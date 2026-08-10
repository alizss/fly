import { currentNavigationUrl } from "../navigation-identity.js";

export function createObservationSignatures({
  activeOverlayElements,
  buildPageMap,
  buttonText,
  directControlName,
  elementBox,
  isVisible,
  overlayText
}) {
  function normalizeMatchText(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/€|eur/g, " eur ")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function stableHash(value = "") {
    const text = String(value || "");
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return `h${(hash >>> 0).toString(36)}`;
  }

  function elementSignature(element) {
    if (!element) return "";
    const box = isVisible(element) ? elementBox(element) : null;
    const surface = element.closest?.("[role='dialog'], [aria-modal='true'], .modal, .popover, [role='listbox'], [role='menu']")
      || activeOverlayElements()[0]
      || null;
    const surfaceText = surface ? overlayText(surface).slice(0, 260) : "";
    return [
      currentNavigationUrl(),
      element.tagName,
      element.id,
      element.name,
      box ? `${Math.round(box.centerX)}:${Math.round(box.centerY)}:${Math.round(box.width)}x${Math.round(box.height)}` : "",
      surfaceText,
      element.innerText || element.value || element.getAttribute("aria-label") || ""
    ].join("|").slice(0, 500);
  }

  function pageSignature(map = buildPageMap()) {
    return [currentNavigationUrl(), map.step, map.errors.join("|"), map.text.slice(0, 800)].join("||");
  }

  function canonicalItineraryActionDate(value = "") {
    const text = String(value || "").replace(/(\d{1,2})(?:st|nd|rd|th)\b/gi, "$1").trim();
    const iso = text.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
    const months = new Map([
      ["january", 1], ["february", 2], ["march", 3], ["april", 4], ["may", 5], ["june", 6],
      ["july", 7], ["august", 8], ["september", 9], ["october", 10], ["november", 11], ["december", 12],
      ["jan", 1], ["feb", 2], ["mar", 3], ["apr", 4], ["jun", 6], ["jul", 7], ["aug", 8],
      ["sep", 9], ["sept", 9], ["oct", 10], ["nov", 11], ["dec", 12]
    ]);
    const dayFirst = text.match(/\b(\d{1,2})\s+([\p{L}.]+)\s+(20\d{2})\b/iu);
    const monthFirst = text.match(/\b([\p{L}.]+)\s+(\d{1,2})(?:,)?\s+(20\d{2})\b/iu);
    const match = dayFirst || monthFirst;
    if (!match) return "";
    const day = Number(dayFirst ? match[1] : match[2]);
    const monthName = String(dayFirst ? match[2] : match[1]).toLowerCase().replace(/\.$/, "");
    const year = Number(match[3]);
    const month = months.get(monthName) || 0;
    const date = new Date(Date.UTC(year, month - 1, day));
    if (!month || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return "";
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  function itineraryActionEvidence(element) {
    if (!element?.matches?.("button, a, [role='button'], [role='link']")) return null;
    const labels = [
      element.getAttribute?.("aria-label"), directControlName(element), buttonText(element), element.getAttribute?.("title")
    ].map((value) => String(value || "").replace(/\s+/g, " ").trim()).filter(Boolean);
    for (const label of [...new Set(labels)]) {
      const match = label.match(/^(?:edit|change|modify|view)\s+([\p{L}][\p{L} .'’-]{1,78}?)\s+(?:to|→|–|—)\s+([\p{L}][\p{L} .'’-]{1,78}?)\s+flight\s+(?:on|departing(?:\s+on)?)\s+(.{5,60}?)(?:[.!]|$)/iu);
      if (!match) continue;
      const departureDate = canonicalItineraryActionDate(match[3]);
      const origin = match[1].trim();
      const destination = match[2].trim();
      if (!departureDate || origin.toLowerCase() === destination.toLowerCase()) continue;
      return { label, origin, destination, departureDate };
    }
    return null;
  }

  function structuralPageSignature(map = buildPageMap()) {
    const activeSurface = map.currentSurface || {};
    const stableSection = (section) => [
      section.type || "", normalizeMatchText(section.label || ""), section.status || "",
      (section.selected || []).map(normalizeMatchText).join(",")
    ].join(":");
    const stableControl = (control) => [
      control.kind || control.role || control.type || "", control.field || "",
      normalizeMatchText(control.label || control.field || ""), control.hasValue ? "1" : "0", control.selected ? "1" : "0"
    ].join(":");
    const sections = (map.sections || []).map(stableSection).join("|");
    const controls = [...(map.buttons || []), ...(map.fields || [])].map(stableControl).join("|");
    return [
      pageSignature(map),
      `surface:${activeSurface.type || "page"}:${normalizeMatchText(activeSurface.label || "")}`,
      `sections:${sections}`,
      `controls:${controls}`
    ].join("||").slice(0, 4000);
  }

  function materialObservationSignature(map = buildPageMap()) {
    const materialUrl = (() => {
      try {
        const currentUrl = currentNavigationUrl();
        const url = new URL(map.url || currentUrl, currentUrl);
        return `${url.origin}${url.pathname}${url.search}`;
      } catch (error) {
        return String(map.url || currentNavigationUrl() || "").split("#")[0];
      }
    })();
    const foreground = map.currentSurface?.type && map.currentSurface.type !== "page" ? map.currentSurface : {};
    const stableState = (state = {}) => ({
      checked: Boolean(state.checked), selected: Boolean(state.selected), disabled: Boolean(state.disabled),
      expanded: Boolean(state.expanded), valuePresent: Boolean(state.valuePresent),
      normalizedValue: String(state.normalizedValue || ""), required: Boolean(state.required)
    });
    const controls = (map.controls || []).map((control) => ({
      controlId: control.controlId || "",
      decisionGroupId: control.decisionGroupId || "",
      semantic: control.semantic || control.field || "",
      kind: control.kind || control.role || control.type || "",
      risk: control.risk || "",
      surfaceId: control.surfaceId || "",
      sectionId: control.sectionId || "",
      commitState: control.commitState ? {
        status: control.commitState.status || "", popupClosed: control.commitState.popupClosed === true,
        focusSettled: control.commitState.focusSettled === true, actuatorId: control.commitState.actuatorId || ""
      } : null,
      state: stableState(control.state || {
        checked: control.checked, selected: control.selected, disabled: control.disabled,
        valuePresent: control.hasValue, required: control.required
      })
    })).sort((a, b) => a.controlId.localeCompare(b.controlId));
    const decisionGroups = (map.decisionGroups || []).map((group) => ({
      decisionGroupId: group.decisionGroupId || "",
      requirementId: group.requirementId || "",
      semanticType: group.semanticType || group.sectionType || "",
      stage: group.stage || map.step || "",
      surfaceId: group.surfaceId || "",
      instanceId: group.instanceId || "",
      status: group.status || "",
      selectedControlId: group.selectedControlId || group.selected?.controlId || "",
      selectedValue: group.selectedValue || group.selected?.value || "",
      selectedDisposition: group.selectedEvidence?.disposition || "",
      selectedPrice: group.selectedEvidence?.structuredPrice || null,
      removalControlId: group.removalControlId || ""
    })).sort((a, b) => a.decisionGroupId.localeCompare(b.decisionGroupId));
    const fields = (map.fields || []).map((field) => ({
      controlId: field.controlId || "", semantic: field.field || "", decisionGroupId: field.decisionGroupId || "",
      hasValue: Boolean(field.hasValue), required: Boolean(field.required), disabled: Boolean(field.disabled || field.element?.disabled)
    })).sort((a, b) => `${a.controlId}:${a.semantic}`.localeCompare(`${b.controlId}:${b.semantic}`));
    return JSON.stringify({
      url: materialUrl,
      step: map.step || "unknown",
      foreground: { id: foreground.id || "", type: foreground.type || "page", decisionGroupId: foreground.decisionGroupId || "" },
      transactionFacts: map.transactionFacts ? {
        evidenceMode: map.transactionFacts.evidenceMode,
        itinerary: map.transactionFacts.itinerary,
        travelers: map.transactionFacts.travelers,
        currency: map.transactionFacts.currency,
        basePrice: map.transactionFacts.basePrice,
        totalPrice: map.transactionFacts.totalPrice,
        fareBrand: map.transactionFacts.fareBrand,
        selectedExtras: map.transactionFacts.selectedExtras,
        factEvidence: map.transactionFacts.factEvidence
      } : null,
      price: map.price || null,
      controls,
      decisionGroups,
      fields
    });
  }

  function observationHashForMap(map = buildPageMap()) {
    return stableHash(materialObservationSignature(map));
  }

  return Object.freeze({
    normalizeMatchText,
    stableHash,
    elementSignature,
    pageSignature,
    canonicalItineraryActionDate,
    itineraryActionEvidence,
    structuralPageSignature,
    materialObservationSignature,
    observationHashForMap
  });
}
