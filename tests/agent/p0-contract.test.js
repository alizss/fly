const test = require("node:test");
const assert = require("node:assert/strict");

const { evaluateActionPolicy } = require("../../packages/shared/policy");
const { __private } = require("../../apps/web/agent/loop");

function observationWithGroups() {
  return {
    observationId: "obs_test",
    observationSnapshot: { snapshotHash: "hash_test" },
    page: {
      decisionGroups: [
        {
          decisionGroupId: "dg_baggage",
          sectionId: "sec_baggage",
          sectionType: "baggage",
          sectionLabel: "Checked baggage",
          requirementId: "baggage",
          required: true,
          status: "satisfied",
          selectedControlId: "ctrl_bag_none",
          selectedLabel: "No checked baggage",
          alternatives: [
            { controlId: "ctrl_bag_none", targetId: "atw-bag-none", label: "No checked baggage", selected: true, risk: "safe_decline" },
            { controlId: "ctrl_bag_23kg", targetId: "atw-bag-23", label: "1 x 23 kg 44EUR", selected: false, risk: "money", priceText: "44EUR" }
          ],
          evidence: ["Selected: No checked baggage"]
        },
        {
          decisionGroupId: "dg_flexible_ticket",
          sectionId: "sec_flex",
          sectionType: "flexible_ticket",
          sectionLabel: "Flexible Ticket",
          requirementId: "flexible_ticket",
          required: true,
          status: "missing",
          selectedControlId: "",
          selectedLabel: "",
          alternatives: [
            { controlId: "ctrl_flex_none", targetId: "atw-flex-none", label: "None of the passengers", selected: false, risk: "safe_decline" },
            { controlId: "ctrl_flex_all", targetId: "atw-flex-all", label: "All passengers 29EUR", selected: false, risk: "money", priceText: "29EUR" }
          ],
          evidence: ["No selected option for Flexible Ticket"]
        }
      ],
      controls: [
        {
          controlId: "ctrl_bag_none",
          decisionGroupId: "dg_baggage",
          label: "No checked baggage",
          kind: "radio",
          stateElementId: "atw-bag-input",
          preferredActivationElementId: "atw-bag-label",
          actuators: [
            { nodeId: "atw-bag-input", relation: "state" },
            { nodeId: "atw-bag-label", relation: "label" },
            { nodeId: "atw-bag-wrapper", relation: "wrapper" }
          ],
          selected: true,
          state: { checked: true },
          visualRegion: { x: 10, y: 10, width: 140, height: 24 }
        },
        {
          controlId: "ctrl_flex_none",
          visualRef: "O1",
          decisionGroupId: "dg_flexible_ticket",
          label: "None of the passengers",
          kind: "radio",
          stateElementId: "atw-flex-input",
          preferredActivationElementId: "atw-flex-label",
          actuators: [
            { nodeId: "atw-flex-input", relation: "state" },
            { nodeId: "atw-flex-label", relation: "label" },
            { nodeId: "atw-flex-wrapper", relation: "wrapper" }
          ],
          selected: false,
          state: { checked: false },
          visualRegion: { x: 10, y: 80, width: 160, height: 24 }
        },
        {
          controlId: "ctrl_sms_none",
          decisionGroupId: "dg_booking_sms",
          label: "No thanks",
          kind: "radio",
          stateElementId: "atw-sms-input",
          preferredActivationElementId: "atw-sms-label",
          actuators: [
            { nodeId: "atw-sms-input", relation: "state" },
            { nodeId: "atw-sms-label", relation: "label" }
          ],
          selected: false,
          state: { checked: false },
          visualRegion: { x: 10, y: 140, width: 90, height: 24 }
        },
        {
          controlId: "ctrl_support_none",
          decisionGroupId: "dg_support",
          label: "No thanks",
          kind: "radio",
          stateElementId: "atw-support-input",
          preferredActivationElementId: "atw-support-label",
          actuators: [
            { nodeId: "atw-support-input", relation: "state" },
            { nodeId: "atw-support-label", relation: "label" }
          ],
          selected: false,
          state: { checked: false },
          visualRegion: { x: 10, y: 200, width: 90, height: 24 }
        }
      ],
      screenshotAnnotations: [
        {
          visualRef: "O1",
          targetId: "atw-flex-label",
          controlId: "ctrl_flex_none",
          decisionGroupId: "dg_flexible_ticket",
          label: "None of the passengers",
          kind: "radio",
          role: "radio",
          semantic: "decline_paid_extra",
          risk: "safe_decline",
          box: { x: 10, y: 80, width: 160, height: 24, centerX: 90, centerY: 92, inViewport: true }
        }
      ],
      buttons: [
        { id: "atw-continue", label: "Continue", risk: "safe", semantic: "continue" }
      ],
      sections: []
    }
  };
}

