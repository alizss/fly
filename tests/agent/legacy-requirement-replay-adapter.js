"use strict";

// Historical V1 requirement projections live only beside the saved replay
// tests. Production cannot import this module and no live planner consumes its
// output. The adapter preserves old evidence fixtures while the runtime uses
// DecisionFrame/v2 and CurrentObligation/v2 exclusively.

const { normalizeRequirement, requirementFulfilled } = require("../../packages/shared/requirements");
const { buildControlAliasIndex } = require("../../apps/web/agent/control-alias-index");
const { currentSurface } = require("../../apps/web/agent/surface-contract");

function normalizeText(value = "") {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function decisionGroupForRequirement(requirement = {}, page = {}) {
  const exact = String(requirement.decisionGroupId || requirement.scope?.decisionGroupId || "");
  if (exact) return (page.decisionGroups || []).find((group) => String(group.decisionGroupId || "") === exact) || null;
  const ids = new Set([requirement.id, requirement.requirementId, ...(requirement.targetIds || [])].filter(Boolean));
  return (page.decisionGroups || []).find((group) => (
    ids.has(group.decisionGroupId)
    || ids.has(group.requirementId)
    || (group.alternatives || []).some((choice) => ids.has(choice.controlId) || ids.has(choice.targetId))
    || normalizeText(group.sectionLabel) === normalizeText(requirement.label)
  )) || null;
}

function requirementType(group = {}) {
  const text = normalizeText(`${group.requirementId || ""} ${group.sectionType || ""} ${group.sectionLabel || ""}`);
  if (/bag|baggage|luggage/.test(text)) return "baggage_decision";
  if (/seat/.test(text)) return "seat_decision";
  if (/legal|terms|condition|agree/.test(text)) return "legal_acceptance";
  if (/payment|pay|card/.test(text)) return "payment";
  if (/bundle|flexible|ticket|sms|support|insurance|cancellation|protection|extra/.test(text)) return "paid_extra_decision";
  return "unknown";
}

function requirementFromGroup(group = {}, index = 0) {
  const optionalCompatible = group.required !== true
    && group.requiresResolution !== true
    && group.status === "optional"
    && !group.selectedControlId;
  const status = optionalCompatible
    ? "waived_by_policy"
    : (["satisfied", "waived_by_policy"].includes(group.status) ? group.status : group.status || "missing");
  const alternatives = (group.alternatives || []).map((choice) => ({
    controlId: choice.controlId || "",
    targetId: choice.targetId || "",
    label: choice.label || "",
    semantic: choice.semantic || "",
    risk: choice.risk || "",
    selected: choice.selected === true,
    priceText: choice.priceText || ""
  }));
  return {
    ...normalizeRequirement({
      id: group.decisionGroupId || `decision_group_${index}`,
      type: requirementType(group),
      label: group.sectionLabel || group.sectionType || group.requirementId || group.decisionGroupId,
      status,
      required: group.required === true,
      requiresResolution: group.requiresResolution === true,
      risk: alternatives.some((choice) => choice.risk === "money" || choice.priceText) ? "money" : "safe",
      evidence: group.evidence || [],
      targetIds: [group.decisionGroupId, group.sectionId, group.requirementId, ...alternatives.flatMap((choice) => [choice.controlId, choice.targetId])].filter(Boolean)
    }, index),
    decisionGroupId: group.decisionGroupId || "",
    surfaceId: group.surfaceId || "",
    selectedControlId: group.selectedControlId || "",
    selectedLabel: group.selectedLabel || "",
    alternatives,
    alternativeControlIds: [...(group.alternativeControlIds || [])]
  };
}

function requirementsWithDecisionGroups(classifiedRequirements = [], observation = {}) {
  const page = observation.page || {};
  const groups = page.decisionGroups || [];
  const choiceLike = (requirement = {}) => /decision|legal_acceptance/.test(requirement.type || requirement.semanticType || "");
  const withoutGroup = (requirement = {}) => {
    const exactId = String(requirement.decisionGroupId || requirement.id || "");
    const selectedFree = (page.transactionFacts?.selectedExtras || []).find((extra) => (
      String(extra.decisionGroupId || "") === exactId
      && Number(extra.priceAmount) === 0
      && /free|decline|remove|skip|without|none|not selected|no extra/.test(normalizeText(extra.disposition))
    ));
    if (choiceLike(requirement) && selectedFree) return {
      ...requirement,
      status: "satisfied",
      required: false,
      confidence: 0.95,
      evidence: [`FRESH_FREE_SELECTION_OBSERVED: ${selectedFree.label || selectedFree.decisionGroupId}.`, ...(requirement.evidence || [])].slice(0, 5)
    };
    if (choiceLike(requirement)) return {
      ...requirement,
      status: "conflicted",
      required: true,
      confidence: 0,
      evidence: ["CANONICAL_DECISION_GROUP_MISSING: choice completion cannot be derived without an observed decision group.", ...(requirement.evidence || [])].slice(0, 5)
    };
    return requirement;
  };
  if (!groups.length) return classifiedRequirements.map(withoutGroup);
  const canonical = groups.map(requirementFromGroup);
  const canonicalIds = new Set(canonical.map((item) => item.id));
  const retained = classifiedRequirements.flatMap((requirement) => {
    const group = decisionGroupForRequirement(requirement, page);
    if (!group) {
      if (requirement.decisionGroupId && (requirement.scope || requirement.lifecycleStatus || requirement.observationId)) return [];
      return [withoutGroup(requirement)];
    }
    if (/decision|legal_acceptance|unknown/.test(requirement.type || "")) return [];
    return canonicalIds.has(requirement.id) ? [] : [requirement];
  });
  return [...retained, ...canonical];
}

function stableKey(item = {}) {
  const scope = item.scope || {};
  return [item.requirementId || item.id, item.semanticType || item.type, scope.stage, scope.surfaceId, scope.decisionGroupId, scope.instanceId]
    .map((value) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, ""))
    .filter(Boolean)
    .join(":");
}

