const test = require("node:test");
const assert = require("node:assert/strict");

const { reduceTaskState } = require("../../apps/web/agent/task-state-reducer");
const { buildCurrentCandidateSet } = require("../../apps/web/agent/current-candidate-builder");

function capability(operation, actuatorId) {
  const actionability = {
    rendered: true,
    visible: true,
    enabled: true,
    inViewport: true,
    inCurrentSurface: true,
    hitTested: true,
    notOccluded: true,
    operationAuthorized: true,
    executable: true,
    revealable: false,
    code: "ACTIONABLE",
    operation
  };
  return { operation, actuatorId, actuatorIds: [actuatorId], actionability };
}

function control(controlId, options = {}) {
  return {
    controlId,
    surfaceId: options.surfaceId || "surface-page",
    surfaceType: options.surfaceType || "page",
    decisionGroupId: options.decisionGroupId || "",
    label: options.label || controlId,
    semantic: options.semantic || "choice",
    meaning: options.meaning || options.semantic || "choice",
    risk: options.risk || "safe",
    structuredPrice: options.structuredPrice || null,
    kind: "button",
    role: "button",
    stateElementId: `${controlId}_node`,
    preferredActivationElementId: `${controlId}_node`,
    operations: { activate: capability("activate", `${controlId}_node`) }
  };
}

test("authoritative reducer suspends background decisions while a foreground surface owns navigation", () => {
  const observation = {
    observationId: "obs_modal",
    page: {
      url: "https://example.test/checkout",
      currentSurface: { id: "seat_modal", type: "modal", label: "Seat choices", memberControlIds: ["next_leg"] },
      controls: [control("next_leg", { surfaceId: "seat_modal", surfaceType: "modal", label: "Next", semantic: "navigation" })],
      decisionGroups: [{
        decisionGroupId: "extras_background",
        surfaceId: "surface-page",
        sectionType: "insurance",
        required: true,
        status: "missing"
      }],
      validationIssues: []
    }
  };
  const state = reduceTaskState({ observation });

  assert.equal(state.foregroundSurface.id, "seat_modal");
  assert.equal(state.activeDecisions.length, 0);
  assert.equal(state.suspendedDecisions[0].decisionGroupId, "extras_background");
  assert.equal(state.currentGoal.semanticType, "navigation");
  assert.deepEqual(state.currentGoal.actionableControlIds, ["next_leg"]);
});

test("untouched optional decisions do not block safe progression", () => {
  const observation = {
    observationId: "obs_optional_newsletter",
    page: {
      url: "https://example.test/checkout/traveler",
      currentSurface: { id: "surface-page", type: "page" },
      controls: [
        control("newsletter_opt_out", {
          decisionGroupId: "contact_newsletter",
          label: "I do not wish to receive newsletters",
          semantic: "choice"
        }),
        control("continue", { label: "Continue", semantic: "continue", risk: "safe_continue" })
      ],
      decisionGroups: [{
        decisionGroupId: "contact_newsletter",
        requirementId: "contact:newsletter",
        surfaceId: "surface-page",
        surfaceType: "page",
        sectionType: "contact",
        sectionLabel: "Newsletter preferences",
        required: false,
        status: "optional",
        selectedControlId: "",
        alternatives: [{ controlId: "newsletter_opt_out", label: "I do not wish to receive newsletters" }]
      }],
      validationIssues: []
    }
  };

  const state = reduceTaskState({
    observation,
    userPolicy: { bookingRules: "No paid extras" },
    traveler: { booking_rules: "No paid extras" }
  });

  assert.equal(state.observedDecisions[0].status, "stale");
  assert.equal(state.activeDecisions.length, 0);
  assert.equal(state.currentGoal.semanticType, "navigation");
  assert.deepEqual(state.currentGoal.actionableControlIds, ["continue"]);
});

test("required and explicitly requested optional decisions still become active obligations", () => {
  const decisionGroup = (overrides = {}) => ({
    decisionGroupId: "contact_newsletter",
    requirementId: "contact:newsletter",
    surfaceId: "surface-page",
    surfaceType: "page",
    sectionType: "contact",
    sectionLabel: "Newsletter preferences",
    status: "optional",
    selectedControlId: "",
    alternatives: [{ controlId: "newsletter_opt_out", label: "I do not wish to receive newsletters" }],
    ...overrides
  });
  const observation = (group) => ({
    observationId: "obs_newsletter_obligation",
    page: {
      currentSurface: { id: "surface-page", type: "page" },
      controls: [control("newsletter_opt_out", {
        decisionGroupId: "contact_newsletter",
        label: "I do not wish to receive newsletters",
        semantic: "choice"
      })],
      decisionGroups: [group],
      validationIssues: []
    }
  });

  const requiredState = reduceTaskState({ observation: observation(decisionGroup({ required: true })) });
  assert.equal(requiredState.activeDecisions[0].decisionGroupId, "contact_newsletter");

  const requestedState = reduceTaskState({
    observation: observation(decisionGroup({ required: false })),
    userPolicy: { bookingRules: "Do not subscribe me to newsletters" }
  });
  assert.equal(requestedState.activeDecisions[0].decisionGroupId, "contact_newsletter");
});

