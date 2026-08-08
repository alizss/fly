// Historical observation-to-goal inference for replay fixtures only.
// Production meaning is compiled by DecisionFrame and published by TaskState.
const { currentSurface } = require("../../apps/web/agent/surface-contract");

function slug(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function semanticGoalForGroup(group = {}) {
  return `resolve ${group.sectionLabel || group.sectionType || group.requirementId || "current decision"}`;
}

function deriveObservationGoal(observation = {}, requirements = []) {
  const page = observation.page || {};
  const groups = page.decisionGroups || [];
  const surface = currentSurface(page);
  const foreground = surface.type !== "page" ? surface : null;
  const unresolvedGroups = groups.filter((group) => !["satisfied", "waived", "waived_by_policy"].includes(group.status));
  const group = (foreground
    ? unresolvedGroups.find((item) => item.surfaceId === foreground.id || item.decisionGroupId === foreground.decisionGroupId)
    : null)
    || unresolvedGroups.find((item) => item.required)
    || unresolvedGroups[0]
    || null;
  const observationId = observation.observationId || "observation";
  if (group) {
    const semanticGoal = semanticGoalForGroup(group);
    return {
      goalId: `${observationId}:goal:${slug(group.decisionGroupId || semanticGoal)}`,
      semanticGoal,
      semanticType: group.sectionType || group.requirementId || "decision",
      desiredValue: "satisfied",
      decisionGroupId: group.decisionGroupId || "",
      surfaceId: group.surfaceId || "",
      requirementId: group.decisionGroupId || group.requirementId || "",
      sectionId: group.sectionId || "",
      sectionType: group.sectionType || "",
      sectionLabel: group.sectionLabel || "",
      observationId,
      postcondition: {
        type: "requirement_status",
        requirementId: group.decisionGroupId || group.requirementId || "",
        status: "satisfied"
      }
    };
  }
  const missing = (requirements || []).find((requirement) => requirement.required && !["satisfied", "waived_by_policy"].includes(requirement.status));
  const paymentVisible = /payment/.test(`${page.step || ""} ${missing?.type || ""}`.toLowerCase());
  return {
    goalId: `${observationId}:goal:${paymentVisible ? "payment_review" : "continue"}`,
    semanticGoal: paymentVisible ? "review before payment" : "continue checkout",
    semanticType: paymentVisible ? "payment_review" : "navigation",
    desiredValue: paymentVisible ? "final_review" : "next_stage",
    decisionGroupId: "",
    requirementId: missing?.id || "",
    sectionId: "",
    sectionType: "",
    sectionLabel: "",
    observationId,
    postcondition: { type: paymentVisible ? "final_review" : "stage_exit_or_feedback" }
  };
}

module.exports = { deriveObservationGoal };
