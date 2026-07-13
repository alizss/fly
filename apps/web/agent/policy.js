// Server-side glue: adapts the planner's proposed action + session state +
// traveler profile into the shared policy engine's call shape, and turns
// its verdict into the fields the rest of the loop expects.

const { evaluateActionPolicy } = require("../../../packages/shared/policy");

/**
 * @param {import("../../../packages/shared/agent-actions").AgentAction} plannedAction
 * @param {import("../../../packages/shared/agent-state").CheckoutSessionState} state
 * @param {Object} traveler
 * @param {import("../../../packages/shared/agent-state").ApprovalState} approvalState
 * @returns {import("../../../packages/shared/policy").PolicyDecision}
 */
function checkPolicy(plannedAction, state, traveler, approvalState) {
  return evaluateActionPolicy(plannedAction, state, traveler || {}, approvalState || {});
}

module.exports = { checkPolicy };
