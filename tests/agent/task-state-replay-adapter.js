// Explicit raw-observation adapter for tests and saved-trace tooling.
// Production imports only reduceDecisionFrame and therefore cannot trigger
// hidden semantic compilation or V1 currentGoal recovery.

const {
  compileDecisionFrame,
  decisionFrameOwnsObservation
} = require("../../apps/web/agent/authority-frames");
const { compileCurrentObligation } = require("./obligation-test-helper");
const { legacyGoalFromObligation } = require("./legacy-obligation-goal-adapter");
const { reduceDecisionFrame, taskStateReadModel } = require("../../apps/web/agent/task-state-reducer");
const { profileGoalForDescriptor } = require("../../apps/web/agent/profile-mechanics");

function legacyGoalForResult(result = {}, decisionFrame = {}, traveler = {}) {
  const obligation = result.currentObligation || null;
  const base = legacyGoalFromObligation(obligation);
  if (!base || !obligation) return base;
  if (obligation.desiredStateDelta?.kind === "profile_field") {
    const success = obligation.successCondition || {};
    const descriptor = (decisionFrame.profileRequirements || []).find((candidate) => (
      (!success.controlId || candidate.control?.controlId === success.controlId)
      && (!success.logicalFieldId || candidate.logicalFieldId === success.logicalFieldId)
      && (!success.componentRole || candidate.componentRole === success.componentRole)
    ));
    return descriptor
      ? Object.freeze({
          ...base,
          ...profileGoalForDescriptor(descriptor, decisionFrame.observation || {}, base),
          goalId: base.goalId
        })
      : base;
  }
  const readModel = taskStateReadModel(result) || {};
  const decisionGroupId = obligation.desiredStateDelta?.decisionGroupId || "";
  const decision = (readModel.canonicalDecisions || []).find((candidate) => (
    candidate.decisionGroupId === decisionGroupId
  )) || null;
  const transitions = decision?.availableTransitions || [];
  const obligationSemanticType = obligation.semanticType || base.semanticType;
  const projectDecisionFamilyAsSemanticType = ![
    "completed_choice_surface",
    "navigation"
  ].includes(obligationSemanticType);
  const legacySemanticTypeByFamily = {
    seat: "seat_selection",
    insurance: "insurance",
    baggage: "baggage",
    fare: "fare_package"
  };
  const decisionSemanticType = legacySemanticTypeByFamily[decision?.family]
    || decision?.family
    || obligationSemanticType;
  const admitted = new Set(obligation.admittedControlIds || []);
  const freeAlternativeControlIds = transitions.filter((transition) => (
    admitted.has(transition.controlId)
    && transition.paid !== true
    && Number(transition.price?.amount || 0) === 0
    && !/continue|navigation|advance|next|back/.test(
      `${transition.semantic || ""} ${transition.physicalEffect || ""} ${transition.risk || ""}`.toLowerCase()
    )
  )).map((transition) => transition.controlId).filter(Boolean);
  const paidAlternativeControlIds = transitions.filter((transition) => (
    transition.paid === true || Number(transition.price?.amount) > 0
  )).map((transition) => transition.controlId).filter(Boolean);
  return Object.freeze({
    ...base,
    semanticType: projectDecisionFamilyAsSemanticType
      ? decisionSemanticType
      : obligationSemanticType,
    desiredSemanticOutcome: decision?.userIntent?.desiredOutcome || base.desiredSemanticOutcome,
    desiredPolicyOutcome: decision?.userIntent?.desiredOutcome || base.desiredPolicyOutcome,
    family: decision?.family || base.family,
    surfaceId: decision?.surfaceId || base.surfaceId,
    policyAllowedControlIds: obligation.admittedControlIds,
    candidateControlIds: obligation.admittedControlIds,
    actionableControlIds: obligation.admittedControlIds,
    eligibleAlternativeControlIds: transitions.map((transition) => transition.controlId).filter(Boolean),
    freeAlternativeControlIds,
    paidAlternativeControlIds,
    parentDecisionGroupId: obligation.successCondition?.parentDecisionGroupId
      || result.decisionEpisode?.parentDecisionGroupId
      || base.parentDecisionGroupId,
    decisionEpisodeId: obligation.successCondition?.decisionEpisodeId
      || result.decisionEpisode?.episodeId
      || base.decisionEpisodeId
  });
}

function reduceTaskState(args = {}) {
  const observation = args.observation || {};
  const decisionFrame = decisionFrameOwnsObservation(args.decisionFrame, observation)
    ? args.decisionFrame
    : compileDecisionFrame({
        observation,
        state: args.state || (args.transactionReview?.baseline ? {
          transactionInvariants: { baseline: args.transactionReview.baseline }
        } : {}),
        traveler: args.traveler || {}
      });
  const legacyGoal = args.previousTaskState?.currentGoal || null;
  // Saved replays can explicitly replace the historical currentGoal between
  // turns. Always rebind that test-only projection to a canonical obligation;
  // otherwise an older minimal obligation can silently win over the fixture's
  // intended previous state. Production has no currentGoal compatibility
  // projection and never executes this path.
  const previousTaskState = legacyGoal
    ? {
        ...args.previousTaskState,
        currentObligation: compileCurrentObligation({ work: legacyGoal })
      }
    : args.previousTaskState;
  const result = reduceDecisionFrame({ ...args, previousTaskState, decisionFrame });
  const readModel = taskStateReadModel(result) || {};
  return Object.freeze({
    ...result,
    ...readModel,
    currentGoal: legacyGoalForResult(result, decisionFrame, args.traveler || {})
  });
}

module.exports = { reduceTaskState };
