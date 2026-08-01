const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeProfileFieldType,
  semanticTypeForControl,
  resolveLogicalFields,
  logicalFieldSatisfied,
  verifyLogicalField
} = require("../../apps/web/agent/logical-field");
const {
  fieldDescriptors,
  deriveProfileGoal,
  candidatesForProfileGoal,
  profileGoalSatisfied
} = require("../../apps/web/agent/skill-expander");
const { evaluatePostcondition } = require("../../apps/web/agent/transition-evaluator");
const { semanticGoalKey, decisionInstanceKey } = require("../../packages/shared/agent-actions");

const traveler = {
  first_name: "Ali",
  last_name: "Sifrar",
  gender: "male",
  date_of_birth: "2003-05-31",
  phone: "+905551112233",
  document: {
    document_number: "P123456",
    expiry_date: "2031-09-14"
  }
};

function dateControl(role, value = "", options = {}) {
  const controlId = options.controlId || `ctrl_${role}`;
  const operation = options.operation || (role === "month" ? "select" : "type");
  return {
    controlId,
    stableKey: `passenger-dob-${role}`,
    semantic: "date_of_birth",
    fieldType: "date_of_birth",
    sectionId: "passenger_1",
    sectionType: "passenger",
    role: operation === "select" ? "select" : "textbox",
    kind: operation === "select" ? "select-one" : "text",
    label: `Date of birth ${role}`,
    name: `passengers.0.birth${role[0].toUpperCase()}${role.slice(1)}`,
    state: {
      normalizedValue: value,
      dateComponent: role,
      dateComponentValue: value,
      valuePresent: Boolean(value),
      disabled: false
    },
    dateField: {
      component: role,
      inputType: operation === "select" ? "select-one" : "text",
      options: options.options || []
    },
    operations: {
      [operation]: {
        operation,
        actuatorId: `target_${role}`,
        actuatorIds: [`target_${role}`]
      }
    }
  };
}

function fieldFor(control, options = {}) {
  return {
    controlId: control.controlId,
    field: control.fieldType,
    fieldType: control.fieldType,
    label: control.label,
    name: control.name,
    sectionId: control.sectionId,
    sectionType: control.sectionType,
    kind: control.kind,
    required: options.required !== false,
    hasValue: Boolean(control.state?.valuePresent),
    controlState: control.state,
    dateField: control.dateField,
    options: control.dateField?.options || []
  };
}

function observation(controls, validationIssues = [], observationId = "obs_1") {
  return {
    observationId,
    page: {
      step: "traveler_information",
      controls,
      fields: controls.map((control) => fieldFor(control)),
      validationIssues,
      sections: [{ id: "passenger_1", type: "passenger", label: "Passenger 1" }]
    }
  };
}

test("dob_partial_group_validation_does_not_retry_completed_component", () => {
  const controls = [
    dateControl("day", "31"),
    dateControl("month", "", {
      operation: "select",
      options: [{ value: "05", label: "May" }]
    }),
    dateControl("year", "")
  ];
  const observed = observation(controls, [{
    logicalFieldId: "lf_traveler_1_date_of_birth_passenger_1",
    message: "Enter complete date",
    stageWide: false
  }]);

  const logical = resolveLogicalFields(observed.page, traveler)[0];
  assert.equal(logical.components.find((component) => component.role === "day").status, "resolved");
  assert.equal(logical.components.find((component) => component.role === "month").status, "pending");
  assert.equal(logical.currentCanonicalValue, "");

  const goal = deriveProfileGoal(observed, traveler);
  assert.equal(goal.componentRole, "month");
  assert.equal(goal.desiredValue, "05");
  assert.notEqual(goal.controlId, "ctrl_day");
});

