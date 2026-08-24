"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const agentContract = require("../../apps/extension/src/shared/agent-contract");
const { resolveProfileDecision } = require("../../apps/web/agent/policy-profile");
const { reduceTaskState } = require("./task-state-replay-adapter");
const { buildCurrentCandidateSet } = require("./legacy-mechanics-binding-adapter");

function executableControl({ controlId, targetId, label, x, testId = "", price = null, semantic = "selection_cta" }) {
  const box = { x, y: 723, width: 200, height: 44, centerX: x + 100, centerY: 745, inViewport: true };
  return {
    controlId,
    stableKey: `button|meaning:${label.toLowerCase()}|path:repeated-card`,
    label,
    ownText: label,
    accessibleName: `${label} ${testId}`,
    testId,
    semantic,
    semanticIntent: semantic,
    kind: "button",
    role: "button",
    risk: price ? "money" : "uncertain",
    structuredPrice: price,
    surfaceId: "surface-page",
    surfaceType: "page",
    stateElementId: targetId,
    preferredActivationElementId: targetId,
    state: { selected: false, checked: false, required: false, valuePresent: true },
    visualRegion: box,
    operations: {
      activate: {
        actuatorId: targetId,
        actuatorIds: [targetId],
        status: "proven_executable",
        actionability: {
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
          box
        }
      }
    }
  };
}

function kiwiFailurePage() {
  return {
    step: "extras",
    visibleText: "Get the option to change or cancel your trip Upgrade your ticket so you can rebook or get a refund if you decide to change your plans. Learn more Basic Saver Included No flexibility to change your trip Refund: Your amount depends on airline rules, with a 30 € fee per traveler per flight. Continue with Saver Recommended Basic Standard + 685.74 TL Free trip changes or only pay the difference Refund: Your amount depends on airline rules, with a 30 € fee per traveler per flight. Continue with Standard Basic Flexi + 1,396.64 TL Free trip changes or only pay the difference 80% refund of the ticket and any airline services if you cancel Continue with Flexi Rebooking and cancellation options are available up to 48 hours before the first departure in your itinerary. Back",
    readiness: { documentReadyState: "complete", ariaBusy: false, loadingIndicatorCount: 0, stableForMs: 1000 },
    currentSurface: { id: "surface-page", type: "page", label: "extras" },
    decisionGroups: [],
    controls: [
      executableControl({ controlId: "ctrl_button_h11ppoh7", targetId: "atw-el-71", label: "Continue with Saver", x: 417, testId: "fareTypesSaverButton" }),
      executableControl({ controlId: "ctrl_button_hco73sm", targetId: "atw-el-72", label: "Continue with Standard", x: 669, testId: "fareTypesStandardButton" }),
      executableControl({ controlId: "ctrl_button_hnb236g", targetId: "atw-el-74", label: "Continue with Flexi", x: 922, testId: "fareTypesFlexiButton" })
    ]
  };
}

function kiwiAbsoluteFareTotalsPage() {
  return {
    step: "extras",
    visibleText: "Get the option to change or cancel your trip Basic Saver 33 € No flexibility to change your trip Refund: Your amount depends on airline rules, with a 30 € fee per traveler per flight. Continue with Saver Recommended Basic Standard 45 € Free trip changes or only pay the difference Refund: Your amount depends on airline rules, with a 30 € fee per traveler per flight. Continue with Standard Basic Flexi 58 € Free trip changes or only pay the difference 80% refund of the ticket and any airline services if you cancel Continue with Flexi Total (EUR) 33 € View price breakdown",
    readiness: { documentReadyState: "complete", ariaBusy: false, loadingIndicatorCount: 0, stableForMs: 1000 },
    currentSurface: { id: "surface-page", type: "page", label: "extras" },
    decisionGroups: [],
    controls: [
      executableControl({ controlId: "fare_saver", targetId: "fare-saver", label: "Continue with Saver", x: 417 }),
      executableControl({ controlId: "fare_standard", targetId: "fare-standard", label: "Continue with Standard", x: 669 }),
      executableControl({ controlId: "fare_flexi", targetId: "fare-flexi", label: "Continue with Flexi", x: 922 })
    ]
  };
}

