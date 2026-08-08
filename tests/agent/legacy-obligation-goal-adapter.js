// Historical goal-shaped projection for saved replay fixtures only.
// Production consumes CurrentObligation directly through scalar accessors.
const { obligationField } = require("../../apps/web/agent/current-obligation");

const FIELDS = [
  "goalId", "kind", "objective", "semanticGoal", "semanticEffect", "desiredValue",
  "profileCompatible", "risk", "riskClass", "successCondition", "outcomeContract", "postcondition",
  "expectedOutcome", "recoveryBudget", "observationId", "observationHash", "surfaceId",
  "semanticType", "family", "subjectId", "decisionGroupId", "requirementId",
  "logicalFieldId", "descriptorKey", "ordinal", "logicalStructure", "label", "field",
  "sectionType", "controlId", "componentRole", "canonicalValue", "inputValue",
  "expectedValue", "expectedNormalizedValue", "expectedCanonicalValue", "choiceLike",
  "componentBinding", "requirementContract", "validationOwnership", "dateCodec",
  "codecError", "reconciliation", "selectionMode", "policyChoiceBounded", "choiceTerms",
  "freeAlternativeControlIds", "paidAlternativeControlIds", "eligibleAlternativeControlIds",
  "semanticCorrectionControlIds", "candidateControlIds", "actionableControlIds",
  "policyAllowedControlIds", "surfaceExitControlIds", "completedDecisionGroupId",
  "parentSelectedControlId", "parentDecisionGroupId", "parentExpectedSelectedControlId",
  "surfaceExitOwnership", "parentOutcomeContract", "sourceGoalId",
  "policyCorrectionForDecisionGroupId", "semanticOwnershipLinkId", "intendedOutcome",
  "desiredPolicyOutcome", "desiredSemanticOutcome", "decisionEpisodeId",
  "decisionInstanceId", "canonicalOwnerId", "decisionEpisodeStatus", "transactionOutcomeId",
  "stageOutcomeId", "surfaceSubgoalId", "adaptiveEnvelope", "authorization", "admission",
  "ambiguity"
];

function legacyGoalFromObligation(obligation = null) {
  if (!obligation) return null;
  return Object.freeze(Object.fromEntries(FIELDS.map((field) => [field, obligationField(obligation, field)])));
}

module.exports = { legacyGoalFromObligation };
