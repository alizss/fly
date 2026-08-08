const test = require("node:test");
const assert = require("node:assert/strict");

const agentContract = require("../../apps/extension/src/shared/agent-contract");
const { resolveLogicalFields } = require("../../apps/web/agent/logical-field");
const { reduceTaskState } = require("./task-state-replay-adapter");
const {
  actionForCurrentCandidate,
  buildCurrentCandidateSet
} = require("../../apps/web/agent/current-candidate-builder");
const { governObservedAction: governAction } = require("./governance-test-helper");
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

test("one typed commerce authority rejects presentation state and accepts owned paid selection", () => {
  const modeToggle = agentContract.classifySelectedCommerceTruth({
    decisionGroupId: "seat_mode",
    selectedControlId: "add_to_cart_mode",
    selected: true,
    effectRole: "presentation_mode",
    disposition: "paid",
    priceAmount: 19,
    semanticEffect: "add_paid_extra"
  });
  assert.equal(modeToggle.ownedSelection, true);
  assert.equal(modeToggle.paidOption, false);
  assert.equal(modeToggle.selectedPaid, false);

  const selectedSeat = agentContract.classifySelectedCommerceTruth({
    decisionGroupId: "seat_choice",
    selectedControlId: "seat_12a",
    selected: true,
    effectRole: "commerce_option",
    priceAmount: 19,
    semanticEffect: "add_paid_extra"
  });
  assert.equal(selectedSeat.ownedSelection, true);
  assert.equal(selectedSeat.paidOption, true);
  assert.equal(selectedSeat.selectedPaid, true);

  assert.equal(agentContract.canonicalSemanticEffect("add_paid_extra"), "select_paid_option");
  assert.equal(agentContract.canonicalSemanticEffect("remove_paid_selection"), "select_free_option");
});

test("raw exact commerce receipt is persisted before lifecycle can reinterpret parent progress", () => {
  const actionId = "act_raw_airhelp_decline";
  const canonicalOwnerId = "traveler_information:extras:airhelp:dg_airhelp:global";
  const rawResult = {
    actionId,
    dispatched: true,
    verified: true,
    expectedOutcomeObserved: true,
    postconditionSatisfied: true,
    mechanicalEffect: "select_free_option",
    expectedOutcome: {
      type: "exact_free_option_selected",
      decisionGroupId: "dg_airhelp",
      expectedSelectedControlId: "airhelp_none",
      expectedSelectedLabel: "No thanks",
      expectedDisposition: "decline_free_no_extra"
    },
    action: {
      id: actionId,
      controlId: "airhelp_none",
      decisionGroupId: "dg_airhelp",
      targetLabel: "No thanks",
      mechanicalEffect: "select_free_option",
      affordance: {
        physicalEffect: "select_free_option",
        task: {
          canonicalOwnerId,
          decisionInstanceId: canonicalOwnerId,
          parentDecisionGroupId: "dg_airhelp",
          decisionGroupId: "dg_airhelp",
          semanticType: "airhelp"
        }
      }
    }
  };
  const state = loopPrivate.recordRawVerifiedCommerceReceipt(
    createCheckoutSessionState({ travelerId: "trav_raw_receipt" }),
    {
      observationId: "obs_raw_airhelp",
      lastActionResult: rawResult,
      page: { step: "traveler_information" }
    }
  );

  assert.equal(state.verifiedCommerceObligations.length, 1);
  assert.equal(state.verifiedCommerceObligations[0].actionId, actionId);
  assert.equal(state.verifiedCommerceObligations[0].decisionInstanceId, canonicalOwnerId);

  // Parent checkout status is free to progress later; the receipt is already
  // immutable and no longer depends on those rewritten booleans.
  const rewritten = {
    ...rawResult,
    verified: false,
    expectedOutcomeObserved: false,
    postconditionSatisfied: false,
    taskProgressStatus: "progressed"
  };
  const unchanged = loopPrivate.recordRawVerifiedCommerceReceipt(state, {
    observationId: "obs_after_parent_progress",
    lastActionResult: rewritten,
    page: { step: "traveler_information" }
  });
  assert.deepEqual(unchanged.verifiedCommerceObligations, state.verifiedCommerceObligations);
});

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

