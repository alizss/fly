const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyObservationReadiness, READINESS } = require("../../apps/web/agent/observation-readiness");
const {
  advanceActionLifecycle,
  approveActionLifecycle,
  proposeActionLifecycle
} = require("../../apps/web/agent/action-lifecycle");
const { runLoopTurn } = require("../../apps/web/agent/loop");
const { decideStage } = require("../../apps/web/agent/task-state-reducer");
const { createCheckoutSessionState } = require("../../packages/shared/agent-state");

function operation(id) {
  return { activate: { actuatorId: id, actuatorIds: [id], actionability: { executable: true, revealable: false } } };
}

function shellObservation(id = "obs_shell") {
  return {
    observationId: id,
    observationSnapshot: { snapshotHash: `hash_${id}` },
    lastActionResult: {
      feedback: { navigationOccurred: true, pageChanged: true },
      action: { semanticIntent: "advance_checkout_stage", mechanicalEffect: "advance_checkout_stage" }
    },
    page: {
      step: "traveler_information",
      text: "Traveller information English Support My bookings",
      currentSurface: { id: "surface-page", type: "page", label: "Traveller information" },
      controls: [
        { controlId: "language", label: "English", semantic: "unknown", surfaceId: "surface-page", operations: operation("el_language") },
        { controlId: "support", label: "Support", semantic: "unknown", surfaceId: "surface-page", operations: operation("el_support") }
      ],
      decisionGroups: [],
      validationIssues: [],
      summary: { fields: 0, controls: 2, decisionGroups: 0 },
      readiness: { documentReadyState: "complete", ariaBusy: false, loadingIndicatorCount: 0, mainTextLength: 52, stableForMs: 80 }
    }
  };
}

test("post-navigation traveler shell waits beyond three observations until the wall-clock deadline", () => {
  const observation = shellObservation();
  const startedAt = 1_000_000;
  const deadlineAt = startedAt + 20_000;
  let previous = {};
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const readiness = classifyObservationReadiness({
      observation,
      previousReadiness: previous,
      readinessDeadlineAt: deadlineAt,
      nowMs: startedAt + (attempt * 1_000)
    });
    assert.equal(readiness.classification, READINESS.TRANSIENT);
    assert.equal(readiness.attempts, attempt);
    assert.equal(readiness.deadlineAt, deadlineAt);
    assert.equal(readiness.handoffEligible, false);
    previous = readiness;
  }
  const degraded = classifyObservationReadiness({
    observation,
    previousReadiness: previous,
    readinessDeadlineAt: deadlineAt,
    nowMs: deadlineAt
  });
  assert.equal(degraded.classification, READINESS.DEGRADED);
  assert.equal(degraded.reason, "DESTINATION_CONTENT_MISSING_AT_READINESS_DEADLINE");
  assert.equal(degraded.handoffEligible, true);
  assert.equal(degraded.deadlineExpired, true);
});

test("hydrated traveler controls make the next observation ready", () => {
  const shell = shellObservation();
  const transient = classifyObservationReadiness({ observation: shell });
  const readyObservation = {
    ...shell,
    observationId: "obs_ready",
    observationSnapshot: { snapshotHash: "hash_ready" },
    lastActionResult: null,
    page: {
      ...shell.page,
      text: "Traveller information Email First name Last name Continue",
      controls: [
        { controlId: "email", field: "email", semantic: "email", label: "Email", surfaceId: "surface-page", operations: { type: { actuatorId: "el_email", actuatorIds: ["el_email"], actionability: { executable: true } } } },
        { controlId: "continue", semantic: "continue", label: "Continue", surfaceId: "surface-page", operations: operation("el_continue") }
      ],
      summary: { fields: 1, controls: 2, decisionGroups: 0 },
      readiness: { documentReadyState: "complete", ariaBusy: false, loadingIndicatorCount: 0, mainTextLength: 60, stableForMs: 900 }
    }
  };
  const ready = classifyObservationReadiness({ observation: readyObservation, previousReadiness: transient });
  assert.equal(ready.classification, READINESS.READY);
  assert.equal(ready.attempts, 0);
});

test("strong payment evidence is ready even when ordinary payment actions are suppressed", () => {
  const observation = shellObservation("obs_payment_ready");
  observation.page = {
    ...observation.page,
    step: "unknown",
    url: "https://example.test/checkout/payment",
    text: "Payment details. Choose payment method. Review the order amount and total to pay.",
    currentSurface: { id: "surface-page", type: "page", label: "Payment details" },
    controls: [{
      controlId: "purchase",
      label: "Pay now",
      semantic: "submit_payment",
      risk: "payment",
      surfaceId: "surface-page",
      operations: operation("el_purchase")
    }],
    summary: { fields: 0, controls: 1, decisionGroups: 0 },
    readiness: { documentReadyState: "complete", ariaBusy: false, loadingIndicatorCount: 0, mainTextLength: 100, stableForMs: 900 }
  };
  const ready = classifyObservationReadiness({ observation });
  assert.equal(ready.classification, READINESS.READY);
  assert.equal(ready.evidence.strongPaymentEvidence, true);
});

