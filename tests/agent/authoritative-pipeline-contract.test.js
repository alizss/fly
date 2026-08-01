const test = require("node:test");
const assert = require("node:assert/strict");

const agentContract = require("../../apps/extension/src/shared/agent-contract");
const { resolveLogicalFields } = require("../../apps/web/agent/logical-field");
const { reduceTaskState } = require("../../apps/web/agent/task-state-reducer");
const {
  actionForCurrentCandidate,
  buildCurrentCandidateSet
} = require("../../apps/web/agent/current-candidate-builder");
const { governAction } = require("../../apps/web/agent/action-governor");
const { toClientDecision, __private: loopPrivate } = require("../../apps/web/agent/loop");
const { createCheckoutSessionState } = require("../../packages/shared/agent-state");

function provenCapability(operation, actuatorId) {
  const actionability = {
    rendered: true,
    visible: true,
    enabled: true,
    inViewport: true,
    inCurrentSurface: true,
    hitTested: true,
    notOccluded: true,
    targetable: true,
    operationAuthorized: true,
    operationProven: true,
    executable: true,
    revealable: false,
    code: "ACTIONABLE",
    operation
  };
  return {
    operation,
    actuatorId,
    actuatorIds: [actuatorId],
    candidates: [{ nodeId: actuatorId, reason: "exact-test-actuator" }],
    actionability,
    actionabilityByActuator: { [actuatorId]: actionability },
    expectedOutcome: operation === "open" ? "options_surface_appeared" : "normalized_value_changed"
  };
}

function profileControl({
  controlId,
  name,
  fieldType,
  operation = "type",
  actuatorId = `${controlId}_actuator`,
  role = "textbox",
  kind = "field",
  current = "",
  disabled = false,
  options = [],
  dateComponent = ""
}) {
  return {
    controlId,
    stableKey: `stable:${name}`,
    name,
    fieldType,
    semantic: fieldType,
    label: fieldType.replaceAll("_", " "),
    role,
    kind,
    stateElementId: `${controlId}_state`,
    preferredActivationElementId: actuatorId,
    surfaceId: "surface-page",
    surfaceType: "page",
    state: {
      normalizedValue: current,
      dateComponent,
      dateComponentValue: dateComponent ? current : "",
      valuePresent: Boolean(current),
      disabled
    },
    dateField: dateComponent ? {
      component: dateComponent,
      inputType: operation === "select" ? "select-one" : "text",
      options
    } : null,
    options,
    operations: { [operation]: provenCapability(operation, actuatorId) },
    recovery: {},
    actuators: [
      { nodeId: `${controlId}_state`, relation: "state" },
      { nodeId: actuatorId, relation: "operation" }
    ],
    opaqueSemanticEvidence: {
      producer: "observer",
      exact: true,
      nested: { survivesBoundary: true }
    }
  };
}

function observation(controls, id = "obs_contract") {
  return {
    observationId: id,
    observationSnapshot: { snapshotHash: `hash_${id}` },
    page: {
      url: "https://example.test/traveler",
      step: "traveler_information",
      snapshotHash: `hash_${id}`,
      controls,
      fields: controls.map((control) => ({
        controlId: control.controlId,
        field: control.fieldType,
        fieldType: control.fieldType,
        name: control.name,
        label: control.label,
        role: control.role,
        kind: control.kind,
        controlState: control.state,
        dateField: control.dateField,
        options: control.options,
        required: true
      })),
      decisionGroups: [],
      validationIssues: [],
      currentSurface: {
        id: "surface-page",
        type: "page",
        label: "Traveler",
        memberControlIds: controls.map((control) => control.controlId)
      }
    }
  };
}

