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

  function resumePageIdentity() {
    return {
      site: location.host,
      url: currentNavigationUrl(),
      step: "unknown",
      currentSurface: null,
      summary: null,
      errors: []
    };
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
        recordStartEvent("BOOKING_ADMISSION_STARTED", { startAttemptId });
        // Start consumes only the final tab-scoped SelectedBooking produced by
        // the app or the lightweight pre-checkout selection owner. The current
        // checkout page can never manufacture transaction approval here.
        const admission = await admitSelectedBookingForStart();
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
        );
        if (suppliedSelectedBooking && !selectedBookingContract) {
          recordStartEvent("APP_SELECTED_BOOKING_INVALID", {
            startAttemptId,
            checkoutLineageId: admission.checkoutLineageId || "",
            selectionId: String(suppliedSelectedBooking.selectionId || "")
          });
        }
        if (selectedBookingContract) {
          recordStartEvent("BOOKING_CONFIRMED", {
            startAttemptId,
            checkoutLineageId: admission.checkoutLineageId || "",
            selectionId: selectedBookingContract.selectionId
          });
        }
        if (!selectedBookingContract) {
          recordStartEvent("BOOKING_EVIDENCE_REQUIRED", {
            startAttemptId,
            status: admission.status || "absent",
            reason: admission.reason || "",
            missingFacts: admission.missingFacts || []
          });
          const error = new Error(
            admission.missingFacts?.length
              ? `No approved booking was captured before this checkout. Return to the flight/fare selection, select it once, then continue and Start Fly. Missing: ${admission.missingFacts.join(", ")}.`
              : "No approved booking was captured before checkout Start. Return to the flight/fare selection and select it once."
          );
          error.code = "SELECTED_BOOKING_REQUIRED";
          error.details = {
            admissionStatus: admission.status || "absent",
            reason: admission.reason || "",
            missingFacts: admission.missingFacts || []
          };
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
          // A durable resume handshake proves that the transaction still
          // exists before this document is allowed to perform an expensive
          // semantic observation. The next controller step supplies the full
          // page after the server has accepted the exact session id.
          page: resumeSessionId && options.validateBeforeObservation === true
            ? resumePageIdentity()
            : compactPageMap(agent.pageMap || pageStateStore.observe({ reason: "session_start" }).map)
        })
      });
      const session = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(session.error || `session returned ${response.status}`);
        error.code = session.code || `HTTP_${response.status}`;
        error.retryable = session.retryable === true;
        error.details = session.details || null;
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
      const failureMessage = String(error.message || "Checkout session could not be started.");
      const failureCode = error.code || (/extension context invalidated/i.test(failureMessage)
        ? "EXTENSION_CONTEXT_RELOADED"
        : "SESSION_START_FAILED");
      agent.sessionStartFailure = {
        code: String(failureCode),
        message: failureMessage,
        details: error.details || null,
        startAttemptId
      };
      recordStartEvent("SESSION_START_FAILED", {
        startAttemptId,
        code: agent.sessionStartFailure.code,
        message: agent.sessionStartFailure.message,
        details: agent.sessionStartFailure.details
      });
      logAgentEvent("agent_session_failed", { error: error.message });
      agent.sessionId = "";
      return null;
    }
  }

  async function reportActionResult(result = {}, options = {}) {
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
      // A dispatched navigation receipt must be emitted before any fresh DOM
      // work: the old document can disappear immediately after the click.
      // Its already-owned source map is sufficient identity for persistence.
      const map = options.pageMap || pageStateStore.observe({ reason: "action_report" }).map;
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
            // Only the pre-navigation dispatch receipt may outlive its source
            // document. Ordinary field/choice results use an acknowledged
            // request and must not consume the browser's keepalive quota.
            ...(options.keepalive === true ? { keepalive: true } : {}),
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
