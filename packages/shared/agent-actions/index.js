/**
 * @typedef {"click"|"click_xy"|"type"|"select"|"scroll"|"keypress"|"wait"|"ask_user"|"final_review"|"stop"|"fill_known_fields"|"fill_visible_profile_fields"|"save_trip"} ActionType
 *
 * @typedef {Object} AgentAction
 * @property {string} id
 * @property {ActionType} type
 * @property {string} [observationId]
 * @property {string} [observationHash]
 * @property {string} [intent]
 * @property {"activate"|"open"|"choose"|"type"|"select"|"keyboard"} [operation]
 * @property {"choice"|"command"|"opener"|"navigation"|"field"} [interactionRole]
 * @property {"select"|"waive"|"open"|"advance"|"set_value"} [semanticEffect]
 * @property {"selected"|"dismissed"|"options_appeared"|"progress_changed"|"value_changed"|"target_visible"} [expectedEvidence]
 * @property {string} [goalId]
 * @property {string} [candidateId]
 * @property {string} [skillPlanId]
 * @property {string} [skillAtomId]
 * @property {string} [controlId]
 * @property {string} [decisionGroupId]
 * @property {string} [targetId]
 * @property {string} [targetLabel]
 * @property {Object} [targetSnapshot]
 * @property {Object} [expectedOutcome]
 * @property {Object} [affordance]
 * @property {string} [value]
 * @property {number} [x]
 * @property {number} [y]
 * @property {VisualRegion} [visualRegion]
 * @property {number} [scrollY]
 * @property {string} [keys]
 * @property {string} reason
 * @property {string} [requirementId]
 * @property {"safe"|"money"|"payment"|"legal"|"uncertain"} risk
 * @property {boolean} requiresApproval
 */

const ACTION_TYPES = new Set([
  "click",
  "click_xy",
  "type",
  "select",
  "scroll",
  "keypress",
  "wait",
  "ask_user",
  "final_review",
  "stop",
  "fill_known_fields",
  "fill_visible_profile_fields",
  "save_trip"
]);
const RISK_LEVELS = new Set(["safe", "money", "payment", "legal", "uncertain"]);

/**
 * One lossless geometry contract shared by observation, planning, governance,
 * execution, and verification.
 *
 * @typedef {Object} VisualRegion
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 * @property {number} centerX
 * @property {number} centerY
 * @property {number} viewportWidth
 * @property {number} viewportHeight
 * @property {string} surfaceId
 * @property {string} observationId
 * @property {string} controlId
 * @property {string} operation
 * @property {string} source
 * @property {number} confidence
 * @property {string} evidence
 * @property {boolean} inViewport
 */

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeVisualRegion(raw = {}, context = {}) {
  if (!raw || typeof raw !== "object") return null;
  const x = Math.round(finiteNumber(raw.x));
  const y = Math.round(finiteNumber(raw.y));
  const width = Math.max(0, Math.round(finiteNumber(raw.width)));
  const height = Math.max(0, Math.round(finiteNumber(raw.height)));
  return {
    x,
    y,
    width,
    height,
    centerX: Math.round(finiteNumber(raw.centerX, x + width / 2)),
    centerY: Math.round(finiteNumber(raw.centerY, y + height / 2)),
    viewportWidth: Math.max(0, Math.round(finiteNumber(raw.viewportWidth, context.viewportWidth))),
    viewportHeight: Math.max(0, Math.round(finiteNumber(raw.viewportHeight, context.viewportHeight))),
    surfaceId: String(raw.surfaceId || context.surfaceId || "").slice(0, 120),
    observationId: String(raw.observationId || context.observationId || "").slice(0, 120),
    controlId: String(raw.controlId || context.controlId || "").slice(0, 140),
    operation: String(raw.operation || context.operation || "").slice(0, 40),
    source: String(raw.source || context.source || "").slice(0, 120),
    confidence: Math.max(0, Math.min(1, finiteNumber(raw.confidence, context.confidence))),
    evidence: String(raw.evidence || context.evidence || "").slice(0, 240),
    inViewport: raw.inViewport !== false
  };
}

function visualRegionsMatch(left = {}, right = {}, tolerance = 2) {
  const a = normalizeVisualRegion(left);
  const b = normalizeVisualRegion(right);
  if (!a || !b) return false;
  const geometryMatches = ["x", "y", "width", "height", "centerX", "centerY"]
    .every((key) => Math.abs(a[key] - b[key]) <= tolerance);
  if (!geometryMatches) return false;
  return ["viewportWidth", "viewportHeight", "surfaceId", "observationId", "controlId", "operation", "source"]
    .every((key) => !a[key] || !b[key] || a[key] === b[key]);
}

