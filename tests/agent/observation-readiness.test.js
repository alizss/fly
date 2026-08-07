const test = require("node:test");
const assert = require("node:assert/strict");
const {
  classifyObservationReadiness,
  expectedDestinationStage,
  READINESS
} = require("../../apps/web/agent/observation-readiness");
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
  let deadlineAt = 0;
  let previous = {};
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const readiness = classifyObservationReadiness({
      observation,
      previousReadiness: previous,
      readinessDeadlineAt: deadlineAt,
      nowMs: startedAt + (attempt * 1_000)
    });
    if (!deadlineAt) deadlineAt = readiness.deadlineAt;
    assert.equal(readiness.classification, READINESS.TRANSIENT);
    assert.equal(readiness.attempts, attempt);
    assert.equal(readiness.deadlineAt, deadlineAt);
    assert.equal(readiness.handoffEligible, false);
    previous = readiness;
  }
  const controllerHandoff = classifyObservationReadiness({
    observation,
    previousReadiness: previous,
    readinessDeadlineAt: deadlineAt,
    nowMs: deadlineAt
  });
  assert.equal(controllerHandoff.classification, READINESS.READY);
  assert.equal(controllerHandoff.reason, "STABLE_DESTINATION_CONTROLLER_HANDOFF");
  assert.equal(controllerHandoff.handoffEligible, false);
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

test("seat loading copy outranks baggage and insurance query parameters until seat controls hydrate", () => {
  const shell = shellObservation("obs_kiwi_seat_loading_shell");
  shell.page = {
    ...shell.page,
    step: "seats",
    url: "https://www.kiwi.com/en/booking/?activeStep=2&holdBags=15kg&insurance=0",
    heading: "Select your seats",
    text: "Select your seats. Please wait for the seating options to load.",
    controls: [
      { controlId: "currency", label: "TRY", semantic: "unknown", surfaceId: "surface-page", operations: operation("el_currency") },
      { controlId: "price", label: "View price breakdown", semantic: "open_surface", surfaceId: "surface-page", operations: operation("el_price") }
    ],
    decisionGroups: [{
      decisionGroupId: "summary_baggage",
      semanticType: "baggage",
      surfaceId: "surface-page",
      status: "satisfied"
    }],
    summary: { fields: 0, controls: 2, decisionGroups: 1 },
    readiness: {
      documentReadyState: "complete",
      ariaBusy: false,
      loadingIndicatorCount: 0,
      loadingTextEvidence: true,
      mainTextLength: 68,
      stableForMs: 348
    }
  };

  assert.equal(expectedDestinationStage(shell.page), "seats");
  const transient = classifyObservationReadiness({ observation: shell });
  assert.equal(transient.classification, READINESS.TRANSIENT);
  assert.equal(transient.reason, "PAGE_LOADING");
  assert.equal(transient.handoffEligible, false);

  const hydrated = {
    ...shell,
    observationId: "obs_kiwi_seat_hydrated",
    observationSnapshot: { snapshotHash: "hash_kiwi_seat_hydrated" },
    page: {
      ...shell.page,
      text: "Select your seats. Select a seat on the map. Continue.",
      controls: [{
        controlId: "continue",
        label: "Continue",
        semantic: "continue",
        physicalEffect: "advance_checkout_stage",
        surfaceId: "surface-page",
        operations: operation("el_continue")
      }],
      decisionGroups: [],
      summary: { fields: 0, controls: 1, decisionGroups: 0 },
      readiness: {
        documentReadyState: "complete",
        ariaBusy: false,
        loadingIndicatorCount: 0,
        loadingTextEvidence: false,
        mainTextLength: 55,
        stableForMs: 900
      }
    }
  };
  const ready = classifyObservationReadiness({ observation: hydrated, previousReadiness: transient });
  assert.equal(ready.classification, READINESS.READY);
  assert.equal(ready.evidence.expectedStage, "seats");
});

