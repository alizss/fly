const {
  actionForCurrentCandidate,
  bindMechanics
} = require("../mechanics-binder");
const { leasedActionRecord } = require("../action-lifecycle");
const { normalizeAction } = require("../../../../packages/shared/agent-actions");
const { currentObligation } = require("../authority-frames");
const { obligationField } = require("../current-obligation");
const { canonicalizeUserPolicy, seatPolicyFrom } = require("../policy-profile");
const { bindTargetSnapshot } = require("./mechanics");

function taskMechanics(taskState = {}) {
  return currentObligation(taskState) || {};
}

function recoveryScrollAmount(action = {}, observation = {}) {
  const region = action.targetSnapshot?.visualRegion || action.targetSnapshot?.box || {};
  const viewportHeight = Number(observation.page?.viewport?.height || 0) || 800;
  const top = Number(region.y);
  const height = Number(region.height || 0);
  const center = Number.isFinite(top) ? top + height / 2 : viewportHeight;
  let amount = Math.round(center - viewportHeight / 2);
  if (!Number.isFinite(amount) || Math.abs(amount) < 120) amount = center < 0 ? -420 : 420;
  return Math.max(-700, Math.min(700, amount));
}

function viewportRecoveryAction(blockedAction = {}, observation = {}, recoveryCount = 1) {
  return normalizeAction({
    id: `act_recover_view_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    observationId: observation.observationId || "",
    observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
    type: "scroll",
    intent: "recover_target_viewport",
    controlId: blockedAction.controlId || blockedAction.targetSnapshot?.controlId || "",
    actuatorId: blockedAction.actuatorId || blockedAction.targetSnapshot?.id || "",
    targetLabel: blockedAction.targetLabel || blockedAction.targetSnapshot?.label || "",
    scrollY: recoveryScrollAmount(blockedAction, observation),
    expectedOutcome: {
      type: "target_in_view",
      controlId: blockedAction.controlId || blockedAction.targetSnapshot?.controlId || "",
      recoveryOfActionId: blockedAction.id || "",
      attempt: recoveryCount,
      scrollStrategy: recoveryCount >= 3 ? "nearest_container" : "target_center"
    },
    risk: "safe",
    requiresApproval: false,
    reason: `Governed viewport recovery for ${blockedAction.targetLabel || blockedAction.controlId || "the pending canonical control"}.`
  });
}

function viewportProgressSample(action = {}, observation = {}) {
  const target = action.targetSnapshot || null;
  const region = target?.visualRegion || target?.box || null;
  const viewportHeight = Number(observation.page?.viewport?.height || 0);
  const top = Number(region?.y);
  const height = Number(region?.height || 0);
  const center = Number.isFinite(top) ? top + height / 2 : null;
  const distanceToViewport = center == null || !viewportHeight
    ? null
    : center < 0
      ? Math.abs(center)
      : center > viewportHeight
        ? center - viewportHeight
        : 0;
  return {
    observationId: observation.observationId || "",
    exists: Boolean(target?.id && target?.controlId),
    inViewport: region?.inViewport === true,
    distanceToViewport: Number.isFinite(distanceToViewport) ? Math.round(distanceToViewport) : null,
    at: new Date().toISOString()
  };
}

function viewportProgress(previous = null, sample = {}) {
  const previousDistance = typeof previous?.distanceToViewport === "number" ? previous.distanceToViewport : null;
  const currentDistance = typeof sample?.distanceToViewport === "number" ? sample.distanceToViewport : null;
  const measurableProgress = Boolean(
    sample.inViewport
    || (sample.exists && previous && !previous.exists)
    || (previous
      && previousDistance != null
      && currentDistance != null
      && currentDistance <= previousDistance - 8)
  );
  return {
    ...sample,
    measurableProgress
  };
}

function pendingRevealAction(blockedAction = {}, recoveryAttempts = 1, candidate = null, goal = {}) {
  return leasedActionRecord({
    action: normalizeAction({
      ...blockedAction,
      targetSnapshot: null,
      expectedOutcome: null
    }),
    candidate,
    goal,
    status: "needs_reveal",
    recoveryAttempts
  });
}

function rebindPendingRecoveryAction(pending = {}, observation = {}, state = {}, traveler = {}) {
  const original = pending.originalAction || {};
  const authoritativeGoal = taskMechanics(state.taskState || {});
  const direct = bindTargetSnapshot(normalizeAction({
    ...original,
    id: `act_rebind_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    observationId: observation.observationId || "",
    observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
    actuatorId: original.controlId || original.actuatorId || "",
    targetSnapshot: null,
    expectedOutcome: null,
    reason: `Rebound pending governed action after viewport recovery: ${original.reason || original.intent || original.type || "action"}.`
  }), observation);
  if (!obligationField(authoritativeGoal, "goalId")) {
    return { action: direct, candidateSet: null, candidate: pending.candidateIdentity || null };
  }

  const reboundSet = bindMechanics({
    obligation: currentObligation(state.taskState || {}),
    observation,
    traveler,
    state,
    approvals: state.approvals,
    attemptedCandidateIds: [],
    attemptedStrategySignatures: []
  });
  const previous = pending.candidateIdentity || {};
  const previousStableKey = previous.affordance?.stableKey || previous.stableKey || "";
  const exactStableCandidate = (reboundSet.candidates || []).find((candidate) => (
    previousStableKey
      && (candidate.affordance?.stableKey || candidate.stableKey || "") === previousStableKey
      && candidate.operation === previous.operation
  )) || null;
  const profileSemantic = String(
    obligationField(authoritativeGoal, "kind") === "profile_field"
      ? (obligationField(authoritativeGoal, "field") || obligationField(authoritativeGoal, "semanticType") || "")
      : obligationField(authoritativeGoal, "semanticType") || ""
  ).toLowerCase();
  const profileRecovery = obligationField(authoritativeGoal, "kind") === "profile_field"
    || /^(?:email|confirm_email|phone|phone_country_code|first_name|given_names|middle_name|last_name|second_last_name|full_name|title|gender|date_of_birth|place_of_birth|nationality|country_of_residence|document_type|passport_number|document_number|issuing_country|document_issue_date|passport_expiry|document_expiry|address_line1|address_line2|city|state|postal_code|country)$/.test(profileSemantic);
  const semanticProfileCandidate = profileRecovery
    ? (reboundSet.candidates || []).find((candidate) => (
        candidate.operation === (previous.operation || original.operation)
        && String(candidate.semanticGoal || obligationField(authoritativeGoal, "semanticGoal") || "").toLowerCase()
          === String(previous.semanticGoal || obligationField(authoritativeGoal, "semanticGoal") || "").toLowerCase()
        && String(candidate.decisionGroupId || "") === String(previous.decisionGroupId || original.decisionGroupId || "")
      )) || null
    : null;
  const reboundCandidate = exactStableCandidate || semanticProfileCandidate;
  if (!reboundCandidate) return { action: direct, candidateSet: reboundSet, candidate: null };
  const action = bindTargetSnapshot(normalizeAction({
    ...actionForCurrentCandidate(authoritativeGoal, reboundCandidate, observation),
    id: `act_rebind_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    reason: `Rebound the same semantic action to the fresh canonical control after viewport recovery: ${original.reason || original.intent || original.type || "action"}.`
  }), observation);
  return { action, candidateSet: reboundSet, candidate: reboundCandidate };
}

function pendingRecoveryOwnedByCurrentObligation(pending = {}, taskState = {}) {
  const original = pending.originalAction || {};
  const lease = pending.actionLease || {};
  const obligation = currentObligation(taskState);
  if (!obligation) return false;

  const leasedObligationId = String(lease.obligationId || original.obligationId || "").trim();
  const currentObligationId = String(obligation.obligationId || "").trim();
  if (leasedObligationId && currentObligationId && leasedObligationId !== currentObligationId) return false;

  const leasedDecisionGroupId = String(
    original.decisionGroupId
      || original.expectedOutcome?.decisionGroupId
      || original.expectedPostconditions?.[0]?.decisionGroupId
      || ""
  ).trim();
  const currentDecisionGroupId = String(obligation.subject?.decisionGroupId || "").trim();
  if (leasedDecisionGroupId && currentDecisionGroupId && leasedDecisionGroupId !== currentDecisionGroupId) return false;

  const delta = obligation.desiredStateDelta || obligation.binding?.component?.desiredStateDelta || null;
  if (delta && delta.actionRequired === false) return false;
  return true;
}

function pendingRecoveryTargetStatus(action = {}) {
  const target = action.targetSnapshot || null;
  const region = target?.visualRegion || target?.box || null;
  return {
    exists: Boolean(target?.id && target?.controlId),
    inViewport: region?.inViewport === true
  };
}

function actionAdvancesCheckout(action = {}) {
  const effect = action.mechanicalEffect
    || action.affordance?.mechanicalEffect
    || action.affordance?.physicalEffect
    || action.affordance?.effect
    || "";
  return ["advance_surface", "advance_checkout_stage"].includes(effect)
    || ["navigate_stage", "advance_current_surface", "continue_checkout"].includes(action.intent || "");
}

function stableDecisionValue(value) {
  if (Array.isArray(value)) return value.map(stableDecisionValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableDecisionValue(value[key])])
  );
}

function aiDecisionPolicyFingerprint(userPolicy = {}, traveler = {}) {
  const canonicalPolicy = canonicalizeUserPolicy(userPolicy, traveler);
  return JSON.stringify(stableDecisionValue({
    userPolicy: canonicalPolicy,
    travelerPreferences: {
      bookingRules: traveler.booking_rules || "",
      seatPolicy: seatPolicyFrom({ userPolicy: canonicalPolicy, traveler }),
      baggage: traveler.baggage_preference || "",
      payment: traveler.payment_preference || ""
    }
  }));
}

function observationDecisionHash(observation = {}) {
  return String(observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "");
}

function decisionConflictId(goal = {}) {
  return String(obligationField(goal, "decisionGroupId") || obligationField(goal, "requirementId") || obligationField(goal, "goalId") || "");
}

function candidateIntendedOutcome(candidate = {}, selection = {}) {
  return String(candidate.intendedOutcome || candidate.semanticIntent || selection.semanticOutcome || "unknown");
}

function candidateSelectionCacheEntry({ observation = {}, goal = {}, candidate = {}, selection = {}, policyFingerprint = "" } = {}) {
  if (!candidate.candidateId || !candidate.controlId) return null;
  return Object.freeze({
    observationId: String(observation.observationId || ""),
    observationHash: observationDecisionHash(observation),
    policyFingerprint,
    conflictId: decisionConflictId(goal),
    obligationId: String(obligationField(goal, "goalId") || ""),
    candidateId: String(candidate.candidateId),
    controlId: String(candidate.controlId),
    stableControlIdentity: String(candidate.affordance?.stableKey || candidate.stableKey || candidate.controlId),
    operation: String(candidate.operation || candidate.type || ""),
    intendedOutcome: candidateIntendedOutcome(candidate, selection),
    semanticOutcome: String(selection.semanticOutcome || "satisfy_current_decision"),
    confidence: String(selection.confidence || "unknown")
  });
}

function reusableCandidateSelection(cache = null, observation = {}, goal = {}, candidateSet = {}, policyFingerprint = "") {
  const entry = cache?.candidateSelection;
  if (!entry || entry.observationHash !== observationDecisionHash(observation)) return null;
  if (entry.policyFingerprint !== policyFingerprint) return null;
  if (entry.conflictId !== decisionConflictId(goal) || entry.obligationId !== String(obligationField(goal, "goalId") || "")) return null;
  const candidate = (candidateSet.candidates || []).find((item) => (
    String(item.affordance?.stableKey || item.stableKey || item.controlId) === entry.stableControlIdentity
    && String(item.operation || item.type || "") === entry.operation
    && candidateIntendedOutcome(item, entry) === entry.intendedOutcome
    && item.policyDecision?.allow === true
    && item.risk === "safe"
    && item.requiresApproval !== true
  ));
  if (!candidate) return null;
  return {
    candidateId: candidate.candidateId,
    candidate,
    semanticOutcome: entry.semanticOutcome,
    confidence: entry.confidence,
    meta: null,
    reused: true
  };
}

function staleActionRecoveryEntry(action = {}, candidate = {}, goal = {}, policyFingerprint = "", code = "") {
  if (!["OBSERVATION_HASH_MISMATCH", "STALE_OBSERVATION"].includes(code)) return null;
  const stableControlIdentity = String(candidate.affordance?.stableKey || candidate.stableKey || action.affordance?.stableKey || action.controlId || "");
  if (!stableControlIdentity) return null;
  return Object.freeze({
    code,
    conflictId: decisionConflictId(goal),
    obligationId: String(obligationField(goal, "goalId") || action.obligationId || ""),
    stableControlIdentity,
    operation: String(candidate.operation || action.operation || action.type || ""),
    intendedOutcome: candidateIntendedOutcome(candidate, action),
    policyFingerprint,
    attempts: 1
  });
}

function reusableStaleActionCandidate(entry = null, goal = {}, candidateSet = {}, policyFingerprint = "") {
  if (!entry || entry.attempts !== 1 || entry.policyFingerprint !== policyFingerprint) return null;
  if (entry.conflictId !== decisionConflictId(goal) || entry.obligationId !== String(obligationField(goal, "goalId") || "")) return null;
  return (candidateSet.candidates || []).find((candidate) => (
    String(candidate.affordance?.stableKey || candidate.stableKey || candidate.controlId) === entry.stableControlIdentity
    && String(candidate.operation || candidate.type || "") === entry.operation
    && candidateIntendedOutcome(candidate, entry) === entry.intendedOutcome
    && candidate.policyDecision?.allow === true
    && candidate.risk === "safe"
    && candidate.requiresApproval !== true
  )) || null;
}

module.exports = {
  actionAdvancesCheckout,
  aiDecisionPolicyFingerprint,
  candidateSelectionCacheEntry,
  pendingRecoveryTargetStatus,
  pendingRevealAction,
  pendingRecoveryOwnedByCurrentObligation,
  rebindPendingRecoveryAction,
  reusableCandidateSelection,
  reusableStaleActionCandidate,
  staleActionRecoveryEntry,
  viewportProgress,
  viewportProgressSample,
  viewportRecoveryAction
};