function normalizeTargetId(value) {
  const id = String(value || "").trim();
  if (!id || /^(false|true|null|undefined|\[object object\])$/i.test(id)) return "";
  return id.slice(0, 120);
}

function normalizeAction(raw = {}) {
  const region = raw.visualRegion && typeof raw.visualRegion === "object" ? raw.visualRegion : null;
  return {
    id: String(raw.id || `act_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`),
    type: ACTION_TYPES.has(raw.type) ? raw.type : "stop",
    observationId: raw.observationId ? String(raw.observationId).slice(0, 120) : "",
    observationHash: raw.observationHash ? String(raw.observationHash).slice(0, 120) : "",
    intent: raw.intent ? String(raw.intent).slice(0, 120) : "",
    operation: raw.operation ? String(raw.operation).slice(0, 40) : "",
    interactionRole: raw.interactionRole ? String(raw.interactionRole).slice(0, 40) : "",
    semanticEffect: raw.semanticEffect ? String(raw.semanticEffect).slice(0, 40) : "",
    expectedEvidence: raw.expectedEvidence ? String(raw.expectedEvidence).slice(0, 40) : "",
    goalId: raw.goalId ? String(raw.goalId).slice(0, 200) : "",
    candidateId: raw.candidateId ? String(raw.candidateId).slice(0, 240) : "",
    skillPlanId: raw.skillPlanId ? String(raw.skillPlanId).slice(0, 160) : "",
    skillAtomId: raw.skillAtomId ? String(raw.skillAtomId).slice(0, 200) : "",
    controlId: raw.controlId ? String(raw.controlId).slice(0, 140) : (raw.targetSnapshot?.controlId ? String(raw.targetSnapshot.controlId).slice(0, 140) : ""),
    decisionGroupId: raw.decisionGroupId ? String(raw.decisionGroupId).slice(0, 140) : (raw.targetSnapshot?.decisionGroupId ? String(raw.targetSnapshot.decisionGroupId).slice(0, 140) : ""),
    targetId: normalizeTargetId(raw.targetId),
    targetLabel: raw.targetLabel ? String(raw.targetLabel).slice(0, 300) : "",
    targetSnapshot: raw.targetSnapshot && typeof raw.targetSnapshot === "object" ? raw.targetSnapshot : null,
    expectedOutcome: raw.expectedOutcome && typeof raw.expectedOutcome === "object" ? raw.expectedOutcome : null,
    affordance: raw.affordance && typeof raw.affordance === "object" ? raw.affordance : null,
    value: raw.value ? String(raw.value).slice(0, 600) : "",
    x: Number.isFinite(Number(raw.x)) ? Math.round(Number(raw.x)) : null,
    y: Number.isFinite(Number(raw.y)) ? Math.round(Number(raw.y)) : null,
    visualRegion: normalizeVisualRegion(region, {
      observationId: raw.observationId,
      controlId: raw.controlId || raw.targetSnapshot?.controlId,
      operation: raw.operation,
      source: raw.targetSnapshot?.source || raw.source
    }),
    scrollY: Number.isFinite(Number(raw.scrollY)) ? Math.round(Number(raw.scrollY)) : 0,
    keys: raw.keys ? String(raw.keys).slice(0, 80) : "",
    reason: String(raw.reason || "").slice(0, 500),
    requirementId: raw.requirementId ? String(raw.requirementId) : "",
    risk: RISK_LEVELS.has(raw.risk) ? raw.risk : "uncertain",
    requiresApproval: Boolean(raw.requiresApproval)
  };
}

/** Stable identity for one physical actuator attempt within a checkout transaction. */
function actuatorSignature(action = {}) {
  const affordance = action.affordance || {};
  if (affordance.stableKey && affordance.actuator?.stableKey && affordance.effect) {
    return `${affordance.stableKey}:${affordance.actuator.stableKey}:${affordance.effect}:${action.value || action.keys || action.scrollY || ""}`;
  }
  const type = action.type || action.action || "";
  const target = action.targetSnapshot || {};
  return `${type}:${action.operation || ""}:${action.controlId || target.controlId || ""}:${action.targetId || target.id || `${action.x ?? ""},${action.y ?? ""}`}:${action.value || action.keys || action.scrollY || ""}`;
}

/** Two actions are "the same attempt" if they'd resolve to the same target+value+type. */
function actionSignature(action) {
  return actuatorSignature(action);
}

module.exports = {
  normalizeAction,
  normalizeVisualRegion,
  visualRegionsMatch,
  actionSignature,
  actuatorSignature,
  ACTION_TYPES
};
