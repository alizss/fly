const { evaluateTransition } = require("./transition-evaluator");
const { decideStage } = require("./task-state-reducer");
const { actuatorSignature, decisionInstanceKey } = require("../../../packages/shared/agent-actions");

const MAX_RECOVERY_ATTEMPTS = 3;
const PENDING_ACTION_SCHEMA_VERSION = 2;

const FAILURE_CODE_ALIASES = Object.freeze({
  TARGET_OUTSIDE_FOREGROUND: "TARGET_OUTSIDE_CURRENT_SURFACE"
});

const UNSAFE_FAILURE_CODES = new Set([
  "PAYMENT_AUTHORIZATION_REQUIRED",
  "DUPLICATE_PAYMENT_ATTEMPT",
  "ITINERARY_ROUTE_CHANGED",
  "ITINERARY_DATE_CHANGED",
  "ITINERARY_TIME_CHANGED",
  "ITINERARY_FLIGHT_CHANGED",
  "TRAVELER_CHANGED",
  "CURRENCY_CHANGED"
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

function navigationAction(action = {}) {
  const effect = String(
    action.mechanicalEffect
      || action.physicalEffect
      || action.affordance?.mechanicalEffect
      || action.affordance?.physicalEffect
      || action.affordance?.effect
      || ""
  ).toLowerCase();
  const expected = String(action.expectedOutcome?.type || "").toLowerCase();
  const intent = String(`${action.intent || ""} ${action.semanticIntent || ""}`).toLowerCase();
  return /advance_surface|advance_checkout_stage/.test(effect)
    || /current_surface_advanced|checkout_stage_advanced|stage_exit/.test(expected)
    || /navigate|advance|continue|next/.test(intent);
}

function progressFingerprint(observation = {}) {
  const page = observation.page || {};
  return JSON.stringify(
    page.foreground?.progressMarkers
      || page.visualState?.foreground?.progressMarkers
      || page.progressMarkers
      || {}
  );
}

function navigationOrigin(observation = {}) {
  const page = observation.page || {};
  return Object.freeze({
    observationId: observation.observationId || "",
    stage: decideStage(observation).stage,
    step: page.step || page.pageStep || "unknown",
    url: page.url || observation.url || "",
    surfaceId: (page.currentSurface || page.activeSurface || {}).id || "",
    progressFingerprint: progressFingerprint(observation)
  });
}

function proposeActionLifecycle(action = {}, observation = {}) {
  const isNavigation = navigationAction(action);
  return {
    actionId: action.id || "",
    observationId: action.observationId || observation.observationId || "",
    candidateId: action.candidateId || "",
    status: "proposed",
    approved: false,
    dispatched: false,
    observed: false,
    verified: false,
    closed: false,
    awaitingClarification: false,
    awaitingDestination: false,
    navigation: isNavigation,
    origin: isNavigation ? navigationOrigin(observation) : null,
    destinationReadiness: null,
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
    closed: true,
    awaitingClarification: false,
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
    outcomeId: String(existing.outcomeId || ""),
    decisionInstanceId: String(existing.decisionInstanceId || ""),
    transitionTrail: [...(existing.transitionTrail || [])].slice(-12),
    updatedAt: existing.updatedAt || ""
  };
}

function semanticStateKey(observation = {}) {
  const page = observation.page || {};
  const surface = page.currentSurface || page.activeSurface || page.foreground || {};
  const progress = page.foreground?.progressMarkers || page.visualState?.foreground?.progressMarkers || {};
  return JSON.stringify({
    stage: page.step || "unknown",
    surfaceType: surface.type || "page",
    surfaceClass: surface.surfaceClass || "unknown",
    taskHint: surface.taskHint || "",
    label: String(surface.label || "").replace(/\s+/g, " ").trim().slice(0, 120).toLowerCase(),
    progress
  });
}

function registerParentTransition(state = {}, action = {}, transition = {}, beforeObservation = {}, afterObservation = {}) {
  const outcomeId = String(transition.parentProgress?.outcomeId || "");
  if (!outcomeId || transition.parentProgress?.completed === true) return state;
  const recovery = recoveryStateFor(state);
  const from = semanticStateKey(beforeObservation);
  const to = semanticStateKey(afterObservation);
  const strategySignature = actuatorSignature(action);
  const priorTrail = recovery.outcomeId === outcomeId ? recovery.transitionTrail : [];
  const prior = priorTrail[priorTrail.length - 1] || null;
  const cycle = Boolean(prior && prior.from === to && prior.to === from && from !== to);
  const failedStrategySignatures = [...recovery.failedStrategySignatures];
  if (cycle) {
    for (const signature of [prior.strategySignature, strategySignature]) {
      if (signature && !failedStrategySignatures.includes(signature)) failedStrategySignatures.push(signature);
    }
  }
  const transitionTrail = [...priorTrail, {
    from,
    to,
    strategySignature,
    parentProgress: transition.parentProgress.status
  }].slice(-12);
  return stateWithRecovery(state, {
    ...recovery,
    outcomeId,
    transitionTrail,
    failedStrategySignatures,
    attempts: cycle ? Math.max(recovery.attempts + 1, failedStrategySignatures.length) : recovery.attempts,
    phase: cycle ? "parent_cycle" : recovery.phase,
    lastCode: cycle ? "PARENT_OUTCOME_CYCLE" : recovery.lastCode,
    updatedAt: new Date().toISOString()
  });
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
    next.decisionInstanceId = "";
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
    const decisionInstanceId = String(event.decisionInstanceId || "");
    const sameDecisionInstance = Boolean(
      decisionInstanceId
      && previous.decisionInstanceId
      && decisionInstanceId === previous.decisionInstanceId
    );
    const signatures = !sameDecisionInstance || (stateHash && stateHash !== previous.stateHash)
      ? []
      : [...previous.failedStrategySignatures];
    if (event.strategySignature && !signatures.includes(event.strategySignature)) signatures.push(event.strategySignature);
    next.phase = "execution_no_effect";
    next.stateHash = stateHash || previous.stateHash;
    next.decisionInstanceId = decisionInstanceId;
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
    closed: sameAction ? previous.closed === true : false,
    awaitingClarification: sameAction ? previous.awaitingClarification === true : false,
    awaitingDestination: sameAction ? previous.awaitingDestination === true : false,
    navigation: sameAction ? previous.navigation === true : navigationAction(action),
    origin: sameAction && previous.origin
      ? previous.origin
      : (navigationAction(action) ? navigationOrigin({ page: result.beforePage || {}, observationId: action.observationId || "" }) : null),
    destinationReadiness: sameAction ? previous.destinationReadiness || null : null,
    resultCode: canonicalFailureCode(result),
    transitionStatus: sameAction ? previous.transitionStatus || "" : "",
    resultObservationId: observation.observationId || ""
  };
}

function transitionResult(result = {}, transition = null) {
  if (!transition) return { ...result, failureCode: canonicalFailureCode(result) };
  const interveningMutation = transition.causality?.classification === "intervening_external_mutation";
  return {
    ...result,
    failureCode: interveningMutation
      ? "INTERVENING_EXTERNAL_MUTATION"
      : transition.status === "no_effect"
      ? "TRANSITION_NO_EFFECT"
      : canonicalFailureCode(result),
    transitionStatus: transition.status,
    transitionDirective: transition.nextDirective,
    transition,
    localMechanicalResult: transition.localMechanicalResult || transition.localEffect || null,
    currentObligationResult: transition.currentObligationResult || null,
    durableObjectiveProgress: transition.durableObjectiveProgress || transition.parentProgress || null,
    localEffect: transition.localEffect || transition.physicalResult || null,
    physicalResult: transition.physicalResult || null,
    physicalEffectVerified: transition.localEffect?.verified === true || transition.physicalResult?.verified === true,
    parentProgress: transition.parentProgress || null,
    taskOutcome: transition.taskOutcome || "",
    taskOutcomeCompleted: (transition.durableObjectiveProgress || transition.parentProgress)?.completed === true,
    completionAuthority: "task_state",
    postconditionSatisfied: transition.status === "achieved",
    expectedOutcomeObserved: transition.status === "achieved",
    verified: transition.status === "achieved"
  };
}

function advanceActionLifecycle({
  state = {},
  observation = {},
  previousObservation = null,
  observationReadiness = null
} = {}) {
  const result = observation.lastActionResult || {};
  if (!result.actionId) return { state, observation, lifecycle: null, transition: null, directive: "continue" };

  const action = lifecycleAction(state, result);
  if (["wait", "ask_user", "stop", "final_review"].includes(action.type || action.action)) {
    return { state, observation, lifecycle: null, transition: null, directive: "continue" };
  }

  const previousLifecycle = state.actionLifecycle || {};
  const samePreviouslyObservedAction = Boolean(
    previousLifecycle.actionId
    && previousLifecycle.actionId === (result.actionId || action.id)
  );
  const dispatched = wasDispatched(result);
  const isNavigation = previousLifecycle.navigation === true || navigationAction(action);
  const destinationPending = isNavigation
    && dispatched
    && previousLifecycle.closed !== true
    && ["TRANSIENT", "DEGRADED"].includes(String(observationReadiness?.classification || ""))
    && observationReadiness?.handoffEligible !== true;
  if (destinationPending) {
    const lifecycle = {
      ...baseLifecycle(state, observation, action, result),
      status: "waiting_for_destination",
      approved: true,
      dispatched: true,
      observed: true,
      verified: false,
      closed: false,
      awaitingClarification: false,
      awaitingDestination: true,
      navigation: true,
      origin: previousLifecycle.origin
        || navigationOrigin(previousObservation || { page: result.beforePage || {}, observationId: action.observationId || "" }),
      destinationReadiness: observationReadiness,
      resultObservationId: observation.observationId || "",
      resultCode: canonicalFailureCode(result)
    };
    return {
      state: { ...state, actionLifecycle: lifecycle },
      observation: {
        ...observation,
        lastActionResult: {
          ...result,
          transitionStatus: "waiting_for_destination",
          destinationReadiness: observationReadiness
        }
      },
      lifecycle,
      transition: null,
      directive: "reobserve_destination",
      exhausted: false
    };
  }
  // An action owns exactly one immediate result window. A repeated action
  // token on a later observation cannot make that already-closed action
  // succeed or fail retroactively; the latest page is consumed as fresh
  // TaskState input instead.
  if (samePreviouslyObservedAction && previousLifecycle.closed === true) {
    return {
      state,
      observation: {
        ...observation,
        lastActionResult: {
          ...result,
          causalWindowClosed: true,
          causality: {
            classification: "external_or_current_state",
            code: "ACTION_CAUSAL_WINDOW_CLOSED",
            actionId: result.actionId || action.id || ""
          }
        }
      },
      lifecycle: null,
      transition: null,
      directive: "continue"
    };
  }
  // An unclear immediate result gets one fresh read. That read rebuilds the
  // current state, but is not attributed to the old action because another
  // site/user mutation may have happened after dispatch.
  if (
    samePreviouslyObservedAction
    && previousLifecycle.awaitingClarification === true
    && previousLifecycle.awaitingDestination !== true
  ) {
    const lifecycle = {
      ...previousLifecycle,
      status: "observed",
      observed: true,
      verified: false,
      closed: true,
      awaitingClarification: false,
      resultObservationId: observation.observationId || "",
      resultCode: "ACTION_RESULT_UNCLEAR_AFTER_REOBSERVE",
      transitionStatus: "uncertain"
    };
    return {
      state: { ...state, actionLifecycle: lifecycle },
      observation: {
        ...observation,
        lastActionResult: {
          ...result,
          verified: false,
          failureCode: "ACTION_RESULT_UNCLEAR_AFTER_REOBSERVE",
          causalWindowClosed: true
        }
      },
      lifecycle,
      transition: null,
      directive: "rebuild_candidates",
      exhausted: false
    };
  }

  const code = canonicalFailureCode(result);
  let recovery = { state, recoveryState: recoveryStateFor(state), exhausted: false };
  let lifecycle = baseLifecycle(state, observation, action, result);
  let transition = null;
  let directive = "continue";

  if (!dispatched) {
    const unsafe = UNSAFE_FAILURE_CODES.has(code);
    if (unsafe) {
      lifecycle = { ...lifecycle, status: "unsafe", closed: true, awaitingClarification: false, resultCode: code };
      directive = "stop_for_safety";
    } else {
      recovery = updateRecoveryState(state, { kind: "grounding_rejection", code: code || "PRE_DISPATCH_REJECTION" });
      lifecycle = { ...lifecycle, status: "rejected_before_dispatch", closed: true, awaitingClarification: false, resultCode: code || "PRE_DISPATCH_REJECTION" };
      directive = "rebuild_candidates";
    }
  } else if (!previousObservation?.observationId || !observation.observationId) {
    lifecycle = {
      ...lifecycle,
      status: "dispatched",
      dispatched: true,
      closed: false,
      awaitingClarification: true,
      resultCode: code
    };
    directive = "reobserve_rebind";
  } else {
    transition = evaluateTransition({
      beforeObservation: previousObservation,
      governedAction: action,
      browserResult: { ...result, failureCode: code },
      afterObservation: observation,
      navigationContext: isNavigation
        ? {
          destinationReady: observationReadiness?.classification === "READY",
          readiness: observationReadiness,
          origin: previousLifecycle.origin
            || lifecycle.origin
            || navigationOrigin(previousObservation)
        }
        : null
    });
    const observed = true;
    if (transition.status === "achieved") {
      recovery = updateRecoveryState(state, { kind: "verified", code });
      lifecycle = { ...lifecycle, status: "verified", dispatched: true, observed, verified: true, closed: true, awaitingClarification: false, awaitingDestination: false, destinationReadiness: observationReadiness, transitionStatus: "achieved", resultCode: code };
      directive = "advance_goal";
    } else if (transition.status === "progressed") {
      recovery = updateRecoveryState(state, { kind: "meaningful_progress", code });
      lifecycle = { ...lifecycle, status: "observed", dispatched: true, observed, verified: false, closed: true, awaitingClarification: false, awaitingDestination: false, destinationReadiness: observationReadiness, transitionStatus: "progressed", resultCode: code };
      directive = "rebuild_candidates";
    } else if (transition.status === "blocked") {
      const rebuildFromCurrentState = transition.nextDirective === "rebuild_task_state";
      const reconciliationCode = rebuildFromCurrentState
        ? (transition.causality?.code || "FRESH_STATE_RECONCILIATION_REQUIRED")
        : code;
      recovery = updateRecoveryState(state, {
        kind: "meaningful_progress",
        code: reconciliationCode
      });
      lifecycle = {
        ...lifecycle,
        status: "observed",
        dispatched: true,
        observed,
        verified: false,
        closed: true,
        awaitingClarification: false,
        transitionStatus: "blocked",
        resultCode: reconciliationCode
      };
      directive = rebuildFromCurrentState ? "rebuild_candidates" : "resolve_blocker";
    } else if (transition.status === "no_effect") {
      const revealAction = action.type === "scroll" || action.intent === "recover_target_viewport";
      if (revealAction) {
        lifecycle = { ...lifecycle, status: "observed", dispatched: true, observed, verified: false, closed: true, awaitingClarification: false, transitionStatus: "no_effect", resultCode: "TRANSITION_NO_EFFECT" };
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
      const decisionInstanceId = action.decisionInstanceId
        || decisionInstanceKey(action, previousObservation || observation);
      recovery = updateRecoveryState(state, {
        kind: "execution_no_effect",
        code: "TRANSITION_NO_EFFECT",
        stateHash,
        strategySignature: signature,
        decisionInstanceId
      });
      lifecycle = { ...lifecycle, status: "failed", dispatched: true, observed, verified: false, closed: true, awaitingClarification: false, transitionStatus: "no_effect", resultCode: "TRANSITION_NO_EFFECT" };
      // A finite no-effect budget suppresses repeated strategies, but it does
      // not justify a handoff while another safe grounded capability exists.
      directive = "try_distinct_capability";
      }
    } else if (transition.status === "unsafe") {
      lifecycle = { ...lifecycle, status: "unsafe", dispatched: true, observed, verified: false, closed: true, awaitingClarification: false, transitionStatus: "unsafe", resultCode: code };
      directive = "stop_for_safety";
    } else {
      recovery = updateRecoveryState(state, { kind: "uncertain", code });
      lifecycle = { ...lifecycle, status: "observed", dispatched: true, observed, verified: false, closed: false, awaitingClarification: true, transitionStatus: "uncertain", resultCode: code };
      directive = "reobserve_rebind";
    }
  }

  const parentTrackedState = transition
    ? registerParentTransition(recovery.state, action, transition, previousObservation || {}, observation)
    : recovery.state;
  const nextState = { ...parentTrackedState, actionLifecycle: lifecycle };
  return {
    state: nextState,
    observation: { ...observation, lastActionResult: transitionResult(result, transition), transitionEvaluation: transition || undefined },
    lifecycle,
    transition,
    directive,
    exhausted: false
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
