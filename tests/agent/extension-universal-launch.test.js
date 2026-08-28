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
  let tabCreatedListener = null;
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
      onCreated: { addListener(listener) { tabCreatedListener = listener; } },
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
  assert.equal(typeof tabCreatedListener, "function");
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

  async function createTab(tab) {
    tabCreatedListener(tab);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (storage[`${CHECKOUT_CONTEXT_PREFIX_FOR_TEST}:${tab.id}`]) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  const CHECKOUT_CONTEXT_PREFIX_FOR_TEST = "atwCheckoutContextV1";
  return { calls, completeNavigation, createTab, send, storage };
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

test("a sidebar-started checkout popup inherits the opener's durable session before content boot", async () => {
  const harness = serviceWorkerHarness("https://checkout.unfamiliar-air.test/review");
  const sender = { id: "extension-test", tab: { id: 73 } };
  const lineage = await harness.send({ type: "ATW_CHECKOUT_LINEAGE_BEGIN" }, sender);
  assert.equal(lineage.context.source, "browser_selection");
  await harness.send({
    type: "ATW_CHECKOUT_RESUME_SAVE",
    marker: { travelerId: "trav_unfamiliar", sessionId: "chk_durable_popup" }
  }, sender);

  await harness.createTab({ id: 74, openerTabId: 73, url: "about:blank" });

  assert.equal(harness.storage["atwCheckoutContextV1:74"].checkoutLineageId,
    harness.storage["atwCheckoutContextV1:73"].checkoutLineageId);
  assert.equal(harness.storage.atwAgentResume.sessionId, "chk_durable_popup");
  assert.equal(harness.storage.atwAgentResume.tabContextId, "74");
  assert.equal(harness.storage.atwAgentResume.handoffFromTabContextId, "73");
  assert.equal(
    harness.storage.atwAgentResumeByLineageV1[lineage.context.checkoutLineageId].tabContextId,
    "74"
  );
});

test("a sidebar-started active checkout follows a same-tab redirect to an unfamiliar payment provider", async () => {
  const harness = serviceWorkerHarness("https://booking.supported-air.test/payment");
  const sender = { id: "extension-test", tab: { id: 73 } };
  const lineage = await harness.send({ type: "ATW_CHECKOUT_LINEAGE_BEGIN" }, sender);
  assert.equal(lineage.context.source, "browser_selection");
  await harness.send({
    type: "ATW_CHECKOUT_RESUME_SAVE",
    marker: { travelerId: "trav_unfamiliar", sessionId: "chk_sidebar_redirect" }
  }, sender);

  await harness.completeNavigation(73, "https://payments.unfamiliar-provider.test/card-entry");

  assert.deepEqual(JSON.parse(JSON.stringify(harness.calls.insertedCss)), [{
    target: { tabId: 73 },
    files: ["src/content/sidebar.css"]
  }]);
  assert.deepEqual(JSON.parse(JSON.stringify(harness.calls.executedScripts)), [{
    target: { tabId: 73 },
    files: ["dist/content.js"]
  }]);
  const diagnostics = await harness.send(
    { type: "ATW_STARTUP_DIAGNOSTICS" },
    sender
  );
  assert.ok(diagnostics.events.some((event) => event.code === "RUNTIME_REINJECTED"));
});

test("a browser-selection context without an active session does not follow unrelated navigation", async () => {
  const harness = serviceWorkerHarness("https://booking.supported-air.test/search");
  const sender = { id: "extension-test", tab: { id: 73 } };
  const lineage = await harness.send({ type: "ATW_CHECKOUT_LINEAGE_BEGIN" }, sender);
  assert.equal(lineage.context.source, "browser_selection");

  await harness.completeNavigation(73, "https://unrelated.example.test/home");

  assert.equal(harness.calls.insertedCss.length, 0);
  assert.equal(harness.calls.executedScripts.length, 0);
});

test("a real browser selection becomes the tab-scoped Start authority", async () => {
  const harness = serviceWorkerHarness("https://search.unfamiliar-air.test/results");
  const sender = { id: "extension-test", tab: { id: 73 } };
  const booking = selectedBooking("trav_unfamiliar");

  const candidate = await harness.send({
    type: "ATW_BOOKING_SELECTION_CANDIDATE",
    phase: "selection_click",
    missingFacts: ["approved_total", "currency"]
  }, sender);
  assert.equal(candidate.ok, true);
  assert.deepEqual(
    Array.from(harness.storage["atwCheckoutContextV1:73"].selectionCandidate.missingFacts),
    ["approved_total", "currency"]
  );

  const captured = await harness.send({
    type: "ATW_BOOKING_SELECTION_CAPTURED",
    phase: "selection_click",
    selectedBookingContract: booking
  }, sender);

  assert.equal(captured.ok, true);
  assert.equal(captured.context.source, "browser_selection");
  assert.equal(captured.context.selectionCandidate, null);
  assert.equal(captured.context.selectedBookingContract.selectionId, booking.selectionId);
  assert.equal(harness.storage["atwCheckoutContextV1:73"].selectedBookingContract.approvedTotal.amount, 280);

  const read = await harness.send({ type: "ATW_CHECKOUT_CONTEXT_READ", tabId: 73 });
  assert.equal(read.ok, true);
  assert.equal(read.context.selectedBookingContract.selectionId, booking.selectionId);

  const started = await harness.send({ type: "ATW_START_CHECKOUT", tabId: 73, autoStart: true });
  assert.equal(started.ok, true);
  assert.equal(started.context.checkoutLineageId, captured.context.checkoutLineageId);
  assert.equal(started.context.selectedBookingContract.selectionId, booking.selectionId);
});

test("the background rejects a captured route that conflicts with structured source evidence", async () => {
  const harness = serviceWorkerHarness("https://search.unfamiliar-air.test/results");
  const sender = { id: "extension-test", tab: { id: 73 } };
  const booking = selectedBooking("trav_unfamiliar");
  booking.sourceUrl = "https://search.unfamiliar-air.test/results?origin=ZAG&destination=SJJ&secret=private";
  booking.itinerary.segments[0] = {
    ...booking.itinerary.segments[0],
    origin: "ADD",
    destination: "ONS"
  };

  const captured = await harness.send({
    type: "ATW_BOOKING_SELECTION_CAPTURED",
    phase: "selection_click",
    selectedBookingContract: booking
  }, sender);

  assert.equal(captured.ok, false);
  assert.equal(captured.code, "INVALID_SELECTED_BOOKING");
  assert.equal(harness.storage["atwCheckoutContextV1:73"], undefined);
  assert.equal(harness.storage.selectedBookingContract, undefined);
});

test("the background persists route provenance without URL query data", async () => {
  const harness = serviceWorkerHarness("https://search.unfamiliar-air.test/results");
  const sender = { id: "extension-test", tab: { id: 73 } };
  const booking = selectedBooking("trav_unfamiliar");
  booking.sourceUrl = "https://search.unfamiliar-air.test/results?origin=LJU&destination=FRA&secret=private";

  const captured = await harness.send({
    type: "ATW_BOOKING_SELECTION_CAPTURED",
    phase: "selection_click",
    selectedBookingContract: booking
  }, sender);

  assert.equal(captured.ok, true);
  assert.equal(captured.context.selectedBookingContract.sourceUrl, "https://search.unfamiliar-air.test/results");
  assert.deepEqual(
    JSON.parse(JSON.stringify(captured.context.selectedBookingContract.sourceRouteEvidence)),
    { origin: "LJU", destination: "FRA" }
  );
});

test("a booking selection captured before traveler choice binds that traveler exactly at Start", async () => {
  const harness = serviceWorkerHarness("https://search.unfamiliar-air.test/results");
  const sender = { id: "extension-test", tab: { id: 73 } };
  const booking = selectedBooking("trav_bound_at_start");
  const candidate = {
    contractVersion: "selected-booking-candidate/v1",
    selectionId: booking.selectionId,
    selectedAt: booking.selectedAt,
    sourceUrl: booking.sourceUrl,
    itinerary: booking.itinerary,
    approvedTotal: booking.approvedTotal,
    fareBrand: ""
  };

  const captured = await harness.send({
    type: "ATW_BOOKING_SELECTION_CANDIDATE",
    phase: "selection_click",
    missingFacts: ["selected_traveler"],
    selectedBookingCandidate: candidate
  }, sender);
  assert.equal(captured.ok, true);
  assert.equal(
    harness.storage["atwCheckoutContextV1:73"].selectionCandidate.selectedBookingCandidate.selectionId,
    booking.selectionId
  );

  const started = await harness.send({
    type: "ATW_START_CHECKOUT",
    tabId: 73,
    autoStart: true,
    selectedTravelerId: "trav_bound_at_start"
  });

  assert.equal(started.ok, true);
  assert.equal(started.context.selectionCandidate, null);
  assert.deepEqual(
    Array.from(started.context.selectedBookingContract.travelerIds),
    ["trav_bound_at_start"]
  );
  assert.equal(started.context.selectedBookingContract.selectionId, booking.selectionId);
});

test("content runtimes receive one background-instance epoch for reload ownership", async () => {
  const harness = serviceWorkerHarness();
  const first = await harness.send({ type: "ATW_EXTENSION_RUNTIME_PROBE" });
  const second = await harness.send({ type: "ATW_EXTENSION_RUNTIME_PROBE" });

  assert.equal(first.ok, true);
  assert.match(first.epoch, /^runtime_/);
  assert.equal(second.epoch, first.epoch);
});

test("a captured booking follows a pre-session new-tab checkout handoff", async () => {
  const harness = serviceWorkerHarness("https://search.unfamiliar-air.test/results");
  const sender = { id: "extension-test", tab: { id: 73 } };
  const booking = selectedBooking("trav_unfamiliar");
  const captured = await harness.send({
    type: "ATW_BOOKING_SELECTION_CAPTURED",
    phase: "selection_click",
    selectedBookingContract: booking
  }, sender);

  await harness.createTab({ id: 74, openerTabId: 73, url: "about:blank" });

  const inherited = harness.storage["atwCheckoutContextV1:74"];
  assert.equal(inherited.checkoutLineageId, captured.context.checkoutLineageId);
  assert.equal(inherited.selectedBookingContract.selectionId, booking.selectionId);
  assert.equal(inherited.selectedBookingContract.approvedTotal.currency, "EUR");
  assert.equal(harness.storage.atwAgentResume, undefined);
});

test("resume save claim and clear are isolated by checkout lineage rather than a global tab marker", async () => {
  const harness = serviceWorkerHarness();
  const first = await harness.send({ type: "ATW_START_CHECKOUT", tabId: 73, autoStart: true });
  const second = await harness.send({ type: "ATW_START_CHECKOUT", tabId: 74, autoStart: true });
  const sender = (tabId) => ({ id: "extension-test", tab: { id: tabId } });

  await harness.send({
    type: "ATW_CHECKOUT_RESUME_SAVE",
    marker: { sessionId: "chk_first", travelerId: "trav_first" }
  }, sender(73));
  await harness.send({
    type: "ATW_CHECKOUT_RESUME_SAVE",
    marker: { sessionId: "chk_second", travelerId: "trav_second" }
  }, sender(74));

  const claimedFirst = await harness.send({ type: "ATW_CHECKOUT_RESUME_CLAIM" }, sender(73));
  assert.equal(claimedFirst.marker.sessionId, "chk_first");
  assert.equal(claimedFirst.marker.checkoutLineageId, first.context.checkoutLineageId);

  const clearedFirst = await harness.send({
    type: "ATW_CHECKOUT_RESUME_CLEAR",
    expected: { sessionId: "chk_first" }
  }, sender(73));
  assert.equal(clearedFirst.cleared, true);
  assert.equal(harness.storage.atwAgentResumeByLineageV1[first.context.checkoutLineageId], undefined);
  assert.equal(harness.storage.atwAgentResumeByLineageV1[second.context.checkoutLineageId].sessionId, "chk_second");

  const claimedSecond = await harness.send({ type: "ATW_CHECKOUT_RESUME_CLAIM" }, sender(74));
  assert.equal(claimedSecond.marker.sessionId, "chk_second");
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
  assert.doesNotMatch(popup, /settings\.selectedBookingContract/);
  assert.match(sessionClient, /STARTUP_CONTEXT/);
  assert.match(flow, /entry\.payload\?\.startAttemptId/);
});
