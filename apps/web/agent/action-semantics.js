const INTERACTION_ROLES = new Set(["choice", "command", "opener", "navigation", "field"]);
const SEMANTIC_EFFECTS = new Set(["select", "waive", "open", "advance", "set_value"]);
const EXPECTED_EVIDENCE = new Set(["selected", "dismissed", "options_appeared", "progress_changed", "value_changed", "target_visible"]);
const PHYSICAL_EFFECTS = new Set([
  "open_surface",
  "dismiss_surface",
  "select_free_option",
  "select_paid_option",
  "set_field_value",
  "advance_surface",
  "advance_checkout_stage",
  "accept_legal_terms",
  "enter_payment_credentials",
  "submit_purchase",
  "reveal_control",
  "unknown"
]);
const TASK_OUTCOMES = new Set([
  "profile_field_completed",
  "decision_resolved",
  "optional_extra_declined",
  "current_surface_completed",
  "checkout_stage_advanced",
  "payment_review_reached",
  "booking_confirmed"
]);
const OUTCOME_COMPATIBILITY = Object.freeze({
  COMPATIBLE: "compatible",
  CONTEXT_ONLY: "context_only",
  UNKNOWN: "unknown"
});

function normalized(value = "") {
  return String(value || "").trim().toLowerCase();
}

function normalizedOutcomeContract(contract = {}) {
  const taskOutcome = TASK_OUTCOMES.has(contract.taskOutcome)
    ? contract.taskOutcome
    : "current_surface_completed";
  const acceptablePhysicalEffects = [...new Set((contract.acceptablePhysicalEffects || [])
    .filter((effect) => PHYSICAL_EFFECTS.has(effect)))];
  return Object.freeze({
    outcomeId: String(contract.outcomeId || ""),
    taskOutcome,
    acceptablePhysicalEffects: Object.freeze(acceptablePhysicalEffects),
    completionEvidence: Object.freeze([...new Set((contract.completionEvidence || []).map(String).filter(Boolean))])
  });
}

