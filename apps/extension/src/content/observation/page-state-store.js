export function createPageStateStore({
  buildPageMap,
  rememberPagePlan,
  observationHashForMap,
  emptyPageStateDiff,
  canonicalPageStateDiff,
  pageStateDiffIsMaterial,
  mutationMayBeMaterial,
  mutationOwnedControlId,
  elementById,
  canonicalControlForElement,
  syncIncrementalControlModels,
  syncRequiredProfileChoiceGroups,
  buildCanonicalDecisionGroups,
  buildAuthoritativeStageExit,
  logFlow,
  sleep,
  onMaterialMutation = () => {}
}) {
  let canonical = null;
  let canonicalUrl = "";
  let dirty = true;
  let pendingMutations = [];
  let lastMaterialMutationAt = 0;
  let mutationVersion = 0;
  const mutationObservers = new Set();
  let incrementalUpdates = 0;
  let update = {
    mode: "uninitialized",
    reason: "initial",
    baseSnapshotHash: "",
    snapshotHash: "",
    diff: emptyPageStateDiff(),
    material: true,
    timings: {}
  };

  const recordMutation = (mutation) => {
    if (!mutationMayBeMaterial(mutation)) return false;
    mutationVersion += 1;
    pendingMutations.push(mutation);
    pendingMutations = pendingMutations.slice(-240);
    lastMaterialMutationAt = performance.now();
    dirty = true;
    onMaterialMutation(Date.now());
    return true;
  };

  const noteMutations = (mutations = []) => {
    let material = false;
    for (const mutation of mutations) material = recordMutation(mutation) || material;
    return material;
  };
  const noteEvent = (event) => recordMutation({ type: event.type, target: event.target });

  const attachMutationObserver = (observer) => {
    if (observer?.takeRecords) mutationObservers.add(observer);
    return observer;
  };

  const drainMutationRecords = () => {
    let material = false;
    for (const observer of mutationObservers) {
      const records = observer.takeRecords?.() || [];
      if (records.length) material = noteMutations(records) || material;
    }
    return material;
  };

  const mutationTargets = () => [...new Set(pendingMutations.map((mutation) => (
    mutation.target?.nodeType === Node.ELEMENT_NODE ? mutation.target : mutation.target?.parentElement
  )).filter(Boolean))];

  const canRefreshIncrementally = () => {
    if (!canonical || !pendingMutations.length || incrementalUpdates >= 24) return false;
    if (pendingMutations.some((mutation) => mutation.type === "childList" || mutation.type === "characterData")) return false;
    const targets = mutationTargets();
    const ids = targets.map(mutationOwnedControlId).filter(Boolean);
    return ids.length > 0 && ids.length === targets.length;
  };

  const refreshControls = () => {
    const next = {
      ...canonical,
      controls: [...(canonical.controls || [])],
      transactionFacts: canonical.transactionFacts ? { ...canonical.transactionFacts } : null
    };
    const controlsById = new Map(next.controls.map((control) => [control.controlId, control]));
    const dirtyIds = [...new Set(mutationTargets().map(mutationOwnedControlId).filter(Boolean))];
    for (const controlId of dirtyIds) {
      const prior = controlsById.get(controlId);
      if (!prior) return null;
      const live = elementById(prior.stateElementId)
        || document.querySelector(`[data-atw-control-id="${CSS.escape(controlId)}"]`);
      if (!live || !live.isConnected) return null;
      const surface = prior.surfaceId === canonical.currentSurface?.id ? canonical.currentSurface : {
        id: prior.surfaceId || "surface-page",
        type: prior.surfaceType || "page",
        label: prior.surfaceLabel || ""
      };
      const refreshed = canonicalControlForElement(live, {
        field: prior.fieldType || prior.field || "",
        fieldType: prior.fieldType || "",
        required: prior.required,
        decisionGroupId: prior.decisionGroupId || "",
        sectionId: prior.sectionId || "",
        sectionType: prior.sectionType || "",
        sectionLabel: prior.sectionLabel || "",
        surface
      });
      if (!refreshed || refreshed.controlId !== controlId) return null;
      const fieldType = refreshed.fieldType || prior.fieldType || "";
      controlsById.set(controlId, {
        ...refreshed,
        fieldType,
        fieldClassification: refreshed.fieldClassification?.fieldType
          ? refreshed.fieldClassification
          : (prior.fieldClassification || null),
        semantic: fieldType || (refreshed.semantic && refreshed.semantic !== "unknown" ? refreshed.semantic : prior.semantic),
        semanticIntent: fieldType || (refreshed.semanticIntent && refreshed.semanticIntent !== "unknown" ? refreshed.semanticIntent : prior.semanticIntent),
        meaning: fieldType || refreshed.meaning || prior.meaning
      });
    }
    next.controls = next.controls.map((control) => controlsById.get(control.controlId) || control);
    syncIncrementalControlModels(next, controlsById);
    syncRequiredProfileChoiceGroups(next.fields || [], next.controls || [], next.sections || []);
    next.decisionGroups = buildCanonicalDecisionGroups(next.sections || [], next.controls, next.currentSurface || {});
    next.decisionContracts = next.decisionGroups
      .map((group) => group.decisionContract)
      .filter(Boolean);
    next.stageExit = buildAuthoritativeStageExit({
      decisionGroups: next.decisionGroups,
      fields: next.fields,
      buttons: next.buttons,
      errors: next.errors,
      step: next.step,
      controls: next.controls,
      currentSurface: next.currentSurface
    });
    next.summary = {
      ...(next.summary || {}),
      fields: next.fields.length,
      knownFields: next.fields.filter((field) => field.field !== "unknown").length,
      buttons: next.buttons.length,
      controls: next.controls.length,
      decisionGroups: next.decisionGroups.length,
      continueAllowed: next.stageExit.continueAllowed
    };
    return next;
  };

  const observe = ({ forceFull = false, reason = "observe" } = {}) => {
    const startedAt = performance.now();
    drainMutationRecords();
    const urlChanged = Boolean(canonicalUrl && canonicalUrl !== location.href);
    if (canonical && !dirty && !forceFull && !urlChanged) {
      update = {
        ...update,
        mode: "cached",
        reason,
        diff: emptyPageStateDiff(),
        material: false,
        fresh: true,
        captureStartVersion: mutationVersion,
        captureEndVersion: mutationVersion,
        timings: { observationBuildMs: Math.round(performance.now() - startedAt) }
      };
      return { map: canonical, ...update };
    }
    const before = canonical;
    const baseSnapshotHash = before ? observationHashForMap(before) : "";
    const captureStartVersion = mutationVersion;
    let next = null;
    let mode = "full_snapshot";
    if (!forceFull && !urlChanged && canRefreshIncrementally()) {
      next = refreshControls();
      if (next) {
        mode = "incremental";
        incrementalUpdates += 1;
      }
    }
    if (!next) {
      next = rememberPagePlan(buildPageMap());
      incrementalUpdates = 0;
      mode = before && !urlChanged && !forceFull ? "material_rescan" : "full_snapshot";
    }
    drainMutationRecords();
    const captureEndVersion = mutationVersion;
    const fresh = captureStartVersion === captureEndVersion;
    const diff = canonicalPageStateDiff(before, next);
    canonical = next;
    canonicalUrl = location.href;
    dirty = !fresh;
    if (fresh) pendingMutations = [];
    update = {
      mode,
      reason,
      baseSnapshotHash,
      snapshotHash: observationHashForMap(next),
      diff,
      material: !before || pageStateDiffIsMaterial(diff),
      fresh,
      captureStartVersion,
      captureEndVersion,
      timings: { observationBuildMs: Math.round(performance.now() - startedAt) }
    };
    logFlow("page_state.updated", {
      mode,
      reason,
      material: update.material,
      fresh,
      captureStartVersion,
      captureEndVersion,
      baseSnapshotHash,
      snapshotHash: update.snapshotHash,
      counts: Object.fromEntries(Object.entries(diff).map(([key, entries]) => [key, entries.length])),
      observation_build_ms: update.timings.observationBuildMs
    });
    return { map: canonical, ...update };
  };

  const waitForQuiet = async ({ maxWaitMs = 650, minQuietMs = 70, awaitMutationMs = 0 } = {}) => {
    const startedAt = performance.now();
    while (!dirty && awaitMutationMs > 0 && performance.now() - startedAt < Math.min(awaitMutationMs, maxWaitMs)) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    while (dirty && performance.now() - startedAt < maxWaitMs) {
      const dynamicQuietMs = Math.min(240, minQuietMs + pendingMutations.length * 3);
      const elapsedQuiet = performance.now() - lastMaterialMutationAt;
      if (elapsedQuiet >= dynamicQuietMs) break;
      await sleep(Math.min(40, Math.max(8, dynamicQuietMs - elapsedQuiet)));
    }
    return {
      waitedMs: Math.round(performance.now() - startedAt),
      settled: !dirty || performance.now() - lastMaterialMutationAt >= minQuietMs
    };
  };

  const observeFresh = async ({
    reason = "fresh_observation",
    maxWaitMs = 800,
    maxAttempts = 2,
    postBuildGraceMs = 100
  } = {}) => {
    let lastObserved = null;
    const attempts = Math.max(1, Math.min(3, Number(maxAttempts || 2)));
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      await waitForQuiet({ maxWaitMs, minQuietMs: 80, awaitMutationMs: 0 });
      const observed = observe({
        forceFull: false,
        reason: attempt === 1 ? reason : `${reason}:fresh_retry_${attempt}`
      });
      lastObserved = observed;
      if (observed.mode !== "cached" && postBuildGraceMs > 0) {
        await waitForQuiet({
          maxWaitMs: postBuildGraceMs,
          minQuietMs: 40,
          awaitMutationMs: postBuildGraceMs
        });
      }
      drainMutationRecords();
      const stable = observed.fresh !== false
        && observed.captureEndVersion === mutationVersion
        && !dirty;
      if (stable) {
        return {
          ...observed,
          fresh: true,
          freshnessAttempts: attempt,
          mutationVersion
        };
      }
      logFlow("page_state.stale_capture_discarded", {
        reason,
        attempt,
        mode: observed.mode,
        captureStartVersion: observed.captureStartVersion,
        captureEndVersion: observed.captureEndVersion,
        currentMutationVersion: mutationVersion,
        pendingMutations: pendingMutations.length
      });
    }
    return {
      ...(lastObserved || { map: canonical, ...update }),
      fresh: false,
      freshnessAttempts: attempts,
      mutationVersion
    };
  };

  const invalidate = (reason = "integrity_recovery") => {
    dirty = true;
    pendingMutations.push({ type: "integrity", target: document.documentElement, reason });
    lastMaterialMutationAt = performance.now();
  };

  return Object.freeze({
    observe,
    observeFresh,
    waitForQuiet,
    noteMutations,
    noteEvent,
    attachMutationObserver,
    invalidate,
    current: () => canonical,
    lastUpdate: () => update,
    isDirty: () => dirty,
    pendingCount: () => pendingMutations.length,
    mutationVersion: () => mutationVersion
  });
}
