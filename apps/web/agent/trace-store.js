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

function clipped(value = "", limit = 1200) {
  const text = String(value || "");
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function compactOperations(operations = {}) {
  return Object.fromEntries(Object.entries(operations || {}).slice(0, 8).map(([operation, capability]) => [operation, {
    actuatorId: capability?.actuatorId || "",
    status: capability?.status || "",
    actionability: capability?.actionability ? {
      executable: capability.actionability.executable === true,
      revealable: capability.actionability.revealable === true,
      rendered: capability.actionability.rendered === true,
      visible: capability.actionability.visible === true,
      enabled: capability.actionability.enabled === true,
      inViewport: capability.actionability.inViewport === true,
      inCurrentSurface: capability.actionability.inCurrentSurface === true,
      hitTested: capability.actionability.hitTested === true,
      notOccluded: capability.actionability.notOccluded === true,
      code: capability.actionability.code || ""
    } : null,
    strategies: (capability?.strategies || []).slice(0, 4).map((strategy) => ({
      actuatorId: strategy.actuatorId || "",
      method: strategy.method || "",
      status: strategy.status || ""
    }))
  }]));
}

function compactControl(control = {}) {
  return {
    controlId: control.controlId || "",
    stableKey: control.stableKey || "",
    label: clipped(control.label || control.accessibleName || "", 320),
    role: control.role || control.kind || "",
    semantic: control.semantic || control.fieldType || "",
    physicalEffect: control.physicalEffect || "",
    risk: control.risk || "",
    surfaceId: control.surfaceId || "",
    decisionGroupId: control.decisionGroupId || "",
    required: control.required === true,
    selected: control.selected === true || control.state?.selected === true || control.state?.checked === true,
    disabled: control.disabled === true || control.state?.disabled === true,
    state: control.state ? {
      valuePresent: control.state.valuePresent === true,
      normalizedValue: clipped(control.state.normalizedValue || control.state.selectedValue || "", 160),
      expanded: control.state.expanded === true,
      selected: control.state.selected === true,
      checked: control.state.checked === true,
      disabled: control.state.disabled === true
    } : null,
    structuredPrice: control.structuredPrice || null,
    representationLifecycle: control.representationLifecycle || null,
    operations: compactOperations(control.operations)
  };
}

function compactObservation(observation = null) {
  if (!observation || typeof observation !== "object") return observation;
  const page = observation.page || {};
  const previous = observation.previousObservation || null;
  return {
    observationId: observation.observationId || "",
    observationSnapshot: observation.observationSnapshot || null,
    destinationReadiness: observation.destinationReadiness || null,
    lastActionResult: observation.lastActionResult ? compactValue(observation.lastActionResult, 0) : null,
    previousObservationRef: previous ? {
      observationId: previous.observationId || "",
      snapshotHash: previous.observationSnapshot?.snapshotHash || previous.page?.snapshotHash || "",
      step: previous.page?.step || "",
      url: previous.page?.url || ""
    } : null,
    page: {
      site: page.site || "",
      url: page.url || "",
      step: page.step || "unknown",
      snapshotHash: page.snapshotHash || "",
      readiness: page.readiness || null,
      terminalEvidence: page.terminalEvidence || null,
      currentSurface: page.currentSurface || null,
      surfaceStack: (page.surfaceStack || []).slice(0, 8),
      stageExit: page.stageExit || null,
      validationIssues: (page.validationIssues || []).slice(0, 20),
      fields: (page.fields || []).slice(0, 40).map((field) => compactValue(field, 1)),
      controls: (page.controls || []).slice(0, 120).map(compactControl),
      decisionGroups: (page.decisionGroups || []).slice(0, 40).map((group) => compactValue(group, 1)),
      transactionFacts: page.transactionFacts ? compactValue(page.transactionFacts, 1) : null,
      selectedBooking: page.selectedBooking ? compactValue(page.selectedBooking, 1) : null,
      price: page.price || null,
      graphIntegrity: page.graphIntegrity ? compactValue(page.graphIntegrity, 1) : null,
      semanticReadiness: page.semanticReadiness || ""
    }
  };
}

function compactValue(value, depth = 0) {
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return clipped(value);
  if (depth >= 5) return "[bounded]";
  if (Array.isArray(value)) return value.slice(0, 40).map((item) => compactValue(item, depth + 1));
  if (typeof value !== "object") return String(value);
  const dropped = new Set([
    "previousObservation",
    "screenshotDataUrl",
    "fullText",
    "text",
    "candidateSet",
    "contextCapabilities",
    "normalCandidates",
    "recoveryCandidates",
    "excludedCandidates"
  ]);
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !dropped.has(key))
    .slice(0, 120)
    .map(([key, item]) => [key, compactValue(item, depth + 1)]));
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
    observation: compactObservation(turn.observation || null),
    pageState: compactValue(turn.pageState || null),
    requirements: compactValue(turn.requirements || []),
    verification: compactValue(turn.verification || null),
    plannedAction: compactValue(turn.plannedAction || null),
    policyDecision: compactValue(turn.policyDecision || null),
    executionResult: compactValue(turn.executionResult || null),
    debug: compactValue(turn.debug || null),
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

module.exports = { writeTrace, listTraces, sessionDir, compactObservation, compactValue };
