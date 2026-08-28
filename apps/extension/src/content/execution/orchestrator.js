import { currentNavigationUrl, sanitizedNavigationUrl } from "../navigation-identity.js";

export function createExecutionOrchestrator({
  AGENT_CONTRACT,
  activeOverlayElements,
  addAgentMessage,
  agent,
  beginDestinationWait,
  buildPageMap,
  buttonText,
  clearResumeMarker,
  clearExecutionContext,
  clickResolvedViewportTarget,
  clickableAncestor,
  currentSurfaceEntryForElement,
  dispatchGovernedClickMechanic,
  dispatchKey,
  elementById,
  elementId,
  elementSignature,
  expectedOutcomeForDecision,
  flashElement,
  guardedHelperAllowed,
  inferCheckoutSite,
  isChoiceSelected,
  isDangerousActionLabel,
  isDestinationReadinessDecision,
  isPaymentField,
  isVisible,
  labelText,
  logAgentEvent,
  logFlow,
  mapObservationSnapshot,
  nextFlowId,
  observationChangedSince,
  observationHashForMap,
  observePageStateAfterMutation,
  overlaySignature,
  pageSnapshot,
  pageStateStore,
  persistControlFlowDecision,
  processCheckoutAgent,
  pushActionLedger,
  queryAllDeep,
  recordAction,
  rejectMechanicalAction,
  resetAgentLoopLifecycle,
  rememberActionExecutionResult,
  rememberCanonicalSelectionCommitment,
  rememberChoiceVisualStateBeforeDispatch,
  rememberExactChoiceCommitment,
  rememberUnexecutedActionResult,
  renderSidebar,
  reportActionResult,
  resolveDecisionTarget,
  saveResumeMarker,
  scrollElementWithinNearestContainer,
  setAgentActivity,
  setFieldValue,
  settleTrustedChoiceInteraction,
  showAgentCursor,
  showAgentThought,
  sleep,
  stableHash,
  stopWatchingCheckoutChanges,
  targetFingerprint,
  traveler,
  validateResolvedTarget,
  validateVisualCoordinateTarget,
  verifyAgentStep,
  verifyExpectedOutcome,
  waitForOverlayProgress,
  waitForScrollSettle,
  waitForUiSettle,
  withChoiceCommitEvidence,
  withOverlayProgressEvidence
}) {
  const dispatchedStageExitReceipts = new Map();

  async function settleStopDecision(decision, actionId, observationId) {
    await persistControlFlowDecision(decision, actionId, observationId);
    agent.running = false;
    if (decision.userActionRequired === false) {
      // Engine-only settlement is dormant, not terminal. Preserve this exact
      // durable transaction and wake it only from fresh structural evidence.
      agent.engineReconciliationPending = true;
      agent.awaiting = "engine";
      await saveResumeMarker();
    } else {
      agent.engineReconciliationPending = false;
      agent.awaiting = "";
      stopWatchingCheckoutChanges();
      await clearResumeMarker();
    }
    renderSidebar("agent");
  }

  async function pushVerificationLedger(actionId, observationId, decision, expectedOutcome, verification) {
    const executionResult = rememberActionExecutionResult(actionId, observationId, decision, expectedOutcome, verification);
    pushActionLedger({
      actionId,
      observationId,
      stage: "verified",
      action: decision,
      expectedOutcome,
      executionResult,
      result: {
        ok: Boolean(verification.ok),
        code: verification.code,
        message: verification.message,
        evidence: verification.evidence
      }
    });
    logFlow("outcome.verify", {
      actionId,
      observationId,
      expectedOutcome,
      verification,
      executionResult
    });
    await reportActionResult(executionResult);
    return executionResult;
  }

  async function finalizeGovernedAction(actionId, observationId, decision, expectedOutcome, verification, delay = 500) {
    const executionResult = await pushVerificationLedger(
      actionId,
      observationId,
      decision,
      expectedOutcome,
      verification
    );
    const destinationLoading = executionResult.actionOutcome?.status
      === AGENT_CONTRACT?.ACTION_OUTCOME?.DESTINATION_LOADING;
    logFlow("action.lifecycle.finalized", {
      actionId,
      observationId,
      resultAt: executionResult.at || "",
      verified: executionResult.verified === true,
      outcomeCode: executionResult.outcome?.code || executionResult.failureCode || "",
      resultObservationHash: executionResult.resultObservationHash || "",
      next: destinationLoading ? "mutation_or_deadline" : "fresh_observation"
    });
    // The canonical action outcome owns post-dispatch lifecycle. Once a
    // dispatched stage exit is known to be awaiting its destination, the
    // unchanged source page cannot be sent back to the planner as a new
    // situation: doing so lets a later generic stop contradict the in-flight
    // navigation. Wake only on a material mutation or the bounded deadline.
    if (destinationLoading) {
      beginDestinationWait({
        action: "wait",
        intent: "wait_for_dispatched_stage_exit",
        semanticIntent: "wait_for_dispatched_stage_exit",
        observationId,
        actionId,
        expectedPostconditions: [{ type: "observation_readiness", status: "READY" }],
        reobserveRetryToken: `stage_exit:${actionId}`
      });
      clearExecutionContext();
      renderSidebar("agent");
      return executionResult;
    }
    await continueAfterAction(delay);
    return executionResult;
  }

  async function persistDispatchedStageExitReceipt(actionId, observationId, decision, expectedOutcome, afterMap = {}) {
    const existing = dispatchedStageExitReceipts.get(actionId);
    if (existing) return existing;
    const pendingResult = rememberActionExecutionResult(
      actionId,
      observationId,
      decision,
      expectedOutcome,
      {
        ok: false,
        code: "NAVIGATION_TRANSITION_PENDING",
        message: "The governed stage exit was dispatched once; verification is waiting for a material page change or the bounded deadline.",
        feedback: {
          dispatched: true,
          dispatchSucceeded: true,
          targetFound: true,
          targetReacted: true,
          domChanged: false,
          visualChanged: false,
          surfaceChanged: false,
          progressChanged: false,
          navigationOccurred: false
        },
        evidence: {
          afterObservationHash: observationHashForMap(afterMap)
        }
      }
    );
    pushActionLedger({
      actionId,
      observationId,
      stage: "dispatched_receipt",
      action: decision,
      expectedOutcome,
      executionResult: pendingResult
    });
    // Persist the exact dispatch before an expensive post-click scan. A full
    // navigation may destroy this document during that scan; the destination
    // must still inherit the same leased action from the durable ledger.
    await reportActionResult(pendingResult, { pageMap: afterMap, keepalive: true });
    dispatchedStageExitReceipts.set(actionId, pendingResult);
    if (dispatchedStageExitReceipts.size > 8) {
      dispatchedStageExitReceipts.delete(dispatchedStageExitReceipts.keys().next().value);
    }
    return pendingResult;
  }

  async function holdDispatchedStageExit(actionId, observationId, decision, expectedOutcome, afterMap = {}) {
    const pendingResult = await persistDispatchedStageExitReceipt(
      actionId,
      observationId,
      decision,
      expectedOutcome,
      afterMap
    );
    pushActionLedger({
      actionId,
      observationId,
      stage: "dispatched_wait",
      action: decision,
      expectedOutcome,
      executionResult: pendingResult
    });
    beginDestinationWait({
      action: "wait",
      intent: "wait_for_dispatched_stage_exit",
      semanticIntent: "wait_for_dispatched_stage_exit",
      observationId,
      actionId,
      expectedPostconditions: [{ type: "observation_readiness", status: "READY" }],
      reobserveRetryToken: `stage_exit:${actionId}`
    });
    logFlow("action.lifecycle.stage_exit_pending", {
      actionId,
      observationId,
      resultObservationHash: pendingResult.resultObservationHash || "",
      next: "mutation_or_deadline"
    });
    clearExecutionContext();
    renderSidebar("agent");
    return pendingResult;
  }


  function exactChoiceCommitReadiness(target, decision = {}, pageMap = agent.pageMap || {}) {
    if (isChoiceSelected(target)) {
      return { ready: true, source: "observed_selected_state" };
    }
    const readyStageExitCandidates = (pageMap?.stageExit?.candidates || []).filter((candidate) => (
      candidate.status === "ready" || candidate.executable === true
    ));
    if (readyStageExitCandidates.length) {
      return {
        ready: true,
        source: "stage_exit_enabled",
        candidateControlIds: readyStageExitCandidates.map((candidate) => candidate.controlId).filter(Boolean)
      };
    }
    return { ready: false, source: "not_ready" };
  }

  async function settleExactChoiceOutcome(
    target,
    decision = {},
    expectedOutcome = {},
    beforeMap = {},
    initialAfterMap = null
  ) {
    let afterMap = initialAfterMap || buildPageMap();
    let verification = verifyExpectedOutcome(expectedOutcome, beforeMap, afterMap, target);
    if (expectedOutcome.type !== "exact_free_option_selected" || verification.ok) {
      return { afterMap, verification, commitment: null };
    }
    let readiness = exactChoiceCommitReadiness(target, decision, afterMap);
    const pageReadiness = afterMap.readiness || {};
    const positivePendingEvidence = pageReadiness.documentReadyState === "loading"
      || pageReadiness.ariaBusy === true
      || Number(pageReadiness.loadingIndicatorCount || 0) > 0
      || pageReadiness.loadingTextEvidence === true;

    // One fresh reobservation is permitted only when the page positively says
    // that an asynchronous commit is pending. Stable pages are evidence now;
    // repeatedly rebuilding them cannot manufacture selection truth.
    if (!readiness.ready && positivePendingEvidence) {
      afterMap = (await observePageStateAfterMutation("verify_exact_choice_pending", 700)).map;
      verification = verifyExpectedOutcome(expectedOutcome, beforeMap, afterMap, target);
      if (verification.ok) return { afterMap, verification, commitment: null };
      readiness = exactChoiceCommitReadiness(target, decision, afterMap);
    }
    if (!readiness.ready) return { afterMap, verification, commitment: null };

    const commitment = rememberExactChoiceCommitment(target, decision, readiness);
    pageStateStore.invalidate("exact_choice_commitment");
    afterMap = (await observePageStateAfterMutation("verify_exact_choice_commitment", 700)).map;
    verification = verifyExpectedOutcome(expectedOutcome, beforeMap, afterMap, target);
    return { afterMap, verification, commitment };
  }


  function verificationFromSurfaceFeedback(expected = {}, beforeMap = {}, target = null, {
    beforeOverlaySignature = "",
    progress = null
  } = {}) {
    if (expected.mustNotIncreasePrice === true) return null;
    const allowed = new Set([
      "options_surface_appeared",
      "active_surface_dismissed",
      "active_surface_change"
    ]);
    if (!allowed.has(String(expected.type || ""))) return null;

    const afterOverlay = activeOverlayElements()[0] || null;
    const afterOverlaySignature = afterOverlay ? overlaySignature(afterOverlay) : "";
    const overlayAppeared = Boolean(
      afterOverlaySignature
      && (!beforeOverlaySignature || afterOverlaySignature !== beforeOverlaySignature)
    );
    const overlayDismissed = Boolean(beforeOverlaySignature && !afterOverlaySignature);
    const overlayChanged = Boolean(
      beforeOverlaySignature
      && afterOverlaySignature
      && beforeOverlaySignature !== afterOverlaySignature
    );
    const urlChanged = Boolean(
      expected.beforeUrl
      && currentNavigationUrl() !== sanitizedNavigationUrl(expected.beforeUrl)
    );

    let ok = false;
    if (expected.type === "options_surface_appeared") ok = overlayAppeared;
    else if (expected.type === "active_surface_dismissed") ok = overlayDismissed || progress?.ok === true;
    else if (expected.type === "active_surface_change") ok = overlayChanged || overlayDismissed || progress?.ok === true;
    if (!ok) return null;

    return {
      ok: true,
      code: "MECHANICAL_SURFACE_FEEDBACK_VERIFIED",
      message: "The governed action produced its bounded local surface transition.",
      evidence: {
        source: "live_mechanical_feedback",
        expectedType: expected.type,
        beforeObservationHash: observationHashForMap(beforeMap),
        afterObservationHash: "pending_fresh_observation",
        beforeOverlaySignature: stableHash(beforeOverlaySignature),
        afterOverlaySignature: stableHash(afterOverlaySignature),
        overlayAppeared,
        overlayDismissed,
        overlayChanged,
        urlChanged,
        progress: progress || null,
        targetConnected: Boolean(target?.isConnected)
      },
      feedback: {
        dispatched: true,
        targetFound: Boolean(target),
        targetVisible: Boolean(target && isVisible(target)),
        dispatchSucceeded: true,
        targetReacted: true,
        surfaceChanged: overlayAppeared || overlayDismissed || overlayChanged,
        overlayAppeared,
        navigationOccurred: urlChanged,
        validationAppeared: false,
        priceChanged: false,
        pageChanged: true,
        expectedOutcomeObserved: true,
        postconditionSatisfied: true
      }
    };
  }


  function repeatGuardFor(element, message, decision = null, map = agent.pageMap || null) {
    const signature = elementSignature(element);
    const actionLeaseId = String(decision?.actionId || decision?.id || "").trim();
    // A DOM signature identifies a mechanic, not an execution lease. Checkout
    // stages routinely reuse the same Continue element/markup. Only the exact
    // same governed action may be held as an in-flight duplicate; a fresh lease
    // must be allowed through and remains governed by the backend episode.
    const dispatchSignature = actionLeaseId
      ? `${signature}::action:${actionLeaseId}`
      : signature;
    const now = Date.now();
    const navigationLike = Boolean(decision && isGovernedStageExit(
      decision,
      decision.expectedOutcome || {}
    ));
    const sameSignature = dispatchSignature === agent.lastClickSignature;
    if (sameSignature) {
      agent.repeatClickCount += 1;
    } else {
      agent.lastClickSignature = dispatchSignature;
      agent.repeatClickCount = 0;
    }
    if (navigationLike && sameSignature && agent.lastClickAt && now - agent.lastClickAt < 4_000) {
      logFlow("repeat_guard.navigation_settling", {
        signature,
        actionLeaseId,
        elapsedMs: now - agent.lastClickAt,
        message: String(message || "")
      });
      return false;
    }
    agent.lastClickAt = now;
    if (agent.repeatClickCount >= 2) {
      logFlow("repeat_guard.diagnostic", {
        signature,
        actionLeaseId,
        repeatClickCount: agent.repeatClickCount,
        message: String(message || ""),
        page: pageSnapshot("repeat-guard-diagnostic")
      });
    }
    return true;
  }

  async function continueAfterAction(delay = 800) {
    logFlow("loop.schedule_next", {
      delay,
      next_loop_delay_ms: delay,
      pageAfterAction: pageSnapshot("after-action-before-next-loop"),
      lastAction: agent.actionHistory[agent.actionHistory.length - 1] || null
    });
    clearExecutionContext();
    renderSidebar("agent");
    await sleep(Math.min(Math.max(0, delay), 80));
    processCheckoutAgent();
  }

  function visibleValidationElement() {
    return queryAllDeep([
      "input:invalid",
      "select:invalid",
      "textarea:invalid",
      "[aria-invalid='true']",
      "[role='alert']",
      "[aria-live='assertive']",
      ".validation-error",
      ".field-error",
      ".error-message"
    ].join(", "))
      .filter((element) => isVisible(element) && !element.closest("#atw-sidebar"))
      .map((element) => {
        const text = (
          element.validationMessage
          || element.innerText
          || element.textContent
          || element.getAttribute?.("aria-label")
          || ""
        ).replace(/\s+/g, " ").trim();
        if (element.matches?.(":invalid, [aria-invalid='true']")) {
          return { element, text: text || "invalid control" };
        }
        if (!text || text.length > 220) return null;
        return /select one option|select an option|choose one option|please select|required|must enter|invalid|not valid|too long|too short|error/i.test(text)
          ? { element, text }
          : null;
      })
      .filter(Boolean)[0] || null;
  }

  function lightweightStageExitPendingEvidence(element, beforeMap = {}) {
    const busy = queryAllDeep(
      "[aria-busy='true'], [role='progressbar'], progress, [data-loading='true'], .loading, .loader, .spinner"
    ).some((candidate) => isVisible(candidate));
    const documentLoading = document.readyState === "loading";
    const urlChanged = Boolean(
      beforeMap.url
      && currentNavigationUrl() !== sanitizedNavigationUrl(beforeMap.url)
    );
    const targetDisabled = Boolean(
      element?.disabled
      || element?.getAttribute?.("aria-disabled") === "true"
    );
    const targetHiddenOrReplaced = Boolean(element && (!element.isConnected || !isVisible(element)));
    const materialMutation = pageStateStore.isDirty();
    const validation = visibleValidationElement();
    const pending = !validation && (
      documentLoading
      || busy
      || (materialMutation && (targetDisabled || targetHiddenOrReplaced))
    );
    return {
      pending,
      documentLoading,
      busy,
      urlChanged,
      targetDisabled,
      targetHiddenOrReplaced,
      materialMutation,
      validationText: validation?.text || ""
    };
  }

  function shouldHoldDispatchedStageExit({
    advanced = false,
    visibleBlockers = [],
    readiness = {},
    expectedOutcome = {},
    decision = {}
  } = {}) {
    const positiveLoadingEvidence = readiness.documentReadyState === "loading"
      || readiness.ariaBusy === true
      || Number(readiness.loadingIndicatorCount || 0) > 0
      || readiness.loadingTextEvidence === true;
    const dispatchedStageExit = isGovernedStageExit(decision, expectedOutcome);
    return advanced !== true
      && !(visibleBlockers || []).length
      && (positiveLoadingEvidence || dispatchedStageExit)
      && agent.running;
  }

  function isGovernedStageExit(decision = {}, expectedOutcome = {}) {
    if (decision.interactionRole === "navigation") return true;
    const exactMechanicalEffect = `${decision.mechanicalEffect || ""} ${decision.physicalEffect || ""}`.trim();
    // An explicit local mechanical effect outranks a broad legacy intent or
    // inferred postcondition. Revealing card fields is not page navigation.
    if (exactMechanicalEffect) {
      return /advance_(?:checkout_)?stage/.test(exactMechanicalEffect);
    }
    return [
      "checkout_stage_advanced",
      "current_surface_advanced",
      "stage_exit_or_feedback"
    ].includes(expectedOutcome.type)
      || /advance_(?:checkout_)?stage/.test(String(decision.semanticIntent || ""));
  }

  async function clickAndVerifyAdvance(element, label = "Continue", delay = 1200, options = {}) {
    if (!guardedHelperAllowed("clickAndVerifyAdvance", ["click"])) return false;
    const beforeMap = options.beforeMap || pageStateStore.observe({ reason: "before_advance" }).map;
    const governedDecision = options.decision || { action: "stop", reason: "Missing governed navigation decision." };
    const expectedOutcome = options.expectedOutcome || expectedOutcomeForDecision(governedDecision, beforeMap, element);
    addAgentMessage("assistant", `Clicking: ${label}.`);
    await showAgentThought(element, "Exit", `Act: click ${label}`, "Checking whether the page advances.");
    flashElement(element);
    const dispatch = await dispatchGovernedClickMechanic(element, governedDecision, {
      actionId: options.actionId || agent.activeExecutionActionId || "",
      observationId: options.observationId || agent.activeExecutionObservationId || "",
      operation: governedDecision.operation || ""
    });
    if (dispatch?.ok !== true) {
      await rejectMechanicalAction(
        options.actionId || agent.activeExecutionActionId || nextFlowId("act"),
        options.observationId || agent.activeExecutionObservationId || agent.activeObservationId || "",
        governedDecision,
        {
          code: dispatch?.code || "CLICK_DISPATCH_UNAVAILABLE",
          message: "The governed stage-exit strategy was unavailable before dispatch.",
          dispatched: false
        },
        element
      );
      return false;
    }
    pushActionLedger({
      actionId: options.actionId || agent.activeExecutionActionId || nextFlowId("act"),
      observationId: options.observationId || agent.activeExecutionObservationId || agent.activeObservationId || "",
      stage: "dispatched",
      action: governedDecision,
      targetFingerprint: targetFingerprint(element, governedDecision)
    });
    const actionId = options.actionId || agent.activeExecutionActionId || nextFlowId("act");
    const observationId = options.observationId || agent.activeExecutionObservationId || agent.activeObservationId || "";
    await persistDispatchedStageExitReceipt(
      actionId,
      observationId,
      governedDecision,
      expectedOutcome,
      beforeMap
    );
    await waitForUiSettle(700);
    const pendingEvidence = lightweightStageExitPendingEvidence(element, beforeMap);
    if (pendingEvidence.pending) {
      // A governed navigation was dispatched and the browser already exposes
      // positive transition evidence. Do not deep-scan the disappearing
      // source document and then rebuild the destination a second time. The
      // durable destination lifecycle owns the next canonical observation.
      logFlow("navigation.source_rescan_skipped", {
        actionId,
        observationId,
        evidence: pendingEvidence
      });
      await holdDispatchedStageExit(
        actionId,
        observationId,
        governedDecision,
        expectedOutcome,
        beforeMap
      );
      return false;
    }
    const postActionObservation = await observePageStateAfterMutation("verify_advance", 900);
    let afterMap = postActionObservation.map;
    const verification = verifyExpectedOutcome(expectedOutcome, beforeMap, afterMap, element);
    let advanced = verification.ok;
    agent.pageMap = afterMap;
    const visibleBlockers = [
      ...(Array.isArray(afterMap.errors) ? afterMap.errors.filter(Boolean) : []),
      ...(Array.isArray(afterMap.validationIssues) ? afterMap.validationIssues.filter(Boolean) : [])
    ];
    const readiness = afterMap.readiness || {};
    const transitionPending = shouldHoldDispatchedStageExit({
      advanced,
      visibleBlockers,
      readiness,
      expectedOutcome,
      decision: governedDecision
      // Some checkout SPAs acknowledge the click immediately and mutate the
      // route several seconds later without exposing a spinner or aria-busy.
      // A dispatched stage exit therefore remains pending until a material
      // mutation or its bounded deadline; it must not be retried or reported
      // as NO_EFFECT after the short UI-settle sample.
    });
    setAgentActivity(
      advanced ? `Advanced to ${afterMap.step.replace(/_/g, " ")}` : transitionPending ? "Waiting for the page to advance" : `${label} did not advance`,
      advanced ? "Reading the next page state" : transitionPending ? "The stage exit was dispatched once; waiting for a material page change." : "Looking for the remaining blocker"
    );
    logAgentEvent("verify_advance", {
      label,
      advanced,
      step: afterMap.step,
      errors: afterMap.errors,
      url: currentNavigationUrl(),
      verification
    });
    if (transitionPending && inferCheckoutSite() !== "demo") {
      await holdDispatchedStageExit(actionId, observationId, governedDecision, expectedOutcome, afterMap);
      return false;
    }
    if (!advanced && inferCheckoutSite() !== "demo") {
      if (agent.running) {
        addAgentMessage("assistant", `${label} did not advance, so I am rescanning and sending the updated page back to the AI.`);
        if (afterMap.errors.length) addAgentMessage("assistant", `Visible issue: ${afterMap.errors.slice(0, 2).join("; ")}.`);
        await finalizeGovernedAction(actionId, observationId, governedDecision, expectedOutcome, verification, 350);
        return false;
      }
      await pushVerificationLedger(actionId, observationId, governedDecision, expectedOutcome, verification);
      return false;
    }
    await finalizeGovernedAction(actionId, observationId, governedDecision, expectedOutcome, verification, 250);
    return true;
  }

  async function executeAgentDecision(decision, map) {
    const actionId = decision.actionId || decision.id || nextFlowId("act");
    const executionId = nextFlowId("exec");
    const observation = mapObservationSnapshot(map);
    const actionObservationId = decision.observationId || observation.observationId || agent.activeObservationId || "";
    const actionObservationHash = decision.observationHash || observation.snapshotHash || "";
    agent.activeExecutionActionId = actionId;
    agent.activeExecutionObservationId = actionObservationId;
    agent.activeExecutionDecisionAction = decision.action || "";
    logFlow("execute.start", {
      executionId,
      actionId,
      observationId: actionObservationId,
      decision: {
        source: decision.source,
        observationId: decision.observationId || "",
        observationHash: decision.observationHash || "",
        action: decision.action,
        intent: decision.intent || "",
        requirementId: decision.requirementId || "",
        targetId: decision.targetId,
        targetLabel: decision.targetLabel,
        targetSnapshot: decision.targetSnapshot || null,
        expectedOutcome: decision.expectedOutcome || null,
        value: decision.value,
        x: decision.x,
        y: decision.y,
        risk: decision.risk,
        needsApproval: decision.needsApproval,
        reason: decision.reason
      },
      backendDebug: decision.debug || agent.lastBackendDebug || null,
      observation,
      pageBefore: pageSnapshot("before-execute")
    });
    pushActionLedger({
      actionId,
      observationId: actionObservationId,
      stage: "planned",
      action: decision,
      observation,
      observationHash: actionObservationHash
    });
    logAgentEvent("execute", {
      executionId,
      actionId,
      action: decision.action,
      targetId: decision.targetId,
      risk: decision.risk,
      source: decision.source
    });
    const mechanicalDecision = ["click", "type", "select", "keypress", "scroll", "click_xy"].includes(decision.action);
    // Control-flow decisions are durable reducer outcomes, not DOM actions.
    // Page churn cannot stale, rebind, or execute them through mechanics.
    if (!mechanicalDecision) {
      const message = decision.message || "I have a next action.";
      if (!agent.messages.at(-1) || agent.messages.at(-1).text !== message) {
        addAgentMessage("assistant", message);
      }
      if (decision.reason) setAgentActivity(message, decision.reason);
      if (decision.fatalBackendFailure === true) {
        agent.running = false;
        agent.awaiting = "";
        renderSidebar("agent");
        return;
      }
      if (decision.action === "final_review") {
        await persistControlFlowDecision(decision, actionId, actionObservationId);
        agent.awaiting = "final";
        agent.running = false;
        resetAgentLoopLifecycle("card_entry_reached");
        stopWatchingCheckoutChanges();
        await clearResumeMarker();
        clearExecutionContext();
        renderSidebar("review");
        return;
      }
      if (decision.risk !== "safe" && decision.needsApproval || decision.action === "ask_user") {
        agent.running = false;
        stopWatchingCheckoutChanges();
        resetAgentLoopLifecycle("awaiting_user");
        await persistControlFlowDecision(
          decision.action === "ask_user" ? decision : { ...decision, action: "ask_user" },
          actionId,
          actionObservationId
        );
        agent.pendingInputRequest = decision.inputRequest || null;
        agent.awaiting = decision.risk === "money" ? "extras" : decision.risk === "payment" ? "final" : "manual";
        renderSidebar("agent");
        return;
      }
      if (decision.action === "save_trip") {
        await persistControlFlowDecision(decision, actionId, actionObservationId);
        agent.awaiting = "";
        agent.running = false;
        renderSidebar("saved");
        return;
      }
      if (decision.action === "stop") {
        await settleStopDecision(decision, actionId, actionObservationId);
        return;
      }
      if (decision.action === "wait") {
        if (isDestinationReadinessDecision(decision)) beginDestinationWait(decision);
        else await continueAfterAction(900);
        return;
      }
    }

    await pageStateStore.waitForQuiet({ maxWaitMs: 260 });
    const preExecutionObservation = pageStateStore.observe({ reason: "pre_execution" });
    const freshMap = preExecutionObservation.map;
    const currentObservation = mapObservationSnapshot(freshMap);
    const snapshotChanged = Boolean(
      (decision.observationHash && decision.observationHash !== currentObservation.snapshotHash)
      || observationChangedSince(map)
    );
    if (snapshotChanged) {
      const mechanicalAction = ["click", "type", "select", "keypress", "scroll", "click_xy"].includes(decision.action);
      const freshTarget = mechanicalAction && decision.action !== "click_xy"
        ? resolveDecisionTarget(decision, freshMap)
        : null;
      const freshValidation = freshTarget
        ? validateResolvedTarget(decision, freshTarget, freshMap)
        : { ok: false, code: mechanicalAction ? "CANONICAL_ACTUATOR_UNAVAILABLE" : "CONTROL_FLOW_REQUIRES_FRESH_PLAN" };
      const controlId = decision.controlId || decision.targetSnapshot?.controlId || "";
      const freshControl = (freshMap.controls || []).find((control) => control.controlId === controlId) || null;
      const desiredState = decision.desiredStateDelta?.desiredState
        || decision.pipelineContract?.requirement?.desiredStateDelta?.desiredState
        || decision.affordance?.task?.desiredStateDelta?.desiredState
        || "";
      const comparable = (value = "") => String(value || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9+]+/g, "");
      const desiredValue = decision.expectedNormalizedValue
        || decision.expectedCanonicalValue
        || decision.expectedValue
        || decision.value
        || "";
      const observedValue = freshControl?.state?.canonicalDateValue
        || freshControl?.state?.selectedValue
        || freshControl?.state?.normalizedValue
        || freshControl?.currentCanonicalValue
        || freshControl?.currentValue
        || "";
      const valueAlreadySatisfied = ["type", "select"].includes(decision.action)
        && comparable(desiredValue)
        && comparable(desiredValue) === comparable(observedValue);
      const choiceAlreadySatisfied = decision.action === "click"
        && desiredState !== "unselected"
        && isChoiceSelected(freshTarget)
        && /select_free|select_paid|selected|policy_allowed/.test(String(
          decision.semanticEffect
          || decision.desiredSemanticOutcome
          || decision.pipelineContract?.requirement?.desiredEffect
          || ""
        ).toLowerCase());
      const surfaceAlreadyRevealed = decision.operation === "open"
        && freshControl?.state?.expanded === true;
      const exactTargetStillNeedsAction = freshValidation.ok
        && !valueAlreadySatisfied
        && !choiceAlreadySatisfied
        && !surfaceAlreadyRevealed;

      if (exactTargetStillNeedsAction) {
        // Unrelated page churn must not veto an unchanged local obligation.
        // Rebind the governed action to the exact current control and let the
        // normal executor revalidate operation, foreground, hit testing, and
        // safety below.
        map = freshMap;
        agent.pageMap = freshMap;
        logFlow("execute.obligation_scoped_rebind", {
          actionId,
          observationId: actionObservationId,
          expectedHash: decision.observationHash || "",
          currentHash: currentObservation.snapshotHash || "",
          controlId,
          targetId: elementId(freshTarget),
          validation: freshValidation.code || "TARGET_REVALIDATED"
        });
      } else {
      const staleOutcome = {
        ok: false,
        code: "STALE_OBSERVATION_SUPERSEDED",
        reason: valueAlreadySatisfied || choiceAlreadySatisfied || surfaceAlreadyRevealed
          ? "The exact local obligation is already satisfied in the fresh observation."
          : "The exact local target or obligation changed before execution.",
        expectedHash: decision.observationHash || "",
        currentHash: currentObservation.snapshotHash || "",
        superseded: true,
        freshValidation
      };
      const staleResult = rememberUnexecutedActionResult(
        actionId,
        actionObservationId,
        decision,
        staleOutcome
      );
      pushActionLedger({
        actionId,
        observationId: actionObservationId,
        stage: "rejected",
        action: decision,
        observationHash: actionObservationHash,
        result: staleOutcome
      });
      logFlow("execute.stale_observation", {
        actionId,
        observationId: actionObservationId,
        expectedHash: decision.observationHash || "",
        currentHash: currentObservation.snapshotHash || "",
        before: observation,
        current: currentObservation
      });
      await reportActionResult(staleResult);
      await continueAfterAction(150);
      return;
      }
    }
    const message = decision.message || "I have a next action.";
    if (!agent.messages.at(-1) || agent.messages.at(-1).text !== message) {
      addAgentMessage("assistant", message);
    }
    if (decision.reason) {
      setAgentActivity(message, decision.reason);
    }

    if (decision.fatalBackendFailure === true) {
      // A backend exception is neither a user question nor a semantic stop.
      // Preserve the durable transaction and surface the typed failure without
      // writing an ask_user/stop outcome into its verified history.
      agent.running = false;
      agent.awaiting = "";
      renderSidebar("agent");
      return;
    }

    // final_review is an inert terminal notification. Its type already means
    // the card-entry boundary was verified; the generic risk gate must never
    // reinterpret that completed outcome as a payment approval request.
    if (decision.action === "final_review") {
      await persistControlFlowDecision(decision, actionId, actionObservationId);
      agent.awaiting = "final";
      agent.running = false;
      resetAgentLoopLifecycle("card_entry_reached");
      stopWatchingCheckoutChanges();
      await clearResumeMarker();
      clearExecutionContext();
      renderSidebar("review");
      return;
    }

    if (decision.risk !== "safe" && decision.needsApproval) {
      // Close the local executor before the durable write. A mutation watcher
      // or queued turn must never observe the old `running` flag and schedule
      // a second copy of the same question while this request is in flight.
      agent.running = false;
      stopWatchingCheckoutChanges();
      resetAgentLoopLifecycle("awaiting_user");
      await persistControlFlowDecision({ ...decision, action: "ask_user" }, actionId, actionObservationId);
      agent.awaiting = decision.risk === "money" ? "extras" : decision.risk === "payment" ? "final" : "manual";
      renderSidebar("agent");
      return;
    }

    if (decision.action === "ask_user") {
      // `ask_user` is a latched control-flow state, not an action that may be
      // replanned on page churn. Stop every local producer before persisting
      // it so one missing fact produces one question.
      agent.running = false;
      stopWatchingCheckoutChanges();
      resetAgentLoopLifecycle("awaiting_user");
      await persistControlFlowDecision(decision, actionId, actionObservationId);
      agent.pendingInputRequest = decision.inputRequest || null;
      agent.awaiting = decision.risk === "money" ? "extras" : "manual";
      renderSidebar("agent");
      return;
    }
    agent.pendingInputRequest = null;

    if (decision.action === "save_trip") {
      await persistControlFlowDecision(decision, actionId, actionObservationId);
      agent.awaiting = "";
      agent.running = false;
      renderSidebar("saved");
      return;
    }

    if (decision.action === "stop") {
      await settleStopDecision(decision, actionId, actionObservationId);
      return;
    }

    if (decision.action === "wait") {
      if (isDestinationReadinessDecision(decision)) {
        beginDestinationWait(decision);
        return;
      }
      await continueAfterAction(900);
      return;
    }

    if (decision.candidateId && ["click", "type", "select", "keypress", "click_xy"].includes(decision.action)) {
      const pipeline = decision.pipelineContract || null;
      const control = (map.controls || []).find((item) => item.controlId === decision.controlId) || {};
      const executionLane = AGENT_CONTRACT?.classifyExecutionLane?.({
        action: {
          ...decision,
          type: decision.action,
          observationId: actionObservationId,
          pipelineContract: pipeline
        },
        pipelineContract: pipeline,
        control,
        observation: {
          observationId: actionObservationId,
          page: map
        },
        // The browser verifies mechanics; it does not own retry policy.
        // Backend recovery is the sole consumer of prior canonical outcomes.
        strategyAlreadyFailed: false
      }) || "deny";
      const contractValid = pipeline?.contractVersion === AGENT_CONTRACT?.CONTRACT_VERSION
        && ["normal", "bounded_recovery"].includes(executionLane);
      if (!contractValid) {
        await rejectMechanicalAction(actionId, actionObservationId, decision, {
          code: "CAPABILITY_EXECUTION_LANE_DENIED",
          message: "The authoritative capability contract did not survive to dispatch with valid current proof."
        });
        return;
      }
    }

    if (decision.action === "scroll") {
      const amount = Number.isFinite(Number(decision.scrollY)) && Number(decision.scrollY) !== 0 ? Number(decision.scrollY) : 520;
      const targetBefore = resolveDecisionTarget(decision, map)
        || elementById(decision.targetId || decision.targetSnapshot?.id || "");
      const beforeScrollY = Math.round(window.scrollY);
      const scrollStrategy = decision.expectedOutcome?.scrollStrategy === "nearest_container"
        ? "nearest_container"
        : "target_center";
      const scrollResult = scrollElementWithinNearestContainer(targetBefore, {
        amount,
        behavior: "smooth",
        strategy: scrollStrategy,
        authority: "governed_executor"
      });
      recordAction("scroll", {
        amount,
        controlId: decision.controlId || "",
        targetId: decision.targetId || "",
        containerId: scrollResult.containerId || "",
        containerType: scrollResult.containerType || "",
        strategy: scrollResult.strategy || scrollStrategy,
        ok: scrollResult.ok
      });
      const scrollSettle = targetBefore && scrollResult.ok
        ? await waitForScrollSettle(targetBefore, { container: scrollResult.container })
        : { settled: false, timedOut: false, durationMs: 0, targetInViewport: false };
      const afterScrollY = Math.round(window.scrollY);
      const containerAfter = scrollResult.containerType === "element"
        ? Number(scrollResult.container?.scrollTop || 0)
        : afterScrollY;
      const moved = Boolean(scrollResult.moved || afterScrollY !== beforeScrollY || containerAfter !== scrollResult.before);
      const code = targetBefore
        ? "SCROLL_DISPATCHED_AWAITING_FRESH_OBSERVATION"
        : "TARGET_DISAPPEARED";
      await finalizeGovernedAction(
        actionId,
        actionObservationId,
        decision,
        decision.expectedOutcome || { type: "viewport_scrolled" },
        {
          ok: false,
          code,
          message: code === "TARGET_DISAPPEARED"
            ? "The canonical recovery target disappeared before scrolling could be dispatched."
            : "Scroll was dispatched. A fresh browser observation must confirm the target exists and is in the viewport before the pending action can resume.",
          evidence: {
            beforeScrollY,
            afterScrollY,
            containerId: scrollResult.containerId || "",
            containerType: scrollResult.containerType || "",
            containerBefore: scrollResult.before ?? null,
            containerAfter,
            scrollStrategy: scrollResult.strategy || scrollStrategy,
            moved,
            scrollSettled: scrollSettle.settled,
            scrollSettleTimedOut: scrollSettle.timedOut,
            scrollSettleDurationMs: scrollSettle.durationMs,
            controlId: decision.controlId || "",
            targetFoundBefore: Boolean(targetBefore),
            requiresFreshObservation: true
          }
        },
        0
      );
      return;
    }

    if (decision.action === "keypress") {
      const requestedKey = String(decision.keys || decision.value || "");
      const key = /escape/i.test(requestedKey)
        ? "Escape"
        : /enter/i.test(requestedKey)
          ? "Enter"
          : /arrowdown/i.test(requestedKey)
            ? "ArrowDown"
            : /arrowup/i.test(requestedKey)
              ? "ArrowUp"
              : /space/i.test(requestedKey)
                ? " "
              : "";
      if (!key) {
        agent.awaiting = "manual";
        agent.running = false;
        addAgentMessage("assistant", "The AI requested an unsupported keypress, so I stopped.");
        renderSidebar("agent");
        return;
      }
      const target = resolveDecisionTarget(decision, map);
      if (!target || isPaymentField(target)) {
        await rejectMechanicalAction(actionId, actionObservationId, decision, {
          code: "CANONICAL_ACTUATOR_UNAVAILABLE",
          message: "The governed keyboard strategy has no safe live target."
        });
        return;
      }
      const validation = validateResolvedTarget(decision, target, map);
      if (!validation.ok) {
        await rejectMechanicalAction(actionId, actionObservationId, decision, {
          code: validation.code,
          message: "The governed keyboard target failed live validation.",
          expected: validation.expected,
          live: validation.live
        }, target);
        return;
      }
      pushActionLedger({
        actionId,
        observationId: actionObservationId,
        stage: "target_resolved",
        action: decision,
        targetFingerprint: targetFingerprint(target, decision)
      });
      target.focus?.({ preventScroll: true });
      pushActionLedger({
        actionId,
        observationId: actionObservationId,
        stage: "dispatched",
        action: decision,
        targetFingerprint: targetFingerprint(target, decision)
      });
      dispatchKey(target, key);
      recordAction("keypress", { key, targetId: decision.targetId || "" });
      await waitForUiSettle(500);
      const afterMap = (await observePageStateAfterMutation("verify_keypress", 650)).map;
      const expectedOutcome = expectedOutcomeForDecision(decision, map, target);
      const verification = verifyExpectedOutcome(expectedOutcome, map, afterMap, target);
      await finalizeGovernedAction(actionId, actionObservationId, decision, expectedOutcome, verification, 350);
      return;
    }

    if (decision.action === "fill_known_fields" || decision.action === "fill_visible_profile_fields") {
      agent.awaiting = "manual";
      agent.running = false;
      addAgentMessage("assistant", "The backend sent an unexpanded mutating skill. I stopped because every field change must now be an atomic governed action.");
      renderSidebar("agent");
      return;
    }

    if (decision.action === "click_xy") {
      const targetResolutionStartedAt = performance.now();
      logFlow("latency.span", {
        target_resolution_ms: Math.round(performance.now() - targetResolutionStartedAt),
        actionId,
        action: decision.action,
        method: "coordinate"
      });
      const x = Number(decision.x);
      const y = Number(decision.y);
      if (decision.x == null || decision.y == null || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) {
        await rejectMechanicalAction(actionId, actionObservationId, decision, {
          code: "INVALID_CLICK_COORDINATE",
          message: "The governed coordinate is outside the current viewport."
        });
        return;
      }
      const hit = document.elementFromPoint(x, y);
      const target = clickableAncestor(hit) || hit;
      if (!target || target.closest?.("#atw-sidebar") || isPaymentField(target)) {
        agent.awaiting = "manual";
        agent.running = false;
        addAgentMessage("assistant", "The coordinate target is unavailable or sensitive, so I stopped.");
        renderSidebar("agent");
        return;
      }
      const coordinateValidation = validateVisualCoordinateTarget(decision, target, map);
      if (!coordinateValidation.ok) {
        logFlow("target.validation_failed", {
          actionId,
          observationId: actionObservationId,
          code: coordinateValidation.code,
          expected: coordinateValidation.expected,
          live: coordinateValidation.live
        });
        await rejectMechanicalAction(actionId, actionObservationId, decision, {
          code: coordinateValidation.code,
          message: "The governed visual region failed live validation.",
          expected: coordinateValidation.expected,
          live: coordinateValidation.live
        }, target);
        return;
      }
      const dispatchTarget = coordinateValidation.dispatchTarget || target;
      const targetLabel = decision.targetLabel || decision.value || buttonText(dispatchTarget) || labelText(dispatchTarget);
      if (isDangerousActionLabel(targetLabel)) {
        agent.awaiting = "final";
        agent.running = false;
        addAgentMessage("assistant", "I will not click payment or final booking coordinates automatically.");
        renderSidebar("review");
        return;
      }
      await showAgentThought(dispatchTarget, "Act", `Click visible point`, targetLabel ? `Target: ${targetLabel}` : "Coordinate fallback on the active visual surface.", 700);
      pushActionLedger({
        actionId,
        observationId: actionObservationId,
        stage: "target_resolved",
        action: decision,
        targetFingerprint: targetFingerprint(dispatchTarget, decision),
        expectedOutcome: expectedOutcomeForDecision(decision, map, dispatchTarget)
      });
      showAgentCursor(dispatchTarget, targetLabel || "click point");
      flashElement(dispatchTarget);
      pushActionLedger({
        actionId,
        observationId: actionObservationId,
        stage: "dispatched",
        action: decision,
        targetFingerprint: targetFingerprint(dispatchTarget, decision)
      });
      clickResolvedViewportTarget(dispatchTarget, Math.round(x), Math.round(y), {
        actionId,
        observationId: actionObservationId,
        source: coordinateValidation.expected?.source || ""
      });
      recordAction("click_xy", { x: Math.round(x), y: Math.round(y), label: targetLabel });
      await waitForUiSettle(700);
      {
        const afterMap = (await observePageStateAfterMutation("verify_coordinate_click", 750)).map;
        const expectedOutcome = expectedOutcomeForDecision(decision, map, dispatchTarget);
        const verification = verifyExpectedOutcome(expectedOutcome, map, afterMap, dispatchTarget);
        await finalizeGovernedAction(actionId, actionObservationId, decision, expectedOutcome, verification, 500);
      }
      return;
    }

    if (decision.action === "click") {
      const targetResolutionStartedAt = performance.now();
      const target = resolveDecisionTarget(decision, map);
      logFlow("latency.span", {
        target_resolution_ms: Math.round(performance.now() - targetResolutionStartedAt),
        actionId,
        action: decision.action,
        method: target ? "resolved" : "not_found",
        target: decision.controlId || decision.targetId || decision.targetLabel || decision.value || ""
      });
      if (!target) {
        await rejectMechanicalAction(actionId, actionObservationId, decision, {
          code: "CANONICAL_ACTUATOR_UNAVAILABLE",
          message: "The planned canonical control has no valid live actuator in the fresh observation."
        });
        return;
      }
      const validation = validateResolvedTarget(decision, target, map);
      if (!validation.ok) {
        logFlow("target.validation_failed", {
          actionId,
          observationId: actionObservationId,
          code: validation.code,
          expected: validation.expected,
          live: validation.live,
          decision: {
            targetId: decision.targetId,
            targetLabel: decision.targetLabel,
            value: decision.value
          }
        });
        await showAgentThought(
          target,
          "Verify",
          "Rejecting stale target",
          `The planned target no longer matches the live control (${validation.code}). Re-observing instead of clicking.`,
          650
        );
        await rejectMechanicalAction(actionId, actionObservationId, decision, {
          code: validation.code,
          message: "The governed canonical target failed live validation.",
          expected: validation.expected,
          live: validation.live
        }, target);
        return;
      }
      pushActionLedger({
        actionId,
        observationId: actionObservationId,
        stage: "target_resolved",
        action: decision,
        targetFingerprint: targetFingerprint(target, decision),
        expectedOutcome: expectedOutcomeForDecision(decision, map, target)
      });
      const resolvedTargetId = elementId(target);
      const button = map.buttons.find((item) => item.id === decision.targetId || item.id === resolvedTargetId);
      const canonicalControl = (map.controls || []).find((item) => (
        item.controlId === decision.controlId
        || item.controlId === decision.targetSnapshot?.controlId
      )) || null;
      const surfaceEntry = currentSurfaceEntryForElement(map, target);
      const targetText = labelText(target) || target.innerText || button?.label || "";
      if (surfaceEntry?.risk === "paid") {
        agent.awaiting = "extras";
        agent.running = false;
        addAgentMessage("assistant", `I stopped before selecting a paid option: ${surfaceEntry.label}.`);
        renderSidebar("agent");
        return;
      }
      const canonicalEffect = String([
        decision.mechanicalEffect,
        decision.physicalEffect,
        decision.targetSnapshot?.physicalEffect,
        canonicalControl?.physicalEffect,
        canonicalControl?.semantic
      ].filter(Boolean).join(" ")).toLowerCase();
      const canonicalPurchaseCommit = decision.risk === "payment"
        || canonicalControl?.risk === "payment"
        || /submit_purchase|enter_payment_credentials|confirm_purchase|complete_purchase|book_now|pay_now/.test(canonicalEffect);
      if (canonicalPurchaseCommit) {
        agent.awaiting = "final";
        agent.running = false;
        addAgentMessage("assistant", "I will not enter payment credentials or submit a purchase automatically.");
        renderSidebar("review");
        return;
      }
      if ((target.matches?.("input[type='checkbox'], input[type='radio'], [role='checkbox'], [role='radio']") && isChoiceSelected(target))
        || /true/.test(target.getAttribute?.("aria-checked") || "")) {
        const expectedOutcome = expectedOutcomeForDecision(decision, map, target);
        const verification = verifyExpectedOutcome(expectedOutcome, map, map, target);
        await finalizeGovernedAction(actionId, actionObservationId, decision, expectedOutcome, verification, 350);
        return;
      }
      // Diagnostic only. The shared execution-lane gate above consumes the
      // page-scoped failed-strategy memory and is the sole dispatch authority.
      const repeatAllowed = repeatGuardFor(target, "The same failed local strategy was observed diagnostically.", decision, map);
      if (!repeatAllowed) {
        const settlingResult = rememberUnexecutedActionResult(
          actionId,
          actionObservationId,
          decision,
          {
            ok: false,
            code: "DUPLICATE_ACTION_PENDING_OBSERVATION",
            message: "An identical navigation action was dispatched recently; reobserve before retrying.",
            retryable: true
          }
        );
        await reportActionResult(settlingResult);
        await continueAfterAction(500);
        return;
      }
      const expectedOutcome = expectedOutcomeForDecision(decision, map, target);
      // The canonical action contract owns lifecycle routing. A presentation
      // button model may be missing or stale after framework rerenders, but it
      // cannot demote a governed stage exit into an ordinary click whose
      // dispatch receipt would be lost during cross-document navigation.
      if (isGovernedStageExit(decision, expectedOutcome)) {
        await clickAndVerifyAdvance(target, button.label || "Continue", 1200, {
          actionId,
          observationId: actionObservationId,
          beforeMap: map,
          decision,
          expectedOutcome
        });
        return;
      }
      const surfaceWasActive = Boolean(map.currentSurface?.type && map.currentSurface.type !== "page");
      // The canonical page surface proves there is no foreground owner, so do
      // not rescan the DOM for an overlay before dispatch. After dispatch, one
      // bounded live probe can prove that a new modal/listbox appeared.
      const beforeOverlay = surfaceWasActive ? activeOverlayElements()[0] : null;
      const beforeOverlaySignature = beforeOverlay ? overlaySignature(beforeOverlay) : "";
      showAgentCursor(target, button?.label || "clicking");
      flashElement(target);
      rememberChoiceVisualStateBeforeDispatch(target, decision);
      rememberCanonicalSelectionCommitment(target, decision);
      const clickDispatch = await dispatchGovernedClickMechanic(target, decision, {
        actionId,
        observationId: actionObservationId,
        operation: decision.operation || ""
      });
      if (clickDispatch?.ok !== true) {
        await rejectMechanicalAction(actionId, actionObservationId, decision, {
          code: clickDispatch?.code || "CLICK_DISPATCH_UNAVAILABLE",
          message: "The governed click mechanic was unavailable before dispatch.",
          dispatched: false
        }, target);
        return;
      }
      let choiceCommitResult = clickDispatch.choiceCommitResult || null;
      const customChoiceEpisode = Boolean(
        !choiceCommitResult
        && !target.matches?.("input[type='checkbox'], input[type='radio']")
        && (
          decision.interactionRole === "choice"
          || decision.semanticEffect === "select"
          || ["choose", "select"].includes(decision.operation)
        )
      );
      if (customChoiceEpisode) {
        choiceCommitResult = await settleTrustedChoiceInteraction(target, {
          ...decision,
          actionId,
          observationId: actionObservationId
        });
      }
      pushActionLedger({
        actionId,
        observationId: actionObservationId,
        stage: "dispatched",
        action: decision,
        targetFingerprint: targetFingerprint(target, decision)
      });
      if (surfaceWasActive) {
        const progress = await waitForOverlayProgress(beforeOverlay, beforeOverlaySignature, 2200);
        const verification = verificationFromSurfaceFeedback(
          expectedOutcome,
          map,
          target,
          { beforeOverlaySignature, progress }
        ) || verifyExpectedOutcome(
          expectedOutcome,
          map,
          (await observePageStateAfterMutation("verify_foreground_action", 650)).map,
          target
        );
        const verifiedResult = withChoiceCommitEvidence(
          withOverlayProgressEvidence(verification, progress),
          choiceCommitResult,
          expectedOutcome,
          decision
        );
        await pushVerificationLedger(actionId, actionObservationId, decision, expectedOutcome, verifiedResult);
        await verifyAgentStep(
          target,
          "Interrupt",
          verifiedResult.ok ? verifiedResult.message : `expected outcome not observed${progress.ok ? ` (surface ${progress.reason})` : ""}`,
          verifiedResult.ok,
          650
        );
        if (!verifiedResult.ok) {
          addAgentMessage("assistant", `The active surface changed, but the exact expected outcome was not verified (${verifiedResult.code || "OUTCOME_NOT_VERIFIED"}). I am rescanning instead of marking it done.`);
          await continueAfterAction(450);
          return;
        }
        await continueAfterAction(500);
        return;
      }
      await waitForUiSettle(800);
      const mechanicalVerification = verificationFromSurfaceFeedback(
        expectedOutcome,
        map,
        target,
        { beforeOverlaySignature }
      );
      let afterMap = map;
      let verification = mechanicalVerification;
      if (!verification) {
        afterMap = (await observePageStateAfterMutation("verify_click", 750)).map;
        verification = verifyExpectedOutcome(expectedOutcome, map, afterMap, target);
      }
      if (!verification.ok && expectedOutcome.type === "exact_free_option_selected") {
        const settledChoice = await settleExactChoiceOutcome(
          target,
          decision,
          expectedOutcome,
          map,
          afterMap
        );
        afterMap = settledChoice.afterMap;
        verification = settledChoice.verification;
      }
      const verifiedResult = withChoiceCommitEvidence(
        verification,
        choiceCommitResult,
        expectedOutcome,
        decision
      );
      await finalizeGovernedAction(actionId, actionObservationId, decision, expectedOutcome, verifiedResult, 900);
      return;
    }

    if (decision.action === "type" || decision.action === "select") {
      const targetResolutionStartedAt = performance.now();
      const target = resolveDecisionTarget(decision, map);
      logFlow("latency.span", {
        target_resolution_ms: Math.round(performance.now() - targetResolutionStartedAt),
        actionId,
        action: decision.action,
        method: target ? "resolved" : "not_found",
        target: decision.controlId || decision.targetId || decision.targetLabel || decision.value || ""
      });
      if (!target || isPaymentField(target)) {
        if (target && isPaymentField(target)) {
          agent.awaiting = "manual";
          agent.running = false;
          addAgentMessage("assistant", "The requested field is sensitive, so I stopped before changing it.");
          renderSidebar("agent");
        } else {
          await rejectMechanicalAction(actionId, actionObservationId, decision, {
            code: "CANONICAL_ACTUATOR_UNAVAILABLE",
            message: "The canonical field has no live actuator for this operation."
          });
        }
        return;
      }
      if (decision.action === "select" && target.tagName !== "SELECT") {
        await rejectMechanicalAction(actionId, actionObservationId, decision, {
          code: "ACTION_OPERATION_ACTUATOR_MISMATCH",
          message: "A select operation resolved to a non-native select actuator."
        }, target);
        return;
      }
      const validation = validateResolvedTarget(decision, target, map);
      if (!validation.ok) {
        logFlow("target.validation_failed", {
          actionId,
          observationId: actionObservationId,
          code: validation.code,
          expected: validation.expected,
          live: validation.live
        });
        await rejectMechanicalAction(actionId, actionObservationId, decision, {
          code: validation.code,
          message: "The governed field actuator failed live validation.",
          expected: validation.expected,
          live: validation.live
        }, target);
        return;
      }
      const governedValue = decision.value === "profile://document_number"
        ? String(
            agent.sessionProfileOverrides?.passport_number
            || agent.sessionProfileOverrides?.document_number
            || traveler()?.document?.document_number
            || ""
          )
        : decision.value || "";
      if (decision.value === "profile://document_number" && !governedValue) {
        agent.awaiting = "manual";
        agent.running = false;
        addAgentMessage("assistant", "The governed document field has no saved local document value, so I stopped.");
        renderSidebar("agent");
        return;
      }
      const resolveLiveElement = () => {
        const freshMap = pageStateStore.observe({ reason: "field_rebind" }).map;
        const stableKey = decision.stableKey || decision.targetSnapshot?.stableKey || "";
        return resolveDecisionTarget({
          action: decision.action,
          operation: decision.operation,
          controlId: decision.controlId || decision.targetSnapshot?.controlId || "",
          stableKey,
          targetSnapshot: {
            controlId: decision.controlId || decision.targetSnapshot?.controlId || "",
            stableKey
          }
        }, freshMap);
      };
      pushActionLedger({
        actionId,
        observationId: actionObservationId,
        stage: "dispatched",
        action: decision,
        targetFingerprint: targetFingerprint(target, decision)
      });
      const result = await setFieldValue(target, governedValue, {
        fieldType: decision.action,
        exactOption: decision.exactOption || decision.pipelineContract?.component?.exactOption || null,
        resolveLiveElement,
        // The governed action lifecycle below emits the one authoritative
        // result. The low-level setter must not independently POST a second
        // anonymous field-fill result for the same operation.
        reportResult: false
      });
      if (!result.ok) {
        await rejectMechanicalAction(actionId, actionObservationId, decision, {
          code: "FIELD_VALUE_NOT_VERIFIED",
          message: `The ${decision.action} operation did not retain the governed value.`,
          dispatched: true,
          targetResolved: true,
          details: result
        }, target);
        return;
      }
      {
        const afterMap = (await observePageStateAfterMutation("verify_field_change", 650)).map;
        const expectedOutcome = expectedOutcomeForDecision(decision, map, target);
        const verification = verifyExpectedOutcome(expectedOutcome, map, afterMap, target);
        await finalizeGovernedAction(actionId, actionObservationId, decision, expectedOutcome, verification, 500);
      }
      return;
    }

    agent.awaiting = "manual";
    agent.running = false;
    renderSidebar("agent");
  }

  // ---- Observer Mode: page-understanding projection (read-only, no actions) ----


  return {
    clickAndVerifyAdvance,
    continueAfterAction,
    exactChoiceCommitReadiness,
    executeAgentDecision,
    finalizeGovernedAction,
    holdDispatchedStageExit,
    pushVerificationLedger,
    repeatGuardFor,
    settleExactChoiceOutcome,
    shouldHoldDispatchedStageExit,
    verificationFromSurfaceFeedback,
    visibleValidationElement
  };
}
