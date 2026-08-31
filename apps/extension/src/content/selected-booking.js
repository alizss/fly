export const SELECTED_BOOKING_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const DEV_BOOKING_HORIZON_DAYS = 400;

function normalizedCalendarToken(value = "") {
  return String(value || "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();
}

function localizedCalendarTokens(locale = "en") {
  const locales = [...new Set([String(locale || "").trim(), "en"].filter(Boolean))];
  const months = new Map();
  const weekdays = new Map();
  for (const candidateLocale of locales) {
    for (const style of ["long", "short"]) {
      const monthFormatter = new Intl.DateTimeFormat(candidateLocale, { month: style, timeZone: "UTC" });
      const weekdayFormatter = new Intl.DateTimeFormat(candidateLocale, { weekday: style, timeZone: "UTC" });
      for (let month = 0; month < 12; month += 1) {
        months.set(normalizedCalendarToken(monthFormatter.format(new Date(Date.UTC(2024, month, 1)))), month);
      }
      for (let weekday = 0; weekday < 7; weekday += 1) {
        weekdays.set(normalizedCalendarToken(weekdayFormatter.format(new Date(Date.UTC(2024, 0, 7 + weekday)))), weekday);
      }
    }
  }
  return { months, weekdays };
}

function validUtcDate(year, month, day) {
  const date = new Date(Date.UTC(Number(year), Number(month), Number(day)));
  return date.getUTCFullYear() === Number(year)
    && date.getUTCMonth() === Number(month)
    && date.getUTCDate() === Number(day)
    ? date
    : null;
}

function isoCalendarDate(date) {
  return [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()]
    .map((value, index) => index === 0 ? String(value).padStart(4, "0") : String(value).padStart(2, "0"))
    .join("-");
}

// This is deliberately bounded normalization, not semantic booking authority.
// It converts a date already owned by authoritative structural itinerary
// evidence into one calendar day. Ambiguous values remain unresolved.
export function canonicalSelectedBookingDate(value = "", {
  referenceAt = Date.now(),
  notBefore = "",
  locale = "en",
  horizonDays = DEV_BOOKING_HORIZON_DAYS
} = {}) {
  const raw = String(value || "").replace(/\s+/g, " ").trim();
  const iso = raw.match(/\b(20\d{2})[-/.](0?[1-9]|1[0-2])[-/.](0?[1-9]|[12]\d|3[01])\b/);
  if (iso) {
    const exact = validUtcDate(iso[1], Number(iso[2]) - 1, iso[3]);
    return exact ? isoCalendarDate(exact) : "";
  }

  const tokens = raw.match(/[\p{L}\p{M}]+|\d{1,4}/gu) || [];
  const normalized = tokens.map(normalizedCalendarToken).filter(Boolean);
  const { months, weekdays } = localizedCalendarTokens(locale);
  const monthToken = normalized.find((token) => months.has(token));
  const dayToken = normalized.find((token) => /^\d{1,2}$/.test(token) && Number(token) >= 1 && Number(token) <= 31);
  const yearToken = normalized.find((token) => /^20\d{2}$/.test(token));
  const weekdayToken = normalized.find((token) => weekdays.has(token));
  if (!monthToken || !dayToken) return "";

  const month = months.get(monthToken);
  const day = Number(dayToken);
  if (yearToken) {
    const exact = validUtcDate(Number(yearToken), month, day);
    if (!exact || (weekdayToken && exact.getUTCDay() !== weekdays.get(weekdayToken))) return "";
    return isoCalendarDate(exact);
  }

  const reference = new Date(referenceAt);
  if (!Number.isFinite(reference.getTime())) return "";
  const referenceDay = Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), reference.getUTCDate());
  const minimum = notBefore
    ? Date.parse(`${notBefore}T00:00:00.000Z`)
    : referenceDay - 24 * 60 * 60 * 1000;
  const maximum = referenceDay + Math.max(1, Number(horizonDays) || DEV_BOOKING_HORIZON_DAYS) * 24 * 60 * 60 * 1000;
  const candidates = [];
  for (let year = reference.getUTCFullYear() - 1; year <= reference.getUTCFullYear() + 2; year += 1) {
    const candidate = validUtcDate(year, month, day);
    if (!candidate) continue;
    const time = candidate.getTime();
    if (time < minimum || time > maximum) continue;
    if (weekdayToken && candidate.getUTCDay() !== weekdays.get(weekdayToken)) continue;
    candidates.push(candidate);
  }
  return candidates.length === 1 ? isoCalendarDate(candidates[0]) : "";
}

