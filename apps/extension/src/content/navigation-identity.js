function currentHref() {
  return globalThis.location?.href || "";
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
