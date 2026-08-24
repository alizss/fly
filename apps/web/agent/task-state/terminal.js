const { controlBelongsToCurrentSurface } = require("../surface-contract");
const { controlHasExecutableCapability } = require("./control-evidence");

function clean(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function lower(value = "") {
  return clean(value).toLowerCase();
}

function cardCredentialEntryBoundaryEvidence(observation = {}, stageDecisionEvidence = {}, transactionReview = null, traveler = {}) {
  const page = observation.page || {};
  const controls = (page.controls || []).filter((control) => (
    controlBelongsToCurrentSurface(control, page)
    && controlHasExecutableCapability(control)
  ));
  const semanticText = (control = {}) => lower([
    control.fieldType,
    control.field,
    control.semanticType,
    control.semantic,
    control.name,
    control.autocomplete,
    control.testId,
    control.label,
    control.stableKey
  ].filter(Boolean).join(" "));
  const paymentMethodControlIds = controls
    .filter((control) => /payment.?method|apple.?pay|credit.?card|debit.?card/.test(semanticText(control)))
    .map((control) => control.controlId);
  const paymentCredentialControls = controls
    .map((control) => {
      const semantics = semanticText(control);
      const kind = /card.?number|cc-number/.test(semantics)
        ? "card_number"
        : /card.?expiry|expiration|valid.?through|cc-exp/.test(semantics)
          ? "card_expiry"
          : /security.?code|card.?cvc|\bcvc\b|\bcvv\b|cc-csc/.test(semantics)
            ? "card_security_code"
            : "";
      return { control, kind };
    })
    .filter((entry) => entry.kind);
  const paymentCredentialControlIds = paymentCredentialControls.map(({ control }) => control.controlId);
  const credentialKinds = new Set(paymentCredentialControls.map(({ kind }) => kind));
  const completeCardCredentialControls = ["card_number", "card_expiry", "card_security_code"]
    .every((kind) => credentialKinds.has(kind));
  const payControlIds = controls
    .filter((control) => /(?:^|[^a-z0-9])(?:pay(?:\s+(?:now|securely|with)\b|\s+\d)|confirm\s+and\s+pay\b|submit\s+payment\b|complete\s+purchase\b)/.test(semanticText(control)))
    .map((control) => control.controlId);
  const pendingContactControlIds = controls
    .filter((control) => {
      const semantics = semanticText(control);
      const email = /(?:^|[^a-z])email(?:[^a-z]|$)/.test(semantics) && !/confirm.?email/.test(semantics);
      const phone = /(?:^|[^a-z])(?:phone|mobile|tel-national)(?:[^a-z]|$)/.test(semantics)
        && !/country|prefix|calling.?code/.test(semantics);
      if (!email && !phone) return false;
      const expectedValue = email
        ? clean(traveler.email || traveler.contact_email || traveler.billing_email)
        : clean(traveler.phone || traveler.mobile || traveler.phone_number);
      const state = control.state || {};
      const missingValue = !state.valuePresent && !clean(state.normalizedValue || state.valueText || state.value);
      return state.invalid === true || ((expectedValue || state.required === true || control.required === true) && missingValue);
    })
    .map((control) => control.controlId);
  const transactionFacts = page.transactionFacts
    || transactionReview?.current
    || transactionReview?.baseline
    || {};
  const hasReviewEnvelope = transactionReview?.ready === true || Boolean(
    transactionFacts.currency
    && transactionFacts.totalPrice?.amount != null
    && (transactionFacts.travelers || []).length
  );
  const reviewContext = (transactionFacts.provenance || []).some((entry) => entry?.source === "payment_summary")
    || stageDecisionEvidence.payment?.progress === true
    || stageDecisionEvidence.payment?.heading === true;
  const hostedCardEntryPresent = stageDecisionEvidence.terminalEvidence?.hostedCardEntryPresent === true;
  const compiledCredentialKinds = new Set(
    stageDecisionEvidence.terminalEvidence?.paymentCredentialKinds || []
  );
  const compiledCompleteCardCredentialSet = ["card_number", "card_expiry", "card_security_code"]
    .every((kind) => compiledCredentialKinds.has(kind));
  const compiledCardEntryPresent = stageDecisionEvidence.terminalEvidence?.cardCredentialEntryObserved === true
    && compiledCompleteCardCredentialSet;
  const observed = completeCardCredentialControls || compiledCardEntryPresent || hostedCardEntryPresent;
  return Object.freeze({
    observed,
    terminalEvidence: stageDecisionEvidence.terminalEvidence || null,
    reviewContext,
    hasReviewEnvelope,
    completeCardCredentialControls,
    compiledCardEntryPresent,
    hostedCardEntryPresent,
    payControlIds: Object.freeze(payControlIds),
    paymentMethodControlIds: Object.freeze(paymentMethodControlIds),
    paymentCredentialControlIds: Object.freeze(paymentCredentialControlIds),
    pendingContactControlIds: Object.freeze(pendingContactControlIds)
  });
}

module.exports = { cardCredentialEntryBoundaryEvidence };