test("P0.10 derives one canonical requirement per decision group and drops duplicate choice requirements", () => {
  const observation = observationWithGroups();
  const classified = [
    {
      id: "choice_baggage_duplicate",
      type: "baggage_decision",
      label: "Checked baggage",
      status: "missing",
      required: true,
      risk: "money",
      evidence: ["Classifier saw paid alternatives"],
      confidence: 0.6,
      targetIds: ["atw-bag-23"]
    },
    {
      id: "field_email",
      type: "contact_field",
      label: "E-mail",
      status: "satisfied",
      required: true,
      risk: "safe",
      evidence: ["Email field has value"],
      confidence: 0.95,
      targetIds: ["email"]
    }
  ];

  const requirements = __private.requirementsWithDecisionGroups(classified, observation);

  assert.equal(requirements.some((req) => req.id === "choice_baggage_duplicate"), false);
  assert.equal(requirements.some((req) => req.id === "field_email"), true);
  assert.equal(requirements.find((req) => req.id === "dg_baggage").status, "satisfied");
  assert.equal(requirements.find((req) => req.id === "dg_flexible_ticket").status, "missing");
});

test("P0.8 rejects evidence from another decision group", () => {
  const observation = observationWithGroups();
  const [baggageRequirement] = __private.requirementsWithDecisionGroups([], observation)
    .filter((req) => req.id === "dg_baggage");

  const wrongGroupUpdate = {
    requirementId: "dg_baggage",
    proposedStatus: "satisfied",
    observationId: "obs_test",
    confidence: 0.99,
    evidence: {
      controlId: "ctrl_flex_none",
      selectedValue: "None of the passengers",
      visibleText: "Flexible Ticket"
    }
  };

  assert.equal(
    __private.updateEvidenceMatchesRequirement(wrongGroupUpdate, baggageRequirement, observation),
    false
  );
});

test("P0.8 deterministic current decision-group state outranks stale verifier claims", () => {
  const observation = observationWithGroups();
  const requirements = __private.requirementsWithDecisionGroups([], observation);
  const flexRequirement = requirements.find((req) => req.id === "dg_flexible_ticket");

  const reconciled = __private.reconcileRequirements([flexRequirement], {
    requirementUpdates: [
      {
        requirementId: "dg_flexible_ticket",
        proposedStatus: "satisfied",
        observationId: "obs_test",
        confidence: 0.99,
        evidence: { controlId: "ctrl_bag_none", selectedValue: "No checked baggage", visibleText: "Checked baggage" }
      }
    ]
  }, observation);

  assert.equal(reconciled[0].status, "missing");
  assert.match(reconciled[0].evidence.join(" "), /No selected option for Flexible Ticket/);
});

test("P0.10 fails closed when a choice requirement has no canonical decision group", () => {
  const observation = { observationId: "obs_current", page: { decisionGroups: [], controls: [] } };
  const [requirement] = __private.requirementsWithDecisionGroups([{
    id: "model_baggage_choice",
    type: "baggage_decision",
    label: "Checked baggage",
    status: "satisfied",
    required: false,
    risk: "money",
    evidence: ["Classifier inferred a selected option"],
    confidence: 0.92,
    targetIds: ["visual_guess"]
  }], observation);

  assert.equal(requirement.status, "conflicted");
  assert.equal(requirement.required, true);
  assert.equal(requirement.confidence, 0);
  assert.match(requirement.evidence.join(" "), /CANONICAL_DECISION_GROUP_MISSING/);
  assert.equal(__private.updateEvidenceMatchesRequirement({
    requirementId: requirement.id,
    proposedStatus: "satisfied",
    observationId: "obs_current",
    confidence: 0.99,
    evidence: { controlId: "visual_guess", visibleText: "No checked baggage" }
  }, requirement, observation), false);
});

