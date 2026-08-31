const { enqueueTrace } = require("../trace-store");
const {
  createActionLease,
  normalizeAction
} = require("../../../../packages/shared/agent-actions");
const { withUpdate } = require("../../../../packages/shared/agent-state");
const { currentObligation } = require("../authority-frames");

function taskMechanics(taskState = {}) {
  return currentObligation(taskState);
}

function finalHandoffAction(reason, observation = {}, overrides = {}) {
  return normalizeAction({
    ...overrides,
    observationId: overrides.observationId || observation.observationId || "",
    observationHash: overrides.observationHash || observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
    type: "ask_user",
    intent: "ask_user",
    reason: String(reason || overrides.reason || "User input is required before another action."),
    risk: overrides.risk || "uncertain",
    requiresApproval: true
  });
}

function policyBlockedAction(governance, action) {
  if (governance.allow) return action;
  const reason = governance.reason || action.reason || "The action governor blocked the planned action.";
  if (governance.decision === "requires_user") {
    return finalHandoffAction(reason, {}, {
      id: `${action.id || `act_${Date.now().toString(36)}`}:blocked`,
      observationId: action.observationId || "",
      observationHash: action.observationHash || ""
    });
  }
  return normalizeAction({
    id: `${action.id || `act_${Date.now().toString(36)}`}:blocked`,
    observationId: action.observationId || "",
    observationHash: action.observationHash || "",
    type: "stop",
    intent: "governed_execution_blocked",
    mechanicalEffect: "unknown",
    expectedPostconditions: [],
    reason,
    risk: "safe",
    requiresApproval: false
  });
}


function summarizeTurn({ pageState, requirements, plannedAction, finalAction, policyDecision, deterministicAction, reusedAiDecision = {}, taskState = null, taskReadModel = null }) {
  return {
    planned: {
      type: plannedAction?.type || "",
      label: plannedAction?.targetLabel || plannedAction?.value || plannedAction?.targetId || "",
      risk: plannedAction?.risk || "",
      reason: plannedAction?.reason || ""
    },
    final: {
      type: finalAction?.type || "",
      label: finalAction?.targetLabel || finalAction?.value || finalAction?.targetId || "",
      risk: finalAction?.risk || "",
      reason: finalAction?.reason || ""
    },
    policy: policyDecision ? {
      allow: policyDecision.allow,
      decision: policyDecision.decision,
      reason: policyDecision.reason
    } : null,
    deterministic: Boolean(deterministicAction),
    reusedAiDecision: {
      candidateSelection: reusedAiDecision.candidateSelection === true
    },
    // Read-only testing projection. The browser sidebar may display this, but
    // it never feeds candidate construction, policy, execution, or completion.
    processAwareness: taskReadModel?.processAwareness || null,
    transactionReview: taskReadModel?.transactionReview || null,
    missing: [],
    navigation: (pageState?.navigationActions || []).slice(0, 8).map((nav) => ({
      action: nav.action,
      label: nav.label,
      enabled: nav.enabled,
      risk: nav.risk,
      targetId: nav.targetId
    })),
    riskGates: (pageState?.riskGates || []).slice(0, 6).map((gate) => ({
      type: gate.type,
      label: gate.label,
      status: gate.status,
      risk: gate.risk
    })),
    currentSurface: pageState?.currentSurface || null
  };
}

function toClientDecision(action) {
  const mechanicalAction = ["click", "type", "select", "keypress", "scroll", "click_xy"].includes(action.type);
  const actionLease = mechanicalAction ? createActionLease(action) : null;
  const decision = {
    source: "agent-loop",
    actionId: action.id || "",
    action: action.type,
    actionLease,
    candidateClass: action.candidateClass || "proven_action",
    mechanicalHypothesis: action.mechanicalHypothesis === true,
    discoveryEnvelope: action.discoveryEnvelope || null,
    targetLabel: action.targetLabel || "",
    capabilityStatus: action.capabilityStatus || "",
    executionChannel: action.executionChannel || "",
    inputRequest: action.inputRequest || null,
    readinessStartedAt: Number(action.readinessStartedAt || 0),
    readinessDeadlineAt: Number(action.readinessDeadlineAt || 0),
    readinessAttempts: Number(action.readinessAttempts || 0),
    reobserveRetryToken: action.reobserveRetryToken || "",
    settlementActionId: action.settlementActionId || "",
    message: action.reason || "Working on the next step.",
    needsApproval: action.requiresApproval,
    userActionRequired: action.userActionRequired === true,
    risk: action.risk,
    reason: action.reason
  };
  if (!mechanicalAction) {
    decision.observationId = action.observationId || "";
    decision.observationHash = action.observationHash || "";
    decision.intent = action.intent || action.type || "";
    decision.expectedPostconditions = (action.expectedPostconditions || [])
      .filter((postcondition) => postcondition && typeof postcondition === "object")
      .map((postcondition) => ({ ...postcondition }));
  }
  return decision;
}




