const { currentObligation } = require("../authority-frames");
const { obligationField } = require("../current-obligation");
const { controlBelongsToCurrentSurface } = require("../surface-contract");
const { actionPostconditions } = require("./action-result");
const {
  semanticOwnerFromLegacy,
  semanticOwnerId
} = require("../../../../packages/shared/semantic-owner");

const COMPLETED = new Set(["satisfied", "waived", "waived_by_policy"]);
const GOAL_CREATING = new Set(["active", "conflicted", "blocked"]);
const DECISION_EPISODE_FAMILIES = new Set(["fare", "baggage", "seat", "insurance", "extras"]);

function taskMechanics(taskState = {}) {
  return currentObligation(taskState) || {};
}

function clean(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function lower(value = "") {
  return clean(value).toLowerCase();
}

function decisionEpisodeSurfaceKey(surface = {}) {
  return [
    clean(surface.type || "page").toLowerCase(),
    clean(surface.surfaceClass || "unknown").toLowerCase(),
    lower(surface.label).slice(0, 120)
  ].join("|");
}

function episodeFamilyForDecision(decision = {}) {
  if (!decision || typeof decision !== "object") return "";
  const family = lower(decision.family || decision.subject?.family);
  return DECISION_EPISODE_FAMILIES.has(family) ? family : "";
}

function episodeSubjectKeyForDecision(decision = {}) {
  if (!decision || typeof decision !== "object") return "";
  const family = episodeFamilyForDecision(decision);
  const explicit = lower(decision.subject?.key || decision.requirementId);
  if (family === "seat") return "seat_assignment";
  if (family === "fare") return "ticket";
  return explicit || family;
}

function surfaceEpisodeFamily(surface = {}, canonicalDecisions = []) {
  const hinted = lower(`${surface.taskHint || ""} ${surface.parentSectionType || ""} ${surface.parentSectionLabel || ""} ${surface.label || ""}`);
  const hintedFamily = [...DECISION_EPISODE_FAMILIES].find((family) => (
    family === "extras"
      ? /extra|bundle|meal|priority|support|subscription|flexible/.test(hinted)
      : family === "baggage"
        ? /bag|baggage|luggage/.test(hinted)
        : family === "insurance"
          ? /insurance|protection|cover/.test(hinted)
          : new RegExp(`\\b${family}\\b`).test(hinted)
  ));
  if (hintedFamily) return hintedFamily;
  const ownedFamilies = [...new Set(canonicalDecisions
    .filter((decision) => (
      decision.surfaceId === surface.id
      || decision.decisionGroupId === surface.decisionGroupId
    ))
    .map(episodeFamilyForDecision)
    .filter(Boolean))];
  return ownedFamilies.length === 1 ? ownedFamilies[0] : "";
}

// One authoritative reader for the decision identity carried through
// candidate -> action -> browser result -> semantic verification. Browser
// transport may place the contract at different structural depths, but every
// consumer receives the same normalized lineage from here.
function actionDecisionLineage(result = null, fallbackGoal = {}, fallbackEpisode = {}) {
  if (!result || typeof result !== "object") return Object.freeze({
    explicit: false,
    explicitLineage: Object.freeze({
      decisionEpisodeId: "",
      decisionInstanceId: "",
      canonicalOwnerId: "",
      parentDecisionGroupId: "",
      decisionGroupId: "",
      requirementId: ""
    }),
    fallbackLineage: Object.freeze({
      decisionEpisodeId: "",
      decisionInstanceId: "",
      canonicalOwnerId: "",
      parentDecisionGroupId: "",
      decisionGroupId: "",
      requirementId: ""
    }),
    decisionEpisodeId: "",
    decisionInstanceId: "",
    canonicalOwnerId: "",
    parentDecisionGroupId: "",
    decisionGroupId: "",
    requirementId: ""
  });
  const action = result.action || {};
  const task = action.affordance?.task || {};
  const expected = result.expectedOutcome || action.expectedOutcome || action.affordance?.postcondition || {};
  const postcondition = (action.expectedPostconditions || task.expectedPostconditions || [])
    .find((entry) => entry && typeof entry === "object") || {};
  const explicitEpisodeId = clean(
    result.decisionEpisodeId
    || action.decisionEpisodeId
    || action.pipelineContract?.surfaceOwnership?.decisionEpisodeId
    || task.decisionEpisodeId
    || expected.decisionEpisodeId
    || postcondition.decisionEpisodeId
  );
  const explicitInstanceId = clean(
    result.decisionInstanceId
    || action.decisionInstanceId
    || task.decisionInstanceId
    || task.canonicalOwnerId
    || expected.decisionInstanceId
    || expected.canonicalOwnerId
    || postcondition.decisionInstanceId
    || postcondition.canonicalOwnerId
  );
  const explicitParentDecisionGroupId = clean(
    result.parentDecisionGroupId
    || action.parentDecisionGroupId
    || task.parentDecisionGroupId
    || expected.parentDecisionGroupId
    || postcondition.parentDecisionGroupId
  );
  const explicitDecisionGroupId = clean(
    result.decisionGroupId
    || action.decisionGroupId
    || task.decisionGroupId
    || expected.decisionGroupId
    || postcondition.decisionGroupId
  );
  const explicitRequirementId = clean(
    result.requirementId
    || action.requirementId
    || task.requirementId
    || expected.requirementId
    || postcondition.requirementId
  );
  const explicitLineage = Object.freeze({
    decisionEpisodeId: explicitEpisodeId,
    decisionInstanceId: explicitInstanceId,
    canonicalOwnerId: explicitInstanceId,
    parentDecisionGroupId: explicitParentDecisionGroupId,
    decisionGroupId: explicitDecisionGroupId,
    requirementId: explicitRequirementId
  });
  const fallbackInstanceId = clean(
    obligationField(fallbackGoal, "decisionInstanceId")
    || obligationField(fallbackGoal, "canonicalOwnerId")
    || fallbackEpisode.decisionInstanceId
    || fallbackEpisode.canonicalOwnerId
  );
  const fallbackLineage = Object.freeze({
    decisionEpisodeId: clean(obligationField(fallbackGoal, "decisionEpisodeId") || fallbackEpisode.episodeId),
    decisionInstanceId: fallbackInstanceId,
    canonicalOwnerId: fallbackInstanceId,
    parentDecisionGroupId: clean(obligationField(fallbackGoal, "parentDecisionGroupId") || fallbackEpisode.parentDecisionGroupId),
    decisionGroupId: clean(obligationField(fallbackGoal, "decisionGroupId") || fallbackEpisode.parentDecisionGroupId),
    requirementId: clean(obligationField(fallbackGoal, "requirementId") || fallbackEpisode.requirementId)
  });
  const decisionInstanceId = clean(
    explicitInstanceId
    || fallbackLineage.decisionInstanceId
  );
  return Object.freeze({
    explicit: Boolean(
      explicitEpisodeId
      || explicitInstanceId
      || explicitParentDecisionGroupId
      || explicitDecisionGroupId
    ),
    explicitLineage,
    fallbackLineage,
    decisionEpisodeId: clean(
      explicitEpisodeId
      || fallbackLineage.decisionEpisodeId
    ),
    decisionInstanceId,
    canonicalOwnerId: decisionInstanceId,
    parentDecisionGroupId: clean(
      explicitParentDecisionGroupId
      || fallbackLineage.parentDecisionGroupId
    ),
    decisionGroupId: clean(
      explicitDecisionGroupId
      || fallbackLineage.decisionGroupId
    ),
    requirementId: clean(
      explicitRequirementId
      || fallbackLineage.requirementId
    )
  });
}

// An episode belongs to one exact canonical decision. Family names and shared
// requirement labels (for example `contact:select-an-option`) describe a
// category, not ownership: a page can contain several independent extras.
function episodeOwnsDecision(episode = {}, decision = {}) {
  const parentDecisionGroupId = clean(episode.parentDecisionGroupId);
  const decisionGroupId = clean(decision.decisionGroupId || decision.completedDecisionGroupId);
  if (!parentDecisionGroupId || !decisionGroupId) return false;
  return parentDecisionGroupId === decisionGroupId;
}

function episodeOwnsGoal(episode = {}, goal = {}) {
  return episodeOwnsDecision(episode, goal)
    || clean(goal.parentDecisionGroupId) === clean(episode.parentDecisionGroupId)
    || clean(goal.completedDecisionGroupId) === clean(episode.parentDecisionGroupId)
    // A child confirmation is permitted only after the episode itself proved
    // that this foreground surface belongs to its exact parent decision.
    || (
      clean(episode.childSurfaceId)
      && clean(goal.surfaceId) === clean(episode.childSurfaceId)
    );
}

function verifiedActionSucceeded(result = null) {
  if (!result || result.dispatched === false) return false;
  const hasLocalOutcomeContract = [
    "localOutcomeVerified",
    "localExpectedOutcomeObserved",
    "localPostconditionSatisfied"
  ].some((key) => Object.prototype.hasOwnProperty.call(result, key));
  if (hasLocalOutcomeContract) {
    return Boolean(
      result.localOutcomeVerified === true
      && result.localExpectedOutcomeObserved !== false
      && result.localPostconditionSatisfied !== false
    );
  }
  return Boolean(
    result.verified === true
    && result.expectedOutcomeObserved !== false
    && result.postconditionSatisfied !== false
  );
}

function verifiedEpisodeAction(result = null, episode = {}) {
  if (!result || !episode?.episodeId) return false;
  const lineage = actionDecisionLineage(result);
  const action = result.action || {};
  const exactTargetControlId = clean(
    result.controlId
    || action.controlId
    || result.targetSnapshot?.controlId
    || action.targetSnapshot?.controlId
  );
  const exactPostconditionControlIds = actionPostconditions(result).flatMap((postcondition) => [
    postcondition.controlId,
    postcondition.expectedSelectedControlId,
    postcondition.parentExpectedSelectedControlId
  ]).map(clean).filter(Boolean);
  const belongs = lineage.decisionEpisodeId === clean(episode.episodeId)
    || lineage.decisionInstanceId === clean(episode.decisionInstanceId || episode.canonicalOwnerId)
    || lineage.parentDecisionGroupId === clean(episode.parentDecisionGroupId)
    || lineage.decisionGroupId === clean(episode.parentDecisionGroupId)
    // Some browser transports preserve the exact actuator but omit planning
    // lineage. Exact selected-control equality is still authoritative and is
    // safer than inheriting a generic episode/family fallback.
    || Boolean(exactTargetControlId && exactTargetControlId === clean(episode.selectedControlId))
    || exactPostconditionControlIds.includes(clean(episode.selectedControlId));
  return belongs && verifiedActionSucceeded(result);
}

function terminalEpisodeOutcome(episode = {}, parent = null) {
  const family = clean(episode.family || episodeFamilyForDecision(parent));
  const subjectKey = clean(episode.subjectKey || episodeSubjectKeyForDecision(parent));
  const decisionInstanceId = clean(
    episode.decisionInstanceId
    || episode.canonicalOwnerId
    || parent?.canonicalOwnerId
    || parent?.decisionGroupId
    || episode.parentDecisionGroupId
  );
  const paid = parent?.commitmentPhase === "committed_paid" || parent?.currentOutcome === "paid_affirmative";
  const declined = !paid && (
    episode.commitmentPhase === "confirmation_pending"
    || parent?.commitmentPhase === "declined_free"
    || /random|declin|without|skip/.test(lower(episode.intendedOutcome))
  );
  const semanticOwner = semanticOwnerFromLegacy(episode, {
    stage: episode.stage,
    family,
    subjectId: subjectKey,
    passengerId: episode.passengerId,
    segmentId: episode.segmentId,
    repeatedInstance: decisionInstanceId
  });
  const ownerId = semanticOwnerId(semanticOwner);
  return Object.freeze({
    semanticOwner,
    semanticOwnerId: ownerId,
    decisionGroupId: clean(parent?.decisionGroupId || episode.parentDecisionGroupId),
    // Legacy read-model projections are deterministically derived from the
    // sole durable semantic owner; they no longer invent parallel identity.
    decisionInstanceId: ownerId,
    decisionOwnerKey: ownerId,
    canonicalOwnerId: ownerId,
    originKind: "verified_commerce_decision",
    family,
    subjectKey,
    label: family === "seat" && declined ? "Random seat assignment" : clean(parent?.selectedLabel || episode.intendedOutcome),
    disposition: paid ? "paid" : declined ? "declined" : "selected",
    outcome: paid ? "paid_affirmative" : family === "seat" && declined ? "random_assignment" : declined ? "declined" : "selected",
    priceAmount: paid ? (parent?.priceRisk?.amount ?? null) : 0,
    currency: clean(parent?.priceRisk?.currency),
    segmentOutcomes: Object.freeze((Array.isArray(episode.segmentOutcomes) ? episode.segmentOutcomes : [])
      .filter((entry) => entry?.verified === true && entry?.segmentKey)
      .map((entry) => Object.freeze({
        segmentKey: clean(entry.segmentKey),
        outcome: clean(entry.outcome),
        verified: true
      }))),
    verified: episode.outcomeVerified === true
  });
}


function choiceDecisionEpisode({
  previousTaskState = {},
  previousActionResult = null,
  canonicalDecisions = [],
  observation = {},
  surface = {}
} = {}) {
  const page = observation.page || {};
  const previousRaw = previousTaskState.decisionEpisode || null;
  const lastAction = previousActionResult?.action || observation.lastActionResult?.action || null;
  const lastLineage = actionDecisionLineage(
    previousActionResult || observation.lastActionResult,
    taskMechanics(previousTaskState),
    previousRaw || {}
  );
  const previousParentDecisionGroupId = clean(previousRaw?.parentDecisionGroupId);
  const explicitLastLineage = lastLineage.explicitLineage || {};
  // A corrupted or stale episode can be carried in an action envelope. If
  // that action itself targets a different, page-owned decision, it is a
  // sibling decision, never evidence that the old episode continues.
  const lineageTargetsVisiblePageSibling = Boolean(
    previousRaw
    && lastLineage.decisionGroupId
    && clean(lastLineage.decisionGroupId) !== previousParentDecisionGroupId
    && surface.type === "page"
    && canonicalDecisions.some((decision) => (
      clean(decision.decisionGroupId) === clean(lastLineage.decisionGroupId)
      && clean(decision.surfaceId || "surface-page") === clean(surface.id || "surface-page")
    ))
  );
  const previousActionContinues = Boolean(previousRaw && (
    lastLineage.explicit === true
    && !lineageTargetsVisiblePageSibling
    && (
      clean(explicitLastLineage.decisionEpisodeId) === clean(previousRaw.episodeId)
      || clean(explicitLastLineage.decisionInstanceId) === clean(previousRaw.decisionInstanceId || previousRaw.canonicalOwnerId)
      || clean(explicitLastLineage.parentDecisionGroupId) === clean(previousRaw.parentDecisionGroupId)
      || clean(explicitLastLineage.decisionGroupId) === clean(previousRaw.parentDecisionGroupId)
    )
  ));
  const currentFamily = surfaceEpisodeFamily(surface, canonicalDecisions);
  const previousFamily = clean(previousRaw?.family);
  const previousOwnerVisible = Boolean(previousRaw && canonicalDecisions.some((decision) => (
    (
      clean(decision.canonicalOwnerId) === clean(previousRaw.decisionInstanceId || previousRaw.canonicalOwnerId)
      || clean(decision.decisionGroupId) === clean(previousRaw.parentDecisionGroupId)
    )
    && GOAL_CREATING.has(decision.status)
  )));
  // Family + presentation subject is not ownership. Several sibling products
  // may all be `extras / select_an_option`; only an exact owner or the action
  // that opened its child surface may continue the previous episode.
  const previous = previousRaw && (previousActionContinues || previousOwnerVisible)
    ? previousRaw
    : null;
  const previousParentId = clean(previous?.parentDecisionGroupId);
  const previousParent = previousParentId
    ? canonicalDecisions.find((decision) => decision.decisionGroupId === previousParentId) || null
    : null;
  const selectedOnCurrentChoiceSurface = surface.type !== "page" ? canonicalDecisions.find((decision) => (
    COMPLETED.has(decision.status)
    && decision.selectedControlId
    && (page.controls || []).some((control) => (
      control.controlId === decision.selectedControlId
      && controlBelongsToCurrentSurface(control, page)
    ))
  )) || null : null;
  const familyParent = currentFamily ? canonicalDecisions.find((decision) => (
    episodeFamilyForDecision(decision) === currentFamily
    && (
      decision.surfaceId === surface.id
      || decision.decisionGroupId === surface.decisionGroupId
    )
    && GOAL_CREATING.has(decision.status)
  )) || canonicalDecisions.find((decision) => (
    episodeFamilyForDecision(decision) === currentFamily
    && (
      decision.surfaceId === surface.id
      || decision.decisionGroupId === surface.decisionGroupId
    )
    && decision.currentState?.selected === true
  )) || (surface.type !== "page" ? canonicalDecisions.find((decision) => (
    episodeFamilyForDecision(decision) === currentFamily
    && decision.currentState?.selected === true
    && clean(decision.surfaceId || "surface-page") !== clean(surface.id)
  )) : null) || canonicalDecisions.find((decision) => (
    episodeFamilyForDecision(decision) === currentFamily
    && GOAL_CREATING.has(decision.status)
  )) || null : null;
  const parent = previousActionContinues
    ? (previousParent || null)
    : (selectedOnCurrentChoiceSurface || familyParent || previousParent);
  if (!parent && !previous && !currentFamily) return null;
  const family = episodeFamilyForDecision(parent) || currentFamily || previousFamily;
  if (!DECISION_EPISODE_FAMILIES.has(family)) return null;
  const subjectKey = family === "seat"
    ? "seat_assignment"
    : episodeSubjectKeyForDecision(parent) || clean(previous?.subjectKey) || family;
  const parentDecisionGroupId = clean(
    parent?.decisionGroupId
    || previousParentId
    || surface.decisionGroupId
    || `${family}:${subjectKey}`
  );
  const decisionInstanceId = clean(
    previous?.decisionInstanceId
    || previous?.canonicalOwnerId
    || parent?.canonicalOwnerId
    || parentDecisionGroupId
  );
  const intendedParentControlId = clean(
    previousParentId
    && lastLineage.decisionGroupId === previousParentId
    && previousActionResult?.dispatched !== false
      ? (
          lastAction?.controlId
          || previousActionResult?.controlId
          || previousActionResult?.targetSnapshot?.controlId
        )
      : ""
  );
  const selectedControlId = clean(
    parent?.selectedControlId || previous?.selectedControlId || intendedParentControlId
  );
  const parentCompleted = Boolean(parent && COMPLETED.has(parent.status) && selectedControlId);
  const previousActionVerified = verifiedEpisodeAction(previousActionResult || observation.lastActionResult, previous);
  if (previous && previous.commitmentPhase === "confirmation_pending" && previousActionVerified) {
    const completedEpisode = {
      ...previous,
      decisionInstanceId,
      canonicalOwnerId: decisionInstanceId,
      outcomeVerified: true
    };
    const terminalOutcome = terminalEpisodeOutcome(completedEpisode, parent);
    return Object.freeze({
      ...completedEpisode,
      parentStatus: "satisfied",
      status: "completed",
      commitmentPhase: terminalOutcome.disposition === "paid" ? "committed_paid" : "committed_free",
      terminalOutcome,
      observationId: observation.observationId || ""
    });
  }
  const currentSurfaceKey = decisionEpisodeSurfaceKey(surface);
  const previousPath = Array.isArray(previous?.surfacePath) ? previous.surfacePath : [];
  const childConfirmationActive = Boolean(
    previous
    && surface.type !== "page"
    && previousPath[previousPath.length - 1]
    && previousPath[previousPath.length - 1] !== currentSurfaceKey
    && canonicalDecisions.some((decision) => (
      episodeFamilyForDecision(decision) === family
      && episodeSubjectKeyForDecision(decision) === subjectKey
      && decision.surfaceId === surface.id
      && GOAL_CREATING.has(decision.status)
    ))
  );
  const committedParent = parentCompleted && !childConfirmationActive;
  const surfacePath = previousPath[previousPath.length - 1] === currentSurfaceKey
    ? previousPath
    : [...previousPath, currentSurfaceKey].slice(-8);
  const semanticOutcomeKey = [
    clean(parent?.status || previous?.parentStatus || "active"),
    selectedControlId,
    clean(parent?.completionReason || "")
  ].join("|");
  const revisitedWithoutProgress = Boolean(
    previous
    && previous.semanticOutcomeKey === semanticOutcomeKey
    && previousPath.slice(0, -1).includes(currentSurfaceKey)
  );
  const cycleCount = revisitedWithoutProgress
    ? Number(previous.cycleCount || 0) + 1
    : Number(previous?.cycleCount || 0);
  const expandedChoiceOpeners = committedParent
    ? (page.controls || []).filter((control) => (
        control.controlId !== selectedControlId
        && control.state?.expanded === true
        && /combobox|button/.test(`${control.role || ""} ${control.kind || ""}`.toLowerCase())
        && [control.operations?.open, control.operations?.activate].some((capability) => (
          capability?.actionability?.executable === true
        ))
      ))
    : [];
  const exactOwnedOpeners = expandedChoiceOpeners.filter((control) => (
    control.decisionGroupId === parentDecisionGroupId
  ));
  const surfaceExitControlIds = exactOwnedOpeners.length === 1
    ? [exactOwnedOpeners[0].controlId]
    // Some sites give the collapsed combobox and its portal/listbox separate
    // group IDs. A single expanded page-owned choice opener while its exact
    // dropdown is foreground is still authoritative ownership evidence.
    : expandedChoiceOpeners.length === 1
      ? [expandedChoiceOpeners[0].controlId]
      : [];
  const surfaceExitControl = surfaceExitControlIds.length === 1
    ? expandedChoiceOpeners.find((control) => control.controlId === surfaceExitControlIds[0]) || null
    : null;
  const pendingSurfaceExit = Boolean(
    committedParent
    && surface.type !== "page"
    && /dropdown|listbox|menu|choice/.test(`${surface.type || ""} ${surface.surfaceClass || ""}`.toLowerCase())
    && surfaceExitControlIds.length
  );
  const status = cycleCount >= 2 && !committedParent
    ? "blocked_cycle"
    : pendingSurfaceExit
      ? "completed_pending_surface_exit"
      : committedParent
        ? "completed"
        : (previous ? "awaiting_child_confirmation" : "active");
  const episodeId = clean(previous?.episodeId)
    || `${clean(observation.page?.step || "unknown")}:${decisionInstanceId}`;
  const progress = page.foreground?.progressMarkers
    || page.visualState?.foreground?.progressMarkers
    || {};
  const segmentKey = clean(progress.flightOrdinal || progress.route || progress.segment);
  const previousSegments = Array.isArray(previous?.segmentOutcomes) ? previous.segmentOutcomes : [];
  const segmentOutcomes = previous?.currentSegmentKey
    && previousActionVerified
    && !previousSegments.some((entry) => entry.segmentKey === previous.currentSegmentKey)
      ? [...previousSegments, Object.freeze({
          segmentKey: previous.currentSegmentKey,
          outcome: previous.commitmentPhase === "committed_paid" ? "selected_paid" : "unselected",
          verified: true
        })]
      : previousSegments;
  const confirmationPending = family === "seat"
    && surface.type !== "page"
    && !segmentKey
    && segmentOutcomes.length > 0
    && !committedParent;
  const commitmentPhase = confirmationPending
    ? "confirmation_pending"
    : committedParent
      ? (parent.commitmentPhase === "committed_paid" ? "committed_paid" : "declined_free")
      : "option_pending";
  const outcomeVerified = Boolean(previous?.outcomeVerified || (committedParent && previousActionVerified));
  const terminalOutcome = committedParent ? terminalEpisodeOutcome({
    ...(previous || {}),
    family,
    subjectKey,
    parentDecisionGroupId,
    decisionInstanceId,
    canonicalOwnerId: decisionInstanceId,
    commitmentPhase,
    outcomeVerified
  }, parent) : null;
  const surfaceExitOwnership = pendingSurfaceExit && surfaceExitControl ? Object.freeze({
    kind: "parent_controls_active_surface",
    status: "proven",
    observationId: observation.observationId || "",
    activeSurfaceId: surface.id || "",
    activeSurfaceType: surface.type || "",
    parentSurfaceId: clean(surfaceExitControl.surfaceId || "surface-page"),
    parentControlId: surfaceExitControl.controlId,
    decisionEpisodeId: episodeId,
    parentDecisionGroupId,
    proof: Object.freeze({
      completedChoice: true,
      uniqueExpandedOpener: expandedChoiceOpeners.length === 1,
      exactDecisionOwner: exactOwnedOpeners.length === 1,
      declaredParentMatch: !surface.parentControlId || surface.parentControlId === surfaceExitControl.controlId
    })
  }) : null;
  return Object.freeze({
    episodeId,
    decisionInstanceId,
    canonicalOwnerId: decisionInstanceId,
    originKind: "commerce_decision",
    family,
    subjectKey,
    parentDecisionGroupId,
    requirementId: clean(parent?.requirementId || previous?.requirementId),
    intendedOutcome: clean(previous?.intendedOutcome || "selected_policy_allowed_option"),
    selectedControlId,
    parentStatus: clean(parent?.status || previous?.parentStatus || "active"),
    status,
    commitmentPhase,
    outcomeVerified,
    terminalOutcome,
    semanticOutcomeKey,
    surfacePath: Object.freeze(surfacePath),
    childSurfaceId: childConfirmationActive ? clean(surface.id) : "",
    surfaceExitControlIds: Object.freeze(surfaceExitControlIds),
    surfaceExitOwnership,
    cycleCount,
    cycleDetected: status === "blocked_cycle",
    segmentOutcomes: Object.freeze(segmentOutcomes),
    currentSegmentKey: segmentKey,
    observationId: observation.observationId || ""
  });
}

module.exports = {
  actionDecisionLineage,
  choiceDecisionEpisode,
  decisionEpisodeSurfaceKey,
  episodeFamilyForDecision,
  episodeOwnsGoal,
  episodeSubjectKeyForDecision,
  terminalEpisodeOutcome,
  verifiedActionSucceeded,
  verifiedEpisodeAction
};