function outcomeContractForGoal(goal = {}, observation = {}) {
  if (goal.outcomeContract?.taskOutcome) return normalizedOutcomeContract(goal.outcomeContract);
  const semantic = normalized(`${goal.kind || ""} ${goal.semanticType || ""} ${goal.semanticGoal || ""} ${goal.desiredValue || ""}`);
  const surface = observation.page?.currentSurface || observation.page?.activeSurface || {};
  const foreground = (surface.type || goal.surfaceType) && (surface.type || goal.surfaceType) !== "page";

  if (goal.kind === "profile_field" || /profile_field|traveler field|contact field/.test(semantic)) {
    return normalizedOutcomeContract({
      taskOutcome: "profile_field_completed",
      acceptablePhysicalEffects: ["set_field_value", "open_surface", "reveal_control"],
      completionEvidence: ["normalized_value_changed", "date_value_committed"]
    });
  }
  if (/payment_review|reach payment|review before payment/.test(semantic)) {
    return normalizedOutcomeContract({
      taskOutcome: "payment_review_reached",
      // These effects may advance an intermediate stage/surface, but only
      // fresh payment evidence completes this durable outcome.
      acceptablePhysicalEffects: ["open_surface", "dismiss_surface", "select_free_option", "set_field_value", "advance_surface", "advance_checkout_stage", "reveal_control"],
      completionEvidence: ["fresh_payment_stage", "payment_url", "payment_progress_marker", "payment_controls"]
    });
  }
  if (/booking_confirm|confirmation/.test(semantic)) {
    return normalizedOutcomeContract({
      taskOutcome: "booking_confirmed",
      acceptablePhysicalEffects: ["advance_checkout_stage", "submit_purchase", "reveal_control"],
      completionEvidence: ["fresh_confirmation_stage", "booking_reference"]
    });
  }
  if (normalized(goal.semanticType) === "navigation") {
    return normalizedOutcomeContract({
      taskOutcome: foreground ? "current_surface_completed" : "checkout_stage_advanced",
      acceptablePhysicalEffects: foreground ? ["advance_surface", "reveal_control"] : ["advance_checkout_stage", "reveal_control"],
      completionEvidence: foreground
        ? ["fresh_surface_progress", "fresh_surface_replacement"]
        : ["fresh_stage_change", "fresh_url_change", "fresh_progress_marker"]
    });
  }
  if (goal.decisionGroupId || /decision|seat|baggage|insurance|bundle|extra/.test(semantic)) {
    const decline = /selected_free_option|free_or_no_extra|decline|no paid|without/.test(semantic);
    return normalizedOutcomeContract({
      taskOutcome: decline ? "optional_extra_declined" : "decision_resolved",
      acceptablePhysicalEffects: decline
        ? ["select_free_option", "dismiss_surface", "advance_surface", "open_surface", "reveal_control"]
        : ["select_free_option", "select_paid_option", "dismiss_surface", "advance_surface", "open_surface", "reveal_control"],
      completionEvidence: ["exact_option_selected", "decision_group_resolved", "fresh_policy_waiver"]
    });
  }
  if (/surface_ambiguity|interpret.*surface|safe_progress/.test(semantic)) {
    return normalizedOutcomeContract({
      taskOutcome: "current_surface_completed",
      acceptablePhysicalEffects: ["open_surface", "dismiss_surface", "select_free_option", "set_field_value", "advance_surface", "advance_checkout_stage", "reveal_control"],
      completionEvidence: ["fresh_surface_state", "fresh_validation_state", "fresh_stage_state"]
    });
  }
  if (/navigation|continue|next_stage|advance/.test(semantic)) {
    return normalizedOutcomeContract({
      taskOutcome: foreground ? "current_surface_completed" : "checkout_stage_advanced",
      acceptablePhysicalEffects: foreground ? ["advance_surface", "reveal_control"] : ["advance_checkout_stage", "reveal_control"],
      completionEvidence: foreground
        ? ["fresh_surface_progress", "fresh_surface_replacement"]
        : ["fresh_stage_change", "fresh_url_change", "fresh_progress_marker"]
    });
  }
  return normalizedOutcomeContract({
    taskOutcome: "current_surface_completed",
    acceptablePhysicalEffects: ["open_surface", "dismiss_surface", "select_free_option", "set_field_value", "advance_surface", "advance_checkout_stage", "reveal_control"],
    completionEvidence: ["fresh_surface_state"]
  });
}

function effectCompatibleWithGoal(goalOrContract = {}, physicalEffect = "unknown", observation = {}) {
  const contract = goalOrContract.taskOutcome
    ? normalizedOutcomeContract(goalOrContract)
    : outcomeContractForGoal(goalOrContract, observation);
  return contract.acceptablePhysicalEffects.includes(physicalEffect);
}

function semanticIntentForAction({ mechanicalEffect = "unknown", control = {}, candidate = {}, goal = {}, observation = {} } = {}) {
  const surface = observation.page?.currentSurface || observation.page?.activeSurface || {};
  const declaredSurfaceClass = normalized(surface.surfaceClass || observation.page?.surfaceClass || "unknown");
  const surfaceText = normalized(surface.label || "");
  const surfaceClass = declaredSurfaceClass !== "unknown"
    ? declaredSurfaceClass
    : /review|verify|check your (details|information)/.test(surfaceText)
      ? "review_confirmation"
      : /warning|are you sure|continue without|not selected.*seat|without.*seat/.test(surfaceText)
        ? "warning"
        : "unknown";
  const text = normalized([
    candidate.targetLabel,
    candidate.semantic,
    control.label,
    control.semantic,
    control.testId,
    surface.label,
    goal.semanticGoal
  ].filter(Boolean).join(" "));
  if (/seat/.test(text) && /continue without|go without|not selected|skip seat|random seating/.test(text)
    && ["dismiss_surface", "advance_surface"].includes(mechanicalEffect)) return "confirm_continue_without_seats";
  if (surfaceClass === "review_confirmation" || /review your|check your (details|information)/.test(text)) {
    if (mechanicalEffect === "dismiss_surface") return "close_review";
    if (mechanicalEffect === "open_surface" && /edit|change/.test(text)) return "edit_review";
    if (["advance_surface", "advance_checkout_stage"].includes(mechanicalEffect) && /payment|continue|proceed|submit/.test(text)) return "continue_to_payment";
  }
  if (mechanicalEffect === "select_free_option") return "select_policy_safe_option";
  if (mechanicalEffect === "select_paid_option") return "select_paid_option";
  if (mechanicalEffect === "open_surface") return /edit|change/.test(text) ? "edit_current_information" : "open_current_surface";
  if (mechanicalEffect === "dismiss_surface") return "dismiss_current_surface";
  if (mechanicalEffect === "advance_checkout_stage") return /payment/.test(text) ? "continue_to_payment" : "advance_checkout_stage";
  if (mechanicalEffect === "advance_surface") return "advance_current_surface";
  if (mechanicalEffect === "set_field_value") return "complete_profile_field";
  return String(candidate.semanticIntent || candidate.intent || goal.semanticType || "unknown");
}