test("completed exact outcomes survive scrolling, rerenders, missing controls and surface changes", () => {
  const first = reduceTaskState({
    observation: {
      observationId: "obs_selected",
      page: {
        currentSurface: { id: "seat_modal", type: "modal" },
        controls: [control("no_seat", { surfaceId: "seat_modal", surfaceType: "modal", decisionGroupId: "seat_leg_1", semantic: "decline_paid_extra" })],
        decisionGroups: [{
          decisionGroupId: "seat_leg_1",
          surfaceId: "seat_modal",
          sectionType: "seat",
          required: true,
          status: "satisfied",
          selectedControlId: "no_seat"
        }]
      }
    }
  });
  const rerendered = reduceTaskState({
    previousTaskState: first,
    observation: {
      observationId: "obs_rerendered",
      page: {
        currentSurface: { id: "seat_confirm", type: "modal", label: "Continue without seats" },
        controls: [],
        decisionGroups: []
      }
    }
  });

  assert.equal(rerendered.completedOutcomes.some((outcome) => outcome.decisionGroupId === "seat_leg_1"), true);
  assert.equal(rerendered.meaningfulSurfaceChange, true);
  assert.equal(rerendered.clearObsoleteRecovery, false);
  assert.equal(rerendered.stageOutcome.outcomeId, first.stageOutcome.outcomeId);
});

test("only exact fresh paid selection evidence reopens a completed decision", () => {
  const previousTaskState = {
    completedOutcomes: [{ decisionGroupId: "seat_leg_2", surfaceId: "old_surface", status: "satisfied" }]
  };
  const alternativesOnly = reduceTaskState({
    previousTaskState,
    userPolicy: { bookingRules: "No paid seats" },
    observation: {
      observationId: "obs_alternatives",
      page: {
        currentSurface: { id: "seat_modal", type: "modal", decisionGroupId: "seat_leg_2" },
        controls: [control("paid_seat", {
          surfaceId: "seat_modal",
          surfaceType: "modal",
          decisionGroupId: "seat_leg_2",
          structuredPrice: { amount: 25, currency: "EUR" },
          risk: "money"
        })],
        decisionGroups: [{
          decisionGroupId: "seat_leg_2",
          surfaceId: "seat_modal",
          sectionType: "seat",
          required: true,
          status: "missing",
          selectedControlId: ""
        }]
      }
    }
  });
  assert.equal(alternativesOnly.activeDecisions.length, 0);
  assert.equal(alternativesOnly.completedOutcomes.some((outcome) => outcome.decisionGroupId === "seat_leg_2"), true);

  const selectedPaid = reduceTaskState({
    previousTaskState: alternativesOnly,
    userPolicy: { bookingRules: "No paid seats" },
    observation: {
      observationId: "obs_selected_paid",
      page: {
        currentSurface: { id: "seat_modal", type: "modal", decisionGroupId: "seat_leg_2" },
        controls: [control("paid_seat", {
          surfaceId: "seat_modal",
          surfaceType: "modal",
          decisionGroupId: "seat_leg_2",
          structuredPrice: { amount: 25, currency: "EUR" },
          risk: "money"
        })],
        decisionGroups: [{
          decisionGroupId: "seat_leg_2",
          surfaceId: "seat_modal",
          sectionType: "seat",
          required: true,
          status: "missing",
          selectedControlId: "paid_seat"
        }]
      }
    }
  });
  assert.equal(selectedPaid.activeDecisions[0].status, "conflicted");
  assert.equal(selectedPaid.completedOutcomes.some((outcome) => outcome.decisionGroupId === "seat_leg_2"), false);
});

