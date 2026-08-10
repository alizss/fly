const path = require("path");
const { appendRotatingJsonLine, retentionConfig } = require("./diagnostic-retention");

function clampText(value, max = 4000) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function now() {
  return new Date().toISOString();
}

function logAgent(label, data) {
  const stamp = new Date().toISOString().slice(11, 23);
  if (data === undefined) console.log(`[agent ${stamp}] ${label}`);
  else console.log(`[agent ${stamp}] ${label}`, JSON.stringify(data));
}

function safeLogFilePart(value) {
  return clampText(value || "no-session", 120).replace(/[^a-zA-Z0-9_.-]/g, "_") || "no-session";
}

function summarizeClientFlowLog(body) {
  const entry = body.entry || {};
  const payload = entry.payload || {};
  const page = payload.page || payload.pageBefore || payload.pageAfterAction || {};
  const decision = payload.decision || {};
  const target = payload.target || payload.resolved || {};
  const point = payload.point || {};
  return {
    sessionId: clampText(body.sessionId || "", 80),
    clientTurnId: clampText(body.clientTurnId || entry.turnId || "", 80),
    observationId: clampText(payload.observationId || payload.observation?.observationId || "", 80),
    actionId: clampText(payload.actionId || payload.executionId || "", 80),
    seq: entry.seq,
    phase: clampText(entry.phase || "unknown", 80),
    action: clampText(payload.action || decision.action || "", 80),
    target: clampText(payload.targetLabel || target.text || target.label || decision.targetLabel || decision.targetId || payload.targetId || "", 140),
    method: clampText(payload.method || "", 80),
    point: point.x !== undefined && point.y !== undefined ? `${Math.round(point.x)},${Math.round(point.y)}` : "",
    site: clampText(page.site || "", 80),
    step: clampText(page.step || "", 80),
    controls: Array.isArray(page.visibleControls) ? page.visibleControls.length : undefined,
    currentSurface: clampText(page.currentSurface?.label || page.currentSurface?.type || "", 140),
    reason: clampText(payload.reason || decision.reason || "", 180)
  };
}

function summarizeActionLedgerRow(body = {}) {
  const action = body.action || {};
  const result = body.result || {};
  const target = body.targetFingerprint || {};
  return {
    transactionId: clampText(body.transactionId || "", 80),
    observationId: clampText(body.observationId || "", 80),
    turnId: clampText(body.turnId || "", 80),
    actionId: clampText(body.actionId || "", 80),
    stage: clampText(body.stage || "", 80),
    action: clampText(action.action || action.type || "", 80),
    target: clampText(action.targetLabel || action.value || target.text || target.id || "", 160),
    result: result.ok === undefined ? "" : result.ok ? "ok" : "failed",
    code: clampText(result.code || "", 80),
    reason: clampText(result.reason || result.message || action.reason || "", 180)
  };
}

function createRequestDiagnostics({ diagnosticDir, agentSessionStore }) {
  async function writeClientFlowLog(body) {
    const sessionId = safeLogFilePart(body.sessionId || body.entry?.turnId || "no-session");
    const summary = summarizeClientFlowLog(body);
    const row = {
      receivedAt: now(),
      ...summary,
      entry: {
        seq: body.entry?.seq,
        at: clampText(body.entry?.at || "", 80),
        turnId: clampText(body.entry?.turnId || "", 80),
        phase: clampText(body.entry?.phase || "unknown", 80),
        payload: body.entry?.payload || null
      }
    };
    await appendRotatingJsonLine(path.join(diagnosticDir, "agent-client-logs", `${sessionId}.jsonl`), row, {
      config: retentionConfig(),
      fallback: { receivedAt: row.receivedAt, ...summary, entry: { phase: row.entry.phase, truncated: true } }
    });
    return summary;
  }

  async function writeActionLedgerRow(body = {}) {
    const transactionId = safeLogFilePart(body.transactionId || body.sessionId || body.turnId || "no-session");
    const summary = summarizeActionLedgerRow(body);
    const row = {
      receivedAt: now(),
      ...summary,
      semanticEffect: clampText(body.semanticEffect || body.action?.semanticEffect || body.action?.physicalEffect || "", 100),
      expectedOutcome: body.expectedOutcome ? {
        type: clampText(body.expectedOutcome.type || "", 100),
        decisionGroupId: clampText(body.expectedOutcome.decisionGroupId || "", 120),
        requirementId: clampText(body.expectedOutcome.requirementId || "", 120)
      } : null
    };
    await appendRotatingJsonLine(path.join(diagnosticDir, "agent-ledger", `${transactionId}.jsonl`), row, {
      config: retentionConfig(),
      fallback: { receivedAt: row.receivedAt, ...summary, truncated: true }
    });
    const realTransactionId = clampText(body.transactionId || body.sessionId || "", 120);
    if (realTransactionId && agentSessionStore.getSession(realTransactionId)) {
      agentSessionStore.recordActionEvent(realTransactionId, row);
    }
    return summary;
  }

  return { writeActionLedgerRow, writeClientFlowLog };
}

module.exports = {
  createRequestDiagnostics,
  logAgent,
  summarizeActionLedgerRow,
  summarizeClientFlowLog
};
