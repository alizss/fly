const {
  buildObservationCandidateSet
} = require("./observation-candidates");
const {
  candidatesForProfileGoal,
  profileGoalForDescriptor
} = require("./profile-mechanics");
const {
  controlBelongsToCurrentSurface,
  surfaceBinding
} = require("./surface-contract");
const {
  buildSemanticAffordance,
  compileTypedExpectedOutcome,
  expectedPostconditionsForAction,
  outcomeContractForGoal,
  normalizedActionSemantics
} = require("./action-semantics");
const {
  actuatorSignature,
  isCandidateGrounded,
  normalizeAction,
  normalizeVisualRegion
} = require("../../../packages/shared/agent-actions");
const agentContract = require("../../extension/src/shared/agent-contract");
const { canonicalOptionMatch } = require("./logical-field");
const { CURRENT_OBLIGATION_VERSION } = require("./authority-frames");
const { semanticOwner } = require("./current-obligation");

function candidateOperation(candidate = {}) {
  return candidate.authorizedOperation
    || (candidate.operation === "scroll_to" ? "" : candidate.operation)
    || "";
}

function mechanicsGoalFromObligation(obligation = {}, decisionFrame = null, observation = {}) {
  const delta = obligation.desiredStateDelta || {};
  const owner = obligation.semanticOwner || {};
  const admitted = [...new Set(obligation.admittedControlIds || [])];
  const controls = (decisionFrame?.observation?.page?.controls || observation.page?.controls || [])
    .filter((control) => admitted.includes(control.controlId));
  const primary = controls[0] || {};
  const success = obligation.successCondition || {};
  const kind = String(delta.kind || "unknown");
  const profile = kind === "profile_field";
  const completedSurface = kind === "completed_choice_surface"
    || success.type === "active_surface_dismissed"
    || /dismiss_surface/.test(String(delta.desiredEffect || ""));
  const semanticType = completedSurface
    ? "completed_choice_surface"
    : profile
    ? String(primary.fieldType || primary.field || primary.semantic || owner.family || "unknown")
    : String(delta.family || owner.family || primary.sectionType || primary.semantic || "decision");
  const component = primary.componentContract || primary.logicalComponent || {};
  const exactPolicySafeSelection = [
    "explicit_profile_mismatch",
    "proven_incremental_cost_conflict"
  ].includes(String(delta.reason || ""))
    || /non_paid|no_(?:insurance|seat|baggage|extras)/.test(String(delta.desiredState || delta.desiredEffect || "").toLowerCase());
  const isCommerceOption = (control = {}) => (
    control.effectRole === "commerce_option"
    || /select_(?:free|paid)_option|add_paid|decline_paid|remove_paid/.test(
      `${control.physicalEffect || ""} ${control.semantic || ""}`.toLowerCase()
    )
  );
  const freeIds = controls.filter((control) => (
    isCommerceOption(control) && (exactPolicySafeSelection
      ? !(Number(control.structuredPrice?.amount) > 0)
      : Number(control.structuredPrice?.amount) === 0
        || /select_free|decline|remove|skip|without|none/.test(`${control.physicalEffect || ""} ${control.semantic || ""}`.toLowerCase()))
  )).map((control) => control.controlId);
  const paidIds = controls.filter((control) => (
    isCommerceOption(control) && (
      Number(control.structuredPrice?.amount) > 0
      || /select_paid|add_paid|money/.test(`${control.physicalEffect || ""} ${control.risk || ""}`.toLowerCase())
    )
  )).map((control) => control.controlId);
  const linkedCorrectionControlIds = (observation.page?.semanticOwnershipLinks || [])
    .filter((link) => (
      link.status === "resolved"
      && link.sourceDecisionGroupId === (delta.decisionGroupId || success.decisionGroupId || primary.decisionGroupId || "")
      && admitted.includes(link.correctionControlId)
    ))
    .map((link) => link.correctionControlId)
    .filter(Boolean);
  if (profile) {
    const descriptor = (decisionFrame?.profileRequirements || []).find((candidate) => (
      admitted.includes(candidate.control?.controlId)
      && (!success.logicalFieldId || candidate.logicalFieldId === success.logicalFieldId)
      && (!success.componentRole || candidate.componentRole === success.componentRole)
    )) || (decisionFrame?.profileRequirements || []).find((candidate) => admitted.includes(candidate.control?.controlId)) || null;
    if (descriptor) {
      return Object.freeze({
        ...profileGoalForDescriptor(descriptor, decisionFrame.observation || observation),
        id: obligation.id,
        goalId: obligation.id,
        desiredStateDelta: delta,
        postcondition: success,
        successCondition: success,
        outcomeContract: success,
        admittedControlIds: admitted,
        actionableControlIds: admitted
      });
    }
  }
  return Object.freeze({
    id: obligation.id,
    goalId: obligation.id,
    kind,
    semanticGoal: `satisfy ${semanticType}`,
    semanticType,
    family: delta.family || owner.family || "",
    subjectId: owner.subjectId || "global",
    passengerId: owner.passengerId || "",
    segmentId: owner.segmentId || "",
    logicalFieldId: success.logicalFieldId || component.logicalFieldId || owner.repeatedInstance || "",
    componentRole: success.componentRole || component.componentRole || "value",
    controlId: success.controlId || primary.controlId || admitted[0] || "",
    surfaceId: delta.surfaceId || primary.surfaceId || "surface-page",
    decisionGroupId: delta.decisionGroupId || success.decisionGroupId || primary.decisionGroupId || "",
    requirementId: success.requirementId || primary.requirementId || "",
    desiredValue: delta.desiredValue ?? "",
    canonicalValue: success.expectedCanonicalValue ?? delta.desiredValue ?? "",
    inputValue: delta.desiredValue ?? "",
    desiredSemanticOutcome: delta.desiredEffect || "",
    desiredPolicyOutcome: delta.desiredEffect || "",
    desiredStateDelta: delta,
    admittedControlIds: admitted,
    actionableControlIds: admitted,
    eligibleAlternativeControlIds: admitted,
    policyAllowedControlIds: admitted,
    policyChoiceBounded: !profile,
    freeAlternativeControlIds: freeIds,
    paidAlternativeControlIds: paidIds,
    semanticCorrectionControlIds: [...new Set([
      ...linkedCorrectionControlIds,
      ...admitted.filter((controlId) => success.expectedSelectedControlId === controlId)
    ])],
    componentBinding: profile ? Object.freeze({
      ...component,
      controlId: success.controlId || primary.controlId || admitted[0] || "",
      logicalFieldId: success.logicalFieldId || component.logicalFieldId || owner.repeatedInstance || "",
      componentRole: success.componentRole || component.componentRole || "value",
      representationControlIds: admitted,
      stateControlIds: success.stateControlIds || admitted
    }) : null,
    requirementContract: primary.requirementContract || null,
    validationOwnership: primary.validationOwnership || null,
    dateCodec: success.dateCodec || primary.dateField || null,
    surfaceExitOwnership: success.surfaceExitOwnership || null,
    parentDecisionGroupId: success.parentDecisionGroupId || "",
    parentExpectedSelectedControlId: success.parentExpectedSelectedControlId || "",
    parentSelectedControlId: success.parentExpectedSelectedControlId || "",
    decisionEpisodeId: success.decisionEpisodeId || "",
    postcondition: success,
    successCondition: success,
    outcomeContract: success,
    observationId: obligation.observationId || observation.observationId || ""
  });
}

