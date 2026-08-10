export const SELECTED_BOOKING_MAX_AGE_MS = 6 * 60 * 60 * 1000;

function authoritativeSelectedBookingItinerary(facts = null) {
  if (!facts || facts.evidenceMode !== "typed") return null;
  const segments = Array.isArray(facts.itinerary?.segments) ? facts.itinerary.segments : [];
  const evidence = Array.isArray(facts.factEvidence?.itinerary) ? facts.factEvidence.itinerary : [];
  if (facts.itinerary?.completeness !== "complete" || !segments.length) return null;
  const complete = segments.every((segment) => {
    const proof = segment.evidence || evidence.find((entry) => entry?.segmentId === segment.segmentId) || null;
    return Boolean(
      String(segment.origin || "").trim()
      && String(segment.destination || "").trim()
      && String(segment.departureDate || "").trim()
      && proof?.authoritative === true
      && String(proof.ownerKey || "").trim()
    );
  });
  return complete ? facts : null;
}

export function authoritativeSelectedBookingFacts(facts = null) {
  const itineraryFacts = authoritativeSelectedBookingItinerary(facts);
  if (!itineraryFacts) return null;
  const totalAmount = Number(facts.totalPrice?.amount);
  const totalCurrency = String(facts.totalPrice?.currency || facts.currency || "").trim().toUpperCase();
  const totalEvidence = facts.factEvidence?.totalPrice || null;
  const authoritativeTotal = Number.isFinite(totalAmount)
    && totalAmount >= 0
    && Boolean(totalCurrency)
    && totalEvidence?.authoritative === true
    && totalEvidence?.role === "booking_total"
    && Boolean(String(totalEvidence.ownerKey || "").trim());
  return authoritativeTotal ? itineraryFacts : null;
}

export function approvedSelectedBookingAcquisitionFromMap(map = null, {
  approvalSource = "",
  now = Date.now(),
  observationHash = "",
  sourceUrl = globalThis.location?.href || ""
} = {}) {
  // The page observer may find a coherent itinerary before it can prove that a
  // framework-specific price owner is a booking-total owner. The user's Start
  // action is the one explicit authority allowed to promote that currently
  // displayed page total into the immutable checkout baseline.
  if (approvalSource !== "explicit_agent_start") return null;
  const facts = authoritativeSelectedBookingItinerary(map?.transactionFacts);
  const amount = Number(map?.price?.amount);
  const currency = String(map?.price?.currency || "").trim().toUpperCase();
  if (!facts || !Number.isFinite(amount) || amount < 0 || !currency) return null;
  const ownerKey = `agent_start:${String(observationHash || `${amount}:${currency}:${now}`)}`;
  const approvedFacts = {
    ...facts,
    currency,
    totalPrice: { amount, currency },
    factEvidence: {
      ...(facts.factEvidence || {}),
      totalPrice: {
        source: "user_approved_visible_checkout_total",
        ownerKey,
        role: "booking_total",
        ownerType: "selected_booking_summary",
        qualification: "explicit_agent_start",
        observationId: String(observationHash || ""),
        confidence: 1,
        authoritative: true
      }
    },
    provenance: [
      ...(Array.isArray(facts.provenance) ? facts.provenance : []),
      {
        source: "explicit_agent_start",
        observationId: String(observationHash || ""),
        confidence: 1
      }
    ]
  };
  return {
    contractVersion: "selected-booking-acquisition/v1",
    capturedAt: new Date(now).toISOString(),
    sourceOrigin: globalThis.location?.origin || "",
    sourceUrl: String(sourceUrl || ""),
    observationId: `booking_start_${String(observationHash || now.toString(36))}`,
    approvalSource,
    facts: approvedFacts
  };
}

export function composeSelectedBookingContract(acquisition = null, selectedTraveler = null, environment = {}) {
  const facts = authoritativeSelectedBookingFacts(acquisition?.facts);
  const travelerId = String(selectedTraveler?.id || "").trim();
  if (!facts || !travelerId) return null;
  const now = typeof environment.now === "function" ? environment.now() : Date.now();
  const sourceUrl = environment.sourceUrl ?? globalThis.location?.href ?? "";
  return {
    contractVersion: "selected-booking/v1",
    selectionId: String(acquisition.observationId || `selected_booking_${now.toString(36)}`),
    selectedAt: String(acquisition.capturedAt || new Date(now).toISOString()),
    sourceUrl: String(acquisition.sourceUrl || sourceUrl),
    itinerary: {
      segments: facts.itinerary.segments.map((segment) => ({
        segmentId: segment.segmentId || "",
        origin: segment.origin || "",
        destination: segment.destination || "",
        departureDate: segment.departureDate || "",
        departureTime: segment.departureTime || "",
        arrivalDate: segment.arrivalDate || "",
        arrivalTime: segment.arrivalTime || "",
        carrier: segment.carrier || "",
        flightNumber: segment.flightNumber || ""
      }))
    },
    approvedTotal: {
      amount: Number(facts.totalPrice.amount),
      currency: String(facts.totalPrice.currency || facts.currency || "").trim().toUpperCase()
    },
    fareBrand: String(facts.fareBrand || ""),
    travelerIds: [travelerId]
  };
}

export function validStoredSelectedBookingContract(
  raw = null,
  selectedTraveler = null,
  now = Date.now(),
  maxAgeMs = SELECTED_BOOKING_MAX_AGE_MS
) {
  if (!raw || raw.contractVersion !== "selected-booking/v1") return null;
  const selectedAt = Date.parse(String(raw.selectedAt || ""));
  const travelerId = String(selectedTraveler?.id || "").trim();
  const travelerIds = Array.isArray(raw.travelerIds)
    ? raw.travelerIds.map((value) => String(value || "").trim()).filter(Boolean)
    : [];
  const segments = Array.isArray(raw.itinerary?.segments) ? raw.itinerary.segments : [];
  const amount = Number(raw.approvedTotal?.amount);
  const currency = String(raw.approvedTotal?.currency || "").trim().toUpperCase();
  const fresh = Number.isFinite(selectedAt)
    && selectedAt <= now + 60_000
    && now - selectedAt <= maxAgeMs;
  const completeItinerary = segments.length > 0 && segments.every((segment) => (
    String(segment?.origin || "").trim()
    && String(segment?.destination || "").trim()
    && String(segment?.departureDate || "").trim()
  ));
  if (
    !String(raw.selectionId || "").trim()
    || !fresh
    || !completeItinerary
    || !Number.isFinite(amount)
    || amount < 0
    || !currency
    || !travelerId
    || !travelerIds.includes(travelerId)
  ) return null;
  return raw;
}
