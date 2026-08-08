const CONTRACT_VERSION = "selected-booking/v1";

function text(value = "", limit = 240) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function number(value) {
  if (value === null || value === undefined || value === "" || typeof value === "object") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeSelectedBooking(raw = null) {
  if (!raw || typeof raw !== "object") return null;
  const itinerary = raw.itinerary || {};
  const segments = (Array.isArray(itinerary.segments) ? itinerary.segments : []).map((segment, index) => ({
    segmentId: text(segment.segmentId || `segment_${index + 1}`, 120),
    origin: text(segment.origin, 20).toUpperCase(),
    destination: text(segment.destination, 20).toUpperCase(),
    departureDate: text(segment.departureDate, 20),
    departureTime: text(segment.departureTime, 20),
    arrivalDate: text(segment.arrivalDate, 20),
    arrivalTime: text(segment.arrivalTime, 20),
    carrier: text(segment.carrier, 120),
    flightNumber: text(segment.flightNumber, 40)
  }));
  const approvedTotal = raw.approvedTotal || raw.totalPrice || {};
  const amount = number(approvedTotal.amount);
  const currency = text(approvedTotal.currency || raw.currency, 20).toUpperCase();
  const travelerIds = [...new Set((raw.travelerIds || []).map((value) => text(value, 120)).filter(Boolean))];
  if (
    raw.contractVersion !== CONTRACT_VERSION
    || !text(raw.selectionId, 160)
    || !segments.length
    || segments.some((segment) => !segment.origin || !segment.destination || !segment.departureDate)
    || amount == null
    || amount < 0
    || !currency
  ) return null;
  return Object.freeze({
    contractVersion: CONTRACT_VERSION,
    selectionId: text(raw.selectionId, 160),
    selectedAt: text(raw.selectedAt, 80),
    sourceUrl: text(raw.sourceUrl, 1000),
    itinerary: Object.freeze({ segments: Object.freeze(segments.map(Object.freeze)) }),
    approvedTotal: Object.freeze({ amount, currency }),
    fareBrand: text(raw.fareBrand, 160),
    travelerIds: Object.freeze(travelerIds)
  });
}

function transactionFactsFromSelectedBooking(contract = null) {
  const booking = normalizeSelectedBooking(contract);
  if (!booking) return null;
  const ownerKey = `selected_booking:${booking.selectionId}`;
  const itineraryEvidence = booking.itinerary.segments.map((segment) => ({
    segmentId: segment.segmentId,
    ownerKey: `${ownerKey}:${segment.segmentId}`,
    authoritative: true,
    source: "product_selected_booking"
  }));
  return Object.freeze({
    evidenceMode: "typed",
    itinerary: Object.freeze({
      completeness: "complete",
      segments: Object.freeze(booking.itinerary.segments.map((segment, index) => Object.freeze({
        ...segment,
        evidence: itineraryEvidence[index]
      })))
    }),
    fareBrand: booking.fareBrand || "",
    totalPrice: Object.freeze({ amount: booking.approvedTotal.amount, currency: booking.approvedTotal.currency }),
    currency: booking.approvedTotal.currency,
    travelers: Object.freeze(booking.travelerIds.map((travelerId) => Object.freeze({ travelerId }))),
    selectedExtras: Object.freeze([]),
    factEvidence: Object.freeze({
      itinerary: Object.freeze(itineraryEvidence.map(Object.freeze)),
      totalPrice: Object.freeze({
        ownerKey,
        authoritative: true,
        role: "booking_total",
        source: "product_selected_booking"
      }),
      fareBrand: booking.fareBrand ? Object.freeze({ ownerKey, authoritative: true, source: "product_selected_booking" }) : null,
      travelers: booking.travelerIds.length ? Object.freeze({ ownerKey, authoritative: true, source: "product_selected_booking" }) : null
    }),
    provenance: Object.freeze([Object.freeze({
      source: "product_selected_booking",
      observationId: booking.selectionId,
      confidence: 1
    })])
  });
}

module.exports = {
  CONTRACT_VERSION,
  normalizeSelectedBooking,
  transactionFactsFromSelectedBooking
};