test("dob_rerender_rebinds_component_without_losing_progress", () => {
  const before = observation([
    dateControl("day", "31"),
    dateControl("month", ""),
    dateControl("year", "")
  ], [], "obs_before");
  const firstGoal = deriveProfileGoal(before, traveler);
  assert.equal(firstGoal.componentRole, "month");

  const after = observation([
    dateControl("day", "31", { controlId: "rerender_day" }),
    dateControl("month", "", { controlId: "rerender_month" }),
    dateControl("year", "", { controlId: "rerender_year" })
  ], [], "obs_after");
  const reboundGoal = deriveProfileGoal(after, traveler, firstGoal);

  assert.equal(reboundGoal.goalId, firstGoal.goalId);
  assert.equal(reboundGoal.componentRole, "month");
  assert.equal(reboundGoal.controlId, "rerender_month");
  assert.notEqual(reboundGoal.controlId, firstGoal.controlId);
});

test("dob_complete_value_verifies_canonically", () => {
  const observed = observation([
    dateControl("day", "31"),
    dateControl("month", "05"),
    dateControl("year", "2003")
  ]);
  const logical = resolveLogicalFields(observed.page, traveler)[0];

  assert.equal(logical.currentCanonicalValue, "2003-05-31");
  assert.equal(logical.desiredCanonicalValue, "2003-05-31");
  assert.equal(logicalFieldSatisfied(logical), true);
  assert.equal(deriveProfileGoal(observed, traveler), null);
});

test("displayed custom choice remains unresolved until its interaction commit settles", () => {
  const day = dateControl("day", "31");
  const month = dateControl("month", "05", {
    operation: "select",
    options: [{ value: "05", label: "May" }]
  });
  const year = dateControl("year", "2003");
  month.commitState = {
    status: "unsettled",
    popupClosed: false,
    focusSettled: false,
    actuatorId: "target_month"
  };
  const unsettled = observation([day, month, year], [], "obs_unsettled_choice");
  const unsettledLogical = resolveLogicalFields(unsettled.page, traveler)[0];
  const unsettledGoal = deriveProfileGoal(unsettled, traveler);

  assert.equal(unsettledLogical.currentCanonicalValue, "2003-05-31");
  assert.equal(logicalFieldSatisfied(unsettledLogical), false);
  assert.equal(unsettledGoal.componentRole, "month");
  assert.equal(profileGoalSatisfied(unsettledGoal, unsettled, traveler), false);

  month.commitState = {
    ...month.commitState,
    status: "settled",
    popupClosed: true,
    focusSettled: true
  };
  const settled = observation([day, month, year], [], "obs_settled_choice");
  const settledLogical = resolveLogicalFields(settled.page, traveler)[0];

  assert.equal(logicalFieldSatisfied(settledLogical), true);
  assert.equal(deriveProfileGoal(settled, traveler), null);
});

test("disabled Continue never reopens a settled logical field", () => {
  const day = dateControl("day", "31");
  const month = dateControl("month", "05", {
    operation: "select",
    options: [{ value: "05", label: "May" }]
  });
  const year = dateControl("year", "2003");
  month.commitState = {
    status: "settled",
    popupClosed: true,
    focusSettled: true,
    actuatorId: "target_month",
    attempts: 1,
    updatedAt: 300
  };
  const blocked = observation([day, month, year], [], "obs_blocked_reconciliation");
  blocked.page.currentSurface = { id: "surface-page", type: "page" };
  blocked.page.stageExit = {
    continueObserved: true,
    continueDisabled: true,
    blockers: ["Continue is disabled"]
  };

  assert.equal(deriveProfileGoal(blocked, traveler), null);
});

test("native date input is one scalar logical requirement", () => {
  const control = {
    controlId: "native_dob",
    stableKey: "native-date-of-birth",
    semantic: "date_of_birth",
    fieldType: "date_of_birth",
    sectionId: "passenger_1",
    sectionType: "passenger",
    role: "textbox",
    kind: "date",
    label: "Date of birth",
    name: "passengers.0.birthDate",
    state: {
      normalizedValue: "2003-05-31",
      canonicalDateValue: "2003-05-31",
      valuePresent: true,
      disabled: false
    },
    dateField: { inputType: "date", format: "ymd", separator: "-" },
    operations: {
      type: { operation: "type", actuatorId: "native_dob_target", actuatorIds: ["native_dob_target"] }
    }
  };
  const logical = resolveLogicalFields(observation([control]).page, traveler)[0];

  assert.equal(logical.structure, "scalar");
  assert.equal(logical.currentCanonicalValue, "2003-05-31");
  assert.equal(logicalFieldSatisfied(logical), true);
});

