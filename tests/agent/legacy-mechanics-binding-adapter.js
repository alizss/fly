// Historical replay adapter for fixtures that still construct goal-shaped
// inputs. Production binding accepts only CurrentObligation.
const { currentObligationFromGoal } = require("../../apps/web/agent/authority-frames");
const { rawObservationCandidates: bindRawObservationCandidates } = require("../../apps/web/agent/observation-candidates");
const {
  actionForCurrentCandidate: bindActionForCurrentCandidate,
  bindMechanics
} = require("../../apps/web/agent/mechanics-binder");

function obligationForLegacyGoal(goal = {}, observation = {}) {
  if (goal?.contractVersion === "current-obligation/v2") return goal;
  const seed = currentObligationFromGoal({ goal });
  const discoveredControlIds = [...new Set(bindRawObservationCandidates(observation, seed)
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

function rawObservationCandidates(observation = {}, goal = {}) {
  return bindRawObservationCandidates(observation, obligationForLegacyGoal(goal, observation));
}

function actionForCurrentCandidate(goal = {}, candidate = {}, observation = {}) {
  return bindActionForCurrentCandidate(obligationForLegacyGoal(goal, observation), candidate, observation);
}

function actionForObservationCandidate(goal = {}, candidate = {}, observation = {}) {
  return bindActionForCurrentCandidate(obligationForLegacyGoal(goal, observation), candidate, observation);
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
  const obligation = obligationForLegacyGoal(goal, observation);
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
  actionForObservationCandidate,
  bindMechanics,
  buildCurrentCandidateSet,
  groundedObservationCandidateSet,
  rawObservationCandidates
};