test("observed control serialization preserves one exact proof without duplicating the component graph", () => {
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
    const capability = serialized.operations[Object.keys(control.operations)[0]];
    assert.equal(capability?.status, "proven_executable");
    assert.equal(capability?.strategies.length, 1);
    assert.ok(capability?.strategies[0].strategyId);
    const operation = serialized.operations[Object.keys(control.operations)[0]];
    assert.equal(operation.exactActuators[0].actuatorId, control.preferredActivationElementId);
    assert.equal(operation.exactActuators[0].proof.executable, true);
    assert.equal(Object.hasOwn(operation, "actionabilityByActuator"), false);
    assert.equal(Object.hasOwn(serialized.componentContract, "compositeControl"), false);
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
  const recovery = agentContract.observedComponentContract(serialized).capabilities
    .find((item) => item.operation === "open");
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

test("canonical parent-surface exit proof is narrow, fresh, and shared by execution classification", () => {
  const opener = profileControl({
    controlId: "flex_opener",
    name: "flexible_ticket",
    fieldType: "choice",
    operation: "open",
    actuatorId: "flex_opener_button",
    role: "combobox",
    kind: "button"
  });
  opener.state.expanded = true;
  opener.operations = { open: provenCapability("open", "flex_opener_button") };
  const observed = agentContract.observedComponentContract(opener, { surfaceId: "surface-page" });
  const capability = observed.capabilities.find((item) => item.operation === "open");
  const pipelineContract = agentContract.canonicalPipelineContract({
    requirement: { requirementId: "flexible_ticket", semanticType: "completed_choice_surface" },
    component: { componentIdentity: opener.stableKey, controlId: opener.controlId, controlRole: opener.role },
    capability: {
      ...capability,
      actuatorId: "flex_opener_button",
      selectedStrategy: capability.strategies.find((item) => item.actuatorId === "flex_opener_button"),
      proof: capability.exactActuators.find((item) => item.actuatorId === "flex_opener_button")?.proof
    },
    expectedOutcome: { type: "active_surface_dismissed", previousSurfaceId: "flex_dropdown" },
    surfaceOwnership: {
      kind: "parent_controls_active_surface",
      status: "proven",
      observationId: "obs_flex_exit",
      activeSurfaceId: "flex_dropdown",
      activeSurfaceType: "dropdown",
      parentSurfaceId: "surface-page",
      parentControlId: opener.controlId,
      parentActuatorId: "flex_opener_button",
      operation: "open",
      decisionEpisodeId: "episode:flexible_ticket",
      parentDecisionGroupId: "decision:flexible_ticket",
      proof: { completedChoice: true, uniqueExpandedOpener: true }
    }
  });
  const action = {
    type: "click",
    operation: "open",
    interactionMethod: pipelineContract.capability.selectedStrategy.method,
    observationId: "obs_flex_exit",
    controlId: opener.controlId,
    targetId: "flex_opener_button",
    surfaceId: "flex_dropdown",
    targetSnapshot: { id: "flex_opener_button", controlId: opener.controlId, surfaceId: "surface-page" },
    visualRegion: { observationId: "obs_flex_exit", controlId: opener.controlId, operation: "open", surfaceId: "flex_dropdown" },
    expectedOutcome: pipelineContract.expectedOutcome,
    pipelineContract,
    risk: "safe"
  };
  const observation = {
    observationId: "obs_flex_exit",
    page: {
      currentSurface: {
        id: "flex_dropdown",
        type: "dropdown",
        surfaceClass: "choice_set",
        parentControlId: opener.controlId
      },
      controls: [opener]
    }
  };
  assert.equal(agentContract.classifyExecutionLane({ action, pipelineContract, control: opener, observation }), "normal");

  const secondOpener = {
    ...opener,
    controlId: "other_opener",
    state: { ...opener.state, expanded: true }
  };
  assert.equal(agentContract.classifyExecutionLane({
    action,
    pipelineContract,
    control: opener,
    observation: { ...observation, page: { ...observation.page, controls: [opener, secondOpener] } }
  }), "deny");
  assert.equal(agentContract.classifyExecutionLane({
    action,
    pipelineContract,
    control: opener,
    observation: { ...observation, observationId: "obs_stale_exit" }
  }), "deny");
  assert.equal(agentContract.classifyExecutionLane({
    action: { ...action, visualRegion: { ...action.visualRegion, observationId: "obs_stale_region" } },
    pipelineContract,
    control: opener,
    observation
  }), "deny");
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
