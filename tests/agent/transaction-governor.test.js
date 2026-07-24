const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createStore } = require("../../apps/web/agent/session-store");
const { governAction } = require("../../apps/web/agent/action-governor");
const {
  dateValueForField,
  normalizedPhoneParts,
  profileStageReadiness,
  deriveProfileGoal,
  profileGoalSatisfied,
  candidatesForProfileGoal,
  actionForProfileCandidate,
  normalizeProfileFieldType
} = require("../../apps/web/agent/skill-expander");
const { runLoopTurn, __private: loopPrivate } = require("../../apps/web/agent/loop");
const { pendingActionRecord } = require("../../apps/web/agent/action-lifecycle");
const { buildCurrentCandidateSet } = require("../../apps/web/agent/current-candidate-builder");
const { deriveObservationGoal } = require("../../apps/web/agent/observation-candidates");
const { createCheckoutSessionState } = require("../../packages/shared/agent-state");

function actionableCapability(operation, actuatorId, { inViewport = true, actuatorIds = [actuatorId] } = {}) {
  const actionability = {
    rendered: true,
    visible: true,
    enabled: true,
    inViewport,
    inCurrentSurface: true,
    hitTested: inViewport,
    notOccluded: inViewport,
    operationAuthorized: true,
    executable: inViewport,
    revealable: !inViewport,
    code: inViewport ? "ACTIONABLE" : "ACTUATOR_OUT_OF_VIEW",
    operation
  };
  return {
    operation,
    actuatorId,
    actuatorIds,
    precondition: { disabled: false },
    actionability,
    actionabilityByActuator: Object.fromEntries(actuatorIds.map((id) => [id, id === actuatorId ? actionability : { ...actionability, executable: false, revealable: false }]))
  };
}

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
          operations: { activate: actionableCapability("activate", "el_decline") },
          visualRegion: { x: 100, y: 100, width: 180, height: 40, inViewport: true }
        }
      ],
      decisionGroups: []
    }
  };
  return { state, observation };
}

function pendingDeclineContext(observation, state, traveler) {
  observation.page.decisionGroups = [{
    decisionGroupId: "dg_baggage_confirm",
    requirementId: "dg_baggage_confirm",
    sectionType: "baggage",
    sectionLabel: "Optional baggage",
    status: "missing",
    required: true,
    surfaceId: "surface_1",
    alternatives: [{ controlId: "ctrl_decline", label: "I'll go without", priceAmount: 0 }]
  }];
  const goal = deriveObservationGoal(observation, []);
  const candidateSet = buildCurrentCandidateSet({ goal, observation, traveler, state, approvals: state.approvals });
  const currentGoal = { ...goal, candidateSet, candidates: candidateSet.candidates };
  state.currentGoal = currentGoal;
  state.taskState = {
    stage: "extras",
    currentGoal,
    activeDecisions: [],
    validationBlockers: []
  };
  return { goal: currentGoal, candidate: candidateSet.candidates[0] };
}

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atw-store-"));
  return { dir, dbPath: path.join(dir, "transactions.sqlite") };
}