test("lossless observed control serialization preserves every semantic and proof property", () => {
  const examples = [
    profileControl({ controlId: "split_day", name: "passengers.0.birthDay", fieldType: "date_of_birth", dateComponent: "day" }),
    profileControl({ controlId: "phone_code", name: "contact.phone_country_code", fieldType: "phone_country_code", operation: "select", role: "combobox", kind: "select" }),
    profileControl({ controlId: "phone_local", name: "contact.phone_number", fieldType: "phone" }),
    profileControl({ controlId: "custom_title", name: "passengers.0.title", fieldType: "title", operation: "open", role: "combobox", kind: "select", disabled: true }),
    profileControl({ controlId: "nationality_search", name: "passengers.0.nationality", fieldType: "nationality", operation: "type", role: "editable_combobox" }),
    profileControl({ controlId: "radio_card", name: "baggage.none", fieldType: "", operation: "choose", role: "radio", kind: "radio" }),
    profileControl({ controlId: "paid_reversal", name: "extras.remove", fieldType: "", operation: "activate", role: "button", kind: "button" }),
    profileControl({ controlId: "modal_advance", name: "modal.advance", fieldType: "", operation: "activate", role: "button", kind: "button" })
  ];

  for (const control of examples) {
    const serialized = agentContract.serializeObservedControl(control, { observationId: "obs_boundary" });
    assert.equal(serialized.contractVersion, agentContract.CONTRACT_VERSION);
    assert.deepEqual(serialized.opaqueSemanticEvidence, control.opaqueSemanticEvidence);
    assert.deepEqual(serialized.options, control.options);
    assert.deepEqual(serialized.dateField, control.dateField);
    assert.deepEqual(serialized.actuators, control.actuators);
    assert.equal(serialized.componentContract.controlIdentity.controlId, control.controlId);
    const capability = serialized.componentContract.capabilities
      .find((item) => item.operation === Object.keys(control.operations)[0]);
    assert.equal(capability?.status, "proven_executable");
    assert.equal(capability?.strategies.length, 1);
    assert.ok(capability?.strategies[0].strategyId);
    assert.equal(
      serialized.componentContract.compositeControl.stateNode.nodeId,
      control.stateElementId
    );
    assert.equal(
      serialized.componentContract.compositeControl.visibleWidget.nodeId,
      control.preferredActivationElementId
    );
    assert.deepEqual(
      serialized.componentContract.compositeControl.activationCandidates,
      control.actuators
    );
  }
});

test("interaction method is part of stable failed-strategy identity", () => {
  const action = {
    type: "click",
    operation: "open",
    controlId: "custom_title",
    targetId: "title_wrapper"
  };
  assert.notEqual(
    loopPrivate.candidateStrategySignature({}, { ...action, interactionMethod: "native_click" }),
    loopPrivate.candidateStrategySignature({}, { ...action, interactionMethod: "pointer_sequence" })
  );
});

