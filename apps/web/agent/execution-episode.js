const EXECUTION_EPISODE_VERSION = "execution-episode/v2";
const { actionFromLease } = require("../../../packages/shared/agent-actions");

const RECOVERY_FIELDS = Object.freeze([
  "attempts",
  "phase",
  "stateHash",
  "attemptedCandidateIds",
  "failedStrategies",
  "failedStrategySignatures",
  "lastCode",
  "lastRevealSample",
  "outcomeId",
  "semanticOwnerId",
  "transitionTrail",
  "staleRebind",
  "remainingAttempts",
  "deadlineAt",
  "updatedAt"
]);

function array(value, limit) {
  return Array.isArray(value) ? value.slice(-limit) : [];
}

function emptyExecutionEpisode() {
  return {
    contractVersion: EXECUTION_EPISODE_VERSION,
    obligationId: "",
    leasedAction: null,
    status: "idle",
    actionId: "",
    observationId: "",
    candidateId: "",
    approved: false,
    dispatched: false,
    observed: false,
    verified: false,
    closed: false,
    awaitingClarification: false,
    awaitingDestination: false,
    navigation: false,
    navigationEpisodeId: "",
    navigationStatus: "",
    origin: null,
    sourceDocument: null,
    destinationDocument: null,
    destinationObservation: null,
    expectedPostcondition: null,
    destinationReadiness: null,
    resultCode: "",
    transitionStatus: "",
    resultObservationId: "",
    localOutcomeVerified: false,
    attempts: 0,
    phase: "idle",
    stateHash: "",
    attemptedCandidateIds: [],
    failedStrategies: [],
    failedStrategySignatures: [],
    lastCode: "",
    lastRevealSample: null,
    outcomeId: "",
    semanticOwnerId: "",
    transitionTrail: [],
    staleRebind: null,
    remainingAttempts: 0,
    deadlineAt: 0,
    lastResult: null,
    mechanicalEvidence: null,
    updatedAt: ""
  };
}

function normalizeExecutionEpisode(raw = null) {
  const source = raw && typeof raw === "object" ? raw : {};
  const { decisionInstanceId: legacyDecisionInstanceId = "", ...canonicalSource } = source;
  const leasedAction = source.leasedAction && typeof source.leasedAction === "object"
    ? { ...source.leasedAction }
    : null;
  const hydratedAction = actionFromLease(leasedAction?.actionLease || null);
  if (leasedAction && hydratedAction?.id && !leasedAction.originalAction) {
    Object.defineProperty(leasedAction, "originalAction", {
      value: hydratedAction,
      enumerable: false,
      configurable: false,
      writable: false
    });
  }
  return {
    ...emptyExecutionEpisode(),
    ...canonicalSource,
    contractVersion: EXECUTION_EPISODE_VERSION,
    obligationId: String(source.obligationId || leasedAction?.actionLease?.obligationId || ""),
    leasedAction,
    status: String(source.status || source.phase || "idle"),
    actionId: String(source.actionId || leasedAction?.actionLease?.actionId || leasedAction?.originalAction?.id || ""),
    observationId: String(source.observationId || ""),
    candidateId: String(source.candidateId || source.leasedAction?.actionLease?.candidateId || source.leasedAction?.candidateId || ""),
    semanticOwnerId: String(source.semanticOwnerId || legacyDecisionInstanceId || ""),
    approved: source.approved === true,
    dispatched: source.dispatched === true,
    observed: source.observed === true,
    verified: source.verified === true,
    closed: source.closed === true,
    awaitingClarification: source.awaitingClarification === true,
    awaitingDestination: source.awaitingDestination === true,
    navigation: source.navigation === true,
    navigationEpisodeId: String(source.navigationEpisodeId || ""),
    navigationStatus: String(source.navigationStatus || ""),
    sourceDocument: source.sourceDocument && typeof source.sourceDocument === "object"
      ? { ...source.sourceDocument }
      : null,
    destinationDocument: source.destinationDocument && typeof source.destinationDocument === "object"
      ? { ...source.destinationDocument }
      : null,
    destinationObservation: source.destinationObservation && typeof source.destinationObservation === "object"
      ? { ...source.destinationObservation }
      : null,
    expectedPostcondition: source.expectedPostcondition && typeof source.expectedPostcondition === "object"
      ? { ...source.expectedPostcondition }
      : null,
    attempts: Math.max(0, Number(source.attempts || 0)),
    phase: String(source.phase || "idle"),
    stateHash: String(source.stateHash || ""),
    attemptedCandidateIds: array(source.attemptedCandidateIds, 24),
    failedStrategies: array(source.failedStrategies || source.attemptedStrategies, 80),
    failedStrategySignatures: array(source.failedStrategySignatures || source.attemptedStrategySignatures, 80),
    lastCode: String(source.lastCode || ""),
    transitionTrail: array(source.transitionTrail, 12),
    remainingAttempts: Math.max(0, Number(source.remainingAttempts || 0)),
    deadlineAt: Math.max(0, Number(source.deadlineAt || source.destinationReadiness?.deadlineAt || 0)),
    updatedAt: String(source.updatedAt || "")
  };
}

function executionEpisodeFor(state = {}) {
  return normalizeExecutionEpisode(state.executionEpisode || null);
}

function recoveryFacts(state = {}) {
  const episode = executionEpisodeFor(state);
  return Object.fromEntries(RECOVERY_FIELDS.map((field) => [field, episode[field]]));
}

function leasedActionFor(state = {}) {
  return executionEpisodeFor(state).leasedAction || null;
}

function stripLegacyAuthorities(state = {}) {
  const {
    pendingAction: _pendingAction,
    actionLifecycle: _actionLifecycle,
    recoveryState: _recoveryState,
    pendingMechanicalEvidence: _pendingMechanicalEvidence,
    ...rest
  } = state;
  return rest;
}

function stateWithExecutionEpisode(state = {}, update = {}) {
  const previous = executionEpisodeFor(state);
  const next = normalizeExecutionEpisode({
    ...previous,
    ...update,
    updatedAt: update.updatedAt || previous.updatedAt || new Date().toISOString()
  });
  return { ...stripLegacyAuthorities(state), executionEpisode: next };
}

function updatedExecutionEpisode(state = {}, update = {}) {
  return normalizeExecutionEpisode({
    ...executionEpisodeFor(state),
    ...update,
    updatedAt: update.updatedAt || new Date().toISOString()
  });
}

function stateWithRecoveryFacts(state = {}, recovery = {}) {
  const update = {};
  for (const field of RECOVERY_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(recovery, field)) update[field] = recovery[field];
  }
  return stateWithExecutionEpisode(state, update);
}

module.exports = {
  EXECUTION_EPISODE_VERSION,
  emptyExecutionEpisode,
  executionEpisodeFor,
  leasedActionFor,
  normalizeExecutionEpisode,
  recoveryFacts,
  stateWithExecutionEpisode,
  stateWithRecoveryFacts,
  updatedExecutionEpisode,
  stripLegacyAuthorities
};
