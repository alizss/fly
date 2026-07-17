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

function normalizeCompleteness(value, segments = []) {
  if (["complete", "partial", "unknown"].includes(value)) return value;
  if (!segments.length) return "unknown";
  return segments.every((segment) => segment.origin && segment.destination && segment.departureDate)
    ? "complete"
    : "partial";
}

function normalizeSegment(segment = {}, index = 0) {
  return {
    segmentId: text(segment.segmentId || `segment_${index + 1}`, 120),
    origin: text(segment.origin, 12).toUpperCase(),
    destination: text(segment.destination, 12).toUpperCase(),
    departureDate: text(segment.departureDate, 40),
    departureTime: text(segment.departureTime, 20),
    arrivalTime: text(segment.arrivalTime, 20),
    flightNumber: text(segment.flightNumber, 30).toUpperCase()
  };
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
    itinerary: {
      completeness: normalizeCompleteness(raw.itinerary?.completeness, segments),
      segments
    },
    travelers: authoritativeTravelers,
    currency,
    basePrice: { amount: number(basePrice.amount ?? raw.basePrice), currency: text(basePrice.currency || currency, 20).toUpperCase() },
    totalPrice: { amount: number(pagePrice.amount ?? raw.totalPrice), currency: text(pagePrice.currency || currency, 20).toUpperCase() },
    fareBrand: text(raw.fareBrand, 120),
    selectedExtras: (Array.isArray(raw.selectedExtras) ? raw.selectedExtras : []).map((extra) => ({
      decisionGroupId: text(extra.decisionGroupId, 140),
      label: text(extra.label || extra.selectedLabel, 180),
      disposition: text(extra.disposition || extra.semantic, 80),
      priceAmount: number(extra.priceAmount),
      currency: text(extra.currency || currency, 20).toUpperCase()
    })).slice(0, 40),
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
  return normalizeFacts(raw, { observationId: observation.observationId || "", state, traveler });
}

module.exports = {
  factsFromObservation,
  normalizeFacts
};
