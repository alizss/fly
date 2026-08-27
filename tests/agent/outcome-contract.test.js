const test = require("node:test");
const assert = require("node:assert/strict");
const { buildCurrentCandidateSet, actionForCurrentCandidate } = require("./legacy-mechanics-binding-adapter");
const { evaluateTransition } = require("../../apps/web/agent/transition-evaluator");
const { reduceTaskState } = require("./task-state-replay-adapter");
const { governObservedAction: governAction } = require("./governance-test-helper");
const { __private: loopPrivate } = require("../../apps/web/agent/loop");
const { compileTypedExpectedOutcome } = require("../../apps/web/agent/action-semantics");
const agentContract = require("../../apps/extension/src/shared/agent-contract");

function canonicalResult(action = {}, status, evidence = {}) {
  return {
    actionId: action.id || "",
    dispatched: true,
    executed: true,
    verified: status === agentContract.ACTION_OUTCOME.SATISFIED,
    expectedOutcome: action.expectedOutcome || null,
    actionOutcome: agentContract.compileActionOutcome({
      status,
      causedByActionId: action.id || "",
      originalSuccessContract: action.expectedOutcome || null,
      code: evidence.code || status,
      observedEvidence: evidence
    })
  };
}

function capability(operation, actuatorId) {
  const actionability = {
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
    revealable: false,
    code: "ACTIONABLE",
    operation
  };
  return {
    operation,
    actuatorId,
    actuatorIds: [actuatorId],
    actionability,
    actionabilityByActuator: { [actuatorId]: actionability }
  };
}

function observation(id, page, lastActionResult = null) {
  return {
    observationId: id,
    observationSnapshot: { snapshotHash: `hash_${id}` },
    page: { url: "https://example.test/checkout", controls: [], decisionGroups: [], validationIssues: [], ...page },
    lastActionResult
  };
}

function readyTransactionReview() {
  const transaction = {
    itinerary: {
      completeness: "complete",
      segments: [{ segmentId: "segment_1", origin: "LHR", destination: "LJU", departureDate: "2026-08-10" }]
    },
    travelers: [{ travelerId: "trav_1", name: "Alex Example" }],
    currency: "EUR",
    totalPrice: { amount: 208, currency: "EUR" },
    selectedExtras: []
  };
  return {
    ready: true,
    baselineStatus: "approved",
    missingFacts: [],
    contradictions: [],
    unauthorizedPaidExtras: [],
    baseline: transaction,
    current: transaction
  };
}

function paymentGoal(id = "obs_modal") {
  return {
    goalId: `${id}:goal:payment_review`,
    semanticGoal: "reach card credential entry",
    semanticType: "card_credential_entry",
    desiredValue: "card_credential_entry_reached",
    actionableControlIds: ["close", "submit"],
    observationId: id,
    surfaceId: "review_modal",
    outcomeContract: {
      taskOutcome: "card_credential_entry_reached",
      acceptablePhysicalEffects: ["advance_checkout_stage", "reveal_control"],
      completionEvidence: ["fresh_payment_stage", "payment_url", "payment_progress_marker", "payment_controls"]
    }
  };
}

test("checkout advance preserves the stage-exit-or-feedback contract", () => {
  const compiled = compileTypedExpectedOutcome({
    controlId: "confirm",
    intent: "advance_checkout",
    mechanicalEffect: "advance_checkout_stage",
    expectedOutcome: {
      type: "stage_exit_or_feedback",
      beforeStage: "review",
      beforePageHash: "hash_before"
    }
  }, {
    controls: [{ controlId: "confirm", semantic: "continue", role: "button" }]
  });

  assert.equal(compiled.type, "stage_exit_or_feedback");
  assert.equal(compiled.beforeStage, "review");
  assert.equal(compiled.beforePageHash, "hash_before");
});