test("Logical Field Adapter owns split dates, phone components, searchable choices, and rerender identity", () => {
  const traveler = {
    id: "traveler_1",
    phone: "+905551112233",
    nationality: "TR",
    date_of_birth: "2003-05-31"
  };
  const controls = [
    profileControl({ controlId: "dob_day_old", name: "passengers.0.birthDay", fieldType: "date_of_birth", current: "31", dateComponent: "day" }),
    profileControl({
      controlId: "dob_month_old",
      name: "passengers.0.birthMonth",
      fieldType: "date_of_birth",
      operation: "select",
      role: "combobox",
      kind: "select",
      dateComponent: "month",
      options: [{ value: "05", label: "May" }]
    }),
    profileControl({ controlId: "dob_year_old", name: "passengers.0.birthYear", fieldType: "date_of_birth", dateComponent: "year" }),
    profileControl({ controlId: "phone_code_old", name: "contact.phone_country_code", fieldType: "phone_country_code", operation: "select", role: "combobox", kind: "select", current: "+90" }),
    profileControl({ controlId: "phone_local_old", name: "contact.phone_number", fieldType: "phone" }),
    profileControl({ controlId: "nationality_old", name: "passengers.0.nationality", fieldType: "nationality", operation: "type", role: "editable_combobox" })
  ];
  const before = observation(controls, "obs_before_rerender");
  const fields = resolveLogicalFields(before.page, traveler);
  const dob = fields.find((field) => field.semanticType === "date_of_birth");
  const phone = fields.find((field) => field.semanticType === "phone");
  const nationality = fields.find((field) => field.semanticType === "nationality");

  assert.deepEqual(dob.components.map((component) => component.componentRole), ["day", "month", "year"]);
  assert.equal(dob.components.find((component) => component.componentRole === "day").status, "resolved");
  assert.equal(dob.components.find((component) => component.componentRole === "month").inputValue, "05");
  assert.deepEqual(phone.components.map((component) => component.componentRole), ["country_code", "local_number"]);
  assert.equal(phone.components.find((component) => component.componentRole === "country_code").status, "resolved");
  assert.deepEqual(
    nationality.components[0].bindingContract.requirement,
    {
      requirementId: nationality.requirementContract.requirementId,
      subjectId: nationality.requirementContract.subjectId,
      semanticType: nationality.requirementContract.semanticType,
      desiredCanonicalValue: nationality.requirementContract.desiredCanonicalValue,
      policyRequirementId: ""
    }
  );
  assert.equal(nationality.components[0].inputValue, "TR");

  const rerendered = controls.map((control) => ({
    ...control,
    controlId: control.controlId.replace("_old", "_new"),
    stateElementId: control.stateElementId.replace("_old", "_new"),
    preferredActivationElementId: control.preferredActivationElementId.replace("_old", "_new")
  }));
  const after = resolveLogicalFields(observation(rerendered, "obs_after_rerender").page, traveler);
  const reboundDob = after.find((field) => field.semanticType === "date_of_birth");
  assert.equal(reboundDob.logicalFieldId, dob.logicalFieldId);
  assert.deepEqual(
    reboundDob.components.map((component) => component.stableIdentity),
    dob.components.map((component) => component.stableIdentity)
  );
  assert.notDeepEqual(
    reboundDob.components.map((component) => component.controlId),
    dob.components.map((component) => component.controlId)
  );
});

test("one requirement-component-capability contract remains identical through governor and client dispatch", () => {
  const traveler = {
    id: "traveler_wrapper",
    first_name: "Ali",
    last_name: "Sifrar",
    gender: "male"
  };
  const wrapperId = "title_enabled_wrapper";
  const title = profileControl({
    controlId: "title_control",
    name: "passengers.0.title",
    fieldType: "title",
    operation: "open",
    actuatorId: wrapperId,
    role: "combobox",
    kind: "select",
    disabled: true,
    options: [{ value: "Mr", label: "Mr" }, { value: "Mrs/Ms", label: "Mrs/Ms" }]
  });
  title.actuators = [
    { nodeId: title.stateElementId, relation: "state" },
    { nodeId: wrapperId, relation: "wrapper" }
  ];
  const observed = observation([title], "obs_wrapper_chain");
  const taskState = reduceTaskState({ observation: observed, traveler });
  assert.equal(taskState.currentGoal.semanticType, "title");

  const grounded = loopPrivate.groundedObservationCandidateSet(taskState.currentGoal, observed, [], {
    state: { taskState, approvals: {} },
    traveler,
    approvals: {}
  });
  const candidate = grounded.candidates[0];
  assert.equal(candidate.targetId, wrapperId);
  assert.equal(candidate.capabilityStatus, "proven_executable");
  assert.notEqual(candidate.targetId, title.stateElementId);

  const authoritativeGoal = {
    ...taskState.currentGoal,
    candidateSet: grounded,
    candidates: grounded.candidates
  };
  const state = {
    ...createCheckoutSessionState({
      goal: "Complete traveler",
      travelerId: traveler.id,
      site: { host: "example.test", url: observed.page.url }
    }),
    id: "txn_contract_chain",
    taskState: { ...taskState, currentGoal: authoritativeGoal },
    currentGoal: authoritativeGoal
  };
  const action = loopPrivate.bindTargetSnapshot(
    actionForCurrentCandidate(authoritativeGoal, candidate, observed),
    observed
  );
  const store = {
    isCurrentObservation: (_id, observationId, hash) => (
      observationId === observed.observationId
      && hash === observed.observationSnapshot.snapshotHash
    ),
    recordActionEvent() {},
    reserveGovernedAction() { return { ok: true, signature: "contract-chain" }; }
  };
  const governed = governAction({
    action,
    state,
    observation: observed,
    traveler,
    approvals: {},
    store,
    turnId: "turn_contract_chain"
  });
  assert.equal(governed.allow, true, JSON.stringify(governed));
  const decision = toClientDecision(governed.action);
  assert.deepEqual(action.pipelineContract, candidate.pipelineContract);
  assert.deepEqual(governed.action.pipelineContract, candidate.pipelineContract);
  assert.deepEqual(decision.pipelineContract, candidate.pipelineContract);
  assert.equal(decision.pipelineContract.capability.actuatorId, wrapperId);
  assert.equal(decision.pipelineContract.expectedOutcome.type, "options_surface_appeared");
});

