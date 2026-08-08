// Explicit raw-observation adapter for tests and saved-trace tooling.
// Production imports only reduceDecisionFrame and therefore cannot trigger
// hidden semantic compilation or V1 currentGoal recovery.

const {
  compileDecisionFrame,
  currentObligationFromGoal,
  decisionFrameOwnsObservation
} = require("../../apps/web/agent/authority-frames");
const { legacyGoalFromObligation } = require("./legacy-obligation-goal-adapter");
const { reduceDecisionFrame, taskStateReadModel } = require("../../apps/web/agent/task-state-reducer");

function reduceTaskState(args = {}) {
  const observation = args.observation || {};
  const decisionFrame = decisionFrameOwnsObservation(args.decisionFrame, observation)
    ? args.decisionFrame
    : compileDecisionFrame({
        observation,
        state: args.state || (args.transactionReview?.baseline ? {
          transactionInvariants: { baseline: args.transactionReview.baseline }
        } : {}),
        traveler: args.traveler || {}
      });
  const legacyGoal = args.previousTaskState?.currentGoal || null;
  const previousTaskState = legacyGoal && !args.previousTaskState.currentObligation
    ? {
        ...args.previousTaskState,
        currentObligation: currentObligationFromGoal({ goal: legacyGoal })
      }
    : args.previousTaskState;
  const result = reduceDecisionFrame({ ...args, previousTaskState, decisionFrame });
  return Object.freeze({
    ...result,
    ...(taskStateReadModel(result) || {}),
    currentGoal: legacyGoalFromObligation(result.currentObligation)
  });
}

module.exports = { reduceTaskState };
