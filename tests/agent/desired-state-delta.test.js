const test = require("node:test");
const assert = require("node:assert/strict");

const {
  compileDesiredStateDeltas,
  desiredStateEvaluationForDecision,
  deltaForDecision,
  exactIncrementalCostProof,
  typedLegalEvidence
} = require("../../apps/web/agent/desired-state-delta");
const { exactUserIntent } = require("../../apps/web/agent/canonical-decision");

function decision(overrides = {}) {
  return {
    decisionId: "dg_example",
    decisionGroupId: "dg_example",
    family: "decision",
    subject: { key: "decision_example", family: "decision" },
    status: "satisfied",
    required: false,
    needsAction: false,
    selectedControlId: "current",
    currentState: { selectedControlId: "current" },
    availableTransitions: [],
    userIntent: {
      match: "none",
      desiredSelected: true,
      desiredControlIds: []
    },
    observed: {},
    ...overrides
  };
}

test("Desired State Delta ignores inherited section totals and settled unfamiliar state", () => {
  const inheritedTotal = decision({
    observed: {
      selectedEvidence: {
        selected: true,
        disposition: "paid",
        source: "owned_decision_section",
        structuredPrice: { amount: 152.62, currency: "EUR" }
      }
    }
  });
  assert.equal(exactIncrementalCostProof(inheritedTotal).proven, false);
  assert.equal(deltaForDecision(inheritedTotal), null);
  assert.deepEqual(compileDesiredStateDeltas({ decisions: [inheritedTotal] }), []);
});

test("Desired State Delta admits an exact selected-control charge", () => {
  const paid = decision({
    status: "conflicted",
    needsAction: true,
    selectedControlId: "paid_seat",
    currentState: { selectedControlId: "paid_seat" },
    availableTransitions: [{
      controlId: "paid_seat",
      executable: true,
      effectRole: "commerce_option",
      price: { amount: 24, currency: "EUR" },
      semantic: "select_paid_option"
    }],
    observed: {
      selectedEvidence: {
        selected: true,
        selectedControlId: "paid_seat",
        source: "selected_control",
        structuredPrice: { amount: 24, currency: "EUR" }
      }
    }
  });
  const delta = deltaForDecision(paid);
  assert.equal(delta.reason, "proven_incremental_cost_conflict");
  assert.equal(delta.proof.incrementalCost.amount, 24);
});

test("Desired State Delta admits required state and explicit profile mismatch", () => {
  const required = decision({
    selectedControlId: "",
    currentState: { selectedControlId: "" },
    required: true,
    status: "active",
    needsAction: true
  });
  const mismatch = decision({
    status: "active",
    needsAction: true,
    selectedControlId: "old",
    currentState: { selectedControlId: "old" },
    userIntent: {
      match: "exact",
      desiredSelected: true,
      desiredControlIds: ["profile_choice"]
    }
  });
  assert.equal(deltaForDecision(required).reason, "required_state_missing");
  assert.equal(deltaForDecision(mismatch).reason, "explicit_profile_mismatch");
});

test("Desired State Delta treats typed legal evidence narrowly", () => {
  const nounOnly = decision({
    subject: { key: "decision_purchaser_type", family: "decision" },
    observed: { sectionLabel: "Natural person or Legal person" }
  });
  const attestation = decision({
    required: true,
    status: "active",
    needsAction: true,
    selectedControlId: "",
    currentState: { selectedControlId: "" },
    observed: { semanticType: "legal_acceptance" }
  });
  assert.equal(typedLegalEvidence(nounOnly), false);
  assert.equal(typedLegalEvidence(attestation), true);
  assert.equal(deltaForDecision(attestation).evidenceKind, "typed_legal_requirement");
});

test("Desired State Delta admits selected optional consent only for an explicit profile mismatch", () => {
  const consent = decision({
    family: "contact",
    subject: { key: "optional_consent", family: "contact" },
    status: "conflicted",
    needsAction: true,
    selectedControlId: "survey",
    currentState: { selectedControlId: "survey" },
    physicalControlIds: ["survey"],
    userIntent: {
      match: "exact",
      desiredSelected: false,
      desiredControlIds: ["survey"]
    }
  });
  const delta = deltaForDecision(consent);
  assert.equal(delta.desiredState, "unselected");
  assert.deepEqual(delta.admittedControlIds, ["survey"]);
});

