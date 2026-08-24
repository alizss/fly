const test = require("node:test");
const assert = require("node:assert/strict");

const { callStructured } = require("../../apps/web/agent/openai-client");
const {
  activeUnknownComponents,
  applySemanticBinding,
  unknownComponentsForObligation,
  resolveActiveComponentSemantics
} = require("../../apps/web/agent/active-component-grounding");
const { selectCandidate } = require("../../apps/web/agent/select-candidate");
const {
  resolveSemanticOwnership,
  reusableSemanticOwnershipDecision,
  semanticOwnershipCacheEntry
} = require("./legacy-semantic-ownership-adapter");
const { reduceTaskState } = require("./task-state-replay-adapter");
const { actionForCurrentCandidate, buildCurrentCandidateSet } = require("./legacy-mechanics-binding-adapter");
const { evaluateTransition } = require("../../apps/web/agent/transition-evaluator");
const { __private: loopPrivate } = require("../../apps/web/agent/loop");
const { plannerFailureReason } = require("../../apps/web/agent/loop/turn-result");

test("planner authentication failures identify configuration instead of generic page uncertainty", () => {
  const reason = plannerFailureReason(new Error("OpenAI checkout_candidate_selection request failed: 401 Incorrect API key provided"));
  assert.match(reason, /API key was rejected/);
  assert.doesNotMatch(reason, /ask the user|multiple current candidates/i);
});

function activeUnknownProfileObservation() {
  return {
    observationId: "obs_unknown_profile_component",
    page: {
      step: "traveler_information",
      currentSurface: { id: "surface-page", type: "page", memberControlIds: ["mystery_age"] },
      controls: [{
        controlId: "mystery_age",
        surfaceId: "surface-page",
        role: "select",
        kind: "select-one",
        label: "Traveller category on flight date",
        required: true,
        representationLifecycle: { status: "active_rendered", active: true },
        state: { valuePresent: false, selected: false, checked: false },
        options: [{ value: "18_24", label: "18–24" }],
        operations: {
          select: {
            actuatorId: "mystery_age",
            status: "executable",
            strategies: [{ method: "native_select" }],
            actionability: { executable: true, rendered: true, visible: true, hitTested: true }
          }
        }
      }, {
        controlId: "dormant_template",
        surfaceId: "surface-page",
        role: "textbox",
        kind: "text",
        label: "Template value",
        required: true,
        representationLifecycle: { status: "dormant_hidden", active: false },
        state: { valuePresent: false },
        operations: { type: { actuatorId: "dormant_template", status: "unavailable" } }
      }],
      fields: [],
      validationIssues: [],
      selectedBooking: {
        itinerary: { segments: [{ departureDate: "2026-10-15" }] }
      }
    }
  };
}

test("active semantic grounding admits only the current lifecycle representation", () => {
  const components = activeUnknownComponents(activeUnknownProfileObservation(), {
    admittedControlIds: ["mystery_age"]
  });
  assert.deepEqual(components.map((component) => component.controlId), ["mystery_age"]);
});

test("unknown grounding can block only its exact admitted profile obligation", () => {
  const observation = activeUnknownProfileObservation();
  const preliminary = reduceTaskState({
    observation,
    traveler: { date_of_birth: "2003-05-31" }
  });
  const admitted = unknownComponentsForObligation(observation, preliminary.currentObligation);
  assert.deepEqual(admitted.map((component) => component.controlId), ["mystery_age"]);

  const groundedObservation = {
    ...observation,
    page: {
      ...observation.page,
      activeRequirementGrounding: {
        contractVersion: "active-component-semantic-grounding/v1",
        status: "unknown",
        reasonCode: "ACTIVE_REQUIREMENT_UNRESOLVED",
        candidateComponentIds: ["mystery_age"],
        evidence: "The exact admitted component does not expose enough traveler semantics."
      }
    }
  };
  const finalState = reduceTaskState({
    observation: groundedObservation,
    traveler: { date_of_birth: "2003-05-31" }
  });
  const candidateSet = buildCurrentCandidateSet({
    goal: finalState.currentGoal,
    observation: groundedObservation,
    traveler: { date_of_birth: "2003-05-31" },
    state: { taskState: finalState, approvals: {} }
  });

  assert.equal(finalState.currentObligation.policyDecision.status, "blocked");
  assert.equal(finalState.currentObligation.policyDecision.ambiguity.code, "ACTIVE_REQUIREMENT_UNRESOLVED");
  assert.equal(finalState.profileReadiness.ready, true);
  assert.deepEqual(candidateSet.candidates, []);
});

test("an unblocked executable stage exit suppresses unknown-component grounding authority", () => {
  const observation = activeUnknownProfileObservation();
  observation.page.stageExit = {
    continueAllowed: true,
    continueObserved: true,
    continueDisabled: false,
    navigationState: "ready",
    blockers: [],
    candidates: [{ controlId: "continue", status: "ready", executable: true }]
  };

  assert.deepEqual(activeUnknownComponents(observation, {
    admittedControlIds: ["mystery_age"]
  }), []);
});

test("disabled navigation does not promote a generic container into an active semantic requirement", () => {
  const observation = activeUnknownProfileObservation();
  observation.page.controls = [{
    controlId: "passenger_container",
    surfaceId: "surface-page",
    role: "textbox",
    kind: "input",
    label: "Passenger information",
    required: false,
    representationLifecycle: { status: "active_rendered", active: true },
    state: { valuePresent: false },
    operations: {
      type: {
        actuatorId: "passenger_container",
        actionability: { executable: true, rendered: true, visible: true, hitTested: true }
      }
    }
  }, {
    controlId: "continue",
    surfaceId: "surface-page",
    role: "button",
    kind: "button",
    label: "Continue",
    state: { disabled: true },
    operations: {}
  }];

  assert.deepEqual(activeUnknownComponents(observation, {
    admittedControlIds: ["passenger_container"]
  }), []);
});