test("P0.4 Continue blocks missing required decision groups but not unselected paid alternatives in satisfied groups", () => {
  const observation = observationWithGroups();
  const requirements = __private.requirementsWithDecisionGroups([], observation);
  const continueAction = {
    type: "click",
    targetLabel: "Continue",
    targetSnapshot: { controlId: "ctrl_continue", label: "Continue", kind: "button", risk: "safe", semantic: "continue" },
    risk: "safe"
  };

  const blocked = evaluateActionPolicy(continueAction, { requirements, priceHistory: [] }, { booking_rules: "no extras no seats" }, {});
  assert.equal(blocked.allow, false);
  assert.match(blocked.reason, /Flexible Ticket/);

  const allSatisfied = requirements.map((req) =>
    req.id === "dg_flexible_ticket" ? { ...req, status: "satisfied", selectedLabel: "None of the passengers" } : req
  );
  const allowed = evaluateActionPolicy(continueAction, { requirements: allSatisfied, priceHistory: [] }, { booking_rules: "no extras no seats" }, {});
  assert.equal(allowed.allow, true);
});

test("P0.6 typed policy trusts canonical semantic risk instead of button wording", () => {
  const safeDeclineWithPaidLookingCopy = evaluateActionPolicy({
    type: "click",
    intent: "decline_optional_extra",
    targetLabel: "Premium add to cart",
    targetSnapshot: {
      controlId: "ctrl_safe_decline",
      semantic: "decline_paid_extra",
      risk: "safe_decline",
      kind: "button"
    },
    risk: "safe"
  }, { requirements: [], priceHistory: [] }, { booking_rules: "no extras" }, {});
  assert.equal(safeDeclineWithPaidLookingCopy.allow, true);

  const paidControlWithSafeLookingCopy = evaluateActionPolicy({
    type: "click",
    intent: "choose_option",
    targetLabel: "No thanks",
    targetSnapshot: {
      controlId: "ctrl_paid",
      semantic: "add_paid_extra",
      risk: "money",
      kind: "choice"
    },
    risk: "money"
  }, { requirements: [], priceHistory: [] }, { booking_rules: "no extras" }, {});
  assert.equal(paidControlWithSafeLookingCopy.allow, false);
});

test("P0.9 binds repeated labels by canonical controlId instead of first matching text", () => {
  const observation = observationWithGroups();
  const action = {
    type: "click",
    targetId: "ctrl_support_none",
    targetLabel: "No thanks"
  };

  const bound = __private.bindTargetSnapshot(action, observation);

  assert.equal(bound.targetSnapshot.controlId, "ctrl_support_none");
  assert.equal(bound.targetSnapshot.id, "atw-support-label");
  assert.equal(bound.targetSnapshot.decisionGroupId, "dg_support");
});

test("P0.9 preserves decision-group identity when binding a logical control target", () => {
  const observation = observationWithGroups();
  const bound = __private.bindTargetSnapshot({
    type: "click",
    targetId: "ctrl_bag_none",
    targetLabel: "No checked baggage"
  }, observation);

  assert.equal(bound.controlId, "ctrl_bag_none");
  assert.equal(bound.decisionGroupId, "dg_baggage");
  assert.equal(bound.targetSnapshot.stateElementId, "atw-bag-input");
  assert.equal(bound.targetSnapshot.preferredActivationElementId, "atw-bag-label");
});

test("P0.4/P0.7 binds type to the state element while click uses the activation element", () => {
  const observation = observationWithGroups();
  observation.page.controls.push({
    controlId: "ctrl_email",
    label: "E-mail",
    kind: "field",
    role: "textbox",
    semantic: "email",
    risk: "safe",
    stateElementId: "atw-email-input",
    preferredActivationElementId: "atw-email-label",
    actuators: [
      { nodeId: "atw-email-input", relation: "state" },
      { nodeId: "atw-email-label", relation: "label" }
    ]
  });

  const typed = __private.bindTargetSnapshot({ type: "type", targetId: "ctrl_email", value: "ali@example.test" }, observation);
  const clicked = __private.bindTargetSnapshot({ type: "click", targetId: "ctrl_email" }, observation);

  assert.equal(typed.targetSnapshot.id, "atw-email-input");
  assert.equal(clicked.targetSnapshot.id, "atw-email-label");
});

