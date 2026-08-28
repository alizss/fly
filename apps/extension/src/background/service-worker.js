const EXTENSION_RUNTIME_EPOCH = `runtime_${Date.now().toString(36)}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(["apiBase"]);
  if (!existing.apiBase) {
    await chrome.storage.local.set({ apiBase: "http://localhost:4173/api" });
  }
  await installPrecheckoutProducerOnOpenTabs();
});

chrome.runtime.onStartup?.addListener?.(() => {
  installPrecheckoutProducerOnOpenTabs().catch(() => undefined);
});

const CHECKOUT_CONTEXT_PREFIX = "atwCheckoutContextV1";
const STARTUP_DIAGNOSTICS_PREFIX = "atwStartupDiagnosticsV1";
const RESUME_SESSIONS_KEY = "atwAgentResumeByLineageV1";
const LEGACY_RESUME_KEY = "atwAgentResume";
const RESUME_MAX_AGE_MS = 3 * 60 * 1000;
const SELECTED_BOOKING_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const STARTUP_DIAGNOSTIC_LIMIT = 40;

function checkoutContextKey(tabId) {
  return `${CHECKOUT_CONTEXT_PREFIX}:${tabId}`;
}

function startupDiagnosticsKey(tabId) {
  return `${STARTUP_DIAGNOSTICS_PREFIX}:${tabId}`;
}

async function appendStartupDiagnostic(tabId, code, details = {}) {
  if (!Number.isInteger(tabId)) return null;
  const key = startupDiagnosticsKey(tabId);
  const stored = await chrome.storage.local.get(key);
  const previous = Array.isArray(stored?.[key]) ? stored[key] : [];
  const event = {
    at: new Date().toISOString(),
    code: String(code || "STARTUP_EVENT"),
    details: details && typeof details === "object" ? details : {}
  };
  await chrome.storage.local.set({ [key]: [...previous, event].slice(-STARTUP_DIAGNOSTIC_LIMIT) });
  return event;
}

async function readStartupDiagnostics(tabId) {
  if (!Number.isInteger(tabId)) return [];
  const key = startupDiagnosticsKey(tabId);
  const stored = await chrome.storage.local.get(key);
  return Array.isArray(stored?.[key]) ? stored[key] : [];
}

function injectableCheckoutUrl(url = "") {
  return /^https?:\/\//i.test(String(url || ""));
}

function publicSelectionSourceUrl(value = "") {
  try {
    const url = new URL(String(value || ""));
    const authority = url.origin !== "null"
      ? url.origin
      : `${url.protocol}//${url.host}`;
    return `${authority}${url.pathname}${url.hash || ""}`;
  } catch (_error) {
    return "";
  }
}

function routeIdentityFromSourceUrl(value = "") {
  try {
    const url = new URL(String(value || ""));
    const entries = [...url.searchParams.entries()].map(([key, item]) => [
      key.toLowerCase().replace(/[^a-z0-9]+/g, "_"),
      String(item || "").trim().toUpperCase()
    ]);
    const find = (patterns) => entries.find(([key, item]) => (
      patterns.some((pattern) => pattern.test(key)) && /^[A-Z]{3}$/.test(item)
    ))?.[1] || "";
    const origin = find([/^(?:origin|from|departure_airport|departure_location|b_location_1)$/]);
    const destination = find([/^(?:destination|to|arrival_airport|arrival_location|e_location_1)$/]);
    return origin && destination && origin !== destination ? { origin, destination } : null;
  } catch (_error) {
    return null;
  }
}

