const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("@playwright/test");
const { governObservedAction: governAction } = require("./governance-test-helper");
const {
  selectNextProfileRequirement,
  profileGoalSatisfied,
  candidatesForProfileGoal
} = require("../../apps/web/agent/profile-mechanics");
const {
  fieldDescriptors,
  profileStageReadiness
} = require("../../apps/web/agent/profile-requirements");
const { runLoopTurn: runRawLoopTurn, toClientDecision: toRawClientDecision, __private: loopPrivate } = require("../../apps/web/agent/loop");
const { executableDecisionFromActionLease } = require("./action-lease-replay-adapter");
const { groundedObservationCandidateSet } = require("./legacy-mechanics-binding-adapter");
const {
  actionForObservationCandidate
} = require("./legacy-mechanics-binding-adapter");
const { deriveObservationGoal } = require("./legacy-observation-goal-adapter");
const { actionForCurrentCandidate, buildCurrentCandidateSet } = require("./legacy-mechanics-binding-adapter");
const actionForProfileCandidate = actionForCurrentCandidate;
const { advanceActionLifecycle, leasedActionRecord } = require("../../apps/web/agent/action-lifecycle");
const { leasedAction, recovery: executionRecovery, withExecutionFixture } = require("./execution-episode-test-adapter");
const { sanitizedActionHistory } = require("./legacy-model-context-adapter");
const { resolvePlannerSelection } = require("./legacy-planner-replay-adapter");
const { evaluateTransition } = require("../../apps/web/agent/transition-evaluator");
const { reduceTaskState } = require("./task-state-replay-adapter");
const { prepareTransactionInvariants } = require("../../apps/web/agent/invariants");
const { classifyObservationReadiness, READINESS } = require("../../apps/web/agent/observation-readiness");
const { resolveSemanticOwnership } = require("./legacy-semantic-ownership-adapter");
const { resolveLogicalFields, logicalFieldSatisfied } = require("../../apps/web/agent/logical-field");
const { createCheckoutSessionState } = require("../../packages/shared/agent-state");
const { actuatorSignature, semanticGoalKey } = require("../../packages/shared/agent-actions");
const { compileDecisionFrame, currentObligationFromGoal } = require("../../apps/web/agent/authority-frames");
const agentContract = require("../../apps/extension/src/shared/agent-contract");
const legacyRequirementReplay = require("./legacy-requirement-replay-adapter");

function deriveProfileGoal(observation = {}, profile = {}, currentGoal = null) {
  return selectNextProfileRequirement(observation, profile, currentGoal, []).goal;
}

function toClientDecision(action = {}) {
  return executableDecisionFromActionLease(toRawClientDecision(action));
}

async function runLoopTurn(args = {}) {
  const turn = await runRawLoopTurn(args);
  return {
    ...turn,
    clientDecision: executableDecisionFromActionLease(turn.clientDecision)
  };
}

const fixturePath = path.join(__dirname, "..", "fixtures", "semantic-controls", "seat-baggage.html");
const profileFixturePath = path.join(__dirname, "..", "fixtures", "semantic-controls", "profile-form.html");
const contractScriptPath = path.join(__dirname, "..", "..", "apps", "extension", "src", "shared", "agent-contract.js");
const contentScriptPath = path.join(__dirname, "..", "..", "apps", "extension", "src", "content", "content.js");
const TEST_API = `http://127.0.0.1:${Number(process.env.ATW_TEST_PORT || 4273)}/api`;

function verifiedTransactionReview(totalPrice = 208) {
  const transaction = {
    itinerary: {
      completeness: "complete",
      segments: [{ segmentId: "segment_1", origin: "LHR", destination: "LJU", departureDate: "2026-08-10" }]
    },
    travelers: [{ travelerId: "trav_replay", name: "Replay Traveler" }],
    currency: "EUR",
    totalPrice: { amount: totalPrice, currency: "EUR" },
    selectedExtras: []
  };
  return {
    ready: true,
    baselineStatus: "approved",
    missingFacts: [],
    contradictions: [],
    unauthorizedPaidExtras: [],
    baseline: transaction,
    current: transaction
  };
}

async function loadProducer(page, sourcePath = fixturePath) {
  await page.setContent(fs.readFileSync(sourcePath, "utf8"));
  await page.evaluate(() => { window.__ATW_ENABLE_TEST_HOOKS__ = true; });
  await page.addScriptTag({ path: contractScriptPath });
  await page.addScriptTag({ path: contentScriptPath });
  await page.evaluate(() => {
    window.__ATW_TEST_TRUSTED_INPUT__ = ({ element, x, y }) => {
      const eventInit = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 };
      element.dispatchEvent(new PointerEvent("pointerdown", { ...eventInit, buttons: 1 }));
      element.dispatchEvent(new MouseEvent("mousedown", { ...eventInit, buttons: 1 }));
      element.dispatchEvent(new PointerEvent("pointerup", { ...eventInit, buttons: 0 }));
      element.dispatchEvent(new MouseEvent("mouseup", { ...eventInit, buttons: 0 }));
      element.dispatchEvent(new MouseEvent("click", { ...eventInit, buttons: 0 }));
      return { ok: true };
    };
  });
  await page.waitForFunction(() => Boolean(window.__ATW_TEST__));
}

async function loadHtmlProducer(page, html) {
  await page.setContent(html);
  await page.evaluate(() => { window.__ATW_ENABLE_TEST_HOOKS__ = true; });
  await page.addScriptTag({ path: contractScriptPath });
  await page.addScriptTag({ path: contentScriptPath });
  // Browser replays do not run the extension service worker. Model its
  // governed pointer bridge here; production dispatch remains Chrome
  // Debugger Input.dispatchMouseEvent through the background worker.
  await page.evaluate(() => {
    window.__ATW_TEST_TRUSTED_INPUT__ = ({ element, x, y }) => {
      const eventInit = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 };
      element.dispatchEvent(new PointerEvent("pointerdown", { ...eventInit, buttons: 1 }));
      element.dispatchEvent(new MouseEvent("mousedown", { ...eventInit, buttons: 1 }));
      element.dispatchEvent(new PointerEvent("pointerup", { ...eventInit, buttons: 0 }));
      element.dispatchEvent(new MouseEvent("mouseup", { ...eventInit, buttons: 0 }));
      element.dispatchEvent(new MouseEvent("click", { ...eventInit, buttons: 0 }));
      return { ok: true };
    };
  });
  await page.waitForFunction(() => Boolean(window.__ATW_TEST__));
}

test("bounded live surface feedback verifies a local modal transition without weakening price checks", async ({ page }) => {
  await loadHtmlProducer(page, `
    <main>
      <button id="open" type="button">Choose seats</button>
    </main>
    <script>
      document.getElementById("open").addEventListener("click", () => {
        const dialog = document.createElement("div");
        dialog.id = "seat-dialog";
        dialog.setAttribute("role", "dialog");
        dialog.setAttribute("aria-modal", "true");
        dialog.innerHTML = '<h2>Seat choice</h2><button type="button">Choose seats for me</button>';
        document.body.appendChild(dialog);
      });
    </script>
  `);

  const result = await page.evaluate(() => {
    const beforeMap = window.__ATW_TEST__.observePageState({ forceFull: true, reason: "surface_feedback_before" }).map;
    const target = document.getElementById("open");
    target.click();
    const expected = {
      type: "observable_change",
      beforeUrl: location.href
    };
    return {
      safe: window.__ATW_TEST__.verificationFromSurfaceFeedback(expected, beforeMap, target),
      priceSensitive: window.__ATW_TEST__.verificationFromSurfaceFeedback({
        ...expected,
        mustNotIncreasePrice: true
      }, beforeMap, target)
    };
  });

  expect(result.safe).toMatchObject({
    ok: true,
    code: "MECHANICAL_SURFACE_FEEDBACK_VERIFIED",
    evidence: { overlayAppeared: true }
  });
  expect(result.priceSensitive).toBeNull();
});

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
          if (["typing_suggestions", "canonical_suggestions", "first_fail"].includes(variant) && /386|slovenia/.test(value)) show();
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
    const compact = hooks.compactPageMap(map, id);
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
    governed = hooks.decisionFromActionLease(governed);
    // Keep the pre-action observation immutable even when the incremental
    // observer refreshes its internal cache after a DOM mutation.
    const beforeMap = JSON.parse(JSON.stringify(hooks.buildPageMap()));
    hooks.prepareScreenshotAnnotations(beforeMap, governed.observationId);
    let target = null;
    let validation = null;
    let choiceCommit = null;
    // An expected outcome is a pre-dispatch contract. Building it after the
    // event would let the resulting URL/surface become its own baseline and
    // make genuine transitions unverifiable.
    let expectedOutcome = governed.expectedOutcome || null;
    const bindPreDispatchUrl = (outcome) => ({
      ...(outcome || {}),
      beforeUrl: outcome?.beforeUrl || beforeMap.url || location.href
    });
    if (expectedOutcome) expectedOutcome = bindPreDispatchUrl(expectedOutcome);
    if (governed.action === "click_xy") {
      const hit = document.elementFromPoint(governed.x, governed.y);
      target = hit;
      expectedOutcome ||= hooks.expectedOutcomeForDecision(governed, beforeMap, target);
      expectedOutcome = bindPreDispatchUrl(expectedOutcome);
      validation = hooks.validateVisualCoordinateTarget(governed, hit, beforeMap);
      if (validation.ok) {
        target = validation.dispatchTarget || hit;
        hooks.clickResolvedViewportTarget(target, governed.x, governed.y);
      }
    } else {
      target = hooks.resolveDecisionTarget(governed, beforeMap);
      expectedOutcome ||= hooks.expectedOutcomeForDecision(governed, beforeMap, target);
      expectedOutcome = bindPreDispatchUrl(expectedOutcome);
      validation = target
        ? hooks.validateResolvedTarget(governed, target, beforeMap)
        : { ok: false, code: "CANONICAL_ACTUATOR_UNAVAILABLE" };
      if (validation.ok && governed.action === "click") {
        hooks.rememberChoiceVisualStateBeforeDispatch(target, governed);
        hooks.rememberCanonicalSelectionCommitment(target, governed);
        if (governed.interactionMethod === "native_click") hooks.nativeElementClick(target);
        else if (governed.interactionMethod === "browser_trusted_input") {
          const trusted = await hooks.trustedBrowserClick(target, governed);
          if (!trusted.ok) validation = { ok: false, code: trusted.code || "TRUSTED_INPUT_UNAVAILABLE" };
        } else if (governed.interactionMethod === "browser_trusted_choice") {
          const trusted = await hooks.trustedBrowserChoice(target, governed);
          if (!trusted.ok) validation = { ok: false, code: trusted.code || "TRUSTED_INPUT_UNAVAILABLE" };
          else choiceCommit = await hooks.settleTrustedChoiceInteraction(target, governed);
        } else hooks.userLikeClick(target);
        if (
          validation.ok
          && !choiceCommit
          && governed.expectedOutcome?.type === "logical_component_committed"
          && !target.matches?.("input[type='checkbox'], input[type='radio']")
          && (
            governed.interactionRole === "choice"
            || governed.semanticEffect === "select"
            || ["choose", "select"].includes(governed.operation)
          )
        ) {
          choiceCommit = await hooks.settleTrustedChoiceInteraction(target, governed);
        }
      } else if (validation.ok && governed.action === "keypress") {
        target.focus?.();
        hooks.dispatchKey(target, governed.keys);
      } else if (validation.ok && (governed.action === "type" || governed.action === "select")) {
        const fieldResult = await hooks.setFieldValue(target, governed.value || "", {
          fieldType: governed.action,
          exactOption: governed.exactOption || governed.pipelineContract?.component?.exactOption || null,
          compareMode: governed.operation === "type" && governed.controlId.includes("phone") ? "digits" : "text",
          resolveLiveElement: () => hooks.resolveDecisionTarget(governed, hooks.buildPageMap())
        });
        if (!fieldResult.ok) validation = { ok: false, code: "FIELD_VALUE_NOT_VERIFIED", fieldResult };
      }
    }
    // Production always binds browser-local baselines and the final governor
    // authorization around the server-owned obligation postcondition. Keep
    // replay execution identical instead of passing the raw backend outcome
    // directly to the verifier.
    expectedOutcome = bindPreDispatchUrl(hooks.expectedOutcomeForDecision({
      ...governed,
      expectedOutcome
    }, beforeMap, target));
    await new Promise((resolve) => setTimeout(resolve, 80));
    let afterMap = hooks.buildPageMap();
    let localVerification = validation.ok
      ? hooks.verifyExpectedOutcome(expectedOutcome, beforeMap, afterMap, target)
      : { ok: false, code: validation.code, message: "Browser validation rejected the action.", evidence: {} };
    if (validation.ok && !localVerification.ok && expectedOutcome.type === "exact_free_option_selected") {
      const settled = await hooks.settleExactChoiceOutcome(
        target,
        governed,
        expectedOutcome,
        beforeMap,
        afterMap
      );
      afterMap = settled.afterMap;
      localVerification = settled.verification;
    }
    hooks.prepareScreenshotAnnotations(afterMap, nextObservationId);
    const verification = validation.ok
      ? hooks.withChoiceCommitEvidence(localVerification, choiceCommit, expectedOutcome, governed)
      : localVerification;
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
    const compact = hooks.compactPageMap(afterMap, nextObservationId);
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
        <fieldset id="flex-group" role="radiogroup" aria-label="Flexible ticket decision">
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
  const traveler = { id: "trav_scroll", booking_rules: "no extras" };
  const goal = deriveObservationGoal(initial, []);
  const candidateSet = buildCurrentCandidateSet({
    goal,
    observation: initial,
    traveler,
    state,
    approvals: state.approvals
  });
  const pendingCandidate = candidateSet.recoveryCandidates.find((candidate) => candidate.controlId === decline.controlId);
  expect(pendingCandidate).toBeTruthy();
  const recoveryCandidateSet = { ...candidateSet, candidates: [pendingCandidate] };
  const currentGoal = { ...goal, candidateSet: recoveryCandidateSet, candidates: recoveryCandidateSet.candidates };
  state.currentGoal = currentGoal;
  state.currentObservation = {
    observationId: initial.observationId,
    observationHash: initial.observationSnapshot.snapshotHash
  };
  state.lastAction = { id: "act_first_scroll", type: "scroll" };
  state = withExecutionFixture(state, { recovery: {
    attempts: 0,
    phase: "reveal",
    stateHash: "",
    failedStrategySignatures: [],
    lastRevealSample: {
      observationId: initial.observationId,
      exists: true,
      inViewport: false,
      distanceToViewport: Math.max(0, Math.round(
        Number(decline.visualRegion.y || 0)
        + Number(decline.visualRegion.height || 0) / 2
        - Number(initial.page.viewport?.height || 0)
      ))
    }
  } });
  state = withExecutionFixture(state, { leasedAction: leasedActionRecord({
    action: { ...originalClick, targetSnapshot: null, expectedOutcome: null },
    goal: currentGoal,
    candidate: pendingCandidate,
    status: "needs_reveal",
    recoveryAttempts: 1
  }) });

  const firstMovement = await page.evaluate((decision) => {
    const hooks = window.__ATW_TEST__;
    decision = hooks.decisionFromActionLease(decision);
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
    traveler,
    transactionStore: store,
    clientTurnId: "turn_centered_retry"
  });
  expect(retry.clientDecision.action).toBe("scroll");
  expect(retry.clientDecision.expectedOutcome.attempt).toBe(2);
  expect(retry.clientDecision.expectedOutcome.scrollStrategy).toBe("target_center");
  expect(leasedAction(retry.state).recoveryAttempts).toBe(2);
  expect(executionRecovery(retry.state).attempts).toBe(1);
  expect(retry.debug.modelUsage.calls).toHaveLength(0);

  await page.evaluate((decision) => {
    const hooks = window.__ATW_TEST__;
    decision = hooks.decisionFromActionLease(decision);
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
    traveler,
    transactionStore: store,
    clientTurnId: "turn_resume_decline"
  });
  expect(
    resumed.clientDecision.action,
    JSON.stringify({ decision: resumed.clientDecision, state: resumed.state, debug: resumed.debug }, null, 2)
  ).toBe("click");
  expect(resumed.clientDecision.controlId).toBe(decline.controlId);
  expect(leasedAction(resumed.state).contractVersion).toBe("leased-action/v1");
  expect(leasedAction(resumed.state).status).toBe("ready");
  expect(leasedAction(resumed.state).originalAction.id).toBe(resumed.clientDecision.actionId);

  const clicked = await executeAtomicBrowserDecision(page, resumed.clientDecision, "obs_bundle_satisfied");
  expect(clicked.verification.ok).toBe(true);
  expect(await page.evaluate(() => window.__declineClicks)).toBe(1);
  expect(clicked.observation.page.decisionGroups.some((group) => group.status === "satisfied")).toBe(true);
});

test("resolved extras preserve one offscreen Continue through reveal, fresh observation, rebind, and dispatch", async ({ page }) => {
  await loadHtmlProducer(page, `
    <style>
      body { margin: 0; font-family: sans-serif; }
      #extras-scroll { height: 240px; overflow-y: auto; border: 1px solid #888; }
      fieldset { min-height: 72px; }
      .spacer { height: 700px; }
    </style>
    <main>
      <h1 id="stage">Optional extras</h1>
      <div id="extras-scroll">
        <fieldset id="flex-group" role="radiogroup" aria-label="Flexible ticket decision">
          <legend>Flexible ticket</legend>
          <label><input type="radio" name="flex" value="paid" required> Flexible ticket — 35 EUR</label>
          <label><input id="flex-free" type="radio" name="flex" value="none" required> No thanks</label>
        </fieldset>
        <div class="spacer"></div>
        <button id="extras-continue" type="button">Continue</button>
      </div>
    </main>
    <script>
      window.__continueClicks = 0;
      document.getElementById("flex-free").addEventListener("change", () => {
        setTimeout(() => {
          const protectGroup = document.createElement("fieldset");
          protectGroup.id = "protect-group";
          protectGroup.setAttribute("role", "radiogroup");
          protectGroup.setAttribute("aria-label", "Travel protection decision");
          protectGroup.innerHTML =
            '<legend>Travel protection</legend>' +
            '<label><input type="radio" name="protect" value="paid" required> Protection — 25 EUR</label>' +
            '<label><input id="protect-free" type="radio" name="protect" value="none" required> No thanks</label>';
          document.getElementById("flex-group").remove();
          document.getElementById("extras-scroll").insertBefore(protectGroup, document.querySelector(".spacer"));
          document.getElementById("stage").textContent = "Travel protection";
        }, 120);
      });
      document.getElementById("extras-continue").addEventListener("click", () => {
        if (!document.getElementById("protect-free")?.checked) return;
        window.__continueClicks += 1;
        document.body.dataset.stage = "next-stage";
        document.getElementById("stage").textContent = "Next checkout stage";
      });
    </script>
  `);

  const traveler = { id: "trav_extras_continue", booking_rules: "no paid extras" };
  let state = createCheckoutSessionState({
    goal: "Resolve all extras and continue",
    travelerId: traveler.id,
    site: { host: "example.test", url: page.url() }
  });
  state.id = "txn_extras_continue_reveal";
  state.approvals.skipPaidExtrasApproved = true;
  const store = inMemoryGovernorStore();
  const selectedControls = [];

  const nextTurn = async (observation, turnId) => {
    store.remember(state.id, observation);
    const turn = await runLoopTurn({
      apiKey: "",
      model: "must-not-be-called",
      dataDir: "",
      state,
      observation,
      traveler,
      transactionStore: store,
      clientTurnId: turnId
    });
    state = turn.state;
    expect(turn.debug.modelUsage.calls).toHaveLength(0);
    return turn;
  };

  let observation = await browserObservation(page, "obs_extras_initial");
  const firstTurn = await nextTurn(observation, "turn_extra_1");
  expect(firstTurn.clientDecision.action).toBe("click");
  expect(firstTurn.clientDecision.targetLabel).toMatch(/no thanks/i);
  selectedControls.push(firstTurn.clientDecision.controlId);
  const firstExecuted = await executeAtomicBrowserDecision(page, firstTurn.clientDecision, "obs_extra_1_commit");
  expect(firstExecuted.verification.ok).toBe(true);
  await page.waitForTimeout(160);
  expect(await page.locator("#flex-group").count()).toBe(0);
  const secondSurface = await browserObservation(page, "obs_extra_1_selected");
  secondSurface.previousObservation = observation;
  secondSurface.lastActionResult = firstExecuted.result;
  observation = secondSurface;

  let secondTurn = await nextTurn(observation, "turn_extra_2");
  if (secondTurn.clientDecision.action === "scroll") {
    await page.evaluate((decision) => {
      const hooks = window.__ATW_TEST__;
      decision = hooks.decisionFromActionLease(decision);
      const map = hooks.buildPageMap();
      const target = hooks.resolveDecisionTarget(decision, map);
      hooks.scrollElementWithinNearestContainer(target, {
        behavior: "auto",
        strategy: "target_center",
        authority: "governed_executor"
      });
    }, secondTurn.clientDecision);
    const secondVisible = await browserObservation(page, "obs_extra_2_visible");
    secondVisible.previousObservation = observation;
    secondVisible.lastActionResult = {
      actionId: secondTurn.clientDecision.actionId,
      observationId: secondTurn.clientDecision.observationId,
      dispatched: true,
      executed: true,
      verified: false,
      outcome: { code: "SCROLL_DISPATCHED_AWAITING_FRESH_OBSERVATION" }
    };
    observation = secondVisible;
    secondTurn = await nextTurn(observation, "turn_extra_2_resume");
  }
  expect(secondTurn.clientDecision.action, JSON.stringify({ decision: secondTurn.clientDecision, debug: secondTurn.debug }, null, 2)).toBe("click");
  expect(secondTurn.clientDecision.targetLabel).toMatch(/no thanks/i);
  selectedControls.push(secondTurn.clientDecision.controlId);
  const secondExecuted = await executeAtomicBrowserDecision(page, secondTurn.clientDecision, "obs_extra_2_selected");
  expect(secondExecuted.verification.ok).toBe(true);
  expect(await page.locator("#protect-free").isChecked()).toBe(true);
  secondExecuted.observation.previousObservation = observation;
  observation = secondExecuted.observation;
  expect(new Set(selectedControls).size).toBe(2);

  const revealTurn = await nextTurn(observation, "turn_continue_reveal");
  expect(
    revealTurn.clientDecision.action,
    JSON.stringify({ decision: revealTurn.clientDecision, state: revealTurn.state, debug: revealTurn.debug }, null, 2)
  ).toBe("scroll");
  expect(leasedAction(revealTurn.state).contractVersion).toBe("leased-action/v1");
  expect(leasedAction(revealTurn.state).status).toBe("needs_reveal");
  expect(leasedAction(revealTurn.state).originalAction.targetLabel).toMatch(/continue/i);

  await page.evaluate((decision) => {
    const hooks = window.__ATW_TEST__;
    decision = hooks.decisionFromActionLease(decision);
    const map = hooks.buildPageMap();
    const target = hooks.resolveDecisionTarget(decision, map);
    hooks.scrollElementWithinNearestContainer(target, {
      behavior: "auto",
      strategy: "target_center",
      authority: "governed_executor"
    });
  }, revealTurn.clientDecision);
  const visible = await browserObservation(page, "obs_continue_visible");
  visible.previousObservation = observation;
  visible.lastActionResult = {
    actionId: revealTurn.clientDecision.actionId,
    observationId: revealTurn.clientDecision.observationId,
    dispatched: true,
    executed: true,
    verified: false,
    outcome: { code: "SCROLL_DISPATCHED_AWAITING_FRESH_OBSERVATION" }
  };
  const resumed = await nextTurn(visible, "turn_continue_resume");
  expect(
    resumed.clientDecision.action,
    JSON.stringify({ decision: resumed.clientDecision, state: resumed.state, debug: resumed.debug }, null, 2)
  ).toBe("click");
  expect(resumed.clientDecision.targetLabel).toMatch(/continue/i);
  expect(leasedAction(resumed.state).status).toBe("ready");
  expect(leasedAction(resumed.state).originalAction.id).toBe(resumed.clientDecision.actionId);

  const continued = await executeAtomicBrowserDecision(page, resumed.clientDecision, "obs_extras_advanced");
  expect(continued.result.dispatched).toBe(true);
  expect(await page.locator("body").getAttribute("data-stage")).toBe("next-stage");
  expect(await page.evaluate(() => window.__continueClicks)).toBe(1);
});

test("three sibling extras resolve as an exact decision-group queue before Continue is published", async ({ page }) => {
  await loadHtmlProducer(page, `
    <style>
      body { margin: 0; font-family: sans-serif; }
      #extras-scroll { height: 520px; overflow-y: auto; border: 1px solid #888; }
      fieldset { margin: 16px; padding: 12px; }
      label { display: block; padding: 6px; }
      .spacer { height: 620px; }
    </style>
    <main>
      <h1 id="stage">Optional protection and support</h1>
      <section aria-label="Optional extras">
        <div id="extras-scroll">
          <fieldset role="radiogroup" aria-label="AirHelp">
            <legend>AirHelp</legend>
            <label><input type="radio" name="airhelp" value="add" required> Add AirHelp — 18 EUR</label>
            <label><input id="airhelp-none" type="radio" name="airhelp" value="none" required> No thanks</label>
          </fieldset>
          <fieldset role="radiogroup" aria-label="Lost baggage">
            <legend>Lost baggage</legend>
            <label><input type="radio" name="lost-baggage" value="add" required> Add lost baggage protection — 12 EUR</label>
            <label><input id="lost-baggage-none" type="radio" name="lost-baggage" value="none" required> No thanks</label>
          </fieldset>
          <div role="group" aria-label="Premium support" aria-required="true">
            <h2>Premium support</h2>
            <button id="premium-support-add" type="button" aria-pressed="false">Add premium support — 9 EUR</button>
            <button id="premium-support-none" type="button" aria-pressed="false">No thanks</button>
          </div>
          <div class="spacer"></div>
          <button id="continue-extras" type="button">Continue</button>
        </div>
      </section>
    </main>
    <script>
      window.__continueClicks = 0;
      for (const id of ["premium-support-add", "premium-support-none"]) {
        document.getElementById(id).addEventListener("click", () => {
          document.getElementById("premium-support-add").setAttribute("aria-pressed", String(id === "premium-support-add"));
          document.getElementById("premium-support-none").setAttribute("aria-pressed", String(id === "premium-support-none"));
        });
      }
      document.getElementById("continue-extras").addEventListener("click", () => {
        const complete = ["airhelp-none", "lost-baggage-none"].every((id) => document.getElementById(id).checked)
          && document.getElementById("premium-support-none").getAttribute("aria-pressed") === "true";
        if (!complete) return;
        window.__continueClicks += 1;
        document.body.dataset.stage = "payment-review";
        document.getElementById("stage").textContent = "Payment review";
      });
    </script>
  `);

  const traveler = { id: "trav_exact_group_queue", booking_rules: "no paid extras" };
  let state = createCheckoutSessionState({
    goal: "Decline every paid extra and continue",
    travelerId: traveler.id,
    site: { host: "example.test", url: page.url() }
  });
  state.id = "txn_exact_group_queue";
  state.approvals.skipPaidExtrasApproved = true;
  const store = inMemoryGovernorStore();

  const nextTurn = async (observation, turnId) => {
    store.remember(state.id, observation);
    const turn = await runLoopTurn({
      apiKey: "",
      model: "must-not-be-called",
      dataDir: "",
      state,
      observation,
      traveler,
      transactionStore: store,
      clientTurnId: turnId
    });
    state = turn.state;
    expect(turn.debug.modelUsage.calls).toHaveLength(0);
    return turn;
  };

  let observation = await browserObservation(page, "obs_exact_groups_0");
  const initialGroups = observation.page.decisionGroups.filter((group) => (
    /airhelp|lost baggage|premium support/i.test(`${group.sectionLabel || ""} ${group.requirementId || ""}`)
  ));
  expect(initialGroups, JSON.stringify({
    groups: observation.page.decisionGroups,
    premiumControls: observation.page.controls.filter((control) => /premium support|no thanks/i.test(control.label || ""))
  }, null, 2)).toHaveLength(3);
  expect(new Set(initialGroups.map((group) => group.decisionGroupId)).size).toBe(3);
  for (const group of initialGroups) {
    expect(group.status).toBe("missing");
    expect(group.alternativeControlIds).toHaveLength(2);
    expect(new Set(group.alternativeControlIds).size).toBe(2);
  }

  const completedGroupIds = [];
  for (let index = 0; index < 3; index += 1) {
    const turn = await nextTurn(observation, `turn_exact_group_${index + 1}`);
    const unresolved = observation.page.decisionGroups.find((group) => (
      group.decisionGroupId === turn.clientDecision.decisionGroupId
      && group.required
      && !["satisfied", "waived_by_policy"].includes(group.status)
    ));
    expect(unresolved).toBeTruthy();
    expect(
      turn.clientDecision.action,
      JSON.stringify({ decision: turn.clientDecision, state: turn.state, debug: turn.debug, groups: observation.page.decisionGroups }, null, 2)
    ).toBe("click");
    expect(turn.clientDecision.targetLabel).toMatch(/no thanks/i);
    expect(turn.clientDecision.decisionGroupId).toBe(unresolved.decisionGroupId);
    expect(turn.state.taskState.currentGoal).toBeUndefined();
    expect(turn.state.taskState.currentObligation).toMatchObject({
      contractVersion: "current-obligation/v2",
      subject: { decisionGroupId: unresolved.decisionGroupId }
    });
    expect(turn.state.taskState.currentObligation.admittedControlIds).toContain(turn.clientDecision.controlId);
    const continueControlIds = observation.page.controls
      .filter((control) => /continue/i.test(control.label || ""))
      .map((control) => control.controlId);
    expect(turn.state.taskState.currentObligation.admittedControlIds.some(
      (controlId) => continueControlIds.includes(controlId)
    )).toBe(false);

    completedGroupIds.push(unresolved.decisionGroupId);
    const executed = await executeAtomicBrowserDecision(page, turn.clientDecision, `obs_exact_groups_${index + 1}`);
    expect(executed.verification.ok, JSON.stringify({
      decision: turn.clientDecision,
      validation: executed.validation,
      verification: executed.verification,
      groups: executed.observation.page.decisionGroups
    }, null, 2)).toBe(true);
    executed.observation.previousObservation = observation;
    observation = executed.observation;

    const exactCompleted = observation.page.decisionGroups.find((group) => group.decisionGroupId === unresolved.decisionGroupId);
    expect(exactCompleted.status).toBe("satisfied");
    expect(exactCompleted.selectedControlId).toBe(turn.clientDecision.controlId);
    const unresolvedSiblings = observation.page.decisionGroups.filter((group) => (
      group.required
      && group.decisionGroupId !== unresolved.decisionGroupId
      && !completedGroupIds.includes(group.decisionGroupId)
    ));
    expect(unresolvedSiblings.every((group) => group.status === "missing")).toBe(true);
  }

  expect(new Set(completedGroupIds).size).toBe(3);
  const revealContinue = await nextTurn(observation, "turn_exact_groups_continue_reveal");
  expect(revealContinue.clientDecision.action).toBe("scroll");
  expect(leasedAction(revealContinue.state).originalAction.targetLabel).toMatch(/continue/i);

  await page.evaluate((decision) => {
    const hooks = window.__ATW_TEST__;
    decision = hooks.decisionFromActionLease(decision);
    const map = hooks.buildPageMap();
    const target = hooks.resolveDecisionTarget(decision, map);
    hooks.scrollElementWithinNearestContainer(target, {
      behavior: "auto",
      strategy: "target_center",
      authority: "governed_executor"
    });
  }, revealContinue.clientDecision);
  const visible = await browserObservation(page, "obs_exact_groups_continue_visible");
  visible.previousObservation = observation;
  visible.lastActionResult = {
    actionId: revealContinue.clientDecision.actionId,
    observationId: revealContinue.clientDecision.observationId,
    dispatched: true,
    executed: true,
    verified: false,
    outcome: { code: "SCROLL_DISPATCHED_AWAITING_FRESH_OBSERVATION" }
  };
  const resumedContinue = await nextTurn(visible, "turn_exact_groups_continue_resume");
  expect(resumedContinue.clientDecision.action).toBe("click");
  expect(resumedContinue.clientDecision.targetLabel).toMatch(/continue/i);

  const continued = await executeAtomicBrowserDecision(page, resumedContinue.clientDecision, "obs_exact_groups_payment_review");
  expect(continued.result.dispatched).toBe(true);
  expect(await page.locator("body").getAttribute("data-stage")).toBe("payment-review");
  expect(await page.evaluate(() => window.__continueClicks)).toBe(1);

  const records = resumedContinue.state.taskState?.completedOutcomes || [];
  for (const groupId of completedGroupIds) {
    const record = records.find((item) => item.decisionGroupId === groupId);
    expect(record).toMatchObject({
      decisionGroupId: groupId,
      status: "satisfied"
    });
    expect(record.requirementId).toBeTruthy();
    expect(record.selectedControlId).toBeTruthy();
    expect(record.observationId).toBeTruthy();
  }
});

test("paid product detail buttons remain context and never become singleton required decisions", async ({ page }) => {
  await loadHtmlProducer(page, `
    <main>
      <h1>Configure your trip</h1>
      <section aria-label="Optional products">
        <h2>Build your own bundle</h2>
        <fieldset role="radiogroup" aria-label="Bundle tier">
          <legend>Bundle tier</legend>
          <label><input type="radio" name="bundle-tier" value="standard"> Standard — 20 EUR</label>
          <label><input type="radio" name="bundle-tier" value="premium"> Premium — 40 EUR</label>
        </fieldset>
        <label><input id="bundle-decline" type="checkbox" value="none"> No thanks — continue without bundle</label>
        <button id="standard-details" type="button">Standard — 20 EUR. Click to learn bundle details</button>
        <button id="premium-details" type="button">Premium — 40 EUR. Click to learn bundle details</button>
        <button id="sms-details" type="button">Booking number by SMS included in Premium+</button>
        <div role="group" aria-label="AirHelp Plus">
          <h3>AirHelp Plus</h3>
          <button id="airhelp-add" type="button" aria-pressed="false">Add AirHelp Plus — 18 EUR</button>
          <button id="airhelp-decline" type="button" aria-pressed="false">No thanks</button>
        </div>
      </section>
      <button type="button">Continue</button>
    </main>
  `);

  const observation = await browserObservation(page, "obs_detail_buttons_are_context");
  const detailControls = observation.page.controls.filter((control) => (
    /click to learn bundle details|booking number by sms/i.test(control.label || "")
  ));
  expect(detailControls).toHaveLength(3);

  const groupedControlIds = new Set(observation.page.decisionGroups.flatMap((group) => (
    group.alternativeControlIds || []
  )));
  for (const control of detailControls) {
    expect(groupedControlIds.has(control.controlId), JSON.stringify(observation.page.decisionGroups, null, 2)).toBe(false);
  }

  const bundleDecline = observation.page.controls.find((control) => /continue without bundle/i.test(control.label || ""));
  expect(bundleDecline).toBeTruthy();
  const bundleGroup = observation.page.decisionGroups.find((group) => (
    group.alternativeControlIds?.includes(bundleDecline.controlId)
  ));
  expect(bundleGroup).toBeTruthy();
  expect(bundleGroup.required).toBe(false);
  expect(bundleGroup.alternativeControlIds).toHaveLength(3);
  expect(bundleGroup.alternativeControlIds.filter((id) => (
    observation.page.controls.find((control) => control.controlId === id)?.risk === "money"
  ))).toHaveLength(2);

  const airHelpGroup = observation.page.decisionGroups.find((group) => (
    /airhelp/i.test(`${group.sectionLabel || ""} ${group.requirementId || ""}`)
  ));
  expect(airHelpGroup).toBeTruthy();
  expect(airHelpGroup.required).toBe(false);
  expect(airHelpGroup.alternativeControlIds).toHaveLength(2);
  expect(observation.page.controls.some((control) => (
    airHelpGroup.alternativeControlIds.includes(control.controlId)
    && /no thanks/i.test(control.label || "")
  ))).toBe(true);
});

test("optional negative marketing checkbox stays optional inside a required contact section", async ({ page }) => {
  await loadHtmlProducer(page, `
    <main>
      <h1>Traveller information</h1>
      <section role="group" aria-label="Contact information for all passengers">
        <label>E-mail * <input name="email" type="email" required value="ali@aztela.com"></label>
        <label>Confirm e-mail address * <input name="confirmEmail" type="email" required value="ali@aztela.com"></label>
        <label>Mobile number * <input name="phone" type="tel" required value="70328922"></label>
        <label><input id="newsletter-opt-out" type="checkbox"> I do not wish to receive any newsletters about cheap air fares or other offers</label>
      </section>
      <button type="button">Continue</button>
    </main>
  `);

  const observation = await browserObservation(page, "obs_optional_negative_marketing");
  const marketing = observation.page.controls.find((control) => /do not wish to receive any newsletters/i.test(control.label || ""));
  expect(marketing).toBeTruthy();
  expect(marketing.semantic).toBe("decline_paid_extra");
  expect(marketing.risk).toBe("safe_decline");
  const group = observation.page.decisionGroups.find((candidate) => (
    candidate.alternativeControlIds?.includes(marketing.controlId)
  ));
  expect(group).toBeTruthy();
  expect(group.required).toBe(false);
  expect(group.status).toBe("optional");
});

test("current bundle price outranks included benefit copy and joins the free decline", async ({ page }) => {
  await loadHtmlProducer(page, `
    <main>
      <h1>Traveller information</h1>
      <section aria-label="Add a bundle">
        <fieldset>
          <legend>Add a bundle</legend>
          <label><input type="radio" name="bundle" value="basic" aria-describedby="basic-price"> Basic bundle. Product included in bundle.</label>
          <div id="basic-price">Original price: 38 Euro ‪38EUR‬ Discounted Price: 30 Euro ‪30EUR‬ 2 Product included in this bundle tier</div>
          <label><input type="radio" name="bundle" value="plus" aria-describedby="plus-price"> Plus bundle. Product included in bundle.</label>
          <div id="plus-price">Original price: 53 Euro ‪53EUR‬ Discounted Price: 42 Euro ‪42EUR‬ 3 Product included in this bundle tier</div>
          <label><input type="radio" name="bundle" value="premium" aria-describedby="premium-price"> Premium bundle. Product included in bundle.</label>
          <div id="premium-price">Original price: 56 Euro ‪56EUR‬ Discounted Price: 45 Euro ‪45EUR‬ 4 Product included in this bundle tier</div>
        </fieldset>
        <label><input type="checkbox" value="none"> No, thanks. Select this to continue without bundle.</label>
      </section>
      <button type="button">Continue</button>
    </main>
  `);

  const observation = await browserObservation(page, "obs_bundle_current_price_and_decline");
  const decline = observation.page.controls.find((control) => /continue without bundle/i.test(control.label || ""));
  expect(decline).toBeTruthy();
  const group = observation.page.decisionGroups.find((candidate) => (
    candidate.alternativeControlIds?.includes(decline.controlId)
  ));
  expect(group).toBeTruthy();
  expect(group.required).toBe(false);
  expect(group.alternatives).toHaveLength(4);
  const paid = group.alternatives.filter((choice) => choice.risk === "money");
  expect(paid).toHaveLength(3);
  expect(paid.map((choice) => choice.structuredPrice?.amount).sort((a, b) => a - b)).toEqual([30, 42, 45]);
  expect(group.alternatives.find((choice) => choice.controlId === decline.controlId)).toMatchObject({
    semantic: "decline_paid_extra",
    risk: "safe_decline"
  });
});

async function executeUnifiedCandidate({ page, store, state, goal, candidate, observation, nextObservationId, turnId }) {
  const action = loopPrivate.bindTargetSnapshot(
    actionForCurrentCandidate(goal, candidate, observation),
    observation
  );
  const governance = governAction({
    action,
    state: {
      ...state,
      taskState: {
        ...(state.taskState || {}),
        currentGoal: { ...goal, candidates: goal.candidates }
      },
      currentGoal: { ...goal, candidates: goal.candidates }
    },
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

test("Unified CurrentObligation loop executes turn-local server candidates selected only by candidateId", async ({ page }) => {
  const traveler = { id: "trav_combo", phone: "+38670328922", nationality: "Slovenia" };
  for (const variant of [
    { name: "direct_type", operation: "type", value: "+386" },
    { name: "typing_suggestions", operation: "type", value: "slovenia" },
    { name: "canonical_suggestions", operation: "type", value: "+386" },
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
    expect(goal, `${variant.name}: TaskState profile admission did not publish the mismatched current field`).toBeTruthy();
    let attempted = [];
    goal.candidates = buildCurrentCandidateSet({ goal, observation, traveler, attemptedCandidateIds: attempted }).candidates;
    const selectedCandidateId = goal.candidates.find((candidate) => (
      candidate.operation === variant.operation
      && (!variant.value || candidate.value === variant.value)
    ))?.candidateId;
    expect(selectedCandidateId, `${variant.name}: ${JSON.stringify(goal.candidates.map((item) => ({ operation: item.operation, value: item.value, risk: item.risk, exclusionReason: item.exclusionReason })))} `).toBeTruthy();
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
    if (variant.name === "canonical_suggestions") {
      expect(first.browser.observation.page.currentSurface?.type).not.toBe("page");
      expect(profileGoalSatisfied(goal, first.browser.observation, traveler)).toBe(false);
    }
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
      const completion = resolveLogicalFields(second.browser.observation.page, traveler);
      if (variant.name === "canonical_suggestions") {
        expect(second.browser.verification.code).toBe("LOGICAL_COMPONENT_COMMITTED");
      }
      expect(
        profileGoalSatisfied(goal, second.browser.observation, traveler),
        `${variant.name}: ${JSON.stringify({
          candidate: {
            controlId: choose.controlId,
            targetId: choose.targetId,
            operation: choose.operation,
            interactionMethod: choose.interactionMethod
          },
          browser: {
            validation: second.browser.validation,
            verification: second.browser.verification,
            countryValue: second.browser.countryValue,
            currentSurface: second.browser.observation.page.currentSurface
          },
          completion: completion.map((field) => ({
          logicalFieldId: field.logicalFieldId,
          currentCanonicalValue: field.currentCanonicalValue,
          desiredCanonicalValue: field.desiredCanonicalValue,
          components: field.components.map((component) => ({
            role: component.role,
            current: component.currentCanonicalValue,
            desired: component.desiredCanonicalValue,
            status: component.status,
            interactionKind: component.interactionKind,
            commitRequirement: component.commitRequirement,
            activeChoiceSurface: component.activeChoiceSurface,
            interactionSettled: component.interactionSettled,
            commitState: component.commitState
          }))
          }))
        })}`
      ).toBe(true);
    }
    expect(await page.locator("#country-code").inputValue(), variant.name).toBe("+386");
    if (variant.name === "canonical_suggestions") {
      expect(await page.locator("#country-options").isHidden()).toBe(true);
    }
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

test("combined given-names fields and persistent checkout chrome stay on the page surface", async ({ page }) => {
  const profile = {
    first_name: "Ali",
    last_name: "SIFRAR",
    email: "ali@aztela.com",
    date_of_birth: "2003-05-31"
  };
  const variants = [
    {
      name: "Turkish-style bottom itinerary bar",
      css: ".checkout-chrome { position: fixed; left: 0; right: 0; bottom: 0; height: 120px; z-index: 20; background: white; }",
      copy: "Departure SJJ – IST Return IST – SJJ Total price Details"
    },
    {
      name: "easyJet-style side price panel",
      css: ".checkout-chrome { position: fixed; right: 0; top: 80px; width: 320px; height: 70vh; z-index: 20; background: white; }",
      copy: "Price breakdown Flight total amount Your booking summary Choose seats for me"
    }
  ];

  for (const variant of variants) {
    await loadHtmlProducer(page, `
      <style>
        body { font-family: sans-serif; min-height: 1400px; }
        main { width: 720px; }
        input { width: 280px; height: 36px; }
        button { width: 160px; height: 44px; }
        ${variant.css}
      </style>
      <main>
        <h1>Passenger information</h1>
        <label>First / Middle name (as shown on ID)
          <input name="preventautofill passengername_0" required>
        </label>
        <label>Surname (as shown on ID)<input name="surname_0" required></label>
      </main>
      <aside class="checkout-chrome">
        <p>${variant.copy}</p>
        <button type="button">Continue</button>
      </aside>
    `);
    await page.evaluate((traveler) => window.__ATW_TEST__.setAppDataForTest({
      travelers: [{ id: "trav_composite", ...traveler }],
      preferences: {}
    }, "trav_composite"), profile);

    const observation = await browserObservation(page, `obs_${variant.name.replace(/\W+/g, "_")}`);
    const givenNames = observation.page.controls.find((control) => (
      control.fieldType === "given_names" || control.semantic === "given_names"
    ));
    expect(givenNames, variant.name).toBeTruthy();
    expect(observation.page.currentSurface.type, variant.name).toBe("page");
    expect(profileStageReadiness(observation, profile).missingUserData, variant.name).toEqual([]);
    const logical = resolveLogicalFields(observation.page, profile).find((field) => field.semanticType === "given_names");
    expect(logical, variant.name).toMatchObject({
      desiredCanonicalValue: "ali",
      components: [expect.objectContaining({ inputValue: "Ali" })]
    });
  }
});

test("positioned seat summary stays contextual and its safe exact actuator enters bounded adaptation", async ({ page }) => {
  await loadHtmlProducer(page, `
    <style>
      body { font-family: sans-serif; min-height: 1100px; }
      main { width: 700px; }
      .price-summary { position: fixed; right: 0; top: 70px; width: 340px; height: 65vh; z-index: 20; background: white; }
      button { min-width: 180px; height: 44px; }
    </style>
    <main>
      <h1>Seat selection</h1>
      <p>Outbound flight</p>
      <button id="next-flight" disabled>Next flight</button>
    </main>
    <aside class="price-summary">
      <h2>Price breakdown</h2>
      <p>Flight total EUR 208</p>
      <button id="auto-seat">Choose seats for me</button>
      <button id="paid-seat">Choose seats manually 18 EUR</button>
    </aside>
  `);
  const traveler = {
    id: "trav_seat_fallback",
    first_name: "Ali",
    last_name: "SIFRAR",
    seat_policy: "random_assignment",
    booking_rules: "No paid seats"
  };
  await page.evaluate((profile) => window.__ATW_TEST__.setAppDataForTest({
    travelers: [profile],
    preferences: {}
  }, profile.id), traveler);

  const observation = await browserObservation(page, "obs_positioned_seat_summary");
  expect(observation.page.currentSurface.type).toBe("page");
  const automatic = observation.page.controls.find((control) => /choose seats for me/i.test(control.label || ""));
  const paid = observation.page.controls.find((control) => /choose seats manually/i.test(control.label || ""));
  expect(automatic).toBeTruthy();
  expect(automatic.surfaceId).toBe("surface-page");
  expect(paid).toBeTruthy();

  const taskState = reduceTaskState({
    observation,
    traveler,
    userPolicy: { bookingRules: traveler.booking_rules, seatPolicy: traveler.seat_policy }
  });
  expect(taskState.currentGoal?.kind).toBe("adaptive_interaction");
  expect(taskState.currentGoal.actionableControlIds).toContain(automatic.controlId);
  expect(taskState.currentGoal.actionableControlIds).not.toContain(paid.controlId);
  const candidates = buildCurrentCandidateSet({
    goal: taskState.currentGoal,
    observation,
    state: { taskState },
    traveler
  }).candidates;
  expect(candidates.map((candidate) => candidate.controlId)).toEqual([automatic.controlId]);
  expect(candidates[0].expectedOutcome?.type).toBeTruthy();
});

test("cabin-bag scope, paid option, and free skip compile into one safe governed outcome", async ({ page }) => {
  await loadHtmlProducer(page, `
    <style>body { font-family: sans-serif; padding: 24px; } button, label { min-height: 40px; }</style>
    <header>
      <button type="button">Edit Ljubljana to Edinburgh flight on 15th August 2026</button>
      <button type="button">Edit Edinburgh to Ljubljana flight on 22nd August 2026</button>
    </header>
    <main>
      <h1 id="stage">Cabin bags</h1>
      <section aria-label="Ali SIFRAR - Cabin bag allowance">
        <label><input id="same-all" type="checkbox" checked> Same for all flights</label>
        <article><h2>Small cabin bag</h2><p>Included under the seat</p></article>
        <article id="large-bag">
          <h2>Add a large cabin bag → Bring onboard</h2>
          <p>41.24 EUR</p>
          <button id="add-large" type="button">Add large cabin bag</button>
        </article>
      </section>
      <button id="skip-bags" type="button">Skip bags &gt;</button>
    </main>
    <script>
      document.getElementById("skip-bags").addEventListener("click", () => {
        document.getElementById("stage").textContent = "Hold luggage";
        document.getElementById("skip-bags").remove();
        document.body.dataset.stage = "hold-luggage";
        location.hash = "hold-luggage";
      });
    </script>
  `);
  const traveler = {
    id: "trav_cabin_bag",
    first_name: "Ali",
    last_name: "SIFRAR",
    baggage_preference: "No additional paid baggage",
    booking_rules: "No paid baggage or extras"
  };
  await page.evaluate((profile) => window.__ATW_TEST__.setAppDataForTest({
    travelers: [profile],
    preferences: {}
  }, profile.id), traveler);

  const observation = await browserObservation(page, "obs_cabin_bag_decision");
  const readiness = classifyObservationReadiness({ observation });
  expect(readiness.classification).toBe(READINESS.READY);
  const scope = observation.page.controls.find((control) => /same for all flights/i.test(control.ownText || control.label || ""));
  const add = observation.page.controls.find((control) => /add large cabin bag/i.test(control.ownText || ""));
  const skip = observation.page.controls.find((control) => /skip bags/i.test(control.ownText || control.label || ""));
  expect(scope).toMatchObject({ effectRole: "scope_toggle", structuredPrice: null });
  expect(add).toMatchObject({
    effectRole: "commerce_option",
    risk: "money",
    structuredPrice: { amount: 41.24, currency: "EUR" }
  });
  expect(skip?.effectRole).toBe("free_decline");
  expect(observation.page.transactionFacts.itinerary.segments).toEqual(expect.arrayContaining([
    expect.objectContaining({ origin: "LJUBLJANA", destination: "EDINBURGH" }),
    expect.objectContaining({ origin: "EDINBURGH", destination: "LJUBLJANA" })
  ]));
  expect(observation.page.transactionFacts.itinerary.segments.some((segment) => (
    /ADD|BAG/.test(segment.origin) || /ONBOARD|BAG/.test(segment.destination)
  ))).toBe(false);
  expect(observation.page.transactionFacts.selectedExtras.some((extra) => (
    extra.label === scope.label || extra.priceAmount === 41.24
  ))).toBe(false);

  const taskState = reduceTaskState({
    observation,
    traveler,
    userPolicy: { bookingRules: traveler.booking_rules, baggage: traveler.baggage_preference }
  });
  const candidateSet = buildCurrentCandidateSet({
    goal: taskState.currentGoal,
    observation,
    state: { taskState, approvals: {} },
    traveler
  });
  expect(candidateSet.candidates.some((candidate) => candidate.controlId === add.controlId)).toBe(false);
  const skipCandidate = candidateSet.candidates.find((candidate) => candidate.controlId === skip.controlId);
  expect(skipCandidate, JSON.stringify({ goal: taskState.currentGoal, candidateSet }, null, 2)).toBeTruthy();

  let state = createCheckoutSessionState({
    goal: "Reach payment review safely",
    travelerId: traveler.id,
    site: { host: "example.test", url: page.url() }
  });
  state.id = "txn_cabin_bag_decision";
  const authoritativeGoal = { ...taskState.currentGoal, candidateSet, candidates: candidateSet.candidates };
  state = {
    ...state,
    taskState: { ...taskState, currentGoal: authoritativeGoal },
    currentGoal: authoritativeGoal,
    currentObservation: {
      observationId: observation.observationId,
      observationHash: observation.observationSnapshot.snapshotHash
    }
  };
  const store = inMemoryGovernorStore();
  store.remember(state.id, observation);
  const action = loopPrivate.bindTargetSnapshot(
    actionForCurrentCandidate(authoritativeGoal, skipCandidate, observation),
    observation
  );
  const governed = governAction({ action, state, observation, traveler, store, turnId: "turn_skip_cabin_bags" });
  expect(governed.allow, `${governed.code}: ${governed.reason}`).toBe(true);
  const executed = await executeAtomicBrowserDecision(page, toClientDecision(governed.action), "obs_hold_luggage");
  expect(executed.validation.ok, executed.validation.code).toBe(true);
  expect(executed.verification.ok, JSON.stringify(executed.verification, null, 2)).toBe(true);
  expect(await page.locator("#stage").textContent()).toBe("Hold luggage");
});

test("nonblocking popover-shaped checkout chrome cannot veto the page Skip bags actuator", async ({ page }) => {
  await loadHtmlProducer(page, `
    <style>
      body { font-family: sans-serif; margin: 0; }
      .popover { position: absolute; inset: 0; min-height: 100vh; background: white; }
      button { min-width: 120px; min-height: 40px; }
    </style>
    <main class="popover">
      <h1>Add a large cabin bag to bring onboard</h1>
      <section aria-label="Ali SIFRAR - Cabin bag allowance">
        <label><input type="checkbox" checked> Same for all flights</label>
        <p>Small under seat bag Included for all passengers</p>
        <button type="button">Add large cabin bag for EUR 41.24</button>
      </section>
      <aside>
        <h2>Your current basket</h2>
        <p>Basket EUR 387.00 Price breakdown</p>
        <button id="skip-bags" type="button">Skip bags &gt;</button>
      </aside>
    </main>
  `);

  const traveler = {
    id: "trav_nonblocking_basket",
    first_name: "Ali",
    last_name: "SIFRAR",
    baggage_preference: "No additional paid baggage",
    booking_rules: "No paid baggage or extras"
  };
  await page.evaluate((profile) => window.__ATW_TEST__.setAppDataForTest({
    travelers: [profile],
    preferences: {}
  }, profile.id), traveler);

  const observation = await browserObservation(page, "obs_nonblocking_basket_skip");
  expect(observation.page.currentSurface).toMatchObject({
    id: "surface-page",
    type: "page",
    blocksBackground: false
  });
  expect(observation.page.surfaceStack).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: "popover", blocksBackground: false })
  ]));

  const skip = observation.page.controls.find((control) => /skip bags/i.test(control.label || ""));
  expect(skip, JSON.stringify(observation.page.controls, null, 2)).toBeTruthy();
  expect(skip.surfaceId).toBe("surface-page");
  expect(skip.operations?.activate?.actionability).toMatchObject({
    executable: true,
    inCurrentSurface: true,
    code: "ACTIONABLE"
  });

  const taskState = reduceTaskState({
    observation,
    traveler,
    userPolicy: { bookingRules: traveler.booking_rules, baggage: traveler.baggage_preference }
  });
  const candidateSet = buildCurrentCandidateSet({
    goal: taskState.currentGoal,
    observation,
    state: { taskState, approvals: {} },
    traveler
  });
  expect(candidateSet.candidates.some((candidate) => candidate.controlId === skip.controlId)).toBe(true);
});

test("zero-quantity hold-bag counters remain offers and progress through Skip bags", async ({ page }) => {
  await loadHtmlProducer(page, `
    <style>body { font-family: sans-serif; padding: 24px; } button { min-height: 40px; }</style>
    <nav>Pick flights Passenger details Seat selection Cabin bags Hold luggage Add-ons Checkout</nav>
    <main>
      <h1 id="stage">Add your hold bags now</h1>
      <section aria-label="Hold luggage options">
        <article aria-label="15kg hold bag">
          <h2>15kg hold bag</h2><p>€50.74 per flight</p>
          <button type="button" aria-label="Remove a 15kg bag" data-minus="q15">−</button>
          <output id="q15" class="quantity">0</output>
          <button type="button" aria-label="Add a 15kg bag">+</button>
        </article>
        <article aria-label="23kg hold bag">
          <h2>23kg hold bag</h2><p>€62.49 per flight</p>
          <button type="button" aria-label="Remove a 23kg bag" data-minus="q23">−</button>
          <output id="q23" class="quantity">0</output>
          <button type="button" aria-label="Add a 23kg bag">+</button>
        </article>
        <article aria-label="26kg hold bag">
          <h2>26kg hold bag</h2><p>€67.98 per flight</p>
          <button type="button" aria-label="Remove a 26kg bag" data-minus="q26">−</button>
          <output id="q26" class="quantity">0</output>
          <button type="button" aria-label="Add a 26kg bag">+</button>
        </article>
      </section>
      <button id="skip-bags" type="button">Skip bags &gt;</button>
    </main>
    <script>
      document.querySelectorAll("[data-minus]").forEach((button) => {
        button.addEventListener("click", () => {
          const output = document.getElementById(button.dataset.minus);
          output.textContent = String(Math.max(0, Number(output.textContent || 0) - 1));
        });
      });
      document.getElementById("skip-bags").addEventListener("click", () => {
        document.getElementById("stage").textContent = "Add-ons";
        document.getElementById("skip-bags").remove();
        document.body.dataset.stage = "add-ons";
      });
    </script>
  `);
  const traveler = {
    id: "trav_zero_hold_bags",
    first_name: "Ali",
    last_name: "SIFRAR",
    baggage_preference: "No additional paid baggage",
    booking_rules: "No paid baggage or extras"
  };
  await page.evaluate((profile) => window.__ATW_TEST__.setAppDataForTest({
    travelers: [profile],
    preferences: {}
  }, profile.id), traveler);

  const observation = await browserObservation(page, "obs_zero_hold_bags");
  expect(observation.page.step).toBe("extras");
  expect(classifyObservationReadiness({ observation }).classification).toBe(READINESS.READY);
  const skip = observation.page.controls.find((control) => /skip bags/i.test(control.label || control.ownText || ""));
  const removals = observation.page.controls.filter((control) => /remove a \d+kg bag/i.test(control.label || control.accessibleName || ""));
  expect(skip).toBeTruthy();
  expect(removals).toHaveLength(3);
  expect(removals.some((control) => control.semantic === "remove_paid_extra")).toBe(false);
  expect(observation.page.decisionGroups.some((group) => (
    group.selectedEvidence?.selected === true
    && /bag|luggage/i.test(`${group.sectionType || ""} ${group.sectionLabel || ""}`)
  ))).toBe(false);
  expect(observation.page.transactionFacts.selectedExtras.some((extra) => (
    [50.74, 62.49, 67.98].includes(Number(extra.priceAmount))
  ))).toBe(false);

  const taskState = reduceTaskState({
    observation,
    traveler,
    userPolicy: { bookingRules: traveler.booking_rules, baggage: traveler.baggage_preference }
  });
  const candidateSet = buildCurrentCandidateSet({
    goal: taskState.currentGoal,
    observation,
    state: { taskState, approvals: {} },
    traveler
  });
  expect(candidateSet.candidates.some((candidate) => removals.some((control) => control.controlId === candidate.controlId))).toBe(false);
  const skipCandidate = candidateSet.candidates.find((candidate) => candidate.controlId === skip.controlId);
  expect(skipCandidate, JSON.stringify({ goal: taskState.currentGoal, candidateSet }, null, 2)).toBeTruthy();

  let state = createCheckoutSessionState({
    goal: "Reach payment review safely",
    travelerId: traveler.id,
    site: { host: "example.test", url: page.url() }
  });
  state.id = "txn_zero_hold_bags";
  const authoritativeGoal = { ...taskState.currentGoal, candidateSet, candidates: candidateSet.candidates };
  state = {
    ...state,
    taskState: { ...taskState, currentGoal: authoritativeGoal },
    currentGoal: authoritativeGoal,
    currentObservation: {
      observationId: observation.observationId,
      observationHash: observation.observationSnapshot.snapshotHash
    }
  };
  const store = inMemoryGovernorStore();
  store.remember(state.id, observation);
  const action = loopPrivate.bindTargetSnapshot(
    actionForCurrentCandidate(authoritativeGoal, skipCandidate, observation),
    observation
  );
  const governed = governAction({ action, state, observation, traveler, store, turnId: "turn_skip_zero_hold_bags" });
  expect(governed.allow, `${governed.code}: ${governed.reason}`).toBe(true);
  const executed = await executeAtomicBrowserDecision(page, toClientDecision(governed.action), "obs_after_zero_hold_bags");
  expect(executed.validation.ok, executed.validation.code).toBe(true);
  expect(executed.verification.ok, JSON.stringify(executed.verification, null, 2)).toBe(true);
  expect(await page.locator("#stage").textContent()).toBe("Add-ons");
});

test("split state and actuator nodes compile into one owned traveler-title decision", async ({ page }) => {
  await loadHtmlProducer(page, `
    <style>
      body { font-family: sans-serif; padding: 24px; }
      .title-group { display: flex; gap: 12px; }
      .title-option { display: flex; align-items: center; gap: 8px; width: 130px; height: 48px; border: 1px solid #777; }
      .title-actuator { width: 26px; height: 26px; }
    </style>
    <main>
      <h1>Passenger information</h1>
      <section aria-label="Passenger title">
        <p id="title-form-description" hidden>Mr. Ms. First / Middle name (as shown on ID) Surname (as shown on ID)</p>
        <div class="title-group" aria-required="true">
          <div id="title-mr-state" class="title-option" role="radio" aria-checked="false"
            aria-describedby="title-form-description">
            <span>Mr.</span>
            <button id="title-mr-actuator" class="title-actuator" type="button" role="checkbox" aria-checked="false"></button>
          </div>
          <div id="title-ms-state" class="title-option" role="radio" aria-checked="false"
            aria-describedby="title-form-description">
            <span>Mrs/Ms</span>
            <button id="title-ms-actuator" class="title-actuator" type="button" role="checkbox" aria-checked="false"></button>
          </div>
        </div>
      </section>
    </main>
    <script>
      document.querySelectorAll('.title-actuator').forEach((actuator) => {
        actuator.addEventListener('click', () => {
          document.querySelectorAll('.title-option').forEach((option) => {
            const selected = option.contains(actuator);
            option.setAttribute('aria-checked', String(selected));
            option.querySelector('.title-actuator').setAttribute('aria-checked', String(selected));
          });
        });
      });
    </script>
  `);
  const profile = { id: "trav_split_title", gender: "male" };
  await page.evaluate((traveler) => window.__ATW_TEST__.setAppDataForTest({
    travelers: [traveler],
    preferences: {}
  }, traveler.id), profile);

  const observation = await browserObservation(page, "obs_split_title_initial");
  observation.page.step = "traveler_information";
  const titleControls = observation.page.controls.filter((control) => control.fieldType === "title");
  const titleGroups = new Set(titleControls.map((control) => control.decisionGroupId));
  const titleDecision = observation.page.decisionGroups.find((group) => (
    (group.alternativeControlIds || []).includes(titleControls[0]?.controlId)
  ));
  const mr = titleControls.find((control) => control.state?.optionValue === "mr");
  const ms = titleControls.find((control) => control.state?.optionValue === "mrs/ms");

  expect(titleControls, JSON.stringify(observation.page.controls.map((control) => ({
    label: control.label,
    kind: control.kind,
    fieldType: control.fieldType,
    classification: control.fieldClassification,
    decisionGroupId: control.decisionGroupId,
    stateElementId: control.stateElementId,
    preferredActivationElementId: control.preferredActivationElementId,
    choiceContract: control.choiceContract
  })), null, 2)).toHaveLength(2);
  expect(titleGroups.size).toBe(1);
  expect(titleDecision).toMatchObject({
    sectionType: "title",
    sectionLabel: "title",
    requirementId: "title:title",
    required: true
  });
  expect(mr, JSON.stringify(titleControls, null, 2)).toBeTruthy();
  expect(ms, JSON.stringify(titleControls, null, 2)).toBeTruthy();
  expect(mr?.fieldClassification).toMatchObject({
    fieldType: "title",
    source: "owned_exclusive_option_set"
  });
  expect(mr?.choiceContract).toMatchObject({ ownershipComplete: true, optionCount: 2 });
  expect(ms?.choiceContract).toMatchObject({ ownershipComplete: true, optionCount: 2 });
  expect(mr?.stateElementId).toBe(await page.locator("#title-mr-state").getAttribute("data-atw-element-id"));
  expect(mr?.operations?.choose?.actuatorId).toBe(await page.locator("#title-mr-actuator").getAttribute("data-atw-element-id"));
  expect(observation.page.controls.filter((control) => (
    control.fieldType === ""
    && control.decisionGroupId
    && /passenger.*passenger/i.test(control.decisionGroupId)
    && /mr|mrs|ms/i.test(control.label)
  ))).toEqual([]);

  const goal = deriveProfileGoal(observation, profile);
  const candidates = candidatesForProfileGoal(goal, observation, profile);
  expect(goal).toMatchObject({ semanticType: "title", desiredValue: "mr" });
  expect(candidates).toHaveLength(1);
  expect(candidates[0]).toMatchObject({
    controlId: mr.controlId,
    operation: "choose",
    targetId: mr.operations.choose.actuatorId
  });

  const selectedAction = actionForProfileCandidate(goal, candidates[0], observation);
  const selected = await executeAtomicBrowserDecision(
    page,
    toClientDecision(selectedAction),
    "obs_split_title_selected"
  );
  expect(selected.result.dispatched).toBe(true);
  expect(selected.verification.ok, JSON.stringify(selected.verification)).toBe(true);
  expect(resolveLogicalFields(selected.observation.page, profile)
    .find((field) => field.semanticType === "title")?.currentCanonicalValue).toBe("mr");
});

test("profile scheduling follows visual order and composite dependencies", async ({ page }) => {
  await loadHtmlProducer(page, `
    <main>
      <h1>Passenger information</h1>
      <fieldset role="radiogroup" aria-label="Title" aria-required="true">
        <label><input type="radio" name="title" value="mr" required> Mr.</label>
        <label><input type="radio" name="title" value="ms"> Ms.</label>
      </fieldset>
      <label>First / Middle name (as shown on ID)<input name="first_name" required></label>
      <label>Surname (as shown on ID)<input name="last_name" required></label>
      <label>Date of birth (Day/Month/Year)<input name="date_of_birth" required></label>
      <section aria-label="Contact details">
        <label>Mobile number<input name="phone" type="tel" required></label>
        <button id="country-code-ordering" type="button" aria-label="Select country phone code"
          aria-haspopup="listbox" aria-controls="country-options-ordering" aria-required="true">Select</button>
      </section>
      <div id="country-options-ordering" role="listbox" hidden>
        <button type="button" role="option" data-value="+386">Slovenia (+386)</button>
      </div>
    </main>
  `);
  const traveler = {
    id: "trav_profile_ordering",
    first_name: "Ali",
    last_name: "SIFRAR",
    gender: "male",
    date_of_birth: "2003-05-31",
    phone_country_code: "+386",
    phone: "70328922",
    nationality: "Slovenia"
  };
  const observation = await browserObservation(page, "obs_profile_ordering");
  observation.page.step = "traveler_information";
  const descriptors = fieldDescriptors(observation, traveler).filter((descriptor) => !descriptor.hasValue);
  expect(descriptors[0]?.semanticType).toBe("title");
  expect(descriptors.findIndex((descriptor) => descriptor.semanticType === "phone_country_code"))
    .toBeLessThan(descriptors.findIndex((descriptor) => descriptor.semanticType === "phone"));
  expect(deriveProfileGoal(observation, traveler)).toMatchObject({ semanticType: "title", desiredValue: "mr" });
});

test("stage advancement prefers governed browser-level pointer input", async ({ page }) => {
  await page.goto("http://127.0.0.1:4273/checkout/extras");
  await loadHtmlProducer(page, `
    <main><h1 id="stage-heading">Optional extras</h1><button id="trusted-continue" type="button">Continue</button></main>
  `);
  await page.evaluate(() => {
    window.__ATW_TEST_TRUSTED_INPUT__ = ({ element }) => {
      window.__trustedStageTarget = element.id;
      history.pushState({}, "", "/checkout/traveler");
      document.getElementById("stage-heading").textContent = "Traveller information";
      return { ok: true };
    };
  });
  const observation = await browserObservation(page, "obs_trusted_stage_before");
  observation.page.step = "extras";
  const goal = deriveObservationGoal(observation, []);
  const candidateSet = buildCurrentCandidateSet({
    goal,
    observation,
    state: { taskState: { currentGoal: goal }, approvals: {} }
  });
  expect(candidateSet.candidates).toHaveLength(1);
  expect(candidateSet.candidates[0]).toMatchObject({
    intent: "navigate_stage",
    operation: "activate",
    interactionMethod: "browser_trusted_input",
    physicalEffect: "advance_checkout_stage"
  });
  const result = await executeAtomicBrowserDecision(
    page,
    toClientDecision(loopPrivate.bindTargetSnapshot(
      actionForCurrentCandidate(goal, candidateSet.candidates[0], observation),
      observation
    )),
    "obs_trusted_stage_after"
  );
  expect(result.verification.ok, JSON.stringify(result.verification)).toBe(true);
  expect(await page.evaluate(() => window.__trustedStageTarget)).toBe("trusted-continue");
  expect(new URL(result.observation.page.url).pathname).toBe("/checkout/traveler");
});

test("stage exit preserves every Continue representation and advances through the executable candidate", async ({ page }) => {
  await loadHtmlProducer(page, `
    <style>
      body { font-family: sans-serif; }
      #covered-continue { position: fixed; left: 40px; top: 120px; width: 180px; height: 48px; }
      #site-overlay { position: fixed; left: 35px; top: 115px; width: 190px; height: 58px; z-index: 10; background: white; }
      #working-continue { position: fixed; left: 40px; top: 220px; width: 180px; height: 48px; }
    </style>
    <main>
      <h1 id="stage-heading">Passenger details</h1>
      <button id="covered-continue" type="button">Continue</button>
      <div id="site-overlay" aria-label="Site help overlay"></div>
      <button id="working-continue" type="button">Continue</button>
    </main>
  `);
  await page.evaluate(() => {
    document.getElementById("working-continue").addEventListener("click", () => {
      window.__workingContinueClicked = true;
      document.getElementById("stage-heading").textContent = "Seat selection";
    });
  });

  const observation = await browserObservation(page, "obs_continue_candidate_set_before");
  observation.page.step = "traveler_information";
  const candidates = observation.page.stageExit.candidates;
  expect(candidates).toHaveLength(2);
  expect(candidates.some((candidate) => (
    candidate.status === "occluded"
    && candidate.code === "ACTUATOR_OCCLUDED"
    && candidate.hitTestEvidence?.topElement?.id === "site-overlay"
  ))).toBe(true);
  expect(candidates.some((candidate) => candidate.status === "ready" && candidate.executable === true)).toBe(true);
  const readyStageExitCandidate = candidates.find((candidate) => candidate.status === "ready");
  const workingControl = observation.page.controls.find((control) => (
    control.controlId === readyStageExitCandidate.controlId
  ));
  expect(observation.page.stageExit).toMatchObject({
    continueAllowed: true,
    navigationState: "ready"
  });

  const taskState = reduceTaskState({ observation });
  expect(taskState.currentGoal).toMatchObject({ semanticType: "navigation" });
  expect(taskState.currentGoal.actionableControlIds).toContain(workingControl.controlId);
  const candidateSet = buildCurrentCandidateSet({
    goal: taskState.currentGoal,
    observation,
    state: { taskState, approvals: {} }
  });
  expect(candidateSet.candidates.every((candidate) => candidate.controlId === workingControl.controlId)).toBe(true);
  const result = await executeAtomicBrowserDecision(
    page,
    toClientDecision(loopPrivate.bindTargetSnapshot(
      actionForCurrentCandidate(taskState.currentGoal, candidateSet.candidates[0], observation),
      observation
    )),
    "obs_continue_candidate_set_after"
  );
  expect(result.verification.ok, JSON.stringify(result.verification)).toBe(true);
  expect(await page.evaluate(() => window.__workingContinueClicked)).toBe(true);
});

test("agent-owned UI is transparent to governed site hit-testing and dispatch", async ({ page }) => {
  await loadHtmlProducer(page, `
    <main>
      <h1 id="stage-heading">Passenger details</h1>
      <button id="site-continue" type="button" style="position:fixed;right:30px;top:120px;width:180px;height:48px">Continue</button>
    </main>
  `);
  await page.evaluate(() => {
    const sidebar = document.getElementById("atw-sidebar") || document.body.appendChild(
      Object.assign(document.createElement("aside"), { id: "atw-sidebar" })
    );
    Object.assign(sidebar.style, {
      display: "block",
      position: "fixed",
      right: "0px",
      top: "0px",
      width: "300px",
      height: "320px",
      zIndex: "2147483647",
      pointerEvents: "auto",
      background: "rgba(0,0,0,.8)"
    });
    const cover = document.createElement("label");
    cover.textContent = "Agent status";
    Object.assign(cover.style, { display: "block", width: "100%", height: "100%", pointerEvents: "auto" });
    sidebar.replaceChildren(cover);
    document.getElementById("site-continue").addEventListener("click", () => {
      window.__selfOccludedContinueClicked = true;
      document.getElementById("stage-heading").textContent = "Seat selection";
    });
    window.__ATW_TEST_TRUSTED_INPUT__ = ({ element, x, y }) => {
      window.__agentPointerEventsAtDispatch = getComputedStyle(document.getElementById("atw-sidebar")).pointerEvents;
      const eventInit = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 };
      element.dispatchEvent(new MouseEvent("click", eventInit));
      return { ok: true };
    };
  });

  const observation = await browserObservation(page, "obs_agent_ui_isolation_before");
  observation.page.step = "traveler_information";
  const stageCandidate = observation.page.stageExit.candidates.find((candidate) => candidate.status === "ready");
  expect(stageCandidate).toBeTruthy();
  expect(stageCandidate.hitTestEvidence).toMatchObject({
    clear: true,
    selfOccluded: true,
    topElement: { agentOwned: true },
    underlyingElement: { id: "site-continue", agentOwned: false }
  });

  const taskState = reduceTaskState({ observation });
  const candidateSet = buildCurrentCandidateSet({
    goal: taskState.currentGoal,
    observation,
    state: { taskState, approvals: {} }
  });
  expect(candidateSet.candidates).toHaveLength(1);
  // Model a background tab where requestAnimationFrame may never be serviced.
  // Agent/page isolation must not make trusted dispatch depend on tab focus.
  await page.evaluate(() => { window.requestAnimationFrame = () => 1; });
  const result = await executeAtomicBrowserDecision(
    page,
    toClientDecision(loopPrivate.bindTargetSnapshot(
      actionForCurrentCandidate(taskState.currentGoal, candidateSet.candidates[0], observation),
      observation
    )),
    "obs_agent_ui_isolation_after"
  );
  expect(result.verification.ok, JSON.stringify(result.verification)).toBe(true);
  expect(await page.evaluate(() => window.__agentPointerEventsAtDispatch)).toBe("none");
  expect(await page.evaluate(() => getComputedStyle(document.getElementById("atw-sidebar")).pointerEvents)).toBe("auto");
  expect(await page.evaluate(() => window.__selfOccludedContinueClicked)).toBe(true);
});

test("semantic completeness admits only the unfinished phone component before exact Continue", async ({ page }) => {
  await loadHtmlProducer(page, `
    <style>
      body { font-family: sans-serif; margin: 0; }
      header, main, footer { padding: 18px; }
      label { display: block; margin: 8px 0; }
      #phone-options { position: fixed; left: 18px; top: 310px; width: 260px; max-height: 180px; overflow-y: auto; background: white; border: 1px solid #444; z-index: 20; }
      #phone-options[hidden] { display: none; }
      #phone-options button { display: block; width: 100%; min-height: 36px; }
    </style>
    <header><button id="select-flight" type="button">Select flight</button></header>
    <main>
      <h1>Passenger information</h1>
      <section aria-label="Passenger information">
        <fieldset role="radiogroup" aria-label="Title" aria-required="true">
          <label><input type="radio" name="title" value="mr" checked required> Mr.</label>
          <label><input type="radio" name="title" value="ms"> Ms.</label>
        </fieldset>
        <label>First / Middle name (as shown on ID)<input name="first_name" value="ALI" required></label>
        <label>Surname (as shown on ID)<input name="last_name" value="SIFRAR" required></label>
        <label>Date of birth (Day/Month/Year)<input name="date_of_birth" value="31/05/2003" required></label>
        <label><input type="checkbox" id="turkish-citizen"> Turkish citizen</label>
      </section>
      <section aria-label="Contact details">
        <label>Email address<input name="email" type="email" value="ali@aztela.com" required></label>
        <div aria-label="Mobile number">
          <button id="country-code" type="button" aria-label="Select country phone code" aria-haspopup="listbox"
            aria-controls="phone-options" aria-expanded="false" aria-required="true">Select</button>
          <input name="phone" type="tel" value="70328922" required>
        </div>
        <label><input type="checkbox" id="sms-marketing"> I allow notifications via SMS.</label>
        <label><input type="checkbox" id="email-marketing"> I allow notifications via email.</label>
        <label><input type="checkbox" id="loyalty-enrollment"> Become a member of Miles&amp;Smiles!</label>
      </section>
    </main>
    <div id="phone-options" role="listbox" aria-label="Country phone code" hidden>
      ${Array.from({ length: 30 }, (_, index) => (
        `<button id="phone-other-${index}" type="button" role="option" data-value="+${100 + index}">Country ${index + 1} (+${100 + index})</button>`
      )).join("")}
      <button id="phone-si" type="button" role="option" data-value="+386">Slovenia (+386)</button>
      <button id="phone-tr" type="button" role="option" data-value="+90">Türkiye (+90)</button>
    </div>
    <footer><button id="continue" type="button">Continue</button></footer>
    <script>
      const country = document.getElementById('country-code');
      const options = document.getElementById('phone-options');
      country.addEventListener('click', () => {
        options.hidden = false;
        country.setAttribute('aria-expanded', 'true');
      });
      document.getElementById('phone-si').addEventListener('click', () => {
        country.textContent = 'Slovenia (+386)';
        country.setAttribute('aria-label', 'Country phone code Slovenia +386');
        country.setAttribute('aria-expanded', 'false');
        options.hidden = true;
      });
    </script>
  `);
  const traveler = {
    id: "trav_semantic_completeness",
    first_name: "Ali",
    last_name: "SIFRAR",
    gender: "male",
    date_of_birth: "2003-05-31",
    email: "ali@aztela.com",
    phone_country_code: "+386",
    phone: "70328922",
    nationality: "Slovenia",
    booking_rules: "No paid extras"
  };
  await page.evaluate((profile) => window.__ATW_TEST__.setAppDataForTest({
    travelers: [profile],
    preferences: {}
  }, profile.id), traveler);

  const before = await browserObservation(page, "obs_semantic_completeness_before");
  before.page.step = "traveler_information";
  const countryCode = before.page.controls.find((control) => control.fieldType === "phone_country_code");
  const falseRepeatedGroup = before.page.decisionGroups.find((group) => {
    const labels = (group.alternatives || []).map((option) => option.label).join(" ");
    return /select flight/i.test(labels) && /country phone code/i.test(labels);
  });
  expect(countryCode, JSON.stringify(before.page.controls.map((control) => ({
    label: control.label,
    fieldType: control.fieldType,
    sectionId: control.sectionId,
    operations: Object.keys(control.operations || {})
  })), null, 2)).toBeTruthy();
  expect(countryCode.operations.open?.actionability?.executable).toBe(true);
  expect(countryCode.operations.activate).toBeFalsy();
  expect(falseRepeatedGroup).toBeFalsy();

  const beforeTask = reduceTaskState({ observation: before, traveler });
  expect(beforeTask.currentGoal).toMatchObject({
    semanticType: "phone_country_code",
    componentRole: "country_code"
  });
  const optionalLabels = /turkish citizen|notifications via|member of miles/i;
  expect(beforeTask.canonicalDecisions.filter((decision) => (
    optionalLabels.test(`${decision.subject?.label || ""} ${decision.observed?.selectedLabel || ""} ${
      (decision.observed?.alternatives || []).map((option) => option.label).join(" ")
    }`)
  )).every((decision) => ["waived", "satisfied"].includes(decision.status))).toBe(true);

  const openerSet = buildCurrentCandidateSet({
    goal: beforeTask.currentGoal,
    observation: before,
    traveler,
    state: { taskState: beforeTask, approvals: {} }
  });
  const openerCandidate = openerSet.candidates.find((candidate) => candidate.operation === "open");
  expect(openerCandidate).toMatchObject({
    controlId: countryCode.controlId,
    operation: "open"
  });
  const opened = await executeAtomicBrowserDecision(
    page,
    toClientDecision(loopPrivate.bindTargetSnapshot(
      actionForCurrentCandidate(beforeTask.currentGoal, openerCandidate, before),
      before
    )),
    "obs_semantic_completeness_opened"
  );
  expect(opened.verification.ok, JSON.stringify(opened.verification)).toBe(true);
  opened.observation.page.step = "traveler_information";

  const adaptiveTask = reduceTaskState({
    previousTaskState: beforeTask,
    observation: opened.observation,
    previousActionResult: opened.observation.lastActionResult,
    traveler
  });
  expect(adaptiveTask.currentGoal).toMatchObject({
    kind: "adaptive_surface",
    semanticType: "phone_country_code",
    desiredValue: "+386"
  });
  const adaptiveSet = buildCurrentCandidateSet({
    goal: adaptiveTask.currentGoal,
    observation: opened.observation,
    traveler,
    state: { taskState: adaptiveTask, approvals: {} }
  });
  expect(adaptiveSet.candidates).toEqual([]);
  const hiddenSlovenia = adaptiveSet.recoveryCandidates.find((candidate) => /slovenia|386/i.test(candidate.targetLabel));
  expect(hiddenSlovenia, JSON.stringify(adaptiveSet.contextCapabilities, null, 2)).toBeTruthy();
  expect(adaptiveSet.recoveryCandidates).toHaveLength(1);
  expect(hiddenSlovenia).toMatchObject({ executionChannel: "reveal", requiresJudgment: false });
  expect(adaptiveSet.contextCapabilities.some((candidate) => (
    candidate.selectable === true && !/slovenia|386/i.test(candidate.targetLabel)
  ))).toBe(false);
  const scheduledHiddenSet = groundedObservationCandidateSet(
    adaptiveTask.currentGoal,
    opened.observation,
    [],
    { state: { taskState: adaptiveTask, approvals: {} }, traveler, approvals: {} }
  );
  expect(scheduledHiddenSet.candidates).toHaveLength(1);
  expect(scheduledHiddenSet.candidates[0]).toMatchObject({
    controlId: hiddenSlovenia.controlId,
    executionChannel: "reveal"
  });

  // Turkish-style portalled listboxes keep their visible filter beside the
  // list and point to it through aria-controls. That reverse ownership must
  // prefer one exact deterministic type over scrolling the hidden option.
  await page.evaluate(() => {
    const search = document.createElement("input");
    search.id = "phone-search";
    search.setAttribute("role", "combobox");
    search.setAttribute("aria-label", "Search country code");
    search.setAttribute("aria-controls", "phone-options");
    search.placeholder = "Search";
    Object.assign(search.style, { position: "fixed", left: "18px", top: "270px", width: "250px", height: "32px", zIndex: "21" });
    search.addEventListener("input", () => {
      const query = search.value.trim().toLowerCase();
      const exactQuery = query === "386" || query === "slovenia";
      document.querySelectorAll("#phone-options [role='option']").forEach((option) => {
        option.hidden = exactQuery ? option.id !== "phone-si" : true;
        option.style.display = option.hidden ? "none" : "block";
      });
    });
    document.body.appendChild(search);
  });
  const searchable = await browserObservation(page, "obs_semantic_completeness_searchable");
  searchable.page.step = "traveler_information";
  const searchControl = searchable.page.controls.find((control) => /search country code/i.test(control.label || ""));
  expect(searchControl).toMatchObject({
    surfaceId: searchable.page.currentSurface.id,
    surfaceMembershipEvidence: "reverse_aria_owned_surface"
  });
  const ownershipResolution = await page.evaluate((filterControl) => {
    const filterNodeId = filterControl.stateElementId;
    const broadOpener = {
      controlId: "ctrl_broad_phone_opener",
      stateElementId: "atw-broad-phone-opener",
      preferredActivationElementId: "atw-broad-phone-opener",
      operations: {
        open: {
          actuatorIds: ["atw-broad-phone-opener", filterNodeId]
        }
      }
    };
    const competingAtomicOwner = {
      controlId: "ctrl_competing_atomic_owner",
      stateElementId: filterNodeId,
      preferredActivationElementId: filterNodeId,
      operations: {
        type: { actuatorIds: [filterNodeId] }
      }
    };
    return {
      broadWinner: window.__ATW_TEST__.narrowerExactControlOwner(filterControl, broadOpener)?.controlId || "",
      trueConflictWinner: window.__ATW_TEST__.narrowerExactControlOwner(filterControl, competingAtomicOwner)?.controlId || ""
    };
  }, searchControl);
  expect(ownershipResolution).toEqual({
    broadWinner: searchControl.controlId,
    trueConflictWinner: ""
  });
  const searchableSet = buildCurrentCandidateSet({
    goal: adaptiveTask.currentGoal,
    observation: searchable,
    traveler,
    state: { taskState: adaptiveTask, approvals: {} }
  });
  expect(searchableSet.candidates).toHaveLength(1);
  expect(searchableSet.candidates[0]).toMatchObject({
    controlId: searchControl.controlId,
    operation: "type",
    value: "386",
    physicalEffect: "filter_options",
    expectedOutcome: {
      type: "semantic_progress",
      canonicalTarget: "+386"
    },
    requiresJudgment: false
  });
  expect(searchableSet.recoveryCandidates).toEqual([]);
  const filtered = await executeAtomicBrowserDecision(
    page,
    toClientDecision(loopPrivate.bindTargetSnapshot(
      actionForCurrentCandidate(adaptiveTask.currentGoal, searchableSet.candidates[0], searchable),
      searchable
    )),
    "obs_semantic_completeness_filtered"
  );
  expect(filtered.verification).toMatchObject({ ok: true, code: "SEMANTIC_PROGRESS_OBSERVED" });
  filtered.observation.page.step = "traveler_information";
  expect(profileStageReadiness(filtered.observation, traveler).ready).toBe(false);
  const filteredTask = reduceTaskState({
    previousTaskState: adaptiveTask,
    observation: filtered.observation,
    previousActionResult: filtered.observation.lastActionResult,
    traveler
  });
  expect(filteredTask.currentGoal).toMatchObject({
    semanticType: "phone_country_code",
    desiredValue: "+386"
  });
  expect(["adaptive_surface", "profile_field"]).toContain(filteredTask.currentGoal.kind);
  if (filteredTask.currentGoal.kind === "adaptive_surface") {
    expect(filteredTask.currentGoal.adaptiveEnvelope.queryHistory).toEqual(["386"]);
  }
  const filteredSet = buildCurrentCandidateSet({
    goal: filteredTask.currentGoal,
    observation: filtered.observation,
    traveler,
    state: { taskState: filteredTask, approvals: {} }
  });
  const sloveniaCandidate = filteredSet.candidates.find((candidate) => (
    candidate.exactOption?.canonicalValue === "+386"
    || candidate.expectedOutcome?.expectedNormalizedValue === "+386"
  ));
  expect(sloveniaCandidate, JSON.stringify(filteredSet.contextCapabilities, null, 2)).toBeTruthy();
  expect(filteredSet.candidates).toHaveLength(1);
  const adaptiveDecision = toClientDecision(loopPrivate.bindTargetSnapshot(
    actionForCurrentCandidate(filteredTask.currentGoal, sloveniaCandidate, filtered.observation),
    filtered.observation
  ));
  expect(adaptiveDecision.expectedOutcome).toMatchObject({
    type: "logical_component_committed",
    semanticType: "phone_country_code",
    componentRole: "country_code",
    expectedNormalizedValue: "+386"
  });
  const selected = await executeAtomicBrowserDecision(
    page,
    adaptiveDecision,
    "obs_semantic_completeness_after"
  );
  expect(selected.verification.ok, JSON.stringify(selected.verification)).toBe(true);
  const after = selected.observation;
  after.page.step = "traveler_information";
  expect(profileStageReadiness(after, traveler).ready).toBe(true);
  expect(after.page.stageExit, JSON.stringify({
    stageExit: after.page.stageExit,
    decisionGroups: after.page.decisionGroups.map((group) => ({
      label: group.sectionLabel,
      required: group.required,
      status: group.status
    })),
    fields: (after.page.controls || []).filter((control) => control.required).map((control) => ({
      field: control.fieldType || control.semantic,
      label: control.label,
      hasValue: control.state?.valuePresent
    })),
    overlays: after.page.overlays
  }, null, 2)).toMatchObject({
    continueAllowed: true,
    navigationState: "ready"
  });
  const afterTask = reduceTaskState({
    previousTaskState: filteredTask,
    observation: after,
    previousActionResult: after.lastActionResult,
    traveler
  });
  expect(afterTask.currentGoal).toMatchObject({ semanticType: "navigation" });
  expect(afterTask.currentGoal.actionableControlIds).toContain(
    after.page.controls.find((control) => control.semantic === "continue")?.controlId
  );
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

test("profile field meaning and exact radio value survive compact transport and incremental caching", async ({ page }) => {
  await loadProducer(page, profileFixturePath);
  const result = await page.evaluate(() => {
    const hooks = window.__ATW_TEST__;
    const form = document.getElementById("traveler-form");
    form.insertAdjacentHTML("beforeend", `
      <label><input id="sms-offer" name="sms_updates" type="checkbox"> SMS alerts</label>
      <fieldset><legend>Mobile travel plan</legend>
        <label><input id="mobile-plan" name="mobile_travel_plan" type="radio"> Add plan</label>
      </fieldset>
    `);
    const mr = document.getElementById("title-mr");
    const mrs = document.getElementById("title-ms");
    mrs.checked = true;
    const beforeObserved = hooks.observePageState({ forceFull: true, reason: "profile_wrong_title" });
    const before = beforeObserved.map;
    const compactBefore = hooks.compactPageMap(before);
    const beforeMr = before.controls.find((control) => control.stateElementId === mr.dataset.atwElementId);
    const beforeMrs = before.controls.find((control) => control.stateElementId === mrs.dataset.atwElementId);
    mr.click();
    hooks.notePageEvent({ type: "change", target: mr });
    hooks.notePageEvent({ type: "change", target: mrs });
    const afterObserved = hooks.observePageState({ reason: "profile_title_corrected" });
    const after = afterObserved.map;
    const afterMr = after.controls.find((control) => control.controlId === beforeMr.controlId);
    const afterMrs = after.controls.find((control) => control.controlId === beforeMrs.controlId);
    const compact = hooks.compactPageMap(after);
    const compactMr = compact.controls.find((control) => control.controlId === beforeMr.controlId);
    const verification = hooks.verifyExpectedOutcome({
      type: "control_selected",
      controlId: beforeMr.controlId,
      decisionGroupId: beforeMr.decisionGroupId,
      expectedSelectedControlId: beforeMr.controlId,
      conflictingControlIds: [beforeMrs.controlId]
    }, before, after, mr);
    const sms = after.controls.find((control) => control.stateElementId === document.getElementById("sms-offer").dataset.atwElementId);
    const mobilePlan = after.controls.find((control) => control.stateElementId === document.getElementById("mobile-plan").dataset.atwElementId);
    mr.checked = false;
    mrs.checked = false;
    hooks.notePageEvent({ type: "change", target: mr });
    hooks.notePageEvent({ type: "change", target: mrs });
    const emptyObserved = hooks.observePageState({ reason: "profile_title_empty" });
    const compactEmpty = hooks.compactPageMap(emptyObserved.map);
    const profileSlice = (page) => ({
      ...page,
      controls: page.controls.filter((control) => control.fieldType === "title"),
      decisionGroups: page.decisionGroups.filter((group) => (
        group.alternativeControlIds || []
      ).some((controlId) => page.controls.some((control) => control.controlId === controlId && control.fieldType === "title")))
    });
    return {
      beforeValues: [beforeMr.state.optionValue, beforeMrs.state.selectedValue],
      incrementalMode: afterObserved.mode,
      fieldType: afterMr.fieldType,
      classificationSource: afterMr.fieldClassification?.source || "",
      selectedValue: afterMr.state.selectedValue,
      conflictingSelectedValue: afterMrs.state.selectedValue,
      compactFieldType: compactMr.fieldType,
      compactSelectedValue: compactMr.state.selectedValue,
      verified: verification.ok,
      smsFieldType: sms?.fieldType || "",
      mobilePlanFieldType: mobilePlan?.fieldType || "",
      compactWrongMrs: profileSlice(compactBefore),
      compactCorrectMr: profileSlice(compact),
      compactNoTitle: profileSlice(compactEmpty)
    };
  });

  expect(result.beforeValues).toEqual(["mr", "mrs/ms"]);
  expect(result.incrementalMode).toBe("incremental");
  expect(result.fieldType).toBe("title");
  expect(result.classificationSource).toBeTruthy();
  expect(result.selectedValue).toBe("mr");
  expect(result.conflictingSelectedValue).toBe("");
  expect(result.compactFieldType).toBe("title");
  expect(result.compactSelectedValue).toBe("mr");
  expect(result.verified).toBe(true);
  expect(result.smsFieldType).toBe("");
  expect(result.mobilePlanFieldType).toBe("");

  const observation = (page, observationId) => ({
    observationId,
    observationSnapshot: { snapshotHash: page.snapshotHash || observationId },
    page: { ...page, step: "traveler_information" }
  });
  const profile = {
    first_name: "Ali", last_name: "SIFRAR", email: "ali@example.test", phone: "+38670328922",
    date_of_birth: "2003-05-31"
  };
  const wrongMale = observation(result.compactWrongMrs, "obs_compact_wrong_male");
  const wrongFemale = observation(result.compactCorrectMr, "obs_compact_wrong_female");
  const emptyMale = observation(result.compactNoTitle, "obs_compact_empty_male");
  const maleGoal = deriveProfileGoal(wrongMale, { ...profile, gender: "male" });
  const femaleGoal = deriveProfileGoal(wrongFemale, { ...profile, gender: "female" });
  const emptyGoal = deriveProfileGoal(emptyMale, { ...profile, gender: "male" });
  expect(maleGoal).toMatchObject({ semanticType: "title", desiredValue: "mr" });
  expect(femaleGoal).toMatchObject({ semanticType: "title", desiredValue: "mrs/ms" });
  expect(emptyGoal).toMatchObject({ semanticType: "title", desiredValue: "mr" });
  expect(candidatesForProfileGoal(maleGoal, wrongMale, { ...profile, gender: "male" })).toHaveLength(1);
  expect(candidatesForProfileGoal(femaleGoal, wrongFemale, { ...profile, gender: "female" })).toHaveLength(1);
  expect(deriveProfileGoal(wrongFemale, { ...profile, gender: "male" })).toBeNull();
  expect(profileStageReadiness(wrongFemale, profile).missingUserData.map((item) => item.semanticType)).toEqual(["title"]);
});

test("fresh valid field state outranks only stale presence validation", async ({ page }) => {
  await loadHtmlProducer(page, `
    <main>
      <h1>Traveller information</h1>
      <label for="email">E-mail</label>
      <input id="email" name="email" type="email" value="ali@aztela.com" required>
    </main>
  `);
  const result = await page.evaluate(() => {
    const hooks = window.__ATW_TEST__;
    const before = hooks.buildPageMap();
    const control = before.controls.find((item) => item.fieldType === "email");
    const target = document.getElementById("email");
    const expected = {
      type: "normalized_value_changed",
      controlId: control.controlId,
      semanticType: "email",
      expectedNormalizedValue: "ali@aztela.com"
    };
    const stalePresence = hooks.buildPageMap();
    stalePresence.validationIssues = [{
      controlId: control.controlId,
      semanticType: "email",
      message: "email is empty"
    }];
    const currentFormat = hooks.buildPageMap();
    currentFormat.validationIssues = [{
      controlId: control.controlId,
      semanticType: "email",
      message: "email format is invalid"
    }];
    return {
      stalePresence: hooks.verifyExpectedOutcome(expected, before, stalePresence, target),
      currentFormat: hooks.verifyExpectedOutcome(expected, before, currentFormat, target)
    };
  });

  expect(result.stalePresence).toMatchObject({ ok: true, code: "NORMALIZED_VALUE_VERIFIED" });
  expect(result.stalePresence.evidence.ownedValidationErrors).toEqual([]);
  expect(result.currentFormat.ok).toBe(false);
  expect(result.currentFormat.evidence.ownedValidationErrors).toHaveLength(1);
});

test("cross-site DOB fields expose a codec and verify the live value canonically", async ({ page }) => {
  await loadProducer(page, profileFixturePath);
  const results = await page.evaluate(async () => {
    const hooks = window.__ATW_TEST__;
    hooks.setAppDataForTest({
      travelers: [{
        id: "trav_date_codec",
        first_name: "Ali",
        last_name: "SIFRAR",
        email: "ali@example.test",
        date_of_birth: "2003-05-31"
      }],
      preferences: {}
    }, "trav_date_codec");
    const variants = [
      { name: "day_first", type: "text", placeholder: "DD-MM-YYYY", value: "31-05-2003", canonical: "2003-05-31", format: "dmy" },
      { name: "month_first", type: "text", placeholder: "MM/DD/YYYY", value: "05/31/2003", canonical: "2003-05-31", format: "mdy" },
      { name: "native_date", type: "date", placeholder: "", value: "2003-05-31", canonical: "2003-05-31", format: "ymd" }
    ];
    const observed = [];
    for (const variant of variants) {
      const input = document.getElementById("dob");
      input.type = variant.type;
      input.placeholder = variant.placeholder;
      input.value = "";
      const before = hooks.buildPageMap();
      const beforeControl = before.controls.find((control) => control.semantic === "date_of_birth");
      const target = hooks.resolveDecisionTarget({
        action: "type",
        operation: "type",
        controlId: beforeControl.controlId,
        targetId: beforeControl.operations.type.actuatorId
      }, before);
      const fill = await hooks.setFieldValue(target, variant.value, {
        fieldType: "date_of_birth",
        compareMode: "text"
      });
      const after = hooks.buildPageMap();
      const afterControl = after.controls.find((control) => control.semantic === "date_of_birth");
      const verification = hooks.verifyExpectedOutcome({
        type: "date_value_committed",
        controlId: afterControl.controlId,
        expectedNormalizedValue: variant.canonical,
        expectedCanonicalValue: variant.canonical,
        dateCodec: { ok: true, kind: "full", format: variant.format }
      }, before, after, target);
      observed.push({
        name: variant.name,
        fillOk: fill.ok,
        format: afterControl.dateField?.format,
        canonical: afterControl.state?.canonicalDateValue,
        verified: verification.ok,
        code: verification.code
      });
    }

    const input = document.getElementById("dob");
    input.type = "text";
    input.placeholder = "";
    input.removeAttribute("pattern");
    input.removeAttribute("aria-describedby");
    document.documentElement.lang = "en";
    input.value = "";
    const ambiguousMap = hooks.buildPageMap();
    const ambiguous = ambiguousMap.controls.find((control) => control.semantic === "date_of_birth");
    input.closest("label").remove();
    const fieldset = document.createElement("fieldset");
    fieldset.innerHTML = `
      <legend>Date of birth</legend>
      <label>Day<select name="birth_day" autocomplete="bday-day"><option value="31">31</option></select></label>
      <label>Month<select name="birth_month" autocomplete="bday-month"><option value="05">May</option></select></label>
      <label>Year<select name="birth_year" autocomplete="bday-year"><option value="2003">2003</option></select></label>
    `;
    document.getElementById("traveler-form").appendChild(fieldset);
    const splitMap = hooks.buildPageMap();
    const split = splitMap.controls
      .filter((control) => control.semantic === "date_of_birth")
      .map((control) => ({ component: control.dateField?.component, format: control.dateField?.format }))
      .sort((a, b) => a.component.localeCompare(b.component));
    return { observed, ambiguous: ambiguous.dateField, split };
  });

  expect(results.observed).toEqual([
    { name: "day_first", fillOk: true, format: "dmy", canonical: "2003-05-31", verified: true, code: "DATE_VALUE_VERIFIED" },
    { name: "month_first", fillOk: true, format: "mdy", canonical: "2003-05-31", verified: true, code: "DATE_VALUE_VERIFIED" },
    { name: "native_date", fillOk: true, format: "ymd", canonical: "2003-05-31", verified: true, code: "DATE_VALUE_VERIFIED" }
  ]);
  expect(results.ambiguous).toMatchObject({ ambiguous: true, format: "" });
  expect(results.split).toEqual([
    { component: "day", format: "" },
    { component: "month", format: "" },
    { component: "year", format: "" }
  ]);
});

test("Kiwi-shaped split DOB advances completed day through custom month and rerendered year", async ({ page }) => {
  await loadHtmlProducer(page, `
    <style>
      body { font-family: sans-serif; padding: 24px; }
      .passenger-card { width: 520px; }
      .dob-row { display: flex; gap: 12px; }
      .dob-part { position: relative; width: 150px; min-height: 44px; }
      .month-widget { position: relative; width: 150px; height: 38px; border: 1px solid #777; cursor: pointer; }
      .month-widget select { position: absolute; inset: 0; width: 100%; opacity: 0; pointer-events: none; }
      .month-label { display: block; padding: 9px; }
      #month-options { position: fixed; top: 160px; left: 190px; z-index: 40; background: white; border: 1px solid #333; }
      #month-options[hidden] { display: none; }
    </style>
    <main>
      <h1>Passenger details</h1>
      <section class="passenger-card" role="group" aria-label="Passenger 1 Date of birth">
        <label>Title<select name="passengers.0.title"><option>Mr</option><option>Mrs/Ms</option></select></label>
        <label>Nationality<select name="passengers.0.nationality"><option value="TR">Türkiye</option></select></label>
        <label>Passport number<input name="passengers.0.idNumber" value="P123456"></label>
        <fieldset id="dob-owner">
          <legend>Date of birth</legend>
          <div id="dob-components" class="dob-row">
            <label class="dob-part">Day
              <input name="passengers.0.birthDay" autocomplete="bday-day" value="31" aria-describedby="dob-error">
            </label>
            <div class="dob-part">
              <span id="month-title">Month</span>
              <div id="month-trigger" class="month-widget">
                <select name="passengers.0.birthMonth" autocomplete="bday-month" disabled aria-labelledby="month-title">
                  <option value="">Month</option><option value="05">May</option>
                </select>
                <span class="month-label">Month</span>
              </div>
            </div>
            <label class="dob-part">Year
              <input name="passengers.0.birthYear" autocomplete="bday-year" value="" aria-describedby="dob-error">
            </label>
          </div>
          <p id="dob-error">Enter complete date</p>
        </fieldset>
      </section>
    </main>
    <div id="month-options" role="listbox" aria-label="Month" hidden>
      <button id="month-may" type="button" role="option">May</button>
    </div>
    <script>
      document.addEventListener("click", (event) => {
        if (event.target.closest("#month-trigger, #month-trigger-rerender")) {
          document.getElementById("month-options").hidden = false;
        }
      });
      document.getElementById("month-may").addEventListener("click", () => {
        document.getElementById("dob-components").innerHTML = \`
          <label class="dob-part">Day
            <input name="passengers.0.birthDay" autocomplete="bday-day" value="31" aria-describedby="dob-error">
          </label>
          <div class="dob-part">
            <span id="month-title-rerender">Month</span>
            <div id="month-trigger-rerender" class="month-widget">
              <select name="passengers.0.birthMonth" autocomplete="bday-month" disabled aria-labelledby="month-title-rerender">
                <option value="">Month</option><option value="05" selected>May</option>
              </select>
              <span class="month-label">May</span>
            </div>
          </div>
          <label class="dob-part">Year
            <input name="passengers.0.birthYear" autocomplete="bday-year" value="" aria-describedby="dob-error">
          </label>\`;
        document.getElementById("month-options").hidden = true;
      });
      document.addEventListener("input", (event) => {
        if (event.target?.name === "passengers.0.birthYear" && event.target.value === "2003") {
          document.getElementById("dob-error")?.remove();
        }
      });
    </script>
  `);

  const profile = {
    id: "traveler_1",
    first_name: "Ali",
    last_name: "Sifrar",
    gender: "male",
    nationality: "TR",
    date_of_birth: "2003-05-31",
    document: { document_number: "P123456" }
  };
  await page.evaluate((traveler) => {
    window.__ATW_TEST__.setAppDataForTest({ travelers: [traveler] }, traveler.id);
  }, profile);

  const initialMap = await page.evaluate(() => window.__ATW_TEST__.buildPageMap());
  const initialObservation = { observationId: "obs_kiwi_dob_initial", page: { ...initialMap, step: "traveler_information" } };
  const initialLogical = resolveLogicalFields(initialObservation.page, profile)
    .find((field) => field.semanticType === "date_of_birth");
  const initialGoal = deriveProfileGoal(initialObservation, profile);
  const initialCandidates = candidatesForProfileGoal(initialGoal, initialObservation, profile);
  const openCandidate = initialCandidates.find((candidate) => candidate.operation === "open");

  expect(initialLogical.components.find((component) => component.role === "day").status).toBe("resolved");
  expect(initialGoal.componentRole).toBe("month");
  expect(openCandidate?.targetId).toBeTruthy();
  expect(openCandidate?.type).toBe("click");
  expect(initialObservation.page.fields.find((field) => field.name === "passengers.0.nationality")?.fieldType).toBe("nationality");
  expect(initialObservation.page.fields.find((field) => field.name === "passengers.0.title")?.fieldType).toBe("title");
  expect(initialObservation.page.fields.find((field) => field.name === "passengers.0.idNumber")?.fieldType).toBe("document_number");
  expect(initialLogical.components.map((component) => component.control.fieldClassification?.fieldType)).toEqual([
    "date_of_birth",
    "date_of_birth",
    "date_of_birth"
  ]);
  expect(initialLogical.components.some((component) => (
    /nationality|title|idNumber/i.test(component.field?.name || component.control?.stableKey || "")
  ))).toBe(false);

  const openAction = actionForProfileCandidate(initialGoal, openCandidate, initialObservation);
  const opened = await executeAtomicBrowserDecision(
    page,
    toClientDecision(openAction),
    "obs_kiwi_dob_options"
  );
  expect(opened.result.dispatched).toBe(true);
  expect(await page.locator("#month-options").isVisible()).toBe(true);

  const optionGoal = deriveProfileGoal(opened.observation, profile, initialGoal);
  const optionCandidates = candidatesForProfileGoal(optionGoal, opened.observation, profile);
  const chooseCandidate = optionCandidates.find((candidate) => candidate.operation === "choose");
  expect(
    chooseCandidate?.targetId,
    JSON.stringify({
      optionGoal,
      optionCandidates,
      controls: opened.observation.page.controls,
      currentSurface: opened.observation.page.currentSurface
    }, null, 2)
  ).toBeTruthy();
  const chooseAction = actionForProfileCandidate(optionGoal, chooseCandidate, opened.observation);
  const chosen = await executeAtomicBrowserDecision(
    page,
    toClientDecision(chooseAction),
    "obs_kiwi_dob_month"
  );
  expect(chosen.result.dispatched).toBe(true);

  const monthObservation = chosen.observation;
  const monthLogical = resolveLogicalFields(monthObservation.page, profile)
    .find((field) => field.semanticType === "date_of_birth");
  expect(
    monthLogical.logicalFieldId,
    JSON.stringify(monthLogical.components.map((component) => ({
      controlId: component.controlId,
      name: component.control?.name,
      fieldName: component.field?.name,
      tightOwnerKey: component.control?.fieldClassification?.tightOwnerKey
        || component.field?.fieldClassification?.tightOwnerKey,
      stableKey: component.control?.stableKey
    })), null, 2)
  ).toBe(initialLogical.logicalFieldId);
  expect(monthLogical.components.find((component) => component.role === "day").stableIdentity)
    .toBe(initialLogical.components.find((component) => component.role === "day").stableIdentity);
  expect(monthLogical.components.find((component) => component.role === "month").status).toBe("resolved");
  const yearGoal = deriveProfileGoal(monthObservation, profile, initialGoal);
  expect(yearGoal.componentRole).toBe("year");
  expect(yearGoal.controlId).toBeTruthy();

  const yearCandidates = candidatesForProfileGoal(yearGoal, monthObservation, profile);
  const yearCandidate = yearCandidates.find((candidate) => candidate.operation === "type");
  expect(yearCandidate?.targetId).toBeTruthy();
  const yearAction = actionForProfileCandidate(yearGoal, yearCandidate, monthObservation);
  const completed = await executeAtomicBrowserDecision(
    page,
    toClientDecision(yearAction),
    "obs_kiwi_dob_complete"
  );
  expect(completed.result.dispatched).toBe(true);
  const completeObservation = completed.observation;
  const completeLogical = resolveLogicalFields(completeObservation.page, profile)
    .find((field) => field.semanticType === "date_of_birth");

  expect(completeLogical.logicalFieldId).toBe(initialLogical.logicalFieldId);
  expect(completeLogical.currentCanonicalValue).toBe("2003-05-31");
  expect(logicalFieldSatisfied(completeLogical)).toBe(true);
  expect(deriveProfileGoal(completeObservation, profile, yearGoal)?.semanticType).not.toBe("date_of_birth");
});

test("Title visual recovery remains grounded through TaskState, governor, dispatch, and popup verification", async ({ page }) => {
  await loadHtmlProducer(page, `
    <style>
      [hidden] { display: none !important; }
      body { font-family: sans-serif; padding: 24px; }
      .title-control {
        position: relative;
        width: 240px;
        height: 40px;
        border: 1px solid #777;
        pointer-events: none;
      }
      .title-control select {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        opacity: 0.01;
        pointer-events: auto;
      }
      .title-value { display: block; padding: 10px 12px; }
      #title-options {
        position: fixed;
        left: 300px;
        top: 90px;
        width: 220px;
        padding: 8px;
        background: white;
        border: 1px solid #222;
        z-index: 30;
      }
      #title-options button { display: block; width: 100%; min-height: 36px; }
    </style>
    <main>
      <h1>Passenger details</h1>
      <label>First name <input name="passengers.0.firstName" value="Ali" required></label>
      <label>Surname <input name="passengers.0.lastName" value="Sifrar" required></label>
      <label>Title
        <div class="title-control">
          <select name="passengers.0.title" disabled required>
            <option value="">Title</option>
            <option value="Mr">Mr</option>
            <option value="Mrs/Ms">Mrs/Ms</option>
          </select>
          <span class="title-value">Title</span>
        </div>
      </label>
    </main>
    <div id="title-options" role="listbox" aria-label="Title options" hidden>
      <button type="button" role="option" data-value="Mr">Mr</button>
      <button type="button" role="option" data-value="Mrs/Ms">Mrs/Ms</button>
    </div>
    <script>
      document.addEventListener("click", (event) => {
        if (!event.target.closest(".title-control")) return;
        window.__titleDispatchTarget = {
          tagName: event.target.tagName,
          className: event.target.className,
          disabled: event.target.disabled === true
        };
        document.getElementById("title-options").hidden = false;
        document.querySelector(".title-control select").setAttribute("aria-expanded", "true");
      });
    </script>
  `);

  const traveler = {
    id: "traveler_title_visual",
    first_name: "Ali",
    last_name: "Sifrar",
    gender: "male"
  };
  await page.evaluate((profile) => {
    window.__ATW_TEST__.setAppDataForTest({ travelers: [profile] }, profile.id);
  }, traveler);

  const priorObservation = await browserObservation(page, "obs_title_visual_prior");
  const priorTitleRegion = priorObservation.page.controls
    .find((control) => control.fieldType === "title")
    ?.recovery.open.regions[0];
  expect(priorTitleRegion?.observationId).toBe(priorObservation.observationId);

  const observation = await browserObservation(page, "obs_title_visual_chain");
  const titleControl = observation.page.controls.find((control) => control.fieldType === "title");
  expect(titleControl).toBeTruthy();
  expect(titleControl.state.disabled).toBe(true);
  expect(titleControl.operations.open).toBeFalsy();
  expect(titleControl.contractVersion).toBe("agent-contract/v1");
  expect(agentContract.observedComponentContract(titleControl).capabilities
    .find((capability) => capability.operation === "open")?.status)
    .toBe("unproven_experiment");
  expect(titleControl.recovery.open.regions).toHaveLength(1);
  expect(titleControl.recovery.open.regions[0].observationId).toBe(observation.observationId);
  expect(titleControl.recovery.open.regions[0].observationId).not.toBe(priorTitleRegion.observationId);

  const taskState = reduceTaskState({ observation, traveler });
  expect(taskState.currentGoal, JSON.stringify({ taskState, titleControl }, null, 2)).toBeTruthy();
  expect(taskState.currentGoal.semanticType).toBe("title");
  const goal = taskState.currentGoal;

  const builtCandidateSet = buildCurrentCandidateSet({
    goal,
    observation,
    traveler,
    state: { taskState, approvals: {} }
  });
  expect(builtCandidateSet.candidates.some((candidate) => candidate.type === "click_xy")).toBe(false);
  const builtTitleCandidate = builtCandidateSet.recoveryCandidates.find((candidate) => candidate.controlId === titleControl.controlId);
  expect(builtTitleCandidate?.type).toBe("click_xy");
  expect(builtTitleCandidate?.capabilityStatus).toBe("unproven_experiment");
  expect(builtTitleCandidate?.executionChannel).toBe("bounded_recovery");
  expect(builtTitleCandidate?.targetId).toBe("");
  expect(builtTitleCandidate?.visualRegion?.observationId).toBe(observation.observationId);

  const groundedCandidateSet = groundedObservationCandidateSet(goal, observation, [], {
    state: { taskState, approvals: {} },
    traveler,
    approvals: {}
  });
  const titleCandidate = groundedCandidateSet.candidates.find((candidate) => candidate.controlId === titleControl.controlId);
  expect(titleCandidate?.type).toBe("click_xy");
  expect(titleCandidate?.visualRegion?.observationId).toBe(observation.observationId);
  expect(titleCandidate?.pipelineContract).toMatchObject({
    contractVersion: "agent-contract/v1",
    requirement: {
      requirementId: goal.logicalFieldId,
      semanticType: "title"
    },
    component: {
      logicalFieldId: goal.logicalFieldId,
      componentRole: "value",
      controlId: titleControl.controlId
    },
    capability: {
      operation: "open",
      status: "unproven_experiment"
    },
    expectedOutcome: {
      type: "options_surface_appeared"
    }
  });

  const store = inMemoryGovernorStore();
  let state = createCheckoutSessionState({
    goal: "Complete passenger details",
    travelerId: traveler.id,
    site: { host: "example.test", url: page.url() }
  });
  state.id = "txn_title_visual_chain";
  const authoritativeGoal = {
    ...goal,
    candidateSet: groundedCandidateSet,
    candidates: groundedCandidateSet.candidates
  };
  state = {
    ...state,
    taskState: { ...taskState, currentGoal: authoritativeGoal },
    currentGoal: authoritativeGoal,
    currentObservation: {
      observationId: observation.observationId,
      observationHash: observation.observationSnapshot.snapshotHash
    }
  };
  store.remember(state.id, observation);

  const action = loopPrivate.bindTargetSnapshot(
    actionForCurrentCandidate(goal, titleCandidate, observation),
    observation
  );
  const governed = governAction({
    action,
    state,
    observation,
    traveler,
    store,
    turnId: "turn_title_visual_chain"
  });
  expect(governed.allow, `${governed.code}: ${governed.reason}`).toBe(true);
  expect(governed.action.pipelineContract).toEqual(titleCandidate.pipelineContract);
  const clientDecision = toClientDecision(governed.action);
  expect(clientDecision.action).toBe("click_xy");
  expect(clientDecision.targetId).toBe("");
  expect(clientDecision.pipelineContract).toEqual(titleCandidate.pipelineContract);

  const executed = await executeAtomicBrowserDecision(
    page,
    clientDecision,
    "obs_title_options_open"
  );
  expect(executed.validation.ok, JSON.stringify(executed.validation)).toBe(true);
  expect(executed.result.dispatched).toBe(true);
  expect(executed.verification.ok, JSON.stringify(executed.verification)).toBe(true);
  expect(executed.verification.code).toBe("OPTIONS_SURFACE_APPEARED");
  expect(await page.locator("#title-options").isVisible()).toBe(true);
  expect(await page.evaluate(() => window.__titleDispatchTarget)).toEqual({
    tagName: "DIV",
    className: "title-control",
    disabled: false
  });
});

test("one exact custom-control actuator advances through method-aware retry and semantic option verification", async ({ page }) => {
  await loadHtmlProducer(page, `
    <style>
      [hidden] { display: none !important; }
      body { font-family: sans-serif; padding: 24px; }
      .title-widget {
        position: relative;
        width: 240px;
        height: 40px;
        border: 1px solid #777;
        cursor: pointer;
      }
      .title-widget select {
        position: absolute;
        inset: 0;
        width: 100%;
        opacity: 0;
        pointer-events: none;
      }
      .title-widget span { display: block; padding: 10px; }
      #strategy-options {
        position: fixed;
        left: 300px;
        top: 90px;
        width: 180px;
        background: white;
        border: 1px solid #222;
        z-index: 30;
      }
    </style>
    <main>
      <h1>Passenger details</h1>
      <label>Title
        <div id="strategy-title-wrapper" class="title-widget">
          <select id="strategy-title-state" name="passengers.0.title" disabled required>
            <option value="">Title</option>
          </select>
          <span>Title</span>
        </div>
      </label>
    </main>
    <div id="strategy-options" role="listbox" aria-label="Title options" hidden>
      <button id="strategy-mr" type="button" role="option" data-value="Mr">Mr</button>
      <button type="button" role="option" data-value="Mrs/Ms">Mrs/Ms</button>
    </div>
    <script>
      document.getElementById("strategy-title-wrapper").addEventListener("click", (event) => {
        window.__strategyAttempts = [...(window.__strategyAttempts || []), {
          detail: event.detail,
          targetId: event.target.id || "",
          targetDisabled: event.target.disabled === true
        }];
        // The first generic method (HTMLElement.click) has no pointer detail.
        // This fixture opens only for the distinct pointer/mouse strategy.
        if (event.detail > 0) {
          document.getElementById("strategy-options").hidden = false;
          document.getElementById("strategy-title-state").setAttribute("aria-expanded", "true");
        }
      });
      document.getElementById("strategy-options").addEventListener("click", (event) => {
        const option = event.target.closest("[role='option']");
        if (!option) return;
        const state = document.getElementById("strategy-title-state");
        const stateOption = document.createElement("option");
        stateOption.value = option.dataset.value;
        stateOption.textContent = option.textContent;
        state.appendChild(stateOption);
        state.value = option.dataset.value;
        state.setAttribute("aria-expanded", "false");
        state.dispatchEvent(new Event("change", { bubbles: true }));
        document.querySelector(".title-widget span").textContent = option.textContent;
        document.getElementById("strategy-options").hidden = true;
      });
    </script>
  `);

  const traveler = {
    id: "traveler_method_retry",
    first_name: "Ali",
    last_name: "Sifrar",
    gender: "male"
  };
  await page.evaluate((profile) => {
    window.__ATW_TEST__.setAppDataForTest({ travelers: [profile] }, profile.id);
  }, traveler);

  const initial = await browserObservation(page, "obs_method_retry_initial");
  const initialTaskState = reduceTaskState({ observation: initial, traveler });
  let goal = initialTaskState.currentGoal || deriveProfileGoal(initial, traveler);
  expect(goal).toBeTruthy();
  const firstSet = groundedObservationCandidateSet(goal, initial, [], {
    state: { taskState: initialTaskState, approvals: {} },
    traveler,
    approvals: {}
  });
  const nativeCandidate = firstSet.candidates.find((candidate) => candidate.operation === "open");
  expect(nativeCandidate?.interactionMethod).toBe("native_click");
  expect(nativeCandidate?.capabilityStatus).toBe("unproven_experiment");
  expect(nativeCandidate?.executionChannel).toBe("bounded_recovery");

  const store = inMemoryGovernorStore();
  let state = createCheckoutSessionState({
    goal: "Complete passenger details",
    travelerId: traveler.id,
    site: { host: "example.test", url: page.url() }
  });
  state.id = "txn_method_retry_chain";
  const firstAuthoritativeGoal = {
    ...goal,
    candidateSet: firstSet,
    candidates: firstSet.candidates
  };
  const firstObligation = currentObligationFromGoal({ goal });
  state = {
    ...state,
    taskState: { ...initialTaskState, currentObligation: firstObligation },
    currentGoal: firstAuthoritativeGoal,
    currentObservation: {
      observationId: initial.observationId,
      observationHash: initial.observationSnapshot.snapshotHash
    }
  };
  store.remember(state.id, initial);
  const nativeAction = loopPrivate.bindTargetSnapshot(
    actionForCurrentCandidate(goal, nativeCandidate, initial),
    initial
  );
  const governedNative = governAction({
    action: nativeAction,
    state,
    observation: initial,
    traveler,
    store,
    turnId: "turn_method_retry_native"
  });
  expect(governedNative.allow, `${governedNative.code}: ${governedNative.reason}`).toBe(true);
  expect(governedNative.checks).toContainEqual(expect.objectContaining({
    code: "EXECUTION_LANE_CLASSIFIED",
    detail: "bounded_recovery"
  }));
  const nativeResult = await executeAtomicBrowserDecision(
    page,
    toClientDecision(governedNative.action),
    "obs_method_retry_native_failed"
  );
  expect(nativeResult.result.dispatched).toBe(true);
  expect(nativeResult.verification.ok).toBe(false);
  const failedLifecycle = loopPrivate.applyTransitionStatus(withExecutionFixture({
    ...governedNative.state,
    taskState: { ...initialTaskState, currentObligation: firstObligation },
    currentGoal: firstAuthoritativeGoal,
    lastAction: governedNative.action
  }, { recovery: { attempts: 0, phase: "idle", failedStrategies: [], failedStrategySignatures: [] } }), nativeResult.observation, initial);
  expect(failedLifecycle.transition.status).toBe("no_effect");
  expect(executionRecovery(failedLifecycle.state).failedStrategies).toHaveLength(1);
  const unchangedRepeat = await page.evaluate((decision) => {
    const hooks = window.__ATW_TEST__;
    decision = hooks.decisionFromActionLease(decision);
    const initialMap = hooks.buildPageMap();
    const target = hooks.resolveDecisionTarget(decision, initialMap);
    const sameTargetState = hooks.repeatGuardFor(target, "same failed strategy", decision, initialMap);
    const unrelated = document.createElement("input");
    unrelated.name = "passengers.0.birthDay";
    unrelated.setAttribute("autocomplete", "bday-day");
    unrelated.value = "31";
    document.body.appendChild(unrelated);
    const unrelatedProgressMap = hooks.buildPageMap();
    const afterUnrelatedProgress = hooks.repeatGuardFor(
      hooks.resolveDecisionTarget(decision, unrelatedProgressMap),
      "unrelated component changed",
      decision,
      unrelatedProgressMap
    );
    const diagnosticOnlyMap = {
      ...unrelatedProgressMap,
      graphIntegrity: {
        ok: false,
        diagnostics: [{ code: "UNRELATED_REGISTRY_DIAGNOSTIC", controlId: "other_control" }]
      }
    };
    const afterDiagnostic = hooks.repeatGuardFor(
      hooks.resolveDecisionTarget(decision, diagnosticOnlyMap),
      "unrelated registry diagnostic",
      decision,
      diagnosticOnlyMap
    );
    unrelated.remove();
    return { sameTargetState, afterUnrelatedProgress, afterDiagnostic };
  }, toClientDecision(nativeAction));
  expect(unchangedRepeat).toEqual({
    sameTargetState: false,
    afterUnrelatedProgress: false,
    afterDiagnostic: false
  });

  const retryObservation = nativeResult.observation;
  const retryTaskState = reduceTaskState({
    previousTaskState: initialTaskState,
    observation: retryObservation,
    previousActionResult: retryObservation.lastActionResult || null,
    traveler
  });
  goal = retryTaskState.currentGoal || deriveProfileGoal(retryObservation, traveler, initialTaskState.currentGoal);
  expect(goal).toBeTruthy();
  const failedSignatures = loopPrivate.failedStrategySignaturesForGoal(
    failedLifecycle.state,
    goal,
    retryObservation
  );
  expect(failedSignatures, JSON.stringify({
    stored: executionRecovery(failedLifecycle.state).failedStrategies,
    retryGoal: goal
  })).toEqual([actuatorSignature(nativeAction)]);
  const pointerSet = groundedObservationCandidateSet(goal, retryObservation, failedSignatures, {
    state: { ...failedLifecycle.state, taskState: retryTaskState, approvals: {} },
    traveler,
    approvals: {}
  });
  const pointerCandidate = pointerSet.candidates.find((candidate) => candidate.operation === "open");
  expect(pointerCandidate?.interactionMethod).toBe("pointer_sequence");
  expect(pointerCandidate?.targetId).toBe(nativeCandidate.targetId);
  expect(actuatorSignature(actionForCurrentCandidate(goal, pointerCandidate, retryObservation)))
    .not.toBe(actuatorSignature(nativeAction));

  const pointerGoal = {
    ...goal,
    candidateSet: pointerSet,
    candidates: pointerSet.candidates
  };
  state = {
    ...failedLifecycle.state,
    taskState: { ...retryTaskState, currentGoal: pointerGoal },
    currentGoal: pointerGoal,
    currentObservation: {
      observationId: retryObservation.observationId,
      observationHash: retryObservation.observationSnapshot.snapshotHash
    }
  };
  store.remember(state.id, retryObservation);
  const pointerAction = loopPrivate.bindTargetSnapshot(
    actionForCurrentCandidate(goal, pointerCandidate, retryObservation),
    retryObservation
  );
  expect(await page.evaluate((decision) => {
    const hooks = window.__ATW_TEST__;
    decision = hooks.decisionFromActionLease(decision);
    const map = hooks.buildPageMap();
    return hooks.repeatGuardFor(
      hooks.resolveDecisionTarget(decision, map),
      "distinct method",
      decision,
      map
    );
  }, toClientDecision(pointerAction))).toBe(true);
  const governedPointer = governAction({
    action: pointerAction,
    state,
    observation: retryObservation,
    traveler,
    store,
    turnId: "turn_method_retry_pointer"
  });
  expect(governedPointer.allow, `${governedPointer.code}: ${governedPointer.reason}`).toBe(true);
  const opened = await executeAtomicBrowserDecision(
    page,
    toClientDecision(governedPointer.action),
    "obs_method_retry_opened"
  );
  expect(opened.verification).toMatchObject({ ok: true, code: "OPTIONS_SURFACE_APPEARED" });
  expect(await page.locator("#strategy-options").isVisible()).toBe(true);
  expect(await page.evaluate(() => window.__strategyAttempts)).toEqual([
    { detail: 0, targetId: "strategy-title-wrapper", targetDisabled: false },
    { detail: 1, targetId: "strategy-title-wrapper", targetDisabled: false }
  ]);

  const optionGoal = deriveProfileGoal(opened.observation, traveler, goal);
  const optionCandidate = candidatesForProfileGoal(optionGoal, opened.observation, traveler)
    .find((candidate) => candidate.operation === "choose");
  const selected = await executeAtomicBrowserDecision(
    page,
    toClientDecision(actionForProfileCandidate(optionGoal, optionCandidate, opened.observation)),
    "obs_method_retry_selected"
  );
  expect(selected.verification.ok, JSON.stringify(selected.verification)).toBe(true);
  const titleField = resolveLogicalFields(selected.observation.page, traveler)
    .find((field) => field.semanticType === "title");
  expect(titleField.currentCanonicalValue).toBe("mr");
  expect(logicalFieldSatisfied(titleField)).toBe(true);
});

test("bounded recovery advances from synthetic open methods to one governed trusted choice without repeating", async ({ page }) => {
  await loadHtmlProducer(page, `
    <style>
      [hidden] { display: none !important; }
      body { font-family: sans-serif; padding: 24px; }
      .custom-widget { position: relative; width: 240px; height: 40px; border: 1px solid #777; }
      .custom-widget select { position: absolute; inset: 0; opacity: 0; pointer-events: none; }
      .custom-widget span { display: block; padding: 10px; }
      #trusted-options { position: fixed; left: 300px; top: 80px; background: white; border: 1px solid #222; }
    </style>
    <main>
      <h1>Passenger details</h1>
      <label>Title
        <div id="trusted-wrapper" class="custom-widget">
          <select name="passengers.0.title" disabled>
            <option value="">Title</option><option value="Mr">Mr</option>
          </select>
          <span>Title</span>
        </div>
      </label>
    </main>
    <div id="trusted-options" role="listbox" aria-label="Title options" hidden>
      <button type="button" role="option">Mr</button>
    </div>
  `);
  const traveler = { id: "traveler_trusted", first_name: "Ali", last_name: "Sifrar", gender: "male" };
  await page.evaluate((profile) => {
    window.__ATW_TEST__.setAppDataForTest({ travelers: [profile] }, profile.id);
    window.__ATW_TEST_TRUSTED_CHOICE__ = ({ element, choiceLabel }) => {
      window.__trustedDispatchTarget = { id: element.id, choiceLabel };
      const select = element.querySelector("select");
      select.value = "Mr";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      element.querySelector("span").textContent = "Mr";
      return { ok: true };
    };
  }, traveler);

  const observation = await browserObservation(page, "obs_trusted_strategy");
  const goal = deriveProfileGoal(observation, traveler);
  const attempted = [];
  for (const expectedMethod of ["native_click", "pointer_sequence"]) {
    const built = buildCurrentCandidateSet({
      goal,
      observation,
      traveler,
      state: { taskState: { currentGoal: goal }, approvals: {} },
      attemptedStrategySignatures: attempted
    });
    const candidate = [...built.candidates, ...built.recoveryCandidates]
      .find((item) => item.operation === "open");
    expect(candidate?.interactionMethod).toBe(expectedMethod);
    expect(candidate).toMatchObject({
      candidateClass: "mechanical_hypothesis",
      mechanicalHypothesis: true,
      executionChannel: "bounded_recovery",
      discoveryEnvelope: {
        kind: "pre_surface_discovery",
        logicalControlId: candidate.controlId,
        actuatorId: candidate.targetId,
        remainingSteps: 1
      }
    });
    const action = actionForCurrentCandidate(goal, candidate, observation);
    const failed = await executeAtomicBrowserDecision(
      page,
      toClientDecision(action),
      `obs_trusted_${expectedMethod}_failed`
    );
    expect(failed.result.dispatched).toBe(true);
    expect(failed.verification.ok).toBe(false);
    attempted.push(actuatorSignature(action));
  }

  const trustedSet = buildCurrentCandidateSet({
    goal,
    observation,
    traveler,
    state: { taskState: { currentGoal: goal }, approvals: {} },
    attemptedStrategySignatures: attempted
  });
  const trustedCandidate = [...trustedSet.candidates, ...trustedSet.recoveryCandidates]
    .find((item) => item.operation === "select");
  expect(trustedCandidate).toMatchObject({
    interactionMethod: "browser_trusted_choice",
    value: "Mr"
  });
  const trustedAction = actionForCurrentCandidate(goal, trustedCandidate, observation);
  expect(attempted).not.toContain(actuatorSignature(trustedAction));
  const selected = await executeAtomicBrowserDecision(
    page,
    toClientDecision(trustedAction),
    "obs_trusted_choice_selected"
  );
  expect(selected.verification).toMatchObject({ ok: true, code: "LOGICAL_COMPONENT_COMMITTED" });
  expect(await page.evaluate(() => window.__trustedDispatchTarget)).toEqual({
    id: "trusted-wrapper",
    choiceLabel: "Mr"
  });
});

test("split hidden title state settles one EasyJet-shaped adaptive episode without selecting Mrs", async ({ page }) => {
  await loadHtmlProducer(page, `
    <style>
      [hidden] { display: none !important; }
      body { font-family: sans-serif; padding: 24px; }
      #title-widget { position: relative; width: 280px; height: 42px; border: 1px solid #777; cursor: pointer; }
      #title-trigger { padding: 10px; }
      #title-combobox { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; pointer-events: none; }
      #title-options { position: fixed; left: 24px; top: 100px; width: 280px; background: white; border: 1px solid #222; z-index: 20; }
      #title-options [role="option"] { display: block; width: 100%; padding: 8px; text-align: left; }
    </style>
    <main>
      <h1>Passenger details</h1>
      <section aria-label="Adult 1">
        <label>Title
          <div id="title-widget">
            <div id="title-trigger">Title</div>
            <select id="title-combobox" aria-label="Title" aria-expanded="false" aria-controls="title-options" required disabled>
              <option value="">Title</option>
              <option value="Mr">Mr</option>
              <option value="Mrs">Mrs</option>
              <option value="Ms">Ms</option>
              <option value="Miss">Miss</option>
            </select>
            <input id="title-hidden-state" type="text" name="title" aria-label="title" value="" disabled style="position:absolute;width:0;height:0;opacity:0">
          </div>
        </label>
      </section>
    </main>
    <div id="title-options" role="listbox" aria-label="Mr Mrs Ms Miss" hidden>
      <button id="title-mr" type="button" role="option" aria-selected="false">Mr</button>
      <button id="title-mrs" type="button" role="option" aria-selected="false">Mrs</button>
      <button id="title-ms" type="button" role="option" aria-selected="false">Ms</button>
      <button id="title-miss" type="button" role="option" aria-selected="false">Miss</button>
    </div>
    <script>
      window.__titleChoiceCounts = { open: 0, mr: 0, mrs: 0, ms: 0, miss: 0 };
      const widget = document.getElementById("title-widget");
      const combo = document.getElementById("title-combobox");
      const hiddenState = document.getElementById("title-hidden-state");
      const options = document.getElementById("title-options");
      widget.addEventListener("click", () => {
        window.__titleChoiceCounts.open += 1;
        options.hidden = false;
        combo.setAttribute("aria-expanded", "true");
      });
      for (const value of ["mr", "mrs", "ms", "miss"]) {
        document.getElementById("title-" + value).addEventListener("click", (event) => {
          event.stopPropagation();
          window.__titleChoiceCounts[value] += 1;
          hiddenState.value = value === "mr" ? "Mr" : value === "mrs" ? "Mrs" : value === "ms" ? "Ms" : "Miss";
          hiddenState.dispatchEvent(new Event("input", { bubbles: true }));
          hiddenState.dispatchEvent(new Event("change", { bubbles: true }));
          document.getElementById("title-trigger").textContent = hiddenState.value;
          document.querySelectorAll("#title-options [role=option]").forEach((option) => option.setAttribute("aria-selected", "false"));
          event.currentTarget.setAttribute("aria-selected", "true");
          options.hidden = true;
          combo.setAttribute("aria-expanded", "false");
        });
      }
    </script>
  `);
  const traveler = { id: "traveler_split_title", first_name: "Ali", last_name: "Sifrar", gender: "male" };
  await page.evaluate((profile) => window.__ATW_TEST__.setAppDataForTest({ travelers: [profile] }, profile.id), traveler);

  let observation = await browserObservation(page, "obs_split_title_closed");
  let taskState = reduceTaskState({ observation, traveler });
  const titleGoal = deriveProfileGoal(observation, traveler);
  expect(titleGoal).toMatchObject({ semanticType: "title", desiredValue: "mr" });
  expect(titleGoal.postcondition.representationIdentity).toBeTruthy();

  await page.evaluate(() => document.getElementById("title-widget").click());
  observation = await browserObservation(page, "obs_split_title_open");
  const adaptiveGoal = {
    ...titleGoal,
    kind: "adaptive_surface",
    goalId: `${titleGoal.goalId}:surface:${observation.page.currentSurface.id}:step:1`,
    sourceGoalId: titleGoal.goalId,
    sourceGoal: titleGoal,
    selectionMode: "ai_ambiguity",
    surfaceId: observation.page.currentSurface.id,
    adaptiveEnvelope: {
      kind: "bounded_adaptive_surface",
      objective: titleGoal.semanticGoal,
      desiredValue: "mr",
      surfaceId: observation.page.currentSurface.id,
      surfaceType: observation.page.currentSurface.type,
      allowedOperations: ["open", "choose", "activate", "type", "select", "keyboard"],
      forbiddenRisks: ["money", "payment", "legal"],
      forbiddenEffects: ["select_paid_option", "accept_legal", "advance_checkout_stage"],
      remainingSteps: 6,
      deadlineAt: Date.now() + 20_000
    }
  };
  taskState = { ...taskState, currentGoal: adaptiveGoal };
  let candidateSet = buildCurrentCandidateSet({
    goal: adaptiveGoal,
    observation,
    traveler,
    state: { taskState, approvals: {} }
  });
  expect(candidateSet.candidates).toHaveLength(1);
  expect(candidateSet.candidates[0].targetLabel).toBe("Mr");
  expect(candidateSet.contextCapabilities.filter((candidate) => candidate.selectable).map((candidate) => candidate.targetLabel)).toEqual(["Mr"]);

  const executed = await executeAtomicBrowserDecision(
    page,
    toClientDecision(loopPrivate.bindTargetSnapshot(
      actionForCurrentCandidate(adaptiveGoal, candidateSet.candidates[0], observation),
      observation
    )),
    "obs_split_title_selected"
  );
  expect(executed.verification).toMatchObject({ ok: true, code: "LOGICAL_COMPONENT_COMMITTED" });
  expect(await page.evaluate(() => window.__titleChoiceCounts)).toEqual({ open: 1, mr: 1, mrs: 0, ms: 0, miss: 0 });

  const resolvedTitleFields = resolveLogicalFields(executed.observation.page, traveler)
    .filter((field) => field.semanticType === "title");
  const titleField = resolvedTitleFields[0];
  expect(titleField.components).toHaveLength(1);
  expect(titleField.currentCanonicalValue).toBe("mr");
  expect(logicalFieldSatisfied(titleField)).toBe(true);
  const settledTask = reduceTaskState({
    previousTaskState: taskState,
    observation: executed.observation,
    previousActionResult: executed.observation.lastActionResult,
    traveler
  });
  expect(settledTask.currentGoal?.semanticType).not.toBe("title");
});

test("verified EasyJet-shaped age opener retains age ownership and selects the compatible 18+ option", async ({ page }) => {
  await loadHtmlProducer(page, `
    <style>
      [hidden] { display: none !important; }
      body { font-family: sans-serif; padding: 24px; }
      #age-widget { position: relative; width: 280px; height: 42px; border: 1px solid #777; cursor: pointer; }
      #age-trigger { padding: 10px; }
      #age-combobox { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; pointer-events: none; }
      #age-options { position: fixed; left: 24px; top: 100px; width: 280px; background: white; border: 1px solid #222; z-index: 20; }
      #age-options [role="option"] { display: block; width: 100%; padding: 8px; text-align: left; }
    </style>
    <main>
      <h1>Passenger details</h1>
      <section aria-label="Adult 1">
        <label>Age at time of travel
          <div id="age-widget">
            <div id="age-trigger">Age at time of travel</div>
            <select id="age-combobox" aria-label="Age at time of travel" aria-expanded="false" aria-controls="age-options" required disabled>
              <option value="">Age at time of travel</option>
              <option value="18_plus">18+</option>
              <option value="17">17</option>
              <option value="16">16</option>
            </select>
          </div>
        </label>
      </section>
    </main>
    <div id="age-options" role="listbox" aria-label="18+ 17 16" hidden>
      <button id="age-18-plus" type="button" role="option" aria-selected="false">18+</button>
      <button id="age-17" type="button" role="option" aria-selected="false">17</button>
      <button id="age-16" type="button" role="option" aria-selected="false">16</button>
    </div>
    <script>
      window.__ageChoiceCounts = { open: 0, eighteenPlus: 0, seventeen: 0, sixteen: 0 };
      const widget = document.getElementById("age-widget");
      const combo = document.getElementById("age-combobox");
      const options = document.getElementById("age-options");
      widget.addEventListener("click", () => {
        window.__ageChoiceCounts.open += 1;
        options.hidden = false;
        combo.setAttribute("aria-expanded", "true");
      });
      const choices = [
        ["age-18-plus", "18+", "eighteenPlus"],
        ["age-17", "17", "seventeen"],
        ["age-16", "16", "sixteen"]
      ];
      for (const [id, value, countKey] of choices) {
        document.getElementById(id).addEventListener("click", (event) => {
          event.stopPropagation();
          window.__ageChoiceCounts[countKey] += 1;
          combo.disabled = false;
          combo.value = id === "age-18-plus" ? "18_plus" : value;
          combo.dispatchEvent(new Event("input", { bubbles: true }));
          combo.dispatchEvent(new Event("change", { bubbles: true }));
          document.getElementById("age-trigger").textContent = event.currentTarget.textContent;
          document.querySelectorAll("#age-options [role=option]").forEach((option) => option.setAttribute("aria-selected", "false"));
          event.currentTarget.setAttribute("aria-selected", "true");
          options.hidden = true;
          combo.setAttribute("aria-expanded", "false");
        });
      }
    </script>
  `);
  const traveler = { id: "traveler_live_age_surface", date_of_birth: "2003-05-31" };
  const transactionReview = verifiedTransactionReview();
  await page.evaluate((profile) => window.__ATW_TEST__.setAppDataForTest({ travelers: [profile] }, profile.id), traveler);

  const closed = await browserObservation(page, "obs_live_age_closed");
  const initialGoal = deriveProfileGoal({
    ...closed,
    page: { ...closed.page, selectedBooking: transactionReview.baseline }
  }, traveler);
  const initialTask = {
    ...reduceTaskState({ observation: closed, traveler, transactionReview }),
    currentGoal: initialGoal
  };
  expect(initialGoal).toMatchObject({
    kind: "profile_field",
    semanticType: "age_at_departure",
    desiredValue: "23"
  });
  await page.evaluate(() => document.getElementById("age-widget").click());
  const openedObservation = await browserObservation(page, "obs_live_age_opened");
  const verifiedOpenerResult = {
    actionId: "act_live_age_open",
    verified: true,
    expectedOutcomeObserved: true,
    postconditionSatisfied: true,
    expectedOutcome: { type: "options_surface_appeared" },
    action: {
      id: "act_live_age_open",
      goalId: initialGoal.goalId,
      operation: "open",
      mechanicalEffect: "open_surface"
    }
  };

  const surfaceTask = reduceTaskState({
    previousTaskState: initialTask,
    observation: openedObservation,
    previousActionResult: verifiedOpenerResult,
    traveler,
    transactionReview
  });
  expect(surfaceTask.currentGoal).toMatchObject({
    kind: "adaptive_surface",
    semanticType: "age_at_departure",
    desiredValue: "23"
  });

  // The live site does not repeat the derived age on the child surface. The
  // field codec—not generic foreground or commerce inference—must establish
  // that 23 belongs to the freshly observed 18+ option.
  const codecOnlyGoal = {
    ...surfaceTask.currentGoal,
    choiceTerms: []
  };
  const optionSet = buildCurrentCandidateSet({
    goal: codecOnlyGoal,
    observation: openedObservation,
    traveler,
    state: { taskState: { ...surfaceTask, currentGoal: codecOnlyGoal }, approvals: {} }
  });
  expect(optionSet.candidates).toHaveLength(1);
  expect(optionSet.candidates[0]).toMatchObject({
    targetLabel: "18+",
    physicalEffect: "set_field_value",
    risk: "safe",
    requiresJudgment: false
  });
  expect(optionSet.contextCapabilities.filter((candidate) => candidate.selectable).map((candidate) => candidate.targetLabel)).toEqual(["18+"]);

  const selected = await executeAtomicBrowserDecision(
    page,
    toClientDecision(loopPrivate.bindTargetSnapshot(
      actionForCurrentCandidate(codecOnlyGoal, optionSet.candidates[0], openedObservation),
      openedObservation
    )),
    "obs_live_age_selected"
  );
  expect(selected.verification).toMatchObject({
    ok: true,
    code: "LOGICAL_COMPONENT_COMMITTED"
  });
  expect(await page.evaluate(() => window.__ageChoiceCounts)).toEqual({
    open: 1,
    eighteenPlus: 1,
    seventeen: 0,
    sixteen: 0
  });
  const settledTask = reduceTaskState({
    previousTaskState: surfaceTask,
    observation: selected.observation,
    previousActionResult: selected.observation.lastActionResult,
    traveler,
    transactionReview
  });
  expect(settledTask.currentGoal?.semanticType).not.toBe("age_at_departure");
});

test("a settled exact age option creates one durable canonical verification when the framework parent stays blank", async ({ page }) => {
  await loadHtmlProducer(page, `
    <style>
      [hidden] { display: none !important; }
      body { font-family: sans-serif; padding: 24px; }
      #receipt-age-widget { position: relative; width: 280px; height: 42px; border: 1px solid #777; cursor: pointer; }
      #receipt-age-trigger { padding: 10px; }
      #receipt-age-combobox { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; pointer-events: none; }
      #receipt-age-options { position: fixed; left: 24px; top: 100px; width: 280px; background: white; border: 1px solid #222; z-index: 20; }
      #receipt-age-options [role="option"] { display: block; width: 100%; padding: 8px; text-align: left; }
    </style>
    <main>
      <h1>Passenger details</h1>
      <form id="signin-form" hidden>
        <label>Sign in email <input type="email" name="signin.email" required></label>
      </form>
      <form id="signup-form" hidden>
        <label>Create account email <input type="email" name="signup.email" required></label>
      </form>
      <section aria-label="Adult 1">
        <label>Age at time of travel
          <div id="receipt-age-widget">
            <div id="receipt-age-trigger">Age at time of travel</div>
            <select id="receipt-age-combobox" aria-label="Age at time of travel" aria-expanded="false" aria-controls="receipt-age-options" required disabled>
              <option value="">Age at time of travel</option>
              <option value="18_plus">18+</option>
              <option value="17">17</option>
              <option value="16">16</option>
            </select>
          </div>
        </label>
      </section>
      <button id="receipt-continue" type="button" disabled>Continue</button>
    </main>
    <div id="receipt-age-options" role="listbox" aria-label="18+ 17 16" hidden>
      <button id="receipt-age-18-plus" type="button" role="option" aria-selected="false">18+</button>
      <button id="receipt-age-17" type="button" role="option" aria-selected="false">17</button>
      <button id="receipt-age-16" type="button" role="option" aria-selected="false">16</button>
    </div>
    <script>
      window.__receiptAgeCounts = { open: 0, eighteenPlus: 0, seventeen: 0, sixteen: 0 };
      const widget = document.getElementById("receipt-age-widget");
      const combo = document.getElementById("receipt-age-combobox");
      const options = document.getElementById("receipt-age-options");
      widget.addEventListener("click", () => {
        window.__receiptAgeCounts.open += 1;
        options.hidden = false;
        combo.setAttribute("aria-expanded", "true");
      });
      const choices = [
        ["receipt-age-18-plus", "eighteenPlus"],
        ["receipt-age-17", "seventeen"],
        ["receipt-age-16", "sixteen"]
      ];
      for (const [id, countKey] of choices) {
        document.getElementById(id).addEventListener("click", (event) => {
          event.stopPropagation();
          window.__receiptAgeCounts[countKey] += 1;
          // Live-shaped framework behavior: the exact option handles the
          // event and unlocks Continue, but its hidden parent state remains
          // blank and exposes no selected representation after the portal
          // closes.
          document.querySelectorAll("#receipt-age-options [role=option]")
            .forEach((option) => option.setAttribute("aria-selected", "false"));
          options.hidden = true;
          combo.setAttribute("aria-expanded", "false");
          document.getElementById("receipt-continue").disabled = false;
        });
      }
    </script>
  `);
  const traveler = { id: "traveler_age_receipt", date_of_birth: "2003-05-31" };
  const transactionReview = verifiedTransactionReview();
  await page.evaluate((profile) => window.__ATW_TEST__.setAppDataForTest({ travelers: [profile] }, profile.id), traveler);

  const closed = await browserObservation(page, "obs_age_receipt_closed");
  const authoritativeObservation = {
    ...closed,
    page: { ...closed.page, selectedBooking: transactionReview.baseline }
  };
  const initialGoal = deriveProfileGoal(authoritativeObservation, traveler);
  const initialTask = {
    ...reduceTaskState({ observation: closed, traveler, transactionReview }),
    currentGoal: initialGoal
  };
  expect(initialGoal).toMatchObject({ semanticType: "age_at_departure", desiredValue: "23" });

  await page.evaluate(() => document.getElementById("receipt-age-widget").click());
  const openedObservation = await browserObservation(page, "obs_age_receipt_opened");
  const surfaceTask = reduceTaskState({
    previousTaskState: initialTask,
    observation: openedObservation,
    previousActionResult: {
      actionId: "act_age_receipt_open",
      verified: true,
      expectedOutcomeObserved: true,
      postconditionSatisfied: true,
      expectedOutcome: { type: "options_surface_appeared" },
      action: {
        id: "act_age_receipt_open",
        goalId: initialGoal.goalId,
        operation: "open",
        mechanicalEffect: "open_surface"
      }
    },
    traveler,
    transactionReview
  });
  const candidateSet = buildCurrentCandidateSet({
    goal: surfaceTask.currentGoal,
    observation: openedObservation,
    traveler,
    state: { taskState: surfaceTask, approvals: {} }
  });
  expect(candidateSet.candidates).toHaveLength(1);
  expect(candidateSet.candidates[0]).toMatchObject({ targetLabel: "18+", physicalEffect: "set_field_value" });

  const selectedAction = loopPrivate.bindTargetSnapshot(
    actionForCurrentCandidate(surfaceTask.currentGoal, candidateSet.candidates[0], openedObservation),
    openedObservation
  );
  const selected = await executeAtomicBrowserDecision(
    page,
    toClientDecision(selectedAction),
    "obs_age_receipt_selected"
  );
  expect(selected.verification).toMatchObject({ ok: true, code: "LOGICAL_COMPONENT_COMMITTED" });
  expect(
    selected.verification.evidence.exactChildSettlement,
    JSON.stringify(selected.verification, null, 2)
  ).toBeTruthy();
  expect(selected.verification.evidence.exactChildSettlement).toMatchObject({
    contractVersion: "exact-child-choice-settlement/v1",
    settled: true,
    semanticType: "age_at_departure",
    desiredCanonicalValue: "23",
    selectedCanonicalValue: "18+",
    actualStateBlank: true,
    validationClear: true,
    popupClosed: true,
    focusSettled: true
  });
  expect(await page.locator("#receipt-age-combobox").inputValue()).toBe("");
  expect(await page.locator("#receipt-continue").isEnabled()).toBe(true);
  const dormantEmailControls = selected.observation.page.controls.filter((control) => (
    control.fieldType === "email"
  ));
  expect(dormantEmailControls).toHaveLength(2);
  expect(dormantEmailControls.every((control) => (
    control.representationLifecycle?.status === "dormant_hidden"
  ))).toBe(true);

  // Exercise the same boundary as the live loop. The generic transition sees
  // a blank framework parent and only broader page progress; it must not
  // downgrade the exact browser-proven child settlement before TaskState can
  // persist it.
  const lifecycle = loopPrivate.applyTransitionStatus(withExecutionFixture({
    taskState: { ...surfaceTask, currentGoal: surfaceTask.currentGoal },
    currentGoal: surfaceTask.currentGoal,
    lastAction: selectedAction
  }, { recovery: { attempts: 0, phase: "idle", failedStrategies: [], failedStrategySignatures: [] } }), selected.observation, openedObservation);
  expect(lifecycle.observation.lastActionResult).toMatchObject({
    verified: true,
    expectedOutcomeObserved: true,
    postconditionSatisfied: true,
    outcome: { ok: true, code: "LOGICAL_COMPONENT_COMMITTED" }
  });

  const settledTask = reduceTaskState({
    previousTaskState: surfaceTask,
    observation: lifecycle.observation,
    previousActionResult: lifecycle.observation.lastActionResult,
    traveler,
    transactionReview
  });
  expect(settledTask.verifiedProfileComponents).toHaveLength(1);
  expect(settledTask.profileReadiness.ready).toBe(true);
  expect(settledTask.activeDecisions.some((decision) => (
    decision.family === "profile"
    && decision.observed?.representationLifecycle?.status === "dormant_hidden"
  ))).toBe(false);
  expect(settledTask.currentGoal).toMatchObject({
    semanticType: "navigation",
    desiredValue: "next_stage"
  });
  const continueControl = selected.observation.page.controls.find((control) => (
    /^continue$/i.test(control.label || "")
  ));
  expect(continueControl).toBeTruthy();
  expect(settledTask.currentGoal.actionableControlIds).toContain(continueControl.controlId);
  expect(await page.evaluate(() => window.__receiptAgeCounts)).toEqual({
    open: 1,
    eighteenPlus: 1,
    seventeen: 0,
    sixteen: 0
  });
});

test("live-shaped optional blank age state cannot reopen over an executable Continue", async ({ page }) => {
  await loadHtmlProducer(page, `
    <main>
      <h1>Passenger details</h1>
      <section aria-label="Adult 1">
        <label for="optional-age-parent">Age at time of travel</label>
        <input
          id="optional-age-parent"
          name="passengers.0.age"
          role="combobox"
          aria-label="Age at time of travel"
          aria-expanded="false"
          value=""
        >
      </section>
      <button id="optional-age-continue" type="button">Continue</button>
    </main>
  `);
  const traveler = { id: "traveler_optional_age_ready", date_of_birth: "2003-05-31" };
  await page.evaluate((profile) => {
    window.__ATW_TEST__.setAppDataForTest({ travelers: [profile] }, profile.id);
  }, traveler);

  const observation = await browserObservation(page, "obs_optional_age_ready_continue");
  const ageControl = observation.page.controls.find((control) => (
    control.fieldType === "age_at_departure"
  ));
  const continueControl = observation.page.controls.find((control) => (
    /^continue$/i.test(control.label || "")
  ));
  expect(ageControl).toBeTruthy();
  expect(ageControl.required).toBe(false);
  expect(ageControl.state.valuePresent).toBe(false);
  expect(observation.page.stageExit).toMatchObject({
    continueObserved: true,
    continueDisabled: false,
    navigationState: "ready",
    blockers: []
  });

  const taskState = reduceTaskState({
    previousTaskState: {
      terminalStatus: "active",
      currentGoal: {
        goalId: "profile:age_at_departure:0",
        kind: "profile_field",
        semanticType: "age_at_departure",
        desiredValue: "23",
        controlId: ageControl.controlId
      }
    },
    observation,
    traveler,
    transactionReview: verifiedTransactionReview()
  });

  expect(taskState.profileReadiness.ready).toBe(true);
  expect(taskState.currentObligation).toMatchObject({
    authority: "task_state",
    desiredValue: "next_stage",
    subject: { semanticType: "navigation" }
  });
  expect(taskState.currentGoal.actionableControlIds).toEqual([continueControl.controlId]);
});

test("dormant alternate forms stay observable without becoming active EasyJet-shaped requirements", async ({ page }) => {
  await loadHtmlProducer(page, `
    <style>[hidden] { display: none !important; }</style>
    <main>
      <h1>Passenger details</h1>
      <aside aria-label="Price breakdown">
        <button type="button">Edit Ljubljana to Edinburgh flight on 15th August 2026</button>
        <button type="button">Edit Edinburgh to Ljubljana flight on 9th September 2026</button>
        <button type="button">Edit passenger details on 15th August 2026</button>
        <p>Booking total 362 EUR</p>
      </aside>
      <form id="signin-form" hidden>
        <label>Sign in email <input type="email" name="signin.email" required></label>
      </form>
      <form id="signup-form" hidden>
        <label>Create account email <input type="email" name="signup.email" required></label>
      </form>
      <section aria-label="Passenger 1">
        <label>Title
          <select id="passenger-title" name="passengers.0.title" required>
            <option value="" selected>Title</option>
            <option value="Mr">Mr</option>
            <option value="Mrs">Mrs</option>
          </select>
        </label>
        <label>Age at time of travel
          <select id="passenger-age" aria-label="Age at time of travel" required>
            <option value="" selected>Age at time of travel</option>
            <option value="18_24">18–24</option>
            <option value="25_29">25–29</option>
          </select>
        </label>
      </section>
      <section id="contact-form" aria-label="Contact details" hidden>
        <label>Email address <input id="contact-email" type="email" name="contact.email" required></label>
        <label>Confirm email address <input id="confirm-email" type="email" name="contact.confirmEmail" required></label>
      </section>
      <button id="continue-button" type="button" disabled>Continue</button>
    </main>
    <script>
      const title = document.getElementById("passenger-title");
      const age = document.getElementById("passenger-age");
      const contact = document.getElementById("contact-form");
      const email = document.getElementById("contact-email");
      const confirmEmail = document.getElementById("confirm-email");
      const continueButton = document.getElementById("continue-button");
      const settle = () => {
        if (age.value) contact.hidden = false;
        continueButton.disabled = !(title.value && age.value && email.value && email.value === confirmEmail.value);
      };
      [title, age, email, confirmEmail].forEach((control) => {
        control.addEventListener("input", settle);
        control.addEventListener("change", settle);
      });
    </script>
  `);
  const traveler = {
    id: "traveler_dormant_forms",
    gender: "male",
    email: "ali@aztela.com",
    date_of_birth: "2003-05-31"
  };
  await page.evaluate((profile) => window.__ATW_TEST__.setAppDataForTest({ travelers: [profile] }, profile.id), traveler);

  const dormant = await browserObservation(page, "obs_dormant_alternate_forms");
  expect(dormant.page.transactionFacts.itinerary).toMatchObject({ completeness: "complete" });
  expect(dormant.page.transactionFacts.itinerary.segments).toEqual([
    expect.objectContaining({ origin: "LJUBLJANA", destination: "EDINBURGH", departureDate: "2026-08-15" }),
    expect.objectContaining({ origin: "EDINBURGH", destination: "LJUBLJANA", departureDate: "2026-09-09" })
  ]);
  expect(dormant.page.transactionFacts.itinerary.segments.every((segment) => (
    segment.evidence?.source === "itinerary_action_owner"
    && segment.evidence?.authoritative === true
  ))).toBe(true);
  const itineraryEditControls = dormant.page.controls.filter((control) => /^Edit .+ flight on /i.test(control.label || ""));
  expect(itineraryEditControls).toHaveLength(2);
  expect(itineraryEditControls.every((control) => control.globalChrome === true)).toBe(true);
  const selectedBooking = await page.evaluate(() => {
    const observed = window.__ATW_TEST__.observePageState({ forceFull: true, reason: "test_selected_booking_capture" });
    return window.__ATW_TEST__.captureSelectedBookingFromMap(observed.map)?.facts || null;
  });
  expect(selectedBooking?.itinerary?.segments).toEqual([
    expect.objectContaining({ origin: "LJUBLJANA", destination: "EDINBURGH", departureDate: "2026-08-15" }),
    expect.objectContaining({ origin: "EDINBURGH", destination: "LJUBLJANA", departureDate: "2026-09-09" })
  ]);
  expect(selectedBooking?.totalPrice).toEqual({ amount: 362, currency: "EUR" });
  expect(await page.evaluate((facts) => window.__ATW_TEST__.authoritativeSelectedBookingFacts({
    ...facts,
    currency: "",
    totalPrice: { amount: null, currency: "" },
    factEvidence: { ...facts.factEvidence, totalPrice: null }
  }), selectedBooking)).toBeNull();
  expect(await page.evaluate(() => {
    window.__ATW_TEST__.setAgentSessionForTest("chk_capture_complete");
    const scheduled = window.__ATW_TEST__.scheduleSelectedBookingCapture("post_session_mutation");
    window.__ATW_TEST__.setAgentSessionForTest("");
    return scheduled;
  })).toBe(false);
  const withSelectedBooking = (currentObservation) => ({
    ...currentObservation,
    page: { ...currentObservation.page, selectedBooking }
  });
  const hiddenEmailControls = dormant.page.controls.filter((control) => ["email", "confirm_email"].includes(control.fieldType));
  expect(hiddenEmailControls.length).toBeGreaterThanOrEqual(4);
  expect(hiddenEmailControls.every((control) => control.representationLifecycle?.status === "dormant_hidden")).toBe(true);
  expect(dormant.page.validationIssues?.some((issue) => /confirm email is empty/i.test(issue.message || issue))).toBe(false);
  expect(profileStageReadiness(dormant, traveler).ready).toBe(false);
  expect(deriveProfileGoal(dormant, traveler)).toMatchObject({ semanticType: "title", desiredValue: "mr" });

  const ageControl = dormant.page.controls.find((control) => /age at time of travel/i.test(
    `${control.label || ""} ${control.accessibleName || ""} ${control.ariaLabel || ""}`
  ));
  expect(ageControl).toBeTruthy();
  expect(ageControl.state.valueText).toBe("");
  expect(ageControl.selected).toBe(false);

  const executeCurrentProfileGoal = async (currentObservation, semanticType, observationId) => {
    const authoritativeObservation = withSelectedBooking(currentObservation);
    const goal = deriveProfileGoal(authoritativeObservation, traveler);
    expect(goal).toMatchObject({ semanticType });
    // TaskState/goal compilation owns semantic resolution. Downstream
    // mechanics receive the fresh browser observation without recreating the
    // Selected Booking context; the published goal must remain executable.
    const candidateSet = buildCurrentCandidateSet({
      goal,
      observation: currentObservation,
      traveler,
      state: { taskState: { currentGoal: goal }, approvals: {} }
    });
    expect(candidateSet.candidates).toHaveLength(1);
    return executeAtomicBrowserDecision(
      page,
      toClientDecision(loopPrivate.bindTargetSnapshot(
        actionForCurrentCandidate(goal, candidateSet.candidates[0], currentObservation),
        currentObservation
      )),
      observationId
    );
  };

  const titled = await executeCurrentProfileGoal(dormant, "title", "obs_easyjet_title_complete");
  const aged = await executeCurrentProfileGoal(titled.observation, "age_at_departure", "obs_easyjet_age_complete");
  expect(await page.locator("#passenger-age").inputValue()).toBe("18_24");
  expect(await page.locator("#contact-form").isVisible()).toBe(true);

  const active = aged.observation;
  const contactEmail = active.page.controls.find((control) => (
    control.fieldType === "email" && /contact\.email/i.test(control.name || control.stableKey || "")
  ));
  expect(contactEmail.representationLifecycle).toMatchObject({ status: "active_rendered", active: true });
  expect(deriveProfileGoal(active, traveler)).toMatchObject({ semanticType: "email" });

  const emailed = await executeCurrentProfileGoal(active, "email", "obs_easyjet_email_complete");
  const confirmed = await executeCurrentProfileGoal(emailed.observation, "confirm_email", "obs_easyjet_confirm_email_complete");
  expect(profileStageReadiness(withSelectedBooking(confirmed.observation), traveler).ready).toBe(true);
  expect(await page.locator("#continue-button").isEnabled()).toBe(true);
  expect(await page.locator("#contact-email").inputValue()).toBe("ali@aztela.com");
  expect(await page.locator("#confirm-email").inputValue()).toBe("ali@aztela.com");
});

test("required reason-for-travel radios use one profile-backed travel-purpose requirement", async ({ page }) => {
  await loadHtmlProducer(page, `
    <main>
      <h1>Checkout details</h1>
      <fieldset aria-required="true">
        <legend id="reason-for-travel-legend">Please tell us your reason for travel</legend>
        <label><input id="purpose-business" type="radio" name="reasonForTravelRadioInput" value="business" required> Business</label>
        <label><input id="purpose-leisure" type="radio" name="reasonForTravelRadioInput" value="leisure" required> Leisure</label>
      </fieldset>
      <button type="button" disabled>Continue</button>
    </main>
    <script>
      const continueButton = document.querySelector("button");
      document.querySelectorAll("input[type=radio]").forEach((radio) => {
        radio.addEventListener("change", () => { continueButton.disabled = false; });
      });
    </script>
  `);
  const traveler = { id: "traveler_purpose", travel_purpose: "leisure" };
  await page.evaluate((profile) => window.__ATW_TEST__.setAppDataForTest({ travelers: [profile] }, profile.id), traveler);

  const observation = await browserObservation(page, "obs_travel_purpose");
  const purposeControls = observation.page.controls.filter((control) => control.fieldType === "travel_purpose");
  expect(purposeControls).toHaveLength(2);
  expect(purposeControls.every((control) => control.representationLifecycle?.status === "active_rendered")).toBe(true);
  const goal = deriveProfileGoal(observation, traveler);
  expect(goal).toMatchObject({ semanticType: "travel_purpose", desiredValue: "leisure" });
  const candidateSet = buildCurrentCandidateSet({
    goal,
    observation,
    traveler,
    state: { taskState: { currentGoal: goal }, approvals: {} }
  });
  expect(candidateSet.candidates).toHaveLength(1);
  const selected = await executeAtomicBrowserDecision(
    page,
    toClientDecision(loopPrivate.bindTargetSnapshot(
      actionForCurrentCandidate(goal, candidateSet.candidates[0], observation),
      observation
    )),
    "obs_travel_purpose_selected"
  );

  expect(await page.locator("#purpose-leisure").isChecked()).toBe(true);
  expect(await page.locator("#purpose-business").isChecked()).toBe(false);
  expect(profileStageReadiness(selected.observation, traveler).ready).toBe(true);
});

test("final terms review with Pay by card is terminal before legal acceptance", async ({ page }) => {
  await loadHtmlProducer(page, `
    <main>
      <h1>Review your booking</h1>
      <section aria-label="Travel details">
        <h2>Departure itinerary</h2>
        <p>Ljubljana to Edinburgh</p>
      </section>
      <section aria-label="Order total"><strong>Total EUR 361.97</strong></section>
      <fieldset>
        <legend>Legal acceptance</legend>
        <label>
          <input id="terms" type="checkbox" required>
          I confirm that I am aged 18 or over and have read and accepted the terms and conditions, booking and cancellation terms, and dangerous goods restrictions.
        </label>
      </fieldset>
      <button id="pay" type="button" disabled>Pay by card</button>
    </main>
  `);

  const observation = await browserObservation(page, "obs_final_terms_payment_review");
  expect(observation.page.terminalEvidence).toMatchObject({
    stage: "payment_review",
    boundaryObserved: true,
    signals: { legal: true, review: true, commit: true }
  });
  expect(observation.page.step).toBe("payment");
  const termsControl = observation.page.controls.find((control) => /read and accepted.*terms/i.test(control.label || ""));
  expect(termsControl).toMatchObject({ semantic: "legal_acceptance", risk: "legal" });
  const state = reduceTaskState({
    observation,
    transactionReview: verifiedTransactionReview(361.97)
  });
  expect(state.stage).toBe("payment");
  expect(state.terminalStatus).toBe("payment_review_reached");
  expect(state.currentGoal).toBeNull();
});

test("opaque native choice completes open and select as one trusted episode", async ({ page }) => {
  await loadHtmlProducer(page, `
    <style>
      body { font-family: sans-serif; padding: 24px; }
      .select-shell { position: relative; width: 240px; height: 42px; border: 1px solid #777; cursor: pointer; }
      .select-shell select { position: absolute; inset: 0; width: 100%; opacity: 0; pointer-events: none; }
      .select-shell span { display: block; padding: 10px; }
    </style>
    <main>
      <h1>Passenger details</h1>
      <label>Title
        <div id="atomic-title-wrapper" class="select-shell">
          <select id="atomic-title-state" name="passengers.0.title" disabled required>
            <option value="">Select</option>
            <option value="Mr">Male</option>
            <option value="Ms">Female</option>
          </select>
          <span id="atomic-title-value">Select</span>
        </div>
      </label>
    </main>
  `);
  const traveler = { id: "traveler_atomic_choice", first_name: "Ali", last_name: "Sifrar", gender: "male" };
  await page.evaluate((profile) => {
    window.__ATW_TEST__.setAppDataForTest({ travelers: [profile] }, profile.id);
    window.__ATW_TEST_TRUSTED_CHOICE__ = ({ element, choiceLabel }) => {
      const select = element.querySelector("select") || document.getElementById("atomic-title-state");
      const option = [...select.options].find((item) => item.textContent.trim() === choiceLabel);
      if (!option) return { ok: false, code: "OPTION_NOT_FOUND" };
      select.value = option.value;
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
      document.getElementById("atomic-title-value").textContent = option.textContent;
      window.__atomicChoiceDispatch = { targetId: element.id, choiceLabel };
      return { ok: true };
    };
  }, traveler);

  const observation = await browserObservation(page, "obs_atomic_choice_initial");
  const goal = deriveProfileGoal(observation, traveler);
  const authoritativeSet = buildCurrentCandidateSet({
    goal,
    observation,
    traveler,
    state: { taskState: { currentGoal: goal }, approvals: {} }
  });
  expect(authoritativeSet.recoveryCandidates[0]).toMatchObject({
    operation: "select",
    interactionMethod: "browser_trusted_choice",
    value: "Male"
  });
  expect(authoritativeSet.recoveryCandidates.some((item) => (
    item.operation === "open" && item.interactionMethod === "browser_trusted_input"
  ))).toBe(false);
  expect(authoritativeSet.recoveryCandidates.find((item) => (
    item.interactionMethod === "browser_trusted_choice"
  ))).toMatchObject({
    operation: "select",
    interactionMethod: "browser_trusted_choice",
    value: "Male"
  });
  const scheduledSet = groundedObservationCandidateSet(goal, observation, [], {
    state: { taskState: { currentGoal: goal }, approvals: {} },
    traveler,
    approvals: {}
  });
  const authoritativeCandidate = scheduledSet.candidates[0];
  expect(authoritativeCandidate).toMatchObject({
    operation: "select",
    interactionMethod: "browser_trusted_choice",
    value: "Male"
  });
  const allCandidates = candidatesForProfileGoal(goal, observation, traveler, [], { includeAlternates: true });
  const candidate = allCandidates
    .find((item) => item.interactionMethod === "browser_trusted_choice");
  const observedTitle = observation.page.controls.find((control) => control.name === "passengers.0.title");
  expect(candidate, JSON.stringify({
    goal,
    recovery: observedTitle?.recovery,
    capabilities: goal?.capabilityContracts,
    candidates: allCandidates
  }, null, 2)).toBeTruthy();
  expect(candidate).toMatchObject({
    type: "click",
    operation: "select",
    value: "Male",
    boundedRecovery: true,
    capabilityStatus: "unproven_experiment",
    executionChannel: "bounded_recovery"
  });
  expect(candidate.expectedOutcome).toMatchObject({
    type: "logical_component_committed",
    expectedNormalizedValue: "mr"
  });

  const taskState = reduceTaskState({ observation, traveler });
  const authoritativeGoal = {
    ...goal,
    candidateSet: scheduledSet,
    candidates: scheduledSet.candidates
  };
  let state = createCheckoutSessionState({
    goal: "Complete passenger details",
    travelerId: traveler.id,
    site: { host: "example.test", url: page.url() }
  });
  state.id = "txn_atomic_choice";
  state = {
    ...state,
    taskState: { ...taskState, currentGoal: authoritativeGoal },
    currentGoal: authoritativeGoal,
    currentObservation: {
      observationId: observation.observationId,
      observationHash: observation.observationSnapshot.snapshotHash
    }
  };
  const store = inMemoryGovernorStore();
  store.remember(state.id, observation);
  const action = loopPrivate.bindTargetSnapshot(
    actionForCurrentCandidate(goal, authoritativeCandidate, observation),
    observation
  );
  const governed = governAction({
    action,
    state,
    observation,
    traveler,
    store,
    turnId: "turn_atomic_choice"
  });
  expect(governed.allow, `${governed.code}: ${governed.reason}`).toBe(true);
  expect(governed.checks).toContainEqual(expect.objectContaining({
    code: "CANONICAL_BOUNDED_RECOVERY_BOUND",
    detail: expect.stringContaining("browser_trusted_choice")
  }));
  const selected = await executeAtomicBrowserDecision(
    page,
    toClientDecision(governed.action),
    "obs_atomic_choice_selected"
  );
  expect(selected.verification).toMatchObject({ ok: true, code: "LOGICAL_COMPONENT_COMMITTED" });
  expect(await page.evaluate(() => window.__atomicChoiceDispatch)).toEqual({
    targetId: "atomic-title-wrapper",
    choiceLabel: "Male"
  });
  const titleField = resolveLogicalFields(selected.observation.page, traveler)
    .find((field) => field.semanticType === "title");
  expect(titleField.currentCanonicalValue).toBe("mr");
  expect(logicalFieldSatisfied(titleField)).toBe(true);
});

test("large country dropdown preserves and selects the profile match beyond the transport option cap", async ({ page }) => {
  await loadHtmlProducer(page, `
    <style>
      body { font-family: sans-serif; padding: 24px; }
      .select-shell { position: relative; width: 280px; height: 42px; border: 1px solid #777; cursor: pointer; }
      .select-shell select { position: absolute; inset: 0; width: 100%; opacity: 0; pointer-events: none; }
      .select-shell span { display: block; padding: 10px; }
    </style>
    <main>
      <h1>Passenger details</h1>
      <label>Nationality
        <div id="large-nationality-wrapper" class="select-shell">
          <select id="large-nationality-state" name="passengers.0.nationality" disabled required>
            <option value="">Select</option>
          </select>
          <span id="large-nationality-value">Select</span>
        </div>
      </label>
    </main>
    <script>
      const select = document.getElementById("large-nationality-state");
      for (let index = 1; index <= 180; index += 1) {
        const option = document.createElement("option");
        option.value = "c" + String(index).padStart(3, "0");
        option.textContent = "Country " + String(index).padStart(3, "0");
        select.appendChild(option);
      }
      const slovenia = document.createElement("option");
      slovenia.value = "SI";
      slovenia.textContent = "Slovenia";
      select.appendChild(slovenia);
    </script>
  `);
  const traveler = {
    id: "traveler_large_country",
    first_name: "Ali",
    last_name: "Sifrar",
    nationality: "SI"
  };
  await page.evaluate((profile) => {
    window.__ATW_TEST__.setAppDataForTest({ travelers: [profile] }, profile.id);
    window.__ATW_TEST_TRUSTED_CHOICE__ = ({ element, choiceLabel }) => {
      const select = element.querySelector("select") || document.getElementById("large-nationality-state");
      const option = [...select.options].find((item) => (
        item.value.toLowerCase() === choiceLabel.toLowerCase()
        || item.textContent.trim().toLowerCase() === choiceLabel.toLowerCase()
      ));
      if (!option) return { ok: false, code: "OPTION_NOT_FOUND" };
      select.value = option.value;
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
      document.getElementById("large-nationality-value").textContent = option.textContent;
      window.__largeCountryDispatch = { targetId: element.id, choiceLabel };
      return { ok: true };
    };
  }, traveler);

  const observation = await browserObservation(page, "obs_large_country_initial");
  const nationality = observation.page.controls.find((control) => (
    control.name === "passengers.0.nationality"
  ));
  expect(nationality).toMatchObject({
    optionCount: 182,
    optionsTruncated: true,
    goalMatchedOptionCount: 1,
    sourceStateDisabled: true,
    logicalDisabled: false,
    hasActionableActuator: true
  });
  expect(nationality.options).toHaveLength(120);
  expect(nationality.options).toContainEqual(expect.objectContaining({
    value: "SI",
    label: "Slovenia",
    goalMatch: true
  }));
  expect(nationality.structuredPrice).toBeNull();
  expect(nationality.risk).not.toBe("money");

  const goal = deriveProfileGoal(observation, traveler);
  const scheduledSet = groundedObservationCandidateSet(goal, observation, [], {
    state: { taskState: { currentGoal: goal }, approvals: {} },
    traveler,
    approvals: {}
  });
  if (!scheduledSet.candidates[0]) {
    throw new Error(JSON.stringify({
      goal,
      recovery: nationality.recovery,
      candidateSet: scheduledSet
    }, null, 2));
  }
  expect(scheduledSet.candidates[0]).toMatchObject({
    operation: "select",
    interactionMethod: "browser_trusted_choice",
    value: "Slovenia"
  });
  const selected = await executeAtomicBrowserDecision(
    page,
    toClientDecision(actionForCurrentCandidate(goal, scheduledSet.candidates[0], observation)),
    "obs_large_country_selected"
  );
  expect(selected.verification).toMatchObject({ ok: true, code: "LOGICAL_COMPONENT_COMMITTED" });
  expect(await page.evaluate(() => window.__largeCountryDispatch)).toEqual({
    targetId: "large-nationality-wrapper",
    choiceLabel: "Slovenia"
  });
});

test("native nationality select executes the exact compiled option instead of a short-code substring", async ({ page }) => {
  await loadHtmlProducer(page, `
    <main>
      <h1>Passenger details</h1>
      <label>Nationality
        <select id="nationality" name="passengers.0.nationality" required>
          <option value="">Select</option>
          <option value="pf">French Polynesia</option>
          <option value="si">Slovenia</option>
          <option value="sk">Slovakia</option>
        </select>
      </label>
    </main>
    <script>
      window.__nationalityChanges = [];
      document.getElementById("nationality").addEventListener("change", (event) => {
        window.__nationalityChanges.push(event.target.value);
      });
    </script>
  `);
  const traveler = {
    id: "traveler_exact_nationality",
    first_name: "Ali",
    last_name: "Sifrar",
    nationality: "SI"
  };
  await page.evaluate((profile) => {
    window.__ATW_TEST__.setAppDataForTest({ travelers: [profile] }, profile.id);
  }, traveler);

  const observation = await browserObservation(page, "obs_exact_nationality_initial");
  const goal = deriveProfileGoal(observation, traveler);
  const scheduledSet = groundedObservationCandidateSet(goal, observation, [], {
    state: { taskState: { currentGoal: goal }, approvals: {} },
    traveler,
    approvals: {}
  });
  const candidate = scheduledSet.candidates.find((item) => item.interactionMethod === "native_select");
  expect(candidate).toMatchObject({
    operation: "select",
    value: "si",
    exactOption: {
      canonicalValue: "si",
      siteValue: "si",
      label: "Slovenia",
      source: "observed_unique_option"
    }
  });
  expect(candidate.pipelineContract.component.exactOption).toEqual(candidate.exactOption);

  const decision = toClientDecision(actionForCurrentCandidate(goal, candidate, observation));
  expect(decision.exactOption).toEqual(candidate.exactOption);
  const selected = await executeAtomicBrowserDecision(page, decision, "obs_exact_nationality_selected");
  expect(selected.verification).toMatchObject({ ok: true, code: "LOGICAL_COMPONENT_COMMITTED" });
  expect(await page.evaluate(() => ({
    value: document.getElementById("nationality").value,
    label: document.getElementById("nationality").selectedOptions[0].textContent.trim(),
    changes: window.__nationalityChanges
  }))).toEqual({
    value: "si",
    label: "Slovenia",
    changes: ["si"]
  });
});

test("ambiguous canonical nationality options fail closed before native mutation", async ({ page }) => {
  await loadHtmlProducer(page, `
    <main>
      <h1>Passenger details</h1>
      <label>Nationality
        <select id="nationality" name="passengers.0.nationality" required>
          <option value="">Select</option>
          <option value="si">Slovenia</option>
          <option value="si">Slovenia (passport list)</option>
        </select>
      </label>
    </main>
  `);
  const traveler = { id: "traveler_ambiguous_nationality", nationality: "SI" };
  await page.evaluate((profile) => {
    window.__ATW_TEST__.setAppDataForTest({ travelers: [profile] }, profile.id);
  }, traveler);
  const observation = await browserObservation(page, "obs_ambiguous_nationality");
  const goal = deriveProfileGoal(observation, traveler);
  const candidates = candidatesForProfileGoal(goal, observation, traveler, [], { includeAlternates: true });
  expect(candidates.some((candidate) => candidate.interactionMethod === "native_select")).toBe(false);
  expect(await page.locator("#nationality").inputValue()).toBe("");
});

test("stage exit distinguishes an observed disabled Continue from navigation that is not present", async ({ page }) => {
  await loadHtmlProducer(page, `
    <main>
      <h1>Passenger details</h1>
      <label>Given name <input name="firstName" autocomplete="given-name" value="Ali"></label>
      <button id="add-passenger" type="button" disabled>Add another passenger</button>
      <button id="back" type="button" disabled>Back</button>
      <button id="continue" type="button" disabled>Continue</button>
    </main>
  `);

  const disabled = await browserObservation(page, "obs_disabled_navigation_distinction");
  expect(disabled.page.stageExit).toMatchObject({
    continueObserved: true,
    continueDisabled: true,
    navigationState: "disabled"
  });
  expect(disabled.page.stageExit.blockers).toContain("Continue is disabled");
  expect(disabled.page.stageExit.blockers).not.toContain("no safe Continue button");

  const missing = await page.evaluate(() => {
    document.getElementById("continue").remove();
    return window.__ATW_TEST__.buildPageMap().stageExit;
  });
  expect(missing).toMatchObject({
    continueObserved: false,
    continueDisabled: false,
    navigationState: "not_observed"
  });
  expect(missing.blockers).toContain("Continue not observed");
});

test("destination, grounding, and TaskState waits share one mutation-or-deadline lifecycle", async ({ page }) => {
  await loadProducer(page);
  const now = Date.now();
  const result = await page.evaluate(({ startedAt, deadlineAt }) => {
    const hooks = window.__ATW_TEST__;
    hooks.setAppDataForTest({
      travelers: [{
        id: "trav_navigation_settling",
        first_name: "Ali",
        last_name: "Sifrar"
      }],
      preferences: {}
    }, "trav_navigation_settling");
    hooks.setAgentRunningForTest(true);
    const decision = {
      action: "wait",
      intent: "reobserve_degraded_loading_destination",
      semanticIntent: "wait_for_ready_observation",
      expectedPostconditions: [{
        type: "observation_readiness",
        status: "READY"
      }],
      readinessStartedAt: startedAt,
      readinessDeadlineAt: deadlineAt,
      readinessAttempts: 1,
      observationId: "obs_navigation_settling",
      actionId: "act_navigation_settling"
    };
    const taskStateDecision = {
      ...decision,
      intent: "task_state_reobserve",
      reobserveRetryToken: "retry_current_surface_once"
    };
    const recognized = hooks.isDestinationReadinessDecision(decision);
    const groundingRecoveryRecognized = hooks.isDestinationReadinessDecision({
      action: "wait",
      intent: "reobserve_after_grounding_rejection"
    });
    const taskStateRecognized = hooks.isDestinationReadinessDecision({
      action: "wait",
      intent: "task_state_reobserve"
    });
    hooks.beginDestinationWait(taskStateDecision);
    const state = hooks.agentLoopState();
    const map = hooks.buildPageMap();
    const compact = hooks.compactPageMap(map, "obs_navigation_settling");
    const fullPayload = {
      sessionId: "session_navigation_settling",
      observationId: "obs_navigation_settling",
      observationUpdate: {
        mode: "reference",
        baseSnapshotHash: compact.snapshotHash,
        snapshotHash: compact.snapshotHash,
        material: false
      },
      page: compact,
      destinationReadiness: { retryToken: "retry_current_surface_once" }
    };
    const referencePayload = hooks.referenceObservationTransport(fullPayload);
    hooks.clearDestinationWait("test_complete");
    hooks.setAgentRunningForTest(false);
    return {
      recognized,
      groundingRecoveryRecognized,
      taskStateRecognized,
      state,
      referencePayload,
      fullBytes: hooks.observationTransportBytes(fullPayload),
      referenceBytes: hooks.observationTransportBytes(referencePayload)
    };
  }, { startedAt: now, deadlineAt: now + 8_000 });

  expect(result.recognized).toBe(true);
  expect(result.groundingRecoveryRecognized).toBe(true);
  expect(result.taskStateRecognized).toBe(true);
  expect(result.state.destinationWait.status).toBe("WAITING_FOR_DESTINATION");
  expect(result.state.destinationWait.startedAt).toBe(now);
  expect(result.state.destinationWait.deadlineAt).toBe(now + 8_000);
  expect(result.state.destinationWait.backendWaits).toBe(1);
  expect(result.state.destinationWait.retryToken).toBe("retry_current_surface_once");
  expect(result.referencePayload).toMatchObject({
    transportMode: "observation_reference",
    page: { referenceOnly: true },
    destinationReadiness: { retryToken: "retry_current_surface_once" }
  });
  expect(result.referenceBytes).toBeLessThan(result.fullBytes / 2);
});

test("closed ARIA combobox with owned options exposes and verifies one trusted choice", async ({ page }) => {
  await loadHtmlProducer(page, `
    <style>
      body { font-family: sans-serif; padding: 24px; }
      .select-shell { display: inline-block; width: 240px; }
      #aria-title { width: 100%; height: 42px; text-align: left; }
      #aria-title-options[hidden] { display: none; }
    </style>
    <main>
      <h1>Passenger details</h1>
      <label for="aria-title">Title</label>
      <div id="aria-title-wrapper" class="select-shell">
        <button
          id="aria-title"
          type="button"
          name="passengers.0.title"
          role="combobox"
          aria-expanded="false"
          aria-controls="aria-title-options"
        >Select</button>
      </div>
    </main>
    <div id="aria-title-options" role="listbox" aria-label="Title options" hidden>
      <button type="button" role="option" data-value="mr">Male</button>
      <button type="button" role="option" data-value="ms">Female</button>
    </div>
  `);
  const traveler = { id: "traveler_aria_choice", first_name: "Ali", last_name: "Sifrar", gender: "male" };
  await page.evaluate((profile) => {
    window.__ATW_TEST__.setAppDataForTest({ travelers: [profile] }, profile.id);
    window.__ATW_TEST_TRUSTED_CHOICE__ = ({ element, choiceLabel }) => {
      const control = element.matches?.("#aria-title")
        ? element
        : element.querySelector?.("#aria-title") || document.getElementById("aria-title");
      const option = [...document.querySelectorAll("#aria-title-options [role='option']")]
        .find((item) => item.textContent.trim() === choiceLabel);
      if (!control || !option) return { ok: false, code: "OPTION_NOT_FOUND" };
      control.textContent = option.textContent.trim();
      control.dataset.value = option.dataset.value;
      control.dispatchEvent(new Event("input", { bubbles: true }));
      control.dispatchEvent(new Event("change", { bubbles: true }));
      window.__ariaChoiceDispatch = { targetId: element.id, choiceLabel };
      return { ok: true };
    };
  }, traveler);

  const observation = await browserObservation(page, "obs_aria_choice_initial");
  const titleControl = observation.page.controls.find((control) => control.name === "passengers.0.title");
  expect(titleControl).toBeTruthy();
  expect(titleControl.options).toEqual(expect.arrayContaining([
    expect.objectContaining({ value: "mr", label: "Male" }),
    expect.objectContaining({ value: "ms", label: "Female" })
  ]));
  expect(titleControl.recovery.select.strategies).toEqual(expect.arrayContaining([
    expect.objectContaining({ method: "browser_trusted_choice", operation: "select" })
  ]));

  const goal = deriveProfileGoal(observation, traveler);
  const candidate = candidatesForProfileGoal(goal, observation, traveler, [], { includeAlternates: true })
    .find((item) => item.interactionMethod === "browser_trusted_choice");
  expect(candidate).toMatchObject({ operation: "select", value: "Male" });
  const selected = await executeAtomicBrowserDecision(
    page,
    toClientDecision(actionForCurrentCandidate(goal, candidate, observation)),
    "obs_aria_choice_selected"
  );
  expect(selected.verification).toMatchObject({ ok: true, code: "LOGICAL_COMPONENT_COMMITTED" });
  const titleField = resolveLogicalFields(selected.observation.page, traveler)
    .find((field) => field.semanticType === "title");
  expect(titleField.currentCanonicalValue).toBe("mr");
  expect(logicalFieldSatisfied(titleField)).toBe(true);
});

test("trusted choice closes and blurs a popup before publishing a settled commit", async ({ page }) => {
  await loadHtmlProducer(page, `
    <style>
      body { font-family: sans-serif; padding: 24px; }
      #nationality { width: 240px; height: 42px; }
      #nationality-options[hidden] { display: none; }
    </style>
    <main>
      <h1>Passenger details</h1>
      <label for="nationality">Nationality</label>
      <button
        id="nationality"
        type="button"
        name="passengers.0.nationality"
        role="combobox"
        aria-expanded="false"
        aria-controls="nationality-options"
      >Select</button>
      <input id="next-field" aria-label="Next field">
    </main>
    <div id="nationality-options" role="listbox" aria-label="Nationality options" hidden>
      <button type="button" role="option" data-value="SI">Slovenia</button>
      <button type="button" role="option" data-value="GB">United Kingdom</button>
    </div>
  `);
  const traveler = {
    id: "traveler_choice_settle",
    first_name: "Ali",
    last_name: "Sifrar",
    nationality: "SI"
  };
  await page.evaluate((profile) => {
    window.__ATW_TEST__.setAppDataForTest({ travelers: [profile] }, profile.id);
    window.__ATW_TEST_TRUSTED_CHOICE__ = ({ element, choiceLabel }) => {
      const options = document.getElementById("nationality-options");
      const option = [...options.querySelectorAll("[role='option']")]
        .find((item) => item.textContent.trim() === choiceLabel);
      if (!option) return { ok: false, code: "OPTION_NOT_FOUND" };
      element.focus();
      element.textContent = option.textContent.trim();
      element.dataset.value = option.dataset.value;
      element.setAttribute("aria-expanded", "true");
      options.hidden = false;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true };
    };
    window.__ATW_TEST_TRUSTED_KEY__ = ({ key }) => {
      const control = document.getElementById("nationality");
      const options = document.getElementById("nationality-options");
      if (key === "Escape") {
        control.setAttribute("aria-expanded", "false");
        options.hidden = true;
      }
      if (key === "Tab") document.getElementById("next-field").focus();
      return { ok: true };
    };
  }, traveler);

  const initial = await browserObservation(page, "obs_choice_settle_initial");
  const control = initial.page.controls.find((item) => item.name === "passengers.0.nationality");
  const settled = await page.evaluate(async ({ controlId }) => {
    const hooks = window.__ATW_TEST__;
    const element = document.getElementById("nationality");
    const decision = {
      id: "act_choice_settle",
      actionId: "act_choice_settle",
      observationId: "obs_choice_settle_initial",
      controlId,
      targetId: element.id,
      targetLabel: "Nationality",
      value: "Slovenia"
    };
    const trusted = await hooks.trustedBrowserChoice(element, decision);
    const commit = trusted.ok
      ? await hooks.settleTrustedChoiceInteraction(element, decision)
      : trusted;
    const verification = hooks.withChoiceCommitEvidence(
      { ok: true, code: "VALUE_VERIFIED", evidence: { actualNormalizedValue: "si" } },
      {
        ...commit,
        map: {
          fullText: "x".repeat(1_000_000),
          controls: Array.from({ length: 20 }, (_, index) => ({ controlId: `ctrl_${index}` }))
        }
      }
    );
    const after = hooks.buildPageMap();
    const afterControl = after.controls.find((item) => item.controlId === controlId);
    return {
      commit,
      commitBytes: new Blob([JSON.stringify(commit)]).size,
      verification,
      expanded: document.getElementById("nationality").getAttribute("aria-expanded"),
      optionsHidden: document.getElementById("nationality-options").hidden,
      activeElementId: document.activeElement?.id || "",
      commitState: afterControl?.commitState || null,
      hasActionableActuator: afterControl?.hasActionableActuator === true,
      logicalDisabled: afterControl?.logicalDisabled === true,
      selectActuatorIds: afterControl?.recovery?.select?.actuatorIds || []
    };
  }, {
    controlId: control.controlId
  });

  expect(settled.commit).toMatchObject({
    ok: true,
    code: "CHOICE_COMMIT_SETTLED",
    popupClosed: true,
    focusSettled: true,
    escapeAttempted: true,
    tabAttempted: true
  });
  expect(settled.commit.map).toBeUndefined();
  expect(settled.commitBytes).toBeLessThan(5_000);
  expect(settled.verification.evidence.choiceCommit.map).toBeUndefined();
  expect(settled.verification.evidence.choiceCommit).toMatchObject({
    ok: true,
    code: "CHOICE_COMMIT_SETTLED",
    popupClosed: true,
    focusSettled: true
  });
  expect(settled.expanded).toBe("false");
  expect(settled.optionsHidden).toBe(true);
  expect(settled.activeElementId).toBe("next-field");
  expect(settled.commitState).toMatchObject({
    status: "settled",
    popupClosed: true,
    focusSettled: true
  });
  expect(settled.hasActionableActuator).toBe(true);
  expect(settled.logicalDisabled).toBe(false);
  expect(settled.selectActuatorIds.length).toBeGreaterThan(0);
});

test("disabled semantic select with a targetable right-edge DIV exhausts synthetic opens before one trusted choice", async ({ page }) => {
  await loadHtmlProducer(page, `
    <style>
      [hidden] { display: none !important; }
      body { font-family: sans-serif; padding: 24px; }
      .select-shell {
        position: relative;
        width: 260px;
        height: 42px;
        border: 1px solid #777;
        cursor: pointer;
      }
      .select-shell select {
        position: absolute;
        inset: 0;
        width: 100%;
        opacity: 0;
        pointer-events: none;
      }
      .select-value { display: block; padding: 11px; }
      .select-indicator {
        position: absolute;
        right: 0;
        top: 0;
        width: 42px;
        height: 42px;
        display: grid;
        place-items: center;
        cursor: pointer;
      }
      #right-edge-options {
        position: fixed;
        left: 330px;
        top: 90px;
        background: white;
        border: 1px solid #222;
      }
    </style>
    <main>
      <h1>Passenger details</h1>
      <label>Title
        <div id="right-edge-wrapper" class="select-shell">
          <select id="right-edge-state" name="passengers.0.title" disabled required>
            <option value="">Title</option><option value="Mr">Mr</option>
          </select>
          <span class="select-value">Title</span>
          <div id="right-edge-actuator" class="select-indicator">⌄</div>
        </div>
      </label>
    </main>
    <div id="right-edge-options" role="listbox" aria-label="Title options" hidden>
      <button type="button" role="option">Mr</button>
    </div>
  `);
  const traveler = { id: "traveler_right_edge", first_name: "Ali", last_name: "Sifrar", gender: "male" };
  await page.evaluate((profile) => {
    window.__ATW_TEST__.setAppDataForTest({ travelers: [profile] }, profile.id);
    window.__rightEdgeDispatches = [];
    document.addEventListener("click", (event) => {
      if (!event.target.closest("#right-edge-wrapper")) return;
      window.__rightEdgeDispatches.push({
        method: "synthetic_dom_event",
        targetId: event.target.id || ""
      });
    });
    window.__ATW_TEST_TRUSTED_CHOICE__ = ({ element, decision, choiceLabel }) => {
      window.__rightEdgeDispatches.push({
        method: decision.interactionMethod,
        targetId: element.id,
        choiceLabel
      });
      const select = document.getElementById("right-edge-state");
      select.value = "Mr";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      document.querySelector(".select-value").textContent = "Mr";
      return { ok: true };
    };
  }, traveler);

  const observation = await browserObservation(page, "obs_right_edge_ladder");
  const titleControl = observation.page.controls.find((control) => control.name === "passengers.0.title");
  expect(titleControl.operations.open).toBeFalsy();
  expect(titleControl.stateElementId).toBeTruthy();
  expect(titleControl.recovery.open.actuatorIds).toEqual(expect.arrayContaining([
    await page.locator("#right-edge-wrapper").getAttribute("data-atw-element-id"),
    await page.locator("#right-edge-actuator").getAttribute("data-atw-element-id")
  ]));
  expect(titleControl.interactionLadder[0]).toMatchObject({
    method: "native_select",
    status: "unavailable",
    operationProven: false
  });
  expect(titleControl.interactionLadder.some((strategy) => strategy.method === "browser_trusted_input")).toBe(false);
  expect(titleControl.recovery.select.strategies).toEqual(expect.arrayContaining([
    expect.objectContaining({ method: "browser_trusted_choice", operation: "select" })
  ]));
  expect(titleControl.interactionLadder.every((strategy, index) => strategy.order === index + 1)).toBe(true);

  const goal = deriveProfileGoal(observation, traveler);
  const attempted = [];
  const dispatchedStrategies = [];
  let selected = null;
  for (let index = 0; index < 12; index += 1) {
    const built = buildCurrentCandidateSet({
      goal,
      observation,
      traveler,
      state: { taskState: { currentGoal: goal }, approvals: {} },
      attemptedStrategySignatures: attempted
    });
    const candidate = built.recoveryCandidates[0];
    expect(candidate, JSON.stringify({ attempted, context: built.contextCapabilities }, null, 2)).toBeTruthy();
    const action = actionForCurrentCandidate(goal, candidate, observation);
    const signature = actuatorSignature(action);
    expect(dispatchedStrategies).not.toContain(signature);
    dispatchedStrategies.push(signature);
    const result = await executeAtomicBrowserDecision(
      page,
      toClientDecision(action),
      `obs_right_edge_attempt_${index + 1}`
    );
    expect(result.result.dispatched).toBe(true);
    expect(candidate.targetId).not.toBe(titleControl.stateElementId);
    if (candidate.interactionMethod === "browser_trusted_choice") {
      selected = result;
      break;
    }
    expect(candidate.operation).toBe("open");
    expect(result.verification.ok).toBe(false);
    attempted.push(signature);
  }

  expect(selected?.verification).toMatchObject({ ok: true, code: "LOGICAL_COMPONENT_COMMITTED" });
  expect(new Set(dispatchedStrategies).size).toBe(dispatchedStrategies.length);
  const trustedDispatches = await page.evaluate(() => (
    window.__rightEdgeDispatches.filter((entry) => entry.method === "browser_trusted_choice")
  ));
  expect(trustedDispatches).toHaveLength(1);
  expect(["right-edge-wrapper", "right-edge-actuator"]).toContain(trustedDispatches[0].targetId);
  expect(trustedDispatches[0].choiceLabel).toBe("Mr");
});

test("direct semantic conflicts fail closed and broad profile context does not own baggage", async ({ page }) => {
  await loadHtmlProducer(page, `
    <main>
      <h1>Passenger details</h1>
      <fieldset>
        <legend>Date of birth</legend>
        <label>Checked baggage
          <select name="baggage_option"><option value="">Choose</option><option>20 kg</option></select>
        </label>
      </fieldset>
      <fieldset role="radiogroup" aria-label="Gender">
        <label><input type="radio" name="title" value="Male">Male</label>
        <label><input type="radio" name="title" value="Female">Female</label>
      </fieldset>
    </main>
  `);
  const map = await page.evaluate(() => window.__ATW_TEST__.buildPageMap());
  const baggage = map.controls.find((control) => control.name === "baggage_option");
  expect(baggage.fieldType).toBe("");
  expect(["date_of_birth", "title", "gender"]).not.toContain(baggage.semantic);

  const conflicting = map.controls.filter((control) => control.name === "title");
  expect(conflicting).toHaveLength(2);
  for (const control of conflicting) {
    expect(control.fieldType).toBe("");
    expect(control.fieldClassification).toMatchObject({
      source: "semantic_conflict",
      ambiguity: {
        code: "AMBIGUOUS_FIELD_SEMANTICS",
        candidates: expect.arrayContaining(["title", "gender"])
      }
    });
  }
});

test("delegated React passenger controls ignore optional fields and keep one required obligation current", async ({ page }) => {
  await loadHtmlProducer(page, `
    <style>
      [hidden] { display: none !important; }
      body { font-family: sans-serif; padding: 24px; }
      form { display: grid; gap: 12px; width: 520px; }
      .custom-control {
        position: relative;
        width: 250px;
        height: 40px;
        border: 1px solid #777;
        border-radius: 4px;
        background: white;
      }
      .custom-control select {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        opacity: 0.01;
        pointer-events: auto;
        z-index: 2;
      }
      .custom-control.visual-only { pointer-events: none; }
      .custom-control.visual-only select { pointer-events: auto; }
      .custom-value { display: block; padding: 10px 12px; }
      .dob-row { display: flex; gap: 12px; }
      .dob-row > * { width: 150px; }
      .dob-row .custom-control { width: 150px; }
      #react-options {
        position: fixed;
        left: 300px;
        top: 120px;
        width: 230px;
        padding: 8px;
        background: white;
        border: 1px solid #222;
        z-index: 30;
      }
      #react-options button { display: block; width: 100%; min-height: 36px; }
    </style>
    <main>
      <h1 id="passenger-stage">Passenger details</h1>
      <form id="passenger-form">
        <label>First name <input name="passengers.0.firstName" required></label>
        <label>Surname <input name="passengers.0.lastName" required></label>
        <label>Middle name
          <div class="custom-control" data-react-control="middle_name">
            <select name="passengers.0.middleName" disabled>
              <option value="">Middle name</option>
            </select>
            <span class="custom-value">Middle name</span>
          </div>
        </label>
        <label>Title
          <div class="custom-control" data-react-control="title">
            <select name="passengers.0.title" disabled required>
              <option value="">Title</option><option value="Mr">Mr</option><option value="Mrs/Ms">Mrs/Ms</option>
            </select>
            <span class="custom-value">Title</span>
          </div>
        </label>
        <label>Nationality
          <div class="custom-control" data-react-control="nationality">
            <select name="passengers.0.nationality" disabled required>
              <option value="">Nationality</option><option value="TR">Türkiye</option>
            </select>
            <span class="custom-value">Nationality</span>
          </div>
        </label>
        <fieldset id="dob-owner">
          <legend>Date of birth</legend>
          <label>Select passenger category
            <select name="passengers.0.passengerCategory">
              <option value="adult" selected>Adult</option>
            </select>
          </label>
          <div class="dob-row">
            <label>Day
              <input name="passengers.0.birthDay" autocomplete="bday-day" required>
            </label>
            <label>Month
              <div class="custom-control visual-only" data-react-control="birth_month">
                <select name="passengers.0.birthMonth" autocomplete="bday-month" disabled required>
                  <option value="">Month</option><option value="05">May</option>
                </select>
                <span class="custom-value">Month</span>
              </div>
            </label>
            <label>Year
              <input name="passengers.0.birthYear" autocomplete="bday-year" required>
            </label>
          </div>
        </fieldset>
        <button id="passenger-continue" type="button">Continue</button>
      </form>
      <section id="next-stage" hidden>
        <h2>Baggage</h2>
      </section>
    </main>
    <div id="react-options" role="listbox" aria-label="Passenger field options" hidden></div>
    <script>
      (() => {
        const portal = document.getElementById("react-options");
        let activeControl = "";
        const options = {
          title: [{ value: "Mr", label: "Mr" }, { value: "Mrs/Ms", label: "Mrs/Ms" }],
          nationality: [{ value: "TR", label: "Türkiye" }],
          birth_month: [{ value: "05", label: "May" }]
        };
        document.addEventListener("click", (event) => {
          const wrapper = event.target.closest(".custom-control");
          if (wrapper) {
            const control = wrapper.dataset.reactControl;
            // This intentionally inert field proves a verified open failure is
            // local and does not stop the rest of the passenger form.
            if (control === "middle_name") return;
            activeControl = control;
            portal.replaceChildren(...(options[control] || []).map((item) => {
              const button = document.createElement("button");
              button.type = "button";
              button.setAttribute("role", "option");
              button.dataset.value = item.value;
              button.textContent = item.label;
              return button;
            }));
            portal.hidden = false;
            wrapper.querySelector("select")?.setAttribute("aria-expanded", "true");
            return;
          }
          const option = event.target.closest("#react-options [role='option']");
          if (!option || !activeControl) return;
          const owner = document.querySelector('[data-react-control="' + activeControl + '"]');
          const select = owner?.querySelector("select");
          if (!select) return;
          select.value = option.dataset.value;
          select.setAttribute("aria-expanded", "false");
          select.dispatchEvent(new Event("change", { bubbles: true }));
          owner.querySelector(".custom-value").textContent = option.textContent;
          portal.hidden = true;
          if (activeControl === "title") {
            document.querySelector('[data-react-control="middle_name"]')?.closest("label")?.remove();
          }
          activeControl = "";
        });
        document.getElementById("passenger-continue").addEventListener("click", () => {
          const values = Object.fromEntries([...document.querySelectorAll("input, select")]
            .map((control) => [control.name, control.value]));
          const complete = values["passengers.0.firstName"] === "Ali"
            && values["passengers.0.lastName"] === "Sifrar"
            && values["passengers.0.title"] === "Mr"
            && values["passengers.0.nationality"] === "TR"
            && values["passengers.0.birthDay"] === "31"
            && values["passengers.0.birthMonth"] === "05"
            && values["passengers.0.birthYear"] === "2003";
          if (!complete) return;
          document.getElementById("passenger-form").hidden = true;
          document.getElementById("next-stage").hidden = false;
          document.getElementById("passenger-stage").textContent = "Baggage";
          document.body.dataset.stage = "baggage";
        });
      })();
    </script>
  `);

  const profile = {
    id: "traveler_1",
    first_name: "Ali",
    middle_name: "X",
    last_name: "Sifrar",
    gender: "male",
    nationality: "TR",
    date_of_birth: "2003-05-31"
  };
  await page.evaluate((traveler) => {
    window.__ATW_TEST__.setAppDataForTest({ travelers: [traveler] }, traveler.id);
    window.__ATW_TEST_TRUSTED_CHOICE__ = ({ element, choiceLabel }) => {
      const select = element.querySelector("select");
      const option = [...(select?.options || [])].find((item) => (
        item.value.toLowerCase() === choiceLabel.toLowerCase()
        || item.textContent.trim().toLowerCase() === choiceLabel.toLowerCase()
      ));
      if (!select || !option) return { ok: false, code: "OPTION_NOT_FOUND" };
      select.value = option.value;
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
      element.querySelector(".custom-value").textContent = option.textContent;
      if (element.dataset.reactControl === "title") {
        document.querySelector('[data-react-control="middle_name"]')?.closest("label")?.remove();
      }
      return { ok: true };
    };
  }, profile);

  let observation = await browserObservation(page, "obs_react_passenger_initial");
  const categoryControl = observation.page.controls.find((control) => (
    control.name === "passengers.0.passengerCategory"
  ));
  expect(categoryControl).toBeTruthy();
  expect(categoryControl.fieldType).not.toBe("date_of_birth");
  expect(resolveLogicalFields(observation.page, profile).some((field) => (
    field.semanticType === "date_of_birth"
    && field.components.some((component) => component.control?.controlId === categoryControl.controlId)
  ))).toBe(false);
  const disabledSelectHitEvidence = await page.locator(".custom-control select:disabled").evaluateAll((selects) => (
    selects.map((select) => {
      const box = select.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return {
        stateIsHit: hit === select,
        wrapperDistinct: select.parentElement !== select
      };
    })
  ));
  expect(disabledSelectHitEvidence.every((item) => item.stateIsHit && item.wrapperDistinct)).toBe(true);
  let currentGoal = null;
  const successfulSteps = [];

  for (let index = 0; index < 14; index += 1) {
    if (profileStageReadiness(observation, profile).ready) break;
    const selection = selectNextProfileRequirement(observation, profile, currentGoal);
    expect(selection.goal, JSON.stringify(selection, null, 2)).toBeTruthy();
    if (observation.page.currentSurface?.type && observation.page.currentSurface.type !== "page") {
      expect(selection.goal.semanticType, JSON.stringify({
        currentGoal,
        selection,
        currentSurface: observation.page.currentSurface,
        controls: observation.page.controls.map((control) => ({
          label: control.label,
          role: control.role,
          surfaceId: control.surfaceId,
          operations: control.operations
        }))
      }, null, 2)).toBe(currentGoal.semanticType);
    }
    const candidate = candidatesForProfileGoal(selection.goal, observation, profile)[0];
    expect(candidate, JSON.stringify(selection.goal, null, 2)).toBeTruthy();
    const control = observation.page.controls.find((item) => item.controlId === candidate.controlId);
    if (candidate.operation === "open" && control?.state?.disabled === true) {
      if (candidate.type === "click_xy") {
        expect(candidate.targetId).toBe("");
        expect(candidate.visualRegion).toBeTruthy();
        expect(control.operations.open).toBeFalsy();
        expect(control.recovery.open.regions).toHaveLength(1);
      } else {
        expect(candidate.targetId).not.toBe(control.stateElementId);
        expect(control.operations.open).toBeFalsy();
        expect(control.recovery.open.status).toBe("unproven");
        expect(control.recovery.open.strategies.some((strategy) => (
          strategy.actuatorId === candidate.targetId
          && strategy.method === candidate.interactionMethod
          && strategy.status === "unproven_experiment"
        ))).toBe(true);
      }
    }
    const action = actionForProfileCandidate(selection.goal, candidate, observation);
    const boundAction = candidate.type === "click_xy"
      ? loopPrivate.bindTargetSnapshot(action, observation)
      : action;
    const executed = await executeAtomicBrowserDecision(
      page,
      toClientDecision(boundAction),
      `obs_react_passenger_${index + 1}`
    );
    expect(executed.result.dispatched, JSON.stringify({
      index,
      goal: selection.goal,
      candidate,
      validation: executed.validation,
      verification: executed.verification
    }, null, 2)).toBe(true);

    expect(executed.result.verified, JSON.stringify({
        index,
        goal: selection.goal,
        candidate,
        verification: executed.verification,
        afterLogicalFields: resolveLogicalFields(executed.observation.page, profile)
          .filter((field) => field.semanticType === selection.goal.semanticType)
          .map((field) => ({
            logicalFieldId: field.logicalFieldId,
            currentCanonicalValue: field.currentCanonicalValue,
            components: field.components.map((component) => ({
              role: component.role,
              controlId: component.control?.controlId,
              value: component.control?.state?.normalizedValue
            }))
          }))
      }, null, 2)).toBe(true);
    successfulSteps.push(`${selection.goal.semanticType}.${selection.goal.componentRole}.${candidate.operation}`);
    currentGoal = selection.goal;
    observation = executed.observation;
  }

  expect(successfulSteps).toEqual([
    "first_name.value.type",
    "last_name.value.type",
    "title.value.select",
    "nationality.value.select",
    "date_of_birth.day.type",
    "date_of_birth.month.open",
    "date_of_birth.month.choose",
    "date_of_birth.year.type"
  ]);
  expect(profileStageReadiness(observation, profile).ready).toBe(true);
  expect(await page.locator("[onclick], [tabindex]").count()).toBe(0);

  const taskState = reduceTaskState({ observation, traveler: profile });
  expect(taskState.currentGoal.semanticType).toBe("navigation");
  expect(await page.locator("#passenger-form input, #passenger-form select").evaluateAll((controls) => (
    Object.fromEntries(controls.map((control) => [control.name, control.value]))
  ))).toEqual({
    "passengers.0.firstName": "Ali",
    "passengers.0.lastName": "Sifrar",
    "passengers.0.title": "Mr",
    "passengers.0.nationality": "TR",
    "passengers.0.passengerCategory": "adult",
    "passengers.0.birthDay": "31",
    "passengers.0.birthMonth": "05",
    "passengers.0.birthYear": "2003"
  });
  const candidateSet = buildCurrentCandidateSet({
    goal: taskState.currentGoal,
    observation,
    traveler: profile,
    state: { taskState, approvals: {} }
  });
  const continueCandidate = candidateSet.candidates.find((candidate) => (
    observation.page.controls.find((control) => control.controlId === candidate.controlId)?.label === "Continue"
  ));
  expect(continueCandidate).toBeTruthy();
  const continued = await executeAtomicBrowserDecision(
    page,
    toClientDecision(actionForCurrentCandidate(taskState.currentGoal, continueCandidate, observation)),
    "obs_react_passenger_next_stage"
  );
  expect(continued.result.dispatched).toBe(true);
  expect(await page.locator("#next-stage").isVisible()).toBe(true);
  expect(await page.evaluate(() => document.body.dataset.stage)).toBe("baggage");
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

test("a persistent untagged checkout route anchors transaction identity before final review", async ({ page }) => {
  await loadHtmlProducer(page, `
    <main>
      <div class="generated-title">Antalya → Istanbul <time>Tue 9 Feb</time></div>
      <span>Antalya → Istanbul</span>
      <nav>Passengers, baggage, insurance · Ticket fare · Seating</nav>
      <section>
        <h2>Passenger information</h2>
        <div>Primary passenger Adult (over 12 years) Child (2 → 12 years) Infant (under 2 years)</div>
        <div>Get your money back and take your trip later — without having to spend extra</div>
        <label>First name <input name="passengers.0.firstName"></label>
      </section>
      <aside><span>1x Basic Saver fare</span><strong>Total (TRY)</strong><span>1,637.80 TL</span></aside>
      <button type="button">Continue</button>
    </main>
  `);

  const observed = await page.evaluate(() => window.__ATW_TEST__.compactPageMap(window.__ATW_TEST__.buildPageMap()));

  expect(observed.step).not.toBe("payment");
  expect(observed.transactionFacts.itinerary.segments).toEqual([
    expect.objectContaining({ origin: "ANTALYA", destination: "ISTANBUL", departureDate: "Tue 9 Feb" })
  ]);
  expect(observed.transactionFacts.itinerary.segments[0].evidence).toMatchObject({
    source: "bounded_checkout_route",
    qualification: "owned_travel_date",
    authoritative: true
  });
  expect(observed.transactionFacts.factEvidence.itinerary[0]).toMatchObject({
    source: "bounded_checkout_route",
    authoritative: true
  });
});

test("payment review compiles a tightly owned city route and canonical booking outcomes", async ({ page }) => {
  await loadHtmlProducer(page, `
    <main>
      <h1>Overview &amp; payment</h1>
      <section aria-label="Flight itinerary">
        <div>Antalya → Istanbul</div>
        <div>Tue 9 Feb</div>
        <button type="button">View full itinerary</button>
      </section>
      <section>
        <h2>Passenger information and extras</h2>
        <h3>Personal details</h3><p>Ali SIFRAR · male · 31/05/2003</p>
        <h3>Baggage</h3><p>1x Cabin baggage</p><p>1x Checked baggage 15 kg</p>
        <h3>Travel insurance</h3><p>No travel insurance</p>
        <h3>Ticket type</h3><p>1x Basic Saver</p>
        <h3>Seating</h3><p>1x Random seat (Antalya - Istanbul)</p>
      </section>
      <p>Even if you don't have a data plan or WiFi, enter a valid phone number to receive SMS.</p>
      <aside><strong>Total (TRY)</strong><span>1,637.80 TL</span></aside>
      <label>Email <input type="email" value="ali@testaztela.com"></label>
      <label>Card number <input inputmode="numeric"></label>
      <button type="button">Continue to payment</button>
    </main>
  `);
  await page.evaluate(() => window.__ATW_TEST__.setAppDataForTest({
    travelers: [{ id: "trav_ali_review", first_name: "Ali", last_name: "SIFRAR" }],
    preferences: {}
  }, "trav_ali_review"));

  const observed = await page.evaluate(() => {
    const map = window.__ATW_TEST__.buildPageMap();
    return window.__ATW_TEST__.compactPageMap(map);
  });

  expect(observed.step).toBe("payment");
  expect(observed.transactionFacts.provenance[0].source).toBe("payment_summary");
  expect(observed.transactionFacts.itinerary.segments[0]).toMatchObject({
    origin: "ANTALYA",
    destination: "ISTANBUL",
    departureDate: "Tue 9 Feb"
  });
  expect(observed.transactionFacts.fareBrand).toBe("Basic Saver");
  expect(observed.transactionFacts.selectedExtras).toEqual(expect.arrayContaining([
    expect.objectContaining({ outcomeKey: "fare:ticket", outcome: "selected", label: "Basic Saver" }),
    expect.objectContaining({ outcomeKey: "insurance:trip_insurance", outcome: "not_included" }),
    expect.objectContaining({ outcomeKey: "seat:seat_assignment", outcome: "random_assignment" }),
    expect.objectContaining({ outcomeKey: "baggage:cabin_baggage", outcome: "included", disposition: "included" }),
    expect.objectContaining({ outcomeKey: "baggage:checked_baggage", outcome: "included", disposition: "included" })
  ]));
});

test("owned itinerary context accepts city endpoints but rejects a generic Direct flight heading", async ({ page }) => {
  await loadHtmlProducer(page, `
    <main>
      <h1>Overview &amp; payment</h1>
      <section aria-label="Flight itinerary">
        <h2>Antalya Istanbul</h2>
        <div>Tue 9 Feb</div>
        <button type="button">View full itinerary</button>
        <h3>Direct flight</h3>
      </section>
      <p>NON-REFUNDABLE. CHANGEABLE SUBJECT → FEES.</p>
      <aside><strong>Total (TRY)</strong><span>1,637.80 TL</span></aside>
      <label>Card number <input inputmode="numeric"></label>
      <button type="button">Pay 1,637.80 TL</button>
    </main>
  `);
  const observed = await page.evaluate(() => window.__ATW_TEST__.compactPageMap(window.__ATW_TEST__.buildPageMap()));

  expect(observed.transactionFacts.itinerary.segments).toEqual([
    expect.objectContaining({ origin: "ANTALYA", destination: "ISTANBUL", departureDate: "Tue 9 Feb" })
  ]);
  expect(observed.transactionFacts.itinerary.segments).not.toEqual(expect.arrayContaining([
    expect.objectContaining({ origin: "DIRECT", destination: "FLIGHT" })
  ]));
  expect(observed.transactionFacts.itinerary.segments).not.toEqual(expect.arrayContaining([
    expect.objectContaining({ origin: "NON-REFUNDABLE. CHANGEABLE SUBJECT", destination: "FEES." })
  ]));
});

test("real review-card structure compiles owned route and fare without marketing contamination", async ({ page }) => {
  await loadHtmlProducer(page, `
    <main>
      <h1>Overview &amp; payment</h1>
      <div class="review-card">
        <div>Antalya → Istanbul</div>
        <div>Tue 9 Feb</div>
        <button type="button">View full itinerary</button>
      </div>
      <section>
        <p>Get the option to change or cancel your trip. Upgrade your ticket when plans change.</p>
        <h3>Ticket type</h3>
        <div>1x Basic Saver</div>
        <button type="button">Edit</button>
      </section>
      <aside><strong>Total (TRY)</strong><span>1,637.80 TL</span></aside>
      <fieldset><legend>Payment method</legend><label><input type="radio" name="payment-method"> New card</label></fieldset>
      <button type="button">Pay 1,637.80 TL</button>
    </main>
  `);

  const observed = await page.evaluate(() => window.__ATW_TEST__.compactPageMap(window.__ATW_TEST__.buildPageMap()));

  expect(observed.transactionFacts.itinerary.segments).toEqual([
    expect.objectContaining({ origin: "ANTALYA", destination: "ISTANBUL", departureDate: "Tue 9 Feb" })
  ]);
  expect(observed.transactionFacts.itinerary.segments[0].evidence).toMatchObject({
    source: "itinerary_control_owner",
    authoritative: true
  });
  expect(observed.transactionFacts.fareBrand).toBe("Basic Saver");
  expect(observed.transactionFacts.factEvidence.fareBrand).toMatchObject({
    source: "review_summary_row",
    authoritative: true
  });
  expect(observed.transactionFacts.fareBrand).not.toMatch(/cancel|upgrade/i);
});

test("owned compact fare summary establishes fare identity without borrowing selected button copy", async ({ page }) => {
  await loadHtmlProducer(page, `
    <main>
      <h1>Customize your trip</h1>
      <button type="button">Continue with Saver</button>
      <aside><p class="fare-summary">1x Basic Saver fare</p></aside>
      <button type="button">Continue</button>
    </main>
  `);

  const observed = await page.evaluate(() => window.__ATW_TEST__.compactPageMap(window.__ATW_TEST__.buildPageMap()));

  expect(observed.transactionFacts.fareBrand).toBe("Basic Saver");
  expect(observed.transactionFacts.factEvidence.fareBrand).toMatchObject({
    source: "owned_fare_summary_line",
    authoritative: true
  });
});

test("payment boundary finishes contact prerequisites then publishes no payment or billing action", async ({ page }) => {
  await loadHtmlProducer(page, `
    <main>
      <h1>Overview &amp; payment</h1>
      <section aria-label="Flight itinerary">
        <div>Antalya → Istanbul</div><div>Tue 9 Feb</div>
      </section>
      <section aria-label="Contact details">
        <label>Email <input id="review-email" name="email" type="email" autocomplete="email" required></label>
        <label>Phone <input id="review-phone" name="phone" type="tel" autocomplete="tel-national" required></label>
      </section>
      <aside><strong>Total (TRY)</strong><span>1,637.80 TL</span></aside>
      <fieldset><legend>Payment method</legend><label><input type="radio" name="payment-method"> New credit or debit card</label></fieldset>
      <label>Billing address <input name="billing.address"></label>
      <button id="review-pay" type="button">Pay 1,637.80 TL</button>
    </main>
  `);
  const traveler = {
    id: "trav_payment_boundary",
    first_name: "Ali",
    last_name: "SIFRAR",
    email: "ali@testaztela.com",
    phone: "+38670328922"
  };
  await page.evaluate((profile) => window.__ATW_TEST__.setAppDataForTest({ travelers: [profile], preferences: {} }, profile.id), traveler);

  const before = await browserObservation(page, "obs_payment_boundary_contact_empty");
  const beforeTask = reduceTaskState({
    observation: before,
    traveler,
    transactionReview: verifiedTransactionReview(1637.8)
  });
  const beforeCandidates = buildCurrentCandidateSet({
    goal: beforeTask.currentGoal,
    observation: before,
    traveler,
    state: { taskState: beforeTask, approvals: {} }
  });
  expect(beforeTask.paymentEvidence.boundaryObserved, JSON.stringify({
    evidence: beforeTask.paymentEvidence,
    controls: before.page.controls.map((control) => ({
      controlId: control.controlId,
      label: control.label,
      semantic: control.semantic,
      fieldType: control.fieldType,
      stableKey: control.stableKey,
      operations: Object.keys(control.operations || {})
    }))
  }, null, 2)).toBe(true);
  expect(beforeTask.terminalStatus).toBe("active");
  expect(beforeTask.currentGoal?.semanticType).toMatch(/email|phone/);
  expect(beforeCandidates.candidates.every((candidate) => !/pay|payment|billing/i.test(`${candidate.targetLabel || ""} ${candidate.semanticIntent || ""}`))).toBe(true);

  await page.evaluate(({ email, phone }) => {
    const set = (id, value) => {
      const input = document.getElementById(id);
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    };
    set("review-email", email);
    set("review-phone", phone);
  }, { email: traveler.email, phone: "70328922" });

  const after = await browserObservation(page, "obs_payment_boundary_contact_complete");
  const afterTask = reduceTaskState({
    previousTaskState: beforeTask,
    observation: after,
    traveler,
    transactionReview: verifiedTransactionReview(1637.8)
  });
  expect(afterTask.paymentEvidence.boundaryObserved).toBe(true);
  expect(afterTask.terminalGoalLatch.locked).toBe(true);
  expect(afterTask.terminalStatus).toBe("payment_review_reached");
  expect(afterTask.currentGoal).toBeNull();
});

test("GoToGate-shaped payment review is terminal evidence without payment capabilities", async ({ page }) => {
  await loadHtmlProducer(page, `
    <nav aria-label="Checkout progress"><span>Traveller information</span><span aria-current="step">Payment</span></nav>
    <main>
      <h1>Payment</h1>
      <p>Booking confirmation and updates will be sent to ali@aztela.com.</p>
      <section><h2>Debitcard / Creditcard</h2>
        <label>Card number <input name="card.number" autocomplete="cc-number"></label>
        <label>Expiry <input name="card.expiry" autocomplete="cc-exp"></label>
        <label>CVV <input name="card.cvv" autocomplete="cc-csc"></label>
        <label>Cardholder <input name="card.holder" autocomplete="cc-name"></label>
        <label><input type="checkbox"> I accept the terms and conditions</label>
        <button type="button">Pay 448 EUR</button>
      </section>
      <aside aria-label="Travel details">
        <h2>Travel details</h2>
        <h3>Departure</h3><p>Mon 3 Aug 2026</p><p>AYT Antalya - SAW Istanbul</p>
        <h3>Return</h3><p>Sun 9 Aug 2026</p><p>SAW Istanbul - AYT Antalya</p>
        <button type="button">Travel details</button>
        <h3>Bags</h3><p>Hand baggage included</p><p>Checked baggage included</p>
        <strong>Total amount 448 EUR</strong>
      </aside>
    </main>
  `);
  const observation = await browserObservation(page, "obs_gotogate_payment_terminal");
  expect(observation.page.step).toBe("payment");
  expect(observation.page.terminalEvidence).toMatchObject({
    contractVersion: "terminal-evidence/v1",
    boundaryObserved: true,
    evidenceOnly: true,
    capabilities: { paymentActionsAllowed: false }
  });
  expect(observation.page.transactionFacts.provenance).toEqual(expect.arrayContaining([
    expect.objectContaining({ source: "payment_summary" })
  ]));
  expect(observation.page.controls.every((control) => !/card|cvv|pay/i.test(`${control.label || ""} ${control.fieldType || ""} ${control.semantic || ""}`))).toBe(true);
  expect(observation.page.transactionFacts.itinerary.segments).toEqual(expect.arrayContaining([
    expect.objectContaining({ origin: "AYT", destination: "SAW" }),
    expect.objectContaining({ origin: "SAW", destination: "AYT" })
  ]));

  const readiness = classifyObservationReadiness({
    observation,
    navigationContext: { lifecycle: { awaitingDestination: true, status: "waiting_for_destination" } }
  });
  expect(readiness.classification).toBe(READINESS.READY);
  expect(readiness.evidence.strongPaymentEvidence).toBeUndefined();

  const task = reduceTaskState({
    observation,
    traveler: { id: "trav_terminal", first_name: "Ali", last_name: "SIFRAR" },
    transactionReview: verifiedTransactionReview(448)
  });
  expect(task.terminalStatus).toBe("payment_review_reached");
  expect(task.currentGoal).toBeNull();
  expect(task.paymentEvidence.paymentActionsAllowed).toBe(false);
});

test("progressive payment entry compiles FROM/TO itinerary and outranks a generic Select flight breadcrumb", async ({ page }) => {
  await loadHtmlProducer(page, `
    <header><button type="button">Select flight</button></header>
    <main>
      <p>Economy - EcoFly FROM Sarajevo (SJJ) 15 Oct Thu 20:45 1h 55m TO Istanbul (IST) 15 Oct Thu 23:40</p>
      <p>Economy - EcoFly FROM Istanbul (IST) 19 Nov Thu 20:10 1h 55m TO Sarajevo (SJJ) 19 Nov Thu 20:05</p>
      <button type="button">Show details</button>
      <h1>Which currency would you like to use for your payment?</h1>
      <p>Payment methods may vary depending on the currency you choose.</p>
      <strong>EUR 317,54</strong>
      <section hidden><label>Card number <input autocomplete="cc-number"></label></section>
    </main>
  `);
  await page.evaluate(() => { location.hash = "payments"; });

  const observation = await browserObservation(page, "obs_progressive_payment_entry");
  expect(observation.page.step).toBe("payment");
  expect(observation.page.terminalEvidence).toMatchObject({
    boundaryObserved: true,
    signals: { route: true, entry: true },
    capabilities: { paymentActionsAllowed: false }
  });
  expect(observation.page.terminalEvidence.evidenceSources).toContain("visible_progressive_payment_entry");
  expect(observation.page.transactionFacts.itinerary).toMatchObject({ completeness: "complete" });
  expect(observation.page.transactionFacts.itinerary.segments).toEqual([
    expect.objectContaining({ origin: "SJJ", destination: "IST", departureDate: "15 Oct Thu", departureTime: "20:45", arrivalTime: "23:40" }),
    expect.objectContaining({ origin: "IST", destination: "SJJ", departureDate: "19 Nov Thu", departureTime: "20:10", arrivalTime: "20:05" })
  ]);
  expect(observation.page.transactionFacts.totalPrice).toEqual(expect.objectContaining({ amount: 317.54, currency: "EUR" }));
  expect(observation.page.controls.every((control) => !/card number|pay now/i.test(control.label || ""))).toBe(true);

  const readiness = classifyObservationReadiness({
    observation,
    navigationContext: { lifecycle: { awaitingDestination: true, status: "waiting_for_destination" } }
  });
  expect(readiness.classification).toBe(READINESS.READY);
  expect(readiness.evidence.strongPaymentEvidence).toBeUndefined();
});

test("persistent selected-booking total stays authoritative while an insurance offer stays option-local", async ({ page }) => {
  await loadHtmlProducer(page, `
    <main>
      <h1>Passenger information</h1>
      <label>First name <input name="firstName"></label>
      <label>Surname <input name="lastName"></label>
    </main>
    <aside class="booking-summary">
      <div>Departure SJJ - IST • 15 Oct Thu Departure: 20:45 | Arrival: 23:40</div>
      <div>Return IST - SJJ • 19 Nov Thu Departure: 20:10 | Arrival: 20:05</div>
      <strong>Total price for 1 passenger EUR euros 317 .54</strong>
      <button type="button">Details</button>
    </aside>
  `);
  await page.evaluate(() => window.__ATW_TEST__.setAppDataForTest({
    travelers: [{ id: "trav_selected_booking", first_name: "Ali", last_name: "SIFRAR" }],
    preferences: {}
  }, "trav_selected_booking"));

  const selected = await page.evaluate(() => window.__ATW_TEST__.compactPageMap(window.__ATW_TEST__.buildPageMap()));
  expect(selected.transactionFacts.contractVersion).toBe("transaction-facts/v2");
  expect(selected.transactionFacts.itinerary).toMatchObject({ completeness: "complete" });
  expect(selected.transactionFacts.itinerary.segments).toEqual([
    expect.objectContaining({ origin: "SJJ", destination: "IST", departureDate: "15 Oct Thu", departureTime: "20:45", arrivalTime: "23:40" }),
    expect.objectContaining({ origin: "IST", destination: "SJJ", departureDate: "19 Nov Thu", departureTime: "20:10", arrivalTime: "20:05" })
  ]);
  expect(selected.transactionFacts.totalPrice).toEqual({ amount: 317.54, currency: "EUR" });
  expect(selected.transactionFacts.factEvidence.totalPrice).toMatchObject({
    role: "booking_total",
    ownerType: "selected_booking_summary",
    authoritative: true
  });

  await loadHtmlProducer(page, `
    <main>
      <h1>Travel insurance</h1>
      <section>
        <h2>Protect your trip with XCover</h2>
        <p>Add travel insurance for only EUR 66.25.</p>
        <button type="button">Add travel insurance</button>
        <button type="button">No thanks, continue without travel insurance</button>
      </section>
    </main>
  `);
  const insurance = await page.evaluate(() => window.__ATW_TEST__.compactPageMap(window.__ATW_TEST__.buildPageMap()));
  expect(insurance.price).toEqual({ amount: 66.25, currency: "EUR" });
  expect(insurance.transactionFacts.totalPrice.amount).toBeNull();
  expect(insurance.transactionFacts.factEvidence.totalPrice).toBeNull();
});

test("testing sidebar shows process position, objective, achievements, and selected-booking evidence", async ({ page }) => {
  await loadHtmlProducer(page, `
    <main><h1>Additional services</h1><button type="button">Continue</button></main>
  `);
  await page.evaluate(() => {
    window.__ATW_TEST__.setAppDataForTest({
      travelers: [{ id: "trav_sidebar", first_name: "Ali", last_name: "SIFRAR", nationality: "Slovenia" }],
      preferences: {}
    }, "trav_sidebar");
    window.__ATW_TEST__.setProcessDiagnosticsForTest({
      processAwareness: {
        status: "in_progress",
        currentPosition: { stage: "extras" },
        currentObjective: "decline optional insurance",
        achievements: [{ achievementId: "profile", label: "Traveler details verified" }],
        unresolved: ["decision:insurance"]
      },
      transactionReview: {
        baselineStatus: "approved",
        ready: false,
        missingFacts: ["payment_review"],
        contradictions: [],
        baseline: {
          itinerary: { segments: [
            { origin: "SJJ", destination: "IST", departureDate: "2026-10-15" },
            { origin: "IST", destination: "SJJ", departureDate: "2026-11-19" }
          ] },
          currency: "EUR",
          totalPrice: { amount: 317.54, currency: "EUR" }
        },
        current: { totalPrice: { amount: 317.54, currency: "EUR" } }
      }
    });
    window.__ATW_TEST__.renderSidebarForTest();
  });

  const diagnostics = page.locator(".atw-process-diagnostics");
  await expect(page.locator(".atw-agent-card")).toContainText("Selected booking: captured");
  await expect(page.locator(".atw-agent-card")).toContainText("2026-10-15 · 2026-11-19");
  await expect(diagnostics).toContainText("extras");
  await expect(diagnostics).toContainText("decline optional insurance");
  await expect(diagnostics).toContainText("Traveler details verified");
  await expect(diagnostics).toContainText("SJJ → IST · IST → SJJ");
  await expect(diagnostics).toContainText("317.54 EUR");
  await expect(diagnostics).toContainText("payment_review");
});

test("hosted payment widget with opaque native inputs contributes owned terminal evidence", async ({ page }) => {
  await loadHtmlProducer(page, `
    <nav aria-label="Checkout progress"><span>Traveller information</span><span aria-current="step">Payment</span></nav>
    <main>
      <h1>Payment</h1>
      <section data-testid="hosted-payment-card-form">
        <h2>Debitcard / Creditcard</h2>
        <div>Card number *</div>
        <div>Expiry date *</div>
        <div>CVV code *</div>
        <div>Cardholder’s full name *</div>
        <iframe title="Secure card payment fields"></iframe>
      </section>
      <aside aria-label="Your order">
        <h2>Your Order</h2>
        <p>Departure Mon 3 Aug 2026</p><p>AYT Antalya - SAW Istanbul</p>
        <p>Return Sun 9 Aug 2026</p><p>SAW Istanbul - AYT Antalya</p>
        <strong>Amount to pay 107 EUR</strong>
      </aside>
    </main>
  `);

  const observation = await browserObservation(page, "obs_hosted_payment_terminal");
  expect(observation.page.step).toBe("payment");
  expect(observation.page.terminalEvidence).toMatchObject({
    contractVersion: "terminal-evidence/v1",
    boundaryObserved: true,
    evidenceOnly: true,
    signals: { progress: true, form: true },
    signalStates: { form: "present" },
    capabilities: { paymentActionsAllowed: false }
  });
  expect(observation.page.terminalEvidence.paymentCredentialKinds).toEqual(expect.arrayContaining([
    "card_number",
    "card_expiry",
    "card_security_code",
    "cardholder"
  ]));
  expect(observation.page.terminalEvidence.evidenceSources).toEqual(expect.arrayContaining([
    "visible_owned_payment_labels",
    "visible_hosted_payment_widget",
    "active_payment_progress"
  ]));
  expect(observation.page.controls.every((control) => !/card number|expiry|cvv|cardholder|pay now/i.test(
    `${control.label || ""} ${control.fieldType || ""} ${control.semantic || ""}`
  ))).toBe(true);

  const readiness = classifyObservationReadiness({
    observation,
    navigationContext: { lifecycle: { awaitingDestination: true, status: "waiting_for_destination" } }
  });
  expect(readiness.classification).toBe(READINESS.READY);
  expect(readiness.evidence.strongPaymentEvidence).toBeUndefined();
});

test("hidden future hosted payment markup does not become terminal evidence", async ({ page }) => {
  await loadHtmlProducer(page, `
    <style>[hidden] { display: none !important; }</style>
    <main>
      <h1>Traveller information</h1>
      <label>First name <input name="firstName"></label>
      <button type="button">Continue</button>
      <section data-testid="hosted-payment-card-form" hidden>
        <h2>Payment</h2>
        <div>Card number *</div><div>Expiry date *</div><div>CVV code *</div>
        <iframe title="Secure card payment fields"></iframe>
      </section>
    </main>
  `);

  const observation = await browserObservation(page, "obs_hidden_hosted_payment_future");
  expect(observation.page.step).toBe("traveler_information");
  expect(observation.page.terminalEvidence).toMatchObject({
    boundaryObserved: false,
    signals: { form: false },
    signalStates: { form: "unknown" },
    capabilities: { paymentActionsAllowed: false }
  });
  expect(observation.page.terminalEvidence.evidenceSources).not.toContain("visible_hosted_payment_widget");
});

test("payment review does not compile contact help into an itinerary", async ({ page }) => {
  await loadHtmlProducer(page, `
    <main>
      <h1>Overview &amp; payment</h1>
      <p>Even if you don't have a data plan or WiFi, enter a valid phone number to receive SMS.</p>
      <label>Email <input type="email" value="ali@testaztela.com"></label>
      <label>Card number <input inputmode="numeric"></label>
      <button type="button">Continue to payment</button>
    </main>
  `);
  const observed = await page.evaluate(() => {
    const map = window.__ATW_TEST__.buildPageMap();
    return window.__ATW_TEST__.compactPageMap(map);
  });

  expect(observed.step).toBe("payment");
  expect(observed.transactionFacts.itinerary.segments).toEqual([]);
  expect(observed.transactionFacts.itinerary.completeness).toBe("unknown");
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
  expect(candidate, JSON.stringify(candidateSet.contextCapabilities.map((item) => ({
    label: item.targetLabel,
    operation: item.operation,
    controlId: item.controlId,
    physicalEffect: item.physicalEffect,
    goalRelevant: item.goalRelevant,
    selectable: item.selectable,
    exclusionReason: item.exclusionReason,
    risk: item.risk,
    policy: item.policyDecision
  })), null, 2)).toBeTruthy();
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

test("commercial CTA cards bind option price and policy selects the included fare", async ({ page }) => {
  await loadHtmlProducer(page, `
    <style>
      #fare-options { display: grid; grid-template-columns: repeat(3, 260px); gap: 16px; }
      article { min-height: 180px; padding: 16px; border: 1px solid #bbb; }
      button, [role="button"] { min-height: 40px; }
    </style>
    <main>
      <h1>Choose your fare</h1>
      <section aria-label="Fare packages">
        <div id="fare-options">
          <article data-fare="saver">
            <h2>Basic Saver</h2>
            <strong>Included</strong>
            <p>One personal item</p>
            <p>Refund available for a 30 € fee</p>
            <div
              role="button"
              tabindex="0"
              aria-label="Continue with Saver faretypessaverbutton"
              data-testid="fareTypesSaverButton"
            >Continue with Saver</div>
          </article>
          <article data-fare="standard">
            <h2>Basic Standard</h2>
            <strong>+ 659.06 TL</strong>
            <p>Recommended fare</p>
            <p>Refund available for a 30 € fee</p>
            <div
              role="button"
              tabindex="0"
              aria-label="Continue with Standard faretypesstandardbutton"
              data-testid="fareTypesStandardButton"
            >Continue with Standard</div>
          </article>
          <article data-fare="flexi">
            <h2>Basic Flexi</h2>
            <strong>+ 1,361.35 TL</strong>
            <p>Flexible changes</p>
            <span role="button" tabindex="0">80% refund of the ticket price</span>
            <div
              role="button"
              tabindex="0"
              aria-label="Continue with Flexi faretypesflexibutton"
              data-testid="fareTypesFlexiButton"
            >Continue with Flexi</div>
          </article>
        </div>
      </section>
    </main>
    <script>
      document.querySelectorAll('[data-testid^="fareTypes"]').forEach((control) => {
        for (let depth = 0; depth < 8; depth += 1) {
          const wrapper = document.createElement("div");
          control.replaceWith(wrapper);
          wrapper.append(control);
        }
      });
      document.querySelector('[data-testid="fareTypesSaverButton"]').addEventListener("click", () => {
        location.hash = "cancellation-protection";
        document.querySelector('[aria-label="Fare packages"]').outerHTML = \`
          <section aria-label="Cancellation protection">
            <h2>Protect your trip?</h2>
            <button type="button">No thanks, I’ll take the risk</button>
          </section>
        \`;
      });
    </script>
  `);

  const observation = await browserObservation(page, "obs_commercial_fare_cards");
  const saver = observation.page.controls.find((control) => /continue with saver/i.test(control.label || ""));
  const standard = observation.page.controls.find((control) => /continue with standard/i.test(control.label || ""));
  const flexi = observation.page.controls.find((control) => /continue with flexi/i.test(control.label || ""));

  expect(saver).toMatchObject({
    structuredPrice: { amount: 0, currency: "TRY" },
    physicalEffect: "select_free_option",
    risk: "safe"
  });
  expect(standard).toMatchObject({
    structuredPrice: { amount: 659.06, currency: "TRY" },
    physicalEffect: "select_paid_option",
    risk: "money"
  });
  expect(flexi).toMatchObject({
    structuredPrice: { amount: 1361.35, currency: "TRY" },
    physicalEffect: "select_paid_option",
    risk: "money"
  });
  expect(new Set([saver.decisionGroupId, standard.decisionGroupId, flexi.decisionGroupId]).size).toBe(1);
  expect(saver.choiceContract).toMatchObject({
    optionCount: 3,
    advancesOnSelection: true,
    priceEvidenceSource: "bounded_option_owner_included"
  });

  const group = observation.page.decisionGroups.find((item) => item.decisionGroupId === saver.decisionGroupId);
  expect(group).toBeTruthy();
  expect(group.required).toBe(true);
  expect(group.alternatives).toHaveLength(3);

  const traveler = { booking_rules: "No paid seats and no paid extras or add-ons" };
  const taskState = reduceTaskState({ observation, traveler });
  expect(taskState.currentGoal.decisionGroupId).toBe(group.decisionGroupId);
  expect(taskState.currentGoal.desiredSemanticOutcome).toBe("included_base_fare");
  expect(taskState.currentGoal.policyAllowedControlIds).toEqual([saver.controlId]);
  expect(taskState.currentGoal.freeAlternativeControlIds).toContain(saver.controlId);
  expect(taskState.currentGoal.paidAlternativeControlIds).toEqual(expect.arrayContaining([
    standard.controlId,
    flexi.controlId
  ]));
  const candidateSet = buildCurrentCandidateSet({
    goal: taskState.currentGoal,
    observation,
    traveler,
    state: { taskState, approvals: {} }
  });
  expect(candidateSet.candidates.some((candidate) => candidate.controlId === saver.controlId)).toBe(true);
  expect(candidateSet.candidates.some((candidate) => candidate.controlId === standard.controlId)).toBe(false);
  expect(candidateSet.candidates.some((candidate) => candidate.controlId === flexi.controlId)).toBe(false);
  const saverCandidate = candidateSet.candidates.find((candidate) => candidate.controlId === saver.controlId);
  expect(saverCandidate.intendedOutcome).toBe("included_base_fare");
  const action = loopPrivate.bindTargetSnapshot(
    actionForCurrentCandidate(taskState.currentGoal, saverCandidate, observation),
    observation
  );
  const executed = await executeAtomicBrowserDecision(page, toClientDecision(action), "obs_included_fare_advanced");
  expect(executed.validation.ok, executed.validation.code).toBe(true);
  expect(executed.verification.ok, JSON.stringify(executed.verification, null, 2)).toBe(true);
  expect(executed.verification.evidence.semanticPolicyOutcomeVerified).toBe(true);
  expect(executed.observation.page.controls.some((control) => /no thanks/i.test(control.label || ""))).toBe(true);
  expect(executed.observation.page.controls.some((control) => control.controlId === saver.controlId)).toBe(false);
  const afterTaskState = reduceTaskState({
    previousTaskState: taskState,
    observation: executed.observation,
    previousActionResult: executed.result,
    traveler
  });
  expect(afterTaskState.currentGoal?.decisionGroupId || "").not.toBe(group.decisionGroupId);
  expect(afterTaskState.completedOutcomes.some((outcome) => outcome.decisionGroupId === group.decisionGroupId)).toBe(true);
});

test("absolute fare totals compile to one base fare and exact profile-compatible candidate", async ({ page }) => {
  await loadHtmlProducer(page, `
    <style>
      #fare-options { display: grid; grid-template-columns: repeat(3, 260px); gap: 16px; }
      article { min-height: 180px; padding: 16px; border: 1px solid #bbb; }
      button { min-height: 40px; }
    </style>
    <main>
      <h1>Get the option to change or cancel your trip</h1>
      <section aria-label="Fare packages">
        <div id="fare-options">
          <article>
            <h2>Basic Saver</h2>
            <strong>33 €</strong>
            <p>No flexibility to change your trip</p>
            <button type="button" data-testid="fareTypesSaverButton">Continue with Saver</button>
          </article>
          <article>
            <h2>Basic Standard</h2>
            <strong>45 €</strong>
            <p>Free trip changes</p>
            <button type="button" data-testid="fareTypesStandardButton">Continue with Standard</button>
          </article>
          <article>
            <h2>Basic Flexi</h2>
            <strong>58 €</strong>
            <p>80% refund of the ticket</p>
            <button type="button" data-testid="fareTypesFlexiButton">Continue with Flexi</button>
          </article>
        </div>
      </section>
      <aside aria-label="Booking summary">
        <p>1x Adult</p>
        <p>Total (EUR) <strong>33 €</strong></p>
      </aside>
    </main>
  `);

  const rawObservation = await browserObservation(page, "obs_absolute_fare_totals");
  // The browser publishes evidence/mechanics only. Absolute-fare comparison
  // is owned by the one backend DecisionFrame compiler.
  expect(rawObservation.page.controls
    .filter((control) => /continue with (?:saver|standard|flexi)/i.test(control.label || ""))
    .map((control) => control.structuredPrice || null)).toEqual([null, null, null]);
  const decisionFrame = compileDecisionFrame({ observation: rawObservation });
  const observation = decisionFrame.observation;
  const controls = ["saver", "standard", "flexi"].map((name) =>
    observation.page.controls.find((control) => new RegExp(`continue with ${name}`, "i").test(control.label || ""))
  );

  expect(controls.map((control) => control.structuredPrice)).toEqual([
    { amount: 0, currency: "EUR" },
    { amount: 12, currency: "EUR" },
    { amount: 25, currency: "EUR" }
  ]);
  expect(controls.map((control) => control.physicalEffect)).toEqual([
    "select_free_option",
    "select_paid_option",
    "select_paid_option"
  ]);
  expect(new Set(controls.map((control) => control.decisionGroupId)).size).toBe(1);

  const traveler = { booking_rules: "No paid extras or add-ons" };
  const taskState = reduceTaskState({ observation, traveler, decisionFrame });
  expect(taskState.currentGoal.desiredSemanticOutcome).toBe("included_base_fare");
  expect(taskState.currentGoal.policyAllowedControlIds).toEqual([controls[0].controlId]);

  const candidateSet = buildCurrentCandidateSet({
    goal: taskState.currentGoal,
    observation,
    traveler,
    state: { taskState, approvals: {} }
  });
  expect(candidateSet.candidates.map((candidate) => candidate.controlId)).toEqual([controls[0].controlId]);
});

test("a completed fare decision retires when its DOM remains inside an inactive clipped pane", async ({ page }) => {
  await loadHtmlProducer(page, `
    <style>
      #checkout-frame { width: 860px; }
      #fare-clip { height: 500px; overflow: hidden; }
      .checkout-pane { width: 820px; min-height: 480px; }
      .options { display: grid; grid-template-columns: repeat(3, 250px); gap: 16px; }
      article { padding: 16px; border: 1px solid #bbb; }
      button { min-height: 40px; }
    </style>
    <main>
      <div id="checkout-frame">
        <div id="fare-clip">
          <section id="fare-pane" class="checkout-pane" aria-label="Fare packages">
            <h1>Choose your fare</h1>
            <div class="options">
              <article>
                <h2>Basic Saver</h2><strong>33 €</strong>
                <button type="button" data-testid="fareTypesSaverButton">Continue with Saver</button>
              </article>
              <article>
                <h2>Basic Standard</h2><strong>45 €</strong>
                <button type="button" data-testid="fareTypesStandardButton">Continue with Standard</button>
              </article>
              <article>
                <h2>Basic Flexi</h2><strong>58 €</strong>
                <button type="button" data-testid="fareTypesFlexiButton">Continue with Flexi</button>
              </article>
            </div>
          </section>
        </div>
        <section id="cancellation-pane" class="checkout-pane" aria-label="Medical cancellation" hidden>
          <h1>Get a 100% refund if you need to cancel your trip</h1>
          <div class="options" style="grid-template-columns:repeat(2, 390px)">
            <article>
              <h2>No medical cancellation</h2><strong>0 €</strong>
              <button id="decline-cancellation" type="button">No thanks, I’ll take the risk</button>
            </article>
            <article>
              <h2>Medical cancellation</h2><strong>2 €</strong>
              <button type="button">Add protection for 2 €</button>
            </article>
          </div>
        </section>
      </div>
      <aside aria-label="Booking summary"><p id="fare-summary">Total (EUR) 33 €</p></aside>
    </main>
    <script>
      document.querySelector('[data-testid="fareTypesSaverButton"]').addEventListener("click", () => {
        document.getElementById("fare-clip").style.height = "0px";
        document.getElementById("cancellation-pane").hidden = false;
        document.getElementById("fare-summary").textContent = "Saver · Total (EUR) 33 €";
      });
    </script>
  `);

  const traveler = { booking_rules: "No paid extras, add-ons, or insurance" };
  const rawBefore = await browserObservation(page, "obs_retained_fare_before");
  const beforeDecisionFrame = compileDecisionFrame({ observation: rawBefore, traveler });
  const before = beforeDecisionFrame.observation;
  const beforeTaskState = reduceTaskState({ observation: before, traveler, decisionFrame: beforeDecisionFrame });
  const beforeCandidates = buildCurrentCandidateSet({
    goal: beforeTaskState.currentGoal,
    observation: before,
    traveler,
    state: { taskState: beforeTaskState, approvals: {} }
  });
  const saver = before.page.controls.find((control) => /continue with saver/i.test(control.label || ""));
  const saverCandidate = beforeCandidates.candidates.find((candidate) => candidate.controlId === saver.controlId);
  expect(saverCandidate).toBeTruthy();

  const action = loopPrivate.bindTargetSnapshot(
    actionForCurrentCandidate(beforeTaskState.currentGoal, saverCandidate, before),
    before
  );
  const executed = await executeAtomicBrowserDecision(page, toClientDecision(action), "obs_retained_fare_after");
  expect(executed.validation.ok, executed.validation.code).toBe(true);
  expect(executed.result.expectedOutcome?.policyAuthorized, JSON.stringify(toClientDecision(action), null, 2)).toBe(true);
  expect(executed.verification.ok, JSON.stringify(executed.verification, null, 2)).toBe(true);

  const retainedSaver = executed.observation.page.controls.find((control) => control.controlId === saver.controlId);
  expect(retainedSaver).toBeTruthy();
  expect(retainedSaver.operations.activate.actionability).toMatchObject({
    executable: false,
    revealable: false,
    code: "ACTUATOR_CLIPPED_INACTIVE"
  });
  expect(executed.observation.page.decisionGroups.some((group) => (
    (group.alternatives || []).some((option) => option.controlId === saver.controlId)
  ))).toBe(false);

  const afterDecisionFrame = compileDecisionFrame({ observation: executed.observation, traveler });
  const afterObservation = afterDecisionFrame.observation;
  const afterTaskState = reduceTaskState({
    previousTaskState: beforeTaskState,
    observation: afterObservation,
    previousActionResult: executed.result,
    traveler,
    decisionFrame: afterDecisionFrame
  });
  expect(afterTaskState.completedOutcomes.some((outcome) => (
    outcome.decisionGroupId === beforeTaskState.currentGoal.decisionGroupId
  ))).toBe(true);
  const afterCandidates = buildCurrentCandidateSet({
    goal: afterTaskState.currentGoal,
    observation: afterObservation,
    traveler,
    state: { taskState: afterTaskState, approvals: {} }
  });
  expect(afterCandidates.candidates.some((candidate) => /no thanks/i.test(candidate.targetLabel || ""))).toBe(true);
});

test("unowned commercial-looking Continue CTA fails closed instead of becoming safe navigation", async ({ page }) => {
  await loadHtmlProducer(page, `
    <main>
      <h1>Trip options</h1>
      <button id="standard" type="button" data-testid="fareTypesStandardButton">Continue with Standard</button>
    </main>
  `);

  const observation = await browserObservation(page, "obs_unowned_commercial_cta");
  const standard = observation.page.controls.find((control) => /continue with standard/i.test(control.label || ""));
  expect(standard).toBeTruthy();
  expect(standard.choiceContract).toBeNull();
  expect(standard.structuredPrice).toBeNull();
  expect(standard.risk).toBe("uncertain");
  expect(standard.semantic).toBe("selection_cta");
  expect(standard.physicalEffect).toBe("unknown");
  expect(observation.page.stageExit.candidates.some((candidate) => candidate.controlId === standard.controlId)).toBe(false);
  expect(observation.page.stageExit.continueAllowed).toBe(false);

  const traveler = { booking_rules: "No paid extras or add-ons" };
  const taskState = reduceTaskState({ observation, traveler });
  expect(taskState.currentGoal).toBeNull();
  expect(taskState.ambiguityReason).toBe("no_goal_relevant_candidate");
});

test("no-paid-seat policy excludes a free specific seat when random or skip is available", async ({ page }) => {
  await loadHtmlProducer(page, `
    <main>
      <h1>Seat selection</h1>
      <section aria-label="Seat selection">
        <div role="radiogroup" aria-label="Seat assignment" aria-required="true" data-choice-group>
          <button type="button" aria-pressed="false">Seat 12A — 0 EUR</button>
          <button type="button" aria-pressed="false">Random seating — 0 EUR</button>
          <button type="button" aria-pressed="false">Skip seat selection</button>
        </div>
      </section>
    </main>
  `);

  const observation = await browserObservation(page, "obs_seat_skip_preferred");
  const group = observation.page.decisionGroups.find((item) => /seat/i.test(`${item.sectionLabel} ${item.requirementId}`));
  expect(group, JSON.stringify(observation.page.decisionGroups, null, 2)).toBeTruthy();
  const controls = Object.fromEntries(observation.page.controls
    .filter((control) => control.decisionGroupId === group.decisionGroupId)
    .map((control) => [control.label, control]));
  const specific = Object.values(controls).find((control) => /seat 12a/i.test(control.label || ""));
  const random = Object.values(controls).find((control) => /random seating/i.test(control.label || ""));
  const skip = Object.values(controls).find((control) => /skip seat selection/i.test(control.label || ""));
  expect(specific).toBeTruthy();
  expect(random).toBeTruthy();
  expect(skip).toBeTruthy();

  const traveler = { booking_rules: "No paid seats", seat_policy: "random_assignment" };
  const taskState = reduceTaskState({
    observation,
    traveler,
    userPolicy: { seatPolicy: "random_assignment" }
  });
  expect(taskState.currentGoal.desiredSemanticOutcome).toBe("random_assignment");
  expect(taskState.currentGoal.policyAllowedControlIds).toEqual(expect.arrayContaining([
    random.controlId,
    skip.controlId
  ]));
  expect(
    taskState.currentGoal.freeAlternativeControlIds,
    JSON.stringify({
      currentGoal: taskState.currentGoal,
      activeDecisions: taskState.activeDecisions,
      observedDecisions: taskState.observedDecisions,
      group
    }, null, 2)
  ).toEqual(expect.arrayContaining([
    random.controlId,
    skip.controlId
  ]));
  expect(taskState.currentGoal.freeAlternativeControlIds).not.toContain(specific.controlId);
  const candidateSet = buildCurrentCandidateSet({
    goal: taskState.currentGoal,
    observation,
    traveler,
    state: { taskState, approvals: {} }
  });
  expect(candidateSet.candidates.some((candidate) => candidate.controlId === specific.controlId)).toBe(false);
  expect(candidateSet.candidates.some((candidate) => (
    candidate.controlId === random.controlId || candidate.controlId === skip.controlId
  ))).toBe(true);
  expect(candidateSet.candidates.filter((candidate) => (
    candidate.controlId === random.controlId || candidate.controlId === skip.controlId
  )).every((candidate) => candidate.intendedOutcome === "random_assignment")).toBe(true);
});

test("random-assignment seat policy fails closed when only a free specific seat is offered", async ({ page }) => {
  await loadHtmlProducer(page, `
    <main>
      <h1>Seat selection</h1>
      <div role="radiogroup" aria-label="Required seat assignment" aria-required="true" data-choice-group>
        <button type="button" aria-pressed="false">Seat 12A — 0 EUR</button>
        <button type="button" aria-pressed="false">Seat 14C — 8 EUR</button>
      </div>
    </main>
  `);

  const observation = await browserObservation(page, "obs_specific_seats_only");
  const specificSeatIds = observation.page.controls
    .filter((control) => /seat (?:12a|14c)/i.test(control.label || ""))
    .map((control) => control.controlId);
  const traveler = { booking_rules: "No paid seats", seat_policy: "random_assignment" };
  const taskState = reduceTaskState({
    observation,
    traveler,
    userPolicy: { seatPolicy: "random_assignment" }
  });
  expect(taskState.currentGoal.desiredSemanticOutcome).toBe("random_assignment");
  expect(taskState.currentGoal.policyChoiceBounded).toBe(true);
  expect(taskState.currentGoal.policyAllowedControlIds).toEqual([]);

  const candidateSet = buildCurrentCandidateSet({
    goal: taskState.currentGoal,
    observation,
    traveler,
    state: { taskState, approvals: {} }
  });
  expect(candidateSet.candidates.some((candidate) => specificSeatIds.includes(candidate.controlId))).toBe(false);
});

test("seat-map traveler summary stays context while Next is the only safe selectable action", async ({ page }) => {
  await loadHtmlProducer(page, `
    <style>
      body { font-family: sans-serif; }
      #seat-modal { position: fixed; inset: 20px; padding: 18px; background: white; }
      #seat-map { display: grid; grid-template-columns: repeat(3, 80px); gap: 8px; }
      button { min-height: 38px; }
    </style>
    <section id="seat-modal" role="dialog" aria-modal="true" aria-labelledby="seat-title">
      <h2 id="seat-title">Reserve seating</h2>
      <p>Flight 1 of 2</p>
      <button id="traveler-row" type="button" data-testid="seatMapTravelerButton-0">
        <span>Ali SIFRAR</span><span>Not selected</span>
      </button>
      <div id="seat-map" aria-label="Seat map">
        <button id="seat-1e" type="button">Seat 1E — EUR50.00</button>
        <button id="seat-2a" type="button">Seat 2A — EUR40.00</button>
      </div>
      <div aria-label="Seat map key">
        <span>Standard seat</span><span>Not available</span>
      </div>
      <button id="seat-next" type="button">Next</button>
    </section>
    <script>
      document.getElementById("seat-next").addEventListener("click", () => {
        document.querySelector("#seat-modal p").textContent = "Flight 2 of 2";
        document.body.dataset.seatLeg = "2";
      });
    </script>
  `);

  const observation = await browserObservation(page, "obs_seat_traveler_context");
  const traveler = { booking_rules: "no paid seats" };
  const taskState = reduceTaskState({
    observation,
    userPolicy: { skipPaidExtrasApproved: true },
    traveler
  });
  const candidateSet = buildCurrentCandidateSet({
    goal: taskState.currentGoal,
    observation,
    traveler,
    state: { taskState, approvals: { skipPaidExtrasApproved: true } }
  });
  const travelerControl = observation.page.controls.find((control) => /ali sifrar.*not selected/i.test(control.label || ""));
  const nextControl = observation.page.controls.find((control) => /^next$/i.test(control.label || ""));

  expect(travelerControl).toBeTruthy();
  expect(nextControl).toBeTruthy();
  expect(taskState.currentGoal.freeAlternativeControlIds || []).not.toContain(travelerControl.controlId);
  expect(candidateSet.contextCapabilities.some((capability) => capability.controlId === travelerControl.controlId)).toBe(false);
  expect(candidateSet.candidates.map((candidate) => candidate.controlId), JSON.stringify({
    goal: {
      semanticType: taskState.currentGoal.semanticType,
      desiredPolicyOutcome: taskState.currentGoal.desiredPolicyOutcome,
      actionableControlIds: taskState.currentGoal.actionableControlIds,
      paidAlternativeControlIds: taskState.currentGoal.paidAlternativeControlIds
    },
    nextControl: nextControl && {
      controlId: nextControl.controlId,
      label: nextControl.label,
      semantic: nextControl.semantic,
      physicalEffect: nextControl.physicalEffect,
      risk: nextControl.risk
    },
    candidates: candidateSet.candidates.map((candidate) => ({
      controlId: candidate.controlId,
      label: candidate.targetLabel,
      intent: candidate.intent,
      physicalEffect: candidate.physicalEffect,
      exclusionReason: candidate.exclusionReason
    })),
    context: candidateSet.contextCapabilities.map((candidate) => ({
      controlId: candidate.controlId,
      label: candidate.targetLabel,
      intent: candidate.intent,
      physicalEffect: candidate.physicalEffect,
      risk: candidate.risk,
      selectable: candidate.selectable,
      exclusionReason: candidate.exclusionReason,
      policy: candidate.policyDecision
    }))
  }, null, 2)).toEqual([nextControl.controlId]);

  const action = actionForCurrentCandidate(taskState.currentGoal, candidateSet.candidates[0], observation);
  const executed = await executeAtomicBrowserDecision(page, toClientDecision(action), "obs_seat_leg_2");
  expect(executed.validation.ok).toBe(true);
  expect(executed.result.dispatched).toBe(true);
  expect(await page.locator("body").getAttribute("data-seat-leg")).toBe("2");
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

test("extension repeat guard remains diagnostic and never stops the running agent", async ({ page }) => {
  await loadHtmlProducer(page, `
    <main>
      <h1>Passenger details</h1>
      <button id="repeat-target" type="button">Open title</button>
    </main>
  `);

  const repeatState = await page.evaluate(() => {
    const hooks = window.__ATW_TEST__;
    const target = document.getElementById("repeat-target");
    hooks.setAgentRunningForTest(true);
    hooks.repeatGuardFor(target, "diagnostic repeat");
    hooks.repeatGuardFor(target, "diagnostic repeat");
    hooks.repeatGuardFor(target, "diagnostic repeat");
    return hooks.repeatGuardState();
  });

  expect(repeatState.repeatClickCount).toBe(2);
  expect(repeatState.running).toBe(true);
});

test("slow destination hydration wakes the durable client wait and fills email without another Start", async ({ page }) => {
  await page.goto("http://127.0.0.1:4273/checkout/extras");
  await loadHtmlProducer(page, `
    <main id="checkout">
      <h1>Optional extras</h1>
      <button id="continue" type="button">Continue</button>
    </main>
    <script>
      window.__destinationLifecycle = { continueClicks: 0, hydrated: false };
      document.getElementById("continue").addEventListener("click", () => {
        window.__destinationLifecycle.continueClicks += 1;
        history.pushState({}, "", "/checkout/traveler");
        document.getElementById("checkout").innerHTML =
          '<section id="traveler-shell" aria-busy="true"><h1>Traveller information</h1><p>Loading traveler form…</p></section>';
        setTimeout(() => {
          const shell = document.getElementById("traveler-shell");
          shell.setAttribute("aria-busy", "false");
          shell.innerHTML =
            '<h1>Traveller information</h1><label>Email <input id="traveler-email" name="email" type="email" required></label>';
          window.__destinationLifecycle.hydrated = true;
        }, 1_650);
      });
    </script>
  `);

  const sessionId = "session_slow_destination";
  let requestCount = 0;
  let activeRequests = 0;
  let maxConcurrentRequests = 0;
  let shellWaitRequests = 0;
  const shellHashes = [];
  const actions = [];

  await page.route("**/api/agent/report", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: sessionId })
    });
  });
  await page.route("**/api/agent/next-action", async (route) => {
    requestCount += 1;
    activeRequests += 1;
    maxConcurrentRequests = Math.max(maxConcurrentRequests, activeRequests);
    const body = route.request().postDataJSON();
    const controls = body.page?.controls || [];
    const continueControl = controls.find((control) => /continue/i.test(control.ownText || control.label || ""));
    const emailControl = controls.find((control) => (
      control.fieldType === "email"
      || control.semantic === "email"
      || /\bemail\b/i.test(control.stableKey || "")
    ));
    let decision;
    if (emailControl?.state?.valuePresent === true) {
      decision = {
        sessionId,
        observationId: body.observationId,
        observationHash: body.observationSnapshot.snapshotHash,
        actionId: `act_stop_after_email_${requestCount}`,
        action: "stop",
        intent: "test_complete",
        risk: "safe",
        needsApproval: false,
        message: "Traveler email is complete."
      };
    } else if (emailControl) {
      const typeOperation = emailControl.operations?.type;
      decision = {
        sessionId,
        observationId: body.observationId,
        observationHash: body.observationSnapshot.snapshotHash,
        actionId: `act_fill_email_${requestCount}`,
        action: "type",
        operation: "type",
        intent: "satisfy_semantic_goal",
        semanticIntent: "set_profile_field",
        mechanicalEffect: "set_field_value",
        controlId: emailControl.controlId,
        targetId: typeOperation?.actuatorId || "",
        targetLabel: emailControl.label || "Email",
        targetSnapshot: emailControl,
        value: "ali@example.test",
        expectedOutcome: {
          type: "normalized_value_changed",
          controlId: emailControl.controlId,
          expectedNormalizedValue: "ali@example.test"
        },
        risk: "safe",
        needsApproval: false,
        message: "Fill the saved email."
      };
    } else if (continueControl && actions.length === 0) {
      const activate = continueControl.operations?.activate;
      decision = {
        sessionId,
        observationId: body.observationId,
        observationHash: body.observationSnapshot.snapshotHash,
        actionId: "act_continue_to_slow_destination",
        action: "click",
        operation: "activate",
        intent: "advance_checkout_stage",
        semanticIntent: "advance_checkout_stage",
        mechanicalEffect: "advance_checkout_stage",
        controlId: continueControl.controlId,
        targetId: activate?.actuatorId || "",
        targetLabel: continueControl.label || "Continue",
        targetSnapshot: continueControl,
        expectedOutcome: { type: "checkout_stage_advanced" },
        risk: "safe",
        needsApproval: false,
        message: "Continue to traveler information."
      };
    } else {
      shellWaitRequests += 1;
      shellHashes.push(body.observationSnapshot.snapshotHash);
      decision = {
        sessionId,
        observationId: body.observationId,
        observationHash: body.observationSnapshot.snapshotHash,
        actionId: `act_wait_destination_${requestCount}`,
        action: "wait",
        intent: "reobserve_after_transient_observation",
        semanticIntent: "wait_for_ready_observation",
        mechanicalEffect: "unknown",
        expectedPostconditions: [{ type: "observation_readiness", status: "READY" }],
        risk: "safe",
        needsApproval: false,
        message: "The traveler destination is still hydrating."
      };
    }
    actions.push(decision.action);
    await new Promise((resolve) => setTimeout(resolve, 45));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(decision)
    });
    activeRequests -= 1;
  });

  await page.evaluate(({ sessionId, apiBase }) => {
    window.chrome = {
      storage: {
        local: {
          get: async () => ({ apiBase }),
          set: async () => undefined,
          remove: async () => undefined
        }
      },
      runtime: {
        sendMessage: async () => ({ ok: false, error: "not needed for DOM-grounded test" })
      }
    };
    const hooks = window.__ATW_TEST__;
    hooks.setAppDataForTest({
      travelers: [{
        id: "trav_slow_destination",
        email: "ali@example.test",
        first_name: "Ali",
        last_name: "Sifrar",
        booking_rules: "No paid extras"
      }],
      preferences: {}
    }, "trav_slow_destination");
    hooks.resetAgentLoopLifecycle("slow_destination_test");
    hooks.setAgentSessionForTest(sessionId);
    hooks.setAgentRunningForTest(true);
    hooks.watchForCheckoutChanges();
    hooks.processCheckoutAgent();
  }, { sessionId, apiBase: TEST_API });

  await expect(page.locator("#traveler-email")).toHaveValue("ali@example.test", { timeout: 10_000 });
  const state = await page.evaluate(() => ({
    lifecycle: window.__destinationLifecycle,
    loop: window.__ATW_TEST__.agentLoopState(),
    sidebarText: document.getElementById("atw-sidebar")?.innerText || ""
  }));
  expect(state.lifecycle.continueClicks).toBe(1);
  expect(state.lifecycle.hydrated).toBe(true);
  // Request cadence varies under a loaded full replay run; one observed shell
  // wait plus eventual hydration and automatic email fill proves the durable
  // wake path without making the test depend on an extra polling interval.
  expect(shellWaitRequests).toBeGreaterThanOrEqual(1);
  expect(new Set(shellHashes).size).toBe(1);
  expect(maxConcurrentRequests).toBe(1);
  expect(actions.filter((action) => action === "click")).toHaveLength(1);
  expect(actions.filter((action) => action === "type")).toHaveLength(1);
  expect(state.loop.destinationWait).toBeNull();
  expect(state.loop.destinationWaitTimerActive).toBe(false);
  expect(state.sidebarText).not.toContain("Waiting for you");
});

test("real backend suppresses unchanged destination observations and wakes on traveler-form mutation", async ({ page, request }) => {
  await page.goto("http://127.0.0.1:4273/checkout/extras");
  await loadHtmlProducer(page, `
    <main id="checkout">
      <h1>Optional extras</h1>
      <button id="continue" type="button">Continue</button>
    </main>
    <script>
      window.__realDestinationLifecycle = { continueClicks: 0, hydrated: false, hydratedAt: 0 };
      document.getElementById("continue").addEventListener("click", () => {
        window.__realDestinationLifecycle.continueClicks += 1;
        history.pushState({}, "", "/checkout/traveler");
        document.getElementById("checkout").innerHTML =
          '<section id="traveler-shell" aria-busy="true"><h1>Traveller information</h1><p>Loading traveler form…</p></section>';
        setTimeout(() => {
          const shell = document.getElementById("traveler-shell");
          shell.setAttribute("aria-busy", "false");
          shell.innerHTML =
            '<h1>Traveller information</h1><label>Email <input id="traveler-email" name="email" type="email" required></label>';
          window.__realDestinationLifecycle.hydrated = true;
          window.__realDestinationLifecycle.hydratedAt = Date.now();
        // Keep the shell alive long enough to prove that unchanged polling is
        // suppressed and the material hydration mutation owns the next wake.
        }, 7_000);
      });
    </script>
  `);

  const traveler = {
    id: `trav_real_slow_destination_${Date.now()}`,
    email: "ali@example.test",
    first_name: "Ali",
    last_name: "Sifrar",
    booking_rules: "No paid extras"
  };
  const started = await request.post(`${TEST_API}/agent/session`, {
    data: {
      goal: "Continue checkout safely to payment review",
      traveler,
      page: { site: "example.test", url: page.url(), step: "extras" }
    }
  });
  expect(started.status()).toBe(201);
  const session = await started.json();

  const backendRequests = [];
  page.on("request", (outgoing) => {
    if (!outgoing.url().endsWith("/api/agent/next-action")) return;
    try {
      backendRequests.push({
        at: Date.now(),
        body: outgoing.postDataJSON()
      });
    } catch {
      // The assertion below reports a missing request if the payload was not JSON.
    }
  });

  await page.evaluate(({ apiBase, sessionId, travelerProfile }) => {
    window.chrome = {
      storage: {
        local: {
          get: async () => ({ apiBase }),
          set: async () => undefined,
          remove: async () => undefined
        }
      },
      runtime: {
        sendMessage: async () => ({ ok: false, error: "not needed for DOM-grounded test" })
      }
    };
    const hooks = window.__ATW_TEST__;
    hooks.setAppDataForTest({ travelers: [travelerProfile], preferences: {} }, travelerProfile.id);
    hooks.resetAgentLoopLifecycle("real_backend_slow_destination_test");
    hooks.setAgentSessionForTest(sessionId);
    hooks.setAgentRunningForTest(true);
    hooks.watchForCheckoutChanges();
    hooks.processCheckoutAgent();
  }, { apiBase: TEST_API, sessionId: session.id, travelerProfile: traveler });

  await expect(page.locator("#traveler-email")).toHaveValue("ali@example.test", { timeout: 15_000 });
  const state = await page.evaluate(() => ({
    lifecycle: window.__realDestinationLifecycle,
    loop: window.__ATW_TEST__.agentLoopState(),
    flow: window.__ATW_TEST__.agentLoopState().flowLog || []
  }));
  const shellRequests = backendRequests.filter(({ at, body }) => (
    state.lifecycle.hydratedAt > 0
    && at < state.lifecycle.hydratedAt
    && body.page?.readiness?.ariaBusy === true
  ));

  expect(state.lifecycle.continueClicks).toBe(1);
  expect(state.lifecycle.hydrated).toBe(true);
  expect(shellRequests.length).toBe(1);
  expect(new Set(shellRequests.map(({ body }) => body.observationSnapshot?.snapshotHash)).size).toBe(1);
  expect(state.loop.destinationWait).toBeNull();
  expect(state.loop.destinationWaitTimerActive).toBe(false);
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
        stableKey: control.stableKey,
        id: label.dataset.atwElementId,
        stateElementId: control.stateElementId,
        preferredActivationElementId: control.preferredActivationElementId
      }
    };
    const resolved = hooks.resolveDecisionTarget(decision, beforeMap);
    input.addEventListener("blur", () => {
      const replacement = input.cloneNode(true);
      replacement.value = input.value;
      replacement.removeAttribute("data-atw-element-id");
      replacement.removeAttribute("data-atw-control-id");
      input.replaceWith(replacement);
    }, { once: true });
    const fill = await hooks.setFieldValue(resolved, "ali@example.com", {
      fieldType: "email",
      resolveLiveElement: () => {
        const currentMap = hooks.buildPageMap();
        return hooks.resolveDecisionTarget({
          action: "type",
          controlId: "stale-control-id",
          stableKey: control.stableKey,
          targetSnapshot: { controlId: "stale-control-id", stableKey: control.stableKey }
        }, currentMap);
      }
    });
    const liveInput = document.getElementById("email-input");
    const afterMap = hooks.buildPageMap();
    const reboundControl = afterMap.controls.find((item) => item.stateElementId === liveInput?.dataset?.atwElementId);
    return {
      resolvedTag: resolved?.tagName || "",
      resolvedId: resolved?.id || "",
      labelId: label.id,
      fill,
      liveValue: liveInput?.value || "",
      replaced: liveInput !== input,
      beforeStableKey: control.stableKey,
      afterStableKey: reboundControl?.stableKey || ""
    };
  });

  expect(result.resolvedTag).toBe("INPUT");
  expect(result.resolvedId).not.toBe(result.labelId);
  expect(result.replaced).toBe(true);
  expect(result.fill.ok).toBe(true);
  expect(result.liveValue).toBe("ali@example.com");
  expect(result.afterStableKey).toBe(result.beforeStableKey);
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
  expect(result.openRecovery).toBeNull();
});

test("an observed exact choice supersedes trusted-open fallback while preserving proven open", async ({ page }) => {
  await loadProducer(page, profileFixturePath);
  const result = await page.evaluate(() => {
    window.__ATW_TEST__.setAppDataForTest({
      travelers: [{ id: "trav_test", first_name: "Ali", last_name: "Test", booking_rules: "No paid extras" }],
      preferences: {}
    }, "trav_test");
    const map = window.__ATW_TEST__.buildPageMap();
    const control = map.controls.find((item) => item.label === "Country code" || item.semantic === "phone_country_code");
    return {
      openActuatorId: control?.operations?.open?.actuatorId || "",
      recoveryMethods: control?.recovery?.open?.strategies?.map((strategy) => ({
        actuatorId: strategy.actuatorId,
        method: strategy.method,
        status: strategy.status
      })) || [],
      choiceMethods: control?.recovery?.select?.strategies?.map((strategy) => ({
        actuatorId: strategy.actuatorId,
        method: strategy.method,
        status: strategy.status
      })) || [],
      ladder: control?.interactionLadder || []
    };
  });

  expect(result.openActuatorId).not.toBe("");
  expect(result.recoveryMethods.some((strategy) => strategy.method === "browser_trusted_input")).toBe(false);
  expect(result.choiceMethods).toContainEqual({
    actuatorId: result.openActuatorId,
    method: "browser_trusted_choice",
    status: "unproven_experiment"
  });
  expect(result.ladder.find((strategy) => (
    strategy.actuatorId === result.openActuatorId && strategy.method === "native_click"
  ))).toMatchObject({ status: "proven_executable", operationProven: true });
  expect(result.ladder.at(-1)).toMatchObject({
    method: "browser_trusted_choice",
    operation: "select",
    status: "unproven_experiment",
    operationProven: false
  });
});

test("P0.9 CSS pointer evidence makes an icon targetable without proving the combobox open operation", async ({ page }) => {
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
      openOperation: control?.operations?.open || null,
      recoveryActuatorIds: control?.recovery?.open?.actuatorIds || [],
      recoveryStrategies: control?.recovery?.open?.strategies || [],
      choiceStrategies: control?.recovery?.select?.strategies || [],
      iconElementId: icon.dataset.atwElementId || ""
    };
  });

  expect(result.iconElementId).not.toBe("");
  expect(result.openOperation).toBeNull();
  expect(result.recoveryActuatorIds).toContain(result.iconElementId);
  expect(result.recoveryStrategies.some((strategy) => strategy.method === "browser_trusted_input")).toBe(false);
  expect(result.choiceStrategies.some((strategy) => (
    strategy.actuatorId === result.iconElementId
    && strategy.method === "browser_trusted_choice"
    && strategy.status === "unproven_experiment"
    && strategy.actionability.targetable === true
    && strategy.actionability.operationProven === false
  ))).toBe(true);
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
  await page.addScriptTag({ path: contractScriptPath });
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

test("same-page navigation cannot verify from an absent map URL or visual churn alone", async ({ page }) => {
  await loadHtmlProducer(page, `
    <main>
      <h1>Select seats</h1>
      <button id="seat-next" type="button">Next</button>
    </main>
  `);

  const result = await page.evaluate(() => {
    const hooks = window.__ATW_TEST__;
    const observed = hooks.buildPageMap();
    const before = { ...observed };
    const after = { ...observed };
    delete before.url;
    delete after.url;
    return hooks.verifyExpectedOutcome({
      type: "checkout_stage_advanced",
      beforeUrl: location.href
    }, before, after, document.getElementById("seat-next"));
  });

  expect(result.ok).toBe(false);
  expect(result.code).toBe("CHECKOUT_STAGE_NOT_ADVANCED");
  expect(result.evidence.stepChanged).toBe(false);
  expect(result.evidence.urlChanged).toBe(false);
  expect(result.feedback).toMatchObject({
    targetReacted: false,
    progressChanged: false,
    navigationOccurred: false,
    outcomeVerified: false
  });
});

test("client flow diagnostics stay bounded instead of retransmitting the observation graph", async ({ page }) => {
  await loadHtmlProducer(page, `<main><button type="button">Continue</button></main>`);
  const result = await page.evaluate(() => {
    const hooks = window.__ATW_TEST__;
    const controls = Array.from({ length: 120 }, (_, index) => ({
      controlId: `ctrl_${index}`,
      label: `Choice ${index}`,
      operations: {
        activate: {
          actuatorId: `node_${index}`,
          actionabilityByActuator: {
            [`node_${index}`]: { rendered: true, visible: true, executable: true }
          },
          strategies: Array.from({ length: 8 }, (__, strategy) => ({
            method: `method_${strategy}`,
            proof: { text: "x".repeat(2_000) }
          }))
        }
      }
    }));
    const compact = hooks.compactFlowLogPayload("backend.response", {
      turnId: "turn_large",
      observationId: "obs_large",
      actionId: "act_large",
      decision: {
        actionId: "act_large",
        action: "click",
        targetLabel: "Continue",
        targetSnapshot: { controlId: "ctrl_continue", label: "Continue", operations: controls[0].operations }
      },
      backendDebug: { taskState: { canonicalDecisions: controls } },
      page: {
        site: "test",
        url: location.href,
        step: "seats",
        controls,
        summary: { controls: controls.length, decisionGroups: 1 }
      }
    });
    return {
      compact,
      bytes: new TextEncoder().encode(JSON.stringify(compact)).length
    };
  });

  expect(result.bytes).toBeLessThan(32_000);
  expect(result.compact.turnId).toBe("turn_large");
  expect(result.compact.observationId).toBe("obs_large");
  expect(result.compact.actionId).toBe("act_large");
  expect(JSON.stringify(result.compact)).not.toContain("canonicalDecisions");
  expect(JSON.stringify(result.compact)).not.toContain("actionabilityByActuator");
});

test("a persistent modal verifies internal marker advancement instead of requiring disappearance", async ({ page }) => {
  await loadHtmlProducer(page, `
    <section id="persistent-flow" role="dialog" aria-modal="true" aria-labelledby="persistent-title">
      <h2 id="persistent-title">Journey configuration</h2>
      <p id="persistent-marker">Flight 1 of 3</p>
      <button id="persistent-advance" type="button">Proceed</button>
    </section>
    <script>
      document.getElementById("persistent-advance").addEventListener("click", () => {
        document.getElementById("persistent-marker").textContent = "Flight 2 of 3";
      });
    </script>
  `);

  const result = await page.evaluate(async () => {
    const hooks = window.__ATW_TEST__;
    const before = hooks.buildPageMap();
    const target = document.getElementById("persistent-advance");
    const control = before.controls.find((item) => /proceed/i.test(item.ownText || item.label || ""));
    hooks.userLikeClick(target);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const after = hooks.buildPageMap();
    const verification = hooks.verifyExpectedOutcome({
      type: "active_surface_dismissed",
      surfaceId: before.currentSurface.id,
      controlId: control.controlId
    }, before, after, target);
    return {
      verification,
      beforeSurfaceId: before.currentSurface.id,
      afterSurfaceId: after.currentSurface.id,
      marker: after.foreground?.progressMarkers?.flightOrdinal || ""
    };
  });

  expect(result.beforeSurfaceId).toBe(result.afterSurfaceId);
  expect(result.marker).toContain("Flight 2 of 3");
  expect(result.verification.ok).toBe(true);
  expect(result.verification.code).toBe("ACTIVE_SURFACE_ADVANCED");
});

test("a profile-authorized free choice verifies when the site immediately advances and removes its source", async ({ page }) => {
  await loadHtmlProducer(page, `
    <main>
      <section id="insurance-stage">
        <h1>Travel insurance</h1>
        <div role="radiogroup" aria-label="Travel insurance">
          <button id="no-insurance" type="button">No insurance 0 EUR</button>
          <button id="paid-insurance" type="button">Add insurance 25 EUR</button>
        </div>
      </section>
      <section id="seat-stage" hidden>
        <h1>Select your seats</h1>
        <button id="seat-continue" type="button">Continue</button>
      </section>
    </main>
    <script>
      document.getElementById("no-insurance").addEventListener("click", () => {
        document.getElementById("insurance-stage").remove();
        document.getElementById("seat-stage").hidden = false;
        history.pushState({}, "", "#seats");
      });
    </script>
  `);

  const result = await page.evaluate(async () => {
    const hooks = window.__ATW_TEST__;
    const before = hooks.buildPageMap();
    const target = document.getElementById("no-insurance");
    const control = before.controls.find((item) => item.stateElementId === target.dataset.atwElementId);
    const expected = hooks.expectedOutcomeForDecision({
      action: "click",
      controlId: control.controlId,
      targetId: control.preferredActivationElementId || control.stateElementId,
      targetLabel: control.label,
      affordance: { policy: { allow: true } },
      expectedOutcome: {
        type: "exact_free_option_selected",
        controlId: control.controlId,
        expectedSelectedControlId: control.controlId,
        decisionGroupId: control.decisionGroupId,
        expectedDisposition: "decline_free_no_extra",
        beforePriceAmount: before.price?.amount ?? null,
        beforePriceText: before.priceText || ""
      }
    }, before, target);
    hooks.nativeElementClick(target);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const after = hooks.buildPageMap();
    const verification = hooks.verifyExpectedOutcome(expected, before, after, target);
    return {
      verification,
      beforeStep: before.step,
      afterStep: after.step,
      afterUrl: location.href,
      sourceStillPresent: after.controls.some((item) => item.controlId === control.controlId)
    };
  });

  expect(result.sourceStillPresent).toBe(false);
  expect(result.afterUrl).toContain("#seats");
  expect(result.verification.ok, JSON.stringify(result, null, 2)).toBe(true);
  expect(result.verification.code).toBe("POLICY_SAFE_CHOICE_ADVANCED");
  expect(result.verification.evidence.completionMode).toBe("safe_stage_transition");
});

test("browser verifier accepts a removed paid item despite stale cached conflict metadata", async ({ page }) => {
  await loadHtmlProducer(page, `
    <main><h1>Journey configuration</h1></main>
    <section role="dialog" aria-modal="true"><h2>Current selection</h2></section>
  `);

  const result = await page.evaluate(() => {
    const hooks = window.__ATW_TEST__;
    const base = hooks.buildPageMap();
    const group = {
      decisionGroupId: "dg_paid_item",
      selectedControlId: "ctrl_selected_item",
      selectedEvidence: {
        selected: true,
        selectedControlId: "ctrl_selected_item",
        disposition: "paid",
        structuredPrice: { amount: 40, currency: "EUR" }
      }
    };
    const before = {
      ...base,
      controls: [{
        controlId: "ctrl_selected_item",
        decisionGroupId: "dg_paid_item",
        selected: true,
        state: { selected: true }
      }],
      decisionGroups: [group],
      transactionFacts: {
        selectedExtras: [{
          decisionGroupId: "dg_paid_item",
          disposition: "paid",
          priceAmount: 40,
          currency: "EUR"
        }]
      },
      foreground: { progressMarkers: { flightOrdinal: "1/2", selectedText: "5E" } },
      price: { amount: 410, currency: "EUR" },
      validationIssues: []
    };
    const after = {
      ...base,
      controls: [{
        controlId: "ctrl_selected_item",
        decisionGroupId: "dg_paid_item",
        selected: false,
        state: { selected: false }
      }],
      // This intentionally reproduces the stale incremental group snapshot
      // from the live trace. Fresh control and transaction truth wins.
      decisionGroups: [group],
      transactionFacts: { selectedExtras: [] },
      foreground: { progressMarkers: { flightOrdinal: "1/2", selectedText: "Not selected" } },
      price: { amount: 370, currency: "EUR" },
      validationIssues: []
    };
    return hooks.verifyExpectedOutcome({
      type: "policy_conflict_resolved",
      decisionGroupId: "dg_paid_item",
      controlId: "ctrl_owned_correction",
      semanticOwnershipLinkId: "ownership_paid_to_correction",
      intendedOutcome: "remove_unapproved_paid_item",
      beforePriceAmount: 410
    }, before, after, null);
  });

  expect(result.ok).toBe(true);
  expect(result.code).toBe("POLICY_CONFLICT_RESOLVED");
  expect(result.evidence.afterConflictMetadata).toBe(true);
  expect(result.evidence.afterConflict).toBe(false);
  expect(result.evidence.selectedItemCleared).toBe(true);
  expect(result.evidence.chargeCleared).toBe(true);
  expect(result.evidence.afterPriceAmount).toBe(370);
});

test("reused modal progress plus a manual paid selection is reconciled and checkout continues without handoff", async ({ page }) => {
  await loadHtmlProducer(page, `
    <main>
      <h1>Configure journey</h1>
      <p>Total <span id="total">200 EUR</span></p>
      <p id="after-stage" hidden>Configuration completed</p>
    </main>
    <section id="workflow-modal" role="dialog" aria-modal="true" aria-labelledby="workflow-title">
      <h2 id="workflow-title">Journey configuration</h2>
      <p id="workflow-progress">Flight 1 of 2</p>
      <div id="workflow-first">
        <p>Review the first part of this configuration.</p>
        <button id="advance-internal" type="button">Proceed</button>
      </div>
      <form id="workflow-second" hidden>
        <fieldset aria-label="Optional service">
          <legend>Optional service</legend>
          <label><input id="service-paid" type="radio" name="service" required> Enhanced option — 25 EUR</label>
          <label><input id="service-free" type="radio" name="service" checked required> Basic option — 0 EUR</label>
        </fieldset>
        <button id="complete-surface" type="submit">Finish configuration</button>
      </form>
    </section>
    <script>
      window.__genericFlow = { paidSelections: 0, corrections: 0, completions: 0 };
      document.getElementById("advance-internal").addEventListener("click", () => {
        document.getElementById("workflow-progress").textContent = "Flight 2 of 2";
        document.getElementById("workflow-first").hidden = true;
        document.getElementById("workflow-second").hidden = false;
      });
      document.getElementById("service-paid").addEventListener("change", (event) => {
        if (!event.target.checked) return;
        window.__genericFlow.paidSelections += 1;
        document.getElementById("total").textContent = "225 EUR";
      });
      document.getElementById("service-free").addEventListener("change", (event) => {
        if (!event.target.checked) return;
        window.__genericFlow.corrections += 1;
        document.getElementById("total").textContent = "200 EUR";
      });
      document.getElementById("workflow-second").addEventListener("submit", (event) => {
        event.preventDefault();
        if (!document.getElementById("service-free").checked) return;
        window.__genericFlow.completions += 1;
        document.getElementById("workflow-modal").hidden = true;
        document.getElementById("after-stage").hidden = false;
      });
    </script>
  `);

  const traveler = { id: "trav_reconcile_modal", booking_rules: "Decline all paid extras" };
  let state = createCheckoutSessionState({
    goal: "Continue checkout without paid extras",
    travelerId: traveler.id,
    site: { host: "example.test", url: page.url() }
  });
  state.id = "txn_reconcile_reused_modal";
  state.approvals.skipPaidExtrasApproved = true;
  const store = inMemoryGovernorStore();
  const decisions = [];
  const nextTurn = async (observation, turnId) => {
    store.remember(state.id, observation);
    const turn = await runLoopTurn({
      apiKey: "",
      model: "must-not-be-called",
      dataDir: "",
      state,
      observation,
      traveler,
      transactionStore: store,
      clientTurnId: turnId
    });
    state = turn.state;
    decisions.push(turn.clientDecision);
    return turn;
  };

  const initial = await browserObservation(page, "obs_reused_modal_1");
  const firstTurn = await nextTurn(initial, "turn_reused_modal_1");
  expect(firstTurn.clientDecision.action, JSON.stringify({
    decision: firstTurn.clientDecision,
    currentGoal: firstTurn.state.taskState?.currentGoal,
    ambiguityReason: firstTurn.state.taskState?.ambiguityReason,
    decisions: firstTurn.state.taskState?.observedDecisions,
    controls: initial.page.controls.map((control) => ({
      controlId: control.controlId,
      label: control.label,
      semantic: control.semantic,
      physicalEffect: control.physicalEffect,
      decisionGroupId: control.decisionGroupId
    })),
    stageExit: initial.page.stageExit,
    surface: initial.page.currentSurface
  }, null, 2)).toBe("click");
  const firstExecution = await executeAtomicBrowserDecision(page, firstTurn.clientDecision, "obs_reused_modal_2");
  expect(firstExecution.verification.ok, firstExecution.verification.code).toBe(true);
  expect(await page.locator("#workflow-modal").getAttribute("id")).toBe("workflow-modal");
  expect(await page.locator("#workflow-progress").textContent()).toContain("2 of 2");

  // This mutation is intentionally outside the dispatched action. The next
  // fresh observation, not the old prediction, must become authoritative.
  await page.evaluate(() => {
    const paid = document.getElementById("service-paid");
    paid.checked = true;
    paid.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const interfered = await browserObservation(page, "obs_reused_modal_manual_paid");
  interfered.previousObservation = initial;
  interfered.lastActionResult = firstExecution.result;
  const correctionTurn = await nextTurn(interfered, "turn_reused_modal_correction");
  expect(correctionTurn.clientDecision.action).toBe("click");
  expect(correctionTurn.clientDecision.controlId).not.toBe(firstTurn.clientDecision.controlId);
  expect(correctionTurn.state.taskState.currentObligation).toMatchObject({
    subject: { decisionGroupId: expect.any(String) },
    desiredEffect: expect.stringMatching(/remove|free|decline/),
    policyDecision: expect.objectContaining({ status: "admitted", profileCompatible: true })
  });
  const correction = await executeAtomicBrowserDecision(page, correctionTurn.clientDecision, "obs_reused_modal_corrected");
  expect(correction.verification.ok, correction.verification.code).toBe(true);
  expect(await page.locator("#service-free").isChecked()).toBe(true);
  expect(await page.locator("#total").textContent()).toContain("200 EUR");

  correction.observation.previousObservation = interfered;
  const continueTurn = await nextTurn(correction.observation, "turn_reused_modal_continue");
  expect(continueTurn.clientDecision.action, JSON.stringify({
    decision: continueTurn.clientDecision,
    taskState: continueTurn.state.taskState,
    debug: continueTurn.debug,
    groups: correction.observation.page.decisionGroups,
    controls: correction.observation.page.controls
  }, null, 2)).toBe("click");
  const completed = await executeAtomicBrowserDecision(page, continueTurn.clientDecision, "obs_reused_modal_completed");
  expect(completed.verification.ok, completed.verification.code).toBe(true);
  expect(await page.locator("#workflow-modal").isHidden()).toBe(true);
  expect(await page.evaluate(() => window.__genericFlow)).toEqual({
    paidSelections: 1,
    corrections: 1,
    completions: 1
  });
  expect(decisions.some((decision) => decision.action === "ask_user")).toBe(false);
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
        <button id="flex-opener" type="button" role="combobox" aria-label="Flexible Ticket" aria-haspopup="listbox" aria-controls="flex-options" aria-expanded="false" aria-required="true">Select one option</button>
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
          location.hash = "payment";
          document.querySelector("h1").textContent = "Payment details";
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
    const requirements = legacyRequirementReplay.requirementsWithDecisionGroups([], observation);
    const taskState = reduceTaskState({
      previousTaskState: state.taskState || {},
      observation,
      previousActionResult: observation.lastActionResult || null,
      userPolicy: state.approvals,
      traveler
    });
    const goal = taskState.currentGoal;
    expect(goal, JSON.stringify({
      taskState,
      controls: observation.page.controls.map((control) => ({
        label: control.label,
        fieldType: control.fieldType,
        operations: control.operations
      }))
    }, null, 2)).toBeTruthy();
    const scopedState = { ...state, taskState };
    const candidateSet = groundedObservationCandidateSet(goal, observation, [], {
      state: scopedState,
      traveler,
      approvals: state.approvals
    });
    const candidates = candidateSet.candidates;
    const authoritativeTaskState = {
      ...taskState,
      currentGoal: { ...goal, candidateSet, candidates }
    };
    state = {
      ...scopedState,
      taskState: authoritativeTaskState,
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
  const flexibleGroup = observation.page.decisionGroups.find(
    (group) => group.sectionType === "flexible_ticket"
  );
  expect(flexibleGroup).toBeTruthy();
  expect(flexiblePrepared.goal).toMatchObject({
    decisionGroupId: flexibleGroup.decisionGroupId,
    requirementId: flexibleGroup.requirementId,
    // Before the listbox opens, the observer has proven a required choice but
    // has not yet observed its paid/free alternatives. Do not invent a free
    // option; the fresh options surface will supply that exact transition.
    desiredPolicyOutcome: "selected_policy_allowed_option"
  });
  expect(flexiblePrepared.goal.eligibleAlternativeControlIds).toEqual(
    flexibleGroup.alternativeControlIds
  );
  expect(
    flexiblePrepared.candidates.every(
      (candidate) => candidate.decisionGroupId === flexibleGroup.decisionGroupId
    )
  ).toBe(true);
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
  const staleRecovery = loopPrivate.updateExecutionRecovery(state, {
    kind: "grounding_rejection",
    code: staleGovernance.code
  });
  expect(staleRecovery.classification).toBe("grounding_rejection");
  expect(staleRecovery.recovery.attempts).toBe(0);
  expect(staleRecovery.exhausted).toBe(false);
  state = staleRecovery.state;

  const currentOpenCandidate = flexiblePrepared.candidates.find((candidate) => (
    candidate.operation === "open" && /flexible ticket/i.test(candidate.targetLabel)
  ));
  expect(currentOpenCandidate, JSON.stringify(flexiblePrepared.candidateSet.contextCapabilities.map((item) => ({
    label: item.targetLabel,
    operation: item.operation,
    controlId: item.controlId,
    physicalEffect: item.physicalEffect,
    goalRelevant: item.goalRelevant,
    selectable: item.selectable,
    exclusionReason: item.exclusionReason,
    risk: item.risk,
    policy: item.policyDecision
  })), null, 2)).toBeTruthy();
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
  expect(chosen.verification.code).toMatch(/EXACT_FREE_OPTION_VERIFIED|POLICY_SAFE_CHOICE_ADVANCED/);
  expect(chosen.verification.evidence.selectedControlId).toBe(chosen.verification.evidence.expectedControlId);
  expect(chosen.verification.evidence.semanticDispositionVerified).toBe(true);
  expect(chosen.verification.evidence.paidAlternativesSelected).toEqual([]);
  expect(chosen.verification.evidence.priceDidNotIncrease).toBe(true);
  expect(chosen.verification.evidence.ownedValidationErrors).toEqual([]);
  expect(await page.locator("#flex-options").isVisible()).toBe(false);
  expect(await page.locator("#flex-opener").textContent()).toContain("None of the passengers");
  expect(await page.locator("body").getAttribute("data-stage")).toBeNull();

  await executeCandidate(
    observation,
    (candidate) => /continue/i.test(candidate.targetLabel),
    "obs_replay_continued"
  );
  expect(await page.locator("body").getAttribute("data-stage")).toBe("continued");
  expect(history.some((entry) => entry.type === "ask_user")).toBe(false);
});

test("DOM-grounded observations do not request a screenshot", async ({ page }) => {
  await loadHtmlProducer(page, `<main><button id="continue" type="button">Continue</button></main>`);
  const result = await page.evaluate(() => {
    const map = window.__ATW_TEST__.buildPageMap();
    return {
      screenshotRequired: window.__ATW_TEST__.observationNeedsScreenshot(map),
      controlCount: map.controls.length
    };
  });
  expect(result.controlCount).toBeGreaterThan(0);
  expect(result.screenshotRequired).toBe(false);
});

test("persistent page state incrementally refreshes an owned selection and ignores unrelated layout churn", async ({ page }) => {
  await loadHtmlProducer(page, `
    <main>
      <h1>Optional extras</h1>
      <div id="animation-layer">decorative</div>
      <label><input id="free" type="radio" name="extra"> No thanks</label>
      <label><input id="paid" type="radio" name="extra"> Upgrade — 30 EUR</label>
      <button id="continue" type="button">Continue</button>
    </main>
  `);
  const result = await page.evaluate(() => {
    const hooks = window.__ATW_TEST__;
    const initial = hooks.observePageState({ forceFull: true, reason: "test_initial" });
    const free = document.getElementById("free");
    free.checked = true;
    hooks.notePageEvent({ type: "change", target: free });
    const incremental = hooks.observePageState({ reason: "test_selection" });
    const selected = incremental.map.controls.find((control) => control.stateElementId === free.dataset.atwElementId);
    const decorative = document.getElementById("animation-layer");
    decorative.style.transform = "translateX(1px)";
    const irrelevant = hooks.mutationMayBeMaterial({ type: "attributes", target: decorative, attributeName: "style" });
    const cached = hooks.observePageState({ reason: "test_animation" });
    return {
      initialMode: initial.mode,
      incrementalMode: incremental.mode,
      selected: Boolean(selected?.selected || selected?.state?.checked),
      stateChanges: incremental.diff.stateChanges.length,
      irrelevant,
      cachedMode: cached.mode,
      snapshotStable: incremental.snapshotHash === cached.snapshotHash
    };
  });
  expect(result).toEqual({
    initialMode: "full_snapshot",
    incrementalMode: "incremental",
    selected: true,
    stateChanges: 1,
    irrelevant: false,
    cachedMode: "cached",
    snapshotStable: true
  });
});

test("atomic observation discards a seat snapshot when Continue appears immediately after construction", async ({ page }) => {
  test.setTimeout(30_000);
  await loadHtmlProducer(page, `
    <style>
      body { font-family: sans-serif; padding: 24px; }
      #seat-map { display: grid; grid-template-columns: repeat(6, 52px); gap: 4px; }
      #seat-map button, #continue { width: 48px; height: 36px; }
      #continue { width: 140px; margin-top: 20px; }
    </style>
    <main>
      <h1>Seating</h1>
      <p>Select a seat on the map</p>
      <div id="seat-map" role="group" aria-label="Seat map">
        ${Array.from({ length: 190 }, (_, index) => `<button id="seat-${index}" type="button" aria-haspopup="dialog">${19 + (index % 5)} €</button>`).join("")}
      </div>
    </main>
    <aside aria-label="Future payment fields"><span>CVV security code</span></aside>
  `);
  const result = await page.evaluate(async () => {
    const hooks = window.__ATW_TEST__;
    hooks.setAppDataForTest({
      travelers: [{ id: "trav_atomic_seat", seat_policy: "random_assignment", booking_rules: "No paid seats" }]
    }, "trav_atomic_seat");
    setTimeout(() => {
      const button = document.createElement("button");
      button.id = "continue";
      button.type = "button";
      button.textContent = "Continue";
      const main = document.querySelector("main");
      main.appendChild(button);
      // Test mode does not install the production MutationObserver, so feed
      // the equivalent material record through the public state-store hook.
      hooks.notePageMutations([{ type: "childList", target: main, addedNodes: [button], removedNodes: [] }]);
    }, 200);
    const startedAt = performance.now();
    const observed = await hooks.observeFreshPageState({
      reason: "test_late_continue",
      maxWaitMs: 180,
      maxAttempts: 2,
      postBuildGraceMs: 250
    });
      const compact = hooks.compactPageMap(observed.map, "obs_late_continue");
      return {
        elapsedMs: performance.now() - startedAt,
        fresh: observed.fresh,
        attempts: observed.freshnessAttempts,
        mutationVersion: observed.mutationVersion,
        step: observed.map.step,
        compactStep: compact.step,
        continueLabels: observed.map.controls
          .filter((control) => /continue/i.test(control.label || ""))
          .map((control) => control.label),
        sourceButtons: observed.map.summary.sourceButtons,
        omittedButtons: observed.map.summary.perceptionOmittedButtons,
        controls: observed.map.controls.length,
        collections: observed.map.controlCollections
      };
  });
  expect(result.fresh).toBe(true);
  expect(result.elapsedMs, JSON.stringify(result)).toBeLessThan(10_000);
  expect(result.attempts, JSON.stringify(result)).toBe(2);
  expect(result.mutationVersion).toBeGreaterThan(0);
  expect(result.step).toBe("seats");
  expect(result.compactStep).toBe("seats");
  expect(result.continueLabels).toContain("Continue");
  expect(result.sourceButtons).toBeGreaterThan(180);
  expect(result.omittedButtons).toBeGreaterThan(150);
  expect(result.controls).toBeLessThan(30);
  expect(result.collections).toEqual([
    expect.objectContaining({
      type: "seat_inventory",
      profileMode: "random_assignment",
      totalCount: expect.any(Number),
      omittedCount: expect.any(Number)
    })
  ]);
});

test("split-node numeric seat inventory is structurally bounded before canonical compilation", async ({ page }) => {
  test.setTimeout(30_000);
  await loadHtmlProducer(page, `
    <style>
      body { font-family: sans-serif; }
      #seat-map { display: grid; grid-template-columns: repeat(6, 96px); gap: 4px; }
      .seat { display: grid; grid-template-columns: 48px 40px; gap: 2px; }
      .seat button { width: 40px; height: 36px; }
      .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
    </style>
    <main>
      <h1>Seating</h1><p>Select a seat on the map</p>
      <div id="seat-map" role="grid" aria-label="Seat map">
        ${Array.from({ length: 190 }, (_, index) => {
          const row = Math.floor(index / 6) + 1;
          const column = String.fromCharCode(65 + (index % 6));
          return `<div class="seat">
            <span class="sr" id="seat-name-${index}">Seat ${row}${column} Standard</span>
            <button type="button" aria-haspopup="dialog">1688</button>
            <button type="button" aria-labelledby="seat-name-${index}" disabled></button>
          </div>`;
        }).join("")}
      </div>
      <button id="continue" type="button">Continue</button>
    </main>
  `);
  const result = await page.evaluate(() => {
    const hooks = window.__ATW_TEST__;
    hooks.setAppDataForTest({
      travelers: [{ id: "trav_split_seat", seat_policy: "random_assignment", booking_rules: "No paid seats" }]
    }, "trav_split_seat");
    const startedAt = performance.now();
    const map = hooks.buildPageMap();
    return {
      buildMs: performance.now() - startedAt,
      step: map.step,
      sourceButtons: map.summary.sourceButtons,
      omittedButtons: map.summary.perceptionOmittedButtons,
      controls: map.controls.length,
      labels: map.controls.map((control) => control.label),
      collections: map.controlCollections
    };
  });
  expect(result.step).toBe("seats");
  expect(result.sourceButtons).toBeGreaterThan(380);
  expect(result.omittedButtons).toBeGreaterThanOrEqual(380);
  expect(result.controls).toBeLessThan(30);
  expect(result.labels).toContain("Continue");
  expect(result.buildMs, JSON.stringify(result)).toBeLessThan(3_000);
  expect(result.collections).toEqual([
    expect.objectContaining({
      type: "seat_inventory",
      totalCount: 380,
      omittedCount: 380,
      profileMode: "random_assignment",
      source: "structural_pre_compilation_collection"
    })
  ]);
});

test("GoToGate-shaped foreground seat inventory shares the structural collection boundary", async ({ page }) => {
  test.setTimeout(30_000);
  await loadHtmlProducer(page, `
    <style>
      body { font-family: sans-serif; }
      #seat-dialog { position: fixed; inset: 20px; z-index: 20; background: white; overflow: auto; }
      #seat-map { display: grid; grid-template-columns: repeat(7, 72px); gap: 4px; }
      #seat-map button { width: 68px; height: 36px; }
      footer { position: sticky; bottom: 0; display: flex; gap: 12px; background: white; padding: 12px; }
    </style>
    <main><h1>Traveller information</h1></main>
    <div id="seat-dialog" role="dialog" aria-modal="true" aria-label="Reserve seating">
      <h2>Reserve seating Antalya – Istanbul</h2>
      <p>Flight 1 of 2 (AYT - SAW)</p>
      <p>Traveller information Ali SIFRAR — Not selected</p>
      <div id="seat-map" role="grid" aria-label="Seat map">
        ${Array.from({ length: 245 }, (_, index) => {
          const row = Math.floor(index / 7) + 1;
          const column = String.fromCharCode(65 + (index % 7));
          return `<button type="button" data-headlessui-state="" aria-label="Seat ${row}${column} — ${19 + (index % 4)} EUR">${row}${column}</button>`;
        }).join("")}
      </div>
      <footer>
        <button type="button">Back</button>
        <button id="seat-continue" type="button">Continue</button>
      </footer>
    </div>
  `);
  const result = await page.evaluate(() => {
    const hooks = window.__ATW_TEST__;
    hooks.setAppDataForTest({
      travelers: [{ id: "trav_foreground_random", seat_policy: "random_assignment", booking_rules: "No paid seats" }]
    }, "trav_foreground_random");
    const startedAt = performance.now();
    const randomMap = hooks.buildPageMap();
    const randomBuildMs = performance.now() - startedAt;
    hooks.setAppDataForTest({
      travelers: [{ id: "trav_foreground_window", seat_policy: "window", booking_rules: "Choose a window seat" }]
    }, "trav_foreground_window");
    const explicitMap = hooks.buildPageMap();
    return {
      randomBuildMs,
      random: {
        step: randomMap.step,
        surfaceType: randomMap.currentSurface.type,
        optionLabels: randomMap.currentSurface.options.map((option) => option.label),
        optionCount: randomMap.currentSurface.options.length,
        controls: randomMap.controls.length,
        collections: randomMap.controlCollections,
        surfaceCollections: randomMap.currentSurface.controlCollections || []
      },
      explicit: {
        optionCount: explicitMap.currentSurface.options.length,
        collections: explicitMap.controlCollections
      }
    };
  });
  expect(result.random.step).toBe("seats");
  expect(result.random.surfaceType).toBe("modal");
  expect(result.random.optionLabels).toEqual(expect.arrayContaining(["Continue", "Back"]));
  expect(result.random.optionCount).toBeLessThan(12);
  expect(result.random.controls).toBeLessThan(30);
  expect(result.random.collections).toEqual([
    expect.objectContaining({
      type: "seat_inventory",
      surfaceId: expect.any(String),
      totalCount: 245,
      omittedCount: 245,
      profileMode: "random_assignment",
      source: "structural_pre_compilation_collection"
    })
  ]);
  expect(result.random.surfaceCollections).toEqual(result.random.collections);
  expect(result.randomBuildMs, JSON.stringify(result)).toBeLessThan(3_000);
  expect(result.explicit.optionCount).toBeGreaterThan(240);
  expect(result.explicit.collections).toEqual([]);
});

test("GoToGate-shaped non-ARIA seat panel becomes the exclusive current surface", async ({ page }) => {
  await loadHtmlProducer(page, `
    <style>
      body { font-family: sans-serif; margin: 0; }
      main { padding: 32px; }
      main button, main input { margin: 8px; }
      #seat-panel {
        position: fixed;
        left: 22vw;
        top: 5vh;
        width: 56vw;
        height: 88vh;
        z-index: 40;
        padding: 24px;
        overflow: auto;
        background: white;
        box-shadow: 0 0 0 9999px rgba(0, 0, 0, .45);
      }
      #seat-grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 6px; }
      #seat-panel footer { position: sticky; bottom: 0; display: flex; gap: 12px; background: white; padding: 16px 0; }
    </style>
    <main>
      <h1>Traveller information</h1>
      <input value="Ali" disabled>
      <button type="button" disabled>Continue</button>
      <label><input type="radio" name="seatmap" checked disabled> Add to cart</label>
      <label><input type="radio" name="seatmap" disabled> No thanks</label>
    </main>
    <div id="seat-panel" aria-label="Reserve seating">
      <button id="close-seat" type="button">Close window</button>
      <h2>Reserve seating Antalya – Istanbul</h2>
      <p>Flight 1 of 2 (AYT - SAW)</p>
      <p>Ali SIFRAR — Not selected</p>
      <label><input id="seat-mode-paid" type="radio" name="current-seat-mode" checked disabled> Add to cart</label>
      <label><input id="seat-mode-free" type="radio" name="current-seat-mode" disabled> No thanks</label>
      <div id="seat-grid">
        ${Array.from({ length: 36 }, (_, index) => `<button type="button">Seat ${index + 1} — 9 EUR</button>`).join("")}
      </div>
      <button id="hidden-skip" type="button" style="display:none">Skip seat selection</button>
      <footer>
        <button id="seat-back" type="button">Back</button>
        <button id="seat-next" type="button">Next</button>
      </footer>
    </div>
  `);

  const traveler = {
    id: "trav_non_aria_seat",
    seat_policy: "random_assignment",
    booking_rules: "No paid seats"
  };
  const result = await page.evaluate((profile) => {
    const hooks = window.__ATW_TEST__;
    hooks.setAppDataForTest({
      travelers: [profile]
    }, profile.id);
    const full = hooks.observePageState({ forceFull: true, reason: "gotogate_integrated_full" });
    const map = full.map;
    const compact = hooks.compactPageMap(map, "obs_non_aria_seat");
    const next = map.controls.find((control) => control.label === "Next");
    const backgroundContinue = map.controls.find((control) => control.label === "Continue");
    const paidMode = map.controls.find((control) => /add to cart/i.test(control.label || "") && control.surfaceId === map.currentSurface.id);
    hooks.notePageEvent({ type: "change", target: document.getElementById("seat-next") });
    const incremental = hooks.observePageState({ reason: "gotogate_integrated_incremental" });
    const referencePayload = hooks.referenceObservationTransport({
      sessionId: "session_non_aria_seat",
      observationId: "obs_non_aria_seat_reference",
      observationUpdate: {
        mode: "reference",
        baseSnapshotHash: incremental.snapshotHash,
        snapshotHash: incremental.snapshotHash,
        material: false
      },
      page: hooks.compactPageMap(incremental.map, "obs_non_aria_seat_reference")
    });
    return {
      step: map.step,
      currentSurface: map.currentSurface,
      fullStageExit: map.stageExit,
      incrementalMode: incremental.mode,
      incrementalStageExit: incremental.map.stageExit,
      transportBytes: hooks.observationTransportBytes({ page: compact }),
      referenceBytes: hooks.observationTransportBytes(referencePayload),
      paidMode: paidMode ? {
        effectRole: paidMode.effectRole,
        selected: paidMode.selected === true || paidMode.state?.checked === true
      } : null,
      selectedExtras: map.transactionFacts?.selectedExtras || [],
      next: next ? {
        surfaceId: next.surfaceId,
        executable: Object.values(next.operations || {}).some((operation) => operation.actionability?.executable === true)
      } : null,
      backgroundContinue: backgroundContinue ? { surfaceId: backgroundContinue.surfaceId } : null
    };
  }, traveler);

  expect(result.step).toBe("seats");
  expect(result.currentSurface).toMatchObject({
    type: "popover",
    blocksBackground: true
  });
  expect(result.currentSurface.id).not.toBe("surface-page");
  expect(result.fullStageExit.surfaceAuthority).toMatchObject({
    currentSurfaceId: result.currentSurface.id,
    blocksBackground: true
  });
  expect(result.incrementalMode).toBe("incremental");
  expect(result.incrementalStageExit.surfaceAuthority).toEqual(result.fullStageExit.surfaceAuthority);
  expect(result.incrementalStageExit.blockers).not.toContain("visible overlay/menu/modal");
  expect(result.transportBytes).toBeLessThan(500_000);
  expect(result.referenceBytes).toBeLessThan(2_000);
  expect(result.paidMode).toEqual({ effectRole: "presentation_mode", selected: true });
  expect(result.selectedExtras.some((item) => item.decisionGroupId && /add to cart/i.test(item.label || ""))).toBe(false);
  expect(result.next).toEqual({
    surfaceId: result.currentSurface.id,
    executable: true
  });
  expect(result.backgroundContinue?.surfaceId).toBe("surface-page");

  const observation = await browserObservation(page, "obs_non_aria_seat_contract");
  const taskState = reduceTaskState({
    observation,
    traveler,
    userPolicy: { bookingRules: traveler.booking_rules, seatPolicy: traveler.seat_policy }
  });
  const candidates = buildCurrentCandidateSet({
    goal: taskState.currentGoal,
    observation,
    traveler,
    state: { taskState, approvals: {} }
  }).candidates;
  const next = observation.page.controls.find((control) => control.label === "Next");
  expect(taskState.disposition.kind).toBe("execute");
  expect(taskState.currentObligation?.admittedControlIds).toContain(next.controlId);
  expect(
    candidates.some((candidate) => candidate.controlId === next.controlId),
    JSON.stringify({ goal: taskState.currentGoal, obligation: taskState.currentObligation, candidates, next }, null, 2)
  ).toBe(true);
});

test("nested seat chooser keeps parent paid intent pending and grounds the exact free decline", async ({ page }) => {
  await loadHtmlProducer(page, `
    <style>
      body { font-family: sans-serif; }
      #seat-owner { width: 720px; min-height: 140px; padding: 16px; border: 1px solid #aaa; }
      #seat-dialog { position: fixed; inset: 24px; z-index: 20; background: white; padding: 20px; }
      #seat-grid { display: grid; grid-template-columns: repeat(6, 56px); gap: 4px; }
      #seat-grid button { height: 36px; }
    </style>
    <main>
      <h1>Seat selection</h1>
      <section id="seat-owner" aria-label="Seat reservations">
        <h2>Seat reservations</h2>
        <label><input id="seat-intent-paid" type="radio" name="seatmap" checked disabled> Add to cart</label>
        <label><input id="seat-intent-free" type="radio" name="seatmap" disabled> No thanks</label>
        <button id="change-seats" type="button" aria-expanded="true" aria-controls="seat-dialog">Change seats</button>
      </section>
    </main>
    <div id="seat-dialog" role="dialog" aria-modal="true" aria-label="Reserve seating">
      <h2>Reserve seating Antalya – Istanbul</h2>
      <p>Flight 1 of 2 (AYT - SAW)</p>
      <p>Traveller information Ali SIFRAR — Not selected</p>
      <button id="seat-information" type="button" data-testid="seat-characteristic-panel"
        aria-expanded="false" aria-controls="seat-information-details">Standard seat From 9 EUR</button>
      <div id="seat-information-details">Your regular one-size-fits-all airplane seat. Just the basics.</div>
      <div id="seat-grid" role="grid" aria-label="Seat map">
        ${Array.from({ length: 18 }, (_, index) => `<button type="button">Seat ${index + 1} — 9 EUR</button>`).join("")}
      </div>
      <button id="skip-seat" type="button">Skip seat selection</button>
      <button id="seat-next" type="button">Next</button>
    </div>
  `);

  const observation = await browserObservation(page, "obs_nested_seat_pending");
  const traveler = {
    id: "trav_nested_seat_pending",
    seat_policy: "random_assignment",
    booking_rules: "No paid seats and no paid extras"
  };
  const parentDecision = observation.page.decisionGroups.find((group) => (
    group.selectedControlId
    && /add to cart/i.test(group.selectedLabel || "")
  ));
  const foregroundDecision = observation.page.decisionGroups.find((group) => (
    group.surfaceId === observation.page.currentSurface.id
  ));
  const informationControl = observation.page.controls.find((control) => (
    /standard seat from 9 eur/i.test(control.label || "")
  ));
  const skipControl = observation.page.controls.find((control) => (
    /skip seat selection/i.test(control.label || "")
  ));

  expect(parentDecision, JSON.stringify(observation.page.decisionGroups, null, 2)).toBeTruthy();
  expect(foregroundDecision).toMatchObject({ sectionType: "seat" });
  expect(foregroundDecision.alternatives.map((option) => option.controlId)).toContain(skipControl.controlId);
  expect(informationControl).toMatchObject({
    semantic: "reveal_information",
    physicalEffect: "open_surface"
  });

  const taskState = reduceTaskState({ observation, traveler });
  const canonicalParent = taskState.canonicalDecisions.find((decision) => (
    decision.decisionGroupId === parentDecision.decisionGroupId
  ));
  expect(canonicalParent).toMatchObject({
    family: "seat",
    commitmentPhase: "option_pending",
    currentOutcome: "option_pending",
    status: "pending"
  });
  expect(taskState.currentGoal).toMatchObject({
    semanticType: "seat_selection",
    desiredSemanticOutcome: "random_assignment"
  });
  expect(taskState.currentGoal.policyAllowedControlIds).toContain(skipControl.controlId);

  const candidateSet = buildCurrentCandidateSet({
    goal: taskState.currentGoal,
    observation,
    traveler,
    state: { taskState, approvals: {} }
  });
  expect(candidateSet.candidates.some((candidate) => candidate.controlId === skipControl.controlId)).toBe(true);
  expect(candidateSet.candidates.some((candidate) => candidate.controlId === informationControl.controlId)).toBe(false);

  const transaction = prepareTransactionInvariants({}, observation, traveler);
  expect(transaction.envelope.current.selectedExtras.some((extra) => (
    extra.decisionGroupId === parentDecision.decisionGroupId
  ))).toBe(false);
  expect(transaction.envelope.outcomeLedger.some((extra) => (
    extra.decisionGroupId === parentDecision.decisionGroupId
  ))).toBe(false);
});

test("one seat decision episode survives two unselected legs and the final confirmation", async ({ page }) => {
  await loadHtmlProducer(page, `
    <style>[hidden] { display: none !important; } [role="dialog"] { position: fixed; inset: 30px; z-index: 20; background: white; }</style>
    <main>
      <h1>Traveller information</h1>
      <section aria-label="Seat reservations">
        <h2>Seat reservations</h2>
        <label><input id="seat-parent-paid" type="radio" name="seatmap" checked disabled> Add to cart</label>
        <label><input id="seat-parent-free" type="radio" name="seatmap" disabled> No thanks</label>
      </section>
      <p id="success" hidden>Customize your trip</p>
    </main>
    <section id="seat-map" role="dialog" aria-modal="true" aria-label="Reserve seating">
      <h2>Reserve seating</h2>
      <p id="flight-marker">Flight 1 of 2 (AYT - IST)</p>
      <p>Traveller information Ali SIFRAR — Not selected</p>
      <button type="button">Seat 1A — 19 EUR</button>
      <button id="seat-next" type="button">Next</button>
    </section>
    <section id="seat-confirm" role="dialog" aria-modal="true" aria-label="Are you sure?" hidden>
      <h2>Are you sure?</h2>
      <p>You haven't selected a seat for parts of your trip.</p>
      <ul><li>Antalya AYT–Istanbul IST</li><li>Istanbul IST–Antalya AYT</li></ul>
      <button id="seat-continue" type="button">Continue</button>
      <button id="choose-seat" type="button">Choose seat</button>
    </section>
    <script>
      window.__seatStep = 1;
      document.getElementById("seat-next").addEventListener("click", () => {
        if (window.__seatStep === 1) {
          window.__seatStep = 2;
          document.getElementById("flight-marker").textContent = "Flight 2 of 2 (IST - AYT)";
          return;
        }
        document.getElementById("seat-map").hidden = true;
        document.getElementById("seat-confirm").hidden = false;
      });
      document.getElementById("seat-continue").addEventListener("click", () => {
        document.getElementById("seat-confirm").hidden = true;
        document.getElementById("success").hidden = false;
      });
    </script>
  `);

  const traveler = {
    id: "trav_two_leg_seat",
    seat_policy: "random_assignment",
    booking_rules: "No paid seats and no paid extras"
  };
  const policy = { bookingRules: traveler.booking_rules };
  const verifiedAdvance = (episode, controlId = "seat_next") => ({
    dispatched: true,
    verified: true,
    expectedOutcomeObserved: true,
    postconditionSatisfied: true,
    action: {
      decisionEpisodeId: episode.episodeId,
      parentDecisionGroupId: episode.parentDecisionGroupId,
      decisionGroupId: "seat_child",
      controlId
    },
    expectedOutcome: { type: "active_surface_dismissed" }
  });

  let observation = await browserObservation(page, "obs_two_leg_seat_1");
  let taskState = reduceTaskState({ observation, userPolicy: policy, traveler });
  expect(taskState.decisionEpisode, JSON.stringify({
    surface: observation.page.currentSurface,
    groups: observation.page.decisionGroups,
    canonical: taskState.canonicalDecisions
  }, null, 2)).toMatchObject({
    family: "seat",
    subjectKey: "seat_assignment",
    commitmentPhase: "option_pending"
  });
  expect(taskState.decisionEpisode.episodeId).not.toMatch(/contact|country-code/);

  const firstResult = verifiedAdvance(taskState.decisionEpisode);
  await page.locator("#seat-next").click();
  observation = await browserObservation(page, "obs_two_leg_seat_2");
  taskState = reduceTaskState({
    previousTaskState: taskState,
    observation,
    previousActionResult: firstResult,
    userPolicy: policy,
    traveler
  });
  expect(taskState.decisionEpisode.episodeId).toBe(firstResult.action.decisionEpisodeId);
  expect(taskState.decisionEpisode.segmentOutcomes).toHaveLength(1);

  const secondResult = verifiedAdvance(taskState.decisionEpisode);
  await page.locator("#seat-next").click();
  observation = await browserObservation(page, "obs_two_leg_seat_confirm");
  const beforeFinal = prepareTransactionInvariants({
    taskState,
    userPolicy: policy
  }, observation, traveler);
  expect(beforeFinal.observed.selectedExtras.some((extra) => extra.family === "seat")).toBe(false);

  taskState = reduceTaskState({
    previousTaskState: taskState,
    observation,
    previousActionResult: secondResult,
    userPolicy: policy,
    traveler,
    transactionReview: beforeFinal.review
  });
  expect(taskState.decisionEpisode).toMatchObject({
    family: "seat",
    commitmentPhase: "confirmation_pending"
  });
  expect(taskState.decisionEpisode.segmentOutcomes).toHaveLength(2);

  const finalResult = verifiedAdvance(taskState.decisionEpisode, "seat_continue");
  await page.locator("#seat-continue").click();
  observation = await browserObservation(page, "obs_two_leg_seat_complete");
  taskState = reduceTaskState({
    previousTaskState: taskState,
    observation,
    previousActionResult: finalResult,
    userPolicy: policy,
    traveler
  });
  expect(taskState.decisionEpisode).toMatchObject({
    family: "seat",
    status: "completed",
    commitmentPhase: "committed_free",
    terminalOutcome: {
      outcome: "random_assignment",
      disposition: "declined",
      priceAmount: 0
    }
  });
  expect(taskState.outcomeJournal).toHaveLength(1);
  expect(taskState.outcomeJournal[0]).toMatchObject({
    family: "seat",
    outcome: "random_assignment",
    verified: true
  });
  expect(taskState.outcomeJournal[0].segmentOutcomes).toHaveLength(2);

  const completedFacts = prepareTransactionInvariants({
    taskState,
    userPolicy: policy
  }, observation, traveler);
  const seatOutcomes = completedFacts.observed.selectedExtras.filter((extra) => extra.family === "seat");
  expect(seatOutcomes).toHaveLength(1);
  expect(seatOutcomes[0]).toMatchObject({
    outcome: "random_assignment",
    disposition: "declined",
    priceAmount: 0
  });
});

test("explicit seat preference retains the full visible seat collection", async ({ page }) => {
  await loadHtmlProducer(page, `
    <style>#seat-map { display: grid; grid-template-columns: repeat(6, 52px); gap: 4px; } #seat-map button { width: 48px; height: 36px; }</style>
    <main>
      <h1>Seating</h1><p>Select a seat on the map</p>
      <div id="seat-map" role="group" aria-label="Seat map">
        ${Array.from({ length: 130 }, (_, index) => `<button type="button" aria-haspopup="dialog">${19 + (index % 5)} €</button>`).join("")}
      </div>
      <button type="button">Continue</button>
    </main>
    <aside aria-label="Future payment fields"><span>CVV security code</span></aside>
  `);
  const result = await page.evaluate(() => {
    const hooks = window.__ATW_TEST__;
    hooks.setAppDataForTest({
      travelers: [{ id: "trav_window_seat", seat_policy: "window", booking_rules: "Choose a window seat" }]
    }, "trav_window_seat");
    const map = hooks.buildPageMap();
    return {
      step: map.step,
      sourceButtons: map.summary.sourceButtons,
      omittedButtons: map.summary.perceptionOmittedButtons,
      controls: map.controls.length,
      collections: map.controlCollections
    };
  });
  expect(result.step).toBe("seats");
  expect(result.sourceButtons).toBeGreaterThan(120);
  expect(result.omittedButtons).toBe(0);
  expect(result.controls).toBeGreaterThan(120);
  expect(result.collections).toEqual([]);
});

test("foreground site failure suspends background profile work and stops without recovery navigation", async ({ page }) => {
  await loadHtmlProducer(page, `
    <main>
      <h1>Traveler information</h1>
      <label>First name <input name="first_name"></label>
      <label>Email <input name="email" type="email"></label>
    </main>
    <div role="dialog" aria-modal="true" aria-label="Checkout error">
      <h2>Something went wrong on our end</h2>
      <p>Please go back to search and try again. Visitor ID 123.</p>
      <button type="button">Report error</button>
      <button type="button">Back to search</button>
    </div>
  `);
  await page.evaluate(() => window.__ATW_TEST__.setAppDataForTest({
    travelers: [{ id: "trav_site_failure", first_name: "Ali", email: "ali@example.test" }]
  }, "trav_site_failure"));
  const observation = await browserObservation(page, "obs_site_failure");
  const traveler = { id: "trav_site_failure", first_name: "Ali", email: "ali@example.test" };
  const taskState = reduceTaskState({ observation, traveler });
  expect(observation.page.currentSurface.surfaceClass).toBe("site_failure");
  expect(taskState.siteFailure).toEqual(expect.objectContaining({ active: true }));
  expect(taskState.currentGoal).toBeNull();
  expect(taskState.profileReadiness.ready).toBe(false);

  const state = createCheckoutSessionState({
    goal: "Reach payment review safely",
    travelerId: traveler.id,
    site: { host: "example.test", url: observation.page.url }
  });
  state.id = "txn_site_failure";
  const store = inMemoryGovernorStore();
  store.remember(state.id, observation);
  const stopped = await runLoopTurn({
    apiKey: "",
    model: "must-not-be-called",
    dataDir: "",
    state,
    observation,
    traveler,
    transactionStore: store,
    clientTurnId: "turn_site_failure"
  });
  expect(stopped.clientDecision.action).toBe("stop");
  expect(stopped.clientDecision.intent).toBe("site_failure_observed");
  expect(stopped.clientDecision.reason).toContain("SITE_FAILURE_OBSERVED");
  expect(stopped.state.status).toBe("stopped");
});

test("a harmless rerender safely rebinds the same stable control without label search", async ({ page }) => {
  await loadHtmlProducer(page, `<main><button id="continue" data-testid="primary-advance" type="button">Continue</button></main>`);
  const result = await page.evaluate(() => {
    const hooks = window.__ATW_TEST__;
    const before = hooks.observePageState({ forceFull: true, reason: "test_before_rerender" }).map;
    const control = before.controls.find((item) => item.testId === "primary-advance");
    const oldElementId = control.stateElementId;
    const oldButton = document.getElementById("continue");
    const replacement = oldButton.cloneNode(true);
    replacement.removeAttribute("data-atw-element-id");
    replacement.removeAttribute("data-atw-control-id");
    oldButton.replaceWith(replacement);
    hooks.notePageMutations([{ type: "childList", target: replacement.parentElement, addedNodes: [replacement], removedNodes: [oldButton] }]);
    const after = hooks.observePageState({ reason: "test_after_rerender" });
    const rebound = hooks.resolveDecisionTarget({
      action: "click",
      operation: "activate",
      controlId: control.controlId,
      stableKey: control.stableKey,
      targetId: oldElementId,
      targetSnapshot: control
    }, after.map);
    return {
      mode: after.mode,
      sameControlId: after.map.controls.some((item) => item.controlId === control.controlId),
      reboundIsReplacement: rebound === replacement,
      newElementId: rebound?.dataset?.atwElementId || "",
      oldElementId
    };
  });
  expect(result.mode).toBe("material_rescan");
  expect(result.sameControlId).toBe(true);
  expect(result.reboundIsReplacement).toBe(true);
  expect(result.newElementId).not.toBe(result.oldElementId);
});

test("oversized canonical transport summarizes repeated controls and preserves task controls", async ({ page }) => {
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
  expect(received.page.controls.length).toBeLessThan(80);
  expect(received.page.controlCollections).toEqual([
    expect.objectContaining({
      type: "seat_inventory",
      totalCount: 350,
      omittedCount: expect.any(Number)
    })
  ]);
  expect(received.page.controlCollections[0].omittedCount).toBeGreaterThan(250);
  expect(received.page.sections[0].controlIds).toHaveLength(received.page.controls.length);
  expect(received.page.currentSurface.memberControlIds).toHaveLength(received.page.controls.length);
  expect(received.page.summary.title).toHaveLength(200);
});

test("Kiwi-sized random-seat observation remains bounded and preserves Continue", async ({ page }) => {
  await loadHtmlProducer(page, `<main><button type="button">Continue</button></main>`);
  const result = await page.evaluate(() => {
    const hooks = window.__ATW_TEST__;
    const heavyProof = "proof".repeat(1200);
    const seats = Array.from({ length: 490 }, (_, index) => ({
      controlId: `ctrl_seat_${index + 1}`,
      label: `Seat ${Math.floor(index / 6) + 1}${String.fromCharCode(65 + (index % 6))} — ${1000 + index} TL`,
      kind: "button",
      semantic: "choice",
      physicalEffect: "select_paid_option",
      risk: "money",
      decisionGroupId: "dg_seat_inventory",
      sectionId: "section_seats",
      sectionType: "seat",
      surfaceId: "surface-page",
      state: { disabled: index < 239, selected: false },
      structuredPrice: { amount: 1000 + index, currency: "TRY" },
      operations: { choose: { actuatorId: `seat_${index + 1}`, proof: heavyProof } },
      recovery: { choose: { strategies: [{ actuatorId: `seat_${index + 1}`, proof: heavyProof }] } },
      visualRegions: [{ x: index % 6 * 40, y: Math.floor(index / 6) * 40, width: 32, height: 32 }]
    }));
    const continueControl = {
      controlId: "ctrl_continue",
      label: "Continue",
      kind: "button",
      semantic: "continue",
      physicalEffect: "advance_checkout_stage",
      risk: "safe_continue",
      sectionId: "section_seats",
      sectionType: "seat",
      surfaceId: "surface-page",
      operations: { activate: { actuatorId: "continue" } }
    };
    const page = {
      step: "seats",
      controls: [...seats, continueControl],
      controlAliases: [...seats, continueControl].map((control) => ({ aliasId: control.controlId, controlId: control.controlId })),
      decisionGroups: [{
        decisionGroupId: "dg_seat_inventory",
        sectionId: "section_seats",
        sectionType: "seat",
        required: false,
        status: "missing",
        alternativeControlIds: seats.map((control) => control.controlId),
        alternatives: seats.map((control) => ({ controlId: control.controlId, label: control.label }))
      }],
      sections: [{ id: "section_seats", type: "seat", controlIds: [...seats, continueControl].map((control) => control.controlId) }],
      currentSurface: { id: "surface-page", type: "page", memberControlIds: [...seats, continueControl].map((control) => control.controlId) },
      surfaceStack: [],
      screenshotAnnotations: seats.slice(0, 80).map((control) => ({ controlId: control.controlId }))
    };
    const compact = hooks.boundedObservationTransport({
      traveler: { seat_policy: "random_assignment", booking_rules: "No paid seats or extras" },
      userIntent: "Continue checkout safely",
      page
    });
    return {
      bytesBefore: hooks.observationTransportBytes({ page }),
      bytesAfter: hooks.observationTransportBytes(compact),
      controls: compact.page.controls.map((control) => control.controlId),
      collections: compact.page.controlCollections,
      decisionGroups: compact.page.decisionGroups,
      sectionControlIds: compact.page.sections[0].controlIds,
      surfaceControlIds: compact.page.currentSurface.memberControlIds,
      annotations: compact.page.screenshotAnnotations
    };
  });

  expect(result.bytesBefore).toBeGreaterThan(5_500_000);
  expect(result.bytesAfter).toBeLessThan(1_000_000);
  expect(result.controls).toContain("ctrl_continue");
  expect(result.controls.length).toBeLessThan(20);
  expect(result.collections).toEqual([
    expect.objectContaining({
      type: "seat_inventory",
      totalCount: 490,
      availableCount: 251,
      disabledCount: 239,
      paidCount: 490,
      profileMode: "random_assignment"
    })
  ]);
  expect(result.decisionGroups).toEqual([]);
  expect(result.sectionControlIds).toEqual(["ctrl_continue"]);
  expect(result.surfaceControlIds).toEqual(["ctrl_continue"]);
  expect(result.annotations).toEqual([]);
});

test("price-summary utilities cannot become free checkout alternatives", async ({ page }) => {
  await loadHtmlProducer(page, `
    <main>
      <h1>Antalya → Istanbul</h1>
      <div style="display:grid;grid-template-columns:minmax(0,2fr) minmax(280px,1fr);gap:24px">
        <section aria-labelledby="cancel-title">
          <h2 id="cancel-title">Medical cancellation</h2>
          <div>
            <article>
              <h3>No medical cancellation</h3>
              <p>0 TL</p>
              <button id="decline" type="button">No thanks, I'll take the risk</button>
            </article>
            <article>
              <h3>Medical cancellation</h3>
              <p>109.37 TL</p>
              <button id="add" type="button">Add protection for 109.37 TL</button>
            </article>
          </div>
        </section>
        <div>
          <p>1x Adult 1,830.83 TL</p>
          <p>1x Cabin baggage Included</p>
          <p>1x Checked baggage 15 kg Included</p>
          <p>1x Basic Saver fare Included</p>
          <p>Total 1,830.83 TL</p>
          <button id="breakdown" type="button" aria-haspopup="dialog">View price breakdown</button>
          <h2>Need more time to decide?</h2>
          <p>We'll hold this ticket price for 3 days.</p>
          <button id="lock" type="button">Lock price for 546.84 TL</button>
        </div>
      </div>
    </main>
  `);
  const result = await page.evaluate(() => {
    const map = window.__ATW_TEST__.buildPageMap();
    const byTestId = (id) => map.controls.find((control) => control.testId === id || control.stateElementId === document.getElementById(id)?.dataset.atwElementId);
    const decline = byTestId("decline") || map.controls.find((control) => /no thanks/i.test(control.label || ""));
    const breakdown = byTestId("breakdown") || map.controls.find((control) => /price breakdown/i.test(control.accessibleName || control.label || ""));
    const lock = byTestId("lock") || map.controls.find((control) => /lock price/i.test(control.accessibleName || control.label || ""));
    return {
      decline: decline ? { controlId: decline.controlId, decisionGroupId: decline.decisionGroupId, semantic: decline.semantic } : null,
      breakdown: breakdown ? {
        controlId: breakdown.controlId,
        decisionGroupId: breakdown.decisionGroupId,
        semantic: breakdown.semantic,
        choiceContract: breakdown.choiceContract,
        label: breakdown.label
      } : null,
      lock: lock ? {
        controlId: lock.controlId,
        decisionGroupId: lock.decisionGroupId,
        semantic: lock.semantic,
        physicalEffect: lock.physicalEffect,
        risk: lock.risk,
        structuredPrice: lock.structuredPrice,
        choiceContract: lock.choiceContract,
        label: lock.label
      } : null,
      publishedLockGroups: map.decisionGroups.filter((group) => (
        (group.alternatives || []).some((alternative) => alternative.controlId === lock?.controlId)
      )).map((group) => group.decisionGroupId)
    };
  });

  expect(result.decline).toBeTruthy();
  expect(result.breakdown).toBeTruthy();
  expect(result.breakdown.choiceContract).toBeNull();
  expect(result.breakdown.semantic).not.toMatch(/select_free_option|decline/);
  expect(result.breakdown.decisionGroupId).not.toBe(result.decline.decisionGroupId);
  expect(result.breakdown.label).toBe("View price breakdown");
  expect(result.lock).toBeTruthy();
  expect(result.lock.choiceContract).toBeNull();
  expect(result.lock.semantic).toBe("add_paid_extra");
  expect(result.lock.physicalEffect).not.toBe("select_free_option");
  expect(result.lock.risk).toBe("money");
  expect(result.lock.structuredPrice).toEqual({ amount: 546.84, currency: "TRY" });
  expect(result.lock.label).toBe("Lock price for 546.84 TL");
  expect(result.publishedLockGroups).toEqual([]);
});

test("identical navigation dispatch is held while the first action is settling", async ({ page }) => {
  await loadHtmlProducer(page, `<main><button id="continue" type="button">Continue</button></main>`);
  const result = await page.evaluate(() => {
    const hooks = window.__ATW_TEST__;
    const target = document.getElementById("continue");
    const decision = {
      action: "click",
      interactionRole: "navigation",
      semanticEffect: "advance",
      intent: "navigate_stage"
    };
    return {
      first: hooks.repeatGuardFor(target, "first", decision),
      immediateRepeat: hooks.repeatGuardFor(target, "repeat", decision),
      state: hooks.repeatGuardState()
    };
  });

  expect(result.first).toBe(true);
  expect(result.immediateRepeat).toBe(false);
  expect(result.state.lastClickAt).toBeGreaterThan(0);
});

test("action transport strips embedded page maps before the first backend request", async ({ page }) => {
  await loadHtmlProducer(page, `<main><button type="button">Continue</button></main>`);
  let received = null;
  let requestCount = 0;
  await page.route("**/api/agent/next-action", async (route) => {
    requestCount += 1;
    received = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true })
    });
  });
  const result = await page.evaluate(async (apiBase) => {
    const hooks = window.__ATW_TEST__;
    const bulkyActionResult = {
      actionId: "act_choice_transport",
      observationId: "obs_choice_transport",
      dispatched: true,
      verified: true,
      action: {
        action: "click",
        controlId: "ctrl_nationality",
        value: "Slovenia"
      },
      outcome: {
        ok: true,
        code: "CHOICE_COMMIT_SETTLED",
        evidence: {
          choiceCommit: {
            ok: true,
            code: "CHOICE_COMMIT_SETTLED",
            popupClosed: true,
            focusSettled: true,
            map: {
              fullText: "x".repeat(3_000_000),
              controls: Array.from({ length: 50 }, (_, index) => ({ controlId: `ctrl_${index}` }))
            }
          },
          exactChildSettlement: {
            contractVersion: "exact-child-choice-settlement/v1",
            settled: true,
            logicalFieldId: "lf_age_at_departure",
            subjectId: "traveler_1",
            semanticType: "age_at_departure",
            componentRole: "value",
            parentControlId: "ctrl_age_parent",
            selectedControlId: "ctrl_age_18_plus",
            selectedActuatorId: "atw-age-18-plus",
            desiredCanonicalValue: "23",
            selectedCanonicalValue: "18+",
            actualStateBlank: true,
            validationClear: true,
            popupClosed: true,
            focusSettled: true
          }
        }
      }
    };
    const payload = {
      sessionId: "session_action_transport",
      observationId: "obs_action_transport",
      observationSnapshot: { snapshotHash: "hash_action_transport" },
      actionHistory: [bulkyActionResult],
      lastActionResult: bulkyActionResult,
      page: {
        step: "traveler_information",
        controls: [{ controlId: "ctrl_continue", label: "Continue" }]
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
  expect(result.sentBytes).toBeLessThan(100_000);
  expect(result.transportMode).toBe("canonical");
  expect(result.response).toEqual({ ok: true });
  expect(requestCount).toBe(1);
  expect(received.actionHistory[0].outcome.evidence.choiceCommit.map).toBeUndefined();
  expect(received.lastActionResult.outcome.evidence.choiceCommit.map).toBeUndefined();
  expect(received.lastActionResult.outcome.evidence.choiceCommit).toMatchObject({
    ok: true,
    popupClosed: true,
    focusSettled: true
  });
  expect(received.lastActionResult.outcome.evidence.exactChildSettlement).toMatchObject({
    contractVersion: "exact-child-choice-settlement/v1",
    settled: true,
    semanticType: "age_at_departure",
    desiredCanonicalValue: "23",
    selectedCanonicalValue: "18+"
  });
});

test("oversized transport recovery is bounded when compact retry is also rejected", async ({ page }) => {
  await loadHtmlProducer(page, `<main><button type="button">Continue</button></main>`);
  let requestCount = 0;
  await page.route("**/api/agent/next-action", async (route) => {
    requestCount += 1;
    await route.fulfill({
      status: 413,
      contentType: "application/json",
      body: JSON.stringify({
        code: "OBSERVATION_TOO_LARGE",
        retryable: true,
        error: "Request body exceeds 5500000 bytes."
      })
    });
  });
  const result = await page.evaluate(async (apiBase) => {
    try {
      await window.__ATW_TEST__.postObservationWithSizeRecovery(apiBase, {
        sessionId: "session_transport_circuit_breaker",
        observationId: "obs_transport_circuit_breaker",
        observationSnapshot: { snapshotHash: "hash_transport_circuit_breaker" },
        page: {
          step: "traveler_information",
          controls: [{ controlId: "ctrl_continue", label: "Continue" }]
        }
      });
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        code: error.code || "",
        retryable: error.retryable === true
      };
    }
  }, TEST_API);

  expect(result).toEqual({
    ok: false,
    code: "OBSERVATION_TOO_LARGE",
    retryable: true
  });
  expect(requestCount).toBe(2);
});

test("incremental transport automatically falls back to one full resynchronization on a stale base", async ({ page }) => {
  await loadHtmlProducer(page, `<main><button type="button">Continue</button></main>`);
  const received = [];
  await page.route("**/api/agent/next-action", async (route) => {
    const body = route.request().postDataJSON();
    received.push(body);
    if (received.length === 1) {
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ code: "OBSERVATION_RESYNC_REQUIRED", retryable: true })
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  const result = await page.evaluate(async (apiBase) => {
    const hooks = window.__ATW_TEST__;
    const payload = {
      sessionId: "session_incremental_resync",
      observationId: "obs_incremental_resync",
      observationSnapshot: { snapshotHash: "hash_incremental_resync" },
      observationUpdate: {
        mode: "incremental",
        baseSnapshotHash: "hash_previous",
        snapshotHash: "hash_incremental_resync",
        diff: { stateChanges: [{ controlId: "ctrl_foreground" }] }
      },
      page: {
        currentSurface: { id: "surface_modal", type: "modal" },
        controls: [
          { controlId: "ctrl_background", surfaceId: "surface-page", label: "Background" },
          { controlId: "ctrl_foreground", surfaceId: "surface_modal", label: "Continue" }
        ],
        controlAliases: [
          { aliasId: "ctrl_background", controlId: "ctrl_background" },
          { aliasId: "ctrl_foreground", controlId: "ctrl_foreground" }
        ],
        decisionGroups: [],
        sections: []
      }
    };
    const posted = await hooks.postObservationWithSizeRecovery(apiBase, payload);
    return { transportMode: posted.transportMode, response: await posted.response.json() };
  }, TEST_API);
  expect(result).toEqual({ transportMode: "full_resynchronization", response: { ok: true } });
  expect(received).toHaveLength(2);
  expect(received[0].transportMode).toBe("incremental_diff");
  expect(received[0].page.controls.map((control) => control.controlId)).toEqual(["ctrl_foreground"]);
  expect(received[1].transportMode).toBe("full_resynchronization");
  expect(received[1].page.controls).toHaveLength(2);
});

test("large canonical observation uploads screenshot separately and reaches a grounded backend action", async ({ page, request }) => {
  test.setTimeout(210_000);
  const seatCount = 128;
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
      currentSurface: canonicalPage.currentSurface,
      emailControl: canonicalPage.controls.find((control) => control.semantic === "email" || /email/i.test(control.label || "")) || null,
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
  expect(transport.decision, JSON.stringify({ currentSurface: transport.currentSurface, emailControl: transport.emailControl, decision: transport.decision })).toMatchObject({
    sessionId: session.id,
    action: "type",
    actionLease: {
      observation: { id: transport.observationId },
      mechanic: { actionType: "type" }
    }
  });
  expect(transport.decision.actionLease.candidateId).toBeTruthy();
  expect(transport.emailControl).toMatchObject({
    contractVersion: "agent-contract/v1",
    componentContract: {
      currentCanonicalValue: "",
      controlIdentity: { controlId: transport.emailControl.controlId }
    }
  });
  expect(transport.decision.actionLease.capabilityProof).toMatchObject({
    contractVersion: "agent-contract/v1",
    requirement: { semanticType: "email" },
    component: { controlId: transport.emailControl.controlId },
    capability: { operation: "type", status: "proven_executable" },
    expectedOutcome: { type: "normalized_value_changed" }
  });

  const transactionResponse = await request.get(`${TEST_API}/agent/transaction/${session.id}`);
  expect(transactionResponse.status()).toBe(200);
  const transaction = await transactionResponse.json();
  expect(transaction.currentObservation.page.controls.length).toBeLessThan(transport.mapControlCount);
  expect(transaction.currentObservation.page.controlCollections).toEqual([
    expect.objectContaining({
      type: "seat_inventory",
      totalCount: expect.any(Number),
      omittedCount: expect.any(Number)
    })
  ]);
  expect(transaction.currentObservation.page.controlCollections[0].totalCount).toBeGreaterThan(100);
  expect(transaction.currentObservation.page.controlCollections[0].omittedCount).toBeGreaterThan(100);
  const persistedEmailControl = transaction.currentObservation.page.controls
    .find((control) => control.controlId === transport.emailControl.controlId);
  expect(persistedEmailControl.componentContract).toEqual(transport.emailControl.componentContract);
  expect(persistedEmailControl.operations).toEqual(transport.emailControl.operations);
  expect(persistedEmailControl.observedOptions).toEqual(transport.emailControl.observedOptions);
  expect(transaction.currentObservation.page.screenshotId).toBe(transport.screenshotId);
  expect(transaction.currentObservation.page.screenshotDataUrl).toBe("[redacted-persisted-separately]");
});

test("final safe checkout replay advances completed traveler through both seat legs to payment review", async ({ page }) => {
  await loadHtmlProducer(page, `
    <style>
      [hidden] { display: none !important; }
      section { margin: 12px; padding: 12px; border: 1px solid #aaa; }
      #seats { position: fixed; inset: 50px 100px auto; background: white; z-index: 20; }
      #seat-footer { position: fixed; left: 102px; top: 122px; z-index: 21; background: white; }
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
    const requirements = legacyRequirementReplay.requirementsWithDecisionGroups([], observation);
    const taskState = reduceTaskState({
      previousTaskState: state.taskState || {},
      observation,
      previousActionResult: observation.lastActionResult || null,
      userPolicy: state.approvals,
      traveler
    });
    const goal = taskState.currentGoal;
    expect(goal, JSON.stringify({
      taskState,
      controls: observation.page.controls.map((control) => ({
        label: control.label,
        fieldType: control.fieldType,
        operations: control.operations
      }))
    }, null, 2)).toBeTruthy();
    const scopedState = { ...state, taskState };
    const candidateSet = groundedObservationCandidateSet(goal, observation, [], {
      state: scopedState,
      traveler,
      approvals: state.approvals
    });
    const authoritativeTaskState = {
      ...taskState,
      currentGoal: { ...goal, candidateSet, candidates: candidateSet.candidates }
    };
    state = {
      ...scopedState,
      taskState: authoritativeTaskState,
      currentGoal: { ...goal, label: goal.semanticGoal, candidateSet, candidates: candidateSet.candidates },
      currentObservation: { observationId: observation.observationId, observationHash: observation.observationSnapshot.snapshotHash },
      requirements,
      activeRequirements: requirements
    };
    store.remember(state.id, observation);
    const candidate = candidateSet.candidates.find(matcher);
    expect(candidate, JSON.stringify({
      goal,
      candidates: candidateSet.candidates,
      decisionGroups: observation.page.decisionGroups,
      transactionFacts: observation.page.transactionFacts,
      controls: (observation.page.controls || []).map((control) => ({
        label: control.label,
        controlId: control.controlId,
        surfaceId: control.surfaceId,
        operations: control.operations
      }))
    })).toBeTruthy();
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

  const rejectionRequirements = legacyRequirementReplay.requirementsWithDecisionGroups([], observation);
  const rejectionTaskState = reduceTaskState({
    previousTaskState: state.taskState || {},
    observation,
    previousActionResult: observation.lastActionResult || null,
    userPolicy: state.approvals,
    traveler
  });
  const rejectionGoal = rejectionTaskState.currentGoal;
  const rejectionSet = groundedObservationCandidateSet(rejectionGoal, observation, [], {
    state: { ...state, taskState: rejectionTaskState },
    traveler,
    approvals: state.approvals
  });
  const currentFreeCandidate = rejectionSet.candidates.find((candidate) => /no thanks/i.test(candidate.targetLabel));
  expect(currentFreeCandidate, JSON.stringify({
    taskState: rejectionTaskState,
    context: rejectionSet.contextCapabilities.map((candidate) => ({
      label: candidate.targetLabel,
      controlId: candidate.controlId,
      decisionGroupId: candidate.decisionGroupId,
      physicalEffect: candidate.physicalEffect,
      goalRelevant: candidate.goalRelevant,
      selectable: candidate.selectable,
      exclusionReason: candidate.exclusionReason,
      risk: candidate.risk,
      policy: candidate.policyDecision
    }))
  }, null, 2)).toBeTruthy();
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
    state: withExecutionFixture({ ...state, lastAction: wrongSurfaceAction }, { recovery: { attempts: 0, phase: "idle", failedStrategySignatures: [] } }),
    observation: rejected.observation,
    previousObservation: observation
  });
  expect(recovery.lifecycle.status).toBe("rejected_before_dispatch");
  expect(recovery.directive).toBe("rebuild_candidates");
  expect(executionRecovery(recovery.state).attempts).toBe(0);
  expect(executionRecovery(recovery.state).phase).toBe("grounding_rejection");
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

test("checkpoint checkout reaches payment through review without paid, close, card, or purchase actions", async ({ page }) => {
  await page.goto("http://127.0.0.1:4273/checkout/traveler");
  await loadHtmlProducer(page, `
    <style>
      [hidden] { display: none !important; }
      section, [role="dialog"] { margin: 12px; padding: 12px; border: 1px solid #aaa; }
      #seats, #review { position: fixed; inset: 50px 100px auto; background: white; z-index: 20; }
    </style>
    <main>
      <h1 id="stage-title">Traveller information</h1>
      <p data-origin="LHR" data-destination="LJU" data-departure-date="2026-08-10">London LHR → Ljubljana LJU</p>
      <p id="total-price">Total 208 EUR</p>
      <section id="traveler">
        <label>Email <input id="email" type="email" required value="ali@example.test"></label>
        <label>Confirm email <input id="confirm-email" type="email" required value="ali@example.test"></label>
        <label>Country code <input id="country" type="tel" required value="+386"></label>
        <label>Phone <input id="phone" type="tel" required value="70328922"></label>
        <label>First name <input id="first-name" required value="Ali"></label>
        <label>Last name <input id="last-name" required value="Sifrar"></label>
        <button id="traveler-continue" type="button">Continue</button>
      </section>
      <section id="extras" aria-label="Optional protection" hidden>
        <h2>Optional protection</h2>
        <label><input id="extra-paid" type="radio" name="protection"> Add protection — 25 EUR</label>
        <label><input id="extra-free" type="radio" name="protection" required> No protection</label>
        <button id="extras-continue" type="button">Continue</button>
      </section>
      <section id="payment-summary" hidden>
        <h2>Payment review</h2>
        <p>Review the payment method, order amount, passenger details, and total to pay before entering any payment information.</p>
        <button type="button">Visa payment method</button>
        <button type="button">Mastercard payment method</button>
        <button type="button">Price details</button>
        <button type="button">Billing information</button>
      </section>
    </main>
    <section id="seats" role="dialog" aria-modal="true" aria-label="Reserve seating" hidden>
      <h2>Reserve seating</h2>
      <p>Flight 1 of 1</p>
      <button id="seat-paid-a" type="button">Seat 1A — 18 EUR</button>
      <button id="seat-paid-b" type="button">Seat 1B — 18 EUR</button>
      <label><input id="seat-free" type="radio" name="seat" required> No thanks</label>
      <button id="seat-next" type="button">Next</button>
    </section>
    <section id="review" role="dialog" aria-modal="true" aria-label="Review your booking" hidden>
      <h2>Review your booking</h2>
      <p>Check traveller and flight details before payment.</p>
      <button id="review-close" type="button" data-testid="dialog-close" aria-label="Close">×</button>
      <form id="review-form" action="/checkout/payment" method="post">
        <button id="review-submit" type="submit" data-testid="info-review-submit-button">Continue to Payment</button>
      </form>
    </section>
    <section id="payment" hidden>
      <h1>Payment</h1>
      <h2>Payment method</h2>
      <p>Order amount: 208 EUR</p>
      <label>Card number <input id="card-number" name="cardNumber" autocomplete="cc-number"></label>
      <label>Expiry <input id="card-expiry" autocomplete="cc-exp"></label>
      <label>CVC <input id="card-cvc" autocomplete="cc-csc"></label>
      <button id="purchase" type="button">Pay now</button>
    </section>
    <script>
      (() => {
        const counters = window.__checkpointCounters = {
          paidExtraSelections: 0,
          paidSeatSelections: 0,
          reviewCloseClicks: 0,
          cardFieldInputs: 0,
          purchaseClicks: 0
        };
        const traveler = document.getElementById("traveler");
        const extras = document.getElementById("extras");
        const seats = document.getElementById("seats");
        const review = document.getElementById("review");
        const payment = document.getElementById("payment");
        document.getElementById("traveler-continue").addEventListener("click", () => {
          traveler.hidden = true;
          extras.hidden = false;
          document.getElementById("stage-title").textContent = "Optional extras";
        });
        document.getElementById("extra-paid").addEventListener("click", () => { counters.paidExtraSelections += 1; });
        document.getElementById("extras-continue").addEventListener("click", () => {
          if (!document.getElementById("extra-free").checked) return;
          extras.hidden = true;
          seats.hidden = false;
          document.getElementById("stage-title").textContent = "Seat selection";
        });
        for (const id of ["seat-paid-a", "seat-paid-b"]) {
          document.getElementById(id).addEventListener("click", () => { counters.paidSeatSelections += 1; });
        }
        document.getElementById("seat-next").addEventListener("click", () => {
          if (!document.getElementById("seat-free").checked) return;
          seats.hidden = true;
          review.hidden = false;
          document.getElementById("stage-title").textContent = "Review";
        });
        document.getElementById("review-close").addEventListener("click", () => {
          counters.reviewCloseClicks += 1;
          review.hidden = true;
        });
        const showPayment = (event) => {
          event.preventDefault();
          review.hidden = true;
          payment.hidden = false;
          document.getElementById("payment-summary").hidden = false;
          document.getElementById("stage-title").textContent = "Payment";
          document.body.dataset.stage = "payment-review";
          history.pushState({}, "", "/checkout/payment");
        };
        document.getElementById("review-form").addEventListener("submit", showPayment);
        for (const id of ["card-number", "card-expiry", "card-cvc"]) {
          document.getElementById(id).addEventListener("input", () => { counters.cardFieldInputs += 1; });
        }
        document.getElementById("purchase").addEventListener("click", () => { counters.purchaseClicks += 1; });
      })();
    </script>
  `);

  const store = inMemoryGovernorStore();
  const traveler = {
    id: "trav_checkpoint_success",
    email: "ali@example.test",
    phone: "+38670328922",
    first_name: "Ali",
    last_name: "Sifrar",
    booking_rules: "no paid extras and no paid seats"
  };
  let state = createCheckoutSessionState({
    goal: "Reach payment review without paid extras",
    travelerId: traveler.id,
    site: { host: "example.test", url: page.url() }
  });
  state.id = "txn_checkpoint_success";
  state.approvals.skipPaidExtrasApproved = true;
  const actionLabels = [];

  const execute = async (observation, matcher, nextObservationId) => {
    const prepared = prepareTransactionInvariants(state, observation, traveler);
    state = prepared.state;
    const taskState = reduceTaskState({
      previousTaskState: state.taskState || {},
      observation,
      previousActionResult: observation.lastActionResult || null,
      userPolicy: state.approvals,
      traveler,
      transactionReview: prepared.review
    });
    const goal = taskState.currentGoal;
    expect(goal, JSON.stringify({
      taskState,
      controls: observation.page.controls.map((control) => ({
        label: control.label,
        fieldType: control.fieldType,
        operations: control.operations
      }))
    }, null, 2)).toBeTruthy();
    const candidateSet = groundedObservationCandidateSet(goal, observation, [], {
      state: { ...state, taskState }, traveler, approvals: state.approvals
    });
    const authoritativeGoal = { ...goal, candidateSet, candidates: candidateSet.candidates };
    state = {
      ...state,
      taskState: { ...taskState, currentGoal: authoritativeGoal },
      currentGoal: authoritativeGoal,
      currentObservation: {
        observationId: observation.observationId,
        observationHash: observation.observationSnapshot.snapshotHash
      }
    };
    const candidate = candidateSet.candidates.find(matcher);
    expect(candidate, JSON.stringify(candidateSet.contextCapabilities.map((item) => ({
      label: item.targetLabel,
      selectable: item.selectable,
      risk: item.risk,
      policy: item.policyDecision
    })), null, 2)).toBeTruthy();
    expect(candidate.risk).toBe("safe");
    const action = loopPrivate.bindTargetSnapshot(actionForCurrentCandidate(authoritativeGoal, candidate, observation), observation);
    store.remember(state.id, observation);
    const governed = governAction({ action, state, observation, traveler, store, turnId: nextObservationId });
    expect(governed.allow, `${governed.code}: ${governed.reason}`).toBe(true);
    state = { ...(governed.state || state), lastAction: action };
    const executed = await executeAtomicBrowserDecision(page, toClientDecision(action), nextObservationId);
    expect(executed.validation.ok, executed.validation.code).toBe(true);
    expect(executed.result.dispatched).toBe(true);
    actionLabels.push(candidate.targetLabel);
    return executed.observation;
  };

  let observation = await browserObservation(page, "obs_checkpoint_traveler");
  observation = await execute(observation, (candidate) => /continue/i.test(candidate.targetLabel), "obs_checkpoint_extras");
  observation = await execute(observation, (candidate) => /no protection/i.test(candidate.targetLabel), "obs_checkpoint_extra_declined");
  observation = await execute(observation, (candidate) => /continue/i.test(candidate.targetLabel), "obs_checkpoint_seats");
  observation = await execute(observation, (candidate) => /no thanks/i.test(candidate.targetLabel), "obs_checkpoint_seat_declined");
  observation = await execute(observation, (candidate) => /^next$/i.test(candidate.targetLabel), "obs_checkpoint_review");
  const reviewObservation = observation;
  observation = await execute(observation, (candidate) => /continue to payment/i.test(candidate.targetLabel), "obs_checkpoint_payment");

  const paymentPrepared = prepareTransactionInvariants(state, observation, traveler);
  state = paymentPrepared.state;
  const paymentTaskState = reduceTaskState({
    previousTaskState: state.taskState || {},
    observation,
    previousActionResult: observation.lastActionResult,
    userPolicy: state.approvals,
    traveler,
    transactionReview: paymentPrepared.review
  });
  expect(paymentTaskState.paymentEvidence.observed, JSON.stringify({
    stage: paymentTaskState.stage,
    paymentEvidence: paymentTaskState.paymentEvidence,
    stageDecisionEvidence: paymentTaskState.stageDecisionEvidence,
    url: observation.page.url,
    controls: observation.page.controls.map((control) => ({ label: control.label, semantic: control.semantic, field: control.field }))
  }, null, 2)).toBe(true);
  expect(paymentTaskState.terminalStatus).toBe("payment_review_reached");
  expect(paymentTaskState.currentGoal).toBeNull();

  const paymentActionResult = observation.lastActionResult;
  await page.waitForTimeout(350);
  const readyPaymentObservation = await browserObservation(page, "obs_checkpoint_payment_ready");
  readyPaymentObservation.lastActionResult = paymentActionResult;
  readyPaymentObservation.previousObservation = reviewObservation;
  const stopped = await runLoopTurn({
    apiKey: "",
    model: "must-not-be-called",
    dataDir: "",
    state,
    observation: readyPaymentObservation,
    traveler,
    transactionStore: store,
    clientTurnId: "turn_checkpoint_stop"
  });
  expect(stopped.clientDecision.action, JSON.stringify({
    clientDecision: stopped.clientDecision,
    status: stopped.state.status,
    readiness: stopped.state.observationReadiness,
    transition: stopped.debug.transition,
    debug: stopped.debug
  }, null, 2)).toBe("final_review");
  expect(stopped.state.status).toBe("ready_for_payment");
  expect(stopped.debug.candidateGenerationSuppressed).toBe(true);

  const counters = await page.evaluate(() => window.__checkpointCounters);
  expect(counters).toEqual({
    paidExtraSelections: 0,
    paidSeatSelections: 0,
    reviewCloseClicks: 0,
    cardFieldInputs: 0,
    purchaseClicks: 0
  });
  expect(actionLabels).toHaveLength(6);
  expect(actionLabels[0]).toMatch(/continue/i);
  expect(actionLabels[1]).toMatch(/no protection/i);
  expect(actionLabels[2]).toMatch(/continue/i);
  expect(actionLabels[3]).toMatch(/no thanks/i);
  expect(actionLabels[4]).toMatch(/^next$/i);
  expect(actionLabels[5]).toMatch(/continue to payment/i);
});

test("dirty checkout repairs exact paid selections before continuing to payment", async ({ page }) => {
  await page.goto("http://127.0.0.1:4273/checkout/extras");
  await loadHtmlProducer(page, `
    <style>
      [hidden] { display: none !important; }
      fieldset, [role="dialog"] { margin: 12px; padding: 12px; border: 1px solid #aaa; }
      #review { position: fixed; inset: 50px 100px auto; background: white; z-index: 20; }
    </style>
    <main>
      <h1 id="stage-title">Optional extras</h1>
      <p data-origin="LHR" data-destination="LJU" data-departure-date="2026-08-10">London LHR → Ljubljana LJU</p>
      <p id="total-price">Total 340 EUR</p>
      <section id="extras" aria-label="Optional extras">
        <fieldset>
          <legend>Travel bundle</legend>
          <label><input id="bundle-paid" type="radio" name="bundle" checked> Premium bundle</label>
          <label><input id="bundle-free" type="radio" name="bundle"> No bundle</label>
        </fieldset>
        <fieldset>
          <legend>Flexible ticket</legend>
          <label><input id="flex-paid" type="radio" name="flex" checked> Premium flexible ticket</label>
          <label><input id="flex-free" type="radio" name="flex"> No flexible ticket</label>
        </fieldset>
        <fieldset>
          <legend>Seat selection</legend>
          <label><input id="seat-paid" type="radio" name="seat" checked> Premium seat</label>
          <label><input id="seat-free" type="radio" name="seat"> No seat</label>
        </fieldset>
        <fieldset>
          <legend>Trip add-on</legend>
          <label><input id="addon-paid" type="radio" name="addon" checked> Premium add-on</label>
          <label><input id="addon-free" type="radio" name="addon"> Remove add-on</label>
        </fieldset>
        <button id="extras-continue" type="button">Continue</button>
      </section>
      <section id="review" role="dialog" aria-modal="true" aria-label="Review your booking" hidden>
        <h2>Review your booking</h2>
        <button id="review-close" type="button" data-testid="dialog-close" aria-label="Close">×</button>
        <form id="review-form" action="/checkout/payment" method="post">
          <button id="review-submit" type="submit" data-testid="info-review-submit-button">Continue to Payment</button>
        </form>
      </section>
      <section id="payment" hidden>
        <h1>Payment</h1>
        <h2>Payment method</h2>
        <p>Order amount: 200 EUR</p>
        <label>Card number <input id="card-number" autocomplete="cc-number"></label>
        <label>Expiry <input id="card-expiry" autocomplete="cc-exp"></label>
        <label>CVC <input id="card-cvc" autocomplete="cc-csc"></label>
        <button id="purchase" type="button">Pay now</button>
      </section>
    </main>
    <script>
      (() => {
        const paidIds = ["bundle-paid", "flex-paid", "seat-paid", "addon-paid"];
        const freeIds = ["bundle-free", "flex-free", "seat-free", "addon-free"];
        const counters = window.__dirtyCounters = {
          paidSelections: 0,
          repairs: 0,
          continuedWhileDirty: 0,
          reviewCloseClicks: 0,
          cardFieldInputs: 0,
          purchaseClicks: 0
        };
        for (const id of paidIds) {
          document.getElementById(id).addEventListener("click", () => { counters.paidSelections += 1; });
        }
        for (const id of freeIds) {
          document.getElementById(id).addEventListener("change", (event) => {
            if (event.target.checked) {
              counters.repairs += 1;
              document.getElementById("total-price").textContent = "Total " + (340 - (counters.repairs * 35)) + " EUR";
            }
          });
        }
        document.getElementById("extras-continue").addEventListener("click", () => {
          const clean = freeIds.every((id) => document.getElementById(id).checked);
          if (!clean) counters.continuedWhileDirty += 1;
          document.getElementById("extras").hidden = true;
          document.getElementById("review").hidden = false;
          document.getElementById("stage-title").textContent = "Review";
        });
        document.getElementById("review-close").addEventListener("click", () => {
          counters.reviewCloseClicks += 1;
          document.getElementById("review").hidden = true;
        });
        document.getElementById("review-form").addEventListener("submit", (event) => {
          event.preventDefault();
          document.getElementById("review").hidden = true;
          document.getElementById("payment").hidden = false;
          document.getElementById("stage-title").textContent = "Payment";
          document.body.dataset.stage = "payment-review";
          history.pushState({}, "", "/checkout/payment");
        });
        for (const id of ["card-number", "card-expiry", "card-cvc"]) {
          document.getElementById(id).addEventListener("input", () => { counters.cardFieldInputs += 1; });
        }
        document.getElementById("purchase").addEventListener("click", () => { counters.purchaseClicks += 1; });
      })();
    </script>
  `);

  const store = inMemoryGovernorStore();
  const traveler = {
    id: "trav_dirty_checkout",
    booking_rules: "decline all paid extras and paid seats"
  };
  let state = createCheckoutSessionState({
    goal: "Reach payment review without paid extras",
    travelerId: traveler.id,
    site: { host: "example.test", url: page.url() }
  });
  state.id = "txn_dirty_checkout";
  state.approvals.skipPaidExtrasApproved = true;

  let observation = await browserObservation(page, "obs_dirty_initial");
  const dirtyGroups = observation.page.decisionGroups.filter((group) => group.selectedControlId);
  expect(dirtyGroups).toHaveLength(4);
  const controlsById = new Map(observation.page.controls.map((control) => [control.controlId, control]));
  expect(dirtyGroups.every((group) => controlsById.get(group.selectedControlId)?.risk === "money")).toBe(true);

  // These persisted outcomes represent the previously clean state. The user
  // manually changed each exact control before the fresh observation.
  state.taskState = {
    completedOutcomes: dirtyGroups.map((group) => {
      const free = observation.page.controls.find((control) => (
        control.decisionGroupId === group.decisionGroupId
        && /no |remove/i.test(control.label)
      ));
      expect(free).toBeTruthy();
      return {
        decisionGroupId: group.decisionGroupId,
        requirementId: group.requirementId,
        surfaceId: group.surfaceId,
        status: "satisfied",
        selectedControlId: free.controlId,
        completionReason: "exact_browser_selection",
        observationId: "obs_before_manual_change"
      };
    })
  };

  const selectedLabels = [];
  for (let turn = 0; turn < 8; turn += 1) {
    const prepared = prepareTransactionInvariants(state, observation, traveler);
    state = prepared.state;
    const taskState = reduceTaskState({
      previousTaskState: state.taskState || {},
      observation,
      previousActionResult: observation.lastActionResult || null,
      userPolicy: state.approvals,
      traveler,
      transactionReview: prepared.review
    });
    state = { ...state, taskState };
    if (taskState.terminalStatus === "payment_review_reached") break;
    // The durable outcome journal is compiled by TaskState, then consumed by
    // transaction reconciliation on the following turn. Waiting one bounded
    // reconciliation-only turn at the payment boundary is expected and must
    // not publish a payment or generic surface action.
    if (!taskState.currentGoal && taskState.ambiguityReason === "transaction_review_incomplete") continue;
    expect(taskState.currentGoal, JSON.stringify({
      turn,
      stage: taskState.stage,
      ambiguityReason: taskState.ambiguityReason,
      decisionEpisode: taskState.decisionEpisode,
      activeDecisions: taskState.activeDecisions?.map((decision) => ({
        decisionGroupId: decision.decisionGroupId,
        status: decision.status,
        selectedControlId: decision.selectedControlId
      })),
      completedOutcomes: taskState.completedOutcomes
    }, null, 2)).toBeTruthy();
    const candidateSet = groundedObservationCandidateSet(taskState.currentGoal, observation, [], {
      state, traveler, approvals: state.approvals
    });
    const authoritativeGoal = { ...taskState.currentGoal, candidateSet, candidates: candidateSet.candidates };
    state = {
      ...state,
      taskState: { ...taskState, currentGoal: authoritativeGoal },
      currentGoal: authoritativeGoal,
      currentObservation: {
        observationId: observation.observationId,
        observationHash: observation.observationSnapshot.snapshotHash
      }
    };
    const candidate = candidateSet.candidates[0];
    expect(candidate, JSON.stringify(candidateSet.contextCapabilities.map((item) => ({
      label: item.targetLabel,
      selectable: item.selectable,
      risk: item.risk,
      policy: item.policyDecision
    })), null, 2)).toBeTruthy();
    expect(candidate.risk).toBe("safe");
    const action = loopPrivate.bindTargetSnapshot(actionForCurrentCandidate(authoritativeGoal, candidate, observation), observation);
    store.remember(state.id, observation);
    const governed = governAction({ action, state, observation, traveler, store, turnId: `turn_dirty_${turn}` });
    expect(governed.allow, `${governed.code}: ${governed.reason}`).toBe(true);
    state = { ...(governed.state || state), taskState, lastAction: action };
    const executed = await executeAtomicBrowserDecision(page, toClientDecision(action), `obs_dirty_${turn + 1}`);
    expect(executed.validation.ok, executed.validation.code).toBe(true);
    expect(executed.result.dispatched).toBe(true);
    selectedLabels.push(candidate.targetLabel);
    observation = executed.observation;
  }

  const finalPrepared = prepareTransactionInvariants(state, observation, traveler);
  state = finalPrepared.state;
  const finalTaskState = reduceTaskState({
    previousTaskState: state.taskState || {},
    observation,
    previousActionResult: observation.lastActionResult || null,
    userPolicy: state.approvals,
    traveler,
    transactionReview: finalPrepared.review
  });
  expect(finalTaskState.terminalStatus, JSON.stringify({
    selectedLabels,
    stage: finalTaskState.stage,
    goal: finalTaskState.currentGoal,
    ambiguityReason: finalTaskState.ambiguityReason,
    outcomeCoverage: finalTaskState.outcomeCoverage,
    observedDecisions: finalTaskState.observedDecisions,
    counters: await page.evaluate(() => window.__dirtyCounters)
  }, null, 2)).toBe("payment_review_reached");
  expect(finalTaskState.currentGoal).toBeNull();
  expect(await page.locator("#total-price").textContent()).toContain("200 EUR");
  expect(selectedLabels.slice(0, 4)).toEqual(expect.arrayContaining([
    expect.stringMatching(/no bundle/i),
    expect.stringMatching(/no flexible ticket/i),
    expect.stringMatching(/no seat/i),
    expect.stringMatching(/remove add-on/i)
  ]));
  expect(selectedLabels).toContain("Continue");
  expect(selectedLabels).toContain("Continue to Payment");
  expect(await page.evaluate(() => window.__dirtyCounters)).toEqual({
    paidSelections: 0,
    repairs: 4,
    continuedWhileDirty: 0,
    reviewCloseClicks: 0,
    cardFieldInputs: 0,
    purchaseClicks: 0
  });
});

test("live-shaped selected bundle inherits paid evidence only from its owned decision section", async ({ page }) => {
  await loadHtmlProducer(page, `
    <main>
      <h1>Optional extras</h1>
      <section aria-label="Travel bundle">
        <fieldset id="bundle-owner">
          <legend>Travel bundle</legend>
          <label><input id="bundle-selected" type="radio" name="bundle" checked> Package for all travelers</label>
          <label><input id="bundle-none" type="radio" name="bundle"> No bundle</label>
          <p id="bundle-cost">Cost: 29 EUR</p>
        </fieldset>
        <button id="bundle-continue" type="button">Continue</button>
      </section>
    </main>
    <script>
      document.getElementById("bundle-none").addEventListener("change", (event) => {
        if (event.target.checked) document.getElementById("bundle-cost").textContent = "Cost: 0 EUR";
      });
    </script>
  `);

  const traveler = { booking_rules: "No bundles" };
  let observation = await browserObservation(page, "obs_owned_bundle_paid");
  const group = observation.page.decisionGroups.find((item) => /bundle/i.test(item.sectionLabel));
  expect(group).toBeTruthy();
  expect(group.selectedEvidence).toMatchObject({
    disposition: "paid",
    structuredPrice: { amount: 29, currency: "EUR" },
    source: "owned_decision_section"
  });
  const selectedControl = observation.page.controls.find((control) => control.controlId === group.selectedControlId);
  expect(selectedControl.structuredPrice).toBeNull();

  let taskState = reduceTaskState({ observation, traveler });
  expect(
    taskState.activeDecisions[0]?.status,
    JSON.stringify(taskState.observedDecisions, null, 2)
  ).toBe("conflicted");
  const candidateSet = buildCurrentCandidateSet({
    goal: taskState.currentGoal,
    observation,
    traveler,
    state: { taskState, approvals: {} }
  });
  const correction = candidateSet.candidates.find((candidate) => /no bundle/i.test(candidate.targetLabel));
  expect(correction).toBeTruthy();
  const action = loopPrivate.bindTargetSnapshot(actionForCurrentCandidate(taskState.currentGoal, correction, observation), observation);
  const executed = await executeAtomicBrowserDecision(page, toClientDecision(action), "obs_owned_bundle_repaired");
  expect(executed.validation.ok, executed.validation.code).toBe(true);
  expect(executed.verification.ok, executed.verification.code).toBe(true);
  observation = executed.observation;
  taskState = reduceTaskState({ previousTaskState: taskState, observation, traveler });
  expect(taskState.activeDecisions).toHaveLength(0);
  expect(observation.page.decisionGroups.find((item) => item.decisionGroupId === group.decisionGroupId).selectedEvidence).toMatchObject({
    disposition: "free",
    structuredPrice: { amount: 0, currency: "EUR" }
  });
});

test("localized paid extras are classified as paid while an exact Included selection remains free", async ({ page }) => {
  await loadHtmlProducer(page, `
    <main>
      <h1>Passengers, baggage, insurance</h1>
      <section aria-label="Cabin or carry-on baggage">
        <fieldset>
          <legend>Cabin or carry-on baggage</legend>
          <label><input id="included-bag" type="radio" name="cabin_bag" checked> Included</label>
          <label><input id="no-cabin-bag" type="radio" name="cabin_bag"> No cabin bag</label>
        </fieldset>
      </section>
      <section aria-label="Lost baggage protection">
        <label>
          <input id="lost-bag-protection" type="checkbox" name="lost_bag_protection">
          Add lost baggage protection + 270.07 TL
        </label>
      </section>
      <button type="button">Continue</button>
    </main>
  `);

  const parsed = await page.evaluate(() => ({
    suffix: window.__ATW_TEST__.structuredPriceFromText("Add protection + 270.07 TL"),
    prefix: window.__ATW_TEST__.structuredPriceFromText("TRY 1.608,96"),
    symbol: window.__ATW_TEST__.structuredPriceFromText("₺270,07"),
    bidiPrefix: window.__ATW_TEST__.structuredPriceFromText("All passengers \u202AEUR37.95\u202C 37.95 Euro")
  }));
  expect(parsed).toEqual({
    suffix: { amount: 270.07, currency: "TRY" },
    prefix: { amount: 1608.96, currency: "TRY" },
    symbol: { amount: 270.07, currency: "TRY" },
    bidiPrefix: { amount: 37.95, currency: "EUR" }
  });

  const observation = await browserObservation(page, "obs_localized_paid_extra");
  const paid = observation.page.controls.find((control) => control.name === "lost_bag_protection");
  expect(paid).toMatchObject({
    risk: "money",
    physicalEffect: "select_paid_option",
    structuredPrice: { amount: 270.07, currency: "TRY" },
    selected: false
  });
  const included = observation.page.controls.find((control) => control.name === "cabin_bag");
  const includedDisposition = await page.evaluate((control) => (
    window.__ATW_TEST__.selectedDisposition({
      selected: { label: "Included", semantic: control.semantic, risk: control.risk },
      selectedControl: control,
      structuredPrice: null
    })
  ), included);
  expect(includedDisposition).toBe("free");

  const taskState = reduceTaskState({
    observation,
    traveler: { booking_rules: "No paid extras" }
  });
  expect(taskState.activeDecisions).toHaveLength(0);
});

test("a temporarily disabled Continue does not manufacture a required card choice", async ({ page }) => {
  await loadHtmlProducer(page, `
    <main>
      <h1>Passengers, baggage, insurance</h1>
      <section aria-label="Passenger and baggage">
        <label>Given names <input name="first_name" value="Ali" required></label>
        <label>Surnames <input name="last_name" value="SIFRAR" required></label>
        <fieldset>
          <legend>Cabin baggage</legend>
          <label><input type="radio" name="cabin_bag" checked> Included</label>
          <label><input type="radio" name="cabin_bag"> Extra cabin bag + 30 EUR</label>
        </fieldset>
        <div class="insurance-offer">
          <h2>Travel insurance</h2>
          <ul>
            <li><button id="insurance-plus" type="button">Travel Plus + 80 EUR</button></li>
            <li><button id="insurance-basic" type="button">Travel Basic + 35 EUR</button></li>
            <li><button id="insurance-none" type="button">No insurance</button></li>
          </ul>
        </div>
      </section>
      <button id="continue" type="button" disabled>Continue</button>
    </main>
  `);

  const observation = await browserObservation(page, "obs_navigation_blocking_insurance");
  const noInsurance = observation.page.controls.find((control) => control.label === "No insurance");
  expect(noInsurance).toMatchObject({
    semantic: "decline_paid_extra",
    risk: "safe_decline"
  });

  const insuranceGroup = observation.page.decisionGroups.find((group) => (
    group.alternativeControlIds?.includes(noInsurance.controlId)
  ));
  expect(insuranceGroup).toMatchObject({
    required: false,
    status: "optional"
  });
  expect(insuranceGroup.navigationBlocking).not.toBe(true);
  expect(insuranceGroup.alternativeControlIds).toHaveLength(3);

  const taskState = reduceTaskState({
    observation,
    traveler: {
      first_name: "Ali",
      last_name: "SIFRAR",
      booking_rules: "No paid extras"
    }
  });
  expect(taskState.currentGoal.decisionGroupId).toBe(insuranceGroup.decisionGroupId);
  expect(taskState.currentGoal.freeAlternativeControlIds).toContain(noInsurance.controlId);
});

test("button-only choice groups reconstruct an already-selected option and advance to Continue", async ({ page }) => {
  await loadHtmlProducer(page, `
    <main>
      <h1>Passengers, baggage, insurance</h1>
      <section aria-label="Passenger and baggage">
        <label>Given names <input name="first_name" value="Ali" required></label>
        <label>Surnames <input name="last_name" value="SIFRAR" required></label>
        <fieldset>
          <legend>Cabin baggage</legend>
          <label><input type="radio" name="cabin_bag" value="included" checked> Included</label>
          <label><input type="radio" name="cabin_bag" value="extra"> Extra cabin bag + 30 EUR</label>
        </fieldset>
        <fieldset>
          <legend>Checked baggage</legend>
          <label><input type="radio" name="checked_bag" value="included" checked> Included</label>
          <label><input type="radio" name="checked_bag" value="extra"> Extra checked bag + 40 EUR</label>
        </fieldset>
        <div class="insurance-offer">
          <h2>Travel insurance</h2>
          <ul>
            <li data-state="unselected"><button type="button">Travel Plus + 80 EUR</button></li>
            <li data-state="unselected"><button type="button">Travel Basic + 35 EUR</button></li>
            <li data-state="selected"><button id="insurance-none" type="button">No insurance</button></li>
          </ul>
        </div>
      </section>
      <button id="continue" type="button">Continue</button>
    </main>
  `);

  const observation = await browserObservation(page, "obs_button_choice_preselected");
  const insuranceControls = observation.page.controls.filter((control) => (
    /travel plus|travel basic|no insurance/i.test(control.label || "")
  ));
  expect(insuranceControls).toHaveLength(3);
  expect(new Set(insuranceControls.map((control) => control.controlId)).size).toBe(3);
  expect(new Set(insuranceControls.map((control) => control.decisionGroupId)).size).toBe(1);

  const noInsurance = insuranceControls.find((control) => /no insurance/i.test(control.label || ""));
  expect(noInsurance).toMatchObject({
    selected: true,
    state: {
      selected: true,
      selectionEvidence: {
        exclusive: true,
        invariantValid: true,
        selectedCount: 1
      }
    }
  });
  const insuranceGroup = observation.page.decisionGroups.find((group) => (
    group.decisionGroupId === noInsurance.decisionGroupId
  ));
  expect(insuranceGroup).toMatchObject({
    status: "satisfied",
    selectedControlId: noInsurance.controlId,
    selectionInvariant: {
      exclusive: true,
      valid: true,
      selectedCount: 1
    }
  });

  const cabin = observation.page.controls.find((control) => control.name === "cabin_bag" && control.selected);
  const checked = observation.page.controls.find((control) => control.name === "checked_bag" && control.selected);
  expect(cabin.controlId).not.toBe(checked.controlId);
  expect(cabin.decisionGroupId).not.toBe(checked.decisionGroupId);

  const taskState = reduceTaskState({
    observation,
    traveler: {
      first_name: "Ali",
      last_name: "SIFRAR",
      booking_rules: "No paid extras"
    }
  });
  expect(taskState.currentGoal).toMatchObject({
    semanticType: "navigation",
    semanticGoal: "continue checkout"
  });
});

test("button-only choice verification follows the option owner state transition", async ({ page }) => {
  await loadHtmlProducer(page, `
    <main>
      <h1>Passengers, baggage, insurance</h1>
      <section aria-label="Travel insurance">
        <label>Given names <input name="first_name" value="Ali" required></label>
        <label>Surnames <input name="last_name" value="SIFRAR" required></label>
        <div class="insurance-offer">
          <h2>Travel insurance</h2>
          <ul id="insurance-options">
            <li data-state="unselected"><button type="button">Travel Plus + 80 EUR</button></li>
            <li data-state="unselected"><button type="button">Travel Basic + 35 EUR</button></li>
            <li data-state="unselected"><button id="insurance-none" type="button">No insurance</button></li>
          </ul>
        </div>
      </section>
      <button id="continue" type="button" disabled>Continue</button>
    </main>
    <script>
      for (const button of document.querySelectorAll("#insurance-options button")) {
        button.addEventListener("click", () => {
          for (const option of document.querySelectorAll("#insurance-options li")) {
            option.dataset.state = option.contains(button) ? "selected" : "unselected";
          }
          document.getElementById("continue").disabled = false;
        });
      }
    </script>
  `);

  const observation = await browserObservation(page, "obs_button_choice_unselected");
  const taskState = reduceTaskState({
    observation,
    traveler: { first_name: "Ali", last_name: "SIFRAR", booking_rules: "No paid extras" }
  });
  const candidateSet = buildCurrentCandidateSet({
    goal: taskState.currentGoal,
    observation,
    traveler: { booking_rules: "No paid extras" },
    state: { taskState, approvals: {} }
  });
  const decline = candidateSet.candidates.find((candidate) => /no insurance/i.test(candidate.targetLabel || ""));
  expect(decline).toBeTruthy();

  const selected = await executeAtomicBrowserDecision(
    page,
    toClientDecision(actionForCurrentCandidate(taskState.currentGoal, decline, observation)),
    "obs_button_choice_selected"
  );
  expect(selected.verification).toMatchObject({
    ok: true,
    code: "EXACT_FREE_OPTION_VERIFIED"
  });
  const group = selected.observation.page.decisionGroups.find((item) => (
    item.decisionGroupId === taskState.currentGoal.decisionGroupId
  ));
  expect(group).toMatchObject({
    status: "satisfied",
    selectedControlId: decline.controlId
  });
  expect(await page.locator("#continue").isEnabled()).toBe(true);
});

test("Kiwi-style SVG button choice verifies the free option and enables Continue despite disabled utility variants", async ({ page }) => {
  await loadHtmlProducer(page, `
    <style>
      button { min-width: 180px; min-height: 72px; }
      svg { width: 24px; height: 24px; }
    </style>
    <main>
      <h1>Passengers, baggage, insurance</h1>
      <section aria-label="Travel insurance">
        <label>Given names <input name="first_name" value="Ali" required></label>
        <label>Surnames <input name="last_name" value="SIFRAR" required></label>
        <div class="insurance-offer">
          <h2>Travel insurance</h2>
          <ul id="insurance-options">
            <li>
              <button type="button" class="insurance-card disabled:cursor-not-allowed disabled:opacity-50">
                <svg aria-hidden="true" viewBox="0 0 24 24">
                  <circle class="choice-ring" cx="12" cy="12" r="9" fill="none" stroke="#697d8c"></circle>
                  <circle class="choice-dot" cx="12" cy="12" r="5" fill="#00a991" opacity="0"></circle>
                </svg>
                Travel Plus + 80 EUR
              </button>
            </li>
            <li>
              <button type="button" class="insurance-card disabled:cursor-not-allowed disabled:opacity-50">
                <svg aria-hidden="true" viewBox="0 0 24 24">
                  <circle class="choice-ring" cx="12" cy="12" r="9" fill="none" stroke="#697d8c"></circle>
                  <circle class="choice-dot" cx="12" cy="12" r="5" fill="#00a991" opacity="0"></circle>
                </svg>
                Travel Basic + 35 EUR
              </button>
            </li>
            <li>
              <button id="insurance-none" type="button" class="insurance-card disabled:cursor-not-allowed disabled:opacity-50">
                <svg aria-hidden="true" viewBox="0 0 24 24">
                  <circle class="choice-ring" cx="12" cy="12" r="9" fill="none" stroke="#697d8c"></circle>
                  <circle class="choice-dot" cx="12" cy="12" r="5" fill="#00a991" opacity="0"></circle>
                </svg>
                No insurance
              </button>
            </li>
          </ul>
        </div>
      </section>
      <button id="continue" type="button" class="orbit-button bg-green-600 disabled:cursor-not-allowed disabled:opacity-50" disabled>
        Continue
      </button>
    </main>
    <script>
      for (const button of document.querySelectorAll("#insurance-options button")) {
        button.addEventListener("click", () => {
          for (const option of document.querySelectorAll("#insurance-options button")) {
            const selected = option === button;
            option.querySelector(".choice-dot").style.opacity = selected ? "1" : "0";
            option.querySelector(".choice-ring").style.stroke = selected ? "#00a991" : "#697d8c";
          }
          document.getElementById("continue").disabled = false;
        });
      }
    </script>
  `);

  const traveler = {
    first_name: "Ali",
    last_name: "SIFRAR",
    booking_rules: "No paid extras"
  };
  const observation = await browserObservation(page, "obs_kiwi_svg_choice_unselected");
  const insuranceControls = observation.page.controls.filter((control) => (
    /travel plus|travel basic|no insurance/i.test(control.label || "")
  ));
  expect(insuranceControls).toHaveLength(3);
  expect(insuranceControls.every((control) => control.state?.selected === false)).toBe(true);

  const initialContinue = observation.page.controls.find((control) => /^continue$/i.test(control.label || ""));
  expect(initialContinue).toMatchObject({ state: { disabled: true } });
  expect(await page.locator("#continue").isDisabled()).toBe(true);
  expect(initialContinue.operations?.activate?.status).not.toBe("proven_executable");

  let taskState = reduceTaskState({ observation, traveler });
  expect(taskState.currentGoal).toMatchObject({ semanticType: "travel_insurance" });
  const candidateSet = buildCurrentCandidateSet({
    goal: taskState.currentGoal,
    observation,
    traveler,
    state: { taskState, approvals: {} }
  });
  const decline = candidateSet.candidates.find((candidate) => /no insurance/i.test(candidate.targetLabel || ""));
  expect(decline).toBeTruthy();

  const selected = await executeAtomicBrowserDecision(
    page,
    toClientDecision(actionForCurrentCandidate(taskState.currentGoal, decline, observation)),
    "obs_kiwi_svg_choice_selected"
  );
  expect(selected.verification).toMatchObject({
    ok: true,
    code: "EXACT_FREE_OPTION_VERIFIED"
  });
  expect(await page.locator("#insurance-none .choice-dot").getAttribute("style")).toContain("opacity: 1");
  expect(await page.locator("#continue").isEnabled()).toBe(true);

  const group = selected.observation.page.decisionGroups.find((item) => (
    item.decisionGroupId === taskState.currentGoal.decisionGroupId
  ));
  expect(group).toMatchObject({
    status: "satisfied",
    selectedControlId: decline.controlId,
    selectionInvariant: {
      exclusive: true,
      valid: true,
      selectedCount: 1
    }
  });
  const selectedControl = selected.observation.page.controls.find((control) => control.controlId === decline.controlId);
  expect(selectedControl).toMatchObject({
    selected: true,
    state: {
      selected: true,
      selectionEvidence: {
        source: "owned_visual_state_transition",
        selectedCount: 1,
        exclusive: true,
        invariantValid: true
      }
    }
  });
  expect(selected.observation.page.controls.filter((control) => (
    control.risk === "paid" && control.state?.selected === true
  ))).toHaveLength(0);

  const observedContinue = selected.observation.page.controls.find((control) => /^continue$/i.test(control.label || ""));
  expect(observedContinue).toMatchObject({
    state: { disabled: false },
    operations: {
      activate: {
        status: "proven_executable",
        actionability: {
          enabled: true,
          executable: true,
          code: "ACTIONABLE"
        }
      }
    }
  });

  taskState = reduceTaskState({
    previousTaskState: taskState,
    observation: selected.observation,
    traveler
  });
  expect(taskState.currentGoal).toMatchObject({
    semanticType: "navigation",
    semanticGoal: "continue checkout"
  });
  const continueCandidates = buildCurrentCandidateSet({
    goal: taskState.currentGoal,
    observation: selected.observation,
    traveler,
    state: { taskState, approvals: {} }
  });
  expect(continueCandidates.candidates.some((candidate) => (
    candidate.controlId === observedContinue.controlId
    && candidate.pipelineContract?.capability?.status === "proven_executable"
  ))).toBe(true);
});

test("per-card group wrappers collapse into one exclusive insurance decision", async ({ page }) => {
  await loadHtmlProducer(page, `
    <style>
      .insurance-options { display: flex; gap: 12px; }
      .insurance-card { width: 220px; min-height: 180px; border: 1px solid #ccd3dd; padding: 8px; }
      .insurance-card > button { width: 100%; height: 120px; }
      input[type="radio"] { display: block; width: 13px; height: 13px; margin-top: 20px; pointer-events: none; }
    </style>
    <main>
      <h1>Passengers, baggage, insurance</h1>
      <section aria-label="Travel insurance">
        <h2>Travel insurance</h2>
        <div class="insurance-options" role="radiogroup" aria-label="Travel insurance">
          <div class="insurance-card" role="group">
            <button type="button" data-selects="insurance-plus-radio">Travel Plus Medical expenses Trip cancellation</button>
            <input id="insurance-plus-radio" type="radio" aria-label="+ 80 EUR">
          </div>
          <div class="insurance-card" role="group">
            <button type="button" data-selects="insurance-basic-radio">Travel Basic Medical expenses</button>
            <input id="insurance-basic-radio" type="radio" aria-label="+ 35 EUR">
          </div>
          <div class="insurance-card" role="group">
            <button type="button" data-selects="insurance-none-radio">No insurance</button>
            <input id="insurance-none-radio" type="radio" aria-label="0 EUR">
          </div>
        </div>
      </section>
      <button id="continue" type="button" disabled>Continue</button>
    </main>
    <script>
      for (const card of document.querySelectorAll("[data-selects]")) {
        card.addEventListener("click", () => {
          for (const peer of document.querySelectorAll("input[type='radio']")) {
            peer.checked = peer.id === card.dataset.selects;
            if (peer.checked) peer.dispatchEvent(new Event("change", { bubbles: true }));
          }
          document.getElementById("continue").disabled = false;
        });
      }
    </script>
  `);

  const observation = await browserObservation(page, "obs_card_wrapped_insurance");
  const insuranceRadios = observation.page.controls.filter((control) => (
    control.role === "radio" && /insurance|travel (?:plus|basic)/i.test(control.label || "")
  ));
  expect(insuranceRadios).toHaveLength(3);

  const insuranceGroupIds = new Set(insuranceRadios.map((control) => control.decisionGroupId));
  expect(insuranceGroupIds.size).toBe(1);
  const [insuranceGroupId] = [...insuranceGroupIds];
  const insuranceGroup = observation.page.decisionGroups.find((group) => (
    group.decisionGroupId === insuranceGroupId
  ));
  expect(insuranceGroup.alternatives).toHaveLength(3);
  expect(insuranceGroup.alternatives.map((alternative) => alternative.label)).toEqual(
    expect.arrayContaining([
      expect.stringMatching(/travel plus/i),
      expect.stringMatching(/travel basic/i),
      expect.stringMatching(/no insurance/i)
    ])
  );
  for (const control of insuranceRadios) {
    expect(control.preferredActivationElementId).not.toBe(control.stateElementId);
    expect(control.operations.choose).toMatchObject({
      actuatorId: control.preferredActivationElementId,
      expectedOutcome: "control_selected",
      actionability: { executable: true }
    });
  }
  expect(observation.page.controls.filter((control) => (
    control.kind === "button" && /travel plus|travel basic|no insurance/i.test(control.label || "")
  ))).toHaveLength(0);

  const traveler = { booking_rules: "No paid extras" };
  let taskState = reduceTaskState({ observation, traveler });
  expect(taskState.currentGoal).toMatchObject({
    decisionGroupId: insuranceGroupId,
    semanticType: "travel_insurance"
  });
  const candidateSet = buildCurrentCandidateSet({
    goal: taskState.currentGoal,
    observation,
    traveler,
    state: { taskState, approvals: {} }
  });
  const decline = candidateSet.candidates.find((candidate) => /no insurance/i.test(candidate.targetLabel || ""));
  expect(decline).toBeTruthy();

  const action = toClientDecision(actionForCurrentCandidate(taskState.currentGoal, decline, observation));
  const selected = await executeAtomicBrowserDecision(page, action, "obs_card_wrapped_insurance_selected");
  expect(selected.verification).toMatchObject({
    ok: true,
    code: "EXACT_FREE_OPTION_VERIFIED"
  });
  expect(await page.locator("#insurance-none-radio").isChecked()).toBe(true);
  expect(await page.locator("#continue").isEnabled()).toBe(true);

  taskState = reduceTaskState({
    previousTaskState: taskState,
    observation: selected.observation,
    traveler
  });
  expect(taskState.currentGoal).toMatchObject({
    semanticType: "navigation",
    semanticGoal: "continue checkout"
  });
});

test("option ownership keeps AirHelp price, decline actuator, and utility chrome isolated", async ({ page }) => {
  await loadHtmlProducer(page, `
    <style>
      body { font-family: sans-serif; margin: 0; }
      main { width: 760px; padding: 32px; }
      .offer { border: 1px solid #ccd3dd; padding: 18px; }
      .option { display: block; padding: 14px; border-top: 1px solid #e4e8ee; }
      .option input { width: 14px; height: 14px; pointer-events: none; }
      #feedback { position: fixed; right: 0; top: 45%; width: 34px; height: 120px; }
    </style>
    <main>
      <h1>Passengers, baggage, insurance</h1>
      <section aria-label="Passenger checkout">
        <div class="offer">
          <h2 id="airhelp-heading">AirHelp+ flight disruption assistance</h2>
          <div role="radiogroup" aria-labelledby="airhelp-heading" aria-required="true">
            <label class="option" id="airhelp-paid-label">
              <strong>1 in 3 flights gets delayed or canceled.</strong>
              <span>Up to 32,810.63 TL in compensation and up to 429,272.41 TL in reimbursement.</span>
              <input id="airhelp-paid" type="radio" name="passenger" required>
              <span>+ 437.48 TL</span>
            </label>
            <div class="option">
              <label id="airhelp-free-label"><input id="airhelp-free" type="radio" name="passenger" required> I’ll take the risk</label>
              <span>Final price for all passengers and flights.</span>
              <button id="learn-more" type="button">Learn more</button>
            </div>
          </div>
        </div>
      </section>
      <button id="continue" type="button" disabled>Continue</button>
    </main>
    <button id="feedback" type="button">Feedback</button>
    <script>
      window.__learnMoreClicks = 0;
      document.getElementById("learn-more").addEventListener("click", () => { window.__learnMoreClicks += 1; });
      for (const radio of document.querySelectorAll("input[type='radio']")) {
        radio.addEventListener("change", () => { document.getElementById("continue").disabled = false; });
      }
    </script>
  `);

  const observation = await browserObservation(page, "obs_airhelp_option_contract");
  const free = observation.page.controls.find((control) => /take the risk/i.test(control.label || ""));
  const paid = observation.page.controls.find((control) => /flight gets delayed|437\.48/i.test(control.label || ""));
  const feedback = observation.page.controls.find((control) => /feedback/i.test(control.label || ""));
  const ids = await page.evaluate(() => ({
    learnMore: document.getElementById("learn-more").dataset.atwElementId,
    freeLabel: document.getElementById("airhelp-free-label").dataset.atwElementId
  }));

  expect(free).toMatchObject({
    semantic: "select_free_option",
    physicalEffect: "select_free_option",
    risk: "safe",
    sectionType: "bundle",
    choiceContract: {
      decisionLabel: expect.stringMatching(/airhelp/i),
      ownershipComplete: true,
      optionPhysicalEffect: "select_free_option"
    }
  });
  expect(free.preferredActivationElementId).toBe(ids.freeLabel);
  expect(free.preferredActivationElementId).not.toBe(ids.learnMore);
  expect(paid.structuredPrice).toEqual({ amount: 437.48, currency: "TRY" });
  expect(feedback.globalChrome).toBe(true);

  const airHelpGroup = observation.page.decisionGroups.find((group) => (
    (group.alternatives || []).some((alternative) => alternative.controlId === free.controlId)
  ));
  expect(airHelpGroup).toMatchObject({
    sectionType: "bundle",
    sectionLabel: expect.stringMatching(/airhelp/i)
  });
  expect(airHelpGroup.requirementId).not.toMatch(/^passenger:/);

  const traveler = { booking_rules: "No paid extras" };
  const taskState = reduceTaskState({ observation, traveler });
  expect(taskState.currentGoal.decisionGroupId).toBe(airHelpGroup.decisionGroupId);
  const candidateSet = buildCurrentCandidateSet({
    goal: taskState.currentGoal,
    observation,
    traveler,
    state: { taskState, approvals: {} }
  });
  const decline = candidateSet.candidates.find((candidate) => candidate.controlId === free.controlId);
  expect(decline).toMatchObject({
    physicalEffect: "select_free_option",
    targetId: ids.freeLabel,
    risk: "safe"
  });
  expect(candidateSet.candidates.some((candidate) => candidate.controlId === feedback.controlId)).toBe(false);

  const action = toClientDecision(actionForCurrentCandidate(taskState.currentGoal, decline, observation));
  const selected = await executeAtomicBrowserDecision(page, action, "obs_airhelp_declined");
  expect(selected.verification).toMatchObject({ ok: true, code: "EXACT_FREE_OPTION_VERIFIED" });
  expect(await page.locator("#airhelp-free").isChecked()).toBe(true);
  expect(await page.evaluate(() => window.__learnMoreClicks)).toBe(0);
});

test("an active parent card cannot turn an unchecked native paid toggle into a selection", async ({ page }) => {
  await loadHtmlProducer(page, `
    <main>
      <h1>Passengers, baggage, insurance</h1>
      <section aria-label="Passenger and baggage">
        <label>Given names <input name="first_name" value="Ali" required></label>
        <label>Surnames <input name="last_name" value="SIFRAR" required></label>
        <fieldset>
          <legend>Cabin baggage</legend>
          <label><input type="radio" name="cabin_bag" checked> Included</label>
          <label><input type="radio" name="cabin_bag"> Extra cabin bag + 30 EUR</label>
        </fieldset>
        <div class="active selected-card" data-state="active">
          <label>
            <input id="lost-bag-protection" type="checkbox" name="lost_bag_protection">
            Add lost baggage protection + 12 EUR
          </label>
        </div>
      </section>
      <button id="continue" type="button">Continue</button>
    </main>
  `);

  const observation = await browserObservation(page, "obs_unchecked_native_inside_active_card");
  const protection = observation.page.controls.find((control) => control.name === "lost_bag_protection");
  expect(protection).toMatchObject({
    selected: false,
    state: {
      checked: false,
      selected: false,
      selectedValue: ""
    }
  });
  expect(observation.page.transactionFacts.selectedExtras).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({ label: expect.stringMatching(/lost baggage protection/i) })
    ])
  );

  const taskState = reduceTaskState({
    observation,
    traveler: {
      first_name: "Ali",
      last_name: "SIFRAR",
      booking_rules: "No paid extras"
    }
  });
  expect(taskState.activeDecisions).toHaveLength(0);
  expect(taskState.currentGoal).toMatchObject({
    semanticType: "navigation",
    semanticGoal: "continue checkout"
  });
  const candidateSet = buildCurrentCandidateSet({
    goal: taskState.currentGoal,
    observation,
    traveler: { booking_rules: "No paid extras" }
  });
  expect(candidateSet.candidates.some((candidate) => candidate.targetLabel === "Continue")).toBe(true);
});

test("a custom free card remains committed when the site only enables Continue after a delay", async ({ page }) => {
  await loadHtmlProducer(page, `
    <main>
      <h1>Passengers, baggage, insurance</h1>
      <section aria-label="Passenger and baggage">
        <label>Given names <input name="first_name" value="Ali" required></label>
        <label>Surnames <input name="last_name" value="SIFRAR" required></label>
        <div class="insurance-offer">
          <h2>Travel insurance</h2>
          <ul>
            <li><button id="insurance-plus" type="button">Travel Plus + 80 EUR</button></li>
            <li><button id="insurance-basic" type="button">Travel Basic + 35 EUR</button></li>
            <li><button id="insurance-none" type="button">No insurance</button></li>
          </ul>
        </div>
      </section>
      <button id="continue" type="button" disabled>Continue</button>
    </main>
    <script>
      document.getElementById("insurance-none").addEventListener("click", () => {
        setTimeout(() => {
          document.getElementById("continue").disabled = false;
        }, 450);
      });
    </script>
  `);

  const observation = await browserObservation(page, "obs_delayed_custom_choice");
  const taskState = reduceTaskState({
    observation,
    traveler: { first_name: "Ali", last_name: "SIFRAR", booking_rules: "No paid extras" }
  });
  const candidateSet = buildCurrentCandidateSet({
    goal: taskState.currentGoal,
    observation,
    traveler: { booking_rules: "No paid extras" }
  });
  const candidate = candidateSet.candidates.find((item) => /no insurance/i.test(item.targetLabel || ""));
  expect(candidate).toBeTruthy();

  const selected = await executeAtomicBrowserDecision(
    page,
    toClientDecision(actionForCurrentCandidate(taskState.currentGoal, candidate, observation)),
    "obs_delayed_custom_choice_selected"
  );
  expect(selected.verification).toMatchObject({
    ok: true,
    code: "EXACT_FREE_OPTION_VERIFIED"
  });
  const group = selected.observation.page.decisionGroups.find((item) => (
    item.decisionGroupId === taskState.currentGoal.decisionGroupId
  ));
  expect(group).toMatchObject({
    status: "satisfied",
    selectedControlId: candidate.controlId
  });
  expect(await page.isEnabled("#continue")).toBe(true);
});

test("one baggage section preserves independent quantity and protection decision contracts", async ({ page }) => {
  await loadHtmlProducer(page, `
    <main>
      <h1>Baggage</h1>
      <section aria-label="Baggage choices">
        <fieldset aria-required="true">
          <legend>Checked baggage</legend>
          <label><input id="one-checked-bag" type="radio" name="checked_bag_quantity" checked required> One checked bag</label>
          <label><input id="two-checked-bags" type="radio" name="checked_bag_quantity" required> Two checked bags + 30 EUR</label>
        </fieldset>
        <label>
          <input id="lost-baggage-protection" type="checkbox" name="lost_baggage_protection">
          Add lost baggage protection + 12 EUR
        </label>
        <button id="continue-baggage" type="button">Continue</button>
      </section>
    </main>
  `);

  const observation = await browserObservation(page, "obs_independent_baggage_contracts");
  const quantityControl = observation.page.controls.find((control) => control.name === "checked_bag_quantity");
  const protectionControl = observation.page.controls.find((control) => control.name === "lost_baggage_protection");
  expect(quantityControl.controlId).not.toBe(protectionControl.controlId);
  expect(quantityControl.decisionGroupId).not.toBe(protectionControl.decisionGroupId);

  const quantityGroup = observation.page.decisionGroups.find((group) => group.decisionGroupId === quantityControl.decisionGroupId);
  const protectionGroup = observation.page.decisionGroups.find((group) => group.decisionGroupId === protectionControl.decisionGroupId);
  expect(quantityGroup.alternativeControlIds).toHaveLength(2);
  expect(protectionGroup.alternativeControlIds).toEqual([protectionControl.controlId]);
  expect(quantityGroup.required).toBe(true);
  expect(protectionGroup.required).toBe(false);

  const taskState = reduceTaskState({
    observation,
    traveler: {
      baggage_preference: "One checked bag",
      booking_rules: "No paid extras"
    }
  });
  const quantity = taskState.canonicalDecisions.find((decision) => decision.decisionGroupId === quantityGroup.decisionGroupId);
  const protection = taskState.canonicalDecisions.find((decision) => decision.decisionGroupId === protectionGroup.decisionGroupId);
  expect(quantity).toMatchObject({
    controlType: "exclusive_choice",
    currentOutcome: "selected",
    needsAction: false,
    status: "satisfied"
  });
  expect(quantity.subject.key).toBe("checked_baggage_quantity");
  expect(quantity.userIntent.match).toBe("exact");
  expect(protection).toMatchObject({
    controlType: "optional_toggle",
    currentOutcome: "declined",
    needsAction: false,
    status: "satisfied"
  });
  expect(protection.subject.key).toBe("baggage_protection");
  expect(protection.userIntent).toMatchObject({ match: "constraint", source: "no_paid_extras" });
  expect(taskState.activeDecisions).toHaveLength(0);
  expect(taskState.currentGoal.semanticType).toBe("navigation");
});

test("live-shaped flexible-ticket dropdown publishes selected price, exact none alternative, and verifies correction", async ({ page }) => {
  await loadHtmlProducer(page, `
    <style>[hidden] { display: none !important; } #flex-options { position: fixed; inset: 120px auto auto 120px; background: white; border: 1px solid #222; padding: 8px; z-index: 20; }</style>
    <main>
      <h1>Optional extras</h1>
      <section aria-label="Flexible ticket">
        <fieldset id="flex-owner">
          <legend>Flexible ticket</legend>
          <label for="flex-select">Passengers</label>
          <input id="flex-select" name="flexible_ticket" role="combobox" readonly aria-expanded="false" aria-controls="flex-options" value="All passengers">
          <p id="flex-cost">Cost: 29 EUR</p>
        </fieldset>
        <button id="flex-continue" type="button">Continue</button>
      </section>
    </main>
    <div id="flex-options" role="listbox" aria-label="Flexible ticket passengers" hidden>
      <button id="flex-all" type="button" role="option" aria-selected="true">All passengers — 29 EUR</button>
      <button id="flex-none" type="button" role="option" aria-selected="false">None of the passengers — 0 EUR</button>
    </div>
    <script>
      (() => {
        const select = document.getElementById("flex-select");
        const options = document.getElementById("flex-options");
        const show = () => { options.hidden = false; select.setAttribute("aria-expanded", "true"); };
        select.addEventListener("click", show);
        select.addEventListener("keydown", (event) => { if (event.key === "ArrowDown" || event.key === "Enter") show(); });
        document.getElementById("flex-none").addEventListener("click", () => {
          select.value = "None of the passengers";
          select.setAttribute("aria-expanded", "false");
          document.getElementById("flex-all").setAttribute("aria-selected", "false");
          document.getElementById("flex-none").setAttribute("aria-selected", "true");
          document.getElementById("flex-cost").textContent = "Cost: 0 EUR";
          options.hidden = true;
          select.dispatchEvent(new Event("change", { bubbles: true }));
        });
      })();
    </script>
  `);

  const traveler = { booking_rules: "No flexible ticket" };
  let observation = await browserObservation(page, "obs_flex_paid_closed");
  let group = observation.page.decisionGroups.find((item) => /flexible/i.test(`${item.sectionLabel} ${item.requirementId}`));
  expect(group).toBeTruthy();
  expect(group.selectedLabel).toMatch(/all passengers/i);
  expect(group.selectedEvidence).toMatchObject({ disposition: "paid", structuredPrice: { amount: 29, currency: "EUR" } });

  let taskState = reduceTaskState({ observation, traveler });
  expect(
    taskState.activeDecisions[0]?.status,
    JSON.stringify(taskState.observedDecisions, null, 2)
  ).toBe("conflicted");
  let candidateSet = buildCurrentCandidateSet({ goal: taskState.currentGoal, observation, traveler, state: { taskState, approvals: {} } });
  const opener = candidateSet.candidates.find((candidate) => candidate.operation === "open" || /passengers/i.test(candidate.targetLabel));
  expect(opener).toBeTruthy();
  let action = loopPrivate.bindTargetSnapshot(actionForCurrentCandidate(taskState.currentGoal, opener, observation), observation);
  let executed = await executeAtomicBrowserDecision(page, toClientDecision(action), "obs_flex_options_open");
  expect(executed.validation.ok, executed.validation.code).toBe(true);
  observation = executed.observation;

  taskState = reduceTaskState({ previousTaskState: taskState, observation, traveler });
  candidateSet = buildCurrentCandidateSet({ goal: taskState.currentGoal, observation, traveler, state: { taskState, approvals: {} } });
  const none = candidateSet.candidates.find((candidate) => /none of the passengers/i.test(candidate.targetLabel));
  expect(none).toBeTruthy();
  action = loopPrivate.bindTargetSnapshot(actionForCurrentCandidate(taskState.currentGoal, none, observation), observation);
  executed = await executeAtomicBrowserDecision(page, toClientDecision(action), "obs_flex_none_selected");
  expect(executed.validation.ok, executed.validation.code).toBe(true);
  expect(executed.verification.ok, executed.verification.code).toBe(true);
  observation = executed.observation;
  taskState = reduceTaskState({ previousTaskState: taskState, observation, traveler });
  group = observation.page.decisionGroups.find((item) => /flexible/i.test(`${item.sectionLabel} ${item.requirementId}`));
  expect(group.selectedLabel).toMatch(/none of the passengers/i);
  expect(group.selectedEvidence).toMatchObject({ disposition: "free", structuredPrice: { amount: 0, currency: "EUR" } });
  expect(taskState.activeDecisions).toHaveLength(0);
});

test("multi-surface free choice confirms once, closes its completed parent, and never republishes the selected option", async ({ page }) => {
  await loadHtmlProducer(page, `
    <style>
      [hidden] { display: none !important; }
      #flex-options { position: fixed; left: 120px; top: 160px; width: 340px; padding: 8px; background: white; border: 1px solid #222; z-index: 20; }
      #flex-confirm { position: fixed; left: 180px; top: 240px; width: 420px; padding: 20px; background: white; border: 2px solid #111; z-index: 30; }
    </style>
    <main>
      <h1>Traveller information</h1>
      <section aria-label="Flexible Ticket">
        <h2>Flexible Ticket</h2>
        <button id="flex-opener" type="button" role="combobox" aria-haspopup="listbox" aria-controls="flex-options" aria-expanded="true" aria-required="true">Select one option</button>
        <button id="continue" type="button">Continue</button>
      </section>
    </main>
    <div id="flex-options" role="listbox" aria-label="Flexible Ticket options">
      <button id="flex-paid" type="button" role="option" aria-selected="false">All passengers ‪16EUR‬ 16 Euro</button>
      <button id="flex-none" type="button" role="option" aria-selected="false">None of the passengers ‪0EUR‬ 0 Euro</button>
    </div>
    <section id="flex-confirm" role="dialog" aria-modal="true" aria-labelledby="flex-confirm-title" hidden>
      <h2 id="flex-confirm-title">Flexible Ticket</h2>
      <p>Do you want to add a Flexible ticket and have the option to change your trip?</p>
      <button id="flex-without" type="button">I'll go without</button>
      <button id="flex-add" type="button">Add to my trip</button>
    </section>
    <script>
      window.__flexCounts = { option: 0, confirmation: 0, close: 0, continue: 0 };
      const opener = document.getElementById("flex-opener");
      const options = document.getElementById("flex-options");
      const confirmation = document.getElementById("flex-confirm");
      opener.addEventListener("click", () => {
        const expanded = opener.getAttribute("aria-expanded") === "true";
        opener.setAttribute("aria-expanded", expanded ? "false" : "true");
        options.hidden = expanded;
        if (expanded) window.__flexCounts.close += 1;
      });
      document.getElementById("flex-none").addEventListener("click", () => {
        window.__flexCounts.option += 1;
        opener.textContent = "None of the passengers";
        document.getElementById("flex-none").setAttribute("aria-selected", "true");
        document.getElementById("flex-paid").setAttribute("aria-selected", "false");
        confirmation.hidden = false;
      });
      document.getElementById("flex-without").addEventListener("click", () => {
        window.__flexCounts.confirmation += 1;
        confirmation.hidden = true;
      });
      document.getElementById("continue").addEventListener("click", () => {
        window.__flexCounts.continue += 1;
      });
    </script>
  `);

  const traveler = { booking_rules: "No paid extras" };
  let observation = await browserObservation(page, "obs_episode_parent");
  let taskState = reduceTaskState({ observation, traveler });
  let candidates = buildCurrentCandidateSet({ goal: taskState.currentGoal, observation, traveler, state: { taskState, approvals: {} } });
  const none = candidates.candidates.find((candidate) => /none of the passengers/i.test(candidate.targetLabel));
  expect(none, JSON.stringify(candidates, null, 2)).toBeTruthy();
  let action = loopPrivate.bindTargetSnapshot(actionForCurrentCandidate(taskState.currentGoal, none, observation), observation);
  expect(action.affordance.task).toMatchObject({
    decisionEpisodeId: taskState.decisionEpisode.episodeId,
    decisionInstanceId: taskState.decisionEpisode.decisionInstanceId
  });
  let executed = await executeAtomicBrowserDecision(page, toClientDecision(action), "obs_episode_child");
  expect(executed.validation.ok, executed.validation.code).toBe(true);

  observation = executed.observation;
  taskState = reduceTaskState({ previousTaskState: taskState, observation, previousActionResult: observation.lastActionResult, traveler });
  expect(taskState.currentGoal.parentDecisionGroupId).toBeTruthy();
  candidates = buildCurrentCandidateSet({ goal: taskState.currentGoal, observation, traveler, state: { taskState, approvals: {} } });
  const decline = candidates.candidates.find((candidate) => /go without/i.test(candidate.targetLabel));
  expect(decline, JSON.stringify(candidates, null, 2)).toBeTruthy();
  action = loopPrivate.bindTargetSnapshot(actionForCurrentCandidate(taskState.currentGoal, decline, observation), observation);
  executed = await executeAtomicBrowserDecision(page, toClientDecision(action), "obs_episode_parent_completed");
  expect(executed.verification.ok, executed.verification.code).toBe(true);

  observation = executed.observation;
  taskState = reduceTaskState({ previousTaskState: taskState, observation, previousActionResult: observation.lastActionResult, traveler });
  expect(taskState.decisionEpisode.status).toBe("completed_pending_surface_exit");
  expect(taskState.outcomeJournal).toHaveLength(1);
  expect(taskState.outcomeJournal[0]).toMatchObject({
    decisionInstanceId: taskState.decisionEpisode.decisionInstanceId,
    verified: true,
    originKind: "verified_commerce_decision"
  });
  expect(taskState.currentGoal.semanticType).toBe("completed_choice_surface");
  candidates = buildCurrentCandidateSet({ goal: taskState.currentGoal, observation, traveler, state: { taskState, approvals: {} } });
  expect(candidates.candidates.some((candidate) => /none of the passengers.*0/i.test(candidate.targetLabel)), false);
  expect(candidates.candidates).toHaveLength(1);
  expect(candidates.candidates[0]).toMatchObject({ physicalEffect: "dismiss_surface" });
  action = loopPrivate.bindTargetSnapshot(actionForCurrentCandidate(taskState.currentGoal, candidates.candidates[0], observation), observation);
  expect(action.pipelineContract?.surfaceOwnership).toMatchObject({
    kind: "parent_controls_active_surface",
    status: "proven",
    activeSurfaceId: observation.page.currentSurface.id,
    parentControlId: action.controlId,
    parentActuatorId: action.actuatorId,
    operation: action.operation
  });
  let governorState = createCheckoutSessionState({
    goal: "Complete traveler checkout",
    travelerId: "trav_episode",
    site: { host: "example.test", url: page.url() }
  });
  governorState.id = "txn_completed_choice_surface_exit";
  const authoritativeGoal = { ...taskState.currentGoal, candidateSet: candidates, candidates: candidates.candidates };
  governorState = {
    ...governorState,
    taskState: { ...taskState, currentGoal: authoritativeGoal },
    currentGoal: authoritativeGoal,
    currentObservation: {
      observationId: observation.observationId,
      observationHash: observation.observationSnapshot.snapshotHash
    }
  };
  const store = inMemoryGovernorStore();
  store.remember(governorState.id, observation);
  const governed = governAction({
    action,
    state: governorState,
    observation,
    traveler,
    store,
    turnId: "turn_completed_choice_surface_exit"
  });
  expect(governed.allow, `${governed.code}: ${governed.reason}`).toBe(true);
  expect(governed.checks).toContainEqual(expect.objectContaining({
    code: "EXECUTION_LANE_CLASSIFIED",
    detail: "normal"
  }));
  executed = await executeAtomicBrowserDecision(page, toClientDecision(governed.action), "obs_episode_closed");
  expect(executed.verification.ok, executed.verification.code).toBe(true);

  expect(await page.evaluate(() => window.__flexCounts)).toEqual({ option: 1, confirmation: 1, close: 1, continue: 0 });
  expect(await page.locator("#flex-options").isHidden()).toBe(true);
});

test("collapsed custom selector publishes its displayed paid value without checked option state", async ({ page }) => {
  await page.goto("http://127.0.0.1:4273/checkout/extras");
  await loadHtmlProducer(page, `
    <main>
      <h1>Optional extras</h1>
      <section aria-label="Flexible ticket">
        <div class="owned-product">
          <h2>Flexible ticket</h2>
          <button id="flex-selector" type="button" aria-haspopup="listbox" aria-controls="flex-options" aria-expanded="false">
            <span class="displayed-value">All passengers</span><span aria-hidden="true">⌄</span>
          </button>
          <span class="owned-price">29 EUR</span>
        </div>
        <button id="continue" type="button">Continue</button>
      </section>
      <div id="flex-options" role="listbox" aria-label="Flexible ticket options" hidden>
        <button id="flex-all" type="button" role="option">All passengers — 29 EUR</button>
        <button id="flex-none" type="button" role="option">None of the passengers — 0 EUR</button>
      </div>
    </main>
    <script>
      document.getElementById("flex-selector").addEventListener("click", () => {
        document.getElementById("flex-options").hidden = false;
        document.getElementById("flex-selector").setAttribute("aria-expanded", "true");
      });
    </script>
  `);

  const observation = await browserObservation(page, "obs_collapsed_paid_selector");
  const selector = observation.page.controls.find((control) => control.preferredActivationElementId === "flex-selector" || /all passengers/i.test(control.currentValue));
  expect(selector).toBeTruthy();
  const group = observation.page.decisionGroups.find((item) => item.selectedEvidence?.selectedControlId === selector.controlId);
  expect(group, JSON.stringify(observation.page.decisionGroups, null, 2)).toBeTruthy();
  expect(group.selectedLabel).toMatch(/all passengers/i);
  expect(group.selectedEvidence).toMatchObject({
    selected: true,
    disposition: "paid",
    structuredPrice: { amount: 29, currency: "EUR" },
    source: "owned_decision_section"
  });
  const taskState = reduceTaskState({
    observation,
    traveler: { booking_rules: "decline all paid extras" }
  });
  expect(taskState.activeDecisions).toHaveLength(1);
  expect(taskState.activeDecisions[0]).toMatchObject({
    decisionGroupId: group.decisionGroupId,
    status: "conflicted"
  });
});

test("live-shaped selected seat summary exposes only its structurally owned Remove correction", async ({ page }) => {
  await loadHtmlProducer(page, `
    <main>
      <h1>Seat selection</h1>
      <section aria-label="Selected seats">
        <h2>Selected seats</h2>
        <article id="seat-summary" data-selected-item="seat">
          <span>Seat 7C</span>
          <span id="seat-price">19 EUR</span>
          <button id="seat-remove" type="button" data-action="remove">Remove</button>
        </article>
        <button id="seat-next" type="button">Next</button>
      </section>
    </main>
    <script>
      document.getElementById("seat-remove").addEventListener("click", () => document.getElementById("seat-summary").remove());
    </script>
  `);

  const traveler = { booking_rules: "No paid seats" };
  let observation = await browserObservation(page, "obs_seat_summary_paid");
  const group = observation.page.decisionGroups.find((item) => item.removalControlId);
  expect(group, JSON.stringify({
    controls: observation.page.controls.map((control) => ({
      label: control.label,
      semantic: control.semantic,
      risk: control.risk,
      sectionId: control.sectionId,
      sectionType: control.sectionType,
      ownText: control.ownText,
      testId: control.testId
    })),
    sections: observation.page.sections,
    decisionGroups: observation.page.decisionGroups
  }, null, 2)).toBeTruthy();
  expect(group.selectedEvidence).toMatchObject({
    disposition: "paid",
    structuredPrice: { amount: 19, currency: "EUR" }
  });
  const removeControl = observation.page.controls.find((control) => control.controlId === group.removalControlId);
  expect(removeControl).toMatchObject({
    decisionGroupId: group.decisionGroupId,
    physicalEffect: "select_free_option",
    risk: "safe_decline"
  });
  expect(group.alternativeControlIds).toEqual([group.removalControlId]);
  const ownershipFastPath = await resolveSemanticOwnership({
    apiKey: "",
    model: "must-not-be-called",
    observation,
    userPolicy: { bookingRules: traveler.booking_rules },
    traveler
  });
  expect(ownershipFastPath.resolution).toBeNull();

  let taskState = reduceTaskState({ observation, traveler });
  expect(taskState.activeDecisions[0].status).toBe("conflicted");
  const candidateSet = buildCurrentCandidateSet({ goal: taskState.currentGoal, observation, traveler, state: { taskState, approvals: {} } });
  expect(candidateSet.candidates).toHaveLength(1);
  expect(candidateSet.candidates[0].controlId).toBe(group.removalControlId);
  const action = loopPrivate.bindTargetSnapshot(actionForCurrentCandidate(taskState.currentGoal, candidateSet.candidates[0], observation), observation);
  const executed = await executeAtomicBrowserDecision(page, toClientDecision(action), "obs_seat_summary_removed");
  expect(executed.validation.ok, executed.validation.code).toBe(true);
  expect(executed.verification.ok, executed.verification.code).toBe(true);
  observation = executed.observation;
  expect(observation.page.decisionGroups.some((item) => item.decisionGroupId === group.decisionGroupId)).toBe(false);
  taskState = reduceTaskState({ previousTaskState: taskState, observation, traveler });
  expect(taskState.activeDecisions).toHaveLength(0);
  expect(taskState.currentGoal.semanticType).toBe("navigation");
});

test("text-only paid summaries on separate surface instances are independently reversed before navigation", async ({ page }) => {
  await loadHtmlProducer(page, `
    <main>
      <h1>Optional selections</h1>
      <p id="total-price">Total 119 EUR</p>
    </main>
    <section id="selection-surface" role="dialog" aria-modal="true" aria-label="Current optional selection">
      <h2>Current optional selection</h2>
      <p id="surface-progress">Flight 1 of 2</p>
      <div id="selected-slot"></div>
      <button id="surface-advance" type="button">Proceed</button>
    </section>
    <section id="payment" hidden>
      <h1>Payment</h1>
      <h2>Payment method</h2>
      <p>Order amount: 100 EUR</p>
      <label>Card number <input autocomplete="cc-number"></label>
    </section>
    <script>
      (() => {
        const charges = [19, 27];
        let surfaceInstance = 0;
        let selected = true;
        const counters = window.__multiSurfaceCorrection = { reversals: [0, 0], advances: 0 };
        const render = () => {
          const charge = charges[surfaceInstance];
          document.getElementById("surface-progress").textContent = "Flight " + (surfaceInstance + 1) + " of 2";
          document.getElementById("total-price").textContent = "Total " + (100 + (selected ? charge : 0)) + " EUR";
          document.getElementById("selected-slot").innerHTML = selected
            ? '<article data-selected-item="true"><span>Chosen item ' + (surfaceInstance === 0 ? 'A' : 'B') + '</span> <span>' + charge + ' EUR</span> <button type="button" aria-label="Deselect current choice">Undo</button></article>'
            : '<p>No current selection</p>';
        };
        document.getElementById("selection-surface").addEventListener("click", (event) => {
          if (event.target.closest("[aria-label='Deselect current choice']")) {
            counters.reversals[surfaceInstance] += 1;
            selected = false;
            render();
            return;
          }
          if (event.target.closest("#surface-advance")) {
            counters.advances += 1;
            if (selected) return;
            if (surfaceInstance === 0) {
              surfaceInstance = 1;
              selected = true;
              render();
              return;
            }
            document.getElementById("selection-surface").hidden = true;
            document.getElementById("payment").hidden = false;
            document.body.dataset.stage = "payment-review";
            history.pushState({}, "", "/checkout/payment");
          }
        });
        render();
      })();
    </script>
  `);

  const traveler = { booking_rules: "Decline all paid extras" };
  const observedGroupIds = [];
  const previousFetch = global.fetch;
  let modelCalls = 0;
  global.fetch = async () => {
    modelCalls += 1;
    throw new Error("Semantic ownership AI must not run for one exact structurally owned reversal.");
  };
  try {
    let observation = await browserObservation(page, "obs_multi_surface_paid_1");
    let previousTaskState = {};
    for (let index = 0; index < 2; index += 1) {
      const paidGroup = observation.page.decisionGroups.find((group) => (
        group.selectedControlId === ""
        && group.removalControlId
        && Number(group.selectedEvidence?.structuredPrice?.amount) === [19, 27][index]
      ));
      expect(paidGroup, JSON.stringify(observation.page.decisionGroups, null, 2)).toBeTruthy();
      expect(paidGroup.selectedEvidence.selected).toBe(true);
      expect(paidGroup.selectedEvidence.disposition).toBe("paid");
      observedGroupIds.push(paidGroup.decisionGroupId);

      const ownershipFastPath = await resolveSemanticOwnership({
        apiKey: "must-not-be-used",
        model: "must-not-be-called",
        observation,
        userPolicy: { bookingRules: traveler.booking_rules },
        traveler
      });
      expect(ownershipFastPath.resolution).toBeNull();

      const conflictedState = reduceTaskState({ previousTaskState, observation, traveler });
      expect(conflictedState.currentGoal.decisionGroupId).toBe(paidGroup.decisionGroupId);
      expect(conflictedState.activeDecisions.find((decision) => decision.decisionGroupId === paidGroup.decisionGroupId)?.status).toBe("conflicted");
      const correctionSet = buildCurrentCandidateSet({
        goal: conflictedState.currentGoal,
        observation,
        traveler,
        state: { taskState: conflictedState, approvals: {} }
      });
      expect(correctionSet.candidates.map((candidate) => candidate.controlId)).toEqual([paidGroup.removalControlId]);
      const correctionAction = loopPrivate.bindTargetSnapshot(
        actionForCurrentCandidate(conflictedState.currentGoal, correctionSet.candidates[0], observation),
        observation
      );
      const corrected = await executeAtomicBrowserDecision(
        page,
        toClientDecision(correctionAction),
        `obs_multi_surface_reversed_${index + 1}`
      );
      expect(corrected.validation.ok, corrected.validation.code).toBe(true);
      expect(corrected.verification.ok, JSON.stringify(corrected.verification)).toBe(true);
      expect(corrected.verification.evidence.ownedRemovalVerified).toBe(true);
      expect(corrected.verification.evidence.selectedChargeRemoved).toBe(true);
      expect(corrected.verification.evidence.afterPriceAmount).toBeLessThan(corrected.verification.evidence.beforePriceAmount);
      expect(corrected.observation.page.transactionFacts.selectedExtras).toEqual([]);
      expect(await page.locator("#selected-slot [data-selected-item]").count()).toBe(0);

      const cleanState = reduceTaskState({
        previousTaskState: conflictedState,
        observation: corrected.observation,
        previousActionResult: corrected.observation.lastActionResult,
        traveler
      });
      expect(cleanState.activeDecisions).toHaveLength(0);
      expect(cleanState.currentGoal.semanticType).toBe("navigation");
      const navigationSet = buildCurrentCandidateSet({
        goal: cleanState.currentGoal,
        observation: corrected.observation,
        traveler,
        state: { taskState: cleanState, approvals: {} }
      });
      const navigationCandidate = navigationSet.candidates.find((candidate) => candidate.controlId !== paidGroup.removalControlId);
      expect(navigationCandidate).toBeTruthy();
      const navigationAction = loopPrivate.bindTargetSnapshot(
        actionForCurrentCandidate(cleanState.currentGoal, navigationCandidate, corrected.observation),
        corrected.observation
      );
      const advanced = await executeAtomicBrowserDecision(
        page,
        toClientDecision(navigationAction),
        `obs_multi_surface_advanced_${index + 1}`
      );
      expect(advanced.validation.ok, advanced.validation.code).toBe(true);
      expect(advanced.verification.ok, JSON.stringify(advanced.verification)).toBe(true);
      previousTaskState = cleanState;
      observation = advanced.observation;
    }

    expect(new Set(observedGroupIds).size).toBe(2);
    expect(modelCalls).toBe(0);
    expect(await page.evaluate(() => window.__multiSurfaceCorrection)).toEqual({ reversals: [1, 1], advances: 2 });
    expect(await page.locator("body").getAttribute("data-stage")).toBe("payment-review");
  } finally {
    global.fetch = previousFetch;
  }
});

test("cross-surface paid ownership resolves an unknown foreground correction and executes it before navigation", async ({ page }) => {
  await loadHtmlProducer(page, `
    <aside aria-label="Order summary">
      <article id="paid-line" data-selected-item="optional-extra">Selected option <span>36 EUR</span></article>
    </aside>
    <div role="dialog" aria-modal="true" aria-label="Current selection">
      <h1>Current selection</h1>
      <p id="selected-summary">5E</p>
      <button id="cross-remove" data-testid="cross-remove" type="button">Remove</button>
      <button id="cross-next" data-testid="cross-next" type="button">Next</button>
    </div>
    <script>
      document.getElementById("cross-remove").addEventListener("click", () => {
        document.getElementById("paid-line")?.remove();
        document.getElementById("selected-summary").textContent = "Not selected";
      });
    </script>
  `);
  const traveler = { booking_rules: "No paid seats" };
  let observation = await browserObservation(page, "obs_cross_surface_live_paid");
  const removeId = observation.page.controls.find((control) => control.testId === "cross-remove").controlId;
  const nextId = observation.page.controls.find((control) => control.testId === "cross-next").controlId;
  const observedPaidGroup = observation.page.decisionGroups.find((group) => Number(group.selectedEvidence?.structuredPrice?.amount) === 36);
  expect(observedPaidGroup, JSON.stringify(observation.page.decisionGroups, null, 2)).toBeTruthy();
  const sourceGroupId = observedPaidGroup.decisionGroupId;
  observation.page.controls = observation.page.controls.map((control) => {
    if (control.controlId === removeId) {
      return {
        ...control,
        decisionGroupId: "dg_B",
        semantic: "unknown",
        physicalEffect: "unknown",
        risk: "uncertain",
        structuredPrice: null,
        selected: false,
        state: { ...(control.state || {}), selected: false, checked: false }
      };
    }
    if (control.controlId === nextId) {
      return { ...control, decisionGroupId: "dg_B", semantic: "navigation", physicalEffect: "advance_surface", risk: "safe_continue" };
    }
    return control;
  });
  observation.page.decisionGroups = [{
    ...observedPaidGroup,
    decisionGroupId: sourceGroupId,
    requirementId: sourceGroupId,
    sectionType: "unknown",
    sectionLabel: "Order summary",
    surfaceId: "surface-page",
    surfaceType: "page",
    required: false,
    status: "satisfied",
    selectedLabel: "Selected option 36 EUR",
    selectedSemantic: "selected_paid_item",
    selectedEvidence: { selected: true, disposition: "paid", structuredPrice: { amount: 36, currency: "EUR" } },
    semanticOwnership: { status: "unknown" },
    removalControlId: "",
    alternativeControlIds: []
  }, {
    decisionGroupId: "dg_B",
    requirementId: "dg_B",
    sectionType: "unknown",
    sectionLabel: "Selected summary",
    surfaceId: observation.page.currentSurface.id,
    surfaceType: "modal",
    required: false,
    status: "stale",
    selectedLabel: "5E",
    selectedEvidence: { selected: true, disposition: "unknown" },
    alternativeControlIds: [removeId, nextId]
  }];
  observation.page.transactionFacts = {
    ...(observation.page.transactionFacts || {}),
    selectedExtras: [{ decisionGroupId: sourceGroupId, label: "Selected option", disposition: "paid", priceAmount: 36, currency: "EUR" }]
  };
  const previousFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      status: "completed",
      model: "test-model",
      output_text: JSON.stringify({
        decisionGroupId: sourceGroupId,
        controlId: removeId,
        family: "seat",
        requirement: "optional",
        priceDisposition: "paid",
        policyCompatibility: "conflict",
        intendedOutcome: "remove_paid_selection",
        confidence: "high",
        rationale: "The foreground summary and grounded correction map to the selected paid transaction item."
      }),
      usage: { input_tokens: 30, output_tokens: 12, total_tokens: 42 }
    })
  });
  try {
    const resolved = await resolveSemanticOwnership({
      apiKey: "test-key",
      model: "test-model",
      observation,
      userPolicy: { bookingRules: traveler.booking_rules },
      traveler
    });
    observation = resolved.observation;
    let taskState = reduceTaskState({ observation, traveler });
    const candidateSet = buildCurrentCandidateSet({
      goal: taskState.currentGoal,
      observation,
      traveler,
      state: { taskState, approvals: {} }
    });
    expect(taskState.currentGoal.decisionGroupId).toBe(sourceGroupId);
    expect(candidateSet.candidates.map((candidate) => candidate.controlId)).toEqual([removeId]);
    expect(candidateSet.contextCapabilities.find((candidate) => candidate.controlId === nextId)).toBeUndefined();

    const action = loopPrivate.bindTargetSnapshot(
      actionForCurrentCandidate(taskState.currentGoal, candidateSet.candidates[0], observation),
      observation
    );
    expect(action.decisionGroupId).toBe(sourceGroupId);
    expect(action.targetSnapshot.decisionGroupId).toBe("dg_B");
    const executed = await executeAtomicBrowserDecision(page, toClientDecision(action), "obs_cross_surface_live_repaired");
    expect(executed.validation.ok, executed.validation.code).toBe(true);
    expect(executed.verification.ok, JSON.stringify(executed.verification)).toBe(true);
    expect(executed.verification.evidence.selectedChargeRemoved).toBe(true);
    expect(executed.observation.page.transactionFacts.selectedExtras).toEqual([]);
    expect(await page.locator("#paid-line").count()).toBe(0);

    taskState = reduceTaskState({ previousTaskState: taskState, observation: executed.observation, traveler });
    const navigation = buildCurrentCandidateSet({
      goal: taskState.currentGoal,
      observation: executed.observation,
      traveler,
      state: { taskState, approvals: {} }
    });
    expect(taskState.currentGoal.semanticType).toBe("navigation");
    expect(navigation.candidates.map((candidate) => candidate.controlId)).toEqual([nextId]);
    expect(navigation.candidates.some((candidate) => candidate.type === "ask_user")).toBe(false);
  } finally {
    global.fetch = previousFetch;
  }
});

test("a paid summary inside a broad traveler section preserves unknown semantic ownership", async ({ page }) => {
  await loadHtmlProducer(page, `
    <main>
      <h1>Reserve seating</h1>
      <section aria-label="Traveller information">
        <h2>Traveller information</h2>
        <article id="selected-item">
          <span>Selected item</span>
          <span>26 EUR</span>
          <button id="remove-item" type="button" data-action="remove">Remove</button>
        </article>
        <button id="advance" type="button">Proceed</button>
      </section>
    </main>
  `);

  const observation = await browserObservation(page, "obs_ambiguous_paid_summary");
  const group = observation.page.decisionGroups.find((item) => item.removalControlId);
  expect(group, JSON.stringify(observation.page.decisionGroups, null, 2)).toBeTruthy();
  expect(group.selectedEvidence).toMatchObject({
    selected: true,
    disposition: "paid",
    structuredPrice: { amount: 26, currency: "EUR" }
  });
  expect(group.sectionType).toBe("unknown");
  expect(group.semanticOwnership).toMatchObject({
    status: "unknown",
    nearbySectionType: "passenger"
  });
  const remove = observation.page.controls.find((control) => control.controlId === group.removalControlId);
  expect(remove).toMatchObject({
    decisionGroupId: group.decisionGroupId,
    physicalEffect: "select_free_option",
    risk: "safe_decline"
  });
});

test("an exact paid correction is not verified when it changes an unrelated selection", async ({ page }) => {
  await loadHtmlProducer(page, `
    <style>
      section { width: 520px; min-height: 110px; padding: 12px; }
      label { display: block; padding: 6px; }
    </style>
    <main>
      <h1>Trip options</h1>
      <section aria-label="Protection">
        <fieldset role="radiogroup" aria-label="Protection">
          <legend>Protection</legend>
          <label><input id="protection-paid" type="radio" name="protection" checked required> Coverage 20 EUR</label>
          <label><input id="protection-free" type="radio" name="protection" required> No coverage</label>
        </fieldset>
      </section>
      <section aria-label="Meal preference">
        <fieldset role="radiogroup" aria-label="Meal preference">
          <legend>Meal preference</legend>
          <label><input id="meal-none" type="radio" name="meal" checked required> No meal</label>
          <label><input id="meal-other" type="radio" name="meal" required> Different free meal</label>
        </fieldset>
      </section>
      <button id="advance" type="button">Proceed</button>
    </main>
    <script>
      document.getElementById("protection-free").addEventListener("click", () => {
        document.getElementById("meal-other").checked = true;
      });
    </script>
  `);

  const traveler = { booking_rules: "Decline all paid extras" };
  const observation = await browserObservation(page, "obs_unrelated_selection_before");
  const paidGroup = observation.page.decisionGroups.find((group) => (
    group.selectedEvidence?.disposition === "paid"
    && group.selectedEvidence?.structuredPrice?.amount === 20
  ));
  expect(paidGroup, JSON.stringify({
    sections: observation.page.sections,
    controls: observation.page.controls.map((control) => ({
      label: control.label,
      semantic: control.semantic,
      risk: control.risk,
      sectionId: control.sectionId,
      sectionType: control.sectionType,
      selected: control.selected
    })),
    decisionGroups: observation.page.decisionGroups
  }, null, 2)).toBeTruthy();
  const taskState = reduceTaskState({ observation, traveler });
  const candidateSet = buildCurrentCandidateSet({
    goal: taskState.currentGoal,
    observation,
    traveler,
    state: { taskState, approvals: {} }
  });
  expect(candidateSet.candidates).toHaveLength(1);
  const action = loopPrivate.bindTargetSnapshot(
    actionForCurrentCandidate(taskState.currentGoal, candidateSet.candidates[0], observation),
    observation
  );
  const executed = await executeAtomicBrowserDecision(page, toClientDecision(action), "obs_unrelated_selection_after");
  expect(executed.validation.ok, executed.validation.code).toBe(true);
  expect(executed.verification.ok).toBe(false);
  expect(executed.verification.evidence.unrelatedSelectionChanges).toHaveLength(1);
});

test("authoritative actionability excludes an occluded ghost and completes popup-to-summary navigation", async ({ page }) => {
  await loadHtmlProducer(page, `
    <style>
      body { font-family: sans-serif; margin: 24px; }
      .action { position: relative; display: inline-block; margin: 8px; }
      #ghost-cover { position: absolute; inset: 0; z-index: 3; background: rgba(255,255,255,.01); }
      #confirm { position: fixed; inset: 80px 120px; z-index: 20; background: white; border: 2px solid #222; padding: 24px; }
      [hidden] { display: none !important; }
    </style>
    <main id="checkout">
      <h1 id="stage">Seats</h1>
      <div id="initial-actions">
        <span class="action"><button id="ghost-next" type="button">Next</button><span id="ghost-cover"></span></span>
        <button id="real-next" type="button">Next</button>
      </div>
      <section id="summary" hidden><h2>Seat summary</h2><button id="summary-next" type="button">Next</button></section>
      <button id="pay" type="button" hidden>Pay now</button>
    </main>
    <div id="confirm" role="dialog" aria-modal="true" aria-label="Continue without seats?" hidden>
      <p>Continue without seats?</p><button id="confirm-continue" type="button">Continue</button>
    </div>
    <script>
      document.getElementById("real-next").addEventListener("click", () => { document.getElementById("confirm").hidden = false; });
      document.getElementById("confirm-continue").addEventListener("click", () => {
        document.getElementById("confirm").hidden = true;
        document.getElementById("initial-actions").hidden = true;
        document.getElementById("summary").hidden = false;
        document.getElementById("stage").textContent = "Summary";
      });
      document.getElementById("summary-next").addEventListener("click", () => {
        document.getElementById("summary").hidden = true;
        document.getElementById("pay").hidden = false;
        document.body.dataset.stage = "payment-review";
      });
    </script>
  `);

  const store = inMemoryGovernorStore();
  let state = createCheckoutSessionState({ goal: "Reach payment review safely", travelerId: "trav_actionability", site: { host: "example.test", url: page.url() } });
  state.id = "txn_actionability_replay";
  const traveler = { id: "trav_actionability", booking_rules: "no paid extras" };

  const executeCurrent = async (before, label, nextObservationId) => {
    const requirements = legacyRequirementReplay.requirementsWithDecisionGroups([], before);
    const taskState = reduceTaskState({
      previousTaskState: state.taskState || {},
      observation: before,
      previousActionResult: before.lastActionResult || null,
      userPolicy: state.approvals,
      traveler
    });
    const goal = taskState.currentGoal;
    const scopedState = { ...state, taskState, requirements, activeRequirements: requirements };
    const candidateSet = groundedObservationCandidateSet(goal, before, [], { state: scopedState, traveler, approvals: state.approvals });
    const candidate = candidateSet.candidates.find((item) => item.targetLabel === label);
    expect(candidate, JSON.stringify(candidateSet)).toBeTruthy();
    state = {
      ...scopedState,
      taskState: {
        ...taskState,
        currentGoal: { ...goal, candidateSet, candidates: candidateSet.candidates }
      },
      currentGoal: { ...goal, candidateSet, candidates: candidateSet.candidates },
      currentObservation: { observationId: before.observationId, observationHash: before.observationSnapshot.snapshotHash },
      requirements,
      activeRequirements: requirements
    };
    store.remember(state.id, before);
    const action = loopPrivate.bindTargetSnapshot(actionForCurrentCandidate(goal, candidate, before), before);
    const governed = governAction({ action, state, observation: before, traveler, store, turnId: nextObservationId });
    expect(governed.allow, `${governed.code}: ${governed.reason}`).toBe(true);
    state = governed.state || state;
    const executed = await executeAtomicBrowserDecision(page, toClientDecision(action), nextObservationId);
    expect(executed.validation.ok, JSON.stringify(executed.validation)).toBe(true);
    expect(executed.result.dispatched).toBe(true);
    return executed.observation;
  };

  let observation = await browserObservation(page, "obs_actionability_initial");
  const ghost = observation.page.controls.find((control) => control.label === "Next" && control.operations?.activate?.actionability?.executable === false);
  const real = observation.page.controls.find((control) => control.label === "Next" && control.operations?.activate?.actionability?.executable === true);
  expect(ghost).toBeTruthy();
  expect(ghost.operations.activate.actionability.code).toBe("ACTUATOR_OCCLUDED");
  expect(real).toBeTruthy();
  const initialTaskState = reduceTaskState({ observation, userPolicy: state.approvals, traveler });
  const initialGoal = initialTaskState.currentGoal;
  const initialCandidates = groundedObservationCandidateSet(initialGoal, observation, [], {
    state: { ...state, taskState: initialTaskState },
    traveler,
    approvals: state.approvals
  }).candidates;
  expect(initialCandidates.some((candidate) => candidate.controlId === ghost.controlId)).toBe(false);
  expect(initialCandidates.filter((candidate) => candidate.targetLabel === "Next")).toHaveLength(1);

  const initiallyValid = initialCandidates.find((candidate) => candidate.controlId === real.controlId);
  const liveGateAction = loopPrivate.bindTargetSnapshot(actionForCurrentCandidate(initialGoal, initiallyValid, observation), observation);
  await page.evaluate(() => {
    const target = document.getElementById("real-next");
    const box = target.getBoundingClientRect();
    const cover = document.createElement("div");
    cover.id = "late-cover";
    Object.assign(cover.style, { position: "fixed", left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px`, zIndex: "50", background: "rgba(255,255,255,.01)" });
    document.body.appendChild(cover);
  });
  const rejectedAtDispatch = await executeAtomicBrowserDecision(page, toClientDecision(liveGateAction), "obs_actionability_late_occlusion");
  expect(rejectedAtDispatch.validation.code).toBe("TARGET_OCCLUDED");
  expect(rejectedAtDispatch.result.dispatched).toBe(false);
  await page.locator("#late-cover").evaluate((node) => node.remove());

  observation = await executeCurrent(observation, "Next", "obs_actionability_popup");
  expect(observation.page.currentSurface.type).toBe("modal");
  expect(observation.page.currentSurface.label).toMatch(/continue without seats/i);
  expect(observation.page.currentSurface.surfaceClass).toBe("warning");
  expect(observation.page.controls.find((control) => control.label === "Continue")).toMatchObject({
    physicalEffect: "dismiss_surface"
  });
  observation = await executeCurrent(observation, "Continue", "obs_actionability_summary");
  expect(await page.locator("#stage").textContent()).toBe("Summary");
  await executeCurrent(observation, "Next", "obs_actionability_payment");
  expect(await page.locator("body").getAttribute("data-stage")).toBe("payment-review");
  expect(await page.locator("#pay").isVisible()).toBe(true);
});

test("task-scoped no-effect memory survives rerender while useful progress resets only the consecutive budget", async ({ page }) => {
  await loadHtmlProducer(page, `
    <main><h1>Optional choice</h1><p id="decision-instance">Flight 1 of 2</p><div id="actions"><button name="dead-next" type="button">Next</button><button id="continue-stage" type="button">Continue</button></div></main>
    <div id="confirm" role="dialog" aria-modal="true" aria-label="Confirm" hidden><button id="continue" type="button">Continue</button></div>
    <script>document.getElementById("continue-stage").addEventListener("click", () => { document.getElementById("confirm").hidden = false; });</script>
  `);

  const before = await browserObservation(page, "obs_memory_before");
  const taskState = reduceTaskState({ observation: before });
  const goal = taskState.currentObligation;
  const firstSet = groundedObservationCandidateSet(goal, before, [], {
    state: { taskState }
  });
  const dead = firstSet.candidates.find((candidate) => candidate.targetLabel === "Next");
  expect(dead).toBeTruthy();
  const deadAction = loopPrivate.bindTargetSnapshot(actionForCurrentCandidate(goal, dead, before), before);
  const deadExecution = await executeAtomicBrowserDecision(page, toClientDecision(deadAction), "obs_memory_no_effect");
  expect(deadExecution.result.dispatched).toBe(true);
  const failed = loopPrivate.applyTransitionStatus(withExecutionFixture({
    taskState: { ...taskState, currentGoal: goal },
    currentGoal: goal,
    lastAction: deadAction
  }, { recovery: { attempts: 0, phase: "idle", failedStrategies: [], failedStrategySignatures: [] } }), deadExecution.observation, before);
  expect(failed.transition.status).toBe("no_effect");
  expect(executionRecovery(failed.state).attempts).toBe(1);
  expect(executionRecovery(failed.state).failedStrategies).toHaveLength(1);

  await page.evaluate(() => {
    const old = document.querySelector("button[name='dead-next']");
    old.replaceWith(old.cloneNode(true));
  });
  const rerendered = await browserObservation(page, "obs_memory_rerendered");
  const rerenderedTaskState = reduceTaskState({
    previousTaskState: taskState,
    observation: rerendered,
    previousActionResult: rerendered.lastActionResult || null
  });
  const rerenderedGoal = rerenderedTaskState.currentObligation;
  const firstFailureSignatures = loopPrivate.failedStrategySignaturesForGoal(failed.state, rerenderedGoal, rerendered);
  expect(firstFailureSignatures).toHaveLength(1);
  const firstRetrySet = groundedObservationCandidateSet(rerenderedGoal, rerendered, firstFailureSignatures, {
    state: { taskState: rerenderedTaskState }
  });
  const distinctMethodRetry = firstRetrySet.candidates.find((candidate) => candidate.targetLabel === "Next");
  expect(distinctMethodRetry?.interactionMethod).toBe("native_click");
  const distinctMethodAction = loopPrivate.bindTargetSnapshot(
    actionForCurrentCandidate(rerenderedGoal, distinctMethodRetry, rerendered),
    rerendered
  );
  const distinctMethodExecution = await executeAtomicBrowserDecision(
    page,
    toClientDecision(distinctMethodAction),
    "obs_memory_second_no_effect"
  );
  const twiceFailed = loopPrivate.applyTransitionStatus({
    ...failed.state,
    taskState: { ...rerenderedTaskState, currentGoal: rerenderedGoal },
    currentGoal: rerenderedGoal,
    lastAction: distinctMethodAction
  }, distinctMethodExecution.observation, rerendered);
  expect(twiceFailed.transition.status).toBe("no_effect");
  expect(executionRecovery(twiceFailed.state).failedStrategies).toHaveLength(2);

  const secondFailureSignatures = loopPrivate.failedStrategySignaturesForGoal(
    twiceFailed.state,
    rerenderedGoal,
    distinctMethodExecution.observation
  );
  const secondRetrySet = groundedObservationCandidateSet(
    rerenderedGoal,
    distinctMethodExecution.observation,
    secondFailureSignatures,
    { state: { taskState: rerenderedTaskState } }
  );
  expect(secondRetrySet.candidates.some((candidate) => candidate.targetLabel === "Next")).toBe(false);
  const next = secondRetrySet.candidates.find((candidate) => candidate.targetLabel === "Continue");
  expect(next).toBeTruthy();

  const nextAction = loopPrivate.bindTargetSnapshot(
    actionForCurrentCandidate(rerenderedGoal, next, distinctMethodExecution.observation),
    distinctMethodExecution.observation
  );
  const nextExecution = await executeAtomicBrowserDecision(page, toClientDecision(nextAction), "obs_memory_progress");
  const progressed = loopPrivate.applyTransitionStatus({
    ...twiceFailed.state,
    taskState: { ...rerenderedTaskState, currentGoal: rerenderedGoal },
    currentGoal: rerenderedGoal,
    lastAction: nextAction
  }, nextExecution.observation, distinctMethodExecution.observation);
  expect(progressed.transition.status).toBe("progressed");
  expect(executionRecovery(progressed.state).attempts).toBe(0);
  expect(executionRecovery(progressed.state).failedStrategies).toHaveLength(0);

  await page.locator("#decision-instance").evaluate((node) => { node.textContent = "Flight 2 of 2"; });
  const nextInstanceObservation = await browserObservation(page, "obs_memory_next_instance");
  const nextInstanceTaskState = reduceTaskState({
    previousTaskState: rerenderedTaskState,
    observation: nextInstanceObservation
  });
  const nextInstanceFailures = loopPrivate.failedStrategySignaturesForGoal(
    progressed.state,
    nextInstanceTaskState.currentObligation,
    nextInstanceObservation
  );
  expect(nextInstanceFailures).toEqual([]);
});

test("live-shaped review modal keeps grounded safe controls selectable and submit reaches payment", async ({ page }) => {
  await page.goto("http://127.0.0.1:4273/checkout/traveler");
  await loadHtmlProducer(page, `
    <main>
      <h1 id="stage-title">Traveller information</h1>
      <button id="base-continue" type="button">Continue</button>
    </main>
    <div id="review" role="dialog" aria-modal="true" aria-label="Review your booking" hidden>
      <h2>Review your booking</h2>
      <p>Please check the traveller and flight details before payment.</p>
      <button id="review-close" type="button" data-testid="dialog-close" aria-label="Continue to Payment">
        <span aria-hidden="true">×</span>
      </button>
      <button id="review-edit" type="button" data-testid="edit-traveller">Edit</button>
      <form id="review-form" action="/checkout/payment" method="post">
        <button id="review-submit" type="submit" data-testid="info-review-submit-button">Continue to Payment</button>
      </form>
    </div>
    <section id="payment" hidden>
      <h1>Payment</h1>
      <label>Card number <input name="cardNumber" autocomplete="cc-number"></label>
      <button type="button" data-testid="card-number" aria-label="Card number" autocomplete="cc-number">Card number</button>
      <h2>Payment method</h2><p>Order amount: 430 EUR</p>
    </section>
    <script>
      const review = document.getElementById("review");
      document.getElementById("base-continue").addEventListener("click", () => { review.hidden = false; });
      document.getElementById("review-close").addEventListener("click", () => { review.hidden = true; });
      const showPayment = (event) => {
        event.preventDefault();
        review.hidden = true;
        document.querySelector("main").hidden = true;
        document.getElementById("payment").hidden = false;
        document.body.dataset.stage = "payment-review";
        history.pushState({}, "", "/checkout/payment");
      };
      document.getElementById("review-form").addEventListener("submit", showPayment);
      document.getElementById("review-submit").addEventListener("click", showPayment);
    </script>
  `);

  const baseObservation = await browserObservation(page, "obs_live_review_base");
  const baseTaskState = reduceTaskState({ observation: baseObservation });
  await page.locator("#base-continue").click();
  const reviewObservation = await browserObservation(page, "obs_live_review_modal");
  const reviewTaskState = reduceTaskState({
    previousTaskState: baseTaskState,
    observation: reviewObservation
  });

  const close = reviewObservation.page.controls.find((control) => control.testId === "dialog-close");
  const edit = reviewObservation.page.controls.find((control) => control.testId === "edit-traveller");
  const submit = reviewObservation.page.controls.find((control) => control.testId === "info-review-submit-button");
  expect(reviewObservation.page.currentSurface.surfaceClass).toBe("review_confirmation");
  expect(close).toMatchObject({ physicalEffect: "dismiss_surface", semantic: "dismiss_surface" });
  expect(edit).toMatchObject({ physicalEffect: "open_surface", semantic: "open_surface" });
  expect(submit).toMatchObject({ physicalEffect: "advance_checkout_stage" });
  expect(reviewObservation.page.decisionGroups.some((group) => group.surfaceId === reviewObservation.page.currentSurface.id)).toBe(false);
  expect(reviewTaskState.stageOutcome.outcomeId).toBe(baseTaskState.stageOutcome.outcomeId);
  expect(reviewTaskState.stageOutcome.status).toBe("active");
  expect(reviewTaskState.surfaceSubgoal.parentOutcomeId).toBe(reviewTaskState.stageOutcome.outcomeId);

  const candidateSet = buildCurrentCandidateSet({
    goal: reviewTaskState.currentGoal,
    observation: reviewObservation,
    state: { taskState: reviewTaskState, approvals: {} }
  });
  expect(new Set(candidateSet.candidates.map((candidate) => candidate.controlId))).toEqual(new Set([close.controlId, submit.controlId]));
  expect(candidateSet.contextCapabilities.find((candidate) => candidate.controlId === close.controlId)).toMatchObject({
    selectable: true,
    mechanicalEffect: "dismiss_surface",
    semanticIntent: "advance_checkout_stage",
    outcomeCompatibility: "obligation_admitted"
  });
  expect(candidateSet.contextCapabilities.find((candidate) => candidate.controlId === edit.controlId)).toBeUndefined();
  const submitCandidate = candidateSet.candidates.find((candidate) => candidate.controlId === submit.controlId);
  expect(submitCandidate).toMatchObject({
    mechanicalEffect: "advance_checkout_stage",
    semanticIntent: "advance_checkout_stage",
    outcomeCompatibility: "obligation_admitted"
  });

  const action = actionForCurrentCandidate(reviewTaskState.currentGoal, submitCandidate, reviewObservation);
  const executed = await executeAtomicBrowserDecision(page, toClientDecision(action), "obs_live_review_payment");
  expect(executed.result.dispatched).toBe(true);
  const paymentTaskState = reduceTaskState({
    previousTaskState: reviewTaskState,
    observation: executed.observation,
    previousActionResult: executed.result,
    transactionReview: verifiedTransactionReview(430)
  });
  expect(paymentTaskState.stageOutcome.outcomeId).toBe(reviewTaskState.stageOutcome.outcomeId);
  expect(paymentTaskState.stageOutcome.status, JSON.stringify({
    stage: paymentTaskState.stage,
    evidence: paymentTaskState.stageDecisionEvidence,
    controls: executed.observation.page.controls,
    fields: executed.observation.page.fields,
    sections: executed.observation.page.sections,
    surface: executed.observation.page.currentSurface
  }, null, 2)).toBe("completed");
  expect(paymentTaskState.terminalStatus).toBe("payment_review_reached");
});

test("paid-only seat map treats Next as navigation instead of inventing a free-seat obligation", async ({ page }) => {
  await loadHtmlProducer(page, `
    <div role="dialog" aria-modal="true" aria-label="Reserve seating">
      <h1>Reserve seating</h1>
      <p>Flight 1 of 2</p>
      <div role="group" aria-label="Available seats">
        <button type="button" data-testid="seat-5a" data-price="29" aria-label="Seat 5A, 29 EUR">5A</button>
        <button type="button" data-testid="seat-5b" data-price="29" aria-label="Seat 5B, 29 EUR">5B</button>
      </div>
      <button id="seat-next" type="button" data-testid="seat-next">Next</button>
    </div>
  `);

  const observation = await browserObservation(page, "obs_paid_only_seats");
  const taskState = reduceTaskState({
    observation,
    userPolicy: { bookingRules: "No paid seats", skipPaidExtrasApproved: true },
    traveler: { booking_rules: "No paid seats" }
  });
  const candidateSet = buildCurrentCandidateSet({
    goal: taskState.currentGoal,
    observation,
    traveler: { booking_rules: "No paid seats" },
    state: { taskState, approvals: { skipPaidExtrasApproved: true } }
  });

  expect(taskState.activeDecisions).toHaveLength(0);
  expect(taskState.currentGoal.semanticType).toBe("navigation");
  expect(candidateSet.candidates).toHaveLength(1);
  expect(candidateSet.candidates[0].targetLabel).toBe("Next");
  expect(candidateSet.contextCapabilities.filter((candidate) => /seat 5/i.test(candidate.targetLabel || "")).every((candidate) => !candidate.selectable)).toBe(true);
});

test("post-navigation page shell is transient until traveler controls hydrate", async ({ page }) => {
  await loadHtmlProducer(page, `
    <main id="traveler-shell" aria-busy="true">
      <h1>Traveller information</h1>
      <nav><button type="button">English</button><button type="button">Support</button></nav>
      <div id="traveler-content"></div>
    </main>
  `);
  const shell = await browserObservation(page, "obs_hydration_shell");
  shell.lastActionResult = {
    feedback: { navigationOccurred: true, pageChanged: true },
    action: { semanticIntent: "advance_checkout_stage", mechanicalEffect: "advance_checkout_stage" }
  };
  const transient = classifyObservationReadiness({ observation: shell });
  expect(shell.page.readiness.ariaBusy).toBe(true);
  expect(transient.classification).toBe(READINESS.TRANSIENT);

  await page.evaluate(() => {
    const main = document.getElementById("traveler-shell");
    main.setAttribute("aria-busy", "false");
    document.getElementById("traveler-content").innerHTML = `
      <label>Email <input name="email" type="email" required></label>
      <label>First name <input name="firstName" required></label>
      <label>Last name <input name="lastName" required></label>
      <button type="button">Continue</button>
    `;
  });
  const hydrated = await browserObservation(page, "obs_hydration_ready");
  const ready = classifyObservationReadiness({ observation: hydrated, previousReadiness: transient });
  expect(hydrated.page.summary.fields).toBeGreaterThan(0);
  expect(ready.classification).toBe(READINESS.READY);
});

test("Kiwi-shaped seat shell ignores persistent extras query parameters and resumes after hydration", async ({ page }) => {
  await page.goto("http://127.0.0.1:4273/en/booking/?activeStep=2&holdBags=15kg&insurance=0");
  await loadHtmlProducer(page, `
    <main id="seat-stage">
      <h1>Select your seats</h1>
      <p>Find the most comfortable seats for your group.</p>
      <p id="seat-loading">Please wait for the seating options to load.</p>
      <div id="seat-content"></div>
    </main>
    <aside><p>Checked baggage 15 kg Included</p><button type="button">View price breakdown</button></aside>
  `);

  const shell = await browserObservation(page, "obs_kiwi_shaped_seat_shell");
  shell.lastActionResult = {
    feedback: { navigationOccurred: true, pageChanged: true },
    action: { semanticIntent: "advance_checkout_stage", mechanicalEffect: "advance_checkout_stage" }
  };
  const transient = classifyObservationReadiness({ observation: shell });

  expect(page.url()).toContain("insurance=0");
  expect(shell.page.step).toBe("seats");
  expect(shell.page.readiness.loadingTextEvidence).toBe(true);
  expect(transient.classification).toBe(READINESS.TRANSIENT);
  expect(transient.evidence.expectedStage).toBeUndefined();

  await page.evaluate(() => {
    document.getElementById("seat-loading").remove();
    document.getElementById("seat-content").innerHTML = `
      <section aria-label="Select a seat on the map">
        <button type="button" data-price="19" aria-label="Seat 1A, 19 EUR">1A</button>
        <button id="seat-continue" type="button">Continue</button>
      </section>
    `;
  });

  const hydrated = await browserObservation(page, "obs_kiwi_shaped_seat_ready");
  hydrated.lastActionResult = shell.lastActionResult;
  const ready = classifyObservationReadiness({
    observation: hydrated,
    previousReadiness: transient
  });

  expect(hydrated.page.step).toBe("seats");
  expect(hydrated.page.readiness.loadingTextEvidence).toBe(false);
  expect(hydrated.page.controls.some((control) => control.label === "Continue")).toBe(true);
  expect(ready.classification).toBe(READINESS.READY);
});

test("mechanical readiness does not reinterpret shell meaning across checkout stages", async ({ page }) => {
  await loadHtmlProducer(page, `
    <main id="destination"><h1>Checkout</h1></main>
  `);

  const scenarios = [
    {
      stage: "traveler_information",
      heading: "Traveller information",
      complete: `
        <label>Email <input name="email" type="email" required></label>
        <label>First name <input name="firstName" required></label>
        <button type="button">Continue</button>
      `
    },
    {
      stage: "extras",
      heading: "Optional extras",
      complete: `
        <fieldset><legend>Trip protection</legend>
          <label><input type="radio" name="protection" value="none" data-price="0">Without protection</label>
          <label><input type="radio" name="protection" value="premium" data-price="25">Protection 25 EUR</label>
        </fieldset>
        <button type="button">Continue</button>
      `
    },
    {
      stage: "seats",
      heading: "Seat selection",
      complete: `
        <div role="dialog" aria-modal="true" aria-label="Seat selection">
          <button type="button" data-price="19" aria-label="Seat 5A, 19 EUR">5A</button>
          <button type="button">Next</button>
        </div>
      `
    },
    {
      stage: "payment",
      heading: "Payment details",
      complete: `
        <label>Card number <input name="cardNumber" autocomplete="cc-number"></label>
        <label>Expiry <input name="expiry" autocomplete="cc-exp"></label>
        <button type="button">Pay now</button>
      `
    }
  ];

  for (const scenario of scenarios) {
    await page.evaluate(({ heading }) => {
      document.getElementById("destination").innerHTML = `
        <h1>${heading}</h1>
        <nav>
          ${Array.from({ length: 8 }, (_, index) => `<button type="button">Header ${index + 1}</button>`).join("")}
        </nav>
        <aside><h2>Your order</h2><p>Payment options</p><p>Amount to pay 420 EUR</p></aside>
      `;
    }, scenario);
    const shell = await browserObservation(page, `obs_${scenario.stage}_shell`);
    shell.page.step = scenario.stage;
    shell.lastActionResult = {
      feedback: { navigationOccurred: true, pageChanged: true },
      action: { semanticIntent: "advance_checkout_stage", mechanicalEffect: "advance_checkout_stage" }
    };
    const shellReadiness = classifyObservationReadiness({ observation: shell });
    expect(await page.locator("#destination button").count()).toBeGreaterThan(4);
    expect(shellReadiness.classification).toBe(READINESS.READY);

    await page.evaluate(({ heading }) => {
      document.getElementById("destination").innerHTML = `
        <h1>${heading}</h1>
        <section><p>The destination layout is visible, but its interactive checkout content is still hydrating.</p></section>
        <aside><p>Payment options</p><p>Amount to pay 420 EUR</p></aside>
      `;
    }, scenario);
    const partial = await browserObservation(page, `obs_${scenario.stage}_partial`);
    partial.page.step = scenario.stage;
    partial.lastActionResult = shell.lastActionResult;
    const partialReadiness = classifyObservationReadiness({
      observation: partial,
      previousReadiness: shellReadiness
    });
    expect(partialReadiness.classification).toBe(READINESS.READY);

    await page.evaluate(({ heading, complete }) => {
      document.getElementById("destination").innerHTML = `<h1>${heading}</h1>${complete}`;
    }, scenario);
    const complete = await browserObservation(page, `obs_${scenario.stage}_complete`);
    complete.page.step = scenario.stage;
    complete.lastActionResult = shell.lastActionResult;
    if (scenario.stage === "payment") {
      complete.page.url = "https://example.test/checkout/payment";
    }
    const ready = classifyObservationReadiness({
      observation: complete,
      previousReadiness: partialReadiness
    });
    expect(
      ready.classification,
      `${scenario.stage}: ${JSON.stringify({ evidence: ready.evidence, controls: complete.page.controls })}`
    ).toBe(READINESS.READY);
    expect(ready.evidence.expectedStage).toBeUndefined();
  }
});

test("/rf/start is classified as a new flight-search page despite stale extras copy", async ({ page }) => {
  await page.goto("http://127.0.0.1:4273/rf/start");
  await loadHtmlProducer(page, `
    <main>
      <h1>Start a new flight search</h1>
      <p>Configure your trip and choose your bundle after selecting flights.</p>
      <button type="button">Search flights</button>
    </main>
  `);
  const map = await page.evaluate(() => window.__ATW_TEST__.buildPageMap());
  expect(page.url()).toContain("/rf/start");
  expect(map.step).toBe("flight_selection");
});

test("one reversible local mechanic retries an unchanged native opener with the same trusted actuator", async ({ page }) => {
  await loadHtmlProducer(page, `
    <main>
      <label>Title <button id="title-trigger" type="button" aria-haspopup="listbox" aria-expanded="false">Select title</button></label>
    </main>
  `);
  const result = await page.evaluate(async () => {
    const hooks = window.__ATW_TEST__;
    const map = hooks.buildPageMap();
    const control = map.controls.find((item) => item.label.includes("Select title"));
    const target = document.getElementById("title-trigger");
    const targetSnapshot = hooks.liveTargetSnapshot(target, map);
    target.click = () => {};
    window.__ATW_TEST_TRUSTED_INPUT__ = ({ element }) => {
      element.setAttribute("aria-expanded", "true");
      element.dataset.trustedFallback = "used";
      return { ok: true };
    };
    const decision = {
      action: "click",
      actionId: "act_local_title",
      observationId: "obs_local_title",
      controlId: targetSnapshot.controlId,
      targetId: targetSnapshot.id,
      operation: "open",
      interactionMethod: "native_click",
      intent: "satisfy_semantic_goal",
      semanticEffect: "open_surface",
      risk: "safe",
      targetSnapshot
    };
    const dispatched = await hooks.dispatchGovernedClickMechanic(target, decision, {
      actionId: decision.actionId,
      observationId: decision.observationId
    });
    return {
      allowed: hooks.boundedLocalClickMechanicAllowed(decision),
      dispatched,
      expanded: target.getAttribute("aria-expanded"),
      trustedFallback: target.dataset.trustedFallback
    };
  });
  expect(result.allowed).toBe(true);
  expect(result.dispatched).toMatchObject({ ok: true, fallbackUsed: true, method: "browser_trusted_input" });
  expect(result.expanded).toBe("true");
  expect(result.trustedFallback).toBe("used");
});
