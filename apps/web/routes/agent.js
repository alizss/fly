function createAgentRoutes({
  MAX_OBSERVATION_BYTES,
  MAX_SCREENSHOT_UPLOAD_BYTES,
  agentLoopFailurePayload,
  agentSessionStore,
  agentTraceStore,
  clampText,
  createAgentSession,
  dataDir,
  decideAgentNextActionViaLoop,
  logAgent,
  readBody,
  reportAgentResult,
  sendJson,
  storeScreenshotUpload,
  summarizeAgentSession,
  writeActionLedgerRow,
  writeClientFlowLog
}) {
  async function handleNextAction(req, res) {
    const requestStartedAt = Date.now();
    let requestParseMs = 0;
    let sessionLookupMs = 0;
    let requestOutcome = "error";
    try {
      const parseStartedAt = Date.now();
      const body = await readBody(req, { maxBytes: MAX_OBSERVATION_BYTES, tooLargeCode: "OBSERVATION_TOO_LARGE" });
      requestParseMs = Date.now() - parseStartedAt;
      const sessionId = clampText(body.sessionId || "", 120);
      if (!sessionId) {
        requestOutcome = "durable_session_required";
        sendJson(res, 409, { error: "A durable checkout session is required before planning.", code: "DURABLE_SESSION_REQUIRED" });
        return;
      }
      const lookupStartedAt = Date.now();
      const sessionExists = Boolean(agentSessionStore.getSession(sessionId));
      sessionLookupMs = Date.now() - lookupStartedAt;
      if (!sessionExists) {
        requestOutcome = "durable_session_not_found";
        sendJson(res, 409, { error: "The checkout session no longer exists; refusing to create a replacement transaction.", code: "DURABLE_SESSION_NOT_FOUND" });
        return;
      }
      const decision = await decideAgentNextActionViaLoop(body);
      requestOutcome = "decision";
      sendJson(res, 200, decision);
    } catch (error) {
      if (error.code === "AGENT_LOOP_FAILED") {
        requestOutcome = "agent_loop_failed";
        sendJson(res, Number(error.status || 500), agentLoopFailurePayload(error));
        return;
      }
      if (error.code === "OBSERVATION_RESYNC_REQUIRED") {
        requestOutcome = "observation_resync_required";
        sendJson(res, 409, { error: error.message, code: error.code, retryable: true });
        return;
      }
      if (/^DURABLE_SESSION_/.test(error.message || "")) {
        requestOutcome = "durable_session_error";
        sendJson(res, 409, { error: error.message, code: error.message });
        return;
      }
      throw error;
    } finally {
      logAgent("next-action request timing", {
        outcome: requestOutcome,
        request_parse_ms: requestParseMs,
        session_lookup_ms: sessionLookupMs,
        request_total_ms: Date.now() - requestStartedAt
      });
    }
  }

  return async function handleAgentRoutes(req, res, pathname) {
    if (req.method === "POST" && pathname === "/api/agent/client-log") {
      const summary = await writeClientFlowLog(await readBody(req));
      logAgent("client flow", summary);
      sendJson(res, 200, { ok: true });
      return true;
    }
    if (req.method === "POST" && pathname === "/api/agent/action-ledger") {
      const summary = await writeActionLedgerRow(await readBody(req));
      logAgent("action ledger", summary);
      sendJson(res, 200, { ok: true });
      return true;
    }
    if (req.method === "POST" && pathname === "/api/agent/screenshot") {
      const body = await readBody(req, { maxBytes: MAX_SCREENSHOT_UPLOAD_BYTES, tooLargeCode: "SCREENSHOT_TOO_LARGE" });
      const sessionId = clampText(body.sessionId || "", 120);
      const observationId = clampText(body.observationId || "", 120);
      if (!sessionId || !agentSessionStore.getSession(sessionId)) {
        sendJson(res, 409, { error: "A current checkout session is required for screenshot upload.", code: "DURABLE_SESSION_NOT_FOUND", retryable: false });
        return true;
      }
      if (!observationId) {
        sendJson(res, 400, { error: "observationId is required.", code: "OBSERVATION_ID_REQUIRED", retryable: false });
        return true;
      }
      const screenshotId = storeScreenshotUpload({ sessionId, observationId, screenshotDataUrl: String(body.screenshotDataUrl || "") });
      sendJson(res, 201, { screenshotId });
      return true;
    }
    if (req.method === "POST" && pathname === "/api/agent/next-action") {
      await handleNextAction(req, res);
      return true;
    }
    if (req.method === "POST" && pathname === "/api/agent/session") {
      const session = createAgentSession(await readBody(req));
      if (!session) {
        sendJson(res, 409, {
          error: "The saved checkout session could not be resumed; refusing to create a replacement transaction.",
          code: "DURABLE_SESSION_NOT_FOUND"
        });
        return true;
      }
      sendJson(res, 201, summarizeAgentSession(session));
      return true;
    }
    if (req.method === "POST" && pathname === "/api/agent/report") {
      const session = reportAgentResult(await readBody(req));
      if (!session) {
        sendJson(res, 404, { error: "Agent session not found" });
        return true;
      }
      sendJson(res, 200, summarizeAgentSession(session));
      return true;
    }
    if (req.method === "GET" && pathname.startsWith("/api/agent/session/")) {
      const sessionId = pathname.slice("/api/agent/session/".length);
      const state = agentSessionStore.getSession(sessionId);
      sendJson(res, state ? 200 : 404, state || { error: "Checkout session not found" });
      return true;
    }
    if (req.method === "GET" && pathname.startsWith("/api/agent/transaction/")) {
      const sessionId = pathname.slice("/api/agent/transaction/".length);
      const transaction = agentSessionStore.reconstructTransaction(sessionId);
      sendJson(res, transaction ? 200 : 404, transaction || { error: "Checkout transaction not found" });
      return true;
    }
    if (req.method === "GET" && pathname.startsWith("/api/agent/traces/")) {
      const sessionId = pathname.slice("/api/agent/traces/".length);
      sendJson(res, 200, { sessionId, traces: agentTraceStore.listTraces(dataDir, sessionId) });
      return true;
    }
    return false;
  };
}

module.exports = { createAgentRoutes };
