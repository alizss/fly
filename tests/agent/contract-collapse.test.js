const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { toClientDecision } = require("../../apps/web/agent/loop");
const { actionFromLease, normalizeAction } = require("../../packages/shared/agent-actions");
const { legacyCurrentObligationFromGoal: currentObligationFromGoal } = require("./legacy-scene-item-adapter");
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
  const loopFacade = read("loop.js");
  const loop = read("loop/orchestrator.js");
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

  assert.match(loopFacade, /module\.exports = require\("\.\/loop\/orchestrator"\)/);
  assert.match(loop, /require\("\.\.\/mechanics-binder"\)/);
  assert.match(loop, /require\("\.\.\/ambiguity-resolver"\)/);
  assert.doesNotMatch(loop, /require\("\.\.\/(?:select-candidate|active-component-grounding)"\)/);
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
  const nextAction = fs.readFileSync(path.join(root, "apps/web/agent/next-action-service.js"), "utf8");
  const agentRoutes = fs.readFileSync(path.join(root, "apps/web/routes/agent.js"), "utf8");
  const loop = fs.readFileSync(path.join(root, "apps/web/agent/loop.js"), "utf8");
  const content = fs.readFileSync(path.join(root, "apps/extension/src/content/runtime.js"), "utf8");
  const execution = fs.readFileSync(path.join(root, "apps/extension/src/content/execution/orchestrator.js"), "utf8");
  const decisions = fs.readFileSync(path.join(root, "apps/extension/src/content/controller/decision-client.js"), "utf8");
  const observationPayload = decisions.slice(
    decisions.indexOf("const observationPayload = {"),
    decisions.indexOf("const transport = await postObservationWithSizeRecovery")
  );

  assert.doesNotMatch(server, /actionHistory/);
  assert.doesNotMatch(agentRoutes, /actionHistory/);
  assert.doesNotMatch(loop, /actionHistory/);
  assert.doesNotMatch(observationPayload, /actionHistory/);
  assert.match(observationPayload, /lastActionResult: lastActionForTransport/);
  assert.match(nextAction, /throw failure/);
  assert.match(agentRoutes, /error\.code === "AGENT_LOOP_FAILED"/);
  assert.match(decisions, /\["AGENT_LOOP_FAILED", "BACKEND_INTERNAL_ERROR"\]/);
  assert.match(execution, /decision\.fatalBackendFailure === true/);
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