function kiwiSeatConfirmationPage() {
  const surfaceId = "seat-confirmation";
  const onSurface = (control, overrides = {}) => ({
    ...control,
    surfaceId,
    surfaceType: "modal",
    decisionGroupId: "dg_kiwi_seat_confirmation",
    ...overrides
  });
  return {
    step: "confirmation",
    visibleText: "Are you sure that you don't want to select seats for your flights? Skip seat selection Continue with seat selection",
    readiness: { documentReadyState: "complete", ariaBusy: false, loadingIndicatorCount: 0, stableForMs: 1000 },
    currentSurface: {
      id: surfaceId,
      type: "modal",
      label: "Are you sure that you don't want to select seats for your flights?",
      blocksBackground: true,
      memberControlIds: ["close", "skip", "continue"]
    },
    decisionGroups: [],
    controls: [
      executableControl({ controlId: "background_first_name", targetId: "first-name", label: "First name", x: 100, semantic: "first_name" }),
      onSurface(executableControl({ controlId: "close", targetId: "close-button", label: "Close", x: 300, semantic: "dismiss_surface" })),
      onSurface(executableControl({ controlId: "skip", targetId: "skip-button", label: "Skip seat selection", x: 500, semantic: "decline_paid_extra" }), {
        risk: "safe_decline",
        physicalEffect: "dismiss_surface"
      }),
      onSurface(executableControl({ controlId: "continue", targetId: "continue-button", label: "Continue with seat selection", x: 720, semantic: "selection_cta" }), {
        physicalEffect: "dismiss_surface"
      })
    ]
  };
}

test("exact sanitized Kiwi observation reconstructs one fare decision with three owned actuators", () => {
  const compiled = agentContract.compileSemanticCheckout(kiwiFailurePage());
  const fares = compiled.decisionContracts.filter((decision) => decision.subject === "fare_package");
  assert.equal(fares.length, 1);
  assert.equal(fares[0].kind, "exclusive_choice");
  assert.equal(fares[0].required, true);
  assert.equal(fares[0].valid, true);
  assert.deepEqual(fares[0].options.map((option) => option.label), ["Saver", "Standard", "Flexi"]);
  assert.deepEqual(fares[0].options.map((option) => option.priceDelta), [0, 685.74, 1396.64]);
  assert.deepEqual(fares[0].options.map((option) => option.currency), ["TRY", "TRY", "TRY"]);
  assert.deepEqual(fares[0].options.map((option) => option.exactActuator.targetId), ["atw-el-71", "atw-el-72", "atw-el-74"]);
  assert.equal(fares[0].options[2].canonicalAttributes.refundPercent, 80);
  assert.equal(compiled.unownedMaterialControls.length, 0);
  assert.equal(compiled.semanticReadiness, "ready");
  compiled.controls.forEach((control) => assert.equal(control.choiceContract?.decisionInstance, fares[0].decisionGroupId));
});

test("the same fare decision resolves differently from profile criteria and never invents paid authority", () => {
  const compiled = agentContract.compileSemanticCheckout(kiwiFailurePage());
  const decision = compiled.decisionContracts.find((item) => item.subject === "fare_package");
  const cheapest = resolveProfileDecision(decision, { userPolicy: { bookingRules: "Cheapest included fare" } });
  const standard = resolveProfileDecision(decision, { userPolicy: { bookingRules: "Flexible changes, maximum 700 TL" } });
  const flexi = resolveProfileDecision(decision, { userPolicy: { bookingRules: "At least 80% refund, maximum 1,500 TL" } });
  const unspecified = resolveProfileDecision(decision, { userPolicy: {} });
  const unbounded = resolveProfileDecision(decision, { userPolicy: { bookingRules: "I prefer flexible changes" } });

  assert.equal(cheapest.preferredOptionId, "saver");
  assert.equal(cheapest.authorization, null);
  assert.equal(standard.preferredOptionId, "standard");
  assert.equal(standard.authorization.maximumAmount, 700);
  assert.equal(flexi.preferredOptionId, "flexi");
  assert.equal(flexi.authorization.maximumAmount, 1500);
  assert.equal(unspecified.match, "ambiguous");
  assert.equal(unspecified.preferredOptionId, "");
  assert.equal(unbounded.match, "ambiguous");
  assert.equal(unbounded.authorization, null);
});

