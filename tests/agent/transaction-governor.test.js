const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createStore } = require("../../apps/web/agent/session-store");
const { governAction } = require("../../apps/web/agent/action-governor");
const {
  advanceSkillPlan,
  createSkillPlan,
  currentProfileSkillAtom,
  dateValueForField,
  expandSkillAction,
  normalizedPhoneParts,
  profileStageReadiness,
  resumeSuspendedSkillPlan,
  skillRecoveryContext,
  blockedObligationForPlan,
  exactRecoveryProof,
  recordBlockedObligationAttempt,
  reconcileBlockedObligationResult
} = require("../../apps/web/agent/skill-expander");
const { runLoopTurn, __private: loopPrivate } = require("../../apps/web/agent/loop");
const { createCheckoutSessionState } = require("../../packages/shared/agent-state");

function fixture() {
  const state = createCheckoutSessionState({
    goal: "Complete checkout without extras",
    travelerId: "trav_1",
    site: { host: "example.test", url: "https://example.test/checkout" }
  });
  state.id = "txn_test";
  const observation = {
    observationId: "obs_1",
    observationSnapshot: { snapshotHash: "hash_1" },
    page: {
      site: "example.test",
      url: "https://example.test/checkout",
      step: "extras",
      snapshotHash: "hash_1",
      viewport: { width: 1200, height: 800 },
      graphIntegrity: { ok: true, conflicts: [] },
      foreground: { active: true, id: "surface_1", type: "modal", blocksBackground: true },
      currentSurface: { id: "surface_1", type: "modal", label: "Optional baggage" },
      price: { amount: 200, currency: "EUR" },
      controls: [
        {
          controlId: "ctrl_decline",
          decisionGroupId: "dg_baggage_confirm",
          label: "I'll go without",
          kind: "button",
          semantic: "decline_paid_extra",
          risk: "safe_decline",
          surfaceId: "surface_1",
          surfaceType: "modal",
          state: { disabled: false },
          stateElementId: "el_decline_state",
          preferredActivationElementId: "el_decline",
          actuators: [
            { nodeId: "el_decline_state", relation: "state" },
            { nodeId: "el_decline", relation: "activation" },
            { nodeId: "el_decline_label", relation: "label" },
            { nodeId: "el_decline_wrapper", relation: "wrapper" }
          ],
          visualRegion: { x: 100, y: 100, width: 180, height: 40, inViewport: true }
        }
      ],
      decisionGroups: []
    }
  };
  return { state, observation };
}

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atw-store-"));
  return { dir, dbPath: path.join(dir, "transactions.sqlite") };
}

