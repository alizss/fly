const test = require("node:test");
const assert = require("node:assert/strict");

const {
  semanticSceneUncertainty,
  applyRememberedSemanticBindings,
  rememberSemanticBindings,
  applySemanticSceneHypotheses,
  reconcileSemanticScene
} = require("../../apps/web/agent/semantic-scene-reconciliation");
const agentContract = require("../../apps/extension/src/shared/agent-contract");
const { compileDecisionFrame } = require("../../apps/web/agent/authority-frames");
const { buildCanonicalDecisions } = require("../../apps/web/agent/canonical-decision");
const { __private: { semanticReconciliationEligible } } = require("../../apps/web/agent/loop/orchestrator");

function executable(actuatorId) {
  return {
    status: "proven_executable",
    actuatorId,
    actionability: { executable: true }
  };
}

function control(overrides = {}) {
  return {
    controlId: "ctrl_unknown",
    role: "textbox",
    kind: "text",
    label: "Passenger detail",
    name: "opaque_1",
    fieldType: "",
    semantic: "",
    required: true,
    state: { required: true, valuePresent: false },
    representationLifecycle: { active: true, status: "active_rendered" },
    surfaceId: "surface-page",
    operations: { type: executable("act_unknown") },
    ...overrides
  };
}

function observation(controls, validationIssues = []) {
  return {
    observationId: "obs_scene",
    page: {
      step: "traveler_information",
      currentSurface: { id: "surface-page", type: "page", blocksBackground: false },
      controls,
      fields: controls.map((item) => ({ controlId: item.controlId, field: item.fieldType || "", fieldType: item.fieldType || "" })),
      validationIssues
    }
  };
}

function admittedObligation(controlIds = ["ctrl_unknown"], decisionGroupId = "") {
  return {
    contractVersion: "current-obligation/v3",
    id: "unknown-required:ctrl_unknown",
    objective: "resolve the current unknown required control",
    admittedControlIds: controlIds,
    delta: {
      kind: "unknown_required",
      subject: { family: "profile", decisionGroupId },
      authorization: { status: "admitted" }
    }
  };
}

test("known deterministic profile scenes do not request semantic reconciliation", () => {
  const known = control({
    controlId: "ctrl_first_name",
    label: "First name",
    name: "first_name",
    fieldType: "first_name",
    semantic: "first_name"
  });
  const scene = semanticSceneUncertainty({
    observation: observation([known]),
    traveler: { first_name: "Ali" }
  });
  assert.equal(scene.needed, false);
});

test("page-wide optional uncertainty cannot gate deterministic work", () => {
  const unresolvedFrame = {
    semanticCompilation: { semanticReadiness: "unresolved" },
    unresolvedEvidence: [{ kind: "unknown_optional_context" }]
  };
  const exactObligation = {
    contractVersion: "current-obligation/v3",
    desiredStateDelta: { status: "EXACT_DELTA", actionRequired: true },
    admittedControlIds: ["ctrl_title"]
  };

  assert.equal(semanticReconciliationEligible(unresolvedFrame, exactObligation), false);
  assert.equal(semanticReconciliationEligible(unresolvedFrame, null), false);
  assert.equal(semanticReconciliationEligible({
    semanticCompilation: { semanticReadiness: "unresolved" },
    unresolvedEvidence: [{
      kind: "unknown_validation",
      status: "unresolved",
      evidenceStrength: "strong"
    }]
  }), true);
  assert.equal(semanticReconciliationEligible({
    semanticCompilation: { semanticReadiness: "ready" },
    unresolvedEvidence: []
  }, exactObligation), false);
});

test("uncertain required controls and unowned validation produce a closed hypothesis surface", () => {
  const unknown = control({ semantic: "choice" });
  const scene = semanticSceneUncertainty({
    observation: observation([unknown], [{
      issueId: "validation_1",
      message: "Please enter the passenger detail",
      controlId: "",
      stageWide: false
    }]),
    traveler: { first_name: "Ali", last_name: "Sifrar" },
    currentObligation: admittedObligation()
  });

  assert.equal(scene.needed, true);
  assert.deepEqual(scene.components.map((item) => item.controlId), ["ctrl_unknown"]);
  assert.equal(scene.allowedBindings.some((binding) => (
    binding.controlId === "ctrl_unknown" && binding.semanticType === "first_name"
  )), true);
  assert.deepEqual(scene.allowedValidationOwners, [{
    validationIssueId: "validation_1",
    controlId: "ctrl_unknown"
  }]);
});

