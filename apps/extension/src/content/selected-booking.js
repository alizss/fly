import { currentNavigationUrl } from "./navigation-identity.js";

export const SELECTED_BOOKING_MAX_AGE_MS = 6 * 60 * 60 * 1000;

const BOOKING_APPROVAL_SOURCES = new Set([
  "explicit_agent_start",
  "explicit_flight_selection"
]);

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

function itineraryIdentity(value = null) {
  const segments = Array.isArray(value?.itinerary?.segments) ? value.itinerary.segments : [];
  if (!segments.length) return "";
  const normalized = segments.map((segment) => ({
    origin: String(segment?.origin || "").trim().toUpperCase(),
    destination: String(segment?.destination || "").trim().toUpperCase(),
    departureDate: String(segment?.departureDate || segment?.departure_date || "").trim()
  }));
  if (normalized.some((segment) => !segment.origin || !segment.destination || !segment.departureDate)) return "";
  return JSON.stringify(normalized);
}

function bookingFactsFromCandidate(candidate = null) {
  if (!candidate || typeof candidate !== "object") return null;
  if (candidate.facts?.itinerary) return candidate.facts;
  if (candidate.itinerary && candidate.approvedTotal) {
    return {
      itinerary: candidate.itinerary,
      currency: candidate.approvedTotal.currency || "",
      totalPrice: candidate.approvedTotal
    };
  }
  return candidate.itinerary ? candidate : null;
}

export function selectedBookingCompatibilityWithMap(candidate = null, map = null) {
  const currentFacts = authoritativeSelectedBookingItinerary(map?.transactionFacts);
  if (!currentFacts) {
    return Object.freeze({ status: "unknown", reason: "CURRENT_CHECKOUT_IDENTITY_UNAVAILABLE" });
  }
  const candidateFacts = bookingFactsFromCandidate(candidate);
  const candidateIdentity = itineraryIdentity(candidateFacts);
  const currentIdentity = itineraryIdentity(currentFacts);
  if (!candidateIdentity || !currentIdentity || candidateIdentity !== currentIdentity) {
    return Object.freeze({ status: "conflict", reason: "CURRENT_CHECKOUT_ITINERARY_MISMATCH" });
  }
  const candidateAmount = Number(candidateFacts?.totalPrice?.amount);
  const candidateCurrency = String(
    candidateFacts?.totalPrice?.currency || candidateFacts?.currency || ""
  ).trim().toUpperCase();
  const currentAmount = Number(currentFacts?.totalPrice?.amount);
  const currentCurrency = String(
    currentFacts?.totalPrice?.currency || currentFacts?.currency || ""
  ).trim().toUpperCase();
  const currentTotalAuthoritative = Number.isFinite(currentAmount)
    && Boolean(currentCurrency)
    && currentFacts?.factEvidence?.totalPrice?.authoritative === true
    && currentFacts?.factEvidence?.totalPrice?.role === "booking_total";
  if (currentTotalAuthoritative && (
    !Number.isFinite(candidateAmount)
    || candidateCurrency !== currentCurrency
    || Math.abs(candidateAmount - currentAmount) > 0.005
  )) {
    return Object.freeze({ status: "conflict", reason: "CURRENT_CHECKOUT_TOTAL_MISMATCH" });
  }
  return Object.freeze({ status: "match", reason: "CURRENT_CHECKOUT_IDENTITY_MATCH" });
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
  if (!BOOKING_APPROVAL_SOURCES.has(approvalSource)) return null;
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
        source: approvalSource === "explicit_flight_selection"
          ? "user_selected_visible_flight_total"
          : "user_approved_visible_checkout_total",
        ownerKey,
        role: "booking_total",
        ownerType: "selected_booking_summary",
        qualification: approvalSource,
        observationId: String(observationHash || ""),
        confidence: 1,
        authoritative: true
      }
    },
    provenance: [
      ...(Array.isArray(facts.provenance) ? facts.provenance : []),
      {
        source: approvalSource,
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
  const sourceUrl = environment.sourceUrl ?? currentNavigationUrl();
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
