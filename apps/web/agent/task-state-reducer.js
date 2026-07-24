const { profileStageReadiness, deriveProfileGoal } = require("./skill-expander");
const { currentSurface, controlBelongsToCurrentSurface } = require("./surface-contract");
const { outcomeContractForGoal } = require("./action-semantics");
const { decisionInstanceKey } = require("../../../packages/shared/agent-actions");

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

function controlForGroup(group = {}, page = {}) {
  const selectedId = clean(group.selectedControlId);
  if (!selectedId) return null;
  return (page.controls || []).find((control) => control.controlId === selectedId)
    || (group.alternatives || []).find((control) => control.controlId === selectedId)
    || null;
}

function positiveStructuredPrice(value = {}) {
  const amount = Number(value.structuredPrice?.amount);
  return Number.isFinite(amount) && amount > 0;
}

function transactionSelectionForGroup(group = {}, page = {}) {
  const exactId = groupId(group);
  return (page.transactionFacts?.selectedExtras || []).find((item) => (
    clean(item?.decisionGroupId) === exactId
  )) || null;
}

function paidSelectionEvidence(group = {}, page = {}) {
  const selected = controlForGroup(group, page);
  const selectedEvidence = group.selectedEvidence || {};
  const transactionSelection = transactionSelectionForGroup(group, page);
  const selectedControlId = clean(group.selectedControlId || selectedEvidence.selectedControlId);
  const selectedControl = selectedControlId
    ? (page.controls || []).find((control) => clean(control.controlId) === selectedControlId) || null
    : null;
  const currentSelected = Boolean(
    selectedControl?.selected
    || selectedControl?.state?.checked
    || selectedControl?.state?.selected
  );
  const currentSelectedText = lower(
    page.foreground?.progressMarkers?.selectedText
    || page.visualState?.foreground?.progressMarkers?.selectedText
    || ""
  );
  const explicitUnselectedState = /not selected|unselected|no selection|none selected/.test(currentSelectedText);
  const ownedRemovalGone = Boolean(
    group.removalControlId
    && !(page.controls || []).some((control) => clean(control.controlId) === clean(group.removalControlId))
  );
  if (!transactionSelection
    && explicitUnselectedState
    && ((selectedControlId && !currentSelected) || ownedRemovalGone)) {
    return null;
  }
  const transactionDisposition = lower(transactionSelection?.disposition);
  const transactionPaid = Boolean(transactionSelection && (
    Number(transactionSelection.priceAmount) > 0
    || (
      /paid|money|selected_paid/.test(transactionDisposition)
      && !/decline|free|remove|skip|without|none|not selected|no extra/.test(transactionDisposition)
    )
  ));
  const evidencePaid = selectedEvidence.selected === true
    && selectedEvidence.disposition !== "free"
    && (
      selectedEvidence.disposition === "paid"
      || positiveStructuredPrice(selectedEvidence)
      || /money|paid|purchase|upgrade|select_paid/.test(lower(`${selectedEvidence.risk || ""} ${selectedEvidence.semantic || ""}`))
    );
  if (!transactionPaid && !evidencePaid && (!selected || !optionLooksPaid(selected))) return null;
  const structuredPrice = selectedEvidence.structuredPrice
    || selected?.structuredPrice
    || (transactionSelection && Number.isFinite(Number(transactionSelection.priceAmount))
      ? { amount: Number(transactionSelection.priceAmount), currency: clean(transactionSelection.currency) }
      : null);
  return {
    code: Number(structuredPrice?.amount) > 0
      ? "EXACT_SELECTED_OPTION_PRICE_EXCEEDS_POLICY"
      : "EXACT_SELECTED_OPTION_CONTRADICTS_POLICY",
    decisionGroupId: groupId(group),
    controlId: clean(group.selectedControlId || selectedEvidence.selectedControlId),
    ownerElementId: clean(selectedEvidence.ownerElementId),
    structuredPrice,
    semantic: clean(selectedEvidence.semantic || selected?.semantic || group.selectedSemantic),
    risk: clean(selectedEvidence.risk || selected?.risk || (transactionPaid ? "money" : ""))
  };
}

function validationForGroup(group = {}, page = {}) {
  const ids = new Set([
    groupId(group),
    clean(group.requirementId),
    clean(group.sectionId),
    clean(group.selectedControlId)
  ].filter(Boolean));
  return (page.validationIssues || []).find((issue) => (
    issue.stageWide === true
    || ids.has(clean(issue.decisionGroupId))
    || ids.has(clean(issue.requirementId))
    || ids.has(clean(issue.sectionId))
    || ids.has(clean(issue.controlId))
  )) || null;
}

