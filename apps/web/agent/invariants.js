const { withUpdate } = require("../../../packages/shared/agent-state");
const { factsFromObservation, normalizeFacts } = require("./transaction-facts");
const { controlBelongsToCurrentSurface } = require("./surface-contract");

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
    envelope: nextEnvelope,
    observation
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

function observedPaidExtraForDecision(observed = {}, decisionGroupId = "") {
  return (observed.selectedExtras || []).find((extra) => {
    if (!decisionGroupId || extra.decisionGroupId !== decisionGroupId) return false;
    const disposition = normalizedText(extra.disposition);
    return number(extra.priceAmount) > 0
      || (/paid|money/.test(disposition) && !/decline|free|remove|skip|without|none/.test(disposition));
  }) || null;
}

function exactPolicyCorrectionStep(action = {}, state = {}, observed = {}) {
  const decisionGroupId = action.decisionGroupId
    || action.targetSnapshot?.decisionGroupId
    || action.expectedOutcome?.decisionGroupId
    || action.affordance?.task?.decisionGroupId
    || "";
  const targetControlId = action.controlId || action.targetSnapshot?.controlId || "";
  const effect = action.mechanicalEffect
    || action.physicalEffect
    || action.affordance?.mechanicalEffect
    || action.affordance?.physicalEffect
    || action.affordance?.effect
    || "";
  const currentGoal = state.taskState?.currentGoal || {};
  const conflict = (state.taskState?.activeDecisions || []).find((decision) => (
    decision.decisionGroupId === decisionGroupId
    && decision.status === "conflicted"
    && /SELECTED_OPTION_(?:PRICE_EXCEEDS|CONTRADICTS)_POLICY/.test(String(decision.reopenEvidence?.code || ""))
  ));
  const paidSelection = observedPaidExtraForDecision(observed, decisionGroupId);
  const exactGoal = Boolean(currentGoal.decisionGroupId && currentGoal.decisionGroupId === decisionGroupId);
  const exactTarget = Boolean(
    decisionGroupId
    && targetControlId
    && action.targetSnapshot?.controlId === targetControlId
    && (
      action.targetSnapshot?.decisionGroupId === decisionGroupId
      || (
        action.targetSnapshot?.policyCorrectionForDecisionGroupId === decisionGroupId
        && action.targetSnapshot?.semanticOwnershipLinkId
      )
    )
  );
  const expected = action.expectedOutcome || {};
  const safeMeaning = normalizedText(`${action.intent || ""} ${action.semanticIntent || ""} ${action.targetSnapshot?.semantic || ""} ${action.targetSnapshot?.risk || ""}`);
  const exactFreeReversal = effect === "select_free_option"
    && expected.type === "exact_free_option_selected"
    && expected.decisionGroupId === decisionGroupId
    && (expected.expectedSelectedControlId || expected.controlId) === targetControlId
    && expected.prohibitPaidAlternative !== false
    && /decline|free|remove|skip|without|none|safe/.test(safeMeaning);
  const exactSelectorOpen = effect === "open_surface"
    && expected.type === "options_surface_appeared"
    && expected.decisionGroupId === decisionGroupId
    && /open choice|open selector|open dropdown/.test(safeMeaning);
  const linkedOutcomeMatchesObservedMechanics = expected.intendedOutcome === "open_correction_surface"
    ? expected.type === "options_surface_appeared"
      && !["advance_checkout_stage", "submit_purchase", "enter_payment_credentials", "accept_legal_terms"].includes(effect)
    : expected.type === "policy_conflict_resolved"
      && !["advance_surface", "advance_checkout_stage", "submit_purchase", "enter_payment_credentials", "accept_legal_terms"].includes(effect);
  const linkedSemanticCorrection = Boolean(
    action.semanticOwnershipLinkId
    && action.policyCorrectionForDecisionGroupId === decisionGroupId
    && linkedOutcomeMatchesObservedMechanics
    && expected.semanticOwnershipLinkId === action.semanticOwnershipLinkId
    && expected.decisionGroupId === decisionGroupId
    && expected.controlId === targetControlId
    && expected.intendedOutcome
    && expected.intendedOutcome !== "unknown"
  );
  return Boolean(conflict && paidSelection && exactGoal && exactTarget && (exactFreeReversal || exactSelectorOpen || linkedSemanticCorrection));
}

function groundedSafeReversalForExtra(extra = {}, observation = {}) {
  const page = observation.page || {};
  const decisionGroupId = text(extra.decisionGroupId, 140);
  const group = (page.decisionGroups || []).find((item) => text(item.decisionGroupId, 140) === decisionGroupId);
  if (!group) return null;
  const semanticLink = (page.semanticOwnershipLinks || []).find((link) => (
    link.status === "resolved"
    && link.sourceDecisionGroupId === decisionGroupId
    && link.intendedOutcome
    && link.intendedOutcome !== "unknown"
  )) || null;
  const ids = new Set([
    group.removalControlId,
    ...(group.alternativeControlIds || []),
    ...(group.semanticCorrectionControlIds || []),
    semanticLink?.correctionControlId,
    ...(group.alternatives || []).map((alternative) => alternative.controlId)
  ].map((id) => text(id, 140)).filter(Boolean));
  const control = (page.controls || []).find((item) => {
    if (!ids.has(text(item.controlId, 140))) return false;
    if (!controlBelongsToCurrentSurface(item, page)) return false;
    const meaning = normalizedText(`${item.semantic || ""} ${item.physicalEffect || ""} ${item.risk || ""}`);
    const exactLinkedHypothesis = semanticLink?.correctionControlId === text(item.controlId, 140);
    if (!exactLinkedHypothesis && !/remove|decline|free|skip|without|none|deselect|clear|safe decline|select free/.test(meaning)) return false;
    if (/advance checkout stage|payment|purchase|legal|select paid|add paid/.test(meaning)) return false;
    return Object.values(item.operations || {}).some((operation) => (
      operation?.actionability?.executable === true || operation?.actionability?.revealable === true
    ));
  });
  return control ? {
    decisionGroupId,
    controlId: text(control.controlId, 140),
    effect: text(control.physicalEffect || "unknown", 80),
    ...(semanticLink?.intendedOutcome ? { intendedOutcome: semanticLink.intendedOutcome } : {}),
    ...(semanticLink?.linkId ? { semanticOwnershipLinkId: semanticLink.linkId } : {})
  } : null;
}

