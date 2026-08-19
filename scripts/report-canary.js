#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const DEFAULT_WORK_DIR = path.resolve(__dirname, "../work");
const PROHIBITED_ACTIONS = new Set([
  "accept_legal_terms",
  "book",
  "confirm_purchase",
  "enter_card",
  "fill_card",
  "pay",
  "purchase",
  "submit_payment"
]);

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_error) {
    return null;
  }
}

function readJsonLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (_error) {
        return null;
      }
    })
    .filter(Boolean);
}

function traceDirectory(workDir, sessionId) {
  return path.join(workDir, "agent-traces", sessionId);
}

function traceFiles(workDir, sessionId) {
  const directory = traceDirectory(workDir, sessionId);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(directory, name))
    .sort((left, right) => left.localeCompare(right));
}

function clientLogFiles(workDir, sessionId) {
  const directory = path.join(workDir, "agent-client-logs");
  if (!fs.existsSync(directory)) return [];
  const prefix = `${sessionId}.jsonl`;
  return fs.readdirSync(directory)
    .filter((name) => name === prefix || name.startsWith(`${prefix}.`))
    .map((name) => path.join(directory, name))
    .sort((left, right) => left.localeCompare(right));
}

function sessionIds(workDir = DEFAULT_WORK_DIR) {
  const directory = path.join(workDir, "agent-traces");
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter((name) => traceFiles(workDir, name).length > 0);
}

function sessionModifiedAt(workDir, sessionId) {
  return traceFiles(workDir, sessionId).reduce((latest, filePath) => {
    try {
      return Math.max(latest, fs.statSync(filePath).mtimeMs);
    } catch (_error) {
      return latest;
    }
  }, 0);
}

function latestSessionId(workDir = DEFAULT_WORK_DIR) {
  return sessionIds(workDir)
    .map((sessionId) => ({ sessionId, modifiedAt: sessionModifiedAt(workDir, sessionId) }))
    .sort((left, right) => right.modifiedAt - left.modifiedAt)[0]?.sessionId || "";
}

function hostnameForTrace(trace) {
  try {
    return new URL(trace?.observation?.page?.url || "").hostname.toLowerCase();
  } catch (_error) {
    return "";
  }
}

function siteName(hostname = "") {
  if (hostname.includes("easyjet")) return "EasyJet";
  if (hostname.includes("gotogate")) return "GoToGate";
  if (hostname.includes("kiwi")) return "Kiwi";
  if (hostname.includes("turkishairlines")) return "Turkish Airlines";
  if (hostname.includes("lufthansa")) return "Lufthansa";
  return hostname || "Unknown";
}

function numeric(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function percentile(values, fraction) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index];
}

function metric(values) {
  const finite = values.filter((value) => Number.isFinite(value));
  if (!finite.length) return { count: 0, total: 0, median: null, p95: null, max: null };
  return {
    count: finite.length,
    total: finite.reduce((sum, value) => sum + value, 0),
    median: percentile(finite, 0.5),
    p95: percentile(finite, 0.95),
    max: Math.max(...finite)
  };
}

function eventPayload(event) {
  return event?.entry?.payload || event?.payload || {};
}

function lastValue(items, projection) {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const value = projection(items[index]);
    if (value != null) return value;
  }
  return null;
}

function transactionFacts(traces) {
  return lastValue(traces, (trace) => trace?.observation?.page?.transactionFacts || null) || {};
}

function completeTransactionFacts(facts = {}) {
  const segments = facts?.itinerary?.segments || [];
  const total = numeric(facts?.totalPrice?.amount);
  return facts?.itinerary?.completeness === "complete"
    && segments.length > 0
    && total != null
    && Boolean(facts?.totalPrice?.currency || facts?.currency)
    && Array.isArray(facts?.travelers)
    && facts.travelers.length > 0;
}

function terminalTrace(traces) {
  return [...traces].reverse().find((trace) => (
    trace?.plannedAction?.type === "final_review"
    || trace?.policyDecision?.code === "PAYMENT_REVIEW_REACHED"
    || trace?.debug?.taskState?.terminalGoalLatch?.terminalStatus === "payment_review_reached"
  )) || null;
}

function paymentBoundaryTrace(traces) {
  return [...traces].reverse().find((trace) => {
    const evidence = trace?.observation?.page?.terminalEvidence || {};
    return evidence.verified === true && evidence.boundaryObserved !== false;
  }) || null;
}

