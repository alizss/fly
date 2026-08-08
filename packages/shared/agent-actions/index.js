/**
 * @typedef {"click"|"click_xy"|"type"|"select"|"scroll"|"keypress"|"wait"|"ask_user"|"final_review"|"stop"|"fill_known_fields"|"fill_visible_profile_fields"|"save_trip"} ActionType
 *
 * @typedef {Object} AgentAction
 * @property {string} id
 * @property {ActionType} type
 * @property {string} [observationId]
 * @property {string} [observationHash]
 * @property {string} [intent]
 * @property {"activate"|"open"|"choose"|"type"|"select"|"keyboard"} [operation]
 * @property {"choice"|"command"|"opener"|"navigation"|"field"} [interactionRole]
 * @property {"select"|"waive"|"open"|"advance"|"set_value"} [semanticEffect]
 * @property {"selected"|"dismissed"|"options_appeared"|"progress_changed"|"value_changed"|"target_visible"} [expectedEvidence]
 * @property {string} [semanticOutcome]
 * @property {string} [mechanicalEffect]
 * @property {string} [semanticIntent]
 * @property {Object[]} [expectedPostconditions]
 * @property {"compatible"|"context_only"|"unknown"} [outcomeCompatibility]
 * @property {string} [physicalEffect]
 * @property {string} [intendedOutcome]
 * @property {string} [semanticOwnershipLinkId]
 * @property {string} [policyCorrectionForDecisionGroupId]
 * @property {string} [goalId]
 * @property {string} [decisionInstanceId]
 * @property {string} [candidateId]
 * @property {"proven_action"|"mechanical_hypothesis"} [candidateClass]
 * @property {boolean} [mechanicalHypothesis]
 * @property {Object} [discoveryEnvelope]
 * @property {string} [logicalControlId]
 * @property {string} [actuatorId]
 * @property {string} [skillPlanId]
 * @property {string} [skillAtomId]
 * @property {string} [controlId]
 * @property {string} [decisionGroupId]
 * @property {string} [targetId]
 * @property {string} [targetLabel]
 * @property {Object} [targetSnapshot]
 * @property {Object} [expectedOutcome]
 * @property {Object} [affordance]
 * @property {Object} [pipelineContract]
 * @property {"proven_executable"|"recoverable"|"unproven_experiment"|"unavailable"} [capabilityStatus]
 * @property {"normal"|"reveal"|"bounded_recovery"|"unavailable"} [executionChannel]
 * @property {"direct_input"|"native_select"|"native_click"|"pointer_sequence"|"focus_enter"|"focus_space"|"focus_arrow_down"|"visual_coordinate"|"browser_trusted_input"|"browser_trusted_choice"} [interactionMethod]
 * @property {boolean} [boundedRecovery]
 * @property {string} [value]
 * @property {{requestId:string,field:string,label:string,subjectId?:string,sensitive?:boolean}} [inputRequest]
 * @property {number} [x]
 * @property {number} [y]
 * @property {VisualRegion} [visualRegion]
 * @property {number} [scrollY]
 * @property {string} [keys]
 * @property {string} reason
 * @property {string} [requirementId]
 * @property {"safe"|"money"|"payment"|"legal"|"uncertain"} risk
 * @property {boolean} requiresApproval
 */

const ACTION_TYPES = new Set([
  "click",
  "click_xy",
  "type",
  "select",
  "scroll",
  "keypress",
  "wait",
  "ask_user",
  "final_review",
  "stop",
  "fill_known_fields",
  "fill_visible_profile_fields",
  "save_trip"
]);
const RISK_LEVELS = new Set(["safe", "money", "payment", "legal", "uncertain"]);