test("P0.7/P0.9 resolves every canonical alias to one logical control", () => {
  const observation = observationWithGroups();
  const aliases = [
    "ctrl_bag_none",
    "atw-bag-input",
    "atw-bag-label",
    "atw-bag-wrapper"
  ];

  for (const aliasId of aliases) {
    const resolution = __private.resolveActionControl({ type: "click", targetId: aliasId }, observation.page);
    assert.equal(resolution.ok, true, aliasId);
    assert.equal(resolution.control.controlId, "ctrl_bag_none", aliasId);
    const bound = __private.bindTargetSnapshot({ type: "click", targetId: aliasId }, observation);
    assert.equal(bound.controlId, "ctrl_bag_none", aliasId);
    assert.equal(bound.targetSnapshot.controlId, "ctrl_bag_none", aliasId);
    assert.equal(bound.targetSnapshot.decisionGroupId, "dg_baggage", aliasId);
  }

  assert.equal(__private.controlDecisionGroupId("atw-bag-wrapper", observation.page), "dg_baggage");
});

test("P0.7/P0.9 fails closed when one alias is owned by incompatible controls", () => {
  const observation = observationWithGroups();
  observation.page.controls.find((control) => control.controlId === "ctrl_support_none")
    .actuators.push({ nodeId: "atw-sms-label", relation: "label" });

  const index = __private.buildControlAliasIndex(observation.page);
  assert.equal(index.resolve("atw-sms-label"), null);
  assert.equal(index.conflicts.some((conflict) => conflict.code === "ALIAS_OWNERSHIP_CONFLICT"), true);

  const bound = __private.bindTargetSnapshot({ type: "click", targetId: "atw-sms-label" }, observation);
  assert.equal(bound.controlId, "");
  assert.equal(bound.targetSnapshot, null);
});

test("P0.7 refuses label-only mutation instead of recovering a DOM target from text", () => {
  const observation = observationWithGroups();
  const bound = __private.bindTargetSnapshot({
    type: "click",
    targetLabel: "No thanks",
    intent: "decline_optional_extra",
    risk: "safe_decline"
  }, observation);

  assert.equal(bound.targetSnapshot, null);
  const decision = evaluateActionPolicy(bound, { requirements: [], priceHistory: [] }, {
    booking_rules: "no extras"
  }, {});
  assert.equal(decision.allow, false);
  assert.match(decision.reason, /canonical control/i);
});

test("P1.1 binds annotated screenshot visualRef to the canonical control", () => {
  const observation = observationWithGroups();
  const bound = __private.bindTargetSnapshot({
    type: "click",
    targetId: "O1",
    targetLabel: "None of the passengers"
  }, observation);

  assert.equal(bound.targetSnapshot.visualRef, "O1");
  assert.equal(bound.targetSnapshot.controlId, "ctrl_flex_none");
  assert.equal(bound.targetSnapshot.decisionGroupId, "dg_flexible_ticket");
  assert.equal(bound.targetSnapshot.id, "atw-flex-label");
});

test("P0.10 live selected dropdown group state survives stale missing model claims", () => {
  const observation = observationWithGroups();
  observation.page.decisionGroups = observation.page.decisionGroups.map((group) =>
    group.decisionGroupId === "dg_flexible_ticket"
      ? {
          ...group,
          status: "satisfied",
          selectedControlId: "ctrl_flex_none",
          selectedLabel: "None of the passengers",
          alternatives: group.alternatives.map((choice) =>
            choice.controlId === "ctrl_flex_none" ? { ...choice, selected: true } : choice
          ),
          evidence: ["Selected: None of the passengers"]
        }
      : group
  );

  const classified = [
    {
      id: "model_flex_missing",
      decisionGroupId: "dg_flexible_ticket",
      type: "paid_extra_decision",
      label: "Flexible Ticket",
      status: "missing",
      required: true,
      risk: "money",
      evidence: ["Model did not see the collapsed selected value"],
      confidence: 0.8,
      targetIds: ["atw-el-324"]
    }
  ];

  const requirements = __private.requirementsWithDecisionGroups(classified, observation);
  const flex = requirements.find((req) => req.id === "dg_flexible_ticket");

  assert.equal(requirements.some((req) => req.id === "model_flex_missing"), false);
  assert.equal(flex.status, "satisfied");
  assert.equal(flex.selectedLabel, "None of the passengers");
});