function policyDeclinesPaidExtras(userPolicy = {}, traveler = {}, family = "extras") {
  if (userPolicy.skipPaidExtrasApproved === true) return true;
  const bookingRules = lower([
    userPolicy.bookingRules,
    traveler.booking_rules,
  ].filter(Boolean).join(" "));
  const appliesToEveryOptionalFamily = /decline all paid|skip all paid|avoid all paid|nothing paid|\bno paid extras?\b|\bno extras?\b|nothing extra/.test(bookingRules);
  if (appliesToEveryOptionalFamily) return true;
  if (family === "seat") {
    const text = lower(`${bookingRules} ${userPolicy.seats || ""} ${traveler.seat_preference || ""}`);
    return /no paid seat|no seat|skip seat|without seat/.test(text);
  }
  if (family === "baggage") {
    const text = lower(`${bookingRules} ${userPolicy.baggage || ""} ${traveler.baggage_preference || ""}`);
    return /no paid (?:bag|baggage)|no checked (?:bag|baggage)|no (?:bag|baggage)|personal item only|without baggage/.test(text);
  }
  if (family === "insurance") {
    const text = lower(`${bookingRules} ${userPolicy.insurance || ""}`);
    return /no insurance|no protection|skip insurance|without protection/.test(text);
  }
  if (family === "extras") {
    const text = lower(`${bookingRules} ${userPolicy.extras || ""}`);
    return /no paid extras?|no extras?|no add.?ons?|no bundles?|no flexible ticket|skip extras?|without extras?/.test(text);
  }
  return false;
}

