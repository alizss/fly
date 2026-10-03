const BOOKING_TOTAL_CONTRACT = globalThis.AtwBookingTotalContract;

export function normalizedCurrencyToken(value = "") {
  return BOOKING_TOTAL_CONTRACT.normalizedCurrencyToken(value);
}

export function localizedPriceAmount(value = "") {
  return BOOKING_TOTAL_CONTRACT.localizedPriceAmount(value);
}

export function structuredPricesFromText(value = "") {
  return BOOKING_TOTAL_CONTRACT.structuredPricesFromText(value);
}

export function structuredPriceFromText(value = "") {
  return structuredPricesFromText(value)[0] || null;
}

export function currentCommercialOptionPrice(value = "") {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  const cues = [...text.matchAll(/\b(?:discounted|current|final|now|today(?:'s|’s)?)\s*(?:price)?\s*[:–—-]?\s*/gi)];
  for (const cue of cues.reverse()) {
    const boundedTail = text.slice(cue.index + cue[0].length, cue.index + cue[0].length + 100);
    const price = structuredPricesFromText(boundedTail)[0] || null;
    if (price) return price;
  }
  return null;
}
