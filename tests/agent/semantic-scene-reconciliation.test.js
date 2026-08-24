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
    operations: { type: { actuatorId: "act_unknown" } },
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
    obligationId: "unknown-required:ctrl_unknown",
    kind: "unknown_required",
    objective: "resolve the current unknown required control",
    authority: "task_state",
    admittedControlIds: controlIds,
    policyDecision: { status: "admitted" },
    subject: { decisionGroupId }
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
    control({ controlId: "ctrl_accept", role: "radio", kind: "radio", required: false, label: "Add protection", operations: { select: { actuatorId: "accept" } } }),
    control({ controlId: "ctrl_decline", role: "radio", kind: "radio", required: false, label: "Continue without", operations: { select: { actuatorId: "decline" } } })
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

  const compiled = agentContract.compileSemanticCheckout(reconciled.page);
  const decision = compiled.decisionGroups.find((group) => group.decisionGroupId === "dg_opaque_offer");
  assert.equal(decision.semanticOwnership.family, "insurance");
  assert.equal(decision.required, false);
  assert.equal(decision.status, "optional");
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

  assert.equal(reconciled.page.controls[0].fieldType, "first_name");
  assert.equal(reconciled.page.controls[0].fieldClassification.source, "grounded_semantic_scene");
  assert.equal(reconciled.page.validationIssues[0].controlId, "ctrl_unknown");
  assert.equal(reconciled.page.semanticSceneReconciliation.hypotheses.length, 1);
  assert.equal(reconciled.page.semanticSceneReconciliation.authority, "hypothesis_only");
});

test("an evidence-identical grounded binding is reused without another model request", () => {
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
  assert.equal(next.page.controls[0].fieldType, "first_name");
  assert.equal(next.page.controls[0].fieldClassification.source, "remembered_grounded_semantic_scene");
  assert.equal(semanticSceneUncertainty({ observation: next, traveler: { first_name: "Ali" } }).needed, false);
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
    assert.equal(payload.scene.currentObligation.obligationId, obligation.obligationId);
    assert.equal(payload.scene.components[0].rawEvidenceChannels.name, "opaque_1");
    assert.equal(payload.policyConstraints.declinePaidExtras, true);
    assert.deepEqual(payload.failedMethods, [{ operation: "open", method: "native_click", result: "NO_EFFECT" }]);
    assert.equal(payload.forbiddenConsequences.includes("grant_permission"), true);
    assert.equal(payload.allowedSemanticBindings.some((binding) => (
      binding.controlId === "ctrl_unknown"
      && binding.semanticType === "first_name"
      && binding.factSource === "profile.first_name"
    )), true);
    assert.equal(result.observation.page.controls[0].fieldType, "first_name");
    assert.equal(Object.hasOwn(result.reconciliation, "action"), false);
    assert.equal(Object.hasOwn(result.reconciliation, "permission"), false);
    assert.equal(Object.hasOwn(result.reconciliation, "completed"), false);
  } finally {
    global.fetch = previousFetch;
  }
});
