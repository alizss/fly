const agentContract = require("../../../extension/src/shared/agent-contract");
const { normalizeAction } = require("../../../../packages/shared/agent-actions");
const { currentSurface } = require("../surface-contract");
const {
  compileTypedExpectedOutcome,
  expectedPostconditionsForAction,
  predictPhysicalEffect,
  semanticIntentForAction,
  normalizedActionSemantics
} = require("../action-semantics");

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
  const semantics = normalizedActionSemantics(action, {
    control: action.targetSnapshot || {},
    expectedOutcome
  });
  const mechanicalEffect = action.mechanicalEffect || action.affordance?.mechanicalEffect || action.affordance?.physicalEffect || action.affordance?.effect
    || predictPhysicalEffect({
      semantics,
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
    ...semantics,
    intent,
    mechanicalEffect,
    semanticIntent,
    expectedPostconditions,
    expectedOutcome
  });
}

module.exports = { expectedOutcomeForAction, withActionContract };
