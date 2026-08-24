const agentContract = require("../../extension/src/shared/agent-contract");
const { factsFromObservation } = require("./transaction-facts");
const {
  descriptorOwnsActiveRequirement,
  fieldDescriptors
} = require("./profile-requirements");
const { buildCanonicalDecisions } = require("./canonical-decision");
const { activeValidationIssues } = require("./validation-evidence");
const {
  normalizeSemanticOwner,
  semanticOwnerId
} = require("../../../packages/shared/semantic-owner");

const OBSERVATION_FRAME_VERSION = "observation-frame/v2";
const DECISION_FRAME_VERSION = "decision-frame/v2";
const CURRENT_OBLIGATION_VERSION = "current-obligation/v2";
const CHECKOUT_SITUATION_VERSION = "checkout-situation/v1";

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

function lower(value = "") {
  return clean(value).toLowerCase();
}

function controlEvidenceIds(control = {}) {
  return Object.freeze(unique([
    control.controlId,
    control.stateElementId,
    control.preferredActivationElementId
  ]));
}

function activeRepresentation(control = {}) {
  const lifecycle = control.representationLifecycle || {};
  return lifecycle.status !== "dormant_hidden" && lifecycle.active !== false;
}

function controlConsequence(control = {}) {
  const explicitMeaning = lower([
    control.physicalEffect,
    control.semanticEffect,
    control.semantic,
    control.fieldType,
    control.field,
    control.risk
  ].filter(Boolean).join(" "));
  const evidence = lower([
    explicitMeaning,
    control.label,
    control.name,
    control.autocomplete
  ].filter(Boolean).join(" "));
  const choiceLike = /checkbox|switch/.test(lower(`${control.kind || ""} ${control.role || ""} ${control.inputType || ""}`));
  if (/accept_legal|legal_acceptance|terms_accept|accept_terms|unknown_attestation/.test(explicitMeaning)
    || (choiceLike && /agree|accept|terms|conditions|dangerous goods|declaration/.test(evidence))) {
    return "legal_attestation";
  }
  if (/enter_payment|card_number|card_expiry|security_code|\bcvc\b|\bcvv\b|cc-number|cc-exp|cc-csc/.test(explicitMeaning)
    || /autocomplete[:= ](?:cc-number|cc-exp|cc-csc)|name[:= ](?:cardnumber|card_number|cvv|cvc)/.test(evidence)) {
    return "payment_entry";
  }
  if (/submit_purchase|complete_purchase|confirm_and_pay|pay_now|place_order|book_now/.test(explicitMeaning)
    || (/button|submit/.test(lower(`${control.kind || ""} ${control.role || ""} ${control.inputType || ""}`))
      && /confirm and pay|pay now|complete purchase|place order|book now/.test(evidence))) {
    return "purchase_submission";
  }
  if (/select_paid|add_paid|money|paid_extra|upgrade/.test(evidence)) return "monetary_selection";
  if (/login|log_in|sign_in|authentication|otp|captcha/.test(evidence)) return "authentication";
  if (/advance_checkout|continue|navigation|proceed|next/.test(evidence)) return "checkout_progress";
  if (/set_field|textbox|combobox|select|input/.test(evidence)) return "fact_entry";
  if (/select_free|decline|skip|no_extra/.test(evidence)) return "policy_choice";
  return "unknown";
}

function controlAvailable(control = {}) {
  if (!activeRepresentation(control)) return false;
  if (control.disabled === true || control.state?.disabled === true) return false;
  return Object.values(control.operations || {}).some((operation) => (
    operation?.actionability?.executable === true
    || operation?.actionability?.targetable === true
    || (operation?.exactActuators || []).some((actuator) => actuator?.proof?.executable === true)
  ));
}

function requiredProfileObligation(descriptor = {}, page = {}) {
  if (descriptor.hasValue || !descriptorOwnsActiveRequirement(descriptor, page)) return null;
  return Object.freeze({
    obligationId: clean(descriptor.key || descriptor.logicalFieldId || descriptor.control?.controlId),
    kind: "profile_fact",
    semanticType: clean(descriptor.semanticType),
    logicalFieldId: clean(descriptor.logicalFieldId),
    surfaceId: clean(descriptor.control?.surfaceId || "surface-page"),
    evidenceIds: controlEvidenceIds(descriptor.control),
    evidenceStrength: "strong",
    status: "unresolved"
  });
}

