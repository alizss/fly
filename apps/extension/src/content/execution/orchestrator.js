import { currentNavigationUrl, sanitizedNavigationUrl } from "../navigation-identity.js";

export function createExecutionOrchestrator({
  AGENT_CONTRACT,
  activeOverlayElements,
  addAgentMessage,
  agent,
  beginDestinationWait,
  buildPageMap,
  buttonText,
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
  failedLocalStrategyForDecision,
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
  rememberActionExecutionResult,
  rememberCanonicalSelectionCommitment,
  rememberChoiceVisualStateBeforeDispatch,
  rememberExactChoiceCommitment,
  rememberUnexecutedActionResult,
  renderSidebar,
  reportActionResult,
  resolveDecisionTarget,
  scrollElementWithinNearestContainer,
  setAgentActivity,
  setFieldValue,
  settleTrustedChoiceInteraction,
  showAgentCursor,
  showAgentThought,
  sleep,
  stableHash,
  targetFingerprint,
  targetLocalDispatchIdentity,
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
    logFlow("action.lifecycle.finalized", {
      actionId,
      observationId,
      resultAt: executionResult.at || "",
      verified: executionResult.verified === true,
      outcomeCode: executionResult.outcome?.code || executionResult.failureCode || "",
      resultObservationHash: executionResult.resultObservationHash || "",
      next: "fresh_observation"
    });
    await continueAfterAction(delay);
    return executionResult;
  }

  async function holdDispatchedStageExit(
    actionId,
    observationId,
    decision,
    expectedOutcome,
    afterMap = {},
    dispatchedAt = 0
  ) {
    const pendingResult = rememberUnexecutedActionResult(
      actionId,
      observationId,
      decision,
      {
        ok: false,
        code: "NAVIGATION_TRANSITION_PENDING",
        message: "The governed stage exit was dispatched once; verification is waiting for a material page change or the bounded deadline.",
        dispatched: true,
        executed: true,
        targetResolved: true,
        clickReachedPage: true,
        pageChanged: false,
        resultObservationHash: observationHashForMap(afterMap)
      }
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
      dispatchedAt,
      expectedPostconditions: [{ type: "observation_readiness", status: "READY" }],
      reobserveRetryToken: `stage_exit:${actionId}`
    });
    await reportActionResult(pendingResult);
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
    const stageExitCandidates = pageMap?.stageExit?.candidates || [];
    const readyStageExitCandidates = stageExitCandidates.filter((candidate) => {
      if (candidate.status === "ready" || candidate.executable === true) return true;
      const actuator = elementById(candidate.actuatorId || "");
      return Boolean(
        actuator
        && actuator.isConnected
        && isVisible(actuator)
        && actuator.disabled !== true
        && actuator.getAttribute?.("aria-disabled") !== "true"
      );
    });
    if (readyStageExitCandidates.length) {
      return {
        ready: true,
        source: "stage_exit_enabled",
        candidateControlIds: readyStageExitCandidates.map((candidate) => candidate.controlId).filter(Boolean)
      };
    }
    return { ready: false, source: "not_ready" };
  }

  function exactChoiceRequiresCanonicalVerification(expectedOutcome = {}, beforeMap = {}) {
    if (
      expectedOutcome.requireChargeRemoved === true
      || expectedOutcome.semanticOwnershipLinkId
      || expectedOutcome.correctionDecisionGroupId
    ) return true;
    const expectedDecisionGroupId = String(
      expectedOutcome.decisionGroupId
      || expectedOutcome.requirementId
      || ""
    );
    const group = (beforeMap.decisionGroups || []).find((item) => (
      String(item.decisionGroupId || item.requirementId || "") === expectedDecisionGroupId
    ));
    const selectedAmount = Number(group?.selectedEvidence?.structuredPrice?.amount);
    return Boolean(
      group?.selectedEvidence?.selected === true
      && (
        group.selectedEvidence.disposition === "paid"
        || (Number.isFinite(selectedAmount) && selectedAmount > 0)
      )
    );
  }

  function localExactChoiceVerification(expectedOutcome = {}, beforeMap = {}, target = null) {
    if (
      expectedOutcome.type !== "exact_free_option_selected"
      || exactChoiceRequiresCanonicalVerification(expectedOutcome, beforeMap)
      || !isChoiceSelected(target)
    ) return null;
    return {
      ok: true,
      code: "EXACT_CHOICE_LOCAL_STATE_VERIFIED",
      message: "The exact choice exposes a committed selected state on its leased actuator.",
      evidence: {
        source: "local_exact_choice_state",
        controlId: expectedOutcome.controlId || "",
        expectedSelectedControlId: expectedOutcome.expectedSelectedControlId || "",
        beforeObservationHash: observationHashForMap(beforeMap),
        afterObservationHash: "pending_canonical_observation",
        targetConnected: Boolean(target?.isConnected),
        selected: true
      },
      feedback: {
        dispatched: true,
        targetFound: Boolean(target),
        targetVisible: Boolean(target && isVisible(target)),
        dispatchSucceeded: true,
        targetReacted: true,
        selectionChanged: true,
        surfaceChanged: false,
        progressChanged: false,
        domChanged: true,
        visualChanged: false,
        navigationOccurred: false,
        overlayAppeared: false,
        validationAppeared: false,
        priceChanged: false,
        outcomeVerified: true,
        expectedOutcomeObserved: true,
        postconditionSatisfied: true
      }
    };
  }

  async function settleExactChoiceOutcome(
    target,
    decision = {},
    expectedOutcome = {},
    beforeMap = {},
    initialAfterMap = null,
    timeoutMs = 4200
  ) {
    let afterMap = initialAfterMap || agent.pageMap || beforeMap;
    let verification = verifyExpectedOutcome(expectedOutcome, beforeMap, afterMap, target);
    if (expectedOutcome.type !== "exact_free_option_selected" || verification.ok) {
      return { afterMap, verification, commitment: null };
    }
    const immediateLocalVerification = localExactChoiceVerification(expectedOutcome, beforeMap, target);
    if (immediateLocalVerification) {
      return { afterMap, verification: immediateLocalVerification, commitment: null };
    }
    const initialReadiness = exactChoiceCommitReadiness(target, decision, afterMap);
    if (initialReadiness.ready) {
      const commitment = rememberExactChoiceCommitment(target, decision, initialReadiness);
      verification = verifyExpectedOutcome(expectedOutcome, beforeMap, afterMap, target);
      if (verification.ok) return { afterMap, verification, commitment };
    }
    const startedAt = performance.now();
    while (performance.now() - startedAt < timeoutMs) {
      // Local commitment is cheap and causally exact. The caller already owns
      // the single canonical post-action observation; never rebuild the whole
      // checkout graph inside this bounded settlement loop.
      await sleep(80);
      const localVerification = localExactChoiceVerification(expectedOutcome, beforeMap, target);
      if (localVerification) {
        return { afterMap, verification: localVerification, commitment: null };
      }
      const readiness = exactChoiceCommitReadiness(target, decision, afterMap);
      if (readiness.ready) {
        const commitment = rememberExactChoiceCommitment(target, decision, readiness);
        // A custom card may expose no selected state of its own and prove the
        // commit only by enabling the exact stage exit. Compile once after
        // that causal local signal so canonical decision truth and unrelated
        // selection safeguards are both evaluated from the fresh scene.
        pageStateStore.invalidate("exact_choice_local_commitment");
        afterMap = buildPageMap();
        verification = verifyExpectedOutcome(expectedOutcome, beforeMap, afterMap, target);
        return { afterMap, verification, commitment };
      }
    }
    return { afterMap, verification, commitment: null };
  }


  function verificationFromSurfaceFeedback(expected = {}, beforeMap = {}, target = null, {
    beforeOverlaySignature = "",
    progress = null
  } = {}) {
    if (expected.mustNotIncreasePrice === true) return null;
    const allowed = new Set([
      "options_surface_appeared",
      "active_surface_dismissed",
      "active_surface_change",
      "observable_change"
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
    else if (expected.type === "observable_change") ok = overlayAppeared || overlayChanged || overlayDismissed || urlChanged;
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
    if (decision && failedLocalStrategyForDecision(decision, map || buildPageMap())) {
      logFlow("repeat_guard.blocked", {
        signature: targetLocalDispatchIdentity(decision, map || buildPageMap()).strategySignature,
        message: String(message || "")
      });
      return false;
    }
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
    const navigationLike = Boolean(decision && (
      decision.interactionRole === "navigation"
      || decision.semanticEffect === "advance"
      || /navigate|advance|continue|next_stage/.test(String(decision.intent || decision.physicalEffect || "").toLowerCase())
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
    return queryAllDeep("body *")
      .filter((element) => isVisible(element) && !element.closest("#atw-sidebar"))
      .map((element) => {
        const text = (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
        if (!text || text.length > 220) return null;
        return /select one option|select an option|choose one option|please select|required|must enter|invalid|not valid|too long|too short/i.test(text)
          ? { element, text }
          : null;
      })
      .filter(Boolean)[0] || null;
  }

  async function clickAndVerifyAdvance(element, label = "Continue", delay = 1200, options = {}) {
    if (!guardedHelperAllowed("clickAndVerifyAdvance", ["click"])) return false;
    const beforeMap = options.beforeMap || pageStateStore.observe({ reason: "before_advance" }).map;
    const governedDecision = options.decision || { action: "stop", reason: "Missing governed navigation decision." };
    const expectedOutcome = options.expectedOutcome || expectedOutcomeForDecision(governedDecision, beforeMap, element);
    addAgentMessage("assistant", `Clicking: ${label}.`);
    await showAgentThought(element, "Exit", `Act: click ${label}`, "Checking whether the page advances.");
    flashElement(element);
    const dispatchedAt = Date.now();
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
    await waitForUiSettle(700);
    const postActionObservation = await observePageStateAfterMutation("verify_advance", 900);
    let afterMap = postActionObservation.map;
    const verification = verifyExpectedOutcome(expectedOutcome, beforeMap, afterMap, element);
    let advanced = verification.ok;
    agent.pageMap = afterMap;
    const visibleBlockers = Array.isArray(afterMap.errors) ? afterMap.errors.filter(Boolean) : [];
    const transitionPending = !advanced && !visibleBlockers.length && agent.running;
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
    const actionId = options.actionId || agent.activeExecutionActionId || nextFlowId("act");
    const observationId = options.observationId || agent.activeExecutionObservationId || agent.activeObservationId || "";
    if (transitionPending && inferCheckoutSite() !== "demo") {
      await holdDispatchedStageExit(
        actionId,
        observationId,
        governedDecision,
        expectedOutcome,
        afterMap,
        dispatchedAt
      );
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
    await pageStateStore.waitForQuiet({ maxWaitMs: 260 });
    const currentObservation = mapObservationSnapshot(pageStateStore.observe({ reason: "pre_execution" }).map);
    if ((decision.observationHash && decision.observationHash !== currentObservation.snapshotHash) || observationChangedSince(map)) {
      const staleOutcome = {
        ok: false,
        code: "OBSERVATION_HASH_MISMATCH",
        reason: "The page materially changed before execution.",
        expectedHash: decision.observationHash || "",
        currentHash: currentObservation.snapshotHash || ""
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

    if (decision.risk !== "safe" && decision.needsApproval) {
      await persistControlFlowDecision({ ...decision, action: "ask_user" }, actionId, actionObservationId);
      agent.pendingApprovalRequest = decision.approvalRequest || null;
      agent.awaiting = decision.risk === "money" ? "extras" : decision.risk === "payment" ? "final" : decision.risk === "legal" ? "legal" : "manual";
      agent.running = false;
      renderSidebar("agent");
      return;
    }

    if (decision.action === "ask_user") {
      await persistControlFlowDecision(decision, actionId, actionObservationId);
      agent.pendingInputRequest = decision.inputRequest || null;
      agent.pendingApprovalRequest = decision.approvalRequest || null;
      agent.awaiting = decision.risk === "money" ? "extras" : decision.risk === "legal" ? "legal" : "manual";
      agent.running = false;
      renderSidebar("agent");
      return;
    }
    agent.pendingInputRequest = null;
    agent.pendingApprovalRequest = null;

    if (decision.action === "final_review") {
      await persistControlFlowDecision(decision, actionId, actionObservationId);
      agent.awaiting = "final";
      agent.running = false;
      renderSidebar("review");
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
      await persistControlFlowDecision(decision, actionId, actionObservationId);
      agent.running = false;
      agent.awaiting = "";
      renderSidebar("agent");
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

    let failedLocalStrategy = null;
    if (["click", "type", "select", "keypress", "click_xy"].includes(decision.action)) {
      failedLocalStrategy = failedLocalStrategyForDecision(decision, map);
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
        strategyAlreadyFailed: Boolean(failedLocalStrategy)
      }) || "deny";
      const contractValid = pipeline?.contractVersion === AGENT_CONTRACT?.CONTRACT_VERSION
        && ["normal", "bounded_recovery"].includes(executionLane);
      if (!contractValid) {
        await rejectMechanicalAction(actionId, actionObservationId, decision, {
          code: failedLocalStrategy
            ? "FAILED_STRATEGY_REUSE"
            : "CAPABILITY_EXECUTION_LANE_DENIED",
          message: "The authoritative capability contract did not survive to dispatch with valid current proof."
        });
        return;
      }
    }

    if (["click", "type", "select", "keypress", "click_xy"].includes(decision.action)) {
      if (failedLocalStrategy) {
        logFlow("repeat_guard.blocked", {
          actionId,
          observationId: actionObservationId,
          controlId: decision.controlId || "",
          operation: decision.operation || "",
          interactionMethod: decision.interactionMethod || decision.action || "",
          failedLocalStrategy
        });
        await rejectMechanicalAction(actionId, actionObservationId, decision, {
          code: "FAILED_STRATEGY_REUSE",
          message: "The identical failed actuator strategy is blocked while its target-local state is unchanged.",
          dispatched: false
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
      const surfaceEntry = currentSurfaceEntryForElement(map, target);
      const targetText = labelText(target) || target.innerText || button?.label || "";
      if (surfaceEntry?.risk === "paid") {
        agent.awaiting = "extras";
        agent.running = false;
        addAgentMessage("assistant", `I stopped before selecting a paid option: ${surfaceEntry.label}.`);
        renderSidebar("agent");
        return;
      }
      const governedAdvanceToPayment = decision.semanticEffect === "advance_to_payment"
        && expectedOutcomeForDecision(decision, map, target)?.type === "payment_entry_reached";
      if (!governedAdvanceToPayment && (button?.risk === "payment" || isDangerousActionLabel(button?.label || ""))) {
        agent.awaiting = "final";
        agent.running = false;
        addAgentMessage("assistant", "I will not click payment or final booking buttons automatically on a real site.");
        renderSidebar("review");
        return;
      }
      const alreadyCommittedOutcome = expectedOutcomeForDecision(decision, map, target);
      if (
        (
          isChoiceSelected(target)
          && (
            target.matches?.("input[type='checkbox'], input[type='radio'], [role='checkbox'], [role='radio']")
            || alreadyCommittedOutcome.type === "exact_free_option_selected"
          )
        )
        || /true/.test(target.getAttribute?.("aria-checked") || "")
      ) {
        const verification = verifyExpectedOutcome(alreadyCommittedOutcome, map, map, target);
        await finalizeGovernedAction(actionId, actionObservationId, decision, alreadyCommittedOutcome, verification, 350);
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
      if (button?.risk === "safe_continue") {
        await clickAndVerifyAdvance(target, button.label || "Continue", 1200, {
          actionId,
          observationId: actionObservationId,
          beforeMap: map,
          decision,
          expectedOutcome: expectedOutcomeForDecision(decision, map, target)
        });
        return;
      }
      const surfaceWasActive = Boolean(map.currentSurface?.type && map.currentSurface.type !== "page");
      // The canonical page surface proves there is no foreground owner, so do
      // not rescan the DOM for an overlay before dispatch. After dispatch, one
      // bounded live probe can prove that a new modal/listbox appeared.
      const beforeOverlay = surfaceWasActive ? activeOverlayElements()[0] : null;
      const beforeOverlaySignature = beforeOverlay ? overlaySignature(beforeOverlay) : "";
      const expectedOutcome = expectedOutcomeForDecision(decision, map, target);
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
      const localChoiceVerification = localExactChoiceVerification(expectedOutcome, map, target);
      const mechanicalVerification = localChoiceVerification || verificationFromSurfaceFeedback(
        expectedOutcome,
        map,
        target,
        { beforeOverlaySignature }
      );
      let afterMap = map;
      let verification = mechanicalVerification;
      if (!verification) {
        afterMap = (await observePageStateAfterMutation("verify_click", 750, {
          maxAttempts: expectedOutcome.type === "exact_free_option_selected" ? 1 : 2
        })).map;
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
    verificationFromSurfaceFeedback,
    visibleValidationElement
  };
}
