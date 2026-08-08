const fs = require("fs");
const path = require("path");

const DEFAULT_MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_TRACE_SESSION_BYTES = 64 * 1024 * 1024;
const DEFAULT_TRACE_SESSION_FILES = 160;
const DEFAULT_TRACE_SESSIONS = 50;
const DEFAULT_TRACE_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_LOG_FILE_BYTES = 20 * 1024 * 1024;
const DEFAULT_LOG_SEGMENTS = 3;
const DEFAULT_LOG_FILES = 120;
const DEFAULT_LOG_AGE_MS = 14 * 24 * 60 * 60 * 1000;

const scheduledRoots = new Map();

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function retentionConfig(env = process.env) {
  return Object.freeze({
    minFreeBytes: positiveInteger(env.ATW_DIAGNOSTIC_MIN_FREE_BYTES, DEFAULT_MIN_FREE_BYTES),
    traceSessionBytes: positiveInteger(env.ATW_TRACE_SESSION_MAX_BYTES, DEFAULT_TRACE_SESSION_BYTES),
    traceSessionFiles: positiveInteger(env.ATW_TRACE_SESSION_MAX_FILES, DEFAULT_TRACE_SESSION_FILES),
    traceSessions: positiveInteger(env.ATW_TRACE_MAX_SESSIONS, DEFAULT_TRACE_SESSIONS),
    traceAgeMs: positiveInteger(env.ATW_TRACE_MAX_AGE_MS, DEFAULT_TRACE_AGE_MS),
    logFileBytes: positiveInteger(env.ATW_LOG_FILE_MAX_BYTES, DEFAULT_LOG_FILE_BYTES),
    logSegments: positiveInteger(env.ATW_LOG_MAX_SEGMENTS, DEFAULT_LOG_SEGMENTS),
    logFiles: positiveInteger(env.ATW_LOG_MAX_FILES, DEFAULT_LOG_FILES),
    logAgeMs: positiveInteger(env.ATW_LOG_MAX_AGE_MS, DEFAULT_LOG_AGE_MS)
  });
}

function freeDiskBytes(targetPath) {
  try {
    const stat = fs.statfsSync(targetPath);
    return Number(stat.bavail) * Number(stat.bsize);
  } catch (_) {
    return Number.POSITIVE_INFINITY;
  }
}

function diagnosticsWritable(targetPath, config = retentionConfig()) {
  const probe = fs.existsSync(targetPath) ? targetPath : path.dirname(targetPath);
  return freeDiskBytes(probe) >= config.minFreeBytes;
}

function fileEntries(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== ".pinned")
    .map((entry) => {
      const filePath = path.join(dir, entry.name);
      const stat = fs.statSync(filePath);
      return { name: entry.name, path: filePath, bytes: stat.size, mtimeMs: stat.mtimeMs };
    });
}

function pruneFiles(dir, { maxBytes, maxFiles, maxAgeMs = 0 } = {}) {
  const now = Date.now();
  const entries = fileEntries(dir).sort((left, right) => right.mtimeMs - left.mtimeMs);
  let retainedBytes = 0;
  let retainedFiles = 0;
  const removed = [];
  for (const entry of entries) {
    const expired = maxAgeMs > 0 && now - entry.mtimeMs > maxAgeMs;
    const overCount = Number.isFinite(maxFiles) && retainedFiles >= maxFiles;
    const overBytes = Number.isFinite(maxBytes) && retainedBytes + entry.bytes > maxBytes;
    if (expired || overCount || overBytes) {
      try {
        fs.unlinkSync(entry.path);
        removed.push(entry.path);
      } catch (_) {
        // Diagnostics are best effort and never checkout authority.
      }
      continue;
    }
    retainedFiles += 1;
    retainedBytes += entry.bytes;
  }
  return { removed, retainedBytes, retainedFiles };
}

function directoryMtime(dir) {
  try {
    return fs.statSync(dir).mtimeMs;
  } catch (_) {
    return 0;
  }
}

