const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  compileDecisionFrame,
  createObservationFrame,
  currentObligationFromGoal,
  CHECKOUT_SITUATION_VERSION,
  CURRENT_OBLIGATION_VERSION,
  DECISION_FRAME_VERSION,
  OBSERVATION_FRAME_VERSION
} = require("../../apps/web/agent/authority-frames");
const { reduceTaskState } = require("./task-state-replay-adapter");
const { reduceDecisionFrame, taskStateReadModel } = require("../../apps/web/agent/task-state-reducer");
const { bindMechanics, buildCurrentCandidateSet } = require("./legacy-mechanics-binding-adapter");
const agentContract = require("../../apps/extension/src/shared/agent-contract");

function actionable(operation, actuatorId) {
  return {
    operation,
    actuatorId,
    actuatorIds: [actuatorId],
    actionability: {
      rendered: true,
      visible: true,
      enabled: true,
      inViewport: true,
      inCurrentSurface: true,
      hitTested: true,
      notOccluded: true,
      targetable: true,
      operationAuthorized: true,
      operationProven: true,
      executable: true,
      code: "ACTIONABLE",
      operation
    }
  };
}

function option(controlId, label, price = null) {
  return {
    controlId,
    stateElementId: `${controlId}_node`,
    preferredActivationElementId: `${controlId}_node`,
    surfaceId: "surface-page",
    surfaceType: "page",
    decisionGroupId: "dg_baggage",
    label,
    semantic: price ? "add_paid_baggage" : "decline_paid_baggage",
    physicalEffect: price ? "select_paid_option" : "select_free_option",
    risk: price ? "money" : "safe_decline",
    structuredPrice: price,
    kind: "radio",
    role: "radio",
    operations: { choose: actionable("choose", `${controlId}_node`) },
    state: { checked: false, selected: false }
  };
}

test("V2 frames compile once and publish one small mechanics-binding obligation", () => {
  const free = option("bag_none", "No checked baggage");
  const paid = option("bag_paid", "Add 20 kg — 35 EUR", { amount: 35, currency: "EUR" });
  const observation = {
    observationId: "obs_v2_baggage",
    observationSnapshot: { snapshotHash: "hash_v2_baggage" },
    page: {
      url: "https://example.test/checkout/baggage",
      step: "extras",
      currentSurface: { id: "surface-page", type: "page", surfaceClass: "checkout", label: "Baggage" },
      controls: [free, paid],
      decisionGroups: [{
        decisionGroupId: "dg_baggage",
        requirementId: "baggage:checked",
        surfaceId: "surface-page",
        surfaceType: "page",
        sectionType: "baggage",
        sectionLabel: "Checked baggage",
        required: true,
        status: "missing",
        selectedControlId: "",
        alternatives: [free, paid],
        controls: [free, paid]
      }],
      validationIssues: [],
      stageExit: { continueAllowed: false, candidates: [] }
    }
  };

  const observationFrame = createObservationFrame(observation);
  const decisionFrame = compileDecisionFrame({ observation, observationFrame });
  const taskState = reduceTaskState({
    observation,
    decisionFrame,
    traveler: { booking_rules: "No paid baggage or extras" },
    userPolicy: { bookingRules: "No paid baggage or extras" }
  });
  const productionTaskState = reduceDecisionFrame({
    previousTaskState: {},
    observation,
    decisionFrame,
    traveler: { booking_rules: "No paid baggage or extras" },
    userPolicy: { bookingRules: "No paid baggage or extras" }
  });

  assert.equal(observationFrame.contractVersion, OBSERVATION_FRAME_VERSION);
  assert.equal(decisionFrame.contractVersion, DECISION_FRAME_VERSION);
  assert.equal(taskState.decisionFrameId, decisionFrame.frameId);
  assert.equal(taskState.currentObligation.contractVersion, CURRENT_OBLIGATION_VERSION);
  assert.equal(taskState.currentObligation.authority, "task_state");
  assert.equal(taskState.currentObligation.bindingContract, undefined);
  assert.equal(taskState.currentObligation.mechanics, undefined);
  assert.ok(taskState.currentObligation.binding);
  assert.equal(taskState.currentObligation.subject.decisionGroupId, "dg_baggage");
  assert.deepEqual(taskState.currentObligation.admittedControlIds, ["bag_none"]);
  assert.equal(taskState.currentGoal.candidateSet, undefined);
  assert.equal(taskState.currentGoal.candidates, undefined);
  assert.equal(productionTaskState.contractVersion, "task-state/v2");
  assert.equal(productionTaskState.activeDecisions, undefined);
  assert.equal(productionTaskState.canonicalDecisions, undefined);
  assert.equal(productionTaskState.profileReadiness, undefined);
  assert.equal(productionTaskState.processAwareness, undefined);
  assert.ok(Array.isArray(taskStateReadModel(productionTaskState).canonicalDecisions));

  const candidateSet = bindMechanics({
    obligation: taskState.currentObligation,
    decisionFrame,
    observation: decisionFrame.observation,
    state: { taskState, approvals: {} },
    traveler: { booking_rules: "No paid baggage or extras" }
  });
  assert.equal(candidateSet.obligationId, taskState.currentObligation.obligationId);
  assert.deepEqual(candidateSet.candidates.map((candidate) => candidate.controlId), ["bag_none"]);
  assert.throws(() => bindMechanics({
    obligation: taskState.currentObligation,
    decisionFrame: { ...decisionFrame, observationHash: "stale_hash" },
    observation: decisionFrame.observation
  }), /BIND_MECHANICS_DECISION_FRAME_MISMATCH/);
});

