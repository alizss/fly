export function createSelectedBookingAdmission({
  checkoutContextRead = async () => null,
  checkoutLineageBegin = async () => null,
  recordEvent = () => undefined
} = {}) {
  let checkoutContext = null;

  async function refresh() {
    try {
      const current = await checkoutContextRead();
      checkoutContext = current?.contractVersion === "checkout-context/v1" ? current : null;
    } catch (_error) {
      checkoutContext = null;
    }
    return checkoutContext;
  }

  async function ensureLineage() {
    if (checkoutContext?.checkoutLineageId) return checkoutContext;
    try {
      const current = await checkoutLineageBegin({ rotate: false });
      if (current?.contractVersion === "checkout-context/v1") checkoutContext = current;
    } catch (_error) {
      // Admission remains unavailable; Start reports the missing authority.
    }
    return checkoutContext;
  }

  async function admitForStart() {
    await refresh();
    await ensureLineage();
    const selectedBookingContract = checkoutContext?.selectedBookingContract || null;
    if (selectedBookingContract) {
      recordEvent("BOOKING_AUTHORITY_AVAILABLE", {
        checkoutLineageId: String(checkoutContext.checkoutLineageId || ""),
        selectionId: String(selectedBookingContract.selectionId || "")
      });
      return Object.freeze({
        contractVersion: "booking-admission/v1",
        status: "confirmed",
        reason: checkoutContext.source === "app_launch"
          ? "APP_SELECTED_BOOKING_CONFIRMED"
          : "BROWSER_SELECTED_BOOKING_CONFIRMED",
        missingFacts: [],
        selectedBookingContract,
        checkoutLineageId: String(checkoutContext.checkoutLineageId || "")
      });
    }

    const missingFacts = Array.isArray(checkoutContext?.selectionCandidate?.missingFacts)
      ? checkoutContext.selectionCandidate.missingFacts
      : ["itinerary", "approved_total", "currency"];
    recordEvent("BOOKING_AUTHORITY_MISSING", {
      checkoutLineageId: String(checkoutContext?.checkoutLineageId || ""),
      missingFacts
    });
    return Object.freeze({
      contractVersion: "booking-admission/v1",
      status: checkoutContext?.selectionCandidate ? "candidate" : "absent",
      reason: checkoutContext?.selectionCandidate
        ? "SELECTION_BOOKING_INCOMPLETE"
        : "SELECTED_BOOKING_NOT_CAPTURED",
      missingFacts: Object.freeze([...missingFacts]),
      selectedBookingContract: null,
      checkoutLineageId: String(checkoutContext?.checkoutLineageId || "")
    });
  }

  return Object.freeze({
    admitForStart,
    hydrate: refresh,
    read: () => checkoutContext?.selectedBookingContract || null
  });
}