test("fresh stage-wide validation may be grounded to an exact observed non-profile control", () => {
  const terms = control({
    controlId: "ctrl_terms",
    role: "checkbox",
    kind: "checkbox",
    label: "I accept the booking terms and conditions",
    semantic: "legal_acceptance",
    fieldType: "",
    required: false,
    state: { required: false, checked: false, selected: false, valuePresent: false },
    operations: { select: executable("act_terms") }
  });
  const source = observation([terms], [{
    issueId: "validation_terms",
    message: "Please confirm the terms by clicking the checkbox",
    controlId: "",
    stageWide: true,
    status: "active_stage_error",
    active: true,
    introducedAfterAction: true
  }]);
  const uncertainty = semanticSceneUncertainty({ observation: source, traveler: {} });

  assert.equal(uncertainty.needed, true);
  assert.deepEqual(uncertainty.validationIssues.map((issue) => issue.issueId), ["validation_terms"]);
  assert.deepEqual(uncertainty.allowedValidationOwners, [{
    validationIssueId: "validation_terms",
    controlId: "ctrl_terms"
  }]);

  const reconciled = applySemanticSceneHypotheses(source, {
    status: "grounded",
    hypotheses: [{
      controlId: "ctrl_terms",
      semanticType: "unknown",
      factSource: "",
      validationIssueId: "validation_terms",
      confidence: "high",
      evidence: "The validation explicitly names the terms checkbox."
    }],
    decisionHypotheses: [],
    controlHypotheses: []
  }, uncertainty);

  assert.equal(reconciled.page.semanticFieldHints.length, 0);
  assert.deepEqual(reconciled.page.semanticValidationHints.map((hint) => ({
    validationIssueId: hint.validationIssueId,
    controlId: hint.controlId
  })), [{ validationIssueId: "validation_terms", controlId: "ctrl_terms" }]);
});

