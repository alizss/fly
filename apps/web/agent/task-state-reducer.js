const { profileStageReadiness, selectExecutableProfileGoal } = require("./skill-expander");
const { currentSurface, controlBelongsToCurrentSurface } = require("./surface-contract");
const { outcomeContractForGoal } = require("./action-semantics");
const { decisionInstanceKey } = require("../../../packages/shared/agent-actions");
const {
  CONTROL_TYPES,
  buildCanonicalDecisions,
  canonicalDecisionForGroup,
  isTypedNavigationControl
} = require("./canonical-decision");
const { normalizeProfilePolicy, seatPolicyFrom } = require("./policy-profile");
const agentContract = require("../../extension/src/shared/agent-contract");

const COMPLETED = new Set(["satisfied", "waived", "waived_by_policy"]);
const GOAL_CREATING = new Set(["active", "conflicted", "blocked"]);

function clean(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function lower(value = "") {
  return clean(value).toLowerCase();
}

function groupId(group = {}) {
  return clean(group.decisionGroupId || group.requirementId);
}

function groupKey(group = {}) {
  return groupId(group);
}

function decisionFamily(group = {}) {
  const resolvedOwnership = group.semanticOwnership || {};
  if (["resolved", "hypothesis"].includes(resolvedOwnership.status)
    && resolvedOwnership.source === "grounded_ai") {
    const resolvedFamily = lower(resolvedOwnership.family);
    if (resolvedFamily === "bundle") return "extras";
    if (["seat", "baggage", "insurance", "extras"].includes(resolvedFamily)) return resolvedFamily;
  }
  const text = lower(`${group.sectionType || ""} ${group.sectionLabel || ""} ${group.requirementId || ""}`);
  if (/seat/.test(text)) return "seat";
  if (/bag|luggage/.test(text)) return "baggage";
  if (/insurance|cancellation|protection/.test(text)) return "insurance";
  if (/bundle|support|sms|flexible|extra|add.?on/.test(text)) return "extras";
  if (/legal|terms|consent/.test(text)) return "legal";
  if (/payment|card|pay/.test(text)) return "payment";
  return "decision";
}

function stageEvidence(observation = {}) {
  const page = observation.page || {};
  const controls = page.controls || [];
  const fields = page.fields || [];
  const surface = currentSurface(page);
  const url = lower(page.url || observation.url);
  const controlText = (control = {}) => lower(
    `${control.fieldType || ""} ${control.field || ""} ${control.semanticType || ""} ${control.semantic || ""} ${control.inputType || ""} ${control.autocomplete || ""} ${control.name || ""} ${control.testId || ""} ${control.stableKey || ""}`
  );
  const directControlText = controls.concat(fields).map(controlText).join(" ");
  const primarySections = (page.sections || []).filter((section) => (
    !/order|summary|price|total|itinerary/.test(lower(`${section.type || ""} ${section.sectionType || ""}`))
  ));
  const headingText = lower([
    page.heading,
    page.summary?.title,
    page.foreground?.heading,
    surface.label,
    ...primarySections.map((section) => `${section.label || ""} ${section.heading || ""}`)
  ].filter(Boolean).join(" "));
  const text = lower([
    page.text,
    headingText,
    ...(page.sections || []).map((section) => `${section.type || ""} ${section.label || ""}`),
    ...(page.decisionGroups || []).map((group) => `${group.sectionType || ""} ${group.sectionLabel || ""}`),
    ...controls.slice(0, 180).map((control) => `${control.field || ""} ${control.semantic || ""} ${control.label || ""} ${control.inputType || ""}`)
  ].filter(Boolean).join(" "));
  const progressFacts = page.checkoutProgress
    || page.progress
    || page.activeProgress
    || page.foreground?.progressMarkers
    || page.visualState?.foreground?.progressMarkers
    || {};
  const explicitlyActiveProgressEntries = Object.entries(progressFacts || {}).flatMap(([key, value]) => {
    if (typeof value === "string" && /^(?:active|current|selected)$/i.test(value.trim())) return [key];
    if (value && typeof value === "object" && (
      value.active === true
      || value.current === true
      || value.selected === true
      || value["aria-current"] === "step"
    )) {
      return [`${key} ${value.label || value.name || ""}`];
    }
    return [];
  });
  const activeProgressText = lower([
    progressFacts.activeStep,
    progressFacts.currentStep,
    progressFacts.selectedStep,
    progressFacts.activeLabel,
    ...explicitlyActiveProgressEntries,
    ...(Array.isArray(progressFacts.steps)
      ? progressFacts.steps.filter((step) => (
        step?.active === true || step?.current === true || step?.selected === true || step?.["aria-current"] === "step"
      )).map((step) => `${step.label || ""} ${step.name || ""}`)
      : [])
  ].filter(Boolean).join(" "));
  const newSearchRoute = /(?:^|\/)rf\/start\/?$/.test(url)
    || /(?:^|\/)(?:flight-)?search\/?$/.test(url);
  const payment = {
    route: /(?:^|[\/#?&_-])payment(?:[\/#?&=_-]|$)/.test(url),
    progress: /payment|pay/.test(activeProgressText),
    fields: /card_number|cardholder|security_code|card_cvc|\bcvc\b|\bcvv\b|card_expiry|cc-number|cc-exp|cc-csc/.test(directControlText),
    method: /payment_method|billing_address|payment_option/.test(directControlText),
    heading: /payment|pay securely|payment details|choose payment method/.test(headingText),
    orderSection: /payment method|payment options|order amount|amount due|amount to pay|total to pay/.test(text)
  };
  // Order-summary copy is context only. It cannot increase the strong signal
  // count used to classify the whole page as payment.
  const paymentSignals = ["route", "progress", "fields", "method", "heading"]
    .filter((key) => payment[key]).length;
  const confirmation = /booking confirmed|booking reference|reservation number|confirmation number|\bpnr\b/.test(headingText)
    || /confirmation|booking-confirmed/.test(url);
  const seat = /(?:^|[\/#?&_-])seats?(?:[\/#?&=_-]|$)/.test(url)
    || /seat_option|seat_map|seat_selection/.test(directControlText)
    || /seat selection|reserve seating|seat map/.test(headingText)
    || (surface.type !== "page" && /seat|seating/.test(lower(surface.label)));
  const traveler = /(?:^|[\/#?&_-])(?:travell?er|passenger|contact)(?:[\/#?&=_-]|$)/.test(url)
    || /first_name|last_name|surname|full_name|email|phone|date_of_birth|dob|passport|nationality|traveler_title/.test(directControlText)
    || /travell?er information|passenger details|contact information/.test(headingText);
  const extras = (page.decisionGroups || []).some((group) => ["seat", "baggage", "insurance", "extras"].includes(decisionFamily(group)))
    || /(?:^|[\/#?&_-])(?:extras?|ancillar(?:y|ies)?|baggage|bundle|insurance)(?:[\/#?&=_-]|$)/.test(url)
    || /baggage|insurance|bundle|flexible ticket|add.?on|upgrade your trip/.test(headingText);
  const flight = /(?:^|[\/#?&_-])(?:flights?|search)(?:[\/#?&=_-]|$)/.test(url)
    || /select flight|choose flight|flight selection|fare selection/.test(headingText);
  return {
    payment,
    paymentSignals,
    confirmation,
    seat,
    traveler,
    extras,
    flight,
    newSearchRoute,
    activeProgressText,
    headingText,
    text,
    url
  };
}

function decideStage(observation = {}) {
  const evidence = stageEvidence(observation);
  const surface = currentSurface(observation.page || {});
  const paymentDestination = Boolean(
    (evidence.payment.route && evidence.paymentSignals >= 2)
    || (evidence.payment.fields && (evidence.payment.heading || evidence.payment.progress || evidence.payment.method))
    || (evidence.payment.progress && (evidence.payment.heading || evidence.payment.method))
  );
  if (paymentDestination) return { stage: "payment", evidence };
  if (evidence.confirmation) return { stage: "confirmation", evidence };
  // Search/start routes are outside an active checkout. Route structure is
  // stronger than stale extras copy retained in a rerendered shell.
  if (evidence.newSearchRoute) return { stage: "flight_selection", evidence };
  if (surface.type !== "page" && evidence.seat) return { stage: "seats", evidence };
  if (evidence.traveler) return { stage: "traveler_information", evidence };
  if (evidence.seat) return { stage: "seats", evidence };
  if (evidence.extras) return { stage: "extras", evidence };
  if (evidence.flight) return { stage: "flight_selection", evidence };
  return { stage: "unknown", evidence };
}

function surfaceFingerprint(stage = "unknown", surface = {}, observation = {}) {
  const progress = observation.page?.foreground?.progressMarkers
    || observation.page?.visualState?.foreground?.progressMarkers
    || {};
  return JSON.stringify({
    stage,
    id: surface.id || "surface-page",
    type: surface.type || "page",
    label: lower(surface.label),
    progress
  });
}

function completedMap(previousTaskState = {}) {
  const records = previousTaskState.completedOutcomes || [];
  return new Map(records.filter((record) => groupId(record)).map((record) => [
    clean(record.instanceId || groupKey(record)),
    { ...record }
  ]));
}

function forwardControlIds(observation = {}) {
  const page = observation.page || {};
  const explicitStageExitIds = new Set([
    page.stageExit?.continueControlId,
    page.stageExit?.continueTargetId
  ].filter(Boolean));
  return (page.controls || []).filter((control) => {
    if (!controlBelongsToCurrentSurface(control, page)) return false;
    if (!controlHasExecutableCapability(control)) return false;
    const explicitStageExit = explicitStageExitIds.has(control.controlId)
      || explicitStageExitIds.has(control.stateElementId)
      || explicitStageExitIds.has(control.preferredActivationElementId);
    return isTypedNavigationControl(control, { explicitStageExit });
  }).map((control) => control.controlId).filter(Boolean);
}

function controlHasExecutableCapability(control = {}) {
  return Object.values(control.operations || {}).some((capability) => (
    capability?.actionability?.executable === true
    || capability?.actionability?.revealable === true
  ));
}

function capabilitiesForDecision(decision = {}, observation = {}) {
  const page = observation.page || {};
  if (Array.isArray(decision.availableTransitions)) {
    const ids = new Set(decision.availableTransitions.map((transition) => transition.controlId).filter(Boolean));
    return (page.controls || []).filter((control) => (
      ids.has(control.controlId)
      && controlBelongsToCurrentSurface(control, page)
      && controlHasExecutableCapability(control)
    ));
  }
  const group = (page.decisionGroups || []).find((item) => groupId(item) === decision.decisionGroupId) || {};
  const ids = new Set([
    ...(group.alternativeControlIds || []),
    ...(group.semanticCorrectionControlIds || []),
    ...(group.alternatives || []).map((item) => item.controlId)
  ].filter(Boolean));
  return (page.controls || []).filter((control) => {
    if (!controlBelongsToCurrentSurface(control, page) || !controlHasExecutableCapability(control)) return false;
    // When the browser supplies explicit alternatives, that exact set owns
    // eligibility. Section siblings and page-wide controls cannot leak in.
    return ids.size ? ids.has(control.controlId) : control.decisionGroupId === decision.decisionGroupId;
  });
}

function optionPrice(control = {}) {
  const amount = Number(control.structuredPrice?.amount ?? control.priceAmount);
  return Number.isFinite(amount) ? amount : null;
}

function optionLooksPaid(control = {}) {
  if (optionLooksExplicitlyFree(control)) return false;
  return Number(optionPrice(control)) > 0
    || /money|payment|paid|purchase|premium|upgrade|add_paid/.test(lower(`${control.risk || ""} ${control.semantic || ""}`));
}

function optionLooksExplicitlyFree(control = {}) {
  return optionPrice(control) === 0
    || /safe_decline|decline|free|\bincluded\b|no[_ -]?extra|no (?:checked|hand|cabin|hold) (?:bag|baggage)|without|none|skip|remove|opt[_ -]?out|not included/.test(
      lower(`${control.risk || ""} ${control.semantic || ""} ${control.label || ""}`)
    );
}

function optionIsBoundedChoice(control = {}) {
  return /radio|checkbox|option|choice/.test(lower(`${control.kind || ""} ${control.role || ""} ${control.semantic || ""}`));
}

function decisionOptionContract(decision = {}, observation = {}) {
  if (Array.isArray(decision.availableTransitions)) {
    const transitions = decision.availableTransitions.filter((transition) => transition.executable);
    const linkedCorrectionIds = new Set((observation.page?.semanticOwnershipLinks || [])
      .filter((link) => (
        link.status === "resolved"
        && link.sourceDecisionGroupId === decision.decisionGroupId
        && link.intendedOutcome
        && link.intendedOutcome !== "unknown"
      ))
      .map((link) => link.correctionControlId));
    const paidIds = transitions.filter((transition) => transition.paid).map((transition) => transition.controlId);
    const generallyFreeIds = transitions.filter((transition) => (
      !transition.paid && optionLooksExplicitlyFree(transition)
    )).map((transition) => transition.controlId);
    const desiredIds = new Set(decision.userIntent?.desiredControlIds || []);
    const eligibleIntentIds = new Set(decision.userIntent?.eligibleOptionIds || []);
    const exactFreeIds = generallyFreeIds.filter((controlId) => desiredIds.has(controlId));
    const policyChoiceBounded = ["constraint", "exact", "ambiguous", "unavailable"].includes(decision.userIntent?.match);
    const constrainedFreeIds = generallyFreeIds.filter((controlId) => eligibleIntentIds.has(controlId));
    const freeIds = policyChoiceBounded
      ? (exactFreeIds.length ? exactFreeIds : constrainedFreeIds)
      : generallyFreeIds;
    const correctionIds = transitions.filter((transition) => (
      linkedCorrectionIds.has(transition.controlId)
      || (decision.status === "conflicted" && desiredIds.has(transition.controlId))
    ))
      .map((transition) => transition.controlId);
    const policyAllowedIds = transitions.filter((transition) => (
      desiredIds.has(transition.controlId)
      || (decision.userIntent?.match === "constraint" && eligibleIntentIds.has(transition.controlId))
      || linkedCorrectionIds.has(transition.controlId)
    )).map((transition) => transition.controlId);
    return {
      eligibleControlIds: transitions.map((transition) => transition.controlId),
      freeControlIds: freeIds,
      paidControlIds: paidIds,
      correctionControlIds: correctionIds,
      policyAllowedControlIds: policyAllowedIds,
      policyChoiceBounded
    };
  }
  const eligible = capabilitiesForDecision(decision, observation);
  const linkedCorrectionIds = new Set((observation.page?.semanticOwnershipLinks || [])
    .filter((link) => (
      link.status === "resolved"
      && link.sourceDecisionGroupId === decision.decisionGroupId
      && link.intendedOutcome
      && link.intendedOutcome !== "unknown"
    ))
    .map((link) => link.correctionControlId));
  const paidIds = new Set(eligible.filter(optionLooksPaid).map((control) => control.controlId));
  const hasPaidSibling = paidIds.size > 0;
  const freeIds = eligible.filter((control) => (
    !paidIds.has(control.controlId)
    && (
      optionLooksExplicitlyFree(control)
      // Inferring "free" from a paid sibling is needed for raw baggage
      // choices such as No hand baggage versus 8 kg. A seat modal is broader:
      // it also contains traveler rows, legends and navigation controls.
      || (hasPaidSibling && decision.family === "baggage" && optionIsBoundedChoice(control))
    )
  )).map((control) => control.controlId);
  return {
    eligibleControlIds: eligible.map((control) => control.controlId),
    freeControlIds: freeIds,
    paidControlIds: [...paidIds],
    correctionControlIds: eligible.filter((control) => linkedCorrectionIds.has(control.controlId)).map((control) => control.controlId),
    policyAllowedControlIds: [],
    policyChoiceBounded: false
  };
}

function ambiguityGoal(observation = {}, reason = "unknown_surface") {
  const surface = currentSurface(observation.page || {});
  return Object.freeze({
    goalId: `${observation.observationId || "observation"}:goal:interpret_surface`,
    semanticGoal: "interpret and resolve the current foreground surface",
    semanticType: "surface_ambiguity",
    desiredValue: "safe_progress",
    decisionGroupId: "",
    requirementId: "",
    surfaceId: surface.id || "surface-page",
    observationId: observation.observationId || "",
    selectionMode: "ai_ambiguity",
    ambiguityReason: reason,
    postcondition: { type: "surface_change_or_feedback" }
  });
}

function goalForDecision(decision = {}, observation = {}, userPolicy = {}, traveler = {}) {
  const options = decisionOptionContract(decision, observation);
  const desiredSemanticOutcome = decision.userIntent?.desiredOutcome || "";
  const desiredPolicyOutcome = desiredSemanticOutcome || "selected_policy_allowed_option";
  const observationId = observation.observationId || "observation";
  return Object.freeze({
    goalId: `${observationId}:goal:${decision.decisionGroupId}`,
    semanticGoal: `resolve ${decision.subject?.label || `the exact current ${decision.family || "checkout"} decision`}`,
    semanticType: decision.subject?.key || decision.family || "decision",
    desiredValue: desiredPolicyOutcome,
    desiredPolicyOutcome,
    desiredSemanticOutcome,
    canonicalDecisionId: decision.decisionId,
    canonicalSubject: decision.subject || null,
    controlType: decision.controlType || "",
    userIntentMatch: decision.userIntent?.match || "none",
    profileResolutionReason: decision.userIntent?.reason || "",
    authorization: decision.userIntent?.authorization || null,
    decisionGroupId: decision.decisionGroupId,
    requirementId: decision.requirementId,
    surfaceId: decision.surfaceId,
    observationId,
    eligibleAlternativeControlIds: Object.freeze(options.eligibleControlIds),
    policyAllowedControlIds: Object.freeze(options.policyAllowedControlIds),
    policyChoiceBounded: options.policyChoiceBounded === true,
    freeAlternativeControlIds: Object.freeze(options.freeControlIds),
    paidAlternativeControlIds: Object.freeze(options.paidControlIds),
    semanticCorrectionControlIds: Object.freeze(options.correctionControlIds),
    decisionStatus: decision.status,
    forceAiResolution: ["conflicted", "blocked"].includes(decision.status),
    postcondition: Object.freeze({
      type: "decision_group_resolved",
      decisionGroupId: decision.decisionGroupId,
      desiredPolicyOutcome,
      desiredSemanticOutcome,
      eligibleAlternativeControlIds: options.eligibleControlIds
    })
  });
}

function navigationGoal(observation = {}, controlIds = []) {
  const surface = currentSurface(observation.page || {});
  return Object.freeze({
    goalId: `${observation.observationId || "observation"}:goal:continue`,
    semanticGoal: surface.type === "page" ? "continue checkout" : "advance the current foreground surface",
    semanticType: "navigation",
    desiredValue: "next_stage",
    decisionGroupId: "",
    requirementId: "",
    surfaceId: surface.id || "surface-page",
    observationId: observation.observationId || "",
    actionableControlIds: [...new Set(controlIds)],
    postcondition: { type: "stage_exit_or_feedback" }
  });
}

function blockedNavigationGoal(observation = {}, decision = null) {
  const surface = currentSurface(observation.page || {});
  const controlId = clean(decision?.physicalControlIds?.[0]);
  const control = (observation.page?.controls || []).find((item) => item.controlId === controlId) || {};
  const blockers = [
    ...(observation.page?.stageExit?.blockers || []),
    ...(observation.page?.validationIssues || []).map((issue) => issue.message || issue.label || issue.code)
  ].map(clean).filter(Boolean);
  return Object.freeze({
    goalId: `${observation.observationId || "observation"}:goal:diagnose_blocked_navigation`,
    semanticGoal: `diagnose why ${clean(control.label || decision?.subject?.label || "Continue")} is unavailable`,
    semanticType: "blocked_navigation",
    desiredValue: "identify_and_resolve_blocker",
    decisionGroupId: "",
    requirementId: "",
    surfaceId: surface.id || "surface-page",
    observationId: observation.observationId || "",
    diagnosticControlId: controlId,
    actionableControlIds: controlId ? [controlId] : [],
    blockerEvidence: Object.freeze(blockers),
    postcondition: Object.freeze({
      type: "navigation_enabled_or_blocker_identified",
      controlId,
      previousDisabled: control.disabled === true || control.state?.disabled === true
    })
  });
}

function terminalForStage(stage = "unknown") {
  if (stage === "payment") return "payment_review_reached";
  if (stage === "confirmation") return "confirmation_reached";
  return "active";
}

function paymentReviewBoundaryEvidence(observation = {}, stageDecisionEvidence = {}, transactionReview = null, traveler = {}) {
  const page = observation.page || {};
  const controls = (page.controls || []).filter((control) => (
    controlBelongsToCurrentSurface(control, page)
    && controlHasExecutableCapability(control)
  ));
  const semanticText = (control = {}) => lower([
    control.fieldType,
    control.field,
    control.semanticType,
    control.semantic,
    control.name,
    control.autocomplete,
    control.testId,
    control.label,
    control.stableKey
  ].filter(Boolean).join(" "));
  const paymentMethodControlIds = controls
    .filter((control) => /payment.?method|apple.?pay|credit.?card|debit.?card/.test(semanticText(control)))
    .map((control) => control.controlId);
  const paymentCredentialControlIds = controls
    .filter((control) => /card.?number|card.?expiry|security.?code|card.?cvc|\bcvc\b|\bcvv\b|cc-number|cc-exp|cc-csc/.test(semanticText(control)))
    .map((control) => control.controlId);
  const payControlIds = controls
    .filter((control) => /(?:^|[^a-z0-9])(?:pay(?:\s+(?:now|securely|with)\b|\s+\d)|confirm\s+and\s+pay\b|submit\s+payment\b|complete\s+purchase\b)/.test(semanticText(control)))
    .map((control) => control.controlId);
  const pendingContactControlIds = controls
    .filter((control) => {
      const semantics = semanticText(control);
      const email = /(?:^|[^a-z])email(?:[^a-z]|$)/.test(semantics) && !/confirm.?email/.test(semantics);
      const phone = /(?:^|[^a-z])(?:phone|mobile|tel-national)(?:[^a-z]|$)/.test(semantics)
        && !/country|prefix|calling.?code/.test(semantics);
      if (!email && !phone) return false;
      const expectedValue = email
        ? clean(traveler.email || traveler.contact_email || traveler.billing_email)
        : clean(traveler.phone || traveler.mobile || traveler.phone_number);
      const state = control.state || {};
      const missingValue = !state.valuePresent && !clean(state.normalizedValue || state.valueText || state.value);
      return state.invalid === true || ((expectedValue || state.required === true || control.required === true) && missingValue);
    })
    .map((control) => control.controlId);
  const step = lower(page.step || page.pageStep);
  const transactionFacts = page.transactionFacts
    || transactionReview?.current
    || transactionReview?.baseline
    || {};
  const hasReviewEnvelope = transactionReview?.ready === true || Boolean(
    transactionFacts.currency
    && transactionFacts.totalPrice?.amount != null
    && (transactionFacts.travelers || []).length
  );
  const reviewContext = /payment|confirmation|review/.test(step)
    || (transactionFacts.provenance || []).some((entry) => entry?.source === "payment_summary")
    || stageDecisionEvidence.payment?.progress === true
    || stageDecisionEvidence.payment?.heading === true;
  const strongStageEvidence = stageDecisionEvidence.paymentSignals >= 3
    || (
      stageDecisionEvidence.paymentSignals >= 2
      && (paymentMethodControlIds.length || paymentCredentialControlIds.length)
    );
  const verifiedPaymentStage = transactionReview?.ready === true
    && stageDecisionEvidence.paymentSignals >= 2
    && Boolean(
      stageDecisionEvidence.payment?.route
      || stageDecisionEvidence.payment?.progress
      || stageDecisionEvidence.payment?.heading
    );
  // A lone hidden CVV/card field is not a payment-review boundary. Require
  // either mutually reinforcing payment-stage evidence or an owned final
  // envelope together with the actual commit and payment-method controls.
  const observed = Boolean(
    verifiedPaymentStage
    || strongStageEvidence
    || (
      hasReviewEnvelope
      && payControlIds.length
      && (paymentMethodControlIds.length || paymentCredentialControlIds.length)
    )
  );
  return Object.freeze({
    observed,
    reviewContext,
    hasReviewEnvelope,
    payControlIds: Object.freeze(payControlIds),
    paymentMethodControlIds: Object.freeze(paymentMethodControlIds),
    paymentCredentialControlIds: Object.freeze(paymentCredentialControlIds),
    pendingContactControlIds: Object.freeze(pendingContactControlIds)
  });
}

function surfaceClassFrom(page = {}) {
  const surface = currentSurface(page);
  if (surface.type === "page") return "navigation";
  if (["choice_set", "form", "review_confirmation", "site_failure", "warning", "navigation", "information", "unknown"].includes(surface.surfaceClass)) {
    return surface.surfaceClass;
  }
  const controls = (page.controls || []).filter((control) => controlBelongsToCurrentSurface(control, page));
  const effects = new Set(controls.map((control) => control.physicalEffect).filter(Boolean));
  const text = lower(`${surface.label || ""} ${controls.map((control) => control.ownText || control.label || "").join(" ")}`);
  if (controls.filter((control) => /radio|checkbox|option/.test(lower(`${control.kind || ""} ${control.role || ""}`))).length >= 2) return "choice_set";
  if (controls.some((control) => control.physicalEffect === "set_field_value" || /field|textbox|combobox/.test(lower(`${control.kind || ""} ${control.role || ""}`)))) return "form";
  if (/review|verify|check your (?:details|information)/.test(text)
    && (effects.has("advance_surface") || effects.has("advance_checkout_stage") || /continue.*payment/.test(text))) return "review_confirmation";
  if (/warning|are you sure|attention|problem|error/.test(text)) return "warning";
  if (effects.has("advance_surface") || effects.has("advance_checkout_stage") || /\bnext|continue|proceed\b/.test(text)) return "navigation";
  if (!controls.length) return "information";
  return "unknown";
}

function stableOutcome(previous = {}, fallbackId = "", type = "") {
  const sameType = previous && previous.type === type;
  return Object.freeze({
    outcomeId: sameType && previous.outcomeId ? previous.outcomeId : fallbackId,
    type
  });
}

function durableOutcomeHierarchy(previousTaskState = {}, stage = "unknown", terminalStatus = "active") {
  const transactionBase = stableOutcome(
    previousTaskState.transactionOutcome,
    "transaction_outcome:checkout_to_payment_review",
    "checkout_to_payment_review"
  );
  const stageBase = stableOutcome(
    previousTaskState.stageOutcome,
    "stage_outcome:reach_payment_review",
    "reach_payment_review"
  );
  const completed = terminalStatus === "payment_review_reached";
  const stageOutcome = Object.freeze({
    ...stageBase,
    parentOutcomeId: transactionBase.outcomeId,
    status: completed ? "completed" : "active",
    observedStage: stage,
    completionEvidence: completed ? "fresh_payment_evidence" : "",
    outcomeContract: outcomeContractForGoal({
      semanticGoal: "reach payment review",
      semanticType: "payment_review",
      desiredValue: "payment_review_reached"
    })
  });
  const transactionOutcome = Object.freeze({
    ...transactionBase,
    status: completed ? "completed" : "active",
    activeStageOutcomeId: stageOutcome.outcomeId,
    desiredOutcome: "payment_review_reached"
  });
  return { transactionOutcome, stageOutcome };
}

function surfaceSemanticKey(surface = {}, surfaceClass = "unknown") {
  const progress = surface.foreground?.progressMarkers || surface.visualState?.foreground?.progressMarkers || {};
  return lower([
    surfaceClass,
    surface.taskHint,
    progress.flightOrdinal,
    progress.route,
    clean(surface.label).slice(0, 120)
  ].filter(Boolean).join("|"));
}

function surfaceContractForGoal(goal = {}, surfaceClass = "unknown", foreground = false) {
  if (goal.kind === "profile_field" || goal.decisionGroupId) return outcomeContractForGoal(goal);
  if (!foreground) return outcomeContractForGoal(goal);
  if (surfaceClass === "review_confirmation") {
    return Object.freeze({
      outcomeId: "",
      taskOutcome: "current_surface_completed",
      acceptablePhysicalEffects: Object.freeze(["advance_surface", "advance_checkout_stage", "reveal_control"]),
      completionEvidence: Object.freeze(["fresh_surface_progress", "fresh_stage_change", "fresh_payment_stage"])
    });
  }
  if (surfaceClass === "warning" || surfaceClass === "navigation" || surfaceClass === "choice_set") {
    return Object.freeze({
      outcomeId: "",
      taskOutcome: "current_surface_completed",
      acceptablePhysicalEffects: Object.freeze(["select_free_option", "open_surface", "advance_surface", "advance_checkout_stage", "reveal_control"]),
      completionEvidence: Object.freeze(["fresh_surface_progress", "fresh_surface_replacement", "fresh_stage_change"])
    });
  }
  if (surfaceClass === "information") {
    return Object.freeze({
      outcomeId: "",
      taskOutcome: "current_surface_completed",
      acceptablePhysicalEffects: Object.freeze(["dismiss_surface", "open_surface", "reveal_control"]),
      completionEvidence: Object.freeze(["fresh_surface_replacement"])
    });
  }
  return outcomeContractForGoal(goal);
}

function createSurfaceSubgoal(previousTaskState = {}, goal = null, surface = {}, surfaceClass = "unknown", stageOutcome = {}) {
  if (!goal) return null;
  const semanticKey = surfaceSemanticKey(surface, surfaceClass);
  const previous = previousTaskState.surfaceSubgoal || {};
  const subgoalId = previous.semanticKey === semanticKey && previous.subgoalId
    ? previous.subgoalId
    : `${stageOutcome.outcomeId}:surface:${semanticKey || "page"}`;
  const foreground = surface.type !== "page";
  const outcomeContract = surfaceContractForGoal(goal, surfaceClass, foreground);
  return Object.freeze({
    subgoalId,
    parentOutcomeId: stageOutcome.outcomeId,
    semanticKey,
    surfaceId: surface.id || "surface-page",
    surfaceType: surface.type || "page",
    surfaceClass,
    status: "active",
    semanticGoal: goal.semanticGoal || "",
    outcomeContract: Object.freeze({ ...outcomeContract, outcomeId: subgoalId })
  });
}

function reduceTaskState({
  previousTaskState = {},
  observation = {},
  previousActionResult = null,
  userPolicy = {},
  traveler = {},
  transactionReview = null,
  parentObjective = null,
  blockedProfileGoalKeys = []
} = {}) {
  const rawPage = observation.page || {};
  const semanticCompilation = agentContract.compileSemanticCheckout(rawPage);
  const page = {
    ...rawPage,
    controls: semanticCompilation.controls,
    decisionGroups: semanticCompilation.decisionGroups,
    decisionContracts: semanticCompilation.decisionContracts,
    semanticReadiness: semanticCompilation.semanticReadiness,
    semanticCompilation
  };
  observation = { ...observation, page };
  const normalizedProfilePolicy = userPolicy.profilePolicy || normalizeProfilePolicy({ userPolicy, traveler });
  const surface = currentSurface(page);
  const { stage, evidence: stageDecisionEvidence } = decideStage(observation);
  const paymentReviewBoundary = paymentReviewBoundaryEvidence(observation, stageDecisionEvidence, transactionReview, traveler);
  const fingerprint = surfaceFingerprint(stage, surface, observation);
  const meaningfulSurfaceChange = Boolean(previousTaskState.surfaceFingerprint
    && previousTaskState.surfaceFingerprint !== fingerprint);
  const completions = completedMap(previousTaskState);
  const authoritativeActionResult = previousActionResult || observation.lastActionResult || null;
  const verifiedExpectedOutcome = authoritativeActionResult?.expectedOutcome || {};
  const verifiedAction = authoritativeActionResult?.action || {};
  const verifiedDecisionGroupId = clean(
    verifiedExpectedOutcome.decisionGroupId
    || authoritativeActionResult?.decisionGroupId
    || verifiedAction.decisionGroupId
    || authoritativeActionResult?.targetSnapshot?.decisionGroupId
  );
  const verifiedFreeSelection = Boolean(
    authoritativeActionResult?.verified === true
    && authoritativeActionResult?.expectedOutcomeObserved === true
    && authoritativeActionResult?.postconditionSatisfied === true
    && verifiedExpectedOutcome.type === "exact_free_option_selected"
    && verifiedDecisionGroupId
    && (
      authoritativeActionResult?.mechanicalEffect === "select_free_option"
      || verifiedAction.mechanicalEffect === "select_free_option"
      || verifiedAction.affordance?.physicalEffect === "select_free_option"
      || verifiedAction.affordance?.effect === "select_free_option"
      || verifiedExpectedOutcome.expectedDisposition === "decline_free_no_extra"
    )
  );
  if (verifiedFreeSelection) {
    const instanceId = clean(
      authoritativeActionResult.decisionInstanceId
      || verifiedAction.decisionInstanceId
      || (
        previousTaskState.currentGoal?.decisionGroupId === verifiedDecisionGroupId
          ? previousTaskState.currentGoal.decisionInstanceId
          : ""
      )
      || verifiedDecisionGroupId
    );
    completions.set(instanceId, {
      decisionGroupId: verifiedDecisionGroupId,
      instanceId,
      requirementId: clean(
        authoritativeActionResult.requirementId
        || verifiedExpectedOutcome.requirementId
        || previousTaskState.currentGoal?.requirementId
      ),
      surfaceId: clean(
        verifiedExpectedOutcome.surfaceId
        || authoritativeActionResult.targetSnapshot?.surfaceId
        || previousTaskState.currentGoal?.surfaceId
      ),
      status: "satisfied",
      selectedControlId: clean(
        verifiedExpectedOutcome.expectedSelectedControlId
        || verifiedExpectedOutcome.controlId
        || authoritativeActionResult.controlId
        || verifiedAction.controlId
      ),
      completionReason: "verified_exact_free_option",
      observationId: observation.observationId || ""
    });
  }
  const observedDecisions = (page.decisionGroups || []).filter((group) => groupId(group)).map((group) => {
    const instanceId = decisionInstanceKey(group, observation);
    const previousGroupCompletion = [...(previousTaskState.completedOutcomes || [])]
      .reverse()
      .find((record) => groupId(record) === groupId(group)) || null;
    const progress = page.foreground?.progressMarkers
      || page.visualState?.foreground?.progressMarkers
      || {};
    const repeatedInstanceVisible = Boolean(
      progress.flightOrdinal
      || progress.route
      || progress.passengerOrdinal
      || progress.travelerOrdinal
      || progress.segment
    );
    const sameSurfaceCompletion = previousGroupCompletion && (
      (previousTaskState.surfaceFingerprint && previousTaskState.surfaceFingerprint === fingerprint)
      || !repeatedInstanceVisible
    )
      ? previousGroupCompletion
      : null;
    const previousCompletion = completions.get(instanceId) || sameSurfaceCompletion;
    const normalizedDecision = canonicalDecisionForGroup({
      group,
      page,
      previousCompletion,
      userPolicy,
      traveler
    });
    const decision = Object.freeze({
      ...normalizedDecision,
      instanceId
    });
    if (COMPLETED.has(decision.status)) {
      if (sameSurfaceCompletion) {
        completions.delete(clean(sameSurfaceCompletion.instanceId || groupKey(sameSurfaceCompletion)));
      }
      completions.set(instanceId, {
        decisionGroupId: decision.decisionGroupId,
        instanceId: decision.instanceId,
        requirementId: decision.requirementId,
        surfaceId: decision.surfaceId,
        status: decision.status,
        selectedControlId: decision.selectedControlId,
        completionReason: decision.completionReason,
        observationId: observation.observationId || ""
      });
    } else if (decision.reopenEvidence) {
      completions.delete(instanceId);
      if (sameSurfaceCompletion) {
        completions.delete(clean(sameSurfaceCompletion.instanceId || groupKey(sameSurfaceCompletion)));
      }
    }
    return decision;
  });
  const observedPhysicalControlIds = new Set(observedDecisions.flatMap((decision) => (
    decision.physicalControlIds || []
  )));
  const canonicalControlDecisions = buildCanonicalDecisions({
    page: { ...page, decisionGroups: [] },
    userPolicy,
    traveler
  }).filter((decision) => (
    !(decision.physicalControlIds || []).some((controlId) => observedPhysicalControlIds.has(controlId))
  ));
  const canonicalDecisions = Object.freeze([
    ...observedDecisions,
    ...canonicalControlDecisions
  ]);

  const foreground = surface.type !== "page";
  const owned = canonicalDecisions.filter((decision) => {
    if (!foreground) return decision.surfaceId === "surface-page" || decision.surfaceType === "page";
    if (decision.surfaceId === surface.id || decision.decisionGroupId === surface.decisionGroupId) return true;
    // Surface metadata can lag behind a portal/rerender. Exact current-surface
    // controls owned by the decision are stronger than that stale container
    // label and keep a proven paid conflict ahead of navigation.
    return capabilitiesForDecision(decision, observation).length > 0;
  });
  const activeDecisions = owned
    .filter((decision) => GOAL_CREATING.has(decision.status))
    .sort((left, right) => {
      const priority = (decision) => {
        if (decision.status === "conflicted" && (
          decisionOptionContract(decision, observation).freeControlIds.length
          || decisionOptionContract(decision, observation).correctionControlIds.length
        )) return 0;
        if (decision.status === "conflicted") return 1;
        if (decision.status === "blocked") return 2;
        return 3;
      };
      return priority(left) - priority(right);
    });
  const suspendedDecisions = foreground
    ? canonicalDecisions.filter((decision) => decision.surfaceId !== surface.id && GOAL_CREATING.has(decision.status))
    : [];
  const validationBlockers = (page.validationIssues || []).filter((issue) => issue.stageWide === true || !issue.controlId || (page.controls || []).some((control) => (
    control.controlId === issue.controlId && controlBelongsToCurrentSurface(control, page)
  )));
  const controlIds = forwardControlIds(observation);
  const blockedNavigationDecision = owned.find((decision) => (
    decision.controlType === CONTROL_TYPES.NAVIGATION_ACTION
    && decision.currentState?.available !== true
    && (decision.physicalControlIds || []).some(Boolean)
  )) || null;
  const profileEvaluationStage = paymentReviewBoundary.observed ? "traveler_information" : stage;
  const baseProfileReadiness = profileStageReadiness({
    ...observation,
    page: { ...page, step: profileEvaluationStage }
  }, traveler);
  const profileSelection = profileEvaluationStage === "traveler_information"
    && baseProfileReadiness.profileStage
    && !baseProfileReadiness.ready
    ? selectExecutableProfileGoal(
        { ...observation, page: { ...page, step: profileEvaluationStage } },
        traveler,
        previousTaskState.currentGoal,
        { blockedGoalKeys: blockedProfileGoalKeys }
      )
    : { goal: null, blockedFields: [], failureCode: "" };
  const profileReadiness = Object.freeze({
    ...baseProfileReadiness,
    temporarilyBlockedFields: Object.freeze(profileSelection.blockedFields || []),
    blockedReasonCode: baseProfileReadiness.missingUserData?.length
      ? "MISSING_PROFILE_DATA"
      : profileSelection.failureCode || ""
  });
  const selectedProfileGoal = profileSelection.goal;
  const profileGoal = paymentReviewBoundary.observed
    && selectedProfileGoal
    && !/email|phone|contact/.test(lower(`${selectedProfileGoal.semanticType || ""} ${selectedProfileGoal.logicalFieldId || ""}`))
      ? null
      : selectedProfileGoal;
  const surfaceClass = surfaceClassFrom(page);
  const siteFailure = surfaceClass === "site_failure" && foreground
    ? Object.freeze({
        active: true,
        surfaceId: surface.id || "",
        message: clean(surface.label || surface.text || "The checkout site reported an unrecoverable error.").slice(0, 600),
        observedControlIds: Object.freeze((page.controls || [])
          .filter((control) => controlBelongsToCurrentSurface(control, page))
          .map((control) => control.controlId)
          .filter(Boolean))
      })
    : null;
  const observedTerminalStatus = terminalForStage(stage);
  const previousTerminalLatch = previousTaskState.terminalGoalLatch || {};
  const pendingPaymentReviewContact = Boolean(
    paymentReviewBoundary.observed
    && paymentReviewBoundary.pendingContactControlIds.length
  );
  const paymentCompletionObserved = !siteFailure
    && paymentReviewBoundary.observed
    && !pendingPaymentReviewContact
    && transactionReview?.ready === true;
  const transactionReviewBlocked = !siteFailure
    && paymentReviewBoundary.observed
    && !pendingPaymentReviewContact
    && transactionReview?.ready !== true;
  const terminalGoalLatch = Object.freeze(paymentCompletionObserved || previousTerminalLatch.locked === true
    ? {
        locked: true,
        goalId: "reach_payment_review",
        terminalStatus: "payment_review_reached",
        completedObservationId: previousTerminalLatch.completedObservationId || observation.observationId || "",
        completionEvidence: previousTerminalLatch.completionEvidence || "fresh_payment_evidence"
      }
    : {
        locked: false,
        goalId: "reach_payment_review",
        terminalStatus: "active",
        completedObservationId: "",
        completionEvidence: ""
      });
  const previousStage = clean(previousTaskState.stage);
  const leftActiveCheckout = Boolean(
    stageDecisionEvidence.newSearchRoute
    && previousStage
    && !["unknown", "flight_selection"].includes(previousStage)
    && previousTaskState.terminalStatus === "active"
  );
  // Payment-looking UI is evidence of the stage, not proof that the requested
  // transaction reached review intact. Only the verified transaction envelope
  // may complete and latch the task.
  const effectiveObservedTerminalStatus = (siteFailure
    || transactionReviewBlocked
    || observedTerminalStatus === "payment_review_reached")
    ? "active"
    : observedTerminalStatus;
  const terminalStatus = terminalGoalLatch.locked
    ? "payment_review_reached"
    : (leftActiveCheckout ? "checkout_left" : effectiveObservedTerminalStatus);
  const { transactionOutcome, stageOutcome } = durableOutcomeHierarchy(
    previousTaskState,
    siteFailure ? "unknown" : stage,
    terminalStatus
  );
  const paymentEvidence = Object.freeze({
    ...stageDecisionEvidence.payment,
    signalCount: stageDecisionEvidence.paymentSignals,
    boundaryObserved: paymentReviewBoundary.observed,
    pendingContact: pendingPaymentReviewContact,
    boundary: paymentReviewBoundary,
    currentlyObserved: paymentCompletionObserved,
    observed: terminalGoalLatch.locked,
    transactionVerified: transactionReview?.ready === true,
    missingTransactionFacts: Object.freeze(transactionReview?.missingFacts || []),
    transactionContradictions: Object.freeze(transactionReview?.contradictions || [])
  });
  const checkoutBoundary = Object.freeze({
    status: stageDecisionEvidence.newSearchRoute ? "new_search_page" : "checkout",
    leftActiveCheckout,
    route: stageDecisionEvidence.url
  });
  const foregroundOwnsProfileGoal = Boolean(profileGoal && (page.controls || []).some((control) => (
    controlBelongsToCurrentSurface(control, page)
    && String(control.fieldType || control.field || "") === String(profileGoal.semanticType || "")
  )));
  let currentGoal = null;
  let ambiguityReason = "";
  if (terminalStatus === "active") {
    if (siteFailure) {
      // The foreground failure owns the page. Background traveler fields and
      // decisions remain durable facts, but they cannot create an action goal
      // until the failure surface is gone.
      currentGoal = null;
    } else if (paymentReviewBoundary.observed && !profileGoal) {
      currentGoal = null;
      ambiguityReason = pendingPaymentReviewContact
        ? "payment_review_contact_incomplete"
        : transactionReviewBlocked
          ? "transaction_review_incomplete"
          : "payment_review_boundary";
    } else if (profileGoal && (!foreground || foregroundOwnsProfileGoal)) {
      currentGoal = Object.freeze(profileGoal);
    } else if (profileReadiness.profileStage && !profileReadiness.ready && !profileGoal) {
      // An unresolved profile field with no executable actuator must not be
      // replaced by a navigation or unrelated surface goal. A fresh
      // observation will re-evaluate every temporarily blocked field.
      currentGoal = null;
    } else if (activeDecisions.length) {
      const decision = activeDecisions[0];
      const surfaceCapabilities = (page.controls || []).filter((control) => (
        controlBelongsToCurrentSurface(control, page) && controlHasExecutableCapability(control)
      ));
      const decisionCapabilities = capabilitiesForDecision(decision, observation);
      const optionContract = decisionOptionContract(decision, observation);
      const viableControlIds = optionContract.policyChoiceBounded
        ? optionContract.policyAllowedControlIds
        : optionContract.eligibleControlIds;
      const viableDecisionCapabilities = decisionCapabilities.filter((control) => (
        viableControlIds.includes(control.controlId)
      ));
      if (!viableDecisionCapabilities.length && decisionCapabilities.length) {
        const blockedGoal = goalForDecision(decision, observation, userPolicy, traveler);
        currentGoal = Object.freeze({
          ...blockedGoal,
          ambiguity: Object.freeze({
            code: "NO_POLICY_ALLOWED_CANDIDATE",
            reason: "The current decision has executable options, but none matches the selected profile and safety policy."
          })
        });
        ambiguityReason = "no_policy_allowed_candidate";
      } else if (!decisionCapabilities.length && surfaceCapabilities.length) {
        currentGoal = ambiguityGoal(observation, "no_goal_relevant_candidate");
        ambiguityReason = currentGoal.ambiguityReason;
      } else {
        currentGoal = goalForDecision(decision, observation, userPolicy, traveler);
      }
    } else if (validationBlockers.length) {
      currentGoal = ambiguityGoal(observation, "contradictory_or_validation_evidence");
      ambiguityReason = "contradictory_or_validation_evidence";
    } else if (controlIds.length && foreground && ["review_confirmation", "warning", "navigation", "choice_set"].includes(surfaceClass)) {
      currentGoal = navigationGoal(observation, controlIds);
    } else if (foreground && stage === "unknown") {
      currentGoal = ambiguityGoal(observation, "unknown_foreground_surface");
      ambiguityReason = currentGoal.ambiguityReason;
    } else if (controlIds.length) {
      currentGoal = navigationGoal(observation, controlIds);
    } else if (blockedNavigationDecision) {
      currentGoal = blockedNavigationGoal(observation, blockedNavigationDecision);
    } else {
      const currentCapabilities = (page.controls || []).filter((control) => controlBelongsToCurrentSurface(control, page));
      if (foreground || currentCapabilities.length) {
        currentGoal = ambiguityGoal(observation, foreground ? "unknown_foreground_surface" : "no_goal_relevant_candidate");
        ambiguityReason = currentGoal.ambiguityReason;
      }
    }
  }
  const surfaceSubgoal = createSurfaceSubgoal(previousTaskState, currentGoal, surface, surfaceClass, stageOutcome);
  if (currentGoal) {
    currentGoal = Object.freeze({
      ...currentGoal,
      decisionInstanceId: decisionInstanceKey(currentGoal, observation),
      transactionOutcomeId: transactionOutcome.outcomeId,
      stageOutcomeId: stageOutcome.outcomeId,
      surfaceSubgoalId: surfaceSubgoal?.subgoalId || "",
      parentOutcomeContract: stageOutcome.outcomeContract,
      outcomeContract: surfaceSubgoal?.outcomeContract || outcomeContractForGoal(currentGoal, observation)
    });
  }

  return Object.freeze({
    // Durable guidance only. Foreground capability selection happens from the
    // fresh observation; these facts do not authorize or reject a click.
    goal: Object.freeze({ id: "reach_payment_review", status: terminalGoalLatch.locked ? "completed" : "active" }),
    completedRequirements: Object.freeze([...completions.values()].slice(-160)),
    userPreferences: Object.freeze({
      bookingRules: clean(userPolicy.bookingRules || traveler.booking_rules),
      extras: clean(userPolicy.extras),
      seatPolicy: seatPolicyFrom({ userPolicy, traveler }),
      baggage: clean(userPolicy.baggage)
    }),
    safetyRestrictions: Object.freeze({
      declinePaidExtras: normalizedProfilePolicy.constraints.noPaidExtras === true
        || Object.values(normalizedProfilePolicy.constraints.noPaidByFamily || {}).some(Boolean),
      declinePaidExtrasByFamily: Object.freeze(Object.fromEntries(
        ["seat", "baggage", "insurance", "extras"].map((family) => [
          family,
          normalizedProfilePolicy.constraints.noPaidExtras === true
            || normalizedProfilePolicy.constraints.noPaidByFamily?.[family] === true
        ])
      )),
      paymentSubmissionRequiresApproval: true,
      paymentCredentialsBlocked: true
    }),
    paymentEvidence,
    terminalGoalLatch,
    checkoutBoundary,
    stage,
    foregroundSurface: Object.freeze(surface),
    surfaceClass,
    siteFailure,
    transactionOutcome,
    stageOutcome,
    surfaceSubgoal,
    activeDecisions: Object.freeze(activeDecisions),
    observedDecisions: Object.freeze(observedDecisions),
    canonicalDecisions,
    completedOutcomes: Object.freeze([...completions.values()].slice(-160)),
    currentGoal,
    terminalStatus,
    suspendedDecisions: Object.freeze(suspendedDecisions),
    validationBlockers: Object.freeze(validationBlockers),
    stageDecisionEvidence: Object.freeze(stageDecisionEvidence),
    surfaceFingerprint: fingerprint,
    meaningfulSurfaceChange,
    // Surface changes are temporary children of the durable stage outcome.
    // Recovery history is cleared only when that parent changes or completes,
    // otherwise base→modal→base cycles would be forgotten.
    clearObsoleteRecovery: Boolean(
      (previousTaskState.stageOutcome?.outcomeId
        && previousTaskState.stageOutcome.outcomeId !== stageOutcome.outcomeId)
      || stageOutcome.status === "completed"
    ),
    previousActionResult: previousActionResult || null,
    ambiguityReason,
    semanticOwnershipResolutions: Object.freeze(page.semanticOwnershipResolutions || []),
    semanticReadiness: semanticCompilation.semanticReadiness,
    semanticCompilation: Object.freeze({
      unownedMaterialControls: Object.freeze(semanticCompilation.unownedMaterialControls || []),
      unresolvedDecisions: Object.freeze(semanticCompilation.unresolvedDecisions || []),
      currentExecutableObligations: Object.freeze(semanticCompilation.currentExecutableObligations || [])
    }),
    profileReadiness,
    transactionReview: transactionReview ? Object.freeze(transactionReview) : null,
    parentObjective: parentObjective || previousTaskState.parentObjective || null
  });
}

module.exports = {
  ambiguityGoal,
  decideStage,
  durableOutcomeHierarchy,
  reduceTaskState,
  surfaceClassFrom,
  stageEvidence
};
