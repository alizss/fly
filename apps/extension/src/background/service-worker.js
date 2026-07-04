chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(["apiBase"]);
  if (!existing.apiBase) {
    await chrome.storage.local.set({ apiBase: "http://localhost:4173/api" });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "ATW_CAPTURE_VISIBLE_TAB") return false;

  chrome.tabs.captureVisibleTab(sender.tab?.windowId, { format: "jpeg", quality: 35 }, (dataUrl) => {
    if (chrome.runtime.lastError || !dataUrl) {
      sendResponse({ ok: false, error: chrome.runtime.lastError?.message || "Screenshot unavailable" });
      return;
    }
    sendResponse({ ok: true, dataUrl });
  });

  return true;
});
