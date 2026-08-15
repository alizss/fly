const crypto = require("node:crypto");

const CONTRACT_VERSION = "checkout-mandate/v1";
const AUTHORIZATION_VERSION = "mandate-attestation-authorization/v1";
const RECEIPT_VERSION = "attestation-receipt/v1";

const STANDARD_ATTESTATIONS = Object.freeze([
  "bookingAccuracy",
  "conditionsOfCarriage",
  "selectedFareConditions",
  "purchaseConditions",
  "dangerousGoods"
]);

const DEFAULT_FORBIDDEN = Object.freeze([
  "marketing_consent",
  "optional_data_sharing",
  "insurance",
  "subscription",
  "financing",
  "payment_credentials",
  "transaction_commit",
  "purchase"
]);

function text(value = "", limit = 1_600) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function digest(value = "") {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function travelerIds(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => text(value?.travelerId || value?.id || value, 120))
    .filter(Boolean))];
}

function createCheckoutMandate(selectedBooking = null) {
  if (!selectedBooking?.selectionId || !selectedBooking?.approvedTotal) return null;
  const ids = travelerIds(selectedBooking.travelerIds);
  if (!ids.length) return null;
  const itineraryDigest = digest(JSON.stringify(selectedBooking.itinerary || {}));
  const mandateId = `mandate_${digest([
    selectedBooking.selectionId,
    itineraryDigest,
    ids.join(","),
    selectedBooking.approvedTotal.amount,
    selectedBooking.approvedTotal.currency
  ].join("|")).slice(0, 32)}`;
  return Object.freeze({
    contractVersion: CONTRACT_VERSION,
    checkoutMandateId: mandateId,
    objective: "reach_payment_entry",
    selectedBookingId: text(selectedBooking.selectionId, 160),
    itineraryDigest,
    travelerIds: Object.freeze(ids),
    approvedTotal: Number(selectedBooking.approvedTotal.amount),
    currency: text(selectedBooking.approvedTotal.currency, 20).toUpperCase(),
    standardAttestations: Object.freeze(Object.fromEntries(STANDARD_ATTESTATIONS.map((key) => [key, true]))),
    forbidden: DEFAULT_FORBIDDEN,
    createdAt: new Date().toISOString()
  });
}

function normalizeCheckoutMandate(raw = null) {
  if (!raw || raw.contractVersion !== CONTRACT_VERSION) return null;
  const ids = travelerIds(raw.travelerIds);
  const amount = Number(raw.approvedTotal);
  if (!text(raw.checkoutMandateId, 160) || !text(raw.selectedBookingId, 160)
    || !text(raw.itineraryDigest, 80) || !ids.length || !Number.isFinite(amount)
    || !text(raw.currency, 20)) return null;
  return Object.freeze({
    contractVersion: CONTRACT_VERSION,
    checkoutMandateId: text(raw.checkoutMandateId, 160),
    objective: "reach_payment_entry",
    selectedBookingId: text(raw.selectedBookingId, 160),
    itineraryDigest: text(raw.itineraryDigest, 80),
    travelerIds: Object.freeze(ids),
    approvedTotal: amount,
    currency: text(raw.currency, 20).toUpperCase(),
    standardAttestations: Object.freeze(Object.fromEntries(STANDARD_ATTESTATIONS.map((key) => [key, raw.standardAttestations?.[key] === true]))),
    forbidden: Object.freeze([...(raw.forbidden || DEFAULT_FORBIDDEN)].map((item) => text(item, 80)).filter(Boolean)),
    createdAt: text(raw.createdAt, 80)
  });
}