function expectedPostconditionsForAction({ expectedOutcome = null, semanticIntent = "", mechanicalEffect = "unknown", goal = {} } = {}) {
  const conditions = expectedOutcome && typeof expectedOutcome === "object" ? [{ ...expectedOutcome }] : [];
  if (semanticIntent === "confirm_continue_without_seats") {
    conditions.push(
      { type: "surface_absent", surfaceId: expectedOutcome?.surfaceId || "" },
      { type: "seat_policy_outcome", status: "skipped_without_paid_seat" }
    );
  } else if (semanticIntent === "close_review") {
    conditions.push({ type: "durable_objective_progress", status: "no_progress" });
  } else if (semanticIntent === "continue_to_payment") {
    conditions.push({
      type: "payment_review_evidence",
      acceptedEvidence: ["fresh_payment_stage", "payment_url", "payment_progress_marker", "payment_controls"]
    });
  }
  if (!conditions.length && mechanicalEffect !== "unknown") {
    conditions.push({ type: "mechanical_effect_observed", effect: mechanicalEffect });
  }
  return conditions;
}

function verifiablePostconditions(postconditions = []) {
  return Array.isArray(postconditions)
    && postconditions.some((condition) => condition?.type && !["observable_change", "command_acknowledged"].includes(condition.type));
}

