const { evaluateTransition } = require("./transition-evaluator");
const agentContract = require("../../extension/src/shared/agent-contract");
const {
  actionFromLease,
  actuatorSignature,
  createActionLease,
  decisionInstanceKey
} = require("../../../packages/shared/agent-actions");
const {
  executionEpisodeFor,
  leasedActionFor,
  recoveryFacts,
  stateWithExecutionEpisode,
  stateWithRecoveryFacts
} = require("./execution-episode");

const MAX_RECOVERY_ATTEMPTS = 3;
const LEASED_ACTION_VERSION = "leased-action/v1";

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
  const explicitFailure = String(result.failureCode || "");
  if (explicitFailure) return FAILURE_CODE_ALIASES[explicitFailure] || explicitFailure;

  // outcome.code is a result vocabulary, not a failure channel. Browser
  // verification deliberately reports success codes such as
  // NORMALIZED_VALUE_VERIFIED there. Reclassifying that code as a failure
  // makes the backend reject the exact local proof it just received.
  const browserVerifiedSuccess = result.outcome?.ok === true || Boolean(
    result.verified === true
    && result.expectedOutcomeObserved === true
    && result.postconditionSatisfied === true
  );
  if (browserVerifiedSuccess) return "";

  // Legacy failure reports may only carry outcome.code/result.code. Preserve
  // those until every producer writes the dedicated failureCode field.
  const raw = String(result.outcome?.code || result.code || "");
  return FAILURE_CODE_ALIASES[raw] || raw;
}

function wasDispatched(result = {}) {
  return result.dispatched === true || result.executed === true;
}

function leasedActionRecord({ action = {}, candidate = null, goal = {}, status = "ready", recoveryAttempts = 0 } = {}) {
  const record = {
    contractVersion: LEASED_ACTION_VERSION,
    actionLease: createActionLease(action),
    status,
    recoveryAttempts: Number(recoveryAttempts || 0),
    candidateIdentity: candidate ? {
      candidateId: candidate.candidateId || action.candidateId || "",
      stableKey: candidate.affordance?.stableKey || candidate.stableKey || action.affordance?.stableKey || "",
      operation: candidate.operation || action.operation || action.type || "",
      controlId: candidate.controlId || action.controlId || "",
      actuatorId: candidate.actuatorId || candidate.targetId || action.actuatorId || "",
      interactionMethod: candidate.interactionMethod || action.interactionMethod || ""
    } : null,
    createdAt: new Date().toISOString()
  };
  Object.defineProperty(record, "originalAction", {
    value: action,
    enumerable: false,
    configurable: false,
    writable: false
  });
  return record;
}

function normalizeLeasedAction(pending = null) {
  if (!pending || typeof pending !== "object") return null;
  if (pending.contractVersion === LEASED_ACTION_VERSION && pending.actionLease?.actionId) {
    if (pending.originalAction?.id) return pending;
    const action = actionFromLease(pending.actionLease);
    if (!action?.id) return null;
    const hydrated = { ...pending };
    Object.defineProperty(hydrated, "originalAction", {
      value: action,
      enumerable: false,
      configurable: false,
      writable: false
    });
    return hydrated;
  }
  // One-way durable-session migration. Runtime code only emits
  // leased-action/v1 records containing ActionLease/v1.
  const action = pending.action || pending.recoveryOfAction || {};
  return leasedActionRecord({
    action: { ...action, id: pending.actionId || action.id || "" },
    candidate: pending.candidateIdentity || pending.candidate || null,
    goal: { obligationId: pending.actionLease?.obligationId || pending.obligationId || pending.goalId || "" },
    status: pending.type === "viewport_rebind" || pending.status === "viewport_recovery" || pending.status === "rebind"
      ? "needs_reveal"
      : (pending.status === "approved" ? "ready" : (pending.status || "ready")),
    recoveryAttempts: Number(pending.recoveryAttempts || pending.recoveryCount || 0)
  });
}