function groupObligation(group = {}) {
  const status = lower(group.status);
  const unresolved = group.requiresResolution === true
    || (group.required === true && !["satisfied", "waived", "waived_by_policy", "optional"].includes(status));
  if (!unresolved) return null;
  const semanticType = clean(group.sectionType || group.semanticType || "decision");
  const unknownAttestation = /unknown_attestation/.test(lower(semanticType));
  return Object.freeze({
    obligationId: clean(group.decisionGroupId || group.requirementId),
    kind: unknownAttestation ? "unknown_attestation" : "checkout_decision",
    semanticType,
    decisionGroupId: clean(group.decisionGroupId),
    surfaceId: clean(group.surfaceId || "surface-page"),
    evidenceIds: Object.freeze(unique([
      group.selectedControlId,
      ...(group.alternativeControlIds || []),
      ...(group.alternatives || []).map((option) => option.controlId)
    ])),
    evidenceStrength: group.required === true ? "structural" : "strong",
    status: "unresolved"
  });
}

function controlRequiredEvidence(control = {}, validationIssues = []) {
  const state = control.state || {};
  const validation = (validationIssues || []).find((issue) => (
    issue.controlId && issue.controlId === control.controlId
  ));
  if (validation || state.invalid === true || control.invalid === true) return "strong";
  const shape = lower(`${control.role || ""} ${control.kind || ""} ${control.inputType || ""}`);
  if ((control.required === true || state.required === true)
    && /checkbox|radio|switch|option/.test(shape)) return "structural";
  return (control.required === true || state.required === true) ? "weak" : "none";
}

function unknownRequiredObligation(control = {}, validationIssues = [], ownedEvidenceIds = new Set()) {
  if (!control?.controlId || ownedEvidenceIds.has(control.controlId) || !activeRepresentation(control)) return null;
  const state = control.state || {};
  if (state.valuePresent === true || state.checked === true || state.selected === true || control.selected === true) return null;
  const strength = controlRequiredEvidence(control, validationIssues);
  // Weak HTML-required evidence on an ordinary text field is deliberately
  // retained as evidence but cannot become a blocker by itself.
  if (!["strong", "structural"].includes(strength)) return null;
  const attestation = /checkbox|radio|switch/.test(lower(`${control.role || ""} ${control.kind || ""}`));
  return Object.freeze({
    obligationId: `unknown-required:${clean(control.stableKey || control.controlId)}`,
    kind: attestation ? "unknown_attestation" : "unknown_required",
    semanticType: clean(control.semantic || control.fieldType || (attestation ? "unknown_attestation" : "unknown")),
    controlId: clean(control.controlId),
    surfaceId: clean(control.surfaceId || "surface-page"),
    evidenceIds: controlEvidenceIds(control),
    evidenceStrength: strength,
    status: "unresolved"
  });
}

function validationObligation(issue = {}, page = {}, index = 0) {
  const owner = (page.controls || []).find((control) => control.controlId === issue.controlId) || null;
  return Object.freeze({
    obligationId: `unknown-validation:${clean(issue.issueId || issue.controlId || issue.sectionId || index + 1)}`,
    kind: "unknown_validation",
    semanticType: clean(issue.semanticType || owner?.semantic || owner?.fieldType || "unknown"),
    controlId: clean(issue.controlId),
    surfaceId: clean(issue.surfaceId || owner?.surfaceId || "surface-page"),
    evidenceIds: Object.freeze(unique([issue.issueId, issue.controlId, issue.sectionId, ...controlEvidenceIds(owner || {})])),
    evidenceStrength: "strong",
    evidence: clean(issue.message || issue.text || issue.label || issue),
    status: "unresolved"
  });
}

function consequentialObligation(control = {}) {
  const consequence = controlConsequence(control);
  if (!["legal_attestation", "payment_entry", "purchase_submission", "authentication"].includes(consequence)) {
    return null;
  }
  const state = control.state || {};
  if (consequence === "legal_attestation" && (control.selected === true || state.checked === true || state.selected === true)) {
    return null;
  }
  if (consequence === "payment_entry" && (state.valuePresent === true || clean(state.normalizedValue || state.valueText || state.value))) {
    return null;
  }
  return Object.freeze({
    obligationId: `consequence:${clean(control.controlId)}`,
    kind: consequence === "legal_attestation"
      ? "legal_authorization"
      : consequence === "payment_entry"
        ? "payment_authorization"
        : consequence === "purchase_submission"
          ? "purchase_authorization"
          : "authentication",
    semanticType: consequence,
    surfaceId: clean(control.surfaceId || "surface-page"),
    evidenceIds: controlEvidenceIds(control),
    status: "authorization_required"
  });
}