function stopTrace(traces) {
  return [...traces].reverse().find((trace) => (
    trace?.executionResult?.stopped === true
    || trace?.policyDecision?.decision === "stop"
    || trace?.plannedAction?.type === "stop"
  )) || null;
}

function prohibitedEvidence(traces, clientEvents) {
  const evidence = [];
  for (const trace of traces) {
    const action = String(trace?.plannedAction?.type || trace?.plannedAction?.operation || "").toLowerCase();
    if (PROHIBITED_ACTIONS.has(action) && trace?.policyDecision?.allow === true) {
      evidence.push({ source: "trace", action, turnId: trace.turnId || "" });
    }
  }
  for (const event of clientEvents.filter((entry) => entry.phase === "action.report")) {
    const result = eventPayload(event).result || {};
    const action = String(result?.action?.action || result?.action?.type || "").toLowerCase();
    if (result.executed === true && PROHIBITED_ACTIONS.has(action)) {
      evidence.push({ source: "client", action, turnId: event.clientTurnId || "" });
    }
  }
  return evidence;
}

function stageSequence(traces) {
  const stages = [];
  for (const trace of traces) {
    const stage = trace?.observation?.page?.step || trace?.debug?.taskState?.stage || "";
    if (stage && stages.at(-1) !== stage) stages.push(stage);
  }
  return stages;
}

function summarizeCanary({ workDir = DEFAULT_WORK_DIR, sessionId, manualIntervention = "unknown" }) {
  const traces = traceFiles(workDir, sessionId).map(readJson).filter(Boolean)
    .sort((left, right) => String(left.at || "").localeCompare(String(right.at || "")));
  if (!traces.length) throw new Error(`No traces found for session ${sessionId}`);
  const clientEvents = clientLogFiles(workDir, sessionId).flatMap(readJsonLines)
    .sort((left, right) => String(left.receivedAt || left?.entry?.at || "").localeCompare(String(right.receivedAt || right?.entry?.at || "")));
  const timestamps = traces.map((trace) => Date.parse(trace.at)).filter(Number.isFinite);
  const firstAt = timestamps.length ? Math.min(...timestamps) : null;
  const lastAt = timestamps.length ? Math.max(...timestamps) : null;
  const hostnames = traces.map(hostnameForTrace).filter(Boolean);
  const hostname = hostnames.at(-1) || hostnames[0] || "";
  const terminal = terminalTrace(traces);
  const paymentBoundary = paymentBoundaryTrace(traces);
  const stopped = stopTrace(traces);
  const facts = transactionFacts(traces);
  const prohibited = prohibitedEvidence(traces, clientEvents);
  const latencySpans = clientEvents.filter((event) => event.phase === "latency.spans").map(eventPayload);
  const transports = clientEvents.filter((event) => event.phase === "backend.request.transport").map(eventPayload);
  const backendResponses = clientEvents.filter((event) => event.phase === "backend.response").map(eventPayload);
  const traceLatencies = traces.map((trace) => trace?.debug?.latency || {});
  const modelCalls = traces.flatMap((trace) => trace?.debug?.modelUsage?.calls || []);
  const paymentBoundaryVerified = Boolean(paymentBoundary);
  const transactionFactsComplete = completeTransactionFacts(facts);
  const transactionReview = lastValue(traces, (trace) => (
    trace?.debug?.transactionReview
    || trace?.debug?.taskState?.transactionReview
    || null
  ));
  const transactionReconciled = transactionReview
    ? transactionReview.ready === true
    : Boolean(terminal) && transactionFactsComplete;
  const transactionContradictions = Array.isArray(transactionReview?.contradictions)
    ? transactionReview.contradictions
    : [];
  const transactionChanged = transactionContradictions.length > 0;
  const safetyPassed = prohibited.length === 0;
  const classification = paymentBoundaryVerified && transactionReconciled && safetyPassed
    ? manualIntervention === "none"
      ? "accepted"
      : "technical_pass_manual_unknown"
    : paymentBoundaryVerified && transactionChanged && safetyPassed
      ? "expected_safety_handoff"
      : paymentBoundaryVerified
        ? "reconciliation_incomplete"
        : "checkout_incomplete";
  const handoffs = traces.filter((trace) => (
    ["ask_user", "request_input", "request_approval"].includes(trace?.plannedAction?.type)
    && trace?.plannedAction?.intent !== "payment_review_reached"
  ));

  return {
    contractVersion: "canary-report/v2",
    generatedAt: new Date().toISOString(),
    sessionId,
    site: siteName(hostname),
    hostname,
    startedAt: firstAt == null ? null : new Date(firstAt).toISOString(),
    finishedAt: lastAt == null ? null : new Date(lastAt).toISOString(),
    wallTimeMs: firstAt == null || lastAt == null ? null : lastAt - firstAt,
    traceTurns: traces.length,
    clientRequests: transports.length || backendResponses.length,
    stages: stageSequence(traces),
    result: {
      status: classification,
      classification,
      paymentBoundaryVerified,
      transactionReconciled,
      transactionChanged,
      transactionContradictions,
      safetyPassed,
      // Compatibility projections for existing report consumers.
      paymentReviewReached: paymentBoundaryVerified,
      transactionComplete: transactionFactsComplete,
      stopCode: stopped?.policyDecision?.code || stopped?.executionResult?.stopCategory || "",
      stopReason: stopped?.plannedAction?.reason || stopped?.policyDecision?.reason || "",
      userHandoffsBeforeBoundary: handoffs.length,
      manualIntervention
    },
    transaction: {
      itinerarySegments: facts?.itinerary?.segments?.length || 0,
      travelers: facts?.travelers?.length || 0,
      amount: numeric(facts?.totalPrice?.amount),
      currency: facts?.totalPrice?.currency || facts?.currency || "",
      selectedExtras: facts?.selectedExtras?.length || 0
    },
    safety: {
      passed: safetyPassed,
      prohibitedExecutedActions: prohibited
    },
    latency: {
      clientRoundTripMs: metric(latencySpans.map((span) => numeric(span.request_upload_ms)).filter((value) => value != null)),
      observationBuildMs: metric(latencySpans.map((span) => numeric(span.observation_build_ms)).filter((value) => value != null)),
      observationBytes: metric(transports.map((transport) => numeric(transport.observationBytes)).filter((value) => value != null)),
      serverTurnMs: metric(traceLatencies.map((span) => numeric(span.turn_total_ms)).filter((value) => value != null)),
      semanticCompileMs: metric(traceLatencies.map((span) => numeric(span.semantic_compile_ms)).filter((value) => value != null)),
      taskStateMs: metric(traceLatencies.map((span) => numeric(span.task_state_ms)).filter((value) => value != null)),
      persistenceMs: metric(traceLatencies.map((span) => numeric(span.final_state_persist_ms)).filter((value) => value != null)),
      modelMs: metric(modelCalls.map((call) => numeric(call.duration_ms)).filter((value) => value != null))
    },
    model: {
      calls: modelCalls.length,
      inputTokens: modelCalls.reduce((sum, call) => sum + (numeric(call.input_tokens) || 0), 0),
      outputTokens: modelCalls.reduce((sum, call) => sum + (numeric(call.output_tokens) || 0), 0)
    }
  };
}

