const {
  selectNextProfileRequirement
} = require("../profile-mechanics");
const {
  profileStageReadiness
} = require("../profile-requirements");
const { currentSurface, controlBelongsToCurrentSurface } = require("../surface-contract");
const { outcomeContractForGoal } = require("../action-semantics");
const { decisionInstanceKey, semanticGoalKey } = require("../../../../packages/shared/agent-actions");
const {
  CONTROL_TYPES,
  isTypedNavigationControl,
  resolveCanonicalDecision
} = require("../canonical-decision");
const { normalizeProfilePolicy, seatPolicyFrom } = require("../policy-profile");
const { canonicalDecisionOwnerKey } = require("../transaction-facts");
const { canonicalOptionMatch, missingDerivedFactDependency } = require("../logical-field");
const { activeValidationIssues } = require("../validation-evidence");
const {
  compileDesiredStateDeltas,
  compileDesiredStateEvaluations
} = require("../desired-state-delta");
const {
  currentObligation,
  compileCurrentObligation,
  decisionFrameOwnsObservation
} = require("../authority-frames");
const agentContract = require("../../../extension/src/shared/agent-contract");
const {
  normalizeSemanticOwner,
  semanticOwnerFromLegacy,
  semanticOwnerId
} = require("../../../../packages/shared/semantic-owner");
const { decideStage, stageEvidence } = require("./stage");
const { controlHasExecutableCapability } = require("./control-evidence");
const { cardCredentialEntryBoundaryEvidence } = require("./terminal");
const {
  reconcileVerifiedProfileComponents,
  verifiedProfileComponentFromActionResult,
  verifiedProfileComponentMatchesDecision
} = require("./profile-verification");
const { createCommerceLedger } = require("./commerce-ledger");
const { actionPostconditions } = require("./action-result");
const {
  actionDecisionLineage,
  choiceDecisionEpisode,
  decisionEpisodeSurfaceKey,
  episodeFamilyForDecision,
  episodeOwnsGoal,
  episodeSubjectKeyForDecision,
  terminalEpisodeOutcome,
  verifiedActionSucceeded,
  verifiedEpisodeAction
} = require("./decision-episode");
const { surfaceClassFrom } = require("./surface-state");

const {
  admittedVerifiedCommerceOutcomes,
  commerceOutcomeFromVerifiedObligation,
  verifiedCommerceObligationFromActionResult,
  verifiedCommerceObligations,
  verifiedOutcomeCoverage,
  verifiedOutcomeJournal
} = createCommerceLedger({
  actionDecisionLineage,
  episodeFamilyForDecision,
  semanticIdentity,
  taskMechanics,
  verifiedActionSucceeded,
  verifiedEpisodeAction
});

const COMPLETED = new Set(["satisfied", "waived", "waived_by_policy"]);
const GOAL_CREATING = new Set(["active", "conflicted", "blocked"]);
const DECISION_EPISODE_FAMILIES = new Set(["fare", "baggage", "seat", "insurance", "extras"]);
const taskStateReadModels = new WeakMap();

function taskMechanics(taskState = {}) {
  return currentObligation(taskState);
}

function workField(work = null, field = "") {
  if (!work) return undefined;
  if (field === "family") {
    return work.canonicalSubject?.family || work.subject?.family || work.family || work.sectionType || "";
  }
  if (["candidateControlIds", "actionableControlIds", "policyAllowedControlIds"].includes(field)) {
    return work[field] || admittedControlIdsForGoal(work);
  }
  return work[field];
}

function clean(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function lower(value = "") {
  return clean(value).toLowerCase();
}

function semanticIdentity(source = {}, fallback = {}) {
  if (!source || typeof source !== "object") return "";
  // The lease-published canonical owner is already an identity. Never
  // regenerate it from a legacy repeated-instance alias carried beside it.
  if (source.semanticOwnerId) return clean(source.semanticOwnerId);
  if (source.semanticOwner) {
    return clean(semanticOwnerId(semanticOwnerFromLegacy(source, fallback)));
  }
  if (!source.semanticOwner) {
    // One-way migration for receipts written before structured ownership.
    // Preserve their established durable key so a direct receipt and its
    // aggregated episode still reconcile as the same outcome.
    return clean(
      source.decisionInstanceId
      || source.canonicalOwnerId
      || source.decisionOwnerKey
      || source.requirementId
      || source.decisionGroupId
    );
  }
  return "";
}

function verificationDecisionRecord(decision = {}) {
  const observed = decision.observed || decision.observation || {};
  const owner = semanticOwnerFromLegacy(decision, {
    stage: decision.stage,
    family: decision.family,
    subjectId: decision.subjectId,
    repeatedInstance: decision.canonicalOwnerId || decision.decisionInstanceId || decision.decisionGroupId
  });
  return Object.freeze({
    semanticOwner: owner,
    semanticOwnerId: semanticIdentity({ ...decision, semanticOwner: owner }),
    decisionGroupId: clean(decision.decisionGroupId),
    instanceId: clean(decision.instanceId || decision.decisionInstanceId),
    requirementId: clean(decision.requirementId),
    canonicalOwnerId: clean(decision.canonicalOwnerId),
    family: clean(decision.family),
    kind: clean(decision.kind),
    semanticType: clean(decision.semanticType),
    status: clean(decision.status),
    surfaceId: clean(decision.surfaceId),
    subjectId: clean(decision.subjectId),
    selectedControlId: clean(decision.selectedControlId),
    selectedValue: clean(decision.selectedValue),
    completionReason: clean(decision.completionReason),
    physicalControlIds: Object.freeze([...(decision.physicalControlIds || [])].map(clean).filter(Boolean).slice(0, 24)),
    observed: Object.freeze({
      value: observed.value ?? "",
      selectedValue: observed.selectedValue ?? "",
      selectedControlId: clean(observed.selectedControlId),
      satisfied: observed.satisfied === true,
      required: observed.required === true
    })
  });
}

function taskStateReadModel(taskState = null) {
  return taskState && typeof taskState === "object"
    ? taskStateReadModels.get(taskState) || null
    : null;
}

function groupId(group = {}) {
  return clean(group.decisionGroupId || group.requirementId);
}

function groupKey(group = {}) {
  return groupId(group);
}

function semanticToken(value = "", limit = 160) {
  return lower(value).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, limit);
}

function stableSemanticToken(value = "", limit = 56) {
  const normalized = semanticToken(value, 600) || "unknown";
  let hash = 2166136261;
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const suffix = (hash >>> 0).toString(36);
  const prefixLength = Math.max(1, limit - suffix.length - 1);
  return `${normalized.slice(0, prefixLength)}_${suffix}`;
}

// Stable semantic ownership for one checkout decision. Unlike the recovery
// instance key, this deliberately excludes the selected option: choosing an
// option changes the outcome, not the identity of the decision that owns it.
function canonicalDecisionOwnerId(decision = {}, observation = {}) {
  const observed = decision.observed || decision;
  const ownership = observed.semanticOwnership || {};
  const progress = observation.page?.foreground?.progressMarkers
    || observation.page?.visualState?.foreground?.progressMarkers
    || {};
  const family = episodeFamilyForDecision(decision) || lower(decision.family || decision.subject?.family || "decision");
  const owner = clean(
    decision.canonicalOwnerId
    || ownership.canonicalOwnerId
    || ownership.ownerKey
    || ownership.linkId
    || observed.sectionOwnerKey
    || observed.requirementId
    || observed.sectionId
    || decision.requirementId
    || decision.decisionGroupId
    || decision.decisionId
  );
  // A shared requirement such as `contact:select-an-option` is useful
  // semantic context, but is not enough to distinguish sibling products.
  // Keep the exact logical decision group as a separate identity component.
  const exactOwner = clean(
    decision.decisionGroupId
    || decision.decisionId
    || observed.decisionGroupId
    || observed.decisionId
    || decision.requirementId
  );
  const semanticOwner = clean([
    observed.sectionType,
    observed.sectionLabel,
    decision.subject?.label
  ].filter(Boolean).join(" "));
  const repeatedScope = clean([
    progress.flightOrdinal,
    progress.route,
    progress.segment,
    observed.passengerId,
    observed.travelerId,
    observed.passengerOrdinal,
    observed.travelerOrdinal,
    progress.passengerOrdinal,
    progress.travelerOrdinal
  ].filter(Boolean).join("|"));
  return [
    "checkout",
    semanticToken(family, 20),
    stableSemanticToken([semanticOwner, owner].filter(Boolean).join("|") || "unknown_owner", 52),
    stableSemanticToken(exactOwner || "unknown_group", 52),
    stableSemanticToken(repeatedScope || "global", 30)
  ].join(":");
}


function surfaceFingerprint(surface = {}, observation = {}) {
  const rawUrl = clean(observation.page?.url);
  let documentScope = rawUrl.split(/[?#]/)[0];
  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      documentScope = `${parsed.origin}${parsed.pathname}`;
    } catch {
      // Relative and synthetic replay URLs still get a stable query/hash-free
      // document identity from the fallback above.
    }
  }
  const progress = observation.page?.foreground?.progressMarkers
    || observation.page?.visualState?.foreground?.progressMarkers
    || {};
  return JSON.stringify({
    documentScope,
    id: surface.id || "surface-page",
    type: surface.type || "page",
    label: lower(surface.label),
    progress
  });
}

