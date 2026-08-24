"use strict";

const { legalAcceptanceScope } = require("../../../packages/shared/policy");

const SEAT_POLICIES = Object.freeze({
  RANDOM_ASSIGNMENT: "random_assignment",
  AISLE: "aisle",
  WINDOW: "window",
  TOGETHER: "together",
  SPECIFIC_SEAT: "specific_seat",
  UNSPECIFIED: "unspecified"
});

function clean(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function lower(value = "") {
  return clean(value).toLowerCase();
}

function subjectKey(value = {}) {
  return lower(value.subject?.key || value.subject || value.sectionType || value.family || "unknown").replace(/\s+/g, "_");
}

function optionPrice(option = {}) {
  const amount = Number(option.priceDelta ?? option.structuredPrice?.amount ?? option.price?.amount);
  return Number.isFinite(amount) ? amount : null;
}

function normalizedOptions(decision = {}) {
  const source = decision.availableTransitions
    || decision.decisionContract?.options
    || decision.options
    || decision.alternatives
    || [];
  const mapped = source.map((option) => {
    const meaning = lower(`${option.label || ""} ${option.semantic || ""} ${option.risk || ""}`);
    const declinesPaid = /decline|no thanks|without|skip|remove|not now|random|automatic|\bno (?:bundle|insurance|protection|ticket|baggage|bag|seat)\b/.test(meaning);
    return ({
    optionId: clean(option.optionId || option.controlId),
    controlId: clean(option.controlId),
    label: clean(option.label || option.canonicalValue),
    price: optionPrice(option),
    currency: clean(option.currency || option.structuredPrice?.currency || option.price?.currency).toUpperCase(),
    included: option.included === true
      || optionPrice(option) === 0
      || /decline|no thanks|without|skip|remove|not now|random|automatic|\bno (?:bundle|insurance|protection|ticket|baggage|bag|seat)\b/.test(lower(`${option.label || ""} ${option.semantic || ""} ${option.risk || ""}`)),
    paid: !declinesPaid && (option.paid === true || Number(optionPrice(option)) > 0 || /money|paid|purchase|upgrade|add_paid/.test(meaning)),
    selected: option.selected === true,
    executable: option.executable !== false,
    canonicalAttributes: option.canonicalAttributes || {},
    raw: option
  });
  }).filter((option) => option.optionId || option.controlId);
  return mapped;
}

function parsePriceLimit(value = "") {
  const text = lower(value);
  const match = text.match(/(?:maximum|max(?:imum)?|up to|under|no more than|limit(?:ed)? to)\s*(?:(eur|usd|gbp|try|tl|€|\$|£|₺)\s*)?(\d[\d\s.,]*)(?:\s*(eur|usd|gbp|try|tl|€|\$|£|₺))?/i);
  if (!match) return null;
  let raw = match[2].replace(/\s/g, "");
  const lastComma = raw.lastIndexOf(",");
  const lastDot = raw.lastIndexOf(".");
  if (lastComma >= 0 && lastDot < 0 && raw.length - lastComma - 1 === 3) raw = raw.replace(/,/g, "");
  else if (lastDot >= 0 && lastComma < 0 && raw.length - lastDot - 1 === 3) raw = raw.replace(/\./g, "");
  else if (lastComma > lastDot) raw = raw.replace(/\./g, "").replace(",", ".");
  else raw = raw.replace(/,/g, "");
  const amount = Number(raw);
  if (!Number.isFinite(amount)) return null;
  const rawCurrency = String(match[1] || match[3] || "").toUpperCase();
  const currencies = { "€": "EUR", "$": "USD", "£": "GBP", "₺": "TRY", TL: "TRY" };
  return { amount, currency: currencies[rawCurrency] || rawCurrency };
}

function countFromText(value = "") {
  const text = lower(value);
  const words = { one: 1, two: 2, three: 3, four: 4 };
  const match = text.match(/\b(one|two|three|four|\d+)\s*(?:x|×)?\s*(?:checked|hold|cabin|hand|carry.?on)?\s*(?:bag|baggage|luggage)/);
  if (!match) return null;
  return words[match[1]] ?? Number(match[1]);
}

function explicitNoPaid(value = "") {
  return /decline all paid|skip all paid|avoid all paid|nothing paid|\bno paid extras?\b|\bno paid upgrades?\b|\bno extras?\b|\bwithout extras?\b|\bskip extras?\b|nothing extra/.test(lower(value));
}

function normalizeAuthorization(raw = {}, index = 0) {
  const maximumAmount = Number(raw.maximumAmount ?? raw.maxAmount ?? raw.priceLimit?.amount);
  return Object.freeze({
    authorizationId: clean(raw.authorizationId || `profile_authorization_${index + 1}`),
    subject: lower(raw.subject || raw.family || raw.semanticType || ""),
    decisionGroupId: clean(raw.decisionGroupId),
    maximumAmount: Number.isFinite(maximumAmount) ? maximumAmount : null,
    currency: clean(raw.currency || raw.priceLimit?.currency).toUpperCase(),
    source: clean(raw.source || "profile")
  });
}

function normalizeProfilePolicy({ userPolicy = {}, traveler = {} } = {}) {
  const bookingSpecific = clean(
    userPolicy.bookingInstruction
    || userPolicy.oneOffInstruction
    || userPolicy.userGoal
    || userPolicy.sessionInstruction
    || ""
  );
  const savedRules = clean([userPolicy.bookingRules, traveler.booking_rules].filter(Boolean).join(" "));
  const seatPolicy = seatPolicyFrom({ userPolicy, traveler });
  const policyText = lower(`${bookingSpecific} ${savedRules} ${userPolicy.baggage || ""} ${traveler.baggage_preference || ""} ${userPolicy.insurance || ""} ${userPolicy.extras || ""}`);
  const globalNoPaid = userPolicy.skipPaidExtrasApproved === true || explicitNoPaid(policyText);
  const noPaidByFamily = Object.freeze({
    seat: globalNoPaid || seatPolicy === SEAT_POLICIES.RANDOM_ASSIGNMENT,
    baggage: globalNoPaid || /no paid (?:bag|baggage)|no checked (?:bag|baggage)|no (?:bag|baggage)|personal item only|without baggage/.test(policyText),
    insurance: globalNoPaid || /no insurance|no protection|skip insurance|without protection/.test(policyText),
    extras: globalNoPaid || /no extras?|no add.?ons?|no bundles?|no flexible ticket|skip extras?|without extras?/.test(policyText)
  });
  const authorizations = [
    ...(Array.isArray(userPolicy.authorizations) ? userPolicy.authorizations : []),
    ...(Array.isArray(userPolicy.paidExtraAuthorizations) ? userPolicy.paidExtraAuthorizations : []),
    ...(Array.isArray(traveler.authorizations) ? traveler.authorizations : []),
    ...(Array.isArray(traveler.paid_extra_authorizations) ? traveler.paid_extra_authorizations : [])
  ].map(normalizeAuthorization);
  return Object.freeze({
    facts: Object.freeze({ travelerId: clean(traveler.id), profile: traveler }),
    preferences: Object.freeze({
      seatPolicy,
      baggage: clean(userPolicy.baggage || traveler.baggage_preference),
      insurance: clean(userPolicy.insurance || traveler.insurance_preference),
      extras: clean(userPolicy.extras || traveler.extras_preference),
      fare: clean(userPolicy.fare || traveler.fare_preference),
      payment: clean(userPolicy.paymentPreference || traveler.payment_preference),
      meal: clean(userPolicy.meal || traveler.meal_preference)
    }),
    constraints: Object.freeze({
      noPaidExtras: globalNoPaid,
      noPaidByFamily
    }),
    authorizations: Object.freeze(authorizations),
    fallbacks: Object.freeze(userPolicy.fallbacks || traveler.booking_fallbacks || {}),
    bookingSpecific,
    savedRules,
    precedence: Object.freeze(["booking_specific", "safety", "saved_profile", "fallback", "ask_user"])
  });
}

function authorizationFor({ policy = {}, subject = "", decision = {}, option = {}, sourceText = "", source = "" } = {}) {
  if (option.included || Number(option.price) === 0) return null;
  const exact = (policy.authorizations || []).find((authorization) => (
    (!authorization.decisionGroupId || authorization.decisionGroupId === decision.decisionGroupId)
    && (!authorization.subject || subject.includes(authorization.subject) || authorization.subject.includes(subject))
    && (authorization.maximumAmount == null || Number(option.price) <= authorization.maximumAmount)
    && (!authorization.currency || !option.currency || authorization.currency === option.currency)
  ));
  if (exact) return exact;
  const limit = parsePriceLimit(sourceText);
  const explicitlyAuthorizes = /allow|authorize|approved|choose|select|book|add|want|need|maximum|max|up to/.test(lower(sourceText));
  if (!limit || !explicitlyAuthorizes || Number(option.price) > limit.amount) return null;
  if (limit.currency && option.currency && limit.currency !== option.currency) return null;
  return Object.freeze({
    authorizationId: `policy_${subject || "decision"}_${source || "rule"}`,
    subject,
    decisionGroupId: clean(decision.decisionGroupId || decision.decisionId),
    maximumAmount: limit.amount,
    currency: limit.currency || option.currency,
    source
  });
}

function resolutionResult({ match = "ambiguous", source = "", options = [], preferred = null, authorization = null, reason = "", evidence = [] } = {}) {
  return Object.freeze({
    match,
    source,
    eligibleOptionIds: Object.freeze(options.map((option) => option.optionId || option.controlId).filter(Boolean)),
    preferredOptionId: clean(preferred?.optionId || preferred?.controlId),
    preferredControlId: clean(preferred?.controlId),
    authorization: authorization || null,
    reason,
    evidence: Object.freeze(evidence.filter(Boolean).map(clean).slice(0, 8))
  });
}

function resolveProfileDecision(decision = {}, { userPolicy = {}, traveler = {}, normalizedPolicy = null } = {}) {
  const policy = normalizedPolicy || userPolicy.profilePolicy || normalizeProfilePolicy({ userPolicy, traveler });
  const subject = subjectKey(decision);
  const options = normalizedOptions(decision).filter((option) => option.executable);
  const bookingSpecific = policy.bookingSpecific || "";
  const savedText = clean([
    policy.savedRules,
    policy.preferences?.[subject],
    subject.includes("seat") ? policy.preferences?.seatPolicy : "",
    subject.includes("baggage") ? policy.preferences?.baggage : "",
    subject.includes("insurance") ? policy.preferences?.insurance : "",
    subject.includes("fare") ? policy.preferences?.fare : "",
    subject.includes("payment") ? policy.preferences?.payment : "",
    policy.preferences?.extras
  ].filter(Boolean).join(" "));
  const sources = [
    { source: "booking_specific", text: bookingSpecific },
    { source: "saved_profile", text: savedText }
  ].filter((item) => item.text);
  const family = subject.includes("seat")
    ? "seat"
    : subject.includes("baggage")
      ? "baggage"
      : subject.includes("insurance") || subject.includes("protection")
        ? "insurance"
        : /fare|flex|extra|bundle|priority|upgrade/.test(subject)
          ? "extras"
          : "";
  const subjectNoPaid = Boolean(family) && (
    policy.constraints?.noPaidExtras || policy.constraints?.noPaidByFamily?.[family] === true
  );

  for (const source of sources) {
    const direct = options.filter((option) => {
      const label = lower(option.label);
      return label.length >= 3 && new RegExp(`(?:^|[^a-z0-9])${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^a-z0-9])`, "i").test(source.text);
    });
    if (direct.length === 1) {
      if (subjectNoPaid && direct[0].included) {
        // Negative safety/profile language describes an acceptable state set.
        // It must not become a command to click a matching "No insurance" or
        // "No extras" representation when the page already accepts no paid
        // selection.
        return resolutionResult({
          match: "constraint",
          source: policy.constraints?.noPaidExtras ? "no_paid_extras" : source.source,
          options: direct,
          preferred: direct[0],
          reason: "The no-paid preference constrains the resulting state; it does not require activating this decline representation.",
          evidence: [source.text]
        });
      }
      const authorization = authorizationFor({ policy, subject, decision, option: direct[0], sourceText: source.text, source: source.source });
      if (direct[0].paid && !authorization) {
        return resolutionResult({ match: "ambiguous", source: source.source, options: direct, reason: "A paid option is preferred but no bounded financial authorization covers it.", evidence: [source.text] });
      }
      return resolutionResult({ match: "exact", source: source.source, options: direct, preferred: direct[0], authorization, reason: "An exact option name matches the highest-precedence applicable instruction.", evidence: [source.text] });
    }
  }

  const combined = lower(`${bookingSpecific} ${savedText}`);
  if (/legal|terms|conditions|consent|attestation/.test(subject)) {
    const eligible = options.filter((option) => legalAcceptanceScope({
      targetLabel: option.label,
      targetSnapshot: {
        label: option.label,
        semantic: option.raw?.semantic,
        description: option.raw?.description
      }
    }) === "standard_terms");
    if (eligible.length) {
      return resolutionResult({
        match: "exact",
        source: "checkout_mandate",
        options: eligible,
        preferred: eligible.length === 1 ? eligible[0] : null,
        reason: "The transaction-bound Book/Pay mandate covers ordinary required booking terms.",
        evidence: eligible.map((option) => option.label)
      });
    }
    return resolutionResult({
      match: "ambiguous",
      source: "checkout_mandate",
      options: [],
      reason: "The legal choice is exceptional, bundled, or not proven to be ordinary booking terms.",
      evidence: options.map((option) => option.label)
    });
  }
  if (/payment|card|wallet/.test(subject)) {
    const preference = lower(policy.preferences?.payment || "browser saved card");
    const wantsWallet = /apple pay|google pay|wallet/.test(preference);
    const eligible = options.filter((option) => {
      const label = lower(`${option.label} ${option.raw?.semantic || ""}`);
      return wantsWallet
        ? /apple pay|google pay|wallet/.test(label)
        : /credit|debit|payment card|pay by card|card payment|browser saved card|virtual card|\bvisa\b|mastercard|master card|american express|\bamex\b|\bmaestro\b|diners club|\bdiscover\b/.test(label)
          && !/gift card|loyalty card/.test(label);
    });
    if (eligible.length) {
      const equivalentCardEntryRoutes = !wantsWallet && eligible.every((option) => (
        option.paid !== true
        && option.raw?.physicalEffect === "reveal_control"
      ));
      return resolutionResult({
        match: "exact",
        source: "saved_profile",
        options: eligible,
        preferred: eligible.length === 1 || equivalentCardEntryRoutes ? eligible[0] : null,
        reason: `Payment-method choice follows the saved profile preference: ${preference}.`,
        evidence: [preference]
      });
    }
    if (decision.required === true || decision.material === true) {
      return resolutionResult({
        match: "unavailable",
        source: "saved_profile",
        options: [],
        reason: `No available payment method matches the saved profile preference: ${preference}.`,
        evidence: [preference]
      });
    }
  }
  const explicitSeatSkips = subject.includes("seat")
    ? options.filter((option) => /random|automatic|without|skip|no seat|no thanks/.test(lower(option.label)))
    : [];
  const continueSeatSelection = subject.includes("seat")
    ? options.filter((option) => /continue with (?:seat|seating) selection|continue to (?:seat|seating) selection|choose (?:a )?seat|select (?:a )?seat/.test(lower(option.label)))
    : [];
  const seatSelectionGate = explicitSeatSkips.length > 0 && continueSeatSelection.length > 0;
  if (seatSelectionGate && policy.preferences?.seatPolicy === SEAT_POLICIES.RANDOM_ASSIGNMENT) {
    return resolutionResult({
      match: "constraint",
      source: "seat_policy",
      options: explicitSeatSkips,
      preferred: explicitSeatSkips.length === 1 ? explicitSeatSkips[0] : null,
      reason: "Seat policy requests random assignment, so the seat-selection gate must be skipped.",
      evidence: [bookingSpecific || savedText]
    });
  }
  if (seatSelectionGate && [
    SEAT_POLICIES.AISLE,
    SEAT_POLICIES.WINDOW,
    SEAT_POLICIES.TOGETHER,
    SEAT_POLICIES.SPECIFIC_SEAT
  ].includes(policy.preferences?.seatPolicy)) {
    return resolutionResult({
      match: "constraint",
      source: "seat_policy",
      options: continueSeatSelection,
      preferred: continueSeatSelection.length === 1 ? continueSeatSelection[0] : null,
      reason: `Seat policy requests ${policy.preferences.seatPolicy}, so continue into seat selection before choosing an eligible seat.`,
      evidence: [bookingSpecific || savedText]
    });
  }
  if (subject.includes("seat") && policy.preferences?.seatPolicy === SEAT_POLICIES.RANDOM_ASSIGNMENT) {
    const specificFreeSeat = options.some((option) => option.included && /\bseat\s*[a-z]?\d+[a-z]?\b/i.test(option.label));
    const explicitRandomAssignment = options.filter((option) => (
      /random|automatic|without|skip|no seat|no thanks/.test(lower(option.label))
    ));
    const eligible = explicitRandomAssignment.length
      ? explicitRandomAssignment
      : options.filter((option) => (
          !specificFreeSeat
          && /continue|next|proceed|done|finish/.test(lower(`${option.label} ${option.raw?.semantic || ""}`))
          && !option.paid
        ));
    return resolutionResult({
      match: "constraint",
      source: "seat_policy",
      options: eligible,
      preferred: eligible.length === 1 ? eligible[0] : null,
      reason: "Seat policy requests random assignment or safe forward progress without buying a seat.",
      evidence: [bookingSpecific || savedText]
    });
  }
  if (subjectNoPaid
    && options.length > 0
    && options.every((option) => !option.included && option.paid)) {
    return resolutionResult({
      match: "constraint",
      source: policy.constraints?.noPaidExtras ? "no_paid_extras" : (bookingSpecific ? "booking_specific" : "saved_profile"),
      options: [],
      preferred: null,
      reason: "Explicit no-paid policy is already satisfied by leaving this optional product unselected.",
      evidence: [bookingSpecific || savedText]
    });
  }
  if (subject.includes("seat") && [SEAT_POLICIES.WINDOW, SEAT_POLICIES.AISLE].includes(policy.preferences?.seatPolicy)) {
    const requested = policy.preferences.seatPolicy;
    const eligible = options.filter((option) => lower(`${option.label} ${option.canonicalAttributes?.evidenceText || ""}`).includes(requested));
    if (!eligible.length) {
      return resolutionResult({ match: "unavailable", source: bookingSpecific ? "booking_specific" : "saved_profile", options: [], reason: `The requested ${requested} seat is not available.`, evidence: [bookingSpecific || savedText] });
    }
    const preferred = [...eligible].sort((left, right) => (left.price ?? Number.MAX_SAFE_INTEGER) - (right.price ?? Number.MAX_SAFE_INTEGER))[0];
    const sourceText = bookingSpecific || savedText;
    const authorization = authorizationFor({ policy, subject, decision, option: preferred, sourceText, source: bookingSpecific ? "booking_specific" : "saved_profile" });
    if (preferred.paid && !authorization) {
      return resolutionResult({ match: "ambiguous", source: bookingSpecific ? "booking_specific" : "saved_profile", options: eligible, reason: `The preferred ${requested} seat is paid and lacks bounded authorization.`, evidence: [sourceText] });
    }
    return resolutionResult({ match: "exact", source: bookingSpecific ? "booking_specific" : "saved_profile", options: eligible, preferred, authorization, reason: `Seat policy requests a ${requested} seat.`, evidence: [sourceText] });
  }
  if (subject.includes("baggage") && !subject.includes("protection")) {
    const noBag = /no paid (?:bag|baggage)|no checked (?:bag|baggage)|without baggage|personal item only/.test(combined);
    const countMatch = combined.match(/\b(one|two|three|four|\d+)\s*(?:x|×)?\s*(?:checked|hold|cabin|hand|carry.?on)?\s*(?:bag|baggage|luggage)/);
    const words = { one: 1, two: 2, three: 3, four: 4 };
    const requestedCount = countMatch ? (words[countMatch[1]] ?? Number(countMatch[1])) : null;
    const eligible = noBag
      ? options.filter((option) => option.included || /no |without|0\s*(?:bag|baggage)/.test(lower(option.label)))
      : Number.isFinite(requestedCount)
        ? options.filter((option) => countFromText(option.label) === requestedCount)
        : [];
    if (noBag || Number.isFinite(requestedCount)) {
      if (!eligible.length) {
        return resolutionResult({ match: "unavailable", source: bookingSpecific ? "booking_specific" : "saved_profile", options: [], reason: "The requested baggage configuration is not available.", evidence: [bookingSpecific || savedText] });
      }
      const preferred = [...eligible].sort((left, right) => (left.price ?? Number.MAX_SAFE_INTEGER) - (right.price ?? Number.MAX_SAFE_INTEGER))[0];
      const sourceText = bookingSpecific || savedText;
      const authorization = authorizationFor({ policy, subject, decision, option: preferred, sourceText, source: bookingSpecific ? "booking_specific" : "saved_profile" });
      if (preferred.paid && !authorization) {
        return resolutionResult({ match: "ambiguous", source: bookingSpecific ? "booking_specific" : "saved_profile", options: eligible, reason: "The requested paid baggage lacks bounded authorization.", evidence: [sourceText] });
      }
      return resolutionResult({ match: noBag ? "constraint" : "exact", source: bookingSpecific ? "booking_specific" : "saved_profile", options: eligible, preferred, authorization, reason: noBag ? "Baggage policy prohibits paid baggage." : `Baggage policy requests ${requestedCount} bag(s).`, evidence: [sourceText] });
    }
  }
  const refundThreshold = Number(combined.match(/(?:at least|minimum|min\.?|>=)\s*(\d{1,3})\s*%\s*refund/)?.[1]
    || combined.match(/(\d{1,3})\s*%\s*(?:or more\s*)?refund/)?.[1]);
  let eligible = options;
  let reason = "";
  if (subjectNoPaid) {
    eligible = options.filter((option) => option.included && !option.paid);
    reason = "Explicit policy prohibits paid options for this subject.";
  } else if (Number.isFinite(refundThreshold) && refundThreshold > 0) {
    eligible = options.filter((option) => Number(option.canonicalAttributes?.refundPercent) >= refundThreshold);
    reason = `Option must provide at least ${refundThreshold}% refundability.`;
  } else if (/flexible|free (?:trip )?changes?|changes? allowed|rebook/.test(combined)) {
    eligible = options.filter((option) => (
      option.canonicalAttributes?.flexibility === "changes_allowed"
      || (option.canonicalAttributes?.flexibility !== "none"
        && /flex|changes?|rebook/.test(lower(`${option.label} ${option.canonicalAttributes?.evidenceText || ""}`)))
    ));
    reason = "Option must satisfy the requested change flexibility.";
  } else if (/cheapest|lowest (?:price|cost)|included fare|base fare/.test(combined)) {
    const priced = options.filter((option) => option.price !== null);
    const minimum = priced.length ? Math.min(...priced.map((option) => option.price)) : null;
    eligible = options.filter((option) => option.included || (minimum !== null && option.price === minimum));
    reason = "Policy requests the lowest-priced eligible option.";
  } else if (subject.includes("insurance") && /no insurance|no protection|without protection|skip insurance/.test(combined)) {
    eligible = options.filter((option) => option.included || /no |without|decline|skip/.test(lower(option.label)));
    reason = "Insurance policy explicitly requests no protection.";
  } else if (subject.includes("seat") && policy.preferences?.seatPolicy === SEAT_POLICIES.RANDOM_ASSIGNMENT) {
    eligible = options.filter((option) => /random|automatic|without|skip|no seat/.test(lower(option.label)) || option.included);
    reason = "Seat policy requests automatic/random assignment.";
  } else if (/marketing|newsletter|contact/.test(subject) && /do not subscribe|no newsletter|no marketing|decline marketing/.test(combined)) {
    eligible = options.filter((option) => /do not|no |decline|opt.?out|unsubscribe/.test(lower(option.label)));
    if (!eligible.length) {
      return resolutionResult({ match: "unavailable", source: bookingSpecific ? "booking_specific" : "saved_profile", options: [], reason: "The requested marketing opt-out control is unavailable.", evidence: [bookingSpecific || savedText] });
    }
    return resolutionResult({
      match: "exact",
      source: bookingSpecific ? "booking_specific" : "saved_profile",
      options: eligible,
      preferred: eligible[0],
      reason: "Profile explicitly declines marketing communication.",
      evidence: [bookingSpecific || savedText]
    });
  }

  const limit = parsePriceLimit(`${bookingSpecific} ${savedText}`);
  if (limit) {
    eligible = eligible.filter((option) => (
      option.price === null
      || (option.price <= limit.amount && (!limit.currency || !option.currency || limit.currency === option.currency))
    ));
  }
  if (!eligible.length && reason) {
    return resolutionResult({ match: "unavailable", source: bookingSpecific ? "booking_specific" : "saved_profile", options: [], reason, evidence: [bookingSpecific || savedText] });
  }
  if (eligible.length && reason) {
    const preferred = eligible.length === 1 ? eligible[0] : null;
    const sourceText = bookingSpecific || savedText;
    const paidEligible = eligible.filter((option) => option.paid);
    const authorizations = paidEligible.map((option) => authorizationFor({
      policy,
      subject,
      decision,
      option,
      sourceText,
      source: bookingSpecific ? "booking_specific" : "saved_profile"
    }));
    if (paidEligible.length && authorizations.some((authorization) => !authorization)) {
      return resolutionResult({ match: "ambiguous", source: bookingSpecific ? "booking_specific" : "saved_profile", options: eligible, reason: `${reason} The matching paid option lacks bounded financial authorization.`, evidence: [sourceText] });
    }
    const authorization = preferred?.paid
      ? authorizationFor({ policy, subject, decision, option: preferred, sourceText, source: bookingSpecific ? "booking_specific" : "saved_profile" })
      : null;
    return resolutionResult({
      match: "constraint",
      source: policy.constraints?.noPaidExtras
        ? "no_paid_extras"
        : (bookingSpecific ? "booking_specific" : "saved_profile"),
      options: eligible,
      preferred,
      authorization,
      reason,
      evidence: [sourceText]
    });
  }

  if ((decision.kind === "optional_toggle" || decision.controlType === "optional_toggle") && decision.material === true) {
    return resolutionResult({ match: "ambiguous", source: "", options, reason: "This material optional product has no applicable profile rule." });
  }
  if (decision.required === true || decision.material === true) {
    return resolutionResult({ match: "ambiguous", source: "", options, reason: "No applicable profile rule authorizes a consequential choice." });
  }
  return resolutionResult({ match: "none", source: "", options, reason: "No profile decision is required for this untouched optional control." });
}

function normalizeSeatPolicy(value = "", bookingRules = "") {
  const preference = lower(value).replace(/[_-]+/g, " ");
  if (/\baisle\b/.test(preference)) return SEAT_POLICIES.AISLE;
  if (/\bwindow\b/.test(preference)) return SEAT_POLICIES.WINDOW;
  if (/together|adjacent|sit together/.test(preference)) return SEAT_POLICIES.TOGETHER;
  if (/specific seat|select (?:a )?seat|seat number/.test(preference)) return SEAT_POLICIES.SPECIFIC_SEAT;
  if (/random|automatic|auto assign|no preference|skip|without seat|no seat selection|do not select/.test(preference)) {
    return SEAT_POLICIES.RANDOM_ASSIGNMENT;
  }

  const rules = lower(bookingRules);
  if (/random (?:seat|seating|assignment)|automatic seat|no paid seats?|no seat selection|skip seats?|without (?:a )?seat|do not (?:pick|select) (?:a )?seat/.test(rules)) {
    return SEAT_POLICIES.RANDOM_ASSIGNMENT;
  }
  return SEAT_POLICIES.UNSPECIFIED;
}

function seatPolicyFrom({ userPolicy = {}, traveler = {} } = {}) {
  const explicit = userPolicy.seatPolicy
    || traveler.seatPolicy
    || traveler.seat_policy;
  const legacy = userPolicy.preferredSeat
    || userPolicy.seats
    || traveler.seat_preference
    || traveler.preferred_seat;
  const bookingRules = userPolicy.bookingRules || traveler.booking_rules || "";
  return normalizeSeatPolicy(explicit || legacy, bookingRules);
}

function canonicalizeUserPolicy(userPolicy = {}, traveler = {}) {
  const {
    preferredSeat: _preferredSeat,
    seats: _seats,
    seat_preference: _seatPreference,
    ...rest
  } = userPolicy || {};
  return Object.freeze({
    ...rest,
    seatPolicy: seatPolicyFrom({ userPolicy, traveler }),
    profilePolicy: normalizeProfilePolicy({ userPolicy, traveler })
  });
}

module.exports = {
  SEAT_POLICIES,
  canonicalizeUserPolicy,
  normalizeProfilePolicy,
  normalizeSeatPolicy,
  parsePriceLimit,
  resolveProfileDecision,
  seatPolicyFrom
};
