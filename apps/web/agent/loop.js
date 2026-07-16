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
const { verifyAndPlan } = require("./verify-and-plan");
const { governAction } = require("./action-governor");
const { buildControlAliasIndex, resolveActionControl } = require("./control-alias-index");
const {
  advanceSkillPlan,
  createSkillPlan,
  expandSkillAction,
  failSkillAction,
  prepareSkillViewportRecovery,
  profileStageReadiness,
  resumeSuspendedSkillPlan,
  skillRecoveryContext,
  blockedObligationForPlan,
  recordBlockedObligationAttempt,
  reconcileBlockedObligationResult
} = require("./skill-expander");
const { writeTrace } = require("./trace-store");
const { normalizeAction, actionSignature } = require("../../../packages/shared/agent-actions");
const { withUpdate, normalizeStep } = require("../../../packages/shared/agent-state");
const { missingRequired, normalizeRequirement } = require("../../../packages/shared/requirements");

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
  if (group.status === "satisfied") return "safe";
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
    type: decisionGroupRequirementType(group),
    label: group.sectionLabel || group.sectionType || group.requirementId || group.decisionGroupId || `Decision ${index + 1}`,
    status: group.status === "satisfied" ? "satisfied" : (group.status || "missing"),
    required: Boolean(group.required),
    risk: decisionGroupRisk(group),
    evidence: [
      ...(group.evidence || []),
      group.selectedLabel ? `Selected option: ${group.selectedLabel}` : ""
    ].filter(Boolean).slice(0, 5),
    confidence: group.status === "satisfied" ? 0.95 : 0.9,
    targetIds: [
      group.decisionGroupId,
      group.sectionId,
      group.requirementId,
      ...(group.alternatives || []).flatMap((choice) => [choice.controlId, choice.targetId])
    ].filter(Boolean).slice(0, 10)
  }, index);
}

function withDecisionGroupFields(requirement = {}, group = {}) {
  return {
    ...requirement,
    decisionGroupId: group.decisionGroupId || "",
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
    })).slice(0, 16)
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
  if (requirement.status === "satisfied") return "complete";
  if (requirement.status === "conflicted") return "conflicted";
  if (requirement.status === "blocked") return "blocked";
  if (requirement.status === "needs_user") return "needs_user";
  if (requirement.status === "missing") return "pending";
  return "unknown";
}

function lifecycleStatusForRequirement(requirement = {}) {
  if (requirement.status === "satisfied") return "satisfied";
  if (requirement.status === "conflicted") return "conflicted";
  if (requirement.status === "blocked") return "blocked";
  if (requirement.status === "needs_user") return "blocked";
  return "active";
}

function activeSurfaceForRequirement(requirement = {}, page = {}) {
  const surfaces = [page.currentSurface, page.activeSurface].filter((surface) => surface?.type && surface.type !== "page");
  return surfaces.find((surface) => {
    if (!surface) return false;
    if (requirement.decisionGroupId && surface.decisionGroupId === requirement.decisionGroupId) return true;
    if (requirement.decisionGroupId && String(requirement.decisionGroupId).includes(String(surface.id || "__none__"))) return true;
    if ((requirement.targetIds || []).includes(surface.id)) return true;
    if (requirement.sectionId && requirement.sectionId === surface.id) return true;
    return false;
  }) || null;
}

