// The actual observe -> verify -> plan -> policy -> act loop. "act" itself
// happens client-side in the extension (it owns the real DOM); this module's
// job ends at "here is the one policy-approved action to execute," same
// contract /api/agent/next-action already had — the internals are what changed.
//
// Loop-shape note: the spec's abstract "observe -> verify -> plan -> act ->
// verify -> repeat" maps onto this stateless-per-request architecture as:
// verify-after-act happens at the START of the NEXT request (using
// lastActionResult + a fresh requirement extraction), not as a second call
// within the same request. Each HTTP call is one full lap: verify what the
// previous action did, then plan+policy-check the next one.
//
// Zero model calls when task/policy filtering leaves one obvious safe action.
// Ambiguous turns use at most one closed ambiguity-resolution call.
// Earlier multi-call versions measured 15-30+ seconds per turn in practice,
// which is a real cost for a product whose whole point is being fast.

const agentContract = require("../../extension/src/shared/agent-contract");

const {
  resolveAmbiguity,
  unknownComponentsForObligation
} = require("./ambiguity-resolver");
const {
  actionForCurrentCandidate,
  bindMechanics
} = require("./current-candidate-builder");
const { governAction, RECOVERABLE_GROUNDING_CODES } = require("./action-governor");
const { buildControlAliasIndex, resolveActionControl } = require("./control-alias-index");
const { enqueueTrace } = require("./trace-store");
const {
  advanceActionLifecycle,
  canonicalFailureCode,
  normalizeLeasedAction,
  leasedActionNeedsResult,
  leasedActionRecord,
  recoverBeforeDispatch,
  updateExecutionRecovery,
  wasDispatched
} = require("./action-lifecycle");
const {
  normalizeAction,
  createActionLease,
  actuatorSignature,
  decisionInstanceKey,
  isCandidateGrounded,
  semanticGoalKey
} = require("../../../packages/shared/agent-actions");
const { withUpdate, normalizeStep } = require("../../../packages/shared/agent-state");
const { currentSurface, currentSurfaceId, surfaceBinding } = require("./surface-contract");
const {
  compileTypedExpectedOutcome,
  expectedPostconditionsForAction,
  predictPhysicalEffect,
  semanticIntentForAction,
  normalizedActionSemantics
} = require("./action-semantics");
const {
  reduceDecisionFrame,
  taskStateReadModel,
  verifiedCommerceObligationFromActionResult
} = require("./task-state-reducer");
const { prepareTransactionInvariants } = require("./invariants");
const { READINESS, classifyObservationReadiness } = require("./observation-readiness");
const {
  applySessionProfileOverrides,
  consumePendingProfileResponse,
  profileFieldLabel
} = require("./profile-context");
const { canonicalizeUserPolicy, seatPolicyFrom } = require("./policy-profile");
const {
  compileDecisionFrame,
  createObservationFrame,
  currentObligation
} = require("./authority-frames");
const { obligationField, semanticOwner } = require("./current-obligation");
const {
  executionEpisodeFor,
  leasedActionFor,
  recoveryFacts,
  updatedExecutionEpisode
} = require("./execution-episode");

function taskMechanics(taskState = {}) {
  return currentObligation(taskState) || {};
}

