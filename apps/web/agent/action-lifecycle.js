const { evaluateTransition } = require("./transition-evaluator");
const { actuatorSignature } = require("../../../packages/shared/agent-actions");

const MAX_RECOVERY_ATTEMPTS = 3;
const PENDING_ACTION_SCHEMA_VERSION = 2;

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

function pendingActionRecord({ action = {}, candidate = null, goal = {}, status = "ready", recoveryAttempts = 0 } = {}) {
  return {
    schemaVersion: PENDING_ACTION_SCHEMA_VERSION,
    originalAction: action,
    semanticGoal: goal,
    semanticGoalId: action.goalId || goal.goalId || "",
    candidateId: action.candidateId || candidate?.candidateId || "",
    candidateStableKey: candidate?.affordance?.stableKey || candidate?.stableKey || action.affordance?.stableKey || "",
    capability: candidate?.operation || action.operation || action.type || "",
    expectedOutcome: action.expectedOutcome || candidate?.expectedOutcome || null,
    status,
    sourceObservationId: action.observationId || "",
    sourceObservationHash: action.observationHash || "",
    recoveryAttempts: Number(recoveryAttempts || 0),
    candidate,
    createdAt: new Date().toISOString()
  };
}

function normalizePendingAction(pending = null) {
  if (!pending || typeof pending !== "object") return null;
  if (pending.schemaVersion === PENDING_ACTION_SCHEMA_VERSION && pending.originalAction?.id) return pending;
  // One-way durable-session migration. Runtime code only emits v2 records.
  const action = pending.action || pending.recoveryOfAction || {};
  return pendingActionRecord({
    action: { ...action, id: pending.actionId || action.id || "" },
    candidate: pending.candidate || null,
    goal: pending.goal || { goalId: pending.goalId || "" },
    status: pending.type === "viewport_rebind" || pending.status === "viewport_recovery" || pending.status === "rebind"
      ? "needs_reveal"
      : (pending.status === "approved" ? "ready" : (pending.status || "ready")),
    recoveryAttempts: Number(pending.recoveryAttempts || pending.recoveryCount || 0)
  });
}

