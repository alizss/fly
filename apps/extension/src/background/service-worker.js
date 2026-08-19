chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(["apiBase"]);
  if (!existing.apiBase) {
    await chrome.storage.local.set({ apiBase: "http://localhost:4173/api" });
  }
});

const CHECKOUT_CONTEXT_PREFIX = "atwCheckoutContextV1";
const SELECTED_BOOKING_ACQUISITION_PREFIX = "atwSelectedBookingAcquisitionV1";
const SELECTED_BOOKING_MAX_AGE_MS = 6 * 60 * 60 * 1000;

function checkoutContextKey(tabId) {
  return `${CHECKOUT_CONTEXT_PREFIX}:${tabId}`;
}

function selectedBookingAcquisitionKey(tabId) {
  return `${SELECTED_BOOKING_ACQUISITION_PREFIX}:${tabId}`;
}

function checkoutLineageId() {
  return `checkout_${Date.now().toString(36)}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function validSelectedBookingContract(raw = null, now = Date.now()) {
  if (!raw || raw.contractVersion !== "selected-booking/v1") return null;
  const selectedAt = Date.parse(String(raw.selectedAt || ""));
  const segments = Array.isArray(raw.itinerary?.segments) ? raw.itinerary.segments : [];
  const travelerIds = Array.isArray(raw.travelerIds)
    ? raw.travelerIds.map((value) => String(value || "").trim()).filter(Boolean)
    : [];
  const amount = Number(raw.approvedTotal?.amount);
  const currency = String(raw.approvedTotal?.currency || "").trim().toUpperCase();
  const completeItinerary = segments.length > 0 && segments.every((segment) => (
    String(segment?.origin || "").trim()
    && String(segment?.destination || "").trim()
    && String(segment?.departureDate || "").trim()
  ));
  const fresh = Number.isFinite(selectedAt)
    && selectedAt <= now + 60_000
    && now - selectedAt <= SELECTED_BOOKING_MAX_AGE_MS;
  if (
    !String(raw.selectionId || "").trim()
    || !fresh
    || !completeItinerary
    || !Number.isFinite(amount)
    || amount < 0
    || !currency
    || travelerIds.length === 0
  ) return null;
  return {
    ...raw,
    approvedTotal: { amount, currency },
    travelerIds
  };
}

async function readCheckoutContext(tabId) {
  if (!Number.isInteger(tabId)) return null;
  const key = checkoutContextKey(tabId);
  const stored = await chrome.storage.local.get(key);
  const context = stored?.[key] || null;
  return context?.contractVersion === "checkout-context/v1" ? context : null;
}

async function writeCheckoutContext(tabId, update = {}) {
  const now = new Date().toISOString();
  const context = {
    contractVersion: "checkout-context/v1",
    tabId,
    checkoutLineageId: String(update.checkoutLineageId || checkoutLineageId()),
    source: String(update.source || "browser_selection"),
    selectedBookingContract: update.selectedBookingContract || null,
    createdAt: String(update.createdAt || now),
    updatedAt: now
  };
  await chrome.storage.local.set({ [checkoutContextKey(tabId)]: context });
  return context;
}

async function ensureCheckoutContext(tabId, { rotate = false, source = "browser_selection" } = {}) {
  const existing = await readCheckoutContext(tabId);
  if (existing && !rotate) return existing;
  if (rotate) await chrome.storage.local.remove(selectedBookingAcquisitionKey(tabId));
  return writeCheckoutContext(tabId, { source });
}

async function installSelectedBookingLaunch(tabId, rawContract = null) {
  const selectedBookingContract = validSelectedBookingContract(rawContract);
  if (!Number.isInteger(tabId)) return { ok: false, code: "CHECKOUT_TAB_REQUIRED" };
  if (!selectedBookingContract) return { ok: false, code: "INVALID_SELECTED_BOOKING" };
  await chrome.storage.local.remove(selectedBookingAcquisitionKey(tabId));
  const context = await writeCheckoutContext(tabId, {
    source: "app_launch",
    selectedBookingContract
  });
  return { ok: true, context };
}

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.remove([
    checkoutContextKey(tabId),
    selectedBookingAcquisitionKey(tabId)
  ]).catch(() => undefined);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "ATW_TAB_CONTEXT") {
    sendResponse({
      ok: Number.isInteger(sender.tab?.id),
      tabId: Number.isInteger(sender.tab?.id) ? sender.tab.id : null,
      windowId: Number.isInteger(sender.tab?.windowId) ? sender.tab.windowId : null
    });
    return false;
  }

  if (message?.type === "ATW_CHECKOUT_CONTEXT") {
    const tabId = sender.tab?.id;
    if (!Number.isInteger(tabId)) {
      sendResponse({ ok: false, code: "CHECKOUT_TAB_REQUIRED" });
      return false;
    }
    readCheckoutContext(tabId)
      .then((context) => sendResponse({ ok: true, context }))
      .catch((error) => sendResponse({ ok: false, code: "CHECKOUT_CONTEXT_UNAVAILABLE", error: error.message }));
    return true;
  }

  if (message?.type === "ATW_CHECKOUT_LINEAGE_BEGIN") {
    const tabId = sender.tab?.id;
    if (!Number.isInteger(tabId)) {
      sendResponse({ ok: false, code: "CHECKOUT_TAB_REQUIRED" });
      return false;
    }
    ensureCheckoutContext(tabId, {
      rotate: message.rotate === true,
      source: "browser_selection"
    })
      .then((context) => sendResponse({ ok: true, context }))
      .catch((error) => sendResponse({ ok: false, code: "CHECKOUT_CONTEXT_UNAVAILABLE", error: error.message }));
    return true;
  }

  if (message?.type === "ATW_SELECTED_BOOKING_LAUNCH") {
    const extensionOwnedMessage = sender.id === chrome.runtime.id;
    const tabId = Number.isInteger(sender.tab?.id)
      ? sender.tab.id
      : (extensionOwnedMessage && Number.isInteger(message.tabId) ? message.tabId : null);
    installSelectedBookingLaunch(tabId, message.selectedBookingContract)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, code: "SELECTED_BOOKING_LAUNCH_FAILED", error: error.message }));
    return true;
  }

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
