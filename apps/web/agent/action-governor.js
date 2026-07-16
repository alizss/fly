const { evaluateActionPolicy, isNonMutatingAction } = require("../../../packages/shared/policy");
const { normalizeAction, actuatorSignature } = require("../../../packages/shared/agent-actions");
const { withUpdate } = require("../../../packages/shared/agent-state");
const { resolveActionControl } = require("./control-alias-index");
const { currentProfileSkillAtom, profileStageReadiness } = require("./skill-expander");

const DOM_MUTATIONS = new Set(["click", "type", "select"]);
const COMPOUND_MUTATIONS = new Set(["fill_known_fields", "fill_visible_profile_fields"]);

function fail(code, reason, checks = [], decision = "blocked_by_safety") {
  return { allow: false, decision, code, reason, checks: [...checks, { code, ok: false }] };
}

function recoverable(code, reason, checks = []) {
  return fail(code, reason, checks, "recoverable");
}

function pass(checks, code, detail = "") {
  checks.push({ code, ok: true, detail });
}

function text(value) {
  return String(value || "").trim();
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function priceSnapshot(page = {}) {
  const structured = page.price && typeof page.price === "object" ? page.price : {};
  let amount = number(structured.amount ?? structured.total ?? structured.value);
  if (amount == null) {
    const match = text(page.priceText).match(/([0-9]+(?:[.,][0-9]{1,2})?)/);
    amount = match ? Number(match[1].replace(",", ".")) : null;
  }
  const currency = text(structured.currency || (text(page.priceText).match(/\b(EUR|USD|GBP|CHF|CAD|AUD)\b|[€$£]/i)?.[0] || "")).toUpperCase();
  return { amount, currency };
}

function transactionFacts(state = {}, observation = {}, traveler = {}) {
  const page = observation.page || {};
  const summary = page.summary && typeof page.summary === "object" ? page.summary : {};
  const price = priceSnapshot(page);
  return {
    travelerIds: [traveler.id || state.travelerId].filter(Boolean).map(String).sort(),
    itineraryFingerprint: text(page.itineraryFingerprint || summary.itineraryFingerprint || state.itineraryFingerprint),
    offerFingerprint: text(page.offerFingerprint || summary.offerFingerprint || state.offerFingerprint),
    priceAmount: price.amount,
    currency: price.currency
  };
}

function establishInvariantBaseline(state, observation, traveler) {
  const current = transactionFacts(state, observation, traveler);
  if (!state.invariantBaseline) return withUpdate(state, { invariantBaseline: current });
  const baseline = { ...state.invariantBaseline };
  let changed = false;
  for (const field of ["travelerIds", "itineraryFingerprint", "offerFingerprint", "priceAmount", "currency"]) {
    const missing = field === "travelerIds"
      ? !Array.isArray(baseline[field]) || baseline[field].length === 0
      : baseline[field] == null || baseline[field] === "";
    const available = field === "travelerIds"
      ? Array.isArray(current[field]) && current[field].length > 0
      : current[field] != null && current[field] !== "";
    if (missing && available) {
      baseline[field] = current[field];
      changed = true;
    }
  }
  return changed ? withUpdate(state, { invariantBaseline: baseline }) : state;
}

function compareInvariantBaseline(state, observation, traveler, action, checks) {
  const baseline = state.invariantBaseline || {};
  const current = transactionFacts(state, observation, traveler);
  const baselineTravelers = JSON.stringify(baseline.travelerIds || []);
  const currentTravelers = JSON.stringify(current.travelerIds || []);
  if (baselineTravelers !== currentTravelers) return fail("TRAVELER_SET_CHANGED", "The traveler set changed after this checkout transaction began.", checks);
  pass(checks, "TRAVELER_SET_STABLE");

  for (const [field, code] of [["itineraryFingerprint", "ITINERARY_CHANGED"], ["offerFingerprint", "OFFER_CHANGED"], ["currency", "CURRENCY_CHANGED"]]) {
    if (baseline[field] && current[field] && baseline[field] !== current[field]) {
      return fail(code, `${field} no longer matches the approved transaction baseline.`, checks);
    }
    pass(checks, `${field.toUpperCase()}_STABLE`, baseline[field] && current[field] ? current[field] : "not-yet-observed");
  }

  if (baseline.priceAmount != null && current.priceAmount != null && current.priceAmount > baseline.priceAmount) {
    const authorization = state.approvals?.priceAuthorization;
    const approvedMaximum = number(authorization?.maximumAmount);
    if (!authorization?.authorizationId || approvedMaximum == null || current.priceAmount > approvedMaximum) {
      return fail("UNAPPROVED_PRICE_CHANGE", `Price increased from ${baseline.priceAmount} to ${current.priceAmount} without a bound price authorization.`, checks);
    }
  }
  pass(checks, "PRICE_WITHIN_AUTHORIZATION");

  const paymentLike = action.risk === "payment" || action.type === "final_review" || /payment|purchase|book_now/.test(`${action.intent || ""} ${action.targetSnapshot?.semantic || ""}`);
  if (paymentLike) {
    const authorization = state.approvals?.paymentAuthorization;
    if (!authorization?.authorizationId || authorization.transactionId !== state.id || authorization.singleUse !== true) {
      return fail("PAYMENT_AUTHORIZATION_MISSING", "Payment requires a one-time authorization bound to this exact transaction and offer.", checks);
    }
    if (authorization.offerFingerprint && current.offerFingerprint && authorization.offerFingerprint !== current.offerFingerprint) {
      return fail("PAYMENT_OFFER_CHANGED", "The payment authorization does not match the current offer.", checks);
    }
    if (state.paymentState?.attempts > 0 || state.paymentState?.status === "submitted") {
      return fail("DUPLICATE_PAYMENT_ATTEMPT", "A payment attempt has already been recorded for this transaction.", checks);
    }
  }
  pass(checks, "PAYMENT_GUARD");
  return null;
}

function canonicalControlForAction(action, page = {}) {
  return resolveActionControl(action, page).control || null;
}

function incompleteProfileSkillBlocks(action = {}, state = {}, page = {}) {
  const plan = state.activeSkillPlan;
  if (!plan || !COMPOUND_MUTATIONS.has(plan.skillType) || plan.status === "complete") return false;
  if (["satisfy_field", "open_profile_choice"].includes(action.intent)) return false;
  if (!DOM_MUTATIONS.has(action.type)) return false;
  const control = canonicalControlForAction(action, page) || {};
  const section = String(control.sectionType || "").toLowerCase();
  const semantic = String(control.semantic || action.intent || "").toLowerCase();
  return /baggage|bundle|extra|seat|cancellation|insurance|flexible|continue|navigation/.test(`${section} ${semantic}`)
    || action.intent === "navigate_stage";
}

function profileSkillDependencyFailure(action = {}, state = {}, page = {}, checks = []) {
  const plan = state.activeSkillPlan;
  if (!plan || !COMPOUND_MUTATIONS.has(plan.skillType) || plan.status === "complete" || !DOM_MUTATIONS.has(action.type) && action.type !== "click_xy") {
    return null;
  }
  const atom = currentProfileSkillAtom(plan);
  if (!atom) {
    return incompleteProfileSkillBlocks(action, state, page)
      ? fail("PROFILE_SKILL_INCOMPLETE", "Traveler profile work remains incomplete and later checkout work cannot bypass it.", checks)
      : null;
  }
  const exactOwner = action.skillPlanId === plan.planId && action.skillAtomId === atom.atomId;
  if (exactOwner) {
    pass(checks, "PROFILE_ATOM_OWNS_ACTION", atom.atomId);
    return null;
  }
  const control = canonicalControlForAction(action, page) || {};
  return fail(
    "PROFILE_ATOM_DEPENDENCY",
    `The unresolved ${atom.label || atom.semanticType} prerequisite owns the next profile action; ${control.label || action.targetLabel || action.intent || action.type} cannot bypass it.`,
    checks
  );
}

function blockedObligationFailure(action = {}, state = {}, checks = []) {
  const obligation = state.blockedObligation;
  if (!obligation || !["blocked", "recovering"].includes(obligation.status)) return null;
  if (!DOM_MUTATIONS.has(action.type) && action.type !== "click_xy") return null;
  const expected = obligation.recoveryExpectedOutcome || {};
  const exact = action.skillPlanId === obligation.owner?.skillPlanId
    && action.skillAtomId === obligation.owner?.atomId
    && action.controlId === obligation.control?.controlId
    && action.operation === obligation.operation
    && action.expectedOutcome?.type === expected.type
    && String(action.expectedOutcome?.controlId || "") === String(expected.controlId || "");
  if (!exact) {
    return fail(
      "BLOCKED_OBLIGATION_MISMATCH",
      "The executable action does not exactly match the persisted blocked obligation owner, control, operation, and expected outcome.",
      checks
    );
  }
  pass(checks, "BLOCKED_OBLIGATION_EXACT", obligation.obligationId || "");
  return null;
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

function incompleteProfileStageBlocks(action = {}, observation = {}, traveler = {}) {
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
    const controlRole = String(control.role || "").toLowerCase();
    const typeCompatible = controlKind === "field"
      || ["text", "email", "tel", "number", "password", "search", "url", "textarea"].includes(controlKind)
      || ["textbox", "searchbox", "spinbutton"].includes(controlRole);
    const selectCompatible = controlKind === "select" || ["combobox", "listbox"].includes(controlRole);
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
  const foreground = observation.page?.foreground || {};
  if (foreground.active && foreground.blocksBackground !== false && control.surfaceId && foreground.id && control.surfaceId !== foreground.id) {
    return fail("TARGET_OUTSIDE_FOREGROUND", "A blocking foreground surface owns the next action.", checks);
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
    const regionMatches = (recovery?.regions || []).some((candidate) => (
      Math.abs(Number(candidate.x) - Number(region.x)) <= 2
      && Math.abs(Number(candidate.y) - Number(region.y)) <= 2
      && Math.abs(Number(candidate.width) - Number(region.width)) <= 2
      && Math.abs(Number(candidate.height) - Number(region.height)) <= 2
    ));
    if (!resolution.ok || !recovery || !regionMatches || recovery.requiresVisualConfirmation !== true) {
      return fail("VISUAL_CONTROL_RECOVERY_UNPROVEN", "The coordinate is not one of the current canonical control's bounded visual recovery regions.", checks);
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
  const foreground = observation.page?.foreground || {};
  const expectedSurface = foreground.active ? foreground.id : "";
  if (expectedSurface && region.surfaceId !== expectedSurface) {
    return fail("VISUAL_SURFACE_MISMATCH", "The visual region does not belong to the current foreground surface.", checks);
  }
  if (action.risk !== "safe") return fail("VISUAL_RISK_UNAPPROVED", "Coordinate actions must be explicitly classified safe before execution.", checks);
  pass(checks, "VISUAL_FALLBACK_BOUND");
  return null;
}

function governAction({ action: rawAction, state: rawState, observation, traveler = {}, approvals = {}, store, turnId = "" }) {
  const checks = [];
  const action = normalizeAction(rawAction || {});
  let state = establishInvariantBaseline(rawState, observation, traveler);
  const record = (stage, payload = {}) => store?.recordActionEvent?.(state.id, {
    actionId: action.id || "",
    observationId: action.observationId || observation?.observationId || "",
    turnId,
    stage,
    action,
    ...payload
  });
  const denied = (result) => {
    record("blocked", { result: { ok: false, code: result.code, reason: result.reason, checks: result.checks || checks } });
    return result;
  };
  record("proposed", { result: { ok: null } });
  if (!action.id || !action.observationId || !action.observationHash) {
    return denied({ ...fail("ACTION_IDENTITY_MISSING", "Action id, observation id, and observation hash are required.", checks), action, state });
  }
  pass(checks, "ACTION_SCHEMA_VALID");

  if (!store?.isCurrentObservation(state.id, action.observationId, action.observationHash)) {
    return denied({ ...fail("STALE_OBSERVATION", "The proposed action is not bound to the stored current observation.", checks), action, state });
  }
  pass(checks, "OBSERVATION_CURRENT");

  const graphIntegrity = observation.page?.graphIntegrity;
  if (graphIntegrity && graphIntegrity.ok === false) {
    return denied({ ...fail("CONTROL_GRAPH_INVALID", "The current observation has unresolved actionable control ownership conflicts.", checks), action, state });
  }
  pass(checks, "CONTROL_GRAPH_VALID");

  const obligationFailure = blockedObligationFailure(action, state, checks);
  if (obligationFailure) {
    return denied({
      ...obligationFailure,
      action,
      state
    });
  }

  const profileDependencyFailure = profileSkillDependencyFailure(action, state, observation.page || {}, checks);
  if (profileDependencyFailure) {
    return denied({
      ...profileDependencyFailure,
      action,
      state
    });
  }
  pass(checks, "PROFILE_SKILL_SEQUENCE_VALID");

  const profileReadiness = incompleteProfileStageBlocks(action, observation, traveler);
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
  if (targetFailure) return denied({ ...targetFailure, action, state });
  if (DOM_MUTATIONS.has(action.type) || action.type === "click_xy") {
    const signature = actuatorSignature(action);
    const previousFailure = (state.failures || []).find((failure) => failure.actuatorSignature === signature);
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
  const foreground = observation.page?.foreground || {};
  if (action.intent === "decline_optional_extra" && foreground.active
    && action.expectedOutcome?.type !== "active_surface_dismissed") {
    return denied({ ...fail("FOREGROUND_POSTCONDITION_REQUIRED", "A foreground decline must prove that the exact active surface was dismissed.", checks), action, state });
  }
  pass(checks, "EXPECTED_OUTCOME_BOUND", action.expectedOutcome?.type || "control-flow");

  const policy = evaluateActionPolicy(action, state, traveler, approvals);
  if (!policy.allow) {
    const decision = policy.decision === "ask_user" ? "requires_user" : "blocked_by_policy";
    return denied({ ...fail("POLICY_BLOCKED", policy.reason, checks, decision), action, state, policy });
  }
  pass(checks, "POLICY_ALLOWED", policy.reason);

  const invariantFailure = compareInvariantBaseline(state, observation, traveler, action, checks);
  if (invariantFailure) return denied({ ...invariantFailure, action, state, policy });

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

  record("governed", { result: { ok: true, code: "ALLOWED", checks } });
  return { allow: true, decision: "allowed", code: "ALLOWED", reason: policy.reason, checks, action, state, policy };
}

module.exports = {
  governAction,
  __private: {
    canonicalControlForAction,
    compareInvariantBaseline,
    establishInvariantBaseline,
    incompleteProfileSkillBlocks,
    blockedObligationFailure,
    profileSkillDependencyFailure,
    incompleteProfileStageBlocks,
    actionTargetsLaterCheckoutWork,
    priceSnapshot,
    transactionFacts,
    validateCanonicalTarget,
    validateVisualFallback
  }
};
