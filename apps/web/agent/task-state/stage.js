const { currentSurface, controlBelongsToCurrentSurface } = require("../surface-contract");
const agentContract = require("../../../extension/src/shared/agent-contract");

function clean(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function lower(value = "") {
  return clean(value).toLowerCase();
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

module.exports = { decideStage, stageEvidence };
