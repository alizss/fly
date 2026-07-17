const test = require("node:test");
const assert = require("node:assert/strict");

const { evaluateActionPolicy } = require("../../packages/shared/policy");
const { __private } = require("../../apps/web/agent/loop");
const { __private: governorPrivate } = require("../../apps/web/agent/action-governor");
const {
  PlannerContractError,
  resolvePlannerSelection,
  selectFromImmutableCandidateSet
} = require("../../apps/web/agent/verify-and-plan");
const {
  modelObservationContext,
  semanticActionContext,
  sanitizedActionHistory,
  sanitizedFailureHistory
} = require("../../apps/web/agent/model-context");
const { compactWholePageMarkdown } = require("../../apps/web/agent/observation-markdown");
const { conciseActionFeedback, diffObservations, formatObservationDiffMarkdown } = require("../../apps/web/agent/observation-diff");
const {
  actionForObservationCandidate,
  deriveObservationGoal,
  rawObservationCandidates
} = require("../../apps/web/agent/observation-candidates");
const { canonicalizePageSurface, currentSurface, surfaceBinding } = require("../../apps/web/agent/surface-contract");
const { actionForCurrentCandidate, buildCurrentCandidateSet } = require("../../apps/web/agent/current-candidate-builder");

function observationWithGroups() {
  return {
    observationId: "obs_test",
    observationSnapshot: { snapshotHash: "hash_test" },
    page: {
      decisionGroups: [
        {
          decisionGroupId: "dg_baggage",
          sectionId: "sec_baggage",
          sectionType: "baggage",
          sectionLabel: "Checked baggage",
          requirementId: "baggage",
          required: true,
          status: "satisfied",
          selectedControlId: "ctrl_bag_none",
          selectedLabel: "No checked baggage",
          alternatives: [
            { controlId: "ctrl_bag_none", targetId: "atw-bag-none", label: "No checked baggage", selected: true, risk: "safe_decline" },
            { controlId: "ctrl_bag_23kg", targetId: "atw-bag-23", label: "1 x 23 kg 44EUR", selected: false, risk: "money", priceText: "44EUR" }
          ],
          evidence: ["Selected: No checked baggage"]
        },
        {
          decisionGroupId: "dg_flexible_ticket",
          sectionId: "sec_flex",
          sectionType: "flexible_ticket",
          sectionLabel: "Flexible Ticket",
          requirementId: "flexible_ticket",
          required: true,
          status: "missing",
          selectedControlId: "",
          selectedLabel: "",
          alternatives: [
            { controlId: "ctrl_flex_none", targetId: "atw-flex-none", label: "None of the passengers", selected: false, risk: "safe_decline" },
            { controlId: "ctrl_flex_all", targetId: "atw-flex-all", label: "All passengers 29EUR", selected: false, risk: "money", priceText: "29EUR" }
          ],
          evidence: ["No selected option for Flexible Ticket"]
        }
      ],
      controls: [
        {
          controlId: "ctrl_bag_none",
          decisionGroupId: "dg_baggage",
          label: "No checked baggage",
          kind: "radio",
          stateElementId: "atw-bag-input",
          preferredActivationElementId: "atw-bag-label",
          actuators: [
            { nodeId: "atw-bag-input", relation: "state" },
            { nodeId: "atw-bag-label", relation: "label" },
            { nodeId: "atw-bag-wrapper", relation: "wrapper" }
          ],
          selected: true,
          state: { checked: true },
          visualRegion: { x: 10, y: 10, width: 140, height: 24 }
        },
        {
          controlId: "ctrl_flex_none",
          visualRef: "O1",
          decisionGroupId: "dg_flexible_ticket",
          label: "None of the passengers",
          kind: "radio",
          stateElementId: "atw-flex-input",
          preferredActivationElementId: "atw-flex-label",
          actuators: [
            { nodeId: "atw-flex-input", relation: "state" },
            { nodeId: "atw-flex-label", relation: "label" },
            { nodeId: "atw-flex-wrapper", relation: "wrapper" }
          ],
          selected: false,
          state: { checked: false },
          visualRegion: { x: 10, y: 80, width: 160, height: 24 }
        },
        {
          controlId: "ctrl_sms_none",
          decisionGroupId: "dg_booking_sms",
          label: "No thanks",
          kind: "radio",
          stateElementId: "atw-sms-input",
          preferredActivationElementId: "atw-sms-label",
          actuators: [
            { nodeId: "atw-sms-input", relation: "state" },
            { nodeId: "atw-sms-label", relation: "label" }
          ],
          selected: false,
          state: { checked: false },
          visualRegion: { x: 10, y: 140, width: 90, height: 24 }
        },
        {
          controlId: "ctrl_support_none",
          decisionGroupId: "dg_support",
          label: "No thanks",
          kind: "radio",
          stateElementId: "atw-support-input",
          preferredActivationElementId: "atw-support-label",
          actuators: [
            { nodeId: "atw-support-input", relation: "state" },
            { nodeId: "atw-support-label", relation: "label" }
          ],
          selected: false,
          state: { checked: false },
          visualRegion: { x: 10, y: 200, width: 90, height: 24 }
        }
      ],
      screenshotAnnotations: [
        {
          visualRef: "O1",
          targetId: "atw-flex-label",
          controlId: "ctrl_flex_none",
          decisionGroupId: "dg_flexible_ticket",
          label: "None of the passengers",
          kind: "radio",
          role: "radio",
          semantic: "decline_paid_extra",
          risk: "safe_decline",
          box: { x: 10, y: 80, width: 160, height: 24, centerX: 90, centerY: 92, inViewport: true }
        }
      ],
      buttons: [
        { id: "atw-continue", label: "Continue", risk: "safe", semantic: "continue" }
      ],
      sections: []
    }
  };
}