test("P0.10 stable logical decision group is independent of changing DOM element ids", () => {
  const first = {
    decisionGroupId: "dg_flexible_ticket_flexible-ticket",
    sectionId: "atw-el-316",
    sectionType: "flexible_ticket",
    sectionLabel: "Flexible Ticket",
    requirementId: "flexible_ticket",
    required: true,
    status: "satisfied",
    selectedControlId: "ctrl_flex_none",
    selectedLabel: "None of the passengers",
    alternatives: []
  };
  const reopened = {
    ...first,
    sectionId: "atw-el-324"
  };

  assert.equal(first.decisionGroupId, reopened.decisionGroupId);
  assert.notEqual(first.sectionId, reopened.sectionId);
});

test("P1.4 foreground decline requires active surface dismissal instead of generic requirement evidence", () => {
  const page = {
    currentSurface: {
      id: "modal_baggage_confirm",
      type: "modal",
      label: "Baggage confirmation"
    },
    activeSurface: {
      id: "modal_baggage_confirm",
      type: "modal",
      label: "Baggage confirmation"
    }
  };
  const action = {
    type: "click",
    intent: "decline_optional_extra",
    targetId: "atw-go-without",
    decisionGroupId: "dg_modal_baggage_confirm",
    targetSnapshot: {
      id: "atw-go-without",
      label: "I'll go without",
      semantic: "decline_paid_extra",
      risk: "safe_decline",
      surfaceId: "modal_baggage_confirm",
      surfaceType: "modal",
      surfaceLabel: "Baggage confirmation",
      decisionGroupId: "dg_modal_baggage_confirm"
    },
    expectedOutcome: {
      type: "requirement_status",
      requirementId: "baggage",
      status: "satisfied"
    }
  };

  const expected = __private.expectedOutcomeForAction(action, page);

  assert.equal(expected.type, "active_surface_dismissed");
  assert.equal(expected.surfaceId, "modal_baggage_confirm");
  assert.equal(expected.surfaceType, "modal");
  assert.equal(expected.mustNotIncreasePrice, true);
});

test("P0.11 builds authoritative lifecycle requirements with explicit scope and interface state", () => {
  const observation = observationWithGroups();
  observation.page.step = "traveler_information";
  const rawRequirements = __private.requirementsWithDecisionGroups([], observation);

  const lifecycle = __private.canonicalRequirementLifecycle(rawRequirements, observation, [], {
    booking_rules: "no extras no seats"
  }, "traveler_information");
  const flex = lifecycle.find((item) => item.requirementId === "dg_flexible_ticket");

  assert.equal(flex.semanticType, "paid_extra_decision");
  assert.equal(flex.scope.stage, "traveler_information");
  assert.equal(flex.scope.decisionGroupId, "dg_flexible_ticket");
  assert.equal(flex.desiredDisposition, "decline");
  assert.equal(flex.lifecycleStatus, "active");
  assert.equal(flex.interfaceStatus, "pending");
  assert.equal(flex.createdObservationId, "obs_test");
  assert.equal(flex.lastObservedObservationId, "obs_test");
});

test("P0.11 stale scoped requirements leave the active planning view", () => {
  const firstObservation = observationWithGroups();
  firstObservation.page.step = "traveler_information";
  const firstRequirements = __private.requirementsWithDecisionGroups([], firstObservation);
  const firstLifecycle = __private.canonicalRequirementLifecycle(firstRequirements, firstObservation, [], {
    booking_rules: "no extras no seats"
  }, "traveler_information");

  const secondObservation = {
    observationId: "obs_after_modal",
    page: {
      step: "seats",
      decisionGroups: [],
      controls: [],
      fields: [],
      sections: []
    }
  };
  const secondLifecycle = __private.canonicalRequirementLifecycle([], secondObservation, firstLifecycle, {
    booking_rules: "no extras no seats"
  }, "seats");
  const active = __private.activeRequirementView(secondLifecycle);

  assert.equal(secondLifecycle.some((item) => item.lifecycleStatus === "stale"), true);
  assert.equal(active.some((item) => item.requirementId === "dg_flexible_ticket"), false);
});