test("same-label modal close and checkout submit remain exact admitted foreground actions", () => {
  const current = observation("obs_modal", {
    currentSurface: { id: "review_modal", type: "modal", label: "Review", memberControlIds: ["close", "submit"] },
    controls: [
      {
        controlId: "close",
        stableKey: "review.close",
        label: "Continue",
        meaning: "dialog close",
        semantic: "dismiss_surface",
        risk: "safe",
        kind: "button",
        role: "button",
        surfaceId: "review_modal",
        surfaceType: "modal",
        stateElementId: "el_close",
        preferredActivationElementId: "el_close",
        operations: { activate: capability("activate", "el_close") }
      },
      {
        controlId: "submit",
        stableKey: "review.submit",
        label: "Continue",
        meaning: "continue checkout to payment",
        semantic: "continue",
        risk: "safe",
        kind: "button",
        role: "button",
        surfaceId: "review_modal",
        surfaceType: "modal",
        stateElementId: "el_submit",
        preferredActivationElementId: "el_submit",
        operations: { activate: capability("activate", "el_submit") }
      }
    ]
  });
  const goal = paymentGoal();
  const taskState = { currentGoal: goal, activeDecisions: [], validationBlockers: [] };
  const candidateSet = buildCurrentCandidateSet({ goal, observation: current, state: { taskState, approvals: {} } });
  const close = candidateSet.contextCapabilities.find((candidate) => candidate.controlId === "close");
  const submit = candidateSet.contextCapabilities.find((candidate) => candidate.controlId === "submit");

  assert.equal(close.physicalEffect, "dismiss_surface");
  assert.equal(close.mechanicalEffect, "dismiss_surface");
  assert.equal(close.semanticIntent, "resolve_current_decision");
  assert.equal(close.obligationSuccessCondition.taskOutcome, "card_credential_entry_reached");
  assert.equal(close.selectable, true);
  assert.equal(close.outcomeCompatibility, "obligation_admitted");
  assert.equal(close.exclusionReason, "");
  assert.equal(submit.physicalEffect, "advance_checkout_stage");
  assert.equal(submit.mechanicalEffect, "advance_checkout_stage");
  assert.equal(submit.semanticIntent, "resolve_current_decision");
  assert.equal(submit.obligationSuccessCondition.taskOutcome, "card_credential_entry_reached");
  assert.deepEqual(candidateSet.candidates.map((candidate) => candidate.controlId), ["close", "submit"]);
});

test("governor treats outcome mismatch as diagnostic when the grounded action is safe", () => {
  const current = observation("obs_governor", {
    currentSurface: { id: "review_modal", type: "modal", label: "Review", memberControlIds: ["close"] },
    controls: [{
      controlId: "close",
      stableKey: "review.close",
      label: "Continue",
      meaning: "dialog close",
      semantic: "dismiss_surface",
      risk: "safe",
      kind: "button",
      role: "button",
      surfaceId: "review_modal",
      surfaceType: "modal",
      stateElementId: "el_close",
      preferredActivationElementId: "el_close",
      actuators: [{ nodeId: "el_close", relation: "activation" }],
      operations: { activate: capability("activate", "el_close") }
    }]
  });
  const goal = paymentGoal("obs_governor");
  const built = buildCurrentCandidateSet({ goal, observation: current, state: { taskState: { currentGoal: goal, activeDecisions: [], validationBlockers: [] } } });
  const close = built.contextCapabilities.find((candidate) => candidate.controlId === "close");
  const candidateSet = { ...built, candidates: [close] };
  const authoritativeGoal = { ...goal, candidateSet, candidates: [close] };
  const state = {
    id: "txn_outcome_contract",
    taskState: {
      currentGoal: authoritativeGoal,
      stageOutcome: { outcomeId: "stage_outcome:reach_card_credential_entry", outcomeContract: goal.outcomeContract },
      activeDecisions: [],
      validationBlockers: []
    },
    approvals: {},
    failures: [],
    priceHistory: [],
    actionLifecycle: null
  };
  const action = loopPrivate.bindTargetSnapshot(actionForCurrentCandidate(authoritativeGoal, close, current), current);
  const store = {
    isCurrentObservation: (_transactionId, observationId, hash) => observationId === current.observationId && hash === current.observationSnapshot.snapshotHash,
    recordActionEvent() {},
    reserveGovernedAction() { return { ok: true, signature: "unused" }; }
  };
  const result = governAction({ action, state, observation: current, traveler: {}, approvals: {}, store, turnId: "turn_outcome" });

  assert.equal(result.allow, true);
  assert.equal(result.checks.some((check) => check.code === "OUTCOME_COMPATIBILITY_DIAGNOSTIC" && check.ok === true), true);
});

