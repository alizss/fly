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
        mainAriaBusy: loading,
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
  const sourceUrl = "https://example.test/passengers";
  const destinationUrl = "https://example.test/extras";
  const settling = observation({
    id: "obs_settling",
    url: destinationUrl,
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
      awaitingDestination: true,
      origin: {
        url: sourceUrl,
        surfaceId: "surface-page",
        progressFingerprint: JSON.stringify({})
      }
    }
  };
  const usable = classifyObservationReadiness({ observation: settling, navigationContext, nowMs: 1_000 });
  assert.equal(usable.classification, READINESS.READY);
  assert.equal(usable.reason, "STABLE_USABLE_OBSERVATION");

  const stable = observation({
    id: "obs_stable",
    url: destinationUrl,
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
  const current = observation({
    id: "obs_empty",
    url: "https://example.test/destination",
    controls: [],
    stableForMs: 900,
    lastActionResult: result
  });
  const navigationContext = {
    result,
    lifecycle: {
      actionId: "act_empty",
      status: "waiting_for_destination",
      dispatched: true,
      closed: false,
      awaitingDestination: true,
      origin: {
        url: "https://example.test/source",
        surfaceId: "surface-page",
        progressFingerprint: JSON.stringify({})
      }
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
  const current = observation({
    id: "obs_loading",
    url: "https://example.test/destination",
    controls: [],
    loading: true,
    lastActionResult: result
  });
  const navigationContext = {
    result,
    lifecycle: {
      actionId: "act_loading",
      status: "waiting_for_destination",
      dispatched: true,
      closed: false,
      awaitingDestination: true,
      origin: {
        url: "https://example.test/source",
        surfaceId: "surface-page",
        progressFingerprint: JSON.stringify({})
      }
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

test("the browser settlement deadline is authoritative on the first backend loading observation", () => {
  const result = dispatchedNavigation("act_browser_deadline");
  const current = observation({
    id: "obs_browser_deadline",
    controls: [],
    loading: true,
    lastActionResult: result
  });
  const browserDeadlineAt = 41_000;
  const browserStartedAt = 21_000;
  const readiness = classifyObservationReadiness({
    observation: current,
    navigationContext: {
      result,
      lifecycle: {
        actionId: "act_browser_deadline",
        status: "waiting_for_destination",
        dispatched: true,
        closed: false,
        awaitingDestination: true
      }
    },
    readinessStartedAt: browserStartedAt,
    readinessDeadlineAt: browserDeadlineAt,
    nowMs: 40_500,
    readinessTimeoutMs: 20_000
  });

  assert.equal(readiness.classification, READINESS.TRANSIENT);
  assert.equal(readiness.startedAt, browserStartedAt);
  assert.equal(readiness.deadlineAt, browserDeadlineAt);
  assert.equal(readiness.remainingMs, 500);
});

test("a later readiness observation cannot extend the original settlement deadline", () => {
  const result = dispatchedNavigation("act_immutable_deadline");
  const current = observation({
    id: "obs_immutable_deadline",
    controls: [],
    loading: true,
    lastActionResult: result
  });
  const navigationContext = {
    result,
    lifecycle: {
      actionId: "act_immutable_deadline",
      status: "waiting_for_destination",
      dispatched: true,
      closed: false,
      awaitingDestination: true
    }
  };
  const first = classifyObservationReadiness({
    observation: current,
    navigationContext,
    readinessDeadlineAt: 51_000,
    nowMs: 50_000
  });
  const redirected = observation({
    id: "obs_immutable_deadline_redirected",
    url: "https://payments.example.test/hosted",
    controls: [],
    loading: true,
    lastActionResult: result
  });
  const repeated = classifyObservationReadiness({
    observation: redirected,
    previousReadiness: first,
    navigationContext,
    readinessDeadlineAt: 70_000,
    nowMs: 50_500
  });

  assert.equal(repeated.deadlineAt, 51_000);
  assert.equal(repeated.startedAt, first.startedAt);
  assert.equal(repeated.attempts, 2);
});

test("an unrelated busy indicator cannot block an executable settled surface", () => {
  const current = observation({
    id: "obs_local_spinner",
    controls: [{ controlId: "continue", operations: operation("continue_node") }],
    loading: true
  });
  current.page.readiness.documentReadyState = "complete";
  current.page.readiness.mainAriaBusy = false;
  current.page.readiness.loadingTextEvidence = false;

  const readiness = classifyObservationReadiness({ observation: current, nowMs: 60_000 });
  assert.equal(readiness.classification, READINESS.READY);
  assert.equal(readiness.evidence.loadingSignal, true);
  assert.equal(readiness.evidence.explicitLoading, false);
  assert.equal(readiness.evidence.mechanicallyUsable, true);
});

test("loading remains blocking while the exact stage exit is unsettled", () => {
  const result = dispatchedNavigation("act_pending_with_controls");
  const current = observation({
    id: "obs_pending_with_controls",
    controls: [{ controlId: "source_confirm", operations: operation("source_confirm_node") }],
    loading: true,
    lastActionResult: {
      ...result,
      actionOutcome: {
        status: "DESTINATION_LOADING",
        code: "NAVIGATION_TRANSITION_PENDING"
      }
    }
  });
  current.page.readiness.documentReadyState = "complete";

  const readiness = classifyObservationReadiness({
    observation: current,
    navigationContext: {
      result: current.lastActionResult,
      lifecycle: {
        actionId: "act_pending_with_controls",
        status: "waiting_for_destination",
        dispatched: true,
        closed: false,
        awaitingDestination: true
      }
    },
    nowMs: 70_000
  });
  assert.equal(readiness.classification, READINESS.TRANSIENT);
  assert.equal(readiness.evidence.pendingSettlement, true);
  assert.equal(readiness.evidence.explicitLoading, true);
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

test("an unchanged usable source page cannot close or replan an unsettled navigation", () => {
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
  const result = {
    ...dispatchedNavigation(action.id),
    action,
    actionOutcome: {
      status: "DESTINATION_LOADING",
      code: "NAVIGATION_TRANSITION_PENDING"
    }
  };
  const shell = observation({
    id: "obs_shell",
    stableForMs: 100,
    controls: [{ controlId: "header", operations: operation("header_node") }],
    lastActionResult: result
  });
  const lifecycle = approveActionLifecycle(proposeActionLifecycle(action, before));
  const navigationContext = {
    result,
    lifecycle: {
      ...lifecycle,
      dispatched: true,
      status: "waiting_for_destination",
      awaitingDestination: true
    }
  };
  const readiness = classifyObservationReadiness({ observation: shell, navigationContext });
  const waiting = advanceActionLifecycle({
    state: { lastAction: action, actionLifecycle: lifecycle },
    observation: shell,
    previousObservation: before,
    observationReadiness: readiness
  });
  assert.equal(readiness.classification, READINESS.TRANSIENT);
  assert.equal(readiness.reason, "NAVIGATION_ACTION_STILL_UNSETTLED");
  assert.equal(readiness.evidence.mechanicallyUsable, true);
  assert.equal(readiness.evidence.destinationChange.changed, false);
  assert.equal(waiting.transition, null);
  assert.equal(waiting.lifecycle.closed, false);
  assert.equal(waiting.lifecycle.awaitingDestination, true);
  assert.equal(waiting.directive, "reobserve_destination");
});

test("an unchanged source returns to bounded action recovery only after the navigation deadline", () => {
  const action = {
    id: "act_expired_navigation",
    observationId: "obs_expired_source",
    type: "click",
    controlId: "next",
    intent: "navigate_stage",
    mechanicalEffect: "advance_checkout_stage",
    expectedOutcome: { type: "stage_exit_or_feedback", controlId: "next" }
  };
  const before = observation({
    id: "obs_expired_source",
    controls: [{ controlId: "next", operations: operation("next_node") }]
  });
  const result = {
    ...dispatchedNavigation(action.id),
    action,
    actionOutcome: {
      status: "DESTINATION_LOADING",
      code: "NAVIGATION_TRANSITION_PENDING"
    }
  };
  const unchanged = observation({
    id: "obs_expired_result",
    controls: [{ controlId: "next", operations: operation("next_node") }],
    lastActionResult: result
  });
  const lifecycle = {
    ...approveActionLifecycle(proposeActionLifecycle(action, before)),
    dispatched: true,
    status: "waiting_for_destination",
    awaitingDestination: true
  };
  const readiness = classifyObservationReadiness({
    observation: unchanged,
    navigationContext: { result, lifecycle },
    readinessStartedAt: 1_000,
    readinessDeadlineAt: 2_000,
    nowMs: 2_000
  });
  const recovered = advanceActionLifecycle({
    state: { lastAction: action, actionLifecycle: lifecycle },
    observation: unchanged,
    previousObservation: before,
    observationReadiness: readiness
  });

  assert.equal(readiness.classification, READINESS.READY);
  assert.equal(readiness.reason, "NAVIGATION_SETTLEMENT_DEADLINE_EXPIRED");
  assert.equal(recovered.lifecycle.closed, true);
  assert.equal(recovered.lifecycle.status, "failed");
  assert.equal(recovered.directive, "try_distinct_capability");
});

test("a structurally proven destination may settle the navigation lifecycle", () => {
  const action = {
    id: "act_destination",
    observationId: "obs_source",
    type: "click",
    controlId: "next",
    semanticIntent: "advance_checkout_stage",
    mechanicalEffect: "advance_checkout_stage",
    expectedOutcome: { type: "checkout_stage_advanced" }
  };
  const before = observation({
    id: "obs_source",
    url: "https://example.test/passengers",
    controls: [{ controlId: "next", operations: operation("next_node") }]
  });
  const result = {
    ...dispatchedNavigation(action.id),
    action,
    actionOutcome: {
      status: "DESTINATION_LOADING",
      code: "NAVIGATION_TRANSITION_PENDING"
    }
  };
  const destination = observation({
    id: "obs_destination",
    url: "https://example.test/extras",
    controls: [{ controlId: "extras_continue", operations: operation("extras_continue_node") }],
    lastActionResult: result
  });
  const lifecycle = approveActionLifecycle(proposeActionLifecycle(action, before));
  const dispatchedLifecycle = {
    ...lifecycle,
    dispatched: true,
    status: "waiting_for_destination",
    awaitingDestination: true
  };
  const readiness = classifyObservationReadiness({
    observation: destination,
    navigationContext: { result, lifecycle: dispatchedLifecycle }
  });
  const settled = advanceActionLifecycle({
    state: { lastAction: action, actionLifecycle: dispatchedLifecycle },
    observation: destination,
    previousObservation: before,
    observationReadiness: readiness
  });

  assert.equal(readiness.classification, READINESS.READY);
  assert.deepEqual(readiness.evidence.destinationChange.evidence, ["url"]);
  assert.equal(settled.lifecycle.closed, true);
  assert.notEqual(settled.directive, "reobserve_destination");
});
