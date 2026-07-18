/**
 * @typedef {Object} ApprovalState
 * @property {boolean} skipPaidExtrasApproved
 * @property {boolean} paymentApproved
 * @property {boolean} legalApproved
 * @property {boolean} priceIncreaseApproved
 *
 * @typedef {Object} PriceSnapshot
 * @property {number} amount
 * @property {string} currency
 * @property {string} capturedAt
 *
 * @typedef {Object} SelectedOption
 * @property {string} requirementId
 * @property {string} label
 * @property {string} value
 * @property {string} at
 *
 * @typedef {Object} AgentFailure
 * @property {string} at
 * @property {string} actionSignature
 * @property {string} actuatorSignature
 * @property {string} goalKey
 * @property {string} actionId
 * @property {string} observationId
 * @property {string} controlId
 * @property {string} targetId
 * @property {string} operation
 * @property {string} code
 * @property {string} message
 *
 * @typedef {"flight_selection"|"traveler_information"|"extras"|"seats"|"payment"|"confirmation"|"unknown"} CheckoutStep
 * @typedef {"running"|"awaiting_user"|"ready_for_payment"|"complete"|"failed"} SessionStatus
 *
 * @typedef {Object} CheckoutSessionState
 * @property {string} id
 * @property {SessionStatus} status
 * @property {string} goal
 * @property {string} travelerId
 * @property {string[]} travelerIds
 * @property {{host: string, url: string, sellerName?: string}} site
 * @property {CheckoutStep} currentStep
 * @property {import("../requirements").CheckoutRequirement[]} requirements
 * @property {ApprovalState} approvals
 * @property {PriceSnapshot[]} priceHistory
 * @property {SelectedOption[]} selectedOptions
 * @property {import("../agent-actions").AgentAction|null} lastAction
 * @property {Object|null} lastVerification
 * @property {AgentFailure[]} failures
 * @property {string[]} traceIds
 * @property {string} currentObservationId
 * @property {string} currentObservationHash
 * @property {Object[]} requirementLifecycle
 * @property {Object[]} decisionCompletions
 * @property {Object[]} activeRequirements
 * @property {Object|null} currentObservation
 * @property {Object|null} currentGoal
 * @property {Object|null} currentObligation
 * @property {Object|null} pendingAction
 * @property {Object|null} actionLifecycle
 * @property {string[]} attemptedCandidateIds
 * @property {Object[]} failedStrategyMemory
 * @property {Object} recoveryState
 * @property {Object[]} verifiedResults
 * @property {Object} userPolicy
 * @property {Object|null} transactionInvariants
 * @property {Object} paymentState
 * @property {Object} confirmationState
 * @property {string} createdAt
 * @property {string} updatedAt
 */

const CHECKOUT_STEPS = new Set([
  "flight_selection", "traveler_information", "extras", "seats", "payment", "confirmation", "unknown"
]);
const SESSION_STATUSES = new Set(["running", "awaiting_user", "ready_for_payment", "complete", "failed"]);

function nowIso() {
  return new Date().toISOString();
}

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** @returns {CheckoutSessionState} */
function createCheckoutSessionState({ goal = "", travelerId = "", site = {} } = {}) {
  const at = nowIso();
  return {
    id: uid("chk"),
    status: "running",
    goal: String(goal || "Complete checkout safely."),
    travelerId: String(travelerId || ""),
    travelerIds: travelerId ? [String(travelerId)] : [],
    userPolicy: {},
    site: { host: String(site.host || ""), url: String(site.url || ""), sellerName: site.sellerName || undefined },
    currentStep: "unknown",
    requirements: [],
    requirementLifecycle: [],
    decisionCompletions: [],
    activeRequirements: [],
    currentObservation: null,
    currentGoal: null,
    currentObligation: null,
    pendingAction: null,
    actionLifecycle: null,
    attemptedCandidateIds: [],
    failedStrategyMemory: [],
    recoveryState: {
      attempts: 0,
      phase: "idle",
      stateHash: "",
      failedStrategySignatures: [],
      lastCode: "",
      lastRevealSample: null,
      updatedAt: ""
    },
    verifiedResults: [],
    approvals: { skipPaidExtrasApproved: false, paymentApproved: false, legalApproved: false, priceIncreaseApproved: false },
    priceHistory: [],
    selectedOptions: [],
    lastAction: null,
    lastVerification: null,
    failures: [],
    traceIds: [],
    currentObservationId: "",
    currentObservationHash: "",
    itineraryFingerprint: "",
    offerFingerprint: "",
    transactionInvariants: null,
    paymentState: { status: "not_authorized", authorizationId: "", attempts: 0, lastAttemptAt: "" },
    confirmationState: { status: "not_confirmed", reference: "", confirmedAt: "" },
    createdAt: at,
    updatedAt: at
  };
}

function withUpdate(state, patch) {
  return { ...state, ...patch, updatedAt: nowIso() };
}

function normalizeStep(step) {
  return CHECKOUT_STEPS.has(step) ? step : "unknown";
}

function normalizeStatus(status) {
  return SESSION_STATUSES.has(status) ? status : "running";
}

function latestPrice(state) {
  return state.priceHistory[state.priceHistory.length - 1] || null;
}

/** True if the newest price is meaningfully (>3%) higher than the previous one. */
function priceIncreasedSincePrevious(state) {
  const history = state.priceHistory;
  if (history.length < 2) return false;
  const prev = history[history.length - 2];
  const curr = history[history.length - 1];
  if (!prev || !curr || prev.currency !== curr.currency) return false;
  return curr.amount > prev.amount * 1.03;
}

module.exports = {
  createCheckoutSessionState, withUpdate, normalizeStep, normalizeStatus,
  latestPrice, priceIncreasedSincePrevious, CHECKOUT_STEPS, SESSION_STATUSES, uid, nowIso
};
