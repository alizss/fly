export function createControlGraphCompiler(dependencies) {
  const {
    accessibilityNode,
    applyControlToModel,
    checkedFieldLabels,
    choiceLabel,
    choiceRisk,
    compactText,
    controlExclusiveNodeIds,
    controlMemberNodeIds,
    controlText,
    controlsAreCompatibleAliases,
    createObservationControlRegistry,
    currentElementValue,
    currentObservationControlRegistry,
    currentPageMap,
    elementBox,
    elementById,
    elementId,
    implicitRole,
    isChoiceSelected,
    isVisible,
    logFlow,
    queryAllDeep,
    sectionButtonModels,
    sectionChoiceInputs,
    sectionChoiceSelected,
    sectionFieldModels,
    sectionHasRequiredChoice,
    sectionTypeFor,
    selectedControlLabels,
    semanticChoiceType,
    setObservationControlRegistry,
    stableControlKeyForElement,
    stateElementForControl,
    isSafeContinueLabel,
    surfaceMembershipForElement
  } = dependencies;

  function lookupControlForElement(map = currentPageMap(), element = null) {
    if (!element) return null;
    const elementNodeId = elementId(element);
    const dataControlId = element.dataset?.atwControlId || "";
    const state = stateElementForControl(element);
    const stateNodeId = state ? elementId(state) : "";
    const controls = map?.controls || [];
    const authoritative = controls.find((control) => dataControlId && control.controlId === dataControlId)
      || controls.find((control) => controlMemberNodeIds(control).includes(elementNodeId) || controlMemberNodeIds(control).includes(stateNodeId))
      || null;
    // The completed observation map owns semantic identity (including exact
    // decision-group assignment). The live registry is an earlier perception
    // stage and may not yet contain the group split applied after canonical
    // registration, so it is only a fallback for elements absent from the map.
    return authoritative || currentObservationControlRegistry()?.lookupElement?.(element) || null;
  }
  
  function applyControlsToObservationModels(sections = [], fields = [], buttons = [], activeSurface = {}, controls = []) {
    const byControlId = new Map((controls || []).map((control) => [control.controlId, control]));
    const resolveForModel = (model = {}) => {
      const current = model.controlId ? byControlId.get(model.controlId) : null;
      if (current) return current;
      const ids = [model.id, model.stateElementId, model.preferredActivationElementId, model.sourceElementId].filter(Boolean);
      return controls.find((control) => ids.some((id) => controlMemberNodeIds(control).includes(id))) || null;
    };
    const touch = (model) => {
      const control = resolveForModel(model);
      if (control) applyControlToModel(model, control);
    };
    (fields || []).forEach(touch);
    (buttons || []).forEach(touch);
    (sections || []).forEach((section) => {
      (section.fields || []).forEach(touch);
      (section.choices || []).forEach(touch);
      (section.buttons || []).forEach(touch);
    });
    if (activeSurface?.type && activeSurface.type !== "page") {
      (activeSurface.options || []).forEach(touch);
      (activeSurface.buttons || []).forEach(touch);
    }
  }
  
  function sanitizeCanonicalControlGraph(controls = []) {
    const ownersByNode = new Map();
    for (const control of controls) {
      for (const nodeId of controlExclusiveNodeIds(control)) {
        if (!ownersByNode.has(nodeId)) ownersByNode.set(nodeId, []);
        ownersByNode.get(nodeId).push(control);
      }
    }
    const conflictingNodes = new Set();
    for (const [nodeId, owners] of ownersByNode.entries()) {
      const unique = owners.filter((owner, index, list) => list.findIndex((other) => other.controlId === owner.controlId) === index);
      const conflict = unique.length > 1 && unique.some((owner) => unique.some((other) => owner !== other && !controlsAreCompatibleAliases(owner, other)));
      if (conflict) {
        conflictingNodes.add(nodeId);
      }
    }
    if (conflictingNodes.size) {
      const samples = [...conflictingNodes].slice(0, 8).map((nodeId) => {
        const unique = (ownersByNode.get(nodeId) || [])
          .filter((owner, index, list) => list.findIndex((other) => other.controlId === owner.controlId) === index);
        return {
          nodeId,
          owners: unique.map((owner) => ({
            controlId: owner.controlId,
            label: owner.label,
            semantic: owner.semantic,
            risk: owner.risk,
            decisionGroupId: owner.decisionGroupId
          })).slice(0, 6)
        };
      });
      logFlow("control.shared_actuator_conflict", {
        count: conflictingNodes.size,
        samples
      });
    }
    return controls.map((control) => {
      const selectedConflictNodeIds = controlExclusiveNodeIds(control)
        .filter((nodeId) => conflictingNodes.has(nodeId));
      const actuators = (control.actuators || []).filter((actuator) => {
        if (!conflictingNodes.has(actuator.nodeId)) return true;
        return !controlExclusiveNodeIds(control).includes(actuator.nodeId);
      });
      return {
        ...control,
        stateElementId: conflictingNodes.has(control.stateElementId) ? "" : control.stateElementId,
        preferredActivationElementId: conflictingNodes.has(control.preferredActivationElementId) ? "" : control.preferredActivationElementId,
        operations: Object.fromEntries(Object.entries(control.operations || {}).map(([operation, capability]) => [
          operation,
          capability ? {
            ...capability,
            actuatorIds: (capability.actuatorIds || []).filter((nodeId) => !conflictingNodes.has(nodeId)),
            actuatorId: conflictingNodes.has(capability.actuatorId) ? "" : capability.actuatorId,
            strategies: (capability.strategies || []).filter((strategy) => !conflictingNodes.has(strategy.actuatorId))
          } : null
        ])),
        recovery: Object.fromEntries(Object.entries(control.recovery || {}).map(([operation, recovery]) => [
          operation,
          recovery ? {
            ...recovery,
            actuatorIds: (recovery.actuatorIds || []).filter((nodeId) => !conflictingNodes.has(nodeId)),
            strategies: (recovery.strategies || []).filter((strategy) => !conflictingNodes.has(strategy.actuatorId))
          } : null
        ])),
        actuators,
        ownershipIntegrity: {
          ok: selectedConflictNodeIds.length === 0,
          selectedActuatorBlocked: selectedConflictNodeIds.includes(control.preferredActivationElementId)
            || Object.values(control.operations || {}).some((capability) => (
              capability?.actuatorIds || []
            ).some((nodeId) => selectedConflictNodeIds.includes(nodeId))),
          conflictingNodeIds: selectedConflictNodeIds
        }
      };
    });
  }
  
  function buildCanonicalControlGraph(sections = [], fields = [], buttons = [], activeSurface = {}) {
    const registry = createObservationControlRegistry();
    setObservationControlRegistry(registry);
    const register = (element, context, priority = null) => registry.register(element, context, priority);
  
    // Only an exclusive foreground surface may own actuator actionability.
    // A positioned/full-page container can be observed as a popover while the
    // page is hydrating, but when it does not block the background the runtime
    // current surface is still `surface-page`. Passing that contextual overlay
    // into canonical control construction made the same visible, enabled CTA
    // fail `inCurrentSurface` and disappear until a manual restart rebuilt the
    // page without the transient overlay classification.
    const surface = activeSurface?.type
      && activeSurface.type !== "page"
      && activeSurface.blocksBackground === true
      ? activeSurface
      : null;
    const closestSectionForElement = (element) => (sections || [])
      .map((section) => ({ section, owner: elementById(section.id) }))
      .filter((entry) => entry.owner?.contains?.(element))
      .sort((left, right) => {
        if (left.owner === right.owner) return 0;
        if (left.owner.contains(right.owner)) return 1;
        if (right.owner.contains(left.owner)) return -1;
        return 0;
      })[0]?.section || null;
    if (surface) {
      for (const item of [...(surface.options || []), ...(surface.buttons || [])]) {
        const source = elementById(item.id);
        const control = source ? register(source, { surface }, 100) : null;
        applyControlToModel(item, control);
      }
    }
  
    for (const field of fields || []) {
      const section = closestSectionForElement(field.element);
      const control = register(field.element, {
        section,
        sectionId: section?.id || "",
        sectionType: section?.type || "",
        sectionLabel: section?.label || "",
        field: field.fieldType || field.field,
        fieldType: field.fieldType || field.field,
        required: field.required
      }, section ? 50 : 10);
      applyControlToModel(field, control);
    }
  
    for (const button of buttons || []) {
      const stageNavigation = button.semantic === "continue"
        || isSafeContinueLabel(button.label || "")
        || /^(back|close|done)$/i.test((button.label || "").trim());
      const section = stageNavigation ? null : closestSectionForElement(button.element);
      const control = register(button.element, section ? {
        section,
        sectionId: section.id,
        sectionType: section.type,
        sectionLabel: section.label,
        required: false
      } : {
        field: button.semantic,
        required: false
      }, section ? 50 : 10);
      applyControlToModel(button, control);
    }
  
    for (const section of sections || []) {
      for (const [groupType, group] of [["fields", section.fields || []], ["choices", section.choices || []], ["buttons", section.buttons || []]]) {
        for (const item of group) {
          const source = elementById(item.stateElementId || item.id);
          const stageNavigation = groupType === "buttons"
            && (item.semantic === "continue" || isSafeContinueLabel(item.label || "") || /^(back|close|done)$/i.test((item.label || "").trim()));
          const context = stageNavigation
            ? { field: item.semantic || "navigation", required: false }
            : {
                section,
                sectionId: section.id,
                sectionType: section.type,
                sectionLabel: section.label,
                required: item.required
              };
          const control = source ? register(source, context, stageNavigation ? 10 : 50) : null;
          applyControlToModel(item, control);
        }
      }
    }
  
    const sanitized = sanitizeCanonicalControlGraph(registry.controls()).map((control) => {
      const membership = controlMemberNodeIds(control)
        .map(elementById)
        .filter(Boolean)
        .map((element) => surfaceMembershipForElement(element, surface || { type: "page" }))
        .find((result) => result.surfaceId === surface?.id)
        || { surfaceId: "surface-page", evidence: "background_page" };
      const belongsToForeground = Boolean(surface?.type && surface.type !== "page" && membership.surfaceId === surface.id);
      const owner = belongsToForeground ? surface : { id: "surface-page", type: "page", label: "Page" };
      return {
        ...control,
        surfaceId: owner.id,
        surfaceType: owner.type,
        surfaceLabel: owner.label,
        surfaceMembershipEvidence: membership.evidence
      };
    });
    if (surface) {
      surface.memberControlIds = sanitized
        .filter((control) => control.surfaceId === surface.id)
        .map((control) => control.controlId);
      surface.memberActuatorIds = sanitized
        .filter((control) => control.surfaceId === surface.id)
        .flatMap((control) => controlMemberNodeIds(control))
        .filter((id, index, list) => id && list.indexOf(id) === index);
    }
    applyControlsToObservationModels(sections, fields, buttons, activeSurface, sanitized);
    if (registry.conflicts.length) {
      const unresolved = registry.conflicts.filter((conflict) => !conflict.resolved);
      logFlow("control.registry_conflict", {
        count: registry.conflicts.length,
        unresolvedCount: unresolved.length,
        resolvedCount: registry.conflicts.length - unresolved.length,
        samples: registry.conflicts.slice(0, 8)
      });
    }
    return sanitized;
  }
  
  function decisionChoiceOwnerLabel(owner, input) {
    if (!owner) return "";
    const labelledBy = owner.getAttribute?.("aria-labelledby") || "";
    const labelledText = labelledBy
      ? labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ")
      : "";
    const legend = owner.querySelector?.("legend")?.textContent || "";
    const heading = owner.querySelector?.("h1, h2, h3, h4, h5, h6, [role='heading']")?.textContent || "";
    return compactText(
      owner.getAttribute?.("aria-label")
      || labelledText
      || legend
      || heading
      || "",
      140
    );
  }
  
  function structuralDecisionChoiceKind(input) {
    const inputType = String(input?.getAttribute?.("type") || "").toLowerCase();
    const role = String(implicitRole(input) || input?.getAttribute?.("role") || "").toLowerCase();
    if (inputType === "radio" || role === "radio") return "radio";
    if (inputType === "checkbox" || role === "checkbox") return "checkbox";
    return inputType || role || "choice";
  }
  
  function structuralDecisionChoicePeers(owner, input) {
    if (!owner || !input) return [];
    const kind = structuralDecisionChoiceKind(input);
    return queryAllDeep("input[type='radio'], input[type='checkbox'], [role='radio'], [role='checkbox']", owner)
      .filter((candidate) => (
        isVisible(candidate)
        && !candidate.closest("#atw-sidebar")
        && structuralDecisionChoiceKind(candidate) === kind
      ));
  }
  
  function validExclusiveDecisionOwner(owner, input, section = {}) {
    if (!owner || !input || structuralDecisionChoiceKind(input) !== "radio") return false;
    if (!owner.contains(input)) return false;
    if (section.element && !section.element.contains(owner)) return false;
    const peers = structuralDecisionChoicePeers(owner, input);
    return peers.length >= 2 && peers.length <= 10;
  }
  
  function exclusiveDecisionOwner(input, section = {}) {
    if (!input || structuralDecisionChoiceKind(input) !== "radio") return null;
    let owner = input.closest?.("fieldset, [role='radiogroup'], [role='group']") || null;
    if (validExclusiveDecisionOwner(owner, input, section)) return owner;
    owner = null;
    let current = input.parentElement;
    for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
      if (validExclusiveDecisionOwner(current, input, section)) return current;
      if (current === section.element) break;
    }
    return null;
  }
  
  function decisionOptionOwnerElement(element, decisionOwner = null) {
    if (!element) return null;
    for (let current = element.parentElement; current && current !== decisionOwner; current = current.parentElement) {
      if (current.matches?.("label, li, article, [role='group'], [data-option], [data-choice]")) return current;
      if (decisionOwner && current.parentElement === decisionOwner) return current;
    }
    return null;
  }
  
  function decisionChoiceContext(input, section = {}) {
    if (!input) return { instance: "", label: "", required: false };
    const inputType = String(input.getAttribute?.("type") || "").toLowerCase();
    const choiceKind = structuralDecisionChoiceKind(input);
    const name = String(input.getAttribute?.("name") || "").trim();
    const owner = choiceKind === "radio"
      ? exclusiveDecisionOwner(input, section)
      : (input.closest?.("fieldset, [role='group']") || null);
    const ownerLabel = decisionChoiceOwnerLabel(owner, input);
    const ownerKey = owner
      ? stableControlKeyForElement(owner, owner, "decision")
      : "";
    const instance = choiceKind === "radio" && name
      ? `radio:name:${name}`
      : choiceKind === "radio" && ownerKey
        ? `radio:owner:${ownerKey}`
        : `${inputType || choiceKind || "choice"}:control:${elementId(input)}`;
    const required = Boolean(
      input.required
      || input.getAttribute?.("aria-required") === "true"
      || owner?.getAttribute?.("aria-required") === "true"
    );
    return { instance, label: ownerLabel, required };
  }
  
  function sectionChoiceModels(section, allSections = []) {
    return sectionChoiceInputs(section, allSections)
      .map((input) => {
        const label = choiceLabel(input);
        const decision = decisionChoiceContext(input, section);
        return {
          id: elementId(input),
          label,
          selected: Boolean(isChoiceSelected(input)),
          semantic: semanticChoiceType(label),
          risk: choiceRisk(label),
          role: implicitRole(input),
          decisionInstance: decision.instance,
          decisionLabel: decision.label,
          decisionRequired: decision.required,
          accessibility: accessibilityNode(input, null),
          sourceElementId: elementId(input),
          box: elementBox(input)
        };
      })
      .filter((choice) => choice.label);
  }
  
  function unfilledRequiredFields(fields = []) {
    return fields.filter((field) => {
      if (field.representationLifecycle?.status === "dormant_hidden") return false;
      if (!field.required || field.field === "unknown" || field.hasValue || field.controlState?.valuePresent) return false;
      const groupedChoice = /radio|checkbox/i.test(String(field.kind || "")) || ["title", "gender"].includes(String(field.field || ""));
      if (!groupedChoice) return true;
      return !fields.some((peer) => (
        peer !== field
        && peer.field === field.field
        && (peer.hasValue || peer.controlState?.checked || peer.controlState?.selected)
      ));
    });
  }
  
  function inferSectionStatus(section, fields, buttons, allSections = []) {
    const type = sectionTypeFor(section.label, section.text);
    const selected = selectedControlLabels(section, allSections);
    const lower = section.text.toLowerCase();
    const requiredMissing = unfilledRequiredFields(fields);
    const PLACEHOLDER_TEXT = /^(choose|select|please select|select one|select one option|please choose)$/i;
    const hasSelectPlaceholder = queryAllDeep("select, [role='combobox'], button, [role='button'], [tabindex]", section.element)
      .filter((control) => isVisible(control) && !control.closest("#atw-sidebar"))
      .some((control) => {
        const value = (currentElementValue(control) || controlText(control) || "").trim();
        return PLACEHOLDER_TEXT.test(value);
      });
    // Note: intentionally NOT counting a static "select an option" / "please select" prompt
    // label as validation text — that label is always present regardless of whether a
    // choice has already been made, so treating it as an error blocked sections (like
    // cancellation_insurance, flexible_ticket) from ever reaching "complete".
    const hasValidationText = /must enter|invalid|not valid|too long|too short/.test(lower)
      || (/\bfield required\b/.test(lower) && requiredMissing.length > 0);
  
    if (type === "contact" || type === "passenger") {
      const stillMissing = requiredMissing.length || /must enter|invalid|not valid|too long|too short/.test(lower);
      return stillMissing ? "incomplete" : "complete";
    }
    if (type === "baggage") {
      const choices = sectionChoiceInputs(section, allSections);
      const checkedFields = checkedFieldLabels(fields);
      const hasBaggageDecision = choices.some((input) => /baggage|checked|kg|without|no checked/i.test(choiceLabel(input)));
      const selectedNoBaggage = [...selected, ...checkedFields].some((label) => /no checked baggage|no baggage|without/i.test(label));
      // A section like this can bundle more than one required radio group (e.g. cabin
      // baggage AND checked baggage on a self-transfer route) — resolving one used to be
      // enough to mark the whole section complete, silently leaving the other group
      // (its own required "Select one option") untouched and never queued as a task.
      // Every group of radio inputs sharing a name must have its own selection.
      const radioGroups = new Map();
      choices.filter((input) => input.type === "radio" && input.name).forEach((input) => {
        if (!radioGroups.has(input.name)) radioGroups.set(input.name, []);
        radioGroups.get(input.name).push(input);
      });
      const everyGroupResolved = [...radioGroups.values()].every((group) => group.some((input) => isChoiceSelected(input)));
      if (hasBaggageDecision) return selectedNoBaggage && everyGroupResolved ? "complete" : "incomplete";
      return /checked baggage\s+no baggage selected/i.test(lower) && !hasValidationText && everyGroupResolved ? "complete" : "incomplete";
    }
    if (type === "bundle") {
      const checkedFields = checkedFieldLabels(fields);
      const hasBundleDecision = sectionChoiceInputs(section, allSections).some((input) => /no,?\s*thanks|standard|premium|bundle|sms|support/i.test(choiceLabel(input)));
      const selectedDecline = [...selected, ...checkedFields].some((label) => /no,?\s*thanks|none|without bundle/i.test(label));
      if (hasBundleDecision) return selectedDecline ? "complete" : "incomplete";
      return /no,?\s*thanks\s+(?:checked|selected)/i.test(section.text) ? "complete" : "incomplete";
    }
    if (type === "flexible_ticket") {
      return !hasSelectPlaceholder && !hasValidationText ? "complete" : "incomplete";
    }
    if (type === "cancellation_insurance") {
      return [...selected, ...checkedFieldLabels(fields)].some((label) => /no,?\s*thanks|none|without/i.test(label)) && !hasValidationText ? "complete" : "incomplete";
    }
    if (type === "continue") return "gate";
    if (type === "payment") return "blocked";
    if (sectionHasRequiredChoice(section, allSections) && !sectionChoiceSelected(section, allSections)) return "incomplete";
    return hasValidationText || requiredMissing.length ? "incomplete" : "unknown";
  }
  
  function sectionObjective(section, type, status) {
    if (status === "complete") return "Verified complete; do not change unless a specific error appears.";
    const objectives = {
      contact: "Fill saved email, confirm email, country code, and phone.",
      passenger: "Fill saved traveler identity and title exactly from the profile.",
      baggage: "Decline checked baggage and keep included personal/hand baggage only.",
      bundle: "Decline bundle/support/SMS paid extras.",
      flexible_ticket: "Choose the zero-cost/no-passenger option.",
      cancellation_insurance: "Choose No thanks for paid cancellation/refund insurance.",
      seat: "Skip paid seat selection unless already included.",
      continue: "Click Continue only after all prior required sections are complete.",
      payment: "Stop before real payment or final booking."
    };
    return objectives[type] || "Resolve required visible controls safely.";
  }
  
  function buildSectionModels(sections, fields, buttons) {
    return sections.map((section, index) => {
      const text = (section.element.innerText || section.element.textContent || "").replace(/\s+/g, " ").trim();
      const type = sectionTypeFor(section.label, text);
      const sectionId = elementId(section.element);
      const sectionContext = { ...section, id: sectionId, type, text };
      const sectionFields = sectionFieldModels(sectionContext, fields, sections);
      const sectionButtons = sectionButtonModels(sectionContext, buttons, sections);
      const status = inferSectionStatus(sectionContext, sectionFields, sectionButtons, sections);
      const paidChoice = /eur|€|\$|add to cart|premium|bundle|insurance|cancellation|flexible|checked baggage|paid/i.test(text);
      return {
        id: sectionId,
        label: section.label,
        type,
        order: index + 1,
        status,
        required: /required|\*|select one option|choose your bundle|mobile number|first name|surname|title/i.test(text),
        paidChoice,
        objective: sectionObjective(section, type, status),
        selected: selectedControlLabels(section, sections),
        choices: sectionChoiceModels(sectionContext, sections),
        fields: sectionFields,
        buttons: sectionButtons,
        box: section.box,
        text: text.slice(0, 900)
      };
    });
  }
  
  function buildTaskQueue(sectionModels) {
    return sectionModels
      .filter((section) => section.type !== "continue" && section.status !== "complete" && section.status !== "blocked")
      .map((section) => ({
        id: `task-${section.id}`,
        sectionId: section.id,
        sectionLabel: section.label,
        sectionType: section.type,
        order: section.order,
        status: "pending",
        objective: section.objective,
        rule: section.paidChoice ? "Saved traveler rules: no paid extras unless explicitly approved." : "Use saved traveler profile and verify the result."
      }));
  }
  
  return Object.freeze({
    buildCanonicalControlGraph,
    buildSectionModels,
    buildTaskQueue,
    decisionChoiceOwnerLabel,
    exclusiveDecisionOwner,
    lookupControlForElement,
    structuralDecisionChoiceKind,
    structuralDecisionChoicePeers,
    unfilledRequiredFields
  });
}
