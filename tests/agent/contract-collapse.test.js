const test = require("node:test");
const assert = require("node:assert/strict");

const { toClientDecision } = require("../../apps/web/agent/loop");
const {
  normalizeSelectedBooking,
  transactionFactsFromSelectedBooking
} = require("../../packages/shared/selected-booking");

test("ActionLease is the sole enumerable execution contract at the HTTP boundary", () => {
  const decision = toClientDecision({
    id: "act_1",
    type: "click",
    observationId: "obs_1",
    observationHash: "hash_1",
    goalId: "obligation_1",
    decisionInstanceId: "owner_1",
    candidateId: "candidate_1",
    controlId: "control_1",
    targetId: "actuator_1",
    operation: "activate",
    interactionMethod: "trusted",
    semanticEffect: "advance_checkout_stage",
    expectedOutcome: { type: "checkout_stage_advanced" },
    risk: "safe",
    reason: "Continue"
  });

  // In-process legacy readers still work during the boundary migration.
  assert.equal(decision.controlId, "control_1");
  assert.equal(decision.operation, "activate");
  const transported = JSON.parse(JSON.stringify(decision));
  assert.equal(transported.controlId, undefined);
  assert.equal(transported.operation, undefined);
  assert.equal(transported.actionLease.contractVersion, "action-lease/v1");
  assert.deepEqual(transported.actionLease.target, {
    controlId: "control_1",
    actuatorId: "actuator_1",
    surfaceId: "",
    decisionGroupId: "",
    snapshot: null
  });
});

test("selected booking contract creates an immutable authoritative baseline before checkout", () => {
  const booking = normalizeSelectedBooking({
    contractVersion: "selected-booking/v1",
    selectionId: "selection_123",
    selectedAt: "2026-08-08T12:00:00.000Z",
    itinerary: {
      segments: [{
        segmentId: "outbound",
        origin: "LJU",
        destination: "LGW",
        departureDate: "2026-10-15",
        carrier: "U2",
        flightNumber: "1234"
      }]
    },
    approvedTotal: { amount: 355.49, currency: "eur" },
    fareBrand: "Standard",
    travelerIds: ["traveler_1"]
  });
  const facts = transactionFactsFromSelectedBooking(booking);

  assert.equal(facts.evidenceMode, "typed");
  assert.equal(facts.itinerary.completeness, "complete");
  assert.equal(facts.totalPrice.amount, 355.49);
  assert.equal(facts.totalPrice.currency, "EUR");
  assert.equal(facts.factEvidence.totalPrice.authoritative, true);
  assert.equal(facts.factEvidence.totalPrice.role, "booking_total");
  assert.equal(normalizeSelectedBooking({ contractVersion: "selected-booking/v1" }), null);
});