/**
 * One lossless geometry contract shared by observation, planning, governance,
 * execution, and verification.
 *
 * @typedef {Object} VisualRegion
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 * @property {number} centerX
 * @property {number} centerY
 * @property {number} viewportWidth
 * @property {number} viewportHeight
 * @property {string} surfaceId
 * @property {string} observationId
 * @property {string} controlId
 * @property {string} operation
 * @property {string} source
 * @property {number} confidence
 * @property {string} evidence
 * @property {boolean} inViewport
 */

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeVisualRegion(raw = {}, context = {}) {
  if (!raw || typeof raw !== "object") return null;
  const x = Math.round(finiteNumber(raw.x));
  const y = Math.round(finiteNumber(raw.y));
  const width = Math.max(0, Math.round(finiteNumber(raw.width)));
  const height = Math.max(0, Math.round(finiteNumber(raw.height)));
  return {
    x,
    y,
    width,
    height,
    centerX: Math.round(finiteNumber(raw.centerX, x + width / 2)),
    centerY: Math.round(finiteNumber(raw.centerY, y + height / 2)),
    viewportWidth: Math.max(0, Math.round(finiteNumber(raw.viewportWidth, context.viewportWidth))),
    viewportHeight: Math.max(0, Math.round(finiteNumber(raw.viewportHeight, context.viewportHeight))),
    surfaceId: String(raw.surfaceId || context.surfaceId || "").slice(0, 120),
    observationId: String(context.observationId || raw.observationId || "").slice(0, 120),
    controlId: String(raw.controlId || context.controlId || "").slice(0, 140),
    operation: String(raw.operation || context.operation || "").slice(0, 40),
    source: String(raw.source || context.source || "").slice(0, 120),
    confidence: Math.max(0, Math.min(1, finiteNumber(raw.confidence, context.confidence))),
    evidence: String(raw.evidence || context.evidence || "").slice(0, 240),
    inViewport: raw.inViewport !== false
  };
}

function visualRegionsMatch(left = {}, right = {}, tolerance = 2) {
  const a = normalizeVisualRegion(left);
  const b = normalizeVisualRegion(right);
  if (!a || !b) return false;
  const geometryMatches = ["x", "y", "width", "height", "centerX", "centerY"]
    .every((key) => Math.abs(a[key] - b[key]) <= tolerance);
  if (!geometryMatches) return false;
  return ["viewportWidth", "viewportHeight", "surfaceId", "observationId", "controlId", "operation", "source"]
    .every((key) => !a[key] || !b[key] || a[key] === b[key]);
}

function normalizeTargetId(value) {
  const id = String(value || "").trim();
  if (!id || /^(false|true|null|undefined|\[object object\])$/i.test(id)) return "";
  return id.slice(0, 120);
}

function isCandidateGrounded(candidate = {}, observation = {}) {
  if (normalizeTargetId(candidate.targetId)) return true;
  const currentObservationId = String(
    typeof observation === "string"
      ? observation
      : observation.observationId || candidate.observationId || ""
  );
  const region = normalizeVisualRegion(candidate.visualRegion);
  return Boolean(
    currentObservationId
    && region
    && region.width > 0
    && region.height > 0
    && region.observationId === currentObservationId
  );
}

