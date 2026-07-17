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
// Two OpenAI calls per turn, not three: verify+plan are combined
// (verify-and-plan.js) since "given what just happened, what's next" is one
// judgment, not two round-trips — the original 3-call version measured
// 15-30+ seconds per turn in practice, which is a real cost, not a
// theoretical one, for a product whose whole point is being fast.

const { classifyPageState } = require("./page-state-classifier");
const { PlannerContractError, verifyAndPlan } = require("./verify-and-plan");
const { selectCandidate } = require("./select-candidate");
const {
  deriveObservationGoal
} = require("./observation-candidates");
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
  applyRecoveryBudget,
  canonicalFailureCode,
  wasDispatched
} = require("./action-lifecycle");
const {
  normalizeAction,
  actionSignature
} = require("../../../packages/shared/agent-actions");
const { withUpdate, normalizeStep } = require("../../../packages/shared/agent-state");
const { missingRequired, normalizeRequirement, requirementFulfilled } = require("../../../packages/shared/requirements");
const { currentSurface, currentSurfaceId, surfaceBinding } = require("./surface-contract");
const { compileTypedExpectedOutcome } = require("./action-semantics");

const STALL_THRESHOLD = 3;

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
  const targetIds = new Set([requirement.id, ...(requirement.targetIds || [])].filter(Boolean));
  if (targetIds.has(group.decisionGroupId) || targetIds.has(group.sectionId) || targetIds.has(group.requirementId)) return true;
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
    }))
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
    if (!group?.decisionGroupId) return [withoutCanonicalGroup(requirement)];
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

const MAX_VIEWPORT_RECOVERY_ATTEMPTS = 5;
const MAX_CONSECUTIVE_VIEWPORT_FAILURES = 3;

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

function withViewportProgress(pending = {}, sample = {}) {
  const history = Array.isArray(pending.viewportProgress) ? pending.viewportProgress : [];
  const previous = history[history.length - 1] || null;
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
  const comparableFailure = Boolean(previous && !sample.inViewport && !measurableProgress);
  return {
    ...pending,
    viewportProgress: [...history, { ...sample, measurableProgress }].slice(-8),
    noProgressFailureCount: measurableProgress
      ? 0
      : comparableFailure
        ? Number(pending.noProgressFailureCount || 0) + 1
        : Number(pending.noProgressFailureCount || 0),
    updatedAt: new Date().toISOString()
  };
}

function pendingViewportRecovery(blockedAction = {}, recoveryCount = 1, observation = {}) {
  const initialProgress = viewportProgressSample(blockedAction, observation);
  return {
    type: "viewport_rebind",
    action: normalizeAction({
      ...blockedAction,
      targetSnapshot: null,
      expectedOutcome: null
    }),
    recoveryCount,
    viewportProgress: initialProgress.observationId ? [{ ...initialProgress, measurableProgress: false }] : [],
    noProgressFailureCount: 0,
    blockedActionId: blockedAction.id || "",
    createdObservationId: blockedAction.observationId || "",
    updatedAt: new Date().toISOString()
  };
}

