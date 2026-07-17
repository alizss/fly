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
  attemptedCandidateIds = []
} = {}) {
  const binding = surfaceBinding(observation);
  const page = observation.page || {};
  const attempted = new Set(attemptedCandidateIds || []);
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
    return {
      ...bound,
      expectedOutcome,
      affordance: buildSemanticAffordance({ candidate: bound, control, goal, postcondition: expectedOutcome })
    };
  });
  return {
    ...binding,
    candidates: current.filter((candidate) => (
      !attempted.has(candidate.candidateId)
      && !attempted.has(candidate.strategyId)
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

module.exports = { actionForCurrentCandidate, buildCurrentCandidateSet };
