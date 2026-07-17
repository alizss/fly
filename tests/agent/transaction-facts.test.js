const test = require("node:test");
const assert = require("node:assert/strict");

const { createCheckoutSessionState } = require("../../packages/shared/agent-state");
const { governAction } = require("../../apps/web/agent/action-governor");
const { factsFromObservation, normalizeFacts } = require("../../apps/web/agent/transaction-facts");
const { explicitItineraryConflict, invariantDecision, prepareTransactionInvariants } = require("../../apps/web/agent/invariants");

function facts({
  completeness = "complete",
  origin = "LHR",
  destination = "LJU",
  departureDate = "2026-08-10",
  departureTime = "10:20",
  arrivalTime = "13:30",
  flightNumber = "BA690",
  travelerId = "trav_1",
  currency = "EUR",
  totalPrice = 208
} = {}) {
  return {
    itinerary: {
      completeness,
      segments: origin || destination ? [{
        segmentId: "segment_1",
        origin,
        destination,
        departureDate,
        departureTime,
        arrivalTime,
        flightNumber
      }] : []
    },
    travelers: travelerId ? [{ travelerId, name: "Alex Example" }] : [],
    currency,
    basePrice: { amount: 180, currency },
    totalPrice: { amount: totalPrice, currency },
    fareBrand: "Economy Light",
    selectedExtras: [{ decisionGroupId: "dg_bag", label: "No checked baggage", disposition: "decline", priceAmount: 0, currency }],
    provenance: [{ source: "travel_details", observationId: "", confidence: 0.9 }]
  };
}

function observation(id, transactionFacts = null) {
  return {
    observationId: id,
    observationSnapshot: { snapshotHash: `hash_${id}` },
    page: {
      step: "extras",
      transactionFacts
    }
  };
}

test("P0.5 normalizes structured transaction facts without visible-text fingerprints", () => {
  const state = createCheckoutSessionState({ travelerId: "trav_1" });
  const observed = factsFromObservation(state, observation("obs_structured", facts()), { id: "trav_1" });

  assert.equal(observed.itinerary.completeness, "complete");
  assert.deepEqual(observed.itinerary.segments[0], {
    segmentId: "segment_1",
    origin: "LHR",
    destination: "LJU",
    departureDate: "2026-08-10",
    departureTime: "10:20",
    arrivalTime: "13:30",
    flightNumber: "BA690"
  });
  assert.equal(observed.travelers[0].travelerId, "trav_1");
  assert.equal(observed.currency, "EUR");
  assert.equal(observed.totalPrice.amount, 208);
  assert.equal(Object.hasOwn(observed, "itineraryFingerprint"), false);
});

test("P0.5 immutable baseline treats absence and matching partial itinerary evidence as stable", () => {
  let state = createCheckoutSessionState({ travelerId: "trav_1" });
  state.id = "txn_partial_stable";
  const partial = facts({ completeness: "partial", departureDate: "", departureTime: "", arrivalTime: "", flightNumber: "" });
  const first = prepareTransactionInvariants(state, observation("obs_partial", partial), { id: "trav_1" });
  state = first.state;
  const immutableBaseline = JSON.parse(JSON.stringify(first.baseline));

  const absent = prepareTransactionInvariants(state, observation("obs_absent", null), { id: "trav_1" });
  const absentDecision = invariantDecision(absent, { type: "wait", risk: "safe" }, absent.state);
  assert.equal(absentDecision.allow, true);
  assert.deepEqual(absent.envelope.baseline, immutableBaseline);

  const complete = prepareTransactionInvariants(absent.state, observation("obs_complete", facts()), { id: "trav_1" });
  const completeDecision = invariantDecision(complete, { type: "wait", risk: "safe" }, complete.state);
  assert.equal(completeDecision.allow, true);
  assert.deepEqual(complete.envelope.baseline, immutableBaseline);
  assert.equal(complete.envelope.evidence.length, 3);
  assert.equal(complete.envelope.evidence.at(-1).facts.itinerary.completeness, "complete");
});

test("P0.5 blocks only explicit route, date, traveler, and currency contradictions", () => {
  const baseline = normalizeFacts(facts());
  const cases = [
    [facts({ destination: "CDG" }), "ITINERARY_ROUTE_CHANGED"],
    [facts({ departureDate: "2026-08-11" }), "ITINERARY_DATE_CHANGED"],
    [facts({ travelerId: "trav_2" }), "TRAVELER_SET_CHANGED"],
    [facts({ currency: "USD" }), "CURRENCY_CHANGED"]
  ];

  for (const [rawObserved, code] of cases) {
    const observed = normalizeFacts(rawObserved);
    const decision = invariantDecision({ baseline, observed }, { type: "wait", risk: "safe" }, { approvals: {}, paymentState: {} });
    assert.equal(decision.allow, false, code);
    assert.equal(decision.code, code);
  }

  const unrelatedPartial = normalizeFacts(facts({
    completeness: "partial",
    origin: "CDG",
    destination: "FCO",
    departureDate: "",
    flightNumber: ""
  }));
  assert.equal(explicitItineraryConflict(baseline, unrelatedPartial), null);
  assert.equal(invariantDecision({ baseline, observed: unrelatedPartial }, { type: "wait" }, { approvals: {}, paymentState: {} }).allow, true);
});

test("P0.5 records later facts as evidence without silently completing an unknown baseline", () => {
  let state = createCheckoutSessionState({ travelerId: "trav_1" });
  state.id = "txn_unknown_baseline";
  const unknown = prepareTransactionInvariants(state, observation("obs_unknown", null), { id: "trav_1" });
  const completed = prepareTransactionInvariants(unknown.state, observation("obs_later_complete", facts()), { id: "trav_1" });

  assert.equal(completed.envelope.baseline.itinerary.completeness, "unknown");
  assert.equal(completed.envelope.baseline.itinerary.segments.length, 0);
  assert.equal(completed.envelope.evidence.at(-1).facts.itinerary.completeness, "complete");
  assert.equal(completed.envelope.evidence.at(-1).facts.itinerary.segments[0].origin, "LHR");
});

test("P0.5 governor consumes the invariant decision instead of constructing transaction truth", () => {
  let state = createCheckoutSessionState({ travelerId: "trav_1" });
  state.id = "txn_governed_facts";
  state = prepareTransactionInvariants(state, observation("obs_baseline", facts()), { id: "trav_1" }).state;
  const conflicting = observation("obs_conflict", facts({ destination: "CDG" }));
  const result = governAction({
    action: {
      id: "act_wait_conflict",
      observationId: conflicting.observationId,
      observationHash: conflicting.observationSnapshot.snapshotHash,
      type: "wait",
      intent: "reobserve",
      risk: "safe",
      requiresApproval: false
    },
    state,
    observation: conflicting,
    traveler: { id: "trav_1" },
    store: {
      isCurrentObservation: (transactionId, observationId, observationHash) => (
        transactionId === state.id
        && observationId === conflicting.observationId
        && observationHash === conflicting.observationSnapshot.snapshotHash
      ),
      recordActionEvent() {}
    }
  });

  assert.equal(result.allow, false);
  assert.equal(result.code, "ITINERARY_ROUTE_CHANGED");
  assert.equal(result.state.transactionInvariants.baseline.itinerary.segments[0].destination, "LJU");
  assert.equal(result.state.transactionInvariants.evidence.at(-1).facts.itinerary.segments[0].destination, "CDG");
});
