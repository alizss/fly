export function createInteractionMechanics(dependencies) {
  const {
    activeOverlayElements,
    choiceInteractionStates,
    elementBox,
    elementById,
    elementDescriptor,
    elementId,
    isStageExitDecision,
    isTransientChoiceOverlay,
    isVisible,
    logFlow,
    normalizeMatchText,
    pageSnapshot,
    pageStateStore,
    pushActionLedger,
    queryAllDeep,
    rememberChoiceActuatorBinding,
    resolveDecisionTarget,
    setAgentActivity,
    sleep,
    updateChoiceInteractionState,
    validateResolvedTarget,
    withAgentUiPointerPassthrough
  } = dependencies;

  function userLikeClick(element, meta = {}) {
    const rect = element.getBoundingClientRect();
    const hitTarget = document.elementFromPoint(
      Math.min(window.innerWidth - 2, Math.max(2, rect.left + rect.width / 2)),
      Math.min(window.innerHeight - 2, Math.max(2, rect.top + rect.height / 2))
    );
    const eventInit = {
      bubbles: true,
      cancelable: true,
      view: window,
      button: 0,
      buttons: 1,
      detail: 1,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      clientX: Math.round(rect.left + rect.width / 2),
      clientY: Math.round(rect.top + rect.height / 2)
    };
    logFlow("dom.click.dispatch", {
      meta,
      point: { x: eventInit.clientX, y: eventInit.clientY },
      target: elementDescriptor(element),
      hitTarget: elementDescriptor(hitTarget),
      pageBefore: pageSnapshot("before-click")
    });
    watchClickToFirstMutation("click", meta);
    element.dispatchEvent(new PointerEvent("pointerdown", eventInit));
    element.dispatchEvent(new MouseEvent("mousedown", eventInit));
    element.dispatchEvent(new PointerEvent("pointerup", { ...eventInit, buttons: 0 }));
    element.dispatchEvent(new MouseEvent("mouseup", { ...eventInit, buttons: 0 }));
    element.dispatchEvent(new MouseEvent("click", { ...eventInit, buttons: 0 }));
  }

  function nativeElementClick(element, meta = {}) {
    if (!element || typeof element.click !== "function") return false;
    logFlow("dom.native_click.dispatch", {
      meta,
      target: elementDescriptor(element),
      pageBefore: pageSnapshot("before-native-click")
    });
    watchClickToFirstMutation("native_click", meta);
    element.click();
    return true;
  }

  async function trustedBrowserClick(element, decision = {}) {
    if (!element) return { ok: false, code: "CANONICAL_ACTUATOR_UNAVAILABLE" };
    const rect = element.getBoundingClientRect();
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);
    return withAgentUiPointerPassthrough(async () => {
      if (typeof globalThis.__ATW_TEST_TRUSTED_INPUT__ === "function") {
        return globalThis.__ATW_TEST_TRUSTED_INPUT__({ element, x, y, decision });
      }
      if (!globalThis.chrome?.runtime?.sendMessage) {
        return { ok: false, code: "TRUSTED_INPUT_UNAVAILABLE" };
      }
      try {
        return await chrome.runtime.sendMessage({
          type: "ATW_TRUSTED_POINTER_CLICK",
          governed: true,
          actionId: decision.actionId || decision.id || "",
          observationId: decision.observationId || "",
          controlId: decision.controlId || "",
          x,
          y
        });
      } catch (error) {
        return { ok: false, code: "TRUSTED_INPUT_UNAVAILABLE", error: error.message };
      }
    });
  }

  function boundedLocalClickMechanicAllowed(decision = {}) {
    const operation = String(decision.operation || "").toLowerCase();
    const risk = String(decision.risk || decision.targetSnapshot?.risk || "").toLowerCase();
    const effect = String([
      decision.intent,
      decision.semanticEffect,
      decision.physicalEffect,
      decision.mechanicalEffect,
      decision.targetSnapshot?.semantic
    ].filter(Boolean).join(" ")).toLowerCase();
    return ["open", "choose", "select", "activate"].includes(operation)
      && !isStageExitDecision(decision)
      && !/money|paid|payment|purchase|legal|consent|account|login|itinerary/.test(`${risk} ${effect}`);
  }

  function localMechanicReactionSnapshot(element) {
    return JSON.stringify({
      connected: Boolean(element?.isConnected),
      expanded: element?.getAttribute?.("aria-expanded") || "",
      checked: element?.getAttribute?.("aria-checked") || element?.checked || false,
      selected: element?.getAttribute?.("aria-selected") || element?.selected || false,
      value: element?.value || "",
      text: String(element?.innerText || element?.textContent || "").replace(/\s+/g, " ").trim()
    });
  }

  async function waitForLocalMechanicReaction(element, before, timeoutMs = 320) {
    const startedAt = performance.now();
    while (performance.now() - startedAt < timeoutMs) {
      if (localMechanicReactionSnapshot(element) !== before) return true;
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    return localMechanicReactionSnapshot(element) !== before;
  }

  async function dispatchGovernedClickMechanic(element, decision = {}, meta = {}) {
    const reactionBefore = localMechanicReactionSnapshot(element);
    let choiceCommitResult = null;
    let primary = { ok: true, method: decision.interactionMethod || "pointer_sequence" };
    if (decision.interactionMethod === "native_click") {
      primary = nativeElementClick(element, meta)
        ? { ok: true, method: "native_click" }
        : { ok: false, code: "NATIVE_CLICK_UNAVAILABLE", method: "native_click" };
    } else if (decision.interactionMethod === "browser_trusted_input") {
      primary = await trustedBrowserClick(element, { ...decision, ...meta });
    } else if (decision.interactionMethod === "browser_trusted_choice") {
      primary = await trustedBrowserChoice(element, { ...decision, ...meta });
      if (primary?.ok === true) {
        choiceCommitResult = await settleTrustedChoiceInteraction(element, { ...decision, ...meta });
      }
    } else {
      userLikeClick(element, { ...meta, method: decision.interactionMethod || "pointer_sequence" });
    }
    if (primary?.ok !== true) return { ...primary, choiceCommitResult };

    const mayFallback = boundedLocalClickMechanicAllowed(decision)
      && !["browser_trusted_input", "browser_trusted_choice"].includes(decision.interactionMethod);
    const reactionObserved = mayFallback
      ? await waitForLocalMechanicReaction(element, reactionBefore)
      : false;
    if (!mayFallback || reactionObserved) {
      return {
        ok: true,
        method: primary.method || decision.interactionMethod || "pointer_sequence",
        choiceCommitResult,
        reactionObserved
      };
    }

    // Reuse only the exact still-connected actuator from this action lease.
    // A fallback mechanic does not need to reconstruct the whole checkout
    // scene; if the node was replaced, canonical re-observation owns recovery
    // on the next turn rather than silently rebinding here.
    const currentMap = pageStateStore.current();
    const freshTarget = element?.isConnected && isVisible(element) ? element : null;
    const validation = freshTarget && currentMap
      ? validateResolvedTarget(decision, freshTarget, currentMap)
      : freshTarget
        ? { ok: true, code: "SAME_LEASED_ACTUATOR_REUSED" }
        : { ok: false, code: "TARGET_DISAPPEARED" };
    if (!validation.ok) {
      return { ok: true, method: primary.method || decision.interactionMethod || "pointer_sequence", choiceCommitResult };
    }
    const fallback = await trustedBrowserClick(freshTarget, { ...decision, ...meta });
    pushActionLedger({
      actionId: meta.actionId || decision.actionId || decision.id || "",
      observationId: meta.observationId || decision.observationId || "",
      stage: "local_mechanic_fallback",
      action: decision,
      primaryMethod: primary.method || decision.interactionMethod || "pointer_sequence",
      fallbackMethod: "browser_trusted_input",
      fallbackCode: fallback?.code || ""
    });
    return {
      // The primary mechanic was dispatched. An unavailable optional fallback
      // must not rewrite that fact as a pre-dispatch failure; canonical
      // verification below decides whether the action worked.
      ok: true,
      code: fallback?.ok === true ? "LOCAL_FALLBACK_DISPATCHED" : (fallback?.code || "LOCAL_FALLBACK_UNAVAILABLE"),
      method: fallback?.ok === true ? "browser_trusted_input" : (primary.method || decision.interactionMethod || "pointer_sequence"),
      fallbackUsed: fallback?.ok === true,
      choiceCommitResult
    };
  }

  async function trustedBrowserChoice(element, decision = {}) {
    if (!element) return { ok: false, code: "CANONICAL_ACTUATOR_UNAVAILABLE" };
    const choiceLabel = String(decision.value || "").trim();
    if (!choiceLabel) return { ok: false, code: "TRUSTED_CHOICE_VALUE_MISSING" };
    rememberChoiceActuatorBinding(decision.controlId, element, decision);
    const previousInteraction = choiceInteractionStates.get(String(decision.controlId || "").trim()) || {};
    updateChoiceInteractionState(decision.controlId, {
      status: "dispatched",
      actuatorId: elementId(element),
      desiredLabel: choiceLabel,
      attempts: Number(previousInteraction.attempts || 0) + 1,
      popupClosed: false,
      focusSettled: false
    });
    const rect = element.getBoundingClientRect();
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);
    return withAgentUiPointerPassthrough(async () => {
      if (typeof globalThis.__ATW_TEST_TRUSTED_CHOICE__ === "function") {
        const result = await globalThis.__ATW_TEST_TRUSTED_CHOICE__({ element, x, y, choiceLabel, decision });
        if (result?.ok !== true) {
          updateChoiceInteractionState(decision.controlId, {
            status: "unsettled",
            code: result?.code || "TRUSTED_INPUT_UNAVAILABLE"
          });
        }
        return result;
      }
      if (!globalThis.chrome?.runtime?.sendMessage) {
        return { ok: false, code: "TRUSTED_INPUT_UNAVAILABLE" };
      }
      try {
        const result = await chrome.runtime.sendMessage({
          type: "ATW_TRUSTED_CHOICE",
          governed: true,
          actionId: decision.actionId || decision.id || "",
          observationId: decision.observationId || "",
          controlId: decision.controlId || "",
          choiceLabel,
          x,
          y
        });
        if (result?.ok !== true) {
          updateChoiceInteractionState(decision.controlId, {
            status: "unsettled",
            code: result?.code || "TRUSTED_INPUT_UNAVAILABLE"
          });
        }
        return result;
      } catch (error) {
        updateChoiceInteractionState(decision.controlId, {
          status: "unsettled",
          code: "TRUSTED_INPUT_UNAVAILABLE"
        });
        return { ok: false, code: "TRUSTED_INPUT_UNAVAILABLE", error: error.message };
      }
    });
  }

  async function trustedBrowserKey(key = "", decision = {}) {
    const normalizedKey = String(key || "");
    if (!["Escape", "Tab"].includes(normalizedKey)) {
      return { ok: false, code: "TRUSTED_KEY_UNSUPPORTED" };
    }
    if (typeof globalThis.__ATW_TEST_TRUSTED_KEY__ === "function") {
      return globalThis.__ATW_TEST_TRUSTED_KEY__({ key: normalizedKey, decision });
    }
    if (!globalThis.chrome?.runtime?.sendMessage) {
      return { ok: false, code: "TRUSTED_INPUT_UNAVAILABLE" };
    }
    try {
      return await chrome.runtime.sendMessage({
        type: "ATW_TRUSTED_KEY",
        governed: true,
        actionId: decision.actionId || decision.id || "",
        observationId: decision.observationId || "",
        controlId: decision.controlId || "",
        key: normalizedKey
      });
    } catch (error) {
      return { ok: false, code: "TRUSTED_INPUT_UNAVAILABLE", error: error.message };
    }
  }

  function visibleChoiceSurfacesForValue(choiceLabel = "") {
    const wanted = normalizeMatchText(choiceLabel);
    return queryAllDeep("[role='listbox'], [role='menu'], [role='tree'], [data-headlessui-state~='open']")
      .filter((surface) => (
        isVisible(surface)
        && !surface.closest?.("#atw-sidebar")
        && (
          !wanted
          || normalizeMatchText(surface.innerText || surface.textContent || "").includes(wanted)
        )
      ));
  }

  function choiceEpisodeEvidence(target, decision = {}, map = null) {
    const control = (map?.controls || []).find((item) => item.controlId === decision.controlId) || null;
    const activeSurface = map?.currentSurface || {};
    const liveChoiceSurfaces = queryAllDeep("[role='listbox'], [role='menu'], [data-headlessui-state='open'], [aria-expanded='true'], .popover")
      .filter((surface) => !surface.closest?.("#atw-sidebar") && isVisible(surface))
      .filter((surface) => (
        isTransientChoiceOverlay(surface)
        || /dropdown|listbox|menu|popover|choice|option|tree/.test(String(surface.getAttribute?.("role") || "").toLowerCase())
      ));
    const activeChoiceSurface = Boolean(
      liveChoiceSurfaces.length
      || (
        activeSurface.type
        && activeSurface.type !== "page"
        && /dropdown|listbox|menu|popover|choice|option|tree/.test(String(activeSurface.type || "").toLowerCase())
      )
    );
    const expanded = Boolean(
      control?.state?.expanded === true
      || target?.getAttribute?.("aria-expanded") === "true"
      || target?.closest?.("[aria-expanded='true']")
    );
    const visibleChoiceSurfaces = visibleChoiceSurfacesForValue(decision.value || decision.targetLabel || "");
    const relatedElements = [
      target,
      elementById(control?.stateElementId || ""),
      elementById(control?.preferredActivationElementId || ""),
      ...Object.values(control?.operations || {}).flatMap((capability) => (
        capability?.actuatorIds || []
      )).map(elementById)
    ].filter(Boolean);
    const focusInsideTarget = Boolean(
      document.activeElement
      && relatedElements.some((element) => (
        document.activeElement === element
        || element.contains?.(document.activeElement)
      ))
    );
    return {
      activeChoiceSurface,
      expanded,
      visibleChoiceSurfaceCount: visibleChoiceSurfaces.length,
      popupOpen: Boolean(activeChoiceSurface || expanded || visibleChoiceSurfaces.length),
      focusInsideTarget,
      activeElementId: document.activeElement ? elementId(document.activeElement) : "",
      surfaceId: activeSurface.id || (liveChoiceSurfaces[0] ? elementId(liveChoiceSurfaces[0]) : ""),
      surfaceType: activeSurface.type || (liveChoiceSurfaces.length ? "choice_overlay" : "page"),
      continueDisabled: map?.stageExit?.continueDisabled === true
    };
  }

  async function settleTrustedChoiceInteraction(target, decision = {}) {
    await waitForUiSettle(180);
    const beforeCleanup = choiceEpisodeEvidence(target, decision);
    let escapeAttempted = false;
    let tabAttempted = false;
    let escapeResult = null;
    let tabResult = null;

    if (beforeCleanup.popupOpen) {
      escapeAttempted = true;
      escapeResult = await trustedBrowserKey("Escape", decision);
      if (escapeResult?.ok !== true) pressEscape(document.activeElement || target);
      await waitForUiSettle(180);
    }

    const afterEscape = choiceEpisodeEvidence(target, decision);
    if (afterEscape.popupOpen || afterEscape.focusInsideTarget) {
      tabAttempted = true;
      tabResult = await trustedBrowserKey("Tab", decision);
      if (tabResult?.ok !== true) target?.blur?.();
      await waitForUiSettle(220);
    }

    const afterCleanup = choiceEpisodeEvidence(target, decision);
    const popupClosed = !afterCleanup.popupOpen;
    const focusSettled = !afterCleanup.focusInsideTarget;
    const settled = popupClosed && focusSettled;
    const state = updateChoiceInteractionState(decision.controlId, {
      status: settled ? "settled" : "unsettled",
      actuatorId: elementId(target),
      desiredLabel: String(decision.value || "").trim(),
      popupClosed,
      focusSettled,
      escapeAttempted,
      tabAttempted,
      code: settled ? "CHOICE_COMMIT_SETTLED" : "CHOICE_COMMIT_NOT_SETTLED"
    });
    pageStateStore?.invalidate?.("choice_commit_state");
    return {
      ok: settled,
      code: state?.code || "CHOICE_COMMIT_NOT_SETTLED",
      controlId: String(decision.controlId || ""),
      actuatorId: state?.actuatorId || elementId(target),
      desiredLabel: state?.desiredLabel || String(decision.value || "").trim(),
      popupClosed,
      focusSettled,
      escapeAttempted,
      tabAttempted,
      escapeResult,
      tabResult,
      beforeCleanup,
      afterEscape,
      afterCleanup
    };
  }

  function watchClickToFirstMutation(method = "click", meta = {}) {
    const startedAt = performance.now();
    let done = false;
    const finish = (changed) => {
      if (done) return;
      done = true;
      observer.disconnect();
      logFlow("latency.span", {
        click_to_first_mutation_ms: changed ? Math.round(performance.now() - startedAt) : null,
        mutation_observed: Boolean(changed),
        method,
        meta
      });
    };
    const observer = new MutationObserver(() => finish(true));
    try {
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true
      });
      setTimeout(() => finish(false), 1600);
    } catch (error) {
      logFlow("latency.span", {
        click_to_first_mutation_ms: null,
        mutation_observed: false,
        method,
        error: error.message
      });
    }
  }

  async function waitForPaint(ms = 300) {
    await sleep(ms);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }

  function pressEscape(target = document.activeElement || document.body) {
    const eventInit = { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true, cancelable: true };
    target?.dispatchEvent?.(new KeyboardEvent("keydown", eventInit));
    document.dispatchEvent(new KeyboardEvent("keydown", eventInit));
    target?.dispatchEvent?.(new KeyboardEvent("keyup", eventInit));
    document.dispatchEvent(new KeyboardEvent("keyup", eventInit));
    target?.blur?.();
  }

  function clickResolvedViewportTarget(target, x = 18, y = 18, meta = {}) {
    if (!target) return false;
    const eventInit = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: x,
      clientY: y
    };
    logFlow("dom.click_xy.dispatch", {
      meta,
      point: { x, y },
      topElement: elementDescriptor(target),
      pageBefore: pageSnapshot("before-click-xy")
    });
    watchClickToFirstMutation("click_xy", meta);
    target.dispatchEvent(new PointerEvent("pointerdown", eventInit));
    target.dispatchEvent(new MouseEvent("mousedown", eventInit));
    target.dispatchEvent(new PointerEvent("pointerup", eventInit));
    target.dispatchEvent(new MouseEvent("mouseup", eventInit));
    target.dispatchEvent(new MouseEvent("click", eventInit));
    return true;
  }

  function clickViewportPoint(x = 18, y = 18, meta = {}) {
    const target = document.elementFromPoint(x, y) || document.body;
    return clickResolvedViewportTarget(target, x, y, meta);
  }

  function transientOverlayOpen() {
    return activeOverlayElements().some((overlay) => isTransientChoiceOverlay(overlay));
  }

  async function waitForUiSettle(ms = 650) {
    const startedAt = performance.now();
    setAgentActivity("Wait -> Watching page update", "Waiting for a material popup, selection, validation, price, progress, or route change.");
    const settled = await pageStateStore.waitForQuiet({
      maxWaitMs: ms,
      minQuietMs: 80,
      awaitMutationMs: Math.min(180, Math.max(60, Math.round(ms * 0.25)))
    });
    logFlow("latency.span", {
      page_settle_ms: Math.round(performance.now() - startedAt),
      requested_settle_ms: ms,
      mutation_settled: settled.settled
    });
  }


  function composedParent(element) {
    if (!element) return null;
    return element.parentElement || element.getRootNode?.()?.host || null;
  }

  function isEffectiveScrollContainer(element) {
    if (!element || element === document.body || element === document.documentElement) return false;
    const style = getComputedStyle(element);
    return /(auto|scroll|overlay)/.test(`${style.overflowY || ""} ${style.overflow || ""}`)
      && element.scrollHeight > element.clientHeight + 2;
  }

  function nearestEffectiveScrollContainer(element) {
    let current = composedParent(element);
    for (let depth = 0; current && depth < 24; depth += 1, current = composedParent(current)) {
      if (isEffectiveScrollContainer(current)) return current;
    }
    return document.scrollingElement || document.documentElement;
  }

  function scrollElementWithinNearestContainer(element, options = {}) {
    if (options.authority !== "governed_executor") {
      return { ok: false, code: "UNGOVERNED_SCROLL_BLOCKED", container: null, moved: false };
    }
    if (!element) return { ok: false, code: "TARGET_DISAPPEARED", container: null, moved: false };
    const container = nearestEffectiveScrollContainer(element);
    const behavior = options.behavior || "smooth";
    const amount = Number(options.amount || 0);
    const strategy = options.strategy === "nearest_container" ? "nearest_container" : "target_center";
    const documentScroller = container === document.scrollingElement
      || container === document.documentElement
      || container === document.body;
    const before = documentScroller ? Number(window.scrollY || 0) : Number(container.scrollTop || 0);
    if (strategy === "target_center") {
      element.scrollIntoView({ block: "center", inline: "nearest", behavior });
    } else {
      const targetBox = element.getBoundingClientRect();
      const viewportCenter = documentScroller
        ? window.innerHeight / 2
        : (() => {
            const containerBox = container.getBoundingClientRect();
            return containerBox.top + containerBox.height / 2;
          })();
      const centeredDelta = targetBox.top + targetBox.height / 2 - viewportCenter;
      if (documentScroller) window.scrollBy({ top: centeredDelta || amount, left: 0, behavior });
      else container.scrollBy({ top: centeredDelta || amount, left: 0, behavior });
    }
    const after = documentScroller ? Number(window.scrollY || 0) : Number(container.scrollTop || 0);
    return {
      ok: true,
      code: "SCROLL_DISPATCHED",
      container,
      containerId: documentScroller ? "document" : elementId(container),
      containerType: documentScroller ? "document" : "element",
      strategy,
      before,
      after,
      moved: after !== before
    };
  }

  async function waitForScrollSettle(element, options = {}) {
    const container = options.container || nearestEffectiveScrollContainer(element);
    const timeoutMs = Math.max(250, Number(options.timeoutMs || 3000));
    const quietMs = Math.max(80, Number(options.quietMs || 140));
    const documentScroller = container === document.scrollingElement
      || container === document.documentElement
      || container === document.body;
    const sample = () => {
      const rect = element?.getBoundingClientRect?.() || null;
      return {
        windowX: Number(window.scrollX || 0),
        windowY: Number(window.scrollY || 0),
        containerTop: documentScroller ? Number(window.scrollY || 0) : Number(container?.scrollTop || 0),
        targetX: Number(rect?.left || 0),
        targetY: Number(rect?.top || 0)
      };
    };
    const changed = (before, after) => Object.keys(before).some((key) => Math.abs(before[key] - after[key]) > 0.5);
    const startedAt = performance.now();
    let lastChangeAt = startedAt;
    let previous = sample();
    while (performance.now() - startedAt < timeoutMs) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const current = sample();
      if (changed(previous, current)) lastChangeAt = performance.now();
      previous = current;
      if (performance.now() - startedAt >= quietMs && performance.now() - lastChangeAt >= quietMs) {
        return {
          settled: true,
          timedOut: false,
          durationMs: Math.round(performance.now() - startedAt),
          targetInViewport: element ? elementBox(element).inViewport === true : false
        };
      }
    }
    return {
      settled: false,
      timedOut: true,
      durationMs: Math.round(performance.now() - startedAt),
      targetInViewport: element ? elementBox(element).inViewport === true : false
    };
  }


  return {
    boundedLocalClickMechanicAllowed,
    choiceEpisodeEvidence,
    clickResolvedViewportTarget,
    clickViewportPoint,
    composedParent,
    dispatchGovernedClickMechanic,
    isEffectiveScrollContainer,
    localMechanicReactionSnapshot,
    nativeElementClick,
    nearestEffectiveScrollContainer,
    pressEscape,
    scrollElementWithinNearestContainer,
    settleTrustedChoiceInteraction,
    transientOverlayOpen,
    trustedBrowserChoice,
    trustedBrowserClick,
    trustedBrowserKey,
    userLikeClick,
    visibleChoiceSurfacesForValue,
    waitForLocalMechanicReaction,
    waitForPaint,
    waitForScrollSettle,
    waitForUiSettle,
    watchClickToFirstMutation
  };
}
