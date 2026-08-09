export function createTargeting(dependencies) {
  const {
    AGENT_CONTRACT,
    accessibleName,
    accessibilityState,
    actuatorActionability,
    agent,
    buildCanonicalAliasIndex,
    buildPageMap,
    buttonText,
    choiceRisk,
    clickPointIsClear,
    compactText,
    controlMemberNodeIds,
    currentElementValue,
    currentSurfaceEntries,
    decisionTargetAliasIds,
    elementBox,
    elementById,
    elementId,
    implicitRole,
    isDangerousActionLabel,
    isDisabledLike,
    isPaymentField,
    isVisible,
    labelText,
    liveSectionForElement,
    logFlow,
    lookupControlForElement,
    meaningfulActionBox,
    normalizeMatchText,
    semanticChoiceType,
    stableHash,
    surfaceMembershipForElement,
    visualRegionContractsMatch
  } = dependencies;

  function elementDescriptor(element) {
    if (!element) return null;
    const box = isVisible(element) ? elementBox(element) : null;
    const centerX = box ? Math.min(window.innerWidth - 1, Math.max(0, box.centerX)) : 0;
    const centerY = box ? Math.min(window.innerHeight - 1, Math.max(0, box.centerY)) : 0;
    const top = box ? document.elementFromPoint(centerX, centerY) : null;
    return {
      id: element.dataset?.atwElementId || "",
      tag: element.tagName || "",
      role: implicitRole(element),
      accessibleName: accessibleName(element),
      accessibilityState: accessibilityState(element),
      type: element.getAttribute?.("type") || "",
      text: compactText(buttonText(element) || element.innerText || element.textContent || element.getAttribute?.("aria-label") || labelText(element)),
      value: compactText(currentElementValue(element), 80),
      visible: isVisible(element),
      disabled: isDisabledLike(element),
      box,
      topAtCenter: top ? {
        tag: top.tagName || "",
        role: top.getAttribute?.("role") || "",
        id: top.dataset?.atwElementId || "",
        text: compactText(buttonText(top) || top.innerText || top.textContent || top.getAttribute?.("aria-label"))
      } : null,
      clickClear: box ? clickPointIsClear(element) : false
    };
  }

  function targetFingerprint(element, decision = {}) {
    const descriptor = elementDescriptor(element);
    if (!descriptor) return null;
    const parent = element.parentElement && !element.parentElement.closest?.("#atw-sidebar")
      ? compactText(element.parentElement.innerText || element.parentElement.textContent || "", 220)
      : "";
    return {
      ...descriptor,
      requested: {
        targetId: decision.targetId || "",
        targetLabel: decision.targetLabel || "",
        value: decision.value || ""
      },
      nearbyText: parent,
      surface: compactText(agent.pageMap?.currentSurface?.label || "", 220)
    };
  }

  function targetLocalDispatchIdentity(decision = {}, map = agent.pageMap || buildPageMap()) {
    const controlId = decision.controlId || decision.targetSnapshot?.controlId || "";
    const control = (map.controls || []).find((item) => item.controlId === controlId) || null;
    const selectedStrategy = decision.pipelineContract?.capability?.selectedStrategy || {};
    const actuatorStableKey = selectedStrategy.actuatorStableKey
      || [
        control?.stableKey || controlId,
        decision.operation || "",
        (control?.actuators || []).find((item) => item.nodeId === decision.targetId)?.relation || "",
        decision.targetId || (decision.visualRegion ? "visual-region" : "")
      ].join("::");
    const surface = map.currentSurface || {};
    const surfaceInstanceKey = stableHash(JSON.stringify({
      step: map.step || "unknown",
      surfaceId: surface.id || "surface-page",
      surfaceType: surface.type || "page",
      surfaceInstanceId: surface.instanceId || "",
      decisionGroupId: decision.decisionGroupId || control?.decisionGroupId || "",
      requirementId: decision.requirementId
        || decision.pipelineContract?.requirement?.requirementId
        || ""
    }));
    const strategySignature = [
      decision.pipelineContract?.requirement?.requirementId || decision.requirementId || "",
      decision.pipelineContract?.component?.componentIdentity || control?.stableKey || controlId,
      actuatorStableKey,
      decision.operation || "",
      decision.interactionMethod || decision.action || ""
    ].join("::");
    const localStrategies = [
      ...Object.values(control?.operations || {}).flatMap((capability) => capability?.strategies || []),
      ...Object.values(control?.recovery || {}).flatMap((recovery) => recovery?.strategies || [])
    ].filter((strategy) => !selectedStrategy.actuatorStableKey
      || strategy.actuatorStableKey === selectedStrategy.actuatorStableKey);
    const targetLocalStateKey = stableHash(JSON.stringify({
      stableControlKey: control?.stableKey || controlId,
      state: control ? {
        disabled: control.state?.disabled === true || control.disabled === true,
        expanded: control.state?.expanded === true,
        checked: control.state?.checked === true,
        selected: control.state?.selected === true || control.selected === true,
        normalizedValue: String(
          control.state?.canonicalDateValue
          || control.state?.selectedValue
          || control.state?.normalizedValue
          || control.currentCanonicalValue
          || control.currentValue
          || ""
        ),
        optionValue: String(control.state?.optionValue || ""),
        visibleWidgetElementId: String(control.visibleWidgetElementId || "")
      } : null,
      actuator: localStrategies.map((strategy) => ({
        actuatorStableKey: strategy.actuatorStableKey || "",
        status: strategy.status || "",
        visible: strategy.proof?.visible === true,
        enabled: strategy.proof?.enabled === true,
        hitTested: strategy.proof?.hitTested === true,
        notOccluded: strategy.proof?.notOccluded === true
      })).sort((a, b) => a.actuatorStableKey.localeCompare(b.actuatorStableKey))
    }));
    return {
      strategySignature,
      actuatorStableKey,
      surfaceInstanceKey,
      targetLocalStateKey
    };
  }

  function failedLocalStrategyForDecision(decision = {}, map = agent.pageMap || buildPageMap()) {
    const identity = targetLocalDispatchIdentity(decision, map);
    return (agent.failedLocalStrategies || []).find((entry) => (
      entry.strategySignature === identity.strategySignature
      && entry.surfaceInstanceKey === identity.surfaceInstanceKey
      && entry.targetLocalStateKey === identity.targetLocalStateKey
    )) || null;
  }

  function rememberFailedLocalStrategy(decision = {}, map = agent.pageMap || buildPageMap(), code = "") {
    const identity = targetLocalDispatchIdentity(decision, map);
    const existing = failedLocalStrategyForDecision(decision, map);
    if (existing) {
      existing.failureCount = Number(existing.failureCount || 1) + 1;
      existing.code = code || existing.code || "";
      return existing;
    }
    const entry = {
      ...identity,
      controlId: decision.controlId || decision.targetSnapshot?.controlId || "",
      operation: decision.operation || "",
      interactionMethod: decision.interactionMethod || decision.action || "",
      code: String(code || "OUTCOME_NOT_VERIFIED"),
      failureCount: 1
    };
    agent.failedLocalStrategies = [...(agent.failedLocalStrategies || []), entry].slice(-80);
    return entry;
  }

  function normalizedElementLabel(element) {
    return normalizeMatchText(buttonText(element) || labelText(element) || element?.innerText || element?.textContent || element?.getAttribute?.("aria-label") || "");
  }

  function shortNavLabel(label = "") {
    return /^(continue|next|back|close|done|confirm|skip|proceed)$/i.test(String(label || "").trim());
  }

  function validTargetId(id = "") {
    return Boolean(String(id || "").trim() && !/^(false|true|null|undefined|\[object object\])$/i.test(String(id || "").trim()));
  }

  function liveTargetSnapshot(element, map = agent.pageMap || buildPageMap()) {
    if (!element) return null;
    const descriptor = elementDescriptor(element);
    const authoritativeSurface = map?.currentSurface || { id: "surface-page", type: "page", label: "Page" };
    const membership = surfaceMembershipForElement(element, authoritativeSurface);
    const surfaceId = membership.surfaceId;
    const surfaceType = surfaceId === authoritativeSurface.id ? authoritativeSurface.type : "page";
    const surfaceLabel = surfaceId === authoritativeSurface.id ? authoritativeSurface.label : "Page";
    const section = liveSectionForElement(map, element);
    const label = buttonText(element) || labelText(element) || element.innerText || element.textContent || "";
    const control = lookupControlForElement(map, element);
    return {
      id: elementId(element),
      label,
      normalizedLabel: normalizedElementLabel(element),
      role: control?.role || implicitRole(element),
      accessibleName: control?.accessibleName || accessibleName(element),
      accessibilityState: accessibilityState(element),
      kind: control?.kind || (/radio|checkbox/i.test(element.type || "") ? "choice" : (element.tagName || "").toLowerCase()),
      semantic: control?.semantic || control?.semanticIntent || semanticChoiceType(label),
      risk: control?.risk || choiceRisk(label),
      box: descriptor?.box || null,
      surfaceId,
      surfaceType,
      surfaceLabel,
      surfaceMembershipEvidence: membership.evidence,
      surfaceNormalizedLabel: normalizeMatchText(surfaceLabel),
      sectionId: section?.id || "",
      sectionType: section?.type || "",
      sectionLabel: section?.label || "",
      controlId: control?.controlId || element.dataset?.atwControlId || "",
      stableKey: control?.stableKey || "",
      decisionGroupId: control?.decisionGroupId || "",
      controlKind: control?.kind || "",
      state: control?.state || null,
      operations: control?.operations || {},
      recovery: control?.recovery || {},
      ownershipIntegrity: control?.ownershipIntegrity || null,
      actuators: control?.actuators || [],
      stateElementId: control?.stateElementId || "",
      visibleWidgetElementId: control?.visibleWidgetElementId || "",
      preferredActivationElementId: control?.preferredActivationElementId || "",
      visualRegion: control?.visualRegion || descriptor?.box || null
    };
  }

  function boxesCloseEnough(expectedBox, liveBox) {
    if (!expectedBox || !liveBox) return true;
    const expectedX = Number(expectedBox.centerX);
    const expectedY = Number(expectedBox.centerY);
    if (!Number.isFinite(expectedX) || !Number.isFinite(expectedY)) return true;
    const dx = Math.abs(expectedX - liveBox.centerX);
    const dy = Math.abs(expectedY - liveBox.centerY);
    const tolerance = Math.max(90, Math.min(220, Math.max(Number(expectedBox.width) || 0, Number(expectedBox.height) || 0) + 60));
    return dx <= tolerance && dy <= tolerance;
  }

  function isStrictActionSurfaceType(surfaceType = "") {
    const normalized = String(surfaceType || "page").toLowerCase();
    return ["modal", "dialog", "popup", "popover", "dropdown", "overlay", "active_surface"].includes(normalized);
  }

  function targetBelongsToCurrentSurface(map = agent.pageMap || buildPageMap(), element) {
    const surface = map.currentSurface || { id: "surface-page", type: "page" };
    return surfaceMembershipForElement(element, surface).surfaceId === (surface.id || "surface-page");
  }

  function isAuthorizedCompletedChoiceSurfaceExit(decision = {}, element, map = agent.pageMap || buildPageMap()) {
    const targetControl = lookupControlForElement(map, element);
    return Boolean(targetControl && AGENT_CONTRACT?.parentSurfaceExitOwnershipIsCurrent({
      action: decision,
      pipelineContract: decision.pipelineContract || {},
      control: targetControl,
      observation: { observationId: decision.observationId || map.observationId || "", page: map }
    }));
  }

  function validateResolvedTarget(decision = {}, element, map = agent.pageMap || buildPageMap()) {
    const expected = decision.targetSnapshot;
    const live = liveTargetSnapshot(element, map);
    const authorizedCompletedChoiceExit = isAuthorizedCompletedChoiceSurfaceExit(decision, element, map);
    if (!targetBelongsToCurrentSurface(map, element) && !authorizedCompletedChoiceExit) {
      return {
        ok: false,
        code: "TARGET_OUTSIDE_CURRENT_SURFACE",
        expected: expected || {
          surfaceId: map.currentSurface?.id || "surface-page",
          surfaceType: map.currentSurface?.type || "page",
          surfaceLabel: map.currentSurface?.label || "Page"
        },
        live
      };
    }
    if (!live) return { ok: false, code: "TARGET_MISSING", expected, live: null };
    let exactActionability = actuatorActionability(
      element,
      map.currentSurface || { id: "surface-page", type: "page" },
      decision.operation || decision.action || "activate"
    );
    if (authorizedCompletedChoiceExit && exactActionability.inCurrentSurface !== true) {
      exactActionability = {
        ...exactActionability,
        inCurrentSurface: true,
        operationAuthorized: true,
        operationProof: "The single expanded choice opener owns dismissal of the active completed choice surface."
      };
    }
    if (!exactActionability.rendered) return { ok: false, code: "TARGET_NOT_RENDERED", expected: expected || null, live, actionability: exactActionability };
    if (!exactActionability.visible) return { ok: false, code: "TARGET_NOT_VISIBLE", expected: expected || null, live, actionability: exactActionability };
    if (!exactActionability.enabled) return { ok: false, code: "TARGET_DISABLED", expected: expected || null, live, actionability: exactActionability };
    if (!exactActionability.inCurrentSurface) return { ok: false, code: "TARGET_OUTSIDE_CURRENT_SURFACE", expected: expected || null, live, actionability: exactActionability };
    if (!exactActionability.inViewport) return { ok: false, code: "TARGET_OUT_OF_VIEW", expected: expected || null, live, actionability: exactActionability };
    if (!exactActionability.hitTested || !exactActionability.notOccluded) {
      return { ok: false, code: "TARGET_OCCLUDED", expected: expected || null, live, actionability: exactActionability };
    }
    if (!expected) return { ok: true, live, expected: null };
    const warnings = [];
    const strictSurface = isStrictActionSurfaceType(expected.surfaceType);
    const expectedControlId = expected.controlId || decision.controlId || "";
    const liveControlId = live.controlId || element?.dataset?.atwControlId || "";
    const expectedDecisionGroupId = expected.decisionGroupId || decision.decisionGroupId || "";
    if (expectedDecisionGroupId && live.decisionGroupId && expectedDecisionGroupId !== live.decisionGroupId) {
      const expectedActuatorIdentity = new Set([
        expected.id,
        expected.stateElementId,
        expected.preferredActivationElementId,
        expected.actuatorId
      ].filter(validTargetId));
      const liveActuatorIdentity = [
        live.id,
        live.stateElementId,
        live.preferredActivationElementId
      ].filter(validTargetId);
      const exactCompiledControlLease = Boolean(
        expectedControlId
        && liveControlId
        && expectedControlId === liveControlId
        && liveActuatorIdentity.some((id) => expectedActuatorIdentity.has(id))
      );
      const observationScopedOwnershipLink = Boolean(
        expected.semanticOwnershipLinkId
        && expected.policyCorrectionForDecisionGroupId
        && expected.policyCorrectionForDecisionGroupId === decision.decisionGroupId
        && expectedControlId
        && liveControlId
        && expectedControlId === liveControlId
      );
      if (!observationScopedOwnershipLink && !exactCompiledControlLease) {
        return { ok: false, code: "TARGET_DECISION_GROUP_MISMATCH", expected, live };
      }
      warnings.push({
        code: exactCompiledControlLease
          ? "TARGET_DECISION_GROUP_RECOMPILED_FOR_EXACT_LEASE"
          : "TARGET_DECISION_GROUP_LINKED_ACROSS_SURFACES",
        expectedDecisionGroupId,
        liveDecisionGroupId: live.decisionGroupId,
        semanticOwnershipLinkId: expected.semanticOwnershipLinkId
      });
    }
    // The canonical registry is the semantic authority. By execution time the
    // governor has already approved this control's intent and risk; the browser
    // validates identity, foreground ownership, operation compatibility, and
    // actionability without independently reclassifying its text.
    const expectedActuatorIds = new Set([
      expected.stateElementId,
      expected.preferredActivationElementId,
      ...(expected.actuators || []).map((item) => item.nodeId)
    ].filter(validTargetId));
    const liveActuatorIds = new Set([
      live.id,
      live.stateElementId,
      live.preferredActivationElementId,
      ...(live.actuators || []).map((item) => item.nodeId)
    ].filter(validTargetId));
    const governedOperation = decision.operation || "";
    if (governedOperation) {
      const capability = expected.operations?.[governedOperation] || live.operations?.[governedOperation] || null;
      const recovery = decision.boundedRecovery === true
        ? expected.recovery?.[governedOperation] || live.recovery?.[governedOperation] || null
        : null;
      const allowed = new Set(recovery
        ? [
            ...(recovery.actuatorIds || []),
            ...(recovery.strategies || []).map((strategy) => strategy.actuatorId)
          ]
        : capability?.actuatorIds || []);
      if ((!capability && !recovery) || !allowed.has(live.id)) {
        return { ok: false, code: "ACTION_OPERATION_ACTUATOR_MISMATCH", expected, live };
      }
    }
    if (
      live.ownershipIntegrity?.ok === false
      && (live.ownershipIntegrity.conflictingNodeIds || []).includes(live.id)
    ) {
      return { ok: false, code: "SELECTED_ACTUATOR_OWNERSHIP_CONFLICT", expected, live };
    }
    const controlMatches = Boolean(
      expectedControlId
      && liveControlId
      && expectedControlId === liveControlId
    ) || [...expectedActuatorIds].some((id) => liveActuatorIds.has(id));
    let idMatches = true;
    let exactIdMatch = false;
    const expectedIds = [expected.id, decision.targetId].filter(validTargetId);

    if (expectedIds.length) {
      const expectedElements = expectedIds.map((id) => elementById(id)).filter(Boolean);
      exactIdMatch = expectedIds.includes(live.id);
      if (!controlMatches && !exactIdMatch && !expectedElements.some((expectedElement) => expectedElement === element || expectedElement.contains(element))) {
        return { ok: false, code: "TARGET_ID_MISMATCH", expected, live };
      }
      idMatches = exactIdMatch || controlMatches;
    }

    const expectedLabel = normalizeMatchText(expected.normalizedLabel || expected.label || decision.targetLabel || decision.value || "");
    let labelMatches = true;
    if (expectedLabel) {
      const exactRequired = shortNavLabel(expectedLabel) || ["continue", "next", "choose seat"].includes(expectedLabel) || isDangerousActionLabel(expectedLabel);
      labelMatches = exactRequired
        ? live.normalizedLabel === expectedLabel
        : live.normalizedLabel === expectedLabel || live.normalizedLabel.includes(expectedLabel) || expectedLabel.includes(live.normalizedLabel);
      if (!labelMatches) {
        const liveLooksDangerous = isDangerousActionLabel(`${live.label || ""} ${live.normalizedLabel || ""}`);
        if (!controlMatches && (!exactIdMatch || exactRequired || strictSurface || liveLooksDangerous)) {
          return { ok: false, code: "TARGET_LABEL_MISMATCH", expected, live };
        }
        warnings.push("TARGET_LABEL_DRIFT");
      }
    }

    if (strictSurface) {
      if (validTargetId(expected.surfaceId)) {
        const expectedSurface = elementById(expected.surfaceId);
        const authoritativeSurface = map.currentSurface || { id: "surface-page", type: "page" };
        const liveMembership = surfaceMembershipForElement(element, authoritativeSurface);
        const registeredOrRelated = authoritativeSurface.id === expected.surfaceId
          && liveMembership.surfaceId === expected.surfaceId;
        if (!expectedSurface || (!registeredOrRelated && expectedSurface !== element && !expectedSurface.contains(element))) {
          return { ok: false, code: "TARGET_SURFACE_MISMATCH", expected, live };
        }
      } else if (!live.surfaceId && map?.currentSurface?.type && map.currentSurface.type !== "page") {
        return { ok: false, code: "TARGET_NOT_IN_ACTIVE_SURFACE", expected, live };
      }
    }

    if (!boxesCloseEnough(expected.visualRegion || expected.box, live.visualRegion || live.box)) {
      if (strictSurface && !controlMatches) {
        return { ok: false, code: "TARGET_BOX_DRIFT", expected, live };
      }
      warnings.push("TARGET_BOX_DRIFT");
    }

    return { ok: true, expected, live, warnings, actionability: exactActionability };
  }

  function validateVisualCoordinateTarget(decision = {}, hit, map = agent.pageMap || buildPageMap()) {
    const expected = decision.targetSnapshot || {};
    const region = decision.visualRegion || expected.visualRegion || null;
    const x = Number(decision.x);
    const y = Number(decision.y);
    const values = [x, y, Number(region?.x), Number(region?.y), Number(region?.width), Number(region?.height)];
    const controlledRecovery = expected.source === "visual_control_recovery"
      || (
        decision.boundedRecovery === true
        && decision.interactionMethod === "visual_coordinate"
        && decision.pipelineContract?.capability?.status === "unproven_experiment"
      );
    const visualFallback = expected.source === "visual_fallback"
      || decision.mechanicalHypothesis === true;
    let controlledRecoveryControl = null;
    let controlledRecoveryWrapper = null;
    if ((!visualFallback && !controlledRecovery) || !region || values.some((value) => !Number.isFinite(value))) {
      return { ok: false, code: "VISUAL_REGION_REQUIRED", expected, live: liveTargetSnapshot(hit, map) };
    }
    if (controlledRecovery) {
      const control = (map.controls || []).find((item) => item.controlId === (decision.controlId || expected.controlId));
      const recovery = control?.recovery?.[decision.operation || expected.recoveryOperation || ""];
      const regionMatches = (recovery?.regions || []).some((candidate) => visualRegionContractsMatch(candidate, region));
      if (!control || !recovery || recovery.requiresVisualConfirmation !== true || !regionMatches) {
        return { ok: false, code: "VISUAL_CONTROL_RECOVERY_UNPROVEN", expected, live: liveTargetSnapshot(hit, map) };
      }
      if (region.observationId && region.observationId !== decision.observationId) {
        return { ok: false, code: "VISUAL_OBSERVATION_MISMATCH", expected, live: liveTargetSnapshot(hit, map) };
      }
      if (region.controlId && region.controlId !== control.controlId) {
        return { ok: false, code: "VISUAL_CONTROL_MISMATCH", expected, live: liveTargetSnapshot(hit, map) };
      }
      if (region.operation && region.operation !== decision.operation) {
        return { ok: false, code: "VISUAL_OPERATION_MISMATCH", expected, live: liveTargetSnapshot(hit, map) };
      }
      const wrapperMember = (control.actuators || []).find((item) => (
        item.relation === "wrapper"
        && item.nodeId
        && item.nodeId !== control.stateElementId
        && boxesCloseEnough(item.box, region)
      ));
      controlledRecoveryControl = control;
      controlledRecoveryWrapper = wrapperMember ? elementById(wrapperMember.nodeId) : null;
      if (!controlledRecoveryWrapper
        || !isVisible(controlledRecoveryWrapper)
        || isDisabledLike(controlledRecoveryWrapper)) {
        return { ok: false, code: "VISUAL_CONTROL_WRAPPER_UNAVAILABLE", expected, live: liveTargetSnapshot(hit, map) };
      }
    }
    if (region.width < 4 || region.height < 4 || x < region.x || x > region.x + region.width || y < region.y || y > region.y + region.height) {
      return { ok: false, code: "VISUAL_POINT_OUTSIDE_REGION", expected, live: liveTargetSnapshot(hit, map) };
    }
    if (region.viewportWidth && Number(region.viewportWidth) !== window.innerWidth) {
      return { ok: false, code: "VISUAL_VIEWPORT_CHANGED", expected, live: liveTargetSnapshot(hit, map) };
    }
    if (region.viewportHeight && Number(region.viewportHeight) !== window.innerHeight) {
      return { ok: false, code: "VISUAL_VIEWPORT_CHANGED", expected, live: liveTargetSnapshot(hit, map) };
    }
    if (!hit || hit.closest?.("#atw-sidebar") || isPaymentField(hit) || !targetBelongsToCurrentSurface(map, hit)) {
      return { ok: false, code: "VISUAL_TARGET_OUTSIDE_FOREGROUND", expected, live: liveTargetSnapshot(hit, map) };
    }
    const currentSurface = map.currentSurface || { id: "surface-page", type: "page" };
    if (currentSurface.type && currentSurface.type !== "page" && region.surfaceId !== currentSurface.id) {
      return { ok: false, code: "VISUAL_SURFACE_MISMATCH", expected, live: liveTargetSnapshot(hit, map) };
    }
    const top = document.elementFromPoint(x, y);
    if (!top || !(top === hit || hit.contains?.(top) || top.contains?.(hit))) {
      return { ok: false, code: "VISUAL_TARGET_OCCLUDED", expected, live: liveTargetSnapshot(hit, map) };
    }
    const rect = hit.getBoundingClientRect();
    const style = getComputedStyle(hit);
    const disabledStateIntercept = Boolean(
      controlledRecoveryWrapper
      && controlledRecoveryControl
      && elementId(hit) === controlledRecoveryControl.stateElementId
      && isDisabledLike(hit)
    );
    if (!disabledStateIntercept && (
      rect.width < 2
      || rect.height < 2
      || style.visibility === "hidden"
      || style.display === "none"
      || style.pointerEvents === "none"
      || Number(style.opacity || 1) < 0.15
      || isDisabledLike(hit)
    )) {
      return { ok: false, code: "VISUAL_TARGET_NOT_ACTIONABLE", expected, live: liveTargetSnapshot(hit, map) };
    }
    if (decision.risk !== "safe") {
      return { ok: false, code: "VISUAL_RISK_UNAPPROVED", expected, live: liveTargetSnapshot(hit, map) };
    }
    return {
      ok: true,
      expected,
      live: liveTargetSnapshot(hit, map),
      warnings: [],
      dispatchTarget: controlledRecoveryWrapper || hit
    };
  }


  function currentSurfaceEntryForElement(map, element) {
    if (!element) return null;
    const id = elementId(element);
    return currentSurfaceEntries(map).find((entry) => entry.id === id) || null;
  }

  function isActionableClickTarget(element) {
    return Boolean(element?.matches?.("button, a, input[type='button'], input[type='submit'], [role='button'], [role='option'], [role='checkbox'], [role='radio'], label, input[type='checkbox'], input[type='radio'], [tabindex]"));
  }

  function resolveDecisionTarget(decision, map) {
    const canonicalTargetAction = ["click", "type", "select", "keypress", "scroll"].includes(decision.action);
    if (!canonicalTargetAction) return null;

    const requestedVisualRef = decision.visualRef || decision.targetSnapshot?.visualRef || "";
    const requestedControlId = decision.controlId || decision.targetSnapshot?.controlId || "";
    const aliasIndex = buildCanonicalAliasIndex(map);
    const requestedAliases = decisionTargetAliasIds(decision);
    const unresolvedAliases = requestedAliases.filter((aliasId) => !aliasIndex.resolve(aliasId));
    const resolvedControlIds = [...new Set(requestedAliases
      .map((aliasId) => aliasIndex.resolve(aliasId)?.controlId || "")
      .filter(Boolean))];
    const stableIdentityAliases = [
      requestedControlId,
      decision.stableKey,
      decision.targetSnapshot?.stableKey
    ].map((value) => String(value || "").trim()).filter(Boolean);
    const stableIdentityControlIds = [...new Set(stableIdentityAliases
      .map((aliasId) => aliasIndex.resolve(aliasId)?.controlId || "")
      .filter(Boolean))];
    const visualAnnotation = requestedVisualRef
      ? (map.screenshotAnnotations || []).find((item) => item.visualRef === requestedVisualRef) || null
      : null;
    const boundedStableRebind = stableIdentityControlIds.length === 1;
    const control = boundedStableRebind
      ? aliasIndex.byControlId.get(stableIdentityControlIds[0]) || null
      : requestedAliases.length && !unresolvedAliases.length && resolvedControlIds.length === 1
        ? aliasIndex.byControlId.get(resolvedControlIds[0]) || null
        : null;
    if (!control?.controlId) {
      logFlow("target.resolve_failed", {
        code: unresolvedAliases.length
          ? "CANONICAL_ALIAS_UNRESOLVED"
          : (resolvedControlIds.length > 1 ? "CANONICAL_ALIAS_CONFLICT" : "CANONICAL_TARGET_REQUIRED"),
        requested: { controlId: requestedControlId, visualRef: requestedVisualRef, targetId: decision.targetId, targetLabel: decision.targetLabel },
        aliases: requestedAliases,
        unresolvedAliases,
        resolvedControlIds,
        indexConflicts: aliasIndex.conflicts.slice(0, 8),
        reason: "Mutating actions require a control from the current observation registry."
      });
      return null;
    }

    const memberIds = new Set([
      ...controlMemberNodeIds(control),
      ...Object.values(control.operations || {}).flatMap((capability) => capability?.actuatorIds || [])
    ]);
    const capability = decision.operation ? control.operations?.[decision.operation] : null;
    const recovery = decision.boundedRecovery === true && decision.operation
      ? control.recovery?.[decision.operation] || null
      : null;
    if (decision.operation && !capability && !recovery) {
      logFlow("target.resolve_failed", {
        code: "CANONICAL_OPERATION_UNAVAILABLE",
        requested: { controlId: control.controlId, operation: decision.operation }
      });
      return null;
    }
    const exactAliases = [decision.targetId, decision.targetSnapshot?.id, visualAnnotation?.targetId];
    const requestedElementId = exactAliases.find((aliasId) => {
      if (!validTargetId(aliasId) || !memberIds.has(aliasId)) return false;
      const kind = aliasIndex.aliasKinds.get(aliasId) || "";
      return ["click", "scroll"].includes(decision.action)
        ? ["state", "activation", "label", "annotation_target", "decision_target"].includes(kind)
          || kind === `recovery:${decision.operation}`
        : kind === "state" && aliasId === control.stateElementId;
    }) || "";
    const candidateIds = (recovery
      ? [
          requestedElementId,
          ...(recovery.actuatorIds || []),
          ...(recovery.strategies || []).map((strategy) => strategy.actuatorId)
        ]
      : capability
      ? [
          requestedElementId,
          capability.actuatorId,
          ...(capability.actuatorIds || [])
        ]
      : ["click", "scroll"].includes(decision.action)
      ? [
          requestedElementId,
          visualAnnotation?.targetId,
          control.preferredActivationElementId,
          ...(control.actuators || [])
            .filter((item) => ["activation", "label", "state"].includes(item.relation || ""))
            .map((item) => item.nodeId),
          control.stateElementId
        ]
      : [
          requestedElementId,
          control.stateElementId,
          ...(control.actuators || [])
            .filter((item) => item.relation === "state")
            .map((item) => item.nodeId)
        ]
    ).filter((id, index, list) => validTargetId(id) && memberIds.has(id) && list.indexOf(id) === index);
    const operationCompatible = (element) => {
      if (!element) return false;
      if (decision.action === "type") {
        const tag = (element.tagName || "").toLowerCase();
        const type = (element.getAttribute?.("type") || "").toLowerCase();
        return element.isContentEditable
          || tag === "textarea"
          || (tag === "input" && !["button", "submit", "reset", "radio", "checkbox", "file", "hidden"].includes(type));
      }
      if (decision.action === "select") return element.tagName === "SELECT";
      if (decision.action === "keypress") {
        return typeof element.focus === "function"
          && (element.matches?.("input, textarea, select, button, [tabindex], [contenteditable], [role='combobox'], [role='listbox'], [role='option']")
            || element.isContentEditable);
      }
      return true;
    };
    const controlTarget = candidateIds
      .map((id) => elementById(id))
      .find((element) => element
        && isVisible(element)
        && !isDisabledLike(element)
        && operationCompatible(element)
        && (!["click", "scroll"].includes(decision.action) || meaningfulActionBox(elementBox(element))));

    if (controlTarget) {
      logFlow("target.resolve", {
        method: requestedElementId ? "exact-canonical-member" : boundedStableRebind && unresolvedAliases.length ? "bounded-stable-rebind" : "canonical-control",
        requested: { controlId: control.controlId, visualRef: requestedVisualRef, targetId: decision.targetId },
        resolved: elementDescriptor(controlTarget)
      });
      return controlTarget;
    }

    logFlow("target.resolve_failed", {
      code: ["type", "select"].includes(decision.action)
        ? "ACTION_ACTUATOR_KIND_MISMATCH"
        : "CANONICAL_ACTUATOR_UNAVAILABLE",
      requested: { controlId: control.controlId, targetId: decision.targetId },
      actuators: candidateIds
    });
    return null;
  }


  return {
    boxesCloseEnough,
    currentSurfaceEntryForElement,
    elementDescriptor,
    failedLocalStrategyForDecision,
    isActionableClickTarget,
    isAuthorizedCompletedChoiceSurfaceExit,
    isStrictActionSurfaceType,
    liveTargetSnapshot,
    normalizedElementLabel,
    rememberFailedLocalStrategy,
    resolveDecisionTarget,
    shortNavLabel,
    targetBelongsToCurrentSurface,
    targetFingerprint,
    targetLocalDispatchIdentity,
    validateResolvedTarget,
    validateVisualCoordinateTarget,
    validTargetId
  };
}