function operationUsesExecutableActuator(control = {}, candidate = {}) {
  return [
    agentContract.EXECUTION_LANE.NORMAL,
    agentContract.EXECUTION_LANE.BOUNDED_RECOVERY
  ].includes(candidate.executionChannel);
}

function controlUnavailable(control = {}, candidate = {}) {
  const underlyingStateDisabled = control.disabled === true || control.state?.disabled === true;
  return (underlyingStateDisabled && !operationUsesExecutableActuator(control, candidate))
    || (control.state?.available === false && !operationUsesExecutableActuator(control, candidate))
    || /(?:^|\b)(?:not available|unavailable|sold out|disabled)(?:\b|$)/i.test(
      `${control.semantic || ""} ${control.risk || ""} ${control.label || ""}`
    );
}

function candidateActionabilityFailure(candidate = {}, control = {}, observation = {}, strategyAlreadyFailed = false) {
  if (!["click", "type", "select", "keypress", "scroll", "click_xy"].includes(candidate.type)) return "";
  const operation = candidateOperation(candidate);
  const componentBehavior = candidate.pipelineContract?.component?.componentBehavior
    || agentContract.componentBehaviorFor(control);
  if (operation
    && Array.isArray(componentBehavior?.allowedOperations)
    && componentBehavior.allowedOperations.length
    && !componentBehavior.allowedOperations.includes(operation)) {
    return "COMPONENT_OPERATION_UNSUPPORTED";
  }
  if (!isCandidateGrounded(candidate, observation)) return "ACTIONABILITY_UNPROVEN";
  const lane = agentContract.classifyExecutionLane({
    action: candidate,
    pipelineContract: candidate.pipelineContract,
    control,
    observation,
    strategyAlreadyFailed
  });
  if (lane === agentContract.EXECUTION_LANE.NORMAL) return "";
  if (lane === agentContract.EXECUTION_LANE.REVEAL) return "TARGET_NOT_REVEALED";
  if (lane === agentContract.EXECUTION_LANE.BOUNDED_RECOVERY) {
    return candidate.mechanicalHypothesis === true ? "" : "ACTIONABILITY_UNPROVEN";
  }
  return strategyAlreadyFailed ? "FAILED_STRATEGY_REUSE" : "TARGET_NOT_ACTIONABLE";
}

function preSurfaceMechanicalHypothesis(goal = {}, candidate = {}, control = {}, executionChannel = "", observation = {}) {
  const profileDiscovery = (goal?.kind) === "profile_field";
  const ownedChoiceDiscovery = goal?.desiredStateDelta?.status === "EXACT_DELTA"
    && goal?.desiredStateDelta?.desiredState === "options_surface_visible"
    && goal?.desiredStateDelta?.desiredEffect === "open"
    && (goal?.admittedControlIds || []).includes(control.controlId);
  if (
    (!profileDiscovery && !ownedChoiceDiscovery)
    || executionChannel !== agentContract.EXECUTION_LANE.BOUNDED_RECOVERY
    || candidate.boundedRecovery !== true
    || candidateOperation(candidate) !== "open"
    || !["click", "keypress"].includes(candidate.type)
    || !candidate.targetId
    || candidate.expectedOutcome?.type !== "options_surface_appeared"
  ) return null;
  const selectedStrategy = candidate.pipelineContract?.capability?.selectedStrategy || {};
  const proof = selectedStrategy.proof || selectedStrategy.actionability || {};
  if (
    proof.rendered !== true
    || proof.visible !== true
    || proof.enabled !== true
    || proof.inViewport !== true
    || proof.inCurrentSurface !== true
    || proof.hitTested !== true
    || proof.notOccluded !== true
    || proof.targetable !== true
  ) return null;
  const meaning = [
    candidate.semanticIntent,
    candidate.mechanicalEffect,
    candidate.physicalEffect,
    candidate.targetLabel,
    control.semantic,
    control.risk
  ].filter(Boolean).join(" ").toLowerCase();
  if (/purchase|book[_ ]?now|confirm[_ ]?booking|submit[_ ]?payment|pay[_ ]?now|paid|price|legal|terms|consent|subscribe/.test(meaning)) {
    return null;
  }
  const surfaceId = candidate.surfaceId || control.surfaceId || observation.page?.currentSurface?.id || "surface-page";
  return Object.freeze({
    kind: "pre_surface_discovery",
    objective: `Reveal the exact owned choice surface for ${(goal?.semanticType) || (goal?.label) || "the current choice"}.`,
    logicalControlId: control.controlId || candidate.controlId || "",
    actuatorId: candidate.targetId,
    sourceSurfaceId: surfaceId,
    allowedOperations: Object.freeze(["open"]),
    forbiddenRisks: Object.freeze(["money", "legal", "uncertain"]),
    forbiddenEffects: Object.freeze([
      "advance_checkout_stage",
      "navigate_stage",
      "select_paid_option",
      "submit_payment",
      "purchase",
      "accept_legal"
    ]),
    remainingSteps: 1,
    deadlineAt: Date.now() + 20_000
  });
}

function surfaceOwnershipForCandidate(goal = {}, candidate = {}, control = {}, observation = {}) {
  const ownership = (goal?.surfaceExitOwnership) || candidate.pipelineContract?.surfaceOwnership || null;
  if (
    (goal?.semanticType) !== "completed_choice_surface"
    || ownership?.kind !== "parent_controls_active_surface"
    || ownership?.status !== "proven"
    || ownership.parentControlId !== control.controlId
    || !candidate.targetId
    || !["open", "activate"].includes(candidateOperation(candidate))
  ) return null;
  return {
    ...ownership,
    observationId: observation.observationId || ownership.observationId || "",
    parentActuatorId: candidate.targetId,
    operation: candidateOperation(candidate)
  };
}