test("Croatia-shaped validation keeps No thanks selected and reopens only the grounded terms owner", () => {
  const terms = control({
    controlId: "ctrl_terms",
    role: "checkbox",
    kind: "checkbox",
    label: "Yes, I accept the booking terms and conditions",
    semantic: "",
    fieldType: "",
    required: false,
    state: { required: false, checked: false, selected: false, valuePresent: false },
    decisionGroupId: "dg_terms",
    operations: { select: executable("act_terms") }
  });
  const noThanks = control({
    controlId: "ctrl_no_thanks",
    role: "button",
    kind: "button",
    label: "No, thanks",
    semantic: "",
    fieldType: "",
    required: false,
    selected: true,
    state: { required: false, checked: true, selected: true, valuePresent: true },
    decisionGroupId: "dg_time_to_think",
    operations: { activate: executable("act_no_thanks") }
  });
  const yes = control({
    controlId: "ctrl_yes",
    role: "button",
    kind: "button",
    label: "Yes",
    semantic: "",
    fieldType: "",
    required: false,
    state: { required: false, checked: false, selected: false, valuePresent: true },
    decisionGroupId: "dg_time_to_think",
    operations: { activate: executable("act_yes") }
  });
  const source = observation([noThanks, yes, terms], [{
    issueId: "validation_terms",
    message: "Please check the terms and conditions and confirm by clicking the checkbox",
    controlId: "",
    stageWide: true,
    status: "active_stage_error",
    active: true,
    introducedAfterAction: true
  }]);
  source.page.observationContract = "structural-observation/v1";
  source.page.step = "payment";
  source.page.decisionGroups = [{
    decisionGroupId: "dg_time_to_think",
    sectionLabel: "Do you need time to think?",
    requiredStateObserved: false,
    selectedControlId: "ctrl_no_thanks",
    alternativeControlIds: ["ctrl_no_thanks", "ctrl_yes"],
    alternatives: [
      { controlId: "ctrl_no_thanks", label: "No, thanks", selected: true },
      { controlId: "ctrl_yes", label: "Yes", selected: false }
    ]
  }, {
    decisionGroupId: "dg_terms",
    sectionLabel: "Booking terms",
    requiredStateObserved: false,
    selectedControlId: "",
    alternativeControlIds: ["ctrl_terms"],
    alternatives: [{ controlId: "ctrl_terms", label: terms.label, selected: false }]
  }];

  const initialFrame = compileDecisionFrame({ observation: source });
  const initialDecisions = buildCanonicalDecisions({
    page: initialFrame.observation.page,
    userPolicy: { paidExtras: "decline", standardBookingTermsApproved: true }
  });
  assert.equal(initialDecisions.some((decision) => decision.actionReason === "fresh_validation"), false);

  const uncertainty = semanticSceneUncertainty({
    observation: initialFrame.observation,
    semanticCompilation: initialFrame.semanticCompilation,
    traveler: {}
  });
  assert.deepEqual(uncertainty.allowedValidationOwners.map((owner) => owner.controlId), ["ctrl_terms"]);
  const grounded = applySemanticSceneHypotheses(source, {
    status: "grounded",
    hypotheses: [{
      controlId: "ctrl_terms",
      semanticType: "unknown",
      factSource: "",
      validationIssueId: "validation_terms",
      confidence: "high",
      evidence: "The error explicitly requests the terms checkbox."
    }],
    decisionHypotheses: [],
    controlHypotheses: []
  }, uncertainty);
  const finalFrame = compileDecisionFrame({ observation: grounded });
  const decisions = buildCanonicalDecisions({
    page: finalFrame.observation.page,
    userPolicy: { paidExtras: "decline", standardBookingTermsApproved: true }
  });
  const timeToThink = decisions.find((decision) => decision.decisionGroupId === "dg_time_to_think");
  const legal = decisions.find((decision) => decision.decisionGroupId === "dg_terms");

  assert.equal(finalFrame.observation.page.validationIssues[0].controlId, "ctrl_terms");
  assert.equal(timeToThink.selectedControlId, "ctrl_no_thanks");
  assert.notEqual(timeToThink.actionReason, "fresh_validation");
  assert.equal(legal.actionReason, "fresh_validation");
  assert.equal(legal.needsAction, true);
  assert.deepEqual(legal.userIntent.desiredControlIds, ["ctrl_terms"]);
});

test("live-shaped generic validation excludes promotion and hidden controls when an executable typed owner exists", () => {
  const promotion = control({
    controlId: "ctrl_promotion",
    label: "Enter promotion code",
    name: "promotion_code",
    semantic: "unknown",
    fieldType: "",
    required: false,
    state: { required: false, valuePresent: false },
    operations: { type: executable("act_promotion") }
  });
  const terms = control({
    controlId: "ctrl_terms",
    role: "checkbox",
    kind: "checkbox",
    label: "Yes, I confirm the booking information and accept the terms and conditions",
    semantic: "legal_acceptance",
    fieldType: "",
    required: false,
    state: { required: false, checked: false, selected: false, valuePresent: false },
    operations: { choose: executable("act_terms") }
  });
  const hidden = control({
    controlId: "ctrl_hidden",
    label: "",
    semantic: "unknown",
    fieldType: "",
    required: false,
    state: { required: false, valuePresent: false },
    operations: {
      type: {
        status: "unavailable",
        actuatorId: "act_hidden",
        actionability: { executable: false, visible: false }
      }
    }
  });
  const source = observation([promotion, terms, hidden], [{
    issueId: "validation_summary",
    message: "1 error",
    controlId: "",
    stageWide: true,
    status: "active_stage_error",
    active: true,
    introducedAfterAction: true
  }]);

  const uncertainty = semanticSceneUncertainty({ observation: source, traveler: {} });

  assert.deepEqual(uncertainty.components.map((item) => item.controlId), ["ctrl_terms"]);
  assert.deepEqual(uncertainty.allowedValidationOwners, [{
    validationIssueId: "validation_summary",
    controlId: "ctrl_terms"
  }]);
});

