export function createPageStateSupport({ applyControlToModel, compactText }) {
  function emptyPageStateDiff() {
    return {
      addedControls: [], removedControls: [], stateChanges: [], textChanges: [],
      validationChanges: [], priceChanges: [], surfaceChanges: []
    };
  }

  function canonicalPageStateDiff(before = null, after = null) {
    if (!before || !after) return emptyPageStateDiff();
    const diff = emptyPageStateDiff();
    const beforeControls = new Map((before.controls || []).map((control) => [control.controlId, control]));
    const afterControls = new Map((after.controls || []).map((control) => [control.controlId, control]));
    const stateFor = (control = {}) => ({
      checked: Boolean(control.state?.checked),
      selected: Boolean(control.state?.selected || control.selected),
      pressed: Boolean(control.state?.pressed),
      disabled: Boolean(control.state?.disabled),
      expanded: Boolean(control.state?.expanded),
      valuePresent: Boolean(control.state?.valuePresent),
      normalizedValue: String(control.state?.normalizedValue || control.currentValue || ""),
      selectedValue: String(control.state?.selectedValue || ""),
      fieldType: String(control.fieldType || ""),
      executable: Object.values(control.operations || {}).some((operation) => operation?.actionability?.executable === true)
    });
    for (const [controlId, control] of afterControls) {
      const prior = beforeControls.get(controlId);
      if (!prior) {
        diff.addedControls.push({ controlId, stableKey: control.stableKey || "", surfaceId: control.surfaceId || "" });
        continue;
      }
      const beforeState = stateFor(prior);
      const afterState = stateFor(control);
      if (JSON.stringify(beforeState) !== JSON.stringify(afterState)) {
        diff.stateChanges.push({ controlId, before: beforeState, after: afterState });
      }
      const beforeText = compactText([prior.ownText, prior.ariaLabel, prior.title, prior.label].filter(Boolean).join(" "), 240);
      const afterText = compactText([control.ownText, control.ariaLabel, control.title, control.label].filter(Boolean).join(" "), 240);
      if (beforeText !== afterText) diff.textChanges.push({ controlId, before: beforeText, after: afterText });
    }
    for (const [controlId, control] of beforeControls) {
      if (!afterControls.has(controlId)) {
        diff.removedControls.push({ controlId, stableKey: control.stableKey || "", surfaceId: control.surfaceId || "" });
      }
    }
    const validationKey = (issue = {}) => `${issue.issueId || issue.controlId || ""}:${issue.message || issue}`;
    const beforeValidation = new Set([...(before.validationIssues || []).map(validationKey), ...(before.errors || []).map(String)]);
    const afterValidation = new Set([...(after.validationIssues || []).map(validationKey), ...(after.errors || []).map(String)]);
    const appeared = [...afterValidation].filter((value) => !beforeValidation.has(value));
    const cleared = [...beforeValidation].filter((value) => !afterValidation.has(value));
    if (appeared.length || cleared.length) diff.validationChanges.push({ appeared, cleared });
    if (JSON.stringify(before.price || null) !== JSON.stringify(after.price || null)
      || JSON.stringify(before.transactionFacts?.selectedExtras || []) !== JSON.stringify(after.transactionFacts?.selectedExtras || [])) {
      diff.priceChanges.push({
        before: before.price || null,
        after: after.price || null,
        selectedExtrasBefore: before.transactionFacts?.selectedExtras || [],
        selectedExtrasAfter: after.transactionFacts?.selectedExtras || []
      });
    }
    const surfaceFor = (map = {}) => ({
      id: map.currentSurface?.id || "surface-page",
      type: map.currentSurface?.type || "page",
      label: map.currentSurface?.label || "",
      progressMarkers: map.foreground?.progressMarkers || map.currentSurface?.foreground?.progressMarkers || null
    });
    const beforeSurface = surfaceFor(before);
    const afterSurface = surfaceFor(after);
    if (JSON.stringify(beforeSurface) !== JSON.stringify(afterSurface)) {
      diff.surfaceChanges.push({ before: beforeSurface, after: afterSurface });
    }
    return Object.fromEntries(Object.entries(diff).map(([key, value]) => [key, value.slice(0, 40)]));
  }

  function pageStateDiffIsMaterial(diff = emptyPageStateDiff()) {
    return Object.values(diff).some((entries) => Array.isArray(entries) && entries.length > 0);
  }

  function mutationOwnedControlId(target) {
    if (!target || target.nodeType !== Node.ELEMENT_NODE) target = target?.parentElement || null;
    return target?.closest?.("[data-atw-control-id]")?.dataset?.atwControlId
      || target?.dataset?.atwControlId
      || "";
  }

  function mutationMayBeMaterial(mutation) {
    const target = mutation?.target?.nodeType === Node.ELEMENT_NODE
      ? mutation.target
      : mutation?.target?.parentElement;
    if (!target || target.closest?.("#atw-sidebar, #atw-screenshot-annotation-overlay")) return false;
    if (mutation.type === "viewport") return true;
    if (mutation.type === "attributes") {
      if (/^data-atw-/.test(mutation.attributeName || "")) return false;
      const materialAttributes = new Set([
        "checked", "selected", "value", "disabled", "required", "hidden", "open",
        "aria-checked", "aria-selected", "aria-pressed", "aria-expanded", "aria-disabled", "aria-invalid",
        "aria-hidden", "aria-valuenow", "data-price", "data-selected", "data-value"
      ]);
      if (materialAttributes.has(mutation.attributeName)) return true;
      if (["class", "style"].includes(mutation.attributeName)) {
        return Boolean(mutationOwnedControlId(target)
          || target.matches?.("[role='dialog'], [aria-modal='true'], .modal, .popover, [role='listbox'], [role='menu'], [role='alert'], progress"));
      }
      return false;
    }
    if (mutation.type === "characterData") {
      return Boolean(mutationOwnedControlId(target)
        || target.closest?.("[role='dialog'], [aria-modal='true'], [role='alert'], [aria-live], h1, h2, [data-checkout-step], [class*='step'], [class*='progress'], [data-price], [class*='price'], [class*='total'], progress"));
    }
    if (mutation.type === "childList") {
      const nodes = [...(mutation.addedNodes || []), ...(mutation.removedNodes || [])];
      const selector = "button, input, select, textarea, [role='button'], [role='option'], [role='radio'], [role='checkbox'], [role='dialog'], [aria-modal='true'], .modal, .popover, [role='listbox'], [role='menu'], [role='alert'], [aria-live], [data-price], [class*='price'], [class*='total'], progress";
      return nodes.some((node) => {
        if (node.nodeType === Node.TEXT_NODE) return Boolean(mutationOwnedControlId(target)
          || target.matches?.("h1, h2, [data-checkout-step], [class*='step'], [class*='progress'], [role='alert'], [aria-live], [data-price], [class*='price'], [class*='total'], progress")
          || target.closest?.("[role='dialog'], [aria-modal='true']"));
        return Boolean(node.matches?.(selector) || node.querySelector?.(selector));
      });
    }
    return mutation.type === "input" || mutation.type === "change";
  }

  function syncIncrementalControlModels(map, controlsById) {
    const sync = (items = []) => items.map((item) => {
      const control = controlsById.get(item.controlId || item.id);
      return control ? applyControlToModel({ ...item }, control) : item;
    });
    map.fields = sync(map.fields || []);
    map.buttons = sync(map.buttons || []);
    map.sections = (map.sections || []).map((section) => ({
      ...section,
      fields: sync(section.fields || []),
      choices: sync(section.choices || []),
      buttons: sync(section.buttons || [])
    }));
    if (map.currentSurface?.type && map.currentSurface.type !== "page") {
      map.currentSurface = {
        ...map.currentSurface,
        options: sync(map.currentSurface.options || []),
        buttons: sync(map.currentSurface.buttons || [])
      };
    }
    return map;
  }

  return Object.freeze({
    emptyPageStateDiff,
    canonicalPageStateDiff,
    pageStateDiffIsMaterial,
    mutationOwnedControlId,
    mutationMayBeMaterial,
    syncIncrementalControlModels
  });
}
