// The single place checkout safety boundaries are enforced. Preference
// resolution happens earlier in the profile-to-decision resolver; this layer
// validates its exact authorization immediately before dispatch.
// Browser and future iOS executors enforce live actionability and verify the
// postcondition; they do not reinterpret this semantic policy.

/**
 * @typedef {"allow"|"deny"|"ask_user"} PolicyVerdict
 * @typedef {Object} PolicyDecision
 * @property {boolean} allow
 * @property {PolicyVerdict} decision
 * @property {string} reason
 */

function isDeclineOrSkipAction(action) {
  const target = action.targetSnapshot || {};
  return (action.affordance?.physicalEffect || action.affordance?.effect) === "select_free_option"
    || action.intent === "decline_optional_extra"
    || target.semantic === "decline_paid_extra"
    || target.semantic === "decline_baggage"
    || target.semantic === "safe_decline"
    || target.risk === "safe_decline";
}

function isNonMutatingAction(action) {
  return ["ask_user", "stop", "wait", "scroll"].includes(action.type);
}

function isOpenChoiceControlAction(action) {
  const target = action.targetSnapshot || {};
  if (action.intent === "open_choice_control") return true;
  if (action.type !== "click") return false;
  if (target.semantic === "add_paid_extra" || target.risk === "money") return false;
  return target.semantic === "open_choice_control"
    && ["button", "select", "combobox", "field", "choice"].includes(target.kind || "");
}

function looksLikeContinueAction(action) {
  if (action.type !== "click" && action.type !== "click_xy") return false;
  if (isDeclineOrSkipAction(action)) return false;
  const target = action.targetSnapshot || {};
  return ["advance_surface", "advance_checkout_stage"].includes(action.affordance?.physicalEffect || action.affordance?.effect)
    || action.intent === "navigate_stage"
    || target.semantic === "continue"
    || target.risk === "safe_continue";
}

function looksLikeCardField(action) {
  const target = action.targetSnapshot || {};
  return action.type === "type" && (
    action.risk === "payment"
    || target.risk === "payment"
    || ["card_number", "card_security_code", "card_expiry", "cardholder_name"].includes(target.semantic)
  );
}

function looksLikeFinalPayment(action) {
  if (action.type === "final_review") return true;
  const target = action.targetSnapshot || {};
  return action.risk === "payment"
    || target.risk === "payment"
    || ["submit_payment", "finalize_booking", "confirm_purchase"].includes(action.intent)
    || ["submit_payment", "finalize_booking", "confirm_purchase"].includes(target.semantic);
}

function looksLikeLegalAcceptance(action) {
  const target = action.targetSnapshot || {};
  // High-risk policy requires a typed consequence. A label-derived risk or a
  // noun such as "legal person" is not evidence that the action accepts
  // terms, makes a declaration, or changes legal state. Section membership
  // is context, not consequence: a Continue/Confirm button beside a terms
  // checkbox does not itself accept those terms.
  return action.intent === "accept_legal_terms"
    || ["accept_legal_terms", "legal_acceptance", "unknown_attestation"].includes(target.semantic)
    || ["accept_legal_terms", "legal_acceptance"].includes(action.semanticEffect)
    || ["accept_legal_terms", "legal_acceptance"].includes(action.affordance?.physicalEffect);
}

const LEGAL_ACCEPTANCE_SCOPE = Object.freeze({
  STANDARD_TERMS: "standard_terms",
  FACTUAL_ACCURACY_ATTESTATION: "factual_accuracy_attestation",
  EXCEPTIONAL_PERSONAL_DECLARATION: "exceptional_personal_declaration",
  OPTIONAL_CONSENT: "optional_consent",
  UNKNOWN_LEGAL: "unknown_legal"
});