test("absolute fare totals compile into one zero-increment base fare and exact profile candidate", () => {
  const page = kiwiAbsoluteFareTotalsPage();
  const compiled = agentContract.compileSemanticCheckout(page);
  const decision = compiled.decisionContracts.find((item) => item.subject === "fare_package");
  assert.ok(decision);
  assert.deepEqual(decision.options.map((option) => option.priceDelta), [0, 12, 25]);
  assert.deepEqual(decision.options.map((option) => option.currency), ["EUR", "EUR", "EUR"]);
  assert.deepEqual(decision.options.map((option) => option.canonicalAttributes.displayedTotal), [33, 45, 58]);
  assert.deepEqual(decision.options.map((option) => option.canonicalAttributes.priceBasis), [
    "absolute_total",
    "absolute_total",
    "absolute_total"
  ]);

  const traveler = { booking_rules: "No paid extras" };
  const observation = {
    observationId: "obs_absolute_fares",
    page: {
      ...page,
      controls: compiled.controls,
      decisionGroups: compiled.decisionGroups,
      decisionContracts: compiled.decisionContracts
    }
  };
  const state = reduceTaskState({ observation, traveler });
  assert.equal(state.currentGoal.semanticType, "fare_package");
  assert.equal(state.currentGoal.desiredPolicyOutcome, "included_base_fare");
  assert.equal(state.currentGoal.desiredSemanticOutcome, "included_base_fare");
  assert.deepEqual(state.currentGoal.policyAllowedControlIds, ["fare_saver"]);
  const candidateSet = buildCurrentCandidateSet({
    goal: state.currentGoal,
    observation,
    traveler,
    state: { taskState: state, approvals: {} }
  });
  assert.deepEqual(
    candidateSet.candidates.map((candidate) => candidate.controlId),
    ["fare_saver"],
    JSON.stringify(candidateSet, null, 2)
  );
  assert.equal(candidateSet.candidates[0].targetLabel, "Continue with Saver");
});

test("Continue labels never manufacture an included fare when price effects are unknown", () => {
  const resolution = resolveProfileDecision({
    decisionGroupId: "unknown_fares",
    subject: "fare_package",
    kind: "exclusive_choice",
    required: true,
    material: true,
    options: [
      { optionId: "saver", controlId: "saver", label: "Continue with Saver", executable: true },
      { optionId: "standard", controlId: "standard", label: "Continue with Standard", executable: true },
      { optionId: "flexi", controlId: "flexi", label: "Continue with Flexi", executable: true }
    ]
  }, { userPolicy: { bookingRules: "No paid extras" } });
  assert.equal(resolution.match, "unavailable");
  assert.deepEqual(resolution.eligibleOptionIds, []);
  assert.equal(resolution.preferredControlId, "");
});

test("a selected paid fare does not satisfy a no-paid constraint merely because something is selected", () => {
  const page = kiwiAbsoluteFareTotalsPage();
  page.controls[1].selected = true;
  page.controls[1].state = { ...page.controls[1].state, selected: true };
  const state = reduceTaskState({
    observation: { observationId: "obs_wrong_selected_fare", page },
    traveler: { booking_rules: "No paid extras" }
  });
  const fare = state.canonicalDecisions.find((decision) => decision.subject?.key === "fare_package");
  assert.equal(fare.currentState.selectedControlId, "fare_standard");
  assert.equal(fare.status, "conflicted");
  assert.equal(fare.needsAction, true);
  assert.deepEqual(fare.userIntent.desiredControlIds, ["fare_saver"]);
});

test("TaskState consumes the compiled contract and schedules only the profile-resolved exact option", () => {
  const page = kiwiFailurePage();
  const state = reduceTaskState({
    observation: { observationId: "obs_ms8m7xbb_379", page },
    userPolicy: { bookingRules: "Flexible changes, maximum 700 TL" },
    traveler: {}
  });
  assert.equal(state.semanticReadiness, "ready");
  assert.equal(state.currentObligation.subject.semanticType, "fare_package");
  assert.deepEqual(state.currentObligation.admittedControlIds, ["ctrl_button_hco73sm"]);
  assert.equal(state.currentObligation.policyDecision.authorization.maximumAmount, 700);
});

