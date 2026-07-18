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
const { buildSemanticAffordance, compileTypedExpectedOutcome } = require("./action-semantics");
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
      surfaceType: candidate.surfaceType || control.surfaceType || "page"
    }
  };
}

function observationHash(observation = {}) {
  return String(observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "");
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
  const attempted = new Set(attemptedCandidateIds || []);
  const attemptedStrategies = new Set(attemptedStrategySignatures || []);
  const raw = goal.kind === "profile_field"
    ? candidatesForProfileGoal(goal, observation, traveler, [])
    : buildObservationCandidateSet(goal, observation).candidates;
  const current = raw.filter((candidate) => {
    if (!["click", "type", "select", "keypress", "scroll", "click_xy"].includes(candidate.type)) return true;
    const control = (page.controls || []).find((item) => item.controlId === candidate.controlId);
    return Boolean(control && controlBelongsToCurrentSurface(control, page));
  }).map((candidate, index) => {
    const bound = bindCandidateEnvelope(candidate, index, observation, binding);
    const control = (page.controls || []).find((item) => item.controlId === bound.controlId) || {};
    const expectedOutcome = compileTypedExpectedOutcome(bound, page);
    const affordance = buildSemanticAffordance({ candidate: bound, control, goal, postcondition: expectedOutcome });
    const actionabilityFailure = candidateActionabilityFailure(bound, control);
    const grounded = {
      ...bound,
      expectedOutcome,
      affordance,
      requiresJudgment: Boolean(bound.requiresJudgment || bound.risk === "uncertain")
    };
    const policyState = state && Object.keys(state).length
      ? {
          ...state,
          requirements: Array.isArray(state.requirements) ? state.requirements : [],
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
  const excludedCandidates = current.filter((candidate) => (
    Boolean(candidate.exclusionReason)
    || attempted.has(candidate.candidateId)
    || attempted.has(candidate.strategyId)
    || attemptedStrategies.has(actuatorSignature(candidate))
  ));
  return {
    ...binding,
    excludedCandidates,
    candidates: current.filter((candidate) => (
      !candidate.exclusionReason
      && !attempted.has(candidate.candidateId)
      && !attempted.has(candidate.strategyId)
      && !attemptedStrategies.has(actuatorSignature(candidate))
    ))
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
    affordance: candidate.affordance || action.affordance || null
  };
}

module.exports = { actionForCurrentCandidate, buildCurrentCandidateSet, candidateActionabilityFailure };