function pipelineContractForCandidate(goal = {}, candidate = {}, control = {}, expectedOutcome = {}, observation = {}) {
  const observed = agentContract.observedComponentContract(control, {
    surfaceId: control.surfaceId || candidate.surfaceId || ""
  });
  const operation = candidateOperation(candidate);
  const existing = candidate.pipelineContract || null;
  let capability = existing?.capability || observed.capabilities.find((item) => (
    item.operation === operation
    && (
      candidate.type === "click_xy" || candidate.boundedRecovery === true
        ? item.status === agentContract.CAPABILITY_STATUS.UNPROVEN_EXPERIMENT
        : !candidate.targetId || item.actuatorIds?.includes(candidate.targetId)
    )
  )) || observed.capabilities.find((item) => item.operation === operation) || {};
  const exact = (capability.exactActuators || []).find((item) => item.actuatorId === candidate.targetId);
  capability = {
    ...capability,
    actuatorId: candidate.targetId || capability.actuatorId || "",
    selectedStrategy: (capability.strategies || []).find((strategy) => (
      strategy.actuatorId === candidate.targetId
      && (!candidate.interactionMethod || strategy.method === candidate.interactionMethod)
    )) || null,
    status: candidate.type === "click_xy" || candidate.boundedRecovery === true
      ? agentContract.CAPABILITY_STATUS.UNPROVEN_EXPERIMENT
      : exact?.status || capability.status || agentContract.CAPABILITY_STATUS.UNAVAILABLE,
    proof: exact?.proof || capability.proof || capability.actionability || null
  };
  const fallbackComponent = {
    componentPattern: observed.componentPattern || agentContract.componentPatternFor(control),
    componentBehavior: observed.componentBehavior || agentContract.componentBehaviorFor(control),
    logicalFieldId: (goal?.logicalFieldId) || "",
    componentIdentity: `${(goal?.logicalFieldId) || control.stableKey || control.controlId}:${(goal?.componentRole) || "value"}`,
    componentRole: (goal?.componentRole) || "value",
    controlId: control.controlId || candidate.controlId || "",
    controlRole: control.role || control.kind || "",
    currentCanonicalValue: observed.currentCanonicalValue || "",
    desiredCanonicalValue: (goal?.desiredStateDelta?.desiredValue) || (goal?.canonicalValue) || "",
    observedOptions: observed.observedOptions || []
  };
  const sourceComponent = (goal?.componentBinding) || {};
  const profileChildComponent = (goal?.kind) === "profile_field"
    && observation.page?.currentSurface?.type !== "page"
    && control.controlId
    && control.controlId !== sourceComponent.controlId;
  const component = profileChildComponent
    ? {
        ...sourceComponent,
        ...fallbackComponent,
        parentControlId: sourceComponent.controlId || ""
      }
    : {
        ...fallbackComponent,
        ...sourceComponent,
        ...(existing?.component || {})
      };
  return agentContract.canonicalPipelineContract({
    requirement: existing?.requirement || (goal?.requirementContract) || {
      requirementId: (goal?.requirementId) || (goal?.id) || (goal?.decisionGroupId) || "",
      subjectId: (goal?.subjectId) || "",
      semanticType: (goal?.semanticType) || (goal?.sectionType) || "",
      desiredCanonicalValue: (goal?.canonicalValue) || (goal?.desiredStateDelta?.desiredValue) || ""
    },
    component,
    capability,
    expectedOutcome,
    validationOwnership: existing?.validationOwnership || (goal?.validationOwnership) || observed.validationOwnership || {},
    surfaceOwnership: surfaceOwnershipForCandidate(goal, candidate, control, observation)
      || existing?.surfaceOwnership
      || null
  });
}

function observationHash(observation = {}) {
  return String(observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "");
}

function capabilityKey(candidate = {}) {
  return [candidate.controlId, candidate.operation, candidate.targetId, candidate.type, candidate.interactionMethod, candidate.value, candidate.keys]
    .map(String)
    .join("::");
}

function admittedByCurrentObligation(goal = {}, candidate = {}, isGoalCandidate = false, obligation = null) {
  if ((goal?.selectionMode) === "ai_ambiguity" || (goal?.semanticType) === "surface_ambiguity") return false;
  if (obligation?.contractVersion === CURRENT_OBLIGATION_VERSION) {
    if (obligation.desiredStateDelta?.status !== "EXACT_DELTA"
      || obligation.desiredStateDelta?.actionRequired !== true) return false;
    if (new Set(obligation.admittedControlIds || []).has(candidate.controlId)) return true;
    // Portalled child options remain mechanics for the same profile
    // obligation, never a new semantic task chosen by the binder.
    return isGoalCandidate && (goal?.kind) === "profile_field";
  }
  return isGoalCandidate;
}

function normalizedMeaning(value = "") {
  return String(value || "").toLowerCase().replace(/[^a-z0-9+]+/g, " ").trim();
}

function numericMeaningTokens(value = "") {
  return (String(value || "").match(/\+?\d[\d\s().-]*/g) || [])
    .map((token) => token.replace(/\D/g, ""))
    .filter(Boolean);
}

function boundedSemanticMatch(label = "", term = "") {
  if (!label || !term) return false;
  return label === term || ` ${label} `.includes(` ${term} `);
}

function profileChildCandidateScore(goal = {}, candidate = {}, control = {}) {
  if ((goal?.kind) !== "profile_field") return 0;
  const rawDesired = String((goal?.desiredStateDelta?.desiredValue) ?? (goal?.canonicalValue) ?? "").trim();
  const desired = normalizedMeaning(rawDesired);
  const desiredTerms = [...new Set([
    desired,
    ...((goal?.choiceTerms) || []).map(normalizedMeaning),
    ...((goal?.sourceGoal)?.choiceTerms || []).map(normalizedMeaning)
  ].filter(Boolean))];
  const descriptor = normalizedMeaning([
    candidate.targetLabel,
    candidate.meaning,
    control.label,
    control.ownText,
    control.state?.optionValue,
    control.currentValue
  ].filter(Boolean).join(" "));
  // The value to type is supplied by the goal, not observed option evidence.
  // Do not mistake a search box carrying that action value for the exact
  // option itself. Once filtering has written the desired query, keyboard
  // mechanics on that same textbox remain filter mechanics; they must not
  // compete with the exact option that the query revealed.
  const filterControl = /search|filter|query|find/.test(descriptor);
  if (filterControl && candidateOperation(candidate) === "type") return 70;
  if (filterControl && candidateOperation(candidate) === "keyboard") return 30;
  if (["choose", "select", "activate"].includes(candidateOperation(candidate))
    && canonicalOptionMatch(
      (goal?.semanticType) || (goal?.sourceGoal)?.semanticType || "",
      (goal?.componentRole) || (goal?.sourceGoal)?.componentRole || "value",
      rawDesired,
      {
        value: control.state?.optionValue || candidate.value || "",
        label: candidate.targetLabel || control.label || control.accessibleName || ""
      }
    )) return 110;
  const label = normalizedMeaning([descriptor, candidate.value].filter(Boolean).join(" "));
  if (["choose", "select", "activate"].includes(candidateOperation(candidate))
    && desiredTerms.some((term) => boundedSemanticMatch(label, term))) return 100;
  const desiredDigitTokens = desiredTerms.flatMap(numericMeaningTokens);
  const labelDigitTokens = new Set(numericMeaningTokens(label));
  if (desiredDigitTokens.some((token) => labelDigitTokens.has(token))) return 90;
  if (candidate.operation === "keyboard") return 30;
  return 10;
}

