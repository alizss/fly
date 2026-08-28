const { governAction } = require("../../apps/web/agent/action-governor");
const { prepareTransactionInvariants } = require("../../apps/web/agent/invariants");
const { currentSurfaceId } = require("../../apps/web/agent/surface-contract");
const { visualRegionsMatch } = require("../../packages/shared/agent-actions");
const { compileCurrentObligation } = require("./obligation-test-helper");

function stateWithSelectedBookingBaseline(state = {}, traveler = {}, observation = {}) {
  if (state.transactionInvariants) return state;
  const travelerId = String(traveler.id || state.travelerId || state.travelerIds?.[0] || "trav_test");
  const ownerKey = "selected_booking:test_booking";
  const observed = observation.page?.transactionFacts || {};
  const observedSegments = observed.itinerary?.segments || [];
  const segments = observedSegments.length && observedSegments.every((segment) => (
    segment.origin && segment.destination && segment.departureDate
  )) ? observedSegments : [{
    segmentId: "segment_1",
    origin: "SFO",
    destination: "LHR",
    departureDate: "2026-09-18"
  }];
  const currency = String(observed.currency || observed.totalPrice?.currency || observation.page?.price?.currency || "EUR");
  const totalAmount = Number(observed.totalPrice?.amount ?? observation.page?.price?.amount ?? 100);
  const baseline = {
    evidenceMode: "typed",
    itinerary: {
      completeness: "complete",
      segments: segments.map((segment, index) => ({
        ...segment,
        segmentId: segment.segmentId || `segment_${index + 1}`,
        evidence: {
          segmentId: segment.segmentId || `segment_${index + 1}`,
          ownerKey: `${ownerKey}:segment_${index + 1}`,
          authoritative: true,
          source: "product_selected_booking"
        }
      }))
    },
    travelers: [{ travelerId }],
    currency,
    totalPrice: { amount: Number.isFinite(totalAmount) ? totalAmount : 100, currency },
    selectedExtras: [],
    factEvidence: {
      itinerary: segments.map((segment, index) => ({
        segmentId: segment.segmentId || `segment_${index + 1}`,
        ownerKey: `${ownerKey}:segment_${index + 1}`,
        authoritative: true,
        source: "product_selected_booking"
      })),
      totalPrice: { ownerKey, authoritative: true, role: "booking_total", source: "product_selected_booking" },
      travelers: { ownerKey, authoritative: true, source: "product_selected_booking" }
    },
    provenance: [{ source: "product_selected_booking", observationId: "test_booking", confidence: 1 }]
  };
  return {
    ...state,
    travelerId,
    travelerIds: [...new Set([...(state.travelerIds || []), travelerId])],
    transactionInvariants: {
      version: 5,
      baseline,
      current: baseline,
      outcomeLedger: [],
      reviewFacts: null,
      baselineAuthority: "selected_booking",
      baselineLocked: true,
      baselineStatus: "approved",
      baselineObservationId: "test_booking",
      approvedAt: new Date(0).toISOString(),
      evidence: []
    }
  };
}

function replayCandidateSet(state = {}, observation = {}, action = null) {
  let candidates = state.taskState?.currentGoal?.candidates || state.currentGoal?.candidates || [];
  if (!candidates.length) return null;
  if (action?.candidateId && candidates.some((candidate) => (
    candidate.candidateId === action.candidateId
    && candidate.type === action.type
    && candidate.operation === action.operation
    && (
      (!candidate.visualRegion && !action.visualRegion)
      || visualRegionsMatch(candidate.visualRegion || {}, action.visualRegion || {})
    )
  ))) {
    candidates = candidates.map((candidate) => candidate.candidateId === action.candidateId
      ? { ...action, targetId: candidate.targetId || action.actuatorId || "" }
      : candidate);
  }
  return {
    observationId: observation.observationId || "",
    observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
    surfaceId: currentSurfaceId(observation.page || {}),
    candidates
  };
}

// Tests that begin with a raw observation explicitly prepare the same inputs
// that production prepares before calling the pure governor.
function governObservedAction(args = {}) {
  const legacyGoal = args.state?.taskState?.currentGoal || null;
  const compatibleState = stateWithSelectedBookingBaseline(args.state || {}, args.traveler || {}, args.observation || {});
  const state = legacyGoal
    ? {
        ...compatibleState,
        taskState: {
          ...compatibleState.taskState,
          currentObligation: compileCurrentObligation({ work: legacyGoal })
        }
      }
    : compatibleState;
  const preparedInvariantContext = args.preparedInvariantContext
    || prepareTransactionInvariants(state || {}, args.observation || {}, args.traveler || {});
  return governAction({
    ...args,
    state,
    preparedInvariantContext,
    preparedCandidateSet: args.preparedCandidateSet || replayCandidateSet(args.state, args.observation, args.action)
  });
}

module.exports = { governObservedAction, stateWithSelectedBookingBaseline };
