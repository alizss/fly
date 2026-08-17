const test = require("node:test");
const assert = require("node:assert/strict");

const {
  verifiedCommerceObligationFromActionResult,
  verifiedProfileComponentFromActionResult
} = require("../../apps/web/agent/task-state-reducer");
const { reduceTaskState } = require("./task-state-replay-adapter");
const { actionForCurrentCandidate, buildCurrentCandidateSet } = require("./legacy-mechanics-binding-adapter");
const { __private: governorPrivate } = require("../../apps/web/agent/action-governor");
const { __private: loopPrivate } = require("../../apps/web/agent/loop");

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
    semanticType: options.semanticType || "",
    semanticIntent: options.semanticIntent || "",
    semanticEffect: options.semanticEffect || "",
    interactionRole: options.interactionRole || "",
    physicalEffect: options.physicalEffect || "",
    mechanicalEffect: options.mechanicalEffect || "",
    risk: options.risk || "safe",
    structuredPrice: options.structuredPrice || null,
    kind: options.kind || "button",
    role: options.role || "button",
    inputType: options.inputType || "",
    selected: options.selected === true,
    state: options.state || undefined,
    stateElementId: `${controlId}_node`,
    preferredActivationElementId: `${controlId}_node`,
    operations: { activate: capability("activate", `${controlId}_node`) }
  };
}

function disabledNavigation(controlId = "continue", options = {}) {
  const nodeId = `${controlId}_node`;
  const actionability = {
    rendered: true,
    visible: true,
    enabled: false,
    inViewport: options.inViewport === true,
    inCurrentSurface: true,
    hitTested: false,
    notOccluded: false,
    targetable: false,
    operationAuthorized: true,
    operationProven: true,
    executable: false,
    revealable: false,
    code: "ACTUATOR_DISABLED",
    operation: "activate"
  };
  return {
    ...control(controlId, {
      label: options.label || "Continue",
      semantic: "continue",
      risk: "safe_continue"
    }),
    state: { disabled: true, valuePresent: true, normalizedValue: "continue" },
    visualRegion: {
      x: 100,
      y: options.inViewport === true ? 500 : 1800,
      width: 140,
      height: 48,
      inViewport: options.inViewport === true
    },
    operations: {
      activate: {
        operation: "activate",
        actuatorId: nodeId,
        actuatorIds: [nodeId],
        actionability,
        strategies: [{
          operation: "activate",
          actuatorId: nodeId,
          method: "native_click",
          actionType: "click",
          status: "unavailable",
          actionability
        }]
      }
    }
  };
}

test("placeholder selects remain empty and disabled navigation identifies the sole missing traveler datum", () => {
  const nationality = {
    ...control("nationality", {
      label: "Nationality",
      semantic: "nationality",
      kind: "select",
      role: "combobox"
    }),
    fieldType: "nationality",
    currentValue: "Select",
    state: {
      disabled: false,
      required: false,
      valuePresent: true,
      valueText: "Select",
      normalizedValue: "select",
      selectedValue: ""
    }
  };
  const observation = {
    observationId: "obs_disabled_continue_missing_nationality",
    page: {
      url: "https://example.test/checkout/traveler",
      step: "traveler_information",
      currentSurface: { id: "surface-page", type: "page" },
      controls: [nationality, disabledNavigation()],
      fields: [{
        controlId: "nationality",
        field: "nationality",
        fieldType: "nationality",
        label: "Nationality",
        kind: "select",
        role: "combobox",
        value: "Select",
        hasValue: true,
        required: false
      }],
      decisionGroups: [],
      validationIssues: []
    }
  };

  const state = reduceTaskState({
    observation,
    traveler: { first_name: "Ali", last_name: "Sifrar" }
  });

  const canonicalNationality = state.canonicalDecisions.find((decision) => (
    decision.decisionId === "control:nationality"
  ));
  assert.equal(canonicalNationality.currentState.empty, true);
  assert.equal(canonicalNationality.currentState.canonicalValue, null);
  assert.equal(state.profileReadiness.ready, false);
  assert.deepEqual(
    state.profileReadiness.missingUserData.map((item) => item.semanticType),
    ["nationality"]
  );
  assert.equal(
    state.profileReadiness.missingUserData[0].inferredFrom,
    "disabled_navigation_unresolved_profile_fields"
  );
  assert.equal(state.currentGoal, null);
});

test("a Turkish-shaped phone-code opener keeps surface continuity when child options repeat the profile semantic", () => {
  const surfaceId = "surface-country-options";
  const countryField = {
    ...control("country_code", {
      label: "Country code",
      semantic: "phone_country_code",
      kind: "select",
      role: "combobox"
    }),
    fieldType: "phone_country_code",
    required: true,
    state: { disabled: false, required: true, valuePresent: false, normalizedValue: "" }
  };
  const slovenia = control("option_slovenia", {
    surfaceId,
    surfaceType: "portal",
    label: "Slovenia (+386)",
    semantic: "phone_country_code",
    kind: "option",
    role: "option",
    risk: "safe"
  });
  const turkey = control("option_turkey", {
    surfaceId,
    surfaceType: "portal",
    label: "Türkiye (+90)",
    semantic: "phone_country_code",
    kind: "option",
    role: "option",
    risk: "safe"
  });
  const paid = control("option_paid", {
    surfaceId,
    surfaceType: "portal",
    label: "Premium calling support +12 EUR",
    semantic: "select_paid_option",
    physicalEffect: "select_paid_option",
    kind: "option",
    role: "option",
    risk: "money",
    structuredPrice: { amount: 12, currency: "EUR" }
  });
  const observation = {
    observationId: "obs_country_options_open",
    page: {
      url: "https://example.test/checkout/traveler",
      step: "traveler_information",
      currentSurface: {
        id: surfaceId,
        type: "portal",
        label: "Country phone code",
        memberControlIds: [slovenia.controlId, turkey.controlId, paid.controlId]
      },
      foreground: {
        id: surfaceId,
        type: "portal",
        label: "Country phone code",
        memberControlIds: [slovenia.controlId, turkey.controlId, paid.controlId]
      },
      controls: [countryField, slovenia, turkey, paid],
      fields: [{
        controlId: countryField.controlId,
        field: "phone_country_code",
        fieldType: "phone_country_code",
        label: "Country code",
        kind: "select",
        role: "combobox",
        value: "",
        hasValue: false,
        required: true
      }],
      decisionGroups: [],
      validationIssues: []
    }
  };
  const previousGoal = {
    kind: "profile_field",
    goalId: "profile:phone_country_code",
    semanticGoal: "Set country code to +386",
    semanticType: "phone_country_code",
    desiredValue: "+386",
    canonicalValue: "+386",
    logicalFieldId: "traveler.phone_country_code",
    componentRole: "country_code",
    postcondition: { type: "logical_component_committed", expectedCanonicalValue: "+386" }
  };
  const actionResult = {
    dispatched: true,
    verified: true,
    expectedOutcomeObserved: true,
    postconditionSatisfied: true,
    expectedOutcome: { type: "options_surface_appeared", controlId: countryField.controlId },
    action: {
      goalId: previousGoal.goalId,
      operation: "open",
      mechanicalEffect: "open_surface",
      controlId: countryField.controlId
    }
  };
  const traveler = { phone_country_code: "+386" };
  const state = reduceTaskState({
    previousTaskState: { currentGoal: previousGoal },
    observation,
    previousActionResult: actionResult,
    traveler
  });

  assert.equal(state.currentGoal.kind, "adaptive_surface");
  assert.equal(state.currentGoal.sourceGoalId, previousGoal.goalId);
  assert.equal(state.currentGoal.adaptiveEnvelope.surfaceId, surfaceId);
  assert.equal(state.currentGoal.adaptiveEnvelope.remainingSteps, 6);
  assert.deepEqual(state.currentGoal.adaptiveEnvelope.forbiddenRisks, ["money", "payment", "legal"]);

  const candidateSet = buildCurrentCandidateSet({
    goal: state.currentGoal,
    observation,
    traveler,
    state: { taskState: state, approvals: {} }
  });
  const candidates = candidateSet.candidates;
  assert.equal(candidates[0].controlId, slovenia.controlId);
  assert.deepEqual(new Set(candidates.map((candidate) => candidate.controlId)), new Set([slovenia.controlId]));
  assert.equal(candidates.some((candidate) => candidate.controlId === paid.controlId), false);

  const revealActionability = {
    ...slovenia.operations.activate.actionability,
    inViewport: false,
    hitTested: false,
    notOccluded: false,
    targetable: false,
    executable: false,
    revealable: true,
    code: "ACTUATOR_OUT_OF_VIEW",
    box: { x: 20, y: 8344, width: 260, height: 36, inViewport: false }
  };
  const offscreenSlovenia = {
    ...slovenia,
    visualRegion: revealActionability.box,
    operations: {
      activate: {
        ...slovenia.operations.activate,
        actionability: revealActionability,
        actionabilityByActuator: {
          [`${slovenia.controlId}_node`]: revealActionability
        }
      }
    }
  };
  const numericCollision = control("option_numeric_collision", {
    surfaceId,
    surfaceType: "portal",
    label: "Saint Kitts and Nevis (+869) country-option-193",
    semantic: "choice",
    kind: "option",
    role: "option",
    risk: "safe"
  });
  const offscreenObservation = {
    ...observation,
    observationId: "obs_country_options_exact_offscreen",
    page: {
      ...observation.page,
      currentSurface: {
        ...observation.page.currentSurface,
        memberControlIds: [offscreenSlovenia.controlId, turkey.controlId, numericCollision.controlId, paid.controlId]
      },
      foreground: {
        ...observation.page.foreground,
        memberControlIds: [offscreenSlovenia.controlId, turkey.controlId, numericCollision.controlId, paid.controlId]
      },
      controls: [countryField, offscreenSlovenia, turkey, numericCollision, paid]
    }
  };
  const offscreenSet = buildCurrentCandidateSet({
    goal: state.currentGoal,
    observation: offscreenObservation,
    traveler,
    state: { taskState: state, approvals: {} }
  });
  assert.deepEqual(offscreenSet.candidates, []);
  assert.equal(offscreenSet.recoveryCandidates.length, 1);
  assert.equal(offscreenSet.recoveryCandidates[0].controlId, offscreenSlovenia.controlId);
  assert.equal(offscreenSet.recoveryCandidates[0].executionChannel, "reveal");
  assert.equal(offscreenSet.recoveryCandidates[0].requiresJudgment, false);
  assert.equal(offscreenSet.contextCapabilities.find((candidate) => candidate.controlId === turkey.controlId).selectable, false);
  assert.equal(offscreenSet.contextCapabilities.find((candidate) => candidate.controlId === numericCollision.controlId).selectable, false);

  const filter = control("country_filter", {
    surfaceId,
    surfaceType: "portal",
    label: "Search country code",
    semantic: "unknown",
    kind: "text",
    role: "editable_combobox",
    risk: "safe"
  });
  filter.operations = {
    type: capability("type", `${filter.controlId}_node`)
  };
  const filterObservation = {
    ...offscreenObservation,
    observationId: "obs_country_options_with_owned_filter",
    page: {
      ...offscreenObservation.page,
      currentSurface: {
        ...offscreenObservation.page.currentSurface,
        memberControlIds: [...offscreenObservation.page.currentSurface.memberControlIds, filter.controlId]
      },
      controls: [...offscreenObservation.page.controls, filter]
    }
  };
  const filteredSet = buildCurrentCandidateSet({
    goal: state.currentGoal,
    observation: filterObservation,
    traveler,
    state: { taskState: state, approvals: {} }
  });
  assert.equal(filteredSet.candidates.length, 1, JSON.stringify({
    candidates: filteredSet.candidates,
    recovery: filteredSet.recoveryCandidates,
    context: filteredSet.contextCapabilities
  }, null, 2));
  assert.equal(filteredSet.candidates[0].controlId, filter.controlId);
  assert.equal(filteredSet.candidates[0].operation, "type");
  assert.equal(filteredSet.candidates[0].value, "386");
  assert.equal(filteredSet.candidates[0].physicalEffect, "filter_options");
  assert.equal(filteredSet.candidates[0].expectedOutcome.type, "semantic_progress");
  assert.equal(filteredSet.candidates[0].expectedOutcome.canonicalTarget, "+386");
  assert.equal(filteredSet.candidates[0].requiresJudgment, false);
  assert.equal(filteredSet.recoveryCandidates.length, 0);

  // Exercise the production seam that failed live: candidate construction
  // -> target binding -> shared action normalization -> adaptive governance.
  // The normalized action deliberately has no duplicate top-level surfaceId;
  // its canonical target snapshot must retain exact surface ownership.
  const boundRecovery = loopPrivate.bindTargetSnapshot(
    actionForCurrentCandidate(state.currentGoal, offscreenSet.recoveryCandidates[0], offscreenObservation),
    offscreenObservation
  );
  assert.equal(boundRecovery.surfaceId, undefined);
  assert.equal(boundRecovery.targetSnapshot.surfaceId, surfaceId);
  const adaptiveChecks = [];
  assert.equal(
    governorPrivate.adaptiveEnvelopeFailure(boundRecovery, { taskState: state }, offscreenObservation, adaptiveChecks),
    null
  );
  assert.equal(adaptiveChecks.at(-1).code, "ADAPTIVE_ENVELOPE_VALID");
  assert.equal(
    governorPrivate.validateCanonicalTarget(boundRecovery, offscreenObservation, []).code,
    "TARGET_OUT_OF_VIEW"
  );

  const continued = reduceTaskState({
    previousTaskState: state,
    observation: { ...observation, observationId: "obs_country_options_filtered" },
    previousActionResult: {
      dispatched: true,
      verified: true,
      expectedOutcomeObserved: true,
      postconditionSatisfied: true,
      action: { goalId: state.currentGoal.goalId, operation: "type", value: "386" },
      expectedOutcome: { type: "semantic_progress" }
    },
    traveler
  });
  assert.equal(continued.currentGoal.kind, "adaptive_surface");
  assert.equal(continued.currentGoal.adaptiveEnvelope.remainingSteps, 5);
  assert.deepEqual(continued.currentGoal.adaptiveEnvelope.queryHistory, ["386"]);
});