function pinnedTraceDirectory(dir) {
  return fs.existsSync(path.join(dir, ".pinned"));
}

function pruneTraceRoot(rootDir, { preserveSessionId = "", config = retentionConfig() } = {}) {
  if (!fs.existsSync(rootDir)) return { removedSessions: [], prunedSessions: 0 };
  const dirs = fs.readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      path: path.join(rootDir, entry.name),
      mtimeMs: directoryMtime(path.join(rootDir, entry.name))
    }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  const now = Date.now();
  const retained = [];
  const removedSessions = [];
  let ordinaryRetained = 0;
  for (const entry of dirs) {
    const pinned = pinnedTraceDirectory(entry.path) || entry.name === preserveSessionId;
    const expired = !pinned && now - entry.mtimeMs > config.traceAgeMs;
    const overCount = !pinned && ordinaryRetained >= config.traceSessions;
    if (expired || overCount) {
      try {
        fs.rmSync(entry.path, { recursive: true, force: true });
        removedSessions.push(entry.path);
      } catch (_) {
        // Best effort only.
      }
      continue;
    }
    retained.push({ ...entry, pinned });
    if (!pinned) ordinaryRetained += 1;
  }
  for (const entry of retained) {
    pruneFiles(entry.path, {
      maxBytes: config.traceSessionBytes,
      maxFiles: config.traceSessionFiles,
      maxAgeMs: entry.pinned ? 0 : config.traceAgeMs
    });
  }
  return { removedSessions, prunedSessions: retained.length };
}

function scheduleTraceRootRetention(rootDir, options = {}) {
  const key = path.resolve(rootDir);
  const last = scheduledRoots.get(key) || 0;
  if (Date.now() - last < 60_000) return false;
  scheduledRoots.set(key, Date.now());
  setImmediate(() => {
    try {
      pruneTraceRoot(rootDir, options);
    } catch (_) {
      // Never let diagnostic retention affect the active checkout.
    }
  });
  return true;
}

function rotateFile(filePath, maxSegments) {
  for (let index = maxSegments - 1; index >= 1; index -= 1) {
    const source = index === 1 ? filePath : `${filePath}.${index - 1}`;
    const destination = `${filePath}.${index}`;
    try {
      if (fs.existsSync(destination)) fs.unlinkSync(destination);
      if (fs.existsSync(source)) fs.renameSync(source, destination);
    } catch (_) {
      // A failed rotation degrades to the current file only.
    }
  }
}

async function appendRotatingJsonLine(filePath, row, {
  config = retentionConfig(),
  fallback = null
} = {}) {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });
  if (!diagnosticsWritable(dir, config)) {
    pruneFiles(dir, { maxBytes: config.logFileBytes, maxFiles: config.logFiles, maxAgeMs: config.logAgeMs });
    return { written: false, reason: "LOW_DISK_SPACE" };
  }
  let serialized = JSON.stringify(row);
  if (Buffer.byteLength(serialized) > 128 * 1024) {
    serialized = JSON.stringify(fallback || {
      receivedAt: row?.receivedAt || new Date().toISOString(),
      truncated: true,
      reason: "DIAGNOSTIC_ROW_TOO_LARGE"
    });
  }
  const bytes = Buffer.byteLength(serialized) + 1;
  let currentBytes = 0;
  try {
    currentBytes = (await fs.promises.stat(filePath)).size;
  } catch (_) {
    currentBytes = 0;
  }
  if (currentBytes + bytes > config.logFileBytes) rotateFile(filePath, config.logSegments);
  await fs.promises.appendFile(filePath, `${serialized}\n`);
  pruneFiles(dir, {
    maxBytes: config.logFileBytes * config.logFiles,
    maxFiles: config.logFiles,
    maxAgeMs: config.logAgeMs
  });
  return { written: true, bytes };
}

module.exports = {
  appendRotatingJsonLine,
  diagnosticsWritable,
  freeDiskBytes,
  pruneFiles,
  pruneTraceRoot,
  retentionConfig,
  scheduleTraceRootRetention
};
