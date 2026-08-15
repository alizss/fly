// Explicit raw-observation adapter for tests and saved-trace tooling.
// Production imports only reduceCheckoutScene and therefore cannot trigger
// hidden semantic compilation or V1 currentGoal recovery.

const {
  compileCheckoutScene,
  currentObligationFromGoal,
  checkoutSceneOwnsObservation
} = require("../../apps/web/agent/authority-frames");
const { legacyGoalFromObligation } = require("./legacy-obligation-goal-adapter");
const { legacySceneWithGoalItem } = require("./legacy-scene-item-adapter");
const { reduceCheckoutScene, taskStateReadModel } = require("../../apps/web/agent/task-state-reducer");

function reduceTaskState(args = {}) {
  const observation = args.observation || {};
  const compilationState = {
    ...(args.transactionReview?.baseline ? {
      transactionInvariants: { baseline: args.transactionReview.baseline }
    } : {}),
    ...(args.state || {}),
    checkoutMandate: args.checkoutMandate || args.state?.checkoutMandate || null
  };
  let checkoutScene = checkoutSceneOwnsObservation(args.checkoutScene || args.decisionFrame, observation)
    ? (args.checkoutScene || args.decisionFrame)
    : compileCheckoutScene({
        observation,
        state: compilationState,
        traveler: args.traveler || {}
      });
  const rawLegacyGoal = args.previousTaskState?.currentGoal || null;
  const actionOwnedLegacyControlId = rawLegacyGoal
    && args.previousActionResult?.action?.goalId === rawLegacyGoal.goalId
      ? args.previousActionResult.action.controlId
      : "";
  const legacyGoal = rawLegacyGoal && actionOwnedLegacyControlId && !rawLegacyGoal.controlId
    ? { ...rawLegacyGoal, controlId: actionOwnedLegacyControlId, actionableControlIds: [actionOwnedLegacyControlId] }
    : rawLegacyGoal;
  const legacyGoalHasBinding = Boolean(legacyGoal && [
    ...(legacyGoal.candidateControlIds || []),
    ...(legacyGoal.actionableControlIds || []),
    legacyGoal.controlId,
    legacyGoal.componentBinding?.controlId,
    ...(legacyGoal.eligibleAlternativeControlIds || [])
  ].some(Boolean));
  if (legacyGoalHasBinding && !args.previousTaskState.currentObligation) {
    checkoutScene = legacySceneWithGoalItem(checkoutScene, legacyGoal);
  }
  const previousTaskState = legacyGoalHasBinding && !args.previousTaskState.currentObligation
    ? {
        ...args.previousTaskState,
        currentObligation: currentObligationFromGoal({ goal: legacyGoal, checkoutScene })
      }
    : rawLegacyGoal && !args.previousTaskState.currentObligation
      ? { ...args.previousTaskState, currentGoal: null }
      : args.previousTaskState;
  const result = reduceCheckoutScene({ ...args, previousTaskState, checkoutScene });
  return Object.freeze({
    ...result,
    ...(taskStateReadModel(result) || {}),
    currentGoal: legacyGoalFromObligation(result.currentObligation)
  });
}

module.exports = { reduceTaskState };
