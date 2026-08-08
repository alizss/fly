const test = require("node:test");
const assert = require("node:assert/strict");

const { diffObservations } = require("../../apps/web/agent/observation-diff");
const { evaluateTransition } = require("../../apps/web/agent/transition-evaluator");
const { verifiedCommerceObligationFromActionResult } = require("../../apps/web/agent/task-state-reducer");
const {
  advanceActionLifecycle,
  canonicalFailureCode,
  pendingActionRecord
} = require("../../apps/web/agent/action-lifecycle");
const { runLoopTurn, __private: loopPrivate } = require("../../apps/web/agent/loop");
const { allRequiredSatisfied, missingRequired, normalizeRequirement } = require("../../packages/shared/requirements");
const { createCheckoutSessionState } = require("../../packages/shared/agent-state");
const {
  applyAuthoritativeOutcomeToRequirements,
  deriveAuthoritativeTaskContext
} = require("../../apps/web/agent/task-action-context");
const { candidateSelectionSchemaFor } = require("../../apps/web/agent/schemas");
const { currentObligationFromGoal, taskBindingGoal } = require("../../apps/web/agent/authority-frames");
const legacyRequirementReplay = require("./legacy-requirement-replay-adapter");

function actionableCapability(operation, actuatorId, { inViewport = true } = {}) {
  const actionability = {
    rendered: true,
    visible: true,
    enabled: true,
    inViewport,
    inCurrentSurface: true,
    hitTested: inViewport,
    notOccluded: inViewport,
    targetable: inViewport,
    operationAuthorized: true,
    operationProven: true,
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

test("authoritative transition records exact free selection as fresh visible progress", () => {
  const before = observation("before", {
    controls: [{ controlId: "ctrl_free", decisionGroupId: "dg_seat", label: "No thanks", semantic: "decline_paid_extra", risk: "safe_decline", selected: false }],
    decisionGroups: [{ decisionGroupId: "dg_seat", status: "missing", selectedControlId: "" }]
  });
  const after = observation("after", {
    controls: [{ controlId: "ctrl_free", decisionGroupId: "dg_seat", label: "No thanks", semantic: "decline_paid_extra", risk: "safe_decline", selected: true }],
    decisionGroups: [{ decisionGroupId: "dg_seat", status: "satisfied", selectedControlId: "ctrl_free", selectedLabel: "No thanks", selectedSemantic: "decline_paid_extra" }]
  }, result());
  const governedAction = {
    id: "act_1",
    controlId: "ctrl_free",
    decisionGroupId: "dg_seat",
    mechanicalEffect: "select_free_option",
    expectedOutcome: {
      type: "exact_free_option_selected",
      controlId: "ctrl_free",
      expectedSelectedControlId: "ctrl_free",
      parentExpectedSelectedControlId: "ctrl_free",
      decisionGroupId: "dg_seat",
      parentDecisionGroupId: "dg_seat",
      mustNotIncreasePrice: true
    },
    affordance: {
      physicalEffect: "select_free_option",
      task: {
        canonicalOwnerId: "seats:extras:seat-decline:dg_seat:global",
        decisionInstanceId: "seats:extras:seat-decline:dg_seat:global",
        decisionGroupId: "dg_seat",
        parentDecisionGroupId: "dg_seat",
        parentExpectedSelectedControlId: "ctrl_free",
        semanticType: "decline_optional_extra"
      }
    }
  };
  const transition = evaluateTransition({
    beforeObservation: before,
    governedAction,
    browserResult: result(),
    afterObservation: after
  });
  assert.equal(transition.status, "progressed");
  assert.equal(transition.nextDirective, "rebuild_from_fresh_observation");
  assert.equal(transition.postcondition.evidence.selectedControlId, "ctrl_free");

  after.lastActionResult = {
    ...after.lastActionResult,
    action: governedAction,
    mechanicalEffect: "select_free_option",
    expectedOutcome: governedAction.expectedOutcome
  };
  const advanced = advanceActionLifecycle({
    state: { lastAction: governedAction },
    observation: after,
    previousObservation: before
  });
  assert.equal(advanced.transition.status, "progressed");
  assert.equal(advanced.lifecycle.verified, false);
  assert.equal(advanced.lifecycle.localOutcomeVerified, true, JSON.stringify({
    postcondition: advanced.transition.postcondition,
    currentObligationResult: advanced.transition.currentObligationResult,
    localMechanicalResult: advanced.transition.localMechanicalResult
  }));
  assert.equal(advanced.observation.lastActionResult.taskProgressStatus, "progressed");
  assert.equal(advanced.observation.lastActionResult.localPostconditionSatisfied, true);
  assert.equal(advanced.observation.lastActionResult.localOutcomeVerified, true);
  assert.equal(advanced.observation.lastActionResult.verified, true);
  const receipt = verifiedCommerceObligationFromActionResult(
    advanced.observation.lastActionResult,
    after.observationId
  );
  assert.equal(receipt.actionId, "act_1");
  assert.equal(receipt.decisionInstanceId, "seats:extras:seat-decline:dg_seat:global");
});

test("matching browser-verified stage advancement cannot be rewritten as no effect", () => {
  const before = observation("browser_stage_before", {
    step: "traveler_information",
    url: "https://example.test/travelers",
    currentSurface: { id: "surface-page", type: "page", label: "Travelers" }
  });
  const action = {
    id: "act_continue_verified",
    observationId: before.observationId,
    controlId: "ctrl_continue",
    type: "click",
    mechanicalEffect: "advance_checkout_stage",
    expectedOutcome: { type: "checkout_stage_advanced", controlId: "ctrl_continue" }
  };
  const browserResult = {
    actionId: action.id,
    observationId: before.observationId,
    dispatched: true,
    executed: true,
    verified: true,
    expectedOutcomeObserved: true,
    postconditionSatisfied: true,
    expectedOutcome: action.expectedOutcome,
    feedback: { outcomeVerified: true, navigationOccurred: true, surfaceChanged: true },
    action
  };
  // Transport compaction may leave the backend comparison without a useful
  // page diff even though the browser already verified the exact contract.
  const after = observation("browser_stage_after", { ...before.page }, browserResult);
  const transition = evaluateTransition({
    beforeObservation: before,
    governedAction: action,
    browserResult,
    afterObservation: after
  });
  assert.equal(transition.status, "progressed");
  assert.equal(transition.currentObligationResult.completed, true);
  assert.equal(transition.localMechanicalResult.verified, true);

  const advanced = advanceActionLifecycle({
    state: { lastAction: action },
    observation: after,
    previousObservation: before
  });
  assert.notEqual(advanced.observation.lastActionResult.failureCode, "TRANSITION_NO_EFFECT");
  assert.equal(advanced.observation.lastActionResult.verified, true);
});

test("child confirmation verifies the selected free outcome on its parent decision", () => {
  const before = observation("before_flex_confirm", {
    currentSurface: { id: "flex_confirm", type: "popover", label: "Flexible Ticket confirmation" },
    controls: [{
      controlId: "ctrl_decline_confirm",
      decisionGroupId: "dg_flex_confirm",
      surfaceId: "flex_confirm",
      label: "I'll go without",
      semantic: "decline_paid_extra",
      physicalEffect: "dismiss_surface",
      risk: "safe_decline"
    }],
    decisionGroups: [{ decisionGroupId: "dg_flex_confirm", status: "missing", selectedControlId: "" }]
  });
  const after = observation("after_flex_confirm", {
    currentSurface: { id: "flex_options", type: "dropdown", label: "Flexible Ticket options" },
    controls: [{
      controlId: "ctrl_flex_none",
      decisionGroupId: "dg_flexible_ticket",
      surfaceId: "flex_options",
      label: "None of the passengers 0 EUR",
      semantic: "decline_paid_extra",
      physicalEffect: "select_free_option",
      risk: "safe_decline",
      selected: true,
      structuredPrice: { amount: 0, currency: "EUR" }
    }],
    decisionGroups: [{
      decisionGroupId: "dg_flexible_ticket",
      status: "satisfied",
      selectedControlId: "ctrl_flex_none",
      selectedLabel: "None of the passengers 0 EUR",
      selectedSemantic: "decline_paid_extra",
      selectedEvidence: { disposition: "free", structuredPrice: { amount: 0, currency: "EUR" } }
    }]
  }, result("act_flex_confirm"));
  const expectedOutcome = {
    type: "exact_free_option_selected",
    controlId: "ctrl_decline_confirm",
    decisionGroupId: "dg_flex_confirm",
    parentDecisionGroupId: "dg_flexible_ticket",
    parentExpectedSelectedControlId: "ctrl_flex_none",
    childSurfaceId: "flex_confirm",
    requireChildSurfaceDismissed: true,
    mustNotIncreasePrice: true
  };
  const transition = evaluateTransition({
    beforeObservation: before,
    governedAction: {
      id: "act_flex_confirm",
      controlId: "ctrl_decline_confirm",
      decisionGroupId: "dg_flex_confirm",
      mechanicalEffect: "select_free_option",
      expectedOutcome
    },
    browserResult: {
      ...result("act_flex_confirm"),
      verified: true,
      expectedPostconditions: [expectedOutcome]
    },
    afterObservation: after
  });

  assert.equal(transition.postcondition.satisfied, true);
  assert.equal(transition.postcondition.evidence.parentDecisionGroupId, "dg_flexible_ticket");
  assert.equal(transition.postcondition.evidence.childSurfaceDismissed, true);
  assert.equal(transition.postcondition.evidence.completionMode, "child_confirmed_parent_selection");
});

test("paid-conflict correction requires the exact selection charge to disappear", () => {
  const before = observation("charge_before", {
    price: { amount: 229, currency: "EUR" },
    controls: [
      { controlId: "ctrl_paid", decisionGroupId: "dg_bundle", label: "All passengers", semantic: "add_paid_extra", risk: "money", selected: true },
      { controlId: "ctrl_free", decisionGroupId: "dg_bundle", label: "None", semantic: "decline_paid_extra", risk: "safe_decline", selected: false },
      { controlId: "ctrl_meal_none", decisionGroupId: "dg_meal", label: "No meal", semantic: "decline_paid_extra", risk: "safe_decline", selected: true }
    ],
    decisionGroups: [{
      decisionGroupId: "dg_bundle",
      status: "satisfied",
      selectedControlId: "ctrl_paid",
      selectedLabel: "All passengers",
      selectedEvidence: { selected: true, disposition: "paid", structuredPrice: { amount: 29, currency: "EUR" } }
    }, {
      decisionGroupId: "dg_meal",
      status: "satisfied",
      selectedControlId: "ctrl_meal_none",
      selectedEvidence: { selected: true, disposition: "free", structuredPrice: { amount: 0, currency: "EUR" } }
    }]
  });
  const action = {
    id: "act_remove_bundle",
    controlId: "ctrl_free",
    decisionGroupId: "dg_bundle",
    mechanicalEffect: "select_free_option",
    expectedOutcome: {
      type: "exact_free_option_selected",
      controlId: "ctrl_free",
      expectedSelectedControlId: "ctrl_free",
      decisionGroupId: "dg_bundle",
      requireChargeRemoved: true,
      beforeSelectedChargeAmount: 29,
      beforePriceAmount: 229,
      mustNotIncreasePrice: true
    }
  };
  const staleCharge = observation("charge_still_present", {
    price: { amount: 229, currency: "EUR" },
    controls: [
      { controlId: "ctrl_paid", decisionGroupId: "dg_bundle", label: "All passengers", semantic: "add_paid_extra", risk: "money", selected: false },
      { controlId: "ctrl_free", decisionGroupId: "dg_bundle", label: "None", semantic: "decline_paid_extra", risk: "safe_decline", selected: true },
      { controlId: "ctrl_meal_none", decisionGroupId: "dg_meal", label: "No meal", semantic: "decline_paid_extra", risk: "safe_decline", selected: true }
    ],
    decisionGroups: [{
      decisionGroupId: "dg_bundle",
      status: "satisfied",
      selectedControlId: "ctrl_free",
      selectedLabel: "None",
      selectedSemantic: "decline_paid_extra",
      selectedEvidence: { selected: true, disposition: "paid", structuredPrice: { amount: 29, currency: "EUR" } }
    }, {
      decisionGroupId: "dg_meal",
      status: "satisfied",
      selectedControlId: "ctrl_meal_none",
      selectedEvidence: { selected: true, disposition: "free", structuredPrice: { amount: 0, currency: "EUR" } }
    }]
  }, result(action.id));
  const unverified = evaluateTransition({ beforeObservation: before, governedAction: action, browserResult: result(action.id), afterObservation: staleCharge });
  assert.equal(unverified.postcondition.satisfied, false);
  assert.equal(unverified.postcondition.evidence.selectedChargeRemoved, false);

  const corrected = observation("charge_removed", {
    price: { amount: 200, currency: "EUR" },
    controls: [
      { controlId: "ctrl_paid", decisionGroupId: "dg_bundle", label: "All passengers", semantic: "add_paid_extra", risk: "money", selected: false },
      { controlId: "ctrl_free", decisionGroupId: "dg_bundle", label: "None", semantic: "decline_paid_extra", risk: "safe_decline", selected: true },
      { controlId: "ctrl_meal_none", decisionGroupId: "dg_meal", label: "No meal", semantic: "decline_paid_extra", risk: "safe_decline", selected: true }
    ],
    decisionGroups: [{
      decisionGroupId: "dg_bundle",
      status: "satisfied",
      selectedControlId: "ctrl_free",
      selectedLabel: "None",
      selectedSemantic: "decline_paid_extra",
      selectedEvidence: { selected: true, disposition: "free", structuredPrice: { amount: 0, currency: "EUR" } }
    }, {
      decisionGroupId: "dg_meal",
      status: "satisfied",
      selectedControlId: "ctrl_meal_none",
      selectedEvidence: { selected: true, disposition: "free", structuredPrice: { amount: 0, currency: "EUR" } }
    }]
  }, result(action.id));
  const verified = evaluateTransition({ beforeObservation: before, governedAction: action, browserResult: result(action.id), afterObservation: corrected });
  assert.equal(verified.postcondition.satisfied, true);
  assert.equal(verified.postcondition.evidence.selectedChargeRemoved, true);

  const unrelatedChanged = observation("charge_removed_but_meal_changed", {
    price: { amount: 200, currency: "EUR" },
    controls: [
      { controlId: "ctrl_free", decisionGroupId: "dg_bundle", label: "None", semantic: "decline_paid_extra", risk: "safe_decline", selected: true },
      { controlId: "ctrl_meal_other", decisionGroupId: "dg_meal", label: "Different free meal", semantic: "choice", risk: "safe", selected: true }
    ],
    decisionGroups: [{
      decisionGroupId: "dg_bundle",
      status: "satisfied",
      selectedControlId: "ctrl_free",
      selectedLabel: "None",
      selectedSemantic: "decline_paid_extra",
      selectedEvidence: { selected: true, disposition: "free", structuredPrice: { amount: 0, currency: "EUR" } }
    }, {
      decisionGroupId: "dg_meal",
      status: "satisfied",
      selectedControlId: "ctrl_meal_other",
      selectedEvidence: { selected: true, disposition: "free", structuredPrice: { amount: 0, currency: "EUR" } }
    }]
  }, result(action.id));
  const rejectedMutation = evaluateTransition({ beforeObservation: before, governedAction: action, browserResult: result(action.id), afterObservation: unrelatedChanged });
  assert.equal(rejectedMutation.postcondition.satisfied, false);
  assert.deepEqual(rejectedMutation.postcondition.evidence.unrelatedSelectionChanges.map((change) => change.decisionGroupId), ["dg_meal"]);
  assert.equal(rejectedMutation.causality.code, "INTERVENING_EXTERNAL_SELECTION_MUTATION");
});

test("paid-conflict correction trusts fresh cleared selection and charge over stale group metadata", () => {
  const before = observation("paid_before", {
    price: { amount: 410, currency: "EUR" },
    foreground: { progressMarkers: { flightOrdinal: "1/2", selectedText: "5E" } },
    controls: [
      {
        controlId: "ctrl_selected_item",
        decisionGroupId: "dg_paid_item",
        label: "5E",
        semantic: "selected_paid_extra",
        risk: "money",
        selected: true
      },
      {
        controlId: "ctrl_owned_correction",
        decisionGroupId: "dg_surface_command",
        semantic: "unknown",
        risk: "safe",
        selected: false
      }
    ],
    decisionGroups: [{
      decisionGroupId: "dg_paid_item",
      selectedControlId: "ctrl_selected_item",
      selectedEvidence: {
        selected: true,
        selectedControlId: "ctrl_selected_item",
        disposition: "paid",
        structuredPrice: { amount: 40, currency: "EUR" }
      }
    }],
    transactionFacts: {
      selectedExtras: [{
        decisionGroupId: "dg_paid_item",
        disposition: "paid",
        priceAmount: 40,
        currency: "EUR"
      }]
    }
  });
  const after = observation("paid_after", {
    price: { amount: 370, currency: "EUR" },
    foreground: { progressMarkers: { flightOrdinal: "1/2", selectedText: "Not selected" } },
    controls: [{
      controlId: "ctrl_selected_item",
      decisionGroupId: "dg_paid_item",
      label: "5E",
      semantic: "selected_paid_extra",
      risk: "money",
      selected: false
    }],
    // The incremental cache can briefly retain this group snapshot. Fresh
    // control, surface and transaction facts above are authoritative.
    decisionGroups: [{
      decisionGroupId: "dg_paid_item",
      selectedControlId: "ctrl_selected_item",
      selectedEvidence: {
        selected: true,
        selectedControlId: "ctrl_selected_item",
        disposition: "paid",
        structuredPrice: { amount: 40, currency: "EUR" }
      }
    }],
    transactionFacts: { selectedExtras: [] }
  }, result("act_remove_paid"));
  const transition = evaluateTransition({
    beforeObservation: before,
    governedAction: {
      id: "act_remove_paid",
      controlId: "ctrl_owned_correction",
      decisionGroupId: "dg_paid_item",
      mechanicalEffect: "select_free_option",
      expectedOutcome: {
        type: "policy_conflict_resolved",
        decisionGroupId: "dg_paid_item",
        controlId: "ctrl_owned_correction",
        semanticOwnershipLinkId: "ownership_paid_to_correction",
        intendedOutcome: "remove_unapproved_paid_item",
        beforePriceAmount: 410
      }
    },
    browserResult: result("act_remove_paid"),
    afterObservation: after
  });
  assert.equal(transition.postcondition.satisfied, true);
  assert.equal(transition.postcondition.evidence.afterPaidMetadata, true);
  assert.equal(transition.postcondition.evidence.afterPaid, false);
  assert.equal(transition.postcondition.evidence.selectedItemCleared, true);
  assert.equal(transition.postcondition.evidence.chargeCleared, true);
  assert.notEqual(transition.status, "no_effect");
});

test("closed action lifecycle does not claim a later page mutation", () => {
  const action = {
    id: "act_surface_progress",
    controlId: "ctrl_advance",
    decisionGroupId: "dg_surface",
    expectedOutcome: { type: "observable_change", controlId: "ctrl_advance" }
  };
  const before = observation("causal_before", {
    foreground: { progressMarkers: { flightOrdinal: "1/2" } }
  });
  const immediate = observation("causal_immediate", {
    foreground: { progressMarkers: { flightOrdinal: "2/2" } }
  }, result(action.id));
  const first = advanceActionLifecycle({
    state: { lastAction: action },
    previousObservation: before,
    observation: immediate
  });
  assert.equal(first.lifecycle.closed, true);
  assert.ok(first.transition);

  const laterManualChange = observation("causal_later_manual", {
    foreground: { progressMarkers: { flightOrdinal: "2/2", selectedText: "Paid item selected" } },
    price: { amount: 248, currency: "EUR" }
  }, result(action.id));
  const second = advanceActionLifecycle({
    state: first.state,
    previousObservation: immediate,
    observation: laterManualChange
  });
  assert.equal(second.transition, null);
  assert.equal(second.lifecycle, null);
  assert.equal(second.observation.lastActionResult.causalWindowClosed, true);
  assert.equal(second.observation.lastActionResult.causality.code, "ACTION_CAUSAL_WINDOW_CLOSED");
});

test("DecisionFrame paid truth publishes the exact Remove action without a pre-TaskState ownership model", async () => {
  const previousFetch = global.fetch;
  let modelCalls = 0;
  global.fetch = async () => {
    modelCalls += 1;
    return {
      ok: true,
      json: async () => ({
        status: "completed",
        model: "test-model",
        output_text: JSON.stringify({
          decisionGroupId: "dg_selected_item",
          controlId: "ctrl_remove",
          family: "seat",
          confidence: "high",
          rationale: "The paid item belongs to the current seat-selection surface."
        }),
        usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 }
      })
    };
  };
  try {
    const current = observation("obs_loop_ambiguous_paid", {
      step: "seats",
      url: "https://example.test/checkout/seats",
      currentSurface: { id: "surface-page", type: "page", label: "Reserve seating" },
      price: { amount: 226, currency: "EUR" },
      controls: [
        {
          controlId: "ctrl_remove",
          stableKey: "selected-item.remove",
          decisionGroupId: "dg_selected_item",
          sectionType: "unknown",
          sectionLabel: "Selected item",
          surfaceId: "surface-page",
          surfaceType: "page",
          label: "Remove",
          semantic: "remove_paid_extra",
          physicalEffect: "select_free_option",
          risk: "safe_decline",
          kind: "button",
          role: "button",
          stateElementId: "remove-node",
          preferredActivationElementId: "remove-node",
          operations: { activate: actionableCapability("activate", "remove-node") }
        },
        {
          controlId: "ctrl_next",
          stableKey: "checkout.advance",
          surfaceId: "surface-page",
          surfaceType: "page",
          label: "Proceed",
          semantic: "navigation",
          physicalEffect: "advance_checkout_stage",
          risk: "safe_continue",
          kind: "button",
          role: "button",
          stateElementId: "next-node",
          preferredActivationElementId: "next-node",
          operations: { activate: actionableCapability("activate", "next-node") }
        }
      ],
      decisionGroups: [{
        decisionGroupId: "dg_selected_item",
        requirementId: "unknown:selected-item",
        surfaceId: "surface-page",
        surfaceType: "page",
        sectionType: "unknown",
        sectionLabel: "Selected item",
        required: false,
        status: "satisfied",
        selectedControlId: "",
        selectedLabel: "Selected item 26 EUR",
        selectedEvidence: {
          selected: true,
          disposition: "paid",
          structuredPrice: { amount: 26, currency: "EUR" },
          ownerElementId: "selected-item"
        },
        semanticOwnership: {
          status: "unknown",
          nearbySectionType: "passenger",
          nearbySectionLabel: "Traveller information"
        },
        removalControlId: "ctrl_remove",
        alternativeControlIds: ["ctrl_remove"]
      }],
      validationIssues: []
    });
    const traveler = { id: "trav_semantic_owner", booking_rules: "No paid seats" };
    let state = createCheckoutSessionState({
      goal: "Reach payment without paid seats",
      travelerId: traveler.id,
      site: { host: "example.test", url: current.page.url }
    });
    state.id = "txn_semantic_owner";
    state.currentObservation = {
      observationId: current.observationId,
      observationHash: current.observationSnapshot.snapshotHash
    };
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
      apiKey: "test-key",
      model: "test-model",
      dataDir: "",
      state,
      observation: current,
      traveler,
      transactionStore: store,
      clientTurnId: "turn_semantic_owner"
    });

    assert.equal(modelCalls, 0);
    assert.equal(turn.clientDecision.action, "click");
    assert.equal(turn.clientDecision.controlId, "ctrl_remove");
    assert.notEqual(turn.clientDecision.controlId, "ctrl_next");
    assert.equal(turn.state.taskState.currentObligation.subject.decisionGroupId, "dg_selected_item");
    assert.equal(turn.state.taskState.currentObligation.subject.family, "extras");
  } finally {
    global.fetch = previousFetch;
  }
});

