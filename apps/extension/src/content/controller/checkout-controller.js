export function createCheckoutController({
  addAgentMessage,
  agent,
  announceSectionQueue,
  beginAgentLoop,
  buildPageUnderstanding,
  clearResumeMarker,
  describePageMap,
  executeAgentDecision,
  finishAgentLoop,
  logAgentEvent,
  logFlow,
  outlineCoreSections,
  pageStateStore,
  persistControlFlowDecision,
  rememberPagePlan,
  renderSidebar,
  requestAgentDecision,
  resetAgentSessionState,
  resetAgentLoopLifecycle,
  resetFieldProgress,
  runRiskChecks,
  saveResumeMarker,
  setAgentActivity,
  setWarnings,
  shouldAutoDeclinePaidExtras,
  showAgentThought,
  sleep,
  startWatchingCheckoutChanges,
  startAgentSession,
  stopWatchingCheckoutChanges,
  travelerRules
}) {
  async function observePageOnly() {
    agent.running = false;
    agent.awaiting = "";
    agent.messages = [];
    agent.reasoningLog = [];
    agent.actionHistory = [];
    agent.processDiagnostics = null;
    agent.observerTab = agent.observerTab || "summary";
    setAgentActivity("Observing page (no actions will be taken)", travelerRules() || "Using saved traveler profile");
    agent.pageMap = pageStateStore.observe({ forceFull: true, reason: "observe_only" }).map;
    const map = agent.pageMap;
    const started = Date.now();
    agent.pageUnderstanding = buildPageUnderstanding(map);
    agent.pageUnderstanding.debug.latencyMs = Date.now() - started;
    outlineCoreSections(map.sections || []);
    renderSidebar("observer");
    logAgentEvent("observe_only", {
      pageType: agent.pageUnderstanding.pageIdentity.pageType,
      pageConfidence: agent.pageUnderstanding.pageIdentity.confidence,
      sections: agent.pageUnderstanding.sections.map((s) => ({ label: s.label, type: s.type, status: s.status })),
      options: agent.pageUnderstanding.options.length,
      warnings: agent.pageUnderstanding.warnings.length
    });
  }

  function setObserverTab(tab) {
    agent.observerTab = tab;
    renderSidebar("observer");
  }

  async function takeOverCheckout() {
    if (agent.engineReconciliationPending && agent.sessionId) {
      const existingSessionId = agent.sessionId;
      const session = await startAgentSession(existingSessionId, { validateBeforeObservation: true });
      if (!session || agent.sessionId !== existingSessionId) return false;
      agent.engineReconciliationPending = false;
      agent.running = true;
      agent.awaiting = "";
      startWatchingCheckoutChanges();
      await saveResumeMarker();
      setAgentActivity(
        "Continuing the existing checkout session",
        "Re-observing the current page without creating a replacement transaction."
      );
      processCheckoutAgent();
      return true;
    }
    if (agent.running || agent.loopBusy) {
      logFlow("loop.start_duplicate_suppressed", {
        activeLoopRunId: agent.activeLoopRunId,
        lifecycleId: agent.lifecycleId
      });
      return true;
    }
    resetAgentLoopLifecycle("start_agent");
    resetAgentSessionState();
    agent.running = true;
    agent.sessionId = "";
    agent.awaiting = "";
    agent.messages = [];
    agent.reasoningLog = [];
    agent.lastClickSignature = "";
    agent.repeatClickCount = 0;
    agent.lastClickAt = 0;
    agent.skipPaidExtrasApproved = false;
    agent.autopilotMode = true;
    agent.pendingUserMessage = "";
    agent.pendingUserResponse = null;
    agent.pendingInputRequest = null;
    agent.sessionProfileOverrides = {};
    agent.skipPaidExtrasApproved = shouldAutoDeclinePaidExtras();
    agent.actionHistory = [];
    agent.processDiagnostics = null;
    resetFieldProgress();
    setAgentActivity("Starting checkout agent", travelerRules() || "Using saved traveler profile");
    agent.pageMap = pageStateStore.observe({ forceFull: true, reason: "agent_start" }).map;
    const session = await startAgentSession();
    if (!session || !agent.sessionId) {
      stopWatchingCheckoutChanges();
      agent.running = false;
      agent.awaiting = "";
      await clearResumeMarker();
      setAgentActivity(
        "Checkout not started",
        agent.sessionStartFailure?.message || "A durable checkout session could not be established."
      );
      renderSidebar("ready");
      return false;
    }
    startWatchingCheckoutChanges();
    await saveResumeMarker();
    addAgentMessage("assistant", `${describePageMap(agent.pageMap)} I will work step by step and ask when money, payment, or uncertainty appears.`);
    renderSidebar("agent");
    await announceSectionQueue();
    await sleep(650);
    processCheckoutAgent();
    return true;
  }

  async function resumeCheckoutAfterNavigation(marker) {
    resetAgentLoopLifecycle("resume_after_navigation");
    agent.running = true;
    agent.engineReconciliationPending = false;
    agent.sessionId = "";
    agent.awaiting = "";
    agent.messages = [];
    agent.reasoningLog = [];
    agent.lastClickSignature = "";
    agent.repeatClickCount = 0;
    agent.lastClickAt = 0;
    agent.skipPaidExtrasApproved = Boolean(marker.skipPaidExtrasApproved);
    agent.autopilotMode = true;
    agent.pendingUserMessage = "";
    agent.pendingUserResponse = null;
    agent.pendingInputRequest = null;
    agent.sessionProfileOverrides = {};
    agent.actionHistory = [];
    agent.processDiagnostics = null;
    resetFieldProgress();
    setAgentActivity("Continuing checkout agent after page change", travelerRules() || "Using saved traveler profile");
    const resumeSessionId = String(marker.sessionId || "");
    // Session authority comes before page perception. A stale marker must not
    // earn a multi-second main-thread scan merely because the local server is
    // reachable.
    const session = resumeSessionId
      ? await startAgentSession(resumeSessionId, { validateBeforeObservation: true })
      : null;
    if (!session || agent.sessionId !== resumeSessionId) {
      stopWatchingCheckoutChanges();
      agent.running = false;
      agent.awaiting = "manual";
      await clearResumeMarker();
      addAgentMessage("assistant", "The prior checkout session could not be resumed, so I left this page dormant.");
      renderSidebar("ready");
      return;
    }
    if (session.status === "awaiting_user") {
      stopWatchingCheckoutChanges();
      agent.running = false;
      agent.awaiting = "manual";
      await clearResumeMarker();
      addAgentMessage(
        "assistant",
        session.lastAction?.reason || "This checkout is still waiting for your previous answer."
      );
      renderSidebar("ready");
      return;
    }
    // Let initial framework work land before the first planning observation.
    // processCheckoutAgent owns that one observation; doing a separate resume
    // scan here made every cross-document advance scan the same large airline
    // page twice before it could plan.
    await sleep(650);
    startWatchingCheckoutChanges();
    await saveResumeMarker();
    addAgentMessage("assistant", "Picking back up where I left off after the page changed.");
    renderSidebar("agent");
    // Yield once so the passive sidebar can paint before the observation loop
    // performs its one intentional semantic scan on a large checkout page.
    await sleep(0);
    processCheckoutAgent();
  }

  async function processCheckoutAgent() {
    if (!agent.running) return;
    if (!agent.sessionId) {
      stopWatchingCheckoutChanges();
      agent.running = false;
      agent.awaiting = "manual";
      addAgentMessage("assistant", "The durable checkout session is missing, so I stopped before observing or acting.");
      renderSidebar("agent");
      return;
    }
    const loopToken = beginAgentLoop();
    if (!loopToken) return;
    let shouldRerun = false;
    try {
      setWarnings(runRiskChecks());
      await showAgentThought(
        null,
        "Observe",
        "Backend planner",
        "Reading the current page and sending it to the backend before taking any checkout action.",
        120
      );
      if (loopToken.lifecycleId !== agent.lifecycleId || !agent.running) return;
      const observationStartedAt = performance.now();
      const observed = await pageStateStore.observeFresh({
        reason: "planning_turn",
        maxWaitMs: 650,
        maxAttempts: 2,
        postBuildGraceMs: 100
      });
      if (!observed.fresh) {
        logFlow("planning.stale_observation_deferred", {
          attempts: observed.freshnessAttempts,
          mutationVersion: observed.mutationVersion,
          observation_build_ms: observed.timings?.observationBuildMs || 0
        });
        setAgentActivity(
          "Waiting for one fresh page state",
          "The checkout changed while I was reading it. I will observe again instead of planning from mixed state."
        );
        agent.loopRerunQueued = true;
        return;
      }
      const stableMap = rememberPagePlan(observed.map);
      agent.pageMap = stableMap;
      const observationBuildMs = observed.timings.observationBuildMs;
      const observationElapsedMs = Math.round(performance.now() - observationStartedAt);
      logFlow("latency.span", {
        observation_build_ms: observationBuildMs,
        observation_mode: observed.mode,
        observation_total_ms: observationElapsedMs,
        observation_freshness_attempts: observed.freshnessAttempts,
        mutation_version: observed.mutationVersion,
        material: observed.material,
        step: stableMap.step,
        controls: stableMap.controls?.length || 0,
        fields: stableMap.fields?.length || 0,
        buttons: stableMap.buttons?.length || 0
      });
      if (stableMap.graphIntegrity && !stableMap.graphIntegrity.ok) {
        logFlow("control.graph_conflicts_diagnostic", {
          actionableConflictCount: Number(stableMap.graphIntegrity.actionableConflictCount || 0),
          diagnosticConflictCount: Number(stableMap.graphIntegrity.diagnosticConflictCount || 0),
          conflicts: (stableMap.graphIntegrity.conflicts || []).slice(0, 8)
        });
      }

      const userMessage = agent.pendingUserMessage;
      const userResponse = agent.pendingUserResponse;
      agent.pendingUserMessage = "";
      agent.pendingUserResponse = null;
      const decision = await requestAgentDecision(
        stableMap,
        userMessage,
        {
          observation_build_ms: observationBuildMs,
          observation_mode: observed.mode,
          observation_diff: observed.diff,
          base_snapshot_hash: observed.baseSnapshotHash
        },
        loopToken,
        userResponse
      );
      if (!decision || loopToken.lifecycleId !== agent.lifecycleId || !agent.running) return;
      await executeAgentDecision(decision, stableMap);
    } finally {
      shouldRerun = finishAgentLoop(loopToken);
      if (shouldRerun) {
        setTimeout(() => processCheckoutAgent(), 0);
      }
    }
  }

  async function handleAgentChoice(choice) {
    logAgentEvent("user_choice", { choice });
    if (choice === "skip_extras") {
      addAgentMessage("user", "Skip extras.");
      agent.skipPaidExtrasApproved = true;
      document.querySelector("[data-demo-skip-extras]")?.click();
      agent.awaiting = "";
      agent.running = true;
      agent.pendingUserMessage = "Use my saved no-extras preference and continue safely.";
      await processCheckoutAgent();
    }

    if (choice === "add_bag") {
      addAgentMessage("user", "Add cabin bag.");
      document.querySelector("[data-demo-add-bag]")?.click();
      agent.awaiting = "";
      renderSidebar("agent");
      await sleep(600);
      processCheckoutAgent();
    }

    if (choice === "confirm_pay") {
      addAgentMessage("user", "Confirm demo payment.");
      const demoPay = document.querySelector("[data-demo-pay]");
      if (demoPay) {
        demoPay.click();
        await sleep(500);
        processCheckoutAgent();
      } else {
        addAgentMessage("assistant", "I will not click payment on real sites in this prototype. Please confirm payment manually.");
        renderSidebar("review");
      }
    }

    if (choice === "stop") {
      resetAgentLoopLifecycle("user_stop");
      agent.running = false;
      agent.awaiting = "";
      stopWatchingCheckoutChanges();
      if (agent.sessionId) {
        await persistControlFlowDecision({
          action: "stop",
          message: "Checkout stopped by the user.",
          reason: "The user explicitly stopped the active checkout session.",
          risk: "safe"
        });
      }
      addAgentMessage("user", "Stop checkout.");
      addAgentMessage("assistant", "Stopped. Nothing was paid or submitted by me.");
      renderSidebar("agent");
    }

    if (choice === "retry") {
      addAgentMessage("user", "I fixed it. Continue.");
      agent.running = true;
      agent.awaiting = "";
      startWatchingCheckoutChanges();
      agent.repeatClickCount = 0;
      agent.lastClickAt = 0;
      renderSidebar("agent");
      await sleep(300);
      processCheckoutAgent();
    }

    if (choice === "skip_paid") {
      addAgentMessage("user", "Skip paid extras.");
      agent.skipPaidExtrasApproved = true;
      agent.running = true;
      agent.awaiting = "";
      agent.pendingUserMessage = "Use my saved no-extras preference and continue safely.";
      await processCheckoutAgent();
    }
  }

  async function handleChatSubmit(event) {
    event.preventDefault();
    const input = document.getElementById("atw-chat-input");
    const text = (input?.value || "").trim();
    if (!text) return;
    if (input) input.value = "";
    addAgentMessage("user", text);
    const normalized = text.toLowerCase();
    logAgentEvent("chat", { text });

    if (/stop|cancel|pause/.test(normalized)) {
      await handleAgentChoice("stop");
      return;
    }

    if (agent.pendingInputRequest?.field) {
      const request = agent.pendingInputRequest;
      const sensitive = request.sensitive === true;
      agent.sessionProfileOverrides[request.field] = text;
      agent.pendingUserMessage = text;
      agent.pendingUserResponse = {
        requestId: request.requestId || "",
        field: request.field,
        ...(sensitive
          ? {
              value: "",
              valueRef: "profile://session/document_number",
              hasValue: true
            }
          : {
              value: text,
              valueRef: "",
              hasValue: true
            })
      };
      addAgentMessage("assistant", `Got it. I will use that ${request.label || request.field.replace(/_/g, " ")} for this checkout and continue.`);
      agent.running = true;
      agent.awaiting = "";
      renderSidebar("agent");
      await sleep(300);
      processCheckoutAgent();
      return;
    }

    if (/add.*bag|checked bag|baggage/.test(normalized) && !/no|skip|dont|don't/.test(normalized)) {
      await handleAgentChoice("add_bag");
      return;
    }

    if (agent.awaiting === "extras" && /continue|try again|fixed|done|yes|ok|go ahead|proceed/.test(normalized)) {
      agent.pendingUserMessage = text;
      agent.running = true;
      agent.awaiting = "";
      renderSidebar("agent");
      await sleep(300);
      processCheckoutAgent();
      return;
    }

    if (/continue|try again|fixed|done|yes|ok|go ahead|proceed/.test(normalized)) {
      await handleAgentChoice("retry");
      return;
    }

    if (/pay|book|confirm/.test(normalized)) {
      addAgentMessage("assistant", "For safety, I will not click real payment from chat. Review the site payment screen and confirm there manually.");
      renderSidebar("review");
      return;
    }

    agent.pendingUserMessage = text;
    addAgentMessage("assistant", "Got it. I will send that to the agent, rescan the page, and continue only if the next action is safe.");
    agent.running = true;
    agent.awaiting = "";
    renderSidebar("agent");
    await sleep(300);
    processCheckoutAgent();
  }


  return {
    handleAgentChoice,
    handleChatSubmit,
    observePageOnly,
    processCheckoutAgent,
    resumeCheckoutAfterNavigation,
    setObserverTab,
    takeOverCheckout
  };
}