test("geometry never becomes proven and modal Dismiss/Advance remain separate outcome contracts", () => {
  const visual = profileControl({
    controlId: "visual_only",
    name: "passengers.0.title",
    fieldType: "title",
    operation: "open",
    role: "combobox",
    kind: "select",
    disabled: true
  });
  visual.operations = {};
  visual.recovery = {
    open: {
      operation: "open",
      status: "unproven",
      requiresVisualConfirmation: true,
      regions: [{ x: 10, y: 20, width: 100, height: 30, inViewport: true }]
    }
  };
  const serialized = agentContract.serializeObservedControl(visual);
  const recovery = serialized.componentContract.capabilities.find((item) => item.operation === "open");
  assert.equal(recovery.status, "unproven_experiment");
  assert.equal(agentContract.isNormalExecutableContract(agentContract.canonicalPipelineContract({
    capability: recovery
  })), false);

  const dismiss = agentContract.canonicalPipelineContract({
    requirement: { requirementId: "modal_resolution", semanticType: "navigation", desiredCanonicalValue: "advance" },
    component: { componentIdentity: "modal:dismiss", componentRole: "command", controlId: "dismiss" },
    capability: {
      ...agentContract.normalizeCapability(
        { controlId: "dismiss", stateElementId: "dismiss" },
        "activate",
        provenCapability("activate", "dismiss")
      )
    },
    expectedOutcome: { type: "active_surface_dismissed", surfaceId: "modal" },
    validationOwnership: { ownerId: "modal" }
  });
  const advance = agentContract.canonicalPipelineContract({
    requirement: dismiss.requirement,
    component: { componentIdentity: "modal:advance", componentRole: "command", controlId: "advance" },
    capability: {
      ...agentContract.normalizeCapability(
        { controlId: "advance", stateElementId: "advance" },
        "activate",
        provenCapability("activate", "advance")
      )
    },
    expectedOutcome: { type: "checkout_stage_advanced" },
    validationOwnership: { ownerId: "checkout_stage" }
  });
  assert.equal(dismiss.capability.status, "proven_executable");
  assert.equal(advance.capability.status, "proven_executable");
  assert.notDeepEqual(dismiss.expectedOutcome, advance.expectedOutcome);
  assert.notEqual(dismiss.component.componentIdentity, advance.component.componentIdentity);
});