test("blank Kiwi seat destination remains transient when navigation evidence lives in session state", () => {
  const shell = shellObservation("obs_kiwi_blank_seat_destination");
  shell.lastActionResult = null;
  shell.page = {
    ...shell.page,
    step: "seats",
    url: "https://www.kiwi.com/en/booking/?activeStep=2&holdBags=15kg&insurance=0",
    heading: "Select your seats",
    text: "Select your seats. Find the most comfortable seats for your group.",
    controls: [
      { controlId: "currency", label: "TRY", semantic: "unknown", surfaceId: "surface-page", operations: operation("el_currency") },
      { controlId: "price", label: "View price breakdown", semantic: "open_surface", surfaceId: "surface-page", operations: operation("el_price") }
    ],
    decisionGroups: [],
    summary: { fields: 0, controls: 2, decisionGroups: 0 },
    readiness: {
      documentReadyState: "complete",
      ariaBusy: false,
      loadingIndicatorCount: 0,
      loadingTextEvidence: false,
      mainTextLength: 64,
      stableForMs: 350
    }
  };

  const readiness = classifyObservationReadiness({
    observation: shell,
    navigationContext: {
      action: { semanticIntent: "advance_checkout_stage", mechanicalEffect: "advance_checkout_stage" },
      feedback: { navigationOccurred: true, pageChanged: true }
    }
  });

  assert.equal(readiness.classification, READINESS.TRANSIENT);
  assert.equal(readiness.reason, "POST_NAVIGATION_DESTINATION_NOT_READY");
  assert.equal(readiness.evidence.expectedStage, "seats");
  assert.equal(readiness.handoffEligible, false);
});

test("a new destination receives a fresh readiness deadline", () => {
  const traveler = shellObservation("obs_traveler_shell");
  const old = classifyObservationReadiness({
    observation: traveler,
    nowMs: 1_000,
    readinessTimeoutMs: 20_000
  });
  const seats = shellObservation("obs_seat_shell_new_destination");
  seats.page = {
    ...seats.page,
    step: "seats",
    url: "https://example.test/checkout/seats",
    heading: "Seat selection",
    text: "Seat selection is loading",
    readiness: {
      documentReadyState: "complete",
      ariaBusy: false,
      loadingIndicatorCount: 0,
      mainTextLength: 25,
      stableForMs: 300
    }
  };
  const fresh = classifyObservationReadiness({
    observation: seats,
    previousReadiness: old,
    readinessDeadlineAt: old.deadlineAt,
    nowMs: 19_000,
    readinessTimeoutMs: 20_000
  });
  assert.equal(fresh.classification, READINESS.TRANSIENT);
  assert.equal(fresh.startedAt, 19_000);
  assert.equal(fresh.deadlineAt, 39_000);
  assert.equal(fresh.remainingMs, 20_000);
});

