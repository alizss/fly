chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(["apiBase"]);
  if (!existing.apiBase) {
    await chrome.storage.local.set({ apiBase: "http://localhost:4173/api" });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (["ATW_TRUSTED_POINTER_CLICK", "ATW_TRUSTED_CHOICE", "ATW_TRUSTED_KEY"].includes(message?.type)) {
    const tabId = sender.tab?.id;
    const x = Number(message.x);
    const y = Number(message.y);
    const choiceLabel = String(message.choiceLabel || "").trim().slice(0, 120);
    const choiceRequest = message.type === "ATW_TRUSTED_CHOICE";
    const keyRequest = message.type === "ATW_TRUSTED_KEY";
    const requestedKey = String(message.key || "");
    const governed = message.governed === true
      && Boolean(message.actionId)
      && Boolean(message.observationId)
      && Boolean(message.controlId);
    if (!Number.isInteger(tabId)
      || !governed
      || (!keyRequest && (
        !Number.isFinite(x)
        || !Number.isFinite(y)
        || x < 0
        || y < 0
      ))
      || (choiceRequest && !choiceLabel)
      || (keyRequest && !["Escape", "Tab"].includes(requestedKey))) {
      sendResponse({ ok: false, code: "INVALID_TRUSTED_INPUT_REQUEST" });
      return false;
    }
    const target = { tabId };
    const attach = () => new Promise((resolve, reject) => {
      chrome.debugger.attach(target, "1.3", () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });
    const command = (method, params) => new Promise((resolve, reject) => {
      chrome.debugger.sendCommand(target, method, params, (result) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(result);
      });
    });
    const detach = () => new Promise((resolve) => {
      chrome.debugger.detach(target, () => resolve());
    });
    (async () => {
      let attached = false;
      try {
        await attach();
        attached = true;
        if (keyRequest) {
          const keyCode = requestedKey === "Escape" ? 27 : 9;
          const code = requestedKey === "Escape" ? "Escape" : "Tab";
          await command("Input.dispatchKeyEvent", {
            type: "keyDown",
            key: requestedKey,
            code,
            windowsVirtualKeyCode: keyCode,
            nativeVirtualKeyCode: keyCode
          });
          await command("Input.dispatchKeyEvent", {
            type: "keyUp",
            key: requestedKey,
            code,
            windowsVirtualKeyCode: keyCode,
            nativeVirtualKeyCode: keyCode
          });
        } else {
          const common = { x: Math.round(x), y: Math.round(y), button: "left", pointerType: "mouse" };
          await command("Input.dispatchMouseEvent", { type: "mouseMoved", ...common, button: "none" });
          await command("Input.dispatchMouseEvent", { type: "mousePressed", ...common, clickCount: 1 });
          await command("Input.dispatchMouseEvent", { type: "mouseReleased", ...common, clickCount: 1 });
        }
        if (choiceRequest) {
          await new Promise((resolve) => setTimeout(resolve, 120));
          for (const character of choiceLabel) {
            await command("Input.dispatchKeyEvent", {
              type: "keyDown",
              key: character,
              text: character,
              unmodifiedText: character
            });
            await command("Input.dispatchKeyEvent", {
              type: "keyUp",
              key: character
            });
          }
          await new Promise((resolve) => setTimeout(resolve, 80));
          await command("Input.dispatchKeyEvent", {
            type: "keyDown",
            key: "Enter",
            code: "Enter",
            windowsVirtualKeyCode: 13,
            nativeVirtualKeyCode: 13
          });
          await command("Input.dispatchKeyEvent", {
            type: "keyUp",
            key: "Enter",
            code: "Enter",
            windowsVirtualKeyCode: 13,
            nativeVirtualKeyCode: 13
          });
        }
        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({ ok: false, code: "TRUSTED_INPUT_UNAVAILABLE", error: error.message });
      } finally {
        if (attached) await detach();
      }
    })();
    return true;
  }

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