export function testSelectedBookingFromObservedFacts(facts = null, {
  travelerId = "",
  referenceAt = Date.now(),
  sourceUrl = "",
  locale = "en"
} = {}) {
  const authoritativeItinerary = authoritativeSelectedBookingItinerary(facts);
  const authoritativeTotal = authoritativeSelectedBookingTotal(facts);
  const observedSegments = Array.isArray(facts?.itinerary?.segments)
    ? facts.itinerary.segments
    : [];
  const rawSegments = Array.isArray(authoritativeItinerary?.itinerary?.segments)
    ? authoritativeItinerary.itinerary.segments
    : [];
  const amount = Number(authoritativeTotal?.amount);
  const currency = String(authoritativeTotal?.currency || "").trim().toUpperCase();
  const selectedTravelerId = String(travelerId || "").trim();
  const observed = {
    itinerary: { segments: observedSegments },
    approvedTotal: Number.isFinite(Number(facts?.totalPrice?.amount)) && String(facts?.totalPrice?.currency || facts?.currency || "").trim()
      ? { amount: Number(facts.totalPrice.amount), currency: String(facts.totalPrice.currency || facts.currency).trim().toUpperCase() }
      : null
  };
  const missingFacts = [];
  if (!rawSegments.length) missingFacts.push("itinerary");
  if (!Number.isFinite(amount)) missingFacts.push("approved_total");
  if (!currency) missingFacts.push("currency");
  if (!selectedTravelerId) missingFacts.push("selected_traveler");
  if (missingFacts.length) {
    return { ok: false, captured: false, code: "BOOKING_FACTS_INCOMPLETE", missingFacts, observed };
  }

  const segments = [];
  for (const [index, segment] of rawSegments.entries()) {
    const previous = segments.at(-1) || null;
    const departureDate = canonicalSelectedBookingDate(segment.departureDate, {
      referenceAt,
      notBefore: previous?.departureDate || "",
      locale
    });
    if (!departureDate) {
      return {
        ok: false,
        captured: false,
        code: "BOOKING_DATE_AMBIGUOUS",
        missingFacts: ["departure_date"],
        observed
      };
    }
    if (previous && previous.destination !== String(segment.origin || "").trim().toUpperCase()) {
      return {
        ok: false,
        captured: false,
        code: "BOOKING_ITINERARY_AMBIGUOUS",
        missingFacts: ["one coherent itinerary"],
        observed
      };
    }
    segments.push({
      segmentId: String(segment.segmentId || `segment_${index + 1}`),
      origin: String(segment.origin || "").trim().toUpperCase(),
      destination: String(segment.destination || "").trim().toUpperCase(),
      departureDate,
      departureTime: String(segment.departureTime || "").trim(),
      arrivalTime: String(segment.arrivalTime || "").trim(),
      flightNumber: String(segment.flightNumber || "").trim().toUpperCase()
    });
  }

  const selectedAt = new Date(referenceAt).toISOString();
  return {
    ok: true,
    captured: true,
    code: "DEV_OBSERVED_BOOKING_CONFIRMED",
    missingFacts: [],
    observed,
    selectedBookingContract: {
      contractVersion: "selected-booking/v1",
      selectionId: `test_page_confirmation_${Date.parse(selectedAt).toString(36)}`,
      selectedAt,
      sourceUrl: String(sourceUrl || ""),
      itinerary: { segments },
      approvedTotal: { amount, currency },
      fareBrand: String(authoritativeItinerary?.fareBrand || "").trim(),
      travelerIds: [selectedTravelerId],
      testOnlyPageConfirmation: true
    }
  };
}

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

function checkoutSiteIdentity(value = "") {
  try {
    const hostname = new URL(String(value || ""), globalThis.location?.href || "https://invalid.test").hostname
      .toLowerCase()
      .replace(/^www\./, "");
    const labels = hostname.split(".").filter(Boolean);
    if (labels.length <= 2) return hostname;
    const publicSuffix = labels.slice(-2).join(".");
    return ["co.uk", "com.au", "co.nz", "co.jp"].includes(publicSuffix)
      ? labels.slice(-3).join(".")
      : labels.slice(-2).join(".");
  } catch (error) {
    return "";
  }
}

