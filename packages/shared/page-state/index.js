const FIELD_KINDS = new Set(["traveler", "contact", "document", "billing", "unknown"]);
const CHOICE_KINDS = new Set(["baggage", "seat", "paid_extra", "legal", "unknown"]);
const STEP_VALUES = new Set(["flight_selection", "traveler_information", "extras", "seats", "payment", "confirmation", "unknown"]);
const STATUS_VALUES = new Set(["missing", "satisfied", "blocked", "needs_user", "unknown"]);
const RISK_VALUES = new Set(["safe", "money", "payment", "legal", "uncertain"]);
const NAV_ACTIONS = new Set(["continue", "next", "back", "close", "skip", "final_purchase", "unknown"]);

function clamp(value, min = 0, max = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function str(value, max = 300) {
  return String(value || "").slice(0, max);
}

function arr(value, max = 8) {
  return Array.isArray(value) ? value.map((item) => String(item).slice(0, 300)).slice(0, max) : [];
}

function normalizeBox(raw = {}) {
  return {
    x: Math.round(Number(raw.x) || 0),
    y: Math.round(Number(raw.y) || 0),
    width: Math.max(0, Math.round(Number(raw.width) || 0)),
    height: Math.max(0, Math.round(Number(raw.height) || 0)),
    centerX: Math.round(Number(raw.centerX) || Number(raw.x) || 0),
    centerY: Math.round(Number(raw.centerY) || Number(raw.y) || 0),
    inViewport: Boolean(raw.inViewport)
  };
}

function normalizeRequiredField(raw = {}, index = 0) {
  return {
    id: str(raw.id || `field_${index}`, 120),
    kind: FIELD_KINDS.has(raw.kind) ? raw.kind : "unknown",
    label: str(raw.label, 200),
    status: STATUS_VALUES.has(raw.status) ? raw.status : "unknown",
    required: Boolean(raw.required),
    risk: RISK_VALUES.has(raw.risk) ? raw.risk : "safe",
    targetIds: arr(raw.targetIds, 10),
    evidence: arr(raw.evidence, 5),
    confidence: clamp(raw.confidence)
  };
}

function normalizeRequiredChoice(raw = {}, index = 0) {
  return {
    id: str(raw.id || `choice_${index}`, 120),
    kind: CHOICE_KINDS.has(raw.kind) ? raw.kind : "unknown",
    label: str(raw.label, 200),
    status: STATUS_VALUES.has(raw.status) ? raw.status : "unknown",
    required: Boolean(raw.required),
    risk: RISK_VALUES.has(raw.risk) ? raw.risk : "uncertain",
    targetIds: arr(raw.targetIds, 10),
    evidence: arr(raw.evidence, 5),
    confidence: clamp(raw.confidence)
  };
}

function normalizeOptionalExtra(raw = {}, index = 0) {
  return {
    id: str(raw.id || `extra_${index}`, 120),
    label: str(raw.label, 200),
    status: STATUS_VALUES.has(raw.status) ? raw.status : "unknown",
    risk: RISK_VALUES.has(raw.risk) ? raw.risk : "money",
    priceText: str(raw.priceText, 80),
    targetIds: arr(raw.targetIds, 10),
    evidence: arr(raw.evidence, 5),
    confidence: clamp(raw.confidence)
  };
}

function normalizeNavigationAction(raw = {}, index = 0) {
  return {
    id: str(raw.id || `nav_${index}`, 120),
    action: NAV_ACTIONS.has(raw.action) ? raw.action : "unknown",
    label: str(raw.label, 200),
    enabled: Boolean(raw.enabled),
    risk: RISK_VALUES.has(raw.risk) ? raw.risk : "safe",
    targetId: str(raw.targetId, 120),
    x: Math.round(Number(raw.x) || 0),
    y: Math.round(Number(raw.y) || 0),
    evidence: arr(raw.evidence, 5),
    confidence: clamp(raw.confidence)
  };
}

function normalizeRiskGate(raw = {}, index = 0) {
  return {
    id: str(raw.id || `gate_${index}`, 120),
    type: ["payment", "final_purchase", "legal_checkbox", "price_increase", "identity", "unknown"].includes(raw.type) ? raw.type : "unknown",
    label: str(raw.label, 200),
    status: STATUS_VALUES.has(raw.status) ? raw.status : "unknown",
    risk: RISK_VALUES.has(raw.risk) ? raw.risk : "uncertain",
    targetIds: arr(raw.targetIds, 10),
    evidence: arr(raw.evidence, 5),
    confidence: clamp(raw.confidence)
  };
}

function normalizeActiveSurface(raw = {}) {
  return {
    present: Boolean(raw.present),
    type: ["page", "modal", "dropdown", "popover", "unknown"].includes(raw.type) ? raw.type : "page",
    label: str(raw.label, 300),
    taskHint: str(raw.taskHint, 120),
    targetIds: arr(raw.targetIds, 6),
    summary: str(raw.summary, 400)
  };
}

function normalizePageState(raw = {}) {
  return {
    pageStep: STEP_VALUES.has(raw.pageStep) ? raw.pageStep : "unknown",
    requiredFields: (raw.requiredFields || []).map(normalizeRequiredField),
    requiredChoices: (raw.requiredChoices || []).map(normalizeRequiredChoice),
    optionalPaidExtras: (raw.optionalPaidExtras || []).map(normalizeOptionalExtra),
    navigationActions: (raw.navigationActions || []).map(normalizeNavigationAction),
    riskGates: (raw.riskGates || []).map(normalizeRiskGate),
    activeSurface: normalizeActiveSurface(raw.activeSurface || {}),
    uncertainties: arr(raw.uncertainties, 10),
    summary: str(raw.summary, 500)
  };
}

function fieldRequirementType(kind) {
  if (kind === "contact") return "contact_field";
  if (kind === "document") return "document_field";
  return "traveler_field";
}

function choiceRequirementType(kind) {
  if (kind === "baggage") return "baggage_decision";
  if (kind === "seat") return "seat_decision";
  if (kind === "paid_extra") return "paid_extra_decision";
  if (kind === "legal") return "legal_acceptance";
  return "unknown";
}

function requirementsFromPageState(pageState) {
  const requirements = [];
  for (const field of pageState.requiredFields || []) {
    requirements.push({
      id: field.id,
      type: fieldRequirementType(field.kind),
      label: field.label,
      status: field.status,
      required: field.required,
      risk: field.risk,
      evidence: field.evidence,
      confidence: field.confidence,
      targetIds: field.targetIds
    });
  }
  for (const choice of pageState.requiredChoices || []) {
    requirements.push({
      id: choice.id,
      type: choiceRequirementType(choice.kind),
      label: choice.label,
      status: choice.status,
      required: choice.required,
      risk: choice.risk,
      evidence: choice.evidence,
      confidence: choice.confidence,
      targetIds: choice.targetIds
    });
  }
  for (const gate of pageState.riskGates || []) {
    requirements.push({
      id: gate.id,
      type: gate.type === "payment" || gate.type === "final_purchase" ? "payment" : "legal_acceptance",
      label: gate.label,
      status: gate.status,
      required: gate.status !== "satisfied",
      risk: gate.risk,
      evidence: gate.evidence,
      confidence: gate.confidence,
      targetIds: gate.targetIds
    });
  }
  for (const extra of pageState.optionalPaidExtras || []) {
    requirements.push({
      id: extra.id,
      type: "paid_extra_decision",
      label: extra.label,
      status: extra.status,
      required: false,
      risk: extra.risk,
      evidence: extra.evidence,
      confidence: extra.confidence,
      targetIds: extra.targetIds
    });
  }
  return requirements;
}

module.exports = {
  normalizePageState,
  requirementsFromPageState,
  normalizeBox,
  FIELD_KINDS,
  CHOICE_KINDS,
  NAV_ACTIONS
};