test("a GoToGate-shaped editable country code keeps its obligation when typing reveals the exact option", () => {
  const surfaceId = "surface-country-code-listbox";
  const countryCode = {
    ...control("country_code_editable", {
      label: "Country code",
      semantic: "phone_country_code",
      kind: "select",
      role: "editable_combobox"
    }),
    fieldType: "phone_country_code",
    state: {
      disabled: false,
      required: false,
      valuePresent: true,
      normalizedValue: "+386",
      valueText: "+386",
      expanded: true,
      selected: false
    },
    operations: { type: capability("type", "country_code_editable_node") }
  };
  const slovenia = {
    ...control("country_code_slovenia", {
      surfaceId,
      surfaceType: "dropdown",
      label: "Slovenia (+386)",
      semantic: "choice",
      kind: "option",
      role: "option"
    }),
    state: {
      disabled: false,
      required: false,
      valuePresent: false,
      optionValue: "slovenia (+386)",
      selected: false
    },
    operations: { choose: capability("choose", "country_code_slovenia_node") }
  };
  const observation = {
    observationId: "obs_gotogate_country_code_filtered",
    page: {
      url: "https://example.test/checkout/traveler",
      step: "traveler_information",
      currentSurface: {
        id: surfaceId,
        type: "dropdown",
        label: "Slovenia (+386)",
        memberControlIds: [slovenia.controlId]
      },
      foreground: {
        id: surfaceId,
        type: "dropdown",
        label: "Slovenia (+386)",
        memberControlIds: [slovenia.controlId]
      },
      controls: [countryCode, slovenia],
      fields: [{
        controlId: countryCode.controlId,
        field: "phone_country_code",
        fieldType: "phone_country_code",
        label: "Country code",
        kind: "select",
        role: "editable_combobox",
        value: "+386",
        hasValue: true,
        required: false
      }],
      decisionGroups: [],
      validationIssues: []
    }
  };
  const previousGoal = {
    kind: "profile_field",
    goalId: "profile:phone_country_code:gotogate",
    semanticGoal: "Set country code to +386",
    semanticType: "phone_country_code",
    desiredValue: "+386",
    canonicalValue: "+386",
    logicalFieldId: "traveler.phone_country_code",
    subjectId: "traveler_1",
    controlId: countryCode.controlId,
    componentRole: "country_code",
    componentBinding: { controlId: countryCode.controlId },
    postcondition: { type: "logical_component_committed", expectedCanonicalValue: "+386" }
  };
  const actionResult = {
    dispatched: true,
    verified: true,
    expectedOutcomeObserved: true,
    postconditionSatisfied: true,
    // Production compaction keeps goalId on the receipt, not on the nested
    // mechanical action. This exact shape regressed the live GoToGate run.
    goalId: previousGoal.goalId,
    expectedOutcome: {
      type: "semantic_progress",
      controlId: countryCode.controlId,
      semanticType: "phone_country_code",
      componentRole: "country_code",
      expectedNormalizedValue: "+386",
      interactionKind: "editable_combobox",
      commitRequirement: "logical_component_committed"
    },
    action: {
      operation: "type",
      controlId: countryCode.controlId,
      value: "+386"
    }
  };
  const traveler = { phone_country_code: "+386" };

  const closedCountryCode = {
    ...countryCode,
    state: {
      ...countryCode.state,
      normalizedValue: "+441481",
      valueText: "+44-1481",
      expanded: false
    }
  };
  const closedObservation = {
    observationId: "obs_gotogate_country_code_closed",
    page: {
      ...observation.page,
      currentSurface: { id: "surface-page", type: "page", memberControlIds: [countryCode.controlId] },
      foreground: null,
      controls: [closedCountryCode],
      fields: [{
        ...observation.page.fields[0],
        value: "+44-1481",
        hasValue: true,
        state: closedCountryCode.state,
        controlState: closedCountryCode.state
      }]
    }
  };
  const initialCandidates = buildCurrentCandidateSet({
    goal: previousGoal,
    observation: closedObservation,
    traveler
  });
  const typedQuery = initialCandidates.candidates.find((candidate) => candidate.operation === "type");
  assert.ok(typedQuery, JSON.stringify(initialCandidates, null, 2));
  assert.equal(typedQuery.expectedOutcome.type, "semantic_progress");
  assert.equal(typedQuery.expectedOutcome.interactionKind, "editable_combobox");
  assert.equal(typedQuery.expectedOutcome.commitRequirement, "logical_component_committed");

  const state = reduceTaskState({
    previousTaskState: { currentGoal: previousGoal },
    observation,
    previousActionResult: actionResult,
    traveler
  });

  assert.equal(state.currentGoal.kind, "adaptive_surface");
  assert.equal(state.currentGoal.sourceGoalId, previousGoal.goalId);
  assert.equal(state.currentGoal.adaptiveEnvelope.surfaceId, surfaceId);

  const candidateSet = buildCurrentCandidateSet({
    goal: state.currentGoal,
    observation,
    traveler,
    state: { taskState: state, approvals: {} }
  });
  assert.equal(candidateSet.candidates.length, 1, JSON.stringify(candidateSet, null, 2));
  assert.equal(candidateSet.candidates[0].controlId, slovenia.controlId);
  assert.equal(candidateSet.candidates[0].operation, "choose");
});

test("an admitted profile obligation chooses direct mechanics without a model arbitration turn", () => {
  const selected = loopPrivate.deterministicTaskCandidate({
    candidates: [
      {
        candidateId: "country_keyboard",
        operation: "keyboard",
        risk: "uncertain",
        physicalEffect: "set_field_value",
        requiresJudgment: true,
        requiresApproval: false
      },
      {
        candidateId: "country_type",
        operation: "type",
        risk: "uncertain",
        physicalEffect: "set_field_value",
        requiresJudgment: true,
        requiresApproval: false
      }
    ]
  }, { kind: "profile_field" });

  assert.equal(selected?.candidateId, "country_type");
});

test("disabled navigation queues multiple missing traveler facts instead of abandoning the form", () => {
  const blankField = (controlId, semantic, label) => ({
    ...control(controlId, { label, semantic, kind: "select", role: "combobox" }),
    fieldType: semantic,
    currentValue: "Select",
    state: {
      disabled: false,
      required: false,
      valuePresent: true,
      valueText: "Select",
      normalizedValue: "select",
      selectedValue: ""
    }
  });
  const nationality = blankField("nationality_multi", "nationality", "Nationality");
  const issuingCountry = blankField("issuing_country_multi", "issuing_country", "Issuing country");
  const observation = {
    observationId: "obs_disabled_continue_multiple_missing",
    page: {
      url: "https://example.test/checkout/traveler",
      step: "traveler_information",
      currentSurface: { id: "surface-page", type: "page" },
      controls: [nationality, issuingCountry, disabledNavigation()],
      fields: [nationality, issuingCountry].map((item) => ({
        controlId: item.controlId,
        field: item.fieldType,
        fieldType: item.fieldType,
        label: item.label,
        kind: item.kind,
        role: item.role,
        value: "Select",
        hasValue: true,
        required: false
      })),
      decisionGroups: [],
      validationIssues: []
    }
  };

  const state = reduceTaskState({
    observation,
    traveler: { first_name: "Ali", last_name: "Sifrar" }
  });

  assert.deepEqual(
    state.profileReadiness.missingUserData.map((item) => item.semanticType),
    ["nationality", "issuing_country"]
  );
  assert.equal(state.profileReadiness.blockedReasonCode, "MISSING_PROFILE_DATA");
});

test("unavailable navigation does not become a semantic goal when no profile field owns the blocker", () => {
  const firstName = {
    ...control("first_name", {
      label: "First name",
      semantic: "first_name",
      kind: "text",
      role: "textbox"
    }),
    fieldType: "first_name",
    currentValue: "Ali",
    state: { disabled: false, valuePresent: true, normalizedValue: "ali" }
  };
  const observation = {
    observationId: "obs_disabled_continue_diagnostic",
    page: {
      url: "https://example.test/checkout/traveler",
      step: "traveler_information",
      currentSurface: { id: "surface-page", type: "page" },
      controls: [firstName, disabledNavigation("continue", { inViewport: false })],
      fields: [{
        controlId: "first_name",
        field: "first_name",
        fieldType: "first_name",
        label: "First name",
        value: "Ali",
        hasValue: true,
        required: true
      }],
      stageExit: {
        continueObserved: true,
        candidates: [{ controlId: "continue", actuatorId: "continue_node", status: "disabled", executable: false }],
        continueDisabled: true,
        continueInViewport: false,
        blockers: []
      },
      decisionGroups: [],
      validationIssues: []
    }
  };

  const state = reduceTaskState({
    observation,
    traveler: { first_name: "Ali" }
  });

  assert.equal(state.profileReadiness.ready, true);
  assert.equal(state.currentGoal, null);
  assert.equal(state.ambiguityReason, "navigation_disabled_without_active_requirement");
});

test("the observed stage exit is scheduled even when its button wording is unfamiliar", () => {
  const forward = control("opaque_forward_action", {
    label: "Go",
    semantic: "command",
    risk: "safe"
  });
  const observation = {
    observationId: "obs_explicit_stage_exit",
    page: {
      url: "https://example.test/checkout/traveler",
      step: "traveler_information",
      currentSurface: { id: "surface-page", type: "page" },
      controls: [forward],
      fields: [],
      decisionGroups: [],
      validationIssues: [],
      stageExit: {
        continueAllowed: true,
        continueObserved: true,
        candidates: [{
          controlId: forward.controlId,
          actuatorId: forward.preferredActivationElementId,
          status: "ready",
          executable: true
        }],
        continueDisabled: false,
        blockers: []
      }
    }
  };

  const state = reduceTaskState({ observation });

  assert.equal(state.currentGoal.semanticType, "navigation");
  assert.deepEqual(state.currentGoal.actionableControlIds, [forward.controlId]);
});

test("standalone canonical requirements participate in authoritative scheduling", () => {
  const requiredChoice = {
    ...control("meal_preference", {
      label: "Meal preference",
      semantic: "meal_preference",
      kind: "select",
      role: "combobox"
    }),
    required: true,
    fieldType: "meal_preference",
    currentValue: "Select",
    state: {
      disabled: false,
      required: true,
      valuePresent: true,
      valueText: "Select",
      normalizedValue: "select",
      selectedValue: ""
    },
    options: [{ value: "standard meal", label: "Standard meal" }],
    operations: {
      select: capability("select", "meal_preference_node")
    }
  };
  const state = reduceTaskState({
    observation: {
      observationId: "obs_standalone_canonical_requirement",
      page: {
        step: "traveler_information",
        heading: "Traveler information",
        currentSurface: { id: "surface-page", type: "page" },
        controls: [requiredChoice],
        decisionGroups: [],
        validationIssues: []
      }
    },
    traveler: { meal_preference: "standard meal" }
  });

  assert.equal(state.canonicalDecisions[0].status, "active");
  assert.equal(state.activeDecisions[0].decisionId, "control:meal_preference");
  assert.equal(state.currentGoal.semanticType, "meal_preference");
});

test("canonical decisions keep baggage quantity and baggage protection as exact independent subjects", () => {
  const oneBag = control("checked_bag_one", {
    decisionGroupId: "checked_baggage_quantity",
    label: "One checked bag",
    kind: "radio",
    role: "radio",
    selected: true,
    state: { selected: true, checked: true }
  });
  const twoBags = control("checked_bag_two", {
    decisionGroupId: "checked_baggage_quantity",
    label: "Two checked bags",
    kind: "radio",
    role: "radio",
    structuredPrice: { amount: 30, currency: "EUR" },
    risk: "money"
  });
  const protection = control("lost_baggage_protection", {
    decisionGroupId: "baggage_protection",
    label: "Protect my checked baggage",
    kind: "checkbox",
    role: "checkbox",
    structuredPrice: { amount: 12, currency: "EUR" },
    risk: "money",
    state: { checked: false, selected: false }
  });
  const observation = {
    observationId: "obs_exact_baggage_subjects",
    page: {
      currentSurface: { id: "surface-page", type: "page" },
      controls: [
        oneBag,
        twoBags,
        protection,
        control("continue", { label: "Continue", semantic: "continue", risk: "safe_continue" })
      ],
      decisionGroups: [
        {
          decisionGroupId: "checked_baggage_quantity",
          requirementId: "baggage:checked-quantity",
          sectionType: "baggage",
          sectionLabel: "Checked baggage",
          required: true,
          status: "satisfied",
          selectedControlId: "checked_bag_one",
          alternatives: [
            { controlId: "checked_bag_one", label: "One checked bag", selected: true },
            { controlId: "checked_bag_two", label: "Two checked bags" }
          ]
        },
        {
          decisionGroupId: "baggage_protection",
          requirementId: "baggage:lost-protection",
          sectionType: "baggage",
          sectionLabel: "Lost baggage protection",
          required: false,
          status: "optional",
          selectedControlId: "",
          alternatives: [{
            controlId: "lost_baggage_protection",
            label: "Protect my checked baggage",
            structuredPrice: { amount: 12, currency: "EUR" }
          }]
        }
      ],
      validationIssues: []
    }
  };

  const state = reduceTaskState({
    observation,
    traveler: {
      baggage_preference: "One checked bag",
      booking_rules: "No paid extras"
    }
  });
  const quantity = state.canonicalDecisions.find((decision) => decision.decisionGroupId === "checked_baggage_quantity");
  const protectionDecision = state.canonicalDecisions.find((decision) => decision.decisionGroupId === "baggage_protection");

  assert.equal(quantity.subject.key, "checked_baggage_quantity");
  assert.equal(quantity.controlType, "exclusive_choice");
  assert.equal(quantity.currentOutcome, "selected");
  assert.equal(quantity.userIntent.match, "exact");
  assert.equal(quantity.needsAction, false);
  assert.equal(quantity.status, "satisfied");

  assert.equal(protectionDecision.subject.key, "baggage_protection");
  assert.equal(protectionDecision.controlType, "optional_toggle");
  assert.equal(protectionDecision.currentOutcome, "declined");
  assert.equal(protectionDecision.userIntent.match, "constraint");
  assert.equal(protectionDecision.userIntent.source, "no_paid_extras");
  assert.equal(protectionDecision.needsAction, false);
  assert.equal(protectionDecision.status, "satisfied");
  assert.notDeepEqual(quantity.physicalControlIds, protectionDecision.physicalControlIds);
  assert.deepEqual(state.activeDecisions, []);
  assert.equal(state.currentGoal.semanticType, "navigation");
});

test("canonical decisions create a correction only for the exact selected paid subject", () => {
  const selectedProtection = control("lost_baggage_protection", {
    decisionGroupId: "baggage_protection",
    label: "Protect my checked baggage",
    kind: "checkbox",
    role: "checkbox",
    selected: true,
    structuredPrice: { amount: 12, currency: "EUR" },
    risk: "money",
    state: { checked: true, selected: true }
  });
  const removeProtection = control("remove_baggage_protection", {
    decisionGroupId: "baggage_protection",
    label: "Remove protection",
    semantic: "remove_paid_extra",
    risk: "safe_decline"
  });
  const state = reduceTaskState({
    observation: {
      observationId: "obs_selected_protection",
      page: {
        currentSurface: { id: "surface-page", type: "page" },
        controls: [selectedProtection, removeProtection],
        decisionGroups: [{
          decisionGroupId: "baggage_protection",
          requirementId: "baggage:lost-protection",
          sectionType: "baggage",
          sectionLabel: "Lost baggage protection",
          required: false,
          status: "satisfied",
          selectedControlId: "lost_baggage_protection",
          alternatives: [
            { controlId: "lost_baggage_protection", label: "Protect my checked baggage" },
            { controlId: "remove_baggage_protection", label: "Remove protection" }
          ]
        }],
        validationIssues: []
      }
    },
    traveler: {
      baggage_preference: "One checked bag",
      booking_rules: "No paid extras"
    }
  });

  assert.equal(state.observedDecisions[0].subject.key, "baggage_protection");
  assert.equal(state.observedDecisions[0].status, "conflicted");
  assert.equal(state.observedDecisions[0].needsAction, true);
  assert.equal(state.observedDecisions[0].actionReason, "selected_paid_option_conflicts_with_policy");
  assert.equal(state.currentGoal.decisionGroupId, "baggage_protection");
  assert.deepEqual(state.currentGoal.freeAlternativeControlIds, ["remove_baggage_protection"]);
});

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

  assert.equal(state.observedDecisions[0].status, "waived");
  assert.equal(state.observedDecisions[0].requiresResolution, false);
  assert.equal(state.activeDecisions.length, 0);
  assert.equal(state.currentGoal.semanticType, "navigation");
  assert.deepEqual(state.currentGoal.actionableControlIds, ["continue"]);
});

