const { callStructured } = require("./openai-client");
const { candidateSelectionSchemaFor } = require("./schemas");
const { currentSurface } = require("./surface-contract");
const { diffObservations } = require("./observation-diff");
const { taskBindingGoal } = require("./authority-frames");

const MAX_RELATED_MODEL_CONTROLS = 20;
const CANDIDATE_MODEL_PACKET_BYTES = 24_000;

const INSTRUCTIONS = [
  "Interpret only the current foreground surface, then select exactly one supplied candidateId and one semanticOutcome.",
  "Context capabilities describe every grounded control on the current surface, including blocked controls.",
  "Selectable candidates are grounded, actionable, and policy-safe. Choose only from selectableCandidates.",
  "A mechanical_hypothesis is one reversible, exact-actuator discovery action. Use it only to reveal the current goal's owned child surface; never treat it as semantic completion.",
  "After one mechanical hypothesis the browser must reobserve. Do not infer or emit a second action.",
  "When adaptiveEnvelope is present, remain inside its exact surface, operations, risk limits, step budget, and semantic objective.",
  "Do not invent targets, values, keys, geometry, or another action.",
  "Semantic intent and outcome compatibility are guidance only. You may select a grounded safe candidate whose semantic classification is unknown when it is relevant to the visible foreground surface.",
  "Prefer the simplest direct candidate likely to satisfy the semantic postcondition.",
  "For editable comboboxes, direct typing is usually preferable to opening a list; a country-name query is useful when typing the code is unlikely to commit.",
  "Use a visual candidate only when the DOM/accessibility candidates are not credible.",
  "Return only a candidateId that appears in the supplied candidates, a semanticOutcome, and your confidence from the schema."
].join(" ");