test("direct paid semantics reopen a manually changed completion and an exact remove option resolves it", () => {
  const paid = control("premium_addon", {
    decisionGroupId: "trip_addon",
    label: "Premium add-on",
    semantic: "add_paid_extra",
    risk: "money"
  });
  const remove = control("remove_addon", {
    decisionGroupId: "trip_addon",
    label: "Remove add-on",
    // Local extraction can retain paid-looking surrounding semantics. The
    // exact free/remove contrast remains authoritative for reconciliation.
    semantic: "add_paid_extra",
    risk: "money"
  });
  const group = (selectedControlId) => ({
    decisionGroupId: "trip_addon",
    requirementId: "extras:trip-addon",
    surfaceId: "surface-page",
    surfaceType: "page",
    sectionType: "extras",
    sectionLabel: "Trip add-on",
    required: false,
    status: "satisfied",
    selectedControlId,
    alternatives: [paid, remove]
  });
  const previousTaskState = {
    completedOutcomes: [{
      decisionGroupId: "trip_addon",
      requirementId: "extras:trip-addon",
      surfaceId: "surface-page",
      status: "satisfied",
      selectedControlId: "remove_addon"
    }]
  };
  const observation = (observationId, selectedControlId) => ({
    observationId,
    page: {
      currentSurface: { id: "surface-page", type: "page" },
      controls: [paid, remove, control("continue", { label: "Continue", semantic: "continue", risk: "safe_continue" })],
      decisionGroups: [group(selectedControlId)],
      validationIssues: []
    }
  });

  const conflicted = reduceTaskState({
    previousTaskState,
    observation: observation("obs_manual_paid_change", "premium_addon"),
    userPolicy: { bookingRules: "Decline all paid extras" }
  });
  assert.equal(conflicted.activeDecisions[0].status, "conflicted");
  assert.equal(conflicted.activeDecisions[0].reopenEvidence.code, "EXACT_SELECTED_OPTION_CONTRADICTS_POLICY");
  assert.equal(conflicted.completedOutcomes.some((outcome) => outcome.decisionGroupId === "trip_addon"), false);
  assert.deepEqual(conflicted.currentGoal.freeAlternativeControlIds, ["remove_addon"]);

  const repaired = reduceTaskState({
    previousTaskState: conflicted,
    observation: observation("obs_manual_paid_repaired", "remove_addon"),
    userPolicy: { bookingRules: "Decline all paid extras" }
  });
  assert.equal(repaired.activeDecisions.length, 0);
  assert.equal(repaired.completedOutcomes.find((outcome) => outcome.decisionGroupId === "trip_addon").selectedControlId, "remove_addon");
  assert.equal(repaired.currentGoal.semanticType, "navigation");
});

test("a proven paid conflict with a current-surface reversal outranks navigation despite stale surface metadata", () => {
  const decisionGroupId = "optional_selection";
  const paid = control("paid_choice", {
    surfaceId: "flow_modal",
    surfaceType: "modal",
    decisionGroupId,
    semantic: "add_paid_extra",
    risk: "money",
    structuredPrice: { amount: 26, currency: "EUR" }
  });
  const reverse = control("free_reversal", {
    surfaceId: "flow_modal",
    surfaceType: "modal",
    decisionGroupId,
    semantic: "remove_paid_extra",
    risk: "safe_decline",
    structuredPrice: { amount: 0, currency: "EUR" }
  });
  const navigate = control("advance_flow", {
    surfaceId: "flow_modal",
    surfaceType: "modal",
    semantic: "navigation",
    risk: "safe_continue"
  });
  const previousTaskState = {
    completedOutcomes: [{
      decisionGroupId,
      requirementId: "extras:optional-selection",
      surfaceId: "surface-page",
      status: "satisfied",
      selectedControlId: "free_reversal"
    }]
  };
  const observation = {
    observationId: "obs_paid_conflict_in_foreground",
    page: {
      currentSurface: { id: "flow_modal", type: "modal", memberControlIds: [paid.controlId, reverse.controlId, navigate.controlId] },
      controls: [paid, reverse, navigate],
      decisionGroups: [{
        decisionGroupId,
        requirementId: "extras:optional-selection",
        // This intentionally simulates stale ownership from a portal/rerender.
        surfaceId: "surface-page",
        surfaceType: "page",
        sectionType: "extras",
        required: false,
        status: "satisfied",
        selectedControlId: paid.controlId,
        selectedEvidence: {
          selected: true,
          disposition: "paid",
          selectedControlId: paid.controlId,
          structuredPrice: { amount: 26, currency: "EUR" }
        },
        alternativeControlIds: [paid.controlId, reverse.controlId],
        alternatives: [paid, reverse]
      }],
      validationIssues: []
    }
  };

  const state = reduceTaskState({
    previousTaskState,
    observation,
    userPolicy: { bookingRules: "Decline all paid extras" }
  });
  assert.equal(state.activeDecisions[0].status, "conflicted");
  assert.equal(state.currentGoal.decisionGroupId, decisionGroupId);
  assert.deepEqual(state.currentGoal.freeAlternativeControlIds, [reverse.controlId]);
  const candidates = buildCurrentCandidateSet({
    goal: state.currentGoal,
    observation,
    traveler: { booking_rules: "Decline all paid extras" },
    state: { taskState: state, approvals: {} }
  });
  assert.deepEqual(candidates.candidates.map((candidate) => candidate.controlId), [reverse.controlId]);
  assert.equal(candidates.contextCapabilities.find((candidate) => candidate.controlId === navigate.controlId).selectable, false);
});

