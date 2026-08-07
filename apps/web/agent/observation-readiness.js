const READINESS = Object.freeze({
  READY: "READY",
  TRANSIENT: "TRANSIENT",
  UNRESOLVED: "UNRESOLVED",
  DEGRADED: "DEGRADED"
});
const DESTINATION_READINESS_TIMEOUT_MS = 20_000;
const {
  controlBelongsToCurrentSurface,
  currentSurface
} = require("./surface-contract");
const MIN_DESTINATION_STABLE_MS = 400;

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

function checkoutRelevantControl(control = {}) {
  const evidence = lower([
    canonicalSemantic(control),
    control.label,
    control.physicalEffect,
    control.mechanicalEffect,
    control.semanticEffect
  ].filter(Boolean).join(" "));
  return /continue|next|skip|decline|close|dismiss|select|choose|travell?er|passenger|contact|seat|bag|luggage|extra|insurance|payment|card|billing|submit/.test(evidence);
}

function paymentBoundaryObserved(page = {}) {
  if (page.paymentBoundary?.boundaryObserved === true || page.terminalEvidence?.boundaryObserved === true) return true;
  return executableControlsForCurrentSurface(page).some((control) => (
    /card_number|card_expiry|card_cvc|payment_method|billing_address|submit_payment|submit_purchase|cc-number|cc-exp|cc-csc/.test(canonicalSemantic(control))
  ));
}

function navigationShaped(observation = {}, previousReadiness = {}, navigationContext = {}) {
  const result = observation.lastActionResult || navigationContext.result || {};
  const feedback = result.feedback || navigationContext.feedback || {};
  const action = result.action
    || observation.lastAction
    || navigationContext.action
    || navigationContext.originalAction
    || navigationContext
    || {};
  const lifecycle = navigationContext.lifecycle || {};
  const landedOnPageSurface = currentSurface(observation.page || {}).type === "page";
  return Boolean(
    feedback.navigationOccurred
    || result.navigationOccurred
    || (landedOnPageSurface && /advance_checkout_stage/.test(lower(action.mechanicalEffect || action.physicalEffect || "")))
    || (landedOnPageSurface && lifecycle.navigation === true && lifecycle.closed !== true)
    || (landedOnPageSurface && lifecycle.awaitingDestination === true)
    || (landedOnPageSurface && lifecycle.status === "waiting_for_destination")
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
  if (/extra|ancillar|baggage|bundle|insurance|cabin-?bags?|hold-?bags?|\/(?:bags?|luggage)(?:\/|$)/.test(value)) return "extras";
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
  if (paymentBoundaryObserved(page)) return "payment";
  const surface = currentSurface(page);
  const foregroundLabel = surface.type === "page" ? "" : lower(surface.label);
  if (/payment|billing|card details|pay now/.test(foregroundLabel)) return "payment";
  if (/travell?er|passenger|contact details|passport/.test(foregroundLabel)) return "traveler";
  if (/seat|seating/.test(foregroundLabel)) return "seats";
  if (/extra|ancillar|baggage|bundle|insurance|protection/.test(foregroundLabel)) return "extras";

  const routed = routeStage(page.url || "");
  const strongPaymentEvidence = paymentBoundaryObserved(page);
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
    const terminalPaymentEvidence = paymentBoundaryObserved(page);
    return !terminalPaymentEvidence
      && !has(/card_number|card_expiry|card_cvc|payment_method|billing_address|submit_payment|submit_purchase|cc-number|cc-exp|cc-csc/);
  }
  return controls.length === 0;
}

function meaningfulDestinationCapability(page = {}, stage = "") {
  const controls = executableControlsForCurrentSurface(page);
  return controls.some((control) => {
    const semantic = canonicalSemantic(control);
    const effect = lower(`${control.physicalEffect || ""} ${control.mechanicalEffect || ""} ${control.semanticEffect || ""}`);
    const evidence = `${semantic} ${effect}`;
    if (stage === "traveler") {
      return /first_name|last_name|surname|full_name|email|phone|date_of_birth|dob|passport|nationality|traveler_title|age_at_departure|\btitle\b/.test(evidence);
    }
    if (stage === "seats") {
      return /seat|select_free_option|select_paid_option|add_paid_extra|required_dropdown_choice|decline_paid_extra/.test(evidence)
        || checkoutRelevantControl(control);
    }
    if (stage === "extras") {
      return /select_free_option|select_paid_option|add_paid_extra|optional_extra|baggage|bundle|insurance|protection|decline_paid_extra/.test(evidence)
        || checkoutRelevantControl(control);
    }
    if (stage === "payment") {
      return /card_number|card_expiry|card_cvc|payment_method|billing_address|submit_payment|submit_purchase|cc-number|cc-exp|cc-csc/.test(evidence);
    }
    return checkoutRelevantControl(control);
  });
}

