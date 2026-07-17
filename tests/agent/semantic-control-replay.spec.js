const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("@playwright/test");
const { governAction } = require("../../apps/web/agent/action-governor");
const {
  deriveProfileGoal,
  profileGoalSatisfied
} = require("../../apps/web/agent/skill-expander");
const { runLoopTurn, toClientDecision, __private: loopPrivate } = require("../../apps/web/agent/loop");
const {
  actionForObservationCandidate,
  deriveObservationGoal
} = require("../../apps/web/agent/observation-candidates");
const { actionForCurrentCandidate, buildCurrentCandidateSet } = require("../../apps/web/agent/current-candidate-builder");
const { advanceActionLifecycle } = require("../../apps/web/agent/action-lifecycle");
const { sanitizedActionHistory } = require("../../apps/web/agent/model-context");
const { resolvePlannerSelection } = require("../../apps/web/agent/verify-and-plan");
const { evaluateTransition } = require("../../apps/web/agent/transition-evaluator");
const { createCheckoutSessionState } = require("../../packages/shared/agent-state");

const fixturePath = path.join(__dirname, "..", "fixtures", "semantic-controls", "seat-baggage.html");
const profileFixturePath = path.join(__dirname, "..", "fixtures", "semantic-controls", "profile-form.html");
const contentScriptPath = path.join(__dirname, "..", "..", "apps", "extension", "src", "content", "content.js");
const TEST_API = `http://127.0.0.1:${Number(process.env.ATW_TEST_PORT || 4273)}/api`;

async function loadProducer(page, sourcePath = fixturePath) {
  await page.setContent(fs.readFileSync(sourcePath, "utf8"));
  await page.evaluate(() => { window.__ATW_ENABLE_TEST_HOOKS__ = true; });
  await page.addScriptTag({ path: contentScriptPath });
  await page.waitForFunction(() => Boolean(window.__ATW_TEST__));
}

async function loadHtmlProducer(page, html) {
  await page.setContent(html);
  await page.evaluate(() => { window.__ATW_ENABLE_TEST_HOOKS__ = true; });
  await page.addScriptTag({ path: contentScriptPath });
  await page.waitForFunction(() => Boolean(window.__ATW_TEST__));
}

function editableComboboxVariantHtml(variant) {
  return `
    <style>
      body { font-family: sans-serif; padding: 24px; }
      .country-control { display: flex; width: 260px; }
      #country-code { flex: 1; height: 34px; }
      #country-open { width: 42px; cursor: pointer; }
      #country-options { position: fixed; left: 24px; top: 90px; width: 260px; background: white; border: 1px solid #444; z-index: 20; }
      #country-options[hidden] { display: none; }
    </style>
    <main>
      <h1>Traveller information</h1>
      <label for="country-code">Country code</label>
      <div class="country-control">
        <input id="country-code" name="phone_country_code" role="combobox"
          aria-haspopup="listbox" aria-controls="country-options" aria-expanded="false" value="+44">
        ${["open_choose", "portal", "first_fail", "open_once"].includes(variant)
          ? `<button id="country-open" type="button" aria-label="Open country codes" aria-controls="country-options" aria-haspopup="listbox">⌄</button>`
          : ""}
      </div>
    </main>
    <div id="country-options" role="listbox" aria-label="Country code" hidden>
      <button id="country-si" type="button" role="option" data-value="+386">Slovenia +386</button>
      <button id="country-gb" type="button" role="option" data-value="+44">United Kingdom +44</button>
    </div>
    <script>
      (() => {
        const variant = ${JSON.stringify(variant)};
        const input = document.getElementById("country-code");
        const options = document.getElementById("country-options");
        const opener = document.getElementById("country-open");
        window.__variantState = { openCount: 0 };
        const show = () => {
          window.__variantState.openCount += 1;
          options.hidden = false;
          input.setAttribute("aria-expanded", "true");
        };
        const commit = (value) => {
          const live = document.getElementById("country-code");
          live.value = value;
          live.setAttribute("aria-expanded", "false");
          live.dispatchEvent(new Event("input", { bubbles: true }));
          live.dispatchEvent(new Event("change", { bubbles: true }));
          options.hidden = true;
        };
        opener?.addEventListener("click", () => {
          if (variant === "first_fail" && window.__variantState.openCount === 0) {
            window.__variantState.openCount += 1;
            return;
          }
          show();
        });
        input.addEventListener("input", () => {
          const value = input.value.toLowerCase();
          if (variant === "direct_type" && /386/.test(value)) input.value = "+386";
          if (["typing_suggestions", "first_fail"].includes(variant) && /386|slovenia/.test(value)) show();
          if (variant === "dom_replace" && /386/.test(value)) {
            const replacement = input.cloneNode(true);
            replacement.value = "+386";
            input.replaceWith(replacement);
          }
        });
        input.addEventListener("keydown", (event) => {
          if (variant === "keyboard" && event.key === "ArrowDown") show();
          if (variant === "keyboard" && event.key === "Enter" && !options.hidden) commit("+386");
        });
        options.addEventListener("click", (event) => {
          const option = event.target.closest("[role='option']");
          if (option) commit(option.dataset.value);
        });
      })();
    </script>
  `;
}

async function browserObservation(page, observationId) {
  return page.evaluate((id) => {
    const hooks = window.__ATW_TEST__;
    const map = hooks.buildPageMap();
    hooks.prepareScreenshotAnnotations(map, id);
    const compact = hooks.compactPageMap(map);
    return {
      observationId: id,
      observationSnapshot: { snapshotHash: compact.snapshotHash },
      page: compact
    };
  }, observationId);
}

