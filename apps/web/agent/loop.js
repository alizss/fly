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
const { checkPolicy } = require("./policy");
const { writeTrace } = require("./trace-store");
const { normalizeAction, actionSignature } = require("../../../packages/shared/agent-actions");
const { withUpdate, normalizeStep } = require("../../../packages/shared/agent-state");
const { missingRequired } = require("../../../packages/shared/requirements");

const STALL_THRESHOLD = 3;

function isContinueRequirement(req) {
  if (!req) return false;
  if (req.type === "continue") return true;
  return /^continue\b|continue button|next step/i.test(String(req.id || req.label || ""));
}

function actionableMissingRequired(requirements = []) {
  return missingRequired(requirements).filter((req) => !isContinueRequirement(req));
}

function isContinueAction(action) {
  if (!action || (action.type !== "click" && action.type !== "click_xy")) return false;
  return /^(continue|next|proceed|done)\b/i.test(String(action.targetLabel || action.value || ""));
}

function isPassiveNameMatchLegal(req) {
  if (!req || req.type !== "legal_acceptance" || req.status === "satisfied") return false;
  if ((req.targetIds || []).length) return false;
  return /name.*match.*passport|passports? of those travelling|passports? of those traveling/i.test(`${req.label || ""} ${(req.evidence || []).join(" ")}`);
}

function safeIntermediateContinueAction(action, requirements = []) {
  if (!isContinueAction(action)) return action;
  const missing = actionableMissingRequired(requirements);
  if (!missing.length || missing.every(isPassiveNameMatchLegal)) {
    return normalizeAction({
      ...action,
      risk: "safe",
      requiresApproval: false,
      reason: action.reason || "Intermediate Continue is safe; payment/final booking remains gated."
    });
  }
  return action;
}

function noPaidExtrasRuleActive(state = {}, traveler = {}) {
  const rules = String(traveler?.booking_rules || traveler?.baggage_preference || "").toLowerCase();
  return Boolean(state?.approvals?.skipPaidExtrasApproved)
    || /no paid|no extras|no add-?ons|no add ons|no seat|no insurance|no bundle|avoid paid|personal item only/.test(rules);
}

function unresolvedStatus(item = {}) {
  return item && item.status !== "satisfied" && item.status !== "complete" && item.status !== "blocked";
}

function verifierUpdateForRequirement(verification = {}, requirementId = "") {
  return (verification.requirementUpdates || []).find((update) => update.requirementId === requirementId) || null;
}

function normalizeEvidenceStatus(status = "") {
  if (status === "complete" || status === "satisfied") return "satisfied";
  if (status === "blocked") return "blocked";
  if (status === "incomplete" || status === "missing") return "missing";
  if (status === "needs_user") return "needs_user";
  return "unknown";
}

function sameNormalizedText(a = "", b = "") {
  const left = normalizeText(a);
  const right = normalizeText(b);
  return Boolean(left && right && (left === right || left.includes(right) || right.includes(left)));
}

function sectionMatchesRequirement(section = {}, requirement = {}) {
  const targetIds = new Set([requirement.id, ...(requirement.targetIds || [])].filter(Boolean));
  if (targetIds.has(section.id)) return true;
  const sectionTargets = [
    ...(section.choices || []),
    ...(section.fields || []),
    ...(section.buttons || [])
  ].map((item) => item?.id).filter(Boolean);
  if (sectionTargets.some((id) => targetIds.has(id))) return true;
  return sameNormalizedText(section.label, requirement.label);
}

