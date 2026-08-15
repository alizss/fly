const test = require("node:test");
const assert = require("node:assert/strict");

const {
  classifyObservationReadiness,
  navigationShaped,
  READINESS
} = require("../../apps/web/agent/observation-readiness");
const {
  advanceActionLifecycle,
  approveActionLifecycle,
  proposeActionLifecycle
} = require("../../apps/web/agent/action-lifecycle");

function operation(id, executable = true) {
  return {
    activate: {
      actuatorId: id,
      actuatorIds: [id],
      actionability: { executable, revealable: false }
    }
  };
}

function observation({
  id = "obs",
  hash = `hash_${id}`,
  url = "https://example.test/checkout",
  step = "unknown",
  stableForMs = 800,
  controls = [],
  loading = false,
  lastActionResult = null,
  surface = { id: "surface-page", type: "page", blocksBackground: false }
} = {}) {
  return {
    observationId: id,
    observationSnapshot: { snapshotHash: hash },
    lastActionResult,
    page: {
      url,
      step,
      currentSurface: surface,
      controls,
      decisionGroups: [],
      validationIssues: [],
      summary: { controls: controls.length, fields: 0, decisionGroups: 0 },
      readiness: {
        documentReadyState: loading ? "loading" : "complete",
        ariaBusy: loading,
        loadingIndicatorCount: loading ? 1 : 0,
        loadingTextEvidence: loading,
        stableForMs
      }
    }
  };
}

function dispatchedNavigation(actionId = "act_next") {
  return {
    actionId,
    dispatched: true,
    action: { id: actionId, mechanicalEffect: "advance_checkout_stage" },
    feedback: { navigationOccurred: true, pageChanged: true }
  };
}

test("declared navigation intent without dispatch is not destination-wait evidence", () => {
  const current = observation({
    controls: [{ controlId: "next", operations: operation("next_node") }],
    lastActionResult: {
      actionId: "act_next",
      dispatched: false,
      action: { id: "act_next", mechanicalEffect: "advance_checkout_stage" },
      failureCode: "FAILED_STRATEGY_REUSE"
    }
  });
  const navigationContext = {
    lifecycle: {
      actionId: "act_next",
      status: "rejected_before_dispatch",
      dispatched: false,
      closed: true,
      navigation: true
    }
  };

  assert.equal(navigationShaped(current, { classification: READINESS.TRANSIENT }, navigationContext), false);
  const readiness = classifyObservationReadiness({ observation: current, navigationContext });
  assert.equal(readiness.classification, READINESS.READY);
  assert.equal(readiness.evidence.actionDispatched, false);
});

test("readiness does not infer traveler, seats, extras, or payment meaning", () => {
  const mechanics = [{ controlId: "control", operations: operation("node") }];
  const stages = ["traveler_information", "seats", "extras", "payment"];
  const results = stages.map((step) => classifyObservationReadiness({
    observation: observation({ id: `obs_${step}`, step, controls: mechanics })
  }));

  assert.deepEqual(results.map((item) => item.classification), stages.map(() => READINESS.READY));
  for (const result of results) {
    assert.equal(Object.hasOwn(result.evidence, "expectedStage"), false);
    assert.equal(Object.hasOwn(result.evidence, "strongPaymentEvidence"), false);
    assert.equal(Object.hasOwn(result.evidence, "controllerReady"), false);
  }
});

test("a dispatched action hands off immediately when the fresh surface is mechanically usable", () => {
  const actionResult = dispatchedNavigation();
  const settling = observation({
    id: "obs_settling",
    stableForMs: 120,
    controls: [{ controlId: "header", operations: operation("header_node") }],
    lastActionResult: actionResult
  });
  const navigationContext = {
    result: actionResult,
    lifecycle: {
      actionId: "act_next",
      status: "dispatched",
      dispatched: true,
      closed: false,
      awaitingDestination: true
    }
  };
  const usable = classifyObservationReadiness({ observation: settling, navigationContext, nowMs: 1_000 });
  assert.equal(usable.classification, READINESS.READY);
  assert.equal(usable.reason, "STABLE_USABLE_OBSERVATION");

  const stable = observation({
    id: "obs_stable",
    stableForMs: 800,
    controls: [{ controlId: "header", operations: operation("header_node") }],
    lastActionResult: actionResult
  });
  const ready = classifyObservationReadiness({
    observation: stable,
    previousReadiness: usable,
    navigationContext,
    nowMs: 1_800
  });
  assert.equal(ready.classification, READINESS.READY);
  assert.equal(ready.reason, "STABLE_USABLE_OBSERVATION");
});