test("opening a warning modal is verified intermediate progress, never checkout completion", () => {
  const before = observation("before_warning", {
    step: "extras",
    currentSurface: { id: "surface-page", type: "page", label: "Extras" },
    controls: [{ controlId: "continue", label: "Continue", surfaceId: "surface-page" }]
  });
  const after = observation("after_warning", {
    step: "extras",
    currentSurface: { id: "warning", type: "modal", label: "Continue without extras?" },
    controls: [{ controlId: "confirm", label: "Continue", surfaceId: "warning" }]
  }, { actionId: "act_continue", dispatched: true, executed: true });
  const action = {
    id: "act_continue",
    controlId: "continue",
    physicalEffect: "advance_checkout_stage",
    expectedOutcome: { type: "checkout_stage_advanced", controlId: "continue" },
    affordance: { physicalEffect: "advance_checkout_stage", effect: "advance_checkout_stage", task: { outcomeContract: paymentGoal().outcomeContract } }
  };
  const transition = evaluateTransition({
    beforeObservation: before,
    governedAction: action,
    browserResult: canonicalResult(action, agentContract.ACTION_OUTCOME.REVEALED_BLOCKER, { overlayAppeared: true }),
    afterObservation: after
  });

  assert.equal(transition.actionOutcome.status, "REVEALED_BLOCKER");
  assert.equal(transition.postcondition.satisfied, false);
  assert.equal(transition.physicalResult.verified, false);
  assert.equal(transition.taskOutcomeCompleted, false);
  assert.equal(transition.completionAuthority, "browser_verifier");
});

test("closing a review modal cannot prove payment review was reached", () => {
  const before = observation("before_close", {
    step: "extras",
    currentSurface: { id: "review_modal", type: "modal", label: "Review" },
    controls: [{ controlId: "close", label: "Continue", surfaceId: "review_modal" }]
  });
  const after = observation("after_close", {
    step: "extras",
    currentSurface: { id: "surface-page", type: "page", label: "Extras" },
    controls: [{ controlId: "base_continue", label: "Continue", surfaceId: "surface-page" }]
  }, { actionId: "act_close", dispatched: true, executed: true });
  const action = {
    id: "act_close",
    controlId: "close",
    physicalEffect: "advance_checkout_stage",
    expectedOutcome: { type: "checkout_stage_advanced", controlId: "close" },
    affordance: { physicalEffect: "advance_checkout_stage", effect: "advance_checkout_stage", task: { outcomeContract: paymentGoal().outcomeContract } }
  };
  const transition = evaluateTransition({
    beforeObservation: before,
    governedAction: action,
    browserResult: canonicalResult(action, agentContract.ACTION_OUTCOME.NO_EFFECT),
    afterObservation: after
  });

  assert.equal(transition.actionOutcome.status, "NO_EFFECT");
  assert.equal(transition.postcondition.satisfied, false);
  assert.equal(transition.physicalResult.verified, false);
  assert.equal(transition.taskOutcomeCompleted, false);
});

