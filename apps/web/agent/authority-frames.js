const agentContract = require("../../extension/src/shared/agent-contract");
const { factsFromObservation } = require("./transaction-facts");
const { fieldDescriptors } = require("./profile-requirements");
const { activeValidationIssues } = require("./validation-evidence");
const { inferDateFieldCodec } = require("./date-field-codec");
const { surfaceClassFrom } = require("./task-state/surface-state");
const {
  normalizeSemanticOwner,
  semanticOwnerId
} = require("../../../packages/shared/semantic-owner");

const OBSERVATION_FRAME_VERSION = "observation-frame/v2";
const DECISION_FRAME_VERSION = "decision-frame/v2";
const CURRENT_OBLIGATION_VERSION = "current-obligation/v3";

function clean(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function unique(values = []) {
  return [...new Set(values.map(clean).filter(Boolean))];
}

function freezeArray(values = []) {
  if (Array.isArray(values)) return Object.freeze([...values]);
  if (values == null || values === "") return Object.freeze([]);
  return Object.freeze([values]);
}

function arrayReference(values = []) {
  if (Array.isArray(values)) return values;
  if (values == null || values === "") return [];
  return [values];
}

function structuralText(control = {}) {
  return clean([
    control.ownText,
    control.label,
    control.accessibleName,
    control.accessibleDescription,
    control.name,
    control.id,
    control.placeholder,
    control.autocomplete,
    control.sectionLabel
  ].filter(Boolean).join(" ")).toLowerCase();
}

const PROFILE_IDENTITY_RULES = Object.freeze([
  { semantic: "emergency_contact_phone", specificity: 120, pattern: /emergency.{0,60}(?:phone|mobile|telephone)|(?:phone|mobile|telephone).{0,60}emergency/ },
  { semantic: "confirm_email", specificity: 120, pattern: /(?:confirm|repeat|re-enter).{0,40}e-?mail|e-?mail.{0,40}(?:confirm|repeat|re-enter)/ },
  { semantic: "phone_country_code", specificity: 120, pattern: /country phone code|phone country code|country code|dial(?:ling|ing)? code|calling code|phone prefix/ },
  { semantic: "given_names", specificity: 120, pattern: /first\s*\/\s*middle name|first and middle name|given names/ },
  { semantic: "country_of_residence", specificity: 120, pattern: /country of residence|residency/ },
  { semantic: "issuing_country", specificity: 120, pattern: /issuing country|country of issue/ },
  { semantic: "address_line2", specificity: 120, pattern: /address line 2/ },
  { semantic: "age_at_departure", specificity: 110, pattern: /age at (?:time of )?(?:travel|departure)|passenger age|age group/ },
  { semantic: "travel_purpose", specificity: 110, pattern: /reason for travel|travel purpose|purpose of (?:the )?trip/ },
  { semantic: "date_of_birth", specificity: 110, pattern: /date of birth|birth date|birthday|\bdob\b/ },
  { semantic: "document_expiry", specificity: 110, pattern: /passport expiry|document expiry|expiration date/ },
  { semantic: "passport_number", specificity: 110, pattern: /passport number/ },
  { semantic: "document_number", specificity: 100, pattern: /document number|travel document/ },
  { semantic: "first_name", specificity: 90, pattern: /first name|given name|forename/ },
  { semantic: "middle_name", specificity: 90, pattern: /middle name|additional name/ },
  { semantic: "last_name", specificity: 90, pattern: /last name|surname|family name/ },
  { semantic: "email", specificity: 70, pattern: /e-?mail/ },
  { semantic: "phone", specificity: 70, pattern: /phone|mobile|telephone|gsm/ },
  { semantic: "nationality", specificity: 70, pattern: /nationality|citizenship/ },
  { semantic: "postal_code", specificity: 70, pattern: /postal code|postcode|zip code|\bzip\b/ },
  { semantic: "address_line1", specificity: 60, pattern: /street address|address line 1|\baddress\b/ },
  { semantic: "title", specificity: 60, pattern: /passenger title|\btitle\b|salutation|mr\/?mrs/ },
  { semantic: "gender", specificity: 60, pattern: /\bgender\b|\bsex\b/ },
  { semantic: "country", specificity: 50, pattern: /(?:^|\s)country(?:\s|$)|select country/ },
  { semantic: "city", specificity: 50, pattern: /\bcity\b|town/ }
]);

const PROFILE_MACHINE_RULES = Object.freeze([
  { semantic: "emergency_contact_phone", specificity: 120, pattern: /emergency(?:contact)?(?:phone|mobile|telephone)|(?:phone|mobile|telephone)emergency/ },
  { semantic: "confirm_email", specificity: 120, pattern: /(?:confirm|repeat|reenter)email|email(?:confirm|repeat|reenter)/ },
  { semantic: "phone_country_code", specificity: 120, pattern: /phonecountry|countryphone|countrycode|dialcode|callingcode|phoneprefix/ },
  { semantic: "country_of_residence", specificity: 120, pattern: /countryofresidence|residencecountry|residency/ },
  { semantic: "issuing_country", specificity: 120, pattern: /issuingcountry|countryofissue/ },
  { semantic: "address_line2", specificity: 120, pattern: /addressline2|address2/ },
  { semantic: "age_at_departure", specificity: 110, pattern: /ageat(?:travel|departure)|passengerage|agegroup/ },
  { semantic: "travel_purpose", specificity: 110, pattern: /reasonfortravel|travelpurpose|purposeoftrip/ },
  { semantic: "date_of_birth", specificity: 110, pattern: /dateofbirth|birthdate|birth(?:day|month|year)|dob/ },
  { semantic: "document_expiry", specificity: 110, pattern: /passportexpiry|documentexpiry|expirationdate/ },
  { semantic: "passport_number", specificity: 110, pattern: /passportnumber/ },
  { semantic: "document_number", specificity: 100, pattern: /documentnumber|traveldocument/ },
  { semantic: "given_names", specificity: 100, pattern: /givennames|firstmiddlename/ },
  { semantic: "first_name", specificity: 90, pattern: /firstname|givenname|forename/ },
  { semantic: "middle_name", specificity: 90, pattern: /middlename|additionalname/ },
  { semantic: "last_name", specificity: 90, pattern: /lastname|surname|familyname/ },
  { semantic: "email", specificity: 70, pattern: /email/ },
  { semantic: "phone", specificity: 70, pattern: /phone|mobile|telephone|gsm/ },
  { semantic: "nationality", specificity: 70, pattern: /nationality|citizenship/ },
  { semantic: "postal_code", specificity: 70, pattern: /postalcode|postcode|zipcode|zip/ },
  { semantic: "address_line1", specificity: 60, pattern: /streetaddress|addressline1|address1|address/ },
  { semantic: "title", specificity: 60, pattern: /title|salutation/ },
  { semantic: "gender", specificity: 60, pattern: /gender|sex/ },
  { semantic: "country", specificity: 50, pattern: /customercountry|billingcountry|addresscountry|country/ },
  { semantic: "city", specificity: 50, pattern: /city|town/ }
]);

function semanticFromEvidenceValue(value = "", rules = PROFILE_IDENTITY_RULES, machine = false) {
  const normalized = clean(value).toLowerCase();
  if (!normalized) return Object.freeze({ semantic: "", specificity: 0 });
  const evidence = machine ? normalized.replace(/[^a-z0-9]+/g, "") : normalized;
  const matches = rules.filter((rule) => rule.pattern.test(evidence));
  if (!matches.length) return Object.freeze({ semantic: "", specificity: 0 });
  const strongest = Math.max(...matches.map((rule) => rule.specificity));
  const semantics = unique(matches.filter((rule) => rule.specificity === strongest).map((rule) => rule.semantic));
  return Object.freeze({
    semantic: semantics.length === 1 ? semantics[0] : "",
    specificity: strongest,
    ambiguous: semantics.length > 1
  });
}

function resolveSemanticChannel(values = [], rules = PROFILE_IDENTITY_RULES, machine = false) {
  const matches = values.map((value) => semanticFromEvidenceValue(value, rules, machine))
    .filter((match) => match.specificity > 0);
  if (!matches.length) return Object.freeze({ status: "empty", semantic: "", specificity: 0 });
  const strongest = Math.max(...matches.map((match) => match.specificity));
  const strongestMatches = matches.filter((match) => match.specificity === strongest);
  const semantics = unique(strongestMatches.map((match) => match.semantic));
  if (strongestMatches.some((match) => match.ambiguous) || semantics.length > 1) {
    return Object.freeze({ status: "ambiguous", semantic: "", specificity: strongest });
  }
  return Object.freeze({ status: "resolved", semantic: semantics[0], specificity: strongest });
}

function profileSemanticFromStructure(control = {}) {
  const autocomplete = clean(control.autocomplete).toLowerCase();
  const autocompleteAliases = {
    "given-name": "first_name",
    "additional-name": "middle_name",
    "family-name": "last_name",
    "honorific-prefix": "title",
    email: "email",
    tel: "phone",
    "tel-national": "phone",
    "tel-country-code": "phone_country_code",
    bday: "date_of_birth",
    "bday-day": "date_of_birth",
    "bday-month": "date_of_birth",
    "bday-year": "date_of_birth",
    country: "country",
    "country-name": "country",
    "street-address": "address_line1",
    "address-line1": "address_line1",
    "address-line2": "address_line2",
    "address-level2": "city",
    "address-level1": "state",
    "postal-code": "postal_code"
  };
  if (autocompleteAliases[autocomplete]) return autocompleteAliases[autocomplete];
  const shape = clean(`${control.kind || ""} ${control.role || ""} ${control.domRole || ""} ${control.inputType || ""}`).toLowerCase();
  // Evidence channels have an explicit authority order. Values inside a
  // channel must agree; array/regex order can never pick a winner. Helper,
  // validation and section prose are intentionally absent because they
  // constrain a value or surface, not the field's identity.
  const machineChannel = resolveSemanticChannel([
    control.rawEvidenceChannels?.name,
    control.name,
    control.id,
    control.testId
  ], PROFILE_MACHINE_RULES, true);
  const descriptiveChannels = [
    resolveSemanticChannel([
      control.rawEvidenceChannels?.label,
      control.label,
      control.rawEvidenceChannels?.accessibleName,
      control.accessibleName,
      control.ariaLabel
    ]),
    resolveSemanticChannel([control.ownText]),
    resolveSemanticChannel([
      control.rawEvidenceChannels?.placeholder,
      control.placeholder
    ])
  ];
  const boundedOwnerChannel = resolveSemanticChannel([control.sectionLabel]);
  const choiceShape = /checkbox|radio|switch|button|link|option|choice|combobox|listbox|select/.test(shape);
  if (choiceShape) {
    const allowed = /checkbox|switch|link/.test(shape)
      ? new Set()
      : /button/.test(shape)
        ? new Set(["phone_country_code", "age_at_departure", "travel_purpose", "title", "gender", "nationality", "country_of_residence", "country"])
        : new Set(["phone_country_code", "age_at_departure", "travel_purpose", "title", "gender", "nationality", "country_of_residence", "country", "date_of_birth", "document_expiry"]);
    // The state-owner machine identity is authoritative for choice controls:
    // an aggregate radio label often contains the whole surrounding form.
    // Only the closed profile-choice vocabulary is admitted, so legal and
    // marketing checkboxes cannot become profile fields from incidental text.
    if (machineChannel.status === "ambiguous") return "";
    if (machineChannel.status === "resolved" && allowed.has(machineChannel.semantic)) {
      return machineChannel.semantic;
    }
    const allowedChannels = [...descriptiveChannels, boundedOwnerChannel].filter((channel) => (
      channel.status !== "resolved" || allowed.has(channel.semantic)
    ));
    const strongest = Math.max(0, ...allowedChannels.map((channel) => channel.specificity || 0));
    if (!strongest) return "";
    const strongestChannels = allowedChannels.filter((channel) => channel.specificity === strongest);
    if (strongestChannels.some((channel) => channel.status === "ambiguous")) return "";
    const semantics = unique(strongestChannels.map((channel) => channel.semantic));
    return semantics.length === 1 ? semantics[0] : "";
  }
  const channels = [machineChannel, ...descriptiveChannels];
  const strongest = Math.max(0, ...channels.map((channel) => channel.specificity || 0));
  if (!strongest) return "";
  const strongestChannels = channels.filter((channel) => channel.specificity === strongest);
  if (strongestChannels.some((channel) => channel.status === "ambiguous")) return "";
  const semantics = unique(strongestChannels.map((channel) => channel.semantic));
  return semantics.length === 1 ? semantics[0] : "";
}

function decisionFamilyFromStructure(label = "") {
  const text = clean(label).toLowerCase();
  if (/age at (?:time of )?(?:travel|departure)|passenger age|age group/.test(text)) return "age_at_departure";
  if (/reason for travel|travel purpose|purpose of (?:the )?trip/.test(text)) return "travel_purpose";
  if (/passenger title|\btitle\b|salutation/.test(text)) return "title";
  if (/\bgender\b|\bsex\b/.test(text)) return "gender";
  if (agentContract.isLegalAcceptanceText(text)) return "legal_acceptance";
  if (/payment method|credit card|debit card|visa|mastercard|apple pay|google pay|paypal/.test(text)) return "payment_method";
  if (/choose (?:your )?fare|fare packages?|fare types?|basic saver|basic standard|basic flexi/.test(text)) return "fare";
  if (agentContract.isInsuranceOfferText(text) || /insurance|protection|cancellation cover|refund protection/.test(text)) return "insurance";
  if (/baggage|checked bag|hand bag|cabin bag|luggage/.test(text)) return "baggage";
  if (/seat|seating/.test(text)) return "seat";
  if (/flex|change ticket|reschedule/.test(text)) return "flexible_ticket";
  if (/bundle|package|premium support|sms/.test(text)) return "bundle";
  return "decision";
}

function profileComponentRoleFromStructure(control = {}, semanticType = "", phoneField = null) {
  const declaredDateRole = clean(control.state?.dateComponent).toLowerCase();
  if (["day", "month", "year"].includes(declaredDateRole)) return declaredDateRole;
  if (["date_of_birth", "document_expiry"].includes(semanticType)) {
    const evidence = clean(`${control.autocomplete || ""} ${control.name || ""} ${control.id || ""} ${control.placeholder || ""}`)
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_");
    if (/(?:^|_)(?:day|dd)(?:_|$)/.test(evidence)) return "day";
    if (/(?:^|_)(?:month|mm)(?:_|$)/.test(evidence)) return "month";
    if (/(?:^|_)(?:year|yyyy|yy)(?:_|$)/.test(evidence)) return "year";
    return "value";
  }
  if (semanticType === "phone_country_code") return "country_code";
  if (semanticType === "phone") {
    return phoneField?.representation === "combined_international"
      ? "international_number"
      : "local_number";
  }
  const shape = lower(`${control.kind || ""} ${control.role || ""} ${control.domRole || ""}`);
  if (/radio|checkbox|option|choice/.test(shape)) return "option";
  return "value";
}

function paymentMethodKindFromStructure(control = {}) {
  const evidence = lower(`${control.ownText || ""} ${control.label || ""} ${control.accessibleName || ""} ${control.name || ""} ${control.id || ""}`);
  if (/apple pay|google pay|paypal|wallet|keks pay/.test(evidence)) return "wallet";
  if (/credit card|debit card|card payment|pay by card|visa|mastercard|master card|american express|amex|maestro|diners club|discover/.test(evidence)) return "card";
  return "unknown";
}

function dateFieldFromStructure(control = {}, semanticType = "", componentRole = "value") {
  if (!["date_of_birth", "document_expiry"].includes(semanticType)) return null;
  const observed = {
    inputType: control.inputType || "",
    placeholder: control.placeholder || "",
    pattern: control.pattern || "",
    description: control.accessibleDescription || "",
    label: control.label || control.accessibleName || "",
    name: control.name || "",
    autocomplete: control.autocomplete || "",
    options: control.options || [],
    component: ["day", "month", "year"].includes(componentRole) ? componentRole : ""
  };
  const codec = inferDateFieldCodec({ ...control, dateField: observed });
  return {
    ...observed,
    ...(codec.ok && codec.kind === "full" ? {
      format: codec.format,
      separator: codec.separator,
      source: codec.source,
      ambiguous: false
    } : codec.ok && codec.kind === "component" ? {
      component: codec.component,
      source: codec.source,
      ambiguous: false
    } : {
      format: "",
      separator: "",
      source: "insufficient_structural_evidence",
      ambiguous: true
    })
  };
}

function structuralRequirementKey(family = "decision", label = "") {
  const subject = clean(label).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `${family}:${subject || family}`;
}

function groundedControlMeaning(hint = {}) {
  const role = clean(hint.semanticRole).toLowerCase();
  const consequence = clean(hint.consequenceClass).toLowerCase();
  const mapped = {
    payment_method: { semantic: "payment_method", physicalEffect: "reveal_control", risk: "safe", effectRole: "payment_route" },
    stage_exit: { semantic: "navigation", physicalEffect: "advance_checkout_stage", risk: "safe", effectRole: "navigation" },
    reveal_control: { semantic: "open_surface", physicalEffect: "reveal_control", risk: "safe", effectRole: "surface_opener" },
    dismiss_surface: { semantic: "dismiss_surface", physicalEffect: "dismiss_surface", risk: "safe", effectRole: "surface_command" },
    legal_acceptance: { semantic: "legal_acceptance", physicalEffect: "accept_legal_terms", risk: "legal", effectRole: "legal_attestation" },
    choice_option: {
      semantic: consequence === "monetary_selection" ? "add_paid_extra" : "choice",
      physicalEffect: consequence === "monetary_selection" ? "select_paid_option" : "select_option",
      risk: consequence === "monetary_selection" ? "money" : "uncertain",
      effectRole: "commerce_option"
    }
  }[role];
  return mapped || null;
}

function interpretStructuralControl(control = {}, groupLabel = "", currentSurface = {}, hints = {}) {
  const evidence = `${structuralText(control)} ${clean(groupLabel).toLowerCase()}`.trim();
  // Disposition is owned by the exact actuator, never by its surrounding
  // section. A paid option and a "No, thanks" sibling commonly share the
  // same section text; treating that text as option-local makes both choices
  // look free and causes TaskState to preserve the paid selection.
  const localEvidence = clean([
    control.ownText,
    control.label,
    control.accessibleName,
    control.accessibleDescription,
    control.name,
    control.id,
    control.placeholder,
    control.autocomplete
  ].filter(Boolean).join(" ")).toLowerCase();
  const shape = clean(`${control.kind || ""} ${control.role || ""} ${control.domRole || ""} ${control.inputType || ""}`).toLowerCase();
  const disabledStateRepresentation = Boolean(
    control.disabled === true
    || control.logicalDisabled === true
    || control.state?.disabled === true
  ) && /radio|checkbox|switch|toggle/.test(shape);
  const localActionText = clean(control.ownText || control.accessibleName || control.label).toLowerCase();
  const activeForegroundControl = clean(currentSurface.id)
    && clean(currentSurface.id) !== "surface-page"
    && clean(control.surfaceId) === clean(currentSurface.id);
  const surfaceClass = clean(currentSurface.surfaceClass).toLowerCase();
  const surfaceDismiss = activeForegroundControl && (
    /^(?:close|cancel|dismiss|×|x)$/.test(localActionText)
    || /(?:dialog|modal)[_-]?close/.test(clean(control.testId || control.id).toLowerCase())
    || (surfaceClass === "warning" && /^(?:continue|confirm|proceed|ok|yes)\b/.test(localActionText))
  );
  const surfaceOpen = activeForegroundControl
    && /^(?:edit|modify|change)\b/.test(localActionText);
  const surfaceAdvance = activeForegroundControl
    && !surfaceDismiss
    && !surfaceOpen
    && (
      /submit/.test(shape)
      || /^(?:continue|proceed|confirm|finish|done|save)\b/.test(localActionText)
    );
  const commercialSelectionCta = /^continue with\b/.test(localActionText);
  const ownedCommercialChoice = commercialSelectionCta && Boolean(clean(groupLabel));
  const localNavigationCommand = /^(?:continue|next|proceed|confirm|done|save and continue|go to payment|pay by card)\b/.test(localActionText);
  const structuralProgressEvidence = clean([
    localActionText,
    control.name,
    control.id,
    control.testId
  ].filter(Boolean).join(" ")).toLowerCase();
  const progressCapability = control.operations?.activate || control.operations?.choose || null;
  const hintedStageExit = progressCapability?.actionability?.executable === true
    && control.disabled !== true
    && control.state?.disabled !== true
    && /button|link|submit/.test(shape)
    && /submit|continue|next|proceed/.test(structuralProgressEvidence);
  const groundedField = hints.fieldHint?.authority === "grounded_hypothesis_only"
    ? clean(hints.fieldHint.semanticType).toLowerCase()
    : "";
  const profileField = groundedField || ((localNavigationCommand || hintedStageExit || surfaceDismiss || surfaceOpen || surfaceAdvance || commercialSelectionCta) ? "" : profileSemanticFromStructure({
    ...control,
    sectionLabel: clean(groupLabel || control.sectionLabel)
  }));
  const autocomplete = clean(control.autocomplete).toLowerCase();
  const cardField = /^(?:cc-number|cc-exp|cc-csc|cc-name)$/.test(autocomplete)
    || /card number|security code|\bcvc\b|\bcvv\b|card expiry|expiration/.test(evidence);
  const factualAttestation = /(?:confirm|declare|certify|verify).{0,100}(?:booking|passenger|travell?er|itinerary|details|information).{0,100}(?:accurate|correct|complete|true)/.test(localEvidence)
    || /(?:booking|passenger|travell?er|itinerary|details|information).{0,100}(?:accurate|correct|complete|true).{0,100}(?:confirm|declare|certify|verify)/.test(localEvidence);
  const legal = (agentContract.isLegalAcceptanceText(evidence) || factualAttestation)
    && /checkbox|switch|radio/.test(shape);
  // Optional consent is an actuator-local fact. A payment section heading
  // must not turn an unrelated marketing/survey checkbox into a required
  // payment route.
  const optionalConsent = /checkbox|switch/.test(shape)
    && /newsletter|marketing|special offers|third[- ]party offers|offers from (?:our )?(?:partners|third parties)|promotional|notifications? via (?:sms|e-?mail)|survey|research/.test(localEvidence)
    && !legal;
  const pressableChoiceCapability = [
    control.operations?.activate,
    control.operations?.choose
  ].some((capability) => Boolean(
    capability
    && (
      capability.actuatorId
      || (capability.actuatorIds || []).length
      || (capability.strategies || []).some((strategy) => strategy?.actuatorId)
    )
  ));
  const paymentMethod = !cardField
    && !optionalConsent
    && !/^(?:cancel|back|close|help)(?:\s|$)/.test(localActionText)
    && /payment method|pay by card|card payment|credit card|debit card|apple pay|google pay|paypal|visa|mastercard|master card|american express|amex|maestro|diners club|discover|keks pay/.test(localEvidence)
    && (
      /button|radio|option|choice|link|select|combobox|listbox|pressable/.test(shape)
      || pressableChoiceCapability
    );
  const purchase = !paymentMethod && agentContract.isPaymentCommitText(localEvidence);
  const scopeToggle = /checkbox|switch|button/.test(shape)
    && /same for all flights|apply to all (?:flights|segments|travellers|travelers)|use for all/.test(localEvidence);
  const explicitSkipExit = /^(?:skip (?:bags?|baggage|seats?|insurance|extras?|selection)|continue without (?:bags?|baggage|seats?|insurance|extras?)|choose seats? for me)\b/.test(localActionText);
  const foregroundChoiceDecline = explicitSkipExit && (
    activeForegroundControl
    || control.choiceContract?.ownershipComplete === true
    || Boolean(clean(control.choiceContract?.decisionInstance))
    || control.state?.pressable === true
  );
  const stageExit = !foregroundChoiceDecline && !purchase && !surfaceDismiss && !surfaceOpen && !surfaceAdvance && !commercialSelectionCta && (
    /^(?:continue|next|proceed|confirm|done|save and continue|go to payment)\b/.test(localActionText)
    || explicitSkipExit
    || hintedStageExit
  );
  const rawPriceAmount = control.structuredPrice?.amount;
  const hasPriceAmount = rawPriceAmount !== null && rawPriceAmount !== undefined && rawPriceAmount !== "";
  const explicitlyFree = /no thanks|no,? thank|no (?:insurance|bundle|baggage|bags?|extras?)|without|decline|skip|none|not now|remove|random assignment|free/.test(localEvidence)
    || (hasPriceAmount && Number(rawPriceAmount) === 0);
  const priced = hasPriceAmount && Number(rawPriceAmount) > 0;
  const semantic = disabledStateRepresentation
    ? "unknown"
    : surfaceDismiss
    ? "dismiss_surface"
      : surfaceOpen
      ? "open_surface"
      : surfaceAdvance
        ? "navigation"
      : commercialSelectionCta && !ownedCommercialChoice
        ? "selection_cta"
        : cardField
    ? ({ "cc-number": "card_number", "cc-exp": "card_expiry", "cc-csc": "card_security_code", "cc-name": "cardholder_name" }[autocomplete] || "payment_entry")
    : profileField
      ? profileField
      : legal
        ? "legal_acceptance"
        : purchase
          ? "submit_purchase"
          : paymentMethod
            ? "payment_method"
            : stageExit
              ? "navigation"
              : scopeToggle
                ? "scope_toggle"
                : optionalConsent
                  ? "optional_consent"
              : explicitlyFree
                ? (ownedCommercialChoice ? "select_free_option" : "decline_paid_extra")
                : priced
                  ? "add_paid_extra"
                  : /checkbox|radio|option|choice/.test(shape)
                    ? "choice"
                    : "unknown";
  const physicalEffect = disabledStateRepresentation
    ? "unknown"
    : surfaceDismiss
    ? "dismiss_surface"
      : surfaceOpen
      ? "open_surface"
      : surfaceAdvance
        ? (surfaceClass === "review_confirmation" ? "advance_checkout_stage" : "advance_surface")
      : commercialSelectionCta && !ownedCommercialChoice
        ? "unknown"
        : profileField
    ? "set_field_value"
    : legal
      ? "accept_legal_terms"
      : purchase
        ? "submit_purchase"
        : paymentMethod
          ? "reveal_control"
          : stageExit
            ? "advance_checkout_stage"
            : scopeToggle
              ? "preserve_scope"
              : optionalConsent
                ? "set_optional_consent"
            : explicitlyFree
              ? "select_free_option"
              : priced
                ? "select_paid_option"
                : "unknown";
  const risk = disabledStateRepresentation
    ? "uncertain"
    : cardField || purchase
    ? "payment"
    : legal
      ? "legal"
      : priced
        ? "money"
        : surfaceDismiss || surfaceOpen || surfaceAdvance || explicitlyFree || profileField || stageExit || paymentMethod || scopeToggle || optionalConsent
          ? "safe"
          : "uncertain";
  const phoneField = ["phone", "phone_country_code"].includes(profileField)
    ? agentContract.inferPhoneFieldCodec({
        semanticType: profileField,
        label: control.rawEvidenceChannels?.label || control.label || control.accessibleName || "",
        name: control.rawEvidenceChannels?.name || control.name || "",
        placeholder: control.rawEvidenceChannels?.placeholder || control.placeholder || "",
        pattern: control.rawEvidenceChannels?.constraints?.pattern || control.pattern || "",
        autocomplete: control.rawEvidenceChannels?.autocomplete || control.autocomplete || "",
        inputMode: control.rawEvidenceChannels?.constraints?.inputMode || control.inputMode || "",
        accessibleDescription: control.rawEvidenceChannels?.accessibleDescription || control.accessibleDescription || "",
        description: control.rawEvidenceChannels?.helper || control.helperText || control.description || ""
      })
    : null;
  const groundedMeaning = hints.controlHint?.authority === "grounded_hypothesis_only"
    ? groundedControlMeaning(hints.controlHint)
    : null;
  const componentRole = profileField
    ? profileComponentRoleFromStructure(control, profileField, phoneField)
    : "value";
  const dateField = dateFieldFromStructure(control, profileField, componentRole);
  const structuralSectionEvidence = lower(`${control.sectionLabel || ""} ${groupLabel || ""}`);
  const canonicalSectionType = paymentMethod
    ? "payment"
    : legal
      ? "legal_acceptance"
      : profileField
        ? /contact|phone|mobile|e-?mail/.test(structuralSectionEvidence)
          ? "contact"
          : /passenger|travell?er/.test(structuralSectionEvidence)
            ? "passenger"
            : "profile"
        : control.sectionType || "";
  return {
    ...control,
    required: control.required === true || control.state?.required === true,
    invalid: control.invalid === true || control.state?.invalid === true,
    semantic: profileField || groundedMeaning?.semantic || semantic,
    semanticType: profileField || groundedMeaning?.semantic || semantic,
    fieldType: profileField,
    field: profileField,
    physicalEffect: profileField ? "set_field_value" : groundedMeaning?.physicalEffect || physicalEffect,
    semanticIntent: profileField ? "set_field_value" : groundedMeaning?.physicalEffect || physicalEffect,
    risk: groundedMeaning?.risk || risk,
    sectionType: canonicalSectionType,
    componentPattern: control.componentContract?.componentPattern || control.componentPattern || "native_input_select",
    componentRole,
    ...(paymentMethod ? { paymentMethodKind: paymentMethodKindFromStructure(control) } : {}),
    effectRole: groundedMeaning?.effectRole || (disabledStateRepresentation
      ? "presentation_mode"
      : surfaceDismiss || surfaceOpen || surfaceAdvance
      ? "surface_command"
      : profileField
      ? "profile_field"
      : legal
        ? "legal_attestation"
        : paymentMethod
          ? "payment_route"
          : stageExit
            ? "navigation"
            : scopeToggle
              ? "scope_toggle"
            : optionalConsent
              ? "optional_consent"
              : priced || explicitlyFree
                ? "commerce_option"
                : "unknown"),
    // Representation is derived after semantic identity, in the same
    // authority. Browser-authored semantic codecs were removed at the
    // structural boundary, so helper text can refine formatting without
    // independently redefining what the control means.
    phoneField,
    dateField
  };
}

function interpretStructuralPage(page = {}) {
  const structuralGroups = page.decisionGroups || [];
  const fieldHints = new Map((page.semanticFieldHints || []).flatMap((hint) => (
    hint?.authority === "grounded_hypothesis_only" && clean(hint.controlId)
      ? [[clean(hint.controlId), hint]]
      : []
  )));
  const controlHints = new Map((page.semanticControlHints || []).flatMap((hint) => (
    hint?.authority === "grounded_hypothesis_only" && clean(hint.controlId)
      ? [[clean(hint.controlId), hint]]
      : []
  )));
  const validationOwnerHints = new Map((page.semanticValidationHints || []).flatMap((hint) => (
    hint?.authority === "grounded_hypothesis_only" && clean(hint.validationIssueId) && clean(hint.controlId)
      ? [[clean(hint.validationIssueId), hint]]
      : []
  )));
  const validationIssues = (page.validationIssues || []).map((issue) => {
    const hint = validationOwnerHints.get(clean(issue.issueId));
    return hint ? { ...issue, controlId: clean(hint.controlId), ownershipSource: "grounded_semantic_scene" } : issue;
  });
  const groundedDecisionHints = new Map((page.semanticDecisionHints || []).flatMap((hint) => {
    const decisionGroupId = clean(hint?.decisionGroupId);
    const decisionType = clean(hint?.decisionType).toLowerCase();
    if (!decisionGroupId || !decisionType || hint?.authority !== "grounded_hypothesis_only") return [];
    return [[decisionGroupId, { ...hint, decisionType }]];
  }));
  const groupLabelByControl = new Map(structuralGroups.flatMap((group) => (
    (group.alternativeControlIds || group.alternatives || []).map((option) => [
      typeof option === "string" ? option : option.controlId,
      group.sectionLabel || ""
    ])
  )));
  let controls = (page.controls || []).map((control) => (
    interpretStructuralControl(
      control,
      groupLabelByControl.get(control.controlId) || "",
      page.currentSurface || page.activeSurface || {},
      {
        fieldHint: fieldHints.get(clean(control.controlId)),
        controlHint: controlHints.get(clean(control.controlId))
      }
    )
  ));
  const controlsById = new Map(controls.map((control) => [control.controlId, control]));
  const profileOwnedControlIds = new Set(controls
    .filter((control) => control.effectRole === "profile_field")
    .map((control) => clean(control.controlId))
    .filter(Boolean));
  const decisionGroups = structuralGroups.map((group) => {
    const ids = unique([
      ...(group.alternativeControlIds || []),
      ...(group.alternatives || []).map((option) => option.controlId)
    ]).filter((controlId) => !profileOwnedControlIds.has(clean(controlId)));
    // A profile component may be implemented by a select, radio, or custom
    // choice widget, but its desired state and completion are owned by the
    // parent logical profile field. Publishing the same control as a generic
    // checkout decision creates a second requiredness/completion authority.
    if (!ids.length) return null;
    const memberIds = new Set(ids);
    const groupControls = ids.map((controlId) => controlsById.get(controlId)).filter(Boolean);
    // Selection is an observed relationship owned by the structural group.
    // Native <select> elements retain their value without setting the select
    // container's `selected` boolean, so rebuilding this fact from member
    // booleans reopens an already-satisfied choice. Accept the exact observed
    // member id when it belongs to this group; only fall back to member state
    // when the observer did not publish a group-level selection.
    const observedSelectedControlId = clean(
      group.selectedEvidence?.selectedControlId || group.selectedControlId
    );
    const observedSelectedLabel = clean(
      group.selectedEvidence?.selectedLabel || group.selectedLabel
    );
    const exactSelectedControlId = memberIds.has(observedSelectedControlId)
      ? observedSelectedControlId
      : "";
    let family = decisionFamilyFromStructure(`${group.sectionLabel || ""} ${groupControls.map((control) => control.label || "").join(" ")}`);
    const groundedHint = groundedDecisionHints.get(clean(group.decisionGroupId));
    if (groundedHint && family === "decision") family = groundedHint.decisionType;
    // DecisionFrame is the semantic authority. Do not require the browser's
    // earlier descriptive projection to independently agree before retaining
    // a payment-method interpretation. The only local override is a set of
    // exact optional-consent actuators, whose disposition is independently
    // proven on each control rather than inherited from a payment section.
    if (
      family === "payment_method"
      && groupControls.length > 0
      && groupControls.every((control) => control.effectRole === "optional_consent")
    ) {
      family = "optional_consent";
    }
    const requiredByControl = groupControls.some((control) => control.state?.required === true);
    const requiredByValidation = validationIssues.some((issue) => (
      issue?.active !== false
      && [
        issue.controlId,
        issue.ownerControlId,
        issue.stateControlId,
        ...(issue.controlIds || []),
        ...(issue.evidenceIds || [])
      ].map(clean).some((controlId) => memberIds.has(controlId))
    ));
    // Requiredness is interpreted here from exact current evidence. The
    // browser's previous group.required/status projection is intentionally not
    // authoritative across the structural boundary.
    const requiredBySite = group.ownerState?.required === true
      || requiredByControl
      || requiredByValidation;
    let required = requiredBySite;
    const requiredOpaqueAttestation = required
      && groupControls.length === 1
      && /checkbox|switch/.test(clean(`${groupControls[0].kind || ""} ${groupControls[0].role || ""}`).toLowerCase())
      && !groupControls[0].structuredPrice
      && ["choice", "unknown"].includes(clean(groupControls[0].semantic));
    if (requiredOpaqueAttestation) family = "unknown_attestation";
    let alternatives = ids.map((controlId) => {
      const control = controlsById.get(controlId) || {};
      const structural = (group.alternatives || []).find((option) => option.controlId === controlId) || {};
      const optionLabel = clean(structural.label || control.label || controlId);
      const optionAmount = structural.structuredPrice?.amount ?? control.structuredPrice?.amount;
      const hasOptionAmount = optionAmount !== null && optionAmount !== undefined && optionAmount !== "";
      const nonOutcomeRole = [
        "presentation_mode",
        "scope_toggle",
        "surface_opener",
        "information_only",
        "navigation",
        "surface_command",
        "legal_attestation",
        "payment_route",
        "profile_field",
        "optional_consent"
      ].includes(clean(control.effectRole));
      const optionPaid = !nonOutcomeRole && hasOptionAmount && Number(optionAmount) > 0;
      const optionFree = !nonOutcomeRole && !optionPaid && (
        hasOptionAmount && Number(optionAmount) === 0
        || /no thanks|no,? thank|no (?:insurance|bundle|baggage|bags?|extras?)|without|decline|skip|none|not now|remove|deselect|undo|random|automatic|free/.test(optionLabel.toLowerCase())
      );
      return {
        ...structural,
        controlId,
        label: optionLabel,
        semantic: family === "unknown_attestation"
          ? "unknown_attestation"
          : optionPaid
            ? "add_paid_extra"
            : optionFree
              ? "decline_paid_extra"
              : control.semantic || "unknown",
        physicalEffect: family === "unknown_attestation"
          ? "unknown"
          : optionPaid
            ? "select_paid_option"
            : optionFree
              ? "select_free_option"
              : control.physicalEffect || structural.physicalEffect || "unknown",
        effectRole: optionPaid || optionFree
          ? "commerce_option"
          : clean(control.effectRole) && clean(control.effectRole) !== "unknown"
            ? control.effectRole
            : structural.effectRole || "",
        risk: family === "unknown_attestation"
          ? "uncertain"
          : optionPaid
            ? "money"
            : optionFree
              ? "safe"
              : clean(control.risk) && clean(control.risk) !== "uncertain"
                ? control.risk
                : structural.risk || control.risk || "uncertain",
        structuredPrice: nonOutcomeRole ? null : (structural.structuredPrice || control.structuredPrice || null),
        selected: exactSelectedControlId
          ? controlId === exactSelectedControlId
          : structural.selected === true
            || control.selected === true
            || control.state?.checked === true
            || control.state?.selected === true
      };
    });
    const priceEligible = alternatives.some((alternative) => ![
      "presentation_mode",
      "scope_toggle",
      "surface_opener",
      "information_only",
      "navigation",
      "surface_command",
      "legal_attestation",
      "profile_field",
      "optional_consent"
    ].includes(clean(alternative.effectRole)));
    const boundedPriceEvidence = priceEligible
      ? agentContract.boundedDecisionPriceEvidence(page, alternatives, controlsById)
      : [];
    alternatives = alternatives.map((alternative) => {
      const evidence = boundedPriceEvidence.find((entry) => entry.controlId === alternative.controlId);
      if (!evidence) return alternative;
      return {
        ...alternative,
        structuredPrice: alternative.structuredPrice || evidence.structuredPrice || null,
        ...(evidence.included ? {
          semantic: alternative.semantic === "unknown" ? "decline_paid_extra" : alternative.semantic,
          physicalEffect: alternative.physicalEffect === "unknown" ? "select_free_option" : alternative.physicalEffect,
          effectRole: alternative.effectRole || "commerce_option",
          risk: alternative.risk === "uncertain" ? "safe" : alternative.risk
        } : {}),
        canonicalAttributes: {
          ...(alternative.canonicalAttributes || {}),
          ...(evidence.canonicalAttributes || {})
        }
      };
    });
    const hasExactOptionPrice = (option) => {
      if (["presentation_mode", "scope_toggle", "surface_opener", "information_only", "navigation", "surface_command", "legal_attestation", "payment_route", "profile_field", "optional_consent"].includes(clean(option.effectRole))) {
        return false;
      }
      const amount = option.structuredPrice?.amount;
      return amount !== null && amount !== undefined && amount !== "" && Number.isFinite(Number(amount));
    };
    const hasCommerceOptions = alternatives.some((option) => (
      option.effectRole === "commerce_option"
      || hasExactOptionPrice(option)
      || /select_(?:free|paid)_option|decline_paid|add_paid/.test(`${option.physicalEffect || ""} ${option.semantic || ""}`)
    ));
    const boundedAlternatives = hasCommerceOptions
      ? alternatives.filter((option) => {
          if (["presentation_mode", "scope_toggle", "surface_opener", "information_only", "navigation", "surface_command"].includes(clean(option.effectRole))) {
            return false;
          }
          return option.effectRole === "commerce_option"
            || hasExactOptionPrice(option)
            || /select_(?:free|paid)_option|decline_paid|add_paid/.test(`${option.physicalEffect || ""} ${option.semantic || ""}`)
            || /radio|option|checkbox|choice/.test(lower(`${controlsById.get(option.controlId)?.kind || ""} ${controlsById.get(option.controlId)?.role || ""} ${controlsById.get(option.controlId)?.domRole || ""}`));
        })
      : alternatives;
    const selectedAlternatives = boundedAlternatives.filter((option) => option.selected === true);
    const exclusive = group.selectionInvariant?.exclusive === true
      || groupControls.some((control) => /radio|option/.test(lower(`${control.kind || ""} ${control.role || ""}`)));
    const selectionInvariantValid = !exclusive || selectedAlternatives.length <= 1;
    const selected = selectionInvariantValid && selectedAlternatives.length === 1
      ? selectedAlternatives[0]
      : null;
    const selectedEvidenceAmount = group.selectedEvidence?.structuredPrice?.amount;
    const hasSelectedEvidenceAmount = selectedEvidenceAmount !== null
      && selectedEvidenceAmount !== undefined
      && selectedEvidenceAmount !== "";
    const nearbySectionText = lower(`${group.sectionLabel || ""} ${page.sections?.find((section) => section.id === group.sectionId)?.label || ""}`);
    const nearbySectionType = /passenger|travell?er/.test(nearbySectionText)
      ? "passenger"
      : /contact/.test(nearbySectionText)
        ? "contact"
        : "";
    const removalControlId = boundedAlternatives.find((option) => (
      option.physicalEffect === "select_free_option"
      || option.semantic === "decline_paid_extra"
      || /^(?:remove|deselect|undo|clear|none|no thanks|without)\b/i.test(clean(option.label))
    ))?.controlId || "";
    return {
      // The observer owns membership, selection and state relationships only.
      // Do not carry its semantic family/status projections into the final
      // DecisionFrame group and then overwrite them field-by-field.
      decisionGroupId: clean(group.decisionGroupId),
      surfaceId: clean(group.surfaceId || "surface-page"),
      surfaceType: clean(group.surfaceType || "page"),
      sectionId: clean(group.sectionId),
      sectionLabel: clean(group.sectionLabel),
      ownerState: group.ownerState || null,
      requirementId: structuralRequirementKey(family, group.sectionLabel),
      subject: family,
      sectionType: family,
      kind: "exclusive_choice",
      // Preserve the observed exclusivity fact separately from the semantic
      // family. A single select/combobox container is an unresolved choice
      // surface, not proof that only one final alternative exists.
      exclusive,
      material: family !== "decision",
      requiredBySite,
      required,
      status: selectionInvariantValid
        ? (selected ? "satisfied" : required ? "missing" : "optional")
        : "conflicted",
      selectedControlId: selected?.controlId || "",
      selectedLabel: exactSelectedControlId && selected?.controlId === exactSelectedControlId
        ? observedSelectedLabel || selected.label || ""
        : selected?.label || "",
      ...(group.selectedEvidence ? {
        selectedEvidence: {
          ...group.selectedEvidence,
          disposition: hasSelectedEvidenceAmount && Number(selectedEvidenceAmount) > 0
            ? "paid"
            : hasSelectedEvidenceAmount && Number(selectedEvidenceAmount) === 0
              ? "free"
              : /add_paid|select_paid|money/.test(lower(`${selected?.semantic || ""} ${selected?.physicalEffect || ""} ${selected?.risk || ""}`))
                ? "paid"
                : /decline_paid|select_free|safe_decline|included/.test(lower(`${selected?.semantic || ""} ${selected?.physicalEffect || ""}`))
                  ? "free"
                  : "unknown"
        }
      } : {}),
      ...(group.selectedEvidence && family === "decision" ? {
        semanticOwnership: ["hypothesis", "resolved"].includes(clean(group.semanticOwnership?.status))
          ? { ...group.semanticOwnership }
          : {
              status: "unknown",
              nearbySectionType
            }
      } : {}),
      ...(groundedHint ? {
        semanticOwnership: {
          status: "resolved",
          family,
          subject: family,
          source: "grounded_semantic_scene",
          authority: "hypothesis_only",
          confidence: groundedHint.confidence === "high" ? 0.95 : 0.82,
          evidence: clean(groundedHint.evidence)
        }
      } : {}),
      selectionInvariant: Object.freeze({
        exclusive,
        valid: selectionInvariantValid,
        selectedCount: selectedAlternatives.length
      }),
      ...(group.selectedEvidence?.selected === true && removalControlId
        ? { removalControlId }
        : {}),
      alternatives: boundedAlternatives,
      alternativeControlIds: boundedAlternatives.map((option) => option.controlId)
    };
  }).filter(Boolean);
  const structurallyOwnedControlIds = new Set(decisionGroups.flatMap((group) => group.alternativeControlIds || []));
  const inferredRepeatedGroups = agentContract.boundedRepeatedChoiceGroups({ ...page, controls }, controls)
    .filter((group) => !(group.alternativeControlIds || []).some((controlId) => structurallyOwnedControlIds.has(controlId)));
  inferredRepeatedGroups.forEach((group) => {
    decisionGroups.push(group);
    (group.alternativeControlIds || []).forEach((controlId) => structurallyOwnedControlIds.add(controlId));
  });
  // Group ownership supplies the missing relation between an actuator and the
  // decision it changes. Publish that contextual meaning on the canonical
  // controls too, so downstream mechanics never sees one meaning on the
  // control and another on its group alternative.
  const ownedAlternativeByControlId = new Map(decisionGroups.flatMap((group) => (
    (group.alternatives || []).map((alternative) => [alternative.controlId, alternative])
  )));
  controls = controls.map((control) => {
    const alternative = ownedAlternativeByControlId.get(control.controlId);
    const owningGroup = decisionGroups.find((group) => (
      (group.alternativeControlIds || []).includes(control.controlId)
    ));
    const amount = alternative?.structuredPrice?.amount;
    const hasAmount = amount !== null && amount !== undefined && amount !== "" && Number.isFinite(Number(amount));
    const interpretedPhysicalEffect = alternative?.physicalEffect
      || (alternative?.included === true || (hasAmount && Number(amount) === 0)
        ? "select_free_option"
        : hasAmount && Number(amount) > 0
          ? "select_paid_option"
          : control.physicalEffect);
    const interpretedSemantic = alternative?.semantic
      || (interpretedPhysicalEffect === "select_free_option"
        ? "decline_paid_extra"
        : interpretedPhysicalEffect === "select_paid_option"
          ? "add_paid_extra"
          : control.semantic);
    return alternative ? {
      ...control,
      decisionGroupId: owningGroup?.decisionGroupId || control.decisionGroupId || "",
      sectionType: owningGroup?.sectionType || control.sectionType || "",
      semantic: interpretedSemantic,
      semanticType: interpretedSemantic,
      physicalEffect: interpretedPhysicalEffect,
      semanticIntent: interpretedPhysicalEffect,
      effectRole: alternative.effectRole || (hasAmount ? "commerce_option" : control.effectRole),
      risk: alternative.risk || (hasAmount && Number(amount) > 0 ? "money" : hasAmount ? "safe" : control.risk),
      structuredPrice: alternative.structuredPrice || control.structuredPrice || null,
      canonicalAttributes: alternative.canonicalAttributes || control.canonicalAttributes || null
    } : control;
  });
  // Final payment ownership is compiled once from interpreted controls. The
  // observer may report a placeholder selector group and a flat set of actual
  // routes, but those are structural presentations of one decision—not two
  // semantic authorities. Keep presentation selectors as owned support nodes;
  // only card/wallet routes are final alternatives.
  const paymentRoutesBySurface = new Map();
  controls.filter((control) => (
    control.semantic === "payment_method"
    && ["card", "wallet"].includes(clean(control.paymentMethodKind))
    && activeRepresentation(control)
  )).forEach((control) => {
    const surfaceId = clean(control.surfaceId || "surface-page");
    if (!paymentRoutesBySurface.has(surfaceId)) paymentRoutesBySurface.set(surfaceId, []);
    paymentRoutesBySurface.get(surfaceId).push(control);
  });
  for (const [surfaceId, routes] of paymentRoutesBySurface) {
    const routeIds = new Set(routes.map((control) => control.controlId));
    const relatedGroups = decisionGroups.filter((group) => (
      clean(group.surfaceId || "surface-page") === surfaceId
      && (
        group.sectionType === "payment_method"
        || (group.alternativeControlIds || []).some((controlId) => routeIds.has(controlId))
      )
    ));
    const presentationControlIds = unique(relatedGroups.flatMap((group) => group.alternativeControlIds || []))
      .filter((controlId) => !routeIds.has(controlId));
    for (let index = decisionGroups.length - 1; index >= 0; index -= 1) {
      if (relatedGroups.includes(decisionGroups[index])) decisionGroups.splice(index, 1);
    }
    const selected = routes.filter((control) => (
      control.selected === true || control.state?.checked === true || control.state?.selected === true
    ));
    const required = relatedGroups.some((group) => group.required === true);
    const decisionGroupId = `dg_payment_method_${surfaceId.replace(/[^a-z0-9]+/gi, "_")}`;
    decisionGroups.push({
      decisionGroupId,
      requirementId: "payment:method",
      surfaceId,
      surfaceType: clean(routes[0].surfaceType || "page"),
      sectionId: clean(relatedGroups[0]?.sectionId),
      sectionLabel: clean(relatedGroups[0]?.sectionLabel || "Payment method"),
      subject: "payment_method",
      sectionType: "payment_method",
      kind: "exclusive_choice",
      material: true,
      requiredBySite: required,
      required,
      status: selected.length ? "satisfied" : required ? "missing" : "optional",
      selectedControlId: selected[0]?.controlId || "",
      selectedLabel: selected[0]?.label || "",
      presentationControlIds,
      alternatives: routes.map((control) => ({
        controlId: control.controlId,
        label: control.label || control.controlId,
        semantic: "payment_method",
        paymentMethodKind: control.paymentMethodKind,
        physicalEffect: "reveal_control",
        effectRole: "payment_route",
        risk: "safe",
        selected: selected.includes(control),
        structuredPrice: null
      })),
      alternativeControlIds: routes.map((control) => control.controlId),
      selectionInvariant: {
        exclusive: true,
        valid: selected.length <= 1,
        selectedCount: selected.length
      }
    });
    const ownedIds = new Set([...routeIds, ...presentationControlIds]);
    controls = controls.map((control) => {
      if (!ownedIds.has(control.controlId)) return control;
      if (routeIds.has(control.controlId)) return {
        ...control,
        decisionGroupId,
        sectionType: "payment_method"
      };
      return {
        ...control,
        decisionGroupId,
        semantic: "payment_presentation",
        semanticType: "payment_presentation",
        physicalEffect: control.operations?.open ? "open_surface" : "unknown",
        effectRole: "presentation_mode",
        risk: "safe"
      };
    });
  }
  const navigationControls = controls.filter((control) => control.physicalEffect === "advance_checkout_stage");
  const navigationCandidates = navigationControls.map((control) => {
    const capability = control.operations?.activate
      || control.operations?.choose
      || control.operations?.open
      || null;
    const actionability = capability?.actionability || null;
    const disabled = control.disabled === true || control.state?.disabled === true;
    const executable = !disabled && actionability?.executable === true;
    return {
      controlId: control.controlId,
      status: disabled ? "disabled" : executable ? "ready" : "blocked",
      executable,
      disabled,
      code: actionability?.code || (disabled ? "CONTROL_DISABLED" : "ACTIONABILITY_UNPROVEN"),
      hitTestEvidence: actionability?.hitTestEvidence || null,
      actionability
    };
  });
  const continueAllowed = navigationCandidates.some((candidate) => candidate.status === "ready");
  return {
    ...page,
    controls,
    decisionGroups,
    validationIssues,
    stageExit: {
      candidates: navigationCandidates,
      controlIds: navigationControls.map((control) => control.controlId),
      continueObserved: navigationControls.length > 0,
      continueDisabled: navigationControls.length > 0 && navigationCandidates.every((candidate) => candidate.disabled),
      continueAllowed,
      blockers: navigationCandidates.filter((candidate) => candidate.status !== "ready"),
      navigationState: !navigationControls.length
        ? "unavailable"
        : continueAllowed
          ? "ready"
          : navigationCandidates.every((candidate) => candidate.disabled)
            ? "disabled"
            : "blocked"
    }
  };
}

function observationHash(observation = {}) {
  return clean(observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash);
}

function surfaceEvidence(page = {}) {
  const surface = page.currentSurface || page.activeSurface || {};
  return Object.freeze({
    id: clean(surface.id || "surface-page"),
    type: clean(surface.type || "page"),
    surfaceClass: clean(surface.surfaceClass || "unknown"),
    label: clean(surface.label),
    blocksBackground: surface.blocksBackground === true
  });
}

function lower(value = "") {
  return clean(value).toLowerCase();
}

function controlEvidenceIds(control = {}) {
  return Object.freeze(unique([
    control.controlId,
    control.stateElementId,
    ...Object.values(control.operations || {}).flatMap((capability) => [
      ...(capability?.actuatorIds || []),
      ...(capability?.strategies || []).map((strategy) => strategy?.actuatorId)
    ])
  ]));
}

function activeRepresentation(control = {}) {
  const lifecycle = control.representationLifecycle || {};
  return lifecycle.status !== "dormant_hidden" && lifecycle.active !== false;
}

function controlConsequence(control = {}) {
  const explicitMeaning = lower([
    control.physicalEffect,
    control.semanticEffect,
    control.semantic,
    control.fieldType,
    control.field,
    control.risk
  ].filter(Boolean).join(" "));
  const evidence = lower([
    explicitMeaning,
    control.label,
    control.name,
    control.autocomplete
  ].filter(Boolean).join(" "));
  const choiceLike = /checkbox|switch/.test(lower(`${control.kind || ""} ${control.role || ""} ${control.inputType || ""}`));
  if (/accept_legal|legal_acceptance|terms_accept|accept_terms|unknown_attestation/.test(explicitMeaning)
    || (choiceLike && /agree|accept|terms|conditions|dangerous goods|declaration/.test(evidence))) {
    return "legal_attestation";
  }
  if (/enter_payment|card_number|card_expiry|security_code|\bcvc\b|\bcvv\b|cc-number|cc-exp|cc-csc/.test(explicitMeaning)
    || /autocomplete[:= ](?:cc-number|cc-exp|cc-csc)|name[:= ](?:cardnumber|card_number|cvv|cvc)/.test(evidence)) {
    return "payment_entry";
  }
  if (/submit_purchase|complete_purchase|confirm_and_pay|pay_now|place_order|book_now/.test(explicitMeaning)
    || (/button|submit/.test(lower(`${control.kind || ""} ${control.role || ""} ${control.inputType || ""}`))
      && /confirm and pay|pay now|complete purchase|place order|book now/.test(evidence))) {
    return "purchase_submission";
  }
  if (/promotion(?:al)?[_ ]?code|promo[_ ]?code|coupon|voucher|discount[_ ]?code/.test(evidence)) {
    return "optional_utility";
  }
  if (/select_paid|add_paid|money|paid_extra|upgrade/.test(evidence)) return "monetary_selection";
  if (/login|log_in|sign_in|authentication|otp|captcha/.test(evidence)) return "authentication";
  if (/advance_checkout|continue|navigation|proceed|next/.test(evidence)) return "checkout_progress";
  if (/set_field|textbox|combobox|select|input/.test(evidence)) return "fact_entry";
  if (/select_free|decline|skip|no_extra/.test(evidence)) return "policy_choice";
  return "unknown";
}

function controlRequiredEvidence(control = {}, validationIssues = []) {
  const state = control.state || {};
  const validation = (validationIssues || []).find((issue) => (
    issue.controlId && issue.controlId === control.controlId
  ));
  if (validation || state.invalid === true || control.invalid === true) return "strong";
  const shape = lower(`${control.role || ""} ${control.kind || ""} ${control.inputType || ""}`);
  if ((control.required === true || state.required === true)
    && /checkbox|radio|switch|option|select|combobox|listbox/.test(shape)) return "structural";
  return (control.required === true || state.required === true) ? "weak" : "none";
}

function unknownRequiredObligation(control = {}, validationIssues = [], ownedEvidenceIds = new Set()) {
  if (!control?.controlId || ownedEvidenceIds.has(control.controlId) || !activeRepresentation(control)) return null;
  const state = control.state || {};
  if (state.valuePresent === true || state.checked === true || state.selected === true || control.selected === true) return null;
  const strength = controlRequiredEvidence(control, validationIssues);
  // Weak HTML-required evidence on an ordinary text field is deliberately
  // retained as evidence but cannot become a blocker by itself.
  if (!["strong", "structural"].includes(strength)) return null;
  const attestation = /checkbox|radio|switch/.test(lower(`${control.role || ""} ${control.kind || ""}`));
  return Object.freeze({
    obligationId: `unknown-required:${clean(control.stableKey || control.controlId)}`,
    kind: attestation ? "unknown_attestation" : "unknown_required",
    semanticType: clean(control.semantic || control.fieldType || (attestation ? "unknown_attestation" : "unknown")),
    controlId: clean(control.controlId),
    surfaceId: clean(control.surfaceId || "surface-page"),
    evidenceIds: controlEvidenceIds(control),
    evidenceStrength: strength,
    status: "unresolved"
  });
}

function validationObligation(issue = {}, page = {}, index = 0) {
  const owner = (page.controls || []).find((control) => control.controlId === issue.controlId) || null;
  return Object.freeze({
    obligationId: `unknown-validation:${clean(issue.issueId || issue.controlId || issue.sectionId || index + 1)}`,
    kind: "unknown_validation",
    semanticType: clean(issue.semanticType || owner?.semantic || owner?.fieldType || "unknown"),
    controlId: clean(issue.controlId),
    surfaceId: clean(issue.surfaceId || owner?.surfaceId || "surface-page"),
    evidenceIds: Object.freeze(unique([issue.issueId, issue.controlId, issue.sectionId, ...controlEvidenceIds(owner || {})])),
    evidenceStrength: "strong",
    evidence: clean(issue.message || issue.text || issue.label || issue),
    status: "unresolved"
  });
}

function compileUnresolvedEvidence({
  page = {},
  profileRequirements = [],
  commerceEntities = []
} = {}) {
  const controls = (page.controls || []).filter(activeRepresentation);
  const activeValidation = activeValidationIssues(page.validationIssues || []);
  const validationObligations = activeValidation.map((issue, index) => validationObligation(issue, page, index));
  const recognizedEvidenceIds = [
    ...profileRequirements.flatMap((descriptor) => controlEvidenceIds(descriptor.control || {})),
    ...commerceEntities.flatMap((group) => unique([
      group.selectedControlId,
      ...(group.alternativeControlIds || []),
      ...(group.alternatives || []).map((option) => option.controlId)
    ])),
    ...controls
      .filter((control) => controlConsequence(control) !== "unknown")
      .flatMap(controlEvidenceIds)
  ];
  const ownedEvidenceIds = new Set([
    ...validationObligations
  ].flatMap((obligation) => obligation.evidenceIds || []).concat(recognizedEvidenceIds).filter(Boolean));
  const unknownRequiredObligations = controls
    .map((control) => unknownRequiredObligation(control, activeValidation, ownedEvidenceIds))
    .filter(Boolean);
  return Object.freeze([...validationObligations, ...unknownRequiredObligations]);
}

function createObservationFrame(observation = {}) {
  const page = observation.page || {};
  return Object.freeze({
    contractVersion: OBSERVATION_FRAME_VERSION,
    observationId: clean(observation.observationId),
    observationHash: observationHash(observation),
    previousObservationId: clean(observation.previousObservation?.observationId),
    url: clean(page.url),
    stageEvidence: Object.freeze({
      observedStep: clean(page.step),
      routePath: clean(page.routePath),
      evidence: freezeArray(page.stepEvidence || page.stageEvidence || [])
    }),
    surface: surfaceEvidence(page),
    mechanics: Object.freeze({
      // Controls are already immutable observation evidence addressed by the
      // observation hash. Referencing them avoids copying high-cardinality
      // seat maps merely to wrap the frame.
      controls: arrayReference(page.controls),
      viewport: page.viewport || null
    }),
    evidence: Object.freeze({
      transactionFacts: page.transactionFacts || null,
      terminalEvidence: page.terminalEvidence || null,
      validationIssues: freezeArray(page.validationIssues),
      errors: freezeArray(page.errors),
      mutationIdentity: clean(observation.observationUpdate?.diff?.identity || observation.mutationIdentity),
      previousActionResult: observation.lastActionResult || null
    })
  });
}

function decisionFrameControl(control = {}) {
  if (control.semanticAuthority !== "semantic-checkout-compiler/v1") {
    throw new Error("DECISION_FRAME_REQUIRES_CANONICAL_SEMANTIC_COMPILATION");
  }
  const { browserSemanticHint: _discardedBrowserMeaning, ...canonical } = control;
  return Object.freeze({
    ...canonical,
    semanticAuthority: DECISION_FRAME_VERSION
  });
}

function decisionFrameGroup(group = {}) {
  return Object.freeze({
    ...group,
    semanticAuthority: DECISION_FRAME_VERSION,
    alternatives: Object.freeze((group.alternatives || []).map((alternative) => Object.freeze({
      ...alternative,
      semanticAuthority: DECISION_FRAME_VERSION
    })))
  });
}

function canonicalSemanticCompilation(compilation = {}, interpretedPage = {}) {
  const interpretedControlIds = new Set((interpretedPage.controls || []).map((control) => clean(control.controlId)));
  const controls = (compilation.controls || []).filter((control) => (
    interpretedControlIds.has(clean(control.controlId))
  )).map(decisionFrameControl);
  const interpretedGroupIds = new Set((interpretedPage.decisionGroups || []).map((group) => clean(group.decisionGroupId)));
  const decisionGroups = (compilation.decisionGroups || []).filter((group) => (
    interpretedGroupIds.has(clean(group.decisionGroupId))
  )).map(decisionFrameGroup);
  return Object.freeze({
    ...compilation,
    semanticAuthority: DECISION_FRAME_VERSION,
    controls: Object.freeze(controls),
    decisionGroups: Object.freeze(decisionGroups),
    decisionContracts: Object.freeze(decisionGroups.map((group) => group.decisionContract).filter(Boolean))
  });
}

function structuralPageForDecisionFrame(rawPage = {}) {
  const stripSurfaceMeaning = (surface = null) => {
    if (!surface || typeof surface !== "object") return surface;
    const {
      taskHint: _taskHint,
      surfaceClass: _surfaceClass,
      parentSectionType: _parentSectionType,
      expectedResolution: _expectedResolution,
      ...structuralSurface
    } = surface;
    return structuralSurface;
  };
  const structuralPage = {
    ...rawPage,
    // Browser stage/surface classifiers remain available in the immutable raw
    // ObservationFrame for diagnostics. They do not enter the semantic
    // compiler as business meaning; DecisionFrame and TaskState derive meaning
    // from labels, relationships, current state, controls, and typed evidence.
    browserDiagnostics: {
      ...(rawPage.browserDiagnostics || {}),
      step: clean(rawPage.browserDiagnostics?.step || rawPage.step),
      stepEvidence: rawPage.browserDiagnostics?.stepEvidence || rawPage.stepEvidence || null,
      currentSurface: {
        ...(rawPage.browserDiagnostics?.currentSurface || {}),
        taskHint: clean(rawPage.browserDiagnostics?.currentSurface?.taskHint || rawPage.currentSurface?.taskHint),
        surfaceClass: clean(rawPage.browserDiagnostics?.currentSurface?.surfaceClass || rawPage.currentSurface?.surfaceClass),
        expectedResolution: clean(rawPage.browserDiagnostics?.currentSurface?.expectedResolution || rawPage.currentSurface?.expectedResolution)
      }
    },
    step: "",
    stepEvidence: null,
    currentSurface: stripSurfaceMeaning(rawPage.currentSurface),
    activeSurface: stripSurfaceMeaning(rawPage.activeSurface),
    surfaceStack: (rawPage.surfaceStack || []).map(stripSurfaceMeaning)
  };
  if (structuralPage.currentSurface && typeof structuralPage.currentSurface === "object") {
    structuralPage.currentSurface = {
      ...structuralPage.currentSurface,
      surfaceClass: surfaceClassFrom(structuralPage)
    };
  }
  return structuralPage;
}

function compileDecisionFrame({
  observation = {},
  observationFrame = null,
  state = {},
  traveler = {}
} = {}) {
  const sourceFrame = observationFrame || createObservationFrame(observation);
  if (sourceFrame.observationId !== clean(observation.observationId)
    || sourceFrame.observationHash !== observationHash(observation)) {
    throw new Error("DECISION_FRAME_OBSERVATION_MISMATCH");
  }
  const rawPage = observation.page || {};
  const hasGroundedHints = [
    rawPage.semanticFieldHints,
    rawPage.semanticValidationHints,
    rawPage.semanticControlHints,
    rawPage.semanticDecisionHints
  ].some((hints) => Array.isArray(hints) && hints.length > 0);
  const structuralSourcePage = rawPage.observationContract === "structural-observation/v1"
    ? structuralPageForDecisionFrame(rawPage)
    : rawPage;
  let interpretedPage = rawPage.observationContract === "structural-observation/v1" || hasGroundedHints
    ? interpretStructuralPage(structuralSourcePage)
    : rawPage;
  if (rawPage.observationContract === "structural-observation/v1"
    && interpretedPage.currentSurface
    && typeof interpretedPage.currentSurface === "object"
    && clean(interpretedPage.currentSurface.type || "page").toLowerCase() !== "page") {
    interpretedPage = {
      ...interpretedPage,
      currentSurface: {
        ...interpretedPage.currentSurface,
        surfaceClass: surfaceClassFrom(interpretedPage)
      }
    };
  }
  const deterministicCompilation = agentContract.compileSemanticCheckout(interpretedPage);
  const compilation = canonicalSemanticCompilation(deterministicCompilation, interpretedPage);
  const semanticPage = {
    ...interpretedPage,
    selectedBooking: rawPage.selectedBooking || state.transactionInvariants?.baseline || null,
    controls: compilation.controls,
    decisionGroups: compilation.decisionGroups,
    decisionContracts: compilation.decisionContracts,
    semanticReadiness: compilation.semanticReadiness,
    semanticCompilation: compilation
  };
  // Validation ownership is structural, while the owner's semantic type is a
  // DecisionFrame result. Enrich the canonical issue here so no browser
  // classifier or downstream reducer has to reinterpret the field.
  const semanticControlsById = new Map(compilation.controls.map((control) => [clean(control.controlId), control]));
  semanticPage.validationIssues = Object.freeze((semanticPage.validationIssues || []).map((issue) => {
    const owner = semanticControlsById.get(clean(issue.controlId || issue.ownerControlId));
    return Object.freeze(owner ? {
      ...issue,
      semanticType: clean(owner.fieldType || owner.semanticType || owner.semantic || issue.semanticType)
    } : { ...issue });
  }));
  if (semanticPage.currentSurface
    && typeof semanticPage.currentSurface === "object"
    && clean(semanticPage.currentSurface.type || "page").toLowerCase() !== "page") {
    semanticPage.currentSurface = Object.freeze({
      ...semanticPage.currentSurface,
      surfaceClass: surfaceClassFrom(semanticPage)
    });
  }
  const semanticObservation = {
    ...observation,
    page: semanticPage,
    observationSnapshot: observation.observationSnapshot
      ? Object.freeze({ ...observation.observationSnapshot, controls: compilation.controls })
      : observation.observationSnapshot
  };
  const transactionFacts = factsFromObservation(state, semanticObservation, traveler, {
    authoritativeTransactionFacts: interpretedPage.transactionFacts || null
  });
  const page = Object.freeze({ ...semanticPage, transactionFacts });
  const compiledObservation = Object.freeze({ ...semanticObservation, page });
  // Logical profile descriptors are compiled exactly once into DecisionFrame.
  // TaskState may reconcile them with durable verified outcomes, but must not
  // rediscover field meaning from the DOM a second time.
  const profileRequirements = fieldDescriptors(compiledObservation, traveler);
  const unresolvedEvidence = compileUnresolvedEvidence({
    page,
    profileRequirements,
    commerceEntities: compilation.decisionGroups || []
  });
  return Object.freeze({
    contractVersion: DECISION_FRAME_VERSION,
    frameId: `${sourceFrame.observationId || "observation"}:${sourceFrame.observationHash || "unhashed"}:decision-v2`,
    observationId: sourceFrame.observationId,
    observationHash: sourceFrame.observationHash,
    observationFrame: sourceFrame,
    observation: compiledObservation,
    semanticCompilation: compilation,
    profileRequirements: freezeArray(profileRequirements),
    commerceEntities: freezeArray(compilation.decisionGroups || []),
    navigationDiagnostics: page.stageExit || null,
    transactionFacts,
    terminalEvidence: page.terminalEvidence || null,
    validationBlockers: arrayReference(page.validationIssues),
    unresolvedEvidence,
    provenance: Object.freeze({
      compiler: "agent-contract.compileSemanticCheckout",
      compilerVersion: clean(compilation.contractVersion || agentContract.CONTRACT_VERSION),
      sourceObservationId: sourceFrame.observationId,
      sourceObservationHash: sourceFrame.observationHash
    })
  });
}

function decisionFrameOwnsObservation(decisionFrame = null, observation = {}) {
  return Boolean(
    decisionFrame?.contractVersion === DECISION_FRAME_VERSION
    && decisionFrame.observationId === clean(observation.observationId)
    && decisionFrame.observationHash === observationHash(observation)
  );
}

function admittedControlIds(goal = {}) {
  const explicit = unique([...(goal.candidateControlIds || []), ...(goal.actionableControlIds || [])]);
  if (explicit.length) return explicit;
  if (goal.policyChoiceBounded === true) return unique(goal.policyAllowedControlIds || []);
  if (goal.kind === "profile_field") {
    return unique([
      goal.controlId,
      goal.componentBinding?.controlId,
      ...(goal.componentBinding?.representationControlIds || []),
      ...(goal.componentBinding?.stateControlIds || [])
    ]);
  }
  return unique(goal.eligibleAlternativeControlIds || []);
}

function obligationDesiredEffect(goal = {}) {
  const explicit = clean(goal.semanticEffect || goal.desiredSemanticOutcome || goal.desiredPolicyOutcome);
  if (explicit) return agentContract.canonicalSemanticEffect(explicit);
  if (goal.kind === "profile_field") return agentContract.SEMANTIC_EFFECT.SET_FIELD_VALUE;
  if (goal.semanticType === "navigation") return agentContract.SEMANTIC_EFFECT.ADVANCE_CHECKOUT_STAGE;
  if (goal.semanticType === "completed_choice_surface") return agentContract.SEMANTIC_EFFECT.DISMISS_SURFACE;
  return agentContract.canonicalSemanticEffect("resolve_current_decision");
}

function assertObligationConformance({ goal = {}, controls = [], successCondition = {} } = {}) {
  if (successCondition.type !== "decision_group_resolved") return;
  const eligible = new Set(unique(successCondition.eligibleAlternativeControlIds || []));
  if (eligible.size && controls.some((controlId) => !eligible.has(controlId))) {
    const error = new Error(
      `CURRENT_OBLIGATION_CONTROL_CANNOT_SATISFY_SUCCESS_CONDITION:admitted=${controls.join(",")};eligible=${[...eligible].join(",")}`
    );
    error.admittedControlIds = controls;
    error.eligibleAlternativeControlIds = [...eligible];
    throw error;
  }
}

function compileCurrentObligation({ work = null, decisionFrame = null } = {}) {
  if (!work) return null;
  const goal = work;
  const desiredStateDelta = goal.desiredStateDelta || null;
  const controls = unique(desiredStateDelta?.admittedControlIds || []);
  const successCondition = goal.successCondition || goal.postcondition || goal.outcomeContract || {};
  assertObligationConformance({ goal, controls, successCondition });
  if (!desiredStateDelta
    || desiredStateDelta.contractVersion !== "desired-state-delta/v1"
    || desiredStateDelta.status !== "EXACT_DELTA"
    || desiredStateDelta.actionRequired !== true) {
    return null;
  }
  const owner = normalizeSemanticOwner({
    stage: goal.semanticOwner?.stage || "checkout",
    family: (goal.kind === "profile_field" || desiredStateDelta?.kind === "profile_field")
      ? goal.semanticType || goal.semanticOwner?.family
      : goal.canonicalSubject?.family || goal.subject?.family || goal.family || goal.sectionType || goal.semanticType || goal.semanticOwner?.family,
    subjectId: goal.subjectId || goal.semanticOwner?.subjectId || "global",
    passengerId: goal.canonicalSubject?.passengerId || goal.passengerId || goal.travelerId || goal.semanticOwner?.passengerId,
    segmentId: goal.canonicalSubject?.segmentId || goal.segmentId || goal.semanticOwner?.segmentId,
    repeatedInstance: goal.canonicalSubject?.repeatedInstance
      || goal.semanticOwner?.repeatedInstance
      || goal.logicalFieldId
      || goal.canonicalOwnerId
      || goal.requirementId
      || goal.decisionGroupId
      || goal.decisionInstanceId
      || goal.semanticType
      || goal.kind
      || "global"
  });
  const ownerId = semanticOwnerId(owner);
  const delta = Object.freeze({
    ...desiredStateDelta,
    kind: clean(desiredStateDelta.kind || goal.kind || goal.semanticType || "unknown"),
    desiredValue: desiredStateDelta.desiredValue ?? goal.desiredValue ?? goal.canonicalValue ?? "",
    desiredEffect: clean(desiredStateDelta.desiredEffect || obligationDesiredEffect(goal))
  });
  const obligation = {
    contractVersion: CURRENT_OBLIGATION_VERSION,
    // TaskState work IDs survive observation replacement and remain the
    // stable identity shared by the ActionLease and browser result.
    id: clean(goal.goalId || goal.requirementId || goal.decisionGroupId || `obligation:${ownerId}`),
    observationId: clean(decisionFrame?.observationId || goal.observationId),
    decisionFrameId: clean(decisionFrame?.frameId),
    semanticOwner: owner,
    desiredStateDelta: delta,
    admittedControlIds: freezeArray(controls),
    riskClass: clean(goal.riskClass || goal.risk || "reversible"),
    successCondition: Object.freeze({ ...successCondition })
  };
  return Object.freeze(obligation);
}

function currentObligation(taskState = {}) {
  const obligation = taskState?.currentObligation || null;
  return obligation?.contractVersion === CURRENT_OBLIGATION_VERSION ? obligation : null;
}

module.exports = {
  CURRENT_OBLIGATION_VERSION,
  DECISION_FRAME_VERSION,
  OBSERVATION_FRAME_VERSION,
  compileDecisionFrame,
  createObservationFrame,
  currentObligation,
  compileCurrentObligation,
  decisionFrameOwnsObservation
};
