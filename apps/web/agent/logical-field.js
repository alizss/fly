const {
  normalizeCanonicalDate,
  inferDateFieldCodec,
  decodeDateFromField,
  encodeDateForField
} = require("./date-field-codec");
const agentContract = require("../../extension/src/shared/agent-contract");
const { currentSurface: authoritativeCurrentSurface } = require("./surface-contract");

const PROFILE_FIELDS = new Set(agentContract.PROFILE_FIELD_TYPES);
const DATE_FIELDS = new Set(["date_of_birth", "document_issue_date", "passport_expiry", "document_expiry"]);
const COMPONENT_ORDER = new Map([
  ["value", 0],
  ["international_number", 0],
  ["country_code", 0],
  ["local_number", 1],
  ["day", 0],
  ["month", 1],
  ["year", 2],
  ["option", 0]
]);

const MONTHS = new Map([
  ["january", "01"], ["jan", "01"],
  ["february", "02"], ["feb", "02"],
  ["march", "03"], ["mar", "03"],
  ["april", "04"], ["apr", "04"],
  ["may", "05"],
  ["june", "06"], ["jun", "06"],
  ["july", "07"], ["jul", "07"],
  ["august", "08"], ["aug", "08"],
  ["september", "09"], ["sep", "09"], ["sept", "09"],
  ["october", "10"], ["oct", "10"],
  ["november", "11"], ["nov", "11"],
  ["december", "12"], ["dec", "12"]
]);
const DIAL_CODES = [
  "+386", "+385", "+387", "+381", "+44", "+49", "+43", "+39", "+33", "+34", "+41", "+90", "+1"
].sort((left, right) => right.length - left.length);

function normalizedAlias(value = "") {
  return String(value || "")
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeProfileFieldType(value = "") {
  return agentContract.canonicalProfileFieldType(value);
}

function semanticTypesFromLabel(value = "") {
  const evidence = String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!evidence) return [];
  const matches = [];
  const add = (fieldType) => {
    if (fieldType && !matches.includes(fieldType)) matches.push(fieldType);
  };
  if (/confirm.*e[ -]?mail|repeat.*e[ -]?mail/.test(evidence)) add("confirm_email");
  else if (/(?:^|\s)e[ -]?mail(?:\s|$)/.test(evidence)) add("email");
  if (/(?:^|\s)surname(?:\s|$)|family[ _-]?name|last[ _-]?name/.test(evidence)) add("last_name");
  const combinedGivenNames = /(?:first|given)\s*(?:\/|and|&)\s*middle\s+names?\b|\bgiven names\b|\bforenames\b/.test(evidence);
  if (combinedGivenNames) add("given_names");
  else {
    if (/first[ _-]?name|given[ _-]?name|forename/.test(evidence)) add("first_name");
    if (/middle[ _-]?name/.test(evidence)) add("middle_name");
  }
  if (/second (?:last name|surname)|additional surname|maternal surname/.test(evidence)) add("second_last_name");
  if (/(?:^|\s)(?:date of birth|birth date|dob|bday)(?:\s|$)/.test(evidence)) add("date_of_birth");
  if (/(?:age at (?:the )?time of travel|age (?:at|on) departure|departure age|travel age|passenger age)/.test(evidence)) add("age_at_departure");
  if (/(?:^|\s)(?:place of birth|birth place|birth city)(?:\s|$)/.test(evidence)) add("place_of_birth");
  if (/(?:^|\s)(?:nationality|citizenship|country of citizenship)(?:\s|$)/.test(evidence)) add("nationality");
  if (/country of residence|residence country|resident country/.test(evidence)) add("country_of_residence");
  if (/(?:travel|identity)?\s*document type|passport or id|id type/.test(evidence)) add("document_type");
  if (/passport.*(?:number|no)|(?:number|no).*passport/.test(evidence)) add("passport_number");
  if (/(?:travel|identity)?.*document.*(?:number|no)|(?:number|no).*document/.test(evidence)) add("document_number");
  if (/(?:issuing|issue).*(?:country|nation)|(?:country|nation).*(?:issuing|issue)/.test(evidence)) add("issuing_country");
  if (/(?:passport|document).*(?:issue date|date of issue)|(?:issue date|date of issue).*(?:passport|document)/.test(evidence)) add("document_issue_date");
  if (/passport.*(?:expiry|expiration)|(?:expiry|expiration).*passport/.test(evidence)) add("passport_expiry");
  if (/document.*(?:expiry|expiration)|(?:expiry|expiration).*document/.test(evidence)) add("document_expiry");
  if (/frequent[ -]?flyer.*(?:program|programme|airline)|loyalty program/.test(evidence)) add("frequent_flyer_program");
  if (/frequent[ -]?flyer.*(?:number|no)|loyalty (?:number|no)|membership (?:number|no)/.test(evidence)) add("frequent_flyer_number");
  if (/known travell?er (?:number|no)|\bktn\b/.test(evidence)) add("known_traveler_number");
  if (/redress (?:control )?(?:number|no)/.test(evidence)) add("redress_number");
  if (/(?:emergency|sos)(?: contact)?.*name|name.*(?:emergency|sos)(?: contact)?/.test(evidence)) add("emergency_contact_name");
  if (/emergency contact.*relationship|relationship.*emergency contact/.test(evidence)) add("emergency_contact_relationship");
  if (/(?:emergency|sos)(?: contact)?.*(?:phone|mobile|telephone)|(?:phone|mobile|telephone).*(?:emergency|sos)(?: contact)?/.test(evidence)) add("emergency_contact_phone");
  if (/emergency contact.*e[ -]?mail|e[ -]?mail.*emergency contact/.test(evidence)) add("emergency_contact_email");
  if (/meal preference|special meal|meal request/.test(evidence)) add("meal_preference");
  if (/special assistance|assistance request|accessibility request/.test(evidence)) add("special_assistance");
  if (/purpose of (?:the )?(?:trip|travel|journey)|(?:trip|travel|journey) purpose|reason for (?:the )?(?:trip|travel|journey)|business or leisure|travell?ing for (?:business|leisure)/.test(evidence)) add("travel_purpose");
  if (/(?:^|\s)(?:title|salutation|honorific)(?:\s|$)/.test(evidence)) add("title");
  if (/(?:^|\s)(?:gender|sex)(?:\s|$)/.test(evidence)) add("gender");
  if (/(?:^|\s)(?:country|dial|calling)[ _-]?code(?:\s|$)/.test(evidence)) add("phone_country_code");
  if (/(?:^|\s)(?:phone|telephone|mobile)(?:\s|$)/.test(evidence)
    && !/(?:plan|bundle|package|insurance|addon|add on|emergency|sos)/.test(evidence)) {
    add(/country.*code|dial.*code|calling.*code/.test(evidence) ? "phone_country_code" : "phone");
  }
  return matches;
}

function supportsProfileLabelInference(control = {}, field = {}) {
  const roleEvidence = [
    control.role,
    control.kind,
    control.type,
    field.role,
    field.kind,
    field.type
  ].filter(Boolean).join(" ").toLowerCase();
  const operationEvidence = [
    ...Object.keys(control.operations || {}),
    ...Object.keys(field.operations || {}),
    ...(Array.isArray(control.capabilities) ? control.capabilities : []),
    ...(Array.isArray(field.capabilities) ? field.capabilities : [])
  ].join(" ").toLowerCase();
  if (/textbox|input|textarea|select|combobox|listbox|option|radio|checkbox|spinbutton|date/.test(roleEvidence)) {
    return true;
  }
  if (/type|fill|input|set[_ -]?value|select|choose|toggle|check/.test(operationEvidence)) {
    return true;
  }
  // A command can mention profile concepts in its accessible description,
  // but an activation-only actuator cannot own a traveler value.
  if (/button|link/.test(roleEvidence) || /(?:^|\s)activate(?:\s|$)/.test(operationEvidence)) {
    return false;
  }
  return true;
}