test("an unrelated fresh paid selection is an intervening mutation, not progress caused by navigation", () => {
  const before = observation("external_before", {
    step: "extras",
    currentSurface: { id: "surface-page", type: "page", label: "Extras" },
    price: { amount: 200, currency: "EUR" },
    controls: [{ controlId: "ctrl_next", label: "Proceed", semantic: "navigation", surfaceId: "surface-page" }],
    decisionGroups: [{
      decisionGroupId: "dg_bundle",
      sectionType: "bundle",
      status: "satisfied",
      selectedControlId: "ctrl_bundle_free",
      selectedLabel: "None",
      selectedEvidence: { selected: true, disposition: "free", selectedControlId: "ctrl_bundle_free" }
    }]
  });
  const action = {
    id: "act_pending_navigation",
    type: "click",
    intent: "navigate_stage",
    semanticIntent: "continue_checkout",
    mechanicalEffect: "advance_surface",
    controlId: "ctrl_next",
    targetSnapshot: { controlId: "ctrl_next", decisionGroupId: "", surfaceId: "surface-page" },
    expectedOutcome: { type: "current_surface_advanced", mustNotIncreasePrice: true },
    risk: "safe"
  };
  const after = observation("external_after", {
    step: "extras",
    currentSurface: { id: "surface-page", type: "page", label: "Extras" },
    price: { amount: 229, currency: "EUR" },
    controls: [{ controlId: "ctrl_next", label: "Proceed", semantic: "navigation", surfaceId: "surface-page" }],
    decisionGroups: [{
      decisionGroupId: "dg_bundle",
      sectionType: "bundle",
      status: "satisfied",
      selectedControlId: "ctrl_bundle_paid",
      selectedLabel: "All passengers",
      selectedEvidence: {
        selected: true,
        disposition: "paid",
        selectedControlId: "ctrl_bundle_paid",
        structuredPrice: { amount: 29, currency: "EUR" }
      }
    }]
  }, result(action.id));

  const transition = evaluateTransition({
    beforeObservation: before,
    governedAction: action,
    browserResult: result(action.id),
    afterObservation: after
  });
  assert.equal(transition.status, "blocked");
  assert.equal(transition.causality.classification, "intervening_external_mutation");
  assert.deepEqual(transition.causality.decisionGroupIds, ["dg_bundle"]);
  assert.equal(transition.nextDirective, "rebuild_task_state");

  const state = createCheckoutSessionState({ goal: "Reach payment without paid extras", travelerId: "trav_external" });
  state.lastAction = action;
  state.pendingAction = pendingActionRecord({ action, goal: { goalId: "goal_continue" }, status: "ready" });
  const lifecycle = advanceActionLifecycle({ state, observation: after, previousObservation: before });
  assert.equal(lifecycle.lifecycle.status, "observed");
  assert.equal(lifecycle.directive, "rebuild_candidates");
  assert.equal(lifecycle.lifecycle.resultCode, "INTERVENING_EXTERNAL_MUTATION");
});