function assessOutcomeCompatibility({
  goal = {},
  durableObjective = {},
  mechanicalEffect = "unknown",
  semanticIntent = "",
  expectedPostconditions = [],
  candidate = {},
  control = {},
  observation = {}
} = {}) {
  const surface = observation.page?.currentSurface || observation.page?.activeSurface || {};
  const declaredSurfaceClass = normalized(surface.surfaceClass || observation.page?.surfaceClass || "unknown");
  const surfaceText = normalized(surface.label || "");
  const surfaceClass = declaredSurfaceClass !== "unknown"
    ? declaredSurfaceClass
    : /review|verify|check your (details|information)/.test(surfaceText)
      ? "review_confirmation"
      : /warning|are you sure|continue without|not selected.*seat|without.*seat/.test(surfaceText)
        ? "warning"
        : "unknown";
  const taskOutcome = outcomeContractForGoal(goal, observation).taskOutcome;
  const durableOutcome = (durableObjective.taskOutcome ? normalizedOutcomeContract(durableObjective) : outcomeContractForGoal(durableObjective, observation)).taskOutcome;
  if (!candidate.controlId || !candidate.targetId || !control.controlId) {
    return { status: OUTCOME_COMPATIBILITY.UNKNOWN, reason: "candidate_not_grounded" };
  }
  if (control.semanticConflict === true || candidate.semanticConflict === true || mechanicalEffect === "unknown") {
    return { status: OUTCOME_COMPATIBILITY.UNKNOWN, reason: "mechanical_or_semantic_meaning_unknown" };
  }
  if (!verifiablePostconditions(expectedPostconditions)) {
    return { status: OUTCOME_COMPATIBILITY.UNKNOWN, reason: "postconditions_not_verifiable" };
  }
  if (durableOutcome === "payment_review_reached" && ["submit_purchase", "enter_payment_credentials"].includes(mechanicalEffect)) {
    return { status: OUTCOME_COMPATIBILITY.CONTEXT_ONLY, reason: "effect_exceeds_payment_review_objective" };
  }
  if (taskOutcome === "profile_field_completed") {
    return mechanicalEffect === "set_field_value"
      ? { status: OUTCOME_COMPATIBILITY.COMPATIBLE, reason: "field_postcondition_matches_obligation" }
      : { status: OUTCOME_COMPATIBILITY.CONTEXT_ONLY, reason: "does_not_complete_profile_field" };
  }
  if (["decision_resolved", "optional_extra_declined"].includes(taskOutcome)) {
    if (mechanicalEffect === "select_free_option") return { status: OUTCOME_COMPATIBILITY.COMPATIBLE, reason: "exact_safe_choice_matches_decision" };
    if (mechanicalEffect === "select_paid_option") return { status: OUTCOME_COMPATIBILITY.COMPATIBLE, reason: "exact_choice_matches_decision_subject_to_policy" };
    if (semanticIntent === "confirm_continue_without_seats" && mechanicalEffect === "dismiss_surface") {
      return { status: OUTCOME_COMPATIBILITY.COMPATIBLE, reason: "warning_confirmation_preserves_resolved_seat_policy" };
    }
    if (mechanicalEffect === "open_surface") return { status: OUTCOME_COMPATIBILITY.COMPATIBLE, reason: "opens_exact_decision_options" };
    if (goal.desiredPolicyOutcome === "selected_free_option"
      && !(goal.freeAlternativeControlIds || []).length
      && ["advance_surface", "advance_checkout_stage"].includes(mechanicalEffect)) {
      return { status: OUTCOME_COMPATIBILITY.COMPATIBLE, reason: "safe_forward_action_completes_policy_constraint_without_fake_selection" };
    }
    return { status: OUTCOME_COMPATIBILITY.CONTEXT_ONLY, reason: "effect_does_not_resolve_exact_decision" };
  }
  if (surfaceClass === "review_confirmation") {
    if (semanticIntent === "continue_to_payment" && ["advance_surface", "advance_checkout_stage"].includes(mechanicalEffect)) {
      return { status: OUTCOME_COMPATIBILITY.COMPATIBLE, reason: "review_submit_advances_durable_payment_objective" };
    }
    return { status: OUTCOME_COMPATIBILITY.CONTEXT_ONLY, reason: "review_control_does_not_advance_current_obligation" };
  }
  if (surfaceClass === "warning") {
    if (semanticIntent === "confirm_continue_without_seats" && ["dismiss_surface", "advance_surface"].includes(mechanicalEffect)) {
      return { status: OUTCOME_COMPATIBILITY.COMPATIBLE, reason: "warning_confirmation_completes_current_obligation" };
    }
    return ["open_surface", "advance_surface"].includes(mechanicalEffect)
      ? { status: OUTCOME_COMPATIBILITY.COMPATIBLE, reason: "warning_action_has_typed_progress_postcondition" }
      : { status: OUTCOME_COMPATIBILITY.CONTEXT_ONLY, reason: "warning_dismissal_has_no_obligation_progress" };
  }
  if ((goal.semanticType === "surface_ambiguity" || goal.selectionMode === "ai_ambiguity")
    && mechanicalEffect === "dismiss_surface"
    && /close|dismiss_current_surface/.test(semanticIntent)) {
    return { status: OUTCOME_COMPATIBILITY.COMPATIBLE, reason: "explicit_safe_dismissal_resolves_unknown_foreground_surface" };
  }
  if (taskOutcome === "checkout_stage_advanced" || taskOutcome === "current_surface_completed" || goal.semanticType === "navigation") {
    if (["advance_surface", "advance_checkout_stage"].includes(mechanicalEffect)) {
      return { status: OUTCOME_COMPATIBILITY.COMPATIBLE, reason: "typed_navigation_postcondition_matches_obligation" };
    }
    const typedSafeDecline = semanticIntent === "decline_optional_extra"
      && mechanicalEffect === "dismiss_surface"
      && expectedPostconditions.some((condition) => (
        condition?.type === "active_surface_dismissed"
        && condition?.mustNotIncreasePrice !== false
      ));
    if (typedSafeDecline) {
      return { status: OUTCOME_COMPATIBILITY.COMPATIBLE, reason: "grounded_safe_decline_completes_current_surface_obligation" };
    }
    if (surfaceClass === "information" && mechanicalEffect === "dismiss_surface") {
      return { status: OUTCOME_COMPATIBILITY.COMPATIBLE, reason: "information_surface_is_completed_by_dismissal" };
    }
    return { status: OUTCOME_COMPATIBILITY.CONTEXT_ONLY, reason: "local_effect_does_not_advance_current_obligation" };
  }
  return { status: OUTCOME_COMPATIBILITY.UNKNOWN, reason: "obligation_compatibility_requires_interpretation" };
}