async function executeAtomicBrowserDecision(page, decision, resultObservationId) {
  return page.evaluate(async ({ governed, nextObservationId }) => {
    const hooks = window.__ATW_TEST__;
    const beforeMap = hooks.buildPageMap();
    hooks.prepareScreenshotAnnotations(beforeMap, governed.observationId);
    let target = null;
    let validation = null;
    if (governed.action === "click_xy") {
      const hit = document.elementFromPoint(governed.x, governed.y);
      target = hit;
      validation = hooks.validateVisualCoordinateTarget(governed, hit, beforeMap);
      if (validation.ok) hooks.clickViewportPoint(governed.x, governed.y);
    } else {
      target = hooks.resolveDecisionTarget(governed, beforeMap);
      validation = target
        ? hooks.validateResolvedTarget(governed, target, beforeMap)
        : { ok: false, code: "CANONICAL_ACTUATOR_UNAVAILABLE" };
      if (validation.ok && governed.action === "click") {
        hooks.rememberCanonicalSelectionCommitment(target, governed);
        hooks.userLikeClick(target);
      } else if (validation.ok && governed.action === "keypress") {
        target.focus?.();
        hooks.dispatchKey(target, governed.keys);
      } else if (validation.ok && (governed.action === "type" || governed.action === "select")) {
        const fieldResult = await hooks.setFieldValue(target, governed.value || "", {
          fieldType: governed.action,
          compareMode: governed.operation === "type" && governed.controlId.includes("phone") ? "digits" : "text",
          resolveLiveElement: () => hooks.resolveDecisionTarget(governed, hooks.buildPageMap())
        });
        if (!fieldResult.ok) validation = { ok: false, code: "FIELD_VALUE_NOT_VERIFIED", fieldResult };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
    const afterMap = hooks.buildPageMap();
    hooks.prepareScreenshotAnnotations(afterMap, nextObservationId);
    const expectedOutcome = governed.expectedOutcome || hooks.expectedOutcomeForDecision(governed, beforeMap, target);
    const verification = validation.ok
      ? hooks.verifyExpectedOutcome(expectedOutcome, beforeMap, afterMap, target)
      : { ok: false, code: validation.code, message: "Browser validation rejected the action.", evidence: {} };
    const result = validation.ok
      ? hooks.rememberActionExecutionResult(
          governed.actionId || governed.id,
          governed.observationId,
          governed,
          expectedOutcome,
          verification
        )
      : {
          actionId: governed.actionId || governed.id,
          observationId: governed.observationId,
          dispatched: false,
          executed: false,
          verified: false,
          outcome: verification
        };
    const compact = hooks.compactPageMap(afterMap);
    return {
      validation,
      verification,
      result,
      observation: {
        observationId: nextObservationId,
        observationSnapshot: { snapshotHash: compact.snapshotHash },
        page: compact,
        lastActionResult: result
      },
      countryValue: document.getElementById("country-code")?.value || "",
      phoneValue: document.getElementById("phone")?.value || ""
    };
  }, { governed: decision, nextObservationId: resultObservationId });
}

function inMemoryGovernorStore() {
  const observations = new Map();
  const governed = new Set();
  return {
    remember(transactionId, observation) {
      observations.set(transactionId, {
        id: observation.observationId,
        hash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || ""
      });
    },
    isCurrentObservation(transactionId, observationId, observationHash) {
      const current = observations.get(transactionId);
      return Boolean(current && current.id === observationId && current.hash === observationHash);
    },
    reserveGovernedAction({ action }) {
      const signature = `${action.id}:${action.observationId}`;
      if (governed.has(signature)) return { ok: false, code: "DUPLICATE_ACTION", reason: "Duplicate governed action." };
      governed.add(signature);
      return { ok: true, signature };
    },
    recordActionEvent() {}
  };
}

test("viewport recovery waits for fresh proof, survives snap-back, and resumes the stored decline once", async ({ page }) => {
  await loadHtmlProducer(page, `
    <style>
      body { margin: 0; font-family: sans-serif; }
      #bundle-scroll { height: 220px; overflow-y: auto; border: 1px solid #888; }
      .spacer { height: 900px; }
      label { display: block; padding: 12px; }
    </style>
    <main>
      <h1>Choose your travel bundle</h1>
      <div id="bundle-scroll">
        <fieldset>
          <legend>Bundle options</legend>
          <label><input type="radio" name="bundle" value="premium"> Premium bundle — 40 EUR</label>
          <div class="spacer"></div>
          <label><input id="bundle-decline" type="radio" name="bundle" value="none"> No, thanks</label>
        </fieldset>
      </div>
    </main>
    <script>
      window.__declineClicks = 0;
      document.getElementById("bundle-decline").addEventListener("click", () => { window.__declineClicks += 1; });
    </script>
  `);

  const initial = await browserObservation(page, "obs_bundle_below_viewport");
  const decline = initial.page.controls.find((control) => /no,? thanks/i.test(control.label || control.accessibleName || ""));
  expect(decline).toBeTruthy();
  expect(decline.visualRegion?.inViewport).toBe(false);

  const originalClick = loopPrivate.bindTargetSnapshot({
    id: "act_bundle_decline",
    type: "click",
    observationId: initial.observationId,
    observationHash: initial.observationSnapshot.snapshotHash,
    intent: "decline_optional_extra",
    controlId: decline.controlId,
    decisionGroupId: decline.decisionGroupId,
    targetId: decline.preferredActivationElementId || decline.stateElementId || decline.controlId,
    targetLabel: decline.label,
    risk: "safe",
    requiresApproval: false,
    reason: "Decline the optional bundle."
  }, initial);

  let state = createCheckoutSessionState({
    goal: "Decline optional bundle",
    travelerId: "trav_scroll",
    site: { host: "example.test", url: initial.page.url }
  });
  state.id = "txn_scroll_snapback";
  state.approvals.skipPaidExtrasApproved = true;
  state.currentObservation = {
    observationId: initial.observationId,
    observationHash: initial.observationSnapshot.snapshotHash
  };
  state.lastAction = { id: "act_first_scroll", type: "scroll" };
  state.pendingAction = {
    type: "viewport_rebind",
    recoveryCount: 1,
    viewportProgress: [{
      observationId: initial.observationId,
      exists: true,
      inViewport: false,
      distanceToViewport: Math.max(0, Math.round(
        Number(decline.visualRegion.y || 0)
        + Number(decline.visualRegion.height || 0) / 2
        - Number(initial.page.viewport?.height || 0)
      )),
      measurableProgress: false
    }],
    noProgressFailureCount: 0,
    blockedActionId: originalClick.id,
    createdObservationId: initial.observationId,
    action: { ...originalClick, targetSnapshot: null, expectedOutcome: null }
  };

  const firstMovement = await page.evaluate((decision) => {
    const hooks = window.__ATW_TEST__;
    const map = hooks.buildPageMap();
    const target = hooks.resolveDecisionTarget({ ...decision, action: "click" }, map);
    const scroller = document.getElementById("bundle-scroll");
    const before = scroller.scrollTop;
    hooks.scrollElementWithinNearestContainer(target, {
      behavior: "auto",
      strategy: "target_center",
      authority: "governed_executor"
    });
    const after = scroller.scrollTop;
    scroller.scrollTop = 0;
    const beforeCursor = scroller.scrollTop;
    hooks.showAgentCursor(target, "Observe pending target", "Cursor rendering must not control scrolling.");
    const afterCursor = scroller.scrollTop;
    return {
      before,
      after,
      snappedBack: scroller.scrollTop,
      beforeCursor,
      afterCursor,
      cursorVisible: document.getElementById("atw-agent-cursor")?.classList.contains("is-visible") || false
    };
  }, originalClick);
  expect(firstMovement.after).toBeGreaterThan(firstMovement.before);
  expect(firstMovement.snappedBack).toBe(0);
  expect(firstMovement.afterCursor).toBe(firstMovement.beforeCursor);
  expect(firstMovement.cursorVisible).toBe(false);

  const snappedBack = await browserObservation(page, "obs_bundle_snapped_back");
  expect(snappedBack.observationSnapshot.snapshotHash).toBe(initial.observationSnapshot.snapshotHash);
  const store = inMemoryGovernorStore();
  store.remember(state.id, snappedBack);
  const retry = await runLoopTurn({
    apiKey: "",
    model: "must-not-be-called",
    dataDir: "",
    state,
    observation: snappedBack,
    traveler: { id: "trav_scroll", booking_rules: "no extras" },
    transactionStore: store,
    clientTurnId: "turn_centered_retry"
  });
  expect(retry.clientDecision.action).toBe("scroll");
  expect(retry.clientDecision.expectedOutcome.attempt).toBe(2);
  expect(retry.clientDecision.expectedOutcome.scrollStrategy).toBe("target_center");
  expect(retry.state.pendingAction.recoveryCount).toBe(2);
  expect(retry.state.pendingAction.noProgressFailureCount).toBe(1);
  expect(retry.debug.modelUsage.calls).toHaveLength(0);

  await page.evaluate((decision) => {
    const hooks = window.__ATW_TEST__;
    const map = hooks.buildPageMap();
    const target = hooks.resolveDecisionTarget(decision, map)
      || document.querySelector(`[data-atw-element-id="${CSS.escape(decision.targetId || "")}"]`)
      || document.getElementById(decision.targetId || "");
    hooks.scrollElementWithinNearestContainer(target, {
      behavior: "auto",
      strategy: decision.expectedOutcome.scrollStrategy,
      authority: "governed_executor"
    });
  }, retry.clientDecision);
  const visible = await browserObservation(page, "obs_bundle_fresh_visible");
  visible.lastActionResult = {
    actionId: retry.clientDecision.actionId,
    dispatched: true,
    executed: true,
    verified: false,
    outcome: { code: "SCROLL_DISPATCHED_AWAITING_FRESH_OBSERVATION" }
  };
  expect(visible.page.controls.find((control) => control.controlId === decline.controlId)?.visualRegion?.inViewport).toBe(true);

  state = retry.state;
  store.remember(state.id, visible);
  const resumed = await runLoopTurn({
    apiKey: "",
    model: "must-not-be-called",
    dataDir: "",
    state,
    observation: visible,
    traveler: { id: "trav_scroll", booking_rules: "no extras" },
    transactionStore: store,
    clientTurnId: "turn_resume_decline"
  });
  expect(resumed.clientDecision.action).toBe("click");
  expect(resumed.clientDecision.controlId).toBe(decline.controlId);
  expect(resumed.state.pendingAction).toBeNull();

  const clicked = await executeAtomicBrowserDecision(page, resumed.clientDecision, "obs_bundle_satisfied");
  expect(clicked.verification.ok).toBe(true);
  expect(await page.evaluate(() => window.__declineClicks)).toBe(1);
  expect(clicked.observation.page.decisionGroups.some((group) => group.status === "satisfied")).toBe(true);
});

async function executeUnifiedCandidate({ page, store, state, goal, candidate, observation, nextObservationId, turnId }) {
  const action = loopPrivate.bindTargetSnapshot(
    actionForCurrentCandidate(goal, candidate, observation),
    observation
  );
  const governance = governAction({
    action,
    state: { ...state, currentGoal: { ...goal, candidates: goal.candidates } },
    observation,
    traveler: { id: "trav_combo", phone: "+38670328922", nationality: "Slovenia" },
    store,
    turnId
  });
  expect(governance.allow, JSON.stringify(governance)).toBe(true);
  const browser = await executeAtomicBrowserDecision(page, {
    ...action,
    action: action.type,
    actionId: action.id
  }, nextObservationId);
  return { action, browser };
}

test("Unified currentGoal loop executes server candidates selected only by candidateId", async ({ page }) => {
  const traveler = { id: "trav_combo", phone: "+38670328922", nationality: "Slovenia" };
  for (const variant of [
    { name: "direct_type", operation: "type", value: "+386" },
    { name: "typing_suggestions", operation: "type", value: "slovenia" },
    { name: "open_choose", operation: "open" },
    { name: "keyboard", operation: "keyboard" },
    { name: "dom_replace", operation: "type", value: "+386" },
    { name: "portal", operation: "open" },
    { name: "open_once", operation: "open" }
  ]) {
    await loadHtmlProducer(page, editableComboboxVariantHtml(variant.name));
    await page.evaluate(() => window.__ATW_TEST__.setAppDataForTest({
      travelers: [{ id: "trav_combo", phone: "+38670328922", nationality: "Slovenia" }],
      preferences: {}
    }, "trav_combo"));
    const observation = await browserObservation(page, `obs_unified_${variant.name}_closed`);
    let goal = deriveProfileGoal(observation, traveler);
    let attempted = [];
    goal.candidates = buildCurrentCandidateSet({ goal, observation, traveler, attemptedCandidateIds: attempted }).candidates;
    const selectedCandidateId = goal.candidates.find((candidate) => (
      candidate.operation === variant.operation
      && (!variant.value || candidate.value === variant.value)
    ))?.candidateId;
    expect(selectedCandidateId, variant.name).toBeTruthy();
    const candidate = goal.candidates.find((item) => item.candidateId === selectedCandidateId);
    const store = inMemoryGovernorStore();
    const state = createCheckoutSessionState({
      goal: "Set country code",
      travelerId: traveler.id,
      site: { host: "example.test", url: observation.page.url }
    });
    state.id = `txn_unified_${variant.name}`;
    state.currentGoal = goal;
    store.remember(state.id, observation);
    const first = await executeUnifiedCandidate({
      page,
      store,
      state,
      goal,
      candidate,
      observation,
      nextObservationId: `obs_unified_${variant.name}_progress`,
      turnId: `turn_unified_${variant.name}_first`
    });
    expect(first.browser.result.dispatched, variant.name).toBe(true);
    attempted = [candidate.strategyId || candidate.candidateId];
    if (!profileGoalSatisfied(goal, first.browser.observation, traveler)) {
      goal = deriveProfileGoal(first.browser.observation, traveler, goal);
      goal.candidates = buildCurrentCandidateSet({ goal, observation: first.browser.observation, traveler, attemptedCandidateIds: attempted }).candidates;
      const choose = goal.candidates.find((item) => item.operation === "choose");
      expect(choose, variant.name).toBeTruthy();
      state.currentGoal = goal;
      store.remember(state.id, first.browser.observation);
      const second = await executeUnifiedCandidate({
        page,
        store,
        state,
        goal,
        candidate: choose,
        observation: first.browser.observation,
        nextObservationId: `obs_unified_${variant.name}_complete`,
        turnId: `turn_unified_${variant.name}_choose`
      });
      expect(profileGoalSatisfied(goal, second.browser.observation, traveler), variant.name).toBe(true);
    }
    expect(await page.locator("#country-code").inputValue(), variant.name).toBe("+386");
    if (variant.name === "open_once") {
      expect(await page.evaluate(() => window.__variantState.openCount)).toBe(1);
    }
  }

  await loadHtmlProducer(page, editableComboboxVariantHtml("first_fail"));
  await page.evaluate(() => window.__ATW_TEST__.setAppDataForTest({
    travelers: [{ id: "trav_combo", phone: "+38670328922", nationality: "Slovenia" }],
    preferences: {}
  }, "trav_combo"));
  const observation = await browserObservation(page, "obs_unified_first_fail_closed");
  let goal = deriveProfileGoal(observation, traveler);
  let attempted = [];
  goal.candidates = buildCurrentCandidateSet({ goal, observation, traveler, attemptedCandidateIds: attempted }).candidates;
  const failedCandidate = goal.candidates.find((item) => item.operation === "open");
  const store = inMemoryGovernorStore();
  const state = createCheckoutSessionState({
    goal: "Set country code",
    travelerId: traveler.id,
    site: { host: "example.test", url: observation.page.url }
  });
  state.id = "txn_unified_first_fail";
  state.currentGoal = goal;
  store.remember(state.id, observation);
  const failed = await executeUnifiedCandidate({
    page,
    store,
    state,
    goal,
    candidate: failedCandidate,
    observation,
    nextObservationId: "obs_unified_first_fail_after_open",
    turnId: "turn_unified_first_fail_open"
  });
  expect(failed.browser.result.verified).toBe(false);
  attempted.push(failedCandidate.strategyId || failedCandidate.candidateId);
  goal = deriveProfileGoal(failed.browser.observation, traveler, goal);
  goal.candidates = buildCurrentCandidateSet({ goal, observation: failed.browser.observation, traveler, attemptedCandidateIds: attempted }).candidates;
  expect(goal.candidates.some((item) => item.strategyId === failedCandidate.strategyId)).toBe(false);
  const fallback = goal.candidates.find((item) => item.operation === "type" && item.value === "slovenia");
  state.currentGoal = goal;
  store.remember(state.id, failed.browser.observation);
  const typed = await executeUnifiedCandidate({
    page,
    store,
    state,
    goal,
    candidate: fallback,
    observation: failed.browser.observation,
    nextObservationId: "obs_unified_first_fail_suggestions",
    turnId: "turn_unified_first_fail_type"
  });
  attempted.push(fallback.strategyId || fallback.candidateId);
  goal = deriveProfileGoal(typed.browser.observation, traveler, goal);
  goal.candidates = buildCurrentCandidateSet({ goal, observation: typed.browser.observation, traveler, attemptedCandidateIds: attempted }).candidates;
  const choose = goal.candidates.find((item) => item.operation === "choose");
  state.currentGoal = goal;
  store.remember(state.id, typed.browser.observation);
  const completed = await executeUnifiedCandidate({
    page,
    store,
    state,
    goal,
    candidate: choose,
    observation: typed.browser.observation,
    nextObservationId: "obs_unified_first_fail_complete",
    turnId: "turn_unified_first_fail_choose"
  });
  expect(profileGoalSatisfied(goal, completed.browser.observation, traveler)).toBe(true);
});

test("P0.4 browser replay fills the complete profile and chooses the exact country-code option", async ({ page }) => {
  await loadProducer(page, profileFixturePath);
  const result = await page.evaluate(async () => {
    const hooks = window.__ATW_TEST__;
    hooks.setAppDataForTest({
      travelers: [{
        id: "trav_profile",
        first_name: "Ali",
        last_name: "SIFRAR",
        email: "ali@aztellmedia.com",
        phone: "70328922",
        nationality: "Slovenia",
        gender: "male",
        date_of_birth: "2003-05-31",
        booking_rules: "No paid extras"
      }],
      preferences: {}
    }, "trav_profile");
    const values = {
      email: "ali@aztellmedia.com",
      confirm_email: "ali@aztellmedia.com",
      phone: "70328922",
      first_name: "Ali",
      last_name: "SIFRAR",
      date_of_birth: "31-05-2003"
    };
    const fillResults = [];
    for (const [semantic, value] of Object.entries(values)) {
      let map = hooks.buildPageMap();
      const field = map.fields.find((item) => item.field === semantic);
      const control = map.controls.find((item) => item.controlId === field?.controlId);
      const target = hooks.resolveDecisionTarget({
        action: "type",
        operation: "type",
        controlId: control?.controlId,
        targetId: control?.operations?.type?.actuatorId
      }, map);
      const filled = await hooks.setFieldValue(target, value, {
        fieldType: semantic,
        compareMode: semantic === "phone" ? "digits" : "text",
        resolveLiveElement: () => {
          map = hooks.buildPageMap();
          const liveField = map.fields.find((item) => item.field === semantic);
          const liveControl = map.controls.find((item) => item.controlId === liveField?.controlId);
          return hooks.resolveDecisionTarget({
            action: "type",
            operation: "type",
            controlId: liveControl?.controlId,
            targetId: liveControl?.operations?.type?.actuatorId
          }, map);
        }
      });
      fillResults.push({ semantic, ok: filled.ok, value: document.querySelector(`[name='${semantic}']`)?.value || "" });
    }

    let map = hooks.buildPageMap();
    const titleField = map.fields.find((field) => field.field === "title" && /\bmr\b/i.test(field.label) && !/mrs|ms/i.test(field.label));
    const title = map.controls.find((control) => control.controlId === titleField?.controlId);
    hooks.resolveDecisionTarget({
      action: "click",
      operation: "choose",
      controlId: title.controlId,
      targetId: title.operations?.choose?.actuatorId
    }, map)?.click();

    map = hooks.buildPageMap();
    const countryField = map.fields.find((field) => field.field === "phone_country_code");
    const countryControl = map.controls.find((control) => control.controlId === countryField.controlId);
    const countryOpenTarget = hooks.resolveDecisionTarget({
      action: "click",
      operation: "open",
      controlId: countryControl.controlId,
      targetId: countryControl.operations?.open?.actuatorId
    }, map);
    hooks.userLikeClick(countryOpenTarget, { operation: "open", fixture: "profile-form" });

    map = hooks.buildPageMap();
    const slovenia = map.controls.find((control) => /slovenia.*\+386/i.test(`${control.label} ${control.accessibleName}`));
    const guernsey = map.controls.find((control) => /guernsey.*44.?1481/i.test(`${control.label} ${control.accessibleName}`));
    const selected = hooks.resolveDecisionTarget({
      action: "click",
      operation: "choose",
      controlId: slovenia.controlId,
      targetId: slovenia.operations?.choose?.actuatorId
    }, map);
    hooks.userLikeClick(selected, { operation: "choose", fixture: "profile-form" });

    const finalMap = hooks.buildPageMap();
    const finalTitle = finalMap.controls.find((control) => control.controlId === title.controlId);
    return {
      fillResults,
      titleSelected: Boolean(finalTitle?.state?.checked || document.getElementById("title-mr")?.checked),
      countryValue: document.getElementById("country-code")?.value || "",
      countryNormalizedValue: finalMap.controls.find((control) => control.controlId === countryControl.controlId)?.state?.normalizedValue || "",
      countryOpenActuatorWasArrow: countryOpenTarget?.id === "country-code-arrow",
      countrySurfaceClosed: document.getElementById("country-options")?.hidden === true,
      countryControlIdsDistinct: Boolean(slovenia?.controlId && guernsey?.controlId && slovenia.controlId !== guernsey.controlId),
      requiredMissing: finalMap.fields
        .filter((field) => field.required && !field.hasValue)
        .map((field) => field.field),
      visibleErrors: finalMap.errors || [],
      graphIntegrity: finalMap.graphIntegrity
    };
  });

  expect(result.fillResults.every((item) => item.ok), JSON.stringify(result.fillResults)).toBe(true);
  expect(result.fillResults.map((item) => item.value)).toEqual([
    "ali@aztellmedia.com",
    "ali@aztellmedia.com",
    "70328922",
    "Ali",
    "SIFRAR",
    "31-05-2003"
  ]);
  expect(result.titleSelected).toBe(true);
  expect(result.countryValue).toBe("+386");
  expect(result.countryNormalizedValue).toBe("+386");
  expect(result.countryOpenActuatorWasArrow).toBe(true);
  expect(result.countrySurfaceClosed).toBe(true);
  expect(result.countryControlIdsDistinct).toBe(true);
  expect(result.requiredMissing).toEqual([]);
  expect(result.visibleErrors).toEqual([]);
  expect(result.graphIntegrity.ok).toBe(true);
});

test("P0.5 browser observation publishes structured transaction facts instead of visible-text fingerprints", async ({ page }) => {
  await loadHtmlProducer(page, `
    <main>
      <h1>Trip summary</h1>
      <section
        data-origin="LHR"
        data-destination="LJU"
        data-departure-date="2026-08-10"
        data-departure-time="10:20"
        data-arrival-time="13:30"
        data-flight-number="BA690"
      >
        <p>LHR → LJU</p>
        <p>Monday 10 August 2026, 10:20 - 13:30</p>
        <p>Flight BA 690</p>
        <p>Base fare: 180 EUR</p>
      </section>
      <p>Total 208 EUR</p>
      <button type="button">Continue</button>
    </main>
  `);
  await page.evaluate(() => window.__ATW_TEST__.setAppDataForTest({
    travelers: [{ id: "trav_facts", first_name: "Alex", last_name: "Example" }],
    preferences: {}
  }, "trav_facts"));

  const observed = await page.evaluate(() => {
    const map = window.__ATW_TEST__.buildPageMap();
    return window.__ATW_TEST__.compactPageMap(map);
  });

  expect(observed.transactionFacts).toMatchObject({
    itinerary: {
      completeness: "complete",
      segments: [{
        origin: "LHR",
        destination: "LJU",
        departureDate: "2026-08-10",
        departureTime: "10:20",
        arrivalTime: "13:30",
        flightNumber: "BA690"
      }]
    },
    travelers: [{ travelerId: "trav_facts", name: "Alex Example" }],
    currency: "EUR",
    basePrice: { amount: 180, currency: "EUR" }
  });
  expect(observed.transactionFacts.provenance[0].source).toBe("travel_details");
  expect(observed).not.toHaveProperty("itineraryFingerprint");
  expect(observed).not.toHaveProperty("offerFingerprint");
});

test("risk-scoped screenshot grounding drops removed seat annotations and preserves No thanks", async ({ page }) => {
  await loadHtmlProducer(page, `
    <main>
      <h1>Reserve seating</h1>
      <section aria-label="Seat selection">
        <button id="seat-no-thanks" type="button">No thanks</button>
        <button id="seat-unavailable-a" type="button" disabled>Not available</button>
        <button id="seat-unavailable-b" type="button" disabled>Not available</button>
      </section>
    </main>
    <script>
      window.__noThanksClicks = 0;
      document.getElementById("seat-no-thanks").addEventListener("click", () => { window.__noThanksClicks += 1; });
    </script>
  `);

  const result = await page.evaluate(() => {
    const hooks = window.__ATW_TEST__;
    const map = hooks.buildPageMap();
    const noThanks = map.controls.find((control) => /no thanks/i.test(control.label || control.accessibleName || ""));
    map.fields.push({
      id: "removed-seat-cell",
      controlId: "ctrl_removed_seat_cell",
      label: "Not available",
      box: { x: 10, y: 10, width: 50, height: 20, inViewport: true }
    });
    map.activeSurface = {
      id: "stale-seat-surface",
      type: "modal",
      options: [{
        id: "removed-seat-option",
        controlId: "ctrl_removed_seat_option",
        label: "Not available",
        box: { x: 20, y: 20, width: 50, height: 20, inViewport: true }
      }]
    };
    const annotations = hooks.prepareScreenshotAnnotations(map, "obs_seat_annotations");
    const target = hooks.resolveDecisionTarget({
      action: "click",
      operation: noThanks.operations?.activate ? "activate" : "choose",
      controlId: noThanks.controlId,
      targetId: noThanks.operations?.activate?.actuatorId || noThanks.operations?.choose?.actuatorId || noThanks.preferredActivationElementId
    }, map);
    hooks.userLikeClick(target, { operation: "activate", fixture: "risk-scoped-seat" });
    return {
      finalControlIds: map.controls.map((control) => control.controlId),
      annotationControlIds: annotations.map((annotation) => annotation.controlId),
      noThanksControlId: noThanks.controlId,
      noThanksAnnotated: annotations.some((annotation) => annotation.controlId === noThanks.controlId),
      staleAnnotated: annotations.some((annotation) => /ctrl_removed/.test(annotation.controlId || "")),
      clicks: window.__noThanksClicks
    };
  });

  expect(result.annotationControlIds.every((controlId) => result.finalControlIds.includes(controlId))).toBe(true);
  expect(result.noThanksAnnotated).toBe(true);
  expect(result.staleAnnotated).toBe(false);
  expect(result.clicks).toBe(1);
});

test("semantic affordances preserve zero-price truth, proven actuators, and stable identity across rerenders", async ({ page }) => {
  await loadHtmlProducer(page, `
    <style>
      #seat-modal { padding: 20px; border: 1px solid #777; }
      #seat-footer { display: flex; gap: 14px; align-items: center; }
      label, button { min-height: 32px; padding: 6px; }
    </style>
    <section id="seat-modal" role="dialog" aria-modal="true" aria-labelledby="seat-heading" aria-owns="seat-footer">
      <h2 id="seat-heading">Reserve seating — Flight 1 of 2</h2>
      <button id="paid-seat" type="button">Seat 1A — 18 EUR</button>
    </section>
    <div id="seat-footer" role="group" aria-label="Seat selection actions">
      <label id="random-seat-label"><input id="random-seat" type="radio" name="seat-preference" required> Random seating — 0 EUR</label>
      <button id="seat-next" type="button"><span id="next-copy">Next</span></button>
      <span id="fake-skip">Skip</span>
    </div>
  `);

  const first = await browserObservation(page, "obs_affordance_first");
  const nodeIds = await page.evaluate(() => ({
    next: document.getElementById("seat-next").dataset.atwElementId,
    nextCopy: document.getElementById("next-copy").dataset.atwElementId || "",
    fakeSkip: document.getElementById("fake-skip").dataset.atwElementId || ""
  }));
  const random = first.page.controls.find((control) => /random seating/i.test(control.label || control.accessibleName || ""));
  const next = first.page.controls.find((control) => /^next$/i.test(control.label || control.accessibleName || ""));

  expect(random).toBeTruthy();
  expect(random.structuredPrice).toEqual({ amount: 0, currency: "EUR" });
  expect(random.risk).toBe("safe");
  expect(random.operations.choose.actuatorId).toBeTruthy();
  expect(next).toBeTruthy();
  expect(next.operations.activate.actuatorId).toBe(nodeIds.next);
  expect(next.operations.activate.actuatorId).not.toBe(nodeIds.nextCopy);
  expect(first.page.controls.some((control) => (
    control.stateElementId === nodeIds.fakeSkip
    || control.preferredActivationElementId === nodeIds.fakeSkip
  ))).toBe(false);

  const goal = {
    goalId: "goal_random_free",
    semanticGoal: "avoid paid seats",
    semanticType: "seat_decision",
    desiredValue: "free_or_no_extra",
    decisionGroupId: random.decisionGroupId,
    requirementId: random.decisionGroupId,
    observationId: first.observationId
  };
  const candidateSet = buildCurrentCandidateSet({ goal, observation: first });
  const candidate = candidateSet.candidates.find((item) => item.controlId === random.controlId && item.operation === "choose");
  expect(candidate).toBeTruthy();
  expect(candidate.affordance).toMatchObject({
    stableKey: random.stableKey,
    structuredPrice: { amount: 0, currency: "EUR" },
    risk: "safe",
    capability: "choose",
    effect: "select_free_option",
    actuator: { targetId: random.operations.choose.actuatorId, proven: true },
    postcondition: { type: "exact_free_option_selected", expectedSelectedControlId: random.controlId }
  });

  await page.evaluate(() => {
    document.getElementById("seat-heading").textContent = "Choose seats for the outbound flight";
    document.getElementById("seat-modal").setAttribute("aria-label", "A classifier may rename this surface");
    const random = document.getElementById("random-seat");
    const rerenderedRandom = random.cloneNode(true);
    rerenderedRandom.id = "random-seat-rerendered";
    random.replaceWith(rerenderedRandom);
    const next = document.getElementById("seat-next");
    const rerenderedNext = next.cloneNode(true);
    rerenderedNext.id = "seat-next-rerendered";
    next.replaceWith(rerenderedNext);
  });
  const rerendered = await browserObservation(page, "obs_affordance_rerendered");
  const sameRandom = rerendered.page.controls.find((control) => /random seating/i.test(control.label || control.accessibleName || ""));
  const sameNext = rerendered.page.controls.find((control) => /^next$/i.test(control.label || control.accessibleName || ""));

  expect(sameRandom.stableKey).toBe(random.stableKey);
  expect(sameRandom.controlId).toBe(random.controlId);
  expect(sameNext.stableKey).toBe(next.stableKey);
  expect(sameNext.controlId).toBe(next.controlId);
});

test("P0.9 producer replay keeps safe/paid siblings distinct and rejects tiny helpers", async ({ page }) => {
  await loadProducer(page);
  const result = await page.evaluate(() => {
    const map = window.__ATW_TEST__.buildPageMap();
    const pick = (domId) => {
      const element = document.getElementById(domId);
      const observationNodeId = element?.dataset?.atwElementId || "";
      const observationControlId = element?.dataset?.atwControlId || "";
      return map.controls.find((control) =>
        (observationControlId && control.controlId === observationControlId)
        || control.stateElementId === observationNodeId
        || control.preferredActivationElementId === observationNodeId
        || (control.actuators || []).some((actuator) => actuator.nodeId === observationNodeId)
      );
    };
    const summarize = (control) => control && ({
      controlId: control.controlId,
      decisionGroupId: control.decisionGroupId,
      semantic: control.semantic,
      risk: control.risk,
      members: [control.stateElementId, control.preferredActivationElementId, ...(control.actuators || []).map((item) => item.nodeId)].filter(Boolean)
    });
    return {
      decline: summarize(pick("bag-decline")),
      paid: summarize(pick("bag-paid")),
      tiny: summarize(pick("tiny-seat-helper")),
      next: summarize(pick("real-next")),
      surfaceOptionLabels: (map.activeSurface?.options || []).map((item) => item.label),
      graphIntegrity: map.graphIntegrity
    };
  });

  expect(result.decline).toBeTruthy();
  expect(result.paid).toBeTruthy();
  expect(result.decline.controlId).not.toBe(result.paid.controlId);
  expect(result.decline.members.filter((id) => result.paid.members.includes(id))).toEqual([]);
  expect(result.decline.risk).not.toBe("paid");
  expect(result.paid.risk).toBe("money");
  expect(result.tiny).toBeFalsy();
  expect(result.surfaceOptionLabels).not.toContain("Skip seat selection");
  expect(result.next).toBeTruthy();
  expect(result.graphIntegrity.ok).toBe(true);
});

test("P0.9 observation identity rekeys cloned DOM IDs and excludes auxiliary footer links", async ({ page }) => {
  await loadProducer(page);
  const result = await page.evaluate(() => {
    const map = window.__ATW_TEST__.buildPageMap();
    const appStore = document.getElementById("app-store-link");
    const playStore = document.getElementById("play-store-link");
    return {
      appStoreElementId: appStore?.dataset?.atwElementId || "",
      playStoreElementId: playStore?.dataset?.atwElementId || "",
      controlLabels: (map.controls || []).map((control) => control.label),
      buttonLabels: (map.buttons || []).map((button) => button.label),
      graphIntegrity: map.graphIntegrity
    };
  });

  expect(result.appStoreElementId).toBeTruthy();
  expect(result.playStoreElementId).toBeTruthy();
  expect(result.appStoreElementId).not.toBe(result.playStoreElementId);
  expect(result.controlLabels).not.toContain("Download the app from the App Store");
  expect(result.controlLabels).not.toContain("Download the app from Google Play");
  expect(result.buttonLabels).not.toContain("Download the app from the App Store");
  expect(result.buttonLabels).not.toContain("Download the app from Google Play");
  expect(result.graphIntegrity.ok).toBe(true);
  expect(result.graphIntegrity.unresolvedConflictCount).toBe(0);
  expect(result.graphIntegrity.duplicateElementRekeyCount).toBe(2);
});

test("P0.9 canonical identity survives layout movement", async ({ page }) => {
  await loadProducer(page);
  const identities = await page.evaluate(() => {
    const ids = () => {
      const map = window.__ATW_TEST__.buildPageMap();
      return Object.fromEntries(map.controls
        .filter((control) => ["I'll go without", "Add 23 kg — 44 EUR", "Next"].includes(control.label))
        .map((control) => [control.label, control.controlId]));
    };
    const before = ids();
    document.body.style.paddingTop = "137px";
    document.getElementById("bag-modal").style.transform = "translate(73px, 41px)";
    window.scrollTo(0, 300);
    const after = ids();
    return { before, after };
  });

  expect(identities.after).toEqual(identities.before);
});

test("P0.3 material observation hash ignores validation prose and layout but changes with foreground state", async ({ page }) => {
  await loadProducer(page);
  const hashes = await page.evaluate(() => {
    const beforeMap = window.__ATW_TEST__.buildPageMap();
    const before = window.__ATW_TEST__.observationHashForMap(beforeMap);

    const validation = document.createElement("p");
    validation.id = "harmless-validation-copy";
    validation.setAttribute("role", "alert");
    validation.textContent = "Please review the highlighted information before continuing.";
    document.querySelector("main").prepend(validation);
    document.body.style.paddingTop = "91px";
    document.getElementById("bag-modal").style.transform = "translate(42px, 17px)";
    const harmlessMap = window.__ATW_TEST__.buildPageMap();
    const harmless = window.__ATW_TEST__.observationHashForMap(harmlessMap);

    document.getElementById("bag-modal").style.display = "none";
    const materialMap = window.__ATW_TEST__.buildPageMap();
    const material = window.__ATW_TEST__.observationHashForMap(materialMap);
    return { before, harmless, material };
  });

  expect(hashes.harmless).toBe(hashes.before);
  expect(hashes.material).not.toBe(hashes.before);
});

test("P0.3 client loop is single-flight and coalesces duplicate triggers", async ({ page }) => {
  await loadProducer(page);
  const result = await page.evaluate(() => {
    const hooks = window.__ATW_TEST__;
    hooks.setAgentRunningForTest(true);
    hooks.resetAgentLoopLifecycle("test_start");
    const first = hooks.beginAgentLoop();
    const duplicate = hooks.beginAgentLoop();
    const whileBusy = hooks.agentLoopState();
    const shouldRerun = hooks.finishAgentLoop(first);
    const afterFinish = hooks.agentLoopState();
    const next = hooks.beginAgentLoop();
    const nextState = hooks.agentLoopState();
    hooks.setAgentRunningForTest(false);
    hooks.finishAgentLoop(next);
    return {
      first,
      duplicate,
      whileBusy,
      shouldRerun,
      afterFinish,
      next,
      nextState
    };
  });

  expect(result.first).toBeTruthy();
  expect(result.duplicate).toBeNull();
  expect(result.whileBusy.loopBusy).toBe(true);
  expect(result.whileBusy.loopRerunQueued).toBe(true);
  expect(result.shouldRerun).toBe(true);
  expect(result.afterFinish.loopBusy).toBe(false);
  expect(result.afterFinish.loopRerunQueued).toBe(false);
  expect(result.next).toBeTruthy();
  expect(result.next.loopRunId).toBeGreaterThan(result.first.loopRunId);
  expect(result.nextState.loopBusy).toBe(true);
});

test("P0.9 registry replacement updates ownership without rekeying the physical actuator", async ({ page }) => {
  await loadProducer(page);
  const result = await page.evaluate(() => {
    const registry = window.__ATW_TEST__.createObservationControlRegistry();
    const node = document.getElementById("bag-decline");
    const background = registry.register(node, { sectionId: "background", sectionType: "baggage", sectionLabel: "Background baggage" }, 10);
    const foreground = registry.register(node, {
      surface: { id: "bag-modal", type: "modal", label: "Checked baggage", taskHint: "baggage", decisionGroupId: "dg_foreground_baggage" }
    }, 100);
    return {
      backgroundId: background.controlId,
      foregroundId: foreground.controlId,
      ownerId: registry.lookupElement(node)?.controlId || "",
      ownerSurfaceId: registry.lookupElement(node)?.surfaceId || "",
      ownerDecisionGroupId: registry.lookupElement(node)?.decisionGroupId || "",
      controlIds: registry.controls().map((control) => control.controlId),
      datasetId: node.dataset.atwControlId || "",
      conflicts: registry.conflicts
    };
  });

  expect(result.foregroundId).toBe(result.backgroundId);
  expect(result.ownerId).toBe(result.foregroundId);
  expect(result.datasetId).toBe(result.foregroundId);
  expect(result.ownerSurfaceId).toBe("bag-modal");
  expect(result.ownerDecisionGroupId).toBe("dg_foreground_baggage");
  expect(result.controlIds).toContain(result.foregroundId);
  expect(result.controlIds.filter((controlId) => controlId === result.foregroundId)).toHaveLength(1);
  expect(result.conflicts).toHaveLength(0);
});

test("P0.9 executor refuses label-only mutation and P1.4 progress cannot override exact verification", async ({ page }) => {
  await loadProducer(page);
  const result = await page.evaluate(() => {
    const map = window.__ATW_TEST__.buildPageMap();
    const canonical = map.controls.find((control) => control.label === "I'll go without");
    const labelOnly = window.__ATW_TEST__.resolveDecisionTarget({ action: "click", targetLabel: "I'll go without" }, map);
    const resolved = window.__ATW_TEST__.resolveDecisionTarget({ action: "click", controlId: canonical.controlId, targetLabel: canonical.label }, map);
    const merged = window.__ATW_TEST__.withOverlayProgressEvidence(
      { ok: false, code: "ACTIVE_SURFACE_NOT_DISMISSED", message: "Modal is still active.", evidence: { surfaceId: "bag-modal" } },
      { ok: true, reason: "content_changed" }
    );
    return {
      labelOnlyResolved: Boolean(labelOnly),
      canonicalResolvedId: resolved?.dataset?.atwElementId || "",
      canonicalMemberIds: [canonical.stateElementId, canonical.preferredActivationElementId, ...(canonical.actuators || []).map((item) => item.nodeId)].filter(Boolean),
      merged
    };
  });

  expect(result.labelOnlyResolved).toBe(false);
  expect(result.canonicalMemberIds).toContain(result.canonicalResolvedId);
  expect(result.merged.ok).toBe(false);
  expect(result.merged.code).toBe("ACTIVE_SURFACE_NOT_DISMISSED");
  expect(result.merged.evidence.overlayProgress).toEqual({ ok: true, reason: "content_changed" });
});

test("P0.4 type resolves the editable state member and survives a controlled-input rerender", async ({ page }) => {
  await loadProducer(page);
  const result = await page.evaluate(async () => {
    const hooks = window.__ATW_TEST__;
    hooks.setAppDataForTest({
      travelers: [{ id: "trav_test", first_name: "Ali", last_name: "Test", booking_rules: "No paid extras" }],
      preferences: {}
    }, "trav_test");
    const beforeMap = hooks.buildPageMap();
    const input = document.getElementById("email-input");
    const label = document.getElementById("email-label");
    const control = beforeMap.controls.find((item) => item.stateElementId === input.dataset.atwElementId);
    const decision = {
      action: "type",
      controlId: control.controlId,
      targetId: label.dataset.atwElementId,
      targetSnapshot: {
        controlId: control.controlId,
        id: label.dataset.atwElementId,
        stateElementId: control.stateElementId,
        preferredActivationElementId: control.preferredActivationElementId
      }
    };
    const resolved = hooks.resolveDecisionTarget(decision, beforeMap);
    input.addEventListener("blur", () => {
      const replacement = input.cloneNode(true);
      replacement.value = input.value;
      input.replaceWith(replacement);
    }, { once: true });
    const fill = await hooks.setFieldValue(resolved, "ali@example.com", {
      fieldType: "email",
      resolveLiveElement: () => {
        const currentMap = hooks.buildPageMap();
        return hooks.resolveDecisionTarget({ action: "type", controlId: control.controlId }, currentMap);
      }
    });
    const liveInput = document.getElementById("email-input");
    return {
      resolvedTag: resolved?.tagName || "",
      resolvedId: resolved?.id || "",
      labelId: label.id,
      fill,
      liveValue: liveInput?.value || "",
      replaced: liveInput !== input
    };
  });

  expect(result.resolvedTag).toBe("INPUT");
  expect(result.resolvedId).not.toBe(result.labelId);
  expect(result.replaced).toBe(true);
  expect(result.fill.ok).toBe(true);
  expect(result.liveValue).toBe("ali@example.com");
});

test("P0.9 does not publish a combobox input as its opener without a proven actuator", async ({ page }) => {
  await loadProducer(page, profileFixturePath);
  const result = await page.evaluate(() => {
    window.__ATW_TEST__.setAppDataForTest({
      travelers: [{ id: "trav_test", first_name: "Ali", last_name: "Test", booking_rules: "No paid extras" }],
      preferences: {}
    }, "trav_test");
    document.getElementById("country-code-arrow")?.remove();
    const map = window.__ATW_TEST__.buildPageMap();
    const control = map.controls.find((item) => item.label === "Country code" || item.semantic === "phone_country_code");
    return {
      controlFound: Boolean(control),
      openOperation: control?.operations?.open || null,
      openRecovery: control?.recovery?.open || null
    };
  });

  expect(result.controlFound).toBe(true);
  expect(result.openOperation).toBeNull();
  expect(result.openRecovery?.status).toBe("unproven");
  expect(result.openRecovery?.regions?.length).toBeGreaterThan(0);
});

test("P0.9 generic graph recognizes an icon-only pointer actuator as the combobox opener", async ({ page }) => {
  await loadProducer(page, profileFixturePath);
  const result = await page.evaluate(() => {
    window.__ATW_TEST__.setAppDataForTest({
      travelers: [{ id: "trav_test", first_name: "Ali", last_name: "Test", booking_rules: "No paid extras" }],
      preferences: {}
    }, "trav_test");
    const button = document.getElementById("country-code-arrow");
    const icon = document.createElement("div");
    icon.id = "country-code-icon";
    icon.className = "country-arrow";
    icon.style.cursor = "pointer";
    icon.textContent = "⌄";
    button.replaceWith(icon);
    const map = window.__ATW_TEST__.buildPageMap();
    const control = map.controls.find((item) => item.label === "Country code" || item.semantic === "phone_country_code");
    return {
      actuatorId: control?.operations?.open?.actuatorId || "",
      iconElementId: icon.dataset.atwElementId || ""
    };
  });

  expect(result.iconElementId).not.toBe("");
  expect(result.actuatorId).toBe(result.iconElementId);
});

test("P0 scoped validation publishes canonical control and section ownership", async ({ page }) => {
  await loadProducer(page, profileFixturePath);
  const result = await page.evaluate(() => {
    window.__ATW_TEST__.setAppDataForTest({
      travelers: [{ id: "trav_validation", gender: "male", booking_rules: "No paid extras" }],
      preferences: {}
    }, "trav_validation");
    const phone = document.getElementById("phone");
    const phoneError = document.createElement("div");
    phoneError.id = "phone-error";
    phoneError.setAttribute("role", "alert");
    phoneError.textContent = "Mobile number is invalid";
    phone.setAttribute("aria-errormessage", phoneError.id);
    phone.closest("label").appendChild(phoneError);

    const baggageSection = document.createElement("section");
    baggageSection.innerHTML = "<h2>Checked baggage</h2><div id='baggage-error'>Baggage selection is invalid</div>";
    document.body.appendChild(baggageSection);

    const map = window.__ATW_TEST__.buildPageMap();
    const phoneControl = map.controls.find((control) => control.semantic === "phone");
    const phoneIssue = map.validationIssues.find((issue) => issue.controlId === phoneControl?.controlId && /mobile number is invalid/i.test(issue.message));
    const baggageIssue = map.validationIssues.find((issue) => /baggage selection is invalid/i.test(issue.message));
    return { phoneControl, phoneIssue, baggageIssue };
  });

  expect(result.phoneIssue.controlId).toBe(result.phoneControl.controlId);
  expect(result.phoneIssue.sectionType).toBe("contact");
  expect(result.phoneIssue.stageWide).toBe(false);
  expect(result.baggageIssue.controlId).toBe("");
  expect(result.baggageIssue.sectionType).toBe("baggage");
  expect(result.baggageIssue.stageWide).toBe(false);
});

test("P0.7 scroll recovery uses the nearest effective container and fails closed for a missing target", async ({ page }) => {
  await page.setContent(`
    <style>
      body { margin: 0; height: 100vh; overflow: hidden; }
      #nested-scroll { height: 120px; overflow-y: auto; border: 1px solid black; }
      #spacer { height: 520px; }
    </style>
    <div id="nested-scroll">
      <div id="spacer"></div>
      <button id="nested-target" type="button">Continue</button>
    </div>
  `);
  await page.evaluate(() => { window.__ATW_ENABLE_TEST_HOOKS__ = true; });
  await page.addScriptTag({ path: contentScriptPath });
  await page.waitForFunction(() => Boolean(window.__ATW_TEST__));

  const result = await page.evaluate(async () => {
    const hooks = window.__ATW_TEST__;
    const scroller = document.getElementById("nested-scroll");
    const target = document.getElementById("nested-target");
    const beforeMap = hooks.buildPageMap();
    const beforeControl = beforeMap.controls.find((control) => /continue/i.test(control.label || ""));
    const beforeWindow = window.scrollY;
    const nearest = hooks.nearestEffectiveScrollContainer(target);
    const ungoverned = hooks.scrollElementWithinNearestContainer(target, { behavior: "auto" });
    const afterUngoverned = scroller.scrollTop;
    const dispatched = hooks.scrollElementWithinNearestContainer(target, {
      behavior: "auto",
      authority: "governed_executor"
    });
    const settled = await hooks.waitForScrollSettle(target, { container: dispatched.container });
    const afterMap = hooks.buildPageMap();
    const afterControl = afterMap.controls.find((control) => control.controlId === beforeControl?.controlId);
    const afterNested = scroller.scrollTop;
    const afterWindow = window.scrollY;
    target.remove();
    const missing = hooks.scrollElementWithinNearestContainer(null, {
      behavior: "auto",
      authority: "governed_executor"
    });
    return {
      nearestId: nearest.id,
      canonicalVisibility: {
        before: beforeControl?.visualRegion?.inViewport,
        after: afterControl?.visualRegion?.inViewport
      },
      ungoverned: { ok: ungoverned.ok, code: ungoverned.code, afterUngoverned },
      dispatched: {
        ok: dispatched.ok,
        code: dispatched.code,
        containerId: dispatched.containerId,
        containerType: dispatched.containerType
      },
      beforeWindow,
      afterNested,
      afterWindow,
      settled,
      missing
    };
  });

  expect(result.nearestId).toBe("nested-scroll");
  expect(result.canonicalVisibility).toEqual({ before: false, after: true });
  expect(result.ungoverned).toEqual({ ok: false, code: "UNGOVERNED_SCROLL_BLOCKED", afterUngoverned: 0 });
  expect(result.dispatched.containerType).toBe("element");
  expect(result.afterNested).toBeGreaterThan(0);
  expect(result.afterWindow).toBe(result.beforeWindow);
  expect(result.settled.settled).toBe(true);
  expect(result.missing.ok).toBe(false);
  expect(result.missing.code).toBe("TARGET_DISAPPEARED");
});

test("P0.7/P0.9 canonical alias index resolves every present control member and visual ID", async ({ page }) => {
  await loadProducer(page);
  const result = await page.evaluate(() => {
    const map = window.__ATW_TEST__.buildPageMap();
    const canonical = map.controls.find((control) => control.label === "I'll go without");
    canonical.visualRef = "O99";
    map.screenshotAnnotations = [{
      visualRef: "O99",
      targetId: canonical.preferredActivationElementId,
      controlId: canonical.controlId
    }];
    const index = window.__ATW_TEST__.buildCanonicalAliasIndex(map);
    const aliases = [
      canonical.controlId,
      canonical.stateElementId,
      canonical.preferredActivationElementId,
      ...(canonical.actuators || []).map((actuator) => actuator.nodeId),
      canonical.visualRef
    ].filter((aliasId, position, list) => aliasId && list.indexOf(aliasId) === position);
    return {
      canonicalControlId: canonical.controlId,
      resolutions: aliases.map((aliasId) => ({
        aliasId,
        kind: index.aliasKinds.get(aliasId) || "",
        controlId: index.resolve(aliasId)?.controlId || "",
        resolvedElementId: window.__ATW_TEST__.resolveDecisionTarget({ action: "click", targetId: aliasId }, map)?.dataset?.atwElementId || ""
      })),
      conflicts: index.conflicts
    };
  });

  expect(result.conflicts).toEqual([]);
  // A plain button has one physical actuator, so its canonical ID, actuator
  // ID, and visual ref are the complete alias set. Composite controls add
  // state, label, wrapper, and activation aliases to the same index.
  expect(result.resolutions.length).toBeGreaterThanOrEqual(3);
  for (const resolution of result.resolutions) {
    expect(resolution.controlId, resolution.aliasId).toBe(result.canonicalControlId);
    expect(resolution.resolvedElementId, resolution.aliasId).toBeTruthy();
  }
});

test("P0.7/P0.9 executor preserves canonical semantic authority through live label drift", async ({ page }) => {
  await loadProducer(page);
  const result = await page.evaluate(() => {
    const hooks = window.__ATW_TEST__;
    const map = hooks.buildPageMap();
    const control = map.controls.find((item) => item.label === "I'll go without");
    const element = document.getElementById("bag-decline");
    const originalSemantic = control.semantic;
    const originalRisk = control.risk;
    element.textContent = "Continue without this option";
    const live = hooks.liveTargetSnapshot(element, map);
    const validation = hooks.validateResolvedTarget({
      action: "click",
      controlId: control.controlId,
      targetId: control.preferredActivationElementId || control.stateElementId,
      targetSnapshot: {
        id: control.preferredActivationElementId || control.stateElementId,
        controlId: control.controlId,
        decisionGroupId: control.decisionGroupId,
        semantic: originalSemantic,
        risk: originalRisk,
        surfaceId: control.surfaceId,
        surfaceType: control.surfaceType,
        stateElementId: control.stateElementId,
        preferredActivationElementId: control.preferredActivationElementId,
        actuators: control.actuators,
        label: control.label,
        normalizedLabel: control.label.toLowerCase()
      }
    }, element, map);
    return { originalSemantic, originalRisk, live, validation };
  });

  expect(result.live.semantic).toBe(result.originalSemantic);
  expect(result.live.risk).toBe(result.originalRisk);
  expect(result.validation.ok).toBe(true);
  expect(result.validation.code || "").not.toMatch(/TARGET_(INTENT|SEMANTIC|RISK)_MISMATCH/);
});

test("P1.4 Next treats an unexpected popup as verified intermediate progress with concise feedback", async ({ page }) => {
  await loadHtmlProducer(page, `
    <main>
      <h1>Reserve seating</h1>
      <p>Flight 1 of 2</p>
      <button id="seat-next" type="button">Next</button>
    </main>
    <section id="seat-confirm" role="dialog" aria-modal="true" aria-labelledby="seat-confirm-title" hidden>
      <h2 id="seat-confirm-title">Continue without seats?</h2>
      <button id="seat-without" type="button">Continue without seats</button>
    </section>
    <script>
      document.getElementById("seat-next").addEventListener("click", () => {
        document.getElementById("seat-confirm").hidden = false;
      });
    </script>
  `);

  const result = await page.evaluate(async () => {
    const hooks = window.__ATW_TEST__;
    const before = hooks.buildPageMap();
    const target = document.getElementById("seat-next");
    const control = before.controls.find((item) => /next/i.test(item.label || ""));
    const expected = {
      type: "stage_exit_or_feedback",
      targetId: control.preferredActivationElementId || control.stateElementId,
      controlId: control.controlId,
      intent: "navigate_stage"
    };
    hooks.userLikeClick(target);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const after = hooks.buildPageMap();
    const verification = hooks.verifyExpectedOutcome(expected, before, after, target);
    const executionResult = hooks.rememberActionExecutionResult(
      "act_seat_next_popup",
      "obs_seat_before_popup",
      {
        actionId: "act_seat_next_popup",
        observationId: "obs_seat_before_popup",
        action: "click",
        intent: "navigate_stage",
        controlId: control.controlId,
        targetId: expected.targetId
      },
      expected,
      verification
    );
    return {
      verification,
      feedback: executionResult.feedback,
      surface: after.currentSurface || after.activeSurface
    };
  });

  expect(result.verification.ok).toBe(true);
  expect(result.verification.code).toBe("NAVIGATION_POPUP_APPEARED");
  expect(result.surface.label).toContain("Continue without seats");
  expect(result.feedback).toMatchObject({
    dispatched: true,
    targetFound: true,
    dispatchSucceeded: true,
    targetReacted: true,
    surfaceChanged: true,
    overlayAppeared: true,
    navigationOccurred: false,
    priceChanged: false,
    outcomeVerified: true
  });
});

test("stale modal history cannot target the new flexible-ticket dropdown", async ({ page }) => {
  await loadHtmlProducer(page, `
    <style>
      body { font-family: sans-serif; margin: 12px; }
      section { margin: 10px 0; padding: 8px; border: 1px solid #bbb; }
      label, button { display: inline-block; min-height: 34px; padding: 7px 10px; }
      #bag-confirm { position: fixed; inset: 70px auto auto 120px; width: 420px; padding: 20px; background: white; border: 2px solid #222; z-index: 50; }
      #flex-options { position: fixed; left: 30px; top: 120px; width: 280px; padding: 8px; background: white; border: 2px solid #444; z-index: 60; }
      [hidden] { display: none !important; }
    </style>
    <main>
      <h1>Choose trip options</h1>
      <section id="baggage" aria-labelledby="baggage-title">
        <h2 id="baggage-title">Checked baggage</h2>
        <label><input id="bag-paid-choice" type="radio" name="baggage" value="paid"> Add 23 kg — 44 EUR</label>
        <label><input id="bag-free-choice" type="radio" name="baggage" value="none" required> No checked baggage</label>
      </section>
      <section id="bundle" aria-labelledby="bundle-title">
        <h2 id="bundle-title">Choose your bundle</h2>
        <label><input id="bundle-paid" type="radio" name="bundle" value="premium"> Premium bundle — 39 EUR</label>
        <label><input id="bundle-free" type="radio" name="bundle" value="none" required> No, thanks</label>
      </section>
      <section id="flexible" aria-labelledby="flex-title">
        <h2 id="flex-title">Flexible Ticket</h2>
        <p>Select one option</p>
        <button id="flex-opener" type="button" role="combobox" aria-label="Flexible Ticket" aria-haspopup="listbox" aria-controls="flex-options" aria-expanded="false">Select one option</button>
      </section>
      <button id="continue" type="button">Continue</button>
    </main>
    <section id="bag-confirm" role="dialog" aria-modal="true" aria-labelledby="bag-confirm-title" hidden>
      <h2 id="bag-confirm-title">Travel without checked baggage?</h2>
      <button id="bag-without" type="button">I'll go without</button>
      <button id="bag-add" type="button">Add baggage — 44 EUR</button>
    </section>
    <div id="flex-options" role="listbox" aria-label="Flexible Ticket options" hidden>
      <button id="flex-none" type="button" role="option" data-value="none">None of the passengers</button>
      <button id="flex-paid" type="button" role="option" data-value="all">All passengers — 29 EUR</button>
    </div>
    <script>
      (() => {
        const bagFree = document.getElementById("bag-free-choice");
        const modal = document.getElementById("bag-confirm");
        const opener = document.getElementById("flex-opener");
        const options = document.getElementById("flex-options");
        bagFree.addEventListener("click", () => { modal.hidden = false; });
        document.getElementById("bag-without").addEventListener("click", () => { modal.hidden = true; });
        opener.addEventListener("click", () => {
          options.hidden = false;
          opener.setAttribute("aria-expanded", "true");
        });
        options.addEventListener("click", (event) => {
          const option = event.target.closest("[role='option']");
          if (!option) return;
          opener.textContent = option.textContent;
          opener.dataset.selectedValue = option.dataset.value;
          opener.setAttribute("aria-expanded", "false");
          options.hidden = true;
        });
        document.getElementById("continue").addEventListener("click", () => {
          document.body.dataset.stage = "continued";
          document.querySelector("h1").textContent = "Payment review";
          document.getElementById("continue").hidden = true;
        });
      })();
    </script>
  `);

  const store = inMemoryGovernorStore();
  let state = createCheckoutSessionState({
    goal: "Complete safe trip options",
    travelerId: "trav_candidate_replay",
    site: { host: "example.test", url: page.url() }
  });
  state.id = "txn_candidate_replay";
  state.approvals.skipPaidExtrasApproved = true;
  const traveler = { id: "trav_candidate_replay", booking_rules: "no paid extras" };
  const history = [];

  const prepare = (observation) => {
    const requirements = loopPrivate.requirementsWithDecisionGroups([], observation);
    const goal = deriveObservationGoal(observation, requirements);
    const candidateSet = loopPrivate.groundedObservationCandidateSet(goal, observation);
    const candidates = candidateSet.candidates;
    state = {
      ...state,
      currentObservation: {
        observationId: observation.observationId,
        observationHash: observation.observationSnapshot.snapshotHash
      },
      currentGoal: { ...goal, label: goal.semanticGoal, candidateSet, candidates },
      requirements,
      activeRequirements: requirements
    };
    store.remember(state.id, observation);
    return { goal, candidateSet, candidates };
  };

  const executeCandidate = async (observation, matcher, nextObservationId) => {
    const prepared = prepare(observation);
    const candidate = prepared.candidates.find(matcher);
    expect(candidate, `candidate for ${prepared.goal.semanticGoal}`).toBeTruthy();
    const action = loopPrivate.bindTargetSnapshot(
      actionForObservationCandidate(prepared.goal, candidate, observation),
      observation
    );
    const governed = governAction({ action, state, observation, traveler, store, turnId: nextObservationId });
    expect(governed.allow, `${governed.code}: ${governed.reason}`).toBe(true);
    state = governed.state || state;
    const executed = await executeAtomicBrowserDecision(page, toClientDecision(action), nextObservationId);
    expect(executed.validation.ok, executed.validation.code).toBe(true);
    expect(executed.verification.ok, JSON.stringify(executed.verification)).toBe(true);
    history.push({
      goal: prepared.goal.semanticGoal,
      action: candidate.summary,
      verified: executed.result.verified,
      outcome: executed.result.outcome?.message || executed.result.outcome?.code,
      type: candidate.type,
      candidateId: candidate.candidateId,
      controlId: candidate.controlId,
      targetId: candidate.targetId,
      targetSnapshot: action.targetSnapshot
    });
    return { ...executed, action, candidate, goal: prepared.goal };
  };

  let observation = await browserObservation(page, "obs_replay_baggage");
  const baggage = await executeCandidate(
    observation,
    (candidate) => /no checked baggage/i.test(candidate.targetLabel),
    "obs_replay_bag_modal"
  );
  observation = baggage.observation;
  expect(observation.page.activeSurface?.type || observation.page.currentSurface?.type).toBe("modal");

  const modalDecline = await executeCandidate(
    observation,
    (candidate) => /go without/i.test(candidate.targetLabel),
    "obs_replay_bundle"
  );
  const obsoleteModalCandidate = modalDecline.candidate;
  const obsoleteModalAction = modalDecline.action;
  observation = modalDecline.observation;
  expect(observation.page.activeSurface?.type || observation.page.currentSurface?.type || "page").not.toBe("modal");

  const bundle = await executeCandidate(
    observation,
    (candidate) => /no,? thanks/i.test(candidate.targetLabel),
    "obs_replay_flexible_closed"
  );
  observation = bundle.observation;

  const semanticHistory = sanitizedActionHistory(history);
  expect(semanticHistory).toHaveLength(3);
  expect(JSON.stringify(semanticHistory)).not.toContain(obsoleteModalCandidate.controlId);
  expect(JSON.stringify(semanticHistory)).not.toContain(obsoleteModalCandidate.targetId);

  const flexiblePrepared = prepare(observation);
  expect(
    flexiblePrepared.goal.semanticGoal,
    JSON.stringify({
      groups: observation.page.decisionGroups,
      controls: observation.page.controls?.map((control) => ({
        controlId: control.controlId,
        label: control.label,
        role: control.role,
        sectionType: control.sectionType,
        operations: control.operations
      }))
    })
  ).toBe("decline flexible ticket");
  expect(flexiblePrepared.candidates.some((candidate) => candidate.candidateId === obsoleteModalCandidate.candidateId)).toBe(false);
  expect(flexiblePrepared.candidates.some((candidate) => candidate.controlId === obsoleteModalCandidate.controlId)).toBe(false);
  const staleProposal = loopPrivate.bindTargetSnapshot({
    ...obsoleteModalAction,
    id: "act_stale_modal_replay",
    observationId: observation.observationId,
    observationHash: observation.observationSnapshot.snapshotHash
  }, observation);
  const staleGovernance = governAction({ action: staleProposal, state, observation, traveler, store, turnId: "stale_replay" });
  expect(staleGovernance.allow).toBe(false);
  expect(staleGovernance.decision).toBe("recoverable");
  expect(staleGovernance.code).toMatch(/CANONICAL_ALIAS_UNRESOLVED|CURRENT_GOAL_CANDIDATE_MISMATCH/);
  const staleRecovery = loopPrivate.applyRecoveryBudget(state, {
    actionId: staleProposal.id,
    observationId: observation.observationId,
    dispatched: false,
    executed: false,
    verified: false,
    outcome: { code: staleGovernance.code }
  });
  expect(staleRecovery.classification).toBe("grounding_replan");
  expect(staleRecovery.groundingRecoveryAttempts).toBe(1);
  expect(staleRecovery.executionRecoveryAttempts).toBe(0);
  expect(staleRecovery.exhausted).toBe(false);
  state = staleRecovery.state;

  const currentOpenCandidate = flexiblePrepared.candidates.find((candidate) => (
    candidate.operation === "open" && /flexible ticket/i.test(candidate.targetLabel)
  ));
  expect(currentOpenCandidate).toBeTruthy();
  const flexibleWordingSelection = resolvePlannerSelection({
    candidateId: currentOpenCandidate.candidateId
  }, flexiblePrepared.candidateSet);
  expect(Object.keys(flexibleWordingSelection).sort()).toEqual(["candidate", "candidateId"]);
  expect(flexibleWordingSelection.candidateId).toBe(currentOpenCandidate.candidateId);
  expect(flexibleWordingSelection.candidate.operation).toBe("open");

  const opened = await executeCandidate(
    observation,
    (candidate) => candidate.candidateId === flexibleWordingSelection.candidateId,
    "obs_replay_flexible_open"
  );
  observation = opened.observation;
  expect(await page.locator("#flex-options").isVisible()).toBe(true);
  expect(history.filter((entry) => /open/i.test(entry.action || ""))).toHaveLength(1);

  const chosen = await executeCandidate(
    observation,
    (candidate) => /none of the passengers/i.test(candidate.targetLabel),
    "obs_replay_flexible_chosen"
  );
  observation = chosen.observation;
  expect(chosen.verification.code).toBe("EXACT_FREE_OPTION_VERIFIED");
  expect(chosen.verification.evidence.selectedControlId).toBe(chosen.verification.evidence.expectedControlId);
  expect(chosen.verification.evidence.semanticDispositionVerified).toBe(true);
  expect(chosen.verification.evidence.paidAlternativesSelected).toEqual([]);
  expect(chosen.verification.evidence.priceDidNotIncrease).toBe(true);
  expect(chosen.verification.evidence.ownedValidationErrors).toEqual([]);
  expect(await page.locator("#flex-options").isVisible()).toBe(false);
  expect(await page.locator("#flex-opener").textContent()).toContain("None of the passengers");

  await executeCandidate(
    observation,
    (candidate) => /continue/i.test(candidate.targetLabel),
    "obs_replay_continued"
  );
  expect(await page.locator("body").getAttribute("data-stage")).toBe("continued");
  expect(history.some((entry) => entry.type === "ask_user")).toBe(false);
});

test("oversized canonical transport automatically rebuilds smaller without dropping controls", async ({ page }) => {
  await loadHtmlProducer(page, `<main><h1>Seats</h1><button type="button">No thanks</button></main>`);
  let received = null;
  await page.route("**/api/agent/next-action", async (route) => {
    received = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true })
    });
  });
  const result = await page.evaluate(async (apiBase) => {
    const hooks = window.__ATW_TEST__;
    const controls = Array.from({ length: 350 }, (_, index) => ({
      controlId: `ctrl_${index}`,
      label: `Seat ${index}A`,
      kind: "radio",
      semantic: "seat_option",
      state: { selected: false }
    }));
    const payload = {
      sessionId: "session_transport_fallback",
      observationId: "obs_transport_fallback",
      observationSnapshot: { snapshotHash: "hash_transport_fallback" },
      page: {
        step: "seats",
        controls,
        sections: [{ id: "seat_section", controlIds: controls.map((control) => control.controlId) }],
        currentSurface: { id: "seat_surface", type: "modal", memberControlIds: controls.map((control) => control.controlId) },
        summary: { title: "x".repeat(5_600_000), priceText: "208 EUR" }
      }
    };
    const originalBytes = hooks.observationTransportBytes(payload);
    const posted = await hooks.postObservationWithSizeRecovery(apiBase, payload);
    return {
      originalBytes,
      sentBytes: posted.bytes,
      transportMode: posted.transportMode,
      response: await posted.response.json()
    };
  }, TEST_API);
  expect(result.originalBytes).toBeGreaterThan(5_500_000);
  expect(result.sentBytes).toBeLessThan(5_500_000);
  expect(result.transportMode).toBe("compact_retry");
  expect(result.response).toEqual({ ok: true });
  expect(received.page.controls).toHaveLength(350);
  expect(received.page.sections[0].controlIds).toHaveLength(350);
  expect(received.page.currentSurface.memberControlIds).toHaveLength(350);
  expect(received.page.summary.title).toHaveLength(200);
});