test("blocking seat confirmation is reconstructed as a profile-resolved foreground choice", () => {
  const page = kiwiSeatConfirmationPage();
  const compiled = agentContract.compileSemanticCheckout(page);
  assert.equal(compiled.semanticReadiness, "ready");
  assert.equal(compiled.decisionContracts.length, 1);
  const decision = compiled.decisionContracts[0];
  assert.equal(decision.subject, "seat");
  assert.deepEqual(decision.options.map((option) => option.controlId), ["skip", "continue"]);

  const random = resolveProfileDecision(decision, { userPolicy: { seatPolicy: "random_assignment" } });
  const window = resolveProfileDecision(decision, { userPolicy: { seatPolicy: "window" } });
  const unspecified = resolveProfileDecision(decision, { userPolicy: {} });
  assert.equal(random.preferredControlId, "skip");
  assert.equal(window.preferredControlId, "continue");
  assert.equal(unspecified.match, "ambiguous");

  const state = reduceTaskState({
    observation: { observationId: "obs_kiwi_seat_confirmation", page },
    userPolicy: { seatPolicy: "random_assignment" },
    traveler: { booking_rules: "No paid seats" }
  });
  assert.equal(state.currentGoal.semanticType, "seat_selection");
  assert.deepEqual(state.currentGoal.policyAllowedControlIds, ["skip"]);
});

test("unowned selection CTAs fail semantic readiness instead of becoming navigation", () => {
  const page = kiwiFailurePage();
  page.controls = [page.controls[0]];
  const compiled = agentContract.compileSemanticCheckout(page);
  assert.equal(compiled.semanticReadiness, "unresolved");
  assert.equal(compiled.unownedMaterialControls[0].reason, "UNOWNED_SELECTION_CTA");
});

test("phone country-code choice compatibility tolerates repeated accessible labels", () => {
  assert.equal(agentContract.profileChoiceValueCompatible(
    "Slovenia (+386) Slovenia (+386)",
    "+386",
    "phone_country_code"
  ), true);
  assert.equal(agentContract.profileChoiceValueCompatible(
    "Türkiye (+90)",
    "+386",
    "phone_country_code"
  ), false);
});

test("payment-method choice follows the selected profile and is not completion", () => {
  const decision = {
    decisionGroupId: "payment-method",
    subject: { key: "payment_method" },
    required: true,
    material: true,
    alternatives: [
      { controlId: "card", label: "Credit or debit card", semantic: "payment_method", executable: true },
      { controlId: "wallet", label: "Apple Pay / Google Pay", semantic: "payment_method", executable: true }
    ]
  };

  const card = resolveProfileDecision(decision, {
    traveler: { payment_preference: "browser saved card" }
  });
  const wallet = resolveProfileDecision(decision, {
    traveler: { payment_preference: "Apple Pay / Google Pay" }
  });

  assert.equal(card.preferredControlId, "card");
  assert.equal(wallet.preferredControlId, "wallet");
});

test("equivalent card-network reveal tiles resolve to one bounded card-entry route", () => {
  const decision = {
    decisionGroupId: "payment-method-tiles",
    subject: { key: "payment_method" },
    required: true,
    material: true,
    alternatives: [
      { controlId: "amex", label: "American Express", semantic: "payment_method", physicalEffect: "reveal_control", executable: true },
      { controlId: "visa", label: "Visa", semantic: "payment_method", physicalEffect: "reveal_control", executable: true },
      { controlId: "mastercard", label: "Mastercard", semantic: "payment_method", physicalEffect: "reveal_control", executable: true },
      { controlId: "wallet", label: "KEKS Pay", semantic: "payment_method", physicalEffect: "reveal_control", executable: true }
    ]
  };

  const resolution = resolveProfileDecision(decision, {
    traveler: { payment_preference: "manual payment" }
  });

  assert.equal(resolution.match, "exact");
  assert.equal(resolution.preferredControlId, "amex");
  assert.deepEqual(resolution.eligibleOptionIds, ["amex", "visa", "mastercard"]);
});