test("an unfamiliar decision receives only a closed descriptive type and deterministic authority remains unchanged", () => {
  const source = observation([]);
  source.page.decisionGroups = [{
    decisionGroupId: "dg_opaque_offer",
    sectionType: "unknown",
    sectionLabel: "Protect this journey",
    subject: "unknown",
    required: false,
    material: true,
    status: "optional",
    alternatives: [
      { controlId: "ctrl_accept", label: "Add protection" },
      { controlId: "ctrl_decline", label: "Continue without" }
    ]
  }];
  source.page.controls = [
    control({ controlId: "ctrl_accept", role: "radio", kind: "radio", required: false, state: { required: false, valuePresent: true }, label: "Add protection", operations: { select: { actuatorId: "accept" } } }),
    control({ controlId: "ctrl_decline", role: "radio", kind: "radio", required: false, state: { required: false, valuePresent: true }, label: "Continue without", operations: { select: { actuatorId: "decline" } } })
  ];
  source.page.fields = [];
  const uncertainty = semanticSceneUncertainty({
    observation: source,
    traveler: {},
    currentObligation: admittedObligation(["ctrl_accept", "ctrl_decline"], "dg_opaque_offer")
  });
  assert.equal(uncertainty.needed, true);
  assert.equal(uncertainty.allowedDecisionBindings.some((binding) => (
    binding.decisionGroupId === "dg_opaque_offer" && binding.decisionType === "insurance"
  )), true);

  const reconciled = applySemanticSceneHypotheses(source, {
    status: "grounded",
    hypotheses: [],
    decisionHypotheses: [{
      decisionGroupId: "dg_opaque_offer",
      decisionType: "insurance",
      confidence: "high",
      evidence: "The local option pair offers journey protection and an explicit decline."
    }]
  }, uncertainty);
  assert.deepEqual(reconciled.page.semanticDecisionHints.map((hint) => hint.decisionType), ["insurance"]);
  assert.equal(Object.hasOwn(reconciled.page.semanticDecisionHints[0], "required"), false);
  assert.equal(Object.hasOwn(reconciled.page.semanticDecisionHints[0], "action"), false);

  const decisionFrame = compileDecisionFrame({
    observation: {
      ...reconciled,
      page: {
        ...reconciled.page,
        observationContract: "structural-observation/v1"
      }
    }
  });
  const decision = decisionFrame.semanticCompilation.decisionGroups.find((group) => group.decisionGroupId === "dg_opaque_offer");
  assert.equal(decision.semanticOwnership.family, "insurance");
  assert.equal(decision.required, false);
  assert.equal(decision.status, "optional");
});

test("a grounded control hypothesis excludes controls outside the structural decision owner", () => {
  const source = observation([]);
  source.page.step = "payment";
  source.page.controls = [
    control({
      controlId: "ctrl_card",
      role: "button",
      kind: "button",
      label: "Credit card / Debit card",
      semantic: "open_surface",
      fieldType: "",
      required: false,
      state: { valuePresent: true },
      operations: { activate: { actuatorId: "act_card" } }
    }),
    control({
      controlId: "ctrl_wallet",
      role: "button",
      kind: "button",
      label: "Apple Pay",
      semantic: "payment_method",
      fieldType: "",
      required: false,
      state: { valuePresent: true },
      operations: { activate: { actuatorId: "act_wallet" } }
    })
  ];
  source.page.fields = [];
  source.page.decisionGroups = [{
    decisionGroupId: "dg_payment_method",
    requirementId: "payment:payment-method",
    sectionType: "payment_method",
    subject: "payment_method",
    required: true,
    material: true,
    status: "missing",
    alternativeControlIds: ["ctrl_wallet"],
    alternatives: [{ controlId: "ctrl_wallet", label: "Apple Pay", semantic: "payment_method" }]
  }];

  const uncertainty = semanticSceneUncertainty({ observation: source, traveler: { payment_preference: "manual payment" } });
  assert.equal(uncertainty.needed, true);
  assert.equal(uncertainty.allowedControlIds.includes("ctrl_card"), false);
  assert.equal(uncertainty.allowedDecisionGroupIds.includes("dg_payment_method"), true);

  const reconciled = applySemanticSceneHypotheses(source, {
    status: "grounded",
    hypotheses: [],
    decisionHypotheses: [],
    controlHypotheses: [{
      controlId: "ctrl_card",
      semanticRole: "payment_method",
      decisionGroupId: "dg_payment_method",
      decisionType: "payment_method",
      consequenceClass: "payment_route",
      prerequisiteOf: "",
      expectedReversibleEffect: "reveal_control",
      confidence: "high",
      evidence: "The local control explicitly offers credit or debit card payment beside Apple Pay."
    }]
  }, uncertainty);

  assert.equal(reconciled.page.semanticSceneReconciliation.controlHypotheses.length, 0);
  assert.equal(reconciled.page.controls.find((item) => item.controlId === "ctrl_card").semantic, "open_surface");
  assert.deepEqual(reconciled.page.decisionGroups[0].alternativeControlIds, ["ctrl_wallet"]);
});

