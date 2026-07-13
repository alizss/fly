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
          selected: true,
          state: { checked: true },
          visualRegion: { x: 10, y: 10, width: 140, height: 24 }
        },
        {
          controlId: "ctrl_flex_none",
          decisionGroupId: "dg_flexible_ticket",
          label: "None of the passengers",
          kind: "radio",
          stateElementId: "atw-flex-input",
          preferredActivationElementId: "atw-flex-label",
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
          selected: false,
          state: { checked: false },
          visualRegion: { x: 10, y: 200, width: 90, height: 24 }
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
    satisfiedRequirementIds: ["dg_flexible_ticket"],
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

test("P0.4 Continue blocks missing required decision groups but not unselected paid alternatives in satisfied groups", () => {
  const observation = observationWithGroups();
  const requirements = __private.requirementsWithDecisionGroups([], observation);
  const continueAction = {
    type: "click",
    targetLabel: "Continue",
    targetSnapshot: { label: "Continue", risk: "safe", semantic: "continue" },
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
