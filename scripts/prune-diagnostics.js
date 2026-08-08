const path = require("path");

const {
  pruneFiles,
  pruneTraceRoot,
  retentionConfig
} = require("../apps/web/agent/diagnostic-retention");

const root = path.resolve(__dirname, "..");
const dataDir = path.resolve(process.env.ATW_DATA_DIR || path.join(root, "work"));
const diagnosticDir = path.resolve(process.env.ATW_DIAGNOSTIC_DIR || dataDir);
const config = retentionConfig();

const traceRoots = [...new Set([
  path.join(root, "agent-traces"),
  path.join(diagnosticDir, "agent-traces")
])];

for (const traceRoot of traceRoots) {
  const result = pruneTraceRoot(traceRoot, { config });
  console.log(JSON.stringify({
    type: "trace_retention",
    root: traceRoot,
    removedSessions: result.removedSessions.length,
    retainedSessions: result.prunedSessions
  }));
}

for (const name of ["agent-client-logs", "agent-ledger"]) {
  const dir = path.join(diagnosticDir, name);
  const result = pruneFiles(dir, {
    maxBytes: config.logFileBytes * config.logFiles,
    maxFiles: config.logFiles,
    maxAgeMs: config.logAgeMs
  });
  console.log(JSON.stringify({
    type: "log_retention",
    dir,
    removedFiles: result.removed.length,
    retainedFiles: result.retainedFiles,
    retainedBytes: result.retainedBytes
  }));
}