test("optional defaults remain page state when the profile is silent", () => {
  const label = "I wish to participate in a customer satisfaction survey. I can opt-out at any time.";
  const intent = exactUserIntent(
    { key: "optional_consent", label },
    { sectionLabel: label },
    [{ controlId: "survey", label, semantic: "optional_consent", executable: true }],
    { bookingRules: "No paid extras" },
    {}
  );

  assert.equal(intent.match, "none");
  assert.equal(intent.desiredSelected, null);
  assert.deepEqual(intent.desiredControlIds, []);
});

test("explicit consent preferences are exact-subject scoped", () => {
  const surveyLabel = "I wish to participate in a customer satisfaction survey. I can opt-out at any time.";
  const marketingLabel = "I consent to receiving information about third-party offers";
  const bookingRules = "Do not participate in customer satisfaction surveys";
  const intentFor = (label, controlId) => exactUserIntent(
    { key: "optional_consent", label },
    { sectionLabel: label },
    [{ controlId, label, semantic: "optional_consent", executable: true }],
    { bookingRules },
    {}
  );

  const survey = intentFor(surveyLabel, "survey");
  const marketing = intentFor(marketingLabel, "marketing");
  assert.equal(survey.match, "exact");
  assert.equal(survey.desiredSelected, false);
  assert.deepEqual(survey.desiredControlIds, ["survey"]);
  assert.equal(marketing.match, "none");
  assert.equal(marketing.desiredSelected, null);
});

test("a non-blocking no-paid constraint is already satisfied without clicking its decline control", () => {
  const compatible = decision({
    family: "insurance",
    subject: { key: "travel_insurance", family: "insurance" },
    selectedControlId: "",
    currentState: { selectedControlId: "" },
    status: "waived",
    needsAction: false,
    physicalControlIds: ["insurance_none", "insurance_paid"],
    userIntent: {
      match: "constraint",
      desiredSelected: true,
      desiredControlIds: ["insurance_none"],
      eligibleOptionIds: ["insurance_none"]
    }
  });
  const blocking = decision({
    ...compatible,
    status: "active",
    needsAction: true
  });

  assert.equal(deltaForDecision(compatible), null);
  assert.equal(desiredStateEvaluationForDecision(compatible).status, "SATISFIED");
  assert.equal(desiredStateEvaluationForDecision(compatible).actionRequired, false);
  assert.equal(deltaForDecision(blocking).status, "EXACT_DELTA");
  assert.equal(deltaForDecision(blocking).reason, "explicit_profile_mismatch");
});

test("Desired State Delta distinguishes missing facts and external authorization from exact mechanics", () => {
  const missingFact = decision({
    required: true,
    selectedControlId: "",
    currentState: { selectedControlId: "" },
    status: "blocked",
    needsAction: true,
    userIntent: { match: "ambiguous", desiredControlIds: [], desiredSelected: null }
  });
  const external = decision({
    status: "blocked",
    needsAction: true,
    selectedControlId: "paid_bundle",
    currentState: { selectedControlId: "paid_bundle" },
    reopenEvidence: {
      code: "PAID_SELECTION_POLICY_AUTHORIZATION_CONFLICT",
      authorizationId: "auth_bundle"
    },
    availableTransitions: [{
      controlId: "paid_bundle",
      executable: true,
      effectRole: "commerce_option",
      semantic: "select_paid_option",
      price: { amount: 29, currency: "EUR" }
    }],
    observed: {
      selectedEvidence: {
        selected: true,
        source: "selected_control",
        structuredPrice: { amount: 29, currency: "EUR" }
      }
    }
  });

  assert.equal(desiredStateEvaluationForDecision(missingFact).status, "MISSING_FACT");
  assert.equal(desiredStateEvaluationForDecision(external).status, "BLOCKED_EXTERNAL");
});