test("three dropdown date chooses only the next unresolved grounded component", () => {
  const controls = [
    dateControl("day", "31", { operation: "select", options: [{ value: "31", label: "31" }] }),
    dateControl("month", "", { operation: "select", options: [{ value: "05", label: "May" }] }),
    dateControl("year", "", { operation: "select", options: [{ value: "2003", label: "2003" }] })
  ];
  const observed = observation(controls);
  const goal = deriveProfileGoal(observed, traveler);
  const candidates = candidatesForProfileGoal(goal, observed, traveler);

  assert.equal(goal.componentRole, "month");
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].operation, "select");
  assert.equal(candidates[0].value, "05");
});

test("opaque dropdown date emits one trusted choice with a final date-value postcondition", () => {
  const month = dateControl("month", "", {
    operation: "select",
    options: [
      { value: "", label: "Month" },
      { value: "05", label: "May" }
    ]
  });
  month.state.disabled = true;
  month.operations = {};
  month.stateElementId = "month_hidden_state";
  month.preferredActivationElementId = "month_visible_widget";
  month.recovery = {
    select: {
      operation: "select",
      requiresVisualConfirmation: true,
      actuatorIds: ["month_visible_widget"],
      targetabilityByActuator: {
        month_visible_widget: {
          rendered: true,
          visible: true,
          enabled: true,
          inViewport: true,
          inCurrentSurface: true,
          hitTested: true,
          notOccluded: true,
          targetable: true,
          operationAuthorized: true,
          operationProven: false
        }
      },
      strategies: [{
        operation: "select",
        actuatorId: "month_visible_widget",
        method: "browser_trusted_choice",
        actionType: "click",
        status: "unproven_experiment"
      }],
      regions: []
    }
  };
  const observed = observation([
    dateControl("day", "31"),
    month,
    dateControl("year", "2003")
  ]);
  const goal = deriveProfileGoal(observed, traveler);
  const candidate = candidatesForProfileGoal(goal, observed, traveler, [], { includeAlternates: true })
    .find((item) => item.interactionMethod === "browser_trusted_choice");

  assert.equal(goal.componentRole, "month");
  assert.equal(candidate.operation, "select");
  assert.equal(candidate.type, "click");
  assert.equal(candidate.value, "May");
  assert.equal(candidate.boundedRecovery, true);
  assert.equal(candidate.expectedOutcome.type, "date_value_committed");
  assert.equal(candidate.expectedOutcome.expectedNormalizedValue, "05");
  assert.equal(candidate.expectedOutcome.expectedCanonicalValue, "2003-05-31");
});

test("atomic choice remains available when many open strategies exceed the candidate budget", () => {
  const month = dateControl("month", "", {
    operation: "select",
    options: [
      { value: "", label: "Month" },
      { value: "05", label: "May" }
    ]
  });
  month.state.disabled = true;
  month.operations = {};
  const proof = {
    rendered: true,
    visible: true,
    enabled: true,
    inViewport: true,
    inCurrentSurface: true,
    hitTested: true,
    notOccluded: true,
    targetable: true,
    operationAuthorized: true,
    operationProven: false
  };
  month.recovery = {
    open: {
      operation: "open",
      requiresVisualConfirmation: true,
      actuatorIds: Array.from({ length: 12 }, (_, index) => `month_open_${index}`),
      strategies: Array.from({ length: 12 }, (_, index) => ({
        operation: "open",
        actuatorId: `month_open_${index}`,
        method: index < 6 ? "native_click" : "pointer_sequence",
        actionType: "click",
        status: "unproven_experiment",
        actionability: proof
      })),
      regions: []
    },
    select: {
      operation: "select",
      requiresVisualConfirmation: true,
      actuatorIds: ["month_atomic"],
      strategies: [{
        operation: "select",
        actuatorId: "month_atomic",
        method: "browser_trusted_choice",
        actionType: "click",
        status: "unproven_experiment",
        actionability: proof
      }],
      regions: []
    }
  };
  const observed = observation([
    dateControl("day", "31"),
    month,
    dateControl("year", "2003")
  ]);
  const goal = deriveProfileGoal(observed, traveler);
  const candidates = candidatesForProfileGoal(goal, observed, traveler, [], { includeAlternates: true });

  assert.equal(candidates.length, 12);
  assert.ok(candidates.some((candidate) => (
    candidate.interactionMethod === "browser_trusted_choice"
    && candidate.operation === "select"
    && candidate.value === "May"
  )));
});

