chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(["apiBase"]);
  if (!existing.apiBase) {
    await chrome.storage.local.set({ apiBase: "http://localhost:4173/api" });
  }
});

const NAVIGATION_INDEX_KEY = "atwNavigationEpisodeIndex";
const NAVIGATION_KEY_PREFIX = "atwNavigationEpisode:";
const NAVIGATION_EPISODE_MAX_AGE_MS = 2 * 60 * 1000;
const NAVIGATION_TARGET_CREATION_WINDOW_MS = 15 * 1000;
const navigationEpisodeKey = (episodeId) => `${NAVIGATION_KEY_PREFIX}${episodeId}`;
const navigationClaimLocks = new Map();

async function withNavigationClaimLock(tabId, task) {
  const key = String(tabId);
  while (navigationClaimLocks.has(key)) {
    await navigationClaimLocks.get(key);
  }
  let release;
  const lock = new Promise((resolve) => { release = resolve; });
  navigationClaimLocks.set(key, lock);
  try {
    return await task();
  } finally {
    if (navigationClaimLocks.get(key) === lock) navigationClaimLocks.delete(key);
    release();
  }
}

function freshNavigationRoute(route) {
  const deadlineAt = Number(route?.episode?.deadlineAt || route?.deadlineAt || 0);
  const armedAt = Number(route?.armedAt || 0);
  return Boolean(
    route?.episode?.episodeId
    && route?.episode?.sessionId
    && route?.episode?.actionId
    && Number.isInteger(route?.sourceTabId)
    && armedAt > 0
    && Date.now() - armedAt < NAVIGATION_EPISODE_MAX_AGE_MS
    && (!deadlineAt || Date.now() <= deadlineAt)
  );
}

async function navigationRoutes() {
  const indexStored = await chrome.storage.local.get(NAVIGATION_INDEX_KEY);
  const keys = Array.isArray(indexStored?.[NAVIGATION_INDEX_KEY])
    ? indexStored[NAVIGATION_INDEX_KEY].filter((key) => String(key).startsWith(NAVIGATION_KEY_PREFIX))
    : [];
  if (!keys.length) return [];
  const stored = await chrome.storage.local.get(keys);
  const fresh = [];
  const staleKeys = [];
  for (const key of keys) {
    const route = stored?.[key];
    if (freshNavigationRoute(route)) fresh.push({ key, route });
    else staleKeys.push(key);
  }
  if (staleKeys.length) {
    await chrome.storage.local.remove(staleKeys);
    await chrome.storage.local.set({
      [NAVIGATION_INDEX_KEY]: keys.filter((key) => !staleKeys.includes(key))
    });
  }
  return fresh;
}

async function saveNavigationRoute(route) {
  const key = navigationEpisodeKey(route.episode.episodeId);
  const existing = await navigationRoutes();
  const superseded = existing.filter(({ route: prior }) => (
    prior.episode.sessionId === route.episode.sessionId
    && prior.episode.actionId !== route.episode.actionId
  ));
  if (superseded.length) await chrome.storage.local.remove(superseded.map(({ key: priorKey }) => priorKey));
  const index = [...new Set([
    ...existing.filter(({ key: priorKey }) => !superseded.some(({ key: stale }) => stale === priorKey)).map(({ key: priorKey }) => priorKey),
    key
  ])];
  await chrome.storage.local.set({ [key]: route, [NAVIGATION_INDEX_KEY]: index });
  return { key, route };
}

async function updateNavigationRoute(key, route) {
  await chrome.storage.local.set({ [key]: route });
  return route;
}

async function destinationRouteForTab(tabId, documentId = "") {
  const routes = await navigationRoutes();
  return routes.filter(({ route }) => (
    Number(route.destinationTabId) === Number(tabId)
    && route.status === "DESTINATION_ASSIGNED"
    && (!documentId || !route.destinationDocumentId || route.destinationDocumentId === documentId)
  )).sort((left, right) => (
    Number(right.route.assignedAt || right.route.armedAt || 0)
    - Number(left.route.assignedAt || left.route.armedAt || 0)
  ))[0] || null;
}

