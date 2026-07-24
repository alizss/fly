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
  assessOutcomeCompatibility,
  expectedPostconditionsForAction,
  outcomeContractForGoal,
  predictPhysicalEffect,
  semanticIntentForAction,
  normalizedActionSemantics
} = require("./action-semantics");
const { evaluateActionPolicy } = require("../../../packages/shared/policy");
const { actuatorSignature } = require("../../../packages/shared/agent-actions");

function controlUnavailable(control = {}) {
  return control.disabled === true
    || control.state?.disabled === true
    || control.state?.available === false
    || /(?:^|\b)(?:not available|unavailable|sold out|disabled)(?:\b|$)/i.test(
      `${control.semantic || ""} ${control.risk || ""} ${control.label || ""}`
    );
}

function candidateActionabilityFailure(candidate = {}, control = {}) {
  if (!["click", "type", "select", "keypress", "scroll", "click_xy"].includes(candidate.type)) return "";
  if (candidate.type === "click_xy") return candidate.visualRegion ? "" : "ACTIONABILITY_UNPROVEN";
  const operation = candidate.authorizedOperation
    || (candidate.operation === "scroll_to" ? "" : candidate.operation)
    || "";
  const capability = operation ? control.operations?.[operation] : null;
  const actionability = candidate.actionability || capability?.actionability || null;
  if (!capability || !actionability) return "ACTIONABILITY_UNPROVEN";
  if (candidate.type === "scroll") {
    return actionability.revealable === true ? "" : (actionability.code || "TARGET_NOT_REVEALABLE");
  }
  return actionability.executable === true || actionability.revealable === true
    ? ""
    : (actionability.code || "TARGET_NOT_ACTIONABLE");
}

function candidatePolicyAction(goal = {}, candidate = {}, control = {}, observation = {}) {
  return {
    ...actionForCurrentCandidate(goal, candidate, observation),
    targetSnapshot: {
      id: candidate.targetId || "",
      controlId: candidate.controlId || "",
      decisionGroupId: candidate.decisionGroupId || control.decisionGroupId || "",
      semantic: control.semantic || candidate.semantic || "",
      risk: control.risk || candidate.risk || "uncertain",
      kind: control.kind || "",
      role: control.role || "",
      surfaceId: candidate.surfaceId || control.surfaceId || "",
      surfaceType: candidate.surfaceType || control.surfaceType || "page",
      intendedOutcome: candidate.intendedOutcome || "",
      semanticOwnershipLinkId: candidate.semanticOwnershipLinkId || "",
      policyCorrectionForDecisionGroupId: candidate.policyCorrectionForDecisionGroupId || ""
    }
  };
}

function observationHash(observation = {}) {
  return String(observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "");
}

function capabilityKey(candidate = {}) {
  return [candidate.controlId, candidate.operation, candidate.targetId, candidate.type, candidate.value, candidate.keys]
    .map(String)
    .join("::");
}

function relevantToVisibleSurface(goal = {}, candidate = {}, isGoalCandidate = false) {
  if (isGoalCandidate) return true;
  if (goal.selectionMode === "ai_ambiguity" || goal.semanticType === "surface_ambiguity") return true;
  if (goal.kind === "profile_field" || goal.decisionGroupId) return false;
  if (goal.semanticType === "navigation") {
    const ids = new Set(goal.actionableControlIds || []);
    return ids.has(candidate.controlId);
  }
  return false;
}

function allCurrentCapabilityCandidates(goal = {}, observation = {}, traveler = {}) {
  const goalCandidates = goal.kind === "profile_field"
    ? candidatesForProfileGoal(goal, observation, traveler, [])
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
    strategyId: candidate.strategyId || candidate.candidateId || "",
    candidateId: `${binding.observationId || "observation"}:candidate_${index + 1}`,
    observationId: binding.observationId || "",
    observationHash: binding.observationHash || observationHash(observation),
    surfaceId: binding.surfaceId || "",
    surfaceType: binding.surfaceType || "page"
  };
}