function legalAcceptanceScope(action = {}) {
  const target = action.targetSnapshot || {};
  const declared = String(
    action.legalScope
    || target.legalScope
    || target.legalAcceptanceScope
    || action.boundedLegalInterpretation?.resolvedScope
    || target.boundedLegalInterpretation?.resolvedScope
    || ""
  );
  if (Object.values(LEGAL_ACCEPTANCE_SCOPE).includes(declared)) return declared;
  const text = String([
    action.targetLabel,
    action.label,
    action.intent,
    target.label,
    target.accessibleName,
    target.description,
    target.semantic,
    target.name
  ].filter(Boolean).join(" ")).toLowerCase().replace(/\s+/g, " ");
  if (!text) return LEGAL_ACCEPTANCE_SCOPE.UNKNOWN_LEGAL;
  if (/\b(?:newsletter|marketing|promotional|offers?|third[- ]party data|data sharing|personalised ads?|commercial communications?|insurance|protection plan)\b/.test(text)) {
    return LEGAL_ACCEPTANCE_SCOPE.OPTIONAL_CONSENT;
  }
  if (/\b(?:visa|citizenship|citizen|residen(?:cy|t)|medical|health|pregnan|disab|special assistance|guardian|unaccompanied minor|tax declaration|power of attorney|liability waiver|financing|credit agreement|loan)\b/.test(text)) {
    return LEGAL_ACCEPTANCE_SCOPE.EXCEPTIONAL_PERSONAL_DECLARATION;
  }
  if (/\b(?:names?|passenger details?|traveller details?|information|details?)\b.{0,80}\b(?:accurate|correct|true|complete)\b|\b(?:confirm|declare|certify)\b.{0,80}\b(?:accuracy|accurate|correct|true|complete)\b/.test(text)) {
    return LEGAL_ACCEPTANCE_SCOPE.FACTUAL_ACCURACY_ATTESTATION;
  }
  if (/\b(?:terms|conditions|conditions of carriage|fare rules|booking terms|purchase conditions|cancellation|refund conditions|privacy|dangerous goods)\b/.test(text)) {
    return LEGAL_ACCEPTANCE_SCOPE.STANDARD_TERMS;
  }
  return LEGAL_ACCEPTANCE_SCOPE.UNKNOWN_LEGAL;
}

function exceptionalDeclarationProfileMatch(action = {}, profile = {}) {
  const target = action.targetSnapshot || {};
  const declaration = action.personalDeclaration
    || target.personalDeclaration
    || target.declarationFact
    || null;
  if (!declaration?.field) return false;
  const actual = profile[declaration.field];
  if (actual == null || actual === "") return false;
  if (declaration.expectedValue == null) return actual === true;
  return String(actual).trim().toLowerCase() === String(declaration.expectedValue).trim().toLowerCase();
}

function optionalConsentAuthorized(action = {}, merged = {}, profile = {}) {
  const target = action.targetSnapshot || {};
  const consentId = String(action.decisionGroupId || target.decisionGroupId || target.controlId || "");
  if ((merged.optionalConsentApprovals || []).some((approval) => (
    approval?.authorizationId && (!approval.consentId || approval.consentId === consentId)
  ))) return true;
  const consent = String(target.consentCategory || action.consentCategory || "").toLowerCase();
  if (/marketing|newsletter|promotion/.test(consent)) {
    return profile.marketing_opt_in === true
      || profile.marketingConsent === true
      || profile.marketing_consent === "accept";
  }
  return false;
}

function normalizedFact(value) {
  return String(value == null ? "" : value).trim().toLowerCase().replace(/\s+/g, " ");
}

function attestedFactScope(action = {}) {
  const target = action.targetSnapshot || {};
  const statement = normalizedFact([
    action.targetLabel,
    action.label,
    target.label,
    target.accessibleName,
    target.description,
    target.legalText,
    action.legalText
  ].filter(Boolean).join(" "));
  const scope = new Set();
  if (/passenger|travell?er|guest|name|personal (?:data|details)|contact details/.test(statement)) scope.add("travelers");
  if (/flight|itinerary|journey|route|departure|arrival|date|time|destination|origin/.test(statement)) scope.add("itinerary");
  if (/price|total|amount|fare|currency|cost|charge/.test(statement)) scope.add("total_price");
  return { statement, scope };
}

