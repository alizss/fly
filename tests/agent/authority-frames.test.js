const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  compileCheckoutScene,
  createObservationFrame,
  currentObligationFromGoal,
  CURRENT_OBLIGATION_VERSION,
  CHECKOUT_SCENE_VERSION,
  OBSERVATION_FRAME_VERSION
} = require("../../apps/web/agent/authority-frames");
const { reduceTaskState } = require("./task-state-replay-adapter");
const { reduceCheckoutScene, taskStateReadModel } = require("../../apps/web/agent/task-state-reducer");
const { bindMechanics, buildCurrentCandidateSet } = require("./legacy-mechanics-binding-adapter");
const agentContract = require("../../apps/extension/src/shared/agent-contract");
const { semanticSceneUncertainty } = require("../../apps/web/agent/semantic-scene-reconciliation");
const { createRequestPayloadAdapter } = require("../../apps/web/agent/request-payload");

function actionable(operation, actuatorId) {
  return {
    operation,
    actuatorId,
    actuatorIds: [actuatorId],
    actionability: {
      rendered: true,
      visible: true,
      enabled: true,
      inViewport: true,
      inCurrentSurface: true,
      hitTested: true,
      notOccluded: true,
      targetable: true,
      operationAuthorized: true,
      operationProven: true,
      executable: true,
      code: "ACTIONABLE",
      operation
    }
  };
}

function option(controlId, label, price = null) {
  return {
    controlId,
    stateElementId: `${controlId}_node`,
    preferredActivationElementId: `${controlId}_node`,
    surfaceId: "surface-page",
    surfaceType: "page",
    decisionGroupId: "dg_baggage",
    label,
    semantic: price ? "add_paid_baggage" : "decline_paid_baggage",
    physicalEffect: price ? "select_paid_option" : "select_free_option",
    risk: price ? "money" : "safe_decline",
    structuredPrice: price,
    kind: "radio",
    role: "radio",
    operations: { choose: actionable("choose", `${controlId}_node`) },
    state: { checked: false, selected: false }
  };
}

test("observation compaction preserves exact executable actuator proof", () => {
  const { compactAgentPayload } = createRequestPayloadAdapter({
    agentSessionStore: null,
    screenshotForObservation: () => ({ screenshotDataUrl: "" })
  });
  const control = {
    controlId: "payment_method",
    stateElementId: "payment_method_node",
    preferredActivationElementId: "payment_method_node",
    surfaceId: "surface-page",
    role: "combobox",
    kind: "button",
    label: "Payment method",
    state: { disabled: false },
    operations: { open: actionable("open", "payment_method_node") }
  };
  const compact = compactAgentPayload({
    sessionId: "session_compaction",
    observationId: "obs_compaction",
    observationSnapshot: { snapshotHash: "hash_compaction" },
    traveler: {},
    page: {
      currentSurface: { id: "surface-page", type: "page" },
      controls: [control],
      decisionGroups: [],
      validationIssues: []
    }
  });
  const proof = compact.page.controls[0].operations.open.actionability;
  assert.equal(proof.executable, true);
  assert.equal(proof.targetable, true);
  assert.equal(proof.operationAuthorized, true);
  assert.equal(proof.operationProven, true);
});