function bufferedDiagnosticStore(store = null) {
  if (!store?.recordActionEvents || !store?.saveSession) return store;
  const events = [];
  return new Proxy(store, {
    get(target, property) {
      if (property === "recordActionEvent") {
        return (_transactionId, event = {}) => {
          events.push(event);
          return null;
        };
      }
      if (property === "saveSession") {
        return (state) => {
          const saved = target.saveSession(state);
          if (events.length) target.recordActionEvents(state.id, events.splice(0));
          return saved;
        };
      }
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

function finalHandoffAction(reason, observation = {}, overrides = {}) {
  return normalizeAction({
    ...overrides,
    observationId: overrides.observationId || observation.observationId || "",
    observationHash: overrides.observationHash || observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
    type: "ask_user",
    intent: "ask_user",
    reason: String(reason || overrides.reason || "User input is required before another action."),
    risk: overrides.risk || "uncertain",
    requiresApproval: true
  });
}

function policyBlockedAction(governance, action) {
  if (governance.allow) return action;
  const reason = governance.reason || action.reason || "The action governor blocked the planned action.";
  if (governance.decision === "requires_user") {
    return finalHandoffAction(reason, {}, {
      id: `${action.id || `act_${Date.now().toString(36)}`}:blocked`,
      observationId: action.observationId || "",
      observationHash: action.observationHash || ""
    });
  }
  return normalizeAction({
    id: `${action.id || `act_${Date.now().toString(36)}`}:blocked`,
    observationId: action.observationId || "",
    observationHash: action.observationHash || "",
    type: "stop",
    intent: "governed_execution_blocked",
    mechanicalEffect: "unknown",
    expectedPostconditions: [],
    reason,
    risk: "safe",
    requiresApproval: false
  });
}

function recoveryScrollAmount(action = {}, observation = {}) {
  const region = action.targetSnapshot?.visualRegion || action.targetSnapshot?.box || {};
  const viewportHeight = Number(observation.page?.viewport?.height || 0) || 800;
  const top = Number(region.y);
  const height = Number(region.height || 0);
  const center = Number.isFinite(top) ? top + height / 2 : viewportHeight;
  let amount = Math.round(center - viewportHeight / 2);
  if (!Number.isFinite(amount) || Math.abs(amount) < 120) amount = center < 0 ? -420 : 420;
  return Math.max(-700, Math.min(700, amount));
}

function viewportRecoveryAction(blockedAction = {}, observation = {}, recoveryCount = 1) {
  return normalizeAction({
    id: `act_recover_view_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    observationId: observation.observationId || "",
    observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
    type: "scroll",
    intent: "recover_target_viewport",
    controlId: blockedAction.controlId || blockedAction.targetSnapshot?.controlId || "",
    actuatorId: blockedAction.actuatorId || blockedAction.targetSnapshot?.id || "",
    targetLabel: blockedAction.targetLabel || blockedAction.targetSnapshot?.label || "",
    scrollY: recoveryScrollAmount(blockedAction, observation),
    expectedOutcome: {
      type: "target_in_view",
      controlId: blockedAction.controlId || blockedAction.targetSnapshot?.controlId || "",
      recoveryOfActionId: blockedAction.id || "",
      attempt: recoveryCount,
      scrollStrategy: recoveryCount >= 3 ? "nearest_container" : "target_center"
    },
    risk: "safe",
    requiresApproval: false,
    reason: `Governed viewport recovery for ${blockedAction.targetLabel || blockedAction.controlId || "the pending canonical control"}.`
  });
}

function viewportProgressSample(action = {}, observation = {}) {
  const target = action.targetSnapshot || null;
  const region = target?.visualRegion || target?.box || null;
  const viewportHeight = Number(observation.page?.viewport?.height || 0);
  const top = Number(region?.y);
  const height = Number(region?.height || 0);
  const center = Number.isFinite(top) ? top + height / 2 : null;
  const distanceToViewport = center == null || !viewportHeight
    ? null
    : center < 0
      ? Math.abs(center)
      : center > viewportHeight
        ? center - viewportHeight
        : 0;
  return {
    observationId: observation.observationId || "",
    exists: Boolean(target?.id && target?.controlId),
    inViewport: region?.inViewport === true,
    distanceToViewport: Number.isFinite(distanceToViewport) ? Math.round(distanceToViewport) : null,
    at: new Date().toISOString()
  };
}

function viewportProgress(previous = null, sample = {}) {
  const previousDistance = typeof previous?.distanceToViewport === "number" ? previous.distanceToViewport : null;
  const currentDistance = typeof sample?.distanceToViewport === "number" ? sample.distanceToViewport : null;
  const measurableProgress = Boolean(
    sample.inViewport
    || (sample.exists && previous && !previous.exists)
    || (previous
      && previousDistance != null
      && currentDistance != null
      && currentDistance <= previousDistance - 8)
  );
  return {
    ...sample,
    measurableProgress
  };
}

function pendingRevealAction(blockedAction = {}, recoveryAttempts = 1, candidate = null, goal = {}) {
  return leasedActionRecord({
    action: normalizeAction({
      ...blockedAction,
      targetSnapshot: null,
      expectedOutcome: null
    }),
    candidate,
    goal,
    status: "needs_reveal",
    recoveryAttempts
  });
}

function rebindPendingRecoveryAction(pending = {}, observation = {}, state = {}, traveler = {}) {
  const original = pending.originalAction || {};
  const authoritativeGoal = taskMechanics(state.taskState || {});
  const direct = bindTargetSnapshot(normalizeAction({
    ...original,
    id: `act_rebind_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    observationId: observation.observationId || "",
    observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
    actuatorId: original.controlId || original.actuatorId || "",
    targetSnapshot: null,
    expectedOutcome: null,
    reason: `Rebound pending governed action after viewport recovery: ${original.reason || original.intent || original.type || "action"}.`
  }), observation);
  if (!obligationField(authoritativeGoal, "goalId")) {
    return { action: direct, candidateSet: null, candidate: pending.candidateIdentity || null };
  }

  const reboundSet = bindMechanics({
    obligation: currentObligation(state.taskState || {}),
    observation,
    traveler,
    state,
    approvals: state.approvals,
    attemptedCandidateIds: [],
    attemptedStrategySignatures: []
  });
  const previous = pending.candidateIdentity || {};
  const previousStableKey = previous.affordance?.stableKey || previous.stableKey || "";
  const exactStableCandidate = (reboundSet.candidates || []).find((candidate) => (
    previousStableKey
      && (candidate.affordance?.stableKey || candidate.stableKey || "") === previousStableKey
      && candidate.operation === previous.operation
  )) || null;
  const profileSemantic = String(
    obligationField(authoritativeGoal, "kind") === "profile_field"
      ? (obligationField(authoritativeGoal, "field") || obligationField(authoritativeGoal, "semanticType") || "")
      : obligationField(authoritativeGoal, "semanticType") || ""
  ).toLowerCase();
  const profileRecovery = obligationField(authoritativeGoal, "kind") === "profile_field"
    || /^(?:email|confirm_email|phone|phone_country_code|first_name|given_names|middle_name|last_name|second_last_name|full_name|title|gender|date_of_birth|place_of_birth|nationality|country_of_residence|document_type|passport_number|document_number|issuing_country|document_issue_date|passport_expiry|document_expiry|address_line1|address_line2|city|state|postal_code|country)$/.test(profileSemantic);
  const semanticProfileCandidate = profileRecovery
    ? (reboundSet.candidates || []).find((candidate) => (
        candidate.operation === (previous.operation || original.operation)
        && String(candidate.semanticGoal || obligationField(authoritativeGoal, "semanticGoal") || "").toLowerCase()
          === String(previous.semanticGoal || obligationField(authoritativeGoal, "semanticGoal") || "").toLowerCase()
        && String(candidate.decisionGroupId || "") === String(previous.decisionGroupId || original.decisionGroupId || "")
      )) || null
    : null;
  const reboundCandidate = exactStableCandidate || semanticProfileCandidate;
  if (!reboundCandidate) return { action: direct, candidateSet: reboundSet, candidate: null };
  const action = bindTargetSnapshot(normalizeAction({
    ...actionForCurrentCandidate(authoritativeGoal, reboundCandidate, observation),
    id: `act_rebind_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    reason: `Rebound the same semantic action to the fresh canonical control after viewport recovery: ${original.reason || original.intent || original.type || "action"}.`
  }), observation);
  return { action, candidateSet: reboundSet, candidate: reboundCandidate };
}

function pendingRecoveryTargetStatus(action = {}) {
  const target = action.targetSnapshot || null;
  const region = target?.visualRegion || target?.box || null;
  return {
    exists: Boolean(target?.id && target?.controlId),
    inViewport: region?.inViewport === true
  };
}

function actionAdvancesCheckout(action = {}) {
  const effect = action.mechanicalEffect
    || action.affordance?.mechanicalEffect
    || action.affordance?.physicalEffect
    || action.affordance?.effect
    || "";
  return ["advance_surface", "advance_checkout_stage"].includes(effect)
    || ["navigate_stage", "advance_current_surface", "continue_checkout"].includes(action.intent || "");
}

function stableDecisionValue(value) {
  if (Array.isArray(value)) return value.map(stableDecisionValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableDecisionValue(value[key])])
  );
}

function aiDecisionPolicyFingerprint(userPolicy = {}, traveler = {}) {
  const canonicalPolicy = canonicalizeUserPolicy(userPolicy, traveler);
  return JSON.stringify(stableDecisionValue({
    userPolicy: canonicalPolicy,
    travelerPreferences: {
      bookingRules: traveler.booking_rules || "",
      seatPolicy: seatPolicyFrom({ userPolicy: canonicalPolicy, traveler }),
      baggage: traveler.baggage_preference || "",
      payment: traveler.payment_preference || ""
    }
  }));
}

function observationDecisionHash(observation = {}) {
  return String(observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "");
}

function decisionConflictId(goal = {}) {
  return String(obligationField(goal, "decisionGroupId") || obligationField(goal, "requirementId") || obligationField(goal, "goalId") || "");
}

function candidateIntendedOutcome(candidate = {}, selection = {}) {
  return String(candidate.intendedOutcome || candidate.semanticIntent || selection.semanticOutcome || "unknown");
}

function candidateSelectionCacheEntry({ observation = {}, goal = {}, candidate = {}, selection = {}, policyFingerprint = "" } = {}) {
  if (!candidate.candidateId || !candidate.controlId) return null;
  return Object.freeze({
    observationId: String(observation.observationId || ""),
    observationHash: observationDecisionHash(observation),
    policyFingerprint,
    conflictId: decisionConflictId(goal),
    obligationId: String(obligationField(goal, "goalId") || ""),
    candidateId: String(candidate.candidateId),
    controlId: String(candidate.controlId),
    stableControlIdentity: String(candidate.affordance?.stableKey || candidate.stableKey || candidate.controlId),
    operation: String(candidate.operation || candidate.type || ""),
    intendedOutcome: candidateIntendedOutcome(candidate, selection),
    semanticOutcome: String(selection.semanticOutcome || "satisfy_current_decision"),
    confidence: String(selection.confidence || "unknown")
  });
}

function reusableCandidateSelection(cache = null, observation = {}, goal = {}, candidateSet = {}, policyFingerprint = "") {
  const entry = cache?.candidateSelection;
  if (!entry || entry.observationHash !== observationDecisionHash(observation)) return null;
  if (entry.policyFingerprint !== policyFingerprint) return null;
  if (entry.conflictId !== decisionConflictId(goal) || entry.obligationId !== String(obligationField(goal, "goalId") || "")) return null;
  const candidate = (candidateSet.candidates || []).find((item) => (
    String(item.affordance?.stableKey || item.stableKey || item.controlId) === entry.stableControlIdentity
    && String(item.operation || item.type || "") === entry.operation
    && candidateIntendedOutcome(item, entry) === entry.intendedOutcome
    && item.policyDecision?.allow === true
    && item.risk === "safe"
    && item.requiresApproval !== true
  ));
  if (!candidate) return null;
  return {
    candidateId: candidate.candidateId,
    candidate,
    semanticOutcome: entry.semanticOutcome,
    confidence: entry.confidence,
    meta: null,
    reused: true
  };
}

function staleActionRecoveryEntry(action = {}, candidate = {}, goal = {}, policyFingerprint = "", code = "") {
  if (!["OBSERVATION_HASH_MISMATCH", "STALE_OBSERVATION"].includes(code)) return null;
  const stableControlIdentity = String(candidate.affordance?.stableKey || candidate.stableKey || action.affordance?.stableKey || action.controlId || "");
  if (!stableControlIdentity) return null;
  return Object.freeze({
    code,
    conflictId: decisionConflictId(goal),
    obligationId: String(obligationField(goal, "goalId") || action.obligationId || ""),
    stableControlIdentity,
    operation: String(candidate.operation || action.operation || action.type || ""),
    intendedOutcome: candidateIntendedOutcome(candidate, action),
    policyFingerprint,
    attempts: 1
  });
}

function reusableStaleActionCandidate(entry = null, goal = {}, candidateSet = {}, policyFingerprint = "") {
  if (!entry || entry.attempts !== 1 || entry.policyFingerprint !== policyFingerprint) return null;
  if (entry.conflictId !== decisionConflictId(goal) || entry.obligationId !== String(obligationField(goal, "goalId") || "")) return null;
  return (candidateSet.candidates || []).find((candidate) => (
    String(candidate.affordance?.stableKey || candidate.stableKey || candidate.controlId) === entry.stableControlIdentity
    && String(candidate.operation || candidate.type || "") === entry.operation
    && candidateIntendedOutcome(candidate, entry) === entry.intendedOutcome
    && candidate.policyDecision?.allow === true
    && candidate.risk === "safe"
    && candidate.requiresApproval !== true
  )) || null;
}

function summarizeTurn({ pageState, requirements, plannedAction, finalAction, policyDecision, deterministicAction, reusedAiDecision = {}, taskState = null, taskReadModel = null }) {
  return {
    planned: {
      type: plannedAction?.type || "",
      label: plannedAction?.targetLabel || plannedAction?.value || plannedAction?.targetId || "",
      risk: plannedAction?.risk || "",
      reason: plannedAction?.reason || ""
    },
    final: {
      type: finalAction?.type || "",
      label: finalAction?.targetLabel || finalAction?.value || finalAction?.targetId || "",
      risk: finalAction?.risk || "",
      reason: finalAction?.reason || ""
    },
    policy: policyDecision ? {
      allow: policyDecision.allow,
      decision: policyDecision.decision,
      reason: policyDecision.reason
    } : null,
    deterministic: Boolean(deterministicAction),
    reusedAiDecision: {
      candidateSelection: reusedAiDecision.candidateSelection === true
    },
    // Read-only testing projection. The browser sidebar may display this, but
    // it never feeds candidate construction, policy, execution, or completion.
    processAwareness: taskReadModel?.processAwareness || null,
    transactionReview: taskReadModel?.transactionReview || null,
    missing: [],
    navigation: (pageState?.navigationActions || []).slice(0, 8).map((nav) => ({
      action: nav.action,
      label: nav.label,
      enabled: nav.enabled,
      risk: nav.risk,
      targetId: nav.targetId
    })),
    riskGates: (pageState?.riskGates || []).slice(0, 6).map((gate) => ({
      type: gate.type,
      label: gate.label,
      status: gate.status,
      risk: gate.risk
    })),
    currentSurface: pageState?.currentSurface || null
  };
}

function toClientDecision(action) {
  const actionLease = createActionLease(action);
  const decision = {
    source: "agent-loop",
    actionId: action.id || "",
    action: action.type,
    actionLease,
    candidateClass: action.candidateClass || "proven_action",
    mechanicalHypothesis: action.mechanicalHypothesis === true,
    discoveryEnvelope: action.discoveryEnvelope || null,
    targetLabel: action.targetLabel || "",
    capabilityStatus: action.capabilityStatus || "",
    executionChannel: action.executionChannel || "",
    inputRequest: action.inputRequest || null,
    readinessStartedAt: Number(action.readinessStartedAt || 0),
    readinessDeadlineAt: Number(action.readinessDeadlineAt || 0),
    readinessAttempts: Number(action.readinessAttempts || 0),
    reobserveRetryToken: action.reobserveRetryToken || "",
    message: action.reason || "Working on the next step.",
    needsApproval: action.requiresApproval,
    risk: action.risk,
    reason: action.reason
  };
  return decision;
}

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
    visibleWidgetElementId: String(candidate.visibleWidgetElementId || ""),
    preferredActivationElementId: String(candidate.preferredActivationElementId || ""),
    ownershipIntegrity: candidate.ownershipIntegrity || null,
    actuators: Array.isArray(candidate.actuators) ? candidate.actuators.slice(0, 10) : [],
    operations: candidate.operations && typeof candidate.operations === "object" ? candidate.operations : {},
    recovery: candidate.recovery && typeof candidate.recovery === "object" ? candidate.recovery : {},
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
      recoveryOperation: action.operation || "",
    };
  }
  if (resolution.ok) {
    const control = resolution.control;
    const annotation = (page.screenshotAnnotations || []).find((item) => item.controlId === control.controlId) || null;
    const capability = action.operation ? control.operations?.[action.operation] : null;
    const recovery = action.boundedRecovery === true && action.operation
      ? control.recovery?.[action.operation] || null
      : null;
    const operationIds = capability?.actuatorIds || [];
    const recoveryIds = [
      ...(recovery?.actuatorIds || []),
      ...(recovery?.strategies || []).map((strategy) => strategy.actuatorId)
    ].filter(Boolean);
    const requestedMemberId = [
      control.stateElementId,
      control.preferredActivationElementId,
      ...(control.actuators || []).map((item) => item.nodeId),
      ...operationIds,
      ...recoveryIds
    ]
      .includes(action.actuatorId) ? action.actuatorId : "";
    const exactRecoveryTargetId = recovery
      && requestedMemberId
      && recoveryIds.includes(requestedMemberId)
      && (recovery.strategies || []).some((strategy) => (
        strategy.actuatorId === requestedMemberId
        && (!action.interactionMethod || strategy.method === action.interactionMethod)
      ))
      ? requestedMemberId
      : "";
    const exactStrategy = [
      ...(capability?.strategies || []),
      ...(recovery?.strategies || [])
    ].find((strategy) => (
      strategy.actuatorId === (exactRecoveryTargetId || requestedMemberId || action.actuatorId)
      && (!action.interactionMethod || strategy.method === action.interactionMethod)
    )) || null;
    const operationTargetId = exactRecoveryTargetId || (capability
      ? (requestedMemberId && operationIds.includes(requestedMemberId) ? requestedMemberId : capability.actuatorId || operationIds[0])
      : ["type", "select"].includes(action.type)
        ? control.stateElementId
        : requestedMemberId || control.preferredActivationElementId || control.stateElementId);
    const exactActuatorRegion = exactStrategy?.proof?.visualRegion
      || exactStrategy?.actionability?.visualRegion
      || recovery?.targetabilityByActuator?.[operationTargetId]?.visualRegion
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
    decisionGroupId: targetSnapshot?.policyCorrectionForDecisionGroupId
      || targetSnapshot?.decisionGroupId
      || canonicalAction.decisionGroupId
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
    || obligationField(goal, "controlId")
    || obligationField(goal, "componentBinding")?.controlId
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
  const strategies = [
    ...Object.values(control?.operations || {}).flatMap((capability) => capability?.strategies || []),
    ...Object.values(control?.recovery || {}).flatMap((recovery) => recovery?.strategies || [])
  ];
  const matchingStrategies = selectedActuatorStableKey
    ? strategies.filter((strategy) => strategy.actuatorStableKey === selectedActuatorStableKey)
    : strategies;
  const surface = page.currentSurface || {};
  const surfaceInstanceKey = JSON.stringify({
    step: page.step || "unknown",
    surfaceId: surface.id || "surface-page",
    surfaceType: surface.type || "page",
    surfaceInstanceId: surface.instanceId || "",
    decisionGroupId: obligationField(goal, "decisionGroupId") || control?.decisionGroupId || "",
    requirementId: obligationField(goal, "requirementId") || ""
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
      optionValue: String(control.state?.optionValue || ""),
      visibleWidgetElementId: String(control.visibleWidgetElementId || "")
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
  if (obligationField(goal, "kind") !== "profile_field" || !candidates.length) return null;

  // TaskState has already admitted one exact profile obligation and the
  // candidate builder has already consequence-gated these mechanics. Asking
  // a model to choose between direct input, an opener and keyboard fallback
  // adds latency without adding semantic judgment. Prefer the most direct
  // untried proven mechanic; failed-strategy memory removes it on the next
  // observation if it does not verify.
  const rank = (candidate) => {
    const operation = String(candidate.operation || "");
    const exactChoice = Boolean(candidate.exactOption?.canonicalValue);
    if (exactChoice && ["choose", "select", "activate"].includes(operation)) return 0;
    if (operation === "select") return 1;
    if (operation === "type") return 2;
    if (operation === "choose") return 3;
    if (operation === "open") return 4;
    if (operation === "keyboard") return 5;
    return 20;
  };
  const mechanical = candidates
    .filter((candidate) => (
      candidate.requiresApproval !== true
      && !/money|paid|payment|purchase|legal|consent|login|account|itinerary/i.test([
        candidate.risk,
        candidate.physicalEffect,
        candidate.mechanicalEffect,
        candidate.semanticIntent
      ].filter(Boolean).join(" "))
    ))
    .sort((left, right) => rank(left) - rank(right));
  if (!mechanical.length || rank(mechanical[0]) >= 20) return null;
  return mechanical[0];
}

function deterministicTransitionVerification(transition = null) {
  const achieved = transition?.status === "achieved";
  const changed = Boolean(transition && ["achieved", "progressed", "blocked"].includes(transition.status));
  return {
    ok: achieved,
    changed,
    lastActionWorked: achieved,
    blockers: transition?.status === "blocked" ? [transition.blocker?.label || "A new blocker appeared."] : [],
    priceChanged: Boolean(transition?.diff?.priceChanged),
    riskChanged: transition?.status === "unsafe",
    evidence: transition ? [`Browser transition: ${transition.status}.`] : [],
    confidence: transition ? 1 : 0,
    requirementUpdates: []
  };
}

function applyTransitionStatus(
  state = {},
  observation = {},
  previousObservation = null,
  observationReadiness = null
) {
  const advanced = advanceActionLifecycle({
    state,
    observation,
    previousObservation,
    observationReadiness
  });
  const transition = advanced.transition;
  if (!advanced.lifecycle) return { ...advanced, transition: null };
  const pending = normalizeLeasedAction(leasedActionFor(state));
  const governedAction = state.lastAction?.id === advanced.lifecycle.actionId
    ? state.lastAction
    : pending?.originalAction || observation.lastActionResult?.action || {};
  const authoritativeGoal = taskMechanics(state.taskState || {});
  const signature = candidateStrategySignature(authoritativeGoal, governedAction);
  const decisionObservation = previousObservation?.observationId ? previousObservation : observation;
  const decisionInstanceId = governedAction.decisionInstanceId
    || decisionInstanceKey(governedAction, decisionObservation);
  const goalKey = semanticGoalRecoveryKey(authoritativeGoal, decisionObservation);
  const pageStateHash = observationPageStateHash(observation);
  const selectedStrategy = governedAction.pipelineContract?.capability?.selectedStrategy || {};
  const targetScope = targetLocalRecoveryScope(authoritativeGoal, observation, {
    controlId: governedAction.controlId || "",
    stableControlKey: governedAction.affordance?.stableKey
      || governedAction.pipelineContract?.component?.componentIdentity
      || "",
    componentIdentity: governedAction.pipelineContract?.component?.componentIdentity || "",
    actuatorStableKey: selectedStrategy.actuatorStableKey || "",
    pipelineContract: governedAction.pipelineContract || null
  });
  // Action lifecycle owns recovery settlement. When a useful transition has
  // already cleared the episode, do not restore failures from the input state.
  const failedStrategies = [...(recoveryFacts(advanced.state).failedStrategies || [])];
  const browserFailureCode = String(
    advanced.observation?.lastActionResult?.failureCode
    || advanced.observation?.lastActionResult?.outcome?.code
    || observation.lastActionResult?.failureCode
    || observation.lastActionResult?.outcome?.code
    || ""
  );
  const failedStrategyReuse = browserFailureCode === "FAILED_STRATEGY_REUSE";
  if (
    (transition?.status === "no_effect" || failedStrategyReuse)
    && governedAction.type !== "scroll"
    && governedAction.controlId
    && signature
  ) {
    const affordance = governedAction.affordance || {};
    const entry = {
      goalKey,
      decisionInstanceId,
      semanticGoalKey: semanticGoalKey(authoritativeGoal),
      strategySignature: signature,
      controlId: governedAction.controlId || "",
      stableControlKey: affordance.stableKey || governedAction.controlId || "",
      capability: governedAction.operation || governedAction.type || "",
      semanticEffect: affordance.effect || governedAction.semanticEffect || "",
      observationId: observation.observationId || "",
      pageStateHash,
      actuatorStableKey: targetScope.actuatorStableKey,
      surfaceInstanceKey: targetScope.surfaceInstanceKey,
      targetLocalStateKey: targetScope.targetLocalStateKey,
      failureCount: 1
    };
    const existingIndex = failedStrategies.findIndex((item) => (
      item.semanticGoalKey === entry.semanticGoalKey
      && item.strategySignature === signature
      && item.surfaceInstanceKey === entry.surfaceInstanceKey
      && item.targetLocalStateKey === entry.targetLocalStateKey
    ));
    if (existingIndex >= 0) {
      failedStrategies[existingIndex] = {
        ...failedStrategies[existingIndex],
        decisionInstanceId,
        observationId: observation.observationId || "",
        failureCount: Number(failedStrategies[existingIndex].failureCount || 1) + 1
      };
    } else {
      failedStrategies.push(entry);
    }
  }
  const scopedFailures = failedStrategies.filter((entry) => {
    if (!entry.targetLocalStateKey) {
      return entry.goalKey === goalKey && entry.pageStateHash === pageStateHash;
    }
    const scope = targetLocalRecoveryScope(authoritativeGoal, observation, entry);
    return entry.semanticGoalKey === semanticGoalKey(authoritativeGoal)
      && entry.surfaceInstanceKey === scope.surfaceInstanceKey
      && entry.targetLocalStateKey === scope.targetLocalStateKey;
  });
  const rememberedForGoal = scopedFailures
    .map((entry) => entry.strategySignature)
    .filter(Boolean);
  const attemptedStrategySignatures = [...new Set(rememberedForGoal)].slice(-12);
  return {
    ...advanced,
    state: withUpdate(advanced.state, {
      lastTransition: transition || state.lastTransition || null,
      executionEpisode: updatedExecutionEpisode(advanced.state, {
        failedStrategies: failedStrategies.slice(-80),
        failedStrategySignatures: attemptedStrategySignatures
      }),
      ...(transition?.status === "no_effect" || failedStrategyReuse ? { aiDecisionCache: null } : {})
    }),
    transition: transition || null
  };
}

function inferActionIntent(action = {}) {
  const target = action.targetSnapshot || {};
  if (action.type === "fill_known_fields" || action.type === "fill_visible_profile_fields") return "fill_profile_fields";
  if (action.type === "type" || action.type === "select") return "satisfy_field";
  if (action.type === "scroll" || action.type === "wait") return action.type;
  if (action.type === "ask_user" || action.type === "stop" || action.type === "final_review") return action.type;
  if (agentContract.canonicalSemanticEffect(target.semantic)
    === agentContract.SEMANTIC_EFFECT.SELECT_FREE_OPTION
    || target.risk === "safe_decline") return "decline_optional_extra";
  if (target.semantic === "open_choice_control") return "open_choice_control";
  if (target.semantic === "continue" || target.risk === "safe_continue") return "navigate_stage";
  if (target.surfaceType && target.surfaceType !== "page") return "resolve_active_surface";
  if (target.kind === "choice" || /radio|checkbox|option/.test(target.kind || "")) return "choose_option";
  return action.type;
}

function activeForegroundSurface(page = {}, target = {}) {
  const candidate = currentSurface(page);
  const surface = candidate.type !== "page" ? candidate : null;
  if (!surface) return null;
  if (target.surfaceId && surface.id && target.surfaceId !== surface.id) return null;
  return surface;
}

function shouldRequireSurfaceDismissal(action = {}, page = {}) {
  const target = action.targetSnapshot || {};
  if (action.intent !== "decline_optional_extra") return false;
  const choiceSurface = /dropdown|listbox|popover|menu/.test(String(target.surfaceType || "").toLowerCase());
  const choiceSelection = Boolean(
    /choice|radio|checkbox|option/.test(String(target.kind || target.role || "").toLowerCase())
    || (choiceSurface && (action.decisionGroupId || target.decisionGroupId))
  );
  if (choiceSelection) return false;
  const targetSurfaceType = target.surfaceType || "";
  const actionSurface = targetSurfaceType && targetSurfaceType !== "page";
  const foreground = activeForegroundSurface(page, target);
  return Boolean(actionSurface || foreground);
}

function foregroundDismissedOutcome(action = {}, page = {}) {
  const target = action.targetSnapshot || {};
  const surface = activeForegroundSurface(page, target) || {};
  return {
    type: "active_surface_dismissed",
    targetId: action.actuatorId || target.id || "",
    decisionGroupId: action.decisionGroupId || target.decisionGroupId || "",
    sectionId: target.sectionId || "",
    sectionType: target.sectionType || "",
    sectionLabel: target.sectionLabel || "",
    surfaceId: surface.id || target.surfaceId || "",
    surfaceType: surface.type || target.surfaceType || "",
    surfaceLabel: surface.label || target.surfaceLabel || "",
    surfaceSignature: surface.signature || "",
    intent: action.intent || "",
    mustNotIncreasePrice: true
  };
}

function expectedOutcomeForAction(action = {}, page = {}) {
  const target = action.targetSnapshot || {};
  const foreground = activeForegroundSurface(page, target);
  if (action.interactionRole) return compileTypedExpectedOutcome(action, page);
  if (shouldRequireSurfaceDismissal(action, page)) {
    return foregroundDismissedOutcome(action, page);
  }
  if (action.expectedOutcome) return action.expectedOutcome;
  if (action.type === "type" || action.type === "select") {
    return {
      type: "field_value_changed",
      targetId: action.actuatorId || target.id || "",
      controlId: action.controlId || target.controlId || "",
      decisionGroupId: action.decisionGroupId || target.decisionGroupId || "",
      expectedValue: action.value || "",
      surfaceId: target.surfaceId || "",
      intent: action.intent || "satisfy_field"
    };
  }
  if (action.type === "click" && action.intent === "satisfy_field") {
    return {
      type: "control_selected",
      targetId: action.actuatorId || target.id || "",
      controlId: action.controlId || target.controlId || "",
      decisionGroupId: action.decisionGroupId || target.decisionGroupId || "",
      surfaceId: target.surfaceId || "",
      intent: action.intent
    };
  }
  if (action.intent === "decline_optional_extra") {
    // A decline intent is not a proof type. A radio/option must prove its exact
    // selection, a Skip command must prove acknowledgement/waiver, and a Next
    // control must prove progress. Derive that contract from the observed
    // control and operation instead of forcing every decline into a choice.
    return compileTypedExpectedOutcome({ ...action, expectedOutcome: null }, page);
  }
  if (action.intent === "open_choice_control") {
    return {
      type: "options_surface_appeared",
      targetId: action.actuatorId || target.id || "",
      controlId: action.controlId || target.controlId || "",
      decisionGroupId: action.decisionGroupId || target.decisionGroupId || "",
      sectionId: target.sectionId || "",
      sectionType: target.sectionType || "",
      sectionLabel: target.sectionLabel || "",
      surfaceId: target.surfaceId || "",
      previousSurfaceId: foreground?.id || "",
      intent: action.intent,
      mustNotIncreasePrice: true
    };
  }
  if (action.intent === "navigate_stage") {
    return {
      type: "stage_exit_or_feedback",
      targetId: action.actuatorId || target.id || "",
      controlId: action.controlId || target.controlId || "",
      decisionGroupId: action.decisionGroupId || target.decisionGroupId || "",
      surfaceId: target.surfaceId || "",
      intent: action.intent,
      mustNotIncreasePrice: true
    };
  }
  if (action.requirementId) {
    return {
      type: "requirement_status",
      requirementId: action.requirementId,
      status: "satisfied",
      targetId: action.actuatorId || target.id || "",
      decisionGroupId: action.decisionGroupId || target.decisionGroupId || "",
      sectionId: target.sectionId || "",
      sectionType: target.sectionType || "",
      sectionLabel: target.sectionLabel || "",
      surfaceId: target.surfaceId || "",
      intent: action.intent || ""
    };
  }
  if (["click", "click_xy", "keypress"].includes(action.type)) {
    return {
      type: "observable_change",
      targetId: action.actuatorId || target.id || "",
      controlId: action.controlId || target.controlId || "",
      decisionGroupId: action.decisionGroupId || target.decisionGroupId || "",
      surfaceId: target.surfaceId || "",
      intent: action.intent || ""
    };
  }
  return null;
}

function withActionContract(action = {}, page = {}) {
  const intent = action.intent || inferActionIntent(action);
  const expectedOutcome = expectedOutcomeForAction({ ...action, intent }, page);
  const mechanicalEffect = action.mechanicalEffect || action.affordance?.mechanicalEffect || action.affordance?.physicalEffect || action.affordance?.effect
    || predictPhysicalEffect({
      semantics: normalizedActionSemantics(action, { control: action.targetSnapshot || {}, expectedOutcome }),
      control: action.targetSnapshot || {},
      candidate: action,
      goal: {}
    });
  const semanticIntent = action.intent || semanticIntentForAction({
    mechanicalEffect,
    control: action.targetSnapshot || {},
    candidate: action,
    goal: {},
    observation: { page }
  });
  const expectedPostconditions = action.expectedPostconditions?.length
    ? action.expectedPostconditions
    : expectedPostconditionsForAction({ expectedOutcome, semanticIntent, mechanicalEffect, goal: {} });
  return normalizeAction({
    ...action,
    intent,
    mechanicalEffect,
    semanticIntent,
    expectedPostconditions,
    expectedOutcome
  });
}

function modelUsageFromMetas(model, metas = []) {
  const calls = metas.filter(Boolean).map((meta) => ({
    schemaName: meta.schemaName || "",
    model: meta.model || model || "",
    duration_ms: Number(meta.durationMs || 0),
    attempts: Number(meta.attempts || 0),
    input_tokens: Number(meta.input_tokens || 0),
    output_tokens: Number(meta.output_tokens || 0),
    total_tokens: Number(meta.total_tokens || 0)
  }));
  return {
    model: calls.find((call) => call.model)?.model || model || "",
    input_tokens: calls.reduce((sum, call) => sum + call.input_tokens, 0),
    output_tokens: calls.reduce((sum, call) => sum + call.output_tokens, 0),
    total_tokens: calls.reduce((sum, call) => sum + call.total_tokens, 0),
    calls
  };
}

function withLatencyDebug(debug = {}, latency = {}, modelUsage = {}) {
  return {
    ...debug,
    latency,
    modelUsage
  };
}

function finishTurn({
  dataDir,
  sessionId,
  turnId,
  screenshotDataUrl = "",
  observation = null,
  state,
  action,
  debug = {},
  transactionStore = null,
  pageState = null,
  requirements = null,
  requirementLifecycle = [],
  verification = null,
  plannedAction = null,
  policyDecision = null,
  executionResult = null
}) {
  transactionStore?.saveSession?.(state);
  enqueueTrace(dataDir, sessionId || state?.id, {
    turnId,
    screenshotDataUrl,
    observation,
    pageState,
    requirements: requirements || [],
    requirementLifecycle,
    verification,
    plannedAction: plannedAction || action,
    policyDecision,
    executionResult: executionResult || {
      endingAction: action?.type || "",
      endingIntent: action?.intent || "",
      stopped: ["stop", "ask_user", "final_review"].includes(action?.type)
    },
    debug
  });
  return {
    state,
    clientDecision: toClientDecision(action),
    debug
  };
}

function safePlannerFailureResult({ dataDir, state, turnId, screenshotDataUrl, traceObservation, reason, error = null, latency = {}, modelUsage = {} }) {
  const failureAction = finalHandoffAction(reason, traceObservation || {});
  const nextState = withUpdate(state, {
    lastAction: failureAction,
    status: "awaiting_user"
  });
  const debug = {
    fallback: false,
    planned: null,
    final: {
      type: failureAction.type,
      label: "",
      risk: failureAction.risk,
      reason: failureAction.reason
    },
    policy: { allow: false, decision: "ask_user", reason },
    deterministic: false,
    missing: [],
    navigation: [],
    riskGates: [],
    error: error?.message || (error ? String(error) : "")
  };
  const debugWithLatency = withLatencyDebug(debug, latency, modelUsage);
  enqueueTrace(dataDir, state.id, {
    turnId,
    screenshotDataUrl,
    observation: traceObservation,
    pageState: null,
    requirements: [],
    verification: null,
    plannedAction: null,
    policyDecision: debug.policy,
    executionResult: { stopped: true, reason, error: debug.error },
    debug: debugWithLatency
  });
  return {
    state: nextState,
    clientDecision: toClientDecision(failureAction),
    debug: debugWithLatency
  };
}

function plannerFailureReason(error) {
  const message = String(error?.message || error || "");
  if (error?.code === "MODEL_PACKET_TOO_LARGE") {
    return "AI candidate context exceeded its local safety bound before any model call.";
  }
  if (/returned no output text|invalid JSON after retry/i.test(message)) {
    return "AI planner returned no usable candidate selection after a bounded retry.";
  }
  return "AI planner or model API unavailable while choosing between multiple current candidates.";
}

function browserDispatched(result = {}) {
  return wasDispatched(result);
}

const STALE_IDENTITY_CODES = new Set([
  "CANONICAL_ALIAS_UNRESOLVED",
  "CANONICAL_ALIAS_CONFLICT",
  "STALE_OBSERVATION",
  "OBSERVATION_HASH_MISMATCH",
  "PAGE_CHANGED_BEFORE_ACTION",
  "TARGET_OBSERVATION_DRIFT",
  "TARGET_DISAPPEARED",
  "PLANNER_CANDIDATE_NOT_CURRENT",
  ...RECOVERABLE_GROUNDING_CODES
]);

function actionResultCode(result = {}) {
  return canonicalFailureCode(result);
}

function staleIdentityRejection(result = {}) {
  return STALE_IDENTITY_CODES.has(actionResultCode(result));
}

function compactCurrentObservation(observation = {}) {
  return {
    observationId: observation.observationId || "",
    observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
    step: observation.page?.step || "",
    url: observation.page?.url || "",
    capturedAt: new Date().toISOString()
  };
}

function leasedActionSupersededByFreshPage(pending = null, observation = {}) {
  const normalized = normalizeLeasedAction(pending);
  if (!normalized?.originalAction?.id || normalized.status === "needs_reveal") return false;
  if (observation.lastActionResult?.actionId === normalized.originalAction.id) return false;
  const sourceHash = String(normalized.sourceObservationHash || normalized.originalAction.observationHash || "");
  const currentHash = String(observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "");
  return Boolean(sourceHash && currentHash && sourceHash !== currentHash);
}

function recordPreviousActionFacts(state = {}, observation = {}, traveler = {}) {
  let pendingAction = normalizeLeasedAction(leasedActionFor(state));
  let attemptedCandidateIds = [...(recoveryFacts(state).attemptedCandidateIds || [])];
  const result = observation.lastActionResult || {};

  if (pendingAction?.originalAction?.id && result.actionId === pendingAction.originalAction.id) {
    if (browserDispatched(result) && pendingAction.candidateId) {
      attemptedCandidateIds = [...new Set([
        ...attemptedCandidateIds,
        pendingAction.candidateStableKey || pendingAction.candidateId
      ])];
    }
    pendingAction = null;
  }

  // Goal derivation moved to task-state-reducer. This function now records
  // action-result facts only and cannot publish or replace a goal.
  return withUpdate(state, {
    userPolicy: state.userPolicy || state.policySnapshot || {},
    transactionInvariants: state.transactionInvariants || state.invariantBaseline || null,
    currentObservation: compactCurrentObservation(observation),
    executionEpisode: updatedExecutionEpisode(state, {
      leasedAction: pendingAction,
      attemptedCandidateIds
    }),
    activeSkillPlan: undefined,
    blockedObligation: undefined,
    policySnapshot: undefined,
    invariantBaseline: undefined
  });
}

// Snapshot narrowly verified commerce evidence before lifecycle evaluation is
// allowed to rewrite the result for parent-task planning. This function does
// not clear pending actions, publish goals, or infer profile completion; those
// responsibilities remain in recordPreviousActionFacts after transition.
function rawVerifiedCommerceReceipt(state = {}, observation = {}) {
  return verifiedCommerceObligationFromActionResult(
    observation.lastActionResult || null,
    observation.observationId || "",
    {
      taskState: state.taskState || {},
      decisionEpisode: state.taskState?.decisionEpisode || null,
      currentGoal: taskMechanics(state.taskState || {})
    }
  );
}

/**
 * @param {Object} args
 * @param {string} args.apiKey
 * @param {string} args.model
 * @param {string} args.dataDir base dir for traces (server's `work/` dir)
 * @param {import("../../../packages/shared/agent-state").CheckoutSessionState} args.state
 * @param {Object} args.observation AgentObservation from the extension
 * @param {Object} args.traveler
 * @param {Array} args.actionHistory
 * @returns {Promise<{ state: Object, clientDecision: Object }>}
 */
async function runLoopTurn({
  apiKey,
  model,
  recoveryModel = "",
  dataDir,
  state,
  observation,
  traveler,
  userMessage = "",
  userResponse = null,
  actionHistory = [],
  transactionStore = null,
  clientTurnId = ""
}) {
  transactionStore = bufferedDiagnosticStore(transactionStore);
  const turnStartedAt = Date.now();
  const screenshotDataUrl = observation?.page?.screenshotDataUrl || "";
  const traceObservation = screenshotDataUrl
    ? { ...observation, page: { ...(observation?.page || {}), screenshotDataUrl: "[written-to-screenshot-file]" } }
    : observation;
  const turnId = `${Date.now()}`;
  const latency = {
    classification_model_ms: 0,
    verify_plan_model_ms: 0,
    policy_ms: 0,
    semantic_compile_ms: 0,
    task_state_ms: 0,
    trace_queue_ms: 0,
    final_state_persist_ms: 0,
    turn_total_ms: 0
  };
  let verifyPlanMeta = null;
  const consumedProfileResponse = consumePendingProfileResponse({
    pendingInput: state.pendingUserInput || null,
    userResponse,
    userMessage
  });
  if (consumedProfileResponse) {
    state = withUpdate(state, {
      sessionProfileOverrides: {
        ...(state.sessionProfileOverrides || {}),
        [consumedProfileResponse.field]: consumedProfileResponse.value
      },
      pendingUserInput: null,
      status: "running"
    });
  }
  traveler = applySessionProfileOverrides(traveler, state.sessionProfileOverrides || {});
  // Capture evidence/mechanics once. Semantic task authority is compiled once
  // immediately before TaskState reduces the exact DecisionFrame once.
  let observationFrame = null;
  let decisionFrame = null;
  const persistedTerminalLatch = state.taskState?.terminalGoalLatch || null;
  if (persistedTerminalLatch?.locked === true
    && persistedTerminalLatch.terminalStatus === "payment_review_reached") {
    const terminalAction = normalizeAction({
      observationId: observation.observationId || "",
      observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
      type: "final_review",
      intent: "payment_review_reached",
      reason: "Payment review was already verified for this booking request. The completed checkout goal remains closed.",
      risk: "payment",
      requiresApproval: true
    });
    const terminalState = withUpdate(state, {
      executionEpisode: updatedExecutionEpisode(state, { leasedAction: null }),
      lastAction: terminalAction,
      status: "ready_for_payment",
      paymentState: { ...(state.paymentState || {}), status: "review_reached" }
    });
    transactionStore?.saveSession?.(terminalState);
    return {
      state: terminalState,
      clientDecision: toClientDecision(terminalAction),
      debug: withLatencyDebug({
        taskState: terminalState.taskState,
        finalAction: terminalAction,
        terminalGoalLatched: true,
        candidateGenerationSuppressed: true
      }, latency, modelUsageFromMetas(model, []))
    };
  }
  // Immutable local evidence must cross the boundary before lifecycle status
  // can classify the parent checkout as progressed/blocked/achieved.
  const freshVerifiedCommerceReceipt = rawVerifiedCommerceReceipt(state, observation);
  // Readiness is evaluated before transition closure. A URL change or an
  // incomplete destination shell cannot close the navigation action that
  // produced it.
  const activeExecutionEpisode = executionEpisodeFor(state);
  const observationReadiness = classifyObservationReadiness({
    observation,
    previousReadiness: state.observationReadiness || {},
    navigationContext: {
      action: state.lastAction || leasedActionFor(state)?.originalAction || null,
      feedback: observation.lastActionResult?.feedback || state.lastAction?.feedback || null,
      result: observation.lastActionResult || null,
      lifecycle: activeExecutionEpisode
    },
    readinessDeadlineAt: Number(
      observation.destinationReadiness?.deadlineAt
      || activeExecutionEpisode.destinationReadiness?.deadlineAt
      || state.observationReadiness?.deadlineAt
      || 0
    )
  });
  const authoritativeTransition = applyTransitionStatus(
    state,
    observation,
    observation.previousObservation || null,
    observationReadiness
  );
  state = authoritativeTransition.state;
  observation = authoritativeTransition.observation;
  const transition = authoritativeTransition.transition;
  const lifecycle = authoritativeTransition.lifecycle;
  const lifecycleDirective = authoritativeTransition.directive || "continue";
  if (lifecycle) {
    const pendingBeforeLifecycle = normalizeLeasedAction(leasedActionFor(state));
    const preservePendingRecovery = pendingBeforeLifecycle?.status === "needs_reveal"
      && pendingBeforeLifecycle.originalAction?.id !== lifecycle.actionId;
    transactionStore?.recordActionEvent?.(state.id, {
      actionId: lifecycle.actionId,
      observationId: observation.observationId || "",
      turnId: clientTurnId || turnId,
      stage: lifecycle.status,
      lifecycle,
      directive: lifecycleDirective
    });
    transactionStore?.advanceGovernedAction?.(
      lifecycle.actionId,
      ["allowed", "approved", "dispatched", "observed"],
      lifecycle.status,
      { lifecycle, transition }
    );
    state = withUpdate(state, {
      executionEpisode: updatedExecutionEpisode(state, {
        leasedAction: ["rejected_before_dispatch", "observed", "verified", "failed", "unsafe"].includes(lifecycle.status)
          && !preservePendingRecovery
          ? null
          : leasedActionFor(state)
      }),
      stallCount: ["rejected_before_dispatch", "observed", "verified"].includes(lifecycle.status)
        ? 0
        : state.stallCount
    });
  }
  if (transition) {
    const preserveViewportRecovery = normalizeLeasedAction(leasedActionFor(state))?.status === "needs_reveal";
    transactionStore?.recordActionEvent?.(state.id, {
      actionId: transition.actionId,
      observationId: observation.observationId || "",
      turnId: clientTurnId || turnId,
      stage: "transition_evaluated",
      status: transition.status,
      nextDirective: transition.nextDirective,
      postcondition: transition.postcondition,
      diff: transition.diff
    });
    state = withUpdate(state, {
      currentBlocker: transition.status === "blocked" ? transition.blocker : null,
      executionEpisode: updatedExecutionEpisode(state, {
        leasedAction: ["achieved", "progressed", "blocked"].includes(transition.status) && !preserveViewportRecovery
          ? null
          : leasedActionFor(state)
      })
    });
  }

  if (lifecycleDirective === "stop_for_safety" || transition?.status === "unsafe") {
    const action = finalHandoffAction(
      "Fresh browser evidence confirmed a policy or transaction-safety conflict. I stopped before another checkout action.",
      observation
    );
    const unsafeState = withUpdate(state, { lastAction: action, status: "awaiting_user" });
    transactionStore?.saveSession?.(unsafeState);
    return {
      state: unsafeState,
      clientDecision: toClientDecision(action),
      debug: withLatencyDebug({ transition, finalAction: action }, latency, modelUsageFromMetas(model, []))
    };
  }

  if (transition?.status === "uncertain") {
    const action = normalizeAction({
      observationId: observation.observationId || "",
      observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
      type: "wait",
      intent: "reobserve_after_grounding_rejection",
      reason: "The transition evidence is incomplete. Capture one fresh observation and rebind current controls without repeating the action.",
      risk: "safe",
      requiresApproval: false
    });
    const uncertainState = withUpdate(state, { lastAction: action, status: "running" });
    transactionStore?.saveSession?.(uncertainState);
    return {
      state: uncertainState,
      clientDecision: toClientDecision(action),
      debug: withLatencyDebug({ transition, finalAction: action }, latency, modelUsageFromMetas(model, []))
    };
  }

  // Readiness owns the boundary between browser reaction and semantic
  // reasoning. A post-navigation shell is not a checkout state, so it cannot
  // create TaskState goals, candidates, recovery failures, or a user handoff.
  state = withUpdate(state, { observationReadiness });
  if (observationReadiness.classification === READINESS.TRANSIENT) {
    const action = normalizeAction({
      observationId: observation.observationId || "",
      observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
      type: "wait",
      intent: "reobserve_after_transient_observation",
      mechanicalEffect: "unknown",
      expectedPostconditions: [{ type: "observation_readiness", status: READINESS.READY }],
      readinessStartedAt: observationReadiness.startedAt,
      readinessDeadlineAt: observationReadiness.deadlineAt,
      readinessAttempts: observationReadiness.attempts,
      reason: `The page is still settling (${observationReadiness.reason}, observation ${observationReadiness.attempts}). Reobserve before the readiness deadline.`,
      risk: "safe",
      requiresApproval: false
    });
    const waitingState = withUpdate(state, { lastAction: action, status: "running" });
    transactionStore?.saveSession?.(waitingState);
    transactionStore?.recordActionEvent?.(waitingState.id, {
      observationId: observation.observationId || "",
      turnId: clientTurnId || turnId,
      stage: "observation_transient_wait",
      readiness: observationReadiness,
      dispatched: false,
      modelCalled: false
    });
    return {
      state: waitingState,
      clientDecision: toClientDecision(action),
      debug: withLatencyDebug({ observationReadiness, finalAction: action, modelCalled: false }, latency, modelUsageFromMetas(model, []))
    };
  }
  if (observationReadiness.classification === READINESS.DEGRADED) {
    if (observationReadiness.handoffEligible !== true) {
      const action = normalizeAction({
        observationId: observation.observationId || "",
        observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
        type: "wait",
        intent: "reobserve_degraded_loading_destination",
        mechanicalEffect: "unknown",
        expectedPostconditions: [{ type: "observation_readiness", status: READINESS.READY }],
        readinessStartedAt: observationReadiness.startedAt,
        readinessDeadlineAt: observationReadiness.deadlineAt,
        readinessAttempts: observationReadiness.attempts,
        reason: "The destination is still loading. Keep the navigation pending and reobserve without planning or asking the user.",
        risk: "safe",
        requiresApproval: false
      });
      const waitingState = withUpdate(state, { lastAction: action, status: "running" });
      transactionStore?.saveSession?.(waitingState);
      return {
        state: waitingState,
        clientDecision: toClientDecision(action),
        debug: withLatencyDebug({
          observationReadiness,
          finalAction: action,
          modelCalled: false,
          navigationStillPending: true
        }, latency, modelUsageFromMetas(model, []))
      };
    }
    const action = normalizeAction({
      observationId: observation.observationId || "",
      observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
      type: "stop",
      intent: "site_readiness_failure",
      mechanicalEffect: "unknown",
      expectedPostconditions: [],
      reason: "SITE_READINESS_FAILURE: the destination remained genuinely loading or unstable until the readiness deadline.",
      risk: "safe",
      requiresApproval: false
    });
    const degradedState = withUpdate(state, { lastAction: action, status: "stopped" });
    transactionStore?.saveSession?.(degradedState);
    return {
      state: degradedState,
      clientDecision: toClientDecision(action),
      debug: withLatencyDebug({
        observationReadiness,
        finalAction: action,
        modelCalled: false,
        stopCategory: "site_readiness_failure",
        userActionRequired: false
      }, latency, modelUsageFromMetas(model, []))
    };
  }

  // Reduce the fresh observation before any pending-action recovery. A new
  // foreground surface or stage invalidates obsolete recovery ownership, so
  // an old target can never be rebound ahead of the current TaskState.
  state = recordPreviousActionFacts(state, observation, traveler);
  const effectiveUserPolicy = canonicalizeUserPolicy({
    ...(state.approvals || {}),
    ...(state.userPolicy || {})
  }, traveler);
  const decisionPolicyFingerprint = aiDecisionPolicyFingerprint(effectiveUserPolicy, traveler);
  let activeComponentGrounding = null;
  let activeComponentGroundingMeta = null;
  let ambiguityModelCalls = 0;
  let ambiguityModelKind = "";
  const resolveTurnAmbiguity = async (request) => {
    if (ambiguityModelCalls >= 1) {
      const error = new Error("The turn-local ambiguity model budget is exhausted.");
      error.code = "AMBIGUITY_MODEL_BUDGET_EXHAUSTED";
      throw error;
    }
    // Consume the budget before awaiting so a failed model transport cannot
    // silently authorize a second semantic/mechanical interpretation call.
    ambiguityModelCalls += 1;
    ambiguityModelKind = request.kind || "unknown";
    return resolveAmbiguity(request);
  };
  // V2 has no pre-TaskState semantic-ownership model. Selected commerce truth
  // comes from the DecisionFrame transaction facts and verified receipts;
  // ambiguous mechanics may be explored only after one obligation is
  // admitted. This removes a model call and, more importantly, a second task
  // authority ahead of deterministic compilation.
  const semanticCompileStartedAt = Date.now();
  observationFrame = createObservationFrame(observation);
  decisionFrame = compileDecisionFrame({ observation, observationFrame, state, traveler });
  observation = decisionFrame.observation;
  latency.semantic_compile_ms += Date.now() - semanticCompileStartedAt;
  let transactionContext = prepareTransactionInvariants(state, observation, traveler, {
    authoritativeTransactionFacts: decisionFrame.transactionFacts
  });
  state = transactionContext.state;
  const initialTaskState = state.taskState || {};
  const parentObjective = {
    goal: state.goal || "Complete this checkout safely to payment review.",
    bookingRules: traveler.booking_rules || state.userPolicy?.bookingRules || "",
    paymentPreference: traveler.payment_preference || state.userPolicy?.paymentPreference || ""
  };
  const taskStateStartedAt = Date.now();
  const taskState = reduceDecisionFrame({
    previousTaskState: initialTaskState,
    observation,
    previousActionResult: observation.lastActionResult || null,
    verifiedCommerceObligations: freshVerifiedCommerceReceipt ? [freshVerifiedCommerceReceipt] : [],
    userPolicy: effectiveUserPolicy,
    traveler,
    transactionReview: transactionContext.review,
    parentObjective,
    decisionFrame,
    mechanicalEvidence: executionEpisodeFor(state).mechanicalEvidence || null
  });
  const taskReadModel = taskStateReadModel(taskState) || {};
  const authoritativeGoal = taskMechanics(taskState);
  latency.task_state_ms = Date.now() - taskStateStartedAt;

  // TaskState admits the Current Obligation before a model may hypothesize a
  // profile binding. This prevents unrelated required-looking page controls
  // (for example paid bundle cards) from competing with a known safe decline.
  // Grounding is scoped to the exact admitted controls and may refine only the
  // turn-local mechanics view. It does not rebuild DecisionFrame, rerun
  // TaskState, change transaction facts, or publish another obligation.
  const admittedUnknownComponents = unknownComponentsForObligation(
    observation,
    taskState.currentObligation
  );
  if (admittedUnknownComponents.length) {
    const admittedControlIds = admittedUnknownComponents
      .map((control) => control.controlId)
      .filter(Boolean);
    try {
      const grounded = await resolveTurnAmbiguity({
        kind: "semantic_binding",
        input: {
          apiKey,
          model: recoveryModel || model,
          observation,
          traveler,
          transactionReview: transactionContext.review,
          screenshotDataUrl,
          attemptedStrategies: recoveryFacts(state).failedStrategies || [],
          admittedControlIds
        }
      });
      observation = grounded.observation;
      activeComponentGrounding = grounded.optionalBinding;
      activeComponentGroundingMeta = grounded.meta;
      latency.classification_model_ms += Number(grounded.meta?.durationMs || 0);
    } catch (error) {
      activeComponentGrounding = {
        status: "unknown",
        reasonCode: "ACTIVE_REQUIREMENT_UNRESOLVED",
        candidateComponentIds: admittedControlIds,
        evidence: `Bounded semantic grounding was unavailable: ${error?.code || error?.message || "unknown error"}`
      };
    }
  }
  const ambiguityModelAlreadyUsed = () => ambiguityModelCalls > 0;
  if (taskState.clearObsoleteRecovery) {
    state = withUpdate(state, {
      executionEpisode: updatedExecutionEpisode(state, {
        leasedAction: null,
        attempts: 0,
        phase: "idle",
        stateHash: "",
        attemptedCandidateIds: [],
        failedStrategies: [],
        failedStrategySignatures: [],
        lastCode: "",
        lastRevealSample: null,
        updatedAt: new Date().toISOString()
      })
    });
  }
  const resolvedPaidAuthorization = taskState.currentObligation?.policyDecision?.authorization;
  const authorizedDecisionGroupId = taskState.currentObligation?.subject?.decisionGroupId;
  if (resolvedPaidAuthorization?.authorizationId && authorizedDecisionGroupId) {
    const existingAuthorizations = Array.isArray(state.approvals?.paidExtraAuthorizations)
      ? state.approvals.paidExtraAuthorizations
      : [];
    state = withUpdate(state, {
      approvals: {
        ...(state.approvals || {}),
        paidExtraAuthorizations: [
          ...existingAuthorizations.filter((authorization) => (
            authorization.decisionGroupId !== authorizedDecisionGroupId
          )),
          {
            ...resolvedPaidAuthorization,
            decisionGroupId: authorizedDecisionGroupId,
            transactionId: state.id,
            source: resolvedPaidAuthorization.source || "profile_resolver"
          }
        ]
      }
    });
  }
  const { semanticOwnership: _obsoleteSemanticOwnership, ...remainingDecisionCache } = state.aiDecisionCache || {};
  state = withUpdate(state, {
    taskState,
    executionEpisode: updatedExecutionEpisode(state, { mechanicalEvidence: null }),
    semanticOwnershipResolution: undefined,
    aiDecisionCache: remainingDecisionCache
  });
  if (
    state.pendingUserInput?.field
    && !(
      taskState.disposition?.kind === "request_input"
      && taskState.disposition?.field === state.pendingUserInput.field
    )
  ) {
    state = withUpdate(state, { pendingUserInput: null });
  }

  // The current browser state wins over an undispatched/stale prediction. If
  // the page changed without a matching result for the pending action, cancel
  // that binding and plan from the fresh surface instead of waiting for an
  // obsolete DOM outcome.
  const stalePending = normalizeLeasedAction(leasedActionFor(state));
  if (leasedActionSupersededByFreshPage(stalePending, observation)) {
    transactionStore?.recordActionEvent?.(state.id, {
      actionId: stalePending.originalAction.id || "",
      observationId: observation.observationId || "",
      turnId: clientTurnId || turnId,
      stage: "pending_action_cancelled_by_fresh_page",
      sourceObservationHash: stalePending.sourceObservationHash || "",
      currentObservationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
      dispatched: false
    });
    state = withUpdate(state, {
      executionEpisode: updatedExecutionEpisode(state, {
        leasedAction: null,
        attemptedCandidateIds: [],
        failedStrategySignatures: [],
        failedStrategies: []
      }),
      status: "running"
    });
  }

  // A pending advance is never stronger than newer exact selection truth.
  // Manual changes, rerenders, and late selector hydration can reveal a paid
  // conflict after navigation was planned. Cancel that stale plan and let the
  // freshly reduced decision own this turn.
  const pendingBeforeConflictReconciliation = normalizeLeasedAction(leasedActionFor(state));
  const authoritativeEffect = String(
    obligationField(authoritativeGoal, "semanticEffect")
    || obligationField(authoritativeGoal, "desiredSemanticOutcome")
    || obligationField(authoritativeGoal, "desiredPolicyOutcome")
    || ""
  );
  const authoritativeCorrection = agentContract.canonicalSemanticEffect(authoritativeEffect)
    === agentContract.SEMANTIC_EFFECT.SELECT_FREE_OPTION;
  if (pendingBeforeConflictReconciliation?.originalAction
    && actionAdvancesCheckout(pendingBeforeConflictReconciliation.originalAction)
    && authoritativeCorrection) {
    transactionStore?.recordActionEvent?.(state.id, {
      actionId: pendingBeforeConflictReconciliation.originalAction.id || "",
      observationId: observation.observationId || "",
      turnId: clientTurnId || turnId,
      stage: "pending_navigation_preempted_by_policy_conflict",
      decisionGroupId: obligationField(authoritativeGoal, "decisionGroupId") || "",
      obligationId: obligationField(authoritativeGoal, "goalId") || "",
      dispatched: false
    });
    state = withUpdate(state, {
      executionEpisode: updatedExecutionEpisode(state, {
        leasedAction: null,
        attemptedCandidateIds: []
      }),
      status: "running"
    });
  }

  // A recoverable governor result preserves the semantic action across the
  // observation created by scrolling. Rebind that same action to the fresh
  // canonical registry before consulting the model again.
  const normalizedPending = normalizeLeasedAction(leasedActionFor(state));
  if (normalizedPending?.status === "needs_reveal" && normalizedPending.originalAction) {
    const pending = normalizedPending;
    const rebound = rebindPendingRecoveryAction(pending, observation, state, traveler);
    const reboundAction = rebound.action;
    const targetStatus = pendingRecoveryTargetStatus(reboundAction);
    const revealSample = viewportProgress(
      recoveryFacts(state).lastRevealSample || null,
      viewportProgressSample(reboundAction, observation)
    );
    // Candidate graphs are fresh-observation mechanics. Keep them in this
    // turn and pass them directly to governance; never persist them inside the
    // semantic TaskState obligation.
    const reboundState = state;
    if (!targetStatus.exists) {
      const grounding = recoverBeforeDispatch({
        state: reboundState,
        action: reboundAction,
        code: "TARGET_DISAPPEARED"
      });
      const action = normalizeAction({
        observationId: observation.observationId || "",
        observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
        type: "wait",
        intent: "reobserve_after_grounding_rejection",
        obligationId: pending.obligationId || "",
        reason: "The pending target disappeared. Discard its binding, rebuild candidates from the fresh surface, and reselect without consuming an execution attempt.",
        risk: "safe",
        requiresApproval: false
      });
      const recoveryState = withUpdate(grounding.state, {
        executionEpisode: updatedExecutionEpisode(grounding.state, { leasedAction: null }),
        lastAction: action,
        status: "running"
      });
      transactionStore?.saveSession?.(recoveryState);
      return {
        state: recoveryState,
        clientDecision: toClientDecision(action),
        debug: withLatencyDebug({ pendingAction: pending, groundingRejection: grounding, finalAction: action, resumedBeforePlanning: true }, latency, modelUsageFromMetas(model, []))
      };
    }

    const revealRecovery = updateExecutionRecovery(reboundState, {
      kind: "reveal",
      code: targetStatus.inViewport ? "TARGET_IN_VIEW" : "TARGET_OUT_OF_VIEW",
      sample: revealSample,
      measurableProgress: revealSample.measurableProgress
    });
    const policyStartedAt = Date.now();
    let recoveryGovernance = targetStatus.exists && targetStatus.inViewport
      ? governAction({
          action: reboundAction,
          state: revealRecovery.state,
          observation,
          traveler,
          approvals: revealRecovery.state.approvals,
          store: transactionStore,
          turnId: clientTurnId || turnId,
          preparedInvariantContext: transactionContext,
          preparedCandidateSet: rebound.candidateSet
        })
      : {
          state: revealRecovery.state,
          allow: false,
          decision: "recoverable",
          code: "TARGET_OUT_OF_VIEW",
          reason: "The fresh observation has not yet confirmed the pending canonical target in the viewport."
        };
    latency.policy_ms = Date.now() - policyStartedAt;
    let recoveryState = recoveryGovernance.state || reboundState;
    let finalAction = reboundAction;

    if (recoveryGovernance.allow && targetStatus.exists && targetStatus.inViewport) {
      recoveryState = withUpdate(recoveryState, {
        executionEpisode: updatedExecutionEpisode(recoveryState, { leasedAction: leasedActionRecord({
          action: reboundAction,
          candidate: rebound.candidate || pending.candidateIdentity,
          goal: authoritativeGoal,
          status: "ready",
          recoveryAttempts: revealRecovery.recovery.attempts
        }) }),
        lastAction: reboundAction,
        status: "running"
      });
      transactionStore?.recordActionEvent?.(recoveryState.id, {
        actionId: reboundAction.id,
        observationId: observation.observationId || "",
        turnId: clientTurnId || turnId,
        stage: "pending_action_rebound_dispatched",
        recoveryOfActionId: pending.originalAction.id,
        recoveryAttempts: revealRecovery.recovery.attempts,
        action: reboundAction
      });
    } else if (recoveryGovernance.decision === "recoverable"
      && recoveryGovernance.code === "TARGET_OUT_OF_VIEW"
      && !revealRecovery.exhausted) {
      const nextRecoveryAttempt = Number(revealRecovery.recovery.attempts || 0) + 1;
      const scrollAction = viewportRecoveryAction(reboundAction, observation, nextRecoveryAttempt);
      const scrollGovernance = governAction({
        action: scrollAction,
        state: recoveryState,
        observation,
        traveler,
        approvals: recoveryState.approvals,
        store: transactionStore,
        turnId: clientTurnId || turnId,
        preparedInvariantContext: transactionContext,
        preparedCandidateSet: rebound.candidateSet
      });
      if (scrollGovernance.allow) {
        recoveryGovernance = scrollGovernance;
        finalAction = scrollAction;
        recoveryState = withUpdate(scrollGovernance.state || recoveryState, {
          executionEpisode: updatedExecutionEpisode(scrollGovernance.state || recoveryState, { leasedAction: leasedActionRecord({
            action: pending.originalAction,
            candidate: pending.candidateIdentity,
            goal: authoritativeGoal,
            status: "needs_reveal",
            recoveryAttempts: nextRecoveryAttempt
          }) }),
          lastAction: scrollAction,
          status: "running"
        });
        transactionStore?.recordActionEvent?.(recoveryState.id, {
          actionId: scrollAction.id,
          observationId: observation.observationId || "",
          turnId: clientTurnId || turnId,
          stage: "pending_action_reveal_governed",
          recoveryOfActionId: pending.originalAction.id,
          recoveryAttempts: nextRecoveryAttempt,
          action: scrollAction
        });
      } else if (scrollGovernance.decision === "recoverable") {
        const grounding = recoverBeforeDispatch({
          state: recoveryState,
          action: scrollAction,
          code: scrollGovernance.code || "SCROLL_GROUNDING_REJECTED"
        });
        recoveryState = grounding.state;
        finalAction = normalizeAction({
          observationId: observation.observationId || "",
          observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
          type: "wait",
          intent: "reobserve_after_grounding_rejection",
          obligationId: pending.obligationId || "",
          reason: "The governed reveal binding was rejected before dispatch. Rebuild it from a fresh observation without consuming an execution attempt.",
          risk: "safe",
          requiresApproval: false
        });
        recoveryState = withUpdate(recoveryState, {
          executionEpisode: updatedExecutionEpisode(recoveryState, { leasedAction: null }),
          lastAction: finalAction,
          status: "running"
        });
      } else {
        recoveryGovernance = scrollGovernance;
        finalAction = policyBlockedAction(scrollGovernance, scrollAction);
        recoveryState = withUpdate(recoveryState, {
          executionEpisode: updatedExecutionEpisode(recoveryState, { leasedAction: null }),
          lastAction: finalAction,
          status: "awaiting_user"
        });
      }
    } else if (recoveryGovernance.decision === "recoverable"
      && recoveryGovernance.code === "TARGET_OUT_OF_VIEW"
      && revealRecovery.exhausted) {
      const exhaustedGoal = authoritativeGoal || {};
      const mechanicalEvidence = {
        kind: "goal_strategies_exhausted",
        goalId: obligationField(exhaustedGoal, "goalId") || pending.obligationId || "",
        semanticGoalKey: semanticGoalKey(exhaustedGoal),
        decisionGroupId: exhaustedGoal.decisionGroupId || exhaustedGoal.subject?.decisionGroupId || "",
        subjectKey: exhaustedGoal.canonicalSubject?.key || exhaustedGoal.subject?.key || exhaustedGoal.semanticType || "",
        surfaceId: exhaustedGoal.surfaceId || observation.page?.currentSurface?.id || "surface-page",
        observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
        excludedControlIds: [reboundAction.controlId].filter(Boolean)
      };
      finalAction = normalizeAction({
        observationId: observation.observationId || "",
        observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
        type: "wait",
        intent: "reobserve_after_strategy_exhaustion",
        mechanicalEffect: "none",
        expectedPostconditions: [{ type: "fresh_observation_required" }],
        reason: "The exact viewport-recovery budget is exhausted. Persist compact mechanical evidence and let the next single TaskState reduction publish the final disposition.",
        risk: "safe",
        requiresApproval: false
      });
      recoveryState = withUpdate(recoveryState, {
        executionEpisode: updatedExecutionEpisode(recoveryState, {
          leasedAction: null,
          mechanicalEvidence
        }),
        lastAction: finalAction,
        status: "running"
      });
    } else if (recoveryGovernance.decision === "recoverable") {
      const grounding = recoverBeforeDispatch({
        state: recoveryState,
        action: reboundAction,
        code: recoveryGovernance.code || "PENDING_ACTION_GROUNDING_REJECTED"
      });
      recoveryState = grounding.state;
      finalAction = normalizeAction({
        observationId: observation.observationId || "",
        observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
        type: "wait",
        intent: "reobserve_after_grounding_rejection",
        obligationId: pending.obligationId || "",
        reason: "The rebound pending action was rejected before dispatch. Rebuild current candidates from fresh browser evidence without consuming an execution attempt.",
        risk: "safe",
        requiresApproval: false
      });
      recoveryState = withUpdate(recoveryState, {
        executionEpisode: updatedExecutionEpisode(recoveryState, { leasedAction: null }),
        lastAction: finalAction,
        status: "running"
      });
    } else {
      finalAction = policyBlockedAction(recoveryGovernance, reboundAction);
      recoveryState = withUpdate(recoveryState, {
        executionEpisode: updatedExecutionEpisode(recoveryState, { leasedAction: null }),
        lastAction: finalAction,
        status: "awaiting_user"
      });
    }

    finalAction = bindTargetSnapshot(finalAction, observation);
    recoveryState = withUpdate(recoveryState, { lastAction: finalAction });
    transactionStore?.saveSession?.(recoveryState);
    const debug = withLatencyDebug(
      summarizeTurn({
        pageState: null,
        requirements: [],
        plannedAction: reboundAction,
        finalAction,
        policyDecision: recoveryGovernance,
        deterministicAction: reboundAction
      }),
      latency,
      modelUsageFromMetas(model, [])
    );
    enqueueTrace(dataDir, state.id, {
      turnId,
      screenshotDataUrl,
      observation: traceObservation,
      pageState: null,
      requirements: [],
      requirementLifecycle: [],
      verification: observation.lastActionResult || null,
      plannedAction: reboundAction,
      policyDecision: recoveryGovernance,
      executionResult: {
        pendingRecovery: true,
        recoveryAttempts: pending.recoveryAttempts,
        recoveryOfActionId: pending.originalAction.id,
        freshTargetExists: targetStatus.exists,
        freshTargetInViewport: targetStatus.inViewport,
        revealProgress: revealSample,
        executionEpisode: executionEpisodeFor(recoveryState)
      },
      debug
    });
    return { state: recoveryState, clientDecision: toClientDecision(finalAction), debug };
  }

  // An approved action must be observed before any new goal or candidate set
  // is derived. Missing execution feedback is a resume condition, not a new
  // planning turn and not a user-facing failure.
  if (leasedActionNeedsResult(state, observation)) {
    const pending = normalizeLeasedAction(leasedActionFor(state));
    const action = normalizeAction({
      observationId: observation.observationId || "",
      observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
      type: "wait",
      intent: "await_pending_action_result",
      obligationId: pending?.obligationId || "",
      candidateId: pending?.candidateId || "",
      reason: `Wait for browser evidence for pending action ${pending?.originalAction?.id || ""}; do not derive or dispatch another action.`,
      risk: "safe",
      requiresApproval: false
    });
    const waitingState = withUpdate(state, { lastAction: action, status: "running" });
    transactionStore?.saveSession?.(waitingState);
    return {
      state: waitingState,
      clientDecision: toClientDecision(action),
      debug: withLatencyDebug({ pendingAction: pending, finalAction: action, resumedBeforePlanning: true }, latency, modelUsageFromMetas(model, []))
    };
  }

  // TaskState publishes one typed disposition for every ready turn. The loop
  // translates that decision into a client action; it must not independently
  // reinterpret profile readiness, validation, site state, or missing goals.
  const taskDisposition = taskState.disposition || {};
  const publishedGoal = authoritativeGoal;
  const publishedProfileGoal = publishedGoal?.kind === "profile_field"
    ? publishedGoal
    : null;
  const publishedAdaptiveGoal = publishedGoal?.kind === "adaptive_surface"
    ? publishedGoal
    : null;
  const publishedMechanicalGoal = publishedProfileGoal || publishedAdaptiveGoal;
  if (["request_input", "request_approval", "wait_reobserve", "terminal", "stop"].includes(taskDisposition.kind)) {
    const missingDerivedFact = taskDisposition.missingDerivedFact || null;
    const missingField = String(taskDisposition.field || "");
    const missingLabel = String(
      taskDisposition.fieldLabel
      || (missingField ? profileFieldLabel(missingField) : "")
      || taskDisposition.reason
      || "required information"
    );
    const travelerName = [traveler.first_name, traveler.middle_name, traveler.last_name].filter(Boolean).join(" ") || "this traveler";
    const reason = `${taskDisposition.code || "TASK_STATE_DISPOSITION"}: ${missingDerivedFact
      ? `the ${missingDerivedFact.label} was not captured from the selected flight. Return to the selected flight and start Fly again so the booking can be verified before traveler details are completed.`
      : taskDisposition.kind === "request_input" && missingField
      ? `What is ${travelerName}'s ${missingLabel}? This checkout requires it before continuing.`
      : taskDisposition.reason || "TaskState could not publish a safe executable obligation."}`;
    const action = taskDisposition.kind === "terminal"
      ? normalizeAction({
          observationId: observation.observationId || "",
          observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
          type: "final_review",
          intent: taskDisposition.code === "PAYMENT_REVIEW_REACHED" ? "payment_review_reached" : "task_terminal",
          mechanicalEffect: "none",
          expectedPostconditions: [],
          reason,
          risk: taskDisposition.code === "PAYMENT_REVIEW_REACHED" ? "payment" : "safe",
          requiresApproval: true
        })
      : taskDisposition.kind === "request_input"
      ? finalHandoffAction(reason, observation, {
          ...(missingField ? {
            inputRequest: {
              requestId: `profile_input_${state.id}_${missingField}`,
              field: missingField,
              label: missingLabel,
              subjectId: traveler.id || state.travelerId || "traveler_1",
              sensitive: ["passport_number", "document_number"].includes(missingField)
            }
          } : {})
        })
      : taskDisposition.kind === "request_approval"
        ? finalHandoffAction(reason, observation, {
          })
        : normalizeAction({
            observationId: observation.observationId || "",
            observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
            type: taskDisposition.kind === "wait_reobserve" ? "wait" : "stop",
            intent: taskDisposition.code === "SITE_FAILURE_OBSERVED"
              ? "site_failure_observed"
              : taskDisposition.kind === "wait_reobserve"
              ? "task_state_reobserve"
              : "task_state_stop",
            mechanicalEffect: "none",
            expectedPostconditions: taskDisposition.kind === "wait_reobserve"
              ? [{ type: "fresh_observation_required" }]
              : [],
            readinessStartedAt: taskDisposition.reobserveStartedAt || 0,
            readinessDeadlineAt: taskDisposition.reobserveDeadlineAt || 0,
            readinessAttempts: taskDisposition.reobserveCount || 0,
            reobserveRetryToken: taskDisposition.retryToken || "",
            reason,
            risk: "safe",
            requiresApproval: false
          });
    const status = taskDisposition.kind === "terminal"
      ? "ready_for_payment"
      : taskDisposition.kind === "wait_reobserve"
      ? "running"
      : ["request_input", "request_approval"].includes(taskDisposition.kind)
        ? "awaiting_user"
        : "stopped";
    const dispositionState = withUpdate(state, {
      taskState,
      lastAction: action,
      status,
      pendingUserInput: taskDisposition.kind === "request_input" ? action.inputRequest || null : null,
      paymentState: taskDisposition.kind === "terminal"
        ? { ...(state.paymentState || {}), status: "review_reached" }
        : state.paymentState
    });
    const debug = withLatencyDebug({
        taskState,
        processAwareness: taskReadModel.processAwareness || null,
        transactionReview: taskReadModel.transactionReview || null,
        paymentEvidence: taskReadModel.paymentEvidence || null,
        stageDecisionEvidence: taskReadModel.stageDecisionEvidence || null,
        candidateGenerationSuppressed: taskDisposition.kind === "terminal",
        activeComponentGrounding,
        finalAction: action,
        reason,
        stopCategory: String(taskDisposition.code || taskDisposition.kind || "task_state_disposition").toLowerCase(),
        userActionRequired: taskDisposition.userActionRequired === true
      }, latency, modelUsageFromMetas(model, [activeComponentGroundingMeta]));
    return finishTurn({
      dataDir,
      sessionId: state.id,
      turnId,
      screenshotDataUrl,
      observation: traceObservation,
      state: dispositionState,
      action,
      debug,
      transactionStore,
      verification: observation.lastActionResult || null,
      policyDecision: {
        allow: false,
        decision: taskDisposition.kind,
        code: taskDisposition.code,
        reason
      },
      executionResult: {
        endingAction: action.type,
        endingIntent: action.intent,
        stopped: ["stop", "ask_user"].includes(action.type),
        userActionRequired: taskDisposition.userActionRequired === true,
        stopCategory: String(taskDisposition.code || taskDisposition.kind || "task_state_disposition").toLowerCase()
      }
    });
  }

  // The action lifecycle above is the sole authority for unchanged outcomes.
  // A pre-dispatch rejection rebuilds from this observation; only a browser-
  // dispatched unchanged transition consumes an execution strategy attempt.
  // Build the task-scoped contract before consulting a model. Canonical
  // decision groups, current-surface ownership, policy, unavailable state and
  // failed stable strategies are sufficient for an obvious single action.
  // In that case the model must not rediscover or reinterpret the contract.
  let canonicalState = withUpdate(state, {
    taskState,
  });
  let canonicalGoal = taskMechanics(taskState);
  if (!canonicalGoal) {
    const reason = "TASK_STATE_CONTRACT_VIOLATION: an execute disposition did not include a CurrentObligation.";
    const action = normalizeAction({
      observationId: observation.observationId || "",
      observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
      type: "stop",
      intent: "task_state_contract_violation",
      mechanicalEffect: "none",
      expectedPostconditions: [],
      reason,
      risk: "safe",
      requiresApproval: false
    });
    const stoppedState = withUpdate(canonicalState, {
      lastAction: action,
      status: "stopped"
    });
    transactionStore?.saveSession?.(stoppedState);
    const debug = withLatencyDebug({
        taskState,
        finalAction: action,
        stopCategory: "task_state_contract_violation",
        userActionRequired: false
      }, latency, modelUsageFromMetas(model, []));
    return finishTurn({
      dataDir,
      sessionId: state.id,
      turnId,
      screenshotDataUrl,
      observation: traceObservation,
      state: stoppedState,
      action,
      debug,
      transactionStore,
      verification: observation.lastActionResult || null,
      policyDecision: {
        allow: false,
        decision: "internal_failure",
        reason
      },
      executionResult: {
        endingAction: action.type,
        endingIntent: action.intent,
        stopped: true,
        userActionRequired: false,
        stopCategory: "task_state_contract_violation"
      }
    });
  }
  let canonicalFailedStrategies = failedStrategySignaturesForGoal(state, canonicalGoal, observation);
  let canonicalCandidateSet = groundedObservationCandidateSet(
    taskState.currentObligation,
    decisionFrame,
    observation,
    canonicalFailedStrategies,
    {
      state: canonicalState,
      traveler,
      approvals: state.approvals
    }
  );
  // Strategy exhaustion is persisted as compact mechanical evidence for the
  // next observation. The current turn never invokes TaskState a second time.
  // On the next turn the single reducer pass may retain the obligation or
  // publish one bounded adaptive fallback from that evidence.
  if (!canonicalCandidateSet.candidates.length) {
    const failedControlIds = [...new Set((recoveryFacts(state).failedStrategies || [])
      .filter((entry) => entry.semanticGoalKey === semanticGoalKey(canonicalGoal))
      .map((entry) => entry.controlId)
      .filter(Boolean))];
    const mechanicalEvidence = {
        kind: "goal_strategies_exhausted",
        goalId: obligationField(canonicalGoal, "goalId"),
        semanticGoalKey: semanticGoalKey(canonicalGoal),
        decisionGroupId: obligationField(canonicalGoal, "decisionGroupId") || obligationField(canonicalGoal, "subject")?.decisionGroupId || "",
        subjectKey: obligationField(canonicalGoal, "canonicalSubject")?.key || obligationField(canonicalGoal, "subject")?.key || obligationField(canonicalGoal, "semanticType") || "",
        surfaceId: obligationField(canonicalGoal, "surfaceId") || observation.page?.currentSurface?.id || "surface-page",
        observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
        excludedControlIds: failedControlIds
      };
    const action = normalizeAction({
      observationId: observation.observationId || "",
      observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
      type: "wait",
      intent: "reobserve_after_strategy_exhaustion",
      mechanicalEffect: "unknown",
      expectedPostconditions: [{ type: "fresh_observation_required" }],
      reason: "No exact current mechanic can execute the admitted obligation. Reobserve once so TaskState alone can route bounded recovery or publish the final exhaustion disposition.",
      risk: "safe",
      requiresApproval: false
    });
    const waitingState = withUpdate(canonicalState, {
      taskState,
      executionEpisode: updatedExecutionEpisode(canonicalState, { mechanicalEvidence }),
      lastAction: action,
      status: "running"
    });
    return finishTurn({
      dataDir,
      sessionId: state.id,
      turnId,
      screenshotDataUrl,
      observation: traceObservation,
      state: waitingState,
      action,
      debug: withLatencyDebug({ taskState, mechanicalEvidence, finalAction: action }, latency, modelUsageFromMetas(model, [])),
      transactionStore,
      verification: observation.lastActionResult || null,
      policyDecision: { allow: false, decision: "reobserve", code: "MECHANICS_EXHAUSTED", reason: action.reason },
      executionResult: { endingAction: "wait", endingIntent: action.intent, stopped: false }
    });
  }
  canonicalState = withUpdate(canonicalState, { taskState });
  const staleReboundCandidate = reusableStaleActionCandidate(
    recoveryFacts(state).staleRebind,
    canonicalGoal,
    canonicalCandidateSet,
    decisionPolicyFingerprint
  );
  let obviousCandidate = staleReboundCandidate || deterministicTaskCandidate(canonicalCandidateSet, canonicalGoal);
  const staleActionReused = Boolean(staleReboundCandidate);
  if (recoveryFacts(state).staleRebind) {
    state = withUpdate(state, {
      executionEpisode: updatedExecutionEpisode(state, { staleRebind: null })
    });
    canonicalState = withUpdate(canonicalState, {
      executionEpisode: updatedExecutionEpisode(canonicalState, { staleRebind: null })
    });
  }

  let extracted;
  let verification;
  let modelPlannedAction;
  let modelSelection;
  let observationGoal;
  let candidateSet;
  let observationCandidates;
  let deterministicAction = null;
  let candidateSelectionDecision = null;
  let candidateSelectionReused = false;
  const planningModel = publishedMechanicalGoal ? (recoveryModel || model) : model;
  let modelUsage;

  if (obviousCandidate) {
    extracted = {
      pageState: null,
      pageStep: taskState.stage,
      requirements: [],
      uncertainties: [],
      summary: "One policy-allowed task candidate remained after canonical filtering."
    };
    verification = deterministicTransitionVerification(transition);
    observationGoal = canonicalGoal;
    candidateSet = canonicalCandidateSet;
    observationCandidates = candidateSet.candidates;
    modelSelection = {
      candidateId: obviousCandidate.candidateId,
      candidate: obviousCandidate,
      confidence: "deterministic",
      semanticOutcome: obviousCandidate.interactionRole === "navigation"
        ? "advance_current_surface"
        : "satisfy_current_decision"
    };
    modelPlannedAction = bindTargetSnapshot(
      { ...actionForCurrentCandidate(observationGoal, obviousCandidate, observation), semanticOutcome: modelSelection.semanticOutcome },
      observation
    );
    deterministicAction = modelPlannedAction;
    modelUsage = modelUsageFromMetas(planningModel, []);
    transactionStore?.recordActionEvent?.(state.id, {
      observationId: observation.observationId || "",
      turnId: clientTurnId || turnId,
      stage: "deterministic_task_candidate_selected",
      candidateId: obviousCandidate.candidateId,
      candidateCount: 1,
      modelCalled: false,
      staleActionReused
    });
  } else {
    // The task context above is the only semantic authority. Classification
    // cannot replace its remaining goal or reopen a completed obligation.
    // Genuine ambiguity is a closed selection over current candidate IDs.
    extracted = {
      pageState: null,
      pageStep: taskState.stage,
      requirements: [],
      uncertainties: [],
      summary: "Selection is scoped to the authoritative obligation and current candidate set."
    };
    verification = deterministicTransitionVerification(transition);
    observationGoal = canonicalGoal;
    candidateSet = canonicalCandidateSet;
    observationCandidates = candidateSet.candidates;
    try {
      let selected;
      try {
        selected = reusableCandidateSelection(
          state.aiDecisionCache,
          observation,
          observationGoal,
          candidateSet,
          decisionPolicyFingerprint
        );
        if (selected) {
          candidateSelectionReused = true;
          transactionStore?.recordActionEvent?.(state.id, {
            observationId: observation.observationId || "",
            turnId: clientTurnId || turnId,
            stage: "ai_candidate_decision_reused",
            candidateId: selected.candidateId,
            controlId: selected.candidate.controlId,
            modelCalled: false
          });
        } else if (ambiguityModelAlreadyUsed()) {
          // Semantic binding already consumed this turn's sole ambiguity
          // budget. Every remaining mechanic is grounded and governed; use
          // the binder's deterministic order instead of making a second call.
          const bounded = observationCandidates[0];
          selected = bounded
            ? { candidateId: bounded.candidateId, candidate: bounded, confidence: "bounded_deterministic", meta: null }
            : null;
        } else {
          const resolved = await resolveTurnAmbiguity({
            kind: "mechanic_selection",
            input: {
              apiKey,
              model: planningModel,
              goal: observationGoal,
              taskState,
              candidates: observationCandidates,
              contextCapabilities: candidateSet.contextCapabilities,
              observation,
              screenshotDataUrl
            }
          });
          selected = resolved.selection;
        }
      } catch (error) {
        if (error?.code !== "PLANNER_CANDIDATE_NOT_CURRENT") throw error;
        candidateSet = groundedObservationCandidateSet(
          taskState.currentObligation,
          decisionFrame,
          observation,
          failedStrategySignaturesForGoal(state, observationGoal, observation),
          {
            state: canonicalState,
            traveler,
            approvals: state.approvals
          }
        );
        observationCandidates = candidateSet.candidates;
        const rebuiltObvious = deterministicTaskCandidate(candidateSet, observationGoal);
        if (rebuiltObvious) {
          selected = { candidateId: rebuiltObvious.candidateId, candidate: rebuiltObvious, meta: null };
        } else if (ambiguityModelAlreadyUsed() && ambiguityModelKind === "semantic_binding" && observationCandidates[0]) {
          const bounded = observationCandidates[0];
          selected = { candidateId: bounded.candidateId, candidate: bounded, confidence: "bounded_deterministic", meta: null };
        } else if (ambiguityModelAlreadyUsed()) {
          // An invalid mechanical selection consumed the sole model call. Do
          // not reinterpret ambiguity as permission to choose an arbitrary
          // first candidate; return through the existing bounded retry path.
          throw error;
        } else {
          const resolved = await resolveTurnAmbiguity({
            kind: "mechanic_selection",
            input: {
              apiKey,
              model: planningModel,
              goal: observationGoal,
              taskState,
              candidates: observationCandidates,
              contextCapabilities: candidateSet.contextCapabilities,
              observation,
              screenshotDataUrl
            }
          });
          selected = resolved.selection;
        }
        transactionStore?.recordActionEvent?.(state.id, {
          observationId: observation.observationId || "",
          turnId: clientTurnId || turnId,
          stage: "candidate_selection_rebuilt",
          dispatched: false,
          browserReobserved: false,
          candidateCount: observationCandidates.length
        });
      }
      verifyPlanMeta = selected.meta || null;
      latency.verify_plan_model_ms = Number(verifyPlanMeta?.durationMs || 0);
      const selectedCandidate = selected.candidate
        || observationCandidates.find((candidate) => candidate.candidateId === selected.candidateId)
        || null;
      if (!selectedCandidate) {
        const error = new Error("The schema-bound planner did not resolve a current candidate.");
        error.code = "PLANNER_CANDIDATE_NOT_CURRENT";
        throw error;
      }
      modelSelection = {
        candidateId: selectedCandidate.candidateId,
        candidate: selectedCandidate,
        confidence: selected.confidence || "unknown",
        reused: selected.reused === true,
        semanticOutcome: selected.semanticOutcome || "satisfy_current_decision"
      };
      candidateSelectionDecision = candidateSelectionCacheEntry({
        observation,
        goal: observationGoal,
        candidate: selectedCandidate,
        selection: modelSelection,
        policyFingerprint: decisionPolicyFingerprint
      });
      modelPlannedAction = bindTargetSnapshot(
        { ...actionForCurrentCandidate(observationGoal, selectedCandidate, observation), semanticOutcome: modelSelection.semanticOutcome },
        observation
      );
    } catch (error) {
      if (error?.code === "PLANNER_CANDIDATE_NOT_CURRENT" && observationCandidates.length) {
        const fallbackCandidate = deterministicTaskCandidate(candidateSet, observationGoal);
        if (fallbackCandidate) {
          modelSelection = {
            candidateId: fallbackCandidate.candidateId,
            candidate: fallbackCandidate,
            confidence: "deterministic",
            semanticOutcome: fallbackCandidate.interactionRole === "navigation"
              ? "advance_current_surface"
              : "satisfy_current_decision"
          };
          modelPlannedAction = bindTargetSnapshot(
            { ...actionForCurrentCandidate(observationGoal, fallbackCandidate, observation), semanticOutcome: modelSelection.semanticOutcome },
            observation
          );
          deterministicAction = modelPlannedAction;
        } else {
          const retryAction = normalizeAction({
            observationId: observation.observationId || "",
            observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
            type: "wait",
            intent: "retry_planner_current_candidates",
            obligationId: obligationField(observationGoal, "goalId") || "",
            reason: "Candidate grounding was rejected before browser dispatch. Retry selection against this same immutable candidate set without reobserving the page.",
            risk: "safe",
            requiresApproval: false
          });
          const plannerRecovery = updateExecutionRecovery(canonicalState, {
            kind: "planner_rejection",
            code: "PLANNER_CANDIDATE_NOT_CURRENT"
          });
          const retryState = withUpdate(plannerRecovery.state, {
            taskState,
            executionEpisode: updatedExecutionEpisode(plannerRecovery.state, { leasedAction: null }),
            lastAction: retryAction,
            status: "running"
          });
          transactionStore?.saveSession?.(retryState);
          transactionStore?.recordActionEvent?.(retryState.id, {
            observationId: observation.observationId || "",
            turnId: clientTurnId || turnId,
            stage: "planner_candidate_grounding_rejected",
            dispatched: false,
            browserReobserved: false,
            candidateCount: observationCandidates.length,
            executionEpisode: executionEpisodeFor(retryState)
          });
          return {
            state: retryState,
            clientDecision: toClientDecision(retryAction),
            debug: withLatencyDebug({
              candidateGroundingRejected: true,
              aiServiceUnavailable: false,
              candidateSet,
              finalAction: retryAction
            }, latency, modelUsageFromMetas(planningModel, [verifyPlanMeta]))
          };
        }
      } else {
        return safePlannerFailureResult({
          dataDir,
          state: canonicalState,
          turnId,
          screenshotDataUrl,
          traceObservation,
          reason: plannerFailureReason(error),
          error,
          latency,
          modelUsage: modelUsageFromMetas(model, [verifyPlanMeta])
        });
      }
    }
    modelUsage = modelUsageFromMetas(planningModel, [verifyPlanMeta]);
  }

  state = withUpdate(canonicalState, {
    taskState,
  });
  // Do not synchronously persist this intermediate planning snapshot. No
  // browser action has been governed or dispatched yet, and the authoritative
  // post-governance state is persisted below. Writing both copies duplicated
  // a large candidate graph and dominated deterministic turn latency on the
  // multi-GB replay database.

  let nextState = withUpdate(state, {
    lastVerification: verification
  });

  let plannedAction = modelPlannedAction;

  if (!plannedAction || !plannedAction.type) {
    plannedAction = normalizeAction({
      observationId: observation.observationId || "",
      observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
      type: "wait",
      intent: "rebuild_current_action_context",
      obligationId: obligationField(observationGoal, "goalId") || "",
      reason: "No executable action was compiled. Preserve the current goal and rebuild its grounded candidates without treating this as a browser failure.",
      risk: "safe",
      requiresApproval: false
    });
  }

  // 4. Govern once — schema, stored observation, canonical target,
  // actionability, policy, transaction invariants, approval, duplication.
  if (["fill_known_fields", "fill_visible_profile_fields"].includes(plannedAction.type)) {
    plannedAction = finalHandoffAction(
      "The general planner returned a deprecated compound profile action after local semantic-goal processing.",
      observation
    );
  }
  const executablePlannedAction = bindTargetSnapshot(plannedAction, observation);
  const policyStartedAt = Date.now();
  let governance = governAction({
    action: executablePlannedAction,
    state: nextState,
    observation,
    traveler,
    approvals: nextState.approvals,
    store: transactionStore,
    turnId: clientTurnId || turnId,
    preparedInvariantContext: transactionContext,
    preparedCandidateSet: candidateSet
  });
  latency.policy_ms = Date.now() - policyStartedAt;
  nextState = governance.state || nextState;

  let finalAction = executablePlannedAction;
  if (!governance.allow && governance.decision === "recoverable" && governance.code === "TARGET_OUT_OF_VIEW") {
    const scrollAction = viewportRecoveryAction(executablePlannedAction, observation, 1);
    const scrollGovernance = governAction({
      action: scrollAction,
      state: nextState,
      observation,
      traveler,
      approvals: nextState.approvals,
      store: transactionStore,
      turnId: clientTurnId || turnId,
      preparedInvariantContext: transactionContext,
      preparedCandidateSet: candidateSet
    });
    governance = scrollGovernance;
    if (scrollGovernance.allow) {
      finalAction = scrollAction;
      const revealStarted = updateExecutionRecovery(scrollGovernance.state || nextState, {
        kind: "reveal_started",
        code: "TARGET_OUT_OF_VIEW",
        sample: viewportProgressSample(executablePlannedAction, observation)
      });
      nextState = withUpdate(revealStarted.state, {
        executionEpisode: updatedExecutionEpisode(revealStarted.state, {
          leasedAction: pendingRevealAction(
            executablePlannedAction,
            1,
            modelSelection?.candidate || null,
            observationGoal
          )
        }),
        lastAction: scrollAction,
        status: "running"
      });
      transactionStore?.recordActionEvent?.(nextState.id, {
        actionId: scrollAction.id,
        observationId: observation.observationId || "",
        turnId: clientTurnId || turnId,
        stage: "pending_action_reveal_governed",
        recoveryOfActionId: executablePlannedAction.id,
        recoveryAttempts: 1,
        action: scrollAction
      });
    } else {
      finalAction = policyBlockedAction(scrollGovernance, scrollAction);
    }
  } else if (!governance.allow && governance.decision === "recoverable" && STALE_IDENTITY_CODES.has(governance.code)) {
    const groundingBudget = recoverBeforeDispatch({
      state: nextState,
      action: executablePlannedAction,
      code: governance.code
    });
    nextState = withUpdate(groundingBudget.state, {
      executionEpisode: updatedExecutionEpisode(groundingBudget.state, {
        leasedAction: null,
        staleRebind: staleActionRecoveryEntry(
          executablePlannedAction,
          modelSelection?.candidate || {},
          observationGoal,
          decisionPolicyFingerprint,
          governance.code
        )
      })
    });
    transactionStore?.recordActionEvent?.(nextState.id, {
      actionId: executablePlannedAction.id || "",
      observationId: observation.observationId || "",
      turnId: clientTurnId || turnId,
      stage: "grounding_replan",
      code: governance.code,
      dispatched: false,
      executionRecovery: groundingBudget.recovery
    });
    finalAction = normalizeAction({
      observationId: observation.observationId || "",
      observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
      type: "wait",
      intent: "reobserve_after_grounding_rejection",
      obligationId: obligationField(observationGoal, "goalId"),
      candidateId: modelSelection?.candidateId || "",
      reason: `Discard ${governance.code}, capture one fresh observation, and rebind the same safe semantic control before considering new reasoning.`,
      risk: "safe",
      requiresApproval: false
    });
  } else if (!governance.allow
    && governance.decision === "recoverable"
    && governance.code === "UNAPPROVED_SELECTED_EXTRA"
    && governance.details?.groundedReversal?.controlId) {
    nextState = withUpdate(nextState, {
      executionEpisode: updatedExecutionEpisode(nextState, { leasedAction: null }),
      currentBlocker: {
        classification: "reconcile_selected_extra",
        code: governance.code,
        ...governance.details.groundedReversal
      }
    });
    transactionStore?.recordActionEvent?.(nextState.id, {
      actionId: executablePlannedAction.id || "",
      observationId: observation.observationId || "",
      turnId: clientTurnId || turnId,
      stage: "selected_extra_reconciliation",
      code: governance.code,
      recoveryDirective: "reconcile_selected_extra",
      dispatched: false,
      groundedReversal: governance.details.groundedReversal
    });
    finalAction = normalizeAction({
      observationId: observation.observationId || "",
      observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
      type: "wait",
      intent: "reconcile_selected_extra",
      mechanicalEffect: "unknown",
      expectedPostconditions: [],
      reason: "Removing an unrequested paid option before continuing. Reobserve and rebuild the exact grounded correction.",
      risk: "safe",
      requiresApproval: false
    });
  } else if (!governance.allow) {
    finalAction = policyBlockedAction(governance, executablePlannedAction);
  }
  finalAction = bindTargetSnapshot(finalAction, observation);

  const pendingExecutableAction = governance.allow === true
    && ["click", "type", "select", "keypress", "scroll", "click_xy"].includes(finalAction.type)
    && !leasedActionFor(nextState);
  const authoritativePendingAction = pendingExecutableAction
    ? leasedActionRecord({
        action: finalAction,
        candidate: modelSelection?.candidate || null,
        goal: observationGoal,
        status: "ready"
      })
    : leasedActionFor(nextState);

  nextState = withUpdate(nextState, {
    executionEpisode: updatedExecutionEpisode(nextState, { leasedAction: authoritativePendingAction }),
    lastAction: finalAction,
    status: finalAction.type === "ask_user" || finalAction.type === "final_review" ? "awaiting_user" : "running",
    aiDecisionCache: governance.allow === true && candidateSelectionDecision
      ? {
          ...(nextState.aiDecisionCache || {}),
          candidateSelection: candidateSelectionDecision
        }
      : nextState.aiDecisionCache
  });

  const debug = withLatencyDebug(
    summarizeTurn({
      pageState: extracted.pageState,
      requirements: [],
      plannedAction,
      finalAction,
      policyDecision: governance,
      deterministicAction,
      reusedAiDecision: {
        candidateSelection: candidateSelectionReused
      },
      taskState,
      taskReadModel
    }),
    latency,
    modelUsage
  );
  latency.turn_total_ms = Date.now() - turnStartedAt;
  const traceWriteStartedAt = Date.now();
  enqueueTrace(dataDir, state.id, {
    turnId, screenshotDataUrl, observation: traceObservation, pageState: extracted.pageState, requirements: [], requirementLifecycle: [], verification,
    plannedAction, policyDecision: governance,
    executionResult: { stillMissingCount: 0 },
    debug
  });
  latency.trace_queue_ms = Date.now() - traceWriteStartedAt;
  const finalStatePersistStartedAt = Date.now();
  transactionStore?.saveSession?.(nextState);
  latency.final_state_persist_ms = Date.now() - finalStatePersistStartedAt;
  latency.turn_total_ms = Date.now() - turnStartedAt;

  return {
    state: nextState,
    clientDecision: toClientDecision(finalAction),
    debug
  };
}

module.exports = {
  runLoopTurn,
  toClientDecision,
  __private: {
    bindTargetSnapshot,
    buildControlAliasIndex,
    deterministicTaskCandidate,
    expectedOutcomeForAction,
    rebindPendingRecoveryAction,
    updateExecutionRecovery,
    applyTransitionStatus,
    leasedActionSupersededByFreshPage,
    candidateStrategySignature,
    candidateSelectionCacheEntry,
    reusableCandidateSelection,
    staleActionRecoveryEntry,
    reusableStaleActionCandidate,
    aiDecisionPolicyFingerprint,
    semanticGoalRecoveryKey,
    observationPageStateHash,
    targetLocalRecoveryScope,
    rawVerifiedCommerceReceipt,
    failedStrategySignaturesForGoal,
    groundedObservationCandidateSet,
    observationSurfaceId,
    staleIdentityRejection,
    targetSnapshotForAction,
    resolveActionControl,
  }
};
