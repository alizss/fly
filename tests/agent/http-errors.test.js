const test = require("node:test");
const assert = require("node:assert/strict");

const {
  agentLoopFailurePayload,
  createAgentLoopFailure
} = require("../../apps/web/agent/http-errors");

test("an internal loop exception becomes a typed failure that preserves the active session", () => {
  const cause = Object.assign(new Error("candidate binding exploded for sk-secret-value"), {
    code: "CANDIDATE_BINDING_FAILED"
  });
  const failure = createAgentLoopFailure(cause, "chk_active_transaction");
  const payload = agentLoopFailurePayload(failure);

  assert.equal(failure.code, "AGENT_LOOP_FAILED");
  assert.deepEqual(payload, {
    error: "candidate binding exploded for [redacted-key]",
    code: "AGENT_LOOP_FAILED",
    failureCode: "CANDIDATE_BINDING_FAILED",
    sessionId: "chk_active_transaction",
    retryable: false
  });
});