function deterministicRequirementEvidence(requirement = {}, observation = {}) {
  const page = observation?.page || {};
  const targetIds = new Set([requirement.id, ...(requirement.targetIds || [])].filter(Boolean));
  const fields = page.fields || [];
  const sections = page.sections || [];
  const tasks = page.taskQueue || [];

  const field = fields.find((item) => targetIds.has(item.id));
  if (field && /field/.test(requirement.type || "")) {
    return {
      source: "deterministic_field",
      status: field.hasValue ? "satisfied" : "missing",
      evidence: field.hasValue ? `Field ${field.label || field.id} has a value.` : `Field ${field.label || field.id} is empty.`
    };
  }

  const section = sections.find((item) => sectionMatchesRequirement(item, requirement));
  if (section) {
    const selectedChoice = (section.choices || []).find((choice) => choice.selected || choice.hasValue);
    const selectedSafeDecline = selectedChoice && (
      selectedChoice.risk === "safe_decline"
      || selectedChoice.semantic === "decline_paid_extra"
      || safeDeclineLabel(`${selectedChoice.label || ""} ${selectedChoice.semantic || ""} ${selectedChoice.risk || ""}`)
    );
    const status = selectedSafeDecline
      ? "satisfied"
      : normalizeEvidenceStatus(section.status);
    return {
      source: "deterministic_section",
      status,
      evidence: `Section ${section.label || section.id} is ${section.status || "unknown"}${selectedChoice ? ` with selected value ${selectedChoice.label || selectedChoice.id}.` : "."}`
    };
  }

  const task = tasks.find((item) =>
    item.status === "pending"
    && (
      targetIds.has(item.id)
      || targetIds.has(item.sectionId)
      || sameNormalizedText(item.sectionLabel, requirement.label)
      || sameNormalizedText(item.sectionType, requirement.label)
    )
  );
  if (task) {
    return {
      source: "deterministic_task",
      status: "missing",
      evidence: `Task ${task.sectionLabel || task.sectionType || task.id} is still pending.`
    };
  }

  return null;
}

function updateHasCurrentEvidence(update = {}, observation = {}) {
  if (!update || update.proposedStatus !== "satisfied") return false;
  const currentObservationId = String(observation?.observationId || "");
  const updateObservationId = String(update.observationId || "");
  if (currentObservationId && updateObservationId && currentObservationId !== updateObservationId) return false;
  if (Number(update.confidence || 0) < 0.75) return false;
  const evidence = update.evidence || {};
  return Boolean(evidence.controlId || evidence.selectedValue || evidence.visibleText);
}

function requirementConflict(requirement = {}, verification = {}, observation = {}) {
  if (!requirement || requirement.status === "satisfied") return false;
  const satisfiedIds = new Set(verification.satisfiedRequirementIds || []);
  const update = verifierUpdateForRequirement(verification, requirement.id);
  const verifierClaimsSatisfied = satisfiedIds.has(requirement.id) || update?.proposedStatus === "satisfied";
  if (!verifierClaimsSatisfied) return false;
  return !updateHasCurrentEvidence(update, observation);
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

    if (updateHasCurrentEvidence(update, observation)) {
      return {
        ...requirement,
        status: "satisfied",
        confidence: Math.max(requirement.confidence || 0, update.confidence || 0)
      };
    }

    return requirement;
  });
}

function unresolvedPaidExtraContext(pageState = {}, page = {}) {
  const paidExtra = (pageState.optionalPaidExtras || []).find((item) =>
    unresolvedStatus(item) && ["money", "uncertain"].includes(item.risk || "money")
  );
  if (paidExtra) {
    return {
      id: paidExtra.id || "",
      label: paidExtra.label || "optional paid extra",
      targetIds: paidExtra.targetIds || [],
      source: "optionalPaidExtras"
    };
  }

  const requiredPaidChoice = (pageState.requiredChoices || []).find((item) =>
    unresolvedStatus(item) && (item.kind === "paid_extra" || item.risk === "money")
  );
  if (requiredPaidChoice) {
    return {
      id: requiredPaidChoice.id || "",
      label: requiredPaidChoice.label || "paid extra choice",
      targetIds: requiredPaidChoice.targetIds || [],
      source: "requiredChoices"
    };
  }

  const moneyGate = (pageState.riskGates || []).find((item) =>
    unresolvedStatus(item) && ["money", "uncertain"].includes(item.risk || "")
  );
  if (moneyGate) {
    return {
      id: moneyGate.id || "",
      label: moneyGate.label || "money risk gate",
      targetIds: moneyGate.targetIds || [],
      source: "riskGates"
    };
  }

  const pageTask = (page.taskQueue || []).find((task) =>
    task?.status === "pending" && /baggage|bundle|flexible|ticket|cancellation|insurance|seat|sms|support|extra/i.test(`${task.sectionType || ""} ${task.sectionLabel || ""} ${task.objective || ""}`)
  );
  if (pageTask) {
    return {
      id: pageTask.id || pageTask.sectionId || "",
      label: pageTask.sectionLabel || pageTask.sectionType || "pending optional section",
      sectionId: pageTask.sectionId || "",
      sectionType: pageTask.sectionType || "",
      source: "taskQueue"
    };
  }

  return null;
}

