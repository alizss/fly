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

// Browser verification owns whether a profile write satisfied its exact
// postcondition. Project each exact success contract into the one durable
// TaskState receipt instead of making scalar, date, and choice controls use
// different completion authorities.
const VERIFIED_PROFILE_OUTCOME_CODE_BY_TYPE = Object.freeze({
  normalized_value_changed: "NORMALIZED_VALUE_VERIFIED",
  logical_component_committed: "LOGICAL_COMPONENT_COMMITTED",
  date_value_committed: "DATE_VALUE_VERIFIED",
  field_value_changed: "FIELD_VALUE_VERIFIED"
});

const VERIFIED_PROFILE_EVIDENCE_SOURCE_BY_TYPE = Object.freeze({
  normalized_value_changed: "canonical_normalized_value_verifier",
  logical_component_committed: "canonical_parent_state_verifier",
  date_value_committed: "canonical_date_verifier",
  field_value_changed: "canonical_field_value_verifier"
});

function verifiedProfileSelectedValue(actionResult = {}, expected = {}, proof = {}) {
  const evidence = actionResult.outcome?.evidence || {};
  if (expected.type === "logical_component_committed" && proof.selectedCanonicalValue) {
    return clean(proof.selectedCanonicalValue);
  }
  if (expected.type === "date_value_committed") {
    return clean(
      evidence.actualCanonicalValue
      || expected.expectedCanonicalValue
      || evidence.actualComponentValue
      || expected.expectedNormalizedValue
    );
  }
  return clean(
    evidence.actualNormalizedValue
    || expected.expectedNormalizedValue
    || expected.expectedCanonicalValue
    || expected.expectedComponentValue
    || evidence.value
    || actionResult.action?.value
    || actionResult.action?.targetLabel
  );
}

function verifiedProfileComponentFromActionResult(actionResult = null, observationId = "") {
  if (!actionResult || typeof actionResult !== "object") return null;
  const expected = actionResult.expectedOutcome || {};
  const proof = actionResult.outcome?.evidence?.exactChildSettlement || {};
  const expectedSuccessCode = VERIFIED_PROFILE_OUTCOME_CODE_BY_TYPE[clean(expected.type)] || "";
  // FIELD_VALUE_VERIFIED without an expected normalized value proves only
  // that some value exists. That is insufficient to retire a profile fact.
  const exactFieldValueContract = expected.type !== "field_value_changed"
    || Boolean(clean(expected.expectedNormalizedValue));
  const verified = Boolean(
    expectedSuccessCode
    && exactFieldValueContract
    && actionResult.verified === true
    && actionResult.expectedOutcomeObserved === true
    && actionResult.postconditionSatisfied === true
    && actionResult.outcome?.ok === true
    && !clean(actionResult.failureCode)
    && clean(actionResult.outcome?.code) === expectedSuccessCode
  );
  if (!verified || !clean(expected.logicalFieldId) || !clean(expected.semanticType)) return null;
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
    selectedCanonicalValue: verifiedProfileSelectedValue(actionResult, expected, proof),
    evidenceSource: proof.contractVersion === "exact-child-choice-settlement/v1"
      ? "canonical_exact_child_verifier"
      : VERIFIED_PROFILE_EVIDENCE_SOURCE_BY_TYPE[expected.type]
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
