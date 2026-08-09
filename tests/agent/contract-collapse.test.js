const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { toClientDecision } = require("../../apps/web/agent/loop");
const { actionFromLease, normalizeAction } = require("../../packages/shared/agent-actions");
const { currentObligationFromGoal } = require("../../apps/web/agent/authority-frames");
const { leasedActionRecord } = require("../../apps/web/agent/action-lifecycle");
const { normalizeExecutionEpisode } = require("../../apps/web/agent/execution-episode");
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
    surfaceId: ""
  });
  assert.equal(transported.actionLease.expected.intent, undefined);
  assert.equal(transported.actionLease.expected.objective, "");
  assert.equal(transported.actionLease.expected.interactionRole, undefined);
  assert.equal(transported.actionLease.expected.evidence, undefined);
  assert.equal(transported.actionLease.expected.postconditions, undefined);
  assert.deepEqual(Object.keys(transported.actionLease.target).sort(), ["actuatorId", "controlId", "surfaceId"]);
  assert.deepEqual(Object.keys(transported.actionLease.expected).sort(), [
    "objective",
    "policyAuthorization",
    "semanticEffect",
    "successCondition"
  ]);
});

test("ActionLease hydration does not recreate a transported target snapshot or semantic aliases", () => {
  const decision = toClientDecision({
    id: "act_compact",
    type: "click",
    observationId: "obs_compact",
    observationHash: "hash_compact",
    obligationId: "obligation_compact",
    controlId: "control_compact",
    actuatorId: "actuator_compact",
    targetSnapshot: {
      controlId: "control_compact",
      decisionGroupId: "legacy_group",
      label: "large duplicated snapshot"
    },
    intent: "advance_surface",
    operation: "activate",
    mechanicalEffect: "advance_surface",
    semanticEffect: "advance_checkout_stage",
    expectedOutcome: { type: "checkout_stage_advanced" },
    risk: "safe"
  });
  const hydrated = actionFromLease(decision.actionLease);

  assert.equal(decision.actionLease.target.snapshot, undefined);
  assert.equal(hydrated.targetSnapshot, null);
  assert.equal(hydrated.decisionGroupId, "");
  assert.equal(hydrated.intent, "advance_surface");
  assert.equal(hydrated.mechanicalEffect, "advance_surface");
  assert.equal(hydrated.semanticEffect, "advance_checkout_stage");
});

test("durable leased action stores one ActionLease plus mechanical recovery identity", () => {
  const record = leasedActionRecord({
    action: {
      id: "act_lease",
      type: "click",
      observationId: "obs_lease",
      observationHash: "hash_lease",
      obligationId: "obligation_lease",
      candidateId: "candidate_lease",
      controlId: "control_lease",
      actuatorId: "actuator_lease",
      operation: "activate",
      risk: "safe"
    },
    candidate: {
      candidateId: "candidate_lease",
      controlId: "control_lease",
      targetId: "actuator_lease",
      operation: "activate"
    }
  });

  for (const duplicate of [
    "obligationId",
    "candidateId",
    "candidateStableKey",
    "capability",
    "expectedOutcome",
    "sourceObservationId",
    "sourceObservationHash"
  ]) {
    assert.equal(Object.prototype.hasOwnProperty.call(record, duplicate), false);
  }
  assert.equal(record.actionLease.obligationId, "obligation_lease");
  assert.equal(record.actionLease.candidateId, "candidate_lease");
  assert.equal(record.candidateIdentity.decisionGroupId, undefined);
  assert.equal(record.candidateIdentity.semanticGoal, undefined);
});

test("execution episode migrates legacy decision identity into semanticOwnerId once", () => {
  const episode = normalizeExecutionEpisode({
    decisionInstanceId: "legacy_decision_instance",
    status: "failed"
  });
  assert.equal(episode.semanticOwnerId, "legacy_decision_instance");
  assert.equal(Object.prototype.hasOwnProperty.call(episode, "decisionInstanceId"), false);
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
  assert.equal(normalizeSelectedBooking({
    contractVersion: "selected-booking/v1",
    selectionId: "selection_without_travelers",
    itinerary: { segments: [{ origin: "LJU", destination: "LGW", departureDate: "2026-10-15" }] },
    approvedTotal: { amount: 355.49, currency: "EUR" },
    travelerIds: []
  }), null);
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

test("non-boundary internal contract versions are absent", () => {
  const root = path.resolve(__dirname, "../../apps/web/agent");
  const invariants = fs.readFileSync(path.join(root, "invariants.js"), "utf8");
  const executionEpisode = fs.readFileSync(path.join(root, "execution-episode.js"), "utf8");
  const lifecycle = fs.readFileSync(path.join(root, "action-lifecycle.js"), "utf8");

  assert.doesNotMatch(invariants, /transaction-review\/v1/);
  assert.match(executionEpisode, /decisionInstanceId: legacyDecisionInstanceId/);
  assert.doesNotMatch(executionEpisode, /"decisionInstanceId"/);
  assert.doesNotMatch(lifecycle, /next\.decisionInstanceId|previous\.decisionInstanceId/);
});

test("observation transport sends one latest result and loop failures stay typed", () => {
  const root = path.resolve(__dirname, "../..");
  const server = fs.readFileSync(path.join(root, "apps/web/server.js"), "utf8");
  const loop = fs.readFileSync(path.join(root, "apps/web/agent/loop.js"), "utf8");
  const content = fs.readFileSync(path.join(root, "apps/extension/src/content/runtime.js"), "utf8");
  const observationPayload = content.slice(
    content.indexOf("const observationPayload = {"),
    content.indexOf("const transport = await postObservationWithSizeRecovery")
  );

  assert.doesNotMatch(server, /actionHistory/);
  assert.doesNotMatch(loop, /actionHistory/);
  assert.doesNotMatch(observationPayload, /actionHistory/);
  assert.match(observationPayload, /lastActionResult: lastActionForTransport/);
  assert.match(server, /throw failure/);
  assert.match(server, /error\.code === "AGENT_LOOP_FAILED"/);
  assert.match(content, /\["AGENT_LOOP_FAILED", "BACKEND_INTERNAL_ERROR"\]/);
  assert.match(content, /decision\.fatalBackendFailure === true/);
});

test("extension page-map and observation transport have one modular implementation", () => {
  const root = path.resolve(__dirname, "../..");
  const runtime = fs.readFileSync(path.join(root, "apps/extension/src/content/runtime.js"), "utf8");
  const pageMap = fs.readFileSync(path.join(root, "apps/extension/src/content/observation/page-map.js"), "utf8");
  const transport = fs.readFileSync(path.join(root, "apps/extension/src/content/observation/transport.js"), "utf8");

  assert.match(runtime, /createPageMapCompiler\s*\(/);
  assert.match(runtime, /createObservationTransport\s*\(/);
  assert.doesNotMatch(runtime, /function buildPageMap\s*\(/);
  assert.doesNotMatch(runtime, /function boundedObservationTransport\s*\(/);
  assert.match(pageMap, /function buildPageMap\s*\(/);
  assert.match(transport, /function boundedObservationTransport\s*\(/);
  assert.match(transport, /function postObservationWithSizeRecovery\s*\(/);
});
