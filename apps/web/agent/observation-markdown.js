const MAX_MARKDOWN_CHARS = 16_000;

function clean(value, limit = 180) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function hashNumber(value = "") {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0) % 10_000;
}

function controlPrefix(control = {}) {
  const kind = `${control.kind || ""} ${control.role || ""} ${control.semantic || ""}`.toLowerCase();
  if (/input|field|textbox|combobox/.test(kind)) return "F";
  if (/radio|checkbox|option|choice/.test(kind)) return "O";
  if (/next|continue|navigate|button/.test(kind)) return "B";
  return "C";
}

function stableControlRef(control = {}) {
  const visualRef = clean(control.visualRef, 30);
  if (visualRef) return visualRef.replace(/^\[|\]$/g, "");
  const identity = control.controlId || control.id || `${control.label}:${control.kind}:${control.sectionType}`;
  return `${controlPrefix(control)}${hashNumber(identity)}`;
}

function operationNames(control = {}) {
  return Object.entries(control.operations || {})
    .filter(([, value]) => Boolean(value))
    .map(([name]) => name)
    .slice(0, 5);
}

function controlStateText(control = {}) {
  const state = control.state || control.controlState || {};
  const parts = [];
  if (control.required) parts.push("required");
  if (control.selected || state.selected || state.checked) parts.push("selected");
  if (state.disabled || control.disabled) parts.push("disabled");
  if (state.expanded === true) parts.push("expanded");
  if (state.expanded === false && operationNames(control).includes("open")) parts.push("closed");
  const value = clean(state.normalizedValue || state.value || "", 80);
  if (value) parts.push(`value ${value}`);
  else if (/input|field|textbox/.test(`${control.kind || ""} ${control.role || ""}`.toLowerCase())) {
    parts.push(state.valuePresent ? "filled" : "empty");
  }
  if (control.risk) parts.push(clean(control.risk, 40));
  const operations = operationNames(control);
  if (operations.length) parts.push(`can ${operations.join("/")}`);
  return parts.join(" — ");
}

function isSeatCell(control = {}) {
  const context = `${control.sectionType || ""} ${control.sectionLabel || ""} ${control.semantic || ""} ${control.kind || ""}`.toLowerCase();
  const label = clean(control.label || control.accessibleName, 100);
  return /seat/.test(context) && (/\b\d{1,2}\s*[a-k]\b/i.test(label) || /seat[_ -]?cell|seat option|available seat|occupied seat/.test(context));
}

function isImportantControl(control = {}, activeSurfaceId = "") {
  const text = `${control.label || ""} ${control.semantic || ""} ${control.risk || ""}`.toLowerCase();
  return Boolean(
    control.required
    || control.selected
    || (activeSurfaceId && control.surfaceId === activeSurfaceId)
    || /safe_decline|payment|legal/.test(control.risk || "")
    || /no thanks|without|skip|continue|next|close|open_choice|decline|free/.test(text)
    || operationNames(control).some((name) => ["open", "choose", "type", "keypress"].includes(name))
  );
}

function progressText(page = {}) {
  const markers = page.foreground?.progressMarkers
    || page.visualState?.foreground?.progressMarkers
    || page.currentSurface?.foreground?.progressMarkers
    || null;
  if (!markers) return "";
  if (typeof markers === "string") return clean(markers, 160);
  if (Array.isArray(markers)) return markers.map((item) => clean(item, 80)).filter(Boolean).join(" / ");
  return Object.entries(markers).map(([key, value]) => `${clean(key, 50)} ${clean(value, 80)}`).join(" / ");
}

function summarizeSeatCells(controls = []) {
  const summary = { total: controls.length, available: 0, selected: 0, paid: 0, disabled: 0 };
  for (const control of controls) {
    const state = control.state || control.controlState || {};
    if (control.selected || state.selected || state.checked) summary.selected += 1;
    if (state.disabled || control.disabled) summary.disabled += 1;
    else summary.available += 1;
    if (/money|payment/.test(control.risk || "") || /€|eur|\$|£/.test(control.label || "")) summary.paid += 1;
  }
  return summary;
}

