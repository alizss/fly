export function createCheckoutController({
  DESTINATION_MUTATION_SETTLE_MS,
  VALIDATION_TERMS,
  addAgentMessage,
  agent,
  announceSectionQueue,
  beginAgentLoop,
  buildPageUnderstanding,
  clearResumeMarker,
  describePageMap,
  executeAgentDecision,
  finishAgentLoop,
  isVisible,
  labelText,
  logAgentEvent,
  logFlow,
  outlineCoreSections,
  pageStateStore,
  persistControlFlowDecision,
  rememberPagePlan,
  renderSidebar,
  requestAgentDecision,
  resetAgentLoopLifecycle,
  resetFieldProgress,
  runRiskChecks,
  saveResumeMarker,
  scheduleDestinationObservation,
  setAgentActivity,
  setWarnings,
  shouldAutoDeclinePaidExtras,
  showAgentThought,
  sleep,
  startAgentSession,
  travelerRules,
  travelerValue
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
    if (agent.running || agent.loopBusy) {
      logFlow("loop.start_duplicate_suppressed", {
        activeLoopRunId: agent.activeLoopRunId,
        lifecycleId: agent.lifecycleId
      });
      return;
    }
    resetAgentLoopLifecycle("start_agent");
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
      agent.running = false;
      agent.awaiting = "manual";
      await clearResumeMarker();
      addAgentMessage(
        "assistant",
        ["SELECTED_BOOKING_REQUIRED", "SELECTED_TRAVELER_REQUIRED"].includes(agent.sessionStartFailure?.code)
          ? agent.sessionStartFailure.message
          : `I could not establish one durable checkout session, so I stopped before planning or changing the page.${agent.sessionStartFailure?.message ? ` ${agent.sessionStartFailure.message}` : ""}`
      );
      renderSidebar("agent");
      return;
    }
    await saveResumeMarker();
    addAgentMessage("assistant", `${describePageMap(agent.pageMap)} I will work step by step and ask when money, payment, or uncertainty appears.`);
    renderSidebar("agent");
    await announceSectionQueue();
    await sleep(650);
    processCheckoutAgent();
  }

  async function resumeCheckoutAfterNavigation(marker) {
    resetAgentLoopLifecycle("resume_after_navigation");
    agent.running = true;
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
    // A newly loaded checkout document is still hydrating when the content
    // script starts. Building the entire page map immediately and then again
    // after the old 650 ms delay caused two multi-second DOM scans on large
    // airline pages. Let initial framework work land first, then create one
    // atomic fresh observation which the first planning turn can reuse.
    await sleep(650);
    const resumedObservation = await pageStateStore.observeFresh({
      reason: "navigation_resume",
      maxWaitMs: 650,
      maxAttempts: 2,
      postBuildGraceMs: 100
    });
    agent.pageMap = rememberPagePlan(resumedObservation.map);
    const resumeSessionId = String(marker.sessionId || "");
    const session = resumeSessionId ? await startAgentSession(resumeSessionId) : null;
    if (!session || agent.sessionId !== resumeSessionId) {
      agent.running = false;
      agent.awaiting = "manual";
      await clearResumeMarker();
      addAgentMessage("assistant", "The prior checkout session could not be resumed, so I stopped instead of starting a replacement transaction.");
      renderSidebar("agent");
      return;
    }
    await saveResumeMarker();
    addAgentMessage("assistant", "Picking back up where I left off after the page changed.");
    renderSidebar("agent");
    await announceSectionQueue();
    processCheckoutAgent();
  }

  async function processCheckoutAgent() {
    if (!agent.running) return;
    if (!agent.sessionId) {
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
      if (agent.destinationWait?.status === "WAITING_FOR_DESTINATION") {
        const remaining = Math.max(0, agent.destinationWait.deadlineAt - Date.now());
        const materialWakePending = agent.destinationWait.wakeRequested === true
          && agent.destinationWait.lastWakeReason === "dom_mutation";
        // A material MutationObserver event may wake earlier. Otherwise send
        // exactly one deadline observation instead of polling every interval.
        scheduleDestinationObservation(
          materialWakePending ? "dom_mutation" : "readiness_deadline",
          materialWakePending ? DESTINATION_MUTATION_SETTLE_MS : remaining
        );
      } else if (shouldRerun) {
        setTimeout(() => processCheckoutAgent(), 0);
      }
    }
  }

  function collectBlockingIssues() {
    const issues = [];
    const visibleText = [...document.querySelectorAll("body *")]
      .filter((element) => isVisible(element) && !element.closest("#atw-sidebar"))
      .map((element) => (element.innerText || element.textContent || "").trim())
      .filter(Boolean);

    for (const text of visibleText) {
      const normalized = text.toLowerCase();
      if (normalized.length > 180) continue;
      if (VALIDATION_TERMS.some((term) => normalized.includes(term)) && /required|must enter|too long|invalid|not valid|error/.test(normalized)) {
        issues.push(text.replace(/\s+/g, " "));
      }
      if (issues.length >= 4) break;
    }

    const titleAreaVisible = document.body.innerText.toLowerCase().includes("title *") || document.body.innerText.toLowerCase().includes("you must enter a gender");
    const anyTitleChecked = [...document.querySelectorAll("input[type='radio']")]
      .filter((radio) => /mr|mrs|ms|title|gender/.test(labelText(radio)))
      .some((radio) => radio.checked);
    if (titleAreaVisible && !anyTitleChecked && !travelerValue("title")) {
      issues.unshift("title/gender is required but no traveler title preference is saved");
    }

    return [...new Set(issues)];
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
