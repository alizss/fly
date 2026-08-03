const {
  actionForObservationCandidate,
  buildObservationCandidateSet
} = require("./observation-candidates");
const {
  actionForProfileCandidate,
  candidatesForProfileGoal
} = require("./skill-expander");
const {
  controlBelongsToCurrentSurface,
  surfaceBinding
} = require("./surface-contract");
const {
  buildSemanticAffordance,
  compileTypedExpectedOutcome,
  assessOutcomeCompatibility,
  expectedPostconditionsForAction,
  outcomeContractForGoal,
  predictPhysicalEffect,
  semanticIntentForAction,
  normalizedActionSemantics
} = require("./action-semantics");
const { evaluateActionPolicy } = require("../../../packages/shared/policy");
const {
  actuatorSignature,
  isCandidateGrounded,
  normalizeVisualRegion
} = require("../../../packages/shared/agent-actions");
const agentContract = require("../../extension/src/shared/agent-contract");

function candidateOperation(candidate = {}) {
  return candidate.authorizedOperation
    || (candidate.operation === "scroll_to" ? "" : candidate.operation)
    || "";
}

function operationUsesExecutableActuator(control = {}, candidate = {}) {
  return [
    agentContract.EXECUTION_LANE.NORMAL,
    agentContract.EXECUTION_LANE.BOUNDED_RECOVERY
  ].includes(candidate.executionChannel);
}

function controlUnavailable(control = {}, candidate = {}) {
  const underlyingStateDisabled = control.disabled === true || control.state?.disabled === true;
  return (underlyingStateDisabled && !operationUsesExecutableActuator(control, candidate))
    || control.state?.available === false
    || /(?:^|\b)(?:not available|unavailable|sold out|disabled)(?:\b|$)/i.test(
      `${control.semantic || ""} ${control.risk || ""} ${control.label || ""}`
    );
}

function candidateActionabilityFailure(candidate = {}, control = {}, observation = {}, strategyAlreadyFailed = false) {
  if (!["click", "type", "select", "keypress", "scroll", "click_xy"].includes(candidate.type)) return "";
  if (!isCandidateGrounded(candidate, observation)) return "ACTIONABILITY_UNPROVEN";
  const lane = agentContract.classifyExecutionLane({
    action: candidate,
    pipelineContract: candidate.pipelineContract,
    control,
    observation,
    strategyAlreadyFailed
  });
  if (lane === agentContract.EXECUTION_LANE.NORMAL) return "";
  if (lane === agentContract.EXECUTION_LANE.REVEAL) return "TARGET_NOT_REVEALED";
  if (lane === agentContract.EXECUTION_LANE.BOUNDED_RECOVERY) return "ACTIONABILITY_UNPROVEN";
  return strategyAlreadyFailed ? "FAILED_STRATEGY_REUSE" : "TARGET_NOT_ACTIONABLE";
}

function surfaceOwnershipForCandidate(goal = {}, candidate = {}, control = {}, observation = {}) {
  const ownership = goal.surfaceExitOwnership || candidate.pipelineContract?.surfaceOwnership || null;
  if (
    goal.semanticType !== "completed_choice_surface"
    || ownership?.kind !== "parent_controls_active_surface"
    || ownership?.status !== "proven"
    || ownership.parentControlId !== control.controlId
    || !candidate.targetId
    || !["open", "activate"].includes(candidateOperation(candidate))
  ) return null;
  return {
    ...ownership,
    observationId: observation.observationId || ownership.observationId || "",
    parentActuatorId: candidate.targetId,
    operation: candidateOperation(candidate)
  };
}