test("model history is semantic-only and cannot carry an obsolete executable target", () => {
  const forbidden = [
    "targetId", "controlId", "targetSnapshot", "visualRegion", "coordinates",
    "actuators", "operations", "domId", "elementId", "observationId", "actionId"
  ];
  const rawAction = {
    goal: "decline baggage",
    action: "choose free option",
    targetId: "obsolete_modal_button",
    controlId: "obsolete_modal_control",
    targetSnapshot: { id: "obsolete_node", visualRegion: { x: 10, y: 20 } },
    operations: { activate: { actuatorId: "obsolete_node" } }
  };
  const rawResult = {
    verified: true,
    outcome: { message: "modal closed", controlId: "obsolete_modal_control" },
    actionId: "old_action"
  };
  const contexts = [
    semanticActionContext(rawAction, rawResult),
    ...sanitizedActionHistory([{ ...rawAction, verified: true, outcome: "modal closed", payload: rawAction }]),
    ...sanitizedFailureHistory([{ ...rawAction, code: "STALE_OBSERVATION" }])
  ];

  for (const context of contexts) {
    assert.deepEqual(Object.keys(context).sort(), ["action", "goal", "outcome", "verified"]);
    const serialized = JSON.stringify(context);
    for (const key of forbidden) assert.equal(serialized.includes(`\"${key}\"`), false, key);
    assert.equal(serialized.includes("obsolete_modal_button"), false);
    assert.equal(serialized.includes("obsolete_modal_control"), false);
    assert.equal(serialized.includes("obsolete_node"), false);
  }
});

test("fresh observation candidates expose only current canonical flexible-ticket controls", () => {
  const closed = {
    observationId: "obs_136",
    observationSnapshot: { snapshotHash: "hash_136" },
    page: {
      snapshotHash: "hash_136",
      controls: [{
        controlId: "ctrl_flexible_current",
        decisionGroupId: "dg_flexible",
        sectionId: "sec_flexible",
        sectionType: "flexible_ticket",
        label: "Flexible Ticket",
        semantic: "choose_option",
        risk: "safe",
        stateElementId: "node_flexible_state",
        preferredActivationElementId: "node_flexible_opener",
        operations: { open: { actuatorId: "node_flexible_opener" } },
        visualRegion: { x: 20, y: 40, width: 240, height: 36, inViewport: true }
      }],
      decisionGroups: [{
        decisionGroupId: "dg_flexible",
        requirementId: "flexible_ticket",
        sectionId: "sec_flexible",
        sectionType: "flexible_ticket",
        sectionLabel: "Flexible Ticket",
        required: true,
        status: "missing",
        alternatives: [{ controlId: "ctrl_flexible_current", label: "Select one option" }]
      }]
    }
  };
  const goal = deriveObservationGoal(closed, []);
  const candidates = rawObservationCandidates(closed, goal);
  const candidateSet = __private.groundedObservationCandidateSet(goal, closed);

  assert.equal(goal.semanticGoal, "decline flexible ticket");
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].candidateId, "obs_136:candidate_1");
  assert.equal(candidates[0].controlId, "ctrl_flexible_current");
  assert.equal(candidates[0].operation, "open");
  assert.equal(candidateSet.observationId, "obs_136");
  assert.equal(candidateSet.observationHash, "hash_136");
  assert.equal(candidateSet.surfaceId, "surface-page");
  assert.equal(candidateSet.candidates[0].candidateId, "obs_136:candidate_1");
  assert.equal(candidates.some((candidate) => candidate.controlId === "obsolete_modal_control"), false);

  const bound = __private.bindTargetSnapshot(
    actionForObservationCandidate(goal, candidates[0], closed),
    closed
  );
  assert.equal(bound.candidateId, "obs_136:candidate_1");
  assert.equal(bound.controlId, "ctrl_flexible_current");
  assert.equal(bound.targetId, "node_flexible_opener");
  assert.equal(bound.targetSnapshot.controlId, "ctrl_flexible_current");
  assert.equal(bound.targetSnapshot.id, "node_flexible_opener");
});

test("governor rejects an expired candidate-set envelope before target execution", () => {
  const observation = observationWithGroups();
  observation.page.currentSurface = { id: "page", type: "page" };
  observation.page.controls[1].operations = {
    choose: { actuatorId: "atw-flex-label", actuatorIds: ["atw-flex-label"] }
  };
  observation.page.controls[1].visualRegion.inViewport = true;
  const goal = deriveObservationGoal(observation, []);
  const candidateSet = __private.groundedObservationCandidateSet(goal, observation);
  const candidate = candidateSet.candidates[0];
  const action = __private.bindTargetSnapshot(actionForObservationCandidate(goal, candidate, observation), observation);
  const failure = governorPrivate.currentGoalCandidateFailure(action, {
    currentGoal: {
      ...goal,
      candidateSet: { ...candidateSet, observationHash: "expired_hash" },
      candidates: candidateSet.candidates
    }
  }, observation, []);

  assert.equal(failure.allow, false);
  assert.equal(failure.decision, "recoverable");
  assert.equal(failure.code, "CANDIDATE_SET_OBSERVATION_MISMATCH");
});