function safeDeclineLabel(value = "") {
  const text = normalizeText(value);
  if (!text) return false;
  if (/\b(add|cart|buy|premium|upgrade|select seat|choose seat|aisle|window)\b/.test(text) && !/\b0\s*(eur|€|usd|\$)|free\b/.test(text)) return false;
  return /\b(no thanks|no, thanks|none|none of the passengers|go without|without|decline|skip|not now|random seating|0\s*(eur|€|usd|\$)|free)\b/.test(text);
}

function paidLookingLabel(value = "") {
  const text = normalizeText(value);
  return /([1-9][0-9]*(?:[.,][0-9]{1,2})?)\s*(eur|€|usd|\$)/.test(text)
    && !/\b0\s*(eur|€|usd|\$)\b/.test(text);
}

function contextWords(context = {}) {
  return normalizeText(`${context.label || ""} ${context.sectionType || ""} ${context.source || ""}`)
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 4 && !["paid", "extra", "choice", "section", "optional", "pending"].includes(word));
}

function scoreSafeDeclineCandidate(candidate = {}, context = {}) {
  const labelText = `${candidate.label || ""} ${candidate.accessibleName || ""} ${candidate.semantic || ""} ${candidate.risk || ""}`;
  if (!safeDeclineLabel(labelText) && candidate.risk !== "safe_decline" && !/decline/i.test(candidate.semantic || "")) return 0;
  if (candidate.selected) return 0;
  if (paidLookingLabel(labelText) && !/\b0\s*(eur|€|usd|\$)|free\b/i.test(labelText)) return 0;

  let score = 20;
  if (candidate.risk === "safe_decline") score += 40;
  if (/decline/i.test(candidate.semantic || "")) score += 35;
  if (candidate.kind === "choice" || /radio|checkbox|option/.test(candidate.kind || candidate.role || "")) score += 20;
  if (candidate.box) score += 8;
  if (context.sectionId && candidate.sectionId === context.sectionId) score += 45;
  if (context.id && (candidate.sectionId === context.id || candidate.id === context.id)) score += 25;
  if (context.targetIds?.includes(candidate.id)) score += 20;

  const candidateText = normalizeText(`${candidate.label || ""} ${candidate.sectionLabel || ""} ${candidate.sectionType || ""}`);
  for (const word of contextWords(context)) {
    if (candidateText.includes(word)) score += 10;
  }

  return score;
}

