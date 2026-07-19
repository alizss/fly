const { diffObservations } = require("./observation-diff");
const { currentSurface } = require("./surface-contract");
const { normalizedActionSemantics } = require("./action-semantics");

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

function fulfilledStatus(status = "") {
  return ["satisfied", "waived", "waived_by_policy"].includes(String(status || ""));
}

function commandAcknowledged(expected = {}, action = {}, beforePage = {}, afterPage = {}, diff = {}) {
  const groupId = expected.decisionGroupId || expected.requirementId || action.decisionGroupId || action.requirementId || "";
  const beforeGroup = groupById(beforePage, groupId);
  const afterGroup = groupById(afterPage, groupId);
  const acceptedStatuses = new Set(expected.acceptedRequirementStatuses || [expected.expectedRequirementStatus || "satisfied"]);
  const groupResolved = Boolean(afterGroup && (acceptedStatuses.has(afterGroup.status) || fulfilledStatus(afterGroup.status)));
  const previousSurfaceId = expected.previousSurfaceId || expected.surfaceId || action.targetSnapshot?.surfaceId || surfaceOf(beforePage).id || "";
  const afterSurfaceId = surfaceOf(afterPage).id || "";
  const surfaceChanged = Boolean(diff.modalClosed || diff.surfaceChanged || (previousSurfaceId && previousSurfaceId !== afterSurfaceId));
  const targetDisappeared = (diff.disappeared || []).some((item) => item.controlId === (expected.controlId || action.controlId));
  const prerequisiteCleared = Boolean(beforeGroup && !afterGroup && (surfaceChanged || diff.stageChanged || diff.progressChanged || diff.urlChanged));
  const targetReacted = diff.targetReacted === true;
  const acknowledged = groupResolved || surfaceChanged || prerequisiteCleared || targetDisappeared || targetReacted;
  return {
    satisfied: acknowledged,
    evidence: {
      groupId,
      beforeStatus: beforeGroup?.status || "",
      afterStatus: afterGroup?.status || "",
      resolutionStatus: groupResolved && action.semanticEffect === "waive" ? "waived_by_policy" : (afterGroup?.status || ""),
      surfaceChanged,
      prerequisiteCleared,
      targetDisappeared,
      targetReacted
    }
  };
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

  if (semantics.interactionRole === "command" || type === "command_acknowledged") {
    const acknowledged = commandAcknowledged(expected, action, beforePage, afterPage, diff);
    return { type: "command_acknowledged", satisfied: acknowledged.satisfied, evidence: acknowledged.evidence };
  }

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
  if (["section_choice_verified", "observable_change"].includes(type)) {
    return { type, satisfied: meaningfulDiff(diff) && browserResult.dispatched === true, evidence: { targetReacted: diff.targetReacted } };
  }
  return {
    type,
    satisfied: Boolean(browserResult.verified === true && meaningfulDiff(diff)),
    evidence: { browserVerified: browserResult.verified === true, targetReacted: diff.targetReacted }
  };
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

function evaluateTransition({ beforeObservation = null, governedAction = {}, browserResult = {}, afterObservation = {} } = {}) {
  const diff = diffObservations(beforeObservation, afterObservation);
  const expected = expectedFor(governedAction, browserResult);
  const code = String(browserResult.outcome?.code || browserResult.failureCode || browserResult.code || "");
  const beforePage = pageOf(beforeObservation || {});
  const afterPage = pageOf(afterObservation);
  const postcondition = evaluatePostcondition(expected, governedAction, beforeObservation || {}, afterObservation, diff, browserResult);
  const actionSemantics = normalizedActionSemantics(governedAction, { expectedOutcome: expected });
  const dispatched = browserResult.dispatched === true || browserResult.executed === true;
  const unexpectedModal = Boolean(diff.modalOpened && !["options_surface_appeared", "active_surface_change", "semantic_progress"].includes(expected.type));
  const newValidation = Boolean(diff.errorsAppeared?.length);

  let status;
  let nextDirective;
  if (UNSAFE_CODES.has(code) || (priceIncreased(beforePage, afterPage) && expected.mustNotIncreasePrice === true)) {
    status = "unsafe";
    nextDirective = "stop_or_request_approval";
  } else if (!beforeObservation?.observationId || !afterObservation?.observationId || !dispatched) {
    status = "uncertain";
    nextDirective = "reobserve_rebind";
  } else if (unexpectedModal || newValidation) {
    status = "blocked";
    nextDirective = "resolve_blocker";
  } else if (postcondition.satisfied) {
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
    expectedEvidence: actionSemantics.expectedEvidence
  };
}

module.exports = { evaluatePostcondition, evaluateTransition, meaningfulDiff };