test("ambiguous full date produces only bounded grounded strategies for reasoning", () => {
  const control = {
    controlId: "ambiguous_dob",
    stableKey: "ambiguous-dob",
    semantic: "date_of_birth",
    fieldType: "date_of_birth",
    sectionId: "passenger_1",
    role: "textbox",
    kind: "text",
    label: "Date of birth",
    name: "dob",
    state: { normalizedValue: "", valuePresent: false, disabled: false },
    dateField: { inputType: "text", ambiguous: true },
    operations: {
      type: { operation: "type", actuatorId: "ambiguous_target", actuatorIds: ["ambiguous_target"] }
    }
  };
  const observed = observation([control]);
  const goal = deriveProfileGoal(observed, traveler);
  const candidates = candidatesForProfileGoal(goal, observed, traveler);

  assert.equal(goal.ambiguity.code, "AMBIGUOUS_DATE_FORMAT");
  assert.equal(candidates.length, 3);
  assert.deepEqual(candidates.map((candidate) => candidate.value), [
    "31/05/2003",
    "05/31/2003",
    "2003-05-31"
  ]);
  assert.equal(candidates.every((candidate) => candidate.requiresJudgment), true);
  assert.equal(candidates.every((candidate) => candidate.targetId === "ambiguous_target"), true);
});

test("group-level DOB ambiguity does not block a deterministic component", () => {
  const day = {
    ...dateControl("day", ""),
    name: "passengers.0.birthDay"
  };
  const ambiguousGroupMember = {
    controlId: "ambiguous_group_dob",
    stableKey: "ambiguous-group-dob",
    semantic: "date_of_birth",
    fieldType: "date_of_birth",
    name: "passengers.0.birth",
    label: "Date of birth",
    role: "textbox",
    kind: "text",
    state: { normalizedValue: "", valuePresent: false, disabled: false },
    dateField: { inputType: "text", ambiguous: true },
    operations: {
      type: { operation: "type", actuatorId: "ambiguous_group_target", actuatorIds: ["ambiguous_group_target"] }
    }
  };
  const observed = observation([
    day,
    ambiguousGroupMember,
    { ...dateControl("year", ""), name: "passengers.0.birthYear" }
  ]);
  const goal = deriveProfileGoal(observed, traveler);
  const candidates = candidatesForProfileGoal(goal, observed, traveler);

  assert.equal(goal.componentRole, "day");
  assert.equal(goal.ambiguity.code, "AMBIGUOUS_DATE_FORMAT");
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].operation, "type");
  assert.equal(candidates[0].value, "31");
  assert.equal(candidates[0].requiresJudgment, false);
});

