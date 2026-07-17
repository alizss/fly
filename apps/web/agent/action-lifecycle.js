const { evaluateTransition } = require("./transition-evaluator");

const MAX_GROUNDING_RECOVERY_ATTEMPTS = 3;
const MAX_EXECUTION_RECOVERY_ATTEMPTS = 3;

const FAILURE_CODE_ALIASES = Object.freeze({
  TARGET_OUTSIDE_FOREGROUND: "TARGET_OUTSIDE_CURRENT_SURFACE"
});

const UNSAFE_FAILURE_CODES = new Set([
  "POLICY_BLOCKED",
  "BLOCKED_BY_POLICY",
  "BLOCKED_BY_SAFETY",
  "PAYMENT_AUTHORIZATION_REQUIRED",
  "DUPLICATE_PAYMENT_ATTEMPT",
  "ITINERARY_ROUTE_CHANGED",
  "ITINERARY_DATE_CHANGED",
  "ITINERARY_TIME_CHANGED",
  "ITINERARY_FLIGHT_CHANGED",
  "TRAVELER_CHANGED",
  "CURRENCY_CHANGED",
  "PRICE_INCREASE_REQUIRES_AUTHORIZATION"
]);

function canonicalFailureCode(result = {}) {
  const raw = String(result.outcome?.code || result.failureCode || result.code || "");
  return FAILURE_CODE_ALIASES[raw] || raw;
}

function wasDispatched(result = {}) {
  return result.dispatched === true || result.executed === true;
}

function proposeActionLifecycle(action = {}, observation = {}) {
  return {
    actionId: action.id || "",
    observationId: action.observationId || observation.observationId || "",
    candidateId: action.candidateId || "",
    status: "proposed",
    approved: false,
    dispatched: false,
    observed: false,
    verified: false,
    resultCode: "",
    transitionStatus: ""
  };
}

function approveActionLifecycle(lifecycle = {}) {
  return { ...lifecycle, status: "approved", approved: true, resultCode: "ALLOWED" };
}

function rejectActionLifecycle(lifecycle = {}, result = {}) {
  return {
    ...lifecycle,
    status: result.decision === "recoverable" ? "rejected_before_dispatch" : "unsafe",
    approved: false,
    dispatched: false,
    observed: false,
    verified: false,
    resultCode: canonicalFailureCode(result) || "GOVERNOR_REJECTED"
  };
}

function applyRecoveryBudget(state = {}, result = {}) {
  const dispatched = wasDispatched(result);
  const code = canonicalFailureCode(result);
  let groundingRecoveryAttempts = Number(state.groundingRecoveryAttempts || state.staleRecoveryAttempts || 0);
  let executionRecoveryAttempts = Number(state.executionRecoveryAttempts || 0);
  let classification = "none";
  if (!dispatched && code && !UNSAFE_FAILURE_CODES.has(code)) {
    groundingRecoveryAttempts += 1;
    classification = "grounding_replan";
  } else if (dispatched && result.verified === false) {
    executionRecoveryAttempts += 1;
    classification = "execution_strategy";
  } else if (dispatched && result.verified === true) {
    groundingRecoveryAttempts = 0;
    executionRecoveryAttempts = 0;
    classification = "verified_success";
  }
  return {
    state: {
      ...state,
      groundingRecoveryAttempts,
      staleRecoveryAttempts: groundingRecoveryAttempts,
      executionRecoveryAttempts
    },
    classification,
    code,
    dispatched,
    groundingRecoveryAttempts,
    executionRecoveryAttempts,
    exhausted: groundingRecoveryAttempts > MAX_GROUNDING_RECOVERY_ATTEMPTS
      || executionRecoveryAttempts > MAX_EXECUTION_RECOVERY_ATTEMPTS
  };
}

function lifecycleAction(state = {}, result = {}) {
  const resultAction = result.action || {};
  if (state.lastAction?.id && state.lastAction.id === result.actionId) return state.lastAction;
  if (state.pendingAction?.action?.id && state.pendingAction.action.id === result.actionId) return state.pendingAction.action;
  return {
    ...resultAction,
    id: result.actionId || resultAction.id || "",
    expectedOutcome: result.expectedOutcome || resultAction.expectedOutcome || null
  };
}

function baseLifecycle(state = {}, observation = {}, action = {}, result = {}) {
  const previous = state.actionLifecycle || {};
  const sameAction = previous.actionId && previous.actionId === (result.actionId || action.id);
  return {
    actionId: result.actionId || action.id || previous.actionId || "",
    observationId: action.observationId || result.observationId || previous.observationId || "",
    candidateId: action.candidateId || state.pendingAction?.candidateId || previous.candidateId || "",
    status: sameAction ? previous.status : "proposed",
    approved: sameAction ? previous.approved === true : true,
    dispatched: sameAction ? previous.dispatched === true : false,
    observed: sameAction ? previous.observed === true : false,
    verified: sameAction ? previous.verified === true : false,
    resultCode: canonicalFailureCode(result),
    transitionStatus: sameAction ? previous.transitionStatus || "" : "",
    resultObservationId: observation.observationId || ""
  };
}

