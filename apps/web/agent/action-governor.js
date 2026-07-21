const { evaluateActionPolicy, isNonMutatingAction } = require("../../../packages/shared/policy");
const { isDeepStrictEqual } = require("node:util");
const {
  normalizeAction,
  normalizeVisualRegion,
  visualRegionsMatch,
  actuatorSignature,
  semanticGoalKey
} = require("../../../packages/shared/agent-actions");
const { classifyGraphConflicts, resolveActionControl, selectedActionGraphConflicts } = require("./control-alias-index");
const { profileStageReadiness } = require("./skill-expander");
const { invariantDecision, prepareTransactionInvariants } = require("./invariants");
const { PAGE_SURFACE_ID, controlBelongsToCurrentSurface, currentSurface, currentSurfaceId } = require("./surface-contract");
const { approveActionLifecycle, proposeActionLifecycle, rejectActionLifecycle } = require("./action-lifecycle");
const {
  assessOutcomeCompatibility,
  expectedPostconditionsForAction,
  normalizedActionSemantics,
  outcomeContractForGoal,
  predictPhysicalEffect,
  semanticIntentForAction
} = require("./action-semantics");

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

function currentObservationSurfaceId(observation = {}) {
  return currentSurfaceId(observation.page || {});
}

function currentGoalCandidateFailure(action = {}, state = {}, observation = {}, checks = []) {
  const goal = state.taskState?.currentGoal;
  if (!goal?.goalId || (!DOM_MUTATIONS.has(action.type) && action.type !== "click_xy")) return null;
  // An action with no candidate claim is an ownership violation. Let the
  // ownership check below report that precise prerequisite error; candidate
  // exactness applies once a candidateId is actually presented.
  if (!action.candidateId) return null;
  const candidateSet = goal.candidateSet || null;
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
  const candidates = candidateSet?.candidates || goal.candidates || [];
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
    && action.goalId === goal.goalId
    && candidate.type === action.type
    && candidate.operation === action.operation
    && candidate.controlId === action.controlId
    && String(candidate.targetId || "") === String(action.targetId || "")
    && (!["type", "select"].includes(action.type) || String(candidate.value || "") === String(action.value || ""))
    && (action.type !== "keypress" || String(candidate.keys || "") === String(action.keys || ""))
    && (action.type !== "click_xy" || visualRegionsMatch(candidate.visualRegion || {}, action.visualRegion || {}))
    && action.interactionRole === candidate.interactionRole
    && action.semanticEffect === candidate.semanticEffect
    && action.expectedEvidence === candidate.expectedEvidence
    && affordanceExact
    && action.expectedOutcome?.type === candidate.expectedOutcome?.type
    && String(action.expectedOutcome?.controlId || "") === String(candidate.expectedOutcome?.controlId || "");
  if (!exact) {
    return recoverable(
      "CURRENT_GOAL_CANDIDATE_MISMATCH",
      "The executable action is not the server-grounded candidate selected for the current semantic goal.",
      checks
    );
  }
  pass(checks, "CURRENT_GOAL_CANDIDATE_EXACT", candidate.candidateId);
  return null;
}

function currentGoalOwnershipFailure(action = {}, state = {}, page = {}, checks = []) {
  const goal = state.taskState?.currentGoal;
  if (!goal?.goalId || (!DOM_MUTATIONS.has(action.type) && action.type !== "click_xy")) return null;
  if (action.candidateId && action.goalId === goal.goalId) return null;
  const control = canonicalControlForAction(action, page) || {};
  return fail(
    "CURRENT_GOAL_UNRESOLVED",
    `The current semantic goal ${goal.label || goal.semanticType}=${goal.desiredValue} must complete or exhaust its finite recovery budget before ${control.label || action.targetLabel || action.intent || action.type}.`,
    checks
  );
}

function actionTargetsLaterCheckoutWork(action = {}, page = {}) {
  if (!DOM_MUTATIONS.has(action.type)) return false;
  if (["satisfy_field", "open_profile_choice"].includes(action.intent)) return false;
  const control = canonicalControlForAction(action, page) || {};
  const section = String(control.sectionType || "").toLowerCase();
  const semantic = String(control.semantic || action.intent || "").toLowerCase();
  return /baggage|bundle|extra|seat|cancellation|insurance|flexible|continue|navigation|payment|purchase/.test(`${section} ${semantic}`)
    || ["navigate_stage", "decline_optional_extra", "resolve_active_surface"].includes(action.intent);
}