test("stable EasyJet-shaped seats reaches the controller before disabled Next", async () => {
  const executable = (actuatorId) => ({
    activate: {
      actuatorId,
      actuatorIds: [actuatorId],
      actionability: {
        executable: true,
        revealable: false,
        rendered: true,
        visible: true,
        enabled: true,
        inCurrentSurface: true,
        inViewport: true,
        hitTested: true,
        notOccluded: true,
        targetable: true,
        operationAuthorized: true,
        operationProven: true,
        code: "ACTIONABLE",
        operation: "activate"
      }
    }
  });
  const safeSeat = {
    controlId: "choose_seats_for_me",
    label: "Choose seats for me",
    accessibleName: "Choose seats for me",
    semantic: "required_dropdown_choice",
    risk: "safe_decline",
    physicalEffect: "select_free_option",
    surfaceId: "surface-page",
    state: { disabled: false, selected: false },
    representationLifecycle: { status: "active_rendered", active: true },
    operations: executable("el_choose_seats_for_me")
  };
  const paidSeat = {
    controlId: "seat_1a",
    label: "1A Extra Legroom €39.49",
    semantic: "add_paid_extra",
    risk: "money",
    structuredPrice: { amount: 39.49, currency: "EUR" },
    surfaceId: "surface-page",
    representationLifecycle: { status: "active_rendered", active: true },
    operations: executable("el_seat_1a")
  };
  const observation = {
    observationId: "obs_easyjet_stable_seats",
    observationSnapshot: { snapshotHash: "hash_easyjet_stable_seats" },
    page: {
      step: "seats",
      url: "https://www.easyjet.com/en/buy/seats",
      heading: "Seat selection",
      text: "For each passenger select a seat. If you don't select a seat, we'll automatically allocate your seats when you check in.",
      semanticReadiness: "ready",
      currentSurface: { id: "surface-page", type: "page", blocksBackground: false },
      controls: [safeSeat, paidSeat],
      decisionGroups: [],
      validationIssues: [],
      stageExit: {
        continueObserved: true,
        continueDisabled: true,
        candidates: [{ controlId: "next_flight", status: "disabled", executable: false }]
      },
      summary: { fields: 0, controls: 110, decisionGroups: 0 },
      readiness: {
        documentReadyState: "complete",
        ariaBusy: false,
        loadingIndicatorCount: 0,
        mainTextLength: 5409,
        visibleMainCount: 1,
        stableForMs: 2759
      }
    }
  };
  const readiness = classifyObservationReadiness({
    observation,
    navigationContext: {
      action: { semanticIntent: "advance_checkout_stage", mechanicalEffect: "advance_checkout_stage" },
      feedback: { navigationOccurred: true, pageChanged: true }
    },
    readinessDeadlineAt: 1,
    nowMs: 50_000
  });
  assert.equal(readiness.classification, READINESS.READY);
  assert.equal(readiness.reason, "STABLE_DESTINATION_CONTROLLER_READY");
  assert.equal(readiness.evidence.controllerReady, true);

  const state = createCheckoutSessionState({
    goal: "Reach payment review",
    travelerId: "trav_easyjet",
    site: { host: "easyjet.com", url: observation.page.url }
  });
  state.lastAction = {
    id: "act_continue_to_seats",
    semanticIntent: "advance_checkout_stage",
    mechanicalEffect: "advance_checkout_stage",
    feedback: { navigationOccurred: true, pageChanged: true }
  };
  const result = await runLoopTurn({
    apiKey: "",
    model: "must-not-be-called",
    dataDir: "",
    state,
    observation,
    transactionStore: {
      isCurrentObservation: () => true,
      reserveGovernedAction: () => ({ ok: true, signature: "easyjet-safe-seat" }),
      recordActionEvent: () => {},
      saveSession: () => {}
    },
    traveler: {
      id: "trav_easyjet",
      seat_policy: "random_assignment",
      booking_rules: "No paid seats"
    }
  });
  assert.equal(result.state.observationReadiness.classification, READINESS.READY);
  assert.equal(result.state.taskState.currentGoal.kind, "adaptive_interaction");
  assert.equal(result.clientDecision.action, "click", JSON.stringify({
    decision: result.clientDecision,
    readiness: result.state.observationReadiness,
    taskState: result.state.taskState,
    debug: result.debug
  }));
  assert.equal(result.clientDecision.targetId, "el_choose_seats_for_me");
  assert.notEqual(result.clientDecision.action, "ask_user");
});

