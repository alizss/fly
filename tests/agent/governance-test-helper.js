const { governAction } = require("../../apps/web/agent/action-governor");
const { prepareTransactionInvariants } = require("../../apps/web/agent/invariants");
const { currentSurfaceId } = require("../../apps/web/agent/surface-contract");
const { visualRegionsMatch } = require("../../packages/shared/agent-actions");
const { currentObligationFromGoal } = require("../../apps/web/agent/authority-frames");

function replayCandidateSet(state = {}, observation = {}, action = null) {
  let candidates = state.taskState?.currentGoal?.candidates || state.currentGoal?.candidates || [];
  if (!candidates.length) return null;
  if (action?.candidateId && candidates.some((candidate) => (
    candidate.candidateId === action.candidateId
    && candidate.type === action.type
    && candidate.operation === action.operation
    && (
      (!candidate.visualRegion && !action.visualRegion)
      || visualRegionsMatch(candidate.visualRegion || {}, action.visualRegion || {})
    )
  ))) {
    candidates = candidates.map((candidate) => candidate.candidateId === action.candidateId ? action : candidate);
  }
  return {
    observationId: observation.observationId || "",
    observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
    surfaceId: currentSurfaceId(observation.page || {}),
    candidates
  };
}

// Tests that begin with a raw observation explicitly prepare the same inputs
// that production prepares before calling the pure governor.
function governObservedAction(args = {}) {
  const legacyGoal = args.state?.taskState?.currentGoal || null;
  const state = legacyGoal && !args.state.taskState.currentObligation
    ? {
        ...args.state,
        taskState: {
          ...args.state.taskState,
          currentObligation: currentObligationFromGoal({ goal: legacyGoal })
        }
      }
    : args.state;
  const preparedInvariantContext = args.preparedInvariantContext
    || prepareTransactionInvariants(state || {}, args.observation || {}, args.traveler || {});
  return governAction({
    ...args,
    state,
    preparedInvariantContext,
    preparedCandidateSet: args.preparedCandidateSet || replayCandidateSet(args.state, args.observation, args.action)
  });
}

module.exports = { governObservedAction };
