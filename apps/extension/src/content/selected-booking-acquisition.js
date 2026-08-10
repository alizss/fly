import {
  SELECTED_BOOKING_MAX_AGE_MS,
  authoritativeSelectedBookingFacts
} from "./selected-booking.js";

const SELECTED_BOOKING_KEY = "atwSelectedBookingAcquisitionV1";
const UNCHANGED_RETRY_MS = 30_000;

export function createSelectedBookingAcquisition({
  isSessionActive,
  observationHashForMap,
  pageStateStore,
  captureDelayMs = 350,
  unchangedRetryMs = UNCHANGED_RETRY_MS
}) {
  let captureTimer = null;
  let captureAttempt = {
    url: "",
    snapshotHash: "",
    retryAfter: 0
  };

  function read() {
    try {
      const acquisition = JSON.parse(sessionStorage.getItem(SELECTED_BOOKING_KEY) || "null");
      const capturedAt = Date.parse(acquisition?.capturedAt || "");
      if (
        acquisition?.contractVersion !== "selected-booking-acquisition/v1"
        || acquisition.sourceOrigin !== location.origin
        || !Number.isFinite(capturedAt)
        || Date.now() - capturedAt > SELECTED_BOOKING_MAX_AGE_MS
        || !authoritativeSelectedBookingFacts(acquisition.facts)
      ) {
        sessionStorage.removeItem(SELECTED_BOOKING_KEY);
        return null;
      }
      return acquisition;
    } catch (error) {
      return null;
    }
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
      sourceUrl: location.href,
      observationId: `booking_capture_${Date.now().toString(36)}`,
      facts
    };
    try {
      sessionStorage.setItem(SELECTED_BOOKING_KEY, JSON.stringify(acquisition));
    } catch (error) {
      // Opaque documents may deny sessionStorage; the in-memory result remains valid.
    }
    return acquisition;
  }

  function schedule(reason = "page_update") {
    if (isSessionActive() || captureTimer) return false;
    if (captureAttempt.url === location.href && Date.now() < captureAttempt.retryAfter) return false;
    captureTimer = setTimeout(() => {
      captureTimer = null;
      if (isSessionActive()) return;
      const observed = pageStateStore.observe({ reason: `selected_booking_${reason}` });
      const captured = capture(observed.map);
      const snapshotHash = String(observed.snapshotHash || observationHashForMap(observed.map));
      const unchangedMiss = !captured
        && captureAttempt.url === location.href
        && captureAttempt.snapshotHash === snapshotHash
        && observed.material === false;
      captureAttempt = {
        url: location.href,
        snapshotHash,
        retryAfter: captured
          ? Number.POSITIVE_INFINITY
          : Date.now() + (unchangedMiss ? unchangedRetryMs : 1_500)
      };
    }, captureDelayMs);
    return true;
  }

  function cancel() {
    if (!captureTimer) return false;
    clearTimeout(captureTimer);
    captureTimer = null;
    return true;
  }

  return Object.freeze({ capture, read, schedule, cancel });
}
