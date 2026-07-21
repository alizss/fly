const READINESS = Object.freeze({
  READY: "READY",
  TRANSIENT: "TRANSIENT",
  DEGRADED: "DEGRADED"
});
const { stageEvidence } = require("./task-state-reducer");

function lower(value = "") {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function actionableControlCount(page = {}) {
  return (page.controls || []).filter((control) => Object.values(control.operations || {}).some((operation) => (
    operation?.actionability?.executable === true || operation?.actionability?.revealable === true
  ))).length;
}

function foregroundReady(page = {}) {
  const surface = page.currentSurface || page.activeSurface || {};
  if (!surface.type || surface.type === "page") return false;
  const members = new Set(surface.memberControlIds || []);
  return (page.controls || []).some((control) => (
    (members.has(control.controlId) || control.surfaceId === surface.id)
    && Object.values(control.operations || {}).some((operation) => operation?.actionability?.executable === true)
  ));
}

function navigationShaped(observation = {}, previousReadiness = {}) {
  const result = observation.lastActionResult || {};
  const feedback = result.feedback || {};
  const action = result.action || observation.lastAction || {};
  return Boolean(
    feedback.navigationOccurred
    || feedback.pageChanged
    || feedback.surfaceChanged
    || feedback.progressChanged
    || result.pageChanged
    || /navigate|advance|continue|next|reobserve_after_transient/.test(lower(`${action.intent || ""} ${action.semanticIntent || ""}`))
    || /advance_surface|advance_checkout_stage/.test(lower(action.mechanicalEffect || action.physicalEffect || ""))
    || previousReadiness.classification === READINESS.TRANSIENT
  );
}

function expectedStageContentMissing(page = {}) {
  const step = lower(page.step || page.pageStep || "unknown");
  const text = lower(`${page.visibleText || page.text || ""} ${page.currentSurface?.label || ""}`);
  const controls = page.controls || [];
  const groups = page.decisionGroups || [];
  if (step === "traveler_information" || /travell?er information|passenger information|contact information/.test(text)) {
    return !controls.some((control) => /first_name|last_name|full_name|email|phone|date_of_birth|passport/.test(lower(`${control.field || ""} ${control.semantic || ""}`)));
  }
  if (step === "seats" || /seat selection|reserve seating|seat map/.test(text)) {
    return !controls.some((control) => /seat|continue|next|skip|decline/.test(lower(`${control.semantic || ""} ${control.label || ""}`)));
  }
  if (step === "extras" || /baggage|insurance|bundle|optional extras/.test(text)) {
    return groups.length === 0 && !controls.some((control) => /continue|next|skip|decline|no thanks/.test(lower(`${control.semantic || ""} ${control.label || ""}`)));
  }
  return false;
}

function readinessKey(observation = {}) {
  const page = observation.page || {};
  const surface = page.currentSurface || page.activeSurface || {};
  return [
    lower(page.step || page.pageStep || "unknown"),
    lower(surface.type || "page"),
    lower(surface.id || "surface-page"),
    lower(page.url || observation.url || "")
  ].join("|");
}

function classifyObservationReadiness({ observation = {}, previousReadiness = {}, maxTransientAttempts = 3 } = {}) {
  const page = observation.page || {};
  const facts = page.readiness || {};
  const key = readinessKey(observation);
  const sameTransient = previousReadiness.key === key && previousReadiness.classification === READINESS.TRANSIENT;
  const attempts = sameTransient ? Number(previousReadiness.attempts || 0) + 1 : 1;
  const controls = actionableControlCount(page);
  const explicitLoading = facts.documentReadyState === "loading"
    || facts.ariaBusy === true
    || Number(facts.loadingIndicatorCount || 0) > 0;
  const incompleteStage = expectedStageContentMissing(page);
  const checkoutEvidence = stageEvidence(observation);
  const strongPaymentEvidence = checkoutEvidence.paymentSignals >= 3
    || (checkoutEvidence.payment.route && checkoutEvidence.paymentSignals >= 2);
  const shellAfterNavigation = navigationShaped(observation, previousReadiness)
    && !foregroundReady(page)
    && !strongPaymentEvidence
    && controls <= 4
    && (incompleteStage || Number(page.summary?.fields || 0) === 0 && Number(page.summary?.decisionGroups || 0) === 0);
  const transient = explicitLoading || shellAfterNavigation;

  if (transient && attempts <= maxTransientAttempts) {
    return Object.freeze({
      classification: READINESS.TRANSIENT,
      key,
      attempts,
      maxAttempts: maxTransientAttempts,
      reason: explicitLoading ? "PAGE_LOADING" : "POST_NAVIGATION_SHELL_ONLY",
      evidence: Object.freeze({ controls, incompleteStage, explicitLoading, strongPaymentEvidence, facts })
    });
  }
  if (transient) {
    return Object.freeze({
      classification: READINESS.DEGRADED,
      key,
      attempts,
      maxAttempts: maxTransientAttempts,
      reason: "TRANSIENT_OBSERVATION_RETRY_EXHAUSTED",
      evidence: Object.freeze({ controls, incompleteStage, explicitLoading, strongPaymentEvidence, facts })
    });
  }
  return Object.freeze({
    classification: READINESS.READY,
    key,
    attempts: 0,
    maxAttempts: maxTransientAttempts,
    reason: foregroundReady(page) ? "FOREGROUND_ACTIONABLE" : "OBSERVATION_SEMANTICALLY_READY",
    evidence: Object.freeze({ controls, incompleteStage: false, explicitLoading: false, strongPaymentEvidence, facts })
  });
}

module.exports = {
  READINESS,
  classifyObservationReadiness,
  expectedStageContentMissing,
  navigationShaped,
  readinessKey
};
