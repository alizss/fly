const crypto = require("node:crypto");
const agentContract = require("../../extension/src/shared/agent-contract");
const { factsFromObservation } = require("./transaction-facts");
const { fieldDescriptors } = require("./profile-requirements");
const {
  buildCanonicalDecisions,
  canonicalDecisionForGroup
} = require("./canonical-decision");
const {
  normalizeSemanticOwner,
  semanticOwnerId
} = require("../../../packages/shared/semantic-owner");
const {
  CHECKOUT_SCENE_VERSION,
  createCheckoutScene,
  checkoutSceneOwnsObservation
} = require("./checkout-scene");
const { applyScenePatch } = require("./semantic-scene-reconciliation");

const OBSERVATION_FRAME_VERSION = "observation-frame/v2";
const CURRENT_OBLIGATION_VERSION = "current-obligation/v2";

function clean(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function stableDigest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
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

function settleObservedExclusiveGroups(compilation = {}) {
  const controlsById = new Map((compilation.controls || []).map((control) => [control.controlId, control]));
  const groups = (compilation.decisionGroups || []).map((group) => {
    const controlIds = unique([
      ...(group.alternativeControlIds || []),
      ...(group.alternatives || []).map((option) => option.controlId),
      ...(group.decisionContract?.options || []).map((option) => option.controlId)
    ]);
    const selected = controlIds.filter((controlId) => (
      agentContract.controlSelectionCommitted(controlsById.get(controlId) || {})
    ));
    if (selected.length !== 1) return group;
    return Object.freeze({
      ...group,
      selectedControlId: selected[0],
      status: "satisfied",
      satisfied: true,
      completionReason: "explicit_current_selected_state"
    });
  });
  const resolvedIds = new Set(groups.filter((group) => (
    ["satisfied", "waived", "waived_by_policy"].includes(group.status)
  )).map((group) => clean(group.decisionGroupId || group.requirementId)).filter(Boolean));
  return Object.freeze({
    ...compilation,
    decisionGroups: Object.freeze(groups),
    currentExecutableObligations: Object.freeze((compilation.currentExecutableObligations || []).filter((id) => !resolvedIds.has(clean(id))))
  });
}

function sceneStateDescriptor(group = {}) {
  const label = clean(`${group.sectionLabel || ""} ${group.decisionContract?.subjectLabel || ""} ${group.requirementId || ""}`).toLowerCase();
  const options = group.decisionContract?.options || group.alternatives || [];
  const optionText = clean(options.map((option) => `${option.label || ""} ${option.semantic || ""}`).join(" ")).toLowerCase();
  const hasEconomicEvidence = options.some((option) => (
    Number(option.structuredPrice?.amount) > 0
    || Number(option.priceDelta) > 0
    || /paid|price|fare|baggage|seat|insurance|extra|bundle/.test(clean(`${option.semantic || ""} ${option.risk || ""}`).toLowerCase())
  ));
  if (hasEconomicEvidence) return null;
  let semanticType = "";
  if ((/natural person/.test(optionText) && /legal person/.test(optionText))
    || /you are purchasing as|purchaser(?: type)?/.test(label)) {
    semanticType = "purchaser_type";
  } else if (/payment method/.test(label)
    || /meansofpayment/.test(optionText)
    || (/credit.*debit.*card/.test(optionText) && /saved card/.test(optionText))
    || (/payment/.test(`${label} ${group.sectionType || ""}`) && /credit.*debit card|saved card/.test(optionText))) {
    semanticType = "payment_method";
  } else if (/survey/.test(`${label} ${optionText}`)) {
    semanticType = "survey_consent";
  } else if (/marketing|promotional|third.party offers|receive information/.test(`${label} ${optionText}`)) {
    semanticType = "marketing_consent";
  }
  if (!semanticType) return null;
  const selected = options.find((option) => option.controlId === group.selectedControlId || option.selected === true) || null;
  const selectedText = clean(selected?.label || group.selectedLabel).toLowerCase();
  const optionalConsent = ["survey_consent", "marketing_consent"].includes(semanticType);
  const selectedValue = semanticType === "purchaser_type"
    ? (/legal person/.test(selectedText) && !/natural person/.test(selectedText) ? "legal_person" : "natural_person")
    : semanticType === "payment_method"
      ? (/saved/.test(selectedText) ? "saved_card" : /credit|debit|card/.test(selectedText) ? "credit_debit_card" : selectedText)
      : selected ? "selected" : "not_selected";
  return Object.freeze({
    semanticType,
    selectedValue,
    status: optionalConsent
      ? (selected ? "unresolved" : "resolved")
      : selected || ["satisfied", "waived", "waived_by_policy"].includes(group.status)
        ? "resolved"
        : "unresolved",
    consequence: optionalConsent ? "optional_consent" : "non_commerce",
    requiredness: optionalConsent && selected
      ? "policy_required"
      : semanticType === "payment_method" || group.required === true
        ? "progression_required"
        : "optional_meaningful"
  });
}

function sceneStateOnlyGroup(group = {}) {
  const descriptor = sceneStateDescriptor(group);
  // A selected method is scene state. An unresolved method is executable
  // progression work and must flow through the existing decision mechanics.
  return Boolean(descriptor && !(descriptor.semanticType === "payment_method" && descriptor.status === "unresolved"));
}

function progressionDecisionGroup(group = {}) {
  const descriptor = sceneStateDescriptor(group);
  if (descriptor?.semanticType !== "payment_method" || descriptor.status !== "unresolved") return group;
  return Object.freeze({
    ...group,
    required: true,
    material: true,
    status: "missing",
    progressionRole: "payment_method"
  });
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

function compileCheckoutScene({
  observation = {},
  observationFrame = null,
  semanticCompilation = null,
  scenePatch = null,
  state = {},
  traveler = {}
} = {}) {
  const sourceFrame = observationFrame || createObservationFrame(observation);
  if (sourceFrame.observationId !== clean(observation.observationId)
    || sourceFrame.observationHash !== observationHash(observation)) {
    throw new Error("CHECKOUT_SCENE_OBSERVATION_MISMATCH");
  }
  const rawPage = observation.page || {};
  const deterministicCompilation = semanticCompilation || agentContract.compileSemanticCheckout(rawPage);
  const extractedCompilation = scenePatch
    ? applyScenePatch(deterministicCompilation, scenePatch, scenePatch.uncertainty || {}, observation)
    : deterministicCompilation;
  const compilation = settleObservedExclusiveGroups(extractedCompilation);
  const semanticPage = {
    ...rawPage,
    selectedBooking: rawPage.selectedBooking || state.transactionInvariants?.baseline || null,
    controls: compilation.controls,
    fields: compilation.fields || rawPage.fields,
    validationIssues: compilation.validationIssues || rawPage.validationIssues,
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
  // Logical profile descriptors are compiled exactly once into CheckoutScene.
  // TaskState may reconcile them with durable verified outcomes, but must not
  // rediscover field meaning from the DOM a second time.
  const profileRequirements = fieldDescriptors(compiledObservation, traveler);
  const groupedControlIds = new Set((compilation.decisionGroups || []).flatMap((group) => [
    ...(group.alternativeControlIds || []),
    ...(group.alternatives || []).map((option) => option.controlId),
    ...(group.decisionContract?.options || []).map((option) => option.controlId)
  ]).filter(Boolean));
  const standaloneDecisions = buildCanonicalDecisions({
    page: { ...page, decisionGroups: [] },
    userPolicy: {},
    traveler: {},
    decisionEpisode: null
  }).filter((decision) => !(decision.physicalControlIds || []).some((controlId) => groupedControlIds.has(controlId)));
  const commerceGroups = (compilation.decisionGroups || [])
    .filter((group) => !sceneStateOnlyGroup(group))
    .map(progressionDecisionGroup);
  // CheckoutScene compiles the policy-neutral semantic entity once. TaskState
  // may reconcile this typed entity with user policy and durable history, but
  // it cannot rediscover its subject/family by scanning raw labels again.
  const commerceItems = commerceGroups.map((group) => canonicalDecisionForGroup({
    group,
    page,
    previousCompletion: null,
    userPolicy: {},
    traveler: {},
    decisionEpisode: null
  }));
  const stateItems = (compilation.decisionGroups || []).filter(sceneStateOnlyGroup).map((group) => Object.freeze({
    ...group,
    sceneState: sceneStateDescriptor(group)
  }));
  return createCheckoutScene({
    observation,
    observationFrame: sourceFrame,
    semanticState: compilation,
    compiledObservation,
    profileItems: profileRequirements,
    decisionItems: standaloneDecisions,
    stateItems,
    commerceItems,
    transactionFacts,
    terminalEvidence: page.terminalEvidence || null,
    validationBlockers: arrayReference(page.validationIssues),
    checkoutMandate: state.checkoutMandate || null,
    patch: scenePatch
  });
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
    stage: clean(goal.stage || goal.owner?.stage),
    family: clean(goal.canonicalSubject?.family || goal.subject?.family || goal.family || goal.sectionType),
    key: clean(goal.canonicalSubject?.key || goal.subject?.key || goal.subjectKey || goal.semanticType),
    semanticType: clean(goal.semanticType),
    subjectId: clean(goal.subjectId || "global"),
    passengerId: clean(goal.canonicalSubject?.passengerId || goal.passengerId || goal.travelerId),
    segmentId: clean(goal.canonicalSubject?.segmentId || goal.segmentId),
    repeatedInstance: clean(goal.canonicalSubject?.repeatedInstance || goal.decisionInstanceId),
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

function sceneItemForGoal(goal = {}, checkoutScene = null) {
  const admitted = new Set(admittedControlIds(goal));
  const semanticKeys = new Set(unique([
    goal.sceneItemId,
    goal.decisionGroupId,
    goal.requirementId,
    goal.logicalFieldId,
    goal.descriptorKey,
    goal.semanticType,
    goal.subjectKey
  ]));
  const desiredRole = goal.semanticType === "navigation"
    ? "navigation"
    : goal.semanticType === "legal_attestation" || goal.kind === "legal_attestation"
      ? "legal_attestation"
    : goal.kind === "profile_field"
      ? "profile_field"
      : "checkout_decision";
  return (checkoutScene?.items || [])
    .map((item) => ({
      item,
      overlap: (item.controlIds || []).filter((controlId) => admitted.has(controlId)).length,
      roleMatch: item.role === desiredRole ? 1 : 0,
      semanticMatch: semanticKeys.has(clean(item.sceneItemId))
        || semanticKeys.has(clean(item.subject))
        || semanticKeys.has(clean(item.repeatedInstance))
        ? 1
        : 0
    }))
    .filter((entry) => entry.overlap > 0 || entry.semanticMatch > 0)
    .sort((left, right) => (right.roleMatch - left.roleMatch)
      || (right.semanticMatch - left.semanticMatch)
      || (right.overlap - left.overlap))[0]?.item || null;
}

function currentObligationFromGoal({ goal = null, checkoutScene = null } = {}) {
  if (!goal) return null;
  const controls = admittedControlIds(goal);
  const sceneItem = sceneItemForGoal(goal, checkoutScene);
  const goalSuccessCondition = goal.successCondition || goal.postcondition || goal.outcomeContract || {};
  assertObligationConformance({ goal, controls, successCondition: goalSuccessCondition });
  if (!sceneItem?.sceneItemId) {
    throw new Error("CURRENT_OBLIGATION_SCENE_ITEM_REQUIRED");
  }
  const successCondition = sceneItem?.expectedPostcondition
    ? { ...sceneItem.expectedPostcondition, ...goalSuccessCondition }
    : goalSuccessCondition;
  assertObligationConformance({ goal, controls, successCondition });
  const binding = Object.freeze({
    component: Object.freeze({
      semanticType: clean(goal.semanticType),
      descriptorKey: clean(goal.descriptorKey),
      ordinal: Number.isFinite(Number(goal.ordinal)) ? Number(goal.ordinal) : null,
      logicalStructure: clean(goal.logicalStructure),
      label: clean(goal.label),
      field: clean(goal.field),
      logicalFieldId: clean(goal.logicalFieldId),
      controlId: clean(goal.controlId),
      role: clean(goal.componentRole),
      desiredValue: goal.desiredValue ?? "",
      canonicalValue: goal.canonicalValue ?? goal.desiredValue ?? "",
      inputValue: goal.inputValue ?? "",
      expectedValue: goal.expectedValue ?? goal.inputValue ?? "",
      expectedNormalizedValue: goal.expectedNormalizedValue ?? goal.desiredValue ?? "",
      expectedCanonicalValue: goal.expectedCanonicalValue ?? goal.canonicalValue ?? goal.desiredValue ?? "",
      choiceLike: goal.choiceLike === true,
      componentContract: goal.componentBinding ? Object.freeze({ ...goal.componentBinding }) : null,
      requirementContract: goal.requirementContract ? Object.freeze({ ...goal.requirementContract }) : null,
      localPostcondition: goal.expectedOutcome ? Object.freeze({ ...goal.expectedOutcome }) : null,
      semanticPostcondition: goal.postcondition ? Object.freeze({ ...goal.postcondition }) : null,
      validationOwnership: goal.validationOwnership ? Object.freeze({ ...goal.validationOwnership }) : null,
      dateCodec: goal.dateCodec ? Object.freeze({ ...goal.dateCodec }) : null,
      codecError: goal.codecError ? Object.freeze({ ...goal.codecError }) : null,
      reconciliation: goal.reconciliation ? Object.freeze({ ...goal.reconciliation }) : null
    }),
    choice: Object.freeze({
      mode: clean(goal.selectionMode),
      policyBounded: goal.policyChoiceBounded === true,
      terms: freezeArray(goal.choiceTerms),
      freeControlIds: freezeArray(goal.freeAlternativeControlIds),
      paidControlIds: freezeArray(goal.paidAlternativeControlIds),
      eligibleControlIds: freezeArray(goal.eligibleAlternativeControlIds),
      semanticCorrectionControlIds: freezeArray(goal.semanticCorrectionControlIds)
    }),
    surface: Object.freeze({
      sectionType: clean(goal.sectionType),
      exitControlIds: freezeArray(goal.surfaceExitControlIds),
      completedDecisionGroupId: clean(goal.completedDecisionGroupId),
      parentSelectedControlId: clean(goal.parentSelectedControlId),
      parentDecisionGroupId: clean(goal.parentDecisionGroupId),
      parentExpectedSelectedControlId: clean(goal.parentExpectedSelectedControlId),
      exitOwnership: goal.surfaceExitOwnership ? Object.freeze({ ...goal.surfaceExitOwnership }) : null,
      parentOutcome: goal.parentOutcomeContract ? Object.freeze({ ...goal.parentOutcomeContract }) : null
    }),
    lineage: Object.freeze({
      sourceObligationId: clean(goal.sourceGoalId),
      policyCorrectionDecisionGroupId: clean(goal.policyCorrectionForDecisionGroupId),
      semanticOwnershipLinkId: clean(goal.semanticOwnershipLinkId),
      intendedOutcome: clean(goal.intendedOutcome),
      desiredPolicyOutcome: clean(goal.desiredPolicyOutcome),
      desiredSemanticOutcome: clean(goal.desiredSemanticOutcome),
      decisionEpisodeId: clean(goal.decisionEpisodeId),
      decisionInstanceId: clean(goal.decisionInstanceId),
      canonicalOwnerId: clean(goal.canonicalOwnerId),
      decisionEpisodeStatus: clean(goal.decisionEpisodeStatus),
      transactionOutcomeId: clean(goal.transactionOutcomeId),
      stageOutcomeId: clean(goal.stageOutcomeId),
      surfaceSubgoalId: clean(goal.surfaceSubgoalId)
    }),
    adaptive: goal.adaptiveEnvelope ? Object.freeze({ ...goal.adaptiveEnvelope }) : null
  });
  const owner = normalizeSemanticOwner({
    stage: goal.stage || goal.owner?.stage || checkoutScene?.observation?.page?.step,
    family: goal.canonicalSubject?.family || goal.subject?.family || goal.family || goal.sectionType || goal.semanticType,
    subjectId: goal.subjectId || "global",
    passengerId: goal.canonicalSubject?.passengerId || goal.passengerId || goal.travelerId,
    segmentId: goal.canonicalSubject?.segmentId || goal.segmentId,
    repeatedInstance: goal.canonicalSubject?.repeatedInstance
      || goal.decisionInstanceId
      || goal.canonicalOwnerId
      || goal.requirementId
      || goal.decisionGroupId
      || goal.logicalFieldId
      || goal.goalId
  });
  const ownerIdentity = semanticOwnerId(owner);
  const desiredState = goal.desiredState || successCondition.desiredState || null;
  const stableStateObligationId = goal.kind === "control_state"
    ? `control-state:${ownerIdentity}:${stableDigest(desiredState || {}).slice(0, 16)}`
    : "";
  const obligation = {
    contractVersion: CURRENT_OBLIGATION_VERSION,
    obligationId: clean(stableStateObligationId || goal.goalId || goal.requirementId || goal.decisionGroupId),
    sceneItemId: clean(sceneItem?.sceneItemId),
    authority: "task_state",
    observationId: clean(checkoutScene?.observationId || goal.observationId),
    observationHash: clean(checkoutScene?.sourceSnapshotHash),
    surfaceId: clean(goal.owner?.surfaceId || goal.surfaceId || checkoutScene?.observationFrame?.surface?.id || "surface-page"),
    kind: clean(goal.kind || goal.semanticType || "unknown"),
    semanticOwner: owner,
    semanticOwnerId: ownerIdentity,
    subject: obligationSubject(goal),
    objective: clean(goal.objective || goal.semanticGoal || "resolve the current checkout obligation"),
    desiredEffect: obligationDesiredEffect(goal),
    desiredValue: goal.desiredValue ?? goal.canonicalValue ?? "",
    currentState: goal.currentState ? Object.freeze({ ...goal.currentState }) : null,
    desiredState: desiredState ? Object.freeze({ ...desiredState }) : null,
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
    successCondition: Object.freeze({ ...successCondition })
  };
  obligation.binding = binding;
  return Object.freeze(obligation);
}

function currentObligation(taskState = {}) {
  const obligation = taskState?.currentObligation || null;
  return obligation?.contractVersion === CURRENT_OBLIGATION_VERSION ? obligation : null;
}

module.exports = {
  CURRENT_OBLIGATION_VERSION,
  CHECKOUT_SCENE_VERSION,
  OBSERVATION_FRAME_VERSION,
  compileCheckoutScene,
  createObservationFrame,
  currentObligation,
  currentObligationFromGoal,
  checkoutSceneOwnsObservation
};
