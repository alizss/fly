const DATE_COMPONENTS = new Set(["day", "month", "year"]);
const DATE_FORMATS = new Set(["dmy", "mdy", "ymd"]);

function canonicalDateParts(value = "") {
  const match = String(value || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return {
    canonical: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    year: String(year).padStart(4, "0"),
    month: String(month).padStart(2, "0"),
    day: String(day).padStart(2, "0")
  };
}

function normalizeCanonicalDate(value = "") {
  return canonicalDateParts(value)?.canonical || "";
}

function normalizedEvidence(field = {}) {
  const declared = field.dateField && typeof field.dateField === "object" ? field.dateField : {};
  return {
    inputType: String(declared.inputType || field.inputType || field.kind || "").toLowerCase(),
    placeholder: String(declared.placeholder || field.placeholder || ""),
    pattern: String(declared.pattern || field.pattern || ""),
    description: String(declared.description || field.description || field.accessibleDescription || ""),
    label: String(declared.label || field.label || field.accessibleName || ""),
    name: String(declared.name || field.name || ""),
    autocomplete: String(declared.autocomplete || field.autocomplete || "").toLowerCase(),
    locale: String(declared.locale || field.locale || ""),
    options: Array.isArray(declared.options) ? declared.options : (Array.isArray(field.options) ? field.options : []),
    declaredFormat: String(declared.format || "").toLowerCase(),
    declaredComponent: String(declared.component || "").toLowerCase(),
    declaredSeparator: String(declared.separator || "")
  };
}

function explicitComponent(evidence = {}) {
  if (DATE_COMPONENTS.has(evidence.declaredComponent)) return evidence.declaredComponent;
  if (/bday-day/.test(evidence.autocomplete)) return "day";
  if (/bday-month/.test(evidence.autocomplete)) return "month";
  if (/bday-year/.test(evidence.autocomplete)) return "year";
  const hint = `${evidence.label} ${evidence.name} ${evidence.placeholder}`.toLowerCase();
  const hasFullDateTokens = /(dd|day).{0,8}(mm|month).{0,8}(yyyy|year)|(mm|month).{0,8}(dd|day).{0,8}(yyyy|year)|(yyyy|year).{0,8}(mm|month).{0,8}(dd|day)/i.test(hint);
  if (hasFullDateTokens) return "";
  const matches = [
    ["day", /(^|[^a-z])(day|dd)([^a-z]|$)/],
    ["month", /(^|[^a-z])(month|mm)([^a-z]|$)/],
    ["year", /(^|[^a-z])(year|yyyy)([^a-z]|$)/]
  ].filter(([, pattern]) => pattern.test(hint));
  return matches.length === 1 ? matches[0][0] : "";
}

function tokenFormat(hint = "") {
  const normalized = String(hint || "")
    .toLowerCase()
    .replace(/year/g, "yyyy")
    .replace(/month/g, "mm")
    .replace(/day/g, "dd");
  const tokens = [...normalized.matchAll(/yyyy|yy|mm|dd/g)].map((match) => ({ token: match[0], index: match.index }));
  const unique = [];
  for (const item of tokens) {
    const token = item.token.startsWith("y") ? "y" : item.token.startsWith("m") ? "m" : "d";
    if (!unique.some((entry) => entry.token === token)) unique.push({ ...item, token });
  }
  if (unique.length !== 3) return null;
  unique.sort((a, b) => a.index - b.index);
  const format = unique.map((item) => item.token).join("");
  if (!DATE_FORMATS.has(format)) return null;
  const between = normalized.slice(unique[0].index + (unique[0].token === "y" ? 4 : 2), unique[1].index);
  const separator = between.match(/[-/.]/)?.[0] || (normalized.match(/[-/.]/)?.[0] || "-");
  return { format, separator, source: "explicit_format_hint", confidence: 1 };
}

function localeFormat(locale = "") {
  const normalized = String(locale || "").trim();
  if (!/^[a-z]{2,3}[-_][a-z]{2}$/i.test(normalized)) return null;
  try {
    const parts = new Intl.DateTimeFormat(normalized.replace("_", "-"), {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone: "UTC"
    }).formatToParts(new Date(Date.UTC(2003, 10, 22)));
    const format = parts
      .filter((part) => ["day", "month", "year"].includes(part.type))
      .map((part) => part.type[0])
      .join("");
    if (!DATE_FORMATS.has(format)) return null;
    const separator = parts.find((part) => part.type === "literal")?.value?.match(/[-/.]/)?.[0] || "/";
    return { format, separator, source: "explicit_locale", confidence: 0.8 };
  } catch (_) {
    return null;
  }
}

function inferDateFieldCodec(field = {}) {
  const evidence = normalizedEvidence(field);
  if (DATE_FORMATS.has(evidence.declaredFormat)) {
    return {
      ok: true,
      kind: "full",
      format: evidence.declaredFormat,
      separator: evidence.declaredSeparator || (evidence.declaredFormat === "ymd" ? "-" : "/"),
      source: "observed_date_contract",
      confidence: 1
    };
  }
  const component = explicitComponent(evidence);
  if (component) return { ok: true, kind: "component", component, source: "component_semantics", confidence: 1 };
  if (evidence.inputType === "date") {
    return { ok: true, kind: "full", format: "ymd", separator: "-", source: "native_date_input", confidence: 1 };
  }
  const explicit = tokenFormat([
    evidence.placeholder,
    evidence.pattern,
    evidence.description,
    evidence.label,
    evidence.name,
    evidence.autocomplete
  ].filter(Boolean).join(" "));
  if (explicit) return { ok: true, kind: "full", ...explicit };
  const localized = localeFormat(evidence.locale);
  if (localized) return { ok: true, kind: "full", ...localized };
  return {
    ok: false,
    kind: "ambiguous",
    code: "AMBIGUOUS_DATE_FORMAT",
    reason: "The date field does not expose an unambiguous day/month/year order."
  };
}

function optionValueForPart(options = [], part = "", value = "", locale = "") {
  const numeric = String(Number(value));
  const candidates = new Set([String(value), numeric]);
  if (part === "month") {
    const monthIndex = Number(value) - 1;
    for (const style of ["long", "short"]) {
      try {
        candidates.add(new Intl.DateTimeFormat(locale || "en", { month: style, timeZone: "UTC" })
          .format(new Date(Date.UTC(2003, monthIndex, 1))));
      } catch (_) {
        // Numeric matching remains available when locale evidence is invalid.
      }
    }
  }
  const normalized = [...candidates].map((item) => item.toLowerCase().replace(/\.$/, ""));
  const match = (options || []).find((option) => {
    const optionValue = String(option?.value || "").trim().toLowerCase().replace(/\.$/, "");
    const optionLabel = String(option?.label || "").trim().toLowerCase().replace(/\.$/, "");
    return normalized.includes(optionValue) || normalized.includes(optionLabel);
  });
  return match ? String(match.value) : String(value);
}

function encodeDateForField(canonicalValue = "", field = {}) {
  const parts = canonicalDateParts(canonicalValue);
  if (!parts) {
    return { ok: false, code: "INVALID_CANONICAL_DATE", reason: "Saved date must be a real date in YYYY-MM-DD form." };
  }
  const codec = inferDateFieldCodec(field);
  if (!codec.ok) return { ...codec, canonicalValue: parts.canonical };
  if (codec.kind === "component") {
    const rawValue = parts[codec.component];
    const evidence = normalizedEvidence(field);
    const value = optionValueForPart(evidence.options, codec.component, rawValue, evidence.locale);
    return {
      ok: true,
      value,
      canonicalValue: parts.canonical,
      expectedNormalizedValue: rawValue,
      codec
    };
  }
  const ordered = codec.format.split("").map((token) => ({ d: parts.day, m: parts.month, y: parts.year })[token]);
  return {
    ok: true,
    value: ordered.join(codec.separator),
    canonicalValue: parts.canonical,
    expectedNormalizedValue: parts.canonical,
    codec
  };
}

function decodeDateFromField(liveValue = "", codecOrField = {}) {
  const codec = codecOrField?.ok != null || codecOrField?.kind
    ? codecOrField
    : inferDateFieldCodec(codecOrField);
  if (!codec?.ok) return { ok: false, code: codec?.code || "AMBIGUOUS_DATE_FORMAT" };
  const raw = String(liveValue || "").trim();
  if (codec.kind === "component") {
    const digits = raw.match(/\d{1,4}/)?.[0] || "";
    if (!digits) return { ok: false, code: "DATE_COMPONENT_NOT_PARSEABLE" };
    const width = codec.component === "year" ? 4 : 2;
    return { ok: true, component: codec.component, componentValue: digits.padStart(width, "0") };
  }
  const numbers = raw.match(/\d+/g) || [];
  if (numbers.length !== 3) return { ok: false, code: "DATE_VALUE_NOT_PARSEABLE" };
  const values = Object.fromEntries(codec.format.split("").map((token, index) => [token, numbers[index]]));
  const candidate = `${String(values.y || "").padStart(4, "0")}-${String(values.m || "").padStart(2, "0")}-${String(values.d || "").padStart(2, "0")}`;
  const canonical = normalizeCanonicalDate(candidate);
  return canonical ? { ok: true, canonicalValue: canonical } : { ok: false, code: "DATE_VALUE_INVALID" };
}

module.exports = {
  canonicalDateParts,
  normalizeCanonicalDate,
  inferDateFieldCodec,
  encodeDateForField,
  decodeDateFromField
};
