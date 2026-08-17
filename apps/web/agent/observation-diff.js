const { stableControlRef } = require("./observation-markdown");
const { currentSurface } = require("./surface-contract");

function clean(value, limit = 180) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function pageOf(observation = {}) {
  return observation?.page || {};
}

function surfaceOf(page = {}) {
  return currentSurface(page);
}

function controlState(control = {}) {
  const state = control.state || control.controlState || {};
  return {
    label: clean(control.label || control.accessibleName, 180),
    selected: Boolean(control.selected || state.selected || state.checked),
    value: clean(state.normalizedValue || state.value || "", 120),
    expanded: state.expanded === true,
    disabled: Boolean(state.disabled || control.disabled),
    visible: control.visualRegion?.inViewport !== false,
    surfaceId: clean(control.surfaceId, 80),
    semantic: clean(control.semantic, 80),
    risk: clean(control.risk, 60)
  };
}

function controlSummary(control = {}) {
  return {
    ref: stableControlRef(control),
    controlId: clean(control.controlId, 140),
    label: clean(control.label || control.accessibleName, 180),
    role: clean(control.role || control.kind, 80),
    semantic: clean(control.semantic, 80),
    surfaceId: clean(control.surfaceId, 80)
  };
}

function errorsOf(page = {}) {
  return [...(page.validationIssues || []).map((issue) => ({
    key: clean(issue.issueId || `${issue.controlId}:${issue.message}`, 240),
    message: clean(issue.message, 220),
    controlId: clean(issue.controlId, 140),
    sectionId: clean(issue.sectionId, 80),
    stageWide: issue.stageWide === true
  })), ...(page.errors || []).map((message) => ({
    key: clean(message, 240), message: clean(message, 220), controlId: "", sectionId: "", stageWide: true
  }))];
}

function progressOf(page = {}) {
  return page.foreground?.progressMarkers
    || page.visualState?.foreground?.progressMarkers
    || page.currentSurface?.foreground?.progressMarkers
    || null;
}

function priceOf(page = {}) {
  return {
    text: clean(page.priceText, 100),
    amount: Number.isFinite(Number(page.price?.amount)) ? Number(page.price.amount) : null,
    currency: clean(page.price?.currency, 20)
  };
}

function same(valueA, valueB) {
  return JSON.stringify(valueA) === JSON.stringify(valueB);
}

function diffObservations(previousObservation = null, currentObservation = {}) {
  const before = pageOf(previousObservation || {});
  const after = pageOf(currentObservation);
  const initial = !previousObservation?.observationId;
  const beforeControls = new Map((before.controls || []).map((control) => [control.controlId, control]));
  const afterControls = new Map((after.controls || []).map((control) => [control.controlId, control]));
  const appeared = [];
  const disappeared = [];
  const changed = [];
  const becameEnabled = [];
  const becameDisabled = [];

  if (!initial) {
    for (const [controlId, control] of afterControls) {
      const prior = beforeControls.get(controlId);
      if (!prior) {
        appeared.push(controlSummary(control));
        continue;
      }
      const beforeState = controlState(prior);
      const afterState = controlState(control);
      const changes = {};
      for (const key of Object.keys(afterState)) {
        if (!same(beforeState[key], afterState[key])) changes[key] = { from: beforeState[key], to: afterState[key] };
      }
      if (Object.keys(changes).length) changed.push({ ...controlSummary(control), changes });
      if (beforeState.disabled && !afterState.disabled) becameEnabled.push(controlSummary(control));
      if (!beforeState.disabled && afterState.disabled) becameDisabled.push(controlSummary(control));
    }
    for (const [controlId, control] of beforeControls) {
      if (!afterControls.has(controlId)) disappeared.push(controlSummary(control));
    }
  }

  const beforeGroups = new Map((before.decisionGroups || []).map((group) => [group.decisionGroupId, group]));
  const decisionChanges = [];
  if (!initial) {
    for (const group of after.decisionGroups || []) {
      const prior = beforeGroups.get(group.decisionGroupId);
      if (!prior) continue;
      if (prior.status !== group.status || prior.selectedControlId !== group.selectedControlId || prior.selectedLabel !== group.selectedLabel) {
        decisionChanges.push({
          decisionGroupId: clean(group.decisionGroupId, 140),
          label: clean(group.sectionLabel || group.requirementId, 160),
          status: { from: clean(prior.status, 40), to: clean(group.status, 40) },
          selected: { from: clean(prior.selectedLabel, 160), to: clean(group.selectedLabel, 160) }
        });
      }
    }
  }

  const beforeSurface = surfaceOf(before);
  const afterSurface = surfaceOf(after);
  const beforeSurfaceActive = beforeSurface.type && beforeSurface.type !== "page";
  const afterSurfaceActive = afterSurface.type && afterSurface.type !== "page";
  const surfaceChanged = !initial && !same(
    { id: beforeSurface.id, type: beforeSurface.type, label: beforeSurface.label },
    { id: afterSurface.id, type: afterSurface.type, label: afterSurface.label }
  );
  const modalOpened = Boolean(!initial && afterSurfaceActive && (!beforeSurfaceActive || surfaceChanged))
    ? { id: clean(afterSurface.id, 80), type: clean(afterSurface.type, 80), label: clean(afterSurface.label, 180) }
    : null;
  const modalClosed = Boolean(!initial && beforeSurfaceActive && (!afterSurfaceActive || surfaceChanged))
    ? { id: clean(beforeSurface.id, 80), type: clean(beforeSurface.type, 80), label: clean(beforeSurface.label, 180) }
    : null;
  const beforeErrors = errorsOf(before);
  const afterErrors = errorsOf(after);
  const beforeErrorKeys = new Set(beforeErrors.map((error) => error.key));
  const afterErrorKeys = new Set(afterErrors.map((error) => error.key));
  const errorsAppeared = initial ? [] : afterErrors.filter((error) => !beforeErrorKeys.has(error.key));
  const errorsCleared = initial ? [] : beforeErrors.filter((error) => !afterErrorKeys.has(error.key));
  const previousPrice = priceOf(before);
  const currentPrice = priceOf(after);
  const priceChanged = !initial && !same(previousPrice, currentPrice)
    ? { from: previousPrice, to: currentPrice }
    : null;
  const stageChanged = !initial && clean(before.step, 80) !== clean(after.step, 80)
    ? { from: clean(before.step, 80), to: clean(after.step, 80) }
    : null;
  const urlChanged = !initial && clean(before.url, 500) !== clean(after.url, 500)
    ? { from: clean(before.url, 500), to: clean(after.url, 500) }
    : null;
  const beforeProgress = progressOf(before);
  const currentProgress = progressOf(after);
  const progressChanged = !initial && !same(beforeProgress, currentProgress)
    ? { from: beforeProgress, to: currentProgress }
    : null;
  const selectionChanged = decisionChanges.length > 0 || changed.some((entry) => entry.changes.selected || entry.changes.value);
  const lastResult = currentObservation.lastActionResult || {};
  const targetControlId = clean(lastResult.controlId || lastResult.action?.controlId, 140);
  const targetChanged = targetControlId && changed.some((entry) => entry.controlId === targetControlId);
  const targetDisappeared = targetControlId && disappeared.some((entry) => entry.controlId === targetControlId);
  const targetReacted = Boolean(
    lastResult.dispatched === true
    && (targetChanged || targetDisappeared || surfaceChanged || progressChanged || stageChanged || urlChanged || errorsAppeared.length || errorsCleared.length)
  );

  return {
    fromObservationId: clean(previousObservation?.observationId, 120),
    toObservationId: clean(currentObservation?.observationId, 120),
    initial,
    appeared: appeared.slice(0, 40),
    disappeared: disappeared.slice(0, 40),
    changed: changed.slice(0, 40),
    decisionChanges: decisionChanges.slice(0, 20),
    becameEnabled: becameEnabled.slice(0, 20),
    becameDisabled: becameDisabled.slice(0, 20),
    modalOpened,
    modalClosed,
    errorsAppeared: errorsAppeared.slice(0, 20),
    errorsCleared: errorsCleared.slice(0, 20),
    priceChanged,
    stageChanged,
    urlChanged,
    progressChanged,
    selectionChanged,
    surfaceChanged,
    targetReacted
  };
}

