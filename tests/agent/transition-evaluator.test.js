const test = require("node:test");
const assert = require("node:assert/strict");

const { diffObservations } = require("../../apps/web/agent/observation-diff");
const { evaluateTransition } = require("../../apps/web/agent/transition-evaluator");
const {
  advanceActionLifecycle,
  canonicalFailureCode
} = require("../../apps/web/agent/action-lifecycle");
const { runLoopTurn, __private: loopPrivate } = require("../../apps/web/agent/loop");
const { allRequiredSatisfied, missingRequired, normalizeRequirement } = require("../../packages/shared/requirements");
const { createCheckoutSessionState } = require("../../packages/shared/agent-state");
const {
  applyAuthoritativeOutcomeToRequirements,
  deriveAuthoritativeTaskContext
} = require("../../apps/web/agent/task-action-context");
const { candidateSelectionSchemaFor } = require("../../apps/web/agent/schemas");

function actionableCapability(operation, actuatorId, { inViewport = true } = {}) {
  const actionability = {
    rendered: true,
    visible: true,
    enabled: true,
    inViewport,
    inCurrentSurface: true,
    hitTested: inViewport,
    notOccluded: inViewport,
    operationAuthorized: true,
    executable: inViewport,
    revealable: !inViewport,
    code: inViewport ? "ACTIONABLE" : "ACTUATOR_OUT_OF_VIEW",
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

function observation(id, page = {}, lastActionResult = null) {
  return {
    observationId: id,
    observationSnapshot: { snapshotHash: `hash_${id}` },
    page: {
      step: "seats",
      url: "https://example.test/seats",
      currentSurface: { id: "seat_modal", type: "modal", label: "Seats" },
      controls: [],
      decisionGroups: [],
      validationIssues: [],
      price: { amount: 208, currency: "EUR" },
      ...page
    },
    lastActionResult
  };
}

function result(actionId = "act_1") {
  return { actionId, dispatched: true, executed: true, verified: false };
}

test("authoritative transition achieves only the exact free selection", () => {
  const before = observation("before", {
    controls: [{ controlId: "ctrl_free", decisionGroupId: "dg_seat", label: "No thanks", semantic: "decline_paid_extra", risk: "safe_decline", selected: false }],
    decisionGroups: [{ decisionGroupId: "dg_seat", status: "missing", selectedControlId: "" }]
  });
  const after = observation("after", {
    controls: [{ controlId: "ctrl_free", decisionGroupId: "dg_seat", label: "No thanks", semantic: "decline_paid_extra", risk: "safe_decline", selected: true }],
    decisionGroups: [{ decisionGroupId: "dg_seat", status: "satisfied", selectedControlId: "ctrl_free", selectedLabel: "No thanks", selectedSemantic: "decline_paid_extra" }]
  }, result());
  const transition = evaluateTransition({
    beforeObservation: before,
    governedAction: {
      id: "act_1",
      controlId: "ctrl_free",
      decisionGroupId: "dg_seat",
      expectedOutcome: { type: "exact_free_option_selected", controlId: "ctrl_free", expectedSelectedControlId: "ctrl_free", decisionGroupId: "dg_seat", mustNotIncreasePrice: true }
    },
    browserResult: result(),
    afterObservation: after
  });
  assert.equal(transition.status, "achieved");
  assert.equal(transition.nextDirective, "advance_goal");
  assert.equal(transition.postcondition.evidence.selectedControlId, "ctrl_free");
});

test("authoritative transition distinguishes blocked, progressed, no-effect, uncertain, and unsafe", () => {
  const before = observation("before", {
    currentSurface: { id: "page", type: "page", label: "Seats" },
    controls: [{ controlId: "ctrl_next", label: "Next", state: { disabled: false } }]
  });
  const action = { id: "act_1", controlId: "ctrl_next", expectedOutcome: { type: "stage_exit_or_feedback" } };

  const blockedAfter = observation("blocked", {
    currentSurface: { id: "confirm", type: "modal", label: "Continue without seats?" },
    controls: [{ controlId: "ctrl_continue_without", label: "Continue without seats" }]
  }, result());
  const blocked = evaluateTransition({ beforeObservation: before, governedAction: action, browserResult: result(), afterObservation: blockedAfter });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.nextDirective, "resolve_blocker");
  assert.equal(blocked.blocker.surfaceId, "confirm");

  const progressedAfter = observation("progressed", {
    currentSurface: { id: "page", type: "page", label: "Seats" },
    controls: [{ controlId: "ctrl_new", label: "Different current control" }]
  }, result());
  const progressed = evaluateTransition({
    beforeObservation: before,
    governedAction: { ...action, expectedOutcome: { type: "normalized_value_changed", controlId: "ctrl_missing", expectedValue: "done" } },
    browserResult: result(),
    afterObservation: progressedAfter
  });
  assert.equal(progressed.status, "progressed");
  assert.equal(progressed.nextDirective, "rebuild_from_fresh_observation");

  const unchanged = observation("unchanged", before.page, result());
  const noEffect = evaluateTransition({ beforeObservation: before, governedAction: action, browserResult: result(), afterObservation: unchanged });
  assert.equal(noEffect.status, "no_effect");
  assert.equal(noEffect.nextDirective, "try_distinct_capability");

  const uncertain = evaluateTransition({ beforeObservation: null, governedAction: action, browserResult: result(), afterObservation: unchanged });
  assert.equal(uncertain.status, "uncertain");
  assert.equal(uncertain.nextDirective, "reobserve_rebind");

  const unsafeAfter = observation("unsafe", { ...before.page, price: { amount: 250, currency: "EUR" } }, result());
  const unsafe = evaluateTransition({
    beforeObservation: before,
    governedAction: { ...action, expectedOutcome: { type: "observable_change", mustNotIncreasePrice: true } },
    browserResult: result(),
    afterObservation: unsafeAfter
  });
  assert.equal(unsafe.status, "unsafe");
  assert.equal(unsafe.nextDirective, "stop_or_request_approval");
});

test("typed diff reports validation clearing from fresh browser evidence", () => {
  const before = observation("before", { validationIssues: [{ issueId: "err_email", controlId: "ctrl_email", message: "Email required" }] });
  const after = observation("after", { validationIssues: [] }, result());
  const diff = diffObservations(before, after);
  assert.equal(diff.errorsAppeared.length, 0);
  assert.equal(diff.errorsCleared[0].controlId, "ctrl_email");
  assert.equal(diff.targetReacted, true);
});

test("loop recovery counts dispatched no-effect and excludes that exact strategy", () => {
  const before = observation("before", {
    controls: [{ controlId: "ctrl_flex", label: "Flexible ticket", state: { expanded: false } }]
  });
  const browserResult = result("act_open");
  const after = observation("after", before.page, browserResult);
  const state = {
    currentGoal: { goalId: "goal_flex", semanticType: "flexible_ticket" },
    lastAction: {
      id: "act_open",
      type: "click",
      controlId: "ctrl_flex",
      operation: "open",
      expectedOutcome: { type: "options_surface_appeared", controlId: "ctrl_flex" }
    },
    attemptedStrategySignatures: []
  };
  const applied = loopPrivate.applyTransitionStatus(state, after, before);
  assert.equal(applied.transition.status, "no_effect");
  assert.equal(applied.observation.lastActionResult.verified, false);
  assert.equal(applied.observation.lastActionResult.failureCode, "TRANSITION_NO_EFFECT");
  assert.deepEqual(applied.state.attemptedStrategySignatures, ["click:open:ctrl_flex:,:"]);
  assert.equal(applied.directive, "try_distinct_capability");
  assert.equal(applied.state.recoveryState.attempts, 1);
  assert.equal(applied.state.recoveryState.phase, "execution_no_effect");
});

test("three distinct no-effect strategies exhaust only one unchanged state and meaningful progress resets the counter", () => {
  const samePage = {
    currentSurface: { id: "seat_modal", type: "modal", label: "Seats" },
    controls: ["one", "two", "three"].map((id) => ({ controlId: `ctrl_${id}`, label: id })),
    decisionGroups: []
  };
  let state = { recoveryState: { attempts: 0, phase: "idle", stateHash: "", failedStrategySignatures: [] } };
  let before = observation("budget_before", samePage);
  before.observationSnapshot.snapshotHash = "unchanged_hash";

  for (const [index, id] of ["one", "two", "three"].entries()) {
    const action = {
      id: `act_${id}`,
      type: "click",
      operation: "activate",
      controlId: `ctrl_${id}`,
      targetId: `el_${id}`,
      expectedOutcome: { type: "stage_exit_or_feedback" }
    };
    const after = observation(`budget_after_${id}`, samePage, result(action.id));
    after.observationSnapshot.snapshotHash = "unchanged_hash";
    const advanced = advanceActionLifecycle({ state: { ...state, lastAction: action }, observation: after, previousObservation: before });
    state = advanced.state;
    assert.equal(state.recoveryState.attempts, index + 1);
    assert.equal(advanced.directive, index === 2 ? "handoff_recovery_exhausted" : "try_distinct_capability");
    before = after;
  }

  const progressAction = {
    id: "act_progress",
    type: "click",
    operation: "activate",
    controlId: "ctrl_three",
    targetId: "el_three",
    expectedOutcome: { type: "stage_exit_or_feedback" }
  };
  const progressed = observation("budget_progress", {
    ...samePage,
    currentSurface: { id: "confirm_modal", type: "modal", label: "Confirm" },
    controls: [{ controlId: "ctrl_continue", label: "Continue" }]
  }, result(progressAction.id));
  const reset = advanceActionLifecycle({ state: { ...state, lastAction: progressAction }, observation: progressed, previousObservation: before });
  assert.equal(reset.transition.status, "blocked");
  assert.equal(reset.state.recoveryState.attempts, 0);
  assert.deepEqual(reset.state.recoveryState.failedStrategySignatures, []);
});

test("pre-dispatch surface rejection on an unchanged page rebuilds without consuming execution recovery", () => {
  const before = observation("before", {
    currentSurface: { id: "seat_modal", type: "modal", label: "Seats" },
    controls: [{ controlId: "ctrl_no_thanks", surfaceId: "seat_modal", label: "No thanks" }]
  });
  const after = observation("after", before.page, {
    actionId: "act_no_thanks",
    observationId: "before",
    dispatched: false,
    executed: false,
    verified: false,
    outcome: { code: "TARGET_OUTSIDE_CURRENT_SURFACE" }
  });
  const advanced = advanceActionLifecycle({
    state: {
      lastAction: {
        id: "act_no_thanks",
        observationId: "before",
        candidateId: "before:candidate_1",
        type: "click",
        controlId: "ctrl_no_thanks"
      },
      recoveryState: { attempts: 0, phase: "idle", stateHash: "", failedStrategySignatures: [] }
    },
    observation: after,
    previousObservation: before
  });

  assert.equal(advanced.lifecycle.status, "rejected_before_dispatch");
  assert.equal(advanced.lifecycle.dispatched, false);
  assert.equal(advanced.transition, null);
  assert.equal(advanced.directive, "rebuild_candidates");
  assert.equal(advanced.state.recoveryState.attempts, 0);
  assert.equal(advanced.state.recoveryState.phase, "grounding_rejection");
  assert.notEqual(advanced.directive, "handoff_recovery_exhausted");
});

test("legacy foreground failure normalizes to the shared current-surface taxonomy", () => {
  assert.equal(
    canonicalFailureCode({ outcome: { code: "TARGET_OUTSIDE_FOREGROUND" } }),
    "TARGET_OUTSIDE_CURRENT_SURFACE"
  );
});

test("useful unexpected transition is observed progress, not verified success", () => {
  const before = observation("before_progress", {
    controls: [{ controlId: "ctrl_next", label: "Next" }]
  });
  const after = observation("after_progress", {
    currentSurface: { id: "confirm_modal", type: "modal", label: "Continue without seats" },
    controls: [{ controlId: "ctrl_confirm", surfaceId: "confirm_modal", label: "Continue without seats" }]
  }, result("act_next"));
  const advanced = advanceActionLifecycle({
    state: {
      lastAction: {
        id: "act_next",
        observationId: "before_progress",
        type: "click",
        controlId: "ctrl_next",
        expectedOutcome: { type: "stage_exit_or_feedback" }
      }
    },
    observation: after,
    previousObservation: before
  });

  assert.equal(advanced.transition.status, "blocked");
  assert.equal(advanced.lifecycle.status, "observed");
  assert.equal(advanced.lifecycle.observed, true);
  assert.equal(advanced.lifecycle.verified, false);
  assert.equal(advanced.directive, "resolve_blocker");
});

test("typed seat commands use acknowledgement proof and no-effect selects a distinct navigation capability", () => {
  const before = observation("typed_before", {
    currentSurface: {
      id: "seat_modal",
      type: "modal",
      label: "Reserve seating",
      memberControlIds: ["ctrl_skip", "ctrl_next"],
      memberActuatorIds: ["el_skip", "el_next"]
    },
    controls: [{
      controlId: "ctrl_skip",
      decisionGroupId: "dg_seat",
      sectionId: "section_seat",
      surfaceId: "seat_modal",
      label: "Skip seat selection",
      kind: "button",
      role: "button",
      semantic: "decline_paid_extra",
      risk: "safe_decline",
      preferredActivationElementId: "el_skip",
      visualRegion: { inViewport: true },
      operations: { activate: actionableCapability("activate", "el_skip") }
    }, {
      controlId: "ctrl_next",
      sectionId: "section_seat",
      surfaceId: "seat_modal",
      label: "Next",
      kind: "button",
      role: "button",
      semantic: "navigation",
      risk: "safe",
      preferredActivationElementId: "el_next",
      visualRegion: { inViewport: true },
      operations: { activate: actionableCapability("activate", "el_next") }
    }],
    decisionGroups: [{
      decisionGroupId: "dg_seat",
      sectionId: "section_seat",
      surfaceId: "seat_modal",
      status: "missing",
      required: true,
      alternatives: []
    }]
  });
  const goal = {
    goalId: "goal_seat",
    semanticGoal: "decline paid seat selection",
    semanticType: "seat_decision",
    desiredValue: "free_or_no_extra",
    decisionGroupId: "dg_seat",
    requirementId: "dg_seat",
    observationId: before.observationId
  };
  const firstSet = loopPrivate.groundedObservationCandidateSet(goal, before);
  const skip = firstSet.candidates.find((candidate) => candidate.controlId === "ctrl_skip");
  const next = firstSet.candidates.find((candidate) => candidate.controlId === "ctrl_next");

  assert.equal(skip.interactionRole, "command");
  assert.equal(skip.semanticEffect, "waive");
  assert.equal(skip.expectedEvidence, "dismissed");
  assert.equal(skip.expectedOutcome.type, "command_acknowledged");
  assert.equal(next.interactionRole, "navigation");
  assert.equal(next.semanticEffect, "advance");
  assert.equal(next.expectedOutcome.type, "stage_exit_or_feedback");

  const dispatchedSkip = { ...skip, id: "act_skip" };
  const unchanged = observation("typed_unchanged", before.page, result(dispatchedSkip.id));
  const applied = loopPrivate.applyTransitionStatus({
    currentGoal: goal,
    lastAction: dispatchedSkip,
    attemptedStrategySignatures: []
  }, unchanged, before);
  assert.equal(applied.transition.status, "no_effect");
  assert.equal(applied.directive, "try_distinct_capability");

  const retrySet = loopPrivate.groundedObservationCandidateSet(goal, unchanged, applied.state.attemptedStrategySignatures);
  assert.equal(retrySet.candidates.some((candidate) => candidate.controlId === "ctrl_skip"), false);
  assert.equal(retrySet.candidates.some((candidate) => candidate.controlId === "ctrl_next"), true);
});

test("failed-strategy memory survives rerendered control and decision-group identities", () => {
  const first = {
    controlId: "ctrl_runtime_1",
    decisionGroupId: "dg_classifier_first",
    operation: "activate",
    semanticEffect: "waive",
    affordance: {
      stableKey: "seat_modal.skip",
      actuator: { stableKey: "seat_modal.skip:actuator:activate" },
      effect: "skip_current_item"
    }
  };
  const rerendered = {
    ...first,
    controlId: "ctrl_runtime_2",
    decisionGroupId: "dg_classifier_second"
  };

  assert.equal(
    loopPrivate.candidateStrategySignature({ semanticType: "first wording" }, first),
    loopPrivate.candidateStrategySignature({ semanticType: "different wording" }, rerendered)
  );
});

test("sibling paid-extra groups form an exact work queue and broad family completion cannot waive peers", () => {
  const groups = [
    { decisionGroupId: "dg_airhelp", requirementId: "protection:airhelp", sectionType: "protection", sectionLabel: "AirHelp", surfaceId: "surface-page", required: true, status: "satisfied", selectedControlId: "ctrl_airhelp_none" },
    { decisionGroupId: "dg_lost_baggage", requirementId: "protection:lost-baggage", sectionType: "protection", sectionLabel: "Lost baggage", surfaceId: "surface-page", required: true, status: "missing", selectedControlId: "" },
    { decisionGroupId: "dg_premium_support", requirementId: "protection:premium-support", sectionType: "protection", sectionLabel: "Premium support", surfaceId: "surface-page", required: true, status: "missing", selectedControlId: "" }
  ];
  const current = observation("obs_exact_group_queue", {
    currentSurface: { id: "surface-page", type: "page", label: "Optional protection" },
    controls: [],
    decisionGroups: groups
  });
  const requirements = groups.map((group) => ({
    id: group.decisionGroupId,
    requirementId: group.requirementId,
    decisionGroupId: group.decisionGroupId,
    type: "paid_extra_decision",
    semanticType: "paid_extra_decision",
    label: group.sectionLabel,
    sectionType: group.sectionType,
    status: group.status,
    lifecycleStatus: group.status,
    required: true,
    risk: "money",
    confidence: 0.95,
    selectedControlId: group.selectedControlId
  }));
  const state = createCheckoutSessionState({ goal: "No paid extras", travelerId: "trav_exact_queue" });
  state.approvals.skipPaidExtrasApproved = true;
  state.requirementLifecycle = [requirements[0]];
  state.currentObligation = {
    userOutcome: {
      semanticFamily: "protection",
      desiredDisposition: "decline_paid",
      status: "satisfied",
      decisionGroupId: "dg_airhelp",
      requirementId: "protection:airhelp",
      selectedControlId: "ctrl_airhelp_none"
    }
  };

  const context = deriveAuthoritativeTaskContext({
    state,
    observation: current,
    requirements,
    traveler: { booking_rules: "no paid extras" }
  });
  assert.equal(context.remainingGoal.decisionGroupId, "dg_lost_baggage");
  assert.equal(context.userOutcome.status, "pending");

  const broadFamilyContext = {
    userOutcome: {
      semanticFamily: "protection",
      desiredDisposition: "decline_paid",
      status: "satisfied",
      decisionGroupId: "dg_airhelp",
      requirementId: "protection:airhelp"
    }
  };
  const reconciled = applyAuthoritativeOutcomeToRequirements(requirements, broadFamilyContext);
  assert.equal(reconciled.find((item) => item.decisionGroupId === "dg_airhelp").status, "satisfied");
  assert.equal(reconciled.find((item) => item.decisionGroupId === "dg_lost_baggage").status, "missing");
  assert.equal(reconciled.find((item) => item.decisionGroupId === "dg_premium_support").status, "missing");

  const completions = loopPrivate.exactDecisionCompletionRecords([], reconciled, current.observationId);
  assert.deepEqual(completions, [{
    surfaceId: "surface-page",
    decisionGroupId: "dg_airhelp",
    requirementId: "protection:airhelp",
    selectedControlId: "ctrl_airhelp_none",
    status: "satisfied",
    observationId: "obs_exact_group_queue"
  }]);
});

test("task-scoped filtering reduces 72 seat controls to untried safe Next and skips all AI calls", async () => {
  const surfaceId = "seat_modal";
  const groupId = "dg_seat";
  const control = ({ id, label, risk = "safe", semantic = "choice", disabled = false, surface = surfaceId }) => ({
    controlId: `ctrl_${id}`,
    stableKey: `seat.${id}`,
    meaning: label,
    structuredPrice: risk === "money" ? { amount: 18, currency: "EUR" } : null,
    decisionGroupId: surface === surfaceId ? groupId : "dg_other",
    sectionId: surface === surfaceId ? "section_seats" : "section_help",
    sectionType: surface === surfaceId ? "seats" : "help",
    surfaceId: surface,
    surfaceType: surface === surfaceId ? "modal" : "page",
    label,
    semantic,
    risk,
    kind: "button",
    role: "button",
    state: { disabled },
    stateElementId: `el_${id}`,
    preferredActivationElementId: `el_${id}`,
    actuators: [{ nodeId: `el_${id}`, relation: "activation" }],
    operations: { activate: actionableCapability("activate", `el_${id}`) },
    visualRegion: { x: 10, y: 10, width: 120, height: 30, inViewport: true }
  });
  const paid = Array.from({ length: 68 }, (_, index) => control({
    id: `paid_${index + 1}`,
    label: `Seat ${index + 1} — 18 EUR`,
    risk: "money",
    semantic: "add_paid_extra"
  }));
  const skip = control({ id: "skip", label: "Skip seat selection", semantic: "decline_paid_extra" });
  const next = control({ id: "next", label: "Next", semantic: "navigation" });
  const unavailable = control({ id: "unavailable", label: "Not available", semantic: "unavailable", disabled: true });
  const irrelevant = control({ id: "help", label: "Help", semantic: "help", surface: "surface-page" });
  const controls = [...paid, skip, next, unavailable, irrelevant];
  assert.equal(controls.length, 72);

  const current = observation("obs_72_seats", {
    currentSurface: {
      id: surfaceId,
      type: "modal",
      label: "Reserve seating — Flight 1 of 2",
      blocksBackground: true,
      memberControlIds: controls.filter((item) => item.surfaceId === surfaceId).map((item) => item.controlId),
      memberActuatorIds: controls.filter((item) => item.surfaceId === surfaceId).map((item) => item.preferredActivationElementId)
    },
    controls,
    decisionGroups: [{
      decisionGroupId: groupId,
      requirementId: "seat_decision",
      sectionId: "section_seats",
      sectionType: "seats",
      sectionLabel: "Seat selection",
      surfaceId,
      required: true,
      status: "missing",
      alternatives: [skip, unavailable, ...paid].map((item) => ({
        controlId: item.controlId,
        label: item.label,
        risk: item.risk,
        selected: false
      }))
    }]
  });
  const traveler = { id: "trav_72", booking_rules: "no paid seats and no paid extras" };
  let state = createCheckoutSessionState({
    goal: "Proceed without paid seats",
    travelerId: traveler.id,
    site: { host: "example.test", url: current.page.url }
  });
  state.id = "txn_72_seats";
  state.approvals.skipPaidExtrasApproved = true;
  state.requirements = loopPrivate.requirementsWithDecisionGroups([], current);
  state.activeRequirements = state.requirements;
  state.currentObservation = { observationId: current.observationId, observationHash: current.observationSnapshot.snapshotHash };

  const goal = require("../../apps/web/agent/observation-candidates").deriveObservationGoal(current, state.requirements);
  const firstSet = loopPrivate.groundedObservationCandidateSet(goal, current, [], { state, traveler, approvals: state.approvals });
  assert.deepEqual(firstSet.candidates.map((candidate) => candidate.targetLabel).sort(), ["Next", "Skip seat selection"]);
  const failedSkip = firstSet.candidates.find((candidate) => /skip/i.test(candidate.targetLabel));
  state.currentGoal = goal;
  state.failedStrategyMemory = [{
    goalKey: loopPrivate.semanticGoalRecoveryKey(goal),
    strategySignature: loopPrivate.candidateStrategySignature(goal, failedSkip),
    stableControlKey: failedSkip.affordance.stableKey,
    capability: failedSkip.operation
  }];

  const store = {
    isCurrentObservation: (_transactionId, observationId, observationHash) => (
      observationId === current.observationId && observationHash === current.observationSnapshot.snapshotHash
    ),
    reserveGovernedAction: () => ({ ok: true }),
    recordActionEvent: () => {},
    advanceGovernedAction: () => {},
    saveSession: () => {}
  };
  const turn = await runLoopTurn({
    apiKey: "",
    model: "must-not-be-called",
    dataDir: "",
    state,
    observation: current,
    traveler,
    transactionStore: store,
    clientTurnId: "turn_72"
  });

  assert.equal(turn.clientDecision.action, "click");
  assert.equal(turn.clientDecision.targetLabel, "Next");
  assert.equal(turn.clientDecision.affordance.effect, "advance_surface");
  assert.equal(turn.clientDecision.affordance.policy.allow, true);
  assert.equal(turn.debug.deterministic, true);
  assert.deepEqual(turn.debug.modelUsage.calls, []);
});

test("completed no-paid-seat obligation remains satisfied and publishes only safe forward progress", async () => {
  const surfaceId = "seat_modal";
  const groupId = "dg_seat";
  const control = ({ id, label, semantic, risk = "safe", price = null }) => ({
    controlId: `ctrl_${id}`,
    stableKey: `seat.${id}`,
    meaning: label,
    structuredPrice: price,
    decisionGroupId: groupId,
    sectionId: "section_seats",
    sectionType: "seats",
    surfaceId,
    surfaceType: "modal",
    label,
    semantic,
    risk,
    kind: "button",
    role: "button",
    state: { disabled: false },
    stateElementId: `el_${id}`,
    preferredActivationElementId: `el_${id}`,
    actuators: [{ nodeId: `el_${id}`, relation: "activation" }],
    operations: { activate: actionableCapability("activate", `el_${id}`) },
    visualRegion: { x: 10, y: 10, width: 120, height: 30, inViewport: true }
  });
  const chooseSeat = control({ id: "choose", label: "Choose seat", semantic: "seat_option" });
  const paidSeat = control({ id: "paid", label: "Seat 1A — 18 EUR", semantic: "add_paid_extra", risk: "money", price: { amount: 18, currency: "EUR" } });
  const back = control({ id: "back", label: "Back", semantic: "navigation" });
  const details = control({ id: "details", label: "Price details", semantic: "information" });
  const next = control({ id: "next", label: "Next", semantic: "navigation" });
  const controls = [chooseSeat, paidSeat, back, details, next];
  const current = observation("obs_completed_seat", {
    currentSurface: {
      id: surfaceId,
      type: "modal",
      label: "Reserve seating — Flight 1 of 2",
      blocksBackground: true,
      memberControlIds: controls.map((item) => item.controlId),
      memberActuatorIds: controls.map((item) => item.preferredActivationElementId)
    },
    controls,
    decisionGroups: [{
      decisionGroupId: groupId,
      requirementId: "seat_decision",
      sectionId: "section_seats",
      sectionType: "seats",
      sectionLabel: "Seat selection",
      surfaceId,
      required: true,
      status: "missing",
      alternatives: [chooseSeat, paidSeat].map((item) => ({
        controlId: item.controlId,
        label: item.label,
        risk: item.risk,
        structuredPrice: item.structuredPrice,
        selected: false
      }))
    }]
  });
  const traveler = { id: "trav_completed_seat", booking_rules: "no paid seats and no paid extras" };
  let state = createCheckoutSessionState({
    goal: "Proceed without paid seats",
    travelerId: traveler.id,
    site: { host: "example.test", url: current.page.url }
  });
  state.id = "txn_completed_seat";
  state.approvals.skipPaidExtrasApproved = true;
  state.requirements = loopPrivate.requirementsWithDecisionGroups([], current);
  state.activeRequirements = state.requirements;
  state.currentObligation = {
    userOutcome: {
      semanticFamily: "seat",
      desiredDisposition: "decline_paid",
      status: "satisfied",
      decisionGroupId: groupId
    }
  };

  const context = deriveAuthoritativeTaskContext({ state, observation: current, requirements: state.requirements, traveler });
  assert.equal(context.userOutcome.status, "satisfied");
  assert.equal(context.interfaceStatus.status, "needs_advance");
  assert.equal(context.remainingGoal.semanticType, "navigation");
  const authoritativeRequirements = applyAuthoritativeOutcomeToRequirements(state.requirements, context);
  assert.equal(authoritativeRequirements[0].status, "waived_by_policy");

  const candidateSet = loopPrivate.groundedObservationCandidateSet(
    context.remainingGoal,
    current,
    [],
    { state: { ...state, requirements: authoritativeRequirements }, traveler, approvals: state.approvals }
  );
  assert.deepEqual(candidateSet.candidates.map((candidate) => candidate.targetLabel), ["Next"]);

  const store = {
    isCurrentObservation: (_transactionId, observationId, observationHash) => (
      observationId === current.observationId && observationHash === current.observationSnapshot.snapshotHash
    ),
    reserveGovernedAction: () => ({ ok: true }),
    recordActionEvent: () => {},
    advanceGovernedAction: () => {},
    saveSession: () => {}
  };
  const turn = await runLoopTurn({
    apiKey: "",
    model: "must-not-be-called",
    dataDir: "",
    state,
    observation: current,
    traveler,
    transactionStore: store,
    clientTurnId: "turn_completed_seat"
  });

  assert.equal(turn.clientDecision.action, "click");
  assert.equal(turn.clientDecision.targetLabel, "Next");
  assert.equal(turn.state.currentObligation.userOutcome.status, "satisfied");
  assert.equal(turn.state.currentGoal.semanticType, "navigation");
  assert.equal(turn.debug.deterministic, true);
  assert.deepEqual(turn.debug.modelUsage.calls, []);
});

test("planner candidate schema is a closed enum over the current observation", () => {
  const schema = candidateSelectionSchemaFor(["obs_1:candidate_1", "obs_1:candidate_2"]);
  assert.deepEqual(schema.properties.candidateId.enum, ["obs_1:candidate_1", "obs_1:candidate_2"]);
  assert.equal(schema.additionalProperties, false);
});

test("invalid planner output retries the immutable candidate set without browser handoff", async () => {
  const current = observation("obs_invalid_planner", {
    currentSurface: {
      id: "seat_modal",
      type: "modal",
      label: "Seat preference",
      blocksBackground: true,
      memberControlIds: ["ctrl_free_a", "ctrl_free_b"],
      memberActuatorIds: ["el_free_a", "el_free_b"]
    },
    controls: ["a", "b"].map((suffix) => ({
      controlId: `ctrl_free_${suffix}`,
      stableKey: `seat.free.${suffix}`,
      decisionGroupId: "dg_seat",
      sectionId: "section_seat",
      sectionType: "seats",
      surfaceId: "seat_modal",
      surfaceType: "modal",
      label: `Free seating ${suffix.toUpperCase()}`,
      semantic: "decline_paid_extra",
      risk: "safe_decline",
      kind: "button",
      role: "button",
      state: { disabled: false },
      stateElementId: `el_free_${suffix}`,
      preferredActivationElementId: `el_free_${suffix}`,
      actuators: [{ nodeId: `el_free_${suffix}`, relation: "activation" }],
      operations: { activate: actionableCapability("activate", `el_free_${suffix}`) },
      visualRegion: { x: 20, y: 20, width: 120, height: 30, inViewport: true }
    })),
    decisionGroups: [{
      decisionGroupId: "dg_seat",
      requirementId: "seat_decision",
      sectionId: "section_seat",
      sectionType: "seats",
      surfaceId: "seat_modal",
      required: true,
      status: "missing",
      alternatives: [
        { controlId: "ctrl_free_a", label: "Free seating A", risk: "safe_decline" },
        { controlId: "ctrl_free_b", label: "Free seating B", risk: "safe_decline" }
      ]
    }]
  });
  const traveler = { id: "trav_invalid_planner", booking_rules: "no paid seats and no paid extras" };
  const state = createCheckoutSessionState({
    goal: "Proceed without paid seats",
    travelerId: traveler.id,
    site: { host: "example.test", url: current.page.url }
  });
  state.id = "txn_invalid_planner";
  state.approvals.skipPaidExtrasApproved = true;
  state.requirements = loopPrivate.requirementsWithDecisionGroups([], current);
  state.activeRequirements = state.requirements;
  const store = {
    isCurrentObservation: (_transactionId, observationId, observationHash) => (
      observationId === current.observationId && observationHash === current.observationSnapshot.snapshotHash
    ),
    reserveGovernedAction: () => ({ ok: true }),
    recordActionEvent: () => {},
    advanceGovernedAction: () => {},
    saveSession: () => {}
  };
  const previousFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return {
      ok: true,
      json: async () => ({ output_text: JSON.stringify({ candidateId: "invented_candidate" }) })
    };
  };
  try {
    const turn = await runLoopTurn({
      apiKey: "test-key",
      model: "test-model",
      dataDir: "",
      state,
      observation: current,
      traveler,
      transactionStore: store,
      clientTurnId: "turn_invalid_planner"
    });
    assert.equal(calls, 2);
    assert.equal(turn.clientDecision.action, "wait");
    assert.equal(turn.clientDecision.intent, "retry_planner_current_candidates");
    assert.equal(turn.state.status, "running");
    assert.equal(turn.debug.candidateGroundingRejected, true);
    assert.equal(turn.debug.aiServiceUnavailable, false);
  } finally {
    global.fetch = previousFetch;
  }
});