function canonicalRequirementLifecycle(requirements = [], observation = {}, previous = [], traveler = {}, pageStep = "") {
  const previousByKey = new Map(previous.map((item) => [stableKey(item), item]));
  const surface = currentSurface(observation.page || {});
  const observationId = observation.observationId || "";
  const current = requirements.map((requirement) => {
    const lifecycleStatus = requirement.status === "waived_by_policy" ? "waived_by_policy"
      : requirement.status === "satisfied" ? "satisfied"
      : requirement.status === "conflicted" ? "conflicted"
      : requirement.status === "blocked" || requirement.status === "needs_user" ? "blocked"
      : "active";
    const scope = {
      stage: pageStep || observation.page?.step || "unknown",
      surfaceId: surface.type === "page" ? "" : surface.id || "",
      decisionGroupId: requirement.decisionGroupId || "",
      instanceId: surface.type === "page" ? requirement.decisionGroupId || requirement.id || "" : surface.id || ""
    };
    const item = {
      ...requirement,
      requirementId: requirement.id || requirement.decisionGroupId || "",
      semanticType: requirement.type || "unknown",
      scope,
      desiredDisposition: /no paid|no extras|no seat/.test(normalizeText(traveler.booking_rules)) ? "decline" : "complete",
      lifecycleStatus,
      interfaceStatus: requirementFulfilled(requirement) ? "complete" : requirement.status === "missing" ? "pending" : requirement.status || "unknown",
      createdObservationId: observationId,
      lastObservedObservationId: observationId,
      observationId,
      stale: false
    };
    const old = previousByKey.get(stableKey(item));
    if (old) item.createdObservationId = old.createdObservationId || item.createdObservationId;
    return item;
  });
  const keys = new Set(current.map(stableKey));
  const stale = previous.filter((item) => !keys.has(stableKey(item)) && item.lifecycleStatus !== "stale").map((item) => ({
    ...item,
    lifecycleStatus: "stale",
    interfaceStatus: "stale",
    status: "satisfied",
    required: false,
    stale: true,
    lastObservedObservationId: observationId
  }));
  return [...current, ...stale];
}