function allCurrentCapabilityCandidates(goal = {}, observation = {}, traveler = {}) {
  const profileCandidates = (goal?.kind) === "profile_field"
    ? candidatesForProfileGoal(goal, observation, traveler, [], { includeAlternates: true })
    : [];
  const childSurfaceCandidates = (goal?.kind) === "profile_field"
    && observation.page?.currentSurface?.type !== "page"
      ? buildObservationCandidateSet(goal, observation).candidates
      : [];
  const goalCandidates = (goal?.kind) === "profile_field"
    ? [...profileCandidates, ...childSurfaceCandidates]
    : buildObservationCandidateSet(goal, observation).candidates;
  return {
    goalCandidateKeys: new Set(goalCandidates.map(capabilityKey)),
    candidates: goalCandidates
  };
}

function bindCandidateEnvelope(candidate = {}, index, observation = {}, binding = {}) {
  return {
    ...candidate,
    visualRegion: candidate.visualRegion
      ? normalizeVisualRegion(candidate.visualRegion, {
          observationId: binding.observationId || observation.observationId || "",
          controlId: candidate.controlId || "",
          operation: candidate.operation || "",
          surfaceId: binding.surfaceId || ""
        })
      : null,
    strategyId: candidate.strategyId || candidate.candidateId || "",
    candidateId: `${binding.observationId || "observation"}:candidate_${index + 1}`,
    observationId: binding.observationId || "",
    observationHash: binding.observationHash || observationHash(observation),
    surfaceId: binding.surfaceId || "",
    surfaceType: binding.surfaceType || "page"
  };
}

// The binder owns mechanics only. It may describe the local browser effect
// needed to execute an already-admitted obligation, but it must never infer a
// new checkout objective or consequence policy from labels/DOM shape.
function localMechanicalEffect(goal = {}, candidate = {}, control = {}) {
  const operation = candidateOperation(candidate);
  if ((goal?.kind) === "profile_field" && control.role === "editable_combobox"
    && ["type", "keyboard"].includes(operation)) return "filter_options";
  const observedSemanticEffect = agentContract.canonicalSemanticEffect(control.semantic || "");
  const declared = String(
    candidate.physicalEffect
    || candidate.mechanicalEffect
    || control.physicalEffect
    || ([
      "dismiss_surface",
      "open_surface",
      "advance_checkout_stage",
      agentContract.SEMANTIC_EFFECT.SELECT_FREE_OPTION,
      "set_field_value"
    ].includes(observedSemanticEffect)
      ? observedSemanticEffect
      : "")
  ).trim().toLowerCase();
  // Observer uncertainty is absence of an effect contract, not an explicit
  // effect. Let the admitted operation and obligation supply the local
  // mechanic instead of allowing the sentinel string to erase settlement.
  const explicit = ["", "unknown", "uncertain", "unclassified", "none", "n/a"]
    .includes(declared) ? "" : declared;
  if (explicit) return explicit;
  if (control.semantic === "legal_acceptance" && ["choose", "select", "activate"].includes(operation)) {
    return "accept_legal_terms";
  }
  if (["open", "reveal"].includes(operation)) return "open_surface";
  if (["type", "fill"].includes(operation)) return "type_value";
  if (["choose", "select"].includes(operation)) return "select_option";
  if (operation === "keyboard") return "keyboard_input";
  if (operation === "scroll_to") return "scroll_into_view";
  return String(candidate.physicalEffect || candidate.mechanicalEffect || control.physicalEffect || operation || "unknown");
}

function verifierOutcomeFromObligation(goal = {}, candidate = {}, control = {}, binding = {}) {
  const success = (goal?.successCondition)
    || (goal?.successCondition)
    || (goal?.expectedOutcome)
    || null;
  if (!success?.type) return null;
  if (success.type === "decision_group_resolved") {
    const desiredEffect = agentContract.canonicalSemanticEffect(
      success.desiredSemanticOutcome || success.desiredPolicyOutcome || (goal?.desiredSemanticOutcome)
    );
    const selected = control.selected === true
      || control.state?.selected === true
      || control.state?.checked === true;
    const candidateControlId = candidate.controlId || control.controlId || "";
    const exactUnselect = goal?.desiredStateDelta?.desiredState === "unselected"
      && (goal?.admittedControlIds || []).includes(candidateControlId);
    if (selected && exactUnselect) {
      return {
        type: "control_unselected",
        controlId: candidateControlId,
        decisionGroupId: success.decisionGroupId
          || candidate.decisionGroupId
          || control.decisionGroupId
          || (goal?.decisionGroupId)
          || "",
        surfaceId: binding.surfaceId || control.surfaceId || "",
        desiredPolicyOutcome: success.desiredPolicyOutcome || (goal?.desiredPolicyOutcome) || "",
        mustNotIncreasePrice: true,
        obligationSuccessType: success.type
      };
    }
    return {
      type: "control_selected",
      controlId: candidate.controlId || control.controlId || "",
      expectedSelectedControlId: candidate.controlId || control.controlId || "",
      expectedSelectedLabel: candidate.targetLabel || control.label || "",
      decisionGroupId: success.decisionGroupId
        || candidate.decisionGroupId
        || control.decisionGroupId
        || (goal?.decisionGroupId)
        || "",
      surfaceId: binding.surfaceId || control.surfaceId || "",
      desiredPolicyOutcome: success.desiredPolicyOutcome || (goal?.desiredPolicyOutcome) || "",
      mustNotIncreasePrice: true,
      obligationSuccessType: success.type
    };
  }
  return { ...success };
}