test("scene hypotheses may refine supplied evidence but cannot invent owners or facts", () => {
  const source = observation([control()], [{
    issueId: "validation_1",
    message: "Please enter the passenger detail",
    controlId: "",
    stageWide: false
  }]);
  const uncertainty = semanticSceneUncertainty({
    observation: source,
    traveler: { first_name: "Ali" },
    currentObligation: admittedObligation()
  });
  const reconciled = applySemanticSceneHypotheses(source, {
    status: "grounded",
    hypotheses: [{
      controlId: "ctrl_unknown",
      semanticType: "first_name",
      factSource: "profile.first_name",
      validationIssueId: "validation_1",
      confidence: "high",
      evidence: "The local passenger label and validation refer to the given name."
    }, {
      controlId: "invented_control",
      semanticType: "passport_number",
      factSource: "invented.fact",
      validationIssueId: "",
      confidence: "high",
      evidence: "Invented"
    }]
  }, uncertainty);

  assert.equal(reconciled.page.controls[0].fieldType, "");
  assert.equal(reconciled.page.validationIssues[0].controlId, "");
  assert.equal(reconciled.page.semanticFieldHints[0].semanticType, "first_name");
  assert.equal(reconciled.page.semanticValidationHints[0].controlId, "ctrl_unknown");
  assert.equal(reconciled.page.semanticSceneReconciliation.hypotheses.length, 1);
  assert.equal(reconciled.page.semanticSceneReconciliation.authority, "hypothesis_only");
  const frame = compileDecisionFrame({
    observation: {
      ...reconciled,
      page: { ...reconciled.page, observationContract: "structural-observation/v1" }
    }
  });
  assert.equal(frame.observation.page.controls[0].fieldType, "first_name");
  assert.equal(frame.observation.page.validationIssues[0].controlId, "ctrl_unknown");
});

test("an evidence-identical grounded profile binding is reused without another model request or generic decision", () => {
  const sourceControl = control({
    controlId: "ctrl_unknown_1",
    stableKey: "traveler|passenger_1|opaque_1",
    sectionId: "passenger_1",
    sectionType: "passenger",
    sectionLabel: "Passenger 1"
  });
  const source = observation([sourceControl]);
  const uncertainty = semanticSceneUncertainty({
    observation: source,
    traveler: { first_name: "Ali" },
    currentObligation: admittedObligation(["ctrl_unknown_1"])
  });
  const reconciled = applySemanticSceneHypotheses(source, {
    status: "grounded",
    hypotheses: [{
      controlId: "ctrl_unknown_1",
      semanticType: "first_name",
      factSource: "profile.first_name",
      validationIssueId: "",
      confidence: "high",
      evidence: "The local passenger label identifies the given name."
    }]
  }, uncertainty);
  const memory = rememberSemanticBindings([], reconciled);
  const nextControl = { ...sourceControl, controlId: "ctrl_unknown_2" };
  const next = applyRememberedSemanticBindings(observation([nextControl]), memory, {
    traveler: { first_name: "Ali" }
  });

  assert.equal(memory.length, 1);
  assert.equal(next.page.controls[0].fieldType, "");
  assert.equal(next.page.semanticFieldHints[0].semanticType, "first_name");
  const frame = compileDecisionFrame({
    observation: {
      ...next,
      page: { ...next.page, observationContract: "structural-observation/v1" }
    },
    traveler: { first_name: "Ali" }
  });
  assert.equal(frame.observation.page.controls[0].fieldType, "first_name");
  assert.equal(frame.semanticCompilation.semanticReadiness, "ready");
  assert.equal(frame.profileRequirements[0].semanticType, "first_name");
});

