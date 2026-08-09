function boundedText(value = "", limit = 400) {
  return String(value || "")
    .replace(/sk-proj-[A-Za-z0-9_*.-]+/g, "[redacted-key]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted-key]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function failureCodeFor(error = null) {
  const raw = String(error?.code || error?.name || "AGENT_LOOP_EXCEPTION")
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return raw && raw !== "ERROR" ? raw : "AGENT_LOOP_EXCEPTION";
}

function createAgentLoopFailure(error = null, sessionId = "") {
  const failure = new Error(boundedText(error?.message || "Agent loop failed before producing a decision."));
  failure.name = "AgentLoopFailure";
  failure.code = "AGENT_LOOP_FAILED";
  failure.failureCode = failureCodeFor(error);
  failure.sessionId = String(sessionId || "").slice(0, 120);
  failure.status = 500;
  failure.retryable = false;
  return failure;
}

function agentLoopFailurePayload(error = null) {
  return {
    error: boundedText(error?.message || "Agent loop failed before producing a decision."),
    code: "AGENT_LOOP_FAILED",
    failureCode: failureCodeFor({ code: error?.failureCode }),
    sessionId: String(error?.sessionId || "").slice(0, 120),
    retryable: false
  };
}

module.exports = {
  agentLoopFailurePayload,
  createAgentLoopFailure,
  failureCodeFor
};
