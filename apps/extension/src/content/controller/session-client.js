export function createSessionClient({
  ACTION_REPORT_MAX_ATTEMPTS,
  ACTION_REPORT_TIMEOUT_MS,
  DEFAULT_API,
  actionableCheckoutErrors,
  acquireSelectedBookingForStart,
  addAgentMessage,
  agent,
  compactActionResultForTransport,
  compactPageMap,
  composeSelectedBookingContract,
  logAgentEvent,
  logFlow,
  observationHashForMap,
  pageSnapshot,
  pageStateStore,
  renderSidebar,
  resetAgentLoopLifecycle,
  setAgentActivity,
  storageGet,
  traveler,
  userIntentText,
  validStoredSelectedBookingContract
}) {
  async function startAgentSession(resumeSessionId = "", options = {}) {
    try {
      agent.sessionStartFailure = null;
      const settings = await storageGet(["apiBase", "selectedBookingContract"]);
      const selectedTraveler = traveler();
      if (!selectedTraveler?.id) {
        const error = new Error("Select at least one wallet traveler before starting checkout.");
        error.code = "SELECTED_TRAVELER_REQUIRED";
        throw error;
      }
      let selectedBookingContract = null;
      if (!resumeSessionId) {
        selectedBookingContract = validStoredSelectedBookingContract(settings.selectedBookingContract, selectedTraveler);
        if (!selectedBookingContract) {
          setAgentActivity(
            "Confirming the selected booking",
            "Waiting briefly for the selected itinerary and displayed starting total."
          );
          renderSidebar("agent");
          const acquisition = await acquireSelectedBookingForStart({
            initialMap: agent.pageMap || pageStateStore.current(),
            timeoutMs: options.bookingAcquisitionTimeoutMs
          });
          selectedBookingContract = composeSelectedBookingContract(acquisition, selectedTraveler);
        }
        if (!selectedBookingContract) {
          const error = new Error(
            "The selected itinerary and starting total are not available yet. Return to the approved flight selection or make its booking summary visible, then start again."
          );
          error.code = "SELECTED_BOOKING_REQUIRED";
          throw error;
        }
      }
      const response = await fetch(`${settings.apiBase || DEFAULT_API}/agent/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: resumeSessionId || "",
          resumeOnly: Boolean(resumeSessionId),
          goal: agent.userGoal || "Complete this flight checkout safely with one-click assistance.",
          userIntent: userIntentText(),
          traveler: traveler(),
          selectedBookingContract,
          page: compactPageMap(agent.pageMap || pageStateStore.observe({ reason: "session_start" }).map)
        })
      });
      const session = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(session.error || `session returned ${response.status}`);
        error.code = session.code || `HTTP_${response.status}`;
        error.retryable = session.retryable === true;
        throw error;
      }
      const sessionId = String(session.id || "");
      if (!sessionId) throw new Error("session handshake returned an empty id");
      if (resumeSessionId && sessionId !== resumeSessionId) {
        throw new Error("session handshake returned a replacement transaction id");
      }
      agent.sessionId = sessionId;
      logAgentEvent("agent_session_started", { sessionId: agent.sessionId });
      return session;
    } catch (error) {
      agent.sessionStartFailure = {
        code: String(error.code || "SESSION_START_FAILED"),
        message: String(error.message || "Checkout session could not be started.")
      };
      logAgentEvent("agent_session_failed", { error: error.message });
      agent.sessionId = "";
      return null;
    }
  }

  async function reportActionResult(result = {}) {
    if (!agent.sessionId) {
      if (!agent.running) return false;
      throw new Error("Cannot report an action result without the durable checkout session.");
    }
    if (agent.activeExecutionActionId && !result.actionId && typeof result.verified !== "boolean") {
      logFlow("action.report.helper_suppressed", {
        actionId: agent.activeExecutionActionId,
        resultType: result.type || "",
        reason: "Only the final governed verification result may update the transaction."
      });
      return false;
    }
    logFlow("action.report", {
      result,
      page: pageSnapshot("report-action-result")
    });
    try {
      const settings = await storageGet(["apiBase"]);
      const map = pageStateStore.observe({ reason: "action_report" }).map;
      const authoritativeResult = compactActionResultForTransport({
        ...(agent.lastActionResult || {}),
        ...result,
        actionId: result.actionId || agent.lastActionResult?.actionId || agent.activeExecutionActionId || "",
        observationId: result.observationId || agent.lastActionResult?.observationId || agent.activeExecutionObservationId || ""
      });
      const pageReference = {
        site: map.site || location.host,
        url: location.href,
        step: map.step || "unknown",
        snapshotHash: observationHashForMap(map),
        surfaceId: map.currentSurface?.id || "surface-page",
        surfaceType: map.currentSurface?.type || "page",
        errors: actionableCheckoutErrors(map.errors || []).slice(0, 4)
      };
      const reportBody = JSON.stringify({
        sessionId: agent.sessionId,
        result: {
          ...authoritativeResult,
          stage: authoritativeResult.stage || pageReference.step,
          errors: authoritativeResult.errors || pageReference.errors
        },
        // The next observation carries the complete canonical page. Result
        // persistence only needs enough fresh identity to advance the durable
        // action lifecycle, not hundreds of destination controls.
        page: pageReference
      });
      let session = null;
      let lastError = null;
      for (let attempt = 1; attempt <= ACTION_REPORT_MAX_ATTEMPTS; attempt += 1) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), ACTION_REPORT_TIMEOUT_MS);
        const startedAt = performance.now();
        try {
          const response = await fetch(`${settings.apiBase || DEFAULT_API}/agent/report`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: reportBody,
            signal: controller.signal
          });
          if (!response.ok) {
            const error = new Error(`agent report returned ${response.status}`);
            error.retryable = response.status >= 500;
            throw error;
          }
          session = await response.json();
          logFlow("action.report.acknowledged", {
            actionId: authoritativeResult.actionId || "",
            attempt,
            duration_ms: Math.round(performance.now() - startedAt),
            resultAt: authoritativeResult.at || "",
            page: pageReference
          });
          break;
        } catch (error) {
          lastError = error;
          const retryable = error.name === "AbortError" || error.retryable === true || error instanceof TypeError;
          logFlow("action.report.attempt_failed", {
            actionId: authoritativeResult.actionId || "",
            attempt,
            retryable,
            duration_ms: Math.round(performance.now() - startedAt),
            error: error.message || error.name || "Action report failed"
          });
          if (!retryable || attempt >= ACTION_REPORT_MAX_ATTEMPTS) throw error;
          setAgentActivity("Saving action result", `Retrying durable result acknowledgement (${attempt + 1}/${ACTION_REPORT_MAX_ATTEMPTS}).`);
        } finally {
          clearTimeout(timeout);
        }
      }
      if (!session) throw lastError || new Error("agent report did not return a session");
      if (!session?.id || session.id !== agent.sessionId) {
        throw new Error("agent report did not acknowledge the active durable session");
      }
      return true;
    } catch (error) {
      logAgentEvent("agent_report_failed", { error: error.message });
      resetAgentLoopLifecycle("action_result_persistence_failed");
      agent.running = false;
      agent.awaiting = "manual";
      addAgentMessage("assistant", "I could not persist the verified action result in the active checkout session, so I stopped before taking another action.");
      renderSidebar("agent");
      throw error;
    }
  }


  return {
    reportActionResult,
    startAgentSession
  };
}