test("raw machine semantics outrank a broad passenger group and DOB owns only its components", () => {
  const broadContext = "Passenger 1 Date of birth Nationality Title Passport number";
  const rawControls = [
    {
      controlId: "raw_nationality",
      name: "passengers.0.nationality",
      label: broadContext,
      sectionId: "passenger_1",
      role: "combobox",
      operations: { select: { actuatorId: "target_nationality", actuatorIds: ["target_nationality"] } },
      state: { normalizedValue: "" }
    },
    {
      controlId: "raw_title",
      name: "passengers.0.title",
      label: broadContext,
      sectionId: "passenger_1",
      role: "combobox",
      operations: { select: { actuatorId: "target_title", actuatorIds: ["target_title"] } },
      state: { normalizedValue: "" }
    },
    {
      controlId: "raw_document",
      name: "passengers.0.idNumber",
      label: broadContext,
      sectionId: "passenger_1",
      role: "textbox",
      operations: { type: { actuatorId: "target_document", actuatorIds: ["target_document"] } },
      state: { normalizedValue: "" }
    },
    ...["day", "month", "year"].map((role) => ({
      controlId: `raw_birth_${role}`,
      name: `passengers.0.birth${role[0].toUpperCase()}${role.slice(1)}`,
      autocomplete: `bday-${role}`,
      label: broadContext,
      sectionId: "passenger_1",
      role: role === "month" ? "combobox" : "textbox",
      dateField: { component: role },
      operations: {
        [role === "month" ? "select" : "type"]: {
          actuatorId: `target_birth_${role}`,
          actuatorIds: [`target_birth_${role}`]
        }
      },
      state: { normalizedValue: "", dateComponent: role, dateComponentValue: "" }
    }))
  ];
  const page = {
    controls: rawControls,
    fields: rawControls.map((control) => ({
      controlId: control.controlId,
      name: control.name,
      label: control.label,
      autocomplete: control.autocomplete,
      sectionId: control.sectionId,
      dateField: control.dateField
    })),
    validationIssues: []
  };

  assert.equal(normalizeProfileFieldType("passengers.0.nationality"), "nationality");
  assert.equal(normalizeProfileFieldType("passengers.0.title"), "title");
  assert.equal(normalizeProfileFieldType("passengers.0.idNumber"), "document_number");
  assert.equal(normalizeProfileFieldType("passengers.0.birthDay"), "date_of_birth");
  assert.equal(semanticTypeForControl(rawControls[0], page.fields[0]), "nationality");
  assert.equal(semanticTypeForControl(rawControls[1], page.fields[1]), "title");
  assert.equal(semanticTypeForControl(rawControls[2], page.fields[2]), "document_number");

  const logicalFields = resolveLogicalFields(page, traveler);
  const dob = logicalFields.find((field) => field.semanticType === "date_of_birth");
  assert.deepEqual(dob.components.map((component) => component.role), ["day", "month", "year"]);
  assert.equal(dob.components.some((component) => [
    "raw_nationality",
    "raw_title",
    "raw_document"
  ].includes(component.controlId)), false);
});

test("component verification remains successful while group validation is unresolved", () => {
  const before = observation([
    dateControl("day", ""),
    dateControl("month", ""),
    dateControl("year", "")
  ], [], "obs_before");
  const goal = deriveProfileGoal(before, traveler);
  assert.equal(goal.componentRole, "day");

  const after = observation([
    dateControl("day", "31"),
    dateControl("month", ""),
    dateControl("year", "")
  ], [{ message: "Enter complete date", logicalFieldId: goal.logicalFieldId }], "obs_after");

  assert.equal(profileGoalSatisfied(goal, after, traveler), true);
  assert.equal(deriveProfileGoal(after, traveler, goal).componentRole, "month");
});