test("extension logical controls and canonical graph compile outside the runtime orchestrator", () => {
  const root = path.resolve(__dirname, "../..");
  const runtime = fs.readFileSync(path.join(root, "apps/extension/src/content/runtime.js"), "utf8");
  const controls = fs.readFileSync(path.join(root, "apps/extension/src/content/observation/logical-controls.js"), "utf8");
  const graph = fs.readFileSync(path.join(root, "apps/extension/src/content/observation/control-graph.js"), "utf8");

  assert.match(runtime, /createLogicalControlCompiler\s*\(/);
  assert.match(runtime, /createControlGraphCompiler\s*\(/);
  assert.doesNotMatch(runtime, /function controlOperationsForElement\s*\(/);
  assert.doesNotMatch(runtime, /function applyControlsToObservationModels\s*\(/);
  assert.match(controls, /function controlOperationsForElement\s*\(/);
  assert.match(controls, /function canonicalControlForElement\s*\(/);
  assert.match(graph, /function applyControlsToObservationModels\s*\(/);
  assert.match(graph, /function buildCanonicalControlGraph\s*\(/);
});

test("extension perception facade owns section, readiness, and visual page projections", () => {
  const root = path.resolve(__dirname, "../..");
  const runtime = fs.readFileSync(path.join(root, "apps/extension/src/content/runtime.js"), "utf8");
  const perception = fs.readFileSync(path.join(root, "apps/extension/src/content/observation/perception.js"), "utf8");
  const sections = fs.readFileSync(path.join(root, "apps/extension/src/content/observation/sections.js"), "utf8");

  assert.match(runtime, /createPerceptionFacade\s*\(/);
  assert.match(runtime, /createSectionPerception\s*\(/);
  assert.doesNotMatch(runtime, /function pageReadinessFacts\s*\(/);
  assert.doesNotMatch(runtime, /function visualPageState\s*\(/);
  assert.doesNotMatch(runtime, /function detectCheckoutSections\s*\(/);
  assert.doesNotMatch(runtime, /function elementBelongsToSectionBand\s*\(/);
  assert.match(perception, /function pageReadinessFacts\s*\(/);
  assert.match(perception, /function visualPageState\s*\(/);
  assert.match(sections, /function detectCheckoutSections\s*\(/);
  assert.match(sections, /function elementBelongsToSectionBand\s*\(/);
});

test("extension targeting owns exact resolution and actuator validation", () => {
  const root = path.resolve(__dirname, "../..");
  const runtime = fs.readFileSync(path.join(root, "apps/extension/src/content/runtime.js"), "utf8");
  const targeting = fs.readFileSync(path.join(root, "apps/extension/src/content/execution/targeting.js"), "utf8");

  assert.match(runtime, /createTargeting\s*\(/);
  assert.doesNotMatch(runtime, /function resolveDecisionTarget\s*\(/);
  assert.doesNotMatch(runtime, /function validateResolvedTarget\s*\(/);
  assert.doesNotMatch(runtime, /function validateVisualCoordinateTarget\s*\(/);
  assert.match(targeting, /function resolveDecisionTarget\s*\(/);
  assert.match(targeting, /function validateResolvedTarget\s*\(/);
  assert.match(targeting, /function validateVisualCoordinateTarget\s*\(/);
  assert.match(targeting, /function liveTargetSnapshot\s*\(/);
});

test("extension interaction module owns click, choice, keyboard, and scroll mechanics", () => {
  const root = path.resolve(__dirname, "../..");
  const runtime = fs.readFileSync(path.join(root, "apps/extension/src/content/runtime.js"), "utf8");
  const interaction = fs.readFileSync(path.join(root, "apps/extension/src/content/execution/interaction.js"), "utf8");

  assert.match(runtime, /createInteractionMechanics\s*\(/);
  assert.doesNotMatch(runtime, /function dispatchGovernedClickMechanic\s*\(/);
  assert.doesNotMatch(runtime, /function trustedBrowserChoice\s*\(/);
  assert.doesNotMatch(runtime, /function scrollElementWithinNearestContainer\s*\(/);
  assert.match(interaction, /function dispatchGovernedClickMechanic\s*\(/);
  assert.match(interaction, /function trustedBrowserChoice\s*\(/);
  assert.match(interaction, /function trustedBrowserKey\s*\(/);
  assert.match(interaction, /function scrollElementWithinNearestContainer\s*\(/);
});

test("extension field interaction owns controlled typing, native select, and phone choice mechanics", () => {
  const root = path.resolve(__dirname, "../..");
  const runtime = fs.readFileSync(path.join(root, "apps/extension/src/content/runtime.js"), "utf8");
  const fields = fs.readFileSync(path.join(root, "apps/extension/src/content/execution/field-interaction.js"), "utf8");

  assert.match(runtime, /createFieldInteraction\s*\(/);
  assert.doesNotMatch(runtime, /function setFieldValue\s*\(/);
  assert.doesNotMatch(runtime, /function setSelectValue\s*\(/);
  assert.doesNotMatch(runtime, /function selectCountryCodeControl\s*\(/);
  assert.match(fields, /function setFieldValue\s*\(/);
  assert.match(fields, /function setSelectValue\s*\(/);
  assert.match(fields, /function selectCountryCodeControl\s*\(/);
  assert.match(fields, /function selectComboboxOption\s*\(/);
});

test("extension outcome verification owns expected results and canonical postcondition proof", () => {
  const root = path.resolve(__dirname, "../..");
  const runtime = fs.readFileSync(path.join(root, "apps/extension/src/content/runtime.js"), "utf8");
  const outcomes = fs.readFileSync(path.join(root, "apps/extension/src/content/verification/outcomes.js"), "utf8");

  assert.match(runtime, /createOutcomeVerification\s*\(/);
  assert.doesNotMatch(runtime, /function expectedOutcomeForDecision\s*\(/);
  assert.doesNotMatch(runtime, /function verifyExpectedOutcomeInternal\s*\(/);
  assert.doesNotMatch(runtime, /function transitionFeedbackForMaps\s*\(/);
  assert.match(outcomes, /function expectedOutcomeForDecision\s*\(/);
  assert.match(outcomes, /function verifyExpectedOutcomeInternal\s*\(/);
  assert.match(outcomes, /function transitionFeedbackForMaps\s*\(/);
  assert.match(outcomes, /function exactChildChoiceSettlementEvidence\s*\(/);
});

test("extension execution orchestrator owns one governed action lifecycle", () => {
  const root = path.resolve(__dirname, "../..");
  const runtime = fs.readFileSync(path.join(root, "apps/extension/src/content/runtime.js"), "utf8");
  const orchestrator = fs.readFileSync(path.join(root, "apps/extension/src/content/execution/orchestrator.js"), "utf8");

  assert.match(runtime, /createExecutionOrchestrator\s*\(/);
  assert.doesNotMatch(runtime, /function executeAgentDecision\s*\(/);
  assert.doesNotMatch(runtime, /function clickAndVerifyAdvance\s*\(/);
  assert.doesNotMatch(runtime, /function pushVerificationLedger\s*\(/);
  assert.match(orchestrator, /function executeAgentDecision\s*\(/);
  assert.match(orchestrator, /function clickAndVerifyAdvance\s*\(/);
  assert.match(orchestrator, /function pushVerificationLedger\s*\(/);
  assert.match(orchestrator, /function verificationFromSurfaceFeedback\s*\(/);
});

test("extension controller owns single-flight turns and bounded destination waiting", () => {
  const root = path.resolve(__dirname, "../..");
  const runtime = fs.readFileSync(path.join(root, "apps/extension/src/content/runtime.js"), "utf8");
  const lifecycle = fs.readFileSync(path.join(root, "apps/extension/src/content/controller/lifecycle.js"), "utf8");

  assert.match(runtime, /createAgentLifecycle\s*\(/);
  assert.doesNotMatch(runtime, /function beginDestinationWait\s*\(/);
  assert.doesNotMatch(runtime, /function beginAgentLoop\s*\(/);
  assert.doesNotMatch(runtime, /function abortActivePlannerRequest\s*\(/);
  assert.match(lifecycle, /function beginDestinationWait\s*\(/);
  assert.match(lifecycle, /function scheduleDestinationObservation\s*\(/);
  assert.match(lifecycle, /function beginAgentLoop\s*\(/);
  assert.match(lifecycle, /function abortActivePlannerRequest\s*\(/);
});

test("extension controller modules own session, backend decisions, and checkout turns", () => {
  const root = path.resolve(__dirname, "../..");
  const runtime = fs.readFileSync(path.join(root, "apps/extension/src/content/runtime.js"), "utf8");
  const session = fs.readFileSync(path.join(root, "apps/extension/src/content/controller/session-client.js"), "utf8");
  const decisions = fs.readFileSync(path.join(root, "apps/extension/src/content/controller/decision-client.js"), "utf8");
  const checkout = fs.readFileSync(path.join(root, "apps/extension/src/content/controller/checkout-controller.js"), "utf8");

  assert.match(runtime, /createSessionClient\s*\(/);
  assert.match(runtime, /createDecisionClient\s*\(/);
  assert.match(runtime, /createCheckoutController\s*\(/);
  assert.doesNotMatch(runtime, /function startAgentSession\s*\(/);
  assert.doesNotMatch(runtime, /function requestAgentDecision\s*\(/);
  assert.doesNotMatch(runtime, /function processCheckoutAgent\s*\(/);
  assert.match(session, /function startAgentSession\s*\(/);
  assert.match(decisions, /function requestAgentDecision\s*\(/);
  assert.match(checkout, /function processCheckoutAgent\s*\(/);
});

test("active checkout continuity follows one armed governed navigation across same-tab, child, noopener, or replaced destinations", () => {
  const root = path.resolve(__dirname, "../..");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "apps/extension/manifest.json"), "utf8"));
  const worker = fs.readFileSync(path.join(root, "apps/extension/src/background/service-worker.js"), "utf8");
  const runtime = fs.readFileSync(path.join(root, "apps/extension/src/content/runtime.js"), "utf8");
  const session = fs.readFileSync(path.join(root, "apps/extension/src/content/controller/session-client.js"), "utf8");

  assert.ok(manifest.permissions.includes("scripting"));
  assert.ok(manifest.permissions.includes("webNavigation"));
  assert.ok(manifest.host_permissions.includes("<all_urls>"));
  assert.match(worker, /chrome\.tabs\.onCreated\.addListener/);
  assert.match(worker, /tab\.openerTabId/);
  assert.match(worker, /chrome\.tabs\.onUpdated\.addListener/);
  assert.match(worker, /chrome\.tabs\.onReplaced\.addListener/);
  assert.match(worker, /chrome\.webNavigation\.onCreatedNavigationTarget\.addListener/);
  assert.match(worker, /chrome\.webNavigation\.onCommitted\.addListener/);
  assert.match(worker, /chrome\.webNavigation\.onHistoryStateUpdated\.addListener/);
  assert.match(worker, /chrome\.webNavigation\.onReferenceFragmentUpdated\.addListener/);
  assert.match(worker, /chrome\.webNavigation\.onDOMContentLoaded\.addListener/);
  assert.match(worker, /const directSource = newest/);
  assert.match(worker, /routeForCommittedNavigation\(details\)[\s\S]*injectActiveCheckout/);
  assert.match(worker, /ATW_ARM_NAVIGATION_EPISODE/);
  assert.match(worker, /ATW_CLAIM_NAVIGATION_EPISODE/);
  assert.match(worker, /navigationEpisodeKey/);
  assert.match(worker, /chrome\.scripting\.executeScript/);
  assert.match(runtime, /__ATW_CONTENT_BOOTING__/);
  assert.match(runtime, /activateNavigationEpisode/);
  assert.match(runtime, /armCheckoutHandoff/);
  assert.match(runtime, /claimNavigationEpisode/);
  assert.doesNotMatch(runtime, /atwAgentResume/);
  assert.match(session, /action\.report\.navigation_ack_deferred/);
});

test("an action-scoped navigation episode is pulled by an active noopener destination without a global resume marker", async () => {
  const root = path.resolve(__dirname, "../..");
  const workerSource = fs.readFileSync(path.join(root, "apps/extension/src/background/service-worker.js"), "utf8");
  const storage = {};
  const listeners = {};
  const local = {
    async get(keys) {
      const requested = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(requested
        .filter((key) => Object.prototype.hasOwnProperty.call(storage, key))
        .map((key) => [key, storage[key]]));
    },
    async set(values) {
      Object.assign(storage, values || {});
    },
    async remove(keys) {
      for (const key of (Array.isArray(keys) ? keys : [keys])) delete storage[key];
    }
  };
  const chrome = {
    storage: { local },
    runtime: {
      lastError: null,
      onInstalled: { addListener(listener) { listeners.installed = listener; } },
      onMessage: { addListener(listener) { listeners.message = listener; } }
    },
    tabs: {
      onCreated: { addListener(listener) { listeners.created = listener; } },
      onUpdated: { addListener(listener) { listeners.updated = listener; } },
      onReplaced: { addListener(listener) { listeners.replaced = listener; } },
      onRemoved: { addListener(listener) { listeners.removed = listener; } },
      async get() { return null; },
      async sendMessage() { return { ok: true }; },
      captureVisibleTab() {}
    },
    webNavigation: {
      onCreatedNavigationTarget: { addListener(listener) { listeners.createdNavigationTarget = listener; } },
      onCommitted: { addListener(listener) { listeners.committed = listener; } },
      onHistoryStateUpdated: { addListener(listener) { listeners.historyStateUpdated = listener; } },
      onReferenceFragmentUpdated: { addListener(listener) { listeners.referenceFragmentUpdated = listener; } },
      onDOMContentLoaded: { addListener(listener) { listeners.domContentLoaded = listener; } }
    },
    scripting: {
      async insertCSS() {},
      async executeScript() {}
    },
    debugger: {
      attach() {},
      sendCommand() {},
      detach() {}
    }
  };
  vm.runInNewContext(workerSource, { chrome, Date, Number, String, Boolean, RegExp, setTimeout, clearTimeout });

  const episode = {
    episodeId: "navigation:chk_noopener:act_confirm",
    travelerId: "trav_noopener",
    sessionId: "chk_noopener",
    actionId: "act_confirm",
    observationId: "obs_review",
    deadlineAt: Date.now() + 120000
  };
  const armed = await new Promise((resolve) => {
    listeners.message({
      type: "ATW_ARM_NAVIGATION_EPISODE",
      episode
    }, {
      documentId: "document_source",
      tab: { id: 11, windowId: 3, url: "https://booking.example/review" }
    }, resolve);
  });
  assert.equal(armed?.ok, true);
  assert.equal(armed?.armed, true);

  const unrelated = await new Promise((resolve) => {
    listeners.message({ type: "ATW_CLAIM_NAVIGATION_EPISODE" }, {
      documentId: "document_unrelated",
      tab: { id: 99, windowId: 8, url: "https://unrelated.example/" }
    }, resolve);
  });
  assert.equal(unrelated?.episode, null);

  listeners.created({
    id: 12,
    windowId: 3,
    active: true,
    url: "https://payments.example/setup"
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  listeners.committed({
    tabId: 12,
    frameId: 0,
    documentId: "document_destination",
    url: "https://payments.example/setup"
  });
  await new Promise((resolve) => setImmediate(resolve));

  const claimed = await new Promise((resolve) => {
    listeners.message({ type: "ATW_CLAIM_NAVIGATION_EPISODE" }, {
      documentId: "document_destination",
      tab: { id: 12, windowId: 3, url: "https://payments.example/setup" }
    }, resolve);
  });
  assert.equal(claimed?.ok, true);
  assert.equal(claimed?.episode?.episodeId, episode.episodeId);
  assert.equal(claimed?.episode?.sessionId, episode.sessionId);
  assert.equal(claimed?.episode?.actionId, episode.actionId);
  assert.equal(claimed?.destination?.documentId, "document_destination");
  assert.equal(Object.keys(storage).some((key) => key === "atwAgentResume"), false);

  // The first claimed page can be a short-lived handoff. A new top-level
  // document in the same routed tab must inherit the same episode until the
  // usable destination explicitly reports readiness.
  listeners.committed({
    tabId: 12,
    frameId: 0,
    documentId: "document_destination_final",
    url: "https://payments.example/form"
  });
  await new Promise((resolve) => setImmediate(resolve));
  const redirectClaim = await new Promise((resolve) => {
    listeners.message({
      type: "ATW_CLAIM_NAVIGATION_EPISODE",
      claimantId: "controller_destination_final"
    }, {
      documentId: "document_destination_final",
      tab: { id: 12, windowId: 3, url: "https://payments.example/form" }
    }, resolve);
  });
  assert.equal(redirectClaim?.episode?.episodeId, episode.episodeId);
  assert.equal(redirectClaim?.destination?.documentId, "controller_destination_final");

  const ready = await new Promise((resolve) => {
    listeners.message({
      type: "ATW_NAVIGATION_DESTINATION_READY",
      episodeId: episode.episodeId,
      claimantId: "controller_destination_final"
    }, {
      documentId: "document_destination_final",
      tab: { id: 12, windowId: 3, url: "https://payments.example/form" }
    }, resolve);
  });
  assert.equal(ready?.ready, true);

  listeners.committed({
    tabId: 12,
    frameId: 0,
    documentId: "document_after_ready",
    url: "https://unrelated.example/"
  });
  await new Promise((resolve) => setImmediate(resolve));
  const afterReadyClaim = await new Promise((resolve) => {
    listeners.message({ type: "ATW_CLAIM_NAVIGATION_EPISODE" }, {
      documentId: "document_after_ready",
      tab: { id: 12, windowId: 3, url: "https://unrelated.example/" }
    }, resolve);
  });
  assert.equal(afterReadyClaim?.episode, null);

  const secondEpisode = {
    ...episode,
    episodeId: "navigation:chk_noopener:act_payment_continue",
    actionId: "act_payment_continue",
    observationId: "obs_payment_setup"
  };
  const secondArmed = await new Promise((resolve) => {
    listeners.message({ type: "ATW_ARM_NAVIGATION_EPISODE", episode: secondEpisode }, {
      documentId: "document_destination_final",
      tab: { id: 12, windowId: 3, url: "https://payments.example/form" }
    }, resolve);
  });
  assert.equal(secondArmed?.armed, true);
  listeners.committed({
    tabId: 12,
    frameId: 0,
    documentId: "document_hosted_payment",
    url: "https://hosted-payments.example/card"
  });
  await new Promise((resolve) => setImmediate(resolve));

  const secondClaim = await new Promise((resolve) => {
    listeners.message({ type: "ATW_CLAIM_NAVIGATION_EPISODE" }, {
      documentId: "document_hosted_payment",
      tab: { id: 12, windowId: 3, url: "https://hosted-payments.example/card" }
    }, resolve);
  });
  assert.equal(secondClaim?.episode?.episodeId, secondEpisode.episodeId);
  assert.equal(secondClaim?.episode?.actionId, secondEpisode.actionId);
  assert.notEqual(secondClaim?.episode?.actionId, episode.actionId);
});

test("extension sidebar module owns rendering and diagnostic presentation", () => {
  const root = path.resolve(__dirname, "../..");
  const runtime = fs.readFileSync(path.join(root, "apps/extension/src/content/runtime.js"), "utf8");
  const sidebar = fs.readFileSync(path.join(root, "apps/extension/src/content/ui/sidebar.js"), "utf8");

  assert.match(runtime, /createSidebarUi\s*\(/);
  assert.doesNotMatch(runtime, /function renderSidebar\s*\(/);
  assert.doesNotMatch(runtime, /function observerPanelHtml\s*\(/);
  assert.match(sidebar, /function renderSidebar\s*\(/);
  assert.match(sidebar, /function observerPanelHtml\s*\(/);
  assert.match(sidebar, /function agentProcessDiagnosticsHtml\s*\(/);
});

test("extension diagnostics and screenshot projection are modular boundaries", () => {
  const root = path.resolve(__dirname, "../..");
  const runtime = fs.readFileSync(path.join(root, "apps/extension/src/content/runtime.js"), "utf8");
  const flow = fs.readFileSync(path.join(root, "apps/extension/src/content/diagnostics/flow.js"), "utf8");
  const debug = fs.readFileSync(path.join(root, "apps/extension/src/content/diagnostics/debug.js"), "utf8");
  const screenshot = fs.readFileSync(path.join(root, "apps/extension/src/content/observation/screenshot.js"), "utf8");
  const understanding = fs.readFileSync(path.join(root, "apps/extension/src/content/observation/page-understanding.js"), "utf8");

  assert.match(runtime, /createFlowDiagnostics\s*\(/);
  assert.match(runtime, /createDebugDiagnostics\s*\(/);
  assert.match(runtime, /createScreenshotObservation\s*\(/);
  assert.match(runtime, /createPageUnderstanding\s*\(/);
  assert.doesNotMatch(runtime, /function compactFlowLogPayload\s*\(/);
  assert.doesNotMatch(runtime, /function debugSnapshot\s*\(/);
  assert.doesNotMatch(runtime, /function prepareScreenshotAnnotations\s*\(/);
  assert.doesNotMatch(runtime, /function buildPageUnderstanding\s*\(/);
  assert.match(flow, /function compactFlowLogPayload\s*\(/);
  assert.match(debug, /function debugSnapshot\s*\(/);
  assert.match(screenshot, /function prepareScreenshotAnnotations\s*\(/);
  assert.match(understanding, /function buildPageUnderstanding\s*\(/);
});

test("web server remains a composition root instead of a second agent authority", () => {
  const root = path.resolve(__dirname, "../..");
  const server = fs.readFileSync(path.join(root, "apps/web/server.js"), "utf8");

  for (const boundary of [
    "createSessionService",
    "createScreenshotStore",
    "createRequestDiagnostics",
    "createWalletStore",
    "createRequestPayloadAdapter",
    "createNextActionService",
    "createAgentRoutes",
    "createWalletRoutes"
  ]) {
    assert.match(server, new RegExp(`${boundary}\\s*\\(`));
  }
  for (const escapedResponsibility of [
    "compactAgentPayload",
    "hydrateIncrementalAgentBody",
    "decideAgentNextActionViaLoop",
    "writeClientFlowLog",
    "writeActionLedgerRow",
    "readDb",
    "seedDb"
  ]) {
    assert.doesNotMatch(server, new RegExp(`function ${escapedResponsibility}\\s*\\(`));
  }
});

test("TaskState modules preserve one CheckoutScene reducer authority behind the compatibility facade", () => {
  const root = path.resolve(__dirname, "../..");
  const facade = fs.readFileSync(path.join(root, "apps/web/agent/task-state-reducer.js"), "utf8");
  const reducer = fs.readFileSync(path.join(root, "apps/web/agent/task-state/reducer.js"), "utf8");
  const modules = [
    "stage.js",
    "terminal.js",
    "profile-verification.js",
    "commerce-ledger.js",
    "decision-episode.js",
    "surface-state.js"
  ].map((file) => fs.readFileSync(path.join(root, "apps/web/agent/task-state", file), "utf8"));

  assert.match(facade, /module\.exports = require\("\.\/task-state\/reducer"\)/);
  assert.doesNotMatch(facade, /function reduceCheckoutScene\s*\(/);
  assert.match(reducer, /function reduceCheckoutScene\s*\(/);
  for (const moduleSource of modules) {
    assert.doesNotMatch(moduleSource, /function reduceCheckoutScene\s*\(/);
  }
});

test("agent loop modules preserve one turn orchestrator behind the compatibility facade", () => {
  const root = path.resolve(__dirname, "../..");
  const facade = fs.readFileSync(path.join(root, "apps/web/agent/loop.js"), "utf8");
  const orchestrator = fs.readFileSync(path.join(root, "apps/web/agent/loop/orchestrator.js"), "utf8");
  const modules = [
    "action-contract.js",
    "mechanics.js",
    "transition.js",
    "observation-settlement.js",
    "recovery.js",
    "turn-result.js"
  ].map((file) => fs.readFileSync(path.join(root, "apps/web/agent/loop", file), "utf8"));

  assert.match(facade, /module\.exports = require\("\.\/loop\/orchestrator"\)/);
  assert.doesNotMatch(facade, /async function runLoopTurn\s*\(/);
  assert.match(orchestrator, /async function runLoopTurn\s*\(/);
  for (const moduleSource of modules) {
    assert.doesNotMatch(moduleSource, /async function runLoopTurn\s*\(/);
  }
});