test("bounded semantic grounding can only apply an exact supplied binding tuple", () => {
  const observation = activeUnknownProfileObservation();
  const bindings = [{
    componentId: "mystery_age",
    semanticType: "age_at_departure",
    factSource: "derived_fact.age_at_departure"
  }];
  const accepted = applySemanticBinding(observation, {
    status: "bound",
    componentId: "mystery_age",
    semanticType: "age_at_departure",
    factSource: "derived_fact.age_at_departure",
    confidence: "high",
    evidence: "Local label asks for category on the flight date."
  }, bindings);
  const rejected = applySemanticBinding(observation, {
    status: "bound",
    componentId: "invented_component",
    semanticType: "age_at_departure",
    factSource: "derived_fact.age_at_departure",
    confidence: "high",
    evidence: "Invented target."
  }, bindings);

  assert.equal(accepted.page.controls[0].fieldType, "age_at_departure");
  assert.equal(accepted.page.activeRequirementGrounding.status, "bound");
  assert.equal(rejected.page.activeRequirementGrounding.status, "unknown");
  assert.equal(rejected.page.activeRequirementGrounding.reasonCode, "ACTIVE_REQUIREMENT_UNRESOLVED");
});

test("obligation-scoped grounding sends a binding-only InteractionView and returns no browser action", async () => {
  const previousFetch = global.fetch;
  let request = null;
  global.fetch = async (_url, options) => {
    request = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        status: "completed",
        model: "test-model",
        output_text: JSON.stringify({
          status: "bound",
          componentId: "mystery_age",
          semanticType: "age_at_departure",
          factSource: "derived_fact.age_at_departure",
          confidence: "high",
          evidence: "The active local label asks for the traveller category on the flight date."
        }),
        usage: { input_tokens: 20, output_tokens: 12, total_tokens: 32 }
      })
    };
  };
  try {
    const result = await resolveActiveComponentSemantics({
      apiKey: "test-key",
      model: "test-model",
      observation: activeUnknownProfileObservation(),
      traveler: { date_of_birth: "2003-05-31" },
      admittedControlIds: ["mystery_age"]
    });
    const payload = JSON.parse(request.input[0].content[0].text);

    assert.equal(payload.outputAuthority, "binding_hypothesis_only");
    assert.equal(payload.interactionView.allowedSemanticBindings.some((binding) => (
      binding.componentId === "mystery_age"
      && binding.semanticType === "age_at_departure"
      && binding.factSource === "derived_fact.age_at_departure"
    )), true);
    assert.equal(Object.hasOwn(result.resolution, "action"), false);
    assert.equal(result.observation.page.controls[0].fieldType, "age_at_departure");
  } finally {
    global.fetch = previousFetch;
  }
});

test("a GoToGate paid bundle cannot enter profile grounding ahead of its admitted free decline", () => {
  const choiceCapability = (controlId) => ({
    choose: {
      actuatorId: controlId,
      status: "executable",
      strategies: [{ method: "native_click" }],
      actionability: {
        executable: true,
        rendered: true,
        visible: true,
        hitTested: true,
        notOccluded: true
      }
    }
  });
  const paid = [29, 41, 46].map((amount, index) => ({
    controlId: `bundle_paid_${index}`,
    surfaceId: "surface-page",
    role: "radio",
    kind: "radio",
    label: `Bundle ${amount} EUR`,
    semantic: "add_paid_extra",
    physicalEffect: "select_paid_option",
    risk: "money",
    required: true,
    representationLifecycle: { status: "active_rendered", active: true },
    state: { valuePresent: false, selected: false, checked: false, required: true },
    structuredPrice: { amount, currency: "EUR" },
    operations: choiceCapability(`bundle_paid_${index}`)
  }));
  const decline = {
    controlId: "bundle_no_thanks",
    surfaceId: "surface-page",
    role: "checkbox",
    kind: "checkbox",
    label: "No, thanks — continue without bundle",
    semantic: "decline_paid_extra",
    physicalEffect: "select_free_option",
    risk: "safe_decline",
    required: false,
    representationLifecycle: { status: "active_rendered", active: true },
    state: { valuePresent: false, selected: false, checked: false },
    operations: choiceCapability("bundle_no_thanks")
  };
  const observation = {
    observationId: "obs_gotogate_bundle_after_profile",
    page: {
      url: "https://en-en.gotogate.com/rf/traveler-details",
      step: "traveler_information",
      currentSurface: { id: "surface-page", type: "page" },
      controls: [...paid, decline],
      fields: [],
      validationIssues: [],
      decisionGroups: [{
        decisionGroupId: "gotogate_bundle",
        requirementId: "bundle:travel_essentials",
        surfaceId: "surface-page",
        sectionType: "bundle",
        sectionLabel: "Add a bundle with your travel essentials",
        required: false,
        status: "optional",
        alternatives: [...paid, decline].map((control) => ({
          controlId: control.controlId,
          label: control.label,
          semantic: control.semantic,
          physicalEffect: control.physicalEffect,
          risk: control.risk,
          structuredPrice: control.structuredPrice || null,
          selected: false
        }))
      }]
    }
  };
  const taskState = reduceTaskState({
    observation,
    userPolicy: { bookingRules: "No support bundles and no paid extras." },
    traveler: { booking_rules: "No support bundles and no paid extras." }
  });

  assert.deepEqual(
    activeUnknownComponents(observation, { admittedControlIds: paid.map((control) => control.controlId) })
      .map((control) => control.controlId),
    paid.map((control) => control.controlId)
  );
  assert.deepEqual(taskState.currentObligation.admittedControlIds, [decline.controlId]);
  assert.equal(taskState.currentObligation.subject.family, "extras");
  assert.deepEqual(unknownComponentsForObligation(observation, taskState.currentObligation), []);
});