test("a newly exposed destination decision cannot make verified navigation simultaneously fail", () => {
  const before = observation("traveler_before_seats", {
    step: "traveler_information",
    currentSurface: { id: "surface-page", type: "page", label: "Traveler information" },
    controls: [{ controlId: "ctrl_continue", label: "Continue", semantic: "continue", surfaceId: "surface-page" }],
    decisionGroups: [],
    price: { amount: 208, currency: "EUR" }
  });
  const action = {
    id: "act_continue_to_seats",
    type: "click",
    intent: "navigate_stage",
    semanticIntent: "advance_checkout_stage",
    mechanicalEffect: "advance_checkout_stage",
    controlId: "ctrl_continue",
    targetSnapshot: { controlId: "ctrl_continue", surfaceId: "surface-page" },
    expectedOutcome: { type: "checkout_stage_advanced", controlId: "ctrl_continue", mustNotIncreasePrice: true },
    risk: "safe"
  };
  const browserResult = {
    actionId: action.id,
    action,
    expectedOutcome: action.expectedOutcome,
    dispatched: true,
    executed: true,
    verified: true,
    expectedOutcomeObserved: true,
    postconditionSatisfied: true,
    outcome: { ok: true, code: "CHECKOUT_STAGE_ADVANCED" },
    feedback: { dispatched: true, navigationOccurred: true, surfaceChanged: true, outcomeVerified: true }
  };
  const after = observation("seat_destination", {
    step: "seats",
    currentSurface: { id: "seat_panel", type: "popover", blocksBackground: true, label: "Reserve seating" },
    controls: [{ controlId: "ctrl_next", label: "Next", semantic: "continue", surfaceId: "seat_panel" }],
    decisionGroups: [{
      decisionGroupId: "dg_new_seat_mode",
      sectionType: "seat",
      status: "conflicted",
      selectedControlId: "ctrl_seat_paid_shell",
      selectedLabel: "Add to cart",
      selectedEvidence: {
        selected: true,
        disposition: "paid",
        selectedControlId: "ctrl_seat_paid_shell"
      }
    }],
    price: { amount: 208, currency: "EUR" }
  }, browserResult);

  const transition = evaluateTransition({
    beforeObservation: before,
    governedAction: action,
    browserResult,
    afterObservation: after,
    navigationContext: { destinationReady: true }
  });
  assert.equal(transition.causality, null);
  assert.equal(transition.status, "achieved");

  const state = createCheckoutSessionState({ goal: "Reach payment without paid extras", travelerId: "trav_destination" });
  state.lastAction = action;
  state.pendingAction = pendingActionRecord({ action, goal: { goalId: "goal_continue" }, status: "ready" });
  const lifecycle = advanceActionLifecycle({
    state,
    observation: after,
    previousObservation: before,
    observationReadiness: { classification: "READY" }
  });
  assert.equal(lifecycle.lifecycle.status, "verified");
  assert.equal(lifecycle.lifecycle.verified, true);
  assert.equal(lifecycle.lifecycle.transitionStatus, "achieved");
  assert.notEqual(lifecycle.lifecycle.resultCode, "INTERVENING_EXTERNAL_MUTATION");
});