function buildCurrentCandidateSet({
  obligation,
  goal = obligation,
  observation = {},
  traveler = {},
  state = {},
  approvals = {},
  attemptedCandidateIds = [],
  attemptedStrategySignatures = []
} = {}) {
  const binding = surfaceBinding(observation);
  const page = observation.page || {};
  const attempted = new Set(attemptedCandidateIds || []);
  const attemptedStrategies = new Set(attemptedStrategySignatures || []);
  const outcomeContract = (goal?.successCondition)
    || (goal?.successCondition)
    || outcomeContractForGoal(goal, observation);
  const parentOutcomeContract = outcomeContract;
  const allCapabilities = allCurrentCapabilityCandidates(goal, observation, traveler);
  const completedSurfaceExitIds = new Set(
    (goal?.semanticType) === "completed_choice_surface"
      ? ((goal?.admittedControlIds) || []).filter(Boolean)
      : []
  );
  const current = allCapabilities.candidates.filter((candidate) => {
    if (!["click", "type", "select", "keypress", "scroll", "click_xy"].includes(candidate.type)) return true;
    const control = (page.controls || []).find((item) => item.controlId === candidate.controlId);
    return Boolean(control && (
      controlBelongsToCurrentSurface(control, page)
      // A completed dropdown can only be dismissed through its page-owned
      // opener. TaskState publishes that exact actuator; it is the sole safe
      // exception to foreground ownership and prevents reselecting the value.
      || completedSurfaceExitIds.has(control.controlId)
    ));
  }).map((candidate, index) => {
    const bound = bindCandidateEnvelope(candidate, index, observation, binding);
    const control = (page.controls || []).find((item) => item.controlId === bound.controlId) || {};
    const semantics = normalizedActionSemantics(bound, { control, goal, expectedOutcome: bound.expectedOutcome });
    const profileChildScore = profileChildCandidateScore(goal, bound, control);
    const exactProfileChildMatch = (goal?.kind) === "profile_field" && profileChildScore >= 90;
    const exactProfileOption = (goal?.kind) === "profile_field"
      && bound.exactOption?.canonicalValue
      && normalizedMeaning(bound.exactOption.canonicalValue) === normalizedMeaning((goal?.desiredStateDelta?.desiredValue) || (goal?.canonicalValue) || "");
    const profileChildFilter = (goal?.kind) === "profile_field"
      && observation.page?.currentSurface?.type !== "page"
      && candidateOperation(bound) === "type"
      && profileChildScore === 70;
    const profileChoiceQuery = (goal?.kind) === "profile_field"
      && control.role === "editable_combobox"
      && ["type", "keyboard"].includes(candidateOperation(bound));
    const standardTermsMandate = approvals.standardBookingTermsApproved === true
      && /legal/.test(`${bound.risk || ""} ${control.risk || ""}`.toLowerCase());
    const physicalEffect = profileChoiceQuery
      ? "filter_options"
      : exactProfileChildMatch || exactProfileOption
      ? "set_field_value"
      : profileChildFilter
        ? "filter_options"
        : localMechanicalEffect(goal, bound, control);
    // TaskState's obligation success condition is authoritative. Candidate
    // mechanics may describe an intermediate browser effect, but they must
    // not weaken a choice component's settlement contract into a scalar value
    // change. In particular, typing into an editable combobox is filtering
    // progress until the exact child option is selected and the popup settles.
    const goalComponentOutcome = (goal?.successCondition)
      || (goal?.expectedOutcome)
      || (goal?.successCondition)
      || {};
    const editableProfileQuery = Boolean(
      profileChoiceQuery
      && (
        goalComponentOutcome.commitRequirement === "logical_component_committed"
        || goalComponentOutcome.type === "logical_component_committed"
      )
    );
    const obligationExpectedOutcome = verifierOutcomeFromObligation(goal, bound, control, binding);
    const exactComponentExpectedOutcome = editableProfileQuery ? {
      ...(bound.expectedOutcome || {}),
      type: "normalized_value_changed",
      logicalFieldId: (goal?.logicalFieldId) || goalComponentOutcome.logicalFieldId || "",
      subjectId: (goal?.subjectId) || goalComponentOutcome.subjectId || "traveler_1",
      semanticType: (goal?.semanticType) || goalComponentOutcome.semanticType || "",
      componentRole: (goal?.componentRole) || goalComponentOutcome.componentRole || "value",
      controlId: (goal?.controlId) || (goal?.componentBinding)?.controlId || bound.controlId || "",
      expectedComponentValue: (goal?.desiredStateDelta?.desiredValue) ?? (goal?.canonicalValue) ?? "",
      expectedCanonicalValue: goalComponentOutcome.expectedCanonicalValue
        ?? (goal?.canonicalValue)
        ?? (goal?.desiredStateDelta?.desiredValue)
        ?? "",
      expectedNormalizedValue: (goal?.desiredStateDelta?.desiredValue) ?? (goal?.canonicalValue) ?? "",
      interactionKind: "editable_combobox",
      commitRequirement: "logical_component_committed",
      canonicalTarget: (goal?.desiredStateDelta?.desiredValue) ?? (goal?.canonicalValue) ?? "",
      mustNotIncreasePrice: true
    } : exactProfileChildMatch || exactProfileOption ? {
      ...goalComponentOutcome,
      type: "logical_component_committed",
      logicalFieldId: (goal?.logicalFieldId) || "",
      semanticType: (goal?.semanticType) || "",
      componentRole: (goal?.componentRole) || "value",
      controlId: (goal?.controlId) || (goal?.componentBinding)?.controlId || "",
      stateControlIds: goalComponentOutcome.stateControlIds
        || (goal?.componentBinding)?.representationControlIds
        || (goal?.componentBinding)?.stateControlIds
        || [],
      expectedCanonicalValue: (goal?.desiredStateDelta?.desiredValue) ?? (goal?.canonicalValue) ?? "",
      expectedNormalizedValue: (goal?.desiredStateDelta?.desiredValue) ?? (goal?.canonicalValue) ?? "",
      surfaceId: binding.surfaceId || "",
      requireSurfaceDismissed: true,
      mustNotIncreasePrice: true
    } : (bound.expectedOutcome || obligationExpectedOutcome);
    const compiledExpectedOutcome = compileTypedExpectedOutcome({
      ...bound,
      expectedOutcome: exactComponentExpectedOutcome,
      mechanicalEffect: physicalEffect,
      goal: { ...goal, outcomeContract }
    }, page);
    const expectedOutcome = exactProfileChildMatch || exactProfileOption ? {
      ...compiledExpectedOutcome,
      controlId: (goal?.controlId) || (goal?.componentBinding)?.controlId || compiledExpectedOutcome?.controlId || "",
      logicalFieldId: (goal?.logicalFieldId) || compiledExpectedOutcome?.logicalFieldId || "",
      semanticType: (goal?.semanticType) || compiledExpectedOutcome?.semanticType || "",
      componentRole: (goal?.componentRole) || compiledExpectedOutcome?.componentRole || "value",
      expectedCanonicalValue: (goal?.desiredStateDelta?.desiredValue) ?? (goal?.canonicalValue) ?? "",
      expectedNormalizedValue: (goal?.desiredStateDelta?.desiredValue) ?? (goal?.canonicalValue) ?? ""
    } : compiledExpectedOutcome;
    const pipelineContract = pipelineContractForCandidate(goal, bound, control, expectedOutcome, observation);
    const semanticIntent = String(
      (goal?.desiredStateDelta?.desiredEffect)
      || (goal?.desiredSemanticOutcome)
      || (goal?.desiredPolicyOutcome)
      || obligation?.desiredEffect
      || "perform_current_obligation"
    );
    const expectedPostconditions = expectedPostconditionsForAction({
      expectedOutcome,
      semanticIntent,
      mechanicalEffect: physicalEffect,
      goal
    });
    const affordance = buildSemanticAffordance({
      candidate: { ...bound, physicalEffect, mechanicalEffect: physicalEffect, semanticIntent, expectedPostconditions },
      control,
      goal: { ...goal, outcomeContract },
      postcondition: expectedOutcome
    });
    const strategyAlreadyFailed = attemptedStrategies.has(actuatorSignature(bound));
    const laneInput = {
      ...bound,
      goalCandidate: allCapabilities.goalCandidateKeys.has(capabilityKey(candidate)),
      // A visible foreground surface owns the next click. TaskState remains
      // useful planning context, but it cannot hide a grounded safe control
      // merely because its predicted semantic effect is incomplete/unknown.
      // Selectable actions must belong to the authoritative obligation.
      // Other foreground controls remain model context only. Adaptive child
      // surfaces admit only an exact compatible option or its owned filter.
      goalRelevant: admittedByCurrentObligation(
      goal,
      bound,
      allCapabilities.goalCandidateKeys.has(capabilityKey(candidate)),
      obligation
      )
        && (
          !((goal?.kind) === "profile_field" && observation.page?.currentSurface?.type !== "page")
          || profileChildScore >= 70
        ),
      requiresApproval: exactProfileOption || standardTermsMandate
        ? false
        : Boolean(bound.requiresApproval),
      expectedOutcome,
      localMechanicalPostcondition: expectedOutcome,
      obligationSuccessCondition: outcomeContract,
      pipelineContract,
      capabilityStatus: pipelineContract.capability.status,
      expectedPostconditions,
      physicalEffect,
      mechanicalEffect: physicalEffect,
      semanticIntent,
      outcomeContract,
      parentOutcomeContract,
      // Compatibility was decided when TaskState admitted the obligation.
      // The consequence governor remains the only downstream policy authority.
      outcomeCompatibility: "obligation_admitted",
      outcomeCompatibilityReason: "TaskState admitted this exact control for the current obligation.",
      affordance,
      // Exact profile agreement is deterministic even when its actuator still
      // needs viewport recovery. Visibility is a mechanical condition, not a
      // reason to ask AI to reinterpret an already-known value.
      risk: exactProfileChildMatch || profileChildFilter || exactProfileOption
        ? "safe"
        : (bound.risk || ((goal?.kind) === "profile_field" ? "safe" : "uncertain")),
      requiresJudgment: exactProfileChildMatch || profileChildFilter || exactProfileOption
        ? false
        : Boolean(bound.requiresJudgment || bound.risk === "uncertain")
    };
    const executionChannel = agentContract.classifyExecutionLane({
      action: laneInput,
      pipelineContract,
      control,
      observation,
      strategyAlreadyFailed
    });
    const discoveryEnvelope = preSurfaceMechanicalHypothesis(
      goal,
      laneInput,
      control,
      executionChannel,
      observation
    );
    const grounded = {
      ...laneInput,
      executionChannel,
      candidateClass: discoveryEnvelope ? "mechanical_hypothesis" : "proven_action",
      mechanicalHypothesis: Boolean(discoveryEnvelope),
      discoveryEnvelope,
      logicalControlId: control.controlId || bound.controlId || "",
      actuatorId: bound.targetId || "",
      ...(discoveryEnvelope ? {
        interactionRole: "opener",
        mechanicalEffect: "open_surface",
        physicalEffect: "open_surface",
        semanticIntent: "discover_control_surface",
        requiresJudgment: false
      } : {})
    };
    const actionabilityFailure = candidateActionabilityFailure(
      grounded,
      control,
      observation,
      strategyAlreadyFailed
    );
    const admitted = laneInput.goalRelevant
      && obligation?.desiredStateDelta?.status === "EXACT_DELTA";
    return {
      ...grounded,
      admitted,
      affordance,
      exclusionReason: controlUnavailable(control, grounded)
        ? "CONTROL_UNAVAILABLE"
        : actionabilityFailure
          ? actionabilityFailure
        : !admitted
          ? "NOT_ADMITTED_BY_CURRENT_OBLIGATION"
          : ""
    };
  });
  const excludedCandidates = current.filter((candidate) => candidate.goalRelevant && (
    Boolean(candidate.exclusionReason)
      || attempted.has(candidate.candidateId)
      || attempted.has(candidate.strategyId)
      || attemptedStrategies.has(actuatorSignature(candidate))
  ));
  const mechanicallySelectable = (candidate) => {
    if (!candidate.goalRelevant) return false;
    const nonMutating = ["ask_user", "wait"].includes(candidate.type);
    if (!nonMutating && candidate.admitted !== true) return false;
    // Consequence policy, including ask-user decisions, is owned by the
    // action governor. Hiding a grounded mechanic here turns an authorization
    // question into a false "no mechanics" result.
    return !attempted.has(candidate.candidateId)
      && !attempted.has(candidate.strategyId)
      && !attemptedStrategies.has(actuatorSignature(candidate));
  };
  const exactProfileChildCandidates = (goal?.kind) === "profile_field"
    ? current.filter((candidate) => {
      const control = (page.controls || []).find((item) => item.controlId === candidate.controlId) || {};
      return mechanicallySelectable(candidate)
        && candidate.admitted === true
        && !controlUnavailable(control, candidate)
        && profileChildCandidateScore(goal, candidate, control) >= 90;
    })
    : [];
  const visibleExactProfileChildCandidates = exactProfileChildCandidates.filter((candidate) => (
    candidate.executionChannel === agentContract.EXECUTION_LANE.NORMAL
  ));
  const profileChildFilterCandidates = (goal?.kind) === "profile_field"
    ? current.filter((candidate) => {
      const control = (page.controls || []).find((item) => item.controlId === candidate.controlId) || {};
      return mechanicallySelectable(candidate)
        && candidate.admitted === true
        && candidate.executionChannel === agentContract.EXECUTION_LANE.NORMAL
        && candidateOperation(candidate) === "type"
        && profileChildCandidateScore(goal, candidate, control) === 70;
    })
    : [];
  // Cheapest deterministic mechanics win: click an exact visible option;
  // otherwise filter the owned visible collection; only then reveal/scroll
  // toward an exact off-screen option.
  const preferredProfileChildCandidates = visibleExactProfileChildCandidates.length
    ? visibleExactProfileChildCandidates
    : profileChildFilterCandidates.length
      ? profileChildFilterCandidates
      : exactProfileChildCandidates;
  const preferredProfileChildCandidateIds = new Set(preferredProfileChildCandidates.map((candidate) => candidate.candidateId));
  const admittedSelectablePool = current.filter((candidate) => (
    mechanicallySelectable(candidate)
    // Semantic exactness is authoritative across execution lanes. Once the
    // desired value exists on the owned surface, unrelated visible options
    // cannot force model arbitration ahead of its reveal/execute lifecycle.
    && (!preferredProfileChildCandidateIds.size || preferredProfileChildCandidateIds.has(candidate.candidateId))
    && !controlUnavailable(
      (page.controls || []).find((item) => item.controlId === candidate.controlId) || {},
      candidate
    )
    && !candidate.exclusionReason
    && (
      !["click", "type", "select", "keypress", "scroll", "click_xy"].includes(candidate.type)
      || candidate.executionChannel === agentContract.EXECUTION_LANE.NORMAL
      || candidate.mechanicalHypothesis === true
    )
  ));
  const provenSelectablePool = admittedSelectablePool.filter((candidate) => (
    candidate.executionChannel === agentContract.EXECUTION_LANE.NORMAL
  ));
  // A hypothesis is a last mechanical mile, never a competitor to a proven
  // exact action. Admit it only when this goal has no normal capability.
  const selectablePool = provenSelectablePool.length ? provenSelectablePool : admittedSelectablePool;
  const oneCurrentStrategyPerOperation = (items = []) => {
    const strategyRank = (candidate) => {
      if (candidate.intent !== "navigate_stage" || candidateOperation(candidate) !== "activate") return 0;
      if (candidate.interactionMethod === "browser_trusted_input") return 3;
      if (candidate.interactionMethod === "native_click") return 2;
      if (candidate.interactionMethod === "pointer_sequence") return 1;
      return 0;
    };
    const preferredByOperation = new Map();
    for (const candidate of items) {
      if (!["click", "keypress"].includes(candidate.type)) continue;
      const key = [candidate.controlId, candidate.operation].join("::");
      const current = preferredByOperation.get(key);
      if (!current || strategyRank(candidate) > strategyRank(current)) {
        preferredByOperation.set(key, candidate);
      }
    }
    // Choose the strongest actuator only within the same semantic control and
    // operation. Never reorder distinct actions such as modal Close and the
    // checkout-stage Continue that happens to share its label.
    return items.filter((candidate) => {
      if (!["click", "keypress"].includes(candidate.type)) return true;
      const key = [candidate.controlId, candidate.operation].join("::");
      return preferredByOperation.get(key) === candidate;
    });
  };
  // An exact goal-owned action outranks safe contextual navigation. This
  // prevents a Continue/Next control from bypassing a required correction.
  const hasGoalOwnedAction = selectablePool.some((candidate) => (
    candidate.goalCandidate === true
    && !["ask_user", "wait"].includes(candidate.type)
  ));
  const goalBoundSelectablePool = hasGoalOwnedAction
    ? selectablePool.filter((candidate) => candidate.goalCandidate === true)
    : selectablePool;
  // Handoff/wait are fallbacks, not peers of a grounded executable action.
  // Keeping both model-selectable lets ambiguity machinery choose to stop even
  // after the current surface has supplied one exact safe actuator.
  const hasGroundedAction = goalBoundSelectablePool.some((candidate) => !["ask_user", "wait"].includes(candidate.type));
  const decisiveSelectablePool = hasGroundedAction
    ? goalBoundSelectablePool.filter((candidate) => !["ask_user", "wait"].includes(candidate.type))
    : goalBoundSelectablePool;
  const selectable = oneCurrentStrategyPerOperation(decisiveSelectablePool)
    .sort((left, right) => {
      const leftControl = (page.controls || []).find((item) => item.controlId === left.controlId) || {};
      const rightControl = (page.controls || []).find((item) => item.controlId === right.controlId) || {};
      return profileChildCandidateScore(goal, right, rightControl) - profileChildCandidateScore(goal, left, leftControl);
    });
  const recoverySource = preferredProfileChildCandidates.length
    ? preferredProfileChildCandidates
    : current;
  const recoveryCandidates = oneCurrentStrategyPerOperation(recoverySource.filter((candidate) => (
    mechanicallySelectable(candidate)
    && candidate.admitted === true
    && !controlUnavailable(
      (page.controls || []).find((item) => item.controlId === candidate.controlId) || {},
      candidate
    )
    && [
      agentContract.EXECUTION_LANE.REVEAL,
      agentContract.EXECUTION_LANE.BOUNDED_RECOVERY
    ].includes(candidate.executionChannel)
    && candidate.mechanicalHypothesis !== true
    && !candidate.requiresJudgment
  )));
  const selectableIds = new Set(selectable.map((candidate) => candidate.candidateId));
  const recoveryIds = new Set(recoveryCandidates.map((candidate) => candidate.candidateId));
  const annotatedContext = current.map((candidate) => ({
    ...candidate,
    capabilityId: capabilityKey(candidate),
    admissionStatus: candidate.admitted === true ? "admitted" : "context_only",
    selectable: selectableIds.has(candidate.candidateId),
    recoverySelectable: recoveryIds.has(candidate.candidateId)
  }));
  const compactContextCapability = (candidate) => ({
    candidateId: candidate.candidateId,
    capabilityId: candidate.capabilityId,
    controlId: candidate.controlId,
    logicalControlId: candidate.logicalControlId,
    targetId: candidate.targetId,
    actuatorId: candidate.actuatorId,
    targetLabel: candidate.targetLabel,
    label: candidate.label,
    type: candidate.type,
    operation: candidate.operation,
    interactionMethod: candidate.interactionMethod,
    semantic: candidate.semantic,
    semanticIntent: candidate.semanticIntent,
    physicalEffect: candidate.physicalEffect,
    mechanicalEffect: candidate.mechanicalEffect,
    risk: candidate.risk,
    goalRelevant: candidate.goalRelevant === true,
    goalCandidate: candidate.goalCandidate === true,
    executionChannel: candidate.executionChannel,
    capabilityStatus: candidate.capabilityStatus,
    admissionStatus: candidate.admissionStatus,
    exclusionReason: candidate.exclusionReason,
    selectable: candidate.selectable === true,
    recoverySelectable: candidate.recoverySelectable === true
  });
  const contextCapabilities = annotatedContext.length <= 120
    ? annotatedContext
    : annotatedContext
      .sort((left, right) => Number(right.goalRelevant || right.selectable || right.recoverySelectable) - Number(left.goalRelevant || left.selectable || left.recoverySelectable))
      .slice(0, 120)
      .map(compactContextCapability);
  return {
    ...binding,
    obligationId: obligation?.id || (goal?.id) || "",
    // Context is complete; selection is policy-safe. The model can understand
    // blocked controls without receiving their IDs in its selectable enum.
    contextCapabilities,
    excludedCandidates,
    candidates: selectable,
    recoveryCandidates
  };
}

