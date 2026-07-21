const { diffObservations } = require("./observation-diff");
const { currentSurface } = require("./surface-contract");
const { normalizedActionSemantics, outcomeContractForGoal } = require("./action-semantics");
const { decideStage } = require("./task-state-reducer");

const UNSAFE_CODES = new Set([
  "ITINERARY_ROUTE_CHANGED",
  "ITINERARY_DATE_CHANGED",
  "ITINERARY_TIME_CHANGED",
  "ITINERARY_FLIGHT_CHANGED",
  "TRAVELER_CHANGED",
  "CURRENCY_CHANGED",
  "PRICE_INCREASE_REQUIRES_AUTHORIZATION",
  "PAYMENT_AUTHORIZATION_REQUIRED",
  "DUPLICATE_PAYMENT_ATTEMPT",
  "BLOCKED_BY_POLICY",
  "BLOCKED_BY_SAFETY"
]);

function text(value = "") {
  return String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function pageOf(observation = {}) {
  return observation?.page || {};
}

function controlById(page = {}, controlId = "") {
  return (page.controls || []).find((control) => control.controlId === controlId) || null;
}

function groupById(page = {}, groupId = "") {
  return (page.decisionGroups || []).find((group) => group.decisionGroupId === groupId || group.requirementId === groupId) || null;
}

function controlValue(control = {}) {
  const state = control.state || control.controlState || {};
  return text(state.normalizedValue || state.value || control.currentValue || "").replace(/\s+/g, "");
}

function selected(control = {}) {
  const state = control.state || control.controlState || {};
  return Boolean(control.selected || state.selected || state.checked);
}

function surfaceOf(page = {}) {
  return currentSurface(page);
}

function priceAmount(page = {}) {
  const amount = Number(page.price?.amount);
  return Number.isFinite(amount) ? amount : null;
}

function priceIncreased(beforePage = {}, afterPage = {}) {
  const before = priceAmount(beforePage);
  const after = priceAmount(afterPage);
  return before != null && after != null && after > before + 0.0001;
}

function meaningfulDiff(diff = {}) {
  return Boolean(
    diff.appeared?.length
    || diff.disappeared?.length
    || diff.changed?.length
    || diff.decisionChanges?.length
    || diff.becameEnabled?.length
    || diff.becameDisabled?.length
    || diff.modalOpened
    || diff.modalClosed
    || diff.errorsAppeared?.length
    || diff.errorsCleared?.length
    || diff.priceChanged
    || diff.stageChanged
    || diff.urlChanged
    || diff.progressChanged
    || diff.surfaceChanged
    || diff.targetReacted
  );
}

function expectedFor(governedAction = {}, browserResult = {}) {
  return governedAction.expectedOutcome || browserResult.expectedOutcome || {};
}

function exactFreeSelection(expected = {}, action = {}, beforePage = {}, afterPage = {}) {
  const groupId = expected.decisionGroupId || action.decisionGroupId || action.targetSnapshot?.decisionGroupId || "";
  const group = groupById(afterPage, groupId);
  const expectedControlId = expected.expectedSelectedControlId || expected.controlId || action.controlId || "";
  const chosen = controlById(afterPage, group?.selectedControlId || expectedControlId);
  const semantic = text(`${group?.selectedSemantic || ""} ${chosen?.semantic || ""} ${chosen?.risk || ""} ${chosen?.label || group?.selectedLabel || ""}`);
  const exact = Boolean(group && expectedControlId && group.selectedControlId === expectedControlId && selected(chosen || {}));
  const freeDisposition = /decline|free|no[_ -]?extra|no thanks|without|skip|none/.test(semantic)
    && !/purchase|premium|upgrade/.test(semantic);
  const paidSelected = (afterPage.controls || []).some((control) => (
    control.decisionGroupId === groupId
    && selected(control)
    && control.controlId !== expectedControlId
    && /paid|money|purchase|premium|upgrade/.test(text(`${control.risk || ""} ${control.semantic || ""} ${control.label || ""}`))
  ));
  const validation = (afterPage.validationIssues || []).some((issue) => (
    issue.stageWide === true
    || issue.controlId === expectedControlId
    || (group?.sectionId && issue.sectionId === group.sectionId)
  ));
  return {
    satisfied: exact && freeDisposition && !paidSelected && !priceIncreased(beforePage, afterPage) && !validation,
    evidence: { groupId, expectedControlId, selectedControlId: group?.selectedControlId || "", freeDisposition, paidSelected, validation }
  };
}

function evaluatePostcondition(expected = {}, action = {}, beforeObservation = {}, afterObservation = {}, diff = {}, browserResult = {}) {
  const beforePage = pageOf(beforeObservation);
  const afterPage = pageOf(afterObservation);
  const controlId = expected.controlId || action.controlId || action.targetSnapshot?.controlId || "";
  const beforeControl = controlById(beforePage, controlId);
  const afterControl = controlById(afterPage, controlId);
  const type = expected.type || "observable_change";
  const semantics = normalizedActionSemantics(action, { expectedOutcome: expected });

  if (type === "exact_free_option_selected") {
    const exact = exactFreeSelection(expected, action, beforePage, afterPage);
    const browserVerifiedBeforeDismissal = Boolean(
      !exact.satisfied
      && browserResult.verified === true
      && browserResult.expectedOutcome?.type === "exact_free_option_selected"
      && (diff.modalClosed || (diff.disappeared || []).some((item) => item.controlId === (expected.controlId || action.controlId)))
      && !priceIncreased(beforePage, afterPage)
      && !(diff.errorsAppeared || []).length
    );
    return {
      type,
      satisfied: exact.satisfied || browserVerifiedBeforeDismissal,
      evidence: { ...exact.evidence, browserVerifiedBeforeDismissal }
    };
  }
  if (type === "date_value_committed") {
    const codec = expected.dateCodec || afterControl?.dateField || {};
    const wantedCanonicalValue = String(expected.expectedCanonicalValue || "");
    const wantedComponentValue = String(expected.expectedNormalizedValue || "");
    const actualCanonicalValue = String(afterControl?.state?.canonicalDateValue || "");
    const actualComponentValue = String(afterControl?.state?.dateComponentValue || "");
    const validation = (afterPage.validationIssues || []).some((issue) => (
      issue.stageWide === true || (controlId && issue.controlId === controlId)
    ));
    const exact = codec.kind === "component"
      ? Boolean(wantedComponentValue && actualComponentValue === wantedComponentValue)
      : Boolean(wantedCanonicalValue && actualCanonicalValue === wantedCanonicalValue);
    return {
      type,
      satisfied: exact && !validation,
      evidence: {
        controlId,
        codec,
        wantedCanonicalValue,
        actualCanonicalValue,
        wantedComponentValue,
        actualComponentValue,
        validation
      }
    };
  }
  if (["normalized_value_changed", "field_value_changed"].includes(type)) {
    const wanted = text(expected.expectedNormalizedValue || expected.expectedValue || action.value || "").replace(/\s+/g, "");
    const actual = controlValue(afterControl || {});
    return { type, satisfied: Boolean(afterControl && wanted && actual === wanted), evidence: { controlId, wanted, actual } };
  }
  if (type === "control_selected") {
    const groupId = expected.decisionGroupId || action.decisionGroupId || afterControl?.decisionGroupId || "";
    const group = groupById(afterPage, groupId);
    const wanted = expected.expectedSelectedControlId || expected.controlId || action.controlId || "";
    const actual = group?.selectedControlId || (selected(afterControl || {}) ? afterControl?.controlId : "");
    return { type, satisfied: Boolean(wanted && actual === wanted), evidence: { groupId, wanted, actual } };
  }
  if (["options_surface_appeared", "active_surface_change", "semantic_progress"].includes(type)) {
    const expanded = afterControl?.state?.expanded === true && beforeControl?.state?.expanded !== true;
    const optionAppeared = (diff.appeared || []).some((item) => /option|choice|radio|menuitem/.test(text(item.role)));
    return { type, satisfied: Boolean(expanded || diff.modalOpened || optionAppeared || diff.surfaceChanged), evidence: { expanded, optionAppeared, modalOpened: diff.modalOpened } };
  }
  if (type === "active_surface_dismissed") {
    const expectedSurfaceId = expected.surfaceId || action.targetSnapshot?.surfaceId || surfaceOf(beforePage).id || "";
    const afterSurface = surfaceOf(afterPage);
    const gone = Boolean(diff.modalClosed || (expectedSurfaceId && afterSurface.id !== expectedSurfaceId));
    return { type, satisfied: gone, evidence: { expectedSurfaceId, currentSurfaceId: afterSurface.id || "", modalClosed: diff.modalClosed } };
  }
  if (type === "requirement_status") {
    const groupId = expected.requirementId || expected.decisionGroupId || action.decisionGroupId || "";
    const group = groupById(afterPage, groupId);
    return { type, satisfied: Boolean(group && group.status === (expected.status || "satisfied")), evidence: { groupId, status: group?.status || "" } };
  }
  if (type === "target_in_view") {
    const target = controlById(afterPage, expected.controlId || action.controlId || "");
    return { type, satisfied: Boolean(target && target.visualRegion?.inViewport === true), evidence: { controlId: target?.controlId || "", inViewport: target?.visualRegion?.inViewport === true } };
  }
  if (type === "stage_exit_or_feedback") {
    const satisfied = Boolean(diff.stageChanged || diff.urlChanged || diff.progressChanged || diff.modalOpened || diff.modalClosed || diff.errorsAppeared?.length || diff.surfaceChanged);
    return { type, satisfied, evidence: { stageChanged: diff.stageChanged, progressChanged: diff.progressChanged, modalOpened: diff.modalOpened, errorsAppeared: diff.errorsAppeared } };
  }
  if (type === "current_surface_advanced") {
    const advanced = Boolean(
      diff.progressChanged
      || diff.stageChanged
      || diff.urlChanged
      || (diff.surfaceChanged && !diff.modalOpened && !diff.modalClosed)
    );
    return {
      type,
      satisfied: advanced,
      evidence: {
        stageChanged: diff.stageChanged,
        urlChanged: diff.urlChanged,
        progressChanged: diff.progressChanged,
        surfaceChanged: diff.surfaceChanged,
        modalOpened: diff.modalOpened,
        modalClosed: diff.modalClosed
      }
    };
  }
  if (type === "checkout_stage_advanced") {
    const advanced = Boolean(diff.stageChanged || diff.urlChanged || diff.progressChanged);
    return {
      type,
      satisfied: advanced,
      evidence: {
        stageChanged: diff.stageChanged,
        urlChanged: diff.urlChanged,
        progressChanged: diff.progressChanged,
        modalOpened: diff.modalOpened,
        modalClosed: diff.modalClosed
      }
    };
  }
  if (["section_choice_verified", "observable_change"].includes(type)) {
    return { type, satisfied: meaningfulDiff(diff) && browserResult.dispatched === true, evidence: { targetReacted: diff.targetReacted } };
  }
  return {
    type,
    satisfied: Boolean(browserResult.verified === true && meaningfulDiff(diff)),
    evidence: { browserVerified: browserResult.verified === true, targetReacted: diff.targetReacted }
  };
}

function verifiedPhysicalResult(action = {}, postcondition = {}, diff = {}) {
  const predictedEffect = action.mechanicalEffect || action.affordance?.mechanicalEffect || action.affordance?.physicalEffect || action.affordance?.effect || action.physicalEffect || "unknown";
  if (diff.modalOpened) {
    return { effect: "open_surface", verified: true, evidence: { modalOpened: true } };
  }
  if (postcondition.satisfied && postcondition.type === "exact_free_option_selected") {
    return { effect: "select_free_option", verified: true, evidence: postcondition.evidence };
  }
  if (postcondition.satisfied && postcondition.type === "control_selected") {
    return { effect: predictedEffect === "select_paid_option" ? "select_paid_option" : predictedEffect, verified: true, evidence: postcondition.evidence };
  }
  if (postcondition.satisfied && ["normalized_value_changed", "field_value_changed", "date_value_committed"].includes(postcondition.type)) {
    return { effect: predictedEffect === "enter_payment_credentials" ? "enter_payment_credentials" : "set_field_value", verified: true, evidence: postcondition.evidence };
  }
  if (postcondition.satisfied && postcondition.type === "checkout_stage_advanced") {
    return { effect: "advance_checkout_stage", verified: true, evidence: postcondition.evidence };
  }
  if (postcondition.satisfied && postcondition.type === "current_surface_advanced") {
    return { effect: "advance_surface", verified: true, evidence: postcondition.evidence };
  }
  if (diff.modalClosed && !diff.stageChanged && !diff.urlChanged && !diff.progressChanged) {
    return { effect: "dismiss_surface", verified: true, evidence: { modalClosed: true } };
  }
  if (postcondition.satisfied) {
    return { effect: predictedEffect, verified: true, evidence: postcondition.evidence };
  }
  return { effect: meaningfulDiff(diff) ? "unknown" : predictedEffect, verified: false, evidence: postcondition.evidence || {} };
}

function currentObligationResultFor(action = {}, postcondition = {}, localMechanicalResult = {}, diff = {}) {
  const taskOutcome = action.affordance?.task?.outcomeContract?.taskOutcome || "";
  const compatibility = action.outcomeCompatibility || "unknown";
  const completed = postcondition.satisfied === true;
  const progress = !completed && (
    localMechanicalResult.verified === true
    || meaningfulDiff(diff)
  );
  return Object.freeze({
    outcomeId: action.affordance?.task?.surfaceSubgoalId || action.goalId || "",
    taskOutcome,
    status: completed ? "completed" : (progress ? "progress" : "no_progress"),
    completed,
    compatibility,
    evidence: Object.freeze({
      postconditionType: postcondition.type || "",
      postconditionSatisfied: postcondition.satisfied === true,
      mechanicalEffect: localMechanicalResult.effect || "unknown"
    })
  });
}

function blockerFrom(afterObservation = {}, diff = {}) {
  const page = pageOf(afterObservation);
  const surface = surfaceOf(page);
  if (diff.modalOpened || (surface.type && surface.type !== "page")) {
    return { type: "surface", surfaceId: surface.id || "", surfaceType: surface.type || "", label: surface.label || "" };
  }
  const issue = diff.errorsAppeared?.[0] || null;
  if (issue) return { type: "validation", controlId: issue.controlId || "", sectionId: issue.sectionId || "", label: issue.message || "" };
  return null;
}

function parentProgressFor(action = {}, afterObservation = {}, localEffect = {}, diff = {}) {
  const task = action.affordance?.task || {};
  const contract = task.parentOutcomeContract || task.outcomeContract || {};
  const outcomeId = task.stageOutcomeId || contract.outcomeId || task.transactionOutcomeId || "";
  const taskOutcome = contract.taskOutcome || "";
  const observedStage = decideStage(afterObservation).stage;
  const completed = taskOutcome === "payment_review_reached"
    ? observedStage === "payment"
    : taskOutcome === "booking_confirmed"
      ? observedStage === "confirmation"
      : false;
  const usefulLocalProgress = localEffect.verified === true;
  const usefulObservedProgress = meaningfulDiff(diff);
  return Object.freeze({
    outcomeId,
    taskOutcome,
    status: completed ? "completed" : (usefulLocalProgress || usefulObservedProgress ? "progress" : "no_progress"),
    completed,
    evidence: Object.freeze({ observedStage, stageChanged: diff.stageChanged, urlChanged: diff.urlChanged, progressChanged: diff.progressChanged })
  });
}

function evaluateTransition({ beforeObservation = null, governedAction = {}, browserResult = {}, afterObservation = {} } = {}) {
  const diff = diffObservations(beforeObservation, afterObservation);
  const expected = expectedFor(governedAction, browserResult);
  const code = String(browserResult.outcome?.code || browserResult.failureCode || browserResult.code || "");
  const beforePage = pageOf(beforeObservation || {});
  const afterPage = pageOf(afterObservation);
  const postcondition = evaluatePostcondition(expected, governedAction, beforeObservation || {}, afterObservation, diff, browserResult);
  const actionSemantics = normalizedActionSemantics(governedAction, { expectedOutcome: expected });
  const outcomeContract = governedAction.affordance?.task?.outcomeContract
    || outcomeContractForGoal(governedAction.goal || {}, beforeObservation || {});
  const localMechanicalResult = verifiedPhysicalResult(governedAction, postcondition, diff);
  const currentObligationResult = currentObligationResultFor(governedAction, postcondition, localMechanicalResult, diff);
  const durableObjectiveProgress = parentProgressFor(governedAction, afterObservation, localMechanicalResult, diff);
  const dispatched = browserResult.dispatched === true || browserResult.executed === true;
  let status;
  let nextDirective;
  if (UNSAFE_CODES.has(code) || (priceIncreased(beforePage, afterPage) && expected.mustNotIncreasePrice === true)) {
    status = "unsafe";
    nextDirective = "stop_or_request_approval";
  } else if (!beforeObservation?.observationId || !afterObservation?.observationId || !dispatched) {
    status = "uncertain";
    nextDirective = "reobserve_rebind";
  } else if (durableObjectiveProgress.completed) {
    status = "achieved";
    nextDirective = "advance_goal";
  } else if (meaningfulDiff(diff)) {
    status = "progressed";
    nextDirective = "rebuild_from_fresh_observation";
  } else if (dispatched) {
    status = "no_effect";
    nextDirective = "try_distinct_capability";
  } else {
    status = "uncertain";
    nextDirective = "reobserve_rebind";
  }

  return {
    status,
    diff,
    postcondition,
    nextDirective,
    blocker: status === "blocked" ? blockerFrom(afterObservation, diff) : null,
    authoritative: "browser_observation",
    beforeObservationId: beforeObservation?.observationId || "",
    afterObservationId: afterObservation?.observationId || "",
    actionId: browserResult.actionId || governedAction.id || "",
    interactionRole: actionSemantics.interactionRole,
    semanticEffect: actionSemantics.semanticEffect,
    expectedEvidence: actionSemantics.expectedEvidence,
    predictedMechanicalEffect: governedAction.mechanicalEffect || governedAction.affordance?.mechanicalEffect || governedAction.affordance?.physicalEffect || governedAction.affordance?.effect || governedAction.physicalEffect || "unknown",
    predictedPhysicalEffect: governedAction.mechanicalEffect || governedAction.affordance?.mechanicalEffect || governedAction.affordance?.physicalEffect || governedAction.affordance?.effect || governedAction.physicalEffect || "unknown",
    localMechanicalResult,
    currentObligationResult,
    durableObjectiveProgress,
    localEffect: localMechanicalResult,
    physicalResult: localMechanicalResult,
    parentProgress: durableObjectiveProgress,
    surfaceTaskOutcome: outcomeContract.taskOutcome,
    taskOutcome: durableObjectiveProgress.taskOutcome || outcomeContract.taskOutcome,
    taskOutcomeCompleted: durableObjectiveProgress.completed,
    completionAuthority: "task_state"
  };
}

module.exports = { currentObligationResultFor, evaluatePostcondition, evaluateTransition, meaningfulDiff, parentProgressFor, verifiedPhysicalResult };