test("a dispatched empty surface is temporarily incomplete until its deadline", () => {
  const result = dispatchedNavigation("act_empty");
  const current = observation({ id: "obs_empty", controls: [], stableForMs: 900, lastActionResult: result });
  const navigationContext = {
    result,
    lifecycle: {
      actionId: "act_empty",
      status: "waiting_for_destination",
      dispatched: true,
      closed: false,
      awaitingDestination: true
    }
  };
  const transient = classifyObservationReadiness({
    observation: current,
    navigationContext,
    nowMs: 10_000,
    readinessTimeoutMs: 2_000
  });
  assert.equal(transient.classification, READINESS.TRANSIENT);
  assert.equal(transient.reason, "POST_ACTION_SURFACE_TEMPORARILY_INCOMPLETE");

  const expired = classifyObservationReadiness({
    observation: current,
    previousReadiness: transient,
    navigationContext,
    readinessDeadlineAt: transient.deadlineAt,
    nowMs: transient.deadlineAt
  });
  assert.equal(expired.classification, READINESS.READY);
  assert.equal(expired.reason, "STABLE_DESTINATION_CONTROLLER_HANDOFF");
});

test("genuine loading is bounded and degrades at the mechanical deadline", () => {
  const result = dispatchedNavigation("act_loading");
  const current = observation({ id: "obs_loading", controls: [], loading: true, lastActionResult: result });
  const navigationContext = {
    result,
    lifecycle: {
      actionId: "act_loading",
      status: "waiting_for_destination",
      dispatched: true,
      closed: false,
      awaitingDestination: true
    }
  };
  const transient = classifyObservationReadiness({
    observation: current,
    navigationContext,
    nowMs: 20_000,
    readinessTimeoutMs: 1_000
  });
  assert.equal(transient.classification, READINESS.TRANSIENT);
  assert.equal(transient.reason, "PAGE_LOADING");

  const degraded = classifyObservationReadiness({
    observation: current,
    previousReadiness: transient,
    navigationContext,
    readinessDeadlineAt: transient.deadlineAt,
    nowMs: transient.deadlineAt
  });
  assert.equal(degraded.classification, READINESS.DEGRADED);
  assert.equal(degraded.handoffEligible, true);
});

test("a prior transient state cannot perpetuate waiting after the action closes", () => {
  const previous = {
    classification: READINESS.TRANSIENT,
    key: "old",
    attempts: 7,
    startedAt: 1,
    deadlineAt: 30_000
  };
  const current = observation({
    id: "obs_closed",
    controls: [{ controlId: "next", operations: operation("next_node") }]
  });
  const readiness = classifyObservationReadiness({
    observation: current,
    previousReadiness: previous,
    navigationContext: {
      lifecycle: { actionId: "act_old", dispatched: true, closed: true, status: "failed" }
    },
    nowMs: 2_000
  });
  assert.equal(readiness.classification, READINESS.READY);
  assert.equal(readiness.attempts, 0);
});

test("navigation lifecycle closes on the first mechanically usable destination frame", () => {
  const action = {
    id: "act_advance",
    observationId: "obs_before",
    type: "click",
    controlId: "next",
    semanticIntent: "advance_checkout_stage",
    mechanicalEffect: "advance_checkout_stage",
    expectedOutcome: { type: "checkout_stage_advanced" }
  };
  const before = observation({
    id: "obs_before",
    controls: [{ controlId: "next", operations: operation("next_node") }]
  });
  const result = { ...dispatchedNavigation(action.id), action };
  const shell = observation({
    id: "obs_shell",
    stableForMs: 100,
    controls: [{ controlId: "header", operations: operation("header_node") }],
    lastActionResult: result
  });
  const lifecycle = approveActionLifecycle(proposeActionLifecycle(action, before));
  const navigationContext = { result, lifecycle: { ...lifecycle, dispatched: true, status: "dispatched" } };
  const ready = classifyObservationReadiness({ observation: shell, navigationContext });
  const closed = advanceActionLifecycle({
    state: { lastAction: action, actionLifecycle: lifecycle },
    observation: shell,
    previousObservation: before,
    observationReadiness: ready
  });
  assert.equal(ready.classification, READINESS.READY);
  assert.equal(closed.transition.status, "observed_change");
  assert.equal(closed.lifecycle.closed, true);
});

test("an action-scoped navigation episode cannot be negatively closed by its still-usable source document", () => {
  const action = {
    id: "act_cross_document",
    observationId: "obs_source",
    type: "click",
    intent: "navigate_stage",
    mechanicalEffect: "advance_to_payment",
    expectedOutcome: { type: "payment_entry_reached" }
  };
  const before = observation({
    id: "obs_source",
    url: "https://booking.example/review",
    controls: [{ controlId: "confirm", operations: operation("confirm_node") }]
  });
  const pendingResult = {
    actionId: action.id,
    dispatched: true,
    executed: true,
    action,
    failureCode: "NAVIGATION_TRANSITION_PENDING"
  };
  const sourceAfterDispatch = observation({
    id: "obs_source_after_dispatch",
    url: "https://booking.example/review",
    controls: [{ controlId: "confirm", operations: operation("confirm_node") }],
    lastActionResult: pendingResult
  });
  const ready = classifyObservationReadiness({
    observation: sourceAfterDispatch,
    navigationContext: {
      result: pendingResult,
      lifecycle: { actionId: action.id, dispatched: true, closed: false, awaitingDestination: true }
    }
  });
  const advanced = advanceActionLifecycle({
    state: {
      lastAction: action,
      executionEpisode: {
        actionId: action.id,
        observationId: before.observationId,
        navigation: true,
        navigationEpisodeId: `navigation:session:${action.id}`,
        navigationStatus: "ARMED",
        status: "navigation_armed",
        dispatched: false,
        closed: false,
        awaitingDestination: true,
        sourceDocument: { documentId: "source_document", url: before.page.url },
        destinationDocument: null
      }
    },
    observation: sourceAfterDispatch,
    previousObservation: before,
    observationReadiness: ready
  });

  assert.equal(ready.classification, READINESS.READY);
  assert.equal(advanced.transition, null);
  assert.equal(advanced.directive, "reobserve_destination");
  assert.equal(advanced.lifecycle.status, "waiting_for_destination");
  assert.equal(advanced.lifecycle.navigationStatus, "DISPATCHED");
  assert.equal(advanced.lifecycle.closed, false);
  assert.equal(advanced.lifecycle.awaitingDestination, true);
});