test("stale canonical identity failures trigger bounded fresh replanning", () => {
  for (const code of ["CANONICAL_ALIAS_UNRESOLVED", "CANONICAL_ALIAS_CONFLICT", "STALE_OBSERVATION"]) {
    assert.equal(__private.staleIdentityRejection({ outcome: { code } }), true, code);
  }
  assert.equal(__private.staleIdentityRejection({ outcome: { code: "VALIDATION_ERROR" } }), false);

  const initial = { groundingRecoveryAttempts: 0, executionRecoveryAttempts: 0, lastAction: { type: "click" } };
  const preDispatch = __private.applyRecoveryBudget(initial, {
    dispatched: false,
    executed: false,
    verified: false,
    outcome: { code: "CURRENT_GOAL_CANDIDATE_MISMATCH" }
  });
  assert.equal(preDispatch.classification, "grounding_replan");
  assert.equal(preDispatch.groundingRecoveryAttempts, 1);
  assert.equal(preDispatch.executionRecoveryAttempts, 0);

  const dispatched = __private.applyRecoveryBudget(preDispatch.state, {
    dispatched: true,
    executed: true,
    verified: false,
    outcome: { code: "EXACT_FREE_OPTION_NOT_VERIFIED" }
  });
  assert.equal(dispatched.classification, "execution_strategy");
  assert.equal(dispatched.groundingRecoveryAttempts, 1);
  assert.equal(dispatched.executionRecoveryAttempts, 1);
});

test("planner executable contract contains only the authoritative candidateId", () => {
  const candidateSet = {
    observationId: "obs_wording",
    observationHash: "hash_wording",
    surfaceId: "page",
    candidates: [{
      candidateId: "obs_wording:candidate_1",
      controlId: "ctrl_flexible_open",
      operation: "open"
    }]
  };
  const selection = resolvePlannerSelection({ candidateId: "obs_wording:candidate_1" }, candidateSet);

  assert.deepEqual(Object.keys(selection).sort(), ["candidate", "candidateId"]);
  assert.equal(selection.candidateId, "obs_wording:candidate_1");
  assert.equal(selection.candidate.controlId, "ctrl_flexible_open");
  assert.throws(
    () => resolvePlannerSelection({ candidateId: "obs_old:candidate_9" }, candidateSet),
    (error) => error instanceof PlannerContractError && error.code === "PLANNER_CANDIDATE_NOT_CURRENT"
  );

  const recovered = __private.applyRecoveryBudget({
    groundingRecoveryAttempts: 0,
    executionRecoveryAttempts: 0,
    lastAction: { type: "click" }
  }, {
    dispatched: false,
    executed: false,
    verified: false,
    outcome: { code: "PLANNER_CANDIDATE_NOT_CURRENT" }
  });
  assert.equal(recovered.classification, "grounding_replan");
  assert.equal(recovered.groundingRecoveryAttempts, 1);
  assert.equal(recovered.executionRecoveryAttempts, 0);
  assert.equal(recovered.exhausted, false);
});

test("invalid model candidate IDs are retried against the same immutable candidate set", async () => {
  const candidateSet = Object.freeze({
    observationId: "obs_immutable",
    observationHash: "hash_immutable",
    surfaceId: "surface_seats",
    candidates: Object.freeze([{ candidateId: "obs_immutable:candidate_1", controlId: "ctrl_next" }])
  });
  const seenSets = [];
  const selected = await selectFromImmutableCandidateSet({
    candidateSet,
    maxAttempts: 3,
    requestSelection: async (attempt) => {
      seenSets.push(candidateSet);
      return {
        data: { action: { candidateId: attempt < 3 ? "obsolete:candidate_9" : "obs_immutable:candidate_1" } },
        meta: { attempt }
      };
    }
  });

  assert.equal(selected.attempt, 3);
  assert.equal(selected.selection.candidateId, "obs_immutable:candidate_1");
  assert.equal(seenSets.every((item) => item === candidateSet), true);
  assert.equal(candidateSet.observationId, "obs_immutable");
  assert.equal(candidateSet.observationHash, "hash_immutable");
});

test("the server-owned semantic affordance is unchanged from candidate through action", () => {
  const observation = {
    observationId: "obs_affordance",
    observationSnapshot: { snapshotHash: "hash_affordance" },
    page: {
      currentSurface: { id: "surface_seats", type: "modal", memberControlIds: ["ctrl_random"] },
      controls: [{
        controlId: "ctrl_random",
        stableKey: "seat_preference.random.free",
        meaning: "free random seat",
        structuredPrice: { amount: 0, currency: "EUR" },
        decisionGroupId: "dg_seat",
        surfaceId: "surface_seats",
        label: "Random seating — 0 EUR",
        semantic: "choice",
        risk: "safe",
        kind: "radio",
        role: "radio",
        stateElementId: "el_random_input",
        preferredActivationElementId: "el_random_label",
        operations: { choose: { actuatorId: "el_random_label", actuatorIds: ["el_random_label", "el_random_input"] } },
        visualRegion: { x: 10, y: 10, width: 180, height: 30, inViewport: true }
      }],
      decisionGroups: [{
        decisionGroupId: "dg_seat",
        surfaceId: "surface_seats",
        required: true,
        status: "missing",
        alternatives: [{ controlId: "ctrl_random", label: "Random seating — 0 EUR" }]
      }]
    }
  };
  const goal = deriveObservationGoal(observation, []);
  const candidateSet = buildCurrentCandidateSet({ goal, observation });
  const candidate = candidateSet.candidates[0];
  const action = actionForCurrentCandidate(goal, candidate, observation);

  assert.deepEqual(candidate.affordance, {
    stableKey: "seat_preference.random.free",
    meaning: "free random seat",
    structuredPrice: { amount: 0, currency: "EUR" },
    risk: "safe",
    capability: "choose",
    actuator: {
      stableKey: "seat_preference.random.free:actuator:choose",
      targetId: "el_random_label",
      controlId: "ctrl_random",
      proven: true,
      source: "canonical_operation"
    },
    effect: "select_free_option",
    postcondition: candidate.expectedOutcome
  });
  assert.deepEqual(action.affordance, candidate.affordance);
  assert.equal(action.affordance.postcondition.type, "exact_free_option_selected");
});