test("loop returns wait before TaskState reduction and never hands off a transient shell", async () => {
  const state = createCheckoutSessionState({
    goal: "Reach payment review",
    travelerId: "trav_ready",
    site: { host: "example.test", url: "https://example.test/checkout/traveler" }
  });
  state.taskState = { sentinel: "preserved_before_ready" };
  const result = await runLoopTurn({
    apiKey: "",
    model: "must-not-be-called",
    dataDir: "",
    state,
    observation: shellObservation("obs_loop_shell"),
    traveler: { id: "trav_ready" }
  });
  assert.equal(result.clientDecision.action, "wait");
  assert.equal(result.clientDecision.semanticIntent, "wait_for_ready_observation");
  assert.equal(result.state.status, "running");
  assert.equal(result.state.taskState.sentinel, "preserved_before_ready");
  assert.equal(result.state.observationReadiness.classification, READINESS.TRANSIENT);
  assert.equal(result.debug.modelCalled, false);
});

test("generic order-summary payment copy cannot override real traveler controls", () => {
  const observation = shellObservation("obs_traveler_with_order_summary");
  observation.page = {
    ...observation.page,
    url: "https://example.test/checkout/traveler",
    heading: "Traveller information",
    text: "Traveller information. Your order. Payment options. Amount to pay 420 EUR.",
    controls: [{
      controlId: "email",
      fieldType: "email",
      semantic: "email",
      surfaceId: "surface-page",
      operations: { type: { actuatorId: "el_email", actionability: { executable: true } } }
    }],
    sections: [{
      sectionId: "order",
      type: "order_summary",
      label: "Payment options Amount to pay"
    }]
  };
  const stage = decideStage(observation);
  assert.equal(stage.stage, "traveler_information");
  assert.equal(stage.evidence.payment.orderSection, true);
  assert.equal(stage.evidence.paymentSignals, 0);
});

test("many generic shell controls remain transient until destination semantics appear", () => {
  const observation = shellObservation("obs_busy_shell_without_busy_flag");
  observation.page.controls = Array.from({ length: 9 }, (_, index) => ({
    controlId: `header_${index}`,
    label: `Header action ${index}`,
    semantic: "unknown",
    surfaceId: "surface-page",
    operations: operation(`el_header_${index}`)
  }));
  observation.page.summary = { fields: 0, controls: 9, decisionGroups: 0 };
  const readiness = classifyObservationReadiness({ observation });
  assert.equal(readiness.classification, READINESS.TRANSIENT);
  assert.equal(readiness.evidence.controls, 9);
  assert.equal(readiness.evidence.incompleteStage, true);
});

test("navigation remains open through hydration and closes only when destination is usable", () => {
  const action = {
    id: "act_advance_to_traveler",
    observationId: "obs_extras_before",
    type: "click",
    controlId: "ctrl_advance",
    semanticIntent: "advance_checkout_stage",
    mechanicalEffect: "advance_checkout_stage",
    expectedOutcome: { type: "checkout_stage_advanced" }
  };
  const before = {
    observationId: "obs_extras_before",
    observationSnapshot: { snapshotHash: "hash_extras_before" },
    page: {
      step: "extras",
      url: "https://example.test/checkout/extras",
      heading: "Optional extras",
      currentSurface: { id: "surface-page", type: "page", label: "Optional extras" },
      controls: [{
        controlId: "ctrl_advance",
        semantic: "navigation",
        physicalEffect: "advance_checkout_stage",
        surfaceId: "surface-page",
        operations: operation("el_advance")
      }],
      decisionGroups: [{
        decisionGroupId: "dg_extra",
        family: "extras",
        status: "satisfied",
        surfaceId: "surface-page"
      }],
      readiness: { documentReadyState: "complete", ariaBusy: false, loadingIndicatorCount: 0, mainTextLength: 40, stableForMs: 500 }
    }
  };
  const shell = shellObservation("obs_traveler_shell_after_click");
  shell.page.url = "https://example.test/checkout/traveler";
  shell.lastActionResult = {
    actionId: action.id,
    dispatched: true,
    executed: true,
    action,
    feedback: { navigationOccurred: true, pageChanged: true }
  };
  const lifecycle = approveActionLifecycle(proposeActionLifecycle(action, before));
  const transient = classifyObservationReadiness({ observation: shell });
  const held = advanceActionLifecycle({
    state: { lastAction: action, actionLifecycle: lifecycle },
    observation: shell,
    previousObservation: before,
    observationReadiness: transient
  });
  assert.equal(held.lifecycle.status, "waiting_for_destination");
  assert.equal(held.lifecycle.closed, false);
  assert.equal(held.transition, null);

  const readyObservation = {
    ...shell,
    observationId: "obs_traveler_ready_after_click",
    observationSnapshot: { snapshotHash: "hash_traveler_ready_after_click" },
    page: {
      ...shell.page,
      heading: "Traveller information",
      text: "Traveller information Email First name",
      controls: [{
        controlId: "email",
        fieldType: "email",
        semantic: "email",
        surfaceId: "surface-page",
        operations: { type: { actuatorId: "el_email", actionability: { executable: true } } }
      }],
      summary: { fields: 1, controls: 1, decisionGroups: 0 },
      readiness: { documentReadyState: "complete", ariaBusy: false, loadingIndicatorCount: 0, mainTextLength: 45, stableForMs: 800 }
    }
  };
  const ready = classifyObservationReadiness({
    observation: readyObservation,
    previousReadiness: transient
  });
  const closed = advanceActionLifecycle({
    state: held.state,
    observation: readyObservation,
    previousObservation: shell,
    observationReadiness: ready
  });
  assert.equal(ready.classification, READINESS.READY);
  assert.equal(closed.transition.status, "achieved");
  assert.equal(closed.lifecycle.status, "verified");
  assert.equal(closed.lifecycle.closed, true);
});
