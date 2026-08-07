const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { writeTrace } = require("../../apps/web/agent/trace-store");

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
