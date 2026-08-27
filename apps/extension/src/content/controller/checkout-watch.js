const OBSERVED_ATTRIBUTES = [
  "checked", "selected", "value", "disabled", "required", "hidden", "open", "class", "style",
  "aria-checked", "aria-selected", "aria-expanded", "aria-disabled", "aria-invalid", "aria-hidden", "aria-valuenow",
  "data-price", "data-selected", "data-value"
];

export function createCheckoutWatcher({
  destinationMutationSettleMs,
  getDestinationWait,
  hasFilledFields,
  onMaterialPageChange,
  pageStateStore,
  refreshSidebarWarnings,
  scheduleDestinationObservation
}) {
  let observer = null;
  let renderTimer = null;
  let materialWakeTimer = null;

  const onInput = (event) => pageStateStore.noteEvent(event);
  const onScroll = (event) => pageStateStore.noteEvent({
    type: "viewport",
    target: event.target === document ? document.documentElement : event.target
  });
  const onResize = () => pageStateStore.noteEvent({ type: "viewport", target: document.documentElement });

  function watch() {
    if (observer) return observer;
    observer = new MutationObserver((mutations) => {
      const pageChanged = pageStateStore.noteMutations(mutations);
      const externalPageMutation = mutations.some((mutation) => {
        const target = mutation.target?.nodeType === Node.ELEMENT_NODE
          ? mutation.target
          : mutation.target?.parentElement;
        if (target?.closest?.("#atw-sidebar, #atw-agent-cursor, .atw-agent-cursor")) return false;
        const changedNodes = mutation.type === "childList"
          ? [...(mutation.addedNodes || []), ...(mutation.removedNodes || [])]
          : [];
        return !changedNodes.length || changedNodes.some((node) => {
          const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
          return element && !element.matches?.("#atw-sidebar, #atw-agent-cursor, .atw-agent-cursor")
            && !element.closest?.("#atw-sidebar, #atw-agent-cursor, .atw-agent-cursor");
        });
      });
      const destinationWaiting = getDestinationWait()?.status === "WAITING_FOR_DESTINATION";
      if (pageChanged && externalPageMutation && destinationWaiting) {
        scheduleDestinationObservation("dom_mutation", destinationMutationSettleMs);
      }
      if (pageChanged && externalPageMutation && !destinationWaiting) {
        if (materialWakeTimer) clearTimeout(materialWakeTimer);
        materialWakeTimer = setTimeout(() => {
          materialWakeTimer = null;
          // A stage-exit receipt may establish destination ownership after
          // the source mutation scheduled this callback. Its bounded
          // mutation/deadline lifecycle is then the sole wake authority.
          if (getDestinationWait()?.status === "WAITING_FOR_DESTINATION") return;
          onMaterialPageChange?.();
        }, destinationMutationSettleMs);
      }
      if (!pageChanged || renderTimer) return;
      renderTimer = setTimeout(() => {
        renderTimer = null;
        if (!hasFilledFields()) refreshSidebarWarnings();
      }, 180);
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeOldValue: true,
      attributeFilter: OBSERVED_ATTRIBUTES
    });
    pageStateStore.attachMutationObserver(observer);
    document.addEventListener("input", onInput, true);
    document.addEventListener("change", onInput, true);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize, { passive: true });
    return observer;
  }

  function stop() {
    observer?.disconnect();
    observer = null;
    document.removeEventListener("input", onInput, true);
    document.removeEventListener("change", onInput, true);
    document.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", onResize);
    if (renderTimer) clearTimeout(renderTimer);
    if (materialWakeTimer) clearTimeout(materialWakeTimer);
    renderTimer = null;
    materialWakeTimer = null;
  }

  return Object.freeze({ watch, stop });
}