test("only contradictory current browser evidence can reopen a completed policy outcome", () => {
  const paidControl = {
    controlId: "ctrl_paid_seat",
    label: "Seat 1A — 18 EUR",
    semantic: "add_paid_extra",
    risk: "money",
    structuredPrice: { amount: 18, currency: "EUR" },
    selected: true
  };
  const current = observation("obs_paid_contradiction", {
    currentSurface: { id: "seat_modal", type: "modal", label: "Reserve seating" },
    controls: [paidControl],
    decisionGroups: [{
      decisionGroupId: "dg_seat",
      requirementId: "seat_decision",
      sectionType: "seats",
      sectionLabel: "Seat selection",
      surfaceId: "seat_modal",
      required: true,
      status: "satisfied",
      selectedControlId: paidControl.controlId,
      selectedLabel: paidControl.label,
      alternatives: [paidControl]
    }]
  });
  const requirements = loopPrivate.requirementsWithDecisionGroups([], current);
  const state = {
    id: "txn_paid_contradiction",
    goal: "Proceed without paid seats",
    approvals: { skipPaidExtrasApproved: true },
    currentObligation: {
      userOutcome: {
        semanticFamily: "seat",
        desiredDisposition: "decline_paid",
        status: "satisfied",
        decisionGroupId: "dg_seat"
      }
    }
  };
  const context = deriveAuthoritativeTaskContext({
    state,
    observation: current,
    requirements,
    traveler: { booking_rules: "no paid seats" }
  });
  assert.equal(context.userOutcome.status, "contradicted");
  assert.equal(context.userOutcome.contradiction.code, "PAID_OPTION_SELECTED");
  assert.equal(context.remainingGoal.decisionGroupId, "dg_seat");
});

