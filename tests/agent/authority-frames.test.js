const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  compileDecisionFrame,
  createObservationFrame,
  currentObligationFromGoal,
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
  assert.equal((ambiguityResolver.match(/require\("\.\/select-candidate"\)/g) || []).length, 1);
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
