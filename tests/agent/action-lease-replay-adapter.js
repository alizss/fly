function executableDecisionFromActionLease(rawDecision = {}) {
  const lease = rawDecision.actionLease || null;
  if (lease?.contractVersion !== "action-lease/v1") return rawDecision;
  return {
    ...rawDecision,
    actionId: lease.actionId || rawDecision.actionId || "",
    observationId: lease.observation?.id || "",
    observationHash: lease.observation?.hash || "",
    action: lease.mechanic?.actionType || rawDecision.action || "stop",
    intent: lease.expected?.intent || lease.expected?.semanticEffect || rawDecision.action || "",
    operation: lease.mechanic?.operation || "",
    mechanicalEffect: lease.mechanic?.effect || "",
    physicalEffect: lease.mechanic?.effect || "",
    interactionRole: lease.expected?.interactionRole || "",
    semanticEffect: lease.expected?.semanticEffect || "",
    expectedEvidence: lease.expected?.evidence || "",
    semanticIntent: lease.expected?.semanticEffect || "",
    expectedPostconditions: lease.expected?.postconditions || [],
    goalId: lease.obligationId || "",
    obligationId: lease.obligationId || "",
    semanticOwner: lease.semanticOwner || null,
    decisionInstanceId: lease.semanticOwner?.repeatedInstance || "",
    candidateId: lease.candidateId || "",
    logicalControlId: lease.target?.controlId || "",
    controlId: lease.target?.controlId || "",
    actuatorId: lease.target?.actuatorId || "",
    targetId: lease.target?.actuatorId || "",
    targetSnapshot: lease.target?.snapshot || null,
    decisionGroupId: lease.target?.decisionGroupId || lease.target?.snapshot?.decisionGroupId || "",
    expectedOutcome: lease.expected?.successCondition || null,
    affordance: lease.expected?.policyAuthorization ? {
      policy: lease.expected.policyAuthorization
    } : null,
    pipelineContract: lease.capabilityProof || null,
    interactionMethod: lease.mechanic?.method || "",
    boundedRecovery: lease.mechanic?.boundedRecovery === true,
    exactOption: lease.mechanic?.exactOption || null,
    value: lease.mechanic?.value || "",
    keys: lease.mechanic?.keys || "",
    x: lease.mechanic?.x,
    y: lease.mechanic?.y,
    scrollY: lease.mechanic?.scrollY,
    visualRegion: lease.mechanic?.visualRegion || null,
    risk: lease.risk || rawDecision.risk || "uncertain"
  };
}

module.exports = { executableDecisionFromActionLease };