test("an unknown optional manual selection invalidates the old completion without blocking navigation", () => {
  const state = reduceTaskState({
    previousTaskState: {
      completedOutcomes: [{
        decisionGroupId: "optional_unknown",
        surfaceId: "surface-page",
        status: "satisfied",
        selectedControlId: "old_choice"
      }]
    },
    observation: {
      observationId: "obs_optional_changed",
      page: {
        currentSurface: { id: "surface-page", type: "page" },
        controls: [
          control("new_choice", { decisionGroupId: "optional_unknown", risk: "uncertain" }),
          control("continue", { label: "Continue", semantic: "continue", risk: "safe_continue" })
        ],
        decisionGroups: [{
          decisionGroupId: "optional_unknown",
          surfaceId: "surface-page",
          surfaceType: "page",
          sectionType: "unknown",
          required: false,
          status: "satisfied",
          selectedControlId: "new_choice"
        }],
        validationIssues: []
      }
    }
  });

  assert.equal(state.observedDecisions[0].status, "stale");
  assert.equal(state.observedDecisions[0].reopenEvidence.code, "EXACT_SELECTED_CONTROL_CHANGED");
  assert.equal(state.completedOutcomes.some((outcome) => outcome.decisionGroupId === "optional_unknown"), false);
  assert.equal(state.activeDecisions.length, 0);
  assert.equal(state.currentGoal.semanticType, "navigation");
});

test("grounded semantic ownership turns an ambiguous paid summary into the exact policy conflict", () => {
  const observation = {
    observationId: "obs_ambiguous_paid_summary",
    page: {
      url: "https://example.test/checkout/seats",
      currentSurface: { id: "surface-page", type: "page", label: "Reserve seating" },
      controls: [
        control("remove_selected_item", {
          decisionGroupId: "dg_selected_item",
          label: "Remove",
          semantic: "remove_paid_extra",
          risk: "safe_decline"
        }),
        control("advance_checkout", { label: "Proceed", semantic: "navigation", risk: "safe_continue" })
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
          source: "owned_selected_item_summary",
          ownerElementId: "selected-item"
        },
        semanticOwnership: {
          status: "resolved",
          family: "seat",
          source: "grounded_ai",
          controlId: "remove_selected_item"
        },
        removalControlId: "remove_selected_item",
        alternatives: [{ controlId: "remove_selected_item", semantic: "remove_paid_extra", risk: "safe_decline" }]
      }],
      validationIssues: []
    }
  };

  const state = reduceTaskState({ observation, traveler: { booking_rules: "No paid seats" } });
  assert.equal(state.activeDecisions.length, 1);
  assert.equal(state.activeDecisions[0].status, "conflicted");
  assert.equal(state.activeDecisions[0].family, "seat");
  assert.equal(state.currentGoal.decisionGroupId, "dg_selected_item");
  assert.deepEqual(state.currentGoal.freeAlternativeControlIds, ["remove_selected_item"]);
  assert.equal(state.currentGoal.actionableControlIds, undefined);
});

test("fresh transaction-backed paid truth cannot remain satisfied when selected evidence is missing", () => {
  const reversal = control("reverse_paid_selection", {
    surfaceId: "current_modal",
    surfaceType: "modal",
    decisionGroupId: "dg_live_summary",
    label: "Undo",
    semantic: "remove_paid_extra",
    risk: "safe_decline"
  });
  const navigation = control("advance_modal", {
    surfaceId: "current_modal",
    surfaceType: "modal",
    label: "Proceed",
    semantic: "navigation",
    risk: "safe_continue"
  });
  const observation = {
    observationId: "obs_transaction_paid_truth",
    page: {
      currentSurface: {
        id: "current_modal",
        type: "modal",
        memberControlIds: [reversal.controlId, navigation.controlId]
      },
      controls: [reversal, navigation],
      decisionGroups: [{
        decisionGroupId: "dg_live_summary",
        surfaceId: "current_modal",
        sectionType: "unknown",
        sectionLabel: "Unrelated nearby heading",
        status: "satisfied",
        selectedControlId: "",
        selectedLabel: "Selected item 23 EUR",
        selectedSemantic: "selected_paid_item",
        selectedEvidence: null,
        semanticOwnership: null,
        removalControlId: null,
        alternativeControlIds: [reversal.controlId],
        alternatives: [{ controlId: reversal.controlId }]
      }],
      transactionFacts: {
        selectedExtras: [{
          decisionGroupId: "dg_live_summary",
          label: "Selected item 23 EUR",
          disposition: "paid",
          priceAmount: 23,
          currency: "EUR"
        }]
      },
      validationIssues: []
    }
  };

  const state = reduceTaskState({
    observation,
    userPolicy: { bookingRules: "No paid extras" }
  });
  assert.equal(state.activeDecisions[0].status, "conflicted");
  assert.equal(state.activeDecisions[0].reopenEvidence.structuredPrice.amount, 23);
  assert.equal(state.currentGoal.decisionGroupId, "dg_live_summary");
  assert.deepEqual(state.currentGoal.freeAlternativeControlIds, [reversal.controlId]);
  const candidates = buildCurrentCandidateSet({
    goal: state.currentGoal,
    observation,
    traveler: { booking_rules: "No paid extras" },
    state: { taskState: state, approvals: {} }
  });
  assert.deepEqual(candidates.candidates.map((candidate) => candidate.controlId), [reversal.controlId]);
  assert.equal(candidates.contextCapabilities.find((candidate) => candidate.controlId === navigation.controlId).selectable, false);
});

