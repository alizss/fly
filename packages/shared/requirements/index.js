// Canonical shape for one thing the checkout still needs resolved.
// This replaces "section status" as the unit of truth: a section can bundle
// several independent requirements (e.g. cabin baggage AND checked baggage),
// and treating the section as one blob is exactly what let one satisfied
// requirement silently hide an unsatisfied sibling requirement.

/**
 * @typedef {"traveler_field"|"contact_field"|"document_field"|"baggage_decision"|
 *   "seat_decision"|"paid_extra_decision"|"legal_acceptance"|"payment"|"continue"|"unknown"} RequirementType
 * @typedef {"missing"|"satisfied"|"blocked"|"needs_user"|"unknown"|"conflicted"} RequirementStatus
 * @typedef {"safe"|"money"|"payment"|"legal"|"uncertain"} RiskLevel
 *
 * @typedef {Object} CheckoutRequirement
 * @property {string} id
 * @property {string} [decisionGroupId]
 * @property {RequirementType} type
 * @property {string} label
 * @property {RequirementStatus} status
 * @property {boolean} required
 * @property {RiskLevel} risk
 * @property {string[]} evidence
 * @property {number} confidence
 * @property {string[]} targetIds
 */

const REQUIREMENT_TYPES = new Set([
  "traveler_field", "contact_field", "document_field", "baggage_decision",
  "seat_decision", "paid_extra_decision", "legal_acceptance", "payment", "continue", "unknown"
]);
const REQUIREMENT_STATUSES = new Set(["missing", "satisfied", "blocked", "needs_user", "unknown", "conflicted"]);
const RISK_LEVELS = new Set(["safe", "money", "payment", "legal", "uncertain"]);

function clampConfidence(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/** Normalize a raw (e.g. model-produced) object into a well-formed CheckoutRequirement. */
function normalizeRequirement(raw = {}, index = 0) {
  return {
    id: String(raw.id || `req_${index}_${Math.random().toString(36).slice(2, 8)}`),
    decisionGroupId: raw.decisionGroupId ? String(raw.decisionGroupId).slice(0, 140) : "",
    type: REQUIREMENT_TYPES.has(raw.type) ? raw.type : "unknown",
    label: String(raw.label || "").slice(0, 200),
    status: REQUIREMENT_STATUSES.has(raw.status) ? raw.status : "unknown",
    required: Boolean(raw.required),
    risk: RISK_LEVELS.has(raw.risk) ? raw.risk : "uncertain",
    evidence: Array.isArray(raw.evidence) ? raw.evidence.map((item) => String(item).slice(0, 300)).slice(0, 5) : [],
    confidence: clampConfidence(raw.confidence),
    targetIds: Array.isArray(raw.targetIds) ? raw.targetIds.map(String).slice(0, 10) : []
  };
}

/** True only when every required requirement is satisfied above the given confidence floor. */
function allRequiredSatisfied(requirements = [], minConfidence = 0.75) {
  return requirements
    .filter((req) => req.required)
    .every((req) => req.status === "satisfied" && req.confidence >= minConfidence);
}

function missingRequired(requirements = []) {
  return requirements.filter((req) => req.required && req.status !== "satisfied");
}

module.exports = { normalizeRequirement, allRequiredSatisfied, missingRequired, REQUIREMENT_TYPES, REQUIREMENT_STATUSES, RISK_LEVELS };
