export function createPageMapCompiler(dependencies) {
  const {
    accessibilityNode,
    accessibilitySnapshot,
    actionElementLabel,
    actionRisk,
    activeOverlayElements,
    agentContract,
    beginObservationCompilation,
    boundHighCardinalityActionElements,
    buildActiveSurface,
    buildAuthoritativeStageExit,
    buildCanonicalControlGraph,
    buildCanonicalDecisionGroups,
    buildSectionModels,
    buildSurfaceStack,
    buildTaskQueue,
    candidateInputs,
    classifyStep,
    clickableAncestor,
    collectPaidChoices,
    collectValidationIssues,
    compactText,
    controlMemberNodeIds,
    currentObservationCompilation,
    dateFieldEvidenceForElement,
    describedText,
    detectCheckoutSections,
    detectField,
    discoverStructuralActionCollections,
    elementBox,
    elementId,
    fieldValue,
    foregroundSurfaceState,
    implicitRole,
    inferCheckoutSite,
    isAuxiliaryNavigationAction,
    isPaymentField,
    isPlaceholderChoiceValue,
    isVisible,
    labelElementForInput,
    labelText,
    logFlow,
    meaningfulActionBox,
    observeTerminalStructure,
    observedLocale,
    pageCoverage,
    pageReadinessFacts,
    priceFromText,
    primaryPageText,
    profileFieldGroupEvidence,
    queryAllDeep,
    semanticChoiceType,
    syncRequiredProfileChoiceGroups,
    transactionFactsEvidence,
    visibleOverlays,
    visiblePageText,
    visualPageState
  } = dependencies;

  function buildPageMap() {
    beginObservationCompilation();
    const text = primaryPageText();
    const fullText = visiblePageText();
    const sourceActionElements = queryAllDeep("button, a, input[type='button'], input[type='submit'], [role='button'], [role='option'], [role='menuitem'], [role='checkbox'], [role='radio']")
      .filter((button) => isVisible(button) && !button.closest("#atw-sidebar") && !isPaymentField(button) && !isAuxiliaryNavigationAction(button));
    const structuralCollections = discoverStructuralActionCollections(sourceActionElements, `${text} ${fullText.slice(0, 2500)}`);
    const seatInventoryCount = structuralCollections
      .filter((collection) => collection.type === "seat_inventory")
      .reduce((total, collection) => total + collection.members.length, 0);
    const terminalStructure = observeTerminalStructure(fullText);
    const terminalEvidence = agentContract?.compileTerminalEvidence?.({
      url: location.href,
      visibleText: `${text} ${fullText}`,
      structuralEvidence: terminalStructure
    }) || null;
    const step = classifyStep({
      visibleText: `${text} ${fullText.slice(0, 2500)}`,
      url: location.href,
      structuralEvidence: { seatInventoryCount, ...terminalStructure },
      terminalEvidence
    });
    const fields = candidateInputs().map((input) => {
      const detected = detectField(input);
      const semantic = detected?.fieldType || detected?.field || "unknown";
      const value = fieldValue(input);
      const linkedRepresentationElements = [
        input,
        labelElementForInput(input),
        clickableAncestor(input)
      ].filter(Boolean);
      const renderedRepresentationElements = [...new Set(linkedRepresentationElements)]
        .filter((element) => isVisible(element));
      const representationLifecycle = {
        status: renderedRepresentationElements.length ? "active_rendered" : "dormant_hidden",
        active: renderedRepresentationElements.length > 0,
        stateRendered: isVisible(input),
        renderedMemberIds: renderedRepresentationElements.map(elementId).filter(Boolean)
      };
      return {
        element: input,
        id: elementId(input),
        label: labelText(input),
        name: input.getAttribute("name") || "",
        placeholder: input.getAttribute("placeholder") || "",
        pattern: input.getAttribute("pattern") || "",
        description: describedText(input),
        autocomplete: input.getAttribute("autocomplete") || "",
        inputMode: input.getAttribute("inputmode") || "",
        inputType: String(input.getAttribute("type") || input.type || "").toLowerCase(),
        locale: observedLocale(),
        formatHint: [input.getAttribute("placeholder"), input.getAttribute("aria-label"), input.getAttribute("name")]
          .filter(Boolean).join(" ").slice(0, 180),
        options: input.tagName === "SELECT"
          ? [...input.options].map((option) => ({ value: option.value, label: compactText(option.textContent || option.label || option.value, 120) })).slice(0, 120)
          : [],
        box: elementBox(input),
        kind: input.type || input.tagName.toLowerCase(),
        role: implicitRole(input),
        field: semantic,
        fieldType: semantic === "unknown" ? "" : semantic,
        fieldClassification: detected ? {
          fieldType: detected.fieldType || detected.field || "",
          source: detected.source || "observer",
          confidence: Number(detected.confidence || 0),
          evidence: [...(detected.evidence || [])],
          evidenceByChannel: detected.evidenceByChannel || null,
          tightOwnerId: detected.tightOwnerId || "",
          tightOwnerKey: detected.tightOwnerKey || "",
          ambiguity: detected.ambiguity || null
        } : null,
        semantic,
        dateField: semantic === "date_of_birth" ? dateFieldEvidenceForElement(input) : null,
        required: Boolean(
          input.required
          || input.getAttribute?.("aria-required") === "true"
          || /\*|\brequired\b/i.test(`${labelText(input)} ${profileFieldGroupEvidence(input).label}`)
        ),
        representationLifecycle,
        value,
        hasValue: Boolean(value && !isPlaceholderChoiceValue(value, input)),
        confidence: detected?.confidence || 0,
        accessibility: accessibilityNode(input, null)
      };
    });
    const boundedActions = boundHighCardinalityActionElements(sourceActionElements, structuralCollections);
    const buttons = boundedActions.elements
      .filter((button) => meaningfulActionBox(elementBox(button)))
      .map((button) => {
        const label = actionElementLabel(button);
        const lower = label.toLowerCase();
        const box = elementBox(button);
        return {
          element: button,
          id: elementId(button),
          label,
          box,
          role: implicitRole(button),
          semantic: semanticChoiceType(label),
          risk: actionRisk(lower),
          accessibility: accessibilityNode(button, null)
        };
      });
    const paidChoices = collectPaidChoices(fullText);
    const price = priceFromText(fullText);
    const overlays = visibleOverlays();
    const sections = buildSectionModels(detectCheckoutSections(), fields, buttons);
    const taskQueue = buildTaskQueue(sections);
    const activeSurface = buildActiveSurface(activeOverlayElements(), sections, taskQueue, structuralCollections);
    const controlCollections = [...new Map([
      ...(boundedActions.collections || []),
      ...(activeSurface.controlCollections || [])
    ].map((collection) => [collection.collectionId, collection])).values()];
    const controls = buildCanonicalControlGraph(sections, fields, buttons, activeSurface);
    syncRequiredProfileChoiceGroups(fields, controls, sections);
    const validationIssues = collectValidationIssues(text, fields, controls, sections, activeSurface);
    const errors = validationIssues.map((issue) => issue.message);
    const observationCompilation = currentObservationCompilation();
    const registryConflicts = observationCompilation.controlRegistry?.conflicts || [];
    const unresolvedGraphConflicts = registryConflicts.filter((conflict) => !conflict.resolved);
    const resolvedGraphConflicts = registryConflicts.filter((conflict) => conflict.resolved);
    const classifiedGraphConflicts = unresolvedGraphConflicts.map((conflict) => {
      const conflictControlIds = [
        ...(conflict.controlIds || []),
        conflict.existing?.controlId,
        conflict.incoming?.controlId
      ].filter(Boolean);
      const conflictNodeIds = new Set([conflict.aliasId, ...(conflict.nodeIds || [])].filter(Boolean));
      const affectedControlIds = controls.filter((control) => (
        conflictControlIds.includes(control.controlId)
        || controlMemberNodeIds(control).some((nodeId) => conflictNodeIds.has(nodeId))
      )).map((control) => control.controlId);
      return {
        ...conflict,
        classification: affectedControlIds.length ? "actionable" : "diagnostic",
        affectedControlIds
      };
    });
    const actionableGraphConflicts = classifiedGraphConflicts.filter((conflict) => conflict.classification === "actionable");
    const diagnosticGraphConflicts = classifiedGraphConflicts.filter((conflict) => conflict.classification === "diagnostic");
    const duplicateElementRekeys = observationCompilation.elementRegistry?.duplicateRekeys || [];
    if (duplicateElementRekeys.length) {
      logFlow("element.duplicate_id_rekeyed", {
        count: duplicateElementRekeys.length,
        samples: duplicateElementRekeys.slice(0, 8)
      });
    }
    const graphIntegrity = {
      ok: actionableGraphConflicts.length === 0,
      conflicts: classifiedGraphConflicts.slice(0, 12),
      unresolvedConflictCount: unresolvedGraphConflicts.length,
      actionableConflictCount: actionableGraphConflicts.length,
      diagnosticConflictCount: diagnosticGraphConflicts.length,
      actionableConflicts: actionableGraphConflicts.slice(0, 12),
      diagnosticConflicts: diagnosticGraphConflicts.slice(0, 12),
      resolvedConflictCount: resolvedGraphConflicts.length,
      resolvedConflicts: resolvedGraphConflicts.slice(0, 12),
      duplicateElementRekeyCount: duplicateElementRekeys.length,
      duplicateElementRekeys: duplicateElementRekeys.slice(0, 12)
    };
    const decisionGroups = buildCanonicalDecisionGroups(sections, controls, activeSurface);
    const surfaceModel = buildSurfaceStack(activeSurface, sections, taskQueue, overlays, step);
    const stageExit = buildAuthoritativeStageExit({
      decisionGroups,
      fields,
      buttons,
      errors,
      step,
      controls,
      currentSurface: surfaceModel.currentSurface
    });
    const transactionFacts = transactionFactsEvidence({
      step,
      price,
      decisionGroups,
      activeSurface,
      terminalEvidence
    });
    const map = {
      site: inferCheckoutSite(),
      step,
      text,
      fullText,
      coverage: pageCoverage(),
      readiness: pageReadinessFacts(),
      terminalEvidence,
      fields,
      buttons,
      overlays,
      surfaceStack: surfaceModel.surfaceStack,
      currentSurface: surfaceModel.currentSurface,
      currentSurfaceTasks: surfaceModel.currentSurfaceTasks,
      backgroundTasks: surfaceModel.backgroundTasks,
      errors,
      validationIssues,
      paidChoices,
      price,
      priceText: price ? `${price.amount} ${price.currency}` : "",
      transactionFacts,
      controls,
      controlCollections,
      graphIntegrity,
      decisionGroups,
      decisionContracts: decisionGroups.map((group) => group.decisionContract).filter(Boolean),
      sections,
      taskQueue,
      stageExit,
      summary: {
        fields: fields.length,
        knownFields: fields.filter((field) => field.field !== "unknown").length,
        buttons: buttons.length,
        sourceButtons: boundedActions.sourceCount,
        perceptionOmittedButtons: boundedActions.omittedCount,
        controls: controls.length,
        graphIntegrityOk: graphIntegrity.ok,
        graphIntegrityConflicts: graphIntegrity.conflicts.length,
        graphIntegrityResolvedConflicts: graphIntegrity.resolvedConflictCount,
        duplicateElementRekeys: graphIntegrity.duplicateElementRekeyCount,
        decisionGroups: decisionGroups.length,
        overlays: overlays.length,
        errors: errors.length,
        paidChoices: paidChoices.length,
        sections: sections.length,
        pendingTasks: taskQueue.filter((task) => task.status === "pending").length,
        lockedTasks: taskQueue.filter((task) => task.status === "locked").length,
        continueAllowed: stageExit.continueAllowed,
        priceText: price ? `${price.amount} ${price.currency}` : "",
        price,
        transactionFactsCompleteness: transactionFacts.itinerary.completeness
      }
    };
    map.accessibility = accessibilitySnapshot(map);
    map.foreground = foregroundSurfaceState(map.currentSurface || {});
    map.visualState = visualPageState(map);
    return map;
  }

  return Object.freeze({ buildPageMap });
}