async function installPrecheckoutProducerOnOpenTabs() {
  const tabs = await chrome.tabs.query({});
  await Promise.allSettled(tabs
    .filter((tab) => Number.isInteger(tab?.id) && injectableCheckoutUrl(tab?.url))
    .map((tab) => chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["src/content/precheckout-capture.js"]
    })));
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
  const sourceRoute = routeIdentityFromSourceUrl(raw.sourceUrl) || (
    /^[A-Z]{3}$/.test(String(raw.sourceRouteEvidence?.origin || "").toUpperCase())
    && /^[A-Z]{3}$/.test(String(raw.sourceRouteEvidence?.destination || "").toUpperCase())
      ? {
          origin: String(raw.sourceRouteEvidence.origin).toUpperCase(),
          destination: String(raw.sourceRouteEvidence.destination).toUpperCase()
        }
      : null
  );
  const firstSegment = segments[0] || {};
  const sourceConflict = sourceRoute && (
    String(firstSegment.origin || "").trim().toUpperCase() !== sourceRoute.origin
    || String(firstSegment.destination || "").trim().toUpperCase() !== sourceRoute.destination
  );
  if (
    !String(raw.selectionId || "").trim()
    || !fresh
    || !completeItinerary
    || !Number.isFinite(amount)
    || amount < 0
    || !currency
    || travelerIds.length === 0
    || sourceConflict
  ) return null;
  return {
    ...raw,
    sourceUrl: publicSelectionSourceUrl(raw.sourceUrl),
    sourceRouteEvidence: sourceRoute,
    approvedTotal: { amount, currency },
    travelerIds
  };
}

function validSelectionCandidate(raw = null, now = Date.now()) {
  if (!raw || raw.contractVersion !== "selected-booking-candidate/v1") return null;
  const selectedAt = Date.parse(String(raw.selectedAt || ""));
  const segments = Array.isArray(raw.itinerary?.segments) ? raw.itinerary.segments : [];
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
  const sourceRoute = routeIdentityFromSourceUrl(raw.sourceUrl) || (
    /^[A-Z]{3}$/.test(String(raw.sourceRouteEvidence?.origin || "").toUpperCase())
    && /^[A-Z]{3}$/.test(String(raw.sourceRouteEvidence?.destination || "").toUpperCase())
      ? {
          origin: String(raw.sourceRouteEvidence.origin).toUpperCase(),
          destination: String(raw.sourceRouteEvidence.destination).toUpperCase()
        }
      : null
  );
  const firstSegment = segments[0] || {};
  const sourceConflict = sourceRoute && (
    String(firstSegment.origin || "").trim().toUpperCase() !== sourceRoute.origin
    || String(firstSegment.destination || "").trim().toUpperCase() !== sourceRoute.destination
  );
  if (
    !String(raw.selectionId || "").trim()
    || !fresh
    || !completeItinerary
    || !Number.isFinite(amount)
    || amount < 0
    || !currency
    || sourceConflict
  ) return null;
  return {
    ...raw,
    sourceUrl: publicSelectionSourceUrl(raw.sourceUrl),
    sourceRouteEvidence: sourceRoute,
    approvedTotal: { amount, currency }
  };
}

async function readCheckoutContext(tabId) {
  if (!Number.isInteger(tabId)) return null;
  const key = checkoutContextKey(tabId);
  const stored = await chrome.storage.local.get(key);
  const context = stored?.[key] || null;
  return context?.contractVersion === "checkout-context/v1" ? context : null;
}

async function finalizeSelectionCandidateForTraveler(tabId, travelerId = "") {
  let context = await readCheckoutContext(tabId);
  if (!context) return context;
  const currentContract = validSelectedBookingContract(context.selectedBookingContract);
  if (currentContract) {
    if (currentContract.sourceUrl !== context.selectedBookingContract?.sourceUrl) {
      context = await writeCheckoutContext(tabId, { ...context, selectedBookingContract: currentContract });
    }
    return context;
  }
  if (context.selectedBookingContract) {
    context = await writeCheckoutContext(tabId, {
      ...context,
      selectedBookingContract: null
    });
    await chrome.storage.local.remove("selectedBookingContract");
    await appendStartupDiagnostic(tabId, "CAPTURED_BOOKING_REJECTED", {
      reason: "STRUCTURAL_BOOKING_CONFLICT"
    });
  }
  const candidate = validSelectionCandidate(context.selectionCandidate?.selectedBookingCandidate);
  const normalizedTravelerId = String(travelerId || "").trim();
  if (!candidate || !normalizedTravelerId) return context;
  const selectedBookingContract = {
    contractVersion: "selected-booking/v1",
    selectionId: candidate.selectionId,
    selectedAt: candidate.selectedAt,
    sourceUrl: candidate.sourceUrl,
    sourceRouteEvidence: candidate.sourceRouteEvidence || null,
    itinerary: candidate.itinerary,
    approvedTotal: candidate.approvedTotal,
    fareBrand: String(candidate.fareBrand || ""),
    travelerIds: [normalizedTravelerId]
  };
  const finalized = await writeCheckoutContext(tabId, {
    ...context,
    selectedBookingContract,
    selectionCandidate: null
  });
  await appendStartupDiagnostic(tabId, "BOOKING_SELECTION_BOUND_TO_TRAVELER", {
    selectionId: selectedBookingContract.selectionId,
    checkoutLineageId: finalized.checkoutLineageId,
    travelerId: normalizedTravelerId
  });
  return finalized;
}