function factualAccuracyEvidence(state = {}, action = {}) {
  const invariants = state?.transactionInvariants || {};
  const baseline = invariants.baseline || null;
  const current = invariants.current || null;
  const attestation = attestedFactScope(action);
  const missingFacts = [];
  const contradictions = [];
  if (!attestation.scope.size) {
    return { verified: false, missingFacts: ["attestation_scope"], contradictions, scope: [] };
  }
  if (!current) missingFacts.push("current_booking_facts");
  if (!current) return { verified: false, missingFacts, contradictions, scope: [...attestation.scope] };

  if (attestation.scope.has("itinerary")) {
    const baselineSegments = Array.isArray(baseline?.itinerary?.segments) ? baseline.itinerary.segments : [];
    const currentSegments = Array.isArray(current.itinerary?.segments) ? current.itinerary.segments : [];
    if (baseline?.itinerary?.completeness !== "complete" || !baselineSegments.length) {
      missingFacts.push("authoritative_itinerary");
    } else if (currentSegments.length !== baselineSegments.length) {
      contradictions.push("itinerary_segment_count_changed");
    } else {
      const itineraryFields = ["origin", "destination", "departureDate", "departureTime", "arrivalTime", "flightNumber"];
      baselineSegments.forEach((segment, index) => {
        const observed = currentSegments[index] || {};
        for (const field of itineraryFields) {
          const expected = normalizedFact(segment?.[field]);
          const actual = normalizedFact(observed?.[field]);
          if (expected && actual && expected !== actual) contradictions.push(`itinerary_${index}_${field}_changed`);
          if (expected && !actual) missingFacts.push(`itinerary_${index}_${field}`);
        }
      });
    }
  }

  if (attestation.scope.has("travelers")) {
    const travelers = Array.isArray(current.travelers) ? current.travelers : [];
    const travelerEvidence = current.factEvidence?.travelers || null;
    if (!travelers.length || travelers.some((traveler) => !normalizedFact(traveler?.name))) {
      missingFacts.push("traveler_names");
    }
    if (travelerEvidence?.authoritative !== true) missingFacts.push("authoritative_traveler_profile");
  }

  if (attestation.scope.has("total_price")) {
    const baselineTotal = Number(baseline?.totalPrice?.amount);
    const currentTotal = Number(current.totalPrice?.amount);
    const baselineCurrency = normalizedFact(baseline?.totalPrice?.currency || baseline?.currency).toUpperCase();
    const currentCurrency = normalizedFact(current.totalPrice?.currency || current.currency).toUpperCase();
    if (!Number.isFinite(baselineTotal) || !baselineCurrency) missingFacts.push("approved_total_price");
    if (!Number.isFinite(currentTotal) || !currentCurrency) missingFacts.push("current_total_price");
    if (Number.isFinite(baselineTotal) && Number.isFinite(currentTotal) && Math.abs(baselineTotal - currentTotal) > 0.001) {
      contradictions.push("total_price_changed");
    }
    if (baselineCurrency && currentCurrency && baselineCurrency !== currentCurrency) contradictions.push("currency_changed");
  }

  return {
    verified: missingFacts.length === 0 && contradictions.length === 0,
    missingFacts: [...new Set(missingFacts)],
    contradictions: [...new Set(contradictions)],
    scope: [...attestation.scope]
  };
}

function looksLikePaidExtraSelection(action) {
  if (isNonMutatingAction(action) || isDeclineOrSkipAction(action) || isOpenChoiceControlAction(action)) return false;
  const target = action.targetSnapshot || {};
  const typedEffect = String(
    action.mechanicalEffect
    || action.affordance?.mechanicalEffect
    || action.affordance?.physicalEffect
    || action.affordance?.effect
    || ""
  ).toLowerCase();
  return typedEffect === "select_paid_option"
    || Number(action.affordance?.structuredPrice?.amount) > 0
    || action.affordance?.risk === "money"
    || action.risk === "money"
    || target.risk === "money"
    || target.risk === "paid"
    || ["add_paid_extra", "select_paid_seat", "select_paid_baggage"].includes(action.intent)
    || ["add_paid_extra", "select_paid_seat", "select_paid_baggage"].includes(target.semantic);
}