test("a verified free choice resolves its decision but TaskState still publishes navigation", () => {
  const before = observation("before_free", {
    step: "extras",
    currentSurface: { id: "surface-page", type: "page", label: "Baggage" },
    controls: [
      { controlId: "free", label: "No checked baggage", semantic: "safe_decline", risk: "safe", decisionGroupId: "bag", surfaceId: "surface-page", state: { selected: false } },
      { controlId: "continue", label: "Continue", semantic: "continue", risk: "safe", surfaceId: "surface-page", operations: { activate: capability("activate", "el_continue") } }
    ],
    decisionGroups: [{ decisionGroupId: "bag", requirementId: "bag", sectionType: "baggage", required: true, status: "missing", surfaceId: "surface-page", alternatives: [{ controlId: "free" }] }]
  });
  const after = observation("after_free", {
    step: "extras",
    currentSurface: { id: "surface-page", type: "page", label: "Baggage" },
    controls: [
      { controlId: "free", label: "No checked baggage", semantic: "safe_decline", risk: "safe", decisionGroupId: "bag", surfaceId: "surface-page", selected: true, state: { selected: true } },
      { controlId: "continue", label: "Continue", semantic: "continue", risk: "safe", surfaceId: "surface-page", operations: { activate: capability("activate", "el_continue") } }
    ],
    decisionGroups: [{ decisionGroupId: "bag", requirementId: "bag", sectionType: "baggage", required: true, status: "satisfied", selectedControlId: "free", surfaceId: "surface-page", alternatives: [{ controlId: "free" }] }]
  }, { actionId: "act_free", dispatched: true, executed: true });
  const action = {
    id: "act_free",
    controlId: "free",
    decisionGroupId: "bag",
    expectedOutcome: { type: "exact_free_option_selected", controlId: "free", expectedSelectedControlId: "free", decisionGroupId: "bag" },
    affordance: { physicalEffect: "select_free_option", effect: "select_free_option", task: { outcomeContract: { taskOutcome: "optional_extra_declined", acceptablePhysicalEffects: ["select_free_option"], completionEvidence: ["exact_option_selected"] } } }
  };
  const transition = evaluateTransition({
    beforeObservation: before,
    governedAction: action,
    browserResult: canonicalResult(action, agentContract.ACTION_OUTCOME.SATISFIED),
    afterObservation: after
  });
  const taskState = reduceTaskState({
    previousTaskState: {},
    observation: after,
    previousActionResult: { verified: true, physicalResult: transition.physicalResult },
    userPolicy: { skipPaidExtrasApproved: true },
    traveler: { booking_rules: "no paid baggage" }
  });

  assert.equal(transition.actionOutcome.status, "SATISFIED");
  assert.equal(transition.physicalResult.effect, "select_free_option");
  assert.equal(transition.taskOutcomeCompleted, false);
  assert.equal(taskState.completedOutcomes.some((outcome) => outcome.decisionGroupId === "bag"), true);
  assert.equal(taskState.currentGoal.semanticType, "navigation");
  assert.equal(taskState.terminalStatus, "active");
});

test("a failed exact free-choice postcondition cannot be promoted by a stage change", () => {
  const before = observation("before_auto_advance", {
    step: "extras",
    price: { amount: 120, currency: "EUR" },
    currentSurface: { id: "surface-page", type: "page", label: "Insurance" },
    controls: [{
      controlId: "no_insurance",
      label: "No insurance — 0 EUR",
      semantic: "safe_decline",
      physicalEffect: "select_free_option",
      structuredPrice: { amount: 0, currency: "EUR" },
      risk: "safe",
      decisionGroupId: "insurance",
      surfaceId: "surface-page"
    }],
    decisionGroups: [{
      decisionGroupId: "insurance",
      requirementId: "insurance",
      sectionType: "insurance",
      status: "missing",
      alternatives: [{ controlId: "no_insurance" }]
    }]
  });
  const after = observation("after_auto_advance", {
    url: "https://example.test/checkout/seats",
    step: "seats",
    price: { amount: 120, currency: "EUR" },
    currentSurface: { id: "surface-page", type: "page", label: "Seating" },
    controls: [{
      controlId: "continue",
      label: "Continue",
      semantic: "continue",
      surfaceId: "surface-page",
      operations: { activate: capability("activate", "el_continue") }
    }],
    decisionGroups: []
  }, { actionId: "act_no_insurance", dispatched: true, executed: true });
  const action = {
    id: "act_no_insurance",
    controlId: "no_insurance",
    decisionGroupId: "insurance",
    semanticIntent: "select_policy_safe_option",
    mechanicalEffect: "select_free_option",
    expectedOutcome: {
      type: "exact_free_option_selected",
      controlId: "no_insurance",
      expectedSelectedControlId: "no_insurance",
      decisionGroupId: "insurance",
      expectedDisposition: "decline_free_no_extra",
      mustNotIncreasePrice: true
    },
    affordance: {
      policy: { allow: true },
      physicalEffect: "select_free_option",
      task: {
        outcomeContract: {
          taskOutcome: "optional_extra_declined",
          acceptablePhysicalEffects: ["select_free_option", "advance_checkout_stage"],
          completionEvidence: ["exact_option_selected", "fresh_stage"]
        }
      }
    }
  };
  const transition = evaluateTransition({
    beforeObservation: before,
    governedAction: action,
    browserResult: canonicalResult(action, agentContract.ACTION_OUTCOME.NO_EFFECT, { code: "EXACT_FREE_OPTION_NOT_VERIFIED" }),
    afterObservation: after
  });

  assert.equal(transition.actionOutcome.status, "NO_EFFECT");
  assert.equal(transition.postcondition.satisfied, false);
  assert.equal(transition.postcondition.evidence.browserSettlementStatus, "NO_EFFECT");
  assert.equal(transition.physicalResult.verified, false);
  assert.equal(transition.nextDirective, "try_distinct_capability");
});

