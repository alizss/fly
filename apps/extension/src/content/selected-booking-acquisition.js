import {
  SELECTED_BOOKING_MAX_AGE_MS,
  authoritativeSelectedBookingFacts,
  selectedBookingAdmissionState,
  selectedBookingCompatibilityWithMap
} from "./selected-booking.js";
import { currentNavigationUrl } from "./navigation-identity.js";

const SELECTED_BOOKING_KEY = "atwSelectedBookingAcquisitionV1";
const UNCHANGED_RETRY_MS = 30_000;

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
    return capture(map);
  }

  async function admitForStart({ initialMap = null } = {}) {
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
    if (!checkoutContext?.checkoutLineageId) await beginCheckoutLineage({ rotate: false });
    // Admission is a single snapshot read. Existing/app-supplied evidence may
    // strengthen the baseline, but DOM hydration can never delay or authorize
    // durable session creation.
    const map = initialMap || pageStateStore.current();
    const acquisition = acquisitionFromMap(map);
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

  function bookingSelectionContext(owner = null) {
    const contexts = [];
    let cursor = owner?.parentElement || null;
    while (cursor && contexts.length < 8) {
      if (cursor.matches?.("article, section, form, [role='group'], [role='radiogroup'], main")) contexts.push(cursor);
      if (cursor.matches?.("main")) break;
      cursor = cursor.parentElement;
    }
    if (!contexts.length || contexts.some((context) => context.closest?.("#atw-sidebar"))) {
      return { copy: "", structuredItinerary: false };
    }
    const copy = contexts.flatMap((context) => {
      const heading = context.querySelector?.("h1, h2, h3, legend, [role='heading']");
      return [
        context.getAttribute?.("aria-label"),
        context.getAttribute?.("data-testid"),
        context.id,
        typeof context.className === "string" ? context.className : "",
        heading?.innerText,
        heading?.textContent
      ];
    }).filter(Boolean).join(" ").replace(/\s+/g, " ").trim().slice(0, 1_200);
    const structuredItinerary = contexts.some((context) => (
      context.matches?.("[data-origin][data-destination]")
      || context.querySelector?.("[data-origin][data-destination]")
    ));
    return { copy, structuredItinerary };
  }

  function explicitBookingSelectionTarget(target = null) {
    const owner = target?.closest?.("a, button, [role='button'], [role='radio'], [role='option']");
    if (!owner || owner.closest?.("#atw-sidebar")) return null;
    const ownerCopy = bookingCommitCopy(owner);
    const context = bookingSelectionContext(owner);
    const explicitCopy = `${ownerCopy} ${context.copy}`;
    const explicitFlightSelection = /\b(?:select|choose|book)\b.*\b(?:flight|fare)\b|\b(?:flight|fare)\b.*\b(?:select|choose|book)\b/i.test(explicitCopy);
    const contextualCommit = /\b(?:continue|proceed|next|confirm|select|choose|book)\b/i.test(ownerCopy)
      && (context.structuredItinerary || /\b(?:flight|fare)[\s_-]+(?:selection|options?|choice|family)\b/i.test(context.copy));
    return explicitFlightSelection || contextualCommit
      ? owner
      : null;
  }

  function onPotentialBookingCommit(event) {
    const commitTarget = explicitBookingSelectionTarget(event.target);
    if (isSessionActive() || !commitTarget) return;
    // One explicit flight/fare selection may establish the immutable booking
    // baseline. Generic Continue/Next/Confirm controls are not booking
    // authority and must leave the idle extension inert.
    const selectionObservation = pageStateStore.observe({
      forceFull: true,
      reason: "selected_booking_user_commit"
    });
    const lineagePromise = beginCheckoutLineage({ rotate: true });
    queueMicrotask(async () => {
      if (isSessionActive()) return;
      const activeContext = await lineagePromise;
      const lineageOptions = {
        checkoutLineageId: activeContext?.checkoutLineageId || "",
        replaceExisting: true
      };
      capture(selectionObservation.map, lineageOptions);
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
    return cancelled;
  }

  return Object.freeze({
    admitForStart,
    armSelectionCapture,
    cancel,
    capture,
    discard,
    disarmSelectionCapture,
    hydrate,
    read,
    schedule
  });
}
