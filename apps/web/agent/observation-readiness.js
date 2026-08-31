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

function navigationSettlementPending(observation = {}, navigationContext = {}) {
  const result = observation.lastActionResult || navigationContext.result || {};
  const lifecycle = navigationContext.lifecycle || {};
  const destinationReadiness = navigationContext.destinationReadiness || {};
  const outcome = result.actionOutcome || {};
  return Boolean(
    lifecycle.closed !== true
    && (
      lifecycle.awaitingDestination === true
      || lifecycle.status === "waiting_for_destination"
      || destinationReadiness.status === "WAITING_FOR_DESTINATION"
      || outcome.status === "DESTINATION_LOADING"
      || outcome.code === "NAVIGATION_TRANSITION_PENDING"
      || result.failureCode === "NAVIGATION_TRANSITION_PENDING"
    )
  );
}

function progressFingerprint(page = {}) {
  return JSON.stringify(
    page.foreground?.progressMarkers
      || page.visualState?.foreground?.progressMarkers
      || page.progressMarkers
      || {}
  );
}

function destinationIdentity(observation = {}) {
  const page = observation.page || {};
  const surface = currentSurface(page);
  return Object.freeze({
    url: cleanIdentity(page.url || observation.url || ""),
    surfaceId: cleanIdentity(surface.id || ""),
    progressFingerprint: progressFingerprint(page)
  });
}

function destinationChangedFromOrigin(observation = {}, navigationContext = {}) {
  const origin = navigationContext.lifecycle?.origin || {};
  const current = destinationIdentity(observation);
  const evidence = [];
  if (origin.url && cleanIdentity(origin.url) !== current.url) evidence.push("url");
  if (origin.surfaceId && cleanIdentity(origin.surfaceId) !== current.surfaceId) evidence.push("surface");
  if (origin.progressFingerprint && origin.progressFingerprint !== current.progressFingerprint) evidence.push("progress");
  return Object.freeze({
    changed: evidence.length > 0,
    evidence: Object.freeze(evidence),
    origin: Object.freeze({
      url: cleanIdentity(origin.url || ""),
      surfaceId: cleanIdentity(origin.surfaceId || ""),
      progressFingerprint: origin.progressFingerprint || ""
    }),
    current
  });
}

function navigationShaped(observation = {}, previousReadiness = {}, navigationContext = {}) {
  const result = observation.lastActionResult || navigationContext.result || {};
  const feedback = result.feedback || navigationContext.feedback || {};
  const lifecycle = navigationContext.lifecycle || {};
  const explicitlyRejected = result.dispatched === false
    || lifecycle.dispatched === false
    || lifecycle.status === "rejected_before_dispatch";
  if (explicitlyRejected) return false;
  const dispatched = result.dispatched === true
    || lifecycle.dispatched === true
    || feedback.dispatched === true;
  if (!dispatched) return false;
  const browserObservedChange = feedback.navigationOccurred === true
    || feedback.pageChanged === true
    || feedback.surfaceChanged === true
    || result.navigationOccurred === true
    || result.pageChanged === true
    || result.surfaceChanged === true;
  const openDispatchedLifecycle = lifecycle.closed !== true && (
    lifecycle.awaitingDestination === true
    || lifecycle.status === "dispatched"
    || lifecycle.status === "waiting_for_destination"
  );
  return Boolean(
    browserObservedChange
    || openDispatchedLifecycle
  );
}
function readinessKey(observation = {}, navigationContext = {}) {
  const page = observation.page || {};
  const lifecycle = navigationContext.lifecycle || {};
  const result = observation.lastActionResult || navigationContext.result || {};
  const destinationReadiness = navigationContext.destinationReadiness || {};
  const action = result.action || navigationContext.action || navigationContext.originalAction || {};
  const surface = currentSurface(page);
  const actionId = cleanIdentity(
    lifecycle.actionId
    || destinationReadiness.actionId
    || result.actionId
    || action.id
    || "no-action"
  );
  if (actionId !== "no-action" && navigationSettlementPending(observation, navigationContext)) {
    return `navigation|${actionId}`;
  }
  return [
    actionId,
    cleanIdentity(page.url || observation.url || "same-route"),
    cleanIdentity(surface.id || "surface-page"),
    cleanIdentity(surface.type || "page")
  ].join("|");
}