test("a decision obligation cannot admit navigation that its success condition cannot satisfy", () => {
  assert.throws(() => currentObligationFromGoal({
    goal: {
      goalId: "seat-random-assignment",
      semanticType: "seat_selection",
      desiredSemanticOutcome: "random_assignment",
      decisionGroupId: "dg_seat",
      actionableControlIds: ["next"],
      postcondition: {
        type: "decision_group_resolved",
        decisionGroupId: "dg_seat",
        desiredSemanticOutcome: "random_assignment",
        eligibleAlternativeControlIds: ["skip_seat_selection"]
      }
    }
  }), {
    message: "CURRENT_OBLIGATION_CONTROL_CANNOT_SATISFY_SUCCESS_CONDITION"
  });
});

test("shared semantic effects canonicalize legacy free-choice vocabulary", () => {
  assert.equal(
    agentContract.canonicalSemanticEffect("selected_free_option"),
    agentContract.SEMANTIC_EFFECT.SELECT_FREE_OPTION
  );
  assert.equal(
    agentContract.canonicalSemanticEffect("select_free_alternative"),
    agentContract.SEMANTIC_EFFECT.SELECT_FREE_OPTION
  );
  assert.equal(
    agentContract.semanticEffectSatisfies("random_assignment", "select_free_option"),
    true
  );
  assert.equal(
    agentContract.semanticEffectSatisfies("random_assignment", "advance_checkout_stage"),
    false
  );
});