function pipelineContractForCandidate(goal = {}, candidate = {}, control = {}, expectedOutcome = {}, observation = {}) {
  const observed = agentContract.observedComponentContract(control, {
    surfaceId: control.surfaceId || candidate.surfaceId || ""
  });
  const operation = candidateOperation(candidate);
  const existing = candidate.pipelineContract || null;
  let capability = existing?.capability || observed.capabilities.find((item) => (
    item.operation === operation
    && (
      candidate.type === "click_xy" || candidate.boundedRecovery === true
        ? item.status === agentContract.CAPABILITY_STATUS.UNPROVEN_EXPERIMENT
        : !candidate.targetId || item.actuatorIds?.includes(candidate.targetId)
    )
  )) || observed.capabilities.find((item) => item.operation === operation) || {};
  const exact = (capability.exactActuators || []).find((item) => item.actuatorId === candidate.targetId);
  capability = {
    ...capability,
    actuatorId: candidate.targetId || capability.actuatorId || "",
    selectedStrategy: (capability.strategies || []).find((strategy) => (
      strategy.actuatorId === candidate.targetId
      && (!candidate.interactionMethod || strategy.method === candidate.interactionMethod)
    )) || null,
    status: candidate.type === "click_xy" || candidate.boundedRecovery === true
      ? agentContract.CAPABILITY_STATUS.UNPROVEN_EXPERIMENT
      : exact?.status || capability.status || agentContract.CAPABILITY_STATUS.UNAVAILABLE,
    proof: exact?.proof || capability.proof || capability.actionability || null
  };
  return agentContract.canonicalPipelineContract({
    requirement: existing?.requirement || goal.requirementContract || {
      requirementId: goal.requirementId || goal.goalId || goal.decisionGroupId || "",
      subjectId: goal.subjectId || "",
      semanticType: goal.semanticType || goal.sectionType || "",
      desiredCanonicalValue: goal.canonicalValue || goal.desiredValue || ""
    },
    component: existing?.component || goal.componentBinding || {
      logicalFieldId: goal.logicalFieldId || "",
      componentIdentity: `${goal.logicalFieldId || control.stableKey || control.controlId}:${goal.componentRole || "value"}`,
      componentRole: goal.componentRole || "value",
      controlId: control.controlId || candidate.controlId || "",
      controlRole: control.role || control.kind || "",
      currentCanonicalValue: observed.currentCanonicalValue || "",
      desiredCanonicalValue: goal.desiredValue || goal.canonicalValue || "",
      observedOptions: observed.observedOptions || []
    },
    capability,
    expectedOutcome,
    validationOwnership: existing?.validationOwnership || goal.validationOwnership || observed.validationOwnership || {},
    surfaceOwnership: surfaceOwnershipForCandidate(goal, candidate, control, observation)
      || existing?.surfaceOwnership
      || null
  });
}

function candidatePolicyAction(goal = {}, candidate = {}, control = {}, observation = {}) {
  return {
    ...actionForCurrentCandidate(goal, candidate, observation),
    targetSnapshot: {
      id: candidate.targetId || "",
      controlId: candidate.controlId || "",
      decisionGroupId: candidate.decisionGroupId || control.decisionGroupId || "",
      semantic: control.semantic || candidate.semantic || "",
      risk: control.risk || candidate.risk || "uncertain",
      kind: control.kind || "",
      role: control.role || "",
      surfaceId: candidate.surfaceId || control.surfaceId || "",
      surfaceType: candidate.surfaceType || control.surfaceType || "page",
      intendedOutcome: candidate.intendedOutcome || "",
      semanticOwnershipLinkId: candidate.semanticOwnershipLinkId || "",
      policyCorrectionForDecisionGroupId: candidate.policyCorrectionForDecisionGroupId || ""
    }
  };
}

function observationHash(observation = {}) {
  return String(observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "");
}

function capabilityKey(candidate = {}) {
  return [candidate.controlId, candidate.operation, candidate.targetId, candidate.type, candidate.interactionMethod, candidate.value, candidate.keys]
    .map(String)
    .join("::");
}

function relevantToVisibleSurface(goal = {}, candidate = {}, isGoalCandidate = false) {
  if (isGoalCandidate) return true;
  if (goal.selectionMode === "ai_ambiguity" || goal.semanticType === "surface_ambiguity") return true;
  if (goal.kind === "profile_field" || goal.decisionGroupId) return false;
  if (goal.semanticType === "navigation") {
    const ids = new Set(goal.actionableControlIds || []);
    return ids.has(candidate.controlId);
  }
  return false;
}

function allCurrentCapabilityCandidates(goal = {}, observation = {}, traveler = {}) {
  const goalCandidates = goal.kind === "profile_field"
    ? candidatesForProfileGoal(goal, observation, traveler, [], { includeAlternates: true })
    : buildObservationCandidateSet(goal, observation).candidates;
  const contextGoal = {
    ...goal,
    kind: "",
    semanticType: "surface_ambiguity",
    selectionMode: "ai_ambiguity",
    decisionGroupId: "",
    requirementId: "",
    eligibleAlternativeControlIds: [],
    freeAlternativeControlIds: [],
    paidAlternativeControlIds: []
  };
  const surfaceCandidates = buildObservationCandidateSet(contextGoal, observation).candidates;
  const byCapability = new Map(surfaceCandidates.map((candidate) => [capabilityKey(candidate), candidate]));
  // Goal-specific candidates replace the contextual version of the same
  // capability so their typed postcondition remains authoritative.
  for (const candidate of goalCandidates) byCapability.set(capabilityKey(candidate), candidate);
  return {
    goalCandidateKeys: new Set(goalCandidates.map(capabilityKey)),
    candidates: [...byCapability.values()]
  };
}