test("an actionable blank optional profile representation cannot outrank a ready stage exit", () => {
  const age = {
    ...control("age_at_departure_parent", {
      label: "Age at time of travel",
      semantic: "age_at_departure",
      kind: "select",
      role: "editable_combobox"
    }),
    fieldType: "age_at_departure",
    required: false,
    representationLifecycle: {
      status: "active_rendered",
      active: true,
      stateRendered: true,
      renderedMemberIds: ["age_at_departure_trigger"]
    },
    state: {
      valuePresent: false,
      selected: false,
      checked: false,
      required: false,
      invalid: false,
      normalizedValue: ""
    },
    operations: {
      open: capability("open", "age_at_departure_trigger")
    }
  };
  const forward = control("continue_after_passenger", {
    label: "Continue",
    semantic: "continue",
    risk: "safe_continue"
  });
  const observation = {
    observationId: "obs_live_easyjet_optional_age_ready_continue",
    observationSnapshot: { snapshotHash: "hash_live_easyjet_optional_age_ready_continue" },
    page: {
      url: "https://www.easyjet.com/en/buy/checkout",
      step: "traveler_information",
      heading: "Passenger details",
      currentSurface: { id: "surface-page", type: "page" },
      controls: [age, forward],
      fields: [{
        controlId: age.controlId,
        field: "age_at_departure",
        fieldType: "age_at_departure",
        label: age.label,
        kind: age.kind,
        role: age.role,
        required: false,
        hasValue: false,
        representationLifecycle: age.representationLifecycle,
        controlState: age.state
      }],
      decisionGroups: [{
        decisionGroupId: "passenger_age_at_time_of_travel",
        requirementId: "passenger:age_at_departure",
        surfaceId: "surface-page",
        surfaceType: "page",
        sectionType: "passenger",
        sectionLabel: "Age at time of travel",
        required: false,
        status: "optional",
        selectedControlId: "",
        alternatives: [{ controlId: age.controlId, label: age.label }]
      }],
      validationIssues: [],
      activeRequirementGrounding: {
        contractVersion: "active-component-semantic-grounding/v1",
        status: "unknown",
        reasonCode: "ACTIVE_REQUIREMENT_UNRESOLVED",
        candidateComponentIds: [age.controlId]
      },
      stageExit: {
        continueAllowed: true,
        continueObserved: true,
        continueDisabled: false,
        navigationState: "ready",
        blockers: [],
        candidates: [{
          controlId: forward.controlId,
          actuatorId: forward.preferredActivationElementId,
          status: "ready",
          executable: true
        }]
      }
    }
  };

  const state = reduceTaskState({
    previousTaskState: {
      terminalStatus: "active",
      currentGoal: {
        goalId: "profile:age_at_departure:0",
        kind: "profile_field",
        semanticType: "age_at_departure",
        desiredValue: "23",
        controlId: age.controlId
      }
    },
    observation,
    traveler: { id: "trav_1", date_of_birth: "2003-05-31" },
    transactionReview: readyTransactionReview()
  });

  assert.equal(state.observedDecisions[0].status, "waived");
  assert.equal(state.observedDecisions[0].requiresResolution, false);
  assert.equal(state.profileReadiness.ready, true, JSON.stringify(state.profileReadiness, null, 2));
  assert.equal(state.currentObligation.subject.semanticType, "navigation", JSON.stringify(state.currentObligation, null, 2));
  assert.equal(state.currentObligation.authority, "task_state");
  assert.deepEqual(state.currentObligation.admittedControlIds, [forward.controlId]);
});

test("a profile-resolved exclusive insurance choice is completed before real navigation", () => {
  const noInsurance = control("insurance_none", {
    decisionGroupId: "travel_insurance",
    label: "No insurance 0 EUR",
    semantic: "decline_paid_extra",
    risk: "safe_decline",
    structuredPrice: { amount: 0, currency: "EUR" }
  });
  const paidInsurance = control("insurance_plus", {
    decisionGroupId: "travel_insurance",
    label: "Travel Plus 40 EUR",
    semantic: "add_paid_extra",
    risk: "money",
    structuredPrice: { amount: 40, currency: "EUR" }
  });
  const observation = {
    observationId: "obs_optional_insurance_gate",
    observationSnapshot: { snapshotHash: "hash_optional_insurance_gate" },
    page: {
      url: "https://example.test/checkout/traveler",
      step: "traveler_information",
      currentSurface: { id: "surface-page", type: "page" },
      controls: [
        noInsurance,
        paidInsurance,
        control("continue", {
          label: "Continue",
          semantic: "continue",
          physicalEffect: "advance_checkout_stage",
          risk: "safe_continue"
        })
      ],
      decisionGroups: [{
        decisionGroupId: "travel_insurance",
        requirementId: "insurance:travel",
        surfaceId: "surface-page",
        surfaceType: "page",
        sectionType: "insurance",
        sectionLabel: "Travel insurance",
        required: false,
        status: "optional",
        selectedControlId: "",
        alternatives: [noInsurance, paidInsurance]
      }],
      validationIssues: []
    }
  };
  const traveler = { booking_rules: "No paid extras" };
  const state = reduceTaskState({ observation, traveler });
  const candidates = buildCurrentCandidateSet({
    goal: state.currentGoal,
    observation,
    traveler,
    state: { taskState: state, approvals: {} }
  });

  assert.equal(state.observedDecisions[0].status, "active");
  assert.equal(state.observedDecisions[0].actionReason, "blocking_surface_has_exact_safe_transition");
  assert.equal(state.currentGoal.decisionGroupId, "travel_insurance");
  assert.deepEqual(state.currentGoal.policyAllowedControlIds, ["insurance_none"]);
  assert.deepEqual(candidates.candidates.map((candidate) => candidate.controlId), ["insurance_none"]);
});

test("medical cancellation wording resolves as insurance and outranks paid marketing prose", () => {
  const noCancellation = control("no_medical_cancellation", {
    decisionGroupId: "medical_cancellation_choice",
    label: "No medical cancellation 0 TL — No thanks, I'll take the risk",
    semantic: "select_free_option",
    risk: "safe_decline",
    structuredPrice: { amount: 0, currency: "TRY" }
  });
  const paidCancellation = control("medical_cancellation", {
    decisionGroupId: "medical_cancellation_choice",
    label: "Medical cancellation 109.37 TL",
    semantic: "add_paid_extra",
    risk: "money",
    structuredPrice: { amount: 109.37, currency: "TRY" }
  });
  const lockPrice = control("lock_price", {
    label: "Lock price for 546.84 TL — pay the locked price when you're ready to finish your booking",
    semantic: "add_paid_extra",
    meaning: "add_paid_extra",
    physicalEffect: "select_paid_option",
    risk: "money",
    structuredPrice: { amount: 546.84, currency: "TRY" }
  });
  const observation = {
    observationId: "obs_medical_cancellation_gate",
    observationSnapshot: { snapshotHash: "hash_medical_cancellation_gate" },
    page: {
      url: "https://example.test/checkout/fare",
      step: "extras",
      currentSurface: { id: "surface-page", type: "page" },
      controls: [noCancellation, paidCancellation, lockPrice],
      decisionGroups: [{
        decisionGroupId: "medical_cancellation_choice",
        surfaceId: "surface-page",
        surfaceType: "page",
        sectionLabel: "Medical cancellation",
        required: false,
        status: "optional",
        selectedControlId: "",
        alternatives: [noCancellation, paidCancellation]
      }],
      validationIssues: []
    }
  };
  const traveler = { booking_rules: "No paid extras" };
  const state = reduceTaskState({ observation, traveler });
  const candidates = buildCurrentCandidateSet({
    goal: state.currentGoal,
    observation,
    traveler,
    state: { taskState: state, approvals: {} }
  });

  assert.equal(state.observedDecisions[0].subject.key, "travel_insurance");
  assert.equal(state.currentGoal.decisionGroupId, "medical_cancellation_choice");
  assert.deepEqual(candidates.candidates.map((candidate) => candidate.controlId), ["no_medical_cancellation"]);
  assert.equal(candidates.contextCapabilities.find((candidate) => candidate.controlId === "lock_price"), undefined);
});

test("marketing prose containing finish your booking is not navigation", () => {
  const observation = {
    observationId: "obs_marketing_finish_prose",
    page: {
      step: "extras",
      currentSurface: { id: "surface-page", type: "page" },
      controls: [control("lock_price_only", {
        label: "Lock this price and finish your booking later",
        semantic: "add_paid_extra",
        physicalEffect: "select_paid_option",
        risk: "money",
        structuredPrice: { amount: 25, currency: "EUR" }
      })],
      decisionGroups: [],
      validationIssues: []
    }
  };

  const state = reduceTaskState({ observation });

  assert.equal(state.currentGoal, null);
  assert.equal(state.ambiguityReason, "no_goal_relevant_candidate");
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

test("fresh policy-safe selection outranks a stale completed control id after rerender", () => {
  const decisionGroupId = "travel_insurance";
  const free = control("insurance_none_rerendered", {
    decisionGroupId,
    label: "No insurance",
    semantic: "decline_paid_extra",
    risk: "safe_decline",
    structuredPrice: { amount: 0, currency: "EUR" },
    selected: true
  });
  const paid = control("insurance_plus_rerendered", {
    decisionGroupId,
    label: "Travel Plus",
    semantic: "add_paid_extra",
    risk: "money",
    structuredPrice: { amount: 80, currency: "EUR" }
  });
  const observation = {
    observationId: "obs_insurance_safe_rerender",
    page: {
      currentSurface: { id: "surface-page", type: "page" },
      controls: [
        free,
        paid,
        control("continue", { label: "Continue", semantic: "continue", risk: "safe_continue" })
      ],
      decisionGroups: [{
        decisionGroupId,
        requirementId: "insurance:travel",
        surfaceId: "surface-page",
        surfaceType: "page",
        sectionType: "insurance",
        sectionLabel: "Travel insurance",
        required: true,
        status: "satisfied",
        selectedControlId: free.controlId,
        selectedEvidence: {
          selected: true,
          disposition: "free",
          selectedControlId: free.controlId,
          structuredPrice: { amount: 0, currency: "EUR" }
        },
        alternatives: [free, paid]
      }],
      validationIssues: []
    }
  };
  const state = reduceTaskState({
    previousTaskState: {
      completedOutcomes: [{
        decisionGroupId,
        requirementId: "insurance:travel",
        surfaceId: "surface-page",
        status: "satisfied",
        selectedControlId: "insurance_none_before_rerender"
      }]
    },
    observation,
    userPolicy: { bookingRules: "Decline all paid extras" }
  });

  assert.equal(state.observedDecisions[0].status, "satisfied");
  assert.equal(state.observedDecisions[0].reopenEvidence, null);
  assert.equal(state.completedOutcomes.find((outcome) => outcome.decisionGroupId === decisionGroupId).selectedControlId, free.controlId);
  assert.equal(state.activeDecisions.length, 0);
  assert.equal(state.currentGoal.semanticType, "navigation");
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
  assert.equal(candidates.contextCapabilities.find((candidate) => candidate.controlId === navigate.controlId), undefined);
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
  assert.deepEqual(state.currentGoal.actionableControlIds, ["remove_selected_item"]);
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
          family: "extras",
          subjectKey: "selected_item",
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
  assert.equal(candidates.contextCapabilities.find((candidate) => candidate.controlId === navigation.controlId), undefined);
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

  const seatsOnly = reduceTaskState({
    observation,
    userPolicy: { paidExtraAuthorizations: [{ authorizationId: "auth_bundle", decisionGroupId: "bundle_group" }] },
    traveler: { booking_rules: "No paid seats" }
  });
  assert.deepEqual(seatsOnly.activeDecisions.map((decision) => decision.decisionGroupId), ["seat_group"]);
  assert.equal(seatsOnly.observedDecisions.find((decision) => decision.decisionGroupId === "bundle_group").status, "satisfied");
  assert.deepEqual(seatsOnly.safetyRestrictions.declinePaidExtrasByFamily, {
    seat: true,
    baggage: false,
    insurance: false,
    extras: false
  });

  const bundlesOnly = reduceTaskState({
    observation,
    userPolicy: { paidExtraAuthorizations: [{ authorizationId: "auth_seat", decisionGroupId: "seat_group" }] },
    traveler: { booking_rules: "No bundles" }
  });
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
    transactionReview: readyTransactionReview(),
    observation: {
      observationId: "obs_payment",
      page: {
        step: "extras",
        url: "https://example.test/checkout/payment",
        text: "Payment details. Choose payment method. Total to pay 208 EUR.",
        currentSurface: { id: "surface-page", type: "page" },
        controls: [
          control("card", { semantic: "card_number" }),
          {
            ...control("pay", { label: "Pay", semantic: "submit_purchase" }),
            role: "button",
            kind: "button",
            accessibleName: "Pay secure booking e-mail confirmation",
            capabilities: ["activate"]
          }
        ],
        foreground: { progressMarkers: { payment: "current" } },
        decisionGroups: []
      }
    }
  });

  assert.equal(state.stage, "payment");
  assert.equal(state.terminalStatus, "payment_review_reached");
  assert.equal(state.currentGoal, null);
  assert.equal(state.profileReadiness.ready, true);
  assert.deepEqual(state.goal, { id: "reach_payment_review", status: "completed" });
  assert.equal(state.paymentEvidence.observed, true);
  assert.equal(state.paymentEvidence.signalCount >= 3, true);
  assert.equal(state.safetyRestrictions.paymentSubmissionRequiresApproval, true);
  assert.equal(state.safetyRestrictions.paymentCredentialsBlocked, true);
});