function cleanIdentity(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function classifyObservationReadiness({
  observation = {},
  previousReadiness = {},
  navigationContext = {},
  readinessStartedAt = 0,
  readinessDeadlineAt = 0,
  nowMs = Date.now(),
  readinessTimeoutMs = DESTINATION_READINESS_TIMEOUT_MS
} = {}) {
  const page = observation.page || {};
  const facts = page.readiness || {};
  const afterNavigation = navigationShaped(observation, previousReadiness, navigationContext);
  const key = readinessKey(observation, navigationContext);
  const samePendingDestination = previousReadiness.key === key
    && afterNavigation
    && [READINESS.TRANSIENT, READINESS.UNRESOLVED, READINESS.DEGRADED].includes(previousReadiness.classification);
  const attempts = samePendingDestination ? Number(previousReadiness.attempts || 0) + 1 : 1;
  const suppliedStartedAt = Number(readinessStartedAt || 0);
  const startedAt = samePendingDestination
    ? Number(previousReadiness.startedAt || nowMs)
    : (suppliedStartedAt > 0 ? suppliedStartedAt : Number(nowMs));
  const suppliedDeadline = Number(readinessDeadlineAt || 0);
  const previousDeadline = samePendingDestination ? Number(previousReadiness.deadlineAt || 0) : 0;
  // The browser creates the settlement deadline when the original action is
  // dispatched. That action identity survives URL/document changes, and a
  // later loading observation must never replace or extend its deadline.
  const deadlineAt = previousDeadline > 0
    ? previousDeadline
    : (suppliedDeadline > 0
        ? suppliedDeadline
        : startedAt + Math.max(1, Number(readinessTimeoutMs || 0)));
  const deadlineExpired = Number(nowMs) >= deadlineAt;
  const controls = actionableControlCount(page);
  const loadingSignal = facts.ariaBusy === true
    || Number(facts.loadingIndicatorCount || 0) > 0
    || facts.loadingTextEvidence === true;
  const mainLoadingSignal = facts.mainAriaBusy === true
    || facts.loadingTextEvidence === true;
  const pendingSettlement = navigationSettlementPending(observation, navigationContext);
  const destinationChange = destinationChangedFromOrigin(observation, navigationContext);
  // An exact browser-owned navigation result remains authoritative while the
  // source document is still structurally the same. Source controls remaining
  // clickable is not proof that the destination arrived, and must not reopen
  // TaskState or permit the same stage exit to be planned again.
  const unsettledSource = pendingSettlement && destinationChange.changed !== true;
  // A local spinner is diagnostic when the current surface already exposes
  // executable mechanics. It becomes page-blocking only when no executable
  // surface exists or an exact dispatched navigation is still unsettled.
  const explicitLoading = facts.documentReadyState === "loading"
    || mainLoadingSignal
    || (loadingSignal && (controls === 0 || pendingSettlement));
  const usableForeground = foregroundReady(page) && !explicitLoading;
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
  const mechanicallyUsable = !explicitLoading && controls > 0;
  const temporarilyIncomplete = afterNavigation && !mechanicallyUsable;
  // Readiness owns only browser mechanics. Stage, field, commerce and payment
  // meaning belongs to DecisionFrame/TaskState and is deliberately absent.
  // Stability is diagnostic once a fresh current surface already exposes an
  // executable mechanic. Waiting solely for a quiet-time threshold creates a
  // lost-mutation race: the destination can become usable before the wait is
  // installed and then never mutate again. Only explicit loading or a truly
  // incomplete post-action surface may hold the controller.
  const transient = explicitLoading || temporarilyIncomplete || unsettledSource;
  const evidence = Object.freeze({
    controls,
    loadingSignal,
    mainLoadingSignal,
    pendingSettlement,
    unsettledSource,
    destinationChange,
    explicitLoading,
    mechanicallyUsable,
    temporarilyIncomplete,
    actionDispatched: afterNavigation,
    stable,
    facts
  });

  if (unsettledSource && !deadlineExpired) {
    return Object.freeze({
      classification: READINESS.TRANSIENT,
      key,
      attempts,
      startedAt,
      deadlineAt,
      elapsedMs: Math.max(0, Number(nowMs) - startedAt),
      remainingMs: Math.max(0, deadlineAt - Number(nowMs)),
      deadlineExpired,
      reason: "NAVIGATION_ACTION_STILL_UNSETTLED",
      handoffEligible: false,
      evidence
    });
  }

  if (unsettledSource) {
    // The lease, not TaskState, owns this deadline. Once it expires, hand the
    // unchanged source back to ActionLifecycle so bounded recovery can record
    // a no-effect result and choose a distinct proven strategy. Do not create
    // an unbounded destination wait or require a manual restart.
    return Object.freeze({
      classification: READINESS.READY,
      key,
      attempts,
      startedAt,
      deadlineAt,
      elapsedMs: Math.max(0, Number(nowMs) - startedAt),
      remainingMs: 0,
      deadlineExpired: true,
      reason: "NAVIGATION_SETTLEMENT_DEADLINE_EXPIRED",
      handoffEligible: true,
      evidence
    });
  }

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
        : temporarilyIncomplete
          ? "POST_ACTION_SURFACE_TEMPORARILY_INCOMPLETE"
          : "POST_ACTION_SURFACE_SETTLING",
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
      : (mechanicallyUsable ? "STABLE_USABLE_OBSERVATION" : "OBSERVATION_STABLE"),
    handoffEligible: false,
    evidence
  });
}

module.exports = {
  READINESS,
  DESTINATION_READINESS_TIMEOUT_MS,
  MIN_DESTINATION_STABLE_MS,
  classifyObservationReadiness,
  navigationShaped,
  readinessKey
};