test("decline policy is scoped to the matching optional family", () => {
  const seat = control("paid_seat", {
    decisionGroupId: "seat_group",
    label: "Selected seat",
    risk: "money",
    semantic: "add_paid_extra",
    structuredPrice: { amount: 19, currency: "EUR" }
  });
  const bundle = control("paid_bundle", {
    decisionGroupId: "bundle_group",
    label: "Selected bundle",
    risk: "money",
    semantic: "add_paid_extra",
    structuredPrice: { amount: 29, currency: "EUR" }
  });
  const observation = {
    observationId: "obs_family_policy",
    page: {
      currentSurface: { id: "surface-page", type: "page" },
      controls: [seat, bundle],
      decisionGroups: [
        {
          decisionGroupId: "seat_group",
          surfaceId: "surface-page",
          sectionType: "seat",
          sectionLabel: "Seat selection",
          status: "satisfied",
          selectedControlId: "paid_seat"
        },
        {
          decisionGroupId: "bundle_group",
          surfaceId: "surface-page",
          sectionType: "bundle",
          sectionLabel: "Travel bundle",
          status: "satisfied",
          selectedControlId: "paid_bundle"
        }
      ],
      validationIssues: []
    }
  };

  const seatsOnly = reduceTaskState({ observation, traveler: { booking_rules: "No paid seats" } });
  assert.deepEqual(seatsOnly.activeDecisions.map((decision) => decision.decisionGroupId), ["seat_group"]);
  assert.equal(seatsOnly.observedDecisions.find((decision) => decision.decisionGroupId === "bundle_group").status, "satisfied");
  assert.deepEqual(seatsOnly.safetyRestrictions.declinePaidExtrasByFamily, {
    seat: true,
    baggage: false,
    insurance: false,
    extras: false
  });

  const bundlesOnly = reduceTaskState({ observation, traveler: { booking_rules: "No bundles" } });
  assert.deepEqual(bundlesOnly.activeDecisions.map((decision) => decision.decisionGroupId), ["bundle_group"]);
  assert.equal(bundlesOnly.observedDecisions.find((decision) => decision.decisionGroupId === "seat_group").status, "satisfied");
});

test("an exact paid-item authorization conflicting with decline policy requires user resolution", () => {
  const paid = control("paid_bundle", {
    decisionGroupId: "bundle_authorized",
    label: "All passengers",
    risk: "money",
    semantic: "add_paid_extra",
    structuredPrice: { amount: 29, currency: "EUR" }
  });
  const free = control("free_bundle", {
    decisionGroupId: "bundle_authorized",
    label: "None",
    risk: "safe_decline",
    semantic: "decline_paid_extra",
    structuredPrice: { amount: 0, currency: "EUR" }
  });
  const state = reduceTaskState({
    observation: {
      observationId: "obs_authorized_policy_conflict",
      page: {
        currentSurface: { id: "surface-page", type: "page" },
        controls: [paid, free],
        decisionGroups: [{
          decisionGroupId: "bundle_authorized",
          surfaceId: "surface-page",
          sectionType: "bundle",
          sectionLabel: "Travel bundle",
          status: "satisfied",
          selectedControlId: "paid_bundle",
          selectedEvidence: {
            selected: true,
            disposition: "paid",
            selectedControlId: "paid_bundle",
            structuredPrice: { amount: 29, currency: "EUR" }
          },
          alternatives: [{ controlId: "paid_bundle" }, { controlId: "free_bundle" }]
        }],
        validationIssues: []
      }
    },
    userPolicy: {
      bookingRules: "Decline all paid extras",
      paidExtraAuthorizations: [{ authorizationId: "auth_bundle", decisionGroupId: "bundle_authorized" }]
    }
  });

  assert.equal(state.activeDecisions[0].status, "blocked");
  assert.equal(state.activeDecisions[0].reopenEvidence.code, "PAID_SELECTION_POLICY_AUTHORIZATION_CONFLICT");
  assert.equal(state.activeDecisions[0].reopenEvidence.authorizationId, "auth_bundle");
});

test("backend payment stage ignores extension hint and suppresses ordinary goals", () => {
  const state = reduceTaskState({
    observation: {
      observationId: "obs_payment",
      page: {
        step: "extras",
        url: "https://example.test/checkout/payment",
        text: "Payment details. Choose payment method. Total to pay 208 EUR.",
        currentSurface: { id: "surface-page", type: "page" },
        controls: [control("card", { semantic: "card_number" })],
        foreground: { progressMarkers: { payment: "current" } },
        decisionGroups: []
      }
    }
  });

  assert.equal(state.stage, "payment");
  assert.equal(state.terminalStatus, "payment_review_reached");
  assert.equal(state.currentGoal, null);
  assert.deepEqual(state.goal, { id: "reach_payment_review", status: "completed" });
  assert.equal(state.paymentEvidence.observed, true);
  assert.equal(state.paymentEvidence.signalCount >= 3, true);
  assert.equal(state.safetyRestrictions.paymentSubmissionRequiresApproval, true);
  assert.equal(state.safetyRestrictions.paymentCredentialsBlocked, true);
});

