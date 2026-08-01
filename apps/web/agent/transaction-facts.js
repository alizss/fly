const { buildCanonicalDecisions } = require("./canonical-decision");

const TRANSACTION_CONTRACT_VERSION = "transaction-facts/v1";
const COMMERCE_FAMILIES = new Set(["fare", "baggage", "seat", "insurance", "extras"]);

function text(value, limit = 180) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function normalizedText(value, limit = 180) {
  return text(value, limit).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function number(value) {
  if (value == null || value === "") return null;
  if (typeof value === "object") return null;
  const parsed = Number(String(value).replace(",", ".").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function semanticToken(value, limit = 120) {
  return normalizedText(value, limit).replace(/\s+/g, "_");
}

function canonicalSubjectKey(extra = {}) {
  const family = text(extra.family || extra.subjectFamily, 40).toLowerCase();
  const explicit = semanticToken(extra.subjectKey || extra.subject, 120);
  if (family === "fare") return "ticket";
  if (family === "seat") return explicit && /segment|leg|passenger/.test(explicit) ? explicit : "seat_assignment";
  if (family === "insurance") return "trip_insurance";
  if (family === "baggage") {
    if (/checked|hold/.test(normalizedText(`${explicit} ${extra.label || ""}`))) return "checked_baggage";
    if (/cabin|carry on|hand bag/.test(normalizedText(`${explicit} ${extra.label || ""}`))) return "cabin_baggage";
    if (/personal item/.test(normalizedText(`${explicit} ${extra.label || ""}`))) return "personal_item";
    return explicit || "baggage";
  }
  return explicit || semanticToken(extra.label, 100) || "selection";
}

function canonicalOutcomeKey(extra = {}) {
  const family = text(extra.family || extra.subjectFamily, 40).toLowerCase();
  if (!COMMERCE_FAMILIES.has(family)) return "";
  return `${family}:${canonicalSubjectKey(extra)}`;
}

function normalizeCompleteness(value, segments = []) {
  if (["complete", "partial", "unknown"].includes(value)) return value;
  if (!segments.length) return "unknown";
  return segments.every((segment) => segment.origin && segment.destination && segment.departureDate)
    ? "complete"
    : "partial";
}

const RESERVED_ROUTE_ENDPOINTS = new Set([
  "trip", "summary", "primary", "passenger", "checked", "baggage",
  "travel", "insurance", "direct", "flight", "booking", "payment",
  "overview", "contact", "details", "ticket", "fare", "seat", "seating"
]);

function normalizedRouteEndpoint(value = "") {
  const endpoint = text(value, 80).toUpperCase();
  const tokens = normalizedText(endpoint, 80).split(/\s+/).filter(Boolean);
  if (!endpoint || !tokens.length) return "";
  if (tokens.every((token) => RESERVED_ROUTE_ENDPOINTS.has(token))) return "";
  return endpoint;
}

function normalizeSegment(segment = {}, index = 0) {
  const origin = normalizedRouteEndpoint(segment.origin);
  const destination = normalizedRouteEndpoint(segment.destination);
  return {
    segmentId: text(segment.segmentId || `segment_${index + 1}`, 120),
    origin,
    destination,
    departureDate: text(segment.departureDate, 40),
    departureTime: text(segment.departureTime, 20),
    arrivalTime: text(segment.arrivalTime, 20),
    flightNumber: text(segment.flightNumber, 30).toUpperCase()
  };
}

function normalizeExtra(extra = {}, currency = "") {
  const family = text(extra.family || extra.subjectFamily, 40).toLowerCase();
  if (!COMMERCE_FAMILIES.has(family)) return null;
  const subjectKey = canonicalSubjectKey({ ...extra, family });
  return {
    decisionGroupId: text(extra.decisionGroupId, 140),
    outcomeKey: text(extra.outcomeKey || `${family}:${subjectKey}`, 180),
    family,
    subjectKey,
    label: text(extra.label || extra.selectedLabel, 180),
    disposition: text(extra.disposition || extra.semantic, 80),
    outcome: text(extra.outcome || extra.semanticOutcome || extra.disposition || extra.semantic, 80),
    priceAmount: number(extra.priceAmount),
    currency: text(extra.currency || currency, 20).toUpperCase()
  };
}

function mergeCommerceSelections(...collections) {
  const merged = new Map();
  for (const collection of collections) {
    for (const raw of Array.isArray(collection) ? collection : []) {
      const extra = normalizeExtra(raw, raw?.currency || "");
      if (!extra) continue;
      const key = extra.outcomeKey || canonicalOutcomeKey(extra);
      if (!key) continue;
      const previous = merged.get(key) || {};
      merged.set(key, {
        ...previous,
        ...extra,
        decisionGroupId: extra.decisionGroupId || previous.decisionGroupId || "",
        label: extra.label || previous.label || "",
        disposition: extra.disposition || previous.disposition || "",
        outcome: extra.outcome || previous.outcome || "",
        priceAmount: extra.priceAmount == null ? (previous.priceAmount ?? null) : extra.priceAmount,
        currency: extra.currency || previous.currency || ""
      });
    }
  }
  return [...merged.values()].slice(0, 40);
}

function commerceSelectionsFromPage(page = {}, state = {}, traveler = {}) {
  const decisions = buildCanonicalDecisions({
    page,
    userPolicy: state.userPolicy || {},
    traveler
  });
  return decisions
    .filter((decision) => (
      COMMERCE_FAMILIES.has(String(decision.family || decision.subject?.family || "").toLowerCase())
      && decision.currentState?.selected === true
      && decision.currentState?.selectedLabel
    ))
    .map((decision) => normalizeExtra({
      decisionGroupId: decision.decisionGroupId || decision.decisionId,
      family: decision.family || decision.subject?.family,
      subjectKey: decision.subject?.key,
      label: decision.currentState.selectedLabel,
      disposition: decision.priceRisk?.selectedPaid ? "paid" : decision.currentOutcome || decision.status,
      outcome: decision.currentOutcome || decision.status,
      priceAmount: decision.priceRisk?.amount,
      currency: decision.priceRisk?.currency
    }))
    .filter(Boolean)
    .slice(0, 40);
}

function normalizeTraveler(entry = {}) {
  if (typeof entry === "string") return { travelerId: text(entry, 120), name: "" };
  return {
    travelerId: text(entry.travelerId || entry.id, 120),
    name: text(entry.name || [entry.firstName, entry.lastName].filter(Boolean).join(" "), 160)
  };
}

function travelerKey(entry = {}) {
  return text(entry.travelerId, 120) || normalizedText(entry.name, 160);
}

function normalizeFacts(raw = {}, { observationId = "", state = {}, traveler = {} } = {}) {
  const rawSegments = Array.isArray(raw.itinerary?.segments) ? raw.itinerary.segments : [];
  const segments = rawSegments.map(normalizeSegment);
  const stateTravelers = Array.isArray(state.travelerIds) ? state.travelerIds.filter(Boolean) : [];
  const observedTravelers = Array.isArray(raw.travelers) ? raw.travelers.map(normalizeTraveler).filter(travelerKey) : [];
  const authoritativeTravelers = observedTravelers.length
    ? observedTravelers
    : stateTravelers.length
      ? stateTravelers.map((travelerId) => normalizeTraveler({ travelerId }))
      : [normalizeTraveler({ travelerId: traveler.id || state.travelerId, name: traveler.name })].filter(travelerKey);
  const pagePrice = raw.totalPrice && typeof raw.totalPrice === "object" ? raw.totalPrice : {};
  const basePrice = raw.basePrice && typeof raw.basePrice === "object" ? raw.basePrice : {};
  const currency = text(raw.currency || pagePrice.currency || basePrice.currency, 20).toUpperCase();
  const provenance = (Array.isArray(raw.provenance) ? raw.provenance : []).map((entry) => ({
    source: text(entry.source || "unknown", 80),
    observationId: text(entry.observationId || observationId, 120),
    confidence: Math.max(0, Math.min(1, Number(entry.confidence) || 0))
  })).slice(0, 20);
  return {
    contractVersion: TRANSACTION_CONTRACT_VERSION,
    itinerary: {
      completeness: normalizeCompleteness(raw.itinerary?.completeness, segments),
      segments
    },
    travelers: authoritativeTravelers,
    currency,
    basePrice: { amount: number(basePrice.amount ?? raw.basePrice), currency: text(basePrice.currency || currency, 20).toUpperCase() },
    totalPrice: { amount: number(pagePrice.amount ?? raw.totalPrice), currency: text(pagePrice.currency || currency, 20).toUpperCase() },
    fareBrand: text(raw.fareBrand, 120),
    selectedExtras: mergeCommerceSelections((Array.isArray(raw.selectedExtras) ? raw.selectedExtras : []).map((extra) => ({
      ...extra,
      currency: extra.currency || currency
    }))),
    provenance: provenance.length ? provenance : [{ source: "unknown", observationId: text(observationId, 120), confidence: 0 }]
  };
}

function factsFromObservation(state = {}, observation = {}, traveler = {}) {
  const page = observation.page || {};
  const raw = page.transactionFacts && typeof page.transactionFacts === "object"
    ? page.transactionFacts
    : {
        itinerary: { completeness: "unknown", segments: [] },
        travelers: [],
        currency: page.price?.currency || "",
        totalPrice: page.price || null,
        provenance: [{ source: "legacy_page_summary", observationId: observation.observationId || "", confidence: 0.3 }]
      };
  const normalized = normalizeFacts(raw, { observationId: observation.observationId || "", state, traveler });
  const compiledSelections = commerceSelectionsFromPage(page, state, traveler);
  return {
    ...normalized,
    // Current controls may enrich the observation, but they must never erase
    // review rows or previously compiled outcomes from the same page map.
    selectedExtras: mergeCommerceSelections(normalized.selectedExtras, compiledSelections)
  };
}

module.exports = {
  COMMERCE_FAMILIES,
  TRANSACTION_CONTRACT_VERSION,
  canonicalOutcomeKey,
  canonicalSubjectKey,
  commerceSelectionsFromPage,
  factsFromObservation,
  mergeCommerceSelections,
  normalizeFacts
};