test("one terminal latch replaces the stage and surface outcome hierarchy", () => {
  const base = observation("hierarchy_base", {
    step: "extras",
    currentSurface: { id: "surface-page", type: "page", label: "Extras", surfaceClass: "navigation" },
    controls: [{
      controlId: "base_continue", label: "Continue", semantic: "continue", physicalEffect: "advance_checkout_stage",
      risk: "safe", surfaceId: "surface-page", surfaceType: "page", operations: { activate: capability("activate", "el_base_continue") }
    }]
  });
  const first = reduceTaskState({ observation: base });
  const review = observation("hierarchy_review", {
    step: "extras",
    currentSurface: { id: "review_modal", type: "modal", label: "Review your details", surfaceClass: "review_confirmation" },
    controls: [{
      controlId: "close", label: "Continue to Payment", semantic: "dismiss_surface", physicalEffect: "dismiss_surface",
      risk: "safe", surfaceId: "review_modal", surfaceType: "modal", operations: { activate: capability("activate", "el_close") }
    }, {
      controlId: "submit", label: "Continue to Payment", semantic: "continue", physicalEffect: "advance_checkout_stage",
      risk: "safe", surfaceId: "review_modal", surfaceType: "modal", operations: { activate: capability("activate", "el_submit") }
    }]
  });
  const second = reduceTaskState({ previousTaskState: first, observation: review });
  const candidates = buildCurrentCandidateSet({
    goal: second.currentGoal,
    observation: review,
    state: { taskState: second, approvals: {} }
  });

  assert.equal(second.transactionOutcome, undefined);
  assert.equal(second.stageOutcome, undefined);
  assert.equal(second.surfaceSubgoal, undefined);
  assert.deepEqual(candidates.candidates.map((candidate) => candidate.controlId), ["close", "submit"]);
  assert.equal(candidates.contextCapabilities.find((candidate) => candidate.controlId === "close").selectable, true);

  const payment = observation("hierarchy_payment", {
    url: "https://example.test/checkout/payment",
    currentSurface: { id: "surface-page", type: "page", label: "Payment details", surfaceClass: "form" },
    foreground: { progressMarkers: { current: "Payment" } },
    controls: [
      { controlId: "card", semantic: "card_number", label: "Card number", surfaceId: "surface-page", operations: { type: capability("type", "card") } },
      { controlId: "expiry", semantic: "card_expiry", label: "Expiry", surfaceId: "surface-page", operations: { type: capability("type", "expiry") } },
      { controlId: "cvc", semantic: "card_cvc", label: "Security code", surfaceId: "surface-page", operations: { type: capability("type", "cvc") } }
    ],
    sections: [{ type: "payment", label: "Payment method and order amount" }]
  });
  const completed = reduceTaskState({
    previousTaskState: second,
    observation: payment,
    transactionReview: readyTransactionReview()
  });
  assert.equal(completed.terminalStatus, "card_credential_entry_reached");
  assert.equal(completed.terminalGoalLatch.locked, true);
});