test("shared execution-lane classifier admits only fresh exact bounded recovery", () => {
  const wrapperId = "title_wrapper";
  const control = profileControl({
    controlId: "title_control",
    name: "passengers.0.title",
    fieldType: "title",
    operation: "open",
    actuatorId: wrapperId,
    role: "combobox",
    kind: "select",
    disabled: true
  });
  control.operations = {};
  control.recovery = {
    open: {
      operation: "open",
      boundedRecovery: true,
      requiresVisualConfirmation: true,
      actuatorIds: [wrapperId],
      regions: [{
        x: 20,
        y: 30,
        width: 180,
        height: 36,
        inViewport: true,
        observationId: "obs_lane",
        controlId: control.controlId,
        operation: "open",
        surfaceId: "surface-page"
      }],
      strategies: [{
        operation: "open",
        actuatorId: wrapperId,
        method: agentContract.INTERACTION_METHOD.POINTER_SEQUENCE,
        actionType: "click",
        status: agentContract.CAPABILITY_STATUS.UNPROVEN_EXPERIMENT
      }]
    }
  };
  const observed = agentContract.observedComponentContract(control, { surfaceId: "surface-page" });
  const capability = observed.capabilities.find((item) => item.operation === "open");
  const selectedStrategy = capability.strategies.find((item) => (
    item.actuatorId === wrapperId
    && item.method === agentContract.INTERACTION_METHOD.POINTER_SEQUENCE
  ));
  const pipelineContract = agentContract.canonicalPipelineContract({
    requirement: { requirementId: "traveler:title", semanticType: "title", desiredCanonicalValue: "mr" },
    component: { componentIdentity: "traveler:title:value", componentRole: "value", controlId: control.controlId },
    capability: {
      ...capability,
      status: agentContract.CAPABILITY_STATUS.UNPROVEN_EXPERIMENT,
      actuatorId: wrapperId,
      selectedStrategy
    },
    expectedOutcome: { type: "options_surface_appeared", controlId: control.controlId }
  });
  const observation = {
    observationId: "obs_lane",
    page: {
      currentSurface: { id: "surface-page", type: "page" },
      controls: [control]
    }
  };
  const action = {
    type: "click",
    operation: "open",
    boundedRecovery: true,
    observationId: observation.observationId,
    surfaceId: "surface-page",
    controlId: control.controlId,
    targetId: wrapperId,
    interactionMethod: agentContract.INTERACTION_METHOD.POINTER_SEQUENCE,
    risk: "safe",
    requiresApproval: false,
    expectedOutcome: pipelineContract.expectedOutcome,
    pipelineContract
  };

  assert.equal(agentContract.classifyExecutionLane({
    action,
    pipelineContract,
    control,
    observation
  }), agentContract.EXECUTION_LANE.BOUNDED_RECOVERY);
  assert.equal(agentContract.classifyExecutionLane({
    action,
    pipelineContract,
    control,
    observation,
    strategyAlreadyFailed: true
  }), agentContract.EXECUTION_LANE.DENY);
  assert.equal(agentContract.classifyExecutionLane({
    action: { ...action, risk: "payment" },
    pipelineContract,
    control,
    observation
  }), agentContract.EXECUTION_LANE.DENY);
  assert.equal(agentContract.classifyExecutionLane({
    action: { ...action, observationId: "stale_observation" },
    pipelineContract,
    control,
    observation
  }), agentContract.EXECUTION_LANE.DENY);
});

