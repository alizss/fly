const { prepareTransactionInvariants } = require("./invariants");
const { canonicalizeUserPolicy } = require("./policy-profile");
const { withUpdate } = require("../../../packages/shared/agent-state");
const {
  normalizeSelectedBooking,
  transactionFactsFromSelectedBooking
} = require("../../../packages/shared/selected-booking");
const {
  createCheckoutMandate,
  normalizeCheckoutMandate
} = require("../../../packages/shared/checkout-mandate");
const { requestBodyError } = require("../http/body");
const {
  executionEpisodeFor,
  leasedActionFor,
  stateWithExecutionEpisode
} = require("./execution-episode");

const NAVIGATION_EPISODE_TIMEOUT_MS = 2 * 60 * 1000;

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
  function navigationEpisodeSummary(state = {}) {
    const episode = executionEpisodeFor(state);
    const lease = episode.leasedAction?.actionLease || null;
    if (!episode.navigationEpisodeId || !episode.actionId || !lease) return null;
    return {
      episodeId: episode.navigationEpisodeId,
      sessionId: state.id,
      travelerId: state.travelerId,
      actionId: episode.actionId,
      observationId: episode.observationId || lease.observation?.id || "",
      observationHash: lease.observation?.hash || "",
      obligationId: episode.obligationId || lease.obligationId || "",
      status: episode.navigationStatus || "",
      sourceDocument: episode.sourceDocument || null,
      destinationDocument: episode.destinationDocument || null,
      expectedPostcondition: episode.expectedPostcondition || lease.expected?.successCondition || null,
      currentObjective: lease.expected?.objective || "reach_actual_payment_entry",
      deadlineAt: Number(episode.deadlineAt || 0)
    };
  }

  function armNavigationEpisode(body = {}) {
    const sessionId = clampText(body.sessionId || "", 120);
    const actionId = clampText(body.actionId || "", 160);
    const state = agentSessionStore.getSession(sessionId);
    if (!state || !actionId) return null;
    const current = executionEpisodeFor(state);
    const lease = leasedActionFor(state)?.actionLease || null;
    if (!lease?.actionId || lease.actionId !== actionId) {
      throw requestBodyError(
        "NAVIGATION_ACTION_MISMATCH",
        "The navigation action is not the currently leased durable action.",
        409
      );
    }
    const now = Date.now();
    const navigationEpisodeId = `navigation:${sessionId}:${actionId}`;
    const updated = stateWithExecutionEpisode(state, {
      ...current,
      actionId,
      observationId: clampText(body.observationId || lease.observation?.id || current.observationId || "", 160),
      obligationId: clampText(lease.obligationId || current.obligationId || "", 200),
      navigation: true,
      navigationEpisodeId,
      navigationStatus: "ARMED",
      status: "navigation_armed",
      approved: true,
      dispatched: false,
      observed: false,
      verified: false,
      closed: false,
      awaitingClarification: false,
      awaitingDestination: true,
      sourceDocument: {
        documentId: clampText(body.sourceDocumentId || "", 180),
        url: clampText(body.sourceUrl || "", 800),
        origin: clampText(body.sourceOrigin || "", 240),
        armedAt: now
      },
      destinationDocument: null,
      destinationObservation: null,
      expectedPostcondition: lease.expected?.successCondition || body.expectedPostcondition || null,
      deadlineAt: now + NAVIGATION_EPISODE_TIMEOUT_MS,
      updatedAt: new Date(now).toISOString()
    });
    agentSessionStore.saveSession(updated);
    agentSessionStore.recordActionEvent?.(sessionId, {
      actionId,
      observationId: updated.executionEpisode.observationId,
      stage: "navigation_armed",
      navigationEpisodeId
    });
    return navigationEpisodeSummary(updated);
  }

  function claimNavigationEpisode(body = {}) {
    const sessionId = clampText(body.sessionId || "", 120);
    const episodeId = clampText(body.episodeId || "", 320);
    const state = agentSessionStore.getSession(sessionId);
    if (!state) return null;
    const current = executionEpisodeFor(state);
    const actionId = clampText(body.actionId || "", 160);
    if (!current.navigationEpisodeId
      || current.navigationEpisodeId !== episodeId
      || (actionId && current.actionId !== actionId)
      || current.closed === true
      || Date.now() > Number(current.deadlineAt || 0)) return null;
    if (current.destinationDocument) {
      const requestedDocumentId = clampText(body.destinationDocumentId || "", 180);
      const requestedTabContextId = clampText(body.tabContextId || "", 80);
      const requestedUrl = clampText(body.destinationUrl || "", 800);
      const sameDocument = Boolean(
        requestedDocumentId
        && current.destinationDocument.documentId
        && requestedDocumentId === current.destinationDocument.documentId
      );
      const sameFallbackDestination = Boolean(
        !requestedDocumentId
        && !current.destinationDocument.documentId
        && requestedTabContextId
        && requestedTabContextId === current.destinationDocument.tabContextId
        && (!requestedUrl || requestedUrl === current.destinationDocument.url)
      );
      // A lost HTTP acknowledgement may retry from the exact destination.
      if (sameDocument || sameFallbackDestination) return navigationEpisodeSummary(state);

      const redirectContinuation = Boolean(
        ["DESTINATION_CLAIMED", "DESTINATION_READY"].includes(current.navigationStatus)
        && requestedDocumentId
        && requestedTabContextId
        && requestedTabContextId === current.destinationDocument.tabContextId
        && requestedDocumentId !== current.destinationDocument.documentId
        && (
          current.navigationStatus === "DESTINATION_CLAIMED"
          || body.redirectContinuation === true
        )
      );
      if (!redirectContinuation) return null;

      // Browser navigation can commit one or more short-lived handoff
      // documents before the stable checkout/provider document. Ownership may
      // move forward in the same routed tab while claimed; after readiness it
      // may move only when the browser route proves the next commit is an
      // actual client/server redirect continuation.
      const now = Date.now();
      const destinationDocument = {
        documentId: requestedDocumentId,
        tabContextId: requestedTabContextId,
        url: requestedUrl,
        origin: clampText(body.destinationOrigin || "", 240),
        claimedAt: now
      };
      const updated = stateWithExecutionEpisode(state, {
        ...current,
        status: "destination_claimed",
        navigationStatus: "DESTINATION_CLAIMED",
        observed: false,
        destinationDocument,
        destinationObservation: null,
        destinationClaimHistory: [
          ...(Array.isArray(current.destinationClaimHistory) ? current.destinationClaimHistory : []),
          current.destinationDocument
        ].slice(-8),
        updatedAt: new Date(now).toISOString()
      });
      agentSessionStore.saveSession(updated);
      agentSessionStore.recordActionEvent?.(sessionId, {
        actionId: current.actionId,
        observationId: current.observationId,
        stage: "destination_redirect_claimed",
        navigationEpisodeId: episodeId,
        destinationDocument
      });
      return navigationEpisodeSummary(updated);
    }
    const now = Date.now();
    const destinationDocument = {
      documentId: clampText(body.destinationDocumentId || "", 180),
      tabContextId: clampText(body.tabContextId || "", 80),
      url: clampText(body.destinationUrl || "", 800),
      origin: clampText(body.destinationOrigin || "", 240),
      claimedAt: now
    };
    const updated = stateWithExecutionEpisode(state, {
      ...current,
      status: "destination_claimed",
      navigationStatus: "DESTINATION_CLAIMED",
      dispatched: true,
      awaitingDestination: true,
      destinationDocument,
      updatedAt: new Date(now).toISOString()
    });
    agentSessionStore.saveSession(updated);
    agentSessionStore.recordActionEvent?.(sessionId, {
      actionId: current.actionId,
      observationId: current.observationId,
      stage: "destination_claimed",
      navigationEpisodeId: episodeId,
      destinationDocument
    });
    return navigationEpisodeSummary(updated);
  }

  function readyNavigationEpisode(body = {}) {
    const sessionId = clampText(body.sessionId || "", 120);
    const episodeId = clampText(body.episodeId || "", 320);
    const state = agentSessionStore.getSession(sessionId);
    if (!state) return null;
    const current = executionEpisodeFor(state);
    const actionId = clampText(body.actionId || "", 160);
    if (!current.navigationEpisodeId
      || current.navigationEpisodeId !== episodeId
      || (actionId && current.actionId !== actionId)
      || current.closed === true) return null;
    const destinationDocumentId = clampText(body.destinationDocumentId || "", 180);
    const tabContextId = clampText(body.tabContextId || "", 80);
    if (!current.destinationDocument
      || !destinationDocumentId
      || destinationDocumentId !== current.destinationDocument.documentId
      || (tabContextId && tabContextId !== current.destinationDocument.tabContextId)) return null;
    const updated = stateWithExecutionEpisode(state, {
      ...current,
      status: "destination_ready",
      navigationStatus: "DESTINATION_READY",
      dispatched: true,
      observed: true,
      awaitingDestination: true,
      destinationObservation: {
        observationId: clampText(body.observationId || "", 180),
        observationHash: clampText(body.observationHash || "", 180),
        url: clampText(body.destinationUrl || current.destinationDocument?.url || "", 800),
        readyAt: Date.now()
      },
      updatedAt: new Date().toISOString()
    });
    agentSessionStore.saveSession(updated);
    return navigationEpisodeSummary(updated);
  }

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
    const checkoutMandate = existing
      ? normalizeCheckoutMandate(existing.checkoutMandate)
      : createCheckoutMandate(admittedSelectedBooking);
    if (!existing && !checkoutMandate) {
      throw requestBodyError(
        "CHECKOUT_MANDATE_REQUIRED",
        "The selected booking could not create the autonomous checkout mandate.",
        422
      );
    }
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
      checkoutMandate: checkoutMandate || state.checkoutMandate || null,
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

  return {
    armNavigationEpisode,
    claimNavigationEpisode,
    createAgentSession,
    navigationEpisodeSummary,
    readyNavigationEpisode,
    reportAgentResult,
    summarizeAgentSession
  };
}

module.exports = { createSessionService, summarizeAgentSession };