test("no-paid-seat policy with only paid seats creates navigation, not a fake free-seat obligation", () => {
  const seatMap = observation("paid_only_seat_map", {
    currentSurface: { id: "seat_modal", type: "modal", label: "Reserve seating", surfaceClass: "choice_set" },
    controls: [{
      controlId: "seat_5a", label: "Seat 5A — 29 EUR", semantic: "add_paid_extra", physicalEffect: "select_paid_option",
      structuredPrice: { amount: 29, currency: "EUR" }, risk: "money", decisionGroupId: "seat_group", surfaceId: "seat_modal", surfaceType: "modal",
      operations: { activate: capability("activate", "el_5a") }
    }, {
      controlId: "seat_5b", label: "Seat 5B — 29 EUR", semantic: "add_paid_extra", physicalEffect: "select_paid_option",
      structuredPrice: { amount: 29, currency: "EUR" }, risk: "money", decisionGroupId: "seat_group", surfaceId: "seat_modal", surfaceType: "modal",
      operations: { activate: capability("activate", "el_5b") }
    }, {
      controlId: "next", label: "Next", semantic: "continue", physicalEffect: "advance_surface",
      risk: "safe", surfaceId: "seat_modal", surfaceType: "modal", operations: { activate: capability("activate", "el_next") }
    }],
    decisionGroups: [{
      decisionGroupId: "seat_group", requirementId: "seat", sectionType: "seat", surfaceId: "seat_modal",
      required: true, status: "missing", alternatives: [{ controlId: "seat_5a" }, { controlId: "seat_5b" }]
    }]
  });
  const taskState = reduceTaskState({
    observation: seatMap,
    userPolicy: { bookingRules: "No paid seats" },
    traveler: { booking_rules: "No paid seats" }
  });
  const candidates = buildCurrentCandidateSet({
    goal: taskState.currentGoal,
    observation: seatMap,
    traveler: { booking_rules: "No paid seats" },
    state: { taskState, approvals: { skipPaidExtrasApproved: true } }
  });

  assert.equal(taskState.activeDecisions.length, 0);
  assert.equal(taskState.completedOutcomes.find((item) => item.decisionGroupId === "seat_group").completionReason, "policy_constraint_satisfied_without_selection");
  assert.equal(taskState.currentGoal.semanticType, "navigation");
  assert.deepEqual(candidates.candidates.map((candidate) => candidate.controlId), ["next"]);
});

test("seat-warning Continue carries separate mechanical, semantic, and postcondition contracts", () => {
  const warning = observation("obs_seat_warning", {
    step: "seats",
    text: "You have not selected a seat. Continue without seats?",
    currentSurface: {
      id: "seat_warning",
      type: "modal",
      label: "You have not selected a seat. Continue without seats?",
      surfaceClass: "warning",
      memberControlIds: ["warning_continue", "warning_back"]
    },
    controls: [{
      controlId: "warning_continue",
      label: "Continue without seats",
      semantic: "continue",
      physicalEffect: "dismiss_surface",
      risk: "safe",
      surfaceId: "seat_warning",
      surfaceType: "modal",
      operations: { activate: capability("activate", "el_warning_continue") }
    }, {
      controlId: "warning_back",
      label: "Go back",
      semantic: "open_surface",
      physicalEffect: "open_surface",
      risk: "safe",
      surfaceId: "seat_warning",
      surfaceType: "modal",
      operations: { activate: capability("activate", "el_warning_back") }
    }]
  });
  const taskState = reduceTaskState({
    observation: warning,
    userPolicy: { bookingRules: "No paid seats" },
    traveler: { booking_rules: "No paid seats" }
  });
  const candidateSet = buildCurrentCandidateSet({
    goal: taskState.currentGoal,
    observation: warning,
    state: { taskState, approvals: { skipPaidExtrasApproved: true } },
    traveler: { booking_rules: "No paid seats" }
  });
  assert.deepEqual(candidateSet.candidates.map((candidate) => candidate.controlId), ["warning_continue"]);
  const candidate = candidateSet.candidates[0];
  assert.equal(candidate.mechanicalEffect, "dismiss_surface");
  assert.equal(candidate.semanticIntent, "advance_checkout_stage");
  assert.equal(candidate.outcomeCompatibility, "obligation_admitted");
  assert.deepEqual(candidate.obligationSuccessCondition, taskState.currentGoal.successCondition);
  assert.deepEqual(candidate.expectedPostconditions, [candidate.localMechanicalPostcondition]);

  const after = observation("obs_seat_warning_closed", {
    step: "seats",
    text: "Seat selection Flight 2 of 2",
    currentSurface: { id: "surface-page", type: "page", label: "Seat selection" },
    controls: []
  });
  const action = actionForCurrentCandidate(taskState.currentGoal, candidate, warning);
  const transition = evaluateTransition({
    beforeObservation: warning,
    governedAction: action,
    browserResult: canonicalResult(action, agentContract.ACTION_OUTCOME.SATISFIED),
    afterObservation: after
  });
  assert.deepEqual(transition.localMechanicalResult, transition.localEffect);
  assert.equal(transition.localMechanicalResult.effect, "dismiss_surface");
  assert.equal(transition.currentObligationResult.completed, false);
  assert.equal(transition.currentObligationResult.status, "awaiting_fresh_reduction");
  assert.equal(transition.durableObjectiveProgress.completed, false);
  assert.equal(transition.durableObjectiveProgress.status, "no_progress");
});
