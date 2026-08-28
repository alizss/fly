export function createAgentLifecycle({
  DESTINATION_MUTATION_SETTLE_MS,
  DESTINATION_RETRY_INTERVAL_MS,
  DESTINATION_WAIT_TIMEOUT_MS,
  addAgentMessage,
  agent,
  logFlow,
  processCheckoutAgent,
  renderSidebar,
  setAgentActivity
}) {
  function abortActivePlannerRequest(reason = "superseded") {
    const request = agent.activePlannerRequest;
    if (!request) return false;
    agent.activePlannerRequest = null;
    request.controller?.abort(reason);
    logFlow("backend.request.abort", {
      turnId: request.turnId,
      observationId: request.observationId,
      loopRunId: request.loopRunId,
      reason
    });
    return true;
  }

  function isDestinationReadinessDecision(decision = {}) {
    if (decision.action !== "wait") return false;
    const intent = `${decision.intent || ""} ${decision.semanticIntent || ""}`.toLowerCase();
    return /wait_for_ready_observation|wait_for_dispatched_stage_exit|reobserve_after_transient_observation|reobserve_degraded_loading_destination/.test(intent)
      || /await_pending_action_result/.test(intent)
      || (decision.expectedPostconditions || []).some((postcondition) => (
        postcondition?.type === "observation_readiness" && postcondition?.status === "READY"
      ));
  }

  function clearDestinationWait(reason = "cleared") {
    if (agent.destinationWaitTimer) {
      clearTimeout(agent.destinationWaitTimer);
      agent.destinationWaitTimer = null;
    }
    if (agent.destinationWait) {
      logFlow("destination_wait.exit", {
        reason,
        startedAt: agent.destinationWait.startedAt,
        attempts: agent.destinationWait.attempts,
        backendWaits: agent.destinationWait.backendWaits
      });
    }
    agent.destinationWait = null;
  }

  function expireDestinationWait(reason = "timeout") {
    const wait = agent.destinationWait;
    clearDestinationWait(reason);
    if (!agent.running) return;
    // A bounded readiness deadline ends active polling, not the durable
    // checkout. Keep the watcher armed and resume automatically when the
    // destination eventually publishes fresh structural evidence. Turning
    // this into `awaiting = manual` made slow airline pages require a second
    // Start even though no user decision was missing.
    agent.running = false;
    agent.engineReconciliationPending = true;
    agent.awaiting = "";
    setAgentActivity(
      "Waiting for the checkout page",
      "Active polling ended; Fly will continue automatically when fresh checkout controls appear."
    );
    addAgentMessage(
      "assistant",
      "The destination is still loading. I will continue automatically when its checkout controls appear."
    );
    renderSidebar("agent");
  }

  function beginDestinationWait(decision = {}) {
    const now = Date.now();
    const existing = agent.destinationWait;
    const backendStartedAt = Number(decision.readinessStartedAt || 0);
    const backendDeadlineAt = Number(decision.readinessDeadlineAt || 0);
    const dispatchedStageExitWait = /wait_for_dispatched_stage_exit|await_pending_action_result/.test(`${decision.intent || ""} ${decision.semanticIntent || ""}`.toLowerCase());
    const retryToken = String(decision.reobserveRetryToken || "");
    agent.destinationWait = {
      status: "WAITING_FOR_DESTINATION",
      kind: dispatchedStageExitWait
            ? "dispatched_stage_exit"
            : "destination",
      startedAt: backendStartedAt > 0 ? backendStartedAt : (existing?.startedAt || now),
      deadlineAt: backendDeadlineAt > 0 ? backendDeadlineAt : (existing?.deadlineAt || (now + DESTINATION_WAIT_TIMEOUT_MS)),
      attempts: Number(existing?.attempts || 0),
      backendWaits: Number(existing?.backendWaits || 0) + 1,
      wakeRequested: decision.wakeRequested === true,
      lastWakeReason: decision.lastWakeReason || "backend_wait",
      lastMutationAt: Number(decision.lastMutationAt || existing?.lastMutationAt || 0),
      deadlineObservationSent: Boolean(existing?.deadlineObservationSent),
      observationId: decision.observationId || existing?.observationId || "",
      actionId: decision.actionId || decision.id || existing?.actionId || "",
      retryToken: retryToken || existing?.retryToken || ""
    };
    setAgentActivity(
      dispatchedStageExitWait
            ? "Waiting for the checkout stage to change"
            : "Waiting for destination",
      dispatchedStageExitWait
          ? "The stage exit was dispatched once. I will resume on a material page change or verify it at the bounded deadline."
        : "Navigation completed, but the destination controls are still hydrating. I will continue automatically."
    );
    renderSidebar("agent");
    logFlow("destination_wait.enter", {
      observationId: agent.destinationWait.observationId,
      backendWaits: agent.destinationWait.backendWaits,
      deadlineAt: new Date(agent.destinationWait.deadlineAt).toISOString()
    });
    // The wait object owns its deadline wake.  If this is entered during an
    // active loop, finishAgentLoop consumes the durable wake request; if it is
    // entered outside a loop, the deadline is armed immediately.
    scheduleDestinationObservation(
      "readiness_deadline",
      Math.max(0, agent.destinationWait.deadlineAt - now)
    );
    return agent.destinationWait;
  }

  function scheduleDestinationObservation(reason = "scheduled", delay = DESTINATION_RETRY_INTERVAL_MS) {
    const wait = agent.destinationWait;
    if (!wait || !agent.running) return false;
    // A material DOM mutation may wake early.
    // Ordinary readiness waits send one settled observation at the deadline;
    // unchanged timer polling is forbidden.
    if (reason === "dom_mutation" && agent.destinationWaitTimer) {
      clearTimeout(agent.destinationWaitTimer);
      agent.destinationWaitTimer = null;
    }
    wait.wakeRequested = true;
    wait.lastWakeReason = reason;
    if (reason === "dom_mutation") wait.lastMutationAt = Date.now();
    if (Date.now() >= wait.deadlineAt) {
      if (wait.deadlineObservationSent) {
        expireDestinationWait("backend_deadline_confirmed");
        return false;
      }
      wait.deadlineObservationSent = true;
      delay = 0;
    }
    // A loop/request already in progress owns the next observation. Its
    // finally block will consume the durable wake request.
    if (agent.loopBusy || agent.activePlannerRequest || agent.destinationWaitTimer) return false;
    const remaining = Math.max(0, wait.deadlineAt - Date.now());
    const boundedDelay = Math.min(Math.max(0, delay), remaining);
    agent.destinationWaitTimer = setTimeout(() => {
      agent.destinationWaitTimer = null;
      const current = agent.destinationWait;
      if (!current || !agent.running) return;
      if (Date.now() >= current.deadlineAt && !current.deadlineObservationSent) {
        current.deadlineObservationSent = true;
      }
      if (agent.loopBusy || agent.activePlannerRequest) {
        scheduleDestinationObservation("request_still_active", DESTINATION_RETRY_INTERVAL_MS);
        return;
      }
      current.wakeRequested = false;
      current.attempts += 1;
      logFlow("destination_wait.reobserve", {
        reason: current.lastWakeReason || reason,
        attempts: current.attempts,
        elapsedMs: Date.now() - current.startedAt
      });
      processCheckoutAgent();
    }, boundedDelay);
    logFlow("destination_wait.scheduled", {
      reason,
      delayMs: boundedDelay,
      deadlineAt: new Date(wait.deadlineAt).toISOString()
    });
    return true;
  }

  function resetAgentLoopLifecycle(reason = "reset") {
    agent.lifecycleId += 1;
    agent.loopRerunQueued = false;
    agent.honoredReobserveRetryTokens.clear();
    clearDestinationWait(reason);
    abortActivePlannerRequest(reason);
    return agent.lifecycleId;
  }

  function beginAgentLoop() {
    if (agent.loopBusy) {
      agent.loopRerunQueued = true;
      logFlow("loop.duplicate_suppressed", {
        activeLoopRunId: agent.activeLoopRunId,
        lifecycleId: agent.lifecycleId,
        reason: "A checkout loop turn is already active; one fresh rerun was queued."
      });
      return null;
    }
    const token = {
      loopRunId: agent.loopRunSerial + 1,
      lifecycleId: agent.lifecycleId
    };
    agent.loopRunSerial = token.loopRunId;
    agent.activeLoopRunId = token.loopRunId;
    agent.loopBusy = true;
    return token;
  }

  function finishAgentLoop(token) {
    if (!token || agent.activeLoopRunId !== token.loopRunId) return false;
    const shouldRerun = Boolean(agent.loopRerunQueued && agent.running);
    agent.loopBusy = false;
    agent.activeLoopRunId = 0;
    agent.loopRerunQueued = false;
    if (agent.destinationWait?.status === "WAITING_FOR_DESTINATION") {
      const wait = agent.destinationWait;
      const materialWakePending = wait.wakeRequested === true
        && wait.lastWakeReason === "dom_mutation";
      scheduleDestinationObservation(
        materialWakePending ? "dom_mutation" : "readiness_deadline",
        materialWakePending
          ? DESTINATION_MUTATION_SETTLE_MS
          : Math.max(0, wait.deadlineAt - Date.now())
      );
      return false;
    }
    return shouldRerun;
  }

  function plannerRequestIsCurrent(request) {
    return Boolean(
      request
      && agent.activePlannerRequest === request
      && request.lifecycleId === agent.lifecycleId
      && request.loopRunId === agent.activeLoopRunId
    );
  }


  return {
    abortActivePlannerRequest,
    beginAgentLoop,
    beginDestinationWait,
    clearDestinationWait,
    expireDestinationWait,
    finishAgentLoop,
    isDestinationReadinessDecision,
    plannerRequestIsCurrent,
    resetAgentLoopLifecycle,
    scheduleDestinationObservation
  };
}
