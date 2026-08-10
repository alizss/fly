import { currentNavigationUrl } from "../navigation-identity.js";

export function createFlowDiagnostics({
  DEFAULT_API,
  actionableCheckoutErrors,
  agent,
  buildPageMap,
  compactText,
  foregroundSurfaceState,
  logAgentEvent,
  observationHashForMap,
  pageSignature,
  visualPageState
}) {
  function pageSnapshot(label = "") {
    const map = agent.pageMap || buildPageMap();
    return {
      label,
      url: currentNavigationUrl(),
      site: map.site,
      // The extension reports observed facts and capabilities only. Checkout
      // stage is reduced authoritatively by the backend from this payload.
      step: "unknown",
      signature: pageSignature(map).slice(0, 900),
      snapshotHash: observationHashForMap(map),
      graphIntegrity: map.graphIntegrity || null,
      foreground: map.foreground || foregroundSurfaceState(map.currentSurface || {}),
      visualState: map.visualState || visualPageState(map),
      accessibility: map.accessibility ? {
        foregroundSurfaceId: map.accessibility.foregroundSurfaceId,
        foregroundSurfaceType: map.accessibility.foregroundSurfaceType,
        controls: (map.accessibility.controls || []).slice(0, 40)
      } : null,
      currentSurface: map.currentSurface ? {
        id: map.currentSurface.id || "",
        type: map.currentSurface.type || "page",
        label: compactText(map.currentSurface.label, 220),
        taskHint: map.currentSurface.taskHint || "",
        blocksBackground: Boolean(map.currentSurface.blocksBackground),
        expectedResolution: map.currentSurface.expectedResolution || "",
        foreground: map.currentSurface.foreground || foregroundSurfaceState(map.currentSurface),
        visualState: map.currentSurface.visualState || null,
        options: (map.currentSurface.options || []).slice(0, 20).map((option) => ({
          id: option.id,
          label: option.label,
          risk: option.risk,
          semantic: option.semantic,
          selected: Boolean(option.selected),
          accessibility: option.accessibility || null,
          box: option.box
        })),
        buttons: (map.currentSurface.buttons || []).slice(0, 20).map((button) => ({
          id: button.id,
          label: button.label,
          risk: button.risk,
          semantic: button.semantic,
          selected: Boolean(button.selected),
          accessibility: button.accessibility || null,
          box: button.box
        })),
        taskQueue: (map.currentSurface.taskQueue || []).map((task) => ({
          id: task.id,
          sectionType: task.sectionType,
          sectionLabel: task.sectionLabel,
          status: task.status
        })).slice(0, 8)
      } : null,
      surfaceStack: (map.surfaceStack || []).map((surface) => ({
        id: surface.id || "",
        type: surface.type || "page",
        label: compactText(surface.label, 160),
        isCurrent: Boolean(surface.isCurrent),
        blocksBackground: Boolean(surface.blocksBackground),
        taskTypes: (surface.taskQueue || []).map((task) => task.sectionType).slice(0, 8),
        expectedResolution: surface.expectedResolution || ""
      })),
      summary: map.summary,
      errors: actionableCheckoutErrors(map.errors),
      visibleControls: [...(map.buttons || []), ...(map.fields || [])]
        .filter((item) => item.box?.inViewport)
        .slice(0, 24)
        .map((item) => ({
          id: item.id,
          label: compactText(item.label || item.field || "", 100),
          risk: item.risk || "",
          field: item.field || "",
          box: item.box
        }))
    };
  }

  function sendFlowLog(entry) {
    const apiBase = agent.apiBase || DEFAULT_API;
    fetch(`${apiBase}/agent/client-log`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: agent.sessionId || "",
        clientTurnId: entry.turnId || agent.activeTurnId || "",
        entry
      })
    }).catch(() => {
      // Logging must never slow or break the checkout agent.
    });
  }

  function compactFlowLogTarget(target = {}) {
    if (!target || typeof target !== "object") return target || null;
    return {
      id: String(target.id || target.targetId || ""),
      controlId: String(target.controlId || ""),
      actuatorId: String(target.actuatorId || target.targetId || ""),
      stableKey: compactText(target.stableKey || "", 240),
      label: compactText(target.label || target.targetLabel || target.accessibleName || "", 240),
      role: String(target.role || target.kind || ""),
      semantic: String(target.semantic || target.fieldType || ""),
      risk: String(target.risk || ""),
      surfaceId: String(target.surfaceId || ""),
      decisionGroupId: String(target.decisionGroupId || ""),
      state: target.state ? {
        selected: target.state.selected === true || target.state.checked === true,
        valuePresent: target.state.valuePresent === true,
        normalizedValue: compactText(target.state.normalizedValue || target.state.selectedValue || "", 160),
        disabled: target.state.disabled === true,
        expanded: target.state.expanded === true
      } : null,
      box: target.box || target.visualRegion || null
    };
  }

  function compactFlowLogPage(page = {}) {
    if (!page || typeof page !== "object") return page || null;
    return {
      site: String(page.site || ""),
      url: compactText(page.url || "", 500),
      step: String(page.step || ""),
      snapshotHash: String(page.snapshotHash || page.observationSnapshot?.snapshotHash || ""),
      currentSurface: page.currentSurface ? {
        id: String(page.currentSurface.id || ""),
        type: String(page.currentSurface.type || "page"),
        label: compactText(page.currentSurface.label || "", 240),
        blocksBackground: page.currentSurface.blocksBackground === true
      } : null,
      summary: page.summary ? {
        fields: Number(page.summary.fields || 0),
        controls: Number(page.summary.controls || 0),
        decisionGroups: Number(page.summary.decisionGroups || 0),
        errors: Number(page.summary.errors || 0),
        paidChoices: Number(page.summary.paidChoices || 0),
        pendingTasks: Number(page.summary.pendingTasks || 0),
        continueAllowed: page.summary.continueAllowed === true,
        priceText: compactText(page.summary.priceText || "", 100)
      } : null,
      errors: (page.errors || []).slice(0, 8).map((error) => compactText(
        typeof error === "string" ? error : error.message || error.label || "",
        240
      ))
    };
  }

  function compactFlowLogValue(value, key = "", depth = 0) {
    if (value == null || typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value === "string") return compactText(value, 900);
    if (depth >= 4) return "[bounded]";
    if (key === "page" || key === "pageBefore" || key === "pageAfterAction") {
      return compactFlowLogPage(value);
    }
    if (key === "targetSnapshot" || key === "target" || key === "resolved") {
      return compactFlowLogTarget(value);
    }
    if (Array.isArray(value)) {
      return value.slice(0, 24).map((item) => compactFlowLogValue(item, "", depth + 1));
    }
    if (typeof value !== "object") return compactText(String(value), 900);
    const dropped = new Set([
      "observation",
      "previousObservation",
      "beforeObservation",
      "afterObservation",
      "pageMap",
      "controls",
      "controlAliases",
      "candidateSet",
      "contextCapabilities",
      "normalCandidates",
      "recoveryCandidates",
      "excludedCandidates",
      "operations",
      "actuators",
      "strategies",
      "exactActuators",
      "actionabilityByActuator",
      "targetabilityByActuator",
      "visualRegions",
      "backendDebug",
      "debug",
      "processAwareness",
      "transactionReview",
      "canonicalDecisions",
      "observedDecisions",
      "semanticCompilation",
      "interactionView",
      "screenshotDataUrl"
    ]);
    const compact = {};
    for (const [childKey, childValue] of Object.entries(value).slice(0, 100)) {
      if (dropped.has(childKey)) continue;
      compact[childKey] = compactFlowLogValue(childValue, childKey, depth + 1);
    }
    return compact;
  }

  function compactFlowLogPayload(phase = "", payload = {}) {
    const compact = compactFlowLogValue(payload, "", 0) || {};
    if (JSON.stringify(compact).length <= 32_000) return compact;
    const decision = payload.decision || {};
    return {
      truncated: true,
      phase: String(phase || ""),
      turnId: String(payload.turnId || ""),
      observationId: String(payload.observationId || decision.observationId || ""),
      actionId: String(payload.actionId || decision.actionId || decision.id || ""),
      action: String(typeof payload.action === "string" ? payload.action : decision.action || ""),
      intent: String(payload.intent || decision.intent || ""),
      targetLabel: compactText(payload.targetLabel || decision.targetLabel || "", 240),
      code: String(payload.code || payload.failureCode || payload.result?.code || ""),
      reason: compactText(payload.reason || decision.reason || "", 500),
      observationBytes: Number(payload.observationBytes || 0),
      request_upload_ms: Number(payload.request_upload_ms || 0),
      turn_total_ms: Number(payload.turn_total_ms || 0),
      page: compactFlowLogPage(payload.page || payload.pageAfterAction || payload.pageBefore || {}),
      targetSnapshot: compactFlowLogTarget(payload.targetSnapshot || decision.targetSnapshot || {})
    };
  }

  function sendActionLedger(row) {
    const apiBase = agent.apiBase || DEFAULT_API;
    fetch(`${apiBase}/agent/action-ledger`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(row)
    }).catch(() => {
      // Best-effort durable audit trail; execution must not depend on logging.
    });
  }

  function shouldSendFlowLog(phase = "") {
    if (agent.sessionId || agent.activeTurnId || agent.running || agent.awaiting) return true;
    return /^(backend|execute|ledger|action|invariant|policy|target|outcome|latency)\./.test(String(phase || ""));
  }

  function logFlow(phase, payload = {}) {
    const diagnosticPayload = compactFlowLogPayload(phase, payload);
    const entry = {
      seq: agent.flowSeq + 1,
      at: new Date().toISOString(),
      turnId: payload.turnId || agent.activeTurnId || "",
      phase,
      payload: diagnosticPayload
    };
    agent.flowSeq += 1;
    agent.flowLog.push(entry);
    agent.flowLog = agent.flowLog.slice(-160);
    logAgentEvent(`flow:${phase}`, diagnosticPayload);
    // eslint-disable-next-line no-console
    console.debug("[atw-flow]", phase, diagnosticPayload);
    if (shouldSendFlowLog(phase)) sendFlowLog(entry);
    return entry;
  }


  return {
    compactFlowLogPage,
    compactFlowLogPayload,
    compactFlowLogTarget,
    logFlow,
    pageSnapshot,
    sendActionLedger
  };
}
