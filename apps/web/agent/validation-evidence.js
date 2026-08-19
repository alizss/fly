const VALIDATION_STATES = Object.freeze({
  CLEAR: "clear",
  DIAGNOSTIC: "diagnostic",
  ACTIVE_CONTROL_ERROR: "active_control_error",
  ACTIVE_STAGE_ERROR: "active_stage_error",
  UNRESOLVED: "unresolved"
});

function clean(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function clearValidationMessage(message = "") {
  const normalized = clean(message).toLowerCase();
  return /\b(?:0|no|zero)\s+(?:validation\s+)?errors?\b/.test(normalized)
    || /\b(?:there (?:are|is)|found)\s+no\s+errors?\b/.test(normalized)
    || /\bvalidation\s+(?:passed|successful|clear)\b/.test(normalized);
}

function validationIssueIsBlocking(issue = {}) {
  if (typeof issue === "string") return Boolean(clean(issue)) && !clearValidationMessage(issue);
  if (!issue || issue.visible === false || clearValidationMessage(issue.message || issue.text || issue.label)) return false;
  if ([VALIDATION_STATES.CLEAR, VALIDATION_STATES.DIAGNOSTIC, VALIDATION_STATES.UNRESOLVED].includes(issue.status)) return false;
  if ([VALIDATION_STATES.ACTIVE_CONTROL_ERROR, VALIDATION_STATES.ACTIVE_STAGE_ERROR].includes(issue.status)) return true;
  if (Number(issue.errorCount) > 0 && issue.stageWide === true) return true;
  if (Array.isArray(issue.invalidControlIds) && issue.invalidControlIds.length) return true;
  if (issue.active === true && Boolean(issue.controlId || issue.stageWide === true)) return true;
  // Old persisted observations had no lifecycle status. Preserve positive
  // owned/stage-wide errors while refusing to elevate unowned prose.
  return !issue.status && Boolean(
    issue.controlId
    || issue.logicalFieldId
    || issue.logicalOwnerKey
    || issue.decisionGroupId
    || issue.stageWide === true
  );
}

function activeValidationIssues(issues = []) {
  return (issues || []).filter(validationIssueIsBlocking);
}

module.exports = {
  VALIDATION_STATES,
  activeValidationIssues,
  clearValidationMessage,
  validationIssueIsBlocking
};