function compileCheckoutSituation({
  sourceFrame = {},
  page = {},
  profileRequirements = [],
  commerceEntities = [],
  standaloneDecisions = [],
  semanticCompilation = {}
} = {}) {
  const controls = (page.controls || []).filter(activeRepresentation);
  const actions = controls.filter(controlAvailable).map((control) => Object.freeze({
    controlId: clean(control.controlId),
    surfaceId: clean(control.surfaceId || "surface-page"),
    consequence: controlConsequence(control),
    physicalEffect: clean(control.physicalEffect || control.semanticEffect || control.semantic || "unknown"),
    risk: clean(control.risk || "unknown"),
    evidenceIds: controlEvidenceIds(control)
  }));
  const profileObligations = profileRequirements
    .map((descriptor) => requiredProfileObligation(descriptor, page))
    .filter(Boolean);
  const decisionObligations = commerceEntities.map(groupObligation).filter(Boolean);
  const boundaryObligations = controls.map(consequentialObligation).filter(Boolean);
  const activeValidation = activeValidationIssues(page.validationIssues || []);
  const validationObligations = activeValidation.map((issue, index) => validationObligation(issue, page, index));
  // Unknown-obligation discovery is allowed only after every deterministic
  // producer has had a chance to claim its controls. Include resolved and
  // optional entities here as well: an unchecked alternative in a satisfied
  // radio group, or an already-accepted legal checkbox, must not be reborn as
  // a parallel "unknown required" obligation merely because it no longer
  // needs an active obligation of its own.
  const recognizedEvidenceIds = [
    ...profileRequirements.flatMap((descriptor) => controlEvidenceIds(descriptor.control || {})),
    ...commerceEntities.flatMap((group) => unique([
      group.selectedControlId,
      ...(group.alternativeControlIds || []),
      ...(group.alternatives || []).map((option) => option.controlId)
    ])),
    ...standaloneDecisions.flatMap((decision) => unique([
      decision.controlId,
      decision.selectedControlId,
      ...(decision.physicalControlIds || []),
      ...(decision.alternativeControlIds || [])
    ])),
    ...controls
      .filter((control) => controlConsequence(control) !== "unknown")
      .flatMap(controlEvidenceIds)
  ];
  const ownedEvidenceIds = new Set([
    ...profileObligations,
    ...decisionObligations,
    ...boundaryObligations,
    ...validationObligations
  ].flatMap((obligation) => obligation.evidenceIds || []).concat(recognizedEvidenceIds).filter(Boolean));
  const unknownRequiredObligations = controls
    .map((control) => unknownRequiredObligation(control, activeValidation, ownedEvidenceIds))
    .filter(Boolean);
  const validationBlockers = activeValidation.map((issue, index) => Object.freeze({
    blockerId: clean(issue.controlId || issue.sectionId || `validation-${index + 1}`),
    kind: "unknown_validation",
    controlId: clean(issue.controlId),
    surfaceId: clean(issue.surfaceId || "surface-page"),
    evidence: clean(issue.message || issue.text || issue.label || issue)
  }));
  const consequentialActions = actions.filter((action) => [
    "legal_attestation",
    "payment_entry",
    "purchase_submission",
    "monetary_selection",
    "authentication"
  ].includes(action.consequence));
  const contradictions = [
    ...(semanticCompilation.unownedMaterialControls || []).map((control) => Object.freeze({
      code: "UNOWNED_MATERIAL_CONTROL",
      evidenceIds: controlEvidenceIds(control)
    })),
    ...(semanticCompilation.unresolvedDecisions || []).map((decision) => Object.freeze({
      code: "UNRESOLVED_DECISION",
      evidenceIds: Object.freeze(unique([
        decision.decisionGroupId,
        decision.requirementId,
        ...(decision.alternativeControlIds || [])
      ]))
    }))
  ];
  // The canonical controls are the only action authority. `stageExit` is a
  // browser-side diagnostic projection of these same controls and must never
  // re-admit a target that the graph itself did not publish as available.
  const navigationControlIds = Object.freeze(unique(
    actions
      .filter((action) => action.consequence === "checkout_progress")
      .map((action) => action.controlId)
  ));
  const checkoutActive = Boolean(
    controls.length
    || commerceEntities.length
    || profileRequirements.length
    || navigationControlIds.length
    || page.transactionFacts
    || page.terminalEvidence
  );
  const obligations = Object.freeze([
    ...profileObligations,
    ...decisionObligations,
    ...boundaryObligations,
    ...validationObligations,
    ...unknownRequiredObligations
  ]);
  return Object.freeze({
    contractVersion: CHECKOUT_SITUATION_VERSION,
    observationId: clean(sourceFrame.observationId),
    observationHash: clean(sourceFrame.observationHash),
    surface: surfaceEvidence(page),
    // Diagnostic context only: this hint never admits, completes, or
    // identifies an obligation.
    stageHint: Object.freeze({
      value: clean(page.step || page.pageStep || "unknown"),
      evidence: freezeArray(page.stepEvidence || page.stageEvidence || [])
    }),
    checkoutActive,
    obligations,
    availableActions: Object.freeze(actions),
    consequentialActions: Object.freeze(consequentialActions),
    blockers: Object.freeze(validationBlockers),
    navigationControlIds,
    transactionEvidence: page.transactionFacts || null,
    completionEvidence: page.terminalEvidence || null,
    contradictions: Object.freeze(contradictions),
    reconciliationRequired: Boolean(
      contradictions.length
      || (checkoutActive && !obligations.length && !actions.length && !page.terminalEvidence)
    )
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
  const checkoutSituation = compileCheckoutSituation({
    sourceFrame,
    page,
    profileRequirements,
    commerceEntities: compilation.decisionGroups || [],
    standaloneDecisions,
    semanticCompilation: compilation
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
    commerceEntities: freezeArray(compilation.decisionGroups || []),
    navigationDiagnostics: page.stageExit || null,
    transactionFacts,
    terminalEvidence: page.terminalEvidence || null,
    validationBlockers: arrayReference(page.validationIssues),
    checkoutSituation,
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
    // Diagnostic context only. Stable ownership below deliberately excludes
    // a guessed checkout stage.
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

function currentObligationFromGoal({ goal = null, decisionFrame = null } = {}) {
  if (!goal) return null;
  const controls = admittedControlIds(goal);
  const successCondition = goal.successCondition || goal.postcondition || goal.outcomeContract || {};
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
      reconciliation: goal.reconciliation ? Object.freeze({ ...goal.reconciliation }) : null,
      desiredStateDelta: goal.desiredStateDelta
        ? Object.freeze({ ...goal.desiredStateDelta })
        : null
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
    stage: "checkout",
    family: goal.canonicalSubject?.family || goal.subject?.family || goal.family || goal.sectionType || goal.semanticType,
    subjectId: goal.subjectId || "global",
    passengerId: goal.canonicalSubject?.passengerId || goal.passengerId || goal.travelerId,
    segmentId: goal.canonicalSubject?.segmentId || goal.segmentId,
    repeatedInstance: goal.canonicalSubject?.repeatedInstance
      || goal.logicalFieldId
      || goal.canonicalOwnerId
      || goal.requirementId
      || goal.decisionGroupId
      || goal.decisionInstanceId
      || goal.semanticType
      || goal.kind
      || "global"
  });
  const ownerId = semanticOwnerId(owner);
  const obligation = {
    contractVersion: CURRENT_OBLIGATION_VERSION,
    // Production goal producers use semantic IDs that survive observation
    // replacement. Preserve an explicitly supplied ID so leased-action and
    // result receipts remain compatible across the CurrentObligation bridge.
    obligationId: clean(goal.goalId || goal.requirementId || goal.decisionGroupId || `obligation:${ownerId}`),
    authority: "task_state",
    observationId: clean(decisionFrame?.observationId || goal.observationId),
    observationHash: clean(decisionFrame?.observationHash),
    surfaceId: clean(goal.owner?.surfaceId || goal.surfaceId || decisionFrame?.observationFrame?.surface?.id || "surface-page"),
    kind: clean(goal.kind || goal.semanticType || "unknown"),
    semanticOwner: owner,
    semanticOwnerId: ownerId,
    subject: obligationSubject(goal),
    objective: clean(goal.objective || goal.semanticGoal || "resolve the current checkout obligation"),
    desiredEffect: obligationDesiredEffect(goal),
    desiredValue: goal.desiredValue ?? goal.canonicalValue ?? "",
    desiredStateDelta: goal.desiredStateDelta
      ? Object.freeze({ ...goal.desiredStateDelta })
      : null,
    admittedControlIds: freezeArray(controls),
    evidenceStrength: clean(goal.evidenceStrength),
    rawEvidenceIds: freezeArray(goal.rawEvidenceIds),
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
  CHECKOUT_SITUATION_VERSION,
  CURRENT_OBLIGATION_VERSION,
  DECISION_FRAME_VERSION,
  OBSERVATION_FRAME_VERSION,
  compileDecisionFrame,
  createObservationFrame,
  currentObligation,
  currentObligationFromGoal,
  decisionFrameOwnsObservation
};
