// Test-only migration for historical goal-shaped fixtures whose previously
// persisted control is no longer present in the fresh CheckoutScene. Runtime
// code must never synthesize scene ownership; production obligations require
// an exact item emitted by the current scene compiler.

function clean(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function unique(values = []) {
  return [...new Set(values.map(clean).filter(Boolean))];
}

function legacySceneWithGoalItem(scene = {}, goal = {}) {
  const controls = unique([
    ...(goal.candidateControlIds || []),
    ...(goal.actionableControlIds || []),
    goal.controlId,
    goal.componentBinding?.controlId,
    ...(goal.componentBinding?.representationControlIds || []),
    ...(goal.eligibleAlternativeControlIds || [])
  ]);
  const existing = (scene.items || []).some((item) => (
    (item.controlIds || []).some((controlId) => controls.includes(controlId))
  ));
  if (existing) return scene;
  const role = goal.kind === "profile_field"
    ? "profile_field"
    : goal.kind === "legal_attestation" || goal.semanticType === "legal_attestation"
      ? "legal_attestation"
      : goal.semanticType === "navigation"
        ? "navigation"
        : "checkout_decision";
  const sceneItemId = `legacy-test:${clean(goal.goalId || goal.decisionGroupId || goal.requirementId || controls[0])}`;
  const syntheticControls = controls.length ? controls : [`legacy-control:${clean(goal.goalId || goal.semanticType || "goal")}`];
  const item = Object.freeze({
    contractVersion: "scene-item/v1",
    sceneItemId,
    semanticOwnerId: sceneItemId,
    stage: scene.stage || "unknown",
    surfaceId: goal.surfaceId || scene.surface?.id || "surface-page",
    region: "legacy_test_fixture",
    role,
    subject: goal.semanticType || goal.decisionGroupId || goal.requirementId || goal.goalId || "legacy_goal",
    repeatedInstance: goal.decisionInstanceId || "",
    controlIds: Object.freeze(syntheticControls),
    actuatorIds: Object.freeze([]),
    status: "unresolved",
    requiredness: "progression_required",
    consequence: goal.riskClass || goal.risk || "unknown",
    factSource: "",
    authority: "legacy_test_fixture",
    expectedPostcondition: Object.freeze({ ...(goal.successCondition || goal.postcondition || goal.outcomeContract || {}) }),
    evidence: Object.freeze([]),
    contradictions: Object.freeze([])
  });
  return Object.freeze({ ...scene, items: Object.freeze([...(scene.items || []), item]) });
}

function currentObligationForLegacyGoal(goal = {}, observation = {}) {
  const { currentObligationFromGoal } = require("../../apps/web/agent/authority-frames");
  const scene = legacySceneWithGoalItem({
    stage: observation.page?.step || goal.stage || "unknown",
    surface: observation.page?.currentSurface || { id: goal.surfaceId || "surface-page" },
    observationId: observation.observationId || goal.observationId || "legacy-test-observation",
    sourceSnapshotHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "legacy-test-snapshot",
    items: []
  }, goal);
  const sceneControlIds = scene.items.at(-1)?.controlIds || [];
  const boundGoal = [
    ...(goal.candidateControlIds || []),
    ...(goal.actionableControlIds || []),
    goal.controlId,
    ...(goal.eligibleAlternativeControlIds || [])
  ].some(Boolean) ? goal : { ...goal, candidateControlIds: sceneControlIds };
  return currentObligationFromGoal({ goal: boundGoal, checkoutScene: scene });
}

function legacyCurrentObligationFromGoal({ goal = {}, checkoutScene = null } = {}, observation = {}) {
  if (checkoutScene) {
    const { currentObligationFromGoal } = require("../../apps/web/agent/authority-frames");
    return currentObligationFromGoal({ goal, checkoutScene });
  }
  return currentObligationForLegacyGoal(goal, observation);
}

module.exports = { currentObligationForLegacyGoal, legacyCurrentObligationFromGoal, legacySceneWithGoalItem };