function bestSafeDeclineCandidate(page = {}, context = {}) {
  const candidates = pageTargetCandidates(page)
    .map((candidate) => ({ candidate, score: scoreSafeDeclineCandidate(candidate, context) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
  return candidates[0]?.candidate || null;
}

function recoverPendingPaidExtraBeforeNavigation(action = {}, pageState = {}, observation = {}, state = {}, traveler = {}) {
  if (!isContinueAction(action)) return null;
  if (!noPaidExtrasRuleActive(state, traveler)) return null;

  const page = observation.page || {};
  const context = unresolvedPaidExtraContext(pageState, page);
  if (!context) return null;

  const declineTarget = bestSafeDeclineCandidate(page, context);
  if (!declineTarget) return null;

  return normalizeAction({
    observationId: observation.observationId || "",
    observationHash: observation.observationSnapshot?.snapshotHash || "",
    type: "click",
    targetId: declineTarget.id || "",
    targetLabel: declineTarget.label || declineTarget.accessibleName || "",
    value: declineTarget.label || declineTarget.accessibleName || "",
    reason: `Resolve pending ${context.label || "paid extra"} by choosing the visible no-cost decline option before navigation.`,
    risk: "safe",
    requiresApproval: false,
    intent: "decline_optional_extra",
    requirementId: context.id || declineTarget.sectionType || declineTarget.sectionLabel || "",
    targetSnapshot: declineTarget,
    expectedOutcome: {
      type: "requirement_status",
      requirementId: context.id || declineTarget.sectionType || declineTarget.sectionLabel || "",
      status: "satisfied",
      targetId: declineTarget.id || "",
      sectionId: declineTarget.sectionId || context.sectionId || "",
      sectionType: declineTarget.sectionType || context.sectionType || "",
      sectionLabel: declineTarget.sectionLabel || context.label || "",
      surfaceId: declineTarget.surfaceId || "",
      intent: "decline_optional_extra",
      mustNotIncreasePrice: true
    }
  });
}

function policyBlockedAction(policyDecision, action) {
  if (policyDecision.allow) return action;
  const reason = policyDecision.reason || action.reason || "Policy blocked the planned action.";
  return normalizeAction({
    observationId: action.observationId || "",
    observationHash: action.observationHash || "",
    type: "ask_user",
    reason,
    risk: "uncertain",
    requiresApproval: true
  });
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
    requirementId: action.requirementId || "",
    controlId: action.controlId || action.targetSnapshot?.controlId || "",
    targetId: action.targetId || "",
    targetLabel: action.targetLabel || "",
    targetSnapshot: action.targetSnapshot || null,
    expectedOutcome: action.expectedOutcome || null,
    value: action.value || action.targetLabel || "",
    x: action.x,
    y: action.y,
    scrollY: action.scrollY,
    keys: action.keys || "",
    message: action.reason || "Working on the next step.",
    needsApproval: action.requiresApproval,
    risk: action.risk,
    reason: action.reason
  };
}

function askUserDecision(reason) {
  return toClientDecision(normalizeAction({ type: "ask_user", reason, risk: "uncertain", requiresApproval: true }));
}

function normalizeText(value = "") {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function shortNavigationLabel(label = "") {
  return /^(continue|next|back|close|done|confirm|skip|proceed)$/i.test(String(label || "").trim());
}

function visibleActionCandidates(page = {}) {
  const activeSurface = page.currentSurface && page.currentSurface.type !== "page" ? page.currentSurface : (page.activeSurface || {});
  return [
    ...(activeSurface.buttons || []),
    ...(activeSurface.options || []),
    ...(page.buttons || []),
    ...(page.sections || []).flatMap((section) => section.buttons || [])
  ].filter((item, index, list) =>
    item && (item.id || item.label) && list.findIndex((other) => other?.id === item.id && other?.label === item.label) === index
  );
}

function targetCandidateSnapshot(candidate = {}, source = "", surface = {}) {
  if (!candidate) return null;
  return {
    id: String(candidate.id || ""),
    controlId: String(candidate.controlId || ""),
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

function pageTargetCandidates(page = {}) {
  const activeSurface = page.currentSurface && page.currentSurface.type !== "page" ? page.currentSurface : (page.activeSurface || {});
  const controls = (page.controls || []).map((control) => targetCandidateSnapshot({
    ...control,
    id: control.preferredActivationElementId || control.stateElementId || control.controlId,
    label: control.label || control.accessibleName || control.controlId,
    kind: control.kind || "control",
    box: control.visualRegion || null,
    controlState: control.state || null
  }, "page.controls", {
    type: control.surfaceType || (control.sectionId ? "section" : "page"),
    id: control.surfaceId || control.sectionId || "",
    label: control.surfaceLabel || control.sectionLabel || "",
    sectionId: control.sectionId || "",
    sectionType: control.sectionType || "",
    sectionLabel: control.sectionLabel || ""
  }));
  const surfaceItems = [
    ...(activeSurface.buttons || []).map((item) => ({ ...item, kind: "button" })),
    ...(activeSurface.options || []).map((item) => ({ ...item, kind: "choice" }))
  ].map((item) => targetCandidateSnapshot(item, "activeSurface", activeSurface));
  const pageButtons = (page.buttons || []).map((item) => targetCandidateSnapshot({ ...item, kind: "button" }, "page.buttons", { type: "page", id: "", label: "" }));
  const pageFields = (page.fields || []).map((item) => targetCandidateSnapshot({ ...item, kind: item.kind || "field" }, "page.fields", { type: "page", id: "", label: "" }));
  const sectionButtons = (page.sections || []).flatMap((section) =>
    (section.buttons || []).map((item) => targetCandidateSnapshot({ ...item, kind: "button" }, "section.buttons", { type: "section", id: section.id || "", label: section.label || "", sectionId: section.id || "", sectionType: section.type || "", sectionLabel: section.label || "" }))
  );
  const sectionChoices = (page.sections || []).flatMap((section) =>
    (section.choices || []).map((item) => targetCandidateSnapshot({ ...item, kind: "choice" }, "section.choices", { type: "section", id: section.id || "", label: section.label || "", sectionId: section.id || "", sectionType: section.type || "", sectionLabel: section.label || "" }))
  );
  const sectionFields = (page.sections || []).flatMap((section) =>
    (section.fields || []).map((item) => targetCandidateSnapshot({ ...item, kind: item.kind || "field" }, "section.fields", { type: "section", id: section.id || "", label: section.label || "", sectionId: section.id || "", sectionType: section.type || "", sectionLabel: section.label || "" }))
  );
  return [...controls, ...surfaceItems, ...pageButtons, ...pageFields, ...sectionButtons, ...sectionChoices, ...sectionFields]
    .filter((item, index, list) => item && (item.id || item.controlId || item.label) && list.findIndex((other) => other.id === item.id && other.controlId === item.controlId && other.label === item.label && other.source === item.source) === index);
}

function targetSnapshotForAction(action = {}, page = {}) {
  if (!["click", "click_xy", "select", "type"].includes(action.type)) return null;
  const candidates = pageTargetCandidates(page);
  const byId = action.targetId ? candidates.filter((item) => item.id === action.targetId) : [];
  const byControlId = action.targetId ? candidates.filter((item) => item.controlId === action.targetId) : [];
  const primaryLabel = normalizeText(action.targetLabel || action.value || "");
  const exactLabel = primaryLabel ? candidates.filter((item) => item.normalizedLabel === primaryLabel) : [];
  const activeExact = exactLabel.find((item) => item.surfaceType && item.surfaceType !== "page");
  const controlAndLabel = byControlId.find((item) => !primaryLabel || item.normalizedLabel === primaryLabel || normalizeText(item.accessibleName).includes(primaryLabel));
  const idAndLabel = byId.find((item) => !primaryLabel || item.normalizedLabel === primaryLabel);
  const chosen = controlAndLabel
    || activeExact
    || idAndLabel
    || byControlId[0]
    || (shortNavigationLabel(primaryLabel) ? exactLabel[0] : null)
    || byId[0]
    || exactLabel[0]
    || null;
  return chosen || (action.x != null && action.y != null ? {
    id: "",
    label: action.targetLabel || action.value || "",
    normalizedLabel: normalizeText(action.targetLabel || action.value || ""),
    box: { centerX: action.x, centerY: action.y, width: 0, height: 0 },
    source: "coordinate",
    surfaceId: (page.currentSurface && page.currentSurface.type !== "page" ? page.currentSurface?.id : page.activeSurface?.id) || "",
    surfaceType: (page.currentSurface && page.currentSurface.type !== "page" ? page.currentSurface?.type : page.activeSurface?.type) || "page",
    surfaceLabel: (page.currentSurface && page.currentSurface.type !== "page" ? page.currentSurface?.label : page.activeSurface?.label) || "",
    surfaceNormalizedLabel: normalizeText((page.currentSurface && page.currentSurface.type !== "page" ? page.currentSurface?.label : page.activeSurface?.label) || "")
  } : null);
}

function bindTargetSnapshot(action = {}, observation = {}) {
  if (!action) return action;
  const targetSnapshot = targetSnapshotForAction(action, observation.page || {});
  const bound = normalizeAction({
    ...action,
    observationId: action.observationId || observation.observationId || "",
    observationHash: action.observationHash || observation.observationSnapshot?.snapshotHash || "",
    targetSnapshot: action.targetSnapshot || targetSnapshot || null
  });
  return withActionContract(bound);
}

function inferActionIntent(action = {}) {
  const target = action.targetSnapshot || {};
  const text = normalizeText(`${action.targetLabel || ""} ${action.value || ""} ${target.label || ""} ${target.semantic || ""} ${target.risk || ""} ${target.sectionLabel || ""} ${target.sectionType || ""}`);
  if (action.type === "fill_known_fields" || action.type === "fill_visible_profile_fields") return "fill_profile_fields";
  if (action.type === "type" || action.type === "select") return "satisfy_field";
  if (action.type === "scroll" || action.type === "wait") return action.type;
  if (action.type === "ask_user" || action.type === "stop" || action.type === "final_review") return action.type;
  if (/decline|safe_decline|no thanks|no, thanks|none of the passengers|go without|without|0\s*(eur|€|usd|\$)|free/.test(text)) return "decline_optional_extra";
  if (action.type === "click"
    && /\b(choose|select option|select one option|open)\b/.test(text)
    && /\b(bundle|flexible|ticket|sms|support|protection|insurance|extra|baggage|seat|option)\b/.test(text)) {
    return "open_choice_control";
  }
  if (/continue|next|proceed|done/.test(text)) return "navigate_stage";
  if (target.surfaceType && target.surfaceType !== "page") return "resolve_active_surface";
  if (target.kind === "choice" || /radio|checkbox|option/.test(target.kind || "")) return "choose_option";
  return action.type;
}

function expectedOutcomeForAction(action = {}) {
  const target = action.targetSnapshot || {};
  if (action.expectedOutcome) return action.expectedOutcome;
  if (action.intent === "decline_optional_extra") {
    return {
      type: "requirement_status",
      requirementId: action.requirementId || target.sectionType || target.sectionLabel || "",
      status: "satisfied",
      targetId: action.targetId || target.id || "",
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
      sectionId: target.sectionId || "",
      sectionType: target.sectionType || "",
      sectionLabel: target.sectionLabel || "",
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
      sectionId: target.sectionId || "",
      sectionType: target.sectionType || "",
      sectionLabel: target.sectionLabel || "",
      surfaceId: target.surfaceId || "",
      intent: action.intent || ""
    };
  }
  return null;
}

function withActionContract(action = {}) {
  const intent = action.intent || inferActionIntent(action);
  return normalizeAction({
    ...action,
    intent,
    expectedOutcome: action.expectedOutcome || expectedOutcomeForAction({ ...action, intent })
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
async function runLoopTurn({ apiKey, model, dataDir, state, observation, traveler, actionHistory = [] }) {
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

  // 1. Observe + classify typed page state. Requirements are derived from
  // typed buckets, so navigation actions like Continue/Next cannot be
  // misclassified as missing requirements.
  let extracted;
  try {
    extracted = await classifyPageState({ apiKey, model, observation, screenshotDataUrl, traveler });
    classificationMeta = extracted.meta || null;
    latency.classification_model_ms = Number(classificationMeta?.durationMs || 0);
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
  try {
    ({ verification, action: modelPlannedAction, meta: verifyPlanMeta } = await verifyAndPlan({
      apiKey, model, state, observation, currentRequirements: extracted.requirements, pageState: extracted.pageState,
      traveler, actionHistory, screenshotDataUrl
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
  const modelUsage = modelUsageFromMetas(model, [classificationMeta, verifyPlanMeta]);

  // Fresh page evidence is the source of truth. The verifier can propose
  // updates, but it may not blindly override current-page unresolved evidence.
  // Contradictions become blockers instead of silently turning into satisfied.
  const mergedRequirements = reconcileRequirements(extracted.requirements, verification, observation);

  let nextState = withUpdate(state, {
    currentStep: normalizeStep(extracted.pageStep),
    requirements: mergedRequirements,
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
  const missingCount = actionableMissingRequired(mergedRequirements).length;
  const hadPreviousCount = typeof state.lastMissingCount === "number";
  const noCountImprovement = hadPreviousCount && missingCount >= state.lastMissingCount;
  const verifierSaysNoProgress = !verification.changed && !verification.lastActionWorked;
  const deterministicAction = recoverPendingPaidExtraBeforeNavigation(
    modelPlannedAction,
    extracted.pageState,
    observation,
    nextState,
    traveler
  );
  const plannedAction = deterministicAction || modelPlannedAction;

  if (!plannedAction || !plannedAction.type) {
    nextState = withUpdate(nextState, { status: "awaiting_user" });
    const reason = "AI planner did not return a next action. I stopped instead of using a deterministic checkout fallback.";
    const clientDecision = askUserDecision(reason);
    const debug = withLatencyDebug(
      summarizeTurn({ pageState: extracted.pageState, requirements: mergedRequirements, plannedAction, finalAction: clientDecision, policyDecision: null, deterministicAction }),
      latency,
      modelUsage
    );
    writeTrace(dataDir, state.id, {
      turnId, screenshotDataUrl, observation: traceObservation, pageState: extracted.pageState, requirements: mergedRequirements, verification,
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
    const clientDecision = askUserDecision(reason);
    const debug = withLatencyDebug(
      summarizeTurn({ pageState: extracted.pageState, requirements: mergedRequirements, plannedAction, finalAction: clientDecision, policyDecision: null, deterministicAction: null }),
      latency,
      modelUsage
    );
    writeTrace(dataDir, state.id, {
      turnId, screenshotDataUrl, observation: traceObservation, pageState: extracted.pageState, requirements: mergedRequirements, verification,
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

  // 4. Policy check — one place, always, regardless of how the target was found.
  const executablePlannedAction = bindTargetSnapshot(
    safeIntermediateContinueAction(plannedAction, mergedRequirements),
    observation
  );
  const policyStartedAt = Date.now();
  const policyDecision = checkPolicy(executablePlannedAction, nextState, traveler, nextState.approvals);
  latency.policy_ms = Date.now() - policyStartedAt;

  let finalAction = executablePlannedAction;
  if (!policyDecision.allow) {
    finalAction = policyBlockedAction(policyDecision, executablePlannedAction);
  }
  finalAction = bindTargetSnapshot(finalAction, observation);

  nextState = withUpdate(nextState, {
    lastAction: finalAction,
    status: finalAction.type === "ask_user" || finalAction.type === "final_review" ? "awaiting_user" : "running"
  });

  const debug = withLatencyDebug(
    summarizeTurn({ pageState: extracted.pageState, requirements: mergedRequirements, plannedAction, finalAction, policyDecision, deterministicAction }),
    latency,
    modelUsage
  );
  writeTrace(dataDir, state.id, {
    turnId, screenshotDataUrl, observation: traceObservation, pageState: extracted.pageState, requirements: mergedRequirements, verification,
    plannedAction, policyDecision,
    executionResult: { stillMissingCount: actionableMissingRequired(mergedRequirements).length },
    debug
  });

  return {
    state: nextState,
    clientDecision: toClientDecision(finalAction),
    debug
  };
}

module.exports = { runLoopTurn, toClientDecision, askUserDecision };