function normalizeAction(raw = {}) {
  const region = raw.visualRegion && typeof raw.visualRegion === "object" ? raw.visualRegion : null;
  const mechanicalEffect = String(raw.mechanicalEffect || raw.physicalEffect || raw.affordance?.mechanicalEffect || raw.affordance?.physicalEffect || raw.affordance?.effect || "").slice(0, 80);
  const semanticIntent = String(raw.semanticIntent || raw.intent || "").slice(0, 160);
  const expectedPostconditions = Array.isArray(raw.expectedPostconditions)
    ? raw.expectedPostconditions.filter((item) => item && typeof item === "object").map((item) => ({ ...item })).slice(0, 8)
    : (raw.expectedOutcome && typeof raw.expectedOutcome === "object" ? [{ ...raw.expectedOutcome }] : []);
  return {
    id: String(raw.id || `act_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`),
    type: ACTION_TYPES.has(raw.type) ? raw.type : "stop",
    observationId: raw.observationId ? String(raw.observationId).slice(0, 120) : "",
    observationHash: raw.observationHash ? String(raw.observationHash).slice(0, 120) : "",
    intent: String(raw.intent || semanticIntent || "").slice(0, 120),
    operation: raw.operation ? String(raw.operation).slice(0, 40) : "",
    interactionRole: raw.interactionRole ? String(raw.interactionRole).slice(0, 40) : "",
    semanticEffect: raw.semanticEffect ? String(raw.semanticEffect).slice(0, 40) : "",
    expectedEvidence: raw.expectedEvidence ? String(raw.expectedEvidence).slice(0, 40) : "",
    semanticOutcome: raw.semanticOutcome ? String(raw.semanticOutcome).slice(0, 80) : "",
    mechanicalEffect,
    semanticIntent,
    expectedPostconditions,
    outcomeCompatibility: ["compatible", "context_only", "unknown"].includes(raw.outcomeCompatibility) ? raw.outcomeCompatibility : "unknown",
    physicalEffect: mechanicalEffect,
    intendedOutcome: raw.intendedOutcome ? String(raw.intendedOutcome).slice(0, 120) : "",
    semanticOwnershipLinkId: raw.semanticOwnershipLinkId ? String(raw.semanticOwnershipLinkId).slice(0, 260) : "",
    policyCorrectionForDecisionGroupId: raw.policyCorrectionForDecisionGroupId ? String(raw.policyCorrectionForDecisionGroupId).slice(0, 140) : "",
    goalId: raw.goalId ? String(raw.goalId).slice(0, 200) : "",
    decisionInstanceId: raw.decisionInstanceId ? String(raw.decisionInstanceId).slice(0, 900) : "",
    candidateId: raw.candidateId ? String(raw.candidateId).slice(0, 240) : "",
    candidateClass: ["proven_action", "mechanical_hypothesis"].includes(raw.candidateClass)
      ? raw.candidateClass
      : "proven_action",
    mechanicalHypothesis: raw.mechanicalHypothesis === true,
    discoveryEnvelope: raw.discoveryEnvelope && typeof raw.discoveryEnvelope === "object"
      ? { ...raw.discoveryEnvelope }
      : null,
    logicalControlId: raw.logicalControlId
      ? String(raw.logicalControlId).slice(0, 160)
      : (raw.controlId ? String(raw.controlId).slice(0, 160) : ""),
    actuatorId: normalizeTargetId(raw.actuatorId || raw.targetId),
    skillPlanId: raw.skillPlanId ? String(raw.skillPlanId).slice(0, 160) : "",
    skillAtomId: raw.skillAtomId ? String(raw.skillAtomId).slice(0, 200) : "",
    controlId: raw.controlId ? String(raw.controlId).slice(0, 140) : (raw.targetSnapshot?.controlId ? String(raw.targetSnapshot.controlId).slice(0, 140) : ""),
    decisionGroupId: raw.decisionGroupId ? String(raw.decisionGroupId).slice(0, 140) : (raw.targetSnapshot?.decisionGroupId ? String(raw.targetSnapshot.decisionGroupId).slice(0, 140) : ""),
    targetId: normalizeTargetId(raw.targetId),
    targetLabel: raw.targetLabel ? String(raw.targetLabel).slice(0, 300) : "",
    targetSnapshot: raw.targetSnapshot && typeof raw.targetSnapshot === "object" ? raw.targetSnapshot : null,
    expectedOutcome: raw.expectedOutcome && typeof raw.expectedOutcome === "object" ? raw.expectedOutcome : null,
    affordance: raw.affordance && typeof raw.affordance === "object" ? raw.affordance : null,
    pipelineContract: raw.pipelineContract && typeof raw.pipelineContract === "object" ? raw.pipelineContract : null,
    capabilityStatus: raw.capabilityStatus ? String(raw.capabilityStatus).slice(0, 60) : "",
    executionChannel: raw.executionChannel ? String(raw.executionChannel).slice(0, 60) : "",
    interactionMethod: raw.interactionMethod ? String(raw.interactionMethod).slice(0, 80) : "",
    boundedRecovery: raw.boundedRecovery === true,
    exactOption: raw.exactOption && typeof raw.exactOption === "object"
      ? {
          canonicalValue: String(raw.exactOption.canonicalValue || "").slice(0, 600),
          siteValue: String(raw.exactOption.siteValue || "").slice(0, 600),
          label: String(raw.exactOption.label || "").slice(0, 600),
          controlId: String(raw.exactOption.controlId || raw.controlId || "").slice(0, 160),
          source: String(raw.exactOption.source || "").slice(0, 120)
        }
      : null,
    value: raw.value ? String(raw.value).slice(0, 600) : "",
    inputRequest: raw.inputRequest && typeof raw.inputRequest === "object"
      ? {
          requestId: String(raw.inputRequest.requestId || "").slice(0, 160),
          field: String(raw.inputRequest.field || "").slice(0, 120),
          label: String(raw.inputRequest.label || "").slice(0, 160),
          subjectId: String(raw.inputRequest.subjectId || "").slice(0, 160),
          sensitive: raw.inputRequest.sensitive === true
        }
      : null,
    x: Number.isFinite(Number(raw.x)) ? Math.round(Number(raw.x)) : null,
    y: Number.isFinite(Number(raw.y)) ? Math.round(Number(raw.y)) : null,
    visualRegion: normalizeVisualRegion(region, {
      observationId: raw.observationId,
      controlId: raw.controlId || raw.targetSnapshot?.controlId,
      operation: raw.operation,
      source: raw.targetSnapshot?.source || raw.source
    }),
    scrollY: Number.isFinite(Number(raw.scrollY)) ? Math.round(Number(raw.scrollY)) : 0,
    keys: raw.keys ? String(raw.keys).slice(0, 80) : "",
    readinessStartedAt: Number.isFinite(Number(raw.readinessStartedAt)) ? Number(raw.readinessStartedAt) : 0,
    readinessDeadlineAt: Number.isFinite(Number(raw.readinessDeadlineAt)) ? Number(raw.readinessDeadlineAt) : 0,
    readinessAttempts: Number.isFinite(Number(raw.readinessAttempts)) ? Number(raw.readinessAttempts) : 0,
    reobserveRetryToken: raw.reobserveRetryToken ? String(raw.reobserveRetryToken).slice(0, 180) : "",
    reason: String(raw.reason || "").slice(0, 500),
    requirementId: raw.requirementId ? String(raw.requirementId) : "",
    risk: RISK_LEVELS.has(raw.risk) ? raw.risk : "uncertain",
    requiresApproval: Boolean(raw.requiresApproval)
  };
}

