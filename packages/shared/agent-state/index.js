/**
 * @typedef {Object} ApprovalState
 * @property {boolean} skipPaidExtrasApproved
 * @property {boolean} paymentApproved
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
 * @property {ApprovalState} approvals
 * @property {import("../agent-actions").AgentAction|null} lastAction
 * @property {Object|null} lastVerification
 * @property {string[]} traceIds
 * @property {string} currentObservationId
 * @property {string} currentObservationHash
 * @property {Object|null} currentObservation
 * @property {Object|null} taskState
 * @property {Object} observationReadiness
 * @property {Object} executionEpisode
 * @property {{candidateSelection?: Object}|null} aiDecisionCache
 * @property {Object} userPolicy
 * @property {Object} sessionProfileOverrides
 * @property {{requestId:string,field:string,label:string,subjectId?:string,sensitive?:boolean}|null} pendingUserInput
 * @property {Object|null} transactionInvariants
 * @property {Object|null} checkoutMandate
 * @property {Object} paymentState
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
    sessionProfileOverrides: {},
    pendingUserInput: null,
    site: { host: String(site.host || ""), url: String(site.url || ""), sellerName: site.sellerName || undefined },
    currentObservation: null,
    taskState: null,
    observationReadiness: {
      classification: "READY",
      key: "",
      attempts: 0,
      maxAttempts: 3,
      reason: "",
      evidence: null
    },
    executionEpisode: {
      contractVersion: "execution-episode/v2",
      obligationId: "",
      leasedAction: null,
      status: "idle",
      actionId: "",
      attempts: 0,
      phase: "idle",
      attemptedCandidateIds: [],
      failedStrategies: [],
      failedStrategySignatures: [],
      lastCode: "",
      remainingAttempts: 0,
      deadlineAt: 0,
      updatedAt: ""
    },
    aiDecisionCache: null,
    approvals: { skipPaidExtrasApproved: false, paymentApproved: false, priceIncreaseApproved: false },
    lastAction: null,
    lastVerification: null,
    traceIds: [],
    currentObservationId: "",
    currentObservationHash: "",
    transactionInvariants: null,
    checkoutMandate: null,
    paymentState: { status: "not_authorized", authorizationId: "", attempts: 0, lastAttemptAt: "" },
    createdAt: at,
    updatedAt: at
  };
}

function withUpdate(state, patch) {
  const update = { ...(patch || {}) };
  const merged = { ...state, ...update, updatedAt: nowIso() };
  delete merged.pendingAction;
  delete merged.actionLifecycle;
  delete merged.recoveryState;
  delete merged.pendingMechanicalEvidence;
  // One obligation-owned recovery state is authoritative. Remove historical
  // scheduler/diagnostic fields whenever a session advances so old persisted
  // sessions cannot reactivate competing runtime paths.
  delete merged.legacyRequirementsDiagnostic;
  delete merged.navigationSettling;
  delete merged.attemptedCandidateIds;
  delete merged.attemptedStrategySignatures;
  delete merged.failedStrategyMemory;
  delete merged.blockedProfileGoalKeys;
  delete merged.blockedProfilePageStateHash;
  // TaskState is the only semantic-goal authority. Historical root mirrors
  // multiplied large candidate graphs and allowed consumers to read a stale
  // goal after TaskState had advanced.
  delete merged.currentGoal;
  delete merged.currentObligation;
  return merged;
}

function normalizeStep(step) {
  return CHECKOUT_STEPS.has(step) ? step : "unknown";
}

function normalizeStatus(status) {
  return SESSION_STATUSES.has(status) ? status : "running";
}

function latestPrice(state) {
  const current = state.transactionInvariants?.current?.totalPrice;
  if (Number.isFinite(Number(current?.amount)) && current?.amount !== null) {
    return {
      amount: Number(current.amount),
      currency: String(current.currency || state.transactionInvariants?.current?.currency || ""),
      capturedAt: state.updatedAt || ""
    };
  }
  const legacy = Array.isArray(state.priceHistory) ? state.priceHistory : [];
  return legacy[legacy.length - 1] || null;
}

/** True if the newest price is meaningfully (>3%) higher than the previous one. */
function priceIncreasedSincePrevious(state) {
  const evidence = Array.isArray(state.transactionInvariants?.evidence)
    ? state.transactionInvariants.evidence
      .map((entry) => ({
        amount: entry.facts?.totalPrice?.amount,
        currency: entry.facts?.totalPrice?.currency || entry.facts?.currency || "",
        capturedAt: entry.observedAt || ""
      }))
      .filter((entry) => Number.isFinite(Number(entry.amount)) && entry.amount !== null)
    : [];
  const history = evidence.length ? evidence : (Array.isArray(state.priceHistory) ? state.priceHistory : []);
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