test("verified payment completion remains latched after redirect to a new search page", () => {
  const payment = reduceTaskState({
    observation: {
      observationId: "obs_payment_latch",
      page: {
        url: "https://example.test/rf/payment",
        text: "Payment details. Choose payment method. Total to pay 208 EUR.",
        currentSurface: { id: "surface-page", type: "page" },
        controls: [control("card_latch", { semantic: "card_number" })],
        foreground: { progressMarkers: { payment: "current" } },
        decisionGroups: []
      }
    }
  });
  assert.equal(payment.terminalGoalLatch.locked, true);

  const redirected = reduceTaskState({
    previousTaskState: payment,
    observation: {
      observationId: "obs_redirected_search",
      page: {
        url: "https://example.test/rf/start",
        text: "Configure your trip. Choose your bundle. Select a new flight.",
        currentSurface: { id: "surface-page", type: "page" },
        controls: [control("new_search", { semantic: "flight_search" })],
        decisionGroups: []
      }
    }
  });
  assert.equal(redirected.stage, "flight_selection");
  assert.equal(redirected.checkoutBoundary.status, "new_search_page");
  assert.equal(redirected.terminalGoalLatch.locked, true);
  assert.equal(redirected.terminalStatus, "payment_review_reached");
  assert.equal(redirected.goal.status, "completed");
  assert.equal(redirected.currentGoal, null);

  const unrelated = reduceTaskState({
    previousTaskState: redirected,
    observation: {
      observationId: "obs_unrelated_page",
      page: {
        url: "https://example.test/account",
        text: "Account home",
        currentSurface: { id: "surface-page", type: "page" },
        controls: [],
        decisionGroups: []
      }
    }
  });
  assert.equal(unrelated.terminalStatus, "payment_review_reached");
  assert.equal(unrelated.currentGoal, null);
});

test("an active checkout redirected to the search start is classified as checkout left", () => {
  const active = reduceTaskState({
    observation: {
      observationId: "obs_active_extras",
      page: {
        url: "https://example.test/rf/extras",
        text: "Choose your bundle",
        currentSurface: { id: "surface-page", type: "page" },
        controls: [],
        decisionGroups: []
      }
    }
  });
  assert.equal(active.stage, "extras");

  const left = reduceTaskState({
    previousTaskState: active,
    observation: {
      observationId: "obs_search_start",
      page: {
        step: "extras",
        url: "https://example.test/rf/start",
        text: "Choose your bundle. Start a new flight search.",
        currentSurface: { id: "surface-page", type: "page" },
        controls: [],
        decisionGroups: []
      }
    }
  });
  assert.equal(left.stage, "flight_selection");
  assert.equal(left.terminalStatus, "checkout_left");
  assert.equal(left.checkoutBoundary.leftActiveCheckout, true);
  assert.equal(left.currentGoal, null);
});

test("unknown foreground gives AI complete context but only policy-safe selectable IDs", () => {
  const observation = {
    observationId: "obs_unknown_popup",
    observationSnapshot: { snapshotHash: "hash_popup" },
    page: {
      currentSurface: { id: "mystery", type: "modal", memberControlIds: ["safe_close", "paid_upgrade"] },
      controls: [
        control("safe_close", { surfaceId: "mystery", surfaceType: "modal", label: "Close", semantic: "dismiss" }),
        control("paid_upgrade", {
          surfaceId: "mystery",
          surfaceType: "modal",
          label: "Upgrade 30 EUR",
          semantic: "purchase",
          risk: "money",
          structuredPrice: { amount: 30, currency: "EUR" }
        })
      ],
      decisionGroups: []
    }
  };
  const taskState = reduceTaskState({ observation });
  const candidates = buildCurrentCandidateSet({
    goal: taskState.currentGoal,
    observation,
    state: { taskState, approvals: {} }
  });

  assert.equal(taskState.currentGoal.selectionMode, "ai_ambiguity");
  assert.equal(candidates.contextCapabilities.length, 2);
  assert.equal(candidates.contextCapabilities.some((candidate) => candidate.controlId === "paid_upgrade"), true);
  assert.equal(candidates.contextCapabilities.find((candidate) => candidate.controlId === "paid_upgrade").policyDecision.allow, false);
  assert.deepEqual(candidates.candidates.map((candidate) => candidate.controlId), ["safe_close"]);
});

