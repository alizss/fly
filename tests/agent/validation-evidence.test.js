const test = require("node:test");
const assert = require("node:assert/strict");
const {
  activeValidationIssues,
  validationIssueIsBlocking
} = require("../../apps/web/agent/validation-evidence");

test("validation lifecycle ignores zero, hidden, stale, and unowned diagnostic error prose", () => {
  const issues = [
    { message: "0 error Please check the information below marked in red", status: "clear", errorCount: 0, visible: true },
    { message: "No errors", status: "clear", visible: true },
    { message: "There was an error", status: "unresolved", visible: true },
    { message: "Old error summary", status: "active_stage_error", visible: false },
    { message: "Error-format instructions", status: "diagnostic", visible: true }
  ];
  assert.deepEqual(activeValidationIssues(issues), []);
});

test("validation lifecycle blocks exact invalid controls and positive active stage failures", () => {
  const phone = {
    message: "Please enter a valid phone number",
    status: "active_control_error",
    active: true,
    visible: true,
    controlId: "ctrl_phone",
    invalidControlIds: ["ctrl_phone"]
  };
  const stage = {
    message: "1 error remains",
    status: "active_stage_error",
    active: true,
    visible: true,
    errorCount: 1,
    stageWide: true
  };
  assert.equal(validationIssueIsBlocking(phone), true);
  assert.equal(validationIssueIsBlocking(stage), true);
  assert.deepEqual(activeValidationIssues([phone, stage]), [phone, stage]);
});

test("legacy owned validation remains blocking while legacy unowned prose is diagnostic", () => {
  assert.equal(validationIssueIsBlocking({ message: "Invalid phone", controlId: "ctrl_phone" }), true);
  assert.equal(validationIssueIsBlocking({ message: "Enter complete date", logicalOwnerKey: "traveler_dob" }), true);
  assert.equal(validationIssueIsBlocking({ message: "Something has an error" }), false);
});
