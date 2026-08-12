// The actual observe -> verify -> plan -> policy -> act loop. "act" itself
// happens client-side in the extension (it owns the real DOM); this module's
// job ends at "here is the one policy-approved action to execute," same
// contract /api/agent/next-action already had — the internals are what changed.
//
// Loop-shape note: the spec's abstract "observe -> verify -> plan -> act ->
// verify -> repeat" maps onto this stateless-per-request architecture as:
// verify-after-act happens at the START of the NEXT request (using
// lastActionResult + a fresh requirement extraction), not as a second call
// within the same request. Each HTTP call is one full lap: verify what the
// previous action did, then plan+policy-check the next one.
//
// Zero model calls when task/policy filtering leaves one obvious safe action.
// Ambiguous turns use at most one closed ambiguity-resolution call.
// Earlier multi-call versions measured 15-30+ seconds per turn in practice,
// which is a real cost for a product whose whole point is being fast.

const agentContract = require("../../../extension/src/shared/agent-contract");

const {
  resolveAmbiguity,
  semanticSceneUncertainty
} = require("../ambiguity-resolver");
const {
  actionForCurrentCandidate,
  bindMechanics
} = require("../mechanics-binder");
const { governAction, RECOVERABLE_GROUNDING_CODES } = require("../action-governor");
const { buildControlAliasIndex, resolveActionControl } = require("../control-alias-index");
const { enqueueTrace } = require("../trace-store");
const {
  advanceActionLifecycle,
  canonicalFailureCode,
  normalizeLeasedAction,
  leasedActionNeedsResult,
  leasedActionRecord,
  recoverBeforeDispatch,
  updateExecutionRecovery,
  wasDispatched
} = require("../action-lifecycle");
const {
  normalizeAction,
  createActionLease,
  actuatorSignature,
  decisionInstanceKey,
  isCandidateGrounded,
  semanticGoalKey
} = require("../../../../packages/shared/agent-actions");
const { withUpdate, normalizeStep } = require("../../../../packages/shared/agent-state");
const { currentSurface, currentSurfaceId, surfaceBinding } = require("../surface-contract");
const {
  compileTypedExpectedOutcome,
  expectedPostconditionsForAction,
  predictPhysicalEffect,
  semanticIntentForAction,
  normalizedActionSemantics
} = require("../action-semantics");
const {
  reduceDecisionFrame,
  taskStateReadModel,
  verifiedCommerceObligationFromActionResult
} = require("../task-state-reducer");
const { prepareTransactionInvariants } = require("../invariants");
const { READINESS, classifyObservationReadiness } = require("../observation-readiness");
const {
  applySessionProfileOverrides,
  consumePendingProfileResponse,
  profileFieldLabel
} = require("../profile-context");
const { canonicalizeUserPolicy, seatPolicyFrom } = require("../policy-profile");
const {
  compileDecisionFrame,
  createObservationFrame,
  currentObligation
} = require("../authority-frames");
const { obligationField, semanticOwner } = require("../current-obligation");
const {
  executionEpisodeFor,
  leasedActionFor,
  recoveryFacts,
  updatedExecutionEpisode
} = require("../execution-episode");
const { expectedOutcomeForAction, withActionContract } = require("./action-contract");
const {
  bindTargetSnapshot,
  candidateStrategySignature,
  deterministicTaskCandidate,
  failedStrategySignaturesForGoal,
  groundedObservationCandidateSet,
  observationPageStateHash,
  observationSurfaceId,
  semanticGoalRecoveryKey,
  targetLocalRecoveryScope,
  targetSnapshotForAction
} = require("./mechanics");
const { applyTransitionStatus, deterministicTransitionVerification } = require("./transition");
const {
  browserDispatched,
  leasedActionSupersededByFreshPage,
  rawVerifiedCommerceReceipt,
  recordPreviousActionFacts,
  staleIdentityRejection
} = require("./observation-settlement");
const {
  actionAdvancesCheckout,
  aiDecisionPolicyFingerprint,
  candidateSelectionCacheEntry,
  pendingRecoveryTargetStatus,
  pendingRevealAction,
  rebindPendingRecoveryAction,
  reusableCandidateSelection,
  reusableStaleActionCandidate,
  staleActionRecoveryEntry,
  viewportProgress,
  viewportProgressSample,
  viewportRecoveryAction
} = require("./recovery");
const {
  finalHandoffAction,
  finishTurn,
  modelUsageFromMetas,
  plannerFailureReason,
  policyBlockedAction,
  safePlannerFailureResult,
  summarizeTurn,
  toClientDecision,
  withLatencyDebug
} = require("./turn-result");

function taskMechanics(taskState = {}) {
  return currentObligation(taskState) || {};
}