function classifyAttestation(value = "") {
  const normalized = text(value, 4_000).toLowerCase();
  const classes = [];
  if (/accurac|correct.*(?:name|date|flight|travell?er)|travel document/.test(normalized)) classes.push("bookingAccuracy");
  if (/conditions? of carriage|general conditions|carrier terms/.test(normalized)) classes.push("conditionsOfCarriage");
  if (/fare (?:family )?terms|fare conditions|selected fare/.test(normalized)) classes.push("selectedFareConditions");
  if (/purchase conditions|booking conditions|terms and conditions/.test(normalized)) classes.push("purchaseConditions");
  if (/dangerous goods|restricted articles|passenger baggage/.test(normalized)) classes.push("dangerousGoods");
  const exceptional = /(?:visa|residen|citizen|medical|health|pregnan|disabil|waiv|release of liability|power of attorney|guardian|unaccompanied minor|tax declaration)/.test(normalized);
  const forbidden = /(?:marketing|newsletter|promotional (?:email|message)|share my data|third[- ]party data|insurance|subscription|financing|credit agreement)/.test(normalized);
  return Object.freeze({
    classes: Object.freeze([...new Set(classes)]),
    standard: classes.length > 0 && !exceptional && !forbidden,
    exceptional,
    forbidden,
    legalTextDigest: digest(normalized)
  });
}

function mandateCoversAttestation(mandate = null, classification = null) {
  const normalized = normalizeCheckoutMandate(mandate);
  if (!normalized || !classification?.standard || classification.exceptional || classification.forbidden) return false;
  return classification.classes.every((key) => normalized.standardAttestations[key] === true);
}

function authorizationFromMandate({ mandate = null, transactionId = "", sceneItem = null } = {}) {
  const normalized = normalizeCheckoutMandate(mandate);
  if (!normalized || !sceneItem?.sceneItemId || sceneItem.authority !== "checkout_mandate") return null;
  const legalTextDigest = text(sceneItem.legalTextDigest, 80);
  const legalControlId = text(sceneItem.controlIds?.[0], 180);
  if (!legalTextDigest || !legalControlId) return null;
  return Object.freeze({
    contractVersion: AUTHORIZATION_VERSION,
    authorizationId: `mandate_legal_${digest([
      normalized.checkoutMandateId,
      transactionId,
      sceneItem.sceneItemId,
      legalTextDigest
    ].join("|")).slice(0, 40)}`,
    checkoutMandateId: normalized.checkoutMandateId,
    transactionId: text(transactionId, 160),
    itineraryDigest: normalized.itineraryDigest,
    travelerIds: normalized.travelerIds,
    total: normalized.approvedTotal,
    currency: normalized.currency,
    sceneItemId: text(sceneItem.sceneItemId, 500),
    legalSemanticOwnerId: text(sceneItem.semanticOwnerId, 500),
    legalTextDigest,
    legalControlId,
    source: "checkout_mandate"
  });
}

function attestationReceipt({ mandate = null, transactionId = "", sceneItemId = "", authorization = null, actionResult = null } = {}) {
  const normalized = normalizeCheckoutMandate(mandate);
  if (!normalized || authorization?.contractVersion !== AUTHORIZATION_VERSION
    || actionResult?.verified !== true || actionResult?.postconditionSatisfied !== true) return null;
  return Object.freeze({
    contractVersion: RECEIPT_VERSION,
    checkoutMandateId: normalized.checkoutMandateId,
    transactionId: text(transactionId, 160),
    sceneItemId: text(sceneItemId || authorization.sceneItemId, 500),
    travelerIds: normalized.travelerIds,
    itineraryDigest: normalized.itineraryDigest,
    total: normalized.approvedTotal,
    currency: normalized.currency,
    legalTextDigest: text(authorization.legalTextDigest, 80),
    controlId: text(actionResult.controlId || actionResult.action?.controlId || authorization.legalControlId, 180),
    authorizationId: text(authorization.authorizationId, 180),
    verifiedAt: new Date().toISOString()
  });
}

module.exports = {
  AUTHORIZATION_VERSION,
  CONTRACT_VERSION,
  RECEIPT_VERSION,
  STANDARD_ATTESTATIONS,
  attestationReceipt,
  authorizationFromMandate,
  classifyAttestation,
  createCheckoutMandate,
  mandateCoversAttestation,
  normalizeCheckoutMandate
};
