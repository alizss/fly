// Every turn of the agent loop gets written to disk: what it saw, what it
// decided, what the policy said, what happened. "It stalled on GoToGate" is
// not debuggable; "here is the exact turn where it stalled, with the
// screenshot and the requirements it thought were still missing" is.

const fs = require("fs");
const path = require("path");

function sessionDir(baseDir, sessionId) {
  return path.join(baseDir, "agent-traces", String(sessionId || "unknown"));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * @param {string} baseDir usually the server's `work/` directory
 * @param {string} sessionId
 * @param {Object} turn
 * @param {string} turn.turnId
 * @param {string} [turn.screenshotDataUrl] data: URL, written alongside the JSON as a .jpg
 * @param {Object} turn.observation
 * @param {Object} [turn.pageState]
 * @param {Object[]} turn.requirements
 * @param {Object} turn.verification
 * @param {Object} turn.plannedAction
 * @param {Object} turn.policyDecision
 * @param {Object} [turn.executionResult]
 * @param {Object} [turn.debug]
 * @returns {{ jsonPath: string, screenshotPath: string|null }}
 */
function writeTrace(baseDir, sessionId, turn) {
  const dir = sessionDir(baseDir, sessionId);
  ensureDir(dir);
  const turnId = String(turn.turnId || Date.now());

  let screenshotPath = null;
  const dataUrl = turn.screenshotDataUrl || "";
  if (dataUrl.startsWith("data:image/")) {
    const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    screenshotPath = path.join(dir, `${turnId}.jpg`);
    try {
      fs.writeFileSync(screenshotPath, Buffer.from(base64, "base64"));
    } catch (error) {
      screenshotPath = null;
    }
  }

  const jsonPath = path.join(dir, `${turnId}.json`);
  const record = {
    sessionId,
    turnId,
    at: new Date().toISOString(),
    observation: turn.observation || null,
    pageState: turn.pageState || null,
    requirements: turn.requirements || [],
    verification: turn.verification || null,
    plannedAction: turn.plannedAction || null,
    policyDecision: turn.policyDecision || null,
    executionResult: turn.executionResult || null,
    debug: turn.debug || null,
    screenshotFile: screenshotPath ? path.basename(screenshotPath) : null
  };
  fs.writeFileSync(jsonPath, JSON.stringify(record, null, 2));

  return { jsonPath, screenshotPath };
}

function listTraces(baseDir, sessionId) {
  const dir = sessionDir(baseDir, sessionId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
      } catch (error) {
        return null;
      }
    })
    .filter(Boolean);
}

module.exports = { writeTrace, listTraces, sessionDir };