function activeRequirementView(lifecycle = []) {
  return lifecycle.filter((item) => item.lifecycleStatus !== "stale");
}

function exactDecisionCompletionRecords(previous = [], lifecycle = [], observationId = "") {
  const records = new Map(previous.map((record) => [
    `${record.surfaceId || ""}:${record.decisionGroupId || ""}:${record.requirementId || ""}`,
    record
  ]));
  for (const requirement of lifecycle) {
    if (!requirement.decisionGroupId || !["satisfied", "waived_by_policy"].includes(requirement.lifecycleStatus || requirement.status)) continue;
    const record = {
      surfaceId: requirement.surfaceId || requirement.scope?.surfaceId || "surface-page",
      decisionGroupId: requirement.decisionGroupId,
      requirementId: requirement.requirementId || requirement.id || requirement.decisionGroupId,
      selectedControlId: requirement.selectedControlId || "",
      status: requirement.lifecycleStatus || requirement.status,
      observationId: requirement.lastObservedObservationId || requirement.observationId || observationId
    };
    records.set(`${record.surfaceId}:${record.decisionGroupId}:${record.requirementId}`, record);
  }
  return [...records.values()].slice(-120);
}

function controlDecisionGroupId(controlId = "", page = {}) {
  const control = buildControlAliasIndex(page).resolve(controlId);
  if (control?.decisionGroupId) return control.decisionGroupId;
  return (page.decisionGroups || []).find((group) => (group.alternatives || []).some((choice) => (
    choice.controlId === controlId || choice.targetId === controlId
  )))?.decisionGroupId || "";
}

function updateEvidenceMatchesRequirement(update = {}, requirement = {}, observation = {}) {
  const page = observation.page || {};
  const groupId = String(requirement.decisionGroupId || requirement.scope?.decisionGroupId || decisionGroupForRequirement(requirement, page)?.decisionGroupId || "");
  if (/decision|legal_acceptance/.test(requirement.type || requirement.semanticType || "") && !groupId) return false;
  if (!groupId) return true;
  const controlId = String(update.evidence?.controlId || "");
  const evidenceGroupId = String(update.evidence?.decisionGroupId || "") || controlDecisionGroupId(controlId, page);
  return Boolean(controlId && evidenceGroupId === groupId);
}

function deterministicRequirementEvidence(requirement = {}, observation = {}) {
  const group = decisionGroupForRequirement(requirement, observation.page || {});
  if (!group) return null;
  return {
    source: "deterministic_decision_group",
    status: ["satisfied", "waived_by_policy"].includes(group.status) ? group.status : "missing",
    evidence: group.selectedLabel ? `Decision ${group.sectionLabel || group.decisionGroupId} selected ${group.selectedLabel}.` : `Decision ${group.sectionLabel || group.decisionGroupId} has no selected option.`
  };
}

function reconcileRequirements(requirements = [], _verification = {}, observation = {}) {
  return requirements.map((requirement) => {
    const evidence = deterministicRequirementEvidence(requirement, observation);
    return evidence ? {
      ...requirement,
      status: evidence.status,
      evidence: [evidence.evidence, ...(requirement.evidence || [])].filter(Boolean).slice(0, 5),
      confidence: Math.max(requirement.confidence || 0, 0.9)
    } : requirement;
  });
}

module.exports = {
  activeRequirementView,
  canonicalRequirementLifecycle,
  controlDecisionGroupId,
  deterministicRequirementEvidence,
  exactDecisionCompletionRecords,
  reconcileRequirements,
  requirementsWithDecisionGroups,
  updateEvidenceMatchesRequirement
};
