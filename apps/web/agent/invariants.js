const { withUpdate } = require("../../../packages/shared/agent-state");
const {
  canonicalFareBrand,
  durableCommerceSelections,
  factsFromObservation,
  mergeCommerceSelections,
  normalizeFacts
} = require("./transaction-facts");
const { controlBelongsToCurrentSurface } = require("./surface-contract");
const { currentObligation } = require("./authority-frames");
const { obligationField } = require("./current-obligation");
const agentContract = require("../../extension/src/shared/agent-contract");

function text(value, limit = 180) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function normalizedText(value, limit = 180) {
  return text(value, limit).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function number(value) {
  if (value == null || value === "") return null;
  const parsed = Number(String(value).replace(",", ".").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function baselineTotalAmount(facts = {}) {
  const amount = number(facts.totalPrice?.amount);
  const evidence = facts.factEvidence?.totalPrice || null;
  if (facts.evidenceMode === "typed" && (
    evidence?.authoritative !== true
    || evidence?.role !== "booking_total"
  )) return null;
  if (amount !== 0) return amount;
  // Zero is often a loading placeholder. It may become immutable only when
  // complete itinerary identity and authoritative price ownership prove that
  // zero is the real transaction total (for example a points redemption).
  const segments = facts.itinerary?.segments || [];
  const completeIdentity = facts.itinerary?.completeness === "complete"
    && segments.length > 0
    && segments.every((segment) => segment.origin && segment.destination);
  return completeIdentity && facts.factEvidence?.totalPrice?.authoritative === true ? 0 : null;
}

function coherentBookingEnvelope(facts = {}) {
  const segments = facts.itinerary?.segments || [];
  return facts.itinerary?.completeness === "complete"
    && segments.length > 0
    && segments.every((segment) => segment.origin && segment.destination && segment.departureDate)
    && (facts.travelers || []).length > 0
    && Boolean(facts.currency)
    && facts.factEvidence?.totalPrice?.authoritative === true
    && facts.factEvidence?.totalPrice?.role === "booking_total";
}

function promotableObservedTotal(facts = {}) {
  const amount = baselineTotalAmount(facts);
  if (amount == null) return null;
  // Legacy observations are retained only for migration. The current typed
  // producer must prove one coherent selected-booking envelope before its
  // monetary fact can enter the immutable baseline.
  if (facts.evidenceMode !== "typed") return amount;
  return coherentBookingEnvelope(facts) ? amount : null;
}

function comparableBookingTotals(left = {}, right = {}) {
  const leftEvidence = left.factEvidence?.totalPrice || null;
  const rightEvidence = right.factEvidence?.totalPrice || null;
  const legacyPair = left.evidenceMode !== "typed" && right.evidenceMode !== "typed";
  const sameTypedRole = leftEvidence?.authoritative === true
    && rightEvidence?.authoritative === true
    && leftEvidence.role === "booking_total"
    && rightEvidence.role === "booking_total";
  return legacyPair || sameTypedRole;
}

function isFinalReviewFacts(facts = {}) {
  return (facts.provenance || []).some((entry) => entry.source === "payment_summary");
}

function outcomeClass(extra = {}) {
  const meaning = normalizedText(`${extra.outcome || ""} ${extra.disposition || ""} ${extra.label || ""}`, 280);
  if (extra.family === "fare") {
    return normalizedText(canonicalFareBrand(extra.label), 120);
  }
  if (extra.family === "seat") {
    if (/random|automatic|assigned by|without seat selection|skip seat/.test(meaning)) return "random_assignment";
    if (/selected|assigned|included/.test(meaning)) return "assigned";
  }
  if (extra.family === "insurance") {
    if (/no insurance|without insurance|decline|not included|take the risk|none/.test(meaning)) return "none";
    if (/selected|included|covered|paid/.test(meaning)) return "included";
  }
  if (extra.family === "baggage") {
    if (/not included|no checked|without|decline|none/.test(meaning)) return "none";
    if (/included|selected|present|\b\d+\s*x/.test(meaning)) return "included";
  }
  return meaning;
}

function compatibleFareBrands(left = "", right = "") {
  const before = normalizedText(canonicalFareBrand(left), 120);
  const after = normalizedText(canonicalFareBrand(right), 120);
  if (!before || !after) return true;
  return before === after;
}

function materialReviewOutcomes(selections = []) {
  return (selections || []).filter((extra) => {
    if (["fare", "seat", "insurance"].includes(extra.family)) return true;
    return extra.family === "baggage" && outcomeClass(extra) === "included";
  });
}

function outcomeReviewContradictions(expectedSelections = [], reviewSelections = []) {
  const expected = materialReviewOutcomes(expectedSelections);
  const actualByKey = new Map((reviewSelections || []).map((extra) => [extra.outcomeKey, extra]));
  const contradictions = [];
  for (const wanted of expected) {
    const actual = actualByKey.get(wanted.outcomeKey);
    // A final review often omits declined optional products. The durable
    // verified ledger remains authoritative for absence; review rows can
    // contradict an outcome, but their omission cannot erase it.
    if (!actual) continue;
    if (wanted.family === "fare" && compatibleFareBrands(wanted.label, actual.label)) continue;
    const wantedClass = outcomeClass(wanted);
    const actualClass = outcomeClass(actual);
    if (wantedClass && actualClass && wantedClass !== actualClass) {
      contradictions.push(`REVIEW_OUTCOME_CHANGED:${wanted.outcomeKey}`);
    }
  }
  return contradictions;
}

function travelerKey(entry = {}) {
  return text(entry.travelerId, 120) || normalizedText(entry.name, 160);
}

function legacyBaseline(invariants = {}, state = {}) {
  return normalizeFacts({
    itinerary: { completeness: invariants.itineraryFingerprint ? "partial" : "unknown", segments: [] },
    travelers: invariants.travelerIds || state.travelerIds || [],
    currency: invariants.currency || "",
    totalPrice: invariants.priceAmount == null ? null : { amount: invariants.priceAmount, currency: invariants.currency || "" },
    provenance: [{ source: "legacy_invariant_baseline", observationId: "", confidence: 0.2 }]
  }, { state });
}

function mergeSegmentIdentity(existing = {}, observed = {}, index = 0) {
  const evidence = existing.evidence || observed.evidence || null;
  return {
    segmentId: text(existing.segmentId || observed.segmentId || `segment_${index + 1}`, 120),
    origin: text(existing.origin || observed.origin, 80).toUpperCase(),
    destination: text(existing.destination || observed.destination, 80).toUpperCase(),
    departureDate: text(existing.departureDate || observed.departureDate, 40),
    departureTime: text(existing.departureTime || observed.departureTime, 20),
    arrivalTime: text(existing.arrivalTime || observed.arrivalTime, 20),
    flightNumber: text(existing.flightNumber || observed.flightNumber, 30).toUpperCase(),
    ...(evidence ? { evidence } : {})
  };
}

function enrichBaseline(existing = {}, observed = {}) {
  const previousSegments = existing.itinerary?.segments || [];
  const observedSegments = observed.itinerary?.segments || [];
  const segments = previousSegments.length
    ? previousSegments.map((segment, index) => mergeSegmentIdentity(segment, observedSegments[index] || {}, index))
    : observedSegments.map((segment, index) => mergeSegmentIdentity({}, segment, index));
  const completeness = segments.length
    ? segments.every((segment) => segment.origin && segment.destination && segment.departureDate)
      ? "complete"
      : "partial"
    : "unknown";
  const existingBaseAmount = number(existing.basePrice?.amount);
  const existingTotalAmount = baselineTotalAmount(existing);
  const observedTotalAmount = promotableObservedTotal(observed);
  return normalizeFacts({
    itinerary: { completeness, segments },
    travelers: existing.travelers?.length ? existing.travelers : observed.travelers,
    currency: existing.currency || observed.currency,
    basePrice: {
      amount: existingBaseAmount == null ? number(observed.basePrice?.amount) : existingBaseAmount,
      currency: existing.basePrice?.currency || observed.basePrice?.currency || existing.currency || observed.currency
    },
    totalPrice: {
      amount: existingTotalAmount == null ? observedTotalAmount : existingTotalAmount,
      currency: existing.totalPrice?.currency || observed.totalPrice?.currency || existing.currency || observed.currency
    },
    fareBrand: existing.fareBrand || observed.fareBrand,
    selectedExtras: existing.selectedExtras || [],
    factEvidence: {
      itinerary: previousSegments.length && existing.factEvidence?.itinerary?.length
        ? existing.factEvidence.itinerary
        : observed.factEvidence?.itinerary,
      fareBrand: existing.factEvidence?.fareBrand || observed.factEvidence?.fareBrand || null,
      totalPrice: existingTotalAmount == null
        ? observed.factEvidence?.totalPrice || null
        : existing.factEvidence?.totalPrice || observed.factEvidence?.totalPrice || null,
      travelers: existing.factEvidence?.travelers || observed.factEvidence?.travelers || null
    },
    provenance: existing.provenance?.length ? existing.provenance : observed.provenance
  });
}

function mergeCurrentFacts(previous = {}, observed = {}, baseline = {}) {
  const identity = enrichBaseline(previous?.contractVersion ? previous : baseline, observed);
  const previousSegments = identity.itinerary?.segments || [];
  const observedSegments = observed.itinerary?.segments || [];
  const currentSegments = observedSegments.length
    ? observedSegments.map((segment, index) => ({
        ...mergeSegmentIdentity(previousSegments[index] || {}, segment, index),
        // Current evidence must win when it explicitly names transaction
        // identity. Otherwise a changed route would be hidden by the retained
        // prior observation and could incorrectly pass final review.
        origin: text(segment.origin || previousSegments[index]?.origin, 80).toUpperCase(),
        destination: text(segment.destination || previousSegments[index]?.destination, 80).toUpperCase(),
        departureDate: text(segment.departureDate || previousSegments[index]?.departureDate, 40),
        departureTime: text(segment.departureTime || previousSegments[index]?.departureTime, 20),
        arrivalTime: text(segment.arrivalTime || previousSegments[index]?.arrivalTime, 20),
        flightNumber: text(segment.flightNumber || previousSegments[index]?.flightNumber, 30).toUpperCase()
      }))
    : previousSegments;
  const selections = mergeCommerceSelections(previous.selectedExtras, observed.selectedExtras);
  return normalizeFacts({
    ...identity,
    itinerary: { completeness: observedSegments.length ? observed.itinerary?.completeness : identity.itinerary?.completeness, segments: currentSegments },
    travelers: observed.travelers?.length ? observed.travelers : identity.travelers,
    currency: observed.currency || identity.currency,
    basePrice: number(observed.basePrice?.amount) == null ? identity.basePrice : observed.basePrice,
    totalPrice: number(observed.totalPrice?.amount) == null ? identity.totalPrice : observed.totalPrice,
    fareBrand: observed.fareBrand || identity.fareBrand,
    selectedExtras: selections,
    factEvidence: {
      itinerary: observed.factEvidence?.itinerary?.length ? observed.factEvidence.itinerary : identity.factEvidence?.itinerary,
      fareBrand: observed.factEvidence?.fareBrand || identity.factEvidence?.fareBrand || null,
      totalPrice: observed.factEvidence?.totalPrice || identity.factEvidence?.totalPrice || null,
      travelers: observed.factEvidence?.travelers || identity.factEvidence?.travelers || null
    },
    provenance: [...(previous.provenance || []), ...(observed.provenance || [])].slice(-20)
  });
}

function transactionFactGaps(facts = {}) {
  const gaps = [];
  const segments = facts.itinerary?.segments || [];
  if (!segments.length || segments.some((segment) => !segment.origin || !segment.destination)) gaps.push("itinerary_route");
  if (!(facts.travelers || []).length) gaps.push("travelers");
  if (!facts.currency) gaps.push("currency");
  if (baselineTotalAmount(facts) == null) gaps.push("total_price");
  return gaps;
}

function reviewTransactionEnvelope(envelope = {}, state = {}) {
  const baseline = envelope.baseline || normalizeFacts({});
  const current = envelope.current || baseline;
  const reviewFacts = envelope.reviewFacts || null;
  const comparison = reviewFacts || current;
  const missing = transactionFactGaps(baseline);
  if (!reviewFacts) missing.push("payment_review");
  else missing.push(...transactionFactGaps(reviewFacts).map((fact) => `review_${fact}`));
  const contradictions = [];
  const itineraryConflict = explicitItineraryConflict(baseline, comparison);
  if (itineraryConflict) contradictions.push(itineraryConflict.code);
  if (explicitTravelerConflict(baseline.travelers || [], comparison.travelers || [])) contradictions.push("TRAVELER_SET_CHANGED");
  if (baseline.currency && comparison.currency && baseline.currency !== comparison.currency) contradictions.push("CURRENCY_CHANGED");
  const baselineTotal = number(baseline.totalPrice?.amount);
  const currentTotal = number(comparison.totalPrice?.amount);
  if (
    envelope.baselineStatus === "approved"
    && comparableBookingTotals(baseline, comparison)
    && baselineTotal != null
    && currentTotal != null
    && currentTotal > baselineTotal
  ) {
    const maximum = number(state.approvals?.priceAuthorization?.maximumAmount);
    if (!state.approvals?.priceAuthorization?.authorizationId || maximum == null || currentTotal > maximum) {
      contradictions.push("UNAPPROVED_PRICE_CHANGE");
    }
  }
  const authorizedExtraIds = new Set((state.approvals?.paidExtraAuthorizations || [])
    .filter((authorization) => authorization?.authorizationId)
    .map((authorization) => authorization.decisionGroupId));
  const durableSelections = envelope.outcomeLedger || current.selectedExtras || [];
  const unauthorizedExtras = durableSelections.filter((extra) => (
    (number(extra.priceAmount) > 0 || /paid|money/.test(normalizedText(extra.disposition)))
    && !authorizedExtraIds.has(extra.decisionGroupId)
  ));
  if (unauthorizedExtras.length) contradictions.push("UNAPPROVED_SELECTED_EXTRA");
  if (reviewFacts) {
    contradictions.push(...outcomeReviewContradictions(durableSelections, reviewFacts.selectedExtras || []));
    const durableFare = durableSelections.find((extra) => extra.family === "fare");
    if (!durableFare && baseline.fareBrand && reviewFacts.fareBrand
      && !compatibleFareBrands(baseline.fareBrand, reviewFacts.fareBrand)) {
      contradictions.push("FARE_BRAND_CHANGED");
    }
  }
  return Object.freeze({
    ready: envelope.baselineStatus === "approved" && !missing.length && !contradictions.length,
    baselineStatus: envelope.baselineStatus || "collecting",
    missingFacts: Object.freeze(missing),
    contradictions: Object.freeze([...new Set(contradictions)]),
    unauthorizedExtraDecisionGroupIds: Object.freeze(unauthorizedExtras.map((extra) => extra.decisionGroupId)),
    baseline,
    current,
    reviewFacts,
    outcomeLedger: durableSelections
  });
}

function prepareTransactionInvariants(state = {}, observation = {}, traveler = {}, {
  authoritativeTransactionFacts = null
} = {}) {
  const observed = authoritativeTransactionFacts
    ? normalizeFacts(authoritativeTransactionFacts, {
        observationId: observation.observationId || "",
        state,
        traveler
      })
    : factsFromObservation(state, observation, traveler);
  const admittedOutcomes = durableCommerceSelections(observed.selectedExtras);
  const existing = state.transactionInvariants;
  const at = new Date().toISOString();
  const finalReviewObservation = isFinalReviewFacts(observed);
  let envelope;
  if (!existing) {
    const baseline = finalReviewObservation
      ? enrichBaseline(normalizeFacts({}, { state, traveler }), normalizeFacts({}, { state, traveler }))
      : enrichBaseline(normalizeFacts({}, { state, traveler }), observed);
    envelope = {
      version: 4,
      baseline,
      current: mergeCurrentFacts({}, observed, baseline),
      outcomeLedger: finalReviewObservation ? [] : mergeCommerceSelections(admittedOutcomes),
      reviewFacts: finalReviewObservation ? observed : null,
      baselineStatus: transactionFactGaps(baseline).length ? "collecting" : "approved",
      baselineObservationId: observation.observationId || "",
      approvedAt: transactionFactGaps(baseline).length ? "" : at,
      evidence: []
    };
  } else if ((existing.version === 4 || existing.version === 3) && existing.baseline) {
    // Approved identity is immutable, but facts that were genuinely unknown
    // (for example a fare chosen later in checkout) may still be filled from
    // authoritative non-review evidence. Final review can never seed them.
    const baseline = finalReviewObservation
      ? existing.baseline
      : enrichBaseline(existing.baseline, observed);
    const approved = !transactionFactGaps(baseline).length;
    envelope = {
      ...existing,
      version: 4,
      baseline,
      current: mergeCurrentFacts(existing.current || existing.baseline, observed, baseline),
      outcomeLedger: finalReviewObservation
        ? mergeCommerceSelections(existing.outcomeLedger)
        : mergeCommerceSelections(existing.outcomeLedger, admittedOutcomes),
      reviewFacts: finalReviewObservation ? observed : (existing.reviewFacts || null),
      baselineStatus: existing.baselineStatus === "approved" || approved ? "approved" : "collecting",
      approvedAt: existing.approvedAt || (approved ? at : "")
    };
  } else if (existing.version === 2 && existing.baseline) {
    const baseline = enrichBaseline(existing.baseline, observed);
    const approved = !transactionFactGaps(baseline).length;
    envelope = {
      version: 4,
      baseline,
      current: mergeCurrentFacts(existing.baseline, observed, baseline),
      outcomeLedger: finalReviewObservation ? [] : mergeCommerceSelections(admittedOutcomes),
      reviewFacts: finalReviewObservation ? observed : null,
      baselineStatus: approved ? "approved" : "collecting",
      baselineObservationId: existing.baselineObservationId || observation.observationId || "",
      approvedAt: approved ? (existing.approvedAt || at) : "",
      evidence: Array.isArray(existing.evidence) ? existing.evidence : []
    };
  } else {
    const baseline = enrichBaseline(legacyBaseline(existing, state), observed);
    const approved = !transactionFactGaps(baseline).length;
    envelope = {
      version: 4,
      baseline,
      current: mergeCurrentFacts({}, observed, baseline),
      outcomeLedger: finalReviewObservation ? [] : mergeCommerceSelections(admittedOutcomes),
      reviewFacts: finalReviewObservation ? observed : null,
      baselineStatus: approved ? "approved" : "collecting",
      baselineObservationId: existing.baselineObservationId || "",
      approvedAt: approved ? (existing.approvedAt || state.createdAt || at) : "",
      evidence: Array.isArray(existing.evidence) ? existing.evidence : []
    };
  }
  const observationId = text(observation.observationId, 120);
  const evidence = Array.isArray(envelope.evidence) ? envelope.evidence : [];
  const nextEvidence = observationId && !evidence.some((entry) => entry.observationId === observationId)
    ? [...evidence, { observationId, observedAt: at, facts: observed }].slice(-60)
    : evidence;
  const nextEnvelope = {
    ...envelope,
    evidence: nextEvidence,
    review: null
  };
  nextEnvelope.review = reviewTransactionEnvelope(nextEnvelope, state);
  return {
    state: withUpdate(state, { transactionInvariants: nextEnvelope }),
    baseline: nextEnvelope.baseline,
    observed,
    envelope: nextEnvelope,
    review: nextEnvelope.review,
    observation
  };
}

function explicitTravelerConflict(baseline = [], observed = []) {
  const before = baseline.map(travelerKey).filter(Boolean).sort();
  const after = observed.map(travelerKey).filter(Boolean).sort();
  if (!before.length || !after.length) return null;
  return JSON.stringify(before) === JSON.stringify(after) ? null : { before, after };
}

function comparableSegments(baseline = {}, observed = {}) {
  const before = baseline.itinerary?.segments || [];
  const after = observed.itinerary?.segments || [];
  if (!before.length || !after.length) return [];
  const pairs = [];
  const used = new Set();
  before.forEach((segment, index) => {
    let matchIndex = after.findIndex((candidate, candidateIndex) => (
      !used.has(candidateIndex) && segment.flightNumber && candidate.flightNumber && segment.flightNumber === candidate.flightNumber
    ));
    if (matchIndex < 0) {
      matchIndex = after.findIndex((candidate, candidateIndex) => (
        !used.has(candidateIndex) && segment.origin && segment.destination
        && segment.origin === candidate.origin && segment.destination === candidate.destination
      ));
    }
    if (matchIndex < 0
      && baseline.itinerary?.completeness === "complete"
      && observed.itinerary?.completeness === "complete"
      && before.length === after.length) matchIndex = index;
    if (matchIndex >= 0 && after[matchIndex]) {
      used.add(matchIndex);
      pairs.push([segment, after[matchIndex]]);
    }
  });
  return pairs;
}

function explicitItineraryConflict(baseline = {}, observed = {}) {
  for (const [before, after] of comparableSegments(baseline, observed)) {
    if (before.origin && after.origin && before.origin !== after.origin) return { code: "ITINERARY_ROUTE_CHANGED", field: "origin", before: before.origin, after: after.origin };
    if (before.destination && after.destination && before.destination !== after.destination) return { code: "ITINERARY_ROUTE_CHANGED", field: "destination", before: before.destination, after: after.destination };
    if (before.departureDate && after.departureDate && normalizedText(before.departureDate) !== normalizedText(after.departureDate)) return { code: "ITINERARY_DATE_CHANGED", field: "departureDate", before: before.departureDate, after: after.departureDate };
    if (before.flightNumber && after.flightNumber && before.flightNumber !== after.flightNumber) return { code: "FLIGHT_NUMBER_CHANGED", field: "flightNumber", before: before.flightNumber, after: after.flightNumber };
    for (const field of ["departureTime", "arrivalTime"]) {
      if (before[field] && after[field] && before[field] !== after[field]) return { code: "ITINERARY_TIME_CHANGED", field, before: before[field], after: after[field] };
    }
  }
  return null;
}

function observedPaidExtraForDecision(observed = {}, decisionGroupId = "") {
  return (observed.selectedExtras || []).find((extra) => {
    if (!decisionGroupId || extra.decisionGroupId !== decisionGroupId) return false;
    const disposition = normalizedText(extra.disposition);
    return number(extra.priceAmount) > 0
      || (/paid|money/.test(disposition) && !/decline|free|remove|skip|without|none/.test(disposition));
  }) || null;
}

function exactPolicyCorrectionStep(action = {}, state = {}, observed = {}) {
  const decisionGroupId = action.decisionGroupId
    || action.targetSnapshot?.decisionGroupId
    || action.expectedOutcome?.decisionGroupId
    || action.affordance?.task?.decisionGroupId
    || "";
  const targetControlId = action.controlId || action.targetSnapshot?.controlId || "";
  const effect = action.mechanicalEffect
    || action.affordance?.mechanicalEffect
    || action.affordance?.physicalEffect
    || action.affordance?.effect
    || "";
  const currentGoal = currentObligation(state.taskState || {}) || {};
  const obligation = state.taskState?.currentObligation || {};
  const obligationOwnsCorrection = Boolean(
    obligation.subject?.decisionGroupId === decisionGroupId
    && obligation.policyDecision?.status === "admitted"
    && agentContract.canonicalSemanticEffect(obligation.desiredEffect)
      === agentContract.SEMANTIC_EFFECT.SELECT_FREE_OPTION
  );
  const paidSelection = observedPaidExtraForDecision(observed, decisionGroupId);
  const exactGoal = Boolean(
    obligationField(currentGoal, "decisionGroupId")
    && obligationField(currentGoal, "decisionGroupId") === decisionGroupId
  );
  const exactTarget = Boolean(
    decisionGroupId
    && targetControlId
    && action.targetSnapshot?.controlId === targetControlId
    && (
      action.targetSnapshot?.decisionGroupId === decisionGroupId
      || (
        action.targetSnapshot?.policyCorrectionForDecisionGroupId === decisionGroupId
        && action.targetSnapshot?.semanticOwnershipLinkId
      )
    )
  );
  const expected = action.expectedOutcome || {};
  const safeMeaning = normalizedText(`${action.intent || ""} ${action.targetSnapshot?.semantic || ""} ${action.targetSnapshot?.risk || ""}`);
  const exactFreeReversal = effect === "select_free_option"
    && expected.type === "exact_free_option_selected"
    && expected.decisionGroupId === decisionGroupId
    && (expected.expectedSelectedControlId || expected.controlId) === targetControlId
    && expected.prohibitPaidAlternative !== false
    && /decline|free|remove|skip|without|none|safe/.test(safeMeaning);
  const exactSelectorOpen = effect === "open_surface"
    && expected.type === "options_surface_appeared"
    && expected.decisionGroupId === decisionGroupId
    && /open choice|open selector|open dropdown/.test(safeMeaning);
  const linkedOutcomeMatchesObservedMechanics = expected.intendedOutcome === "open_correction_surface"
    ? expected.type === "options_surface_appeared"
      && !["advance_checkout_stage", "submit_purchase", "enter_payment_credentials", "accept_legal_terms"].includes(effect)
    : expected.type === "policy_conflict_resolved"
      && !["advance_surface", "advance_checkout_stage", "submit_purchase", "enter_payment_credentials", "accept_legal_terms"].includes(effect);
  const linkedSemanticCorrection = Boolean(
    action.semanticOwnershipLinkId
    && action.policyCorrectionForDecisionGroupId === decisionGroupId
    && linkedOutcomeMatchesObservedMechanics
    && expected.semanticOwnershipLinkId === action.semanticOwnershipLinkId
    && expected.decisionGroupId === decisionGroupId
    && expected.controlId === targetControlId
    && expected.intendedOutcome
    && expected.intendedOutcome !== "unknown"
  );
  return Boolean(obligationOwnsCorrection && paidSelection && exactGoal && exactTarget && (exactFreeReversal || exactSelectorOpen || linkedSemanticCorrection));
}

function groundedSafeReversalForExtra(extra = {}, observation = {}) {
  const page = observation.page || {};
  const decisionGroupId = text(extra.decisionGroupId, 140);
  const group = (page.decisionGroups || []).find((item) => text(item.decisionGroupId, 140) === decisionGroupId);
  if (!group) return null;
  const semanticLink = (page.semanticOwnershipLinks || []).find((link) => (
    link.status === "resolved"
    && link.sourceDecisionGroupId === decisionGroupId
    && link.intendedOutcome
    && link.intendedOutcome !== "unknown"
  )) || null;
  const ids = new Set([
    group.removalControlId,
    ...(group.alternativeControlIds || []),
    ...(group.semanticCorrectionControlIds || []),
    semanticLink?.correctionControlId,
    ...(group.alternatives || []).map((alternative) => alternative.controlId)
  ].map((id) => text(id, 140)).filter(Boolean));
  const control = (page.controls || []).find((item) => {
    if (!ids.has(text(item.controlId, 140))) return false;
    if (!controlBelongsToCurrentSurface(item, page)) return false;
    const meaning = normalizedText(`${item.semantic || ""} ${item.physicalEffect || ""} ${item.risk || ""}`);
    const exactLinkedHypothesis = semanticLink?.correctionControlId === text(item.controlId, 140);
    if (!exactLinkedHypothesis && !/remove|decline|free|skip|without|none|deselect|clear|safe decline|select free/.test(meaning)) return false;
    if (/advance checkout stage|payment|purchase|legal|select paid|add paid/.test(meaning)) return false;
    return Object.values(item.operations || {}).some((operation) => (
      operation?.actionability?.executable === true || operation?.actionability?.revealable === true
    ));
  });
  return control ? {
    decisionGroupId,
    controlId: text(control.controlId, 140),
    effect: text(control.physicalEffect || "unknown", 80),
    ...(semanticLink?.intendedOutcome ? { intendedOutcome: semanticLink.intendedOutcome } : {}),
    ...(semanticLink?.linkId ? { semanticOwnershipLinkId: semanticLink.linkId } : {})
  } : null;
}

function invariantDecision(prepared = {}, action = {}, state = prepared.state || {}) {
  const baseline = prepared.baseline || normalizeFacts({});
  const observed = prepared.observed || normalizeFacts({});
  const checks = [];
  const deny = (code, reason, details = {}, decision = "blocked_by_safety") => ({ allow: false, decision, code, reason, details, checks: [...checks, { code, ok: false }] });
  const pass = (code, detail = "") => checks.push({ code, ok: true, detail });

  const travelerConflict = explicitTravelerConflict(baseline.travelers, observed.travelers);
  if (travelerConflict) return deny("TRAVELER_SET_CHANGED", "Explicit traveler evidence conflicts with the immutable approved transaction baseline.", travelerConflict);
  pass("TRAVELER_SET_STABLE", observed.travelers.length ? "matching evidence" : "current evidence absent");

  const itineraryConflict = explicitItineraryConflict(baseline, observed);
  if (itineraryConflict) return deny(itineraryConflict.code, `Explicit ${itineraryConflict.field} evidence conflicts with the immutable approved itinerary.`, itineraryConflict);
  pass("ITINERARY_STABLE", `${baseline.itinerary.completeness} baseline / ${observed.itinerary.completeness} current; absence and partial evidence are non-conflicting`);

  if (baseline.currency && observed.currency && baseline.currency !== observed.currency) {
    return deny("CURRENCY_CHANGED", `Currency changed from ${baseline.currency} to ${observed.currency}.`, { before: baseline.currency, after: observed.currency });
  }
  pass("CURRENCY_STABLE", baseline.currency && observed.currency ? observed.currency : "current evidence absent or baseline unknown");

  const actionEffect = action.mechanicalEffect
    || action.affordance?.mechanicalEffect
    || action.affordance?.physicalEffect
    || action.affordance?.effect
    || "";
  const actionMeaning = normalizedText(`${action.intent || ""} ${action.risk || ""} ${action.targetSnapshot?.semantic || ""}`);
  const exactCostReducingCorrection = exactPolicyCorrectionStep(action, state, observed);
  // A grounded observation-scoped correction may still have an unknown
  // browser semantic. Its safety comes from the exact conflict/control link
  // and fresh postcondition, not from rewriting the observed effect.
  const correctsPaidSelection = exactCostReducingCorrection;
  const actionAddsCost = actionEffect === "select_paid_option"
    || action.risk === "money"
    || action.targetSnapshot?.risk === "money"
    || number(action.affordance?.structuredPrice?.amount) > 0;
  const finalTransactionBoundary = actionEffect === "submit_purchase"
    || action.risk === "payment"
    || action.targetSnapshot?.risk === "payment"
    || /submit payment|submit purchase|confirm purchase|finalize booking|book now/.test(actionMeaning);

  const beforePrice = number(baseline.totalPrice?.amount);
  const currentPrice = number(observed.totalPrice?.amount);
  const baselineApproved = prepared.envelope
    ? prepared.envelope.baselineStatus === "approved"
    : transactionFactGaps(baseline).length === 0;
  if (
    baselineApproved
    && comparableBookingTotals(baseline, observed)
    && beforePrice != null
    && currentPrice != null
    && currentPrice > beforePrice
  ) {
    if (exactCostReducingCorrection) {
      pass("ELEVATED_PRICE_EXACT_CORRECTION", `${beforePrice} -> ${currentPrice}`);
    } else if (actionAddsCost || finalTransactionBoundary) {
      const authorization = state.approvals?.priceAuthorization;
      const maximum = number(authorization?.maximumAmount);
      if (!authorization?.authorizationId || maximum == null || currentPrice > maximum) {
        return deny("UNAPPROVED_PRICE_CHANGE", `A cost-adding or final transaction action requires price authorization for the current total (${beforePrice} -> ${currentPrice}).`, { before: beforePrice, after: currentPrice });
      }
    } else {
      pass("PRICE_CHANGE_REQUIRES_RECONCILIATION_NOT_APPROVAL", `${beforePrice} -> ${currentPrice}`);
    }
  }
  pass("PRICE_OBSERVED_OR_BOUNDARY_AUTHORIZED");
  const advancesCheckout = !correctsPaidSelection && (
    ["advance_surface", "advance_checkout_stage"].includes(actionEffect)
    || action.intent === "navigate_stage"
  );
  if (advancesCheckout) {
    const paidSelections = (observed.selectedExtras || []).filter((extra) => (
      number(extra.priceAmount) > 0
      || (
        /paid|money/.test(normalizedText(extra.disposition))
        && !/decline|free|remove|skip|without|none/.test(normalizedText(extra.disposition))
      )
    ));
    const authorizations = Array.isArray(state.approvals?.paidExtraAuthorizations)
      ? state.approvals.paidExtraAuthorizations
      : [];
    const unapproved = paidSelections.filter((extra) => !authorizations.some((authorization) => (
      authorization?.authorizationId
      && authorization.decisionGroupId
      && authorization.decisionGroupId === extra.decisionGroupId
    )));
    if (unapproved.length) {
      const groundedReversal = unapproved
        .map((extra) => groundedSafeReversalForExtra(extra, prepared.observation || {}))
        .find(Boolean);
      if (groundedReversal) {
        return deny(
          "UNAPPROVED_SELECTED_EXTRA",
          "An unrequested paid option has an exact safe reversal. Reconcile it before continuing.",
          {
            decisionGroupIds: unapproved.map((extra) => extra.decisionGroupId),
            selectedExtras: unapproved,
            groundedReversal,
            recoveryDirective: "reconcile_selected_extra"
          },
          "recoverable"
        );
      }
      return deny(
        "UNAPPROVED_SELECTED_EXTRA",
        "The current checkout contains a paid optional item without an explicit item authorization.",
        { decisionGroupIds: unapproved.map((extra) => extra.decisionGroupId), selectedExtras: unapproved }
      );
    }
  }
  pass("SELECTED_EXTRAS_EXPLICITLY_AUTHORIZED");

  const paymentLike = action.risk === "payment" || action.type === "final_review" || /payment|purchase|book_now/.test(`${action.intent || ""} ${action.targetSnapshot?.semantic || ""}`);
  if (paymentLike) {
    const authorization = state.approvals?.paymentAuthorization;
    if (!authorization?.authorizationId || authorization.transactionId !== state.id || authorization.singleUse !== true) {
      return deny("PAYMENT_AUTHORIZATION_MISSING", "Payment requires a one-time authorization bound to this exact transaction.");
    }
    if (state.paymentState?.attempts > 0 || state.paymentState?.status === "submitted") {
      return deny("DUPLICATE_PAYMENT_ATTEMPT", "A payment attempt has already been recorded for this transaction.");
    }
  }
  pass("PAYMENT_GUARD");
  return { allow: true, decision: "allowed", code: "INVARIANTS_STABLE", reason: "No explicit transaction fact contradiction was observed.", checks };
}

module.exports = {
  explicitItineraryConflict,
  invariantDecision,
  prepareTransactionInvariants,
  reviewTransactionEnvelope,
  transactionFactGaps
};
