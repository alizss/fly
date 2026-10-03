const { callStructured } = require("./openai-client");

const bookingProposalSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "segments", "approvedTotal", "confidence", "evidence"],
  properties: {
    status: { type: "string", enum: ["proposed", "unknown"] },
    segments: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["origin", "originAliases", "destination", "destinationAliases", "departureDate"],
        properties: {
          origin: { type: "string", maxLength: 120 },
          originAliases: {
            type: "array",
            maxItems: 6,
            items: { type: "string", maxLength: 120 }
          },
          destination: { type: "string", maxLength: 120 },
          destinationAliases: {
            type: "array",
            maxItems: 6,
            items: { type: "string", maxLength: 120 }
          },
          departureDate: { type: "string", maxLength: 10 }
        }
      }
    },
    approvedTotal: {
      type: "object",
      additionalProperties: false,
      required: ["amount", "currency"],
      properties: {
        amount: { type: "number", minimum: 0 },
        currency: { type: "string", maxLength: 3 }
      }
    },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    evidence: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["fact", "value", "source"],
        properties: {
          fact: { type: "string", maxLength: 80 },
          value: { type: "string", maxLength: 180 },
          source: { type: "string", enum: ["dom", "screenshot"] }
        }
      }
    }
  }
};

function validIsoDate(value = "") {
  const text = String(value || "").trim();
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

function endpointAliases(primary = "", aliases = []) {
  return [...new Set([primary, ...(Array.isArray(aliases) ? aliases : [])]
    .map((value) => String(value || "").replace(/\s+/g, " ").trim())
    .filter(Boolean))].slice(0, 6);
}

function endpointsOverlap(left = [], right = []) {
  const normalizedLeft = new Set(left.map((value) => value.toLocaleUpperCase()));
  return right.some((value) => normalizedLeft.has(value.toLocaleUpperCase()));
}

function normalizeBookingProposal(value = null, { observed = null } = {}) {
  let segments = Array.isArray(value?.segments)
    ? value.segments.slice(0, 8).map((segment) => {
        const origin = String(segment?.origin || "").replace(/\s+/g, " ").trim();
        const destination = String(segment?.destination || "").replace(/\s+/g, " ").trim();
        return {
          origin,
          originAliases: endpointAliases(origin, segment?.originAliases),
          destination,
          destinationAliases: endpointAliases(destination, segment?.destinationAliases),
          departureDate: String(segment?.departureDate || "").trim()
        };
      })
    : [];
  const observedSegments = Array.isArray(observed?.itinerary?.segments)
    ? observed.itinerary.segments.map((segment) => ({
        originAliases: endpointAliases(segment?.origin, segment?.originAliases),
        destinationAliases: endpointAliases(segment?.destination, segment?.destinationAliases),
        departureDate: String(segment?.departureDate || "").trim()
      }))
    : [];
  // Deterministic observation may retain an exact display-label/IATA relation
  // that the proposal chose to render with only one of those tokens. Merge the
  // identities only when both endpoints and the departure date already overlap;
  // this preserves proven aliases without introducing airport-name guessing.
  segments = segments.map((segment) => {
    const matching = observedSegments.find((observedSegment) => (
      observedSegment.departureDate === segment.departureDate
      && endpointsOverlap(segment.originAliases, observedSegment.originAliases)
      && endpointsOverlap(segment.destinationAliases, observedSegment.destinationAliases)
    ));
    return matching ? {
      ...segment,
      originAliases: endpointAliases(segment.origin, [...segment.originAliases, ...matching.originAliases]),
      destinationAliases: endpointAliases(segment.destination, [...segment.destinationAliases, ...matching.destinationAliases])
    } : segment;
  });
  const amount = Number(value?.approvedTotal?.amount);
  const currency = String(value?.approvedTotal?.currency || "").trim().toUpperCase();
  const connectedItinerary = segments.every((segment, index) => (
    index === 0
    || endpointsOverlap(segments[index - 1].destinationAliases, segment.originAliases)
  ));
  const coherent = value?.status === "proposed"
    && segments.length > 0
    && segments.every((segment) => segment.origin && segment.destination && validIsoDate(segment.departureDate))
    && connectedItinerary
    && Number.isFinite(amount)
    && amount > 0
    && /^[A-Z]{3}$/.test(currency);
  return {
    status: coherent ? "proposed" : "unknown",
    segments: coherent ? segments : [],
    approvedTotal: coherent ? { amount, currency } : { amount: 0, currency: "" },
    confidence: ["high", "medium", "low"].includes(value?.confidence) ? value.confidence : "low",
    evidence: Array.isArray(value?.evidence)
      ? value.evidence.slice(0, 12).map((entry) => ({
          fact: String(entry?.fact || "").slice(0, 80),
          value: String(entry?.value || "").slice(0, 180),
          source: entry?.source === "screenshot" ? "screenshot" : "dom"
        })).filter((entry) => entry.fact && entry.value)
      : []
  };
}

async function proposeBookingCandidate({
  apiKey,
  model,
  sourceUrl = "",
  pageTitle = "",
  pageText = "",
  observed = null,
  screenshotDataUrl = "",
  referenceDate = "",
  callStructuredFn = callStructured
} = {}) {
  const result = await callStructuredFn({
    apiKey,
    model,
    schema: bookingProposalSchema,
    schemaName: "booking_proposal",
    maxOutputTokens: 1100,
    instructions: [
      "You inspect one current airline or OTA page only to propose the booking the user has visibly selected.",
      "Use the DOM text, deterministic observations, and screenshot as evidence. Never invent missing facts.",
      "Distinguish selected flights from alternative fares. Use the basket or checkout grand total, not a single leg price or a crossed-out price.",
      "For each endpoint, make origin/destination the exact selected-route label visibly rendered by the page. Put every other visibly proven identity for that same endpoint, such as its IATA code and full airport or city label, in the matching aliases array. Never infer an alias from general knowledge.",
      "Return status=proposed only when one coherent selected itinerary, exact departure date for every segment, final total, and three-letter currency are jointly visible.",
      "Normalize dates to YYYY-MM-DD. Infer a year only when the page evidence and reference date make it unambiguous.",
      "If any required fact is ambiguous, return status=unknown with empty segments, amount 0, and empty currency.",
      "This output is only a proposal for explicit human confirmation. It is never transaction approval."
    ].join("\n"),
    payload: {
      page: {
        sourceUrl: String(sourceUrl || "").slice(0, 500),
        title: String(pageTitle || "").slice(0, 240),
        referenceDate: String(referenceDate || "").slice(0, 10),
        visibleText: String(pageText || "").replace(/\s+/g, " ").trim().slice(0, 16_000)
      },
      deterministicObservation: observed || null
    },
    screenshotDataUrl,
    returnMeta: true
  });
  return {
    proposal: normalizeBookingProposal(result.data, { observed }),
    meta: result.meta
  };
}

module.exports = {
  bookingProposalSchema,
  normalizeBookingProposal,
  proposeBookingCandidate,
  validIsoDate
};
