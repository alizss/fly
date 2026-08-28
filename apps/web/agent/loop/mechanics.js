const {
  actionForCurrentCandidate,
  bindMechanics
} = require("../mechanics-binder");
const { resolveActionControl } = require("../control-alias-index");
const {
  normalizeAction,
  actuatorSignature,
  decisionInstanceKey,
  isCandidateGrounded,
  semanticGoalKey
} = require("../../../../packages/shared/agent-actions");
const { currentSurface, currentSurfaceId, surfaceBinding } = require("../surface-contract");
const { recoveryFacts } = require("../execution-episode");
const { withActionContract } = require("./action-contract");

function normalizeText(value = "") {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function targetCandidateSnapshot(candidate = {}, source = "", surface = {}) {
  if (!candidate) return null;
  return {
    id: String(candidate.id || ""),
    controlId: String(candidate.controlId || ""),
    logicalControlId: String(candidate.logicalControlId || candidate.controlId || ""),
    actuatorId: String(candidate.actuatorId || candidate.id || ""),
    stableKey: String(candidate.stableKey || ""),
    meaning: String(candidate.meaning || candidate.semantic || candidate.label || ""),
    structuredPrice: candidate.structuredPrice || null,
    visualRef: String(candidate.visualRef || ""),
    decisionGroupId: String(candidate.decisionGroupId || ""),
    policyCorrectionForDecisionGroupId: String(candidate.policyCorrectionForDecisionGroupId || ""),
    semanticOwnershipLinkId: String(candidate.semanticOwnershipLinkId || ""),
    label: String(candidate.label || ""),
    normalizedLabel: normalizeText(candidate.label || ""),
    role: String(candidate.role || ""),
    domRole: String(candidate.domRole || ""),
    accessibleName: String(candidate.accessibility?.name || candidate.accessibleName || ""),
    accessibilityState: candidate.accessibility?.state || null,
    risk: String(candidate.risk || ""),
    semantic: String(candidate.semantic || ""),
    kind: String(candidate.kind || candidate.field || candidate.type || ""),
    fieldType: String(candidate.fieldType || candidate.field || ""),
    fieldClassification: candidate.fieldClassification || null,
    controlKind: String(candidate.controlKind || candidate.kind || candidate.field || candidate.type || ""),
    state: candidate.controlState || candidate.state || null,
    currentValue: String(candidate.currentValue || candidate.controlState?.normalizedValue || candidate.state?.normalizedValue || ""),
    capabilities: Array.isArray(candidate.capabilities) ? candidate.capabilities.slice(0, 12) : [],
    selected: Boolean(candidate.selected),
    required: Boolean(candidate.required),
    hasValue: Boolean(candidate.hasValue || candidate.value),
    box: candidate.box || null,
    visualRegion: candidate.visualRegion || candidate.box || null,
    stateElementId: String(candidate.stateElementId || ""),
    ownershipIntegrity: candidate.ownershipIntegrity || null,
    operations: candidate.operations && typeof candidate.operations === "object" ? candidate.operations : {},
    visualRegions: Array.isArray(candidate.visualRegions) ? candidate.visualRegions.slice(0, 12) : [],
    source,
    surfaceId: String(surface?.id || ""),
    surfaceType: String(surface?.type || "page"),
    surfaceLabel: String(surface?.label || "").slice(0, 500),
    surfaceNormalizedLabel: normalizeText(surface?.label || "").slice(0, 500),
    sectionId: String(surface?.sectionId || surface?.id || ""),
    sectionType: String(surface?.sectionType || surface?.type || ""),
    sectionLabel: String(surface?.sectionLabel || surface?.label || "").slice(0, 300)
  };
}

function targetSnapshotForAction(action = {}, page = {}) {
  if (!["click", "click_xy", "select", "type", "keypress"].includes(action.type)) return null;
  const resolution = resolveActionControl(action, page);
  if (action.type === "click_xy" && resolution.ok) {
    const control = resolution.control;
    const region = action.visualRegion || {};
    return {
      ...targetCandidateSnapshot({
        ...control,
        id: "",
        label: control.label || action.targetLabel || control.semantic || "visual control recovery",
        box: region,
        visualRegion: region,
        controlState: control.state || null
      }, "visual_control_recovery", {
        type: control.surfaceType || "page",
        id: control.surfaceId || "",
        label: control.surfaceLabel || control.sectionLabel || ""
      }),
      operation: action.operation || "",
    };
  }
  if (resolution.ok) {
    const control = resolution.control;
    const annotation = (page.screenshotAnnotations || []).find((item) => item.controlId === control.controlId) || null;
    const capability = action.operation ? control.operations?.[action.operation] : null;
    // A leased mutation must name the exact canonical operation whose
    // strategies own its physical actuators. State/presentation aliases are
    // verification topology, never a fallback execution plan.
    if (!capability) return null;
    const operationIds = [...new Set([
      ...(capability?.actuatorIds || []),
      ...(capability?.strategies || []).map((strategy) => strategy.actuatorId)
    ].filter(Boolean))];
    const requestedMemberId = operationIds.includes(action.actuatorId) ? action.actuatorId : "";
    const exactStrategy = (capability?.strategies || []).find((strategy) => (
      strategy.actuatorId === (requestedMemberId || action.actuatorId)
      && (!action.interactionMethod || strategy.method === action.interactionMethod)
    )) || null;
    const operationTargetId = requestedMemberId || capability.actuatorId || operationIds[0];
    if (!operationTargetId) return null;
    const exactActuatorRegion = exactStrategy?.proof?.visualRegion
      || exactStrategy?.actionability?.visualRegion
      || capability?.actionabilityByActuator?.[operationTargetId]?.visualRegion
      || (capability?.exactActuators || []).find((item) => item.actuatorId === operationTargetId)?.proof?.visualRegion
      || null;
    return targetCandidateSnapshot({
      ...control,
      id: operationTargetId || control.controlId,
      logicalControlId: control.controlId,
      actuatorId: operationTargetId || control.controlId,
      visualRef: control.visualRef || annotation?.visualRef || "",
      label: control.label || control.accessibleName || control.controlId,
      kind: control.kind || "control",
      box: exactActuatorRegion || control.visualRegion || annotation?.box || null,
      visualRegion: exactActuatorRegion || control.visualRegion || annotation?.box || null,
      controlState: control.state || null
    }, "canonical_alias_index", {
      type: control.surfaceType || "page",
      id: control.surfaceId || "",
      label: control.surfaceLabel || control.sectionLabel || "",
      sectionId: control.sectionId || "",
      sectionType: control.sectionType || "",
      sectionLabel: control.sectionLabel || ""
    });
  }
  return (!resolution.aliasIds.length && action.x != null && action.y != null) ? {
    id: "",
    label: action.targetLabel || action.value || "",
    normalizedLabel: normalizeText(action.targetLabel || action.value || ""),
    box: action.visualRegion ? {
      ...action.visualRegion,
      centerX: Number(action.visualRegion.x || 0) + Number(action.visualRegion.width || 0) / 2,
      centerY: Number(action.visualRegion.y || 0) + Number(action.visualRegion.height || 0) / 2,
      inViewport: true
    } : null,
    visualRegion: action.visualRegion || null,
    source: "visual_fallback",
    surfaceId: action.visualRegion?.surfaceId || currentSurfaceId(page),
    surfaceType: currentSurface(page).type,
    surfaceLabel: currentSurface(page).label,
    surfaceNormalizedLabel: normalizeText(currentSurface(page).label)
  } : null;
}

function bindTargetSnapshot(action = {}, observation = {}) {
  if (!action) return action;
  const canonicalAction = normalizeAction(action);
  const observedTargetSnapshot = targetSnapshotForAction(canonicalAction, observation.page || {});
  const targetSnapshot = observedTargetSnapshot ? {
    ...observedTargetSnapshot,
    intendedOutcome: canonicalAction.intendedOutcome || "",
    semanticOwnershipLinkId: canonicalAction.semanticOwnershipLinkId || "",
    policyCorrectionForDecisionGroupId: canonicalAction.policyCorrectionForDecisionGroupId || ""
  } : null;
  const bound = normalizeAction({
    ...canonicalAction,
    observationId: canonicalAction.observationId || observation.observationId || "",
    observationHash: canonicalAction.observationHash || observation.observationSnapshot?.snapshotHash || "",
    controlId: targetSnapshot?.controlId || canonicalAction.controlId || "",
    // The action belongs to TaskState's semantic obligation. A correction
    // control may physically live in another group; preserve that truthful
    // physical group only inside targetSnapshot instead of allowing target
    // binding to rewrite the leased action's semantic owner.
    decisionGroupId: canonicalAction.decisionGroupId
      || targetSnapshot?.policyCorrectionForDecisionGroupId
      || targetSnapshot?.decisionGroupId
      || "",
    actuatorId: targetSnapshot?.actuatorId || targetSnapshot?.id || canonicalAction.actuatorId || "",
    logicalControlId: targetSnapshot?.logicalControlId || canonicalAction.logicalControlId || canonicalAction.controlId || "",
    targetSnapshot: targetSnapshot || null
  });
  return withActionContract({
    ...bound,
    decisionInstanceId: bound.decisionInstanceId || decisionInstanceKey(bound, observation)
  }, observation.page || {});
}

function observationSurfaceId(observation = {}) {
  return currentSurfaceId(observation.page || {});
}

function candidateStrategySignature(goal = {}, candidate = {}) {
  return actuatorSignature(candidate);
}

function semanticGoalRecoveryKey(goal = {}, observation = {}) {
  if (!goal) return "";
  return `${semanticGoalKey(goal)}::${decisionInstanceKey(goal, observation)}`;
}

function observationPageStateHash(observation = {}) {
  return String(
    observation.observationSnapshot?.snapshotHash
    || observation.page?.snapshotHash
    || ""
  );
}

function targetLocalRecoveryScope(goal = {}, observation = {}, identity = {}) {
  const page = observation.page || {};
  const controls = page.controls || [];
  const expectedControlId = String(
    identity.controlId
    || (goal?.controlId)
    || (goal?.componentBinding)?.controlId
    || ""
  );
  const expectedStableControlKey = String(
    identity.stableControlKey
    || identity.componentIdentity
    || ""
  );
  const control = controls.find((item) => expectedControlId && item.controlId === expectedControlId)
    || controls.find((item) => expectedStableControlKey && (
      item.stableKey === expectedStableControlKey
      || item.componentContract?.componentIdentity === expectedStableControlKey
    ))
    || null;
  const stableControlKey = String(
    control?.stableKey
    || control?.componentContract?.componentIdentity
    || expectedStableControlKey
    || expectedControlId
  );
  const selectedActuatorStableKey = String(
    identity.actuatorStableKey
    || identity.pipelineContract?.capability?.selectedStrategy?.actuatorStableKey
    || ""
  );
  const strategies = Object.values(control?.operations || {})
    .flatMap((capability) => capability?.strategies || []);
  const matchingStrategies = selectedActuatorStableKey
    ? strategies.filter((strategy) => strategy.actuatorStableKey === selectedActuatorStableKey)
    : strategies;
  const surface = page.currentSurface || {};
  const surfaceInstanceKey = JSON.stringify({
    surfaceId: surface.id || "surface-page",
    surfaceType: surface.type || "page",
    surfaceInstanceId: surface.instanceId || "",
    decisionGroupId: (goal?.decisionGroupId) || control?.decisionGroupId || "",
    requirementId: (goal?.requirementId) || ""
  });
  const targetLocalStateKey = JSON.stringify({
    stableControlKey,
    state: control ? {
      disabled: control.state?.disabled === true || control.disabled === true,
      expanded: control.state?.expanded === true,
      checked: control.state?.checked === true,
      selected: control.state?.selected === true || control.selected === true,
      normalizedValue: String(
        control.state?.canonicalDateValue
        || control.state?.selectedValue
        || control.state?.normalizedValue
        || control.currentCanonicalValue
        || control.currentValue
        || ""
      ),
      optionValue: String(control.state?.optionValue || "")
    } : null,
    actuator: matchingStrategies.map((strategy) => ({
      actuatorStableKey: strategy.actuatorStableKey || "",
      status: strategy.status || "",
      rendered: strategy.proof?.rendered === true,
      visible: strategy.proof?.visible === true,
      enabled: strategy.proof?.enabled === true,
      hitTested: strategy.proof?.hitTested === true,
      notOccluded: strategy.proof?.notOccluded === true
    })).sort((a, b) => a.actuatorStableKey.localeCompare(b.actuatorStableKey))
  });
  return {
    control,
    stableControlKey,
    actuatorStableKey: selectedActuatorStableKey,
    surfaceInstanceKey,
    targetLocalStateKey
  };
}

function failedStrategySignaturesForGoal(state = {}, goal = {}, observation = {}) {
  const goalKey = semanticGoalRecoveryKey(goal, observation);
  const pageStateHash = observationPageStateHash(observation);
  const scopedFailures = (recoveryFacts(state).failedStrategies || [])
    .filter((entry) => (
      entry.targetLocalStateKey
        ? (
            entry.semanticGoalKey === semanticGoalKey(goal)
            && (() => {
              const scope = targetLocalRecoveryScope(goal, observation, entry);
              return scope.surfaceInstanceKey === entry.surfaceInstanceKey
                && scope.targetLocalStateKey === entry.targetLocalStateKey;
            })()
          )
        : entry.goalKey === goalKey && entry.pageStateHash === pageStateHash
    ));
  return scopedFailures
    .map((entry) => entry.strategySignature)
    .filter(Boolean);
}

function groundedObservationCandidateSet(obligation = null, decisionFrame = null, observation = {}, attemptedStrategySignatures = [], context = {}) {
  const binding = surfaceBinding(observation);
  const built = bindMechanics({
    obligation,
    decisionFrame,
    observation,
    state: context.state || {},
    traveler: context.traveler || {},
    approvals: context.approvals || {},
    attemptedStrategySignatures
  });
  // Proven capabilities always win. When the observer already compiled an
  // exact atomic choice (for example Slovenia or Male), that single verified
  // value-setting operation is cheaper and more semantic than opening the
  // same widget merely to discover its surface. Pre-surface discovery owns
  // the turn only when neither a normal action nor an exact atomic choice is
  // available.
  const normalCandidates = (built.candidates || []).filter((candidate) => (
    candidate.mechanicalHypothesis !== true
  ));
  const atomicExactRecovery = (built.recoveryCandidates || []).filter((candidate) => (
    candidate.operation === "select"
    && candidate.interactionMethod === "browser_trusted_choice"
    && Boolean(candidate.exactOption?.canonicalValue || candidate.value)
  ));
  const scheduledCandidates = normalCandidates.length
    ? normalCandidates
    : atomicExactRecovery.length
      ? atomicExactRecovery.slice(0, 1)
      : built.candidates.length
        ? built.candidates
        : (built.recoveryCandidates || []).slice(0, 1);
  const groundedCandidates = scheduledCandidates.map((candidate) => {
    const bound = bindTargetSnapshot(actionForCurrentCandidate(obligation, candidate, observation), observation);
    return {
      ...candidate,
      type: bound.type,
      intent: bound.intent,
      operation: bound.operation,
      interactionRole: bound.interactionRole,
      semanticEffect: bound.semanticEffect,
      expectedEvidence: bound.expectedEvidence,
      controlId: bound.controlId,
      decisionGroupId: bound.decisionGroupId,
      targetId: bound.actuatorId,
      targetLabel: bound.targetLabel,
      value: bound.value,
      keys: bound.keys,
      interactionMethod: bound.interactionMethod || candidate.interactionMethod || "",
      boundedRecovery: bound.boundedRecovery === true || candidate.boundedRecovery === true,
      exactOption: bound.exactOption
        || candidate.exactOption
        || bound.pipelineContract?.component?.exactOption
        || candidate.pipelineContract?.component?.exactOption
        || null,
      requirementId: bound.requirementId,
      expectedOutcome: bound.expectedOutcome,
      expectedPostconditions: bound.expectedPostconditions,
      mechanicalEffect: bound.mechanicalEffect,
      outcomeCompatibility: candidate.outcomeCompatibility,
      affordance: bound.affordance,
      pipelineContract: bound.pipelineContract || candidate.pipelineContract || null,
      capabilityStatus: bound.capabilityStatus || candidate.capabilityStatus || "",
      executionChannel: bound.executionChannel || candidate.executionChannel || "",
      risk: bound.risk,
      requiresApproval: bound.requiresApproval
    };
  }).filter((candidate) => (
    !["click", "type", "select", "keypress", "click_xy"].includes(candidate.type)
    || Boolean(candidate.controlId && candidate.expectedOutcome && isCandidateGrounded(candidate, observation))
  ));
  return {
    ...binding,
    candidates: groundedCandidates,
    contextCapabilities: built.contextCapabilities || [],
    normalCandidates: built.candidates || [],
    recoveryCandidates: built.recoveryCandidates || [],
    excludedCandidates: built.excludedCandidates || []
  };
}

function deterministicTaskCandidate(candidateSet = {}, goal = {}) {
  const candidates = candidateSet.candidates || [];
  if (candidates.length === 1) return candidates[0];
  if (!candidates.length) return null;

  // TaskState has already admitted one exact obligation and bindMechanics has
  // consequence/policy-gated every candidate. What remains is execution
  // strategy, never semantic judgment. Prefer the most direct untried proven
  // mechanic for every obligation kind; failed-strategy memory removes it on
  // the next observation if verification fails.
  const exactControlIds = new Set([
    (goal?.controlId),
    (goal?.componentBinding)?.controlId,
    ...((goal?.admittedControlIds) || [])
  ].filter(Boolean));
  const goalKind = String((goal?.kind) || "");
  const rank = (candidate) => {
    const operation = String(candidate.operation || "");
    const exactChoice = Boolean(candidate.exactOption?.canonicalValue);
    const executable = candidate.actionability?.executable === true || candidate.visible === true;
    const exactControl = exactControlIds.has(candidate.controlId);
    const recovery = candidate.boundedRecovery === true || candidate.mechanicalHypothesis === true;
    const operationRank = exactChoice && ["choose", "select", "activate"].includes(operation)
      ? 0
      : goalKind === "profile_field"
        ? ({ select: 1, type: 2, choose: 3, open: 4, activate: 5, keyboard: 6 }[operation] ?? 20)
        : goalKind === "navigation"
          ? ({ activate: 1, open: 2, choose: 3, keyboard: 4 }[operation] ?? 20)
          : ({ choose: 1, activate: 2, select: 3, open: 4, type: 5, keyboard: 6 }[operation] ?? 20);
    return [
      candidate.requiresApproval === true ? 1 : 0,
      exactControl ? 0 : 1,
      executable ? 0 : 1,
      recovery ? 1 : 0,
      operationRank,
      String(candidate.controlId || ""),
      String(candidate.targetId || ""),
      String(candidate.candidateId || "")
    ];
  };
  const compare = (left, right) => {
    const leftRank = rank(left);
    const rightRank = rank(right);
    for (let index = 0; index < leftRank.length; index += 1) {
      if (leftRank[index] === rightRank[index]) continue;
      if (typeof leftRank[index] === "number") return leftRank[index] - rightRank[index];
      return String(leftRank[index]).localeCompare(String(rightRank[index]));
    }
    return 0;
  };
  return [...candidates].sort(compare)[0] || null;
}

module.exports = {
  bindTargetSnapshot,
  candidateStrategySignature,
  deterministicTaskCandidate,
  failedStrategySignaturesForGoal,
  groundedObservationCandidateSet,
  observationPageStateHash,
  observationSurfaceId,
  semanticGoalRecoveryKey,
  targetLocalRecoveryScope,
  targetSnapshotForAction
};
