(function initializeBookingTotalContract(root, factory) {
  const contract = factory();
  if (typeof module === "object" && module.exports) module.exports = contract;
  if (root && typeof root === "object") root.AtwBookingTotalContract = contract;
})(typeof globalThis !== "undefined" ? globalThis : this, function bookingTotalContractFactory() {
  "use strict";

  const FALLBACK_CURRENCY_CODES = Object.freeze(new Set([
    "AED", "ARS", "AUD", "BGN", "BHD", "BRL", "CAD", "CHF", "CLP", "CNY",
    "COP", "CZK", "DKK", "EGP", "EUR", "GBP", "HKD", "HRK", "HUF", "IDR",
    "ILS", "INR", "ISK", "JPY", "KRW", "KWD", "MAD", "MXN", "MYR", "NOK",
    "NZD", "OMR", "PEN", "PHP", "PLN", "QAR", "RON", "RSD", "RUB", "SAR",
    "SEK", "SGD", "THB", "TRY", "TWD", "UAH", "USD", "VND", "ZAR"
  ]));
  const SUPPORTED_CURRENCY_CODES = (() => {
    try {
      const supported = typeof Intl.supportedValuesOf === "function"
        ? Intl.supportedValuesOf("currency")
        : [];
      return new Set([...FALLBACK_CURRENCY_CODES, ...supported.map((code) => String(code).toUpperCase())]);
    } catch (_error) {
      return FALLBACK_CURRENCY_CODES;
    }
  })();

  function normalizedText(value = "") {
    return String(value || "")
      .slice(0, 4000)
      .replace(/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizedCurrencyToken(value = "") {
    const token = String(value || "").trim().toUpperCase();
    const symbols = { "€": "EUR", "$": "USD", "£": "GBP", "¥": "JPY", "₩": "KRW", "₹": "INR", "₺": "TRY" };
    if (symbols[token]) return symbols[token];
    if (token === "TL") return "TRY";
    return SUPPORTED_CURRENCY_CODES.has(token) ? token : "";
  }

  function localizedPriceAmount(value = "") {
    const raw = String(value || "").replace(/[\s'’]/g, "");
    if (!/^-?\d[\d.,]*$/.test(raw)) return null;
    const separator = Math.max(raw.lastIndexOf("."), raw.lastIndexOf(","));
    let normalized = raw;
    if (separator >= 0) {
      const fractionalDigits = raw.length - separator - 1;
      normalized = fractionalDigits >= 1 && fractionalDigits <= 2
        ? `${raw.slice(0, separator).replace(/[.,]/g, "")}.${raw.slice(separator + 1)}`
        : raw.replace(/[.,]/g, "");
    }
    const amount = Number(normalized);
    return Number.isFinite(amount) ? amount : null;
  }

  function structuredPricesFromText(value = "") {
    const normalized = normalizedText(value);
    const numberPattern = "-?(?:\\d{1,3}(?:[\\s'’.,]\\d{3})+(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?)";
    const currencyAfterAmountPattern = "(?:(?:[A-Za-z]{3}|TL)\\b|€|\\$|£|¥|₩|₹|₺)";
    const currencyBeforeAmountPattern = "(?:\\b(?:[A-Za-z]{3}|TL)(?=\\s*-?\\d)|€|\\$|£|¥|₩|₹|₺)";
    const matches = [
      ...normalized.matchAll(new RegExp(`(${numberPattern})\\s*(${currencyAfterAmountPattern})`, "gi"))
    ].map((match) => ({
      amount: localizedPriceAmount(match[1]),
      currency: normalizedCurrencyToken(match[2])
    })).concat([
      ...normalized.matchAll(new RegExp(`(${currencyBeforeAmountPattern})\\s*(${numberPattern})`, "gi"))
    ].map((match) => ({
      amount: localizedPriceAmount(match[2]),
      currency: normalizedCurrencyToken(match[1])
    }))).filter((price) => price.amount != null && price.currency);
    return matches.filter((price, index, list) => (
      list.findIndex((other) => other.amount === price.amount && other.currency === price.currency) === index
    ));
  }

  function bookingTotalCueMatch(value = "") {
    const normalized = normalizedText(value);
    if (/^total\s+duration\b/i.test(normalized)) return null;
    const match = normalized.match(/^(amount to pay|grand total|booking total|trip total|order total|total(?:\s+(?:amount|price)(?:\s+for\s+\d+\s+passengers?)?)?|basket(?:\s+total)?|cart(?:\s+total)?)\b/i);
    if (!match) return null;
    return {
      label: match[1],
      qualification: /^(?:basket|cart)/i.test(match[1])
        ? "checkout_summary_balance"
        : "exact_owned_total"
    };
  }

  function bookingTotalCue(value = "") {
    return bookingTotalCueMatch(value)?.qualification || "";
  }

  function ownedBookingTotalEvidence({ cueText = "", ownerText = "" } = {}) {
    const cue = bookingTotalCueMatch(cueText);
    if (!cue) return null;
    const normalizedCue = normalizedText(cue.label);
    const normalizedOwner = normalizedText(ownerText);
    const cueIndex = normalizedOwner.toLowerCase().indexOf(normalizedCue.toLowerCase());
    if (cueIndex < 0) return null;

    // Ownership is the label/value relationship, not uniqueness across the
    // whole summary container. A basket commonly contains its balance plus
    // child fare prices. Only an immediately adjacent monetary value belongs
    // to the cue; later line-item prices remain unrelated evidence.
    const adjacentValue = normalizedOwner
      .slice(cueIndex + normalizedCue.length)
      .match(/^\s*(?:[:\-–—]\s*)?((?:(?:[A-Za-z]{3}|TL)\s*|[€$£¥₩₹₺]\s*)-?\d[\d\s'’.,]*|-?\d[\d\s'’.,]*\s*(?:(?:[A-Za-z]{3}|TL)\b|[€$£¥₩₹₺]))/i)?.[1] || "";
    const prices = structuredPricesFromText(adjacentValue);
    if (prices.length !== 1) return null;
    return Object.freeze({ ...prices[0], qualification: cue.qualification });
  }

  return Object.freeze({
    normalizedCurrencyToken,
    localizedPriceAmount,
    structuredPricesFromText,
    bookingTotalCue,
    ownedBookingTotalEvidence
  });
});
