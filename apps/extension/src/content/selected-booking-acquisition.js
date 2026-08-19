import {
  SELECTED_BOOKING_MAX_AGE_MS,
  approvedSelectedBookingAcquisitionFromMap,
  authoritativeSelectedBookingFacts,
  selectedBookingAdmissionState,
  selectedBookingCompatibilityWithMap
} from "./selected-booking.js";
import { currentNavigationUrl } from "./navigation-identity.js";

const SELECTED_BOOKING_KEY = "atwSelectedBookingAcquisitionV1";
const UNCHANGED_RETRY_MS = 30_000;
const START_ACQUISITION_TIMEOUT_MS = 10_000;
const START_MUTATION_SETTLE_MS = 180;

export function createSelectedBookingAcquisition({
  checkoutContextRead = async () => null,
  checkoutLineageBegin = async () => null,
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
  let durableMutation = Promise.resolve();
  let checkoutContext = null;
  let selectionCaptureArmed = false;
  let lastAdmissionConflict = null;
  let captureAttempt = {
    url: "",
    snapshotHash: "",
    retryAfter: 0
  };

  function lineageAdmissionOptions() {
    const checkoutLineageId = String(checkoutContext?.checkoutLineageId || "").trim();
    return {
      currentUrl: currentNavigationUrl(),
      currentCheckoutLineageId: checkoutLineageId,
      checkoutLineageAuthoritative: Boolean(checkoutLineageId)
    };
  }

  async function refreshCheckoutContext() {
    try {
      const current = await checkoutContextRead();
      if (current?.contractVersion === "checkout-context/v1") {
        checkoutContext = current;
        if (current.source === "app_launch" && current.selectedBookingContract) {
          durableAcquisition = null;
          try {
            sessionStorage.removeItem(SELECTED_BOOKING_KEY);
          } catch (error) {
            // The background tab context remains authoritative.
          }
        }
      }
    } catch (error) {
      // Browser-visible acquisition remains available during a background-worker outage.
    }
    return checkoutContext;
  }

  async function beginCheckoutLineage({ rotate = false } = {}) {
    try {
      const current = await checkoutLineageBegin({ rotate });
      if (current?.contractVersion === "checkout-context/v1") checkoutContext = current;
    } catch (error) {
      // The legacy same-document fallback below remains bounded to this tab.
    }
    return checkoutContext;
  }

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
        if (acquisition) lastAdmissionConflict = selectedBookingAdmissionState(acquisition, pageStateStore.current(), {
          ...lineageAdmissionOptions()
        });
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
    await refreshCheckoutContext();
    if (checkoutContext?.source === "app_launch" && checkoutContext.selectedBookingContract) return null;
    try {
      const acquisition = await durableRead();
      if (validAcquisition(acquisition)) {
        const admission = selectedBookingAdmissionState(acquisition, pageStateStore.current(), {
          ...lineageAdmissionOptions()
        });
        if (admission.status === "confirmed") {
          durableAcquisition = acquisition;
          try {
            sessionStorage.setItem(SELECTED_BOOKING_KEY, JSON.stringify(acquisition));
          } catch (error) {
            // Cross-origin durable storage is authoritative when sessionStorage is unavailable.
          }
        } else {
          lastAdmissionConflict = admission;
          await durableClear();
        }
      } else if (acquisition) {
        lastAdmissionConflict = selectedBookingAdmissionState(acquisition, pageStateStore.current(), {
          ...lineageAdmissionOptions()
        });
        await durableClear();
      }
    } catch (error) {
      // A storage outage must not prevent bounded visible-page acquisition.
    }
    return read();
  }

  function persist(acquisition = null) {
    if (!acquisition) return null;
    lastAdmissionConflict = null;
    durableAcquisition = acquisition;
    try {
      sessionStorage.setItem(SELECTED_BOOKING_KEY, JSON.stringify(acquisition));
    } catch (error) {
      // Opaque documents may deny sessionStorage; the in-memory result remains valid.
    }
    // Serialize replacement storage. A conflicting checkout may clear the
    // previous tab acquisition immediately before this write; allowing those
    // asynchronous operations to race can delete the newly captured booking.
    durableMutation = durableMutation
      .catch(() => undefined)
      .then(() => durableWrite(acquisition))
      .catch(() => undefined);
    return acquisition;
  }

  function discard() {
    durableAcquisition = null;
    try {
      sessionStorage.removeItem(SELECTED_BOOKING_KEY);
    } catch (error) {
      // The tab-scoped durable copy is cleared below when sessionStorage is unavailable.
    }
    durableMutation = durableMutation
      .catch(() => undefined)
      .then(() => durableClear())
      .catch(() => undefined);
  }

  function capture(map = null, { checkoutLineageId = "", replaceExisting = false } = {}) {
    const facts = authoritativeSelectedBookingFacts(map?.transactionFacts);
    if (!facts) return null;
    const existing = read();
    // The approved flight is immutable after checkout leaves flight selection.
    if (existing && map?.step !== "flight_selection" && !replaceExisting) return existing;
    const acquisition = {
      contractVersion: "selected-booking-acquisition/v1",
      admissionStatus: "confirmed",
      checkoutLineageId: String(
        checkoutLineageId
        || checkoutContext?.checkoutLineageId
        || existing?.checkoutLineageId
        || `checkout_${Date.now().toString(36)}`
      ),
      capturedAt: new Date().toISOString(),
      sourceOrigin: location.origin,
      sourceUrl: currentNavigationUrl(),
      observationId: `booking_capture_${Date.now().toString(36)}`,
      approvalSource: "observed_authoritative_booking",
      missingFacts: [],
      facts
    };
    return persist(acquisition);
  }

  function approveVisibleSummary(map = null, approvalSource = "explicit_agent_start", { checkoutLineageId = "" } = {}) {
    const observationHash = String(observationHashForMap(map) || "");
    const acquisition = approvedSelectedBookingAcquisitionFromMap(map, {
      approvalSource,
      observationHash,
      sourceUrl: currentNavigationUrl()
    });
    if (!acquisition) return null;
    return persist({
      ...acquisition,
      checkoutLineageId: String(
        checkoutLineageId
        || checkoutContext?.checkoutLineageId
        || acquisition.checkoutLineageId
      )
    });
  }

  function acquisitionFromMap(map = null) {
    const existing = read();
    if (existing) {
      const admission = selectedBookingAdmissionState(existing, map, { ...lineageAdmissionOptions() });
      if (admission.status === "confirmed") return existing;
      if (admission.status === "conflict") lastAdmissionConflict = admission;
      // A new airline/itinerary in the same tab is a new transaction. The
      // old acquisition remains authoritative only for resume, which bypasses
      // fresh acquisition and uses the backend's durable baseline.
      discard();
    }
    return capture(map) || approveVisibleSummary(map);
  }

  async function admitForStart(options = {}) {
    await hydrate();
    await refreshCheckoutContext();
    if (checkoutContext?.source === "app_launch" && checkoutContext.selectedBookingContract) {
      return Object.freeze({
        contractVersion: "booking-admission/v1",
        status: "confirmed",
        reason: "APP_SELECTED_BOOKING_CONFIRMED",
        missingFacts: [],
        acquisition: null,
        selectedBookingContract: checkoutContext.selectedBookingContract,
        checkoutLineageId: String(checkoutContext.checkoutLineageId || "")
      });
    }
    const acquisition = await acquireForStart(options);
    const map = options.initialMap || pageStateStore.current();
    const admission = selectedBookingAdmissionState(acquisition, map, {
      ...lineageAdmissionOptions()
    });
    const authoritativeAdmission = acquisition ? admission : (lastAdmissionConflict || admission);
    return Object.freeze({
      contractVersion: "booking-admission/v1",
      ...authoritativeAdmission,
      acquisition: authoritativeAdmission.status === "confirmed" ? acquisition : null,
      selectedBookingContract: null,
      checkoutLineageId: authoritativeAdmission.status === "confirmed" ? String(acquisition?.checkoutLineageId || "") : ""
    });
  }

  async function acquireForStart({
    initialMap = null,
    timeoutMs = START_ACQUISITION_TIMEOUT_MS,
    mutationSettleMs = START_MUTATION_SETTLE_MS
  } = {}) {
    await hydrate();
    await refreshCheckoutContext();
    if (!checkoutContext?.checkoutLineageId) await beginCheckoutLineage({ rotate: false });
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

  function bookingCommitCopy(owner = null) {
    return [
      owner?.innerText,
      owner?.textContent,
      owner?.getAttribute?.("aria-label"),
      owner?.getAttribute?.("title"),
      owner?.id,
      owner?.getAttribute?.("name"),
      owner?.getAttribute?.("data-testid")
    ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim().slice(0, 600);
  }

  function potentialBookingCommitTarget(target = null) {
    const owner = target?.closest?.("a, button, [role='button'], [role='radio'], [role='option']");
    if (!owner || owner.closest?.("#atw-sidebar")) return null;
    const copy = bookingCommitCopy(owner);
    return /\b(?:select|choose|continue|proceed|confirm|book|fare|flight|next)\b/i.test(copy)
      ? owner
      : null;
  }

  function onPotentialBookingCommit(event) {
    const commitTarget = potentialBookingCommitTarget(event.target);
    if (isSessionActive() || !commitTarget) return;
    const beforeCommit = pageStateStore.observe({
      forceFull: true,
      reason: "selected_booking_user_commit"
    });
    const explicitSelection = /\b(?:select|choose|book)\b.*\b(?:flight|fare)\b|\b(?:flight|fare)\b.*\b(?:select|choose|book)\b/i
      .test(bookingCommitCopy(commitTarget));
    const beginsNewSelection = beforeCommit.map?.step === "flight_selection" || explicitSelection;
    const lineagePromise = beginCheckoutLineage({ rotate: beginsNewSelection });
    queueMicrotask(async () => {
      if (isSessionActive()) return;
      const activeContext = await lineagePromise;
      const observed = pageStateStore.observe({
        forceFull: true,
        reason: "selected_booking_user_commit"
      });
      const lineageOptions = {
        checkoutLineageId: activeContext?.checkoutLineageId || "",
        replaceExisting: beginsNewSelection
      };
      const captured = capture(observed.map, lineageOptions);
      if (!captured && (observed.map?.step === "flight_selection" || explicitSelection)) {
        approveVisibleSummary(observed.map, "explicit_flight_selection", lineageOptions);
      }
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
    captureTimer = setTimeout(async () => {
      captureTimer = null;
      if (isSessionActive()) return;
      const activeContext = await beginCheckoutLineage({ rotate: false });
      const observed = pageStateStore.observe({ reason: `selected_booking_${reason}` });
      const captured = capture(observed.map, {
        checkoutLineageId: activeContext?.checkoutLineageId || ""
      });
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
    admitForStart,
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