test("large canonical observation uploads screenshot separately and reaches a grounded backend action", async ({ page, request }) => {
  const seatCount = 320;
  await loadHtmlProducer(page, `
    <main>
      <h1>Traveller information</h1>
      <label>Email <input id="email" type="email" required></label>
      <section id="seat-map" aria-label="Large seat map">
        ${Array.from({ length: seatCount }, (_, index) => `<label><input id="seat-${index + 1}" type="radio" name="seat"> Seat ${index + 1}A — 18 EUR</label>`).join("")}
        <label><input id="seat-free" type="radio" name="seat"> No thanks</label>
        <button id="seat-next" type="button">Next</button>
      </section>
    </main>
  `);

  const traveler = {
    id: `trav_transport_${Date.now()}`,
    first_name: "Ali",
    last_name: "Sifrar",
    email: "ali@example.test",
    phone: "+38670328922",
    booking_rules: "No paid seats and no paid extras"
  };
  const started = await request.post(`${TEST_API}/agent/session`, {
    data: {
      goal: "Continue checkout safely",
      traveler,
      page: { site: "example.test", url: page.url(), step: "traveler_information" }
    }
  });
  expect(started.status()).toBe(201);
  const session = await started.json();

  const transport = await page.evaluate(async ({ apiBase, sessionId, traveler }) => {
    const hooks = window.__ATW_TEST__;
    const observationId = `obs_transport_${Date.now()}`;
    const map = hooks.buildPageMap();
    const annotations = hooks.prepareScreenshotAnnotations(map, observationId);
    const canonicalPage = hooks.compactPageMap(map);
    const screenshotDataUrl = `data:image/png;base64,${"a".repeat(400_000)}`;
    const screenshotId = await hooks.uploadObservationScreenshot(apiBase, {
      sessionId,
      observationId,
      screenshotDataUrl
    });
    const payload = {
      sessionId,
      clientTurnId: `turn_transport_${Date.now()}`,
      observationId,
      observationSnapshot: {
        ...hooks.mapObservationSnapshot(map),
        observationId,
        snapshotHash: hooks.observationHashForMap(map)
      },
      userIntent: "Continue checkout safely",
      traveler,
      approvalState: { skipPaidExtrasApproved: true, paymentApproved: false },
      actionHistory: [],
      lastActionResult: null,
      page: {
        ...canonicalPage,
        screenshotId,
        screenshotAnnotations: annotations.map((annotation) => ({
          visualRef: annotation.visualRef || "",
          controlId: annotation.controlId || "",
          decisionGroupId: annotation.decisionGroupId || "",
          box: annotation.box || null
        }))
      }
    };
    const bytes = hooks.observationTransportBytes(payload);
    const posted = await hooks.postObservationWithSizeRecovery(apiBase, payload);
    const decision = await posted.response.json();
    return {
      observationId,
      screenshotId,
      mapControlCount: map.controls.length,
      transportControlCount: canonicalPage.controls.length,
      bytes,
      transportMode: posted.transportMode,
      containsInlineScreenshot: JSON.stringify(payload).includes("data:image/png"),
      sectionUsesIdsOnly: canonicalPage.sections.every((section) => (
        Array.isArray(section.controlIds)
        && !("fields" in section)
        && !("choices" in section)
        && !("buttons" in section)
      )),
      surfaceUsesIdsOnly: Array.isArray(canonicalPage.currentSurface.memberControlIds)
        && !("options" in canonicalPage.currentSurface),
      decision
    };
  }, { apiBase: TEST_API, sessionId: session.id, traveler });

  expect(transport.mapControlCount).toBeGreaterThan(seatCount);
  expect(transport.transportControlCount).toBe(transport.mapControlCount);
  expect(transport.bytes).toBeLessThan(5_500_000);
  expect(transport.screenshotId).toMatch(/^shot_/);
  expect(transport.containsInlineScreenshot).toBe(false);
  expect(transport.sectionUsesIdsOnly).toBe(true);
  expect(transport.surfaceUsesIdsOnly).toBe(true);
  expect(transport.decision).toMatchObject({
    sessionId: session.id,
    observationId: transport.observationId,
    action: "type",
    intent: "satisfy_semantic_goal"
  });
  expect(transport.decision.candidateId).toBeTruthy();

  const transactionResponse = await request.get(`${TEST_API}/agent/transaction/${session.id}`);
  expect(transactionResponse.status()).toBe(200);
  const transaction = await transactionResponse.json();
  expect(transaction.currentObservation.page.controls).toHaveLength(transport.mapControlCount);
  expect(transaction.currentObservation.page.screenshotId).toBe(transport.screenshotId);
  expect(transaction.currentObservation.page.screenshotDataUrl).toBe("[redacted-persisted-separately]");
});