function choiceLike(control = {}) {
  return control.state?.pressable === true
    || /radio|checkbox|option|choice/.test(normalized(`${control.kind || ""} ${control.role || ""}`));
}

function navigationLike(control = {}, goal = {}) {
  return /navigation|continue|next|proceed|stage_exit/.test(normalized(`${control.semantic || ""} ${control.kind || ""} ${goal.semanticType || ""}`));
}

function safeWaiver(control = {}, goal = {}) {
  return /decline|free|safe_decline|no[_ -]?extra|without|waive|skip/.test(
    normalized(`${control.semantic || ""} ${control.risk || ""} ${control.label || ""}`)
  );
}

function paidChoiceLike(control = {}) {
  if (safeWaiver(control)) return false;
  return Number(control.structuredPrice?.amount) > 0
    || /add_paid|paid_extra|select_paid|purchase|upgrade|money/.test(
      normalized(`${control.semantic || ""} ${control.risk || ""}`)
    );
}

function fromExpectedOutcome(expectedOutcome = {}) {
  const type = normalized(expectedOutcome.type);
  if (type === "target_in_view") return { interactionRole: "navigation", semanticEffect: "advance", expectedEvidence: "target_visible" };
  if (/options_surface_appeared|active_surface_change|semantic_progress/.test(type)) return { interactionRole: "opener", semanticEffect: "open", expectedEvidence: "options_appeared" };
  if (/exact_free_option_selected|control_selected|section_choice_verified/.test(type)) return { interactionRole: "choice", semanticEffect: "select", expectedEvidence: "selected" };
  if (/normalized_value_changed|field_value_changed|date_value_committed/.test(type)) return { interactionRole: "field", semanticEffect: "set_value", expectedEvidence: "value_changed" };
  if (/stage_exit_or_feedback/.test(type)) return { interactionRole: "navigation", semanticEffect: "advance", expectedEvidence: "progress_changed" };
  if (/active_surface_dismissed|requirement_status/.test(type)) return { interactionRole: "command", semanticEffect: "waive", expectedEvidence: "dismissed" };
  return null;
}

function deriveActionSemantics({ control = {}, operation = "", type = "", goal = {}, expectedOutcome = null } = {}) {
  const op = normalized(operation);
  if (type === "scroll") return { interactionRole: "navigation", semanticEffect: "advance", expectedEvidence: "target_visible" };
  if (op === "open") return { interactionRole: "opener", semanticEffect: "open", expectedEvidence: "options_appeared" };
  if (["type", "select"].includes(op) || ["type", "select"].includes(type)) {
    return { interactionRole: "field", semanticEffect: "set_value", expectedEvidence: "value_changed" };
  }
  if (op === "choose" || choiceLike(control)) {
    return { interactionRole: "choice", semanticEffect: "select", expectedEvidence: "selected" };
  }
  if (op === "activate" && paidChoiceLike(control)) {
    return { interactionRole: "choice", semanticEffect: "select", expectedEvidence: "selected" };
  }
  if (op === "keyboard") {
    const typed = fromExpectedOutcome(expectedOutcome || {});
    return typed?.interactionRole === "field"
      ? typed
      : { interactionRole: "opener", semanticEffect: "open", expectedEvidence: "options_appeared" };
  }
  const explicit = fromExpectedOutcome(expectedOutcome || {});
  if (explicit) return explicit;
  if (navigationLike(control, goal)) {
    return { interactionRole: "navigation", semanticEffect: "advance", expectedEvidence: "progress_changed" };
  }
  if (control.decisionGroupId || goal.decisionGroupId) {
    return {
      interactionRole: "command",
      semanticEffect: safeWaiver(control, goal) ? "waive" : "advance",
      expectedEvidence: "dismissed"
    };
  }
  return { interactionRole: "command", semanticEffect: "advance", expectedEvidence: "dismissed" };
}

