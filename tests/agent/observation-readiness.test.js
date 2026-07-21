const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyObservationReadiness, READINESS } = require("../../apps/web/agent/observation-readiness");
const { runLoopTurn } = require("../../apps/web/agent/loop");
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

test("post-navigation traveler shell waits three times, then becomes degraded", () => {
  const observation = shellObservation();
  let previous = {};
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const readiness = classifyObservationReadiness({ observation, previousReadiness: previous, maxTransientAttempts: 3 });
    assert.equal(readiness.classification, READINESS.TRANSIENT);
    assert.equal(readiness.attempts, attempt);
    previous = readiness;
  }
  const degraded = classifyObservationReadiness({ observation, previousReadiness: previous, maxTransientAttempts: 3 });
  assert.equal(degraded.classification, READINESS.DEGRADED);
  assert.equal(degraded.reason, "TRANSIENT_OBSERVATION_RETRY_EXHAUSTED");
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
