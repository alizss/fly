const { evaluateActionPolicy, isNonMutatingAction } = require("../../../packages/shared/policy");
const { isDeepStrictEqual } = require("node:util");
const {
  actuatorSignature,
  normalizeAction,
  normalizeVisualRegion,
  visualRegionsMatch
} = require("../../../packages/shared/agent-actions");
const { classifyGraphConflicts, resolveActionControl, selectedActionGraphConflicts } = require("./control-alias-index");
const { invariantDecision } = require("./invariants");
const { PAGE_SURFACE_ID, controlBelongsToCurrentSurface, currentSurface, currentSurfaceId } = require("./surface-contract");
const { approveActionLifecycle, proposeActionLifecycle, rejectActionLifecycle } = require("./action-lifecycle");
const { executionEpisodeFor, recoveryFacts, stateWithExecutionEpisode } = require("./execution-episode");
const {
  assessOutcomeCompatibility,
  expectedPostconditionsForAction,
  normalizedActionSemantics,
  outcomeContractForGoal,
  predictPhysicalEffect,
  semanticIntentForAction
} = require("./action-semantics");
const agentContract = require("../../extension/src/shared/agent-contract");
const { currentObligation } = require("./authority-frames");

const DOM_MUTATIONS = new Set(["click", "type", "select", "keypress"]);
const COMPOUND_MUTATIONS = new Set(["fill_known_fields", "fill_visible_profile_fields"]);
const RECOVERABLE_GROUNDING_CODES = new Set([
  "CANDIDATE_SET_OBSERVATION_MISMATCH",
  "CURRENT_GOAL_CANDIDATE_MISMATCH",
  "CANONICAL_ALIAS_REQUIRED",
  "CANONICAL_ALIAS_UNRESOLVED",
  "CANONICAL_ALIAS_CONFLICT",
  "CANONICAL_TARGET_REQUIRED",
  "CONTROL_ID_MISMATCH",
  "DECISION_GROUP_MISMATCH",
  "TARGET_DECISION_GROUP_MISMATCH",
  "TARGET_ID_MISMATCH",
  "TARGET_SURFACE_MISMATCH",
  "TARGET_SEMANTIC_MISMATCH",
  "TARGET_RISK_MISMATCH",
  "ACTION_OPERATION_ACTUATOR_MISMATCH",
  "ACTION_ACTUATOR_KIND_MISMATCH",
  "CANONICAL_OPERATION_UNAVAILABLE",
  "CANONICAL_ACTUATOR_UNAVAILABLE",
  "OPERATION_PRECONDITION_FAILED",
  "TARGET_DISAPPEARED",
  "TARGET_NOT_RENDERED",
  "TARGET_NOT_VISIBLE",
  "TARGET_OCCLUDED",
  "TARGET_ACTIONABILITY_UNPROVEN",
  "TARGET_OUTSIDE_CURRENT_SURFACE",
  "CONTROL_GRAPH_SELECTED_ACTION_AMBIGUOUS"
]);

function taskMechanics(taskState = {}) {
  return currentObligation(taskState);
}

function fail(code, reason, checks = [], decision = "blocked_by_safety") {
  return { allow: false, decision, code, reason, checks: [...checks, { code, ok: false }] };
}

function recoverable(code, reason, checks = []) {
  return fail(code, reason, checks, "recoverable");
}

