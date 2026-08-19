const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

const root = path.resolve(__dirname, "../..");

function serviceWorkerHarness(tabUrl = "https://checkout.unfamiliar-air.test/passengers") {
  const storage = {};
  const calls = { insertedCss: [], executedScripts: [], tabMessages: [] };
  let messageListener = null;
  let tabUpdatedListener = null;
  let currentTabUrl = tabUrl;
  const chrome = {
    runtime: {
      id: "extension-test",
      lastError: null,
      onInstalled: { addListener() {} },
      onMessage: { addListener(listener) { messageListener = listener; } }
    },
    storage: {
      local: {
        async get(keys) {
          const requested = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(requested
            .filter((key) => Object.prototype.hasOwnProperty.call(storage, key))
            .map((key) => [key, storage[key]]));
        },
        async set(values) { Object.assign(storage, values || {}); },
        async remove(keys) {
          for (const key of (Array.isArray(keys) ? keys : [keys])) delete storage[key];
        }
      }
    },
    tabs: {
      async get(tabId) { return { id: tabId, url: currentTabUrl, windowId: 1 }; },
      async sendMessage(tabId, message) {
        calls.tabMessages.push({ tabId, message });
        return { ok: true, status: "started" };
      },
      onUpdated: { addListener(listener) { tabUpdatedListener = listener; } },
      onRemoved: { addListener() {} },
      captureVisibleTab(_windowId, _options, callback) { callback(""); }
    },
    scripting: {
      async insertCSS(details) { calls.insertedCss.push(details); },
      async executeScript(details) { calls.executedScripts.push(details); }
    },
    debugger: {
      attach(_target, _version, callback) { callback(); },
      detach(_target, callback) { callback(); },
      sendCommand(_target, _method, _params, callback) { callback({}); }
    }
  };
  const source = fs.readFileSync(
    path.join(root, "apps/extension/src/background/service-worker.js"),
    "utf8"
  );
  vm.runInNewContext(source, {
    chrome,
    crypto: webcrypto,
    URL,
    Date,
    Promise,
    Number,
    String,
    Array,
    Object,
    RegExp,
    Error,
    setTimeout,
    clearTimeout
  });
  assert.equal(typeof messageListener, "function");
  assert.equal(typeof tabUpdatedListener, "function");

  async function send(message, sender = { id: chrome.runtime.id }) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) reject(new Error(`No response for ${message.type}`));
      }, 1_000);
      const sendResponse = (response) => {
        settled = true;
        clearTimeout(timer);
        resolve(response);
      };
      try {
        messageListener(message, sender, sendResponse);
      } catch (error) {
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  async function completeNavigation(tabId, url) {
    currentTabUrl = url;
    tabUpdatedListener(tabId, { status: "complete", url }, { id: tabId, url, windowId: 1 });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (calls.executedScripts.length > 1) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  return { calls, completeNavigation, send, storage };
}

function selectedBooking(travelerId = "trav_unfamiliar") {
  return {
    contractVersion: "selected-booking/v1",
    selectionId: "selection_unfamiliar_1",
    selectedAt: new Date().toISOString(),
    sourceUrl: "fly://selection/selection_unfamiliar_1",
    itinerary: {
      segments: [{ origin: "LJU", destination: "FRA", departureDate: "2026-10-15" }]
    },
    approvedTotal: { amount: 280, currency: "EUR" },
    travelerIds: [travelerId]
  };
}

test("explicit launch injects Fly on an unlisted http checkout", async () => {
  const harness = serviceWorkerHarness();
  const result = await harness.send({ type: "ATW_START_CHECKOUT", tabId: 73, autoStart: true });

  assert.equal(result.ok, true);
  assert.equal(result.startStatus, "started");
  assert.deepEqual(JSON.parse(JSON.stringify(harness.calls.insertedCss)), [{
    target: { tabId: 73 },
    files: ["src/content/sidebar.css"]
  }]);
  assert.deepEqual(JSON.parse(JSON.stringify(harness.calls.executedScripts)), [{
    target: { tabId: 73 },
    files: ["dist/content.js"]
  }]);
  assert.deepEqual(JSON.parse(JSON.stringify(harness.calls.tabMessages)), [{
    tabId: 73,
    message: { type: "ATW_START_AGENT" }
  }]);
  assert.equal(harness.storage["atwCheckoutContextV1:73"].source, "explicit_agent_start");

  const diagnostics = await harness.send(
    { type: "ATW_STARTUP_DIAGNOSTICS" },
    { id: "extension-test", tab: { id: 73 } }
  );
  assert.equal(diagnostics.ok, true);
  assert.deepEqual(Array.from(diagnostics.events, (event) => String(event.code)), [
    "CHECKOUT_CONTEXT_READY",
    "RUNTIME_INJECTION_STARTED",
    "RUNTIME_INJECTED",
    "AGENT_START_REQUESTED"
  ]);
});

test("app-supplied SelectedBooking starts an itinerary-free unfamiliar passenger page", async () => {
  const harness = serviceWorkerHarness("https://passengers.new-provider.test/details");
  const booking = selectedBooking();
  const result = await harness.send({
    type: "ATW_START_CHECKOUT",
    tabId: 74,
    autoStart: true,
    selectedBookingContract: booking
  });

  assert.equal(result.ok, true);
  assert.equal(result.context.source, "app_launch");
  assert.equal(result.context.selectedBookingContract.selectionId, booking.selectionId);
  assert.equal(harness.storage["atwCheckoutContextV1:74"].selectedBookingContract.approvedTotal.amount, 280);
  assert.equal(harness.storage["atwSelectedBookingAcquisitionV1:74"], undefined);

  await harness.completeNavigation(74, "https://payments.redirected-provider.test/review");
  assert.equal(harness.calls.executedScripts.length, 2);
  const diagnostics = await harness.send(
    { type: "ATW_STARTUP_DIAGNOSTICS" },
    { id: "extension-test", tab: { id: 74 } }
  );
  assert.ok(diagnostics.events.some((event) => event.code === "RUNTIME_REINJECTED"));
});

test("explicit launch refuses browser-internal pages without injecting", async () => {
  const harness = serviceWorkerHarness("chrome://extensions/");
  const result = await harness.send({ type: "ATW_START_CHECKOUT", tabId: 75 });

  assert.equal(result.ok, false);
  assert.equal(result.code, "UNSUPPORTED_CHECKOUT_TAB");
  assert.equal(harness.calls.executedScripts.length, 0);
});

test("manifest and popup expose the explicit universal launch path", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "apps/extension/manifest.json"), "utf8"));
  const popup = fs.readFileSync(path.join(root, "apps/extension/src/popup/popup.js"), "utf8");
  const sessionClient = fs.readFileSync(path.join(root, "apps/extension/src/content/controller/session-client.js"), "utf8");
  const flow = fs.readFileSync(path.join(root, "apps/extension/src/content/diagnostics/flow.js"), "utf8");

  assert.ok(manifest.permissions.includes("scripting"));
  assert.ok(manifest.host_permissions.includes("<all_urls>"));
  assert.match(popup, /ATW_START_CHECKOUT/);
  assert.match(sessionClient, /STARTUP_CONTEXT/);
  assert.match(flow, /entry\.payload\?\.startAttemptId/);
});
