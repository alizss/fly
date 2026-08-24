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
  return /legal_acceptance|unknown_attestation|accept_legal|accept_terms|terms_accept/.test(typed);
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
  const typedCommerce = clean(transition.effectRole || evidence.effectRole) === "commerce_option"
    || evidence.source === "selected_control"
    || boundedSelectedSummary
    || transition.price != null
    || decision.priceRisk?.transactionOwned === true
    || explicitPaidSemantic;
  return Object.freeze({
    proven: typedCommerce && (
      Number.isFinite(amount) && amount > 0
      || explicitPaidSemantic
      || decision.priceRisk?.selectedPaid === true && decision.priceRisk?.transactionOwned === true
    ),
    amount: Number.isFinite(amount) ? amount : null,
    currency: clean(transition.price?.currency || evidence.structuredPrice?.currency),
    evidenceSource: clean(evidence.source),
    effectRole: clean(transition.effectRole || evidence.effectRole)
  });
}

function exactProfileMismatch(decision = {}) {
  const intent = decision.userIntent || {};
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
  const requiredMissing = decision.required === true && !selectedId;
  const profileMismatch = exactProfileMismatch(decision);
  const validation = ownedValidationProof(decision);
  const incrementalCost = exactIncrementalCostProof(decision);
  const paidConflict = ["conflicted", "blocked"].includes(clean(decision.status))
    && incrementalCost.proven;
  const requiredSemanticResolution = decision.required === true
    && ["ambiguous", "unavailable"].includes(clean(decision.userIntent?.match));
  const typedProfileRequirement = clean(decision.family || decision.subject?.family) === "profile"
    && decision.needsAction === true;
  const typedLegalRequirement = !selectedId
    && typedLegalEvidence(decision)
    && (decision.required === true || decision.needsAction === true);
  const blockedExternal = clean(decision.status) === "blocked"
    && /AUTHORIZATION|LOGIN|AUTHENTICATION|OTP|CAPTCHA|3DS|BANK_APPROVAL/.test(
      clean(decision.reopenEvidence?.code)
    );

  let reason = "";
  let desiredState = "";
  let evidenceKind = "";
  if (validation) {
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

  return Object.freeze({
    contractVersion: DESIRED_STATE_DELTA_VERSION,
    status: blockedExternal
      ? "BLOCKED_EXTERNAL"
      : requiredSemanticResolution
        ? "MISSING_FACT"
        : "EXACT_DELTA",
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
    actionRequired: true,
    admittedControlIds: Object.freeze([
      ...(decision.userIntent?.desiredControlIds || []),
      ...(decision.physicalControlIds || [])
    ].map(clean).filter((value, index, values) => value && values.indexOf(value) === index)),
    proof: Object.freeze({
      requiredMissing,
      profileMismatch,
      ownedValidation: validation,
      typedLegalRequirement,
      typedProfileRequirement,
      incrementalCost
    })
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

function compileDesiredStateDeltas({ decisions = [] } = {}) {
  return Object.freeze(compileDesiredStateEvaluations({ decisions })
    .filter((evaluation) => evaluation.actionRequired === true));
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