test("typed waiver command is achieved by a browser-observed policy waiver without inventing a selected choice", () => {
  const before = observation("waiver_before", {
    decisionGroups: [{ decisionGroupId: "dg_seat", status: "missing", selectedControlId: "" }]
  });
  const after = observation("waiver_after", {
    decisionGroups: [{ decisionGroupId: "dg_seat", status: "waived_by_policy", selectedControlId: "" }]
  }, result("act_skip"));
  const transition = evaluateTransition({
    beforeObservation: before,
    governedAction: {
      id: "act_skip",
      type: "click",
      controlId: "ctrl_skip",
      decisionGroupId: "dg_seat",
      interactionRole: "command",
      semanticEffect: "waive",
      expectedEvidence: "dismissed",
      expectedOutcome: {
        type: "command_acknowledged",
        decisionGroupId: "dg_seat",
        expectedRequirementStatus: "waived_by_policy",
        acceptedRequirementStatuses: ["waived_by_policy", "waived", "satisfied"]
      }
    },
    browserResult: result("act_skip"),
    afterObservation: after
  });

  assert.equal(transition.status, "achieved");
  assert.equal(transition.postcondition.type, "command_acknowledged");
  assert.equal(transition.postcondition.evidence.resolutionStatus, "waived_by_policy");
  assert.equal(after.page.decisionGroups[0].selectedControlId, "");
});

test("waived_by_policy is resolved requirement truth but remains distinct from selected", () => {
  const waived = normalizeRequirement({
    id: "req_seat",
    type: "seat_decision",
    label: "Paid seat purchase",
    status: "waived_by_policy",
    required: true,
    risk: "money",
    confidence: 0.95
  });
  assert.equal(waived.status, "waived_by_policy");
  assert.equal(allRequiredSatisfied([waived]), true);
  assert.deepEqual(missingRequired([waived]), []);
});