function bindCandidateEnvelope(candidate = {}, index, observation = {}, binding = {}) {
  return {
    ...candidate,
    visualRegion: candidate.visualRegion
      ? normalizeVisualRegion(candidate.visualRegion, {
          observationId: binding.observationId || observation.observationId || "",
          controlId: candidate.controlId || "",
          operation: candidate.operation || "",
          surfaceId: binding.surfaceId || ""
        })
      : null,
    strategyId: candidate.strategyId || candidate.candidateId || "",
    candidateId: `${binding.observationId || "observation"}:candidate_${index + 1}`,
    observationId: binding.observationId || "",
    observationHash: binding.observationHash || observationHash(observation),
    surfaceId: binding.surfaceId || "",
    surfaceType: binding.surfaceType || "page"
  };
}

function buildCurrentCandidateSet({
  goal = {},
  observation = {},
  traveler = {},
  state = {},
  approvals = {},
  attemptedCandidateIds = [],
  attemptedStrategySignatures = []
} = {}) {
  const binding = surfaceBinding(observation);
  const page = observation.page || {};
  const foregroundOwnsSelection = binding.surfaceType !== "page";
  const attempted = new Set(attemptedCandidateIds || []);
  const attemptedStrategies = new Set(attemptedStrategySignatures || []);
  const outcomeContract = outcomeContractForGoal(goal, observation);
  const parentOutcomeContract = state.taskState?.stageOutcome?.outcomeContract
    || goal.parentOutcomeContract
    || outcomeContract;
  const allCapabilities = allCurrentCapabilityCandidates(goal, observation, traveler);
  const completedSurfaceExitIds = new Set(
    goal.semanticType === "completed_choice_surface"
      ? (goal.actionableControlIds || []).filter(Boolean)
      : []
  );
  const current = allCapabilities.candidates.filter((candidate) => {
    if (!["click", "type", "select", "keypress", "scroll", "click_xy"].includes(candidate.type)) return true;
    const control = (page.controls || []).find((item) => item.controlId === candidate.controlId);
    return Boolean(control && (
      controlBelongsToCurrentSurface(control, page)
      // A completed dropdown can only be dismissed through its page-owned
      // opener. TaskState publishes that exact actuator; it is the sole safe
      // exception to foreground ownership and prevents reselecting the value.
      || completedSurfaceExitIds.has(control.controlId)
    ));
  }).map((candidate, index) => {
    const bound = bindCandidateEnvelope(candidate, index, observation, binding);
    const control = (page.controls || []).find((item) => item.controlId === bound.controlId) || {};
    const semantics = normalizedActionSemantics(bound, { control, goal, expectedOutcome: bound.expectedOutcome });
    const physicalEffect = predictPhysicalEffect({ semantics, control, candidate: bound, goal: { ...goal, outcomeContract } });
    const expectedOutcome = compileTypedExpectedOutcome({ ...bound, physicalEffect, goal: { ...goal, outcomeContract } }, page);
    const pipelineContract = pipelineContractForCandidate(goal, bound, control, expectedOutcome, observation);
    const semanticIntent = semanticIntentForAction({
      mechanicalEffect: physicalEffect,
      control,
      candidate: bound,
      goal,
      observation
    });
    const expectedPostconditions = expectedPostconditionsForAction({
      expectedOutcome,
      semanticIntent,
      mechanicalEffect: physicalEffect,
      goal
    });
    const outcomeCompatibility = assessOutcomeCompatibility({
      goal,
      durableObjective: parentOutcomeContract,
      mechanicalEffect: physicalEffect,
      semanticIntent,
      expectedPostconditions,
      candidate: bound,
      control,
      observation
    });
    const affordance = buildSemanticAffordance({
      candidate: { ...bound, physicalEffect, mechanicalEffect: physicalEffect, semanticIntent, expectedPostconditions },
      control,
      goal: { ...goal, outcomeContract },
      postcondition: expectedOutcome
    });
    const strategyAlreadyFailed = attemptedStrategies.has(actuatorSignature(bound));
    const laneInput = {
      ...bound,
      goalCandidate: allCapabilities.goalCandidateKeys.has(capabilityKey(candidate)),
      // A visible foreground surface owns the next click. TaskState remains
      // useful planning context, but it cannot hide a grounded safe control
      // merely because its predicted semantic effect is incomplete/unknown.
      goalRelevant: goal.kind === "profile_field"
        ? allCapabilities.goalCandidateKeys.has(capabilityKey(candidate))
        : foregroundOwnsSelection
          ? (
              relevantToVisibleSurface(goal, bound, allCapabilities.goalCandidateKeys.has(capabilityKey(candidate)))
              // A foreground modal/drawer owns interaction. Its exact safe
              // forward actuator remains admissible even when the earlier
              // goal snapshot did not enumerate a newly hydrated Next or
              // Continue control. Paid/uncertain siblings still go through
              // typed policy and never inherit this admission.
              || (
                bound.intent === "navigate_stage"
                && bound.risk === "safe"
                && bound.requiresApproval !== true
              )
            )
          : allCapabilities.goalCandidateKeys.has(capabilityKey(candidate)),
      risk: bound.risk || (goal.kind === "profile_field" ? "safe" : "uncertain"),
      requiresApproval: Boolean(bound.requiresApproval),
      expectedOutcome,
      pipelineContract,
      capabilityStatus: pipelineContract.capability.status,
      expectedPostconditions,
      physicalEffect,
      mechanicalEffect: physicalEffect,
      semanticIntent,
      outcomeContract,
      parentOutcomeContract,
      outcomeCompatibility: outcomeCompatibility.status,
      outcomeCompatibilityReason: outcomeCompatibility.reason,
      affordance,
      requiresJudgment: Boolean(bound.requiresJudgment || bound.risk === "uncertain")
    };
    const executionChannel = agentContract.classifyExecutionLane({
      action: laneInput,
      pipelineContract,
      control,
      observation,
      strategyAlreadyFailed
    });
    const grounded = {
      ...laneInput,
      executionChannel
    };
    const actionabilityFailure = candidateActionabilityFailure(
      grounded,
      control,
      observation,
      strategyAlreadyFailed
    );
    const policyState = state && Object.keys(state).length
      ? {
          taskState: state.taskState || null,
          approvals: state.approvals || {},
          priceHistory: Array.isArray(state.transactionInvariants?.evidence)
            ? state.transactionInvariants.evidence
              .map((entry) => ({
                amount: entry.facts?.totalPrice?.amount,
                currency: entry.facts?.totalPrice?.currency || entry.facts?.currency || "",
                capturedAt: entry.observedAt || ""
              }))
              .filter((entry) => entry.amount !== null && Number.isFinite(Number(entry.amount)))
            : []
        }
      : null;
    const policyDecision = evaluateActionPolicy(
      candidatePolicyAction(goal, grounded, control, observation),
      policyState,
      traveler,
      { ...(state.approvals || {}), ...approvals }
    );
    return {
      ...grounded,
      policyDecision,
      affordance: Object.freeze({
        ...affordance,
        policy: Object.freeze({
          allow: policyDecision.allow === true,
          decision: String(policyDecision.decision || "deny"),
          reason: String(policyDecision.reason || "")
        })
      }),
      exclusionReason: controlUnavailable(control, grounded)
        ? "CONTROL_UNAVAILABLE"
        : actionabilityFailure
          ? actionabilityFailure
        : policyDecision.allow !== true
          ? `POLICY_${String(policyDecision.decision || "deny").toUpperCase()}`
          : ""
    };
  });
  const excludedCandidates = current.filter((candidate) => candidate.goalRelevant && (
    Boolean(candidate.exclusionReason)
      || attempted.has(candidate.candidateId)
      || attempted.has(candidate.strategyId)
      || attemptedStrategies.has(actuatorSignature(candidate))
  ));
  const policySelectable = (candidate) => {
    if (!candidate.goalRelevant) return false;
    const nonMutating = ["ask_user", "wait"].includes(candidate.type);
    if (!nonMutating && candidate.policyDecision?.allow !== true) return false;
    if (!nonMutating && candidate.requiresApproval && !candidate.affordance?.authorization?.authorizationId) return false;
    return !attempted.has(candidate.candidateId)
      && !attempted.has(candidate.strategyId)
      && !attemptedStrategies.has(actuatorSignature(candidate));
  };
  const selectablePool = current.filter((candidate) => (
    policySelectable(candidate)
    && !controlUnavailable(
      (page.controls || []).find((item) => item.controlId === candidate.controlId) || {},
      candidate
    )
    && !candidate.exclusionReason
    && (
      !["click", "type", "select", "keypress", "scroll", "click_xy"].includes(candidate.type)
      || candidate.executionChannel === agentContract.EXECUTION_LANE.NORMAL
    )
  ));
  const oneCurrentStrategyPerOperation = (items = []) => {
    const selected = new Set();
    return items.filter((candidate) => {
      if (!["click", "keypress"].includes(candidate.type)) return true;
      const key = [
        candidate.controlId,
        candidate.operation
      ].join("::");
      if (selected.has(key)) return false;
      selected.add(key);
      return true;
    });
  };
  // An exact goal-owned action outranks safe contextual navigation. This
  // prevents a Continue/Next control from bypassing a required correction.
  const hasGoalOwnedAction = selectablePool.some((candidate) => (
    candidate.goalCandidate === true
    && !["ask_user", "wait"].includes(candidate.type)
  ));
  const goalBoundSelectablePool = hasGoalOwnedAction
    ? selectablePool.filter((candidate) => candidate.goalCandidate === true)
    : selectablePool;
  // Handoff/wait are fallbacks, not peers of a grounded executable action.
  // Keeping both model-selectable lets ambiguity machinery choose to stop even
  // after the current surface has supplied one exact safe actuator.
  const hasGroundedAction = goalBoundSelectablePool.some((candidate) => !["ask_user", "wait"].includes(candidate.type));
  const decisiveSelectablePool = hasGroundedAction
    ? goalBoundSelectablePool.filter((candidate) => !["ask_user", "wait"].includes(candidate.type))
    : goalBoundSelectablePool;
  const selectable = oneCurrentStrategyPerOperation(decisiveSelectablePool);
  const recoveryCandidates = oneCurrentStrategyPerOperation(current.filter((candidate) => (
    policySelectable(candidate)
    && candidate.policyDecision?.allow === true
    && !controlUnavailable(
      (page.controls || []).find((item) => item.controlId === candidate.controlId) || {},
      candidate
    )
    && [
      agentContract.EXECUTION_LANE.REVEAL,
      agentContract.EXECUTION_LANE.BOUNDED_RECOVERY
    ].includes(candidate.executionChannel)
    && !candidate.requiresJudgment
  )));
  const selectableIds = new Set(selectable.map((candidate) => candidate.candidateId));
  const recoveryIds = new Set(recoveryCandidates.map((candidate) => candidate.candidateId));
  return {
    ...binding,
    // Context is complete; selection is policy-safe. The model can understand
    // blocked controls without receiving their IDs in its selectable enum.
    contextCapabilities: current.map((candidate) => ({
      ...candidate,
      capabilityId: capabilityKey(candidate),
      policyStatus: candidate.policyDecision?.allow === true
        ? (candidate.goalRelevant ? "allowed" : "context_only")
        : String(candidate.policyDecision?.decision || "denied"),
      selectable: selectableIds.has(candidate.candidateId),
      recoverySelectable: recoveryIds.has(candidate.candidateId)
    })),
    excludedCandidates,
    candidates: selectable,
    recoveryCandidates
  };
}

