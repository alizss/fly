export function createPerceptionFacade(dependencies) {
  const {
    activeOverlayElements,
    agent,
    compactText,
    elementBox,
    elementId,
    isVisible,
    normalizeMatchText,
    overlayText,
    queryAllDeep,
    stableHash,
    surfaceText
  } = dependencies;

  function pageCoverage() {
    const iframes = [...document.querySelectorAll("iframe")];
    let accessibleIframes = 0;
    for (const frame of iframes) {
      try {
        if (frame.contentDocument) accessibleIframes += 1;
      } catch (error) {
        // Cross-origin frame.
      }
    }
    return {
      openShadowRoots: queryAllDeep("*").filter((element) => element.shadowRoot).length,
      iframes: iframes.length,
      accessibleIframes,
      blockedIframes: Math.max(0, iframes.length - accessibleIframes),
      scroll: {
        scrollY: Math.round(window.scrollY),
        viewportHeight: Math.round(window.innerHeight),
        documentHeight: Math.round(Math.max(
          document.documentElement?.scrollHeight || 0,
          document.body?.scrollHeight || 0
        )),
        atTop: window.scrollY <= 2,
        atBottom: window.scrollY + window.innerHeight >= Math.max(
          document.documentElement?.scrollHeight || 0,
          document.body?.scrollHeight || 0
        ) - 2
      }
    };
  }

  function pageReadinessFacts() {
    const loadingSelectors = [
      "[aria-busy='true']",
      "[role='progressbar']",
      "[data-loading='true']",
      "[data-testid*='loading']",
      ".loading",
      ".loader",
      ".spinner",
      "[class*='skeleton']"
    ].join(",");
    const loadingIndicators = queryAllDeep(loadingSelectors)
      .filter((element) => isVisible(element) && !element.closest("#atw-sidebar, #atw-agent-cursor"));
    const main = queryAllDeep("main, [role='main']").find((element) => isVisible(element)) || document.body;
    const mainText = compactText(main?.innerText || main?.textContent || "", 10_000);
    const loadingTextEvidence = /\bplease\s+wait\b|\b(?:loading|fetching|preparing)\b.{0,80}\b(?:option|seat|fare|checkout|payment|travell?er|passenger|detail|trip)\b/i.test(mainText);
    return {
      documentReadyState: document.readyState || "unknown",
      ariaBusy: Boolean(queryAllDeep("[aria-busy='true']").some((element) => isVisible(element))),
      loadingIndicatorCount: loadingIndicators.length,
      loadingTextEvidence,
      mainTextLength: mainText.length,
      visibleMainCount: queryAllDeep("main, [role='main']").filter(isVisible).length,
      stableForMs: Math.max(0, Date.now() - Number(agent.lastPageMutationAt || Date.now()))
    };
  }

  function visibleOverlays() {
    return activeOverlayElements()
      .map((element) => {
        const text = overlayText(element);
        return {
          id: elementId(element),
          label: text.slice(0, 220),
          box: elementBox(element),
          role: element.getAttribute("role") || ""
        };
      })
      .filter((item) => item.label || item.role)
      .slice(0, 12);
  }

  function isInViewport(element) {
    const rect = element.getBoundingClientRect();
    return rect.bottom >= 0 && rect.right >= 0 && rect.top <= window.innerHeight && rect.left <= window.innerWidth;
  }

  function numericZIndex(element) {
    const value = Number.parseInt(getComputedStyle(element).zIndex || "0", 10);
    return Number.isFinite(value) ? value : 0;
  }

  function pointBelongsToElement(point, element) {
    const top = document.elementFromPoint(point.x, point.y);
    return Boolean(top && (top === element || element.contains(top)));
  }

  function overlayTopHitCount(element) {
    if (!element || !isVisible(element) || !isInViewport(element)) return 0;
    const rect = element.getBoundingClientRect();
    const left = Math.max(2, rect.left + Math.min(28, rect.width * 0.18));
    const right = Math.min(window.innerWidth - 2, rect.right - Math.min(28, rect.width * 0.18));
    const top = Math.max(2, rect.top + Math.min(28, rect.height * 0.18));
    const bottom = Math.min(window.innerHeight - 2, rect.bottom - Math.min(28, rect.height * 0.18));
    const centerX = Math.min(window.innerWidth - 2, Math.max(2, rect.left + rect.width / 2));
    const centerY = Math.min(window.innerHeight - 2, Math.max(2, rect.top + rect.height / 2));
    const points = [
      { x: centerX, y: centerY },
      { x: left, y: top },
      { x: right, y: top },
      { x: left, y: bottom },
      { x: right, y: bottom }
    ];
    return points.filter((point) => pointBelongsToElement(point, element)).length;
  }

  function overlayVisualScore(element) {
    const rect = element.getBoundingClientRect();
    return (overlayTopHitCount(element) * 1000000) + (numericZIndex(element) * 1000) + Math.round(Math.min(rect.width * rect.height, 900000));
  }

  function surfaceProgressMarkers(text = "") {
    const clean = String(text || "").replace(/\s+/g, " ");
    return {
      flightOrdinal: clean.match(/\bflight\s+\d+\s+of\s+\d+\b/i)?.[0] || "",
      route: clean.match(/\b[A-Z]{3}\s*(?:-|–|to)\s*[A-Z]{3}\b/)?.[0] || "",
      selectedText: clean.match(/\b(not selected|selected|seat not selected|random seating)\b/i)?.[0] || "",
      priceText: clean.match(/\b\d+(?:[.,]\d{1,2})?\s*(?:EUR|USD|GBP|€|\$|£)\b/i)?.[0] || ""
    };
  }

  function boundedSurfaceEvidenceOptions(surface = {}, limit = 48) {
    const options = surface.options || [];
    const important = options.filter((option) => (
      option.selected === true
      || /^(?:next|continue|close|done|confirm|back|skip|proceed)\b/i.test(option.label || "")
    ));
    const evidence = [];
    const seen = new Set();
    for (const option of [...important, ...options]) {
      const key = `${option.id || ""}:${option.label || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      evidence.push(option);
      if (evidence.length >= limit) break;
    }
    return evidence;
  }

  function surfaceVisualFingerprint(surface = {}) {
    return stableHash([
      surface.type || "",
      normalizeMatchText(surface.label || ""),
      boundedSurfaceEvidenceOptions(surface).map((option) => `${normalizeMatchText(option.label)}:${option.selected ? "1" : "0"}`).join("|"),
      (surface.controlCollections || []).map((collection) => `${collection.collectionId}:${collection.totalCount}:${collection.selectedCount}`).join("|"),
      JSON.stringify(surfaceProgressMarkers(surface.label || ""))
    ].join("||"));
  }

  function foregroundSurfaceState(activeSurface = {}) {
    const active = Boolean(
      activeSurface?.type
      && activeSurface.type !== "page"
      && activeSurface.blocksBackground === true
    );
    const text = surfaceText(activeSurface);
    const optionCount = (activeSurface.options || []).length;
    const navCount = (activeSurface.options || []).filter((option) => /^(next|continue|close|done|confirm)\b/i.test(option.label || "")).length;
    const confidence = !active ? 0 : Math.min(0.99, 0.45
      + (activeSurface.role ? 0.1 : 0)
      + (activeSurface.box?.inViewport ? 0.15 : 0)
      + (optionCount ? 0.15 : 0)
      + (navCount ? 0.1 : 0)
      + (/seat|baggage|bundle|insurance|extra|are you sure|not selected/i.test(text) ? 0.05 : 0));
    return {
      active,
      id: activeSurface.id || "",
      type: activeSurface.type || "page",
      label: activeSurface.label || "",
      blocksBackground: activeSurface.blocksBackground === true,
      confidence,
      reason: active ? "Visible foreground surface owns the next action until it closes or changes." : "No foreground surface detected.",
      progressMarkers: surfaceProgressMarkers(text),
      fingerprint: surfaceVisualFingerprint(activeSurface),
      optionCount,
      navigationControlCount: navCount,
      box: activeSurface.box || null
    };
  }

  function compactVisualControl(item = {}) {
    const box = item.box || {};
    const role = item.accessibility?.role || item.role || "";
    const name = item.accessibility?.name || item.label || item.field || "";
    return {
      id: item.id || "",
      role,
      name: String(name || "").replace(/\s+/g, " ").trim().slice(0, 160),
      label: String(item.label || item.field || "").replace(/\s+/g, " ").trim().slice(0, 160),
      kind: item.kind || item.field || "",
      semantic: item.semantic || item.field || "",
      risk: item.risk || "",
      selected: Boolean(item.selected),
      required: Boolean(item.required),
      hasValue: Boolean(item.hasValue || item.value),
      state: item.accessibility?.state || null,
      box: box ? {
        x: Math.round(box.x || 0),
        y: Math.round(box.y || 0),
        width: Math.round(box.width || 0),
        height: Math.round(box.height || 0),
        centerX: Math.round(box.centerX || 0),
        centerY: Math.round(box.centerY || 0),
        inViewport: Boolean(box.inViewport)
      } : null
    };
  }

  function visualPageState(map = agent.pageMap || {}) {
    const activeSurface = map.currentSurface || {};
    const foreground = foregroundSurfaceState(activeSurface);
    const surfaceControls = foreground.active
      ? boundedSurfaceEvidenceOptions(activeSurface, 120)
      : [];
    const pageControls = !foreground.active
      ? [
          ...(map.fields || []),
          ...(map.buttons || []),
          ...(map.sections || []).flatMap((section) => section.choices || [])
        ]
      : [];
    const uniqueControls = [];
    const seenControls = new Set();
    for (const item of [...surfaceControls, ...pageControls]) {
      if (!item || !(item.id || item.label || item.field)) continue;
      const key = `${item.id || ""}:${item.label || ""}`;
      if (seenControls.has(key)) continue;
      seenControls.add(key);
      uniqueControls.push(item);
    }
    const controls = uniqueControls
      .map(compactVisualControl)
      .filter((item) => item.box?.inViewport || foreground.active)
      .slice(0, 120);
    const signature = [
      map.step || "",
      location.pathname,
      foreground.fingerprint || "",
      controls.map((item) => [
        item.id,
        normalizeMatchText(item.name || item.label),
        item.role,
        item.selected ? "1" : "0",
        item.hasValue ? "v" : "",
        item.box ? `${Math.round(item.box.centerX / 8)}:${Math.round(item.box.centerY / 8)}` : ""
      ].join(":")).join("|")
    ].join("||");
    return {
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        scrollX: Math.round(window.scrollX),
        scrollY: Math.round(window.scrollY),
        devicePixelRatio: window.devicePixelRatio || 1
      },
      foreground,
      controls,
      controlCount: controls.length,
      fingerprint: stableHash(signature)
    };
  }

  return {
    boundedSurfaceEvidenceOptions,
    foregroundSurfaceState,
    isInViewport,
    overlayTopHitCount,
    overlayVisualScore,
    pageCoverage,
    pageReadinessFacts,
    pointBelongsToElement,
    surfaceProgressMarkers,
    visualPageState,
    visibleOverlays
  };
}
