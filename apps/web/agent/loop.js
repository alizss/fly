// The actual observe -> verify -> plan -> policy -> act loop. "act" itself
// happens client-side in the extension (it owns the real DOM); this module's
// job ends at "here is the one policy-approved action to execute," same
// contract /api/agent/next-action already had — the internals are what changed.
//
// Loop-shape note: the spec's abstract "observe -> verify -> plan -> act ->
// verify -> repeat" maps onto this stateless-per-request architecture as:
// verify-after-act happens at the START of the NEXT request (using
// lastActionResult + a fresh requirement extraction), not as a second call
// within the same request. Each HTTP call is one full lap: verify what the
// previous action did, then plan+policy-check the next one.
//
// Zero model calls when task/policy filtering leaves one obvious safe action.
// Ambiguous turns use at most two: classification plus combined verify/plan.
// The original 3-call version measured 15-30+ seconds per turn in practice,
// which is a real cost for a product whose whole point is being fast.

const { selectCandidate } = require("./select-candidate");
const {
  actionForCurrentCandidate,
  buildCurrentCandidateSet
} = require("./current-candidate-builder");
const { governAction, RECOVERABLE_GROUNDING_CODES } = require("./action-governor");
const { buildControlAliasIndex, resolveActionControl } = require("./control-alias-index");
const {
  profileStageReadiness,
  deriveProfileGoal,
  profileGoalSatisfied
} = require("./skill-expander");
const { writeTrace } = require("./trace-store");
const {
  advanceActionLifecycle,
  canonicalFailureCode,
  normalizePendingAction,
  pendingActionNeedsResult,
  pendingActionRecord,
  recoverBeforeDispatch,
  updateRecoveryState,
  wasDispatched
} = require("./action-lifecycle");
const {
  normalizeAction,
  actuatorSignature,
  semanticGoalKey
} = require("../../../packages/shared/agent-actions");
const { withUpdate, normalizeStep } = require("../../../packages/shared/agent-state");
const { missingRequired, normalizeRequirement, requirementFulfilled } = require("../../../packages/shared/requirements");
const { currentSurface, currentSurfaceId, surfaceBinding } = require("./surface-contract");
const { compileTypedExpectedOutcome } = require("./action-semantics");
const {
  applyAuthoritativeOutcomeToRequirements,
  contextForPublishedGoal,
  deriveAuthoritativeTaskContext
} = require("./task-action-context");

function isContinueRequirement(req) {
  if (!req) return false;
  return req.type === "continue";
}

function actionableMissingRequired(requirements = []) {
  return missingRequired(requirements).filter((req) => !isContinueRequirement(req));
}

function verifierUpdateForRequirement(verification = {}, requirementId = "") {
  return (verification.requirementUpdates || []).find((update) => update.requirementId === requirementId) || null;
}

function sameNormalizedText(a = "", b = "") {
  const left = normalizeText(a);
  const right = normalizeText(b);
  return Boolean(left && right && (left === right || left.includes(right) || right.includes(left)));
}

function decisionGroupMatchesRequirement(group = {}, requirement = {}) {
  const exactGroupId = String(requirement.decisionGroupId || requirement.scope?.decisionGroupId || "");
  if (exactGroupId) return String(group.decisionGroupId || "") === exactGroupId;
  const exactRequirementId = String(requirement.requirementId || requirement.id || "");
  if (exactRequirementId && (exactRequirementId === group.decisionGroupId || exactRequirementId === group.requirementId)) return true;
  const targetIds = new Set([requirement.id, ...(requirement.targetIds || [])].filter(Boolean));
  if (targetIds.has(group.decisionGroupId) || targetIds.has(group.requirementId)) return true;
  if ((group.alternativeControlIds || []).some((controlId) => targetIds.has(controlId))) return true;
  if ((group.alternatives || []).some((choice) => targetIds.has(choice.controlId) || targetIds.has(choice.targetId))) return true;
  return sameNormalizedText(group.sectionLabel, requirement.label) || sameNormalizedText(group.sectionType, requirement.label) || sameNormalizedText(group.requirementId, requirement.id);
}

function decisionGroupForRequirement(requirement = {}, page = {}) {
  return (page.decisionGroups || []).find((group) => decisionGroupMatchesRequirement(group, requirement)) || null;
}

function decisionGroupRequirementType(group = {}) {
  const text = normalizeText(`${group.requirementId || ""} ${group.sectionType || ""} ${group.sectionLabel || ""}`);
  if (/bag|baggage|luggage/.test(text)) return "baggage_decision";
  if (/seat/.test(text)) return "seat_decision";
  if (/legal|terms|condition|agree/.test(text)) return "legal_acceptance";
  if (/payment|pay|card/.test(text)) return "payment";
  if (/bundle|flexible|ticket|sms|support|insurance|cancellation|protection|extra/.test(text)) return "paid_extra_decision";
  return "unknown";
}

function decisionGroupRisk(group = {}) {
  if (["satisfied", "waived_by_policy"].includes(group.status)) return "safe";
  const alternatives = group.alternatives || [];
  if (alternatives.some((choice) => choice.risk === "payment")) return "payment";
  if (alternatives.some((choice) => choice.risk === "legal")) return "legal";
  if (alternatives.some((choice) => choice.risk === "money" || choice.priceText)) return "money";
  if (alternatives.some((choice) => choice.risk === "uncertain")) return "uncertain";
  return "safe";
}

function requirementFromDecisionGroup(group = {}, index = 0) {
  return normalizeRequirement({
    id: group.decisionGroupId || `decision_group_${index}`,
    decisionGroupId: group.decisionGroupId || "",
    surfaceId: group.surfaceId || "",
    type: decisionGroupRequirementType(group),
    label: group.sectionLabel || group.sectionType || group.requirementId || group.decisionGroupId || `Decision ${index + 1}`,
    status: ["satisfied", "waived_by_policy"].includes(group.status) ? group.status : (group.status || "missing"),
    required: Boolean(group.required),
    risk: decisionGroupRisk(group),
    evidence: [
      ...(group.evidence || []),
      group.selectedLabel ? `Selected option: ${group.selectedLabel}` : ""
    ].filter(Boolean).slice(0, 5),
    confidence: ["satisfied", "waived_by_policy"].includes(group.status) ? 0.95 : 0.9,
    targetIds: [
      group.decisionGroupId,
      group.sectionId,
      group.requirementId,
      ...(group.alternativeControlIds || []),
      ...(group.alternatives || []).flatMap((choice) => [choice.controlId, choice.targetId])
    ].filter(Boolean)
  }, index);
}

function withDecisionGroupFields(requirement = {}, group = {}) {
  return {
    ...requirement,
    decisionGroupId: group.decisionGroupId || "",
    surfaceId: group.surfaceId || "",
    selectedControlId: group.selectedControlId || "",
    selectedLabel: group.selectedLabel || "",
    alternatives: (group.alternatives || []).map((choice) => ({
      controlId: choice.controlId || "",
      targetId: choice.targetId || "",
      label: choice.label || "",
      semantic: choice.semantic || "",
      risk: choice.risk || "",
      selected: Boolean(choice.selected),
      priceText: choice.priceText || ""
    })),
    alternativeControlIds: [...(group.alternativeControlIds || [])]
  };
}