function invariantDecision(prepared = {}, action = {}, state = prepared.state || {}) {
  const baseline = prepared.baseline || normalizeFacts({});
  const observed = prepared.observed || normalizeFacts({});
  const checks = [];
  const deny = (code, reason, details = {}, decision = "blocked_by_safety") => ({ allow: false, decision, code, reason, details, checks: [...checks, { code, ok: false }] });
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

  const actionEffect = action.mechanicalEffect
    || action.physicalEffect
    || action.affordance?.mechanicalEffect
    || action.affordance?.physicalEffect
    || action.affordance?.effect
    || "";
  const actionMeaning = normalizedText(`${action.intent || ""} ${action.semanticIntent || ""} ${action.risk || ""} ${action.targetSnapshot?.semantic || ""}`);
  const exactCostReducingCorrection = exactPolicyCorrectionStep(action, state, observed);
  // A grounded observation-scoped correction may still have an unknown
  // browser semantic. Its safety comes from the exact conflict/control link
  // and fresh postcondition, not from rewriting the observed effect.
  const correctsPaidSelection = exactCostReducingCorrection;
  const actionAddsCost = actionEffect === "select_paid_option"
    || action.risk === "money"
    || action.targetSnapshot?.risk === "money"
    || number(action.affordance?.structuredPrice?.amount) > 0;
  const finalTransactionBoundary = actionEffect === "submit_purchase"
    || action.risk === "payment"
    || action.targetSnapshot?.risk === "payment"
    || /submit payment|submit purchase|confirm purchase|finalize booking|book now/.test(actionMeaning);

  const beforePrice = number(baseline.totalPrice?.amount);
  const currentPrice = number(observed.totalPrice?.amount);
  if (beforePrice != null && currentPrice != null && currentPrice > beforePrice) {
    if (exactCostReducingCorrection) {
      pass("ELEVATED_PRICE_EXACT_CORRECTION", `${beforePrice} -> ${currentPrice}`);
    } else if (actionAddsCost || finalTransactionBoundary) {
      const authorization = state.approvals?.priceAuthorization;
      const maximum = number(authorization?.maximumAmount);
      if (!authorization?.authorizationId || maximum == null || currentPrice > maximum) {
        return deny("UNAPPROVED_PRICE_CHANGE", `A cost-adding or final transaction action requires price authorization for the current total (${beforePrice} -> ${currentPrice}).`, { before: beforePrice, after: currentPrice });
      }
    } else {
      pass("PRICE_CHANGE_REQUIRES_RECONCILIATION_NOT_APPROVAL", `${beforePrice} -> ${currentPrice}`);
    }
  }
  pass("PRICE_OBSERVED_OR_BOUNDARY_AUTHORIZED");
  const advancesCheckout = !correctsPaidSelection && (
    ["advance_surface", "advance_checkout_stage"].includes(actionEffect)
    || action.intent === "navigate_stage"
  );
  if (advancesCheckout) {
    const paidSelections = (observed.selectedExtras || []).filter((extra) => (
      number(extra.priceAmount) > 0
      || (
        /paid|money/.test(normalizedText(extra.disposition))
        && !/decline|free|remove|skip|without|none/.test(normalizedText(extra.disposition))
      )
    ));
    const authorizations = Array.isArray(state.approvals?.paidExtraAuthorizations)
      ? state.approvals.paidExtraAuthorizations
      : [];
    const unapproved = paidSelections.filter((extra) => !authorizations.some((authorization) => (
      authorization?.authorizationId
      && authorization.decisionGroupId
      && authorization.decisionGroupId === extra.decisionGroupId
    )));
    if (unapproved.length) {
      const groundedReversal = unapproved
        .map((extra) => groundedSafeReversalForExtra(extra, prepared.observation || {}))
        .find(Boolean);
      if (groundedReversal) {
        return deny(
          "UNAPPROVED_SELECTED_EXTRA",
          "An unrequested paid option has an exact safe reversal. Reconcile it before continuing.",
          {
            decisionGroupIds: unapproved.map((extra) => extra.decisionGroupId),
            selectedExtras: unapproved,
            groundedReversal,
            recoveryDirective: "reconcile_selected_extra"
          },
          "recoverable"
        );
      }
      return deny(
        "UNAPPROVED_SELECTED_EXTRA",
        "The current checkout contains a paid optional item without an explicit item authorization.",
        { decisionGroupIds: unapproved.map((extra) => extra.decisionGroupId), selectedExtras: unapproved }
      );
    }
  }
  pass("SELECTED_EXTRAS_EXPLICITLY_AUTHORIZED");

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
