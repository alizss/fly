const { normalizeProfileFieldType } = require("./logical-field");
const agentContract = require("../../extension/src/shared/agent-contract");

const TRANSACTION_CONTRACT_VERSION = "transaction-facts/v2";
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

function canonicalFareBrand(value = "") {
  return text(value, 160)
    .replace(/\b(?:continue with|ticket type|fare type|fare brand|ticket class|fare class|cabin class|travel class)\b/gi, " ")
    .replace(/^\s*\d+\s*x\s*/i, "")
    .replace(/\s+\b(?:edit|change|modify|details|selected)\b.*$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function normalizeFactEvidence(entry = null, fallbackObservationId = "") {
  if (!entry || typeof entry !== "object") return null;
  return {
    source: text(entry.source || "unknown", 80),
    ownerKey: text(entry.ownerKey, 180),
    ...(entry.role ? { role: text(entry.role, 40) } : {}),
    ...(entry.ownerType ? { ownerType: text(entry.ownerType, 60) } : {}),
    qualification: text(entry.qualification, 80),
    observationId: text(entry.observationId || fallbackObservationId, 120),
    confidence: Math.max(0, Math.min(1, Number(entry.confidence) || 0)),
    authoritative: entry.authoritative === true
  };
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

function canonicalDecisionOwnerKey(extra = {}) {
  const owner = semanticToken(
    extra.semanticOwnerId || extra.decisionOwnerKey || extra.decisionInstanceId || extra.ownerKey,
    300
  );
  return owner.length <= 96
    ? owner
    : `${owner.slice(0, 47).replace(/_+$/, "")}_${owner.slice(-48).replace(/^_+/, "")}`;
}

function isProfileSelection(extra = {}) {
  const sourceKind = semanticToken(extra.sourceKind || extra.originKind || extra.selectionKind, 60);
  const fieldType = normalizeProfileFieldType(
    extra.profileFieldType || extra.fieldType || extra.semanticType,
  );
  return sourceKind === "profile_field" || Boolean(fieldType);
}

function canonicalOutcomeKey(extra = {}) {
  const family = text(extra.family || extra.subjectFamily, 40).toLowerCase();
  if (!COMMERCE_FAMILIES.has(family)) return "";
  const subjectKey = canonicalSubjectKey(extra);
  const base = `${family}:${subjectKey}`;
  const ownerKey = canonicalDecisionOwnerKey(extra);
  // Extras are open-ended and frequently share presentation labels such as
  // "Select an option". Their semantic owner is therefore part of identity.
  // Closed families retain their established canonical reconciliation keys.
  return family === "extras" && ownerKey
    ? `${family}:${semanticToken(subjectKey, 60)}:${ownerKey}`
    : base;
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
  const nonTravelMeaning = /\b(?:adult|child|children|infant|teen|passengers?|age|aged|years?|months?|over|under|younger|older|kg|kgs|kilograms?|lb|lbs|pounds?|cm|centimet(?:er|re)s?|dimensions?)\b/i;
  const nonRouteCommerceMeaning = /\b(?:non[ -]?refundable|refundable|changeable|changes?|subject|fees?|charges?|conditions?|restrictions?|included|excluded|add|buy|purchase|upgrade|bags?|baggage|luggage|onboard|carry[ -]?on|bring)\b/i;
  if (!endpoint || !tokens.length) return "";
  if (/\d/.test(endpoint) || tokens.length > 8 || nonTravelMeaning.test(endpoint) || nonRouteCommerceMeaning.test(endpoint)) return "";
  if (tokens.every((token) => RESERVED_ROUTE_ENDPOINTS.has(token))) return "";
  return endpoint;
}

function normalizeSegment(segment = {}, index = 0) {
  const origin = normalizedRouteEndpoint(segment.origin);
  const destination = normalizedRouteEndpoint(segment.destination);
  const evidence = normalizeFactEvidence(segment.evidence);
  return {
    segmentId: text(segment.segmentId || `segment_${index + 1}`, 120),
    origin,
    destination,
    departureDate: text(segment.departureDate, 40),
    departureTime: text(segment.departureTime, 20),
    arrivalTime: text(segment.arrivalTime, 20),
    flightNumber: text(segment.flightNumber, 30).toUpperCase(),
    ...(evidence ? { evidence } : {})
  };
}

function routeEvidenceAuthoritative(evidence = null) {
  if (evidence?.authoritative !== true) return false;
  if (evidence.source !== "bounded_checkout_route") return true;
  return [
    "semantic_route_owner",
    "airport_code_pair",
    "owned_travel_date"
  ].includes(evidence.qualification);
}

function canonicalizeSegments(rawSegments = []) {
  return rawSegments.reduce((segments, segment) => {
    const duplicateIndex = segments.findIndex((candidate) => (
      candidate.origin === segment.origin
      && candidate.destination === segment.destination
      && (
        candidate.departureDate === segment.departureDate
        || !candidate.departureDate
        || !segment.departureDate
      )
    ));
    if (duplicateIndex < 0) {
      segments.push(segment);
      return segments;
    }
    const existing = segments[duplicateIndex];
    const existingDetail = [existing.departureDate, existing.departureTime, existing.arrivalTime, existing.flightNumber].filter(Boolean).length;
    const incomingDetail = [segment.departureDate, segment.departureTime, segment.arrivalTime, segment.flightNumber].filter(Boolean).length;
    const preferred = incomingDetail > existingDetail ? segment : existing;
    const secondary = preferred === segment ? existing : segment;
    segments[duplicateIndex] = {
      ...secondary,
      ...preferred,
      departureDate: preferred.departureDate || secondary.departureDate || "",
      departureTime: preferred.departureTime || secondary.departureTime || "",
      arrivalTime: preferred.arrivalTime || secondary.arrivalTime || "",
      flightNumber: preferred.flightNumber || secondary.flightNumber || ""
    };
    return segments;
  }, []);
}

function normalizeExtra(extra = {}, currency = "") {
  const family = text(extra.family || extra.subjectFamily, 40).toLowerCase();
  const effectRole = semanticToken(extra.effectRole, 60);
  if (!COMMERCE_FAMILIES.has(family)
    || isProfileSelection(extra)
    || ["scope_toggle", "information_only", "navigation"].includes(effectRole)) return null;
  const subjectKey = canonicalSubjectKey({ ...extra, family });
  const decisionOwnerKey = canonicalDecisionOwnerKey(extra);
  const canonicalKey = canonicalOutcomeKey({ ...extra, family, subjectKey, decisionOwnerKey });
  const sourceKind = text(extra.sourceKind || extra.originKind, 60);
  const semanticOwnerId = text(extra.semanticOwnerId, 300);
  return {
    decisionGroupId: text(extra.decisionGroupId, 140),
    ...(semanticOwnerId ? { semanticOwnerId } : {}),
    ...(semanticOwnerId || extra.decisionInstanceId
      ? { decisionInstanceId: semanticOwnerId || text(extra.decisionInstanceId, 220) }
      : {}),
    ...(decisionOwnerKey ? { decisionOwnerKey } : {}),
    ...(semanticOwnerId || extra.canonicalOwnerId
      ? { canonicalOwnerId: semanticOwnerId || text(extra.canonicalOwnerId, 220) }
      : {}),
    ...(sourceKind ? { sourceKind } : {}),
    outcomeKey: text(
      family === "extras" && decisionOwnerKey
        ? canonicalKey
        : extra.outcomeKey || canonicalKey,
      180
    ),
    family,
    ...(effectRole ? { effectRole } : {}),
    subjectKey,
    label: family === "fare"
      ? canonicalFareBrand(extra.label || extra.selectedLabel)
      : text(extra.label || extra.selectedLabel, 180),
    disposition: text(extra.disposition || extra.semantic, 80),
    outcome: text(extra.outcome || extra.semanticOutcome || extra.disposition || extra.semantic, 80),
    priceAmount: number(extra.priceAmount),
    currency: text(extra.currency || currency, 20).toUpperCase(),
    ...(extra.verified === true ? { verified: true } : {})
  };
}

function durableCommerceSelections(selections = []) {
  return (Array.isArray(selections) ? selections : []).filter((entry) => {
    const sourceKind = semanticToken(entry?.sourceKind || entry?.originKind, 60);
    if (sourceKind === "profile_field" || isProfileSelection(entry)) return false;
    if (sourceKind === "commerce_decision") return false;
    if (sourceKind === "verified_commerce_decision") return entry?.verified === true;
    // Untyped rows are retained only for compatibility with authoritative
    // transaction-fact producers (fare/bag/review summaries). They are page
    // evidence, not inferred canonical-control selections.
    return !sourceKind;
  });
}

function decisionOwnsProfileField(decision = {}, page = {}) {
  const ownedIds = new Set([
    decision.selectedControlId,
    ...(decision.physicalControlIds || [])
  ].filter(Boolean));
  if (!ownedIds.size) return false;
  return (page.controls || []).some((control) => (
    ownedIds.has(control.controlId)
    && control.fieldClassification?.source !== "direct_non_profile_control"
    && Boolean(normalizeProfileFieldType(
      control.fieldClassification?.fieldType
      || control.profileFieldType
      || control.fieldType
    ))
  ));
}

function mergeCommerceSelections(...collections) {
  const merged = new Map();
  for (const collection of collections) {
    for (const raw of Array.isArray(collection) ? collection : []) {
      const extra = normalizeExtra(raw, raw?.currency || "");
      if (!extra) continue;
      const verifiedOwnerKey = extra.verified === true
        && extra.sourceKind === "verified_commerce_decision"
        ? canonicalDecisionOwnerKey(extra)
        : "";
      const key = verifiedOwnerKey ? `verified:${verifiedOwnerKey}` : extra.outcomeKey || canonicalOutcomeKey(extra);
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

function commerceSelectionsFromJournal(state = {}) {
  const journal = state.taskState?.outcomeJournal || state.outcomeJournal || [];
  return (Array.isArray(journal) ? journal : [])
    .filter((entry) => (
      entry?.verified === true
      && entry?.originKind === "verified_commerce_decision"
      && entry?.decisionInstanceId
    ))
    .map((entry) => normalizeExtra(entry, entry.currency || ""))
    .filter(Boolean);
}

function commerceSelectionsFromVerifiedObligations(state = {}) {
  const obligations = state.taskState?.verifiedCommerceObligations || [];
  return (Array.isArray(obligations) ? obligations : [])
    .filter((entry) => (
      entry?.verified === true
      && entry?.originKind === "verified_commerce_obligation"
      && entry?.decisionInstanceId
    ))
    .map((entry) => normalizeExtra({
      ...entry,
      // Raw browser controls are not transaction authority. The exact
      // governed action receipt is promoted into the same durable source kind
      // as the canonical outcome journal before it can enter selectedExtras.
      sourceKind: "verified_commerce_decision"
    }, entry.currency || ""))
    .filter(Boolean);
}

function commerceSelectionFromEpisode(state = {}) {
  const episode = state.taskState?.decisionEpisode || state.decisionEpisode || null;
  if (
    !episode?.terminalOutcome
    || episode.status !== "completed"
    || episode.outcomeVerified !== true
    || episode.terminalOutcome.verified !== true
  ) return [];
  const normalized = normalizeExtra(episode.terminalOutcome, episode.terminalOutcome.currency || "");
  return normalized ? [normalized] : [];
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
  // Older persisted observations predate typed fact evidence. New producer
  // observations always include factEvidence and must not regain authority
  // from value-only transport if ownership proof is missing or stripped.
  const evidenceEntries = raw.factEvidence && typeof raw.factEvidence === "object"
    ? [
        ...(Array.isArray(raw.factEvidence.itinerary) ? raw.factEvidence.itinerary : []),
        raw.factEvidence.fareBrand,
        raw.factEvidence.totalPrice,
        raw.factEvidence.travelers
      ].filter((entry) => entry && typeof entry === "object")
    : [];
  const evidenceContractPresent = raw.evidenceMode === "typed" || evidenceEntries.length > 0;
  const rawSegments = Array.isArray(raw.itinerary?.segments) ? raw.itinerary.segments : [];
  const itineraryEvidence = Array.isArray(raw.factEvidence?.itinerary) ? raw.factEvidence.itinerary : [];
  const segments = canonicalizeSegments(rawSegments
    .map((segment, index) => normalizeSegment({
      ...segment,
      evidence: segment.evidence || itineraryEvidence.find((entry) => entry?.segmentId === segment.segmentId) || null
    }, index))
    .filter((segment) => segment.origin && segment.destination)
    .filter((segment) => evidenceContractPresent
      ? routeEvidenceAuthoritative(segment.evidence)
      : segment.evidence == null || routeEvidenceAuthoritative(segment.evidence)));
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
  const fareEvidence = normalizeFactEvidence(raw.factEvidence?.fareBrand, observationId);
  const fareBrand = evidenceContractPresent
    ? fareEvidence?.authoritative === true ? canonicalFareBrand(raw.fareBrand || "") : ""
    : fareEvidence && fareEvidence.authoritative !== true
      ? ""
      : canonicalFareBrand(raw.fareBrand || "");
  const rawTotalAmount = number(pagePrice.amount ?? raw.totalPrice);
  const totalPriceEvidence = normalizeFactEvidence(raw.factEvidence?.totalPrice, observationId)
    || (raw.evidenceMode === "typed" && raw.contractVersion !== TRANSACTION_CONTRACT_VERSION && rawTotalAmount != null
      ? {
          source: "legacy_typed_total",
          ownerKey: "legacy_total",
          role: "booking_total",
          ownerType: "legacy_transaction_summary",
          qualification: "pre_v2_compatibility",
          observationId: text(observationId, 120),
          confidence: 0.3,
          authoritative: true
        }
      : null);
  // Pre-v2 observations did not carry a monetary role. Preserve their
  // migration path as booking totals, while every v2 producer must publish
  // the role explicitly. This keeps one compatibility seam instead of
  // letting downstream layers reinterpret raw price text.
  const normalizedTotalPriceEvidence = totalPriceEvidence
    ? {
        ...totalPriceEvidence,
        role: totalPriceEvidence.role
          || (raw.contractVersion === TRANSACTION_CONTRACT_VERSION ? "" : "booking_total")
      }
    : null;
  const typedBookingTotal = normalizedTotalPriceEvidence?.authoritative === true
    && normalizedTotalPriceEvidence.role === "booking_total";
  const factEvidence = {
    itinerary: segments.map((segment) => {
      const evidence = normalizeFactEvidence(segment.evidence, observationId);
      return evidence ? { segmentId: segment.segmentId, ...evidence } : null;
    }).filter(Boolean),
    fareBrand: fareEvidence,
    totalPrice: normalizedTotalPriceEvidence,
    travelers: normalizeFactEvidence(raw.factEvidence?.travelers, observationId)
  };
  return {
    contractVersion: TRANSACTION_CONTRACT_VERSION,
    evidenceMode: evidenceContractPresent ? "typed" : "legacy",
    itinerary: {
      completeness: normalizeCompleteness(raw.itinerary?.completeness, segments),
      segments
    },
    travelers: authoritativeTravelers,
    currency,
    basePrice: { amount: number(basePrice.amount ?? raw.basePrice), currency: text(basePrice.currency || currency, 20).toUpperCase() },
    totalPrice: {
      amount: evidenceContractPresent && !typedBookingTotal
        ? null
        : rawTotalAmount,
      currency: text(pagePrice.currency || currency, 20).toUpperCase()
    },
    fareBrand,
    selectedExtras: mergeCommerceSelections((Array.isArray(raw.selectedExtras) ? raw.selectedExtras : []).map((extra) => ({
      ...extra,
      label: fareBrand && String(extra?.family || "").toLowerCase() === "fare"
        ? fareBrand
        : extra.label,
      currency: extra.currency || currency
    }))),
    factEvidence,
    provenance: provenance.length ? provenance : [{ source: "unknown", observationId: text(observationId, 120), confidence: 0 }]
  };
}

function factsFromObservation(state = {}, observation = {}, traveler = {}, {
  authoritativeTransactionFacts = null
} = {}) {
  const page = observation.page || {};
  const terminalReviewObserved = page.terminalEvidence?.boundaryObserved === true
    || page.terminalEvidence?.verified === true;
  const profileDecisionGroupIds = new Set((page.decisionGroups || [])
    .filter((group) => decisionOwnsProfileField({
      selectedControlId: group.selectedControlId,
      physicalControlIds: (group.alternatives || []).map((option) => option.controlId).filter(Boolean)
    }, page))
    .map((group) => group.decisionGroupId || group.requirementId)
    .filter(Boolean));
  const sourceRaw = authoritativeTransactionFacts && typeof authoritativeTransactionFacts === "object"
    ? authoritativeTransactionFacts
    : page.transactionFacts && typeof page.transactionFacts === "object"
    ? page.transactionFacts
    : {
        itinerary: { completeness: "unknown", segments: [] },
        travelers: [],
        currency: page.price?.currency || "",
        totalPrice: page.price || null,
        provenance: [{ source: "legacy_page_summary", observationId: observation.observationId || "", confidence: 0.3 }]
      };
  const sourceProvenance = Array.isArray(sourceRaw.provenance) ? sourceRaw.provenance : [];
  const raw = {
    ...sourceRaw,
    // The shared typed terminal contract is the sole authority for whether
    // these facts came from final review. This also hardens older/compacted
    // browser payloads whose producer omitted the matching provenance label.
    provenance: terminalReviewObserved
      ? [
          ...sourceProvenance,
          ...(sourceProvenance.some((entry) => entry?.source === "payment_summary")
            ? []
            : [{
                source: "payment_summary",
                observationId: observation.observationId || "",
                confidence: 1
              }])
        ]
      : sourceProvenance,
    selectedExtras: (sourceRaw.selectedExtras || []).filter((extra) => (
      !profileDecisionGroupIds.has(extra?.decisionGroupId)
    ))
  };
  const normalized = normalizeFacts(raw, { observationId: observation.observationId || "", state, traveler });
  const episodeSelections = commerceSelectionFromEpisode(state);
  const journalSelections = commerceSelectionsFromJournal(state);
  const verifiedObligationSelections = commerceSelectionsFromVerifiedObligations(state);
  return {
    ...normalized,
    // DecisionFrame transaction evidence and exact verified receipts are the
    // only production commerce authorities. A selected checkbox/toggle in the
    // current control graph is UI state, not proof that a paid item entered
    // the booking.
    selectedExtras: mergeCommerceSelections(
      normalized.selectedExtras,
      journalSelections,
      episodeSelections,
      verifiedObligationSelections
    )
  };
}

module.exports = {
  COMMERCE_FAMILIES,
  TRANSACTION_CONTRACT_VERSION,
  canonicalDecisionOwnerKey,
  canonicalFareBrand,
  canonicalOutcomeKey,
  canonicalSubjectKey,
  commerceSelectionFromEpisode,
  commerceSelectionsFromJournal,
  commerceSelectionsFromVerifiedObligations,
  durableCommerceSelections,
  factsFromObservation,
  mergeCommerceSelections,
  normalizeFacts
};
