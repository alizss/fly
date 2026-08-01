const READINESS = Object.freeze({
  READY: "READY",
  TRANSIENT: "TRANSIENT",
  UNRESOLVED: "UNRESOLVED",
  DEGRADED: "DEGRADED"
});
const DESTINATION_READINESS_TIMEOUT_MS = 20_000;
const { decideStage, stageEvidence } = require("./task-state-reducer");
const {
  controlBelongsToCurrentSurface,
  currentSurface
} = require("./surface-contract");

function lower(value = "") {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function operationExecutable(control = {}) {
  return Object.values(control.operations || {}).some((operation) => (
    operation?.actionability?.executable === true || operation?.actionability?.revealable === true
  ));
}

function executableControlsForCurrentSurface(page = {}) {
  const controls = (page.controls || []).filter(operationExecutable);
  const surface = currentSurface(page);
  if (surface.type === "page" || surface.blocksBackground !== true) return controls;
  return controls.filter((control) => controlBelongsToCurrentSurface(control, page));
}

function actionableControlCount(page = {}) {
  return executableControlsForCurrentSurface(page).length;
}

function foregroundReady(page = {}) {
  const surface = currentSurface(page);
  return surface.type !== "page" && executableControlsForCurrentSurface(page).length > 0;
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
    || previousReadiness.classification === READINESS.DEGRADED
  );
}

function canonicalSemantic(control = {}) {
  return lower([
    control.fieldType
      || control.profileFieldType
      || control.field
      || control.semanticType
      || control.semantic
      || control.kind
      || "",
    control.autocomplete,
    control.name,
    control.testId,
    control.stableKey
  ].filter(Boolean).join(" "));
}