test("P0.2/P0.3 reconstructs the transaction, observation, action, and result after restart", () => {
  const { dir, dbPath } = tempDb();
  const { state, observation } = fixture();
  state.userPolicy = {
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
  assert.equal(store.getGovernedAction("act_1").status, "approved");
  store.recordActionEvent(state.id, { actionId: "act_1", stage: "diagnostic_only" });
  assert.equal(store.getGovernedAction("act_1").status, "approved");
  assert.equal(store.advanceGovernedAction("act_1", ["approved"], "dispatched", { actionId: "act_1", dispatched: true }), true);
  assert.equal(store.advanceGovernedAction("act_1", ["dispatched"], "observed", { actionId: "act_1", observed: true }), true);
  assert.equal(store.advanceGovernedAction("act_1", ["observed"], "verified", { actionId: "act_1", verified: true }), true);
  store.close();

  store = createStore({ dbPath });
  const reconstructed = store.reconstructTransaction(state.id);
  assert.equal(reconstructed.state.id, state.id);
  assert.equal(reconstructed.state.userPolicy.bookingRules, "No paid extras");
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
  assert.equal(allowed.state.actionLifecycle.status, "approved");
  assert.equal(allowed.state.actionLifecycle.approved, true);
  assert.equal(allowed.state.actionLifecycle.dispatched, false);
  const duplicate = governAction({ action: { ...action, id: "act_safe_2" }, state: allowed.state, observation, traveler: { id: "trav_1", booking_rules: "no extras" }, store, turnId: "turn_2" });
  assert.equal(duplicate.allow, false);
  assert.equal(duplicate.code, "DUPLICATE_ACTION_ATTEMPT");
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("risk-scoped governor preserves unrelated conflicts but blocks selected ownership ambiguity", () => {
  const governedAction = {
    id: "act_risk_scoped",
    type: "click",
    operation: "activate",
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
    expectedOutcome: { type: "active_surface_dismissed", surfaceId: "surface_1", mustNotIncreasePrice: true },
    risk: "safe",
    reason: "Decline the current optional extra."
  };

  const diagnosticFixture = fixture();
  diagnosticFixture.observation.page.controls[0].operations = {
    activate: actionableCapability("activate", "el_decline")
  };
  diagnosticFixture.observation.page.graphIntegrity = {
    ok: false,
    conflicts: [],
    aliasConflicts: [{ code: "UNKNOWN_CONTROL_ID", aliasId: "el_unavailable", controlIds: ["ctrl_removed_unavailable"], source: "screenshot_annotation" }]
  };
  const diagnosticDb = tempDb();
  const diagnosticStore = createStore({ dbPath: diagnosticDb.dbPath });
  diagnosticStore.saveSession(diagnosticFixture.state);
  diagnosticStore.recordObservation(diagnosticFixture.state.id, diagnosticFixture.observation);
  const allowed = governAction({
    action: governedAction,
    state: diagnosticFixture.state,
    observation: diagnosticFixture.observation,
    traveler: { id: "trav_1", booking_rules: "no extras" },
    store: diagnosticStore,
    turnId: "turn_diagnostic_conflict"
  });
  assert.equal(allowed.allow, true);
  assert.ok(allowed.checks.some((check) => check.code === "SELECTED_CONTROL_GRAPH_VALID" && /diagnostic conflict/.test(check.detail)));
  diagnosticStore.close();
  fs.rmSync(diagnosticDb.dir, { recursive: true, force: true });

  const selectedFixture = fixture();
  selectedFixture.observation.page.controls[0].operations = {
    activate: actionableCapability("activate", "el_decline")
  };
  selectedFixture.observation.page.graphIntegrity = {
    ok: false,
    conflicts: [{
      nodeIds: ["el_decline"],
      existing: { controlId: "ctrl_decline" },
      incoming: { controlId: "ctrl_conflicting_decline" },
      resolved: false
    }]
  };
  const selectedDb = tempDb();
  const selectedStore = createStore({ dbPath: selectedDb.dbPath });
  selectedStore.saveSession(selectedFixture.state);
  selectedStore.recordObservation(selectedFixture.state.id, selectedFixture.observation);
  const blocked = governAction({
    action: { ...governedAction, id: "act_selected_conflict" },
    state: selectedFixture.state,
    observation: selectedFixture.observation,
    traveler: { id: "trav_1", booking_rules: "no extras" },
    store: selectedStore,
    turnId: "turn_selected_conflict"
  });
  assert.equal(blocked.allow, false);
  assert.equal(blocked.decision, "recoverable");
  assert.equal(blocked.code, "CONTROL_GRAPH_SELECTED_ACTION_AMBIGUOUS");
  selectedStore.close();
  fs.rmSync(selectedDb.dir, { recursive: true, force: true });
});

test("P0.2/P0.6 persists a failed actuator and forbids the identical retry across observations", () => {
  const { dir, dbPath } = tempDb();
  const { state, observation } = fixture();
  const store = createStore({ dbPath });
  store.saveSession(state);
  store.recordObservation(state.id, observation);
  const failedDecisionInstanceId = "surface_1|flight_1|trav_1|dg_baggage_confirm";
  store.recordActionResult(state.id, {
    at: new Date().toISOString(),
    actionId: "act_failed",
    observationId: "obs_1",
    executed: true,
    verified: false,
    decisionInstanceId: failedDecisionInstanceId,
    action: {
      id: "act_failed",
      action: "click",
      targetId: "el_decline",
      targetLabel: "I'll go without",
      decisionInstanceId: failedDecisionInstanceId,
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
    decisionInstanceId: failedDecisionInstanceId,
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

  const differentDecisionInstance = governAction({
    action: {
      ...repeatedAction,
      id: "act_same_control_next_leg",
      decisionInstanceId: "surface_1|flight_2|trav_1|dg_baggage_confirm"
    },
    state: failedState,
    observation,
    traveler: { id: "trav_1", booking_rules: "no extras" },
    store,
    turnId: "turn_same_control_next_leg"
  });
  assert.equal(differentDecisionInstance.allow, true);

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
            type: { ...actionableCapability("type", `el_email_${observationId}`), expectedOutcome: "normalized_value_changed" },
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
            type: { ...actionableCapability("type", `el_phone_${observationId}`), expectedOutcome: "normalized_value_changed" },
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
      fieldType: definition.semantic,
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
        normalizedValue: definition.semantic === "title"
          ? (selected ? (definition.option === "Mr" ? "mr" : "mrs/ms") : "")
          : (selected ? normalizedValues[definition.semantic] || "filled" : ""),
        optionValue: definition.semantic === "title" ? (definition.option === "Mr" ? "mr" : "mrs/ms") : "",
        selectedValue: definition.semantic === "title" && selected ? (definition.option === "Mr" ? "mr" : "mrs/ms") : "",
        checked: definition.kind === "radio" && selected,
        selected: definition.kind === "radio" && selected
      },
      sectionType: definition.sectionType,
      decisionGroupId: definition.semantic === "title" ? `dg_title_${observationId}` : `dg_${suffix}`
    };
  });
  const controls = fields.map((field) => ({
    controlId: field.controlId,
    label: field.label,
    accessibleName: field.label,
    kind: field.kind,
    role: field.role,
    semantic: field.semantic,
    fieldType: field.fieldType,
    risk: "safe",
    sectionType: field.sectionType,
    decisionGroupId: field.decisionGroupId,
    surfaceId: "",
    state: {
      disabled: false,
      valuePresent: field.hasValue,
      normalizedValue: field.controlState.normalizedValue,
      optionValue: field.controlState.optionValue,
      selectedValue: field.controlState.selectedValue,
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
          choose: { ...actionableCapability("choose", `label_${field.id}`, { actuatorIds: [`label_${field.id}`, field.id] }), expectedOutcome: "control_selected" },
          type: null,
          select: null
        }
      : field.kind === "select"
        ? {
            activate: null,
            open: null,
            choose: null,
            type: null,
            select: { ...actionableCapability("select", field.id), expectedOutcome: "normalized_value_changed" }
          }
        : {
            activate: null,
            open: null,
            choose: null,
            type: { ...actionableCapability("type", field.id), expectedOutcome: "normalized_value_changed" },
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

test("profile field aliases normalize without loose substring matches", () => {
  assert.equal(normalizeProfileFieldType("traveler_title"), "title");
  assert.equal(normalizeProfileFieldType("salutation"), "title");
  assert.equal(normalizeProfileFieldType("mobile_number"), "phone");
  assert.equal(normalizeProfileFieldType("birth_date"), "date_of_birth");
  assert.equal(normalizeProfileFieldType("passport_issuing_country"), "issuing_country");
  assert.equal(normalizeProfileFieldType("sms"), "");
  assert.equal(normalizeProfileFieldType("mobile_travel_plan"), "");
});

test("exact profile reconciliation fills, preserves, and corrects traveler title deterministically", () => {
  const common = new Set(["email", "confirm_email", "phone_country_code", "phone", "first_name", "last_name", "date_of_birth"]);
  const male = {
    first_name: "Ali", last_name: "SIFRAR", email: "ali@example.test", phone: "+38670328922",
    gender: "male", date_of_birth: "2003-05-31"
  };
  const female = { ...male, gender: "female" };

  const empty = completeProfileObservation({ observationId: "obs_title_empty", filled: common });
  const emptyGoal = deriveProfileGoal(empty, male);
  assert.equal(emptyGoal.semanticType, "title");
  assert.equal(emptyGoal.desiredValue, "mr");
  assert.match(candidatesForProfileGoal(emptyGoal, empty, male)[0]?.summary || "", /^choose/);

  const wrongMale = completeProfileObservation({
    observationId: "obs_title_wrong_male",
    filled: new Set([...common, "title:Mrs/Ms"])
  });
  const maleGoal = deriveProfileGoal(wrongMale, male);
  assert.equal(maleGoal.semanticType, "title");
  assert.equal(maleGoal.desiredValue, "mr");
  assert.equal(candidatesForProfileGoal(maleGoal, wrongMale, male)[0]?.controlId.includes("title_0"), true);

  const wrongFemale = completeProfileObservation({
    observationId: "obs_title_wrong_female",
    filled: new Set([...common, "title:Mr"])
  });
  const femaleGoal = deriveProfileGoal(wrongFemale, female);
  assert.equal(femaleGoal.semanticType, "title");
  assert.equal(femaleGoal.desiredValue, "mrs/ms");
  assert.equal(candidatesForProfileGoal(femaleGoal, wrongFemale, female)[0]?.controlId.includes("title_1"), true);

  const correct = completeProfileObservation({
    observationId: "obs_title_correct",
    filled: new Set([...common, "title:Mr"])
  });
  assert.equal(deriveProfileGoal(correct, male), null);
});

test("missing title identity data asks instead of accepting or guessing a selected option", () => {
  const filled = new Set(["email", "confirm_email", "phone_country_code", "phone", "title:Mr", "first_name", "last_name", "date_of_birth"]);
  const observation = completeProfileObservation({ observationId: "obs_title_missing_profile", filled });
  const traveler = {
    first_name: "Ali", last_name: "SIFRAR", email: "ali@example.test", phone: "+38670328922", date_of_birth: "2003-05-31"
  };
  const readiness = profileStageReadiness(observation, traveler);
  assert.equal(readiness.ready, false);
  assert.equal(readiness.shouldOwn, false);
  assert.deepEqual(readiness.missingUserData.map((item) => item.semanticType), ["title"]);
});

test("generic planning cannot own a recognized mismatched profile field", () => {
  const filled = new Set(["email", "confirm_email", "phone_country_code", "phone", "title:Mrs/Ms", "first_name", "last_name", "date_of_birth"]);
  const observation = completeProfileObservation({ observationId: "obs_profile_owned_title", filled });
  const traveler = {
    first_name: "Ali", last_name: "SIFRAR", email: "ali@example.test", phone: "+38670328922",
    gender: "male", date_of_birth: "2003-05-31"
  };
  const goal = deriveProfileGoal(observation, traveler);
  const candidates = buildCurrentCandidateSet({ goal, observation, traveler }).candidates;
  assert.equal(goal.kind, "profile_field");
  assert.equal(goal.semanticType, "title");
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].controlId.includes("title_0"), true);
});

test("profile DOB candidate carries formatted input and canonical verification", () => {
  const filled = new Set(["email", "confirm_email", "phone_country_code", "phone", "title", "first_name", "last_name"]);
  const observation = completeProfileObservation({ observationId: "obs_dob_codec", filled });
  const traveler = {
    first_name: "Ali",
    last_name: "SIFRAR",
    email: "ali@example.test",
    phone: "+38670328922",
    gender: "male",
    date_of_birth: "2003-05-31"
  };
  const goal = deriveProfileGoal(observation, traveler);
  assert.equal(goal.semanticType, "date_of_birth");
  assert.equal(goal.inputValue, "31-05-2003");
  assert.equal(goal.desiredValue, "2003-05-31");
  assert.equal(goal.postcondition.type, "date_value_committed");
  const candidate = candidatesForProfileGoal(goal, observation, traveler)[0];
  assert.equal(candidate.value, "31-05-2003");
  assert.equal(candidate.expectedOutcome.type, "date_value_committed");
  assert.equal(candidate.expectedOutcome.expectedCanonicalValue, "2003-05-31");
});

test("profile DOB goal publishes no executable candidate when format evidence is ambiguous", () => {
  const filled = new Set(["email", "confirm_email", "phone_country_code", "phone", "title", "first_name", "last_name"]);
  const observation = completeProfileObservation({ observationId: "obs_dob_ambiguous", filled });
  const field = observation.page.fields.find((item) => item.semantic === "date_of_birth");
  const control = observation.page.controls.find((item) => item.semantic === "date_of_birth");
  field.label = "Date of birth";
  field.placeholder = "";
  field.formatHint = "";
  control.label = "Date of birth";
  control.accessibleName = "Date of birth";
  const traveler = {
    first_name: "Ali",
    last_name: "SIFRAR",
    email: "ali@example.test",
    phone: "+38670328922",
    gender: "male",
    date_of_birth: "2003-05-31"
  };
  const goal = deriveProfileGoal(observation, traveler);
  assert.equal(goal.codecError.code, "AMBIGUOUS_DATE_FORMAT");
  assert.deepEqual(candidatesForProfileGoal(goal, observation, traveler), []);
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

test("Control-owned confirm-email validation does not invalidate primary email", () => {
  const traveler = {
    email: "ali@example.test",
    phone: "+38670328922",
    nationality: "Slovenia",
    gender: "male",
    first_name: "Ali",
    last_name: "Sifrar",
    date_of_birth: "2003-05-31"
  };
  const blank = completeProfileObservation({ observationId: "obs_email_blank", filled: new Set() });
  const emailGoal = deriveProfileGoal(blank, traveler);
  assert.equal(emailGoal.semanticType, "email");

  const filled = new Set(["email", "confirm_email"]);
  const observation = completeProfileObservation({ observationId: "obs_confirm_error", filled });
  const confirmControl = observation.page.controls.find((control) => control.semantic === "confirm_email");
  observation.page.validationIssues = [{
    issueId: "validation_confirm_email",
    message: "Email confirmation does not match",
    controlId: confirmControl.controlId,
    sectionType: "contact",
    stageWide: false
  }];

  assert.equal(profileGoalSatisfied(emailGoal, observation, traveler), true);
  const next = deriveProfileGoal(observation, traveler, emailGoal);
  assert.equal(next.semanticType, "confirm_email");
  const candidates = candidatesForProfileGoal(next, observation, traveler);
  assert.equal(candidates.some((candidate) => candidate.type === "type" && candidate.value === traveler.email), true);
});

test("Unified blank-profile goals advance in order and known values always produce candidates", () => {
  const traveler = {
    id: "trav_unified_profile",
    email: "ali@example.test",
    phone: "+38670328922",
    nationality: "Slovenia",
    gender: "male",
    first_name: "Ali",
    last_name: "Sifrar",
    date_of_birth: "2003-05-31"
  };
  const expectedOrder = ["email", "confirm_email", "phone_country_code", "phone", "title", "first_name", "last_name", "date_of_birth"];
  const filled = new Set();
  let currentGoal = null;

  for (let index = 0; index < expectedOrder.length; index += 1) {
    const observation = completeProfileObservation({ observationId: `obs_unified_progress_${index}`, filled });
    currentGoal = deriveProfileGoal(observation, traveler, currentGoal);
    assert.equal(currentGoal.semanticType, expectedOrder[index]);
    const candidates = candidatesForProfileGoal(currentGoal, observation, traveler);
    assert.ok(candidates.length > 0, `${currentGoal.semanticType} should have a deterministic or grounded candidate`);
    if (currentGoal.semanticType === "confirm_email") {
      assert.equal(candidates.some((candidate) => candidate.value === traveler.email), true);
    }
    filled.add(currentGoal.semanticType);
  }

  const completeObservation = completeProfileObservation({ observationId: "obs_unified_progress_complete", filled });
  assert.equal(deriveProfileGoal(completeObservation, traveler, currentGoal), null);
  assert.equal(profileStageReadiness(completeObservation, traveler).ready, true);
});

test("Unified profile loop asks only when required user data is genuinely missing", async () => {
  const { dir, dbPath } = tempDb();
  const traveler = { id: "trav_missing_passport", email: "ali@example.test" };
  const observation = {
    observationId: "obs_missing_passport",
    observationSnapshot: { snapshotHash: "hash_missing_passport" },
    page: {
      site: "example.test",
      url: "https://example.test/traveler",
      step: "traveler_information",
      snapshotHash: "hash_missing_passport",
      graphIntegrity: { ok: true, conflicts: [] },
      activeSurface: { id: "", type: "page", label: "" },
      currentSurface: { id: "", type: "page", label: "" },
      errors: [],
      fields: [{
        id: "el_passport",
        controlId: "ctrl_passport",
        field: "passport_number",
        label: "Passport number",
        kind: "text",
        role: "textbox",
        required: true,
        hasValue: false,
        controlState: { valuePresent: false, normalizedValue: "" },
        sectionType: "document"
      }],
      controls: [{
        controlId: "ctrl_passport",
        label: "Passport number",
        kind: "text",
        role: "textbox",
        semantic: "passport_number",
        risk: "safe",
        sectionType: "document",
        state: { disabled: false, valuePresent: false, normalizedValue: "" },
        stateElementId: "el_passport",
        preferredActivationElementId: "el_passport",
        actuators: [{ nodeId: "el_passport", relation: "state" }],
        operations: {
          activate: null,
          open: null,
          choose: null,
          type: { operation: "type", actuatorId: "el_passport", actuatorIds: ["el_passport"] },
          select: null
        }
      }]
    }
  };
  const state = createCheckoutSessionState({
    goal: "Complete traveler information",
    travelerId: traveler.id,
    site: { host: "example.test", url: observation.page.url }
  });
  state.id = "txn_missing_passport";
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
    clientTurnId: "turn_missing_passport"
  });

  assert.equal(result.clientDecision.action, "ask_user");
  assert.match(result.clientDecision.reason, /Passport number/);
  assert.match(result.clientDecision.reason, /not available/i);
  assert.equal(result.debug.modelUsage.calls.length, 0);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("P0.4 governor blocks baggage and extras while the profile skill is incomplete", () => {
  const { dir, dbPath } = tempDb();
  const { state, observation } = fixture();
  state.currentGoal = {
    goalId: "profile:email:0",
    semanticType: "email",
    desiredValue: "ali@example.test",
    label: "Email",
    candidates: []
  };
  state.taskState = {
    stage: "traveler_information",
    currentGoal: state.currentGoal,
    activeDecisions: [],
    validationBlockers: [],
    profileReadiness: { ready: false, unresolvedKnown: [{ label: "Email" }], unresolvedRequired: [], visibleErrors: [] }
  };
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
  assert.equal(result.code, "CURRENT_GOAL_UNRESOLVED");
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
  state.currentGoal = deriveProfileGoal(observation, traveler);
  state.taskState = {
    stage: "traveler_information",
    currentGoal: state.currentGoal,
    activeDecisions: [],
    validationBlockers: []
  };
  assert.equal(state.currentGoal.semanticType, "phone_country_code");
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
  assert.equal(result.code, "CURRENT_GOAL_UNRESOLVED");
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
  state.currentGoal = deriveProfileGoal(observation, traveler);
  state.currentGoal.candidates = candidatesForProfileGoal(state.currentGoal, observation, traveler);
  state.taskState = {
    stage: "traveler_information",
    currentGoal: state.currentGoal,
    activeDecisions: [],
    validationBlockers: []
  };
  const candidate = state.currentGoal.candidates.find((item) => item.type === "click_xy");
  assert.ok(candidate);

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
      ...loopPrivate.bindTargetSnapshot(
        actionForProfileCandidate(state.currentGoal, candidate, observation),
        observation
      ),
      operation: "choose"
    }
  });
  assert.equal(mismatched.allow, false);
  assert.equal(mismatched.code, "CURRENT_GOAL_CANDIDATE_MISMATCH");

  const result = governAction({
    state,
    observation,
    traveler,
    store,
    turnId: "turn_visual_country",
    action: loopPrivate.bindTargetSnapshot(
      actionForProfileCandidate(state.currentGoal, candidate, observation),
      observation
    )
  });
  assert.equal(result.allow, true, JSON.stringify(result));
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Unified semantic goal state survives a SQLite restart", () => {
  const { dir, dbPath } = tempDb();
  const { state } = fixture();
  const traveler = { id: "trav_1", email: "ali@example.test", phone: "+38640111222" };
  const observation = profileFormObservation();
  state.currentGoal = deriveProfileGoal(observation, traveler);
  state.currentGoal.candidates = candidatesForProfileGoal(state.currentGoal, observation, traveler);
  state.pendingAction = {
    status: "governed",
    actionId: "act_email",
    goalId: state.currentGoal.goalId,
    candidateId: state.currentGoal.candidates[0].candidateId
  };
  state.attemptedCandidateIds = ["candidate_previous"];
  state.verifiedResults = [{ goalId: "profile:prior:0", browserVerified: true }];
  let store = createStore({ dbPath });
  store.saveSession(state);
  store.close();
  store = createStore({ dbPath });
  const restored = store.getSession(state.id);
  assert.equal(restored.currentGoal.goalId, "profile:email:0");
  assert.equal(restored.pendingAction.candidateId, state.currentGoal.candidates[0].candidateId);
  assert.deepEqual(restored.attemptedCandidateIds, ["candidate_previous"]);
  assert.equal(restored.verifiedResults[0].browserVerified, true);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Unified loop fills email then immediately advances to confirmation email", async () => {
  const { dir, dbPath } = tempDb();
  const traveler = {
    id: "trav_email_confirmation",
    email: "ali@example.test",
    phone: "+38670328922",
    nationality: "Slovenia",
    gender: "male",
    first_name: "Ali",
    last_name: "Sifrar",
    date_of_birth: "2003-05-31"
  };
  const state = createCheckoutSessionState({
    goal: "Complete traveler profile",
    travelerId: traveler.id,
    site: { host: "example.test", url: "https://example.test/traveler" }
  });
  state.id = "txn_email_confirmation";
  const store = createStore({ dbPath });
  const firstObservation = completeProfileObservation({ observationId: "obs_email_first", filled: new Set() });
  store.saveSession(state);
  store.recordObservation(state.id, firstObservation);
  const email = await runLoopTurn({
    apiKey: "",
    model: "must-not-be-called",
    dataDir: dir,
    state: store.getSession(state.id),
    observation: firstObservation,
    traveler,
    transactionStore: store,
    clientTurnId: "turn_email_first"
  });
  assert.equal(email.clientDecision.action, "type");
  assert.equal(email.state.currentGoal.semanticType, "email");
  assert.equal(email.clientDecision.value, traveler.email);

  const confirmationObservation = completeProfileObservation({
    observationId: "obs_email_confirmation_next",
    filled: new Set(["email"])
  });
  confirmationObservation.lastActionResult = {
    actionId: email.clientDecision.actionId,
    candidateId: email.clientDecision.candidateId,
    dispatched: true,
    executed: true,
    verified: true,
    postconditionSatisfied: true,
    outcome: { code: "NORMALIZED_VALUE_VERIFIED" }
  };
  store.recordObservation(state.id, confirmationObservation);
  const confirmation = await runLoopTurn({
    apiKey: "",
    model: "must-not-be-called",
    dataDir: dir,
    state: store.getSession(state.id),
    observation: confirmationObservation,
    traveler,
    transactionStore: store,
    clientTurnId: "turn_email_confirmation"
  });
  assert.equal(confirmation.clientDecision.action, "type");
  assert.equal(confirmation.state.currentGoal.semanticType, "confirm_email");
  assert.equal(confirmation.clientDecision.value, traveler.email);
  assert.equal(confirmation.debug.modelUsage.calls.length, 0);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Unified semantic loop advances to the next profile goal without another model call", async () => {
  const { dir, dbPath } = tempDb();
  const { state } = fixture();
  const traveler = { id: "trav_1", email: "ali@example.test", phone: "+38640111222", booking_rules: "no extras" };
  const firstObservation = profileFormObservation();
  const store = createStore({ dbPath });
  store.saveSession(state);
  store.recordObservation(state.id, firstObservation);
  const first = await runLoopTurn({
    apiKey: "",
    model: "should-not-be-called",
    dataDir: dir,
    state: store.getSession(state.id),
    observation: firstObservation,
    traveler,
    transactionStore: store,
    clientTurnId: "turn_goal_email"
  });
  const nextObservation = {
    ...profileFormObservation({ observationId: "obs_form_resume", emailFilled: true }),
    lastActionResult: {
      actionId: first.clientDecision.actionId,
      candidateId: first.clientDecision.candidateId,
      dispatched: true,
      executed: true,
      verified: true,
      postconditionSatisfied: true,
      outcome: { code: "FIELD_VALUE_VERIFIED" }
    }
  };
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
  assert.equal(result.clientDecision.goalId, "profile:phone:0");
  assert.equal(result.clientDecision.observationId, "obs_form_resume");
  assert.match(result.clientDecision.actionId, /^act_goal_/);
  assert.equal(result.clientDecision.expectedOutcome.type, "normalized_value_changed");
  assert.equal(result.clientDecision.expectedOutcome.expectedNormalizedValue, "40111222");
  assert.equal(result.debug.modelUsage.calls.length, 0);
  assert.equal(result.state.currentGoal.semanticType, "phone");
  assert.equal(result.state.verifiedResults.some((item) => item.goalId === "profile:email:0" && item.semanticPostconditionSatisfied), true);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Unified semantic loop reissues a candidate after stale pre-dispatch rejection", async () => {
  const { dir, dbPath } = tempDb();
  const { state } = fixture();
  const traveler = { id: "trav_1", email: "ali@example.test", phone: "+38640111222", booking_rules: "no extras" };
  const firstObservation = profileFormObservation({ observationId: "obs_stale_loop_before" });
  const store = createStore({ dbPath });
  store.saveSession(state);
  store.recordObservation(state.id, firstObservation);
  const first = await runLoopTurn({
    apiKey: "",
    model: "should-not-be-called",
    dataDir: dir,
    state: store.getSession(state.id),
    observation: firstObservation,
    traveler,
    transactionStore: store,
    clientTurnId: "turn_stale_initial"
  });
  const freshObservation = {
    ...profileFormObservation({ observationId: "obs_stale_loop_after" }),
    lastActionResult: {
      actionId: first.clientDecision.actionId,
      candidateId: first.clientDecision.candidateId,
      dispatched: false,
      executed: false,
      verified: false,
      outcome: { code: "OBSERVATION_HASH_MISMATCH" }
    }
  };
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
  assert.equal(result.clientDecision.goalId, "profile:email:0");
  assert.notEqual(result.clientDecision.candidateId, first.clientDecision.candidateId);
  assert.equal(result.clientDecision.candidateId, "obs_stale_loop_after:candidate_1");
  assert.equal(result.clientDecision.observationId, "obs_stale_loop_after");
  assert.equal(result.clientDecision.controlId, "ctrl_email_obs_stale_loop_after");
  assert.notEqual(result.clientDecision.actionId, first.clientDecision.actionId);
  assert.equal(result.debug.modelUsage.calls.length, 0);
  assert.deepEqual(result.state.attemptedCandidateIds, []);
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
  assert.equal(result.clientDecision.intent, "satisfy_semantic_goal");
  assert.equal(result.clientDecision.goalId, "profile:email:0");
  assert.ok(result.clientDecision.candidateId);
  assert.equal(result.debug.modelUsage.calls.length, 0);
  assert.equal(result.state.currentGoal.semanticType, "email");
  assert.equal(result.state.pendingAction.candidateId, result.clientDecision.candidateId);
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

  assert.equal(state.currentGoal, null);
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
  assert.equal(recovery.state.currentGoal.semanticType, "email");
  assert.equal(recovery.state.pendingAction.schemaVersion, 2);
  assert.equal(recovery.state.pendingAction.status, "needs_reveal");

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
  assert.notEqual(rebound.clientDecision.actionId, recovery.state.pendingAction.originalAction.id);
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
  const traveler = { id: "trav_1", booking_rules: "no extras" };
  const pending = pendingDeclineContext(observation, state, traveler);
  state.pendingAction = pendingActionRecord({
    status: "needs_reveal",
    recoveryAttempts: 1,
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
    },
    goal: pending.goal,
    candidate: pending.candidate
  });
  const store = createStore({ dbPath });
  store.saveSession(state);
  store.recordObservation(state.id, observation);

  const result = await runLoopTurn({
    apiKey: "",
    model: "should-not-be-called",
    dataDir: dir,
    state: store.getSession(state.id),
    observation,
    traveler,
    transactionStore: store,
    clientTurnId: "turn_pending_rebind"
  });

  assert.equal(result.clientDecision.action, "click");
  assert.equal(result.clientDecision.controlId, "ctrl_decline");
  assert.equal(result.clientDecision.targetId, "el_decline");
  assert.equal(result.clientDecision.expectedOutcome.type, "exact_free_option_selected");
  assert.equal(result.state.pendingAction.schemaVersion, 2);
  assert.equal(result.state.pendingAction.status, "ready");
  assert.equal(result.state.pendingAction.originalAction.id, result.clientDecision.actionId);
  assert.equal(result.debug.modelUsage.calls.length, 0);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("authoritative lifecycle waits for browser evidence before deriving or planning another goal", async () => {
  const { dir, dbPath } = tempDb();
  const { state, observation } = fixture();
  state.pendingAction = pendingActionRecord({
    status: "ready",
    action: {
      id: "act_pending_click",
      type: "click",
      observationId: "obs_1",
      observationHash: "hash_1",
      controlId: "ctrl_decline",
      targetId: "el_decline",
      risk: "safe"
    },
    candidate: null,
    goal: { goalId: "goal_decline_baggage" }
  });
  const store = createStore({ dbPath });
  store.saveSession(state);
  store.recordObservation(state.id, observation);

  const result = await runLoopTurn({
    apiKey: "",
    model: "must-not-be-called",
    dataDir: dir,
    state: store.getSession(state.id),
    observation,
    traveler: { id: "trav_1", booking_rules: "no extras" },
    transactionStore: store,
    clientTurnId: "turn_wait_pending_result"
  });

  assert.equal(result.clientDecision.action, "wait");
  assert.equal(result.clientDecision.intent, "await_pending_action_result");
  assert.equal(result.state.pendingAction.originalAction.id, "act_pending_click");
  assert.equal(result.debug.resumedBeforePlanning, true);
  assert.deepEqual(result.debug.modelUsage.calls, []);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("fresh paid conflict preempts a pending navigation action and dispatches the exact safe reversal", async () => {
  const { dir, dbPath } = tempDb();
  const { state, observation } = fixture();
  const traveler = { id: "trav_1", booking_rules: "decline all paid extras" };
  observation.page.controls = [
    {
      controlId: "ctrl_bundle_paid",
      decisionGroupId: "dg_bundle",
      label: "All passengers",
      kind: "radio",
      semantic: "add_paid_extra",
      risk: "money",
      selected: true,
      state: { selected: true, disabled: false },
      structuredPrice: { amount: 29, currency: "EUR" },
      surfaceId: "surface_1",
      surfaceType: "modal",
      stateElementId: "el_bundle_paid",
      preferredActivationElementId: "el_bundle_paid",
      operations: { choose: actionableCapability("choose", "el_bundle_paid") },
      visualRegion: { x: 100, y: 100, width: 180, height: 40, inViewport: true }
    },
    {
      controlId: "ctrl_bundle_free",
      decisionGroupId: "dg_bundle",
      label: "None",
      kind: "radio",
      semantic: "decline_paid_extra",
      risk: "safe_decline",
      selected: false,
      state: { selected: false, disabled: false },
      structuredPrice: { amount: 0, currency: "EUR" },
      surfaceId: "surface_1",
      surfaceType: "modal",
      stateElementId: "el_bundle_free",
      preferredActivationElementId: "el_bundle_free",
      operations: { choose: actionableCapability("choose", "el_bundle_free") },
      visualRegion: { x: 100, y: 160, width: 180, height: 40, inViewport: true }
    },
    {
      controlId: "ctrl_continue",
      label: "Proceed",
      kind: "button",
      semantic: "navigation",
      physicalEffect: "advance_surface",
      risk: "safe",
      state: { disabled: false },
      surfaceId: "surface_1",
      surfaceType: "modal",
      stateElementId: "el_continue",
      preferredActivationElementId: "el_continue",
      operations: { activate: actionableCapability("activate", "el_continue", { inViewport: false }) },
      visualRegion: { x: 100, y: 1200, width: 180, height: 40, inViewport: false }
    }
  ];
  observation.page.decisionGroups = [{
    decisionGroupId: "dg_bundle",
    requirementId: "extras:bundle",
    sectionType: "bundle",
    sectionLabel: "Bundle",
    status: "satisfied",
    required: false,
    surfaceId: "surface_1",
    surfaceType: "modal",
    selectedControlId: "ctrl_bundle_paid",
    selectedLabel: "All passengers",
    selectedSemantic: "add_paid_extra",
    selectedEvidence: {
      selected: true,
      disposition: "paid",
      selectedControlId: "ctrl_bundle_paid",
      structuredPrice: { amount: 29, currency: "EUR" }
    },
    alternativeControlIds: ["ctrl_bundle_paid", "ctrl_bundle_free"],
    alternatives: [
      { controlId: "ctrl_bundle_paid", label: "All passengers", semantic: "add_paid_extra", risk: "money" },
      { controlId: "ctrl_bundle_free", label: "None", semantic: "decline_paid_extra", risk: "safe_decline" }
    ]
  }];
  state.pendingAction = pendingActionRecord({
    status: "ready",
    action: {
      id: "act_pending_continue",
      type: "click",
      observationId: "obs_before_manual_change",
      observationHash: "hash_before_manual_change",
      intent: "navigate_stage",
      semanticIntent: "continue_checkout",
      mechanicalEffect: "advance_surface",
      controlId: "ctrl_continue",
      targetId: "el_continue",
      risk: "safe"
    },
    goal: { goalId: "goal_continue", semanticType: "navigation" }
  });
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
    clientTurnId: "turn_policy_conflict_preempts_navigation"
  });

  assert.equal(result.clientDecision.action, "click");
  assert.equal(result.clientDecision.controlId, "ctrl_bundle_free");
  assert.equal(result.clientDecision.intent, "decline_optional_extra");
  assert.notEqual(result.state.pendingAction.originalAction.id, "act_pending_continue");
  assert.equal(result.state.taskState.activeDecisions[0].status, "conflicted");
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
  const traveler = { id: "trav_1", booking_rules: "no extras" };
  const pending = pendingDeclineContext(observation, state, traveler);
  state.pendingAction = pendingActionRecord({
    status: "needs_reveal",
    recoveryAttempts: 1,
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
    },
    goal: pending.goal,
    candidate: pending.candidate
  });
  const store = createStore({ dbPath });
  store.saveSession(state);
  store.recordObservation(state.id, observation);

  const result = await runLoopTurn({
    apiKey: "",
    model: "should-not-be-called",
    dataDir: dir,
    state: store.getSession(state.id),
    observation,
    traveler,
    transactionStore: store,
    clientTurnId: "turn_pending_scroll_again"
  });

  assert.equal(result.clientDecision.action, "scroll");
  assert.equal(result.clientDecision.intent, "recover_target_viewport");
  assert.equal(result.state.pendingAction.recoveryAttempts, 2);
  assert.equal(result.debug.modelUsage.calls.length, 0);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("P0.7 measurable viewport progress resets the genuine-failure budget", async () => {
  const { dir, dbPath } = tempDb();
  const { state, observation } = fixture();
  observation.page.viewport = { width: 1200, height: 800 };
  observation.page.controls[0].visualRegion = { x: 100, y: 1200, width: 180, height: 40, inViewport: false };
  const traveler = { id: "trav_1", booking_rules: "no extras" };
  const pending = pendingDeclineContext(observation, state, traveler);
  state.recoveryState = {
    attempts: 2,
    phase: "reveal",
    stateHash: "",
    failedStrategySignatures: [],
    lastRevealSample: {
      observationId: "obs_previous_scroll",
      exists: true,
      inViewport: false,
      distanceToViewport: 900
    }
  };
  state.pendingAction = pendingActionRecord({
    status: "needs_reveal",
    recoveryAttempts: 2,
    action: {
      id: "act_decline_progress",
      type: "click",
      observationId: "obs_before_scroll",
      intent: "decline_optional_extra",
      controlId: "ctrl_decline",
      decisionGroupId: "dg_baggage_confirm",
      targetId: "ctrl_decline",
      risk: "safe",
      reason: "Resume the optional-extra decline after viewport recovery."
    },
    goal: pending.goal,
    candidate: pending.candidate
  });
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
    clientTurnId: "turn_viewport_progress"
  });

  assert.equal(result.clientDecision.action, "scroll");
  assert.equal(result.clientDecision.expectedOutcome.attempt, 1);
  assert.equal(result.state.pendingAction.recoveryAttempts, 1);
  assert.equal(result.state.recoveryState.attempts, 0);
  assert.equal(result.state.recoveryState.lastRevealSample.measurableProgress, true);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("P0.7 user handoff occurs only after bounded genuine viewport failures", async () => {
  const { dir, dbPath } = tempDb();
  const { state, observation } = fixture();
  observation.page.viewport = { width: 1200, height: 800 };
  observation.page.controls[0].visualRegion = { x: 100, y: 1280, width: 180, height: 40, inViewport: false };
  const traveler = { id: "trav_1", booking_rules: "no extras" };
  const pending = pendingDeclineContext(observation, state, traveler);
  state.recoveryState = {
    attempts: 2,
    phase: "reveal",
    stateHash: "",
    failedStrategySignatures: [],
    lastRevealSample: {
      observationId: "obs_previous_unchanged_scroll",
      exists: true,
      inViewport: false,
      distanceToViewport: 500
    }
  };
  state.pendingAction = pendingActionRecord({
    status: "needs_reveal",
    recoveryAttempts: 2,
    action: {
      id: "act_decline_stuck",
      type: "click",
      observationId: "obs_before_scroll",
      intent: "decline_optional_extra",
      controlId: "ctrl_decline",
      decisionGroupId: "dg_baggage_confirm",
      targetId: "ctrl_decline",
      risk: "safe",
      reason: "Resume the optional-extra decline after viewport recovery."
    },
    goal: pending.goal,
    candidate: pending.candidate
  });
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
    clientTurnId: "turn_viewport_genuine_failure"
  });

  assert.equal(result.clientDecision.action, "ask_user");
  assert.equal(result.state.pendingAction, null);
  assert.equal(result.state.status, "awaiting_user");
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
