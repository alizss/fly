const { conflictedControlIds } = require("./control-alias-index");
const { controlBelongsToCurrentSurface, currentSurface, surfaceBinding } = require("./surface-contract");
const { deriveActionSemantics } = require("./action-semantics");
const agentContract = require("../../extension/src/shared/agent-contract");


function slug(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function normalizedRisk(risk = "", operation = "", structuredPrice = null) {
  if (operation === "open" || operation === "keyboard") return "safe";
  if (structuredPrice && Number(structuredPrice.amount) === 0) return "safe";
  if (structuredPrice && Number(structuredPrice.amount) > 0) return "money";
  const value = String(risk || "").toLowerCase();
  if (/safe|decline|skip|continue|free|no[_ -]?(?:extra|protection|seat|bag)|without|none/.test(value)) return "safe";
  if (/payment/.test(value)) return "payment";
  if (/legal/.test(value)) return "legal";
  if (/paid|money|price/.test(value)) return "money";
  return "uncertain";
}

function profileChoiceQuery(goal = {}, control = {}) {
  const desired = String((goal?.desiredStateDelta?.desiredValue) ?? (goal?.canonicalValue) ?? "").trim();
  const digits = desired.replace(/\D/g, "");
  const query = (goal?.semanticType) === "phone_country_code" && digits
    ? digits
    : desired;
  const current = String(control.state?.normalizedValue || control.currentValue || "").trim();
  return query && query !== current ? query : "";
}

function requiredDecisionGroupsForCurrentSurface(page = {}) {
  const surface = currentSurface(page);
  return (page.decisionGroups || []).filter((group) => {
    if (group.required !== true) return false;
    if (surface.type === "page") {
      return !group.surfaceId || group.surfaceId === "surface-page" || group.surfaceType === "page";
    }
    return group.surfaceId === surface.id;
  });
}

function unresolvedRequiredDecisionGroups(page = {}, resolvedDecisionGroupIds = []) {
  const resolved = new Set((resolvedDecisionGroupIds || []).filter(Boolean).map(String));
  return requiredDecisionGroupsForCurrentSurface(page)
    .filter((group) => (
      !resolved.has(String(group.decisionGroupId || group.requirementId || ""))
      && !["satisfied", "waived", "waived_by_policy"].includes(group.status)
    ));
}

function allRequiredDecisionGroupsResolved(page = {}, resolvedDecisionGroupIds = []) {
  return unresolvedRequiredDecisionGroups(page, resolvedDecisionGroupIds).length === 0;
}

function operationActionType(operation = "") {
  if (["open", "choose", "activate"].includes(operation)) return "click";
  if (operation === "type") return "type";
  if (operation === "select") return "select";
  if (operation === "keyboard") return "keypress";
  return "click";
}

function intentFor(control = {}, operation = "", goal = {}) {
  const semantic = String(control.semantic || "").toLowerCase();
  const risk = String(control.risk || "").toLowerCase();
  const canonicalMeaningPublished = control.semanticAuthority === "decision-frame/v2";
  const meaning = canonicalMeaningPublished
    ? `${semantic} ${risk} ${control.physicalEffect || ""}`.toLowerCase()
    : `${semantic} ${risk} ${control.physicalEffect || ""} ${control.label || ""} ${control.accessibleName || ""}`.toLowerCase();
  if (operation === "open") return "open_choice_control";
  if (/decline|no[_ -]?(?:extra|protection|seat|bag)|without|skip|free|none/.test(meaning)) return "decline_optional_extra";
  // An explicit close/dismiss semantic remains a surface resolution even if
  // the airline gives that button the same visible label as checkout submit.
  if (semantic === "dismiss_surface" || /dialog close|close (?:dialog|modal|surface)/.test(String(control.meaning || "").toLowerCase())) {
    return "resolve_active_surface";
  }
  // The exact actuator's forward meaning outranks price or choice semantics
  // inherited from the surrounding section. This keeps a plain Next/Continue
  // button navigational without treating arbitrary nearby prose as an action.
  if (/\b(?:continue|next|proceed|advance)\b|navigation|safe_continue/.test(meaning)) return "navigate_stage";
  if (/navigation/.test(String((goal?.semanticType) || "").toLowerCase())) return "navigate_stage";
  if (control.surfaceType && control.surfaceType !== "page") return "resolve_active_surface";
  return "choose_option";
}

function opensChoiceControlFor(control = {}, operation = "") {
  return operation === "open"
    || /open_choice_control|open_surface/.test(
      `${control.semantic || ""} ${control.physicalEffect || ""}`.toLowerCase()
    )
    || /combobox|listbox/.test(`${control.kind || ""} ${control.role || ""} ${control.domRole || ""}`.toLowerCase())
    || control.hasPopup === true
    || Boolean(control.ariaHasPopup);
}

function isGlobalSiteChromeControl(control = {}) {
  if (control.globalChrome === true) return true;
  if (control.semanticAuthority === "decision-frame/v2") return false;
  const meaning = `${control.label || ""} ${control.accessibleName || ""} ${control.semantic || ""} ${control.stableKey || ""}`.toLowerCase();
  const utilityLabel = /\bopen sidebar\b|\bregional settings\b|\bcurrency (?:selector|switcher)\b|\bhelp(?:\s*&\s*| and )support\b|\bsign in\b|\bfeedback\b/.test(meaning);
  const utilityEffect = /open_surface|choice|unknown/.test(`${control.semantic || ""} ${control.physicalEffect || ""}`.toLowerCase());
  // Utility identity outranks accidental geometric section ownership. A
  // fixed Feedback/Help control does not become checkout UI merely because a
  // broad section band assigned it section and decision IDs.
  return utilityLabel && utilityEffect;
}

function exactActuatorHasPositivePrice(control = {}) {
  const labels = (control.actuators || [])
    .filter((actuator) => (
      ["state", "activation", "source"].includes(String(actuator.relation || ""))
      || String(actuator.relation || "").startsWith("operation:")
    ))
    .map((actuator) => String(actuator.label || "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const currency = "(?:EUR|USD|GBP|TRY|TL|CAD|AUD|CHF|JPY|CNY|€|\\$|£|¥|₺)";
  const amount = "(?:\\d[\\d\\s.,'’]*\\d|\\d)";
  const patterns = [
    new RegExp(`(${amount})\\s*${currency}`, "i"),
    new RegExp(`${currency}\\s*(${amount})`, "i")
  ];
  return labels.some((label) => patterns.some((pattern) => {
    const match = label.match(pattern);
    if (!match) return false;
    const numeric = String(match[1] || "").replace(/\D/g, "");
    return Boolean(numeric && Number(numeric) > 0);
  }));
}

function optionContractIsCoherent(control = {}) {
  const contract = control.choiceContract || null;
  if (contract?.ownershipComplete === false) return false;
  const controlEffect = String(control.physicalEffect || "unknown");
  const contractEffect = String(contract?.optionPhysicalEffect || controlEffect || "unknown");
  if (contractEffect !== "unknown" && controlEffect !== "unknown" && contractEffect !== controlEffect) return false;
  const price = contract?.structuredPrice || control.structuredPrice || null;
  const amount = Number(price?.amount);
  if (Number.isFinite(amount) && amount > 0 && controlEffect === "select_free_option") return false;
  if (Number.isFinite(amount) && amount === 0 && controlEffect === "select_paid_option") return false;
  const declaredFree = controlEffect === "select_free_option"
    || contractEffect === "select_free_option"
    || agentContract.canonicalSemanticEffect(control.semantic)
      === agentContract.SEMANTIC_EFFECT.SELECT_FREE_OPTION
    || /safe_decline/.test(`${control.risk || ""}`.toLowerCase())
    || (Number.isFinite(amount) && amount === 0);
  if (declaredFree && exactActuatorHasPositivePrice(control)) return false;
  return true;
}

function isObservedSafeProgressControl(control = {}) {
  if (Number(control.structuredPrice?.amount) > 0 || exactActuatorHasPositivePrice(control)) return false;
  const meaning = `${control.semantic || ""} ${control.physicalEffect || ""} ${control.meaning || ""} ${control.risk || ""}`.toLowerCase();
  if (/money|paid|purchase|payment|add_paid|select_paid/.test(meaning)) return false;
  return /continue|navigation|advance|next|proceed|dismiss_surface|safe_continue/.test(meaning);
}

function controlIsCurrentlySelected(control = {}) {
  return control.selected === true
    || control.state?.selected === true
    || control.state?.checked === true;
}

function controlsForGoal(page = {}, goal = {}) {
  const controls = (page.controls || []).filter((control) => {
    const meaning = `${control.semantic || ""} ${control.semanticType || ""} ${control.meaning || ""}`.toLowerCase();
    return !isGlobalSiteChromeControl(control)
      && optionContractIsCoherent(control)
      && !(/selection[_ -]?cta/.test(meaning) && !control.choiceContract);
  });
  if ((goal?.semanticType) === "completed_choice_surface") {
    const exactIds = new Set(((goal?.admittedControlIds) || []).filter(Boolean));
    return controls.filter((control) => exactIds.has(control.controlId));
  }
  if (["unknown_required", "unknown_validation", "unknown_attestation"].includes((goal?.kind))) {
    const exactIds = new Set(((goal?.admittedControlIds) || []).filter(Boolean));
    return controls.filter((control) => exactIds.has(control.controlId));
  }
  if ((goal?.kind) === "profile_field" && currentSurface(page).type !== "page") {
    return controls.filter((control) => controlBelongsToCurrentSurface(control, page));
  }
  if ((goal?.semanticType) === "surface_ambiguity" || (goal?.selectionMode) === "ai_ambiguity") {
    // Selected values are current state, not executable alternatives. If the
    // selected outcome still needs confirmation, its child surface owns the
    // next action; if it is complete, TaskState publishes the exact surface
    // exit instead of offering the same option again.
    return controls.filter((control) => !controlIsCurrentlySelected(control));
  }
  const policyAllowedIds = new Set(((goal?.admittedControlIds) || []).filter(Boolean));
  const exactUnselectIds = new Set(
    goal?.desiredStateDelta?.desiredState === "unselected"
      ? [...policyAllowedIds]
      : []
  );
  const provenFreeIds = ((goal?.freeAlternativeControlIds) || []).filter((controlId) => (
    !policyAllowedIds.size || policyAllowedIds.has(controlId)
  ));
  const provenSafeProgressIds = controls.filter((control) => (
    policyAllowedIds.has(control.controlId)
    && isObservedSafeProgressControl(control)
  )).map((control) => control.controlId);
  // A correction opener is an admitted intermediate mechanic for the same
  // obligation. It need not itself be the eventual free option; opening its
  // owned choice surface is how that option becomes observable.
  const correctionIds = ((goal?.semanticCorrectionControlIds) || []).filter((controlId) => (
    !policyAllowedIds.size || policyAllowedIds.has(controlId)
  ));
  const policyExactIds = agentContract.canonicalSemanticEffect((goal?.desiredPolicyOutcome))
    === agentContract.SEMANTIC_EFFECT.SELECT_FREE_OPTION
    ? [...new Set([...exactUnselectIds, ...provenFreeIds, ...provenSafeProgressIds, ...correctionIds])]
    : (goal?.policyChoiceBounded) === true
      ? (goal?.admittedControlIds)
      : (goal?.eligibleAlternativeControlIds);
  const exactEligibleIds = new Set((policyExactIds || []).filter(Boolean));
  if ((goal?.decisionGroupId) && (goal?.policyChoiceBounded) === true && exactEligibleIds.size === 0) {
    return [];
  }
  if ((goal?.decisionGroupId) && exactEligibleIds.size) {
    return controls.filter((control) => exactEligibleIds.has(control.controlId));
  }
  const group = (page.decisionGroups || []).find((item) => item.decisionGroupId === (goal?.decisionGroupId)) || null;
  if (!group) {
    const directlyOwned = (goal?.decisionGroupId)
      ? controls.filter((control) => control.decisionGroupId === (goal?.decisionGroupId))
      : [];
    if (directlyOwned.length) return directlyOwned;
    const authoritativeNavigationIds = new Set(((goal?.admittedControlIds) || []).filter(Boolean));
    if ((goal?.semanticType) === "navigation" && authoritativeNavigationIds.size) {
      return controls.filter((control) => authoritativeNavigationIds.has(control.controlId));
    }
    const completedDecisionGroupId = String((goal?.completedDecisionGroupId) || "");
    if ((goal?.semanticType) === "navigation" && !allRequiredDecisionGroupsResolved(page, [completedDecisionGroupId])) return [];
    return controls.filter((control) => {
      const text = `${control.semantic || ""} ${control.risk || ""} ${control.meaning || ""} ${control.label || ""}`.toLowerCase();
      if (/selection[_ -]?cta/.test(text) && !control.choiceContract) return false;
      if (/\bback\b|previous|go back|price|details|learn more|info(?:rmation)?|edit|change/.test(text)) return false;
      if (/choose|select|pick/.test(text) && /seat|bag|bundle|extra|upgrade/.test(text)) return false;
      if (Number(control.structuredPrice?.amount) > 0 || /add_paid|money|purchase|premium|upgrade/.test(text)) return false;
      const forward = /navigation|safe_continue|continue|next|proceed|advance|done|finish|confirm|close|dismiss/.test(text);
      const newSurfaceCommand = Boolean(
        completedDecisionGroupId
        && control.decisionGroupId
        && control.decisionGroupId !== completedDecisionGroupId
        && /no thanks|without|decline|skip/.test(text)
      );
      return forward || newSurfaceCommand;
    });
  }
  const groupControlIds = new Set([
    ...(group.alternativeControlIds || []),
    ...(group.alternatives || []).map((item) => item.controlId)
  ].filter(Boolean));
  const hasExactGroupMembers = groupControlIds.size > 0;
  return controls.filter((control) => (
    control.decisionGroupId === group.decisionGroupId
    || groupControlIds.has(control.controlId)
    || (!hasExactGroupMembers && group.sectionId && control.sectionId === group.sectionId)
    || (!hasExactGroupMembers && !group.sectionId && group.sectionType && control.sectionType === group.sectionType)
  ));
}

function rawObservationCandidates(observation = {}, goal = {}) {
  const page = observation.page || {};
  const observationId = observation.observationId || "observation";
  const surface = currentSurface(page);
  const foreground = surface.type !== "page" ? surface : null;
  const ambiguousControlIds = conflictedControlIds(page);
  const parentSurfaceControlIds = new Set(
    (goal?.semanticType) === "completed_choice_surface"
      ? ((goal?.admittedControlIds) || []).filter(Boolean)
      : []
  );
  const controls = controlsForGoal(page, goal).filter((control) => (
    !ambiguousControlIds.has(control.controlId)
    && (
      controlBelongsToCurrentSurface(control, page)
      || parentSurfaceControlIds.has(control.controlId)
    )
  ));
  const raw = [];
  const freeAlternativeIds = new Set(((goal?.freeAlternativeControlIds) || []).filter(Boolean));
  const exactUnselectIds = new Set(
    goal?.desiredStateDelta?.desiredState === "unselected"
      ? ((goal?.admittedControlIds) || []).filter(Boolean)
      : []
  );
  const paidAlternativeIds = new Set(((goal?.paidAlternativeControlIds) || []).filter(Boolean));
  const semanticCorrectionIds = new Set(((goal?.semanticCorrectionControlIds) || []).filter(Boolean));
  const profileChildSurface = (goal?.kind) === "profile_field" && surface.type !== "page";
  for (const control of controls) {
    const exactChoiceDiscovery = goal?.desiredStateDelta?.status === "EXACT_DELTA"
      && goal?.desiredStateDelta?.desiredState === "options_surface_visible"
      && goal?.desiredStateDelta?.desiredEffect === "open"
      && (goal?.admittedControlIds || []).includes(control.controlId);
    const operationEntries = [...new Set([
      ...Object.keys(control.operations || {})
    ])];
    const usable = operationEntries.flatMap((operation) => {
      const rawCapability = control.operations?.[operation] || null;
      const capability = agentContract.normalizeCapability(control, operation, rawCapability);
      return (capability.strategies || [])
        .filter((strategy) => (
          strategy.actuatorId
          && (
            [
              agentContract.CAPABILITY_STATUS.PROVEN_EXECUTABLE,
              agentContract.CAPABILITY_STATUS.RECOVERABLE
            ].includes(strategy.status)
            || (
              exactChoiceDiscovery
              && operation === "open"
              && strategy.status === agentContract.CAPABILITY_STATUS.UNPROVEN_EXPERIMENT
              && capability.requiresVisualConfirmation === true
            )
          )
        ))
        .map((strategy) => ({
          operation,
          capability,
          strategy,
          boundedRecovery: exactChoiceDiscovery
            && operation === "open"
            && strategy.status === agentContract.CAPABILITY_STATUS.UNPROVEN_EXPERIMENT
        }));
    });
    for (const { operation, capability, strategy, boundedRecovery } of usable) {
      if (!["open", "choose", "activate", "keyboard", ...(profileChildSurface ? ["type", "select"] : [])].includes(operation)) continue;
      const mechanicalQuery = profileChildSurface && operation === "type"
        ? profileChoiceQuery(goal, control)
        : "";
      if (profileChildSurface && operation === "type" && !mechanicalQuery) continue;
      const completesChoiceSurface = (goal?.semanticType) === "completed_choice_surface"
        && parentSurfaceControlIds.has(control.controlId);
      if (completesChoiceSurface && !["activate", "open"].includes(operation)) continue;
      const actionability = strategy.proof || capability.actionability || {};
      const visible = actionability.executable === true
        || (boundedRecovery && actionability.visible === true);
      const actionType = strategy.actionType || operationActionType(operation);
      const targetId = strategy.actuatorId;
      if (!targetId) continue;
      const interpretedFree = (freeAlternativeIds.has(control.controlId) || exactUnselectIds.has(control.controlId))
        && (
          agentContract.canonicalSemanticEffect((goal?.desiredPolicyOutcome))
            === agentContract.SEMANTIC_EFFECT.SELECT_FREE_OPTION
          || (goal?.policyChoiceBounded) === true
        );
      const interpretedPaid = paidAlternativeIds.has(control.controlId);
      const paidAuthorization = interpretedPaid && (goal?.desiredStateDelta?.authorization)?.authorizationId
        ? (goal?.desiredStateDelta?.authorization)
        : null;
      const resolvedSemanticCorrection = (page.semanticOwnershipLinks || []).find((link) => (
        link.status === "resolved"
        && link.sourceDecisionGroupId === (goal?.decisionGroupId)
        && link.correctionControlId === control.controlId
      )) || null;
      const semanticCorrection = resolvedSemanticCorrection
        || (semanticCorrectionIds.has(control.controlId) && opensChoiceControlFor(control, operation) ? {
            linkId: "",
            sourceDecisionGroupId: (goal?.decisionGroupId),
            correctionDecisionGroupId: control.decisionGroupId || (goal?.decisionGroupId),
            correctionControlId: control.controlId,
            intendedOutcome: "open_correction_surface"
          } : null);
      const opensChoiceControl = !completesChoiceSurface && opensChoiceControlFor(control, operation);
      const candidateIntent = completesChoiceSurface
        ? "dismiss_completed_choice_surface"
        : semanticCorrection
        ? "reconcile_policy_conflict"
        : interpretedFree
        ? "decline_optional_extra"
        : intentFor(control, operation, goal);
      const physicalEffect = completesChoiceSurface
        ? "dismiss_surface"
        : opensChoiceControl
        ? "open_surface"
        : semanticCorrection
        ? (control.physicalEffect || "unknown")
        : interpretedFree
        ? "select_free_option"
          : interpretedPaid
          ? "select_paid_option"
          : candidateIntent === "navigate_stage"
            ? (["dismiss_surface", "open_surface", "advance_surface", "advance_checkout_stage"].includes(control.physicalEffect)
              ? control.physicalEffect
              : (
                control.physicalEffect === "advance_checkout_stage"
                || !foreground
                || (goal?.semanticType) === "card_credential_entry"
                  ? "advance_checkout_stage"
                  : "advance_surface"
              ))
          : (control.physicalEffect || "");
      // Keep paid controls as non-selectable diagnostic context. Typed policy
      // below owns admission to the finite model-selectable candidate set,
      // even when an airline's price text is unfamiliar or failed to parse.
      const observedRisk = normalizedRisk(control.risk, operation, control.structuredPrice);
      const risk = completesChoiceSurface
        ? "safe"
        : opensChoiceControl
        ? "safe"
        : semanticCorrection
        ? "safe"
        : interpretedFree
        ? "safe"
        : interpretedPaid
          ? "money"
          // Structured observer risk is authoritative. Semantic/label text may
          // fill an unknown value, but it must never reclassify an exact fact.
          : observedRisk !== "uncertain"
            ? observedRisk
            : normalizedRisk(control.semanticAuthority === "decision-frame/v2"
              ? control.semantic || ""
              : `${control.semantic || ""} ${control.label || ""}`, operation, control.structuredPrice);
      const rawChoiceLike = /choice|option|radio|checkbox/.test(
        `${control.kind || ""} ${control.role || ""} ${control.semantic || ""}`.toLowerCase()
      );
      const semantics = completesChoiceSurface
        ? { interactionRole: "command", semanticEffect: "waive", expectedEvidence: "dismissed" }
        : semanticCorrection
        ? deriveActionSemantics({ control, operation, type: actionType, goal })
        : !opensChoiceControl && (interpretedFree || interpretedPaid) && rawChoiceLike
        ? { interactionRole: "choice", semanticEffect: "select", expectedEvidence: "selected" }
        : interpretedFree && foreground && operation === "activate"
          ? { interactionRole: "command", semanticEffect: "waive", expectedEvidence: "dismissed" }
          : deriveActionSemantics({ control, operation, type: actionType, goal });
      raw.push({
        candidateId: "",
        semanticGoal: (goal?.objective),
        semantic: completesChoiceSurface
          ? "dismiss_completed_choice_surface"
          : opensChoiceControl ? "open_choice_control" : (interpretedFree ? "select_free_option" : (control.semantic || operation)),
        physicalEffect,
        policyOutcome: completesChoiceSurface
          ? "completed_decision_surface_dismissed"
          : semanticCorrection ? "proposed_policy_correction" : (interpretedFree ? agentContract.SEMANTIC_EFFECT.SELECT_FREE_OPTION : (interpretedPaid ? agentContract.SEMANTIC_EFFECT.SELECT_PAID_OPTION : "selected_policy_allowed_option")),
        intendedOutcome: semanticCorrection?.intendedOutcome || (
          interpretedFree ? ((goal?.desiredSemanticOutcome) || "") : ""
        ),
        semanticOwnershipLinkId: semanticCorrection?.linkId || "",
        policyCorrectionForDecisionGroupId: semanticCorrection?.sourceDecisionGroupId || "",
        observedSemantic: control.semantic || "unknown",
        semanticAuthority: control.semanticAuthority || "",
        observedPhysicalEffect: control.physicalEffect || "unknown",
        observedRisk: control.risk || "uncertain",
        stableKey: control.stableKey || `control:${control.controlId}`,
        meaning: control.meaning || control.semantic || control.accessibleName || control.label || operation,
        structuredPrice: control.structuredPrice || null,
        authorization: paidAuthorization,
        approvedPaidAction: Boolean(paidAuthorization),
        type: actionType,
        operation,
        interactionMethod: strategy.method || "",
        authorizedOperation: operation,
        actionability,
        ...semantics,
        controlId: control.controlId,
        decisionGroupId: (goal?.decisionGroupId) || control.decisionGroupId || "",
        targetId,
        targetLabel: control.label || control.accessibleName || control.semantic || operation,
        requirementId: (goal?.requirementId) || "",
        intent: candidateIntent,
        expectedOutcome: mechanicalQuery ? {
          type: "normalized_value_changed",
          controlId: control.controlId,
          semanticType: (goal?.semanticType) || "",
          previousValue: String(control.state?.normalizedValue || control.currentValue || ""),
          expectedNormalizedValue: mechanicalQuery,
          canonicalTarget: String((goal?.desiredStateDelta?.desiredValue) ?? (goal?.canonicalValue) ?? ""),
          surfaceId: surface.id || "",
          mustNotIncreasePrice: true
        } : completesChoiceSurface ? {
          type: "active_surface_dismissed",
          controlId: control.controlId,
          decisionGroupId: (goal?.parentDecisionGroupId) || (goal?.decisionGroupId) || "",
          previousSurfaceId: surface.id || "",
          surfaceId: surface.id || "",
          parentDecisionGroupId: (goal?.parentDecisionGroupId) || (goal?.decisionGroupId) || "",
          parentExpectedSelectedControlId: (goal?.parentSelectedControlId) || "",
          decisionEpisodeId: (goal?.decisionEpisodeId) || "",
          mustNotIncreasePrice: true
        } : semanticCorrection ? {
          type: semanticCorrection.intendedOutcome === "open_correction_surface"
            ? "options_surface_appeared"
            : "policy_conflict_resolved",
          decisionGroupId: (goal?.decisionGroupId),
          controlId: control.controlId,
          semanticOwnershipLinkId: semanticCorrection.linkId,
          correctionDecisionGroupId: semanticCorrection.correctionDecisionGroupId || control.decisionGroupId || "",
          intendedOutcome: semanticCorrection.intendedOutcome || "unknown",
          beforePriceAmount: Number.isFinite(Number(page.price?.amount)) ? Number(page.price.amount) : null,
          beforePriceText: page.priceText || "",
          mustNotIncreasePrice: true
        } : boundedRecovery ? {
          type: "options_surface_appeared",
          controlId: control.controlId,
          decisionGroupId: (goal?.decisionGroupId) || control.decisionGroupId || "",
          previousSurfaceId: surface.id || "",
          surfaceId: surface.id || "",
          mustNotIncreasePrice: true
        } : ((goal?.parentDecisionGroupId)
          && (goal?.parentExpectedSelectedControlId)
          && interpretedFree ? {
          type: "exact_free_option_selected",
          parentDecisionGroupId: (goal?.parentDecisionGroupId),
          parentExpectedSelectedControlId: (goal?.parentExpectedSelectedControlId) || "",
          decisionEpisodeId: (goal?.decisionEpisodeId) || "",
          childSurfaceId: surface.id || "",
          requireChildSurfaceDismissed: true,
          mustNotIncreasePrice: true
        } : null),
        risk,
        requiresApproval: ["money", "payment", "legal"].includes(risk) && !paidAuthorization,
        visible,
        value: mechanicalQuery || (profileChildSurface && operation === "select"
          ? String((goal?.desiredStateDelta?.desiredValue) ?? (goal?.canonicalValue) ?? "")
          : ""),
        canonicalTarget: profileChildSurface
          ? String((goal?.desiredStateDelta?.desiredValue) ?? (goal?.canonicalValue) ?? "")
          : "",
        boundedRecovery: Boolean(boundedRecovery),
        mechanicalHypothesis: Boolean(mechanicalQuery || boundedRecovery),
        keys: strategy.keys || (operation === "keyboard" ? "ArrowDown" : ""),
        needsReveal: !visible && actionability.revealable === true,
        summary: `${operation} the current ${control.label || control.semantic || "control"}${visible ? "." : " after revealing it."}`
      });
    }
  }

  if (!raw.length
    && (goal?.semanticType) !== "surface_ambiguity"
    && !((goal?.semanticType) === "navigation" && !allRequiredDecisionGroupsResolved(page, [(goal?.completedDecisionGroupId)]))) {
    const cardEntry = (goal?.semanticType) === "card_credential_entry";
    raw.push({
      candidateId: "",
      semanticGoal: (goal?.objective),
      semantic: cardEntry ? "final_review" : "ask_user",
      type: cardEntry ? "final_review" : "ask_user",
      operation: cardEntry ? "review" : "handoff",
      interactionRole: "navigation",
      semanticEffect: "advance",
      expectedEvidence: "progress_changed",
      controlId: "",
      decisionGroupId: (goal?.decisionGroupId) || "",
      targetId: "",
      targetLabel: "",
      requirementId: (goal?.requirementId) || "",
      intent: cardEntry ? "final_review" : "ask_user",
      risk: cardEntry ? "safe" : "uncertain",
      requiresApproval: !cardEntry,
      visible: true,
      value: "",
      keys: "",
      summary: cardEntry ? "Stop because actual card credential entry is ready." : "Ask the user because no current grounded control can satisfy the goal."
    });
  }

  return raw.map((candidate, index) => ({
    ...candidate,
    candidateId: `${observationId}:candidate_${index + 1}`
  }));
}

function buildObservationCandidateSet(goal = {}, observation = {}) {
  return { ...surfaceBinding(observation), candidates: rawObservationCandidates(observation, goal) };
}

module.exports = {
  allRequiredDecisionGroupsResolved,
  buildObservationCandidateSet,
  requiredDecisionGroupsForCurrentSurface,
  unresolvedRequiredDecisionGroups,
  rawObservationCandidates
};
