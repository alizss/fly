const agentContract = require("../../extension/src/shared/agent-contract");
const { factsFromObservation } = require("./transaction-facts");
const { fieldDescriptors } = require("./skill-expander");
const { buildCanonicalDecisions } = require("./canonical-decision");

const OBSERVATION_FRAME_VERSION = "observation-frame/v2";
const DECISION_FRAME_VERSION = "decision-frame/v2";
const CURRENT_OBLIGATION_VERSION = "current-obligation/v2";

function clean(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function unique(values = []) {
  return [...new Set(values.map(clean).filter(Boolean))];
}

function freezeArray(values = []) {
  if (Array.isArray(values)) return Object.freeze([...values]);
  if (values == null || values === "") return Object.freeze([]);
  return Object.freeze([values]);
}

function arrayReference(values = []) {
  if (Array.isArray(values)) return values;
  if (values == null || values === "") return [];
  return [values];
}

function observationHash(observation = {}) {
  return clean(observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash);
}

function surfaceEvidence(page = {}) {
  const surface = page.currentSurface || page.activeSurface || {};
  return Object.freeze({
    id: clean(surface.id || "surface-page"),
    type: clean(surface.type || "page"),
    surfaceClass: clean(surface.surfaceClass || "unknown"),
    label: clean(surface.label),
    blocksBackground: surface.blocksBackground === true
  });
}

function createObservationFrame(observation = {}) {
  const page = observation.page || {};
  return Object.freeze({
    contractVersion: OBSERVATION_FRAME_VERSION,
    observationId: clean(observation.observationId),
    observationHash: observationHash(observation),
    previousObservationId: clean(observation.previousObservation?.observationId),
    url: clean(page.url),
    stageEvidence: Object.freeze({
      observedStep: clean(page.step),
      routePath: clean(page.routePath),
      evidence: freezeArray(page.stepEvidence || page.stageEvidence || [])
    }),
    surface: surfaceEvidence(page),
    mechanics: Object.freeze({
      // Controls are already immutable observation evidence addressed by the
      // observation hash. Referencing them avoids copying high-cardinality
      // seat maps merely to wrap the frame.
      controls: arrayReference(page.controls),
      stageExit: page.stageExit || null,
      viewport: page.viewport || null
    }),
    evidence: Object.freeze({
      transactionFacts: page.transactionFacts || null,
      terminalEvidence: page.terminalEvidence || null,
      validationIssues: freezeArray(page.validationIssues),
      errors: freezeArray(page.errors),
      mutationIdentity: clean(observation.observationUpdate?.diff?.identity || observation.mutationIdentity),
      previousActionResult: observation.lastActionResult || null
    })
  });
}

function compileDecisionFrame({
  observation = {},
  observationFrame = null,
  semanticCompilation = null,
  state = {},
  traveler = {}
} = {}) {
  const sourceFrame = observationFrame || createObservationFrame(observation);
  if (sourceFrame.observationId !== clean(observation.observationId)
    || sourceFrame.observationHash !== observationHash(observation)) {
    throw new Error("DECISION_FRAME_OBSERVATION_MISMATCH");
  }
  const rawPage = observation.page || {};
  const compilation = semanticCompilation || agentContract.compileSemanticCheckout(rawPage);
  const semanticPage = {
    ...rawPage,
    selectedBooking: rawPage.selectedBooking || state.transactionInvariants?.baseline || null,
    controls: compilation.controls,
    decisionGroups: compilation.decisionGroups,
    decisionContracts: compilation.decisionContracts,
    semanticReadiness: compilation.semanticReadiness,
    semanticCompilation: compilation
  };
  const semanticObservation = {
    ...observation,
    page: semanticPage,
    observationSnapshot: observation.observationSnapshot
      ? Object.freeze({ ...observation.observationSnapshot, controls: compilation.controls })
      : observation.observationSnapshot
  };
  const transactionFacts = factsFromObservation(state, semanticObservation, traveler, {
    authoritativeTransactionFacts: rawPage.transactionFacts || null
  });
  const page = Object.freeze({ ...semanticPage, transactionFacts });
  const compiledObservation = Object.freeze({ ...semanticObservation, page });
  // Logical profile descriptors are compiled exactly once into DecisionFrame.
  // TaskState may reconcile them with durable verified outcomes, but must not
  // rediscover field meaning from the DOM a second time.
  const profileRequirements = fieldDescriptors(compiledObservation, traveler);
  const standaloneDecisions = buildCanonicalDecisions({
    page: { ...page, decisionGroups: [] },
    userPolicy: {},
    traveler: {},
    decisionEpisode: null
  });
  return Object.freeze({
    contractVersion: DECISION_FRAME_VERSION,
    frameId: `${sourceFrame.observationId || "observation"}:${sourceFrame.observationHash || "unhashed"}:decision-v2`,
    observationId: sourceFrame.observationId,
    observationHash: sourceFrame.observationHash,
    observationFrame: sourceFrame,
    observation: compiledObservation,
    semanticCompilation: compilation,
    profileRequirements: freezeArray(profileRequirements),
    standaloneDecisions: freezeArray(standaloneDecisions),
    commerceDecisions: compilation.decisionGroups || [],
    navigationOpportunity: page.stageExit || null,
    transactionFacts,
    terminalEvidence: page.terminalEvidence || null,
    validationBlockers: arrayReference(page.validationIssues),
    provenance: Object.freeze({
      compiler: "agent-contract.compileSemanticCheckout",
      compilerVersion: clean(compilation.contractVersion || agentContract.CONTRACT_VERSION),
      sourceObservationId: sourceFrame.observationId,
      sourceObservationHash: sourceFrame.observationHash
    })
  });
}

function decisionFrameOwnsObservation(decisionFrame = null, observation = {}) {
  return Boolean(
    decisionFrame?.contractVersion === DECISION_FRAME_VERSION
    && decisionFrame.observationId === clean(observation.observationId)
    && decisionFrame.observationHash === observationHash(observation)
  );
}

function admittedControlIds(goal = {}) {
  const explicit = unique([...(goal.candidateControlIds || []), ...(goal.actionableControlIds || [])]);
  if (explicit.length) return explicit;
  if (goal.policyChoiceBounded === true) return unique(goal.policyAllowedControlIds || []);
  if (goal.kind === "profile_field") {
    return unique([
      goal.controlId,
      goal.componentBinding?.controlId,
      ...(goal.componentBinding?.representationControlIds || []),
      ...(goal.componentBinding?.stateControlIds || [])
    ]);
  }
  return unique(goal.eligibleAlternativeControlIds || []);
}

function obligationSubject(goal = {}) {
  return Object.freeze({
    family: clean(goal.canonicalSubject?.family || goal.subject?.family || goal.family || goal.sectionType),
    key: clean(goal.canonicalSubject?.key || goal.subject?.key || goal.subjectKey || goal.semanticType),
    semanticType: clean(goal.semanticType),
    subjectId: clean(goal.subjectId || "global"),
    decisionGroupId: clean(goal.decisionGroupId),
    requirementId: clean(goal.requirementId),
    logicalFieldId: clean(goal.logicalFieldId)
  });
}

function obligationDesiredEffect(goal = {}) {
  const explicit = clean(goal.semanticEffect || goal.desiredSemanticOutcome || goal.desiredPolicyOutcome);
  if (explicit) return agentContract.canonicalSemanticEffect(explicit);
  if (goal.kind === "profile_field") return agentContract.SEMANTIC_EFFECT.SET_FIELD_VALUE;
  if (goal.semanticType === "navigation") return agentContract.SEMANTIC_EFFECT.ADVANCE_CHECKOUT_STAGE;
  if (goal.semanticType === "completed_choice_surface") return agentContract.SEMANTIC_EFFECT.DISMISS_SURFACE;
  if (["adaptive_surface", "adaptive_interaction"].includes(goal.kind)) return agentContract.SEMANTIC_EFFECT.SAFE_CHECKOUT_PROGRESS;
  return agentContract.canonicalSemanticEffect("resolve_current_decision");
}

function assertObligationConformance({ goal = {}, controls = [], successCondition = {} } = {}) {
  if (successCondition.type !== "decision_group_resolved") return;
  const eligible = new Set(unique(successCondition.eligibleAlternativeControlIds || []));
  if (eligible.size && controls.some((controlId) => !eligible.has(controlId))) {
    throw new Error("CURRENT_OBLIGATION_CONTROL_CANNOT_SATISFY_SUCCESS_CONDITION");
  }
}

function currentObligationFromGoal({ goal = null, decisionFrame = null, recoveryState = {} } = {}) {
  if (!goal) return null;
  const controls = admittedControlIds(goal);
  const successCondition = goal.successCondition || goal.postcondition || goal.outcomeContract || {};
  assertObligationConformance({ goal, controls, successCondition });
  const maxAttempts = Math.max(1, Number(
    goal.recoveryBudget?.maxAttempts
    || goal.adaptiveEnvelope?.remainingSteps
    || 3
  ));
  const mechanics = Object.freeze({
    semanticType: clean(goal.semanticType),
    descriptorKey: clean(goal.descriptorKey),
    ordinal: Number.isFinite(Number(goal.ordinal)) ? Number(goal.ordinal) : null,
    logicalStructure: clean(goal.logicalStructure),
    label: clean(goal.label),
    field: clean(goal.field),
    family: clean(goal.family),
    sectionType: clean(goal.sectionType),
    subjectId: clean(goal.subjectId || "global"),
    decisionGroupId: clean(goal.decisionGroupId),
    requirementId: clean(goal.requirementId),
    logicalFieldId: clean(goal.logicalFieldId),
    controlId: clean(goal.controlId),
    sourceGoalId: clean(goal.sourceGoalId),
    completedDecisionGroupId: clean(goal.completedDecisionGroupId),
    parentSelectedControlId: clean(goal.parentSelectedControlId),
    parentDecisionGroupId: clean(goal.parentDecisionGroupId),
    policyCorrectionForDecisionGroupId: clean(goal.policyCorrectionForDecisionGroupId),
    semanticOwnershipLinkId: clean(goal.semanticOwnershipLinkId),
    intendedOutcome: clean(goal.intendedOutcome),
    desiredPolicyOutcome: clean(goal.desiredPolicyOutcome),
    desiredSemanticOutcome: clean(goal.desiredSemanticOutcome),
    decisionEpisodeId: clean(goal.decisionEpisodeId),
    decisionInstanceId: clean(goal.decisionInstanceId),
    canonicalOwnerId: clean(goal.canonicalOwnerId),
    parentExpectedSelectedControlId: clean(goal.parentExpectedSelectedControlId),
    decisionEpisodeStatus: clean(goal.decisionEpisodeStatus),
    transactionOutcomeId: clean(goal.transactionOutcomeId),
    stageOutcomeId: clean(goal.stageOutcomeId),
    surfaceSubgoalId: clean(goal.surfaceSubgoalId),
    componentRole: clean(goal.componentRole),
    desiredValue: goal.desiredValue ?? "",
    canonicalValue: goal.canonicalValue ?? goal.desiredValue ?? "",
    inputValue: goal.inputValue ?? "",
    expectedValue: goal.expectedValue ?? goal.inputValue ?? "",
    expectedNormalizedValue: goal.expectedNormalizedValue ?? goal.desiredValue ?? "",
    expectedCanonicalValue: goal.expectedCanonicalValue ?? goal.canonicalValue ?? goal.desiredValue ?? "",
    choiceLike: goal.choiceLike === true,
    selectionMode: clean(goal.selectionMode),
    policyChoiceBounded: goal.policyChoiceBounded === true,
    choiceTerms: freezeArray(goal.choiceTerms),
    freeAlternativeControlIds: freezeArray(goal.freeAlternativeControlIds),
    paidAlternativeControlIds: freezeArray(goal.paidAlternativeControlIds),
    eligibleAlternativeControlIds: freezeArray(goal.eligibleAlternativeControlIds),
    surfaceExitControlIds: freezeArray(goal.surfaceExitControlIds),
    componentBinding: goal.componentBinding ? Object.freeze({ ...goal.componentBinding }) : null,
    requirementContract: goal.requirementContract ? Object.freeze({ ...goal.requirementContract }) : null,
    expectedOutcome: goal.expectedOutcome ? Object.freeze({ ...goal.expectedOutcome }) : null,
    postcondition: goal.postcondition ? Object.freeze({ ...goal.postcondition }) : null,
    parentOutcomeContract: goal.parentOutcomeContract ? Object.freeze({ ...goal.parentOutcomeContract }) : null,
    surfaceExitOwnership: goal.surfaceExitOwnership ? Object.freeze({ ...goal.surfaceExitOwnership }) : null,
    validationOwnership: goal.validationOwnership ? Object.freeze({ ...goal.validationOwnership }) : null,
    dateCodec: goal.dateCodec ? Object.freeze({ ...goal.dateCodec }) : null,
    codecError: goal.codecError ? Object.freeze({ ...goal.codecError }) : null,
    reconciliation: goal.reconciliation ? Object.freeze({ ...goal.reconciliation }) : null,
    adaptiveEnvelope: goal.adaptiveEnvelope ? Object.freeze({ ...goal.adaptiveEnvelope }) : null
  });
  const obligation = {
    contractVersion: CURRENT_OBLIGATION_VERSION,
    obligationId: clean(goal.goalId || goal.requirementId || goal.decisionGroupId),
    authority: "task_state",
    observationId: clean(decisionFrame?.observationId || goal.observationId),
    observationHash: clean(decisionFrame?.observationHash),
    surfaceId: clean(goal.owner?.surfaceId || goal.surfaceId || decisionFrame?.observationFrame?.surface?.id || "surface-page"),
    kind: clean(goal.kind || goal.semanticType || "unknown"),
    subject: obligationSubject(goal),
    objective: clean(goal.objective || goal.semanticGoal || "resolve the current checkout obligation"),
    desiredEffect: obligationDesiredEffect(goal),
    desiredValue: goal.desiredValue ?? goal.canonicalValue ?? "",
    admittedControlIds: freezeArray(controls),
    policyDecision: Object.freeze({
      status: goal.admission?.status === "blocked" || goal.ambiguity ? "blocked" : "admitted",
      profileCompatible: goal.profileCompatible !== false && !goal.ambiguity,
      authorizationId: clean(goal.authorization?.authorizationId),
      authorization: goal.authorization ? Object.freeze({ ...goal.authorization }) : null,
      ambiguity: goal.ambiguity ? Object.freeze({ ...goal.ambiguity }) : null,
      reason: clean(goal.admission?.reason || goal.ambiguity?.code || "authoritative_current_obligation")
    }),
    risk: clean(goal.riskClass || goal.risk || "reversible"),
    successCondition: Object.freeze({ ...successCondition }),
    recoveryBudget: Object.freeze({
      maxAttempts,
      attemptedStrategies: Number(recoveryState.attempts || 0),
      remainingAttempts: Math.max(0, maxAttempts - Number(recoveryState.attempts || 0))
    })
  };
  // This is the one turn-local mechanics input for the admitted obligation.
  // It is explicit instead of hidden in a WeakMap, and the durable session
  // compactor deliberately drops it. A resumed turn recompiles it from the
  // fresh DecisionFrame before any actuator can be leased.
  obligation.mechanics = mechanics;
  return Object.freeze(obligation);
}

function currentObligation(taskState = {}) {
  const obligation = taskState?.currentObligation || null;
  return obligation?.contractVersion === CURRENT_OBLIGATION_VERSION ? obligation : null;
}

function mechanicsForObligation(obligation = null) {
  if (!obligation || obligation.contractVersion !== CURRENT_OBLIGATION_VERSION) return null;
  const subject = obligation.subject || {};
  const mechanics = obligation.mechanics || {};
  return Object.freeze({
    ...mechanics,
    // These names are the direct mechanics-binder view of the obligation.
    // They are derived here rather than stored as a second goal authority.
    obligationId: obligation.obligationId,
    goalId: obligation.obligationId,
    kind: obligation.kind,
    objective: obligation.objective,
    semanticGoal: obligation.objective,
    desiredEffect: obligation.desiredEffect,
    semanticEffect: obligation.desiredEffect,
    desiredValue: obligation.desiredValue,
    admittedControlIds: obligation.admittedControlIds,
    candidateControlIds: obligation.admittedControlIds,
    actionableControlIds: obligation.admittedControlIds,
    policyAllowedControlIds: obligation.admittedControlIds,
    policyDecision: obligation.policyDecision,
    admission: Object.freeze({
      status: obligation.policyDecision?.status,
      reason: obligation.policyDecision?.reason
    }),
    profileCompatible: obligation.policyDecision?.profileCompatible !== false,
    risk: obligation.risk,
    riskClass: obligation.risk,
    successCondition: obligation.successCondition,
    outcomeContract: obligation.successCondition,
    recoveryBudget: obligation.recoveryBudget,
    observationId: obligation.observationId,
    observationHash: obligation.observationHash,
    surfaceId: obligation.surfaceId,
    subject,
    semanticType: subject.semanticType || "",
    family: subject.family || "",
    subjectId: subject.subjectId || "global",
    decisionGroupId: subject.decisionGroupId || "",
    requirementId: subject.requirementId || "",
    logicalFieldId: mechanics.logicalFieldId || subject.logicalFieldId || ""
  });
}

module.exports = {
  CURRENT_OBLIGATION_VERSION,
  DECISION_FRAME_VERSION,
  OBSERVATION_FRAME_VERSION,
  compileDecisionFrame,
  createObservationFrame,
  currentObligation,
  currentObligationFromGoal,
  decisionFrameOwnsObservation,
  mechanicsForObligation
};