test("P1.2 compact whole-page Markdown aggregates seat cells and preserves critical controls", () => {
  const seatControls = Array.from({ length: 250 }, (_, index) => ({
    controlId: `ctrl_seat_${index + 1}`,
    label: `Seat ${Math.floor(index / 6) + 1}${String.fromCharCode(65 + (index % 6))}`,
    kind: "seat_cell",
    role: "button",
    semantic: "available seat",
    risk: index % 3 === 0 ? "money" : "safe",
    sectionType: "seats",
    sectionLabel: "Reserve seating",
    state: { disabled: index % 10 === 0 },
    visualRegion: { inViewport: index < 12 }
  }));
  const observation = {
    observationId: "obs_seats_compact",
    page: {
      step: "seats",
      priceText: "EUR208",
      currentSurface: { id: "seat_modal", type: "modal", label: "Reserve seating" },
      foreground: { progressMarkers: { flight: "1 of 2" } },
      controls: [
        ...seatControls,
        { controlId: "ctrl_skip", visualRef: "O5", label: "No thanks", kind: "button", semantic: "decline_paid_extra", risk: "safe_decline", surfaceId: "seat_modal" },
        { controlId: "ctrl_next", visualRef: "B2", label: "Next", kind: "button", semantic: "continue", risk: "safe_continue", surfaceId: "seat_modal" }
      ],
      decisionGroups: [{
        decisionGroupId: "dg_seats",
        sectionLabel: "Seat selection",
        sectionType: "seats",
        required: true,
        status: "missing",
        alternatives: []
      }]
    }
  };

  const compact = compactWholePageMarkdown(observation, {
    traveler: { booking_rules: "No paid seats" }
  });
  const context = modelObservationContext(observation, { booking_rules: "No paid seats" });

  assert.match(compact.markdown, /\[Stage\] seats/);
  assert.match(compact.markdown, /Reserve seating — active/);
  assert.match(compact.markdown, /flight 1 of 2/);
  assert.match(compact.markdown, /Seat cells aggregated\] 250 total/);
  assert.match(compact.markdown, /\[Button O5\] No thanks/);
  assert.match(compact.markdown, /\[Button B2\] Next/);
  assert.match(compact.markdown, /\[Policy\] No paid seats/);
  assert.equal(compact.markdown.includes("Seat 20A"), false);
  assert.ok(compact.markdown.length < 4_000);
  assert.equal(context.pageMarkdown, compact.markdown);
  assert.equal(Object.hasOwn(context, "page"), false);
});

test("P1.3 authoritative diff reports selection, popup, progress, validation, and target reaction", () => {
  const previous = {
    observationId: "obs_before_next",
    page: {
      step: "seats",
      url: "https://example.test/seats",
      priceText: "EUR208",
      currentSurface: { id: "seat_modal", type: "modal", label: "Reserve seating" },
      foreground: { progressMarkers: { flight: "1 of 2" } },
      controls: [{ controlId: "ctrl_next", visualRef: "B2", label: "Next", kind: "button", state: { disabled: false } }],
      decisionGroups: [{ decisionGroupId: "dg_seat", sectionLabel: "Seat decision", status: "missing", selectedControlId: "", selectedLabel: "" }],
      validationIssues: []
    }
  };
  const current = {
    observationId: "obs_after_next",
    lastActionResult: { dispatched: true, controlId: "ctrl_next" },
    page: {
      step: "seats",
      url: "https://example.test/seats",
      priceText: "EUR208",
      currentSurface: { id: "seat_confirm", type: "modal", label: "Continue without seats?" },
      foreground: { progressMarkers: { flight: "2 of 2" } },
      controls: [
        { controlId: "ctrl_continue_without", visualRef: "O5", label: "Continue without seats", kind: "button", risk: "safe_decline" }
      ],
      decisionGroups: [{ decisionGroupId: "dg_seat", sectionLabel: "Seat decision", status: "satisfied", selectedControlId: "ctrl_none", selectedLabel: "No seats" }],
      validationIssues: [{ issueId: "warn_seat", message: "Confirm travel without seats", stageWide: false }]
    }
  };

  const diff = diffObservations(previous, current);
  const markdown = formatObservationDiffMarkdown(diff, current);
  const feedback = conciseActionFeedback(diff, current.lastActionResult);

  assert.equal(diff.modalOpened.label, "Continue without seats?");
  assert.equal(diff.modalClosed.label, "Reserve seating");
  assert.equal(diff.progressChanged.from.flight, "1 of 2");
  assert.equal(diff.progressChanged.to.flight, "2 of 2");
  assert.equal(diff.decisionChanges[0].status.to, "satisfied");
  assert.equal(diff.errorsAppeared[0].message, "Confirm travel without seats");
  assert.equal(diff.targetReacted, true);
  assert.match(markdown, /CHANGED:/);
  assert.match(markdown, /APPEARED:/);
  assert.match(markdown, /Continue without seats/);
  assert.deepEqual(feedback, {
    dispatched: true,
    targetReacted: true,
    selectionChanged: true,
    surfaceChanged: true,
    progressChanged: true,
    priceChanged: false
  });
});

