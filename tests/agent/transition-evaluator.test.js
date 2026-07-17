const test = require("node:test");
const assert = require("node:assert/strict");

const { diffObservations } = require("../../apps/web/agent/observation-diff");
const { evaluateTransition } = require("../../apps/web/agent/transition-evaluator");
const {
  advanceActionLifecycle,
  canonicalFailureCode
} = require("../../apps/web/agent/action-lifecycle");
const { __private: loopPrivate } = require("../../apps/web/agent/loop");
const { allRequiredSatisfied, missingRequired, normalizeRequirement } = require("../../packages/shared/requirements");

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
  assert.deepEqual(applied.state.attemptedStrategySignatures, ["ctrl_flex:open:effect::"]);
  assert.equal(applied.directive, "try_distinct_capability");
  assert.equal(applied.state.executionRecoveryAttempts, 1);
  assert.equal(applied.state.groundingRecoveryAttempts, 0);
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
      groundingRecoveryAttempts: 0,
      executionRecoveryAttempts: 0
    },
    observation: after,
    previousObservation: before
  });

  assert.equal(advanced.lifecycle.status, "rejected_before_dispatch");
  assert.equal(advanced.lifecycle.dispatched, false);
  assert.equal(advanced.transition, null);
  assert.equal(advanced.directive, "rebuild_candidates");
  assert.equal(advanced.state.groundingRecoveryAttempts, 1);
  assert.equal(advanced.state.executionRecoveryAttempts, 0);
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
      operations: { activate: { operation: "activate", actuatorId: "el_skip", actuatorIds: ["el_skip"] } }
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
      operations: { activate: { operation: "activate", actuatorId: "el_next", actuatorIds: ["el_next"] } }
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
