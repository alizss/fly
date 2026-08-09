const FALLBACK_CURRENCY_CODES = new Set([
  "AED", "ARS", "AUD", "BGN", "BHD", "BRL", "CAD", "CHF", "CLP", "CNY",
  "COP", "CZK", "DKK", "EGP", "EUR", "GBP", "HKD", "HRK", "HUF", "IDR",
  "ILS", "INR", "ISK", "JPY", "KRW", "KWD", "MAD", "MXN", "MYR", "NOK",
  "NZD", "OMR", "PEN", "PHP", "PLN", "QAR", "RON", "RSD", "RUB", "SAR",
  "SEK", "SGD", "THB", "TRY", "TWD", "UAH", "USD", "VND", "ZAR"
]);

const SUPPORTED_CURRENCY_CODES = (() => {
  try {
    const supported = typeof Intl.supportedValuesOf === "function"
      ? Intl.supportedValuesOf("currency")
      : [];
    return new Set([...FALLBACK_CURRENCY_CODES, ...supported.map((code) => String(code).toUpperCase())]);
  } catch (error) {
    return FALLBACK_CURRENCY_CODES;
  }
})();

export function normalizedCurrencyToken(value = "") {
  const token = String(value || "").trim().toUpperCase();
  const symbols = { "€": "EUR", "$": "USD", "£": "GBP", "¥": "JPY", "₩": "KRW", "₹": "INR", "₺": "TRY" };
  if (symbols[token]) return symbols[token];
  if (token === "TL") return "TRY";
  return SUPPORTED_CURRENCY_CODES.has(token) ? token : "";
}

export function localizedPriceAmount(value = "") {
  const raw = String(value || "").replace(/[\s'’]/g, "");
  if (!/^-?\d[\d.,]*$/.test(raw)) return null;
  const lastDot = raw.lastIndexOf(".");
  const lastComma = raw.lastIndexOf(",");
  const separator = Math.max(lastDot, lastComma);
  let normalized = raw;
  if (separator >= 0) {
    const fractionalDigits = raw.length - separator - 1;
    if (fractionalDigits >= 1 && fractionalDigits <= 2) {
      normalized = `${raw.slice(0, separator).replace(/[.,]/g, "")}.${raw.slice(separator + 1)}`;
    } else {
      normalized = raw.replace(/[.,]/g, "");
    }
  }
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : null;
}

export function structuredPricesFromText(value = "") {
  const text = String(value || "")
    .replace(/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const numberPattern = "-?(?:\\d{1,3}(?:[\\s'’.,]\\d{3})+(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?)";
  const currencyAfterAmountPattern = "(?:(?:[A-Za-z]{3}|TL)\\b|€|\\$|£|¥|₩|₹|₺)";
  const currencyBeforeAmountPattern = "(?:\\b(?:[A-Za-z]{3}|TL)(?=\\s*-?\\d)|€|\\$|£|¥|₩|₹|₺)";
  const matches = [
    ...text.matchAll(new RegExp(`(${numberPattern})\\s*(${currencyAfterAmountPattern})`, "gi"))
  ].map((match) => ({
    amount: localizedPriceAmount(match[1]),
    currency: normalizedCurrencyToken(match[2])
  })).concat([
    ...text.matchAll(new RegExp(`(${currencyBeforeAmountPattern})\\s*(${numberPattern})`, "gi"))
  ].map((match) => ({
    amount: localizedPriceAmount(match[2]),
    currency: normalizedCurrencyToken(match[1])
  }))).filter((price) => price.amount != null && price.currency);
  return matches.filter((price, index, list) => (
    list.findIndex((other) => other.amount === price.amount && other.currency === price.currency) === index
  ));
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