function semanticTypeForControl(control = {}, field = {}) {
  if (
    control.fieldClassification?.source === "direct_non_profile_control"
    || field.fieldClassification?.source === "direct_non_profile_control"
  ) {
    return "";
  }
  const explicitEvidence = [
    control.accessibleName,
    control.ariaLabel,
    control.label,
    control.placeholder,
    field.label,
    field.placeholder,
    field.accessibleName
  ].filter(Boolean).join(" ");
  const explicitTypes = semanticTypesFromLabel(explicitEvidence);
  const declaredTypes = [
    control.fieldClassification?.fieldType,
    field.fieldClassification?.fieldType,
    control.fieldType,
    control.field,
    field.fieldType,
    field.field,
    control.name,
    field.name
  ].map(normalizeProfileFieldType).filter(Boolean);
  if (
    explicitTypes.length === 1
    && explicitTypes[0] === "given_names"
    && declaredTypes.every((candidate) => ["first_name", "given_names"].includes(candidate))
  ) {
    return "given_names";
  }
  const declaredCountry = [
    control.fieldClassification?.fieldType,
    field.fieldClassification?.fieldType,
    control.fieldType,
    control.field,
    field.fieldType,
    field.field,
    control.name,
    field.name
  ].map(normalizeProfileFieldType).includes("country");
  if (declaredCountry && explicitTypes.length === 1 && explicitTypes[0] === "phone_country_code") {
    return "phone_country_code";
  }
  const classified = [
    control.fieldClassification?.fieldType,
    field.fieldClassification?.fieldType
  ].map(normalizeProfileFieldType).filter(Boolean);
  if (classified.length === 1) return classified[0];
  if (new Set(classified).size > 1) return "";

  const raw = [
    control.fieldType,
    control.field,
    field.fieldType,
    field.field,
    control.name,
    control.autocomplete,
    field.name,
    field.autocomplete
  ].map(normalizeProfileFieldType).filter(Boolean);
  const rawTypes = [...new Set(raw)];
  if (rawTypes.length === 1) return rawTypes[0];
  if (rawTypes.length > 1) return "";

  if (explicitTypes.length === 1 && supportsProfileLabelInference(control, field)) return explicitTypes[0];
  if (explicitTypes.length > 1) return "";

  // Broad fieldset/group text is observation context, not semantic ownership.
  // Composite ownership must already be present in the observer's explicit
  // classification or in the control's own attributes/label.
  return "";
}

