export const VALIDATION_STATES = Object.freeze({
  CLEAR: "clear",
  DIAGNOSTIC: "diagnostic",
  ACTIVE_CONTROL_ERROR: "active_control_error",
  ACTIVE_STAGE_ERROR: "active_stage_error",
  UNRESOLVED: "unresolved"
});

function normalizedMessage(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function validationErrorCount(message = "") {
  const normalized = normalizedMessage(message).toLowerCase();
  if (!normalized) return null;
  if (/\b(?:no|zero)\s+(?:validation\s+)?errors?\b/.test(normalized)) return 0;
  const explicit = normalized.match(/(?:^|\D)(\d+)\s+(?:validation\s+)?errors?\b/);
  return explicit ? Number(explicit[1]) : null;
}

export function clearValidationMessage(message = "") {
  const normalized = normalizedMessage(message).toLowerCase();
  return validationErrorCount(normalized) === 0
    || /\b(?:there (?:are|is)|found)\s+no\s+errors?\b/.test(normalized)
    || /\bvalidation\s+(?:passed|successful|clear)\b/.test(normalized);
}

export function validationLifecycle(evidence = {}) {
  const message = normalizedMessage(evidence.message || evidence.text || evidence.label || evidence);
  const visible = evidence.visible !== false;
  const errorCount = evidence.errorCount !== null
    && evidence.errorCount !== undefined
    && Number.isFinite(Number(evidence.errorCount))
    ? Number(evidence.errorCount)
    : validationErrorCount(message);
  const invalidControlIds = [...new Set([
    ...(Array.isArray(evidence.invalidControlIds) ? evidence.invalidControlIds : []),
    evidence.invalidControlId
  ].filter(Boolean).map(String))];
  const controlId = String(evidence.controlId || invalidControlIds[0] || "");
  const stageWide = evidence.stageWide === true;
  const introducedAfterAction = evidence.introducedAfterAction === true;
  const explicitlyActive = evidence.active === true;

  let status = String(evidence.status || "");
  if (!visible || clearValidationMessage(message) || errorCount === 0) {
    status = VALIDATION_STATES.CLEAR;
  } else if (errorCount > 0 && stageWide) {
    status = VALIDATION_STATES.ACTIVE_STAGE_ERROR;
  } else if (invalidControlIds.length || (controlId && (explicitlyActive || introducedAfterAction || evidence.ownerReferenced === true))) {
    status = VALIDATION_STATES.ACTIVE_CONTROL_ERROR;
  } else if (stageWide && (explicitlyActive || introducedAfterAction)) {
    status = VALIDATION_STATES.ACTIVE_STAGE_ERROR;
  } else if (!status || !Object.values(VALIDATION_STATES).includes(status)) {
    status = evidence.diagnostic === true ? VALIDATION_STATES.DIAGNOSTIC : VALIDATION_STATES.UNRESOLVED;
  }

  const active = status === VALIDATION_STATES.ACTIVE_CONTROL_ERROR
    || status === VALIDATION_STATES.ACTIVE_STAGE_ERROR;
  return Object.freeze({
    status,
    active,
    visible,
    errorCount,
    controlId,
    invalidControlIds: Object.freeze(invalidControlIds),
    introducedAfterAction
  });
}

export function validationIssueIsBlocking(issue = {}) {
  if (typeof issue === "string") {
    return Boolean(normalizedMessage(issue)) && !clearValidationMessage(issue);
  }
  return validationLifecycle(issue).active === true;
}

export function actionableCheckoutErrors(errors = []) {
  return (errors || [])
    .filter(validationIssueIsBlocking)
    .map((error) => normalizedMessage(typeof error === "string" ? error : error?.message || ""))
    .filter(Boolean)
    .filter((error) => !/no seat map available|not possible to reserve seats|requested random seating/i.test(error));
}