function normalizedActionSemantics(action = {}, context = {}) {
  const derived = deriveActionSemantics({
    ...context,
    operation: action.operation || context.operation,
    type: action.type || action.action || context.type,
    expectedOutcome: action.expectedOutcome || context.expectedOutcome
  });
  return {
    interactionRole: INTERACTION_ROLES.has(action.interactionRole) ? action.interactionRole : derived.interactionRole,
    semanticEffect: SEMANTIC_EFFECTS.has(action.semanticEffect) ? action.semanticEffect : derived.semanticEffect,
    expectedEvidence: EXPECTED_EVIDENCE.has(action.expectedEvidence) ? action.expectedEvidence : derived.expectedEvidence
  };
}

function compileTypedExpectedOutcome(action = {}, page = {}) {
  if (action.affordance?.postcondition?.type) return action.affordance.postcondition;
  const target = action.targetSnapshot || {};
  const control = (page.controls || []).find((item) => item.controlId === (action.controlId || target.controlId)) || target;
  const semantics = normalizedActionSemantics(action, { control });
  const physicalEffect = action.physicalEffect || action.affordance?.physicalEffect || action.affordance?.effect
    || predictPhysicalEffect({ semantics, control, candidate: action, goal: action.goal || {} });
  const existing = action.expectedOutcome || {};
  const base = {
    interactionRole: semantics.interactionRole,
    semanticEffect: semantics.semanticEffect,
    expectedEvidence: semantics.expectedEvidence,
    targetId: action.targetId || target.id || existing.targetId || "",
    controlId: action.controlId || target.controlId || existing.controlId || "",
    decisionGroupId: action.decisionGroupId || target.decisionGroupId || existing.decisionGroupId || "",
    requirementId: action.requirementId || existing.requirementId || "",
    surfaceId: target.surfaceId || action.surfaceId || existing.surfaceId || "",
    intent: action.intent || existing.intent || "",
    mustNotIncreasePrice: existing.mustNotIncreasePrice !== false
  };

  if (existing.type === "target_in_view" || semantics.expectedEvidence === "target_visible") {
    return { ...existing, ...base, type: "target_in_view" };
  }
  if (["select_free_option", "select_paid_option"].includes(physicalEffect)) {
    const disposition = normalized(`${action.semantic || ""} ${action.policyOutcome || ""} ${action.risk || ""} ${control.semantic || ""} ${control.risk || ""}`);
    const structuredPrice = action.affordance?.structuredPrice || control.structuredPrice || null;
    const exactFree = physicalEffect === "select_free_option" || Number(structuredPrice?.amount) === 0
      || /decline|safe_decline|free|selected_free_option|no[_ -]?extra|without/.test(disposition)
      || existing.type === "exact_free_option_selected";
    return {
      ...existing,
      ...base,
      type: exactFree ? "exact_free_option_selected" : "control_selected",
      expectedSelectedControlId: base.controlId,
      expectedSelectedLabel: action.targetLabel || target.label || control.label || existing.expectedSelectedLabel || "",
      expectedDisposition: exactFree ? "decline_free_no_extra" : "selected",
      prohibitPaidAlternative: exactFree,
      requireSurfaceDismissed: false,
      beforePriceAmount: Number.isFinite(Number(page.price?.amount)) ? Number(page.price.amount) : null,
      beforePriceText: page.priceText || "",
      mustNotIncreasePrice: true
    };
  }
  if (physicalEffect === "dismiss_surface") {
    return { ...existing, ...base, type: "active_surface_dismissed", previousSurfaceId: existing.previousSurfaceId || base.surfaceId };
  }
  if (physicalEffect === "open_surface" || semantics.interactionRole === "opener") {
    return { ...existing, ...base, type: "options_surface_appeared" };
  }
  if (physicalEffect === "advance_checkout_stage") {
    return { ...existing, ...base, type: "checkout_stage_advanced" };
  }
  if (physicalEffect === "advance_surface" || semantics.interactionRole === "navigation") {
    return { ...existing, ...base, type: "current_surface_advanced" };
  }
  if (["set_field_value", "enter_payment_credentials"].includes(physicalEffect) || semantics.interactionRole === "field") {
    return {
      ...existing,
      ...base,
      type: existing.type === "date_value_committed" ? "date_value_committed" : "normalized_value_changed",
      expectedValue: existing.expectedValue || action.value || "",
      expectedNormalizedValue: existing.expectedNormalizedValue || action.value || ""
    };
  }
  if (physicalEffect === "accept_legal_terms") {
    return { ...existing, ...base, type: "control_selected", expectedSelectedControlId: base.controlId };
  }
  if (physicalEffect === "submit_purchase") {
    return { ...existing, ...base, type: "booking_confirmed" };
  }
  return existing.type ? { ...existing, ...base } : null;
}