function pass(checks, code, detail = "") {
  checks.push({ code, ok: true, detail });
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function canonicalControlForAction(action, page = {}) {
  return resolveActionControl(action, page).control || null;
}

function executionLaneForAction(action = {}, control = {}, observation = {}, strategyAlreadyFailed = false) {
  let pipelineContract = action.pipelineContract || null;
  if (!pipelineContract && action.operation) {
    const observed = agentContract.observedComponentContract(control, {
      surfaceId: action.surfaceId || control.surfaceId || currentSurfaceId(observation.page || {})
    });
    const baseCapability = observed.capabilities.find((capability) => capability.operation === action.operation) || {};
    const selectedStrategy = (baseCapability.strategies || []).find((strategy) => (
      strategy.actuatorId === action.actuatorId
      && (!action.interactionMethod || strategy.method === action.interactionMethod)
    )) || null;
    const exactActuator = (baseCapability.exactActuators || [])
      .find((actuator) => actuator.actuatorId === action.actuatorId);
    pipelineContract = agentContract.canonicalPipelineContract({
      requirement: {
        requirementId: action.requirementId || action.obligationId || action.decisionGroupId || "",
        semanticType: action.targetSnapshot?.semantic || action.intent || ""
      },
      component: {
        componentIdentity: control.componentContract?.componentIdentity || control.stableKey || control.controlId,
        componentRole: control.componentRole || "value",
        controlId: control.controlId || action.controlId || "",
        controlRole: control.role || control.kind || ""
      },
      capability: {
        ...baseCapability,
        actuatorId: action.actuatorId || baseCapability.actuatorId || "",
        selectedStrategy,
        status: exactActuator?.status || baseCapability.status,
        proof: exactActuator?.proof || baseCapability.proof || null
      },
      expectedOutcome: action.expectedOutcome || {},
      validationOwnership: control.validationOwnership || {}
    });
  }
  return agentContract.classifyExecutionLane({
    action: { ...action, pipelineContract },
    pipelineContract,
    control,
    observation,
    strategyAlreadyFailed
  });
}

function currentObservationSurfaceId(observation = {}) {
  return currentSurfaceId(observation.page || {});
}

// A bound target snapshot is the canonical action-to-observation ownership
// contract. Candidate-only fields may exist before binding, but normalizeAction
// intentionally does not transport a second top-level surface identity.
function canonicalActionSurfaceId(action = {}) {
  return String(action.targetSnapshot?.surfaceId || "");
}

function currentWorkCandidateFailure(action = {}, state = {}, observation = {}, checks = [], preparedCandidateSet = null) {
  const goal = taskMechanics(state.taskState || {});
  if (!(goal?.id) || (!DOM_MUTATIONS.has(action.type) && action.type !== "click_xy")) return null;
  // An action with no candidate claim is an ownership violation. Let the
  // ownership check below report that precise prerequisite error; candidate
  // exactness applies once a candidateId is actually presented.
  if (!action.candidateId) return null;
  const candidateSet = preparedCandidateSet || null;
  if (!candidateSet) {
    return recoverable(
      "CURRENT_CANDIDATE_SET_REQUIRED",
      "Governance requires the turn-local candidate set for the authoritative Current Obligation.",
      checks
    );
  }
  if (candidateSet) {
    const currentObservationId = observation.observationId || "";
    const currentObservationHash = observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "";
    const currentSurfaceId = currentObservationSurfaceId(observation);
    if (candidateSet.observationId !== currentObservationId
      || candidateSet.observationHash !== currentObservationHash
      || candidateSet.surfaceId !== currentSurfaceId) {
      return recoverable(
        "CANDIDATE_SET_OBSERVATION_MISMATCH",
        "The selected candidate set is not bound to the current observation, hash, and surface.",
        checks
      );
    }
  }
  const candidates = candidateSet.candidates || [];
  const candidate = candidates.find((item) => item.candidateId === action.candidateId);
  const candidateAffordance = candidate?.affordance || {};
  const actionAffordance = action.affordance || {};
  const affordanceExact = !candidateAffordance.stableKey && !actionAffordance.stableKey
    ? true
    : Boolean(candidateAffordance.stableKey)
      && candidateAffordance.actuator?.proven === true
      && actionAffordance.actuator?.proven === true
      && isDeepStrictEqual(candidateAffordance, actionAffordance);
  const exact = Boolean(candidate)
    && action.obligationId === (goal?.id)
    && candidate.type === action.type
    && candidate.operation === action.operation
    && candidate.controlId === action.controlId
    && String(candidate.targetId || "") === String(action.actuatorId || "")
    && (!["type", "select"].includes(action.type) || String(candidate.value || "") === String(action.value || ""))
    && (action.type !== "keypress" || String(candidate.keys || "") === String(action.keys || ""))
    && (action.type !== "click_xy" || visualRegionsMatch(candidate.visualRegion || {}, action.visualRegion || {}))
    && action.interactionRole === candidate.interactionRole
    && action.semanticEffect === candidate.semanticEffect
    && action.expectedEvidence === candidate.expectedEvidence
    && affordanceExact
    && action.expectedOutcome?.type === candidate.expectedOutcome?.type
    && String(action.expectedOutcome?.controlId || "") === String(candidate.expectedOutcome?.controlId || "")
    && isDeepStrictEqual(action.pipelineContract || null, candidate.pipelineContract || null);
  if (!exact) {
    const mismatchFields = !candidate ? ["candidate"] : [
      ["obligationId", action.obligationId, (goal?.id)],
      ["type", action.type, candidate.type],
      ["operation", action.operation, candidate.operation],
      ["controlId", action.controlId, candidate.controlId],
      ["actuatorId", action.actuatorId, candidate.targetId],
      ["interactionRole", action.interactionRole, candidate.interactionRole],
      ["semanticEffect", action.semanticEffect, candidate.semanticEffect],
      ["expectedEvidence", action.expectedEvidence, candidate.expectedEvidence],
      ["expectedOutcome.type", action.expectedOutcome?.type, candidate.expectedOutcome?.type],
      ["expectedOutcome.controlId", action.expectedOutcome?.controlId, candidate.expectedOutcome?.controlId],
      ["affordance", affordanceExact, true],
      ["pipelineContract", isDeepStrictEqual(action.pipelineContract || null, candidate.pipelineContract || null), true]
    ].filter(([, actual, expected]) => actual !== expected).map(([field]) => field);
    return recoverable(
      "CURRENT_GOAL_CANDIDATE_MISMATCH",
      `The executable action is not the server-grounded candidate selected for the current semantic goal (${mismatchFields.join(", ") || "payload"}).`,
      checks
    );
  }
  const requiredDelta = goal.desiredStateDelta || goal.delta || null;
  if (!requiredDelta?.deltaId || action.desiredStateDelta?.deltaId !== requiredDelta.deltaId) {
    return recoverable(
      "ACTION_DESIRED_STATE_DELTA_MISMATCH",
      "Every mutation must carry the exact DesiredStateDelta published by the current obligation.",
      checks
    );
  }
  pass(checks, "CURRENT_GOAL_CANDIDATE_EXACT", candidate.candidateId);
  return null;
}

function currentWorkOwnershipFailure(action = {}, state = {}, page = {}, checks = []) {
  const goal = taskMechanics(state.taskState || {});
  if (!(goal?.id) || (!DOM_MUTATIONS.has(action.type) && action.type !== "click_xy")) return null;
  if (action.candidateId && action.obligationId === (goal?.id)) return null;
  const control = canonicalControlForAction(action, page) || {};
  return fail(
    "CURRENT_GOAL_UNRESOLVED",
    `The current semantic goal ${String(goal?.semanticOwner?.family || goal?.desiredStateDelta?.kind || "unknown").replace(/_/g, " ")}=${goal?.desiredStateDelta?.desiredValue} must complete or exhaust its finite recovery budget before ${control.label || action.targetLabel || action.intent || action.type}.`,
    checks
  );
}

function preSurfaceDiscoveryFailure(action = {}, state = {}, observation = {}, checks = []) {
  if (action.mechanicalHypothesis !== true) return null;
  const goal = taskMechanics(state.taskState || {});
  const envelope = action.discoveryEnvelope || {};
  const currentSurfaceId = currentObservationSurfaceId(observation);
  const effect = [
    action.mechanicalEffect,
    action.mechanicalEffect,
    action.intent,
    action.intent,
    action.targetSnapshot?.semantic
  ].filter(Boolean).join(" ").toLowerCase();
  const profileDiscovery = goal?.desiredStateDelta?.kind === "profile_field";
  const ownedChoiceDiscovery = goal?.desiredStateDelta?.status === "EXACT_DELTA"
    && goal?.desiredStateDelta?.desiredState === "options_surface_visible"
    && goal?.desiredStateDelta?.desiredEffect === "open"
    && (goal?.admittedControlIds || []).includes(action.controlId);
  if (
    (!profileDiscovery && !ownedChoiceDiscovery)
    || envelope.kind !== "pre_surface_discovery"
    || action.candidateClass !== "mechanical_hypothesis"
    || action.boundedRecovery !== true
    || action.capabilityStatus !== agentContract.CAPABILITY_STATUS.UNPROVEN_EXPERIMENT
  ) {
    return fail(
      "DISCOVERY_CONTRACT_INVALID",
      "A pre-surface hypothesis requires the exact owned choice goal and bounded discovery contract that created it.",
      checks
    );
  }
  if (
    !currentSurfaceId
    || envelope.sourceSurfaceId !== currentSurfaceId
    || envelope.logicalControlId !== (action.logicalControlId || action.controlId)
    || envelope.logicalControlId !== action.controlId
    || envelope.actuatorId !== action.actuatorId
  ) {
    return recoverable(
      "DISCOVERY_BINDING_STALE",
      "The mechanical hypothesis no longer belongs to its exact logical control, actuator, and source surface.",
      checks
    );
  }
  if (
    Number(envelope.remainingSteps || 0) !== 1
    || Number(envelope.deadlineAt || 0) <= Date.now()
    || !(envelope.allowedOperations || []).includes(action.operation)
    || action.operation !== "open"
    || !["click", "keypress"].includes(action.type)
    || action.expectedOutcome?.type !== "options_surface_appeared"
  ) {
    return fail(
      "DISCOVERY_BUDGET_OR_OPERATION_INVALID",
      "Pre-surface discovery permits one fresh open action followed by mandatory reobservation.",
      checks
    );
  }
  const risk = String(action.risk || action.targetSnapshot?.risk || "uncertain").toLowerCase();
  if (
    risk !== "safe"
    || (envelope.forbiddenRisks || []).includes(risk)
    || (envelope.forbiddenEffects || []).some((item) => effect.includes(String(item).toLowerCase()))
    || /purchase|booking|submit[_ ]?payment|pay[_ ]?now|paid|price|legal|terms|consent|subscribe|navigate|advance/.test(effect)
  ) {
    return fail(
      "DISCOVERY_EFFECT_FORBIDDEN",
      "Pre-surface discovery cannot navigate, add money, accept consent, or submit payment.",
      checks
    );
  }
  pass(checks, "PRE_SURFACE_DISCOVERY_VALID", `${envelope.logicalControlId}:${envelope.actuatorId}`);
  return null;
}

function validateCanonicalTarget(action, observation, checks, executionLane = "") {
  if (!DOM_MUTATIONS.has(action.type)) return null;
  const target = action.targetSnapshot || {};
  const resolution = resolveActionControl(action, observation.page || {});
  if (!resolution.ok) {
    return fail(resolution.code, "Every supplied target identity must resolve to the same canonical control in the stored observation.", checks);
  }
  const control = resolution.control;
  const authoritativeLane = executionLane || executionLaneForAction(action, control, observation);
  const authorizedParentSurfaceExit = agentContract.parentSurfaceExitOwnershipIsCurrent({
    action,
    pipelineContract: action.pipelineContract || {},
    control,
    observation
  });
  if (!control?.controlId || !target.controlId) {
    return fail("CANONICAL_TARGET_REQUIRED", "DOM mutations require one canonical control from the stored current observation.", checks);
  }
  if (control.controlId !== target.controlId) return fail("CONTROL_ID_MISMATCH", "The governed target does not match the canonical control registry.", checks);
  if (target.decisionGroupId && control.decisionGroupId && target.decisionGroupId !== control.decisionGroupId) {
    return fail("DECISION_GROUP_MISMATCH", "The target moved to a different checkout decision group.", checks);
  }
  if (target.surfaceId && control.surfaceId && target.surfaceId !== control.surfaceId) {
    return fail("TARGET_SURFACE_MISMATCH", "The governed target no longer belongs to the canonical control's surface.", checks);
  }
  if (target.semantic && control.semantic && target.semantic !== control.semantic) {
    return fail("TARGET_SEMANTIC_MISMATCH", "The target semantic intent changed after observation.", checks);
  }
  if (target.risk && control.risk && target.risk !== control.risk) {
    return fail("TARGET_RISK_MISMATCH", "The target risk classification changed after observation.", checks);
  }
  if (
    control.ownershipIntegrity?.ok === false
    && (control.ownershipIntegrity.conflictingNodeIds || []).includes(target.id)
  ) {
    return fail(
      "SELECTED_ACTUATOR_OWNERSHIP_CONFLICT",
      "The selected actuator is claimed by incompatible logical controls in the current observation.",
      checks
    );
  }
  let operationUsesExecutableActuator = false;
  if (action.operation) {
    const capability = control.operations?.[action.operation];
    if (authoritativeLane === agentContract.EXECUTION_LANE.BOUNDED_RECOVERY) {
      operationUsesExecutableActuator = true;
      pass(checks, "CANONICAL_BOUNDED_RECOVERY_BOUND", `${action.operation}:${target.id}:${action.interactionMethod || ""}`);
    } else if (authoritativeLane === agentContract.EXECUTION_LANE.REVEAL) {
      return recoverable(
        "TARGET_OUT_OF_VIEW",
        "The exact canonical actuator is recoverable but must be revealed before dispatch.",
        checks
      );
    } else if (authoritativeLane === agentContract.EXECUTION_LANE.NORMAL) {
      operationUsesExecutableActuator = true;
      pass(checks, "CANONICAL_OPERATION_BOUND", `${action.operation}:${target.id}`);
      pass(checks, "CANONICAL_ACTUATOR_ACTIONABLE", `${action.operation}:${target.id}`);
      const precondition = capability?.precondition || {};
      if (precondition.expanded === false && control.state?.expanded === true && !authorizedParentSurfaceExit) {
        return fail("OPERATION_PRECONDITION_FAILED", "The canonical control is already expanded, so its open operation is no longer valid.", checks);
      }
    } else {
      return fail(
        "ACTION_OPERATION_ACTUATOR_MISMATCH",
        `The canonical contract does not authorize ${action.operation} through this execution lane.`,
        checks
      );
    }
  }
  if (["type", "select"].includes(action.type)) {
    if (!control.stateElementId || target.id !== control.stateElementId) {
      return fail(
        "ACTION_ACTUATOR_KIND_MISMATCH",
        `${action.type} must target the canonical state-bearing element, not its label, wrapper, or activation member.`,
        checks
      );
    }
    const controlKind = String(control.kind || control.controlKind || "").toLowerCase();
    const controlRole = String(control.role || control.domRole || "").toLowerCase();
    const typeCompatible = controlKind === "field"
      || ["text", "email", "tel", "number", "password", "search", "url", "textarea"].includes(controlKind)
      || ["textbox", "searchbox", "spinbutton", "editable_combobox"].includes(controlRole);
    const selectCompatible = controlKind === "select" || ["combobox", "listbox", "select"].includes(controlRole);
    if (action.type === "type" && !typeCompatible) {
      return fail("ACTION_ACTUATOR_KIND_MISMATCH", "Type actions require an editable canonical field.", checks);
    }
    if (action.type === "select" && !selectCompatible) {
      return fail("ACTION_ACTUATOR_KIND_MISMATCH", "Select actions require a canonical select control.", checks);
    }
  }
  const state = control.state || {};
  if (
    (state.disabled === true || control.disabled === true)
    && !operationUsesExecutableActuator
  ) {
    return fail("TARGET_DISABLED", "The canonical target was observed as disabled.", checks);
  }
  // Geometry belongs to the exact actuator, not necessarily to the logical
  // state element. Composite selects commonly keep a hidden/disabled input
  // while exposing a visible trigger. Falling back to the logical control
  // first incorrectly converts a current trigger click into viewport work.
  const region = target.visualRegion || target.box || control.visualRegion;
  if (region?.inViewport === false) return recoverable("TARGET_OUT_OF_VIEW", "The canonical target is outside the observed viewport and can be recovered by governed scrolling.", checks);
  if (!controlBelongsToCurrentSurface(control, observation.page || {}) && !authorizedParentSurfaceExit) {
    return recoverable("TARGET_OUTSIDE_CURRENT_SURFACE", "The selected control does not belong to the authoritative current surface.", checks);
  }
  pass(checks, "CANONICAL_TARGET_CURRENT", control.controlId);
  return null;
}

function validateVisualFallback(action, observation, checks) {
  if (action.type !== "click_xy") return null;
  const target = action.targetSnapshot || {};
  const region = action.visualRegion || target.visualRegion;
  const controlledRecovery = target.source === "visual_control_recovery";
  if (!["visual_fallback", "visual_control_recovery"].includes(target.source) || !region) {
    return fail("VISUAL_REGION_REQUIRED", "A coordinate action requires an observation-bound visual fallback region.", checks);
  }
  if (action.controlId || target.controlId) {
    if (!controlledRecovery) {
      return fail("COORDINATE_CANONICAL_BYPASS", "A known DOM control may use coordinates only through its explicit visual-recovery contract.", checks);
    }
    const resolution = resolveActionControl(action, observation.page || {});
    const control = resolution.control;
    const recovery = control?.recovery?.[action.operation || target.recoveryOperation || ""];
    const regionMatches = (recovery?.regions || []).some((candidate) => visualRegionsMatch(candidate, region));
    if (!resolution.ok || !recovery || !regionMatches || recovery.requiresVisualConfirmation !== true) {
      return fail("VISUAL_CONTROL_RECOVERY_UNPROVEN", "The coordinate is not one of the current canonical control's bounded visual recovery regions.", checks);
    }
    const canonicalRegion = normalizeVisualRegion(region);
    if (canonicalRegion.observationId && canonicalRegion.observationId !== action.observationId) {
      return fail("VISUAL_OBSERVATION_MISMATCH", "The bounded visual region belongs to a different observation.", checks);
    }
    if (canonicalRegion.controlId && canonicalRegion.controlId !== control.controlId) {
      return fail("VISUAL_CONTROL_MISMATCH", "The bounded visual region belongs to a different logical control.", checks);
    }
    if (canonicalRegion.operation && canonicalRegion.operation !== action.operation) {
      return fail("VISUAL_OPERATION_MISMATCH", "The bounded visual region belongs to a different control operation.", checks);
    }
    pass(checks, "VISUAL_CONTROL_RECOVERY_BOUND", `${control.controlId}:${action.operation}`);
  }
  const x = number(action.x);
  const y = number(action.y);
  const rx = number(region.x);
  const ry = number(region.y);
  const width = number(region.width);
  const height = number(region.height);
  if ([x, y, rx, ry, width, height].some((value) => value == null) || width < 4 || height < 4) {
    return fail("VISUAL_REGION_INVALID", "The visual fallback region is missing usable geometry.", checks);
  }
  if (x < rx || x > rx + width || y < ry || y > ry + height) {
    return fail("VISUAL_POINT_OUTSIDE_REGION", "The coordinate is outside its governed visual region.", checks);
  }
  const viewport = observation.page?.viewport || {};
  const viewportWidth = number(region.viewportWidth || viewport.width);
  const viewportHeight = number(region.viewportHeight || viewport.height);
  if (!viewportWidth || !viewportHeight || x < 0 || y < 0 || x > viewportWidth || y > viewportHeight) {
    return fail("VISUAL_POINT_OUTSIDE_VIEWPORT", "The visual coordinate is outside the observed viewport.", checks);
  }
  if (region.viewportWidth && viewport.width && Number(region.viewportWidth) !== Number(viewport.width)) {
    return fail("VISUAL_VIEWPORT_CHANGED", "Viewport width changed after the visual action was planned.", checks);
  }
  if (region.viewportHeight && viewport.height && Number(region.viewportHeight) !== Number(viewport.height)) {
    return fail("VISUAL_VIEWPORT_CHANGED", "Viewport height changed after the visual action was planned.", checks);
  }
  const expectedSurface = currentSurfaceId(observation.page || {});
  const regionSurface = region.surfaceId || (currentSurface(observation.page || {}).type === "page" ? PAGE_SURFACE_ID : "");
  if (expectedSurface && regionSurface !== expectedSurface) {
    return fail("VISUAL_SURFACE_MISMATCH", "The visual region does not belong to the current foreground surface.", checks);
  }
  if (action.risk !== "safe") return fail("VISUAL_RISK_UNAPPROVED", "Coordinate actions must be explicitly classified safe before execution.", checks);
  pass(checks, "VISUAL_FALLBACK_BOUND");
  return null;
}

function governAction({
  action: rawAction,
  state: rawState,
  observation,
  traveler = {},
  approvals = {},
  store,
  turnId = "",
  preparedInvariantContext = null,
  preparedCandidateSet = null
}) {
  const checks = [];
  const action = normalizeAction(rawAction || {});
  const preparedContextCurrent = Boolean(
    preparedInvariantContext?.envelope
    && preparedInvariantContext?.observation?.observationId === observation?.observationId
    && (
      !observation?.observationSnapshot?.snapshotHash
      || preparedInvariantContext.observation?.observationSnapshot?.snapshotHash
        === observation.observationSnapshot.snapshotHash
    )
  );
  const invariantContext = preparedContextCurrent ? preparedInvariantContext : null;
  let state = preparedContextCurrent
    ? {
        ...rawState,
        transactionInvariants: invariantContext.state?.transactionInvariants
          || rawState.transactionInvariants
      }
    : rawState;
  const record = (stage, payload = {}) => store?.recordActionEvent?.(state.id, {
    actionId: action.id || "",
    observationId: action.observationId || observation?.observationId || "",
    turnId,
    stage,
    action,
    ...payload
  });
  const denied = (result) => {
    state = stateWithExecutionEpisode(
      state,
      rejectActionLifecycle(executionEpisodeFor(state), result)
    );
    record("blocked", { result: { ok: false, code: result.code, reason: result.reason, checks: result.checks || checks } });
    return { ...result, state };
  };
  record("proposed", { result: { ok: null } });
  state = stateWithExecutionEpisode(state, proposeActionLifecycle(action, observation));
  if (!preparedContextCurrent) {
    return denied({
      ...fail(
        "GOVERNANCE_CONTEXT_REQUIRED",
        "The governor requires transaction facts prepared for this exact immutable observation.",
        checks
      ),
      action,
      state
    });
  }
  if (!action.id || !action.observationId || !action.observationHash) {
    return denied({ ...fail("ACTION_IDENTITY_MISSING", "Action id, observation id, and observation hash are required.", checks), action, state });
  }
  pass(checks, "ACTION_SCHEMA_VALID");

  if (!store?.isCurrentObservation(state.id, action.observationId, action.observationHash)) {
    return denied({
      ...recoverable(
        "STALE_OBSERVATION",
        "The proposed action is not bound to the stored current observation. Capture one fresh observation and attempt a stable semantic rebind.",
        checks
      ),
      action,
      state
    });
  }
  pass(checks, "OBSERVATION_CURRENT");

  const graphConflicts = classifyGraphConflicts(observation.page || {});
  const selectedConflicts = selectedActionGraphConflicts(action, observation.page || {});
  if (selectedConflicts.length) {
    return denied({
      ...recoverable(
        "CONTROL_GRAPH_SELECTED_ACTION_AMBIGUOUS",
        "The selected candidate's canonical control or actuator has ambiguous ownership in the current observation.",
        checks
      ),
      action,
      state,
      conflicts: selectedConflicts.slice(0, 8)
    });
  }
  pass(
    checks,
    "SELECTED_CONTROL_GRAPH_VALID",
    `${graphConflicts.actionable.length} unrelated actionable conflict(s); ${graphConflicts.diagnostic.length} diagnostic conflict(s) preserved`
  );

  const goalCandidateFailure = currentWorkCandidateFailure(
    action,
    state,
    observation,
    checks,
    preparedCandidateSet
  );
  if (goalCandidateFailure) {
    return denied({
      ...goalCandidateFailure,
      action,
      state
    });
  }
  const goalOwnershipFailure = currentWorkOwnershipFailure(action, state, observation.page || {}, checks);
  if (goalOwnershipFailure) {
    return denied({
      ...goalOwnershipFailure,
      action,
      state
    });
  }
  const discoveryFailure = preSurfaceDiscoveryFailure(action, state, observation, checks);
  if (discoveryFailure) {
    return denied({
      ...discoveryFailure,
      action,
      state
    });
  }
  pass(checks, "SEMANTIC_GOAL_SEQUENCE_VALID");

  let executionLane = "";
  if ((DOM_MUTATIONS.has(action.type) || action.type === "click_xy") && action.candidateId) {
    const pipeline = action.pipelineContract || null;
    if (!pipeline || pipeline.contractVersion !== agentContract.CONTRACT_VERSION) {
      return denied({
        ...recoverable(
          "CANONICAL_PIPELINE_CONTRACT_MISSING",
          "The selected candidate lost its authoritative requirement/component/capability contract before governance.",
          checks
        ),
        action,
        state
      });
    }
    const control = canonicalControlForAction(action, observation.page || {}) || {};
    const strategyAlreadyFailed = new Set(recoveryFacts(state).failedStrategySignatures || [])
      .has(actuatorSignature(action));
    executionLane = agentContract.classifyExecutionLane({
      action,
      pipelineContract: pipeline,
      control,
      observation,
      strategyAlreadyFailed
    });
    if (executionLane === agentContract.EXECUTION_LANE.REVEAL) {
      return denied({
        ...recoverable(
          "TARGET_OUT_OF_VIEW",
          "The bound capability is revealable but is not yet proven executable in the current viewport.",
          checks
        ),
        action,
        state
      });
    }
    if (executionLane === agentContract.EXECUTION_LANE.DENY) {
      return denied({
        ...recoverable(
          strategyAlreadyFailed ? "FAILED_STRATEGY_REUSE" : "CAPABILITY_EXECUTION_LANE_DENIED",
          strategyAlreadyFailed
            ? "The exact strategy already failed on the unchanged target-local state."
            : "The action is neither a proven exact capability nor a current bounded-recovery strategy.",
          checks
        ),
        action,
        state
      });
    }
    pass(checks, "EXECUTION_LANE_CLASSIFIED", executionLane);
  }

  if (DOM_MUTATIONS.has(action.type) || action.type === "click_xy") {
    const goal = taskMechanics(state.taskState || {});
    const contract = (goal?.successCondition) || outcomeContractForGoal(goal, observation);
    const parentContract = contract;
    const explicitMechanicalEffect = action.mechanicalEffect || action.affordance?.mechanicalEffect || action.affordance?.physicalEffect || action.affordance?.effect || "";
    const mechanicalEffect = explicitMechanicalEffect || predictPhysicalEffect({
      semantics: normalizedActionSemantics(action, { control: action.targetSnapshot || {}, goal, expectedOutcome: action.expectedOutcome }),
      control: action.targetSnapshot || {},
      candidate: action,
      goal
    });
    const semanticIntent = action.intent || semanticIntentForAction({
      mechanicalEffect,
      control: action.targetSnapshot || {},
      candidate: action,
      goal,
      observation
    });
    const expectedPostconditions = action.expectedPostconditions?.length
      ? action.expectedPostconditions
      : expectedPostconditionsForAction({ expectedOutcome: action.expectedOutcome, semanticIntent, mechanicalEffect, goal });
    const compatibility = assessOutcomeCompatibility({
      goal,
      durableObjective: parentContract,
      mechanicalEffect,
      semanticIntent,
      expectedPostconditions,
      candidate: action,
      control: action.targetSnapshot || {},
      observation
    });
    // Compatibility is planner guidance and trace evidence, not click
    // authority. Grounding, actionability, policy and approval checks below
    // remain hard gates even when semantic classification is unknown.
    pass(checks, "OUTCOME_COMPATIBILITY_DIAGNOSTIC",
      `${compatibility.status}:${compatibility.reason}:${parentContract.taskOutcome}/${contract.taskOutcome}:${mechanicalEffect}:${semanticIntent}`);
  }

  // TaskState has already admitted exactly one CurrentObligation. The
  // governor verifies that action's exact binding and consequences; it does
  // not independently reconstruct profile-stage completeness.
  pass(checks, "TASK_STATE_OBLIGATION_ALREADY_ADMITTED");

  const targetFailure = validateCanonicalTarget(action, observation, checks, executionLane)
    || validateVisualFallback(action, observation, checks);
  if (targetFailure) {
    const routedFailure = RECOVERABLE_GROUNDING_CODES.has(targetFailure.code)
      ? { ...targetFailure, decision: "recoverable" }
      : targetFailure;
    return denied({ ...routedFailure, action, state });
  }
  if (COMPOUND_MUTATIONS.has(action.type)) {
    return denied({ ...fail("UNEXPANDED_COMPOUND_ACTION", "Mutating skills must expand to one canonical atomic action before governance.", checks), action, state });
  }
  if (!["ask_user", "stop", "wait", "scroll", "save_trip", "final_review"].includes(action.type)
    && (!action.expectedOutcome || !action.expectedOutcome.type)) {
    return denied({ ...fail("EXPECTED_OUTCOME_REQUIRED", "Every executable action must carry its governed postcondition before dispatch.", checks), action, state });
  }
  const foreground = currentSurface(observation.page || {});
  const exactForegroundChoice = action.expectedOutcome?.type === "exact_free_option_selected"
    && Boolean(action.expectedOutcome?.expectedSelectedControlId || action.expectedOutcome?.controlId)
    && Boolean(action.expectedOutcome?.decisionGroupId || action.decisionGroupId);
  if (action.intent === "decline_optional_extra" && foreground.type !== "page"
    && action.expectedOutcome?.type !== "active_surface_dismissed"
    && !exactForegroundChoice) {
    return denied({ ...fail("FOREGROUND_POSTCONDITION_REQUIRED", "A foreground decline must prove the exact free choice or the exact surface dismissal; generic command acknowledgement is not completion evidence.", checks), action, state });
  }
  pass(checks, "EXPECTED_OUTCOME_BOUND", action.expectedOutcome?.type || "control-flow");

  const policy = evaluateActionPolicy(action, state, traveler, approvals);
  if (!policy.allow) {
    const decision = policy.decision === "ask_user" ? "requires_user" : "blocked_by_policy";
    return denied({ ...fail("POLICY_BLOCKED", policy.reason, checks, decision), action, state, policy });
  }
  const governedMechanicalEffect = String(
    action.mechanicalEffect
    || action.affordance?.mechanicalEffect
    || action.affordance?.physicalEffect
    || action.affordance?.effect
    || ""
  ).toLowerCase();
  if (governedMechanicalEffect === "select_paid_option" && !policy.authorization?.authorizationId) {
    return denied({
      ...fail(
        "UNAPPROVED_PAID_EFFECT",
        "A typed paid-option effect requires one explicit bounded authorization before browser dispatch.",
        checks
      ),
      action,
      state,
      policy
    });
  }
  pass(checks, "POLICY_ALLOWED", policy.reason);

  const invariants = invariantDecision(invariantContext, action, state);
  checks.push(...(invariants.checks || []));
  if (!invariants.allow) return denied({ ...invariants, checks, action, state, policy });

  if (!isNonMutatingAction(action)) {
    const reservation = store.reserveGovernedAction({
      transactionId: state.id,
      turnId,
      action,
      observationId: action.observationId,
      observationHash: action.observationHash
    });
    if (!reservation.ok) return denied({ ...fail(reservation.code, reservation.reason, checks), action, state, policy });
    pass(checks, "DUPLICATE_ACTION_GUARD", reservation.signature);
  }

  state = stateWithExecutionEpisode(
    state,
    approveActionLifecycle(executionEpisodeFor(state))
  );
  record("governed", { result: { ok: true, code: "ALLOWED", checks } });
  return {
    allow: true,
    decision: "allowed",
    code: "ALLOWED",
    reason: policy.reason,
    checks,
    action,
    state,
    policy,
    governorDecisionId: `governor:${action.id}:${observation.observationId}:${policy.authorization?.authorizationId || "routine"}`
  };
}

module.exports = {
  governAction,
  __private: {
    canonicalControlForAction,
    canonicalActionSurfaceId,
    currentWorkCandidateFailure,
    currentObservationSurfaceId,
    currentWorkOwnershipFailure,
    preSurfaceDiscoveryFailure,
    validateCanonicalTarget,
    validateVisualFallback
  },
  RECOVERABLE_GROUNDING_CODES
};