function slugScopePart(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function stableRequirementKey(item = {}) {
  const scope = item.scope || {};
  return [
    item.requirementId || item.id,
    item.semanticType || item.type,
    scope.stage,
    scope.surfaceId,
    scope.decisionGroupId,
    scope.instanceId
  ].map(slugScopePart).filter(Boolean).join(":");
}

function profileWantsDeclineDisposition(traveler = {}) {
  const rules = normalizeText(`${traveler.booking_rules || ""} ${traveler.baggage_preference || ""}`);
  return /no paid|no extras|no add-?ons|no add ons|no seat|no insurance|no bundle|personal item only|avoid paid|no checked|no bag|no baggage/.test(rules);
}

function desiredDispositionForRequirement(requirement = {}, traveler = {}) {
  const text = normalizeText(`${requirement.type || ""} ${requirement.label || ""} ${requirement.risk || ""} ${(requirement.evidence || []).join(" ")}`);
  const alternatives = requirement.alternatives || [];
  const hasPaidAlternative = alternatives.some((choice) => choice.risk === "money" || choice.priceText);
  const selectedDecline = /no thanks|none|without|decline|skip|0\s*(eur|€|usd|\$)/.test(normalizeText(requirement.selectedLabel || ""));
  if ((requirement.risk === "money" || hasPaidAlternative || /paid_extra|seat|baggage|bundle|insurance|support|sms|cancellation|protection/.test(text))
    && profileWantsDeclineDisposition(traveler)) {
    return "decline";
  }
  if (selectedDecline) return "decline";
  if (requirement.type === "legal_acceptance") return "accept_after_user_approval";
  if (requirement.type === "payment") return "payment_authorization_required";
  return "complete";
}

function interfaceStatusForRequirement(requirement = {}) {
  if (requirementFulfilled(requirement)) return "complete";
  if (requirement.status === "conflicted") return "conflicted";
  if (requirement.status === "blocked") return "blocked";
  if (requirement.status === "needs_user") return "needs_user";
  if (requirement.status === "missing") return "pending";
  return "unknown";
}

function lifecycleStatusForRequirement(requirement = {}) {
  if (requirement.status === "waived_by_policy") return "waived_by_policy";
  if (requirement.status === "satisfied") return "satisfied";
  if (requirement.status === "conflicted") return "conflicted";
  if (requirement.status === "blocked") return "blocked";
  if (requirement.status === "needs_user") return "blocked";
  return "active";
}

function currentSurfaceForRequirement(requirement = {}, page = {}) {
  const surface = currentSurface(page);
  if (surface.type === "page") return null;
  if (requirement.surfaceId && requirement.surfaceId !== surface.id) return null;
  if (requirement.decisionGroupId && surface.decisionGroupId && requirement.decisionGroupId !== surface.decisionGroupId) return null;
  return surface;
}

function requirementScope(requirement = {}, observation = {}, pageStep = "") {
  const page = observation?.page || {};
  const surface = currentSurfaceForRequirement(requirement, page);
  const stage = pageStep || page.step || page.pageStep || "unknown";
  return {
    stage,
    surfaceId: surface?.id || "",
    decisionGroupId: requirement.decisionGroupId || "",
    instanceId: surface?.id || requirement.sectionId || requirement.decisionGroupId || requirement.id || ""
  };
}

function canonicalRequirementLifecycle(requirements = [], observation = {}, previousLifecycle = [], traveler = {}, pageStep = "") {
  const previousByKey = new Map((previousLifecycle || []).map((item) => [stableRequirementKey(item), item]));
  const observationId = observation?.observationId || "";
  const lastActionId = observation?.lastAction?.actionId || observation?.lastActionResult?.actionId || "";
  const current = (requirements || []).map((requirement) => {
    const scope = requirementScope(requirement, observation, pageStep);
    const semanticType = requirement.type || "unknown";
    const requirementId = requirement.id || requirement.decisionGroupId || "";
    const desiredDisposition = desiredDispositionForRequirement(requirement, traveler);
    const interfaceStatus = interfaceStatusForRequirement(requirement);
    const lifecycleStatus = lifecycleStatusForRequirement(requirement);
    const candidate = {
      ...requirement,
      id: requirementId,
      requirementId,
      semanticType,
      scope,
      desiredDisposition,
      lifecycleStatus,
      interfaceStatus,
      createdObservationId: observationId,
      lastObservedObservationId: observationId,
      observationId,
      resolvedByActionId: ["satisfied", "waived_by_policy"].includes(lifecycleStatus) ? lastActionId : "",
      value: requirement.selectedLabel || requirement.value || "",
      stale: false
    };
    const previous = previousByKey.get(stableRequirementKey(candidate));
    if (previous) {
      candidate.createdObservationId = previous.createdObservationId || candidate.createdObservationId;
      candidate.resolvedByActionId = candidate.resolvedByActionId || previous.resolvedByActionId || "";
    }
    return candidate;
  });
  const currentKeys = new Set(current.map(stableRequirementKey));
  const stalePrevious = (previousLifecycle || [])
    .filter((item) => !currentKeys.has(stableRequirementKey(item)) && item.lifecycleStatus !== "stale")
    .map((item) => ({
      ...item,
      lifecycleStatus: "stale",
      interfaceStatus: "stale",
      status: "satisfied",
      required: false,
      stale: true,
      lastObservedObservationId: observationId || item.lastObservedObservationId || "",
      evidence: [
        "STALE_REQUIREMENT_SCOPE: requirement left the active observation scope.",
        ...(item.evidence || [])
      ].slice(0, 5)
    }));
  return [...current, ...stalePrevious];
}

function activeRequirementView(lifecycle = []) {
  return (lifecycle || []).filter((item) => item.lifecycleStatus !== "stale");
}

function exactDecisionCompletionRecords(previous = [], lifecycle = [], observationId = "") {
  const byIdentity = new Map((previous || []).map((record) => [
    `${record.surfaceId || ""}:${record.decisionGroupId || ""}:${record.requirementId || ""}`,
    record
  ]));
  for (const requirement of lifecycle || []) {
    if (!requirement.decisionGroupId || !["satisfied", "waived_by_policy"].includes(requirement.lifecycleStatus || requirement.status)) continue;
    const record = {
      surfaceId: requirement.surfaceId || requirement.scope?.surfaceId || "surface-page",
      decisionGroupId: requirement.decisionGroupId,
      requirementId: requirement.requirementId || requirement.id || requirement.decisionGroupId,
      selectedControlId: requirement.selectedControlId || "",
      status: requirement.lifecycleStatus || requirement.status,
      observationId: requirement.lastObservedObservationId || requirement.observationId || observationId || ""
    };
    byIdentity.set(`${record.surfaceId}:${record.decisionGroupId}:${record.requirementId}`, record);
  }
  return [...byIdentity.values()].slice(-120);
}

function requirementsWithDecisionGroups(classifiedRequirements = [], observation = {}) {
  const page = observation?.page || {};
  const groups = page.decisionGroups || [];
  const choiceRequirement = (requirement = {}) => /decision|legal_acceptance/.test(requirement.type || requirement.semanticType || "");
  const withoutCanonicalGroup = (requirement = {}) => choiceRequirement(requirement)
    ? {
        ...requirement,
        status: "conflicted",
        required: true,
        confidence: 0,
        evidence: [
          "CANONICAL_DECISION_GROUP_MISSING: choice completion cannot be derived without an observed decision group.",
          ...(requirement.evidence || [])
        ].slice(0, 5)
      }
    : requirement;
  if (!groups.length) return (classifiedRequirements || []).map(withoutCanonicalGroup);

  const groupRequirements = groups.map((group, index) =>
    withDecisionGroupFields(requirementFromDecisionGroup(group, index), group)
  );
  const groupedIds = new Set(groupRequirements.map((req) => req.id).filter(Boolean));
  const filteredClassified = (classifiedRequirements || []).flatMap((requirement) => {
    const group = decisionGroupForRequirement(requirement, page);
    if (!group?.decisionGroupId) {
      const persistedExactGroup = Boolean(
        requirement.decisionGroupId
        && (requirement.scope || requirement.lifecycleStatus || requirement.observationId)
      );
      // A lifecycle-owned exact group that is absent from the fresh canonical
      // registry has left the active observation scope. Do not revive it as a
      // current conflict; canonicalRequirementLifecycle retains it as stale.
      if (persistedExactGroup) return [];
      return [withoutCanonicalGroup(requirement)];
    }
    // Choice-like requirements are represented by the canonical group. Field,
    // payment, and unrelated requirements remain separate.
    if (/decision|legal_acceptance|unknown/.test(requirement.type || "")) return [];
    return groupedIds.has(requirement.id) ? [] : [requirement];
  });

  return [...filteredClassified, ...groupRequirements];
}

function controlDecisionGroupId(controlId = "", page = {}) {
  if (!controlId) return "";
  const control = buildControlAliasIndex(page).resolve(controlId);
  if (control?.decisionGroupId) return control.decisionGroupId;
  const group = (page.decisionGroups || []).find((item) =>
    (item.alternatives || []).some((choice) => choice.controlId === controlId || choice.targetId === controlId)
  );
  return group?.decisionGroupId || "";
}

function updateEvidenceMatchesRequirement(update = {}, requirement = {}, observation = {}) {
  const page = observation?.page || {};
  const requirementGroup = decisionGroupForRequirement(requirement, page);
  const requirementGroupId = String(
    requirement.decisionGroupId
    || requirement.scope?.decisionGroupId
    || requirementGroup?.decisionGroupId
    || ""
  );
  const choiceRequirement = /decision|legal_acceptance/.test(requirement.type || requirement.semanticType || "");
  if (choiceRequirement && !requirementGroupId) return false;
  if (!requirementGroupId) return true;
  const evidenceControlId = String(update?.evidence?.controlId || "");
  const evidenceGroupId = String(update?.evidence?.decisionGroupId || "") || controlDecisionGroupId(evidenceControlId, page);
  return Boolean(evidenceControlId && evidenceGroupId === requirementGroupId);
}

function deterministicRequirementEvidence(requirement = {}, observation = {}) {
  const page = observation?.page || {};
  const targetIds = new Set([requirement.id, ...(requirement.targetIds || [])].filter(Boolean));
  const fields = Array.isArray(page.fields) && page.fields.length
    ? page.fields
    : (page.controls || []).filter((control) => control.field).map((control) => ({
        ...control,
        id: control.stateElementId || control.controlId,
        hasValue: Boolean(control.hasValue || control.state?.valuePresent)
      }));

  const decisionGroup = decisionGroupForRequirement(requirement, page);
  if (decisionGroup) {
    return {
      source: "deterministic_decision_group",
      status: ["satisfied", "waived_by_policy"].includes(decisionGroup.status) ? decisionGroup.status : "missing",
      evidence: decisionGroup.selectedLabel
        ? `Decision ${decisionGroup.sectionLabel || decisionGroup.decisionGroupId} selected ${decisionGroup.selectedLabel}.`
        : `Decision ${decisionGroup.sectionLabel || decisionGroup.decisionGroupId} has no selected option.`
    };
  }

  const field = fields.find((item) => targetIds.has(item.id));
  if (field && /field/.test(requirement.type || "")) {
    return {
      source: "deterministic_field",
      status: field.hasValue ? "satisfied" : "missing",
      evidence: field.hasValue ? `Field ${field.label || field.id} has a value.` : `Field ${field.label || field.id} is empty.`
    };
  }

  return null;
}

function updateHasCurrentEvidence(update = {}, observation = {}, requirement = {}) {
  if (!update || update.proposedStatus !== "satisfied") return false;
  const currentObservationId = String(observation?.observationId || "");
  const updateObservationId = String(update.observationId || "");
  if (currentObservationId && updateObservationId && currentObservationId !== updateObservationId) return false;
  if (Number(update.confidence || 0) < 0.75) return false;
  if (!updateEvidenceMatchesRequirement(update, requirement, observation)) return false;
  const evidence = update.evidence || {};
  return Boolean(evidence.controlId || evidence.selectedValue || evidence.visibleText);
}

function requirementConflict(requirement = {}, verification = {}, observation = {}) {
  if (!requirement || requirementFulfilled(requirement)) return false;
  const update = verifierUpdateForRequirement(verification, requirement.id);
  const verifierClaimsSatisfied = update?.proposedStatus === "satisfied";
  if (!verifierClaimsSatisfied) return false;
  return !updateHasCurrentEvidence(update, observation, requirement);
}

function reconcileRequirements(freshRequirements = [], verification = {}, observation = {}) {
  return freshRequirements.map((requirement) => {
    const deterministic = deterministicRequirementEvidence(requirement, observation);
    if (deterministic && deterministic.status !== "unknown") {
      return {
        ...requirement,
        status: deterministic.status,
        evidence: [
          deterministic.evidence,
          ...(requirement.evidence || [])
        ].filter(Boolean).slice(0, 5),
        confidence: Math.max(requirement.confidence || 0, 0.9)
      };
    }

    // Model verification is diagnostic only. Requirement truth comes from the
    // fresh observer/classifier and deterministic browser evidence.
    return requirement;
  });
}

function finalHandoffAction(reason, observation = {}, overrides = {}) {
  return normalizeAction({
    ...overrides,
    observationId: overrides.observationId || observation.observationId || "",
    observationHash: overrides.observationHash || observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
    type: "ask_user",
    intent: "ask_user",
    reason: String(reason || overrides.reason || "User input is required before another action."),
    risk: overrides.risk || "uncertain",
    requiresApproval: true
  });
}

function policyBlockedAction(governance, action) {
  if (governance.allow) return action;
  const reason = governance.reason || action.reason || "The action governor blocked the planned action.";
  return finalHandoffAction(reason, {}, {
    id: `${action.id || `act_${Date.now().toString(36)}`}:blocked`,
    observationId: action.observationId || "",
    observationHash: action.observationHash || "",
  });
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
    skillPlanId: blockedAction.skillPlanId || "",
    skillAtomId: blockedAction.skillAtomId || "",
    controlId: blockedAction.controlId || blockedAction.targetSnapshot?.controlId || "",
    targetId: blockedAction.targetId || blockedAction.targetSnapshot?.id || "",
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
  return pendingActionRecord({
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
  const direct = bindTargetSnapshot(normalizeAction({
    ...original,
    id: `act_rebind_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    observationId: observation.observationId || "",
    observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
    targetId: original.controlId || original.targetId || "",
    targetSnapshot: null,
    expectedOutcome: null,
    reason: `Rebound pending governed action after viewport recovery: ${original.reason || original.intent || original.type || "action"}.`
  }), observation);
  if (!pending.semanticGoal?.goalId) {
    return { action: direct, candidateSet: null, candidate: pending.candidate || null };
  }

  const reboundSet = buildCurrentCandidateSet({
    goal: pending.semanticGoal,
    observation,
    traveler,
    state,
    approvals: state.approvals,
    attemptedCandidateIds: [],
    attemptedStrategySignatures: []
  });
  const previous = pending.candidate || {};
  const previousStableKey = previous.affordance?.stableKey || previous.stableKey || "";
  const reboundCandidate = (reboundSet.candidates || []).find((candidate) => (
    previousStableKey
      && (candidate.affordance?.stableKey || candidate.stableKey || "") === previousStableKey
      && candidate.operation === previous.operation
  )) || ((reboundSet.candidates || []).length === 1 ? reboundSet.candidates[0] : null);
  if (!reboundCandidate) return { action: direct, candidateSet: reboundSet, candidate: null };
  const action = bindTargetSnapshot(normalizeAction({
    ...actionForCurrentCandidate(pending.semanticGoal, reboundCandidate, observation),
    id: `act_rebind_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    reason: `Rebound the same semantic action to the fresh canonical control after viewport recovery: ${original.reason || original.intent || original.type || "action"}.`
  }), observation);
  return { action, candidateSet: reboundSet, candidate: reboundCandidate };
}

function pendingRecoveryTargetStatus(action = {}) {
  const target = action.targetSnapshot || null;
  const region = target?.visualRegion || target?.box || null;
  return {
    exists: Boolean(target?.id && target?.controlId),
    inViewport: region?.inViewport === true
  };
}

function summarizeTurn({ pageState, requirements, plannedAction, finalAction, policyDecision, deterministicAction }) {
  return {
    planned: {
      type: plannedAction?.type || "",
      label: plannedAction?.targetLabel || plannedAction?.value || plannedAction?.targetId || "",
      risk: plannedAction?.risk || "",
      reason: plannedAction?.reason || ""
    },
    final: {
      type: finalAction?.type || "",
      label: finalAction?.targetLabel || finalAction?.value || finalAction?.targetId || "",
      risk: finalAction?.risk || "",
      reason: finalAction?.reason || ""
    },
    policy: policyDecision ? {
      allow: policyDecision.allow,
      decision: policyDecision.decision,
      reason: policyDecision.reason
    } : null,
    deterministic: Boolean(deterministicAction),
    missing: actionableMissingRequired(requirements).slice(0, 6).map((req) => ({
      id: req.id,
      type: req.type,
      label: req.label,
      status: req.status,
      risk: req.risk
    })),
    navigation: (pageState?.navigationActions || []).slice(0, 8).map((nav) => ({
      action: nav.action,
      label: nav.label,
      enabled: nav.enabled,
      risk: nav.risk,
      targetId: nav.targetId
    })),
    riskGates: (pageState?.riskGates || []).slice(0, 6).map((gate) => ({
      type: gate.type,
      label: gate.label,
      status: gate.status,
      risk: gate.risk
    })),
    currentSurface: pageState?.currentSurface || null
  };
}

function parsePriceAmount(priceText = "") {
  const match = String(priceText).match(/([0-9]+(?:[.,][0-9]{1,2})?)/);
  if (!match) return null;
  return Number(match[1].replace(",", "."));
}

function toClientDecision(action) {
  // Bridge back to the shape the (unmodified) extension executor expects.
  return {
    source: "agent-loop",
    actionId: action.id || "",
    observationId: action.observationId || "",
    observationHash: action.observationHash || "",
    action: action.type,
    intent: action.intent || "",
    operation: action.operation || "",
    interactionRole: action.interactionRole || "",
    semanticEffect: action.semanticEffect || "",
    expectedEvidence: action.expectedEvidence || "",
    goalId: action.goalId || "",
    candidateId: action.candidateId || "",
    skillPlanId: action.skillPlanId || "",
    skillAtomId: action.skillAtomId || "",
    requirementId: action.requirementId || "",
    controlId: action.controlId || action.targetSnapshot?.controlId || "",
    targetId: action.targetId || "",
    targetLabel: action.targetLabel || "",
    targetSnapshot: action.targetSnapshot || null,
    decisionGroupId: action.decisionGroupId || action.targetSnapshot?.decisionGroupId || "",
    expectedOutcome: action.expectedOutcome || null,
    affordance: action.affordance || null,
    value: action.value || action.targetLabel || "",
    x: action.x,
    y: action.y,
    visualRegion: action.visualRegion || null,
    scrollY: action.scrollY,
    keys: action.keys || "",
    message: action.reason || "Working on the next step.",
    needsApproval: action.requiresApproval,
    risk: action.risk,
    reason: action.reason
  };
}

function normalizeText(value = "") {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function targetCandidateSnapshot(candidate = {}, source = "", surface = {}) {
  if (!candidate) return null;
  return {
    id: String(candidate.id || ""),
    controlId: String(candidate.controlId || ""),
    stableKey: String(candidate.stableKey || ""),
    meaning: String(candidate.meaning || candidate.semantic || candidate.label || ""),
    structuredPrice: candidate.structuredPrice || null,
    visualRef: String(candidate.visualRef || ""),
    decisionGroupId: String(candidate.decisionGroupId || ""),
    label: String(candidate.label || ""),
    normalizedLabel: normalizeText(candidate.label || ""),
    role: String(candidate.role || ""),
    domRole: String(candidate.domRole || ""),
    accessibleName: String(candidate.accessibility?.name || candidate.accessibleName || ""),
    accessibilityState: candidate.accessibility?.state || null,
    risk: String(candidate.risk || ""),
    semantic: String(candidate.semantic || ""),
    kind: String(candidate.kind || candidate.field || candidate.type || ""),
    controlKind: String(candidate.controlKind || candidate.kind || candidate.field || candidate.type || ""),
    state: candidate.controlState || candidate.state || null,
    currentValue: String(candidate.currentValue || candidate.controlState?.normalizedValue || candidate.state?.normalizedValue || ""),
    capabilities: Array.isArray(candidate.capabilities) ? candidate.capabilities.slice(0, 12) : [],
    selected: Boolean(candidate.selected),
    required: Boolean(candidate.required),
    hasValue: Boolean(candidate.hasValue || candidate.value),
    box: candidate.box || null,
    visualRegion: candidate.visualRegion || candidate.box || null,
    stateElementId: String(candidate.stateElementId || ""),
    preferredActivationElementId: String(candidate.preferredActivationElementId || ""),
    actuators: Array.isArray(candidate.actuators) ? candidate.actuators.slice(0, 10) : [],
    operations: candidate.operations && typeof candidate.operations === "object" ? candidate.operations : {},
    recovery: candidate.recovery && typeof candidate.recovery === "object" ? candidate.recovery : {},
    visualRegions: Array.isArray(candidate.visualRegions) ? candidate.visualRegions.slice(0, 12) : [],
    source,
    surfaceId: String(surface?.id || ""),
    surfaceType: String(surface?.type || "page"),
    surfaceLabel: String(surface?.label || "").slice(0, 500),
    surfaceNormalizedLabel: normalizeText(surface?.label || "").slice(0, 500),
    sectionId: String(surface?.sectionId || surface?.id || ""),
    sectionType: String(surface?.sectionType || surface?.type || ""),
    sectionLabel: String(surface?.sectionLabel || surface?.label || "").slice(0, 300)
  };
}

function targetSnapshotForAction(action = {}, page = {}) {
  if (!["click", "click_xy", "select", "type", "keypress"].includes(action.type)) return null;
  const resolution = resolveActionControl(action, page);
  if (action.type === "click_xy" && resolution.ok) {
    const control = resolution.control;
    const region = action.visualRegion || {};
    return {
      ...targetCandidateSnapshot({
        ...control,
        id: "",
        label: control.label || action.targetLabel || control.semantic || "visual control recovery",
        box: region,
        visualRegion: region,
        controlState: control.state || null
      }, "visual_control_recovery", {
        type: control.surfaceType || "page",
        id: control.surfaceId || "",
        label: control.surfaceLabel || control.sectionLabel || ""
      }),
      recoveryOperation: action.operation || "",
      skillPlanId: action.skillPlanId || "",
      skillAtomId: action.skillAtomId || ""
    };
  }
  if (resolution.ok) {
    const control = resolution.control;
    const annotation = (page.screenshotAnnotations || []).find((item) => item.controlId === control.controlId) || null;
    const capability = action.operation ? control.operations?.[action.operation] : null;
    const operationIds = capability?.actuatorIds || [];
    const requestedMemberId = [control.stateElementId, control.preferredActivationElementId, ...(control.actuators || []).map((item) => item.nodeId), ...operationIds]
      .includes(action.targetId) ? action.targetId : "";
    const operationTargetId = capability
      ? (requestedMemberId && operationIds.includes(requestedMemberId) ? requestedMemberId : capability.actuatorId || operationIds[0])
      : ["type", "select"].includes(action.type)
        ? control.stateElementId
        : requestedMemberId || control.preferredActivationElementId || control.stateElementId;
    return targetCandidateSnapshot({
      ...control,
      id: operationTargetId || control.controlId,
      visualRef: control.visualRef || annotation?.visualRef || "",
      label: control.label || control.accessibleName || control.controlId,
      kind: control.kind || "control",
      box: control.visualRegion || annotation?.box || null,
      controlState: control.state || null
    }, "canonical_alias_index", {
      type: control.surfaceType || "page",
      id: control.surfaceId || "",
      label: control.surfaceLabel || control.sectionLabel || "",
      sectionId: control.sectionId || "",
      sectionType: control.sectionType || "",
      sectionLabel: control.sectionLabel || ""
    });
  }
  return (!resolution.aliasIds.length && action.x != null && action.y != null) ? {
    id: "",
    label: action.targetLabel || action.value || "",
    normalizedLabel: normalizeText(action.targetLabel || action.value || ""),
    box: action.visualRegion ? {
      ...action.visualRegion,
      centerX: Number(action.visualRegion.x || 0) + Number(action.visualRegion.width || 0) / 2,
      centerY: Number(action.visualRegion.y || 0) + Number(action.visualRegion.height || 0) / 2,
      inViewport: true
    } : null,
    visualRegion: action.visualRegion || null,
    source: "visual_fallback",
    surfaceId: action.visualRegion?.surfaceId || currentSurfaceId(page),
    surfaceType: currentSurface(page).type,
    surfaceLabel: currentSurface(page).label,
    surfaceNormalizedLabel: normalizeText(currentSurface(page).label)
  } : null;
}

function bindTargetSnapshot(action = {}, observation = {}) {
  if (!action) return action;
  const targetSnapshot = targetSnapshotForAction(action, observation.page || {});
  const bound = normalizeAction({
    ...action,
    observationId: action.observationId || observation.observationId || "",
    observationHash: action.observationHash || observation.observationSnapshot?.snapshotHash || "",
    controlId: targetSnapshot?.controlId || action.controlId || "",
    decisionGroupId: targetSnapshot?.decisionGroupId || action.decisionGroupId || "",
    targetId: targetSnapshot?.id || action.targetId || "",
    targetSnapshot: targetSnapshot || null
  });
  return withActionContract(bound, observation.page || {});
}

function observationSurfaceId(observation = {}) {
  return currentSurfaceId(observation.page || {});
}

function candidateStrategySignature(goal = {}, candidate = {}) {
  return actuatorSignature(candidate);
}

function semanticGoalRecoveryKey(goal = {}) {
  return semanticGoalKey(goal);
}

function failedStrategySignaturesForGoal(state = {}, goal = {}) {
  const goalKey = semanticGoalRecoveryKey(goal);
  return (state.failedStrategyMemory || [])
    .filter((entry) => entry.goalKey === goalKey)
    .map((entry) => entry.strategySignature)
    .filter(Boolean);
}

function groundedObservationCandidateSet(goal = {}, observation = {}, attemptedStrategySignatures = [], context = {}) {
  const binding = surfaceBinding(observation);
  const built = buildCurrentCandidateSet({
    goal,
    observation,
    state: context.state || {},
    traveler: context.traveler || {},
    approvals: context.approvals || {},
    attemptedStrategySignatures
  });
  const candidates = built.candidates.map((candidate) => {
    const bound = bindTargetSnapshot(actionForCurrentCandidate(goal, candidate, observation), observation);
    return {
      ...candidate,
      type: bound.type,
      intent: bound.intent,
      operation: bound.operation,
      interactionRole: bound.interactionRole,
      semanticEffect: bound.semanticEffect,
      expectedEvidence: bound.expectedEvidence,
      controlId: bound.controlId,
      decisionGroupId: bound.decisionGroupId,
      targetId: bound.targetId,
      targetLabel: bound.targetLabel,
      value: bound.value,
      keys: bound.keys,
      requirementId: bound.requirementId,
      expectedOutcome: bound.expectedOutcome,
      affordance: bound.affordance,
      risk: bound.risk,
      requiresApproval: bound.requiresApproval
    };
  }).filter((candidate) => (
    !["click", "type", "select", "keypress", "click_xy"].includes(candidate.type)
    || Boolean(candidate.controlId && candidate.targetId && candidate.expectedOutcome)
  ));
  return { ...binding, candidates, excludedCandidates: built.excludedCandidates || [] };
}

function groundedObservationCandidates(goal = {}, observation = {}) {
  return groundedObservationCandidateSet(goal, observation).candidates;
}

function deterministicTaskCandidate(candidateSet = {}) {
  const candidates = candidateSet.candidates || [];
  if (candidates.length !== 1) return null;
  const candidate = candidates[0];
  if (["ask_user", "final_review"].includes(candidate.type)) return candidate;
  const executable = ["click", "type", "select", "keypress", "scroll", "click_xy"].includes(candidate.type);
  if (!executable
    || candidate.requiresJudgment
    || candidate.requiresApproval
    || candidate.risk !== "safe"
    || candidate.policyDecision?.allow !== true
    || candidate.affordance?.actuator?.proven !== true) return null;
  return candidate;
}

function deterministicSafeForwardCandidate(candidateSet = {}) {
  const candidates = (candidateSet.candidates || []).filter((candidate) => {
    const executable = ["click", "keypress", "scroll"].includes(candidate.type);
    return executable
      && candidate.interactionRole === "navigation"
      && candidate.semanticEffect === "advance"
      && candidate.expectedEvidence === "progress_changed"
      && !candidate.requiresJudgment
      && !candidate.requiresApproval
      && candidate.risk === "safe"
      && candidate.policyDecision?.allow === true
      && candidate.affordance?.actuator?.proven === true;
  });
  return candidates.length === 1 ? candidates[0] : null;
}

function deterministicTransitionVerification(transition = null) {
  const achieved = transition?.status === "achieved";
  const changed = Boolean(transition && ["achieved", "progressed", "blocked"].includes(transition.status));
  return {
    ok: achieved,
    changed,
    lastActionWorked: achieved,
    blockers: transition?.status === "blocked" ? [transition.blocker?.label || "A new blocker appeared."] : [],
    priceChanged: Boolean(transition?.diff?.priceChanged),
    riskChanged: transition?.status === "unsafe",
    evidence: transition ? [`Browser transition: ${transition.status}.`] : [],
    confidence: transition ? 1 : 0,
    requirementUpdates: []
  };
}

function applyTransitionStatus(state = {}, observation = {}, previousObservation = null) {
  const advanced = advanceActionLifecycle({ state, observation, previousObservation });
  const transition = advanced.transition;
  if (!advanced.lifecycle) return { ...advanced, transition: null };
  const pending = normalizePendingAction(state.pendingAction);
  const governedAction = state.lastAction?.id === advanced.lifecycle.actionId
    ? state.lastAction
    : pending?.originalAction || observation.lastActionResult?.action || {};
  const signature = candidateStrategySignature(state.currentGoal || {}, governedAction);
  const goalKey = semanticGoalRecoveryKey(state.currentGoal || {});
  const failedStrategyMemory = [...(state.failedStrategyMemory || [])];
  if (transition?.status === "no_effect" && governedAction.type !== "scroll" && governedAction.controlId && signature) {
    const affordance = governedAction.affordance || {};
    const entry = {
      goalKey,
      strategySignature: signature,
      stableControlKey: affordance.stableKey || governedAction.controlId || "",
      capability: governedAction.operation || governedAction.type || "",
      semanticEffect: affordance.effect || governedAction.semanticEffect || "",
      observationId: observation.observationId || ""
    };
    if (!failedStrategyMemory.some((item) => item.goalKey === goalKey && item.strategySignature === signature)) {
      failedStrategyMemory.push(entry);
    }
  }
  const rememberedForGoal = failedStrategyMemory
    .filter((entry) => entry.goalKey === goalKey)
    .map((entry) => entry.strategySignature)
    .filter(Boolean);
  const attemptedStrategySignatures = [...new Set(rememberedForGoal)].slice(-12);
  return {
    ...advanced,
    state: withUpdate(advanced.state, {
      lastTransition: transition || state.lastTransition || null,
      attemptedStrategySignatures,
      failedStrategyMemory: failedStrategyMemory.slice(-80)
    }),
    transition: transition || null
  };
}

function inferActionIntent(action = {}) {
  const target = action.targetSnapshot || {};
  if (action.type === "fill_known_fields" || action.type === "fill_visible_profile_fields") return "fill_profile_fields";
  if (action.type === "type" || action.type === "select") return "satisfy_field";
  if (action.type === "scroll" || action.type === "wait") return action.type;
  if (action.type === "ask_user" || action.type === "stop" || action.type === "final_review") return action.type;
  if (["decline_paid_extra", "decline_baggage", "safe_decline"].includes(target.semantic) || target.risk === "safe_decline") return "decline_optional_extra";
  if (target.semantic === "open_choice_control") return "open_choice_control";
  if (target.semantic === "continue" || target.risk === "safe_continue") return "navigate_stage";
  if (target.surfaceType && target.surfaceType !== "page") return "resolve_active_surface";
  if (target.kind === "choice" || /radio|checkbox|option/.test(target.kind || "")) return "choose_option";
  return action.type;
}

function activeForegroundSurface(page = {}, target = {}) {
  const candidate = currentSurface(page);
  const surface = candidate.type !== "page" ? candidate : null;
  if (!surface) return null;
  if (target.surfaceId && surface.id && target.surfaceId !== surface.id) return null;
  return surface;
}

function shouldRequireSurfaceDismissal(action = {}, page = {}) {
  const target = action.targetSnapshot || {};
  if (action.intent !== "decline_optional_extra") return false;
  const choiceSurface = /dropdown|listbox|popover|menu/.test(String(target.surfaceType || "").toLowerCase());
  const choiceSelection = Boolean(
    /choice|radio|checkbox|option/.test(String(target.kind || target.role || "").toLowerCase())
    || (choiceSurface && (action.decisionGroupId || target.decisionGroupId))
  );
  if (choiceSelection) return false;
  const targetSurfaceType = target.surfaceType || "";
  const actionSurface = targetSurfaceType && targetSurfaceType !== "page";
  const foreground = activeForegroundSurface(page, target);
  return Boolean(actionSurface || foreground);
}

function foregroundDismissedOutcome(action = {}, page = {}) {
  const target = action.targetSnapshot || {};
  const surface = activeForegroundSurface(page, target) || {};
  return {
    type: "active_surface_dismissed",
    targetId: action.targetId || target.id || "",
    decisionGroupId: action.decisionGroupId || target.decisionGroupId || "",
    sectionId: target.sectionId || "",
    sectionType: target.sectionType || "",
    sectionLabel: target.sectionLabel || "",
    surfaceId: surface.id || target.surfaceId || "",
    surfaceType: surface.type || target.surfaceType || "",
    surfaceLabel: surface.label || target.surfaceLabel || "",
    surfaceSignature: surface.signature || "",
    intent: action.intent || "",
    mustNotIncreasePrice: true
  };
}

function expectedOutcomeForAction(action = {}, page = {}) {
  const target = action.targetSnapshot || {};
  const foreground = activeForegroundSurface(page, target);
  if (action.interactionRole) return compileTypedExpectedOutcome(action, page);
  if (shouldRequireSurfaceDismissal(action, page)) {
    return foregroundDismissedOutcome(action, page);
  }
  if (action.expectedOutcome) return action.expectedOutcome;
  if (action.type === "type" || action.type === "select") {
    return {
      type: "field_value_changed",
      targetId: action.targetId || target.id || "",
      controlId: action.controlId || target.controlId || "",
      decisionGroupId: action.decisionGroupId || target.decisionGroupId || "",
      expectedValue: action.value || "",
      surfaceId: target.surfaceId || "",
      intent: action.intent || "satisfy_field"
    };
  }
  if (action.type === "click" && action.intent === "satisfy_field") {
    return {
      type: "control_selected",
      targetId: action.targetId || target.id || "",
      controlId: action.controlId || target.controlId || "",
      decisionGroupId: action.decisionGroupId || target.decisionGroupId || "",
      surfaceId: target.surfaceId || "",
      intent: action.intent
    };
  }
  if (action.intent === "decline_optional_extra") {
    // A decline intent is not a proof type. A radio/option must prove its exact
    // selection, a Skip command must prove acknowledgement/waiver, and a Next
    // control must prove progress. Derive that contract from the observed
    // control and operation instead of forcing every decline into a choice.
    return compileTypedExpectedOutcome({ ...action, expectedOutcome: null }, page);
  }
  if (action.intent === "open_choice_control") {
    return {
      type: "options_surface_appeared",
      targetId: action.targetId || target.id || "",
      controlId: action.controlId || target.controlId || "",
      decisionGroupId: action.decisionGroupId || target.decisionGroupId || "",
      sectionId: target.sectionId || "",
      sectionType: target.sectionType || "",
      sectionLabel: target.sectionLabel || "",
      surfaceId: target.surfaceId || "",
      previousSurfaceId: foreground?.id || "",
      intent: action.intent,
      mustNotIncreasePrice: true
    };
  }
  if (action.intent === "navigate_stage") {
    return {
      type: "stage_exit_or_feedback",
      targetId: action.targetId || target.id || "",
      controlId: action.controlId || target.controlId || "",
      decisionGroupId: action.decisionGroupId || target.decisionGroupId || "",
      surfaceId: target.surfaceId || "",
      intent: action.intent,
      mustNotIncreasePrice: true
    };
  }
  if (action.requirementId) {
    return {
      type: "requirement_status",
      requirementId: action.requirementId,
      status: "satisfied",
      targetId: action.targetId || target.id || "",
      decisionGroupId: action.decisionGroupId || target.decisionGroupId || "",
      sectionId: target.sectionId || "",
      sectionType: target.sectionType || "",
      sectionLabel: target.sectionLabel || "",
      surfaceId: target.surfaceId || "",
      intent: action.intent || ""
    };
  }
  if (["click", "click_xy", "keypress"].includes(action.type)) {
    return {
      type: "observable_change",
      targetId: action.targetId || target.id || "",
      controlId: action.controlId || target.controlId || "",
      decisionGroupId: action.decisionGroupId || target.decisionGroupId || "",
      surfaceId: target.surfaceId || "",
      intent: action.intent || ""
    };
  }
  return null;
}

function withActionContract(action = {}, page = {}) {
  const intent = action.intent || inferActionIntent(action);
  return normalizeAction({
    ...action,
    intent,
    expectedOutcome: expectedOutcomeForAction({ ...action, intent }, page)
  });
}

function modelUsageFromMetas(model, metas = []) {
  const calls = metas.filter(Boolean).map((meta) => ({
    schemaName: meta.schemaName || "",
    model: meta.model || model || "",
    duration_ms: Number(meta.durationMs || 0),
    attempts: Number(meta.attempts || 0),
    input_tokens: Number(meta.input_tokens || 0),
    output_tokens: Number(meta.output_tokens || 0),
    total_tokens: Number(meta.total_tokens || 0)
  }));
  return {
    model: calls.find((call) => call.model)?.model || model || "",
    input_tokens: calls.reduce((sum, call) => sum + call.input_tokens, 0),
    output_tokens: calls.reduce((sum, call) => sum + call.output_tokens, 0),
    total_tokens: calls.reduce((sum, call) => sum + call.total_tokens, 0),
    calls
  };
}

function withLatencyDebug(debug = {}, latency = {}, modelUsage = {}) {
  return {
    ...debug,
    latency,
    modelUsage
  };
}

function safePlannerFailureResult({ dataDir, state, turnId, screenshotDataUrl, traceObservation, reason, error = null, latency = {}, modelUsage = {} }) {
  const failureAction = finalHandoffAction(reason, traceObservation || {});
  const nextState = withUpdate(state, {
    lastAction: failureAction,
    status: "awaiting_user"
  });
  const debug = {
    fallback: false,
    planned: null,
    final: {
      type: failureAction.type,
      label: "",
      risk: failureAction.risk,
      reason: failureAction.reason
    },
    policy: { allow: false, decision: "ask_user", reason },
    deterministic: false,
    missing: [],
    navigation: [],
    riskGates: [],
    error: error?.message || (error ? String(error) : "")
  };
  const debugWithLatency = withLatencyDebug(debug, latency, modelUsage);
  writeTrace(dataDir, state.id, {
    turnId,
    screenshotDataUrl,
    observation: traceObservation,
    pageState: null,
    requirements: state.requirements || [],
    verification: null,
    plannedAction: null,
    policyDecision: debug.policy,
    executionResult: { stopped: true, reason, error: debug.error },
    debug: debugWithLatency
  });
  return {
    state: nextState,
    clientDecision: toClientDecision(failureAction),
    debug: debugWithLatency
  };
}

function plannerFailureReason(error) {
  const message = String(error?.message || error || "");
  if (/returned no output text|invalid JSON after retry/i.test(message)) {
    return "AI planner returned no usable candidate selection after a bounded retry.";
  }
  return "AI planner or model API unavailable while choosing between multiple current candidates.";
}

function browserDispatched(result = {}) {
  return wasDispatched(result);
}

const STALE_IDENTITY_CODES = new Set([
  "CANONICAL_ALIAS_UNRESOLVED",
  "CANONICAL_ALIAS_CONFLICT",
  "STALE_OBSERVATION",
  "OBSERVATION_HASH_MISMATCH",
  "PAGE_CHANGED_BEFORE_ACTION",
  "TARGET_OBSERVATION_DRIFT",
  "TARGET_DISAPPEARED",
  "PLANNER_CANDIDATE_NOT_CURRENT",
  ...RECOVERABLE_GROUNDING_CODES
]);

function actionResultCode(result = {}) {
  return canonicalFailureCode(result);
}

function staleIdentityRejection(result = {}) {
  return STALE_IDENTITY_CODES.has(actionResultCode(result));
}

function compactCurrentObservation(observation = {}) {
  return {
    observationId: observation.observationId || "",
    observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
    step: observation.page?.step || "",
    url: observation.page?.url || "",
    capturedAt: new Date().toISOString()
  };
}

function reconcileSemanticGoalState(state = {}, observation = {}, traveler = {}) {
  let currentGoal = state.currentGoal || null;
  let pendingAction = normalizePendingAction(state.pendingAction);
  let attemptedCandidateIds = [...(state.attemptedCandidateIds || [])];
  let verifiedResults = [...(state.verifiedResults || [])];
  const result = observation.lastActionResult || {};

  if (pendingAction?.originalAction?.id && result.actionId === pendingAction.originalAction.id) {
    if (browserDispatched(result) && pendingAction.candidateId) {
      attemptedCandidateIds = [...new Set([
        ...attemptedCandidateIds,
        pendingAction.candidateStableKey || pendingAction.candidateId
      ])];
    }
    if (browserDispatched(result)) {
      verifiedResults = [...verifiedResults, {
        goalId: pendingAction.semanticGoalId || currentGoal?.goalId || "",
        candidateId: pendingAction.candidateId || "",
        actionId: result.actionId || "",
        observationId: observation.observationId || "",
        dispatched: true,
        browserVerified: result.verified === true,
        postconditionSatisfied: result.postconditionSatisfied === true,
        outcomeCode: result.outcome?.code || result.failureCode || "",
        at: new Date().toISOString()
      }].slice(-40);
    }
    pendingAction = null;
  }

  if (currentGoal && profileGoalSatisfied(currentGoal, observation, traveler)) {
    verifiedResults = [...verifiedResults, {
      goalId: currentGoal.goalId,
      candidateId: result.candidateId || "",
      actionId: result.actionId || "",
      observationId: observation.observationId || "",
      browserVerified: true,
      semanticPostconditionSatisfied: true,
      desiredValue: currentGoal.desiredValue,
      at: new Date().toISOString()
    }].slice(-40);
    currentGoal = null;
    pendingAction = null;
    attemptedCandidateIds = [];
  }

  currentGoal = deriveProfileGoal(observation, traveler, currentGoal);
  if (!currentGoal) attemptedCandidateIds = [];
  return withUpdate(state, {
    userPolicy: state.userPolicy || state.policySnapshot || {},
    transactionInvariants: state.transactionInvariants || state.invariantBaseline || null,
    currentObservation: compactCurrentObservation(observation),
    currentGoal,
    pendingAction,
    attemptedCandidateIds,
    verifiedResults,
    activeSkillPlan: undefined,
    blockedObligation: undefined,
    policySnapshot: undefined,
    invariantBaseline: undefined
  });
}

/**
 * @param {Object} args
 * @param {string} args.apiKey
 * @param {string} args.model
 * @param {string} args.dataDir base dir for traces (server's `work/` dir)
 * @param {import("../../../packages/shared/agent-state").CheckoutSessionState} args.state
 * @param {Object} args.observation AgentObservation from the extension
 * @param {Object} args.traveler
 * @param {Array} args.actionHistory
 * @returns {Promise<{ state: Object, clientDecision: Object }>}
 */
async function runLoopTurn({ apiKey, model, recoveryModel = "", dataDir, state, observation, traveler, actionHistory = [], transactionStore = null, clientTurnId = "" }) {
  const screenshotDataUrl = observation?.page?.screenshotDataUrl || "";
  const traceObservation = screenshotDataUrl
    ? { ...observation, page: { ...(observation?.page || {}), screenshotDataUrl: "[written-to-screenshot-file]" } }
    : observation;
  const turnId = `${Date.now()}`;
  const latency = {
    classification_model_ms: 0,
    verify_plan_model_ms: 0,
    policy_ms: 0
  };
  let verifyPlanMeta = null;
  const authoritativeTransition = applyTransitionStatus(
    state,
    observation,
    observation.previousObservation || null
  );
  state = authoritativeTransition.state;
  observation = authoritativeTransition.observation;
  const transition = authoritativeTransition.transition;
  const lifecycle = authoritativeTransition.lifecycle;
  const lifecycleDirective = authoritativeTransition.directive || "continue";
  if (lifecycle) {
    const pendingBeforeLifecycle = normalizePendingAction(state.pendingAction);
    const preservePendingRecovery = pendingBeforeLifecycle?.status === "needs_reveal"
      && pendingBeforeLifecycle.originalAction?.id !== lifecycle.actionId;
    transactionStore?.recordActionEvent?.(state.id, {
      actionId: lifecycle.actionId,
      observationId: observation.observationId || "",
      turnId: clientTurnId || turnId,
      stage: lifecycle.status,
      lifecycle,
      directive: lifecycleDirective
    });
    transactionStore?.advanceGovernedAction?.(
      lifecycle.actionId,
      ["allowed", "approved", "dispatched", "observed"],
      lifecycle.status,
      { lifecycle, transition }
    );
    state = withUpdate(state, {
      pendingAction: ["rejected_before_dispatch", "observed", "verified", "failed", "unsafe"].includes(lifecycle.status)
        && !preservePendingRecovery
        ? null
        : state.pendingAction,
      stallCount: ["rejected_before_dispatch", "observed", "verified"].includes(lifecycle.status)
        ? 0
        : state.stallCount
    });
    transactionStore?.saveSession?.(state);
  }
  if (transition) {
    const preserveViewportRecovery = normalizePendingAction(state.pendingAction)?.status === "needs_reveal";
    transactionStore?.recordActionEvent?.(state.id, {
      actionId: transition.actionId,
      observationId: observation.observationId || "",
      turnId: clientTurnId || turnId,
      stage: "transition_evaluated",
      status: transition.status,
      nextDirective: transition.nextDirective,
      postcondition: transition.postcondition,
      diff: transition.diff
    });
    state = withUpdate(state, {
      currentBlocker: transition.status === "blocked" ? transition.blocker : null,
      pendingAction: ["achieved", "progressed", "blocked"].includes(transition.status) && !preserveViewportRecovery
        ? null
        : state.pendingAction
    });
    transactionStore?.saveSession?.(state);
  }

  if (lifecycleDirective === "stop_for_safety" || transition?.status === "unsafe") {
    const action = finalHandoffAction(
      "Fresh browser evidence confirmed a policy or transaction-safety conflict. I stopped before another checkout action.",
      observation
    );
    const unsafeState = withUpdate(state, { lastAction: action, status: "awaiting_user" });
    transactionStore?.saveSession?.(unsafeState);
    return {
      state: unsafeState,
      clientDecision: toClientDecision(action),
      debug: withLatencyDebug({ transition, finalAction: action }, latency, modelUsageFromMetas(model, []))
    };
  }

  if (lifecycleDirective === "handoff_recovery_exhausted") {
    const reason = lifecycle?.dispatched
      ? "Three browser-dispatched strategies produced no verified effect. Execution recovery is exhausted."
      : "Three fresh grounded candidates were rejected before dispatch. Grounding recovery is exhausted.";
    const action = finalHandoffAction(reason, observation);
    const exhaustedState = withUpdate(state, { lastAction: action, status: "awaiting_user" });
    transactionStore?.saveSession?.(exhaustedState);
    return {
      state: exhaustedState,
      clientDecision: toClientDecision(action),
      debug: withLatencyDebug({ lifecycle, lifecycleDirective, finalAction: action }, latency, modelUsageFromMetas(model, []))
    };
  }

  if (transition?.status === "uncertain") {
    const action = normalizeAction({
      observationId: observation.observationId || "",
      observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
      type: "wait",
      intent: "reobserve_after_grounding_rejection",
      reason: "The transition evidence is incomplete. Capture one fresh observation and rebind current controls without repeating the action.",
      risk: "safe",
      requiresApproval: false
    });
    const uncertainState = withUpdate(state, { lastAction: action, status: "running" });
    transactionStore?.saveSession?.(uncertainState);
    return {
      state: uncertainState,
      clientDecision: toClientDecision(action),
      debug: withLatencyDebug({ transition, finalAction: action }, latency, modelUsageFromMetas(model, []))
    };
  }

  // A recoverable governor result preserves the semantic action across the
  // observation created by scrolling. Rebind that same action to the fresh
  // canonical registry before consulting the model again.
  const normalizedPending = normalizePendingAction(state.pendingAction);
  if (normalizedPending?.status === "needs_reveal" && normalizedPending.originalAction) {
    const pending = normalizedPending;
    const rebound = rebindPendingRecoveryAction(pending, observation, state, traveler);
    const reboundAction = rebound.action;
    const targetStatus = pendingRecoveryTargetStatus(reboundAction);
    const revealSample = viewportProgress(
      state.recoveryState?.lastRevealSample || null,
      viewportProgressSample(reboundAction, observation)
    );
    const reboundState = rebound.candidateSet && pending.semanticGoal
      ? withUpdate(state, {
          currentGoal: {
            ...pending.semanticGoal,
            candidateSet: rebound.candidateSet,
            candidates: rebound.candidateSet.candidates,
            updatedAt: new Date().toISOString()
          }
        })
      : state;
    if (!targetStatus.exists) {
      const grounding = recoverBeforeDispatch({
        state: reboundState,
        action: reboundAction,
        code: "TARGET_DISAPPEARED"
      });
      const action = normalizeAction({
        observationId: observation.observationId || "",
        observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
        type: "wait",
        intent: "reobserve_after_grounding_rejection",
        goalId: pending.semanticGoalId || "",
        reason: "The pending target disappeared. Discard its binding, rebuild candidates from the fresh surface, and reselect without consuming an execution attempt.",
        risk: "safe",
        requiresApproval: false
      });
      const recoveryState = withUpdate(grounding.state, { pendingAction: null, lastAction: action, status: "running" });
      transactionStore?.saveSession?.(recoveryState);
      return {
        state: recoveryState,
        clientDecision: toClientDecision(action),
        debug: withLatencyDebug({ pendingAction: pending, groundingRejection: grounding, finalAction: action, resumedBeforePlanning: true }, latency, modelUsageFromMetas(model, []))
      };
    }

    const revealRecovery = updateRecoveryState(reboundState, {
      kind: "reveal",
      code: targetStatus.inViewport ? "TARGET_IN_VIEW" : "TARGET_OUT_OF_VIEW",
      sample: revealSample,
      measurableProgress: revealSample.measurableProgress
    });
    const policyStartedAt = Date.now();
    let recoveryGovernance = targetStatus.exists && targetStatus.inViewport
      ? governAction({
          action: reboundAction,
          state: revealRecovery.state,
          observation,
          traveler,
          approvals: revealRecovery.state.approvals,
          store: transactionStore,
          turnId: clientTurnId || turnId
        })
      : {
          state: revealRecovery.state,
          allow: false,
          decision: "recoverable",
          code: "TARGET_OUT_OF_VIEW",
          reason: "The fresh observation has not yet confirmed the pending canonical target in the viewport."
        };
    latency.policy_ms = Date.now() - policyStartedAt;
    let recoveryState = recoveryGovernance.state || reboundState;
    let finalAction = reboundAction;

    if (recoveryGovernance.allow && targetStatus.exists && targetStatus.inViewport) {
      recoveryState = withUpdate(recoveryState, {
        pendingAction: pendingActionRecord({
          action: reboundAction,
          candidate: rebound.candidate || pending.candidate,
          goal: pending.semanticGoal || { goalId: pending.semanticGoalId },
          status: "ready",
          recoveryAttempts: revealRecovery.recoveryState.attempts
        }),
        lastAction: reboundAction,
        status: "running"
      });
      transactionStore?.recordActionEvent?.(recoveryState.id, {
        actionId: reboundAction.id,
        observationId: observation.observationId || "",
        turnId: clientTurnId || turnId,
        stage: "pending_action_rebound_dispatched",
        recoveryOfActionId: pending.originalAction.id,
        recoveryAttempts: revealRecovery.recoveryState.attempts,
        action: reboundAction
      });
    } else if (recoveryGovernance.decision === "recoverable"
      && recoveryGovernance.code === "TARGET_OUT_OF_VIEW"
      && !revealRecovery.exhausted) {
      const nextRecoveryAttempt = Number(revealRecovery.recoveryState.attempts || 0) + 1;
      const scrollAction = viewportRecoveryAction(reboundAction, observation, nextRecoveryAttempt);
      const scrollGovernance = governAction({
        action: scrollAction,
        state: recoveryState,
        observation,
        traveler,
        approvals: recoveryState.approvals,
        store: transactionStore,
        turnId: clientTurnId || turnId
      });
      if (scrollGovernance.allow) {
        recoveryGovernance = scrollGovernance;
        finalAction = scrollAction;
        recoveryState = withUpdate(scrollGovernance.state || recoveryState, {
          pendingAction: pendingActionRecord({
            action: pending.originalAction,
            candidate: pending.candidate,
            goal: pending.semanticGoal,
            status: "needs_reveal",
            recoveryAttempts: nextRecoveryAttempt
          }),
          lastAction: scrollAction,
          status: "running"
        });
        transactionStore?.recordActionEvent?.(recoveryState.id, {
          actionId: scrollAction.id,
          observationId: observation.observationId || "",
          turnId: clientTurnId || turnId,
          stage: "pending_action_reveal_governed",
          recoveryOfActionId: pending.originalAction.id,
          recoveryAttempts: nextRecoveryAttempt,
          action: scrollAction
        });
      } else if (scrollGovernance.decision === "recoverable") {
        const grounding = recoverBeforeDispatch({
          state: recoveryState,
          action: scrollAction,
          code: scrollGovernance.code || "SCROLL_GROUNDING_REJECTED"
        });
        recoveryState = grounding.state;
        finalAction = normalizeAction({
          observationId: observation.observationId || "",
          observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
          type: "wait",
          intent: "reobserve_after_grounding_rejection",
          goalId: pending.semanticGoalId || "",
          reason: "The governed reveal binding was rejected before dispatch. Rebuild it from a fresh observation without consuming an execution attempt.",
          risk: "safe",
          requiresApproval: false
        });
        recoveryState = withUpdate(recoveryState, { pendingAction: null, lastAction: finalAction, status: "running" });
      } else {
        recoveryGovernance = scrollGovernance;
        finalAction = policyBlockedAction(scrollGovernance, scrollAction);
        recoveryState = withUpdate(recoveryState, { pendingAction: null, lastAction: finalAction, status: "awaiting_user" });
      }
    } else if (recoveryGovernance.decision === "recoverable"
      && recoveryGovernance.code === "TARGET_OUT_OF_VIEW"
      && revealRecovery.exhausted) {
      finalAction = finalHandoffAction(
        "The pending control remained unreachable after three grounded reveal attempts and no safe current alternative could be dispatched.",
        observation
      );
      recoveryState = withUpdate(recoveryState, { pendingAction: null, lastAction: finalAction, status: "awaiting_user" });
    } else if (recoveryGovernance.decision === "recoverable") {
      const grounding = recoverBeforeDispatch({
        state: recoveryState,
        action: reboundAction,
        code: recoveryGovernance.code || "PENDING_ACTION_GROUNDING_REJECTED"
      });
      recoveryState = grounding.state;
      finalAction = normalizeAction({
        observationId: observation.observationId || "",
        observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
        type: "wait",
        intent: "reobserve_after_grounding_rejection",
        goalId: pending.semanticGoalId || "",
        reason: "The rebound pending action was rejected before dispatch. Rebuild current candidates from fresh browser evidence without consuming an execution attempt.",
        risk: "safe",
        requiresApproval: false
      });
      recoveryState = withUpdate(recoveryState, { pendingAction: null, lastAction: finalAction, status: "running" });
    } else {
      finalAction = policyBlockedAction(recoveryGovernance, reboundAction);
      recoveryState = withUpdate(recoveryState, {
        pendingAction: null,
        lastAction: finalAction,
        status: "awaiting_user"
      });
    }

    finalAction = bindTargetSnapshot(finalAction, observation);
    recoveryState = withUpdate(recoveryState, { lastAction: finalAction });
    transactionStore?.saveSession?.(recoveryState);
    const debug = withLatencyDebug(
      summarizeTurn({
        pageState: null,
        requirements: recoveryState.activeRequirements || recoveryState.requirements || [],
        plannedAction: reboundAction,
        finalAction,
        policyDecision: recoveryGovernance,
        deterministicAction: reboundAction
      }),
      latency,
      modelUsageFromMetas(model, [])
    );
    writeTrace(dataDir, state.id, {
      turnId,
      screenshotDataUrl,
      observation: traceObservation,
      pageState: null,
      requirements: recoveryState.activeRequirements || recoveryState.requirements || [],
      requirementLifecycle: recoveryState.requirementLifecycle || [],
      verification: observation.lastActionResult || null,
      plannedAction: reboundAction,
      policyDecision: recoveryGovernance,
      executionResult: {
        pendingRecovery: true,
        recoveryAttempts: pending.recoveryAttempts,
        recoveryOfActionId: pending.originalAction.id,
        freshTargetExists: targetStatus.exists,
        freshTargetInViewport: targetStatus.inViewport,
        revealProgress: revealSample,
        recoveryState: recoveryState.recoveryState
      },
      debug
    });
    return { state: recoveryState, clientDecision: toClientDecision(finalAction), debug };
  }

  // An approved action must be observed before any new goal or candidate set
  // is derived. Missing execution feedback is a resume condition, not a new
  // planning turn and not a user-facing failure.
  if (pendingActionNeedsResult(state, observation)) {
    const pending = normalizePendingAction(state.pendingAction);
    const action = normalizeAction({
      observationId: observation.observationId || "",
      observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
      type: "wait",
      intent: "await_pending_action_result",
      goalId: pending?.semanticGoalId || "",
      candidateId: pending?.candidateId || "",
      reason: `Wait for browser evidence for pending action ${pending?.originalAction?.id || ""}; do not derive or dispatch another action.`,
      risk: "safe",
      requiresApproval: false
    });
    const waitingState = withUpdate(state, { lastAction: action, status: "running" });
    transactionStore?.saveSession?.(waitingState);
    return {
      state: waitingState,
      clientDecision: toClientDecision(action),
      debug: withLatencyDebug({ pendingAction: pending, finalAction: action, resumedBeforePlanning: true }, latency, modelUsageFromMetas(model, []))
    };
  }

  // Profile specialization publishes only the next semantic field goal. It
  // no longer selects candidates, governs, recovers, or hands off.
  state = reconcileSemanticGoalState(state, observation, traveler);
  const profileReadiness = profileStageReadiness(observation, traveler);
  const publishedProfileGoal = profileReadiness.profileStage && !profileReadiness.ready
    ? state.currentGoal
    : null;
  if (profileReadiness.profileStage && !profileReadiness.ready && !publishedProfileGoal) {
    const missing = profileReadiness.missingUserData || [];
    const blockers = [
      ...missing.map((item) => item.label || item.semanticType),
      ...(profileReadiness.unresolvedKnown || []).map((item) => item.label || item.semanticType),
      ...(profileReadiness.visibleErrors || [])
    ].filter(Boolean);
    const reason = missing.length
      ? `Required traveler data is not available in the saved profile or current context: ${blockers.join(", ")}.`
      : `No safe grounded profile candidate remains${blockers.length ? `: ${blockers.join("; ")}` : "."}`;
    const action = finalHandoffAction(reason, observation);
    const stoppedState = withUpdate(state, { lastAction: action, status: "awaiting_user" });
    transactionStore?.saveSession?.(stoppedState);
    return {
      state: stoppedState,
      clientDecision: toClientDecision(action),
      debug: withLatencyDebug({ currentGoal: null, finalAction: action, reason, stopCategory: missing.length ? "missing_user_data" : "safe_candidate_unavailable" }, latency, modelUsageFromMetas(model, []))
    };
  }

  // The action lifecycle above is the sole authority for unchanged outcomes.
  // A pre-dispatch rejection rebuilds from this observation; only a browser-
  // dispatched unchanged transition consumes an execution strategy attempt.
  // Build the task-scoped contract before consulting a model. Canonical
  // decision groups, current-surface ownership, policy, unavailable state and
  // failed stable strategies are sufficient for an obvious single action.
  // In that case the model must not rediscover or reinterpret the contract.
  const observedCanonicalRequirements = requirementsWithDecisionGroups(
    state.activeRequirements || state.requirements || [],
    observation
  );
  const taskContext = publishedProfileGoal
    ? contextForPublishedGoal({ state, observation, goal: publishedProfileGoal })
    : deriveAuthoritativeTaskContext({
        state,
        observation,
        requirements: observedCanonicalRequirements,
        traveler,
        transition
      });
  const canonicalRequirements = applyAuthoritativeOutcomeToRequirements(
    observedCanonicalRequirements,
    taskContext
  );
  const canonicalState = withUpdate(state, {
    requirements: canonicalRequirements,
    activeRequirements: canonicalRequirements,
    currentObligation: taskContext
  });
  const canonicalGoal = taskContext.remainingGoal;
  const canonicalFailedStrategies = failedStrategySignaturesForGoal(state, canonicalGoal);
  const canonicalCandidateSet = groundedObservationCandidateSet(
    canonicalGoal,
    observation,
    canonicalFailedStrategies,
    { state: canonicalState, traveler, approvals: state.approvals }
  );
  const obviousCandidate = deterministicTaskCandidate(canonicalCandidateSet)
    || deterministicSafeForwardCandidate(canonicalCandidateSet);

  // An empty executable set is a grounding/policy outcome, not an OpenAI
  // outage and not a reason to ask the model to invent an action. Preserve the
  // exact goal and report the actual blocker through the final handoff path.
  if (!canonicalCandidateSet.candidates.length) {
    const reason = `No safe grounded candidate is available for the current goal: ${canonicalGoal.semanticGoal || "current checkout decision"}.`;
    const action = finalHandoffAction(reason, observation);
    const stoppedState = withUpdate(canonicalState, {
      currentGoal: {
        ...canonicalGoal,
        label: canonicalGoal.semanticGoal,
        candidateSet: canonicalCandidateSet,
        candidates: [],
        updatedAt: new Date().toISOString()
      },
      pendingAction: null,
      lastAction: action,
      status: "awaiting_user"
    });
    transactionStore?.saveSession?.(stoppedState);
    transactionStore?.recordActionEvent?.(stoppedState.id, {
      observationId: observation.observationId || "",
      turnId: clientTurnId || turnId,
      stage: "no_safe_grounded_candidate",
      goalId: canonicalGoal.goalId || "",
      dispatched: false,
      modelCalled: false,
      excludedCandidates: canonicalCandidateSet.excludedCandidates?.length || 0
    });
    return {
      state: stoppedState,
      clientDecision: toClientDecision(action),
      debug: withLatencyDebug({
        currentGoal: stoppedState.currentGoal,
        finalAction: action,
        stopCategory: "safe_candidate_unavailable",
        aiServiceUnavailable: false,
        modelCalled: false
      }, latency, modelUsageFromMetas(publishedProfileGoal ? (recoveryModel || model) : model, []))
    };
  }

  let extracted;
  let verification;
  let modelPlannedAction;
  let modelSelection;
  let observationGoal;
  let candidateSet;
  let observationCandidates;
  let deterministicAction = null;
  const planningModel = publishedProfileGoal ? (recoveryModel || model) : model;
  let modelUsage;

  if (obviousCandidate) {
    extracted = {
      pageState: null,
      pageStep: observation.page?.step || state.currentStep || "unknown",
      requirements: canonicalRequirements,
      uncertainties: [],
      summary: "One policy-allowed task candidate remained after canonical filtering."
    };
    verification = deterministicTransitionVerification(transition);
    observationGoal = canonicalGoal;
    candidateSet = canonicalCandidateSet;
    observationCandidates = candidateSet.candidates;
    modelSelection = { candidateId: obviousCandidate.candidateId, candidate: obviousCandidate };
    modelPlannedAction = bindTargetSnapshot(
      actionForCurrentCandidate(observationGoal, obviousCandidate, observation),
      observation
    );
    deterministicAction = modelPlannedAction;
    modelUsage = modelUsageFromMetas(planningModel, []);
    transactionStore?.recordActionEvent?.(state.id, {
      observationId: observation.observationId || "",
      turnId: clientTurnId || turnId,
      stage: "deterministic_task_candidate_selected",
      candidateId: obviousCandidate.candidateId,
      candidateCount: 1,
      modelCalled: false
    });
  } else {
    // The task context above is the only semantic authority. Classification
    // cannot replace its remaining goal or reopen a completed obligation.
    // Genuine ambiguity is a closed selection over current candidate IDs.
    extracted = {
      pageState: null,
      pageStep: observation.page?.step || state.currentStep || "unknown",
      requirements: canonicalRequirements,
      uncertainties: [],
      summary: "Selection is scoped to the authoritative obligation and current candidate set."
    };
    verification = deterministicTransitionVerification(transition);
    observationGoal = canonicalGoal;
    candidateSet = canonicalCandidateSet;
    observationCandidates = candidateSet.candidates;
    try {
      let selected;
      try {
        selected = await selectCandidate({
          apiKey,
          model: planningModel,
          goal: observationGoal,
          candidates: observationCandidates,
          observation,
          screenshotDataUrl
        });
      } catch (error) {
        if (error?.code !== "PLANNER_CANDIDATE_NOT_CURRENT") throw error;
        candidateSet = groundedObservationCandidateSet(
          observationGoal,
          observation,
          failedStrategySignaturesForGoal(state, observationGoal),
          { state: canonicalState, traveler, approvals: state.approvals }
        );
        observationCandidates = candidateSet.candidates;
        const rebuiltObvious = deterministicTaskCandidate(candidateSet)
          || deterministicSafeForwardCandidate(candidateSet);
        selected = rebuiltObvious
          ? { candidateId: rebuiltObvious.candidateId, candidate: rebuiltObvious, meta: null }
          : await selectCandidate({
              apiKey,
              model: planningModel,
              goal: observationGoal,
              candidates: observationCandidates,
              observation,
              screenshotDataUrl
            });
        transactionStore?.recordActionEvent?.(state.id, {
          observationId: observation.observationId || "",
          turnId: clientTurnId || turnId,
          stage: "candidate_selection_rebuilt",
          dispatched: false,
          browserReobserved: false,
          candidateCount: observationCandidates.length
        });
      }
      verifyPlanMeta = selected.meta || null;
      latency.verify_plan_model_ms = Number(verifyPlanMeta?.durationMs || 0);
      const selectedCandidate = selected.candidate
        || observationCandidates.find((candidate) => candidate.candidateId === selected.candidateId)
        || null;
      if (!selectedCandidate) {
        const error = new Error("The schema-bound planner did not resolve a current candidate.");
        error.code = "PLANNER_CANDIDATE_NOT_CURRENT";
        throw error;
      }
      modelSelection = { candidateId: selectedCandidate.candidateId, candidate: selectedCandidate };
      modelPlannedAction = bindTargetSnapshot(
        actionForCurrentCandidate(observationGoal, selectedCandidate, observation),
        observation
      );
    } catch (error) {
      if (error?.code === "PLANNER_CANDIDATE_NOT_CURRENT" && observationCandidates.length) {
        const fallbackCandidate = deterministicSafeForwardCandidate(candidateSet)
          || deterministicTaskCandidate(candidateSet);
        if (fallbackCandidate) {
          modelSelection = { candidateId: fallbackCandidate.candidateId, candidate: fallbackCandidate };
          modelPlannedAction = bindTargetSnapshot(
            actionForCurrentCandidate(observationGoal, fallbackCandidate, observation),
            observation
          );
          deterministicAction = modelPlannedAction;
        } else {
          const retryAction = normalizeAction({
            observationId: observation.observationId || "",
            observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
            type: "wait",
            intent: "retry_planner_current_candidates",
            goalId: observationGoal.goalId || "",
            reason: "Candidate grounding was rejected before browser dispatch. Retry selection against this same immutable candidate set without reobserving the page.",
            risk: "safe",
            requiresApproval: false
          });
          const plannerRecovery = updateRecoveryState(canonicalState, {
            kind: "planner_rejection",
            code: "PLANNER_CANDIDATE_NOT_CURRENT"
          });
          const retryState = withUpdate(plannerRecovery.state, {
            currentGoal: {
              ...observationGoal,
              label: observationGoal.semanticGoal,
              candidateSet,
              candidates: observationCandidates,
              updatedAt: new Date().toISOString()
            },
            pendingAction: null,
            lastAction: retryAction,
            status: "running"
          });
          transactionStore?.saveSession?.(retryState);
          transactionStore?.recordActionEvent?.(retryState.id, {
            observationId: observation.observationId || "",
            turnId: clientTurnId || turnId,
            stage: "planner_candidate_grounding_rejected",
            dispatched: false,
            browserReobserved: false,
            candidateCount: observationCandidates.length,
            recoveryState: retryState.recoveryState
          });
          return {
            state: retryState,
            clientDecision: toClientDecision(retryAction),
            debug: withLatencyDebug({
              candidateGroundingRejected: true,
              aiServiceUnavailable: false,
              candidateSet,
              finalAction: retryAction
            }, latency, modelUsageFromMetas(planningModel, [verifyPlanMeta]))
          };
        }
      } else {
        return safePlannerFailureResult({
          dataDir,
          state: canonicalState,
          turnId,
          screenshotDataUrl,
          traceObservation,
          reason: plannerFailureReason(error),
          error,
          latency,
          modelUsage: modelUsageFromMetas(model, [verifyPlanMeta])
        });
      }
    }
    modelUsage = modelUsageFromMetas(planningModel, [verifyPlanMeta]);
  }

  state = withUpdate(state, {
    currentObligation: taskContext,
    currentGoal: {
      ...observationGoal,
      label: observationGoal.semanticGoal,
      candidateSet,
      candidates: observationCandidates,
      updatedAt: new Date().toISOString()
    }
  });
  transactionStore?.saveSession?.(state);

  // Fresh page evidence is the source of truth. The verifier can propose
  // updates, but it may not blindly override current-page unresolved evidence.
  // Contradictions become blockers instead of silently turning into satisfied.
  const mergedRequirements = applyAuthoritativeOutcomeToRequirements(
    reconcileRequirements(extracted.requirements, verification, observation),
    taskContext
  );
  const requirementLifecycle = canonicalRequirementLifecycle(
    mergedRequirements,
    observation,
    state.requirementLifecycle || [],
    traveler,
    extracted.pageStep
  );
  const activeRequirements = activeRequirementView(requirementLifecycle);

  let nextState = withUpdate(state, {
    currentStep: normalizeStep(extracted.pageStep),
    requirements: activeRequirements,
    requirementLifecycle,
    activeRequirements,
    decisionCompletions: exactDecisionCompletionRecords(
      state.decisionCompletions || [],
      requirementLifecycle,
      observation.observationId || ""
    ),
    lastVerification: verification
  });

  if (verification.priceChanged) {
    const amount = parsePriceAmount(observation?.page?.priceText);
    if (amount !== null) {
      nextState = withUpdate(nextState, { priceHistory: [...nextState.priceHistory, { amount, currency: "?", capturedAt: new Date().toISOString() }] });
    }
  }

  let plannedAction = modelPlannedAction;

  if (!plannedAction || !plannedAction.type) {
    plannedAction = normalizeAction({
      observationId: observation.observationId || "",
      observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
      type: "wait",
      intent: "rebuild_current_action_context",
      goalId: observationGoal?.goalId || "",
      reason: "No executable action was compiled. Preserve the current goal and rebuild its grounded candidates without treating this as a browser failure.",
      risk: "safe",
      requiresApproval: false
    });
  }

  // 4. Govern once — schema, stored observation, canonical target,
  // actionability, policy, transaction invariants, approval, duplication.
  if (["fill_known_fields", "fill_visible_profile_fields"].includes(plannedAction.type)) {
    plannedAction = finalHandoffAction(
      "The general planner returned a deprecated compound profile action after local semantic-goal processing.",
      observation
    );
  }
  const executablePlannedAction = bindTargetSnapshot(plannedAction, observation);
  const policyStartedAt = Date.now();
  let governance = governAction({
    action: executablePlannedAction,
    state: nextState,
    observation,
    traveler,
    approvals: nextState.approvals,
    store: transactionStore,
    turnId: clientTurnId || turnId
  });
  latency.policy_ms = Date.now() - policyStartedAt;
  nextState = governance.state || nextState;

  let finalAction = executablePlannedAction;
  if (!governance.allow && governance.decision === "recoverable" && governance.code === "TARGET_OUT_OF_VIEW") {
    const scrollAction = viewportRecoveryAction(executablePlannedAction, observation, 1);
    const scrollGovernance = governAction({
      action: scrollAction,
      state: nextState,
      observation,
      traveler,
      approvals: nextState.approvals,
      store: transactionStore,
      turnId: clientTurnId || turnId
    });
    governance = scrollGovernance;
    if (scrollGovernance.allow) {
      finalAction = scrollAction;
      const revealStarted = updateRecoveryState(scrollGovernance.state || nextState, {
        kind: "reveal_started",
        code: "TARGET_OUT_OF_VIEW",
        sample: viewportProgressSample(executablePlannedAction, observation)
      });
      nextState = withUpdate(revealStarted.state, {
        pendingAction: pendingRevealAction(
          executablePlannedAction,
          1,
          modelSelection?.candidate || null,
          observationGoal
        ),
        lastAction: scrollAction,
        status: "running"
      });
      transactionStore?.recordActionEvent?.(nextState.id, {
        actionId: scrollAction.id,
        observationId: observation.observationId || "",
        turnId: clientTurnId || turnId,
        stage: "pending_action_reveal_governed",
        recoveryOfActionId: executablePlannedAction.id,
        recoveryAttempts: 1,
        action: scrollAction
      });
    } else {
      finalAction = policyBlockedAction(scrollGovernance, scrollAction);
    }
  } else if (!governance.allow && governance.decision === "recoverable" && STALE_IDENTITY_CODES.has(governance.code)) {
    const groundingBudget = recoverBeforeDispatch({
      state: nextState,
      action: executablePlannedAction,
      code: governance.code
    });
    nextState = withUpdate(groundingBudget.state, { pendingAction: null });
    transactionStore?.recordActionEvent?.(nextState.id, {
      actionId: executablePlannedAction.id || "",
      observationId: observation.observationId || "",
      turnId: clientTurnId || turnId,
      stage: "grounding_replan",
      code: governance.code,
      dispatched: false,
      recoveryState: groundingBudget.recoveryState
    });
    finalAction = normalizeAction({
      observationId: observation.observationId || "",
      observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
      type: "wait",
      intent: "reobserve_after_grounding_rejection",
      goalId: observationGoal.goalId,
      candidateId: modelSelection?.candidateId || "",
      reason: `Discard ${governance.code}, capture a fresh observation, rebuild the candidate set, and replan the same semantic goal.`,
      risk: "safe",
      requiresApproval: false
    });
  } else if (!governance.allow) {
    finalAction = policyBlockedAction(governance, executablePlannedAction);
  }
  finalAction = bindTargetSnapshot(finalAction, observation);

  const pendingExecutableAction = governance.allow === true
    && ["click", "type", "select", "keypress", "scroll", "click_xy"].includes(finalAction.type)
    && !nextState.pendingAction;
  const authoritativePendingAction = pendingExecutableAction
    ? pendingActionRecord({
        action: finalAction,
        candidate: modelSelection?.candidate || null,
        goal: observationGoal,
        status: "ready"
      })
    : nextState.pendingAction;

  nextState = withUpdate(nextState, {
    pendingAction: authoritativePendingAction,
    lastAction: finalAction,
    status: finalAction.type === "ask_user" || finalAction.type === "final_review" ? "awaiting_user" : "running"
  });

  const debug = withLatencyDebug(
    summarizeTurn({ pageState: extracted.pageState, requirements: activeRequirements, plannedAction, finalAction, policyDecision: governance, deterministicAction }),
    latency,
    modelUsage
  );
  writeTrace(dataDir, state.id, {
    turnId, screenshotDataUrl, observation: traceObservation, pageState: extracted.pageState, requirements: activeRequirements, requirementLifecycle, verification,
    plannedAction, policyDecision: governance,
    executionResult: { stillMissingCount: actionableMissingRequired(activeRequirements).length },
    debug
  });
  transactionStore?.saveSession?.(nextState);

  return {
    state: nextState,
    clientDecision: toClientDecision(finalAction),
    debug
  };
}

module.exports = {
  runLoopTurn,
  toClientDecision,
  __private: {
    actionableMissingRequired,
    activeRequirementView,
    bindTargetSnapshot,
    buildControlAliasIndex,
    canonicalRequirementLifecycle,
    controlDecisionGroupId,
    decisionGroupForRequirement,
    deterministicRequirementEvidence,
    exactDecisionCompletionRecords,
    expectedOutcomeForAction,
    updateRecoveryState,
    applyTransitionStatus,
    candidateStrategySignature,
    semanticGoalRecoveryKey,
    failedStrategySignaturesForGoal,
    deterministicSafeForwardCandidate,
    groundedObservationCandidateSet,
    groundedObservationCandidates,
    observationSurfaceId,
    reconcileRequirements,
    requirementsWithDecisionGroups,
    staleIdentityRejection,
    targetSnapshotForAction,
    resolveActionControl,
    updateEvidenceMatchesRequirement
  }
};