function requirementScope(requirement = {}, observation = {}, pageStep = "") {
  const page = observation?.page || {};
  const surface = activeSurfaceForRequirement(requirement, page);
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
      resolvedByActionId: lifecycleStatus === "satisfied" ? lastActionId : "",
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
  const fields = page.fields || [];

  const decisionGroup = decisionGroupForRequirement(requirement, page);
  if (decisionGroup) {
    return {
      source: "deterministic_decision_group",
      status: decisionGroup.status === "satisfied" ? "satisfied" : "missing",
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
  if (!requirement || requirement.status === "satisfied") return false;
  const update = verifierUpdateForRequirement(verification, requirement.id);
  const verifierClaimsSatisfied = update?.proposedStatus === "satisfied";
  if (!verifierClaimsSatisfied) return false;
  return !updateHasCurrentEvidence(update, observation, requirement);
}

function reconcileRequirements(freshRequirements = [], verification = {}, observation = {}) {
  return freshRequirements.map((requirement) => {
    const deterministic = deterministicRequirementEvidence(requirement, observation);
    const update = verifierUpdateForRequirement(verification, requirement.id);
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

    if (requirement.status === "satisfied") return requirement;

    if (requirementConflict(requirement, verification, observation)) {
      return {
        ...requirement,
        status: "conflicted",
        required: true,
        risk: requirement.risk || "uncertain",
        evidence: [
          ...(requirement.evidence || []),
          "CONTRADICTORY_REQUIREMENT_STATE: fresh page evidence says unresolved, verifier claimed satisfied without same-observation proof."
        ].slice(0, 5)
      };
    }

    if (updateHasCurrentEvidence(update, observation, requirement)) {
      return {
        ...requirement,
        status: "satisfied",
        confidence: Math.max(requirement.confidence || 0, update.confidence || 0)
      };
    }

    return requirement;
  });
}

function policyBlockedAction(governance, action) {
  if (governance.allow) return action;
  const reason = governance.reason || action.reason || "The action governor blocked the planned action.";
  return normalizeAction({
    id: `${action.id || `act_${Date.now().toString(36)}`}:blocked`,
    observationId: action.observationId || "",
    observationHash: action.observationHash || "",
    type: "ask_user",
    reason,
    risk: "uncertain",
    requiresApproval: true
  });
}

function deterministicProfileOwnershipAction(observation = {}) {
  return normalizeAction({
    id: `act_profile_owner_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    observationId: observation.observationId || "",
    observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
    type: "fill_visible_profile_fields",
    intent: "fill_profile_fields",
    risk: "safe",
    requiresApproval: false,
    reason: "Deterministic traveler/contact readiness owns this stage before general planning."
  });
}

function ownedSkillRecoveryAction(action = {}, context = null, observation = {}) {
  if (!context?.atomId || !context?.controlId) return action;
  const page = observation.page || {};
  const resolution = resolveActionControl(action, page);
  const targetsOwnedControl = resolution.ok && resolution.control?.controlId === context.controlId;
  const visualRecovery = action.type === "click_xy";
  const suppliedRegion = action.visualRegion || {};
  const matchesRecoveryRegion = (context.recovery?.regions || []).some((region) => (
    Math.abs(Number(region.x) - Number(suppliedRegion.x)) <= 2
    && Math.abs(Number(region.y) - Number(suppliedRegion.y)) <= 2
    && Math.abs(Number(region.width) - Number(suppliedRegion.width)) <= 2
    && Math.abs(Number(region.height) - Number(suppliedRegion.height)) <= 2
  ));
  const observationalRecovery = ["scroll", "wait", "ask_user"].includes(action.type);
  if (visualRecovery && !matchesRecoveryRegion) {
    return normalizeAction({
      observationId: observation.observationId || "",
      observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
      type: "wait",
      intent: "recover_skill_observation",
      skillPlanId: context.planId,
      skillAtomId: context.atomId,
      controlId: context.controlId,
      reason: `Rejected an unbound coordinate for ${context.label || context.semanticType}; collect a fresh observation and use only a supplied recovery region.`,
      risk: "safe",
      requiresApproval: false
    });
  }
  if (!targetsOwnedControl && !visualRecovery && !observationalRecovery) {
    return normalizeAction({
      observationId: observation.observationId || "",
      observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
      type: "wait",
      intent: "recover_skill_observation",
      skillPlanId: context.planId,
      skillAtomId: context.atomId,
      controlId: context.controlId,
      reason: `The proposed action would bypass unresolved ${context.label || context.semanticType}; reobserve that owned prerequisite instead.`,
      risk: "safe",
      requiresApproval: false
    });
  }
  const expectedOutcome = context.operation === "open"
    ? {
        type: "options_surface_appeared",
        controlId: context.controlId,
        previousSurfaceId: (page.currentSurface?.type && page.currentSurface.type !== "page" ? page.currentSurface.id : page.activeSurface?.id) || "",
        previousExpanded: Boolean(context.state?.expanded)
      }
    : action.expectedOutcome || null;
  return normalizeAction({
    ...action,
    intent: observationalRecovery ? "recover_skill_observation" : "recover_skill_atom",
    operation: observationalRecovery ? "" : context.operation,
    skillPlanId: context.planId,
    skillAtomId: context.atomId,
    controlId: visualRecovery ? context.controlId : action.controlId,
    expectedOutcome,
    reason: `${action.reason || "Recover the unresolved profile control."} Owned prerequisite: ${context.label || context.semanticType}.`
  });
}

function sameRegion(left = {}, right = {}) {
  return ["x", "y", "width", "height"].every((key) => Math.abs(Number(left[key]) - Number(right[key])) <= 2);
}

function canonicalBlockedRecoveryAction(obligation = {}, observation = {}) {
  const page = observation.page || {};
  const control = (page.controls || []).find((item) => item.controlId === obligation.control?.controlId);
  if (!control) return null;
  const operation = obligation.operation || "";
  const attemptedTargets = new Set((obligation.attempts || [])
    .filter((attempt) => attempt.operation === operation)
    .map((attempt) => attempt.targetId || `${attempt.actionType}:${attempt.visualRegion?.x || ""}:${attempt.visualRegion?.y || ""}`));
  const capability = control.operations?.[operation] || null;
  const targetId = (capability?.actuatorIds || []).find((id) => id && !attemptedTargets.has(id));
  const base = {
    id: `act_blocked_recovery_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    observationId: observation.observationId || "",
    observationHash: observation.observationSnapshot?.snapshotHash || page.snapshotHash || "",
    intent: "recover_skill_atom",
    operation,
    skillPlanId: obligation.owner?.skillPlanId || "",
    skillAtomId: obligation.owner?.atomId || "",
    controlId: control.controlId,
    targetLabel: `${control.label || obligation.control?.label || obligation.control?.semanticType || "control"} ${operation}`,
    expectedOutcome: obligation.recoveryExpectedOutcome || null,
    risk: "safe",
    requiresApproval: false
  };
  if (targetId) {
    return normalizeAction({
      ...base,
      type: operation === "type" ? "type" : operation === "select" ? "select" : "click",
      targetId,
      reason: `Execute the next untried canonical ${operation} actuator for the blocked ${obligation.control?.label || obligation.control?.semanticType}.`
    });
  }
  const recovery = control.recovery?.[operation];
  const annotations = page.screenshotAnnotations || [];
  const region = (recovery?.regions || []).find((candidate) => {
    const regionKey = `click_xy:${candidate.x}:${candidate.y}`;
    if (attemptedTargets.has(regionKey)) return false;
    return annotations.some((annotation) => (
      annotation.controlId === control.controlId
      && annotation.source === `control.recovery.${operation}`
      && sameRegion(annotation.box || {}, candidate)
    ));
  });
  if (!region || recovery?.requiresVisualConfirmation !== true) return null;
  return normalizeAction({
    ...base,
    type: "click_xy",
    targetId: "",
    x: Number(region.centerX || (Number(region.x) + Number(region.width) / 2)),
    y: Number(region.centerY || (Number(region.y) + Number(region.height) / 2)),
    visualRegion: region,
    reason: `Execute the screenshot-confirmed bounded ${operation} region for the blocked ${obligation.control?.label || obligation.control?.semanticType}.`
  });
}

function resolvedBlockedObligation(obligation = {}, plan = {}, result = {}, observation = {}) {
  if (!obligation?.owner?.atomId || obligation.owner.atomId !== result.skillAtomId) return obligation;
  const atom = (plan.atoms || []).find((item) => item.atomId === obligation.owner.atomId);
  const expected = obligation.expectedResult || {};
  const control = (observation.page?.controls || []).find((item) => item.controlId === expected.controlId);
  const finalValueMatches = !expected.expectedNormalizedValue
    || String(control?.state?.normalizedValue || "") === String(expected.expectedNormalizedValue);
  const exactFinalResult = result.executed === true
    && result.verified === true
    && result.skillPlanId === obligation.owner.skillPlanId
    && result.skillAtomId === obligation.owner.atomId
    && result.expectedOutcome?.type === expected.type
    && String(result.expectedOutcome?.controlId || "") === String(expected.controlId || "")
    && finalValueMatches;
  if (!atom || !["complete", "satisfied"].includes(atom.status) || !exactFinalResult) return obligation;
  return {
    ...obligation,
    status: "resolved",
    finalStatus: "satisfied",
    finalReason: expected.expectedNormalizedValue
      ? `The blocked control retained ${expected.expectedNormalizedValue}.`
      : "The blocked atom completed with exact governed verification.",
    resolvedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
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
      attempt: recoveryCount
    },
    risk: "safe",
    requiresApproval: false,
    reason: `Governed viewport recovery for ${blockedAction.targetLabel || blockedAction.controlId || "the pending canonical control"}.`
  });
}

function pendingViewportRecovery(blockedAction = {}, recoveryCount = 1) {
  return {
    type: "viewport_rebind",
    action: normalizeAction({
      ...blockedAction,
      targetSnapshot: null,
      expectedOutcome: null
    }),
    recoveryCount,
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
    activeSurface: pageState?.activeSurface || null
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
    skillPlanId: action.skillPlanId || "",
    skillAtomId: action.skillAtomId || "",
    requirementId: action.requirementId || "",
    controlId: action.controlId || action.targetSnapshot?.controlId || "",
    targetId: action.targetId || "",
    targetLabel: action.targetLabel || "",
    targetSnapshot: action.targetSnapshot || null,
    decisionGroupId: action.decisionGroupId || action.targetSnapshot?.decisionGroupId || "",
    expectedOutcome: action.expectedOutcome || null,
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
  return toClientDecision(normalizeAction({
    type: "ask_user",
    observationId: observation.observationId || "",
    observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
    reason,
    risk: "uncertain",
    requiresApproval: true
  }));
}

function normalizeText(value = "") {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function targetCandidateSnapshot(candidate = {}, source = "", surface = {}) {
  if (!candidate) return null;
  return {
    id: String(candidate.id || ""),
    controlId: String(candidate.controlId || ""),
    visualRef: String(candidate.visualRef || ""),
    decisionGroupId: String(candidate.decisionGroupId || ""),
    label: String(candidate.label || ""),
    normalizedLabel: normalizeText(candidate.label || ""),
    role: String(candidate.role || ""),
    accessibleName: String(candidate.accessibility?.name || candidate.accessibleName || ""),
    accessibilityState: candidate.accessibility?.state || null,
    risk: String(candidate.risk || ""),
    semantic: String(candidate.semantic || ""),
    kind: String(candidate.kind || candidate.field || candidate.type || ""),
    controlKind: String(candidate.controlKind || candidate.kind || candidate.field || candidate.type || ""),
    state: candidate.controlState || candidate.state || null,
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
  if (!["click", "click_xy", "select", "type"].includes(action.type)) return null;
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
      type: control.surfaceType || (control.sectionId ? "section" : "page"),
      id: control.surfaceId || control.sectionId || "",
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
    surfaceId: action.visualRegion?.surfaceId || (page.currentSurface && page.currentSurface.type !== "page" ? page.currentSurface?.id : page.activeSurface?.id) || "",
    surfaceType: (page.currentSurface && page.currentSurface.type !== "page" ? page.currentSurface?.type : page.activeSurface?.type) || "page",
    surfaceLabel: (page.currentSurface && page.currentSurface.type !== "page" ? page.currentSurface?.label : page.activeSurface?.label) || "",
    surfaceNormalizedLabel: normalizeText((page.currentSurface && page.currentSurface.type !== "page" ? page.currentSurface?.label : page.activeSurface?.label) || "")
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
  const candidates = [page.currentSurface, page.activeSurface].filter(Boolean);
  const surface = candidates.find((item) => item?.type && item.type !== "page") || null;
  if (!surface) return null;
  if (target.surfaceId && surface.id && target.surfaceId !== surface.id) return null;
  return surface;
}

function shouldRequireSurfaceDismissal(action = {}, page = {}) {
  const target = action.targetSnapshot || {};
  if (action.intent !== "decline_optional_extra") return false;
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
    const requirementId = action.requirementId || target.decisionGroupId || "";
    if (!requirementId) return null;
    return {
      type: "requirement_status",
      requirementId,
      status: "satisfied",
      targetId: action.targetId || target.id || "",
      decisionGroupId: action.decisionGroupId || target.decisionGroupId || "",
      sectionId: target.sectionId || "",
      sectionType: target.sectionType || "",
      sectionLabel: target.sectionLabel || "",
      surfaceId: target.surfaceId || "",
      intent: action.intent,
      mustNotIncreasePrice: true
    };
  }
  if (action.intent === "open_choice_control") {
    return {
      type: "active_surface_change",
      targetId: action.targetId || target.id || "",
      decisionGroupId: action.decisionGroupId || target.decisionGroupId || "",
      sectionId: target.sectionId || "",
      sectionType: target.sectionType || "",
      sectionLabel: target.sectionLabel || "",
      surfaceId: target.surfaceId || "",
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
  const failureAction = normalizeAction({
    observationId: traceObservation?.observationId || "",
    observationHash: traceObservation?.observationSnapshot?.snapshotHash || traceObservation?.page?.snapshotHash || "",
    type: "ask_user",
    reason,
    risk: "uncertain",
    requiresApproval: true
  });
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

  if (state.blockedObligation && observation.lastActionResult?.actionId) {
    const reconciledObligation = reconcileBlockedObligationResult(state.blockedObligation, observation.lastActionResult);
    state = withUpdate(state, { blockedObligation: reconciledObligation.obligation });
    transactionStore?.saveSession?.(state);
  }

  if (state.activeSkillPlan?.status === "suspended") {
    const recoveryResume = resumeSuspendedSkillPlan(
      state.activeSkillPlan,
      observation,
      traveler,
      observation.lastActionResult || {},
      state.blockedObligation
    );
    if (recoveryResume.resumable) {
      state = withUpdate(state, {
        activeSkillPlan: recoveryResume.plan,
        blockedObligation: {
          ...state.blockedObligation,
          status: "recovered",
          updatedAt: new Date().toISOString()
        },
        status: "running"
      });
      transactionStore?.recordActionEvent?.(state.id, {
        actionId: observation.lastActionResult?.actionId || "",
        observationId: observation.observationId || "",
        turnId: clientTurnId || turnId,
        stage: "skill_recovery_resumed",
        skillPlanId: recoveryResume.plan.planId,
        skillAtomId: recoveryResume.atom?.atomId || "",
        recoveryContext: recoveryResume.context
      });
      transactionStore?.saveSession?.(state);
    }
  }

  // Known traveler/contact obligations are deterministic transaction work.
  // Establish ownership before either model call so profile completion cannot
  // depend on the planner voluntarily proposing a compound fill action.
  const profileReadiness = profileStageReadiness(observation, traveler);
  const existingSkillStatus = state.activeSkillPlan?.status || "";
  if (profileReadiness.shouldOwn && !["running", "suspended"].includes(existingSkillStatus)) {
    const ownershipAction = deterministicProfileOwnershipAction(observation);
    const ownershipPlan = createSkillPlan(ownershipAction, observation, traveler);
    if (ownershipPlan?.status === "running") {
      state = withUpdate(state, {
        activeSkillPlan: ownershipPlan,
        status: "running"
      });
      transactionStore?.recordActionEvent?.(state.id, {
        actionId: ownershipAction.id,
        observationId: observation.observationId || "",
        turnId: clientTurnId || turnId,
        stage: "skill_plan_created",
        skill: ownershipPlan.skillType,
        skillPlanId: ownershipPlan.planId,
        atomCount: ownershipPlan.atoms?.length || 0,
        ownership: "deterministic_profile_stage",
        readiness: profileReadiness
      });
      transactionStore?.saveSession?.(state);
    }
  }

  // A persisted skill owns its predictable next atoms. Resume it before any
  // model call, but still bind and govern exactly one atom against this fresh
  // observation. The AI is consulted again only after completion or when the
  // live page/result no longer matches the skill contract.
  if (state.activeSkillPlan?.status === "running") {
    const previousDispatchedAtom = (state.activeSkillPlan.atoms || []).find((atom) => atom.status === "dispatched") || null;
    const resumed = advanceSkillPlan(
      state.activeSkillPlan,
      observation,
      traveler,
      observation.lastActionResult || {}
    );
    let skillState = withUpdate(state, {
      activeSkillPlan: resumed.plan,
      lastVerification: observation.lastActionResult || state.lastVerification,
      stallCount: 0
    });
    if (state.blockedObligation) {
      skillState = withUpdate(skillState, {
        blockedObligation: resolvedBlockedObligation(
          state.blockedObligation,
          resumed.plan,
          observation.lastActionResult || {},
          observation
        )
      });
    }
    if (previousDispatchedAtom && resumed.plan.atoms?.find((atom) => atom.atomId === previousDispatchedAtom.atomId)?.status === "complete") {
      transactionStore?.recordActionEvent?.(skillState.id, {
        actionId: previousDispatchedAtom.lastActionId || "",
        observationId: observation.observationId || "",
        turnId: clientTurnId || turnId,
        stage: "skill_atom_verified",
        skillPlanId: resumed.plan.planId,
        skillAtomId: previousDispatchedAtom.atomId,
        result: observation.lastActionResult || null
      });
    }
    if (resumed.status === "action") {
      const executableAction = bindTargetSnapshot(resumed.action, observation);
      const policyStartedAt = Date.now();
      let governance = governAction({
        action: executableAction,
        state: skillState,
        observation,
        traveler,
        approvals: skillState.approvals,
        store: transactionStore,
        turnId: clientTurnId || turnId
      });
      latency.policy_ms = Date.now() - policyStartedAt;
      skillState = governance.state || skillState;
      let finalAction = executableAction;
      if (!governance.allow) {
        if (governance.decision === "recoverable" && governance.code === "TARGET_OUT_OF_VIEW") {
          const recovery = prepareSkillViewportRecovery(
            resumed.plan,
            executableAction.id,
            observation.observationId || ""
          );
          if (recovery.recovered) {
            const scrollAction = viewportRecoveryAction(
              executableAction,
              observation,
              recovery.atom?.viewportRecoveryCount || 1
            );
            const scrollGovernance = governAction({
              action: scrollAction,
              state: skillState,
              observation,
              traveler,
              approvals: skillState.approvals,
              store: transactionStore,
              turnId: clientTurnId || turnId
            });
            governance = scrollGovernance;
            if (scrollGovernance.allow) {
              skillState = withUpdate(scrollGovernance.state || skillState, {
                activeSkillPlan: recovery.plan,
                lastAction: scrollAction,
                status: "running"
              });
              finalAction = scrollAction;
              transactionStore?.recordActionEvent?.(skillState.id, {
                actionId: scrollAction.id,
                observationId: observation.observationId || "",
                turnId: clientTurnId || turnId,
                stage: "skill_viewport_recovery_dispatched",
                skillPlanId: recovery.plan.planId,
                skillAtomId: recovery.atom?.atomId || "",
                recoveryOfActionId: executableAction.id,
                action: scrollAction
              });
            } else {
              const failedPlan = failSkillAction(
                resumed.plan,
                executableAction.id,
                scrollGovernance.reason || "The action governor blocked viewport recovery.",
                observation.observationId || ""
              );
              skillState = withUpdate(skillState, { activeSkillPlan: failedPlan, status: "awaiting_user" });
              finalAction = policyBlockedAction(scrollGovernance, scrollAction);
            }
          } else {
            skillState = withUpdate(skillState, { activeSkillPlan: recovery.plan, status: "awaiting_user" });
            finalAction = policyBlockedAction(governance, executableAction);
          }
        } else {
          const failedPlan = failSkillAction(
            resumed.plan,
            executableAction.id,
            governance.reason || "The action governor blocked this skill atom.",
            observation.observationId || ""
          );
          skillState = withUpdate(skillState, { activeSkillPlan: failedPlan, status: "awaiting_user" });
          finalAction = policyBlockedAction(governance, executableAction);
        }
      } else {
        skillState = withUpdate(skillState, {
          activeSkillPlan: resumed.plan,
          lastAction: executableAction,
          status: "running"
        });
        transactionStore?.recordActionEvent?.(skillState.id, {
          actionId: executableAction.id,
          observationId: observation.observationId || "",
          turnId: clientTurnId || turnId,
          stage: "skill_atom_dispatched",
          skillPlanId: resumed.plan.planId,
          skillAtomId: resumed.atom?.atomId || "",
          action: executableAction
        });
      }
      finalAction = bindTargetSnapshot(finalAction, observation);
      skillState = withUpdate(skillState, { lastAction: finalAction });
      transactionStore?.saveSession?.(skillState);
      const debug = withLatencyDebug({
        ...summarizeTurn({
          pageState: null,
          requirements: skillState.activeRequirements || skillState.requirements || [],
          plannedAction: resumed.action,
          finalAction,
          policyDecision: governance,
          deterministicAction: resumed.action
        }),
        skill: {
          planId: resumed.plan.planId,
          atomId: resumed.atom?.atomId || "",
          status: resumed.plan.status,
          remaining: (resumed.plan.atoms || []).filter((atom) => atom.status === "pending" || atom.status === "dispatched").length
        }
      }, latency, modelUsageFromMetas(model, []));
      writeTrace(dataDir, state.id, {
        turnId,
        screenshotDataUrl,
        observation: traceObservation,
        pageState: null,
        requirements: skillState.activeRequirements || skillState.requirements || [],
        requirementLifecycle: skillState.requirementLifecycle || [],
        verification: observation.lastActionResult || null,
        plannedAction: resumed.action,
        policyDecision: governance,
        executionResult: { skillPlanId: resumed.plan.planId, skillAtomId: resumed.atom?.atomId || "" },
        debug
      });
      return { state: skillState, clientDecision: toClientDecision(finalAction), debug };
    }

    const skillStage = resumed.status === "complete" ? "skill_completed" : "skill_suspended";
    transactionStore?.recordActionEvent?.(skillState.id, {
      actionId: previousDispatchedAtom?.lastActionId || "",
      observationId: observation.observationId || "",
      turnId: clientTurnId || turnId,
      stage: skillStage,
      skillPlanId: resumed.plan.planId,
      reason: resumed.reason || ""
    });
    transactionStore?.saveSession?.(skillState);
    state = skillState;
  }

  if (state.activeSkillPlan?.status === "suspended") {
    const obligation = blockedObligationForPlan(
      state.activeSkillPlan,
      observation,
      traveler,
      state.blockedObligation,
      { code: "SKILL_ATOM_BLOCKED", message: state.activeSkillPlan.suspendedReason }
    );
    if (obligation) {
      const recoveryAction = canonicalBlockedRecoveryAction(obligation, observation);
      if (recoveryAction && (obligation.attempts || []).length < 3) {
        const executableAction = bindTargetSnapshot(recoveryAction, observation);
        const policyStartedAt = Date.now();
        const governance = governAction({
          action: executableAction,
          state: withUpdate(state, { blockedObligation: obligation }),
          observation,
          traveler,
          approvals: state.approvals,
          store: transactionStore,
          turnId: clientTurnId || turnId
        });
        latency.policy_ms = Date.now() - policyStartedAt;
        if (governance.allow) {
          const attemptedObligation = recordBlockedObligationAttempt(obligation, executableAction);
          const recoveryState = withUpdate(governance.state || state, {
            blockedObligation: attemptedObligation,
            lastAction: executableAction,
            status: "running"
          });
          transactionStore?.recordActionEvent?.(recoveryState.id, {
            actionId: executableAction.id,
            observationId: observation.observationId || "",
            turnId: clientTurnId || turnId,
            stage: "blocked_obligation_recovery_dispatched",
            obligationId: attemptedObligation.obligationId,
            skillPlanId: attemptedObligation.owner.skillPlanId,
            skillAtomId: attemptedObligation.owner.atomId,
            controlId: attemptedObligation.control.controlId,
            operation: attemptedObligation.operation,
            expectedOutcome: attemptedObligation.recoveryExpectedOutcome,
            action: executableAction
          });
          transactionStore?.saveSession?.(recoveryState);
          const debug = withLatencyDebug({
            blockedObligation: attemptedObligation,
            plannedAction: recoveryAction,
            finalAction: executableAction,
            policyDecision: governance
          }, latency, modelUsageFromMetas(model, []));
          writeTrace(dataDir, state.id, {
            turnId,
            screenshotDataUrl,
            observation: traceObservation,
            pageState: null,
            requirements: recoveryState.activeRequirements || recoveryState.requirements || [],
            requirementLifecycle: recoveryState.requirementLifecycle || [],
            verification: observation.lastActionResult || null,
            plannedAction: recoveryAction,
            policyDecision: governance,
            executionResult: { blockedObligation: attemptedObligation },
            debug
          });
          return { state: recoveryState, clientDecision: toClientDecision(executableAction), debug };
        }
      }
      const exhausted = (obligation.attempts || []).length >= 3;
      const handedOff = {
        ...obligation,
        status: "handed_off",
        finalStatus: "handed_off",
        finalReason: exhausted
          ? "All bounded canonical recovery candidates were exhausted."
          : "No screenshot-confirmed or canonical actuator remains for this exact operation.",
        updatedAt: new Date().toISOString()
      };
      const handoffAction = normalizeAction({
        id: `act_blocked_handoff_${Date.now().toString(36)}`,
        observationId: observation.observationId || "",
        observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
        type: "ask_user",
        skillPlanId: handedOff.owner.skillPlanId,
        skillAtomId: handedOff.owner.atomId,
        controlId: handedOff.control.controlId,
        reason: `${handedOff.control.label || handedOff.control.semanticType} remains blocked: ${handedOff.finalReason}`,
        risk: "uncertain",
        requiresApproval: true
      });
      const handoffState = withUpdate(state, {
        blockedObligation: handedOff,
        lastAction: handoffAction,
        status: "awaiting_user"
      });
      transactionStore?.saveSession?.(handoffState);
      return {
        state: handoffState,
        clientDecision: toClientDecision(handoffAction),
        debug: withLatencyDebug({ blockedObligation: handedOff, finalAction: handoffAction }, latency, modelUsageFromMetas(model, []))
      };
    }
  }

  // A recoverable governor result preserves the semantic action across the
  // observation created by scrolling. Rebind that same action to the fresh
  // canonical registry before consulting the model again.
  if (state.pendingRecoveryAction?.type === "viewport_rebind" && state.pendingRecoveryAction.action) {
    const pending = state.pendingRecoveryAction;
    const reboundAction = rebindPendingRecoveryAction(pending, observation);
    const policyStartedAt = Date.now();
    let recoveryGovernance = governAction({
      action: reboundAction,
      state,
      observation,
      traveler,
      approvals: state.approvals,
      store: transactionStore,
      turnId: clientTurnId || turnId
    });
    latency.policy_ms = Date.now() - policyStartedAt;
    let recoveryState = recoveryGovernance.state || state;
    let finalAction = reboundAction;

    if (recoveryGovernance.allow) {
      recoveryState = withUpdate(recoveryState, {
        pendingRecoveryAction: null,
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
      && recoveryGovernance.code === "TARGET_OUT_OF_VIEW"
      && Number(pending.recoveryCount || 0) < 2) {
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
          pendingRecoveryAction: {
            ...pending,
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
          stage: "pending_action_viewport_recovery_dispatched",
          recoveryOfActionId: pending.blockedActionId || pending.action?.id || "",
          recoveryCount: nextRecoveryCount,
          action: scrollAction
        });
      } else {
        recoveryGovernance = scrollGovernance;
        finalAction = policyBlockedAction(scrollGovernance, scrollAction);
        recoveryState = withUpdate(recoveryState, {
          pendingRecoveryAction: null,
          lastAction: finalAction,
          status: "awaiting_user"
        });
      }
    } else {
      finalAction = policyBlockedAction(recoveryGovernance, reboundAction);
      recoveryState = withUpdate(recoveryState, {
        pendingRecoveryAction: null,
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
        recoveryOfActionId: pending.blockedActionId || pending.action?.id || ""
      },
      debug
    });
    return { state: recoveryState, clientDecision: toClientDecision(finalAction), debug };
  }

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
  const recoveryContext = state.activeSkillPlan?.status === "suspended"
    ? skillRecoveryContext(state.activeSkillPlan, observation, traveler)
    : null;
  const recoveryAttempts = Number(state.blockedObligation?.attempts?.length || 0);
  const planningModel = recoveryContext && recoveryAttempts > 0 && recoveryModel ? recoveryModel : model;
  try {
    ({ verification, action: modelPlannedAction, meta: verifyPlanMeta } = await verifyAndPlan({
      apiKey, model: planningModel, state, observation, currentRequirements: extracted.requirements, pageState: extracted.pageState,
      traveler, actionHistory, screenshotDataUrl, skillRecovery: recoveryContext
    }));
    latency.verify_plan_model_ms = Number(verifyPlanMeta?.durationMs || 0);
  } catch (error) {
    return safePlannerFailureResult({
      dataDir,
      state,
      turnId,
      screenshotDataUrl,
      traceObservation,
      reason: "AI planner unavailable while choosing the next action. I stopped instead of using a deterministic checkout fallback.",
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
  let plannedAction = ownedSkillRecoveryAction(modelPlannedAction, recoveryContext, observation);
  if (recoveryContext && recoveryAttempts >= 3 && !["ask_user", "stop"].includes(plannedAction.type)) {
    plannedAction = normalizeAction({
      observationId: observation.observationId || "",
      observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
      type: "ask_user",
      skillPlanId: recoveryContext.planId,
      skillAtomId: recoveryContext.atomId,
      reason: `The unresolved ${recoveryContext.label || recoveryContext.semanticType} control still has no proven actuator after three bounded semantic/visual recovery attempts.`,
      risk: "uncertain",
      requiresApproval: true
    });
  }

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
  const repeatedNoProgress = Boolean(state.lastAction) && (samePlannedAction || plannedWait) && (noCountImprovement || verifierSaysNoProgress);
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
  const skillExpansion = expandSkillAction(plannedAction, observation, traveler);
  if (skillExpansion.expanded) {
    nextState = withUpdate(nextState, { activeSkillPlan: skillExpansion.plan });
    transactionStore?.recordActionEvent?.(nextState.id, {
      actionId: plannedAction.id || "",
      observationId: observation.observationId || "",
      turnId: clientTurnId || turnId,
      stage: "skill_plan_created",
      skill: skillExpansion.skill,
      skillPlanId: skillExpansion.plan?.planId || "",
      atomCount: skillExpansion.plan?.atoms?.length || 0,
      field: skillExpansion.field || "",
      exhausted: Boolean(skillExpansion.exhausted),
      atomicAction: skillExpansion.action
    });
  }
  const executablePlannedAction = bindTargetSnapshot(
    skillExpansion.action,
    observation
  );
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
  if (!governance.allow) {
    if (governance.decision === "recoverable" && governance.code === "TARGET_OUT_OF_VIEW") {
      if (skillExpansion.expanded && skillExpansion.plan) {
        const recovery = prepareSkillViewportRecovery(
          skillExpansion.plan,
          executablePlannedAction.id,
          observation.observationId || ""
        );
        if (recovery.recovered) {
          const scrollAction = viewportRecoveryAction(
            executablePlannedAction,
            observation,
            recovery.atom?.viewportRecoveryCount || 1
          );
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
              activeSkillPlan: recovery.plan,
              lastAction: scrollAction,
              status: "running"
            });
          } else {
            nextState = withUpdate(nextState, {
              activeSkillPlan: failSkillAction(
                recovery.plan,
                executablePlannedAction.id,
                scrollGovernance.reason || "The action governor blocked viewport recovery.",
                observation.observationId || ""
              )
            });
            finalAction = policyBlockedAction(scrollGovernance, scrollAction);
          }
        } else {
          nextState = withUpdate(nextState, { activeSkillPlan: recovery.plan });
          finalAction = policyBlockedAction(governance, executablePlannedAction);
        }
      } else {
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
            pendingRecoveryAction: pendingViewportRecovery(executablePlannedAction, 1),
            lastAction: scrollAction,
            status: "running"
          });
          transactionStore?.recordActionEvent?.(nextState.id, {
            actionId: scrollAction.id,
            observationId: observation.observationId || "",
            turnId: clientTurnId || turnId,
            stage: "pending_action_viewport_recovery_dispatched",
            recoveryOfActionId: executablePlannedAction.id,
            recoveryCount: 1,
            action: scrollAction
          });
        } else {
          finalAction = policyBlockedAction(scrollGovernance, scrollAction);
        }
      }
    } else {
      if (skillExpansion.expanded && skillExpansion.plan) {
        nextState = withUpdate(nextState, {
          activeSkillPlan: failSkillAction(
            skillExpansion.plan,
            executablePlannedAction.id,
            governance.reason || "The action governor blocked the first skill atom.",
            observation.observationId || ""
          )
        });
      }
      finalAction = policyBlockedAction(governance, executablePlannedAction);
    }
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
    canonicalBlockedRecoveryAction,
    controlDecisionGroupId,
    decisionGroupForRequirement,
    deterministicRequirementEvidence,
    expectedOutcomeForAction,
    reconcileRequirements,
    requirementsWithDecisionGroups,
    resolvedBlockedObligation,
    targetSnapshotForAction,
    resolveActionControl,
    updateEvidenceMatchesRequirement
  }
};