/**
 * Stable identity for one physical actuator attempt.
 * Values and key payloads do not make a retry distinct; only its target,
 * operation, or dispatch method does. Page-state identity is scoped by the
 * caller because the same actuator may become valid after a material change.
 */
function actuatorSignature(action = {}) {
  const affordance = action.affordance || {};
  const selectedStrategy = action.pipelineContract?.capability?.selectedStrategy || {};
  const method = action.interactionMethod || action.type || action.action || "";
  const operation = action.operation || affordance.capability || "";
  if (selectedStrategy.actuatorStableKey) {
    return [
      method,
      operation,
      action.pipelineContract?.component?.componentIdentity || affordance.stableKey || action.controlId || "",
      selectedStrategy.actuatorStableKey
    ].join(":");
  }
  if (affordance.stableKey && affordance.actuator?.stableKey && affordance.effect) {
    return [
      method,
      operation,
      affordance.stableKey,
      affordance.actuator.stableKey
    ].join(":");
  }
  const target = action.targetSnapshot || {};
  return [
    method,
    operation,
    action.controlId || target.controlId || "",
    action.targetId || target.id || `${action.x ?? ""},${action.y ?? ""}`
  ].join(":");
}

function semanticGoalKey(source = {}) {
  const goal = source.affordance?.task || source.currentGoal || source;
  const stableScope = goal.semanticType
    || goal.sectionType
    || goal.semanticGoal
    || goal.requirementId
    || goal.decisionGroupId
    || "current_goal";
  const normalize = (value) => String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
  return [
    stableScope,
    goal.logicalFieldId || "",
    goal.subjectId || "",
    goal.componentRole || "",
    goal.desiredValue || "",
    Number.isFinite(Number(goal.ordinal)) ? `ordinal:${Number(goal.ordinal)}` : ""
  ]
    .map(normalize)
    .join("|");
}