function pendingActionNeedsResult(state = {}, observation = {}) {
  const pending = normalizePendingAction(state.pendingAction);
  const actionId = pending?.originalAction?.id || "";
  if (!actionId || pending.status === "needs_reveal") return false;
  return String(observation.lastActionResult?.actionId || "") !== actionId;
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

function recoveryStateFor(state = {}) {
  const existing = state.recoveryState || {};
  const migratedAttempts = Math.max(
    Number(state.groundingRecoveryAttempts || state.staleRecoveryAttempts || 0),
    Number(state.executionRecoveryAttempts || 0),
    Number(state.uncertainTransitionCount || 0)
  );
  return {
    attempts: Number(existing.attempts ?? migratedAttempts),
    phase: String(existing.phase || "idle"),
    stateHash: String(existing.stateHash || state.unchangedStateHash || ""),
    failedStrategySignatures: [...(existing.failedStrategySignatures || state.unchangedStateFailedStrategySignatures || [])],
    lastCode: String(existing.lastCode || ""),
    lastRevealSample: existing.lastRevealSample || null,
    updatedAt: existing.updatedAt || ""
  };
}

function stateWithRecovery(state = {}, recoveryState = {}) {
  const {
    groundingRecoveryAttempts: _groundingRecoveryAttempts,
    staleRecoveryAttempts: _staleRecoveryAttempts,
    executionRecoveryAttempts: _executionRecoveryAttempts,
    uncertainTransitionCount: _uncertainTransitionCount,
    unchangedStateHash: _unchangedStateHash,
    unchangedStateFailedStrategySignatures: _unchangedStateFailedStrategySignatures,
    ...rest
  } = state;
  return { ...rest, recoveryState };
}

function updateRecoveryState(state = {}, event = {}) {
  const previous = recoveryStateFor(state);
  const next = { ...previous, updatedAt: new Date().toISOString() };
  const kind = String(event.kind || "none");
  const code = String(event.code || "");
  let classification = "none";

  if (["verified", "meaningful_progress"].includes(kind)) {
    next.attempts = 0;
    next.phase = kind;
    next.stateHash = "";
    next.failedStrategySignatures = [];
    next.lastCode = code;
    next.lastRevealSample = null;
    classification = kind;
  } else if (["grounding_rejection", "planner_rejection"].includes(kind)) {
    next.phase = kind;
    next.lastCode = code;
    classification = kind;
  } else if (kind === "reveal_started") {
    next.phase = "reveal";
    next.lastCode = code;
    next.lastRevealSample = event.sample || null;
    classification = "reveal_started";
  } else if (kind === "reveal") {
    next.phase = "reveal";
    next.lastCode = code;
    next.lastRevealSample = event.sample || null;
    next.attempts = event.measurableProgress === true ? 0 : previous.attempts + 1;
    classification = event.measurableProgress === true ? "reveal_progress" : "reveal_no_effect";
  } else if (kind === "execution_no_effect") {
    const stateHash = String(event.stateHash || "");
    const signatures = stateHash && stateHash !== previous.stateHash
      ? []
      : [...previous.failedStrategySignatures];
    if (event.strategySignature && !signatures.includes(event.strategySignature)) signatures.push(event.strategySignature);
    next.phase = "execution_no_effect";
    next.stateHash = stateHash || previous.stateHash;
    next.failedStrategySignatures = signatures;
    next.attempts = signatures.length || previous.attempts + 1;
    next.lastCode = code || "TRANSITION_NO_EFFECT";
    classification = "execution_no_effect";
  } else if (kind === "uncertain") {
    next.phase = "uncertain";
    next.attempts = previous.attempts + 1;
    next.lastCode = code;
    classification = "uncertain";
  }

  return {
    state: stateWithRecovery(state, next),
    recoveryState: next,
    classification,
    code,
    exhausted: next.attempts >= MAX_RECOVERY_ATTEMPTS
  };
}

function recoverBeforeDispatch({ state = {}, action = {}, code = "PRE_DISPATCH_REJECTION" } = {}) {
  const recovery = updateRecoveryState(state, { kind: "grounding_rejection", code });
  const lifecycle = {
    ...proposeActionLifecycle(action, { observationId: action.observationId || "" }),
    status: "rejected_before_dispatch",
    resultCode: recovery.code || code
  };
  return {
    ...recovery,
    state: {
      ...recovery.state,
      actionLifecycle: lifecycle
    },
    lifecycle,
    directive: "rebuild_candidates"
  };
}

function lifecycleAction(state = {}, result = {}) {
  const resultAction = result.action || {};
  if (state.lastAction?.id && state.lastAction.id === result.actionId) return state.lastAction;
  const pending = normalizePendingAction(state.pendingAction);
  if (pending?.originalAction?.id === result.actionId) return pending.originalAction;
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
    candidateId: action.candidateId || normalizePendingAction(state.pendingAction)?.candidateId || previous.candidateId || "",
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
  let recovery = { state, recoveryState: recoveryStateFor(state), exhausted: false };
  let lifecycle = baseLifecycle(state, observation, action, result);
  let transition = null;
  let directive = "continue";

  if (!dispatched) {
    const unsafe = UNSAFE_FAILURE_CODES.has(code);
    if (unsafe) {
      lifecycle = { ...lifecycle, status: "unsafe", resultCode: code };
      directive = "stop_for_safety";
    } else {
      recovery = updateRecoveryState(state, { kind: "grounding_rejection", code: code || "PRE_DISPATCH_REJECTION" });
      lifecycle = { ...lifecycle, status: "rejected_before_dispatch", resultCode: code || "PRE_DISPATCH_REJECTION" };
      directive = "rebuild_candidates";
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
      recovery = updateRecoveryState(state, { kind: "verified", code });
      lifecycle = { ...lifecycle, status: "verified", dispatched: true, observed, verified: true, transitionStatus: "achieved", resultCode: code };
      directive = "advance_goal";
    } else if (transition.status === "progressed") {
      recovery = updateRecoveryState(state, { kind: "meaningful_progress", code });
      lifecycle = { ...lifecycle, status: "observed", dispatched: true, observed, verified: false, transitionStatus: "progressed", resultCode: code };
      directive = "rebuild_candidates";
    } else if (transition.status === "blocked") {
      recovery = updateRecoveryState(state, { kind: "meaningful_progress", code });
      lifecycle = { ...lifecycle, status: "observed", dispatched: true, observed, verified: false, transitionStatus: "blocked", resultCode: code };
      directive = "resolve_blocker";
    } else if (transition.status === "no_effect") {
      const revealAction = action.type === "scroll" || action.intent === "recover_target_viewport";
      if (revealAction) {
        lifecycle = { ...lifecycle, status: "observed", dispatched: true, observed, verified: false, transitionStatus: "no_effect", resultCode: "TRANSITION_NO_EFFECT" };
        directive = "reobserve_rebind";
      } else {
      const stateHash = String(
        observation.observationSnapshot?.snapshotHash
        || observation.page?.snapshotHash
        || previousObservation?.observationSnapshot?.snapshotHash
        || previousObservation?.page?.snapshotHash
        || ""
      );
      const signature = actuatorSignature(action);
      recovery = updateRecoveryState(state, {
        kind: "execution_no_effect",
        code: "TRANSITION_NO_EFFECT",
        stateHash,
        strategySignature: signature
      });
      lifecycle = { ...lifecycle, status: "failed", dispatched: true, observed, verified: false, transitionStatus: "no_effect", resultCode: "TRANSITION_NO_EFFECT" };
      directive = recovery.exhausted
        ? "handoff_recovery_exhausted"
        : "try_distinct_capability";
      }
    } else if (transition.status === "unsafe") {
      lifecycle = { ...lifecycle, status: "unsafe", dispatched: true, observed, verified: false, transitionStatus: "unsafe", resultCode: code };
      directive = "stop_for_safety";
    } else {
      recovery = updateRecoveryState(state, { kind: "uncertain", code });
      lifecycle = { ...lifecycle, status: "observed", dispatched: true, observed, verified: false, transitionStatus: "uncertain", resultCode: code };
      directive = recovery.exhausted ? "handoff_recovery_exhausted" : "reobserve_rebind";
    }
  }

  const nextState = { ...recovery.state, actionLifecycle: lifecycle };
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
  MAX_RECOVERY_ATTEMPTS,
  approveActionLifecycle,
  advanceActionLifecycle,
  canonicalFailureCode,
  normalizePendingAction,
  pendingActionNeedsResult,
  pendingActionRecord,
  PENDING_ACTION_SCHEMA_VERSION,
  proposeActionLifecycle,
  recoverBeforeDispatch,
  recoveryStateFor,
  rejectActionLifecycle,
  updateRecoveryState,
  wasDispatched
};
