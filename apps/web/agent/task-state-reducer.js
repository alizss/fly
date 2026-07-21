const { profileStageReadiness, deriveProfileGoal } = require("./skill-expander");
const { currentSurface, controlBelongsToCurrentSurface } = require("./surface-contract");
const { outcomeContractForGoal } = require("./action-semantics");

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

function paidSelectionEvidence(group = {}, page = {}) {
  const selected = controlForGroup(group, page);
  if (!selected) return null;
  if (!positiveStructuredPrice(selected)) return null;
  return {
    code: "EXACT_SELECTED_OPTION_PRICE_EXCEEDS_POLICY",
    decisionGroupId: groupId(group),
    controlId: clean(group.selectedControlId),
    structuredPrice: selected.structuredPrice
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

function policyDeclinesPaidExtras(userPolicy = {}, traveler = {}) {
  const text = lower([
    userPolicy.bookingRules,
    userPolicy.extras,
    userPolicy.seats,
    traveler.booking_rules,
    traveler.baggage_preference
  ].filter(Boolean).join(" "));
  return /no paid|no extra|no add.?on|no seat|no bag|no baggage|no insurance|avoid paid|personal item only/.test(text)
    || userPolicy.skipPaidExtrasApproved === true;
}

function decisionFamily(group = {}) {
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
  const observedStatus = lower(group.status);
  const selected = controlForGroup(group, page);
  const selectedSafe = Boolean(selected && !positiveStructuredPrice(selected)
    && !/money|payment|legal|purchase|add_paid/.test(lower(`${selected.risk || ""} ${selected.semantic || ""}`)));

  const alternatives = controlsForObservedGroup(group, page);
  const actionableAlternatives = alternatives.filter(controlHasExecutableCapability);
  const hasExplicitFreeAlternative = actionableAlternatives.some(optionLooksExplicitlyFree);
  const paidOnlyWithSafeForward = actionableAlternatives.length > 0
    && actionableAlternatives.every(optionLooksPaid)
    && safeForwardExistsForGroup(group, page);
  const constraintOnly = policyRequestIsConstraintOnly(group, userPolicy, traveler);
  const createsObligation = group.required === true
    || (decisionExplicitlyRequested(group, userPolicy, traveler)
      && (!constraintOnly || hasExplicitFreeAlternative));
  let status = createsObligation ? "active" : "stale";
  let completionReason = "";
  let reopenEvidence = null;
  if (validation) {
    status = "blocked";
    reopenEvidence = { code: "FRESH_VALIDATION_REQUIRES_DECISION", issue: validation };
  } else if (paidEvidence && policyDeclinesPaidExtras(userPolicy, traveler)) {
    status = "conflicted";
    reopenEvidence = paidEvidence;
  } else if (COMPLETED.has(observedStatus) || selectedSafe) {
    status = observedStatus === "waived_by_policy" || observedStatus === "waived" ? "waived" : "satisfied";
    completionReason = selectedSafe ? "exact_browser_selection" : "fresh_browser_status";
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
  } else if (policyDeclinesPaidExtras(userPolicy, traveler)
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
  const text = lower([
    page.text,
    page.summary?.title,
    page.foreground?.heading,
    surface.label,
    ...(page.sections || []).map((section) => `${section.type || ""} ${section.label || ""}`),
    ...(page.decisionGroups || []).map((group) => `${group.sectionType || ""} ${group.sectionLabel || ""}`),
    ...controls.slice(0, 180).map((control) => `${control.field || ""} ${control.semantic || ""} ${control.label || ""} ${control.inputType || ""}`)
  ].filter(Boolean).join(" "));
  const progress = lower(JSON.stringify(page.foreground?.progressMarkers || page.visualState?.foreground?.progressMarkers || {}));
  const payment = {
    route: /(?:^|[\/#?&_-])payment(?:[\/#?&=_-]|$)/.test(url),
    progress: /payment|pay/.test(progress),
    fields: controls.concat(fields).some((control) => /card_number|cardholder|security_code|cvc|cvv|expiry/.test(lower(`${control.field || ""} ${control.semantic || ""} ${control.autocomplete || ""}`))),
    heading: /payment|pay securely|payment details/.test(text),
    orderSection: /payment method|order amount|amount due|total to pay/.test(text)
  };
  const paymentSignals = Object.values(payment).filter(Boolean).length;
  const confirmation = /booking confirmed|booking reference|reservation number|confirmation number|\bpnr\b/.test(text);
  const seat = /seat|seating|seat map/.test(text);
  const traveler = controls.concat(fields).some((control) => /first_name|last_name|full_name|email|phone|date_of_birth|passport/.test(lower(`${control.field || ""} ${control.semantic || ""}`)))
    || /travell?er information|passenger details|contact information/.test(text);
  const extras = (page.decisionGroups || []).some((group) => ["seat", "baggage", "insurance", "extras"].includes(decisionFamily(group)))
    || /baggage|insurance|bundle|flexible ticket|add.?on|upgrade your trip/.test(text);
  const flight = /select flight|choose flight|flight selection|fare selection/.test(text);
  return { payment, paymentSignals, confirmation, seat, traveler, extras, flight, text, url };
}

function decideStage(observation = {}) {
  const evidence = stageEvidence(observation);
  const surface = currentSurface(observation.page || {});
  if (evidence.paymentSignals >= 3 || (evidence.payment.route && evidence.paymentSignals >= 2)) return { stage: "payment", evidence };
  if (evidence.confirmation) return { stage: "confirmation", evidence };
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
  return new Map(records.filter((record) => groupId(record)).map((record) => [groupKey(record), { ...record }]));
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
    || /safe_decline|decline|free|no[_ -]?extra|without|none|skip/.test(lower(`${control.risk || ""} ${control.semantic || ""} ${control.label || ""}`));
}

function optionIsBoundedChoice(control = {}) {
  return /radio|checkbox|option|choice/.test(lower(`${control.kind || ""} ${control.role || ""} ${control.semantic || ""}`));
}

function decisionOptionContract(decision = {}, observation = {}) {
  const eligible = capabilitiesForDecision(decision, observation);
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
    paidControlIds: [...paidIds]
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
  const preferFree = policyDeclinesPaidExtras(userPolicy, traveler)
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
    const key = groupKey(group);
    const decision = normalizeObservedDecision(group, page, completions.get(key) || null, userPolicy, traveler);
    if (COMPLETED.has(decision.status)) {
      completions.set(key, {
        decisionGroupId: decision.decisionGroupId,
        requirementId: decision.requirementId,
        surfaceId: decision.surfaceId,
        status: decision.status,
        selectedControlId: decision.selectedControlId,
        completionReason: decision.completionReason,
        observationId: observation.observationId || ""
      });
    } else if (decision.reopenEvidence) {
      completions.delete(key);
    }
    return decision;
  });

  const foreground = surface.type !== "page";
  const owned = observedDecisions.filter((decision) => (
    foreground
      ? decision.surfaceId === surface.id || decision.decisionGroupId === surface.decisionGroupId
      : decision.surfaceId === "surface-page" || decision.surfaceType === "page"
  ));
  const activeDecisions = owned.filter((decision) => GOAL_CREATING.has(decision.status));
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
  const terminalStatus = terminalForStage(stage);
  const { transactionOutcome, stageOutcome } = durableOutcomeHierarchy(previousTaskState, stage, terminalStatus);
  const paymentEvidence = Object.freeze({
    ...stageDecisionEvidence.payment,
    signalCount: stageDecisionEvidence.paymentSignals,
    observed: terminalStatus === "payment_review_reached"
  });
  const surfaceClass = surfaceClassFrom(page);
  let currentGoal = null;
  let ambiguityReason = "";
  if (terminalStatus === "active") {
    if (profileGoal && !foreground) {
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
    goal: Object.freeze({ id: "reach_payment_review", status: paymentEvidence.observed ? "completed" : "active" }),
    completedRequirements: Object.freeze([...completions.values()].slice(-160)),
    userPreferences: Object.freeze({
      bookingRules: clean(userPolicy.bookingRules || traveler.booking_rules),
      extras: clean(userPolicy.extras),
      seats: clean(userPolicy.seats),
      baggage: clean(userPolicy.baggage)
    }),
    safetyRestrictions: Object.freeze({
      declinePaidExtras: policyDeclinesPaidExtras(userPolicy, traveler),
      paymentSubmissionRequiresApproval: true,
      paymentCredentialsBlocked: true
    }),
    paymentEvidence,
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