function completedMap(previousTaskState = {}) {
  const records = previousTaskState.completedOutcomes || [];
  return new Map(records.filter((record) => groupId(record)).map((record) => [
    clean(record.instanceId || groupKey(record)),
    { ...record }
  ]));
}

function forwardControlIds(observation = {}) {
  const page = observation.page || {};
  return (page.controls || []).filter((control) => {
    if (!controlBelongsToCurrentSurface(control, page)) return false;
    if (!controlHasExecutableCapability(control)) return false;
    const typedNavigation = isTypedNavigationControl(control, { explicitStageExit: false });
    const state = control.state || {};
    const alreadySelected = control.selected === true
      || state.selected === true
      || state.checked === true;
    const choiceLike = /checkbox|radio|option|choice/.test(lower(
      `${control.kind || ""} ${control.role || ""} ${control.domRole || ""}`
    ));
    // Choice settlement belongs to its decision obligation. Navigation is
    // admitted only from typed meaning on this canonical control; the derived
    // browser `stageExit` projection cannot add a second authority.
    if (alreadySelected && !typedNavigation) return false;
    if (choiceLike && !typedNavigation) return false;
    return typedNavigation;
  }).map((control) => control.controlId).filter(Boolean);
}


function capabilitiesForDecision(decision = {}, observation = {}) {
  const page = observation.page || {};
  if (Array.isArray(decision.availableTransitions)) {
    const ids = new Set(decision.availableTransitions.map((transition) => transition.controlId).filter(Boolean));
    return (page.controls || []).filter((control) => (
      ids.has(control.controlId)
      && controlBelongsToCurrentSurface(control, page)
      && controlHasExecutableCapability(control)
    ));
  }
  const group = (page.decisionGroups || []).find((item) => groupId(item) === decision.decisionGroupId) || {};
  const ids = new Set([
    ...(group.alternativeControlIds || []),
    ...(group.semanticCorrectionControlIds || []),
    ...(group.alternatives || []).map((item) => item.controlId)
  ].filter(Boolean));
  return (page.controls || []).filter((control) => {
    if (!controlBelongsToCurrentSurface(control, page) || !controlHasExecutableCapability(control)) return false;
    // When the browser supplies explicit alternatives, that exact set owns
    // eligibility. Section siblings and page-wide controls cannot leak in.
    return ids.size ? ids.has(control.controlId) : control.decisionGroupId === decision.decisionGroupId;
  });
}

function transitionIsFree(transition = {}) {
  const amount = transition.structuredPrice?.amount ?? transition.priceDelta;
  return transition.included === true
    || (amount !== null && amount !== undefined && amount !== "" && Number(amount) === 0)
    || ["select_free_option", "decline_paid_extra", "remove_paid_selection"].includes(
      clean(transition.physicalEffect || transition.semanticEffect || transition.semantic)
    );
}

function decisionOptionContract(decision = {}, observation = {}) {
  if (Array.isArray(decision.availableTransitions)) {
    const allTransitions = decision.availableTransitions;
    const transitions = allTransitions.filter((transition) => transition.executable);
    const desiredIds = new Set(decision.userIntent?.desiredControlIds || []);
    const unselectDesiredToggle = decision.userIntent?.desiredSelected === false;
    const linkedCorrectionIds = new Set((observation.page?.semanticOwnershipLinks || [])
      .filter((link) => (
        link.status === "resolved"
        && link.sourceDecisionGroupId === decision.decisionGroupId
        && link.intendedOutcome
        && link.intendedOutcome !== "unknown"
      ))
      .map((link) => link.correctionControlId));
    const paidIds = transitions.filter((transition) => transition.paid).map((transition) => transition.controlId);
    const generallyFreeIds = transitions.filter((transition) => (
      !transition.paid && (
        transitionIsFree(transition)
        || (unselectDesiredToggle && desiredIds.has(transition.controlId))
      )
    )).map((transition) => transition.controlId);
    const eligibleIntentIds = new Set(decision.userIntent?.eligibleOptionIds || []);
    const exactFreeIds = generallyFreeIds.filter((controlId) => desiredIds.has(controlId));
    const legalDecision = [
      decision.family,
      decision.subject?.key,
      decision.subject?.family,
      decision.sectionType
    ].map((value) => clean(value)).some((value) => [
      "legal",
      "legal_attestation",
      "standard_terms",
      "factual_accuracy_attestation",
      "unknown_attestation"
    ].includes(value));
    // A legal attestation is an obligation even when the generic preference
    // resolver has no "desired option" vocabulary for it. Admit its exact
    // observed actuator here; the typed legal-scope policy remains the sole
    // authority that may allow or request approval at governance time.
    const policyChoiceBounded = !legalDecision
      && ["constraint", "exact", "ambiguous", "unavailable"].includes(decision.userIntent?.match);
    const constrainedFreeIds = generallyFreeIds.filter((controlId) => eligibleIntentIds.has(controlId));
    const freeIds = policyChoiceBounded
      ? (exactFreeIds.length ? exactFreeIds : constrainedFreeIds)
      : generallyFreeIds;
    const correctionIds = transitions.filter((transition) => (
      linkedCorrectionIds.has(transition.controlId)
      || (decision.status === "conflicted" && desiredIds.has(transition.controlId))
    ))
      .map((transition) => transition.controlId);
    const policyAllowedIds = transitions.filter((transition) => (
      desiredIds.has(transition.controlId)
      || (decision.userIntent?.match === "constraint" && eligibleIntentIds.has(transition.controlId))
      || linkedCorrectionIds.has(transition.controlId)
    )).map((transition) => transition.controlId);
    return {
      // Semantic eligibility is independent of current mechanical
      // executability. An unavailable exact Skip remains the only state that
      // can satisfy the obligation; it must not be replaced by executable
      // Next/Back controls. Mechanics will separately produce no candidate.
      eligibleControlIds: allTransitions.map((transition) => transition.controlId),
      freeControlIds: freeIds,
      paidControlIds: paidIds,
      correctionControlIds: correctionIds,
      policyAllowedControlIds: policyAllowedIds,
      policyChoiceBounded
    };
  }
  // Canonical DecisionFrame decisions always publish typed transitions. If a
  // decision reaches TaskState without them, semantics are incomplete; do not
  // reconstruct paid/free meaning from labels or nearby controls here.
  return {
    eligibleControlIds: [],
    freeControlIds: [],
    paidControlIds: [],
    correctionControlIds: [],
    policyAllowedControlIds: [],
    policyChoiceBounded: false
  };
}

function goalForDecision(decision = {}, observation = {}, userPolicy = {}, traveler = {}) {
  const options = decisionOptionContract(decision, observation);
  const explicitDesiredOutcome = clean(decision.userIntent?.desiredOutcome);
  const unselectOptionalConsent = decision.desiredStateDelta?.desiredState === "unselected"
    || decision.userIntent?.desiredSelected === false;
  const genericDesiredOutcome = !explicitDesiredOutcome
    || ["selected", "selected_policy_allowed_option"].includes(explicitDesiredOutcome);
  const desiredSemanticOutcome = unselectOptionalConsent
    ? agentContract.SEMANTIC_EFFECT.SELECT_FREE_OPTION
    : genericDesiredOutcome && options.correctionControlIds.length
    ? agentContract.SEMANTIC_EFFECT.SELECT_FREE_OPTION
    : genericDesiredOutcome
      && options.policyChoiceBounded
      && options.freeControlIds.some((controlId) => options.policyAllowedControlIds.includes(controlId))
      ? agentContract.SEMANTIC_EFFECT.SELECT_FREE_OPTION
      : explicitDesiredOutcome;
  const desiredPolicyOutcome = desiredSemanticOutcome || "selected_policy_allowed_option";
  const observationId = observation.observationId || "observation";
  const unknownAttestation = [
    decision.sectionType,
    decision.subject?.key,
    decision.semanticType
  ].some((value) => clean(value) === "unknown_attestation");
  return Object.freeze({
    goalId: `decision:${decision.decisionGroupId || decision.decisionId}`,
    kind: unknownAttestation ? "unknown_attestation" : "checkout_decision",
    semanticGoal: `resolve ${decision.subject?.label || `the exact current ${decision.family || "checkout"} decision`}`,
    semanticType: unknownAttestation
      ? "unknown_attestation"
      : decision.subject?.key || decision.family || "decision",
    desiredValue: desiredPolicyOutcome,
    desiredPolicyOutcome,
    desiredSemanticOutcome,
    canonicalDecisionId: decision.decisionId,
    canonicalSubject: decision.subject || null,
    controlType: decision.controlType || "",
    userIntentMatch: decision.userIntent?.match || "none",
    profileResolutionReason: decision.userIntent?.reason || "",
    authorization: decision.userIntent?.authorization || null,
    decisionGroupId: decision.decisionGroupId,
    requirementId: decision.requirementId,
    surfaceId: decision.surfaceId,
    observationId,
    eligibleAlternativeControlIds: Object.freeze(options.eligibleControlIds),
    policyAllowedControlIds: Object.freeze(options.policyAllowedControlIds),
    policyChoiceBounded: options.policyChoiceBounded === true,
    freeAlternativeControlIds: Object.freeze(options.freeControlIds),
    paidAlternativeControlIds: Object.freeze(options.paidControlIds),
    semanticCorrectionControlIds: Object.freeze(options.correctionControlIds),
    decisionStatus: decision.status,
    desiredStateDelta: decision.desiredStateDelta || null,
    forceAiResolution: ["conflicted", "blocked"].includes(decision.status),
    postcondition: Object.freeze({
      type: "decision_group_resolved",
      decisionGroupId: decision.decisionGroupId,
      desiredPolicyOutcome,
      desiredSemanticOutcome,
      eligibleAlternativeControlIds: options.eligibleControlIds
    })
  });
}