test("DOB transition requires the exact canonical date and no owned validation error", () => {
  const before = observation("dob_before", {
    step: "traveler_information",
    currentSurface: { id: "page", type: "page", label: "Traveler" },
    controls: [{ controlId: "ctrl_dob", semantic: "date_of_birth", state: { canonicalDateValue: "" } }]
  });
  const action = {
    id: "act_dob",
    controlId: "ctrl_dob",
    operation: "type",
    expectedOutcome: {
      type: "date_value_committed",
      controlId: "ctrl_dob",
      expectedCanonicalValue: "2003-05-31",
      expectedNormalizedValue: "2003-05-31",
      dateCodec: { ok: true, kind: "full", format: "dmy", separator: "-" }
    }
  };
  const exact = observation("dob_exact", {
    step: "traveler_information",
    currentSurface: { id: "page", type: "page", label: "Traveler" },
    controls: [{ controlId: "ctrl_dob", semantic: "date_of_birth", state: { canonicalDateValue: "2003-05-31", normalizedValue: "2003-05-31" } }]
  }, result("act_dob"));
  const achieved = evaluateTransition({ beforeObservation: before, governedAction: action, browserResult: result("act_dob"), afterObservation: exact });
  assert.equal(achieved.status, "progressed");

  const invalid = observation("dob_invalid", {
    step: "traveler_information",
    currentSurface: { id: "page", type: "page", label: "Traveler" },
    controls: [{ controlId: "ctrl_dob", semantic: "date_of_birth", state: { canonicalDateValue: "2003-05-31", normalizedValue: "2003-05-31" } }],
    validationIssues: [{ issueId: "dob_error", controlId: "ctrl_dob", message: "Invalid date" }]
  }, result("act_dob"));
  const blocked = evaluateTransition({ beforeObservation: before, governedAction: action, browserResult: result("act_dob"), afterObservation: invalid });
  assert.equal(blocked.status, "progressed");
  assert.equal(blocked.postcondition.satisfied, false);
});

