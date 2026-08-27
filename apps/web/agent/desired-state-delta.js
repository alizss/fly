"use strict";

const DESIRED_STATE_DELTA_VERSION = "desired-state-delta/v1";

function clean(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function lower(value = "") {
  return clean(value).toLowerCase();
}

function selectedTransition(decision = {}) {
  const selectedId = clean(decision.selectedControlId || decision.currentState?.selectedControlId);
  return (decision.availableTransitions || []).find((transition) => (
    clean(transition.controlId) === selectedId
  )) || null;
}

function typedLegalEvidence(decision = {}) {
  const observed = decision.observed || {};
  const typed = lower([
    observed.sectionType,
    observed.semanticType,
    decision.semanticType,
    ...(decision.availableTransitions || []).map((transition) => (
      `${transition.semantic || ""} ${transition.effectRole || ""}`
    ))
  ].filter(Boolean).join(" "));
  return /legal_acceptance|accept_legal|accept_terms|terms_accept/.test(typed);
}

function unknownAttestationEvidence(decision = {}) {
  const observed = decision.observed || {};
  return /unknown_attestation/.test(lower([
    observed.sectionType,
    observed.semanticType,
    decision.semanticType,
    decision.subject?.key,
    ...(decision.availableTransitions || []).map((transition) => transition.semantic)
  ].filter(Boolean).join(" ")));
}

function exactIncrementalCostProof(decision = {}) {
  const observed = decision.observed || {};
  const evidence = observed.selectedEvidence || {};
  const transition = selectedTransition(decision) || {};
  const exactReversal = (decision.availableTransitions || []).some((candidate) => (
    candidate.executable === true
    && /remove|deselect|unselect|undo|delete|clear selection|remove_paid/.test(lower(
      `${candidate.semantic || ""} ${candidate.risk || ""} ${candidate.label || ""}`
    ))
  ));
  const boundedSelectedSummary = evidence.selected === true
    && clean(evidence.source) !== "owned_decision_section"
    && (
      exactReversal
      || ["resolved", "hypothesis"].includes(clean(observed.semanticOwnership?.status))
    );
  const rawAmount = transition.price?.amount
    ?? (evidence.source === "selected_control" || boundedSelectedSummary
      ? evidence.structuredPrice?.amount
      : null);
  const amount = rawAmount == null || rawAmount === "" ? null : Number(rawAmount);
  const explicitPaidSemantic = /select_paid|add_paid|purchase|upgrade|money/.test(lower(
    `${transition.semantic || ""} ${transition.risk || ""} ${evidence.semantic || ""} ${evidence.risk || ""}`
  ));
  const effectRole = clean(evidence.effectRole || transition.effectRole);
  const scopeControl = ["scope_toggle", "surface_opener", "presentation_mode"].includes(effectRole);
  const typedCommerce = !scopeControl && (effectRole === "commerce_option"
    || evidence.source === "selected_control"
    || boundedSelectedSummary
    || transition.price != null
    || decision.priceRisk?.transactionOwned === true
    || explicitPaidSemantic);
  return Object.freeze({
    proven: typedCommerce && (
      Number.isFinite(amount) && amount > 0
      || explicitPaidSemantic
      || decision.priceRisk?.selectedPaid === true && decision.priceRisk?.transactionOwned === true
    ),
    amount: Number.isFinite(amount) ? amount : null,
    currency: clean(transition.price?.currency || evidence.structuredPrice?.currency),
    evidenceSource: clean(evidence.source),
    effectRole
  });
}

function exactProfileMismatch(decision = {}) {
  const intent = decision.userIntent || {};
  // The transaction-bound mandate authorizes required standard terms; it is
  // not a command to opt into every legal-looking checkbox on the page.
  // Optional legal state remains page state unless a separate explicit user
  // preference owns it.
  if (typedLegalEvidence(decision) && decision.required !== true) return false;
  // A constraint describes a set of acceptable states, not a command to
  // activate one representative control. In particular, "no paid extras" is
  // already satisfied when no paid option is selected. Only exact profile
  // intent can establish a mismatch against an unselected safe alternative;
  // selected paid conflicts are admitted separately by exact cost evidence.
  const exactIntent = clean(intent.match) === "exact";
  const blockingConstraint = clean(intent.match) === "constraint"
    && decision.needsAction === true;
  if (!exactIntent && !blockingConstraint) return false;
  const selectedId = clean(decision.selectedControlId || decision.currentState?.selectedControlId);
  const desiredIds = (intent.desiredControlIds || []).map(clean).filter(Boolean);
  if (intent.desiredSelected === false) {
    return Boolean(selectedId && desiredIds.includes(selectedId));
  }
  if (!desiredIds.length) return false;
  return !selectedId || !desiredIds.includes(selectedId);
}

function ownedValidationProof(decision = {}) {
  const code = clean(decision.reopenEvidence?.code);
  return /VALIDATION/.test(code) || decision.actionReason === "fresh_validation";
}

function deltaForDecision(decision = {}) {
  const decisionGroupId = clean(decision.decisionGroupId || decision.decisionId);
  if (!decisionGroupId) return null;
  const selectedId = clean(decision.selectedControlId || decision.currentState?.selectedControlId);
  const safeUnselectedPolicyOutcomes = new Set([
    "random_assignment",
    "declined_or_free",
    "no_insurance",
    "included_base_fare"
  ]);
  const transitions = decision.availableTransitions || [];
  const paidOnlyUnselectedConstraint = !selectedId
    && clean(decision.userIntent?.match) === "constraint"
    && safeUnselectedPolicyOutcomes.has(clean(decision.userIntent?.desiredOutcome))
    && transitions.length > 0
    && transitions.every((transition) => (
      transition.paid === true
      || Number.isFinite(Number(transition.price?.amount)) && Number(transition.price.amount) > 0
    ));
  const requiredMissing = decision.required === true && !selectedId && !paidOnlyUnselectedConstraint;
  const profileMismatch = exactProfileMismatch(decision);
  const validation = ownedValidationProof(decision);
  const incrementalCost = exactIncrementalCostProof(decision);
  const paidConflict = ["conflicted", "blocked"].includes(clean(decision.status))
    && incrementalCost.proven;
  const requiredSemanticResolution = decision.required === true
    && ["ambiguous", "unavailable"].includes(clean(decision.userIntent?.match));
  const exactDiscoveryControlIds = (decision.userIntent?.desiredControlIds || []).map(clean).filter((controlId) => (
    (decision.availableTransitions || []).some((transition) => (
      clean(transition.controlId) === controlId
      && transition.executable === true
      && clean(transition.operation) === "open"
    ))
  ));
  const ownedChoiceDiscovery = decision.actionReason === "open_owned_choice_to_observe_options"
    && exactDiscoveryControlIds.length === 1;
  const unavailablePolicyConstraint = clean(decision.userIntent?.match) === "constraint"
    && decision.needsAction === true
    && !paidOnlyUnselectedConstraint
    && !(decision.userIntent?.desiredControlIds || []).length
    && !(decision.userIntent?.eligibleOptionIds || []).length;
  const typedProfileRequirement = clean(decision.family || decision.subject?.family) === "profile"
    && decision.needsAction === true;
  const typedLegalRequirement = !selectedId
    && typedLegalEvidence(decision)
    && decision.required === true;
  const unknownAttestation = !selectedId
    && unknownAttestationEvidence(decision)
    && decision.required === true;
  const hasOwnedActuator = [
    ...(decision.userIntent?.desiredControlIds || []),
    ...(decision.physicalControlIds || [])
  ].some((controlId) => clean(controlId));
  const blockedExternal = clean(decision.status) === "blocked"
    && /AUTHORIZATION|LOGIN|AUTHENTICATION|OTP|CAPTCHA|3DS|BANK_APPROVAL/.test(
      clean(decision.reopenEvidence?.code)
    );

  let reason = "";
  let desiredState = "";
  let evidenceKind = "";
  if (unknownAttestation) {
    // Requiredness proves that the site demands a choice; it does not prove
    // what an unfamiliar declaration means or that the user's checkout
    // mandate authorizes it. Keep it as missing semantic authority instead
    // of converting the visible checkbox into an executable legal action.
    reason = "required_semantic_resolution";
    desiredState = "required_state_satisfied";
    evidenceKind = "structural_required";
  } else if (validation) {
    reason = "owned_validation";
    desiredState = "validation_cleared";
    evidenceKind = "owned_validation";
  } else if (paidConflict) {
    reason = "proven_incremental_cost_conflict";
    desiredState = "policy_compatible_non_paid_state";
    evidenceKind = "exact_incremental_cost";
  } else if (profileMismatch) {
    reason = "explicit_profile_mismatch";
    desiredState = decision.userIntent?.desiredSelected === false
      ? "unselected"
      : "profile_selected_state";
    evidenceKind = "profile_policy";
  } else if (ownedChoiceDiscovery) {
    // The semantic choice is not missing: TaskState knows exactly which owned
    // control can reveal its alternatives. Publish that single reversible
    // state change instead of turning a grounded mechanical discovery into a
    // user-facing MISSING_FACT blocker.
    reason = "owned_choice_options_not_observed";
    desiredState = "options_surface_visible";
    evidenceKind = "owned_choice_discovery";
  } else if (unavailablePolicyConstraint || (requiredSemanticResolution && !hasOwnedActuator)) {
    reason = "required_semantic_resolution";
    desiredState = "required_state_satisfied";
    evidenceKind = "structural_required";
  } else if (typedLegalRequirement || requiredMissing) {
    reason = typedLegalRequirement ? "typed_required_legal_attestation" : "required_state_missing";
    desiredState = "required_state_satisfied";
    evidenceKind = typedLegalRequirement ? "typed_legal_requirement" : "structural_required";
  } else if (requiredSemanticResolution) {
    reason = "required_semantic_resolution";
    desiredState = "required_state_satisfied";
    evidenceKind = "structural_required";
  } else if (typedProfileRequirement) {
    reason = "typed_profile_requirement";
    desiredState = "profile_selected_state";
    evidenceKind = "profile_requirement";
  } else {
    // Visibility, unfamiliar wording, a selected optional default, or an
    // inferred family is not work. A satisfied group can reopen only when a
    // fresh positive proof above establishes an actual desired-state delta.
    return null;
  }

  const status = blockedExternal
    ? "BLOCKED_EXTERNAL"
    : reason === "required_semantic_resolution"
      ? "MISSING_FACT"
      : "EXACT_DELTA";
  const actionRequired = status === "EXACT_DELTA";
  const exactDesiredControlIds = [
    ...(ownedChoiceDiscovery ? exactDiscoveryControlIds : (decision.userIntent?.desiredControlIds || [])),
    ...(!(decision.userIntent?.desiredControlIds || []).length
      ? (decision.userIntent?.eligibleOptionIds || [])
      : [])
  ].map(clean).filter((value, index, values) => value && values.indexOf(value) === index);
  const policyCompatibleControlIds = (decision.availableTransitions || []).filter((transition) => (
    transition.paid !== true
    && !(Number.isFinite(Number(transition.price?.amount)) && Number(transition.price.amount) > 0)
    && /select_free|decline|remove|delete|undo|skip|without|none|random/.test(lower(
      `${transition.semantic || ""} ${transition.physicalEffect || ""} ${transition.risk || ""} ${transition.label || ""}`
    ))
  )).map((transition) => clean(transition.controlId)).filter(Boolean);
  const exactCorrectionControlIds = exactDesiredControlIds.length
    ? exactDesiredControlIds
    : paidConflict
      ? policyCompatibleControlIds
      : [];
  const candidateControlIds = exactCorrectionControlIds.length
    ? exactCorrectionControlIds
    : [
        ...exactDesiredControlIds,
        ...(decision.physicalControlIds || [])
      ];
  const admittedControlIds = actionRequired
    ? candidateControlIds.map(clean).filter((value, index, values) => value && values.indexOf(value) === index)
    : [];

  return Object.freeze({
    contractVersion: DESIRED_STATE_DELTA_VERSION,
    status,
    deltaId: `delta:${decisionGroupId}`,
    decisionGroupId,
    surfaceId: clean(decision.surfaceId || "surface-page"),
    family: clean(decision.family || decision.subject?.family || "decision"),
    reason,
    evidenceKind,
    observedState: Object.freeze({
      selectedControlId: selectedId,
      selected: Boolean(selectedId),
      status: clean(decision.status),
      required: decision.required === true
    }),
    desiredState,
    desiredEffect: ownedChoiceDiscovery ? "open" : "",
    actionRequired,
    admittedControlIds: Object.freeze(admittedControlIds),
    authorization: decision.userIntent?.authorization
      ? Object.freeze({ ...decision.userIntent.authorization })
      : decision.authorization
        ? Object.freeze({ ...decision.authorization })
        : null,
    proof: Object.freeze({
      requiredMissing,
      profileMismatch,
      ownedValidation: validation,
      typedLegalRequirement,
      unknownAttestation,
      typedProfileRequirement,
      incrementalCost
    })
  });
}

function deltaForWork({ work = null, admittedControlIds = [] } = {}) {
  if (!work) return null;
  if (work.desiredStateDelta) {
    const supplied = work.desiredStateDelta;
    const status = clean(supplied.status || "EXACT_DELTA");
    const actionRequired = status === "EXACT_DELTA" && supplied.actionRequired !== false;
    return Object.freeze({
      ...supplied,
      contractVersion: DESIRED_STATE_DELTA_VERSION,
      status,
      actionRequired,
      admittedControlIds: Object.freeze(actionRequired
        ? (supplied.admittedControlIds || admittedControlIds).map(clean).filter(Boolean)
        : []),
      authorization: supplied.authorization
        ? Object.freeze({ ...supplied.authorization })
        : work.authorization
          ? Object.freeze({ ...work.authorization })
          : null
    });
  }

  const kind = clean(work.kind || work.semanticType || "unknown");
  const ambiguityCode = clean(work.ambiguity?.code);
  const semanticFactMissing = /ACTIVE_REQUIREMENT_UNRESOLVED|SEMANTIC_AMBIGUITY|NO_POLICY_ALLOWED_CANDIDATE|UNKNOWN_REQUIRED/.test(ambiguityCode);
  const status = semanticFactMissing ? "MISSING_FACT" : "EXACT_DELTA";
  const actionRequired = status === "EXACT_DELTA";
  // A CurrentObligation changes one component. Its delta must carry that
  // component's requested value (for example +386), not the aggregate
  // logical-field normalization (+38670328922) used by final verification.
  const desiredValue = work.desiredValue
    ?? work.expectedComponentValue
    ?? work.expectedCanonicalValue
    ?? work.canonicalValue
    ?? work.expectedNormalizedValue
    ?? "";
  const desiredState = kind === "profile_field"
    ? "profile_value_satisfied"
    : work.semanticType === "navigation"
      ? "next_checkout_surface_observed"
      : work.semanticType === "completed_choice_surface"
        ? "current_surface_dismissed"
        : "required_state_satisfied";

  return Object.freeze({
    contractVersion: DESIRED_STATE_DELTA_VERSION,
    status,
    deltaId: `delta:${clean(work.goalId || work.requirementId || work.decisionGroupId || kind)}`,
    decisionGroupId: clean(work.decisionGroupId),
    surfaceId: clean(work.surfaceId || "surface-page"),
    family: clean(work.canonicalSubject?.family || work.subject?.family || work.family || work.sectionType || kind),
    reason: clean(work.ambiguity?.code || `${kind}_desired_state`),
    evidenceKind: kind === "profile_field" ? "profile_policy" : "canonical_obligation",
    observedState: Object.freeze({
      value: work.currentValue ?? "",
      selectedControlId: clean(work.selectedControlId),
      status: clean(work.decisionStatus || "unresolved")
    }),
    desiredState,
    desiredValue,
    actionRequired,
    admittedControlIds: Object.freeze(actionRequired
      ? admittedControlIds.map(clean).filter(Boolean)
      : []),
    authorization: work.authorization ? Object.freeze({ ...work.authorization }) : null,
    proof: Object.freeze({ source: "decision_frame" })
  });
}

function desiredStateEvaluationForDecision(decision = {}) {
  const delta = deltaForDecision(decision);
  if (delta) return delta;
  const decisionGroupId = clean(decision.decisionGroupId || decision.decisionId);
  if (!decisionGroupId) return null;
  const selectedId = clean(decision.selectedControlId || decision.currentState?.selectedControlId);
  return Object.freeze({
    contractVersion: DESIRED_STATE_DELTA_VERSION,
    status: "SATISFIED",
    deltaId: `delta:${decisionGroupId}`,
    decisionGroupId,
    surfaceId: clean(decision.surfaceId || "surface-page"),
    family: clean(decision.family || decision.subject?.family || "decision"),
    reason: "observed_state_compatible_with_desired_state",
    evidenceKind: "exact_observed_state",
    observedState: Object.freeze({
      selectedControlId: selectedId,
      selected: Boolean(selectedId),
      status: clean(decision.status),
      required: decision.required === true
    }),
    desiredState: "compatible_current_state",
    actionRequired: false,
    admittedControlIds: Object.freeze([]),
    proof: Object.freeze({})
  });
}

function compileDesiredStateEvaluations({ decisions = [] } = {}) {
  return Object.freeze((decisions || [])
    .map(desiredStateEvaluationForDecision)
    .filter(Boolean));
}

function compileDesiredStateDeltas({ decisions = [], work = null, admittedControlIds = [] } = {}) {
  const decisionDeltas = compileDesiredStateEvaluations({ decisions })
    .filter((evaluation) => evaluation.status === "EXACT_DELTA" && evaluation.actionRequired === true);
  const workDelta = work ? deltaForWork({ work, admittedControlIds }) : null;
  return Object.freeze([
    ...decisionDeltas,
    ...(workDelta?.status === "EXACT_DELTA" && workDelta.actionRequired === true ? [workDelta] : [])
  ]);
}

module.exports = {
  DESIRED_STATE_DELTA_VERSION,
  compileDesiredStateDeltas,
  compileDesiredStateEvaluations,
  deltaForDecision,
  desiredStateEvaluationForDecision,
  exactIncrementalCostProof,
  exactProfileMismatch,
  typedLegalEvidence
};