test("CheckoutScene compiles once and publishes one small mechanics-binding obligation", () => {
  const free = option("bag_none", "No checked baggage");
  const paid = option("bag_paid", "Add 20 kg — 35 EUR", { amount: 35, currency: "EUR" });
  const observation = {
    observationId: "obs_v2_baggage",
    observationSnapshot: { snapshotHash: "hash_v2_baggage" },
    page: {
      url: "https://example.test/checkout/baggage",
      step: "extras",
      currentSurface: { id: "surface-page", type: "page", surfaceClass: "checkout", label: "Baggage" },
      controls: [free, paid],
      decisionGroups: [{
        decisionGroupId: "dg_baggage",
        requirementId: "baggage:checked",
        surfaceId: "surface-page",
        surfaceType: "page",
        sectionType: "baggage",
        sectionLabel: "Checked baggage",
        required: true,
        status: "missing",
        selectedControlId: "",
        alternatives: [free, paid],
        controls: [free, paid]
      }],
      validationIssues: [],
      stageExit: { continueAllowed: false, candidates: [] }
    }
  };

  const observationFrame = createObservationFrame(observation);
  const checkoutScene = compileCheckoutScene({ observation, observationFrame });
  const taskState = reduceTaskState({
    observation,
    checkoutScene,
    traveler: { booking_rules: "No paid baggage or extras" },
    userPolicy: { bookingRules: "No paid baggage or extras" }
  });
  const productionTaskState = reduceCheckoutScene({
    previousTaskState: {},
    observation,
    checkoutScene,
    traveler: { booking_rules: "No paid baggage or extras" },
    userPolicy: { bookingRules: "No paid baggage or extras" }
  });

  assert.equal(observationFrame.contractVersion, OBSERVATION_FRAME_VERSION);
  assert.equal(checkoutScene.contractVersion, CHECKOUT_SCENE_VERSION);
  assert.equal(taskState.sceneId, checkoutScene.sceneId);
  assert.equal(taskState.currentObligation.contractVersion, CURRENT_OBLIGATION_VERSION);
  assert.equal(taskState.currentObligation.authority, "task_state");
  assert.equal(taskState.currentObligation.bindingContract, undefined);
  assert.equal(taskState.currentObligation.mechanics, undefined);
  assert.ok(taskState.currentObligation.binding);
  assert.equal(taskState.currentObligation.subject.decisionGroupId, "dg_baggage");
  assert.deepEqual(taskState.currentObligation.admittedControlIds, ["bag_none"]);
  assert.equal(taskState.currentGoal.candidateSet, undefined);
  assert.equal(taskState.currentGoal.candidates, undefined);
  assert.equal(productionTaskState.contractVersion, "task-state/v2");
  assert.equal(productionTaskState.activeDecisions, undefined);
  assert.equal(productionTaskState.canonicalDecisions, undefined);
  assert.equal(productionTaskState.profileReadiness, undefined);
  assert.equal(productionTaskState.processAwareness, undefined);
  assert.ok(Array.isArray(taskStateReadModel(productionTaskState).canonicalDecisions));

  const candidateSet = bindMechanics({
    obligation: taskState.currentObligation,
    checkoutScene,
    observation: checkoutScene.observation,
    state: { taskState, approvals: {} },
    traveler: { booking_rules: "No paid baggage or extras" }
  });
  assert.equal(candidateSet.obligationId, taskState.currentObligation.obligationId);
  assert.deepEqual(candidateSet.candidates.map((candidate) => candidate.controlId), ["bag_none"]);
  assert.throws(() => bindMechanics({
    obligation: taskState.currentObligation,
    checkoutScene: { ...checkoutScene, sourceSnapshotHash: "stale_hash" },
    observation: checkoutScene.observation
  }), /BIND_MECHANICS_CHECKOUT_SCENE_MISMATCH/);
});

test("a stable active checkout stage without an owned exit keeps semantic closure open", () => {
  const unfamiliarForward = {
    controlId: "unknown_forward",
    stateElementId: "unknown_forward_node",
    preferredActivationElementId: "unknown_forward_node",
    surfaceId: "surface-page",
    surfaceType: "page",
    label: "Complete this section",
    semantic: "choice",
    physicalEffect: "unknown",
    risk: "uncertain",
    kind: "button",
    role: "button",
    operations: { activate: actionable("activate", "unknown_forward_node") },
    representationLifecycle: { active: true, status: "active_rendered" },
    state: { disabled: false }
  };
  const observation = {
    observationId: "obs_missing_scene_exit",
    observationSnapshot: { snapshotHash: "hash_missing_scene_exit" },
    page: {
      url: "https://example.test/checkout/extras",
      step: "extras",
      readiness: {
        documentReadyState: "complete",
        ariaBusy: false,
        loadingIndicatorCount: 0,
        stableForMs: 1_000
      },
      currentSurface: { id: "surface-page", type: "page", blocksBackground: false },
      controls: [unfamiliarForward],
      decisionGroups: [],
      validationIssues: [],
      stageExit: { continueObserved: false, continueDisabled: false, candidates: [] }
    }
  };
  const scene = compileCheckoutScene({ observation });
  const uncertainty = semanticSceneUncertainty({
    observation,
    semanticCompilation: agentContract.compileSemanticCheckout(observation.page),
    checkoutScene: scene
  });

  assert.equal(scene.closure.status, "open");
  assert.equal(scene.closure.missingStageExit, true);
  assert.equal(scene.stageExit.authoritativeCandidate, null);
  assert.equal(uncertainty.needed, true);
  assert.deepEqual(uncertainty.components.map((control) => control.controlId), ["unknown_forward"]);
});