function unknownEvidenceGoal(obligation = {}, observation = {}) {
  const page = observation.page || {};
  const reconciliation = page.semanticSceneReconciliation || page.activeRequirementGrounding || null;
  const exactIds = new Set([
    obligation.controlId,
    ...(obligation.evidenceIds || [])
  ].map(clean).filter(Boolean));
  const actionableControlIds = (page.controls || []).filter((control) => (
    exactIds.has(clean(control.controlId))
    && controlBelongsToCurrentSurface(control, page)
    && controlHasExecutableCapability(control)
  )).map((control) => control.controlId);
  return Object.freeze({
    goalId: clean(obligation.id),
    kind: clean(obligation.kind || "unknown_required"),
    semanticGoal: `resolve the current ${clean(obligation.kind || "unknown requirement").replace(/_/g, " ")}`,
    semanticType: clean(obligation.semanticType || "unknown"),
    desiredValue: "requirement_resolved",
    surfaceId: clean(obligation.surfaceId || "surface-page"),
    observationId: observation.observationId || "",
    actionableControlIds: Object.freeze(actionableControlIds),
    evidenceStrength: clean(obligation.evidenceStrength || "strong"),
    rawEvidenceIds: Object.freeze([...(obligation.evidenceIds || [])]),
    postcondition: Object.freeze({
      type: "validation_or_requirement_resolved",
      obligationId: clean(obligation.id),
      controlId: clean(obligation.controlId),
      mustNotIncreasePrice: true
    }),
    ...(actionableControlIds.length && reconciliation?.status !== "unknown" ? {} : {
      ambiguity: Object.freeze({
        code: clean(reconciliation?.reasonCode) || (actionableControlIds.length
          ? "UNKNOWN_OBLIGATION_UNRESOLVED"
          : "UNKNOWN_OBLIGATION_HAS_NO_ACTUATOR"),
        reason: clean(reconciliation?.evidence) || (actionableControlIds.length
          ? "Bounded interpretation could not safely resolve the exact current blocker."
          : "Strong blocker evidence exists, but no exact current-surface actuator owns it.")
      })
    })
  });
}

function navigationGoal(observation = {}, controlIds = []) {
  const surface = currentSurface(observation.page || {});
  return Object.freeze({
    goalId: `navigation:${surface.id || "surface-page"}`,
    semanticGoal: surface.type === "page" ? "continue checkout" : "advance the current foreground surface",
    semanticType: "navigation",
    desiredValue: "next_stage",
    decisionGroupId: "",
    requirementId: "",
    surfaceId: surface.id || "surface-page",
    observationId: observation.observationId || "",
    actionableControlIds: [...new Set(controlIds)],
    postcondition: { type: "stage_exit_or_feedback" }
  });
}

function completedChoiceSurfaceGoal(observation = {}, episode = {}) {
  const surface = currentSurface(observation.page || {});
  return Object.freeze({
    goalId: `close:${clean(episode.episodeId || episode.parentDecisionGroupId || surface.id || "surface-page")}`,
    semanticGoal: "close the completed choice surface",
    semanticType: "completed_choice_surface",
    desiredValue: "surface_dismissed",
    decisionGroupId: clean(episode.parentDecisionGroupId),
    parentDecisionGroupId: clean(episode.parentDecisionGroupId),
    parentSelectedControlId: clean(episode.selectedControlId),
    decisionEpisodeId: clean(episode.episodeId),
    requirementId: clean(episode.requirementId),
    surfaceId: surface.id || "surface-page",
    observationId: observation.observationId || "",
    actionableControlIds: Object.freeze([...(episode.surfaceExitControlIds || [])]),
    surfaceExitOwnership: episode.surfaceExitOwnership || null,
    completedDecisionGroupId: clean(episode.parentDecisionGroupId),
    postcondition: Object.freeze({
      type: "active_surface_dismissed",
      previousSurfaceId: surface.id || "",
      parentDecisionGroupId: clean(episode.parentDecisionGroupId),
      parentExpectedSelectedControlId: clean(episode.selectedControlId),
      decisionEpisodeId: clean(episode.episodeId),
      surfaceExitOwnership: episode.surfaceExitOwnership || null
    })
  });
}

function admittedControlIdsForGoal(goal = {}) {
  const explicit = (goal.actionableControlIds || []).filter(Boolean);
  if (explicit.length) return [...new Set(explicit)];
  if (goal.policyChoiceBounded === true) {
    return [...new Set((goal.policyAllowedControlIds || []).filter(Boolean))];
  }
  if (goal.kind === "profile_field") {
    return [...new Set([
      goal.controlId,
      goal.componentBinding?.controlId,
      ...(goal.componentBinding?.representationControlIds || []),
      ...(goal.componentBinding?.stateControlIds || [])
    ].filter(Boolean))];
  }
  return [...new Set((goal.eligibleAlternativeControlIds || []).filter(Boolean))];
}




