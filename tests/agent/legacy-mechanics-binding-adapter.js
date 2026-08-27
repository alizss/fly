// Historical replay adapter for fixtures that still construct goal-shaped
// inputs. Production binding accepts only CurrentObligation.
const {
  compileDecisionFrame,
  DECISION_FRAME_VERSION
} = require("../../apps/web/agent/authority-frames");
const {
  compileCurrentObligation,
  legacyWorkForObligation
} = require("./obligation-test-helper");
const { rawObservationCandidates: bindRawObservationCandidates } = require("../../apps/web/agent/observation-candidates");
const { allRequiredDecisionGroupsResolved } = require("../../apps/web/agent/observation-candidates");
const {
  actionForCurrentCandidate: bindActionForCurrentCandidate,
  bindMechanics
} = require("../../apps/web/agent/mechanics-binder");
const {
  candidatesForProfileGoal: bindProfileCandidates,
  profileGoalSatisfied: verifyProfileObligation
} = require("../../apps/web/agent/profile-mechanics");
const { fieldDescriptors } = require("../../apps/web/agent/profile-requirements");

function canonicalObservation(observation = {}) {
  const controls = observation.page?.controls || [];
  if (controls.length && controls.every((control) => control.semanticAuthority === DECISION_FRAME_VERSION)) {
    return observation;
  }
  return compileDecisionFrame({ observation }).observation;
}

function canonicalFrame(observation = {}, traveler = {}) {
  const frame = compileDecisionFrame({ observation, traveler });
  return {
    decisionFrame: frame,
    observation: frame.observation
  };
}

function profileMechanicsGoal(goal = {}) {
  const source = legacyWorkForObligation(goal) || goal;
  if (!source || typeof source !== "object") return source;
  return {
    ...source,
    id: source.id || source.goalId || "",
    desiredStateDelta: source.desiredStateDelta || {
      contractVersion: "desired-state-delta/v1",
      status: "EXACT_DELTA",
      actionRequired: true,
      kind: source.kind || "profile_field",
      desiredValue: source.desiredValue || source.expectedNormalizedValue || ""
    },
    successCondition: source.successCondition || source.postcondition || source.expectedOutcome || null
  };
}

function legacyAdmittedControlIds(goal = {}, observation = {}) {
  goal = goal || {};
  const explicit = [
    ...(goal.admittedControlIds || []),
    ...(goal.actionableControlIds || []),
    ...(goal.candidateControlIds || []),
    ...(goal.eligibleAlternativeControlIds || []),
    ...(goal.policyAllowedControlIds || [])
  ].filter(Boolean);
  if (explicit.length) return [...new Set(explicit)];

  const page = observation.page || {};
  const controls = page.controls || [];
  const groupId = String(goal.decisionGroupId || "");
  if (groupId) {
    const group = (page.decisionGroups || []).find((item) => item.decisionGroupId === groupId) || null;
    const groupIds = [
      ...(group?.alternativeControlIds || []),
      ...(group?.alternatives || []).map((option) => option.controlId),
      ...controls.filter((control) => control.decisionGroupId === groupId).map((control) => control.controlId)
    ].filter(Boolean);
    return [...new Set(groupIds)];
  }

  if (String(goal.semanticType || "") === "navigation") {
    if (!allRequiredDecisionGroupsResolved(page)) return [];
    return controls.filter((control) => (
      control.physicalEffect === "advance_checkout_stage"
      || /^(?:navigation|continue|next|proceed|advance)$/.test(String(control.semantic || "").toLowerCase())
    )).map((control) => control.controlId).filter(Boolean);
  }
  return [];
}

function obligationForLegacyGoal(goal = {}, observation = {}, decisionFrame = null) {
  goal = goal || {};
  if (goal?.contractVersion === "current-obligation/v3") return goal;
  const decidedObservation = canonicalObservation(observation);
  const discoveredControlIds = legacyAdmittedControlIds(goal, decidedObservation);
  return compileCurrentObligation({ work: {
      ...goal,
      candidateControlIds: goal.candidateControlIds?.length
        ? goal.candidateControlIds
        : discoveredControlIds
    },
    decisionFrame
  });
}