function bufferedDiagnosticStore(store = null) {
  if (!store?.recordActionEvents || !store?.saveSession) return store;
  const events = [];
  return new Proxy(store, {
    get(target, property) {
      if (property === "recordActionEvent") {
        return (_transactionId, event = {}) => {
          events.push(event);
          return null;
        };
      }
      if (property === "saveSession") {
        return (state) => {
          const saved = target.saveSession(state);
          if (events.length) target.recordActionEvents(state.id, events.splice(0));
          return saved;
        };
      }
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

async function runLoopTurn({
  apiKey,
  model,
  recoveryModel = "",
  dataDir,
  state,
  observation,
  traveler,
  userMessage = "",
  userResponse = null,
  transactionStore = null,
  clientTurnId = ""
}) {
  transactionStore = bufferedDiagnosticStore(transactionStore);
  const turnStartedAt = Date.now();
  const screenshotDataUrl = observation?.page?.screenshotDataUrl || "";
  const traceObservation = screenshotDataUrl
    ? { ...observation, page: { ...(observation?.page || {}), screenshotDataUrl: "[written-to-screenshot-file]" } }
    : observation;
  const turnId = `${Date.now()}`;
  const latency = {
    classification_model_ms: 0,
    verify_plan_model_ms: 0,
    policy_ms: 0,
    semantic_compile_ms: 0,
    task_state_ms: 0,
    trace_queue_ms: 0,
    final_state_persist_ms: 0,
    turn_total_ms: 0
  };
  let verifyPlanMeta = null;
  const consumedProfileResponse = consumePendingProfileResponse({
    pendingInput: state.pendingUserInput || null,
    userResponse,
    userMessage
  });
  if (consumedProfileResponse) {
    state = withUpdate(state, {
      sessionProfileOverrides: {
        ...(state.sessionProfileOverrides || {}),
        [consumedProfileResponse.field]: consumedProfileResponse.value
      },
      pendingUserInput: null,
      status: "running"
    });
  }
  traveler = applySessionProfileOverrides(traveler, state.sessionProfileOverrides || {});
  // Capture evidence/mechanics once. Semantic task authority is compiled once
  // immediately before TaskState reduces the exact DecisionFrame once.
  let observationFrame = null;
  let decisionFrame = null;
  const persistedTerminalLatch = state.taskState?.terminalGoalLatch || null;
  if (persistedTerminalLatch?.locked === true
    && persistedTerminalLatch.terminalStatus === "payment_entry_reached") {
    const terminalAction = normalizeAction({
      observationId: observation.observationId || "",
      observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
      type: "final_review",
      intent: "payment_entry_reached",
      reason: "Actual payment entry was already verified for this booking request. The completed checkout goal remains closed.",
      risk: "payment",
      requiresApproval: true
    });
    const terminalState = withUpdate(state, {
      executionEpisode: updatedExecutionEpisode(state, { leasedAction: null }),
      lastAction: terminalAction,
      status: "ready_for_payment",
      paymentState: { ...(state.paymentState || {}), status: "review_reached" }
    });
    transactionStore?.saveSession?.(terminalState);
    return {
      state: terminalState,
      clientDecision: toClientDecision(terminalAction),
      debug: withLatencyDebug({
        taskState: terminalState.taskState,
        finalAction: terminalAction,
        terminalGoalLatched: true,
        candidateGenerationSuppressed: true
      }, latency, modelUsageFromMetas(model, []))
    };
  }
  // Immutable local evidence must cross the boundary before lifecycle status
  // can classify the parent checkout as progressed/blocked/achieved.
  const freshVerifiedCommerceReceipt = rawVerifiedCommerceReceipt(state, observation);
  // Readiness is evaluated before transition closure. A URL change or an
  // incomplete destination shell cannot close the navigation action that
  // produced it.
  const activeExecutionEpisode = executionEpisodeFor(state);
  const observationReadiness = classifyObservationReadiness({
    observation,
    previousReadiness: state.observationReadiness || {},
    navigationContext: {
      action: state.lastAction || leasedActionFor(state)?.originalAction || null,
      feedback: observation.lastActionResult?.feedback || state.lastAction?.feedback || null,
      result: observation.lastActionResult || null,
      lifecycle: activeExecutionEpisode
    },
    readinessDeadlineAt: Number(
      observation.destinationReadiness?.deadlineAt
      || activeExecutionEpisode.destinationReadiness?.deadlineAt
      || state.observationReadiness?.deadlineAt
      || 0
    )
  });
  const authoritativeTransition = applyTransitionStatus(
    state,
    observation,
    observation.previousObservation || null,
    observationReadiness
  );
  state = authoritativeTransition.state;
  observation = authoritativeTransition.observation;
  const transition = authoritativeTransition.transition;
  const lifecycle = authoritativeTransition.lifecycle;
  const lifecycleDirective = authoritativeTransition.directive || "continue";
  if (lifecycle) {
    const pendingBeforeLifecycle = normalizeLeasedAction(leasedActionFor(state));
    const preservePendingRecovery = pendingBeforeLifecycle?.status === "needs_reveal"
      && pendingBeforeLifecycle.originalAction?.id !== lifecycle.actionId;
    transactionStore?.recordActionEvent?.(state.id, {
      actionId: lifecycle.actionId,
      observationId: observation.observationId || "",
      turnId: clientTurnId || turnId,
      stage: lifecycle.status,
      lifecycle,
      directive: lifecycleDirective
    });
    transactionStore?.advanceGovernedAction?.(
      lifecycle.actionId,
      ["allowed", "approved", "dispatched", "observed"],
      lifecycle.status,
      { lifecycle, transition }
    );
    state = withUpdate(state, {
      executionEpisode: updatedExecutionEpisode(state, {
        leasedAction: ["rejected_before_dispatch", "observed", "verified", "failed", "unsafe"].includes(lifecycle.status)
          && !preservePendingRecovery
          ? null
          : leasedActionFor(state)
      }),
      stallCount: ["rejected_before_dispatch", "observed", "verified"].includes(lifecycle.status)
        ? 0
        : state.stallCount
    });
  }
  if (transition) {
    const preserveViewportRecovery = normalizeLeasedAction(leasedActionFor(state))?.status === "needs_reveal";
    transactionStore?.recordActionEvent?.(state.id, {
      actionId: transition.actionId,
      observationId: observation.observationId || "",
      turnId: clientTurnId || turnId,
      stage: "transition_evaluated",
      status: transition.status,
      nextDirective: transition.nextDirective,
      postcondition: transition.postcondition,
      diff: transition.diff
    });
    state = withUpdate(state, {
      currentBlocker: transition.status === "blocked" ? transition.blocker : null,
      executionEpisode: updatedExecutionEpisode(state, {
        leasedAction: ["achieved", "progressed", "blocked"].includes(transition.status) && !preserveViewportRecovery
          ? null
          : leasedActionFor(state)
      })
    });
  }

  if (lifecycleDirective === "stop_for_safety" || transition?.status === "unsafe") {
    const action = finalHandoffAction(
      "Fresh browser evidence confirmed a policy or transaction-safety conflict. I stopped before another checkout action.",
      observation
    );
    const unsafeState = withUpdate(state, { lastAction: action, status: "awaiting_user" });
    transactionStore?.saveSession?.(unsafeState);
    return {
      state: unsafeState,
      clientDecision: toClientDecision(action),
      debug: withLatencyDebug({ transition, finalAction: action }, latency, modelUsageFromMetas(model, []))
    };
  }

  if (transition?.status === "uncertain") {
    const action = normalizeAction({
      observationId: observation.observationId || "",
      observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
      type: "wait",
      intent: "reobserve_after_grounding_rejection",
      reason: "The transition evidence is incomplete. Capture one fresh observation and rebind current controls without repeating the action.",
      risk: "safe",
      requiresApproval: false
    });
    const uncertainState = withUpdate(state, { lastAction: action, status: "running" });
    transactionStore?.saveSession?.(uncertainState);
    return {
      state: uncertainState,
      clientDecision: toClientDecision(action),
      debug: withLatencyDebug({ transition, finalAction: action }, latency, modelUsageFromMetas(model, []))
    };
  }

  // Readiness owns the boundary between browser reaction and semantic
  // reasoning. A post-navigation shell is not a checkout state, so it cannot
  // create TaskState goals, candidates, recovery failures, or a user handoff.
  state = withUpdate(state, { observationReadiness });
  if (observationReadiness.classification === READINESS.TRANSIENT) {
    const action = normalizeAction({
      observationId: observation.observationId || "",
      observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
      type: "wait",
      intent: "reobserve_after_transient_observation",
      mechanicalEffect: "unknown",
      expectedPostconditions: [{ type: "observation_readiness", status: READINESS.READY }],
      readinessStartedAt: observationReadiness.startedAt,
      readinessDeadlineAt: observationReadiness.deadlineAt,
      readinessAttempts: observationReadiness.attempts,
      reason: `The page is still settling (${observationReadiness.reason}, observation ${observationReadiness.attempts}). Reobserve before the readiness deadline.`,
      risk: "safe",
      requiresApproval: false
    });
    const waitingState = withUpdate(state, { lastAction: action, status: "running" });
    transactionStore?.saveSession?.(waitingState);
    transactionStore?.recordActionEvent?.(waitingState.id, {
      observationId: observation.observationId || "",
      turnId: clientTurnId || turnId,
      stage: "observation_transient_wait",
      readiness: observationReadiness,
      dispatched: false,
      modelCalled: false
    });
    return {
      state: waitingState,
      clientDecision: toClientDecision(action),
      debug: withLatencyDebug({ observationReadiness, finalAction: action, modelCalled: false }, latency, modelUsageFromMetas(model, []))
    };
  }
  if (observationReadiness.classification === READINESS.DEGRADED) {
    if (observationReadiness.handoffEligible !== true) {
      const action = normalizeAction({
        observationId: observation.observationId || "",
        observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
        type: "wait",
        intent: "reobserve_degraded_loading_destination",
        mechanicalEffect: "unknown",
        expectedPostconditions: [{ type: "observation_readiness", status: READINESS.READY }],
        readinessStartedAt: observationReadiness.startedAt,
        readinessDeadlineAt: observationReadiness.deadlineAt,
        readinessAttempts: observationReadiness.attempts,
        reason: "The destination is still loading. Keep the navigation pending and reobserve without planning or asking the user.",
        risk: "safe",
        requiresApproval: false
      });
      const waitingState = withUpdate(state, { lastAction: action, status: "running" });
      transactionStore?.saveSession?.(waitingState);
      return {
        state: waitingState,
        clientDecision: toClientDecision(action),
        debug: withLatencyDebug({
          observationReadiness,
          finalAction: action,
          modelCalled: false,
          navigationStillPending: true
        }, latency, modelUsageFromMetas(model, []))
      };
    }
    const action = normalizeAction({
      observationId: observation.observationId || "",
      observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
      type: "stop",
      intent: "site_readiness_failure",
      mechanicalEffect: "unknown",
      expectedPostconditions: [],
      reason: "SITE_READINESS_FAILURE: the destination remained genuinely loading or unstable until the readiness deadline.",
      risk: "safe",
      requiresApproval: false
    });
    const degradedState = withUpdate(state, { lastAction: action, status: "stopped" });
    transactionStore?.saveSession?.(degradedState);
    return {
      state: degradedState,
      clientDecision: toClientDecision(action),
      debug: withLatencyDebug({
        observationReadiness,
        finalAction: action,
        modelCalled: false,
        stopCategory: "site_readiness_failure",
        userActionRequired: false
      }, latency, modelUsageFromMetas(model, []))
    };
  }

  // Reduce the fresh observation before any pending-action recovery. A new
  // foreground surface or stage invalidates obsolete recovery ownership, so
  // an old target can never be rebound ahead of the current TaskState.
  state = recordPreviousActionFacts(state, observation, traveler);
  const effectiveUserPolicy = canonicalizeUserPolicy({
    ...(state.approvals || {}),
    ...(state.userPolicy || {})
  }, traveler);
  const decisionPolicyFingerprint = aiDecisionPolicyFingerprint(effectiveUserPolicy, traveler);
  let activeComponentGrounding = null;
  let activeComponentGroundingMeta = null;
  let ambiguityModelCalls = 0;
  let ambiguityModelKind = "";
  const resolveTurnAmbiguity = async (request) => {
    if (ambiguityModelCalls >= 1) {
      const error = new Error("The turn-local ambiguity model budget is exhausted.");
      error.code = "AMBIGUITY_MODEL_BUDGET_EXHAUSTED";
      throw error;
    }
    // Consume the budget before awaiting so a failed model transport cannot
    // silently authorize a second semantic/mechanical interpretation call.
    ambiguityModelCalls += 1;
    ambiguityModelKind = request.kind || "unknown";
    return resolveAmbiguity(request);
  };
  // Deterministic semantics remain the fast path. When the current scene has
  // a required unknown component, an explicit classifier contradiction, or
  // an unowned local validation, one closed model call may add grounded
  // hypotheses to fresh observed IDs. It cannot publish work or actions;
  // DecisionFrame is compiled once from the reconciled evidence and TaskState
  // remains the sole obligation authority.
  const semanticCompileStartedAt = Date.now();
  const deterministicSemanticCompilation = agentContract.compileSemanticCheckout(observation.page || {});
  const sceneUncertainty = semanticSceneUncertainty({
    observation,
    semanticCompilation: deterministicSemanticCompilation,
    traveler
  });
  if (sceneUncertainty.needed) {
    try {
      const reconciled = await resolveTurnAmbiguity({
        kind: "semantic_scene",
        input: {
          apiKey,
          model: recoveryModel || model,
          observation,
          semanticCompilation: deterministicSemanticCompilation,
          traveler,
          screenshotDataUrl,
          uncertainty: sceneUncertainty
        }
      });
      observation = reconciled.observation;
      activeComponentGrounding = reconciled.reconciliation;
      activeComponentGroundingMeta = reconciled.meta;
      latency.classification_model_ms += Number(reconciled.meta?.durationMs || 0);
    } catch (error) {
      activeComponentGrounding = {
        status: "unknown",
        authority: "hypothesis_only",
        reasonCode: "SEMANTIC_SCENE_UNRESOLVED",
        evidence: `Grounded scene reconciliation was unavailable: ${error?.code || error?.message || "unknown error"}`
      };
      observation = {
        ...observation,
        page: {
          ...(observation.page || {}),
          semanticSceneReconciliation: activeComponentGrounding
        }
      };
    }
  }
  observationFrame = createObservationFrame(observation);
  decisionFrame = compileDecisionFrame({ observation, observationFrame, state, traveler });
  observation = decisionFrame.observation;
  latency.semantic_compile_ms += Date.now() - semanticCompileStartedAt;
  let transactionContext = prepareTransactionInvariants(state, observation, traveler, {
    authoritativeTransactionFacts: decisionFrame.transactionFacts
  });
  state = transactionContext.state;
  const initialTaskState = state.taskState || {};
  const parentObjective = {
    goal: state.goal || "Complete this checkout safely to payment review.",
    bookingRules: traveler.booking_rules || state.userPolicy?.bookingRules || "",
    paymentPreference: traveler.payment_preference || state.userPolicy?.paymentPreference || ""
  };
  const taskStateStartedAt = Date.now();
  const taskState = reduceDecisionFrame({
    previousTaskState: initialTaskState,
    observation,
    previousActionResult: observation.lastActionResult || null,
    verifiedCommerceObligations: freshVerifiedCommerceReceipt ? [freshVerifiedCommerceReceipt] : [],
    userPolicy: effectiveUserPolicy,
    traveler,
    transactionReview: transactionContext.review,
    transactionId: state.id,
    approvals: state.approvals || {},
    parentObjective,
    decisionFrame,
    mechanicalEvidence: executionEpisodeFor(state).mechanicalEvidence || null
  });
  const taskReadModel = taskStateReadModel(taskState) || {};
  const authoritativeGoal = taskMechanics(taskState);
  latency.task_state_ms = Date.now() - taskStateStartedAt;

  const ambiguityModelAlreadyUsed = () => ambiguityModelCalls > 0;
  if (taskState.clearObsoleteRecovery) {
    state = withUpdate(state, {
      executionEpisode: updatedExecutionEpisode(state, {
        leasedAction: null,
        attempts: 0,
        phase: "idle",
        stateHash: "",
        attemptedCandidateIds: [],
        failedStrategies: [],
        failedStrategySignatures: [],
        lastCode: "",
        lastRevealSample: null,
        updatedAt: new Date().toISOString()
      })
    });
  }
  const resolvedPaidAuthorization = taskState.currentObligation?.policyDecision?.authorization;
  const authorizedDecisionGroupId = taskState.currentObligation?.subject?.decisionGroupId;
  if (resolvedPaidAuthorization?.authorizationId && authorizedDecisionGroupId) {
    const existingAuthorizations = Array.isArray(state.approvals?.paidExtraAuthorizations)
      ? state.approvals.paidExtraAuthorizations
      : [];
    state = withUpdate(state, {
      approvals: {
        ...(state.approvals || {}),
        paidExtraAuthorizations: [
          ...existingAuthorizations.filter((authorization) => (
            authorization.decisionGroupId !== authorizedDecisionGroupId
          )),
          {
            ...resolvedPaidAuthorization,
            decisionGroupId: authorizedDecisionGroupId,
            transactionId: state.id,
            source: resolvedPaidAuthorization.source || "profile_resolver"
          }
        ]
      }
    });
  }
  const { semanticOwnership: _obsoleteSemanticOwnership, ...remainingDecisionCache } = state.aiDecisionCache || {};
  state = withUpdate(state, {
    taskState,
    executionEpisode: updatedExecutionEpisode(state, { mechanicalEvidence: null }),
    semanticOwnershipResolution: undefined,
    aiDecisionCache: remainingDecisionCache
  });
  if (
    state.pendingUserInput?.field
    && !(
      taskState.disposition?.kind === "request_input"
      && taskState.disposition?.field === state.pendingUserInput.field
    )
  ) {
    state = withUpdate(state, { pendingUserInput: null });
  }

  // The current browser state wins over an undispatched/stale prediction. If
  // the page changed without a matching result for the pending action, cancel
  // that binding and plan from the fresh surface instead of waiting for an
  // obsolete DOM outcome.
  const stalePending = normalizeLeasedAction(leasedActionFor(state));
  if (leasedActionSupersededByFreshPage(stalePending, observation)) {
    transactionStore?.recordActionEvent?.(state.id, {
      actionId: stalePending.originalAction.id || "",
      observationId: observation.observationId || "",
      turnId: clientTurnId || turnId,
      stage: "pending_action_cancelled_by_fresh_page",
      sourceObservationHash: stalePending.sourceObservationHash || "",
      currentObservationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
      dispatched: false
    });
    state = withUpdate(state, {
      executionEpisode: updatedExecutionEpisode(state, {
        leasedAction: null,
        attemptedCandidateIds: [],
        failedStrategySignatures: [],
        failedStrategies: []
      }),
      status: "running"
    });
  }

  // A pending advance is never stronger than newer exact selection truth.
  // Manual changes, rerenders, and late selector hydration can reveal a paid
  // conflict after navigation was planned. Cancel that stale plan and let the
  // freshly reduced decision own this turn.
  const pendingBeforeConflictReconciliation = normalizeLeasedAction(leasedActionFor(state));
  const authoritativeEffect = String(
    obligationField(authoritativeGoal, "semanticEffect")
    || obligationField(authoritativeGoal, "desiredSemanticOutcome")
    || obligationField(authoritativeGoal, "desiredPolicyOutcome")
    || ""
  );
  const authoritativeCorrection = agentContract.canonicalSemanticEffect(authoritativeEffect)
    === agentContract.SEMANTIC_EFFECT.SELECT_FREE_OPTION;
  if (pendingBeforeConflictReconciliation?.originalAction
    && actionAdvancesCheckout(pendingBeforeConflictReconciliation.originalAction)
    && authoritativeCorrection) {
    transactionStore?.recordActionEvent?.(state.id, {
      actionId: pendingBeforeConflictReconciliation.originalAction.id || "",
      observationId: observation.observationId || "",
      turnId: clientTurnId || turnId,
      stage: "pending_navigation_preempted_by_policy_conflict",
      decisionGroupId: obligationField(authoritativeGoal, "decisionGroupId") || "",
      obligationId: obligationField(authoritativeGoal, "goalId") || "",
      dispatched: false
    });
    state = withUpdate(state, {
      executionEpisode: updatedExecutionEpisode(state, {
        leasedAction: null,
        attemptedCandidateIds: []
      }),
      status: "running"
    });
  }

  // A recoverable governor result preserves the semantic action across the
  // observation created by scrolling. Rebind that same action to the fresh
  // canonical registry before consulting the model again.
  const normalizedPending = normalizeLeasedAction(leasedActionFor(state));
  if (normalizedPending?.status === "needs_reveal" && normalizedPending.originalAction) {
    const pending = normalizedPending;
    const rebound = rebindPendingRecoveryAction(pending, observation, state, traveler);
    const reboundAction = rebound.action;
    const targetStatus = pendingRecoveryTargetStatus(reboundAction);
    const revealSample = viewportProgress(
      recoveryFacts(state).lastRevealSample || null,
      viewportProgressSample(reboundAction, observation)
    );
    // Candidate graphs are fresh-observation mechanics. Keep them in this
    // turn and pass them directly to governance; never persist them inside the
    // semantic TaskState obligation.
    const reboundState = state;
    if (!targetStatus.exists) {
      const grounding = recoverBeforeDispatch({
        state: reboundState,
        action: reboundAction,
        code: "TARGET_DISAPPEARED"
      });
      const action = normalizeAction({
        observationId: observation.observationId || "",
        observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
        type: "wait",
        intent: "reobserve_after_grounding_rejection",
        obligationId: pending.actionLease?.obligationId || pending.obligationId || "",
        reason: "The pending target disappeared. Discard its binding, rebuild candidates from the fresh surface, and reselect without consuming an execution attempt.",
        risk: "safe",
        requiresApproval: false
      });
      const recoveryState = withUpdate(grounding.state, {
        executionEpisode: updatedExecutionEpisode(grounding.state, { leasedAction: null }),
        lastAction: action,
        status: "running"
      });
      transactionStore?.saveSession?.(recoveryState);
      return {
        state: recoveryState,
        clientDecision: toClientDecision(action),
        debug: withLatencyDebug({ pendingAction: pending, groundingRejection: grounding, finalAction: action, resumedBeforePlanning: true }, latency, modelUsageFromMetas(model, []))
      };
    }

    const revealRecovery = updateExecutionRecovery(reboundState, {
      kind: "reveal",
      code: targetStatus.inViewport ? "TARGET_IN_VIEW" : "TARGET_OUT_OF_VIEW",
      sample: revealSample,
      measurableProgress: revealSample.measurableProgress
    });
    const policyStartedAt = Date.now();
    let recoveryGovernance = targetStatus.exists && targetStatus.inViewport
      ? governAction({
          action: reboundAction,
          state: revealRecovery.state,
          observation,
          traveler,
          approvals: revealRecovery.state.approvals,
          store: transactionStore,
          turnId: clientTurnId || turnId,
          preparedInvariantContext: transactionContext,
          preparedCandidateSet: rebound.candidateSet
        })
      : {
          state: revealRecovery.state,
          allow: false,
          decision: "recoverable",
          code: "TARGET_OUT_OF_VIEW",
          reason: "The fresh observation has not yet confirmed the pending canonical target in the viewport."
        };
    latency.policy_ms = Date.now() - policyStartedAt;
    let recoveryState = recoveryGovernance.state || reboundState;
    let finalAction = reboundAction;

    if (recoveryGovernance.allow && targetStatus.exists && targetStatus.inViewport) {
      recoveryState = withUpdate(recoveryState, {
        executionEpisode: updatedExecutionEpisode(recoveryState, { leasedAction: leasedActionRecord({
          action: reboundAction,
          candidate: rebound.candidate || pending.candidateIdentity,
          goal: authoritativeGoal,
          status: "ready",
          recoveryAttempts: revealRecovery.recovery.attempts
        }) }),
        lastAction: reboundAction,
        status: "running"
      });
      transactionStore?.recordActionEvent?.(recoveryState.id, {
        actionId: reboundAction.id,
        observationId: observation.observationId || "",
        turnId: clientTurnId || turnId,
        stage: "pending_action_rebound_dispatched",
        recoveryOfActionId: pending.originalAction.id,
        recoveryAttempts: revealRecovery.recovery.attempts,
        action: reboundAction
      });
    } else if (recoveryGovernance.decision === "recoverable"
      && recoveryGovernance.code === "TARGET_OUT_OF_VIEW"
      && !revealRecovery.exhausted) {
      const nextRecoveryAttempt = Number(revealRecovery.recovery.attempts || 0) + 1;
      const scrollAction = viewportRecoveryAction(reboundAction, observation, nextRecoveryAttempt);
      const scrollGovernance = governAction({
        action: scrollAction,
        state: recoveryState,
        observation,
        traveler,
        approvals: recoveryState.approvals,
        store: transactionStore,
        turnId: clientTurnId || turnId,
        preparedInvariantContext: transactionContext,
        preparedCandidateSet: rebound.candidateSet
      });
      if (scrollGovernance.allow) {
        recoveryGovernance = scrollGovernance;
        finalAction = scrollAction;
        recoveryState = withUpdate(scrollGovernance.state || recoveryState, {
          executionEpisode: updatedExecutionEpisode(scrollGovernance.state || recoveryState, { leasedAction: leasedActionRecord({
            action: pending.originalAction,
            candidate: pending.candidateIdentity,
            goal: authoritativeGoal,
            status: "needs_reveal",
            recoveryAttempts: nextRecoveryAttempt
          }) }),
          lastAction: scrollAction,
          status: "running"
        });
        transactionStore?.recordActionEvent?.(recoveryState.id, {
          actionId: scrollAction.id,
          observationId: observation.observationId || "",
          turnId: clientTurnId || turnId,
          stage: "pending_action_reveal_governed",
          recoveryOfActionId: pending.originalAction.id,
          recoveryAttempts: nextRecoveryAttempt,
          action: scrollAction
        });
      } else if (scrollGovernance.decision === "recoverable") {
        const grounding = recoverBeforeDispatch({
          state: recoveryState,
          action: scrollAction,
          code: scrollGovernance.code || "SCROLL_GROUNDING_REJECTED"
        });
        recoveryState = grounding.state;
        finalAction = normalizeAction({
          observationId: observation.observationId || "",
          observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
          type: "wait",
          intent: "reobserve_after_grounding_rejection",
          obligationId: pending.actionLease?.obligationId || pending.obligationId || "",
          reason: "The governed reveal binding was rejected before dispatch. Rebuild it from a fresh observation without consuming an execution attempt.",
          risk: "safe",
          requiresApproval: false
        });
        recoveryState = withUpdate(recoveryState, {
          executionEpisode: updatedExecutionEpisode(recoveryState, { leasedAction: null }),
          lastAction: finalAction,
          status: "running"
        });
      } else {
        recoveryGovernance = scrollGovernance;
        finalAction = policyBlockedAction(scrollGovernance, scrollAction);
        recoveryState = withUpdate(recoveryState, {
          executionEpisode: updatedExecutionEpisode(recoveryState, { leasedAction: null }),
          lastAction: finalAction,
          status: "awaiting_user"
        });
      }
    } else if (recoveryGovernance.decision === "recoverable"
      && recoveryGovernance.code === "TARGET_OUT_OF_VIEW"
      && revealRecovery.exhausted) {
      const exhaustedGoal = authoritativeGoal || {};
      const mechanicalEvidence = {
        kind: "goal_strategies_exhausted",
        goalId: obligationField(exhaustedGoal, "goalId") || pending.actionLease?.obligationId || pending.obligationId || "",
        semanticGoalKey: semanticGoalKey(exhaustedGoal),
        decisionGroupId: exhaustedGoal.decisionGroupId || exhaustedGoal.subject?.decisionGroupId || "",
        subjectKey: exhaustedGoal.canonicalSubject?.key || exhaustedGoal.subject?.key || exhaustedGoal.semanticType || "",
        surfaceId: exhaustedGoal.surfaceId || observation.page?.currentSurface?.id || "surface-page",
        observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
        excludedControlIds: [reboundAction.controlId].filter(Boolean)
      };
      finalAction = normalizeAction({
        observationId: observation.observationId || "",
        observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
        type: "wait",
        intent: "reobserve_after_strategy_exhaustion",
        mechanicalEffect: "none",
        expectedPostconditions: [{ type: "fresh_observation_required" }],
        reason: "The exact viewport-recovery budget is exhausted. Persist compact mechanical evidence and let the next single TaskState reduction publish the final disposition.",
        risk: "safe",
        requiresApproval: false
      });
      recoveryState = withUpdate(recoveryState, {
        executionEpisode: updatedExecutionEpisode(recoveryState, {
          leasedAction: null,
          mechanicalEvidence
        }),
        lastAction: finalAction,
        status: "running"
      });
    } else if (recoveryGovernance.decision === "recoverable") {
      const grounding = recoverBeforeDispatch({
        state: recoveryState,
        action: reboundAction,
        code: recoveryGovernance.code || "PENDING_ACTION_GROUNDING_REJECTED"
      });
      recoveryState = grounding.state;
      finalAction = normalizeAction({
        observationId: observation.observationId || "",
        observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
        type: "wait",
        intent: "reobserve_after_grounding_rejection",
        obligationId: pending.actionLease?.obligationId || pending.obligationId || "",
        reason: "The rebound pending action was rejected before dispatch. Rebuild current candidates from fresh browser evidence without consuming an execution attempt.",
        risk: "safe",
        requiresApproval: false
      });
      recoveryState = withUpdate(recoveryState, {
        executionEpisode: updatedExecutionEpisode(recoveryState, { leasedAction: null }),
        lastAction: finalAction,
        status: "running"
      });
    } else {
      finalAction = policyBlockedAction(recoveryGovernance, reboundAction);
      recoveryState = withUpdate(recoveryState, {
        executionEpisode: updatedExecutionEpisode(recoveryState, { leasedAction: null }),
        lastAction: finalAction,
        status: "awaiting_user"
      });
    }

    finalAction = bindTargetSnapshot(finalAction, observation);
    recoveryState = withUpdate(recoveryState, { lastAction: finalAction });
    transactionStore?.saveSession?.(recoveryState);
    const debug = withLatencyDebug(
      summarizeTurn({
        pageState: null,
        requirements: [],
        plannedAction: reboundAction,
        finalAction,
        policyDecision: recoveryGovernance,
        deterministicAction: reboundAction
      }),
      latency,
      modelUsageFromMetas(model, [])
    );
    enqueueTrace(dataDir, state.id, {
      turnId,
      screenshotDataUrl,
      observation: traceObservation,
      pageState: null,
      requirements: [],
      requirementLifecycle: [],
      verification: observation.lastActionResult || null,
      plannedAction: reboundAction,
      policyDecision: recoveryGovernance,
      executionResult: {
        pendingRecovery: true,
        recoveryAttempts: pending.recoveryAttempts,
        recoveryOfActionId: pending.originalAction.id,
        freshTargetExists: targetStatus.exists,
        freshTargetInViewport: targetStatus.inViewport,
        revealProgress: revealSample,
        executionEpisode: executionEpisodeFor(recoveryState)
      },
      debug
    });
    return { state: recoveryState, clientDecision: toClientDecision(finalAction), debug };
  }

  // An approved action must be observed before any new goal or candidate set
  // is derived. Missing execution feedback is a resume condition, not a new
  // planning turn and not a user-facing failure.
  if (leasedActionNeedsResult(state, observation)) {
    const pending = normalizeLeasedAction(leasedActionFor(state));
    const action = normalizeAction({
      observationId: observation.observationId || "",
      observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
      type: "wait",
      intent: "await_pending_action_result",
      obligationId: pending?.obligationId || "",
      candidateId: pending?.candidateId || "",
      reason: `Wait for browser evidence for pending action ${pending?.originalAction?.id || ""}; do not derive or dispatch another action.`,
      risk: "safe",
      requiresApproval: false
    });
    const waitingState = withUpdate(state, { lastAction: action, status: "running" });
    transactionStore?.saveSession?.(waitingState);
    return {
      state: waitingState,
      clientDecision: toClientDecision(action),
      debug: withLatencyDebug({ pendingAction: pending, finalAction: action, resumedBeforePlanning: true }, latency, modelUsageFromMetas(model, []))
    };
  }

  // TaskState publishes one typed disposition for every ready turn. The loop
  // translates that decision into a client action; it must not independently
  // reinterpret profile readiness, validation, site state, or missing goals.
  const taskDisposition = taskState.disposition || {};
  const publishedGoal = authoritativeGoal;
  const publishedProfileGoal = publishedGoal?.kind === "profile_field"
    ? publishedGoal
    : null;
  const publishedAdaptiveGoal = publishedGoal?.kind === "adaptive_surface"
    ? publishedGoal
    : null;
  const publishedMechanicalGoal = publishedProfileGoal || publishedAdaptiveGoal;
  if (["request_input", "request_approval", "wait_reobserve", "terminal", "stop"].includes(taskDisposition.kind)) {
    const missingDerivedFact = taskDisposition.missingDerivedFact || null;
    const missingField = String(taskDisposition.field || "");
    const missingLabel = String(
      taskDisposition.fieldLabel
      || (missingField ? profileFieldLabel(missingField) : "")
      || taskDisposition.reason
      || "required information"
    );
    const travelerName = [traveler.first_name, traveler.middle_name, traveler.last_name].filter(Boolean).join(" ") || "this traveler";
    const reason = `${taskDisposition.code || "TASK_STATE_DISPOSITION"}: ${missingDerivedFact
      ? `the ${missingDerivedFact.label} was not captured from the selected flight. Return to the selected flight and start Fly again so the booking can be verified before traveler details are completed.`
      : taskDisposition.kind === "request_input" && missingField
      ? `What is ${travelerName}'s ${missingLabel}? This checkout requires it before continuing.`
      : taskDisposition.reason || "TaskState could not publish a safe executable obligation."}`;
    const action = taskDisposition.kind === "terminal"
      ? normalizeAction({
          observationId: observation.observationId || "",
          observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
          type: "final_review",
          intent: taskDisposition.code === "PAYMENT_ENTRY_REACHED" ? "payment_entry_reached" : "task_terminal",
          mechanicalEffect: "none",
          expectedPostconditions: [],
          reason,
          risk: taskDisposition.code === "PAYMENT_ENTRY_REACHED" ? "payment" : "safe",
          requiresApproval: true
        })
      : taskDisposition.kind === "request_input"
      ? finalHandoffAction(reason, observation, {
          ...(missingField ? {
            inputRequest: {
              requestId: `profile_input_${state.id}_${missingField}`,
              field: missingField,
              label: missingLabel,
              subjectId: traveler.id || state.travelerId || "traveler_1",
              sensitive: ["passport_number", "document_number"].includes(missingField)
            }
          } : {})
        })
      : taskDisposition.kind === "request_approval"
        ? finalHandoffAction(reason, observation, {
            approvalRequest: taskDisposition.details?.approvalRequest || null,
            risk: taskDisposition.code === "LEGAL_APPROVAL_REQUIRED" ? "legal" : "uncertain"
          })
        : normalizeAction({
            observationId: observation.observationId || "",
            observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
            type: taskDisposition.kind === "wait_reobserve" ? "wait" : "stop",
            intent: taskDisposition.code === "SITE_FAILURE_OBSERVED"
              ? "site_failure_observed"
              : taskDisposition.kind === "wait_reobserve"
              ? "task_state_reobserve"
              : "task_state_stop",
            mechanicalEffect: "none",
            expectedPostconditions: taskDisposition.kind === "wait_reobserve"
              ? [{ type: "fresh_observation_required" }]
              : [],
            readinessStartedAt: taskDisposition.reobserveStartedAt || 0,
            readinessDeadlineAt: taskDisposition.reobserveDeadlineAt || 0,
            readinessAttempts: taskDisposition.reobserveCount || 0,
            reobserveRetryToken: taskDisposition.retryToken || "",
            reason,
            risk: "safe",
            requiresApproval: false
          });
    const status = taskDisposition.kind === "terminal"
      ? "ready_for_payment"
      : taskDisposition.kind === "wait_reobserve"
      ? "running"
      : ["request_input", "request_approval"].includes(taskDisposition.kind)
        ? "awaiting_user"
        : "stopped";
    const dispositionState = withUpdate(state, {
      taskState,
      lastAction: action,
      status,
      pendingUserInput: taskDisposition.kind === "request_input" ? action.inputRequest || null : null,
      paymentState: taskDisposition.kind === "terminal"
        ? { ...(state.paymentState || {}), status: "review_reached" }
        : state.paymentState
    });
    const debug = withLatencyDebug({
        taskState,
        processAwareness: taskReadModel.processAwareness || null,
        transactionReview: taskReadModel.transactionReview || null,
        paymentEvidence: taskReadModel.paymentEvidence || null,
        stageDecisionEvidence: taskReadModel.stageDecisionEvidence || null,
        candidateGenerationSuppressed: taskDisposition.kind === "terminal",
        activeComponentGrounding,
        finalAction: action,
        reason,
        stopCategory: String(taskDisposition.code || taskDisposition.kind || "task_state_disposition").toLowerCase(),
        userActionRequired: taskDisposition.userActionRequired === true
      }, latency, modelUsageFromMetas(model, [activeComponentGroundingMeta]));
    return finishTurn({
      dataDir,
      sessionId: state.id,
      turnId,
      screenshotDataUrl,
      observation: traceObservation,
      state: dispositionState,
      action,
      debug,
      transactionStore,
      verification: observation.lastActionResult || null,
      policyDecision: {
        allow: false,
        decision: taskDisposition.kind,
        code: taskDisposition.code,
        reason
      },
      executionResult: {
        endingAction: action.type,
        endingIntent: action.intent,
        stopped: ["stop", "ask_user"].includes(action.type),
        userActionRequired: taskDisposition.userActionRequired === true,
        stopCategory: String(taskDisposition.code || taskDisposition.kind || "task_state_disposition").toLowerCase()
      }
    });
  }

  // The action lifecycle above is the sole authority for unchanged outcomes.
  // A pre-dispatch rejection rebuilds from this observation; only a browser-
  // dispatched unchanged transition consumes an execution strategy attempt.
  // Build the task-scoped contract before consulting a model. Canonical
  // decision groups, current-surface ownership, policy, unavailable state and
  // failed stable strategies are sufficient for an obvious single action.
  // In that case the model must not rediscover or reinterpret the contract.
  let canonicalState = withUpdate(state, {
    taskState,
  });
  let canonicalGoal = taskMechanics(taskState);
  if (!canonicalGoal) {
    const reason = "TASK_STATE_CONTRACT_VIOLATION: an execute disposition did not include a CurrentObligation.";
    const action = normalizeAction({
      observationId: observation.observationId || "",
      observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
      type: "stop",
      intent: "task_state_contract_violation",
      mechanicalEffect: "none",
      expectedPostconditions: [],
      reason,
      risk: "safe",
      requiresApproval: false
    });
    const stoppedState = withUpdate(canonicalState, {
      lastAction: action,
      status: "stopped"
    });
    transactionStore?.saveSession?.(stoppedState);
    const debug = withLatencyDebug({
        taskState,
        finalAction: action,
        stopCategory: "task_state_contract_violation",
        userActionRequired: false
      }, latency, modelUsageFromMetas(model, []));
    return finishTurn({
      dataDir,
      sessionId: state.id,
      turnId,
      screenshotDataUrl,
      observation: traceObservation,
      state: stoppedState,
      action,
      debug,
      transactionStore,
      verification: observation.lastActionResult || null,
      policyDecision: {
        allow: false,
        decision: "internal_failure",
        reason
      },
      executionResult: {
        endingAction: action.type,
        endingIntent: action.intent,
        stopped: true,
        userActionRequired: false,
        stopCategory: "task_state_contract_violation"
      }
    });
  }
  let canonicalFailedStrategies = failedStrategySignaturesForGoal(state, canonicalGoal, observation);
  let canonicalCandidateSet = groundedObservationCandidateSet(
    taskState.currentObligation,
    decisionFrame,
    observation,
    canonicalFailedStrategies,
    {
      state: canonicalState,
      traveler,
      approvals: state.approvals
    }
  );
  // Strategy exhaustion is persisted as compact mechanical evidence for the
  // next observation. The current turn never invokes TaskState a second time.
  // On the next turn the single reducer pass may retain the obligation or
  // publish one bounded adaptive fallback from that evidence.
  if (!canonicalCandidateSet.candidates.length) {
    const failedControlIds = [...new Set((recoveryFacts(state).failedStrategies || [])
      .filter((entry) => entry.semanticGoalKey === semanticGoalKey(canonicalGoal))
      .map((entry) => entry.controlId)
      .filter(Boolean))];
    const mechanicalEvidence = {
        kind: "goal_strategies_exhausted",
        goalId: obligationField(canonicalGoal, "goalId"),
        semanticGoalKey: semanticGoalKey(canonicalGoal),
        decisionGroupId: obligationField(canonicalGoal, "decisionGroupId") || obligationField(canonicalGoal, "subject")?.decisionGroupId || "",
        subjectKey: obligationField(canonicalGoal, "canonicalSubject")?.key || obligationField(canonicalGoal, "subject")?.key || obligationField(canonicalGoal, "semanticType") || "",
        surfaceId: obligationField(canonicalGoal, "surfaceId") || observation.page?.currentSurface?.id || "surface-page",
        observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
        excludedControlIds: failedControlIds
      };
    const action = normalizeAction({
      observationId: observation.observationId || "",
      observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
      type: "wait",
      intent: "reobserve_after_strategy_exhaustion",
      mechanicalEffect: "unknown",
      expectedPostconditions: [{ type: "fresh_observation_required" }],
      reason: "No exact current mechanic can execute the admitted obligation. Reobserve once so TaskState alone can route bounded recovery or publish the final exhaustion disposition.",
      risk: "safe",
      requiresApproval: false
    });
    const waitingState = withUpdate(canonicalState, {
      taskState,
      executionEpisode: updatedExecutionEpisode(canonicalState, { mechanicalEvidence }),
      lastAction: action,
      status: "running"
    });
    return finishTurn({
      dataDir,
      sessionId: state.id,
      turnId,
      screenshotDataUrl,
      observation: traceObservation,
      state: waitingState,
      action,
      debug: withLatencyDebug({ taskState, mechanicalEvidence, finalAction: action }, latency, modelUsageFromMetas(model, [])),
      transactionStore,
      verification: observation.lastActionResult || null,
      policyDecision: { allow: false, decision: "reobserve", code: "MECHANICS_EXHAUSTED", reason: action.reason },
      executionResult: { endingAction: "wait", endingIntent: action.intent, stopped: false }
    });
  }
  canonicalState = withUpdate(canonicalState, { taskState });
  const staleReboundCandidate = reusableStaleActionCandidate(
    recoveryFacts(state).staleRebind,
    canonicalGoal,
    canonicalCandidateSet,
    decisionPolicyFingerprint
  );
  let obviousCandidate = staleReboundCandidate || deterministicTaskCandidate(canonicalCandidateSet, canonicalGoal);
  const staleActionReused = Boolean(staleReboundCandidate);
  if (recoveryFacts(state).staleRebind) {
    state = withUpdate(state, {
      executionEpisode: updatedExecutionEpisode(state, { staleRebind: null })
    });
    canonicalState = withUpdate(canonicalState, {
      executionEpisode: updatedExecutionEpisode(canonicalState, { staleRebind: null })
    });
  }

  let extracted;
  let verification;
  let modelPlannedAction;
  let modelSelection;
  let observationGoal;
  let candidateSet;
  let observationCandidates;
  let deterministicAction = null;
  let candidateSelectionDecision = null;
  let candidateSelectionReused = false;
  const planningModel = publishedMechanicalGoal ? (recoveryModel || model) : model;
  let modelUsage;

  if (obviousCandidate) {
    extracted = {
      pageState: null,
      pageStep: taskState.stage,
      requirements: [],
      uncertainties: [],
      summary: "One policy-allowed task candidate remained after canonical filtering."
    };
    verification = deterministicTransitionVerification(transition);
    observationGoal = canonicalGoal;
    candidateSet = canonicalCandidateSet;
    observationCandidates = candidateSet.candidates;
    modelSelection = {
      candidateId: obviousCandidate.candidateId,
      candidate: obviousCandidate,
      confidence: "deterministic",
      semanticOutcome: obviousCandidate.interactionRole === "navigation"
        ? "advance_current_surface"
        : "satisfy_current_decision"
    };
    modelPlannedAction = bindTargetSnapshot(
      { ...actionForCurrentCandidate(observationGoal, obviousCandidate, observation), semanticOutcome: modelSelection.semanticOutcome },
      observation
    );
    deterministicAction = modelPlannedAction;
    modelUsage = modelUsageFromMetas(planningModel, []);
    transactionStore?.recordActionEvent?.(state.id, {
      observationId: observation.observationId || "",
      turnId: clientTurnId || turnId,
      stage: "deterministic_task_candidate_selected",
      candidateId: obviousCandidate.candidateId,
      candidateCount: 1,
      modelCalled: false,
      staleActionReused
    });
  } else {
    // The task context above is the only semantic authority. Classification
    // cannot replace its remaining goal or reopen a completed obligation.
    // Genuine ambiguity is a closed selection over current candidate IDs.
    extracted = {
      pageState: null,
      pageStep: taskState.stage,
      requirements: [],
      uncertainties: [],
      summary: "Selection is scoped to the authoritative obligation and current candidate set."
    };
    verification = deterministicTransitionVerification(transition);
    observationGoal = canonicalGoal;
    candidateSet = canonicalCandidateSet;
    observationCandidates = candidateSet.candidates;
    try {
      let selected;
      try {
        selected = reusableCandidateSelection(
          state.aiDecisionCache,
          observation,
          observationGoal,
          candidateSet,
          decisionPolicyFingerprint
        );
        if (selected) {
          candidateSelectionReused = true;
          transactionStore?.recordActionEvent?.(state.id, {
            observationId: observation.observationId || "",
            turnId: clientTurnId || turnId,
            stage: "ai_candidate_decision_reused",
            candidateId: selected.candidateId,
            controlId: selected.candidate.controlId,
            modelCalled: false
          });
        } else if (ambiguityModelAlreadyUsed()) {
          // Semantic binding already consumed this turn's sole ambiguity
          // budget. Every remaining mechanic is grounded and governed; use
          // the binder's deterministic order instead of making a second call.
          const bounded = observationCandidates[0];
          selected = bounded
            ? { candidateId: bounded.candidateId, candidate: bounded, confidence: "bounded_deterministic", meta: null }
            : null;
        } else {
          const resolved = await resolveTurnAmbiguity({
            kind: "mechanic_selection",
            input: {
              apiKey,
              model: planningModel,
              goal: observationGoal,
              taskState,
              candidates: observationCandidates,
              contextCapabilities: candidateSet.contextCapabilities,
              observation,
              screenshotDataUrl
            }
          });
          selected = resolved.selection;
        }
      } catch (error) {
        if (error?.code !== "PLANNER_CANDIDATE_NOT_CURRENT") throw error;
        candidateSet = groundedObservationCandidateSet(
          taskState.currentObligation,
          decisionFrame,
          observation,
          failedStrategySignaturesForGoal(state, observationGoal, observation),
          {
            state: canonicalState,
            traveler,
            approvals: state.approvals
          }
        );
        observationCandidates = candidateSet.candidates;
        const rebuiltObvious = deterministicTaskCandidate(candidateSet, observationGoal);
        if (rebuiltObvious) {
          selected = { candidateId: rebuiltObvious.candidateId, candidate: rebuiltObvious, meta: null };
        } else if (ambiguityModelAlreadyUsed() && ambiguityModelKind === "semantic_scene" && observationCandidates[0]) {
          const bounded = observationCandidates[0];
          selected = { candidateId: bounded.candidateId, candidate: bounded, confidence: "bounded_deterministic", meta: null };
        } else if (ambiguityModelAlreadyUsed()) {
          // An invalid mechanical selection consumed the sole model call. Do
          // not reinterpret ambiguity as permission to choose an arbitrary
          // first candidate; return through the existing bounded retry path.
          throw error;
        } else {
          const resolved = await resolveTurnAmbiguity({
            kind: "mechanic_selection",
            input: {
              apiKey,
              model: planningModel,
              goal: observationGoal,
              taskState,
              candidates: observationCandidates,
              contextCapabilities: candidateSet.contextCapabilities,
              observation,
              screenshotDataUrl
            }
          });
          selected = resolved.selection;
        }
        transactionStore?.recordActionEvent?.(state.id, {
          observationId: observation.observationId || "",
          turnId: clientTurnId || turnId,
          stage: "candidate_selection_rebuilt",
          dispatched: false,
          browserReobserved: false,
          candidateCount: observationCandidates.length
        });
      }
      verifyPlanMeta = selected.meta || null;
      latency.verify_plan_model_ms = Number(verifyPlanMeta?.durationMs || 0);
      const selectedCandidate = selected.candidate
        || observationCandidates.find((candidate) => candidate.candidateId === selected.candidateId)
        || null;
      if (!selectedCandidate) {
        const error = new Error("The schema-bound planner did not resolve a current candidate.");
        error.code = "PLANNER_CANDIDATE_NOT_CURRENT";
        throw error;
      }
      modelSelection = {
        candidateId: selectedCandidate.candidateId,
        candidate: selectedCandidate,
        confidence: selected.confidence || "unknown",
        reused: selected.reused === true,
        semanticOutcome: selected.semanticOutcome || "satisfy_current_decision"
      };
      candidateSelectionDecision = candidateSelectionCacheEntry({
        observation,
        goal: observationGoal,
        candidate: selectedCandidate,
        selection: modelSelection,
        policyFingerprint: decisionPolicyFingerprint
      });
      modelPlannedAction = bindTargetSnapshot(
        { ...actionForCurrentCandidate(observationGoal, selectedCandidate, observation), semanticOutcome: modelSelection.semanticOutcome },
        observation
      );
    } catch (error) {
      if (error?.code === "PLANNER_CANDIDATE_NOT_CURRENT" && observationCandidates.length) {
        const fallbackCandidate = deterministicTaskCandidate(candidateSet, observationGoal);
        if (fallbackCandidate) {
          modelSelection = {
            candidateId: fallbackCandidate.candidateId,
            candidate: fallbackCandidate,
            confidence: "deterministic",
            semanticOutcome: fallbackCandidate.interactionRole === "navigation"
              ? "advance_current_surface"
              : "satisfy_current_decision"
          };
          modelPlannedAction = bindTargetSnapshot(
            { ...actionForCurrentCandidate(observationGoal, fallbackCandidate, observation), semanticOutcome: modelSelection.semanticOutcome },
            observation
          );
          deterministicAction = modelPlannedAction;
        } else {
          const retryAction = normalizeAction({
            observationId: observation.observationId || "",
            observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
            type: "wait",
            intent: "retry_planner_current_candidates",
            obligationId: obligationField(observationGoal, "goalId") || "",
            reason: "Candidate grounding was rejected before browser dispatch. Retry selection against this same immutable candidate set without reobserving the page.",
            risk: "safe",
            requiresApproval: false
          });
          const plannerRecovery = updateExecutionRecovery(canonicalState, {
            kind: "planner_rejection",
            code: "PLANNER_CANDIDATE_NOT_CURRENT"
          });
          const retryState = withUpdate(plannerRecovery.state, {
            taskState,
            executionEpisode: updatedExecutionEpisode(plannerRecovery.state, { leasedAction: null }),
            lastAction: retryAction,
            status: "running"
          });
          transactionStore?.saveSession?.(retryState);
          transactionStore?.recordActionEvent?.(retryState.id, {
            observationId: observation.observationId || "",
            turnId: clientTurnId || turnId,
            stage: "planner_candidate_grounding_rejected",
            dispatched: false,
            browserReobserved: false,
            candidateCount: observationCandidates.length,
            executionEpisode: executionEpisodeFor(retryState)
          });
          return {
            state: retryState,
            clientDecision: toClientDecision(retryAction),
            debug: withLatencyDebug({
              candidateGroundingRejected: true,
              aiServiceUnavailable: false,
              candidateSet,
              finalAction: retryAction
            }, latency, modelUsageFromMetas(planningModel, [verifyPlanMeta]))
          };
        }
      } else {
        return safePlannerFailureResult({
          dataDir,
          state: canonicalState,
          turnId,
          screenshotDataUrl,
          traceObservation,
          reason: plannerFailureReason(error),
          error,
          latency,
          modelUsage: modelUsageFromMetas(model, [verifyPlanMeta])
        });
      }
    }
    modelUsage = modelUsageFromMetas(planningModel, [verifyPlanMeta]);
  }

  state = withUpdate(canonicalState, {
    taskState,
  });
  // Do not synchronously persist this intermediate planning snapshot. No
  // browser action has been governed or dispatched yet, and the authoritative
  // post-governance state is persisted below. Writing both copies duplicated
  // a large candidate graph and dominated deterministic turn latency on the
  // multi-GB replay database.

  let nextState = withUpdate(state, {
    lastVerification: verification
  });

  let plannedAction = modelPlannedAction;

  if (!plannedAction || !plannedAction.type) {
    plannedAction = normalizeAction({
      observationId: observation.observationId || "",
      observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
      type: "wait",
      intent: "rebuild_current_action_context",
      obligationId: obligationField(observationGoal, "goalId") || "",
      reason: "No executable action was compiled. Preserve the current goal and rebuild its grounded candidates without treating this as a browser failure.",
      risk: "safe",
      requiresApproval: false
    });
  }

  // 4. Govern once — schema, stored observation, canonical target,
  // actionability, policy, transaction invariants, approval, duplication.
  if (["fill_known_fields", "fill_visible_profile_fields"].includes(plannedAction.type)) {
    plannedAction = finalHandoffAction(
      "The general planner returned a deprecated compound profile action after local semantic-goal processing.",
      observation
    );
  }
  const executablePlannedAction = bindTargetSnapshot(plannedAction, observation);
  const policyStartedAt = Date.now();
  let governance = governAction({
    action: executablePlannedAction,
    state: nextState,
    observation,
    traveler,
    approvals: nextState.approvals,
    store: transactionStore,
    turnId: clientTurnId || turnId,
    preparedInvariantContext: transactionContext,
    preparedCandidateSet: candidateSet
  });
  latency.policy_ms = Date.now() - policyStartedAt;
  nextState = governance.state || nextState;

  let finalAction = executablePlannedAction;
  if (!governance.allow && governance.decision === "recoverable" && governance.code === "TARGET_OUT_OF_VIEW") {
    const scrollAction = viewportRecoveryAction(executablePlannedAction, observation, 1);
    const scrollGovernance = governAction({
      action: scrollAction,
      state: nextState,
      observation,
      traveler,
      approvals: nextState.approvals,
      store: transactionStore,
      turnId: clientTurnId || turnId,
      preparedInvariantContext: transactionContext,
      preparedCandidateSet: candidateSet
    });
    governance = scrollGovernance;
    if (scrollGovernance.allow) {
      finalAction = scrollAction;
      const revealStarted = updateExecutionRecovery(scrollGovernance.state || nextState, {
        kind: "reveal_started",
        code: "TARGET_OUT_OF_VIEW",
        sample: viewportProgressSample(executablePlannedAction, observation)
      });
      nextState = withUpdate(revealStarted.state, {
        executionEpisode: updatedExecutionEpisode(revealStarted.state, {
          leasedAction: pendingRevealAction(
            executablePlannedAction,
            1,
            modelSelection?.candidate || null,
            observationGoal
          )
        }),
        lastAction: scrollAction,
        status: "running"
      });
      transactionStore?.recordActionEvent?.(nextState.id, {
        actionId: scrollAction.id,
        observationId: observation.observationId || "",
        turnId: clientTurnId || turnId,
        stage: "pending_action_reveal_governed",
        recoveryOfActionId: executablePlannedAction.id,
        recoveryAttempts: 1,
        action: scrollAction
      });
    } else {
      finalAction = policyBlockedAction(scrollGovernance, scrollAction);
    }
  } else if (!governance.allow && governance.decision === "recoverable" && STALE_IDENTITY_CODES.has(governance.code)) {
    const groundingBudget = recoverBeforeDispatch({
      state: nextState,
      action: executablePlannedAction,
      code: governance.code
    });
    nextState = withUpdate(groundingBudget.state, {
      executionEpisode: updatedExecutionEpisode(groundingBudget.state, {
        leasedAction: null,
        staleRebind: staleActionRecoveryEntry(
          executablePlannedAction,
          modelSelection?.candidate || {},
          observationGoal,
          decisionPolicyFingerprint,
          governance.code
        )
      })
    });
    transactionStore?.recordActionEvent?.(nextState.id, {
      actionId: executablePlannedAction.id || "",
      observationId: observation.observationId || "",
      turnId: clientTurnId || turnId,
      stage: "grounding_replan",
      code: governance.code,
      dispatched: false,
      executionRecovery: groundingBudget.recovery
    });
    finalAction = normalizeAction({
      observationId: observation.observationId || "",
      observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
      type: "wait",
      intent: "reobserve_after_grounding_rejection",
      obligationId: obligationField(observationGoal, "goalId"),
      candidateId: modelSelection?.candidateId || "",
      reason: `Discard ${governance.code}, capture one fresh observation, and rebind the same safe semantic control before considering new reasoning.`,
      risk: "safe",
      requiresApproval: false
    });
  } else if (!governance.allow
    && governance.decision === "recoverable"
    && governance.code === "UNAPPROVED_SELECTED_EXTRA"
    && governance.details?.groundedReversal?.controlId) {
    nextState = withUpdate(nextState, {
      executionEpisode: updatedExecutionEpisode(nextState, { leasedAction: null }),
      currentBlocker: {
        classification: "reconcile_selected_extra",
        code: governance.code,
        ...governance.details.groundedReversal
      }
    });
    transactionStore?.recordActionEvent?.(nextState.id, {
      actionId: executablePlannedAction.id || "",
      observationId: observation.observationId || "",
      turnId: clientTurnId || turnId,
      stage: "selected_extra_reconciliation",
      code: governance.code,
      recoveryDirective: "reconcile_selected_extra",
      dispatched: false,
      groundedReversal: governance.details.groundedReversal
    });
    finalAction = normalizeAction({
      observationId: observation.observationId || "",
      observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
      type: "wait",
      intent: "reconcile_selected_extra",
      mechanicalEffect: "unknown",
      expectedPostconditions: [],
      reason: "Removing an unrequested paid option before continuing. Reobserve and rebuild the exact grounded correction.",
      risk: "safe",
      requiresApproval: false
    });
  } else if (!governance.allow) {
    finalAction = policyBlockedAction(governance, executablePlannedAction);
  }
  finalAction = bindTargetSnapshot(finalAction, observation);

  const pendingExecutableAction = governance.allow === true
    && ["click", "type", "select", "keypress", "scroll", "click_xy"].includes(finalAction.type)
    && !leasedActionFor(nextState);
  const authoritativePendingAction = pendingExecutableAction
    ? leasedActionRecord({
        action: finalAction,
        candidate: modelSelection?.candidate || null,
        goal: observationGoal,
        status: "ready"
      })
    : leasedActionFor(nextState);

  nextState = withUpdate(nextState, {
    executionEpisode: updatedExecutionEpisode(nextState, { leasedAction: authoritativePendingAction }),
    lastAction: finalAction,
    status: finalAction.type === "ask_user" || finalAction.type === "final_review" ? "awaiting_user" : "running",
    aiDecisionCache: governance.allow === true && candidateSelectionDecision
      ? {
          ...(nextState.aiDecisionCache || {}),
          candidateSelection: candidateSelectionDecision
        }
      : nextState.aiDecisionCache
  });

  const debug = withLatencyDebug(
    summarizeTurn({
      pageState: extracted.pageState,
      requirements: [],
      plannedAction,
      finalAction,
      policyDecision: governance,
      deterministicAction,
      reusedAiDecision: {
        candidateSelection: candidateSelectionReused
      },
      taskState,
      taskReadModel
    }),
    latency,
    modelUsage
  );
  latency.turn_total_ms = Date.now() - turnStartedAt;
  const traceWriteStartedAt = Date.now();
  enqueueTrace(dataDir, state.id, {
    turnId, screenshotDataUrl, observation: traceObservation, pageState: extracted.pageState, requirements: [], requirementLifecycle: [], verification,
    plannedAction, policyDecision: governance,
    executionResult: { stillMissingCount: 0 },
    debug
  });
  latency.trace_queue_ms = Date.now() - traceWriteStartedAt;
  const finalStatePersistStartedAt = Date.now();
  transactionStore?.saveSession?.(nextState);
  latency.final_state_persist_ms = Date.now() - finalStatePersistStartedAt;
  latency.turn_total_ms = Date.now() - turnStartedAt;

  return {
    state: nextState,
    clientDecision: toClientDecision(finalAction),
    debug
  };
}

module.exports = {
  runLoopTurn,
  toClientDecision,
  __private: {
    bindTargetSnapshot,
    buildControlAliasIndex,
    deterministicTaskCandidate,
    expectedOutcomeForAction,
    rebindPendingRecoveryAction,
    updateExecutionRecovery,
    applyTransitionStatus,
    leasedActionSupersededByFreshPage,
    candidateStrategySignature,
    candidateSelectionCacheEntry,
    reusableCandidateSelection,
    staleActionRecoveryEntry,
    reusableStaleActionCandidate,
    aiDecisionPolicyFingerprint,
    semanticGoalRecoveryKey,
    observationPageStateHash,
    targetLocalRecoveryScope,
    rawVerifiedCommerceReceipt,
    failedStrategySignaturesForGoal,
    groundedObservationCandidateSet,
    observationSurfaceId,
    staleIdentityRejection,
    targetSnapshotForAction,
    resolveActionControl,
  }
};
