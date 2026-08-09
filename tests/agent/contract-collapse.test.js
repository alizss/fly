const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { toClientDecision } = require("../../apps/web/agent/loop");
const { normalizeAction } = require("../../packages/shared/agent-actions");
const { currentObligationFromGoal } = require("../../apps/web/agent/authority-frames");
const {
  normalizeSemanticOwner,
  semanticOwnerId
} = require("../../packages/shared/semantic-owner");
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
    obligationId: "obligation_1",
    decisionInstanceId: "owner_1",
    candidateId: "candidate_1",
    controlId: "control_1",
    actuatorId: "actuator_1",
    operation: "activate",
    interactionMethod: "trusted",
    semanticEffect: "advance_checkout_stage",
    expectedOutcome: { type: "checkout_stage_advanced" },
    risk: "safe",
    reason: "Continue"
  });

  assert.equal(decision.controlId, undefined);
  assert.equal(decision.operation, undefined);
  const transported = JSON.parse(JSON.stringify(decision));
  assert.equal(transported.controlId, undefined);
  assert.equal(transported.operation, undefined);
  assert.equal(transported.actionLease.contractVersion, "action-lease/v1");
  assert.deepEqual(transported.actionLease.target, {
    controlId: "control_1",
    actuatorId: "actuator_1",
    surfaceId: "",
    snapshot: null
  });
});

test("legacy action aliases migrate once and never enter the canonical ActionDraft", () => {
  const action = normalizeAction({
    type: "click",
    semanticIntent: "advance_checkout_stage",
    physicalEffect: "advance_checkout_stage",
    goalId: "legacy_goal",
    targetId: "legacy_actuator",
    semanticOwner: {
      stage: "bags",
      family: "baggage",
      subjectId: "checked_bags",
      passengerId: "traveler_1",
      segmentId: "outbound",
      repeatedInstance: "bag_decision"
    },
    risk: "safe"
  });

  assert.equal(action.intent, "advance_checkout_stage");
  assert.equal(action.mechanicalEffect, "advance_checkout_stage");
  assert.equal(action.obligationId, "legacy_goal");
  assert.equal(action.actuatorId, "legacy_actuator");
  for (const alias of ["semanticIntent", "physicalEffect", "goalId", "targetId"]) {
    assert.equal(Object.prototype.hasOwnProperty.call(action, alias), false);
  }
});

test("semantic owner identity is structured and stable across fresh actuator identities", () => {
  const owner = normalizeSemanticOwner({
    stage: "Seats",
    family: "seat",
    subjectId: "seat_selection",
    passengerId: "traveler_1",
    segmentId: "outbound",
    repeatedInstance: "seat-decision-1"
  });
  const identity = semanticOwnerId(owner);

  assert.equal(identity, semanticOwnerId({ ...owner }));
  assert.match(identity, /^owner:seats:seat:seat_selection:traveler_1:outbound:/);
  assert.notEqual(identity, semanticOwnerId({ ...owner, segmentId: "return" }));
});

test("CurrentObligation and ActionLease carry the same semantic owner identity", () => {
  const obligation = currentObligationFromGoal({
    goal: {
      goalId: "profile:phone_country_code:0",
      kind: "profile_field",
      stage: "traveler_information",
      family: "profile",
      semanticType: "phone_country_code",
      subjectId: "traveler_1",
      passengerId: "traveler_1",
      logicalFieldId: "contact_phone",
      componentRole: "country_code",
      desiredValue: "+386",
      controlId: "country_code",
      candidateControlIds: ["country_code"],
      postcondition: { type: "logical_component_committed" }
    }
  });
  const decision = toClientDecision({
    id: "action_country_code",
    type: "select",
    observationId: "obs_country_code",
    observationHash: "hash_country_code",
    obligationId: obligation.obligationId,
    semanticOwner: obligation.semanticOwner,
    semanticOwnerId: obligation.semanticOwnerId,
    candidateId: "candidate_country_code",
    controlId: "country_code",
    actuatorId: "option_slovenia",
    operation: "choose",
    semanticEffect: "set_field_value",
    expectedOutcome: obligation.successCondition,
    risk: "safe"
  });

  assert.equal(decision.actionLease.semanticOwnerId, obligation.semanticOwnerId);
  assert.deepEqual(decision.actionLease.semanticOwner, obligation.semanticOwner);
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

test("production import graph exposes one mechanics binder and one ambiguity boundary", () => {
  const root = path.resolve(__dirname, "../../apps/web/agent");
  const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
  const loop = read("loop.js");
  const grounding = read("active-component-grounding.js");
  const binder = read("mechanics-binder.js");
  const retired = [
    "current-candidate-builder",
    "skill-expander",
    "bindingGoalFromObligation",
    "obligationBindings",
    "taskBindingGoal",
    "bindingResume",
    "mechanicContract"
  ];

  assert.match(loop, /require\("\.\/mechanics-binder"\)/);
  assert.match(loop, /require\("\.\/ambiguity-resolver"\)/);
  assert.doesNotMatch(loop, /require\("\.\/(?:select-candidate|active-component-grounding)"\)/);
  assert.match(grounding, /require\("\.\/interaction-view"\)/);
  assert.doesNotMatch(grounding, /require\("\.\/select-candidate"\)/);
  assert.match(binder, /function bindMechanics/);
  for (const token of retired) {
    assert.equal(fs.existsSync(path.join(root, `${token}.js`)), false);
  }
});