test("a grounded binding is invalidated when its local semantic evidence changes", () => {
  const sourceControl = control({
    stableKey: "traveler|passenger_1|opaque_1",
    sectionId: "passenger_1",
    sectionLabel: "Passenger 1"
  });
  const source = observation([sourceControl]);
  const uncertainty = semanticSceneUncertainty({
    observation: source,
    traveler: { first_name: "Ali" },
    currentObligation: admittedObligation()
  });
  const reconciled = applySemanticSceneHypotheses(source, {
    status: "grounded",
    hypotheses: [{
      controlId: "ctrl_unknown",
      semanticType: "first_name",
      factSource: "profile.first_name",
      validationIssueId: "",
      confidence: "high",
      evidence: "Passenger given name"
    }]
  }, uncertainty);
  const memory = rememberSemanticBindings([], reconciled);
  const changed = observation([{ ...sourceControl, label: "Passenger nationality", placeholder: "Choose country" }]);
  const next = applyRememberedSemanticBindings(changed, memory, { traveler: { first_name: "Ali" } });

  assert.equal(next.page.controls[0].fieldType, "");
  assert.equal(semanticSceneUncertainty({
    observation: next,
    traveler: { first_name: "Ali" },
    currentObligation: admittedObligation()
  }).needed, true);
});

test("an unchanged unresolved semantic signature is not sent to the model again", () => {
  const sourceControl = control({
    stableKey: "traveler|passenger_1|opaque_unresolved",
    sectionId: "passenger_1",
    sectionLabel: "Passenger 1"
  });
  const source = observation([sourceControl]);
  const memory = rememberSemanticBindings([], source, { unresolvedControls: [sourceControl] });
  const next = applyRememberedSemanticBindings(observation([{ ...sourceControl, controlId: "ctrl_unknown_rerender" }]), memory, {
    traveler: { first_name: "Ali" }
  });
  const uncertainty = semanticSceneUncertainty({
    observation: next,
    traveler: { first_name: "Ali" },
    currentObligation: admittedObligation(["ctrl_unknown_rerender"])
  });

  assert.equal(memory[0].status, "unresolved");
  assert.deepEqual(next.page.semanticUnresolvedControlIds, ["ctrl_unknown_rerender"]);
  assert.equal(uncertainty.needed, false);
});

test("an ambiguous scene uses one closed-ID hypothesis call and returns no action authority", async () => {
  const previousFetch = global.fetch;
  let calls = 0;
  let request = null;
  global.fetch = async (_url, options) => {
    calls += 1;
    request = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        status: "completed",
        model: "test-model",
        output_text: JSON.stringify({
          status: "grounded",
          hypotheses: [{
            controlId: "ctrl_unknown",
            semanticType: "first_name",
            factSource: "profile.first_name",
            validationIssueId: "",
            confidence: "high",
            evidence: "The local label asks for the passenger given name."
          }]
        }),
        usage: { input_tokens: 20, output_tokens: 12, total_tokens: 32 }
      })
    };
  };
  try {
    const source = observation([control()]);
    const uncertainty = semanticSceneUncertainty({
      observation: source,
      traveler: { first_name: "Ali" },
      currentObligation: admittedObligation()
    });
    const obligation = admittedObligation();
    const result = await reconcileSemanticScene({
      apiKey: "test-key",
      model: "test-model",
      observation: source,
      traveler: { first_name: "Ali" },
      currentObligation: obligation,
      policyConstraints: { bookingRules: "no paid extras", declinePaidExtras: true },
      failedMethods: [{ operation: "open", method: "native_click", result: "NO_EFFECT" }],
      uncertainty
    });
    const payload = JSON.parse(request.input[0].content[0].text);

    assert.equal(calls, 1);
    assert.equal(payload.outputAuthority, "grounded_hypothesis_only");
    assert.equal(Object.hasOwn(payload.scene, "stage"), false);
    assert.equal(payload.scene.currentObligation.id, obligation.id);
    assert.equal(payload.scene.components[0].rawEvidenceChannels.name, "opaque_1");
    assert.equal(payload.policyConstraints.declinePaidExtras, true);
    assert.deepEqual(payload.failedMethods, [{ operation: "open", method: "native_click", result: "NO_EFFECT" }]);
    assert.equal(payload.forbiddenConsequences.includes("grant_permission"), true);
    assert.deepEqual(payload.allowedSemanticBindings.controlIds, ["ctrl_unknown"]);
    assert.equal(payload.allowedSemanticBindings.semanticTypes.includes("first_name"), true);
    assert.equal(payload.allowedSemanticBindings.factSources.includes("profile.first_name"), true);
    assert.equal(result.observation.page.controls[0].fieldType, "");
    assert.equal(result.observation.page.semanticFieldHints[0].semanticType, "first_name");
    assert.equal(Object.hasOwn(result.reconciliation, "action"), false);
    assert.equal(Object.hasOwn(result.reconciliation, "permission"), false);
    assert.equal(Object.hasOwn(result.reconciliation, "completed"), false);
  } finally {
    global.fetch = previousFetch;
  }
});