test("P1.4 action contracts accept intermediate transitions without weakening exact choices", () => {
  const page = {
    priceText: "EUR208",
    currentSurface: { id: "seat_modal", type: "modal", label: "Reserve seating" }
  };
  const choice = __private.expectedOutcomeForAction({
    type: "click",
    intent: "decline_optional_extra",
    requirementId: "dg_seat",
    controlId: "ctrl_no_seat",
    decisionGroupId: "dg_seat",
    targetLabel: "No thanks",
    targetSnapshot: {
      controlId: "ctrl_no_seat",
      decisionGroupId: "dg_seat",
      kind: "radio",
      label: "No thanks",
      risk: "safe_decline",
      surfaceId: "seat_modal",
      surfaceType: "modal"
    }
  }, page);
  const open = __private.expectedOutcomeForAction({
    type: "click",
    intent: "open_choice_control",
    controlId: "ctrl_flex",
    targetSnapshot: { controlId: "ctrl_flex", kind: "combobox", surfaceId: "page" }
  }, page);
  const next = __private.expectedOutcomeForAction({
    type: "click",
    intent: "navigate_stage",
    controlId: "ctrl_next",
    targetSnapshot: { controlId: "ctrl_next", kind: "button" }
  }, page);

  assert.equal(choice.type, "exact_free_option_selected");
  assert.equal(choice.requireSurfaceDismissed, false);
  assert.equal(open.type, "options_surface_appeared");
  assert.equal(next.type, "stage_exit_or_feedback");
});

test("risk-scoped candidate generation excludes only controls touched by graph conflicts", () => {
  const observation = {
    observationId: "obs_seat_conflicts",
    observationSnapshot: { snapshotHash: "hash_seat_conflicts" },
    page: {
      currentSurface: { id: "seat_modal", type: "modal", label: "Reserve seating" },
      activeSurface: { id: "seat_modal", type: "modal", label: "Reserve seating" },
      graphIntegrity: {
        ok: false,
        conflicts: [{
          nodeIds: ["el_unavailable"],
          existing: { controlId: "ctrl_unavailable" },
          incoming: { controlId: "ctrl_removed_unavailable" },
          resolved: false
        }]
      },
      controls: [
        {
          controlId: "ctrl_no_thanks",
          decisionGroupId: "dg_seats",
          sectionId: "seat_modal",
          sectionType: "seats",
          surfaceId: "seat_modal",
          label: "No thanks",
          semantic: "decline_paid_extra",
          risk: "safe_decline",
          visualRegion: { inViewport: true },
          operations: { choose: { actuatorId: "el_no_thanks", actuatorIds: ["el_no_thanks"] } }
        },
        {
          controlId: "ctrl_unavailable",
          decisionGroupId: "dg_seats",
          sectionId: "seat_modal",
          sectionType: "seats",
          surfaceId: "seat_modal",
          label: "Not available",
          semantic: "seat_unavailable",
          risk: "safe",
          visualRegion: { inViewport: true },
          operations: { choose: { actuatorId: "el_unavailable", actuatorIds: ["el_unavailable"] } }
        }
      ],
      decisionGroups: [{
        decisionGroupId: "dg_seats",
        sectionId: "seat_modal",
        sectionType: "seats",
        sectionLabel: "Seat selection",
        required: true,
        status: "missing",
        alternatives: [{ controlId: "ctrl_no_thanks" }, { controlId: "ctrl_unavailable" }]
      }]
    }
  };
  const goal = deriveObservationGoal(observation, []);
  const candidates = rawObservationCandidates(observation, goal);
  assert.ok(candidates.some((candidate) => candidate.controlId === "ctrl_no_thanks"));
  assert.equal(candidates.some((candidate) => candidate.controlId === "ctrl_unavailable"), false);
  assert.equal(candidates.some((candidate) => candidate.type === "ask_user"), false);
});

test("currentSurface is the sole candidate and envelope ownership authority", () => {
  const page = canonicalizePageSurface({
    currentSurface: {
      id: "surface_current_popover",
      type: "popover",
      blocksBackground: true,
      memberControlIds: ["ctrl_no_thanks"],
      memberActuatorIds: ["el_no_thanks"]
    },
    activeSurface: { id: "surface_stale_page", type: "page" },
    controls: [
      {
        controlId: "ctrl_no_thanks",
        decisionGroupId: "dg_seat",
        label: "No thanks",
        semantic: "decline_paid_extra",
        risk: "safe_decline",
        surfaceId: "surface_current_popover",
        visualRegion: { inViewport: true },
        operations: { choose: { actuatorId: "el_no_thanks", actuatorIds: ["el_no_thanks"] } }
      },
      {
        controlId: "ctrl_missing_surface",
        decisionGroupId: "dg_seat",
        label: "Not available",
        surfaceId: "",
        visualRegion: { inViewport: true },
        operations: { choose: { actuatorId: "el_missing", actuatorIds: ["el_missing"] } }
      },
      {
        controlId: "ctrl_background",
        decisionGroupId: "dg_seat",
        label: "Background continue",
        surfaceId: "surface-page",
        visualRegion: { inViewport: true },
        operations: { activate: { actuatorId: "el_background", actuatorIds: ["el_background"] } }
      }
    ],
    decisionGroups: [{
      decisionGroupId: "dg_seat",
      sectionType: "seats",
      required: true,
      status: "missing",
      alternatives: [
        { controlId: "ctrl_no_thanks" },
        { controlId: "ctrl_missing_surface" },
        { controlId: "ctrl_background" }
      ]
    }]
  });
  const observation = {
    observationId: "obs_surface_authority",
    observationSnapshot: { snapshotHash: "hash_surface_authority" },
    page
  };
  const goal = deriveObservationGoal(observation, []);
  const candidates = rawObservationCandidates(observation, goal);
  assert.equal(Object.hasOwn(page, "activeSurface"), false);
  assert.equal(currentSurface(page).id, "surface_current_popover");
  assert.equal(surfaceBinding(observation).surfaceId, "surface_current_popover");
  assert.deepEqual(candidates.map((candidate) => candidate.controlId), ["ctrl_no_thanks"]);
});

