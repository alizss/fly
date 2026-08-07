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
const { canonicalOptionMatch } = require("./logical-field");

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
  if (lane === agentContract.EXECUTION_LANE.BOUNDED_RECOVERY) {
    return candidate.mechanicalHypothesis === true ? "" : "ACTIONABILITY_UNPROVEN";
  }
  return strategyAlreadyFailed ? "FAILED_STRATEGY_REUSE" : "TARGET_NOT_ACTIONABLE";
}

function preSurfaceMechanicalHypothesis(goal = {}, candidate = {}, control = {}, executionChannel = "", observation = {}) {
  if (
    goal.kind !== "profile_field"
    || executionChannel !== agentContract.EXECUTION_LANE.BOUNDED_RECOVERY
    || candidate.boundedRecovery !== true
    || candidateOperation(candidate) !== "open"
    || !["click", "keypress"].includes(candidate.type)
    || !candidate.targetId
    || candidate.expectedOutcome?.type !== "options_surface_appeared"
  ) return null;
  const selectedStrategy = candidate.pipelineContract?.capability?.selectedStrategy || {};
  const proof = selectedStrategy.proof || selectedStrategy.actionability || {};
  if (
    proof.rendered !== true
    || proof.visible !== true
    || proof.enabled !== true
    || proof.inViewport !== true
    || proof.inCurrentSurface !== true
    || proof.hitTested !== true
    || proof.notOccluded !== true
    || proof.targetable !== true
  ) return null;
  const meaning = [
    candidate.semanticIntent,
    candidate.mechanicalEffect,
    candidate.physicalEffect,
    candidate.targetLabel,
    control.semantic,
    control.risk
  ].filter(Boolean).join(" ").toLowerCase();
  if (/payment|purchase|book[_ ]?now|confirm[_ ]?booking|paid|price|legal|terms|consent|subscribe/.test(meaning)) {
    return null;
  }
  const surfaceId = candidate.surfaceId || control.surfaceId || observation.page?.currentSurface?.id || "surface-page";
  return Object.freeze({
    contractVersion: "pre-surface-discovery/v1",
    objective: `Reveal the exact owned choice surface for ${goal.semanticType || goal.label || "the current field"}.`,
    logicalControlId: control.controlId || candidate.controlId || "",
    actuatorId: candidate.targetId,
    sourceSurfaceId: surfaceId,
    allowedOperations: Object.freeze(["open"]),
    forbiddenRisks: Object.freeze(["money", "payment", "legal", "uncertain"]),
    forbiddenEffects: Object.freeze([
      "advance_checkout_stage",
      "navigate_stage",
      "select_paid_option",
      "submit_payment",
      "purchase",
      "accept_legal"
    ]),
    remainingSteps: 1,
    deadlineAt: Date.now() + 20_000
  });
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
  const fallbackComponent = {
    logicalFieldId: goal.logicalFieldId || "",
    componentIdentity: `${goal.logicalFieldId || control.stableKey || control.controlId}:${goal.componentRole || "value"}`,
    componentRole: goal.componentRole || "value",
    controlId: control.controlId || candidate.controlId || "",
    controlRole: control.role || control.kind || "",
    currentCanonicalValue: observed.currentCanonicalValue || "",
    desiredCanonicalValue: goal.desiredValue || goal.canonicalValue || "",
    observedOptions: observed.observedOptions || []
  };
  const component = goal.kind === "adaptive_surface"
    ? {
        ...(goal.componentBinding || {}),
        ...fallbackComponent,
        componentIdentity: `${goal.logicalFieldId || "adaptive"}:surface:${control.stableKey || control.controlId}`,
        parentControlId: goal.controlId || goal.componentBinding?.controlId || ""
      }
    : existing?.component || goal.componentBinding || fallbackComponent;
  return agentContract.canonicalPipelineContract({
    requirement: existing?.requirement || goal.requirementContract || {
      requirementId: goal.requirementId || goal.goalId || goal.decisionGroupId || "",
      subjectId: goal.subjectId || "",
      semanticType: goal.semanticType || goal.sectionType || "",
      desiredCanonicalValue: goal.canonicalValue || goal.desiredValue || ""
    },
    component,
    capability,
    expectedOutcome,
    validationOwnership: existing?.validationOwnership || goal.validationOwnership || observed.validationOwnership || {},
    surfaceOwnership: surfaceOwnershipForCandidate(goal, candidate, control, observation)
      || existing?.surfaceOwnership
      || null
  });
}

