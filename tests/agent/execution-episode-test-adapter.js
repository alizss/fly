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
  return executionEpisodeFor(state).leasedAction || null;
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
