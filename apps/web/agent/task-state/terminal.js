const { controlBelongsToCurrentSurface } = require("../surface-contract");
const { controlHasExecutableCapability } = require("./control-evidence");

function clean(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function lower(value = "") {
  return clean(value).toLowerCase();
}

function paymentReviewBoundaryEvidence(observation = {}, stageDecisionEvidence = {}, transactionReview = null, traveler = {}) {
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
  const paymentCredentialControlIds = controls
    .filter((control) => /card.?number|card.?expiry|security.?code|card.?cvc|\bcvc\b|\bcvv\b|cc-number|cc-exp|cc-csc/.test(semanticText(control)))
    .map((control) => control.controlId);
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
  const step = lower(page.step || page.pageStep);
  const transactionFacts = page.transactionFacts
    || transactionReview?.current
    || transactionReview?.baseline
    || {};
  const hasReviewEnvelope = transactionReview?.ready === true || Boolean(
    transactionFacts.currency
    && transactionFacts.totalPrice?.amount != null
    && (transactionFacts.travelers || []).length
  );
  const reviewContext = /payment|confirmation|review/.test(step)
    || (transactionFacts.provenance || []).some((entry) => entry?.source === "payment_summary")
    || stageDecisionEvidence.payment?.progress === true
    || stageDecisionEvidence.payment?.heading === true;
  const strongStageEvidence = stageDecisionEvidence.paymentSignals >= 3
    || (
      stageDecisionEvidence.paymentSignals >= 2
      && (paymentMethodControlIds.length || paymentCredentialControlIds.length)
    );
  const verifiedPaymentStage = transactionReview?.ready === true
    && stageDecisionEvidence.paymentSignals >= 2
    && Boolean(
      stageDecisionEvidence.payment?.route
      || stageDecisionEvidence.payment?.progress
      || stageDecisionEvidence.payment?.heading
    );
  // A lone hidden CVV/card field is not a payment-review boundary. Require
  // either mutually reinforcing payment-stage evidence or an owned final
  // envelope together with the actual commit and payment-method controls.
  const observed = Boolean(
    stageDecisionEvidence.terminalEvidence?.boundaryObserved === true
    || verifiedPaymentStage
    || strongStageEvidence
    || (
      hasReviewEnvelope
      && payControlIds.length
      && (paymentMethodControlIds.length || paymentCredentialControlIds.length)
    )
  );
  return Object.freeze({
    observed,
    terminalEvidence: stageDecisionEvidence.terminalEvidence || null,
    reviewContext,
    hasReviewEnvelope,
    payControlIds: Object.freeze(payControlIds),
    paymentMethodControlIds: Object.freeze(paymentMethodControlIds),
    paymentCredentialControlIds: Object.freeze(paymentCredentialControlIds),
    pendingContactControlIds: Object.freeze(pendingContactControlIds)
  });
}

module.exports = { paymentReviewBoundaryEvidence };