test("decision planning keeps unrelated surface controls as context and uses one shared safe selectable set", () => {
  const observation = {
    observationId: "obs_decision_context",
    observationSnapshot: { snapshotHash: "hash_decision_context" },
    page: {
      currentSurface: { id: "offer_modal", type: "modal", memberControlIds: ["no_thanks", "paid_upgrade", "close_help"] },
      controls: [
        control("no_thanks", { surfaceId: "offer_modal", surfaceType: "modal", decisionGroupId: "upgrade_choice", label: "No thanks", semantic: "decline_paid_extra" }),
        control("paid_upgrade", {
          surfaceId: "offer_modal",
          surfaceType: "modal",
          decisionGroupId: "upgrade_choice",
          label: "Upgrade for 30 EUR",
          semantic: "add_paid_extra",
          risk: "money",
          structuredPrice: { amount: 30, currency: "EUR" }
        }),
        control("close_help", { surfaceId: "offer_modal", surfaceType: "modal", label: "Close help", semantic: "dismiss" })
      ],
      decisionGroups: [{
        decisionGroupId: "upgrade_choice",
        requirementId: "upgrade_choice",
        surfaceId: "offer_modal",
        sectionType: "extras",
        required: true,
        status: "missing",
        alternatives: [{ controlId: "no_thanks" }, { controlId: "paid_upgrade" }]
      }],
      validationIssues: []
    }
  };
  const taskState = reduceTaskState({ observation, userPolicy: { bookingRules: "No paid extras" } });
  const candidateSet = buildCurrentCandidateSet({
    goal: taskState.currentGoal,
    observation,
    state: {
      taskState,
      approvals: {},
      legacyRequirementsDiagnostic: {
        diagnosticOnly: true,
        requirements: [{ id: "obsolete", required: true, status: "missing" }]
      }
    },
    traveler: { booking_rules: "no paid extras" }
  });

  assert.deepEqual(candidateSet.contextCapabilities.map((candidate) => candidate.controlId).sort(), ["close_help", "no_thanks", "paid_upgrade"]);
  assert.equal(candidateSet.contextCapabilities.find((candidate) => candidate.controlId === "close_help").selectable, false);
  assert.equal(candidateSet.contextCapabilities.find((candidate) => candidate.controlId === "paid_upgrade").policyStatus, "deny");
  assert.deepEqual(
    candidateSet.candidates.map((candidate) => candidate.controlId),
    ["no_thanks"],
    JSON.stringify({ goal: taskState.currentGoal, context: candidateSet.contextCapabilities, excluded: candidateSet.excludedCandidates })
  );
});

test("exact baggage groups decline cabin then checked baggage before Continue", () => {
  const traveler = { booking_rules: "no paid extras and no paid baggage" };
  const userPolicy = { bookingRules: traveler.booking_rules };
  const controls = [
    control("cabin_none", { decisionGroupId: "cabin_baggage", label: "No hand baggage", semantic: "choice" }),
    control("cabin_paid", { decisionGroupId: "cabin_baggage", label: "8 kg", semantic: "choice", risk: "money", structuredPrice: { amount: 18, currency: "EUR" } }),
    control("checked_none", { decisionGroupId: "checked_baggage", label: "No checked baggage", semantic: "choice" }),
    control("checked_paid", { decisionGroupId: "checked_baggage", label: "20 kg", semantic: "choice", risk: "money", structuredPrice: { amount: 35, currency: "EUR" } }),
    control("continue", { label: "Continue", semantic: "continue", risk: "safe_continue" })
  ];
  const group = (decisionGroupId, status, selectedControlId = "") => ({
    decisionGroupId,
    requirementId: decisionGroupId,
    surfaceId: "surface-page",
    surfaceType: "page",
    sectionType: "baggage",
    required: true,
    status,
    selectedControlId,
    alternatives: decisionGroupId === "cabin_baggage"
      ? [{ controlId: "cabin_none" }, { controlId: "cabin_paid" }]
      : [{ controlId: "checked_none" }, { controlId: "checked_paid" }]
  });
  const observation = (observationId, cabinStatus, cabinSelected, checkedStatus, checkedSelected) => ({
    observationId,
    observationSnapshot: { snapshotHash: `${observationId}_hash` },
    page: {
      currentSurface: { id: "surface-page", type: "page" },
      controls,
      decisionGroups: [
        group("cabin_baggage", cabinStatus, cabinSelected),
        group("checked_baggage", checkedStatus, checkedSelected)
      ],
      validationIssues: []
    }
  });

  const cabinObservation = observation("obs_cabin", "missing", "", "missing", "");
  const cabinState = reduceTaskState({ observation: cabinObservation, userPolicy, traveler });
  assert.equal(cabinState.currentGoal.decisionGroupId, "cabin_baggage");
  assert.deepEqual(cabinState.currentGoal.eligibleAlternativeControlIds, ["cabin_none", "cabin_paid"]);
  assert.deepEqual(cabinState.currentGoal.freeAlternativeControlIds, ["cabin_none"]);
  const cabinCandidates = buildCurrentCandidateSet({
    goal: cabinState.currentGoal,
    observation: cabinObservation,
    state: { taskState: cabinState, approvals: {} },
    traveler
  });
  assert.deepEqual(cabinCandidates.candidates.map((candidate) => candidate.controlId), ["cabin_none"]);
  assert.equal(cabinCandidates.candidates[0].decisionGroupId, "cabin_baggage");
  assert.equal(cabinCandidates.candidates[0].expectedOutcome.type, "exact_free_option_selected");
  assert.equal(cabinCandidates.candidates[0].expectedOutcome.expectedSelectedControlId, "cabin_none");

  const checkedObservation = observation("obs_checked", "satisfied", "cabin_none", "missing", "");
  const checkedState = reduceTaskState({
    previousTaskState: cabinState,
    observation: checkedObservation,
    previousActionResult: { verified: true, postconditionSatisfied: true },
    userPolicy,
    traveler
  });
  assert.equal(checkedState.completedOutcomes.some((outcome) => outcome.decisionGroupId === "cabin_baggage"), true);
  assert.equal(checkedState.currentGoal.decisionGroupId, "checked_baggage");
  const checkedCandidates = buildCurrentCandidateSet({
    goal: checkedState.currentGoal,
    observation: checkedObservation,
    state: { taskState: checkedState, approvals: {} },
    traveler
  });
  assert.deepEqual(checkedCandidates.candidates.map((candidate) => candidate.controlId), ["checked_none"]);
  assert.equal(checkedCandidates.candidates[0].decisionGroupId, "checked_baggage");
  assert.equal(checkedCandidates.candidates[0].expectedOutcome.type, "exact_free_option_selected");
  assert.equal(checkedCandidates.candidates[0].expectedOutcome.expectedSelectedControlId, "checked_none");

  const continueObservation = observation("obs_baggage_done", "satisfied", "cabin_none", "satisfied", "checked_none");
  const continueState = reduceTaskState({
    previousTaskState: checkedState,
    observation: continueObservation,
    previousActionResult: { verified: true, postconditionSatisfied: true },
    userPolicy,
    traveler
  });
  assert.equal(continueState.completedOutcomes.some((outcome) => outcome.decisionGroupId === "checked_baggage"), true);
  assert.equal(continueState.activeDecisions.length, 0);
  assert.equal(continueState.currentGoal.semanticType, "navigation");
  assert.deepEqual(continueState.currentGoal.actionableControlIds, ["continue"]);
});