test("a confirmation-labeled final review latches from owned payment evidence", () => {
  const state = reduceTaskState({
    transactionReview: readyTransactionReview(),
    observation: {
      observationId: "obs_confirmation_payment_boundary",
      page: {
        step: "confirmation",
        url: "https://example.test/checkout?activeStep=4",
        currentSurface: { id: "surface-page", type: "page" },
        controls: [
          control("payment_method", { label: "payment-method-card", semantic: "payment_method", kind: "radio", role: "radio" }),
          control("pay", { label: "Pay 208 EUR", semantic: "submit_purchase" }),
          control("billing_name", { label: "Billing first name", semantic: "first_name", kind: "field", role: "textbox" })
        ],
        decisionGroups: []
      }
    }
  });

  assert.equal(state.paymentEvidence.boundaryObserved, true);
  assert.equal(state.terminalGoalLatch.locked, true);
  assert.equal(state.terminalStatus, "payment_review_reached");
  assert.equal(state.currentGoal, null);
  assert.equal(state.processAwareness.status, "goal_achieved");
  assert.equal(state.processAwareness.currentPosition.stage, "payment_review");
  assert.equal(state.processAwareness.finalOutcome.achieved, true);
  assert.equal(state.processAwareness.finalOutcome.transactionVerified, true);
});

test("final checkout with terms and a disabled pay-by-card control is payment review", () => {
  const state = reduceTaskState({
    transactionReview: readyTransactionReview(),
    observation: {
      observationId: "obs_final_terms_review",
      page: {
        step: "seats",
        url: "https://example.test/en/buy/checkout",
        currentSurface: { id: "surface-page", type: "page" },
        terminalStructure: {
          legalAcceptancePresent: true,
          reviewSummaryPresent: true,
          payControlPresent: true,
          paymentMethodPresent: true
        },
        controls: [
          {
            ...control("dormant_first_name", { label: "First name", semantic: "first_name", kind: "field", role: "textbox" }),
            representationLifecycle: { status: "dormant_hidden", active: false }
          },
          control("terms", {
            label: "I confirm I have read and accepted the terms and conditions",
            semantic: "legal_acceptance",
            kind: "checkbox",
            role: "checkbox"
          }),
          {
            ...control("pay_by_card", { label: "Pay by card", semantic: "submit_purchase", kind: "button", role: "button" }),
            disabled: true,
            state: { disabled: true }
          }
        ],
        decisionGroups: []
      }
    }
  });

  assert.equal(state.stage, "payment");
  assert.equal(state.paymentEvidence.boundaryObserved, true);
  assert.equal(state.terminalStatus, "payment_review_reached");
  assert.equal(state.currentGoal, null);
});

test("an unverified final review freezes payment and billing work without claiming success", () => {
  const current = readyTransactionReview().current;
  const state = reduceTaskState({
    transactionReview: {
      ready: false,
      baselineStatus: "approved",
      current,
      missingFacts: ["itinerary_route"],
      contradictions: [],
      unauthorizedPaidExtras: []
    },
    observation: {
      observationId: "obs_confirmation_payment_blocked",
      page: {
        step: "confirmation",
        url: "https://example.test/checkout?activeStep=4",
        transactionFacts: current,
        currentSurface: { id: "surface-page", type: "page" },
        controls: [
          control("payment_method_blocked", { label: "payment-method-card", semantic: "payment_method", kind: "radio", role: "radio" }),
          control("pay_blocked", { label: "Pay 208 EUR", semantic: "submit_purchase" }),
          control("billing_blocked", { label: "Billing address", semantic: "billing_address", kind: "field", role: "textbox" })
        ],
        decisionGroups: []
      }
    }
  });

  assert.equal(state.paymentEvidence.boundaryObserved, true);
  assert.equal(state.terminalGoalLatch.locked, false);
  assert.equal(state.terminalStatus, "active");
  assert.equal(state.currentGoal, null);
  assert.equal(state.ambiguityReason, "transaction_review_incomplete");
  assert.equal(state.processAwareness.status, "verifying_final_transaction");
  assert.equal(state.processAwareness.currentObjective, "verify the final transaction");
  assert.deepEqual(state.processAwareness.unresolved, ["transaction:itinerary_route"]);
  assert.equal(state.processAwareness.finalOutcome.achieved, false);
});

test("a lone card field outside review does not create a terminal boundary", () => {
  const state = reduceTaskState({
    transactionReview: readyTransactionReview(),
    observation: {
      observationId: "obs_hidden_card_on_seats",
      page: {
        step: "seats",
        url: "https://example.test/checkout/seats",
        currentSurface: { id: "surface-page", type: "page" },
        controls: [
          control("hidden_cvv", { label: "CVV", semantic: "card_cvc", kind: "field", role: "textbox" }),
          control("seat_continue", { label: "Continue", semantic: "continue", physicalEffect: "advance_checkout_stage" })
        ],
        decisionGroups: []
      }
    }
  });

  assert.equal(state.stage, "seats");
  assert.equal(state.paymentEvidence.boundaryObserved, false);
  assert.equal(state.terminalGoalLatch.locked, false);
  assert.notEqual(state.terminalStatus, "payment_review_reached");
});

test("payment UI alone does not complete checkout without a verified transaction envelope", () => {
  const state = reduceTaskState({
    transactionReview: {
      ready: false,
      baselineStatus: "collecting",
      missingFacts: ["itinerary.route", "travelers", "currency", "totalPrice"],
      contradictions: [],
      unauthorizedPaidExtras: []
    },
    observation: {
      observationId: "obs_unverified_payment",
      page: {
        url: "https://example.test/checkout/payment",
        text: "Payment details. Choose payment method.",
        currentSurface: { id: "surface-page", type: "page" },
        controls: [control("card_unverified", { semantic: "card_number" })],
        foreground: { progressMarkers: { payment: "current" } },
        decisionGroups: []
      }
    }
  });

  assert.equal(state.stage, "payment");
  assert.equal(state.terminalStatus, "active");
  assert.equal(state.currentGoal, null);
  assert.equal(state.paymentEvidence.observed, false);
  assert.equal(state.paymentEvidence.signalCount >= 2, true);
  assert.equal(state.paymentEvidence.transactionVerified, false);
  assert.deepEqual(state.paymentEvidence.missingTransactionFacts, ["itinerary.route", "travelers", "currency", "totalPrice"]);
});