function incompleteProfileStageBlocks(action = {}, observation = {}, traveler = {}, state = {}) {
  const taskState = state.taskState || null;
  if (taskState) {
    const ownsProfileGoal = taskState.stage === "traveler_information"
      && taskState.currentGoal?.kind === "profile_field";
    return ownsProfileGoal && actionTargetsLaterCheckoutWork(action, observation.page || {})
      ? (taskState.profileReadiness || { ready: false, unresolvedKnown: [], unresolvedRequired: [], visibleErrors: [] })
      : null;
  }
  // Migration-only fallback for persisted sessions created before TaskState.
  const readiness = profileStageReadiness(observation, traveler);
  return !readiness.ready && actionTargetsLaterCheckoutWork(action, observation.page || {})
    ? readiness
    : null;
}

function validateCanonicalTarget(action, observation, checks) {
  if (!DOM_MUTATIONS.has(action.type)) return null;
  const target = action.targetSnapshot || {};
  const resolution = resolveActionControl(action, observation.page || {});
  if (!resolution.ok) {
    return fail(resolution.code, "Every supplied target identity must resolve to the same canonical control in the stored observation.", checks);
  }
  const control = resolution.control;
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
  if (action.operation) {
    const capability = control.operations?.[action.operation];
    const operationIds = new Set(capability?.actuatorIds || []);
    if (!capability || !operationIds.has(target.id)) {
      return fail("ACTION_OPERATION_ACTUATOR_MISMATCH", `The canonical control does not authorize ${action.operation} through the governed actuator.`, checks);
    }
    pass(checks, "CANONICAL_OPERATION_BOUND", `${action.operation}:${target.id}`);
    const actionability = capability.actionabilityByActuator?.[target.id] || capability.actionability || null;
    if (!actionability || actionability.executable !== true) {
      if (actionability?.revealable === true && actionability.inViewport === false) {
        return recoverable(
          "TARGET_OUT_OF_VIEW",
          "The exact canonical actuator is rendered, enabled, surface-owned, and revealable, but must be brought into view before live hit-testing and dispatch.",
          checks
        );
      }
      return recoverable(
        "TARGET_ACTIONABILITY_UNPROVEN",
        "The exact canonical actuator was not proven rendered, visible, enabled, current-surface owned, hit-tested, and unoccluded in this observation.",
        checks
      );
    }
    pass(checks, "CANONICAL_ACTUATOR_ACTIONABLE", `${action.operation}:${target.id}`);
    const precondition = capability.precondition || {};
    if (precondition.expanded === false && control.state?.expanded === true) {
      return fail("OPERATION_PRECONDITION_FAILED", "The canonical control is already expanded, so its open operation is no longer valid.", checks);
    }
    if (precondition.disabled === false && control.state?.disabled === true) {
      return fail("OPERATION_PRECONDITION_FAILED", "The canonical operation requires an enabled control.", checks);
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
  if (state.disabled === true || control.disabled === true) return fail("TARGET_DISABLED", "The canonical target was observed as disabled.", checks);
  const region = control.visualRegion || target.visualRegion || target.box;
  if (region?.inViewport === false) return recoverable("TARGET_OUT_OF_VIEW", "The canonical target is outside the observed viewport and can be recovered by governed scrolling.", checks);
  if (!controlBelongsToCurrentSurface(control, observation.page || {})) {
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

function governAction({ action: rawAction, state: rawState, observation, traveler = {}, approvals = {}, store, turnId = "" }) {
  const checks = [];
  const action = normalizeAction(rawAction || {});
  const invariantContext = prepareTransactionInvariants(rawState, observation, traveler);
  let state = invariantContext.state;
  const record = (stage, payload = {}) => store?.recordActionEvent?.(state.id, {
    actionId: action.id || "",
    observationId: action.observationId || observation?.observationId || "",
    turnId,
    stage,
    action,
    ...payload
  });
  const denied = (result) => {
    state = { ...state, actionLifecycle: rejectActionLifecycle(state.actionLifecycle, result) };
    record("blocked", { result: { ok: false, code: result.code, reason: result.reason, checks: result.checks || checks } });
    return { ...result, state };
  };
  record("proposed", { result: { ok: null } });
  state = { ...state, actionLifecycle: proposeActionLifecycle(action, observation) };
  if (!action.id || !action.observationId || !action.observationHash) {
    return denied({ ...fail("ACTION_IDENTITY_MISSING", "Action id, observation id, and observation hash are required.", checks), action, state });
  }
  pass(checks, "ACTION_SCHEMA_VALID");

  if (!store?.isCurrentObservation(state.id, action.observationId, action.observationHash)) {
    return denied({ ...fail("STALE_OBSERVATION", "The proposed action is not bound to the stored current observation.", checks), action, state });
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

  const goalCandidateFailure = currentGoalCandidateFailure(action, state, observation, checks);
  if (goalCandidateFailure) {
    return denied({
      ...goalCandidateFailure,
      action,
      state
    });
  }
  const goalOwnershipFailure = currentGoalOwnershipFailure(action, state, observation.page || {}, checks);
  if (goalOwnershipFailure) {
    return denied({
      ...goalOwnershipFailure,
      action,
      state
    });
  }
  pass(checks, "SEMANTIC_GOAL_SEQUENCE_VALID");

  if (DOM_MUTATIONS.has(action.type) || action.type === "click_xy") {
    const goal = state.taskState?.currentGoal || {};
    const contract = goal.outcomeContract || outcomeContractForGoal(goal, observation);
    const parentContract = state.taskState?.stageOutcome?.outcomeContract || goal.parentOutcomeContract || contract;
    const explicitMechanicalEffect = action.mechanicalEffect || action.affordance?.mechanicalEffect || action.affordance?.physicalEffect || action.affordance?.effect || action.physicalEffect || "";
    const mechanicalEffect = explicitMechanicalEffect || predictPhysicalEffect({
      semantics: normalizedActionSemantics(action, { control: action.targetSnapshot || {}, goal, expectedOutcome: action.expectedOutcome }),
      control: action.targetSnapshot || {},
      candidate: action,
      goal
    });
    const semanticIntent = action.semanticIntent || semanticIntentForAction({
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

  const profileReadiness = incompleteProfileStageBlocks(action, observation, traveler, state);
  if (profileReadiness) {
    const blockers = [
      ...profileReadiness.unresolvedKnown.map((item) => item.label),
      ...profileReadiness.unresolvedRequired.map((item) => item.label),
      ...profileReadiness.visibleErrors
    ].filter(Boolean).slice(0, 5);
    return denied({
      ...fail(
        "PROFILE_STAGE_NOT_READY",
        `Traveler/contact readiness blocks later checkout work${blockers.length ? `: ${blockers.join("; ")}` : "."}`,
        checks
      ),
      action,
      state,
      profileReadiness
    });
  }
  pass(checks, "PROFILE_STAGE_READY_OR_ACTION_SCOPED");

  const targetFailure = validateCanonicalTarget(action, observation, checks) || validateVisualFallback(action, observation, checks);
  if (targetFailure) {
    const routedFailure = RECOVERABLE_GROUNDING_CODES.has(targetFailure.code)
      ? { ...targetFailure, decision: "recoverable" }
      : targetFailure;
    return denied({ ...routedFailure, action, state });
  }
  if (DOM_MUTATIONS.has(action.type) || action.type === "click_xy") {
    const signature = actuatorSignature(action);
    const goalKey = semanticGoalKey(action);
    const previousFailure = (state.failures || []).find((failure) => (
      failure.actuatorSignature === signature
      && (!failure.goalKey || failure.goalKey === goalKey)
    ));
    if (previousFailure) {
      return denied({
        ...fail(
          "FAILED_ACTUATOR_REUSE",
          `This exact actuator already failed verification in the current checkout session (${previousFailure.code || "OUTCOME_NOT_VERIFIED"}). Reobserve and choose another canonical actuator or stop.`,
          checks
        ),
        action,
        state,
        previousFailure
      });
    }
    pass(checks, "ACTUATOR_NOT_PREVIOUSLY_FAILED", signature);
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

  state = { ...state, actionLifecycle: approveActionLifecycle(state.actionLifecycle) };
  record("governed", { result: { ok: true, code: "ALLOWED", checks } });
  return { allow: true, decision: "allowed", code: "ALLOWED", reason: policy.reason, checks, action, state, policy };
}

module.exports = {
  governAction,
  __private: {
    canonicalControlForAction,
    currentGoalCandidateFailure,
    currentObservationSurfaceId,
    currentGoalOwnershipFailure,
    incompleteProfileStageBlocks,
    actionTargetsLaterCheckoutWork,
    validateCanonicalTarget,
    validateVisualFallback
  },
  RECOVERABLE_GROUNDING_CODES
};