test("accessibility skip links cannot make one executable Continue scene exit ambiguous", () => {
  const accessibilityLink = (controlId, meaning, label) => ({
    controlId,
    stateElementId: `${controlId}_node`,
    surfaceId: "surface-page",
    surfaceType: "page",
    label,
    stableKey: `link|meaning:${meaning}|path:${controlId}`,
    semantic: "choice",
    physicalEffect: "unknown",
    risk: "uncertain",
    kind: "link",
    role: "link",
    operations: {},
    state: { disabled: false }
  });
  const continueControl = {
    controlId: "continue_checkout",
    stateElementId: "continue_checkout_node",
    preferredActivationElementId: "continue_checkout_node",
    surfaceId: "surface-page",
    surfaceType: "page",
    label: "CONTINUE",
    stableKey: "button|meaning:continue|path:continue_checkout",
    semantic: "continue",
    physicalEffect: "advance_checkout_stage",
    risk: "safe",
    kind: "button",
    role: "button",
    operations: { activate: actionable("activate", "continue_checkout_node") },
    state: { disabled: false }
  };
  const observation = {
    observationId: "obs_accessibility_skip_links",
    observationSnapshot: { snapshotHash: "hash_accessibility_skip_links" },
    page: {
      url: "https://example.test/checkout/travelers",
      step: "traveler_information",
      readiness: {
        documentReadyState: "complete",
        ariaBusy: false,
        loadingIndicatorCount: 0,
        stableForMs: 1_000
      },
      currentSurface: { id: "surface-page", type: "page", blocksBackground: false },
      controls: [
        accessibilityLink("skip_main", "skip-to-main-content", "Skip to main content"),
        accessibilityLink("skip_summary", "skip-to-trip-summary", "Skip to booking details"),
        continueControl
      ],
      decisionGroups: [],
      validationIssues: [],
      stageExit: {
        continueAllowed: true,
        continueObserved: true,
        continueDisabled: false,
        navigationState: "ready",
        candidates: [{
          controlId: "continue_checkout",
          actuatorId: "continue_checkout_node",
          operation: "activate",
          method: "browser_trusted_input",
          status: "ready",
          executable: true
        }]
      }
    }
  };

  const scene = compileCheckoutScene({ observation });

  assert.equal(scene.closure.status, "closed");
  assert.equal(scene.stageExit.authoritativeCandidate.controlId, "continue_checkout");
  assert.deepEqual(scene.stageExit.candidates.map((candidate) => candidate.controlId), ["continue_checkout"]);
});

test("a decision obligation cannot admit navigation that its success condition cannot satisfy", () => {
  assert.throws(() => currentObligationFromGoal({
    goal: {
      goalId: "seat-random-assignment",
      semanticType: "seat_selection",
      desiredSemanticOutcome: "random_assignment",
      decisionGroupId: "dg_seat",
      actionableControlIds: ["next"],
      postcondition: {
        type: "decision_group_resolved",
        decisionGroupId: "dg_seat",
        desiredSemanticOutcome: "random_assignment",
        eligibleAlternativeControlIds: ["skip_seat_selection"]
      }
    }
  }), {
    message: "CURRENT_OBLIGATION_CONTROL_CANNOT_SATISFY_SUCCESS_CONDITION"
  });
});