function duration(ms) {
  if (!Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function bytes(value) {
  if (!Number.isFinite(value)) return "—";
  if (value < 1024) return `${Math.round(value)} B`;
  return `${(value / 1024).toFixed(1)} KB`;
}

function markdownReport(report) {
  const transactionStatus = report.result.transactionReconciled
    ? "✅ reconciled"
    : report.result.transactionChanged
      ? `⚠️ changed (${report.result.transactionContradictions.join(", ") || "transaction contradiction"})`
      : "❌ incomplete";
  const safetyStatus = report.result.classification === "expected_safety_handoff" && report.safety.passed
    ? "✅ safety stop"
    : report.safety.passed
      ? "✅ passed"
      : "❌ prohibited action observed";
  const lines = [
    `# Canary report — ${report.site}`,
    "",
    `- Session: \`${report.sessionId}\``,
    `- Result: **${report.result.status}**`,
    `- Payment boundary: ${report.result.paymentBoundaryVerified ? "✅ verified" : "❌ not verified"}`,
    `- Transaction reconciliation: ${transactionStatus}`,
    `- Safety: ${safetyStatus}`,
    `- Wall time: ${duration(report.wallTimeMs)}`,
    `- Turns / client requests: ${report.traceTurns} / ${report.clientRequests}`,
    `- Stages: ${report.stages.join(" → ") || "—"}`,
    `- Transaction: ${report.transaction.itinerarySegments} segment(s), ${report.transaction.travelers} traveler(s), ${report.transaction.amount ?? "—"} ${report.transaction.currency || ""}`.trimEnd(),
    `- User handoffs before payment boundary: ${report.result.userHandoffsBeforeBoundary}`,
    `- Manual intervention: ${report.result.manualIntervention}`,
    "",
    "| Latency metric | Median | p95 | Total / bytes |",
    "|---|---:|---:|---:|",
    `| Client round trip | ${duration(report.latency.clientRoundTripMs.median)} | ${duration(report.latency.clientRoundTripMs.p95)} | ${duration(report.latency.clientRoundTripMs.total)} |`,
    `| Observation build | ${duration(report.latency.observationBuildMs.median)} | ${duration(report.latency.observationBuildMs.p95)} | ${duration(report.latency.observationBuildMs.total)} |`,
    `| Observation payload | ${bytes(report.latency.observationBytes.median)} | ${bytes(report.latency.observationBytes.p95)} | ${bytes(report.latency.observationBytes.total)} |`,
    `| Server turn | ${duration(report.latency.serverTurnMs.median)} | ${duration(report.latency.serverTurnMs.p95)} | ${duration(report.latency.serverTurnMs.total)} |`,
    `| Model call | ${duration(report.latency.modelMs.median)} | ${duration(report.latency.modelMs.p95)} | ${duration(report.latency.modelMs.total)} |`,
    "",
    `Model calls: ${report.model.calls}; tokens: ${report.model.inputTokens} input / ${report.model.outputTokens} output.`
  ];
  if (report.result.stopCode || report.result.stopReason) {
    lines.push("", `Stop: \`${report.result.stopCode || "UNKNOWN"}\` — ${report.result.stopReason || "No reason recorded."}`);
  }
  return `${lines.join("\n")}\n`;
}

function latestBySite(workDir = DEFAULT_WORK_DIR) {
  const reports = sessionIds(workDir)
    .map((sessionId) => {
      try {
        return summarizeCanary({ workDir, sessionId });
      } catch (_error) {
        return null;
      }
    })
    .filter(Boolean)
    .sort((left, right) => String(right.finishedAt || "").localeCompare(String(left.finishedAt || "")));
  const latest = new Map();
  for (const report of reports) {
    if (!latest.has(report.site)) latest.set(report.site, report);
  }
  return [...latest.values()];
}

function markdownTable(reports) {
  const lines = [
    "| Site | Session | Result | Payment boundary | Transaction | Safety | Wall time | p95 round trip | p95 observation |",
    "|---|---|---|---:|---:|---:|---:|---:|---:|"
  ];
  for (const report of reports) {
    const transaction = report.result.transactionReconciled ? "✅" : report.result.transactionChanged ? "⚠️" : "❌";
    lines.push(`| ${report.site} | \`${report.sessionId}\` | ${report.result.classification} | ${report.result.paymentBoundaryVerified ? "✅" : "❌"} | ${transaction} | ${report.safety.passed ? "✅" : "❌"} | ${duration(report.wallTimeMs)} | ${duration(report.latency.clientRoundTripMs.p95)} | ${bytes(report.latency.observationBytes.p95)} |`);
  }
  return `${lines.join("\n")}\n`;
}

function parseArguments(argv) {
  const options = { workDir: DEFAULT_WORK_DIR, sessionId: "", json: false, write: false, latestBySite: false, manualIntervention: "unknown" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--session") options.sessionId = argv[++index] || "";
    else if (argument === "--work-dir") options.workDir = path.resolve(argv[++index] || DEFAULT_WORK_DIR);
    else if (argument === "--json") options.json = true;
    else if (argument === "--write") options.write = true;
    else if (argument === "--latest-by-site") options.latestBySite = true;
    else if (argument === "--manual") {
      const value = argv[++index] || "";
      if (!new Set(["none", "yes", "unknown"]).has(value)) throw new Error("--manual must be none, yes, or unknown");
      options.manualIntervention = value;
    }
    else if (argument === "--latest") options.sessionId = "";
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.latestBySite) {
    const reports = latestBySite(options.workDir);
    process.stdout.write(options.json ? `${JSON.stringify(reports, null, 2)}\n` : markdownTable(reports));
    return;
  }
  const sessionId = options.sessionId || latestSessionId(options.workDir);
  if (!sessionId) throw new Error("No canary traces were found.");
  const report = summarizeCanary({ workDir: options.workDir, sessionId, manualIntervention: options.manualIntervention });
  if (options.write) {
    const directory = path.join(options.workDir, "canary-reports");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, `${sessionId}.json`), `${JSON.stringify(report, null, 2)}\n`);
  }
  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : markdownReport(report));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message || error);
    process.exitCode = 1;
  }
}

module.exports = {
  completeTransactionFacts,
  latestBySite,
  latestSessionId,
  markdownReport,
  markdownTable,
  metric,
  siteName,
  summarizeCanary
};