function compactWholePageMarkdown(observation = {}, { traveler = {} } = {}) {
  const page = observation.page || {};
  const controls = Array.isArray(page.controls) ? page.controls : [];
  const groups = Array.isArray(page.decisionGroups) ? page.decisionGroups : [];
  const activeSurface = currentSurface(page);
  const activeSurfaceId = activeSurface.id || "";
  const lines = [];
  const emittedControlIds = new Set();

  lines.push(`[Stage] ${clean(page.step || "unknown", 100)}`);
  lines.push(`[Page] ${clean(page.summary?.title || page.currentSurface?.pageTitle || page.site || page.url || "Checkout", 180)}`);
  if (page.priceText) lines.push(`[Price] ${clean(page.priceText, 100)}`);
  if (activeSurface.type && activeSurface.type !== "page") {
    lines.push(`[Surface ${clean(activeSurface.id || activeSurface.type, 50)}] ${clean(activeSurface.label || activeSurface.type, 180)} — active`);
  } else {
    lines.push("[Surface] Page — active");
  }
  const progress = progressText(page);
  if (progress) lines.push(`[Progress] ${progress}`);
  const policy = [traveler.booking_rules, traveler.preferred_seat, traveler.baggage_preference]
    .map((item) => clean(item, 180)).filter(Boolean).join("; ");
  if (policy) lines.push(`[Policy] ${policy}`);

  for (const issue of page.validationIssues || []) {
    lines.push(`[Validation ${clean(issue.controlId || issue.sectionId || "stage", 50)}] ${clean(issue.message, 220)}`);
  }
  for (const error of page.errors || []) lines.push(`[Error] ${clean(error, 220)}`);

  for (const group of groups) {
    const ref = `D${hashNumber(group.decisionGroupId || group.requirementId || group.sectionLabel)}`;
    const status = clean(group.status || "unknown", 40);
    lines.push(`[Decision ${ref}] ${clean(group.sectionLabel || group.requirementId || group.sectionType || "Choice", 160)} — ${group.required ? "required" : "optional"} — ${status}`);
    if (group.selectedLabel) lines.push(`  Selected: ${clean(group.selectedLabel, 180)}`);
    const alternatives = Array.isArray(group.alternatives) ? group.alternatives : [];
    const seatAlternatives = alternatives.filter(isSeatCell);
    if (seatAlternatives.length) {
      const aggregate = summarizeSeatCells(seatAlternatives);
      lines.push(`  [Seat cells aggregated] ${aggregate.total} total — ${aggregate.available} available — ${aggregate.selected} selected — ${aggregate.paid} paid — ${aggregate.disabled} disabled`);
    }
    for (const option of alternatives.filter((item) => !isSeatCell(item))) {
      const control = controls.find((item) => item.controlId === option.controlId) || option;
      const refId = stableControlRef(control);
      const state = [option.selected ? "selected" : "", option.risk, option.priceText].filter(Boolean).join(" — ");
      lines.push(`  [Option ${refId}] ${clean(option.label || control.label, 180)}${state ? ` — ${clean(state, 120)}` : ""}`);
      if (option.controlId) emittedControlIds.add(option.controlId);
    }
  }

  const seatCells = controls.filter(isSeatCell);
  if (seatCells.length && !groups.some((group) => (group.alternatives || []).some(isSeatCell))) {
    const aggregate = summarizeSeatCells(seatCells);
    lines.push(`[Seat cells aggregated] ${aggregate.total} total — ${aggregate.available} available — ${aggregate.selected} selected — ${aggregate.paid} paid — ${aggregate.disabled} disabled`);
  }

  const remaining = controls.filter((control) => (
    !emittedControlIds.has(control.controlId)
    && !isSeatCell(control)
    && isImportantControl(control, activeSurfaceId)
  ));
  for (const control of remaining.slice(0, 90)) {
    const kind = controlPrefix(control) === "F" ? "Input" : controlPrefix(control) === "O" ? "Option" : controlPrefix(control) === "B" ? "Button" : "Control";
    const state = controlStateText(control);
    lines.push(`[${kind} ${stableControlRef(control)}] ${clean(control.label || control.accessibleName || control.semantic || "Unlabelled control", 180)}${state ? ` — ${state}` : ""}`);
    if (control.controlId) emittedControlIds.add(control.controlId);
  }

  for (const section of page.sections || []) {
    if (lines.length > 150) break;
    const sectionControlIds = section.controlIds || [
      ...(section.fields || []).map((item) => item.controlId),
      ...(section.choices || []).map((item) => item.controlId),
      ...(section.buttons || []).map((item) => item.controlId)
    ];
    const hasEmittedChild = sectionControlIds.some((controlId) => emittedControlIds.has(controlId));
    if (!hasEmittedChild && (section.required || section.paidChoice)) {
      lines.push(`[Section S${hashNumber(section.id || section.label)}] ${clean(section.label || section.type, 160)} — ${section.required ? "required" : "optional"}`);
    }
  }

  let markdown = lines.filter(Boolean).join("\n");
  if (markdown.length > MAX_MARKDOWN_CHARS) {
    markdown = `${markdown.slice(0, MAX_MARKDOWN_CHARS - 80)}\n[Truncated] Non-critical controls omitted.`;
  }
  return {
    markdown,
    stats: {
      sourceControls: controls.length,
      emittedControls: emittedControlIds.size,
      aggregatedSeatCells: seatCells.length,
      characters: markdown.length
    }
  };
}

module.exports = { compactWholePageMarkdown, stableControlRef, isSeatCell };
const { currentSurface } = require("./surface-contract");