test("target binding preserves the exact bounded-recovery actuator instead of substituting the preferred control member", () => {
  const recoveryActuatorId = "title_recovery_actuator";
  const preferredActivationId = "title_preferred_activation";
  const control = profileControl({
    controlId: "title_recovery_control",
    name: "passengers.0.title",
    fieldType: "title",
    operation: "open",
    actuatorId: preferredActivationId,
    role: "combobox",
    kind: "select",
    disabled: true,
    options: [{ value: "mr", label: "Male" }, { value: "ms", label: "Female" }]
  });
  control.operations = {};
  control.actuators = [
    { nodeId: control.stateElementId, relation: "state" },
    { nodeId: preferredActivationId, relation: "activation" }
  ];
  control.recovery = {
    open: {
      operation: "open",
      status: "unproven",
      requiresVisualConfirmation: true,
      actuatorIds: [recoveryActuatorId],
      targetabilityByActuator: {
        [recoveryActuatorId]: {
          rendered: true,
          visible: true,
          enabled: true,
          inViewport: true,
          inCurrentSurface: true,
          hitTested: true,
          notOccluded: true,
          targetable: true,
          operationAuthorized: true,
          operationProven: false,
          executable: false,
          revealable: false,
          code: "OPERATION_NOT_PROVEN",
          operation: "open"
        }
      },
      strategies: [{
        operation: "open",
        actuatorId: recoveryActuatorId,
        method: agentContract.INTERACTION_METHOD.NATIVE_CLICK,
        actionType: "click",
        status: agentContract.CAPABILITY_STATUS.UNPROVEN_EXPERIMENT
      }],
      regions: []
    }
  };
  const observed = observation([control], "obs_recovery_binding");
  const capability = agentContract.observedComponentContract(control, {
    surfaceId: "surface-page"
  }).capabilities.find((item) => item.operation === "open");
  const selectedStrategy = capability.strategies.find((item) => (
    item.actuatorId === recoveryActuatorId
    && item.method === agentContract.INTERACTION_METHOD.NATIVE_CLICK
  ));
  const pipelineContract = agentContract.canonicalPipelineContract({
    requirement: {
      requirementId: "traveler:title",
      semanticType: "title",
      desiredCanonicalValue: "mr"
    },
    component: {
      componentIdentity: "traveler:title:value",
      componentRole: "value",
      controlId: control.controlId
    },
    capability: {
      ...capability,
      status: agentContract.CAPABILITY_STATUS.UNPROVEN_EXPERIMENT,
      actuatorId: recoveryActuatorId,
      selectedStrategy
    },
    expectedOutcome: {
      type: "options_surface_appeared",
      controlId: control.controlId
    }
  });
  const bound = loopPrivate.bindTargetSnapshot({
    type: "click",
    operation: "open",
    candidateId: "candidate_title_recovery",
    boundedRecovery: true,
    observationId: observed.observationId,
    observationHash: observed.observationSnapshot.snapshotHash,
    surfaceId: "surface-page",
    controlId: control.controlId,
    targetId: recoveryActuatorId,
    interactionMethod: agentContract.INTERACTION_METHOD.NATIVE_CLICK,
    risk: "safe",
    requiresApproval: false,
    expectedOutcome: pipelineContract.expectedOutcome,
    pipelineContract
  }, observed);

  assert.equal(bound.targetId, recoveryActuatorId);
  assert.equal(bound.targetSnapshot.id, recoveryActuatorId);
  assert.notEqual(bound.targetId, preferredActivationId);
  assert.equal(
    bound.pipelineContract.capability.selectedStrategy.actuatorId,
    bound.targetId
  );
  assert.equal(agentContract.classifyExecutionLane({
    action: bound,
    pipelineContract: bound.pipelineContract,
    control,
    observation: observed
  }), agentContract.EXECUTION_LANE.BOUNDED_RECOVERY);

  const traveler = {
    id: "traveler_recovery_binding",
    first_name: "Ali",
    last_name: "Sifrar",
    gender: "male"
  };
  const taskState = reduceTaskState({ observation: observed, traveler });
  const grounded = loopPrivate.groundedObservationCandidateSet(
    taskState.currentGoal,
    observed,
    [],
    {
      state: { taskState, approvals: {} },
      traveler,
      approvals: {}
    }
  );
  assert.equal(grounded.candidates.length, 1);
  assert.equal(grounded.candidates[0].targetId, recoveryActuatorId);
  assert.equal(grounded.candidates[0].executionChannel, agentContract.EXECUTION_LANE.BOUNDED_RECOVERY);

  const authoritativeGoal = {
    ...taskState.currentGoal,
    candidateSet: grounded,
    candidates: grounded.candidates
  };
  const state = {
    ...createCheckoutSessionState({
      goal: "Complete traveler",
      travelerId: traveler.id,
      site: { host: "example.test", url: observed.page.url }
    }),
    id: "txn_bounded_recovery_binding",
    taskState: { ...taskState, currentGoal: authoritativeGoal },
    currentGoal: authoritativeGoal
  };
  const governedAction = loopPrivate.bindTargetSnapshot(
    actionForCurrentCandidate(authoritativeGoal, grounded.candidates[0], observed),
    observed
  );
  const store = {
    isCurrentObservation: (_id, observationId, hash) => (
      observationId === observed.observationId
      && hash === observed.observationSnapshot.snapshotHash
    ),
    recordActionEvent() {},
    reserveGovernedAction() {
      return { ok: true, signature: "bounded-recovery-binding" };
    }
  };
  const governed = governAction({
    action: governedAction,
    state,
    observation: observed,
    traveler,
    approvals: {},
    store,
    turnId: "turn_bounded_recovery_binding"
  });
  assert.equal(governed.allow, true, JSON.stringify(governed));
  assert.equal(governed.action.targetId, recoveryActuatorId);
});
