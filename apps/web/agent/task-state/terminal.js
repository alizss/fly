const { controlBelongsToCurrentSurface } = require("../surface-contract");
const { controlHasExecutableCapability } = require("./control-evidence");
const agentContract = require("../../../extension/src/shared/agent-contract");

function clean(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function lower(value = "") {
  return clean(value).toLowerCase();
}

function terminalForStage(stage = "unknown") {
  if (stage === "confirmation") return "confirmation_reached";
  return "active";
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
  const terminalEvidence = stageDecisionEvidence.terminalEvidence || page.terminalEvidence || {};
  const declaredBoundary = Object.values(agentContract.CHECKOUT_BOUNDARY).includes(terminalEvidence.boundary)
    ? terminalEvidence.boundary
    : terminalEvidence.boundaryObserved === true
      ? agentContract.CHECKOUT_BOUNDARY.PAYMENT_ENTRY
      : agentContract.CHECKOUT_BOUNDARY.UNKNOWN;
  const fallbackPaymentEntry = Boolean(
    verifiedPaymentStage
    || strongStageEvidence
    || (
      hasReviewEnvelope
      && payControlIds.length
      && (paymentMethodControlIds.length || paymentCredentialControlIds.length)
    )
  );
  const boundary = declaredBoundary !== agentContract.CHECKOUT_BOUNDARY.UNKNOWN
    ? declaredBoundary
    : fallbackPaymentEntry
      ? agentContract.CHECKOUT_BOUNDARY.PAYMENT_ENTRY
      : agentContract.CHECKOUT_BOUNDARY.UNKNOWN;
  const paymentEntry = [
    agentContract.CHECKOUT_BOUNDARY.PAYMENT_ENTRY,
    agentContract.CHECKOUT_BOUNDARY.PURCHASE_COMMIT
  ].includes(boundary);
  const legalGate = boundary === agentContract.CHECKOUT_BOUNDARY.LEGAL_GATE;
  const prePaymentReview = boundary === agentContract.CHECKOUT_BOUNDARY.PRE_PAYMENT_REVIEW;
  const observed = boundary !== agentContract.CHECKOUT_BOUNDARY.UNKNOWN;
  const canonicalIdsForObservedElements = (ids = []) => {
    const wanted = new Set(ids.map(clean).filter(Boolean));
    if (!wanted.size) return [];
    return controls.filter((control) => (
      wanted.has(clean(control.controlId))
      || wanted.has(clean(control.stateElementId))
      || wanted.has(clean(control.preferredActivationElementId))
      || (control.actuators || []).some((actuator) => wanted.has(clean(actuator.nodeId)))
    )).map((control) => control.controlId);
  };
  const legalAcceptanceControlIds = canonicalIdsForObservedElements(terminalEvidence.legalAcceptanceControlIds || []);
  const advanceToPaymentControlIds = canonicalIdsForObservedElements(terminalEvidence.advanceToPaymentControlIds || []);
  return Object.freeze({
    observed,
    boundary,
    paymentEntry,
    purchaseCommit: boundary === agentContract.CHECKOUT_BOUNDARY.PURCHASE_COMMIT,
    legalGate,
    prePaymentReview,
    terminalEvidence,
    reviewContext,
    hasReviewEnvelope,
    payControlIds: Object.freeze(payControlIds),
    paymentMethodControlIds: Object.freeze(paymentMethodControlIds),
    paymentCredentialControlIds: Object.freeze(paymentCredentialControlIds),
    legalAcceptanceControlIds: Object.freeze(legalAcceptanceControlIds),
    legalAcceptanceText: clean(terminalEvidence.legalAcceptanceText || ""),
    advanceToPaymentControlIds: Object.freeze(advanceToPaymentControlIds),
    pendingContactControlIds: Object.freeze(pendingContactControlIds)
  });
}

module.exports = { paymentReviewBoundaryEvidence, terminalForStage };