test("production runtime contains one semantic compiler and one TaskState reduction site", () => {
  const root = path.resolve(__dirname, "../..");
  const browser = fs.readFileSync(path.join(root, "apps/extension/src/content/runtime.js"), "utf8");
  const loop = fs.readFileSync(path.join(root, "apps/web/agent/loop/orchestrator.js"), "utf8");
  const candidateBinder = fs.readFileSync(path.join(root, "apps/web/agent/select-candidate.js"), "utf8");
  const ambiguityResolver = fs.readFileSync(path.join(root, "apps/web/agent/ambiguity-resolver.js"), "utf8");
  const governor = fs.readFileSync(path.join(root, "apps/web/agent/action-governor.js"), "utf8");
  const schemas = fs.readFileSync(path.join(root, "apps/web/agent/schemas.js"), "utf8");
  assert.equal((browser.match(/compileSemanticCheckout\s*\(/g) || []).length, 0);
  assert.equal((loop.match(/compileDecisionFrame\s*\(/g) || []).length, 1);
  assert.equal((loop.match(/reduceDecisionFrame\s*\(/g) || []).length, 1);
  assert.equal(/\bselectCandidate\b|\bresolveActiveComponentSemantics\b/.test(loop), false);
  assert.equal((ambiguityResolver.match(/require\("\.\/select-candidate"\)/g) || []).length, 0);
  assert.equal(/mechanic_selection/.test(`${loop}\n${ambiguityResolver}`), false);
  assert.equal((ambiguityResolver.match(/require\("\.\/active-component-grounding"\)/g) || []).length, 0);
  assert.equal((ambiguityResolver.match(/require\("\.\/semantic-scene-reconciliation"\)/g) || []).length, 1);
  assert.equal(/resolveSemanticOwnership|reusableSemanticOwnershipDecision/.test(`${loop}\n${candidateBinder}`), false);
  assert.equal(/activeDecisions|profileReadiness/.test(candidateBinder), false);
  assert.equal(/prepareTransactionInvariants|profileStageReadiness/.test(governor), false);
  assert.equal(/verifyAndPlan|plannerSchema|verifierSchema|pageStateSchema|requirementSchema/.test(schemas), false);
});

test("a DecisionFrame cannot be reused for a different immutable observation", () => {
  const first = {
    observationId: "obs_one",
    observationSnapshot: { snapshotHash: "hash_one" },
    page: { controls: [], decisionGroups: [] }
  };
  const second = {
    observationId: "obs_two",
    observationSnapshot: { snapshotHash: "hash_two" },
    page: { controls: [], decisionGroups: [] }
  };
  const staleFrame = createObservationFrame(first);
  assert.throws(
    () => compileDecisionFrame({ observation: second, observationFrame: staleFrame }),
    /DECISION_FRAME_OBSERVATION_MISMATCH/
  );
});

test("navigation admission excludes a settled decline even when browser stage-exit evidence mentions it", () => {
  const settledDecline = {
    controlId: "bundle_no_thanks",
    stateElementId: "bundle_no_thanks_node",
    preferredActivationElementId: "bundle_no_thanks_node",
    surfaceId: "surface-page",
    surfaceType: "page",
    decisionGroupId: "dg_bundle",
    label: "No, thanks — select this to continue without bundle",
    semantic: "decline_paid_extra",
    physicalEffect: "select_free_option",
    risk: "safe_decline",
    kind: "checkbox",
    role: "checkbox",
    selected: true,
    state: { selected: true, checked: true, disabled: false },
    operations: { choose: actionable("choose", "bundle_no_thanks_node") }
  };
  const continueControl = {
    controlId: "checkout_continue",
    stateElementId: "checkout_continue_node",
    preferredActivationElementId: "checkout_continue_node",
    surfaceId: "surface-page",
    surfaceType: "page",
    label: "Continue",
    semantic: "navigation",
    physicalEffect: "advance_checkout_stage",
    risk: "safe",
    kind: "button",
    role: "button",
    state: { disabled: false },
    operations: { activate: actionable("activate", "checkout_continue_node") }
  };
  const observation = {
    observationId: "obs_settled_decline_navigation",
    observationSnapshot: { snapshotHash: "hash_settled_decline_navigation" },
    page: {
      step: "traveler_information",
      currentSurface: { id: "surface-page", type: "page", surfaceClass: "checkout" },
      controls: [settledDecline, continueControl],
      decisionGroups: [{
        decisionGroupId: "dg_bundle",
        requirementId: "bundle:optional",
        surfaceId: "surface-page",
        sectionType: "bundle",
        required: false,
        status: "satisfied",
        selectedControlId: settledDecline.controlId,
        alternatives: [settledDecline]
      }],
      validationIssues: [],
      stageExit: {
        continueAllowed: true,
        candidates: [
          { controlId: settledDecline.controlId, executable: true, status: "ready" },
          { controlId: continueControl.controlId, executable: true, status: "ready" }
        ]
      }
    }
  };
  const decisionFrame = compileDecisionFrame({ observation, observationFrame: createObservationFrame(observation) });
  const taskState = reduceTaskState({ observation, decisionFrame, traveler: { booking_rules: "No paid extras" } });
  assert.equal(taskState.currentObligation.desiredEffect, "advance_checkout_stage");
  assert.deepEqual(taskState.currentObligation.admittedControlIds, [continueControl.controlId]);
  const candidates = buildCurrentCandidateSet({
    obligation: taskState.currentObligation,
    observation: decisionFrame.observation,
    state: { taskState, approvals: {} },
    traveler: { booking_rules: "No paid extras" }
  });
  assert.deepEqual(candidates.candidates.map((candidate) => candidate.controlId), [continueControl.controlId]);
});

test("CheckoutSituation admits grounded obligations and consequences without treating stage as authority", () => {
  const firstName = {
    controlId: "first_name",
    stateElementId: "first_name_node",
    preferredActivationElementId: "first_name_node",
    surfaceId: "surface-page",
    surfaceType: "page",
    fieldType: "first_name",
    semantic: "first_name",
    physicalEffect: "set_field_value",
    label: "First name",
    kind: "text",
    role: "textbox",
    required: true,
    state: { required: true, valuePresent: false, normalizedValue: "" },
    operations: { type: actionable("type", "first_name_node") }
  };
  const terms = {
    controlId: "terms",
    stateElementId: "terms_node",
    preferredActivationElementId: "terms_node",
    surfaceId: "surface-page",
    semantic: "legal_acceptance",
    physicalEffect: "accept_legal_terms",
    risk: "legal",
    label: "I agree with the General Conditions of Carriage and purchase conditions and understand dangerous goods restrictions",
    kind: "checkbox",
    role: "checkbox",
    state: { checked: false },
    operations: { choose: actionable("choose", "terms_node") }
  };
  const pay = {
    controlId: "pay",
    stateElementId: "pay_node",
    preferredActivationElementId: "pay_node",
    surfaceId: "surface-page",
    semantic: "submit_purchase",
    physicalEffect: "submit_purchase",
    risk: "payment",
    label: "Confirm and pay",
    kind: "button",
    role: "button",
    operations: { activate: actionable("activate", "pay_node") }
  };
  const observation = {
    observationId: "obs_mixed_checkout",
    observationSnapshot: { snapshotHash: "hash_mixed_checkout" },
    page: {
      url: "https://example.test/checkout",
      step: "extras",
      currentSurface: { id: "surface-page", type: "page" },
      controls: [firstName, terms, pay],
      fields: [{
        controlId: firstName.controlId,
        field: "first_name",
        fieldType: "first_name",
        label: firstName.label,
        required: true,
        hasValue: false,
        state: firstName.state,
        controlState: firstName.state
      }],
      decisionGroups: [],
      validationIssues: [{
        status: "diagnostic",
        lifecycle: "diagnostic",
        message: "0 error"
      }]
    }
  };
  const decisionFrame = compileDecisionFrame({
    observation,
    observationFrame: createObservationFrame(observation),
    traveler: { first_name: "Ali" }
  });
  const situation = decisionFrame.checkoutSituation;
  const taskState = reduceTaskState({ observation, decisionFrame, traveler: { first_name: "Ali" } });

  assert.equal(situation.contractVersion, CHECKOUT_SITUATION_VERSION);
  assert.equal(situation.stageHint.value, "extras");
  assert.equal(situation.obligations.some((item) => item.semanticType === "first_name"), true);
  assert.deepEqual(situation.blockers, []);
  assert.deepEqual(
    situation.obligations.filter((item) => item.status === "authorization_required").map((item) => item.kind).sort(),
    ["legal_authorization", "purchase_authorization"]
  );
  assert.deepEqual(
    situation.consequentialActions.map((item) => item.consequence).sort(),
    ["legal_attestation", "purchase_submission"]
  );
  assert.equal(taskState.currentObligation.kind, "profile_field");
  assert.equal(taskState.currentObligation.subject.semanticType, "first_name");
});

test("stage hints do not change stable obligation ownership", () => {
  const makeObservation = (step, observationId, snapshotHash) => ({
    observationId,
    observationSnapshot: { snapshotHash },
    page: {
      url: "https://example.test/checkout",
      step,
      currentSurface: { id: "surface-page", type: "page" },
      controls: [{
        controlId: "last_name",
        stateElementId: "last_name_node",
        preferredActivationElementId: "last_name_node",
        surfaceId: "surface-page",
        fieldType: "last_name",
        semantic: "last_name",
        physicalEffect: "set_field_value",
        label: "Last name",
        kind: "text",
        role: "textbox",
        required: true,
        state: { required: true, valuePresent: false },
        operations: { type: actionable("type", "last_name_node") }
      }],
      fields: [{
        controlId: "last_name",
        field: "last_name",
        fieldType: "last_name",
        label: "Last name",
        required: true,
        hasValue: false
      }],
      decisionGroups: [],
      validationIssues: []
    }
  });
  const traveler = { last_name: "Sifrar" };
  const extras = reduceTaskState({ observation: makeObservation("extras", "obs_owner_a", "hash_owner_a"), traveler });
  const travelerHint = reduceTaskState({ observation: makeObservation("traveler_information", "obs_owner_b", "hash_owner_b"), traveler });

  assert.equal(extras.currentObligation.semanticOwner.stage, "checkout");
  assert.equal(extras.currentObligation.semanticOwnerId, travelerHint.currentObligation.semanticOwnerId);
  assert.equal(extras.surfaceFingerprint, travelerHint.surfaceFingerprint);
});

test("an active unexplained checkout produces typed situation reconciliation", () => {
  const observation = {
    observationId: "obs_unexplained_checkout",
    observationSnapshot: { snapshotHash: "hash_unexplained_checkout" },
    page: {
      url: "https://example.test/checkout",
      step: "unknown",
      currentSurface: { id: "surface-page", type: "page" },
      controls: [],
      decisionGroups: [],
      validationIssues: [],
      transactionFacts: { currency: "EUR", totalPrice: { amount: 100, currency: "EUR" } }
    }
  };
  const decisionFrame = compileDecisionFrame({ observation, observationFrame: createObservationFrame(observation) });
  const taskState = reduceDecisionFrame({ observation, decisionFrame });

  assert.equal(decisionFrame.checkoutSituation.reconciliationRequired, true);
  assert.equal(taskState.disposition.code, "SITUATION_RECONCILIATION_REQUIRED");
  assert.equal(taskState.disposition.userActionRequired, false);
});

test("strong unknown validation survives semantic uncertainty and outranks navigation while weak required markup does not", () => {
  const baseControl = {
    surfaceId: "surface-page",
    representationLifecycle: { active: true, status: "active_rendered" },
    state: { valuePresent: false },
    operations: { type: actionable("type", "unknown_input") }
  };
  const observation = {
    observationId: "obs_unknown_validation_contract",
    observationSnapshot: { snapshotHash: "hash_unknown_validation_contract" },
    page: {
      url: "https://example.test/checkout",
      step: "misleading_stage",
      currentSurface: { id: "surface-page", type: "page" },
      controls: [{
        ...baseControl,
        controlId: "unknown_input",
        stateElementId: "unknown_input",
        preferredActivationElementId: "unknown_input",
        role: "textbox",
        kind: "text",
        label: "Passenger detail",
        name: "opaque"
      }, {
        ...baseControl,
        controlId: "promo",
        stateElementId: "promo",
        preferredActivationElementId: "promo",
        label: "Promo code",
        name: "promo",
        required: true,
        state: { required: true, valuePresent: false }
      }, {
        controlId: "continue",
        stateElementId: "continue",
        preferredActivationElementId: "continue",
        surfaceId: "surface-page",
        role: "button",
        kind: "button",
        label: "Continue",
        semantic: "continue",
        physicalEffect: "advance_checkout_stage",
        representationLifecycle: { active: true, status: "active_rendered" },
        state: { disabled: false },
        operations: { activate: actionable("activate", "continue") }
      }],
      fields: [],
      decisionGroups: [],
      validationIssues: [{
        issueId: "validation_unknown",
        controlId: "unknown_input",
        message: "Please complete this passenger detail",
        status: "active_control_error"
      }],
      stageExit: { candidates: [{ controlId: "continue", executable: true, status: "ready" }], blockers: [] }
    }
  };
  const frame = compileDecisionFrame({ observation, observationFrame: createObservationFrame(observation) });
  const kinds = frame.checkoutSituation.obligations.map((obligation) => obligation.kind);
  assert.equal(kinds.includes("unknown_validation"), true);
  assert.equal(frame.checkoutSituation.obligations.some((obligation) => obligation.controlId === "promo"), false);

  const taskState = reduceDecisionFrame({ observation: frame.observation, decisionFrame: frame });
  assert.equal(taskState.currentObligation.kind, "unknown_validation");
  assert.deepEqual(taskState.currentObligation.admittedControlIds, ["unknown_input"]);
  assert.notEqual(taskState.currentObligation.kind, "navigation");
});
