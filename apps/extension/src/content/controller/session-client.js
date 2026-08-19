import { currentNavigationUrl } from "../navigation-identity.js";

export function createSessionClient({
  ACTION_REPORT_MAX_ATTEMPTS,
  ACTION_REPORT_TIMEOUT_MS,
  DEFAULT_API,
  actionableCheckoutErrors,
  admitSelectedBookingForStart,
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
  readStartupDiagnostics,
  renderSidebar,
  resetAgentLoopLifecycle,
  setAgentActivity,
  storageGet,
  traveler,
  userIntentText,
  validStoredSelectedBookingContract
}) {
  function recordStartEvent(type, payload = {}) {
    logAgentEvent(type, payload);
    logFlow("booking.admission", { event: type, ...payload });
  }

  async function startAgentSession(resumeSessionId = "", options = {}) {
    const startAttemptId = String(options.startAttemptId || `start_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`);
    try {
      agent.sessionStartFailure = null;
      recordStartEvent("START_CLICKED", { startAttemptId, resume: Boolean(resumeSessionId) });
      const startupEvents = await readStartupDiagnostics();
      recordStartEvent("STARTUP_CONTEXT", {
        startAttemptId,
        events: startupEvents.slice(-12)
      });
      const settings = await storageGet(["apiBase"]);
      const selectedTraveler = traveler();
      if (!selectedTraveler?.id) {
        const error = new Error("Select at least one wallet traveler before starting checkout.");
        error.code = "SELECTED_TRAVELER_REQUIRED";
        throw error;
      }
      let selectedBookingContract = null;
      if (!resumeSessionId) {
        const currentMap = agent.pageMap || pageStateStore.current() || pageStateStore.observe({ reason: "session_start_booking" }).map;
        recordStartEvent("BOOKING_CAPTURE_STARTED", { startAttemptId });
        const admission = await admitSelectedBookingForStart({
          initialMap: currentMap,
          timeoutMs: options.bookingAcquisitionTimeoutMs
        });
        if (admission.status === "candidate") {
          recordStartEvent("BOOKING_CANDIDATE_FOUND", {
            startAttemptId,
            missingFacts: admission.missingFacts || [],
            reason: admission.reason || ""
          });
        } else if (admission.status === "conflict") {
          recordStartEvent("BOOKING_CONFLICT", { startAttemptId, reason: admission.reason || "" });
        }
        const suppliedSelectedBooking = admission.selectedBookingContract || null;
        selectedBookingContract = validStoredSelectedBookingContract(
          suppliedSelectedBooking,
          selectedTraveler
        ) || composeSelectedBookingContract(admission.acquisition, selectedTraveler);
        if (suppliedSelectedBooking && !selectedBookingContract) {
          const error = new Error("The app-selected booking is expired, incomplete, or does not include the selected wallet traveler.");
          error.code = "APP_SELECTED_BOOKING_INVALID";
          error.details = {
            checkoutLineageId: admission.checkoutLineageId || "",
            selectionId: String(suppliedSelectedBooking.selectionId || "")
          };
          throw error;
        }
        if (selectedBookingContract) {
          recordStartEvent("BOOKING_CONFIRMED", {
            startAttemptId,
            checkoutLineageId: admission.checkoutLineageId || "",
            selectionId: selectedBookingContract.selectionId
          });
        }
        if (!selectedBookingContract) {
          const missingFacts = admission.missingFacts || [];
          recordStartEvent("BOOKING_CONFIRMATION_REQUIRED", {
            startAttemptId,
            status: admission.status || "absent",
            reason: admission.reason || "",
            missingFacts
          });
          setAgentActivity(
            "Confirming the selected booking",
            missingFacts.length
              ? `The current tab is missing: ${missingFacts.join(", ")}.`
              : "The current tab must expose the selected itinerary and displayed starting total."
          );
          renderSidebar("agent");
          const error = new Error(
            "The selected itinerary and starting total are not available yet. Return to the approved flight selection or make its booking summary visible, then start again."
          );
          error.code = "SELECTED_BOOKING_REQUIRED";
          error.details = { admissionStatus: admission.status || "absent", missingFacts };
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
      recordStartEvent("SESSION_CREATED", { startAttemptId, sessionId: agent.sessionId, resume: Boolean(resumeSessionId) });
      logAgentEvent("agent_session_started", { sessionId: agent.sessionId });
      return session;
    } catch (error) {
      agent.sessionStartFailure = {
        code: String(error.code || "SESSION_START_FAILED"),
        message: String(error.message || "Checkout session could not be started."),
        details: error.details || null,
        startAttemptId
      };
      recordStartEvent("SESSION_START_FAILED", {
        startAttemptId,
        code: agent.sessionStartFailure.code,
        details: agent.sessionStartFailure.details
      });
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
        url: currentNavigationUrl(),
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