test("authoritative transition treats popup and reversible price changes as fresh state while preserving irreversible safety", () => {
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
  assert.equal(blocked.status, "progressed");
  assert.equal(blocked.nextDirective, "rebuild_from_fresh_observation");
  assert.equal(blocked.blocker, null);

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
  const recoverablePrice = evaluateTransition({
    beforeObservation: before,
    governedAction: { ...action, expectedOutcome: { type: "observable_change", mustNotIncreasePrice: true } },
    browserResult: result(),
    afterObservation: unsafeAfter
  });
  assert.equal(recoverablePrice.status, "blocked");
  assert.equal(recoverablePrice.nextDirective, "rebuild_task_state");
  assert.equal(recoverablePrice.causality.classification, "unexpected_reversible_change");
  const recoverableLifecycle = advanceActionLifecycle({
    state: { lastAction: { ...action, expectedOutcome: { type: "observable_change", mustNotIncreasePrice: true } } },
    observation: unsafeAfter,
    previousObservation: before
  });
  assert.equal(recoverableLifecycle.lifecycle.status, "observed");
  assert.equal(recoverableLifecycle.directive, "rebuild_candidates");
  assert.equal(recoverableLifecycle.lifecycle.resultCode, "UNEXPECTED_PRICE_INCREASE");

  const unsafe = evaluateTransition({
    beforeObservation: before,
    governedAction: {
      ...action,
      mechanicalEffect: "select_paid_option",
      requiresApproval: true,
      expectedOutcome: { type: "observable_change", mustNotIncreasePrice: true }
    },
    browserResult: result(),
    afterObservation: unsafeAfter
  });
  assert.equal(unsafe.status, "unsafe");
  assert.equal(unsafe.nextDirective, "stop_or_request_approval");
});

test("a foreground site-failure modal cannot satisfy checkout-stage advancement", () => {
  const before = observation("site_failure_before", {
    step: "traveler_information",
    url: "https://example.test/traveler",
    currentSurface: { id: "surface-page", type: "page", surfaceClass: "unknown", label: "Traveler information" },
    controls: [{ controlId: "ctrl_continue", label: "Continue" }]
  });
  const after = observation("site_failure_after", {
    step: "traveler_information",
    url: "https://example.test/traveler",
    currentSurface: {
      id: "site_failure_modal",
      type: "modal",
      surfaceClass: "site_failure",
      label: "We are currently unable to process your request. Please try again later."
    },
    controls: [{ controlId: "ctrl_close", label: "Close", surfaceId: "site_failure_modal" }]
  }, result("act_continue"));
  const transition = evaluateTransition({
    beforeObservation: before,
    governedAction: {
      id: "act_continue",
      type: "click",
      intent: "navigate_stage",
      controlId: "ctrl_continue",
      expectedOutcome: { type: "checkout_stage_advanced" }
    },
    browserResult: result("act_continue"),
    afterObservation: after,
    navigationContext: {
      destinationReady: true,
      origin: {
        stage: "traveler_information",
        url: "https://example.test/traveler",
        surfaceId: "surface-page",
        progressFingerprint: "{}"
      }
    }
  });

  assert.equal(transition.postcondition.satisfied, false);
  assert.equal(transition.currentObligationResult.completed, false);
  assert.equal(transition.status, "progressed");
  assert.equal(transition.nextDirective, "rebuild_from_fresh_observation");
});

test("the same modal instance verifies progress when its foreground marker advances", () => {
  const before = observation("same_modal_before", {
    currentSurface: { id: "flow_modal", type: "modal", label: "Configuration" },
    foreground: { progressMarkers: { flightOrdinal: "Flight 1 of 3" } },
    controls: [{ controlId: "ctrl_advance", surfaceId: "flow_modal", label: "Proceed" }]
  });
  const action = {
    id: "act_advance_same_modal",
    type: "click",
    controlId: "ctrl_advance",
    mechanicalEffect: "dismiss_surface",
    expectedOutcome: { type: "active_surface_dismissed", surfaceId: "flow_modal" }
  };
  const after = observation("same_modal_after", {
    currentSurface: { id: "flow_modal", type: "modal", label: "Configuration" },
    foreground: { progressMarkers: { flightOrdinal: "Flight 2 of 3" } },
    controls: [{ controlId: "ctrl_advance", surfaceId: "flow_modal", label: "Proceed" }]
  }, result(action.id));
  const transition = evaluateTransition({
    beforeObservation: before,
    governedAction: action,
    browserResult: result(action.id),
    afterObservation: after
  });
  assert.equal(transition.postcondition.satisfied, true);
  assert.equal(transition.postcondition.evidence.advancedInPlace, true);
  assert.equal(transition.status, "progressed");
  assert.notEqual(transition.status, "no_effect");
});

