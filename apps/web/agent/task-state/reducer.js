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
const { adaptiveInteractionGoal } = require("../adaptive-interaction");
const {
  currentObligation,
  currentObligationFromGoal,
  decisionFrameOwnsObservation
} = require("../authority-frames");
const { obligationField } = require("../current-obligation");
const agentContract = require("../../../extension/src/shared/agent-contract");
const {
  normalizeSemanticOwner,
  semanticOwnerFromLegacy,
  semanticOwnerId
} = require("../../../../packages/shared/semantic-owner");
const { decideStage, stageEvidence } = require("./stage");
const { controlHasExecutableCapability } = require("./control-evidence");
const { paymentReviewBoundaryEvidence } = require("./terminal");
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
const {
  adaptiveSurfaceGoal,
  createSurfaceSubgoal,
  durableOutcomeHierarchy,
  surfaceClassFrom
} = require("./surface-state");

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
const TASK_STATE_REOBSERVE_DEADLINE_MS = 8_000;
const taskStateReadModels = new WeakMap();

function taskMechanics(taskState = {}) {
  return currentObligation(taskState) || {};
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

function unblockedStageExitReady(page = {}) {
  const exit = page.stageExit || {};
  if (exit.continueDisabled === true || exit.navigationState === "disabled") return false;
  const readyCandidate = (exit.candidates || []).some((candidate) => (
    candidate.executable === true || candidate.status === "ready"
  ));
  return Boolean(readyCandidate && !(exit.blockers || []).length);
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
  const progress = observation.page?.foreground?.progressMarkers
    || observation.page?.visualState?.foreground?.progressMarkers
    || {};
  return JSON.stringify({
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
  const explicitStageExitIds = new Set([
    ...(page.stageExit?.candidates || [])
      .filter((candidate) => candidate.status === "ready" || candidate.executable === true)
      .flatMap((candidate) => [candidate.controlId, candidate.actuatorId])
  ].filter(Boolean));
  return (page.controls || []).filter((control) => {
    if (!controlBelongsToCurrentSurface(control, page)) return false;
    if (!controlHasExecutableCapability(control)) return false;
    const explicitStageExit = explicitStageExitIds.has(control.controlId)
      || explicitStageExitIds.has(control.stateElementId)
      || explicitStageExitIds.has(control.preferredActivationElementId);
    const typedNavigation = isTypedNavigationControl(control, { explicitStageExit: false });
    const state = control.state || {};
    const alreadySelected = control.selected === true
      || state.selected === true
      || state.checked === true;
    const choiceLike = /checkbox|radio|option|choice/.test(lower(
      `${control.kind || ""} ${control.role || ""} ${control.domRole || ""}`
    ));
    // A browser stage-exit heuristic may notice text such as "select this to
    // continue" on a settled decline checkbox. That does not make the choice
    // itself a navigation actuator. Exact typed navigation remains eligible;
    // an explicit stage-exit fallback is admitted only for an unselected
    // non-choice actuator such as Continue, Skip bags, or Proceed without
    // seats. Choice settlement belongs to its decision obligation.
    if (alreadySelected && !typedNavigation) return false;
    if (choiceLike && !typedNavigation) return false;
    return typedNavigation || explicitStageExit;
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

function optionPrice(control = {}) {
  const amount = Number(control.structuredPrice?.amount ?? control.priceAmount);
  return Number.isFinite(amount) ? amount : null;
}

function optionLooksPaid(control = {}) {
  if (optionLooksExplicitlyFree(control)) return false;
  return agentContract.isPaidCommerceOption({
    effectRole: control.effectRole,
    priceAmount: optionPrice(control),
    disposition: control.disposition,
    semanticEffect: control.physicalEffect || control.semantic
  });
}

function optionLooksExplicitlyFree(control = {}) {
  return optionPrice(control) === 0
    || /safe_decline|decline|free|\bincluded\b|no[_ -]?extra|no (?:checked|hand|cabin|hold) (?:bag|baggage)|without|none|skip|remove|opt[_ -]?out|not included/.test(
      lower(`${control.risk || ""} ${control.semantic || ""} ${control.label || ""}`)
    );
}

function optionIsBoundedChoice(control = {}) {
  return /radio|checkbox|option|choice/.test(lower(`${control.kind || ""} ${control.role || ""} ${control.semantic || ""}`));
}

function decisionOptionContract(decision = {}, observation = {}) {
  if (Array.isArray(decision.availableTransitions)) {
    const transitions = decision.availableTransitions.filter((transition) => transition.executable);
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
      !transition.paid && optionLooksExplicitlyFree(transition)
    )).map((transition) => transition.controlId);
    const desiredIds = new Set(decision.userIntent?.desiredControlIds || []);
    const eligibleIntentIds = new Set(decision.userIntent?.eligibleOptionIds || []);
    const exactFreeIds = generallyFreeIds.filter((controlId) => desiredIds.has(controlId));
    const policyChoiceBounded = ["constraint", "exact", "ambiguous", "unavailable"].includes(decision.userIntent?.match);
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
      eligibleControlIds: transitions.map((transition) => transition.controlId),
      freeControlIds: freeIds,
      paidControlIds: paidIds,
      correctionControlIds: correctionIds,
      policyAllowedControlIds: policyAllowedIds,
      policyChoiceBounded
    };
  }
  const eligible = capabilitiesForDecision(decision, observation);
  const linkedCorrectionIds = new Set((observation.page?.semanticOwnershipLinks || [])
    .filter((link) => (
      link.status === "resolved"
      && link.sourceDecisionGroupId === decision.decisionGroupId
      && link.intendedOutcome
      && link.intendedOutcome !== "unknown"
    ))
    .map((link) => link.correctionControlId));
  const paidIds = new Set(eligible.filter(optionLooksPaid).map((control) => control.controlId));
  const hasPaidSibling = paidIds.size > 0;
  const freeIds = eligible.filter((control) => (
    !paidIds.has(control.controlId)
    && (
      optionLooksExplicitlyFree(control)
      // Inferring "free" from a paid sibling is needed for raw baggage
      // choices such as No hand baggage versus 8 kg. A seat modal is broader:
      // it also contains traveler rows, legends and navigation controls.
      || (hasPaidSibling && decision.family === "baggage" && optionIsBoundedChoice(control))
    )
  )).map((control) => control.controlId);
  return {
    eligibleControlIds: eligible.map((control) => control.controlId),
    freeControlIds: freeIds,
    paidControlIds: [...paidIds],
    correctionControlIds: eligible.filter((control) => linkedCorrectionIds.has(control.controlId)).map((control) => control.controlId),
    policyAllowedControlIds: [],
    policyChoiceBounded: false
  };
}

function goalForDecision(decision = {}, observation = {}, userPolicy = {}, traveler = {}) {
  const options = decisionOptionContract(decision, observation);
  const explicitDesiredOutcome = clean(decision.userIntent?.desiredOutcome);
  const genericDesiredOutcome = !explicitDesiredOutcome
    || ["selected", "selected_policy_allowed_option"].includes(explicitDesiredOutcome);
  const desiredSemanticOutcome = genericDesiredOutcome && options.correctionControlIds.length
    ? agentContract.SEMANTIC_EFFECT.SELECT_FREE_OPTION
    : genericDesiredOutcome
      && options.policyChoiceBounded
      && options.freeControlIds.some((controlId) => options.policyAllowedControlIds.includes(controlId))
      ? agentContract.SEMANTIC_EFFECT.SELECT_FREE_OPTION
      : explicitDesiredOutcome;
  const desiredPolicyOutcome = desiredSemanticOutcome || "selected_policy_allowed_option";
  const observationId = observation.observationId || "observation";
  return Object.freeze({
    goalId: `${observationId}:goal:${decision.decisionGroupId}`,
    semanticGoal: `resolve ${decision.subject?.label || `the exact current ${decision.family || "checkout"} decision`}`,
    semanticType: decision.subject?.key || decision.family || "decision",
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

function navigationGoal(observation = {}, controlIds = []) {
  const surface = currentSurface(observation.page || {});
  return Object.freeze({
    goalId: `${observation.observationId || "observation"}:goal:continue`,
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
    goalId: `${observation.observationId || "observation"}:goal:close_completed_choice_surface`,
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
      decisionEpisodeId: clean(episode.episodeId)
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
  const checkoutSituation = authoritativeDecisionFrame.checkoutSituation || {};
  const semanticCompilation = authoritativeDecisionFrame.semanticCompilation;
  observation = authoritativeDecisionFrame.observation;
  const previousGoal = taskMechanics(previousTaskState);
  const page = observation.page || {};
  const normalizedProfilePolicy = userPolicy.profilePolicy || normalizeProfilePolicy({ userPolicy, traveler });
  const surface = currentSurface(page);
  const { stage, evidence: stageDecisionEvidence } = decideStage(observation);
  const paymentReviewBoundary = paymentReviewBoundaryEvidence(observation, stageDecisionEvidence, transactionReview, traveler);
  const fingerprint = surfaceFingerprint(surface, observation);
  const meaningfulSurfaceChange = Boolean(previousTaskState.surfaceFingerprint
    && previousTaskState.surfaceFingerprint !== fingerprint);
  const completions = completedMap(previousTaskState);
  const authoritativeActionResult = previousActionResult || observation.lastActionResult || null;
  const verifiedExpectedOutcome = authoritativeActionResult?.expectedOutcome || {};
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
    authoritativeActionResult?.verified === true
    && authoritativeActionResult?.expectedOutcomeObserved === true
    && authoritativeActionResult?.postconditionSatisfied === true
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
        obligationField(previousGoal, "decisionGroupId") === verifiedDecisionGroupId
          ? obligationField(previousGoal, "decisionInstanceId")
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
        || obligationField(previousGoal, "requirementId")
      ),
      surfaceId: clean(
        verifiedExpectedOutcome.surfaceId
        || authoritativeActionResult.targetSnapshot?.surfaceId
        || obligationField(previousGoal, "surfaceId")
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
    const instanceId = decisionInstanceKey(group, observation);
    const previousGroupCompletion = [...(previousTaskState.completedOutcomes || [])]
      .reverse()
      .find((record) => groupId(record) === groupId(group)) || null;
    const progress = page.foreground?.progressMarkers
      || page.visualState?.foreground?.progressMarkers
      || {};
    const repeatedInstanceVisible = Boolean(
      progress.flightOrdinal
      || progress.route
      || progress.passengerOrdinal
      || progress.travelerOrdinal
      || progress.segment
    );
    const sameSurfaceCompletion = previousGroupCompletion && (
      (previousTaskState.surfaceFingerprint && previousTaskState.surfaceFingerprint === fingerprint)
      || !repeatedInstanceVisible
    )
      ? previousGroupCompletion
      : null;
    const previousCompletion = completions.get(instanceId) || sameSurfaceCompletion;
    const normalizedDecision = resolveCanonicalDecision({
      group,
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
  const observedPhysicalControlIds = new Set(observedDecisions.flatMap((decision) => (
    decision.physicalControlIds || []
  )));
  const canonicalControlDecisions = (authoritativeDecisionFrame.standaloneDecisions || []).filter((decision) => (
    !(decision.physicalControlIds || []).some((controlId) => observedPhysicalControlIds.has(controlId))
  )).map((decision) => Object.freeze({
    ...decision,
    canonicalOwnerId: canonicalDecisionOwnerId(decision, observation),
    originKind: decision.family === "profile" ? "profile_field" : "commerce_decision"
  }));
  const canonicalDecisions = Object.freeze([
    ...observedDecisions,
    ...canonicalControlDecisions
  ]);

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
  let activeDecisions = owned
    .filter((decision) => GOAL_CREATING.has(decision.status))
    .sort((left, right) => {
      const priority = (decision) => {
        if (decision.status === "conflicted" && (
          decisionOptionContract(decision, observation).freeControlIds.length
          || decisionOptionContract(decision, observation).correctionControlIds.length
        )) return 0;
        if (decision.status === "conflicted") return 1;
        if (decision.status === "blocked") return 2;
        return 3;
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
    ? canonicalDecisions.filter((decision) => decision.surfaceId !== surface.id && GOAL_CREATING.has(decision.status))
    : [];
  const validationBlockers = activeValidationIssues(page.validationIssues || []).filter((issue) => issue.stageWide === true || !issue.controlId || (page.controls || []).some((control) => (
    control.controlId === issue.controlId && controlBelongsToCurrentSurface(control, page)
  )));
  const controlIds = forwardControlIds(observation);
  const readyStageExitControlIds = (page.stageExit?.candidates || [])
    .filter((candidate) => candidate.executable === true || candidate.status === "ready")
    .map((candidate) => candidate.controlId)
    .filter((controlId) => controlIds.includes(controlId));
  const paymentContactControlIds = new Set(
    paymentReviewBoundary.observed
      ? paymentReviewBoundary.pendingContactControlIds || []
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
  const profileObservation = paymentReviewBoundary.observed
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
  const profileGoal = paymentReviewBoundary.observed
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
  const pendingPaymentReviewContact = Boolean(
    paymentReviewBoundary.observed
    && paymentReviewBoundary.pendingContactControlIds.length
  );
  const transactionEvidenceReady = transactionReview?.ready === true
    && outcomeCoverage.complete === true;
  const paymentCompletionObserved = !siteFailure
    && paymentReviewBoundary.observed
    && !pendingPaymentReviewContact
    && transactionEvidenceReady;
  const transactionReviewBlocked = !siteFailure
    && paymentReviewBoundary.observed
    && !pendingPaymentReviewContact
    && !transactionEvidenceReady;
  const transactionChangeRequiresApproval = Boolean(
    transactionReviewBlocked
    && (transactionReview?.contradictions || []).length
  );
  const terminalGoalLatch = Object.freeze(paymentCompletionObserved || previousTerminalLatch.locked === true
    ? {
        locked: true,
        goalId: "reach_payment_review",
        terminalStatus: "payment_review_reached",
        completedObservationId: previousTerminalLatch.completedObservationId || observation.observationId || "",
        completionEvidence: previousTerminalLatch.completionEvidence || "fresh_payment_evidence"
      }
    : {
        locked: false,
        goalId: "reach_payment_review",
        terminalStatus: "active",
        completedObservationId: "",
        completionEvidence: ""
      });
  const leftActiveCheckout = Boolean(
    stageDecisionEvidence.newSearchRoute
    && previousTaskState.checkoutBoundary?.status === "checkout"
    && previousTaskState.terminalStatus === "active"
  );
  // Payment-looking UI is evidence of the stage, not proof that the requested
  // transaction reached review intact. Only the verified transaction envelope
  // may complete and latch the task.
  const terminalStatus = terminalGoalLatch.locked
    ? "payment_review_reached"
    : (leftActiveCheckout ? "checkout_left" : "active");
  const { transactionOutcome, stageOutcome } = durableOutcomeHierarchy(
    previousTaskState,
    siteFailure ? "unknown" : stage,
    terminalStatus
  );
  const paymentEvidence = Object.freeze({
    ...stageDecisionEvidence.payment,
    contractVersion: stageDecisionEvidence.terminalEvidence?.contractVersion || "",
    signals: stageDecisionEvidence.terminalEvidence?.signals || {},
    signalCount: stageDecisionEvidence.terminalEvidence?.signalCount ?? stageDecisionEvidence.paymentSignals,
    evidenceOnly: true,
    paymentActionsAllowed: false,
    boundaryObserved: paymentReviewBoundary.observed,
    pendingContact: pendingPaymentReviewContact,
    boundary: paymentReviewBoundary,
    currentlyObserved: paymentCompletionObserved,
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
  // A verified profile-field opener transfers that exact unfinished task to
  // its child surface. Do not make continuity depend on re-derived page
  // readiness: a portalled dropdown may temporarily hide/suspend its parent
  // field and make the page look complete even though no value was selected.
  const adaptiveGoal = adaptiveSurfaceGoal({
    previousTaskState,
    actionResult: authoritativeActionResult,
    observation,
    surface
  });
  let currentGoal = null;
  let ambiguityReason = "";
  if (terminalStatus === "active") {
    if (siteFailure) {
      // The foreground failure owns the page. Background traveler fields and
      // decisions remain durable facts, but they cannot create an action goal
      // until the failure surface is gone.
      currentGoal = null;
    } else if (paymentReviewBoundary.observed && !profileGoal) {
      currentGoal = null;
      ambiguityReason = pendingPaymentReviewContact
        ? "payment_review_contact_incomplete"
        : transactionReviewBlocked
          ? "transaction_review_incomplete"
          : "payment_review_boundary";
    } else if (adaptiveGoal) {
      // A verified reversible opener may reveal controls whose local labels no
      // longer repeat the parent profile field semantics. Preserve the exact
      // unfinished objective inside that one foreground surface instead of
      // erasing it and falling into a generic no-actuator stop.
      currentGoal = adaptiveGoal;
    } else if (profileGoal && (!foreground || foregroundOwnsProfileGoal)) {
      currentGoal = Object.freeze(profileGoal);
    } else if (profileReadiness.profileStage && !profileReadiness.ready && !profileGoal) {
      // An unresolved profile field with no executable actuator must not be
      // replaced by a navigation or unrelated surface goal. A fresh
      // observation will re-evaluate every temporarily blocked field.
      currentGoal = null;
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
        currentGoal = navigationGoal(observation, controlIds);
      } else if (!viableDecisionCapabilities.length && decisionCapabilities.length) {
        const blockedGoal = goalForDecision(decision, observation, userPolicy, traveler);
        currentGoal = Object.freeze({
          ...blockedGoal,
          ambiguity: Object.freeze({
            code: "NO_POLICY_ALLOWED_CANDIDATE",
            reason: "The current decision has executable options, but none matches the selected profile and safety policy."
          })
        });
        ambiguityReason = "no_policy_allowed_candidate";
      } else if (!decisionCapabilities.length && surfaceCapabilities.length) {
        currentGoal = null;
        ambiguityReason = "no_goal_relevant_candidate";
      } else {
        currentGoal = goalForDecision(decision, observation, userPolicy, traveler);
      }
    } else if (decisionEpisode?.status === "completed_pending_surface_exit") {
      currentGoal = completedChoiceSurfaceGoal(observation, decisionEpisode);
    } else if (validationBlockers.length) {
      currentGoal = null;
      ambiguityReason = "contradictory_or_validation_evidence";
    } else if (unblockedStageExitReady(page) && readyStageExitControlIds.length) {
      // Decisive stage invariant: after canonical profile/decision/validation
      // admission has produced no blocker, an exact executable stage exit is
      // the next task. Optional blank framework representations cannot outrank
      // it or manufacture a new semantic obligation.
      currentGoal = navigationGoal(observation, readyStageExitControlIds);
    } else if (controlIds.length && foreground && (
      ["review_confirmation", "warning", "navigation", "choice_set"].includes(surfaceClass)
      || (page.stageExit?.candidates || []).some((candidate) => controlIds.includes(candidate.controlId))
    )) {
      currentGoal = navigationGoal(observation, controlIds);
    } else if (foreground) {
      currentGoal = null;
      ambiguityReason = "unknown_foreground_surface";
    } else if (controlIds.length) {
      currentGoal = navigationGoal(observation, controlIds);
    } else if (
      page.stageExit?.continueObserved === true
      || (page.stageExit?.candidates || []).length > 0
    ) {
      currentGoal = null;
      ambiguityReason = page.stageExit?.continueDisabled === true
        ? "navigation_disabled_without_active_requirement"
        : "navigation_actuator_unavailable";
    } else {
      const currentCapabilities = (page.controls || []).filter((control) => controlBelongsToCurrentSurface(control, page));
      if (foreground || currentCapabilities.length) {
        currentGoal = null;
        ambiguityReason = foreground ? "unknown_foreground_surface" : "no_goal_relevant_candidate";
      }
    }
  }
  // Formal compilation remains the preferred path, but it is no longer a
  // prerequisite for one harmless reversible mechanic. When the task is
  // unfinished and no canonical goal survived, publish one bounded adaptive
  // interaction over exact current-surface actuators. The consequence
  // governor and fresh postcondition verification remain authoritative.
  const adaptiveFallbackReasons = new Set([
    "navigation_actuator_unavailable",
    "navigation_disabled_without_active_requirement",
    "no_goal_relevant_candidate",
    "unknown_foreground_surface"
  ]);
  if (
    terminalStatus === "active"
    && !currentGoal
    && adaptiveFallbackReasons.has(ambiguityReason)
    && !siteFailure
    && !validationBlockers.length
    && (!profileReadiness.profileStage || profileReadiness.ready === true)
    && !paymentReviewBoundary.observed
  ) {
    const fallback = adaptiveInteractionGoal({
      observation,
      userPolicy,
      traveler,
      reason: ambiguityReason
    });
    if (fallback) {
      currentGoal = fallback;
      ambiguityReason = "";
    }
  }
  // Candidate exhaustion is mechanical evidence, not authority for the loop
  // to replace semantic work. When the exact TaskState-published goal has
  // exhausted its grounded strategies, TaskState alone may yield to one
  // consequence-gated adaptive goal on the same fresh surface.
  const mechanicalEvidenceOwnsGoal = Boolean(
    mechanicalEvidence?.kind === "goal_strategies_exhausted"
    && (
      !mechanicalEvidence.observationHash
      || mechanicalEvidence.observationHash === (
        observation.observationSnapshot?.snapshotHash || page.snapshotHash || ""
      )
    )
    && (
      mechanicalEvidence.goalId === obligationField(currentGoal, "goalId")
      || (
        mechanicalEvidence.semanticGoalKey
        && mechanicalEvidence.semanticGoalKey === semanticGoalKey(currentGoal || {})
      )
      || (
        mechanicalEvidence.decisionGroupId
        && mechanicalEvidence.decisionGroupId === (
          obligationField(currentGoal, "decisionGroupId") || currentGoal?.subject?.decisionGroupId
        )
      )
    )
  );
  if (
    terminalStatus === "active"
    && currentGoal
    && mechanicalEvidenceOwnsGoal
    && !["profile_field", "adaptive_surface", "adaptive_interaction"].includes(obligationField(currentGoal, "kind"))
    && !["payment", "legal"].includes(obligationField(currentGoal, "semanticType"))
    && !siteFailure
    && !paymentReviewBoundary.observed
  ) {
    const fallback = adaptiveInteractionGoal({
      observation,
      userPolicy,
      traveler,
      reason: "canonical_goal_exhausted_without_observable_change",
      excludedControlIds: mechanicalEvidence.excludedControlIds || []
    });
    if (fallback) {
      currentGoal = fallback;
      ambiguityReason = "";
    }
  }
  const unresolvedGroundingControlIds = new Set(
    activeRequirementGrounding?.status !== "bound"
      ? (activeRequirementGrounding?.candidateComponentIds || []).map(clean).filter(Boolean)
      : []
  );
  const currentGoalFamily = lower(
    currentGoal?.canonicalSubject?.family
    || currentGoal?.subject?.family
    || obligationField(currentGoal, "family")
  );
  const groundingOwnsCurrentGoal = Boolean(
    currentGoal
    && currentGoalFamily === "profile"
    && (obligationField(currentGoal, "candidateControlIds") || admittedControlIdsForGoal(currentGoal))
      .some((controlId) => unresolvedGroundingControlIds.has(clean(controlId)))
  );
  if (groundingOwnsCurrentGoal) {
    // Unknown grounding may block only the exact profile obligation that
    // TaskState already admitted. It cannot make profile readiness false,
    // preempt a sibling decision, or veto navigation from page-wide context.
    currentGoal = Object.freeze({
      ...currentGoal,
      ambiguity: Object.freeze({
        code: "ACTIVE_REQUIREMENT_UNRESOLVED",
        reason: clean(activeRequirementGrounding.evidence || "The admitted profile component could not be bound to a supplied traveler fact.")
      })
    });
    ambiguityReason = "active_requirement_unresolved";
  }
  if (!decisionEpisode && obligationField(currentGoal, "decisionGroupId")) {
    const parent = canonicalDecisions.find((decision) => decision.decisionGroupId === obligationField(currentGoal, "decisionGroupId")) || null;
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
        intendedOutcome: clean(obligationField(currentGoal, "desiredSemanticOutcome") || obligationField(currentGoal, "desiredPolicyOutcome") || "selected_policy_allowed_option"),
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
  const surfaceSubgoal = createSurfaceSubgoal(previousTaskState, currentGoal, surface, surfaceClass, stageOutcome);
  if (currentGoal) {
    // An active episode can annotate only its exact parent decision (or its
    // proven close-child surface). Never copy it into the next sibling goal.
    const activeEpisode = decisionEpisode
      && !["completed", "blocked_cycle"].includes(decisionEpisode.status)
      && episodeOwnsGoal(decisionEpisode, currentGoal)
      ? decisionEpisode
      : null;
    currentGoal = Object.freeze({
      ...currentGoal,
      decisionInstanceId: activeEpisode?.decisionInstanceId || decisionInstanceKey(currentGoal, observation),
      canonicalOwnerId: activeEpisode?.canonicalOwnerId || activeEpisode?.decisionInstanceId || "",
      ...(activeEpisode
        ? {
            decisionEpisodeId: activeEpisode.episodeId,
            parentDecisionGroupId: activeEpisode.parentDecisionGroupId,
            parentExpectedSelectedControlId: activeEpisode.selectedControlId,
            decisionEpisodeStatus: activeEpisode.status
          }
        : {}),
      transactionOutcomeId: transactionOutcome.outcomeId,
      stageOutcomeId: stageOutcome.outcomeId,
      surfaceSubgoalId: surfaceSubgoal?.subgoalId || "",
      parentOutcomeContract: stageOutcome.outcomeContract,
      outcomeContract: surfaceSubgoal?.outcomeContract || outcomeContractForGoal(currentGoal, observation)
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
    ...(paymentReviewBoundary.observed ? (transactionReview?.missingFacts || []).map((fact) => `transaction:${clean(fact)}`) : []),
    ...(paymentReviewBoundary.observed ? (transactionReview?.contradictions || []).map((fact) => `contradiction:${clean(fact)}`) : [])
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
      stage: paymentReviewBoundary.observed ? "payment_review" : stage,
      surfaceId: clean(surface.id || "surface-page"),
      surfaceType: clean(surface.type || "page"),
      surfaceClass
    }),
    currentObjective: clean(
      obligationField(currentGoal, "semanticGoal")
      || (transactionReviewBlocked ? "verify the final transaction" : "reach verified payment review")
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

  const currentObligation = currentObligationFromGoal({
    goal: currentGoal,
    decisionFrame: authoritativeDecisionFrame
  });
  const situationNeedsReconciliation = Boolean(
    terminalStatus === "active"
    && !currentObligation
    && !siteFailure
    && !paymentReviewBoundary.observed
    && checkoutSituation.checkoutActive === true
    && (
      checkoutSituation.reconciliationRequired === true
      || (checkoutSituation.consequentialActions || []).length > 0
      || (
        !(checkoutSituation.obligations || []).length
        && !(checkoutSituation.navigationControlIds || []).length
      )
    )
  );
  const missingProfileFact = (profileReadiness.missingUserData || [])[0] || null;
  const missingDerivedFact = (profileReadiness.missingDerivedFacts || [])[0] || null;
  const authorizationConflict = activeDecisions.find((decision) => (
    decision.reopenEvidence?.code === "PAID_SELECTION_POLICY_AUTHORIZATION_CONFLICT"
  )) || null;
  const previousDisposition = previousTaskState.disposition || {};
  const admittedMechanicsExhausted = Boolean(
    mechanicalEvidenceOwnsGoal
    && currentGoal
    && (
      mechanicalEvidence.goalId === obligationField(currentGoal, "goalId")
      || mechanicalEvidence.semanticGoalKey === semanticGoalKey(currentGoal)
    )
  );
  const dispositionCode = clean(
    siteFailure ? "SITE_FAILURE_OBSERVED"
      : terminalStatus === "payment_review_reached" ? "PAYMENT_REVIEW_REACHED"
      : terminalStatus === "checkout_left" ? "CHECKOUT_LEFT"
      : transactionChangeRequiresApproval ? "TRANSACTION_CHANGE_REQUIRES_APPROVAL"
      : transactionReviewBlocked ? "TRANSACTION_REVIEW_INCOMPLETE"
      : authorizationConflict ? "PAID_SELECTION_POLICY_AUTHORIZATION_CONFLICT"
      : admittedMechanicsExhausted ? "STRATEGIES_EXHAUSTED"
      : obligationField(currentGoal, "ambiguity")?.code ? obligationField(currentGoal, "ambiguity").code
      : currentObligation ? "EXECUTE_CURRENT_OBLIGATION"
      : missingDerivedFact ? "SELECTED_BOOKING_FACT_MISSING"
      : missingProfileFact ? "MISSING_PROFILE_DATA"
      : validationBlockers.length ? "ACTIVE_VALIDATION_BLOCKER"
      : profileReadiness.blockedReasonCode ? profileReadiness.blockedReasonCode
      : situationNeedsReconciliation ? "SITUATION_RECONCILIATION_REQUIRED"
      : ambiguityReason ? ambiguityReason
      : "NO_CURRENT_OBLIGATION"
  );
  const sameReobserveDisposition = Boolean(
    previousDisposition.kind === "wait_reobserve"
    && previousDisposition.code === dispositionCode
    && previousDisposition.surfaceFingerprint === fingerprint
  );
  const reobserveNow = Date.now();
  const reobserveCount = sameReobserveDisposition
    ? Number(previousDisposition.reobserveCount || 0) + 1
    : 1;
  const reobserveStartedAt = sameReobserveDisposition
    ? Number(previousDisposition.reobserveStartedAt || reobserveNow)
    : reobserveNow;
  const reobserveDeadlineAt = sameReobserveDisposition
    ? Number(previousDisposition.reobserveDeadlineAt || (reobserveStartedAt + TASK_STATE_REOBSERVE_DEADLINE_MS))
    : reobserveStartedAt + TASK_STATE_REOBSERVE_DEADLINE_MS;
  const reobserveRetryToken = sameReobserveDisposition
    ? clean(previousDisposition.retryToken)
    : `reobserve_${stableSemanticToken(`${dispositionCode}:${fingerprint}`, 42)}_${reobserveStartedAt.toString(36)}`;
  const waitForEngineReconciliation = (reason) => reobserveDeadlineAt > reobserveNow
    ? {
        kind: "wait_reobserve",
        code: dispositionCode,
        reason,
        reobserveCount,
        retryToken: reobserveRetryToken,
        reobserveStartedAt,
        reobserveDeadlineAt,
        surfaceFingerprint: fingerprint,
        userActionRequired: false
      }
    : {
        kind: "stop",
        code: dispositionCode || "READINESS_DEADLINE_EXHAUSTED",
        reason: `${reason} The bounded engine reconciliation deadline was exhausted.`,
        reobserveCount,
        surfaceFingerprint: fingerprint,
        userActionRequired: false
      };
  let disposition;
  if (siteFailure) {
    disposition = {
      kind: "stop",
      code: dispositionCode,
      reason: clean(siteFailure.message || "The active checkout surface reports a site failure."),
      userActionRequired: false
    };
  } else if (terminalStatus === "payment_review_reached") {
    disposition = {
      kind: "terminal",
      code: dispositionCode,
      reason: "The approved transaction is reconciled at payment review.",
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
      reason: "The transaction visible at payment review materially conflicts with the approved booking mandate.",
      userActionRequired: true,
      details: Object.freeze({
        missingFacts: Object.freeze([...(transactionReview?.missingFacts || []), ...(outcomeCoverage.complete ? [] : ["verified_decision_outcomes"])]),
        contradictions: Object.freeze([...(transactionReview?.contradictions || [])])
      })
    };
  } else if (transactionReviewBlocked) {
    disposition = waitForEngineReconciliation(
      "Payment review is visible, but the engine has not yet reconciled every required transaction fact."
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
      obligationId: clean(obligationField(currentGoal, "goalId")),
      userActionRequired: false
    };
  } else if (obligationField(currentGoal, "ambiguity")) {
    disposition = waitForEngineReconciliation(
      clean(obligationField(currentGoal, "ambiguity").reason || "The current admitted checkout obligation requires engine reconciliation.")
    );
  } else if (currentObligation) {
    disposition = {
      kind: "execute",
      code: dispositionCode,
      reason: "Execute the exact current TaskState obligation.",
      obligationId: currentObligation.obligationId,
      userActionRequired: false
    };
  } else if (missingDerivedFact) {
    disposition = waitForEngineReconciliation(
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
    disposition = waitForEngineReconciliation(
      "The active checkout surface reports validation that is not yet owned by an executable obligation."
    );
  } else if (["ACTIVE_REQUIREMENT_UNRESOLVED", "SEMANTIC_AMBIGUITY", "active_requirement_unresolved", "contradictory_or_validation_evidence"].includes(dispositionCode)) {
    disposition = waitForEngineReconciliation(
      "The active checkout requirement is not yet resolved from the fresh evidence."
    );
  } else if (reobserveDeadlineAt > reobserveNow) {
    disposition = {
      kind: "wait_reobserve",
      code: dispositionCode,
      reason: "No executable obligation is proven yet; wait for a material mutation or the bounded deadline before stopping.",
      reobserveCount,
      retryToken: reobserveRetryToken,
      reobserveStartedAt,
      reobserveDeadlineAt,
      surfaceFingerprint: fingerprint,
      userActionRequired: false
    };
  } else {
    disposition = {
      kind: "stop",
      code: dispositionCode || "READINESS_DEADLINE_EXHAUSTED",
      reason: "The same settled surface produced no executable obligation after the bounded re-observation deadline.",
      reobserveCount,
      surfaceFingerprint: fingerprint,
      userActionRequired: false
    };
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
    checkoutSituation,
    profileReadiness,
    transactionReview: transactionReviewProjection,
    processAwareness
  });
  const taskState = Object.freeze({
    contractVersion: "task-state/v2",
    goal: Object.freeze({ id: "reach_payment_review", status: terminalGoalLatch.locked ? "completed" : "active" }),
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
      paymentCredentialsBlocked: true
    }),
    terminalGoalLatch,
    checkoutBoundary,
    stage,
    transactionOutcome,
    stageOutcome,
    surfaceSubgoal,
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
    clearObsoleteRecovery: Boolean(
      (previousTaskState.stageOutcome?.outcomeId
        && previousTaskState.stageOutcome.outcomeId !== stageOutcome.outcomeId)
      || stageOutcome.status === "completed"
    ),
    parentObjective: parentObjective || previousTaskState.parentObjective || null
  });
  taskStateReadModels.set(taskState, readModel);
  return taskState;
}

module.exports = {
  decideStage,
  durableOutcomeHierarchy,
  reconcileVerifiedProfileComponents,
  reduceDecisionFrame,
  taskStateReadModel,
  surfaceClassFrom,
  stageEvidence,
  verifiedCommerceObligationFromActionResult,
  verifiedProfileComponentFromActionResult
};
