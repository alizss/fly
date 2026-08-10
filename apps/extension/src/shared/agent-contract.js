(function initializeAgentContract(root, factory) {
  const contract = factory();
  if (typeof module === "object" && module.exports) module.exports = contract;
  if (root && typeof root === "object") root.AtwAgentContract = contract;
})(typeof globalThis !== "undefined" ? globalThis : this, function agentContractFactory() {
  "use strict";

  const CONTRACT_VERSION = "agent-contract/v1";
  const TERMINAL_EVIDENCE_VERSION = "terminal-evidence/v1";
  const CAPABILITY_STATUS = Object.freeze({
    PROVEN_EXECUTABLE: "proven_executable",
    RECOVERABLE: "recoverable",
    UNPROVEN_EXPERIMENT: "unproven_experiment",
    UNAVAILABLE: "unavailable"
  });
  const INTERACTION_METHOD = Object.freeze({
    DIRECT_INPUT: "direct_input",
    NATIVE_SELECT: "native_select",
    NATIVE_CLICK: "native_click",
    POINTER_SEQUENCE: "pointer_sequence",
    FOCUS_ENTER: "focus_enter",
    FOCUS_SPACE: "focus_space",
    FOCUS_ARROW_DOWN: "focus_arrow_down",
    VISUAL_COORDINATE: "visual_coordinate",
    BROWSER_TRUSTED_INPUT: "browser_trusted_input",
    BROWSER_TRUSTED_CHOICE: "browser_trusted_choice"
  });
  const EXECUTION_LANE = Object.freeze({
    NORMAL: "normal",
    REVEAL: "reveal",
    BOUNDED_RECOVERY: "bounded_recovery",
    DENY: "deny"
  });
  const DECISION_KIND = Object.freeze({
    VALUE_FIELD: "value_field",
    EXCLUSIVE_CHOICE: "exclusive_choice",
    OPTIONAL_TOGGLE: "optional_toggle",
    NAVIGATION: "navigation"
  });
  const SEMANTIC_READINESS = Object.freeze({
    TRANSIENT: "transient",
    UNRESOLVED: "unresolved",
    READY: "ready",
    TERMINAL: "terminal"
  });
  const SEMANTIC_EFFECT = Object.freeze({
    SET_FIELD_VALUE: "set_field_value",
    SELECT_FREE_OPTION: "select_free_option",
    SELECT_PAID_OPTION: "select_paid_option",
    DECLINE_PAID_EXTRA: "decline_paid_extra",
    REMOVE_PAID_SELECTION: "remove_paid_selection",
    RANDOM_ASSIGNMENT: "random_assignment",
    ADVANCE_CHECKOUT_STAGE: "advance_checkout_stage",
    DISMISS_SURFACE: "dismiss_surface",
    SAFE_CHECKOUT_PROGRESS: "safe_checkout_progress",
    UNKNOWN: "unknown"
  });
  const SEMANTIC_EFFECT_ALIASES = Object.freeze({
    selected_free_option: SEMANTIC_EFFECT.SELECT_FREE_OPTION,
    select_free_alternative: SEMANTIC_EFFECT.SELECT_FREE_OPTION,
    decline_paid_extra: SEMANTIC_EFFECT.SELECT_FREE_OPTION,
    remove_paid_selection: SEMANTIC_EFFECT.SELECT_FREE_OPTION,
    safe_decline: SEMANTIC_EFFECT.SELECT_FREE_OPTION,
    decline_baggage: SEMANTIC_EFFECT.SELECT_FREE_OPTION,
    free_or_no_extra: SEMANTIC_EFFECT.SELECT_FREE_OPTION,
    selected_paid_option: SEMANTIC_EFFECT.SELECT_PAID_OPTION,
    add_paid_extra: SEMANTIC_EFFECT.SELECT_PAID_OPTION,
    choose_paid_option: SEMANTIC_EFFECT.SELECT_PAID_OPTION,
    selected_paid_extra: SEMANTIC_EFFECT.SELECT_PAID_OPTION,
    advance: SEMANTIC_EFFECT.ADVANCE_CHECKOUT_STAGE,
    next_stage: SEMANTIC_EFFECT.ADVANCE_CHECKOUT_STAGE
  });

  function canonicalSemanticEffect(value = "") {
    const normalized = String(value || "").toLowerCase().replace(/[\s-]+/g, "_").trim();
    return SEMANTIC_EFFECT_ALIASES[normalized] || normalized || SEMANTIC_EFFECT.UNKNOWN;
  }

  function semanticEffectSatisfies(desiredEffect = "", observedEffect = "") {
    const desired = canonicalSemanticEffect(desiredEffect);
    const observed = canonicalSemanticEffect(observedEffect);
    if (desired === observed) return true;
    const compatible = {
      [SEMANTIC_EFFECT.RANDOM_ASSIGNMENT]: [SEMANTIC_EFFECT.SELECT_FREE_OPTION]
    };
    return (compatible[desired] || []).includes(observed);
  }

  const NON_COMMERCE_EFFECT_ROLES = Object.freeze(new Set([
    "scope_toggle",
    "information_only",
    "navigation",
    "presentation_mode"
  ]));

  function commerceNumber(value) {
    if (value == null || value === "" || typeof value === "object") return null;
    const parsed = Number(String(value).replace(",", ".").replace(/[^0-9.-]/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }

  function commerceToken(value = "") {
    return String(value || "").toLowerCase().replace(/[\s-]+/g, "_").trim();
  }

  // Typed prospective commerce classification. UI labels are intentionally
  // excluded: a seat-map mode toggle cannot become a paid transaction merely
  // because its copy contains a price or "add to cart".
  function isPaidCommerceOption(value = {}) {
    const effectRole = commerceToken(value.effectRole || value.selectionRole);
    if (NON_COMMERCE_EFFECT_ROLES.has(effectRole)) return false;
    const amount = commerceNumber(
      value.priceAmount
      ?? value.amount
      ?? value.structuredPrice?.amount
      ?? value.price?.amount
    );
    const disposition = commerceToken(value.disposition || value.outcome);
    const semanticEffect = canonicalSemanticEffect(
      value.semanticEffect || value.physicalEffect || value.mechanicalEffect || value.semantic
    );
    if (["free", "declined", "decline_free_no_extra", "included", "waived"].includes(disposition)) return false;
    return Number(amount) > 0
      || disposition === "paid"
      || semanticEffect === SEMANTIC_EFFECT.SELECT_PAID_OPTION;
  }

  // One authority for observed paid truth. A paid-looking representation is
  // a selected commerce item only when fresh evidence owns both the decision
  // and the selected control.
  function classifySelectedCommerceTruth(value = {}) {
    const decisionGroupId = String(
      value.decisionGroupId || value.requirementId || value.ownerId || ""
    ).trim();
    const selectedControlId = String(
      value.selectedControlId || value.controlId || value.selectedEvidence?.selectedControlId || ""
    ).trim();
    const selectionOwnerId = String(
      value.selectionOwnerId
      || value.ownerElementId
      || value.selectedEvidence?.ownerElementId
      || ""
    ).trim();
    const selected = value.selected === true
      || value.checked === true
      || value.currentState?.selected === true
      || value.selectedEvidence?.selected === true;
    const effectRole = commerceToken(
      value.effectRole
      || value.currentState?.effectRole
      || value.selectedEvidence?.effectRole
    );
    const transactionOwned = value.transactionOwned === true;
    const ownedSelection = Boolean(
      decisionGroupId
      && selected
      && (selectedControlId || selectionOwnerId || transactionOwned)
    );
    const paidOption = isPaidCommerceOption({
      ...value,
      effectRole,
      priceAmount: value.priceAmount
        ?? value.amount
        ?? value.priceRisk?.amount
        ?? value.selectedEvidence?.structuredPrice?.amount,
      disposition: value.disposition
        ?? value.outcome
        ?? value.selectedEvidence?.disposition,
      semanticEffect: value.semanticEffect
        ?? value.physicalEffect
        ?? value.selectedEvidence?.semantic
    });
    return Object.freeze({
      selectedPaid: Boolean(ownedSelection && paidOption),
      selected: Boolean(selected),
      ownedSelection,
      paidOption,
      decisionGroupId,
      selectedControlId,
      selectionOwnerId,
      transactionOwned,
      effectRole: effectRole || "unknown"
    });
  }

  function isGenuineSelectedPaidItem(value = {}) {
    return classifySelectedCommerceTruth(value).selectedPaid;
  }
  const DECISION_AVAILABILITY = Object.freeze({
    ACTIVE: "active",
    REVEALABLE: "revealable",
    INACTIVE: "inactive"
  });
  const PROFILE_FIELD_ALIAS_GROUPS = Object.freeze({
    title: ["title", "traveler_title", "traveller_title", "salutation", "gender_title", "honorific"],
    gender: ["gender", "sex"],
    first_name: ["first_name", "firstname", "given_name", "forename"],
    given_names: ["given_names", "first_middle_name", "first_and_middle_name", "forenames"],
    middle_name: ["middle_name", "middlename", "additional_name"],
    last_name: ["last_name", "lastname", "surname", "family_name"],
    second_last_name: ["second_last_name", "second_surname", "additional_surname", "maternal_surname"],
    full_name: ["full_name", "fullname", "passenger_name", "traveler_name", "traveller_name"],
    email: ["email", "email_address", "e_mail"],
    confirm_email: ["confirm_email", "email_confirmation", "repeat_email", "confirm_email_address"],
    phone: ["phone", "phone_number", "mobile", "mobile_number", "telephone", "tel"],
    phone_country_code: ["phone_country_code", "country_dial_code", "dial_code", "calling_code", "country_calling_code"],
    date_of_birth: ["date_of_birth", "birth_date", "birthdate", "dob", "bday"],
    age_at_departure: ["age_at_departure", "travel_age", "departure_age", "age_on_departure", "age_at_time_of_travel"],
    place_of_birth: ["place_of_birth", "birth_place", "birth_city"],
    nationality: ["nationality", "citizenship", "country_of_citizenship", "passport_nationality"],
    country_of_residence: ["country_of_residence", "residence_country", "resident_country"],
    document_type: ["document_type", "travel_document_type", "identity_document_type", "id_type"],
    passport_number: ["passport_number", "passport_no"],
    document_number: ["document_number", "travel_document_number", "identity_document_number"],
    issuing_country: ["issuing_country", "document_issuing_country", "passport_issuing_country"],
    document_issue_date: ["document_issue_date", "passport_issue_date", "date_of_issue", "issue_date"],
    address_line1: ["address_line1", "address1", "street_address", "billing_address", "billing_address_line1"],
    address_line2: ["address_line2", "address2", "billing_address_line2"],
    city: ["city", "address_city", "billing_city", "locality"],
    state: ["state", "province", "region", "address_state", "billing_state"],
    postal_code: ["postal_code", "postcode", "zip", "zip_code", "billing_postal_code"],
    country: ["country", "address_country", "billing_country", "country_name"],
    passport_expiry: ["passport_expiry", "passport_expiration", "passport_expiry_date"],
    document_expiry: ["document_expiry", "document_expiration", "document_expiry_date"],
    frequent_flyer_program: ["frequent_flyer_program", "loyalty_program", "airline_loyalty_program"],
    frequent_flyer_number: ["frequent_flyer_number", "loyalty_number", "membership_number"],
    known_traveler_number: ["known_traveler_number", "known_traveller_number", "ktn"],
    redress_number: ["redress_number", "redress_control_number"],
    emergency_contact_name: ["emergency_contact_name", "emergency_name", "sos_name", "sosname"],
    emergency_contact_relationship: ["emergency_contact_relationship", "emergency_relationship"],
    emergency_contact_phone: ["emergency_contact_phone", "emergency_phone", "sos_phone", "sosphone"],
    emergency_contact_email: ["emergency_contact_email", "emergency_email"],
    meal_preference: ["meal_preference", "meal_request", "special_meal"],
    special_assistance: ["special_assistance", "assistance_request", "accessibility_request"],
    travel_purpose: [
      "travel_purpose",
      "trip_purpose",
      "journey_purpose",
      "purpose_of_travel",
      "reason_for_travel",
      "reason_for_travel_radio_input",
      "business_or_leisure"
    ]
  });
  const PROFILE_FIELD_ALIASES = new Map(Object.entries(PROFILE_FIELD_ALIAS_GROUPS)
    .flatMap(([canonical, aliases]) => aliases.map((alias) => [alias, canonical])));
  const PROFILE_FIELD_TYPES = Object.freeze([...new Set(PROFILE_FIELD_ALIASES.values())]);

  function text(value, limit = 500) {
    return String(value == null ? "" : value).slice(0, limit);
  }

  function cloneSerializable(value, state = null) {
    const context = state || { seen: new WeakSet(), depth: 0 };
    if (value == null || ["string", "number", "boolean"].includes(typeof value)) return value;
    if (typeof value === "bigint") return String(value);
    if (typeof value === "function" || typeof value === "symbol") return undefined;
    if (context.depth > 16) return undefined;
    if (typeof Node !== "undefined" && value instanceof Node) return undefined;
    if (typeof value !== "object") return undefined;
    if (context.seen.has(value)) return undefined;
    context.seen.add(value);
    const next = { seen: context.seen, depth: context.depth + 1 };
    if (Array.isArray(value)) {
      const result = value.map((item) => cloneSerializable(item, next)).filter((item) => item !== undefined);
      context.seen.delete(value);
      return result;
    }
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      const cloned = cloneSerializable(item, next);
      if (cloned !== undefined) result[key] = cloned;
    }
    context.seen.delete(value);
    return result;
  }

  function normalizedText(value = "") {
    return text(value, 4000).replace(/\s+/g, " ").trim();
  }

  function normalizedKey(value = "") {
    return normalizedText(value)
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 100);
  }

  function canonicalProfileFieldType(value = "") {
    const normalized = normalizedKey(value);
    if (PROFILE_FIELD_ALIASES.has(normalized)) return PROFILE_FIELD_ALIASES.get(normalized);
    const withoutSubject = normalized
      .replace(/^(?:passengers?|travell?ers?|adults?)_\d+_/, "")
      .replace(/^(?:contact|profile)_/, "");
    if (PROFILE_FIELD_ALIASES.has(withoutSubject)) return PROFILE_FIELD_ALIASES.get(withoutSubject);
    if (/(?:^|_)(?:birth|dob|bday)_(?:day|month|year)(?:_|$)/.test(normalized)) return "date_of_birth";
    if (/(?:passport|document|id)_(?:expiry|expiration)_(?:day|month|year)/.test(normalized)) {
      return normalized.includes("passport") ? "passport_expiry" : "document_expiry";
    }
    if (/(?:passport|document|id)_(?:issue|issued)_(?:day|month|year)/.test(normalized)) return "document_issue_date";
    if (/^(?:passport_)?nationality$|^country_of_citizenship$/.test(withoutSubject)) return "nationality";
    if (/^(?:travell?er_)?title$|^salutation$|^gender_title$/.test(withoutSubject)) return "title";
    if (/^(?:passport_)?id_number$|^travel_document_(?:number|no)$/.test(withoutSubject)) {
      return withoutSubject.startsWith("passport") ? "passport_number" : "document_number";
    }
    return "";
  }

  function paymentCredentialKindsFromText(value = "") {
    const visible = normalizedText(value).toLowerCase();
    const kinds = [];
    if (/\bcard\s*(?:number|no\.?|#)\b|\bcc-number\b/.test(visible)) kinds.push("card_number");
    if (/\b(?:expiry|expiration|valid\s+through)\b|\bcc-exp\b/.test(visible)) kinds.push("card_expiry");
    if (/\b(?:cvc|cvv|security\s+code)\b|\bcc-csc\b/.test(visible)) kinds.push("card_security_code");
    if (/\bcardholder\b|\bname\s+on\s+card\b/.test(visible)) kinds.push("cardholder");
    return kinds;
  }

  function isLegalAcceptanceText(value = "") {
    const visible = normalizedText(value).toLowerCase();
    if (!visible) return false;
    return /\b(?:accept|agree|confirm|acknowledge|read and accepted|aged?\s+18)\b/.test(visible)
      && /\b(?:terms|conditions|fare rules|booking terms|cancellation terms|privacy|dangerous goods|legal)\b/.test(visible);
  }

  function isInsuranceOfferText(value = "") {
    const visible = normalizedText(value).toLowerCase();
    if (!visible || isLegalAcceptanceText(visible)) return false;
    return /\b(?:travel|trip|cancellation|luggage|baggage)?\s*(?:insurance|protection|cover)\b|\bvoucher refund\b|\brefund protection\b/.test(visible);
  }

  function isPaymentCommitText(value = "") {
    const visible = normalizedText(value).toLowerCase();
    return /\b(?:pay(?:\s+now|\s+securely|\s+by\s+(?:card|bank|wallet)|\s+[\d.,])|confirm\s+and\s+pay|submit\s+payment|complete\s+purchase|place\s+order)\b/.test(visible);
  }

  function terminalSignalState(present, negativeEvidence = false) {
    if (present === true) return "present";
    return negativeEvidence === true ? "absent" : "unknown";
  }

  // Payment controls are terminal evidence, never executable capabilities.
  // This compiler is shared by browser perception, readiness and TaskState so
  // those layers cannot independently reinterpret payment-looking page copy.
  function compileTerminalEvidence(input = {}) {
    const page = input?.page && typeof input.page === "object" ? input.page : input;
    const supplied = page?.terminalEvidence;
    if (supplied?.contractVersion === TERMINAL_EVIDENCE_VERSION) {
      const signals = supplied.signals || {};
      const signalCount = Object.values(signals).filter(Boolean).length;
      const boundaryObserved = supplied.boundaryObserved === true || supplied.verified === true;
      return Object.freeze({
        ...cloneSerializable(supplied),
        contractVersion: TERMINAL_EVIDENCE_VERSION,
        stage: boundaryObserved ? "payment_review" : "unknown",
        signals: Object.freeze({ ...signals }),
        signalCount,
        boundaryObserved,
        verified: boundaryObserved,
        capabilities: Object.freeze({ paymentActionsAllowed: false })
      });
    }

    const structural = page?.terminalStructure || page?.structuralEvidence || {};
    const url = normalizedText(page?.url || input?.url || "").toLowerCase();
    const visible = normalizedText([
      page?.visibleText,
      page?.fullText,
      page?.text,
      page?.heading,
      page?.title,
      input?.visibleText,
      input?.headingText
    ].filter(Boolean).join(" ")).toLowerCase();
    const activeProgress = normalizedText(
      structural.activeProgressText || input?.activeProgressText || ""
    ).toLowerCase();
    const route = /(?:^|[\/#?&_-])payments?(?:[\/#?&=_-]|$)/.test(url);
    const progress = structural.activePaymentProgress === true || /\bpayment\b|\bpay\b/.test(activeProgress);
    const nativeCredentialKinds = structural.paymentCredentialKinds || [];
    const ownedCredentialKinds = [
      ...(structural.paymentCredentialLabelKinds || []),
      ...(structural.hostedPaymentCredentialKinds || [])
    ];
    const credentialKinds = new Set([...nativeCredentialKinds, ...ownedCredentialKinds]);
    const structuralPaymentProbe = Object.prototype.hasOwnProperty.call(structural, "paymentCredentialCount")
      || Object.prototype.hasOwnProperty.call(structural, "paymentFormPresent")
      || Object.prototype.hasOwnProperty.call(structural, "paymentCredentialKinds");
    // A native-control probe can be empty when a payment provider owns its
    // inputs inside an opaque iframe/custom widget. Empty native evidence is
    // therefore unknown, not authoritative absence. Visible credential copy
    // may contribute only when perception tied it to a visible payment owner.
    const visibleFallbackAllowed = !structuralPaymentProbe
      || structural.paymentOwnerPresent === true
      || structural.visibleTextFallbackAllowed === true;
    if (visibleFallbackAllowed) {
      paymentCredentialKindsFromText(visible).forEach((kind) => credentialKinds.add(kind));
    }
    const form = structural.paymentFormPresent === true
      || structural.paymentOwnerPresent === true
      || structural.hostedPaymentWidgetPresent === true
      || Number(structural.paymentCredentialCount || 0) >= 2
      || credentialKinds.size >= 2;
    const method = structural.paymentMethodPresent === true
      || /\bpayment\s+(?:method|option)\b|\bdebit\s*card\b|\bcredit\s*card\b/.test(visible);
    const commit = structural.payControlPresent === true || isPaymentCommitText(visible);
    const legal = structural.legalAcceptancePresent === true;
    const review = structural.reviewSummaryPresent === true
      || (/\b(?:amount\s+to\s+pay|total)\b/.test(visible)
        && /\b(?:departure|return|itinerary|travel\s+details|your\s+order)\b/.test(visible));
    const heading = structural.paymentHeadingPresent === true
      || /\b(?:payment\s+details|choose\s+payment\s+method|pay\s+securely|overview\s*(?:&|and)\s*payment)\b/.test(visible);
    // Some payment pages hydrate methods/credentials only after the traveler
    // chooses a currency. A visible, owned itinerary + exact total + explicit
    // payment/currency prompt is already the irreversible boundary we promise
    // to stop at. URL or generic payment prose alone can never create it.
    const entry = structural.progressivePaymentEntryPresent === true;
    const signals = Object.freeze({ route, progress, form, method, commit, legal, review, heading, entry });
    const signalStates = Object.freeze({
      route: terminalSignalState(route, Boolean(url)),
      progress: terminalSignalState(progress),
      form: terminalSignalState(form, structural.paymentOwnerProbeState === "observed_absent"),
      method: terminalSignalState(method),
      commit: terminalSignalState(commit),
      legal: terminalSignalState(legal),
      review: terminalSignalState(review),
      heading: terminalSignalState(heading),
      entry: terminalSignalState(entry)
    });
    const signalCount = Object.values(signals).filter(Boolean).length;
    const stageAnchor = route || progress || heading;
    const boundaryObserved = Boolean(
      (form && (stageAnchor || method || commit))
      || (stageAnchor && method && commit)
      || (route && progress && (method || commit || review))
      || ((route || progress) && entry)
      // Some review/payment pages reveal credential controls progressively.
      // A payment heading plus owned order review plus at least one exact
      // credential kind is a typed terminal boundary; generic payment copy or
      // a lone card field without review ownership still cannot qualify.
      || (heading && review && credentialKinds.size >= 1)
      // A final review can intentionally keep payment credentials hidden
      // until the user accepts terms. Review ownership + legal acceptance +
      // an exact payment commit control is already the boundary at which Fly
      // must stop; requiring hydrated card fields here caused the agent to
      // reinterpret final checkout as an earlier traveler/seat page.
      || (review && legal && commit)
    );
    return Object.freeze({
      contractVersion: TERMINAL_EVIDENCE_VERSION,
      stage: boundaryObserved ? "payment_review" : "unknown",
      signals,
      signalCount,
      boundaryObserved,
      verified: boundaryObserved,
      evidenceOnly: true,
      paymentCredentialKinds: Object.freeze([...credentialKinds]),
      signalStates,
      evidenceSources: Object.freeze([...(structural.terminalEvidenceSources || [])]),
      capabilities: Object.freeze({ paymentActionsAllowed: false })
    });
  }

  function operationAvailability(operation = {}) {
    const actionability = operation?.actionability;
    if (actionability && typeof actionability === "object") {
      if (actionability.executable === true) return DECISION_AVAILABILITY.ACTIVE;
      if (actionability.revealable === true) return DECISION_AVAILABILITY.REVEALABLE;
      return DECISION_AVAILABILITY.INACTIVE;
    }
    if (operation?.status === CAPABILITY_STATUS.PROVEN_EXECUTABLE) return DECISION_AVAILABILITY.ACTIVE;
    if (operation?.status === CAPABILITY_STATUS.RECOVERABLE) return DECISION_AVAILABILITY.REVEALABLE;
    return DECISION_AVAILABILITY.INACTIVE;
  }

  function controlAvailability(control = {}) {
    const availability = Object.values(control.operations || {}).map(operationAvailability);
    if (availability.includes(DECISION_AVAILABILITY.ACTIVE)) return DECISION_AVAILABILITY.ACTIVE;
    if (availability.includes(DECISION_AVAILABILITY.REVEALABLE)) return DECISION_AVAILABILITY.REVEALABLE;
    return DECISION_AVAILABILITY.INACTIVE;
  }

  function decisionAvailability(group = {}, controls = []) {
    const controlsById = controls instanceof Map
      ? controls
      : new Map((controls || []).map((control) => [control.controlId, control]));
    const controlIds = [
      ...(group.alternatives || group.options || []).map((option) => option.controlId),
      ...(group.alternativeControlIds || []),
      ...(group.semanticCorrectionControlIds || []),
      group.removalControlId
    ].filter(Boolean);
    const availability = controlIds.map((controlId) => controlAvailability(controlsById.get(controlId) || {}));
    if (availability.includes(DECISION_AVAILABILITY.ACTIVE)) return DECISION_AVAILABILITY.ACTIVE;
    if (availability.includes(DECISION_AVAILABILITY.REVEALABLE)) return DECISION_AVAILABILITY.REVEALABLE;
    return DECISION_AVAILABILITY.INACTIVE;
  }

  function operationExecutable(control = {}) {
    return controlAvailability(control) !== DECISION_AVAILABILITY.INACTIVE;
  }

  function exactActuatorFor(control = {}) {
    for (const [operation, capability] of Object.entries(control.operations || {})) {
      const actuatorId = text(
        capability?.actuatorId
        || capability?.actuatorIds?.[0]
        || control.preferredActivationElementId
        || control.stateElementId,
        160
      );
      if (!actuatorId) continue;
      return {
        controlId: text(control.controlId, 160),
        targetId: actuatorId,
        operation,
        capabilityStatus: text(capability?.status, 80),
        executable: operationExecutable(control)
      };
    }
    return {
      controlId: text(control.controlId, 160),
      targetId: text(control.preferredActivationElementId || control.stateElementId, 160),
      operation: "",
      capabilityStatus: "",
      executable: false
    };
  }

  function priceFrom(value = null) {
    if (!value || typeof value !== "object") return null;
    const amount = Number(value.amount);
    if (!Number.isFinite(amount)) return null;
    return { amount, currency: normalizedText(value.currency).toUpperCase().slice(0, 8) };
  }

  function signedPriceFromText(value = "") {
    const source = normalizedText(value);
    const number = "(\\d(?:[\\d\\s.,'’]*\\d)?)";
    const currency = "(EUR|USD|GBP|TRY|TL|CAD|AUD|CHF|JPY|€|\\$|£|¥|₺)";
    const amountThenCurrency = source.match(new RegExp(`\\+\\s*${number}\\s*${currency}`, "i"));
    const currencyThenAmount = source.match(new RegExp(`\\+\\s*${currency}\\s*${number}`, "i"));
    const match = amountThenCurrency || currencyThenAmount;
    if (!match) return null;
    const rawAmount = amountThenCurrency ? match[1] : match[2];
    const rawCurrency = amountThenCurrency ? match[2] : match[1];
    let cleaned = rawAmount.replace(/[\s'’]/g, "");
    const lastComma = cleaned.lastIndexOf(",");
    const lastDot = cleaned.lastIndexOf(".");
    if (lastComma > lastDot) cleaned = cleaned.replace(/\./g, "").replace(",", ".");
    else cleaned = cleaned.replace(/,/g, "");
    const amount = Number(cleaned);
    if (!Number.isFinite(amount)) return null;
    const currencyMap = { "€": "EUR", "$": "USD", "£": "GBP", "¥": "JPY", "₺": "TRY", TL: "TRY" };
    return { amount, currency: currencyMap[String(rawCurrency).toUpperCase()] || String(rawCurrency).toUpperCase() };
  }

  function priceFromTokens(rawAmount = "", rawCurrency = "") {
    let cleaned = String(rawAmount || "").replace(/[\s'’]/g, "");
    const lastComma = cleaned.lastIndexOf(",");
    const lastDot = cleaned.lastIndexOf(".");
    if (lastComma > lastDot) cleaned = cleaned.replace(/\./g, "").replace(",", ".");
    else cleaned = cleaned.replace(/,/g, "");
    const amount = Number(cleaned);
    if (!Number.isFinite(amount)) return null;
    const currencyMap = { "€": "EUR", "$": "USD", "£": "GBP", "¥": "JPY", "₺": "TRY", TL: "TRY" };
    const token = String(rawCurrency || "").toUpperCase();
    return { amount, currency: currencyMap[token] || token };
  }

  function absolutePriceNearOption(value = "", optionName = "") {
    const source = normalizedText(value);
    const name = normalizedText(optionName);
    if (!source || !name) return null;
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const number = "(\\d(?:[\\d\\s.,'’]*\\d)?)";
    const currency = "(EUR|USD|GBP|TRY|TL|CAD|AUD|CHF|JPY|€|\\$|£|¥|₺)";
    const patterns = [
      { regex: new RegExp(`${escapedName}([^\\d]{0,32})${number}\\s*${currency}`, "i"), amount: 2, currency: 3, separator: 1 },
      { regex: new RegExp(`${escapedName}([^\\d]{0,32})${currency}\\s*${number}`, "i"), amount: 3, currency: 2, separator: 1 },
      { regex: new RegExp(`${number}\\s*${currency}([^\\d]{0,32})${escapedName}`, "i"), amount: 1, currency: 2, separator: 3 },
      { regex: new RegExp(`${currency}\\s*${number}([^\\d]{0,32})${escapedName}`, "i"), amount: 2, currency: 1, separator: 3 }
    ];
    for (const pattern of patterns) {
      const match = source.match(pattern.regex);
      if (!match || /\+/.test(match[pattern.separator] || "")) continue;
      const price = priceFromTokens(match[pattern.amount], match[pattern.currency]);
      if (price) return price;
    }
    return null;
  }

  function selectionCtaDescriptor(control = {}) {
    const label = normalizedText(control.label || control.ownText || control.accessibleName);
    const match = label.match(/^\s*(continue|choose|select|book|pick)\s+(?:with\s+)?(.+?)\s*$/i);
    if (!match) return null;
    return {
      command: match[1].toLowerCase(),
      optionName: normalizedText(match[2]),
      label
    };
  }

  function optionEvidenceFromPage(page = {}, descriptor = {}, orderedDescriptors = [], index = 0) {
    const visibleText = normalizedText(page.visibleText || page.fullText || page.text);
    if (!visibleText) return "";
    const lowerText = visibleText.toLowerCase();
    const marker = descriptor.label.toLowerCase();
    const end = lowerText.indexOf(marker);
    if (end < 0) return "";
    let start = Math.max(0, end - 700);
    if (index > 0) {
      const previousMarker = orderedDescriptors[index - 1].label.toLowerCase();
      const previous = lowerText.lastIndexOf(previousMarker, end - 1);
      if (previous >= 0) start = previous + previousMarker.length;
    }
    return normalizedText(visibleText.slice(start, end + descriptor.label.length));
  }

  function canonicalAttributesFromEvidence(value = "") {
    const evidence = normalizedText(value);
    const refund = evidence.match(/\b(\d{1,3})\s*%\s*refund/i);
    const noFlexibility = /no flexibility|cannot (?:change|rebook)|changes? not (?:allowed|included)/i.test(evidence);
    const flexible = /free (?:trip )?changes?|changes? (?:allowed|included)|rebook/i.test(evidence) && !noFlexibility;
    return {
      ...(refund ? { refundPercent: Number(refund[1]) } : {}),
      ...(noFlexibility ? { flexibility: "none" } : {}),
      ...(flexible ? { flexibility: "changes_allowed" } : {}),
      evidenceText: evidence.slice(0, 700)
    };
  }

  function subjectFromEvidence(value = "") {
    const evidence = normalizedText(value).toLowerCase();
    // Exact product nouns outrank generic commercial tier words. A seat
    // legend such as "Standard seat — 9 EUR" is still a seat decision; the
    // adjective "standard" alone is not authoritative fare ownership.
    if (/seat|seating|legroom|aisle|window/.test(evidence)) return "seat";
    if (/bag|baggage|luggage|carry.?on/.test(evidence)) return "baggage";
    if (/insurance|protection|medical cover/.test(evidence)) return "insurance";
    if (/meal|vegetarian|food/.test(evidence)) return "meal";
    if (/priority|boarding/.test(evidence)) return "priority_boarding";
    if (/fare|ticket|saver|flexi|economy light|basic\/plus|basic (?:standard|saver|flexi)|standard fare|continue with standard/.test(evidence)) return "fare_package";
    return "unknown";
  }

  function alignedRepeatedControls(items = []) {
    if (items.length < 2) return false;
    const boxes = items.map((item) => (
      item.control.visualRegion
      || item.control.visualRegions?.[0]
      || Object.values(item.control.operations || {})[0]?.actionability?.box
      || null
    ));
    if (boxes.some((box) => !box)) return true;
    const heights = boxes.map((box) => Number(box.height || 0)).filter((value) => value > 0);
    const widths = boxes.map((box) => Number(box.width || 0)).filter((value) => value > 0);
    const toleranceY = Math.max(18, ...(heights.length ? heights : [0]));
    const toleranceX = Math.max(18, ...(widths.length ? widths : [0]));
    const sameRow = Math.max(...boxes.map((box) => Number(box.centerY ?? box.y ?? 0)))
      - Math.min(...boxes.map((box) => Number(box.centerY ?? box.y ?? 0))) <= toleranceY;
    const sameColumn = Math.max(...boxes.map((box) => Number(box.centerX ?? box.x ?? 0)))
      - Math.min(...boxes.map((box) => Number(box.centerX ?? box.x ?? 0))) <= toleranceX;
    return sameRow || sameColumn;
  }

  function normalizeDecisionOption(option = {}, control = {}) {
    const structuredPrice = priceFrom(option.structuredPrice || option.priceDelta || control.structuredPrice);
    const exactActuator = cloneSerializable(option.exactActuator || exactActuatorFor(control));
    const canonicalAttributes = cloneSerializable(option.canonicalAttributes || {});
    return {
      optionId: text(option.optionId || normalizedKey(option.label || control.label || control.controlId), 160),
      controlId: text(option.controlId || control.controlId, 160),
      label: normalizedText(option.label || control.label),
      canonicalAttributes,
      priceDelta: structuredPrice ? structuredPrice.amount : null,
      currency: structuredPrice?.currency || "",
      structuredPrice,
      included: option.included === true || structuredPrice?.amount === 0,
      selected: option.selected === true || control.selected === true || control.state?.checked === true || control.state?.selected === true,
      exactActuator,
      stateProbe: cloneSerializable(option.stateProbe || {
        controlId: text(control.controlId, 160),
        stateElementId: text(control.stateElementId, 160),
        selected: option.selected === true || control.selected === true || control.state?.checked === true || control.state?.selected === true
      })
    };
  }

  function normalizeDecisionContract(raw = {}, controlsById = new Map()) {
    const rawOptions = raw.options || raw.alternatives || [];
    const options = rawOptions.map((option) => normalizeDecisionOption(
      option,
      controlsById.get(option.controlId) || {}
    ));
    const selected = options.filter((option) => option.selected);
    const kind = Object.values(DECISION_KIND).includes(raw.kind)
      ? raw.kind
      : (raw.controlType === "optional_toggle" || rawOptions.length <= 1
          ? DECISION_KIND.OPTIONAL_TOGGLE
          : DECISION_KIND.EXCLUSIVE_CHOICE);
    const exclusive = raw.exclusive !== false && kind === DECISION_KIND.EXCLUSIVE_CHOICE;
    const validationErrors = [];
    if (exclusive && options.length < 2) validationErrors.push("EXCLUSIVE_DECISION_REQUIRES_MULTIPLE_OPTIONS");
    if (exclusive && selected.length > 1) validationErrors.push("EXCLUSIVE_DECISION_HAS_MULTIPLE_SELECTIONS");
    options.forEach((option) => {
      if (!option.controlId) validationErrors.push("OPTION_CONTROL_ID_MISSING");
      if (!option.exactActuator?.targetId) validationErrors.push(`OPTION_ACTUATOR_MISSING:${option.optionId}`);
    });
    return {
      contractVersion: CONTRACT_VERSION,
      decisionId: text(raw.decisionId || raw.decisionGroupId || raw.requirementId, 240),
      decisionGroupId: text(raw.decisionGroupId || raw.decisionId || raw.requirementId, 240),
      kind,
      subject: text(raw.subject?.key || raw.subject || raw.sectionType || "unknown", 120),
      subjectLabel: normalizedText(raw.subject?.label || raw.sectionLabel || raw.label || "Checkout decision"),
      required: raw.required === true,
      requiresResolution: raw.requiresResolution === true
        || (raw.requiresResolution !== false && raw.required === true && selected.length === 0),
      exclusive,
      currentSelection: selected.length === 1 ? selected[0].optionId : "",
      options,
      evidence: cloneSerializable(raw.evidence || []),
      confidence: Math.max(0, Math.min(1, Number(raw.confidence ?? 0.8))),
      valid: validationErrors.length === 0,
      validationErrors
    };
  }

  function reconstructSelectionCtaGroups(page = {}, controls = []) {
    const candidates = controls
      .map((control) => ({ control, descriptor: selectionCtaDescriptor(control) }))
      .filter((item) => item.descriptor && operationExecutable(item.control));
    const buckets = new Map();
    for (const candidate of candidates) {
      const key = [candidate.control.surfaceId || "surface-page", candidate.descriptor.command].join("::");
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(candidate);
    }
    return [...buckets.values()].flatMap((items) => {
      const distinctNames = new Set(items.map((item) => normalizedKey(item.descriptor.optionName)));
      const localOwnerValues = items.map((item) => normalizedText(
        item.control.sectionId
        || item.control.choiceContract?.decisionOwnerId
        || item.control.logicalFieldId
        || ""
      ));
      const localOwnerKeys = new Set(localOwnerValues.filter(Boolean));
      const evidenceText = normalizedText([
        page.visibleText || page.fullText || page.text,
        ...items.map((item) => `${item.control.sectionLabel || ""} ${item.control.accessibleName || ""}`)
      ].join(" "));
      const subject = subjectFromEvidence(evidenceText);
      // Repeated command wording across a whole page is not ownership. Only
      // unknown controls under one bounded local owner may become one
      // decision. A known fare/seat/etc. subject is already semantic owner
      // evidence and preserves sanitized/replay observations without DOM ids.
      if (
        items.length < 2
        || distinctNames.size !== items.length
        || (subject === "unknown" && (
          localOwnerValues.some((owner) => !owner)
          || localOwnerKeys.size !== 1
        ))
        || !alignedRepeatedControls(items)
      ) return [];
      const instance = `repeated_${items[0].descriptor.command}_${subject}_${items.map((item) => normalizedKey(item.descriptor.optionName)).join("_")}`;
      const decisionGroupId = `dg_compiled_${normalizedKey(instance)}`.slice(0, 220);
      const descriptors = items.map((item) => item.descriptor);
      let options = items.map((item, index) => {
        const optionEvidence = optionEvidenceFromPage(page, item.descriptor, descriptors, index);
        const explicitlyIncluded = /\b(?:included|no extra (?:cost|charge)|at no extra (?:cost|charge))\b/i.test(optionEvidence)
          || /\b0(?:[.,]0{1,2})?\s*(?:eur|usd|gbp|try|tl|€|\$|£|₺)\b/i.test(optionEvidence);
        const structuredPrice = priceFrom(item.control.structuredPrice)
          || signedPriceFromText(optionEvidence)
          || (explicitlyIncluded ? { amount: 0, currency: "" } : null);
        const absoluteTotal = !structuredPrice && !explicitlyIncluded
          ? absolutePriceNearOption(optionEvidence, item.descriptor.optionName)
          : null;
        return normalizeDecisionOption({
          optionId: normalizedKey(item.descriptor.optionName),
          controlId: item.control.controlId,
          label: item.descriptor.optionName,
          canonicalAttributes: {
            ...canonicalAttributesFromEvidence(optionEvidence),
            ...(absoluteTotal ? {
              displayedTotal: absoluteTotal.amount,
              displayedTotalCurrency: absoluteTotal.currency,
              priceBasis: "absolute_total"
            } : {})
          },
          structuredPrice,
          included: explicitlyIncluded || structuredPrice?.amount === 0,
          selected: item.control.selected === true || item.control.state?.selected === true || item.control.state?.checked === true,
          exactActuator: exactActuatorFor(item.control),
          stateProbe: {
            controlId: item.control.controlId,
            stateElementId: item.control.stateElementId || "",
            selectionEvidence: item.control.state?.selectionEvidence || null
          }
        }, item.control);
      });
      if (subject === "fare_package" && options.length >= 2 && options.every((option) => option.priceDelta === null)) {
        const totals = options.map((option) => ({
          amount: Number(option.canonicalAttributes?.displayedTotal),
          currency: normalizedText(option.canonicalAttributes?.displayedTotalCurrency).toUpperCase()
        }));
        const currencies = new Set(totals.map((total) => total.currency).filter(Boolean));
        const allTotalsOwned = totals.every((total) => Number.isFinite(total.amount) && total.currency);
        if (allTotalsOwned && currencies.size === 1) {
          const baseline = Math.min(...totals.map((total) => total.amount));
          const uniqueBaseline = totals.filter((total) => total.amount === baseline).length === 1;
          if (uniqueBaseline) {
            options = options.map((option, index) => {
              const incrementalAmount = Math.round((totals[index].amount - baseline) * 100) / 100;
              return {
                ...option,
                priceDelta: incrementalAmount,
                currency: totals[index].currency,
                structuredPrice: { amount: incrementalAmount, currency: totals[index].currency },
                included: incrementalAmount === 0,
                canonicalAttributes: {
                  ...option.canonicalAttributes,
                  incrementalAmount,
                  incrementalCurrency: totals[index].currency
                }
              };
            });
          }
        }
      }
      const paidCurrencies = [...new Set(options.filter((option) => Number(option.priceDelta) > 0 && option.currency).map((option) => option.currency))];
      if (paidCurrencies.length === 1) {
        options.forEach((option) => {
          if (option.included && !option.currency) {
            option.currency = paidCurrencies[0];
            option.structuredPrice = { amount: 0, currency: paidCurrencies[0] };
          }
        });
      }
      const required = items[0].descriptor.command === "continue"
        || items.some((item) => item.control.required === true || item.control.state?.required === true);
      const decisionContract = normalizeDecisionContract({
        decisionId: decisionGroupId,
        decisionGroupId,
        kind: DECISION_KIND.EXCLUSIVE_CHOICE,
        subject,
        subjectLabel: subject === "fare_package" ? "Fare package" : "Checkout option",
        required,
        requiresResolution: required,
        exclusive: true,
        options,
        evidence: [
          "Repeated command grammar with distinct option names.",
          "Parallel executable actuators share one surface and aligned layout.",
          "Prices and included markers are bound from option-local text evidence."
        ],
        confidence: subject === "unknown" ? 0.78 : 0.94
      }, new Map(controls.map((control) => [control.controlId, control])));
      return [{
        decisionGroupId,
        requirementId: `${subject}:${normalizedKey(instance)}`,
        surfaceId: items[0].control.surfaceId || "surface-page",
        surfaceType: items[0].control.surfaceType || "page",
        sectionId: items[0].control.sectionId || "",
        sectionType: subject,
        sectionLabel: decisionContract.subjectLabel,
        subject,
        kind: DECISION_KIND.EXCLUSIVE_CHOICE,
        required,
        requiresResolution: required,
        material: true,
        status: decisionContract.currentSelection ? "satisfied" : (required ? "missing" : "optional"),
        selectedControlId: options.find((option) => option.selected)?.controlId || "",
        selectedLabel: options.find((option) => option.selected)?.label || "",
        selectionInvariant: { exclusive: true, valid: decisionContract.valid, selectedCount: options.filter((option) => option.selected).length },
        alternatives: options.map((option) => ({
          ...option,
          targetId: option.exactActuator?.targetId || "",
          semantic: option.included ? "select_free_option" : (Number(option.priceDelta) > 0 ? "add_paid_extra" : "selection_cta"),
          risk: option.included ? "safe" : (Number(option.priceDelta) > 0 ? "money" : "uncertain")
        })),
        evidence: decisionContract.evidence,
        confidence: decisionContract.confidence,
        decisionContract
      }];
    });
  }

  function reconstructForegroundChoiceGroups(page = {}, controls = []) {
    const surface = page.currentSurface || page.activeSurface || {};
    const surfaceType = normalizedText(surface.type || "page").toLowerCase();
    const surfaceId = text(surface.id || surface.surfaceId, 160);
    if (surfaceType === "page" || !surfaceId) return [];

    const memberIds = new Set((surface.memberControlIds || surface.controlIds || []).map((id) => text(id, 160)));
    const candidates = controls.filter((control) => {
      const belongs = control.surfaceId === surfaceId || memberIds.has(text(control.controlId, 160));
      const shape = normalizedText(`${control.kind || ""} ${control.role || ""} ${control.domRole || ""}`).toLowerCase();
      const meaning = normalizedText(`${control.semantic || ""} ${control.semanticIntent || ""} ${control.meaning || ""} ${control.label || ""}`).toLowerCase();
      if (!belongs || !operationExecutable(control) || !/button/.test(shape)) return false;
      if (/^(?:close|dismiss|back|cancel|x)$/i.test(normalizedText(control.label))) return false;
      return /selection[_ -]?cta|decline_paid_extra|safe_decline|select_(?:free|paid)_option|add_paid_extra|skip|without|no thanks|continue with|choose|select/.test(meaning);
    });
    if (candidates.length < 2) return [];

    const buckets = new Map();
    for (const control of candidates) {
      const key = text(control.decisionGroupId || surface.decisionGroupId || surfaceId, 220);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(control);
    }

    return [...buckets.entries()].flatMap(([declaredGroupId, items]) => {
      const distinct = new Set(items.map((control) => normalizedKey(control.label)));
      if (items.length < 2 || distinct.size !== items.length) return [];
      const evidenceText = normalizedText([
        surface.label,
        ...items.map((control) => `${control.label || ""} ${control.semantic || ""}`)
      ].join(" "));
      const subject = subjectFromEvidence(evidenceText);
      const decisionGroupId = declaredGroupId || `dg_compiled_foreground_${normalizedKey(`${surfaceId}_${subject}`)}`;
      const options = items.map((control) => {
        const optionMeaning = normalizedText(`${control.semantic || ""} ${control.risk || ""} ${control.label || ""}`).toLowerCase();
        const included = control.structuredPrice?.amount === 0
          || /decline|safe_decline|skip|without|no thanks|random|automatic|free|included/.test(optionMeaning);
        return normalizeDecisionOption({
          optionId: normalizedKey(control.label || control.controlId),
          controlId: control.controlId,
          label: control.label,
          canonicalAttributes: canonicalAttributesFromEvidence(`${surface.label || ""} ${control.label || ""}`),
          structuredPrice: control.structuredPrice || (included ? { amount: 0, currency: "" } : null),
          included,
          selected: control.selected === true || control.state?.selected === true || control.state?.checked === true,
          exactActuator: exactActuatorFor(control),
          stateProbe: {
            controlId: control.controlId,
            stateElementId: control.stateElementId || "",
            selectionEvidence: control.state?.selectionEvidence || null
          }
        }, control);
      });
      const decisionContract = normalizeDecisionContract({
        decisionId: decisionGroupId,
        decisionGroupId,
        kind: DECISION_KIND.EXCLUSIVE_CHOICE,
        subject,
        subjectLabel: subject === "seat" ? "Seat selection" : (surface.label || "Foreground choice"),
        required: true,
        exclusive: true,
        options,
        evidence: [
          "A blocking foreground surface exposes multiple executable decision actions.",
          "Background controls are excluded from the foreground decision."
        ],
        confidence: subject === "unknown" ? 0.82 : 0.95
      }, new Map(controls.map((control) => [control.controlId, control])));
      return [{
        decisionGroupId,
        requirementId: `${subject}:foreground_choice:${normalizedKey(surfaceId)}`,
        surfaceId,
        surfaceType,
        sectionId: "",
        sectionType: subject,
        sectionLabel: decisionContract.subjectLabel,
        subject,
        kind: DECISION_KIND.EXCLUSIVE_CHOICE,
        required: true,
        material: true,
        status: decisionContract.currentSelection ? "satisfied" : "missing",
        selectedControlId: options.find((option) => option.selected)?.controlId || "",
        selectedLabel: options.find((option) => option.selected)?.label || "",
        selectionInvariant: { exclusive: true, valid: decisionContract.valid, selectedCount: options.filter((option) => option.selected).length },
        alternatives: options.map((option) => {
          const control = items.find((item) => item.controlId === option.controlId) || {};
          return {
            ...option,
            targetId: option.exactActuator?.targetId || "",
            semantic: control.semantic || (option.included ? "select_free_option" : "selection_cta"),
            risk: control.risk || (option.included ? "safe" : "uncertain")
          };
        }),
        evidence: decisionContract.evidence,
        confidence: decisionContract.confidence,
        decisionContract
      }];
    });
  }

  function materialControl(control = {}) {
    if (!operationExecutable(control)) return false;
    const meaning = normalizedText(`${control.semantic || ""} ${control.semanticIntent || ""} ${control.meaning || ""} ${control.label || ""}`).toLowerCase();
    const shape = normalizedText(`${control.kind || ""} ${control.role || ""} ${control.domRole || ""}`).toLowerCase();
    const requiredEmpty = (control.required === true || control.state?.required === true)
      && control.state?.valuePresent !== true
      && control.state?.selected !== true
      && control.state?.checked !== true;
    return requiredEmpty
      || /selection[_ -]?cta/.test(meaning)
      || /radio|option/.test(shape);
  }

  function compileSemanticCheckout(page = {}) {
    const controls = (page.controls || []).map((control) => ({ ...control }));
    const controlsById = new Map(controls.map((control) => [control.controlId, control]));
    const existingGroups = (page.decisionGroups || []).map((group) => {
      const declared = group.decisionContract || group;
      const referencedControlIds = [
        ...(group.alternativeControlIds || []),
        ...(group.semanticCorrectionControlIds || []),
        group.removalControlId
      ].filter(Boolean);
      const inferredOptions = referencedControlIds.map((controlId) => {
        const control = controlsById.get(controlId) || {};
        return {
          controlId,
          label: control.label || controlId,
          structuredPrice: control.structuredPrice || null,
          selected: control.selected === true || control.state?.checked === true || control.state?.selected === true
        };
      });
      const decisionContract = normalizeDecisionContract({
        ...declared,
        options: declared.options || declared.alternatives || group.alternatives || inferredOptions
      }, controlsById);
      return { ...group, decisionContract };
    });
    const existingOwned = new Set(existingGroups.flatMap((group) => (group.alternatives || []).map((option) => option.controlId)).filter(Boolean));
    const reconstructedChoices = reconstructSelectionCtaGroups(page, controls).filter((group) => (
      !(group.alternatives || []).some((option) => existingOwned.has(option.controlId))
    ));
    const reconstructedChoiceControlIds = new Set(reconstructedChoices.flatMap((group) => (
      (group.alternatives || []).map((option) => option.controlId)
    )));
    const reconstructedForegroundChoices = reconstructForegroundChoiceGroups(page, controls).filter((group) => (
      !(group.alternatives || []).some((option) => (
        existingOwned.has(option.controlId) || reconstructedChoiceControlIds.has(option.controlId)
      ))
    ));
    const reconstructed = [...reconstructedChoices, ...reconstructedForegroundChoices];
    const groups = [...existingGroups, ...reconstructed];
    const reconstructedIds = new Set(reconstructed.map((group) => group.decisionGroupId));
    for (const group of groups) {
      if (!reconstructedIds.has(group.decisionGroupId)) continue;
      for (const option of group.decisionContract?.options || []) {
        const control = controlsById.get(option.controlId);
        if (!control) continue;
        const alternative = (group.alternatives || []).find((item) => item.controlId === option.controlId) || {};
        const controlShape = normalizedText(
          `${control.kind || ""} ${control.role || ""} ${control.domRole || ""}`
        ).toLowerCase();
        const ownsLogicalField = Boolean(
          control.fieldType
          || control.field
          || control.logicalFieldId
          || (
            control.componentContract?.logicalIdentity
            && /textbox|input|textarea|combobox|select|spinbutton|date/.test(controlShape)
          )
        );
        Object.assign(control, {
          decisionGroupId: group.decisionGroupId,
          choiceContract: {
            ...(control.choiceContract || {}),
            decisionInstance: group.decisionGroupId,
            decisionLabel: group.sectionLabel || group.decisionContract.subjectLabel,
            optionId: option.optionId,
            optionName: option.label,
            optionCount: group.decisionContract.options.length,
            required: group.required === true,
            advancesOnSelection: control.choiceContract?.advancesOnSelection === true || /^continue\b/i.test(control.label || ""),
            ownershipComplete: Boolean(option.exactActuator?.targetId && option.exactActuator?.executable),
            structuredPrice: option.structuredPrice || null,
            priceDelta: option.priceDelta,
            optionPhysicalEffect: option.included
              ? "select_free_option"
              : (Number(option.priceDelta) > 0 ? "select_paid_option" : "unknown"),
            exactActuator: option.exactActuator,
            stateProbe: option.stateProbe,
            canonicalAttributes: option.canonicalAttributes
          },
          structuredPrice: option.structuredPrice || control.structuredPrice || null
        });
        if (!ownsLogicalField) {
          Object.assign(control, {
            semantic: alternative.semantic || (option.included ? "select_free_option" : (Number(option.priceDelta) > 0 ? "add_paid_extra" : control.semantic)),
            semanticIntent: alternative.semantic || control.semanticIntent,
            physicalEffect: option.included ? "select_free_option" : (Number(option.priceDelta) > 0 ? "select_paid_option" : control.physicalEffect),
            risk: option.included ? "safe" : (Number(option.priceDelta) > 0 ? "money" : control.risk)
          });
        }
      }
    }
    const groupIds = new Set(groups.map((group) => text(group.decisionGroupId || group.requirementId, 240)).filter(Boolean));
    const ownedControlIds = new Set([
      ...groups.flatMap((group) => (group.decisionContract?.options || []).map((option) => option.controlId)),
      ...controls.filter((control) => groupIds.has(text(control.decisionGroupId, 240))).map((control) => control.controlId)
    ].filter(Boolean));
    const unownedMaterialControls = controls.filter((control) => (
      materialControl(control)
      && !ownedControlIds.has(control.controlId)
      && !control.fieldType
      && !control.componentContract?.logicalIdentity
    )).map((control) => ({
      controlId: text(control.controlId, 160),
      label: normalizedText(control.label),
      semantic: text(control.semantic, 120),
      reason: /selection[_ -]?cta/i.test(`${control.semantic || ""} ${control.meaning || ""}`)
        ? "UNOWNED_SELECTION_CTA"
        : "UNOWNED_MATERIAL_CONTROL"
    }));
    const unresolvedDecisions = groups.filter((group) => (
      group.decisionContract?.valid === false
      || (
        group.required === true
        && !["satisfied", "waived", "waived_by_policy"].includes(group.status)
        && (group.decisionContract?.options || []).length === 0
      )
    )).map((group) => ({
      decisionId: group.decisionGroupId,
      validationErrors: group.decisionContract?.validationErrors?.length
        ? group.decisionContract.validationErrors
        : ["REQUIRED_DECISION_HAS_NO_EXECUTABLE_OPTIONS"]
    }));
    const facts = page.readiness || {};
    const transient = facts.documentReadyState === "loading"
      || facts.ariaBusy === true
      || Number(facts.loadingIndicatorCount || 0) > 0;
    const terminal = page.semanticTerminal === true || page.terminalEvidence?.verified === true;
    const semanticReadiness = terminal
      ? SEMANTIC_READINESS.TERMINAL
      : transient
        ? SEMANTIC_READINESS.TRANSIENT
        : (unownedMaterialControls.length || unresolvedDecisions.length)
          ? SEMANTIC_READINESS.UNRESOLVED
          : SEMANTIC_READINESS.READY;
    const currentExecutableObligations = groups.filter((group) => (
      group.required === true && !["satisfied", "waived", "waived_by_policy"].includes(group.status)
    )).map((group) => group.decisionGroupId);
    return {
      contractVersion: CONTRACT_VERSION,
      semanticReadiness,
      controls,
      decisionGroups: groups,
      decisionContracts: groups.map((group) => group.decisionContract).filter(Boolean),
      unownedMaterialControls,
      unresolvedDecisions,
      currentExecutableObligations,
      evidence: {
        reconstructedDecisionCount: reconstructed.length,
        existingDecisionCount: existingGroups.length,
        materialControlCount: ownedControlIds.size + unownedMaterialControls.length
      }
    };
  }

  function normalizedActionability(raw = {}, operation = "") {
    const evidence = raw && typeof raw === "object" ? raw : {};
    return {
      ...cloneSerializable(evidence),
      rendered: evidence.rendered === true,
      visible: evidence.visible === true,
      enabled: evidence.enabled === true,
      inViewport: evidence.inViewport === true,
      inCurrentSurface: evidence.inCurrentSurface === true,
      hitTested: evidence.hitTested === true,
      notOccluded: evidence.notOccluded === true,
      targetable: evidence.targetable === true,
      operationAuthorized: evidence.operationAuthorized === true,
      operationProven: evidence.operationProven === true,
      operationProof: text(evidence.operationProof, 240),
      executable: evidence.executable === true,
      revealable: evidence.revealable === true,
      code: text(evidence.code, 120),
      operation: text(evidence.operation || operation, 60)
    };
  }

  function capabilityStatusFor({
    control = {},
    operation = "",
    targetId = "",
    actionability = null,
    recovery = null
  } = {}) {
    const stateElementId = text(control.stateElementId, 160);
    const disabledState = control.disabled === true || control.state?.disabled === true;
    const target = text(targetId, 160);
    const proof = actionability && typeof actionability === "object" ? actionability : {};
    if (
      target
      && !(disabledState && target === stateElementId)
      && proof.executable === true
      && proof.visible === true
      && proof.enabled === true
      && proof.inCurrentSurface === true
      && proof.hitTested === true
      && proof.notOccluded === true
      && proof.operationAuthorized === true
      && proof.operationProven === true
    ) {
      return CAPABILITY_STATUS.PROVEN_EXECUTABLE;
    }
    if (
      target
      && !(disabledState && target === stateElementId)
      && proof.revealable === true
      && proof.rendered === true
      && proof.enabled === true
      && proof.inCurrentSurface === true
    ) {
      return CAPABILITY_STATUS.RECOVERABLE;
    }
    if (
      recovery?.requiresVisualConfirmation === true
      && Array.isArray(recovery.regions)
      && recovery.regions.some((region) => (
        Number(region?.width) > 0
        && Number(region?.height) > 0
        && region?.inViewport !== false
      ))
    ) {
      return CAPABILITY_STATUS.UNPROVEN_EXPERIMENT;
    }
    return CAPABILITY_STATUS.UNAVAILABLE;
  }

  function actionTypeForMethod(method = "", operation = "") {
    if (method === INTERACTION_METHOD.DIRECT_INPUT) return "type";
    if (method === INTERACTION_METHOD.NATIVE_SELECT) return "select";
    if ([INTERACTION_METHOD.FOCUS_ENTER, INTERACTION_METHOD.FOCUS_SPACE, INTERACTION_METHOD.FOCUS_ARROW_DOWN].includes(method)) {
      return "keypress";
    }
    if (method === INTERACTION_METHOD.VISUAL_COORDINATE) return "click_xy";
    if ([INTERACTION_METHOD.BROWSER_TRUSTED_INPUT, INTERACTION_METHOD.BROWSER_TRUSTED_CHOICE].includes(method)) return "click";
    if (["open", "choose", "activate"].includes(operation)) return "click";
    return "";
  }

  function keysForMethod(method = "") {
    if (method === INTERACTION_METHOD.FOCUS_ENTER) return "Enter";
    if (method === INTERACTION_METHOD.FOCUS_SPACE) return "Space";
    if (method === INTERACTION_METHOD.FOCUS_ARROW_DOWN) return "ArrowDown";
    return "";
  }

  function stableStrategyId(control = {}, operation = "", actuatorId = "", method = "", keys = "") {
    return [
      text(control.stableKey || control.controlId || "control", 220),
      text(operation, 60),
      text(actuatorId || "visual-region", 160),
      text(method, 80),
      text(keys, 40)
    ].join("::");
  }

  function defaultMethodsForOperation(operation = "") {
    if (operation === "type") return [INTERACTION_METHOD.DIRECT_INPUT];
    if (operation === "select") return [INTERACTION_METHOD.NATIVE_SELECT];
    if (operation === "keyboard") return [INTERACTION_METHOD.FOCUS_ARROW_DOWN];
    if (["open", "choose", "activate"].includes(operation)) {
      // Legacy producers described one generic click. Preserve that as one
      // method; the observer publishes additional proven methods explicitly.
      return [INTERACTION_METHOD.NATIVE_CLICK];
    }
    return [];
  }

  function normalizeStrategy(control = {}, operation = "", strategy = {}, actionabilityByActuator = {}) {
    const actuatorId = text(strategy.actuatorId || strategy.targetId, 160);
    const method = text(strategy.method || strategy.interactionMethod, 80);
    const keys = text(strategy.keys || keysForMethod(method), 40);
    const proof = normalizedActionability(
      strategy.proof || strategy.actionability || actionabilityByActuator[actuatorId] || {},
      operation
    );
    const recovery = strategy.recovery || null;
    const status = Object.values(CAPABILITY_STATUS).includes(strategy.status)
      ? strategy.status
      : capabilityStatusFor({ control, operation, targetId: actuatorId, actionability: proof, recovery });
    return {
      ...cloneSerializable(strategy),
      strategyId: text(
        strategy.strategyId || stableStrategyId(control, operation, actuatorId, method, keys),
        700
      ),
      operation: text(strategy.operation || operation, 60),
      actuatorId,
      method,
      actionType: text(strategy.actionType || actionTypeForMethod(method, operation), 40),
      keys,
      status,
      proof,
      expectedOutcome: cloneSerializable(strategy.expectedOutcome || null),
      recovery: cloneSerializable(recovery)
    };
  }

  function normalizeCapability(control = {}, operation = "", rawCapability = null) {
    const capability = rawCapability && typeof rawCapability === "object" ? rawCapability : {};
    const recovery = control.recovery?.[operation] || null;
    const actuatorIds = [...new Set([
      ...(Array.isArray(capability.actuatorIds) ? capability.actuatorIds : []),
      capability.actuatorId
    ].map((id) => text(id, 160)).filter(Boolean))];
    const actionabilityByActuator = Object.fromEntries(actuatorIds.map((actuatorId) => {
      const raw = capability.actionabilityByActuator?.[actuatorId]
        || (capability.exactActuators || []).find((item) => item.actuatorId === actuatorId)?.proof
        || (capability.actuatorId === actuatorId ? capability.actionability : null)
        || {};
      return [actuatorId, normalizedActionability(raw, operation)];
    }));
    const preferredActuatorId = actuatorIds.find((actuatorId) => (
      capabilityStatusFor({
        control,
        operation,
        targetId: actuatorId,
        actionability: actionabilityByActuator[actuatorId]
      }) === CAPABILITY_STATUS.PROVEN_EXECUTABLE
    )) || actuatorIds.find((actuatorId) => (
      capabilityStatusFor({
        control,
        operation,
        targetId: actuatorId,
        actionability: actionabilityByActuator[actuatorId]
      }) === CAPABILITY_STATUS.RECOVERABLE
    )) || actuatorIds[0] || "";
    const preferredActionability = preferredActuatorId
      ? actionabilityByActuator[preferredActuatorId]
      : normalizedActionability(capability.actionability, operation);
    const status = capabilityStatusFor({
      control,
      operation,
      targetId: preferredActuatorId,
      actionability: preferredActionability,
      recovery
    });
    const rawStrategies = Array.isArray(capability.strategies) && capability.strategies.length
      ? capability.strategies
      : actuatorIds.flatMap((actuatorId) => defaultMethodsForOperation(operation).map((method) => ({
          operation,
          actuatorId,
          method,
          expectedOutcome: capability.expectedOutcome || null
        })));
    const strategies = rawStrategies
      .map((strategy) => normalizeStrategy(control, operation, strategy, actionabilityByActuator))
      .filter((strategy, index, list) => (
        strategy.method
        && list.findIndex((other) => other.strategyId === strategy.strategyId) === index
      ));
    for (const rawRecoveryStrategy of recovery?.strategies || []) {
      strategies.push(normalizeStrategy(control, operation, {
        ...rawRecoveryStrategy,
        status: CAPABILITY_STATUS.UNPROVEN_EXPERIMENT,
        recovery
      }, actionabilityByActuator));
    }
    if (recovery?.requiresVisualConfirmation === true && Array.isArray(recovery.regions)) {
      recovery.regions.forEach((region) => strategies.push(normalizeStrategy(control, operation, {
        actuatorId: "",
        method: INTERACTION_METHOD.VISUAL_COORDINATE,
        actionType: "click_xy",
        status: CAPABILITY_STATUS.UNPROVEN_EXPERIMENT,
        recovery: { ...recovery, regions: [region] },
        expectedOutcome: capability.expectedOutcome || null
      }, actionabilityByActuator)));
    }
    return {
      ...cloneSerializable(capability),
      capabilityId: text(
        capability.capabilityId
          || `${control.controlId || control.stableKey || "control"}::${operation}`,
        320
      ),
      operation: text(capability.operation || operation, 60),
      status,
      actuatorId: preferredActuatorId,
      actuatorIds,
      exactActuators: actuatorIds.map((actuatorId) => ({
        actuatorId,
        status: capabilityStatusFor({
          control,
          operation,
          targetId: actuatorId,
          actionability: actionabilityByActuator[actuatorId]
        }),
        proof: actionabilityByActuator[actuatorId]
      })),
      actionability: preferredActionability,
      actionabilityByActuator,
      strategies,
      recovery: recovery ? cloneSerializable(recovery) : null
    };
  }

  function observedComponentContract(control = {}, context = {}) {
    const operations = Object.fromEntries(Object.entries(control.operations || {})
      .filter(([, capability]) => Boolean(capability))
      .map(([operation, capability]) => [
        operation,
        normalizeCapability(control, operation, capability)
      ]));
    const recoveryCapabilities = Object.entries(control.recovery || {})
      .filter(([operation, recovery]) => recovery && !operations[operation])
      .map(([operation, recovery]) => {
        const recoveryActuatorIds = [...new Set((recovery.actuatorIds || [])
          .map((id) => text(id, 160))
          .filter(Boolean))];
        return {
        capabilityId: `${control.controlId || control.stableKey || "control"}::${operation}:recovery`,
        operation,
        status: capabilityStatusFor({ control, operation, recovery }),
        actuatorId: recoveryActuatorIds[0] || "",
        actuatorIds: recoveryActuatorIds,
        exactActuators: recoveryActuatorIds.map((actuatorId) => ({
          actuatorId,
          status: CAPABILITY_STATUS.UNPROVEN_EXPERIMENT,
          proof: normalizedActionability(
            recovery.targetabilityByActuator?.[actuatorId] || {},
            operation
          )
        })),
        actionability: normalizedActionability({}, operation),
        actionabilityByActuator: Object.fromEntries(recoveryActuatorIds.map((actuatorId) => [
          actuatorId,
          normalizedActionability(recovery.targetabilityByActuator?.[actuatorId] || {}, operation)
        ])),
        strategies: [
          ...(recovery.strategies || []).map((strategy) => normalizeStrategy(control, operation, {
            ...strategy,
            status: CAPABILITY_STATUS.UNPROVEN_EXPERIMENT,
            recovery
          })),
          ...(recovery.regions || []).map((region) => normalizeStrategy(control, operation, {
            actuatorId: "",
            method: INTERACTION_METHOD.VISUAL_COORDINATE,
            actionType: "click_xy",
            status: CAPABILITY_STATUS.UNPROVEN_EXPERIMENT,
            recovery: { ...recovery, regions: [region] }
          }))
        ],
        recovery: cloneSerializable(recovery)
        };
      });
    const currentCanonicalValue = text(
      control.currentCanonicalValue
        || control.state?.canonicalDateValue
        || control.state?.dateComponentValue
        || control.state?.selectedValue
        || control.state?.optionValue
        || control.state?.normalizedValue
        || control.currentValue
        || "",
      600
    );
    const logicalIdentity = text(
      control.logicalFieldId
        || control.fieldClassification?.tightOwnerKey
        || control.fieldOwnerId
        || control.name
        || control.fieldType
        || control.semantic
        || "",
      320
    );
    const componentRole = text(
      control.componentRole
        || control.dateField?.component
        || control.fieldClassification?.componentRole
        || "value",
      80
    );
    return {
      contractVersion: CONTRACT_VERSION,
      logicalIdentity,
      componentIdentity: text(
        control.componentIdentity
          || control.stableIdentity
          || `${logicalIdentity || control.stableKey || control.controlId}:${componentRole}`,
        420
      ),
      componentRole,
      controlIdentity: {
        controlId: text(control.controlId, 160),
        stableKey: text(control.stableKey, 320),
        stateElementId: text(control.stateElementId, 160),
        role: text(control.role || control.domRole || control.kind, 100),
        kind: text(control.kind, 100)
      },
      currentCanonicalValue,
      desiredCanonicalValue: text(control.desiredCanonicalValue || "", 600),
      exactOption: cloneSerializable(control.exactOption || null),
      observedOptions: cloneSerializable(
        control.observedOptions
          || control.options
          || control.dateField?.options
          || []
      ),
      capabilities: [...Object.values(operations), ...recoveryCapabilities],
      interactionLadder: cloneSerializable(control.interactionLadder || []),
      operations,
      compositeControl: {
        logicalRequirementId: logicalIdentity,
        stateNode: cloneSerializable(control.componentContract?.compositeControl?.stateNode) || {
          nodeId: text(control.stateElementId, 160),
          disabled: control.disabled === true || control.state?.disabled === true,
          currentCanonicalValue
        },
        visibleWidget: cloneSerializable(control.componentContract?.compositeControl?.visibleWidget) || {
          nodeId: text(control.visibleWidgetElementId || control.preferredActivationElementId, 160),
          visualRegion: cloneSerializable(control.visualRegion || null)
        },
        activationCandidates: cloneSerializable(
          control.componentContract?.compositeControl?.activationCandidates
          || control.actuators
          || []
        ),
        popupSurface: cloneSerializable(
          control.componentContract?.compositeControl?.popupSurface
          || control.popupSurface
          || control.surface
          || null
        ),
        optionNodes: cloneSerializable(
          control.componentContract?.compositeControl?.optionNodes
          || control.optionNodes
          || control.options
          || []
        ),
        verificationContract: cloneSerializable(
          control.componentContract?.compositeControl?.verificationContract
          || control.verificationContract
          || {
          validationOwnership: control.validationOwnership || null,
          expectedOutcomes: [...Object.values(operations), ...recoveryCapabilities]
            .flatMap((capability) => (capability.strategies || []).map((strategy) => strategy.expectedOutcome))
            .filter(Boolean)
          }
        )
      },
      surface: {
        surfaceId: text(control.surfaceId || context.surfaceId, 160),
        surfaceType: text(control.surfaceType || context.surfaceType || "page", 80),
        surfaceLabel: text(control.surfaceLabel, 240)
      },
      validationOwnership: cloneSerializable(control.validationOwnership || {
        ownerId: control.logicalFieldId || control.fieldOwnerId || logicalIdentity,
        logicalFieldId: control.logicalFieldId || "",
        componentRole,
        controlId: control.controlId || "",
        surfaceId: control.surfaceId || context.surfaceId || ""
      })
    };
  }

  function serializeObservedControl(control = {}, context = {}) {
    const serialized = cloneSerializable(control) || {};
    const componentContract = observedComponentContract(serialized, context);
    const {
      operations,
      capabilities,
      observedOptions,
      validationOwnership,
      ...componentIdentityContract
    } = componentContract;
    const compactOperations = Object.fromEntries(Object.entries(operations).map(([operation, capability]) => [
      operation,
      {
        capabilityId: capability.capabilityId,
        operation: capability.operation,
        status: capability.status,
        actuatorId: capability.actuatorId,
        actuatorIds: capability.actuatorIds,
        exactActuators: (capability.exactActuators || []).map((actuator) => ({
          actuatorId: actuator.actuatorId,
          status: actuator.status,
          proof: actuator.proof
        })),
        actionability: capability.actionability,
        strategies: (capability.strategies || []).map((strategy) => ({
          strategyId: strategy.strategyId,
          operation: strategy.operation,
          actuatorId: strategy.actuatorId,
          method: strategy.method,
          actionType: strategy.actionType,
          keys: strategy.keys,
          status: strategy.status,
          expectedOutcome: strategy.expectedOutcome
        })),
        expectedOutcome: capability.expectedOutcome || null,
        recovery: capability.recovery || null
      }
    ]));
    return {
      ...serialized,
      contractVersion: CONTRACT_VERSION,
      // Exact operations/proofs, options, and validation ownership remain
      // authoritative top-level properties. The component contract carries
      // identity plus a compact capability index instead of serializing the
      // same proof graph a second and third time.
      componentContract: {
        contractVersion: componentIdentityContract.contractVersion,
        logicalIdentity: componentIdentityContract.logicalIdentity,
        componentIdentity: componentIdentityContract.componentIdentity,
        componentRole: componentIdentityContract.componentRole,
        controlIdentity: componentIdentityContract.controlIdentity,
        currentCanonicalValue: componentIdentityContract.currentCanonicalValue,
        desiredCanonicalValue: componentIdentityContract.desiredCanonicalValue
      },
      operations: compactOperations,
      observedOptions,
      currentCanonicalValue: componentContract.currentCanonicalValue,
      validationOwnership
    };
  }

  function canonicalPipelineContract({
    requirement = {},
    component = {},
    capability = {},
    expectedOutcome = {},
    validationOwnership = {},
    surfaceOwnership = {}
  } = {}) {
    surfaceOwnership = surfaceOwnership || {};
    const normalizedRequirement = {
      requirementId: text(requirement.requirementId || requirement.id, 320),
      subjectId: text(requirement.subjectId, 160),
      semanticType: text(requirement.semanticType, 120),
      desiredCanonicalValue: text(
        requirement.desiredCanonicalValue || requirement.desiredValue,
        600
      ),
      policyRequirementId: text(requirement.policyRequirementId || "", 320)
    };
    const normalizedComponent = {
      logicalFieldId: text(component.logicalFieldId, 320),
      componentIdentity: text(
        component.componentIdentity || component.stableIdentity || component.id,
        420
      ),
      componentRole: text(component.componentRole || component.role || "value", 80),
      controlId: text(component.controlId, 160),
      controlRole: text(component.controlRole || component.observedRole || "", 100),
      currentCanonicalValue: text(
        component.currentCanonicalValue || component.currentValue,
        600
      ),
      desiredCanonicalValue: text(
        component.desiredCanonicalValue || component.desiredValue,
        600
      ),
      exactOption: cloneSerializable(component.exactOption || null),
      observedOptions: cloneSerializable(component.observedOptions || component.options || [])
    };
    const normalizedCapability = {
      capabilityId: text(capability.capabilityId, 320),
      operation: text(capability.operation, 60),
      status: Object.values(CAPABILITY_STATUS).includes(capability.status)
        ? capability.status
        : CAPABILITY_STATUS.UNAVAILABLE,
      actuatorId: text(capability.actuatorId, 160),
      actuatorIds: [...new Set((capability.actuatorIds || []).map((id) => text(id, 160)).filter(Boolean))],
      exactActuators: cloneSerializable(capability.exactActuators || []),
      strategies: cloneSerializable(capability.strategies || []),
      selectedStrategy: cloneSerializable(capability.selectedStrategy || capability.strategy || null),
      proof: cloneSerializable(capability.proof || capability.actionability || null),
      recovery: cloneSerializable(capability.recovery || null)
    };
    const normalizedSurfaceOwnership = {
      kind: text(surfaceOwnership.kind, 80),
      status: text(surfaceOwnership.status, 40),
      observationId: text(surfaceOwnership.observationId, 240),
      activeSurfaceId: text(surfaceOwnership.activeSurfaceId, 160),
      activeSurfaceType: text(surfaceOwnership.activeSurfaceType, 80),
      parentSurfaceId: text(surfaceOwnership.parentSurfaceId, 160),
      parentControlId: text(surfaceOwnership.parentControlId, 160),
      parentActuatorId: text(surfaceOwnership.parentActuatorId, 160),
      operation: text(surfaceOwnership.operation, 60),
      decisionEpisodeId: text(surfaceOwnership.decisionEpisodeId, 320),
      parentDecisionGroupId: text(surfaceOwnership.parentDecisionGroupId, 320),
      proof: cloneSerializable(surfaceOwnership.proof || null)
    };
    return {
      contractVersion: CONTRACT_VERSION,
      requirement: normalizedRequirement,
      component: normalizedComponent,
      capability: normalizedCapability,
      expectedOutcome: cloneSerializable(expectedOutcome || {}),
      validationOwnership: cloneSerializable(validationOwnership || {}),
      surfaceOwnership: normalizedSurfaceOwnership.kind ? normalizedSurfaceOwnership : null
    };
  }

  function isNormalExecutableContract(contract = {}) {
    return contract?.capability?.status === CAPABILITY_STATUS.PROVEN_EXECUTABLE;
  }

  function isBoundedRecoveryContract(contract = {}) {
    return contract?.capability?.status === CAPABILITY_STATUS.UNPROVEN_EXPERIMENT
      && contract?.capability?.recovery?.requiresVisualConfirmation === true;
  }

  function sameVisualRegion(left = {}, right = {}) {
    if (!left || !right) return false;
    const exactTextKeys = ["observationId", "controlId", "operation", "surfaceId"];
    if (exactTextKeys.some((key) => (
      left[key] && right[key] && text(left[key], 320) !== text(right[key], 320)
    ))) return false;
    return ["x", "y", "width", "height"].every((key) => {
      const leftValue = Number(left[key]);
      const rightValue = Number(right[key]);
      return Number.isFinite(leftValue)
        && Number.isFinite(rightValue)
        && Math.abs(leftValue - rightValue) < 0.5;
    });
  }

  function currentSurfaceId(observation = {}) {
    const surface = observation.page?.currentSurface || observation.currentSurface || {};
    const type = text(surface.type || "page", 80).toLowerCase();
    return type === "page" ? "surface-page" : text(surface.id || surface.surfaceId, 160);
  }

  function parentSurfaceExitOwnershipIsCurrent({ action = {}, pipelineContract = {}, control = {}, observation = {} } = {}) {
    const ownership = pipelineContract?.surfaceOwnership || {};
    const expected = action.expectedOutcome || pipelineContract?.expectedOutcome || {};
    const page = observation.page || observation || {};
    const surface = page.currentSurface || page.activeSurface || {};
    const observationId = text(observation.observationId || surface.observationId, 240);
    const activeSurfaceId = currentSurfaceId(observation.page ? observation : { page });
    const controlId = text(control.controlId, 160);
    const targetId = text(action.targetId || action.targetSnapshot?.id, 160);
    const operation = text(action.operation || pipelineContract?.capability?.operation, 60);
    if (
      ownership.kind !== "parent_controls_active_surface"
      || ownership.status !== "proven"
      || expected.type !== "active_surface_dismissed"
      || !/dropdown|listbox|menu|popover|choice/.test(text(`${surface.type || ""} ${surface.surfaceClass || ""}`, 180).toLowerCase())
      || !["open", "activate"].includes(operation)
      || !controlId
      || ownership.parentControlId !== controlId
      || ownership.parentActuatorId !== targetId
      || ownership.operation !== operation
      || ownership.activeSurfaceId !== activeSurfaceId
      || (ownership.observationId && ownership.observationId !== observationId)
      || expected.previousSurfaceId !== activeSurfaceId
      || control.state?.expanded !== true
    ) return false;
    if (
      action.visualRegion?.observationId
      && text(action.visualRegion.observationId, 240) !== observationId
    ) return false;

    const declaredParentControlId = text(surface.parentControlId, 160);
    if (declaredParentControlId && declaredParentControlId !== controlId) return false;
    const capability = control.operations?.[operation] || null;
    const executable = capability?.actionability?.executable === true
      || capability?.actionabilityByActuator?.[targetId]?.executable === true;
    if (!executable || !(capability?.actuatorIds || []).includes(targetId)) return false;

    const expandedOpeners = (page.controls || []).filter((candidate) => (
      candidate.state?.expanded === true
      && /combobox|button/.test(`${candidate.role || ""} ${candidate.kind || ""}`.toLowerCase())
      && [candidate.operations?.open, candidate.operations?.activate].some((candidateCapability) => (
        candidateCapability?.actionability?.executable === true
      ))
    ));
    if (expandedOpeners.length !== 1 || expandedOpeners[0].controlId !== controlId) return false;

    const allowedSurfaceIds = new Set([
      activeSurfaceId,
      text(ownership.parentSurfaceId, 160),
      text(control.surfaceId, 160)
    ].filter(Boolean));
    const boundSurfaceIds = [
      action.surfaceId,
      action.targetSnapshot?.surfaceId,
      control.surfaceId,
      action.visualRegion?.surfaceId
    ].map((value) => text(value, 160)).filter(Boolean);
    return boundSurfaceIds.every((value) => allowedSurfaceIds.has(value));
  }

  function expectedOutcomeIsVerifiable(expectedOutcome = {}) {
    const type = text(expectedOutcome?.type, 120);
    if (!type) return false;
    return ![
      "action_acknowledged",
      "click_dispatched",
      "command_acknowledged",
      "dom_mutated",
      "event_dispatched"
    ].includes(type);
  }

  function strategyMatchesAction(strategy = {}, action = {}, operation = "") {
    if (!strategy || typeof strategy !== "object") return false;
    const actionType = text(action.type || action.action, 40);
    const actionMethod = text(action.interactionMethod, 80);
    const targetId = text(action.targetId || action.targetSnapshot?.id, 160);
    if (text(strategy.operation || operation, 60) !== text(operation, 60)) return false;
    if (actionMethod && text(strategy.method, 80) !== actionMethod) return false;
    if (actionType && strategy.actionType && text(strategy.actionType, 40) !== actionType) return false;
    if (actionType === "click_xy") {
      return strategy.method === INTERACTION_METHOD.VISUAL_COORDINATE;
    }
    return Boolean(targetId) && text(strategy.actuatorId, 160) === targetId;
  }

  function bindingIsCurrent({ action = {}, pipelineContract = {}, control = {}, observation = {} } = {}) {
    const observationId = text(observation.observationId, 240);
    const actionObservationId = text(action.observationId, 240);
    if (observationId && actionObservationId !== observationId) return false;

    const actionControlId = text(
      action.controlId || action.targetSnapshot?.controlId || pipelineContract.component?.controlId,
      160
    );
    if (control.controlId && actionControlId !== text(control.controlId, 160)) return false;
    if (
      pipelineContract.component?.controlId
      && control.controlId
      && text(pipelineContract.component.controlId, 160) !== text(control.controlId, 160)
    ) return false;

    if (parentSurfaceExitOwnershipIsCurrent({ action, pipelineContract, control, observation })) return true;

    const surfaceId = currentSurfaceId(observation);
    const boundSurfaceIds = [
      action.surfaceId,
      action.targetSnapshot?.surfaceId,
      control.surfaceId,
      action.visualRegion?.surfaceId
    ].map((value) => text(value, 160)).filter(Boolean);
    if (surfaceId && boundSurfaceIds.some((value) => value !== surfaceId)) return false;
    if (action.visualRegion?.observationId && text(action.visualRegion.observationId, 240) !== observationId) {
      return false;
    }
    return true;
  }

  function boundedRecoveryIsSafe(action = {}) {
    const risk = text(action.risk || action.targetSnapshot?.risk, 80).toLowerCase();
    const semantic = text(
      action.semanticIntent || action.intent || action.targetSnapshot?.semantic,
      240
    ).toLowerCase();
    if (risk === "payment" || /payment|purchase|book_now|confirm_booking/.test(semantic)) return false;
    if (risk === "legal" || /legal|terms_accept|accept_terms|consent/.test(semantic)) return false;
    if (["money", "paid"].includes(risk)) {
      return action.approvedPaidAction === true
        || action.affordance?.policy?.allow === true;
    }
    return action.requiresApproval !== true;
  }

  /**
   * One authoritative execution-lane decision shared by planning, governance,
   * and dispatch. Targetability alone never promotes a strategy to normal
   * execution; an unproven exact strategy can run only through bounded
   * recovery with fresh bindings and observable verification.
   */
  function classifyExecutionLane({
    action = {},
    pipelineContract = action.pipelineContract || {},
    control = {},
    observation = {},
    strategyAlreadyFailed = false
  } = {}) {
    const capability = pipelineContract?.capability || {};
    const operation = text(action.operation || capability.operation, 60);
    const actionType = text(action.type || action.action, 40);
    const targetId = text(action.targetId || action.targetSnapshot?.id, 160);
    const selectedStrategy = capability.selectedStrategy || capability.strategy || null;
    const mechanical = ["click", "type", "select", "keypress", "scroll", "click_xy"].includes(actionType);
    if (!mechanical || !operation || !bindingIsCurrent({ action, pipelineContract, control, observation })) {
      return EXECUTION_LANE.DENY;
    }

    if (capability.status === CAPABILITY_STATUS.PROVEN_EXECUTABLE) {
      const operationCapability = control.operations?.[operation] || null;
      const exactProof = operationCapability?.actionabilityByActuator?.[targetId]
        || capability.proof
        || selectedStrategy?.proof
        || null;
      const exactStrategy = selectedStrategy
        || (operationCapability?.strategies || []).find((strategy) => strategyMatchesAction(strategy, action, operation));
      const exactActuator = Boolean(
        targetId
        && !(
          (control.disabled === true || control.state?.disabled === true)
          && targetId === text(control.stateElementId, 160)
        )
        && (operationCapability?.actuatorIds || capability.actuatorIds || []).includes(targetId)
      );
      if (
        exactActuator
        && exactStrategy
        && strategyMatchesAction(exactStrategy, action, operation)
        && exactProof?.executable === true
        && exactProof?.operationProven === true
      ) {
        return EXECUTION_LANE.NORMAL;
      }
      return EXECUTION_LANE.DENY;
    }

    if (capability.status === CAPABILITY_STATUS.RECOVERABLE) {
      return EXECUTION_LANE.REVEAL;
    }

    const recovery = control.recovery?.[operation] || capability.recovery || null;
    const allowedRecoveryMethods = new Set([
      INTERACTION_METHOD.NATIVE_CLICK,
      INTERACTION_METHOD.POINTER_SEQUENCE,
      INTERACTION_METHOD.FOCUS_ENTER,
      INTERACTION_METHOD.FOCUS_SPACE,
      INTERACTION_METHOD.FOCUS_ARROW_DOWN,
      INTERACTION_METHOD.VISUAL_COORDINATE,
      INTERACTION_METHOD.BROWSER_TRUSTED_INPUT,
      INTERACTION_METHOD.BROWSER_TRUSTED_CHOICE
    ]);
    const exactRecoveryStrategy = (control.recovery?.[operation]?.strategies || [])
      .find((strategy) => strategyMatchesAction(strategy, action, operation));
    const exactVisualRegion = actionType === "click_xy"
      && (control.recovery?.[operation]?.regions || []).some((region) => (
        sameVisualRegion(region, action.visualRegion || action.targetSnapshot?.visualRegion)
      ));
    const selectedMatches = selectedStrategy
      && strategyMatchesAction(selectedStrategy, action, operation);
    const recoveryMethod = text(
      action.interactionMethod || selectedStrategy?.method || exactRecoveryStrategy?.method,
      80
    );
    if (
      capability.status === CAPABILITY_STATUS.UNPROVEN_EXPERIMENT
      && action.boundedRecovery === true
      && recovery?.requiresVisualConfirmation === true
      && allowedRecoveryMethods.has(recoveryMethod)
      && (exactRecoveryStrategy || exactVisualRegion)
      && selectedMatches
      && strategyAlreadyFailed !== true
      && boundedRecoveryIsSafe(action)
      && expectedOutcomeIsVerifiable(pipelineContract.expectedOutcome || action.expectedOutcome)
    ) {
      return EXECUTION_LANE.BOUNDED_RECOVERY;
    }
    return EXECUTION_LANE.DENY;
  }

  function ageChoiceBounds(value = "") {
    const normalized = String(value || "")
      .toLowerCase()
      .replace(/[–—]/g, "-")
      .replace(/_/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    let match = normalized.match(/(\d{1,3})\s*(?:-|to)\s*(\d{1,3})/i);
    if (match) return { minimum: Number(match[1]), maximum: Number(match[2]) };
    match = normalized.match(/(?:under|younger than|less than|<)\s*(\d{1,3})/i);
    if (match) return { minimum: 0, maximum: Number(match[1]) - 1 };
    match = normalized.match(/(\d{1,3})\s*(?:\+|plus|and (?:over|older)|or (?:over|older)|and above|or above)/i);
    if (match) return { minimum: Number(match[1]), maximum: 130 };
    match = normalized.match(/^\D*(\d{1,3})\s*(?:years?|yrs?)?\D*$/i);
    if (!match) return null;
    const exact = Number(match[1]);
    return Number.isInteger(exact) && exact >= 0 && exact <= 130
      ? { minimum: exact, maximum: exact }
      : null;
  }

  function profileChoiceValueCompatible(actualValue = "", desiredValue = "", semanticType = "") {
    const actual = String(actualValue || "").replace(/\s+/g, " ").trim().toLowerCase();
    const desired = String(desiredValue || "").replace(/\s+/g, " ").trim().toLowerCase();
    if (!actual || !desired) return false;
    if (actual === desired) return true;
    const normalizedSemanticType = String(semanticType || "").toLowerCase();
    if (normalizedSemanticType === "phone_country_code") {
      const desiredDigits = desired.replace(/\D/g, "");
      const observedCodes = actual.match(/\+?\d[\d\s().-]*/g) || [];
      return Boolean(desiredDigits && observedCodes.some((code) => (
        code.replace(/\D/g, "") === desiredDigits
      )));
    }
    if (normalizedSemanticType !== "age_at_departure") return false;
    const desiredBounds = ageChoiceBounds(desired);
    const actualBounds = ageChoiceBounds(actual);
    if (!desiredBounds || desiredBounds.minimum !== desiredBounds.maximum || !actualBounds) return false;
    const age = desiredBounds.minimum;
    return age >= actualBounds.minimum && age <= actualBounds.maximum;
  }

  function isPlaceholderChoiceValue(value = "", evidence = {}) {
    const raw = String(value ?? "").replace(/\s+/g, " ").trim();
    const label = String(evidence.optionLabel ?? evidence.label ?? raw).replace(/\s+/g, " ").trim();
    const optionValue = String(evidence.optionValue ?? raw).replace(/\s+/g, " ").trim();
    const normalized = raw.toLowerCase();
    const normalizedLabel = label.toLowerCase();
    const normalizedOptionValue = optionValue.toLowerCase();
    const prompt = /^(?:choose|select|please select|select one(?: option)?|please choose|month|day|year|title|gender|nationality|country|none selected|not selected)$/i;
    const sentinel = /^(?:-1|null|undefined|placeholder|prompt|unselected|none_selected|not_selected)$/i;
    const punctuationOnly = /^(?:[-–—_.*]+)$/;
    if (!raw && (
      !label
      || prompt.test(normalizedLabel)
      || punctuationOnly.test(label)
      || evidence.optionDisabled === true
      || evidence.optionIndex === 0
    )) return true;
    if (prompt.test(normalized) || prompt.test(normalizedLabel)) return true;
    if (sentinel.test(normalized) || sentinel.test(normalizedOptionValue)) return true;
    if (punctuationOnly.test(label) || punctuationOnly.test(raw)) return true;
    if (evidence.optionDisabled === true && evidence.optionIndex === 0) return true;
    return false;
  }

  function phoneDigits(value = "") {
    return String(value || "").replace(/\D/g, "");
  }

  function canonicalPhoneParts({ phone = "", countryCode = "", localNumber = "" } = {}) {
    const rawPhone = String(phone || "").trim();
    const explicitCodeDigits = phoneDigits(countryCode);
    const phoneValueDigits = phoneDigits(rawPhone);
    const localValueDigits = phoneDigits(localNumber);
    const country = explicitCodeDigits ? `+${explicitCodeDigits}` : "";
    let local = localValueDigits || phoneValueDigits;
    if (explicitCodeDigits && local.startsWith(explicitCodeDigits)) local = local.slice(explicitCodeDigits.length);
    local = local.replace(/^0+/, "");
    return Object.freeze({
      countryCode: country,
      localNumber: local,
      international: country && local
        ? `${country}${local}`
        : rawPhone.startsWith("+") && phoneValueDigits
          ? `+${phoneValueDigits}`
          : local
    });
  }

  function inferPhoneFieldCodec(evidence = {}) {
    const autocomplete = String(evidence.autocomplete || "").trim().toLowerCase();
    const semanticType = canonicalProfileFieldType(evidence.semanticType || evidence.fieldType || "");
    const text = [
      evidence.label,
      evidence.placeholder,
      evidence.description,
      evidence.accessibleDescription,
      evidence.helperText,
      evidence.pattern,
      evidence.name,
      evidence.inputMode
    ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim().toLowerCase();
    let representation = "local_only";
    let source = "default_local";
    if (semanticType === "phone_country_code" || autocomplete === "tel-country-code") {
      representation = "country_code";
      source = semanticType === "phone_country_code" ? "semantic_type" : "autocomplete";
    } else if (autocomplete === "tel-national") {
      representation = "local_only";
      source = "autocomplete";
    } else if (
      autocomplete === "tel"
      || /include (?:your )?country code|with (?:the )?country code|international (?:phone|telephone|mobile|number)|country code.*(?:phone|number)|(?:phone|number).*country code|e\.164|example\s*\+\d|e\.g\.\s*\+\d/.test(text)
    ) {
      representation = "combined_international";
      source = autocomplete === "tel" ? "autocomplete_and_local_evidence" : "local_format_evidence";
    }
    return Object.freeze({
      contractVersion: "phone-field-codec/v1",
      representation,
      source,
      evidence: text.slice(0, 320)
    });
  }

  function encodePhoneForField(profile = {}, codec = {}) {
    const parts = canonicalPhoneParts({
      phone: profile.phone || profile.mobile || "",
      countryCode: profile.phone_country_code || profile.country_code || profile.dial_code || "",
      localNumber: profile.phone_local_number || profile.local_phone_number || ""
    });
    if (codec.representation === "country_code") return parts.countryCode;
    if (codec.representation === "combined_international") return parts.international;
    return parts.localNumber;
  }

  return Object.freeze({
    CONTRACT_VERSION,
    TERMINAL_EVIDENCE_VERSION,
    CAPABILITY_STATUS,
    INTERACTION_METHOD,
    EXECUTION_LANE,
    DECISION_KIND,
    SEMANTIC_READINESS,
    SEMANTIC_EFFECT,
    DECISION_AVAILABILITY,
    PROFILE_FIELD_ALIAS_GROUPS,
    PROFILE_FIELD_ALIASES,
    PROFILE_FIELD_TYPES,
    canonicalSemanticEffect,
    semanticEffectSatisfies,
    isPaidCommerceOption,
    classifySelectedCommerceTruth,
    isGenuineSelectedPaidItem,
    canonicalProfileFieldType,
    cloneSerializable,
    operationAvailability,
    controlAvailability,
    decisionAvailability,
    normalizedActionability,
    capabilityStatusFor,
    actionTypeForMethod,
    keysForMethod,
    stableStrategyId,
    normalizeStrategy,
    normalizeCapability,
    observedComponentContract,
    serializeObservedControl,
    canonicalPipelineContract,
    normalizeDecisionContract,
    compileTerminalEvidence,
    isLegalAcceptanceText,
    isInsuranceOfferText,
    isPaymentCommitText,
    compileSemanticCheckout,
    profileChoiceValueCompatible,
    isPlaceholderChoiceValue,
    canonicalPhoneParts,
    inferPhoneFieldCodec,
    encodePhoneForField,
    isNormalExecutableContract,
    isBoundedRecoveryContract,
    classifyExecutionLane,
    parentSurfaceExitOwnershipIsCurrent
  });
});
