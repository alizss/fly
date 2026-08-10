const { verifiedProfileComponentMatchesDescriptor } = require("../profile-requirements");
const agentContract = require("../../../extension/src/shared/agent-contract");

function clean(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function verifiedProfileComponentIdentity(value = {}) {
  return [
    clean(value.subjectId || "traveler_1"),
    clean(value.logicalFieldId || value.semanticType),
    clean(value.componentRole || "value")
  ].join("::");
}

function verifiedProfileComponentFromActionResult(actionResult = null, observationId = "") {
  if (!actionResult || typeof actionResult !== "object") return null;
  const expected = actionResult.expectedOutcome || {};
  const proof = actionResult.outcome?.evidence?.exactChildSettlement || {};
  const verified = Boolean(
    actionResult.verified === true
    && actionResult.expectedOutcomeObserved === true
    && actionResult.postconditionSatisfied === true
    && actionResult.outcome?.ok === true
    && clean(actionResult.outcome?.code || actionResult.failureCode) === "LOGICAL_COMPONENT_COMMITTED"
  );
  if (!verified || expected.type !== "logical_component_committed") return null;
  const completion = {
    contractVersion: "verified-profile-component/v1",
    completionId: verifiedProfileComponentIdentity({
      subjectId: expected.subjectId,
      logicalFieldId: expected.logicalFieldId,
      semanticType: expected.semanticType,
      componentRole: expected.componentRole
    }),
    status: "verified",
    actionId: clean(actionResult.actionId || actionResult.action?.id),
    observationId: clean(observationId || actionResult.resultObservationId || actionResult.observationId),
    logicalFieldId: clean(expected.logicalFieldId),
    subjectId: clean(expected.subjectId || "traveler_1"),
    semanticType: clean(expected.semanticType),
    componentRole: clean(expected.componentRole || "value"),
    parentControlId: clean(expected.controlId),
    selectedControlId: clean(proof.selectedControlId || actionResult.controlId || actionResult.action?.controlId),
    selectedActuatorId: clean(proof.selectedActuatorId || actionResult.action?.actuatorId || actionResult.action?.targetId),
    desiredCanonicalValue: clean(
      proof.desiredCanonicalValue
      || expected.expectedCanonicalValue
      || expected.expectedNormalizedValue
      || expected.expectedComponentValue
    ),
    selectedCanonicalValue: clean(
      proof.selectedCanonicalValue
      || actionResult.action?.value
      || actionResult.action?.targetLabel
    ),
    evidenceSource: proof.contractVersion === "exact-child-choice-settlement/v1"
      ? "canonical_exact_child_verifier"
      : "canonical_parent_state_verifier"
  };
  if (!completion.completionId || !completion.actionId || !completion.selectedCanonicalValue) return null;
  if (!agentContract.profileChoiceValueCompatible(
    completion.selectedCanonicalValue,
    completion.desiredCanonicalValue,
    completion.semanticType
  )) return null;
  return Object.freeze(completion);
}

function verifiedProfileComponentContradicted(completion = {}, descriptors = []) {
  const matching = descriptors.filter((descriptor) => (
    verifiedProfileComponentMatchesDescriptor(completion, descriptor)
    || Boolean(
      completion.logicalFieldId
      && descriptor.logicalFieldId
      && completion.logicalFieldId === descriptor.logicalFieldId
    )
  ));
  if (!matching.length) return false;
  return matching.some((descriptor) => {
    const validationErrors = [
      ...(descriptor.validationIssues || []),
      ...(descriptor.logicalFieldValidationIssues || [])
    ];
    if (validationErrors.length) return true;
    const currentValue = clean(
      descriptor.currentNormalizedValue
      || descriptor.control?.state?.normalizedValue
      || descriptor.control?.state?.selectedValue
      || descriptor.control?.state?.optionValue
    );
    return Boolean(
      currentValue
      && !agentContract.profileChoiceValueCompatible(
        currentValue,
        completion.desiredCanonicalValue,
        completion.semanticType
      )
    );
  });
}

function reconcileVerifiedProfileComponents(previous = [], admitted = null, descriptors = []) {
  const components = new Map();
  for (const completion of Array.isArray(previous) ? previous : []) {
    if (completion?.contractVersion === "verified-profile-component/v1" && completion?.status === "verified") {
      components.set(completion.completionId, completion);
    }
  }
  if (admitted) components.set(admitted.completionId, admitted);
  for (const [completionId, completion] of components.entries()) {
    if (verifiedProfileComponentContradicted(completion, descriptors)) components.delete(completionId);
  }
  return Object.freeze([...components.values()].slice(-80));
}

function verifiedProfileComponentMatchesDecision(completion = {}, decision = {}) {
  if (clean(decision.family || decision.subject?.family) !== "profile") return false;
  const semanticType = clean(
    decision.semanticType
    || decision.subject?.key
    || decision.observed?.fieldType
    || decision.observed?.semanticType
  );
  if (!semanticType || semanticType !== clean(completion.semanticType)) return false;
  const physicalControlIds = new Set([
    ...(decision.physicalControlIds || []),
    decision.controlId,
    decision.observed?.controlId
  ].map(clean).filter(Boolean));
  return Boolean(completion.parentControlId && physicalControlIds.has(clean(completion.parentControlId)));
}

module.exports = {
  reconcileVerifiedProfileComponents,
  verifiedProfileComponentFromActionResult,
  verifiedProfileComponentMatchesDecision
};