test("P0.10 derives one canonical requirement per decision group and drops duplicate choice requirements", () => {
  const observation = observationWithGroups();
  const classified = [
    {
      id: "choice_baggage_duplicate",
      type: "baggage_decision",
      label: "Checked baggage",
      status: "missing",
      required: true,
      risk: "money",
      evidence: ["Classifier saw paid alternatives"],
      confidence: 0.6,
      targetIds: ["atw-bag-23"]
    },
    {
      id: "field_email",
      type: "contact_field",
      label: "E-mail",
      status: "satisfied",
      required: true,
      risk: "safe",
      evidence: ["Email field has value"],
      confidence: 0.95,
      targetIds: ["email"]
    }
  ];

  const requirements = __private.requirementsWithDecisionGroups(classified, observation);

  assert.equal(requirements.some((req) => req.id === "choice_baggage_duplicate"), false);
  assert.equal(requirements.some((req) => req.id === "field_email"), true);
  assert.equal(requirements.find((req) => req.id === "dg_baggage").status, "satisfied");
  assert.equal(requirements.find((req) => req.id === "dg_flexible_ticket").status, "missing");
});

test("P0.8 rejects evidence from another decision group", () => {
  const observation = observationWithGroups();
  const [baggageRequirement] = __private.requirementsWithDecisionGroups([], observation)
    .filter((req) => req.id === "dg_baggage");

  const wrongGroupUpdate = {
    requirementId: "dg_baggage",
    proposedStatus: "satisfied",
    observationId: "obs_test",
    confidence: 0.99,
    evidence: {
      controlId: "ctrl_flex_none",
      selectedValue: "None of the passengers",
      visibleText: "Flexible Ticket"
    }
  };

  assert.equal(
    __private.updateEvidenceMatchesRequirement(wrongGroupUpdate, baggageRequirement, observation),
    false
  );
});

test("P0.8 deterministic current decision-group state outranks stale verifier claims", () => {
  const observation = observationWithGroups();
  const requirements = __private.requirementsWithDecisionGroups([], observation);
  const flexRequirement = requirements.find((req) => req.id === "dg_flexible_ticket");

  const reconciled = __private.reconcileRequirements([flexRequirement], {
    requirementUpdates: [
      {
        requirementId: "dg_flexible_ticket",
        proposedStatus: "satisfied",
        observationId: "obs_test",
        confidence: 0.99,
        evidence: { controlId: "ctrl_bag_none", selectedValue: "No checked baggage", visibleText: "Checked baggage" }
      }
    ]
  }, observation);

  assert.equal(reconciled[0].status, "missing");
  assert.match(reconciled[0].evidence.join(" "), /No selected option for Flexible Ticket/);
});

test("P0.10 fails closed when a choice requirement has no canonical decision group", () => {
  const observation = { observationId: "obs_current", page: { decisionGroups: [], controls: [] } };
  const [requirement] = __private.requirementsWithDecisionGroups([{
    id: "model_baggage_choice",
    type: "baggage_decision",
    label: "Checked baggage",
    status: "satisfied",
    required: false,
    risk: "money",
    evidence: ["Classifier inferred a selected option"],
    confidence: 0.92,
    targetIds: ["visual_guess"]
  }], observation);

  assert.equal(requirement.status, "conflicted");
  assert.equal(requirement.required, true);
  assert.equal(requirement.confidence, 0);
  assert.match(requirement.evidence.join(" "), /CANONICAL_DECISION_GROUP_MISSING/);
  assert.equal(__private.updateEvidenceMatchesRequirement({
    requirementId: requirement.id,
    proposedStatus: "satisfied",
    observationId: "obs_current",
    confidence: 0.99,
    evidence: { controlId: "visual_guess", visibleText: "No checked baggage" }
  }, requirement, observation), false);
});

test("P0.4 Continue blocks missing required decision groups but not unselected paid alternatives in satisfied groups", () => {
  const observation = observationWithGroups();
  const requirements = __private.requirementsWithDecisionGroups([], observation);
  const continueAction = {
    type: "click",
    targetLabel: "Continue",
    targetSnapshot: { controlId: "ctrl_continue", label: "Continue", kind: "button", risk: "safe", semantic: "continue" },
    risk: "safe"
  };

  const blocked = evaluateActionPolicy(continueAction, { requirements, priceHistory: [] }, { booking_rules: "no extras no seats" }, {});
  assert.equal(blocked.allow, false);
  assert.match(blocked.reason, /Flexible Ticket/);

  const allSatisfied = requirements.map((req) =>
    req.id === "dg_flexible_ticket" ? { ...req, status: "satisfied", selectedLabel: "None of the passengers" } : req
  );
  const allowed = evaluateActionPolicy(continueAction, { requirements: allSatisfied, priceHistory: [] }, { booking_rules: "no extras no seats" }, {});
  assert.equal(allowed.allow, true);
});

