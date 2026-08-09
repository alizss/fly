const {
  executionEpisodeFor,
  recoveryFacts,
  stateWithExecutionEpisode
} = require("../../apps/web/agent/execution-episode");

function withExecutionFixture(state = {}, {
  leasedAction,
  lifecycle,
  recovery,
  mechanicalEvidence
} = {}) {
  return stateWithExecutionEpisode(state, {
    ...(lifecycle || {}),
    ...(recovery || {}),
    ...(leasedAction !== undefined ? { leasedAction } : {}),
    ...(mechanicalEvidence !== undefined ? { mechanicalEvidence } : {})
  });
}

function leasedAction(state = {}) {
  const leased = executionEpisodeFor(state).leasedAction || null;
  if (!leased) return null;
  return {
    ...leased,
    obligationId: leased.actionLease?.obligationId || "",
    candidateId: leased.actionLease?.candidateId || "",
    originalAction: leased.originalAction || null
  };
}

function lifecycle(state = {}) {
  return executionEpisodeFor(state);
}

function mechanicalEvidence(state = {}) {
  return executionEpisodeFor(state).mechanicalEvidence || null;
}

function recovery(state = {}) {
  return recoveryFacts(state);
}

module.exports = {
  leasedAction,
  lifecycle,
  mechanicalEvidence,
  recovery,
  withExecutionFixture
};
