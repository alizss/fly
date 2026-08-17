const { prepareTransactionInvariants } = require("./invariants");
const { canonicalizeUserPolicy } = require("./policy-profile");
const { withUpdate } = require("../../../packages/shared/agent-state");
const {
  normalizeSelectedBooking,
  transactionFactsFromSelectedBooking
} = require("../../../packages/shared/selected-booking");
const { requestBodyError } = require("../http/body");

function clampText(value, max = 4000) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function summarizeAgentSession(session) {
  if (!session) return null;
  return {
    id: session.id,
    status: session.status,
    goal: session.goal,
    currentStage: session.taskState?.stage || "unknown",
    travelerName: "",
    approvals: session.approvals,
    completedFields: [],
    lockedFields: {},
    retryCounts: {},
    lastAction: session.lastAction,
    lastResult: session.lastActionResult || null,
    lastPageSummary: {
      site: session.site?.host || "",
      url: session.site?.url || "",
      requirements: 0,
      missing: (session.taskState?.activeDecisions || []).filter((decision) => decision.required === true).length
        + (session.taskState?.validationBlockers || []).length
    },
    events: []
  };
}

function createSessionService(agentSessionStore) {
  function createAgentSession(body = {}) {
    const traveler = body.traveler || {};
    const requestedSessionId = clampText(body.sessionId || "", 120);
    const existing = requestedSessionId ? agentSessionStore.getSession(requestedSessionId) : null;
    if (body.resumeOnly && (!requestedSessionId || !existing)) return null;
    const durableBaseline = existing?.transactionInvariants?.baseline || null;
    const admittedSelectedBooking = existing ? null : normalizeSelectedBooking(body.selectedBookingContract);
    if (!existing && !admittedSelectedBooking) {
      throw requestBodyError(
        "SELECTED_BOOKING_REQUIRED",
        "A complete approved flight selection is required before starting checkout.",
        422
      );
    }
    const selectedBooking = admittedSelectedBooking
      ? {
          observationId: admittedSelectedBooking.selectionId,
          sourceUrl: admittedSelectedBooking.sourceUrl,
          facts: transactionFactsFromSelectedBooking(admittedSelectedBooking)
        }
      : null;
    const selectedTravelerIds = (selectedBooking?.facts?.travelers || durableBaseline?.travelers || [])
      .map((entry) => clampText(entry?.travelerId, 120))
      .filter(Boolean);
    const requestedTravelerId = clampText(traveler.id || body.travelerId || "", 120);
    const durableTravelerId = clampText(existing?.travelerId || selectedTravelerIds[0] || "", 120);
    if (existing && requestedTravelerId && requestedTravelerId !== durableTravelerId) {
      throw requestBodyError(
        "TRAVELER_IDENTITY_MISMATCH",
        "The selected wallet traveler does not match the traveler bound to this durable checkout.",
        409
      );
    }
    if (!existing && !requestedTravelerId) {
      throw requestBodyError(
        "SELECTED_TRAVELER_REQUIRED",
        "Select at least one wallet traveler before starting checkout.",
        422
      );
    }
    if (!existing && selectedBooking && !selectedTravelerIds.includes(requestedTravelerId)) {
      throw requestBodyError(
        "TRAVELER_IDENTITY_MISMATCH",
        "The selected wallet traveler is not authorized by the selected booking contract.",
        409
      );
    }
    const primaryTravelerId = existing ? durableTravelerId : requestedTravelerId;
    const state = existing || agentSessionStore.getOrCreateSession(requestedSessionId, {
      goal: clampText(body.goal || body.userIntent || "Complete checkout safely.", 500),
      travelerId: primaryTravelerId,
      site: { host: body.page?.site || "", url: body.page?.url || "" }
    });
    let updated = withUpdate(state, {
      status: "running",
      userIntent: clampText(body.userIntent || body.goal || state.userIntent || state.goal, 800),
      travelerId: primaryTravelerId,
      travelerIds: [...new Set([...selectedTravelerIds, primaryTravelerId].filter(Boolean))],
      userPolicy: canonicalizeUserPolicy({
        bookingRules: clampText(traveler.booking_rules, 800),
        baggagePreference: clampText(traveler.baggage_preference, 120),
        paymentPreference: clampText(traveler.payment_preference, 120)
      }, traveler),
      approvals: {
        ...state.approvals,
        skipPaidExtrasApproved: Boolean(body.approvalState?.skipPaidExtrasApproved || /no paid|no extras|no add-?ons|no seat|avoid paid/i.test(traveler.booking_rules || "")),
        paymentApproved: false,
        paymentAuthorization: body.approvalState?.paymentAuthorization || state.approvals?.paymentAuthorization || null,
        legalAuthorization: body.approvalState?.legalAuthorization || state.approvals?.legalAuthorization || null,
        priceAuthorization: body.approvalState?.priceAuthorization || state.approvals?.priceAuthorization || null
      }
    });
    if (selectedBooking) {
      updated = prepareTransactionInvariants(updated, {
        observationId: selectedBooking.observationId,
        page: {
          site: body.page?.site || "",
          url: selectedBooking.sourceUrl || body.page?.url || "",
          step: "flight_selection",
          transactionFacts: selectedBooking.facts
        }
      }, traveler).state;
    }
    agentSessionStore.saveSession(updated);
    return updated;
  }

  function reportAgentResult(body = {}) {
    const checkoutState = agentSessionStore.getSession(body.sessionId);
    if (!checkoutState) return null;
    const result = body.result || {};
    const status = result.type === "final_review"
      ? "ready_for_payment"
      : result.type === "save_trip"
        ? "complete"
        : ["ask_user", "stop"].includes(result.type)
          ? "awaiting_user"
          : checkoutState.status;
    return agentSessionStore.recordActionResult(checkoutState.id, result, { status });
  }

  return { createAgentSession, reportAgentResult, summarizeAgentSession };
}

module.exports = { createSessionService, summarizeAgentSession };
