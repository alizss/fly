export function normalizedFieldAlias(value = "") {
  return String(value || "")
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function boundedPhrase(text = "", phrase = "") {
  const source = String(text || "").toLowerCase().replace(/[^a-z0-9+]+/g, " ").replace(/\s+/g, " ").trim();
  const wanted = String(phrase || "").toLowerCase().replace(/[^a-z0-9+]+/g, " ").replace(/\s+/g, " ").trim();
  if (!source || !wanted) return false;
  const escaped = wanted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\ /g, "\\s+");
  return new RegExp(`(?:^|\\s)${escaped}(?:$|\\s)`).test(source);
}

export function profileFieldTypesFromText(value = "", { editable = true } = {}) {
  const evidence = String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!evidence) return [];
  const matches = [];
  const add = (fieldType) => {
    if (fieldType && !matches.includes(fieldType)) matches.push(fieldType);
  };
  if (/emergency contact.*e[ -]?mail|e[ -]?mail.*emergency contact/.test(evidence)) add("emergency_contact_email");
  else if (/confirm.*e[ -]?mail|repeat.*e[ -]?mail/.test(evidence)) add("confirm_email");
  else if (editable && /(?:^|\s)e[ -]?mail(?:\s|$)/.test(evidence)) add("email");
  if (/(?:emergency|sos)(?: contact)?.*name|name.*(?:emergency|sos)(?: contact)?/.test(evidence)) add("emergency_contact_name");
  if (/emergency contact.*relationship|relationship.*emergency contact/.test(evidence)) add("emergency_contact_relationship");
  if (/(?:emergency|sos)(?: contact)?.*(?:phone|mobile|telephone)|(?:phone|mobile|telephone).*(?:emergency|sos)(?: contact)?/.test(evidence)) add("emergency_contact_phone");
  if (boundedPhrase(evidence, "surname") || /family[ _-]?name|last[ _-]?name/.test(evidence)) add("last_name");
  const combinedGivenNames = /(?:first|given)\s*(?:\/|and|&)\s*middle\s+names?\b|\bgiven names\b|\bforenames\b/.test(evidence);
  if (combinedGivenNames) add("given_names");
  else {
    if (/first[ _-]?name|given[ _-]?name|forename/.test(evidence)) add("first_name");
    if (/middle[ _-]?name/.test(evidence)) add("middle_name");
  }
  if (/second (?:last name|surname)|additional surname|maternal surname/.test(evidence)) add("second_last_name");
  if (editable && /(?:^|\s)(?:birth|date of birth|dob|bday)(?:\s|$)/.test(evidence)) add("date_of_birth");
  if (editable && /(?:age at (?:the )?time of travel|age (?:at|on) departure|departure age|travel age|passenger age)/.test(evidence)) add("age_at_departure");
  if (editable && /(?:^|\s)(?:place of birth|birth place|birth city)(?:\s|$)/.test(evidence)) add("place_of_birth");
  if (editable && /(?:^|\s)(?:nationality|citizenship|country of citizenship)(?:\s|$)/.test(evidence)) add("nationality");
  if (editable && /country of residence|residence country|resident country/.test(evidence)) add("country_of_residence");
  if (editable && /(?:travel|identity)?\s*document type|passport or id|id type/.test(evidence)) add("document_type");
  if (editable && /passport.*(?:number|no)|(?:number|no).*passport/.test(evidence)) add("passport_number");
  if (editable && /(?:travel|identity)?.*document.*(?:number|no)|(?:number|no).*document/.test(evidence)) add("document_number");
  if (editable && /(?:issuing|issue).*(?:country|nation)|(?:country|nation).*(?:issuing|issue)/.test(evidence)) add("issuing_country");
  if (editable && /(?:passport|document).*(?:issue date|date of issue)|(?:issue date|date of issue).*(?:passport|document)/.test(evidence)) add("document_issue_date");
  if (editable && /passport.*(?:expiry|expiration)|(?:expiry|expiration).*passport/.test(evidence)) add("passport_expiry");
  if (editable && /document.*(?:expiry|expiration)|(?:expiry|expiration).*document/.test(evidence)) add("document_expiry");
  if (editable && /frequent[ -]?flyer.*(?:program|programme|airline)|loyalty program/.test(evidence)) add("frequent_flyer_program");
  if (editable && /frequent[ -]?flyer.*(?:number|no)|loyalty (?:number|no)|membership (?:number|no)/.test(evidence)) add("frequent_flyer_number");
  if (editable && /known travell?er (?:number|no)|\bktn\b/.test(evidence)) add("known_traveler_number");
  if (editable && /redress (?:control )?(?:number|no)/.test(evidence)) add("redress_number");
  if (editable && /meal preference|special meal|meal request/.test(evidence)) add("meal_preference");
  if (editable && /special assistance|assistance request|accessibility request/.test(evidence)) add("special_assistance");
  if (/purpose of (?:the )?(?:trip|travel|journey)|(?:trip|travel|journey) purpose|reason for (?:the )?(?:trip|travel|journey)|business or leisure|travell?ing for (?:business|leisure)/.test(evidence)) add("travel_purpose");
  const countryPhoneCode = /country.*(?:phone|dial|calling)?\s*code|(?:phone|dial|calling).*country.*code|dial.*code|calling.*code/.test(evidence);
  if (countryPhoneCode) add("phone_country_code");
  else if (editable && /(?:^|\s)(?:phone|telephone|mobile)(?:\s|$)/.test(evidence)
    && !/(?:plan|bundle|package|insurance|addon|add on|emergency|sos)/.test(evidence)) add("phone");
  if (/(?:^|\s)(?:title|salutation|honorific)(?:\s|$)/.test(evidence)) add("title");
  if (/(?:^|\s)(?:gender|sex)(?:\s|$)/.test(evidence)) add("gender");
  return matches;
}
