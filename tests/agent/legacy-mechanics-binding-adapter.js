// Historical replay adapter for fixtures that still construct goal-shaped
// inputs. Production binding accepts only CurrentObligation.
const { compileCheckoutScene, currentObligationFromGoal } = require("../../apps/web/agent/authority-frames");
const { rawObservationCandidates: bindRawObservationCandidates } = require("../../apps/web/agent/observation-candidates");
const { legacySceneWithGoalItem } = require("./legacy-scene-item-adapter");
const {
  actionForCurrentCandidate: bindActionForCurrentCandidate,
  bindMechanics
} = require("../../apps/web/agent/mechanics-binder");

function obligationForLegacyGoal(goal = {}, observation = {}) {
  if (goal?.contractVersion === "current-obligation/v2") return goal;
  const explicitControls = [
    ...(goal.candidateControlIds || []),
    ...(goal.actionableControlIds || []),
    goal.controlId,
    ...(goal.eligibleAlternativeControlIds || [])
  ].filter(Boolean);
  const navigationLike = goal.semanticType === "navigation" || goal.kind === "navigation";
  const decisionAlternativeIds = new Set((observation.page?.decisionGroups || []).flatMap((group) => [
    ...(group.alternativeControlIds || []),
    ...(group.alternatives || []).map((option) => option.controlId),
    ...(group.controls || []).map((option) => option.controlId)
  ]).filter(Boolean));
  const inferredControls = navigationLike
    ? (observation.page?.controls || []).filter((control) => {
        if (decisionAlternativeIds.has(control.controlId)) return false;
        const text = String(`${control.label || ""} ${control.semantic || ""} ${control.physicalEffect || ""}`).toLowerCase();
        return /\b(?:next|continue|proceed|confirm|advance)\b|advance_checkout_stage/.test(text)
          && !/\bback\b/.test(text);
      }).map((control) => control.controlId)
    : (observation.page?.controls || []).map((control) => control.controlId).filter(Boolean);
  const seedControlIds = [...new Set(explicitControls.length ? explicitControls : inferredControls)];
  const seedGoal = { ...goal, candidateControlIds: seedControlIds };
  const checkoutScene = legacySceneWithGoalItem(compileCheckoutScene({ observation }), seedGoal);
  const seed = currentObligationFromGoal({ goal: seedGoal, checkoutScene });
  const discoveredControlIds = [...new Set(bindRawObservationCandidates(observation, seed)
    .map((candidate) => candidate.controlId)
    .filter(Boolean))];
  return currentObligationFromGoal({
    goal: {
      ...goal,
      candidateControlIds: goal.candidateControlIds?.length
        ? goal.candidateControlIds
        : discoveredControlIds.length
          ? discoveredControlIds
          : seedControlIds
    },
    checkoutScene
  });
}

function rawObservationCandidates(observation = {}, goal = {}) {
  if ((goal.semanticType === "navigation" || goal.kind === "navigation")
    && (observation.page?.decisionGroups || []).some((group) => (
      group.required === true
      && !["satisfied", "waived", "waived_by_policy", "optional"].includes(group.status)
      && !group.selectedControlId
    ))) return [];
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
  obligationForLegacyGoal,
  rawObservationCandidates
};
