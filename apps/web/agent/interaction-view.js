const { currentSurface } = require("./surface-contract");
const { diffObservations } = require("./observation-diff");
const { obligationField } = require("./current-obligation");

const MAX_RELATED_MODEL_CONTROLS = 20;

function clean(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function clipped(value = "", limit = 240) {
  return clean(value).slice(0, limit);
}

function compactSurface(surface = null) {
  if (!surface || typeof surface !== "object") return null;
  return {
    id: clean(surface.id),
    type: clean(surface.type),
    label: clipped(surface.label, 240),
    blocksBackground: surface.blocksBackground === true
  };
}

function compactPostcondition(postcondition = null) {
  if (!postcondition || typeof postcondition !== "object") return null;
  return {
    type: clean(postcondition.type),
    semanticType: clean(postcondition.semanticType),
    componentRole: clean(postcondition.componentRole),
    expectedCanonicalValue: clipped(postcondition.expectedCanonicalValue, 120),
    expectedNormalizedValue: clipped(postcondition.expectedNormalizedValue, 120),
    mustNotIncreasePrice: postcondition.mustNotIncreasePrice === true
  };
}

function compactOutcome(contract = null) {
  if (!contract || typeof contract !== "object") return null;
  return {
    outcomeId: clipped(contract.outcomeId, 180),
    taskOutcome: clean(contract.taskOutcome),
    acceptablePhysicalEffects: (contract.acceptablePhysicalEffects || []).map(clean).filter(Boolean).slice(0, 8),
    completionEvidence: (contract.completionEvidence || []).map(clean).filter(Boolean).slice(0, 8)
  };
}

function compactAdaptiveEnvelope(envelope = null) {
  if (!envelope || typeof envelope !== "object") return null;
  return {
    episodeId: clipped(envelope.episodeId, 180),
    objective: clipped(envelope.objective, 240),
    desiredValue: clipped(envelope.desiredValue, 120),
    surfaceId: clean(envelope.surfaceId),
    surfaceType: clean(envelope.surfaceType),
    allowedOperations: (envelope.allowedOperations || []).map(clean).filter(Boolean).slice(0, 10),
    forbiddenRisks: (envelope.forbiddenRisks || []).map(clean).filter(Boolean).slice(0, 10),
    forbiddenEffects: (envelope.forbiddenEffects || []).map(clean).filter(Boolean).slice(0, 12),
    remainingSteps: Number(envelope.remainingSteps || 0),
    deadlineAt: Number(envelope.deadlineAt || 0)
  };
}

// The sole compact representation supplied to either ambiguity mode.
// Semantic binding and mechanical selection therefore see the same current
// obligation, surface, actuator evidence, causal diff, and safety envelope.
function compileInteractionView({
  goal = {},
  taskState = {},
  candidates = [],
  contextCapabilities = [],
  observation = {},
  allowedSemanticBindings = [],
  attemptedStrategies = [],
  forbiddenEffects = [],
  successCondition = null
} = {}) {
  const capabilities = Array.isArray(contextCapabilities) && contextCapabilities.length
    ? contextCapabilities
    : candidates;
  const componentById = new Map();
  for (const capability of capabilities.slice(0, MAX_RELATED_MODEL_CONTROLS)) {
    const logicalControlId = clean(
      capability.logicalControlId
      || capability.pipelineContract?.component?.controlId
      || capability.controlId
    );
    if (!logicalControlId) continue;
    const observedControl = (observation.page?.controls || []).find((control) => (
      control.controlId === logicalControlId || control.controlId === capability.controlId
    )) || {};
    const observedState = observedControl.state || observedControl.controlState || {};
    const region = observedControl.visualRegion || capability.visualRegion || null;
    const existing = componentById.get(logicalControlId) || {
      logicalControlId,
      semanticType: clean(capability.pipelineContract?.requirement?.semanticType || capability.semantic || ""),
      label: clipped(capability.targetLabel || capability.label, 200),
      localOwner: {
        sectionId: clean(observedControl.sectionId),
        sectionType: clean(observedControl.sectionType),
        sectionLabel: clipped(observedControl.sectionLabel, 180),
        surfaceId: clean(observedControl.surfaceId)
      },
      currentCanonicalValue: clipped(
        capability.pipelineContract?.component?.currentCanonicalValue
        || observedState.normalizedValue
        || observedState.valueText
        || observedControl.currentValue,
        120
      ),
      desiredCanonicalValue: clipped(capability.pipelineContract?.component?.desiredCanonicalValue || goal.desiredValue, 120),
      placeholder: clipped(observedControl.placeholder || "", 160),
      placeholderActive: Boolean(
        !observedState.valuePresent
        && !observedState.selected
        && !observedState.checked
        && (observedControl.placeholder || observedState.valueText)
      ),
      representationLifecycle: clean(observedControl.representationLifecycle?.status),
      geometry: region ? {
        x: Number(region.x || 0),
        y: Number(region.y || 0),
        width: Number(region.width || 0),
        height: Number(region.height || 0),
        inViewport: region.inViewport !== false
      } : null,
      validation: (observation.page?.validationIssues || []).filter((issue) => (
        issue.controlId && issue.controlId === observedControl.controlId
      )).slice(0, 3).map((issue) => clipped(issue.message, 180)),
      actuators: []
    };
    const actuatorId = clean(
      capability.actuatorId
      || capability.pipelineContract?.capability?.actuatorId
      || capability.targetId
    );
    const blockedBy = capability.exclusionReason
      || (capability.policyStatus && !["allowed", "context_only"].includes(capability.policyStatus)
        ? `policy:${capability.policyStatus}`
        : capability.executionChannel === "reveal"
          ? "viewport"
          : capability.executionChannel === "unavailable"
            ? "unavailable"
            : "");
    const actuator = {
      candidateId: clean(capability.candidateId),
      actuatorId,
      operation: clean(capability.operation),
      method: clean(capability.interactionMethod),
      candidateClass: capability.mechanicalHypothesis === true ? "mechanical_hypothesis" : "proven_action",
      capabilityStatus: clean(capability.capabilityStatus || capability.pipelineContract?.capability?.status),
      actionability: clean(capability.executionChannel || "unavailable"),
      actionabilityEvidence: capability.actionability ? {
        rendered: capability.actionability.rendered === true,
        visible: capability.actionability.visible === true,
        enabled: capability.actionability.enabled === true,
        hitTested: capability.actionability.hitTested === true,
        inViewport: capability.actionability.inViewport === true
      } : null,
      blockedBy: clipped(blockedBy, 140),
      selectable: capability.selectable === true
        || candidates.some((candidate) => candidate.candidateId === capability.candidateId)
    };
    if (!existing.actuators.some((item) => (
      item.candidateId === actuator.candidateId
      && item.actuatorId === actuator.actuatorId
      && item.operation === actuator.operation
      && item.method === actuator.method
    ))) existing.actuators.push(actuator);
    componentById.set(logicalControlId, existing);
  }
  const result = observation.lastActionResult || {};
  const diff = diffObservations(observation.previousObservation || null, observation);
  return {
    contractVersion: "interaction-view/v1",
    observationId: clean(observation.observationId),
    stage: clean(taskState.stage || "unknown"),
    foregroundSurface: compactSurface(currentSurface(observation.page || {})),
    currentObligation: {
      obligationId: clean(obligationField(goal, "goalId")),
      semanticType: clean(obligationField(goal, "semanticType")),
      desiredCanonicalValue: clipped(obligationField(goal, "desiredValue") || obligationField(goal, "canonicalValue"), 120),
      successCondition: compactPostcondition(obligationField(goal, "successCondition") || obligationField(goal, "postcondition")),
      outcomeContract: compactOutcome(obligationField(goal, "outcomeContract")),
      adaptiveEnvelope: compactAdaptiveEnvelope(obligationField(goal, "adaptiveEnvelope"))
    },
    components: [...componentById.values()].map((component) => ({
      ...component,
      actuators: component.actuators.slice(0, 8)
    })).slice(0, MAX_RELATED_MODEL_CONTROLS),
    recentChanges: {
      appeared: (diff.appeared || []).slice(0, 8),
      disappeared: (diff.disappeared || []).slice(0, 8),
      changed: (diff.changed || []).slice(0, 8),
      validationAppeared: (diff.errorsAppeared || []).slice(0, 6),
      validationCleared: (diff.errorsCleared || []).slice(0, 6),
      surfaceChanged: diff.surfaceChanged === true,
      selectionChanged: diff.selectionChanged === true
    },
    attemptedStrategies: (attemptedStrategies || []).map((item) => ({
      operation: clean(item.operation || item.type),
      method: clean(item.method || item.interactionMethod),
      result: clipped(item.result || item.code || item.outcome, 160)
    })).slice(-8),
    allowedSemanticBindings: (allowedSemanticBindings || []).map((binding) => ({
      componentId: clean(binding.componentId),
      semanticType: clean(binding.semanticType),
      factSource: clean(binding.factSource),
      valuePreview: clipped(binding.valuePreview, 80)
    })).slice(0, 40),
    forbiddenEffects: (forbiddenEffects || []).map(clean).filter(Boolean).slice(0, 16),
    successCondition: compactPostcondition(successCondition),
    recentResult: result && Object.keys(result).length ? {
      actionId: clean(result.actionId || result.action?.id),
      ok: result.ok === true || result.verification?.ok === true,
      code: clean(result.code || result.failureCode || result.verification?.code),
      outcomeType: clean(result.outcome?.type || result.verification?.outcome?.type)
    } : null
  };
}

module.exports = {
  MAX_RELATED_MODEL_CONTROLS,
  clean,
  clipped,
  compileInteractionView
};