function predictPhysicalEffect({ semantics = {}, control = {}, candidate = {}, goal = {} } = {}) {
  if (PHYSICAL_EFFECTS.has(candidate.physicalEffect) && candidate.physicalEffect !== "unknown") return candidate.physicalEffect;
  if (control.semanticConflict === true || candidate.semanticConflict === true) return "unknown";
  if (PHYSICAL_EFFECTS.has(control.physicalEffect) && control.physicalEffect !== "unknown") return control.physicalEffect;
  if (semantics.expectedEvidence === "target_visible") return "reveal_control";
  const meaning = normalized([
    candidate.semantic,
    candidate.testId,
    candidate.formAction,
    candidate.formId,
    candidate.ownText,
    candidate.title,
    control.semantic,
    control.risk,
    control.label,
    control.accessibleName,
    control.testId,
    control.formAction,
    control.formId,
    control.ownText,
    control.title
  ].filter(Boolean).join(" "));
  const goalContract = outcomeContractForGoal(goal, {
    page: { currentSurface: { type: candidate.surfaceType || control.surfaceType || "page" } }
  });
  if (/submit_purchase|confirm_purchase|finalize_booking|book now|pay now|complete purchase/.test(meaning)) return "submit_purchase";
  if (/card_number|cardholder|security_code|cvc|cvv|expiry|payment credential/.test(meaning)) return "enter_payment_credentials";
  if (/accept_legal|accept terms|agree.*terms|legal consent/.test(meaning)) return "accept_legal_terms";
  if (goalContract.taskOutcome === "profile_field_completed"
    && ["choice", "field"].includes(semantics.interactionRole)) return "set_field_value";
  if (semantics.interactionRole === "choice") {
    const price = candidate.structuredPrice || control.structuredPrice || null;
    const safe = Number(price?.amount) === 0 || /safe|decline|free/.test(normalized(`${candidate.risk || ""} ${control.risk || ""} ${control.semantic || ""}`));
    return safe ? "select_free_option" : "select_paid_option";
  }
  if (/dismiss_surface|close|dismiss|icon[_ -]?x|dialog close/.test(meaning)) return "dismiss_surface";
  if (semantics.interactionRole === "opener" || /open_surface|open_choice|show options|expand/.test(meaning)) return "open_surface";
  if (semantics.interactionRole === "field") return "set_field_value";
  // A generic command has no implied direction. Dismissal must be grounded in
  // direct close/dismiss evidence; acknowledgement alone is not an effect.
  if (semantics.interactionRole === "command") return "unknown";
  if (semantics.interactionRole === "navigation") {
    if (/payment|checkout stage|place order/.test(meaning)
      || ["checkout_stage_advanced", "payment_review_reached", "booking_confirmed"].includes(goalContract.taskOutcome)) {
      return "advance_checkout_stage";
    }
    return (candidate.surfaceType || control.surfaceType || "page") === "page"
      ? "advance_checkout_stage"
      : "advance_surface";
  }
  return "unknown";
}