function freshResumeMarker(marker = null) {
  return Boolean(
    marker
    && String(marker.sessionId || "")
    && Number(marker.savedAt || 0) > Date.now() - RESUME_MAX_AGE_MS
  );
}

async function readResumeSessions() {
  const stored = await chrome.storage.local.get([RESUME_SESSIONS_KEY, LEGACY_RESUME_KEY]);
  return {
    sessions: stored?.[RESUME_SESSIONS_KEY] && typeof stored[RESUME_SESSIONS_KEY] === "object"
      ? stored[RESUME_SESSIONS_KEY]
      : {},
    legacy: stored?.[LEGACY_RESUME_KEY] || null
  };
}

async function saveCheckoutResume(tabId, update = {}) {
  const context = await readCheckoutContext(tabId);
  const lineageId = String(context?.checkoutLineageId || update.checkoutLineageId || "");
  const sessionId = String(update.sessionId || "");
  if (!lineageId || !sessionId) return { ok: false, code: "CHECKOUT_LINEAGE_SESSION_REQUIRED" };
  const { sessions } = await readResumeSessions();
  const marker = {
    ...update,
    checkoutLineageId: lineageId,
    tabContextId: String(tabId),
    sessionId,
    savedAt: Date.now()
  };
  await chrome.storage.local.set({
    [RESUME_SESSIONS_KEY]: { ...sessions, [lineageId]: marker },
    // Compatibility pointer for an already-injected older content runtime.
    [LEGACY_RESUME_KEY]: marker
  });
  return { ok: true, marker };
}

async function claimCheckoutResume(tabId) {
  const context = await readCheckoutContext(tabId);
  const lineageId = String(context?.checkoutLineageId || "");
  if (!lineageId) return { ok: true, marker: null };
  const { sessions, legacy } = await readResumeSessions();
  const lineageMarker = sessions[lineageId] || null;
  const compatibleLegacy = legacy && (
    String(legacy.checkoutLineageId || "") === lineageId
    || (!legacy.checkoutLineageId && String(legacy.tabContextId || "") === String(tabId))
  ) ? legacy : null;
  const marker = freshResumeMarker(lineageMarker) ? lineageMarker : compatibleLegacy;
  if (!freshResumeMarker(marker)) return { ok: true, marker: null };
  const claimed = {
    ...marker,
    checkoutLineageId: lineageId,
    tabContextId: String(tabId),
    claimedAt: Date.now(),
    savedAt: Date.now()
  };
  await chrome.storage.local.set({
    [RESUME_SESSIONS_KEY]: { ...sessions, [lineageId]: claimed },
    [LEGACY_RESUME_KEY]: claimed
  });
  return { ok: true, marker: claimed };
}

async function clearCheckoutResume(tabId, expected = {}) {
  const context = await readCheckoutContext(tabId);
  const lineageId = String(context?.checkoutLineageId || expected.checkoutLineageId || "");
  if (!lineageId) return { ok: true, cleared: false };
  const { sessions, legacy } = await readResumeSessions();
  const marker = sessions[lineageId] || null;
  const expectedSessionId = String(expected.sessionId || "");
  const ownsMarker = marker && (
    (!expectedSessionId && String(marker.tabContextId || "") === String(tabId))
    || (expectedSessionId && String(marker.sessionId || "") === expectedSessionId)
  );
  if (!ownsMarker) return { ok: true, cleared: false };
  const nextSessions = { ...sessions };
  delete nextSessions[lineageId];
  await chrome.storage.local.set({ [RESUME_SESSIONS_KEY]: nextSessions });
  if (legacy && String(legacy.checkoutLineageId || "") === lineageId) {
    await chrome.storage.local.remove(LEGACY_RESUME_KEY);
  }
  return { ok: true, cleared: true };
}