function modelUsageFromMetas(model, metas = []) {
  const calls = metas.filter(Boolean).map((meta) => ({
    schemaName: meta.schemaName || "",
    model: meta.model || model || "",
    duration_ms: Number(meta.durationMs || 0),
    attempts: Number(meta.attempts || 0),
    input_tokens: Number(meta.input_tokens || 0),
    output_tokens: Number(meta.output_tokens || 0),
    total_tokens: Number(meta.total_tokens || 0)
  }));
  return {
    model: calls.find((call) => call.model)?.model || model || "",
    input_tokens: calls.reduce((sum, call) => sum + call.input_tokens, 0),
    output_tokens: calls.reduce((sum, call) => sum + call.output_tokens, 0),
    total_tokens: calls.reduce((sum, call) => sum + call.total_tokens, 0),
    calls
  };
}

function withLatencyDebug(debug = {}, latency = {}, modelUsage = {}) {
  return {
    ...debug,
    latency,
    modelUsage
  };
}

function finishTurn({
  dataDir,
  sessionId,
  turnId,
  screenshotDataUrl = "",
  observation = null,
  state,
  action,
  debug = {},
  transactionStore = null,
  pageState = null,
  requirements = null,
  requirementLifecycle = [],
  verification = null,
  plannedAction = null,
  policyDecision = null,
  executionResult = null
}) {
  transactionStore?.saveSession?.(state);
  enqueueTrace(dataDir, sessionId || state?.id, {
    turnId,
    screenshotDataUrl,
    observation,
    pageState,
    requirements: requirements || [],
    requirementLifecycle,
    verification,
    plannedAction: plannedAction || action,
    policyDecision,
    executionResult: executionResult || {
      endingAction: action?.type || "",
      endingIntent: action?.intent || "",
      stopped: ["stop", "ask_user", "final_review"].includes(action?.type)
    },
    debug
  });
  return {
    state,
    clientDecision: toClientDecision(action),
    debug
  };
}

function safePlannerFailureResult({ dataDir, state, turnId, screenshotDataUrl, traceObservation, reason, error = null, latency = {}, modelUsage = {} }) {
  const failureAction = finalHandoffAction(reason, traceObservation || {});
  const nextState = withUpdate(state, {
    lastAction: failureAction,
    status: "awaiting_user"
  });
  const debug = {
    fallback: false,
    planned: null,
    final: {
      type: failureAction.type,
      label: "",
      risk: failureAction.risk,
      reason: failureAction.reason
    },
    policy: { allow: false, decision: "ask_user", reason },
    deterministic: false,
    missing: [],
    navigation: [],
    riskGates: [],
    error: error?.message || (error ? String(error) : "")
  };
  const debugWithLatency = withLatencyDebug(debug, latency, modelUsage);
  enqueueTrace(dataDir, state.id, {
    turnId,
    screenshotDataUrl,
    observation: traceObservation,
    pageState: null,
    requirements: [],
    verification: null,
    plannedAction: null,
    policyDecision: debug.policy,
    executionResult: { stopped: true, reason, error: debug.error },
    debug: debugWithLatency
  });
  return {
    state: nextState,
    clientDecision: toClientDecision(failureAction),
    debug: debugWithLatency
  };
}

function plannerFailureReason(error) {
  const message = String(error?.message || error || "");
  if (/incorrect api key|invalid api key|authentication|\b401\b/i.test(message)) {
    return "The configured OpenAI API key was rejected while resolving a genuinely ambiguous current surface. Update the development API key, then continue the same checkout session.";
  }
  if (/OPENAI_API_KEY is not set/i.test(message)) {
    return "OPENAI_API_KEY is not configured. A model is used only to reconcile genuinely ambiguous semantic meaning; mechanics remain deterministic.";
  }
  if (error?.code === "MODEL_PACKET_TOO_LARGE") {
    return "Semantic-reconciliation context exceeded its local safety bound before any model call.";
  }
  if (/returned no output text|invalid JSON after retry/i.test(message)) {
    return "Semantic reconciliation returned no usable grounded hypothesis after a bounded retry.";
  }
  return "The semantic-reconciliation model is unavailable; no mechanical target or operation depends on it.";
}


/**
 * @param {Object} args
 * @param {string} args.apiKey
 * @param {string} args.model
 * @param {string} args.dataDir base dir for traces (server's `work/` dir)
 * @param {import("../../../packages/shared/agent-state").CheckoutSessionState} args.state
 * @param {Object} args.observation AgentObservation from the extension
 * @param {Object} args.traveler
 * @returns {Promise<{ state: Object, clientDecision: Object }>}
 */

module.exports = {
  finalHandoffAction,
  finishTurn,
  modelUsageFromMetas,
  plannerFailureReason,
  policyBlockedAction,
  safePlannerFailureResult,
  summarizeTurn,
  toClientDecision,
  withLatencyDebug
};