test("actionable seat confirmation owns readiness over executable background traveler controls", () => {
  const observation = shellObservation("obs_kiwi_seat_confirmation");
  observation.page = {
    ...observation.page,
    step: "confirmation",
    url: "https://www.kiwi.com/en/booking/?activeStep=2",
    semanticReadiness: "ready",
    currentSurface: {
      id: "seat-confirmation",
      type: "modal",
      label: "Are you sure that you don't want to select seats for your flights?",
      blocksBackground: true,
      memberControlIds: ["skip-seats", "continue-seats"]
    },
    controls: [
      {
        controlId: "background-first-name",
        fieldType: "first_name",
        semantic: "first_name",
        label: "First name",
        surfaceId: "surface-page",
        operations: {
          type: {
            actuatorId: "el-first-name",
            actionability: { executable: true }
          }
        }
      },
      {
        controlId: "skip-seats",
        semantic: "decline_paid_extra",
        risk: "safe_decline",
        label: "Skip seat selection",
        surfaceId: "seat-confirmation",
        operations: operation("el-skip-seats")
      },
      {
        controlId: "continue-seats",
        semantic: "choice",
        label: "Continue with seat selection",
        surfaceId: "seat-confirmation",
        operations: operation("el-continue-seats")
      }
    ],
    decisionGroups: [],
    summary: { fields: 1, controls: 3, decisionGroups: 0 },
    readiness: {
      documentReadyState: "complete",
      ariaBusy: false,
      loadingIndicatorCount: 0,
      mainTextLength: 240,
      visibleMainCount: 1,
      stableForMs: 16_000
    }
  };
  observation.lastActionResult = {
    feedback: { navigationOccurred: true, pageChanged: true, surfaceChanged: true },
    action: { semanticIntent: "advance_checkout_stage", mechanicalEffect: "advance_checkout_stage" }
  };

  assert.equal(expectedDestinationStage(observation.page), "seats");
  const readiness = classifyObservationReadiness({ observation });
  assert.equal(readiness.classification, READINESS.READY);
  assert.equal(readiness.reason, "FOREGROUND_ACTIONABLE");
  assert.equal(readiness.evidence.expectedStage, "seats");
  assert.equal(readiness.evidence.controls, 2);
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

test("payment route and generic confirmation copy remain a transient shell", () => {
  const observation = shellObservation("obs_payment_route_shell");
  observation.page = {
    ...observation.page,
    step: "confirmation",
    url: "https://example.test/rf/payment",
    heading: "",
    text: "Booking confirmation and updates will be sent by email.",
    controls: [],
    summary: { fields: 0, controls: 0, decisionGroups: 0 },
    readiness: { documentReadyState: "complete", ariaBusy: false, loadingIndicatorCount: 0, mainTextLength: 58, stableForMs: 400 }
  };
  observation.lastActionResult = {
    feedback: { navigationOccurred: true, pageChanged: true },
    action: { semanticIntent: "advance_checkout_stage", mechanicalEffect: "advance_checkout_stage" }
  };
  const readiness = classifyObservationReadiness({ observation });
  assert.equal(readiness.classification, READINESS.TRANSIENT);
  assert.equal(readiness.evidence.strongPaymentEvidence, false);
  assert.equal(readiness.reason, "POST_NAVIGATION_DESTINATION_NOT_READY");
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

test("loop reads navigation commitment from durable state when the new observation omits action feedback", async () => {
  const state = createCheckoutSessionState({
    goal: "Reach payment review",
    travelerId: "trav_durable_navigation",
    site: { host: "kiwi.com", url: "https://www.kiwi.com/en/booking/?activeStep=2" }
  });
  state.taskState = { sentinel: "destination_not_reduced" };
  state.lastAction = {
    id: "act_advance_to_seats",
    semanticIntent: "advance_checkout_stage",
    mechanicalEffect: "advance_checkout_stage",
    feedback: { navigationOccurred: true, pageChanged: true }
  };
  const observation = shellObservation("obs_loop_blank_seat_destination");
  observation.lastActionResult = null;
  observation.page = {
    ...observation.page,
    step: "seats",
    url: "https://www.kiwi.com/en/booking/?activeStep=2",
    heading: "Select your seats",
    text: "Select your seats. Find the most comfortable seats for your group.",
    controls: [{
      controlId: "price",
      label: "View price breakdown",
      semantic: "open_surface",
      surfaceId: "surface-page",
      operations: operation("el_price")
    }],
    decisionGroups: [],
    summary: { fields: 0, controls: 1, decisionGroups: 0 },
    readiness: { documentReadyState: "complete", ariaBusy: false, loadingIndicatorCount: 0, mainTextLength: 64, stableForMs: 350 }
  };

  const result = await runLoopTurn({
    apiKey: "",
    model: "must-not-be-called",
    dataDir: "",
    state,
    observation,
    traveler: { id: "trav_durable_navigation" }
  });

  assert.equal(result.clientDecision.action, "wait");
  assert.equal(result.clientDecision.semanticIntent, "wait_for_ready_observation");
  assert.equal(result.state.taskState.sentinel, "destination_not_reduced");
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