function subjectForControl(control = {}, field = {}) {
  const evidence = [
    control.name,
    control.stableKey,
    control.semanticIdentity,
    field.name,
    field.id,
    control.sectionLabel,
    field.sectionLabel
  ].filter(Boolean).join(" ");
  const machineMatch = evidence.match(/(?:passengers?|travell?ers?|adults?)[.\[_-]*(\d+)/i);
  if (machineMatch) {
    const index = Math.max(0, Number(machineMatch[1]));
    return { type: "traveler", id: `traveler_${index + 1}`, index };
  }
  const humanMatch = evidence.match(/(?:passenger|travell?er|adult)[ _-]*(\d+)/i);
  if (humanMatch) {
    const index = Math.max(0, Number(humanMatch[1]) - 1);
    return { type: "traveler", id: `traveler_${index + 1}`, index };
  }
  return { type: "traveler", id: "traveler_1", index: 0 };
}

function travelerForSubject(profile = {}, subject = {}) {
  const travelers = Array.isArray(profile.travelers)
    ? profile.travelers
    : Array.isArray(profile.passengers)
      ? profile.passengers
      : null;
  return travelers?.[Number(subject.index || 0)] || profile.traveler || profile;
}

function normalizedTitle(value = "") {
  const text = String(value || "").trim().toLowerCase();
  if (/^(mr|mister|male|man)$/.test(text)) return "mr";
  if (/^(mrs|ms|miss|mrs\/ms|female|woman)$/.test(text)) return "mrs/ms";
  return text;
}

function canonicalValue(semanticType = "", value = "") {
  const type = normalizeProfileFieldType(semanticType) || semanticType;
  const text = String(value || "").trim();
  if (!text) return "";
  if (DATE_FIELDS.has(type)) return normalizeCanonicalDate(text);
  if (["title", "gender"].includes(type)) return normalizedTitle(text);
  if (type === "age_at_departure") {
    const exactAge = text.match(/^\D*(\d{1,3})\s*(?:years?|yrs?)?\D*$/i)?.[1] || "";
    const age = Number(exactAge);
    return exactAge && Number.isInteger(age) && age >= 0 && age <= 130 ? String(age) : "";
  }
  if (type === "phone_country_code") {
    const digits = text.replace(/\D/g, "");
    return digits ? `+${digits}` : "";
  }
  if (type === "phone") return text.replace(/\D/g, "").replace(/^0+/, "");
  if (["passport_number", "document_number"].includes(type)) {
    return text.replace(/\s+/g, "").toUpperCase();
  }
  return text.toLowerCase().replace(/\s+/g, " ");
}

function canonicalDepartureDate(value = "") {
  const canonical = normalizeCanonicalDate(value);
  if (canonical) return canonical;
  const parsed = new Date(String(value || ""));
  if (Number.isNaN(parsed.getTime())) return "";
  const year = parsed.getUTCFullYear();
  const month = String(parsed.getUTCMonth() + 1).padStart(2, "0");
  const day = String(parsed.getUTCDate()).padStart(2, "0");
  return normalizeCanonicalDate(`${year}-${month}-${day}`);
}

function ageOnDate(dateOfBirth = "", departureDate = "") {
  const birth = normalizeCanonicalDate(dateOfBirth);
  const departure = canonicalDepartureDate(departureDate);
  if (!birth || !departure || departure < birth) return null;
  const [birthYear, birthMonth, birthDay] = birth.split("-").map(Number);
  const [departureYear, departureMonth, departureDay] = departure.split("-").map(Number);
  let age = departureYear - birthYear;
  if (departureMonth < birthMonth || (departureMonth === birthMonth && departureDay < birthDay)) age -= 1;
  return Number.isInteger(age) && age >= 0 && age <= 130 ? age : null;
}

function departureDatesFromContext(context = {}) {
  const page = context.page || context.observation?.page || context;
  // There is one authority for trip-dependent profile facts: the immutable
  // selected-booking baseline. Current-page fragments and review totals may
  // describe ancillary or abbreviated facts and must never be reinterpreted
  // as the trip selected by the user.
  const selectedBooking = context.selectedBooking
    || context.transactionReview?.baseline
    || page?.selectedBooking
    || null;
  return [...new Set([selectedBooking].filter(Boolean).flatMap((source) => (
    source?.itinerary?.segments || source?.segments || []
  )).map((segment) => canonicalDepartureDate(
    segment?.departureDate || segment?.departure_date || segment?.date || ""
  )).filter(Boolean))].sort();
}

function missingDerivedFactDependency(semanticType = "", traveler = {}, context = {}) {
  if (normalizeProfileFieldType(semanticType) !== "age_at_departure") return null;
  if (!normalizeCanonicalDate(traveler.date_of_birth || "")) return null;
  if (departureDatesFromContext(context).length) return null;
  return Object.freeze({
    semanticType: "age_at_departure",
    reasonCode: "SELECTED_BOOKING_FACT_MISSING",
    sourceField: "departure_date",
    sourcePath: "selected_booking.departure_date",
    label: "selected flight departure date"
  });
}

function derivedTravelerFacts(traveler = {}, context = {}) {
  const explicitAge = canonicalValue(
    "age_at_departure",
    traveler.derived_facts?.age_at_departure || traveler.age_at_departure || ""
  );
  const departureDate = departureDatesFromContext(context)[0] || "";
  const calculatedAge = explicitAge || String(ageOnDate(traveler.date_of_birth, departureDate) ?? "");
  return Object.freeze({
    age_at_departure: calculatedAge ? Object.freeze({
      semanticType: "age_at_departure",
      value: calculatedAge,
      source: explicitAge ? "profile.age_at_departure" : "derived_fact.age_at_departure",
      inputs: explicitAge ? Object.freeze([]) : Object.freeze(["profile.date_of_birth", "selected_booking.departure_date"]),
      departureDate
    }) : null
  });
}

function desiredProfileInputValue(semanticType = "", traveler = {}, context = {}) {
  const type = normalizeProfileFieldType(semanticType) || semanticType;
  const document = traveler.document || {};
  const address = traveler.address || {};
  const title = traveler.title || traveler.salutation || traveler.gender || "";
  const rawPhone = String(traveler.phone || traveler.mobile || "");
  const phoneDigits = rawPhone.replace(/\D/g, "");
  const explicitCodeDigits = String(
    traveler.phone_country_code || traveler.country_code || traveler.dial_code || ""
  ).replace(/\D/g, "");
  const inferredCode = explicitCodeDigits
    ? `+${explicitCodeDigits}`
    : rawPhone.startsWith("+")
      ? DIAL_CODES.find((code) => phoneDigits.startsWith(code.slice(1))) || ""
      : "";
  const codeDigits = inferredCode.replace(/\D/g, "");
  const localPhone = String(
    traveler.phone_local_number
      || traveler.local_phone_number
      || (
        codeDigits && phoneDigits.startsWith(codeDigits)
          ? phoneDigits.slice(codeDigits.length)
          : phoneDigits
      )
  ).replace(/\D/g, "").replace(/^0+/, "");
  const values = {
    title,
    gender: traveler.gender,
    first_name: traveler.first_name,
    given_names: traveler.given_names || [traveler.first_name, traveler.middle_name].filter(Boolean).join(" "),
    middle_name: traveler.middle_name,
    last_name: traveler.last_name,
    second_last_name: traveler.second_last_name,
    full_name: [traveler.first_name, traveler.middle_name, traveler.last_name, traveler.second_last_name].filter(Boolean).join(" "),
    email: traveler.email,
    confirm_email: traveler.email,
    phone_country_code: inferredCode,
    phone: localPhone,
    date_of_birth: traveler.date_of_birth,
    age_at_departure: derivedTravelerFacts(traveler, context).age_at_departure?.value || "",
    place_of_birth: traveler.place_of_birth,
    nationality: traveler.nationality,
    country_of_residence: traveler.country_of_residence || address.country || traveler.country,
    document_type: document.document_type,
    passport_number: document.document_number || (document.has_document_number ? "profile://document_number" : ""),
    document_number: document.document_number || (document.has_document_number ? "profile://document_number" : ""),
    issuing_country: document.issuing_country,
    document_issue_date: document.issue_date,
    address_line1: address.line1 || traveler.address_line1 || traveler.billing_address,
    address_line2: address.line2 || traveler.address_line2,
    city: address.city || traveler.city || traveler.billing_city,
    state: address.state || address.province || traveler.state || traveler.province,
    postal_code: address.postal_code || address.postcode || traveler.postal_code || traveler.billing_postal_code,
    country: address.country || traveler.address_country || traveler.country || traveler.nationality,
    passport_expiry: document.expiry_date,
    document_expiry: document.expiry_date,
    frequent_flyer_program: traveler.frequent_flyer_program,
    frequent_flyer_number: traveler.frequent_flyer_number,
    known_traveler_number: traveler.known_traveler_number,
    redress_number: traveler.redress_number,
    emergency_contact_name: traveler.emergency_contact_name,
    emergency_contact_relationship: traveler.emergency_contact_relationship,
    emergency_contact_phone: traveler.emergency_contact_phone,
    emergency_contact_email: traveler.emergency_contact_email,
    meal_preference: traveler.meal_preference,
    special_assistance: traveler.special_assistance,
    travel_purpose: traveler.travel_purpose
  };
  return String(values[type] || "");
}

function desiredProfileValue(semanticType = "", traveler = {}, context = {}) {
  const type = normalizeProfileFieldType(semanticType) || semanticType;
  return canonicalValue(type, desiredProfileInputValue(type, traveler, context));
}

function dateComponentRole(control = {}, field = {}) {
  const declared = String(
    control.dateField?.component
      || field.dateField?.component
      || control.state?.dateComponent
      || ""
  ).toLowerCase();
  if (["day", "month", "year"].includes(declared)) return declared;
  const evidence = normalizedAlias([
    control.autocomplete,
    control.name,
    control.id,
    control.placeholder,
    field.autocomplete,
    field.name,
    field.id,
    field.placeholder
  ].filter(Boolean).join(" "));
  const fullDateContract = (
    /(?:^|_)(?:day|dd)(?:_|$)/.test(evidence)
    && /(?:^|_)(?:month|mm)(?:_|$)/.test(evidence)
    && /(?:^|_)(?:year|yyyy|yy)(?:_|$)/.test(evidence)
  );
  if (fullDateContract) return "value";
  if (/(?:^|_)(?:day|dd)(?:_|$)/.test(evidence)) return "day";
  if (/(?:^|_)(?:month|mm)(?:_|$)/.test(evidence)) return "month";
  if (/(?:^|_)(?:year|yyyy|yy)(?:_|$)/.test(evidence)) return "year";
  return "value";
}

function componentRole(control = {}, field = {}, semanticType = "") {
  if (DATE_FIELDS.has(semanticType)) return dateComponentRole(control, field);
  if (semanticType === "phone_country_code") return "country_code";
  if (semanticType === "phone") {
    const codec = control.phoneField || field.phoneField || agentContract.inferPhoneFieldCodec({
      semanticType,
      label: control.label || field.label || "",
      name: control.name || field.name || "",
      placeholder: control.placeholder || field.placeholder || "",
      pattern: control.pattern || field.pattern || "",
      autocomplete: control.autocomplete || field.autocomplete || "",
      inputMode: control.inputMode || field.inputMode || "",
      accessibleDescription: control.accessibleDescription || field.accessibleDescription || field.description || ""
    });
    return codec.representation === "combined_international" ? "international_number" : "local_number";
  }
  if (/radio|checkbox|option|choice/.test(String(control.role || control.kind || field.kind || "").toLowerCase())) {
    return "option";
  }
  return "value";
}

function monthComponent(value = "") {
  const normalized = String(value || "").trim().toLowerCase().replace(/\.$/, "");
  if (MONTHS.has(normalized)) return MONTHS.get(normalized);
  const digits = normalized.match(/\d{1,2}/)?.[0] || "";
  const month = Number(digits);
  return month >= 1 && month <= 12 ? String(month).padStart(2, "0") : "";
}

function dateComponentValue(role = "", value = "") {
  if (role === "month") return monthComponent(value);
  const digits = String(value || "").match(/\d{1,4}/)?.[0] || "";
  if (!digits) return "";
  return digits.padStart(role === "year" ? 4 : 2, "0");
}

function rawControlValue(control = {}) {
  const state = control.state || control.controlState || {};
  return String(
    state.canonicalDateValue
      || state.dateComponentValue
      || state.selectedValue
      || state.optionValue
      || state.normalizedValue
      || state.valueText
      || control.currentValue
      || control.value
      || ""
  );
}

function ageOptionContains(value = "", desiredAge = "") {
  return agentContract.profileChoiceValueCompatible(value, desiredAge, "age_at_departure");
}

function currentComponentValue(semanticType = "", role = "", control = {}, field = {}, desiredValue = "") {
  if (role === "option"
    && !(control.selected || control.state?.selected || control.state?.checked)) {
    return "";
  }
  const raw = rawControlValue(control);
  if (semanticType === "phone" && role === "international_number") {
    const digits = String(raw || "").replace(/\D/g, "");
    return digits ? `+${digits}` : "";
  }
  if (semanticType === "age_at_departure" && desiredValue) {
    const options = [...(control.options || []), ...(field.options || [])];
    const selectedOption = options.find((option) => (
      String(option?.value || "") === raw || String(option?.label || "") === raw
    ));
    const evidence = [raw, selectedOption?.value, selectedOption?.label].filter(Boolean);
    if (evidence.some((value) => ageOptionContains(value, desiredValue))) return String(desiredValue);
  }
  if (DATE_FIELDS.has(semanticType)) {
    if (role !== "value") return dateComponentValue(role, raw);
    const canonical = control.state?.canonicalDateValue || normalizeCanonicalDate(raw);
    if (canonical) return canonical;
    const codec = inferDateFieldCodec({ ...field, dateField: control.dateField || field.dateField });
    const decoded = codec.ok ? decodeDateFromField(raw, codec) : null;
    return decoded?.canonicalValue || "";
  }
  return canonicalValue(semanticType, raw);
}

function desiredComponentValue(semanticType = "", role = "", desired = "") {
  if (!desired) return "";
  if (DATE_FIELDS.has(semanticType) && role !== "value") {
    const [year, month, day] = desired.split("-");
    return { year, month, day }[role] || "";
  }
  return desired;
}

function validationIssueContradictedByFreshOwner(issue = {}, control = {}) {
  if (!issue?.controlId || issue.controlId !== control.controlId) return false;
  const state = control.state || control.controlState || {};
  const presenceOnly = /\b(?:empty|required|missing|fill|enter|provide)\b/i.test(
    String(issue.message || issue.text || issue.label || "")
  );
  return Boolean(
    presenceOnly
    && state.valuePresent === true
    && state.invalid !== true
    && !String(state.validationMessage || "").trim()
  );
}

function relevantComponentIssues(page = {}, control = {}, logicalFieldId = "", role = "") {
  const observed = (page.validationIssues || []).filter((issue) => {
    const owned = Boolean(control.controlId && issue.controlId === control.controlId)
      || Boolean(
        logicalFieldId
        && issue.logicalFieldId === logicalFieldId
        && issue.componentRole
        && issue.componentRole === role
      );
    return owned && !validationIssueContradictedByFreshOwner(issue, control);
  });
  const state = control.state || control.controlState || {};
  if (state.invalid === true && !observed.some((issue) => issue.controlId === control.controlId)) {
    observed.push({
      issueId: `native-invalid:${control.controlId || logicalFieldId}`,
      message: String(state.validationMessage || "The current field value is invalid."),
      controlId: control.controlId || "",
      logicalFieldId,
      componentRole: role,
      semanticType: control.fieldType || control.semantic || "",
      source: "native_invalid_state"
    });
  }
  return observed;
}

function relevantLogicalIssues(page = {}, logicalFieldId = "", controlIds = new Set(), ownerKey = "") {
  return (page.validationIssues || []).filter((issue) => {
    const owned = Boolean(logicalFieldId && issue.logicalFieldId === logicalFieldId && !issue.componentRole)
      || Boolean(ownerKey && issue.logicalOwnerKey === ownerKey && !issue.componentRole)
      || Boolean(issue.controlId && controlIds.has(issue.controlId));
    if (!owned) return false;
    const control = issue.controlId
      ? (page.controls || []).find((candidate) => candidate.controlId === issue.controlId) || {}
      : {};
    return !validationIssueContradictedByFreshOwner(issue, control);
  });
}

function semanticMachineOwner(control = {}, field = {}, semanticType = "") {
  const machine = normalizedAlias(control.name || field.name || control.autocomplete || field.autocomplete || "");
  if (!machine) return "";
  const withoutComponent = DATE_FIELDS.has(semanticType)
    ? machine.replace(/_(?:day|month|year)$/, "")
    : semanticType === "phone"
      ? machine.replace(/_(?:country(?:_(?:code|dial_code))?|dial_code|local(?:_(?:number|phone))?|national|number)$/, "")
      : machine;
  return withoutComponent || machine;
}

function logicalOwner(control = {}, field = {}, semanticType = "") {
  const explicit = control.logicalFieldId
    || field.logicalFieldId
    || control.fieldOwnerId
    || field.fieldOwnerId;
  if (explicit) return String(explicit);
  const sectionType = String(control.sectionType || field.sectionType || "").toLowerCase();
  const sectionId = control.sectionId || field.sectionId || "";
  // Phone country code and national number often use unrelated machine names
  // but share one bounded contact owner. Prefer that composite owner before a
  // component-local name so both pieces compile into one logical phone.
  if (semanticType === "phone" && sectionId && /contact|phone/.test(`${sectionType} ${sectionId}`)) {
    return `contact-phone:${sectionId}`;
  }
  // Machine identity is more durable than a generated DOM/group id. It
  // survives value entry, validation, dropdown state, and React recreation.
  const machineOwner = semanticMachineOwner(control, field, semanticType);
  if (machineOwner) return machineOwner;
  const tightOwnerKey = control.tightOwnerKey
    || field.tightOwnerKey
    || control.fieldClassification?.tightOwnerKey
    || field.fieldClassification?.tightOwnerKey
    || "";
  if (tightOwnerKey) return String(tightOwnerKey);
  // A logical requirement must outlive the DOM node that currently renders it.
  // Physical ids, placeholders and current values are therefore never identity
  // fallbacks. One canonical profile fact per traveler is the durable owner when
  // the page exposes no tighter machine or structural ownership evidence.
  return `profile-fact:${semanticType || "unknown"}`;
}

function representationIdentity(control = {}, field = {}) {
  return String(
    control.componentContract?.componentIdentity
    || control.componentIdentity
    || field.componentIdentity
    || control.componentContract?.logicalIdentity
    || control.logicalIdentity
    || field.logicalIdentity
    || ""
  ).trim();
}

function mechanicalOperationsForControl(control = {}) {
  const serializedOperations = Object.keys(control.operations || {});
  return [...new Set([
    ...operationsFor(control),
    ...Object.entries(control.recovery || {}).filter(([, value]) => Boolean(value)).map(([operation]) => operation),
    ...(serializedOperations.length
      ? []
      : (control.componentContract?.capabilities || []).map((capability) => capability.operation).filter(Boolean))
  ])];
}

function representationIsStateOnly(control = {}) {
  const operations = mechanicalOperationsForControl(control);
  const stableKey = String(control.stableKey || "").toLowerCase();
  const box = control.visualRegion || control.box || {};
  const hasArea = Number(box.width) > 0 && Number(box.height) > 0;
  const hasRecoveryMechanic = Object.values(control.recovery || {}).some(Boolean)
    || (!Object.keys(control.operations || {}).length && (control.componentContract?.capabilities || []).some((capability) => (
      capability.status !== agentContract.CAPABILITY_STATUS.UNAVAILABLE
    )));
  const mechanicallyInert = operations.length === 0
    || control.state?.disabled === true
    || control.disabled === true
    || Object.values(control.operations || {}).filter(Boolean).every((capability) => (
      capability.status === agentContract.CAPABILITY_STATUS.UNAVAILABLE
      || capability.actionability?.executable === false
    ));
  return mechanicallyInert && (
    /type:hidden/.test(stableKey)
    || control.hidden === true
    || control.accessibility?.hidden === true
    || !hasArea
    || !hasRecoveryMechanic
  );
}

function representationsCanShareComponent(existing = {}, incoming = {}) {
  if (existing.role !== incoming.role) return false;
  const leftIdentity = representationIdentity(existing.control, existing.field);
  const rightIdentity = representationIdentity(incoming.control, incoming.field);
  if (!leftIdentity || leftIdentity !== rightIdentity) return false;
  const leftSection = String(existing.control.sectionId || existing.field.sectionId || "");
  const rightSection = String(incoming.control.sectionId || incoming.field.sectionId || "");
  if (leftSection && rightSection && leftSection !== rightSection) return false;
  const leftStateOnly = representationIsStateOnly(existing.control);
  const rightStateOnly = representationIsStateOnly(incoming.control);
  const leftInteractive = mechanicalOperationsForControl(existing.control).length > 0 && !leftStateOnly;
  const rightInteractive = mechanicalOperationsForControl(incoming.control).length > 0 && !rightStateOnly;
  return (leftStateOnly && rightInteractive) || (rightStateOnly && leftInteractive);
}

function operationsFor(control = {}) {
  return Object.entries(control.operations || {})
    .filter(([, capability]) => Boolean(capability))
    .map(([operation]) => operation);
}

function decodeLogicalValue(semanticType = "", components = []) {
  if (DATE_FIELDS.has(semanticType)) {
    const full = components.find((component) => component.role === "value");
    if (full?.currentValue) return normalizeCanonicalDate(full.currentValue);
    const parts = Object.fromEntries(components
      .filter((component) => ["day", "month", "year"].includes(component.role))
      .map((component) => [component.role, component.currentValue]));
    if (parts.day && parts.month && parts.year) {
      return normalizeCanonicalDate(`${parts.year}-${parts.month}-${parts.day}`);
    }
    return "";
  }
  if (semanticType === "phone") {
    const international = components.find((component) => component.role === "international_number")?.currentValue || "";
    if (international) return international;
    const country = components.find((component) => component.role === "country_code")?.currentValue || "";
    const local = components.find((component) => component.role === "local_number")?.currentValue || "";
    if (country && local) return `${country}${local}`;
    return country || local;
  }
  const selected = components.find((component) => (
    component.control.selected
    || component.control.state?.selected
    || component.control.state?.checked
  ));
  return selected?.currentValue
    || components.find((component) => component.currentValue)?.currentValue
    || "";
}

function instructionsForMembers(members = []) {
  return [...new Set(members.flatMap(({ control, field }) => [
    field.description,
    field.helperText,
    field.accessibleDescription,
    control.description,
    control.helperText,
    control.accessibleDescription
  ]).map((value) => String(value || "").replace(/\s+/g, " ").trim()).filter(Boolean))];
}

function optionsForMembers(members = []) {
  return members.flatMap(({ control, field, role }) => [
    ...(Array.isArray(control.options) ? control.options : []),
    ...(Array.isArray(control.dateField?.options) ? control.dateField.options : []),
    ...(Array.isArray(field.options) ? field.options : [])
  ].map((option) => ({
    componentRole: role,
    value: String(option?.value ?? ""),
    label: String(option?.label ?? option?.text ?? option?.value ?? "")
  }))).filter((option, index, list) => (
    list.findIndex((candidate) => (
      candidate.componentRole === option.componentRole
      && candidate.value === option.value
      && candidate.label === option.label
    )) === index
  ));
}

function canonicalOptionMatch(semanticType = "", role = "", desiredValue = "", option = {}) {
  const raw = [option.value, option.label].map((value) => String(value || "").trim()).filter(Boolean);
  if (DATE_FIELDS.has(semanticType) && role !== "value") {
    return raw.some((value) => dateComponentValue(role, value) === desiredValue);
  }
  if (semanticType === "age_at_departure") {
    return raw.some((value) => ageOptionContains(value, desiredValue));
  }
  return raw.some((value) => canonicalValue(semanticType, value) === desiredValue);
}

function exactObservedOptionContract({
  semanticType = "",
  role = "value",
  desiredValue = "",
  controlId = "",
  options = []
} = {}) {
  if (!desiredValue || !Array.isArray(options) || !options.length) return null;
  const matches = options
    .filter((option) => canonicalOptionMatch(semanticType, role, desiredValue, option))
    .filter((option, index, list) => list.findIndex((candidate) => (
      String(candidate.value || "") === String(option.value || "")
      && String(candidate.label || "") === String(option.label || "")
    )) === index);
  if (matches.length !== 1) return null;
  const option = matches[0];
  const siteValue = String(option.value || "").trim();
  const label = String(option.label || option.value || "").replace(/\s+/g, " ").trim();
  if (!siteValue && !label) return null;
  return Object.freeze({
    canonicalValue: String(desiredValue),
    siteValue,
    label,
    controlId: String(controlId || ""),
    source: "observed_unique_option"
  });
}

function executableComponentValue({
  semanticType = "",
  role = "value",
  desiredValue = "",
  desiredInputValue = "",
  desiredCanonicalValue = "",
  control = {},
  field = {}
} = {}) {
  if (!desiredValue) return "";
  const options = [
    ...(control.options || []),
    ...(control.dateField?.options || []),
    ...(field.options || [])
  ];
  const matching = options.find((option) => canonicalOptionMatch(
    semanticType,
    role,
    desiredValue,
    option
  ));
  if (matching) return String(matching.value || matching.label || desiredValue);
  if (DATE_FIELDS.has(semanticType) && role === "value") {
    const encoded = encodeDateForField(desiredCanonicalValue, {
      ...field,
      dateField: control.dateField || field.dateField
    });
    return encoded.ok ? encoded.value : "";
  }
  return desiredInputValue || desiredValue;
}

function componentSelectionTerms(semanticType = "", role = "value", desiredValue = "", inputValue = "", options = []) {
  const terms = [desiredValue, inputValue];
  for (const option of options || []) {
    if (canonicalOptionMatch(semanticType, role, desiredValue, option)) {
      terms.push(option.value, option.label);
    }
  }
  if (["title", "gender"].includes(semanticType)) {
    if (desiredValue === "mr") terms.push("mr", "mister", "male");
    if (desiredValue === "mrs/ms") terms.push("mrs", "ms", "miss", "female");
  }
  if (semanticType === "phone_country_code") {
    terms.push(String(desiredValue || "").replace(/\D/g, ""));
  }
  return [...new Set(terms
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean))];
}

