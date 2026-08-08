// Historical replay adapter for fixtures that still construct goal-shaped
// inputs. Production binding accepts only CurrentObligation.
const { currentObligationFromGoal } = require("../../apps/web/agent/authority-frames");
const { rawObservationCandidates } = require("../../apps/web/agent/observation-candidates");
const {
  actionForCurrentCandidate,
  bindMechanics
} = require("../../apps/web/agent/current-candidate-builder");

function obligationForLegacyGoal(goal = {}, observation = {}) {
  if (goal?.contractVersion === "current-obligation/v2") return goal;
  const discoveredControlIds = [...new Set(rawObservationCandidates(observation, goal)
    .map((candidate) => candidate.controlId)
    .filter(Boolean))];
  return currentObligationFromGoal({
    goal: {
      ...goal,
      candidateControlIds: goal.candidateControlIds?.length
        ? goal.candidateControlIds
        : discoveredControlIds
    }
  });
}

function buildCurrentCandidateSet({
  goal = {},
  obligation = null,
  observation = {},
  traveler = {},
  state = {},
  approvals = {},
  attemptedCandidateIds = [],
  attemptedStrategySignatures = []
} = {}) {
  return bindMechanics({
    obligation: obligation || state.taskState?.currentObligation || obligationForLegacyGoal(goal, observation),
    observation,
    traveler,
    state,
    approvals,
    attemptedCandidateIds,
    attemptedStrategySignatures
  });
}

function groundedObservationCandidateSet(goal = {}, observation = {}, attemptedStrategySignatures = [], context = {}) {
  const discoveredControlIds = [...new Set(rawObservationCandidates(observation, goal)
    .map((candidate) => candidate.controlId)
    .filter(Boolean))];
  const obligation = currentObligationFromGoal({
    goal: {
      ...goal,
      candidateControlIds: goal.candidateControlIds?.length
        ? goal.candidateControlIds
        : discoveredControlIds
    }
  });
  const { __private } = require("../../apps/web/agent/loop");
  return __private.groundedObservationCandidateSet(
    obligation,
    null,
    observation,
    attemptedStrategySignatures,
    context
  );
}

module.exports = {
  actionForCurrentCandidate,
  bindMechanics,
  buildCurrentCandidateSet,
  groundedObservationCandidateSet
};