test("verified payment completion remains latched after redirect to a new search page", () => {
  const payment = reduceTaskState({
    transactionReview: readyTransactionReview(),
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

test("unknown foreground publishes one bounded reversible goal and excludes consequential controls", () => {
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

  assert.equal(taskState.currentGoal.kind, "adaptive_interaction");
  assert.deepEqual(taskState.currentGoal.actionableControlIds, ["safe_close"]);
  assert.equal(taskState.ambiguityReason, "");
  const candidates = buildCurrentCandidateSet({
    goal: taskState.currentGoal,
    observation,
    state: { taskState },
    traveler: {}
  }).candidates;
  assert.deepEqual(candidates.map((candidate) => candidate.controlId), ["safe_close"]);
  assert.equal(candidates[0].localMechanicalPostcondition.type, "observable_change");
  assert.equal(candidates[0].obligationSuccessCondition.type, "observable_change");
  assert.equal(candidates.some((candidate) => candidate.controlId === "paid_upgrade"), false);
});

test("reversible utility controls do not become adaptive checkout progress", () => {
  const observation = {
    observationId: "obs_utility_only_shell",
    observationSnapshot: { snapshotHash: "hash_utility_only_shell" },
    page: {
      step: "traveler_information",
      currentSurface: { id: "surface-page", type: "page" },
      controls: [
        control("language", { label: "English", semantic: "unknown", risk: "safe" }),
        control("support", { label: "Support", semantic: "unknown", risk: "safe" })
      ],
      decisionGroups: []
    }
  };
  const taskState = reduceTaskState({ observation });
  assert.equal(taskState.currentGoal, null);
  assert.equal(taskState.ambiguityReason, "no_goal_relevant_candidate");
});

test("seat page without a decision group uses the consequence-gated fallback instead of stopping", () => {
  const randomAssignment = control("random_assignment", {
    label: "Choose seats for me",
    semantic: "required_dropdown_choice",
    physicalEffect: "select_free_option",
    risk: "safe_decline"
  });
  const manualSeats = control("manual_seats", {
    label: "Choose seats manually 18 EUR",
    semantic: "select_paid_seat",
    physicalEffect: "select_paid_option",
    risk: "money",
    structuredPrice: { amount: 18, currency: "EUR" }
  });
  const next = control("next_flight", {
    label: "Next flight",
    semantic: "continue",
    risk: "safe_continue",
    state: { disabled: true }
  });
  next.disabled = true;
  const observation = {
    observationId: "obs_easyjet_seat_shell",
    observationSnapshot: { snapshotHash: "hash_easyjet_seat_shell" },
    page: {
      step: "seats",
      currentSurface: {
        id: "surface-page",
        type: "page",
        label: "Seat selection",
        memberControlIds: [randomAssignment.controlId, manualSeats.controlId, next.controlId]
      },
      controls: [randomAssignment, manualSeats, next],
      decisionGroups: [],
      validationIssues: [],
      stageExit: {
        continueObserved: true,
        continueDisabled: true,
        candidates: [{ controlId: next.controlId, status: "disabled", executable: false }]
      }
    }
  };
  const traveler = { booking_rules: "No paid seats", seat_policy: "random_assignment" };
  const taskState = reduceTaskState({ observation, traveler, userPolicy: { bookingRules: traveler.booking_rules } });

  assert.equal(taskState.currentGoal.kind, "adaptive_interaction");
  assert.deepEqual(taskState.currentGoal.actionableControlIds, [randomAssignment.controlId]);
  const candidateSet = buildCurrentCandidateSet({
    goal: taskState.currentGoal,
    observation,
    state: { taskState },
    traveler
  });
  assert.deepEqual(candidateSet.candidates.map((candidate) => candidate.controlId), [randomAssignment.controlId]);
  assert.equal(candidateSet.candidates[0].mechanicalEffect, "select_free_option");
  assert.equal(candidateSet.candidates[0].expectedOutcome.type, "exact_free_option_selected");
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

  assert.deepEqual(candidateSet.contextCapabilities.map((candidate) => candidate.controlId), ["no_thanks"]);
  assert.equal(candidateSet.contextCapabilities.find((candidate) => candidate.controlId === "close_help"), undefined);
  assert.equal(candidateSet.contextCapabilities.find((candidate) => candidate.controlId === "paid_upgrade"), undefined);
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
  assert.equal(cabinState.currentObligation.contractVersion, "current-obligation/v2");
  assert.equal(cabinState.currentObligation.authority, "task_state");
  assert.equal(cabinState.currentObligation.surfaceId, "surface-page");
  assert.equal(cabinState.currentObligation.policyDecision.status, "admitted");
  assert.deepEqual(cabinState.currentGoal.candidateControlIds, ["cabin_none"]);
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
  assert.equal(continueState.currentGoal.semanticEffect, "advance_checkout_stage");
  assert.deepEqual(continueState.currentGoal.candidateControlIds, ["continue"]);
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
  assert.equal(candidates.contextCapabilities.find((candidate) => candidate.controlId === "traveler_row"), undefined);
  assert.equal(candidates.contextCapabilities.find((candidate) => candidate.controlId === "paid_seat_1e"), undefined);
});

test("one decision episode closes a selected parent dropdown after child confirmation without reselecting it", () => {
  const traveler = { booking_rules: "No paid extras" };
  const parentDecisionGroupId = "flexible_ticket";
  const freeOption = control("flex_none", {
    surfaceId: "flex_options",
    surfaceType: "dropdown",
    decisionGroupId: parentDecisionGroupId,
    label: "None of the passengers 0 EUR",
    semantic: "decline_paid_extra",
    physicalEffect: "select_free_option",
    risk: "safe_decline",
    structuredPrice: { amount: 0, currency: "EUR" },
    kind: "option",
    role: "option"
  });
  freeOption.operations = { choose: capability("choose", "flex_none_node") };
  const paidOption = control("flex_all", {
    surfaceId: "flex_options",
    surfaceType: "dropdown",
    decisionGroupId: parentDecisionGroupId,
    label: "All passengers 16 EUR",
    semantic: "add_paid_extra",
    physicalEffect: "select_paid_option",
    risk: "money",
    structuredPrice: { amount: 16, currency: "EUR" },
    kind: "option",
    role: "option"
  });
  paidOption.operations = { choose: capability("choose", "flex_all_node") };
  const parentGroup = (selected = false) => ({
    decisionGroupId: parentDecisionGroupId,
    requirementId: "extras:flexible_ticket",
    surfaceId: "flex_options",
    surfaceType: "dropdown",
    sectionType: "extras",
    sectionLabel: "Flexible Ticket",
    required: true,
    status: selected ? "satisfied" : "missing",
    selectedControlId: selected ? "flex_none" : "",
    selectedLabel: selected ? "None of the passengers 0 EUR" : "",
    selectedSemantic: selected ? "decline_paid_extra" : "",
    alternatives: [
      { ...freeOption, selected },
      { ...paidOption, selected: false }
    ]
  });
  const dropdownObservation = (id, selected = false) => ({
    observationId: id,
    observationSnapshot: { snapshotHash: `hash_${id}` },
    page: {
      step: "traveler_information",
      currentSurface: {
        id: "flex_options",
        type: "dropdown",
        surfaceClass: "choice_set",
        label: "All passengers 16 EUR None of the passengers 0 EUR",
        memberControlIds: ["flex_all", "flex_none"]
      },
      controls: [
        { ...freeOption, selected, state: { ...(freeOption.state || {}), selected } },
        paidOption,
        ...(selected ? [control("flex_opener", {
          surfaceId: "surface-page",
          decisionGroupId: parentDecisionGroupId,
          label: "None of the passengers",
          semantic: "required_dropdown_choice",
          risk: "safe_decline",
          state: { expanded: true, normalizedValue: "none of the passengers" }
        })] : [])
      ],
      decisionGroups: [parentGroup(selected)],
      validationIssues: []
    }
  });

  const parentState = reduceTaskState({
    observation: dropdownObservation("obs_flex_parent"),
    userPolicy: { bookingRules: traveler.booking_rules },
    traveler
  });
  assert.equal(parentState.currentGoal.decisionGroupId, parentDecisionGroupId);
  assert.equal(parentState.decisionEpisode.status, "active");

  const declineChild = control("flex_decline_confirm", {
    surfaceId: "flex_confirm",
    surfaceType: "popover",
    decisionGroupId: "flexible_ticket_confirmation",
    label: "I'll go without",
    semantic: "decline_paid_extra",
    physicalEffect: "dismiss_surface",
    risk: "safe_decline"
  });
  const childObservation = {
    observationId: "obs_flex_child",
    observationSnapshot: { snapshotHash: "hash_obs_flex_child" },
    page: {
      step: "traveler_information",
      currentSurface: {
        id: "flex_confirm",
        type: "popover",
        label: "Flexible Ticket confirmation",
        memberControlIds: ["flex_decline_confirm"]
      },
      controls: [declineChild],
      decisionGroups: [{
        decisionGroupId: "flexible_ticket_confirmation",
        requirementId: "extras:flexible_ticket_confirmation",
        surfaceId: "flex_confirm",
        surfaceType: "popover",
        sectionType: "extras",
        sectionLabel: "Flexible Ticket confirmation",
        required: true,
        status: "missing",
        selectedControlId: "",
        alternatives: [declineChild]
      }],
      validationIssues: []
    }
  };
  const childState = reduceTaskState({
    previousTaskState: parentState,
    observation: childObservation,
    previousActionResult: {
      dispatched: true,
      verified: false,
      feedback: { surfaceChanged: true },
      action: { decisionGroupId: parentDecisionGroupId, controlId: "flex_none" }
    },
    userPolicy: { bookingRules: traveler.booking_rules },
    traveler
  });
  assert.equal(childState.currentGoal.decisionGroupId, "flexible_ticket_confirmation");
  assert.equal(childState.currentGoal.parentDecisionGroupId, parentDecisionGroupId);
  assert.equal(childState.currentGoal.decisionEpisodeId, parentState.decisionEpisode.episodeId);

  const completedObservation = dropdownObservation("obs_flex_completed", true);
  const completedState = reduceTaskState({
    previousTaskState: childState,
    observation: completedObservation,
    previousActionResult: {
      dispatched: true,
      verified: true,
      expectedOutcomeObserved: true,
      postconditionSatisfied: true,
      action: {
        decisionGroupId: "flexible_ticket_confirmation",
        controlId: "flex_decline_confirm",
        affordance: {
          physicalEffect: "dismiss_surface",
          task: {
            decisionEpisodeId: childState.decisionEpisode.episodeId,
            decisionInstanceId: childState.decisionEpisode.decisionInstanceId,
            parentDecisionGroupId,
            decisionGroupId: "flexible_ticket_confirmation"
          }
        }
      }
    },
    userPolicy: { bookingRules: traveler.booking_rules },
    traveler
  });
  assert.equal(completedState.decisionEpisode.status, "completed_pending_surface_exit");
  assert.equal(completedState.outcomeJournal.length, 1);
  assert.equal(completedState.outcomeJournal[0].decisionInstanceId, completedState.outcomeJournal[0].semanticOwnerId);
  assert.equal(completedState.currentGoal.semanticType, "completed_choice_surface");
  const candidates = buildCurrentCandidateSet({
    goal: completedState.currentGoal,
    observation: completedObservation,
    traveler,
    state: { taskState: completedState, approvals: {} }
  });
  assert.deepEqual(candidates.candidates.map((candidate) => candidate.controlId), ["flex_opener"]);
  assert.equal(candidates.candidates[0].physicalEffect, "dismiss_surface");
  assert.equal(candidates.candidates.some((candidate) => candidate.controlId === "flex_none"), false);

  const closedObservation = dropdownObservation("obs_flex_closed", true);
  closedObservation.page.currentSurface = {
    id: "surface-page",
    type: "page",
    surfaceClass: "page",
    label: "Traveller information",
    memberControlIds: []
  };
  closedObservation.page.controls = closedObservation.page.controls.map((entry) => (
    entry.controlId === "flex_opener"
      ? { ...entry, state: { ...(entry.state || {}), expanded: false } }
      : entry
  ));
  const journalState = reduceTaskState({
    previousTaskState: completedState,
    observation: closedObservation,
    previousActionResult: {
      dispatched: true,
      verified: true,
      expectedOutcomeObserved: true,
      postconditionSatisfied: true,
      action: {
        decisionEpisodeId: completedState.decisionEpisode.episodeId,
        parentDecisionGroupId,
        decisionGroupId: parentDecisionGroupId,
        controlId: "flex_opener"
      }
    },
    userPolicy: { bookingRules: traveler.booking_rules },
    traveler
  });
  assert.equal(journalState.decisionEpisode.status, "completed");
  assert.equal(journalState.outcomeJournal.length, 1);
  assert.equal(journalState.outcomeJournal[0].originKind, "verified_commerce_decision");
  assert.equal(journalState.outcomeJournal[0].verified, true);
});

test("explicit child identity cannot inherit a stale fallback episode when the exact completed parent returns", () => {
  const traveler = { booking_rules: "No paid extras" };
  const parentDecisionGroupId = "dg_flexible_ticket";
  const surfaceId = "flex_options";
  const free = control("flex_none", {
    surfaceId,
    surfaceType: "dropdown",
    decisionGroupId: parentDecisionGroupId,
    label: "None of the passengers \u202AEUR0.00\u202C 0.00 Euro",
    semantic: "decline_paid_extra",
    physicalEffect: "select_free_option",
    risk: "safe_decline",
    structuredPrice: { amount: 0, currency: "EUR" },
    kind: "option",
    role: "option",
    selected: true,
    state: { selected: true }
  });
  free.operations = { choose: capability("choose", "flex_none_node") };
  const paid = control("flex_all", {
    surfaceId,
    surfaceType: "dropdown",
    decisionGroupId: parentDecisionGroupId,
    label: "All passengers \u202AEUR37.95\u202C 37.95 Euro",
    semantic: "add_paid_extra",
    physicalEffect: "select_paid_option",
    risk: "money",
    structuredPrice: { amount: 37.95, currency: "EUR" },
    kind: "option",
    role: "option"
  });
  paid.operations = { choose: capability("choose", "flex_all_node") };
  const opener = control("flex_opener", {
    surfaceId: "surface-page",
    decisionGroupId: parentDecisionGroupId,
    label: "Select one option * None of the passengers",
    semantic: "required_dropdown_choice",
    risk: "safe_decline",
    state: { expanded: true, normalizedValue: "none of the passengers" }
  });
  const observation = {
    observationId: "obs_live_prefix_currency_parent_return",
    observationSnapshot: { snapshotHash: "hash_live_prefix_currency_parent_return" },
    page: {
      step: "traveler_information",
      currentSurface: {
        id: surfaceId,
        type: "dropdown",
        surfaceClass: "choice_set",
        label: "All passengers \u202AEUR37.95\u202C None of the passengers \u202AEUR0.00\u202C",
        memberControlIds: ["flex_all", "flex_none"]
      },
      controls: [free, paid, opener],
      decisionGroups: [{
        decisionGroupId: parentDecisionGroupId,
        requirementId: "extras:flexible_ticket",
        surfaceId,
        surfaceType: "dropdown",
        sectionType: "passenger",
        sectionLabel: "Flexible Ticket",
        required: true,
        status: "satisfied",
        selectedControlId: free.controlId,
        selectedLabel: free.label,
        selectedSemantic: free.semantic,
        alternatives: [free, paid]
      }],
      validationIssues: []
    }
  };
  const staleEpisode = {
    episodeId: "traveler_information:extras:extras",
    decisionInstanceId: "extras:extras",
    canonicalOwnerId: "extras:extras",
    family: "extras",
    subjectKey: "extras",
    parentDecisionGroupId: "extras:extras",
    status: "awaiting_child_confirmation",
    commitmentPhase: "option_pending",
    selectedControlId: "",
    surfacePath: ["page|unknown|traveler_information", "popover|unknown|flexible ticket confirmation"],
    segmentOutcomes: []
  };
  const previousTaskState = {
    decisionEpisode: staleEpisode,
    currentGoal: {
      goalId: "obs_child:goal:flexible_confirmation",
      decisionInstanceId: "child_flexible_confirmation",
      decisionGroupId: "dg_flexible_confirmation",
      semanticType: "extras_choice",
      surfaceId: "flex_confirm"
    }
  };
  const state = reduceTaskState({
    previousTaskState,
    observation,
    previousActionResult: {
      dispatched: true,
      verified: true,
      expectedOutcomeObserved: true,
      postconditionSatisfied: true,
      mechanicalEffect: "select_free_option",
      expectedOutcome: {
        type: "exact_free_option_selected",
        decisionGroupId: "dg_flexible_confirmation",
        expectedSelectedControlId: "flex_decline_confirm"
      },
      action: {
        decisionInstanceId: "child_flexible_confirmation",
        decisionGroupId: "dg_flexible_confirmation",
        controlId: "flex_decline_confirm",
        mechanicalEffect: "select_free_option",
        affordance: {
          physicalEffect: "select_free_option",
          task: {
            decisionInstanceId: "child_flexible_confirmation",
            decisionGroupId: "dg_flexible_confirmation"
          }
        }
      }
    },
    userPolicy: { bookingRules: traveler.booking_rules },
    traveler
  });

  assert.equal(state.decisionEpisode.parentDecisionGroupId, parentDecisionGroupId);
  assert.equal(state.decisionEpisode.status, "completed_pending_surface_exit");
  assert.equal(state.currentGoal.semanticType, "completed_choice_surface");
  assert.deepEqual(state.currentGoal.actionableControlIds, ["flex_opener"]);
  const candidateSet = buildCurrentCandidateSet({
    goal: state.currentGoal,
    observation,
    traveler,
    state: { taskState: state, approvals: {} }
  });
  assert.deepEqual(candidateSet.candidates.map((candidate) => candidate.controlId), ["flex_opener"]);
  assert.equal(candidateSet.contextCapabilities.some((candidate) => (
    candidate.controlId === "flex_all" && candidate.selectable === true
  )), false);
});

test("verified nested action lineage journals same-label sibling extras under distinct canonical owners", () => {
  const traveler = { booking_rules: "No paid extras" };
  const ancillaryObservation = (id, decisionGroupId, selected = false) => {
    const free = control(`${decisionGroupId}_none`, {
      decisionGroupId,
      label: "None of the passengers 0 EUR",
      semantic: "decline_paid_extra",
      physicalEffect: "select_free_option",
      risk: "safe_decline",
      structuredPrice: { amount: 0, currency: "EUR" },
      kind: "option",
      role: "option",
      selected
    });
    free.operations = { choose: capability("choose", `${decisionGroupId}_none_node`) };
    const paid = control(`${decisionGroupId}_all`, {
      decisionGroupId,
      label: "All passengers 13 EUR",
      semantic: "add_paid_extra",
      physicalEffect: "select_paid_option",
      risk: "money",
      structuredPrice: { amount: 13, currency: "EUR" },
      kind: "option",
      role: "option"
    });
    paid.operations = { choose: capability("choose", `${decisionGroupId}_all_node`) };
    return {
      observationId: id,
      observationSnapshot: { snapshotHash: `hash_${id}` },
      page: {
        step: "traveler_information",
        currentSurface: { id: "surface-page", type: "page", surfaceClass: "page", label: "Traveller information" },
        controls: [free, paid],
        decisionGroups: [{
          decisionGroupId,
          requirementId: "contact:select-an-option",
          surfaceId: "surface-page",
          surfaceType: "page",
          sectionType: "extras",
          sectionLabel: "Select an option",
          required: true,
          status: selected ? "satisfied" : "missing",
          selectedControlId: selected ? free.controlId : "",
          selectedLabel: selected ? free.label : "",
          selectedSemantic: selected ? free.semantic : "",
          alternatives: [{ ...free, selected }, paid]
        }],
        validationIssues: []
      }
    };
  };
  const commitSibling = (previousTaskState, groupId, suffix) => {
    const active = reduceTaskState({
      previousTaskState: { ...previousTaskState, decisionEpisode: null, currentGoal: null },
      observation: ancillaryObservation(`obs_${suffix}_active`, groupId),
      userPolicy: { bookingRules: traveler.booking_rules },
      traveler
    });
    const actionResult = {
      actionId: `act_${suffix}_none`,
      dispatched: true,
      verified: true,
      expectedOutcomeObserved: true,
      postconditionSatisfied: true,
      mechanicalEffect: "select_free_option",
      expectedOutcome: {
        type: "exact_free_option_selected",
        decisionGroupId: groupId,
        expectedSelectedControlId: `${groupId}_none`
      },
      action: {
        id: `act_${suffix}_none`,
        controlId: `${groupId}_none`,
        decisionGroupId: groupId,
        mechanicalEffect: "select_free_option",
        affordance: {
          physicalEffect: "select_free_option",
          task: {
            decisionEpisodeId: active.decisionEpisode.episodeId,
            decisionInstanceId: active.decisionEpisode.decisionInstanceId,
            parentDecisionGroupId: groupId,
            decisionGroupId: groupId
          }
        }
      }
    };
    const receipt = verifiedCommerceObligationFromActionResult(
      actionResult,
      `obs_${suffix}_selected`,
      { decisionEpisode: active.decisionEpisode }
    );
    return reduceTaskState({
      previousTaskState: active,
      verifiedCommerceObligations: [
        ...(previousTaskState.verifiedCommerceObligations || []),
        receipt
      ],
      observation: ancillaryObservation(`obs_${suffix}_selected`, groupId, true),
      previousActionResult: actionResult,
      userPolicy: { bookingRules: traveler.booking_rules },
      traveler
    });
  };

  const airhelp = commitSibling({}, "dg_airhelp", "airhelp");
  assert.equal(airhelp.outcomeJournal.length, 1);
  const sms = commitSibling(airhelp, "dg_sms", "sms");
  assert.equal(sms.outcomeJournal.length, 2);
  assert.equal(new Set(sms.outcomeJournal.map((entry) => entry.decisionInstanceId)).size, 2);
  assert.deepEqual(sms.outcomeJournal.map((entry) => entry.decisionGroupId).sort(), ["dg_airhelp", "dg_sms"]);
  assert.equal(sms.outcomeCoverage.expectedDecisionInstanceIds.length, 2);
  assert.equal(sms.outcomeCoverage.missingJournalDecisionInstanceIds.length, 0);
});

test("a verified commerce result is journaled even when its transient episode is absent", () => {
  const traveler = { booking_rules: "No paid extras" };
  const decisionGroupId = "dg_airhelp";
  const free = control("airhelp_none", {
    decisionGroupId,
    label: "No thanks AirHelp",
    semantic: "decline_paid_extra",
    physicalEffect: "select_free_option",
    risk: "safe_decline",
    kind: "radio",
    role: "radio",
    selected: true,
    state: { checked: true, selected: true }
  });
  free.operations = { choose: capability("choose", "airhelp_none_node") };
  const paid = control("airhelp_paid", {
    decisionGroupId,
    label: "Add AirHelp — 10 EUR",
    semantic: "add_paid_extra",
    physicalEffect: "select_paid_option",
    risk: "money",
    structuredPrice: { amount: 10, currency: "EUR" },
    kind: "radio",
    role: "radio"
  });
  paid.operations = { choose: capability("choose", "airhelp_paid_node") };
  const observation = {
    observationId: "obs_airhelp_verified_without_episode",
    observationSnapshot: { snapshotHash: "airhelp_verified_without_episode" },
    page: {
      step: "traveler_information",
      currentSurface: { id: "surface-page", type: "page", surfaceClass: "page", label: "Traveller information" },
      controls: [free, paid],
      decisionGroups: [{
        decisionGroupId,
        requirementId: "contact:select-an-option",
        surfaceId: "surface-page",
        surfaceType: "page",
        sectionType: "extras",
        sectionLabel: "AirHelp",
        required: false,
        status: "satisfied",
        selectedControlId: free.controlId,
        selectedLabel: free.label,
        selectedSemantic: free.semantic,
        alternatives: [{ ...free, selected: true }, paid]
      }],
      validationIssues: []
    }
  };
  const decisionInstanceId = "traveler_information:extras:airhelp:dg_airhelp:global";
  const state = reduceTaskState({
    // This is the live failure shape: browser verification has the exact
    // owner, but the reducer has no surviving decisionEpisode to reconstruct.
    previousTaskState: { decisionEpisode: null, currentGoal: null },
    observation,
    previousActionResult: {
      actionId: "act_airhelp_verified",
      dispatched: true,
      verified: true,
      expectedOutcomeObserved: true,
      postconditionSatisfied: true,
      mechanicalEffect: "select_free_option",
      expectedOutcome: {
        type: "exact_free_option_selected",
        decisionGroupId,
        expectedSelectedControlId: free.controlId,
        expectedSelectedLabel: free.label,
        expectedDisposition: "decline_free_no_extra"
      },
      action: {
        id: "act_airhelp_verified",
        controlId: free.controlId,
        decisionGroupId,
        mechanicalEffect: "select_free_option",
        affordance: {
          physicalEffect: "select_free_option",
          task: {
            decisionInstanceId,
            canonicalOwnerId: decisionInstanceId,
            parentDecisionGroupId: decisionGroupId,
            decisionGroupId,
            requirementId: "contact:select-an-option"
          }
        }
      }
    },
    userPolicy: { bookingRules: traveler.booking_rules },
    traveler
  });

  assert.equal(state.outcomeJournal.length, 1);
  assert.equal(state.outcomeJournal[0].decisionInstanceId, state.outcomeJournal[0].semanticOwnerId);
  assert.notEqual(state.outcomeJournal[0].semanticOwnerId, decisionInstanceId);
  assert.equal(state.outcomeJournal[0].admissionSource, "verified_action_contract");
  // Direct journal admission is useful backward-compatible evidence, but it
  // is not allowed to manufacture an expected obligation. Production loop
  // accounting establishes expectations from the raw receipt register.
  assert.deepEqual(state.outcomeCoverage.expectedDecisionInstanceIds, []);
  assert.deepEqual(state.outcomeCoverage.missingJournalDecisionInstanceIds, []);
  assert.deepEqual(state.outcomeCoverage.missingLedgerDecisionInstanceIds, []);
  assert.equal(state.outcomeCoverage.complete, true);
});

test("a verified commerce receipt remains an expected obligation after the source page is gone", () => {
  const decisionGroupId = "dg_lost_bundle";
  const decisionInstanceId = "traveler_information:extras:bundle:dg_lost_bundle:global";
  const actionResult = {
    actionId: "act_lost_bundle_decline",
    dispatched: true,
    verified: true,
    expectedOutcomeObserved: true,
    postconditionSatisfied: true,
    mechanicalEffect: "select_free_option",
    expectedOutcome: {
      type: "exact_free_option_selected",
      decisionGroupId,
      expectedSelectedControlId: "bundle_none",
      expectedSelectedLabel: "No thanks",
      expectedDisposition: "decline_free_no_extra"
    },
    action: {
      id: "act_lost_bundle_decline",
      controlId: "bundle_none",
      decisionGroupId,
      mechanicalEffect: "select_free_option",
      affordance: {
        physicalEffect: "select_free_option",
        task: {
          decisionInstanceId,
          canonicalOwnerId: decisionInstanceId,
          parentDecisionGroupId: decisionGroupId,
          decisionGroupId,
          semanticType: "decline_bundle"
        }
      }
    }
  };
  const receipt = verifiedCommerceObligationFromActionResult(actionResult, "obs_bundle_selected");
  const state = reduceTaskState({
    // The next page no longer contains the bundle and there is no action
    // result left to replay. The independently persisted receipt must still
    // enter the journal and block terminal certification until ledgered.
    previousTaskState: { decisionEpisode: null, currentGoal: null },
    verifiedCommerceObligations: [receipt],
    observation: {
      observationId: "obs_after_bundle_rerender",
      observationSnapshot: { snapshotHash: "after_bundle_rerender" },
      page: {
        step: "seat_selection",
        currentSurface: { id: "surface-page", type: "page", surfaceClass: "page", label: "Seat selection" },
        controls: [],
        decisionGroups: [],
        validationIssues: []
      }
    }
  });

  assert.equal(state.outcomeJournal.length, 1);
  assert.equal(state.outcomeJournal[0].decisionInstanceId, state.outcomeJournal[0].semanticOwnerId);
  assert.notEqual(state.outcomeJournal[0].semanticOwnerId, decisionInstanceId);
  assert.equal(state.outcomeJournal[0].admissionSource, "verified_action_obligation");
  assert.deepEqual(state.outcomeCoverage.expectedActionIds, ["act_lost_bundle_decline"]);
  assert.deepEqual(state.outcomeCoverage.missingActionIds, ["act_lost_bundle_decline"]);
  assert.equal(state.outcomeCoverage.complete, false);
});

test("one verified action cannot create duplicate receipt and direct journal owners", () => {
  const canonicalOwnerId = "traveler_information:extras:flexible_ticket:dg_flexible:global";
  const transientOwnerId = JSON.stringify({
    stage: "traveler_information",
    surface: "flexible ticket dropdown",
    decisionGroup: "dg_flexible"
  });
  const result = {
    actionId: "act_flexible_none",
    dispatched: true,
    verified: true,
    expectedOutcomeObserved: true,
    postconditionSatisfied: true,
    mechanicalEffect: "select_free_option",
    decisionInstanceId: transientOwnerId,
    expectedOutcome: {
      type: "exact_free_option_selected",
      decisionGroupId: "dg_flexible",
      expectedSelectedControlId: "flexible_none",
      expectedSelectedLabel: "None of the passengers",
      expectedDisposition: "decline_free_no_extra"
    },
    action: {
      id: "act_flexible_none",
      decisionInstanceId: transientOwnerId,
      decisionGroupId: "dg_flexible",
      controlId: "flexible_none",
      targetLabel: "None of the passengers",
      mechanicalEffect: "select_free_option",
      affordance: {
        physicalEffect: "select_free_option",
        task: {
          canonicalOwnerId,
          decisionInstanceId: canonicalOwnerId,
          parentDecisionGroupId: "dg_flexible",
          decisionGroupId: "dg_flexible",
          semanticType: "flexible_ticket"
        }
      }
    }
  };
  const receipt = verifiedCommerceObligationFromActionResult(result, "obs_flexible");
  const state = reduceTaskState({
    previousTaskState: { decisionEpisode: null, currentGoal: null },
    verifiedCommerceObligations: [receipt],
    previousActionResult: result,
    observation: {
      observationId: "obs_after_flexible",
      observationSnapshot: { snapshotHash: "after_flexible" },
      lastActionResult: result,
      page: {
        step: "traveler_information",
        currentSurface: { id: "surface-page", type: "page", surfaceClass: "page", label: "Traveler" },
        controls: [],
        decisionGroups: [],
        validationIssues: []
      }
    }
  });

  assert.equal(state.outcomeJournal.length, 1);
  assert.equal(state.outcomeJournal[0].actionId, "act_flexible_none");
  assert.equal(state.outcomeJournal[0].decisionInstanceId, state.outcomeJournal[0].semanticOwnerId);
  assert.notEqual(state.outcomeJournal[0].semanticOwnerId, canonicalOwnerId);
  assert.equal(state.outcomeJournal[0].admissionSource, "verified_action_obligation");
  assert.deepEqual(state.outcomeCoverage.expectedDecisionInstanceIds, [state.outcomeJournal[0].semanticOwnerId]);
  assert.equal(state.outcomeCoverage.expectedDecisionInstanceIds.includes(transientOwnerId), false);
});

test("a stale page episode cannot own the next sibling receipt while its exact foreground child can", () => {
  const staleEpisode = {
    episodeId: "episode_airhelp",
    decisionInstanceId: "owner_airhelp",
    canonicalOwnerId: "owner_airhelp",
    parentDecisionGroupId: "dg_airhelp",
    childSurfaceId: "surface-page",
    family: "extras",
    subjectKey: "airhelp"
  };
  const exactResult = ({
    actionId,
    owner,
    decisionGroupId,
    label,
    surfaceId = "surface-page"
  }) => ({
    actionId,
    dispatched: true,
    verified: true,
    expectedOutcomeObserved: true,
    postconditionSatisfied: true,
    mechanicalEffect: "select_free_option",
    expectedOutcome: {
      type: "exact_free_option_selected",
      decisionGroupId,
      surfaceId,
      expectedSelectedControlId: `${decisionGroupId}_none`,
      expectedSelectedLabel: label,
      expectedDisposition: "decline_free_no_extra"
    },
    action: {
      id: actionId,
      controlId: `${decisionGroupId}_none`,
      decisionGroupId,
      targetLabel: label,
      mechanicalEffect: "select_free_option",
      affordance: {
        physicalEffect: "select_free_option",
        task: {
          canonicalOwnerId: owner,
          decisionInstanceId: owner,
          decisionEpisodeId: `episode_${decisionGroupId}`,
          parentDecisionGroupId: decisionGroupId,
          decisionGroupId,
          semanticType: decisionGroupId
        }
      }
    }
  });
  const baggage = verifiedCommerceObligationFromActionResult(
    exactResult({
      actionId: "act_baggage_none",
      owner: "owner_baggage",
      decisionGroupId: "dg_baggage",
      label: "No thanks baggage"
    }),
    "obs_baggage",
    { decisionEpisode: staleEpisode }
  );
  assert.equal(baggage.decisionInstanceId, baggage.semanticOwnerId);
  assert.notEqual(baggage.semanticOwnerId, "owner_baggage");
  assert.notEqual(baggage.decisionInstanceId, staleEpisode.canonicalOwnerId);

  const parentEpisode = {
    ...staleEpisode,
    episodeId: "episode_flexible",
    decisionInstanceId: "owner_flexible",
    canonicalOwnerId: "owner_flexible",
    parentDecisionGroupId: "dg_flexible",
    childSurfaceId: "surface_flexible_confirmation",
    subjectKey: "flexible_ticket"
  };
  const child = verifiedCommerceObligationFromActionResult(
    exactResult({
      actionId: "act_flexible_confirm_none",
      owner: "transient_confirmation_owner",
      decisionGroupId: "dg_flexible_confirmation",
      label: "I'll go without",
      surfaceId: "surface_flexible_confirmation"
    }),
    "obs_flexible_confirmation",
    { decisionEpisode: parentEpisode }
  );
  assert.equal(child.decisionInstanceId, child.semanticOwnerId);
  assert.notEqual(child.semanticOwnerId, "owner_flexible");
  assert.equal(child.decisionGroupId, "dg_flexible");
});

test("a compact verified result resolves its exact commerce owner from the result target snapshot", () => {
  const traveler = { booking_rules: "No paid extras" };
  const decisionGroupId = "dg_compact_airhelp";
  const free = control("compact_airhelp_none", {
    decisionGroupId,
    label: "No thanks AirHelp",
    semantic: "decline_paid_extra",
    physicalEffect: "select_free_option",
    risk: "safe_decline",
    kind: "radio",
    role: "radio",
    selected: true,
    state: { checked: true, selected: true }
  });
  free.operations = { choose: capability("choose", "compact_airhelp_none_node") };
  const paid = control("compact_airhelp_paid", {
    decisionGroupId,
    label: "Add AirHelp — 10 EUR",
    semantic: "add_paid_extra",
    physicalEffect: "select_paid_option",
    risk: "money",
    structuredPrice: { amount: 10, currency: "EUR" },
    kind: "radio",
    role: "radio"
  });
  const decisionInstanceId = "traveler_information:extras:airhelp:dg_compact_airhelp:global";
  const state = reduceTaskState({
    previousTaskState: { decisionEpisode: null, currentGoal: null },
    observation: {
      observationId: "obs_compact_airhelp_verified",
      observationSnapshot: { snapshotHash: "compact_airhelp_verified" },
      page: {
        step: "traveler_information",
        currentSurface: { id: "surface-page", type: "page", surfaceClass: "page", label: "Traveller information" },
        controls: [free, paid],
        decisionGroups: [{
          decisionGroupId,
          requirementId: "extras:airhelp",
          surfaceId: "surface-page",
          surfaceType: "page",
          sectionType: "extras",
          sectionLabel: "AirHelp",
          required: false,
          status: "satisfied",
          selectedControlId: free.controlId,
          selectedLabel: free.label,
          selectedSemantic: free.semantic,
          alternatives: [{ ...free, selected: true }, paid]
        }],
        validationIssues: []
      }
    },
    // This mirrors the transport shape from a real browser result: planning
    // metadata is compacted off action, while the exact resolved target and
    // canonical task contract remain present.
    previousActionResult: {
      actionId: "act_compact_airhelp_verified",
      dispatched: true,
      verified: true,
      expectedOutcomeObserved: true,
      postconditionSatisfied: true,
      mechanicalEffect: "select_free_option",
      targetSnapshot: { controlId: free.controlId, decisionGroupId },
      expectedOutcome: {
        type: "exact_free_option_selected",
        expectedSelectedControlId: free.controlId,
        expectedSelectedLabel: free.label,
        expectedDisposition: "decline_free_no_extra"
      },
      action: {
        id: "act_compact_airhelp_verified",
        controlId: free.controlId,
        mechanicalEffect: "select_free_option",
        affordance: {
          physicalEffect: "select_free_option",
          task: { decisionInstanceId, canonicalOwnerId: decisionInstanceId, decisionGroupId }
        }
      }
    },
    userPolicy: { bookingRules: traveler.booking_rules },
    traveler
  });

  assert.equal(state.outcomeJournal.length, 1);
  assert.equal(state.outcomeJournal[0].decisionInstanceId, state.outcomeJournal[0].semanticOwnerId);
  assert.equal(state.outcomeJournal[0].subjectKey, "extras_airhelp");
  assert.deepEqual(state.outcomeCoverage.expectedDecisionInstanceIds, []);
});

test("a stale completed-extra episode cannot block its visible sibling queue", () => {
  const traveler = { booking_rules: "No paid extras" };
  const safeChoice = (decisionGroupId, label, selected = false) => {
    const free = control(`${decisionGroupId}_none`, {
      decisionGroupId,
      label: `No thanks ${label}`,
      semantic: "decline_paid_extra",
      physicalEffect: "select_free_option",
      risk: "safe_decline",
      kind: "radio",
      role: "radio",
      selected,
      state: { checked: selected, selected }
    });
    free.operations = { choose: capability("choose", `${decisionGroupId}_none_node`) };
    const paid = control(`${decisionGroupId}_paid`, {
      decisionGroupId,
      label: `Add ${label} — 10 EUR`,
      semantic: "add_paid_extra",
      physicalEffect: "select_paid_option",
      risk: "money",
      structuredPrice: { amount: 10, currency: "EUR" },
      kind: "radio",
      role: "radio"
    });
    paid.operations = { choose: capability("choose", `${decisionGroupId}_paid_node`) };
    return {
      decisionGroupId,
      requirementId: "contact:select-an-option",
      surfaceId: "surface-page",
      surfaceType: "page",
      sectionType: "extras",
      sectionLabel: "Select an option",
      required: true,
      status: selected ? "satisfied" : "missing",
      selectedControlId: selected ? free.controlId : "",
      selectedLabel: selected ? free.label : "",
      selectedSemantic: selected ? free.semantic : "",
      alternatives: [{ ...free, selected }, paid],
      controls: [free, paid]
    };
  };
  const bankruptcy = safeChoice("dg_bankruptcy", "bankruptcy protection", true);
  const airhelp = safeChoice("dg_airhelp", "AirHelp");
  const sms = safeChoice("dg_sms", "SMS updates");
  const observation = {
    observationId: "obs_gotogate_after_first_decline",
    observationSnapshot: { snapshotHash: "gotogate_after_first_decline" },
    page: {
      step: "traveler_information",
      currentSurface: { id: "surface-page", type: "page", surfaceClass: "page", label: "Traveller information" },
      controls: [
        ...bankruptcy.controls,
        ...airhelp.controls,
        ...sms.controls
      ],
      decisionGroups: [bankruptcy, airhelp, sms],
      validationIssues: []
    }
  };
  const staleBundleEpisode = {
    episodeId: "traveler_information:bundle",
    decisionInstanceId: "bundle-owner",
    canonicalOwnerId: "bundle-owner",
    family: "extras",
    subjectKey: "bundle",
    parentDecisionGroupId: "dg_bundle",
    requirementId: "bundle:add-a-bundle",
    status: "blocked_cycle",
    commitmentPhase: "option_pending",
    semanticOutcomeKey: "satisfied|bundle_none|",
    surfacePath: ["page|unknown|traveller information"],
    cycleCount: 2,
    cycleDetected: true
  };
  const state = reduceTaskState({
    previousTaskState: { decisionEpisode: staleBundleEpisode, currentGoal: { decisionGroupId: "dg_bundle" } },
    // This is the malformed lineage from the live regression: the actual
    // action selected bankruptcy, but an old bundle episode was carried too.
    previousActionResult: {
      dispatched: true,
      verified: true,
      expectedOutcomeObserved: true,
      postconditionSatisfied: true,
      action: {
        decisionEpisodeId: staleBundleEpisode.episodeId,
        parentDecisionGroupId: "dg_bundle",
        decisionGroupId: "dg_bankruptcy",
        controlId: "dg_bankruptcy_none"
      }
    },
    observation,
    userPolicy: { bookingRules: traveler.booking_rules },
    traveler
  });

  assert.equal(state.ambiguityReason, "");
  assert.equal(state.currentGoal.decisionGroupId, "dg_airhelp");
  assert.notEqual(state.currentGoal.decisionEpisodeId, staleBundleEpisode.episodeId);
  assert.equal(state.currentGoal.parentDecisionGroupId, "dg_airhelp");
  assert.ok(state.activeDecisions.some((decision) => decision.decisionGroupId === "dg_sms"));
});

test("a current decision cycle remains routable while an exact fresh strategy exists", () => {
  const free = control("seat_none", {
    decisionGroupId: "dg_seat",
    label: "Continue with random seat assignment",
    semantic: "decline_paid_seat",
    physicalEffect: "select_free_option",
    risk: "safe_decline",
    kind: "radio",
    role: "radio",
    state: { checked: false, selected: false }
  });
  free.operations = { choose: capability("choose", "seat_none_node") };
  const paid = control("seat_paid", {
    decisionGroupId: "dg_seat",
    label: "Choose a seat — 12 EUR",
    semantic: "add_paid_seat",
    physicalEffect: "select_paid_option",
    risk: "money",
    structuredPrice: { amount: 12, currency: "EUR" },
    kind: "radio",
    role: "radio"
  });
  paid.operations = { choose: capability("choose", "seat_paid_node") };
  const episode = {
    episodeId: "seats:seat:dg_seat",
    decisionInstanceId: "seats:seat:dg_seat:global",
    canonicalOwnerId: "seats:seat:dg_seat:global",
    family: "seat",
    subjectKey: "seat",
    parentDecisionGroupId: "dg_seat",
    requirementId: "seats:seat-selection",
    status: "blocked_cycle",
    commitmentPhase: "option_pending",
    semanticOutcomeKey: "missing||",
    surfacePath: ["page|unknown|select seats"],
    cycleCount: 2,
    cycleDetected: true
  };
  const state = reduceTaskState({
    previousTaskState: {
      decisionEpisode: episode,
      currentGoal: {
        kind: "commerce_decision",
        goalId: "decision:dg_seat",
        decisionGroupId: "dg_seat",
        parentDecisionGroupId: "dg_seat",
        decisionEpisodeId: episode.episodeId
      }
    },
    observation: {
      observationId: "obs_same_seat_cycle",
      observationSnapshot: { snapshotHash: "same_seat_cycle" },
      page: {
        step: "seats",
        currentSurface: { id: "surface-page", type: "page", surfaceClass: "page", label: "Select seats" },
        controls: [free, paid],
        decisionGroups: [{
          decisionGroupId: "dg_seat",
          requirementId: "seats:seat-selection",
          surfaceId: "surface-page",
          surfaceType: "page",
          sectionType: "seat",
          sectionLabel: "Select seats",
          required: true,
          status: "missing",
          selectedControlId: "",
          alternatives: [free, paid],
          controls: [free, paid]
        }],
        validationIssues: []
      }
    },
    userPolicy: { bookingRules: "No paid extras; accept random seat assignment" },
    traveler: { booking_rules: "No paid extras; accept random seat assignment" }
  });

  assert.equal(state.ambiguityReason, "");
  assert.equal(state.currentGoal?.decisionGroupId, "dg_seat");
  assert.equal(state.currentGoal?.selectedControlId || "", "");
  assert.ok(state.activeDecisions.some((decision) => decision.decisionGroupId === "dg_seat"));
});

test("GoToGate seat mode toggle yields to independently proven safe Next without treating Next as Skip", () => {
  const noThanks = control("seatmap_false", {
    decisionGroupId: "dg_seat_mode",
    label: "No thanks",
    semantic: "decline_paid_extra",
    physicalEffect: "select_free_option",
    risk: "safe_decline",
    kind: "radio",
    role: "radio",
    state: { disabled: true, checked: false, selected: false }
  });
  noThanks.disabled = true;
  noThanks.operations = {
    choose: {
      ...capability("choose", "seatmap_false_node"),
      actionability: {
        ...capability("choose", "seatmap_false_node").actionability,
        enabled: false,
        executable: false,
        code: "ACTUATOR_DISABLED"
      }
    }
  };
  const paidMode = control("seatmap_true", {
    decisionGroupId: "dg_seat_mode",
    label: "Add to cart",
    semantic: "add_paid_extra",
    physicalEffect: "select_paid_option",
    effectRole: "scope_toggle",
    risk: "money",
    kind: "radio",
    role: "radio",
    selected: true,
    state: { disabled: true, checked: true, selected: true }
  });
  paidMode.disabled = true;
  paidMode.effectRole = "scope_toggle";
  paidMode.operations = noThanks.operations;
  const back = control("back", {
    decisionGroupId: "dg_seat_mode",
    label: "Back",
    semantic: "choice",
    physicalEffect: "unknown"
  });
  const skip = control("skip_seat_selection", {
    decisionGroupId: "dg_seat_mode",
    label: "Skip seat selection",
    semantic: "decline_paid_extra",
    physicalEffect: "select_free_option",
    risk: "safe_decline"
  });
  skip.operations = {
    activate: {
      ...capability("activate", "skip_seat_selection_node"),
      actionability: {
        ...capability("activate", "skip_seat_selection_node").actionability,
        hitTested: false,
        notOccluded: false,
        executable: false,
        code: "TARGET_NOT_ACTIONABLE"
      }
    }
  };
  const next = control("next", {
    label: "Next",
    semantic: "continue",
    physicalEffect: "advance_checkout_stage",
    risk: "safe_continue"
  });
  const state = reduceTaskState({
    previousTaskState: { stage: "traveler_information" },
    observation: {
      observationId: "obs_gotogate_seats",
      observationSnapshot: { snapshotHash: "gotogate_seats_unchanged" },
      page: {
        step: "seats",
        url: "https://en-en.gotogate.com/rf/traveler-details",
        heading: "Select your seats",
        currentSurface: { id: "surface-page", type: "page", surfaceClass: "page", label: "Seats" },
        controls: [noThanks, paidMode, back, skip, next],
        decisionGroups: [{
          decisionGroupId: "dg_seat_mode",
          requirementId: "seat:select-an-option",
          surfaceId: "surface-page",
          surfaceType: "page",
          sectionType: "seat",
          sectionLabel: "Select an option",
          required: true,
          status: "satisfied",
          selectedControlId: "seatmap_true",
          selectedEvidence: {
            selected: true,
            selectedControlId: "seatmap_true",
            disposition: "paid",
            effectRole: "scope_toggle"
          },
          alternatives: [noThanks, paidMode, back, skip],
          controls: [noThanks, paidMode, back, skip]
        }],
        validationIssues: [],
        stageExit: {
          continueAllowed: true,
          candidates: [{ controlId: "next", executable: true, status: "ready" }]
        }
      }
    },
    userPolicy: { bookingRules: "No paid seats; accept random assignment" },
    traveler: { booking_rules: "No paid seats; accept random assignment", seat_policy: "random_assignment" }
  });

  assert.equal(state.stage, "seats");
  assert.deepEqual(state.currentObligation?.admittedControlIds, ["next"]);
  assert.notDeepEqual(state.currentObligation?.admittedControlIds, ["back"]);
  assert.equal(state.currentGoal?.semanticType, "navigation");
  assert.equal(state.ambiguityReason, "");
  assert.equal(state.disposition.kind, "execute");
  const candidateSet = buildCurrentCandidateSet({
    goal: state.currentGoal,
    observation: {
      observationId: "obs_gotogate_seats",
      page: {
        step: "seats",
        currentSurface: { id: "surface-page", type: "page", surfaceClass: "page", label: "Seats" },
        controls: [noThanks, paidMode, back, skip, next],
        decisionGroups: [],
        validationIssues: [],
        stageExit: { continueAllowed: true, candidates: [{ controlId: "next", executable: true, status: "ready" }] }
      }
    },
    traveler: { booking_rules: "No paid seats; accept random assignment", seat_policy: "random_assignment" },
    state: { taskState: state, approvals: {} }
  });
  assert.equal(candidateSet.candidates.some((candidate) => candidate.controlId === "next"), true);
  assert.equal(candidateSet.candidates.some((candidate) => candidate.controlId === "back"), false);
});

test("a genuine paid seat conflict never substitutes unrelated Next or Back for unavailable exact Skip", () => {
  const paid = control("seat_12a", {
    decisionGroupId: "dg_exact_seat",
    label: "Seat 12A — 19 EUR",
    semantic: "add_paid_extra",
    physicalEffect: "select_paid_option",
    risk: "money",
    structuredPrice: { amount: 19, currency: "EUR" },
    selected: true,
    state: { checked: true, selected: true }
  });
  paid.effectRole = "commerce_option";
  const skip = control("skip_exact_seat", {
    decisionGroupId: "dg_exact_seat",
    label: "Skip seat selection",
    semantic: "decline_paid_extra",
    physicalEffect: "select_free_option",
    risk: "safe_decline"
  });
  skip.operations.activate.actionability = {
    ...skip.operations.activate.actionability,
    visible: false,
    hitTested: false,
    notOccluded: false,
    executable: false,
    code: "TARGET_NOT_ACTIONABLE"
  };
  const back = control("seat_back_unrelated", {
    label: "Back",
    semantic: "navigation",
    physicalEffect: "navigate_back"
  });
  const next = control("seat_next_unrelated", {
    label: "Next",
    semantic: "continue",
    physicalEffect: "advance_checkout_stage",
    risk: "safe_continue"
  });
  const observation = {
    observationId: "obs_exact_skip_unavailable",
    observationSnapshot: { snapshotHash: "hash_exact_skip_unavailable" },
    page: {
      step: "seats",
      currentSurface: { id: "seat_modal", type: "modal", surfaceClass: "blocking_modal", blocksBackground: true },
      controls: [paid, skip, back, next],
      decisionGroups: [{
        decisionGroupId: "dg_exact_seat",
        requirementId: "seat:exact-selection",
        surfaceId: "seat_modal",
        surfaceType: "modal",
        sectionType: "seat",
        sectionLabel: "Select a seat",
        required: true,
        status: "satisfied",
        selectedControlId: paid.controlId,
        selectedEvidence: {
          selected: true,
          selectedControlId: paid.controlId,
          ownerElementId: paid.stateElementId,
          effectRole: "commerce_option",
          disposition: "paid",
          structuredPrice: { amount: 19, currency: "EUR" }
        },
        alternatives: [paid, skip],
        controls: [paid, skip]
      }],
      validationIssues: [],
      stageExit: {
        continueAllowed: true,
        candidates: [{ controlId: next.controlId, executable: true, status: "ready" }]
      }
    }
  };
  const traveler = { booking_rules: "No paid seats", seat_policy: "random_assignment" };
  const state = reduceTaskState({ observation, traveler, userPolicy: { bookingRules: traveler.booking_rules } });
  const admitted = state.currentObligation?.admittedControlIds || [];
  assert.equal(admitted.includes(next.controlId), false, JSON.stringify(state.currentGoal, null, 2));
  assert.equal(admitted.includes(back.controlId), false, JSON.stringify(state.currentGoal, null, 2));

  const candidates = buildCurrentCandidateSet({
    goal: state.currentGoal,
    observation,
    traveler,
    state: { taskState: state, approvals: {} }
  }).candidates;
  assert.equal(candidates.some((candidate) => candidate.controlId === next.controlId), false);
  assert.equal(candidates.some((candidate) => candidate.controlId === back.controlId), false);
});

test("TaskState waits through unchanged observations and stops only after the real re-observation deadline", () => {
  const page = {
    step: "unknown",
    currentSurface: { id: "surface-page", type: "page", surfaceClass: "page", blocksBackground: false },
    controls: [],
    fields: [],
    decisionGroups: [],
    validationIssues: []
  };
  const first = reduceTaskState({
    observation: {
      observationId: "obs_reobserve_first",
      observationSnapshot: { snapshotHash: "hash_reobserve_first" },
      page
    }
  });
  assert.equal(first.disposition.kind, "wait_reobserve", JSON.stringify(first.disposition, null, 2));
  assert.match(first.disposition.retryToken, /^reobserve_/);
  assert.equal(first.disposition.reobserveCount, 1);
  assert.ok(first.disposition.reobserveDeadlineAt > first.disposition.reobserveStartedAt);

  const second = reduceTaskState({
    previousTaskState: first,
    observation: {
      observationId: "obs_reobserve_deadline",
      observationSnapshot: { snapshotHash: "hash_reobserve_deadline" },
      page
    }
  });
  assert.equal(second.disposition.kind, "wait_reobserve", JSON.stringify(second.disposition, null, 2));
  assert.equal(second.disposition.reobserveCount, 2);
  assert.equal(second.disposition.surfaceFingerprint, first.disposition.surfaceFingerprint);
  assert.equal(second.disposition.retryToken, first.disposition.retryToken);
  assert.equal(second.disposition.reobserveDeadlineAt, first.disposition.reobserveDeadlineAt);

  const afterDeadline = reduceTaskState({
    previousTaskState: {
      ...second,
      disposition: {
        ...second.disposition,
        reobserveStartedAt: Date.now() - 9_000,
        reobserveDeadlineAt: Date.now() - 1
      }
    },
    observation: {
      observationId: "obs_reobserve_after_deadline",
      observationSnapshot: { snapshotHash: "hash_reobserve_after_deadline" },
      page
    }
  });
  assert.equal(afterDeadline.disposition.kind, "stop", JSON.stringify(afterDeadline.disposition, null, 2));
  assert.equal(afterDeadline.disposition.reobserveCount, 3);
  assert.match(afterDeadline.disposition.reason, /after the bounded re-observation deadline/);
});

test("payment review remains active until every verified decision is present in the transaction ledger", () => {
  const decisionInstanceId = "traveler_information:extras:airhelp:dg_airhelp:global";
  const outcome = {
    decisionGroupId: "dg_airhelp",
    decisionInstanceId,
    decisionOwnerKey: decisionInstanceId,
    canonicalOwnerId: decisionInstanceId,
    originKind: "verified_commerce_decision",
    verified: true,
    family: "extras",
    subjectKey: "airhelp",
    label: "No thanks",
    disposition: "declined",
    outcome: "declined",
    priceAmount: 0,
    currency: "EUR"
  };
  const paymentObservation = {
    observationId: "obs_payment_coverage",
    observationSnapshot: { snapshotHash: "hash_payment_coverage" },
    page: {
      url: "https://example.test/payment",
      step: "payment",
      heading: "Payment",
      currentSurface: { id: "surface-page", type: "page", label: "Payment" },
      controls: [],
      decisionGroups: [],
      terminalEvidence: {
        contractVersion: "terminal-evidence/v1",
        stage: "payment_review",
        signals: { route: true, progress: true, form: true, method: true, heading: true },
        signalCount: 5,
        boundaryObserved: true,
        verified: true,
        evidenceOnly: true,
        capabilities: { paymentActionsAllowed: false }
      },
      validationIssues: []
    }
  };
  const previousTaskState = {
    verifiedCommerceObligations: [{
      actionId: "act_airhelp_none",
      decisionGroupId: "dg_airhelp",
      decisionInstanceId,
      decisionOwnerKey: decisionInstanceId,
      canonicalOwnerId: decisionInstanceId,
      originKind: "verified_commerce_obligation",
      verified: true
    }],
    outcomeJournal: [outcome],
    outcomeCoverage: {
      expectedDecisionInstanceIds: [decisionInstanceId],
      journaledDecisionInstanceIds: [decisionInstanceId],
      ledgeredDecisionInstanceIds: [],
      missingDecisionInstanceIds: [decisionInstanceId],
      complete: false
    }
  };
  const blocked = reduceTaskState({
    previousTaskState,
    observation: paymentObservation,
    transactionReview: readyTransactionReview()
  });
  assert.equal(blocked.terminalStatus, "active");
  assert.equal(blocked.transactionReview.ready, false);
  assert.ok(blocked.transactionReview.missingFacts.includes("verified_decision_outcomes"));

  const accepted = reduceTaskState({
    previousTaskState,
    observation: paymentObservation,
    transactionReview: { ...readyTransactionReview(), outcomeLedger: [outcome] }
  });
  assert.equal(accepted.terminalStatus, "payment_review_reached");
  assert.equal(accepted.transactionReview.ready, true);
  assert.equal(accepted.outcomeCoverage.complete, true);
});

test("unknown grounding remains diagnostic and cannot manufacture profile unready state", () => {
  const observation = {
    observationId: "obs_active_requirement_unresolved",
    observationSnapshot: { snapshotHash: "hash_active_requirement_unresolved" },
    page: {
      url: "https://example.test/passengers",
      step: "traveler_information",
      heading: "Passenger details",
      currentSurface: { id: "surface-page", type: "page", label: "Passenger details" },
      controls: [],
      fields: [],
      decisionGroups: [],
      validationIssues: [],
      activeRequirementGrounding: {
        contractVersion: "active-component-semantic-grounding/v1",
        status: "unknown",
        reasonCode: "ACTIVE_REQUIREMENT_UNRESOLVED",
        candidateComponentIds: ["unknown_component"]
      }
    }
  };

  const taskState = reduceTaskState({ observation, traveler: {} });

  assert.equal(taskState.profileReadiness.profileStage, true);
  assert.equal(taskState.profileReadiness.ready, true);
  assert.equal(taskState.profileReadiness.blockedReasonCode, "");
  assert.equal(taskState.profileReadiness.activeRequirementGrounding.status, "unknown");
  assert.equal(taskState.currentGoal, null);
});

test("age at departure uses the authoritative selected-booking baseline when the page date is abbreviated", () => {
  const ageControl = {
    controlId: "age_on_trip",
    surfaceId: "surface-page",
    label: "Age at time of travel",
    fieldType: "age_at_departure",
    role: "select",
    kind: "select-one",
    required: true,
    representationLifecycle: { status: "active_rendered", active: true },
    state: { valuePresent: false, selected: false, normalizedValue: "" },
    options: [
      { value: "18_24", label: "18–24" },
      { value: "25_29", label: "25–29" }
    ],
    operations: { select: capability("select", "age_on_trip") }
  };
  const observation = {
    observationId: "obs_age_from_booking_baseline",
    observationSnapshot: { snapshotHash: "hash_age_from_booking_baseline" },
    page: {
      url: "https://example.test/passengers",
      step: "traveler_information",
      heading: "Passenger details · 10 Aug",
      currentSurface: { id: "surface-page", type: "page", memberControlIds: ["age_on_trip"] },
      controls: [ageControl],
      fields: [{ ...ageControl, controlState: ageControl.state }],
      decisionGroups: [],
      validationIssues: []
    }
  };

  const taskState = reduceTaskState({
    observation,
    traveler: { id: "trav_1", date_of_birth: "2003-05-31" },
    transactionReview: readyTransactionReview()
  });

  assert.equal(taskState.profileReadiness.ready, false);
  assert.equal(taskState.currentGoal.semanticType, "age_at_departure");
  assert.equal(taskState.currentGoal.desiredValue, "23");
  assert.equal(taskState.currentGoal.inputValue, "18_24");
});

test("a canonically verified child choice durably satisfies its blank parent profile requirement", () => {
  const ageControl = {
    controlId: "age_on_trip_receipt",
    surfaceId: "surface-page",
    label: "Age at time of travel",
    fieldType: "age_at_departure",
    role: "editable_combobox",
    kind: "select",
    required: true,
    representationLifecycle: { status: "active_rendered", active: true },
    state: { valuePresent: false, selected: false, normalizedValue: "", invalid: false },
    options: [],
    operations: { open: capability("open", "age_on_trip_receipt_opener") }
  };
  const observation = {
    observationId: "obs_age_receipt_blank_parent",
    observationSnapshot: { snapshotHash: "hash_age_receipt_blank_parent" },
    page: {
      url: "https://example.test/passengers",
      step: "traveler_information",
      heading: "Passenger details",
      currentSurface: { id: "surface-page", type: "page", memberControlIds: [ageControl.controlId] },
      controls: [ageControl],
      fields: [{ ...ageControl, controlState: ageControl.state }],
      decisionGroups: [],
      validationIssues: []
    }
  };
  const traveler = { id: "trav_1", date_of_birth: "2003-05-31" };
  const initial = reduceTaskState({ observation, traveler, transactionReview: readyTransactionReview() });
  assert.equal(initial.currentGoal.semanticType, "age_at_departure");
  assert.equal(initial.currentGoal.desiredValue, "23");

  const logicalFieldId = initial.currentGoal.logicalFieldId;
  const actionResult = {
    actionId: "act_age_18_plus",
    observationId: "obs_age_options",
    resultObservationId: observation.observationId,
    dispatched: true,
    targetResolved: true,
    clickReachedPage: true,
    pageChanged: true,
    activeSurfaceChanged: true,
    verified: true,
    expectedOutcomeObserved: true,
    postconditionSatisfied: true,
    failureCode: "",
    mechanicalEffect: "set_field_value",
    action: {
      id: "act_age_18_plus",
      goalId: "profile:age_at_departure:0:surface:age-options:step:1",
      operation: "choose",
      mechanicalEffect: "set_field_value",
      controlId: "age_option_18_plus",
      targetId: "age_option_18_plus_node",
      value: "18+",
      targetLabel: "18+"
    },
    expectedOutcome: {
      type: "logical_component_committed",
      logicalFieldId,
      subjectId: "traveler_1",
      semanticType: "age_at_departure",
      componentRole: "value",
      controlId: ageControl.controlId,
      expectedCanonicalValue: "23",
      expectedNormalizedValue: "23",
      mustNotIncreasePrice: true
    },
    outcome: {
      ok: true,
      code: "LOGICAL_COMPONENT_COMMITTED",
      evidence: {
        exactChildSettlement: {
          contractVersion: "exact-child-choice-settlement/v1",
          settled: true,
          logicalFieldId,
          subjectId: "traveler_1",
          semanticType: "age_at_departure",
          componentRole: "value",
          parentControlId: ageControl.controlId,
          selectedControlId: "age_option_18_plus",
          selectedActuatorId: "age_option_18_plus_node",
          desiredCanonicalValue: "23",
          selectedCanonicalValue: "18+",
          actualStateBlank: true,
          validationClear: true,
          popupClosed: true,
          focusSettled: true
        }
      }
    }
  };
  assert.ok(verifiedProfileComponentFromActionResult(actionResult, observation.observationId));

  const settled = reduceTaskState({
    previousTaskState: initial,
    observation,
    previousActionResult: actionResult,
    traveler,
    transactionReview: readyTransactionReview()
  });
  assert.equal(settled.verifiedProfileComponents.length, 1);
  assert.equal(settled.verifiedProfileComponents[0].selectedCanonicalValue, "18+");
  assert.equal(settled.profileReadiness.ready, true);
  assert.equal(settled.currentGoal?.semanticType, undefined, JSON.stringify({
    completion: settled.verifiedProfileComponents[0],
    goal: settled.currentGoal,
    readiness: settled.profileReadiness
  }, null, 2));

  const persisted = reduceTaskState({
    previousTaskState: settled,
    observation: {
      ...observation,
      observationId: "obs_age_receipt_next_read",
      observationSnapshot: { snapshotHash: "hash_age_receipt_next_read" }
    },
    traveler,
    transactionReview: readyTransactionReview()
  });
  assert.equal(persisted.verifiedProfileComponents.length, 1);
  assert.equal(persisted.currentGoal?.semanticType, undefined);

  const contradictoryControl = {
    ...ageControl,
    state: { valuePresent: true, selected: true, normalizedValue: "17", invalid: true }
  };
  const contradicted = reduceTaskState({
    previousTaskState: persisted,
    observation: {
      ...observation,
      observationId: "obs_age_receipt_contradicted",
      observationSnapshot: { snapshotHash: "hash_age_receipt_contradicted" },
      page: {
        ...observation.page,
        controls: [contradictoryControl],
        fields: [{ ...contradictoryControl, controlState: contradictoryControl.state }],
        validationIssues: [{
          controlId: ageControl.controlId,
          message: "Select the passenger age",
          stageWide: false
        }]
      }
    },
    traveler,
    transactionReview: readyTransactionReview()
  });
  assert.equal(contradicted.verifiedProfileComponents.length, 0);
  assert.equal(contradicted.profileReadiness.ready, false);
});

test("popup closure without canonical verification cannot settle a profile requirement", () => {
  const result = verifiedProfileComponentFromActionResult({
    actionId: "act_weak_age_close",
    dispatched: true,
    targetResolved: true,
    clickReachedPage: true,
    failureCode: "LOGICAL_COMPONENT_NOT_COMMITTED",
    action: { operation: "choose", mechanicalEffect: "set_field_value", controlId: "age_18", value: "18+" },
    expectedOutcome: {
      type: "logical_component_committed",
      logicalFieldId: "lf_age",
      subjectId: "traveler_1",
      semanticType: "age_at_departure",
      componentRole: "value",
      controlId: "age_parent",
      expectedCanonicalValue: "23",
      mustNotIncreasePrice: true
    },
    outcome: {
      code: "LOGICAL_COMPONENT_NOT_COMMITTED",
      evidence: {
        choiceCommit: { ok: true, popupClosed: true, focusSettled: true }
      }
    }
  });
  assert.equal(result, null);
});

test("missing selected-flight date outranks semantic grounding and never asks the user for derived age", () => {
  const ageControl = {
    controlId: "age_on_trip_missing_booking",
    surfaceId: "surface-page",
    label: "Age at time of travel",
    fieldType: "age_at_departure",
    role: "select",
    kind: "select-one",
    required: true,
    representationLifecycle: { status: "active_rendered", active: true },
    state: { valuePresent: false, selected: false, normalizedValue: "" },
    options: [{ value: "18_24", label: "18–24" }],
    operations: { select: capability("select", "age_on_trip_missing_booking") }
  };
  const observation = {
    observationId: "obs_age_missing_selected_booking",
    observationSnapshot: { snapshotHash: "hash_age_missing_selected_booking" },
    page: {
      url: "https://example.test/passengers",
      step: "traveler_information",
      currentSurface: { id: "surface-page", type: "page", memberControlIds: [ageControl.controlId] },
      controls: [ageControl],
      fields: [{ ...ageControl, controlState: ageControl.state }],
      decisionGroups: [],
      validationIssues: [],
      activeRequirementGrounding: {
        status: "unknown",
        candidateComponentIds: [ageControl.controlId]
      }
    }
  };

  const taskState = reduceTaskState({
    observation,
    traveler: { id: "trav_1", date_of_birth: "2003-05-31" },
    transactionReview: { baseline: { itinerary: { completeness: "unknown", segments: [] } } }
  });

  assert.equal(taskState.profileReadiness.blockedReasonCode, "SELECTED_BOOKING_FACT_MISSING");
  assert.deepEqual(taskState.profileReadiness.missingDerivedFacts, [{
    semanticType: "age_at_departure",
    reasonCode: "SELECTED_BOOKING_FACT_MISSING",
    sourceField: "departure_date",
    sourcePath: "selected_booking.departure_date",
    label: "selected flight departure date"
  }]);
  assert.equal(taskState.currentGoal, null);
});
