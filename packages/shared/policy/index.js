// The single place safety/preference rules live. Called once, right before any
// action executes, regardless of which site or which detector produced the
// action. Extension, backend, and (later) iOS should all call this same
// function rather than re-implementing "is this safe" independently.

/**
 * @typedef {"allow"|"deny"|"ask_user"} PolicyVerdict
 * @typedef {Object} PolicyDecision
 * @property {boolean} allow
 * @property {PolicyVerdict} decision
 * @property {string} reason
 */

const CARD_FIELD_PATTERN = /\bcard\s*(number|no\.?)\b|\bcvc\b|\bcvv\b|\bsecurity\s*code\b|\bcc-?(number|csc)\b|\bcardholder\b|\bexpir(y|ation)\b.*\bcard\b/i;
const LEGAL_TERMS_PATTERN = /\bterms\s*(and|&)\s*conditions\b|\bi\s+agree\b|\bprivacy\s*policy\b|\bfare\s*rules\b|\blegal\s*(notice|acceptance)\b/i;
const PAID_EXTRA_LABEL_PATTERN = /\badd to (my trip|cart)\b|\bupgrade\b|\bpremium\b|\bbuy\b|\bpurchase\b|\bselect (seat|bag)\b/i;
const DECLINE_LABEL_PATTERN = /\bno,?\s*thanks\b|\bno\s+(checked\s+)?baggage\b|\bnone of the passengers\b|\bskip\b|\bwithout\b|\bdecline\b|\bi.ll go without\b|\b0\s*(eur|usd|gbp|\$|€)\b/i;

function textOf(action) {
  const target = action.targetSnapshot || {};
  return `${action.targetLabel || ""} ${action.value || ""} ${target.label || ""} ${target.semantic || ""} ${target.risk || ""}`.trim();
}

function labelOf(action) {
  return String(action.targetLabel || action.value || "").trim();
}

function isDeclineOrSkipAction(action) {
  const target = action.targetSnapshot || {};
  return action.intent === "decline_optional_extra"
    || target.semantic === "decline_paid_extra"
    || target.semantic === "safe_decline"
    || target.risk === "safe_decline"
    || DECLINE_LABEL_PATTERN.test(textOf(action))
    || action.type === "skip_optional_extra"
    || action.type === "close_modal";
}

function isNonMutatingAction(action) {
  return ["ask_user", "stop", "wait", "scroll"].includes(action.type);
}

function isOpenChoiceControlAction(action) {
  const target = action.targetSnapshot || {};
  const text = textOf(action);
  if (action.intent === "open_choice_control") return true;
  if (action.type !== "click") return false;
  if (!/\b(choose|select option|select one option|open)\b/i.test(text)) return false;
  if (target.semantic === "add_paid_extra" || target.risk === "money") return false;
  return ["button", "select", "combobox", "field", "choice"].includes(target.kind || "")
    || /\b(choose|select option|select one option)\b/i.test(labelOf(action));
}

function looksLikeContinueAction(action) {
  if (action.type !== "click" && action.type !== "click_xy") return false;
  const label = labelOf(action);
  if (!label || isDeclineOrSkipAction(action)) return false;
  return /^(continue|next|proceed|done)\b/i.test(label);
}

function blocksContinue(req, profile = {}) {
  if (!req || req.status === "satisfied") return false;
  if (req.status === "conflicted") return true;
  // A "Continue button" requirement is the action itself, not a prerequisite
  // for clicking Continue. Blocking on it creates a circular wait loop.
  if (req.type === "continue") return false;
  if (/^continue\b|continue button|next step/i.test(String(req.id || req.label || ""))) return false;
  // Passive disclaimer copy such as "names match passports" with no checkbox
  // should not block an intermediate Continue button. Explicit legal controls
  // and final payment remain gated elsewhere.
  if (req.type === "legal_acceptance"
    && !(req.targetIds || []).length
    && /name.*match.*passport|passports? of those travelling|passports? of those traveling/i.test(`${req.label || ""} ${(req.evidence || []).join(" ")}`)) {
    return false;
  }
  if (req.required) return true;
  return false;
}

function looksLikeCardField(action) {
  return CARD_FIELD_PATTERN.test(textOf(action)) || action.risk === "payment" && action.type === "type";
}

function looksLikeFinalPayment(action) {
  if (action.type === "final_review") return true;
  return /\b(pay now|confirm and pay|submit payment|complete (booking|purchase)|place order|book now)\b/i.test(textOf(action));
}

function looksLikeLegalAcceptance(action) {
  return LEGAL_TERMS_PATTERN.test(textOf(action));
}

function looksLikePaidExtraSelection(action) {
  if (isNonMutatingAction(action) || isDeclineOrSkipAction(action) || isOpenChoiceControlAction(action)) return false;
  const text = textOf(action);
  if (DECLINE_LABEL_PATTERN.test(text)) return false;
  return PAID_EXTRA_LABEL_PATTERN.test(text) || action.risk === "money";
}

function profileWantsNoExtras(profile = {}) {
  const rules = String(profile.booking_rules || "").toLowerCase();
  return /no paid|no extras|no add-?ons|no seat|no insurance|no bundle|personal item only|avoid paid/.test(rules);
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
  if (action.type === "click_xy" && !textOf(action) && action.risk !== "safe") {
    return { allow: false, decision: "ask_user", reason: "Coordinate click has no visible label, so it needs human confirmation before acting." };
  }

  // Hard asks — always require explicit human confirmation, no matter what's cached.
  if (looksLikeFinalPayment(action) && !merged.paymentApproved) {
    return { allow: false, decision: "ask_user", reason: "This looks like a final purchase/payment action and needs your explicit confirmation." };
  }
  if (looksLikeLegalAcceptance(action) && !merged.legalApproved) {
    return { allow: false, decision: "ask_user", reason: "This looks like accepting legal terms/fare rules and needs your explicit confirmation." };
  }
  if (state && require("../agent-state").priceIncreasedSincePrevious(state) && !merged.priceIncreaseApproved) {
    return { allow: false, decision: "ask_user", reason: "The price increased since it was last checked; confirm before continuing." };
  }

  // Paid extras: allow declining freely; allow *selecting* only with explicit approval.
  if (looksLikePaidExtraSelection(action)) {
    if (merged.skipPaidExtrasApproved || profileWantsNoExtras(profile)) {
      // "Skip paid extras" directly contradicts a selection-shaped action — this
      // isn't ambiguous, it's a straight no, not something worth another round-trip.
      return { allow: false, decision: "deny", reason: "This looks like selecting a paid extra, which contradicts the saved preference to decline paid extras." };
    }
    return { allow: false, decision: "ask_user", reason: "This looks like selecting a paid extra with no saved preference either way. Confirm before adding it." };
  }

  // Continue/advance: only once every required requirement is actually satisfied.
  if (looksLikeContinueAction(action)) {
    const missing = (state?.requirements || []).filter((req) => req.status !== "satisfied" && blocksContinue(req, profile));
    if (missing.length) {
      return { allow: false, decision: "deny", reason: `${missing.length} required item(s) not yet satisfied: ${missing.map((r) => r.label).join(", ")}.` };
    }
  }

  return { allow: true, decision: "allow", reason: "No policy restriction matched; routine action." };
}

module.exports = {
  evaluateActionPolicy,
  looksLikeCardField,
  looksLikeFinalPayment,
  looksLikeLegalAcceptance,
  looksLikePaidExtraSelection,
  profileWantsNoExtras,
  isDeclineOrSkipAction,
  isNonMutatingAction,
  isOpenChoiceControlAction
};