test("a pre-dispatch price alarm rebuilds from current state instead of stopping before reconciliation", () => {
  const before = observation("price_alarm_before");
  const state = {
    lastAction: {
      id: "act_safe_surface_change",
      type: "click",
      controlId: "ctrl_surface_action",
      mechanicalEffect: "advance_surface",
      expectedOutcome: { type: "current_surface_advanced", mustNotIncreasePrice: true }
    }
  };
  const current = observation("price_alarm_current", {}, {
    actionId: "act_safe_surface_change",
    dispatched: false,
    executed: false,
    failureCode: "PRICE_INCREASE_REQUIRES_AUTHORIZATION"
  });
  const lifecycle = advanceActionLifecycle({ state, observation: current, previousObservation: before });
  assert.equal(lifecycle.lifecycle.status, "rejected_before_dispatch");
  assert.equal(lifecycle.directive, "rebuild_candidates");
  assert.notEqual(lifecycle.directive, "stop_for_safety");
});

test("a fresh page mutation cancels a stale pending prediction but an unchanged snapshot keeps waiting", () => {
  const pending = pendingActionRecord({
    action: {
      id: "act_pending_surface",
      observationId: "obs_source",
      observationHash: "hash_source",
      type: "click",
      mechanicalEffect: "advance_surface"
    },
    goal: { goalId: "goal_surface" },
    status: "ready"
  });
  assert.equal(loopPrivate.pendingActionSupersededByFreshPage(pending, {
    observationId: "obs_same_facts",
    observationSnapshot: { snapshotHash: "hash_source" },
    page: {}
  }), false);
  assert.equal(loopPrivate.pendingActionSupersededByFreshPage(pending, {
    observationId: "obs_user_changed_page",
    observationSnapshot: { snapshotHash: "hash_current" },
    page: {}
  }), true);
  assert.equal(loopPrivate.pendingActionSupersededByFreshPage(pending, {
    observationId: "obs_result_received",
    observationSnapshot: { snapshotHash: "hash_current" },
    page: {},
    lastActionResult: { actionId: "act_pending_surface" }
  }), false);
});

test("typed diff reports validation clearing from fresh browser evidence", () => {
  const before = observation("before", { validationIssues: [{ issueId: "err_email", controlId: "ctrl_email", message: "Email required" }] });
  const after = observation("after", { validationIssues: [] }, result());
  const diff = diffObservations(before, after);
  assert.equal(diff.errorsAppeared.length, 0);
  assert.equal(diff.errorsCleared[0].controlId, "ctrl_email");
  assert.equal(diff.targetReacted, true);
});

test("loop recovery excludes an identical no-effect strategy after its first dispatch", () => {
  const before = observation("before", {
    controls: [{ controlId: "ctrl_flex", label: "Flexible ticket", state: { expanded: false } }]
  });
  const browserResult = result("act_open");
  const after = observation("after", before.page, browserResult);
  const state = {
    currentGoal: { goalId: "goal_flex", semanticType: "flexible_ticket" },
    taskState: {
      currentObligation: currentObligationFromGoal({ goal: { goalId: "goal_flex", semanticType: "flexible_ticket" } })
    },
    lastAction: {
      id: "act_open",
      type: "click",
      controlId: "ctrl_flex",
      operation: "open",
      expectedOutcome: { type: "options_surface_appeared", controlId: "ctrl_flex" }
    },
    recoveryState: { attempts: 0, phase: "idle", failedStrategies: [], failedStrategySignatures: [] },
    aiDecisionCache: { candidateSelection: { candidateId: "cached" } }
  };
  const applied = loopPrivate.applyTransitionStatus(state, after, before);
  assert.equal(applied.transition.status, "no_effect");
  assert.equal(applied.observation.lastActionResult.verified, false);
  assert.equal(applied.observation.lastActionResult.failureCode, "TRANSITION_NO_EFFECT");
  assert.deepEqual(applied.state.recoveryState.failedStrategySignatures, ["click:open:ctrl_flex:,"]);
  assert.equal(applied.state.recoveryState.failedStrategies[0].failureCount, 1);
  assert.equal(applied.directive, "try_distinct_capability");
  assert.equal(applied.state.recoveryState.attempts, 1);
  assert.equal(applied.state.recoveryState.phase, "execution_no_effect");
  assert.equal(applied.state.aiDecisionCache, null);

  assert.deepEqual(
    loopPrivate.failedStrategySignaturesForGoal(applied.state, taskBindingGoal(state.taskState), after),
    ["click:open:ctrl_flex:,"]
  );
  const changedPage = {
    ...after,
    observationId: "after_changed",
    observationSnapshot: { snapshotHash: "hash_after_changed" }
  };
  assert.deepEqual(
    loopPrivate.failedStrategySignaturesForGoal(applied.state, taskBindingGoal(state.taskState), changedPage),
    ["click:open:ctrl_flex:,"]
  );
  const changedTarget = observation("after_target_changed", {
    ...before.page,
    controls: [{ controlId: "ctrl_flex", label: "Flexible ticket", state: { expanded: true } }]
  });
  assert.deepEqual(
    loopPrivate.failedStrategySignaturesForGoal(applied.state, taskBindingGoal(state.taskState), changedTarget),
    []
  );
});

test("FAILED_STRATEGY_REUSE becomes authoritative scheduler exclusion on unchanged target state", () => {
  const before = observation("reuse_before", {
    controls: [{ controlId: "ctrl_title", label: "Title", state: { expanded: false, disabled: true } }]
  });
  const action = {
    id: "act_title_native",
    type: "click",
    controlId: "ctrl_title",
    operation: "open",
    interactionMethod: "native_click",
    expectedOutcome: { type: "options_surface_appeared", controlId: "ctrl_title" }
  };
  const rejected = {
    actionId: action.id,
    dispatched: false,
    executed: false,
    verified: false,
    failureCode: "FAILED_STRATEGY_REUSE",
    outcome: { code: "FAILED_STRATEGY_REUSE" },
    action
  };
  const after = observation("reuse_after", before.page, rejected);
  const state = {
    currentGoal: { goalId: "goal_title", semanticType: "title" },
    taskState: {
      currentObligation: currentObligationFromGoal({ goal: { goalId: "goal_title", semanticType: "title" } })
    },
    lastAction: action,
    recoveryState: { attempts: 0, phase: "idle", failedStrategies: [], failedStrategySignatures: [] },
    aiDecisionCache: { candidateSelection: { candidateId: "stale_reused_candidate" } }
  };

  const applied = loopPrivate.applyTransitionStatus(state, after, before);
  const signature = "native_click:open:ctrl_title:,";
  assert.equal(applied.transition, null);
  assert.equal(applied.directive, "rebuild_candidates");
  assert.deepEqual(applied.state.recoveryState.failedStrategySignatures, [signature]);
  assert.equal(applied.state.recoveryState.failedStrategies[0].strategySignature, signature);
  assert.equal(applied.state.recoveryState.failedStrategies[0].failureCount, 1);
  assert.equal(applied.state.aiDecisionCache, null);
  assert.deepEqual(
    loopPrivate.failedStrategySignaturesForGoal(applied.state, taskBindingGoal(state.taskState), after),
    [signature]
  );

  const unrelatedProgress = observation("reuse_unrelated_progress", {
    ...before.page,
    controls: [
      ...before.page.controls,
      { controlId: "ctrl_dob_day", state: { normalizedValue: "31" } }
    ]
  });
  assert.deepEqual(
    loopPrivate.failedStrategySignaturesForGoal(applied.state, taskBindingGoal(state.taskState), unrelatedProgress),
    [signature]
  );
});

