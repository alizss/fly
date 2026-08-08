const CURRENT_OBLIGATION_VERSION = "current-obligation/v2";

function isCurrentObligation(value = null) {
  return Boolean(value && value.contractVersion === CURRENT_OBLIGATION_VERSION);
}

function obligationField(obligation = null, field = "") {
  if (!obligation) return undefined;
  if (!isCurrentObligation(obligation)) return obligation[field];
  const subject = obligation.subject || {};
  const binding = obligation.binding || {};
  const component = binding.component || {};
  const choice = binding.choice || {};
  const surface = binding.surface || {};
  const lineage = binding.lineage || {};
  switch (field) {
    case "goalId": return obligation.obligationId;
    case "semanticGoal": return obligation.objective;
    case "semanticEffect": return obligation.desiredEffect;
    case "outcomeContract": return obligation.successCondition;
    case "postcondition": return component.semanticPostcondition || obligation.successCondition;
    case "expectedOutcome": return component.localPostcondition || obligation.successCondition;
    case "profileCompatible": return obligation.policyDecision?.profileCompatible !== false;
    case "riskClass": return obligation.risk;
    case "semanticType": return subject.semanticType || component.semanticType || "";
    case "family": return subject.family || "";
    case "subjectId": return subject.subjectId || "global";
    case "decisionGroupId": return subject.decisionGroupId || "";
    case "requirementId": return subject.requirementId || "";
    case "logicalFieldId": return component.logicalFieldId || subject.logicalFieldId || "";
    case "descriptorKey": return component.descriptorKey || "";
    case "ordinal": return component.ordinal;
    case "logicalStructure": return component.logicalStructure || "";
    case "label": return component.label || "";
    case "field": return component.field || "";
    case "sectionType": return surface.sectionType || "";
    case "controlId": return component.controlId || "";
    case "componentRole": return component.role || "";
    case "canonicalValue": return component.canonicalValue ?? obligation.desiredValue ?? "";
    case "inputValue": return component.inputValue ?? "";
    case "expectedValue": return component.expectedValue ?? component.inputValue ?? "";
    case "expectedNormalizedValue": return component.expectedNormalizedValue ?? obligation.desiredValue ?? "";
    case "expectedCanonicalValue": return component.expectedCanonicalValue ?? component.canonicalValue ?? obligation.desiredValue ?? "";
    case "choiceLike": return component.choiceLike === true;
    case "componentBinding": return component.componentContract || null;
    case "requirementContract": return component.requirementContract || null;
    case "validationOwnership": return component.validationOwnership || null;
    case "dateCodec": return component.dateCodec || null;
    case "codecError": return component.codecError || null;
    case "reconciliation": return component.reconciliation || null;
    case "selectionMode": return choice.mode || "";
    case "policyChoiceBounded": return choice.policyBounded === true;
    case "choiceTerms": return choice.terms || [];
    case "freeAlternativeControlIds": return choice.freeControlIds || [];
    case "paidAlternativeControlIds": return choice.paidControlIds || [];
    case "eligibleAlternativeControlIds": return choice.eligibleControlIds || [];
    case "semanticCorrectionControlIds": return choice.semanticCorrectionControlIds || [];
    case "candidateControlIds":
    case "actionableControlIds":
    case "policyAllowedControlIds": return obligation.admittedControlIds || [];
    case "surfaceExitControlIds": return surface.exitControlIds || [];
    case "completedDecisionGroupId": return surface.completedDecisionGroupId || "";
    case "parentSelectedControlId": return surface.parentSelectedControlId || "";
    case "parentDecisionGroupId": return surface.parentDecisionGroupId || "";
    case "parentExpectedSelectedControlId": return surface.parentExpectedSelectedControlId || "";
    case "surfaceExitOwnership": return surface.exitOwnership || null;
    case "parentOutcomeContract": return surface.parentOutcome || null;
    case "sourceGoalId": return lineage.sourceObligationId || "";
    case "policyCorrectionForDecisionGroupId": return lineage.policyCorrectionDecisionGroupId || "";
    case "semanticOwnershipLinkId": return lineage.semanticOwnershipLinkId || "";
    case "intendedOutcome": return lineage.intendedOutcome || "";
    case "desiredPolicyOutcome": return lineage.desiredPolicyOutcome || "";
    case "desiredSemanticOutcome": return lineage.desiredSemanticOutcome || "";
    case "decisionEpisodeId": return lineage.decisionEpisodeId || "";
    case "decisionInstanceId": return lineage.decisionInstanceId || "";
    case "canonicalOwnerId": return lineage.canonicalOwnerId || "";
    case "decisionEpisodeStatus": return lineage.decisionEpisodeStatus || "";
    case "transactionOutcomeId": return lineage.transactionOutcomeId || "";
    case "stageOutcomeId": return lineage.stageOutcomeId || "";
    case "surfaceSubgoalId": return lineage.surfaceSubgoalId || "";
    case "adaptiveEnvelope": return binding.adaptive || null;
    case "authorization": return obligation.policyDecision?.authorization || null;
    case "admission": return {
      status: obligation.policyDecision?.status || "",
      reason: obligation.policyDecision?.reason || ""
    };
    case "ambiguity": return obligation.policyDecision?.ambiguity || null;
    default: return obligation[field];
  }
}

function semanticOwner(obligation = null) {
  if (!isCurrentObligation(obligation)) return null;
  const subject = obligation.subject || {};
  const lineage = obligation.binding?.lineage || {};
  return Object.freeze({
    stage: String(subject.stage || ""),
    family: String(subject.family || ""),
    subjectId: String(subject.subjectId || "global"),
    passengerId: String(subject.passengerId || ""),
    segmentId: String(subject.segmentId || ""),
    repeatedInstance: String(subject.repeatedInstance || lineage.decisionInstanceId || subject.key || "")
  });
}

module.exports = {
  CURRENT_OBLIGATION_VERSION,
  isCurrentObligation,
  obligationField,
  semanticOwner
};