function buildSemanticAffordance({ candidate = {}, control = {}, goal = {}, postcondition = null } = {}) {
  const semantics = normalizedActionSemantics(candidate, { control, goal, expectedOutcome: postcondition || candidate.expectedOutcome });
  const stableKey = String(candidate.stableKey || control.stableKey || `control:${candidate.controlId || control.controlId || "unknown"}`);
  const capability = String(candidate.operation || candidate.type || "activate");
  const actuatorId = String(candidate.targetId || "");
  const structuredPrice = candidate.structuredPrice || control.structuredPrice || null;
  const outcomeContract = outcomeContractForGoal(goal, {
    page: { currentSurface: { type: candidate.surfaceType || control.surfaceType || "page" } }
  });
  const physicalEffect = predictPhysicalEffect({ semantics, control, candidate, goal: { ...goal, outcomeContract } });
  const semanticIntent = candidate.semanticIntent || semanticIntentForAction({
    mechanicalEffect: physicalEffect,
    control,
    candidate,
    goal,
    observation: { page: { currentSurface: { type: candidate.surfaceType || control.surfaceType || "page", surfaceClass: candidate.surfaceClass || "unknown", label: candidate.surfaceLabel || control.surfaceLabel || "" } } }
  });
  const expectedPostconditions = candidate.expectedPostconditions?.length ? candidate.expectedPostconditions : expectedPostconditionsForAction({
    expectedOutcome: postcondition || candidate.expectedOutcome || null,
    semanticIntent,
    mechanicalEffect: physicalEffect,
    goal
  });
  return Object.freeze({
    stableKey,
    meaning: String(candidate.meaning || control.meaning || control.semantic || control.accessibleName || control.label || capability),
    structuredPrice: structuredPrice && Number.isFinite(Number(structuredPrice.amount))
      ? { amount: Number(structuredPrice.amount), currency: String(structuredPrice.currency || "") }
      : null,
    risk: String(candidate.risk || control.risk || "uncertain"),
    task: Object.freeze({
      goalId: String(goal.goalId || ""),
      ...(goal.transactionOutcomeId ? { transactionOutcomeId: String(goal.transactionOutcomeId) } : {}),
      ...(goal.stageOutcomeId ? { stageOutcomeId: String(goal.stageOutcomeId) } : {}),
      ...(goal.surfaceSubgoalId ? { surfaceSubgoalId: String(goal.surfaceSubgoalId) } : {}),
      semanticType: String(goal.semanticType || ""),
      desiredValue: String(goal.desiredValue || ""),
      decisionGroupId: String(goal.decisionGroupId || candidate.decisionGroupId || control.decisionGroupId || ""),
      requirementId: String(goal.requirementId || candidate.requirementId || ""),
      outcomeContract,
      ...(goal.parentOutcomeContract ? { parentOutcomeContract: goal.parentOutcomeContract } : {})
    }),
    capability,
    actuator: Object.freeze({
      stableKey: `${stableKey}:actuator:${capability}`,
      targetId: actuatorId,
      controlId: String(candidate.controlId || control.controlId || ""),
      proven: Boolean(actuatorId || candidate.visualRegion),
      source: candidate.visualRegion ? String(candidate.visualRegion.source || "visual_region") : "canonical_operation"
    }),
    effect: physicalEffect,
    physicalEffect,
    mechanicalEffect: physicalEffect,
    semanticIntent,
    expectedPostconditions: Object.freeze(expectedPostconditions.map((condition) => Object.freeze({ ...condition }))),
    postcondition: postcondition || candidate.expectedOutcome || null
  });
}

module.exports = {
  EXPECTED_EVIDENCE,
  INTERACTION_ROLES,
  PHYSICAL_EFFECTS,
  OUTCOME_COMPATIBILITY,
  SEMANTIC_EFFECTS,
  TASK_OUTCOMES,
  buildSemanticAffordance,
  assessOutcomeCompatibility,
  compileTypedExpectedOutcome,
  deriveActionSemantics,
  effectCompatibleWithGoal,
  expectedPostconditionsForAction,
  outcomeContractForGoal,
  predictPhysicalEffect,
  semanticIntentForAction,
  normalizedActionSemantics
};