function clean(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function clipped(value = "", limit = 240) {
  return clean(value).slice(0, limit);
}

function compactSurfaceForCandidateModel(surface = null) {
  if (!surface || typeof surface !== "object") return null;
  return {
    id: clean(surface.id),
    type: clean(surface.type),
    label: clipped(surface.label, 240),
    blocksBackground: surface.blocksBackground === true
  };
}

function compactPostconditionForCandidateModel(postcondition = null) {
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

function compactOutcomeContractForCandidateModel(contract = null) {
  if (!contract || typeof contract !== "object") return null;
  return {
    outcomeId: clipped(contract.outcomeId, 180),
    taskOutcome: clean(contract.taskOutcome),
    acceptablePhysicalEffects: (contract.acceptablePhysicalEffects || []).map(clean).filter(Boolean).slice(0, 8),
    completionEvidence: (contract.completionEvidence || []).map(clean).filter(Boolean).slice(0, 8)
  };
}

function compactAdaptiveEnvelopeForCandidateModel(envelope = null) {
  if (!envelope || typeof envelope !== "object") return null;
  return {
    contractVersion: clean(envelope.contractVersion),
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
    const candidateClass = capability.mechanicalHypothesis === true
      ? "mechanical_hypothesis"
      : "proven_action";
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
      candidateClass,
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
    foregroundSurface: compactSurfaceForCandidateModel(currentSurface(observation.page || {})),
    currentGoal: {
      goalId: clean(goal.goalId),
      semanticType: clean(goal.semanticType),
      desiredCanonicalValue: clipped(goal.desiredValue || goal.canonicalValue, 120),
      postcondition: compactPostconditionForCandidateModel(goal.postcondition),
      outcomeContract: compactOutcomeContractForCandidateModel(goal.outcomeContract),
      adaptiveEnvelope: compactAdaptiveEnvelopeForCandidateModel(goal.adaptiveEnvelope)
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
    successCondition: compactPostconditionForCandidateModel(successCondition),
    recentResult: result && Object.keys(result).length ? {
      actionId: clean(result.actionId || result.action?.id),
      ok: result.ok === true || result.verification?.ok === true,
      code: clean(result.code || result.failureCode || result.verification?.code),
      outcomeType: clean(result.outcome?.type || result.verification?.outcome?.type)
    } : null
  };
}

async function selectCandidate({
  apiKey,
  model,
  goal,
  taskState = {},
  candidates,
  contextCapabilities = [],
  observation,
  screenshotDataUrl = ""
}) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    const error = new Error("No current executable candidates were published for planner selection.");
    error.code = "NO_CURRENT_CANDIDATES";
    throw error;
  }
  const selectableCandidates = candidates.slice(0, MAX_RELATED_MODEL_CONTROLS);
  const suppliedCapabilities = Array.isArray(contextCapabilities) && contextCapabilities.length
    ? contextCapabilities
    : candidates;
  const capabilityById = new Map();
  for (const capability of [...selectableCandidates, ...suppliedCapabilities]) {
    const id = capability.candidateId || capability.capabilityId || capability.controlId;
    if (!id) continue;
    if (capabilityById.has(id)) {
      capabilityById.set(id, { ...capabilityById.get(id), ...capability });
    } else if (capabilityById.size < MAX_RELATED_MODEL_CONTROLS) {
      capabilityById.set(id, capability);
    }
  }
  const allCapabilities = [...capabilityById.values()];
  const needsScreenshot = ["adaptive_surface", "adaptive_interaction"].includes(goal.kind) || allCapabilities.some((candidate) => (
    candidate.type === "click_xy"
    || candidate.mechanicalHypothesis === true
    || (!candidate.controlId && candidate.visualRegion)
    || candidate.affordance?.actuator?.source === "visual_fallback"
  ));
  const payload = {
      interactionView: compileInteractionView({
        goal,
        taskState,
        candidates: selectableCandidates,
        contextCapabilities: allCapabilities,
        observation
      }),
      selectableCandidates: selectableCandidates.map((candidate) => ({
        candidateId: candidate.candidateId,
        candidateClass: candidate.mechanicalHypothesis === true ? "mechanical_hypothesis" : "proven_action",
        logicalControlId: candidate.logicalControlId || candidate.controlId || "",
        actuatorId: candidate.actuatorId || candidate.targetId || "",
        type: candidate.type,
        operation: candidate.operation,
        interactionRole: candidate.interactionRole || "",
        semanticEffect: candidate.semanticEffect || "",
        expectedEvidence: candidate.expectedEvidence || "",
        mechanicalEffect: candidate.mechanicalEffect || candidate.physicalEffect || candidate.affordance?.mechanicalEffect || candidate.affordance?.effect || "unknown",
        semanticIntent: candidate.semanticIntent || "unknown",
        expectedPostconditions: (candidate.expectedPostconditions || []).slice(0, 3).map((item) => ({
          type: item.type || "",
          decisionGroupId: item.decisionGroupId || "",
          controlId: item.controlId || ""
        })),
        outcomeCompatibility: candidate.outcomeCompatibility || "compatible",
        stableControlIdentity: candidate.affordance?.stableKey || candidate.stableKey || candidate.controlId || "",
        risk: candidate.risk || "uncertain",
        structuredPrice: candidate.structuredPrice || null,
        value: candidate.value || "",
        keys: candidate.keys || "",
        summary: clipped(candidate.summary, 240),
        visual: Boolean(candidate.visualRegion)
      }))
    };
  const metas = [];
  for (let attempt = 1; attempt <= 1; attempt += 1) {
    const { data, meta } = await callStructured({
      apiKey,
      model,
      instructions: INSTRUCTIONS,
      payload: { ...payload, candidateSelectionAttempt: attempt },
      screenshotDataUrl: needsScreenshot ? screenshotDataUrl : "",
      schema: candidateSelectionSchemaFor(selectableCandidates.map((candidate) => candidate.candidateId)),
      schemaName: "checkout_candidate_selection",
      // Keep the response compact, but leave enough room for the structured
      // output machinery to emit the observation-bound enum value reliably.
      maxOutputTokens: 400,
      returnMeta: true,
      maxPayloadBytes: CANDIDATE_MODEL_PACKET_BYTES
    });
    metas.push(meta);
    const candidateId = String(data?.candidateId || "");
    if (selectableCandidates.some((candidate) => candidate.candidateId === candidateId)) {
      return {
        candidateId,
        semanticOutcome: String(data?.semanticOutcome || ""),
        confidence: ["high", "medium", "low"].includes(String(data?.confidence || "").toLowerCase())
          ? String(data.confidence).toLowerCase()
          : "unknown",
        meta: { ...(meta || {}), candidateSelectionAttempts: attempt, retryMetas: metas }
      };
    }
  }
  const error = new Error("Candidate selector exhausted bounded reselection against the unchanged candidate set.");
  error.code = "PLANNER_CANDIDATE_NOT_CURRENT";
  error.selectionAttempts = 1;
  throw error;
}

module.exports = {
  compileInteractionView,
  selectCandidate
};
