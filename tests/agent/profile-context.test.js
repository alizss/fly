const test = require("node:test");
const assert = require("node:assert/strict");

const {
  applySessionProfileOverrides,
  consumePendingProfileResponse,
  normalizeUserProvidedValue,
  profileFieldLabel
} = require("../../apps/web/agent/profile-context");

test("missing profile answers are accepted only for the active structured request", () => {
  const pendingInput = {
    requestId: "profile_input_1",
    field: "nationality",
    label: "nationality",
    subjectId: "trav_1",
    sensitive: false
  };
  assert.deepEqual(consumePendingProfileResponse({
    pendingInput,
    userResponse: {
      requestId: "profile_input_1",
      field: "nationality",
      value: "My nationality is TR",
      hasValue: true
    }
  }), {
    field: "nationality",
    value: "TR",
    source: "user_response"
  });
  assert.equal(consumePendingProfileResponse({
    pendingInput,
    userResponse: {
      requestId: "different_request",
      field: "nationality",
      value: "TR"
    }
  }), null);
  assert.equal(consumePendingProfileResponse({
    pendingInput,
    userResponse: {
      requestId: "profile_input_1",
      field: "issuing_country",
      value: "TR"
    }
  }), null);
});

test("session overrides merge into the effective traveler without mutating the saved profile", () => {
  const saved = {
    id: "trav_1",
    first_name: "Ali",
    nationality: "",
    address: {},
    document: null
  };
  const effective = applySessionProfileOverrides(saved, {
    nationality: "TR",
    country: "TR",
    passport_number: "profile://document_number",
    document_issue_date: "2024-05-31",
    document_expiry: "2034-05-30",
    emergency_contact_phone: "+90 555 010 2040"
  });
  assert.equal(saved.nationality, "");
  assert.equal(effective.nationality, "TR");
  assert.equal(effective.address.country, "TR");
  assert.equal(effective.document.has_document_number, true);
  assert.equal(effective.document.issue_date, "2024-05-31");
  assert.equal(effective.document.expiry_date, "2034-05-30");
  assert.equal(effective.emergency_contact_phone, "+90 555 010 2040");
});

test("profile response normalization covers common airline identity formats", () => {
  assert.equal(normalizeUserProvidedValue("document_number", " tst 123 456 "), "TST123456");
  assert.equal(normalizeUserProvidedValue("phone_country_code", "Turkey +90"), "+90");
  assert.equal(normalizeUserProvidedValue("gender", "Mr"), "male");
  assert.equal(normalizeUserProvidedValue("email", "Use TEST@EXAMPLE.TEST please"), "test@example.test");
  assert.equal(normalizeUserProvidedValue("document_issue_date", "2024-05-31"), "2024-05-31");
  assert.equal(profileFieldLabel("known_traveler_number"), "Known Traveler Number");
});
