const test = require("node:test");
const assert = require("node:assert/strict");

const {
  canonicalizeUserPolicy,
  routineCheckoutAdmission,
  standingCheckoutPolicy
} = require("../../apps/web/agent/policy-profile");

test("an absent checkout preference grants no paid-extra or legal authority", () => {
  assert.deepEqual(standingCheckoutPolicy({}, {}), {
    paidExtras: "ask",
    standardBookingTerms: "ask",
    marketingConsent: "decline",
    paymentMethod: "browser saved card",
    paymentSubmission: "never"
  });
});

test("the saved standing policy authorizes routine choices but never payment submission", () => {
  const policy = canonicalizeUserPolicy({}, {
    paid_extras_policy: "decline",
    standard_booking_terms: "accept",
    marketing_consent: "decline",
    payment_preference: "credit card",
    payment_submission: "pay"
  });

  assert.deepEqual(policy.standingPolicy, {
    paidExtras: "decline",
    standardBookingTerms: "accept",
    marketingConsent: "decline",
    paymentMethod: "credit card",
    paymentSubmission: "never"
  });
  assert.equal(policy.profilePolicy.constraints.noPaidExtras, true);
});

test("routine checkout admission reports incomplete traveler and policy facts before session creation", () => {
  assert.deepEqual(routineCheckoutAdmission({
    traveler: { id: "trav_incomplete", first_name: "Ali" },
    userPolicy: {}
  }), {
    ready: false,
    missingFacts: [
      "traveler.last_name",
      "traveler.date_of_birth",
      "traveler.email",
      "traveler.phone",
      "policy.paid_extras",
      "policy.standard_booking_terms",
      "policy.marketing_consent",
      "policy.payment_method",
      "policy.payment_submission"
    ]
  });
});

test("routine checkout admission accepts a complete selected traveler with explicit standing policy", () => {
  assert.deepEqual(routineCheckoutAdmission({
    traveler: {
      id: "trav_complete",
      first_name: "Ali",
      last_name: "Example",
      date_of_birth: "1990-04-12",
      email: "ali@example.test",
      phone: "+38640123456",
      paid_extras_policy: "decline",
      standard_booking_terms: "accept",
      marketing_consent: "decline",
      payment_preference: "card",
      payment_submission: "never"
    }
  }), {
    ready: true,
    missingFacts: []
  });
});