test("phone and passport expiry reuse the same scalar/composite adapter contract", () => {
  const phoneCountry = {
    controlId: "ctrl_phone_country",
    stableKey: "phone-country",
    semantic: "phone_country_code",
    fieldType: "phone_country_code",
    sectionId: "contact",
    role: "combobox",
    kind: "select-one",
    state: { normalizedValue: "+90", valuePresent: true },
    operations: { select: { actuatorId: "target_phone_country", actuatorIds: ["target_phone_country"] } }
  };
  const phoneLocal = {
    controlId: "ctrl_phone_local",
    stableKey: "phone-local",
    semantic: "phone",
    fieldType: "phone",
    sectionId: "contact",
    role: "textbox",
    kind: "tel",
    state: { normalizedValue: "5551112233", valuePresent: true },
    operations: { type: { actuatorId: "target_phone_local", actuatorIds: ["target_phone_local"] } }
  };
  const expiryControls = ["day", "month", "year"].map((role, index) => ({
    ...dateControl(role, ["14", "09", "2031"][index], { controlId: `expiry_${role}` }),
    semantic: "passport_expiry",
    fieldType: "passport_expiry",
    sectionId: "document_1",
    name: `passengers.0.passportExpiry${role[0].toUpperCase()}${role.slice(1)}`
  }));
  const controls = [phoneCountry, phoneLocal, ...expiryControls];
  const page = {
    controls,
    fields: controls.map((control) => ({
      ...fieldFor(control),
      field: control.fieldType,
      fieldType: control.fieldType
    })),
    validationIssues: []
  };
  const logicalFields = resolveLogicalFields(page, traveler);
  const phone = logicalFields.find((field) => field.semanticType === "phone");
  const expiry = logicalFields.find((field) => field.semanticType === "passport_expiry");

  assert.equal(phone.structure, "composite");
  assert.equal(phone.currentCanonicalValue, "+905551112233");
  assert.equal(logicalFieldSatisfied(phone), true);
  assert.equal(expiry.structure, "composite");
  assert.equal(expiry.currentCanonicalValue, "2031-09-14");
  assert.equal(logicalFieldSatisfied(expiry), true);
});

test("logical field graph exposes one complete authoritative contract", () => {
  const controls = [
    dateControl("day", "31"),
    dateControl("month", "", {
      operation: "select",
      options: [{ value: "05", label: "May" }]
    }),
    dateControl("year", "")
  ];
  const page = observation(controls, [{
    logicalOwnerKey: "passengers_0_birth",
    message: "Enter complete date"
  }]).page;
  page.fields[1].description = "Use the month shown on the travel document.";
  const logical = resolveLogicalFields(page, traveler)[0];

  assert.equal(logical.logicalFieldId, "lf_traveler_1_date_of_birth_passengers_0_birth");
  assert.equal(logical.subjectId, "traveler_1");
  assert.equal(logical.semanticType, "date_of_birth");
  assert.equal(logical.controls.length, 3);
  assert.deepEqual(logical.controls.map((control) => control.componentRole), ["day", "month", "year"]);
  assert.equal(logical.instructions[0], "Use the month shown on the travel document.");
  assert.equal(logical.options.some((option) => option.componentRole === "month" && option.label === "May"), true);
  assert.equal(logical.validation.ownerId, logical.logicalFieldId);
  assert.equal(logical.validation.clear, false);
  assert.equal(logical.currentCanonicalValue, "");
  assert.equal(logical.desiredCanonicalValue, "2003-05-31");
});

test("logical and component identities survive DOM recreation and mutable presentation changes", () => {
  const makeControl = ({
    controlId,
    stableKey,
    placeholder,
    value,
    tightOwnerId
  }) => ({
    controlId,
    stableKey,
    fieldType: "nationality",
    label: "Nationality",
    placeholder,
    role: "combobox",
    state: { normalizedValue: value, valuePresent: Boolean(value) },
    fieldClassification: {
      fieldType: "nationality",
      source: "explicit_label",
      confidence: 0.98,
      tightOwnerId,
      tightOwnerKey: "path:form:none:0/div:group:2"
    },
    operations: {
      select: { operation: "select", actuatorIds: [`target_${controlId}`] }
    }
  });
  const beforeControl = makeControl({
    controlId: "react_before",
    stableKey: "combobox|meaning:choose nationality|path:old",
    placeholder: "Choose",
    value: "",
    tightOwnerId: "generated_owner_1"
  });
  const afterControl = makeControl({
    controlId: "react_after",
    stableKey: "combobox|meaning:turkey|path:new",
    placeholder: "Turkey",
    value: "TR",
    tightOwnerId: "generated_owner_2"
  });
  const before = resolveLogicalFields({
    controls: [beforeControl],
    fields: [{ ...beforeControl, controlState: beforeControl.state }],
    validationIssues: [{ controlId: "react_before", message: "Required" }]
  }, { nationality: "TR" })[0];
  const after = resolveLogicalFields({
    controls: [afterControl],
    fields: [{ ...afterControl, controlState: afterControl.state }],
    validationIssues: []
  }, { nationality: "TR" })[0];

  assert.equal(after.logicalFieldId, before.logicalFieldId);
  assert.equal(after.components[0].stableIdentity, before.components[0].stableIdentity);
  assert.equal(before.components[0].status, "pending");
  assert.equal(after.components[0].status, "resolved");
});

