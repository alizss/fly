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
  "PAYMENT_AUTHORIZATION_REQUIRED",
  "DUPLICATE_PAYMENT_ATTEMPT"
]);

const RECONCILABLE_CHANGE_CODES = new Set([
  "PRICE_INCREASE_REQUIRES_AUTHORIZATION",
  "UNAPPROVED_PRICE_CHANGE"
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

function actionEffect(action = {}) {
  return action.mechanicalEffect
    || action.physicalEffect
    || action.affordance?.mechanicalEffect
    || action.affordance?.physicalEffect
    || action.affordance?.effect
    || "unknown";
}

function crossesIrreversibleBoundary(action = {}) {
  const effect = actionEffect(action);
  const meaning = text(`${action.type || ""} ${action.intent || ""} ${action.semanticIntent || ""} ${action.risk || ""}`);
  const risk = text(action.risk || "");
  return ["select_paid_option", "enter_payment_credentials", "submit_purchase"].includes(effect)
    || ["payment", "purchase", "irreversible"].includes(risk)
    || /submit payment|submit purchase|purchase booking|book now|submit booking|confirm booking|cancel booking|final confirmation|irreversible/.test(meaning);
}

function reversibleUnexpectedChange(action = {}, code = "", beforePage = {}, afterPage = {}) {
  const priceAlarm = RECONCILABLE_CHANGE_CODES.has(code) || priceIncreased(beforePage, afterPage);
  if (!priceAlarm || crossesIrreversibleBoundary(action)) return null;
  return Object.freeze({
    classification: "unexpected_reversible_change",
    code: code || "UNEXPECTED_PRICE_INCREASE",
    actionId: action.id || "",
    actionControlId: action.controlId || action.targetSnapshot?.controlId || "",
    predictedEffect: actionEffect(action),
    beforePrice: priceAmount(beforePage),
    afterPrice: priceAmount(afterPage)
  });
}

function groupHasPaidSelection(group = {}, page = {}) {
  const evidence = group.selectedEvidence || {};
  if (evidence.disposition === "free") return false;
  if (evidence.disposition === "paid" || Number(evidence.structuredPrice?.amount) > 0) return true;
  const selectedControlId = group.selectedControlId || evidence.selectedControlId || "";
  const selectedControl = controlById(page, selectedControlId) || {};
  const meaning = text(`${evidence.semantic || ""} ${evidence.risk || ""} ${selectedControl.semantic || ""} ${selectedControl.risk || ""}`);
  return /paid|money|purchase|premium|upgrade/.test(meaning)
    && !/decline|free|remove|skip|without|none/.test(meaning);
}

function selectedTruth(group = {}) {
  const evidence = group.selectedEvidence || {};
  const controlId = group.selectedControlId || evidence.selectedControlId || "";
  if (evidence.selected !== true && !controlId) return null;
  const amount = Number(evidence.structuredPrice?.amount);
  return {
    controlId,
    disposition: text(evidence.disposition || group.selectedSemantic || "unknown"),
    priceAmount: Number.isFinite(amount) ? amount : null
  };
}

function unrelatedSelectionChanges(beforePage = {}, afterPage = {}, ownedGroupId = "") {
  const beforeById = new Map((beforePage.decisionGroups || []).map((group) => [
    group.decisionGroupId || group.requirementId || "",
    selectedTruth(group)
  ]).filter(([id, truth]) => id && truth));
  return (afterPage.decisionGroups || []).flatMap((group) => {
    const decisionGroupId = group.decisionGroupId || group.requirementId || "";
    if (!decisionGroupId || decisionGroupId === ownedGroupId) return [];
    const after = selectedTruth(group);
    if (!after) return [];
    const before = beforeById.get(decisionGroupId) || null;
    // A newly visible group can be another representation exposed by the
    // correction (for example a dropdown value after its overlay closes).
    // Only the same stable unrelated group proves an external selection
    // change. Newly paid groups are still handled by the paid-mutation guard.
    if (!before) return [];
    if (before && JSON.stringify(before) === JSON.stringify(after)) return [];
    return [{ decisionGroupId, before, after }];
  });
}

function interveningPaidMutation(beforePage = {}, afterPage = {}, action = {}) {
  const ownedGroupId = action.decisionGroupId
    || action.targetSnapshot?.decisionGroupId
    || action.affordance?.task?.decisionGroupId
    || "";
  const effect = action.mechanicalEffect
    || action.physicalEffect
    || action.affordance?.mechanicalEffect
    || action.affordance?.physicalEffect
    || action.affordance?.effect
    || "unknown";
  const exactCorrection = effect === "select_free_option"
    && action.expectedOutcome?.type === "exact_free_option_selected"
    && ownedGroupId;
  const unrelatedChanges = exactCorrection
    ? unrelatedSelectionChanges(beforePage, afterPage, ownedGroupId)
    : [];
  if (unrelatedChanges.length) {
    return Object.freeze({
      classification: "intervening_external_mutation",
      code: "INTERVENING_EXTERNAL_SELECTION_MUTATION",
      actionId: action.id || "",
      actionControlId: action.controlId || action.targetSnapshot?.controlId || "",
      actionDecisionGroupId: ownedGroupId,
      predictedEffect: effect,
      decisionGroupIds: Object.freeze(unrelatedChanges.map((change) => change.decisionGroupId)),
      selectionChanges: Object.freeze(unrelatedChanges)
    });
  }
  const beforePaid = new Set((beforePage.decisionGroups || [])
    .filter((group) => groupHasPaidSelection(group, beforePage))
    .map((group) => group.decisionGroupId || group.requirementId)
    .filter(Boolean));
  const newlyPaid = (afterPage.decisionGroups || []).filter((group) => {
    const id = group.decisionGroupId || group.requirementId || "";
    return id && !beforePaid.has(id) && groupHasPaidSelection(group, afterPage);
  });
  if (!newlyPaid.length) return null;
  const externallyOwned = newlyPaid.filter((group) => (
    effect !== "select_paid_option"
    || !ownedGroupId
    || (group.decisionGroupId || group.requirementId) !== ownedGroupId
  ));
  if (!externallyOwned.length) return null;
  return Object.freeze({
    classification: "intervening_external_mutation",
    code: "INTERVENING_EXTERNAL_MUTATION",
    actionId: action.id || "",
    actionControlId: action.controlId || action.targetSnapshot?.controlId || "",
    actionDecisionGroupId: ownedGroupId,
    predictedEffect: effect,
    decisionGroupIds: Object.freeze(externallyOwned.map((group) => group.decisionGroupId || group.requirementId).filter(Boolean))
  });
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

function materialObservationHash(observation = {}) {
  return String(
    observation.observationSnapshot?.materialHash
    || observation.observationSnapshot?.snapshotHash
    || observation.page?.materialHash
    || observation.page?.snapshotHash
    || ""
  );
}

function materialStateChanged(diff = {}) {
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
  const selectedEvidence = group?.selectedEvidence || {};
  const selectedChargeAmount = Number(selectedEvidence.structuredPrice?.amount ?? chosen?.structuredPrice?.amount);
  const paidTransactionForGroup = (page = {}) => (page.transactionFacts?.selectedExtras || []).find((extra) => (
    String(extra.decisionGroupId || "") === groupId
    && (
      Number(extra.priceAmount) > 0
      || /paid|money|selected_paid/.test(text(extra.disposition || ""))
    )
    && !/decline|free|remove|skip|without|none|no extra/.test(text(extra.disposition || ""))
  )) || null;
  const beforePaidTransaction = paidTransactionForGroup(beforePage);
  const afterPaidTransaction = paidTransactionForGroup(afterPage);
  const semanticOwnershipLink = (beforePage.semanticOwnershipLinks || []).find((link) => (
    link.linkId === expected.semanticOwnershipLinkId
    && link.sourceDecisionGroupId === groupId
    && link.correctionControlId === expectedControlId
    && link.status === "resolved"
  )) || null;
  const linkedPaidSelectionCleared = Boolean(
    semanticOwnershipLink
    && beforePaidTransaction
    && !afterPaidTransaction
  );
  const selectedChargeRemoved = expected.requireChargeRemoved !== true || Boolean(
    linkedPaidSelectionCleared
    ||
    !group
    || (
      selectedEvidence.disposition === "free"
      && (!Number.isFinite(selectedChargeAmount) || selectedChargeAmount <= 0)
    )
    || (Number.isFinite(selectedChargeAmount) && selectedChargeAmount === 0)
  );
  const unrelatedSelectionChangesObserved = unrelatedSelectionChanges(beforePage, afterPage, groupId)
    .filter((change) => change.decisionGroupId !== expected.correctionDecisionGroupId);
  const exactOrLinkedCorrection = (exact && freeDisposition) || linkedPaidSelectionCleared;
  return {
    satisfied: exactOrLinkedCorrection
      && selectedChargeRemoved
      && unrelatedSelectionChangesObserved.length === 0
      && !paidSelected
      && !priceIncreased(beforePage, afterPage)
      && !validation,
    evidence: {
      groupId,
      expectedControlId,
      selectedControlId: group?.selectedControlId || "",
      freeDisposition,
      semanticOwnershipLinkId: semanticOwnershipLink?.linkId || "",
      linkedPaidSelectionCleared,
      selectedChargeRemoved,
      selectedChargeAmount: Number.isFinite(selectedChargeAmount) ? selectedChargeAmount : null,
      unrelatedSelectionChanges: unrelatedSelectionChangesObserved,
      paidSelected,
      validation
    }
  };
}

function policyConflictResolution(expected = {}, action = {}, beforePage = {}, afterPage = {}) {
  const groupId = expected.decisionGroupId || action.decisionGroupId || "";
  const paidTransaction = (page = {}) => (page.transactionFacts?.selectedExtras || []).find((extra) => (
    String(extra.decisionGroupId || "") === groupId
    && (
      Number(extra.priceAmount) > 0
      || /paid|money|selected_paid/.test(text(extra.disposition || ""))
    )
    && !/decline|free|remove|skip|without|none|no extra/.test(text(extra.disposition || ""))
  )) || null;
  const paidGroup = (page = {}) => {
    const group = groupById(page, groupId);
    const evidence = group?.selectedEvidence || {};
    const amount = Number(evidence.structuredPrice?.amount);
    return Boolean(group && evidence.selected === true && (
      evidence.disposition === "paid"
      || (Number.isFinite(amount) && amount > 0)
      || /selected_paid|add_paid|money|purchase/.test(text(`${group.selectedSemantic || ""} ${evidence.semantic || ""} ${evidence.risk || ""}`))
    ));
  };
  const beforeTransaction = paidTransaction(beforePage);
  const afterTransaction = paidTransaction(afterPage);
  const beforeGroup = groupById(beforePage, groupId);
  const afterGroup = groupById(afterPage, groupId);
  const selectedControlId = String(
    beforeGroup?.selectedEvidence?.selectedControlId
    || beforeGroup?.selectedControlId
    || ""
  );
  const afterSelectedControl = controlById(afterPage, selectedControlId);
  const afterSelectedText = text(
    afterPage.foreground?.progressMarkers?.selectedText
    || afterPage.visualState?.foreground?.progressMarkers?.selectedText
    || ""
  );
  const exactControlUnselected = Boolean(
    selectedControlId && (!afterSelectedControl || !selected(afterSelectedControl))
  );
  const explicitUnselectedState = /not selected|unselected|no selection|none selected/.test(afterSelectedText);
  const groupSelectionCleared = Boolean(
    !afterGroup
    || (afterGroup.selectedEvidence?.selected !== true && !afterGroup.selectedControlId)
  );
  const beforePaid = Boolean(beforeTransaction || paidGroup(beforePage));
  const selectedItemCleared = Boolean(
    beforePaid && (exactControlUnselected || explicitUnselectedState || groupSelectionCleared)
  );
  const afterPaidMetadata = Boolean(afterTransaction || paidGroup(afterPage));
  const afterPaid = Boolean(afterTransaction || (paidGroup(afterPage) && !selectedItemCleared));
  const chargeCleared = beforeTransaction ? !afterTransaction : !afterPaid;
  const unrelated = unrelatedSelectionChanges(beforePage, afterPage, groupId)
    .filter((change) => change.decisionGroupId !== expected.correctionDecisionGroupId);
  const validation = (afterPage.validationIssues || []).some((issue) => (
    issue.stageWide === true
    || issue.controlId === (expected.controlId || action.controlId)
  ));
  return {
    satisfied: Boolean(
      expected.semanticOwnershipLinkId
      && beforePaid
      && selectedItemCleared
      && !afterPaid
      && chargeCleared
      && unrelated.length === 0
      && !priceIncreased(beforePage, afterPage)
      && !validation
    ),
    evidence: {
      groupId,
      semanticOwnershipLinkId: expected.semanticOwnershipLinkId || "",
      intendedOutcome: expected.intendedOutcome || "unknown",
      beforePaid,
      afterPaid,
      afterPaidMetadata,
      selectedItemCleared,
      exactControlUnselected,
      explicitUnselectedState,
      groupSelectionCleared,
      chargeCleared,
      unrelatedSelectionChanges: unrelated,
      validation
    }
  };
}

function observationProgressFingerprint(observation = {}) {
  const page = observation.page || {};
  return JSON.stringify(
    page.foreground?.progressMarkers
      || page.visualState?.foreground?.progressMarkers
      || page.progressMarkers
      || {}
  );
}

function destinationProgressFromOrigin(afterObservation = {}, navigationContext = null) {
  if (!navigationContext?.destinationReady || !navigationContext.origin) {
    return { ready: false, progressed: false };
  }
  const origin = navigationContext.origin;
  const afterPage = pageOf(afterObservation);
  const afterStage = decideStage(afterObservation).stage;
  const afterUrl = afterPage.url || afterObservation.url || "";
  const afterSurfaceId = surfaceOf(afterPage).id || "";
  const afterProgress = observationProgressFingerprint(afterObservation);
  const progressed = Boolean(
    (origin.stage && afterStage && origin.stage !== "unknown" && afterStage !== origin.stage)
    || (origin.url && afterUrl && afterUrl !== origin.url)
    || (origin.surfaceId && afterSurfaceId && afterSurfaceId !== origin.surfaceId)
    || (
      origin.progressFingerprint
      && afterProgress
      && afterProgress !== "{}"
      && afterProgress !== origin.progressFingerprint
    )
  );
  return {
    ready: true,
    progressed,
    originStage: origin.stage || "unknown",
    afterStage,
    originUrl: origin.url || "",
    afterUrl,
    originSurfaceId: origin.surfaceId || "",
    afterSurfaceId
  };
}

function evaluatePostcondition(
  expected = {},
  action = {},
  beforeObservation = {},
  afterObservation = {},
  diff = {},
  browserResult = {},
  navigationContext = null
) {
  const beforePage = pageOf(beforeObservation);
  const afterPage = pageOf(afterObservation);
  const controlId = expected.controlId || action.controlId || action.targetSnapshot?.controlId || "";
  const beforeControl = controlById(beforePage, controlId);
  const afterControl = controlById(afterPage, controlId);
  const type = expected.type || "observable_change";
  const semantics = normalizedActionSemantics(action, { expectedOutcome: expected });

  if (type === "policy_conflict_resolved") {
    const resolved = policyConflictResolution(expected, action, beforePage, afterPage);
    return { type, ...resolved };
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
    const conflictingSelected = (expected.conflictingControlIds || []).filter((controlId) => {
      const control = controlById(afterPage, controlId);
      return selected(control || {});
    });
    const validation = (afterPage.validationIssues || []).filter((issue) => (
      issue.stageWide === true || issue.controlId === wanted
    ));
    return {
      type,
      satisfied: Boolean(wanted && actual === wanted && !conflictingSelected.length && !validation.length),
      evidence: { groupId, wanted, actual, conflictingSelected, validation }
    };
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
    const advancedInPlace = Boolean(diff.progressChanged || diff.stageChanged || diff.urlChanged);
    return {
      type,
      satisfied: gone || advancedInPlace,
      evidence: {
        expectedSurfaceId,
        currentSurfaceId: afterSurface.id || "",
        modalClosed: diff.modalClosed,
        advancedInPlace,
        progressChanged: diff.progressChanged,
        stageChanged: diff.stageChanged,
        urlChanged: diff.urlChanged
      }
    };
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
    const destination = destinationProgressFromOrigin(afterObservation, navigationContext);
    const advanced = Boolean(
      diff.progressChanged
      || diff.stageChanged
      || diff.urlChanged
      || (diff.surfaceChanged && !diff.modalOpened && !diff.modalClosed)
      || (destination.ready && destination.progressed)
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
        modalClosed: diff.modalClosed,
        destination
      }
    };
  }
  if (type === "checkout_stage_advanced") {
    const destination = destinationProgressFromOrigin(afterObservation, navigationContext);
    const advanced = Boolean(
      diff.stageChanged
      || diff.urlChanged
      || diff.progressChanged
      || (destination.ready && destination.progressed)
    );
    return {
      type,
      satisfied: advanced,
      evidence: {
        stageChanged: diff.stageChanged,
        urlChanged: diff.urlChanged,
        progressChanged: diff.progressChanged,
        modalOpened: diff.modalOpened,
        modalClosed: diff.modalClosed,
        destination
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

function evaluateTransition({
  beforeObservation = null,
  governedAction = {},
  browserResult = {},
  afterObservation = {},
  navigationContext = null
} = {}) {
  const diff = diffObservations(beforeObservation, afterObservation);
  const expected = expectedFor(governedAction, browserResult);
  const code = String(browserResult.outcome?.code || browserResult.failureCode || browserResult.code || "");
  const beforePage = pageOf(beforeObservation || {});
  const afterPage = pageOf(afterObservation);
  const postcondition = evaluatePostcondition(
    expected,
    governedAction,
    beforeObservation || {},
    afterObservation,
    diff,
    browserResult,
    navigationContext
  );
  const actionSemantics = normalizedActionSemantics(governedAction, { expectedOutcome: expected });
  const outcomeContract = governedAction.affordance?.task?.outcomeContract
    || outcomeContractForGoal(governedAction.goal || {}, beforeObservation || {});
  const localMechanicalResult = verifiedPhysicalResult(governedAction, postcondition, diff);
  const currentObligationResult = currentObligationResultFor(governedAction, postcondition, localMechanicalResult, diff);
  const durableObjectiveProgress = parentProgressFor(governedAction, afterObservation, localMechanicalResult, diff);
  const dispatched = browserResult.dispatched === true || browserResult.executed === true;
  const beforeMaterialHash = materialObservationHash(beforeObservation || {});
  const afterMaterialHash = materialObservationHash(afterObservation);
  const sameMaterialObservation = Boolean(
    beforeMaterialHash
    && afterMaterialHash
    && beforeMaterialHash === afterMaterialHash
  );
  const unchangedMaterialState = sameMaterialObservation || !materialStateChanged(diff);
  let causality = interveningPaidMutation(beforePage, afterPage, governedAction);
  const recoverableChange = reversibleUnexpectedChange(governedAction, code, beforePage, afterPage);
  let status;
  let nextDirective;
  if (causality) {
    status = "blocked";
    nextDirective = "rebuild_task_state";
  } else if (recoverableChange) {
    causality = recoverableChange;
    status = "blocked";
    nextDirective = "rebuild_task_state";
  } else if (UNSAFE_CODES.has(code)
    || (priceIncreased(beforePage, afterPage) && expected.mustNotIncreasePrice === true)) {
    status = "unsafe";
    nextDirective = "stop_or_request_approval";
  } else if (!beforeObservation?.observationId || !afterObservation?.observationId || !dispatched) {
    status = "uncertain";
    nextDirective = "reobserve_rebind";
  } else if (
    durableObjectiveProgress.completed
    || (
      navigationContext?.destinationReady === true
      && postcondition.satisfied === true
      && ["current_surface_advanced", "checkout_stage_advanced", "stage_exit_or_feedback"].includes(postcondition.type)
    )
  ) {
    status = "achieved";
    nextDirective = "advance_goal";
  } else if (dispatched && postcondition.satisfied !== true && unchangedMaterialState) {
    // A new observation id or browser acknowledgement is not progress. The
    // expected user-visible result must exist in a materially changed state.
    status = "no_effect";
    nextDirective = "try_distinct_capability";
  } else if (expected.semanticOwnershipLinkId && postcondition.satisfied !== true) {
    // AI ownership is only a hypothesis. If the fresh page does not prove its
    // exact intended outcome, retain the conflict and suppress this precise
    // action strategy even when some unrelated visible change occurred.
    status = "no_effect";
    nextDirective = "try_distinct_capability";
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
    blocker: status === "blocked"
      ? (causality || blockerFrom(afterObservation, diff))
      : null,
    causality,
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

module.exports = {
  crossesIrreversibleBoundary,
  currentObligationResultFor,
  evaluatePostcondition,
  evaluateTransition,
  meaningfulDiff,
  materialStateChanged,
  parentProgressFor,
  reversibleUnexpectedChange,
  verifiedPhysicalResult
};