function routeCanFollowCommittedDocument(route = {}, details = {}) {
  if (route.status === "DESTINATION_READY") {
    const qualifiers = Array.isArray(details.transitionQualifiers) ? details.transitionQualifiers : [];
    const redirectCommit = qualifiers.some((value) => ["client_redirect", "server_redirect"].includes(value));
    return Boolean(
      redirectCommit
      && Number(route.destinationTabId) === Number(details.tabId)
      && details.documentId
      && String(details.documentId) !== String(route.destinationDocumentId || "")
    );
  }
  if (route.status !== "DESTINATION_CLAIMED") return true;
  const tabId = Number(details.tabId);
  const sameDestinationTab = Number(route.destinationTabId) === tabId;
  if (!sameDestinationTab) return false;
  const nextDocumentId = String(details.documentId || "");
  const claimedDocumentId = String(route.destinationDocumentId || "");
  // A claimed document owns retries within itself. A subsequent top-level
  // document in the same routed tab is a redirect continuation until one
  // destination has completed observation and marks the route ready.
  return Boolean(nextDocumentId && nextDocumentId !== claimedDocumentId);
}

async function assignNavigationDestination(entry, details = {}) {
  if (!entry || !Number.isInteger(details.tabId) || !/^https?:\/\//i.test(String(details.url || ""))) return null;
  const assigned = {
    ...entry.route,
    status: "DESTINATION_ASSIGNED",
    redirectContinuationFromReady: entry.route.status === "DESTINATION_READY",
    destinationTabId: details.tabId,
    destinationWindowId: Number.isInteger(details.windowId) ? details.windowId : entry.route.destinationWindowId,
    destinationDocumentId: String(details.documentId || ""),
    destinationUrl: String(details.url || ""),
    assignedAt: Date.now()
  };
  await updateNavigationRoute(entry.key, assigned);
  return { key: entry.key, route: assigned };
}

async function routeForCommittedNavigation(details = {}) {
  if (details.frameId !== 0 || !Number.isInteger(details.tabId)) return null;
  const routes = await navigationRoutes();
  // A fresh action armed by the document currently occupying this tab owns
  // its next navigation. This must outrank an older episode that previously
  // arrived in the same tab; otherwise a provider redirect can be claimed by
  // the transaction that opened the intermediate page instead of the action
  // that actually submitted it.
  const newest = (entries = []) => [...entries].sort((left, right) => (
    Number(right.route.armedAt || 0) - Number(left.route.armedAt || 0)
  ))[0] || null;
  const directSource = newest(routes.filter(({ route }) => (
    Number(route.sourceTabId) === details.tabId
    && routeCanFollowCommittedDocument(route, details)
    && String(details.url || "") !== String(route.sourceUrl || "")
  )));
  const assignedDestination = newest(routes.filter(({ route }) => (
    routeCanFollowCommittedDocument(route, details)
    && (
      Number(route.candidateTabId) === details.tabId
      || Number(route.destinationTabId) === details.tabId
    )
  )));
  const exact = directSource || assignedDestination;
  return exact ? assignNavigationDestination(exact, details) : null;
}

async function injectActiveCheckout(tabId, url = "", documentId = "") {
  if (!Number.isInteger(tabId) || !/^https?:\/\//i.test(String(url || ""))) return false;
  const entry = await destinationRouteForTab(tabId, documentId);
  if (!entry) return false;
  try {
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ["src/content/sidebar.css"]
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["dist/content.js"]
    });
    // Pull is authoritative, but a statically matched document may already be
    // idle. Wake it after routing is committed so it can claim the exact
    // session/action episode; a fresh injection performs the same pull on boot.
    try {
      await chrome.tabs.sendMessage(tabId, { type: "ATW_CLAIM_NAVIGATION_EPISODE" });
    } catch (error) {
      // The newly injected script may still be initializing. Its boot path
      // consumes the transfer marker independently.
    }
    return true;
  } catch (error) {
    // Restricted browser pages and documents that disappear during redirect
    // are expected. The next committed HTTP(S) destination gets another turn.
    return false;
  }
}

