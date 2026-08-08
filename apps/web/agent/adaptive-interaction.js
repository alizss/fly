"use strict";

const { controlBelongsToCurrentSurface, currentSurface } = require("./surface-contract");
const { SEAT_POLICIES, seatPolicyFrom } = require("./policy-profile");

const ALLOWED_OPERATIONS = Object.freeze(["open", "choose", "activate", "keyboard"]);
const FORBIDDEN_RISKS = Object.freeze(["money", "paid", "payment", "legal", "destructive"]);
const FORBIDDEN_EFFECTS = Object.freeze([
  "select_paid_option",
  "add_paid_extra",
  "enter_payment_credentials",
  "submit_payment",
  "submit_purchase",
  "accept_legal_terms",
  "change_itinerary",
  "change_identity",
  "external_communication"
]);
const CONSEQUENTIAL = /payment|purchase|pay now|book now|confirm booking|place order|card|cvc|cvv|security code|legal|terms|consent|subscribe|newsletter|marketing|miles|loyalty|sign in|log in|delete|cancel booking|change (?:flight|route|passenger|travell?er)|edit (?:flight|route|passenger|travell?er)|feedback|support/i;
const OBSERVED_CONSEQUENTIAL_EFFECT = /select_paid|add_paid|payment|purchase|submit_purchase|accept_legal|enter_payment|change_itinerary|change_identity|external_communication/i;

