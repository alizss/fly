import { currentNavigationUrl, sanitizedNavigationUrl } from "../navigation-identity.js";

export function createOutcomeVerification({
  AGENT_CONTRACT,
  actionableCheckoutErrors,
  boundedPhrase,
  buildPageMap,
  buttonText,
  canonicalProfileFieldType,
  canonicalSelectionCommitments,
  compactText,
  currentElementValue,
  declineChoiceIntent,
  elementById,
  elementId,
  isStageExitDecision,
  isVisible,
  labelText,
  liveSectionForElement,
  logFlow,
  lookupControlForElement,
  normalizeMatchText,
  normalizedFieldAlias,
  normalizedProfileChoiceValue,
  observationHashForMap,
  pageSignature,
  structuralPageSignature,
  unfilledRequiredFields,
  visualPageState
}) {
  function stageExitBlockers(map = buildPageMap(), decision = {}) {
    const blockers = [];
    const currentSurface = map.currentSurface || { type: "page" };
    const surfaceActive = Boolean(currentSurface.type && currentSurface.type !== "page");
    const targetControlId = decision.controlId || decision.targetSnapshot?.controlId || "";
    const targetControl = targetControlId
      ? (map.controls || []).find((control) => control.controlId === targetControlId)
      : null;
    const targetIsActiveSurfaceNavigation = Boolean(
      surfaceActive
      && targetControl?.surfaceId
      && targetControl.surfaceId === currentSurface.id
    );
    const overlays = (map.overlays || []).filter((overlay) => overlay?.label || overlay?.text);
    if (overlays.length && !targetIsActiveSurfaceNavigation) {
      blockers.push({
        code: "ACTIVE_SURFACE_PRESENT",
        message: "A visible popup/dropdown/modal is still active."
      });
    }
    const errors = surfaceActive
      ? actionableCheckoutErrors(currentSurface.errors || [])
      : actionableCheckoutErrors(map.errors || []);
    if (errors.length) {
      blockers.push({
        code: "VISIBLE_VALIDATION_ERRORS",
        message: errors.slice(0, 2).join("; ")
      });
    }
    if (!surfaceActive) {
      const unresolvedGroup = (map.decisionGroups || []).find((group) => group.required && !["satisfied", "waived", "waived_by_policy"].includes(group.status));
      if (unresolvedGroup) {
        blockers.push({
          code: "UNRESOLVED_DECISION_GROUP",
          message: `${unresolvedGroup.sectionLabel || unresolvedGroup.requirementId || "A visible choice"} still needs a verified decision.`
        });
      }
      const unresolvedField = unfilledRequiredFields(map.fields || [])[0];
      if (unresolvedField) blockers.push({
        code: "REQUIRED_FIELD_EMPTY",
        message: `${unresolvedField.label || unresolvedField.field || "A required field"} is empty.`
      });
    }
    return blockers;
  }

  function expectedOutcomeForDecision(decision = {}, map = buildPageMap(), target = null) {
    const targetId = target ? elementId(target) : decision.targetId || "";
    const targetControl = target ? lookupControlForElement(map, target) : null;
    const snapshotControlId = decision.controlId || decision.targetSnapshot?.controlId || targetControl?.controlId || "";
    const label = decision.targetLabel || decision.value || (target ? buttonText(target) || labelText(target) || target.innerText || "" : "");
    const section = target ? liveSectionForElement(map, target) : null;
    const activeSurface = map.currentSurface || {};
    const base = {
      action: decision.action || "",
      targetId,
      controlId: snapshotControlId,
      stateElementId: decision.targetSnapshot?.stateElementId || targetControl?.stateElementId || "",
      targetLabel: String(label || "").replace(/\s+/g, " ").trim().slice(0, 180),
      beforeSignature: structuralPageSignature(map),
      beforeUrl: map.url || currentNavigationUrl(),
      beforeVisualState: visualPageState(map),
      policyAuthorized: Boolean(
        decision.policy?.allow === true
        || decision.policyDecision?.allow === true
        || decision.affordance?.policy?.allow === true
      )
    };
    const activeForegroundSurface = activeSurface?.type && activeSurface.type !== "page" ? activeSurface : null;
    const foregroundDecline = activeForegroundSurface && (
      declineChoiceIntent(decision)
      || /decline|safe_decline/.test(`${decision.intent || ""} ${decision.targetSnapshot?.semantic || ""} ${decision.targetSnapshot?.risk || ""}`)
    );
    const choiceSurface = /dropdown|listbox|popover|menu/.test(String(activeForegroundSurface?.type || targetControl?.surfaceType || decision.targetSnapshot?.surfaceType || "").toLowerCase());
    const foregroundChoiceSelection = Boolean(
      /choice|radio|checkbox|option/.test(String(targetControl?.kind || targetControl?.role || decision.targetSnapshot?.kind || "").toLowerCase())
      || (choiceSurface && (targetControl?.decisionGroupId || decision.decisionGroupId || decision.targetSnapshot?.decisionGroupId))
    );
    if (decision.expectedOutcome && typeof decision.expectedOutcome === "object") {
      if (foregroundDecline && !foregroundChoiceSelection && decision.expectedOutcome.type === "requirement_status") {
        return {
          ...base,
          ...decision.expectedOutcome,
          type: "active_surface_dismissed",
          surfaceId: activeForegroundSurface.id || decision.expectedOutcome.surfaceId || decision.targetSnapshot?.surfaceId || "",
          surfaceType: activeForegroundSurface.type || decision.targetSnapshot?.surfaceType || "",
          surfaceLabel: activeForegroundSurface.label || decision.targetSnapshot?.surfaceLabel || "",
          surfaceSignature: activeForegroundSurface.signature || pageSignature(map),
          mustNotIncreasePrice: true
        };
      }
      return { ...base, ...decision.expectedOutcome };
    }
    if (decision.action === "type" || decision.action === "select") {
      return {
        ...base,
        type: "field_value_changed",
        expectedValue: decision.value || ""
      };
    }
    if (decision.action === "click" || decision.action === "click_xy") {
      const button = (map.buttons || []).find((item) => item.id === decision.targetId || item.id === targetId);
      if (button?.risk === "safe_continue" || isStageExitDecision(decision, map)) {
        return {
          ...base,
          type: "stage_exit_or_feedback",
          blockersBefore: stageExitBlockers(map, decision)
        };
      }
      if (activeSurface.type && activeSurface.type !== "page") {
        if (foregroundDecline && !foregroundChoiceSelection) {
          return {
            ...base,
            type: "active_surface_dismissed",
            surfaceId: activeSurface.id || "",
            surfaceType: activeSurface.type,
            surfaceLabel: activeSurface.label || "",
            surfaceSignature: `${activeSurface.type || ""}:${activeSurface.id || ""}:${activeSurface.label || ""}:${(activeSurface.options || []).map((entry) => entry.id).join(",")}`
          };
        }
        if (foregroundChoiceSelection) {
          return {
            ...base,
            type: "control_selected",
            decisionGroupId: targetControl?.decisionGroupId || ""
          };
        }
        return {
          ...base,
          type: "active_surface_change",
          surfaceType: activeSurface.type,
          surfaceLabel: activeSurface.label || "",
          surfaceSignature: `${activeSurface.type || ""}:${activeSurface.label || ""}:${(activeSurface.options || []).map((entry) => entry.id).join(",")}`
        };
      }
      if (section?.type) {
        return {
          ...base,
          type: "section_choice_verified",
          sectionId: section.id || "",
          sectionType: section.type || "",
          sectionLabel: section.label || ""
        };
      }
    }
    return {
      ...base,
      type: "observable_change"
    };
  }

  function verifyExpectedOutcome(expected = {}, beforeMap = buildPageMap(), afterMap = buildPageMap(), target = null) {
    const startedAt = performance.now();
    const verification = verifyExpectedOutcomeInternal(expected, beforeMap, afterMap, target);
    const feedback = transitionFeedbackForMaps(expected, beforeMap, afterMap, target, verification);
    logFlow("latency.span", {
      outcome_verification_ms: Math.round(performance.now() - startedAt),
      expectedOutcome: expected?.type || "",
      target: expected?.targetId || expected?.controlId || expected?.targetLabel || ""
    });
    return { ...verification, feedback };
  }

  function transitionFeedbackForMaps(expected = {}, beforeMap = {}, afterMap = {}, target = null, verification = {}) {
    const controlId = expected.controlId || expected.targetSnapshot?.controlId || "";
    const beforeControl = controlId ? (beforeMap.controls || []).find((control) => control.controlId === controlId) : null;
    const afterControl = controlId ? (afterMap.controls || []).find((control) => control.controlId === controlId) : null;
    const beforeControlState = beforeControl?.state || beforeControl?.controlState || {};
    const afterControlState = afterControl?.state || afterControl?.controlState || {};
    const controlChanged = JSON.stringify({
      selected: Boolean(beforeControl?.selected || beforeControlState.selected || beforeControlState.checked),
      value: beforeControlState.normalizedValue || beforeControlState.value || "",
      expanded: beforeControlState.expanded
    }) !== JSON.stringify({
      selected: Boolean(afterControl?.selected || afterControlState.selected || afterControlState.checked),
      value: afterControlState.normalizedValue || afterControlState.value || "",
      expanded: afterControlState.expanded
    });
    const decisionGroupId = expected.decisionGroupId || beforeControl?.decisionGroupId || afterControl?.decisionGroupId || "";
    const beforeGroup = decisionGroupId ? (beforeMap.decisionGroups || []).find((group) => group.decisionGroupId === decisionGroupId) : null;
    const afterGroup = decisionGroupId ? (afterMap.decisionGroups || []).find((group) => group.decisionGroupId === decisionGroupId) : null;
    const selectionChanged = Boolean(
      (beforeGroup || afterGroup)
      && `${beforeGroup?.selectedControlId || ""}:${beforeGroup?.status || ""}` !== `${afterGroup?.selectedControlId || ""}:${afterGroup?.status || ""}`
    ) || Boolean(controlChanged && (
      beforeControl?.selected !== afterControl?.selected
      || beforeControlState.checked !== afterControlState.checked
      || beforeControlState.normalizedValue !== afterControlState.normalizedValue
    ));
    const beforeSurface = beforeMap.currentSurface || {};
    const afterSurface = afterMap.currentSurface || {};
    const surfaceChanged = `${beforeSurface.id || ""}:${beforeSurface.type || "page"}:${beforeSurface.label || ""}`
      !== `${afterSurface.id || ""}:${afterSurface.type || "page"}:${afterSurface.label || ""}`;
    const beforeProgress = beforeMap.foreground?.progressMarkers || beforeMap.visualState?.foreground?.progressMarkers || beforeSurface.foreground?.progressMarkers || null;
    const afterProgress = afterMap.foreground?.progressMarkers || afterMap.visualState?.foreground?.progressMarkers || afterSurface.foreground?.progressMarkers || null;
    const progressChanged = JSON.stringify(beforeProgress) !== JSON.stringify(afterProgress);
    const beforeErrors = [
      ...actionableCheckoutErrors(beforeMap.errors || []),
      ...(beforeMap.validationIssues || []).map((issue) => issue.message).filter(Boolean)
    ];
    const afterErrors = [
      ...actionableCheckoutErrors(afterMap.errors || []),
      ...(afterMap.validationIssues || []).map((issue) => issue.message).filter(Boolean)
    ];
    const validationAppeared = afterErrors.some((error) => !beforeErrors.includes(error));
    const beforePrice = `${beforeMap.price?.amount ?? ""}:${beforeMap.price?.currency || ""}:${beforeMap.priceText || ""}`;
    const afterPrice = `${afterMap.price?.amount ?? ""}:${afterMap.price?.currency || ""}:${afterMap.priceText || ""}`;
    const domChanged = structuralPageSignature(beforeMap) !== structuralPageSignature(afterMap);
    const beforeVisual = visualPageState(beforeMap);
    const afterVisual = visualPageState(afterMap);
    const visualChanged = beforeVisual?.fingerprint !== afterVisual?.fingerprint;
    const currentUrl = currentNavigationUrl();
    const navigationOccurred = beforeMap.step !== afterMap.step || (beforeMap.url || currentUrl) !== (afterMap.url || currentUrl);
    const beforeOverlay = Boolean(beforeSurface.type && beforeSurface.type !== "page");
    const afterOverlay = Boolean(afterSurface.type && afterSurface.type !== "page");
    const overlayAppeared = Boolean(afterOverlay && (!beforeOverlay || surfaceChanged));
    const targetFound = Boolean(target || beforeControl);
    const targetVisible = Boolean((target && isVisible(target)) || (beforeControl && beforeControl.visualRegion?.inViewport !== false));
    const targetReacted = Boolean(controlChanged || selectionChanged || surfaceChanged || progressChanged || navigationOccurred || validationAppeared || (!afterControl && beforeControl));
    return {
      dispatched: true,
      targetFound,
      targetVisible,
      dispatchSucceeded: true,
      targetReacted,
      selectionChanged,
      surfaceChanged,
      progressChanged,
      domChanged,
      visualChanged,
      navigationOccurred,
      overlayAppeared,
      validationAppeared,
      priceChanged: beforePrice !== afterPrice,
      outcomeVerified: verification.ok === true
    };
  }

  function withOverlayProgressEvidence(verification = {}, progress = {}) {
    const existingEvidence = verification.evidence && typeof verification.evidence === "object" && !Array.isArray(verification.evidence)
      ? verification.evidence
      : { verifierEvidence: verification.evidence || null };
    return {
      ...verification,
      evidence: {
        ...existingEvidence,
        overlayProgress: {
          ok: Boolean(progress.ok),
          reason: String(progress.reason || "")
        }
      }
    };
  }

  function compactChoiceCommitEvidence(commit = null) {
    if (!commit || typeof commit !== "object") return null;
    const compactEpisode = (episode = null) => {
      if (!episode || typeof episode !== "object") return null;
      return {
        activeChoiceSurface: Boolean(episode.activeChoiceSurface),
        expanded: Boolean(episode.expanded),
        visibleChoiceSurfaceCount: Number(episode.visibleChoiceSurfaceCount || 0),
        popupOpen: Boolean(episode.popupOpen),
        focusInsideTarget: Boolean(episode.focusInsideTarget),
        activeElementId: String(episode.activeElementId || ""),
        surfaceId: String(episode.surfaceId || ""),
        surfaceType: String(episode.surfaceType || "page"),
        continueDisabled: episode.continueDisabled === true
      };
    };
    const compactKeyResult = (result = null) => {
      if (!result || typeof result !== "object") return null;
      return {
        ok: result.ok === true,
        code: String(result.code || ""),
        error: compactText(result.error || "", 240)
      };
    };
    return {
      ok: commit.ok === true,
      code: String(commit.code || ""),
      controlId: String(commit.controlId || ""),
      actuatorId: String(commit.actuatorId || ""),
      desiredLabel: compactText(commit.desiredLabel || "", 160),
      popupClosed: commit.popupClosed === true,
      focusSettled: commit.focusSettled === true,
      escapeAttempted: commit.escapeAttempted === true,
      tabAttempted: commit.tabAttempted === true,
      escapeResult: compactKeyResult(commit.escapeResult),
      tabResult: compactKeyResult(commit.tabResult),
      beforeCleanup: compactEpisode(commit.beforeCleanup),
      afterEscape: compactEpisode(commit.afterEscape),
      afterCleanup: compactEpisode(commit.afterCleanup)
    };
  }

  function exactChildChoiceSettlementEvidence(verification = {}, commit = null, expected = {}, decision = {}) {
    if (!commit || expected.type !== "logical_component_committed" || verification.ok === true) return null;
    const evidence = verification.evidence && typeof verification.evidence === "object" && !Array.isArray(verification.evidence)
      ? verification.evidence
      : {};
    const semanticType = canonicalProfileFieldType(expected.semanticType || "") || String(expected.semanticType || "");
    const desiredCanonicalValue = String(
      expected.expectedCanonicalValue
      || expected.expectedNormalizedValue
      || expected.expectedComponentValue
      || ""
    );
    const selectedCanonicalValue = String(
      decision.value
      || decision.targetLabel
      || commit.desiredLabel
      || ""
    );
    const ownedValidationErrors = Array.isArray(evidence.ownedValidationErrors)
      ? evidence.ownedValidationErrors
      : null;
    const validationClear = Boolean(ownedValidationErrors && ownedValidationErrors.length === 0);
    const exactCompatibleChoice = AGENT_CONTRACT?.profileChoiceValueCompatible?.(
      selectedCanonicalValue,
      desiredCanonicalValue,
      semanticType
    ) === true;
    const actualNormalizedValue = String(evidence.actualNormalizedValue || "");
    const settled = Boolean(
      verification.code === "LOGICAL_COMPONENT_NOT_COMMITTED"
      && !actualNormalizedValue
      && desiredCanonicalValue
      && selectedCanonicalValue
      && exactCompatibleChoice
      && commit.ok === true
      && commit.popupClosed === true
      && commit.focusSettled === true
      && evidence.commitSettled === true
      && evidence.activeChoiceSurface === false
      && validationClear
      && verification.feedback?.priceChanged !== true
    );
    return {
      contractVersion: "exact-child-choice-settlement/v1",
      settled,
      reasonCode: settled
        ? "EXACT_CHILD_CHOICE_SEMANTICALLY_COMMITTED"
        : "EXACT_CHILD_CHOICE_NOT_PROVEN",
      logicalFieldId: String(expected.logicalFieldId || ""),
      subjectId: String(expected.subjectId || "traveler_1"),
      semanticType,
      componentRole: String(expected.componentRole || "value"),
      parentControlId: String(expected.controlId || ""),
      selectedControlId: String(decision.controlId || commit.controlId || ""),
      selectedActuatorId: String(decision.actuatorId || decision.targetId || commit.actuatorId || ""),
      desiredCanonicalValue,
      selectedCanonicalValue,
      actualStateBlank: !actualNormalizedValue,
      validationClear,
      popupClosed: commit.popupClosed === true,
      focusSettled: commit.focusSettled === true
    };
  }

  function withChoiceCommitEvidence(verification = {}, commit = null, expected = {}, decision = {}) {
    if (!commit) return verification;
    const compactCommit = compactChoiceCommitEvidence(commit);
    const existingEvidence = verification.evidence && typeof verification.evidence === "object" && !Array.isArray(verification.evidence)
      ? verification.evidence
      : { verifierEvidence: verification.evidence || null };
    const exactChildSettlement = exactChildChoiceSettlementEvidence(
      verification,
      compactCommit,
      expected,
      decision
    );
    if (exactChildSettlement?.settled === true) {
      return {
        ...verification,
        ok: true,
        code: "LOGICAL_COMPONENT_COMMITTED",
        message: "The exact compatible child choice settled the logical component with clear validation and no price change.",
        evidence: {
          ...existingEvidence,
          choiceCommit: compactCommit,
          exactChildSettlement
        }
      };
    }
    if (commit.ok && verification.ok) {
      return {
        ...verification,
        code: verification.code || "CHOICE_COMMIT_SETTLED",
        evidence: {
          ...existingEvidence,
          choiceCommit: compactCommit
        }
      };
    }
    return {
      ...verification,
      ok: false,
      code: commit.ok ? (verification.code || "CHOICE_VALUE_NOT_VERIFIED") : "CHOICE_COMMIT_NOT_SETTLED",
      message: commit.ok
        ? verification.message
        : "The intended value may be visible, but the choice popup/focus episode did not close and settle.",
      evidence: {
        ...existingEvidence,
        choiceCommit: compactCommit,
        ...(exactChildSettlement ? { exactChildSettlement } : {})
      }
    };
  }

  function currentOwnedValidationErrors(map = {}, expected = {}, controlState = {}) {
    return (map.validationIssues || []).filter((issue) => {
      const owned = issue.stageWide === true || (expected.controlId && issue.controlId === expected.controlId);
      if (!owned) return false;
      const contradictedPresenceError = Boolean(
        issue.controlId === expected.controlId
        && controlState?.valuePresent === true
        && controlState?.invalid !== true
        && !String(controlState?.validationMessage || "").trim()
        && /\b(?:empty|required|missing|fill|enter|provide)\b/i.test(String(issue.message || issue.text || issue.label || ""))
      );
      return !contradictedPresenceError;
    });
  }

  function verifyExpectedOutcomeInternal(expected = {}, beforeMap = buildPageMap(), afterMap = buildPageMap(), target = null) {
    const beforeSignature = expected.beforeSignature || structuralPageSignature(beforeMap);
    const afterSignature = structuralPageSignature(afterMap);
    const changed = beforeSignature !== afterSignature;
    const beforeVisualState = expected.beforeVisualState || visualPageState(beforeMap);
    const afterVisualState = visualPageState(afterMap);
    const visualChanged = beforeVisualState?.fingerprint && afterVisualState?.fingerprint && beforeVisualState.fingerprint !== afterVisualState.fingerprint;
    const foregroundChanged = beforeVisualState?.foreground?.fingerprint && afterVisualState?.foreground?.fingerprint
      && beforeVisualState.foreground.fingerprint !== afterVisualState.foreground.fingerprint;
    const progressMarkerChanged = JSON.stringify(beforeVisualState?.foreground?.progressMarkers || {}) !== JSON.stringify(afterVisualState?.foreground?.progressMarkers || {});
    const beforeTransitionSurface = beforeMap.currentSurface || {};
    const afterTransitionSurface = afterMap.currentSurface || {};
    const surfaceChanged = `${beforeTransitionSurface.id || ""}:${beforeTransitionSurface.type || "page"}:${beforeTransitionSurface.label || ""}`
      !== `${afterTransitionSurface.id || ""}:${afterTransitionSurface.type || "page"}:${afterTransitionSurface.label || ""}`;
    const overlayAppeared = Boolean(
      afterTransitionSurface.type
      && afterTransitionSurface.type !== "page"
      && (!beforeTransitionSurface.type || beforeTransitionSurface.type === "page" || surfaceChanged)
    );
    const beforeErrors = [
      ...actionableCheckoutErrors(beforeMap.errors || []),
      ...(beforeMap.validationIssues || []).map((issue) => issue.message).filter(Boolean)
    ];
    const afterErrors = [
      ...actionableCheckoutErrors(afterMap.errors || []),
      ...(afterMap.validationIssues || []).map((issue) => issue.message).filter(Boolean)
    ];
    const validationAppeared = afterErrors.some((error) => !beforeErrors.includes(error));
    const expectedBeforeNavigationUrl = sanitizedNavigationUrl(
      expected.beforeUrl || beforeMap.url || currentNavigationUrl()
    );
    const observedAfterNavigationUrl = sanitizedNavigationUrl(afterMap.url || currentNavigationUrl());
    const liveAfterNavigationUrl = currentNavigationUrl();
    // The immutable after-map normally owns URL evidence. A same-document hash
    // transition can land between DOM compilation and verification, so a live
    // browser URL that differs from the governed pre-action URL is also fresh
    // mechanical evidence. It cannot manufacture progress when unchanged.
    const verifiedAfterNavigationUrl = liveAfterNavigationUrl !== expectedBeforeNavigationUrl
      ? liveAfterNavigationUrl
      : observedAfterNavigationUrl;
    const evidence = {
      beforeObservationHash: observationHashForMap(beforeMap),
      afterObservationHash: observationHashForMap(afterMap),
      beforeStep: beforeMap.step,
      afterStep: afterMap.step,
      beforeUrl: expectedBeforeNavigationUrl,
      afterUrl: verifiedAfterNavigationUrl,
      beforeSurface: beforeMap.currentSurface?.label || "",
      afterSurface: afterMap.currentSurface?.label || "",
      visual: {
        beforeFingerprint: beforeVisualState?.fingerprint || "",
        afterFingerprint: afterVisualState?.fingerprint || "",
        visualChanged: Boolean(visualChanged),
        foregroundChanged: Boolean(foregroundChanged),
        progressMarkerChanged: Boolean(progressMarkerChanged),
        beforeForeground: beforeVisualState?.foreground || null,
        afterForeground: afterVisualState?.foreground || null
      },
      errors: actionableCheckoutErrors(afterMap.errors || []),
      blockers: stageExitBlockers(afterMap, expected)
    };
    const expectedControlId = expected.controlId || expected.targetSnapshot?.controlId || "";
    const expectedDecisionGroupId = expected.decisionGroupId || expected.targetSnapshot?.decisionGroupId || "";
    const beforeDecisionGroup = expectedDecisionGroupId
      ? (beforeMap.decisionGroups || []).find((group) => group.decisionGroupId === expectedDecisionGroupId)
      : null;
    const directlyMatchedControl = expectedControlId
      ? (afterMap.controls || []).find((control) => control.controlId === expectedControlId)
      : null;
    const beforeExpectedControl = expectedControlId
      ? (beforeMap.controls || []).find((control) => control.controlId === expectedControlId)
      : null;
    const stableStateElementId = String(
      expected.stateElementId
      || beforeExpectedControl?.stateElementId
      || beforeExpectedControl?.componentContract?.controlIdentity?.stateElementId
      || ""
    );
    const stateElementReboundControl = stableStateElementId
      ? (afterMap.controls || []).find((control) => String(
          control.stateElementId
          || control.componentContract?.controlIdentity?.stateElementId
          || ""
        ) === stableStateElementId)
      : null;
    const validationOwnerControlId = String(expected.validationOwnership?.controlId || "");
    const validationOwnerControl = validationOwnerControlId
      ? (afterMap.controls || []).find((control) => control.controlId === validationOwnerControlId)
      : null;
    const expectedSemanticType = canonicalProfileFieldType(expected.semanticType || "")
      || normalizedFieldAlias(expected.semanticType || "");
    const expectedComponentRole = String(expected.componentRole || "value");
    const semanticRebindCandidates = expectedSemanticType
      ? (afterMap.controls || []).filter((control) => {
          const controlSemanticType = canonicalProfileFieldType(
            control.fieldType
            || control.fieldClassification?.fieldType
            || control.field
            || control.semantic
            || control.name
            || ""
          );
          if (controlSemanticType !== expectedSemanticType) return false;
          if (expectedComponentRole === "value") return true;
          // Some sites expose a split requirement (for example phone country
          // code) as its own exact semantic control whose local component role
          // is simply "value". The exact semantic identity is sufficient to
          // rebind that control after its visible label and hashed control id
          // change on selection.
          if (String(control.componentContract?.componentRole || control.componentRole || "") === "value") return true;
          return String(
            control.componentRole
            || control.componentContract?.componentRole
            || control.fieldClassification?.componentRole
            || control.dateField?.component
            || ""
          ) === expectedComponentRole
            || boundedPhrase(`${control.name || ""} ${control.autocomplete || ""}`, expectedComponentRole);
        })
      : [];
    const expectedReboundValue = String(
      expected.expectedNormalizedValue
      || expected.expectedComponentValue
      || ""
    );
    const expectedSemanticValue = normalizedProfileChoiceValue(
      expectedReboundValue,
      expectedSemanticType
    );
    const controlMatchesExpectedValue = (control) => {
      if (!control || !expectedReboundValue) return false;
      const rawValue = String(
        control.state?.normalizedValue
        || control.state?.dateComponentValue
        || control.state?.canonicalDateValue
        || ""
      );
      if (rawValue === expectedReboundValue) return true;
      const semanticValue = normalizedProfileChoiceValue(rawValue, expectedSemanticType);
      return Boolean(semanticValue && expectedSemanticValue && semanticValue === expectedSemanticValue);
    };
    const exactStateControlIds = new Set([
      ...(Array.isArray(expected.stateControlIds) ? expected.stateControlIds : []),
      expected.controlId || ""
    ].filter(Boolean));
    const expectedRepresentationIdentity = String(expected.representationIdentity || "");
    const ownerStateControls = (afterMap.controls || []).filter((control) => (
      exactStateControlIds.has(control.controlId)
      || Boolean(
        expectedRepresentationIdentity
        && String(
          control.componentContract?.componentIdentity
          || control.componentIdentity
          || ""
        ) === expectedRepresentationIdentity
      )
    ));
    // A custom control may keep mechanics on a visible combobox while writing
    // its canonical value into a hidden state sibling. Prefer fresh value
    // evidence from that exact logical owner over a blank actuator shell.
    const valueMatchedOwnerControl = ownerStateControls.find(controlMatchesExpectedValue);
    const valueMatchedSemanticControl = semanticRebindCandidates.find(controlMatchesExpectedValue);
    const afterControl = valueMatchedOwnerControl
      || (controlMatchesExpectedValue(directlyMatchedControl) ? directlyMatchedControl : null)
      || (controlMatchesExpectedValue(stateElementReboundControl) ? stateElementReboundControl : null)
      || valueMatchedSemanticControl
      || directlyMatchedControl
      || validationOwnerControl
      || stateElementReboundControl
      || (semanticRebindCandidates.length === 1 ? semanticRebindCandidates[0] : null);
    const afterDecisionGroup = expectedDecisionGroupId
      ? (afterMap.decisionGroups || []).find((group) => group.decisionGroupId === expectedDecisionGroupId)
      : null;
    const afterControlState = afterControl?.state || null;
    const logicalDecisionSatisfied = Boolean(afterDecisionGroup && afterDecisionGroup.status === "satisfied");
    const logicalControlSatisfied = Boolean(
      afterControl
      && (
        afterControl.selected
        || afterControlState?.checked
        || afterControlState?.selected
        || afterControlState?.valuePresent
      )
    );
    if (expected.type === "semantic_progress") {
      const currentSurface = afterMap.currentSurface || {};
      const actualNormalizedValue = String(afterControlState?.normalizedValue || "");
      const wantedNormalizedValue = String(expected.expectedNormalizedValue || "");
      const valueChanged = actualNormalizedValue !== String(expected.previousValue || "");
      const goalSatisfied = Boolean(wantedNormalizedValue && actualNormalizedValue === wantedNormalizedValue);
      const optionsAppeared = Boolean(
        afterControlState?.expanded === true
        || (currentSurface.type && currentSurface.type !== "page" && currentSurface.id !== String(expected.previousSurfaceId || ""))
      );
      const ok = goalSatisfied || optionsAppeared || valueChanged || foregroundChanged || progressMarkerChanged;
      return {
        ok,
        code: ok ? "SEMANTIC_PROGRESS_OBSERVED" : "SEMANTIC_PROGRESS_NOT_OBSERVED",
        message: ok
          ? "The interaction produced fresh semantic progress for the unresolved control."
          : "The interaction did not change the value, options surface, or foreground state.",
        evidence: {
          ...evidence,
          goalSatisfied,
          optionsAppeared,
          valueChanged,
          actualNormalizedValue,
          wantedNormalizedValue,
          control: afterControl || null,
          currentSurface
        }
      };
    }
    if (expected.type === "options_surface_appeared") {
      const currentSurface = afterMap.currentSurface || {};
      const surfaceAppeared = Boolean(
        currentSurface.type
        && currentSurface.type !== "page"
        && currentSurface.id !== (expected.previousSurfaceId || "")
      );
      const expanded = afterControlState?.expanded === true;
      const ok = surfaceAppeared || expanded;
      return {
        ok,
        code: ok ? "OPTIONS_SURFACE_APPEARED" : "OPTIONS_SURFACE_NOT_APPEARED",
        message: ok ? "The canonical choice options are now visible." : "The canonical open operation did not expose its options surface.",
        evidence: { ...evidence, control: afterControl || null, currentSurface }
      };
    }
    if (expected.type === "date_value_committed") {
      const codec = expected.dateCodec || afterControl?.dateField || {};
      const actualCanonicalValue = String(afterControlState?.canonicalDateValue || "");
      const actualComponentValue = String(afterControlState?.dateComponentValue || "");
      const wantedCanonicalValue = String(expected.expectedCanonicalValue || "");
      const wantedComponentValue = String(expected.expectedNormalizedValue || "");
      const ownedValidationErrors = (afterMap.validationIssues || []).filter((issue) => (
        issue.stageWide === true || (expected.controlId && issue.controlId === expected.controlId)
      ));
      const exactValue = codec.kind === "component"
        ? Boolean(wantedComponentValue && actualComponentValue === wantedComponentValue)
        : Boolean(wantedCanonicalValue && actualCanonicalValue === wantedCanonicalValue);
      const ok = exactValue && ownedValidationErrors.length === 0;
      return {
        ok,
        code: ok ? "DATE_VALUE_VERIFIED" : "DATE_VALUE_NOT_VERIFIED",
        message: ok
          ? "The live date value parses back to the saved canonical date."
          : "The live date value did not parse back to the saved canonical date, or validation remains visible.",
        evidence: {
          ...evidence,
          codec,
          actualCanonicalValue,
          wantedCanonicalValue,
          actualComponentValue,
          wantedComponentValue,
          ownedValidationErrors,
          control: afterControl || null
        }
      };
    }
    if (expected.type === "normalized_value_changed") {
      const actualNormalizedValue = String(afterControlState?.normalizedValue || "");
      const wantedNormalizedValue = String(expected.expectedNormalizedValue || "");
      const semanticType = expected.semanticType || afterControl?.fieldType || afterControl?.semantic || "";
      const actualSemanticValue = normalizedProfileChoiceValue(actualNormalizedValue, semanticType);
      const wantedSemanticValue = normalizedProfileChoiceValue(wantedNormalizedValue, semanticType);
      const compatibleProfileChoice = AGENT_CONTRACT?.profileChoiceValueCompatible?.(
        actualNormalizedValue,
        wantedNormalizedValue,
        canonicalProfileFieldType(semanticType) || semanticType
      ) === true;
      const currentSurface = afterMap.currentSurface || {};
      const surfaceDismissed = !expected.requireSurfaceDismissed
        || !expected.surfaceId
        || currentSurface.id !== expected.surfaceId;
      const ownedValidationErrors = currentOwnedValidationErrors(afterMap, expected, afterControlState);
      const ok = Boolean(
        wantedNormalizedValue
        && (
          actualNormalizedValue === wantedNormalizedValue
          || (
            actualSemanticValue
            && wantedSemanticValue
            && actualSemanticValue === wantedSemanticValue
          )
          || compatibleProfileChoice
        )
        && surfaceDismissed
        && ownedValidationErrors.length === 0
      );
      return {
        ok,
        code: ok ? "NORMALIZED_VALUE_VERIFIED" : "NORMALIZED_VALUE_NOT_VERIFIED",
        message: ok ? "The canonical control retained the expected normalized value." : "The canonical control did not retain the expected normalized value or close its options surface.",
        evidence: {
          ...evidence,
          actualNormalizedValue,
          wantedNormalizedValue,
          actualSemanticValue,
          wantedSemanticValue,
          surfaceDismissed,
          ownedValidationErrors,
          control: afterControl || null,
          currentSurface
        }
      };
    }
    if (expected.type === "logical_component_committed") {
      const actualNormalizedValue = String(afterControlState?.normalizedValue || "");
      const wantedNormalizedValue = String(expected.expectedNormalizedValue || expected.expectedComponentValue || "");
      const semanticType = expected.semanticType || afterControl?.fieldType || afterControl?.semantic || "";
      const actualSemanticValue = normalizedProfileChoiceValue(actualNormalizedValue, semanticType);
      const wantedSemanticValue = normalizedProfileChoiceValue(wantedNormalizedValue, semanticType);
      const compatibleProfileChoice = AGENT_CONTRACT?.profileChoiceValueCompatible?.(
        actualNormalizedValue,
        wantedNormalizedValue,
        canonicalProfileFieldType(semanticType) || semanticType
      ) === true;
      const currentSurface = afterMap.currentSurface || {};
      const expectedChildSurfaceId = String(expected.surfaceId || "");
      const activeChoiceSurface = Boolean(
        currentSurface.type
        && currentSurface.type !== "page"
        && (
          afterControlState?.expanded === true
          || currentSurface.parentControlId === expected.controlId
          || (expectedChildSurfaceId && currentSurface.id === expectedChildSurfaceId)
        )
      );
      const commitState = afterControl?.commitState || null;
      const commitSettled = commitState
        ? Boolean(
            commitState.status === "settled"
            && commitState.popupClosed !== false
            && commitState.focusSettled !== false
          )
        : !activeChoiceSurface;
      const ownedValidationErrors = currentOwnedValidationErrors(afterMap, expected, afterControlState);
      const exactValue = Boolean(
        wantedNormalizedValue
        && (
          actualNormalizedValue === wantedNormalizedValue
          || (
            actualSemanticValue
            && wantedSemanticValue
            && actualSemanticValue === wantedSemanticValue
          )
          || compatibleProfileChoice
        )
      );
      const ok = Boolean(
        exactValue
        && commitSettled
        && ownedValidationErrors.length === 0
      );
      return {
        ok,
        code: ok ? "LOGICAL_COMPONENT_COMMITTED" : "LOGICAL_COMPONENT_NOT_COMMITTED",
        message: ok
          ? "The logical component retained its canonical value and its owned choice interaction settled."
          : "The logical component has not proven both its canonical value and choice-interaction settlement.",
        evidence: {
          ...evidence,
          actualNormalizedValue,
          wantedNormalizedValue,
          actualSemanticValue,
          wantedSemanticValue,
          interactionKind: expected.interactionKind || "choice",
          commitRequirement: expected.commitRequirement || "logical_component_committed",
          activeChoiceSurface,
          commitSettled,
          commitState,
          ownedValidationErrors,
          control: afterControl || null,
          currentSurface
        }
      };
    }
    if (expected.type === "field_value_changed") {
      const liveTarget = target && isVisible(target) ? target : elementById(expected.stateElementId || expected.targetId);
      const value = currentElementValue(liveTarget);
      const expectedNormalizedValue = String(expected.expectedNormalizedValue || "");
      const ok = expectedNormalizedValue
        ? afterControlState?.normalizedValue === expectedNormalizedValue
        : (Boolean(value) && (!expected.expectedValue || normalizeMatchText(value).includes(normalizeMatchText(expected.expectedValue).slice(0, 24))))
          || Boolean(afterControlState?.valuePresent);
      return {
        ok,
        code: ok ? "FIELD_VALUE_VERIFIED" : "FIELD_VALUE_NOT_VERIFIED",
        message: ok ? "Field value is present after the action." : "Field value was not retained after the action.",
        evidence: { ...evidence, value, control: afterControl || null }
      };
    }
    if (expected.type === "control_selected") {
      const expectedSelectedControlId = expected.expectedSelectedControlId || expectedControlId;
      const selectedControlId = afterDecisionGroup?.selectedControlId
        || (afterControl && (afterControl.selected || afterControlState?.checked || afterControlState?.selected) ? afterControl.controlId : "");
      const conflictingSelected = (expected.conflictingControlIds || []).filter((controlId) => {
        const control = (afterMap.controls || []).find((candidate) => candidate.controlId === controlId);
        return Boolean(control && (control.selected || control.state?.checked || control.state?.selected));
      });
      const ownedValidationErrors = (afterMap.validationIssues || []).filter((issue) => (
        issue.stageWide === true || (expectedControlId && issue.controlId === expectedControlId)
      ));
      const ok = Boolean(
        expectedSelectedControlId
        && selectedControlId === expectedSelectedControlId
        && conflictingSelected.length === 0
        && ownedValidationErrors.length === 0
      );
      return {
        ok,
        code: ok ? "CONTROL_SELECTED" : "CONTROL_NOT_SELECTED",
        message: ok ? "The exact canonical choice is selected and conflicting peers are clear." : "The exact desired choice was not selected, a conflicting peer remains selected, or validation is still visible.",
        evidence: {
          ...evidence,
          control: afterControl || null,
          expectedSelectedControlId,
          selectedControlId,
          conflictingSelected,
          ownedValidationErrors
        }
      };
    }
    if (expected.type === "section_choice_verified") {
      const group = expectedDecisionGroupId
        ? (afterMap.decisionGroups || []).find((item) => item.decisionGroupId === expectedDecisionGroupId)
        : null;
      const ok = group?.status === "satisfied";
      return {
        ok,
        code: ok ? "DECISION_GROUP_SATISFIED" : "DECISION_GROUP_NOT_SATISFIED",
        message: ok ? `${expected.sectionLabel || expected.sectionType} is satisfied.` : `${expected.sectionLabel || expected.sectionType || "Decision"} is still unresolved.`,
        evidence: { ...evidence, decisionGroup: group }
      };
    }
    if (expected.type === "policy_conflict_resolved") {
      const selectedPaid = (map = {}) => {
        const transaction = (map.transactionFacts?.selectedExtras || []).find((extra) => (
          String(extra.decisionGroupId || "") === expectedDecisionGroupId
          && (Number(extra.priceAmount) > 0 || /paid|money|selected paid/.test(normalizeMatchText(extra.disposition || "")))
          && !/decline|free|remove|skip|without|none|no extra/.test(normalizeMatchText(extra.disposition || ""))
        ));
        const group = (map.decisionGroups || []).find((item) => item.decisionGroupId === expectedDecisionGroupId);
        const groupAmount = Number(group?.selectedEvidence?.structuredPrice?.amount);
        const groupPaid = Boolean(group?.selectedEvidence?.selected === true && (
          group.selectedEvidence.disposition === "paid"
          || (Number.isFinite(groupAmount) && groupAmount > 0)
          || /selected paid|add paid|money|purchase/.test(normalizeMatchText(`${group?.selectedSemantic || ""} ${group?.selectedEvidence?.semantic || ""} ${group?.selectedEvidence?.risk || ""}`))
        ));
        return { transaction: transaction || null, groupPaid };
      };
      const beforePaid = selectedPaid(beforeMap);
      const afterPaid = selectedPaid(afterMap);
      const beforeConflict = Boolean(beforePaid.transaction || beforePaid.groupPaid);
      const beforeGroup = (beforeMap.decisionGroups || []).find((item) => item.decisionGroupId === expectedDecisionGroupId);
      const afterGroup = (afterMap.decisionGroups || []).find((item) => item.decisionGroupId === expectedDecisionGroupId);
      const selectedControlId = String(
        beforeGroup?.selectedEvidence?.selectedControlId
        || beforeGroup?.selectedControlId
        || ""
      );
      const afterSelectedControl = (afterMap.controls || []).find((control) => control.controlId === selectedControlId);
      const afterSelectedText = normalizeMatchText(
        afterMap.foreground?.progressMarkers?.selectedText
        || afterMap.visualState?.foreground?.progressMarkers?.selectedText
        || ""
      );
      const exactControlUnselected = Boolean(
        selectedControlId
        && (!afterSelectedControl
          || !(afterSelectedControl.selected || afterSelectedControl.state?.checked || afterSelectedControl.state?.selected))
      );
      const explicitUnselectedState = /not selected|unselected|no selection|none selected/.test(afterSelectedText);
      const groupSelectionCleared = Boolean(
        !afterGroup
        || (afterGroup.selectedEvidence?.selected !== true && !afterGroup.selectedControlId)
      );
      const selectedItemCleared = Boolean(
        beforeConflict
        && (exactControlUnselected || explicitUnselectedState || groupSelectionCleared)
      );
      const afterConflictMetadata = Boolean(afterPaid.transaction || afterPaid.groupPaid);
      const afterConflict = Boolean(afterPaid.transaction || (afterPaid.groupPaid && !selectedItemCleared));
      const chargeCleared = beforePaid.transaction ? !afterPaid.transaction : !afterConflict;
      const beforePriceAmount = expected.beforePriceAmount == null ? null : Number(expected.beforePriceAmount);
      const afterPriceAmount = afterMap.price?.amount == null ? null : Number(afterMap.price.amount);
      const priceDidNotIncrease = Number.isFinite(beforePriceAmount) && Number.isFinite(afterPriceAmount)
        ? afterPriceAmount <= beforePriceAmount
        : afterConflict === false;
      const ownedValidationErrors = (afterMap.validationIssues || []).filter((issue) => (
        issue.stageWide === true || (expectedControlId && issue.controlId === expectedControlId)
      ));
      const ok = Boolean(
        expected.semanticOwnershipLinkId
        && beforeConflict
        && selectedItemCleared
        && !afterConflict
        && chargeCleared
        && priceDidNotIncrease
        && ownedValidationErrors.length === 0
      );
      return {
        ok,
        code: ok ? "POLICY_CONFLICT_RESOLVED" : "POLICY_CONFLICT_STILL_PRESENT",
        message: ok
          ? "Fresh browser facts prove the selected paid item and its charge are gone."
          : "Fresh browser facts do not yet prove the selected paid item and charge are gone.",
        evidence: {
          ...evidence,
          semanticOwnershipLinkId: expected.semanticOwnershipLinkId || "",
          intendedOutcome: expected.intendedOutcome || "unknown",
          beforeConflict,
          afterConflict,
          afterConflictMetadata,
          selectedItemCleared,
          exactControlUnselected,
          explicitUnselectedState,
          groupSelectionCleared,
          chargeCleared,
          selectedChargeRemoved: chargeCleared,
          beforePriceAmount: Number.isFinite(beforePriceAmount) ? beforePriceAmount : null,
          afterPriceAmount: Number.isFinite(afterPriceAmount) ? afterPriceAmount : null,
          priceDidNotIncrease,
          ownedValidationErrors
        }
      };
    }
    if (expected.type === "exact_free_option_selected") {
      const beforeExpectedControl = (beforeMap.controls || []).find((control) => (
        control.controlId === String(expected.expectedSelectedControlId || expected.controlId || "")
      )) || null;
      const group = afterDecisionGroup || (afterMap.decisionGroups || []).find((item) => (
        (expected.sectionId && item.sectionId === expected.sectionId)
        || (expected.sectionType && item.sectionType === expected.sectionType)
        || (expected.requirementId && (item.requirementId === expected.requirementId || item.decisionGroupId === expected.requirementId))
        || (expected.expectedSelectedLabel && (() => {
          const observed = normalizeMatchText(item.selectedLabel || "");
          const wanted = normalizeMatchText(expected.expectedSelectedLabel);
          return Boolean(observed && wanted && (observed === wanted || observed.includes(wanted) || wanted.includes(observed)));
        })())
        || (expected.expectedSelectedControlId
          && (item.alternatives || []).some((option) => option.controlId === expected.expectedSelectedControlId && option.selected))
      )) || null;
      const groupSelectedControlId = String(group?.selectedControlId || group?.selected?.controlId || "");
      const expectedControlId = String(expected.expectedSelectedControlId || expected.controlId || "");
      const exactCommitment = [...canonicalSelectionCommitments.values()].find((commitment) => {
        if (!expectedControlId || commitment.controlId !== expectedControlId) return false;
        const committed = normalizeMatchText(commitment.label || "");
        const observed = normalizeMatchText(group?.selectedLabel || "");
        return Boolean(committed && observed && (committed === observed || committed.includes(observed) || observed.includes(committed)));
      }) || null;
      const selectedControlId = exactCommitment?.controlId || groupSelectedControlId;
      const selectedOption = (group?.alternatives || []).find((option) => (
        option.selected === true || (groupSelectedControlId && option.controlId === groupSelectedControlId)
      )) || null;
      const ownedRemovalVerified = Boolean(
        beforeDecisionGroup?.removalControlId
        && beforeDecisionGroup.removalControlId === expectedControlId
        && beforeDecisionGroup.selectedEvidence?.selected === true
        && beforeDecisionGroup.selectedEvidence?.disposition === "paid"
        && !afterControl
        && (!group || group.selectedEvidence?.disposition !== "paid")
      );
      const paidTransactionForGroup = (map = {}) => (map.transactionFacts?.selectedExtras || []).find((extra) => (
        String(extra.decisionGroupId || "") === expectedDecisionGroupId
        && (
          Number(extra.priceAmount) > 0
          || /paid|money|selected paid/.test(normalizeMatchText(extra.disposition || ""))
        )
        && !/decline|free|remove|skip|without|none|no extra/.test(normalizeMatchText(extra.disposition || ""))
      )) || null;
      const linkedPaidSelectionCleared = Boolean(
        expected.semanticOwnershipLinkId
        && paidTransactionForGroup(beforeMap)
        && !paidTransactionForGroup(afterMap)
      );
      const beforeLinkedPaidSelection = Boolean(
        beforeDecisionGroup?.selectedEvidence?.selected === true
        && (
          beforeDecisionGroup.selectedEvidence.disposition === "paid"
          || Number(beforeDecisionGroup.selectedEvidence.structuredPrice?.amount) > 0
        )
      );
      const afterLinkedPaidSelection = Boolean(
        afterDecisionGroup?.selectedEvidence?.selected === true
        && (
          afterDecisionGroup.selectedEvidence.disposition === "paid"
          || Number(afterDecisionGroup.selectedEvidence.structuredPrice?.amount) > 0
        )
      );
      const linkedSourceSelectionCleared = Boolean(
        expected.semanticOwnershipLinkId
        && beforeLinkedPaidSelection
        && !afterLinkedPaidSelection
      );
      const exactReversalVerified = ownedRemovalVerified || linkedPaidSelectionCleared || linkedSourceSelectionCleared;
      const selectedText = normalizeMatchText(`${beforeExpectedControl?.semantic || ""} ${beforeExpectedControl?.meaning || ""} ${beforeExpectedControl?.label || ""} ${exactCommitment?.semantic || ""} ${exactCommitment?.risk || ""} ${exactCommitment?.label || ""} ${selectedOption?.semantic || ""} ${selectedOption?.risk || ""} ${selectedOption?.label || group?.selectedSemantic || ""} ${group?.selectedLabel || ""}`);
      const intendedOutcome = normalizeMatchText(expected.intendedOutcome || "");
      const semanticPolicyOutcomeVerified = (() => {
        if (exactReversalVerified) return true;
        if (!intendedOutcome || intendedOutcome === "declined or free") return true;
        if (intendedOutcome === "random assignment") {
          return /random seating|random (?:seat )?assignment|automatic seat assignment|skip seat|continue without (?:a )?seat|go without (?:a )?seat|no seat selection/.test(selectedText);
        }
        if (intendedOutcome === "included base fare") {
          return /included|base fare|basic(?: fare)?|saver(?: fare)?|economy light|light fare/.test(selectedText);
        }
        if (intendedOutcome === "no insurance") {
          return /no (?:travel |trip )?(?:insurance|protection)|without (?:insurance|protection)|decline (?:insurance|protection)|skip (?:insurance|protection)|no thanks/.test(selectedText);
        }
        if (intendedOutcome === "included allowance") {
          return /included|personal item|underseat|cabin bag|hand baggage|carry on|checked bag|hold baggage/.test(selectedText);
        }
        return true;
      })();
      const semanticDispositionVerified = exactReversalVerified
        || /decline|safe decline|free|included|no extra|no thanks|none|without|skip|remove/.test(selectedText)
        || (
          ["random assignment", "included base fare", "no insurance", "included allowance"].includes(intendedOutcome)
          && semanticPolicyOutcomeVerified
        );
      const paidAlternativesSelected = (group?.alternatives || []).filter((option) => {
        if (!(option.selected === true || (groupSelectedControlId && option.controlId === groupSelectedControlId))) return false;
        const risk = normalizeMatchText(option.risk || "");
        const semantic = normalizeMatchText(option.semantic || "");
        return /money|payment/.test(risk) || /add paid extra|add extra|purchase|upgrade/.test(semantic);
      });
      const exactControlSelected = exactReversalVerified || Boolean(expectedControlId && selectedControlId === expectedControlId);
      const selectedChargeAmount = Number(group?.selectedEvidence?.structuredPrice?.amount ?? selectedOption?.structuredPrice?.amount);
      const selectedChargeRemoved = expected.requireChargeRemoved !== true || Boolean(
        exactReversalVerified
        || (
          group?.selectedEvidence?.disposition === "free"
          && (!Number.isFinite(selectedChargeAmount) || selectedChargeAmount <= 0)
        )
        || (Number.isFinite(selectedChargeAmount) && selectedChargeAmount === 0)
      );
      const selectedTruth = (item = {}) => {
        const selectedEvidence = item.selectedEvidence || {};
        const controlId = String(item.selectedControlId || selectedEvidence.selectedControlId || "");
        if (selectedEvidence.selected !== true && !controlId) return null;
        const amount = Number(selectedEvidence.structuredPrice?.amount);
        return {
          controlId,
          disposition: normalizeMatchText(selectedEvidence.disposition || item.selectedSemantic || "unknown"),
          priceAmount: Number.isFinite(amount) ? amount : null
        };
      };
      const beforeSelections = new Map((beforeMap.decisionGroups || []).map((item) => [
        String(item.decisionGroupId || item.requirementId || ""),
        selectedTruth(item)
      ]).filter(([decisionGroupId, truth]) => decisionGroupId && truth));
      const unrelatedSelectionChanges = (afterMap.decisionGroups || []).flatMap((item) => {
        const decisionGroupId = String(item.decisionGroupId || item.requirementId || "");
        if (!decisionGroupId || decisionGroupId === expectedDecisionGroupId || decisionGroupId === expected.correctionDecisionGroupId) return [];
        const afterSelection = selectedTruth(item);
        if (!afterSelection) return [];
        const beforeSelection = beforeSelections.get(decisionGroupId) || null;
        if (!beforeSelection) return [];
        if (beforeSelection && JSON.stringify(beforeSelection) === JSON.stringify(afterSelection)) return [];
        // Some widgets expose an option in a foreground listbox, then collapse
        // it back into the owning field after selection. When the exact option
        // commitment and selected label identify this group as the expected
        // free result, the field's paid→free change is the postcondition—not
        // an unrelated mutation merely because the presentation group changed.
        const expectedCollapsedSelection = Boolean(
          item === group
          && exactCommitment
          && /free|decline|without|none|no extra|included/.test(afterSelection.disposition)
        );
        if (expectedCollapsedSelection) return [];
        return [{ decisionGroupId, before: beforeSelection, after: afterSelection }];
      });
      const beforePriceAmount = expected.beforePriceAmount == null ? null : Number(expected.beforePriceAmount);
      const afterPriceAmount = afterMap.price?.amount == null ? null : Number(afterMap.price.amount);
      const checkoutStageAdvanced = Boolean(
        String(beforeMap.step || "") !== String(afterMap.step || "")
        || expectedBeforeNavigationUrl !== verifiedAfterNavigationUrl
        || progressMarkerChanged
        || (
          surfaceChanged
          && beforeTransitionSurface.type === "page"
          && afterTransitionSurface.type === "page"
        )
      );
      const afterControlAvailability = afterControl && AGENT_CONTRACT?.controlAvailability
        ? AGENT_CONTRACT.controlAvailability(afterControl)
        : (afterControl ? "active" : "inactive");
      const afterDecisionAvailability = afterDecisionGroup && AGENT_CONTRACT?.decisionAvailability
        ? AGENT_CONTRACT.decisionAvailability(afterDecisionGroup, afterMap.controls || [])
        : (afterDecisionGroup ? "active" : "inactive");
      const sourceRetired = Boolean(
        beforeExpectedControl
        && afterControlAvailability === "inactive"
        && afterDecisionAvailability === "inactive"
      );
      const activeSuccessorDecision = (afterMap.decisionGroups || []).some((item) => (
        item.decisionGroupId !== expectedDecisionGroupId
        && (
          !AGENT_CONTRACT?.decisionAvailability
          || AGENT_CONTRACT.decisionAvailability(item, afterMap.controls || []) === "active"
        )
      ));
      const advancingFreeOptionDisappeared = Boolean(
        beforeExpectedControl?.choiceContract?.advancesOnSelection === true
        && Number(beforeExpectedControl?.structuredPrice?.amount) === 0
        && sourceRetired
        && changed
      );
      const freeCommandDismissed = Boolean(
        beforeExpectedControl
        && /decline|safe decline|free|no thanks|without|skip/.test(selectedText)
        && sourceRetired
        && changed
        && (
          (beforeExpectedControl.surfaceType
            && beforeExpectedControl.surfaceType !== "page"
            && (afterMap.currentSurface?.id !== beforeExpectedControl.surfaceId || afterMap.currentSurface?.type === "page"))
          || (beforeExpectedControl.surfaceType === "page" && checkoutStageAdvanced)
        )
      );
      const policySafeTransitionCandidate = Boolean(
        beforeExpectedControl
        && expected.policyAuthorized === true
        && (
          Number(beforeExpectedControl.structuredPrice?.amount) === 0
          || /decline|safe decline|free|included|without|skip|no thanks|no extra/.test(
            normalizeMatchText(`${expected.expectedDisposition || ""} ${beforeExpectedControl.physicalEffect || ""} ${beforeExpectedControl.semantic || ""} ${beforeExpectedControl.risk || ""} ${beforeExpectedControl.label || ""}`)
          )
        )
        && sourceRetired
        && checkoutStageAdvanced
      );
      const priceDidNotIncrease = (exactReversalVerified || advancingFreeOptionDisappeared || freeCommandDismissed || policySafeTransitionCandidate)
        && Number.isFinite(beforePriceAmount)
        && !Number.isFinite(afterPriceAmount)
        ? true
        : Number.isFinite(beforePriceAmount) && Number.isFinite(afterPriceAmount)
        ? afterPriceAmount <= beforePriceAmount
        : String(afterMap.priceText || "") === String(expected.beforePriceText || "");
      const ownedValidationErrors = (afterMap.validationIssues || []).filter((issue) => (
        issue.stageWide === true
        || (expectedControlId && issue.controlId === expectedControlId)
        || (expected.sectionId && issue.sectionId === expected.sectionId)
        || (expected.sectionType && issue.sectionType === expected.sectionType)
      ));
      const currentSurface = afterMap.currentSurface || {};
      const surfaceDismissed = !expected.requireSurfaceDismissed
        || !expected.expectedSurfaceId
        || currentSurface.id !== expected.expectedSurfaceId;
      const contractPolicySafeAdvance = Boolean(
        beforeExpectedControl
        && beforeExpectedControl.choiceContract?.advancesOnSelection === true
        && Number(beforeExpectedControl.structuredPrice?.amount) === 0
        && beforeDecisionGroup
        && semanticPolicyOutcomeVerified
        && (beforeDecisionGroup.alternatives || []).some((option) => (
          option.controlId === beforeExpectedControl.controlId
          && (
            Number(option.structuredPrice?.amount) === 0
            || /select_free_option|safe_decline|free|included|without|skip/.test(
              normalizeMatchText(`${option.physicalEffect || ""} ${option.semantic || ""} ${option.risk || ""} ${option.label || ""}`)
            )
          )
        ))
        && sourceRetired
        && changed
        && (activeSuccessorDecision || checkoutStageAdvanced)
        && priceDidNotIncrease
        && ownedValidationErrors.length === 0
        && actionableCheckoutErrors(afterMap.errors || []).length === 0
      );
      const policySafeChoiceAdvanced = Boolean(
        policySafeTransitionCandidate
        && semanticPolicyOutcomeVerified
        && priceDidNotIncrease
        && unrelatedSelectionChanges.length === 0
        && paidAlternativesSelected.length === 0
        && ownedValidationErrors.length === 0
        && actionableCheckoutErrors(afterMap.errors || []).length === 0
      );
      const exactPolicySafeAdvance = contractPolicySafeAdvance || policySafeChoiceAdvanced;
      const ok = Boolean(
        (group?.status === "satisfied" || exactReversalVerified || exactPolicySafeAdvance || freeCommandDismissed)
        && (exactControlSelected || exactPolicySafeAdvance || freeCommandDismissed)
        && (semanticDispositionVerified || exactPolicySafeAdvance || freeCommandDismissed)
        && semanticPolicyOutcomeVerified
        && selectedChargeRemoved
        && unrelatedSelectionChanges.length === 0
        && paidAlternativesSelected.length === 0
        && priceDidNotIncrease
        && ownedValidationErrors.length === 0
        && surfaceDismissed
      );
      return {
        ok,
        code: policySafeChoiceAdvanced
          ? "POLICY_SAFE_CHOICE_ADVANCED"
          : (ok ? "EXACT_FREE_OPTION_VERIFIED" : "EXACT_FREE_OPTION_NOT_VERIFIED"),
        message: ok
          ? (policySafeChoiceAdvanced
              ? "The profile-authorized free/no-extra choice safely advanced checkout to a fresh stage."
              : "The exact canonical free/no-extra option is selected without a price increase or validation error.")
          : "The decision is not proven to be the exact canonical free/no-extra selection.",
        evidence: {
          ...evidence,
          decisionGroup: group || null,
          observedDecisionGroups: (afterMap.decisionGroups || []).map((item) => ({
            decisionGroupId: item.decisionGroupId,
            sectionType: item.sectionType,
            sectionLabel: item.sectionLabel,
            status: item.status,
            selectedControlId: item.selectedControlId,
            selectedLabel: item.selectedLabel,
            alternatives: item.alternatives
          })),
          expectedControlId,
          selectedControlId,
          groupSelectedControlId,
          exactCommitment,
          exactControlSelected,
          afterControlAvailability,
          afterDecisionAvailability,
          sourceRetired,
          activeSuccessorDecision,
          exactPolicySafeAdvance,
          contractPolicySafeAdvance,
          policySafeChoiceAdvanced,
          checkoutStageAdvanced,
          completionMode: policySafeChoiceAdvanced ? "safe_stage_transition" : "same_surface_selection",
          freeCommandDismissed,
          intendedOutcome: expected.intendedOutcome || "",
          semanticPolicyOutcomeVerified,
          ownedRemovalVerified,
          linkedPaidSelectionCleared,
          linkedSourceSelectionCleared,
          semanticOwnershipLinkId: expected.semanticOwnershipLinkId || "",
          semanticDispositionVerified,
          selectedChargeRemoved,
          selectedChargeAmount: Number.isFinite(selectedChargeAmount) ? selectedChargeAmount : null,
          unrelatedSelectionChanges,
          paidAlternativesSelected,
          beforePriceAmount: Number.isFinite(beforePriceAmount) ? beforePriceAmount : null,
          afterPriceAmount: Number.isFinite(afterPriceAmount) ? afterPriceAmount : null,
          priceDidNotIncrease,
          ownedValidationErrors,
          surfaceDismissed,
          currentSurface
        }
      };
    }
    if (expected.type === "requirement_status") {
      const activeSurfaceProgress = beforeMap.currentSurface?.label && beforeMap.currentSurface?.label !== afterMap.currentSurface?.label;
      const ok = logicalDecisionSatisfied || logicalControlSatisfied || (activeSurfaceProgress && !evidence.errors.length);
      return {
        ok,
        code: ok ? "REQUIREMENT_EVIDENCE_VERIFIED" : "REQUIREMENT_NOT_VERIFIED",
        message: ok
          ? `${expected.requirementId || expected.sectionLabel || "Requirement"} has evidence after the action.`
          : `${expected.requirementId || expected.sectionLabel || "Requirement"} is still missing evidence after the action.`,
        evidence: {
          ...evidence,
          decisionGroup: afterDecisionGroup || null,
          logicalDecisionSatisfied,
          control: afterControl || null,
          logicalControlSatisfied
        }
      };
    }
    if (expected.type === "active_surface_change") {
      const afterSurface = afterMap.currentSurface || {};
      const afterSurfaceSignature = `${afterSurface.type || ""}:${afterSurface.label || ""}:${(afterSurface.options || []).map((entry) => entry.id).join(",")}`;
      const beforeSurface = beforeMap.currentSurface || {};
      const beforeSurfaceSignature = `${beforeSurface.type || ""}:${beforeSurface.label || ""}:${(beforeSurface.options || []).map((entry) => entry.id).join(",")}`;
      const ok = expected.surfaceSignature
        ? expected.surfaceSignature !== afterSurfaceSignature
        : beforeSurfaceSignature !== afterSurfaceSignature || foregroundChanged || progressMarkerChanged || Boolean(afterSurface.type && afterSurface.type !== "page" && visualChanged);
      return {
        ok,
        code: ok ? "ACTIVE_SURFACE_CHANGED" : "ACTIVE_SURFACE_UNCHANGED",
        message: ok ? "Active surface changed after the action." : "Active surface did not change after the action.",
        evidence: { ...evidence, beforeSurfaceSignature, afterSurfaceSignature }
      };
    }
    if (expected.type === "active_surface_dismissed") {
      const afterSurface = afterMap.currentSurface || {};
      const beforeSurface = beforeMap.currentSurface || {};
      const sameSurfaceId = expected.surfaceId && afterSurface.id === expected.surfaceId;
      const sameSurfaceLabel = normalizeMatchText(afterSurface.label || "") && normalizeMatchText(afterSurface.label || "") === normalizeMatchText(expected.surfaceLabel || "");
      const foregroundGone = !afterSurface.type || afterSurface.type === "page";
      const currentUrl = currentNavigationUrl();
      const stepAdvanced = beforeMap.step !== afterMap.step || currentUrl !== (beforeMap.url || currentUrl);
      const advancedInPlace = Boolean(progressMarkerChanged);
      const ok = Boolean(stepAdvanced || advancedInPlace || foregroundGone || (!sameSurfaceId && !sameSurfaceLabel && (foregroundChanged || visualChanged || changed)));
      return {
        ok,
        code: ok
          ? (advancedInPlace && !foregroundGone ? "ACTIVE_SURFACE_ADVANCED" : "ACTIVE_SURFACE_DISMISSED")
          : "ACTIVE_SURFACE_STILL_PRESENT",
        message: ok
          ? (advancedInPlace && !foregroundGone
              ? "Foreground surface advanced to a fresh internal step."
              : "Foreground surface was dismissed or advanced.")
          : "Foreground surface is still present after the action.",
        evidence: {
          ...evidence,
          expectedSurface: {
            id: expected.surfaceId || "",
            type: expected.surfaceType || "",
            label: expected.surfaceLabel || ""
          },
          afterSurface: {
            id: afterSurface.id || "",
            type: afterSurface.type || "page",
            label: afterSurface.label || ""
          },
          advancedInPlace,
          progressMarkerChanged
        }
      };
    }
    if (expected.type === "current_surface_advanced") {
      const stepChanged = beforeMap.step !== afterMap.step;
      const beforeUrl = expectedBeforeNavigationUrl;
      const afterUrl = verifiedAfterNavigationUrl;
      const urlChanged = beforeUrl !== afterUrl;
      const ok = Boolean(stepChanged || urlChanged || progressMarkerChanged || (surfaceChanged && !overlayAppeared));
      return {
        ok,
        code: ok ? "CURRENT_SURFACE_ADVANCED" : "CURRENT_SURFACE_NOT_ADVANCED",
        message: ok ? "The current surface produced fresh forward-progress evidence." : "The current surface did not produce forward-progress evidence.",
        evidence: { ...evidence, stepChanged, urlChanged, progressMarkerChanged, surfaceChanged, overlayAppeared }
      };
    }
    if (expected.type === "checkout_stage_advanced") {
      const stepChanged = beforeMap.step !== afterMap.step;
      // The canonical page map intentionally does not need to duplicate the
      // browser URL on every internal snapshot. Compare against the governed
      // pre-action URL when it is supplied; treating a missing beforeMap.url
      // as an empty string made every same-page click look like navigation.
      const beforeUrl = expectedBeforeNavigationUrl;
      const afterUrl = verifiedAfterNavigationUrl;
      const urlChanged = beforeUrl !== afterUrl;
      const ok = Boolean(stepChanged || urlChanged || progressMarkerChanged);
      return {
        ok,
        code: ok ? "CHECKOUT_STAGE_ADVANCED" : "CHECKOUT_STAGE_NOT_ADVANCED",
        message: ok ? "Fresh stage, URL, or progress-marker evidence proves checkout advanced." : "No fresh checkout-stage evidence was observed.",
        evidence: { ...evidence, stepChanged, urlChanged, progressMarkerChanged, overlayAppeared, surfaceChanged }
      };
    }
    if (expected.type === "stage_exit_or_feedback") {
      const errors = actionableCheckoutErrors(afterMap.errors || []);
      const blockers = stageExitBlockers(afterMap, expected);
      if (changed && beforeMap.step !== afterMap.step) {
        return { ok: true, code: "STAGE_CHANGED", message: `Stage changed to ${afterMap.step}.`, evidence };
      }
      if (progressMarkerChanged) {
        return { ok: true, code: "NAVIGATION_PROGRESS_CHANGED", message: "Navigation advanced the current progress marker.", evidence };
      }
      if (overlayAppeared || surfaceChanged) {
        return {
          ok: true,
          code: overlayAppeared ? "NAVIGATION_POPUP_APPEARED" : "NAVIGATION_SURFACE_CHANGED",
          message: overlayAppeared ? "Navigation produced a new foreground popup." : "Navigation changed the active surface.",
          evidence
        };
      }
      if (validationAppeared) {
        return {
          ok: true,
          code: "NAVIGATION_VALIDATION_APPEARED",
          message: "Navigation reached the page and produced fresh validation feedback.",
          evidence: { ...evidence, errors }
        };
      }
      if ((changed || visualChanged) && !blockers.length) {
        return { ok: true, code: "PAGE_CHANGED", message: "Page structure changed after navigation action.", evidence };
      }
      if (errors.length || blockers.length) {
        return {
          ok: false,
          code: errors.length ? "STAGE_BLOCKED_BY_VALIDATION" : "STAGE_BLOCKED_BY_REQUIREMENT",
          message: (errors[0] || blockers[0]?.message || "Navigation revealed a blocker."),
          evidence: { ...evidence, blockers }
        };
      }
      return {
        ok: changed || visualChanged,
        code: changed || visualChanged ? "PAGE_CHANGED" : "NO_OBSERVABLE_STAGE_CHANGE",
        message: changed || visualChanged ? "Page changed after navigation action." : "Navigation action did not produce an observable page change.",
        evidence
      };
    }
    return {
      ok: changed || visualChanged,
      code: changed || visualChanged ? "OBSERVABLE_CHANGE" : "NO_OBSERVABLE_CHANGE",
      message: changed || visualChanged ? "Page changed after the action." : "No observable page change after the action.",
      evidence
    };
  }


  return {
    compactChoiceCommitEvidence,
    currentOwnedValidationErrors,
    exactChildChoiceSettlementEvidence,
    expectedOutcomeForDecision,
    stageExitBlockers,
    transitionFeedbackForMaps,
    verifyExpectedOutcome,
    verifyExpectedOutcomeInternal,
    withChoiceCommitEvidence,
    withOverlayProgressEvidence
  };
}