test("final safe checkout replay advances completed traveler through both seat legs to payment review", async ({ page }) => {
  await loadHtmlProducer(page, `
    <style>
      [hidden] { display: none !important; }
      section { margin: 12px; padding: 12px; border: 1px solid #aaa; }
      #seats { position: fixed; inset: 50px 100px auto; background: white; z-index: 20; }
    </style>
    <main>
      <h1 id="stage-title">Passenger information</h1>
      <p id="total-price">Total 208 EUR</p>
      <section id="traveler" aria-label="Passenger 1">
        <label>Email <input id="email" type="email" required value="ali@example.test"></label>
        <label>Confirm email <input id="confirm-email" type="email" required value="ali@example.test"></label>
        <label>Country code <input id="country" type="tel" required value="+386"></label>
        <label>Phone <input id="phone" type="tel" required value="70328922"></label>
        <label>First name <input id="first-name" required value="Ali"></label>
        <label>Last name <input id="last-name" required value="Sifrar"></label>
        <button id="traveler-continue" type="button">Continue</button>
      </section>
      <button id="background-help" type="button">Background help</button>
      <section id="later-offer" aria-label="Travel protection" hidden>
        <h2>Travel protection</h2>
        <label><input id="offer-paid" type="radio" name="offer"> Add protection — 25 EUR</label>
        <label><input id="offer-free" type="radio" name="offer" required> No protection</label>
        <button id="offer-continue" type="button">Continue</button>
      </section>
      <button id="pay-now" type="button" hidden>Pay now</button>
    </main>
    <section id="seats" role="dialog" aria-modal="true" aria-labelledby="seat-title" aria-owns="seat-footer" hidden>
      <h2 id="seat-title">Reserve seating</h2>
      <p id="seat-progress">Flight 1 of 2</p>
      <div id="seat-grid" aria-label="Seat map">
        ${Array.from({ length: 24 }, (_, index) => `<button id="seat-${index + 1}" type="button">Seat ${index + 1} — 18 EUR</button>`).join("")}
      </div>
    </section>
    <div id="seat-footer" role="group" aria-label="Seat selection actions" hidden>
      <label><input id="seat-free" type="radio" name="seat" required> No thanks</label>
      <button id="seat-next" type="button">Next</button>
    </div>
    <script>
      (() => {
        let flight = 1;
        const traveler = document.getElementById("traveler");
        const seats = document.getElementById("seats");
        const seatFooter = document.getElementById("seat-footer");
        const freeSeat = document.getElementById("seat-free");
        const offer = document.getElementById("later-offer");
        document.getElementById("traveler-continue").addEventListener("click", () => {
          traveler.hidden = true;
          seats.hidden = false;
          seatFooter.hidden = false;
          document.getElementById("stage-title").textContent = "Seats";
        });
        document.getElementById("seat-next").addEventListener("click", () => {
          if (!freeSeat.checked) return;
          if (flight === 1) {
            flight = 2;
            freeSeat.checked = false;
            document.getElementById("seat-progress").textContent = "Flight 2 of 2";
          } else {
            seats.hidden = true;
            seatFooter.hidden = true;
            offer.hidden = false;
            document.getElementById("stage-title").textContent = "Optional offers";
          }
        });
        document.getElementById("offer-continue").addEventListener("click", () => {
          if (!document.getElementById("offer-free").checked) return;
          offer.hidden = true;
          document.getElementById("stage-title").textContent = "Payment review";
          document.getElementById("pay-now").hidden = false;
          document.body.dataset.stage = "payment-review";
        });
      })();
    </script>
  `);

  const store = inMemoryGovernorStore();
  let state = createCheckoutSessionState({
    goal: "Reach payment review without paid extras",
    travelerId: "trav_final_replay",
    site: { host: "example.test", url: page.url() }
  });
  state.id = "txn_final_safe_replay";
  state.approvals.skipPaidExtrasApproved = true;
  const traveler = {
    id: "trav_final_replay",
    email: "ali@example.test",
    phone: "+38670328922",
    first_name: "Ali",
    last_name: "Sifrar",
    booking_rules: "no paid extras and no paid seats"
  };
  const actions = [];

  const execute = async (observation, matcher, nextObservationId) => {
    const requirements = loopPrivate.requirementsWithDecisionGroups([], observation);
    const goal = deriveObservationGoal(observation, requirements);
    const candidateSet = loopPrivate.groundedObservationCandidateSet(goal, observation);
    state = {
      ...state,
      currentGoal: { ...goal, label: goal.semanticGoal, candidateSet, candidates: candidateSet.candidates },
      currentObservation: { observationId: observation.observationId, observationHash: observation.observationSnapshot.snapshotHash },
      requirements,
      activeRequirements: requirements
    };
    store.remember(state.id, observation);
    const candidate = candidateSet.candidates.find(matcher);
    expect(candidate, JSON.stringify({ goal, candidates: candidateSet.candidates })).toBeTruthy();
    expect(candidate.risk).toBe("safe");
    expect(candidate.targetLabel).not.toMatch(/paid|pay now|\b\d+\s*EUR/i);
    expect(candidate.affordance?.stableKey).toBeTruthy();
    expect(candidate.affordance?.actuator?.proven).toBe(true);
    const action = loopPrivate.bindTargetSnapshot(actionForCurrentCandidate(goal, candidate, observation), observation);
    expect(action.affordance).toEqual(candidate.affordance);
    const governed = governAction({ action, state, observation, traveler, store, turnId: nextObservationId });
    expect(governed.allow, `${governed.code}: ${governed.reason}`).toBe(true);
    state = governed.state || state;
    const executed = await executeAtomicBrowserDecision(page, toClientDecision(action), nextObservationId);
    expect(executed.validation.ok, JSON.stringify({ validation: executed.validation, action, candidate })).toBe(true);
    expect(executed.result.dispatched).toBe(true);
    const transition = evaluateTransition({
      beforeObservation: observation,
      governedAction: action,
      browserResult: executed.result,
      afterObservation: executed.observation
    });
    expect(["achieved", "progressed", "blocked"]).toContain(transition.status);
    actions.push({
      actionId: action.id,
      plannedObservationId: action.observationId,
      resultObservationId: executed.observation.observationId,
      candidateId: candidate.candidateId,
      controlId: candidate.controlId,
      risk: candidate.risk,
      transitionStatus: transition.status,
      action
    });
    return executed.observation;
  };

  let observation = await browserObservation(page, "obs_final_traveler_complete");
  observation = await execute(observation, (candidate) => /continue/i.test(candidate.targetLabel), "obs_final_seat_1");
  expect(observation.page.currentSurface?.label).toContain("Reserve seating");
  expect(observation.page.controls.filter((control) => control.surfaceId === observation.page.currentSurface.id).length).toBeGreaterThan(20);
  const freeControl = observation.page.controls.find((control) => /no thanks/i.test(control.label));
  expect(freeControl).toBeTruthy();
  expect(freeControl.surfaceId).toBe(observation.page.currentSurface.id);
  expect(observation.page.currentSurface.memberControlIds).toContain(freeControl.controlId);

  const rejectionRequirements = loopPrivate.requirementsWithDecisionGroups([], observation);
  const rejectionGoal = deriveObservationGoal(observation, rejectionRequirements);
  const rejectionSet = loopPrivate.groundedObservationCandidateSet(rejectionGoal, observation);
  const currentFreeCandidate = rejectionSet.candidates.find((candidate) => /no thanks/i.test(candidate.targetLabel));
  expect(currentFreeCandidate.surfaceId).toBe(observation.page.currentSurface.id);
  const currentFreeAction = loopPrivate.bindTargetSnapshot(actionForCurrentCandidate(rejectionGoal, currentFreeCandidate, observation), observation);
  expect(currentFreeAction.targetSnapshot.surfaceId).toBe(observation.page.currentSurface.id);
  const backgroundControl = observation.page.controls.find((control) => /background help/i.test(control.label));
  expect(backgroundControl.surfaceId).toBe("surface-page");
  const wrongSurfaceAction = loopPrivate.bindTargetSnapshot({
    id: "act_wrong_surface_predispatch",
    observationId: observation.observationId,
    observationHash: observation.observationSnapshot.snapshotHash,
    type: "click",
    intent: "navigate_stage",
    operation: "activate",
    controlId: backgroundControl.controlId,
    targetId: backgroundControl.operations.activate.actuatorId,
    targetLabel: backgroundControl.label,
    expectedOutcome: { type: "observable_change", controlId: backgroundControl.controlId },
    risk: "safe",
    requiresApproval: false
  }, observation);
  const rejected = await executeAtomicBrowserDecision(page, toClientDecision(wrongSurfaceAction), "obs_final_seat_1_rejected");
  expect(rejected.result.dispatched).toBe(false);
  expect(rejected.validation.code).toBe("TARGET_OUTSIDE_CURRENT_SURFACE");
  const recovery = advanceActionLifecycle({
    state: { ...state, lastAction: wrongSurfaceAction, groundingRecoveryAttempts: 0, executionRecoveryAttempts: 0 },
    observation: rejected.observation,
    previousObservation: observation
  });
  expect(recovery.lifecycle.status).toBe("rejected_before_dispatch");
  expect(recovery.directive).toBe("rebuild_candidates");
  expect(recovery.state.groundingRecoveryAttempts).toBe(1);
  expect(recovery.state.executionRecoveryAttempts).toBe(0);
  expect(recovery.directive).not.toContain("handoff");
  observation = rejected.observation;
  observation = await execute(observation, (candidate) => /no thanks/i.test(candidate.targetLabel), "obs_final_seat_1_declined");
  observation = await execute(observation, (candidate) => /next/i.test(candidate.targetLabel), "obs_final_seat_2");
  expect(await page.locator("#seat-progress").textContent()).toContain("Flight 2 of 2");
  observation = await execute(observation, (candidate) => /no thanks/i.test(candidate.targetLabel), "obs_final_seat_2_declined");
  observation = await execute(observation, (candidate) => /next/i.test(candidate.targetLabel), "obs_final_offer");
  observation = await execute(observation, (candidate) => /no protection/i.test(candidate.targetLabel), "obs_final_offer_declined");
  await execute(observation, (candidate) => /continue/i.test(candidate.targetLabel), "obs_final_payment_review");

  expect(await page.locator("body").getAttribute("data-stage")).toBe("payment-review");
  expect(await page.locator("#pay-now").isVisible()).toBe(true);
  expect(actions).toHaveLength(7);
  expect(new Set(actions.map((entry) => entry.actionId)).size).toBe(actions.length);
  expect(new Set(actions.map((entry) => entry.candidateId)).size).toBe(actions.length);
  expect(actions.every((entry) => entry.plannedObservationId !== entry.resultObservationId)).toBe(true);
  expect(actions.every((entry) => entry.risk === "safe")).toBe(true);
});