test("authenticated empty model output is retried before being reported as unavailable", async () => {
  const previousFetch = global.fetch;
  const requests = [];
  global.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    if (requests.length === 1) {
      return {
        ok: true,
        json: async () => ({
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          output: []
        })
      };
    }
    return {
      ok: true,
      json: async () => ({
        status: "completed",
        model: "test-model",
        output_text: JSON.stringify({ candidateId: "obs_1:candidate_2" }),
        usage: { input_tokens: 20, output_tokens: 8, total_tokens: 28 }
      })
    };
  };

  try {
    const result = await callStructured({
      apiKey: "test-key",
      model: "test-model",
      instructions: "Select one candidate.",
      payload: { candidates: ["obs_1:candidate_2"] },
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["candidateId"],
        properties: { candidateId: { type: "string", enum: ["obs_1:candidate_2"] } }
      },
      schemaName: "checkout_candidate_selection",
      maxOutputTokens: 400,
      returnMeta: true
    });

    assert.equal(requests.length, 2);
    assert.equal(requests[0].max_output_tokens, 400);
    assert.equal(requests[1].max_output_tokens, 1800);
    assert.equal(result.data.candidateId, "obs_1:candidate_2");
    assert.equal(result.meta.attempts, 2);
    assert.equal(result.meta.total_tokens, 28);
  } finally {
    global.fetch = previousFetch;
  }
});

test("ambiguity selection exposes blocked context but schema permits only safe candidate IDs", async () => {
  const previousFetch = global.fetch;
  let request = null;
  global.fetch = async (_url, options) => {
    request = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        status: "completed",
        model: "test-model",
        output_text: JSON.stringify({
          candidateId: "candidate_close",
          semanticOutcome: "dismiss_current_surface",
          confidence: "high"
        }),
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
      })
    };
  };
  try {
    const safe = {
      candidateId: "candidate_close",
      controlId: "ctrl_close",
      targetLabel: "Close",
      type: "click",
      operation: "activate",
      risk: "safe",
      policyDecision: { allow: true, decision: "allow" }
    };
    const paid = {
      candidateId: "candidate_upgrade",
      controlId: "ctrl_upgrade",
      targetLabel: "Upgrade for €30",
      type: "click",
      operation: "activate",
      risk: "money",
      structuredPrice: { amount: 30, currency: "EUR" },
      policyDecision: { allow: false, decision: "deny", reason: "Paid extra blocked." }
    };
    const result = await selectCandidate({
      apiKey: "test-key",
      model: "test-model",
      goal: { goalId: "goal_popup", semanticType: "surface_ambiguity", desiredValue: "safe_progress" },
      taskState: {
        stage: "extras",
        foregroundSurface: { id: "popup", type: "modal" },
        activeDecisions: [],
        validationBlockers: [],
        completedOutcomes: [],
        terminalStatus: "active"
      },
      candidates: [safe],
      contextCapabilities: [
        { ...safe, capabilityId: "ctrl_close::activate", policyStatus: "allowed", selectable: true },
        { ...paid, capabilityId: "ctrl_upgrade::activate", policyStatus: "deny", selectable: false }
      ],
      observation: { observationId: "obs_popup" }
    });
    const payload = JSON.parse(request.input[0].content[0].text);
    const schema = request.text.format.schema;

    assert.equal(payload.interactionView.contractVersion, "interaction-view/v1");
    assert.equal(payload.interactionView.components.length, 2);
    assert.equal(Object.hasOwn(payload.interactionView, "stage"), false);
    assert.deepEqual(
      payload.interactionView.components.flatMap((component) => component.actuators).map((actuator) => actuator.selectable),
      [true, false]
    );
    assert.equal(payload.interactionView.components[1].actuators[0].blockedBy, "policy:deny");
    assert.deepEqual(payload.selectableCandidates.map((candidate) => candidate.candidateId), ["candidate_close"]);
    assert.deepEqual(schema.properties.candidateId.enum, ["candidate_close"]);
    assert.equal(schema.properties.candidateId.enum.includes("candidate_upgrade"), false);
    assert.equal(result.candidateId, "candidate_close");
    assert.equal(result.confidence, "high");
  } finally {
    global.fetch = previousFetch;
  }
});

test("an empty current candidate set never calls OpenAI", async () => {
  const previousFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    throw new Error("fetch must not run");
  };
  try {
    await assert.rejects(
      selectCandidate({
        apiKey: "test-key",
        model: "test-model",
        goal: { goalId: "goal_bundle", semanticGoal: "decline bundle" },
        candidates: [],
        observation: { observationId: "obs_empty" }
      }),
      (error) => error.code === "NO_CURRENT_CANDIDATES"
    );
    assert.equal(calls, 0);
  } finally {
    global.fetch = previousFetch;
  }
});

test("every model call rejects packets above the hard serialized budget before fetch", async () => {
  const previousFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls += 1; };
  try {
    await assert.rejects(
      () => callStructured({
        apiKey: "test-key",
        model: "test-model",
        instructions: "bounded",
        payload: { oversized: "x".repeat(40_000) },
        schema: { type: "object", additionalProperties: false, properties: {} },
        schemaName: "oversized_packet"
      }),
      (error) => error.code === "MODEL_PACKET_TOO_LARGE" && error.packetBytes > error.maxPayloadBytes
    );
    assert.equal(calls, 0);
  } finally {
    global.fetch = previousFetch;
  }
});