function bindMechanics({
  obligation,
  decisionFrame = null,
  observation = {},
  traveler = {},
  state = {},
  approvals = {},
  attemptedCandidateIds = [],
  attemptedStrategySignatures = []
} = {}) {
  if (!obligation || obligation.contractVersion !== CURRENT_OBLIGATION_VERSION) {
    const error = new Error("BIND_MECHANICS_CURRENT_OBLIGATION_REQUIRED");
    error.code = "BIND_MECHANICS_CURRENT_OBLIGATION_REQUIRED";
    throw error;
  }
  if (!obligation.desiredStateDelta?.contractVersion
    || obligation.desiredStateDelta.actionRequired !== true) {
    const error = new Error("BIND_MECHANICS_DESIRED_STATE_DELTA_REQUIRED");
    error.code = "BIND_MECHANICS_DESIRED_STATE_DELTA_REQUIRED";
    throw error;
  }
  if (decisionFrame && (
    decisionFrame.frameId !== obligation.decisionFrameId
  )) {
    const error = new Error("BIND_MECHANICS_DECISION_FRAME_MISMATCH");
    error.code = "BIND_MECHANICS_DECISION_FRAME_MISMATCH";
    throw error;
  }
  const goal = mechanicsGoalFromObligation(obligation, decisionFrame, observation);
  return buildCurrentCandidateSet({
    obligation,
    goal,
    observation,
    traveler,
    state,
    approvals,
    attemptedCandidateIds,
    attemptedStrategySignatures
  });
}