async function writeCheckoutContext(tabId, update = {}) {
  const now = new Date().toISOString();
  const context = {
    contractVersion: "checkout-context/v1",
    tabId,
    checkoutLineageId: String(update.checkoutLineageId || checkoutLineageId()),
    source: String(update.source || "browser_selection"),
    selectedBookingContract: update.selectedBookingContract || null,
    selectionCandidate: update.selectionCandidate || null,
    createdAt: String(update.createdAt || now),
    updatedAt: now
  };
  await chrome.storage.local.set({ [checkoutContextKey(tabId)]: context });
  return context;
}

async function ensureCheckoutContext(tabId, { rotate = false, source = "browser_selection" } = {}) {
  const existing = await readCheckoutContext(tabId);
  if (existing && !rotate) return existing;
  return writeCheckoutContext(tabId, { source });
}

async function installSelectedBookingLaunch(tabId, rawContract = null, {
  source = "app_launch",
  preserveLineage = false
} = {}) {
  const selectedBookingContract = validSelectedBookingContract(rawContract);
  if (!Number.isInteger(tabId)) return { ok: false, code: "CHECKOUT_TAB_REQUIRED" };
  if (!selectedBookingContract) return { ok: false, code: "INVALID_SELECTED_BOOKING" };
  const existing = preserveLineage ? await readCheckoutContext(tabId) : null;
  const context = await writeCheckoutContext(tabId, {
    source,
    selectedBookingContract,
    checkoutLineageId: existing?.checkoutLineageId,
    createdAt: existing?.createdAt
  });
  return { ok: true, context };
}

async function captureSelectedBooking(tabId, rawContract = null, { phase = "selection" } = {}) {
  const installed = await installSelectedBookingLaunch(tabId, rawContract, {
    source: "browser_selection",
    preserveLineage: true
  });
  await appendStartupDiagnostic(tabId, installed.ok ? "BOOKING_SELECTION_PERSISTED" : "BOOKING_SELECTION_REJECTED", {
    phase: String(phase || "selection"),
    code: installed.code || "",
    selectionId: installed.context?.selectedBookingContract?.selectionId || "",
    checkoutLineageId: installed.context?.checkoutLineageId || ""
  });
  return installed;
}

async function injectCheckoutRuntime(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!injectableCheckoutUrl(tab?.url)) {
    await appendStartupDiagnostic(tabId, "RUNTIME_INJECTION_REJECTED", {
      reason: "UNSUPPORTED_TAB_URL"
    });
    return { ok: false, code: "UNSUPPORTED_CHECKOUT_TAB", error: "Fly can run only on an http(s) checkout tab." };
  }
  let origin = "";
  try {
    origin = new URL(tab.url).origin;
  } catch (_error) {
    origin = "";
  }
  await appendStartupDiagnostic(tabId, "RUNTIME_INJECTION_STARTED", { origin });
  await chrome.scripting.insertCSS({
    target: { tabId },
    files: ["src/content/sidebar.css"]
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["dist/content.js"]
  });
  await appendStartupDiagnostic(tabId, "RUNTIME_INJECTED");
  return { ok: true };
}

