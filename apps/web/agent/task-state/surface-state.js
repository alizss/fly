const { currentObligation } = require("../authority-frames");
const { outcomeContractForGoal } = require("../action-semantics");
const { obligationField } = require("../current-obligation");
const { canonicalOptionMatch } = require("../logical-field");
const { currentSurface, controlBelongsToCurrentSurface } = require("../surface-contract");

function taskMechanics(taskState = {}) {
  return currentObligation(taskState) || {};
}

function clean(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function lower(value = "") {
  return clean(value).toLowerCase();
}

function surfaceClassFrom(page = {}) {
  const surface = currentSurface(page);
  if (surface.type === "page") return "navigation";
  if (["choice_set", "form", "review_confirmation", "site_failure", "warning", "navigation", "information", "unknown"].includes(surface.surfaceClass)) {
    return surface.surfaceClass;
  }
  const controls = (page.controls || []).filter((control) => controlBelongsToCurrentSurface(control, page));
  const effects = new Set(controls.map((control) => control.physicalEffect).filter(Boolean));
  const text = lower(`${surface.label || ""} ${controls.map((control) => control.ownText || control.label || "").join(" ")}`);
  if (controls.filter((control) => /radio|checkbox|option/.test(lower(`${control.kind || ""} ${control.role || ""}`))).length >= 2) return "choice_set";
  if (controls.some((control) => control.physicalEffect === "set_field_value" || /field|textbox|combobox/.test(lower(`${control.kind || ""} ${control.role || ""}`)))) return "form";
  if (/review|verify|check your (?:details|information)/.test(text)
    && (effects.has("advance_surface") || effects.has("advance_checkout_stage") || /continue.*payment/.test(text))) return "review_confirmation";
  if (/warning|are you sure|attention|problem|error/.test(text)) return "warning";
  if (effects.has("advance_surface") || effects.has("advance_checkout_stage") || /\bnext|continue|proceed\b/.test(text)) return "navigation";
  if (!controls.length) return "information";
  return "unknown";
}

function stableOutcome(previous = {}, fallbackId = "", type = "") {
  const sameType = previous && previous.type === type;
  return Object.freeze({
    outcomeId: sameType && previous.outcomeId ? previous.outcomeId : fallbackId,
    type
  });
}

function durableOutcomeHierarchy(previousTaskState = {}, stage = "unknown", terminalStatus = "active") {
  const transactionBase = stableOutcome(
    previousTaskState.transactionOutcome,
    "transaction_outcome:checkout_to_card_credential_entry",
    "checkout_to_card_credential_entry"
  );
  const stageBase = stableOutcome(
    previousTaskState.stageOutcome,
    "stage_outcome:reach_card_credential_entry",
    "reach_card_credential_entry"
  );
  const completed = terminalStatus === "card_credential_entry_reached";
  const stageOutcome = Object.freeze({
    ...stageBase,
    parentOutcomeId: transactionBase.outcomeId,
    status: completed ? "completed" : "active",
    observedStage: stage,
    completionEvidence: completed ? "fresh_card_credential_entry" : "",
    outcomeContract: outcomeContractForGoal({
      semanticGoal: "reach card credential entry",
      semanticType: "card_credential_entry",
      desiredValue: "card_credential_entry_reached"
    })
  });
  const transactionOutcome = Object.freeze({
    ...transactionBase,
    status: completed ? "completed" : "active",
    activeStageOutcomeId: stageOutcome.outcomeId,
    desiredOutcome: "card_credential_entry_reached"
  });
  return { transactionOutcome, stageOutcome };
}

function surfaceSemanticKey(surface = {}, surfaceClass = "unknown") {
  const progress = surface.foreground?.progressMarkers || surface.visualState?.foreground?.progressMarkers || {};
  return lower([
    surfaceClass,
    surface.taskHint,
    progress.flightOrdinal,
    progress.route,
    clean(surface.label).slice(0, 120)
  ].filter(Boolean).join("|"));
}

function surfaceContractForGoal(goal = {}, surfaceClass = "unknown", foreground = false) {
  if (goal.kind === "profile_field" || goal.decisionGroupId) return outcomeContractForGoal(goal);
  if (!foreground) return outcomeContractForGoal(goal);
  if (surfaceClass === "review_confirmation") {
    return Object.freeze({
      outcomeId: "",
      taskOutcome: "current_surface_completed",
      acceptablePhysicalEffects: Object.freeze(["advance_surface", "advance_checkout_stage", "reveal_control"]),
      completionEvidence: Object.freeze(["fresh_surface_progress", "fresh_stage_change", "fresh_card_credential_entry"])
    });
  }
  if (surfaceClass === "warning" || surfaceClass === "navigation" || surfaceClass === "choice_set") {
    return Object.freeze({
      outcomeId: "",
      taskOutcome: "current_surface_completed",
      acceptablePhysicalEffects: Object.freeze(["select_free_option", "open_surface", "advance_surface", "advance_checkout_stage", "reveal_control"]),
      completionEvidence: Object.freeze(["fresh_surface_progress", "fresh_surface_replacement", "fresh_stage_change"])
    });
  }
  if (surfaceClass === "information") {
    return Object.freeze({
      outcomeId: "",
      taskOutcome: "current_surface_completed",
      acceptablePhysicalEffects: Object.freeze(["dismiss_surface", "open_surface", "reveal_control"]),
      completionEvidence: Object.freeze(["fresh_surface_replacement"])
    });
  }
  return outcomeContractForGoal(goal);
}

function createSurfaceSubgoal(previousTaskState = {}, goal = null, surface = {}, surfaceClass = "unknown", stageOutcome = {}) {
  if (!goal) return null;
  const semanticKey = surfaceSemanticKey(surface, surfaceClass);
  const previous = previousTaskState.surfaceSubgoal || {};
  const subgoalId = previous.semanticKey === semanticKey && previous.subgoalId
    ? previous.subgoalId
    : `${stageOutcome.outcomeId}:surface:${semanticKey || "page"}`;
  const foreground = surface.type !== "page";
  const outcomeContract = surfaceContractForGoal(goal, surfaceClass, foreground);
  return Object.freeze({
    subgoalId,
    parentOutcomeId: stageOutcome.outcomeId,
    semanticKey,
    surfaceId: surface.id || "surface-page",
    surfaceType: surface.type || "page",
    surfaceClass,
    status: "active",
    semanticGoal: goal.semanticGoal || "",
    outcomeContract: Object.freeze({ ...outcomeContract, outcomeId: subgoalId })
  });
}

const ADAPTIVE_SURFACE_MAX_STEPS = 6;
const ADAPTIVE_SURFACE_DEADLINE_MS = 20_000;

function boundedAdaptiveQueryHypotheses(goal = {}) {
  const desired = clean(obligationField(goal, "desiredValue") || obligationField(goal, "canonicalValue"));
  const terms = [
    ...(obligationField(goal, "choiceTerms") || []),
    ...(obligationField(goal, "options") || []).flatMap((option) => [option?.label, option?.value]),
    desired
  ].map(clean).filter(Boolean);
  const digits = desired.replace(/\D/g, "");
  const textual = terms.filter((term) => (
    /[a-z]/i.test(term)
    && lower(term) !== lower(desired)
    && !/^(?:select|choose|search|find|country|code|phone|dial|calling)$/i.test(term)
  ));
  return Object.freeze([...new Set([
    digits && digits !== desired ? digits : "",
    ...textual,
    desired
  ].filter(Boolean).map((value) => value.slice(0, 120)))].slice(0, 4));
}

function verifiedReversibleSurfaceEntry(actionResult = {}) {
  const expectedOutcome = actionResult.expectedOutcome || {};
  const action = actionResult.action || {};
  return Boolean(
    actionResult.verified === true
    && actionResult.expectedOutcomeObserved === true
    && actionResult.postconditionSatisfied === true
    && (
      expectedOutcome.type === "options_surface_appeared"
      || action.operation === "open"
      || action.mechanicalEffect === "open_surface"
    )
  );
}

function verifiedTypedChoiceSurfaceEntry({
  actionResult = {},
  previousGoal = {},
  observation = {},
  surface = {}
} = {}) {
  const action = actionResult.action || {};
  const expected = actionResult.expectedOutcome || {};
  const page = observation.page || {};
  const desiredValue = obligationField(previousGoal, "desiredValue") ?? obligationField(previousGoal, "canonicalValue") ?? "";
  const semanticType = clean(obligationField(previousGoal, "semanticType") || obligationField(previousGoal, "sourceGoal")?.semanticType);
  const componentRole = clean(obligationField(previousGoal, "componentRole") || obligationField(previousGoal, "sourceGoal")?.componentRole || "value");
  const goalControlId = clean(obligationField(previousGoal, "controlId") || obligationField(previousGoal, "componentBinding")?.controlId);
  const actionControlId = clean(action.controlId || expected.controlId);
  // Compact browser receipts keep the semantic goal ID at the receipt root;
  // the nested mechanical action is intentionally smaller. Accept either
  // location so persistence compaction cannot sever an active combobox from
  // the exact option surface it just revealed.
  const actionGoalId = clean(action.obligationId || actionResult.obligationId || actionResult.goalId);
  const actionBelongsToGoal = Boolean(
    actionGoalId
    && clean(obligationField(previousGoal, "goalId"))
    && actionGoalId === clean(obligationField(previousGoal, "goalId"))
  );
  const controlIdentityMatches = !goalControlId || !actionControlId || goalControlId === actionControlId;
  if (!(
    actionResult.verified === true
    && actionResult.expectedOutcomeObserved === true
    && actionResult.postconditionSatisfied === true
    && actionBelongsToGoal
    && controlIdentityMatches
    && action.operation === "type"
    && expected.interactionKind === "editable_combobox"
    && expected.commitRequirement === "logical_component_committed"
    && surface.id
    && surface.type !== "page"
    && semanticType
    && clean(desiredValue)
  )) return false;

  // Some searchable choice widgets open their listbox as the direct result of
  // typing. The typed text is only a filter value, not a committed profile
  // value. Preserve the exact parent obligation only when the fresh foreground
  // surface contains a compatible choice actuator for that same value.
  return (page.controls || []).some((control) => {
    const operationNames = Object.keys(control.operations || {});
    if (!controlBelongsToCurrentSurface(control, page)) return false;
    if (!["option", "radio", "checkbox"].includes(lower(control.role || control.kind))
      && !operationNames.some((operation) => ["choose", "select"].includes(operation))) return false;
    return canonicalOptionMatch(semanticType, componentRole, desiredValue, {
      value: control.state?.optionValue || control.state?.selectedValue || control.currentValue || "",
      label: control.label || control.accessibleName || control.meaning || ""
    });
  });
}


function adaptiveSurfaceGoal({ previousTaskState = {}, actionResult = null, observation = {}, surface = {} } = {}) {
  if (!surface.id || surface.type === "page") return null;
  const previousGoal = taskMechanics(previousTaskState);
  const continuing = obligationField(previousGoal, "kind") === "adaptive_surface"
    && obligationField(previousGoal, "adaptiveEnvelope")?.surfaceId === surface.id;
  const entering = obligationField(previousGoal, "kind") === "profile_field"
    && (
      verifiedReversibleSurfaceEntry(actionResult || {})
      || verifiedTypedChoiceSurfaceEntry({
        actionResult: actionResult || {},
        previousGoal,
        observation,
        surface
      })
    );
  if (!continuing && !entering) return null;

  const sourceGoal = continuing
    ? (obligationField(previousGoal, "sourceGoal") || previousGoal)
    : previousGoal;
  const priorEnvelope = continuing ? obligationField(previousGoal, "adaptiveEnvelope") || {} : {};
  const priorQueryHistory = Array.isArray(priorEnvelope.queryHistory)
    ? priorEnvelope.queryHistory.map(clean).filter(Boolean)
    : [];
  const completedQuery = continuing
    && actionResult?.action?.operation === "type"
    && actionResult?.dispatched !== false
      ? clean(actionResult.action.value)
      : "";
  const queryHistory = [...new Set([
    ...priorQueryHistory,
    completedQuery
  ].filter(Boolean))].slice(-ADAPTIVE_SURFACE_MAX_STEPS);
  const consumedStep = continuing
    && actionResult?.action?.goalId === obligationField(previousGoal, "goalId")
    && actionResult?.dispatched !== false
      ? 1
      : 0;
  const remainingSteps = continuing
    ? Math.max(0, Number(priorEnvelope.remainingSteps || ADAPTIVE_SURFACE_MAX_STEPS) - consumedStep)
    : ADAPTIVE_SURFACE_MAX_STEPS;
  const now = Date.now();
  const deadlineAt = Number(priorEnvelope.deadlineAt || (now + ADAPTIVE_SURFACE_DEADLINE_MS));
  if (remainingSteps <= 0 || deadlineAt <= now) return null;

  const sourceGoalId = clean(obligationField(sourceGoal, "sourceGoalId") || obligationField(sourceGoal, "goalId"));
  const episodeId = clean(priorEnvelope.episodeId)
    || `${sourceGoalId || observation.observationId || "profile"}:surface:${surface.id}`;
  return Object.freeze({
    kind: "adaptive_surface",
    goalId: episodeId,
    sourceGoalId,
    semanticType: clean(obligationField(sourceGoal, "semanticType")),
    desiredValue: obligationField(sourceGoal, "desiredValue"),
    canonicalValue: obligationField(sourceGoal, "canonicalValue"),
    logicalFieldId: clean(obligationField(sourceGoal, "logicalFieldId")),
    subjectId: clean(obligationField(sourceGoal, "subjectId") || "traveler_1"),
    controlId: clean(obligationField(sourceGoal, "controlId")),
    componentRole: clean(obligationField(sourceGoal, "componentRole")),
    componentBinding: obligationField(sourceGoal, "componentBinding") || null,
    requirementContract: obligationField(sourceGoal, "requirementContract") || null,
    validationOwnership: obligationField(sourceGoal, "validationOwnership") || null,
    choiceTerms: Object.freeze([...(obligationField(sourceGoal, "choiceTerms") || [])]),
    sourceGoal: Object.freeze({
      kind: obligationField(sourceGoal, "kind") || "profile_field",
      goalId: sourceGoalId,
      semanticGoal: clean(obligationField(sourceGoal, "semanticGoal")),
      semanticType: clean(obligationField(sourceGoal, "semanticType")),
      desiredValue: obligationField(sourceGoal, "desiredValue"),
      canonicalValue: obligationField(sourceGoal, "canonicalValue"),
      logicalFieldId: clean(obligationField(sourceGoal, "logicalFieldId")),
      subjectId: clean(obligationField(sourceGoal, "subjectId") || "traveler_1"),
      controlId: clean(obligationField(sourceGoal, "controlId") || obligationField(sourceGoal, "componentBinding")?.controlId),
      componentRole: clean(obligationField(sourceGoal, "componentRole")),
      componentBinding: Object.freeze({
        controlId: clean(obligationField(sourceGoal, "componentBinding")?.controlId || obligationField(sourceGoal, "controlId")),
        representationControlIds: Object.freeze([...(obligationField(sourceGoal, "componentBinding")?.representationControlIds || [])]),
        stateControlIds: Object.freeze([...(obligationField(sourceGoal, "componentBinding")?.stateControlIds || [])])
      }),
      choiceTerms: Object.freeze([...(obligationField(sourceGoal, "choiceTerms") || [])].map(clean).filter(Boolean))
    }),
    semanticGoal: clean(obligationField(sourceGoal, "semanticGoal") || `complete the current ${surface.label || "choice"}`),
    selectionMode: "ai_ambiguity",
    surfaceId: surface.id,
    observationId: observation.observationId || "",
    postcondition: obligationField(sourceGoal, "postcondition") || {
      type: "profile_requirement_satisfied",
      semanticType: clean(obligationField(sourceGoal, "semanticType"))
    },
    adaptiveEnvelope: Object.freeze({
      kind: "bounded_adaptive_surface",
      episodeId,
      objective: clean(obligationField(sourceGoal, "semanticGoal")),
      desiredValue: obligationField(sourceGoal, "desiredValue"),
      queryHypotheses: priorEnvelope.queryHypotheses
        || boundedAdaptiveQueryHypotheses(sourceGoal),
      queryHistory: Object.freeze(queryHistory),
      surfaceId: surface.id,
      surfaceType: surface.type,
      allowedOperations: Object.freeze(["open", "choose", "activate", "type", "select", "keyboard"]),
      forbiddenRisks: Object.freeze(["money", "payment", "legal"]),
      forbiddenEffects: Object.freeze([
        "select_paid_option",
        "add_paid",
        "accept_legal",
        "submit_payment",
        "submit_purchase",
        "advance_checkout_stage"
      ]),
      remainingSteps,
      deadlineAt
    })
  });
}

module.exports = {
  adaptiveSurfaceGoal,
  createSurfaceSubgoal,
  durableOutcomeHierarchy,
  surfaceClassFrom
};