test("candidate AI receives at most twenty related DOM controls and no screenshot when DOM evidence is sufficient", async () => {
  const previousFetch = global.fetch;
  let request = null;
  global.fetch = async (_url, options) => {
    request = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        status: "completed",
        output_text: JSON.stringify({
          candidateId: "candidate_0",
          semanticOutcome: "satisfy_current_decision",
          confidence: "high"
        })
      })
    };
  };
  const candidates = Array.from({ length: 25 }, (_, index) => ({
    candidateId: `candidate_${index}`,
    capabilityId: `ctrl_${index}::activate`,
    controlId: `ctrl_${index}`,
    targetLabel: `Grounded option ${index}`,
    type: "click",
    operation: "activate",
    risk: "safe",
    selectable: true,
    policyDecision: { allow: true, decision: "allow" },
    visualRegion: { x: 1, y: 1, width: 20, height: 20 }
  }));
  try {
    await selectCandidate({
      apiKey: "test-key",
      model: "test-model",
      goal: { goalId: "goal_bounded", semanticType: "decision" },
      taskState: { stage: "extras", currentGoal: { goalId: "goal_bounded", semanticType: "decision" } },
      candidates,
      contextCapabilities: candidates,
      observation: { observationId: "obs_bounded" },
      screenshotDataUrl: "data:image/png;base64,AAAA"
    });
    const content = request.input[0].content;
    const payload = JSON.parse(content.find((item) => item.type === "input_text").text);
    assert.equal(payload.selectableCandidates.length, 20);
    assert.equal(payload.interactionView.components.length, 20);
    assert.ok(Buffer.byteLength(JSON.stringify(payload), "utf8") < 24_000);
    assert.equal(content.some((item) => item.type === "input_image"), false);
  } finally {
    global.fetch = previousFetch;
  }
});

test("adaptive candidate AI compacts verbose surfaces before the hard packet boundary", async () => {
  const previousFetch = global.fetch;
  let request = null;
  global.fetch = async (_url, options) => {
    request = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        status: "completed",
        output_text: JSON.stringify({
          candidateId: "candidate_visible_choice",
          semanticOutcome: "satisfy_current_decision",
          confidence: "medium"
        })
      })
    };
  };
  const verboseCountryList = Array.from({ length: 260 }, (_, index) => (
    `Country ${index + 1} (+${100 + index})`
  )).join(" ");
  const candidate = {
    candidateId: "candidate_visible_choice",
    capabilityId: "ctrl_visible_choice::choose",
    controlId: "ctrl_visible_choice",
    targetLabel: "Current reversible choice",
    meaning: "current reversible choice",
    type: "click",
    operation: "choose",
    risk: "safe",
    selectable: true,
    policyDecision: { allow: true, decision: "allow" }
  };
  try {
    const result = await selectCandidate({
      apiKey: "test-key",
      model: "test-model",
      goal: {
        kind: "adaptive_surface",
        goalId: "goal_adaptive_verbose",
        semanticType: "phone_country_code",
        semanticGoal: `Choose +386 from ${verboseCountryList}`,
        desiredValue: "+386",
        adaptiveEnvelope: {
          kind: "bounded_adaptive_surface",
          episodeId: "episode_verbose",
          objective: `Choose +386 from ${verboseCountryList}`,
          desiredValue: "+386",
          surfaceId: "surface_country_list",
          surfaceType: "dropdown",
          allowedOperations: ["choose", "keyboard"],
          forbiddenRisks: ["money", "payment", "legal"],
          forbiddenEffects: ["select_paid_option", "submit_payment"],
          remainingSteps: 5,
          deadlineAt: Date.now() + 20_000
        }
      },
      taskState: {
        stage: "traveler_information",
        foregroundSurface: {
          id: "surface_country_list",
          type: "dropdown",
          label: verboseCountryList,
          blocksBackground: true,
          options: Array.from({ length: 260 }, (_, index) => ({ label: `Country ${index}` }))
        },
        currentGoal: {
          goalId: "goal_adaptive_verbose",
          semanticType: "phone_country_code",
          semanticGoal: `Choose +386 from ${verboseCountryList}`
        }
      },
      candidates: [candidate],
      contextCapabilities: [candidate],
      observation: { observationId: "obs_adaptive_verbose" },
      screenshotDataUrl: "data:image/png;base64,AAAA"
    });
    const content = request.input[0].content;
    const payload = JSON.parse(content.find((item) => item.type === "input_text").text);
    assert.equal(result.candidateId, candidate.candidateId);
    assert.ok(Buffer.byteLength(JSON.stringify(payload), "utf8") < 24_000);
    assert.equal(payload.interactionView.currentObligation.semanticType, "phone_country_code");
    assert.ok(payload.interactionView.foregroundSurface.label.length <= 240);
    assert.ok(payload.interactionView.currentObligation.adaptiveEnvelope.objective.length <= 240);
  } finally {
    global.fetch = previousFetch;
  }
});