function rawObservationCandidates(observation = {}, goal = {}) {
  const { decisionFrame, observation: decidedObservation } = canonicalFrame(observation);
  const obligation = obligationForLegacyGoal(goal, decidedObservation, decisionFrame);
  if (!obligation || !(obligation.admittedControlIds || []).length) return [];
  return bindMechanics({
    obligation,
    decisionFrame,
    observation: decidedObservation,
    traveler: {},
    state: {},
    approvals: {},
    attemptedCandidateIds: [],
    attemptedStrategySignatures: []
  }).candidates;
}

function actionForCurrentCandidate(goal = {}, candidate = {}, observation = {}) {
  return bindActionForCurrentCandidate(obligationForLegacyGoal(goal, observation), candidate, observation);
}

function actionForObservationCandidate(goal = {}, candidate = {}, observation = {}) {
  return bindActionForCurrentCandidate(obligationForLegacyGoal(goal, observation), candidate, observation);
}

function buildCurrentCandidateSet({
  goal = {},
  obligation = null,
  observation = {},
  traveler = {},
  state = {},
  approvals = {},
  attemptedCandidateIds = [],
  attemptedStrategySignatures = []
} = {}) {
  const existingObligation = obligation || state.taskState?.currentObligation || null;
  const decidedObservation = canonicalObservation(observation);
  const decisionFrame = existingObligation
    ? {
        contractVersion: DECISION_FRAME_VERSION,
        frameId: existingObligation.decisionFrameId,
        observationId: decidedObservation.observationId || "",
        observation: decidedObservation,
        profileRequirements: fieldDescriptors(decidedObservation, traveler)
      }
    : canonicalFrame(observation, traveler).decisionFrame;
  const selectedObligation = existingObligation
    || obligationForLegacyGoal(goal, decisionFrame.observation, decisionFrame);
  return bindMechanics({
    obligation: selectedObligation,
    decisionFrame,
    observation: decisionFrame.observation,
    traveler,
    state,
    approvals,
    attemptedCandidateIds,
    attemptedStrategySignatures
  });
}

function groundedObservationCandidateSet(goal = {}, observation = {}, attemptedStrategySignatures = [], context = {}) {
  // Historical replays still pass a goal projection. Recompile the complete
  // DecisionFrame at this boundary so production binding receives the same
  // sole semantic authority it receives in the real loop. Passing only the
  // decided observation here discarded profile requirements and forced the
  // mechanics binder to reconstruct meaning from controls.
  const { decisionFrame, observation: decidedObservation } = canonicalFrame(
    observation,
    context.traveler || {}
  );
  const obligation = obligationForLegacyGoal(goal, decidedObservation, decisionFrame);
  const { __private } = require("../../apps/web/agent/loop");
  return __private.groundedObservationCandidateSet(
    obligation,
    decisionFrame,
    decidedObservation,
    attemptedStrategySignatures,
    context
  );
}

function candidatesForProfileGoal(goal = {}, observation = {}, traveler = {}, attemptedCandidateIds = [], options = {}) {
  const decidedObservation = canonicalObservation(observation);
  const resolvedGoal = profileMechanicsGoal(goal);
  return bindProfileCandidates(
    resolvedGoal,
    decidedObservation,
    traveler,
    attemptedCandidateIds,
    options
  );
}

function profileGoalSatisfied(goal = {}, observation = {}, traveler = {}) {
  const decidedObservation = canonicalObservation(observation);
  return verifyProfileObligation(profileMechanicsGoal(goal), decidedObservation, traveler);
}

module.exports = {
  actionForCurrentCandidate,
  actionForObservationCandidate,
  bindMechanics,
  buildCurrentCandidateSet,
  candidatesForProfileGoal,
  groundedObservationCandidateSet,
  profileGoalSatisfied,
  rawObservationCandidates
};