test("a stale controller result cannot replace the action owned by an open navigation episode", () => {
  const currentAction = {
    id: "act_provider_continue",
    observationId: "obs_payment_setup",
    type: "click",
    intent: "navigate_stage",
    mechanicalEffect: "advance_to_payment",
    expectedOutcome: { type: "payment_entry_reached" }
  };
  const staleAction = {
    id: "act_previous_confirm",
    observationId: "obs_review",
    type: "click",
    intent: "navigate_stage",
    mechanicalEffect: "advance_checkout_stage"
  };
  const current = observation({
    id: "obs_payment_setup_after_dispatch",
    url: "https://airline.example/PaymentForm",
    controls: [{ controlId: "continue", operations: operation("continue_node") }],
    lastActionResult: {
      actionId: staleAction.id,
      dispatched: true,
      executed: true,
      action: staleAction,
      failureCode: "NAVIGATION_TRANSITION_PENDING"
    }
  });
  const state = {
    lastAction: currentAction,
    executionEpisode: {
      actionId: currentAction.id,
      observationId: currentAction.observationId,
      status: "navigation_armed",
      navigation: true,
      navigationEpisodeId: `navigation:session:${currentAction.id}`,
      navigationStatus: "ARMED",
      dispatched: false,
      closed: false,
      awaitingDestination: true,
      destinationDocument: null
    }
  };

  const advanced = advanceActionLifecycle({ state, observation: current });

  assert.equal(advanced.directive, "reobserve_destination");
  assert.equal(advanced.transition, null);
  assert.equal(advanced.lifecycle.actionId, currentAction.id);
  assert.equal(advanced.state.executionEpisode.actionId, currentAction.id);
  assert.equal(advanced.state.executionEpisode.navigationEpisodeId, `navigation:session:${currentAction.id}`);
  assert.equal(advanced.observation.lastActionResult.ignoredByExecutionEpisode, true);
  assert.equal(advanced.observation.lastActionResult.causality.code, "STALE_ACTION_DURING_NAVIGATION");
});

test("the source document may positively verify a same-document checkout stage transition", () => {
  const action = {
    id: "act_spa_continue",
    observationId: "obs_spa_before",
    type: "click",
    intent: "advance_checkout_stage",
    mechanicalEffect: "advance_checkout_stage",
    expectedOutcome: { type: "checkout_stage_advanced" }
  };
  const before = observation({
    id: "obs_spa_before",
    step: "review",
    url: "https://booking.example/checkout",
    controls: [{ controlId: "continue", operations: operation("continue_node") }]
  });
  const pendingResult = {
    actionId: action.id,
    dispatched: true,
    executed: true,
    action,
    failureCode: "NAVIGATION_TRANSITION_PENDING"
  };
  const after = observation({
    id: "obs_spa_after",
    step: "payment_setup",
    url: "https://booking.example/checkout#payment",
    controls: [{ controlId: "payment_method", operations: operation("payment_method_node") }],
    lastActionResult: pendingResult
  });
  const ready = classifyObservationReadiness({
    observation: after,
    navigationContext: {
      result: pendingResult,
      lifecycle: { actionId: action.id, dispatched: true, closed: false, awaitingDestination: true }
    }
  });
  const advanced = advanceActionLifecycle({
    state: {
      lastAction: action,
      executionEpisode: {
        actionId: action.id,
        observationId: before.observationId,
        navigation: true,
        navigationEpisodeId: `navigation:session:${action.id}`,
        navigationStatus: "DISPATCHED",
        status: "waiting_for_destination",
        dispatched: true,
        closed: false,
        awaitingDestination: true,
        sourceDocument: { documentId: "same_document", url: before.page.url },
        destinationDocument: null
      }
    },
    observation: after,
    previousObservation: before,
    observationReadiness: ready
  });

  assert.equal(advanced.transition.status, "achieved");
  assert.equal(advanced.directive, "advance_goal");
  assert.equal(advanced.lifecycle.navigationStatus, "VERIFIED");
  assert.equal(advanced.lifecycle.closed, true);
});
