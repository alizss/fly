const { normalizeAction } = require("../../../packages/shared/agent-actions");
const { conflictedControlIds } = require("./control-alias-index");
const { controlBelongsToCurrentSurface, currentSurface, surfaceBinding } = require("./surface-contract");
const { deriveActionSemantics } = require("./action-semantics");

function slug(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function normalizedRisk(risk = "", operation = "", structuredPrice = null) {
  if (operation === "open" || operation === "keyboard") return "safe";
  if (structuredPrice && Number(structuredPrice.amount) === 0) return "safe";
  if (structuredPrice && Number(structuredPrice.amount) > 0) return "money";
  const value = String(risk || "").toLowerCase();
  if (/safe|decline|skip|continue|free|no[_ -]?(?:extra|protection|seat|bag)|without|none/.test(value)) return "safe";
  if (/payment/.test(value)) return "payment";
  if (/legal/.test(value)) return "legal";
  if (/paid|money|price/.test(value)) return "money";
  return "uncertain";
}

function semanticGoalForGroup(group = {}) {
  const text = `${group.requirementId || ""} ${group.sectionType || ""} ${group.sectionLabel || ""}`.toLowerCase();
  if (/flexible|ticket/.test(text)) return "decline flexible ticket";
  if (/bag|luggage/.test(text)) return "decline checked baggage";
  if (/bundle|support|sms/.test(text)) return "decline bundle extras";
  if (/seat/.test(text)) return "decline paid seat selection";
  if (/insurance|cancellation|protection/.test(text)) return "decline cancellation insurance";
  return `resolve ${group.sectionLabel || group.sectionType || group.requirementId || "current decision"}`;
}

function requiredDecisionGroupsForCurrentSurface(page = {}) {
  const surface = currentSurface(page);
  return (page.decisionGroups || []).filter((group) => {
    if (group.required !== true) return false;
    if (surface.type === "page") {
      return !group.surfaceId || group.surfaceId === "surface-page" || group.surfaceType === "page";
    }
    return group.surfaceId === surface.id;
  });
}

function unresolvedRequiredDecisionGroups(page = {}, resolvedDecisionGroupIds = []) {
  const resolved = new Set((resolvedDecisionGroupIds || []).filter(Boolean).map(String));
  return requiredDecisionGroupsForCurrentSurface(page)
    .filter((group) => (
      !resolved.has(String(group.decisionGroupId || group.requirementId || ""))
      && !["satisfied", "waived", "waived_by_policy"].includes(group.status)
    ));
}

function allRequiredDecisionGroupsResolved(page = {}, resolvedDecisionGroupIds = []) {
  return unresolvedRequiredDecisionGroups(page, resolvedDecisionGroupIds).length === 0;
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
      desiredValue: /decline/.test(semanticGoal) ? "free_or_no_extra" : "satisfied",
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

function operationActionType(operation = "") {
  if (["open", "choose", "activate"].includes(operation)) return "click";
  if (operation === "type") return "type";
  if (operation === "select") return "select";
  if (operation === "keyboard") return "keypress";
  return "click";
}

function intentFor(control = {}, operation = "", goal = {}) {
  const semantic = String(control.semantic || "").toLowerCase();
  const risk = String(control.risk || "").toLowerCase();
  if (operation === "open") return "open_choice_control";
  if (/decline|no[_ -]?(?:extra|protection|seat|bag)|without|skip|free|none/.test(`${semantic} ${risk} ${control.label || ""}`.toLowerCase())) return "decline_optional_extra";
  if (/continue|navigation/.test(`${semantic} ${risk} ${goal.semanticType || ""}`)) return "navigate_stage";
  if (control.surfaceType && control.surfaceType !== "page") return "resolve_active_surface";
  return "choose_option";
}

function controlsForGoal(page = {}, goal = {}) {
  const controls = page.controls || [];
  const group = (page.decisionGroups || []).find((item) => item.decisionGroupId === goal.decisionGroupId) || null;
  if (!group) {
    const completedDecisionGroupId = String(goal.completedDecisionGroupId || "");
    if (goal.semanticType === "navigation" && !allRequiredDecisionGroupsResolved(page, [completedDecisionGroupId])) return [];
    return controls.filter((control) => {
      const text = `${control.semantic || ""} ${control.risk || ""} ${control.meaning || ""} ${control.label || ""}`.toLowerCase();
      if (/\bback\b|previous|go back|price|details|learn more|info(?:rmation)?|edit|change/.test(text)) return false;
      if (/choose|select|pick/.test(text) && /seat|bag|bundle|extra|upgrade/.test(text)) return false;
      if (Number(control.structuredPrice?.amount) > 0 || /add_paid|money|purchase|premium|upgrade/.test(text)) return false;
      const forward = /navigation|safe_continue|continue|next|proceed|advance|done|finish|confirm|close|dismiss/.test(text);
      const newSurfaceCommand = Boolean(
        completedDecisionGroupId
        && control.decisionGroupId
        && control.decisionGroupId !== completedDecisionGroupId
        && /no thanks|without|decline|skip/.test(text)
      );
      return forward || newSurfaceCommand;
    });
  }
  const groupControlIds = new Set([
    ...(group.alternativeControlIds || []),
    ...(group.alternatives || []).map((item) => item.controlId)
  ].filter(Boolean));
  const hasExactGroupMembers = groupControlIds.size > 0;
  return controls.filter((control) => (
    control.decisionGroupId === group.decisionGroupId
    || groupControlIds.has(control.controlId)
    || (!hasExactGroupMembers && group.sectionId && control.sectionId === group.sectionId)
    || (!hasExactGroupMembers && !group.sectionId && group.sectionType && control.sectionType === group.sectionType)
  ));
}

function rawObservationCandidates(observation = {}, goal = {}) {
  const page = observation.page || {};
  const observationId = observation.observationId || "observation";
  const surface = currentSurface(page);
  const foreground = surface.type !== "page" ? surface : null;
  const ambiguousControlIds = conflictedControlIds(page);
  const controls = controlsForGoal(page, goal).filter((control) => (
    !ambiguousControlIds.has(control.controlId)
    && controlBelongsToCurrentSurface(control, page)
  ));
  const raw = [];

  for (const control of controls) {
    const operations = Object.entries(control.operations || {}).filter(([, capability]) => (
      (capability?.actuatorId || capability?.actuatorIds?.length)
      && (capability?.actionability?.executable === true || capability?.actionability?.revealable === true)
    ));
    const usable = operations;
    for (const [operation, capability] of usable) {
      if (!["open", "choose", "activate", "keyboard"].includes(operation)) continue;
      const actionability = capability.actionability || {};
      const visible = actionability.executable === true;
      const actionType = operationActionType(operation);
      const targetId = capability.actuatorId || capability.actuatorIds?.[0] || control.preferredActivationElementId || control.stateElementId;
      if (!targetId) continue;
      const risk = normalizedRisk(`${control.risk || ""} ${control.semantic || ""} ${control.label || ""}`, operation, control.structuredPrice);
      const semantics = deriveActionSemantics({ control, operation, type: actionType, goal });
      raw.push({
        candidateId: "",
        semanticGoal: goal.semanticGoal,
        semantic: control.semantic || operation,
        stableKey: control.stableKey || `control:${control.controlId}`,
        meaning: control.meaning || control.semantic || control.accessibleName || control.label || operation,
        structuredPrice: control.structuredPrice || null,
        type: actionType,
        operation,
        authorizedOperation: operation,
        actionability,
        ...semantics,
        controlId: control.controlId,
        decisionGroupId: goal.decisionGroupId || control.decisionGroupId || "",
        targetId,
        targetLabel: control.label || control.accessibleName || control.semantic || operation,
        requirementId: goal.requirementId || "",
        intent: intentFor(control, operation, goal),
        expectedOutcome: null,
        risk,
        requiresApproval: ["money", "payment", "legal"].includes(risk),
        visible,
        value: "",
        keys: operation === "keyboard" ? "ArrowDown" : "",
        needsReveal: !visible && actionability.revealable === true,
        summary: `${operation} the current ${control.label || control.semantic || "control"}${visible ? "." : " after revealing it."}`
      });
    }
  }

  if (!raw.length && !(goal.semanticType === "navigation" && !allRequiredDecisionGroupsResolved(page, [goal.completedDecisionGroupId]))) {
    const paymentReview = goal.semanticType === "payment_review";
    raw.push({
      candidateId: "",
      semanticGoal: goal.semanticGoal,
      semantic: paymentReview ? "final_review" : "ask_user",
      type: paymentReview ? "final_review" : "ask_user",
      operation: paymentReview ? "review" : "handoff",
      interactionRole: "navigation",
      semanticEffect: "advance",
      expectedEvidence: "progress_changed",
      controlId: "",
      decisionGroupId: goal.decisionGroupId || "",
      targetId: "",
      targetLabel: "",
      requirementId: goal.requirementId || "",
      intent: paymentReview ? "final_review" : "ask_user",
      risk: paymentReview ? "payment" : "uncertain",
      requiresApproval: true,
      visible: true,
      value: "",
      keys: "",
      summary: paymentReview ? "Stop for final payment review." : "Ask the user because no current grounded control can satisfy the goal."
    });
  }

  return raw.map((candidate, index) => ({
    ...candidate,
    candidateId: `${observationId}:candidate_${index + 1}`
  }));
}

function buildObservationCandidateSet(goal = {}, observation = {}) {
  return { ...surfaceBinding(observation), candidates: rawObservationCandidates(observation, goal) };
}

function actionForObservationCandidate(goal = {}, candidate = {}, observation = {}) {
  return normalizeAction({
    id: `act_candidate_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    observationId: observation.observationId || "",
    observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
    type: candidate.type,
    intent: candidate.intent,
    operation: candidate.operation,
    goalId: goal.goalId,
    candidateId: candidate.candidateId,
    controlId: candidate.controlId,
    decisionGroupId: candidate.decisionGroupId,
    targetId: candidate.targetId,
    targetLabel: candidate.targetLabel,
    value: candidate.value || "",
    keys: candidate.keys || "",
    requirementId: candidate.requirementId || "",
    expectedOutcome: candidate.expectedOutcome || null,
    interactionRole: candidate.interactionRole,
    semanticEffect: candidate.semanticEffect,
    expectedEvidence: candidate.expectedEvidence,
    affordance: candidate.affordance || null,
    risk: candidate.risk,
    requiresApproval: candidate.requiresApproval,
    reason: candidate.summary || `Execute current candidate ${candidate.candidateId}.`
  });
}

module.exports = {
  allRequiredDecisionGroupsResolved,
  actionForObservationCandidate,
  buildObservationCandidateSet,
  deriveObservationGoal,
  requiredDecisionGroupsForCurrentSurface,
  unresolvedRequiredDecisionGroups,
  rawObservationCandidates
};