test("an authorized legal obligation binds its exact admitted checkbox without forward-label reinterpretation", () => {
  const terms = {
    controlId: "legal_terms",
    stateElementId: "terms_input",
    preferredActivationElementId: "terms_label",
    surfaceId: "surface-page",
    surfaceType: "page",
    decisionGroupId: "dg_legal",
    label: "I agree with the conditions of carriage",
    semantic: "choice",
    physicalEffect: "unknown",
    risk: "uncertain",
    kind: "checkbox",
    role: "checkbox",
    operations: { choose: actionable("choose", "terms_label") },
    state: { checked: false, selected: false }
  };
  const confirm = {
    controlId: "confirm",
    stateElementId: "confirm_button",
    preferredActivationElementId: "confirm_button",
    surfaceId: "surface-page",
    surfaceType: "page",
    label: "CONFIRM",
    semantic: "navigation",
    physicalEffect: "advance_checkout_stage",
    risk: "safe",
    kind: "button",
    role: "button",
    operations: { activate: actionable("activate", "confirm_button") },
    state: { disabled: false }
  };
  const observation = {
    observationId: "obs_exact_legal",
    observationSnapshot: { snapshotHash: "hash_exact_legal" },
    page: {
      step: "payment",
      currentSurface: { id: "surface-page", type: "page", blocksBackground: false },
      controls: [terms, confirm],
      decisionGroups: [],
      validationIssues: []
    }
  };
  const authorization = {
    contractVersion: "legal-authorization/v1",
    authorizationId: "legal_auth_exact",
    transactionId: "txn_exact_legal",
    legalTextDigest: "digest_exact_legal",
    legalControlId: "legal_terms",
    expiresAt: Date.now() + 60_000
  };
  const checkoutScene = compileCheckoutScene({ observation });
  const obligation = currentObligationFromGoal({
    goal: {
      goalId: "goal_exact_legal",
      kind: "legal_attestation",
      semanticType: "legal_attestation",
      semanticEffect: agentContract.SEMANTIC_EFFECT.LEGAL_ACCEPTANCE,
      semanticGoal: "accept the exact approved legal attestation",
      desiredValue: "accepted",
      controlId: "legal_terms",
      actionableControlIds: ["legal_terms"],
      surfaceId: "surface-page",
      observationId: observation.observationId,
      authorization,
      riskClass: "legal",
      postcondition: {
        type: "legal_attestation_accepted",
        controlId: "legal_terms",
        authorizationId: authorization.authorizationId,
        legalTextDigest: authorization.legalTextDigest
      }
    },
    checkoutScene
  });

  const candidateSet = bindMechanics({
    obligation,
    observation,
    state: { id: authorization.transactionId, taskState: { currentObligation: obligation }, approvals: { legalAuthorization: authorization } },
    approvals: { legalAuthorization: authorization }
  });

  assert.deepEqual(candidateSet.candidates.map((candidate) => candidate.controlId), ["legal_terms"]);
  assert.equal(candidateSet.candidates[0].mechanicalEffect, "accept_legal_terms");
  assert.equal(candidateSet.candidates[0].risk, "legal");
  assert.equal(candidateSet.contextCapabilities.some((candidate) => candidate.controlId === "confirm"), false);
});

test("shared semantic effects canonicalize legacy free-choice vocabulary", () => {
  assert.equal(
    agentContract.canonicalSemanticEffect("selected_free_option"),
    agentContract.SEMANTIC_EFFECT.SELECT_FREE_OPTION
  );
  assert.equal(
    agentContract.canonicalSemanticEffect("select_free_alternative"),
    agentContract.SEMANTIC_EFFECT.SELECT_FREE_OPTION
  );
  assert.equal(
    agentContract.semanticEffectSatisfies("random_assignment", "select_free_option"),
    true
  );
  assert.equal(
    agentContract.semanticEffectSatisfies("random_assignment", "advance_checkout_stage"),
    false
  );
});