test("a retry is distinct only when its target, operation, or dispatch method changes", () => {
  const base = {
    type: "type",
    operation: "type",
    controlId: "ctrl_profile",
    targetId: "el_profile",
    value: "Ali"
  };
  const signature = loopPrivate.candidateStrategySignature({}, base);
  assert.equal(
    loopPrivate.candidateStrategySignature({}, { ...base, value: "Different value" }),
    signature
  );
  assert.notEqual(
    loopPrivate.candidateStrategySignature({}, { ...base, targetId: "el_profile_alternate" }),
    signature
  );
  assert.notEqual(
    loopPrivate.candidateStrategySignature({}, { ...base, operation: "choose" }),
    signature
  );
  assert.notEqual(
    loopPrivate.candidateStrategySignature({}, { ...base, type: "keypress" }),
    signature
  );
});

test("a browser acknowledgement on the same material observation is no effect", () => {
  const before = observation("same_material_before", {
    controls: [{ controlId: "ctrl_origin", label: "Origin", state: { expanded: false } }]
  });
  before.observationSnapshot.snapshotHash = "material_origin_closed";
  const after = observation("same_material_after_new_id", before.page, {
    ...result("act_origin_arrow"),
    outcome: { code: "OBSERVABLE_CHANGE" }
  });
  after.observationSnapshot.snapshotHash = "material_origin_closed";
  const transition = evaluateTransition({
    beforeObservation: before,
    governedAction: {
      id: "act_origin_arrow",
      type: "keypress",
      operation: "open",
      controlId: "ctrl_origin",
      keys: ["ArrowDown"],
      expectedOutcome: { type: "options_surface_appeared", controlId: "ctrl_origin" }
    },
    browserResult: after.lastActionResult,
    afterObservation: after
  });
  assert.equal(transition.postcondition.satisfied, false);
  assert.equal(transition.status, "no_effect");
  assert.equal(transition.nextDirective, "try_distinct_capability");
});

test("every failed strategy is excluded on the same unchanged page state", () => {
  const observationForSurface = observation("retry_surface", {
    currentSurface: { id: "origin_picker", type: "modal", label: "Choose origin" },
    foreground: { progressMarkers: { step: "origin" } }
  });
  const goal = {
    goalId: "goal_origin",
    semanticType: "origin",
    semanticGoal: "choose origin"
  };
  const goalKey = loopPrivate.semanticGoalRecoveryKey(goal, observationForSurface);
  const state = {
    recoveryState: { failedStrategies: [{
      goalKey,
      strategySignature: "keypress:open:origin::ArrowDown",
      pageStateHash: observationForSurface.observationSnapshot.snapshotHash,
      failureCount: 1
    }, {
      goalKey,
      strategySignature: "click:open:origin_button::",
      pageStateHash: observationForSurface.observationSnapshot.snapshotHash,
      failureCount: 1
    }], failedStrategySignatures: [] }
  };
  assert.deepEqual(
    loopPrivate.failedStrategySignaturesForGoal(state, goal, observationForSurface),
    ["keypress:open:origin::ArrowDown", "click:open:origin_button::"]
  );
});

test("a persisted payment terminal latch suppresses planning on a later unrelated page", async () => {
  const state = createCheckoutSessionState({
    goal: "Reach payment review",
    travelerId: "trav_terminal_latch",
    site: { host: "example.test", url: "https://example.test/rf/payment" }
  });
  state.status = "ready_for_payment";
  state.terminalGoalLatch = {
    locked: true,
    goalId: "reach_payment_review",
    terminalStatus: "payment_review_reached",
    completedObservationId: "obs_payment_complete",
    completionEvidence: "fresh_payment_evidence"
  };
  state.taskState = {
    terminalStatus: "payment_review_reached",
    terminalGoalLatch: state.terminalGoalLatch,
    goal: { id: "reach_payment_review", status: "completed" }
  };
  const redirected = observation("obs_after_terminal_redirect", {
    step: "extras",
    url: "https://example.test/rf/start",
    text: "Choose your bundle and start a new flight search",
    controls: [{ controlId: "ctrl_new_search", label: "Search flights" }]
  });
  const result = await runLoopTurn({
    apiKey: "",
    model: "unused",
    dataDir: "",
    state,
    observation: redirected,
    traveler: {},
    actionHistory: []
  });
  assert.equal(result.clientDecision.action, "final_review");
  assert.equal(result.clientDecision.intent, "payment_review_reached");
  assert.equal(result.state.status, "ready_for_payment");
  assert.equal(result.state.terminalGoalLatch.locked, true);
  assert.equal(result.debug.terminalGoalLatched, true);
  assert.equal(result.debug.candidateGenerationSuppressed, true);
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
    assert.equal(advanced.directive, "try_distinct_capability");
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
  assert.equal(reset.transition.status, "progressed");
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

  assert.equal(advanced.transition.status, "progressed");
  assert.equal(advanced.lifecycle.status, "observed");
  assert.equal(advanced.lifecycle.observed, true);
  assert.equal(advanced.lifecycle.verified, false);
  assert.equal(advanced.directive, "rebuild_candidates");
});

test("typed seat choices keep safe navigation selectable even when compatibility is context-only", () => {
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
      physicalEffect: "select_free_option",
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
      required: false,
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
  const taskStateContext = {
    state: {
      taskState: {
        activeDecisions: [{ decisionGroupId: "dg_seat", family: "seat", status: "active", required: false }],
        validationBlockers: []
      },
      requirements: [],
      priceHistory: []
    }
  };
  const firstSet = loopPrivate.groundedObservationCandidateSet(goal, before, [], taskStateContext);
  const skip = firstSet.candidates.find((candidate) => candidate.controlId === "ctrl_skip");
  const next = firstSet.candidates.find((candidate) => candidate.controlId === "ctrl_next");

  assert.equal(skip.physicalEffect, "select_free_option");
  assert.equal(skip.expectedOutcome.type, "exact_free_option_selected");
  assert.equal(next.controlId, "ctrl_next");
  assert.equal(firstSet.contextCapabilities.find((candidate) => candidate.controlId === "ctrl_next").outcomeCompatibility, "obligation_admitted");

  const dispatchedSkip = { ...skip, id: "act_skip" };
  const unchanged = observation("typed_unchanged", before.page, result(dispatchedSkip.id));
  const applied = loopPrivate.applyTransitionStatus({
    currentGoal: goal,
    lastAction: dispatchedSkip,
    recoveryState: { attempts: 0, phase: "idle", failedStrategies: [], failedStrategySignatures: [] }
  }, unchanged, before);
  assert.equal(applied.transition.status, "no_effect");
  assert.equal(applied.directive, "try_distinct_capability");

  const retrySet = loopPrivate.groundedObservationCandidateSet(
    goal,
    unchanged,
    applied.state.recoveryState.failedStrategySignatures,
    taskStateContext
  );
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

  const completions = legacyRequirementReplay.exactDecisionCompletionRecords([], reconciled, current.observationId);
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
      status: "satisfied",
      selectedControlId: skip.controlId,
      selectedLabel: skip.label,
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
  state.requirements = legacyRequirementReplay.requirementsWithDecisionGroups([], current);
  state.activeRequirements = state.requirements;
  state.currentObservation = { observationId: current.observationId, observationHash: current.observationSnapshot.snapshotHash };
  state.taskState = {
    stage: "seats",
    activeDecisions: [],
    validationBlockers: [],
    completedOutcomes: [{ decisionGroupId: groupId, surfaceId, status: "satisfied", selectedControlId: skip.controlId }]
  };

  const goal = require("../../apps/web/agent/observation-candidates").deriveObservationGoal(current, state.requirements);
  const firstSet = loopPrivate.groundedObservationCandidateSet(goal, current, [], { state, traveler, approvals: state.approvals });
  assert.deepEqual(firstSet.candidates.map((candidate) => candidate.targetLabel), ["Next"]);
  state.currentGoal = goal;
  state.recoveryState = { ...state.recoveryState, failedStrategies: [], failedStrategySignatures: [] };

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
  state.requirements = legacyRequirementReplay.requirementsWithDecisionGroups([], current);
  state.activeRequirements = state.requirements;
  state.currentObligation = {
    userOutcome: {
      semanticFamily: "seat",
      desiredDisposition: "decline_paid",
      status: "satisfied",
      decisionGroupId: groupId
    }
  };
  state.taskState = {
    stage: "seats",
    activeDecisions: [],
    validationBlockers: [],
    completedOutcomes: [{
      decisionGroupId: groupId,
      requirementId: "seat_decision",
      surfaceId,
      status: "satisfied"
    }]
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
  assert.deepEqual(candidateSet.candidates.map((candidate) => candidate.targetLabel), ["Next"], JSON.stringify(candidateSet.contextCapabilities.map((candidate) => ({
    label: candidate.targetLabel,
    effect: candidate.mechanicalEffect,
    intent: candidate.semanticIntent,
    compatibility: candidate.outcomeCompatibility,
    reason: candidate.outcomeCompatibilityReason,
    exclusion: candidate.exclusionReason,
    relevant: candidate.goalRelevant,
    policy: candidate.policyDecision
  })), null, 2));

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
  assert.equal(turn.state.currentObligation, undefined);
  assert.equal(turn.state.taskState.currentObligation.subject.semanticType, "navigation");
  assert.equal(turn.debug.deterministic, true);
  assert.deepEqual(turn.debug.modelUsage.calls, []);
});

test("planner candidate schema is a closed enum over the current observation", () => {
  const schema = candidateSelectionSchemaFor(["obs_1:candidate_1", "obs_1:candidate_2"]);
  assert.deepEqual(schema.properties.candidateId.enum, ["obs_1:candidate_1", "obs_1:candidate_2"]);
  assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort());
  assert.deepEqual(schema.properties.semanticOutcome.enum, [
    "satisfy_current_decision",
    "advance_current_surface",
    "dismiss_current_surface",
    "request_user_input",
    "stop_for_payment_review"
  ]);
  assert.deepEqual(schema.properties.confidence.enum, ["high", "medium", "low"]);
  assert.equal(schema.additionalProperties, false);
});

