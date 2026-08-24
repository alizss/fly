export function createAccessibilityProjection({
  textFromIds,
  implicitRole,
  buttonText,
  labelText,
  ownedGraphicControlName,
  isDisabledLike,
  isVisible,
  liveSectionForElement,
  lookupControlForElement,
  elementBox,
  elementId,
  elementById,
  queryAllDeep,
  currentPageMap
}) {
  function accessibleName(element) {
    if (!element) return "";
    return [
      element.getAttribute?.("aria-label"),
      textFromIds(element.getAttribute?.("aria-labelledby")),
      element.getAttribute?.("alt"),
      element.getAttribute?.("title"),
      ownedGraphicControlName?.(element),
      element.value && /button|submit|reset/.test(element.type || "") ? element.value : "",
      buttonText(element),
      labelText(element),
      element.innerText || element.textContent
    ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim().slice(0, 240);
  }

  function accessibilityState(element) {
    if (!element) return {};
    return {
      disabled: isDisabledLike(element),
      checked: element.checked === true || element.getAttribute?.("aria-checked") === "true",
      selected: element.selected === true || element.getAttribute?.("aria-selected") === "true",
      expanded: element.getAttribute?.("aria-expanded") || "",
      pressed: element.getAttribute?.("aria-pressed") || "",
      required: element.required === true || element.getAttribute?.("aria-required") === "true",
      invalid: element.getAttribute?.("aria-invalid") === "true",
      hasPopup: element.getAttribute?.("aria-haspopup") || "",
      controls: element.getAttribute?.("aria-controls") || "",
      describedBy: textFromIds(element.getAttribute?.("aria-describedby")).slice(0, 240)
    };
  }

  function accessibilityNode(element, map = currentPageMap()) {
    if (!element || !isVisible(element) || element.closest?.("#atw-sidebar")) return null;
    const section = map ? liveSectionForElement(map, element) : null;
    const surface = map?.currentSurface || {};
    const control = map ? lookupControlForElement(map, element) : null;
    const box = elementBox(element);
    return {
      id: elementId(element),
      controlId: control?.controlId || element.dataset?.atwControlId || "",
      role: implicitRole(element),
      name: accessibleName(element),
      state: accessibilityState(element),
      box,
      tag: (element.tagName || "").toLowerCase(),
      kind: /radio|checkbox/i.test(element.type || "") ? "choice" : ((element.tagName || "").toLowerCase()),
      sectionId: section?.id || "",
      sectionType: section?.type || "",
      sectionLabel: section?.label || "",
      surfaceId: surface?.id || "",
      surfaceType: surface?.type || "page",
      inViewport: Boolean(box?.inViewport)
    };
  }

  function accessibilitySnapshot(map = currentPageMap() || {}) {
    const surface = map.currentSurface || {};
    const controls = [
      ...(map.fields || []).map((item) => item.element),
      ...(map.buttons || []).map((item) => item.element),
      ...(surface.id ? [elementById(surface.id)] : []),
      ...(surface.options || []).map((item) => elementById(item.id)),
      ...(surface.buttons || []).map((item) => elementById(item.id))
    ]
      .filter(Boolean)
      .map((element) => accessibilityNode(element, map))
      .filter(Boolean)
      .filter((node, index, list) => list.findIndex((item) => item.id === node.id) === index)
      .slice(0, 120);
    return {
      foregroundSurfaceId: surface.id || "",
      foregroundSurfaceType: surface.type || "page",
      controls,
      landmarkCount: queryAllDeep("main, [role='main'], form, nav, header, footer, aside").filter(isVisible).length
    };
  }

  return Object.freeze({
    accessibleName,
    accessibilityState,
    accessibilityNode,
    accessibilitySnapshot
  });
}