function buildCurrentCandidateSet({
  goal = {},
  observation = {},
  traveler = {},
  state = {},
  approvals = {},
  attemptedCandidateIds = [],
  attemptedStrategySignatures = []
} = {}) {
  const binding = surfaceBinding(observation);
  const page = observation.page || {};
  const foregroundOwnsSelection = binding.surfaceType !== "page";
  const attempted = new Set(attemptedCandidateIds || []);
  const attemptedStrategies = new Set(attemptedStrategySignatures || []);
  const outcomeContract = outcomeContractForGoal(goal, observation);
  const parentOutcomeContract = state.taskState?.stageOutcome?.outcomeContract
    || goal.parentOutcomeContract
    || outcomeContract;
  const allCapabilities = allCurrentCapabilityCandidates(goal, observation, traveler);
  const current = allCapabilities.candidates.filter((candidate) => {
    if (!["click", "type", "select", "keypress", "scroll", "click_xy"].includes(candidate.type)) return true;
    const control = (page.controls || []).find((item) => item.controlId === candidate.controlId);
    return Boolean(control && controlBelongsToCurrentSurface(control, page));
  }).map((candidate, index) => {
    const bound = bindCandidateEnvelope(candidate, index, observation, binding);
    const control = (page.controls || []).find((item) => item.controlId === bound.controlId) || {};
    const semantics = normalizedActionSemantics(bound, { control, goal, expectedOutcome: bound.expectedOutcome });
    const physicalEffect = predictPhysicalEffect({ semantics, control, candidate: bound, goal: { ...goal, outcomeContract } });
    const expectedOutcome = compileTypedExpectedOutcome({ ...bound, physicalEffect, goal: { ...goal, outcomeContract } }, page);
    const semanticIntent = semanticIntentForAction({
      mechanicalEffect: physicalEffect,
      control,
      candidate: bound,
      goal,
      observation
    });
    const expectedPostconditions = expectedPostconditionsForAction({
      expectedOutcome,
      semanticIntent,
      mechanicalEffect: physicalEffect,
      goal
    });
    const outcomeCompatibility = assessOutcomeCompatibility({
      goal,
      durableObjective: parentOutcomeContract,
      mechanicalEffect: physicalEffect,
      semanticIntent,
      expectedPostconditions,
      candidate: bound,
      control,
      observation
    });
    const affordance = buildSemanticAffordance({
      candidate: { ...bound, physicalEffect, mechanicalEffect: physicalEffect, semanticIntent, expectedPostconditions },
      control,
      goal: { ...goal, outcomeContract },
      postcondition: expectedOutcome
    });
    const actionabilityFailure = candidateActionabilityFailure(bound, control);
    const grounded = {
      ...bound,
      // A visible foreground surface owns the next click. TaskState remains
      // useful planning context, but it cannot hide a grounded safe control
      // merely because its predicted semantic effect is incomplete/unknown.
      goalRelevant: goal.kind === "profile_field"
        ? allCapabilities.goalCandidateKeys.has(capabilityKey(candidate))
        : foregroundOwnsSelection
          ? relevantToVisibleSurface(goal, bound, allCapabilities.goalCandidateKeys.has(capabilityKey(candidate)))
          : allCapabilities.goalCandidateKeys.has(capabilityKey(candidate)),
      risk: bound.risk || (goal.kind === "profile_field" ? "safe" : "uncertain"),
      requiresApproval: Boolean(bound.requiresApproval),
      expectedOutcome,
      expectedPostconditions,
      physicalEffect,
      mechanicalEffect: physicalEffect,
      semanticIntent,
      outcomeContract,
      parentOutcomeContract,
      outcomeCompatibility: outcomeCompatibility.status,
      outcomeCompatibilityReason: outcomeCompatibility.reason,
      affordance,
      requiresJudgment: Boolean(bound.requiresJudgment || bound.risk === "uncertain")
    };
    const policyState = state && Object.keys(state).length
      ? {
          taskState: state.taskState || null,
          approvals: state.approvals || {},
          priceHistory: Array.isArray(state.priceHistory) ? state.priceHistory : []
        }
      : null;
    const policyDecision = evaluateActionPolicy(
      candidatePolicyAction(goal, grounded, control, observation),
      policyState,
      traveler,
      { ...(state.approvals || {}), ...approvals }
    );
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
      exclusionReason: controlUnavailable(control)
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
  const selectable = current.filter((candidate) => {
    if (!candidate.goalRelevant) return false;
    const hardExclusion = controlUnavailable((page.controls || []).find((item) => item.controlId === candidate.controlId) || {})
      || ["CONTROL_UNAVAILABLE", "ACTIONABILITY_UNPROVEN", "TARGET_NOT_ACTIONABLE", "TARGET_NOT_REVEALABLE"].includes(candidate.exclusionReason);
    if (hardExclusion) return false;
    if (candidate.exclusionReason) return false;
    const nonMutating = ["ask_user", "wait"].includes(candidate.type);
    if (!nonMutating && (candidate.risk !== "safe" || candidate.requiresApproval)) return false;
    return !attempted.has(candidate.candidateId)
      && !attempted.has(candidate.strategyId)
      && !attemptedStrategies.has(actuatorSignature(candidate));
  });
  const selectableIds = new Set(selectable.map((candidate) => candidate.candidateId));
  return {
    ...binding,
    // Context is complete; selection is policy-safe. The model can understand
    // blocked controls without receiving their IDs in its selectable enum.
    contextCapabilities: current.map((candidate) => ({
      ...candidate,
      capabilityId: capabilityKey(candidate),
      policyStatus: candidate.policyDecision?.allow === true
        ? (candidate.goalRelevant ? "allowed" : "context_only")
        : String(candidate.policyDecision?.decision || "denied"),
      selectable: selectableIds.has(candidate.candidateId)
    })),
    excludedCandidates,
    candidates: selectable
  };
}

function actionForCurrentCandidate(goal = {}, candidate = {}, observation = {}) {
  const action = goal.kind === "profile_field"
    ? actionForProfileCandidate(goal, candidate, observation)
    : actionForObservationCandidate(goal, candidate, observation);
  return {
    ...action,
    candidateId: candidate.candidateId,
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
    outcomeCompatibility: candidate.outcomeCompatibility || "unknown",
    affordance: candidate.affordance || action.affordance || null
  };
}

module.exports = { actionForCurrentCandidate, buildCurrentCandidateSet, candidateActionabilityFailure };
