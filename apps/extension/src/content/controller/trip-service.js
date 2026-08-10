const BAGGAGE_TERMS = [
  "no cabin bag", "baggage not included", "personal item only", "without baggage", "checked baggage not included"
];
const MULTI_AIRPORT_CODES = new Set(["LHR", "LGW", "LTN", "STN", "LCY", "CDG", "ORY", "BVA", "IST", "SAW"]);

export function createTripService({
  defaultApi,
  getAppData,
  renderSaved,
  setAppData,
  storageGet,
  traveler
}) {
  function monthsAfter(dateString, months) {
    const date = new Date(dateString);
    date.setMonth(date.getMonth() + months);
    return date;
  }

  function extractPrice() {
    const priceEl = document.querySelector("[data-price]");
    if (!priceEl) return null;
    const amount = Number(priceEl.textContent.replace(/[^0-9.]/g, ""));
    return Number.isFinite(amount) ? { amount, currency: priceEl.dataset.currency || "USD" } : null;
  }

  function extractTripShallow() {
    const departureText = document.querySelector("[data-departure]")?.textContent?.trim();
    return {
      departureDate: departureText ? new Date(departureText) : null,
      destinationAirport: document.querySelector("[data-destination]")?.textContent?.trim()
    };
  }

  function runRiskChecks() {
    const selectedTraveler = traveler();
    const pageText = document.body.innerText.toLowerCase();
    const trip = extractTripShallow();
    const results = [];
    if (BAGGAGE_TERMS.some((term) => pageText.includes(term))) {
      results.push({ type: "missing_baggage", severity: "medium", title: "Baggage may not be included", message: "This fare appears to exclude cabin or checked baggage." });
    }
    if (selectedTraveler?.document?.expiry_date && trip.departureDate) {
      const minValid = monthsAfter(trip.departureDate, 6);
      if (new Date(selectedTraveler.document.expiry_date) < minValid) {
        results.push({ type: "passport_expiry", severity: "high", title: "Passport expiry risk", message: "Passport may expire too soon for this trip." });
      }
    }
    const first = document.querySelector("[name='first_name']")?.value;
    const last = document.querySelector("[name='last_name']")?.value;
    if (
      (first && first.trim().toLowerCase() !== selectedTraveler.first_name.toLowerCase())
      || (last && last.trim().toLowerCase() !== selectedTraveler.last_name.toLowerCase())
    ) {
      results.push({ type: "name_mismatch", severity: "high", title: "Name mismatch", message: "Passenger name may not match saved travel document." });
    }
    if (MULTI_AIRPORT_CODES.has(trip.destinationAirport)) {
      results.push({ type: "multiple_airport", severity: "low", title: "Confirm airport", message: "This city has multiple airports. Confirm the correct airport." });
    }
    if (pageText.includes("invoice") && !pageText.includes("tax id")) {
      results.push({ type: "invoice_missing", severity: "medium", title: "Invoice details missing", message: "Company workspace is active and invoice fields may not be complete." });
    }
    return results;
  }

  function extractTrip() {
    const selectedTraveler = traveler();
    const price = extractPrice();
    const departure = document.querySelector("[data-departure]")?.textContent?.trim() || "";
    return {
      workspace_id: getAppData().workspaces[0]?.id,
      traveler_profile_id: selectedTraveler.id,
      airline: document.querySelector("[data-airline]")?.textContent?.trim() || "Demo Air",
      seller: document.querySelector("[data-seller]")?.textContent?.trim() || location.host,
      origin_airport: document.querySelector("[data-origin]")?.textContent?.trim() || "",
      destination_airport: document.querySelector("[data-destination]")?.textContent?.trim() || "",
      departure_at: departure ? new Date(departure).toISOString() : "",
      return_at: "",
      booking_reference: document.querySelector("[data-booking-reference]")?.textContent?.trim() || "",
      price_amount: price?.amount || 0,
      price_currency: price?.currency || "USD",
      baggage_summary: document.querySelector("[data-baggage-summary]")?.textContent?.trim() || "",
      booking_url: location.href,
      invoice_status: "missing",
      warnings: runRiskChecks().map((warning) => warning.message)
    };
  }

  async function saveTrip() {
    const settings = await storageGet(["apiBase"]);
    const response = await fetch(`${settings.apiBase || defaultApi}/trips`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(extractTrip())
    });
    if (!response.ok) throw new Error("Could not save trip");
    setAppData(await response.json());
    renderSaved();
  }

  return Object.freeze({ extractPrice, extractTrip, extractTripShallow, runRiskChecks, saveTrip });
}