async function startCheckoutOnTab(tabId, {
  selectedBookingContract = null,
  selectedTravelerId = "",
  autoStart = true
} = {}) {
  if (!Number.isInteger(tabId)) return { ok: false, code: "CHECKOUT_TAB_REQUIRED" };
  const existingContext = await finalizeSelectionCandidateForTraveler(tabId, selectedTravelerId);
  const existingContract = validSelectedBookingContract(existingContext?.selectedBookingContract);
  const suppliedContract = validSelectedBookingContract(selectedBookingContract);
  const sameSuppliedSelection = Boolean(
    suppliedContract
    && existingContract
    && String(suppliedContract.selectionId) === String(existingContract.selectionId)
  );
  const launch = sameSuppliedSelection || (!suppliedContract && existingContract)
    ? { ok: true, context: existingContext }
    : suppliedContract
      ? await installSelectedBookingLaunch(tabId, suppliedContract)
      : selectedBookingContract
        ? { ok: false, code: "INVALID_SELECTED_BOOKING" }
        : { ok: true, context: await ensureCheckoutContext(tabId, { source: "explicit_agent_start" }) };
  if (!launch.ok) {
    await appendStartupDiagnostic(tabId, "SELECTED_BOOKING_REJECTED", { code: launch.code || "INVALID_SELECTED_BOOKING" });
    return launch;
  }
  await appendStartupDiagnostic(tabId, validSelectedBookingContract(launch.context?.selectedBookingContract) ? "SELECTED_BOOKING_INSTALLED" : "CHECKOUT_CONTEXT_READY", {
    checkoutLineageId: launch.context?.checkoutLineageId || "",
    selectionId: launch.context?.selectedBookingContract?.selectionId || ""
  });
  try {
    const injected = await injectCheckoutRuntime(tabId);
    if (!injected.ok) return injected;
    let startStatus = "injected";
    if (autoStart) {
      try {
        const response = await chrome.tabs.sendMessage(tabId, { type: "ATW_START_AGENT" });
        startStatus = response?.status || "queued";
        const startCode = response?.ok === false ? "AGENT_START_FAILED" : "AGENT_START_REQUESTED";
        await appendStartupDiagnostic(tabId, startCode, { status: startStatus, code: response?.code || "" });
        if (response?.ok === false) {
          return {
            ok: false,
            code: response.code || "AGENT_START_FAILED",
            error: response.error || "Fly was injected, but the checkout session could not start.",
            details: response.details || null,
            context: launch.context,
            startStatus
          };
        }
      } catch (error) {
        // Injection succeeded. If browser message delivery races initial boot,
        // the sidebar remains available and the diagnostics identify the seam.
        await appendStartupDiagnostic(tabId, "AGENT_START_MESSAGE_PENDING", {
          reason: String(error?.message || "CONTENT_RUNTIME_NOT_READY")
        });
      }
    }
    return { ok: true, context: launch.context, startStatus };
  } catch (error) {
    await appendStartupDiagnostic(tabId, "RUNTIME_INJECTION_FAILED", {
      reason: String(error?.message || "RUNTIME_INJECTION_FAILED")
    });
    return { ok: false, code: "RUNTIME_INJECTION_FAILED", error: String(error?.message || "Fly runtime injection failed.") };
  }
}

async function shouldFollowActiveCheckout(tabId) {
  const context = await readCheckoutContext(tabId);
  if (!context) return false;
  if (validSelectedBookingContract(context.selectedBookingContract)) return true;
  const stored = await chrome.storage.local.get([RESUME_SESSIONS_KEY, LEGACY_RESUME_KEY]);
  const lineageId = String(context.checkoutLineageId || "");
  const lineaged = stored?.[RESUME_SESSIONS_KEY]?.[lineageId] || null;
  const legacy = stored?.[LEGACY_RESUME_KEY] || null;
  return freshResumeMarker(lineaged)
    || (String(legacy?.tabContextId || "") === String(tabId) && freshResumeMarker(legacy));
}

async function adoptCheckoutHandoff(tab = {}) {
  const tabId = Number(tab.id);
  const openerTabId = Number(tab.openerTabId);
  if (!Number.isInteger(tabId) || !Number.isInteger(openerTabId) || tabId === openerTabId) return false;
  const openerContext = await readCheckoutContext(openerTabId);
  if (!openerContext) return false;
  const stored = await chrome.storage.local.get([RESUME_SESSIONS_KEY, LEGACY_RESUME_KEY]);
  const lineageId = String(openerContext.checkoutLineageId || "");
  const lineagedResume = stored?.[RESUME_SESSIONS_KEY]?.[lineageId] || null;
  const legacyResume = stored?.[LEGACY_RESUME_KEY] || null;
  const resume = freshResumeMarker(lineagedResume) ? lineagedResume : legacyResume;
  const selectedBookingContract = validSelectedBookingContract(openerContext.selectedBookingContract);
  const hasCapturedBooking = Boolean(selectedBookingContract);
  const resumeIsFresh = freshResumeMarker(resume)
    && (
      String(resume.checkoutLineageId || "") === lineageId
      || (!resume.checkoutLineageId && String(resume.tabContextId || "") === String(openerTabId))
    );
  // A selected booking is the pre-session handoff authority. Requiring a
  // resume marker here made new-tab provider redirects lose the booking before
  // a durable session could even exist.
  if (!resumeIsFresh && !hasCapturedBooking) return false;
  const now = new Date().toISOString();
  const inheritedContext = {
    ...openerContext,
    tabId,
    updatedAt: now
  };
  const update = {
    [checkoutContextKey(tabId)]: inheritedContext
  };
  if (resumeIsFresh) {
    const inheritedResume = {
      ...resume,
      checkoutLineageId: lineageId,
      tabContextId: String(tabId),
      handoffFromTabContextId: String(openerTabId),
      savedAt: Date.now()
    };
    update[RESUME_SESSIONS_KEY] = {
      ...(stored?.[RESUME_SESSIONS_KEY] || {}),
      [lineageId]: inheritedResume
    };
    update[LEGACY_RESUME_KEY] = inheritedResume;
  }
  await chrome.storage.local.set(update);
  await appendStartupDiagnostic(tabId, "CHECKOUT_HANDOFF_ADOPTED", {
    openerTabId,
    checkoutLineageId: inheritedContext.checkoutLineageId || "",
    sessionId: String(resume?.sessionId || ""),
    selectionId: selectedBookingContract?.selectionId || ""
  });
  return true;
}