chrome.tabs.onCreated.addListener((tab) => {
  if (!Number.isInteger(tab?.id)) return;
  (async () => {
    const routes = await navigationRoutes();
    const exactOpener = Number.isInteger(tab.openerTabId)
      ? routes.find(({ route }) => (
          route.sourceTabId === tab.openerTabId
          && route.status !== "DESTINATION_CLAIMED"
          && route.status !== "DESTINATION_READY"
        ))
      : null;
    const unassigned = routes.filter(({ route }) => (
      !Number.isInteger(route.destinationTabId)
      && !Number.isInteger(route.candidateTabId)
      && route.status === "ARMED"
    ));
    const candidate = exactOpener || (
      unassigned.length === 1
      && tab.active !== false
      && Date.now() - Number(unassigned[0].route.armedAt || 0) <= NAVIGATION_TARGET_CREATION_WINDOW_MS
        ? unassigned[0]
        : null
    );
    if (!candidate || tab.id === candidate.route.sourceTabId) return;
    await updateNavigationRoute(candidate.key, {
      ...candidate.route,
      candidateTabId: tab.id,
      candidateWindowId: Number.isInteger(tab.windowId) ? tab.windowId : null,
      candidateCreatedAt: Date.now()
    });
  })().catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  injectActiveCheckout(tabId, tab?.url || changeInfo.url || "").catch(() => {});
});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  (async () => {
    const routes = await navigationRoutes();
    for (const entry of routes) {
      if (![entry.route.sourceTabId, entry.route.candidateTabId, entry.route.destinationTabId].includes(removedTabId)) continue;
      await updateNavigationRoute(entry.key, {
        ...entry.route,
        sourceTabId: entry.route.sourceTabId === removedTabId ? addedTabId : entry.route.sourceTabId,
        candidateTabId: entry.route.candidateTabId === removedTabId ? addedTabId : entry.route.candidateTabId,
        destinationTabId: entry.route.destinationTabId === removedTabId ? addedTabId : entry.route.destinationTabId
      });
    }
    const replacement = await chrome.tabs.get(addedTabId).catch(() => null);
    if (replacement?.status === "complete") {
      await injectActiveCheckout(addedTabId, replacement.url || "");
    }
  })().catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  // Removing the source page must not erase an in-flight transaction. Routes
  // are action-scoped and expire from their durable deadline instead.
});

chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => {
  (async () => {
    const routes = await navigationRoutes();
    const source = routes.filter(({ route }) => (
      route.sourceTabId === details.sourceTabId
      && route.status !== "DESTINATION_CLAIMED"
      && route.status !== "DESTINATION_READY"
    )).sort((left, right) => (
      Number(right.route.armedAt || 0) - Number(left.route.armedAt || 0)
    ))[0] || null;
    if (!source) return;
    await assignNavigationDestination(source, details);
  })().catch(() => {});
});

chrome.webNavigation.onCommitted.addListener((details) => {
  // Route assignment and content wake-up are one operation. Relying only on
  // a later DOMContentLoaded/onUpdated event introduced a race on fast
  // intermediate payment pages: their static content script could pull before
  // assignment, then remain idle until the user pressed Start again.
  routeForCommittedNavigation(details)
    .then((entry) => entry && injectActiveCheckout(details.tabId, details.url || "", details.documentId || ""))
    .catch(() => {});
});

chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  routeForCommittedNavigation(details)
    .then((entry) => entry && injectActiveCheckout(details.tabId, details.url || "", details.documentId || ""))
    .catch(() => {});
});

chrome.webNavigation.onReferenceFragmentUpdated.addListener((details) => {
  routeForCommittedNavigation(details)
    .then((entry) => entry && injectActiveCheckout(details.tabId, details.url || "", details.documentId || ""))
    .catch(() => {});
});