test("semantic ambiguity can only resolve an observed decision group and its owned control", async () => {
  const previousFetch = global.fetch;
  let request = null;
  global.fetch = async (_url, options) => {
    request = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        status: "completed",
        model: "test-model",
        output_text: JSON.stringify({
          decisionGroupId: "dg_selected_item",
          controlId: "ctrl_remove",
          family: "seat",
          requirement: "optional",
          priceDisposition: "paid",
          policyCompatibility: "conflict",
          intendedOutcome: "remove_paid_selection",
          confidence: "high",
          rationale: "The selected paid item is shown on the current seat-selection surface."
        }),
        usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 }
      })
    };
  };
  try {
    const observation = {
      observationId: "obs_semantic_ambiguity",
      page: {
        step: "seats",
        currentSurface: { id: "surface-page", type: "page", label: "Reserve seating" },
        sections: [{ id: "section_traveler", type: "passenger", label: "Traveller information" }],
        controls: [{
          controlId: "ctrl_remove",
          decisionGroupId: "dg_selected_item",
          label: "Remove",
          semantic: "remove_paid_extra",
          physicalEffect: "select_free_option",
          risk: "safe_decline",
          surfaceId: "surface-page",
          stateElementId: "remove-node",
          preferredActivationElementId: "remove-node",
          operations: {
            activate: {
              operation: "activate",
              actuatorId: "remove-node",
              actuatorIds: ["remove-node"],
              actionability: {
                executable: true,
                revealable: false,
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
                code: "ACTIONABLE"
              }
            }
          }
        }],
        decisionGroups: [{
          decisionGroupId: "dg_selected_item",
          sectionType: "unknown",
          sectionLabel: "Selected item",
          surfaceId: "surface-page",
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
          alternatives: [{ controlId: "ctrl_remove" }]
        }]
      }
    };
    const result = await resolveSemanticOwnership({
      apiKey: "test-key",
      model: "test-model",
      observation,
      userPolicy: { bookingRules: "No paid seats" },
      traveler: { booking_rules: "No paid seats" }
    });
    const group = result.observation.page.decisionGroups[0];
    const payload = JSON.parse(request.input[0].content[0].text);
    const schema = request.text.format.schema;

    assert.equal(group.sectionType, "unknown");
    assert.deepEqual(group.semanticOwnership, {
      status: "hypothesis",
      authority: "interpretation_only",
      browserFactsMutated: false,
      family: "seat",
      source: "grounded_ai",
      controlId: "ctrl_remove",
      requirement: "optional",
      priceDisposition: "paid",
      policyCompatibility: "conflict",
      confidence: "high",
      intendedOutcome: "remove_paid_selection",
      rationale: "The selected paid item is shown on the current seat-selection surface."
    });
    assert.deepEqual(schema.properties.decisionGroupId.enum, ["dg_selected_item"]);
    assert.deepEqual(schema.properties.controlId.enum, ["ctrl_remove"]);
    assert.deepEqual(schema.properties.requirement.enum, ["required", "optional", "unknown"]);
    assert.deepEqual(schema.properties.priceDisposition.enum, ["paid", "free", "unknown"]);
    assert.deepEqual(schema.properties.policyCompatibility.enum, ["conflict", "compatible", "unknown"]);
    assert.deepEqual(schema.properties.intendedOutcome.enum, ["remove_paid_selection", "select_free_alternative", "deselect_paid_selection", "open_correction_surface", "unknown"]);
    assert.equal(payload.currentSurface.label, "Reserve seating");
    assert.equal(payload.ambiguousSelections[0].price.amount, 26);

    const taskState = reduceTaskState({
      observation: result.observation,
      userPolicy: { bookingRules: "No paid seats" },
      traveler: { booking_rules: "No paid seats" }
    });
    const candidateSet = buildCurrentCandidateSet({
      goal: taskState.currentGoal,
      observation: result.observation,
      traveler: { booking_rules: "No paid seats" },
      state: { taskState, approvals: {} }
    });
    assert.equal(taskState.currentGoal.decisionGroupId, "dg_selected_item");
    assert.deepEqual(taskState.currentGoal.freeAlternativeControlIds, ["ctrl_remove"]);
    assert.deepEqual(candidateSet.candidates.map((candidate) => candidate.controlId), ["ctrl_remove"]);
  } finally {
    global.fetch = previousFetch;
  }
});

test("diagnostic semantic grounding cannot manufacture a transaction conflict", async () => {
  const previousFetch = global.fetch;
  let request = null;
  global.fetch = async (_url, options) => {
    request = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        status: "completed",
        model: "test-model",
        output_text: JSON.stringify({
          decisionGroupId: "dg_live_paid_summary",
          controlId: "ctrl_live_reversal",
          family: "seat",
          requirement: "optional",
          priceDisposition: "paid",
          policyCompatibility: "conflict",
          intendedOutcome: "remove_paid_selection",
          confidence: "high",
          rationale: "The current foreground surface shows one selected paid item and its exact reversal."
        }),
        usage: { input_tokens: 24, output_tokens: 12, total_tokens: 36 }
      })
    };
  };
  try {
    const observation = {
      observationId: "obs_live_missing_semantics",
      page: {
        step: "seats",
        currentSurface: {
          id: "flow_modal",
          type: "modal",
          label: "Current selection",
          memberControlIds: ["ctrl_live_reversal", "ctrl_live_advance"]
        },
        controls: [
          {
            controlId: "ctrl_live_reversal",
            decisionGroupId: "dg_live_paid_summary",
            label: "Undo",
            semantic: "remove_paid_extra",
            physicalEffect: "select_free_option",
            risk: "safe_decline",
            surfaceId: "flow_modal",
            stateElementId: "undo-node",
            preferredActivationElementId: "undo-node",
            operations: {
              activate: {
                operation: "activate",
                actuatorId: "undo-node",
                actuatorIds: ["undo-node"],
                actionability: {
                  executable: true,
                  revealable: false,
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
                  code: "ACTIONABLE"
                }
              }
            }
          },
          {
            controlId: "ctrl_live_advance",
            label: "Proceed",
            semantic: "navigation",
            physicalEffect: "advance_surface",
            risk: "safe_continue",
            surfaceId: "flow_modal",
            stateElementId: "advance-node",
            preferredActivationElementId: "advance-node",
            operations: {
              activate: {
                operation: "activate",
                actuatorId: "advance-node",
                actuatorIds: ["advance-node"],
                actionability: {
                  executable: true,
                  revealable: false,
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
                  code: "ACTIONABLE"
                }
              }
            }
          }
        ],
        decisionGroups: [{
          decisionGroupId: "dg_live_paid_summary",
          sectionType: "unknown",
          sectionLabel: "Traveller information",
          surfaceId: "flow_modal",
          status: "satisfied",
          selectedControlId: "",
          selectedLabel: "Chosen item 23 EUR",
          selectedSemantic: "selected_paid_item",
          selectedEvidence: null,
          semanticOwnership: null,
          removalControlId: null,
          alternativeControlIds: ["ctrl_live_reversal"]
        }],
        transactionFacts: {
          selectedExtras: [{
            decisionGroupId: "dg_live_paid_summary",
            label: "Chosen item 23 EUR",
            disposition: "paid",
            priceAmount: 23,
            currency: "EUR"
          }]
        },
        validationIssues: []
      }
    };
    const traveler = { booking_rules: "No paid extras" };
    const resolved = await resolveSemanticOwnership({
      apiKey: "test-key",
      model: "test-model",
      observation,
      userPolicy: { bookingRules: traveler.booking_rules },
      traveler
    });

    assert.ok(request, "semantic ownership model should run for transaction-backed paid evidence");
    const payload = JSON.parse(request.input[0].content[0].text);
    assert.equal(payload.ambiguousSelections[0].price.amount, 23);
    assert.equal(resolved.resolution.controlId, "ctrl_live_reversal");

    const taskState = reduceTaskState({
      observation: resolved.observation,
      userPolicy: { bookingRules: traveler.booking_rules },
      traveler
    });
    const candidates = buildCurrentCandidateSet({
      goal: taskState.currentGoal,
      observation: resolved.observation,
      traveler,
      state: { taskState, approvals: {} }
    });
    assert.equal(taskState.activeDecisions[0].status, "active");
    assert.equal(taskState.currentGoal.decisionGroupId, "dg_live_paid_summary");
    assert.deepEqual(candidates.candidates.map((candidate) => candidate.controlId), ["ctrl_live_reversal"]);
    assert.equal(candidates.contextCapabilities.find((candidate) => candidate.controlId === "ctrl_live_advance"), undefined);
  } finally {
    global.fetch = previousFetch;
  }
});

