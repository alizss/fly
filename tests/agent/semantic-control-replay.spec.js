const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("@playwright/test");

const fixturePath = path.join(__dirname, "..", "fixtures", "semantic-controls", "seat-baggage.html");
const profileFixturePath = path.join(__dirname, "..", "fixtures", "semantic-controls", "profile-form.html");
const contentScriptPath = path.join(__dirname, "..", "..", "apps", "extension", "src", "content", "content.js");

async function loadProducer(page, sourcePath = fixturePath) {
  await page.setContent(fs.readFileSync(sourcePath, "utf8"));
  await page.evaluate(() => { window.__ATW_ENABLE_TEST_HOOKS__ = true; });
  await page.addScriptTag({ path: contentScriptPath });
  await page.waitForFunction(() => Boolean(window.__ATW_TEST__));
}

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

test("P0.9 registry replacement removes stale ownership", async ({ page }) => {
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
      controlIds: registry.controls().map((control) => control.controlId),
      datasetId: node.dataset.atwControlId || "",
      conflicts: registry.conflicts
    };
  });

  expect(result.foregroundId).not.toBe(result.backgroundId);
  expect(result.ownerId).toBe(result.foregroundId);
  expect(result.datasetId).toBe(result.foregroundId);
  expect(result.controlIds).toContain(result.foregroundId);
  expect(result.controlIds).not.toContain(result.backgroundId);
  expect(result.conflicts).toHaveLength(1);
  expect(result.conflicts[0].resolved).toBe(true);
  expect(result.conflicts[0].resolvedBy).toBe("foreground_or_higher_priority");
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
    const beforeWindow = window.scrollY;
    const nearest = hooks.nearestEffectiveScrollContainer(target);
    const dispatched = hooks.scrollElementWithinNearestContainer(target, { behavior: "auto" });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const afterNested = scroller.scrollTop;
    const afterWindow = window.scrollY;
    target.remove();
    const missing = hooks.scrollElementWithinNearestContainer(null, { behavior: "auto" });
    return {
      nearestId: nearest.id,
      dispatched: {
        ok: dispatched.ok,
        code: dispatched.code,
        containerId: dispatched.containerId,
        containerType: dispatched.containerType
      },
      beforeWindow,
      afterNested,
      afterWindow,
      missing
    };
  });

  expect(result.nearestId).toBe("nested-scroll");
  expect(result.dispatched.containerType).toBe("element");
  expect(result.afterNested).toBeGreaterThan(0);
  expect(result.afterWindow).toBe(result.beforeWindow);
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
