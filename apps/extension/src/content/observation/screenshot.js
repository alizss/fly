export function createScreenshotObservation({
  agent,
  compactText,
  controlMemberNodeIds,
  elementBox,
  elementById,
  isVisible,
  logAgentEvent,
  meaningfulActionBox,
  normalizeMatchText,
  normalizeVisualRegionContract,
  unionBoxes,
  waitForPaint
}) {
  function annotationBox(item = {}) {
    const box = item.visualRegion || item.box || null;
    if (box?.width > 0 && box?.height > 0) return box;
    const id = item.preferredActivationElementId || item.stateElementId || item.id || "";
    const element = id ? elementById(id) : null;
    return element && isVisible(element) ? elementBox(element) : null;
  }

  function annotationPrefix(item = {}) {
    const kind = normalizeMatchText(`${item.kind || ""} ${item.role || ""} ${item.field || ""} ${item.semantic || ""} ${item.risk || ""}`);
    if (/\b(field|input|textbox|textarea|select|combobox|email|phone|name|date)\b/.test(kind)) return "F";
    if (/\b(button|continue|next|close|back|submit)\b/.test(kind)) return "B";
    if (/\b(choice|radio|checkbox|option|listbox|decline|extra|seat|baggage|bundle|insurance)\b/.test(kind)) return "O";
    return "C";
  }

  function annotationLabel(item = {}) {
    return compactText(item.label || item.accessibleName || item.field || item.semantic || item.id || item.controlId || "", 90);
  }

  function addScreenshotAnnotationCandidate(groups, item, source) {
    if (!item) return;
    const box = annotationBox(item);
    if (!box?.inViewport || !meaningfulActionBox(box)) return;
    if (box.x > window.innerWidth || box.y > window.innerHeight || box.x + box.width < 0 || box.y + box.height < 0) return;
    const key = item.annotationKey || item.controlId || item.id || item.stateElementId || item.preferredActivationElementId || "";
    if (!key) return;
    const existing = groups.get(key) || {
      key,
      items: [],
      box: null,
      label: "",
      prefix: item.prefix || annotationPrefix(item),
      targetId: item.id || item.preferredActivationElementId || item.stateElementId || "",
      controlId: item.controlId || "",
      decisionGroupId: item.decisionGroupId || "",
      kind: item.kind || item.field || item.role || "",
      role: item.role || "",
      semantic: item.semantic || "",
      risk: item.risk || "",
      selected: Boolean(item.selected),
      required: Boolean(item.required),
      source
    };
    existing.items.push(item);
    existing.box = unionBoxes([existing.box, box].filter(Boolean)) || box;
    existing.label = existing.label || annotationLabel(item);
    existing.targetId = existing.targetId || item.id || item.preferredActivationElementId || item.stateElementId || "";
    existing.controlId = existing.controlId || item.controlId || "";
    existing.decisionGroupId = existing.decisionGroupId || item.decisionGroupId || "";
    existing.kind = existing.kind || item.kind || item.field || item.role || "";
    existing.role = existing.role || item.role || "";
    existing.semantic = existing.semantic || item.semantic || "";
    existing.risk = existing.risk || item.risk || "";
    existing.selected = existing.selected || Boolean(item.selected);
    existing.required = existing.required || Boolean(item.required);
    groups.set(key, existing);
  }

  function assignVisualRefToAliases(map, group) {
    const matches = (item) => item && (
      (group.controlId && item.controlId === group.controlId)
      || (group.targetId && item.id === group.targetId)
      || (group.targetId && item.stateElementId === group.targetId)
      || (group.targetId && item.preferredActivationElementId === group.targetId)
    );
    const touch = (item) => {
      if (matches(item)) item.visualRef = group.visualRef;
    };
    (map.controls || []).forEach(touch);
    (map.fields || []).forEach(touch);
    (map.buttons || []).forEach(touch);
    (map.sections || []).forEach((section) => {
      (section.choices || []).forEach(touch);
      (section.fields || []).forEach(touch);
      (section.buttons || []).forEach(touch);
    });
    [map.currentSurface].filter(Boolean).forEach((surface) => {
      (surface.options || []).forEach(touch);
      (surface.buttons || []).forEach(touch);
    });
    (map.accessibility?.controls || []).forEach(touch);
    (map.decisionGroups || []).forEach((decisionGroup) => {
      (decisionGroup.alternatives || []).forEach(touch);
    });
  }

  function prepareScreenshotAnnotations(map, observationId = agent.activeObservationId || "") {
    const groups = new Map();
    const addList = (items, source) => (items || []).forEach((item) => addScreenshotAnnotationCandidate(groups, item, source));
    const finalControls = (map.controls || []).filter((control) => control?.controlId);
    const controlsById = new Map(finalControls.map((control) => [control.controlId, control]));
    (map.controls || []).forEach((control) => {
      (control.operations?.open?.regions || []).forEach((region, index) => {
        const canonicalRegion = normalizeVisualRegionContract(region, {
          observationId,
          controlId: control.controlId,
          operation: "open",
          source: "control.operations.open",
          surfaceId: control.surfaceId || ""
        });
        Object.assign(region, canonicalRegion);
        addScreenshotAnnotationCandidate(groups, {
          annotationKey: `operation:${control.controlId}:open:${index}`,
          controlId: control.controlId,
          decisionGroupId: control.decisionGroupId || "",
          label: `${control.label || control.semantic || "Control"} open region`,
          kind: "visual_recovery",
          role: "visual_region",
          semantic: control.semantic || "",
          risk: "safe",
          prefix: "R",
          visualRegion: canonicalRegion
        }, "control.operations.open");
      });
    });
    // Screenshot grounding is a projection of the finalized canonical
    // registry. Copied field/section/surface models can retain identities for
    // controls that lost ownership during registry reconciliation, so they are
    // intentionally not annotation sources.
    addList(finalControls, "control");

    const counters = { B: 0, F: 0, O: 0, C: 0 };
    const annotations = [...groups.values()]
      .filter((group) => {
        const control = controlsById.get(group.controlId);
        if (!control) return false;
        if (!group.targetId) return group.source === "control.operations.open";
        return controlMemberNodeIds(control).includes(group.targetId)
          || group.targetId === control.controlId;
      })
      .filter((group) => group.box?.width > 0 && group.box?.height > 0)
      .sort((a, b) => (a.box.y - b.box.y) || (a.box.x - b.box.x))
      .slice(0, 80)
      .map((group) => {
        const prefix = group.prefix || "C";
        counters[prefix] = (counters[prefix] || 0) + 1;
        const visualRef = `${prefix}${counters[prefix]}`;
        const annotation = {
          visualRef,
          targetId: group.targetId,
          controlId: group.controlId,
          decisionGroupId: group.decisionGroupId,
          label: group.label,
          kind: group.kind,
          role: group.role,
          semantic: group.semantic,
          risk: group.risk,
          selected: group.selected,
          required: group.required,
          source: group.source,
          box: group.box
        };
        group.visualRef = visualRef;
        group.items.forEach((item) => { item.visualRef = visualRef; });
        assignVisualRefToAliases(map, group);
        return annotation;
      });
    map.screenshotAnnotations = annotations;
    return annotations;
  }

  function clearScreenshotAnnotationOverlay() {
    document.getElementById("atw-screenshot-annotations")?.remove();
  }

  function renderScreenshotAnnotationOverlay(annotations = []) {
    clearScreenshotAnnotationOverlay();
    const visibleAnnotations = (annotations || []).filter((item) => item.box?.inViewport).slice(0, 80);
    if (!visibleAnnotations.length) return null;
    const root = document.createElement("div");
    root.id = "atw-screenshot-annotations";
    root.setAttribute("aria-hidden", "true");
    Object.assign(root.style, {
      position: "fixed",
      inset: "0",
      pointerEvents: "none",
      zIndex: "2147483646",
      fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif"
    });
    for (const item of visibleAnnotations) {
      const box = item.box;
      const outline = document.createElement("div");
      Object.assign(outline.style, {
        position: "absolute",
        left: `${Math.max(0, Math.min(window.innerWidth - 4, box.x))}px`,
        top: `${Math.max(0, Math.min(window.innerHeight - 4, box.y))}px`,
        width: `${Math.max(8, Math.min(window.innerWidth, box.width))}px`,
        height: `${Math.max(8, Math.min(window.innerHeight, box.height))}px`,
        border: "2px solid rgba(14, 132, 255, 0.95)",
        boxShadow: "0 0 0 2px rgba(255,255,255,0.9), 0 0 14px rgba(14,132,255,0.65)",
        borderRadius: "4px",
        boxSizing: "border-box"
      });
      const tag = document.createElement("div");
      tag.textContent = `[${item.visualRef}]`;
      Object.assign(tag.style, {
        position: "absolute",
        left: `${Math.max(4, Math.min(window.innerWidth - 56, box.x))}px`,
        top: `${Math.max(4, Math.min(window.innerHeight - 24, box.y - 24))}px`,
        padding: "2px 6px",
        borderRadius: "5px",
        background: "rgba(6, 20, 38, 0.94)",
        color: "#fff",
        border: "1px solid rgba(255,255,255,0.8)",
        fontSize: "12px",
        fontWeight: "800",
        lineHeight: "16px",
        letterSpacing: "0"
      });
      root.append(outline, tag);
    }
    document.documentElement.appendChild(root);
    return root;
  }

  async function captureVisibleScreenshot(annotations = []) {
    const overlay = renderScreenshotAnnotationOverlay(annotations);
    try {
      if (overlay) await waitForPaint(60);
      const response = await chrome.runtime.sendMessage({ type: "ATW_CAPTURE_VISIBLE_TAB" });
      if (!response?.ok) {
        logAgentEvent("screenshot", { ok: false, error: response?.error || "unavailable" });
        return "";
      }
      logAgentEvent("screenshot", { ok: true, bytes: response.dataUrl.length, annotations: annotations.length });
      return response.dataUrl;
    } catch (error) {
      logAgentEvent("screenshot", { ok: false, error: error.message });
      return "";
    } finally {
      clearScreenshotAnnotationOverlay();
    }
  }

  function observationNeedsScreenshot(map = {}) {
    const graph = map.graphIntegrity || {};
    if (graph.ok === false && Number(graph.actionableConflictCount || graph.aliasConflictCount || 0) > 0) return true;
    const surfaceId = map.currentSurface?.id || map.currentSurface?.surfaceId || "surface-page";
    return (map.controls || []).some((control) => {
      if (control.surfaceId && control.surfaceId !== surfaceId) return false;
      const executable = Object.values(control.operations || {}).some((operation) => (
        operation?.actionability?.executable === true || operation?.actionability?.revealable === true
      ));
      if (!executable || !control.visualRegion) return false;
      const localIdentity = compactText([
        control.ownText,
        control.ariaLabel,
        control.title,
        control.testId,
        control.label,
        control.accessibleName
      ].filter(Boolean).join(" "), 240);
      return !localIdentity;
    });
  }


  return {
    captureVisibleScreenshot,
    clearScreenshotAnnotationOverlay,
    observationNeedsScreenshot,
    prepareScreenshotAnnotations,
    renderScreenshotAnnotationOverlay
  };
}
