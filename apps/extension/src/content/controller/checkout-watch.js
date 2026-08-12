const OBSERVED_ATTRIBUTES = [
  "checked", "selected", "value", "disabled", "required", "hidden", "open", "class", "style",
  "aria-checked", "aria-selected", "aria-expanded", "aria-disabled", "aria-invalid", "aria-hidden", "aria-valuenow",
  "data-price", "data-selected", "data-value"
];

export function createCheckoutWatcher({
  destinationMutationSettleMs,
  getDestinationWait,
  hasFilledFields,
  onExternalMaterialMutation = () => {},
  pageStateStore,
  refreshSidebarWarnings,
  scheduleDestinationObservation
}) {
  let observer = null;
  let renderTimer = null;

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
        return !target?.closest?.("#atw-sidebar, #atw-agent-cursor, .atw-agent-cursor");
      });
      if (pageChanged && externalPageMutation) onExternalMaterialMutation(Date.now());
      if (pageChanged && externalPageMutation && getDestinationWait()?.status === "WAITING_FOR_DESTINATION") {
        scheduleDestinationObservation("dom_mutation", destinationMutationSettleMs);
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
    renderTimer = null;
  }

  return Object.freeze({ watch, stop });
}
