// The single place safety/preference rules live. Called once, right before any
// action is dispatched, regardless of which site or detector proposed it.
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
  return action.risk === "legal"
    || target.risk === "legal"
    || action.intent === "accept_legal_terms"
    || target.semantic === "accept_legal_terms";
}

function looksLikePaidExtraSelection(action) {
  if (isNonMutatingAction(action) || isDeclineOrSkipAction(action) || isOpenChoiceControlAction(action)) return false;
  const target = action.targetSnapshot || {};
  return Number(action.affordance?.structuredPrice?.amount) > 0
    || action.affordance?.risk === "money"
    || action.risk === "money"
    || target.risk === "money"
    || target.risk === "paid"
    || ["add_paid_extra", "select_paid_seat", "select_paid_baggage"].includes(action.intent)
    || ["add_paid_extra", "select_paid_seat", "select_paid_baggage"].includes(target.semantic);
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
  if (looksLikeLegalAcceptance(action) && !merged.legalApproved) {
    return { allow: false, decision: "ask_user", reason: "This looks like accepting legal terms/fare rules and needs your explicit confirmation." };
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

  // TaskState describes remaining work but does not veto a grounded safe
  // foreground click. If Continue exposes validation or another popup, the
  // fresh observation becomes the next source of action guidance.

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
