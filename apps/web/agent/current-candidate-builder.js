const {
  actionForObservationCandidate,
  buildObservationCandidateSet
} = require("./observation-candidates");
const {
  actionForProfileCandidate,
  candidatesForProfileGoal
} = require("./skill-expander");
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
  normalizeVisualRegion
} = require("../../../packages/shared/agent-actions");
const agentContract = require("../../extension/src/shared/agent-contract");
const { canonicalOptionMatch } = require("./logical-field");
const { CURRENT_OBLIGATION_VERSION } = require("./authority-frames");
const { obligationField, semanticOwner } = require("./current-obligation");

function candidateOperation(candidate = {}) {
  return candidate.authorizedOperation
    || (candidate.operation === "scroll_to" ? "" : candidate.operation)
    || "";
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
    || control.state?.available === false
    || /(?:^|\b)(?:not available|unavailable|sold out|disabled)(?:\b|$)/i.test(
      `${control.semantic || ""} ${control.risk || ""} ${control.label || ""}`
    );
}

function candidateActionabilityFailure(candidate = {}, control = {}, observation = {}, strategyAlreadyFailed = false) {
  if (!["click", "type", "select", "keypress", "scroll", "click_xy"].includes(candidate.type)) return "";
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
  if (
    obligationField(goal, "kind") !== "profile_field"
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
  if (/payment|purchase|book[_ ]?now|confirm[_ ]?booking|paid|price|legal|terms|consent|subscribe/.test(meaning)) {
    return null;
  }
  const surfaceId = candidate.surfaceId || control.surfaceId || observation.page?.currentSurface?.id || "surface-page";
  return Object.freeze({
    kind: "pre_surface_discovery",
    objective: `Reveal the exact owned choice surface for ${obligationField(goal, "semanticType") || obligationField(goal, "label") || "the current field"}.`,
    logicalControlId: control.controlId || candidate.controlId || "",
    actuatorId: candidate.targetId,
    sourceSurfaceId: surfaceId,
    allowedOperations: Object.freeze(["open"]),
    forbiddenRisks: Object.freeze(["money", "payment", "legal", "uncertain"]),
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
  const ownership = obligationField(goal, "surfaceExitOwnership") || candidate.pipelineContract?.surfaceOwnership || null;
  if (
    obligationField(goal, "semanticType") !== "completed_choice_surface"
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
    logicalFieldId: obligationField(goal, "logicalFieldId") || "",
    componentIdentity: `${obligationField(goal, "logicalFieldId") || control.stableKey || control.controlId}:${obligationField(goal, "componentRole") || "value"}`,
    componentRole: obligationField(goal, "componentRole") || "value",
    controlId: control.controlId || candidate.controlId || "",
    controlRole: control.role || control.kind || "",
    currentCanonicalValue: observed.currentCanonicalValue || "",
    desiredCanonicalValue: obligationField(goal, "desiredValue") || obligationField(goal, "canonicalValue") || "",
    observedOptions: observed.observedOptions || []
  };
  const component = obligationField(goal, "kind") === "adaptive_surface"
    ? {
        ...(obligationField(goal, "componentBinding") || {}),
        ...fallbackComponent,
        componentIdentity: `${obligationField(goal, "logicalFieldId") || "adaptive"}:surface:${control.stableKey || control.controlId}`,
        parentControlId: obligationField(goal, "controlId") || obligationField(goal, "componentBinding")?.controlId || ""
      }
    : existing?.component || obligationField(goal, "componentBinding") || fallbackComponent;
  return agentContract.canonicalPipelineContract({
    requirement: existing?.requirement || obligationField(goal, "requirementContract") || {
      requirementId: obligationField(goal, "requirementId") || obligationField(goal, "goalId") || obligationField(goal, "decisionGroupId") || "",
      subjectId: obligationField(goal, "subjectId") || "",
      semanticType: obligationField(goal, "semanticType") || obligationField(goal, "sectionType") || "",
      desiredCanonicalValue: obligationField(goal, "canonicalValue") || obligationField(goal, "desiredValue") || ""
    },
    component,
    capability,
    expectedOutcome,
    validationOwnership: existing?.validationOwnership || obligationField(goal, "validationOwnership") || observed.validationOwnership || {},
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
  if ((obligationField(goal, "selectionMode") === "ai_ambiguity" || obligationField(goal, "semanticType") === "surface_ambiguity")
    && obligationField(goal, "kind") !== "adaptive_surface") return false;
  if (obligation?.contractVersion === CURRENT_OBLIGATION_VERSION) {
    if (obligation.policyDecision?.status !== "admitted") return false;
    if (new Set(obligation.admittedControlIds || []).has(candidate.controlId)) return true;
    // Portalled child options are compiled only after the admitted parent
    // opens. They remain mechanics for that same profile/adaptive obligation,
    // never a new semantic task chosen by the binder.
    return isGoalCandidate && ["profile_field", "adaptive_surface"].includes(obligationField(goal, "kind"));
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

function adaptiveCandidateAllowed(goal = {}, candidate = {}, control = {}) {
  if (!["adaptive_surface", "adaptive_interaction"].includes(obligationField(goal, "kind"))) return true;
  const envelope = obligationField(goal, "adaptiveEnvelope") || {};
  const operation = candidateOperation(candidate);
  if (!(envelope.allowedOperations || []).includes(operation)) return false;
  const risk = normalizedMeaning(candidate.risk || control.risk || "uncertain");
  if ((envelope.forbiddenRisks || []).some((item) => risk === normalizedMeaning(item))) return false;
  if (Number(candidate.structuredPrice?.amount ?? control.structuredPrice?.amount) > 0) return false;
  const effect = normalizedMeaning([
    candidate.physicalEffect,
    candidate.mechanicalEffect,
    candidate.semantic,
    candidate.intent,
    control.physicalEffect,
    control.semantic
  ].filter(Boolean).join(" "));
  if ((envelope.forbiddenEffects || []).some((item) => effect.includes(normalizedMeaning(item)))) return false;
  if (obligationField(goal, "kind") === "adaptive_surface"
    && (candidate.intent === "navigate_stage" || candidate.interactionRole === "navigation")) return false;
  return !/payment|purchase|card|accept legal|legal consent|paid option|add paid/.test(effect);
}

function adaptiveCandidateScore(goal = {}, candidate = {}, control = {}) {
  if (obligationField(goal, "kind") !== "adaptive_surface") return 0;
  const rawDesired = String(obligationField(goal, "desiredValue") ?? obligationField(goal, "canonicalValue") ?? "").trim();
  const desired = normalizedMeaning(rawDesired);
  const desiredTerms = [...new Set([
    desired,
    ...(obligationField(goal, "choiceTerms") || []).map(normalizedMeaning),
    ...(obligationField(goal, "sourceGoal")?.choiceTerms || []).map(normalizedMeaning)
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
      obligationField(goal, "semanticType") || obligationField(goal, "sourceGoal")?.semanticType || "",
      obligationField(goal, "componentRole") || obligationField(goal, "sourceGoal")?.componentRole || "value",
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
  const goalCandidates = obligationField(goal, "kind") === "profile_field"
    ? candidatesForProfileGoal(goal, observation, traveler, [], { includeAlternates: true })
    : buildObservationCandidateSet(goal, observation).candidates;
  const contextGoal = {
    ...goal,
    kind: "",
    semanticType: "surface_ambiguity",
    selectionMode: "ai_ambiguity",
    decisionGroupId: "",
    requirementId: "",
    eligibleAlternativeControlIds: [],
    freeAlternativeControlIds: [],
    paidAlternativeControlIds: []
  };
  const surfaceCandidates = buildObservationCandidateSet(contextGoal, observation).candidates;
  const byCapability = new Map(surfaceCandidates.map((candidate) => [capabilityKey(candidate), candidate]));
  // Goal-specific candidates replace the contextual version of the same
  // capability so their typed postcondition remains authoritative.
  for (const candidate of goalCandidates) byCapability.set(capabilityKey(candidate), candidate);
  return {
    goalCandidateKeys: new Set(goalCandidates.map(capabilityKey)),
    candidates: [...byCapability.values()]
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
  if (obligationField(goal, "kind") === "profile_field" && control.role === "editable_combobox"
    && ["type", "keyboard"].includes(operation)) return "filter_options";
  const observedSemanticEffect = agentContract.canonicalSemanticEffect(control.semantic || "");
  const explicit = String(
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
  );
  if (explicit) return explicit;
  if (["open", "reveal"].includes(operation)) return "open_surface";
  if (["type", "fill"].includes(operation)) return "type_value";
  if (["choose", "select"].includes(operation)) return "select_option";
  if (operation === "keyboard") return "keyboard_input";
  if (operation === "scroll_to") return "scroll_into_view";
  return String(candidate.physicalEffect || candidate.mechanicalEffect || control.physicalEffect || operation || "unknown");
}

function buildCurrentCandidateSet({
  goal = null,
  observation = {},
  traveler = {},
  state = {},
  approvals = {},
  obligation = state.taskState?.currentObligation || null,
  attemptedCandidateIds = [],
  attemptedStrategySignatures = []
} = {}) {
  // The obligation is authoritative whenever present. `goal` remains only as
  // a standalone test/replay input; production binding consumes the explicit
  // obligation mechanics and never reconstructs a hidden semantic goal.
  goal = obligation || goal || {};
  const binding = surfaceBinding(observation);
  const page = observation.page || {};
  const attempted = new Set(attemptedCandidateIds || []);
  const attemptedStrategies = new Set(attemptedStrategySignatures || []);
  const outcomeContract = obligationField(goal, "successCondition")
    || obligationField(goal, "outcomeContract")
    || outcomeContractForGoal(goal, observation);
  const parentOutcomeContract = state.taskState?.stageOutcome?.outcomeContract
    || obligationField(goal, "parentOutcomeContract")
    || outcomeContract;
  const allCapabilities = allCurrentCapabilityCandidates(goal, observation, traveler);
  const completedSurfaceExitIds = new Set(
    obligationField(goal, "semanticType") === "completed_choice_surface"
      ? (obligationField(goal, "actionableControlIds") || []).filter(Boolean)
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
    ) && adaptiveCandidateAllowed(goal, candidate, control));
  }).map((candidate, index) => {
    const bound = bindCandidateEnvelope(candidate, index, observation, binding);
    const control = (page.controls || []).find((item) => item.controlId === bound.controlId) || {};
    const semantics = normalizedActionSemantics(bound, { control, goal, expectedOutcome: bound.expectedOutcome });
    const adaptiveScore = adaptiveCandidateScore(goal, bound, control);
    const adaptiveExactMatch = obligationField(goal, "kind") === "adaptive_surface" && adaptiveScore >= 90;
    const exactProfileOption = obligationField(goal, "kind") === "profile_field"
      && bound.exactOption?.canonicalValue
      && normalizedMeaning(bound.exactOption.canonicalValue) === normalizedMeaning(obligationField(goal, "desiredValue") || obligationField(goal, "canonicalValue") || "");
    const adaptiveDeterministicFilter = obligationField(goal, "kind") === "adaptive_surface"
      && candidateOperation(bound) === "type"
      && adaptiveScore === 70;
    const profileChoiceQuery = obligationField(goal, "kind") === "profile_field"
      && control.role === "editable_combobox"
      && ["type", "keyboard"].includes(candidateOperation(bound));
    const observedAdaptiveEffect = normalizedMeaning(bound.physicalEffect || control.physicalEffect || "unknown");
    const physicalEffect = profileChoiceQuery
      ? "filter_options"
      : adaptiveExactMatch || exactProfileOption
      ? "set_field_value"
      : adaptiveDeterministicFilter
        ? "filter_options"
        : obligationField(goal, "kind") === "adaptive_surface" && (!observedAdaptiveEffect || observedAdaptiveEffect === "unknown")
          ? "unknown"
          : localMechanicalEffect(goal, bound, control);
    // TaskState's obligation success condition is authoritative. Candidate
    // mechanics may describe an intermediate browser effect, but they must
    // not weaken a choice component's settlement contract into a scalar value
    // change. In particular, typing into an editable combobox is filtering
    // progress until the exact child option is selected and the popup settles.
    const goalComponentOutcome = obligationField(goal, "successCondition")
      || obligationField(goal, "expectedOutcome")
      || obligationField(goal, "postcondition")
      || {};
    const editableProfileQuery = Boolean(
      profileChoiceQuery
      && (
        goalComponentOutcome.commitRequirement === "logical_component_committed"
        || goalComponentOutcome.type === "logical_component_committed"
      )
    );
    const boundedInteractionOutcome = obligationField(goal, "kind") === "adaptive_interaction" ? {
      type: "observable_change",
      controlId: bound.controlId || control.controlId || "",
      surfaceId: binding.surfaceId || "",
      mustNotIncreasePrice: true
    } : null;
    const exactComponentExpectedOutcome = editableProfileQuery ? {
      ...(bound.expectedOutcome || {}),
      type: "semantic_progress",
      logicalFieldId: obligationField(goal, "logicalFieldId") || goalComponentOutcome.logicalFieldId || "",
      subjectId: obligationField(goal, "subjectId") || goalComponentOutcome.subjectId || "traveler_1",
      semanticType: obligationField(goal, "semanticType") || goalComponentOutcome.semanticType || "",
      componentRole: obligationField(goal, "componentRole") || goalComponentOutcome.componentRole || "value",
      controlId: obligationField(goal, "controlId") || obligationField(goal, "componentBinding")?.controlId || bound.controlId || "",
      expectedComponentValue: obligationField(goal, "desiredValue") ?? obligationField(goal, "canonicalValue") ?? "",
      expectedCanonicalValue: goalComponentOutcome.expectedCanonicalValue
        ?? obligationField(goal, "canonicalValue")
        ?? obligationField(goal, "desiredValue")
        ?? "",
      expectedNormalizedValue: obligationField(goal, "desiredValue") ?? obligationField(goal, "canonicalValue") ?? "",
      interactionKind: "editable_combobox",
      commitRequirement: "logical_component_committed",
      canonicalTarget: obligationField(goal, "desiredValue") ?? obligationField(goal, "canonicalValue") ?? "",
      mustNotIncreasePrice: true
    } : adaptiveExactMatch || exactProfileOption ? {
      ...goalComponentOutcome,
      type: "logical_component_committed",
      logicalFieldId: obligationField(goal, "logicalFieldId") || "",
      semanticType: obligationField(goal, "semanticType") || "",
      componentRole: obligationField(goal, "componentRole") || "value",
      controlId: obligationField(goal, "controlId") || obligationField(goal, "componentBinding")?.controlId || "",
      stateControlIds: goalComponentOutcome.stateControlIds
        || obligationField(goal, "componentBinding")?.representationControlIds
        || obligationField(goal, "componentBinding")?.stateControlIds
        || [],
      expectedCanonicalValue: obligationField(goal, "desiredValue") ?? obligationField(goal, "canonicalValue") ?? "",
      expectedNormalizedValue: obligationField(goal, "desiredValue") ?? obligationField(goal, "canonicalValue") ?? "",
      surfaceId: binding.surfaceId || "",
      requireSurfaceDismissed: true,
      mustNotIncreasePrice: true
    } : (bound.expectedOutcome || boundedInteractionOutcome);
    const compiledExpectedOutcome = compileTypedExpectedOutcome({
      ...bound,
      expectedOutcome: exactComponentExpectedOutcome,
      physicalEffect,
      goal: { ...goal, outcomeContract }
    }, page);
    const expectedOutcome = adaptiveExactMatch || exactProfileOption ? {
      ...compiledExpectedOutcome,
      controlId: obligationField(goal, "controlId") || obligationField(goal, "componentBinding")?.controlId || compiledExpectedOutcome?.controlId || "",
      logicalFieldId: obligationField(goal, "logicalFieldId") || compiledExpectedOutcome?.logicalFieldId || "",
      semanticType: obligationField(goal, "semanticType") || compiledExpectedOutcome?.semanticType || "",
      componentRole: obligationField(goal, "componentRole") || compiledExpectedOutcome?.componentRole || "value",
      expectedCanonicalValue: obligationField(goal, "desiredValue") ?? obligationField(goal, "canonicalValue") ?? "",
      expectedNormalizedValue: obligationField(goal, "desiredValue") ?? obligationField(goal, "canonicalValue") ?? ""
    } : compiledExpectedOutcome;
    const pipelineContract = pipelineContractForCandidate(goal, bound, control, expectedOutcome, observation);
    const semanticIntent = String(
      obligationField(goal, "semanticEffect")
      || obligationField(goal, "desiredSemanticOutcome")
      || obligationField(goal, "desiredPolicyOutcome")
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
        && (obligationField(goal, "kind") !== "adaptive_surface" || adaptiveScore >= 70),
      requiresApproval: exactProfileOption ? false : Boolean(bound.requiresApproval),
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
      risk: adaptiveExactMatch || adaptiveDeterministicFilter || exactProfileOption || obligationField(goal, "kind") === "adaptive_interaction"
        ? "safe"
        : (bound.risk || (obligationField(goal, "kind") === "profile_field" ? "safe" : "uncertain")),
      requiresJudgment: adaptiveExactMatch || adaptiveDeterministicFilter || exactProfileOption
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
    const policyDecision = laneInput.goalRelevant
      && obligation?.policyDecision?.status !== "blocked"
      ? {
          allow: true,
          decision: "obligation_admitted",
          reason: "Mechanics are bound to the exact TaskState-admitted obligation; final consequence policy is evaluated by the governor."
        }
      : { allow: false, decision: "context_only", reason: "Not owned by the current TaskState obligation." };
    return {
      ...grounded,
      policyDecision,
      affordance: Object.freeze({
        ...affordance,
        policy: Object.freeze({
          allow: policyDecision.allow === true,
          decision: String(policyDecision.decision || "deny"),
          reason: String(policyDecision.reason || "")
        })
      }),
      exclusionReason: controlUnavailable(control, grounded)
        ? "CONTROL_UNAVAILABLE"
        : actionabilityFailure
          ? actionabilityFailure
        : policyDecision.allow !== true
          ? `POLICY_${String(policyDecision.decision || "deny").toUpperCase()}`
          : ""
    };
  });
  const excludedCandidates = current.filter((candidate) => candidate.goalRelevant && (
    Boolean(candidate.exclusionReason)
      || attempted.has(candidate.candidateId)
      || attempted.has(candidate.strategyId)
      || attemptedStrategies.has(actuatorSignature(candidate))
  ));
  const policySelectable = (candidate) => {
    if (!candidate.goalRelevant) return false;
    const nonMutating = ["ask_user", "wait"].includes(candidate.type);
    if (!nonMutating && candidate.policyDecision?.allow !== true) return false;
    if (!nonMutating && candidate.requiresApproval && !candidate.affordance?.authorization?.authorizationId) return false;
    return !attempted.has(candidate.candidateId)
      && !attempted.has(candidate.strategyId)
      && !attemptedStrategies.has(actuatorSignature(candidate));
  };
  const adaptiveExactCandidates = obligationField(goal, "kind") === "adaptive_surface"
    ? current.filter((candidate) => {
      const control = (page.controls || []).find((item) => item.controlId === candidate.controlId) || {};
      return policySelectable(candidate)
        && candidate.policyDecision?.allow === true
        && !controlUnavailable(control, candidate)
        && adaptiveCandidateScore(goal, candidate, control) >= 90;
    })
    : [];
  const adaptiveVisibleExactCandidates = adaptiveExactCandidates.filter((candidate) => (
    candidate.executionChannel === agentContract.EXECUTION_LANE.NORMAL
  ));
  const adaptiveFilterCandidates = obligationField(goal, "kind") === "adaptive_surface"
    ? current.filter((candidate) => {
      const control = (page.controls || []).find((item) => item.controlId === candidate.controlId) || {};
      return policySelectable(candidate)
        && candidate.policyDecision?.allow === true
        && candidate.executionChannel === agentContract.EXECUTION_LANE.NORMAL
        && candidateOperation(candidate) === "type"
        && adaptiveCandidateScore(goal, candidate, control) === 70;
    })
    : [];
  // Cheapest deterministic mechanics win: click an exact visible option;
  // otherwise filter the owned visible collection; only then reveal/scroll
  // toward an exact off-screen option.
  const adaptivePreferredCandidates = adaptiveVisibleExactCandidates.length
    ? adaptiveVisibleExactCandidates
    : adaptiveFilterCandidates.length
      ? adaptiveFilterCandidates
      : adaptiveExactCandidates;
  const adaptivePreferredCandidateIds = new Set(adaptivePreferredCandidates.map((candidate) => candidate.candidateId));
  const policySelectablePool = current.filter((candidate) => (
    policySelectable(candidate)
    // Semantic exactness is authoritative across execution lanes. Once the
    // desired value exists on the owned surface, unrelated visible options
    // cannot force model arbitration ahead of its reveal/execute lifecycle.
    && (!adaptivePreferredCandidateIds.size || adaptivePreferredCandidateIds.has(candidate.candidateId))
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
  const provenSelectablePool = policySelectablePool.filter((candidate) => (
    candidate.executionChannel === agentContract.EXECUTION_LANE.NORMAL
  ));
  // A hypothesis is a last mechanical mile, never a competitor to a proven
  // exact action. Admit it only when this goal has no normal capability.
  const selectablePool = provenSelectablePool.length ? provenSelectablePool : policySelectablePool;
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
      return adaptiveCandidateScore(goal, right, rightControl) - adaptiveCandidateScore(goal, left, leftControl);
    });
  const recoverySource = adaptivePreferredCandidates.length
    ? adaptivePreferredCandidates
    : current;
  const recoveryCandidates = oneCurrentStrategyPerOperation(recoverySource.filter((candidate) => (
    policySelectable(candidate)
    && candidate.policyDecision?.allow === true
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
    policyStatus: candidate.policyDecision?.allow === true
      ? (candidate.goalRelevant ? "allowed" : "context_only")
      : String(candidate.policyDecision?.decision || "denied"),
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
    policyStatus: candidate.policyStatus,
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
    obligationId: obligation?.obligationId || obligationField(goal, "goalId") || "",
    mechanicContract: goal,
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
  if (decisionFrame && (
    decisionFrame.observationId !== obligation.observationId
    || decisionFrame.observationHash !== obligation.observationHash
  )) {
    const error = new Error("BIND_MECHANICS_DECISION_FRAME_MISMATCH");
    error.code = "BIND_MECHANICS_DECISION_FRAME_MISMATCH";
    throw error;
  }
  return buildCurrentCandidateSet({
    obligation,
    observation,
    traveler,
    state,
    approvals,
    attemptedCandidateIds,
    attemptedStrategySignatures
  });
}

function actionForCurrentCandidate(goal = {}, candidate = {}, observation = {}) {
  const action = obligationField(goal, "kind") === "profile_field"
    ? actionForProfileCandidate(goal, candidate, observation)
    : actionForObservationCandidate(goal, candidate, observation);
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
    semanticOwner: semanticOwner(goal),
    semanticOwnershipLinkId,
    policyCorrectionForDecisionGroupId,
    candidateId: candidate.candidateId,
    candidateClass: candidate.candidateClass || action.candidateClass || "proven_action",
    mechanicalHypothesis: candidate.mechanicalHypothesis === true || action.mechanicalHypothesis === true,
    discoveryEnvelope: candidate.discoveryEnvelope || action.discoveryEnvelope || null,
    logicalControlId: candidate.logicalControlId || candidate.controlId || action.logicalControlId || action.controlId || "",
    actuatorId: candidate.actuatorId || candidate.targetId || action.actuatorId || action.targetId || "",
    observationId: candidate.observationId || action.observationId,
    observationHash: candidate.observationHash || action.observationHash,
    surfaceId: candidate.surfaceId || action.surfaceId || "",
    interactionRole: candidate.interactionRole || action.interactionRole || "",
    semanticEffect: candidate.semanticEffect || action.semanticEffect || "",
    expectedEvidence: candidate.expectedEvidence || action.expectedEvidence || "",
    physicalEffect: candidate.physicalEffect || candidate.affordance?.physicalEffect || action.affordance?.physicalEffect || "",
    mechanicalEffect: candidate.mechanicalEffect || candidate.physicalEffect || candidate.affordance?.mechanicalEffect || action.affordance?.mechanicalEffect || "",
    semanticIntent: candidate.semanticIntent || action.semanticIntent || action.intent || "",
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
  bindMechanics
};
