const assert = require("node:assert/strict");
const test = require("node:test");

const {
  normalizeCanonicalDate,
  inferDateFieldCodec,
  encodeDateForField,
  decodeDateFromField
} = require("../../apps/web/agent/date-field-codec");

test("date codec stores and validates only real canonical dates", () => {
  assert.equal(normalizeCanonicalDate("2003-05-31"), "2003-05-31");
  assert.equal(normalizeCanonicalDate("31-05-2003"), "");
  assert.equal(normalizeCanonicalDate("2003-02-29"), "");
  assert.equal(normalizeCanonicalDate("2004-02-29"), "2004-02-29");
});

test("date codec adapts canonical DOB from explicit field evidence", () => {
  assert.equal(encodeDateForField("2003-05-31", {
    inputType: "text",
    placeholder: "DD-MM-YYYY"
  }).value, "31-05-2003");
  assert.equal(encodeDateForField("2003-05-31", {
    inputType: "text",
    description: "Enter as MM/DD/YYYY"
  }).value, "05/31/2003");
  assert.equal(encodeDateForField("2003-05-31", {
    inputType: "date"
  }).value, "2003-05-31");
});

test("date codec supports separate day month and year controls", () => {
  assert.equal(encodeDateForField("2003-05-31", {
    autocomplete: "bday-day"
  }).value, "31");
  assert.equal(encodeDateForField("2003-05-31", {
    label: "Month",
    locale: "en-GB",
    options: [{ value: "5", label: "May" }]
  }).value, "5");
  assert.equal(encodeDateForField("2003-05-31", {
    name: "birth_year"
  }).value, "2003");
});

test("date codec parses the live site value back to the same canonical DOB", () => {
  const dmy = inferDateFieldCodec({ placeholder: "DD-MM-YYYY" });
  const mdy = inferDateFieldCodec({ placeholder: "MM/DD/YYYY" });
  assert.deepEqual(decodeDateFromField("31-05-2003", dmy), {
    ok: true,
    canonicalValue: "2003-05-31"
  });
  assert.deepEqual(decodeDateFromField("05/31/2003", mdy), {
    ok: true,
    canonicalValue: "2003-05-31"
  });
});

test("date codec refuses a genuinely ambiguous text field", () => {
  const inferred = inferDateFieldCodec({ inputType: "text", label: "Date of birth" });
  assert.equal(inferred.ok, false);
  assert.equal(inferred.code, "AMBIGUOUS_DATE_FORMAT");
  const encoded = encodeDateForField("2003-05-31", { inputType: "text", label: "Date of birth" });
  assert.equal(encoded.ok, false);
  assert.equal(encoded.code, "AMBIGUOUS_DATE_FORMAT");
});
