const test = require("node:test");
const assert = require("node:assert/strict");

const {
  semanticSceneUncertainty,
  applySemanticSceneHypotheses,
  reconcileSemanticScene
} = require("../../apps/web/agent/semantic-scene-reconciliation");

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
    traveler: { first_name: "Ali", last_name: "Sifrar" }
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

test("scene hypotheses may refine supplied evidence but cannot invent owners or facts", () => {
  const source = observation([control()], [{
    issueId: "validation_1",
    message: "Please enter the passenger detail",
    controlId: "",
    stageWide: false
  }]);
  const uncertainty = semanticSceneUncertainty({
    observation: source,
    traveler: { first_name: "Ali" }
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
    const result = await reconcileSemanticScene({
      apiKey: "test-key",
      model: "test-model",
      observation: source,
      traveler: { first_name: "Ali" }
    });
    const payload = JSON.parse(request.input[0].content[0].text);

    assert.equal(calls, 1);
    assert.equal(payload.outputAuthority, "grounded_hypothesis_only");
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