function optionMatchScore(control = {}, terms = [], surface = {}) {
  if (!control?.controlId) return 0;
  if (surface?.id && control.surfaceId && surface.id !== control.surfaceId) return 0;
  const role = String(control.role || control.kind || "").toLowerCase();
  if (!/option|radio|checkbox|button/.test(role)) return 0;
  const label = canonicalValue("", control.label || control.accessibleName || "");
  if (!label) return 0;
  let score = 0;
  for (const rawTerm of terms || []) {
    const term = canonicalValue("", rawTerm);
    if (!term) continue;
    if (label === term) score += 100;
    else if (` ${label} `.includes(` ${term} `)) score += 70;
    else if (term.length >= 3 && label.includes(term)) score += term.startsWith("+") ? 60 : 25;
  }
  if (control.risk === "money" || /paid|accept_paid|add_to/.test(String(control.semantic || ""))) score -= 100;
  if (control.state?.disabled) score -= 100;
  return score;
}

function bindResolvedComponentToCurrentPage(page = {}, resolved = {}) {
  const terms = resolved.selectionTerms || [];
  if (!terms.length) return null;
  const surface = authoritativeCurrentSurface(page);
  if (!surface || surface.type === "page") return null;
  const ranked = (page.controls || [])
    .map((control) => ({ control, score: optionMatchScore(control, terms, surface) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score);
  if (!ranked.length || (ranked[1] && ranked[0].score === ranked[1].score)) return null;

  const control = ranked[0].control;
  const observedContract = agentContract.observedComponentContract(control, {
    surfaceId: control.surfaceId || surface.id || ""
  });
  const expectedOutcome = Object.freeze({
    ...(resolved.expectedOutcome || {}),
    type: "logical_component_committed",
    controlId: resolved.componentBinding?.controlId || resolved.controlId || "",
    expectedNormalizedValue: resolved.desiredValue || resolved.desiredCanonicalValue || "",
    expectedCanonicalValue: resolved.requirementContract?.desiredCanonicalValue
      || resolved.expectedOutcome?.expectedCanonicalValue
      || "",
    previousSurfaceId: surface.id || "",
    surfaceId: surface.id || "",
    surfaceType: surface.type || "",
    surfaceLabel: surface.label || "",
    requireSurfaceDismissed: true
  });
  const capabilityContracts = Object.freeze((observedContract.capabilities || []).map((capability) => Object.freeze({
    ...capability,
    expectedOutcome
  })));
  const component = {
    ...(resolved.componentBinding || {}),
    controlId: control.controlId,
    controlRole: control.role || control.kind || "option",
    observedOptions: observedContract.observedOptions
  };
  return Object.freeze({
    control,
    goalControlId: resolved.componentBinding?.controlId || resolved.controlId || "",
    requirementContract: resolved.requirementContract || null,
    componentBinding: Object.freeze(component),
    capabilityContracts,
    expectedOutcome,
    validationOwnership: resolved.validationOwnership || null,
    observedOption: true,
    selectionTerms: Object.freeze([...terms]),
    inputValue: resolved.inputValue || resolved.desiredValue || "",
    pipelineBinding: Object.freeze(agentContract.canonicalPipelineContract({
      requirement: resolved.requirementContract || {},
      component,
      capability: {},
      expectedOutcome,
      validationOwnership: resolved.validationOwnership || {}
    }))
  });
}

function expectedOutcomeForComponent({
  semanticType = "",
  logicalFieldId = "",
  subjectId = "",
  role = "value",
  controlId = "",
  desiredValue = "",
  desiredCanonicalValue = "",
  validationOwnership = {},
  control = {},
  field = {}
} = {}) {
  const dateCodec = DATE_FIELDS.has(semanticType)
    ? inferDateFieldCodec({ ...field, dateField: control.dateField || field.dateField })
    : null;
  const interactionKind = interactionKindForControl(control);
  return Object.freeze({
    type: DATE_FIELDS.has(semanticType)
      ? "date_value_committed"
      : interactionKind === "scalar"
        ? "normalized_value_changed"
        : "logical_component_committed",
    logicalFieldId,
    subjectId,
    semanticType,
    componentRole: role,
    controlId,
    expectedComponentValue: desiredValue,
    expectedNormalizedValue: desiredValue,
    expectedCanonicalValue: desiredCanonicalValue,
    dateCodec: dateCodec?.ok ? dateCodec : null,
    interactionKind,
    commitRequirement: interactionKind === "scalar"
      ? "normalized_value_retained"
      : "logical_component_committed",
    representationIdentity: representationIdentity(control, field),
    validationOwnership
  });
}

function interactionKindForControl(control = {}) {
  const role = String(control.role || control.domRole || "").toLowerCase();
  const kind = String(control.kind || control.controlKind || "").toLowerCase();
  if (role === "editable_combobox") return "editable_combobox";
  if (role === "combobox" || kind === "select") {
    return control.state?.native === true || kind === "select" && control.role !== "editable_combobox"
      ? "native_choice"
      : "custom_choice";
  }
  if (control.operations?.open || control.operations?.select || control.recovery?.select) return "custom_choice";
  return "scalar";
}

function componentCommitRequirement(control = {}, page = {}) {
  const interactionKind = interactionKindForControl(control);
  const surface = authoritativeCurrentSurface(page);
  const parentOwnsSurface = Boolean(
    surface?.type
    && surface.type !== "page"
    && surface.parentControlId
    && surface.parentControlId === control.controlId
  );
  const foregroundChoiceSurface = Boolean(
    surface?.type
    && surface.type !== "page"
    && (control.state?.expanded === true || parentOwnsSurface)
  );
  const activeChoiceSurface = interactionKind !== "scalar" && Boolean(
    foregroundChoiceSurface
    || control.commitState?.status === "unsettled"
  );
  const commitState = control.commitState || null;
  const settledCommit = Boolean(
    commitState
    && commitState.status === "settled"
    && commitState.popupClosed !== false
    && commitState.focusSettled !== false
  );
  const interactionSettled = interactionKind === "scalar"
    ? true
    : commitState
      ? settledCommit
      : !activeChoiceSurface;
  return Object.freeze({
    interactionKind,
    commitRequirement: interactionKind === "scalar"
      ? "normalized_value_retained"
      : "logical_component_committed",
    activeChoiceSurface,
    interactionSettled
  });
}

function uniqueBy(items = [], keyFor = (item) => item) {
  return items.filter((item, index, list) => (
    list.findIndex((candidate) => keyFor(candidate) === keyFor(item)) === index
  ));
}

function componentMechanicsScore(component = {}) {
  const operationCount = mechanicalOperationsForControl(component.control || {}).length;
  const capabilityCount = (component.capabilityContracts || []).length;
  const stateOnly = representationIsStateOnly(component.control || {});
  return stateOnly ? -1000 : operationCount * 100 + capabilityCount * 10 + 1;
}

function mergeComponentRepresentations(components = []) {
  const byRole = new Map();
  for (const component of components) {
    const key = component.componentRole === "option"
      ? `option:${component.controlId || component.order}`
      : component.componentRole;
    if (!byRole.has(key)) byRole.set(key, []);
    byRole.get(key).push(component);
  }
  return [...byRole.values()].map((representations) => {
    if (representations.length === 1) return representations[0];
    const primary = [...representations].sort((left, right) => (
      componentMechanicsScore(right) - componentMechanicsScore(left)
      || left.order - right.order
    ))[0];
    const stateOwner = representations.find((component) => component.currentCanonicalValue)
      || representations.find((component) => component.control?.state?.valuePresent === true)
      || primary;
    const stateControlIds = [...new Set(representations.map((component) => component.controlId).filter(Boolean))];
    const currentCanonicalValue = stateOwner.currentCanonicalValue || primary.currentCanonicalValue || "";
    const validationIssues = uniqueBy(
      representations.flatMap((component) => component.validationIssues || []),
      (issue) => `${issue.controlId || ""}|${issue.code || ""}|${issue.message || issue.text || ""}`
    );
    const operations = [...new Set(representations.flatMap((component) => component.operations || []))];
    const capabilityContracts = uniqueBy(
      representations.flatMap((component) => component.capabilityContracts || []),
      (capability) => `${capability.operation || ""}|${capability.actuatorId || ""}|${capability.status || ""}`
    );
    const observedOptions = uniqueBy(
      representations.flatMap((component) => component.observedOptions || []),
      (option) => `${option.value || ""}|${option.label || ""}`
    );
    const selectionTerms = [...new Set(representations.flatMap((component) => component.selectionTerms || []))];
    const exactOption = representations.find((component) => component.exactOption)?.exactOption || null;
    const expectedOutcome = Object.freeze({
      ...(primary.expectedOutcome || {}),
      controlId: primary.controlId || "",
      representationIdentity: representationIdentity(primary.control, primary.field),
      stateControlIds: Object.freeze(stateControlIds)
    });
    const validationOwnership = Object.freeze({
      ...(primary.validationOwnership || {}),
      controlId: primary.controlId || "",
      stateControlIds: Object.freeze(stateControlIds)
    });
    const bindingContract = agentContract.canonicalPipelineContract({
      requirement: primary.requirementContract || {},
      component: {
        ...(primary.bindingContract?.component || {}),
        controlId: primary.controlId || "",
        currentCanonicalValue,
        desiredCanonicalValue: primary.desiredCanonicalValue || "",
        exactOption,
        observedOptions,
        representationControlIds: stateControlIds,
        stateControlId: stateOwner.controlId || ""
      },
      capability: {},
      expectedOutcome,
      validationOwnership
    });
    const interactionSettled = primary.interactionSettled !== false
      && stateOwner.interactionSettled !== false;
    return Object.freeze({
      ...primary,
      currentValue: currentCanonicalValue,
      currentCanonicalValue,
      operations: Object.freeze(operations),
      capabilityContracts: Object.freeze(capabilityContracts),
      observedOptions: Object.freeze(observedOptions),
      selectionTerms: Object.freeze(selectionTerms),
      exactOption,
      expectedOutcome,
      validationOwnership,
      bindingContract: Object.freeze(bindingContract),
      stateControlId: stateOwner.controlId || "",
      stateControlIds: Object.freeze(stateControlIds),
      representationControlIds: Object.freeze(stateControlIds),
      interactionSettled,
      status: primary.desiredCanonicalValue
        && currentCanonicalValue === primary.desiredCanonicalValue
        && validationIssues.length === 0
        && interactionSettled
          ? "resolved"
          : "pending",
      validationIssues: Object.freeze(validationIssues),
      order: Math.min(...representations.map((component) => component.order))
    });
  });
}

function expectedOutcomeForCapability(capability = {}, componentOutcome = {}, control = {}) {
  if (capability.operation === "open") {
    return Object.freeze({
      ...componentOutcome,
      type: "options_surface_appeared",
      previousSurfaceId: control.surfaceId || "",
      previousExpanded: Boolean(control.state?.expanded)
    });
  }
  if (capability.operation === "keyboard" || (
    capability.operation === "type" && control.role === "editable_combobox"
  )) {
    return Object.freeze({
      ...componentOutcome,
      type: "semantic_progress",
      previousSurfaceId: control.surfaceId || "",
      previousValue: componentOutcome.expectedComponentValue
        ? String(control.state?.normalizedValue || "")
        : ""
    });
  }
  if (capability.operation === "choose") {
    return Object.freeze({
      ...componentOutcome,
      type: "control_selected",
      expectedSelectedControlId: control.controlId || ""
    });
  }
  return componentOutcome;
}

function resolveLogicalFields(page = {}, profile = {}) {
  const fieldsByControlId = new Map((page.fields || [])
    .filter((field) => field?.controlId)
    .map((field) => [field.controlId, field]));
  const groups = new Map();

  for (const [order, control] of (page.controls || []).entries()) {
    const field = fieldsByControlId.get(control.controlId) || {};
    const intermediateOwnedFilter = control.surfaceMembershipEvidence === "reverse_aria_owned_surface"
      && /editable_combobox|searchbox|textbox/.test(String(control.role || control.kind || "").toLowerCase())
      && /\b(?:search|filter|find|query)\b/i.test(`${control.label || ""} ${control.accessibleName || ""}`);
    // A portalled search box is a mechanic for discovering the final option,
    // not the profile component that stores the selected canonical value.
    // Keep it in page controls for the adaptive episode, but never let its
    // query text satisfy or replace the parent logical field.
    if (intermediateOwnedFilter) continue;
    const semanticType = semanticTypeForControl(control, field);
    if (!PROFILE_FIELDS.has(semanticType)) continue;
    const subject = subjectForControl(control, field);
    const normalizedType = ["phone", "phone_country_code"].includes(semanticType) ? "phone" : semanticType;
    const owner = logicalOwner(control, field, normalizedType);
    const role = componentRole(control, field, semanticType);
    const baseKey = `${subject.id}|${normalizedType}|${owner}`;
    const incomingRepresentation = {
      control,
      field,
      directSemanticType: semanticType,
      role,
      order
    };
    const compatibleGroup = [...groups.entries()].find(([key, candidate]) => {
      const cooperativeRepresentation = candidate.subject.id === subject.id
        && candidate.semanticType === normalizedType
        && candidate.members.some((member) => representationsCanShareComponent(member, incomingRepresentation));
      return cooperativeRepresentation || (
        key.startsWith(`${baseKey}|`)
        && (
          role === "option"
          || !candidate.members.some((member) => member.role === role)
        )
      );
    });
    const key = compatibleGroup?.[0] || `${baseKey}|${[...groups.keys()].filter((item) => item.startsWith(`${baseKey}|`)).length}`;
    if (!groups.has(key)) {
      groups.set(key, {
        subject,
        semanticType: normalizedType,
        owner,
        order,
        members: []
      });
    }
    groups.get(key).members.push({ control, field, directSemanticType: semanticType, role, order });
  }

  return [...groups.values()].map((group) => {
    const logicalFieldId = `lf_${normalizedAlias(`${group.subject.id}_${group.semanticType}_${group.owner}`)}`;
    const traveler = travelerForSubject(profile, group.subject);
    const phoneTypes = new Set(group.members.map((member) => member.directSemanticType));
    const combinedInternationalPhone = group.members.some((member) => member.role === "international_number");
    const fullPhoneValue = agentContract.encodePhoneForField(traveler, { representation: "combined_international" });
    const desiredCanonicalValue = group.semanticType === "phone"
      ? combinedInternationalPhone
        ? fullPhoneValue
        : phoneTypes.has("phone_country_code") && phoneTypes.has("phone")
        ? `${desiredProfileValue("phone_country_code", traveler)}${desiredProfileValue("phone", traveler)}`
        : phoneTypes.has("phone_country_code")
          ? desiredProfileValue("phone_country_code", traveler)
          : desiredProfileValue("phone", traveler)
      : desiredProfileValue(group.semanticType, traveler, { page });
    const requirementContract = Object.freeze({
      requirementId: logicalFieldId,
      subjectId: group.subject.id,
      semanticType: group.semanticType,
      desiredCanonicalValue: desiredCanonicalValue || "",
      validationOwnerId: logicalFieldId
    });
    const representationComponents = group.members.map(({ control, field, directSemanticType, role, order }) => {
      const componentSemanticType = directSemanticType === "phone_country_code"
        ? "phone_country_code"
        : directSemanticType === "phone"
          ? "phone"
          : group.semanticType;
      const desiredValue = group.semanticType === "phone"
        ? role === "international_number"
          ? fullPhoneValue
          : desiredProfileValue(componentSemanticType, traveler)
        : desiredComponentValue(group.semanticType, role, desiredCanonicalValue);
      const currentValue = currentComponentValue(componentSemanticType, role, control, field, desiredValue);
      const desiredInputValue = DATE_FIELDS.has(group.semanticType)
        ? desiredValue
        : group.semanticType === "phone"
          ? role === "international_number"
            ? agentContract.encodePhoneForField(traveler, control.phoneField || field.phoneField || { representation: "combined_international" })
            : desiredProfileInputValue(componentSemanticType, traveler)
          : desiredProfileInputValue(group.semanticType, traveler, { page });
      const validationIssues = relevantComponentIssues(page, control, logicalFieldId, role);
      const observedContract = agentContract.observedComponentContract(control, {
        surfaceId: control.surfaceId || ""
      });
      const componentObservedOptions = [
        ...(observedContract.observedOptions || []),
        ...(control.options || []),
        ...(control.dateField?.options || []),
        ...(field.options || [])
      ].filter((option, index, list) => list.findIndex((candidate) => (
        String(candidate?.value || "") === String(option?.value || "")
        && String(candidate?.label || "") === String(option?.label || "")
      )) === index);
      const exactOption = exactObservedOptionContract({
        semanticType: componentSemanticType,
        role,
        desiredValue,
        controlId: control.controlId,
        options: componentObservedOptions
      });
      const validationOwnership = Object.freeze({
        ownerId: logicalFieldId,
        logicalFieldId,
        subjectId: group.subject.id,
        semanticType: group.semanticType,
        componentRole: role,
        controlId: control.controlId,
        surfaceId: control.surfaceId || ""
      });
      const inputValue = executableComponentValue({
        semanticType: group.semanticType,
        role,
        desiredValue,
        desiredInputValue,
        desiredCanonicalValue,
        control,
        field
      });
      const selectionTerms = componentSelectionTerms(
        componentSemanticType,
        role,
        desiredValue,
        inputValue,
        componentObservedOptions
      );
      if (componentSemanticType === "phone_country_code") {
        selectionTerms.push(
          ...[traveler.nationality, traveler.country, traveler.country_name]
            .map((value) => String(value || "").trim().toLowerCase())
            .filter(Boolean)
        );
      }
      const expectedOutcome = expectedOutcomeForComponent({
        semanticType: group.semanticType,
        logicalFieldId,
        subjectId: group.subject.id,
        role,
        controlId: control.controlId,
        desiredValue,
        desiredCanonicalValue,
        validationOwnership,
        control,
        field
      });
      const capabilityContracts = Object.freeze((observedContract.capabilities || []).map((capability) => Object.freeze({
        ...capability,
        expectedOutcome: expectedOutcomeForCapability(capability, expectedOutcome, control)
      })));
      const bindingContract = agentContract.canonicalPipelineContract({
        requirement: requirementContract,
        component: {
          logicalFieldId,
          componentIdentity: `${logicalFieldId}:${role}`,
          componentRole: role,
          controlId: control.controlId,
          controlRole: control.role || field.role || "",
          currentCanonicalValue: currentValue || "",
          desiredCanonicalValue: desiredValue || "",
          exactOption,
          observedOptions: componentObservedOptions
        },
        capability: {},
        expectedOutcome,
        validationOwnership
      });
      const commitState = control.commitState || null;
      const commitment = componentCommitRequirement(control, page);
      return Object.freeze({
        semanticType: componentSemanticType,
        role,
        componentRole: role,
        controlId: control.controlId,
        stableIdentity: `${logicalFieldId}:${role}`,
        operations: Object.freeze(operationsFor(control)),
        currentValue: currentValue || "",
        currentCanonicalValue: currentValue || "",
        desiredValue: desiredValue || "",
        desiredCanonicalValue: desiredValue || "",
        exactOption,
        inputValue,
        selectionTerms: Object.freeze([...new Set(selectionTerms)]),
        observedOptions: Object.freeze(componentObservedOptions),
        capabilityContracts,
        expectedOutcome,
        validationOwnership,
        bindingContract: Object.freeze(bindingContract),
        requirementContract,
        commitState,
        interactionKind: commitment.interactionKind,
        commitRequirement: commitment.commitRequirement,
        activeChoiceSurface: commitment.activeChoiceSurface,
        interactionSettled: commitment.interactionSettled,
        status: desiredValue && currentValue === desiredValue && validationIssues.length === 0 && commitment.interactionSettled
          ? "resolved"
          : "pending",
        validationIssues: Object.freeze(validationIssues),
        control,
        field,
        order
      });
    }).sort((left, right) => (
      (COMPONENT_ORDER.get(left.role) ?? 99) - (COMPONENT_ORDER.get(right.role) ?? 99)
      || left.order - right.order
    ));
    const components = mergeComponentRepresentations(representationComponents).sort((left, right) => (
      (COMPONENT_ORDER.get(left.role) ?? 99) - (COMPONENT_ORDER.get(right.role) ?? 99)
      || left.order - right.order
    ));
    const currentCanonicalValue = decodeLogicalValue(group.semanticType, components);
    const controlIds = new Set(components.map((component) => component.controlId));
    const validationIssues = relevantLogicalIssues(page, logicalFieldId, controlIds, group.owner);
    const ambiguousComponents = DATE_FIELDS.has(group.semanticType)
      && components.some((component) => component.role === "value"
        && !inferDateFieldCodec({ ...component.field, dateField: component.control.dateField || component.field.dateField }).ok);
    const ambiguity = ambiguousComponents
      ? {
          code: "AMBIGUOUS_DATE_FORMAT",
          reason: "The date control does not expose a reliable day/month/year representation."
        }
      : null;
    const instructions = instructionsForMembers(group.members);
    const options = optionsForMembers(group.members);
    const controls = components.map((component) => Object.freeze({
      controlId: component.controlId,
      semanticType: component.semanticType,
      componentRole: component.componentRole,
      operations: component.operations,
      currentCanonicalValue: component.currentCanonicalValue,
      desiredCanonicalValue: component.desiredCanonicalValue,
      status: component.status,
      stableIdentity: component.stableIdentity
    }));
    return Object.freeze({
      logicalFieldId,
      subjectId: group.subject.id,
      subject: Object.freeze(group.subject),
      semanticType: group.semanticType,
      ownerKey: group.owner,
      canonicalValue: desiredCanonicalValue || "",
      desiredCanonicalValue: desiredCanonicalValue || "",
      currentCanonicalValue: currentCanonicalValue || "",
      structure: components.length > 1 ? "composite" : "scalar",
      components: Object.freeze(components),
      controls: Object.freeze(controls),
      instructions: Object.freeze(instructions),
      options: Object.freeze(options),
      helperText: instructions[0] || "",
      validationOwner: logicalFieldId,
      requirementContract,
      validationIssues: Object.freeze(validationIssues),
      validation: Object.freeze({
        ownerId: logicalFieldId,
        componentIssues: Object.freeze(Object.fromEntries(components.map((component) => [
          component.componentRole,
          component.validationIssues
        ]))),
        logicalIssues: Object.freeze(validationIssues),
        clear: validationIssues.length === 0
      }),
      confidence: Math.max(0, ...group.members.map(({ control, field }) => Number(
        control.fieldClassification?.confidence || field.confidence || 0.8
      ))),
      ambiguity,
      order: group.order
    });
  }).sort((left, right) => left.order - right.order);
}

function logicalFieldSatisfied(logicalField = {}) {
  const components = logicalField.components || [];
  const isChoiceGroup = components.length > 0 && components.every((component) => component.role === "option");
  return Boolean(
    logicalField.desiredCanonicalValue
    && logicalField.currentCanonicalValue === logicalField.desiredCanonicalValue
    && !logicalField.ambiguity
    && !(logicalField.validationIssues || []).length
    && (isChoiceGroup || components.every((component) => component.status === "resolved"))
  );
}

function verifyLogicalField(page = {}, expectation = {}, profile = {}) {
  const semanticType = normalizeProfileFieldType(expectation.semanticType || "") || expectation.semanticType || "";
  const fields = resolveLogicalFields(page, profile);
  const logicalField = fields.find((field) => (
    Boolean(expectation.logicalFieldId && field.logicalFieldId === expectation.logicalFieldId)
    || Boolean(
      semanticType
      && field.semanticType === semanticType
      && (!expectation.subjectId || field.subjectId === expectation.subjectId)
    )
  )) || null;
  const role = expectation.componentRole || "value";
  const rawExpectedComponentValue = expectation.expectedComponentValue
    || expectation.expectedNormalizedValue
    || expectation.expectedValue
    || "";
  const componentSemanticType = semanticType === "phone" && role === "country_code"
    ? "phone_country_code"
    : semanticType;
  const expectedComponentValue = semanticType === "phone" && role === "international_number"
    ? (() => {
        const digits = String(rawExpectedComponentValue || "").replace(/\D/g, "");
        return digits ? `+${digits}` : "";
      })()
    : DATE_FIELDS.has(semanticType) && role !== "value"
    ? dateComponentValue(role, rawExpectedComponentValue)
    : canonicalValue(componentSemanticType, rawExpectedComponentValue);
  const component = logicalField?.components.find((item) => (
    Boolean(expectation.controlId && item.controlId === expectation.controlId)
    || (
      item.componentRole === role
      && (!expectedComponentValue || item.currentCanonicalValue === expectedComponentValue)
    )
  )) || logicalField?.components.find((item) => item.componentRole === role) || null;
  const actualComponentValue = component?.currentCanonicalValue || "";
  const componentValidation = component?.validationIssues || [];
  const componentSatisfied = Boolean(
    component
    && expectedComponentValue
    && actualComponentValue === expectedComponentValue
    && componentValidation.length === 0
    && component.interactionSettled !== false
  );
  const rawExpectedLogicalValue = expectation.expectedCanonicalValue
    || expectation.desiredCanonicalValue
    || (logicalField?.structure === "scalar" ? expectedComponentValue : "");
  const expectedLogicalValue = semanticType === "phone" && String(rawExpectedLogicalValue).trim().startsWith("+")
    ? `+${String(rawExpectedLogicalValue).replace(/\D/g, "")}`
    : canonicalValue(semanticType, rawExpectedLogicalValue);
  const logicalValidation = logicalField?.validationIssues || [];
  const logicalSatisfied = Boolean(
    logicalField
    && expectedLogicalValue
    && logicalField.currentCanonicalValue === expectedLogicalValue
    && logicalValidation.length === 0
  );
  return Object.freeze({
    logicalField,
    component,
    componentResult: Object.freeze({
      satisfied: componentSatisfied || Boolean(
        role === "option"
        && logicalField
        && expectedLogicalValue
        && logicalField.currentCanonicalValue === expectedLogicalValue
        && componentValidation.length === 0
        && component.interactionSettled !== false
      ),
      componentRole: role,
      expectedCanonicalValue: expectedComponentValue,
      actualCanonicalValue: actualComponentValue,
      validationIssues: Object.freeze(componentValidation)
    }),
    logicalFieldResult: Object.freeze({
      satisfied: logicalSatisfied,
      expectedCanonicalValue: expectedLogicalValue,
      actualCanonicalValue: logicalField?.currentCanonicalValue || "",
      validationIssues: Object.freeze(logicalValidation)
    })
  });
}

module.exports = {
  PROFILE_FIELDS,
  DATE_FIELDS,
  normalizeProfileFieldType,
  semanticTypeForControl,
  subjectForControl,
  travelerForSubject,
  canonicalValue,
  derivedTravelerFacts,
  missingDerivedFactDependency,
  desiredProfileInputValue,
  desiredProfileValue,
  componentRole,
  canonicalOptionMatch,
  resolveLogicalFields,
  bindResolvedComponentToCurrentPage,
  logicalFieldSatisfied,
  verifyLogicalField
};