test("P0.2/P0.3 reconstructs the transaction, observation, action, and result after restart", () => {
  const { dir, dbPath } = tempDb();
  const { state, observation } = fixture();
  state.policySnapshot = {
    bookingRules: "No paid extras",
    baggagePreference: "personal item",
    preferredSeat: "no preference",
    paymentPreference: "manual payment"
  };
  let store = createStore({ dbPath });
  store.saveSession(state);
  store.recordObservation(state.id, observation);
  const action = {
    id: "act_1",
    type: "click",
    observationId: "obs_1",
    observationHash: "hash_1",
    intent: "decline_optional_extra",
    controlId: "ctrl_decline",
    decisionGroupId: "dg_baggage_confirm",
    targetId: "ctrl_decline",
    targetLabel: "I'll go without",
    targetSnapshot: {
      id: "el_decline",
      controlId: "ctrl_decline",
      decisionGroupId: "dg_baggage_confirm",
      semantic: "decline_paid_extra",
      risk: "safe_decline",
      surfaceId: "surface_1",
      surfaceType: "modal"
    },
    expectedOutcome: {
      type: "active_surface_dismissed",
      surfaceId: "surface_1",
      surfaceType: "modal",
      mustNotIncreasePrice: true
    },
    risk: "safe",
    requiresApproval: false,
    reason: "Decline the optional paid baggage."
  };
  assert.equal(store.reserveGovernedAction({ transactionId: state.id, turnId: "turn_1", action, observationId: "obs_1", observationHash: "hash_1" }).ok, true);
  store.updateGovernedAction("act_1", "verified", { actionId: "act_1", verified: true });
  store.close();

  store = createStore({ dbPath });
  const reconstructed = store.reconstructTransaction(state.id);
  assert.equal(reconstructed.state.id, state.id);
  assert.equal(reconstructed.state.policySnapshot.bookingRules, "No paid extras");
  assert.equal(reconstructed.currentObservation.observationId, "obs_1");
  assert.equal(reconstructed.observations.length, 1);
  assert.equal(reconstructed.actions[0].action_id, "act_1");
  assert.equal(reconstructed.actions[0].status, "verified");
  assert.equal(reconstructed.actions[0].result.verified, true);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("P0.2 rejects an observation id reused with a different immutable hash", () => {
  const { dir, dbPath } = tempDb();
  const { state, observation } = fixture();
  const store = createStore({ dbPath });
  store.saveSession(state);
  store.recordObservation(state.id, observation);
  assert.throws(() => store.recordObservation(state.id, {
    ...observation,
    observationSnapshot: { snapshotHash: "different_hash" }
  }), /Immutable observation conflict/);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("P0.6 governor allows one current canonical safe action and rejects its duplicate", () => {
  const { dir, dbPath } = tempDb();
  const { state, observation } = fixture();
  const store = createStore({ dbPath });
  store.saveSession(state);
  store.recordObservation(state.id, observation);
  const action = {
    id: "act_safe",
    type: "click",
    observationId: "obs_1",
    observationHash: "hash_1",
    intent: "decline_optional_extra",
    controlId: "ctrl_decline",
    decisionGroupId: "dg_baggage_confirm",
    targetId: "ctrl_decline",
    targetLabel: "I'll go without",
    targetSnapshot: {
      id: "el_decline",
      controlId: "ctrl_decline",
      decisionGroupId: "dg_baggage_confirm",
      semantic: "decline_paid_extra",
      risk: "safe_decline",
      surfaceId: "surface_1",
      surfaceType: "modal"
    },
    expectedOutcome: {
      type: "active_surface_dismissed",
      surfaceId: "surface_1",
      surfaceType: "modal",
      mustNotIncreasePrice: true
    },
    risk: "safe",
    reason: "Decline paid baggage."
  };
  const allowed = governAction({ action, state, observation, traveler: { id: "trav_1", booking_rules: "no extras" }, store, turnId: "turn_1" });
  assert.equal(allowed.allow, true);
  const duplicate = governAction({ action: { ...action, id: "act_safe_2" }, state: allowed.state, observation, traveler: { id: "trav_1", booking_rules: "no extras" }, store, turnId: "turn_2" });
  assert.equal(duplicate.allow, false);
  assert.equal(duplicate.code, "DUPLICATE_ACTION_ATTEMPT");
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("P0.2/P0.6 persists a failed actuator and forbids the identical retry across observations", () => {
  const { dir, dbPath } = tempDb();
  const { state, observation } = fixture();
  const store = createStore({ dbPath });
  store.saveSession(state);
  store.recordObservation(state.id, observation);
  store.recordActionResult(state.id, {
    at: new Date().toISOString(),
    actionId: "act_failed",
    observationId: "obs_1",
    executed: true,
    verified: false,
    action: {
      id: "act_failed",
      action: "click",
      targetId: "el_decline",
      targetLabel: "I'll go without",
      value: ""
    },
    targetSnapshot: {
      id: "el_decline",
      controlId: "ctrl_decline",
      decisionGroupId: "dg_baggage_confirm",
      semantic: "decline_paid_extra",
      risk: "safe_decline",
      surfaceId: "surface_1",
      surfaceType: "modal"
    },
    outcome: {
      code: "NO_OBSERVABLE_CHANGE",
      message: "The modal remained open."
    }
  });

  const failedState = store.getSession(state.id);
  assert.equal(failedState.failures.length, 1);
  assert.equal(failedState.failures[0].targetId, "el_decline");

  const repeatedAction = {
    id: "act_repeat_failed",
    type: "click",
    observationId: "obs_1",
    observationHash: "hash_1",
    intent: "decline_optional_extra",
    controlId: "ctrl_decline",
    decisionGroupId: "dg_baggage_confirm",
    targetId: "el_decline",
    targetLabel: "I'll go without",
    targetSnapshot: {
      id: "el_decline",
      controlId: "ctrl_decline",
      decisionGroupId: "dg_baggage_confirm",
      semantic: "decline_paid_extra",
      risk: "safe_decline",
      surfaceId: "surface_1",
      surfaceType: "modal"
    },
    expectedOutcome: {
      type: "active_surface_dismissed",
      surfaceId: "surface_1",
      surfaceType: "modal"
    },
    risk: "safe",
    reason: "Try the same actuator again."
  };
  const blocked = governAction({
    action: repeatedAction,
    state: failedState,
    observation,
    traveler: { id: "trav_1", booking_rules: "no extras" },
    store,
    turnId: "turn_repeat_failed"
  });
  assert.equal(blocked.allow, false);
  assert.equal(blocked.code, "FAILED_ACTUATOR_REUSE");

  const alternateAction = {
    ...repeatedAction,
    id: "act_alternate",
    targetId: "el_decline_label",
    targetSnapshot: {
      ...repeatedAction.targetSnapshot,
      id: "el_decline_label"
    },
    reason: "Use another canonical actuator."
  };
  const alternate = governAction({
    action: alternateAction,
    state: failedState,
    observation,
    traveler: { id: "trav_1", booking_rules: "no extras" },
    store,
    turnId: "turn_alternate"
  });
  assert.equal(alternate.allow, true);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("P0.7/P0.9 governor accepts agreeing canonical aliases as one target", () => {
  const { dir, dbPath } = tempDb();
  const { state, observation } = fixture();
  const store = createStore({ dbPath });
  store.saveSession(state);
  store.recordObservation(state.id, observation);
  const action = {
    id: "act_alias_governed",
    type: "click",
    observationId: "obs_1",
    observationHash: "hash_1",
    intent: "decline_optional_extra",
    controlId: "ctrl_decline",
    decisionGroupId: "dg_baggage_confirm",
    targetId: "el_decline_wrapper",
    targetSnapshot: {
      id: "el_decline",
      controlId: "ctrl_decline",
      decisionGroupId: "dg_baggage_confirm",
      semantic: "decline_paid_extra",
      risk: "safe_decline",
      surfaceId: "surface_1",
      surfaceType: "modal",
      stateElementId: "el_decline_state",
      preferredActivationElementId: "el_decline",
      actuators: [
        { nodeId: "el_decline_label", relation: "label" },
        { nodeId: "el_decline_wrapper", relation: "wrapper" }
      ]
    },
    expectedOutcome: {
      type: "active_surface_dismissed",
      surfaceId: "surface_1",
      surfaceType: "modal",
      mustNotIncreasePrice: true
    },
    risk: "safe",
    reason: "Decline paid baggage through its canonical wrapper alias."
  };

  const governed = governAction({
    action,
    state,
    observation,
    traveler: { id: "trav_1", booking_rules: "no extras" },
    store,
    turnId: "turn_alias"
  });
  assert.equal(governed.allow, true);
  assert.equal(governed.checks.some((check) => check.code === "CANONICAL_TARGET_CURRENT"), true);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("P0.4/P0.7 governor rejects typing through a label or activation member", () => {
  const { dir, dbPath } = tempDb();
  const { state, observation } = fixture();
  observation.page.controls.push({
    controlId: "ctrl_email",
    label: "E-mail",
    kind: "field",
    role: "textbox",
    semantic: "email",
    risk: "safe",
    surfaceId: "surface_1",
    surfaceType: "modal",
    state: { disabled: false },
    stateElementId: "el_email_input",
    preferredActivationElementId: "el_email_label",
    actuators: [
      { nodeId: "el_email_input", relation: "state" },
      { nodeId: "el_email_label", relation: "label" }
    ],
    visualRegion: { x: 100, y: 220, width: 240, height: 40, inViewport: true }
  });
  const store = createStore({ dbPath });
  store.saveSession(state);
  store.recordObservation(state.id, observation);

  const governed = governAction({
    action: {
      id: "act_type_wrong_member",
      type: "type",
      observationId: "obs_1",
      observationHash: "hash_1",
      intent: "satisfy_field",
      controlId: "ctrl_email",
      targetId: "el_email_label",
      targetLabel: "E-mail",
      value: "ali@example.test",
      targetSnapshot: {
        id: "el_email_label",
        controlId: "ctrl_email",
        semantic: "email",
        risk: "safe",
        surfaceId: "surface_1",
        surfaceType: "modal",
        stateElementId: "el_email_input",
        preferredActivationElementId: "el_email_label"
      },
      expectedOutcome: {
        type: "field_value_changed",
        controlId: "ctrl_email",
        expectedValue: "ali@example.test"
      },
      risk: "safe",
      reason: "Type the email address."
    },
    state,
    observation,
    traveler: { id: "trav_1", booking_rules: "no extras" },
    store,
    turnId: "turn_wrong_member"
  });

  assert.equal(governed.allow, false);
  assert.equal(governed.code, "ACTION_ACTUATOR_KIND_MISMATCH");
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("P0.7 rejects click_xy without an observation-bound visual region", () => {
  const { dir, dbPath } = tempDb();
  const { state, observation } = fixture();
  const store = createStore({ dbPath });
  store.saveSession(state);
  store.recordObservation(state.id, observation);
  const governed = governAction({
    action: {
      id: "act_xy",
      type: "click_xy",
      observationId: "obs_1",
      observationHash: "hash_1",
      x: 150,
      y: 150,
      targetLabel: "visual canvas target",
      targetSnapshot: { source: "visual_fallback", surfaceId: "surface_1" },
      risk: "safe",
      reason: "Click a visual-only target."
    },
    state,
    observation,
    traveler: { id: "trav_1" },
    store,
    turnId: "turn_xy"
  });
  assert.equal(governed.allow, false);
  assert.equal(governed.code, "VISUAL_REGION_REQUIRED");
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("P0.6 rejects actions bound to a stale stored observation", () => {
  const { dir, dbPath } = tempDb();
  const { state, observation } = fixture();
  const store = createStore({ dbPath });
  store.saveSession(state);
  store.recordObservation(state.id, observation);
  store.recordObservation(state.id, {
    ...observation,
    observationId: "obs_2",
    observationSnapshot: { snapshotHash: "hash_2" },
    page: { ...observation.page, snapshotHash: "hash_2" }
  });
  const result = governAction({
    action: {
      id: "act_stale",
      type: "click",
      observationId: "obs_1",
      observationHash: "hash_1",
      controlId: "ctrl_decline",
      targetSnapshot: { controlId: "ctrl_decline" },
      risk: "safe",
      reason: "stale"
    },
    state,
    observation,
    traveler: { id: "trav_1" },
    store,
    turnId: "turn_stale"
  });
  assert.equal(result.allow, false);
  assert.equal(result.code, "STALE_OBSERVATION");
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("P0.4 expands a profile skill into one canonical atomic field action", () => {
  const { observation } = fixture();
  observation.page.fields = [{
    id: "el_email",
    controlId: "ctrl_email",
    field: "email",
    label: "Email",
    kind: "email",
    hasValue: false
  }];
  observation.page.controls.push({
    controlId: "ctrl_email",
    label: "Email",
    kind: "email",
    role: "textbox",
    semantic: "email",
    risk: "safe",
    surfaceId: "surface_1",
    state: { disabled: false },
    stateElementId: "el_email",
    preferredActivationElementId: "el_email_label",
    actuators: [
      { nodeId: "el_email", relation: "state" },
      { nodeId: "el_email_label", relation: "label" }
    ],
    operations: {
      activate: null,
      open: null,
      choose: null,
      type: { operation: "type", actuatorId: "el_email", actuatorIds: ["el_email"], precondition: { disabled: false }, expectedOutcome: "normalized_value_changed" },
      select: null
    },
    visualRegion: { x: 100, y: 200, width: 240, height: 40, inViewport: true }
  });
  const result = expandSkillAction({
    id: "act_fill",
    type: "fill_visible_profile_fields",
    observationId: "obs_1",
    observationHash: "hash_1",
    risk: "safe",
    reason: "Fill traveler details."
  }, observation, { id: "trav_1", email: "ali@example.test" });
  assert.equal(result.expanded, true);
  assert.equal(result.action.type, "type");
  assert.equal(result.action.controlId, "ctrl_email");
  assert.equal(result.action.operation, "type");
  assert.equal(result.action.targetId, "el_email");
  assert.equal(result.action.value, "ali@example.test");
});

function profileFormObservation({ observationId = "obs_form_1", emailFilled = false, phoneFilled = false } = {}) {
  const snapshotHash = `${observationId}_hash`;
  return {
    observationId,
    observationSnapshot: { snapshotHash },
    page: {
      site: "example.test",
      url: "https://example.test/traveler",
      step: "traveler_information",
      snapshotHash,
      activeSurface: { id: "", type: "page", label: "" },
      currentSurface: { id: "", type: "page", label: "" },
      fields: [
        { id: `el_email_${observationId}`, controlId: `ctrl_email_${observationId}`, field: "email", label: "Email", kind: "email", hasValue: emailFilled },
        { id: `el_phone_${observationId}`, controlId: `ctrl_phone_${observationId}`, field: "phone", label: "Phone", kind: "tel", hasValue: phoneFilled }
      ],
      controls: [
        {
          controlId: `ctrl_email_${observationId}`,
          label: "Email",
          kind: "email",
          role: "textbox",
          semantic: "email",
          risk: "safe",
          surfaceId: "",
          state: { disabled: false, valuePresent: emailFilled, normalizedValue: emailFilled ? "ali@example.test" : "" },
          stateElementId: `el_email_${observationId}`,
          preferredActivationElementId: `el_email_label_${observationId}`,
          actuators: [
            { nodeId: `el_email_${observationId}`, relation: "state" },
            { nodeId: `el_email_label_${observationId}`, relation: "label" }
          ],
          operations: {
            activate: null,
            open: null,
            choose: null,
            type: { operation: "type", actuatorId: `el_email_${observationId}`, actuatorIds: [`el_email_${observationId}`], precondition: { disabled: false }, expectedOutcome: "normalized_value_changed" },
            select: null
          }
        },
        {
          controlId: `ctrl_phone_${observationId}`,
          label: "Phone",
          kind: "tel",
          role: "textbox",
          semantic: "phone",
          risk: "safe",
          surfaceId: "",
          state: { disabled: false, valuePresent: phoneFilled, normalizedValue: phoneFilled ? "40111222" : "" },
          stateElementId: `el_phone_${observationId}`,
          preferredActivationElementId: `el_phone_label_${observationId}`,
          actuators: [
            { nodeId: `el_phone_${observationId}`, relation: "state" },
            { nodeId: `el_phone_label_${observationId}`, relation: "label" }
          ],
          operations: {
            activate: null,
            open: null,
            choose: null,
            type: { operation: "type", actuatorId: `el_phone_${observationId}`, actuatorIds: [`el_phone_${observationId}`], precondition: { disabled: false }, expectedOutcome: "normalized_value_changed" },
            select: null
          }
        }
      ]
    }
  };
}

function completeProfileObservation({ observationId = "obs_complete_profile", filled = new Set(), errors = [] } = {}) {
  const snapshotHash = `${observationId}_hash`;
  const normalizedValues = {
    email: "ali@example.test",
    confirm_email: "ali@example.test",
    phone_country_code: "+386",
    phone: "70328922",
    title: "selected",
    first_name: "ali",
    last_name: "sifrar",
    date_of_birth: "31-05-2003"
  };
  const definitions = [
    { semantic: "email", label: "E-mail", kind: "email", role: "textbox", sectionType: "contact" },
    { semantic: "confirm_email", label: "Confirm e-mail address", kind: "email", role: "textbox", sectionType: "contact" },
    {
      semantic: "phone_country_code",
      label: "Country code",
      kind: "select",
      role: "combobox",
      sectionType: "contact",
      options: [{ value: "+386", label: "+386 Slovenia" }, { value: "+44", label: "+44 United Kingdom" }]
    },
    { semantic: "phone", label: "Mobile number", kind: "tel", role: "textbox", sectionType: "contact" },
    { semantic: "title", label: "Mr", kind: "radio", role: "radio", sectionType: "passenger", option: "Mr" },
    { semantic: "title", label: "Mrs/Ms", kind: "radio", role: "radio", sectionType: "passenger", option: "Mrs/Ms" },
    { semantic: "first_name", label: "First name(s)", kind: "text", role: "textbox", sectionType: "passenger" },
    { semantic: "last_name", label: "Surname", kind: "text", role: "textbox", sectionType: "passenger" },
    { semantic: "date_of_birth", label: "Date of birth DD-MM-YYYY", placeholder: "DD-MM-YYYY", kind: "text", role: "textbox", sectionType: "passenger" }
  ];
  const counters = new Map();
  const fields = definitions.map((definition) => {
    const ordinal = counters.get(definition.semantic) || 0;
    counters.set(definition.semantic, ordinal + 1);
    const key = definition.semantic === "title" ? `${definition.semantic}:${definition.option}` : definition.semantic;
    const selected = filled.has(key) || (definition.semantic === "title" && definition.option === "Mr" && filled.has("title"));
    const suffix = `${definition.semantic}_${ordinal}_${observationId}`;
    return {
      id: `el_${suffix}`,
      controlId: `ctrl_${suffix}`,
      field: definition.semantic,
      semantic: definition.semantic,
      label: definition.label,
      placeholder: definition.placeholder || "",
      kind: definition.kind,
      role: definition.role,
      options: definition.options || [],
      required: true,
      hasValue: selected,
      controlState: {
        valuePresent: selected,
        normalizedValue: selected ? normalizedValues[definition.semantic] || "filled" : "",
        checked: definition.kind === "radio" && selected,
        selected: definition.kind === "radio" && selected
      },
      sectionType: definition.sectionType
    };
  });
  const controls = fields.map((field) => ({
    controlId: field.controlId,
    label: field.label,
    accessibleName: field.label,
    kind: field.kind,
    role: field.role,
    semantic: field.semantic,
    risk: "safe",
    sectionType: field.sectionType,
    surfaceId: "",
    state: {
      disabled: false,
      valuePresent: field.hasValue,
      normalizedValue: field.controlState.normalizedValue,
      checked: field.controlState.checked,
      selected: field.controlState.selected
    },
    stateElementId: field.id,
    preferredActivationElementId: field.kind === "radio" ? `label_${field.id}` : field.id,
    actuators: [
      { nodeId: field.id, relation: "state" },
      ...(field.kind === "radio" ? [{ nodeId: `label_${field.id}`, relation: "label" }] : [])
    ],
    operations: field.kind === "radio"
      ? {
          activate: null,
          open: null,
          choose: { operation: "choose", actuatorId: `label_${field.id}`, actuatorIds: [`label_${field.id}`, field.id], precondition: { disabled: false }, expectedOutcome: "control_selected" },
          type: null,
          select: null
        }
      : field.kind === "select"
        ? {
            activate: null,
            open: null,
            choose: null,
            type: null,
            select: { operation: "select", actuatorId: field.id, actuatorIds: [field.id], precondition: { disabled: false }, expectedOutcome: "normalized_value_changed" }
          }
        : {
            activate: null,
            open: null,
            choose: null,
            type: { operation: "type", actuatorId: field.id, actuatorIds: [field.id], precondition: { disabled: false }, expectedOutcome: "normalized_value_changed" },
            select: null
          }
  }));
  return {
    observationId,
    observationSnapshot: { snapshotHash },
    page: {
      site: "example.test",
      url: "https://example.test/traveler",
      step: "traveler_information",
      snapshotHash,
      activeSurface: { id: "", type: "page", label: "" },
      currentSurface: { id: "", type: "page", label: "" },
      fields,
      controls,
      errors
    }
  };
}

test("P0.4 complete profile skill passes 20 ordered blank-form replays without model work", () => {
  const traveler = {
    id: "trav_ali",
    email: "ali@example.test",
    phone: "+38670328922",
    nationality: "Slovenia",
    gender: "male",
    first_name: "Ali",
    last_name: "Sifrar",
    date_of_birth: "2003-05-31"
  };
  const expectedOrder = ["email", "confirm_email", "phone_country_code", "phone", "title", "first_name", "last_name", "date_of_birth"];

  for (let replay = 0; replay < 20; replay += 1) {
    const filled = new Set();
    let observation = completeProfileObservation({ observationId: `obs_profile_${replay}_0`, filled });
    let plan = createSkillPlan({ id: `act_parent_${replay}`, type: "fill_visible_profile_fields" }, observation, traveler);
    let step = advanceSkillPlan(plan, observation, traveler, {});
    const observedOrder = [];
    let atomIndex = 0;
    while (step.action) {
      observedOrder.push(step.atom.semanticType);
      if (step.atom.semanticType === "phone_country_code") assert.equal(step.action.value, "+386");
      if (step.atom.semanticType === "phone") assert.equal(step.action.value, "70328922");
      if (step.atom.semanticType === "title") assert.equal(step.action.type, "click");
      if (step.atom.semanticType === "date_of_birth") assert.equal(step.action.value, "31-05-2003");
      filled.add(step.atom.semanticType);
      atomIndex += 1;
      observation = completeProfileObservation({ observationId: `obs_profile_${replay}_${atomIndex}`, filled });
      step = advanceSkillPlan(step.plan, observation, traveler, {
        actionId: step.action.id,
        executed: true,
        verified: true,
        outcome: { code: step.atom.semanticType === "title" ? "CONTROL_SELECTED" : "FIELD_VALUE_VERIFIED" }
      });
    }
    assert.equal(step.status, "complete");
    assert.deepEqual(observedOrder, expectedOrder);
    assert.equal(step.plan.atoms.every((atom) => ["complete", "satisfied"].includes(atom.status)), true);
  }
});

test("P0.4 normalizes phone parts and field-specific dates", () => {
  assert.deepEqual(normalizedPhoneParts({ phone: "+386 70 328 922", nationality: "Slovenia" }), {
    countryCode: "+386",
    localNumber: "70328922"
  });
  assert.equal(dateValueForField("2003-05-31", { kind: "text", placeholder: "DD-MM-YYYY" }), "31-05-2003");
  assert.equal(dateValueForField("2003-05-31", { kind: "date" }), "2003-05-31");
  assert.equal(dateValueForField("2003-05-31", {
    kind: "select",
    label: "Month",
    options: [{ value: "05", label: "May" }]
  }), "05");
});

test("P0.4 persists a custom country-code choice as governed open and choose atoms", () => {
  const traveler = { phone: "+38670328922", nationality: "Slovenia" };
  const closedObservation = {
    observationId: "obs_country_closed",
    observationSnapshot: { snapshotHash: "hash_country_closed" },
    page: {
      step: "traveler_information",
      snapshotHash: "hash_country_closed",
      activeSurface: { id: "", type: "page", label: "" },
      currentSurface: { id: "", type: "page", label: "" },
      errors: [],
      fields: [{
        id: "el_country_input",
        controlId: "ctrl_country",
        field: "phone_country_code",
        label: "Country code",
        kind: "text",
        role: "combobox",
        hasValue: true,
        controlState: { valuePresent: true, valueText: "+44-1481", normalizedValue: "+441481", expanded: false }
      }],
      controls: [{
        controlId: "ctrl_country",
        label: "Country code",
        kind: "select",
        role: "combobox",
        semantic: "phone_country_code",
        risk: "safe",
        surfaceId: "",
        state: { disabled: false, valuePresent: true, valueText: "+44-1481", normalizedValue: "+441481", expanded: false },
        stateElementId: "el_country_input",
        preferredActivationElementId: "el_country_label",
        actuators: [
          { nodeId: "el_country_input", relation: "state" },
          { nodeId: "el_country_label", relation: "label" },
          { nodeId: "el_country_arrow", relation: "activation" }
        ],
        operations: {
          activate: null,
          open: { operation: "open", actuatorId: "el_country_arrow", actuatorIds: ["el_country_arrow", "el_country_input"], precondition: { expanded: false }, expectedOutcome: "options_surface_appeared" },
          choose: null,
          type: null,
          select: null
        }
      }]
    }
  };
  const plan = createSkillPlan({ id: "act_country_parent", type: "fill_visible_profile_fields" }, closedObservation, traveler);
  const open = advanceSkillPlan(plan, closedObservation, traveler, {});
  assert.equal(open.status, "action");
  assert.equal(open.action.type, "click");
  assert.equal(open.action.intent, "open_profile_choice");
  assert.equal(open.action.operation, "open");
  assert.equal(open.action.targetId, "el_country_arrow");
  assert.equal(open.action.expectedOutcome.type, "options_surface_appeared");

  const openedObservation = {
    observationId: "obs_country_opened",
    observationSnapshot: { snapshotHash: "hash_country_opened" },
    page: {
      ...closedObservation.page,
      snapshotHash: "hash_country_opened",
      activeSurface: { id: "surface_country", type: "dropdown", label: "Country code" },
      currentSurface: { id: "surface_country", type: "dropdown", label: "Country code" },
      controls: [
        ...closedObservation.page.controls,
        {
          controlId: "ctrl_country_slovenia",
          label: "Slovenia +386",
          accessibleName: "Slovenia +386",
          kind: "option",
          role: "option",
          semantic: "choice",
          risk: "safe",
          surfaceId: "surface_country",
          surfaceType: "dropdown",
          state: { disabled: false, selected: false },
          stateElementId: "el_country_slovenia",
          preferredActivationElementId: "el_country_slovenia",
          actuators: [{ nodeId: "el_country_slovenia", relation: "state" }],
          operations: {
            activate: null,
            open: null,
            choose: { operation: "choose", actuatorId: "el_country_slovenia", actuatorIds: ["el_country_slovenia"], precondition: { disabled: false }, expectedOutcome: "control_selected" },
            type: null,
            select: null
          }
        },
        {
          controlId: "ctrl_country_guernsey",
          label: "Guernsey +44-1481",
          accessibleName: "Guernsey +44-1481",
          kind: "option",
          role: "option",
          semantic: "choice",
          risk: "safe",
          surfaceId: "surface_country",
          surfaceType: "dropdown",
          state: { disabled: false, selected: false },
          stateElementId: "el_country_guernsey",
          preferredActivationElementId: "el_country_guernsey",
          actuators: [{ nodeId: "el_country_guernsey", relation: "state" }],
          operations: {
            activate: null,
            open: null,
            choose: { operation: "choose", actuatorId: "el_country_guernsey", actuatorIds: ["el_country_guernsey"], precondition: { disabled: false }, expectedOutcome: "control_selected" },
            type: null,
            select: null
          }
        }
      ]
    }
  };
  const choose = advanceSkillPlan(open.plan, openedObservation, traveler, {
    actionId: open.action.id,
    executed: true,
    verified: true,
    outcome: { code: "OPTIONS_SURFACE_APPEARED" }
  });
  assert.equal(choose.status, "action");
  assert.equal(choose.action.type, "click");
  assert.equal(choose.action.operation, "choose");
  assert.equal(choose.action.controlId, "ctrl_country_slovenia");
  assert.equal(choose.action.expectedOutcome.type, "normalized_value_changed");
  assert.equal(choose.action.expectedOutcome.expectedNormalizedValue, "+386");
});

test("P0.4 suspended country ownership resumes at choose after verified visual opener recovery", () => {
  const traveler = { phone: "+38670328922", nationality: "Slovenia" };
  const closedObservation = {
    observationId: "obs_country_visual_closed",
    observationSnapshot: { snapshotHash: "hash_country_visual_closed" },
    page: {
      step: "traveler_information",
      snapshotHash: "hash_country_visual_closed",
      activeSurface: { id: "", type: "page", label: "" },
      currentSurface: { id: "", type: "page", label: "" },
      errors: [],
      fields: [{
        id: "el_country_visual_input",
        controlId: "ctrl_country_visual",
        field: "phone_country_code",
        label: "Country code",
        kind: "text",
        role: "combobox",
        hasValue: true,
        controlState: { valuePresent: true, normalizedValue: "+44", expanded: false }
      }],
      controls: [{
        controlId: "ctrl_country_visual",
        label: "Country code",
        kind: "select",
        role: "combobox",
        semantic: "phone_country_code",
        risk: "safe",
        surfaceId: "",
        state: { disabled: false, valuePresent: true, normalizedValue: "+44", expanded: false },
        stateElementId: "el_country_visual_input",
        preferredActivationElementId: "el_country_visual_input",
        actuators: [{ nodeId: "el_country_visual_input", relation: "state" }],
        operations: { activate: null, open: null, choose: null, type: null, select: null },
        recovery: {
          open: {
            operation: "open",
            status: "unproven",
            requiresVisualConfirmation: true,
            regions: [{ x: 180, y: 100, width: 40, height: 40, viewportWidth: 1200, viewportHeight: 800, surfaceId: "" }]
          }
        }
      }]
    }
  };
  const plan = createSkillPlan({ id: "act_country_visual_parent", type: "fill_visible_profile_fields" }, closedObservation, traveler);
  const ambiguous = advanceSkillPlan(plan, closedObservation, traveler, {});
  assert.equal(ambiguous.status, "ambiguous");
  assert.equal(ambiguous.plan.status, "suspended");
  const context = skillRecoveryContext(ambiguous.plan, closedObservation, traveler);
  const obligation = blockedObligationForPlan(ambiguous.plan, closedObservation, traveler);
  assert.equal(context.semanticType, "phone_country_code");
  assert.equal(context.operation, "open");
  assert.equal(context.recovery.regions.length, 1);

  const openedObservation = {
    ...closedObservation,
    observationId: "obs_country_visual_opened",
    observationSnapshot: { snapshotHash: "hash_country_visual_opened" },
    page: {
      ...closedObservation.page,
      snapshotHash: "hash_country_visual_opened",
      activeSurface: { id: "surface_country_visual", type: "dropdown", label: "Country code" },
      currentSurface: { id: "surface_country_visual", type: "dropdown", label: "Country code" }
    }
  };
  const recoveryResult = {
    actionId: "act_visual_recovery",
    skillPlanId: ambiguous.plan.planId,
    skillAtomId: context.atomId,
    controlId: context.controlId,
    operation: "open",
    executed: true,
    verified: true,
    expectedOutcome: obligation.recoveryExpectedOutcome,
    outcome: { code: "OPTIONS_SURFACE_APPEARED" }
  };
  assert.equal(exactRecoveryProof(obligation, recoveryResult), true);
  const resumed = resumeSuspendedSkillPlan(ambiguous.plan, openedObservation, traveler, recoveryResult, obligation);
  assert.equal(resumed.resumable, true);
  assert.equal(resumed.plan.status, "running");
  assert.equal(currentProfileSkillAtom(resumed.plan).phase, "choose");
});

test("P0 root gate persists one exact blocked obligation and ignores wait as a recovery attempt", () => {
  const traveler = { phone: "+38670328922", nationality: "Slovenia" };
  const observation = {
    observationId: "obs_blocked_obligation",
    observationSnapshot: { snapshotHash: "hash_blocked_obligation" },
    page: {
      step: "traveler_information",
      snapshotHash: "hash_blocked_obligation",
      activeSurface: { id: "", type: "page", label: "" },
      currentSurface: { id: "", type: "page", label: "" },
      errors: [],
      fields: [{
        id: "el_blocked_country",
        controlId: "ctrl_blocked_country",
        field: "phone_country_code",
        label: "Country code",
        kind: "text",
        role: "combobox",
        hasValue: true,
        controlState: { valuePresent: true, normalizedValue: "+44", expanded: false }
      }],
      controls: [{
        controlId: "ctrl_blocked_country",
        label: "Country code",
        kind: "select",
        role: "combobox",
        semantic: "phone_country_code",
        risk: "safe",
        state: { disabled: false, valuePresent: true, normalizedValue: "+44", expanded: false },
        stateElementId: "el_blocked_country",
        preferredActivationElementId: "el_blocked_country",
        actuators: [{ nodeId: "el_blocked_country", relation: "state" }],
        operations: { activate: null, open: null, choose: null, type: null, select: null },
        recovery: {
          open: {
            operation: "open",
            status: "unproven",
            requiresVisualConfirmation: true,
            regions: [{ x: 180, y: 100, width: 40, height: 40 }]
          }
        }
      }],
      screenshotAnnotations: [{
        visualRef: "R1",
        targetId: "",
        controlId: "ctrl_blocked_country",
        source: "control.recovery.open",
        box: { x: 180, y: 100, width: 40, height: 40 }
      }]
    }
  };
  const plan = createSkillPlan({ id: "act_blocked_parent", type: "fill_visible_profile_fields" }, observation, traveler);
  const suspended = advanceSkillPlan(plan, observation, traveler, {});
  const obligation = blockedObligationForPlan(suspended.plan, observation, traveler);
  assert.deepEqual(obligation.owner, {
    skillPlanId: suspended.plan.planId,
    atomId: currentProfileSkillAtom(suspended.plan).atomId,
    skillType: "fill_visible_profile_fields",
    semanticType: "phone_country_code",
    ordinal: 0
  });
  assert.equal(obligation.control.controlId, "ctrl_blocked_country");
  assert.equal(obligation.operation, "open");
  assert.equal(obligation.expectedResult.expectedNormalizedValue, "+386");
  assert.equal(recordBlockedObligationAttempt(obligation, { type: "wait" }).attempts.length, 0);

  const action = loopPrivate.canonicalBlockedRecoveryAction(obligation, observation);
  assert.equal(action.type, "click_xy");
  assert.equal(action.controlId, obligation.control.controlId);
  assert.equal(action.operation, "open");
  assert.deepEqual(action.expectedOutcome, obligation.recoveryExpectedOutcome);
  const attempted = recordBlockedObligationAttempt(obligation, action);
  assert.equal(attempted.attempts.length, 1);
  assert.equal(attempted.attempts[0].status, "dispatched");

  const wrongProof = {
    actionId: action.id,
    skillPlanId: obligation.owner.skillPlanId,
    skillAtomId: obligation.owner.atomId,
    controlId: obligation.control.controlId,
    operation: "choose",
    executed: true,
    verified: true,
    expectedOutcome: obligation.recoveryExpectedOutcome,
    outcome: { code: "OPTIONS_SURFACE_APPEARED" }
  };
  assert.equal(exactRecoveryProof(attempted, wrongProof), false);

  const exactProof = { ...wrongProof, operation: "open" };
  const reconciled = reconcileBlockedObligationResult(attempted, exactProof);
  assert.equal(reconciled.exact, true);
  assert.equal(reconciled.obligation.status, "recovered");
  assert.equal(reconciled.obligation.attempts[0].status, "verified");
  assert.equal(reconciled.obligation.proofs[0].controlId, obligation.control.controlId);
});

test("P0.4 does not complete while visible validation errors remain", () => {
  const traveler = {
    email: "ali@example.test",
    phone: "+38670328922",
    nationality: "Slovenia",
    gender: "male",
    first_name: "Ali",
    last_name: "Sifrar",
    date_of_birth: "2003-05-31"
  };
  const filled = new Set();
  let observation = completeProfileObservation({ observationId: "obs_validation_0", filled });
  let result = advanceSkillPlan(
    createSkillPlan({ id: "act_parent_validation", type: "fill_visible_profile_fields" }, observation, traveler),
    observation,
    traveler,
    {}
  );
  let index = 0;
  while (result.action) {
    filled.add(result.atom.semanticType);
    index += 1;
    observation = completeProfileObservation({
      observationId: `obs_validation_${index}`,
      filled,
      errors: filled.has("date_of_birth") ? ["Date of birth is invalid"] : []
    });
    result = advanceSkillPlan(result.plan, observation, traveler, {
      actionId: result.action.id,
      executed: true,
      verified: true,
      outcome: { code: result.atom.semanticType === "title" ? "CONTROL_SELECTED" : "FIELD_VALUE_VERIFIED" }
    });
  }
  assert.equal(result.status, "ambiguous");
  assert.equal(result.plan.status, "suspended");
  assert.match(result.reason, /validation errors remain/i);
});

test("P0 scoped validation blocks only its canonical profile owner or an explicit stage-wide issue", () => {
  const traveler = {
    email: "ali@example.test",
    phone: "+38670328922",
    nationality: "Slovenia",
    gender: "male",
    first_name: "Ali",
    last_name: "Sifrar",
    date_of_birth: "2003-05-31"
  };
  const filled = new Set(["email", "confirm_email", "phone_country_code", "phone", "title", "first_name", "last_name", "date_of_birth"]);
  const observation = completeProfileObservation({ observationId: "obs_scoped_validation", filled });
  observation.page.errors = ["Baggage selection is invalid"];
  observation.page.validationIssues = [{
    issueId: "validation_baggage",
    message: "Baggage selection is invalid",
    controlId: "ctrl_baggage",
    sectionId: "section_baggage",
    sectionType: "baggage",
    surfaceId: "",
    stageWide: false
  }];
  assert.equal(profileStageReadiness(observation, traveler).ready, true);

  const phoneControl = observation.page.controls.find((control) => control.semantic === "phone");
  observation.page.validationIssues = [{
    issueId: "validation_phone",
    message: "Mobile number is invalid",
    controlId: phoneControl.controlId,
    sectionType: "contact",
    stageWide: false
  }];
  const matching = profileStageReadiness(observation, traveler);
  assert.equal(matching.ready, false);
  assert.deepEqual(matching.visibleErrors, ["Mobile number is invalid"]);

  observation.page.validationIssues = [{
    issueId: "validation_stage",
    message: "Traveler form contains an error",
    stageWide: true
  }];
  assert.equal(profileStageReadiness(observation, traveler).ready, false);
});

test("P0.4 governor blocks baggage and extras while the profile skill is incomplete", () => {
  const { dir, dbPath } = tempDb();
  const { state, observation } = fixture();
  state.activeSkillPlan = { planId: "skill_profile", skillType: "fill_visible_profile_fields", status: "running", atoms: [] };
  const store = createStore({ dbPath });
  store.saveSession(state);
  store.recordObservation(state.id, observation);
  const result = governAction({
    state,
    observation,
    traveler: { id: "trav_1", booking_rules: "no extras" },
    store,
    turnId: "turn_profile_sequence",
    action: {
      id: "act_baggage_too_early",
      type: "click",
      observationId: observation.observationId,
      observationHash: observation.observationSnapshot.snapshotHash,
      intent: "decline_optional_extra",
      controlId: "ctrl_decline",
      targetId: "el_decline",
      targetSnapshot: {
        id: "el_decline",
        controlId: "ctrl_decline",
        decisionGroupId: "dg_baggage_confirm",
        semantic: "decline_paid_extra",
        risk: "safe_decline",
        surfaceId: "surface_1",
        surfaceType: "modal"
      },
      expectedOutcome: { type: "active_surface_dismissed", surfaceId: "surface_1" },
      risk: "safe",
      reason: "Decline baggage before traveler fields are complete."
    }
  });
  assert.equal(result.allow, false);
  assert.equal(result.code, "PROFILE_SKILL_INCOMPLETE");
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("P0.5/P0.6 governor blocks phone while country-code prerequisite owns the profile skill", () => {
  const { dir, dbPath } = tempDb();
  const traveler = {
    id: "trav_country_dependency",
    email: "ali@example.test",
    phone: "+38670328922",
    nationality: "Slovenia",
    gender: "male",
    first_name: "Ali",
    last_name: "Sifrar",
    date_of_birth: "2003-05-31"
  };
  const observation = completeProfileObservation({
    observationId: "obs_country_dependency",
    filled: new Set(["email", "confirm_email"])
  });
  const state = createCheckoutSessionState({
    goal: "Complete checkout without extras",
    travelerId: traveler.id,
    site: { host: "example.test", url: "https://example.test/traveler" }
  });
  state.id = "txn_country_dependency";
  const plan = createSkillPlan({ id: "act_country_dependency_parent", type: "fill_visible_profile_fields" }, observation, traveler);
  plan.status = "suspended";
  plan.suspendedReason = "Country opener is ambiguous.";
  state.activeSkillPlan = plan;
  const countryAtom = currentProfileSkillAtom(plan);
  assert.equal(countryAtom.semanticType, "phone_country_code");
  const phoneAtom = plan.atoms.find((atom) => atom.semanticType === "phone");
  const phoneControl = observation.page.controls.find((control) => control.semantic === "phone");

  const store = createStore({ dbPath });
  store.saveSession(state);
  store.recordObservation(state.id, observation);
  const result = governAction({
    state,
    observation,
    traveler,
    store,
    turnId: "turn_phone_bypass",
    action: {
      id: "act_phone_bypass",
      type: "type",
      observationId: observation.observationId,
      observationHash: observation.observationSnapshot.snapshotHash,
      intent: "satisfy_field",
      operation: "type",
      skillPlanId: plan.planId,
      skillAtomId: phoneAtom.atomId,
      controlId: phoneControl.controlId,
      targetId: phoneControl.stateElementId,
      targetLabel: phoneControl.label,
      value: "70328922",
      targetSnapshot: {
        id: phoneControl.stateElementId,
        controlId: phoneControl.controlId,
        semantic: "phone",
        risk: "safe"
      },
      expectedOutcome: {
        type: "field_value_changed",
        controlId: phoneControl.controlId,
        expectedValue: "70328922"
      },
      risk: "safe",
      reason: "Attempt to skip the unresolved country code."
    }
  });
  assert.equal(result.allow, false);
  assert.equal(result.code, "PROFILE_ATOM_DEPENDENCY");
  assert.match(result.reason, /country code/i);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("P1.1/P1.5 governor allows only an owned bounded visual recovery region", () => {
  const { dir, dbPath } = tempDb();
  const traveler = { id: "trav_visual_country", phone: "+38670328922", nationality: "Slovenia" };
  const observation = {
    observationId: "obs_visual_country",
    observationSnapshot: { snapshotHash: "hash_visual_country" },
    page: {
      site: "example.test",
      url: "https://example.test/traveler",
      step: "traveler_information",
      snapshotHash: "hash_visual_country",
      viewport: { width: 1200, height: 800 },
      graphIntegrity: { ok: true, conflicts: [] },
      activeSurface: { id: "", type: "page", label: "" },
      currentSurface: { id: "", type: "page", label: "" },
      fields: [{
        id: "el_visual_country",
        controlId: "ctrl_visual_country",
        field: "phone_country_code",
        label: "Country code",
        kind: "text",
        role: "combobox",
        hasValue: true,
        controlState: { valuePresent: true, normalizedValue: "+44" }
      }],
      controls: [{
        controlId: "ctrl_visual_country",
        label: "Country code",
        kind: "select",
        role: "combobox",
        semantic: "phone_country_code",
        risk: "safe",
        state: { disabled: false, normalizedValue: "+44" },
        stateElementId: "el_visual_country",
        preferredActivationElementId: "el_visual_country",
        actuators: [{ nodeId: "el_visual_country", relation: "state" }],
        operations: { activate: null, open: null, choose: null, type: null, select: null },
        recovery: {
          open: {
            operation: "open",
            status: "unproven",
            requiresVisualConfirmation: true,
            regions: [{ x: 180, y: 100, width: 40, height: 40, viewportWidth: 1200, viewportHeight: 800, surfaceId: "" }]
          }
        }
      }]
    }
  };
  const state = createCheckoutSessionState({
    goal: "Complete checkout safely",
    travelerId: traveler.id,
    site: { host: "example.test", url: observation.page.url }
  });
  state.id = "txn_visual_country";
  const plan = createSkillPlan({ id: "act_visual_country_parent", type: "fill_visible_profile_fields" }, observation, traveler);
  plan.status = "suspended";
  plan.suspendedReason = "No proven DOM opener.";
  state.activeSkillPlan = plan;
  const atom = currentProfileSkillAtom(plan);
  state.blockedObligation = blockedObligationForPlan(plan, observation, traveler);

  const store = createStore({ dbPath });
  store.saveSession(state);
  store.recordObservation(state.id, observation);
  const mismatched = governAction({
    state,
    observation,
    traveler,
    store,
    turnId: "turn_visual_country_mismatch",
    action: {
      id: "act_visual_country_wrong_operation",
      type: "click_xy",
      observationId: observation.observationId,
      observationHash: observation.observationSnapshot.snapshotHash,
      intent: "recover_skill_atom",
      operation: "choose",
      skillPlanId: plan.planId,
      skillAtomId: atom.atomId,
      controlId: "ctrl_visual_country",
      x: 200,
      y: 120,
      visualRegion: { x: 180, y: 100, width: 40, height: 40, viewportWidth: 1200, viewportHeight: 800, surfaceId: "" },
      expectedOutcome: { type: "options_surface_appeared", controlId: "ctrl_visual_country" },
      risk: "safe"
    }
  });
  assert.equal(mismatched.allow, false);
  assert.equal(mismatched.code, "BLOCKED_OBLIGATION_MISMATCH");

  const result = governAction({
    state,
    observation,
    traveler,
    store,
    turnId: "turn_visual_country",
    action: {
      id: "act_visual_country_recovery",
      type: "click_xy",
      observationId: observation.observationId,
      observationHash: observation.observationSnapshot.snapshotHash,
      intent: "recover_skill_atom",
      operation: "open",
      skillPlanId: plan.planId,
      skillAtomId: atom.atomId,
      controlId: "ctrl_visual_country",
      targetId: "",
      targetLabel: "Country code open region",
      x: 200,
      y: 120,
      visualRegion: { x: 180, y: 100, width: 40, height: 40, viewportWidth: 1200, viewportHeight: 800, surfaceId: "" },
      targetSnapshot: {
        id: "",
        controlId: "ctrl_visual_country",
        semantic: "phone_country_code",
        risk: "safe",
        source: "visual_control_recovery",
        recoveryOperation: "open",
        visualRegion: { x: 180, y: 100, width: 40, height: 40, viewportWidth: 1200, viewportHeight: 800, surfaceId: "" }
      },
      expectedOutcome: { type: "options_surface_appeared", controlId: "ctrl_visual_country" },
      risk: "safe",
      reason: "Use the bounded right-edge recovery region."
    }
  });
  assert.equal(result.allow, true);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("P0.4 persists a multi-atom skill and rebinds each atom to the fresh observation", () => {
  const traveler = { id: "trav_1", email: "ali@example.test", phone: "+38640111222" };
  const firstObservation = profileFormObservation();
  const plan = createSkillPlan({ id: "act_parent", type: "fill_visible_profile_fields" }, firstObservation, traveler);
  const first = advanceSkillPlan(plan, firstObservation, traveler, {});
  assert.equal(first.status, "action");
  assert.equal(first.action.controlId, "ctrl_email_obs_form_1");
  assert.equal(first.action.skillPlanId, plan.planId);
  assert.equal(first.action.skillAtomId, first.atom.atomId);

  const secondObservation = profileFormObservation({ observationId: "obs_form_2", emailFilled: true });
  const second = advanceSkillPlan(first.plan, secondObservation, traveler, {
    actionId: first.action.id,
    verified: true,
    outcome: { code: "FIELD_VALUE_VERIFIED" }
  });
  assert.equal(second.status, "action");
  assert.equal(second.action.controlId, "ctrl_phone_obs_form_2");
  assert.notEqual(second.action.controlId, "ctrl_phone_obs_form_1");
  assert.equal(second.plan.atoms.find((atom) => atom.semanticType === "email").status, "complete");

  const finalObservation = profileFormObservation({ observationId: "obs_form_3", emailFilled: true, phoneFilled: true });
  const complete = advanceSkillPlan(second.plan, finalObservation, traveler, {
    actionId: second.action.id,
    verified: true,
    outcome: { code: "FIELD_VALUE_VERIFIED" }
  });
  assert.equal(complete.status, "complete");
  assert.equal(complete.plan.status, "complete");
  assert.equal(complete.plan.atoms.every((atom) => ["complete", "satisfied"].includes(atom.status)), true);
});

test("P0.4 suspends a skill when the exact atomic result fails", () => {
  const traveler = { id: "trav_1", email: "ali@example.test", phone: "+38640111222" };
  const firstObservation = profileFormObservation();
  const first = advanceSkillPlan(
    createSkillPlan({ id: "act_parent", type: "fill_visible_profile_fields" }, firstObservation, traveler),
    firstObservation,
    traveler,
    {}
  );
  const failed = advanceSkillPlan(first.plan, profileFormObservation({ observationId: "obs_form_failed" }), traveler, {
    actionId: first.action.id,
    verified: false,
    outcome: { code: "FIELD_VALUE_NOT_VERIFIED" }
  });
  assert.equal(failed.status, "ambiguous");
  assert.equal(failed.plan.status, "suspended");
  assert.match(failed.reason, /FIELD_VALUE_NOT_VERIFIED/);
});

test("P0.3 reissues an unexecuted stale skill atom against the fresh observation", () => {
  const traveler = { id: "trav_1", email: "ali@example.test", phone: "+38640111222" };
  const firstObservation = profileFormObservation({ observationId: "obs_before_stale" });
  const first = advanceSkillPlan(
    createSkillPlan({ id: "act_parent", type: "fill_visible_profile_fields" }, firstObservation, traveler),
    firstObservation,
    traveler,
    {}
  );
  const freshObservation = profileFormObservation({ observationId: "obs_after_stale" });
  const reissued = advanceSkillPlan(first.plan, freshObservation, traveler, {
    actionId: first.action.id,
    executed: false,
    verified: false,
    outcome: { code: "OBSERVATION_HASH_MISMATCH" }
  });

  assert.equal(reissued.status, "action");
  assert.equal(reissued.plan.status, "running");
  assert.equal(reissued.action.skillAtomId, first.action.skillAtomId);
  assert.equal(reissued.action.observationId, "obs_after_stale");
  assert.equal(reissued.action.controlId, "ctrl_email_obs_after_stale");
  assert.notEqual(reissued.action.id, first.action.id);
  assert.equal(reissued.atom.reissueCount, 1);
  assert.equal(reissued.atom.lastRejectedActionId, first.action.id);
  assert.equal(reissued.atom.lastRejectionCode, "OBSERVATION_HASH_MISMATCH");
});

test("P0.4 active skill plans survive a SQLite restart", () => {
  const { dir, dbPath } = tempDb();
  const { state } = fixture();
  const traveler = { id: "trav_1", email: "ali@example.test", phone: "+38640111222" };
  const observation = profileFormObservation();
  const first = advanceSkillPlan(
    createSkillPlan({ id: "act_parent", type: "fill_visible_profile_fields" }, observation, traveler),
    observation,
    traveler,
    {}
  );
  state.activeSkillPlan = first.plan;
  let store = createStore({ dbPath });
  store.saveSession(state);
  store.close();
  store = createStore({ dbPath });
  const restored = store.getSession(state.id);
  assert.equal(restored.activeSkillPlan.planId, first.plan.planId);
  assert.equal(restored.activeSkillPlan.atoms.find((atom) => atom.status === "dispatched").lastActionId, first.action.id);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("P0.4 resumes the next governed atom without another model call", async () => {
  const { dir, dbPath } = tempDb();
  const { state } = fixture();
  const traveler = { id: "trav_1", email: "ali@example.test", phone: "+38640111222", booking_rules: "no extras" };
  const firstObservation = profileFormObservation();
  const first = advanceSkillPlan(
    createSkillPlan({ id: "act_parent", type: "fill_visible_profile_fields" }, firstObservation, traveler),
    firstObservation,
    traveler,
    {}
  );
  state.activeSkillPlan = first.plan;
  const nextObservation = {
    ...profileFormObservation({ observationId: "obs_form_resume", emailFilled: true }),
    lastActionResult: {
      actionId: first.action.id,
      verified: true,
      outcome: { code: "FIELD_VALUE_VERIFIED" }
    }
  };
  const store = createStore({ dbPath });
  store.saveSession(state);
  store.recordObservation(state.id, nextObservation);
  const result = await runLoopTurn({
    apiKey: "",
    model: "should-not-be-called",
    dataDir: dir,
    state: store.getSession(state.id),
    observation: nextObservation,
    traveler,
    transactionStore: store,
    clientTurnId: "turn_skill_resume"
  });
  assert.equal(result.clientDecision.action, "type");
  assert.equal(result.clientDecision.controlId, "ctrl_phone_obs_form_resume");
  assert.equal(result.clientDecision.skillPlanId, first.plan.planId);
  assert.equal(result.clientDecision.observationId, "obs_form_resume");
  assert.match(result.clientDecision.actionId, /^act_skill_/);
  assert.equal(result.clientDecision.expectedOutcome.type, "field_value_changed");
  assert.equal(result.clientDecision.expectedOutcome.expectedValue, "40111222");
  assert.equal(result.debug.modelUsage.calls.length, 0);
  assert.equal(result.state.activeSkillPlan.atoms.find((atom) => atom.semanticType === "email").status, "complete");
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("P0.3 loop preserves and reissues a stale unexecuted atom through the governor", async () => {
  const { dir, dbPath } = tempDb();
  const { state } = fixture();
  const traveler = { id: "trav_1", email: "ali@example.test", phone: "+38640111222", booking_rules: "no extras" };
  const firstObservation = profileFormObservation({ observationId: "obs_stale_loop_before" });
  const first = advanceSkillPlan(
    createSkillPlan({ id: "act_parent", type: "fill_visible_profile_fields" }, firstObservation, traveler),
    firstObservation,
    traveler,
    {}
  );
  state.activeSkillPlan = first.plan;
  const freshObservation = {
    ...profileFormObservation({ observationId: "obs_stale_loop_after" }),
    lastActionResult: {
      actionId: first.action.id,
      executed: false,
      verified: false,
      outcome: { code: "OBSERVATION_HASH_MISMATCH" }
    }
  };
  const store = createStore({ dbPath });
  store.saveSession(state);
  store.recordObservation(state.id, freshObservation);

  const result = await runLoopTurn({
    apiKey: "",
    model: "should-not-be-called",
    dataDir: dir,
    state: store.getSession(state.id),
    observation: freshObservation,
    traveler,
    transactionStore: store,
    clientTurnId: "turn_stale_reissue"
  });

  assert.equal(result.clientDecision.action, "type");
  assert.equal(result.clientDecision.skillAtomId, first.action.skillAtomId);
  assert.equal(result.clientDecision.observationId, "obs_stale_loop_after");
  assert.equal(result.clientDecision.controlId, "ctrl_email_obs_stale_loop_after");
  assert.notEqual(result.clientDecision.actionId, first.action.id);
  assert.equal(result.debug.modelUsage.calls.length, 0);
  assert.equal(result.state.activeSkillPlan.atoms.find((atom) => atom.semanticType === "email").reissueCount, 1);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("P0.4 blank traveler stage deterministically starts profile ownership before model planning", async () => {
  const { dir, dbPath } = tempDb();
  const { state } = fixture();
  const traveler = { id: "trav_1", email: "ali@example.test", phone: "+38640111222", booking_rules: "no extras" };
  const observation = profileFormObservation({ observationId: "obs_profile_owner" });
  const store = createStore({ dbPath });
  store.saveSession(state);
  store.recordObservation(state.id, observation);

  const result = await runLoopTurn({
    apiKey: "",
    model: "must-not-be-called",
    dataDir: dir,
    state: store.getSession(state.id),
    observation,
    traveler,
    transactionStore: store,
    clientTurnId: "turn_profile_owner"
  });

  assert.equal(result.clientDecision.action, "type");
  assert.equal(result.clientDecision.controlId, "ctrl_email_obs_profile_owner");
  assert.equal(result.clientDecision.intent, "satisfy_field");
  assert.equal(result.debug.modelUsage.calls.length, 0);
  assert.equal(result.state.activeSkillPlan.status, "running");
  assert.equal(result.state.activeSkillPlan.atoms.find((atom) => atom.semanticType === "email").status, "dispatched");
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("P0.4 canonical profile readiness blocks baggage even without an active skill plan", () => {
  const { dir, dbPath } = tempDb();
  const { state, observation: baggageFixture } = fixture();
  const observation = profileFormObservation({ observationId: "obs_profile_error", emailFilled: true, phoneFilled: true });
  observation.page.errors = ["Mobile number is invalid"];
  observation.page.controls.push(baggageFixture.page.controls[0]);
  const store = createStore({ dbPath });
  store.saveSession(state);
  store.recordObservation(state.id, observation);

  const result = governAction({
    state,
    observation,
    traveler: { id: "trav_1", email: "ali@example.test", phone: "+38640111222", booking_rules: "no extras" },
    store,
    turnId: "turn_profile_error_gate",
    action: {
      id: "act_baggage_with_profile_error",
      type: "click",
      observationId: observation.observationId,
      observationHash: observation.observationSnapshot.snapshotHash,
      intent: "decline_optional_extra",
      controlId: "ctrl_decline",
      targetId: "el_decline",
      targetSnapshot: {
        id: "el_decline",
        controlId: "ctrl_decline",
        decisionGroupId: "dg_baggage_confirm",
        semantic: "decline_paid_extra",
        risk: "safe_decline",
        surfaceId: "surface_1",
        surfaceType: "modal"
      },
      expectedOutcome: { type: "active_surface_dismissed", surfaceId: "surface_1" },
      risk: "safe",
      reason: "Attempt baggage while a profile validation error is visible."
    }
  });

  assert.equal(state.activeSkillPlan, null);
  assert.equal(result.allow, false);
  assert.equal(result.code, "PROFILE_STAGE_NOT_READY");
  assert.match(result.reason, /Mobile number is invalid/);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("P0.4/P0.7 offscreen profile atom scrolls, reobserves, and rebinds without asking the model", async () => {
  const { dir, dbPath } = tempDb();
  const { state } = fixture();
  const traveler = { id: "trav_1", email: "ali@example.test", phone: "+38640111222", booking_rules: "no extras" };
  const offscreen = profileFormObservation({ observationId: "obs_profile_offscreen" });
  offscreen.page.viewport = { width: 1200, height: 800 };
  offscreen.page.controls[0].visualRegion = { x: 100, y: 1180, width: 260, height: 42, inViewport: false };
  const store = createStore({ dbPath });
  store.saveSession(state);
  store.recordObservation(state.id, offscreen);

  const recovery = await runLoopTurn({
    apiKey: "",
    model: "must-not-be-called",
    dataDir: dir,
    state: store.getSession(state.id),
    observation: offscreen,
    traveler,
    transactionStore: store,
    clientTurnId: "turn_profile_scroll"
  });

  assert.equal(recovery.clientDecision.action, "scroll");
  assert.equal(recovery.clientDecision.intent, "recover_target_viewport");
  assert.equal(recovery.clientDecision.needsApproval, false);
  assert.equal(recovery.debug.modelUsage.calls.length, 0);
  const pendingAtom = recovery.state.activeSkillPlan.atoms.find((atom) => atom.semanticType === "email");
  assert.equal(pendingAtom.status, "pending");
  assert.equal(pendingAtom.viewportRecoveryCount, 1);

  const fresh = profileFormObservation({ observationId: "obs_profile_scrolled" });
  fresh.page.viewport = { width: 1200, height: 800 };
  fresh.page.controls[0].visualRegion = { x: 100, y: 320, width: 260, height: 42, inViewport: true };
  fresh.lastActionResult = {
    actionId: recovery.clientDecision.actionId,
    executed: true,
    verified: true,
    outcome: { code: "TARGET_IN_VIEW" }
  };
  store.recordObservation(state.id, fresh);

  const rebound = await runLoopTurn({
    apiKey: "",
    model: "must-not-be-called",
    dataDir: dir,
    state: store.getSession(state.id),
    observation: fresh,
    traveler,
    transactionStore: store,
    clientTurnId: "turn_profile_rebind"
  });

  assert.equal(rebound.clientDecision.action, "type");
  assert.equal(rebound.clientDecision.controlId, "ctrl_email_obs_profile_scrolled");
  assert.equal(rebound.clientDecision.observationId, "obs_profile_scrolled");
  assert.equal(rebound.debug.modelUsage.calls.length, 0);
  assert.notEqual(rebound.clientDecision.actionId, pendingAtom.lastViewportRejectedActionId);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("P0.4 profile readiness becomes eligible only after canonical fields and errors are clear", () => {
  const traveler = {
    email: "ali@example.test",
    phone: "+38670328922",
    nationality: "Slovenia",
    gender: "male",
    first_name: "Ali",
    last_name: "Sifrar",
    date_of_birth: "2003-05-31"
  };
  const filled = new Set(["email", "confirm_email", "phone_country_code", "phone", "title", "first_name", "last_name", "date_of_birth"]);
  const ready = profileStageReadiness(completeProfileObservation({ observationId: "obs_profile_ready", filled }), traveler);
  const invalid = profileStageReadiness(completeProfileObservation({ observationId: "obs_profile_invalid", filled, errors: ["Phone invalid"] }), traveler);
  assert.equal(ready.ready, true);
  assert.equal(ready.shouldOwn, false);
  assert.equal(invalid.ready, false);
  assert.deepEqual(invalid.visibleErrors, ["Phone invalid"]);
});

test("P0.7 a pending ordinary action rebinds after viewport recovery without a model call", async () => {
  const { dir, dbPath } = tempDb();
  const { state, observation } = fixture();
  state.pendingRecoveryAction = {
    type: "viewport_rebind",
    recoveryCount: 1,
    blockedActionId: "act_decline_offscreen",
    createdObservationId: "obs_before_scroll",
    action: {
      id: "act_decline_offscreen",
      type: "click",
      observationId: "obs_before_scroll",
      observationHash: "hash_before_scroll",
      intent: "decline_optional_extra",
      controlId: "ctrl_decline",
      decisionGroupId: "dg_baggage_confirm",
      targetId: "ctrl_decline",
      risk: "safe",
      reason: "Decline the optional baggage after bringing it into view."
    }
  };
  const store = createStore({ dbPath });
  store.saveSession(state);
  store.recordObservation(state.id, observation);

  const result = await runLoopTurn({
    apiKey: "",
    model: "should-not-be-called",
    dataDir: dir,
    state: store.getSession(state.id),
    observation,
    traveler: { id: "trav_1", booking_rules: "no extras" },
    transactionStore: store,
    clientTurnId: "turn_pending_rebind"
  });

  assert.equal(result.clientDecision.action, "click");
  assert.equal(result.clientDecision.controlId, "ctrl_decline");
  assert.equal(result.clientDecision.targetId, "el_decline");
  assert.equal(result.clientDecision.expectedOutcome.type, "active_surface_dismissed");
  assert.equal(result.state.pendingRecoveryAction, null);
  assert.equal(result.debug.modelUsage.calls.length, 0);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("P0.7 a still-offscreen ordinary action receives one more governed scroll", async () => {
  const { dir, dbPath } = tempDb();
  const { state, observation } = fixture();
  observation.page.controls[0].visualRegion = {
    x: 100,
    y: 1300,
    width: 180,
    height: 40,
    inViewport: false
  };
  state.pendingRecoveryAction = {
    type: "viewport_rebind",
    recoveryCount: 1,
    blockedActionId: "act_decline_offscreen",
    createdObservationId: "obs_before_scroll",
    action: {
      id: "act_decline_offscreen",
      type: "click",
      observationId: "obs_before_scroll",
      observationHash: "hash_before_scroll",
      intent: "decline_optional_extra",
      controlId: "ctrl_decline",
      decisionGroupId: "dg_baggage_confirm",
      targetId: "ctrl_decline",
      risk: "safe",
      reason: "Decline the optional baggage after bringing it into view."
    }
  };
  const store = createStore({ dbPath });
  store.saveSession(state);
  store.recordObservation(state.id, observation);

  const result = await runLoopTurn({
    apiKey: "",
    model: "should-not-be-called",
    dataDir: dir,
    state: store.getSession(state.id),
    observation,
    traveler: { id: "trav_1", booking_rules: "no extras" },
    transactionStore: store,
    clientTurnId: "turn_pending_scroll_again"
  });

  assert.equal(result.clientDecision.action, "scroll");
  assert.equal(result.clientDecision.intent, "recover_target_viewport");
  assert.equal(result.state.pendingRecoveryAction.recoveryCount, 2);
  assert.equal(result.debug.modelUsage.calls.length, 0);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
