const {
  profileStageReadiness,
  selectNextProfileRequirement,
  verifiedProfileComponentMatchesDescriptor
} = require("./skill-expander");
const { currentSurface, controlBelongsToCurrentSurface } = require("./surface-contract");
const { outcomeContractForGoal } = require("./action-semantics");
const { decisionInstanceKey, semanticGoalKey } = require("../../../packages/shared/agent-actions");
const {
  CONTROL_TYPES,
  canonicalDecisionForGroup,
  isTypedNavigationControl
} = require("./canonical-decision");
const { normalizeProfilePolicy, seatPolicyFrom } = require("./policy-profile");
const { canonicalDecisionOwnerKey } = require("./transaction-facts");
const { canonicalOptionMatch, missingDerivedFactDependency } = require("./logical-field");
const { adaptiveInteractionGoal } = require("./adaptive-interaction");
const {
  currentObligation,
  currentObligationFromGoal,
  decisionFrameOwnsObservation,
  mechanicsForObligation
} = require("./authority-frames");
const agentContract = require("../../extension/src/shared/agent-contract");

const COMPLETED = new Set(["satisfied", "waived", "waived_by_policy"]);
const GOAL_CREATING = new Set(["active", "conflicted", "blocked"]);
const DECISION_EPISODE_FAMILIES = new Set(["fare", "baggage", "seat", "insurance", "extras"]);
const TASK_STATE_REOBSERVE_DEADLINE_MS = 8_000;
const taskStateReadModels = new WeakMap();

function taskMechanics(taskState = {}) {
  return mechanicsForObligation(currentObligation(taskState)) || {};
}

function clean(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function lower(value = "") {
  return clean(value).toLowerCase();
}

function verificationDecisionRecord(decision = {}) {
  const observed = decision.observed || decision.observation || {};
  return Object.freeze({
    decisionGroupId: clean(decision.decisionGroupId),
    instanceId: clean(decision.instanceId || decision.decisionInstanceId),
    requirementId: clean(decision.requirementId),
    canonicalOwnerId: clean(decision.canonicalOwnerId),
    family: clean(decision.family),
    kind: clean(decision.kind),
    semanticType: clean(decision.semanticType),
    status: clean(decision.status),
    surfaceId: clean(decision.surfaceId),
    subjectId: clean(decision.subjectId),
    selectedControlId: clean(decision.selectedControlId),
    selectedValue: clean(decision.selectedValue),
    completionReason: clean(decision.completionReason),
    physicalControlIds: Object.freeze([...(decision.physicalControlIds || [])].map(clean).filter(Boolean).slice(0, 24)),
    observed: Object.freeze({
      value: observed.value ?? "",
      selectedValue: observed.selectedValue ?? "",
      selectedControlId: clean(observed.selectedControlId),
      satisfied: observed.satisfied === true,
      required: observed.required === true
    })
  });
}

function taskStateReadModel(taskState = null) {
  return taskState && typeof taskState === "object"
    ? taskStateReadModels.get(taskState) || null
    : null;
}

function unblockedStageExitReady(page = {}) {
  const exit = page.stageExit || {};
  if (exit.continueDisabled === true || exit.navigationState === "disabled") return false;
  const readyCandidate = (exit.candidates || []).some((candidate) => (
    candidate.executable === true || candidate.status === "ready"
  ));
  return Boolean(readyCandidate && !(exit.blockers || []).length);
}

function groupId(group = {}) {
  return clean(group.decisionGroupId || group.requirementId);
}

function groupKey(group = {}) {
  return groupId(group);
}

function semanticToken(value = "", limit = 160) {
  return lower(value).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, limit);
}

function stableSemanticToken(value = "", limit = 56) {
  const normalized = semanticToken(value, 600) || "unknown";
  let hash = 2166136261;
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const suffix = (hash >>> 0).toString(36);
  const prefixLength = Math.max(1, limit - suffix.length - 1);
  return `${normalized.slice(0, prefixLength)}_${suffix}`;
}

// Stable semantic ownership for one checkout decision. Unlike the recovery
// instance key, this deliberately excludes the selected option: choosing an
// option changes the outcome, not the identity of the decision that owns it.
function canonicalDecisionOwnerId(decision = {}, observation = {}) {
  const observed = decision.observed || decision;
  const ownership = observed.semanticOwnership || {};
  const progress = observation.page?.foreground?.progressMarkers
    || observation.page?.visualState?.foreground?.progressMarkers
    || {};
  const family = episodeFamilyForDecision(decision) || lower(decision.family || decision.subject?.family || "decision");
  const owner = clean(
    decision.canonicalOwnerId
    || ownership.canonicalOwnerId
    || ownership.ownerKey
    || ownership.linkId
    || observed.sectionOwnerKey
    || observed.requirementId
    || observed.sectionId
    || decision.requirementId
    || decision.decisionGroupId
    || decision.decisionId
  );
  // A shared requirement such as `contact:select-an-option` is useful
  // semantic context, but is not enough to distinguish sibling products.
  // Keep the exact logical decision group as a separate identity component.
  const exactOwner = clean(
    decision.decisionGroupId
    || decision.decisionId
    || observed.decisionGroupId
    || observed.decisionId
    || decision.requirementId
  );
  const semanticOwner = clean([
    observed.sectionType,
    observed.sectionLabel,
    decision.subject?.label
  ].filter(Boolean).join(" "));
  const repeatedScope = clean([
    progress.flightOrdinal,
    progress.route,
    progress.segment,
    observed.passengerId,
    observed.travelerId,
    observed.passengerOrdinal,
    observed.travelerOrdinal,
    progress.passengerOrdinal,
    progress.travelerOrdinal
  ].filter(Boolean).join("|"));
  return [
    semanticToken(observation.page?.step || "unknown", 30),
    semanticToken(family, 20),
    stableSemanticToken([semanticOwner, owner].filter(Boolean).join("|") || "unknown_owner", 52),
    stableSemanticToken(exactOwner || "unknown_group", 52),
    stableSemanticToken(repeatedScope || "global", 30)
  ].join(":");
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
  if (/legal|terms|conditions|consent|agree|acceptance/.test(text)) return "legal";
  if (/seat/.test(text)) return "seat";
  if (/bag|luggage/.test(text)) return "baggage";
  if (/insurance|cancellation|protection/.test(text)) return "insurance";
  if (/bundle|support|sms|flexible|extra|add.?on/.test(text)) return "extras";
  if (/payment|card|pay/.test(text)) return "payment";
  return "decision";
}

