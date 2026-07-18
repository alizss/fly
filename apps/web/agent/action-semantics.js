const INTERACTION_ROLES = new Set(["choice", "command", "opener", "navigation", "field"]);
const SEMANTIC_EFFECTS = new Set(["select", "waive", "open", "advance", "set_value"]);
const EXPECTED_EVIDENCE = new Set(["selected", "dismissed", "options_appeared", "progress_changed", "value_changed", "target_visible"]);

function normalized(value = "") {
  return String(value || "").trim().toLowerCase();
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
  if (/normalized_value_changed|field_value_changed/.test(type)) return { interactionRole: "field", semanticEffect: "set_value", expectedEvidence: "value_changed" };
  if (/stage_exit_or_feedback/.test(type)) return { interactionRole: "navigation", semanticEffect: "advance", expectedEvidence: "progress_changed" };
  if (/active_surface_dismissed|command_acknowledged|requirement_status/.test(type)) return { interactionRole: "command", semanticEffect: "waive", expectedEvidence: "dismissed" };
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
  if (semantics.interactionRole === "choice") {
    const disposition = normalized(`${control.semantic || ""} ${control.risk || ""}`);
    const structuredPrice = action.affordance?.structuredPrice || control.structuredPrice || null;
    const exactFree = Number(structuredPrice?.amount) === 0
      || /decline|safe_decline|free|no[_ -]?extra|without/.test(disposition)
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
  if (semantics.interactionRole === "command") {
    return {
      ...existing,
      ...base,
      type: "command_acknowledged",
      expectedRequirementStatus: semantics.semanticEffect === "waive" ? "waived_by_policy" : "satisfied",
      acceptedRequirementStatuses: semantics.semanticEffect === "waive"
        ? ["waived_by_policy", "waived", "satisfied"]
        : ["satisfied"],
      previousSurfaceId: existing.previousSurfaceId || base.surfaceId
    };
  }
  if (semantics.interactionRole === "opener") {
    return { ...existing, ...base, type: "options_surface_appeared" };
  }
  if (semantics.interactionRole === "navigation") {
    return { ...existing, ...base, type: "stage_exit_or_feedback" };
  }
  if (semantics.interactionRole === "field") {
    return {
      ...existing,
      ...base,
      type: "normalized_value_changed",
      expectedValue: existing.expectedValue || action.value || "",
      expectedNormalizedValue: existing.expectedNormalizedValue || action.value || ""
    };
  }
  return existing.type ? { ...existing, ...base } : null;
}

function specificEffect(semantics = {}, control = {}, candidate = {}) {
  if (semantics.expectedEvidence === "target_visible") return "reveal_control";
  if (semantics.interactionRole === "choice") {
    const price = candidate.structuredPrice || control.structuredPrice || null;
    const safe = Number(price?.amount) === 0 || /safe|decline|free/.test(normalized(`${candidate.risk || ""} ${control.risk || ""} ${control.semantic || ""}`));
    return safe ? "select_free_option" : "select_option";
  }
  if (semantics.interactionRole === "command") return semantics.semanticEffect === "waive" ? "skip_current_item" : "dismiss_surface";
  if (semantics.interactionRole === "opener") return "open_control";
  if (semantics.interactionRole === "navigation") return "advance_surface";
  if (semantics.interactionRole === "field") return "set_value";
  return "unknown";
}

function buildSemanticAffordance({ candidate = {}, control = {}, goal = {}, postcondition = null } = {}) {
  const semantics = normalizedActionSemantics(candidate, { control, goal, expectedOutcome: postcondition || candidate.expectedOutcome });
  const stableKey = String(candidate.stableKey || control.stableKey || `control:${candidate.controlId || control.controlId || "unknown"}`);
  const capability = String(candidate.operation || candidate.type || "activate");
  const actuatorId = String(candidate.targetId || "");
  const structuredPrice = candidate.structuredPrice || control.structuredPrice || null;
  return Object.freeze({
    stableKey,
    meaning: String(candidate.meaning || control.meaning || control.semantic || control.accessibleName || control.label || capability),
    structuredPrice: structuredPrice && Number.isFinite(Number(structuredPrice.amount))
      ? { amount: Number(structuredPrice.amount), currency: String(structuredPrice.currency || "") }
      : null,
    risk: String(candidate.risk || control.risk || "uncertain"),
    task: Object.freeze({
      goalId: String(goal.goalId || ""),
      semanticType: String(goal.semanticType || ""),
      desiredValue: String(goal.desiredValue || ""),
      decisionGroupId: String(goal.decisionGroupId || candidate.decisionGroupId || control.decisionGroupId || ""),
      requirementId: String(goal.requirementId || candidate.requirementId || "")
    }),
    capability,
    actuator: Object.freeze({
      stableKey: `${stableKey}:actuator:${capability}`,
      targetId: actuatorId,
      controlId: String(candidate.controlId || control.controlId || ""),
      proven: Boolean(actuatorId || candidate.visualRegion),
      source: candidate.visualRegion ? String(candidate.visualRegion.source || "visual_region") : "canonical_operation"
    }),
    effect: specificEffect(semantics, control, candidate),
    postcondition: postcondition || candidate.expectedOutcome || null
  });
}

module.exports = {
  EXPECTED_EVIDENCE,
  INTERACTION_ROLES,
  SEMANTIC_EFFECTS,
  buildSemanticAffordance,
  compileTypedExpectedOutcome,
  deriveActionSemantics,
  normalizedActionSemantics
};