test("production runtime contains one semantic compiler, a draft/final scene closure, and one TaskState reduction site", () => {
  const root = path.resolve(__dirname, "../..");
  const browser = fs.readFileSync(path.join(root, "apps/extension/src/content/runtime.js"), "utf8");
  const loop = fs.readFileSync(path.join(root, "apps/web/agent/loop/orchestrator.js"), "utf8");
  const candidateBinder = fs.readFileSync(path.join(root, "apps/web/agent/select-candidate.js"), "utf8");
  const ambiguityResolver = fs.readFileSync(path.join(root, "apps/web/agent/ambiguity-resolver.js"), "utf8");
  const governor = fs.readFileSync(path.join(root, "apps/web/agent/action-governor.js"), "utf8");
  const schemas = fs.readFileSync(path.join(root, "apps/web/agent/schemas.js"), "utf8");
  assert.equal((browser.match(/compileSemanticCheckout\s*\(/g) || []).length, 0);
  // CheckoutScene is materialized once as a deterministic draft and once as
  // the immutable final scene when an optional grounded patch is present.
  // Semantic extraction itself and TaskState reduction remain single-pass.
  assert.equal((loop.match(/compileCheckoutScene\s*\(/g) || []).length, 2);
  assert.equal((loop.match(/reduceCheckoutScene\s*\(/g) || []).length, 1);
  assert.equal(/\bselectCandidate\b|\bresolveActiveComponentSemantics\b/.test(loop), false);
  assert.equal((ambiguityResolver.match(/require\("\.\/select-candidate"\)/g) || []).length, 1);
  assert.equal((ambiguityResolver.match(/require\("\.\/active-component-grounding"\)/g) || []).length, 0);
  assert.equal((ambiguityResolver.match(/require\("\.\/semantic-scene-reconciliation"\)/g) || []).length, 1);
  assert.equal(/resolveSemanticOwnership|reusableSemanticOwnershipDecision/.test(`${loop}\n${candidateBinder}`), false);
  assert.equal(/activeDecisions|profileReadiness/.test(candidateBinder), false);
  assert.equal(/prepareTransactionInvariants|profileStageReadiness/.test(governor), false);
  assert.equal(/verifyAndPlan|plannerSchema|verifierSchema|pageStateSchema|requirementSchema/.test(schemas), false);
});

test("a CheckoutScene cannot be reused for a different immutable observation", () => {
  const first = {
    observationId: "obs_one",
    observationSnapshot: { snapshotHash: "hash_one" },
    page: { controls: [], decisionGroups: [] }
  };
  const second = {
    observationId: "obs_two",
    observationSnapshot: { snapshotHash: "hash_two" },
    page: { controls: [], decisionGroups: [] }
  };
  const staleFrame = createObservationFrame(first);
  assert.throws(
    () => compileCheckoutScene({ observation: second, observationFrame: staleFrame }),
    /CHECKOUT_SCENE_OBSERVATION_MISMATCH/
  );
});

test("navigation admission excludes a settled decline even when browser stage-exit evidence mentions it", () => {
  const settledDecline = {
    controlId: "bundle_no_thanks",
    stateElementId: "bundle_no_thanks_node",
    preferredActivationElementId: "bundle_no_thanks_node",
    surfaceId: "surface-page",
    surfaceType: "page",
    decisionGroupId: "dg_bundle",
    label: "No, thanks — select this to continue without bundle",
    semantic: "decline_paid_extra",
    physicalEffect: "select_free_option",
    risk: "safe_decline",
    kind: "checkbox",
    role: "checkbox",
    selected: true,
    state: { selected: true, checked: true, disabled: false },
    operations: { choose: actionable("choose", "bundle_no_thanks_node") }
  };
  const continueControl = {
    controlId: "checkout_continue",
    stateElementId: "checkout_continue_node",
    preferredActivationElementId: "checkout_continue_node",
    surfaceId: "surface-page",
    surfaceType: "page",
    label: "Continue",
    semantic: "navigation",
    physicalEffect: "advance_checkout_stage",
    risk: "safe",
    kind: "button",
    role: "button",
    state: { disabled: false },
    operations: { activate: actionable("activate", "checkout_continue_node") }
  };
  const observation = {
    observationId: "obs_settled_decline_navigation",
    observationSnapshot: { snapshotHash: "hash_settled_decline_navigation" },
    page: {
      step: "traveler_information",
      currentSurface: { id: "surface-page", type: "page", surfaceClass: "checkout" },
      controls: [settledDecline, continueControl],
      decisionGroups: [{
        decisionGroupId: "dg_bundle",
        requirementId: "bundle:optional",
        surfaceId: "surface-page",
        sectionType: "bundle",
        required: false,
        status: "satisfied",
        selectedControlId: settledDecline.controlId,
        alternatives: [settledDecline]
      }],
      validationIssues: [],
      stageExit: {
        continueAllowed: true,
        candidates: [
          { controlId: settledDecline.controlId, executable: true, status: "ready" },
          { controlId: continueControl.controlId, executable: true, status: "ready" }
        ]
      }
    }
  };
  const checkoutScene = compileCheckoutScene({ observation, observationFrame: createObservationFrame(observation) });
  const taskState = reduceTaskState({ observation, checkoutScene, traveler: { booking_rules: "No paid extras" } });
  assert.equal(taskState.currentObligation.desiredEffect, "advance_checkout_stage");
  assert.deepEqual(taskState.currentObligation.admittedControlIds, [continueControl.controlId]);
  const candidates = buildCurrentCandidateSet({
    obligation: taskState.currentObligation,
    observation: checkoutScene.observation,
    state: { taskState, approvals: {} },
    traveler: { booking_rules: "No paid extras" }
  });
  assert.deepEqual(candidates.candidates.map((candidate) => candidate.controlId), [continueControl.controlId]);
});

test("WSPay-like required billing fields resolve before reversible payment setup", () => {
  const address = {
    controlId: "customer_address",
    stateElementId: "customer_address_node",
    preferredActivationElementId: "customer_address_node",
    surfaceId: "surface-page",
    surfaceType: "page",
    decisionGroupId: "dg_address",
    label: "customerAddress customer_address address",
    role: "textbox",
    kind: "text",
    required: true,
    state: { normalizedValue: "", valuePresent: false, disabled: false },
    representationLifecycle: { active: true, status: "active_rendered" },
    operations: { type: actionable("type", "customer_address_node") }
  };
  const country = {
    controlId: "customer_country",
    stateElementId: "customer_country_node",
    preferredActivationElementId: "customer_country_node",
    surfaceId: "surface-page",
    surfaceType: "page",
    decisionGroupId: "dg_country",
    label: "COUNTRY",
    role: "select",
    kind: "select-one",
    required: true,
    state: { normalizedValue: "hr", valuePresent: true, disabled: false },
    representationLifecycle: { active: true, status: "active_rendered" },
    operations: { select: actionable("select", "customer_country_node") }
  };
  const method = {
    controlId: "payment_method",
    stateElementId: "payment_method_node",
    preferredActivationElementId: "payment_method_node",
    surfaceId: "surface-page",
    surfaceType: "page",
    decisionGroupId: "dg_payment_method",
    label: "Payment method selector Please select payment method",
    role: "combobox",
    kind: "button",
    required: false,
    state: { normalizedValue: "", valuePresent: false, disabled: false, expanded: false },
    representationLifecycle: { active: true, status: "active_rendered" },
    operations: { open: actionable("open", "payment_method_node") }
  };
  const observation = {
    observationId: "obs_wspay_billing",
    observationSnapshot: { snapshotHash: "hash_wspay_billing" },
    page: {
      step: "traveler_information",
      currentSurface: { id: "surface-page", type: "page", surfaceClass: "checkout" },
      controls: [address, country, method],
      fields: [],
      decisionGroups: [
        { decisionGroupId: "dg_address", required: true, status: "missing", alternatives: [address] },
        { decisionGroupId: "dg_country", required: true, status: "satisfied", selectedControlId: country.controlId, alternatives: [country] },
        {
          decisionGroupId: "dg_payment_method",
          requirementId: "payment:method",
          sectionType: "payment",
          sectionLabel: "Payment method selector",
          required: false,
          status: "optional",
          selectedControlId: "",
          alternatives: [method]
        }
      ],
      validationIssues: [],
      stageExit: { continueAllowed: false, candidates: [] }
    }
  };
  const traveler = {
    address: { line1: "100 Test Avenue", country: "TR" },
    booking_rules: "Reach payment entry without purchasing."
  };
  const scene = compileCheckoutScene({ observation, traveler });
  assert.equal(scene.stage, "payment_method_selection");
  assert.equal(scene.closure.status, "closed");
  assert.ok(scene.profileItems.some((item) => (
    item.semanticType === "address_line1" && item.control.controlId === address.controlId
  )));
  assert.ok(scene.profileItems.some((item) => (
    item.semanticType === "country"
    && item.currentNormalizedValue === "hr"
    && item.desiredNormalizedValue === "tr"
  )));
  const paymentItem = scene.items.find((item) => item.role === "payment_method");
  const addressItem = scene.items.find((item) => (
    item.role === "profile_field" && item.subject === "address_line1"
  ));
  assert.equal(paymentItem.status, "unresolved");
  assert.equal(paymentItem.requiredness, "progression_required");
  assert.equal(addressItem.status, "unresolved");

  const taskState = reduceTaskState({ observation, checkoutScene: scene, traveler });
  assert.equal(taskState.currentObligation.sceneItemId, addressItem.sceneItemId);
  assert.deepEqual(taskState.currentObligation.admittedControlIds, [address.controlId]);
  const billingCandidates = buildCurrentCandidateSet({
    obligation: taskState.currentObligation,
    observation: scene.observation,
    state: { taskState, approvals: {} },
    traveler
  });
  assert.deepEqual(billingCandidates.candidates.map((candidate) => candidate.controlId), [address.controlId]);

  const settledAddress = { ...address, state: { ...address.state, normalizedValue: "100 Test Avenue", valuePresent: true } };
  const settledCountry = { ...country, state: { ...country.state, normalizedValue: "tr", valuePresent: true } };
  const settledObservation = {
    ...observation,
    observationId: "obs_wspay_billing_settled",
    observationSnapshot: { snapshotHash: "hash_wspay_billing_settled" },
    page: {
      ...observation.page,
      controls: [settledAddress, settledCountry, method],
      decisionGroups: [
        { decisionGroupId: "dg_address", required: true, status: "satisfied", selectedControlId: address.controlId, alternatives: [settledAddress] },
        { decisionGroupId: "dg_country", required: true, status: "satisfied", selectedControlId: country.controlId, alternatives: [settledCountry] },
        observation.page.decisionGroups[2]
      ]
    }
  };
  const settledScene = compileCheckoutScene({ observation: settledObservation, traveler });
  const settledPaymentItem = settledScene.items.find((item) => item.role === "payment_method");
  const paymentState = reduceTaskState({ observation: settledObservation, checkoutScene: settledScene, traveler });
  assert.equal(paymentState.currentObligation.sceneItemId, settledPaymentItem.sceneItemId);
  assert.deepEqual(paymentState.currentObligation.admittedControlIds, [method.controlId]);
  const candidates = buildCurrentCandidateSet({
    obligation: paymentState.currentObligation,
    observation: settledScene.observation,
    state: { taskState: paymentState, approvals: {} },
    traveler
  });
  assert.deepEqual(candidates.candidates.map((candidate) => candidate.controlId), [method.controlId]);
  assert.equal(candidates.candidates[0].mechanicalEffect, "open_surface");
});

test("owned payment method on a durable provider handoff is terminal before provider billing work", () => {
  const billing = {
    controlId: "provider_address",
    stateElementId: "provider_address_node",
    preferredActivationElementId: "provider_address_node",
    surfaceId: "surface-page",
    label: "ADDRESS",
    role: "textbox",
    kind: "text",
    required: true,
    state: { normalizedValue: "", valuePresent: false, disabled: false },
    representationLifecycle: { active: true, status: "active_rendered" },
    operations: { type: actionable("type", "provider_address_node") }
  };
  const method = {
    controlId: "provider_payment_method",
    stateElementId: "provider_payment_method_node",
    preferredActivationElementId: "provider_payment_method_node",
    surfaceId: "surface-page",
    label: "Payment method selector Please select payment method",
    role: "combobox",
    kind: "select",
    state: { normalizedValue: "", valuePresent: false, disabled: false },
    representationLifecycle: { active: true, status: "active_rendered" },
    operations: { open: actionable("open", "provider_payment_method_node") }
  };
  const terminalEvidence = agentContract.compileTerminalEvidence({
    url: "https://form.payment-provider.test/authorization",
    structuralEvidence: {
      paymentMethodPresent: true,
      ownedPaymentMethodPresent: true,
      paymentMethodControlIds: [method.stateElementId],
      providerHandoffPresent: true,
      terminalEvidenceSources: ["visible_owned_payment_method", "durable_provider_handoff"]
    }
  });
  assert.equal(terminalEvidence.boundary, "PAYMENT_ENTRY");
  assert.equal(terminalEvidence.boundaryObserved, true);
  assert.deepEqual(terminalEvidence.paymentMethodControlIds, [method.stateElementId]);

  const genericCopy = agentContract.compileTerminalEvidence({
    url: "https://example.test/authorization",
    visibleText: "Credit card payment is available"
  });
  assert.equal(genericCopy.boundary, "UNKNOWN");

  const transaction = {
    itinerary: {
      completeness: "complete",
      segments: [{ segmentId: "segment_1", origin: "ZAG", destination: "SJJ", departureDate: "2026-09-15" }]
    },
    travelers: [{ travelerId: "trav_provider", name: "Ali SIFRAR" }],
    currency: "EUR",
    totalPrice: { amount: 141.62, currency: "EUR" },
    selectedExtras: []
  };
  const transactionReview = {
    ready: true,
    baselineStatus: "approved",
    missingFacts: [],
    contradictions: [],
    unauthorizedPaidExtras: [],
    baseline: transaction,
    current: transaction
  };
  const observation = {
    observationId: "obs_provider_payment_entry",
    observationSnapshot: { snapshotHash: "hash_provider_payment_entry" },
    page: {
      url: "https://form.payment-provider.test/authorization",
      step: "payment_method_selection",
      terminalEvidence,
      currentSurface: { id: "surface-page", type: "page" },
      controls: [billing, method],
      fields: [],
      decisionGroups: [{
        decisionGroupId: "dg_provider_payment_method",
        requirementId: "payment:method",
        sectionType: "payment",
        required: false,
        status: "optional",
        alternatives: [method]
      }],
      validationIssues: [],
      stageExit: { continueAllowed: false, candidates: [] }
    }
  };
  const scene = compileCheckoutScene({
    observation,
    state: { transactionInvariants: { baseline: transaction } },
    traveler: { id: "trav_provider", address: { line1: "100 Test Avenue" } }
  });
  assert.equal(scene.stage, "payment_entry");
  assert.equal(scene.terminalState.paymentEntry, true);
  assert.deepEqual(scene.terminalState.pendingRequiredSceneItemIds, []);
  assert.deepEqual(scene.terminalState.pendingRequiredProfileControlIds, []);

  const state = reduceTaskState({
    observation,
    checkoutScene: scene,
    traveler: { id: "trav_provider", address: { line1: "100 Test Avenue" } },
    transactionReview
  });
  assert.equal(state.terminalStatus, "payment_entry_reached");
  assert.equal(state.disposition.code, "PAYMENT_ENTRY_REACHED");
  assert.equal(state.currentObligation, null);
});
