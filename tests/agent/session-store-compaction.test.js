const test = require("node:test");
const assert = require("node:assert/strict");

const { createStore } = require("../../apps/web/agent/session-store");
const { createCheckoutSessionState, withUpdate } = require("../../packages/shared/agent-state");

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
  const state = withUpdate(createCheckoutSessionState({ goal: "Reach payment review" }), {
    recoveryState: {
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
  const [failure] = store.getSession(state.id).recoveryState.failedStrategies;

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
