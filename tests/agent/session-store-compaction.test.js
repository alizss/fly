const test = require("node:test");
const assert = require("node:assert/strict");

const { compactSessionState, createStore } = require("../../apps/web/agent/session-store");
const { createCheckoutSessionState, withUpdate } = require("../../packages/shared/agent-state");
const { recovery, withExecutionFixture } = require("./execution-episode-test-adapter");

test("session persistence keeps semantic facts and removes ephemeral candidate graphs", () => {
  const store = createStore({ dbPath: ":memory:" });
  const controls = Array.from({ length: 500 }, (_, index) => ({
    controlId: `control_${index}`,
    label: `Option ${index} ${"large context ".repeat(120)}`,
    operations: { activate: { actuatorId: `node_${index}`, strategies: [{ id: `strategy_${index}` }] } }
  }));
  const state = withUpdate(createCheckoutSessionState({ goal: "Reach payment review" }), {
    aiDecisionCache: { candidateSelection: { controls } },
    currentObservation: { page: { controls } },
    diagnosticReadModel: { controls },
    currentGoal: { goalId: "stale_root_goal", candidateSet: { contextCapabilities: controls } },
    currentObligation: { controls },
    taskState: {
      stage: "extras",
      currentGoal: {
        goalId: "goal_skip_bags",
        kind: "commerce_decision",
        semanticGoal: "Skip optional bags",
        decisionGroupId: "bags",
        candidateSet: { contextCapabilities: controls },
        candidates: controls
      },
      canonicalDecisions: [{
        decisionGroupId: "bags",
        semanticType: "baggage",
        status: "satisfied",
        observed: { selectedValue: "0", controls }
      }],
      suspendedDecisions: controls,
      previousActionResult: { action: { controls }, result: { controls } },
      activeDecisions: controls,
      disposition: { kind: "execute", code: "EXECUTE_CURRENT_OBLIGATION", obligationId: "goal_skip_bags" },
      processAwareness: { controls },
      semanticCompilation: { controls }
    }
  });

  store.saveSession(state);
  const persisted = store.getSession(state.id);
  const raw = JSON.stringify(persisted);

  assert.equal(persisted.currentGoal, undefined);
  assert.equal(persisted.currentObligation, undefined);
  assert.equal(persisted.currentObservation, undefined);
  assert.equal(persisted.aiDecisionCache, undefined);
  assert.equal(persisted.diagnosticReadModel, undefined);
  assert.equal(persisted.taskState.currentGoal, undefined);
  assert.equal(persisted.taskState.processAwareness, undefined);
  assert.equal(persisted.taskState.semanticCompilation, undefined);
  assert.equal(persisted.taskState.suspendedDecisions, undefined);
  assert.equal(persisted.taskState.previousActionResult, undefined);
  assert.equal(persisted.taskState.activeDecisions, undefined);
  assert.equal(persisted.taskState.disposition.kind, "execute");
  assert.equal(persisted.taskState.verificationDecisionMemory[0].status, "satisfied");
  assert.ok(Buffer.byteLength(raw) < 30_000, `persisted state was ${Buffer.byteLength(raw)} bytes`);
});

test("compact persistence preserves the target-local identity required to suppress a failed strategy", () => {
  const store = createStore({ dbPath: ":memory:" });
  const state = withExecutionFixture(createCheckoutSessionState({ goal: "Reach payment review" }), {
    recovery: {
      phase: "execution_no_effect",
      attempts: 1,
      failedStrategies: [{
        goalKey: "seat-selection@seat-surface",
        semanticGoalKey: "seat_selection|random_assignment",
        decisionInstanceId: "seat-decision",
        strategySignature: "browser_trusted_input:activate:skip-seat",
        controlId: "skip-seat",
        stableControlKey: "button|skip-seat-selection",
        targetId: "skip-seat-node",
        capability: "activate",
        operation: "activate",
        semanticEffect: "select_free_option",
        observationId: "obs_seats",
        pageStateHash: "seat-state-hash",
        actuatorStableKey: "button|skip-seat-selection::activate",
        surfaceInstanceKey: "surface-page|seats",
        targetLocalStateKey: "skip-seat|visible|enabled",
        failureCount: 2,
        code: "TRANSITION_NO_EFFECT"
      }],
      failedStrategySignatures: ["browser_trusted_input:activate:skip-seat"]
    }
  });

  store.saveSession(state);
  const [failure] = recovery(store.getSession(state.id)).failedStrategies;

  assert.deepEqual(failure, {
    goalKey: "seat-selection@seat-surface",
    semanticGoalKey: "seat_selection|random_assignment",
    decisionInstanceId: "seat-decision",
    strategySignature: "browser_trusted_input:activate:skip-seat",
    controlId: "skip-seat",
    stableControlKey: "button|skip-seat-selection",
    targetId: "skip-seat-node",
    capability: "activate",
    operation: "activate",
    semanticEffect: "select_free_option",
    observationId: "obs_seats",
    pageStateHash: "seat-state-hash",
    actuatorStableKey: "button|skip-seat-selection::activate",
    surfaceInstanceKey: "surface-page|seats",
    targetLocalStateKey: "skip-seat|visible|enabled",
    failureCount: 2,
    code: "TRANSITION_NO_EFFECT"
  });
});

