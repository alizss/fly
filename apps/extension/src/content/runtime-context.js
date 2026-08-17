function normalizedKeys(values = []) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

export function createRuntimeContext(initialState = {}) {
  const state = { ...initialState };
  const knownKeys = new Set(Object.keys(state));

  function assertKnownKey(key, scopeName) {
    if (typeof key === "symbol") return;
    if (!knownKeys.has(key)) {
      throw new Error(`Unknown runtime state key "${key}" requested by ${scopeName}.`);
    }
  }

  function scope(scopeName, { read = [], write = [] } = {}) {
    const readable = new Set(normalizedKeys([...read, ...write]));
    const writable = new Set(normalizedKeys(write));
    for (const key of readable) assertKnownKey(key, scopeName);

    return new Proxy(Object.create(null), {
      get(_target, key) {
        if (key === "toJSON") return () => Object.fromEntries([...readable].map((name) => [name, state[name]]));
        if (key === Symbol.toStringTag) return `RuntimeScope:${scopeName}`;
        if (typeof key === "symbol") return undefined;
        if (!readable.has(key)) {
          throw new Error(`Runtime scope ${scopeName} cannot read "${key}".`);
        }
        return state[key];
      },
      set(_target, key, value) {
        assertKnownKey(key, scopeName);
        if (!writable.has(key)) {
          throw new Error(`Runtime scope ${scopeName} cannot write "${key}".`);
        }
        state[key] = value;
        return true;
      },
      has(_target, key) {
        return typeof key === "string" && readable.has(key);
      },
      ownKeys() {
        return [...readable];
      },
      getOwnPropertyDescriptor(_target, key) {
        if (typeof key !== "string" || !readable.has(key)) return undefined;
        return { enumerable: true, configurable: true };
      }
    });
  }

  const allKeys = [...knownKeys];
  return Object.freeze({
    owner: scope("runtime-owner", { read: allKeys, write: allKeys }),
    scope,
    snapshot(keys = allKeys) {
      return Object.fromEntries(normalizedKeys(keys).map((key) => {
        assertKnownKey(key, "runtime-snapshot");
        return [key, state[key]];
      }));
    }
  });
}

function initialAgentRuntimeState(defaultApi = "") {
  return {
    running: false,
    sessionId: "",
    apiBase: defaultApi,
    awaiting: "",
    messages: [],
    lastClickSignature: "",
    repeatClickCount: 0,
    lastClickAt: 0,
    failedLocalStrategies: [],
    skipPaidExtrasApproved: false,
    skipRoutineRunning: false,
    autopilotMode: true,
    pendingUserMessage: "",
    pendingUserResponse: null,
    pendingInputRequest: null,
    sessionProfileOverrides: {},
    currentAction: "",
    currentReason: "",
    currentStage: "",
    userGoal: "",
    reasoningLog: [],
    actionHistory: [],
    completedFields: {},
    sectionPlan: [],
    taskQueue: [],
    debugLog: [],
    flowLog: [],
    flowSeq: 0,
    activeTurnId: "",
    activeObservationId: "",
    activeExecutionActionId: "",
    activeExecutionObservationId: "",
    activeExecutionDecisionAction: "",
    actionLedger: [],
    lastActionResult: null,
    lastBackendDebug: null,
    processDiagnostics: null,
    sessionStartFailure: null,
    pageMap: null,
    lastPageMutationAt: Date.now(),
    pageUnderstanding: null,
    observerTab: "summary",
    lifecycleId: 0,
    loopRunSerial: 0,
    activeLoopRunId: 0,
    loopBusy: false,
    loopRerunQueued: false,
    activePlannerRequest: null,
    destinationWait: null,
    destinationWaitTimer: null,
    honoredReobserveRetryTokens: new Set(),
    lastSentMaterialHash: "",
    lastSentFeedbackKey: "",
    screenshotCache: new Map()
  };
}

const RUNTIME_SCOPES = Object.freeze({
  flow: { write: ["activeTurnId", "apiBase", "awaiting", "flowLog", "flowSeq", "pageMap", "running", "sessionId"] },
  lifecycle: {
    write: [
      "activeLoopRunId", "activePlannerRequest", "awaiting", "destinationWait", "destinationWaitTimer",
      "honoredReobserveRetryTokens", "lifecycleId", "loopBusy", "loopRerunQueued", "loopRunSerial", "running"
    ]
  },
  transactionEvidence: { read: ["activeObservationId"] },
  perception: { read: ["lastPageMutationAt", "pageMap"] },
  foregroundSurface: { read: ["pageMap"] },
  targeting: { write: ["failedLocalStrategies", "pageMap"] },
  debug: {
    read: [
      "actionHistory", "actionLedger", "activeObservationId", "activeTurnId", "awaiting", "debugLog",
      "flowLog", "lastActionResult", "lastBackendDebug", "messages", "pageMap", "repeatClickCount",
      "running", "sessionId", "skipPaidExtrasApproved", "skipRoutineRunning"
    ]
  },
  session: {
    write: [
      "activeExecutionActionId", "activeExecutionObservationId", "awaiting", "lastActionResult", "pageMap",
      "running", "sessionId", "sessionStartFailure", "userGoal"
    ]
  },
  screenshot: { read: ["activeObservationId"] },
  decision: {
    write: [
      "actionHistory", "activeLoopRunId", "activeObservationId", "activePlannerRequest", "activeTurnId",
      "destinationWait", "honoredReobserveRetryTokens", "lastActionResult", "lastBackendDebug",
      "lastSentFeedbackKey", "lastSentMaterialHash", "lifecycleId", "loopRerunQueued", "processDiagnostics",
      "screenshotCache", "sessionId"
    ]
  },
  execution: {
    write: [
      "actionHistory", "activeExecutionActionId", "activeExecutionDecisionAction", "activeExecutionObservationId",
      "activeObservationId", "awaiting", "lastBackendDebug", "lastClickAt", "lastClickSignature", "messages",
      "pageMap", "pendingInputRequest", "repeatClickCount", "running", "sessionProfileOverrides"
    ]
  },
  checkout: {
    write: [
      "actionHistory", "activeLoopRunId", "autopilotMode", "awaiting", "destinationWait", "lastClickAt",
      "lastClickSignature", "lifecycleId", "loopBusy", "loopRerunQueued", "messages", "observerTab", "pageMap",
      "pageUnderstanding", "pendingInputRequest", "pendingUserMessage", "pendingUserResponse", "processDiagnostics",
      "reasoningLog", "repeatClickCount", "running", "sessionId", "sessionProfileOverrides", "sessionStartFailure",
      "skipPaidExtrasApproved"
    ]
  },
  sidebar: {
    read: [
      "awaiting", "currentAction", "currentReason", "messages", "observerTab", "pageMap", "pageUnderstanding",
      "processDiagnostics", "reasoningLog", "running", "skipRoutineRunning", "userGoal"
    ]
  }
});

export function createAgentRuntimeContext(defaultApi = "") {
  const context = createRuntimeContext(initialAgentRuntimeState(defaultApi));
  const scopes = Object.fromEntries(Object.entries(RUNTIME_SCOPES).map(([name, permissions]) => (
    [name, context.scope(name, permissions)]
  )));
  return Object.freeze({
    owner: context.owner,
    scopes: Object.freeze(scopes),
    snapshot: context.snapshot
  });
}
