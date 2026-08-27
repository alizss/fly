const test = require("node:test");
const assert = require("node:assert/strict");

const { buildCanonicalDecisions } = require("../../apps/web/agent/canonical-decision");

test("raw required value fields request grounding without manufacturing a profile value", () => {
  const decisions = buildCanonicalDecisions({
    page: {
      controls: [{
        controlId: "ctrl_customer_zip",
        stableKey: "field|name:unfamiliarRequiredValue",
        role: "textbox",
        kind: "field",
        semantic: "unknown",
        required: true,
        state: { required: true, valuePresent: false },
        representationLifecycle: { status: "active_rendered", active: true },
        operations: {
          type: { actuatorId: "input_customer_zip", status: "proven_executable" }
        }
      }],
      decisionGroups: []
    }
  });

  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].subject.key, "unknown");
  assert.equal(decisions[0].userIntent.match, "semantic_grounding_required");
  assert.equal(decisions[0].userIntent.source, "semantic_grounding_required");
  assert.equal(decisions[0].userIntent.desiredOutcome, "");
  assert.equal(decisions[0].userIntent.desiredCanonicalValue, null);
  assert.equal(decisions[0].actionReason, "semantic_grounding_required");
});

test("an enabled page exit cannot waive an exact unresolved required choice", () => {
  const actionable = (actuatorId) => ({
    actuatorId,
    actionability: { executable: true, revealable: false }
  });
  const decisions = buildCanonicalDecisions({
    page: {
      currentSurface: { id: "surface-page", type: "page" },
      stageExit: {
        continueAllowed: true,
        continueDisabled: false,
        candidates: [{ controlId: "continue", actuatorId: "continue", status: "ready" }]
      },
      controls: [
        {
          controlId: "insurance_none",
          label: "No insurance",
          semantic: "decline_paid_extra",
          physicalEffect: "select_free_option",
          risk: "safe_decline",
          decisionGroupId: "dg_insurance",
          surfaceId: "surface-page",
          selected: false,
          state: { selected: false, checked: false },
          operations: { activate: actionable("insurance_none") }
        },
        {
          controlId: "insurance_paid",
          label: "Travel Plus 25 EUR",
          semantic: "add_paid_extra",
          physicalEffect: "select_paid_option",
          risk: "money",
          structuredPrice: { amount: 25, currency: "EUR" },
          decisionGroupId: "dg_insurance",
          surfaceId: "surface-page",
          selected: false,
          state: { selected: false, checked: false },
          operations: { activate: actionable("insurance_paid") }
        }
      ],
      decisionGroups: [{
        decisionGroupId: "dg_insurance",
        sectionType: "insurance",
        sectionLabel: "Travel insurance",
        surfaceId: "surface-page",
        surfaceType: "page",
        required: true,
        selectedControlId: "",
        alternatives: [
          { controlId: "insurance_none", label: "No insurance", semantic: "decline_paid_extra", risk: "safe_decline" },
          { controlId: "insurance_paid", label: "Travel Plus 25 EUR", semantic: "add_paid_extra", risk: "money", structuredPrice: { amount: 25, currency: "EUR" } }
        ]
      }],
      validationIssues: []
    },
    userPolicy: { bookingRules: "No insurance and no paid extras" },
    traveler: { booking_rules: "No insurance and no paid extras" }
  });

  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].status, "active");
  assert.equal(decisions[0].needsAction, true);
  assert.equal(decisions[0].actionReason, "required_unresolved");
  assert.deepEqual(decisions[0].userIntent.desiredControlIds, ["insurance_none"]);
});