function leasedActionNeedsResult(state = {}, observation = {}) {
  const pending = normalizeLeasedAction(leasedActionFor(state));
  const actionId = pending?.originalAction?.id || "";
  if (!actionId || pending.status === "needs_reveal") return false;
  return String(observation.lastActionResult?.actionId || "") !== actionId;
}

function navigationAction(action = {}) {
  const effect = String(
    action.mechanicalEffect
      || action.affordance?.mechanicalEffect
      || action.affordance?.physicalEffect
      || action.affordance?.effect
      || ""
  ).toLowerCase();
  const expected = String(action.expectedOutcome?.type || "").toLowerCase();
  const intent = String(action.intent || "").toLowerCase();
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

function executionRecoveryFor(state = {}) {
  const existing = recoveryFacts(state);
  return {
    attempts: Number(existing.attempts || 0),
    phase: String(existing.phase || "idle"),
    stateHash: String(existing.stateHash || ""),
    attemptedCandidateIds: [...(existing.attemptedCandidateIds || [])].slice(-24),
    failedStrategies: [...(existing.failedStrategies || [])].slice(-80),
    failedStrategySignatures: [...(existing.failedStrategySignatures || [])],
    lastCode: String(existing.lastCode || ""),
    lastRevealSample: existing.lastRevealSample || null,
    outcomeId: String(existing.outcomeId || ""),
    semanticOwnerId: String(existing.semanticOwnerId || ""),
    transitionTrail: [...(existing.transitionTrail || [])].slice(-12),
    remainingAttempts: Math.max(0, Number(existing.remainingAttempts || 0)),
    deadlineAt: Math.max(0, Number(existing.deadlineAt || 0)),
    updatedAt: existing.updatedAt || ""
  };
}

function semanticStateKey(observation = {}) {
  const page = observation.page || {};
  const surface = page.currentSurface || page.activeSurface || page.foreground || {};
  const progress = page.foreground?.progressMarkers || page.visualState?.foreground?.progressMarkers || {};
  return JSON.stringify({
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
  const recovery = executionRecoveryFor(state);
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
  return stateWithExecutionRecovery(state, {
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

function stateWithExecutionRecovery(state = {}, recovery = {}) {
  return stateWithRecoveryFacts(state, recovery);
}

function updateExecutionRecovery(state = {}, event = {}) {
  const previous = executionRecoveryFor(state);
  const next = { ...previous, updatedAt: new Date().toISOString() };
  const kind = String(event.kind || "none");
  const code = String(event.code || "");
  let classification = "none";

  if (["verified", "meaningful_progress"].includes(kind)) {
    next.attempts = 0;
    next.phase = kind;
    next.stateHash = "";
    next.failedStrategySignatures = [];
    next.attemptedCandidateIds = [];
    next.failedStrategies = [];
    next.lastCode = code;
    next.lastRevealSample = null;
    next.semanticOwnerId = "";
    classification = kind;
  } else if (["grounding_rejection", "planner_rejection"].includes(kind)) {
    next.phase = kind;
    next.lastCode = code;
    if (event.strategySignature) {
      const stateHash = String(event.stateHash || "");
      const semanticOwnerId = String(event.semanticOwnerId || "");
      const sameSemanticOwner = Boolean(
        semanticOwnerId
        && previous.semanticOwnerId
        && semanticOwnerId === previous.semanticOwnerId
      );
      const signatures = !sameSemanticOwner || (stateHash && stateHash !== previous.stateHash)
        ? []
        : [...previous.failedStrategySignatures];
      if (!signatures.includes(event.strategySignature)) signatures.push(event.strategySignature);
      next.stateHash = stateHash || previous.stateHash;
      next.semanticOwnerId = semanticOwnerId;
      next.failedStrategySignatures = signatures;
      next.attempts = Math.max(previous.attempts + 1, signatures.length);
    }
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
    const semanticOwnerId = String(event.semanticOwnerId || "");
    const sameSemanticOwner = Boolean(
      semanticOwnerId
      && previous.semanticOwnerId
      && semanticOwnerId === previous.semanticOwnerId
    );
    const signatures = !sameSemanticOwner || (stateHash && stateHash !== previous.stateHash)
      ? []
      : [...previous.failedStrategySignatures];
    if (event.strategySignature && !signatures.includes(event.strategySignature)) signatures.push(event.strategySignature);
    next.phase = "execution_no_effect";
    next.stateHash = stateHash || previous.stateHash;
    next.semanticOwnerId = semanticOwnerId;
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

  next.remainingAttempts = Math.max(0, MAX_RECOVERY_ATTEMPTS - next.attempts);

  return {
    state: stateWithExecutionRecovery(state, next),
    recovery: next,
    classification,
    code,
    exhausted: next.attempts >= MAX_RECOVERY_ATTEMPTS
  };
}

function recoverBeforeDispatch({ state = {}, action = {}, code = "PRE_DISPATCH_REJECTION" } = {}) {
  const recovery = updateExecutionRecovery(state, { kind: "grounding_rejection", code });
  const lifecycle = {
    ...proposeActionLifecycle(action, { observationId: action.observationId || "" }),
    status: "rejected_before_dispatch",
    resultCode: recovery.code || code
  };
  return {
    ...recovery,
    state: stateWithExecutionEpisode(recovery.state, lifecycle),
    lifecycle,
    directive: "rebuild_candidates"
  };
}

function lifecycleAction(state = {}, result = {}) {
  const resultAction = result.action || {};
  if (state.lastAction?.id && state.lastAction.id === result.actionId) return state.lastAction;
  const pending = normalizeLeasedAction(leasedActionFor(state));
  if (pending?.originalAction?.id === result.actionId) return pending.originalAction;
  return {
    ...resultAction,
    id: result.actionId || resultAction.id || "",
    expectedOutcome: result.expectedOutcome || resultAction.expectedOutcome || null
  };
}

function baseLifecycle(state = {}, observation = {}, action = {}, result = {}) {
  const previous = executionEpisodeFor(state);
  const sameAction = previous.actionId && previous.actionId === (result.actionId || action.id);
  return {
    actionId: result.actionId || action.id || previous.actionId || "",
    observationId: action.observationId || result.observationId || previous.observationId || "",
    candidateId: action.candidateId || normalizeLeasedAction(leasedActionFor(state))?.candidateId || previous.candidateId || "",
    status: sameAction ? previous.status : "proposed",
    approved: sameAction ? previous.approved === true : true,
    dispatched: sameAction ? previous.dispatched === true : false,
    observed: sameAction ? previous.observed === true : false,
    verified: sameAction ? previous.verified === true : false,
    closed: sameAction ? previous.closed === true : false,
    awaitingClarification: sameAction ? previous.awaitingClarification === true : false,
    awaitingDestination: sameAction ? previous.awaitingDestination === true : false,
    navigation: previous.navigation === true || navigationAction(action),
    origin: sameAction && previous.origin && (
      previous.origin.observationId || previous.origin.url || previous.origin.surfaceId
    )
      ? previous.origin
      : (navigationAction(action) ? navigationOrigin({ page: result.beforePage || {}, observationId: action.observationId || "" }) : null),
    destinationReadiness: sameAction ? previous.destinationReadiness || null : null,
    resultCode: canonicalFailureCode(result),
    transitionStatus: sameAction ? previous.transitionStatus || "" : "",
    resultObservationId: observation.observationId || ""
  };
}

function authoritativeTransitionStatus(transition = {}) {
  const status = transition.actionOutcome?.status || "";
  const outcome = agentContract.ACTION_OUTCOME;
  if (status === outcome.SATISFIED) return "achieved";
  if (status === outcome.PROGRESSED) return "progressed";
  if (status === outcome.REVEALED_BLOCKER) return "blocked";
  if (status === outcome.UNSAFE_CHANGE) return transition.causality ? "blocked" : "unsafe";
  if (status === outcome.DESTINATION_LOADING) return "destination_loading";
  if (status === outcome.NO_EFFECT) return "no_effect";
  return "no_effect";
}

function transitionResult(result = {}, transition = null) {
  if (!transition) return { ...result, failureCode: canonicalFailureCode(result) };
  const transitionStatus = authoritativeTransitionStatus(transition);
  const interveningMutation = transition.causality?.classification === "intervening_external_mutation";
  const browserCanonicalComponentCommit = Boolean(
    result.verified === true
    && result.expectedOutcomeObserved === true
    && result.postconditionSatisfied === true
    && result.expectedOutcome?.type === "logical_component_committed"
    && result.outcome?.ok === true
    && String(result.outcome?.code || result.failureCode || "") === "LOGICAL_COMPONENT_COMMITTED"
  );
  // One action can finish its exact local obligation while the durable parent
  // objective merely progresses to another decision. Keep those facts
  // separate: parent progress must never erase a browser-proven local outcome
  // before the journal/ledger consumes it.
  const localPostconditionSatisfied = browserCanonicalComponentCommit
    || transition.postcondition?.satisfied === true
    || transition.currentObligationResult?.completed === true;
  const localOutcomeVerified = browserCanonicalComponentCommit
    || (localPostconditionSatisfied && (
      transition.localMechanicalResult?.verified === true
      || transition.localEffect?.verified === true
      || transition.physicalResult?.verified === true
    ));
  return {
    ...result,
    failureCode: interveningMutation
      ? "INTERVENING_EXTERNAL_MUTATION"
      : transitionStatus === "no_effect"
      ? "TRANSITION_NO_EFFECT"
      : canonicalFailureCode(result),
    transitionStatus,
    transitionDirective: transition.nextDirective,
    transition,
    actionOutcome: transition.actionOutcome || null,
    localMechanicalResult: transition.localMechanicalResult || transition.localEffect || null,
    currentObligationResult: transition.currentObligationResult || null,
    durableObjectiveProgress: transition.durableObjectiveProgress || transition.parentProgress || null,
    localEffect: transition.localEffect || transition.physicalResult || null,
    physicalResult: transition.physicalResult || null,
    physicalEffectVerified: transition.localEffect?.verified === true || transition.physicalResult?.verified === true,
    parentProgress: transition.parentProgress || null,
    taskOutcome: transition.taskOutcome || "",
    taskOutcomeCompleted: (transition.durableObjectiveProgress || transition.parentProgress)?.completed === true,
    taskProgressStatus: transitionStatus,
    localPostconditionSatisfied,
    localExpectedOutcomeObserved: localPostconditionSatisfied,
    localOutcomeVerified,
    browserReportedVerified: result.verified === true,
    completionAuthority: "transition_evaluator",
    postconditionSatisfied: localPostconditionSatisfied,
    expectedOutcomeObserved: localPostconditionSatisfied,
    verified: localOutcomeVerified
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

  const previousLifecycle = executionEpisodeFor(state);
  const samePreviouslyObservedAction = Boolean(
    previousLifecycle.actionId
    && previousLifecycle.actionId === (result.actionId || action.id)
  );
  const dispatched = wasDispatched(result);
  const isNavigation = previousLifecycle.navigation === true || navigationAction(action);
  const destinationPending = isNavigation
    && dispatched
    && previousLifecycle.closed !== true
    && ["TRANSIENT", "UNRESOLVED", "DEGRADED"].includes(String(observationReadiness?.classification || ""))
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
      state: stateWithExecutionEpisode(state, lifecycle),
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
      state: stateWithExecutionEpisode(state, lifecycle),
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
  let recovery = { state, recovery: executionRecoveryFor(state), exhausted: false };
  let lifecycle = baseLifecycle(state, observation, action, result);
  let transition = null;
  let directive = "continue";

  if (!dispatched) {
    const unsafe = UNSAFE_FAILURE_CODES.has(code);
    const freshnessSuperseded = result.superseded === true
      && ["OBSERVATION_HASH_MISMATCH", "STALE_OBSERVATION_SUPERSEDED"].includes(code);
    if (unsafe) {
      lifecycle = { ...lifecycle, status: "unsafe", closed: true, awaitingClarification: false, resultCode: code };
      directive = "stop_for_safety";
    } else if (freshnessSuperseded) {
      // The planned snapshot expired before dispatch. This closes the lease
      // and rebuilds from the fresh observation without claiming that the
      // actuator failed or spending the bounded recovery budget.
      lifecycle = {
        ...lifecycle,
        status: "rejected_before_dispatch",
        closed: true,
        awaitingClarification: false,
        resultCode: code
      };
      directive = "rebuild_candidates";
    } else {
      const repeatProhibited = result.actionOutcome?.repeatProhibited === true
        || code === "FAILED_STRATEGY_REUSE";
      const stateHash = String(
        observation.observationSnapshot?.snapshotHash
        || observation.page?.snapshotHash
        || previousObservation?.observationSnapshot?.snapshotHash
        || previousObservation?.page?.snapshotHash
        || ""
      );
      recovery = updateExecutionRecovery(state, {
        kind: "grounding_rejection",
        code: code || "PRE_DISPATCH_REJECTION",
        stateHash,
        strategySignature: repeatProhibited ? actuatorSignature(action) : "",
        semanticOwnerId: action.semanticOwnerId || decisionInstanceKey(action, previousObservation || observation)
      });
      lifecycle = { ...lifecycle, status: "rejected_before_dispatch", closed: true, awaitingClarification: false, resultCode: code || "PRE_DISPATCH_REJECTION" };
      directive = "rebuild_candidates";
    }
  } else if (!previousObservation?.observationId || !observation.observationId) {
    const stateHash = String(
      observation.observationSnapshot?.snapshotHash
      || observation.page?.snapshotHash
      || previousObservation?.observationSnapshot?.snapshotHash
      || previousObservation?.page?.snapshotHash
      || ""
    );
    recovery = updateExecutionRecovery(state, {
      kind: "execution_no_effect",
      code: "ACTION_CAUSAL_IDENTITY_MISSING",
      stateHash,
      strategySignature: actuatorSignature(action),
      semanticOwnerId: action.semanticOwnerId || decisionInstanceKey(action, observation)
    });
    lifecycle = {
      ...lifecycle,
      status: "failed",
      dispatched: true,
      observed: true,
      verified: false,
      closed: true,
      awaitingClarification: false,
      transitionStatus: "no_effect",
      resultCode: "ACTION_CAUSAL_IDENTITY_MISSING"
    };
    directive = "try_distinct_capability";
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
          origin: (
            previousLifecycle.origin?.observationId
            || previousLifecycle.origin?.url
            || previousLifecycle.origin?.surfaceId
          )
            ? previousLifecycle.origin
            : (
                lifecycle.origin?.observationId
                || lifecycle.origin?.url
                || lifecycle.origin?.surfaceId
              )
              ? lifecycle.origin
              : navigationOrigin(previousObservation)
        }
        : null
    });
    const transitionStatus = authoritativeTransitionStatus(transition);
    const observed = true;
    if (transitionStatus === "achieved") {
      recovery = updateExecutionRecovery(state, { kind: "verified", code });
      lifecycle = { ...lifecycle, status: "verified", dispatched: true, observed, verified: true, closed: true, awaitingClarification: false, awaitingDestination: false, destinationReadiness: observationReadiness, transitionStatus: "achieved", resultCode: code };
      directive = "advance_goal";
    } else if (transitionStatus === "progressed") {
      recovery = updateExecutionRecovery(state, { kind: "meaningful_progress", code });
      lifecycle = {
        ...lifecycle,
        status: "observed",
        dispatched: true,
        observed,
        verified: false,
        localOutcomeVerified: (
          transition.postcondition?.satisfied === true
          || transition.currentObligationResult?.completed === true
        ) && (
          transition.localMechanicalResult?.verified === true
          || transition.localEffect?.verified === true
          || transition.physicalResult?.verified === true
        ),
        closed: true,
        awaitingClarification: false,
        awaitingDestination: false,
        destinationReadiness: observationReadiness,
        transitionStatus: "progressed",
        resultCode: code
      };
      directive = "rebuild_candidates";
    } else if (transitionStatus === "blocked") {
      const rebuildFromCurrentState = transition.nextDirective === "rebuild_task_state";
      const reconciliationCode = rebuildFromCurrentState
        ? (transition.causality?.code || "FRESH_STATE_RECONCILIATION_REQUIRED")
        : code;
      recovery = updateExecutionRecovery(state, {
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
    } else if (transitionStatus === "no_effect") {
      const revealAction = action.type === "scroll" || action.intent === "recover_target_viewport";
      if (revealAction) {
        lifecycle = { ...lifecycle, status: "observed", dispatched: true, observed, verified: false, closed: true, awaitingClarification: false, transitionStatus: "no_effect", resultCode: "TRANSITION_NO_EFFECT" };
        directive = "try_distinct_capability";
      } else {
      const stateHash = String(
        observation.observationSnapshot?.snapshotHash
        || observation.page?.snapshotHash
        || previousObservation?.observationSnapshot?.snapshotHash
        || previousObservation?.page?.snapshotHash
        || ""
      );
      const signature = actuatorSignature(action);
      const semanticOwnerId = action.semanticOwnerId
        || decisionInstanceKey(action, previousObservation || observation);
      recovery = updateExecutionRecovery(state, {
        kind: "execution_no_effect",
        code: "TRANSITION_NO_EFFECT",
        stateHash,
        strategySignature: signature,
        semanticOwnerId
      });
      lifecycle = { ...lifecycle, status: "failed", dispatched: true, observed, verified: false, closed: true, awaitingClarification: false, transitionStatus: "no_effect", resultCode: "TRANSITION_NO_EFFECT" };
      // A finite no-effect budget suppresses repeated strategies, but it does
      // not justify a handoff while another safe grounded capability exists.
      directive = "try_distinct_capability";
      }
    } else if (transitionStatus === "unsafe") {
      lifecycle = { ...lifecycle, status: "unsafe", dispatched: true, observed, verified: false, closed: true, awaitingClarification: false, transitionStatus: "unsafe", resultCode: transition.causality?.code || code };
      directive = "stop_for_safety";
    } else {
      recovery = updateExecutionRecovery(state, { kind: "uncertain", code });
      lifecycle = { ...lifecycle, status: "failed", dispatched: true, observed, verified: false, closed: true, awaitingClarification: false, transitionStatus: "no_effect", resultCode: code || "TRANSITION_NO_EFFECT" };
      directive = "try_distinct_capability";
    }
  }

  const parentTrackedState = transition
    ? registerParentTransition(recovery.state, action, transition, previousObservation || {}, observation)
    : recovery.state;
  const nextState = stateWithExecutionEpisode(parentTrackedState, lifecycle);
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
  normalizeLeasedAction,
  leasedActionNeedsResult,
  leasedActionRecord,
  LEASED_ACTION_VERSION,
  proposeActionLifecycle,
  recoverBeforeDispatch,
  executionRecoveryFor,
  rejectActionLifecycle,
  updateExecutionRecovery,
  wasDispatched
};