function routePath(url = "") {
  try {
    return lower(new URL(String(url || ""), "https://fly.invalid").pathname);
  } catch (error) {
    return lower(String(url || "").split(/[?#]/, 1)[0]);
  }
}

function routeStage(url = "") {
  const value = routePath(url);
  if (/payment|checkout\/pay|\/pay(?:\/|$)/.test(value)) return "payment";
  if (/travell?er|passenger|contact/.test(value)) return "traveler";
  if (/seat/.test(value)) return "seats";
  if (/extra|ancillar|baggage|bundle|insurance/.test(value)) return "extras";
  return "";
}

function visibleStage(page = {}) {
  const surface = currentSurface(page);
  const surfaceLabel = surface.type === "page" ? "" : surface.label;
  const visible = lower([
    surfaceLabel,
    page.heading,
    page.title,
    page.text
  ].filter(Boolean).join(" "));
  if (/card details|payment details|choose payment method|pay now|confirm and pay/.test(visible)) return "payment";
  if (/travell?er information|traveler information|passenger details|contact details/.test(visible)) return "traveler";
  if (/seat selection|select (?:your )?seats?\b|choose (?:your )?seats?\b|select a seat|seat map/.test(visible)) return "seats";
  if (/optional extras|customi[sz]e your trip|configure your trip|select baggage|trip protection|travel insurance/.test(visible)) return "extras";
  return "";
}

function expectedDestinationStage(page = {}) {
  const surface = currentSurface(page);
  const foregroundLabel = surface.type === "page" ? "" : lower(surface.label);
  if (/payment|billing|card details|pay now/.test(foregroundLabel)) return "payment";
  if (/travell?er|passenger|contact details|passport/.test(foregroundLabel)) return "traveler";
  if (/seat|seating/.test(foregroundLabel)) return "seats";
  if (/extra|ancillar|baggage|bundle|insurance|protection/.test(foregroundLabel)) return "extras";

  const routed = routeStage(page.url || "");
  const checkoutEvidence = stageEvidence({ page });
  const strongPaymentEvidence = checkoutEvidence.paymentSignals >= 3
    || (checkoutEvidence.payment.route && checkoutEvidence.paymentSignals >= 2);
  if (routed === "payment" && strongPaymentEvidence) return "payment";

  const visible = visibleStage(page);
  if (visible) return visible;

  const executableControls = executableControlsForCurrentSurface(page);
  const semantics = executableControls.map(canonicalSemantic);
  const has = (pattern) => semantics.some((value) => pattern.test(value));

  // Direct control evidence outranks route, progress text, and generic page copy.
  if (has(/card_number|card_expiry|card_cvc|payment_method|billing_address|cc-number|cc-exp|cc-csc/)) return "payment";
  if (has(/first_name|last_name|surname|full_name|email|phone|date_of_birth|dob|passport|nationality|traveler_title|\btitle\b/)) {
    return "traveler";
  }
  if (has(/seat_option|seat_map|seat_selection/)) return "seats";
  if (has(/select_free_option|select_paid_option|optional_extra|baggage|bundle|insurance/)) {
    return "extras";
  }

  if (routed) return routed;

  const decided = decideStage({ page });
  if (["payment", "traveler", "seats", "extras"].includes(decided.stage)) return decided.stage;

  const step = lower(page.step || page.pageStep || "unknown");
  if (/payment/.test(step)) return "payment";
  if (/travell?er|passenger|contact/.test(step)) return "traveler";
  if (/seat/.test(step)) return "seats";
  if (/extra|baggage|bundle|insurance/.test(step)) return "extras";
  return "";
}

function expectedStageContentMissing(page = {}) {
  const controls = executableControlsForCurrentSurface(page);
  const semantics = controls.map(canonicalSemantic);
  const has = (pattern) => semantics.some((value) => pattern.test(value));
  const effects = controls.map((control) => lower(
    control.physicalEffect || control.mechanicalEffect || control.semanticType || control.semantic || ""
  ));
  const hasEffect = (pattern) => effects.some((value) => pattern.test(value));
  const stage = expectedDestinationStage(page);
  const visible = visibleStage(page);
  const hasAdvancingControl = controls.some((control) => (
    /advance_surface|advance_checkout_stage|submit_form|navigation/.test(
      lower(control.physicalEffect || control.mechanicalEffect || control.semanticType || control.semantic || "")
    )
  ));

  if (stage === "traveler") {
    return !has(/first_name|last_name|surname|full_name|email|phone|date_of_birth|dob|passport|nationality|traveler_title|\btitle\b/);
  }
  if (stage === "seats") {
    const foreground = lower(`${page.currentSurface?.type || ""} ${page.currentSurface?.label || ""}`);
    return (
      !has(/seat_option|seat_map|seat_selection/)
      && !(hasEffect(/select_free_option|select_paid_option/) && hasAdvancingControl)
      && !(/seat/.test(foreground) && hasAdvancingControl)
      && !(visible === "seats" && hasAdvancingControl)
    );
  }
  if (stage === "extras") {
    return (
      !has(/select_free_option|select_paid_option|optional_extra|baggage|bundle|insurance/)
      && !hasEffect(/select_free_option|select_paid_option/)
      && !hasAdvancingControl
    );
  }
  if (stage === "payment") {
    const evidence = stageEvidence({ page });
    const terminalPaymentEvidence = evidence.paymentSignals >= 3
      || (evidence.payment.route && evidence.paymentSignals >= 2);
    return !terminalPaymentEvidence
      && !has(/card_number|card_expiry|card_cvc|payment_method|billing_address|submit_payment|submit_purchase|cc-number|cc-exp|cc-csc/);
  }
  return controls.length === 0;
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

function classifyObservationReadiness({
  observation = {},
  previousReadiness = {},
  readinessDeadlineAt = 0,
  nowMs = Date.now(),
  readinessTimeoutMs = DESTINATION_READINESS_TIMEOUT_MS
} = {}) {
  const page = observation.page || {};
  const facts = page.readiness || {};
  const key = readinessKey(observation);
  const samePendingDestination = previousReadiness.key === key
    && [READINESS.TRANSIENT, READINESS.UNRESOLVED, READINESS.DEGRADED].includes(previousReadiness.classification);
  const attempts = samePendingDestination ? Number(previousReadiness.attempts || 0) + 1 : 1;
  const startedAt = samePendingDestination
    ? Number(previousReadiness.startedAt || nowMs)
    : Number(nowMs);
  const suppliedDeadline = Number(readinessDeadlineAt || 0);
  const previousDeadline = samePendingDestination ? Number(previousReadiness.deadlineAt || 0) : 0;
  const deadlineAt = suppliedDeadline > 0
    ? suppliedDeadline
    : (previousDeadline > 0 ? previousDeadline : startedAt + Math.max(1, Number(readinessTimeoutMs || 0)));
  const deadlineExpired = Number(nowMs) >= deadlineAt;
  const controls = actionableControlCount(page);
  const explicitLoading = facts.documentReadyState === "loading"
    || facts.ariaBusy === true
    || Number(facts.loadingIndicatorCount || 0) > 0
    || facts.loadingTextEvidence === true
    || /\bplease\s+wait\b|\b(?:loading|fetching|preparing)\b.{0,80}\b(?:option|seat|fare|checkout|payment|travell?er|passenger|detail|trip)\b/.test(lower(`${page.heading || ""} ${page.text || ""}`));
  const incompleteStage = expectedStageContentMissing(page);
  const semanticReadiness = page.semanticReadiness || page.semanticCompilation?.semanticReadiness || "";
  const semanticUnresolved = semanticReadiness === "unresolved";
  const usableForeground = foregroundReady(page) && !explicitLoading && !semanticUnresolved;
  const expectedStage = expectedDestinationStage(page);
  const checkoutEvidence = stageEvidence(observation);
  const strongPaymentEvidence = checkoutEvidence.paymentSignals >= 3
    || (checkoutEvidence.payment.route && checkoutEvidence.paymentSignals >= 2);
  const afterNavigation = navigationShaped(observation, previousReadiness);
  const shellAfterNavigation = afterNavigation
    && !usableForeground
    && (incompleteStage || (
      !expectedStage
      && Number(page.summary?.fields || 0) === 0
      && Number(page.summary?.decisionGroups || 0) === 0
    ));
  const stable = facts.documentReadyState === "complete"
    && facts.ariaBusy !== true
    && Number(facts.loadingIndicatorCount || 0) === 0
    && (
      Number(facts.stableForMs || 0) >= 250
      || Number(facts.mainTextLength || 0) > 0
      || Number(facts.visibleMainCount || 0) > 0
    );
  const transient = explicitLoading || shellAfterNavigation;
  const evidence = Object.freeze({
    controls,
    incompleteStage,
    expectedStage,
    explicitLoading,
    strongPaymentEvidence,
    semanticReadiness,
    semanticUnresolved,
    unownedMaterialControls: page.semanticCompilation?.unownedMaterialControls || [],
    unresolvedDecisions: page.semanticCompilation?.unresolvedDecisions || [],
    stable,
    facts
  });

  if (transient && !deadlineExpired) {
    return Object.freeze({
      classification: READINESS.TRANSIENT,
      key,
      attempts,
      startedAt,
      deadlineAt,
      elapsedMs: Math.max(0, Number(nowMs) - startedAt),
      remainingMs: Math.max(0, deadlineAt - Number(nowMs)),
      deadlineExpired: false,
      reason: explicitLoading
        ? "PAGE_LOADING"
        : "POST_NAVIGATION_DESTINATION_NOT_READY",
      handoffEligible: false,
      evidence
    });
  }
  if (transient) {
    return Object.freeze({
      classification: READINESS.DEGRADED,
      key,
      attempts,
      startedAt,
      deadlineAt,
      elapsedMs: Math.max(0, Number(nowMs) - startedAt),
      remainingMs: 0,
      deadlineExpired: true,
      reason: explicitLoading || !stable
          ? "DESTINATION_READINESS_DEADLINE_EXPIRED_WHILE_LOADING"
          : "DESTINATION_CONTENT_MISSING_AT_READINESS_DEADLINE",
      handoffEligible: true,
      evidence
    });
  }
  if (semanticUnresolved) {
    return Object.freeze({
      classification: READINESS.UNRESOLVED,
      key,
      attempts,
      startedAt,
      deadlineAt,
      elapsedMs: Math.max(0, Number(nowMs) - startedAt),
      remainingMs: Math.max(0, deadlineAt - Number(nowMs)),
      deadlineExpired,
      reason: "SEMANTIC_COMPILATION_INCOMPLETE",
      handoffEligible: deadlineExpired,
      evidence
    });
  }
  return Object.freeze({
    classification: READINESS.READY,
    key,
    attempts: 0,
    startedAt: 0,
    deadlineAt: 0,
    elapsedMs: 0,
    remainingMs: 0,
    deadlineExpired: false,
    reason: usableForeground ? "FOREGROUND_ACTIONABLE" : "OBSERVATION_SEMANTICALLY_READY",
    handoffEligible: false,
    evidence: Object.freeze({ ...evidence, incompleteStage: false, explicitLoading: false })
  });
}

module.exports = {
  READINESS,
  DESTINATION_READINESS_TIMEOUT_MS,
  classifyObservationReadiness,
  expectedDestinationStage,
  expectedStageContentMissing,
  navigationShaped,
  readinessKey
};
