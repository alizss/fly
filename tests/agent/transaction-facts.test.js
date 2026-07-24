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

test("an inflated starting total is evidence, never approval for an existing paid optional item", () => {
  const raw = facts({ totalPrice: 237 });
  raw.selectedExtras = [{
    decisionGroupId: "dg_bundle",
    label: "Selected bundle",
    disposition: "paid",
    priceAmount: 29,
    currency: "EUR"
  }];
  const baseline = normalizeFacts(raw);
  const observed = normalizeFacts(raw);
  const advance = {
    type: "click",
    intent: "navigate_stage",
    risk: "safe",
    affordance: { physicalEffect: "advance_checkout_stage" }
  };

  const unapproved = invariantDecision({ baseline, observed }, advance, {
    approvals: {
      // A total-price authorization does not approve the item already inside
      // that total.
      priceAuthorization: { authorizationId: "price_auth", maximumAmount: 300 }
    },
    paymentState: {}
  });
  assert.equal(unapproved.allow, false);
  assert.equal(unapproved.code, "UNAPPROVED_SELECTED_EXTRA");

  const approved = invariantDecision({ baseline, observed }, advance, {
    approvals: {
      paidExtraAuthorizations: [{ authorizationId: "extra_auth", decisionGroupId: "dg_bundle" }]
    },
    paymentState: {}
  });
  assert.equal(approved.allow, true);
});

test("price evidence allows reconciliation while selected-extra policy still blocks navigation", () => {
  const baseline = normalizeFacts(facts({ totalPrice: 200 }));
  const currentRaw = facts({ totalPrice: 229 });
  currentRaw.selectedExtras = [{
    decisionGroupId: "dg_bundle",
    label: "All passengers",
    disposition: "paid",
    priceAmount: 29,
    currency: "EUR"
  }];
  const observed = normalizeFacts(currentRaw);
  const state = {
    approvals: {},
    paymentState: {},
    taskState: {
      currentGoal: { goalId: "goal_bundle", decisionGroupId: "dg_bundle", desiredPolicyOutcome: "selected_free_option" },
      activeDecisions: [{
        decisionGroupId: "dg_bundle",
        status: "conflicted",
        reopenEvidence: {
          code: "EXACT_SELECTED_OPTION_PRICE_EXCEEDS_POLICY",
          structuredPrice: { amount: 29, currency: "EUR" }
        }
      }]
    }
  };
  const correction = {
    type: "click",
    intent: "decline_optional_extra",
    semanticIntent: "remove_paid_extra",
    mechanicalEffect: "select_free_option",
    controlId: "ctrl_bundle_free",
    decisionGroupId: "dg_bundle",
    targetSnapshot: {
      controlId: "ctrl_bundle_free",
      decisionGroupId: "dg_bundle",
      semantic: "decline_paid_extra",
      risk: "safe_decline"
    },
    expectedOutcome: {
      type: "exact_free_option_selected",
      decisionGroupId: "dg_bundle",
      controlId: "ctrl_bundle_free",
      expectedSelectedControlId: "ctrl_bundle_free",
      prohibitPaidAlternative: true,
      mustNotIncreasePrice: true
    },
    affordance: { physicalEffect: "select_free_option", structuredPrice: { amount: 0, currency: "EUR" } }
  };

  const allowedCorrection = invariantDecision({ baseline, observed }, correction, state);
  assert.equal(allowedCorrection.allow, true);
  assert.equal(allowedCorrection.checks.some((check) => check.code === "ELEVATED_PRICE_EXACT_CORRECTION"), true);

  const openExactSelector = invariantDecision({ baseline, observed }, {
    type: "click",
    intent: "open_choice_control",
    semanticIntent: "open_dropdown",
    mechanicalEffect: "open_surface",
    controlId: "ctrl_bundle_selector",
    decisionGroupId: "dg_bundle",
    targetSnapshot: {
      controlId: "ctrl_bundle_selector",
      decisionGroupId: "dg_bundle",
      semantic: "open_choice_control",
      risk: "safe"
    },
    expectedOutcome: {
      type: "options_surface_appeared",
      decisionGroupId: "dg_bundle",
      controlId: "ctrl_bundle_selector"
    },
    affordance: { physicalEffect: "open_surface" }
  }, state);
  assert.equal(openExactSelector.allow, true);
  assert.equal(openExactSelector.checks.some((check) => check.code === "ELEVATED_PRICE_EXACT_CORRECTION"), true);

  const navigation = invariantDecision({ baseline, observed }, {
    type: "click",
    intent: "navigate_stage",
    mechanicalEffect: "advance_checkout_stage",
    risk: "safe"
  }, state);
  assert.equal(navigation.allow, false);
  assert.equal(navigation.code, "UNAPPROVED_SELECTED_EXTRA");
  assert.equal(navigation.checks.some((check) => check.code === "PRICE_CHANGE_REQUIRES_RECONCILIATION_NOT_APPROVAL"), true);

  const unrelatedCorrection = invariantDecision({ baseline, observed }, {
    ...correction,
    decisionGroupId: "dg_other",
    targetSnapshot: { ...correction.targetSnapshot, decisionGroupId: "dg_other" },
    expectedOutcome: { ...correction.expectedOutcome, decisionGroupId: "dg_other" }
  }, state);
  assert.equal(unrelatedCorrection.allow, true);
  assert.equal(unrelatedCorrection.checks.some((check) => check.code === "PRICE_CHANGE_REQUIRES_RECONCILIATION_NOT_APPROVAL"), true);
});

test("unapproved selected extra is recoverable when its exact current-surface reversal is grounded", () => {
  const baseline = normalizeFacts(facts({ totalPrice: 200 }));
  const currentRaw = facts({ totalPrice: 223 });
  currentRaw.selectedExtras = [{
    decisionGroupId: "dg_current_paid_item",
    label: "Current paid item",
    disposition: "paid",
    priceAmount: 23,
    currency: "EUR"
  }];
  const observed = normalizeFacts(currentRaw);
  const observation = {
    observationId: "obs_grounded_reversal",
    page: {
      currentSurface: {
        id: "current_modal",
        type: "modal",
        memberControlIds: ["ctrl_reverse_paid"]
      },
      controls: [{
        controlId: "ctrl_reverse_paid",
        decisionGroupId: "dg_current_paid_item",
        surfaceId: "current_modal",
        semantic: "remove_paid_extra",
        physicalEffect: "select_free_option",
        risk: "safe_decline",
        operations: {
          activate: {
            actionability: { executable: true, revealable: false }
          }
        }
      }],
      decisionGroups: [{
        decisionGroupId: "dg_current_paid_item",
        surfaceId: "current_modal",
        removalControlId: "ctrl_reverse_paid",
        alternativeControlIds: ["ctrl_reverse_paid"]
      }]
    }
  };
  const result = invariantDecision({ baseline, observed, observation }, {
    type: "click",
    intent: "navigate_stage",
    mechanicalEffect: "advance_checkout_stage",
    risk: "safe"
  }, { approvals: {}, paymentState: {} });

  assert.equal(result.allow, false);
  assert.equal(result.code, "UNAPPROVED_SELECTED_EXTRA");
  assert.equal(result.decision, "recoverable");
  assert.equal(result.details.recoveryDirective, "reconcile_selected_extra");
  assert.deepEqual(result.details.groundedReversal, {
    decisionGroupId: "dg_current_paid_item",
    controlId: "ctrl_reverse_paid",
    effect: "select_free_option"
  });
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