test("cross-surface ownership maps a background paid fact to the exact foreground correction before navigation", async () => {
  const previousFetch = global.fetch;
  let request = null;
  const executable = (actuatorId) => ({
    activate: {
      operation: "activate",
      actuatorId,
      actuatorIds: [actuatorId],
      actionability: {
        executable: true,
        revealable: false,
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
        code: "ACTIONABLE"
      }
    }
  });
  global.fetch = async (_url, options) => {
    request = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        status: "completed",
        model: "test-model",
        output_text: JSON.stringify({
          decisionGroupId: "dg_A",
          controlId: "ctrl_remove",
          family: "seat",
          requirement: "optional",
          priceDisposition: "paid",
          policyCompatibility: "conflict",
          intendedOutcome: "remove_paid_selection",
          confidence: "high",
          rationale: "The foreground selected summary and its grounded correction correspond to the paid transaction item."
        }),
        usage: { input_tokens: 30, output_tokens: 14, total_tokens: 44 }
      })
    };
  };
  try {
    const before = {
      observationId: "obs_cross_surface_before",
      observationSnapshot: { snapshotHash: "material_cross_surface" },
      page: {
        step: "seats",
        price: { amount: 136, currency: "EUR" },
        priceText: "136 EUR",
        currentSurface: {
          id: "seat_modal",
          type: "modal",
          label: "Current selection",
          memberControlIds: ["ctrl_remove", "ctrl_next"]
        },
        controls: [
          {
            controlId: "ctrl_remove",
            decisionGroupId: "dg_B",
            label: "Remove",
            semantic: "unknown",
            physicalEffect: "unknown",
            risk: "uncertain",
            surfaceId: "seat_modal",
            stateElementId: "remove-node",
            preferredActivationElementId: "remove-node",
            operations: executable("remove-node")
          },
          {
            controlId: "ctrl_next",
            decisionGroupId: "dg_B",
            label: "Next",
            semantic: "navigation",
            physicalEffect: "advance_surface",
            risk: "safe_continue",
            surfaceId: "seat_modal",
            stateElementId: "next-node",
            preferredActivationElementId: "next-node",
            operations: executable("next-node")
          }
        ],
        decisionGroups: [
          {
            decisionGroupId: "dg_A",
            sectionType: "unknown",
            sectionLabel: "Order summary",
            surfaceId: "surface-page",
            surfaceType: "page",
            status: "satisfied",
            selectedLabel: "Selected option 36 EUR",
            selectedSemantic: "selected_paid_item",
            selectedEvidence: {
              selected: true,
              disposition: "paid",
              structuredPrice: { amount: 36, currency: "EUR" }
            },
            semanticOwnership: { status: "unknown" },
            removalControlId: "",
            alternativeControlIds: []
          },
          {
            decisionGroupId: "dg_B",
            sectionType: "unknown",
            sectionLabel: "Selected summary",
            surfaceId: "seat_modal",
            surfaceType: "modal",
            required: false,
            status: "stale",
            selectedLabel: "5E",
            selectedEvidence: { selected: true, disposition: "unknown" },
            alternativeControlIds: ["ctrl_remove", "ctrl_next"]
          }
        ],
        transactionFacts: {
          selectedExtras: [{
            decisionGroupId: "dg_A",
            label: "Selected option",
            disposition: "paid",
            priceAmount: 36,
            currency: "EUR"
          }]
        },
        validationIssues: []
      }
    };
    const traveler = { booking_rules: "No paid seats" };
    const resolved = await resolveSemanticOwnership({
      apiKey: "test-key",
      model: "test-model",
      observation: before,
      userPolicy: { bookingRules: traveler.booking_rules },
      traveler
    });
    const payload = JSON.parse(request.input[0].content[0].text);
    const schema = request.text.format.schema;
    const link = resolved.observation.page.semanticOwnershipLinks[0];
    const sourceGroup = resolved.observation.page.decisionGroups.find((group) => group.decisionGroupId === "dg_A");
    const linkedControl = resolved.observation.page.controls.find((control) => control.controlId === "ctrl_remove");

    assert.deepEqual(schema.properties.decisionGroupId.enum, ["dg_A"]);
    assert.deepEqual(schema.properties.controlId.enum, ["ctrl_remove", "ctrl_next"]);
    assert.deepEqual(payload.ambiguousSelections[0].ownedControlIds, []);
    assert.deepEqual(payload.ambiguousSelections[0].candidateCorrectionControlIds, ["ctrl_remove", "ctrl_next"]);
    assert.equal(link.sourceDecisionGroupId, "dg_A");
    assert.equal(link.correctionDecisionGroupId, "dg_B");
    assert.equal(link.correctionControlId, "ctrl_remove");
    assert.deepEqual(sourceGroup.semanticCorrectionControlIds, ["ctrl_remove"]);
    assert.equal(linkedControl.decisionGroupId, "dg_B", "the browser-owned group remains truthful");
    assert.equal(linkedControl.semantic, "unknown");
    assert.equal(linkedControl.physicalEffect, "unknown");
    assert.equal(linkedControl.risk, "uncertain");
    assert.equal(linkedControl.policyCorrectionForDecisionGroupId, undefined);
    assert.equal(link.intendedOutcome, "remove_paid_selection");
    const ownershipPolicyFingerprint = loopPrivate.aiDecisionPolicyFingerprint(
      { bookingRules: traveler.booking_rules },
      traveler
    );
    const ownershipCache = {
      semanticOwnership: semanticOwnershipCacheEntry(
        resolved.observation,
        ownershipPolicyFingerprint,
        resolved.resolution
      )
    };
    const reusedOwnership = reusableSemanticOwnershipDecision(
      ownershipCache,
      { ...before, observationId: "obs_cross_surface_reobserved" },
      ownershipPolicyFingerprint
    );
    assert.equal(reusedOwnership.resolution.controlId, "ctrl_remove");
    assert.equal(reusedOwnership.resolution.intendedOutcome, "remove_paid_selection");
    assert.equal(reusedOwnership.observation.page.semanticOwnershipLinks[0].observationId, "obs_cross_surface_reobserved");

    const taskState = reduceTaskState({
      observation: resolved.observation,
      userPolicy: { bookingRules: traveler.booking_rules },
      traveler
    });
    const candidateSet = buildCurrentCandidateSet({
      goal: taskState.currentGoal,
      observation: resolved.observation,
      traveler,
      state: { taskState, approvals: {} }
    });
    assert.equal(taskState.currentGoal.decisionGroupId, "dg_A");
    assert.equal(taskState.activeDecisions[0].status, "conflicted");
    assert.deepEqual(candidateSet.candidates.map((candidate) => candidate.controlId), ["ctrl_remove"]);
    assert.equal(candidateSet.contextCapabilities.find((candidate) => candidate.controlId === "ctrl_next"), undefined);

    const correctionAction = loopPrivate.bindTargetSnapshot(
      actionForCurrentCandidate(taskState.currentGoal, candidateSet.candidates[0], resolved.observation),
      resolved.observation
    );
    assert.equal(correctionAction.decisionGroupId, "dg_A", JSON.stringify({ goal: taskState.currentGoal, candidate: candidateSet.candidates[0], action: correctionAction }));
    assert.equal(correctionAction.targetSnapshot.decisionGroupId, "dg_B");
    assert.equal(correctionAction.targetSnapshot.policyCorrectionForDecisionGroupId, "dg_A");
    assert.equal(correctionAction.expectedOutcome.semanticOwnershipLinkId, link.linkId);
    assert.equal(correctionAction.expectedOutcome.decisionGroupId, "dg_A");
    const failedCorrection = {
      observationId: "obs_cross_surface_failed_correction",
      page: {
        ...resolved.observation.page,
        currentSurface: {
          ...resolved.observation.page.currentSurface,
          label: "Current selection updated"
        }
      }
    };
    const failedTransition = evaluateTransition({
      beforeObservation: resolved.observation,
      governedAction: correctionAction,
      browserResult: { actionId: correctionAction.id, dispatched: true, verified: false },
      afterObservation: failedCorrection
    });
    assert.equal(failedTransition.actionOutcome.status, "REVEALED_BLOCKER");
    assert.equal(failedTransition.postcondition.satisfied, false);
    assert.equal(failedTransition.currentObligationResult.completed, false);
    assert.equal(failedTransition.nextDirective, "rebuild_task_state");

    const afterCorrection = {
      observationId: "obs_cross_surface_after_correction",
      page: {
        ...resolved.observation.page,
        price: { amount: 100, currency: "EUR" },
        priceText: "100 EUR",
        controls: resolved.observation.page.controls.filter((control) => control.controlId !== "ctrl_remove"),
        decisionGroups: resolved.observation.page.decisionGroups.filter((group) => group.decisionGroupId !== "dg_A"),
        transactionFacts: { selectedExtras: [] },
        currentSurface: {
          ...resolved.observation.page.currentSurface,
          memberControlIds: ["ctrl_next"]
        }
      }
    };
    const transition = evaluateTransition({
      beforeObservation: resolved.observation,
      governedAction: correctionAction,
      browserResult: { actionId: correctionAction.id, dispatched: true, verified: true },
      afterObservation: afterCorrection
    });
    assert.equal(transition.localMechanicalResult.effect, "select_free_option");
    assert.equal(transition.localMechanicalResult.verified, true);
    assert.equal(transition.currentObligationResult.completed, true);
    assert.equal(transition.postcondition.evidence.selectedChargeRemoved, true);
    assert.equal(transition.diff.priceChanged.to.amount, 100);

    const afterState = reduceTaskState({
      previousTaskState: taskState,
      observation: afterCorrection,
      previousActionResult: transition,
      userPolicy: { bookingRules: traveler.booking_rules },
      traveler
    });
    const navigationCandidates = buildCurrentCandidateSet({
      goal: afterState.currentGoal,
      observation: afterCorrection,
      traveler,
      state: { taskState: afterState, approvals: {} }
    });
    assert.equal(afterState.currentGoal.semanticType, "navigation");
    assert.deepEqual(navigationCandidates.candidates.map((candidate) => candidate.controlId), ["ctrl_next"]);
    assert.equal(navigationCandidates.candidates.some((candidate) => candidate.type === "ask_user"), false);
  } finally {
    global.fetch = previousFetch;
  }
});