chrome.tabs.onCreated.addListener((tab) => {
  adoptCheckoutHandoff(tab).catch((error) => appendStartupDiagnostic(tab?.id, "CHECKOUT_HANDOFF_FAILED", {
    reason: String(error?.message || "CHECKOUT_HANDOFF_FAILED")
  }));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !injectableCheckoutUrl(tab?.url)) return;
  (async () => {
    if (!await shouldFollowActiveCheckout(tabId)) return;
    await appendStartupDiagnostic(tabId, "RUNTIME_REINJECTION_STARTED", {
      origin: new URL(tab.url).origin
    });
    await injectCheckoutRuntime(tabId);
    await appendStartupDiagnostic(tabId, "RUNTIME_REINJECTED");
  })().catch((error) => appendStartupDiagnostic(tabId, "RUNTIME_REINJECTION_FAILED", {
    reason: String(error?.message || "RUNTIME_REINJECTION_FAILED")
  }));
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.remove([
    checkoutContextKey(tabId),
    startupDiagnosticsKey(tabId)
  ]).catch(() => undefined);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "ATW_EXTENSION_RUNTIME_PROBE") {
    sendResponse({ ok: true, epoch: EXTENSION_RUNTIME_EPOCH });
    return false;
  }

  if (message?.type === "ATW_PRECHECKOUT_READY") {
    const tabId = sender.tab?.id;
    if (!Number.isInteger(tabId)) {
      sendResponse({ ok: false, code: "CHECKOUT_TAB_REQUIRED" });
      return false;
    }
    appendStartupDiagnostic(tabId, "PRECHECKOUT_PRODUCER_READY", {
      epoch: String(message.epoch || ""),
      origin: String(message.origin || "")
    })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, code: "PRECHECKOUT_READY_FAILED", error: error.message }));
    return true;
  }

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
    chrome.storage.local.get(["selectedTravelerId"])
      .then((stored) => finalizeSelectionCandidateForTraveler(tabId, message.selectedTravelerId || stored.selectedTravelerId))
      .then((context) => sendResponse({ ok: true, context }))
      .catch((error) => sendResponse({ ok: false, code: "CHECKOUT_CONTEXT_UNAVAILABLE", error: error.message }));
    return true;
  }

  if (message?.type === "ATW_CHECKOUT_RESUME_SAVE") {
    const tabId = sender.tab?.id;
    if (!Number.isInteger(tabId)) {
      sendResponse({ ok: false, code: "CHECKOUT_TAB_REQUIRED" });
      return false;
    }
    saveCheckoutResume(tabId, message.marker || {})
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, code: "CHECKOUT_RESUME_SAVE_FAILED", error: error.message }));
    return true;
  }

  if (message?.type === "ATW_CHECKOUT_RESUME_CLAIM") {
    const tabId = sender.tab?.id;
    if (!Number.isInteger(tabId)) {
      sendResponse({ ok: false, code: "CHECKOUT_TAB_REQUIRED", marker: null });
      return false;
    }
    claimCheckoutResume(tabId)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, code: "CHECKOUT_RESUME_CLAIM_FAILED", error: error.message, marker: null }));
    return true;
  }

  if (message?.type === "ATW_CHECKOUT_RESUME_CLEAR") {
    const tabId = sender.tab?.id;
    if (!Number.isInteger(tabId)) {
      sendResponse({ ok: false, code: "CHECKOUT_TAB_REQUIRED", cleared: false });
      return false;
    }
    clearCheckoutResume(tabId, message.expected || {})
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, code: "CHECKOUT_RESUME_CLEAR_FAILED", error: error.message, cleared: false }));
    return true;
  }

  if (message?.type === "ATW_STARTUP_DIAGNOSTICS") {
    const tabId = sender.tab?.id;
    if (!Number.isInteger(tabId)) {
      sendResponse({ ok: false, code: "CHECKOUT_TAB_REQUIRED", events: [] });
      return false;
    }
    readStartupDiagnostics(tabId)
      .then((events) => sendResponse({ ok: true, events }))
      .catch((error) => sendResponse({ ok: false, code: "STARTUP_DIAGNOSTICS_UNAVAILABLE", error: error.message, events: [] }));
    return true;
  }

  if (message?.type === "ATW_CHECKOUT_CONTEXT_READ") {
    const extensionOwnedMessage = sender.id === chrome.runtime.id;
    const tabId = Number.isInteger(sender.tab?.id)
      ? sender.tab.id
      : (extensionOwnedMessage && Number.isInteger(message.tabId) ? message.tabId : null);
    if (!Number.isInteger(tabId)) {
      sendResponse({ ok: false, code: "CHECKOUT_TAB_REQUIRED", context: null });
      return false;
    }
    chrome.storage.local.get(["selectedTravelerId"])
      .then((stored) => finalizeSelectionCandidateForTraveler(tabId, message.selectedTravelerId || stored.selectedTravelerId))
      .then((context) => sendResponse({ ok: true, context }))
      .catch((error) => sendResponse({ ok: false, code: "CHECKOUT_CONTEXT_UNAVAILABLE", error: error.message, context: null }));
    return true;
  }

  if (message?.type === "ATW_BOOKING_SELECTION_CANDIDATE") {
    const tabId = sender.tab?.id;
    if (!Number.isInteger(tabId)) {
      sendResponse({ ok: false, code: "CHECKOUT_TAB_REQUIRED" });
      return false;
    }
    const missingFacts = Array.isArray(message.missingFacts) ? message.missingFacts.slice(0, 12) : [];
    ensureCheckoutContext(tabId)
      .then((context) => writeCheckoutContext(tabId, {
        ...context,
        selectionCandidate: {
          observedAt: new Date().toISOString(),
          phase: String(message.phase || "selection"),
          missingFacts,
          selectedBookingCandidate: validSelectionCandidate(message.selectedBookingCandidate) || null,
          evidence: {
            producerEpoch: String(message.evidence?.producerEpoch || ""),
            explicitSelectionGesture: message.evidence?.explicitSelectionGesture === true,
            itineraryObserved: message.evidence?.itineraryObserved === true,
            totalObserved: message.evidence?.totalObserved === true
          }
        }
      }))
      .then(() => appendStartupDiagnostic(tabId, "BOOKING_SELECTION_INCOMPLETE", {
        phase: String(message.phase || "selection"),
        missingFacts,
        evidence: message.evidence || {}
      }))
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, code: "BOOKING_SELECTION_DIAGNOSTIC_FAILED", error: error.message }));
    return true;
  }

  if (message?.type === "ATW_BOOKING_SELECTION_CAPTURED") {
    const tabId = sender.tab?.id;
    if (!Number.isInteger(tabId)) {
      sendResponse({ ok: false, code: "CHECKOUT_TAB_REQUIRED" });
      return false;
    }
    captureSelectedBooking(tabId, message.selectedBookingContract, { phase: message.phase })
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, code: "BOOKING_SELECTION_CAPTURE_FAILED", error: error.message }));
    return true;
  }

  if (message?.type === "ATW_START_CHECKOUT") {
    const extensionOwnedMessage = sender.id === chrome.runtime.id;
    const tabId = Number.isInteger(sender.tab?.id)
      ? sender.tab.id
      : (extensionOwnedMessage && Number.isInteger(message.tabId) ? message.tabId : null);
    startCheckoutOnTab(tabId, {
      selectedBookingContract: message.selectedBookingContract || null,
      selectedTravelerId: String(message.selectedTravelerId || ""),
      autoStart: message.autoStart !== false
    })
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, code: "CHECKOUT_START_FAILED", error: error.message }));
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
