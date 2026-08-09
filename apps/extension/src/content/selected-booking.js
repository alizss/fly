export const SELECTED_BOOKING_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export function authoritativeSelectedBookingFacts(facts = null) {
  if (!facts || facts.evidenceMode !== "typed") return null;
  const segments = Array.isArray(facts.itinerary?.segments) ? facts.itinerary.segments : [];
  const evidence = Array.isArray(facts.factEvidence?.itinerary) ? facts.factEvidence.itinerary : [];
  const totalAmount = Number(facts.totalPrice?.amount);
  const totalCurrency = String(facts.totalPrice?.currency || facts.currency || "").trim().toUpperCase();
  const totalEvidence = facts.factEvidence?.totalPrice || null;
  const authoritativeTotal = Number.isFinite(totalAmount)
    && totalAmount >= 0
    && Boolean(totalCurrency)
    && totalEvidence?.authoritative === true
    && totalEvidence?.role === "booking_total"
    && Boolean(String(totalEvidence.ownerKey || "").trim());
  if (facts.itinerary?.completeness !== "complete" || !segments.length || !authoritativeTotal) return null;
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