export function selectedBookingMissingFacts(acquisition = null, map = null) {
  const facts = acquisition?.facts || map?.transactionFacts || null;
  const segments = Array.isArray(facts?.itinerary?.segments) ? facts.itinerary.segments : [];
  const missing = [];
  if (!segments.length) missing.push("itinerary");
  else {
    if (segments.some((segment) => !String(segment?.origin || "").trim() || !String(segment?.destination || "").trim())) missing.push("route");
    if (segments.some((segment) => !String(segment?.departureDate || segment?.departure_date || "").trim())) missing.push("departure_date");
  }
  const amount = Number(facts?.totalPrice?.amount);
  const currency = String(facts?.totalPrice?.currency || facts?.currency || "").trim();
  const totalEvidence = facts?.factEvidence?.totalPrice || null;
  const authoritativeBookingTotal = Number.isFinite(amount)
    && amount >= 0
    && Boolean(currency)
    && totalEvidence?.authoritative === true
    && totalEvidence?.role === "booking_total"
    && Boolean(String(totalEvidence.ownerKey || "").trim());
  if (!authoritativeBookingTotal) missing.push("approved_total");
  if (!currency || !authoritativeBookingTotal) missing.push("currency");
  return Object.freeze([...new Set(missing)]);
}

export function selectedBookingAdmissionState(acquisition = null, map = null, {
  now = Date.now(),
  currentUrl = globalThis.location?.href || "",
  currentCheckoutLineageId = "",
  checkoutLineageAuthoritative = false
} = {}) {
  if (!acquisition) {
    const missingFacts = selectedBookingMissingFacts(null, map);
    const hasCandidateEvidence = missingFacts.length < 4;
    return Object.freeze({
      status: hasCandidateEvidence ? "candidate" : "absent",
      reason: hasCandidateEvidence ? "CURRENT_TAB_BOOKING_PARTIAL" : "CURRENT_TAB_BOOKING_ABSENT",
      missingFacts
    });
  }
  const capturedAt = Date.parse(String(acquisition.capturedAt || ""));
  if (!Number.isFinite(capturedAt) || now - capturedAt > SELECTED_BOOKING_MAX_AGE_MS) {
    return Object.freeze({ status: "expired", reason: "CURRENT_TAB_BOOKING_EXPIRED", missingFacts: selectedBookingMissingFacts(acquisition, map) });
  }
  const compatibility = selectedBookingCompatibilityWithMap(acquisition, map);
  if (compatibility.status === "conflict") {
    return Object.freeze({ status: "conflict", reason: compatibility.reason, missingFacts: selectedBookingMissingFacts(acquisition, map) });
  }
  const acquisitionLineageId = String(acquisition.checkoutLineageId || "").trim();
  const activeLineageId = String(currentCheckoutLineageId || "").trim();
  if (checkoutLineageAuthoritative && (!acquisitionLineageId || acquisitionLineageId !== activeLineageId)) {
    return Object.freeze({
      status: "conflict",
      reason: "CURRENT_TAB_CHECKOUT_LINEAGE_MISMATCH",
      missingFacts: selectedBookingMissingFacts(acquisition, map)
    });
  }
  // Migration fallback for acquisitions created by older extension builds.
  // New checkouts use the background-owned lineage above, so a legitimate
  // airline -> unrelated booking-provider redirect does not look stale merely
  // because its registrable domain changed.
  if (!checkoutLineageAuthoritative && compatibility.status === "unknown") {
    const sourceSite = checkoutSiteIdentity(acquisition.sourceUrl || acquisition.sourceOrigin);
    const currentSite = checkoutSiteIdentity(currentUrl);
    if (sourceSite && currentSite && sourceSite !== currentSite) {
      return Object.freeze({
        status: "conflict",
        reason: "CURRENT_TAB_CHECKOUT_LINEAGE_MISMATCH",
        missingFacts: selectedBookingMissingFacts(acquisition, map)
      });
    }
  }
  const confirmed = authoritativeSelectedBookingFacts(acquisition.facts);
  return Object.freeze({
    status: confirmed ? "confirmed" : "candidate",
    reason: confirmed ? "CURRENT_TAB_BOOKING_CONFIRMED" : "CURRENT_TAB_BOOKING_PARTIAL",
    missingFacts: selectedBookingMissingFacts(acquisition, map)
  });
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
  return authoritativeSelectedBookingTotal(facts) ? itineraryFacts : null;
}

function authoritativeSelectedBookingTotal(facts = null) {
  if (!facts || facts.evidenceMode !== "typed") return null;
  const totalAmount = Number(facts.totalPrice?.amount);
  const totalCurrency = String(facts.totalPrice?.currency || facts.currency || "").trim().toUpperCase();
  const totalEvidence = facts.factEvidence?.totalPrice || null;
  const authoritativeTotal = Number.isFinite(totalAmount)
    && totalAmount >= 0
    && Boolean(totalCurrency)
    && totalEvidence?.authoritative === true
    && totalEvidence?.role === "booking_total"
    && Boolean(String(totalEvidence.ownerKey || "").trim());
  return authoritativeTotal ? { amount: totalAmount, currency: totalCurrency } : null;
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
