(async () => {
  "use strict";

  // This producer is deliberately independent from the checkout engine. It
  // observes only an explicit user booking-selection gesture, performs no
  // mutation scanning or planning, and sends one bounded contract to the
  // background owner. Keeping it small lets Fly retain booking authority on
  // unfamiliar sites without injecting the heavy runtime before Start.
  let runtimeEpoch = "unavailable";
  try {
    const probe = await chrome.runtime.sendMessage({ type: "ATW_EXTENSION_RUNTIME_PROBE" });
    runtimeEpoch = String(probe?.epoch || "unavailable");
  } catch (_error) {
    // A newly injected producer will normally have a live background. When it
    // does not, do not let a stale global marker claim current ownership.
  }
  const existingOwner = globalThis.__ATW_PRECHECKOUT_CAPTURE_OWNER__;
  if (existingOwner?.epoch === runtimeEpoch && existingOwner?.ready === true) return;
  globalThis.__ATW_PRECHECKOUT_CAPTURE_OWNER__ = Object.freeze({
    epoch: runtimeEpoch,
    ready: true
  });
  chrome.runtime.sendMessage({
    type: "ATW_PRECHECKOUT_READY",
    epoch: runtimeEpoch,
    origin: location.origin
  }).catch(() => undefined);

  const MAX_TEXT = 12_000;
  const CURRENCY_SYMBOLS = Object.freeze({ "€": "EUR", "$": "USD", "£": "GBP", "₺": "TRY" });
  const NON_AIRPORT_CODES = new Set([
    "EUR", "USD", "GBP", "TRY", "CAD", "AUD", "NZD", "CHF", "JPY", "CNY",
    "AED", "SAR", "INR", "SEK", "NOK", "DKK", "PLN", "CZK", "HUF", "RON",
    "VAT", "TAX", "TOTAL", "FROM", "SELECT", "BOOK", "PAY"
  ]);
  const MONTHS = Object.freeze({
    jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
    apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
    aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
    nov: 11, november: 11, dec: 12, december: 12
  });
  let selectedTravelerId = "";
  chrome.storage.local.get(["selectedTravelerId"])
    .then((stored) => { selectedTravelerId = clean(stored.selectedTravelerId); })
    .catch(() => undefined);

  function clean(value = "") {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function visibleText(node) {
    if (!node || !(node instanceof Element)) return "";
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") return "";
    const rect = node.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return "";
    return clean(node.innerText || node.textContent || "").slice(0, MAX_TEXT);
  }

  function attribute(node, names = []) {
    for (const name of names) {
      const value = clean(node?.getAttribute?.(name));
      if (value) return value;
    }
    return "";
  }

  function isoDate(value = "") {
    const text = clean(value);
    const compact = text.match(/^((?:19|20)\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?:\d{4,6})?$/);
    if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
    const direct = text.match(/\b(20\d{2})[-/.](0?[1-9]|1[0-2])[-/.](0?[1-9]|[12]\d|3[01])\b/);
    if (direct) return `${direct[1]}-${String(direct[2]).padStart(2, "0")}-${String(direct[3]).padStart(2, "0")}`;
    const dayFirst = text.match(/\b(0?[1-9]|[12]\d|3[01])\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(20\d{2})\b/i);
    if (dayFirst) {
      const month = MONTHS[dayFirst[2].toLowerCase()];
      if (month) return `${dayFirst[3]}-${String(month).padStart(2, "0")}-${String(dayFirst[1]).padStart(2, "0")}`;
    }
    const monthFirst = text.match(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(0?[1-9]|[12]\d|3[01])(?:,)?\s+(20\d{2})\b/i);
    if (monthFirst) {
      const month = MONTHS[monthFirst[1].toLowerCase()];
      if (month) return `${monthFirst[3]}-${String(month).padStart(2, "0")}-${String(monthFirst[2]).padStart(2, "0")}`;
    }
    return "";
  }

  function airportCode(value = "") {
    const code = clean(value).toUpperCase();
    return /^[A-Z]{3}$/.test(code) && !NON_AIRPORT_CODES.has(code) ? code : "";
  }

  function explicitRoute(node, text = visibleText(node)) {
    const origin = airportCode(attribute(node, ["data-origin", "data-origin-airport", "data-from", "data-departure-airport"]));
    const destination = airportCode(attribute(node, ["data-destination", "data-destination-airport", "data-to", "data-arrival-airport"]));
    if (origin && destination && origin !== destination) return { origin, destination };

    const labeledOrigin = text.match(/(?:from|origin|departure(?: airport)?)\s*[:\-]?\s*\(?([A-Z]{3})\)?\b/i);
    const labeledDestination = text.match(/(?:to|destination|arrival(?: airport)?)\s*[:\-]?\s*\(?([A-Z]{3})\)?\b/i);
    const labeled = {
      origin: airportCode(labeledOrigin?.[1]),
      destination: airportCode(labeledDestination?.[1])
    };
    if (labeled.origin && labeled.destination && labeled.origin !== labeled.destination) return labeled;

    // Require a directional token or whitespace around a dash. Otherwise
    // ordinary hyphenated words such as "ADD-ONS" become fake airport pairs.
    const pair = text.match(/\b([A-Z]{3})\b(?:\s*(?:→|➝|⟶)\s*|\s+[–—-]\s+|\s+to\s+)\b([A-Z]{3})\b/i);
    const paired = { origin: airportCode(pair?.[1]), destination: airportCode(pair?.[2]) };
    return paired.origin && paired.destination && paired.origin !== paired.destination ? paired : null;
  }

  function departureDate(node, text = visibleText(node)) {
    const direct = attribute(node, ["data-departure-date", "data-date", "data-flight-date"]);
    if (isoDate(direct)) return isoDate(direct);
    const time = node?.querySelector?.("time[datetime]");
    const timeValue = attribute(time, ["datetime"]);
    return isoDate(timeValue) || isoDate(text);
  }

  function numericAmount(value = "") {
    let raw = clean(value).replace(/[^\d.,\s]/g, "").replace(/\s/g, "");
    if (!raw) return null;
    const comma = raw.lastIndexOf(",");
    const dot = raw.lastIndexOf(".");
    if (comma >= 0 && dot >= 0) raw = comma > dot ? raw.replace(/\./g, "").replace(",", ".") : raw.replace(/,/g, "");
    else if (comma >= 0) raw = raw.length - comma - 1 <= 2 ? raw.replace(",", ".") : raw.replace(/,/g, "");
    else if (dot >= 0 && raw.length - dot - 1 > 2) raw = raw.replace(/\./g, "");
    const amount = Number(raw);
    return Number.isFinite(amount) && amount >= 0 ? amount : null;
  }

  function moneyFromText(value = "") {
    const text = clean(value);
    const labeled = text.match(/(?:total|amount due|grand total|trip total|booking total|fare total|price)\s*[:\-]?\s*(?:(EUR|USD|GBP|TRY|CAD|AUD|NZD|CHF|JPY|CNY|AED|SAR|INR|SEK|NOK|DKK|PLN|CZK|HUF|RON|€|\$|£|₺)\s*)?([\d][\d\s.,]*)(?:\s*(EUR|USD|GBP|TRY|CAD|AUD|NZD|CHF|JPY|CNY|AED|SAR|INR|SEK|NOK|DKK|PLN|CZK|HUF|RON|€|\$|£|₺))?/i);
    const general = text.match(/(?:(EUR|USD|GBP|TRY|CAD|AUD|NZD|CHF|JPY|CNY|AED|SAR|INR|SEK|NOK|DKK|PLN|CZK|HUF|RON|€|\$|£|₺)\s*)([\d][\d\s.,]*)|([\d][\d\s.,]*)\s*(EUR|USD|GBP|TRY|CAD|AUD|NZD|CHF|JPY|CNY|AED|SAR|INR|SEK|NOK|DKK|PLN|CZK|HUF|RON|€|\$|£|₺)/i);
    const match = labeled || general;
    if (!match) return null;
    const rawCurrency = clean(labeled ? (match[1] || match[3]) : (match[1] || match[4])).toUpperCase();
    const amount = numericAmount(labeled ? match[2] : (match[2] || match[3]));
    const currency = CURRENCY_SYMBOLS[rawCurrency] || rawCurrency;
    return amount == null || !currency ? null : { amount, currency, labeled: Boolean(labeled) };
  }

  function explicitMoney(node) {
    const amount = numericAmount(attribute(node, ["data-total", "data-total-price", "data-price", "data-amount"]));
    const rawCurrency = attribute(node, ["data-currency", "data-price-currency"]).toUpperCase();
    const currency = CURRENCY_SYMBOLS[rawCurrency] || rawCurrency;
    if (amount != null && currency) return { amount, currency, labeled: true };
    const totalNodes = [...node.querySelectorAll?.("[data-total], [data-total-price], [data-amount], [aria-label*='total' i], [class*='total' i], [id*='total' i]") || []];
    for (const totalNode of totalNodes.slice(0, 24)) {
      const candidate = moneyFromText(`${attribute(totalNode, ["aria-label"])} ${visibleText(totalNode)}`);
      if (candidate) return { ...candidate, labeled: true };
    }
    return moneyFromText(visibleText(node));
  }

  function segmentFromNode(node, index = 0) {
    const text = visibleText(node);
    const route = explicitRoute(node, text);
    const date = departureDate(node, text);
    if (!route || !date) return null;
    return {
      segmentId: `segment_${index + 1}_${route.origin}_${route.destination}_${date}`,
      origin: route.origin,
      destination: route.destination,
      departureDate: date
    };
  }

  function parameterValue(params, patterns = []) {
    for (const [key, value] of params.entries()) {
      const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]+/g, "_");
      if (patterns.some((pattern) => pattern.test(normalizedKey)) && clean(value)) return clean(value);
    }
    return "";
  }

  function structuredSegmentsFromUrl() {
    let url;
    try {
      url = new URL(location.href);
    } catch (_error) {
      return [];
    }
    const params = url.searchParams;
    const origin = airportCode(parameterValue(params, [
      /^(?:origin|from|departure_airport|departure_location|b_location_1)$/
    ]));
    const destination = airportCode(parameterValue(params, [
      /^(?:destination|to|arrival_airport|arrival_location|e_location_1)$/
    ]));
    const departure = isoDate(parameterValue(params, [
      /^(?:departure_date|depart_date|outbound_date|b_date_1)$/
    ]));
    if (!origin || !destination || origin === destination || !departure) return [];
    const segments = [{
      segmentId: `segment_1_${origin}_${destination}_${departure}`,
      origin,
      destination,
      departureDate: departure
    }];
    const returnDate = isoDate(parameterValue(params, [
      /^(?:return_date|inbound_date|b_date_2)$/
    ]));
    const tripType = parameterValue(params, [/^(?:trip_type|journey_type)$/]).toUpperCase();
    if (returnDate && (/^(?:R|RT|RETURN|ROUNDTRIP|ROUND_TRIP)$/.test(tripType) || returnDate !== departure)) {
      segments.push({
        segmentId: `segment_2_${destination}_${origin}_${returnDate}`,
        origin: destination,
        destination: origin,
        departureDate: returnDate
      });
    }
    return segments;
  }

  function segmentsFromScope(scope) {
    const urlSegments = structuredSegmentsFromUrl();
    if (urlSegments.length) return urlSegments;
    const candidates = [
      ...scope.querySelectorAll?.("[data-flight], [data-segment], [data-origin], [data-origin-airport], article, [role='row']") || []
    ].slice(0, 80);
    const segments = [];
    for (const node of candidates) {
      const segment = segmentFromNode(node, segments.length);
      if (!segment) continue;
      if (segments.some((item) => item.origin === segment.origin && item.destination === segment.destination && item.departureDate === segment.departureDate)) continue;
      segments.push(segment);
    }
    if (!segments.length) {
      const segment = segmentFromNode(scope, 0);
      if (segment) segments.push(segment);
    }
    return segments.slice(0, 8);
  }

  function scopesFor(target) {
    const scopes = [];
    let current = target;
    for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
      if (current instanceof Element && visibleText(current)) scopes.push(current);
    }
    const main = document.querySelector("main, [role='main']");
    if (main && !scopes.includes(main)) scopes.push(main);
    if (document.body && !scopes.includes(document.body)) scopes.push(document.body);
    return scopes;
  }

  function candidateFromScope(scope, target) {
    const segments = segmentsFromScope(scope);
    const total = explicitMoney(scope);
    const text = visibleText(scope);
    const score = (segments.length * 5)
      + (total ? (total.labeled ? 5 : 2) : 0)
      + (/selected|your flight|trip summary|booking summary|fare|itinerary/i.test(text) ? 2 : 0)
      - Math.min(4, Math.floor(text.length / 3000));
    return {
      scope,
      segments,
      total,
      complete: Boolean(segments.length && total),
      score,
      containsTarget: scope.contains(target)
    };
  }

  function actionLabel(target) {
    return clean([
      attribute(target, ["aria-label", "title", "value"]),
      visibleText(target)
    ].filter(Boolean).join(" "));
  }

  function explicitSelectionGesture(target) {
    if (!target?.matches?.("button, a, [role='button'], input[type='button'], input[type='submit']")) return false;
    if (target.closest?.("#atw-sidebar, #atw-agent-cursor, [data-atw-owned='true']")) return false;
    const label = actionLabel(target);
    if (/\b(?:select|choose)(?: this)? (?:flight|fare|option)\b|\b(?:book|reserve)(?: this)? (?:flight|fare)\b/i.test(label)) return true;
    const pageContext = clean([
      document.title,
      ...[...document.querySelectorAll("h1, h2, [role='heading']")].slice(0, 4).map((node) => node.textContent)
    ].join(" "));
    return /(?:select|choose).*(?:flight|fare)|(?:flight|fare).*(?:select|choose)|fare options|flight results/i.test(pageContext)
      && /^(?:continue|next|confirm|select|choose|book|reserve)(?:\b|\s)/i.test(label)
      && !/details|learn|info|expand|more|share|filter|sort|login|sign in/i.test(label);
  }

  function selectionSourceUrl() {
    try {
      const url = new URL(location.href);
      return `${url.origin}${url.pathname}${url.hash || ""}`;
    } catch (_error) {
      return location.origin || "";
    }
  }

  async function publishSelection(target, phase, gestureId) {
    if (!explicitSelectionGesture(target)) return;
    const candidates = scopesFor(target)
      .map((scope) => candidateFromScope(scope, target))
      .filter(Boolean)
      .sort((a, b) => Number(b.complete) - Number(a.complete)
        || b.score - a.score
        || visibleText(a.scope).length - visibleText(b.scope).length);
    const selected = candidates[0];
    const missingFacts = [];
    if (!selected?.segments?.length) missingFacts.push("itinerary");
    if (!selected?.total) missingFacts.push("approved_total", "currency");
    if (!selected?.complete) {
      chrome.runtime.sendMessage({
        type: "ATW_BOOKING_SELECTION_CANDIDATE",
        phase,
        missingFacts,
        evidence: {
          producerEpoch: runtimeEpoch,
          explicitSelectionGesture: true,
          itineraryObserved: Boolean(selected?.segments?.length),
          totalObserved: Boolean(selected?.total)
        }
      }).catch(() => undefined);
      return;
    }
    const now = new Date().toISOString();
    const sourceSegments = structuredSegmentsFromUrl();
    const selectedBookingCandidate = {
      contractVersion: "selected-booking-candidate/v1",
      selectionId: `browser_selection_${gestureId}`,
      selectedAt: now,
      sourceUrl: selectionSourceUrl(),
      sourceRouteEvidence: sourceSegments[0]
        ? { origin: sourceSegments[0].origin, destination: sourceSegments[0].destination }
        : null,
      itinerary: { segments: selected.segments },
      approvedTotal: {
        amount: selected.total.amount,
        currency: selected.total.currency
      },
      fareBrand: ""
    };
    const travelerId = selectedTravelerId || clean((await chrome.storage.local.get(["selectedTravelerId"])).selectedTravelerId);
    if (!travelerId) {
      chrome.runtime.sendMessage({
        type: "ATW_BOOKING_SELECTION_CANDIDATE",
        phase,
        missingFacts: ["selected_traveler"],
        selectedBookingCandidate
      }).catch(() => undefined);
      return;
    }
    const contract = {
      ...selectedBookingCandidate,
      contractVersion: "selected-booking/v1",
      travelerIds: [travelerId]
    };
    chrome.runtime.sendMessage({
      type: "ATW_BOOKING_SELECTION_CAPTURED",
      phase,
      selectedBookingContract: contract
    }).catch(() => undefined);
  }

  document.addEventListener("click", (event) => {
    const target = event.target?.closest?.("button, a, [role='button'], input[type='button'], input[type='submit']");
    if (!target) return;
    const gestureId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    publishSelection(target, "pre_click", gestureId);
    queueMicrotask(() => publishSelection(target, "post_click_microtask", gestureId));
    setTimeout(() => publishSelection(target, "post_click_settled", gestureId), 350);
  }, true);
})();
