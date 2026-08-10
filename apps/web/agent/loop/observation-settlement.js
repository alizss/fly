const { RECOVERABLE_GROUNDING_CODES } = require("../action-governor");
const {
  canonicalFailureCode,
  normalizeLeasedAction,
  wasDispatched
} = require("../action-lifecycle");
const { withUpdate } = require("../../../../packages/shared/agent-state");
const { currentObligation } = require("../authority-frames");
const {
  leasedActionFor,
  recoveryFacts,
  updatedExecutionEpisode
} = require("../execution-episode");
const { verifiedCommerceObligationFromActionResult } = require("../task-state-reducer");

function taskMechanics(taskState = {}) {
  return currentObligation(taskState) || {};
}

function browserDispatched(result = {}) {
  return wasDispatched(result);
}

const STALE_IDENTITY_CODES = new Set([
  "CANONICAL_ALIAS_UNRESOLVED",
  "CANONICAL_ALIAS_CONFLICT",
  "STALE_OBSERVATION",
  "OBSERVATION_HASH_MISMATCH",
  "PAGE_CHANGED_BEFORE_ACTION",
  "TARGET_OBSERVATION_DRIFT",
  "TARGET_DISAPPEARED",
  "PLANNER_CANDIDATE_NOT_CURRENT",
  ...RECOVERABLE_GROUNDING_CODES
]);

function actionResultCode(result = {}) {
  return canonicalFailureCode(result);
}

function staleIdentityRejection(result = {}) {
  return STALE_IDENTITY_CODES.has(actionResultCode(result));
}

function compactCurrentObservation(observation = {}) {
  return {
    observationId: observation.observationId || "",
    observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
    step: observation.page?.step || "",
    url: observation.page?.url || "",
    capturedAt: new Date().toISOString()
  };
}

function leasedActionSupersededByFreshPage(pending = null, observation = {}) {
  const normalized = normalizeLeasedAction(pending);
  if (!normalized?.originalAction?.id || normalized.status === "needs_reveal") return false;
  if (observation.lastActionResult?.actionId === normalized.originalAction.id) return false;
  const sourceHash = String(normalized.sourceObservationHash || normalized.originalAction.observationHash || "");
  const currentHash = String(observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "");
  return Boolean(sourceHash && currentHash && sourceHash !== currentHash);
}

function recordPreviousActionFacts(state = {}, observation = {}, traveler = {}) {
  let pendingAction = normalizeLeasedAction(leasedActionFor(state));
  let attemptedCandidateIds = [...(recoveryFacts(state).attemptedCandidateIds || [])];
  const result = observation.lastActionResult || {};

  if (pendingAction?.originalAction?.id && result.actionId === pendingAction.originalAction.id) {
    if (browserDispatched(result) && pendingAction.candidateId) {
      attemptedCandidateIds = [...new Set([
        ...attemptedCandidateIds,
        pendingAction.candidateStableKey || pendingAction.candidateId
      ])];
    }
    pendingAction = null;
  }

  // Goal derivation moved to task-state-reducer. This function now records
  // action-result facts only and cannot publish or replace a goal.
  return withUpdate(state, {
    userPolicy: state.userPolicy || state.policySnapshot || {},
    transactionInvariants: state.transactionInvariants || state.invariantBaseline || null,
    currentObservation: compactCurrentObservation(observation),
    executionEpisode: updatedExecutionEpisode(state, {
      leasedAction: pendingAction,
      attemptedCandidateIds
    }),
    activeSkillPlan: undefined,
    blockedObligation: undefined,
    policySnapshot: undefined,
    invariantBaseline: undefined
  });
}

// Snapshot narrowly verified commerce evidence before lifecycle evaluation is
// allowed to rewrite the result for parent-task planning. This function does
// not clear pending actions, publish goals, or infer profile completion; those
// responsibilities remain in recordPreviousActionFacts after transition.
function rawVerifiedCommerceReceipt(state = {}, observation = {}) {
  return verifiedCommerceObligationFromActionResult(
    observation.lastActionResult || null,
    observation.observationId || "",
    {
      taskState: state.taskState || {},
      decisionEpisode: state.taskState?.decisionEpisode || null,
      currentGoal: taskMechanics(state.taskState || {})
    }
  );
}

module.exports = {
  browserDispatched,
  leasedActionSupersededByFreshPage,
  rawVerifiedCommerceReceipt,
  recordPreviousActionFacts,
  staleIdentityRejection
};