function draftForBoundMechanic(obligation = {}, candidate = {}, observation = {}) {
  const profile = obligation?.desiredStateDelta?.kind === "profile_field";
  return normalizeAction({
    id: `${profile ? "act_goal" : "act_candidate"}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    observationId: observation.observationId || "",
    observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
    type: candidate.type,
    intent: profile ? "satisfy_semantic_goal" : candidate.intent,
    operation: candidate.operation,
    obligationId: (obligation?.id),
    semanticOwner: semanticOwner(obligation),
    candidateId: candidate.candidateId,
    candidateClass: candidate.candidateClass || "proven_action",
    mechanicalHypothesis: candidate.mechanicalHypothesis === true,
    discoveryEnvelope: candidate.discoveryEnvelope || null,
    logicalControlId: candidate.logicalControlId || candidate.controlId || obligation?.admittedControlIds?.[0] || "",
    actuatorId: candidate.actuatorId || candidate.targetId || "",
    controlId: candidate.controlId || obligation?.admittedControlIds?.[0] || "",
    decisionGroupId: candidate.decisionGroupId || "",
    requirementId: candidate.requirementId || "",
    interactionMethod: candidate.interactionMethod || "",
    boundedRecovery: candidate.boundedRecovery === true,
    exactOption: candidate.exactOption || candidate.pipelineContract?.component?.exactOption || null,
    targetLabel: candidate.targetLabel || (profile
      ? candidate.semanticType || obligation?.semanticOwner?.family || ""
      : ""),
    value: candidate.value || (profile && ["choose", "select", "activate"].includes(candidate.operation)
      ? candidate.exactOption?.label || candidate.targetLabel || ""
      : ""),
    keys: candidate.keys || "",
    x: candidate.visualRegion
      ? Number(candidate.visualRegion.centerX ?? (Number(candidate.visualRegion.x || 0) + Number(candidate.visualRegion.width || 0) / 2))
      : null,
    y: candidate.visualRegion
      ? Number(candidate.visualRegion.centerY ?? (Number(candidate.visualRegion.y || 0) + Number(candidate.visualRegion.height || 0) / 2))
      : null,
    visualRegion: candidate.visualRegion || null,
    expectedOutcome: candidate.expectedOutcome || null,
    desiredStateDelta: obligation.desiredStateDelta || null,
    pipelineContract: candidate.pipelineContract || null,
    capabilityStatus: candidate.capabilityStatus || "",
    executionChannel: candidate.executionChannel || "",
    interactionRole: candidate.interactionRole,
    semanticEffect: candidate.semanticEffect,
    expectedEvidence: candidate.expectedEvidence,
    intendedOutcome: candidate.intendedOutcome || "",
    semanticOwnershipLinkId: candidate.semanticOwnershipLinkId || "",
    policyCorrectionForDecisionGroupId: candidate.policyCorrectionForDecisionGroupId || "",
    affordance: candidate.affordance || null,
    risk: profile ? "safe" : candidate.risk,
    requiresApproval: profile ? false : candidate.requiresApproval,
    reason: candidate.summary || (profile
      ? `Execute candidate ${candidate.candidateId} for ${candidate.semanticType || obligation?.semanticOwner?.family || "profile field"}=${obligation?.desiredStateDelta?.desiredValue}.`
      : `Execute current candidate ${candidate.candidateId}.`)
  });
}

function actionForCurrentCandidate(obligation = {}, candidate = {}, observation = {}) {
  const action = draftForBoundMechanic(obligation, candidate, observation);
  const semanticOwnershipLinkId = candidate.semanticOwnershipLinkId
    || candidate.expectedOutcome?.semanticOwnershipLinkId
    || action.semanticOwnershipLinkId
    || "";
  const policyCorrectionForDecisionGroupId = candidate.policyCorrectionForDecisionGroupId
    || action.policyCorrectionForDecisionGroupId
    || (semanticOwnershipLinkId ? candidate.expectedOutcome?.decisionGroupId : "")
    || "";
  return {
    ...action,
    semanticOwner: semanticOwner(obligation),
    semanticOwnershipLinkId,
    policyCorrectionForDecisionGroupId,
    candidateId: candidate.candidateId,
    candidateClass: candidate.candidateClass || action.candidateClass || "proven_action",
    mechanicalHypothesis: candidate.mechanicalHypothesis === true || action.mechanicalHypothesis === true,
    discoveryEnvelope: candidate.discoveryEnvelope || action.discoveryEnvelope || null,
    logicalControlId: candidate.logicalControlId || candidate.controlId || action.logicalControlId || action.controlId || "",
    actuatorId: candidate.actuatorId || candidate.targetId || action.actuatorId || "",
    observationId: candidate.observationId || action.observationId,
    observationHash: candidate.observationHash || action.observationHash,
    surfaceId: candidate.surfaceId || action.surfaceId || "",
    interactionRole: candidate.interactionRole || action.interactionRole || "",
    semanticEffect: candidate.semanticEffect || candidate.semanticIntent || action.semanticEffect || "",
    expectedEvidence: candidate.expectedEvidence || action.expectedEvidence || "",
    mechanicalEffect: candidate.mechanicalEffect || candidate.physicalEffect || candidate.affordance?.mechanicalEffect || action.affordance?.mechanicalEffect || "",
    intent: action.intent || "",
    expectedPostconditions: candidate.expectedPostconditions || action.expectedPostconditions || (candidate.expectedOutcome ? [candidate.expectedOutcome] : []),
    localMechanicalPostcondition: candidate.localMechanicalPostcondition || candidate.expectedOutcome || action.expectedOutcome || null,
    obligationSuccessCondition: candidate.obligationSuccessCondition || candidate.outcomeContract || action.obligationSuccessCondition || null,
    outcomeCompatibility: candidate.outcomeCompatibility || "unknown",
    affordance: candidate.affordance || action.affordance || null,
    pipelineContract: candidate.pipelineContract || action.pipelineContract || null,
    capabilityStatus: candidate.capabilityStatus || action.capabilityStatus || "",
    executionChannel: candidate.executionChannel || action.executionChannel || "",
    interactionMethod: candidate.interactionMethod || action.interactionMethod || "",
    boundedRecovery: candidate.boundedRecovery === true || action.boundedRecovery === true,
    exactOption: candidate.exactOption
      || candidate.pipelineContract?.component?.exactOption
      || action.exactOption
      || null
  };
}

module.exports = {
  actionForCurrentCandidate,
  bindMechanics,
  resolveMechanicsGoal: mechanicsGoalFromObligation
};