test("logical identity never falls back to mutable physical control identity", () => {
  const makeControl = (controlId, placeholder, value) => ({
    controlId,
    stableKey: `mutable-${controlId}-${placeholder}`,
    fieldType: "nationality",
    semantic: "nationality",
    label: "Nationality",
    placeholder,
    role: "combobox",
    state: { normalizedValue: value, valuePresent: Boolean(value) },
    operations: {
      select: { operation: "select", actuatorIds: [`target_${controlId}`] }
    }
  });
  const beforeControl = makeControl("dom_before", "Choose", "");
  const afterControl = makeControl("dom_after", "Türkiye", "TR");
  const before = resolveLogicalFields({
    controls: [beforeControl],
    fields: [{ ...beforeControl, controlState: beforeControl.state }]
  }, { nationality: "TR" })[0];
  const after = resolveLogicalFields({
    controls: [afterControl],
    fields: [{ ...afterControl, controlState: afterControl.state }]
  }, { nationality: "TR" })[0];

  assert.equal(before.logicalFieldId, after.logicalFieldId);
  assert.equal(before.components[0].stableIdentity, after.components[0].stableIdentity);
  assert.equal(before.logicalFieldId.includes("dom_before"), false);
  assert.equal(after.logicalFieldId.includes("dom_after"), false);
});

test("shared verifier separates component progress from logical completion", () => {
  const incomplete = observation([
    dateControl("day", "31"),
    dateControl("month", ""),
    dateControl("year", "")
  ], [{
    logicalFieldId: "lf_traveler_1_date_of_birth_passengers_0_birth",
    message: "Enter complete date"
  }]);
  const logicalFieldId = resolveLogicalFields(incomplete.page, traveler)[0].logicalFieldId;
  const partial = verifyLogicalField(incomplete.page, {
    logicalFieldId,
    subjectId: "traveler_1",
    semanticType: "date_of_birth",
    componentRole: "day",
    expectedComponentValue: "31",
    expectedCanonicalValue: "2003-05-31"
  });

  assert.equal(partial.componentResult.satisfied, true);
  assert.equal(partial.logicalFieldResult.satisfied, false);

  const complete = observation([
    dateControl("day", "31", { controlId: "new_day" }),
    dateControl("month", "05", { controlId: "new_month" }),
    dateControl("year", "2003", { controlId: "new_year" })
  ]);
  const final = verifyLogicalField(complete.page, {
    logicalFieldId,
    subjectId: "traveler_1",
    semanticType: "date_of_birth",
    componentRole: "year",
    expectedComponentValue: "2003",
    expectedCanonicalValue: "2003-05-31"
  });

  assert.equal(final.componentResult.satisfied, true);
  assert.equal(final.logicalFieldResult.satisfied, true);
});

