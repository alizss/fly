function executableDecisionFromActionLease(rawDecision = {}) {
  const lease = rawDecision.actionLease || null;
  if (lease?.contractVersion !== "action-lease/v1") return rawDecision;
  const operation = String(lease.mechanic?.operation || "");
  const semanticEffect = String(lease.expected?.semanticEffect || "");
  const actionType = String(lease.mechanic?.actionType || rawDecision.action || "stop");
  const interactionRole = ["choose", "select"].includes(operation)
    ? "choice"
    : operation === "open"
      ? "opener"
      : ["type", "select"].includes(actionType)
        ? "field"
        : /advance|navigate/.test(semanticEffect)
          ? "navigation"
          : "command";
  const successCondition = lease.expected?.successCondition || null;
  return {
    ...rawDecision,
    actionId: lease.actionId || rawDecision.actionId || "",
    observationId: lease.observation?.id || "",
    observationHash: lease.observation?.hash || "",
    action: actionType,
    intent: String(lease.expected?.objective || semanticEffect || actionType),
    operation,
    mechanicalEffect: String(lease.mechanic?.effect || operation),
    physicalEffect: String(lease.mechanic?.effect || operation),
    interactionRole,
    semanticEffect,
    expectedEvidence: String(successCondition?.type || ""),
    semanticIntent: semanticEffect,
    expectedPostconditions: successCondition ? [successCondition] : [],
    goalId: lease.obligationId || "",
    obligationId: lease.obligationId || "",
    semanticOwner: lease.semanticOwner || null,
    semanticOwnerId: lease.semanticOwnerId || "",
    decisionInstanceId: lease.semanticOwner?.repeatedInstance || "",
    candidateId: lease.candidateId || "",
    logicalControlId: lease.target?.controlId || "",
    controlId: lease.target?.controlId || "",
    actuatorId: lease.target?.actuatorId || "",
    targetId: lease.target?.actuatorId || "",
    targetSnapshot: null,
    decisionGroupId: String(
      successCondition?.decisionGroupId
      || successCondition?.parentDecisionGroupId
      || ""
    ),
    expectedOutcome: successCondition,
    affordance: null,
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