function profileWantsNoExtras(profile = {}) {
  const rules = String(profile.booking_rules || "").toLowerCase();
  return /no paid|no extras|no add-?ons|no seat|no insurance|no bundle|personal item only|avoid paid|decline (?:all )?paid extras/.test(rules);
}

function boundedPaidAuthorization(action = {}, merged = {}) {
  const decisionGroupId = String(
    action.decisionGroupId
    || action.affordance?.task?.decisionGroupId
    || action.targetSnapshot?.decisionGroupId
    || ""
  );
  const price = action.affordance?.structuredPrice || null;
  const amount = Number(price?.amount);
  const currency = String(price?.currency || "").toUpperCase();
  const embedded = action.affordance?.authorization || null;
  const stored = (merged.paidExtraAuthorizations || []).find((authorization) => (
    authorization?.authorizationId
    && (!authorization.decisionGroupId || authorization.decisionGroupId === decisionGroupId)
  )) || null;
  const authorization = embedded?.authorizationId ? embedded : stored;
  if (!authorization?.authorizationId) return null;
  if (authorization.decisionGroupId && decisionGroupId && authorization.decisionGroupId !== decisionGroupId) return null;
  const maximum = Number(authorization.maximumAmount ?? authorization.maxAmount);
  if (Number.isFinite(maximum) && Number.isFinite(amount) && amount > maximum) return null;
  const authorizedCurrency = String(authorization.currency || "").toUpperCase();
  if (authorizedCurrency && currency && authorizedCurrency !== currency) return null;
  return authorization;
}

/**
 * @param {import("../agent-actions").AgentAction} action
 * @param {import("../agent-state").CheckoutSessionState} state
 * @param {Object} profile traveler profile (booking_rules etc.)
 * @param {import("../agent-state").ApprovalState} approvals
 * @returns {PolicyDecision}
 */