function normalizedInstanceFact(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 180);
}

/**
 * Fresh-browser identity for one current checkout decision. This scopes
 * recovery memory only; it does not classify the page or authorize actions.
 */
function decisionInstanceKey(source = {}, observation = {}) {
  const page = observation.page || {};
  const goal = source.affordance?.task || source.currentGoal || source;
  const target = source.targetSnapshot || {};
  const decisionGroupId = String(
    source.policyCorrectionForDecisionGroupId
    || source.decisionGroupId
    || goal.decisionGroupId
    || target.policyCorrectionForDecisionGroupId
    || target.decisionGroupId
    || ""
  );
  const group = (page.decisionGroups || []).find((item) => (
    String(item.decisionGroupId || item.requirementId || "") === decisionGroupId
  )) || {};
  const surface = page.currentSurface || page.activeSurface || page.foreground || {};
  const progress = page.foreground?.progressMarkers
    || page.visualState?.foreground?.progressMarkers
    || surface.foreground?.progressMarkers
    || surface.visualState?.progressMarkers
    || {};
  const passenger = group.passengerId
    || group.travelerId
    || group.passengerOrdinal
    || group.travelerOrdinal
    || goal.passengerId
    || goal.travelerId
    || progress.passengerOrdinal
    || progress.travelerOrdinal
    || surface.passengerId
    || surface.travelerId
    || "";
  const selected = [
    group.selectedEvidence?.selectedControlId || group.selectedControlId || goal.selectedControlId,
    group.selectedEvidence?.ownerElementId,
    group.selectedEvidence?.selectedLabel || group.selectedLabel || goal.selectedLabel
  ].filter(Boolean).join("|");
  return JSON.stringify({
    stage: normalizedInstanceFact(page.step || page.pageStep || goal.stage || "unknown"),
    surface: normalizedInstanceFact([
      surface.id || target.surfaceId || group.surfaceId || "surface-page",
      surface.type || target.surfaceType || group.surfaceType || "page",
      surface.surfaceClass || surface.taskHint || "",
      surface.label || target.surfaceLabel || ""
    ].filter(Boolean).join("|")),
    repeatedStep: normalizedInstanceFact([
      progress.flightOrdinal,
      progress.route,
      progress.step,
      progress.current,
      progress.segment
    ].filter(Boolean).join("|")),
    passenger: normalizedInstanceFact(passenger),
    decisionGroup: normalizedInstanceFact(decisionGroupId || group.requirementId || goal.requirementId),
    logicalField: normalizedInstanceFact(goal.logicalFieldId || ""),
    componentRole: normalizedInstanceFact(goal.componentRole || ""),
    selectedItem: normalizedInstanceFact(selected)
  });
}

/** Two actions are the same attempt when method, operation, and target match. */
function actionSignature(action) {
  return actuatorSignature(action);
}

module.exports = {
  normalizeAction,
  normalizeVisualRegion,
  visualRegionsMatch,
  isCandidateGrounded,
  actionSignature,
  actuatorSignature,
  decisionInstanceKey,
  semanticGoalKey,
  ACTION_TYPES
};
