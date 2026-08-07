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
      processAwareness: { controls },
      semanticCompilation: { controls }
    }
  });

  store.saveSession(state);
  const persisted = store.getSession(state.id);
  const raw = JSON.stringify(persisted);

  assert.equal(persisted.currentGoal, undefined);
  assert.equal(persisted.currentObligation, undefined);
  assert.equal(persisted.taskState.currentGoal.goalId, "goal_skip_bags");
  assert.equal(persisted.taskState.currentGoal.candidateSet, undefined);
  assert.equal(persisted.taskState.currentGoal.candidates, undefined);
  assert.equal(persisted.taskState.processAwareness, undefined);
  assert.equal(persisted.taskState.semanticCompilation, undefined);
  assert.equal(persisted.taskState.canonicalDecisions[0].status, "satisfied");
  assert.ok(Buffer.byteLength(raw) < 30_000, `persisted state was ${Buffer.byteLength(raw)} bytes`);
});
