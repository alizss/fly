function currentHref() {
  return globalThis.location?.href || "";
}

const COMMON_COUNTRY_CODE_SECOND_LEVEL_SUFFIXES = new Set([
  "ac",
  "co",
  "com",
  "edu",
  "gov",
  "net",
  "org"
]);

function hostnameFrom(value = "") {
  try {
    return new URL(String(value || ""), currentHref() || undefined).hostname
      .toLowerCase()
      .replace(/^\.+|\.+$/g, "");
  } catch (error) {
    return "";
  }
}

function isIpAddress(hostname = "") {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":");
}

// Navigation ownership needs a site identity, not an origin. This compact
// registrable-site projection covers ordinary domains and the common country-
// code second-level suffixes used by checkout sites. It is conservative:
// treating an uncertain provider as merchant-owned merely delays completion
// until stronger payment-widget evidence appears; the inverse stops too early.
export function registrableSite(value = "") {
  const hostname = hostnameFrom(value);
  if (!hostname || hostname === "localhost" || isIpAddress(hostname)) return hostname;
  const labels = hostname.split(".").filter(Boolean);
  if (labels.length <= 2) return hostname;
  const countryCodeSuffix = labels.at(-1).length === 2
    && COMMON_COUNTRY_CODE_SECOND_LEVEL_SUFFIXES.has(labels.at(-2));
  return labels.slice(countryCodeSuffix ? -3 : -2).join(".");
}

export function sameRegistrableSite(left = "", right = "") {
  const leftSite = registrableSite(left);
  const rightSite = registrableSite(right);
  return Boolean(leftSite && rightSite && leftSite === rightSite);
}

export function sanitizedNavigationUrl(value = currentHref()) {
  try {
    const parsed = new URL(String(value || currentHref()), currentHref() || undefined);
    const rawHash = String(parsed.hash || "").slice(1);
    const cleanHashRoute = rawHash.split("?")[0].slice(0, 500);
    const hashRoute = cleanHashRoute
      && /^\/?[a-z0-9/_-]+$/i.test(cleanHashRoute)
      ? `#${cleanHashRoute}`
      : "";
    return `${parsed.origin}${parsed.pathname}${hashRoute}`;
  } catch (error) {
    return String(value || "").split("?")[0].split("#")[0].slice(0, 1000);
  }
}

export function currentNavigationUrl() {
  return sanitizedNavigationUrl(currentHref());
}
