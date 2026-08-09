export function createTransactionEvidenceCompiler(dependencies) {
  const {
    AGENT_CONTRACT,
    agent,
    implicitRole,
    isVisible,
    itineraryActionEvidence,
    primaryPageText,
    queryAllDeep,
    stableHash,
    structuredPricesFromText,
    traveler,
    visiblePageText
  } = dependencies;

  function transactionFactsEvidence({ step = "unknown", price = null, decisionGroups = [], activeSurface = {}, terminalEvidence = null } = {}) {
    const text = String(primaryPageText() || visiblePageText() || "")
      .replace(/[\u200e\u200f\u202a-\u202e]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const normalizeCurrency = (value = "") => ({ "€": "EUR", "$": "USD", "£": "GBP" }[String(value).toUpperCase()] || String(value).toUpperCase());
    const attributeSegments = queryAllDeep("[data-origin][data-destination], [data-departure-airport][data-arrival-airport]")
      .map((element, index) => ({
        segmentId: element.getAttribute("data-segment-id") || `structured_${index + 1}`,
        origin: (element.getAttribute("data-origin") || element.getAttribute("data-departure-airport") || "").toUpperCase(),
        destination: (element.getAttribute("data-destination") || element.getAttribute("data-arrival-airport") || "").toUpperCase(),
        departureDate: element.getAttribute("data-departure-date") || "",
        departureTime: element.getAttribute("data-departure-time") || "",
        arrivalTime: element.getAttribute("data-arrival-time") || "",
        flightNumber: (element.getAttribute("data-flight-number") || "").toUpperCase(),
        confidence: 0.95
      }))
      .filter((segment) => segment.origin || segment.destination);
    const normalizeRouteEndpoint = (value = "") => {
      const endpoint = String(value || "")
        .replace(/^(?:from|to|departure|arrival)\s*:?\s*/i, "")
        .replace(/\s+/g, " ")
        .trim();
      const airportCode = endpoint.match(/(?:^|\s|\()([A-Z]{3})(?:\)|\s|$)/)?.[1];
      return (airportCode || endpoint).slice(0, 80).toUpperCase();
    };
    const reservedRouteEndpoint = (value = "") => {
      const endpoint = String(value || "").trim();
      const tokens = endpoint.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
      const reserved = new Set([
        "trip", "summary", "primary", "passenger", "checked", "baggage",
        "travel", "insurance", "direct", "flight", "booking", "payment",
        "overview", "contact", "details", "ticket", "fare", "seat", "seating"
      ]);
      const nonTravelMeaning = /\b(?:adult|child|children|infant|teen|passengers?|age|aged|years?|months?|over|under|younger|older|kg|kgs|kilograms?|lb|lbs|pounds?|cm|centimet(?:er|re)s?|dimensions?)\b/i;
      const nonRouteCommerceMeaning = /\b(?:non[ -]?refundable|refundable|changeable|changes?|subject|fees?|charges?|conditions?|restrictions?|included|excluded|add|buy|purchase|upgrade|bags?|baggage|luggage|onboard|carry[ -]?on|bring)\b/i;
      return !tokens.length
        || /\d/.test(endpoint)
        || tokens.length > 8
        || nonTravelMeaning.test(endpoint)
        || nonRouteCommerceMeaning.test(endpoint)
        || tokens.every((token) => reserved.has(token));
    };
    const canonicalRouteSegments = (rawSegments = []) => rawSegments.reduce((segments, segment) => {
      const duplicateIndex = segments.findIndex((candidate) => (
        candidate.origin === segment.origin
        && candidate.destination === segment.destination
        && (
          candidate.departureDate === segment.departureDate
          || !candidate.departureDate
          || !segment.departureDate
        )
      ));
      if (duplicateIndex < 0) {
        segments.push(segment);
        return segments;
      }
      const existing = segments[duplicateIndex];
      const existingDetail = [existing.departureDate, existing.departureTime, existing.arrivalTime, existing.flightNumber].filter(Boolean).length;
      const incomingDetail = [segment.departureDate, segment.departureTime, segment.arrivalTime, segment.flightNumber].filter(Boolean).length;
      const preferred = incomingDetail > existingDetail ? segment : existing;
      const secondary = preferred === segment ? existing : segment;
      segments[duplicateIndex] = {
        ...secondary,
        ...preferred,
        departureDate: preferred.departureDate || secondary.departureDate || "",
        departureTime: preferred.departureTime || secondary.departureTime || "",
        arrivalTime: preferred.arrivalTime || secondary.arrivalTime || "",
        flightNumber: preferred.flightNumber || secondary.flightNumber || ""
      };
      return segments;
    }, []);
    const routeUtilityText = (value = "") => /\b(?:phone|mobile|telephone|sms|text message|email|e-mail|wifi|wi-fi|data plan|valid number|enter a number|country code)\b/i.test(String(value || ""));
    const directElementText = (element) => Array.from(element?.childNodes || [])
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent || "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    const visibleElementText = (element, limit = 720) => String(
      element?.innerText || element?.textContent || element?.getAttribute?.("aria-label") || ""
    ).replace(/\s+/g, " ").trim().slice(0, limit);
    const itineraryCommand = (element) => /\b(?:view|show|open)?\s*(?:full\s+)?(?:flight\s+)?(?:itinerary|trip details|travel details|flight details)\b/i.test(
      String(element?.innerText || element?.textContent || element?.getAttribute?.("aria-label") || "")
    );
    const routeSeparator = /(?:→|–|—|\bto\b)/i;
    const routeDateCue = /\b(?:mon|tue|wed|thu|fri|sat|sun)(?:day)?\s+\d{1,2}(?:\s+[\p{L}]+)?(?:\s+20\d{2})?\b|\b20\d{2}-\d{2}-\d{2}\b/iu;
    const itineraryControlOwners = queryAllDeep("button, a, [role='button'], [role='link']")
      .filter((element) => isVisible(element) && itineraryCommand(element))
      .map((control) => {
        let owner = control.parentElement;
        for (let depth = 0; owner && depth < 7; depth += 1, owner = owner.parentElement) {
          if (!isVisible(owner)) continue;
          const ownerText = visibleElementText(owner);
          if (!ownerText || ownerText.length > 720 || routeUtilityText(ownerText)) continue;
          const prefix = ownerText.split(routeDateCue)[0].replace(/\b(?:view|show|open)\s+(?:full\s+)?(?:flight\s+)?(?:itinerary|trip details|flight details)\b.*$/i, "").trim();
          const unseparatedPair = /^\p{L}[\p{L}.'’-]*(?:\s+\p{L}[\p{L}.'’-]*)?\s+\p{L}[\p{L}.'’-]*(?:\s+\p{L}[\p{L}.'’-]*)?$/u.test(prefix);
          const airportHyphenPair = /\b[A-Z]{3}(?:\s+[\p{L}.'’-]+){1,4}\s*-\s*[A-Z]{3}\b/u.test(ownerText);
          if ((routeSeparator.test(ownerText) || unseparatedPair || airportHyphenPair) && routeDateCue.test(ownerText)) return owner;
        }
        return null;
      })
      .filter(Boolean);
    // Some checkouts render an owned travel-details card as rows such as
    // "AYT Antalya - SAW Istanbul". Airport-code pairs inside that exact
    // itinerary owner are authoritative even when the visual separator is a
    // plain hyphen; arbitrary page-wide hyphens remain ineligible.
    const itinerarySummarySegments = itineraryControlOwners.flatMap((owner, ownerIndex) => {
      const ownerText = visibleElementText(owner, 720);
      const matches = [...ownerText.matchAll(/\b([A-Z]{3})(?:\s+[\p{L}.'’-]+){1,4}\s*[-–—]\s*([A-Z]{3})(?:\s+[\p{L}.'’-]+){1,4}/gu)];
      return matches.map((match, matchIndex) => {
        const preceding = ownerText.slice(Math.max(0, Number(match.index || 0) - 140), Number(match.index || 0));
        const departureDate = [...preceding.matchAll(new RegExp(routeDateCue.source, "giu"))].at(-1)?.[0] || "";
        return {
          segmentId: `itinerary_summary_${ownerIndex + 1}_${matchIndex + 1}_${stableHash(`${match[1]}:${match[2]}:${departureDate}`)}`,
          origin: match[1],
          destination: match[2],
          departureDate,
          departureTime: "",
          arrivalTime: "",
          flightNumber: "",
          confidence: 0.94,
          evidence: {
            source: "itinerary_summary_owner",
            ownerKey: stableHash(`itinerary-summary:${ownerText.slice(0, 320)}`),
            qualification: "airport_code_pair_in_itinerary_owner",
            authoritative: true
          }
        };
      });
    });
    // Persistent checkout summaries may expose the selected leg as an exact
    // context action rather than a semantic itinerary card, for example:
    // "Edit Ljubljana to Edinburgh flight on 15th August 2026". The control
    // is evidence-only; it is never a checkout action candidate.
    const itineraryActionSegments = queryAllDeep("button, a, [role='button'], [role='link']")
      .filter((element) => isVisible(element))
      .map((element, index) => {
        const evidence = itineraryActionEvidence(element);
        if (!evidence) return null;
        const origin = normalizeRouteEndpoint(evidence.origin);
        const destination = normalizeRouteEndpoint(evidence.destination);
        if (!origin || !destination || reservedRouteEndpoint(origin) || reservedRouteEndpoint(destination)) return null;
        return {
          segmentId: `itinerary_action_${index + 1}_${stableHash(`${origin}:${destination}:${evidence.departureDate}`)}`,
          origin,
          destination,
          departureDate: evidence.departureDate,
          departureTime: "",
          arrivalTime: "",
          flightNumber: "",
          confidence: 0.98,
          evidence: {
            source: "itinerary_action_owner",
            ownerKey: stableHash(`itinerary-action:${evidence.label}`),
            qualification: "exact_route_flight_full_date_action",
            authoritative: true
          }
        };
      })
      .filter(Boolean);
    // Progressive payment pages can render the selected itinerary as one
    // compact sentence instead of semantic cards: "FROM City (AAA) ... TO
    // City (BBB) ...". FROM/TO + two IATA codes + owned travel timing is a
    // positive route contract; arbitrary page prose and separators remain
    // ineligible.
    const progressiveItinerarySegments = [...text.matchAll(
      /\bFROM\s+([\p{L} .'’-]{1,60}?)\s*\(([A-Z]{3})\)\s+(.{0,90}?)\bTO\s+([\p{L} .'’-]{1,60}?)\s*\(([A-Z]{3})\)\s+(.{0,90}?)(?=\b(?:FROM|economy|business|premium|show\s+details|which\s+currency|payment|$))/giu
    )].map((match, index) => {
      const departureContext = String(match[3] || "");
      const arrivalContext = String(match[6] || "");
      const departureDate = departureContext.match(/\b(?:\d{1,2}\s+[\p{L}]+\s+(?:mon|tue|wed|thu|fri|sat|sun)|(?:mon|tue|wed|thu|fri|sat|sun)\s+\d{1,2}\s+[\p{L}]+|20\d{2}-\d{2}-\d{2})\b/iu)?.[0] || "";
      const departureTime = departureContext.match(/\b\d{1,2}:\d{2}\b/)?.[0] || "";
      const arrivalTime = arrivalContext.match(/\b\d{1,2}:\d{2}\b/)?.[0] || "";
      if (!departureDate || !departureTime || !arrivalTime) return null;
      return {
        segmentId: `progressive_itinerary_${index + 1}_${stableHash(`${match[2]}:${match[5]}:${departureDate}`)}`,
        origin: match[2],
        destination: match[5],
        departureDate,
        departureTime,
        arrivalTime,
        flightNumber: "",
        confidence: 0.94,
        evidence: {
          source: "progressive_from_to_itinerary",
          ownerKey: stableHash(`progressive-itinerary:${match[0].slice(0, 260)}`),
          qualification: "from_to_iata_pair_with_date_and_times",
          authoritative: true
        }
      };
    }).filter(Boolean);
    // Persistent checkout chrome commonly publishes a compact selected
    // booking such as "Departure SJJ - IST • 15 Oct Thu Departure: 20:45 |
    // Arrival: 23:40". Require labelled direction, two IATA endpoints, a
    // travel date, and both times. This is evidence-only page chrome; it does
    // not become a foreground surface or an actuator.
    const persistentSummarySegments = [...text.matchAll(
      /\b(Departure|Outbound|Return|Inbound)\s+([A-Z]{3})\s*[-–—]\s*([A-Z]{3})\s*[•|]?\s*(\d{1,2}\s+[\p{L}]+(?:\s+(?:mon|tue|wed|thu|fri|sat|sun)(?:day)?)?(?:\s+20\d{2})?).{0,100}?\bDeparture\s*:\s*(\d{1,2}:\d{2})\s*[|·•]?\s*Arrival\s*:\s*(\d{1,2}:\d{2})/giu
    )].map((match, index) => ({
      segmentId: `persistent_summary_${index + 1}_${stableHash(`${match[2]}:${match[3]}:${match[4]}`)}`,
      origin: match[2],
      destination: match[3],
      departureDate: match[4],
      departureTime: match[5],
      arrivalTime: match[6],
      flightNumber: "",
      confidence: 0.95,
      evidence: {
        source: "persistent_booking_summary",
        ownerKey: stableHash(`persistent-booking:${match[0].slice(0, 260)}`),
        qualification: "labelled_iata_pair_with_date_and_times",
        authoritative: true
      }
    }));
    // Checkout sites frequently render the persistent selected route as an
    // ordinary styled div/span rather than a semantic heading. Read only a
    // small, exact route-shaped owner; never infer a route from page-wide text.
    const checkoutRouteContext = Boolean(
      price
      || decisionGroups.length
      || /\b(?:booking|checkout|passengers?|ticket fare|seating|overview\s*(?:&|and)\s*payment)\b/i.test(text)
    );
    const boundedRouteSegments = queryAllDeep("h1, h2, h3, h4, h5, h6, [role='heading'], [aria-label*='route' i], [data-testid*='route' i], main div, main span, [role='main'] div, [role='main'] span, form div, form span")
      .filter((element) => isVisible(element))
      .map((element) => {
        const directText = directElementText(element);
        const label = directText || ((element.children?.length || 0) <= 6 ? visibleElementText(element, 180) : "");
        return { element, label };
      })
      .filter(({ label }) => label.length >= 5 && label.length <= 180 && !routeUtilityText(label))
      .map(({ element, label }, index) => {
        const ownerMetadata = `${element.getAttribute?.("aria-label") || ""} ${element.getAttribute?.("data-testid") || ""}`;
        const explicitRouteOwner = /route|itinerary/i.test(ownerMetadata);
        const semanticOwner = /^h[1-6]$/i.test(element.tagName || "")
          || implicitRole(element) === "heading"
          || explicitRouteOwner;
        const explicitVisualSeparator = /[→–—]/.test(label);
        if (!semanticOwner && (!checkoutRouteContext || !explicitVisualSeparator)) return null;
        const match = label.match(/^(.{2,80}?)\s*(?:→|–|—|\bto\b)\s*(.{2,80}?)$/i);
        if (!match) return null;
        const origin = normalizeRouteEndpoint(match[1]);
        const destination = normalizeRouteEndpoint(match[2]);
        if (!origin || !destination || origin === destination || reservedRouteEndpoint(origin) || reservedRouteEndpoint(destination)) return null;
        const localText = visibleElementText(element.parentElement, 320);
        const ownedDate = localText.match(routeDateCue)?.[0] || "";
        const airportPair = /(?:^|\s|\()([A-Z]{3})(?:\)|\s|$)/.test(match[1])
          && /(?:^|\s|\()([A-Z]{3})(?:\)|\s|$)/.test(match[2]);
        const qualification = explicitRouteOwner
          ? "semantic_route_owner"
          : airportPair
            ? "airport_code_pair"
            : ownedDate
              ? "owned_travel_date"
              : "";
        if (!qualification) return null;
        return {
          segmentId: `bounded_route_${index + 1}_${stableHash(`${origin}:${destination}:${ownedDate}`)}`,
          origin,
          destination,
          departureDate: ownedDate,
          departureTime: "",
          arrivalTime: "",
          flightNumber: "",
          confidence: semanticOwner ? 0.88 : 0.84,
          evidence: {
            source: semanticOwner ? "owned_route_heading" : "bounded_checkout_route",
            ownerKey: stableHash(`${element.tagName || "element"}:${label}`),
            qualification,
            authoritative: true
          }
        };
      })
      .filter(Boolean);
    const explicitRouteOwners = queryAllDeep("[data-testid*='itinerary' i], [data-testid*='route' i], [aria-label*='itinerary' i], [aria-label*='route' i], h1, h2, h3");
    const ownedRouteSegments = [...new Set([...explicitRouteOwners, ...itineraryControlOwners])]
      .filter((element) => isVisible(element))
      .map((element) => ({
        element,
        label: String(element.innerText || element.textContent || element.getAttribute("aria-label") || "")
          .replace(/\s+/g, " ")
          .trim()
      }))
      .filter(({ label }) => label.length >= 5 && label.length <= 520 && !routeUtilityText(label))
      .map(({ element, label }, index) => {
        const separated = label.match(/(?:^|\b)([\p{L}][\p{L} .'’-]{1,70}?(?:\s+[A-Z]{3})?)\s*(?:→|–|—|\bto\b)\s*((?:[A-Z]{3}\s+)?[\p{L}][\p{L} .'’-]{1,70}?)(?=\s+(?:mon|tue|wed|thu|fri|sat|sun|view|passenger|flight|booking|$)|$)/iu);
        const prefix = label
          .split(/\b(?:mon|tue|wed|thu|fri|sat|sun)(?:day)?\b|\bview\s+(?:full\s+)?itinerary\b/i)[0]
          .trim();
        const ownedItineraryCue = itineraryControlOwners.includes(element)
          || /itinerary|route/i.test(`${element.getAttribute?.("aria-label") || ""} ${element.getAttribute?.("data-testid") || ""}`)
          || (/\b(?:view|show|open)\s+(?:full\s+)?(?:flight\s+)?(?:itinerary|trip details|flight details)\b/i.test(label)
            && /\b(?:mon|tue|wed|thu|fri|sat|sun)(?:day)?\b/i.test(label));
        const unseparated = !separated
          && ownedItineraryCue
          && /^\p{L}[\p{L}.'’-]*\s+\p{L}[\p{L}.'’-]*$/u.test(prefix)
          ? prefix.split(/\s+/)
          : null;
        const origin = normalizeRouteEndpoint(separated?.[1] || unseparated?.[0] || "");
        const destination = normalizeRouteEndpoint(separated?.[2] || unseparated?.[1] || "");
        if (!origin || !destination || origin === destination || reservedRouteEndpoint(origin) || reservedRouteEndpoint(destination)) return null;
        const ownedDate = label.match(/\b(?:mon|tue|wed|thu|fri|sat|sun)(?:day)?\s+\d{1,2}\s+[\p{L}]+(?:\s+20\d{2})?\b/iu)?.[0] || "";
        const airportPair = /(?:^|\s|\()([A-Z]{3})(?:\)|\s|$)/.test(separated?.[1] || "")
          && /(?:^|\s|\()([A-Z]{3})(?:\)|\s|$)/.test(separated?.[2] || "");
        if (!ownedItineraryCue && !ownedDate && !airportPair) return null;
        const flight = label.match(/\b([A-Z]{2}|[A-Z]\d|\d[A-Z])\s*([0-9]{2,4})\b/) || null;
        return {
          segmentId: `owned_route_${index + 1}_${stableHash(`${origin}:${destination}:${ownedDate}`)}`,
          origin,
          destination,
          departureDate: ownedDate,
          departureTime: "",
          arrivalTime: "",
          flightNumber: flight ? `${flight[1]}${flight[2]}` : "",
          confidence: /itinerary|flight|booking|view full/i.test(label) ? 0.88 : 0.8,
          evidence: {
            source: itineraryControlOwners.includes(element) ? "itinerary_control_owner" : "owned_route_structure",
            ownerKey: stableHash(`${element.tagName || "element"}:${label.slice(0, 240)}`),
            authoritative: true
          }
        };
      })
      .filter(Boolean);
    const dates = [
      ...[...text.matchAll(/\b20\d{2}-\d{2}-\d{2}\b/g)].map((match) => match[0]),
      ...[...text.matchAll(/\b(?:mon|tue|wed|thu|fri|sat|sun)(?:day)?\s+\d{1,2}\s+[\p{L}]+\s+20\d{2}\b/giu)].map((match) => match[0])
    ];
    const timePairs = [...text.matchAll(/\b(\d{1,2}:\d{2})\s*(?:-|–|—|to)\s*(\d{1,2}:\d{2})\b/gi)];
    const flights = [...text.matchAll(/\b([A-Z]{2}|[A-Z]\d|\d[A-Z])\s*([0-9]{2,4})\b/g)]
      .map((match) => `${match[1]}${match[2]}`)
      .filter((value) => !/^20\d{2}$/.test(value));
    const segments = canonicalRouteSegments(attributeSegments.length
      ? attributeSegments.map((segment) => ({
          ...segment,
          evidence: { source: "structured_itinerary_attributes", ownerKey: segment.segmentId, authoritative: true }
        }))
      : itineraryActionSegments.length
        ? itineraryActionSegments
      : itinerarySummarySegments.length
        ? itinerarySummarySegments
        : persistentSummarySegments.length
          ? persistentSummarySegments
        : progressiveItinerarySegments.length
          ? progressiveItinerarySegments
        : ownedRouteSegments.length
        ? ownedRouteSegments
        : boundedRouteSegments.length
          ? boundedRouteSegments
          : [])
      .map(({ confidence, ...segment }) => segment)
      .slice(0, 12);
    const completeness = !segments.length
      ? "unknown"
      : segments.every((segment) => segment.origin && segment.destination && segment.departureDate)
        ? "complete"
        : "partial";
    const baseFareMatch = text.match(/\b(?:price per (?:adult|passenger)|flight ticket|base fare)\s*[:\-]?\s*(\d+(?:[.,]\d{1,2})?)\s*(EUR|USD|GBP|CHF|CAD|AUD|€|\$|£)\b/i);
    const canonicalFareLabel = (value = "") => String(value || "")
      .replace(/\b(?:continue with|ticket type|fare type|fare brand|ticket class|fare class|cabin class|travel class)\b/gi, " ")
      .replace(/^\s*\d+\s*x\s*/i, "")
      .replace(/\s+\b(?:edit|change|modify|details|selected)\b.*$/i, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    const ownedFareRows = queryAllDeep("h1, h2, h3, h4, h5, h6, [role='heading'], dt, th, [data-testid*='fare' i], [data-testid*='ticket' i], [aria-label*='fare' i], [aria-label*='ticket' i]")
      .filter((element) => isVisible(element))
      .filter((element) => /^(?:ticket type|fare type|fare brand|ticket class|fare class|cabin class|travel class)$/i.test(
        directElementText(element) || visibleElementText(element, 120)
      ))
      .map((heading) => {
        let sibling = heading.nextElementSibling;
        for (let offset = 0; sibling && offset < 4; offset += 1, sibling = sibling.nextElementSibling) {
          if (!isVisible(sibling)) continue;
          const siblingText = visibleElementText(sibling, 180);
          if (!siblingText) continue;
          if (/^h[1-6]$/i.test(sibling.tagName || "") || implicitRole(sibling) === "heading") break;
          if (/^(?:edit|change|modify|details)$/i.test(siblingText)) continue;
          const candidate = canonicalFareLabel(siblingText);
          if (candidate && candidate.length <= 120) {
            return { label: candidate, ownerKey: stableHash(`${heading.tagName || "heading"}:${siblingText}`) };
          }
        }
        let owner = heading.parentElement;
        for (let depth = 0; owner && depth < 5; depth += 1, owner = owner.parentElement) {
          if (!isVisible(owner)) continue;
          const ownerText = visibleElementText(owner, 420);
          if (ownerText.length <= 420 && /\b(?:ticket|fare|cabin|travel)\s+(?:type|brand|class)\b/i.test(ownerText)) {
            const candidate = canonicalFareLabel(ownerText);
            if (candidate && !/^(?:type|brand|class)$/i.test(candidate)) {
              return { label: candidate, ownerKey: stableHash(`${heading.tagName || "heading"}:${ownerText}`) };
            }
          }
        }
        return null;
      })
      .filter(Boolean);
    const ownedFareSummaryLines = queryAllDeep("p, li, dd, td, th, [class*='fare' i], [data-testid*='fare' i], [data-testid*='ticket' i], [aria-label*='fare' i], [aria-label*='ticket' i]")
      .filter((element) => isVisible(element))
      .map((element) => {
        const semanticOwner = /fare|ticket/i.test(`${element.getAttribute?.("class") || ""} ${element.getAttribute?.("data-testid") || ""} ${element.getAttribute?.("aria-label") || ""}`);
        const label = directElementText(element)
          || (semanticOwner ? visibleElementText(element, 140) : "");
        if (!label || label.length > 140) return null;
        const match = label.match(/^(?:\d+\s*x\s*)?([\p{L}][\p{L}0-9 +_'-]{1,80}?)\s+(?:fare|ticket)$/iu);
        const candidate = canonicalFareLabel(match?.[1] || "");
        if (!candidate || /^(?:base|flight|ticket|fare|total|price)$/i.test(candidate)) return null;
        return {
          label: candidate,
          ownerKey: stableHash(`${element.tagName || "element"}:${label}`)
        };
      })
      .filter(Boolean);
    const ownedFare = ownedFareRows[0] || ownedFareSummaryLines[0] || null;
    const fareBrand = canonicalFareLabel(ownedFare?.label || "");
    const currentTraveler = traveler() || {};
    // Terminal ownership is compiled once above this fact compiler. Do not
    // maintain a second airline-wording classifier for the same page.
    const finalReviewSurface = terminalEvidence?.boundaryObserved === true
      || terminalEvidence?.verified === true;
    const normalizedMonetaryText = (value = "") => String(value || "")
      .replace(/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "")
      .replace(/\b(EUR|USD|GBP|CHF|CAD|AUD)\s+(?:euros?|dollars?|pounds?|francs?)\b/gi, "$1")
      .replace(/(\d)\s+([.,])\s*(\d)/g, "$1$2$3")
      .replace(/\s+/g, " ")
      .trim();
    const bookingTotalFromText = (value = "") => {
      const normalized = normalizedMonetaryText(value);
      const cue = /\b(?:amount to pay|grand total|booking total|trip total|order total|total(?:\s+(?:amount|price)(?:\s+for\s+\d+\s+passengers?)?)?)\b/gi;
      const candidates = [];
      for (const match of normalized.matchAll(cue)) {
        const bounded = normalized.slice(match.index, match.index + 180);
        const found = structuredPricesFromText(bounded)[0] || null;
        if (found) candidates.push({
          ...found,
          ownerKey: stableHash(`booking-total:${bounded.slice(0, 160)}`),
          qualification: match[0].toLowerCase().replace(/\s+/g, "_")
        });
      }
      return candidates.at(-1) || null;
    };
    const stronglyOwnedBookingTotal = bookingTotalFromText(text);
    const coherentSelectedBooking = completeness === "complete"
      && segments.length > 0
      && segments.every((segment) => segment.origin && segment.destination && segment.departureDate);
    const bookingTotal = stronglyOwnedBookingTotal && (finalReviewSurface || coherentSelectedBooking)
      ? stronglyOwnedBookingTotal
      : finalReviewSurface && price
        ? {
            amount: Number(price.amount),
            currency: normalizeCurrency(price.currency),
            ownerKey: stableHash(`payment-total:${price.amount}:${price.currency}`),
            qualification: "verified_payment_summary"
          }
        : null;
    const source = finalReviewSurface
      ? "payment_summary"
      : activeSurface?.type && activeSurface.type !== "page"
        ? "popup"
        : segments.length
          ? "travel_details"
          : "order_summary";
    const canonicalOutcome = (family = "", label = "", disposition = "") => {
      const meaning = `${label} ${disposition}`.toLowerCase();
      if (family === "seat" && /random|automatic|skip|without.*seat/.test(meaning)) return "random_assignment";
      if (family === "insurance" && /no insurance|without insurance|take the risk|decline|none/.test(meaning)) return "not_included";
      if (family === "baggage" && /included|\b\d+\s*x/.test(meaning) && !/not included|no checked|without/.test(meaning)) return "included";
      if (family === "baggage" && /not included|no checked|without|decline/.test(meaning)) return "not_included";
      if (family === "fare") return "selected";
      return disposition || "selected";
    };
    const outcomeSubject = (family = "", label = "", subjectKey = "") => {
      const meaning = `${subjectKey} ${label}`.toLowerCase();
      if (family === "fare") return "ticket";
      if (family === "seat") return "seat_assignment";
      if (family === "insurance") return "trip_insurance";
      if (family === "baggage" && /checked|hold/.test(meaning)) return "checked_baggage";
      if (family === "baggage" && /cabin|carry.on|hand bag/.test(meaning)) return "cabin_baggage";
      if (family === "baggage" && /personal item/.test(meaning)) return "personal_item";
      return String(subjectKey || label || "selection").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 100);
    };
    const selectedExtras = decisionGroups
      .filter((group) => {
        if (group.status !== "satisfied" || !group.selectedLabel) return false;
        const effectRole = group.selectedEvidence?.effectRole || group.effectRole || "";
        if (["scope_toggle", "information_only", "navigation", "presentation_mode"].includes(effectRole)) return false;
        const paidOption = AGENT_CONTRACT?.isPaidCommerceOption?.({
          effectRole,
          disposition: group.selectedEvidence?.disposition || group.selectedSemantic,
          priceAmount: group.selectedEvidence?.structuredPrice?.amount,
          semanticEffect: group.selectedEvidence?.semantic || group.selectedSemantic
        }) === true;
        return !paidOption || AGENT_CONTRACT?.isGenuineSelectedPaidItem?.({
          decisionGroupId: group.decisionGroupId || group.requirementId,
          selectedControlId: group.selectedControlId || group.selectedEvidence?.selectedControlId,
          selectionOwnerId: group.selectedEvidence?.ownerElementId || group.semanticOwnership?.ownerElementId,
          selected: group.selectedEvidence?.selected === true || Boolean(group.selectedControlId),
          effectRole,
          disposition: group.selectedEvidence?.disposition || group.selectedSemantic,
          priceAmount: group.selectedEvidence?.structuredPrice?.amount,
          semanticEffect: group.selectedEvidence?.semantic || group.selectedSemantic
        }) === true;
      })
      .map((group) => {
        const family = group.subject?.family || group.family || "";
        const subjectKey = outcomeSubject(family, group.selectedLabel || "", group.subject?.key || "");
        const disposition = group.selectedEvidence?.disposition || group.selectedSemantic || "";
        return {
          decisionGroupId: group.decisionGroupId || "",
          outcomeKey: family && subjectKey ? `${family}:${subjectKey}` : "",
          family,
          effectRole: group.selectedEvidence?.effectRole || group.effectRole || "",
          subjectKey,
          label: group.selectedLabel || "",
          disposition,
          outcome: canonicalOutcome(family, group.selectedLabel || "", disposition),
          priceAmount: group.selectedEvidence?.structuredPrice?.amount ?? null,
          currency: group.selectedEvidence?.structuredPrice?.currency || bookingTotal?.currency || price?.currency || ""
        };
      });
    if (finalReviewSurface) {
      const addReviewOutcome = ({ family, subjectKey, label, outcome, disposition = outcome }) => {
        if (!family || !subjectKey || !label) return;
        selectedExtras.push({
          decisionGroupId: `review_${family}_${subjectKey}`,
          outcomeKey: `${family}:${subjectKey}`,
          family,
          subjectKey,
          label,
          disposition,
          outcome,
          priceAmount: null,
          currency: bookingTotal?.currency || price?.currency || ""
        });
      };
      const reviewFare = fareBrand;
      if (reviewFare) addReviewOutcome({ family: "fare", subjectKey: "ticket", label: reviewFare, outcome: "selected" });
      if (/\bno travel insurance\b|\bwithout (?:travel )?insurance\b/i.test(text)) {
        addReviewOutcome({ family: "insurance", subjectKey: "trip_insurance", label: "No travel insurance", outcome: "not_included", disposition: "declined" });
      }
      const randomSeat = text.match(/\b(?:\d+\s*x\s*)?(random seat|automatic(?:ally)? assigned seat|seat assigned at check[ -]?in)\b/i)?.[1] || "";
      if (randomSeat) addReviewOutcome({ family: "seat", subjectKey: "seat_assignment", label: randomSeat, outcome: "random_assignment", disposition: "included" });
      const cabinBag = text.match(/\b(?:\d+\s*x\s*)?(cabin baggage|cabin bag|carry[ -]?on bag|hand baggage)(?:\s+\d+(?:[.,]\d+)?\s*kg)?\b/i)?.[0] || "";
      if (cabinBag) addReviewOutcome({ family: "baggage", subjectKey: "cabin_baggage", label: cabinBag, outcome: "included", disposition: "included" });
      const checkedBag = text.match(/\b(?:\d+\s*x\s*)?(checked baggage|checked bag|hold baggage)(?:\s+\d+(?:[.,]\d+)?\s*kg)?\b/i)?.[0] || "";
      if (checkedBag) addReviewOutcome({ family: "baggage", subjectKey: "checked_baggage", label: checkedBag, outcome: "included", disposition: "included" });
    }
    const selectedOutcomes = [...new Map(selectedExtras
      .filter((extra) => extra.family && extra.subjectKey)
      .map((extra) => [extra.outcomeKey || `${extra.family}:${extra.subjectKey}`, extra])).values()]
      .slice(0, 40);
    return {
      contractVersion: "transaction-facts/v2",
      evidenceMode: "typed",
      itinerary: { completeness, segments },
      travelers: currentTraveler.id ? [{
        travelerId: currentTraveler.id,
        name: [currentTraveler.first_name, currentTraveler.middle_name, currentTraveler.last_name].filter(Boolean).join(" ")
      }] : [],
      currency: normalizeCurrency(bookingTotal?.currency || baseFareMatch?.[2] || ""),
      basePrice: baseFareMatch ? {
        amount: Number(baseFareMatch[1].replace(",", ".")),
        currency: normalizeCurrency(baseFareMatch[2])
      } : { amount: null, currency: normalizeCurrency(bookingTotal?.currency || "") },
      totalPrice: bookingTotal
        ? { amount: Number(bookingTotal.amount), currency: normalizeCurrency(bookingTotal.currency) }
        : { amount: null, currency: "" },
      fareBrand,
      selectedExtras: selectedOutcomes,
      factEvidence: {
        itinerary: segments.map((segment) => ({
          segmentId: segment.segmentId,
          source: segment.evidence?.source || "owned_route_structure",
          ownerKey: segment.evidence?.ownerKey || segment.segmentId,
          observationId: agent.activeObservationId || "",
          confidence: segment.evidence?.source === "structured_itinerary_attributes" ? 0.95 : 0.88,
          authoritative: segment.evidence?.authoritative === true
        })),
        fareBrand: fareBrand ? {
          source: ownedFareRows[0] ? "review_summary_row" : "owned_fare_summary_line",
          ownerKey: ownedFare?.ownerKey || "",
          observationId: agent.activeObservationId || "",
          confidence: ownedFareRows[0] ? 0.92 : 0.88,
          authoritative: true
        } : null,
        totalPrice: bookingTotal ? {
          source: finalReviewSurface ? "payment_summary_total" : "owned_price_summary",
          ownerKey: bookingTotal.ownerKey,
          role: "booking_total",
          ownerType: finalReviewSurface ? "payment_summary" : "selected_booking_summary",
          qualification: bookingTotal.qualification,
          observationId: agent.activeObservationId || "",
          confidence: 0.9,
          authoritative: true
        } : null,
        travelers: currentTraveler.id ? {
          source: "selected_traveler_profile",
          ownerKey: currentTraveler.id,
          observationId: agent.activeObservationId || "",
          confidence: 1,
          authoritative: true
        } : null
      },
      provenance: [{
        source,
        observationId: agent.activeObservationId || "",
        confidence: attributeSegments.length ? 0.95 : segments.length ? 0.88 : bookingTotal ? 0.75 : 0.35
      }]
    };
  }


  return Object.freeze({ transactionFactsEvidence });
}