function transitionResult(result = {}, transition = null) {
  if (!transition) return { ...result, failureCode: canonicalFailureCode(result) };
  return {
    ...result,
    failureCode: transition.status === "no_effect"
      ? "TRANSITION_NO_EFFECT"
      : canonicalFailureCode(result),
    transitionStatus: transition.status,
    transitionDirective: transition.nextDirective,
    transition,
    postconditionSatisfied: transition.status === "achieved",
    expectedOutcomeObserved: transition.status === "achieved",
    verified: transition.status === "achieved"
  };
}

function advanceActionLifecycle({ state = {}, observation = {}, previousObservation = null } = {}) {
  const result = observation.lastActionResult || {};
  if (!result.actionId) return { state, observation, lifecycle: null, transition: null, directive: "continue" };

  const action = lifecycleAction(state, result);
  if (["wait", "ask_user", "stop", "final_review"].includes(action.type || action.action)) {
    return { state, observation, lifecycle: null, transition: null, directive: "continue" };
  }

  const dispatched = wasDispatched(result);
  const code = canonicalFailureCode(result);
  let groundingRecoveryAttempts = Number(state.groundingRecoveryAttempts || state.staleRecoveryAttempts || 0);
  let executionRecoveryAttempts = Number(state.executionRecoveryAttempts || 0);
  let lifecycle = baseLifecycle(state, observation, action, result);
  let transition = null;
  let directive = "continue";

  if (!dispatched) {
    const unsafe = UNSAFE_FAILURE_CODES.has(code);
    if (unsafe) {
      lifecycle = { ...lifecycle, status: "unsafe", resultCode: code };
      directive = "stop_for_safety";
    } else {
      groundingRecoveryAttempts += 1;
      lifecycle = { ...lifecycle, status: "rejected_before_dispatch", resultCode: code || "PRE_DISPATCH_REJECTION" };
      directive = groundingRecoveryAttempts > MAX_GROUNDING_RECOVERY_ATTEMPTS
        ? "handoff_recovery_exhausted"
        : "rebuild_candidates";
    }
  } else if (!previousObservation?.observationId || !observation.observationId) {
    lifecycle = { ...lifecycle, status: "dispatched", dispatched: true, resultCode: code };
    directive = "reobserve_rebind";
  } else {
    transition = evaluateTransition({
      beforeObservation: previousObservation,
      governedAction: action,
      browserResult: { ...result, failureCode: code },
      afterObservation: observation
    });
    const observed = true;
    if (transition.status === "achieved") {
      groundingRecoveryAttempts = 0;
      executionRecoveryAttempts = 0;
      lifecycle = { ...lifecycle, status: "verified", dispatched: true, observed, verified: true, transitionStatus: "achieved", resultCode: code };
      directive = "advance_goal";
    } else if (transition.status === "progressed") {
      groundingRecoveryAttempts = 0;
      lifecycle = { ...lifecycle, status: "observed", dispatched: true, observed, verified: false, transitionStatus: "progressed", resultCode: code };
      directive = "rebuild_candidates";
    } else if (transition.status === "blocked") {
      lifecycle = { ...lifecycle, status: "observed", dispatched: true, observed, verified: false, transitionStatus: "blocked", resultCode: code };
      directive = "resolve_blocker";
    } else if (transition.status === "no_effect") {
      executionRecoveryAttempts += 1;
      lifecycle = { ...lifecycle, status: "failed", dispatched: true, observed, verified: false, transitionStatus: "no_effect", resultCode: "TRANSITION_NO_EFFECT" };
      directive = executionRecoveryAttempts > MAX_EXECUTION_RECOVERY_ATTEMPTS
        ? "handoff_recovery_exhausted"
        : "try_distinct_capability";
    } else if (transition.status === "unsafe") {
      lifecycle = { ...lifecycle, status: "unsafe", dispatched: true, observed, verified: false, transitionStatus: "unsafe", resultCode: code };
      directive = "stop_for_safety";
    } else {
      lifecycle = { ...lifecycle, status: "observed", dispatched: true, observed, verified: false, transitionStatus: "uncertain", resultCode: code };
      directive = "reobserve_rebind";
    }
  }

  const nextState = {
    ...state,
    actionLifecycle: lifecycle,
    groundingRecoveryAttempts,
    staleRecoveryAttempts: groundingRecoveryAttempts,
    executionRecoveryAttempts
  };
  return {
    state: nextState,
    observation: { ...observation, lastActionResult: transitionResult(result, transition), transitionEvaluation: transition || undefined },
    lifecycle,
    transition,
    directive,
    exhausted: directive === "handoff_recovery_exhausted"
  };
}

module.exports = {
  MAX_EXECUTION_RECOVERY_ATTEMPTS,
  MAX_GROUNDING_RECOVERY_ATTEMPTS,
  approveActionLifecycle,
  applyRecoveryBudget,
  advanceActionLifecycle,
  canonicalFailureCode,
  proposeActionLifecycle,
  rejectActionLifecycle,
  wasDispatched
};
