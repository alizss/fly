const { diffObservations } = require("./observation-diff");
const { currentSurface } = require("./surface-contract");
const { normalizedActionSemantics, outcomeContractForGoal } = require("./action-semantics");
const { resolveLogicalFields, verifyLogicalField } = require("./logical-field");
const { decodeDateFromField } = require("./date-field-codec");
const agentContract = require("../../extension/src/shared/agent-contract");

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
    || action.affordance?.mechanicalEffect
    || action.affordance?.physicalEffect
    || action.affordance?.effect
    || "unknown";
}

function crossesIrreversibleBoundary(action = {}) {
  const effect = actionEffect(action);
  const meaning = text(`${action.type || ""} ${action.intent || ""} ${action.risk || ""}`);
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
  const selectedControlId = group.selectedControlId || evidence.selectedControlId || "";
  const selectedControl = controlById(page, selectedControlId) || {};
  return agentContract.isGenuineSelectedPaidItem({
    decisionGroupId: group.decisionGroupId || group.requirementId,
    selectedControlId,
    selectionOwnerId: evidence.ownerElementId || group.semanticOwnership?.ownerElementId,
    selected: evidence.selected === true
      || selectedControl.selected === true
      || selectedControl.state?.selected === true
      || selectedControl.state?.checked === true,
    effectRole: evidence.effectRole || selectedControl.effectRole,
    disposition: evidence.disposition,
    priceAmount: evidence.structuredPrice?.amount ?? selectedControl.structuredPrice?.amount,
    semanticEffect: selectedControl.physicalEffect || evidence.semantic || selectedControl.semantic
  });
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
  const beforeDecisionIds = new Set((beforePage.decisionGroups || [])
    .map((group) => group.decisionGroupId || group.requirementId)
    .filter(Boolean));
  const newlyPaid = (afterPage.decisionGroups || []).filter((group) => {
    const id = group.decisionGroupId || group.requirementId || "";
    // A decision first exposed by the destination surface is fresh TaskState
    // evidence, not proof that the navigation action selected it. Only a
    // stable decision owner that changed inside the causal window can make the
    // action lifecycle fail as an intervening mutation. Price/transaction
    // guards independently catch consequential destination changes.
    return id
      && beforeDecisionIds.has(id)
      && !beforePaid.has(id)
      && groupHasPaidSelection(group, afterPage);
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
    || diff.urlChanged
    || diff.progressChanged
    || diff.surfaceChanged
  );
}

function navigationDestinationArrival(beforeObservation = {}, afterObservation = {}, diff = {}, navigationContext = {}) {
  if (navigationContext?.destinationReady !== true) {
    return Object.freeze({ arrived: false, evidence: [] });
  }
  const afterPage = pageOf(afterObservation);
  const afterSurface = surfaceOf(afterPage);
  const surfaceClass = text(afterSurface.surfaceClass || afterSurface.classification || "");
  const destinationBlocked = Boolean(
    (diff.errorsAppeared || []).length
    || /site.failure|fatal|unavailable|error/.test(surfaceClass)
  );
  if (destinationBlocked) {
    return Object.freeze({ arrived: false, blocked: true, evidence: [] });
  }
  const origin = navigationContext.origin || {};
  const originUrlChanged = Boolean(origin.url && afterPage.url && origin.url !== afterPage.url);
  const originSurfaceChanged = Boolean(
    origin.surfaceId
    && afterSurface.id
    && origin.surfaceId !== afterSurface.id
  );
  const currentProgressFingerprint = JSON.stringify(
    afterPage.foreground?.progressMarkers
      || afterPage.visualState?.foreground?.progressMarkers
      || afterPage.progressMarkers
      || {}
  );
  const originProgressChanged = Boolean(
    origin.progressFingerprint
    && origin.progressFingerprint !== currentProgressFingerprint
  );
  const evidence = [
    diff.urlChanged ? "url_changed" : "",
    diff.stageChanged ? "stage_changed" : "",
    diff.progressChanged ? "progress_changed" : "",
    diff.surfaceChanged ? "surface_changed" : "",
    originUrlChanged ? "origin_url_changed" : "",
    originSurfaceChanged ? "origin_surface_changed" : "",
    originProgressChanged ? "origin_progress_changed" : ""
  ].filter(Boolean);
  return Object.freeze({ arrived: evidence.length > 0, blocked: false, evidence: Object.freeze(evidence) });
}

function matchingBrowserActionOutcome(browserResult = {}, expected = {}, action = {}) {
  const outcome = browserResult.actionOutcome || browserResult.canonicalOutcome || null;
  if (!outcome || outcome.contractVersion !== "action-outcome/v1") return null;
  if (!Object.values(agentContract.ACTION_OUTCOME).includes(outcome.status)) return null;
  const browserContract = outcome.originalSuccessContract || browserResult.expectedOutcome || null;
  const expectedType = String(expected.type || "");
  // The governed action is the expected-contract authority. A compact browser
  // receipt may omit that already-durable contract; compare it only when an
  // older producer still supplies a copy.
  if (browserContract && expectedType && String(browserContract.type || "") !== expectedType) return null;
  const expectedControlId = String(expected.controlId || action.controlId || action.targetSnapshot?.controlId || "");
  const browserControlId = String(
    browserContract?.controlId
    || browserResult.action?.controlId
    || browserResult.targetSnapshot?.controlId
    || ""
  );
  if (expectedControlId && browserControlId && expectedControlId !== browserControlId) return null;
  const expectedActionId = String(action.id || "");
  const browserActionId = String(outcome.causedByActionId || browserResult.actionId || "");
  if (expectedActionId && browserActionId && expectedActionId !== browserActionId) return null;
  return outcome;
}

function expectedFor(governedAction = {}, browserResult = {}) {
  // The adapter-owned contract is authoritative. Browser acknowledgements
  // are evidence only and cannot replace the semantic outcome definition.
  return governedAction.pipelineContract?.expectedOutcome
    || governedAction.expectedOutcome
    || browserResult.expectedOutcome
    || {};
}


function verifiedPhysicalResult(action = {}, postcondition = {}, diff = {}, browserSettlement = null) {
  const predictedEffect = action.mechanicalEffect || action.affordance?.mechanicalEffect || action.affordance?.physicalEffect || action.affordance?.effect || "unknown";
  if (!browserSettlement) {
    return {
      effect: predictedEffect,
      verified: false,
      evidence: {
        browserSettlementStatus: "MISSING_CANONICAL_BROWSER_OUTCOME"
      }
    };
  }
  return {
    effect: browserSettlement.observedEvidence?.mechanicalEffect || predictedEffect,
    verified: browserSettlement.status === agentContract.ACTION_OUTCOME.SATISFIED,
    evidence: {
      browserSettlementStatus: browserSettlement.status,
      causedByActionId: browserSettlement.causedByActionId || "",
      originalSuccessContract: browserSettlement.originalSuccessContract || null
    }
  };
}

function currentObligationResultFor(action = {}, postcondition = {}, localMechanicalResult = {}, diff = {}, browserSettlement = null) {
  const taskOutcome = action.affordance?.task?.outcomeContract?.taskOutcome || "";
  const compatibility = action.outcomeCompatibility || "unknown";
  return Object.freeze({
    outcomeId: action.obligationId || action.affordance?.task?.goalId || "",
    taskOutcome,
    // Browser settlement closes only the leased local operation. The next
    // DecisionFrame/TaskState reduction is the sole obligation authority.
    status: browserSettlement?.status === agentContract.ACTION_OUTCOME.SATISFIED
      ? "awaiting_fresh_reduction"
      : "no_progress",
    completed: false,
    compatibility,
    evidence: Object.freeze({
      postconditionType: postcondition.type || "",
      postconditionSatisfied: postcondition.satisfied === true,
      browserSettlementStatus: browserSettlement?.status || "MISSING_CANONICAL_BROWSER_OUTCOME",
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

function parentProgressFor(action = {}, afterObservation = {}, localEffect = {}, diff = {}, browserSettlement = null) {
  const task = action.affordance?.task || {};
  const contract = task.parentOutcomeContract || task.outcomeContract || {};
  const outcomeId = contract.outcomeId || task.goalId || action.obligationId || "";
  const taskOutcome = contract.taskOutcome || "";
  const terminalEvidence = agentContract.compileTerminalEvidence(afterObservation);
  const completed = taskOutcome === "card_credential_entry_reached"
    ? terminalEvidence.boundaryObserved === true
    : taskOutcome === "booking_confirmed"
      ? afterObservation?.page?.bookingConfirmation?.verified === true
      : false;
  return Object.freeze({
    outcomeId,
    taskOutcome,
    status: completed ? "completed" : "no_progress",
    completed,
    evidence: Object.freeze({
      terminalBoundaryObserved: terminalEvidence.boundaryObserved === true,
      paymentCredentialKinds: terminalEvidence.paymentCredentialKinds || [],
      stageChanged: diff.stageChanged,
      urlChanged: diff.urlChanged,
      progressChanged: diff.progressChanged
    })
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
  const browserSettlement = matchingBrowserActionOutcome(browserResult, expected, governedAction);
  const code = String(browserResult.outcome?.code || browserResult.failureCode || browserResult.code || "");
  const beforePage = pageOf(beforeObservation || {});
  const afterPage = pageOf(afterObservation);
  // Backend transition analysis does not run a second local verifier. It
  // transports the browser settlement and separately evaluates durable
  // safety/terminal consequences from the fresh observation.
  const postcondition = Object.freeze({
    type: expected.type || "exact_outcome_missing",
    satisfied: browserSettlement?.status === agentContract.ACTION_OUTCOME.SATISFIED,
    evidence: Object.freeze({
      browserSettlementStatus: browserSettlement?.status || "MISSING_CANONICAL_BROWSER_OUTCOME",
      causedByActionId: browserSettlement?.causedByActionId || "",
      observedEvidence: browserSettlement?.observedEvidence || null
    })
  });
  const actionSemantics = normalizedActionSemantics(governedAction, { expectedOutcome: expected });
  const outcomeContract = governedAction.affordance?.task?.outcomeContract
    || outcomeContractForGoal(governedAction.goal || {}, beforeObservation || {});
  const localMechanicalResult = verifiedPhysicalResult(governedAction, postcondition, diff, browserSettlement);
  const currentObligationResult = currentObligationResultFor(governedAction, postcondition, localMechanicalResult, diff, browserSettlement);
  const durableObjectiveProgress = parentProgressFor(governedAction, afterObservation, localMechanicalResult, diff, browserSettlement);
  const dispatched = browserResult.dispatched === true || browserResult.executed === true;
  const beforeMaterialHash = materialObservationHash(beforeObservation || {});
  const afterMaterialHash = materialObservationHash(afterObservation);
  const sameMaterialObservation = Boolean(
    beforeMaterialHash
    && afterMaterialHash
    && beforeMaterialHash === afterMaterialHash
  );
  const unchangedMaterialState = sameMaterialObservation || !materialStateChanged(diff);
  const destinationArrival = navigationDestinationArrival(
    beforeObservation || {},
    afterObservation,
    diff,
    navigationContext || {}
  );
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
    // A stable observation with incomplete causal identity cannot justify a
    // timer wait. Close this action as no-effect and let bounded recovery use
    // a distinct proven method or stop.
    status = "no_effect";
    nextDirective = "try_distinct_capability";
  } else if (browserSettlement?.status === agentContract.ACTION_OUTCOME.UNSAFE_CHANGE) {
    status = "unsafe";
    nextDirective = "stop_or_request_approval";
  } else if (browserSettlement?.status === agentContract.ACTION_OUTCOME.REVEALED_BLOCKER) {
    status = "blocked";
    nextDirective = "rebuild_task_state";
  } else if (browserSettlement?.status === agentContract.ACTION_OUTCOME.NO_EFFECT) {
    status = "no_effect";
    nextDirective = "try_distinct_capability";
  } else if (browserSettlement?.status === agentContract.ACTION_OUTCOME.NO_RESULT) {
    status = "no_result";
    nextDirective = "try_distinct_capability";
  } else if (
    durableObjectiveProgress.completed
  ) {
    status = "achieved";
    nextDirective = "advance_goal";
  } else if (
    browserSettlement?.status === agentContract.ACTION_OUTCOME.DESTINATION_LOADING
    && destinationArrival.arrived
  ) {
    status = "destination_arrived";
    nextDirective = "rebuild_from_fresh_observation";
  } else if (browserSettlement?.status === agentContract.ACTION_OUTCOME.DESTINATION_LOADING) {
    status = "destination_loading";
    nextDirective = "wait_for_destination";
  } else if (browserSettlement?.status === agentContract.ACTION_OUTCOME.SATISFIED) {
    status = "local_satisfied";
    nextDirective = "rebuild_from_fresh_observation";
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
  } else if (dispatched) {
    status = "no_effect";
    nextDirective = "try_distinct_capability";
  } else {
    status = "no_effect";
    nextDirective = "try_distinct_capability";
  }

  const provenDestinationAdvance = Boolean(
    navigationContext?.destinationReady === true
    && postcondition.satisfied === true
    && ["current_surface_advanced", "checkout_stage_advanced", "stage_exit_or_feedback"].includes(postcondition.type)
  );
  const revealedBlocker = Boolean(
    causality
    || browserSettlement?.status === agentContract.ACTION_OUTCOME.REVEALED_BLOCKER
    || (!browserSettlement && (
      (diff.modalOpened && !provenDestinationAdvance)
      || (diff.errorsAppeared || []).length
    ))
  );
  const blocker = revealedBlocker
    ? (causality || blockerFrom(afterObservation, diff))
    : null;
  // The backend never recompiles local success from its own diff. It either
  // transports the exact matching browser settlement or records that the
  // local result lacked canonical browser authority. Safety and durable
  // checkout consequences remain separate transition fields below.
  const actionOutcome = browserSettlement || agentContract.compileActionOutcome({
    status: agentContract.ACTION_OUTCOME.NO_RESULT,
    causedByActionId: browserResult.actionId || governedAction.id || "",
    code: "MISSING_CANONICAL_BROWSER_OUTCOME",
    originalSuccessContract: expected
  });
  if (actionOutcome.status === agentContract.ACTION_OUTCOME.REVEALED_BLOCKER) {
    nextDirective = "rebuild_task_state";
  } else if (actionOutcome.status === agentContract.ACTION_OUTCOME.UNSAFE_CHANGE) {
    nextDirective = causality ? "rebuild_task_state" : "stop_or_request_approval";
  }
  return {
    actionOutcome,
    diff,
    postcondition,
    nextDirective,
    blocker: status === "blocked" ? blocker : null,
    causality,
    authoritative: "browser_observation",
    beforeObservationId: beforeObservation?.observationId || "",
    afterObservationId: afterObservation?.observationId || "",
    actionId: browserResult.actionId || governedAction.id || "",
    interactionRole: actionSemantics.interactionRole,
    semanticEffect: actionSemantics.semanticEffect,
    expectedEvidence: actionSemantics.expectedEvidence,
    predictedMechanicalEffect: governedAction.mechanicalEffect || governedAction.affordance?.mechanicalEffect || governedAction.affordance?.physicalEffect || governedAction.affordance?.effect || "unknown",
    predictedPhysicalEffect: governedAction.mechanicalEffect || governedAction.affordance?.mechanicalEffect || governedAction.affordance?.physicalEffect || governedAction.affordance?.effect || "unknown",
    localMechanicalResult,
    currentObligationResult,
    durableObjectiveProgress,
    destinationArrival,
    localEffect: localMechanicalResult,
    physicalResult: localMechanicalResult,
    parentProgress: durableObjectiveProgress,
    surfaceTaskOutcome: outcomeContract.taskOutcome,
    taskOutcome: durableObjectiveProgress.taskOutcome || outcomeContract.taskOutcome,
    taskOutcomeCompleted: durableObjectiveProgress.completed,
    // A matching browser settlement is the local action-result authority.
    // This evaluator derives only safety, blocker, and durable checkout
    // consequences from the fresh observation. Legacy/synthetic results that
    // predate the canonical settlement retain deterministic compatibility.
    completionAuthority: browserSettlement ? "browser_verifier" : "missing_browser_settlement"
  };
}

module.exports = {
  crossesIrreversibleBoundary,
  currentObligationResultFor,
  evaluateTransition,
  matchingBrowserActionOutcome,
  materialStateChanged,
  navigationDestinationArrival,
  parentProgressFor,
  reversibleUnexpectedChange,
  verifiedPhysicalResult
};