function formatObservationDiffMarkdown(diff = {}, currentObservation = {}) {
  const page = pageOf(currentObservation);
  const lines = [];
  if (diff.initial) lines.push("INITIAL OBSERVATION");
  const changes = [];
  for (const item of diff.decisionChanges || []) changes.push(`${item.label}: ${item.status.from || "unknown"} → ${item.status.to || "unknown"}${item.selected.to ? ` (${item.selected.to})` : ""}`);
  for (const item of diff.changed || []) changes.push(`${item.ref} ${item.label}: ${Object.entries(item.changes).map(([key, value]) => `${key} ${String(value.from)} → ${String(value.to)}`).join(", ")}`);
  if (diff.stageChanged) changes.push(`Stage: ${diff.stageChanged.from} → ${diff.stageChanged.to}`);
  if (diff.progressChanged) changes.push(`Progress: ${clean(JSON.stringify(diff.progressChanged.from), 120)} → ${clean(JSON.stringify(diff.progressChanged.to), 120)}`);
  if (diff.priceChanged) changes.push(`Price: ${diff.priceChanged.from.text || diff.priceChanged.from.amount} → ${diff.priceChanged.to.text || diff.priceChanged.to.amount}`);
  if (changes.length) lines.push("CHANGED:", ...changes.slice(0, 30).map((line) => `- ${line}`));
  if (diff.appeared?.length || diff.modalOpened) {
    lines.push("APPEARED:");
    if (diff.modalOpened) lines.push(`- ${diff.modalOpened.type}: ${diff.modalOpened.label}`);
    for (const item of diff.appeared || []) lines.push(`- [${item.ref}] ${item.label}`);
  }
  if (diff.disappeared?.length || diff.modalClosed) {
    lines.push("DISAPPEARED:");
    if (diff.modalClosed) lines.push(`- ${diff.modalClosed.type}: ${diff.modalClosed.label}`);
    for (const item of diff.disappeared || []) lines.push(`- [${item.ref}] ${item.label}`);
  }
  if (diff.errorsAppeared?.length) lines.push("VALIDATION APPEARED:", ...diff.errorsAppeared.map((error) => `- ${error.message}`));
  if (diff.errorsCleared?.length) lines.push("VALIDATION CLEARED:", ...diff.errorsCleared.map((error) => `- ${error.message}`));
  lines.push("CURRENT:", `- Stage: ${clean(page.step || "unknown", 80)}`);
  const surface = surfaceOf(page);
  lines.push(`- Surface: ${clean(surface.label || surface.type || "Page", 180)}`);
  if (page.priceText) lines.push(`- Price: ${clean(page.priceText, 100)}`);
  return lines.join("\n").slice(0, 8_000);
}

function conciseActionFeedback(diff = {}, result = {}) {
  return {
    dispatched: result.dispatched === true,
    targetReacted: diff.targetReacted === true,
    selectionChanged: diff.selectionChanged === true,
    surfaceChanged: diff.surfaceChanged === true,
    progressChanged: Boolean(diff.progressChanged),
    priceChanged: Boolean(diff.priceChanged)
  };
}

module.exports = { conciseActionFeedback, diffObservations, formatObservationDiffMarkdown };
