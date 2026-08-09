export function createDebugDiagnostics({
  addAgentMessage,
  agent,
  buildPageMap,
  getFilledFields,
  getWarnings,
  renderSidebar,
  traveler
}) {
  function debugSnapshot() {
    const map = agent.pageMap || buildPageMap();
    return {
      captured_at: new Date().toISOString(),
      url: location.href,
      host: location.host,
      traveler: traveler() ? [traveler().first_name, traveler().last_name].filter(Boolean).join(" ") : "",
      agent_state: {
        sessionId: agent.sessionId,
        running: agent.running,
        awaiting: agent.awaiting,
        activeTurnId: agent.activeTurnId,
        activeObservationId: agent.activeObservationId,
        skipPaidExtrasApproved: agent.skipPaidExtrasApproved,
        skipRoutineRunning: agent.skipRoutineRunning,
        repeatClickCount: agent.repeatClickCount
      },
      page: {
        site: map.site,
        step: map.step,
        coverage: map.coverage,
        summary: map.summary,
        errors: map.errors,
        paidChoices: map.paidChoices,
        fields: map.fields.map((field) => ({
          id: field.id,
          label: field.label,
          box: field.box,
          kind: field.kind,
          field: field.field,
          required: field.required,
          hasValue: Boolean(field.value),
          confidence: field.confidence
        })),
        buttons: map.buttons.map((button) => ({
          id: button.id,
          label: button.label,
          box: button.box,
          risk: button.risk
        })),
        overlays: (map.overlays || []).map((overlay) => ({
          id: overlay.id,
          label: overlay.label,
          box: overlay.box,
          role: overlay.role
        })),
        text_sample: map.text.slice(0, 1500)
      },
      messages: agent.messages,
      actionHistory: agent.actionHistory,
      lastActionResult: agent.lastActionResult,
      actionLedger: agent.actionLedger,
      flowLog: agent.flowLog,
      lastBackendDebug: agent.lastBackendDebug,
      filledFields: getFilledFields(),
      warnings: getWarnings(),
      events: agent.debugLog
    };
  }

  async function copyDebugLog() {
    const text = JSON.stringify(debugSnapshot(), null, 2);
    try {
      await navigator.clipboard.writeText(text);
      addAgentMessage("assistant", "Debug log copied. Paste it here and I can see what the agent saw and decided.");
    } catch (error) {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.left = "-9999px";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
      addAgentMessage("assistant", "Debug log copied with alternate clipboard method. Paste it here.");
    }
    renderSidebar("agent");
  }


  return {
    copyDebugLog,
    debugSnapshot
  };
}