function paidAuthorizationForDecision(userPolicy = {}, decisionGroupId = "") {
  if (!decisionGroupId) return null;
  const authorizations = Array.isArray(userPolicy.paidExtraAuthorizations)
    ? userPolicy.paidExtraAuthorizations
    : [];
  return authorizations.find((authorization) => (
    authorization?.authorizationId
    && authorization.decisionGroupId === decisionGroupId
  )) || null;
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

function decisionRequestText(group = {}) {
  return lower([
    group.sectionType,
    group.sectionLabel,
    group.requirementId,
    group.label,
    group.semantic,
    ...(group.alternatives || []).map((alternative) => (
      `${alternative.label || ""} ${alternative.semantic || ""} ${alternative.meaning || ""}`
    ))
  ].filter(Boolean).join(" "));
}

function decisionExplicitlyRequested(group = {}, userPolicy = {}, traveler = {}) {
  if (group.explicitlyRequested === true || group.policyRequested === true) return true;
  const request = lower([
    userPolicy.bookingRules,
    userPolicy.extras,
    userPolicy.seats,
    userPolicy.baggage,
    userPolicy.insurance,
    traveler.booking_rules,
    traveler.baggage_preference,
    traveler.seat_preference
  ].filter(Boolean).join(" "));
  if (!request) return false;

  const family = decisionFamily(group);
  const subject = decisionRequestText(group);
  if (family === "seat") return /seat|seating/.test(request);
  if (family === "baggage") return /bag|baggage|luggage|personal item|carry.?on|hand baggage/.test(request);
  if (family === "insurance") return /insurance|protection|coverage|cancellation/.test(request);
  if (family === "extras") return /extra|add.?on|bundle|support|sms|flexible/.test(request);
  if (family === "legal") return /legal|terms|consent/.test(request);
  if (family === "payment") return /payment|card|pay/.test(request);

  // Generic optional controls (for example a newsletter opt-out) are only an
  // obligation when the user request names that subject. Broad checkout or
  // no-paid-extra preferences must not make every untouched checkbox active.
  if (/newsletter|marketing|email offers|promotional/.test(subject)) {
    return /newsletter|marketing|email offers|promotional/.test(request);
  }
  return false;
}

function policyRequestIsConstraintOnly(group = {}, userPolicy = {}, traveler = {}) {
  const request = lower([
    userPolicy.bookingRules,
    userPolicy.extras,
    userPolicy.seats,
    userPolicy.baggage,
    userPolicy.insurance,
    traveler.booking_rules,
    traveler.baggage_preference,
    traveler.seat_preference
  ].filter(Boolean).join(" "));
  const family = decisionFamily(group);
  if (!request) return false;
  if (family === "seat") {
    return /no paid seat|no seat|skip seat|avoid paid/.test(request)
      && !/window|aisle|together|adjacent|specific seat|select (?:a )?seat/.test(request);
  }
  if (family === "baggage") return /no paid (?:bag|baggage)|no (?:bag|baggage)|personal item only|avoid paid/.test(request);
  if (family === "insurance") return /no insurance|no protection|avoid paid/.test(request);
  if (family === "extras") return /no paid|no extra|no add.?on|avoid paid/.test(request);
  return false;
}

function controlsForObservedGroup(group = {}, page = {}) {
  const ids = new Set([
    ...(group.alternativeControlIds || []),
    ...(group.semanticCorrectionControlIds || []),
    ...(group.alternatives || []).map((item) => item.controlId)
  ].filter(Boolean));
  return (page.controls || []).filter((control) => ids.has(control.controlId));
}

function safeForwardExistsForGroup(group = {}, page = {}) {
  const surfaceId = clean(group.surfaceId || "surface-page");
  return (page.controls || []).some((control) => {
    if (surfaceId && clean(control.surfaceId || "surface-page") !== surfaceId) return false;
    if (!controlHasExecutableCapability(control)) return false;
    return /continue|next|proceed|advance|done|finish/.test(lower(`${control.semantic || ""} ${control.label || ""}`));
  });
}

function normalizeObservedDecision(group = {}, page = {}, previousCompletion = null, userPolicy = {}, traveler = {}) {
  const exactId = groupId(group);
  const validation = validationForGroup(group, page);
  const paidEvidence = paidSelectionEvidence(group, page);
  const paidAuthorization = paidAuthorizationForDecision(userPolicy, exactId);
  const observedStatus = lower(group.status);
  const selected = controlForGroup(group, page);
  const selectedEvidence = group.selectedEvidence || {};
  const transactionSelection = transactionSelectionForGroup(group, page);
  const freshTransactionFree = Boolean(transactionSelection
    && Number(transactionSelection.priceAmount) === 0
    && /free|decline|remove|skip|without|none|not selected|no extra/.test(lower(transactionSelection.disposition)));
  const selectedSafe = Boolean(
    selectedEvidence.selected === true && selectedEvidence.disposition === "free"
  ) || freshTransactionFree || Boolean(selected
    && !positiveStructuredPrice(selected)
    && (
      optionLooksExplicitlyFree(selected)
      || /(?:^|\b)safe(?:_|\b)|traveler_title/.test(lower(`${selected.risk || ""} ${selected.semantic || ""}`))
    ));

  const alternatives = controlsForObservedGroup(group, page);
  const actionableAlternatives = alternatives.filter(controlHasExecutableCapability);
  const hasExplicitFreeAlternative = actionableAlternatives.some(optionLooksExplicitlyFree);
  const paidOnlyWithSafeForward = actionableAlternatives.length > 0
    && actionableAlternatives.every(optionLooksPaid)
    && safeForwardExistsForGroup(group, page);
  const constraintOnly = policyRequestIsConstraintOnly(group, userPolicy, traveler);
  const exactSelectionChanged = Boolean(
    previousCompletion?.selectedControlId
    && group.selectedControlId
    && clean(previousCompletion.selectedControlId) !== clean(group.selectedControlId)
  );
  const createsObligation = group.required === true
    || (decisionExplicitlyRequested(group, userPolicy, traveler)
      && (!constraintOnly || hasExplicitFreeAlternative));
  let status = createsObligation ? "active" : "stale";
  let completionReason = "";
  let reopenEvidence = null;
  if (validation) {
    status = "blocked";
    reopenEvidence = { code: "FRESH_VALIDATION_REQUIRES_DECISION", issue: validation };
  } else if (paidEvidence && (
    policyDeclinesPaidExtras(userPolicy, traveler, decisionFamily(group))
    || group.semanticOwnership?.policyCompatibility === "conflict"
  )) {
    status = paidAuthorization ? "blocked" : "conflicted";
    reopenEvidence = paidAuthorization
      ? {
          ...paidEvidence,
          code: "PAID_SELECTION_POLICY_AUTHORIZATION_CONFLICT",
          authorizationId: clean(paidAuthorization.authorizationId)
        }
      : paidEvidence;
  } else if (selectedSafe) {
    status = "satisfied";
    completionReason = "exact_browser_selection";
  } else if (exactSelectionChanged) {
    // A fresh exact selection supersedes the stored outcome. If the new
    // option is not proven unsafe, optional ambiguity stays non-blocking; a
    // required decision can still become active through its own requiredness.
    status = group.required === true ? "active" : "stale";
    reopenEvidence = {
      code: "EXACT_SELECTED_CONTROL_CHANGED",
      decisionGroupId: exactId,
      previousControlId: clean(previousCompletion.selectedControlId),
      selectedControlId: clean(group.selectedControlId)
    };
  } else if (COMPLETED.has(observedStatus)) {
    status = observedStatus === "waived_by_policy" || observedStatus === "waived" ? "waived" : "satisfied";
    completionReason = "fresh_browser_status";
  } else if (previousCompletion) {
    // Missing controls, labels, alternatives and general section prose cannot
    // reopen an exact browser-completed decision.
    status = previousCompletion.status;
    completionReason = "preserved_exact_outcome";
  } else if (constraintOnly && paidOnlyWithSafeForward && !selected) {
    // A negative policy is a restriction, not an instruction to manufacture
    // a free selection. If every observed alternative is paid and the site
    // exposes safe forward navigation, selecting nothing satisfies policy.
    status = "waived";
    completionReason = "policy_constraint_satisfied_without_selection";
  } else if (policyDeclinesPaidExtras(userPolicy, traveler, decisionFamily(group))
    && ["seat", "baggage", "insurance", "extras"].includes(decisionFamily(group))
    && observedStatus === "not_applicable") {
    status = "waived";
    completionReason = "policy_and_fresh_not_applicable_evidence";
  } else if (group.required === false && observedStatus === "not_applicable") {
    status = "waived";
    completionReason = "fresh_not_applicable_evidence";
  }

  return Object.freeze({
    decisionId: exactId,
    decisionGroupId: exactId,
    requirementId: clean(group.requirementId || exactId),
    family: decisionFamily(group),
    status,
    surfaceId: clean(group.surfaceId || "surface-page"),
    surfaceType: clean(group.surfaceType || "page"),
    required: group.required === true,
    selectedControlId: clean(group.selectedControlId),
    selectedLabel: clean(group.selectedLabel),
    completionReason,
    reopenEvidence,
    observed: group
  });
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
  return (page.controls || []).filter((control) => {
    if (!controlBelongsToCurrentSurface(control, page)) return false;
    if (!controlHasExecutableCapability(control)) return false;
    const text = lower(`${control.semantic || ""} ${control.meaning || ""} ${control.label || ""} ${control.risk || ""}`);
    if (/back|previous|edit|change|learn more|details/.test(text)) return false;
    return /navigation|safe_continue|continue|next|proceed|advance|done|close|dismiss|finish/.test(text);
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
    || /safe_decline|decline|free|no[_ -]?extra|without|none|skip|remove|opt[_ -]?out|not included/.test(lower(`${control.risk || ""} ${control.semantic || ""} ${control.label || ""}`));
}

function optionIsBoundedChoice(control = {}) {
  return /radio|checkbox|option|choice/.test(lower(`${control.kind || ""} ${control.role || ""} ${control.semantic || ""}`));
}

function decisionOptionContract(decision = {}, observation = {}) {
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
    correctionControlIds: eligible.filter((control) => linkedCorrectionIds.has(control.controlId)).map((control) => control.controlId)
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
  const preferFree = policyDeclinesPaidExtras(userPolicy, traveler, decision.family)
    && ["seat", "baggage", "insurance", "extras"].includes(decision.family);
  const desiredPolicyOutcome = preferFree ? "selected_free_option" : "selected_policy_allowed_option";
  const observationId = observation.observationId || "observation";
  return Object.freeze({
    goalId: `${observationId}:goal:${decision.decisionGroupId}`,
    semanticGoal: `resolve the exact current ${decision.family || "checkout"} decision`,
    semanticType: decision.family || "decision",
    desiredValue: desiredPolicyOutcome,
    desiredPolicyOutcome,
    decisionGroupId: decision.decisionGroupId,
    requirementId: decision.requirementId,
    surfaceId: decision.surfaceId,
    observationId,
    eligibleAlternativeControlIds: Object.freeze(options.eligibleControlIds),
    freeAlternativeControlIds: Object.freeze(options.freeControlIds),
    paidAlternativeControlIds: Object.freeze(options.paidControlIds),
    semanticCorrectionControlIds: Object.freeze(options.correctionControlIds),
    decisionStatus: decision.status,
    forceAiResolution: ["conflicted", "blocked"].includes(decision.status),
    postcondition: Object.freeze({
      type: "decision_group_resolved",
      decisionGroupId: decision.decisionGroupId,
      desiredPolicyOutcome,
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

function terminalForStage(stage = "unknown") {
  if (stage === "payment") return "payment_review_reached";
  if (stage === "confirmation") return "confirmation_reached";
  return "active";
}

function surfaceClassFrom(page = {}) {
  const surface = currentSurface(page);
  if (surface.type === "page") return "navigation";
  if (["choice_set", "form", "review_confirmation", "warning", "navigation", "information", "unknown"].includes(surface.surfaceClass)) {
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
  const completed = terminalStatus === "payment_review_reached" || stage === "payment";
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
  parentObjective = null
} = {}) {
  const page = observation.page || {};
  const surface = currentSurface(page);
  const { stage, evidence: stageDecisionEvidence } = decideStage(observation);
  const fingerprint = surfaceFingerprint(stage, surface, observation);
  const meaningfulSurfaceChange = Boolean(previousTaskState.surfaceFingerprint
    && previousTaskState.surfaceFingerprint !== fingerprint);
  const completions = completedMap(previousTaskState);
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
    const normalizedDecision = normalizeObservedDecision(
      group,
      page,
      previousCompletion,
      userPolicy,
      traveler
    );
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

  const foreground = surface.type !== "page";
  const owned = observedDecisions.filter((decision) => {
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
    ? observedDecisions.filter((decision) => decision.surfaceId !== surface.id && GOAL_CREATING.has(decision.status))
    : [];
  const validationBlockers = (page.validationIssues || []).filter((issue) => issue.stageWide === true || !issue.controlId || (page.controls || []).some((control) => (
    control.controlId === issue.controlId && controlBelongsToCurrentSurface(control, page)
  )));
  const controlIds = forwardControlIds(observation);
  const profileReadiness = profileStageReadiness({
    ...observation,
    page: { ...page, step: stage }
  }, traveler);
  const profileGoal = stage === "traveler_information" && profileReadiness.profileStage && !profileReadiness.ready
    ? deriveProfileGoal({ ...observation, page: { ...page, step: stage } }, traveler, previousTaskState.currentGoal)
    : null;
  const observedTerminalStatus = terminalForStage(stage);
  const previousTerminalLatch = previousTaskState.terminalGoalLatch || {};
  const paymentCompletionObserved = observedTerminalStatus === "payment_review_reached";
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
  const terminalStatus = terminalGoalLatch.locked
    ? "payment_review_reached"
    : (leftActiveCheckout ? "checkout_left" : observedTerminalStatus);
  const { transactionOutcome, stageOutcome } = durableOutcomeHierarchy(previousTaskState, stage, terminalStatus);
  const paymentEvidence = Object.freeze({
    ...stageDecisionEvidence.payment,
    signalCount: stageDecisionEvidence.paymentSignals,
    currentlyObserved: paymentCompletionObserved,
    observed: terminalGoalLatch.locked
  });
  const checkoutBoundary = Object.freeze({
    status: stageDecisionEvidence.newSearchRoute ? "new_search_page" : "checkout",
    leftActiveCheckout,
    route: stageDecisionEvidence.url
  });
  const surfaceClass = surfaceClassFrom(page);
  const foregroundOwnsProfileGoal = Boolean(profileGoal && (page.controls || []).some((control) => (
    controlBelongsToCurrentSurface(control, page)
    && String(control.fieldType || control.field || "") === String(profileGoal.semanticType || "")
  )));
  let currentGoal = null;
  let ambiguityReason = "";
  if (terminalStatus === "active") {
    if (profileGoal && (!foreground || foregroundOwnsProfileGoal)) {
      currentGoal = Object.freeze(profileGoal);
    } else if (activeDecisions.length) {
      const decision = activeDecisions[0];
      const surfaceCapabilities = (page.controls || []).filter((control) => (
        controlBelongsToCurrentSurface(control, page) && controlHasExecutableCapability(control)
      ));
      if (!capabilitiesForDecision(decision, observation).length && surfaceCapabilities.length) {
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
      seats: clean(userPolicy.seats),
      baggage: clean(userPolicy.baggage)
    }),
    safetyRestrictions: Object.freeze({
      declinePaidExtras: ["seat", "baggage", "insurance", "extras"].some((family) => policyDeclinesPaidExtras(userPolicy, traveler, family)),
      declinePaidExtrasByFamily: Object.freeze(Object.fromEntries(
        ["seat", "baggage", "insurance", "extras"].map((family) => [family, policyDeclinesPaidExtras(userPolicy, traveler, family)])
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
    transactionOutcome,
    stageOutcome,
    surfaceSubgoal,
    activeDecisions: Object.freeze(activeDecisions),
    observedDecisions: Object.freeze(observedDecisions),
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
    profileReadiness,
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
