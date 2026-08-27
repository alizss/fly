const {
  advanceActionLifecycle,
  normalizeLeasedAction
} = require("../action-lifecycle");
const {
  decisionInstanceKey,
  semanticGoalKey
} = require("../../../../packages/shared/agent-actions");
const { withUpdate } = require("../../../../packages/shared/agent-state");
const { currentObligation } = require("../authority-frames");
const agentContract = require("../../../extension/src/shared/agent-contract");
const { leasedActionFor, recoveryFacts, updatedExecutionEpisode } = require("../execution-episode");
const {
  candidateStrategySignature,
  observationPageStateHash,
  semanticGoalRecoveryKey,
  targetLocalRecoveryScope
} = require("./mechanics");

function taskMechanics(taskState = {}) {
  return currentObligation(taskState);
}

function deterministicTransitionVerification(transition = null) {
  const status = transition?.actionOutcome?.status || "";
  const outcome = agentContract.ACTION_OUTCOME;
  const achieved = status === outcome.SATISFIED;
  const changed = [outcome.SATISFIED, outcome.REVEALED_BLOCKER].includes(status);
  return {
    ok: achieved,
    changed,
    lastActionWorked: achieved,
    blockers: status === outcome.REVEALED_BLOCKER ? [transition.blocker?.label || "A new blocker appeared."] : [],
    priceChanged: Boolean(transition?.diff?.priceChanged),
    riskChanged: status === outcome.UNSAFE_CHANGE,
    evidence: transition ? [`Action outcome: ${status}.`] : [],
    confidence: transition ? 1 : 0,
    requirementUpdates: []
  };
}

function applyTransitionStatus(
  state = {},
  observation = {},
  previousObservation = null,
  observationReadiness = null
) {
  const advanced = advanceActionLifecycle({
    state,
    observation,
    previousObservation,
    observationReadiness
  });
  const transition = advanced.transition;
  if (!advanced.lifecycle) return { ...advanced, transition: null };
  const pending = normalizeLeasedAction(leasedActionFor(state));
  const governedAction = state.lastAction?.id === advanced.lifecycle.actionId
    ? state.lastAction
    : pending?.originalAction || observation.lastActionResult?.action || {};
  const authoritativeGoal = taskMechanics(state.taskState || {});
  const signature = candidateStrategySignature(authoritativeGoal, governedAction);
  const decisionObservation = previousObservation?.observationId ? previousObservation : observation;
  const decisionInstanceId = governedAction.decisionInstanceId
    || decisionInstanceKey(governedAction, decisionObservation);
  const goalKey = semanticGoalRecoveryKey(authoritativeGoal, decisionObservation);
  const pageStateHash = observationPageStateHash(observation);
  const selectedStrategy = governedAction.pipelineContract?.capability?.selectedStrategy || {};
  const targetScope = targetLocalRecoveryScope(authoritativeGoal, observation, {
    controlId: governedAction.controlId || "",
    stableControlKey: governedAction.affordance?.stableKey
      || governedAction.pipelineContract?.component?.componentIdentity
      || "",
    componentIdentity: governedAction.pipelineContract?.component?.componentIdentity || "",
    actuatorStableKey: selectedStrategy.actuatorStableKey || "",
    pipelineContract: governedAction.pipelineContract || null
  });
  // Action lifecycle owns recovery settlement. When a useful transition has
  // already cleared the episode, do not restore failures from the input state.
  const failedStrategies = [...(recoveryFacts(advanced.state).failedStrategies || [])];
  const browserFailureCode = String(
    advanced.observation?.lastActionResult?.failureCode
    || observation.lastActionResult?.failureCode
    || ""
  );
  const failedStrategyReuse = browserFailureCode === "FAILED_STRATEGY_REUSE";
  const browserActionOutcome = advanced.observation?.lastActionResult?.actionOutcome
    || observation.lastActionResult?.actionOutcome
    || null;
  const repeatProhibited = transition?.actionOutcome?.repeatProhibited === true
    || browserActionOutcome?.repeatProhibited === true;
  const rejectedBeforeDispatch = advanced.lifecycle.status === "rejected_before_dispatch";
  const failedWithoutDispatch = rejectedBeforeDispatch && repeatProhibited;
  if (
    ((repeatProhibited && [
      agentContract.ACTION_OUTCOME.NO_EFFECT,
      agentContract.ACTION_OUTCOME.NO_RESULT
    ].includes(transition?.actionOutcome?.status))
      || failedWithoutDispatch
      || failedStrategyReuse)
    && governedAction.type !== "scroll"
    && governedAction.controlId
    && signature
  ) {
    const affordance = governedAction.affordance || {};
    const entry = {
      goalKey,
      decisionInstanceId,
      semanticGoalKey: authoritativeGoal ? semanticGoalKey(authoritativeGoal) : "",
      strategySignature: signature,
      controlId: governedAction.controlId || "",
      stableControlKey: affordance.stableKey || governedAction.controlId || "",
      capability: governedAction.operation || governedAction.type || "",
      semanticEffect: affordance.effect || governedAction.semanticEffect || "",
      observationId: observation.observationId || "",
      pageStateHash,
      actuatorStableKey: targetScope.actuatorStableKey,
      surfaceInstanceKey: targetScope.surfaceInstanceKey,
      targetLocalStateKey: targetScope.targetLocalStateKey,
      failureCount: 1
    };
    const existingIndex = failedStrategies.findIndex((item) => (
      item.semanticGoalKey === entry.semanticGoalKey
      && item.strategySignature === signature
      && item.surfaceInstanceKey === entry.surfaceInstanceKey
      && item.targetLocalStateKey === entry.targetLocalStateKey
    ));
    if (existingIndex >= 0) {
      failedStrategies[existingIndex] = {
        ...failedStrategies[existingIndex],
        decisionInstanceId,
        observationId: observation.observationId || "",
        failureCount: Number(failedStrategies[existingIndex].failureCount || 1) + 1
      };
    } else {
      failedStrategies.push(entry);
    }
  }
  const scopedFailures = failedStrategies.filter((entry) => {
    if (!entry.targetLocalStateKey) {
      return entry.goalKey === goalKey && entry.pageStateHash === pageStateHash;
    }
    const scope = targetLocalRecoveryScope(authoritativeGoal, observation, entry);
    return entry.semanticGoalKey === (authoritativeGoal ? semanticGoalKey(authoritativeGoal) : "")
      && entry.surfaceInstanceKey === scope.surfaceInstanceKey
      && entry.targetLocalStateKey === scope.targetLocalStateKey;
  });
  const rememberedForGoal = scopedFailures
    .map((entry) => entry.strategySignature)
    .filter(Boolean);
  const attemptedStrategySignatures = [...new Set(rememberedForGoal)].slice(-12);
  return {
    ...advanced,
    state: withUpdate(advanced.state, {
      lastTransition: transition || state.lastTransition || null,
      executionEpisode: updatedExecutionEpisode(advanced.state, {
        failedStrategies: failedStrategies.slice(-80),
        failedStrategySignatures: attemptedStrategySignatures
      }),
      ...([agentContract.ACTION_OUTCOME.NO_EFFECT, agentContract.ACTION_OUTCOME.NO_RESULT]
        .includes(transition?.actionOutcome?.status)
        || failedWithoutDispatch
        || failedStrategyReuse
        ? { aiDecisionCache: null }
        : {})
    }),
    transition: transition || null
  };
}

module.exports = { applyTransitionStatus, deterministicTransitionVerification };