function actionForCurrentCandidate(goal = {}, candidate = {}, observation = {}) {
  const action = goal.kind === "profile_field"
    ? actionForProfileCandidate(goal, candidate, observation)
    : actionForObservationCandidate(goal, candidate, observation);
  return {
    ...action,
    candidateId: candidate.candidateId,
    observationId: candidate.observationId || action.observationId,
    observationHash: candidate.observationHash || action.observationHash,
    surfaceId: candidate.surfaceId || action.surfaceId || "",
    interactionRole: candidate.interactionRole || action.interactionRole || "",
    semanticEffect: candidate.semanticEffect || action.semanticEffect || "",
    expectedEvidence: candidate.expectedEvidence || action.expectedEvidence || "",
    physicalEffect: candidate.physicalEffect || candidate.affordance?.physicalEffect || action.affordance?.physicalEffect || "",
    mechanicalEffect: candidate.mechanicalEffect || candidate.physicalEffect || candidate.affordance?.mechanicalEffect || action.affordance?.mechanicalEffect || "",
    semanticIntent: candidate.semanticIntent || action.semanticIntent || action.intent || "",
    expectedPostconditions: candidate.expectedPostconditions || action.expectedPostconditions || (candidate.expectedOutcome ? [candidate.expectedOutcome] : []),
    outcomeCompatibility: candidate.outcomeCompatibility || "unknown",
    affordance: candidate.affordance || action.affordance || null,
    pipelineContract: candidate.pipelineContract || action.pipelineContract || null,
    capabilityStatus: candidate.capabilityStatus || action.capabilityStatus || "",
    executionChannel: candidate.executionChannel || action.executionChannel || "",
    interactionMethod: candidate.interactionMethod || action.interactionMethod || "",
    boundedRecovery: candidate.boundedRecovery === true || action.boundedRecovery === true,
    exactOption: candidate.exactOption
      || candidate.pipelineContract?.component?.exactOption
      || action.exactOption
      || null
  };
}

module.exports = { actionForCurrentCandidate, buildCurrentCandidateSet, candidateActionabilityFailure };