function evaluateActionPolicy(action, state, profile = {}, approvals = {}) {
  const merged = { ...(state?.approvals || {}), ...approvals };

  // Non-mutating actions are control-flow decisions, not checkout changes.
  // They should still be logged, but policy should not misclassify "ask_user"
  // with money risk as selecting the paid product.
  if (isNonMutatingAction(action)) {
    return { allow: true, decision: "allow", reason: "Non-mutating agent control action." };
  }

  if (["click", "type", "select"].includes(action.type) && !action.targetSnapshot?.controlId) {
    return { allow: false, decision: "deny", reason: "Mutating DOM actions require a canonical control from the current observation." };
  }

  if (isDeclineOrSkipAction(action)) {
    return { allow: true, decision: "allow", reason: "Typed target contract identifies this as declining/skipping an optional extra." };
  }

  if (isOpenChoiceControlAction(action)) {
    return { allow: true, decision: "allow", reason: "Opening a choice control is allowed; selecting a paid option remains blocked by typed policy." };
  }

  // Hard denies — never askable, never overridable by preference.
  if (looksLikeCardField(action)) {
    return { allow: false, decision: "deny", reason: "Action targets a card number/CVC-like field. Payment fields are never auto-filled." };
  }
  if (action.type === "click_xy" && action.risk !== "safe") {
    return { allow: false, decision: "ask_user", reason: "Coordinate click has no visible label, so it needs human confirmation before acting." };
  }

  // Hard asks — always require explicit human confirmation, no matter what's cached.
  if (looksLikeFinalPayment(action) && !merged.paymentAuthorization?.authorizationId) {
    return { allow: false, decision: "ask_user", reason: "This looks like a final purchase/payment action and needs your explicit confirmation." };
  }
  if (looksLikeLegalAcceptance(action)) {
    const scope = legalAcceptanceScope(action);
    const attestedFacts = factualAccuracyEvidence(state, action);
    const factualAccuracyVerified = merged.factualAccuracyVerified === true
      || attestedFacts.verified === true;
    if (merged.legalApproved) {
      return { allow: true, decision: "allow", reason: "The exact legal action has explicit approval." };
    }
    if (scope === LEGAL_ACCEPTANCE_SCOPE.STANDARD_TERMS && merged.standardBookingTermsApproved === true) {
      return { allow: true, decision: "allow", reason: "Ordinary booking terms are covered by the transaction-bound Book/Pay mandate." };
    }
    if (scope === LEGAL_ACCEPTANCE_SCOPE.FACTUAL_ACCURACY_ATTESTATION
      && merged.standardBookingTermsApproved === true
      && factualAccuracyVerified) {
      return { allow: true, decision: "allow", reason: `The exact attested fact scope (${attestedFacts.scope.join(", ")}) is reconciled.` };
    }
    if (scope === LEGAL_ACCEPTANCE_SCOPE.EXCEPTIONAL_PERSONAL_DECLARATION
      && exceptionalDeclarationProfileMatch(action, profile)) {
      return { allow: true, decision: "allow", reason: "The exact personal declaration is proven by a matching saved profile fact." };
    }
    if (scope === LEGAL_ACCEPTANCE_SCOPE.OPTIONAL_CONSENT) {
      if (optionalConsentAuthorized(action, merged, profile)) {
        return { allow: true, decision: "allow", reason: "The exact optional consent has an explicit profile or transaction-bound authorization." };
      }
      return { allow: false, decision: "deny", reason: "Optional consent defaults to unchecked unless the profile explicitly opts in." };
    }
    return {
      allow: false,
      decision: "ask_user",
      reason: scope === LEGAL_ACCEPTANCE_SCOPE.OPTIONAL_CONSENT
        ? "This bundled consent is optional and is not implied by the booking mandate."
        : scope === LEGAL_ACCEPTANCE_SCOPE.EXCEPTIONAL_PERSONAL_DECLARATION
          ? "This is a personal declaration outside the standard booking mandate."
          : scope === LEGAL_ACCEPTANCE_SCOPE.FACTUAL_ACCURACY_ATTESTATION
            ? `The exact attested facts are not reconciled: ${[...attestedFacts.missingFacts, ...attestedFacts.contradictions].join(", ") || "unknown scope"}.`
            : "This legal control is not proven to be standard terms covered by the transaction-bound mandate."
    };
  }
  // Paid extras: allow declining freely; allow *selecting* only with explicit approval.
  if (looksLikePaidExtraSelection(action)) {
    const authorization = boundedPaidAuthorization(action, merged);
    if (authorization) {
      return {
        allow: true,
        decision: "allow",
        reason: `Paid option is covered by bounded authorization ${authorization.authorizationId}.`,
        authorization
      };
    }
    if (["constraint", "ambiguous", "unavailable"].includes(action.affordance?.profileResolution?.match)) {
      return { allow: false, decision: "deny", reason: "The paid selection is not the exact authorized result of the profile resolver." };
    }
    if (merged.skipPaidExtrasApproved || profileWantsNoExtras(profile)) {
      // "Skip paid extras" directly contradicts a selection-shaped action — this
      // isn't ambiguous, it's a straight no, not something worth another round-trip.
      return { allow: false, decision: "deny", reason: "This looks like selecting a paid extra, which contradicts the saved preference to decline paid extras." };
    }
    return { allow: false, decision: "ask_user", reason: "This looks like selecting a paid extra with no saved preference either way. Confirm before adding it." };
  }

  // TaskState describes remaining work but does not veto a grounded safe
  // foreground click. If Continue exposes validation or another popup, the
  // fresh observation becomes the next source of action guidance.

  return { allow: true, decision: "allow", reason: "No policy restriction matched; routine action." };
}

module.exports = {
  LEGAL_ACCEPTANCE_SCOPE,
  evaluateActionPolicy,
  looksLikeCardField,
  looksLikeFinalPayment,
  looksLikeLegalAcceptance,
  legalAcceptanceScope,
  exceptionalDeclarationProfileMatch,
  optionalConsentAuthorized,
  factualAccuracyEvidence,
  looksLikePaidExtraSelection,
  profileWantsNoExtras,
  boundedPaidAuthorization,
  isDeclineOrSkipAction,
  isNonMutatingAction,
  isOpenChoiceControlAction
};