test("P0.6 typed policy trusts canonical semantic risk instead of button wording", () => {
  const safeDeclineWithPaidLookingCopy = evaluateActionPolicy({
    type: "click",
    intent: "decline_optional_extra",
    targetLabel: "Premium add to cart",
    targetSnapshot: {
      controlId: "ctrl_safe_decline",
      semantic: "decline_paid_extra",
      risk: "safe_decline",
      kind: "button"
    },
    risk: "safe"
  }, { requirements: [], priceHistory: [] }, { booking_rules: "no extras" }, {});
  assert.equal(safeDeclineWithPaidLookingCopy.allow, true);

  const paidControlWithSafeLookingCopy = evaluateActionPolicy({
    type: "click",
    intent: "choose_option",
    targetLabel: "No thanks",
    targetSnapshot: {
      controlId: "ctrl_paid",
      semantic: "add_paid_extra",
      risk: "money",
      kind: "choice"
    },
    risk: "money"
  }, { requirements: [], priceHistory: [] }, { booking_rules: "no extras" }, {});
  assert.equal(paidControlWithSafeLookingCopy.allow, false);
});

test("P0.9 binds repeated labels by canonical controlId instead of first matching text", () => {
  const observation = observationWithGroups();
  const action = {
    type: "click",
    targetId: "ctrl_support_none",
    targetLabel: "No thanks"
  };

  const bound = __private.bindTargetSnapshot(action, observation);

  assert.equal(bound.targetSnapshot.controlId, "ctrl_support_none");
  assert.equal(bound.targetSnapshot.id, "atw-support-label");
  assert.equal(bound.targetSnapshot.decisionGroupId, "dg_support");
});

test("P0.9 preserves decision-group identity when binding a logical control target", () => {
  const observation = observationWithGroups();
  const bound = __private.bindTargetSnapshot({
    type: "click",
    targetId: "ctrl_bag_none",
    targetLabel: "No checked baggage"
  }, observation);

  assert.equal(bound.controlId, "ctrl_bag_none");
  assert.equal(bound.decisionGroupId, "dg_baggage");
  assert.equal(bound.targetSnapshot.stateElementId, "atw-bag-input");
  assert.equal(bound.targetSnapshot.preferredActivationElementId, "atw-bag-label");
});

test("P0.4/P0.7 binds type to the state element while click uses the activation element", () => {
  const observation = observationWithGroups();
  observation.page.controls.push({
    controlId: "ctrl_email",
    label: "E-mail",
    kind: "field",
    role: "textbox",
    semantic: "email",
    risk: "safe",
    stateElementId: "atw-email-input",
    preferredActivationElementId: "atw-email-label",
    actuators: [
      { nodeId: "atw-email-input", relation: "state" },
      { nodeId: "atw-email-label", relation: "label" }
    ]
  });

  const typed = __private.bindTargetSnapshot({ type: "type", targetId: "ctrl_email", value: "ali@example.test" }, observation);
  const clicked = __private.bindTargetSnapshot({ type: "click", targetId: "ctrl_email" }, observation);

  assert.equal(typed.targetSnapshot.id, "atw-email-input");
  assert.equal(clicked.targetSnapshot.id, "atw-email-label");
});

test("P0.7/P0.9 resolves every canonical alias to one logical control", () => {
  const observation = observationWithGroups();
  const aliases = [
    "ctrl_bag_none",
    "atw-bag-input",
    "atw-bag-label",
    "atw-bag-wrapper"
  ];

  for (const aliasId of aliases) {
    const resolution = __private.resolveActionControl({ type: "click", targetId: aliasId }, observation.page);
    assert.equal(resolution.ok, true, aliasId);
    assert.equal(resolution.control.controlId, "ctrl_bag_none", aliasId);
    const bound = __private.bindTargetSnapshot({ type: "click", targetId: aliasId }, observation);
    assert.equal(bound.controlId, "ctrl_bag_none", aliasId);
    assert.equal(bound.targetSnapshot.controlId, "ctrl_bag_none", aliasId);
    assert.equal(bound.targetSnapshot.decisionGroupId, "dg_baggage", aliasId);
  }

  assert.equal(__private.controlDecisionGroupId("atw-bag-wrapper", observation.page), "dg_baggage");
});

test("P0.7/P0.9 fails closed when one alias is owned by incompatible controls", () => {
  const observation = observationWithGroups();
  observation.page.controls.find((control) => control.controlId === "ctrl_support_none")
    .actuators.push({ nodeId: "atw-sms-label", relation: "label" });

  const index = __private.buildControlAliasIndex(observation.page);
  assert.equal(index.resolve("atw-sms-label"), null);
  assert.equal(index.conflicts.some((conflict) => conflict.code === "ALIAS_OWNERSHIP_CONFLICT"), true);

  const bound = __private.bindTargetSnapshot({ type: "click", targetId: "atw-sms-label" }, observation);
  assert.equal(bound.controlId, "");
  assert.equal(bound.targetSnapshot, null);
});

test("P0.7 refuses label-only mutation instead of recovering a DOM target from text", () => {
  const observation = observationWithGroups();
  const bound = __private.bindTargetSnapshot({
    type: "click",
    targetLabel: "No thanks",
    intent: "decline_optional_extra",
    risk: "safe_decline"
  }, observation);

  assert.equal(bound.targetSnapshot, null);
  const decision = evaluateActionPolicy(bound, { requirements: [], priceHistory: [] }, {
    booking_rules: "no extras"
  }, {});
  assert.equal(decision.allow, false);
  assert.match(decision.reason, /canonical control/i);
});

test("P1.1 binds annotated screenshot visualRef to the canonical control", () => {
  const observation = observationWithGroups();
  const bound = __private.bindTargetSnapshot({
    type: "click",
    targetId: "O1",
    targetLabel: "None of the passengers"
  }, observation);

  assert.equal(bound.targetSnapshot.visualRef, "O1");
  assert.equal(bound.targetSnapshot.controlId, "ctrl_flex_none");
  assert.equal(bound.targetSnapshot.decisionGroupId, "dg_flexible_ticket");
  assert.equal(bound.targetSnapshot.id, "atw-flex-label");
});

