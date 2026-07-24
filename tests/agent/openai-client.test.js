const test = require("node:test");
const assert = require("node:assert/strict");

const { callStructured } = require("../../apps/web/agent/openai-client");
const { resolveSemanticOwnership, selectCandidate } = require("../../apps/web/agent/select-candidate");
const { reduceTaskState } = require("../../apps/web/agent/task-state-reducer");
const { actionForCurrentCandidate, buildCurrentCandidateSet } = require("../../apps/web/agent/current-candidate-builder");
const { evaluateTransition } = require("../../apps/web/agent/transition-evaluator");
const { __private: loopPrivate } = require("../../apps/web/agent/loop");

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

    assert.equal(payload.contextCapabilities.length, 2);
    assert.equal(payload.taskState.stage, "extras");
    assert.deepEqual(payload.contextCapabilities.map((capability) => capability.selectable), [true, false]);
    assert.equal(payload.contextCapabilities[1].policyStatus, "deny");
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
    assert.equal(payload.contextCapabilities.length, 20);
    assert.ok(Buffer.byteLength(JSON.stringify(payload), "utf8") < 24_000);
    assert.equal(content.some((item) => item.type === "input_image"), false);
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
                operationAuthorized: true,
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

test("transaction facts trigger semantic ownership when live decision fields are missing", async () => {
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
                  operationAuthorized: true,
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
                  operationAuthorized: true,
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
    assert.equal(taskState.activeDecisions[0].status, "conflicted");
    assert.equal(taskState.currentGoal.decisionGroupId, "dg_live_paid_summary");
    assert.deepEqual(candidates.candidates.map((candidate) => candidate.controlId), ["ctrl_live_reversal"]);
    assert.equal(candidates.contextCapabilities.find((candidate) => candidate.controlId === "ctrl_live_advance").selectable, false);
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
        operationAuthorized: true,
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
      semanticOwnership: loopPrivate.semanticOwnershipCacheEntry(
        resolved.observation,
        ownershipPolicyFingerprint,
        resolved.resolution
      )
    };
    const reusedOwnership = loopPrivate.reusableSemanticOwnershipDecision(
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
    assert.equal(candidateSet.contextCapabilities.find((candidate) => candidate.controlId === "ctrl_next").selectable, false);

    const correctionAction = loopPrivate.bindTargetSnapshot(
      actionForCurrentCandidate(taskState.currentGoal, candidateSet.candidates[0], resolved.observation),
      resolved.observation
    );
    assert.equal(correctionAction.decisionGroupId, "dg_A");
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
    assert.equal(failedTransition.status, "no_effect");
    assert.equal(failedTransition.postcondition.satisfied, false);
    assert.equal(failedTransition.currentObligationResult.completed, false);
    assert.equal(failedTransition.nextDirective, "try_distinct_capability");

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
    assert.equal(transition.localMechanicalResult.effect, "unknown");
    assert.equal(transition.localMechanicalResult.verified, true);
    assert.equal(transition.currentObligationResult.completed, true);
    assert.equal(transition.postcondition.evidence.beforePaid, true);
    assert.equal(transition.postcondition.evidence.afterPaid, false);
    assert.equal(transition.postcondition.evidence.chargeCleared, true);

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
                  operationAuthorized: true,
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
          currentGoal: { goalId: "reach_payment_review" },
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