function clean(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function lower(value = "") {
  return clean(value).toLowerCase();
}

function explicitlyDormant(control = {}) {
  const lifecycle = control.representationLifecycle || {};
  return lifecycle.active === false
    || /dormant|future|template|responsive_duplicate|inactive/.test(lower(lifecycle.status));
}

function operationProofs(control = {}) {
  return Object.entries(control.operations || {}).flatMap(([operation, capability]) => {
    if (!ALLOWED_OPERATIONS.includes(operation) || !capability) return [];
    const strategies = capability.strategies?.length
      ? capability.strategies
      : [{
          actuatorId: capability.actuatorId,
          proof: capability.actionability || {},
          status: capability.status || ""
        }];
    return strategies.map((strategy) => ({
      operation,
      actuatorId: clean(strategy.actuatorId || capability.actuatorId),
      proof: strategy.proof || capability.actionability || {},
      status: clean(strategy.status || capability.status)
    }));
  }).filter((entry) => (
    entry.actuatorId
    && entry.proof.rendered === true
    && entry.proof.visible === true
    && entry.proof.enabled === true
    && entry.proof.inCurrentSurface === true
    && (
      entry.proof.executable === true
      || entry.proof.revealable === true
      || /proven_executable|recoverable|executable/.test(lower(entry.status))
    )
  ));
}

function controlMeaning(control = {}) {
  return lower([
    control.label,
    control.accessibleName,
    control.semantic,
    control.semanticType,
    control.meaning,
    control.physicalEffect,
    control.risk,
    control.interactionRole,
    control.testId,
    control.formAction
  ].filter(Boolean).join(" "));
}

function hasPositivePrice(control = {}) {
  const amount = Number(control.structuredPrice?.amount ?? control.priceAmount);
  return Number.isFinite(amount) && amount > 0;
}

function checkoutRelevantControl(control = {}) {
  const meaning = controlMeaning(control);
  const effect = lower(`${control.physicalEffect || ""} ${control.semanticEffect || ""}`);
  const risk = lower(control.risk);
  return Boolean(
    control.choiceContract
    || /continue|next|advance|navigation|submit_form|dismiss|close|skip|decline|no_thanks|required_dropdown_choice|seat_option|seat_map|seat_selection|baggage|insurance|bundle|optional_extra/.test(meaning)
    || /open_surface|dismiss_surface|select_free_option|advance_surface|advance_checkout_stage|reveal_control/.test(effect)
    || /safe_continue|safe_decline/.test(risk)
  );
}

function lowConsequenceControl(control = {}, page = {}) {
  if (!control?.controlId || explicitlyDormant(control)) return false;
  if (!controlBelongsToCurrentSurface(control, page)) return false;
  if (control.globalChrome === true || control.disabled === true || control.state?.disabled === true) return false;
  if (control.selected === true || control.state?.selected === true || control.state?.checked === true) return false;
  // Profile facts already have one authoritative logical-field adapter and
  // verifier. The adaptive interaction fallback must not reopen or rewrite a
  // completed identity/contact component merely because it is clickable.
  const fieldShape = lower(`${control.kind || ""} ${control.role || ""} ${control.domRole || ""}`);
  if (control.fieldType || control.field || /textbox|input|textarea|combobox|select|spinbutton|date/.test(fieldShape)) return false;
  if (!operationProofs(control).length || hasPositivePrice(control)) return false;

  const risk = lower(control.risk);
  const effect = lower(`${control.physicalEffect || ""} ${control.semanticEffect || ""}`);
  const meaning = controlMeaning(control);
  // A fare/product CTA that only resembles Continue is not a reversible
  // navigation action. It needs an owned option/effect contract before it can
  // enter either the canonical path or this fallback.
  if (
    /selection[_ -]?cta/.test(lower(`${control.semantic || ""} ${control.semanticType || ""}`))
    && !control.choiceContract
    && (!effect || effect === "unknown")
    && (!risk || risk === "uncertain")
  ) return false;
  if (FORBIDDEN_RISKS.includes(risk) || OBSERVED_CONSEQUENTIAL_EFFECT.test(effect)) return false;
  if (CONSEQUENTIAL.test(meaning)) return false;
  // Reversibility alone is insufficient: language, account, header, support,
  // and other harmless controls are not checkout progress. The fallback must
  // still have a locally grounded checkout affordance even when its full
  // canonical decision semantics are incomplete.
  return checkoutRelevantControl(control);
}

function interactionObjective({ observation = {}, userPolicy = {}, traveler = {} } = {}) {
  const page = observation.page || {};
  const stage = lower(page.step || "current checkout");
  const seatPolicy = seatPolicyFrom({ userPolicy, traveler });
  if (/seat/.test(stage)) {
    if (seatPolicy === SEAT_POLICIES.RANDOM_ASSIGNMENT) {
      return "Resolve the current seat step using random airline assignment and without selecting a paid seat.";
    }
    if (seatPolicy !== SEAT_POLICIES.UNSPECIFIED) {
      return `Resolve the current seat step according to the saved ${seatPolicy.replace(/_/g, " ")} preference without exceeding its authorization.`;
    }
    return "Progress the current seat step without adding an unrequested paid seat.";
  }
  if (/bag|baggage|luggage/.test(stage)) {
    return `Resolve the current baggage step using the saved baggage profile (${clean(userPolicy.baggagePreference || traveler.baggage_preference || "no unrequested paid baggage")}).`;
  }
  if (/insurance|protection|bundle|extra|ancillary/.test(stage)) {
    return "Resolve the current optional-product step according to the traveler profile and decline unrequested paid products.";
  }
  return "Make one reversible action that advances the current checkout without changing the approved itinerary, identity, price, legal state, or payment state.";
}

function adaptiveInteractionGoal({
  observation = {},
  userPolicy = {},
  traveler = {},
  reason = "",
  excludedControlIds = []
} = {}) {
  const page = observation.page || {};
  const surface = currentSurface(page);
  if (["payment", "confirmation"].includes(lower(page.step))) return null;
  const excluded = new Set((excludedControlIds || []).map(clean).filter(Boolean));
  const controls = (page.controls || []).filter((control) => (
    !excluded.has(clean(control.controlId))
    && lowConsequenceControl(control, page)
  ));
  if (!controls.length) return null;
  const controlIds = [...new Set(controls.map((control) => control.controlId).filter(Boolean))];
  const objective = interactionObjective({ observation, userPolicy, traveler });
  return Object.freeze({
    goalId: `${observation.observationId || "observation"}:adaptive_interaction`,
    kind: "adaptive_interaction",
    selectionMode: "bounded_adaptive",
    semanticGoal: objective,
    semanticType: "bounded_safe_progress",
    desiredValue: "fresh_checkout_progress",
    observationId: observation.observationId || "",
    surfaceId: surface.id || "surface-page",
    surfaceType: surface.type || "page",
    actionableControlIds: Object.freeze(controlIds),
    postcondition: Object.freeze({
      type: "observable_change",
      surfaceId: surface.id || "surface-page",
      mustNotIncreasePrice: true
    }),
    outcomeContract: Object.freeze({
      outcomeId: `${observation.observationId || "observation"}:bounded_progress`,
      taskOutcome: "current_surface_completed",
      acceptablePhysicalEffects: Object.freeze([
        "open_surface",
        "dismiss_surface",
        "select_free_option",
        "advance_surface",
        "advance_checkout_stage",
        "reveal_control",
        "unknown"
      ]),
      completionEvidence: Object.freeze(["fresh_surface_state", "observable_change"])
    }),
    adaptiveEnvelope: Object.freeze({
      kind: "bounded_adaptive_interaction",
      episodeId: `${observation.observationId || "observation"}:${surface.id || "surface-page"}`,
      objective,
      surfaceId: surface.id || "surface-page",
      surfaceType: surface.type || "page",
      allowedOperations: ALLOWED_OPERATIONS,
      forbiddenRisks: FORBIDDEN_RISKS,
      forbiddenEffects: FORBIDDEN_EFFECTS,
      remainingSteps: 1,
      deadlineAt: Date.now() + 20_000,
      triggerReason: clean(reason || "formal_goal_unavailable"),
      excludedControlIds: Object.freeze([...excluded])
    })
  });
}

module.exports = {
  adaptiveInteractionGoal,
  checkoutRelevantControl,
  interactionObjective,
  lowConsequenceControl,
  operationProofs
};
