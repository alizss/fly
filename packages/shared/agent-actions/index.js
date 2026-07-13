/**
 * @typedef {"click"|"click_xy"|"type"|"select"|"scroll"|"keypress"|"wait"|"ask_user"|"final_review"|"stop"|"fill_known_fields"|"fill_visible_profile_fields"|"skip_optional_extra"|"close_modal"|"save_trip"} ActionType
 *
 * @typedef {Object} AgentAction
 * @property {string} id
 * @property {ActionType} type
 * @property {string} [observationId]
 * @property {string} [observationHash]
 * @property {string} [intent]
 * @property {string} [controlId]
 * @property {string} [decisionGroupId]
 * @property {string} [targetId]
 * @property {string} [targetLabel]
 * @property {Object} [targetSnapshot]
 * @property {Object} [expectedOutcome]
 * @property {string} [value]
 * @property {number} [x]
 * @property {number} [y]
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
  "skip_optional_extra",
  "close_modal",
  "save_trip"
]);
const RISK_LEVELS = new Set(["safe", "money", "payment", "legal", "uncertain"]);

function normalizeTargetId(value) {
  const id = String(value || "").trim();
  if (!id || /^(false|true|null|undefined|\[object object\])$/i.test(id)) return "";
  return id.slice(0, 120);
}

function normalizeAction(raw = {}) {
  return {
    id: String(raw.id || `act_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`),
    type: ACTION_TYPES.has(raw.type) ? raw.type : "stop",
    observationId: raw.observationId ? String(raw.observationId).slice(0, 120) : "",
    observationHash: raw.observationHash ? String(raw.observationHash).slice(0, 120) : "",
    intent: raw.intent ? String(raw.intent).slice(0, 120) : "",
    controlId: raw.controlId ? String(raw.controlId).slice(0, 140) : (raw.targetSnapshot?.controlId ? String(raw.targetSnapshot.controlId).slice(0, 140) : ""),
    decisionGroupId: raw.decisionGroupId ? String(raw.decisionGroupId).slice(0, 140) : (raw.targetSnapshot?.decisionGroupId ? String(raw.targetSnapshot.decisionGroupId).slice(0, 140) : ""),
    targetId: normalizeTargetId(raw.targetId),
    targetLabel: raw.targetLabel ? String(raw.targetLabel).slice(0, 300) : "",
    targetSnapshot: raw.targetSnapshot && typeof raw.targetSnapshot === "object" ? raw.targetSnapshot : null,
    expectedOutcome: raw.expectedOutcome && typeof raw.expectedOutcome === "object" ? raw.expectedOutcome : null,
    value: raw.value ? String(raw.value).slice(0, 600) : "",
    x: Number.isFinite(Number(raw.x)) ? Math.round(Number(raw.x)) : null,
    y: Number.isFinite(Number(raw.y)) ? Math.round(Number(raw.y)) : null,
    scrollY: Number.isFinite(Number(raw.scrollY)) ? Math.round(Number(raw.scrollY)) : 0,
    keys: raw.keys ? String(raw.keys).slice(0, 80) : "",
    reason: String(raw.reason || "").slice(0, 500),
    requirementId: raw.requirementId ? String(raw.requirementId) : "",
    risk: RISK_LEVELS.has(raw.risk) ? raw.risk : "uncertain",
    requiresApproval: Boolean(raw.requiresApproval)
  };
}

/** Two actions are "the same attempt" if they'd resolve to the same target+value+type. */
function actionSignature(action) {
  return `${action.type}:${action.targetId || action.targetLabel || `${action.x || ""},${action.y || ""}`}:${action.value || action.keys || action.scrollY || ""}`;
}

module.exports = { normalizeAction, actionSignature, ACTION_TYPES };