test("the existing ambiguity path resolves order summaries, custom dropdowns, and varied layouts without invented controls", async () => {
  const previousFetch = global.fetch;
  const variants = [
    {
      name: "order-summary add-on",
      family: "bundle",
      expectedTaskFamily: "extras",
      bookingRules: "No bundles",
      surfaceLabel: "Review your order",
      nearbySectionType: "payment",
      nearbySectionLabel: "Order summary",
      selectedLabel: "Trip package 31 EUR",
      controlId: "ctrl_undo_package",
      controlLabel: "Undo",
      semantic: "remove_paid_extra",
      effect: "select_free_option",
      risk: "safe_decline"
    },
    {
      name: "custom baggage dropdown",
      family: "baggage",
      expectedTaskFamily: "baggage",
      bookingRules: "No paid baggage",
      surfaceLabel: "Configure trip",
      nearbySectionType: "passenger",
      nearbySectionLabel: "Your details",
      selectedLabel: "Current value 24 EUR",
      controlId: "ctrl_modify_choice",
      controlLabel: "Modify choice",
      semantic: "open_choice_control",
      effect: "open_surface",
      risk: "safe"
    },
    {
      name: "insurance card with different wording",
      family: "insurance",
      expectedTaskFamily: "insurance",
      bookingRules: "No insurance",
      surfaceLabel: "Complete reservation",
      nearbySectionType: "unknown",
      nearbySectionLabel: "Your selections",
      selectedLabel: "Current selection 17 EUR",
      controlId: "ctrl_clear_selection",
      controlLabel: "Clear",
      semantic: "remove_paid_extra",
      effect: "select_free_option",
      risk: "safe_decline"
    }
  ];
  let callIndex = 0;
  global.fetch = async (_url, options) => {
    const variant = variants[callIndex++];
    const request = JSON.parse(options.body);
    assert.deepEqual(request.text.format.schema.properties.decisionGroupId.enum, [`dg_${callIndex}`]);
    assert.deepEqual(request.text.format.schema.properties.controlId.enum, [variant.controlId]);
    return {
      ok: true,
      json: async () => ({
        status: "completed",
        model: "test-model",
        output_text: JSON.stringify({
          decisionGroupId: `dg_${callIndex}`,
          controlId: variant.controlId,
          family: variant.family,
          requirement: "optional",
          priceDisposition: "paid",
          policyCompatibility: "conflict",
          intendedOutcome: "remove_paid_selection",
          confidence: "high",
          rationale: `Grounded ${variant.name}`
        }),
        usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 }
      })
    };
  };
  try {
    for (let index = 0; index < variants.length; index += 1) {
      const variant = variants[index];
      const decisionGroupId = `dg_${index + 1}`;
      const nodeId = `${variant.controlId}_node`;
      const observation = {
        observationId: `obs_ownership_${index + 1}`,
        page: {
          step: "unknown",
          currentSurface: { id: "surface-page", type: "page", label: variant.surfaceLabel },
          sections: [{ id: `nearby_${index}`, type: variant.nearbySectionType, label: variant.nearbySectionLabel }],
          controls: [{
            controlId: variant.controlId,
            decisionGroupId,
            label: variant.controlLabel,
            semantic: variant.semantic,
            physicalEffect: variant.effect,
            risk: variant.risk,
            surfaceId: "surface-page",
            stateElementId: nodeId,
            preferredActivationElementId: nodeId,
            operations: {
              activate: {
                operation: "activate",
                actuatorId: nodeId,
                actuatorIds: [nodeId],
                actionability: {
                  executable: true,
                  revealable: false,
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
                  code: "ACTIONABLE"
                }
              }
            }
          }],
          decisionGroups: [{
            decisionGroupId,
            sectionType: "unknown",
            sectionLabel: "Current selection",
            surfaceId: "surface-page",
            surfaceType: "page",
            status: "satisfied",
            selectedLabel: variant.selectedLabel,
            selectedEvidence: {
              selected: true,
              disposition: "paid",
              structuredPrice: { amount: 10 + index, currency: "EUR" },
              ownerElementId: `owner_${index}`
            },
            semanticOwnership: {
              status: "unknown",
              nearbySectionType: variant.nearbySectionType,
              nearbySectionLabel: variant.nearbySectionLabel
            },
            removalControlId: variant.effect === "select_free_option" ? variant.controlId : "",
            alternativeControlIds: [variant.controlId]
          }],
          validationIssues: []
        }
      };
      const traveler = { booking_rules: variant.bookingRules };
      const resolved = await resolveSemanticOwnership({
        apiKey: "test-key",
        model: "test-model",
        observation,
        userPolicy: { bookingRules: variant.bookingRules },
        traveler,
        taskState: {
          stage: "extras",
          currentGoal: { goalId: "reach_card_credential_entry" },
          activeDecisions: []
        }
      });
      const taskState = reduceTaskState({
        observation: resolved.observation,
        userPolicy: { bookingRules: variant.bookingRules },
        traveler
      });
      const candidateSet = buildCurrentCandidateSet({
        goal: taskState.currentGoal,
        observation: resolved.observation,
        traveler,
        state: { taskState, approvals: {} }
      });

      assert.equal(resolved.resolution.family, variant.family, variant.name);
      assert.equal(resolved.resolution.policyCompatibility, "conflict", variant.name);
      assert.equal(taskState.activeDecisions[0].family, variant.expectedTaskFamily, variant.name);
      assert.equal(taskState.currentGoal.decisionGroupId, decisionGroupId, variant.name);
      assert.deepEqual(candidateSet.candidates.map((candidate) => candidate.controlId), [variant.controlId], variant.name);
    }
    assert.equal(callIndex, variants.length);
  } finally {
    global.fetch = previousFetch;
  }
});