test("seat-map traveler rows never become free-seat candidates", () => {
  const traveler = { booking_rules: "no paid seats" };
  const observation = {
    observationId: "obs_live_seat_map",
    observationSnapshot: { snapshotHash: "hash_live_seat_map" },
    page: {
      currentSurface: { id: "seat_modal", type: "modal", label: "Reserve seating Flight 1 of 2" },
      controls: [
        control("traveler_row", {
          surfaceId: "seat_modal",
          surfaceType: "modal",
          decisionGroupId: "seat_modal_group",
          label: "Ali SIFRAR Not selected",
          semantic: "choice",
          risk: "uncertain"
        }),
        control("paid_seat_1e", {
          surfaceId: "seat_modal",
          surfaceType: "modal",
          decisionGroupId: "seat_modal_group",
          label: "Seat 1E 50 EUR",
          semantic: "add_paid_extra",
          risk: "money",
          structuredPrice: { amount: 50, currency: "EUR" }
        }),
        control("next_leg", {
          surfaceId: "seat_modal",
          surfaceType: "modal",
          decisionGroupId: "seat_modal_group",
          label: "Next",
          semantic: "continue",
          risk: "safe"
        })
      ],
      decisionGroups: [{
        decisionGroupId: "seat_modal_group",
        requirementId: "seat",
        surfaceId: "seat_modal",
        surfaceType: "modal",
        sectionType: "seat",
        required: true,
        status: "missing",
        alternatives: [
          { controlId: "traveler_row" },
          { controlId: "paid_seat_1e" },
          { controlId: "next_leg" }
        ]
      }],
      validationIssues: []
    }
  };

  const taskState = reduceTaskState({
    observation,
    userPolicy: { bookingRules: traveler.booking_rules },
    traveler
  });
  assert.deepEqual(taskState.currentGoal.freeAlternativeControlIds, []);
  assert.deepEqual(taskState.currentGoal.paidAlternativeControlIds, ["paid_seat_1e"]);
  const candidates = buildCurrentCandidateSet({
    goal: taskState.currentGoal,
    observation,
    traveler,
    state: { taskState, approvals: {} }
  });

  assert.deepEqual(candidates.candidates.map((candidate) => candidate.controlId), ["next_leg"]);
  assert.equal(candidates.contextCapabilities.find((candidate) => candidate.controlId === "traveler_row").selectable, false);
  assert.equal(candidates.contextCapabilities.find((candidate) => candidate.controlId === "paid_seat_1e").selectable, false);
});