function stageEvidence(observation = {}) {
  const page = observation.page || {};
  const controls = page.controls || [];
  const fields = page.fields || [];
  const surface = currentSurface(page);
  const activeRepresentations = controls.concat(fields).filter((control) => (
    control.representationLifecycle?.status !== "dormant_hidden"
    && control.representationLifecycle?.active !== false
    && (control.surfaceId ? controlBelongsToCurrentSurface(control, page) : true)
  ));
  const url = lower(page.url || observation.url);
  const controlText = (control = {}) => lower(
    `${control.fieldType || ""} ${control.field || ""} ${control.semanticType || ""} ${control.semantic || ""} ${control.inputType || ""} ${control.autocomplete || ""} ${control.name || ""} ${control.testId || ""} ${control.stableKey || ""}`
  );
  const directControlText = activeRepresentations.map(controlText).join(" ");
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
    ...activeRepresentations.slice(0, 180).map((control) => `${control.field || ""} ${control.semantic || ""} ${control.label || ""} ${control.inputType || ""}`)
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
  const terminalEvidence = agentContract.compileTerminalEvidence({
    ...page,
    url,
    visibleText: text,
    headingText,
    activeProgressText,
    structuralEvidence: {
      activeProgressText,
      activePaymentProgress: /payment|pay/.test(activeProgressText),
      paymentFormPresent: /card_number|cardholder|security_code|card_cvc|\bcvc\b|\bcvv\b|card_expiry|cc-number|cc-exp|cc-csc/.test(directControlText),
      paymentMethodPresent: /payment_method|billing_address|payment_option/.test(directControlText),
      paymentHeadingPresent: /payment|pay securely|payment details|choose payment method/.test(headingText)
    }
  });
  const payment = {
    route: terminalEvidence.signals.route === true,
    progress: terminalEvidence.signals.progress === true,
    fields: terminalEvidence.signals.form === true,
    method: terminalEvidence.signals.method === true,
    heading: terminalEvidence.signals.heading === true,
    orderSection: terminalEvidence.signals.review === true,
    commit: terminalEvidence.signals.commit === true
  };
  // Compatibility count excludes review/legal context; only independent
  // stage/form channels count as direct payment evidence.
  const paymentSignals = ["route", "progress", "fields", "method", "heading", "commit"]
    .filter((key) => payment[key]).length;
  const confirmation = /booking confirmed|booking reference|reservation number|confirmation number|\bpnr\b/.test(headingText)
    || /confirmation|booking-confirmed/.test(url);
  const seatRoute = /(?:^|[\/#?&_-])seats?(?:[\/#?&=_-]|$)/.test(url);
  const extrasRoute = /\/(?:cabin-?bags?|hold-?bags?|bags?|baggage|luggage|extras?|ancillar(?:y|ies)|insurance|bundles?)(?:\/|$)/.test(url);
  const seat = seatRoute
    || (page.decisionGroups || []).some((group) => decisionFamily(group) === "seat")
    || /seat_option|seat_map|seat_selection/.test(directControlText)
    || /seat selection|select (?:your )?seats?|reserve seating|seat map/.test(headingText)
    || (surface.type !== "page" && /seat|seating/.test(lower(surface.label)));
  const traveler = /(?:^|[\/#?&_-])(?:travell?er|passenger|contact)(?:[\/#?&=_-]|$)/.test(url)
    || /first_name|last_name|surname|full_name|email|phone|date_of_birth|dob|passport|nationality|traveler_title/.test(directControlText)
    || /travell?er information|passenger details|contact information/.test(headingText);
  const extras = extrasRoute
    || (page.decisionGroups || []).some((group) => ["seat", "baggage", "insurance", "extras"].includes(decisionFamily(group)))
    || /(?:^|[\/#?&_-])(?:extras?|ancillar(?:y|ies)?|baggage|bundle|insurance)(?:[\/#?&=_-]|$)/.test(url)
    || /baggage|insurance|bundle|flexible ticket|add.?on|upgrade your trip/.test(headingText);
  const strongExtras = /add your hold bags|hold (?:bag|baggage|luggage) options?|select (?:your )?(?:cabin|checked|hold) bags?|add (?:a |your )?(?:cabin|checked|hold) bags?/.test(headingText);
  const flight = /(?:^|[\/#?&_-])(?:flights?|search)(?:[\/#?&=_-]|$)/.test(url)
    || /select flight|choose flight|flight selection|fare selection/.test(headingText);
  return {
    payment,
    paymentSignals,
    terminalEvidence,
    confirmation,
    seat,
    seatRoute,
    traveler,
    extras,
    extrasRoute,
    strongExtras,
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
  const page = observation.page || {};
  const surface = currentSurface(page);
  const declaredStep = lower(page.step || page.pageStep);
  const declaredStage = /payment/.test(declaredStep)
    ? "payment"
    : /confirmation/.test(declaredStep)
      ? "confirmation"
      : /seat/.test(declaredStep)
        ? "seats"
        : /extra|bag|bundle|insurance|ancillar/.test(declaredStep)
          ? "extras"
          : /travell?er|passenger|contact/.test(declaredStep)
            ? "traveler_information"
            : "";
  const paymentDestination = evidence.terminalEvidence?.boundaryObserved === true;
  if (paymentDestination) return { stage: "payment", evidence };
  if (evidence.confirmation) return { stage: "confirmation", evidence };
  // Search/start routes are outside an active checkout. Route structure is
  // stronger than stale extras copy retained in a rerendered shell.
  if (evidence.newSearchRoute) return { stage: "flight_selection", evidence };
  // Active ancillary routes outrank stale checkout-progress labels such as
  // "Seat selection" that remain visible throughout later bag pages.
  if (evidence.extrasRoute) return { stage: "extras", evidence };
  if (evidence.strongExtras) return { stage: "extras", evidence };
  // The browser's current-step observation is evidence compiled into the one
  // DecisionFrame, not a durable authority. When it agrees with active local
  // evidence it outranks stale route text and disabled controls retained by a
  // single-page checkout shell (for example /traveler-details on a seat step).
  if (declaredStage === "seats" && evidence.seat) return { stage: "seats", evidence };
  if (declaredStage === "extras" && evidence.extras) return { stage: "extras", evidence };
  if (declaredStage === "traveler_information" && evidence.traveler) {
    return { stage: "traveler_information", evidence };
  }
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
    ...(page.stageExit?.candidates || [])
      .filter((candidate) => candidate.status === "ready" || candidate.executable === true)
      .flatMap((candidate) => [candidate.controlId, candidate.actuatorId])
  ].filter(Boolean));
  return (page.controls || []).filter((control) => {
    if (!controlBelongsToCurrentSurface(control, page)) return false;
    if (!controlHasExecutableCapability(control)) return false;
    const explicitStageExit = explicitStageExitIds.has(control.controlId)
      || explicitStageExitIds.has(control.stateElementId)
      || explicitStageExitIds.has(control.preferredActivationElementId);
    const typedNavigation = isTypedNavigationControl(control, { explicitStageExit: false });
    const state = control.state || {};
    const alreadySelected = control.selected === true
      || state.selected === true
      || state.checked === true;
    const choiceLike = /checkbox|radio|option|choice/.test(lower(
      `${control.kind || ""} ${control.role || ""} ${control.domRole || ""}`
    ));
    // A browser stage-exit heuristic may notice text such as "select this to
    // continue" on a settled decline checkbox. That does not make the choice
    // itself a navigation actuator. Exact typed navigation remains eligible;
    // an explicit stage-exit fallback is admitted only for an unselected
    // non-choice actuator such as Continue, Skip bags, or Proceed without
    // seats. Choice settlement belongs to its decision obligation.
    if (alreadySelected && !typedNavigation) return false;
    if (choiceLike && !typedNavigation) return false;
    return typedNavigation || explicitStageExit;
  }).map((control) => control.controlId).filter(Boolean);
}

function controlHasExecutableCapability(control = {}) {
  const disabledState = control.disabled === true || control.state?.disabled === true;
  return Object.values(control.operations || {}).some((capability) => {
    const actuatorId = capability?.actuatorId || "";
    const disabledActuator = disabledState
      && (!actuatorId || actuatorId === control.stateElementId);
    return !disabledActuator && (
      capability?.actionability?.executable === true
      || capability?.actionability?.revealable === true
    );
  });
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
  return agentContract.isPaidCommerceOption({
    effectRole: control.effectRole,
    priceAmount: optionPrice(control),
    disposition: control.disposition,
    semanticEffect: control.physicalEffect || control.semantic
  });
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

function goalForDecision(decision = {}, observation = {}, userPolicy = {}, traveler = {}) {
  const options = decisionOptionContract(decision, observation);
  const explicitDesiredOutcome = clean(decision.userIntent?.desiredOutcome);
  const genericDesiredOutcome = !explicitDesiredOutcome
    || ["selected", "selected_policy_allowed_option"].includes(explicitDesiredOutcome);
  const desiredSemanticOutcome = genericDesiredOutcome && options.correctionControlIds.length
    ? agentContract.SEMANTIC_EFFECT.SELECT_FREE_OPTION
    : genericDesiredOutcome
      && options.policyChoiceBounded
      && options.freeControlIds.some((controlId) => options.policyAllowedControlIds.includes(controlId))
      ? agentContract.SEMANTIC_EFFECT.SELECT_FREE_OPTION
      : explicitDesiredOutcome;
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

function completedChoiceSurfaceGoal(observation = {}, episode = {}) {
  const surface = currentSurface(observation.page || {});
  return Object.freeze({
    goalId: `${observation.observationId || "observation"}:goal:close_completed_choice_surface`,
    semanticGoal: "close the completed choice surface",
    semanticType: "completed_choice_surface",
    desiredValue: "surface_dismissed",
    decisionGroupId: clean(episode.parentDecisionGroupId),
    parentDecisionGroupId: clean(episode.parentDecisionGroupId),
    parentSelectedControlId: clean(episode.selectedControlId),
    decisionEpisodeId: clean(episode.episodeId),
    requirementId: clean(episode.requirementId),
    surfaceId: surface.id || "surface-page",
    observationId: observation.observationId || "",
    actionableControlIds: Object.freeze([...(episode.surfaceExitControlIds || [])]),
    surfaceExitOwnership: episode.surfaceExitOwnership || null,
    completedDecisionGroupId: clean(episode.parentDecisionGroupId),
    postcondition: Object.freeze({
      type: "active_surface_dismissed",
      previousSurfaceId: surface.id || "",
      parentDecisionGroupId: clean(episode.parentDecisionGroupId),
      parentExpectedSelectedControlId: clean(episode.selectedControlId),
      decisionEpisodeId: clean(episode.episodeId)
    })
  });
}

function admittedControlIdsForGoal(goal = {}) {
  const explicit = (goal.actionableControlIds || []).filter(Boolean);
  if (explicit.length) return [...new Set(explicit)];
  if (goal.policyChoiceBounded === true) {
    return [...new Set((goal.policyAllowedControlIds || []).filter(Boolean))];
  }
  if (goal.kind === "profile_field") {
    return [...new Set([
      goal.controlId,
      goal.componentBinding?.controlId,
      ...(goal.componentBinding?.representationControlIds || []),
      ...(goal.componentBinding?.stateControlIds || [])
    ].filter(Boolean))];
  }
  return [...new Set((goal.eligibleAlternativeControlIds || []).filter(Boolean))];
}

function decisionEpisodeSurfaceKey(surface = {}) {
  return [
    clean(surface.type || "page").toLowerCase(),
    clean(surface.surfaceClass || "unknown").toLowerCase(),
    lower(surface.label).slice(0, 120)
  ].join("|");
}

function episodeFamilyForDecision(decision = {}) {
  if (!decision || typeof decision !== "object") return "";
  const family = lower(decision.family || decision.subject?.family);
  return DECISION_EPISODE_FAMILIES.has(family) ? family : "";
}

function episodeSubjectKeyForDecision(decision = {}) {
  if (!decision || typeof decision !== "object") return "";
  const family = episodeFamilyForDecision(decision);
  const explicit = lower(decision.subject?.key || decision.requirementId);
  if (family === "seat") return "seat_assignment";
  if (family === "fare") return "ticket";
  return explicit || family;
}

function surfaceEpisodeFamily(surface = {}, canonicalDecisions = []) {
  const hinted = lower(`${surface.taskHint || ""} ${surface.parentSectionType || ""} ${surface.parentSectionLabel || ""} ${surface.label || ""}`);
  const hintedFamily = [...DECISION_EPISODE_FAMILIES].find((family) => (
    family === "extras"
      ? /extra|bundle|meal|priority|support|subscription|flexible/.test(hinted)
      : family === "baggage"
        ? /bag|baggage|luggage/.test(hinted)
        : family === "insurance"
          ? /insurance|protection|cover/.test(hinted)
          : new RegExp(`\\b${family}\\b`).test(hinted)
  ));
  if (hintedFamily) return hintedFamily;
  const ownedFamilies = [...new Set(canonicalDecisions
    .filter((decision) => (
      decision.surfaceId === surface.id
      || decision.decisionGroupId === surface.decisionGroupId
    ))
    .map(episodeFamilyForDecision)
    .filter(Boolean))];
  return ownedFamilies.length === 1 ? ownedFamilies[0] : "";
}

// One authoritative reader for the decision identity carried through
// candidate -> action -> browser result -> semantic verification. Browser
// transport may place the contract at different structural depths, but every
// consumer receives the same normalized lineage from here.
function actionDecisionLineage(result = null, fallbackGoal = {}, fallbackEpisode = {}) {
  if (!result || typeof result !== "object") return Object.freeze({
    explicit: false,
    explicitLineage: Object.freeze({
      decisionEpisodeId: "",
      decisionInstanceId: "",
      canonicalOwnerId: "",
      parentDecisionGroupId: "",
      decisionGroupId: "",
      requirementId: ""
    }),
    fallbackLineage: Object.freeze({
      decisionEpisodeId: "",
      decisionInstanceId: "",
      canonicalOwnerId: "",
      parentDecisionGroupId: "",
      decisionGroupId: "",
      requirementId: ""
    }),
    decisionEpisodeId: "",
    decisionInstanceId: "",
    canonicalOwnerId: "",
    parentDecisionGroupId: "",
    decisionGroupId: "",
    requirementId: ""
  });
  const action = result.action || {};
  const task = action.affordance?.task || {};
  const expected = result.expectedOutcome || action.expectedOutcome || action.affordance?.postcondition || {};
  const postcondition = (action.expectedPostconditions || task.expectedPostconditions || [])
    .find((entry) => entry && typeof entry === "object") || {};
  const explicitEpisodeId = clean(
    result.decisionEpisodeId
    || action.decisionEpisodeId
    || action.pipelineContract?.surfaceOwnership?.decisionEpisodeId
    || task.decisionEpisodeId
    || expected.decisionEpisodeId
    || postcondition.decisionEpisodeId
  );
  const explicitInstanceId = clean(
    result.decisionInstanceId
    || action.decisionInstanceId
    || task.decisionInstanceId
    || task.canonicalOwnerId
    || expected.decisionInstanceId
    || expected.canonicalOwnerId
    || postcondition.decisionInstanceId
    || postcondition.canonicalOwnerId
  );
  const explicitParentDecisionGroupId = clean(
    result.parentDecisionGroupId
    || action.parentDecisionGroupId
    || task.parentDecisionGroupId
    || expected.parentDecisionGroupId
    || postcondition.parentDecisionGroupId
  );
  const explicitDecisionGroupId = clean(
    result.decisionGroupId
    || action.decisionGroupId
    || task.decisionGroupId
    || expected.decisionGroupId
    || postcondition.decisionGroupId
  );
  const explicitRequirementId = clean(
    result.requirementId
    || action.requirementId
    || task.requirementId
    || expected.requirementId
    || postcondition.requirementId
  );
  const explicitLineage = Object.freeze({
    decisionEpisodeId: explicitEpisodeId,
    decisionInstanceId: explicitInstanceId,
    canonicalOwnerId: explicitInstanceId,
    parentDecisionGroupId: explicitParentDecisionGroupId,
    decisionGroupId: explicitDecisionGroupId,
    requirementId: explicitRequirementId
  });
  const fallbackInstanceId = clean(
    fallbackGoal.decisionInstanceId
    || fallbackGoal.canonicalOwnerId
    || fallbackEpisode.decisionInstanceId
    || fallbackEpisode.canonicalOwnerId
  );
  const fallbackLineage = Object.freeze({
    decisionEpisodeId: clean(fallbackGoal.decisionEpisodeId || fallbackEpisode.episodeId),
    decisionInstanceId: fallbackInstanceId,
    canonicalOwnerId: fallbackInstanceId,
    parentDecisionGroupId: clean(fallbackGoal.parentDecisionGroupId || fallbackEpisode.parentDecisionGroupId),
    decisionGroupId: clean(fallbackGoal.decisionGroupId || fallbackEpisode.parentDecisionGroupId),
    requirementId: clean(fallbackGoal.requirementId || fallbackEpisode.requirementId)
  });
  const decisionInstanceId = clean(
    explicitInstanceId
    || fallbackLineage.decisionInstanceId
  );
  return Object.freeze({
    explicit: Boolean(
      explicitEpisodeId
      || explicitInstanceId
      || explicitParentDecisionGroupId
      || explicitDecisionGroupId
    ),
    explicitLineage,
    fallbackLineage,
    decisionEpisodeId: clean(
      explicitEpisodeId
      || fallbackLineage.decisionEpisodeId
    ),
    decisionInstanceId,
    canonicalOwnerId: decisionInstanceId,
    parentDecisionGroupId: clean(
      explicitParentDecisionGroupId
      || fallbackLineage.parentDecisionGroupId
    ),
    decisionGroupId: clean(
      explicitDecisionGroupId
      || fallbackLineage.decisionGroupId
    ),
    requirementId: clean(
      explicitRequirementId
      || fallbackLineage.requirementId
    )
  });
}

// An episode belongs to one exact canonical decision. Family names and shared
// requirement labels (for example `contact:select-an-option`) describe a
// category, not ownership: a page can contain several independent extras.
function episodeOwnsDecision(episode = {}, decision = {}) {
  const parentDecisionGroupId = clean(episode.parentDecisionGroupId);
  const decisionGroupId = clean(decision.decisionGroupId || decision.completedDecisionGroupId);
  if (!parentDecisionGroupId || !decisionGroupId) return false;
  return parentDecisionGroupId === decisionGroupId;
}

function episodeOwnsGoal(episode = {}, goal = {}) {
  return episodeOwnsDecision(episode, goal)
    || clean(goal.parentDecisionGroupId) === clean(episode.parentDecisionGroupId)
    || clean(goal.completedDecisionGroupId) === clean(episode.parentDecisionGroupId)
    // A child confirmation is permitted only after the episode itself proved
    // that this foreground surface belongs to its exact parent decision.
    || (
      clean(episode.childSurfaceId)
      && clean(goal.surfaceId) === clean(episode.childSurfaceId)
    );
}

function verifiedActionSucceeded(result = null) {
  if (!result || result.dispatched === false) return false;
  const hasLocalOutcomeContract = [
    "localOutcomeVerified",
    "localExpectedOutcomeObserved",
    "localPostconditionSatisfied"
  ].some((key) => Object.prototype.hasOwnProperty.call(result, key));
  if (hasLocalOutcomeContract) {
    return Boolean(
      result.localOutcomeVerified === true
      && result.localExpectedOutcomeObserved !== false
      && result.localPostconditionSatisfied !== false
    );
  }
  return Boolean(
    result.verified === true
    && result.expectedOutcomeObserved !== false
    && result.postconditionSatisfied !== false
  );
}

function verifiedEpisodeAction(result = null, episode = {}) {
  if (!result || !episode?.episodeId) return false;
  const lineage = actionDecisionLineage(result);
  const action = result.action || {};
  const exactTargetControlId = clean(
    result.controlId
    || action.controlId
    || result.targetSnapshot?.controlId
    || action.targetSnapshot?.controlId
  );
  const exactPostconditionControlIds = actionPostconditions(result).flatMap((postcondition) => [
    postcondition.controlId,
    postcondition.expectedSelectedControlId,
    postcondition.parentExpectedSelectedControlId
  ]).map(clean).filter(Boolean);
  const belongs = lineage.decisionEpisodeId === clean(episode.episodeId)
    || lineage.decisionInstanceId === clean(episode.decisionInstanceId || episode.canonicalOwnerId)
    || lineage.parentDecisionGroupId === clean(episode.parentDecisionGroupId)
    || lineage.decisionGroupId === clean(episode.parentDecisionGroupId)
    // Some browser transports preserve the exact actuator but omit planning
    // lineage. Exact selected-control equality is still authoritative and is
    // safer than inheriting a generic episode/family fallback.
    || Boolean(exactTargetControlId && exactTargetControlId === clean(episode.selectedControlId))
    || exactPostconditionControlIds.includes(clean(episode.selectedControlId));
  return belongs && verifiedActionSucceeded(result);
}

function terminalEpisodeOutcome(episode = {}, parent = null) {
  const family = clean(episode.family || episodeFamilyForDecision(parent));
  const subjectKey = clean(episode.subjectKey || episodeSubjectKeyForDecision(parent));
  const decisionInstanceId = clean(
    episode.decisionInstanceId
    || episode.canonicalOwnerId
    || parent?.canonicalOwnerId
    || parent?.decisionGroupId
    || episode.parentDecisionGroupId
  );
  const paid = parent?.commitmentPhase === "committed_paid" || parent?.currentOutcome === "paid_affirmative";
  const declined = !paid && (
    episode.commitmentPhase === "confirmation_pending"
    || parent?.commitmentPhase === "declined_free"
    || /random|declin|without|skip/.test(lower(episode.intendedOutcome))
  );
  return Object.freeze({
    decisionGroupId: clean(parent?.decisionGroupId || episode.parentDecisionGroupId),
    decisionInstanceId,
    decisionOwnerKey: decisionInstanceId,
    canonicalOwnerId: decisionInstanceId,
    originKind: "verified_commerce_decision",
    family,
    subjectKey,
    label: family === "seat" && declined ? "Random seat assignment" : clean(parent?.selectedLabel || episode.intendedOutcome),
    disposition: paid ? "paid" : declined ? "declined" : "selected",
    outcome: paid ? "paid_affirmative" : family === "seat" && declined ? "random_assignment" : declined ? "declined" : "selected",
    priceAmount: paid ? (parent?.priceRisk?.amount ?? null) : 0,
    currency: clean(parent?.priceRisk?.currency),
    segmentOutcomes: Object.freeze((Array.isArray(episode.segmentOutcomes) ? episode.segmentOutcomes : [])
      .filter((entry) => entry?.verified === true && entry?.segmentKey)
      .map((entry) => Object.freeze({
        segmentKey: clean(entry.segmentKey),
        outcome: clean(entry.outcome),
        verified: true
      }))),
    verified: episode.outcomeVerified === true
  });
}

function actionPostconditions(result = null) {
  const action = result?.action || {};
  const task = action.affordance?.task || {};
  return [
    result?.expectedOutcome,
    action.expectedOutcome,
    action.affordance?.postcondition,
    ...(Array.isArray(result?.expectedPostconditions) ? result.expectedPostconditions : []),
    ...(Array.isArray(action.expectedPostconditions) ? action.expectedPostconditions : []),
    ...(Array.isArray(task.expectedPostconditions) ? task.expectedPostconditions : [])
  ].filter((entry) => entry && typeof entry === "object");
}

function verifiedCommercePostcondition(result = null) {
  return actionPostconditions(result).find((postcondition) => (
    postcondition.type === "exact_free_option_selected"
    || postcondition.type === "exact_paid_option_selected"
  )) || null;
}

function isVerifiedCommerceAction(result = null) {
  if (!verifiedActionSucceeded(result)) return false;
  const action = result.action || {};
  const effect = clean(
    result.mechanicalEffect
    || action.mechanicalEffect
    || action.affordance?.physicalEffect
    || action.affordance?.effect
  );
  return Boolean(
    verifiedCommercePostcondition(result)
    || ["select_free_option", "select_paid_option"].includes(effect)
  );
}

// A verified browser result is an immutable receipt.  It must survive even
// when the next observation rerenders away the decision that produced it.
// Keep this contract deliberately narrower than general successful actions:
// profile entry, navigation, opening a selector, waits, and stale results do
// not create commerce obligations.
function verifiedCommerceObligationFromActionResult(result = null, observationId = "", context = {}) {
  if (!isVerifiedCommerceAction(result)) return null;
  const action = result.action || {};
  const task = action.affordance?.task || {};
  const postcondition = verifiedCommercePostcondition(result) || {};
  const decisionEpisode = context.decisionEpisode || context.taskState?.decisionEpisode || null;
  const currentGoal = context.currentGoal || taskMechanics(context.taskState || {});
  const lineage = actionDecisionLineage(result, currentGoal, decisionEpisode || {});
  const actionSurfaceId = clean(
    postcondition.surfaceId
    || result.targetSnapshot?.surfaceId
    || action.targetSnapshot?.surfaceId
    || action.surfaceId
    || result.surfaceId
  );
  // A foreground confirmation may have its own transient decision wrapper,
  // while still being the child of one durable parent episode. Reuse the
  // parent identity only when lineage explicitly agrees or the exact current
  // foreground surface is the episode's recorded child. Never aggregate
  // ordinary page siblings merely because they share `surface-page`.
  const episodeOwnsReceipt = Boolean(
    decisionEpisode?.episodeId
    && clean(decisionEpisode.childSurfaceId)
    && clean(decisionEpisode.childSurfaceId) !== "surface-page"
    && actionSurfaceId === clean(decisionEpisode.childSurfaceId)
  );
  const actionId = clean(result.actionId || action.id);
  const decisionGroupId = clean(
    (episodeOwnsReceipt ? decisionEpisode.parentDecisionGroupId : "")
    || postcondition.decisionGroupId
    || task.parentDecisionGroupId
    || task.decisionGroupId
    || action.decisionGroupId
    || result.decisionGroupId
    || action.targetSnapshot?.decisionGroupId
    || result.targetSnapshot?.decisionGroupId
  );
  const semantic = lower(`${task.semanticType || ""} ${action.semanticIntent || result.semanticIntent || ""}`);
  const family = clean(episodeOwnsReceipt ? decisionEpisode.family : "") || (/seat/.test(semantic)
    ? "seat"
    : /bag|luggage/.test(semantic)
      ? "baggage"
      : /insurance|protection|cancel/.test(semantic)
        ? "insurance"
        : /fare|ticket/.test(semantic)
          ? "fare"
          : "extras");
  const mechanicalEffect = clean(result.mechanicalEffect || action.mechanicalEffect);
  const paid = postcondition.type === "exact_paid_option_selected" || mechanicalEffect === "select_paid_option";
  const declined = !paid && (
    postcondition.expectedDisposition === "decline_free_no_extra"
    || /declin|without|no thanks|skip|none/.test(lower(
      `${postcondition.expectedSelectedLabel || ""} ${action.targetLabel || ""} ${result.targetLabel || ""}`
    ))
  );
  const decisionInstanceId = clean(
    (episodeOwnsReceipt ? decisionEpisode.canonicalOwnerId || decisionEpisode.decisionInstanceId : "")
    || task.canonicalOwnerId
    || task.decisionInstanceId
    || action.canonicalOwnerId
    || action.decisionInstanceId
    || result.canonicalOwnerId
    || result.decisionInstanceId
    || decisionGroupId
  );
  if (!actionId || !decisionGroupId || !decisionInstanceId) return null;
  const targetSnapshot = result.targetSnapshot || action.targetSnapshot || {};
  return Object.freeze({
    actionId,
    observationId: clean(observationId || result.observationId),
    decisionGroupId,
    decisionInstanceId,
    decisionOwnerKey: decisionInstanceId,
    canonicalOwnerId: decisionInstanceId,
    decisionEpisodeId: clean(episodeOwnsReceipt ? decisionEpisode.episodeId : lineage.decisionEpisodeId),
    family,
    subjectKey: clean(
      (episodeOwnsReceipt ? decisionEpisode.subjectKey : "")
      || task.semanticType
      || task.requirementId
      || postcondition.requirementId
      || family
    ),
    label: clean(postcondition.expectedSelectedLabel || action.targetLabel || result.targetLabel),
    disposition: paid ? "paid" : declined ? "declined" : "selected",
    outcome: paid ? "paid_affirmative" : declined ? "declined" : "selected",
    priceAmount: paid ? (targetSnapshot.structuredPrice?.amount ?? null) : 0,
    currency: clean(targetSnapshot.structuredPrice?.currency),
    verified: true,
    originKind: "verified_commerce_obligation",
    // Store only the compiled receipt. Reconstructing meaning from a later
    // page is exactly the lossy path this register replaces.
    receipt: Object.freeze({
      mechanicalEffect,
      expectedOutcomeType: clean(postcondition.type),
      expectedDisposition: clean(postcondition.expectedDisposition),
      semanticIntent: clean(action.semanticIntent || result.semanticIntent)
    })
  });
}

function verifiedCommerceObligations(previous = [], supplied = []) {
  const byActionId = new Map();
  const add = (entry) => {
    if (!entry?.actionId || entry.verified !== true || entry.originKind !== "verified_commerce_obligation") return;
    byActionId.set(clean(entry.actionId), Object.freeze({ ...entry }));
  };
  for (const entry of Array.isArray(previous) ? previous : []) add(entry);
  for (const entry of Array.isArray(supplied) ? supplied : []) add(entry);
  return Object.freeze([...byActionId.values()].slice(-120));
}

function commerceOutcomeFromVerifiedObligation(obligation = {}) {
  if (!obligation?.actionId || obligation.verified !== true || obligation.originKind !== "verified_commerce_obligation") return null;
  if (!DECISION_EPISODE_FAMILIES.has(clean(obligation.family))) return null;
  return Object.freeze({
    decisionGroupId: clean(obligation.decisionGroupId),
    decisionInstanceId: clean(obligation.decisionInstanceId),
    decisionOwnerKey: clean(obligation.decisionOwnerKey || obligation.decisionInstanceId),
    canonicalOwnerId: clean(obligation.canonicalOwnerId || obligation.decisionInstanceId),
    originKind: "verified_commerce_decision",
    admissionSource: "verified_action_obligation",
    actionId: clean(obligation.actionId),
    family: clean(obligation.family),
    subjectKey: clean(obligation.subjectKey),
    label: clean(obligation.label),
    disposition: clean(obligation.disposition || "selected"),
    outcome: clean(obligation.outcome || "selected"),
    priceAmount: obligation.priceAmount ?? null,
    currency: clean(obligation.currency),
    segmentOutcomes: Object.freeze([]),
    verified: true,
    observationId: clean(obligation.observationId)
  });
}

function decisionForVerifiedCommerceAction({
  actionResult = null,
  canonicalDecisions = [],
  previousTaskState = {},
  decisionEpisode = null
} = {}) {
  const lineage = actionDecisionLineage(
    actionResult,
    taskMechanics(previousTaskState),
    decisionEpisode || previousTaskState.decisionEpisode || {}
  );
  const action = actionResult?.action || {};
  // The action's exact target owner is stronger than a parent/episode hint
  // copied from an earlier planning snapshot. Parent lineage remains useful
  // for true child surfaces, which are aggregated by the episode path before
  // this direct committer is reached.
  const exactActionDecisionGroupId = clean(
    actionResult?.decisionGroupId
    || action.decisionGroupId
    // Browser-result compaction keeps the resolved target separately from
    // the planned action. That exact target is first-class ownership proof,
    // never a reason to fall back to a transient episode.
    || actionResult?.targetSnapshot?.decisionGroupId
    || action.targetSnapshot?.decisionGroupId
  );
  const explicit = lineage.explicitLineage || {};
  const ownerIds = [
    exactActionDecisionGroupId,
    explicit.parentDecisionGroupId,
    explicit.decisionGroupId,
    ...(lineage.explicit ? [] : [lineage.fallbackLineage?.parentDecisionGroupId, lineage.fallbackLineage?.decisionGroupId])
  ].filter(Boolean);
  const decisions = [
    ...(Array.isArray(canonicalDecisions) ? canonicalDecisions : []),
    ...(Array.isArray(previousTaskState.verificationDecisionMemory)
      ? previousTaskState.verificationDecisionMemory
      : Array.isArray(previousTaskState.canonicalDecisions)
        ? previousTaskState.canonicalDecisions
        : [])
  ];
  return decisions.find((decision) => ownerIds.includes(clean(decision.decisionGroupId))) || null;
}

function commerceOutcomeFromVerifiedAction({
  actionResult = null,
  canonicalDecisions = [],
  previousTaskState = {},
  decisionEpisode = null,
  observationId = ""
} = {}) {
  if (!isVerifiedCommerceAction(actionResult)) return null;
  const postcondition = verifiedCommercePostcondition(actionResult);
  const lineage = actionDecisionLineage(
    actionResult,
    taskMechanics(previousTaskState),
    decisionEpisode || previousTaskState.decisionEpisode || {}
  );
  const decision = decisionForVerifiedCommerceAction({
    actionResult,
    canonicalDecisions,
    previousTaskState,
    decisionEpisode
  });
  const family = episodeFamilyForDecision(decision)
    || clean(decisionEpisode?.family || previousTaskState.decisionEpisode?.family);
  // A verified choice is consequential only when its exact canonical owner
  // is a commerce decision. This keeps profile fields, navigation, and
  // optional marketing controls out of the transaction journal.
  if (!DECISION_EPISODE_FAMILIES.has(family)) return null;
  const explicit = lineage.explicitLineage || {};
  const exactActionDecisionGroupId = clean(
    actionResult?.decisionGroupId
    || actionResult?.action?.decisionGroupId
    || actionResult?.action?.targetSnapshot?.decisionGroupId
  );
  const decisionGroupId = clean(
    decision?.decisionGroupId
    || exactActionDecisionGroupId
    || explicit.parentDecisionGroupId
    || explicit.decisionGroupId
    || (!lineage.explicit ? lineage.fallbackLineage?.parentDecisionGroupId : "")
    || (!lineage.explicit ? lineage.fallbackLineage?.decisionGroupId : "")
  );
  const decisionInstanceId = clean(
    explicit.decisionInstanceId
    || decision?.canonicalOwnerId
    || decisionGroupId
  );
  if (!decisionGroupId || !decisionInstanceId) return null;
  const action = actionResult.action || {};
  const targetSnapshot = actionResult.targetSnapshot || {};
  const effect = clean(
    actionResult.mechanicalEffect
    || action.mechanicalEffect
    || action.affordance?.physicalEffect
    || action.affordance?.effect
  );
  const paid = postcondition?.type === "exact_paid_option_selected"
    || effect === "select_paid_option"
    || decision?.commitmentPhase === "committed_paid"
    || decision?.currentOutcome === "paid_affirmative";
  const declined = !paid && (
    postcondition?.expectedDisposition === "decline_free_no_extra"
    || /declin|without|no thanks|skip|random/.test(lower(
      `${postcondition?.expectedSelectedLabel || ""} ${action.targetLabel || ""} ${decision?.selectedLabel || ""}`
    ))
  );
  const price = targetSnapshot.structuredPrice
    || decision?.priceRisk
    || {};
  return Object.freeze({
    decisionGroupId,
    decisionInstanceId,
    decisionOwnerKey: decisionInstanceId,
    canonicalOwnerId: decisionInstanceId,
    originKind: "verified_commerce_decision",
    admissionSource: "verified_action_contract",
    actionId: clean(actionResult.actionId || action.id),
    family,
    subjectKey: clean(
      decision?.subject?.key
      || decision?.requirementId
      || explicit.requirementId
      || (!lineage.explicit ? lineage.fallbackLineage?.requirementId : "")
      || family
    ),
    label: clean(
      postcondition?.expectedSelectedLabel
      || decision?.selectedLabel
      || action.targetLabel
      || actionResult.targetLabel
    ),
    disposition: paid ? "paid" : declined ? "declined" : "selected",
    outcome: paid ? "paid_affirmative" : family === "seat" && declined ? "random_assignment" : declined ? "declined" : "selected",
    priceAmount: paid ? (price.amount ?? null) : 0,
    currency: clean(price.currency || decision?.priceRisk?.currency),
    segmentOutcomes: Object.freeze([]),
    verified: true,
    observationId: clean(observationId)
  });
}

function mergeVerifiedCommerceOutcome(previous = {}, next = {}) {
  const segmentOutcomes = [...(previous.segmentOutcomes || []), ...(next.segmentOutcomes || [])];
  const mergedSegments = [...new Map(segmentOutcomes
    .filter((entry) => entry?.segmentKey)
    .map((entry) => [clean(entry.segmentKey), entry])).values()];
  const prefersNext = next.outcome === "random_assignment"
    || next.disposition === "paid"
    || !previous.outcome;
  return Object.freeze({
    ...previous,
    ...next,
    label: clean(next.label || previous.label),
    disposition: prefersNext ? next.disposition : previous.disposition,
    outcome: prefersNext ? next.outcome : previous.outcome,
    priceAmount: next.priceAmount ?? previous.priceAmount ?? null,
    currency: clean(next.currency || previous.currency),
    segmentOutcomes: Object.freeze(mergedSegments),
    verified: previous.verified === true || next.verified === true,
    observationId: clean(next.observationId || previous.observationId)
  });
}

function admittedVerifiedCommerceOutcomes({
  actionResult = null,
  canonicalDecisions = [],
  previousTaskState = {},
  decisionEpisode = null,
  observationId = ""
} = {}) {
  const outcomes = [];
  const terminal = decisionEpisode?.terminalOutcome;
  const episodeOwnsResult = verifiedEpisodeAction(actionResult, decisionEpisode);
  const episodeHasUnfinishedChild = Boolean(
    episodeOwnsResult
    && clean(decisionEpisode?.childSurfaceId)
    && ["active", "awaiting_child_confirmation"].includes(decisionEpisode?.status)
  );
  const terminalEpisodeAdmitted = Boolean(
    ["completed", "completed_pending_surface_exit"].includes(decisionEpisode?.status)
    && decisionEpisode.outcomeVerified === true
    && terminal?.verified === true
    && terminal.originKind === "verified_commerce_decision"
    && terminal.decisionInstanceId
    && episodeOwnsResult
  );
  // A direct verified action is the durable fallback for ordinary choices.
  // A proven episode supersedes it only when it is still resolving a real
  // child confirmation or has already emitted the richer terminal aggregate.
  if (!episodeHasUnfinishedChild && !terminalEpisodeAdmitted) {
    const direct = commerceOutcomeFromVerifiedAction({
      actionResult,
      canonicalDecisions,
      previousTaskState,
      decisionEpisode,
      observationId
    });
    if (direct) outcomes.push(direct);
  }
  if (terminalEpisodeAdmitted) {
    outcomes.push(Object.freeze({
      ...terminal,
      admissionSource: "decision_episode_aggregation",
      observationId: clean(observationId || decisionEpisode.observationId)
    }));
  }
  return Object.freeze([...new Map(outcomes
    .map((outcome) => [clean(outcome.decisionInstanceId), outcome])
    .filter(([decisionInstanceId]) => Boolean(decisionInstanceId))).values()]);
}

function verifiedOutcomeJournal(previousJournal = [], admittedOutcomes = []) {
  const journal = new Map();
  const actionOwners = new Map();
  const identityRank = (entry = {}) => entry.admissionSource === "decision_episode_aggregation"
    ? 3
    : entry.admissionSource === "verified_action_obligation"
      ? 2
      : 1;
  const add = (outcome = {}) => {
    const decisionInstanceId = clean(outcome?.decisionInstanceId);
    if (!decisionInstanceId || outcome?.verified !== true) return;
    const actionId = clean(outcome.actionId);
    const existingActionOwner = actionId ? actionOwners.get(actionId) : "";
    const existingOwner = existingActionOwner || decisionInstanceId;
    const existing = journal.get(existingOwner);
    if (!existing) {
      journal.set(decisionInstanceId, outcome);
      if (actionId) actionOwners.set(actionId, decisionInstanceId);
      return;
    }
    // A receipt and the direct action committer can observe the same physical
    // action through different transient wrappers. Merge them once by action
    // ID, retaining the richer canonical receipt/episode identity.
    const identity = identityRank(outcome) > identityRank(existing) ? outcome : existing;
    const targetOwner = clean(identity.decisionInstanceId || existingOwner);
    const merged = mergeVerifiedCommerceOutcome(existing, outcome);
    const canonical = Object.freeze({
      ...merged,
      decisionGroupId: clean(identity.decisionGroupId || merged.decisionGroupId),
      decisionInstanceId: targetOwner,
      decisionOwnerKey: clean(identity.decisionOwnerKey || targetOwner),
      canonicalOwnerId: clean(identity.canonicalOwnerId || targetOwner),
      admissionSource: clean(identity.admissionSource || merged.admissionSource),
      actionId: clean(identity.actionId || merged.actionId)
    });
    if (existingOwner !== targetOwner) journal.delete(existingOwner);
    journal.set(targetOwner, canonical);
    if (actionId) actionOwners.set(actionId, targetOwner);
  };
  for (const entry of Array.isArray(previousJournal) ? previousJournal : []) add(entry);
  for (const outcome of admittedOutcomes) {
    add(outcome);
  }
  return Object.freeze([...journal.values()].slice(-80));
}

function verifiedOutcomeCoverage(
  obligations = [],
  journal = [],
  transactionOutcomeLedger = []
) {
  const coverageId = (entry = "") => canonicalDecisionOwnerKey(
    typeof entry === "object"
      ? {
          decisionOwnerKey: entry?.decisionOwnerKey,
          decisionInstanceId: entry?.decisionInstanceId,
          ownerKey: entry?.canonicalOwnerId
        }
      : { decisionInstanceId: entry }
  );
  // The durable receipt register is the sole expectation authority. Rebuild
  // coverage from it every turn rather than copying a second memory or
  // allowing journal/direct outcomes to invent expected identities.
  const expected = new Set();
  const expectedActionIds = new Set();
  // The receipt register, not the journal, establishes what must be
  // reconciled. A journal admission can be delayed or lost during a rerender;
  // the verified browser action cannot be allowed to disappear with it.
  for (const obligation of obligations) {
    if (obligation?.verified !== true || obligation?.originKind !== "verified_commerce_obligation") continue;
    expected.add(clean(obligation.decisionInstanceId || obligation.canonicalOwnerId));
    expectedActionIds.add(clean(obligation.actionId));
  }
  const journaledDecisionInstanceIds = (Array.isArray(journal) ? journal : [])
    .filter((entry) => entry?.verified === true && entry?.originKind === "verified_commerce_decision")
    .map((entry) => clean(entry.decisionInstanceId || entry.canonicalOwnerId))
    .filter(Boolean);
  const journaled = new Set((Array.isArray(journal) ? journal : [])
    .filter((entry) => entry?.verified === true && entry?.originKind === "verified_commerce_decision")
    .map(coverageId)
    .filter(Boolean));
  const expectedDecisionInstanceIds = [...expected].slice(-80);
  const reportedJournaledDecisionInstanceIds = journaledDecisionInstanceIds.slice(-80);
  const ledgerEntries = (Array.isArray(transactionOutcomeLedger) ? transactionOutcomeLedger : []);
  const ledgered = new Set(ledgerEntries
    .map(coverageId)
    .filter(Boolean));
  const ledgeredDecisionInstanceIds = ledgerEntries
    .map((entry) => clean(entry?.decisionInstanceId || entry?.canonicalOwnerId || entry?.decisionOwnerKey))
    .filter(Boolean)
    .slice(-80);
  const missingJournalDecisionInstanceIds = expectedDecisionInstanceIds.filter((id) => !journaled.has(coverageId(id)));
  const missingLedgerDecisionInstanceIds = expectedDecisionInstanceIds.filter((id) => !ledgered.has(coverageId(id)));
  const missingDecisionInstanceIds = [...new Set([
    ...missingJournalDecisionInstanceIds,
    ...missingLedgerDecisionInstanceIds
  ])];
  const missingActionIds = [...expectedActionIds].filter((actionId) => {
    const obligation = (Array.isArray(obligations) ? obligations : []).find((entry) => clean(entry?.actionId) === actionId);
    const ownerId = clean(obligation?.decisionInstanceId || obligation?.canonicalOwnerId);
    return !ownerId || !journaled.has(coverageId(ownerId)) || !ledgered.has(coverageId(ownerId));
  });
  return Object.freeze({
    expectedDecisionInstanceIds: Object.freeze(expectedDecisionInstanceIds),
    journaledDecisionInstanceIds: Object.freeze(reportedJournaledDecisionInstanceIds),
    ledgeredDecisionInstanceIds: Object.freeze(ledgeredDecisionInstanceIds),
    missingJournalDecisionInstanceIds: Object.freeze(missingJournalDecisionInstanceIds),
    missingLedgerDecisionInstanceIds: Object.freeze(missingLedgerDecisionInstanceIds),
    missingDecisionInstanceIds: Object.freeze(missingDecisionInstanceIds),
    expectedActionIds: Object.freeze([...expectedActionIds].slice(-120)),
    missingActionIds: Object.freeze(missingActionIds),
    complete: missingDecisionInstanceIds.length === 0 && missingActionIds.length === 0
  });
}

function choiceDecisionEpisode({
  previousTaskState = {},
  previousActionResult = null,
  canonicalDecisions = [],
  observation = {},
  surface = {}
} = {}) {
  const page = observation.page || {};
  const previousRaw = previousTaskState.decisionEpisode || null;
  const lastAction = previousActionResult?.action || observation.lastActionResult?.action || null;
  const lastLineage = actionDecisionLineage(
    previousActionResult || observation.lastActionResult,
    taskMechanics(previousTaskState),
    previousRaw || {}
  );
  const previousParentDecisionGroupId = clean(previousRaw?.parentDecisionGroupId);
  const explicitLastLineage = lastLineage.explicitLineage || {};
  // A corrupted or stale episode can be carried in an action envelope. If
  // that action itself targets a different, page-owned decision, it is a
  // sibling decision, never evidence that the old episode continues.
  const lineageTargetsVisiblePageSibling = Boolean(
    previousRaw
    && lastLineage.decisionGroupId
    && clean(lastLineage.decisionGroupId) !== previousParentDecisionGroupId
    && surface.type === "page"
    && canonicalDecisions.some((decision) => (
      clean(decision.decisionGroupId) === clean(lastLineage.decisionGroupId)
      && clean(decision.surfaceId || "surface-page") === clean(surface.id || "surface-page")
    ))
  );
  const previousActionContinues = Boolean(previousRaw && (
    lastLineage.explicit === true
    && !lineageTargetsVisiblePageSibling
    && (
      clean(explicitLastLineage.decisionEpisodeId) === clean(previousRaw.episodeId)
      || clean(explicitLastLineage.decisionInstanceId) === clean(previousRaw.decisionInstanceId || previousRaw.canonicalOwnerId)
      || clean(explicitLastLineage.parentDecisionGroupId) === clean(previousRaw.parentDecisionGroupId)
      || clean(explicitLastLineage.decisionGroupId) === clean(previousRaw.parentDecisionGroupId)
    )
  ));
  const currentFamily = surfaceEpisodeFamily(surface, canonicalDecisions);
  const previousFamily = clean(previousRaw?.family);
  const previousOwnerVisible = Boolean(previousRaw && canonicalDecisions.some((decision) => (
    (
      clean(decision.canonicalOwnerId) === clean(previousRaw.decisionInstanceId || previousRaw.canonicalOwnerId)
      || clean(decision.decisionGroupId) === clean(previousRaw.parentDecisionGroupId)
    )
    && GOAL_CREATING.has(decision.status)
  )));
  // Family + presentation subject is not ownership. Several sibling products
  // may all be `extras / select_an_option`; only an exact owner or the action
  // that opened its child surface may continue the previous episode.
  const previous = previousRaw && (previousActionContinues || previousOwnerVisible)
    ? previousRaw
    : null;
  const previousParentId = clean(previous?.parentDecisionGroupId);
  const previousParent = previousParentId
    ? canonicalDecisions.find((decision) => decision.decisionGroupId === previousParentId) || null
    : null;
  const selectedOnCurrentChoiceSurface = surface.type !== "page" ? canonicalDecisions.find((decision) => (
    COMPLETED.has(decision.status)
    && decision.selectedControlId
    && (page.controls || []).some((control) => (
      control.controlId === decision.selectedControlId
      && controlBelongsToCurrentSurface(control, page)
    ))
  )) || null : null;
  const familyParent = currentFamily ? canonicalDecisions.find((decision) => (
    episodeFamilyForDecision(decision) === currentFamily
    && (
      decision.surfaceId === surface.id
      || decision.decisionGroupId === surface.decisionGroupId
    )
    && GOAL_CREATING.has(decision.status)
  )) || canonicalDecisions.find((decision) => (
    episodeFamilyForDecision(decision) === currentFamily
    && (
      decision.surfaceId === surface.id
      || decision.decisionGroupId === surface.decisionGroupId
    )
    && decision.currentState?.selected === true
  )) || (surface.type !== "page" ? canonicalDecisions.find((decision) => (
    episodeFamilyForDecision(decision) === currentFamily
    && decision.currentState?.selected === true
    && clean(decision.surfaceId || "surface-page") !== clean(surface.id)
  )) : null) || canonicalDecisions.find((decision) => (
    episodeFamilyForDecision(decision) === currentFamily
    && GOAL_CREATING.has(decision.status)
  )) || null : null;
  const parent = previousActionContinues
    ? (previousParent || null)
    : (selectedOnCurrentChoiceSurface || familyParent || previousParent);
  if (!parent && !previous && !currentFamily) return null;
  const family = episodeFamilyForDecision(parent) || currentFamily || previousFamily;
  if (!DECISION_EPISODE_FAMILIES.has(family)) return null;
  const subjectKey = family === "seat"
    ? "seat_assignment"
    : episodeSubjectKeyForDecision(parent) || clean(previous?.subjectKey) || family;
  const parentDecisionGroupId = clean(
    parent?.decisionGroupId
    || previousParentId
    || surface.decisionGroupId
    || `${family}:${subjectKey}`
  );
  const decisionInstanceId = clean(
    previous?.decisionInstanceId
    || previous?.canonicalOwnerId
    || parent?.canonicalOwnerId
    || parentDecisionGroupId
  );
  const intendedParentControlId = clean(
    previousParentId
    && lastLineage.decisionGroupId === previousParentId
    && previousActionResult?.dispatched !== false
      ? (
          lastAction?.controlId
          || previousActionResult?.controlId
          || previousActionResult?.targetSnapshot?.controlId
        )
      : ""
  );
  const selectedControlId = clean(
    parent?.selectedControlId || previous?.selectedControlId || intendedParentControlId
  );
  const parentCompleted = Boolean(parent && COMPLETED.has(parent.status) && selectedControlId);
  const previousActionVerified = verifiedEpisodeAction(previousActionResult || observation.lastActionResult, previous);
  if (previous && previous.commitmentPhase === "confirmation_pending" && previousActionVerified) {
    const completedEpisode = {
      ...previous,
      decisionInstanceId,
      canonicalOwnerId: decisionInstanceId,
      outcomeVerified: true
    };
    const terminalOutcome = terminalEpisodeOutcome(completedEpisode, parent);
    return Object.freeze({
      ...completedEpisode,
      parentStatus: "satisfied",
      status: "completed",
      commitmentPhase: terminalOutcome.disposition === "paid" ? "committed_paid" : "committed_free",
      terminalOutcome,
      observationId: observation.observationId || ""
    });
  }
  const currentSurfaceKey = decisionEpisodeSurfaceKey(surface);
  const previousPath = Array.isArray(previous?.surfacePath) ? previous.surfacePath : [];
  const childConfirmationActive = Boolean(
    previous
    && surface.type !== "page"
    && previousPath[previousPath.length - 1]
    && previousPath[previousPath.length - 1] !== currentSurfaceKey
    && canonicalDecisions.some((decision) => (
      episodeFamilyForDecision(decision) === family
      && episodeSubjectKeyForDecision(decision) === subjectKey
      && decision.surfaceId === surface.id
      && GOAL_CREATING.has(decision.status)
    ))
  );
  const committedParent = parentCompleted && !childConfirmationActive;
  const surfacePath = previousPath[previousPath.length - 1] === currentSurfaceKey
    ? previousPath
    : [...previousPath, currentSurfaceKey].slice(-8);
  const semanticOutcomeKey = [
    clean(parent?.status || previous?.parentStatus || "active"),
    selectedControlId,
    clean(parent?.completionReason || "")
  ].join("|");
  const revisitedWithoutProgress = Boolean(
    previous
    && previous.semanticOutcomeKey === semanticOutcomeKey
    && previousPath.slice(0, -1).includes(currentSurfaceKey)
  );
  const cycleCount = revisitedWithoutProgress
    ? Number(previous.cycleCount || 0) + 1
    : Number(previous?.cycleCount || 0);
  const expandedChoiceOpeners = committedParent
    ? (page.controls || []).filter((control) => (
        control.controlId !== selectedControlId
        && control.state?.expanded === true
        && /combobox|button/.test(`${control.role || ""} ${control.kind || ""}`.toLowerCase())
        && [control.operations?.open, control.operations?.activate].some((capability) => (
          capability?.actionability?.executable === true
        ))
      ))
    : [];
  const exactOwnedOpeners = expandedChoiceOpeners.filter((control) => (
    control.decisionGroupId === parentDecisionGroupId
  ));
  const surfaceExitControlIds = exactOwnedOpeners.length === 1
    ? [exactOwnedOpeners[0].controlId]
    // Some sites give the collapsed combobox and its portal/listbox separate
    // group IDs. A single expanded page-owned choice opener while its exact
    // dropdown is foreground is still authoritative ownership evidence.
    : expandedChoiceOpeners.length === 1
      ? [expandedChoiceOpeners[0].controlId]
      : [];
  const surfaceExitControl = surfaceExitControlIds.length === 1
    ? expandedChoiceOpeners.find((control) => control.controlId === surfaceExitControlIds[0]) || null
    : null;
  const pendingSurfaceExit = Boolean(
    committedParent
    && surface.type !== "page"
    && /dropdown|listbox|menu|choice/.test(`${surface.type || ""} ${surface.surfaceClass || ""}`.toLowerCase())
    && surfaceExitControlIds.length
  );
  const status = cycleCount >= 2 && !committedParent
    ? "blocked_cycle"
    : pendingSurfaceExit
      ? "completed_pending_surface_exit"
      : committedParent
        ? "completed"
        : (previous ? "awaiting_child_confirmation" : "active");
  const episodeId = clean(previous?.episodeId)
    || `${clean(observation.page?.step || "unknown")}:${decisionInstanceId}`;
  const progress = page.foreground?.progressMarkers
    || page.visualState?.foreground?.progressMarkers
    || {};
  const segmentKey = clean(progress.flightOrdinal || progress.route || progress.segment);
  const previousSegments = Array.isArray(previous?.segmentOutcomes) ? previous.segmentOutcomes : [];
  const segmentOutcomes = previous?.currentSegmentKey
    && previousActionVerified
    && !previousSegments.some((entry) => entry.segmentKey === previous.currentSegmentKey)
      ? [...previousSegments, Object.freeze({
          segmentKey: previous.currentSegmentKey,
          outcome: previous.commitmentPhase === "committed_paid" ? "selected_paid" : "unselected",
          verified: true
        })]
      : previousSegments;
  const confirmationPending = family === "seat"
    && surface.type !== "page"
    && !segmentKey
    && segmentOutcomes.length > 0
    && !committedParent;
  const commitmentPhase = confirmationPending
    ? "confirmation_pending"
    : committedParent
      ? (parent.commitmentPhase === "committed_paid" ? "committed_paid" : "declined_free")
      : "option_pending";
  const outcomeVerified = Boolean(previous?.outcomeVerified || (committedParent && previousActionVerified));
  const terminalOutcome = committedParent ? terminalEpisodeOutcome({
    ...(previous || {}),
    family,
    subjectKey,
    parentDecisionGroupId,
    decisionInstanceId,
    canonicalOwnerId: decisionInstanceId,
    commitmentPhase,
    outcomeVerified
  }, parent) : null;
  const surfaceExitOwnership = pendingSurfaceExit && surfaceExitControl ? Object.freeze({
    kind: "parent_controls_active_surface",
    status: "proven",
    observationId: observation.observationId || "",
    activeSurfaceId: surface.id || "",
    activeSurfaceType: surface.type || "",
    parentSurfaceId: clean(surfaceExitControl.surfaceId || "surface-page"),
    parentControlId: surfaceExitControl.controlId,
    decisionEpisodeId: episodeId,
    parentDecisionGroupId,
    proof: Object.freeze({
      completedChoice: true,
      uniqueExpandedOpener: expandedChoiceOpeners.length === 1,
      exactDecisionOwner: exactOwnedOpeners.length === 1,
      declaredParentMatch: !surface.parentControlId || surface.parentControlId === surfaceExitControl.controlId
    })
  }) : null;
  return Object.freeze({
    episodeId,
    decisionInstanceId,
    canonicalOwnerId: decisionInstanceId,
    originKind: "commerce_decision",
    family,
    subjectKey,
    parentDecisionGroupId,
    requirementId: clean(parent?.requirementId || previous?.requirementId),
    intendedOutcome: clean(previous?.intendedOutcome || "selected_policy_allowed_option"),
    selectedControlId,
    parentStatus: clean(parent?.status || previous?.parentStatus || "active"),
    status,
    commitmentPhase,
    outcomeVerified,
    terminalOutcome,
    semanticOutcomeKey,
    surfacePath: Object.freeze(surfacePath),
    childSurfaceId: childConfirmationActive ? clean(surface.id) : "",
    surfaceExitControlIds: Object.freeze(surfaceExitControlIds),
    surfaceExitOwnership,
    cycleCount,
    cycleDetected: status === "blocked_cycle",
    segmentOutcomes: Object.freeze(segmentOutcomes),
    currentSegmentKey: segmentKey,
    observationId: observation.observationId || ""
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
    stageDecisionEvidence.terminalEvidence?.boundaryObserved === true
    || verifiedPaymentStage
    || strongStageEvidence
    || (
      hasReviewEnvelope
      && payControlIds.length
      && (paymentMethodControlIds.length || paymentCredentialControlIds.length)
    )
  );
  return Object.freeze({
    observed,
    terminalEvidence: stageDecisionEvidence.terminalEvidence || null,
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

const ADAPTIVE_SURFACE_MAX_STEPS = 6;
const ADAPTIVE_SURFACE_DEADLINE_MS = 20_000;

function boundedAdaptiveQueryHypotheses(goal = {}) {
  const desired = clean(goal.desiredValue || goal.canonicalValue);
  const terms = [
    ...(goal.choiceTerms || []),
    ...(goal.options || []).flatMap((option) => [option?.label, option?.value]),
    desired
  ].map(clean).filter(Boolean);
  const digits = desired.replace(/\D/g, "");
  const textual = terms.filter((term) => (
    /[a-z]/i.test(term)
    && lower(term) !== lower(desired)
    && !/^(?:select|choose|search|find|country|code|phone|dial|calling)$/i.test(term)
  ));
  return Object.freeze([...new Set([
    digits && digits !== desired ? digits : "",
    ...textual,
    desired
  ].filter(Boolean).map((value) => value.slice(0, 120)))].slice(0, 4));
}

function verifiedReversibleSurfaceEntry(actionResult = {}) {
  const expectedOutcome = actionResult.expectedOutcome || {};
  const action = actionResult.action || {};
  return Boolean(
    actionResult.verified === true
    && actionResult.expectedOutcomeObserved === true
    && actionResult.postconditionSatisfied === true
    && (
      expectedOutcome.type === "options_surface_appeared"
      || action.operation === "open"
      || action.mechanicalEffect === "open_surface"
    )
  );
}

function verifiedTypedChoiceSurfaceEntry({
  actionResult = {},
  previousGoal = {},
  observation = {},
  surface = {}
} = {}) {
  const action = actionResult.action || {};
  const expected = actionResult.expectedOutcome || {};
  const page = observation.page || {};
  const desiredValue = previousGoal.desiredValue ?? previousGoal.canonicalValue ?? "";
  const semanticType = clean(previousGoal.semanticType || previousGoal.sourceGoal?.semanticType);
  const componentRole = clean(previousGoal.componentRole || previousGoal.sourceGoal?.componentRole || "value");
  const goalControlId = clean(previousGoal.controlId || previousGoal.componentBinding?.controlId);
  const actionControlId = clean(action.controlId || expected.controlId);
  // Compact browser receipts keep the semantic goal ID at the receipt root;
  // the nested mechanical action is intentionally smaller. Accept either
  // location so persistence compaction cannot sever an active combobox from
  // the exact option surface it just revealed.
  const actionGoalId = clean(action.goalId || actionResult.goalId);
  const actionBelongsToGoal = Boolean(
    actionGoalId
    && clean(previousGoal.goalId)
    && actionGoalId === clean(previousGoal.goalId)
  );
  const controlIdentityMatches = !goalControlId || !actionControlId || goalControlId === actionControlId;
  if (!(
    actionResult.verified === true
    && actionResult.expectedOutcomeObserved === true
    && actionResult.postconditionSatisfied === true
    && actionBelongsToGoal
    && controlIdentityMatches
    && action.operation === "type"
    && expected.interactionKind === "editable_combobox"
    && expected.commitRequirement === "logical_component_committed"
    && surface.id
    && surface.type !== "page"
    && semanticType
    && clean(desiredValue)
  )) return false;

  // Some searchable choice widgets open their listbox as the direct result of
  // typing. The typed text is only a filter value, not a committed profile
  // value. Preserve the exact parent obligation only when the fresh foreground
  // surface contains a compatible choice actuator for that same value.
  return (page.controls || []).some((control) => {
    const operationNames = Object.keys(control.operations || {});
    if (!controlBelongsToCurrentSurface(control, page)) return false;
    if (!["option", "radio", "checkbox"].includes(lower(control.role || control.kind))
      && !operationNames.some((operation) => ["choose", "select"].includes(operation))) return false;
    return canonicalOptionMatch(semanticType, componentRole, desiredValue, {
      value: control.state?.optionValue || control.state?.selectedValue || control.currentValue || "",
      label: control.label || control.accessibleName || control.meaning || ""
    });
  });
}

function verifiedProfileComponentIdentity(value = {}) {
  return [
    clean(value.subjectId || "traveler_1"),
    clean(value.logicalFieldId || value.semanticType),
    clean(value.componentRole || "value")
  ].join("::");
}

function verifiedProfileComponentFromActionResult(actionResult = null, observationId = "") {
  if (!actionResult || typeof actionResult !== "object") return null;
  const expected = actionResult.expectedOutcome || {};
  const proof = actionResult.outcome?.evidence?.exactChildSettlement || {};
  const verified = Boolean(
    actionResult.verified === true
    && actionResult.expectedOutcomeObserved === true
    && actionResult.postconditionSatisfied === true
    && actionResult.outcome?.ok === true
    && clean(actionResult.outcome?.code || actionResult.failureCode) === "LOGICAL_COMPONENT_COMMITTED"
  );
  if (!verified || expected.type !== "logical_component_committed") return null;
  const completion = {
    contractVersion: "verified-profile-component/v1",
    completionId: verifiedProfileComponentIdentity({
      subjectId: expected.subjectId,
      logicalFieldId: expected.logicalFieldId,
      semanticType: expected.semanticType,
      componentRole: expected.componentRole
    }),
    status: "verified",
    actionId: clean(actionResult.actionId || actionResult.action?.id),
    observationId: clean(observationId || actionResult.resultObservationId || actionResult.observationId),
    logicalFieldId: clean(expected.logicalFieldId),
    subjectId: clean(expected.subjectId || "traveler_1"),
    semanticType: clean(expected.semanticType),
    componentRole: clean(expected.componentRole || "value"),
    parentControlId: clean(expected.controlId),
    selectedControlId: clean(proof.selectedControlId || actionResult.controlId || actionResult.action?.controlId),
    selectedActuatorId: clean(proof.selectedActuatorId || actionResult.action?.actuatorId || actionResult.action?.targetId),
    desiredCanonicalValue: clean(
      proof.desiredCanonicalValue
      || expected.expectedCanonicalValue
      || expected.expectedNormalizedValue
      || expected.expectedComponentValue
    ),
    selectedCanonicalValue: clean(
      proof.selectedCanonicalValue
      || actionResult.action?.value
      || actionResult.action?.targetLabel
    ),
    evidenceSource: proof.contractVersion === "exact-child-choice-settlement/v1"
      ? "canonical_exact_child_verifier"
      : "canonical_parent_state_verifier"
  };
  if (!completion.completionId || !completion.actionId || !completion.selectedCanonicalValue) return null;
  if (!agentContract.profileChoiceValueCompatible(
    completion.selectedCanonicalValue,
    completion.desiredCanonicalValue,
    completion.semanticType
  )) return null;
  return Object.freeze(completion);
}

function verifiedProfileComponentContradicted(completion = {}, descriptors = []) {
  const matching = descriptors.filter((descriptor) => (
    verifiedProfileComponentMatchesDescriptor(completion, descriptor)
    || Boolean(
      completion.logicalFieldId
      && descriptor.logicalFieldId
      && completion.logicalFieldId === descriptor.logicalFieldId
    )
  ));
  if (!matching.length) return false;
  return matching.some((descriptor) => {
    const validationErrors = [
      ...(descriptor.validationIssues || []),
      ...(descriptor.logicalFieldValidationIssues || [])
    ];
    if (validationErrors.length) return true;
    const currentValue = clean(
      descriptor.currentNormalizedValue
      || descriptor.control?.state?.normalizedValue
      || descriptor.control?.state?.selectedValue
      || descriptor.control?.state?.optionValue
    );
    return Boolean(
      currentValue
      && !agentContract.profileChoiceValueCompatible(
        currentValue,
        completion.desiredCanonicalValue,
        completion.semanticType
      )
    );
  });
}

function reconcileVerifiedProfileComponents(previous = [], admitted = null, descriptors = []) {
  const components = new Map();
  for (const completion of Array.isArray(previous) ? previous : []) {
    if (completion?.contractVersion === "verified-profile-component/v1" && completion?.status === "verified") {
      components.set(completion.completionId, completion);
    }
  }
  if (admitted) components.set(admitted.completionId, admitted);
  for (const [completionId, completion] of components.entries()) {
    if (verifiedProfileComponentContradicted(completion, descriptors)) components.delete(completionId);
  }
  return Object.freeze([...components.values()].slice(-80));
}

function verifiedProfileComponentMatchesDecision(completion = {}, decision = {}) {
  if (clean(decision.family || decision.subject?.family) !== "profile") return false;
  const semanticType = clean(
    decision.semanticType
    || decision.subject?.key
    || decision.observed?.fieldType
    || decision.observed?.semanticType
  );
  if (!semanticType || semanticType !== clean(completion.semanticType)) return false;
  const physicalControlIds = new Set([
    ...(decision.physicalControlIds || []),
    decision.controlId,
    decision.observed?.controlId
  ].map(clean).filter(Boolean));
  return Boolean(completion.parentControlId && physicalControlIds.has(clean(completion.parentControlId)));
}

function adaptiveSurfaceGoal({ previousTaskState = {}, actionResult = null, observation = {}, surface = {} } = {}) {
  if (!surface.id || surface.type === "page") return null;
  const previousGoal = taskMechanics(previousTaskState);
  const continuing = previousGoal.kind === "adaptive_surface"
    && previousGoal.adaptiveEnvelope?.surfaceId === surface.id;
  const entering = previousGoal.kind === "profile_field"
    && (
      verifiedReversibleSurfaceEntry(actionResult || {})
      || verifiedTypedChoiceSurfaceEntry({
        actionResult: actionResult || {},
        previousGoal,
        observation,
        surface
      })
    );
  if (!continuing && !entering) return null;

  const sourceGoal = continuing
    ? (previousGoal.sourceGoal || previousGoal)
    : previousGoal;
  const priorEnvelope = continuing ? previousGoal.adaptiveEnvelope || {} : {};
  const priorQueryHistory = Array.isArray(priorEnvelope.queryHistory)
    ? priorEnvelope.queryHistory.map(clean).filter(Boolean)
    : [];
  const completedQuery = continuing
    && actionResult?.action?.operation === "type"
    && actionResult?.dispatched !== false
      ? clean(actionResult.action.value)
      : "";
  const queryHistory = [...new Set([
    ...priorQueryHistory,
    completedQuery
  ].filter(Boolean))].slice(-ADAPTIVE_SURFACE_MAX_STEPS);
  const consumedStep = continuing
    && actionResult?.action?.goalId === previousGoal.goalId
    && actionResult?.dispatched !== false
      ? 1
      : 0;
  const remainingSteps = continuing
    ? Math.max(0, Number(priorEnvelope.remainingSteps || ADAPTIVE_SURFACE_MAX_STEPS) - consumedStep)
    : ADAPTIVE_SURFACE_MAX_STEPS;
  const now = Date.now();
  const deadlineAt = Number(priorEnvelope.deadlineAt || (now + ADAPTIVE_SURFACE_DEADLINE_MS));
  if (remainingSteps <= 0 || deadlineAt <= now) return null;

  const sourceGoalId = clean(sourceGoal.sourceGoalId || sourceGoal.goalId);
  const episodeId = clean(priorEnvelope.episodeId)
    || `${sourceGoalId || observation.observationId || "profile"}:surface:${surface.id}`;
  return Object.freeze({
    ...sourceGoal,
    kind: "adaptive_surface",
    goalId: `${episodeId}:step:${ADAPTIVE_SURFACE_MAX_STEPS - remainingSteps + 1}`,
    sourceGoalId,
    sourceGoal: Object.freeze({
      kind: sourceGoal.kind || "profile_field",
      goalId: sourceGoalId,
      semanticGoal: clean(sourceGoal.semanticGoal),
      semanticType: clean(sourceGoal.semanticType),
      desiredValue: sourceGoal.desiredValue,
      canonicalValue: sourceGoal.canonicalValue,
      logicalFieldId: clean(sourceGoal.logicalFieldId),
      subjectId: clean(sourceGoal.subjectId || "traveler_1"),
      controlId: clean(sourceGoal.controlId || sourceGoal.componentBinding?.controlId),
      componentRole: clean(sourceGoal.componentRole),
      componentBinding: Object.freeze({
        controlId: clean(sourceGoal.componentBinding?.controlId || sourceGoal.controlId),
        representationControlIds: Object.freeze([...(sourceGoal.componentBinding?.representationControlIds || [])]),
        stateControlIds: Object.freeze([...(sourceGoal.componentBinding?.stateControlIds || [])])
      }),
      choiceTerms: Object.freeze([...(sourceGoal.choiceTerms || [])].map(clean).filter(Boolean))
    }),
    semanticGoal: clean(sourceGoal.semanticGoal || `complete the current ${surface.label || "choice"}`),
    selectionMode: "ai_ambiguity",
    surfaceId: surface.id,
    observationId: observation.observationId || "",
    postcondition: sourceGoal.postcondition || {
      type: "profile_requirement_satisfied",
      semanticType: clean(sourceGoal.semanticType)
    },
    adaptiveEnvelope: Object.freeze({
      contractVersion: "bounded-adaptive-surface/v1",
      episodeId,
      objective: clean(sourceGoal.semanticGoal),
      desiredValue: sourceGoal.desiredValue,
      queryHypotheses: priorEnvelope.queryHypotheses
        || boundedAdaptiveQueryHypotheses(sourceGoal),
      queryHistory: Object.freeze(queryHistory),
      surfaceId: surface.id,
      surfaceType: surface.type,
      allowedOperations: Object.freeze(["open", "choose", "activate", "type", "select", "keyboard"]),
      forbiddenRisks: Object.freeze(["money", "payment", "legal"]),
      forbiddenEffects: Object.freeze([
        "select_paid_option",
        "add_paid",
        "accept_legal",
        "submit_payment",
        "submit_purchase",
        "advance_checkout_stage"
      ]),
      remainingSteps,
      deadlineAt
    })
  });
}

function reduceDecisionFrame({
  previousTaskState = {},
  observation = {},
  previousActionResult = null,
  verifiedCommerceObligations: suppliedVerifiedCommerceObligations = [],
  userPolicy = {},
  traveler = {},
  transactionReview = null,
  parentObjective = null,
  mechanicalEvidence = null,
  decisionFrame = null
} = {}) {
  if (!decisionFrameOwnsObservation(decisionFrame, observation)) {
    throw new Error("TASK_STATE_DECISION_FRAME_REQUIRED");
  }
  const authoritativeDecisionFrame = decisionFrame;
  const semanticCompilation = authoritativeDecisionFrame.semanticCompilation;
  observation = authoritativeDecisionFrame.observation;
  const previousGoal = taskMechanics(previousTaskState);
  const page = observation.page || {};
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
  const verifiedLineage = actionDecisionLineage(
    authoritativeActionResult,
    previousGoal,
    previousTaskState.decisionEpisode || {}
  );
  const verifiedDecisionGroupId = clean(
    verifiedExpectedOutcome.decisionGroupId
    || authoritativeActionResult?.decisionGroupId
    || verifiedAction.decisionGroupId
    || verifiedLineage.decisionGroupId
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
      || verifiedLineage.decisionInstanceId
      || (
        previousGoal.decisionGroupId === verifiedDecisionGroupId
          ? previousGoal.decisionInstanceId
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
        || previousGoal.requirementId
      ),
      surfaceId: clean(
        verifiedExpectedOutcome.surfaceId
        || authoritativeActionResult.targetSnapshot?.surfaceId
        || previousGoal.surfaceId
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
      traveler,
      decisionEpisode: previousTaskState.decisionEpisode || null
    });
    const decision = Object.freeze({
      ...normalizedDecision,
      instanceId,
      canonicalOwnerId: canonicalDecisionOwnerId(normalizedDecision, observation),
      originKind: normalizedDecision.family === "profile" ? "profile_field" : "commerce_decision"
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
  const canonicalControlDecisions = (authoritativeDecisionFrame.standaloneDecisions || []).filter((decision) => (
    !(decision.physicalControlIds || []).some((controlId) => observedPhysicalControlIds.has(controlId))
  )).map((decision) => Object.freeze({
    ...decision,
    canonicalOwnerId: canonicalDecisionOwnerId(decision, observation),
    originKind: decision.family === "profile" ? "profile_field" : "commerce_decision"
  }));
  const canonicalDecisions = Object.freeze([
    ...observedDecisions,
    ...canonicalControlDecisions
  ]);

  let decisionEpisode = choiceDecisionEpisode({
    previousTaskState,
    previousActionResult: authoritativeActionResult,
    canonicalDecisions,
    observation,
    surface
  });
  const durableVerifiedCommerceObligations = verifiedCommerceObligations(
    previousTaskState.verifiedCommerceObligations,
    suppliedVerifiedCommerceObligations
  );
  const admittedOutcomes = admittedVerifiedCommerceOutcomes({
    actionResult: authoritativeActionResult,
    canonicalDecisions,
    previousTaskState,
    decisionEpisode,
    observationId: observation.observationId || ""
  });
  // Keep the existing episode compiler as the richer source for true child
  // confirmations and aggregated seats. Receipts fill only the lossy gap:
  // exact ordinary selections whose page/episode vanished before admission.
  const receiptOutcomes = durableVerifiedCommerceObligations
    .map(commerceOutcomeFromVerifiedObligation)
    .filter(Boolean);
  let outcomeJournal = verifiedOutcomeJournal(
    previousTaskState.outcomeJournal,
    [...receiptOutcomes, ...admittedOutcomes]
  );
  let outcomeCoverage = verifiedOutcomeCoverage(
    durableVerifiedCommerceObligations,
    outcomeJournal,
    transactionReview?.outcomeLedger
  );

  const foreground = surface.type !== "page";
  const owned = canonicalDecisions.filter((decision) => {
    if (!foreground) return decision.surfaceId === "surface-page" || decision.surfaceType === "page";
    if (decision.surfaceId === surface.id || decision.decisionGroupId === surface.decisionGroupId) return true;
    // Surface metadata can lag behind a portal/rerender. Exact current-surface
    // controls owned by the decision are stronger than that stale container
    // label and keep a proven paid conflict ahead of navigation.
    return capabilitiesForDecision(decision, observation).length > 0;
  });
  let activeDecisions = owned
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
  // Cycle evidence is diagnostic, not a second mechanical exhaustion
  // authority. Failed-strategy memory owns whether a fresh actuator/method
  // remains. Suppressing the current decision here used to stop before that
  // recovery could try the next exact strategy. Stale episodes are already
  // excluded by canonical ownership when they are absent from activeDecisions.
  let routableActiveDecisions = activeDecisions;
  const suspendedDecisions = foreground
    ? canonicalDecisions.filter((decision) => decision.surfaceId !== surface.id && GOAL_CREATING.has(decision.status))
    : [];
  const validationBlockers = (page.validationIssues || []).filter((issue) => issue.stageWide === true || !issue.controlId || (page.controls || []).some((control) => (
    control.controlId === issue.controlId && controlBelongsToCurrentSurface(control, page)
  )));
  const controlIds = forwardControlIds(observation);
  const readyStageExitControlIds = (page.stageExit?.candidates || [])
    .filter((candidate) => candidate.executable === true || candidate.status === "ready")
    .map((candidate) => candidate.controlId)
    .filter((controlId) => controlIds.includes(controlId));
  const profileEvaluationStage = paymentReviewBoundary.observed ? "traveler_information" : stage;
  const paymentContactControlIds = new Set(
    paymentReviewBoundary.observed
      ? paymentReviewBoundary.pendingContactControlIds || []
      : []
  );
  // Payment surfaces often contain prose about email confirmations and
  // support. That text must not reopen the whole page as a traveler form.
  // At the terminal boundary, only exact controls already proven to be
  // unfinished contact inputs remain eligible for profile evaluation.
  const profilePage = {
    ...page,
    // Derived traveler facts must use the same immutable booking authority as
    // transaction reconciliation. This is especially important on later
    // pages whose visible date label omits a year.
    selectedBooking: transactionReview?.baseline || null
  };
  const profileObservation = paymentReviewBoundary.observed
    ? {
        ...observation,
        page: {
          ...profilePage,
          step: profileEvaluationStage,
          controls: (page.controls || []).filter((control) => paymentContactControlIds.has(control.controlId)),
          fields: (page.fields || []).filter((field) => paymentContactControlIds.has(field.controlId)),
          validationIssues: (page.validationIssues || []).filter((issue) => (
            issue.controlId && paymentContactControlIds.has(issue.controlId)
          ))
        }
      }
    : { ...observation, page: { ...profilePage, step: profileEvaluationStage } };
  const admittedVerifiedProfileComponent = verifiedProfileComponentFromActionResult(
    authoritativeActionResult,
    observation.observationId || ""
  );
  const verifiedProfileComponents = reconcileVerifiedProfileComponents(
    previousTaskState.verifiedProfileComponents,
    admittedVerifiedProfileComponent,
    authoritativeDecisionFrame.profileRequirements || []
  );
  // Canonical semantic verification is the only completion authority. Once
  // it verifies an exact component, blank framework shells cannot recreate a
  // parallel profile decision; explicit contradictory state still reopens it.
  activeDecisions = activeDecisions.filter((decision) => !verifiedProfileComponents.some((completion) => (
    verifiedProfileComponentMatchesDecision(completion, decision)
  )));
  routableActiveDecisions = routableActiveDecisions.filter((decision) => !verifiedProfileComponents.some((completion) => (
    verifiedProfileComponentMatchesDecision(completion, decision)
  )));
  const compiledProfileRequirements = authoritativeDecisionFrame.profileRequirements || [];
  const baseProfileReadiness = profileStageReadiness(
    profileObservation,
    traveler,
    verifiedProfileComponents,
    { descriptors: compiledProfileRequirements }
  );
  const missingDerivedFacts = Object.freeze((baseProfileReadiness.missingUserData || [])
    .map((item) => missingDerivedFactDependency(item.semanticType, traveler, {
      selectedBooking: transactionReview?.baseline || null
    }))
    .filter(Boolean));
  const activeRequirementGrounding = page.activeRequirementGrounding || null;
  const profileSelection = profileEvaluationStage === "traveler_information"
    && baseProfileReadiness.profileStage
    && !baseProfileReadiness.ready
        ? selectNextProfileRequirement(
          profileObservation,
          traveler,
          previousGoal,
          verifiedProfileComponents,
          { descriptors: compiledProfileRequirements }
        )
    : { goal: null, blockedFields: [], failureCode: "" };
  const profileReadiness = Object.freeze({
    ...baseProfileReadiness,
    temporarilyBlockedFields: Object.freeze(profileSelection.blockedFields || []),
    // A bounded model result is diagnostic binding evidence. It may refine an
    // obligation already admitted by TaskState, but a negative/unknown answer
    // cannot independently create work or make profile readiness false.
    activeRequirementGrounding,
    missingDerivedFacts,
    blockedReasonCode: missingDerivedFacts.length
      ? "SELECTED_BOOKING_FACT_MISSING"
      : baseProfileReadiness.missingUserData?.length
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
  const transactionEvidenceReady = transactionReview?.ready === true
    && outcomeCoverage.complete === true;
  const paymentCompletionObserved = !siteFailure
    && paymentReviewBoundary.observed
    && !pendingPaymentReviewContact
    && transactionEvidenceReady;
  const transactionReviewBlocked = !siteFailure
    && paymentReviewBoundary.observed
    && !pendingPaymentReviewContact
    && !transactionEvidenceReady;
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
    contractVersion: stageDecisionEvidence.terminalEvidence?.contractVersion || "",
    signals: stageDecisionEvidence.terminalEvidence?.signals || {},
    signalCount: stageDecisionEvidence.terminalEvidence?.signalCount ?? stageDecisionEvidence.paymentSignals,
    evidenceOnly: true,
    paymentActionsAllowed: false,
    boundaryObserved: paymentReviewBoundary.observed,
    pendingContact: pendingPaymentReviewContact,
    boundary: paymentReviewBoundary,
    currentlyObserved: paymentCompletionObserved,
    observed: terminalGoalLatch.locked,
    transactionVerified: transactionEvidenceReady,
    missingTransactionFacts: Object.freeze([
      ...(transactionReview?.missingFacts || []),
      ...(outcomeCoverage.complete ? [] : ["verified_decision_outcomes"])
    ]),
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
  // A verified profile-field opener transfers that exact unfinished task to
  // its child surface. Do not make continuity depend on re-derived page
  // readiness: a portalled dropdown may temporarily hide/suspend its parent
  // field and make the page look complete even though no value was selected.
  const adaptiveGoal = adaptiveSurfaceGoal({
    previousTaskState,
    actionResult: authoritativeActionResult,
    observation,
    surface
  });
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
    } else if (adaptiveGoal) {
      // A verified reversible opener may reveal controls whose local labels no
      // longer repeat the parent profile field semantics. Preserve the exact
      // unfinished objective inside that one foreground surface instead of
      // erasing it and falling into a generic no-actuator stop.
      currentGoal = adaptiveGoal;
    } else if (profileGoal && (!foreground || foregroundOwnsProfileGoal)) {
      currentGoal = Object.freeze(profileGoal);
    } else if (profileReadiness.profileStage && !profileReadiness.ready && !profileGoal) {
      // An unresolved profile field with no executable actuator must not be
      // replaced by a navigation or unrelated surface goal. A fresh
      // observation will re-evaluate every temporarily blocked field.
      currentGoal = null;
    } else if (routableActiveDecisions.length) {
      const decision = routableActiveDecisions[0];
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
      const paidOnlyUnselectedDecision = Boolean(
        optionContract.paidControlIds.length
        && decision.priceRisk?.selectedPaid !== true
        && optionContract.freeControlIds.length === 0
        && optionContract.correctionControlIds.length === 0
        && optionContract.policyAllowedControlIds.length === 0
      );
      const independentlyProvenPolicyExit = paidOnlyUnselectedDecision
        && controlIds.length
        && ["random_assignment", "declined_or_free", "no_insurance", "included_base_fare"].includes(
          clean(decision.userIntent?.desiredOutcome || optionContract.desiredPolicyOutcome)
        );
      // A stage exit is never a substitute for an unavailable choice. UI mode
      // toggles are filtered by typed commerce truth before reaching this
      // branch; a genuine selected paid item must be reversed by its exact
      // owned actuator. If no such actuator exists, bounded recovery owns the
      // stop instead of silently treating Next or Back as Skip.
      if (!viableDecisionCapabilities.length && independentlyProvenPolicyExit) {
        // No paid item is selected and every unresolved option would add a
        // charge. In this narrow state, an independently compiled current-
        // surface stage exit is progress without selection, not a replacement
        // actuator for Skip. A genuine selected-paid conflict can never enter
        // this branch and still requires its exact reversal.
        currentGoal = navigationGoal(observation, controlIds);
      } else if (!viableDecisionCapabilities.length && decisionCapabilities.length) {
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
        currentGoal = null;
        ambiguityReason = "no_goal_relevant_candidate";
      } else {
        currentGoal = goalForDecision(decision, observation, userPolicy, traveler);
      }
    } else if (decisionEpisode?.status === "completed_pending_surface_exit") {
      currentGoal = completedChoiceSurfaceGoal(observation, decisionEpisode);
    } else if (validationBlockers.length) {
      currentGoal = null;
      ambiguityReason = "contradictory_or_validation_evidence";
    } else if (unblockedStageExitReady(page) && readyStageExitControlIds.length) {
      // Decisive stage invariant: after canonical profile/decision/validation
      // admission has produced no blocker, an exact executable stage exit is
      // the next task. Optional blank framework representations cannot outrank
      // it or manufacture a new semantic obligation.
      currentGoal = navigationGoal(observation, readyStageExitControlIds);
    } else if (controlIds.length && foreground && (
      ["review_confirmation", "warning", "navigation", "choice_set"].includes(surfaceClass)
      || (page.stageExit?.candidates || []).some((candidate) => controlIds.includes(candidate.controlId))
    )) {
      currentGoal = navigationGoal(observation, controlIds);
    } else if (foreground && stage === "unknown") {
      currentGoal = null;
      ambiguityReason = "unknown_foreground_surface";
    } else if (controlIds.length) {
      currentGoal = navigationGoal(observation, controlIds);
    } else if (
      page.stageExit?.continueObserved === true
      || (page.stageExit?.candidates || []).length > 0
    ) {
      currentGoal = null;
      ambiguityReason = page.stageExit?.continueDisabled === true
        ? "navigation_disabled_without_active_requirement"
        : "navigation_actuator_unavailable";
    } else {
      const currentCapabilities = (page.controls || []).filter((control) => controlBelongsToCurrentSurface(control, page));
      if (foreground || currentCapabilities.length) {
        currentGoal = null;
        ambiguityReason = foreground ? "unknown_foreground_surface" : "no_goal_relevant_candidate";
      }
    }
  }
  // Formal compilation remains the preferred path, but it is no longer a
  // prerequisite for one harmless reversible mechanic. When the task is
  // unfinished and no canonical goal survived, publish one bounded adaptive
  // interaction over exact current-surface actuators. The consequence
  // governor and fresh postcondition verification remain authoritative.
  const adaptiveFallbackReasons = new Set([
    "navigation_actuator_unavailable",
    "navigation_disabled_without_active_requirement",
    "no_goal_relevant_candidate",
    "unknown_foreground_surface"
  ]);
  if (
    terminalStatus === "active"
    && !currentGoal
    && adaptiveFallbackReasons.has(ambiguityReason)
    && !siteFailure
    && !validationBlockers.length
    && (!profileReadiness.profileStage || profileReadiness.ready === true)
    && !paymentReviewBoundary.observed
  ) {
    const fallback = adaptiveInteractionGoal({
      observation,
      userPolicy,
      traveler,
      reason: ambiguityReason
    });
    if (fallback) {
      currentGoal = fallback;
      ambiguityReason = "";
    }
  }
  // Candidate exhaustion is mechanical evidence, not authority for the loop
  // to replace semantic work. When the exact TaskState-published goal has
  // exhausted its grounded strategies, TaskState alone may yield to one
  // consequence-gated adaptive goal on the same fresh surface.
  const mechanicalEvidenceOwnsGoal = Boolean(
    mechanicalEvidence?.kind === "goal_strategies_exhausted"
    && (
      !mechanicalEvidence.observationHash
      || mechanicalEvidence.observationHash === (
        observation.observationSnapshot?.snapshotHash || page.snapshotHash || ""
      )
    )
    && (
      mechanicalEvidence.goalId === currentGoal?.goalId
      || (
        mechanicalEvidence.semanticGoalKey
        && mechanicalEvidence.semanticGoalKey === semanticGoalKey(currentGoal || {})
      )
      || (
        mechanicalEvidence.decisionGroupId
        && mechanicalEvidence.decisionGroupId === (
          currentGoal?.decisionGroupId || currentGoal?.subject?.decisionGroupId
        )
      )
    )
  );
  if (
    terminalStatus === "active"
    && currentGoal
    && mechanicalEvidenceOwnsGoal
    && !["profile_field", "adaptive_surface", "adaptive_interaction"].includes(currentGoal.kind)
    && !["payment", "legal"].includes(currentGoal.semanticType)
    && !siteFailure
    && !paymentReviewBoundary.observed
  ) {
    const fallback = adaptiveInteractionGoal({
      observation,
      userPolicy,
      traveler,
      reason: "canonical_goal_exhausted_without_observable_change",
      excludedControlIds: mechanicalEvidence.excludedControlIds || []
    });
    if (fallback) {
      currentGoal = fallback;
      ambiguityReason = "";
    }
  }
  const unresolvedGroundingControlIds = new Set(
    activeRequirementGrounding?.status !== "bound"
      ? (activeRequirementGrounding?.candidateComponentIds || []).map(clean).filter(Boolean)
      : []
  );
  const currentGoalFamily = lower(
    currentGoal?.canonicalSubject?.family
    || currentGoal?.subject?.family
    || currentGoal?.family
  );
  const groundingOwnsCurrentGoal = Boolean(
    currentGoal
    && currentGoalFamily === "profile"
    && (currentGoal.candidateControlIds || admittedControlIdsForGoal(currentGoal))
      .some((controlId) => unresolvedGroundingControlIds.has(clean(controlId)))
  );
  if (groundingOwnsCurrentGoal) {
    // Unknown grounding may block only the exact profile obligation that
    // TaskState already admitted. It cannot make profile readiness false,
    // preempt a sibling decision, or veto navigation from page-wide context.
    currentGoal = Object.freeze({
      ...currentGoal,
      ambiguity: Object.freeze({
        code: "ACTIVE_REQUIREMENT_UNRESOLVED",
        reason: clean(activeRequirementGrounding.evidence || "The admitted profile component could not be bound to a supplied traveler fact.")
      })
    });
    ambiguityReason = "active_requirement_unresolved";
  }
  if (!decisionEpisode && currentGoal?.decisionGroupId) {
    const parent = canonicalDecisions.find((decision) => decision.decisionGroupId === currentGoal.decisionGroupId) || null;
    const family = episodeFamilyForDecision(parent);
    if (parent && family) {
      const subjectKey = episodeSubjectKeyForDecision(parent);
      const decisionInstanceId = clean(parent.canonicalOwnerId || parent.decisionGroupId);
      decisionEpisode = Object.freeze({
        episodeId: `${stage}:${decisionInstanceId}`,
        decisionInstanceId,
        canonicalOwnerId: decisionInstanceId,
        originKind: "commerce_decision",
        family,
        subjectKey,
        parentDecisionGroupId: parent.decisionGroupId,
        requirementId: clean(parent.requirementId),
        intendedOutcome: clean(currentGoal.desiredSemanticOutcome || currentGoal.desiredPolicyOutcome || "selected_policy_allowed_option"),
        selectedControlId: clean(parent.selectedControlId),
        parentStatus: clean(parent.status || "active"),
        status: COMPLETED.has(parent.status) ? "completed" : "active",
        commitmentPhase: COMPLETED.has(parent.status)
          ? (parent.commitmentPhase || "committed")
          : "option_pending",
        outcomeVerified: false,
        terminalOutcome: COMPLETED.has(parent.status)
          ? terminalEpisodeOutcome({
              family,
              subjectKey,
              parentDecisionGroupId: parent.decisionGroupId,
              decisionInstanceId,
              canonicalOwnerId: decisionInstanceId,
              outcomeVerified: false
            }, parent)
          : null,
        semanticOutcomeKey: `${clean(parent.status || "active")}|${clean(parent.selectedControlId)}|${clean(parent.completionReason)}`,
        surfacePath: Object.freeze([decisionEpisodeSurfaceKey(surface)]),
        surfaceExitControlIds: Object.freeze([]),
        cycleCount: 0,
        cycleDetected: false,
        segmentOutcomes: Object.freeze([]),
        currentSegmentKey: "",
        observationId: observation.observationId || ""
      });
    }
  }
  const surfaceSubgoal = createSurfaceSubgoal(previousTaskState, currentGoal, surface, surfaceClass, stageOutcome);
  if (currentGoal) {
    // An active episode can annotate only its exact parent decision (or its
    // proven close-child surface). Never copy it into the next sibling goal.
    const activeEpisode = decisionEpisode
      && !["completed", "blocked_cycle"].includes(decisionEpisode.status)
      && episodeOwnsGoal(decisionEpisode, currentGoal)
      ? decisionEpisode
      : null;
    currentGoal = Object.freeze({
      ...currentGoal,
      decisionInstanceId: activeEpisode?.decisionInstanceId || decisionInstanceKey(currentGoal, observation),
      canonicalOwnerId: activeEpisode?.canonicalOwnerId || activeEpisode?.decisionInstanceId || "",
      ...(activeEpisode
        ? {
            decisionEpisodeId: activeEpisode.episodeId,
            parentDecisionGroupId: activeEpisode.parentDecisionGroupId,
            parentExpectedSelectedControlId: activeEpisode.selectedControlId,
            decisionEpisodeStatus: activeEpisode.status
          }
        : {}),
      transactionOutcomeId: transactionOutcome.outcomeId,
      stageOutcomeId: stageOutcome.outcomeId,
      surfaceSubgoalId: surfaceSubgoal?.subgoalId || "",
      parentOutcomeContract: stageOutcome.outcomeContract,
      outcomeContract: surfaceSubgoal?.outcomeContract || outcomeContractForGoal(currentGoal, observation)
    });
  }
  const semanticAchievements = [...completions.values()].map((completion) => Object.freeze({
    achievementId: clean(completion.instanceId || completion.decisionGroupId || completion.requirementId),
    kind: completion.requirementId ? "requirement" : "decision",
    status: "verified",
    label: clean(completion.completionReason || completion.requirementId || completion.decisionGroupId),
    observationId: clean(completion.observationId)
  }));
  const transactionAchievements = [
    ...(transactionReview?.outcomeLedger || []),
    ...outcomeJournal
  ].map((outcome) => Object.freeze({
    achievementId: clean(outcome.outcomeKey || outcome.decisionInstanceId || outcome.decisionGroupId),
    kind: clean(outcome.family || "transaction"),
    status: "verified",
    label: clean(outcome.label || outcome.outcome || outcome.disposition),
    observationId: ""
  }));
  const achievements = [...new Map([...semanticAchievements, ...transactionAchievements]
    .filter((achievement) => achievement.achievementId)
    .map((achievement) => [achievement.achievementId, achievement])).values()].slice(-160);
  const unresolved = [
    ...(profileReadiness.missingUserData || []).map((field) => `profile:${clean(field)}`),
    ...activeDecisions.map((decision) => `decision:${clean(decision.decisionGroupId || decision.decisionId)}`),
    ...(paymentReviewBoundary.observed ? (transactionReview?.missingFacts || []).map((fact) => `transaction:${clean(fact)}`) : []),
    ...(paymentReviewBoundary.observed ? (transactionReview?.contradictions || []).map((fact) => `contradiction:${clean(fact)}`) : [])
  ].filter(Boolean);
  const processAwareness = Object.freeze({
    status: terminalGoalLatch.locked
      ? "goal_achieved"
      : siteFailure
        ? "blocked_by_site"
        : transactionReviewBlocked
          ? "verifying_final_transaction"
          : "in_progress",
    currentPosition: Object.freeze({
      stage: paymentReviewBoundary.observed ? "payment_review" : stage,
      surfaceId: clean(surface.id || "surface-page"),
      surfaceType: clean(surface.type || "page"),
      surfaceClass
    }),
    currentObjective: clean(
      currentGoal?.semanticGoal
      || (transactionReviewBlocked ? "verify the final transaction" : "reach verified payment review")
    ),
    achievements: Object.freeze(achievements),
    unresolved: Object.freeze([...new Set(unresolved)].slice(0, 160)),
    finalOutcome: Object.freeze({
      achieved: terminalGoalLatch.locked === true,
      status: terminalStatus,
      transactionVerified: transactionEvidenceReady,
      evidence: clean(terminalGoalLatch.completionEvidence)
    })
  });

  const currentObligation = currentObligationFromGoal({
    goal: currentGoal,
    decisionFrame: authoritativeDecisionFrame,
    recoveryState: previousTaskState.recovery || previousTaskState.recoveryState || {}
  });
  const missingProfileFact = (profileReadiness.missingUserData || [])[0] || null;
  const missingDerivedFact = (profileReadiness.missingDerivedFacts || [])[0] || null;
  const authorizationConflict = activeDecisions.find((decision) => (
    decision.reopenEvidence?.code === "PAID_SELECTION_POLICY_AUTHORIZATION_CONFLICT"
  )) || null;
  const previousDisposition = previousTaskState.disposition || {};
  const admittedMechanicsExhausted = Boolean(
    mechanicalEvidenceOwnsGoal
    && currentGoal
    && (
      mechanicalEvidence.goalId === currentGoal.goalId
      || mechanicalEvidence.semanticGoalKey === semanticGoalKey(currentGoal)
    )
  );
  const dispositionCode = clean(
    siteFailure ? "SITE_FAILURE_OBSERVED"
      : terminalStatus === "payment_review_reached" ? "PAYMENT_REVIEW_REACHED"
      : terminalStatus === "checkout_left" ? "CHECKOUT_LEFT"
      : transactionReviewBlocked ? "TRANSACTION_REVIEW_INCOMPLETE"
      : authorizationConflict ? "PAID_SELECTION_POLICY_AUTHORIZATION_CONFLICT"
      : admittedMechanicsExhausted ? "STRATEGIES_EXHAUSTED"
      : currentGoal?.ambiguity?.code ? currentGoal.ambiguity.code
      : currentObligation ? "EXECUTE_CURRENT_OBLIGATION"
      : missingDerivedFact ? "SELECTED_BOOKING_FACT_MISSING"
      : missingProfileFact ? "MISSING_PROFILE_DATA"
      : validationBlockers.length ? "ACTIVE_VALIDATION_BLOCKER"
      : profileReadiness.blockedReasonCode ? profileReadiness.blockedReasonCode
      : ambiguityReason ? ambiguityReason
      : "NO_CURRENT_OBLIGATION"
  );
  const sameReobserveDisposition = Boolean(
    previousDisposition.kind === "wait_reobserve"
    && previousDisposition.code === dispositionCode
    && previousDisposition.surfaceFingerprint === fingerprint
  );
  const reobserveCount = sameReobserveDisposition
    ? Number(previousDisposition.reobserveCount || 0) + 1
    : 1;
  const reobserveStartedAt = sameReobserveDisposition
    ? Number(previousDisposition.reobserveStartedAt || Date.now())
    : Date.now();
  const reobserveDeadlineAt = sameReobserveDisposition
    ? Number(previousDisposition.reobserveDeadlineAt || (reobserveStartedAt + TASK_STATE_REOBSERVE_DEADLINE_MS))
    : reobserveStartedAt + TASK_STATE_REOBSERVE_DEADLINE_MS;
  const reobserveRetryToken = sameReobserveDisposition
    ? clean(previousDisposition.retryToken)
    : `reobserve_${stableSemanticToken(`${dispositionCode}:${fingerprint}`, 42)}_${reobserveStartedAt.toString(36)}`;
  let disposition;
  if (siteFailure) {
    disposition = {
      kind: "stop",
      code: dispositionCode,
      reason: clean(siteFailure.message || "The active checkout surface reports a site failure."),
      userActionRequired: false
    };
  } else if (terminalStatus === "payment_review_reached") {
    disposition = {
      kind: "terminal",
      code: dispositionCode,
      reason: "The approved transaction is reconciled at payment review.",
      userActionRequired: true
    };
  } else if (terminalStatus === "checkout_left") {
    disposition = {
      kind: "request_approval",
      code: dispositionCode,
      reason: "The browser left the active checkout and returned to flight search.",
      userActionRequired: true
    };
  } else if (transactionReviewBlocked) {
    disposition = {
      kind: "request_approval",
      code: dispositionCode,
      reason: "Payment review is visible, but the approved transaction cannot yet be fully reconciled.",
      userActionRequired: true,
      details: Object.freeze({
        missingFacts: Object.freeze([...(transactionReview?.missingFacts || []), ...(outcomeCoverage.complete ? [] : ["verified_decision_outcomes"])]),
        contradictions: Object.freeze([...(transactionReview?.contradictions || [])])
      })
    };
  } else if (authorizationConflict) {
    disposition = {
      kind: "request_approval",
      code: dispositionCode,
      reason: "A current paid selection conflicts with both the saved decline policy and an explicit item authorization.",
      userActionRequired: true,
      details: Object.freeze({
        decisionGroupId: clean(authorizationConflict.decisionGroupId),
        conflict: authorizationConflict.reopenEvidence
          ? Object.freeze({ ...authorizationConflict.reopenEvidence })
          : null
      })
    };
  } else if (admittedMechanicsExhausted) {
    disposition = {
      kind: "stop",
      code: dispositionCode,
      reason: "The exact admitted obligation exhausted its bounded grounded mechanics without a verified result.",
      obligationId: clean(currentGoal.goalId),
      userActionRequired: false
    };
  } else if (currentGoal?.ambiguity) {
    disposition = {
      kind: "request_approval",
      code: dispositionCode || "SEMANTIC_AMBIGUITY",
      reason: clean(currentGoal.ambiguity.reason || "The current admitted checkout obligation is ambiguous."),
      userActionRequired: true
    };
  } else if (currentObligation) {
    disposition = {
      kind: "execute",
      code: dispositionCode,
      reason: "Execute the exact current TaskState obligation.",
      obligationId: currentObligation.obligationId,
      userActionRequired: false
    };
  } else if (missingDerivedFact || missingProfileFact) {
    disposition = {
      kind: "request_input",
      code: dispositionCode,
      reason: missingDerivedFact
        ? clean(missingDerivedFact.label || "A selected-booking fact required to derive traveler data is missing.")
        : clean(missingProfileFact.label || missingProfileFact.semanticType || "Required traveler information is missing."),
      field: clean(missingProfileFact?.semanticType),
      fieldLabel: clean(missingProfileFact?.label || missingProfileFact?.semanticType),
      missingDerivedFact: missingDerivedFact ? Object.freeze({ ...missingDerivedFact }) : null,
      userActionRequired: true
    };
  } else if (validationBlockers.length) {
    disposition = {
      kind: "request_approval",
      code: dispositionCode,
      reason: "The active checkout surface reports validation that is not owned by an executable obligation.",
      userActionRequired: true
    };
  } else if (["ACTIVE_REQUIREMENT_UNRESOLVED", "SEMANTIC_AMBIGUITY", "active_requirement_unresolved", "contradictory_or_validation_evidence"].includes(dispositionCode)) {
    disposition = {
      kind: "request_approval",
      code: dispositionCode,
      reason: "The active checkout requirement cannot be resolved deterministically from the fresh evidence.",
      userActionRequired: true
    };
  } else if (reobserveCount === 1) {
    disposition = {
      kind: "wait_reobserve",
      code: dispositionCode,
      reason: "No executable obligation is proven yet; request a fresh settled observation before stopping.",
      reobserveCount,
      retryToken: reobserveRetryToken,
      reobserveStartedAt,
      reobserveDeadlineAt,
      surfaceFingerprint: fingerprint,
      userActionRequired: false
    };
  } else {
    disposition = {
      kind: "stop",
      code: dispositionCode || "READINESS_DEADLINE_EXHAUSTED",
      reason: "The same settled surface produced no executable obligation after the bounded re-observation deadline.",
      reobserveCount,
      surfaceFingerprint: fingerprint,
      userActionRequired: false
    };
  }
  disposition = Object.freeze(disposition);

  const transactionReviewProjection = transactionReview ? Object.freeze({
    ...transactionReview,
    ready: transactionEvidenceReady,
    missingFacts: Object.freeze([
      ...(transactionReview.missingFacts || []),
      ...(outcomeCoverage.complete ? [] : ["verified_decision_outcomes"])
    ]),
    outcomeCoverage
  }) : null;
  const readModel = Object.freeze({
    paymentEvidence,
    foregroundSurface: Object.freeze(surface),
    surfaceClass,
    siteFailure,
    activeDecisions: Object.freeze(activeDecisions),
    observedDecisions: Object.freeze(observedDecisions),
    canonicalDecisions,
    suspendedDecisions: Object.freeze(suspendedDecisions),
    validationBlockers: Object.freeze(validationBlockers),
    stageDecisionEvidence: Object.freeze(stageDecisionEvidence),
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
    transactionReview: transactionReviewProjection,
    processAwareness
  });
  const taskState = Object.freeze({
    contractVersion: "task-state/v2",
    goal: Object.freeze({ id: "reach_payment_review", status: terminalGoalLatch.locked ? "completed" : "active" }),
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
    terminalGoalLatch,
    checkoutBoundary,
    stage,
    transactionOutcome,
    stageOutcome,
    surfaceSubgoal,
    decisionEpisode,
    verifiedCommerceObligations: durableVerifiedCommerceObligations,
    verifiedProfileComponents,
    outcomeJournal,
    outcomeCoverage,
    completedOutcomes: Object.freeze([...completions.values()].slice(-160)),
    verificationDecisionMemory: Object.freeze(canonicalDecisions.slice(-80).map(verificationDecisionRecord)),
    currentObligation,
    disposition,
    decisionFrameId: authoritativeDecisionFrame.frameId,
    terminalStatus,
    surfaceFingerprint: fingerprint,
    meaningfulSurfaceChange,
    clearObsoleteRecovery: Boolean(
      (previousTaskState.stageOutcome?.outcomeId
        && previousTaskState.stageOutcome.outcomeId !== stageOutcome.outcomeId)
      || stageOutcome.status === "completed"
    ),
    parentObjective: parentObjective || previousTaskState.parentObjective || null
  });
  taskStateReadModels.set(taskState, readModel);
  return taskState;
}

module.exports = {
  decideStage,
  durableOutcomeHierarchy,
  reconcileVerifiedProfileComponents,
  reduceDecisionFrame,
  taskStateReadModel,
  surfaceClassFrom,
  stageEvidence,
  verifiedCommerceObligationFromActionResult,
  verifiedProfileComponentFromActionResult
};
