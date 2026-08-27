// Historical goal-shaped projection for saved replay fixtures only.
// Production consumes the flat CurrentObligation contract directly. This
// adapter exists only for historical goal-shaped replay fixtures.

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
  const aliases = {
    goalId: obligation.id,
    kind: obligation.desiredStateDelta?.kind,
    objective: `satisfy ${obligation.semanticOwner?.family || obligation.desiredStateDelta?.family || "current obligation"}`,
    semanticGoal: `satisfy ${obligation.semanticOwner?.family || obligation.desiredStateDelta?.family || "current obligation"}`,
    semanticEffect: obligation.desiredStateDelta?.desiredEffect,
    desiredValue: obligation.desiredStateDelta?.desiredValue,
    riskClass: obligation.riskClass,
    observationId: obligation.observationId,
    surfaceId: obligation.desiredStateDelta?.surfaceId,
    semanticType: obligation.successCondition?.type === "active_surface_dismissed"
      || /dismiss_surface/.test(obligation.desiredStateDelta?.desiredEffect || "")
      || obligation.desiredStateDelta?.kind === "completed_choice_surface"
      ? "completed_choice_surface"
      : obligation.desiredStateDelta?.kind === "profile_field"
        ? obligation.semanticOwner?.family
        : obligation.desiredStateDelta?.family,
    family: obligation.desiredStateDelta?.family,
    subjectId: obligation.semanticOwner?.subjectId,
    decisionGroupId: obligation.desiredStateDelta?.decisionGroupId,
    requirementId: obligation.successCondition?.requirementId || "",
    logicalFieldId: obligation.successCondition?.logicalFieldId || obligation.semanticOwner?.repeatedInstance || "",
    componentRole: obligation.successCondition?.componentRole || "value",
    controlId: obligation.successCondition?.controlId || obligation.admittedControlIds?.[0] || "",
    canonicalValue: obligation.successCondition?.expectedCanonicalValue ?? obligation.desiredStateDelta?.desiredValue,
    inputValue: obligation.desiredStateDelta?.desiredValue,
    expectedValue: obligation.successCondition?.expectedValue ?? obligation.desiredStateDelta?.desiredValue,
    expectedNormalizedValue: obligation.successCondition?.expectedNormalizedValue ?? obligation.desiredStateDelta?.desiredValue,
    expectedCanonicalValue: obligation.successCondition?.expectedCanonicalValue ?? obligation.desiredStateDelta?.desiredValue,
    freeAlternativeControlIds: obligation.admittedControlIds,
    eligibleAlternativeControlIds: obligation.admittedControlIds,
    semanticCorrectionControlIds: obligation.successCondition?.expectedSelectedControlId
      ? [obligation.successCondition.expectedSelectedControlId]
      : [],
    parentDecisionGroupId: obligation.successCondition?.parentDecisionGroupId || "",
    parentExpectedSelectedControlId: obligation.successCondition?.parentExpectedSelectedControlId || "",
    decisionEpisodeId: obligation.successCondition?.decisionEpisodeId || "",
    profileCompatible: obligation.desiredStateDelta?.status === "EXACT_DELTA",
    outcomeContract: obligation.successCondition,
    postcondition: obligation.successCondition,
    candidateControlIds: obligation.admittedControlIds,
    actionableControlIds: obligation.admittedControlIds,
    policyAllowedControlIds: obligation.admittedControlIds,
    authorization: obligation.desiredStateDelta?.authorization,
    admission: obligation.desiredStateDelta?.status === "EXACT_DELTA"
      ? { status: "admitted", reason: "exact_desired_state_delta" }
      : { status: "blocked", reason: obligation.desiredStateDelta?.reason || "missing_exact_delta" },
    ambiguity: null
  };
  return Object.freeze(Object.fromEntries(FIELDS.map((field) => [
    field,
    Object.prototype.hasOwnProperty.call(aliases, field) ? aliases[field] : obligation[field]
  ])));
}

module.exports = { legacyGoalFromObligation };