test("P0.10 live selected dropdown group state survives stale missing model claims", () => {
  const observation = observationWithGroups();
  observation.page.decisionGroups = observation.page.decisionGroups.map((group) =>
    group.decisionGroupId === "dg_flexible_ticket"
      ? {
          ...group,
          status: "satisfied",
          selectedControlId: "ctrl_flex_none",
          selectedLabel: "None of the passengers",
          alternatives: group.alternatives.map((choice) =>
            choice.controlId === "ctrl_flex_none" ? { ...choice, selected: true } : choice
          ),
          evidence: ["Selected: None of the passengers"]
        }
      : group
  );

  const classified = [
    {
      id: "model_flex_missing",
      decisionGroupId: "dg_flexible_ticket",
      type: "paid_extra_decision",
      label: "Flexible Ticket",
      status: "missing",
      required: true,
      risk: "money",
      evidence: ["Model did not see the collapsed selected value"],
      confidence: 0.8,
      targetIds: ["atw-el-324"]
    }
  ];

  const requirements = __private.requirementsWithDecisionGroups(classified, observation);
  const flex = requirements.find((req) => req.id === "dg_flexible_ticket");

  assert.equal(requirements.some((req) => req.id === "model_flex_missing"), false);
  assert.equal(flex.status, "satisfied");
  assert.equal(flex.selectedLabel, "None of the passengers");
});

test("P0.10 stable logical decision group is independent of changing DOM element ids", () => {
  const first = {
    decisionGroupId: "dg_flexible_ticket_flexible-ticket",
    sectionId: "atw-el-316",
    sectionType: "flexible_ticket",
    sectionLabel: "Flexible Ticket",
    requirementId: "flexible_ticket",
    required: true,
    status: "satisfied",
    selectedControlId: "ctrl_flex_none",
    selectedLabel: "None of the passengers",
    alternatives: []
  };
  const reopened = {
    ...first,
    sectionId: "atw-el-324"
  };

  assert.equal(first.decisionGroupId, reopened.decisionGroupId);
  assert.notEqual(first.sectionId, reopened.sectionId);
});

test("P1.4 foreground decline requires active surface dismissal instead of generic requirement evidence", () => {
  const page = {
    currentSurface: {
      id: "modal_baggage_confirm",
      type: "modal",
      label: "Baggage confirmation"
    },
    activeSurface: {
      id: "modal_baggage_confirm",
      type: "modal",
      label: "Baggage confirmation"
    }
  };
  const action = {
    type: "click",
    intent: "decline_optional_extra",
    targetId: "atw-go-without",
    decisionGroupId: "dg_modal_baggage_confirm",
    targetSnapshot: {
      id: "atw-go-without",
      label: "I'll go without",
      semantic: "decline_paid_extra",
      risk: "safe_decline",
      surfaceId: "modal_baggage_confirm",
      surfaceType: "modal",
      surfaceLabel: "Baggage confirmation",
      decisionGroupId: "dg_modal_baggage_confirm"
    },
    expectedOutcome: {
      type: "requirement_status",
      requirementId: "baggage",
      status: "satisfied"
    }
  };

  const expected = __private.expectedOutcomeForAction(action, page);

  assert.equal(expected.type, "active_surface_dismissed");
  assert.equal(expected.surfaceId, "modal_baggage_confirm");
  assert.equal(expected.surfaceType, "modal");
  assert.equal(expected.mustNotIncreasePrice, true);
});

test("P0.11 builds authoritative lifecycle requirements with explicit scope and interface state", () => {
  const observation = observationWithGroups();
  observation.page.step = "traveler_information";
  const rawRequirements = __private.requirementsWithDecisionGroups([], observation);

  const lifecycle = __private.canonicalRequirementLifecycle(rawRequirements, observation, [], {
    booking_rules: "no extras no seats"
  }, "traveler_information");
  const flex = lifecycle.find((item) => item.requirementId === "dg_flexible_ticket");

  assert.equal(flex.semanticType, "paid_extra_decision");
  assert.equal(flex.scope.stage, "traveler_information");
  assert.equal(flex.scope.decisionGroupId, "dg_flexible_ticket");
  assert.equal(flex.desiredDisposition, "decline");
  assert.equal(flex.lifecycleStatus, "active");
  assert.equal(flex.interfaceStatus, "pending");
  assert.equal(flex.createdObservationId, "obs_test");
  assert.equal(flex.lastObservedObservationId, "obs_test");
});

test("P0.11 stale scoped requirements leave the active planning view", () => {
  const firstObservation = observationWithGroups();
  firstObservation.page.step = "traveler_information";
  const firstRequirements = __private.requirementsWithDecisionGroups([], firstObservation);
  const firstLifecycle = __private.canonicalRequirementLifecycle(firstRequirements, firstObservation, [], {
    booking_rules: "no extras no seats"
  }, "traveler_information");

  const secondObservation = {
    observationId: "obs_after_modal",
    page: {
      step: "seats",
      decisionGroups: [],
      controls: [],
      fields: [],
      sections: []
    }
  };
  const secondLifecycle = __private.canonicalRequirementLifecycle([], secondObservation, firstLifecycle, {
    booking_rules: "no extras no seats"
  }, "seats");
  const active = __private.activeRequirementView(secondLifecycle);

  assert.equal(secondLifecycle.some((item) => item.lifecycleStatus === "stale"), true);
  assert.equal(active.some((item) => item.requirementId === "dg_flexible_ticket"), false);
});
