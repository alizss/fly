const { normalizeCanonicalDate } = require("./date-field-codec");
const { normalizeProfileFieldType } = require("./logical-field");

const FIELD_LABELS = Object.freeze({
  email: "email address",
  confirm_email: "email confirmation",
  phone_country_code: "phone country code",
  phone: "phone number",
  title: "title",
  gender: "gender",
  first_name: "first name",
  middle_name: "middle name",
  last_name: "last name",
  second_last_name: "second surname",
  full_name: "full name",
  date_of_birth: "date of birth",
  place_of_birth: "place of birth",
  nationality: "nationality",
  country_of_residence: "country of residence",
  document_type: "travel document type",
  passport_number: "passport number",
  document_number: "travel document number",
  issuing_country: "document issuing country",
  document_issue_date: "document issue date",
  passport_expiry: "passport expiry date",
  document_expiry: "document expiry date",
  address_line1: "street address",
  address_line2: "address line 2",
  city: "city",
  state: "state or province",
  postal_code: "postal code",
  country: "address country",
  frequent_flyer_program: "frequent-flyer program",
  frequent_flyer_number: "frequent-flyer number",
  known_traveler_number: "Known Traveler Number",
  redress_number: "redress number",
  emergency_contact_name: "emergency contact name",
  emergency_contact_relationship: "emergency contact relationship",
  emergency_contact_phone: "emergency contact phone",
  emergency_contact_email: "emergency contact email",
  meal_preference: "meal preference",
  special_assistance: "special-assistance requirements"
});

const SUPPORTED_RESPONSE_FIELDS = new Set(Object.keys(FIELD_LABELS));
const DATE_FIELDS = new Set([
  "date_of_birth",
  "document_issue_date",
  "passport_expiry",
  "document_expiry"
]);
const DOCUMENT_NUMBER_FIELDS = new Set(["passport_number", "document_number"]);
const DOCUMENT_FIELDS = new Set([
  "document_type",
  "passport_number",
  "document_number",
  "issuing_country",
  "document_issue_date",
  "passport_expiry",
  "document_expiry"
]);
const ADDRESS_FIELDS = new Set(["address_line1", "address_line2", "city", "state", "postal_code", "country"]);

function canonicalResponseField(value = "") {
  const normalized = normalizeProfileFieldType(value) || String(value || "").trim().toLowerCase();
  return SUPPORTED_RESPONSE_FIELDS.has(normalized) ? normalized : "";
}

function profileFieldLabel(value = "") {
  const field = canonicalResponseField(value);
  return FIELD_LABELS[field] || String(value || "traveler detail").replace(/_/g, " ");
}

function stripAnswerPrefix(value = "", field = "") {
  const label = profileFieldLabel(field)
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+");
  return String(value || "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(new RegExp(`^(?:my|the|their)?\\s*${label}\\s*(?:is|=|:)\\s*`, "i"), "")
    .replace(/^(?:it is|it's|its|answer is)\s+/i, "")
    .trim();
}

function normalizeUserProvidedValue(fieldName = "", rawValue = "") {
  const field = canonicalResponseField(fieldName);
  if (!field) return "";
  let value = stripAnswerPrefix(rawValue, field).replace(/\s+/g, " ").trim().slice(0, 600);
  if (!value) return "";
  if (DATE_FIELDS.has(field)) return normalizeCanonicalDate(value);
  if (DOCUMENT_NUMBER_FIELDS.has(field)) return value.replace(/\s+/g, "").toUpperCase();
  if (field === "phone_country_code") {
    const digits = value.replace(/\D/g, "");
    return digits ? `+${digits}` : "";
  }
  if (field === "phone" || field === "emergency_contact_phone") {
    return value.replace(/[^\d+() -]/g, "").trim();
  }
  if (field === "email" || field === "confirm_email" || field === "emergency_contact_email") {
    const match = value.match(/[^\s@]+@[^\s@]+\.[^\s@]+/);
    return match ? match[0].toLowerCase() : "";
  }
  if (field === "title" || field === "gender") {
    const normalized = value.toLowerCase();
    if (/^(?:mr|mister|male|man)$/.test(normalized)) return field === "gender" ? "male" : "Mr";
    if (/^(?:mrs|ms|miss|female|woman|mrs\/ms)$/.test(normalized)) return field === "gender" ? "female" : "Mrs/Ms";
  }
  return value;
}

function applySessionProfileOverrides(traveler = {}, overrides = {}) {
  const effective = {
    ...(traveler || {}),
    document: { ...(traveler?.document || {}) },
    address: { ...(traveler?.address || {}) }
  };
  for (const [rawField, rawValue] of Object.entries(overrides || {})) {
    const field = canonicalResponseField(rawField);
    const value = String(rawValue || "");
    if (!field || !value) continue;
    if (DOCUMENT_FIELDS.has(field)) {
      if (DOCUMENT_NUMBER_FIELDS.has(field)) {
        if (value.startsWith("profile://")) {
          effective.document.has_document_number = true;
        } else {
          effective.document.document_number = value;
          effective.document.has_document_number = true;
        }
      } else if (field === "passport_expiry" || field === "document_expiry") {
        effective.document.expiry_date = value;
      } else if (field === "document_issue_date") {
        effective.document.issue_date = value;
      } else {
        effective.document[field] = value;
      }
      continue;
    }
    if (ADDRESS_FIELDS.has(field)) {
      const addressKey = field === "address_line1"
        ? "line1"
        : field === "address_line2"
          ? "line2"
          : field;
      effective.address[addressKey] = value;
      effective[field] = value;
      continue;
    }
    effective[field] = value;
    if (field === "title" && !effective.gender) {
      effective.gender = /^mr$/i.test(value) ? "male" : /^(?:mrs|ms|miss|mrs\/ms)$/i.test(value) ? "female" : "";
    }
  }
  return effective;
}

function consumePendingProfileResponse({
  pendingInput = null,
  userResponse = null,
  userMessage = ""
} = {}) {
  if (!pendingInput?.field) return null;
  const pendingField = canonicalResponseField(pendingInput.field);
  const responseField = canonicalResponseField(userResponse?.field || pendingField);
  if (!pendingField || responseField !== pendingField) return null;
  if (
    userResponse?.requestId
    && pendingInput.requestId
    && String(userResponse.requestId) !== String(pendingInput.requestId)
  ) {
    return null;
  }
  if (DOCUMENT_NUMBER_FIELDS.has(pendingField) && userResponse?.hasValue === true && userResponse?.valueRef) {
    return {
      field: pendingField,
      value: "profile://document_number",
      source: "browser_local_sensitive_value"
    };
  }
  const value = normalizeUserProvidedValue(pendingField, userResponse?.value || userMessage);
  return value ? { field: pendingField, value, source: "user_response" } : null;
}

module.exports = {
  FIELD_LABELS,
  SUPPORTED_RESPONSE_FIELDS,
  applySessionProfileOverrides,
  canonicalResponseField,
  consumePendingProfileResponse,
  normalizeUserProvidedValue,
  profileFieldLabel
};