function reduceDecisionFrame({
  previousTaskState = {},
  observation = {},
  previousActionResult = null,
  verifiedCommerceObligations: suppliedVerifiedCommerceObligations = [],
  userPolicy = {},
  traveler = {},
  transactionReview = null,
  parentObjective = null,
  mechanicalEvidence = null,
  decisionFrame = null
} = {}) {
  if (!decisionFrameOwnsObservation(decisionFrame, observation)) {
    throw new Error("TASK_STATE_DECISION_FRAME_REQUIRED");
  }
  const authoritativeDecisionFrame = decisionFrame;
  const semanticCompilation = authoritativeDecisionFrame.semanticCompilation;
  observation = authoritativeDecisionFrame.observation;
  const previousGoal = taskMechanics(previousTaskState);
  const page = observation.page || {};
  const normalizedProfilePolicy = userPolicy.profilePolicy || normalizeProfilePolicy({ userPolicy, traveler });
  const surface = currentSurface(page);
  const { stage: diagnosedStage, evidence: stageDecisionEvidence } = decideStage(observation);
  const cardEntryBoundary = cardCredentialEntryBoundaryEvidence(observation, stageDecisionEvidence, transactionReview, traveler);
  const stage = cardEntryBoundary.observed ? "payment" : diagnosedStage;
  const fingerprint = surfaceFingerprint(surface, observation);
  const meaningfulSurfaceChange = Boolean(previousTaskState.surfaceFingerprint
    && previousTaskState.surfaceFingerprint !== fingerprint);
  const completions = completedMap(previousTaskState);
  const authoritativeActionResult = previousActionResult || observation.lastActionResult || null;
  const verifiedExpectedOutcome = authoritativeActionResult?.actionOutcome?.originalSuccessContract
    || authoritativeActionResult?.expectedOutcome
    || {};
  const verifiedAction = authoritativeActionResult?.action || {};
  const verifiedLineage = actionDecisionLineage(
    authoritativeActionResult,
    previousGoal,
    previousTaskState.decisionEpisode || {}
  );
  const verifiedDecisionGroupId = clean(
    verifiedExpectedOutcome.decisionGroupId
    || authoritativeActionResult?.decisionGroupId
    || verifiedAction.decisionGroupId
    || verifiedLineage.decisionGroupId
    || authoritativeActionResult?.targetSnapshot?.decisionGroupId
  );
  const verifiedFreeSelection = Boolean(
    verifiedActionSucceeded(authoritativeActionResult)
    && verifiedExpectedOutcome.type === "exact_free_option_selected"
    && verifiedDecisionGroupId
    && (
      authoritativeActionResult?.mechanicalEffect === "select_free_option"
      || verifiedAction.mechanicalEffect === "select_free_option"
      || verifiedAction.affordance?.physicalEffect === "select_free_option"
      || verifiedAction.affordance?.effect === "select_free_option"
      || verifiedExpectedOutcome.expectedDisposition === "decline_free_no_extra"
    )
  );
  if (verifiedFreeSelection) {
    const instanceId = clean(
      semanticIdentity(authoritativeActionResult)
      || semanticIdentity(verifiedAction)
      || semanticIdentity(previousGoal)
      || authoritativeActionResult.decisionInstanceId
      || verifiedAction.decisionInstanceId
      || verifiedLineage.decisionInstanceId
      || (
        (previousGoal?.decisionGroupId) === verifiedDecisionGroupId
          ? (previousGoal?.decisionInstanceId)
          : ""
      )
      || verifiedDecisionGroupId
    );
    completions.set(instanceId, {
      decisionGroupId: verifiedDecisionGroupId,
      instanceId,
      semanticOwnerId: instanceId,
      canonicalOwnerId: instanceId,
      requirementId: clean(
        authoritativeActionResult.requirementId
        || verifiedExpectedOutcome.requirementId
        || (previousGoal?.requirementId)
      ),
      surfaceId: clean(
        verifiedExpectedOutcome.surfaceId
        || authoritativeActionResult.targetSnapshot?.surfaceId
        || (previousGoal?.surfaceId)
      ),
      status: "satisfied",
      selectedControlId: clean(
        verifiedExpectedOutcome.expectedSelectedControlId
        || verifiedExpectedOutcome.controlId
        || authoritativeActionResult.controlId
        || verifiedAction.controlId
      ),
      completionReason: "verified_exact_free_option",
      observationId: observation.observationId || ""
    });
  }
  const observedDecisions = (authoritativeDecisionFrame.commerceEntities || []).filter((group) => groupId(group)).map((group) => {
    // Product/milestone desire belongs to TaskState, not semantic
    // interpretation. DecisionFrame tells us this is a payment-method or fare
    // decision; the reducer decides whether the current product objective
    // requires resolving it.
    const taskRequired = group.required === true
      || ["payment_method", "fare"].includes(clean(group.subject || group.sectionType));
    const taskGroup = taskRequired === group.required
      ? group
      : { ...group, required: taskRequired };
    const instanceId = decisionInstanceKey(group, observation);
    const previousGroupCompletion = [...(previousTaskState.completedOutcomes || [])]
      .reverse()
      .find((record) => groupId(record) === groupId(group)) || null;
    const sameSurface = Boolean(
      previousTaskState.surfaceFingerprint
      && previousTaskState.surfaceFingerprint === fingerprint
    );
    const sameSurfaceCompletion = previousGroupCompletion && sameSurface
      ? previousGroupCompletion
      : null;
    // completedOutcomes is settlement memory for the exact observed decision
    // instance, not semantic approval for a similarly named group on a later
    // document. A hosted payment provider commonly publishes the same generic
    // payment group id as the airline even though it is a fresh required
    // choice. Fresh page state must own that decision.
    if (!sameSurface && previousGroupCompletion) {
      for (const [completionId, completion] of completions.entries()) {
        if (groupId(completion) === groupId(group)) completions.delete(completionId);
      }
    }
    const previousCompletion = sameSurface
      ? (completions.get(instanceId) || sameSurfaceCompletion)
      : null;
    const normalizedDecision = resolveCanonicalDecision({
      group: taskGroup,
      page,
      previousCompletion,
      userPolicy,
      traveler,
      decisionEpisode: previousTaskState.decisionEpisode || null
    });
    const decision = Object.freeze({
      ...normalizedDecision,
      instanceId,
      canonicalOwnerId: canonicalDecisionOwnerId(normalizedDecision, observation),
      originKind: normalizedDecision.family === "profile" ? "profile_field" : "commerce_decision"
    });
    if (COMPLETED.has(decision.status)) {
      if (sameSurfaceCompletion) {
        completions.delete(clean(sameSurfaceCompletion.instanceId || groupKey(sameSurfaceCompletion)));
      }
      completions.set(instanceId, {
        decisionGroupId: decision.decisionGroupId,
        instanceId: decision.instanceId,
        requirementId: decision.requirementId,
        surfaceId: decision.surfaceId,
        status: decision.status,
        selectedControlId: decision.selectedControlId,
        completionReason: decision.completionReason,
        observationId: observation.observationId || ""
      });
    } else if (decision.reopenEvidence) {
      completions.delete(instanceId);
      if (sameSurfaceCompletion) {
        completions.delete(clean(sameSurfaceCompletion.instanceId || groupKey(sameSurfaceCompletion)));
      }
    }
    return decision;
  });
  // DecisionFrame commerce entities are the single decision authority.
  // The removed standalone-control pass independently reinterpreted every
  // checkbox/button and could schedule disclosures, plus buttons, or other
  // unrelated controls as new checkout work.
  const canonicalDecisions = Object.freeze([...observedDecisions]);
  const desiredStateEvaluations = compileDesiredStateEvaluations({ decisions: canonicalDecisions });
  const desiredStateDeltas = compileDesiredStateDeltas({ decisions: canonicalDecisions });
  const desiredStateDeltaByDecisionId = new Map(desiredStateDeltas.map((delta) => [
    clean(delta.decisionGroupId),
    delta
  ]));
  const decisionIdentity = (decision = {}) => clean(decision.decisionGroupId || decision.decisionId);

  let decisionEpisode = choiceDecisionEpisode({
    previousTaskState,
    previousActionResult: authoritativeActionResult,
    canonicalDecisions,
    observation,
    surface
  });
  const durableVerifiedCommerceObligations = verifiedCommerceObligations(
    previousTaskState.verifiedCommerceObligations,
    suppliedVerifiedCommerceObligations
  );
  const admittedOutcomes = admittedVerifiedCommerceOutcomes({
    actionResult: authoritativeActionResult,
    canonicalDecisions,
    previousTaskState,
    decisionEpisode,
    observationId: observation.observationId || ""
  });
  // Keep the existing episode compiler as the richer source for true child
  // confirmations and aggregated seats. Receipts fill only the lossy gap:
  // exact ordinary selections whose page/episode vanished before admission.
  const receiptOutcomes = durableVerifiedCommerceObligations
    .map(commerceOutcomeFromVerifiedObligation)
    .filter(Boolean);
  let outcomeJournal = verifiedOutcomeJournal(
    previousTaskState.outcomeJournal,
    [...receiptOutcomes, ...admittedOutcomes]
  );
  let outcomeCoverage = verifiedOutcomeCoverage(
    durableVerifiedCommerceObligations,
    outcomeJournal,
    transactionReview?.outcomeLedger
  );

  const foreground = surface.type !== "page";
  const owned = canonicalDecisions.filter((decision) => {
    if (!foreground) return decision.surfaceId === "surface-page" || decision.surfaceType === "page";
    if (decision.surfaceId === surface.id || decision.decisionGroupId === surface.decisionGroupId) return true;
    // Surface metadata can lag behind a portal/rerender. Exact current-surface
    // controls owned by the decision are stronger than that stale container
    // label and keep a proven paid conflict ahead of navigation.
    return capabilitiesForDecision(decision, observation).length > 0;
  });
  const desiredStateEvaluationByDecisionId = new Map(desiredStateEvaluations.map((evaluation) => [
    clean(evaluation.decisionGroupId),
    evaluation
  ]));
  const blockingDesiredStateEvaluation = owned
    .filter((decision) => GOAL_CREATING.has(decision.status))
    .map((decision) => desiredStateEvaluationByDecisionId.get(decisionIdentity(decision)))
    .find((evaluation) => ["MISSING_FACT", "BLOCKED_EXTERNAL"].includes(evaluation?.status)) || null;
  let activeDecisions = owned
    .filter((decision) => GOAL_CREATING.has(decision.status))
    .filter((decision) => desiredStateDeltaByDecisionId.has(decisionIdentity(decision)))
    .map((decision) => Object.freeze({
      ...decision,
      desiredStateDelta: desiredStateDeltaByDecisionId.get(decisionIdentity(decision))
    }))
    .sort((left, right) => {
      const priority = (decision) => {
        if (decision.status === "conflicted" && (
          decisionOptionContract(decision, observation).freeControlIds.length
          || decisionOptionContract(decision, observation).correctionControlIds.length
        )) return 0;
        if (decision.status === "conflicted") return 1;
        // An executable prerequisite owns the next action. A downstream
        // decision blocked by that prerequisite cannot outrank the control
        // that enables it (for example terms before a disabled card route).
        if (decision.status === "active" && capabilitiesForDecision(decision, observation).length) return 2;
        if (decision.status === "blocked") return 3;
        return 4;
      };
      return priority(left) - priority(right);
    });
  // Cycle evidence is diagnostic, not a second mechanical exhaustion
  // authority. Failed-strategy memory owns whether a fresh actuator/method
  // remains. Suppressing the current decision here used to stop before that
  // recovery could try the next exact strategy. Stale episodes are already
  // excluded by canonical ownership when they are absent from activeDecisions.
  let routableActiveDecisions = activeDecisions;
  const suspendedDecisions = foreground
    ? canonicalDecisions.filter((decision) => (
        decision.surfaceId !== surface.id
        && GOAL_CREATING.has(decision.status)
        && desiredStateEvaluationByDecisionId.has(decisionIdentity(decision))
      ))
    : [];
  const validationBlockers = activeValidationIssues(page.validationIssues || []).filter((issue) => issue.stageWide === true || !issue.controlId || (page.controls || []).some((control) => (
    control.controlId === issue.controlId && controlBelongsToCurrentSurface(control, page)
  )));
  const unknownEvidenceObligations = (authoritativeDecisionFrame.unresolvedEvidence || []).filter((obligation) => (
    ["unknown_required", "unknown_validation", "unknown_attestation"].includes(obligation.kind)
    && ["strong", "structural"].includes(obligation.evidenceStrength)
    && (!obligation.surfaceId || obligation.surfaceId === surface.id || (surface.type === "page" && obligation.surfaceId === "surface-page"))
  ));
  const controlIds = forwardControlIds(observation);
  const paymentContactControlIds = new Set(
    cardEntryBoundary.observed
      ? cardEntryBoundary.pendingContactControlIds || []
      : []
  );
  // Payment surfaces often contain prose about email confirmations and
  // support. That text must not reopen the whole page as a traveler form.
  // At the terminal boundary, only exact controls already proven to be
  // unfinished contact inputs remain eligible for profile evaluation.
  const profilePage = {
    ...page,
    // Derived traveler facts must use the same immutable booking authority as
    // transaction reconciliation. This is especially important on later
    // pages whose visible date label omits a year.
    selectedBooking: transactionReview?.baseline || null
  };
  const profileObservation = cardEntryBoundary.observed
    ? {
        ...observation,
        page: {
          ...profilePage,
          controls: (page.controls || []).filter((control) => paymentContactControlIds.has(control.controlId)),
          fields: (page.fields || []).filter((field) => paymentContactControlIds.has(field.controlId)),
          validationIssues: (page.validationIssues || []).filter((issue) => (
            issue.controlId && paymentContactControlIds.has(issue.controlId)
          ))
        }
      }
    : { ...observation, page: profilePage };
  const admittedVerifiedProfileComponent = verifiedProfileComponentFromActionResult(
    authoritativeActionResult,
    observation.observationId || ""
  );
  const verifiedProfileComponents = reconcileVerifiedProfileComponents(
    previousTaskState.verifiedProfileComponents,
    admittedVerifiedProfileComponent,
    authoritativeDecisionFrame.profileRequirements || []
  );
  // Canonical semantic verification is the only completion authority. Once
  // it verifies an exact component, blank framework shells cannot recreate a
  // parallel profile decision; explicit contradictory state still reopens it.
  activeDecisions = activeDecisions.filter((decision) => !verifiedProfileComponents.some((completion) => (
    verifiedProfileComponentMatchesDecision(completion, decision)
  )));
  routableActiveDecisions = routableActiveDecisions.filter((decision) => !verifiedProfileComponents.some((completion) => (
    verifiedProfileComponentMatchesDecision(completion, decision)
  )));
  const lockedDecisionGroupId = clean(
    (previousGoal?.desiredStateDelta?.decisionGroupId)
    || (previousGoal?.decisionGroupId)
    || (previousGoal?.subject)?.decisionGroupId
  );
  const lockedActiveDecision = lockedDecisionGroupId
    ? routableActiveDecisions.find((decision) => clean(decision.decisionGroupId) === lockedDecisionGroupId) || null
    : null;
  if (lockedActiveDecision) {
    // An unresolved obligation owns the next turn. Reclassification, sibling
    // discovery, and generic progress heuristics may not silently replace it.
    routableActiveDecisions = [
      lockedActiveDecision,
      ...routableActiveDecisions.filter((decision) => decision !== lockedActiveDecision)
    ];
  }
  const compiledProfileRequirements = authoritativeDecisionFrame.profileRequirements || [];
  const baseProfileReadiness = profileStageReadiness(
    profileObservation,
    traveler,
    verifiedProfileComponents,
    { descriptors: compiledProfileRequirements }
  );
  const missingDerivedFacts = Object.freeze((baseProfileReadiness.missingUserData || [])
    .map((item) => missingDerivedFactDependency(item.semanticType, traveler, {
      selectedBooking: transactionReview?.baseline || null
    }))
    .filter(Boolean));
  const activeRequirementGrounding = page.activeRequirementGrounding || null;
  const profileSelection = baseProfileReadiness.profileStage
    && !baseProfileReadiness.ready
        ? selectNextProfileRequirement(
          profileObservation,
          traveler,
          previousGoal,
          verifiedProfileComponents,
          { descriptors: compiledProfileRequirements }
        )
    : { goal: null, blockedFields: [], failureCode: "" };
  const profileReadiness = Object.freeze({
    ...baseProfileReadiness,
    temporarilyBlockedFields: Object.freeze(profileSelection.blockedFields || []),
    // A bounded model result is diagnostic binding evidence. It may refine an
    // obligation already admitted by TaskState, but a negative/unknown answer
    // cannot independently create work or make profile readiness false.
    activeRequirementGrounding,
    missingDerivedFacts,
    blockedReasonCode: missingDerivedFacts.length
      ? "SELECTED_BOOKING_FACT_MISSING"
      : baseProfileReadiness.missingUserData?.length
      ? "MISSING_PROFILE_DATA"
      : profileSelection.failureCode || ""
  });
  const selectedProfileGoal = profileSelection.goal;
  const profileGoal = cardEntryBoundary.observed
    && selectedProfileGoal
    && !/email|phone|contact/.test(lower(`${selectedProfileGoal.semanticType || ""} ${selectedProfileGoal.logicalFieldId || ""}`))
      ? null
      : selectedProfileGoal;
  const surfaceClass = surfaceClassFrom(page);
  const siteFailure = surfaceClass === "site_failure" && foreground
    ? Object.freeze({
        active: true,
        surfaceId: surface.id || "",
        message: clean(surface.label || surface.text || "The checkout site reported an unrecoverable error.").slice(0, 600),
        observedControlIds: Object.freeze((page.controls || [])
          .filter((control) => controlBelongsToCurrentSurface(control, page))
          .map((control) => control.controlId)
          .filter(Boolean))
      })
    : null;
  const previousTerminalLatch = previousTaskState.terminalGoalLatch || {};
  const pendingCardEntryContact = Boolean(
    cardEntryBoundary.observed
    && cardEntryBoundary.pendingContactControlIds.length
  );
  // Booking authority and final-review reconciliation are different facts.
  // Requiring `transactionReview.ready` here is circular because that flag
  // includes `payment_review`, while this gate authorizes the reversible
  // action that reveals payment/card entry in the first place.
  const unresolvedAuthorityFacts = (transactionReview?.missingFacts || []).filter((fact) => (
    fact !== "payment_review" && !String(fact || "").startsWith("review_")
  ));
  const transactionAuthorityReady = transactionReview?.baselineStatus === "approved"
    && unresolvedAuthorityFacts.length === 0
    && (transactionReview?.contradictions || []).length === 0;
  const transactionEvidenceReady = transactionReview?.ready === true
    && outcomeCoverage.complete === true;
  // The current milestone is a browser capability boundary: the user can now
  // enter card number, expiry, and security code. Transaction reconciliation
  // remains visible safety evidence, but it cannot make an observed card form
  // disappear or cause the agent to continue navigating past that boundary.
  const cardEntryCapabilityObserved = !siteFailure
    && cardEntryBoundary.observed
    && !pendingCardEntryContact;
  const cardEntryCompletionObserved = cardEntryCapabilityObserved
    && transactionAuthorityReady;
  const transactionReviewBlocked = !siteFailure
    && cardEntryCapabilityObserved
    && !transactionAuthorityReady;
  const transactionChangeRequiresApproval = Boolean(
    transactionReviewBlocked
    && (transactionReview?.contradictions || []).length
  );
  const terminalGoalLatch = Object.freeze(cardEntryCompletionObserved || previousTerminalLatch.locked === true
    ? {
        locked: true,
        goalId: "reach_card_credential_entry",
        terminalStatus: "card_credential_entry_reached",
        completedObservationId: previousTerminalLatch.completedObservationId || observation.observationId || "",
        completionEvidence: previousTerminalLatch.completionEvidence || "fresh_card_credential_entry"
      }
    : {
        locked: false,
        goalId: "reach_card_credential_entry",
        terminalStatus: "active",
        completedObservationId: "",
        completionEvidence: ""
      });
  const leftActiveCheckout = Boolean(
    stageDecisionEvidence.newSearchRoute
    && previousTaskState.checkoutBoundary?.status === "checkout"
    && previousTaskState.terminalStatus === "active"
  );
  // Only exact card-entry capability latches the task. Method selectors,
  // review summaries, legal copy, routes, and Pay buttons remain nonterminal.
  // Transaction integrity is reported independently below.
  const terminalStatus = terminalGoalLatch.locked
    ? "card_credential_entry_reached"
    : (leftActiveCheckout ? "checkout_left" : "active");
  const paymentEvidence = Object.freeze({
    ...stageDecisionEvidence.payment,
    contractVersion: stageDecisionEvidence.terminalEvidence?.contractVersion || "",
    signals: stageDecisionEvidence.terminalEvidence?.signals || {},
    signalCount: stageDecisionEvidence.terminalEvidence?.signalCount ?? stageDecisionEvidence.paymentSignals,
    evidenceOnly: true,
    paymentActionsAllowed: false,
    boundaryObserved: cardEntryBoundary.observed,
    pendingContact: pendingCardEntryContact,
    boundary: cardEntryBoundary,
    currentlyObserved: cardEntryCapabilityObserved,
    observed: terminalGoalLatch.locked,
    transactionVerified: transactionEvidenceReady,
    missingTransactionFacts: Object.freeze([
      ...(transactionReview?.missingFacts || []),
      ...(outcomeCoverage.complete ? [] : ["verified_decision_outcomes"])
    ]),
    transactionContradictions: Object.freeze(transactionReview?.contradictions || [])
  });
  const checkoutBoundary = Object.freeze({
    status: stageDecisionEvidence.newSearchRoute ? "new_search_page" : "checkout",
    leftActiveCheckout,
    route: stageDecisionEvidence.url
  });
  const foregroundOwnsProfileGoal = Boolean(profileGoal && (page.controls || []).some((control) => (
    controlBelongsToCurrentSurface(control, page)
    && String(control.fieldType || control.field || "") === String(profileGoal.semanticType || "")
  )));
  const previousProfileObligation = previousGoal?.desiredStateDelta?.kind === "profile_field"
    ? previousGoal
    : null;
  const verifiedOwnedProfileChildSurface = Boolean(
    foreground
    && previousProfileObligation
    && verifiedActionSucceeded(authoritativeActionResult)
    && verifiedExpectedOutcome.type === "options_surface_appeared"
    && (
      [
        ...(previousProfileObligation.admittedControlIds || []),
        previousProfileObligation.successCondition?.controlId
      ].filter(Boolean).includes(verifiedExpectedOutcome.controlId || verifiedAction.controlId)
      || (
        !verifiedExpectedOutcome.controlId
        && !verifiedAction.controlId
        && verifiedAction.goalId === previousProfileObligation.id
      )
    )
  );
  let currentWork = null;
  let ambiguityReason = "";
  if (terminalStatus === "active") {
    if (siteFailure) {
      // The foreground failure owns the page. Background traveler fields and
      // decisions remain durable facts, but they cannot create an action goal
      // until the failure surface is gone.
      currentWork = null;
    } else if (cardEntryBoundary.observed && !profileGoal) {
      currentWork = null;
      ambiguityReason = pendingCardEntryContact
        ? "payment_review_contact_incomplete"
        : transactionReviewBlocked
          ? "transaction_review_incomplete"
          : "payment_review_boundary";
    } else if (verifiedOwnedProfileChildSurface) {
      // Opening an owned custom choice changes mechanics, not the semantic
      // obligation. Keep the exact v3 obligation until its desired value is
      // causally committed or recovery is exhausted.
      currentWork = previousProfileObligation;
    } else if (profileGoal && !lockedActiveDecision && (!foreground || foregroundOwnsProfileGoal)) {
      currentWork = Object.freeze(profileGoal);
    } else if (profileReadiness.profileStage && !profileReadiness.ready && !profileGoal) {
      // An unresolved profile field with no executable actuator must not be
      // replaced by a navigation or unrelated surface goal. A fresh
      // observation will re-evaluate every temporarily blocked field.
      currentWork = null;
    } else if (blockingDesiredStateEvaluation) {
      // Missing meaning and external blockers are state, never executable DOM
      // work. In particular they may not fall through to a generic Continue.
      currentWork = null;
      ambiguityReason = blockingDesiredStateEvaluation.status === "BLOCKED_EXTERNAL"
        ? "external_blocker"
        : "missing_decision_fact";
    } else if (decisionEpisode?.status === "completed_pending_surface_exit") {
      // The verified episode owns its remaining mechanical cleanup. The
      // still-visible parent surface may republish structural choices until
      // it closes, but those controls cannot create a second semantic task or
      // reopen the outcome that was just causally verified.
      currentWork = completedChoiceSurfaceGoal(observation, decisionEpisode);
    } else if (routableActiveDecisions.length) {
      const decision = routableActiveDecisions[0];
      const surfaceCapabilities = (page.controls || []).filter((control) => (
        controlBelongsToCurrentSurface(control, page) && controlHasExecutableCapability(control)
      ));
      const decisionCapabilities = capabilitiesForDecision(decision, observation);
      const optionContract = decisionOptionContract(decision, observation);
      const viableControlIds = optionContract.policyChoiceBounded
        ? optionContract.policyAllowedControlIds
        : optionContract.eligibleControlIds;
      const viableDecisionCapabilities = decisionCapabilities.filter((control) => (
        viableControlIds.includes(control.controlId)
      ));
      const paidOnlyUnselectedDecision = Boolean(
        optionContract.paidControlIds.length
        && decision.priceRisk?.selectedPaid !== true
        && optionContract.freeControlIds.length === 0
        && optionContract.correctionControlIds.length === 0
        && optionContract.policyAllowedControlIds.length === 0
      );
      const independentlyProvenPolicyExit = paidOnlyUnselectedDecision
        && controlIds.length
        && ["random_assignment", "declined_or_free", "no_insurance", "included_base_fare"].includes(
          clean(decision.userIntent?.desiredOutcome || optionContract.desiredPolicyOutcome)
        );
      // A stage exit is never a substitute for an unavailable choice. UI mode
      // toggles are filtered by typed commerce truth before reaching this
      // branch; a genuine selected paid item must be reversed by its exact
      // owned actuator. If no such actuator exists, bounded recovery owns the
      // stop instead of silently treating Next or Back as Skip.
      if (!viableDecisionCapabilities.length && independentlyProvenPolicyExit) {
        // No paid item is selected and every unresolved option would add a
        // charge. In this narrow state, an independently compiled current-
        // surface stage exit is progress without selection, not a replacement
        // actuator for Skip. A genuine selected-paid conflict can never enter
        // this branch and still requires its exact reversal.
        currentWork = navigationGoal(observation, controlIds);
      } else if (!viableDecisionCapabilities.length && decisionCapabilities.length) {
        const blockedGoal = goalForDecision(decision, observation, userPolicy, traveler);
        currentWork = Object.freeze({
          ...blockedGoal,
          ambiguity: Object.freeze({
            code: "NO_POLICY_ALLOWED_CANDIDATE",
            reason: "The current decision has executable options, but none matches the selected profile and safety policy."
          })
        });
        ambiguityReason = "no_policy_allowed_candidate";
      } else {
        // An active typed decision remains the obligation even when its
        // canonical state control is hidden and the page also contains
        // unrelated executable controls. The mechanics binder owns its
        // bounded control-local recovery (for example opening the visible
        // widget for a hidden payment-method select). Page-wide capability
        // presence must never erase the exact semantic obligation.
        currentWork = goalForDecision(decision, observation, userPolicy, traveler);
      }
    } else if (unknownEvidenceObligations.length) {
      currentWork = unknownEvidenceGoal(unknownEvidenceObligations[0], observation);
    } else if (validationBlockers.length) {
      currentWork = null;
      ambiguityReason = "contradictory_or_validation_evidence";
    } else if (controlIds.length) {
      // Once canonical profile/decision/validation admission has produced no
      // blocker, an executable typed forward control is the next task. This
      // path depends only on the canonical graph, never on stage classification
      // or a separately rebuilt stage-exit candidate list.
      currentWork = navigationGoal(observation, controlIds);
    } else if (foreground) {
      currentWork = null;
      ambiguityReason = "unknown_foreground_surface";
    } else {
      const currentCapabilities = (page.controls || []).filter((control) => controlBelongsToCurrentSurface(control, page));
      if (foreground || currentCapabilities.length) {
        currentWork = null;
        ambiguityReason = foreground ? "unknown_foreground_surface" : "no_goal_relevant_candidate";
      }
    }
  }
  // Candidate exhaustion is mechanical evidence only. It may stop the exact
  // obligation, but it is never authority to replace that obligation with a
  // page-wide "make progress" action.
  const mechanicalEvidenceOwnsGoal = Boolean(
    mechanicalEvidence?.kind === "goal_strategies_exhausted"
    && (
      !mechanicalEvidence.observationHash
      || mechanicalEvidence.observationHash === (
        observation.observationSnapshot?.snapshotHash || page.snapshotHash || ""
      )
    )
    && (
      mechanicalEvidence.goalId === workField(currentWork, "goalId")
      || (
        mechanicalEvidence.semanticGoalKey
        && mechanicalEvidence.semanticGoalKey === semanticGoalKey(currentWork || {})
      )
      || (
        mechanicalEvidence.decisionGroupId
        && mechanicalEvidence.decisionGroupId === (
          workField(currentWork, "decisionGroupId") || currentWork?.subject?.decisionGroupId
        )
      )
    )
  );
  const unresolvedGroundingControlIds = new Set(
    activeRequirementGrounding?.status !== "bound"
      ? (activeRequirementGrounding?.candidateComponentIds || []).map(clean).filter(Boolean)
      : []
  );
  const currentWorkFamily = lower(
    currentWork?.canonicalSubject?.family
    || currentWork?.subject?.family
    || workField(currentWork, "family")
  );
  const groundingOwnsCurrentGoal = Boolean(
    currentWork
    && currentWorkFamily === "profile"
    && (workField(currentWork, "candidateControlIds") || admittedControlIdsForGoal(currentWork))
      .some((controlId) => unresolvedGroundingControlIds.has(clean(controlId)))
  );
  if (groundingOwnsCurrentGoal) {
    // Unknown grounding may block only the exact profile obligation that
    // TaskState already admitted. It cannot make profile readiness false,
    // preempt a sibling decision, or veto navigation from page-wide context.
    currentWork = Object.freeze({
      ...currentWork,
      ambiguity: Object.freeze({
        code: "ACTIVE_REQUIREMENT_UNRESOLVED",
        reason: clean(activeRequirementGrounding.evidence || "The admitted profile component could not be bound to a supplied traveler fact.")
      })
    });
    ambiguityReason = "active_requirement_unresolved";
  }
  if (!decisionEpisode && workField(currentWork, "decisionGroupId")) {
    const parent = canonicalDecisions.find((decision) => decision.decisionGroupId === workField(currentWork, "decisionGroupId")) || null;
    const family = episodeFamilyForDecision(parent);
    if (parent && family) {
      const subjectKey = episodeSubjectKeyForDecision(parent);
      const decisionInstanceId = clean(parent.canonicalOwnerId || parent.decisionGroupId);
      decisionEpisode = Object.freeze({
        episodeId: `checkout:${decisionInstanceId}`,
        decisionInstanceId,
        canonicalOwnerId: decisionInstanceId,
        originKind: "commerce_decision",
        family,
        subjectKey,
        parentDecisionGroupId: parent.decisionGroupId,
        requirementId: clean(parent.requirementId),
        intendedOutcome: clean(workField(currentWork, "desiredSemanticOutcome") || workField(currentWork, "desiredPolicyOutcome") || "selected_policy_allowed_option"),
        selectedControlId: clean(parent.selectedControlId),
        parentStatus: clean(parent.status || "active"),
        status: COMPLETED.has(parent.status) ? "completed" : "active",
        commitmentPhase: COMPLETED.has(parent.status)
          ? (parent.commitmentPhase || "committed")
          : "option_pending",
        outcomeVerified: false,
        terminalOutcome: COMPLETED.has(parent.status)
          ? terminalEpisodeOutcome({
              family,
              subjectKey,
              parentDecisionGroupId: parent.decisionGroupId,
              decisionInstanceId,
              canonicalOwnerId: decisionInstanceId,
              outcomeVerified: false
            }, parent)
          : null,
        semanticOutcomeKey: `${clean(parent.status || "active")}|${clean(parent.selectedControlId)}|${clean(parent.completionReason)}`,
        surfacePath: Object.freeze([decisionEpisodeSurfaceKey(surface)]),
        surfaceExitControlIds: Object.freeze([]),
        cycleCount: 0,
        cycleDetected: false,
        segmentOutcomes: Object.freeze([]),
        currentSegmentKey: "",
        observationId: observation.observationId || ""
      });
    }
  }
  if (currentWork) {
    // An active episode can annotate only its exact parent decision (or its
    // proven close-child surface). Never copy it into the next sibling goal.
    const activeEpisode = decisionEpisode
      && !["completed", "blocked_cycle"].includes(decisionEpisode.status)
      && episodeOwnsGoal(decisionEpisode, currentWork)
      ? decisionEpisode
      : null;
    const workWithEpisode = {
      ...currentWork,
      decisionInstanceId: activeEpisode?.decisionInstanceId || decisionInstanceKey(currentWork, observation),
      canonicalOwnerId: activeEpisode?.canonicalOwnerId || activeEpisode?.decisionInstanceId || "",
      ...(activeEpisode
        ? {
            decisionEpisodeId: activeEpisode.episodeId,
            parentDecisionGroupId: activeEpisode.parentDecisionGroupId,
            parentExpectedSelectedControlId: activeEpisode.selectedControlId,
            decisionEpisodeStatus: activeEpisode.status
          }
        : {}),
      outcomeContract: outcomeContractForGoal(currentWork, observation)
    };
    // A canonical decision already owns its exact desired-state delta. Do not
    // widen it by recompiling from the legacy goal projection; that used to
    // re-admit profile-incompatible sibling controls after policy resolution.
    const desiredStateDelta = currentWork.desiredStateDelta || compileDesiredStateDeltas({
      work: workWithEpisode,
      admittedControlIds: admittedControlIdsForGoal(workWithEpisode)
    })[0] || null;
    currentWork = Object.freeze({
      ...workWithEpisode,
      desiredStateDelta
    });
  }
  const semanticAchievements = [...completions.values()].map((completion) => Object.freeze({
    achievementId: clean(completion.instanceId || completion.decisionGroupId || completion.requirementId),
    kind: completion.requirementId ? "requirement" : "decision",
    status: "verified",
    label: clean(completion.completionReason || completion.requirementId || completion.decisionGroupId),
    observationId: clean(completion.observationId)
  }));
  const transactionAchievements = [
    ...(transactionReview?.outcomeLedger || []),
    ...outcomeJournal
  ].map((outcome) => Object.freeze({
    achievementId: clean(outcome.outcomeKey || outcome.decisionInstanceId || outcome.decisionGroupId),
    kind: clean(outcome.family || "transaction"),
    status: "verified",
    label: clean(outcome.label || outcome.outcome || outcome.disposition),
    observationId: ""
  }));
  const achievements = [...new Map([...semanticAchievements, ...transactionAchievements]
    .filter((achievement) => achievement.achievementId)
    .map((achievement) => [achievement.achievementId, achievement])).values()].slice(-160);
  const unresolved = [
    ...(profileReadiness.missingUserData || []).map((field) => `profile:${clean(field)}`),
    ...activeDecisions.map((decision) => `decision:${clean(decision.decisionGroupId || decision.decisionId)}`),
    ...(cardEntryBoundary.observed ? (transactionReview?.missingFacts || []).map((fact) => `transaction:${clean(fact)}`) : []),
    ...(cardEntryBoundary.observed ? (transactionReview?.contradictions || []).map((fact) => `contradiction:${clean(fact)}`) : [])
  ].filter(Boolean);
  const processAwareness = Object.freeze({
    status: terminalGoalLatch.locked
      ? "goal_achieved"
      : siteFailure
        ? "blocked_by_site"
        : transactionReviewBlocked
          ? "verifying_final_transaction"
          : "in_progress",
    currentPosition: Object.freeze({
      stage: cardEntryBoundary.observed ? "card_credential_entry" : stage,
      surfaceId: clean(surface.id || "surface-page"),
      surfaceType: clean(surface.type || "page"),
      surfaceClass
    }),
    currentObjective: clean(
      workField(currentWork, "semanticGoal")
      || (transactionReviewBlocked ? "verify the final transaction" : "reach card credential entry")
    ),
    achievements: Object.freeze(achievements),
    unresolved: Object.freeze([...new Set(unresolved)].slice(0, 160)),
    finalOutcome: Object.freeze({
      achieved: terminalGoalLatch.locked === true,
      status: terminalStatus,
      transactionVerified: transactionEvidenceReady,
      evidence: clean(terminalGoalLatch.completionEvidence)
    })
  });

  const exactCurrentWork = currentWork;
  const currentObligation = compileCurrentObligation({
    work: exactCurrentWork,
    decisionFrame: authoritativeDecisionFrame
  });
  const missingProfileFact = (profileReadiness.missingUserData || [])[0] || null;
  const missingDerivedFact = (profileReadiness.missingDerivedFacts || [])[0] || null;
  const authorizationConflict = activeDecisions.find((decision) => (
    decision.reopenEvidence?.code === "PAID_SELECTION_POLICY_AUTHORIZATION_CONFLICT"
  )) || null;
  const admittedMechanicsExhausted = Boolean(
    mechanicalEvidenceOwnsGoal
    && currentWork
    && (
      mechanicalEvidence.goalId === workField(currentWork, "goalId")
      || mechanicalEvidence.semanticGoalKey === semanticGoalKey(currentWork)
    )
  );
  const dispositionCode = clean(
    siteFailure ? "SITE_FAILURE_OBSERVED"
      : terminalStatus === "card_credential_entry_reached" ? "CARD_CREDENTIAL_ENTRY_REACHED"
      : terminalStatus === "checkout_left" ? "CHECKOUT_LEFT"
      : transactionChangeRequiresApproval ? "TRANSACTION_CHANGE_REQUIRES_APPROVAL"
      : transactionReviewBlocked ? "TRANSACTION_REVIEW_INCOMPLETE"
      : authorizationConflict ? "PAID_SELECTION_POLICY_AUTHORIZATION_CONFLICT"
      : admittedMechanicsExhausted ? "STRATEGIES_EXHAUSTED"
      : currentObligation ? "EXECUTE_CURRENT_OBLIGATION"
      : blockingDesiredStateEvaluation?.status === "BLOCKED_EXTERNAL" ? "EXTERNAL_BLOCKER"
      : blockingDesiredStateEvaluation?.status === "MISSING_FACT" ? "MISSING_DECISION_FACT"
      : workField(currentWork, "ambiguity")?.code ? workField(currentWork, "ambiguity").code
      : missingDerivedFact ? "SELECTED_BOOKING_FACT_MISSING"
      : missingProfileFact ? "MISSING_PROFILE_DATA"
      : validationBlockers.length ? "ACTIVE_VALIDATION_BLOCKER"
      : profileReadiness.blockedReasonCode ? profileReadiness.blockedReasonCode
      : ambiguityReason ? ambiguityReason
      : "NO_CURRENT_OBLIGATION"
  );
  // TaskState is reduced from a settled observation. It may execute, ask, or
  // stop, but it must never hope that identical semantic evidence changes by
  // itself. Positive destination loading is handled before this reducer by
  // the observation-readiness lifecycle.
  const stopForEngineReconciliation = (reason) => ({
    kind: "stop",
    code: dispositionCode || "NO_EXECUTABLE_OBLIGATION",
    reason,
    surfaceFingerprint: fingerprint,
    userActionRequired: false
  });
  let disposition;
  if (siteFailure) {
    disposition = {
      kind: "stop",
      code: dispositionCode,
      reason: clean(siteFailure.message || "The active checkout surface reports a site failure."),
      userActionRequired: false
    };
  } else if (terminalStatus === "card_credential_entry_reached") {
    disposition = {
      kind: "terminal",
      code: dispositionCode,
      reason: "Actual owned card credential entry is visible; the pre-payment milestone is reached.",
      userActionRequired: false
    };
  } else if (terminalStatus === "checkout_left") {
    disposition = {
      kind: "stop",
      code: dispositionCode,
      reason: "The browser left the active checkout and returned to flight search.",
      userActionRequired: false
    };
  } else if (transactionChangeRequiresApproval) {
    disposition = {
      kind: "request_approval",
      code: dispositionCode,
      reason: "The transaction visible at card credential entry materially conflicts with the approved booking mandate.",
      userActionRequired: true,
      details: Object.freeze({
        missingFacts: Object.freeze([...(transactionReview?.missingFacts || []), ...(outcomeCoverage.complete ? [] : ["verified_decision_outcomes"])]),
        contradictions: Object.freeze([...(transactionReview?.contradictions || [])])
      })
    };
  } else if (transactionReviewBlocked) {
    disposition = stopForEngineReconciliation(
      "Card credential entry is visible, but required transaction evidence is still unresolved."
    );
  } else if (authorizationConflict) {
    disposition = {
      kind: "request_approval",
      code: dispositionCode,
      reason: "A current paid selection conflicts with both the saved decline policy and an explicit item authorization.",
      userActionRequired: true,
      details: Object.freeze({
        decisionGroupId: clean(authorizationConflict.decisionGroupId),
        conflict: authorizationConflict.reopenEvidence
          ? Object.freeze({ ...authorizationConflict.reopenEvidence })
          : null
      })
    };
  } else if (admittedMechanicsExhausted) {
    disposition = {
      kind: "stop",
      code: dispositionCode,
      reason: "The exact admitted obligation exhausted its bounded grounded mechanics without a verified result.",
      obligationId: clean(workField(currentWork, "goalId")),
      userActionRequired: false
    };
  } else if (currentObligation) {
    // One exact current obligation owns the turn. Missing/blocked evaluations
    // belonging to lower-priority work cannot stop an admitted exact delta.
    disposition = {
      kind: "execute",
      code: dispositionCode,
      reason: "Execute the exact current TaskState obligation.",
      obligationId: currentObligation.id,
      userActionRequired: false
    };
  } else if (blockingDesiredStateEvaluation?.status === "BLOCKED_EXTERNAL") {
    disposition = {
      kind: "request_input",
      code: dispositionCode,
      reason: clean(blockingDesiredStateEvaluation.reason || "The current obligation requires an external user-controlled step."),
      userActionRequired: true,
      details: blockingDesiredStateEvaluation
    };
  } else if (blockingDesiredStateEvaluation?.status === "MISSING_FACT") {
    disposition = stopForEngineReconciliation(
      clean(blockingDesiredStateEvaluation.reason || "The current DecisionFrame lacks a fact required to compile an exact obligation.")
    );
  } else if (workField(currentWork, "ambiguity")) {
    disposition = stopForEngineReconciliation(
      clean(workField(currentWork, "ambiguity").reason || "The current checkout obligation remains semantically ambiguous after bounded resolution.")
    );
  } else if (missingDerivedFact) {
    disposition = stopForEngineReconciliation(
      clean(missingDerivedFact.label || "A selected-booking fact required to derive traveler data is missing.")
    );
  } else if (missingProfileFact) {
    disposition = {
      kind: "request_input",
      code: dispositionCode,
      reason: clean(missingProfileFact.label || missingProfileFact.semanticType || "Required traveler information is missing."),
      field: clean(missingProfileFact?.semanticType),
      fieldLabel: clean(missingProfileFact?.label || missingProfileFact?.semanticType),
      missingDerivedFact: null,
      userActionRequired: true
    };
  } else if (validationBlockers.length) {
    disposition = stopForEngineReconciliation(
      "The active checkout surface reports validation with no safely executable owner."
    );
  } else if (["ACTIVE_REQUIREMENT_UNRESOLVED", "SEMANTIC_AMBIGUITY", "active_requirement_unresolved", "contradictory_or_validation_evidence"].includes(dispositionCode)) {
    disposition = stopForEngineReconciliation(
      "The active checkout requirement remains unresolved after bounded semantic resolution."
    );
  } else {
    disposition = stopForEngineReconciliation(
      "The settled surface produced no safely executable obligation."
    );
  }
  disposition = Object.freeze(disposition);

  const transactionReviewProjection = transactionReview ? Object.freeze({
    ...transactionReview,
    ready: transactionEvidenceReady,
    missingFacts: Object.freeze([
      ...(transactionReview.missingFacts || []),
      ...(outcomeCoverage.complete ? [] : ["verified_decision_outcomes"])
    ]),
    outcomeCoverage
  }) : null;
  const readModel = Object.freeze({
    paymentEvidence,
    foregroundSurface: Object.freeze(surface),
    surfaceClass,
    siteFailure,
    activeDecisions: Object.freeze(activeDecisions),
    observedDecisions: Object.freeze(observedDecisions),
    canonicalDecisions,
    desiredStateDeltas,
    desiredStateEvaluations,
    suspendedDecisions: Object.freeze(suspendedDecisions),
    validationBlockers: Object.freeze(validationBlockers),
    stageDecisionEvidence: Object.freeze(stageDecisionEvidence),
    previousActionResult: previousActionResult || null,
    ambiguityReason,
    semanticOwnershipResolutions: Object.freeze(page.semanticOwnershipResolutions || []),
    semanticReadiness: semanticCompilation.semanticReadiness,
    semanticCompilation: Object.freeze({
      unownedMaterialControls: Object.freeze(semanticCompilation.unownedMaterialControls || []),
      unresolvedDecisions: Object.freeze(semanticCompilation.unresolvedDecisions || []),
      currentExecutableObligations: Object.freeze(semanticCompilation.currentExecutableObligations || [])
    }),
    profileReadiness,
    transactionReview: transactionReviewProjection,
    processAwareness
  });
  const taskState = Object.freeze({
    contractVersion: "task-state/v2",
    milestone: Object.freeze({ id: "reach_card_credential_entry", status: terminalGoalLatch.locked ? "completed" : "active" }),
    userPreferences: Object.freeze({
      bookingRules: clean(userPolicy.bookingRules || traveler.booking_rules),
      extras: clean(userPolicy.extras),
      seatPolicy: seatPolicyFrom({ userPolicy, traveler }),
      baggage: clean(userPolicy.baggage)
    }),
    safetyRestrictions: Object.freeze({
      declinePaidExtras: normalizedProfilePolicy.constraints.noPaidExtras === true
        || Object.values(normalizedProfilePolicy.constraints.noPaidByFamily || {}).some(Boolean),
      declinePaidExtrasByFamily: Object.freeze(Object.fromEntries(
        ["seat", "baggage", "insurance", "extras"].map((family) => [
          family,
          normalizedProfilePolicy.constraints.noPaidExtras === true
            || normalizedProfilePolicy.constraints.noPaidByFamily?.[family] === true
        ])
      )),
      paymentSubmissionRequiresApproval: true,
      paymentCredentialsBlocked: true,
      standardBookingTermsAuthorized: normalizedProfilePolicy.standingPolicy?.standardBookingTerms === "accept"
    }),
    terminalGoalLatch,
    checkoutBoundary,
    stage,
    decisionEpisode,
    verifiedCommerceObligations: durableVerifiedCommerceObligations,
    verifiedProfileComponents,
    outcomeJournal,
    outcomeCoverage,
    completedOutcomes: Object.freeze([...completions.values()].slice(-160)),
    verificationDecisionMemory: Object.freeze(canonicalDecisions.slice(-80).map(verificationDecisionRecord)),
    currentObligation,
    disposition,
    decisionFrameId: authoritativeDecisionFrame.frameId,
    terminalStatus,
    surfaceFingerprint: fingerprint,
    meaningfulSurfaceChange,
    clearObsoleteRecovery: terminalGoalLatch.locked === true,
    parentObjective: parentObjective || previousTaskState.parentObjective || null
  });
  taskStateReadModels.set(taskState, readModel);
  return taskState;
}

module.exports = {
  decideStage,
  reconcileVerifiedProfileComponents,
  reduceDecisionFrame,
  taskStateReadModel,
  surfaceClassFrom,
  stageEvidence,
  verifiedCommerceObligationFromActionResult,
  verifiedProfileComponentFromActionResult
};