function readinessKey(observation = {}) {
  const page = observation.page || {};
  return [
    lower(page.step || page.pageStep || "unknown"),
    lower(page.url || observation.url || "")
  ].join("|");
}

function classifyObservationReadiness({
  observation = {},
  previousReadiness = {},
  navigationContext = {},
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
  // A deadline belongs to one exact destination key. A new stage, surface,
  // or URL starts a fresh readiness episode instead of inheriting time spent
  // hydrating the previous page.
  const deadlineAt = previousDeadline > 0
    ? previousDeadline
    : (samePendingDestination && suppliedDeadline > 0
        ? suppliedDeadline
        : startedAt + Math.max(1, Number(readinessTimeoutMs || 0)));
  const deadlineExpired = Number(nowMs) >= deadlineAt;
  const controls = actionableControlCount(page);
  const explicitLoading = facts.documentReadyState === "loading"
    || facts.ariaBusy === true
    || Number(facts.loadingIndicatorCount || 0) > 0
    || facts.loadingTextEvidence === true
    || /\bplease\s+wait\b|\b(?:loading|fetching|preparing)\b.{0,80}\b(?:option|seat|fare|checkout|payment|travell?er|passenger|detail|trip)\b/.test(lower(`${page.heading || ""} ${page.text || ""}`));
  const incompleteStage = expectedStageContentMissing(page);
  const usableForeground = foregroundReady(page) && !explicitLoading;
  const expectedStage = expectedDestinationStage(page);
  const strongPaymentEvidence = paymentBoundaryObserved(page);
  const afterNavigation = navigationShaped(observation, previousReadiness, navigationContext);
  const hasReadinessEvidence = Boolean(
    facts.documentReadyState
    || facts.stableForMs != null
    || facts.ariaBusy === true
    || Number(facts.loadingIndicatorCount || 0) > 0
  );
  const stable = (!hasReadinessEvidence || facts.documentReadyState === "complete")
    && facts.ariaBusy !== true
    && Number(facts.loadingIndicatorCount || 0) === 0
    && (Number(facts.stableForMs || 0) >= MIN_DESTINATION_STABLE_MS || !hasReadinessEvidence);
  const controllerReady = !explicitLoading
    && (strongPaymentEvidence || meaningfulDestinationCapability(page, expectedStage));
  const shellAfterNavigation = afterNavigation
    && !usableForeground
    && !controllerReady
    && (incompleteStage || (
      !expectedStage
      && Number(page.summary?.fields || 0) === 0
      && Number(page.summary?.decisionGroups || 0) === 0
    ));
  // A changed destination cannot become actionable merely because some text
  // or a temporarily positioned panel exists. Wait for one structurally
  // settled frame before semantic planning is allowed to own the page.
  const transient = explicitLoading
    || (afterNavigation
      && !stable
      && !strongPaymentEvidence
      && !(samePendingDestination && controllerReady))
    || shellAfterNavigation;
  const evidence = Object.freeze({
    controls,
    incompleteStage,
    expectedStage,
    explicitLoading,
    strongPaymentEvidence,
    controllerReady,
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
  if (transient && (!stable || explicitLoading)) {
    return Object.freeze({
      classification: READINESS.DEGRADED,
      key,
      attempts,
      startedAt,
      deadlineAt,
      elapsedMs: Math.max(0, Number(nowMs) - startedAt),
      remainingMs: 0,
      deadlineExpired: true,
      reason: "DESTINATION_READINESS_DEADLINE_EXPIRED_WHILE_LOADING",
      handoffEligible: true,
      evidence
    });
  }
  if (transient) {
    return Object.freeze({
      classification: READINESS.READY,
      key,
      attempts: 0,
      startedAt: 0,
      deadlineAt: 0,
      elapsedMs: 0,
      remainingMs: 0,
      deadlineExpired: false,
      reason: "STABLE_DESTINATION_CONTROLLER_HANDOFF",
      handoffEligible: false,
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
    reason: usableForeground
      ? "FOREGROUND_ACTIONABLE"
      : (controllerReady ? "STABLE_DESTINATION_CONTROLLER_READY" : "OBSERVATION_STABLE"),
    handoffEligible: false,
    evidence
  });
}

module.exports = {
  READINESS,
  DESTINATION_READINESS_TIMEOUT_MS,
  MIN_DESTINATION_STABLE_MS,
  classifyObservationReadiness,
  expectedDestinationStage,
  expectedStageContentMissing,
  meaningfulDestinationCapability,
  navigationShaped,
  readinessKey
};
