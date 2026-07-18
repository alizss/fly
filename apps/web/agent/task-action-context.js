const { deriveObservationGoal } = require("./observation-candidates");
const { currentSurface } = require("./surface-contract");

const RESOLVED = new Set(["satisfied", "waived", "waived_by_policy"]);

function normalized(value = "") {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function semanticFamily(value = {}) {
  const text = normalized([
    value.semanticFamily,
    value.semanticType,
    value.type,
    value.semanticGoal,
    value.label,
    value.sectionType,
    value.sectionLabel,
    value.requirementId
  ].filter(Boolean).join(" "));
  if (/seat/.test(text)) return "seat";
  if (/bag|baggage|luggage/.test(text)) return "baggage";
  if (/flexible.?ticket/.test(text)) return "flexible_ticket";
  if (/bundle|support|sms/.test(text)) return "bundle";
  if (/insurance|cancellation|protection/.test(text)) return "protection";
  if (/extra|add.?on/.test(text)) return "paid_extra";
  if (/payment|pay|card/.test(text)) return "payment";
  if (/traveler|passenger|profile|contact/.test(text)) return "profile";
  if (/continue|navigation|advance|next/.test(text)) return "navigation";
  return "unknown";
}

function declinePolicyApplies(traveler = {}, state = {}, family = "unknown") {
  if (!["seat", "baggage", "flexible_ticket", "bundle", "protection", "paid_extra"].includes(family)) return false;
  const text = normalized([
    traveler.booking_rules,
    traveler.baggage_preference,
    state.goal,
    state.userPolicy?.bookingRules,
    state.userPolicy?.extras
  ].filter(Boolean).join(" "));
  return /no paid|no extras|no add.?ons|no seat|no insurance|no bundle|avoid paid|personal item only|no checked|no bag|no baggage/.test(text)
    || state.approvals?.skipPaidExtrasApproved === true;
}

function requirementForGoal(requirements = [], goal = {}) {
  const ids = new Set([goal.requirementId, goal.decisionGroupId].filter(Boolean));
  return requirements.find((item) => ids.has(item.id) || ids.has(item.requirementId) || ids.has(item.decisionGroupId)) || null;
}

function selectedPaidContradiction(observation = {}, goal = {}, family = "unknown") {
  const page = observation.page || {};
  const exactGroupId = exactDecisionGroupId(goal);
  const group = (page.decisionGroups || []).find((item) => (
    exactGroupId
      ? String(item.decisionGroupId || item.requirementId || "") === exactGroupId
      : (item.selectedControlId && semanticFamily(item) === family)
  ));
  if (!group?.selectedControlId) return null;
  const selected = (page.controls || []).find((control) => control.controlId === group.selectedControlId)
    || (group.alternatives || []).find((choice) => choice.controlId === group.selectedControlId)
    || {};
  const amount = Number(selected.structuredPrice?.amount);
  const paid = (Number.isFinite(amount) && amount > 0)
    || /money|paid|purchase|premium|upgrade|add_paid/.test(normalized(`${selected.risk || ""} ${selected.semantic || ""}`));
  return paid ? {
    code: "PAID_OPTION_SELECTED",
    decisionGroupId: group.decisionGroupId || "",
    requirementId: group.requirementId || group.decisionGroupId || "",
    sectionId: group.sectionId || "",
    sectionType: group.sectionType || "",
    sectionLabel: group.sectionLabel || "",
    surfaceId: group.surfaceId || "",
    controlId: group.selectedControlId,
    label: selected.label || group.selectedLabel || ""
  } : null;
}

function exactDecisionGroupId(goal = {}) {
  return String(goal.decisionGroupId || goal.requirementId || "");
}

function previousResolvedOutcome(state = {}, family = "unknown", goal = {}) {
  const groupId = exactDecisionGroupId(goal);
  if (!groupId) return null;
  const previous = state.currentObligation?.userOutcome;
  if (previous
    && previous.semanticFamily === family
    && String(previous.decisionGroupId || previous.requirementId || "") === groupId
    && RESOLVED.has(previous.status)) return previous;
  const lifecycleOutcome = (state.requirementLifecycle || []).find((item) => (
    semanticFamily(item) === family
    && String(item.decisionGroupId || item.requirementId || item.id || "") === groupId
    && (item.desiredDisposition === "decline" || item.status === "waived_by_policy")
    && RESOLVED.has(item.lifecycleStatus || item.status)
  )) || null;
  if (lifecycleOutcome) return lifecycleOutcome;
  return (state.decisionCompletions || []).find((item) => (
    String(item.decisionGroupId || item.requirementId || "") === groupId
    && RESOLVED.has(item.status)
  )) || null;
}

function transitionResolvedOutcome(state = {}, transition = null, family = "unknown", goal = {}) {
  if (transition?.status !== "achieved") return false;
  const groupId = exactDecisionGroupId(goal);
  if (!groupId) return false;
  const previousFamily = state.currentObligation?.userOutcome?.semanticFamily
    || semanticFamily(state.currentGoal || {});
  if (previousFamily !== family) return false;
  const action = state.lastAction || {};
  const actionGroupId = String(action.decisionGroupId || action.requirementId || action.expectedOutcome?.decisionGroupId || "");
  if (actionGroupId !== groupId) return false;
  return action.semanticEffect === "waive"
    || ["select_free_option", "skip_current_item", "dismiss_surface"].includes(action.affordance?.effect)
    || action.expectedOutcome?.expectedDisposition === "decline_free_no_extra";
}

function nextGoalAfterExactOutcome(observation = {}, requirements = [], completedDecisionGroupId = "") {
  if (!completedDecisionGroupId) return deriveObservationGoal(observation, requirements);
  const page = observation.page || {};
  const adjustedObservation = {
    ...observation,
    page: {
      ...page,
      decisionGroups: (page.decisionGroups || []).map((group) => (
        group.decisionGroupId === completedDecisionGroupId
          ? { ...group, status: RESOLVED.has(group.status) ? group.status : "waived_by_policy" }
          : group
      ))
    }
  };
  return deriveObservationGoal(adjustedObservation, requirements);
}

function navigationGoal(observation = {}, family = "unknown", completedDecisionGroupId = "") {
  const observationId = observation.observationId || "observation";
  const surface = currentSurface(observation.page || {});
  return {
    goalId: `${observationId}:goal:advance_${family}`,
    semanticGoal: `advance checkout after the ${family === "unknown" ? "current" : family} outcome was satisfied`,
    semanticType: "navigation",
    desiredValue: "next_stage",
    decisionGroupId: "",
    requirementId: "",
    sectionId: "",
    sectionType: "",
    sectionLabel: "",
    surfaceId: surface.id || "",
    observationId,
    completedDecisionGroupId,
    postcondition: { type: "stage_exit_or_feedback" }
  };
}

function deriveAuthoritativeTaskContext({
  state = {},
  observation = {},
  requirements = [],
  traveler = {},
  transition = null
} = {}) {
  const observedGoal = deriveObservationGoal(observation, requirements);
  const surface = currentSurface(observation.page || {});
  const observedRequirement = requirementForGoal(requirements, observedGoal);
  const family = semanticFamily({
    ...observedGoal,
    label: `${observedGoal.sectionLabel || ""} ${surface.label || ""}`
  });
  const declineByPolicy = declinePolicyApplies(traveler, state, family);
  const contradiction = declineByPolicy ? selectedPaidContradiction(observation, observedGoal, family) : null;
  const previouslyResolved = declineByPolicy ? previousResolvedOutcome(state, family, observedGoal) : null;
  const observedGroup = (observation.page?.decisionGroups || []).find((group) => (
    group.decisionGroupId === observedGoal.decisionGroupId
    || group.requirementId === observedGoal.requirementId
  )) || null;
  const browserResolved = RESOLVED.has(observedRequirement?.status)
    || Boolean(observedGroup && RESOLVED.has(observedGroup.status));
  const transitionResolved = declineByPolicy && transitionResolvedOutcome(state, transition, family, observedGoal);
  const outcomeSatisfied = !contradiction && (browserResolved || Boolean(previouslyResolved) || transitionResolved);
  const completedDecisionGroupId = outcomeSatisfied
    ? String(previouslyResolved?.decisionGroupId || previouslyResolved?.requirementId || observedGoal.decisionGroupId || observedGoal.requirementId || "")
    : "";
  const userOutcome = {
    semanticFamily: family,
    desiredDisposition: declineByPolicy ? "decline_paid" : "complete_required_outcome",
    status: contradiction ? "contradicted" : (outcomeSatisfied ? "satisfied" : "pending"),
    satisfiedBy: browserResolved ? "browser" : (transitionResolved ? "verified_transition" : (previouslyResolved ? "persisted_browser_evidence" : "")),
    decisionGroupId: completedDecisionGroupId,
    requirementId: observedGroup?.requirementId || observedGoal.requirementId || completedDecisionGroupId,
    surfaceId: observedGroup?.surfaceId || observedGoal.surfaceId || surface.id || "",
    selectedControlId: observedGroup?.selectedControlId || previouslyResolved?.selectedControlId || "",
    observationId: observation.observationId || "",
    contradiction,
    evidence: [
      browserResolved ? "Current browser evidence resolves the outcome." : "",
      transitionResolved ? "The authoritative transition verified the outcome." : "",
      previouslyResolved ? "A prior browser-verified outcome remains authoritative." : ""
    ].filter(Boolean)
  };
  const nextObservedGoal = outcomeSatisfied
    ? nextGoalAfterExactOutcome(observation, requirements, completedDecisionGroupId)
    : observedGoal;
  const remainingGoal = contradiction
    ? {
        ...observedGoal,
        goalId: `${observation.observationId || "observation"}:goal:resolve_${family}_contradiction`,
        semanticGoal: `restore the saved no-paid ${family} outcome`,
        semanticType: contradiction.sectionType || `${family}_decision`,
        desiredValue: "free_or_no_extra",
        decisionGroupId: contradiction.decisionGroupId,
        requirementId: contradiction.requirementId,
        sectionId: contradiction.sectionId,
        sectionType: contradiction.sectionType,
        sectionLabel: contradiction.sectionLabel,
        surfaceId: contradiction.surfaceId,
        postcondition: {
          type: "requirement_status",
          requirementId: contradiction.requirementId,
          status: "satisfied"
        }
      }
    : outcomeSatisfied && nextObservedGoal.decisionGroupId
      ? nextObservedGoal
      : outcomeSatisfied
        ? navigationGoal(observation, family, completedDecisionGroupId)
        : observedGoal;
  return Object.freeze({
    obligationId: `obligation:${family}:${completedDecisionGroupId || observedGoal.decisionGroupId || "current"}:${state.id || "session"}`,
    observationId: observation.observationId || "",
    userOutcome: Object.freeze(userOutcome),
    interfaceStatus: Object.freeze({
      status: outcomeSatisfied ? "needs_advance" : "resolve_current_outcome",
      surfaceId: surface.id || "",
      surfaceType: surface.type || "page",
      blocksBackground: surface.blocksBackground === true
    }),
    remainingGoal: Object.freeze(remainingGoal),
    classifierEvidence: Object.freeze([])
  });
}

function withClassifierEvidence(context = {}, classification = {}) {
  const evidence = [classification.summary, ...(classification.uncertainties || [])].filter(Boolean).map(String).slice(0, 8);
  return Object.freeze({ ...context, classifierEvidence: Object.freeze(evidence) });
}

function contextForPublishedGoal({ state = {}, observation = {}, goal = {} } = {}) {
  const surface = currentSurface(observation.page || {});
  const family = semanticFamily(goal);
  return Object.freeze({
    obligationId: `obligation:${family}:${state.id || "session"}`,
    observationId: observation.observationId || "",
    userOutcome: Object.freeze({
      semanticFamily: family,
      desiredDisposition: goal.desiredValue || "satisfied",
      status: "pending",
      satisfiedBy: "",
      decisionGroupId: goal.decisionGroupId || "",
      contradiction: null,
      evidence: []
    }),
    interfaceStatus: Object.freeze({
      status: "resolve_current_outcome",
      surfaceId: surface.id || "",
      surfaceType: surface.type || "page",
      blocksBackground: surface.blocksBackground === true
    }),
    remainingGoal: Object.freeze(goal),
    classifierEvidence: Object.freeze([])
  });
}

function applyAuthoritativeOutcomeToRequirements(requirements = [], context = {}) {
  const outcome = context.userOutcome || {};
  if (outcome.status !== "satisfied" || outcome.desiredDisposition !== "decline_paid") return requirements;
  const completedDecisionGroupId = String(outcome.decisionGroupId || outcome.requirementId || "");
  if (!completedDecisionGroupId) return requirements;
  return (requirements || []).map((requirement) => {
    const requirementGroupId = String(requirement.decisionGroupId || requirement.requirementId || requirement.id || "");
    if (requirementGroupId !== completedDecisionGroupId || RESOLVED.has(requirement.status)) return requirement;
    return {
      ...requirement,
      status: "waived_by_policy",
      lifecycleStatus: "waived_by_policy",
      interfaceStatus: "complete",
      confidence: Math.max(Number(requirement.confidence || 0), 0.95),
      evidence: [
        "AUTHORITATIVE_OUTCOME_PRESERVED: prior browser-verified policy outcome remains satisfied.",
        ...(requirement.evidence || [])
      ].slice(0, 5)
    };
  });
}

module.exports = {
  applyAuthoritativeOutcomeToRequirements,
  deriveAuthoritativeTaskContext,
  contextForPublishedGoal,
  semanticFamily,
  nextGoalAfterExactOutcome,
  withClassifierEvidence
};