chrome.webNavigation.onDOMContentLoaded.addListener((details) => {
  if (details.frameId !== 0) return;
  injectActiveCheckout(details.tabId, details.url || "", details.documentId || "").catch(() => {});
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

  if (message?.type === "ATW_ARM_NAVIGATION_EPISODE") {
    const tabId = sender.tab?.id;
    const windowId = sender.tab?.windowId;
    (async () => {
      if (!Number.isInteger(tabId) || !Number.isInteger(windowId)) {
        sendResponse({ ok: false, code: "NAVIGATION_SOURCE_CONTEXT_MISSING" });
        return;
      }
      const episode = message.episode;
      if (!episode?.episodeId || !episode?.sessionId || !episode?.actionId) {
        sendResponse({ ok: false, code: "NAVIGATION_EPISODE_INVALID" });
        return;
      }
      await saveNavigationRoute({
        episode,
        sourceTabId: tabId,
        sourceWindowId: windowId,
        sourceDocumentId: String(sender.documentId || message.sourceDocumentId || ""),
        sourceUrl: String(sender.tab?.url || message.sourceUrl || ""),
        status: "ARMED",
        armedAt: Date.now()
      });
      sendResponse({ ok: true, armed: true });
    })().catch((error) => {
      sendResponse({ ok: false, code: "NAVIGATION_EPISODE_ARM_FAILED", error: error?.message || "" });
    });
    return true;
  }

  if (message?.type === "ATW_CLAIM_NAVIGATION_EPISODE") {
    const tabId = sender.tab?.id;
    if (!Number.isInteger(tabId)) {
      sendResponse({ ok: false, code: "NAVIGATION_DESTINATION_CONTEXT_MISSING" });
      return false;
    }
    withNavigationClaimLock(tabId, async () => {
      const claimantId = String(message.claimantId || sender.documentId || "");
      const existingRoutes = await navigationRoutes();
      const claimedByThisController = existingRoutes.find(({ route }) => (
        route.status === "DESTINATION_CLAIMED"
        && Number(route.destinationTabId) === Number(tabId)
        && claimantId
        && route.destinationControllerId === claimantId
      )) || null;
      if (claimedByThisController) {
        return {
          ok: true,
          episode: claimedByThisController.route.episode,
          destination: {
            tabContextId: String(tabId),
            documentId: claimantId,
            browserDocumentId: String(sender.documentId || claimedByThisController.route.destinationDocumentId || ""),
            url: String(sender.tab?.url || claimedByThisController.route.destinationUrl || ""),
            redirectContinuation: claimedByThisController.route.redirectContinuationFromReady === true
          }
        };
      }
      let entry = await destinationRouteForTab(tabId, String(sender.documentId || ""));
      if (!entry) {
        // webNavigation assignment can race the destination content script,
        // especially through short-lived provider handoff pages. A new
        // document in the exact source tab may pull the one action-scoped
        // route directly. Session/action identity and document identity still
        // prevent an unrelated page from claiming it.
        const routes = await navigationRoutes();
        const destinationUrl = String(sender.tab?.url || "");
        const destinationDocumentId = String(sender.documentId || "");
        const sourceFallback = routes.filter(({ route }) => (
          (route.sourceTabId === tabId || route.destinationTabId === tabId)
          && routeCanFollowCommittedDocument(route, {
            tabId,
            documentId: destinationDocumentId,
            url: destinationUrl
          })
          && (
            (destinationDocumentId && destinationDocumentId !== String(route.sourceDocumentId || ""))
            || (destinationUrl && destinationUrl !== String(route.sourceUrl || ""))
          )
        )).sort((left, right) => (
          Number(right.route.armedAt || 0) - Number(left.route.armedAt || 0)
        ))[0] || null;
        if (sourceFallback) {
          entry = await assignNavigationDestination(sourceFallback, {
            tabId,
            windowId: sender.tab?.windowId,
            documentId: destinationDocumentId,
            url: destinationUrl
          });
        }
      }
      if (!entry) {
        return { ok: true, episode: null };
      }
      const claimed = {
        ...entry.route,
        status: "DESTINATION_CLAIMED",
        destinationDocumentId: String(sender.documentId || entry.route.destinationDocumentId || ""),
        destinationControllerId: claimantId,
        destinationUrl: String(sender.tab?.url || entry.route.destinationUrl || ""),
        claimedAt: Date.now()
      };
      await updateNavigationRoute(entry.key, claimed);
      if (claimed.sourceTabId !== tabId && Number.isInteger(claimed.sourceTabId)) {
        chrome.tabs.sendMessage(claimed.sourceTabId, {
          type: "ATW_NAVIGATION_DESTINATION_CLAIMED",
          episodeId: claimed.episode.episodeId,
          destinationTabId: tabId
        }).catch(() => {});
      }
      return {
        ok: true,
        episode: claimed.episode,
        destination: {
          tabContextId: String(tabId),
          documentId: claimantId || claimed.destinationDocumentId,
          browserDocumentId: claimed.destinationDocumentId,
          url: claimed.destinationUrl,
          redirectContinuation: claimed.redirectContinuationFromReady === true
        }
      };
    }).then(sendResponse).catch((error) => sendResponse({
      ok: false,
      code: "NAVIGATION_EPISODE_CLAIM_FAILED",
      error: error?.message || ""
    }));
    return true;
  }

  if (message?.type === "ATW_NAVIGATION_DESTINATION_READY") {
    const tabId = sender.tab?.id;
    if (!Number.isInteger(tabId)) {
      sendResponse({ ok: false, code: "NAVIGATION_DESTINATION_CONTEXT_MISSING" });
      return false;
    }
    withNavigationClaimLock(tabId, async () => {
      const claimantId = String(message.claimantId || sender.documentId || "");
      const episodeId = String(message.episodeId || "");
      const routes = await navigationRoutes();
      const entry = routes.find(({ route }) => (
        route.status === "DESTINATION_CLAIMED"
        && Number(route.destinationTabId) === Number(tabId)
        && route.episode?.episodeId === episodeId
        && claimantId
        && route.destinationControllerId === claimantId
      )) || null;
      if (!entry) return { ok: false, code: "NAVIGATION_DESTINATION_NOT_OWNED" };
      await updateNavigationRoute(entry.key, {
        ...entry.route,
        status: "DESTINATION_READY",
        readyAt: Date.now()
      });
      return { ok: true, ready: true };
    }).then(sendResponse).catch((error) => sendResponse({
      ok: false,
      code: "NAVIGATION_DESTINATION_READY_FAILED",
      error: error?.message || ""
    }));
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