function candidatePolicyAction(goal = {}, candidate = {}, control = {}, observation = {}) {
  const exactProfileOption = goal.kind === "profile_field"
    && candidate.exactOption?.canonicalValue
    && normalizedMeaning(candidate.exactOption.canonicalValue) === normalizedMeaning(goal.desiredValue || goal.canonicalValue || "");
  return {
    ...actionForCurrentCandidate(goal, candidate, observation),
    targetSnapshot: {
      id: candidate.targetId || "",
      controlId: candidate.controlId || "",
      decisionGroupId: candidate.decisionGroupId || control.decisionGroupId || "",
      semantic: exactProfileOption ? (goal.semanticType || "profile_field") : (control.semantic || candidate.semantic || ""),
      risk: exactProfileOption ? "safe" : (control.risk || candidate.risk || "uncertain"),
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
  if (goal.selectionMode === "ai_ambiguity" || goal.semanticType === "surface_ambiguity") return false;
  if (new Set(goal.actionableControlIds || []).has(candidate.controlId)) return true;
  if (isGoalCandidate) return true;
  if (goal.kind === "profile_field" || goal.decisionGroupId) return false;
  if (goal.semanticType === "navigation") {
    const ids = new Set(goal.actionableControlIds || []);
    return ids.has(candidate.controlId);
  }
  return false;
}

function normalizedMeaning(value = "") {
  return String(value || "").toLowerCase().replace(/[^a-z0-9+]+/g, " ").trim();
}

function numericMeaningTokens(value = "") {
  return (String(value || "").match(/\+?\d[\d\s().-]*/g) || [])
    .map((token) => token.replace(/\D/g, ""))
    .filter(Boolean);
}

function boundedSemanticMatch(label = "", term = "") {
  if (!label || !term) return false;
  return label === term || ` ${label} `.includes(` ${term} `);
}

function adaptiveCandidateAllowed(goal = {}, candidate = {}, control = {}) {
  if (!["adaptive_surface", "adaptive_interaction"].includes(goal.kind)) return true;
  const envelope = goal.adaptiveEnvelope || {};
  const operation = candidateOperation(candidate);
  if (!(envelope.allowedOperations || []).includes(operation)) return false;
  const risk = normalizedMeaning(candidate.risk || control.risk || "uncertain");
  if ((envelope.forbiddenRisks || []).some((item) => risk === normalizedMeaning(item))) return false;
  if (Number(candidate.structuredPrice?.amount ?? control.structuredPrice?.amount) > 0) return false;
  const effect = normalizedMeaning([
    candidate.physicalEffect,
    candidate.mechanicalEffect,
    candidate.semantic,
    candidate.intent,
    control.physicalEffect,
    control.semantic
  ].filter(Boolean).join(" "));
  if ((envelope.forbiddenEffects || []).some((item) => effect.includes(normalizedMeaning(item)))) return false;
  if (goal.kind === "adaptive_surface"
    && (candidate.intent === "navigate_stage" || candidate.interactionRole === "navigation")) return false;
  return !/payment|purchase|card|accept legal|legal consent|paid option|add paid/.test(effect);
}

function adaptiveCandidateScore(goal = {}, candidate = {}, control = {}) {
  if (goal.kind !== "adaptive_surface") return 0;
  const rawDesired = String(goal.desiredValue ?? goal.canonicalValue ?? "").trim();
  const desired = normalizedMeaning(rawDesired);
  const desiredTerms = [...new Set([
    desired,
    ...(goal.choiceTerms || []).map(normalizedMeaning),
    ...(goal.sourceGoal?.choiceTerms || []).map(normalizedMeaning)
  ].filter(Boolean))];
  const descriptor = normalizedMeaning([
    candidate.targetLabel,
    candidate.meaning,
    control.label,
    control.ownText,
    control.state?.optionValue,
    control.currentValue
  ].filter(Boolean).join(" "));
  // The value to type is supplied by the goal, not observed option evidence.
  // Do not mistake a search box carrying that action value for the exact
  // option itself.
  if (candidateOperation(candidate) === "type" && /search|filter|query|find/.test(descriptor)) return 70;
  if (["choose", "select", "activate"].includes(candidateOperation(candidate))
    && canonicalOptionMatch(
      goal.semanticType || goal.sourceGoal?.semanticType || "",
      goal.componentRole || goal.sourceGoal?.componentRole || "value",
      rawDesired,
      {
        value: control.state?.optionValue || candidate.value || "",
        label: candidate.targetLabel || control.label || control.accessibleName || ""
      }
    )) return 110;
  const label = normalizedMeaning([descriptor, candidate.value].filter(Boolean).join(" "));
  if (["choose", "select", "activate"].includes(candidateOperation(candidate))
    && desiredTerms.some((term) => boundedSemanticMatch(label, term))) return 100;
  const desiredDigitTokens = desiredTerms.flatMap(numericMeaningTokens);
  const labelDigitTokens = new Set(numericMeaningTokens(label));
  if (desiredDigitTokens.some((token) => labelDigitTokens.has(token))) return 90;
  if (candidate.operation === "keyboard") return 30;
  return 10;
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
    ) && adaptiveCandidateAllowed(goal, candidate, control));
  }).map((candidate, index) => {
    const bound = bindCandidateEnvelope(candidate, index, observation, binding);
    const control = (page.controls || []).find((item) => item.controlId === bound.controlId) || {};
    const semantics = normalizedActionSemantics(bound, { control, goal, expectedOutcome: bound.expectedOutcome });
    const adaptiveScore = adaptiveCandidateScore(goal, bound, control);
    const adaptiveExactMatch = goal.kind === "adaptive_surface" && adaptiveScore >= 90;
    const exactProfileOption = goal.kind === "profile_field"
      && bound.exactOption?.canonicalValue
      && normalizedMeaning(bound.exactOption.canonicalValue) === normalizedMeaning(goal.desiredValue || goal.canonicalValue || "");
    const adaptiveDeterministicFilter = goal.kind === "adaptive_surface"
      && candidateOperation(bound) === "type"
      && adaptiveScore === 70;
    const observedAdaptiveEffect = normalizedMeaning(bound.physicalEffect || control.physicalEffect || "unknown");
    const physicalEffect = adaptiveExactMatch || exactProfileOption
      ? "set_field_value"
      : adaptiveDeterministicFilter
        ? "filter_options"
        : goal.kind === "adaptive_surface" && (!observedAdaptiveEffect || observedAdaptiveEffect === "unknown")
          ? "unknown"
          : predictPhysicalEffect({ semantics, control, candidate: bound, goal: { ...goal, outcomeContract } });
    const goalComponentOutcome = goal.expectedOutcome || goal.postcondition || {};
    const boundedInteractionOutcome = goal.kind === "adaptive_interaction" ? {
      type: "observable_change",
      controlId: bound.controlId || control.controlId || "",
      surfaceId: binding.surfaceId || "",
      mustNotIncreasePrice: true
    } : null;
    const exactComponentExpectedOutcome = adaptiveExactMatch || exactProfileOption ? {
      ...goalComponentOutcome,
      type: "logical_component_committed",
      logicalFieldId: goal.logicalFieldId || "",
      semanticType: goal.semanticType || "",
      componentRole: goal.componentRole || "value",
      controlId: goal.controlId || goal.componentBinding?.controlId || "",
      stateControlIds: goalComponentOutcome.stateControlIds
        || goal.componentBinding?.representationControlIds
        || goal.componentBinding?.stateControlIds
        || [],
      expectedCanonicalValue: goal.desiredValue ?? goal.canonicalValue ?? "",
      expectedNormalizedValue: goal.desiredValue ?? goal.canonicalValue ?? "",
      surfaceId: binding.surfaceId || "",
      requireSurfaceDismissed: true,
      mustNotIncreasePrice: true
    } : (bound.expectedOutcome || boundedInteractionOutcome);
    const compiledExpectedOutcome = compileTypedExpectedOutcome({
      ...bound,
      expectedOutcome: exactComponentExpectedOutcome,
      physicalEffect,
      goal: { ...goal, outcomeContract }
    }, page);
    const expectedOutcome = adaptiveExactMatch || exactProfileOption ? {
      ...compiledExpectedOutcome,
      controlId: goal.controlId || goal.componentBinding?.controlId || compiledExpectedOutcome?.controlId || "",
      logicalFieldId: goal.logicalFieldId || compiledExpectedOutcome?.logicalFieldId || "",
      semanticType: goal.semanticType || compiledExpectedOutcome?.semanticType || "",
      componentRole: goal.componentRole || compiledExpectedOutcome?.componentRole || "value",
      expectedCanonicalValue: goal.desiredValue ?? goal.canonicalValue ?? "",
      expectedNormalizedValue: goal.desiredValue ?? goal.canonicalValue ?? ""
    } : compiledExpectedOutcome;
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
      // Selectable actions must belong to the authoritative obligation.
      // Other foreground controls remain model context only. Adaptive child
      // surfaces admit only an exact compatible option or its owned filter.
      goalRelevant: goal.kind === "adaptive_surface"
        ? adaptiveScore >= 70
        : goal.kind === "profile_field"
          ? allCapabilities.goalCandidateKeys.has(capabilityKey(candidate))
          : relevantToVisibleSurface(
              goal,
              bound,
              allCapabilities.goalCandidateKeys.has(capabilityKey(candidate))
            ),
      requiresApproval: exactProfileOption ? false : Boolean(bound.requiresApproval),
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
      // Exact profile agreement is deterministic even when its actuator still
      // needs viewport recovery. Visibility is a mechanical condition, not a
      // reason to ask AI to reinterpret an already-known value.
      risk: adaptiveExactMatch || adaptiveDeterministicFilter || exactProfileOption || goal.kind === "adaptive_interaction"
        ? "safe"
        : (bound.risk || (goal.kind === "profile_field" ? "safe" : "uncertain")),
      requiresJudgment: adaptiveExactMatch || adaptiveDeterministicFilter || exactProfileOption
        ? false
        : Boolean(bound.requiresJudgment || bound.risk === "uncertain")
    };
    const executionChannel = agentContract.classifyExecutionLane({
      action: laneInput,
      pipelineContract,
      control,
      observation,
      strategyAlreadyFailed
    });
    const discoveryEnvelope = preSurfaceMechanicalHypothesis(
      goal,
      laneInput,
      control,
      executionChannel,
      observation
    );
    const grounded = {
      ...laneInput,
      executionChannel,
      candidateClass: discoveryEnvelope ? "mechanical_hypothesis" : "proven_action",
      mechanicalHypothesis: Boolean(discoveryEnvelope),
      discoveryEnvelope,
      logicalControlId: control.controlId || bound.controlId || "",
      actuatorId: bound.targetId || "",
      ...(discoveryEnvelope ? {
        interactionRole: "opener",
        mechanicalEffect: "open_surface",
        physicalEffect: "open_surface",
        semanticIntent: "discover_control_surface",
        requiresJudgment: false
      } : {})
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
  const adaptiveExactCandidates = goal.kind === "adaptive_surface"
    ? current.filter((candidate) => {
      const control = (page.controls || []).find((item) => item.controlId === candidate.controlId) || {};
      return policySelectable(candidate)
        && candidate.policyDecision?.allow === true
        && !controlUnavailable(control, candidate)
        && adaptiveCandidateScore(goal, candidate, control) >= 90;
    })
    : [];
  const adaptiveVisibleExactCandidates = adaptiveExactCandidates.filter((candidate) => (
    candidate.executionChannel === agentContract.EXECUTION_LANE.NORMAL
  ));
  const adaptiveFilterCandidates = goal.kind === "adaptive_surface"
    ? current.filter((candidate) => {
      const control = (page.controls || []).find((item) => item.controlId === candidate.controlId) || {};
      return policySelectable(candidate)
        && candidate.policyDecision?.allow === true
        && candidate.executionChannel === agentContract.EXECUTION_LANE.NORMAL
        && candidateOperation(candidate) === "type"
        && adaptiveCandidateScore(goal, candidate, control) === 70;
    })
    : [];
  // Cheapest deterministic mechanics win: click an exact visible option;
  // otherwise filter the owned visible collection; only then reveal/scroll
  // toward an exact off-screen option.
  const adaptivePreferredCandidates = adaptiveVisibleExactCandidates.length
    ? adaptiveVisibleExactCandidates
    : adaptiveFilterCandidates.length
      ? adaptiveFilterCandidates
      : adaptiveExactCandidates;
  const adaptivePreferredCandidateIds = new Set(adaptivePreferredCandidates.map((candidate) => candidate.candidateId));
  const policySelectablePool = current.filter((candidate) => (
    policySelectable(candidate)
    // Semantic exactness is authoritative across execution lanes. Once the
    // desired value exists on the owned surface, unrelated visible options
    // cannot force model arbitration ahead of its reveal/execute lifecycle.
    && (!adaptivePreferredCandidateIds.size || adaptivePreferredCandidateIds.has(candidate.candidateId))
    && !controlUnavailable(
      (page.controls || []).find((item) => item.controlId === candidate.controlId) || {},
      candidate
    )
    && !candidate.exclusionReason
    && (
      !["click", "type", "select", "keypress", "scroll", "click_xy"].includes(candidate.type)
      || candidate.executionChannel === agentContract.EXECUTION_LANE.NORMAL
      || candidate.mechanicalHypothesis === true
    )
  ));
  const provenSelectablePool = policySelectablePool.filter((candidate) => (
    candidate.executionChannel === agentContract.EXECUTION_LANE.NORMAL
  ));
  // A hypothesis is a last mechanical mile, never a competitor to a proven
  // exact action. Admit it only when this goal has no normal capability.
  const selectablePool = provenSelectablePool.length ? provenSelectablePool : policySelectablePool;
  const oneCurrentStrategyPerOperation = (items = []) => {
    const strategyRank = (candidate) => {
      if (candidate.intent !== "navigate_stage" || candidateOperation(candidate) !== "activate") return 0;
      if (candidate.interactionMethod === "browser_trusted_input") return 3;
      if (candidate.interactionMethod === "native_click") return 2;
      if (candidate.interactionMethod === "pointer_sequence") return 1;
      return 0;
    };
    const preferredByOperation = new Map();
    for (const candidate of items) {
      if (!["click", "keypress"].includes(candidate.type)) continue;
      const key = [candidate.controlId, candidate.operation].join("::");
      const current = preferredByOperation.get(key);
      if (!current || strategyRank(candidate) > strategyRank(current)) {
        preferredByOperation.set(key, candidate);
      }
    }
    // Choose the strongest actuator only within the same semantic control and
    // operation. Never reorder distinct actions such as modal Close and the
    // checkout-stage Continue that happens to share its label.
    return items.filter((candidate) => {
      if (!["click", "keypress"].includes(candidate.type)) return true;
      const key = [candidate.controlId, candidate.operation].join("::");
      return preferredByOperation.get(key) === candidate;
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
  const selectable = oneCurrentStrategyPerOperation(decisiveSelectablePool)
    .sort((left, right) => {
      const leftControl = (page.controls || []).find((item) => item.controlId === left.controlId) || {};
      const rightControl = (page.controls || []).find((item) => item.controlId === right.controlId) || {};
      return adaptiveCandidateScore(goal, right, rightControl) - adaptiveCandidateScore(goal, left, leftControl);
    });
  const recoverySource = adaptivePreferredCandidates.length
    ? adaptivePreferredCandidates
    : current;
  const recoveryCandidates = oneCurrentStrategyPerOperation(recoverySource.filter((candidate) => (
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
    && candidate.mechanicalHypothesis !== true
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
    candidateClass: candidate.candidateClass || action.candidateClass || "proven_action",
    mechanicalHypothesis: candidate.mechanicalHypothesis === true || action.mechanicalHypothesis === true,
    discoveryEnvelope: candidate.discoveryEnvelope || action.discoveryEnvelope || null,
    logicalControlId: candidate.logicalControlId || candidate.controlId || action.logicalControlId || action.controlId || "",
    actuatorId: candidate.actuatorId || candidate.targetId || action.actuatorId || action.targetId || "",
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
