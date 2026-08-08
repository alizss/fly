const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { writeTrace } = require("../../apps/web/agent/trace-store");
const {
  appendRotatingJsonLine,
  diagnosticsWritable,
  pruneTraceRoot,
  retentionConfig
} = require("../../apps/web/agent/diagnostic-retention");

test("trace persistence stores one compact observation and references prior evidence by identity", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fly-trace-"));
  try {
    const controls = Array.from({ length: 220 }, (_, index) => ({
      controlId: `control_${index}`,
      stableKey: `stable_${index}`,
      label: `Seat option ${index} ${"verbose ".repeat(80)}`,
      semantic: index % 2 ? "seat_option" : "unknown",
      risk: index % 2 ? "money" : "safe",
      surfaceId: "surface-page",
      operations: {
        activate: {
          actuatorId: `node_${index}`,
          status: "proven_executable",
          actionability: {
            rendered: true,
            visible: true,
            enabled: true,
            inViewport: true,
            inCurrentSurface: true,
            hitTested: true,
            notOccluded: true,
            executable: true
          }
        }
      }
    }));
    const previousObservation = {
      observationId: "obs_before",
      observationSnapshot: { snapshotHash: "before_hash" },
      page: { url: "https://example.test/seats", step: "seats", controls }
    };
    const observation = {
      observationId: "obs_after",
      observationSnapshot: { snapshotHash: "after_hash" },
      previousObservation,
      page: {
        url: "https://example.test/seats",
        step: "seats",
        text: "large page text ".repeat(10_000),
        fullText: "duplicated full text ".repeat(10_000),
        currentSurface: { id: "surface-page", type: "page" },
        controls
      }
    };
    const result = writeTrace(dataDir, "session", {
      turnId: "turn",
      observation,
      debug: { taskState: { currentGoal: { candidateSet: { contextCapabilities: controls } } } }
    });
    const raw = fs.readFileSync(result.jsonPath, "utf8");
    const record = JSON.parse(raw);

    assert.equal(record.observation.previousObservation, undefined);
    assert.deepEqual(record.observation.previousObservationRef, {
      observationId: "obs_before",
      snapshotHash: "before_hash",
      step: "seats",
      url: "https://example.test/seats"
    });
    assert.equal(record.observation.page.controls.length, 120);
    assert.equal(record.observation.page.text, undefined);
    assert.equal(record.debug.taskState.currentGoal.candidateSet, undefined);
    assert.ok(Buffer.byteLength(raw) < 180_000, `trace was ${Buffer.byteLength(raw)} bytes`);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("diagnostic retention caps ordinary trace sessions while preserving the current and pinned evidence", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fly-retention-"));
  const root = path.join(dataDir, "agent-traces");
  try {
    const oldDir = path.join(root, "old_session");
    const currentDir = path.join(root, "current_session");
    const pinnedDir = path.join(root, "accepted_canary");
    for (const dir of [oldDir, currentDir, pinnedDir]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, "old.json"), "old");
    fs.writeFileSync(path.join(currentDir, "current.json"), "current");
    fs.writeFileSync(path.join(pinnedDir, ".pinned"), "accepted");
    fs.writeFileSync(path.join(pinnedDir, "canary.json"), "canary");
    const oldTime = new Date(Date.now() - 10_000);
    fs.utimesSync(oldDir, oldTime, oldTime);

    const config = {
      ...retentionConfig({}),
      traceSessions: 0,
      traceAgeMs: 60_000,
      traceSessionBytes: 1024,
      traceSessionFiles: 4
    };
    const result = pruneTraceRoot(root, { preserveSessionId: "current_session", config });
    assert.equal(fs.existsSync(oldDir), false);
    assert.equal(fs.existsSync(currentDir), true);
    assert.equal(fs.existsSync(pinnedDir), true);
    assert.equal(fs.existsSync(path.join(pinnedDir, ".pinned")), true);
    assert.equal(result.removedSessions.includes(oldDir), true);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("diagnostic JSONL rotates to a bounded number of compact files and fails open on low disk", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fly-log-rotation-"));
  const filePath = path.join(dataDir, "session.jsonl");
  try {
    const config = {
      ...retentionConfig({}),
      minFreeBytes: 1,
      logFileBytes: 220,
      logSegments: 3,
      logFiles: 10,
      logAgeMs: 60_000
    };
    for (let index = 0; index < 12; index += 1) {
      await appendRotatingJsonLine(filePath, { index, payload: "x".repeat(70) }, { config });
    }
    const files = fs.readdirSync(dataDir).filter((name) => name.startsWith("session.jsonl"));
    assert.ok(files.length <= 3, JSON.stringify(files));
    assert.ok(files.every((name) => fs.statSync(path.join(dataDir, name)).size <= config.logFileBytes));
    assert.equal(diagnosticsWritable(dataDir, { ...config, minFreeBytes: Number.MAX_SAFE_INTEGER }), false);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