function rebindPendingRecoveryAction(pending = {}, observation = {}) {
  const original = pending.action || {};
  return bindTargetSnapshot(normalizeAction({
    ...original,
    id: `act_rebind_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    observationId: observation.observationId || "",
    observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
    targetId: original.controlId || original.targetId || "",
    targetSnapshot: null,
    expectedOutcome: null,
    reason: `Rebound pending governed action after viewport recovery: ${original.reason || original.intent || original.type || "action"}.`
  }), observation);
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

function askUserDecision(reason, observation = {}) {
  return toClientDecision(finalHandoffAction(reason, observation));
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
  const affordance = candidate.affordance || {};
  return [
    affordance.stableKey || candidate.stableKey || candidate.controlId || "control",
    affordance.actuator?.stableKey || candidate.operation || candidate.type || "actuator",
    affordance.effect || candidate.semanticEffect || "effect",
    candidate.value || "",
    candidate.keys || ""
  ].join(":");
}

function groundedObservationCandidateSet(goal = {}, observation = {}, attemptedStrategySignatures = []) {
  const binding = surfaceBinding(observation);
  const attempted = new Set(attemptedStrategySignatures || []);
  const candidates = buildCurrentCandidateSet({ goal, observation }).candidates.map((candidate) => {
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
  )).filter((candidate) => !attempted.has(candidateStrategySignature(goal, candidate)));
  return { ...binding, candidates };
}

function groundedObservationCandidates(goal = {}, observation = {}) {
  return groundedObservationCandidateSet(goal, observation).candidates;
}

function applyTransitionStatus(state = {}, observation = {}, previousObservation = null) {
  const advanced = advanceActionLifecycle({ state, observation, previousObservation });
  const transition = advanced.transition;
  if (!advanced.lifecycle) return { ...advanced, transition: null };
  const priorSignatures = [...(state.attemptedStrategySignatures || [])];
  const governedAction = state.lastAction?.id === advanced.lifecycle.actionId
    ? state.lastAction
    : state.pendingAction?.action || observation.lastActionResult?.action || {};
  const signature = candidateStrategySignature(state.currentGoal || {}, governedAction);
  const attemptedStrategySignatures = transition?.status === "no_effect" && governedAction.controlId
    ? [...new Set([...priorSignatures, signature])].slice(-12)
    : ["achieved", "progressed", "blocked"].includes(transition?.status)
      ? []
      : priorSignatures;
  return {
    ...advanced,
    state: withUpdate(advanced.state, {
      lastTransition: transition || state.lastTransition || null,
      attemptedStrategySignatures,
      uncertainTransitionCount: transition?.status === "uncertain"
        ? Number(state.uncertainTransitionCount || 0) + 1
        : 0
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
  let pendingAction = state.pendingAction || null;
  let attemptedCandidateIds = [...(state.attemptedCandidateIds || [])];
  let verifiedResults = [...(state.verifiedResults || [])];
  const result = observation.lastActionResult || {};

  if (pendingAction?.actionId && result.actionId === pendingAction.actionId) {
    if (pendingAction.status === "viewport_recovery") {
      pendingAction = null;
    } else {
      if (browserDispatched(result) && pendingAction.candidateId) {
        attemptedCandidateIds = [...new Set([
          ...attemptedCandidateIds,
          pendingAction.strategyId || pendingAction.candidateId
        ])];
      }
      if (browserDispatched(result)) {
        verifiedResults = [...verifiedResults, {
          goalId: pendingAction.goalId || currentGoal?.goalId || "",
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

async function runProfileSemanticGoalTurn({
  apiKey,
  model,
  recoveryModel,
  dataDir,
  state,
  observation,
  traveler,
  transactionStore,
  clientTurnId,
  screenshotDataUrl,
  traceObservation,
  turnId,
  latency
}) {
  let goalState = reconcileSemanticGoalState(state, observation, traveler);
  const readiness = profileStageReadiness(observation, traveler);
  if (!goalState.currentGoal) {
    transactionStore?.saveSession?.(goalState);
    if (readiness.ready || !readiness.profileStage) {
      return { handled: false, state: goalState };
    }
    if (readiness.unresolvedKnown.length > 0) {
      throw new Error(`PROFILE_PROGRESSION_INVARIANT: ${readiness.unresolvedKnown.map((item) => item.semanticType).join(",")} has known data but currentGoal is null.`);
    }
    if (readiness.missingUserData.length > 0) {
      const missing = readiness.missingUserData.map((item) => item.label || item.semanticType).join(", ");
      const reason = `Required traveler data is not available in the saved profile or current context: ${missing}.`;
      const handoff = finalHandoffAction(reason, observation);
      goalState = withUpdate(goalState, { lastAction: handoff, status: "awaiting_user" });
      transactionStore?.saveSession?.(goalState);
      return {
        handled: true,
        state: goalState,
        clientDecision: toClientDecision(handoff),
        debug: withLatencyDebug({ currentGoal: null, finalAction: handoff, reason }, latency, modelUsageFromMetas(model, []))
      };
    }
    const blockers = [
      ...readiness.unresolvedRequired.map((item) => item.label),
      ...readiness.visibleErrors
    ].filter(Boolean).join("; ");
    const reason = `Known traveler data exists, but no safe actionable control is available${blockers ? `: ${blockers}` : "."}`;
    const handoff = finalHandoffAction(reason, observation);
    goalState = withUpdate(goalState, { lastAction: handoff, status: "awaiting_user" });
    transactionStore?.saveSession?.(goalState);
    return {
      handled: true,
      state: goalState,
      clientDecision: toClientDecision(handoff),
      debug: withLatencyDebug({ currentGoal: null, finalAction: handoff, reason, stopCategory: "safe_candidate_unavailable" }, latency, modelUsageFromMetas(model, []))
    };
  }

  if (goalState.pendingAction) {
    const reason = `The browser has not returned an execution result for ${goalState.pendingAction.candidateId || goalState.pendingAction.actionId}; stopping instead of issuing another action.`;
    const handoff = finalHandoffAction(reason, observation, { goalId: goalState.currentGoal.goalId });
    goalState = withUpdate(goalState, { lastAction: handoff, status: "awaiting_user" });
    transactionStore?.saveSession?.(goalState);
    return {
      handled: true,
      state: goalState,
      clientDecision: toClientDecision(handoff),
      debug: withLatencyDebug({ currentGoal: goalState.currentGoal, finalAction: handoff, reason }, latency, modelUsageFromMetas(model, []))
    };
  }

  const attempted = goalState.attemptedCandidateIds || [];
  const candidates = buildCurrentCandidateSet({
    goal: goalState.currentGoal,
    observation,
    traveler,
    attemptedCandidateIds: attempted
  }).candidates;
  goalState = withUpdate(goalState, {
    currentGoal: {
      ...goalState.currentGoal,
      candidates,
      currentValue: deriveProfileGoal(observation, traveler, goalState.currentGoal)?.currentValue || goalState.currentGoal.currentValue || "",
      observationId: observation.observationId || "",
      updatedAt: new Date().toISOString()
    }
  });

  if (attempted.length >= 3 || candidates.length === 0) {
    const reason = attempted.length >= 3
      ? `The recovery budget for ${goalState.currentGoal.label || goalState.currentGoal.semanticType} was exhausted after ${attempted.length} browser-dispatched candidates.`
      : `No untried grounded candidate remains for ${goalState.currentGoal.label || goalState.currentGoal.semanticType}.`;
    const handoff = finalHandoffAction(reason, observation, { goalId: goalState.currentGoal.goalId });
    goalState = withUpdate(goalState, { lastAction: handoff, status: "awaiting_user" });
    transactionStore?.saveSession?.(goalState);
    return {
      handled: true,
      state: goalState,
      clientDecision: toClientDecision(handoff),
      debug: withLatencyDebug({ currentGoal: goalState.currentGoal, candidates, finalAction: handoff }, latency, modelUsageFromMetas(model, []))
    };
  }

  let candidate = candidates.length === 1 && !candidates[0].requiresJudgment
    ? candidates[0]
    : null;
  let selectorMeta = null;
  if (!candidate) {
    try {
      const selected = await selectCandidate({
        apiKey,
        model: recoveryModel || model,
        goal: goalState.currentGoal,
        candidates,
        observation,
        screenshotDataUrl
      });
      selectorMeta = selected.meta || null;
      latency.verify_plan_model_ms = Number(selectorMeta?.durationMs || 0);
      candidate = candidates.find((item) => item.candidateId === selected.candidateId) || null;
    } catch (error) {
      if (error?.code !== "PLANNER_CANDIDATE_NOT_CURRENT") throw error;
      const reason = `The planner failed ${error.selectionAttempts || 3} bounded selections against the unchanged candidate set for ${goalState.currentGoal.label || goalState.currentGoal.semanticType}.`;
      const handoff = finalHandoffAction(reason, observation, { goalId: goalState.currentGoal.goalId });
      goalState = withUpdate(goalState, { pendingAction: null, lastAction: handoff, status: "awaiting_user" });
      transactionStore?.saveSession?.(goalState);
      return {
        handled: true,
        state: goalState,
        clientDecision: toClientDecision(handoff),
        debug: withLatencyDebug({
          plannerFailureCategory: "candidate_selection_exhausted",
          candidateSelectionAttempts: error.selectionAttempts || 3,
          candidateSetObservationId: observation.observationId || "",
          browserReobserved: false,
          finalAction: handoff
        }, latency, modelUsageFromMetas(recoveryModel || model, selectorMeta?.retryMetas || []))
      };
    }
  }

  if (!candidate) throw new Error("No grounded candidate was selected");
  let action = bindTargetSnapshot(
    actionForCurrentCandidate(goalState.currentGoal, candidate, observation),
    observation
  );
  const policyStartedAt = Date.now();
  let governance = governAction({
    action,
    state: goalState,
    observation,
    traveler,
    approvals: goalState.approvals,
    store: transactionStore,
    turnId: clientTurnId || turnId
  });
  latency.policy_ms = Date.now() - policyStartedAt;
  goalState = governance.state || goalState;

  if (!governance.allow && governance.decision === "recoverable" && governance.code === "TARGET_OUT_OF_VIEW") {
    const scrollAction = viewportRecoveryAction(action, observation, 1);
    const scrollGovernance = governAction({
      action: scrollAction,
      state: goalState,
      observation,
      traveler,
      approvals: goalState.approvals,
      store: transactionStore,
      turnId: clientTurnId || turnId
    });
    if (scrollGovernance.allow) {
      governance = scrollGovernance;
      goalState = scrollGovernance.state || goalState;
      goalState = withUpdate(goalState, {
        pendingAction: {
          status: "viewport_recovery",
          actionId: scrollAction.id,
          goalId: goalState.currentGoal.goalId,
          candidateId: candidate.candidateId,
          candidate,
          recoveryOfAction: action
        },
        lastAction: scrollAction,
        status: "running"
      });
      action = scrollAction;
    }
  }

  if (!governance.allow && governance.decision === "recoverable" && STALE_IDENTITY_CODES.has(governance.code)) {
    const groundingBudget = applyRecoveryBudget(goalState, {
      dispatched: false,
      executed: false,
      verified: false,
      outcome: { code: governance.code }
    });
    goalState = withUpdate(groundingBudget.state, {
      pendingAction: null,
      stallCount: 0
    });
    action = groundingBudget.exhausted
      ? finalHandoffAction(
          "Three fresh profile candidate bindings were rejected before dispatch. Grounded replanning is exhausted.",
          observation,
          { goalId: goalState.currentGoal.goalId }
        )
      : normalizeAction({
          observationId: observation.observationId || "",
          observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
          type: "wait",
          intent: "reobserve_after_grounding_rejection",
          goalId: goalState.currentGoal.goalId,
          candidateId: candidate.candidateId,
          reason: `Discard ${governance.code}, capture a fresh observation, rebuild profile candidates, and replan the same goal.`,
          risk: "safe",
          requiresApproval: false
        });
    goalState = withUpdate(goalState, {
      lastAction: action,
      status: action.type === "ask_user" ? "awaiting_user" : "running"
    });
  } else if (!governance.allow) {
    const reason = `The grounded candidate ${candidate.candidateId} was rejected by the safety governor: ${governance.reason || governance.code}.`;
    action = finalHandoffAction(reason, observation, {
      goalId: goalState.currentGoal.goalId,
      candidateId: candidate.candidateId
    });
    goalState = withUpdate(goalState, { lastAction: action, status: "awaiting_user" });
  } else if (action.type !== "scroll") {
    goalState = withUpdate(goalState, {
      pendingAction: {
        status: "governed",
        actionId: action.id,
        goalId: goalState.currentGoal.goalId,
        candidateId: candidate.candidateId,
        strategyId: candidate.strategyId || candidate.candidateId,
        expectedOutcome: action.expectedOutcome,
        affordance: action.affordance,
        interactionRole: action.interactionRole,
        semanticEffect: action.semanticEffect,
        expectedEvidence: action.expectedEvidence,
        observationId: observation.observationId || ""
      },
      lastAction: action,
      status: "running"
    });
  }

  transactionStore?.recordActionEvent?.(goalState.id, {
    actionId: action.id || "",
    observationId: observation.observationId || "",
    turnId: clientTurnId || turnId,
    stage: governance.allow ? "semantic_candidate_governed" : "semantic_candidate_blocked",
    goalId: goalState.currentGoal.goalId,
    candidateId: candidate.candidateId,
    action,
    result: { allow: governance.allow, code: governance.code || "", reason: governance.reason || "" }
  });
  transactionStore?.saveSession?.(goalState);
  const modelUsage = modelUsageFromMetas(recoveryModel || model, [selectorMeta]);
  const debug = withLatencyDebug({
    currentGoal: goalState.currentGoal,
    candidates: candidates.map((item) => ({
      candidateId: item.candidateId,
      type: item.type,
      operation: item.operation,
      summary: item.summary
    })),
    selectedCandidateId: candidate.candidateId,
    finalAction: action,
    policyDecision: governance
  }, latency, modelUsage);
  writeTrace(dataDir, state.id, {
    turnId,
    screenshotDataUrl,
    observation: traceObservation,
    pageState: null,
    requirements: goalState.activeRequirements || goalState.requirements || [],
    verification: observation.lastActionResult || null,
    plannedAction: { candidateId: candidate.candidateId },
    policyDecision: governance,
    executionResult: { currentGoal: goalState.currentGoal, pendingAction: goalState.pendingAction },
    debug
  });
  return { handled: true, state: goalState, clientDecision: toClientDecision(action), debug };
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
  let classificationMeta = null;
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
        ? null
        : state.pendingAction,
      stallCount: ["rejected_before_dispatch", "observed", "verified"].includes(lifecycle.status)
        ? 0
        : state.stallCount
    });
    transactionStore?.saveSession?.(state);
  }
  if (transition) {
    const preserveViewportRecovery = state.pendingAction?.status === "viewport_recovery";
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
    const exhausted = Number(state.uncertainTransitionCount || 0) > 2;
    const action = exhausted
      ? finalHandoffAction("Fresh browser evidence remained insufficient after bounded reobservation, so I need help before acting.", observation)
      : normalizeAction({
          observationId: observation.observationId || "",
          observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
          type: "wait",
          intent: "reobserve_after_grounding_rejection",
          reason: "The transition evidence is incomplete. Capture one fresh observation and rebind current controls without repeating the action.",
          risk: "safe",
          requiresApproval: false
        });
    const uncertainState = withUpdate(state, { lastAction: action, status: exhausted ? "awaiting_user" : "running" });
    transactionStore?.saveSession?.(uncertainState);
    return {
      state: uncertainState,
      clientDecision: toClientDecision(action),
      debug: withLatencyDebug({ transition, finalAction: action }, latency, modelUsageFromMetas(model, []))
    };
  }

  try {
    const profileTurn = await runProfileSemanticGoalTurn({
      apiKey,
      model,
      recoveryModel,
      dataDir,
      state,
      observation,
      traveler,
      transactionStore,
      clientTurnId,
      screenshotDataUrl,
      traceObservation,
      turnId,
      latency
    });
    state = profileTurn.state || state;
    if (profileTurn.handled) return profileTurn;
  } catch (error) {
    return safePlannerFailureResult({
      dataDir,
      state,
      turnId,
      screenshotDataUrl,
      traceObservation,
      reason: "AI candidate selection failed for the current grounded semantic goal.",
      error,
      latency,
      modelUsage: modelUsageFromMetas(recoveryModel || model, [])
    });
  }

  // A recoverable governor result preserves the semantic action across the
  // observation created by scrolling. Rebind that same action to the fresh
  // canonical registry before consulting the model again.
  if (state.pendingAction?.type === "viewport_rebind" && state.pendingAction.action) {
    const pending = state.pendingAction;
    const reboundAction = rebindPendingRecoveryAction(pending, observation);
    const targetStatus = pendingRecoveryTargetStatus(reboundAction);
    const pendingWithProgress = withViewportProgress(
      pending,
      viewportProgressSample(reboundAction, observation)
    );
    const policyStartedAt = Date.now();
    let recoveryGovernance = targetStatus.exists && targetStatus.inViewport
      ? governAction({
          action: reboundAction,
          state,
          observation,
          traveler,
          approvals: state.approvals,
          store: transactionStore,
          turnId: clientTurnId || turnId
        })
      : {
          state,
          allow: false,
          decision: "recoverable",
          code: targetStatus.exists ? "TARGET_OUT_OF_VIEW" : "TARGET_DISAPPEARED",
          reason: targetStatus.exists
            ? "The fresh observation has not yet confirmed the pending canonical target in the viewport."
            : "The fresh observation cannot currently resolve the pending canonical target."
        };
    latency.policy_ms = Date.now() - policyStartedAt;
    let recoveryState = recoveryGovernance.state || state;
    let finalAction = reboundAction;

    if (recoveryGovernance.allow && targetStatus.exists && targetStatus.inViewport) {
      recoveryState = withUpdate(recoveryState, {
        pendingAction: null,
        lastAction: reboundAction,
        status: "running"
      });
      transactionStore?.recordActionEvent?.(recoveryState.id, {
        actionId: reboundAction.id,
        observationId: observation.observationId || "",
        turnId: clientTurnId || turnId,
        stage: "pending_action_rebound_dispatched",
        recoveryOfActionId: pending.blockedActionId || pending.action?.id || "",
        recoveryCount: pending.recoveryCount || 1,
        action: reboundAction
      });
    } else if (recoveryGovernance.decision === "recoverable"
      && ["TARGET_OUT_OF_VIEW", "TARGET_DISAPPEARED"].includes(recoveryGovernance.code)
      && Number(pendingWithProgress.recoveryCount || 0) < MAX_VIEWPORT_RECOVERY_ATTEMPTS
      && Number(pendingWithProgress.noProgressFailureCount || 0) < MAX_CONSECUTIVE_VIEWPORT_FAILURES) {
      const nextRecoveryCount = Number(pending.recoveryCount || 0) + 1;
      const scrollAction = viewportRecoveryAction(reboundAction, observation, nextRecoveryCount);
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
          pendingAction: {
            ...pendingWithProgress,
            recoveryCount: nextRecoveryCount,
            updatedAt: new Date().toISOString()
          },
          lastAction: scrollAction,
          status: "running"
        });
        transactionStore?.recordActionEvent?.(recoveryState.id, {
          actionId: scrollAction.id,
          observationId: observation.observationId || "",
          turnId: clientTurnId || turnId,
          stage: "pending_action_viewport_recovery_governed",
          recoveryOfActionId: pending.blockedActionId || pending.action?.id || "",
          recoveryCount: nextRecoveryCount,
          action: scrollAction
        });
      } else {
        recoveryGovernance = scrollGovernance;
        finalAction = policyBlockedAction(scrollGovernance, scrollAction);
        recoveryState = withUpdate(recoveryState, {
          pendingAction: null,
          lastAction: finalAction,
          status: "awaiting_user"
        });
      }
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
        recoveryCount: pending.recoveryCount || 1,
        recoveryOfActionId: pending.blockedActionId || pending.action?.id || "",
        freshTargetExists: targetStatus.exists,
        freshTargetInViewport: targetStatus.inViewport,
        viewportProgress: pendingWithProgress.viewportProgress,
        noProgressFailureCount: pendingWithProgress.noProgressFailureCount
      },
      debug
    });
    return { state: recoveryState, clientDecision: toClientDecision(finalAction), debug };
  }

  // The action lifecycle above is the sole authority for unchanged outcomes.
  // A pre-dispatch rejection rebuilds from this observation; only a browser-
  // dispatched unchanged transition consumes an execution strategy attempt.
  const staleRejection = lifecycle?.status === "rejected_before_dispatch";
  const recoverableExecutionFailure = lifecycle?.transitionStatus === "no_effect";

  // 1. Observe + classify typed page state. Requirements are derived from
  // typed buckets, so navigation actions like Continue/Next cannot be
  // misclassified as missing requirements.
  let extracted;
  try {
    extracted = await classifyPageState({ apiKey, model, observation, screenshotDataUrl, traveler });
    classificationMeta = extracted.meta || null;
    latency.classification_model_ms = Number(classificationMeta?.durationMs || 0);
    extracted = {
      ...extracted,
      requirements: requirementsWithDecisionGroups(extracted.requirements || [], observation)
    };
  } catch (error) {
    return safePlannerFailureResult({
      dataDir,
      state,
      turnId,
      screenshotDataUrl,
      traceObservation,
      reason: "AI planner unavailable during page classification. I stopped instead of using a deterministic checkout fallback.",
      error,
      latency,
      modelUsage: modelUsageFromMetas(model, [classificationMeta])
    });
  }

  // 2. Verify + plan in one call: did the previous action work, and given
  // that, what's next. Two OpenAI calls total per turn now, not three.
  let verification;
  let modelPlannedAction;
  let modelSelection;
  const planningModel = model;
  const observationGoal = deriveObservationGoal(observation, extracted.requirements || []);
  const candidateSet = groundedObservationCandidateSet(
    observationGoal,
    observation,
    state.attemptedStrategySignatures || []
  );
  const observationCandidates = candidateSet.candidates;
  state = withUpdate(state, {
    currentGoal: {
      ...observationGoal,
      label: observationGoal.semanticGoal,
      candidateSet,
      candidates: observationCandidates,
      updatedAt: new Date().toISOString()
    }
  });
  transactionStore?.saveSession?.(state);
  try {
    ({ verification, selection: modelSelection, meta: verifyPlanMeta } = await verifyAndPlan({
      apiKey, model: planningModel, state, observation, currentRequirements: extracted.requirements, pageState: extracted.pageState,
      traveler,
      actionHistory,
      screenshotDataUrl,
      candidateSet,
      semanticGoal: observationGoal
    }));
    const selectedCandidate = modelSelection.candidate;
    modelPlannedAction = bindTargetSnapshot(
      actionForCurrentCandidate(observationGoal, selectedCandidate, observation),
      observation
    );
    latency.verify_plan_model_ms = Number(verifyPlanMeta?.durationMs || 0);
  } catch (error) {
    if (error instanceof PlannerContractError) {
      const selectionAttempts = Number(error.details?.selectionAttempts || 3);
      const action = finalHandoffAction(
        `The planner exhausted ${selectionAttempts} bounded reselections against the same unchanged candidate set.`,
        observation,
        { goalId: observationGoal.goalId }
      );
      const contractState = withUpdate(state, {
        pendingAction: null,
        lastAction: action,
        stallCount: 0,
        status: "awaiting_user"
      });
      transactionStore?.recordActionEvent?.(contractState.id, {
        observationId: observation.observationId || "",
        turnId: clientTurnId || turnId,
        stage: "planner_contract_rejected",
        code: error.code,
        details: error.details || {},
        dispatched: false,
        candidateSelectionAttempts: selectionAttempts,
        browserReobserved: false,
        groundingRecoveryAttempts: Number(state.groundingRecoveryAttempts || 0),
        executionRecoveryAttempts: Number(state.executionRecoveryAttempts || 0)
      });
      transactionStore?.saveSession?.(contractState);
      const debug = withLatencyDebug({
        plannerFailureCategory: "contract_rejection",
        plannerContractCode: error.code,
        plannerContractDetails: error.details || {},
        candidateSelectionAttempts: selectionAttempts,
        candidateSetObservationId: candidateSet.observationId || "",
        browserReobserved: false,
        groundingRecoveryAttempts: Number(state.groundingRecoveryAttempts || 0),
        executionRecoveryAttempts: Number(state.executionRecoveryAttempts || 0),
        finalAction: action
      }, latency, modelUsageFromMetas(planningModel, [classificationMeta, verifyPlanMeta]));
      writeTrace(dataDir, state.id, {
        turnId,
        screenshotDataUrl,
        observation: traceObservation,
        pageState: extracted.pageState,
        requirements: extracted.requirements || [],
        verification: null,
        plannedAction: { rejectedCandidateId: error.details?.candidateId || "" },
        policyDecision: { allow: false, decision: "recoverable", code: error.code },
        executionResult: { dispatched: false, contractRejected: true },
        debug
      });
      return { state: contractState, clientDecision: toClientDecision(action), debug };
    }
    return safePlannerFailureResult({
      dataDir,
      state,
      turnId,
      screenshotDataUrl,
      traceObservation,
      reason: "AI planner or model API unavailable while choosing the next action. This is an availability failure, not a planner-contract rejection.",
      error,
      latency,
      modelUsage: modelUsageFromMetas(model, [classificationMeta, verifyPlanMeta])
    });
  }
  const modelUsage = modelUsageFromMetas(planningModel, [classificationMeta, verifyPlanMeta]);

  // Fresh page evidence is the source of truth. The verifier can propose
  // updates, but it may not blindly override current-page unresolved evidence.
  // Contradictions become blockers instead of silently turning into satisfied.
  const mergedRequirements = reconcileRequirements(extracted.requirements, verification, observation);
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
    lastVerification: verification
  });

  if (verification.priceChanged) {
    const amount = parsePriceAmount(observation?.page?.priceText);
    if (amount !== null) {
      nextState = withUpdate(nextState, { priceHistory: [...nextState.priceHistory, { amount, currency: "?", capturedAt: new Date().toISOString() }] });
    }
  }

  // 3. Stall check. Primary signal is the actual missing-requirements count,
  // not the verifier's self-reported changed/lastActionWorked flags — those
  // turned out to say "changed" even across 3 consecutive no-op "wait"
  // actions where the missing count never moved, which let a real stall run
  // for ~90s uncaught. A number we compute ourselves is trustworthy in a way
  // an LLM's self-report about its own progress isn't. This runs after the
  // combined call (it needs the merged count), so a stall still overrides
  // the planned action rather than skipping the call — but that's still one
  // fewer call than the old 3-call version even in the stalling case.
  const missingCount = actionableMissingRequired(activeRequirements).length;
  const hadPreviousCount = typeof state.lastMissingCount === "number";
  const noCountImprovement = hadPreviousCount && missingCount >= state.lastMissingCount;
  const verifierSaysNoProgress = !verification.changed && !verification.lastActionWorked;
  const deterministicAction = null;
  let plannedAction = modelPlannedAction;

  if (!plannedAction || !plannedAction.type) {
    nextState = withUpdate(nextState, { status: "awaiting_user" });
    const reason = "AI planner did not return a next action. I stopped instead of using a deterministic checkout fallback.";
    const clientDecision = askUserDecision(reason, observation);
    const debug = withLatencyDebug(
      summarizeTurn({ pageState: extracted.pageState, requirements: activeRequirements, plannedAction, finalAction: clientDecision, policyDecision: null, deterministicAction }),
      latency,
      modelUsage
    );
    writeTrace(dataDir, state.id, {
      turnId, screenshotDataUrl, observation: traceObservation, pageState: extracted.pageState, requirements: activeRequirements, requirementLifecycle, verification,
      plannedAction, policyDecision: null,
      executionResult: { stopped: true, reason },
      debug
    });
    return {
      state: nextState,
      clientDecision,
      debug
    };
  }

  const samePlannedAction = Boolean(state.lastAction) && actionSignature(state.lastAction) === actionSignature(plannedAction);
  const plannedWait = plannedAction.type === "wait";
  const repeatedNoProgress = !staleRejection
    && !recoverableExecutionFailure
    && Boolean(state.lastAction)
    && (samePlannedAction || plannedWait)
    && (noCountImprovement || verifierSaysNoProgress);
  const stallCount = repeatedNoProgress ? (state.stallCount || 0) + 1 : 0;
  nextState = withUpdate(nextState, { stallCount, lastMissingCount: missingCount });

  if (stallCount >= STALL_THRESHOLD) {
    const reason = `I tried the same thing ${stallCount} times without progress (blockers: ${verification.blockers.join("; ") || "unclear"}). Stopping so you can take over.`;
    nextState = withUpdate(nextState, { status: "awaiting_user" });
    const clientDecision = askUserDecision(reason, observation);
    const debug = withLatencyDebug(
      summarizeTurn({ pageState: extracted.pageState, requirements: activeRequirements, plannedAction, finalAction: clientDecision, policyDecision: null, deterministicAction: null }),
      latency,
      modelUsage
    );
    writeTrace(dataDir, state.id, {
      turnId, screenshotDataUrl, observation: traceObservation, pageState: extracted.pageState, requirements: activeRequirements, requirementLifecycle, verification,
      plannedAction, policyDecision: null,
      executionResult: { stalled: true, reason },
      debug
    });
    return {
      state: nextState,
      clientDecision,
      debug
    };
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
      nextState = withUpdate(scrollGovernance.state || nextState, {
        pendingAction: pendingViewportRecovery(executablePlannedAction, 1, observation),
        lastAction: scrollAction,
        status: "running"
      });
      transactionStore?.recordActionEvent?.(nextState.id, {
        actionId: scrollAction.id,
        observationId: observation.observationId || "",
        turnId: clientTurnId || turnId,
        stage: "pending_action_viewport_recovery_governed",
        recoveryOfActionId: executablePlannedAction.id,
        recoveryCount: 1,
        action: scrollAction
      });
    } else {
      finalAction = policyBlockedAction(scrollGovernance, scrollAction);
    }
  } else if (!governance.allow && governance.decision === "recoverable" && STALE_IDENTITY_CODES.has(governance.code)) {
    const groundingBudget = applyRecoveryBudget(nextState, {
      dispatched: false,
      executed: false,
      verified: false,
      outcome: { code: governance.code }
    });
    nextState = withUpdate(groundingBudget.state, { pendingAction: null, stallCount: 0 });
    transactionStore?.recordActionEvent?.(nextState.id, {
      actionId: executablePlannedAction.id || "",
      observationId: observation.observationId || "",
      turnId: clientTurnId || turnId,
      stage: "grounding_replan",
      code: governance.code,
      dispatched: false,
      groundingRecoveryAttempts: groundingBudget.groundingRecoveryAttempts,
      executionRecoveryAttempts: groundingBudget.executionRecoveryAttempts
    });
    finalAction = groundingBudget.exhausted
      ? finalHandoffAction(
          "Three fresh candidate sets were rejected before dispatch. Grounded replanning is exhausted.",
          observation
        )
      : normalizeAction({
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

  nextState = withUpdate(nextState, {
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

  return {
    state: nextState,
    clientDecision: toClientDecision(finalAction),
    debug
  };
}

module.exports = {
  runLoopTurn,
  toClientDecision,
  askUserDecision,
  __private: {
    actionableMissingRequired,
    activeRequirementView,
    bindTargetSnapshot,
    buildControlAliasIndex,
    canonicalRequirementLifecycle,
    controlDecisionGroupId,
    decisionGroupForRequirement,
    deterministicRequirementEvidence,
    expectedOutcomeForAction,
    applyRecoveryBudget,
    applyTransitionStatus,
    candidateStrategySignature,
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
