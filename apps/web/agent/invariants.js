const { withUpdate } = require("../../../packages/shared/agent-state");
const { factsFromObservation, normalizeFacts } = require("./transaction-facts");

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

function prepareTransactionInvariants(state = {}, observation = {}, traveler = {}) {
  const observed = factsFromObservation(state, observation, traveler);
  const existing = state.transactionInvariants;
  const at = new Date().toISOString();
  let envelope;
  if (!existing) {
    envelope = {
      version: 2,
      baseline: observed,
      baselineObservationId: observation.observationId || "",
      approvedAt: at,
      evidence: []
    };
  } else if (existing.version === 2 && existing.baseline) {
    envelope = { ...existing, baseline: existing.baseline };
  } else {
    envelope = {
      version: 2,
      baseline: legacyBaseline(existing, state),
      baselineObservationId: existing.baselineObservationId || "",
      approvedAt: existing.approvedAt || state.createdAt || at,
      evidence: Array.isArray(existing.evidence) ? existing.evidence : []
    };
  }
  const observationId = text(observation.observationId, 120);
  const evidence = Array.isArray(envelope.evidence) ? envelope.evidence : [];
  const nextEvidence = observationId && !evidence.some((entry) => entry.observationId === observationId)
    ? [...evidence, { observationId, observedAt: at, facts: observed }].slice(-60)
    : evidence;
  const nextEnvelope = nextEvidence === evidence ? envelope : { ...envelope, evidence: nextEvidence };
  return {
    state: nextEnvelope === existing ? state : withUpdate(state, { transactionInvariants: nextEnvelope }),
    baseline: nextEnvelope.baseline,
    observed,
    envelope: nextEnvelope
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

function invariantDecision(prepared = {}, action = {}, state = prepared.state || {}) {
  const baseline = prepared.baseline || normalizeFacts({});
  const observed = prepared.observed || normalizeFacts({});
  const checks = [];
  const deny = (code, reason, details = {}) => ({ allow: false, decision: "blocked_by_safety", code, reason, details, checks: [...checks, { code, ok: false }] });
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

  const beforePrice = number(baseline.totalPrice?.amount);
  const currentPrice = number(observed.totalPrice?.amount);
  if (beforePrice != null && currentPrice != null && currentPrice > beforePrice) {
    const authorization = state.approvals?.priceAuthorization;
    const maximum = number(authorization?.maximumAmount);
    if (!authorization?.authorizationId || maximum == null || currentPrice > maximum) {
      return deny("UNAPPROVED_PRICE_CHANGE", `Price increased from ${beforePrice} to ${currentPrice} without a bound price authorization.`, { before: beforePrice, after: currentPrice });
    }
  }
  pass("PRICE_WITHIN_AUTHORIZATION");

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

module.exports = { explicitItineraryConflict, invariantDecision, prepareTransactionInvariants };