test("an AI candidate decision is reused only for the unchanged grounded safe contract", () => {
  const current = observation("obs_cached_ai", {});
  const goal = {
    goalId: "goal_conflict_dg_paid",
    decisionGroupId: "dg_paid",
    semanticType: "decision"
  };
  const candidate = {
    candidateId: "obs_cached_ai:candidate_2",
    controlId: "ctrl_owned_correction",
    stableKey: "paid-extra.owned-correction",
    intendedOutcome: "remove_paid_selection",
    semanticIntent: "remove_unrequested_paid_selection",
    risk: "safe",
    requiresApproval: false,
    policyDecision: { allow: true, decision: "allow" }
  };
  const policyFingerprint = loopPrivate.aiDecisionPolicyFingerprint(
    { skipPaidExtrasApproved: true },
    { booking_rules: "decline paid extras" }
  );
  const cacheEntry = loopPrivate.candidateSelectionCacheEntry({
    observation: current,
    goal,
    candidate,
    selection: {
      semanticOutcome: "satisfy_current_decision",
      confidence: "high"
    },
    policyFingerprint
  });
  const cache = { candidateSelection: cacheEntry };
  const reused = loopPrivate.reusableCandidateSelection(
    cache,
    current,
    goal,
    { candidates: [candidate] },
    policyFingerprint
  );

  assert.equal(reused.candidateId, candidate.candidateId);
  assert.equal(reused.candidate.controlId, candidate.controlId);
  assert.equal(reused.confidence, "high");
  assert.equal(reused.reused, true);
  const reboundCandidate = {
    ...candidate,
    candidateId: "obs_cached_ai_2:candidate_1",
    controlId: "ctrl_owned_correction_rerendered"
  };
  const reusedAfterReobservation = loopPrivate.reusableCandidateSelection(
    cache,
    { ...current, observationId: "obs_cached_ai_2" },
    goal,
    { candidates: [reboundCandidate] },
    policyFingerprint
  );
  assert.equal(reusedAfterReobservation.candidateId, reboundCandidate.candidateId);
  assert.equal(reusedAfterReobservation.candidate.controlId, reboundCandidate.controlId);
  assert.equal(loopPrivate.reusableCandidateSelection(
    cache,
    { ...current, observationSnapshot: { snapshotHash: "changed_hash" } },
    goal,
    { candidates: [candidate] },
    policyFingerprint
  ), null);
  assert.equal(loopPrivate.reusableCandidateSelection(
    cache,
    current,
    { ...goal, decisionGroupId: "dg_other" },
    { candidates: [candidate] },
    policyFingerprint
  ), null);
  assert.equal(loopPrivate.reusableCandidateSelection(
    cache,
    current,
    goal,
    { candidates: [{ ...candidate, policyDecision: { allow: false }, risk: "money" }] },
    policyFingerprint
  ), null);
});

test("one stale observation mismatch rebinds the same safe stable control without AI", () => {
  const goal = { goalId: "goal_paid_conflict", decisionGroupId: "dg_paid" };
  const oldCandidate = {
    candidateId: "old:candidate_1",
    controlId: "ctrl_old_remove",
    stableKey: "optional-extra.safe-reversal",
    operation: "activate",
    intendedOutcome: "remove_paid_selection",
    risk: "safe",
    requiresApproval: false,
    policyDecision: { allow: true }
  };
  const recovery = loopPrivate.staleActionRecoveryEntry(
    { goalId: goal.goalId, controlId: oldCandidate.controlId, operation: "activate" },
    oldCandidate,
    goal,
    "policy_same",
    "OBSERVATION_HASH_MISMATCH"
  );
  const rebound = {
    ...oldCandidate,
    candidateId: "fresh:candidate_2",
    controlId: "ctrl_fresh_remove"
  };
  assert.equal(
    loopPrivate.reusableStaleActionCandidate(recovery, goal, { candidates: [rebound] }, "policy_same"),
    rebound
  );
  assert.equal(
    loopPrivate.reusableStaleActionCandidate(recovery, goal, { candidates: [rebound] }, "policy_changed"),
    null
  );
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
    controls: ["a", "b"].map((suffix, index) => ({
      controlId: `ctrl_free_${suffix}`,
      stableKey: `seat.free.${suffix}`,
      decisionGroupId: "dg_seat",
      sectionId: "section_seat",
      sectionType: "seats",
      surfaceId: "seat_modal",
      surfaceType: "modal",
      label: index === 0 ? "Random seat assignment" : "Skip seat selection",
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
        { controlId: "ctrl_free_a", label: "Random seat assignment", risk: "safe_decline" },
        { controlId: "ctrl_free_b", label: "Skip seat selection", risk: "safe_decline" }
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
  state.requirements = legacyRequirementReplay.requirementsWithDecisionGroups([], current);
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
  const requirements = legacyRequirementReplay.requirementsWithDecisionGroups([], current);
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

test("generic command acknowledgement cannot complete a decision or parent outcome", () => {
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

  assert.equal(transition.status, "progressed");
  assert.equal(transition.postcondition.satisfied, false);
  assert.equal(transition.taskOutcomeCompleted, false);
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