test("one durable execution episode replaces parallel lifecycle and recovery copies", () => {
  const state = withExecutionFixture(withUpdate(createCheckoutSessionState({ goal: "Reach payment review" }), {
    taskState: {
      stage: "extras",
      currentObligation: {
        contractVersion: "current-obligation/v2",
        obligationId: "obligation_skip_bags",
        mechanics: { candidateControlIds: ["skip_bags"], legacyGoalGraph: { large: true } }
      }
    }
  }), {
    leasedAction: {
      semanticGoalId: "obligation_skip_bags",
      originalAction: { id: "action_skip_bags", type: "click", controlId: "skip_bags" }
    },
    lifecycle: { status: "dispatched", actionId: "action_skip_bags" },
    recovery: {
      phase: "execution_no_effect",
      attempts: 1,
      remainingAttempts: 2,
      failedStrategySignatures: ["trusted:activate:skip_bags"]
    },
    mechanicalEvidence: { kind: "goal_strategies_exhausted", controlId: "skip_bags" }
  });

  const compacted = compactSessionState(state);

  assert.equal(compacted.pendingAction, undefined);
  assert.equal(compacted.actionLifecycle, undefined);
  assert.equal(compacted.recoveryState, undefined);
  assert.equal(compacted.pendingMechanicalEvidence, undefined);
  assert.equal(compacted.taskState.currentObligation.mechanics, undefined);
  assert.equal(compacted.executionEpisode.contractVersion, "execution-episode/v2");
  assert.equal(compacted.executionEpisode.obligationId, "obligation_skip_bags");
  assert.equal(compacted.executionEpisode.status, "dispatched");
  assert.equal(compacted.executionEpisode.leasedAction.originalAction, undefined);
  assert.equal(compacted.executionEpisode.leasedAction.actionLease.actionId, "action_skip_bags");
  assert.equal(compacted.executionEpisode.leasedAction.actionLease.contractVersion, "action-lease/v1");
  assert.deepEqual(compacted.executionEpisode.failedStrategySignatures, ["trusted:activate:skip_bags"]);
  assert.equal(compacted.executionEpisode.attempts, 1);
  assert.equal(compacted.executionEpisode.remainingAttempts, 2);
  assert.deepEqual(compacted.executionEpisode.mechanicalEvidence, {
    kind: "goal_strategies_exhausted",
    controlId: "skip_bags"
  });
});

test("observation persistence retains metadata but only two active payloads", () => {
  const store = createStore({ dbPath: ":memory:" });
  const state = createCheckoutSessionState({ goal: "Reach payment review" });
  store.saveSession(state);

  for (let index = 0; index < 30; index += 1) {
    store.recordObservation(state.id, {
      observationId: `observation_${index}`,
      observationSnapshot: { snapshotHash: `hash_${index}` },
      page: { url: `https://example.test/checkout/${index}`, step: "extras", controls: [] }
    }, { updateSession: false });
  }

  const replay = store.reconstructTransaction(state.id);
  assert.equal(replay.observations.length, 30);
  assert.equal(replay.currentObservation.observationId, "observation_29");
  assert.equal(store.getObservation(state.id, "observation_0"), null);
  assert.equal(store.getObservation(state.id, "observation_27"), null);
  assert.equal(store.getObservation(state.id, "observation_28").observationId, "observation_28");
  assert.equal(store.getObservation(state.id, "observation_29").observationId, "observation_29");
  store.close();
});

test("a finalized governed action retains observation identity without pinning its full graph", () => {
  const store = createStore({ dbPath: ":memory:" });
  const state = createCheckoutSessionState({ goal: "Reach payment review" });
  store.saveSession(state);
  store.recordObservation(state.id, {
    observationId: "observation_action_source",
    observationSnapshot: { snapshotHash: "hash_action_source" },
    page: { url: "https://example.test/checkout", step: "extras", controls: [{ controlId: "skip_bags" }] }
  }, { updateSession: false });
  assert.equal(store.reserveGovernedAction({
    transactionId: state.id,
    turnId: "turn_1",
    observationId: "observation_action_source",
    observationHash: "hash_action_source",
    action: { id: "action_skip_bags", type: "click", controlId: "skip_bags", operation: "activate" }
  }).ok, true);
  store.updateGovernedAction("action_skip_bags", "verified", { verified: true });

  for (let index = 0; index < 4; index += 1) {
    store.recordObservation(state.id, {
      observationId: `observation_after_${index}`,
      observationSnapshot: { snapshotHash: `hash_after_${index}` },
      page: { url: `https://example.test/checkout/${index}`, step: "extras", controls: [] }
    }, { updateSession: false });
  }

  assert.equal(store.getObservation(state.id, "observation_action_source"), null);
  assert.equal(store.getGovernedAction("action_skip_bags").observation_id, "observation_action_source");
  assert.equal(store.reconstructTransaction(state.id).observations.length, 5);
  store.close();
});