test("completed component progress advances with a fresh strategy budget", () => {
  const before = observation([
    dateControl("day", ""),
    dateControl("month", "", {
      operation: "select",
      options: [{ value: "05", label: "May" }]
    }),
    dateControl("year", "")
  ]);
  const dayGoal = deriveProfileGoal(before, traveler);
  const [dayCandidate] = candidatesForProfileGoal(dayGoal, before, traveler);
  assert.equal(dayGoal.componentRole, "day");

  const after = observation([
    dateControl("day", "31", { controlId: "rerendered_day" }),
    dateControl("month", "", {
      controlId: "rerendered_month",
      operation: "select",
      options: [{ value: "05", label: "May" }]
    }),
    dateControl("year", "", { controlId: "rerendered_year" })
  ], [], "obs_next_component");
  const monthGoal = deriveProfileGoal(after, traveler, dayGoal);
  const monthCandidates = candidatesForProfileGoal(monthGoal, after, traveler, [dayCandidate.candidateId]);

  assert.equal(monthGoal.componentRole, "month");
  assert.equal(monthCandidates.length, 1);
  assert.equal(monthCandidates[0].value, "05");
  assert.notEqual(monthCandidates[0].candidateId, dayCandidate.candidateId);
  assert.equal(fieldDescriptors(after, traveler).find((descriptor) => descriptor.componentRole === "day").hasValue, true);
});

test("transition verification reports local component success without inventing logical completion", () => {
  const before = observation([
    dateControl("day", ""),
    dateControl("month", ""),
    dateControl("year", "")
  ], [], "obs_before_transition");
  const goal = deriveProfileGoal(before, traveler);
  const after = observation([
    dateControl("day", "31", { controlId: "fresh_day" }),
    dateControl("month", "", { controlId: "fresh_month" }),
    dateControl("year", "", { controlId: "fresh_year" })
  ], [{
    logicalFieldId: goal.logicalFieldId,
    message: "Enter complete date"
  }], "obs_after_transition");
  const result = evaluatePostcondition({
    type: "date_value_committed",
    controlId: goal.controlId,
    logicalFieldId: goal.logicalFieldId,
    subjectId: goal.subjectId,
    semanticType: goal.semanticType,
    componentRole: "day",
    expectedNormalizedValue: "31",
    expectedCanonicalValue: "2003-05-31",
    dateCodec: { ok: true, kind: "component", component: "day" }
  }, {
    controlId: goal.controlId,
    value: "31"
  }, before, after, {
    changed: [{ controlId: "fresh_day" }]
  }, {
    dispatched: true
  });

  assert.equal(result.satisfied, true);
  assert.equal(result.evidence.componentResult.satisfied, true);
  assert.equal(result.evidence.logicalFieldResult.satisfied, false);
});

test("recovery memory is scoped to the stable logical field component", () => {
  const shared = {
    semanticType: "date_of_birth",
    logicalFieldId: "lf_traveler_1_date_of_birth_passengers_0_birth",
    subjectId: "traveler_1",
    desiredValue: "05",
    ordinal: 0
  };
  const day = { ...shared, componentRole: "day" };
  const month = { ...shared, componentRole: "month" };
  const observationPage = {
    step: "traveler_information",
    currentSurface: { id: "surface-page", type: "page" }
  };

  assert.notEqual(semanticGoalKey(day), semanticGoalKey(month));
  assert.notEqual(
    decisionInstanceKey(day, { page: observationPage }),
    decisionInstanceKey(month, { page: observationPage })
  );
});

test("phone components share a stable owner through standard autocomplete contracts", () => {
  const controls = [
    {
      controlId: "phone_code",
      fieldType: "phone_country_code",
      autocomplete: "tel-country-code",
      role: "combobox",
      state: { normalizedValue: "+90" },
      operations: { select: { actuatorIds: ["phone_code_target"] } }
    },
    {
      controlId: "phone_local",
      fieldType: "phone",
      autocomplete: "tel-national",
      role: "textbox",
      state: { normalizedValue: "5551112233" },
      operations: { type: { actuatorIds: ["phone_local_target"] } }
    }
  ];
  const page = {
    controls,
    fields: controls.map((control) => ({
      ...control,
      controlState: control.state
    })),
    validationIssues: []
  };
  const phone = resolveLogicalFields(page, traveler)
    .find((field) => field.semanticType === "phone");

  assert.equal(phone.structure, "composite");
  assert.deepEqual(phone.components.map((component) => component.componentRole), ["country_code", "local_number"]);
  assert.equal(phone.currentCanonicalValue, "+905551112233");
});