test("a maximal unfamiliar scene sends closed enums without a Cartesian packet explosion", async () => {
  const previousFetch = global.fetch;
  let request = null;
  global.fetch = async (_url, options) => {
    request = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        status: "completed",
        model: "test-model",
        output_text: JSON.stringify({ status: "grounded", hypotheses: [], decisionHypotheses: [] }),
        usage: { input_tokens: 20, output_tokens: 4, total_tokens: 24 }
      })
    };
  };
  try {
    const controls = Array.from({ length: 12 }, (_, index) => control({
      controlId: `ctrl_opaque_${index + 1}`,
      label: `Required passenger checkout value ${index + 1} ${"opaque ".repeat(10)}`,
      name: `checkout.deeply.nested.opaque_${index + 1}`,
      semantic: "unknown",
      operations: { type: { actuatorId: `act_opaque_${index + 1}` } }
    }));
    const source = observation(controls);
    source.page.decisionGroups = Array.from({ length: 8 }, (_, index) => ({
      decisionGroupId: `dg_opaque_${index + 1}`,
      sectionType: "unknown",
      sectionLabel: `Unfamiliar required choice ${index + 1}`,
      subject: "unknown",
      required: true,
      material: true,
      alternatives: [{ controlId: controls[index].controlId, label: controls[index].label }]
    }));
    const traveler = {
      first_name: "Ali",
      last_name: "Sifrar",
      email: "ali@example.test",
      phone: "+38670111222",
      title: "MR",
      gender: "male",
      date_of_birth: "1990-01-01",
      nationality: "SI",
      country_of_residence: "SI",
      address_line1: "Test Street 1",
      postal_code: "1000",
      city: "Ljubljana"
    };
    const obligation = admittedObligation(controls.map((item) => item.controlId));
    const uncertainty = semanticSceneUncertainty({
      observation: source,
      traveler,
      currentObligation: obligation
    });

    assert.equal(uncertainty.allowedBindings.length > uncertainty.components.length, true);
    await reconcileSemanticScene({
      apiKey: "test-key",
      model: "test-model",
      observation: source,
      traveler,
      currentObligation: obligation,
      policyConstraints: { bookingRules: "no paid extras", declinePaidExtras: true },
      uncertainty
    });

    const prompt = request.input[0].content[0].text;
    const payload = JSON.parse(prompt);
    assert.equal(prompt.length < 24_000, true, `semantic scene prompt was ${prompt.length} characters`);
    assert.equal(payload.allowedSemanticBindings.controlIds.length, 12);
    assert.equal(Array.isArray(payload.allowedSemanticBindings.semanticTypes), true);
    assert.equal(Array.isArray(payload.allowedSemanticBindings.factSources), true);
    assert.equal(Array.isArray(payload.allowedDecisionBindings.decisionGroupIds), true);
    assert.equal(Array.isArray(payload.allowedDecisionBindings.decisionTypes), true);
  } finally {
    global.fetch = previousFetch;
  }
});
