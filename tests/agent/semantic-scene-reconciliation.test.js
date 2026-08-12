const test = require("node:test");
const assert = require("node:assert/strict");

const {
  semanticSceneUncertainty,
  semanticScenePayload,
  applySemanticSceneHypotheses,
  reconcileSemanticScene
} = require("../../apps/web/agent/semantic-scene-reconciliation");
const agentContract = require("../../apps/extension/src/shared/agent-contract");
const { buildCanonicalDecisions } = require("../../apps/web/agent/canonical-decision");

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

test("known profile work and global conditions copy do not invoke whole-scene reconciliation", () => {
  const known = control({
    controlId: "ctrl_email",
    label: "Email address",
    name: "email",
    fieldType: "email",
    semantic: "email"
  });
  const conditions = control({
    controlId: "ctrl_conditions",
    role: "button",
    kind: "button",
    label: "Purchase conditions",
    semantic: "choice",
    required: false,
    state: { required: false, valuePresent: true },
    operations: { activate: { actuatorId: "act_conditions" } }
  });
  const source = observation([known, conditions]);
  source.page.stageExit = { continueObserved: true, continueDisabled: false, navigationState: "ready" };
  const scene = semanticSceneUncertainty({
    observation: source,
    semanticCompilation: {
      controls: source.page.controls,
      decisionGroups: [],
      unownedMaterialControls: [known]
    },
    traveler: { email: "ali@example.test" }
  });

  assert.equal(scene.needed, false);
  assert.equal(scene.stageContradiction.contradictory, false);
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

test("zero-error summaries never request semantic reconciliation", () => {
  const scene = semanticSceneUncertainty({
    observation: observation([], [{
      issueId: "validation_zero",
      message: "0 error Please check the information below marked in red",
      controlId: "",
      stageWide: false
    }]),
    traveler: { first_name: "Ali" }
  });

  assert.equal(scene.needed, false);
  assert.deepEqual(scene.validationIssues, []);
});

test("the maximum semantic scene projection stays below its model packet budget", () => {
  const components = Array.from({ length: 8 }, (_, index) => control({
    controlId: `ctrl_unknown_${index}`,
    label: `Passenger information field ${index} ${"description ".repeat(40)}`,
    name: `opaque_${index}`,
    accessibleDescription: `Local helper ${"text ".repeat(60)}`
  }));
  const facts = Array.from({ length: 24 }, (_, index) => ({
    semanticType: `semantic_${index}`,
    factSource: `profile.fact_${index}`,
    valuePreview: `value_${index}_${"x".repeat(80)}`
  }));
  const payload = semanticScenePayload(observation(components), {
    components,
    facts,
    validationIssues: [{ issueId: "validation_1", message: "Please correct the highlighted field" }]
  });

  assert.ok(Buffer.byteLength(JSON.stringify(payload), "utf8") < 24_000);
  assert.equal(Object.hasOwn(payload, "allowedSemanticBindings"), false);
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
    stage: "traveler_information",
    stageConfidence: "high",
    stageEvidence: "The active scene contains traveler fields.",
    hypotheses: [{
      controlId: "ctrl_unknown",
      role: "profile_field",
      semanticType: "first_name",
      factSource: "profile.first_name",
      validationIssueId: "validation_1",
      relatedControlIds: [],
      requiredness: "html_required",
      consequence: "personal_attestation",
      confidence: "high",
      evidence: "The local passenger label and validation refer to the given name."
    }, {
      controlId: "invented_control",
      role: "profile_field",
      semanticType: "passport_number",
      factSource: "invented.fact",
      validationIssueId: "",
      relatedControlIds: [],
      requiredness: "html_required",
      consequence: "personal_attestation",
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
          stage: "traveler_information",
          stageConfidence: "high",
          stageEvidence: "The active scene contains traveler fields.",
          hypotheses: [{
            controlId: "ctrl_unknown",
            role: "profile_field",
            semanticType: "first_name",
            factSource: "profile.first_name",
            validationIssueId: "",
            relatedControlIds: [],
            requiredness: "html_required",
            consequence: "personal_attestation",
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
    assert.equal(payload.scene.components[0].controlId, "ctrl_unknown");
    assert.equal(payload.availableFacts.some((fact) => (
      fact.semanticType === "first_name" && fact.factSource === "profile.first_name"
    )), true);
    assert.equal(Object.hasOwn(payload, "allowedSemanticBindings"), false);
    assert.equal(Object.hasOwn(payload, "allowedValidationOwners"), false);
    assert.equal(result.observation.page.controls[0].fieldType, "first_name");
    assert.equal(Object.hasOwn(result.reconciliation, "action"), false);
    assert.equal(Object.hasOwn(result.reconciliation, "permission"), false);
    assert.equal(Object.hasOwn(result.reconciliation, "completed"), false);
  } finally {
    global.fetch = previousFetch;
  }
});

test("a contradictory Croatia PAY scene is reconciled without inventing a promotion-code profile obligation", () => {
  const controls = [
    control({ controlId: "promo", label: "Promotion code — Do you have a promotion code?", name: "promotion_code", required: true }),
    control({
      controlId: "decline_time",
      role: "button",
      kind: "button",
      label: "Time to think — No, thanks",
      required: false,
      state: { selected: false, checked: false, pressed: true },
      operations: { activate: { actuatorId: "act_decline", actionability: { executable: true } } }
    }),
    control({
      controlId: "accept_time",
      role: "button",
      kind: "button",
      label: "Time to think — Yes",
      required: false,
      state: { selected: false, checked: false },
      operations: { activate: { actuatorId: "act_accept", actionability: { executable: true } } }
    }),
    control({
      controlId: "terms",
      role: "checkbox",
      kind: "checkbox",
      label: "I agree with General Conditions of Carriage and purchase conditions",
      required: true,
      state: { required: true, checked: false },
      operations: { choose: { actuatorId: "act_terms", actionability: { executable: true } } }
    }),
    control({
      controlId: "confirm",
      role: "button",
      kind: "button",
      label: "CONFIRM",
      required: false,
      state: { disabled: false },
      operations: { activate: { actuatorId: "act_confirm", actionability: { executable: true, rendered: true, visible: true, enabled: true, inViewport: true, inCurrentSurface: true, hitTested: true, notOccluded: true } } }
    })
  ];
  const source = observation(controls);
  source.page.text = "3. PAY Payment Total to be paid EUR 141.62 Do you need time to think? Purchase conditions";
  source.page.price = { amount: 141.62, currency: "EUR" };
  source.page.terminalEvidence = { signals: { method: true, legal: true, review: true }, boundaryObserved: false };
  source.page.stageExit = { continueObserved: false, continueDisabled: false, candidates: [], blockers: ["Continue not observed"] };
  source.page.decisionGroups = [{
    decisionGroupId: "dg_broad_promotion_container",
    requirementId: "unknown:promotion_container",
    subject: "unknown",
    required: true,
    requiresResolution: true,
    alternatives: [{ controlId: "decline_time", label: "No, thanks" }, { controlId: "accept_time", label: "Yes" }]
  }];
  const compilation = agentContract.compileSemanticCheckout(source.page);
  const uncertainty = semanticSceneUncertainty({ observation: source, semanticCompilation: compilation, traveler: { first_name: "Ali" } });

  assert.equal(uncertainty.needed, true);
  assert.equal(uncertainty.stageContradiction.contradictory, true);
  assert.deepEqual(new Set(uncertainty.components.map((item) => item.controlId)), new Set(["decline_time", "accept_time", "confirm"]));

  const reconciled = applySemanticSceneHypotheses(source, {
    status: "grounded",
    stage: "unknown",
    stageConfidence: "low",
    stageEvidence: "The model did not resolve the stage.",
    hypotheses: [{
      controlId: "decline_time", role: "optional_paid_decline", semanticType: "paid_optional_product", factSource: "", validationIssueId: "", relatedControlIds: ["accept_time"], requiredness: "progression_required", consequence: "optional_paid", confidence: "high", evidence: "No, thanks declines the EUR 8 Time to Think product."
    }, {
      controlId: "accept_time", role: "optional_paid_accept", semanticType: "paid_optional_product", factSource: "", validationIssueId: "", relatedControlIds: ["decline_time"], requiredness: "progression_required", consequence: "optional_paid", confidence: "high", evidence: "Yes accepts the paid Time to Think product."
    }, {
      controlId: "confirm", role: "navigation", semanticType: "checkout_navigation", factSource: "", validationIssueId: "", relatedControlIds: [], requiredness: "progression_required", consequence: "navigation", confidence: "high", evidence: "Confirm advances from pre-payment review after the terms attestation."
    }]
  }, uncertainty);

  assert.equal(reconciled.page.step, "review");
  assert.equal(reconciled.page.controls.find((item) => item.controlId === "promo").required, false);
  assert.equal(reconciled.page.controls.find((item) => item.controlId === "promo").fieldClassification.source, "deterministic_optional_credential");
  assert.equal(reconciled.page.controls.find((item) => item.controlId === "terms").semanticSceneItem.role, "legal_attestation");
  assert.equal(reconciled.page.controls.find((item) => item.controlId === "terms").semanticSceneItem.deterministic, true);
  assert.equal(reconciled.page.stageExit.continueObserved, true);
  assert.equal(reconciled.page.stageExit.continueAllowed, false);
  assert.equal(reconciled.page.stageExit.navigationState, "blocked_by_legal_attestation");
  const compiled = agentContract.compileSemanticCheckout(reconciled.page);
  const standalone = buildCanonicalDecisions({ page: { ...reconciled.page, controls: compiled.controls, decisionGroups: [] } });
  assert.equal(standalone.some((decision) => decision.physicalControlIds?.includes("promo")), false);
  const timeDecision = compiled.decisionGroups.find((group) => group.subject === "optional_product");
  assert.ok(timeDecision);
  assert.equal(timeDecision.required, true);
  assert.equal(timeDecision.status, "satisfied");
  assert.equal(timeDecision.selectedControlId, "decline_time");
  assert.match(timeDecision.decisionGroupId, /^dg_scene_/);
  assert.equal(compiled.decisionGroups.filter((group) => (
    (group.alternatives || []).some((item) => item.controlId === "decline_time")
  )).length, 1);
  assert.equal(timeDecision.alternatives.find((item) => item.controlId === "decline_time").semantic, "decline_paid_extra");
});

test("a proven Croatia review scene uses zero semantic model calls", () => {
  const source = observation([
    control({ controlId: "promo", label: "Promotion code", name: "promotion_code", required: true }),
    control({
      controlId: "terms",
      role: "checkbox",
      kind: "checkbox",
      label: "I agree with General Conditions of Carriage and Purchase conditions",
      semantic: "choice",
      operations: { choose: { actuatorId: "act_terms", actionability: { executable: true } } }
    }),
    control({
      controlId: "confirm",
      role: "button",
      kind: "button",
      label: "CONFIRM",
      semantic: "unknown",
      required: false,
      state: { required: false },
      operations: { activate: { actuatorId: "act_confirm", actionability: { executable: true } } }
    }),
    control({
      controlId: "purchase_conditions",
      role: "button",
      kind: "button",
      label: "Purchase conditions",
      semantic: "unknown",
      required: false,
      state: { required: false },
      operations: { activate: { actuatorId: "act_purchase_conditions", actionability: { executable: true } } }
    })
  ]);
  source.page.step = "payment";
  source.page.text = "PAY CURRENT STEP Your booking Total to be paid EUR 141.62";
  source.page.terminalEvidence = {
    contractVersion: "terminal-evidence/v1",
    stage: "payment_review",
    boundaryObserved: true,
    verified: true,
    signals: { progress: true, review: true, legal: true, commit: true }
  };
  const compilation = agentContract.compileSemanticCheckout(source.page);
  const uncertainty = semanticSceneUncertainty({
    observation: source,
    semanticCompilation: compilation,
    traveler: { first_name: "Ali" }
  });

  assert.equal(compilation.semanticReadiness, agentContract.SEMANTIC_READINESS.TERMINAL);
  assert.equal(uncertainty.needed, false);
  assert.deepEqual(uncertainty.components, []);
});

test("an optional-looking age attestation may be grounded as progression-required from a supplied age fact", () => {
  const age = control({
    controlId: "age_attestation",
    role: "combobox",
    kind: "select",
    label: "Are you over 18?",
    required: false,
    state: { required: false, valuePresent: false },
    options: [{ value: "", label: "Choose" }, { value: "yes", label: "Yes" }, { value: "no", label: "No" }],
    operations: { choose: { actuatorId: "act_age" } }
  });
  const source = observation([age]);
  source.page.stageExit = { continueObserved: true, continueDisabled: true, candidates: [] };
  const uncertainty = semanticSceneUncertainty({
    observation: source,
    traveler: { age_at_departure: "28" }
  });
  const ageFact = uncertainty.facts.find((fact) => fact.semanticType === "age_at_departure");
  assert.ok(ageFact);
  const reconciled = applySemanticSceneHypotheses(source, {
    status: "grounded",
    stage: "traveler_information",
    stageConfidence: "high",
    stageEvidence: "The active traveler form contains an age eligibility question.",
    hypotheses: [{
      controlId: "age_attestation",
      role: "personal_attestation",
      semanticType: "age_at_departure",
      factSource: ageFact.factSource,
      validationIssueId: "",
      relatedControlIds: [],
      requiredness: "progression_required",
      consequence: "personal_attestation",
      confidence: "high",
      evidence: "The Yes/No control asks whether this traveler is over 18."
    }]
  }, uncertainty);
  const grounded = reconciled.page.controls[0];
  assert.equal(grounded.fieldType, "age_at_departure");
  assert.equal(grounded.required, true);
  assert.equal(grounded.semanticSceneItem.role, "personal_attestation");
});
