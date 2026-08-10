import {
  SELECTED_BOOKING_MAX_AGE_MS,
  approvedSelectedBookingAcquisitionFromMap,
  authoritativeSelectedBookingFacts
} from "./selected-booking.js";
import { currentNavigationUrl } from "./navigation-identity.js";

const SELECTED_BOOKING_KEY = "atwSelectedBookingAcquisitionV1";
const UNCHANGED_RETRY_MS = 30_000;
const START_ACQUISITION_TIMEOUT_MS = 10_000;
const START_MUTATION_SETTLE_MS = 180;

export function createSelectedBookingAcquisition({
  durableClear = async () => undefined,
  durableRead = async () => null,
  durableWrite = async () => undefined,
  isSessionActive,
  observationHashForMap,
  pageStateStore,
  captureDelayMs = 350,
  unchangedRetryMs = UNCHANGED_RETRY_MS
}) {
  let captureTimer = null;
  let pendingStartAcquisition = null;
  let durableAcquisition = null;
  let durableHydrated = false;
  let selectionCaptureArmed = false;
  let captureAttempt = {
    url: "",
    snapshotHash: "",
    retryAfter: 0
  };

  function validAcquisition(acquisition = null, { requireCurrentOrigin = false } = {}) {
    const capturedAt = Date.parse(acquisition?.capturedAt || "");
    return Boolean(
      acquisition?.contractVersion === "selected-booking-acquisition/v1"
      && (!requireCurrentOrigin || acquisition.sourceOrigin === location.origin)
      && Number.isFinite(capturedAt)
      && Date.now() - capturedAt <= SELECTED_BOOKING_MAX_AGE_MS
      && authoritativeSelectedBookingFacts(acquisition.facts)
    );
  }

  function read() {
    if (validAcquisition(durableAcquisition)) return durableAcquisition;
    try {
      const acquisition = JSON.parse(sessionStorage.getItem(SELECTED_BOOKING_KEY) || "null");
      if (!validAcquisition(acquisition, { requireCurrentOrigin: true })) {
        sessionStorage.removeItem(SELECTED_BOOKING_KEY);
        return null;
      }
      return acquisition;
    } catch (error) {
      return null;
    }
  }

  async function hydrate() {
    if (durableHydrated) return read();
    durableHydrated = true;
    try {
      const acquisition = await durableRead();
      if (validAcquisition(acquisition)) {
        durableAcquisition = acquisition;
        try {
          sessionStorage.setItem(SELECTED_BOOKING_KEY, JSON.stringify(acquisition));
        } catch (error) {
          // Cross-origin durable storage is authoritative when sessionStorage is unavailable.
        }
      } else if (acquisition) {
        await durableClear();
      }
    } catch (error) {
      // A storage outage must not prevent bounded visible-page acquisition.
    }
    return read();
  }

  function persist(acquisition = null) {
    if (!acquisition) return null;
    durableAcquisition = acquisition;
    try {
      sessionStorage.setItem(SELECTED_BOOKING_KEY, JSON.stringify(acquisition));
    } catch (error) {
      // Opaque documents may deny sessionStorage; the in-memory result remains valid.
    }
    Promise.resolve(durableWrite(acquisition)).catch(() => undefined);
    return acquisition;
  }

  function capture(map = null) {
    const facts = authoritativeSelectedBookingFacts(map?.transactionFacts);
    if (!facts) return null;
    const existing = read();
    // The approved flight is immutable after checkout leaves flight selection.
    if (existing && map?.step !== "flight_selection") return existing;
    const acquisition = {
      contractVersion: "selected-booking-acquisition/v1",
      capturedAt: new Date().toISOString(),
      sourceOrigin: location.origin,
      sourceUrl: currentNavigationUrl(),
      observationId: `booking_capture_${Date.now().toString(36)}`,
      facts
    };
    return persist(acquisition);
  }

  function approveVisibleSummary(map = null, approvalSource = "explicit_agent_start") {
    const observationHash = String(observationHashForMap(map) || "");
    return persist(approvedSelectedBookingAcquisitionFromMap(map, {
      approvalSource,
      observationHash,
      sourceUrl: currentNavigationUrl()
    }));
  }

  function acquisitionFromMap(map = null) {
    return read() || capture(map) || approveVisibleSummary(map);
  }

  async function acquireForStart({
    initialMap = null,
    timeoutMs = START_ACQUISITION_TIMEOUT_MS,
    mutationSettleMs = START_MUTATION_SETTLE_MS
  } = {}) {
    await hydrate();
    const immediate = acquisitionFromMap(initialMap || pageStateStore.current());
    if (immediate) return immediate;
    if (pendingStartAcquisition) return pendingStartAcquisition.promise;

    let observer = null;
    let settleTimer = null;
    let deadlineTimer = null;
    let scanBusy = false;
    let scanQueued = false;
    let resolvePending = null;

    function cleanup() {
      observer?.disconnect();
      observer = null;
      if (settleTimer) clearTimeout(settleTimer);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      settleTimer = null;
      deadlineTimer = null;
      pendingStartAcquisition = null;
    }

    function finish(value = null) {
      const resolve = resolvePending;
      cleanup();
      resolve?.(value);
    }

    async function scan(reason = "mutation") {
      if (scanBusy) {
        scanQueued = true;
        return;
      }
      scanBusy = true;
      try {
        const observed = await pageStateStore.observeFresh({
          reason: `selected_booking_start_${reason}`,
          maxWaitMs: 500,
          maxAttempts: 2,
          postBuildGraceMs: 80
        });
        const acquisition = acquisitionFromMap(observed.map);
        if (acquisition) {
          finish(acquisition);
          return;
        }
      } finally {
        scanBusy = false;
      }
      if (scanQueued && pendingStartAcquisition) {
        scanQueued = false;
        scan("queued");
      }
    }

    function scheduleScan(reason = "mutation") {
      if (!pendingStartAcquisition || settleTimer) return;
      settleTimer = setTimeout(() => {
        settleTimer = null;
        scan(reason);
      }, Math.max(0, mutationSettleMs));
    }

    const promise = new Promise((resolve) => {
      resolvePending = resolve;
      const boundedTimeout = Math.max(0, Number(timeoutMs) || 0);
      observer = new MutationObserver((mutations) => {
        pageStateStore.noteMutations(mutations);
        scheduleScan("mutation");
      });
      observer.observe(document.documentElement || document.body, {
        attributes: true,
        childList: true,
        characterData: true,
        subtree: true
      });
      deadlineTimer = setTimeout(async () => {
        await scan("deadline");
        if (pendingStartAcquisition) finish(null);
      }, boundedTimeout);
    });
    pendingStartAcquisition = { promise, finish };
    return promise;
  }

  function potentialBookingCommitTarget(target = null) {
    const owner = target?.closest?.("a, button, [role='button'], [role='radio'], [role='option']");
    if (!owner || owner.closest?.("#atw-sidebar")) return null;
    const copy = [
      owner.innerText,
      owner.textContent,
      owner.getAttribute?.("aria-label"),
      owner.getAttribute?.("title"),
      owner.id,
      owner.getAttribute?.("name"),
      owner.getAttribute?.("data-testid")
    ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim().slice(0, 600);
    return /\b(?:select|choose|continue|proceed|confirm|book|fare|flight|next)\b/i.test(copy)
      ? owner
      : null;
  }

  function onPotentialBookingCommit(event) {
    if (isSessionActive() || !potentialBookingCommitTarget(event.target)) return;
    queueMicrotask(() => {
      if (isSessionActive()) return;
      const observed = pageStateStore.observe({
        forceFull: true,
        reason: "selected_booking_user_commit"
      });
      capture(observed.map) || approveVisibleSummary(observed.map, "explicit_flight_selection");
    });
  }

  function armSelectionCapture() {
    if (selectionCaptureArmed) return false;
    selectionCaptureArmed = true;
    document.addEventListener("click", onPotentialBookingCommit, false);
    return true;
  }

  function disarmSelectionCapture() {
    if (!selectionCaptureArmed) return false;
    selectionCaptureArmed = false;
    document.removeEventListener("click", onPotentialBookingCommit, false);
    return true;
  }

  function schedule(reason = "page_update") {
    if (isSessionActive() || captureTimer) return false;
    const currentUrl = currentNavigationUrl();
    if (captureAttempt.url === currentUrl && Date.now() < captureAttempt.retryAfter) return false;
    captureTimer = setTimeout(() => {
      captureTimer = null;
      if (isSessionActive()) return;
      const observed = pageStateStore.observe({ reason: `selected_booking_${reason}` });
      const captured = capture(observed.map);
      const snapshotHash = String(observed.snapshotHash || observationHashForMap(observed.map));
      const unchangedMiss = !captured
        && captureAttempt.url === currentNavigationUrl()
        && captureAttempt.snapshotHash === snapshotHash
        && observed.material === false;
      captureAttempt = {
        url: currentNavigationUrl(),
        snapshotHash,
        retryAfter: captured
          ? Number.POSITIVE_INFINITY
          : Date.now() + (unchangedMiss ? unchangedRetryMs : 1_500)
      };
    }, captureDelayMs);
    return true;
  }

  function cancel() {
    let cancelled = false;
    if (captureTimer) {
      clearTimeout(captureTimer);
      captureTimer = null;
      cancelled = true;
    }
    if (pendingStartAcquisition) {
      pendingStartAcquisition.finish(null);
      cancelled = true;
    }
    return cancelled;
  }

  return Object.freeze({
    acquireForStart,
    approveVisibleSummary,
    armSelectionCapture,
    cancel,
    capture,
    disarmSelectionCapture,
    hydrate,
    read,
    schedule
  });
}
