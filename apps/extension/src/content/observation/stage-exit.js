export function createStageExitCompiler({
  unfilledRequiredFields,
  actionableCheckoutErrors
}) {
  function buildStageExit(decisionGroups, fields, _buttons, errors, _step, controls = [], _terminalEvidence = null) {
    const isUnboundSelectionCta = (control) => (
      /selection[_ -]?cta/.test(`${control?.semantic || ""} ${control?.semanticType || ""} ${control?.meaning || ""}`.toLowerCase())
      && !control?.choiceContract
    );
    // Navigation is a derived view of the canonical control graph. Raw button
    // models are intentionally excluded: allowing both representations to
    // publish mechanics made one DOM actuator appear twice with conflicting
    // meaning/actionability and let stale text heuristics outrank fresh proof.
    const semanticContinueControls = controls.filter((control) => (
      !isUnboundSelectionCta(control)
      && (
        control.semantic === "continue"
        || control.semanticType === "continue"
        || ["advance_surface", "advance_checkout_stage"].includes(control.physicalEffect)
        || /(?:^|\s)(?:continue|next)(?:\s|$)/i.test(control.label || "")
      )
    ));
    const continueControls = [...new Map(
      semanticContinueControls.map((control) => [control.controlId, control])
    ).values()];
    const actionabilityForControl = (control) => {
      const capabilities = Object.values(control.operations || {});
      const strategies = capabilities.flatMap((capability) => capability?.strategies || []);
      const executableStrategy = strategies.find((strategy) => strategy?.proof?.executable === true);
      const revealableStrategy = strategies.find((strategy) => strategy?.proof?.revealable === true);
      const selectedStrategy = executableStrategy || revealableStrategy || strategies[0] || null;
      const capability = capabilities.find((item) => (
        item?.actuatorId === selectedStrategy?.actuatorId
        || item?.actuatorIds?.includes(selectedStrategy?.actuatorId)
      )) || capabilities.find((item) => item?.actionability) || capabilities[0] || null;
      const proof = selectedStrategy?.proof || capability?.actionability || {};
      return {
        targetId: selectedStrategy?.actuatorId
          || capability?.actuatorId
          || control.preferredActivationElementId
          || control.stateElementId
          || "",
        operation: selectedStrategy?.operation || capability?.operation || "activate",
        method: selectedStrategy?.method || "",
        proof
      };
    };
    const stageExitCandidates = continueControls.map((control) => {
      const { targetId, operation, method, proof } = actionabilityForControl(control);
      const disabled = Boolean(
        control.logicalDisabled === true
        || control.disabled === true
        || control.state?.disabled === true
        || proof.code === "ACTUATOR_DISABLED"
      );
      const status = proof.executable === true
        ? "ready"
        : disabled
          ? "disabled"
          : proof.revealable === true
            ? "revealable"
            : proof.code === "ACTUATOR_OCCLUDED"
              ? "occluded"
              : "unavailable";
      return Object.freeze({
        controlId: control.controlId || "",
        actuatorId: targetId,
        operation,
        method,
        status,
        rendered: proof.rendered === true,
        visible: proof.visible === true,
        enabled: !disabled && proof.enabled === true,
        inViewport: proof.inViewport === true,
        inCurrentSurface: proof.inCurrentSurface === true,
        hitTested: proof.hitTested === true,
        notOccluded: proof.notOccluded === true,
        selfOccluded: proof.selfOccluded === true,
        executable: proof.executable === true,
        revealable: proof.revealable === true,
        code: String(proof.code || ""),
        hitTestEvidence: proof.hitTestEvidence || null
      });
    }).sort((left, right) => {
      const rank = { ready: 0, revealable: 1, occluded: 2, disabled: 3, unavailable: 4 };
      return (rank[left.status] ?? 9) - (rank[right.status] ?? 9);
    });
    const readyCandidate = stageExitCandidates.find((candidate) => candidate.status === "ready") || null;
    const observedCandidate = readyCandidate || stageExitCandidates[0] || null;
    const safeContinueObserved = Boolean(readyCandidate);
    const continueObserved = stageExitCandidates.length > 0;
    const continueDisabled = Boolean(
      stageExitCandidates.length
      && stageExitCandidates.every((candidate) => candidate.status === "disabled")
    );
    const actionableErrors = actionableCheckoutErrors(errors);
    const blockers = [];
    const unresolvedGroup = (decisionGroups || []).find((group) => (
      group.required && !["satisfied", "waived", "waived_by_policy"].includes(group.status)
    ));
    const unresolvedField = unfilledRequiredFields(fields)[0];
    if (unresolvedGroup) blockers.push(`unresolved decision: ${unresolvedGroup.sectionLabel || unresolvedGroup.requirementId || unresolvedGroup.decisionGroupId}`);
    if (unresolvedField) blockers.push(`required field: ${unresolvedField.label || unresolvedField.field || unresolvedField.controlId}`);
    if (actionableErrors.length) blockers.push(`visible errors: ${actionableErrors.slice(0, 2).join("; ")}`);
    if (!continueObserved) blockers.push("Continue not observed");
    else if (continueDisabled) blockers.push("Continue is disabled");
    else if (!safeContinueObserved) blockers.push("Continue is not safely actionable");
    return {
      projectionVersion: "canonical-navigation/v1",
      authority: "canonical_control_graph",
      continueAllowed: Boolean(
        safeContinueObserved
        && !continueDisabled
        && !unresolvedGroup
        && !unresolvedField
        && !actionableErrors.length
      ),
      candidates: Object.freeze(stageExitCandidates),
      continueObserved,
      continueDisabled,
      continueInViewport: readyCandidate?.inViewport === true || observedCandidate?.inViewport === true,
      navigationState: !continueObserved
        ? "not_observed"
        : continueDisabled
          ? "disabled"
          : safeContinueObserved
            ? "ready"
            : "not_safely_actionable",
      blockers
    };
  }

  function buildAuthoritativeStageExit({
    decisionGroups = [],
    fields = [],
    buttons = [],
    errors = [],
    step = "unknown",
    controls = [],
    terminalEvidence = null,
    currentSurface = { id: "surface-page", type: "page", blocksBackground: false }
  } = {}) {
    const stageExit = buildStageExit(decisionGroups, fields, buttons, errors, step, controls, terminalEvidence);
    return Object.freeze({
      ...stageExit,
      surfaceAuthority: Object.freeze({
        currentSurfaceId: currentSurface?.id || "surface-page",
        currentSurfaceType: currentSurface?.type || "page",
        blocksBackground: currentSurface?.blocksBackground === true,
        authority: "current_surface"
      })
    });
  }

  return Object.freeze({ buildStageExit, buildAuthoritativeStageExit });
}
