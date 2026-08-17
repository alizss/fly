const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluateActionPolicy } = require("../../packages/shared/policy");

function legalAction(overrides = {}) {
  return {
    type: "click",
    controlId: "terms_control",
    risk: "legal",
    intent: "accept_legal_terms",
    mechanicalEffect: "accept_legal_terms",
    targetSnapshot: { controlId: "terms_control", risk: "legal", semantic: "accept_legal_terms" },
    expectedOutcome: {
      type: "legal_attestation_accepted",
      controlId: "terms_control",
      authorizationId: "legal_auth_exact",
      legalTextDigest: "terms_digest"
    },
    ...overrides
  };
}

function authorization(overrides = {}) {
  return {
    contractVersion: "legal-authorization/v1",
    authorizationId: "legal_auth_exact",
    transactionId: "chk_exact",
    legalControlId: "terms_control",
    legalTextDigest: "terms_digest",
    expiresAt: Date.now() + 60_000,
    ...overrides
  };
}

test("legal acceptance requires the exact current transaction-bound authorization", () => {
  const state = { id: "chk_exact", approvals: {} };
  assert.equal(evaluateActionPolicy(legalAction(), state).decision, "ask_user");
  assert.equal(evaluateActionPolicy(legalAction(), state, {}, {
    legalAuthorization: authorization({ legalTextDigest: "different_terms" })
  }).decision, "ask_user");
  assert.equal(evaluateActionPolicy(legalAction(), state, {}, {
    legalAuthorization: authorization({ legalControlId: "different_control" })
  }).decision, "ask_user");
  assert.equal(evaluateActionPolicy(legalAction(), state, {}, {
    legalAuthorization: authorization({ transactionId: "different_transaction" })
  }).decision, "ask_user");

  const allowed = evaluateActionPolicy(legalAction(), state, {}, {
    legalAuthorization: authorization()
  });
  assert.equal(allowed.allow, true);
  assert.equal(allowed.authorization.authorizationId, "legal_auth_exact");
});

