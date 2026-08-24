export function createDecisionGroupCompiler(dependencies) {
  const {
    NON_ECONOMIC_EFFECT_ROLES,
    ECONOMIC_EFFECT_ROLES,
    canonicalDecisionEffectRole,
    canonicalProfileFieldType,
    canonicalSelectionCommitments,
    choiceInteractionStates,
    choiceRisk,
    compactText,
    controlOwnedEvidence,
    controlText,
    decisionChoiceOwnerLabel,
    directControlName,
    elementById,
    elementId,
    isGlobalChromeControl,
    isPlaceholderChoiceValue,
    isVisible,
    normalizeMatchText,
    queryAllDeep,
    sectionTypeFor,
    semanticChoiceType,
    slugControlPart,
    stableControlKeyForElement,
    structuredPriceFromText,
    structuredPricesFromText,
    surfaceProgressMarkers
  } = dependencies;

  function applyControlToModel(model, control) {
    if (!model || !control) return model;
    model.controlId = control.controlId;
    model.stableKey = control.stableKey || model.stableKey || "";
    model.meaning = control.meaning || model.meaning || control.semantic || "";
    model.structuredPrice = control.structuredPrice || model.structuredPrice || null;
    model.dateField = control.dateField || model.dateField || null;
    model.decisionGroupId = control.decisionGroupId || model.decisionGroupId || "";
    model.controlKind = control.kind;
    model.controlState = control.state;
    model.representationLifecycle = control.representationLifecycle || model.representationLifecycle || null;
    model.currentValue = control.currentValue || "";
    model.fieldType = control.fieldType || model.fieldType || canonicalProfileFieldType(model.field || model.semantic || "");
    model.fieldClassification = control.fieldClassification?.fieldType
      ? control.fieldClassification
      : (model.fieldClassification || null);
    if (model.fieldType) model.field = model.fieldType;
    model.capabilities = control.capabilities || [];
    model.operations = control.operations;
    model.actionability = control.actionability || {};
    model.recovery = control.recovery || {};
    model.stateElementId = control.stateElementId;
    model.preferredActivationElementId = control.preferredActivationElementId;
    model.actuators = control.actuators;
    model.operations = control.operations;
    model.visualRegion = control.visualRegion;
    model.visualRegions = control.visualRegions || [];
    model.semantic = model.semantic || control.semantic;
    model.semanticIntent = model.semanticIntent || control.semanticIntent || control.semantic;
    model.physicalEffect = control.physicalEffect || model.physicalEffect || "unknown";
    model.risk = control.risk || model.risk;
    model.role = control.role || model.role;
    model.domRole = control.domRole || model.domRole || "";
    if (model.field || Object.prototype.hasOwnProperty.call(model, "value")) {
      const modelValue = String(model.value || control.currentValue || "").replace(/\s+/g, " ").trim();
      model.hasValue = Boolean(
        (modelValue && !isPlaceholderChoiceValue(modelValue, elementById(control.stateElementId || model.id || "")))
        || control.state?.selectedValue
        || control.state?.normalizedValue
        || control.state?.checked
        || control.state?.selected
      );
    }
    return model;
  }

  function syncRequiredProfileChoiceGroups(fields = [], controls = [], sections = []) {
    const byId = new Map(controls.map((control) => [control.controlId, control]));
    const sync = (items = []) => {
      for (const item of items) {
        const control = byId.get(item.controlId || item.id);
        const fieldType = canonicalProfileFieldType(item.fieldType || item.field || control?.fieldType || "");
        const choiceLike = /radio|checkbox/.test(`${item.kind || ""} ${item.role || ""} ${control?.kind || ""} ${control?.role || ""}`.toLowerCase());
        if (!choiceLike || !["title", "gender"].includes(fieldType) || !item.required || !control?.decisionGroupId) continue;
        item.hasValue = controls.some((peer) => (
          peer.decisionGroupId === control.decisionGroupId
          && canonicalProfileFieldType(peer.fieldType || peer.field || peer.semantic || "") === fieldType
          && Boolean(peer.selected || peer.state?.checked || peer.state?.selected)
        ));
      }
    };
    sync(fields);
    for (const section of sections) sync(section.fields || []);
  }

  function decisionGroupIdForContext({ sectionType = "", sectionLabel = "", field = "", surfaceId = "", surfaceType = "", stage = "", instance = "" } = {}) {
    if (!sectionType && !sectionLabel && !field) return "";
    const logicalType = sectionType && sectionType !== "unknown" ? sectionType : (field || "decision");
    const logicalLabel = sectionLabel && !/^additional section$/i.test(sectionLabel) ? sectionLabel : field;
    const key = [
      stage,
      surfaceType && surfaceType !== "page" ? surfaceType : "",
      surfaceId,
      logicalType || "decision",
      logicalLabel || "group",
      instance
    ].map(slugControlPart).filter(Boolean).join("_");
    return key ? `dg_${key}`.slice(0, 118) : "";
  }

  function sectionDecisionFields(section = {}) {
    return (section.fields || [])
      .filter((field) => {
        const kind = `${field.kind || ""} ${field.controlKind || ""} ${field.role || ""}`.toLowerCase();
        const semantic = `${field.semantic || ""} ${field.field || ""}`.toLowerCase();
        const value = field.controlState?.valueText || "";
        return /select|combobox|listbox/.test(kind)
          || /required_dropdown_choice/.test(semantic)
          || Boolean(value && field.required);
      });
  }

  function choiceLikeModelFromDecisionField(field = {}, control = {}) {
    const stateElement = elementById(control.stateElementId || field.id || "");
    const observedLabel = field.controlState?.valueText || control.state?.valueText || "";
    const selectedLabel = isPlaceholderChoiceValue(observedLabel, stateElement) ? "" : observedLabel;
    return {
      controlId: field.controlId || control.controlId || "",
      targetId: field.id || field.preferredActivationElementId || control.preferredActivationElementId || control.stateElementId || "",
      label: selectedLabel || field.label || control.label || "",
      semantic: selectedLabel ? semanticChoiceType(selectedLabel) : (field.semantic || control.semantic || "required_dropdown_choice"),
      risk: selectedLabel ? choiceRisk(selectedLabel) : (field.risk || control.risk || "uncertain"),
      selected: Boolean(selectedLabel),
      state: field.controlState || control.state || null,
      priceText: selectedLabel.match(/(?:\d+(?:[.,]\d{1,2})?\s?(?:EUR|€|USD|\$)|(?:EUR|€|USD|\$)\s?\d+(?:[.,]\d{1,2})?)/i)?.[0] || ""
    };
  }

  function choiceLikeModelFromDecisionControl(control = {}) {
    const observedValue = String(
      control.currentValue
      || control.state?.valueText
      || control.state?.selectedLabel
      || ""
    ).replace(/\s+/g, " ").trim();
    const interactionState = choiceInteractionStates.get(String(control.controlId || "")) || {};
    const committedLabelMatches = Boolean(
      interactionState.exactChoiceCommitted === true
      && interactionState.pageKey === `${location.origin}${location.pathname}`
      && (
        !interactionState.desiredLabel
        || normalizeMatchText(interactionState.desiredLabel) === normalizeMatchText(control.label || observedValue)
      )
    );
    const selectedByState = Boolean(
      control.selected
      || control.state?.checked
      || control.state?.selected
      || control.state?.pressed
      || committedLabelMatches
    );
    const controlShape = `${control.role || ""} ${control.domRole || ""} ${control.kind || ""}`.toLowerCase();
    const buttonLike = /button/.test(controlShape);
    const binaryChoice = /radio|checkbox|switch|toggle/.test(controlShape);
    const stateElement = elementById(control.stateElementId || control.preferredActivationElementId || "");
    const selectedLabel = selectedByState
      ? (control.label || observedValue)
      // A radio/checkbox value attribute identifies the option; it is not
      // evidence that the option is selected. Exact checked/selected state is
      // the sole authority for binary choices.
      : (!buttonLike && !binaryChoice && observedValue && !isPlaceholderChoiceValue(observedValue, stateElement) ? observedValue : "");
    const optionsSurfaceId = stateElement?.getAttribute?.("aria-controls") || "";
    const optionsSurface = optionsSurfaceId ? document.getElementById(optionsSurfaceId) : null;
    const committedEvidence = optionsSurfaceId ? canonicalSelectionCommitments.get(optionsSurfaceId) : null;
    const committedOption = selectedLabel && optionsSurface
      ? queryAllDeep("[role='option'], option, button, [role='menuitem']", optionsSurface).find((option) => (
          normalizeMatchText(controlText(option) || option.textContent || "") === normalizeMatchText(selectedLabel)
        ))
      : null;
    const matchingCommitment = committedEvidence
      && normalizeMatchText(committedEvidence.label || "") === normalizeMatchText(selectedLabel)
      ? committedEvidence
      : null;
    const committedControlId = matchingCommitment?.controlId || committedOption?.dataset?.atwControlId || "";
    return {
      controlId: committedControlId || control.controlId || "",
      targetId: matchingCommitment?.targetId || (committedOption ? elementId(committedOption) : (control.preferredActivationElementId || control.stateElementId || "")),
      label: selectedLabel || control.label || "",
      semantic: matchingCommitment?.semantic || (selectedLabel ? semanticChoiceType(selectedLabel) : (control.semantic || "required_dropdown_choice")),
      physicalEffect: control.physicalEffect || "unknown",
      risk: matchingCommitment?.risk || (selectedLabel ? choiceRisk(selectedLabel) : (control.risk || "uncertain")),
      effectRole: control.effectRole || canonicalDecisionEffectRole(control),
      selected: Boolean(selectedByState || selectedLabel),
      state: control.state || null,
      exclusive: control.choiceContract?.exclusive === true,
      selectionInvariant: control.choiceContract?.selectionInvariant || null,
      structuredPrice: control.structuredPrice || null,
      priceText: selectedLabel.match(/(?:\d+(?:[.,]\d{1,2})?\s?(?:EUR|€|USD|\$)|(?:EUR|€|USD|\$)\s?\d+(?:[.,]\d{1,2})?)/i)?.[0] || ""
    };
  }

  function decisionChoiceElement(choice = {}, byControlId = new Map()) {
    const control = byControlId.get(choice.controlId) || {};
    return elementById(
      choice.targetId
      || control.stateElementId
      || control.preferredActivationElementId
      || ""
    );
  }

  function ownedDecisionElement(section = {}, choices = [], byControlId = new Map()) {
    const nodes = choices.map((choice) => decisionChoiceElement(choice, byControlId)).filter(Boolean);
    const selected = choices.find((choice) => choice.selected) || choices[0] || null;
    const source = selected ? decisionChoiceElement(selected, byControlId) : nodes[0];
    const sectionElement = elementById(section.id || "") || section.element || null;
    if (!source || !sectionElement) return null;
    for (let current = source.parentElement; current; current = current.parentElement) {
      if (!sectionElement.contains(current) && current !== sectionElement) break;
      const ownsEveryChoice = nodes.every((node) => current.contains(node));
      const prices = structuredPricesFromText(current.innerText || current.textContent || "");
      if (ownsEveryChoice && prices.length) return current;
      if (current === sectionElement) break;
    }
    return null;
  }

  function selectedDisposition({ selected = null, selectedControl = {}, structuredPrice = null } = {}) {
    if (!selected) return "unknown";
    const effectRole = selected.effectRole || selectedControl.effectRole || canonicalDecisionEffectRole(selectedControl);
    if (NON_ECONOMIC_EFFECT_ROLES.has(effectRole)) return "non_economic";
    if (effectRole === "free_decline" || effectRole === "included_entitlement") return "free";
    if (Number(structuredPrice?.amount) > 0) return "paid";
    if (Number(structuredPrice?.amount) === 0) return "free";
    const selectedLabel = normalizeMatchText(selected.label || selectedControl.ownText || "");
    const exactSelectedMeaning = normalizeMatchText(`${selected.risk || ""} ${selected.semantic || ""}`);
    const exactActuatorMeaning = normalizeMatchText(
      (selectedControl.actuators || [])
        .filter((actuator) => ["label", "activation", "operation:choose"].includes(actuator.relation))
        .map((actuator) => actuator.label || "")
        .join(" ")
    );
    const broadControlMeaning = normalizeMatchText(`${selectedControl.risk || ""} ${selectedControl.semantic || ""}`);
    // Exact selected-choice evidence outranks broad semantics inferred from a
    // surrounding choice set. A free/decline choice must not inherit the paid
    // meaning of one of its siblings.
    if (/safe decline|decline|free|\bno\b|no extra|no thanks|none|without|skip|remove|not included|\bincluded\b|at no extra/.test(`${selectedLabel} ${exactSelectedMeaning} ${exactActuatorMeaning}`)) return "free";
    if (/money|paid|purchase|upgrade|premium|add paid|select paid/.test(`${selectedLabel} ${exactSelectedMeaning}`)) return "paid";
    if (/safe decline|decline|free|no extra|no thanks|none|without|skip|remove|not included/.test(broadControlMeaning)) return "free";
    if (/money|paid|purchase|upgrade|add paid|select paid/.test(broadControlMeaning)) return "paid";
    return "unknown";
  }

  function withOwnedSelectedEvidence(group = {}, section = {}, choices = [], byControlId = new Map()) {
    const selected = choices.find((choice) => choice.selected) || null;
    if (!selected) return group;
    const selectedControl = byControlId.get(selected.controlId) || {};
    const effectRole = selected.effectRole || selectedControl.effectRole || canonicalDecisionEffectRole(selectedControl);
    const economic = ECONOMIC_EFFECT_ROLES.has(effectRole);
    const directPrice = effectRole === "commerce_option" ? (selectedControl.structuredPrice
      || structuredPriceFromText(selected.priceText || "")
      || structuredPriceFromText(selected.label || "")) : null;
    // A selected option may use only its own price evidence. Broad ancestor
    // text often contains the booking total and unrelated sibling products;
    // inheriting the sole number found there fabricated paid conflicts on
    // ordinary purchaser-type, survey, and payment-method controls.
    const owner = null;
    const ownedPrice = null;
    const structuredPrice = directPrice || null;
    const disposition = selectedDisposition({ selected, selectedControl, structuredPrice });
    return {
      ...group,
      selectedEvidence: {
        selected: true,
        disposition,
        effectRole,
        economicEffect: economic ? "decision_outcome" : "none",
        structuredPrice,
        source: directPrice ? "selected_control" : (ownedPrice ? "owned_decision_section" : "selected_control_state"),
        ownerElementId: owner ? elementId(owner) : "",
        selectedControlId: selected.controlId || "",
        selectedLabel: selected.label || "",
        semantic: selected.semantic || selectedControl.semantic || "",
        risk: selected.risk || selectedControl.risk || ""
      }
    };
  }

  function attachExactCommerceOptionPrices(controls = []) {
    const commerceControls = (controls || []).filter((control) => (
      (control.effectRole || canonicalDecisionEffectRole(control)) === "commerce_option"
    ));
    for (const control of commerceControls) {
      if (control.structuredPrice || control.selected || control.state?.checked || control.state?.selected) continue;
      const source = elementById(control.preferredActivationElementId || control.stateElementId || "");
      if (!source) continue;
      let ownedPrice = null;
      for (let owner = source.parentElement, depth = 0; owner && depth < 6; owner = owner.parentElement, depth += 1) {
        const ownedCommerceControls = commerceControls.filter((candidate) => {
          const candidateSource = elementById(candidate.preferredActivationElementId || candidate.stateElementId || "");
          return candidateSource && owner.contains(candidateSource);
        });
        if (ownedCommerceControls.length !== 1 || ownedCommerceControls[0].controlId !== control.controlId) continue;
        const prices = structuredPricesFromText(owner.innerText || owner.textContent || "");
        if (prices.length !== 1) continue;
        ownedPrice = prices[0];
        break;
      }
      if (!ownedPrice) continue;
      control.structuredPrice = ownedPrice;
      control.risk = Number(ownedPrice.amount) > 0 ? "money" : "safe";
      if (control.choiceContract) {
        control.choiceContract = {
          ...control.choiceContract,
          structuredPrice: ownedPrice,
          priceEvidenceSource: control.choiceContract.priceEvidenceSource || "exact_commerce_option_owner"
        };
      }
    }
  }

  function explicitOwnedSelectionState(owner, removalSource) {
    if (!owner || !removalSource) return { selected: false, quantity: null, evidence: [] };
    const evidence = [];
    const selectedStateNode = [...owner.querySelectorAll([
      "input:checked",
      "option:checked",
      "[aria-selected='true']",
      "[aria-checked='true']",
      "[aria-pressed='true']",
      "[data-selected='true']",
      "[data-active='true']",
      "[data-selected-item]"
    ].join(", "))].find((node) => node !== removalSource && !removalSource.contains(node));
    const ownerSelectedItem = owner.matches?.("[data-selected-item]")
      && !/^(?:false|0|none|no)$/i.test(String(owner.getAttribute("data-selected-item") || "true").trim());
    if (selectedStateNode || ownerSelectedItem) evidence.push("explicit_selected_state");

    const quantityNodes = [...owner.querySelectorAll([
      "input[type='number']",
      "[role='spinbutton']",
      "[aria-valuenow]",
      "[data-quantity]",
      "[data-count]",
      "[class*='quantity']",
      "[class*='counter-value']",
      "[class*='count-value']",
      "output"
    ].join(", "))];
    const quantities = quantityNodes.map((node) => {
      const raw = node.value
        ?? node.getAttribute?.("aria-valuenow")
        ?? node.getAttribute?.("data-quantity")
        ?? node.getAttribute?.("data-count")
        ?? node.textContent
        ?? "";
      const normalized = String(raw || "").trim().replace(",", ".");
      return /^\d+(?:\.\d+)?$/.test(normalized) ? Number(normalized) : null;
    }).filter((value) => Number.isFinite(value));
    const quantity = quantities.length ? Math.max(...quantities) : null;
    if (Number.isFinite(quantity)) evidence.push(`explicit_quantity:${quantity}`);

    const ownerStateText = normalizeMatchText(owner.innerText || owner.textContent || "");
    const textualSelection = /\b(?:selected|added)\b|\bin (?:your|the) (?:trip|booking|basket|cart)\b/.test(ownerStateText);
    if (textualSelection) evidence.push("explicit_selected_copy");
    const textualQuantity = ownerStateText.match(/\b(?:quantity|qty|count)\s*[:x-]?\s*(\d+)\b/)
      || ownerStateText.match(/\b(\d+)\s+(?:bags?|items?)\s+(?:selected|added)\b/);
    const declaredQuantity = textualQuantity ? Number(textualQuantity[1]) : null;
    if (Number.isFinite(declaredQuantity)) evidence.push(`explicit_text_quantity:${declaredQuantity}`);
    const authoritativeQuantity = Number.isFinite(quantity) ? quantity : declaredQuantity;
    return {
      selected: Boolean(selectedStateNode || ownerSelectedItem || textualSelection || (Number.isFinite(authoritativeQuantity) && authoritativeQuantity > 0)),
      quantity: Number.isFinite(authoritativeQuantity) ? authoritativeQuantity : null,
      evidence
    };
  }

  function ownedRemovalDecisionGroups(sections = [], controls = [], existingGroups = [], activeSurface = {}) {
    const alreadyOwned = new Set(existingGroups.flatMap((group) => group.alternatives || []).map((choice) => choice.controlId).filter(Boolean));
    return controls.flatMap((control) => {
      if (!control?.controlId || alreadyOwned.has(control.controlId)) return [];
      const removalMeaning = normalizeMatchText(`${control.semantic || ""} ${control.physicalEffect || ""} ${control.testId || ""} ${control.formAction || ""} ${control.ownText || ""} ${control.ariaLabel || ""} ${control.title || ""} ${control.label || ""}`);
      if (!/remove|delete|deselect|unassign|clear selection/.test(removalMeaning)) return [];
      const source = elementById(control.preferredActivationElementId || control.stateElementId || "");
      const section = sections.find((item) => item.id === control.sectionId)
        || sections.find((item) => (elementById(item.id || "") || item.element)?.contains?.(source));
      if (!source) return [];
      const sectionElement = elementById(section?.id || "")
        || section?.element
        || source.closest?.("section, [role='region'], main")
        || document.body;
      let owner = null;
      let ownedPrice = null;
      for (let current = source.parentElement; current; current = current.parentElement) {
        if (!sectionElement.contains(current) && current !== sectionElement) break;
        const prices = structuredPricesFromText(current.innerText || current.textContent || "").filter((price) => price.amount > 0);
        const removalControls = [...current.querySelectorAll("button, [role='button'], input[type='button']")]
          .filter((element) => {
            const owned = controlOwnedEvidence(element);
            const localMeaning = normalizeMatchText([
              owned.ownText,
              owned.ariaLabel,
              owned.title,
              owned.testId,
              element.getAttribute?.("data-action"),
              directControlName(element)
            ].filter(Boolean).join(" "));
            return /remove|delete|deselect|unassign|clear selection/.test(localMeaning);
          });
        if (prices.length === 1 && removalControls.length === 1 && current.contains(source)) {
          owner = current;
          ownedPrice = prices[0];
          break;
        }
        if (current === sectionElement) break;
      }
      if (!owner || !ownedPrice) return [];
      // A remove/decrement affordance and a catalog price describe what the
      // widget can do, not what is currently selected. Quantity counters keep
      // both controls and the unit price rendered at zero. Only explicit
      // selected/quantity evidence may promote an offer into transaction state.
      const explicitSelection = explicitOwnedSelectionState(owner, source);
      if (!explicitSelection.selected) return [];
      const inferredSectionLabel = compactText(
        sectionElement?.getAttribute?.("aria-label")
        || sectionElement?.querySelector?.("h1, h2, h3, h4, h5, h6, [role='heading']")?.textContent
        || "",
        140
      );
      const localOwnerLabel = decisionChoiceOwnerLabel(owner, source);
      const localOwnerText = compactText(owner.innerText || owner.textContent || "", 500);
      const sectionType = sectionTypeFor(localOwnerLabel, localOwnerText);
      const nearbySectionType = section?.type || sectionTypeFor(inferredSectionLabel, "");
      const sectionLabel = localOwnerLabel || inferredSectionLabel || "Selected item";
      const progressMarkers = activeSurface.visualState?.progressMarkers || surfaceProgressMarkers(activeSurface.label || "");
      const surfaceInstance = [progressMarkers.flightOrdinal, progressMarkers.route].filter(Boolean).join(":");
      const decisionGroupId = decisionGroupIdForContext({
        sectionType,
        sectionLabel,
        instance: `selected-item:${surfaceInstance || "current-surface"}:${stableControlKeyForElement(owner, owner, "selected")}`
      });
      control.decisionGroupId = decisionGroupId;
      control.sectionId = section?.id || elementId(sectionElement);
      control.sectionType = sectionType;
      control.sectionLabel = sectionLabel;
      control.semantic = "remove_paid_extra";
      control.physicalEffect = "select_free_option";
      control.risk = "safe_decline";
      return [{
        decisionGroupId,
        surfaceId: control.surfaceId || "surface-page",
        sectionId: control.sectionId || "",
        sectionType,
        sectionLabel,
        requirementId: `${sectionType}:selected-item`,
        required: false,
        status: "satisfied",
        selectedControlId: "",
        selectedLabel: compactText(owner.innerText || owner.textContent || "", 180),
        selectedSemantic: "selected_paid_item",
        semanticOwnership: {
          status: sectionType === "unknown" ? "unknown" : "observed",
          family: sectionType === "unknown" ? "" : sectionType,
          source: sectionType === "unknown" ? "local_evidence_insufficient" : "local_owner_evidence",
          nearbySectionType: nearbySectionType || "unknown",
          nearbySectionLabel: section?.label || inferredSectionLabel || "",
          ownerElementId: elementId(owner),
          controlId: control.controlId
        },
        selectedEvidence: {
          selected: true,
          disposition: "paid",
          structuredPrice: ownedPrice,
          quantity: explicitSelection.quantity,
          source: "explicit_owned_selection_state",
          evidence: explicitSelection.evidence,
          ownerElementId: elementId(owner),
          selectedControlId: "",
          selectedLabel: compactText(owner.innerText || owner.textContent || "", 180),
          semantic: "selected_paid_item",
          risk: "money"
        },
        removalControlId: control.controlId,
        alternatives: [{
          controlId: control.controlId,
          targetId: control.preferredActivationElementId || control.stateElementId || "",
          label: control.label || "",
          semantic: control.semantic,
          physicalEffect: control.physicalEffect,
          risk: control.risk,
          selected: false,
          ownership: { ownerElementId: elementId(owner), relation: "remove_selected_item" }
        }],
        evidence: [`Selected paid item in ${sectionLabel}`, `Owned removal control: ${control.controlId}`]
      }];
    }).slice(0, 40);
  }

  function ownedCollapsedSelectorDecisionGroups(sections = [], controls = [], existingGroups = []) {
    return controls.flatMap((control) => {
      const selectorLike = /combobox|listbox|select/.test(
        `${control?.role || ""} ${control?.domRole || ""} ${control?.kind || ""}`.toLowerCase()
      );
      const hasOpenMechanic = Boolean(
        control?.operations?.open
        || (selectorLike && (control?.operations?.activate || control?.operations?.keyboard))
      );
      if (!control?.controlId || !hasOpenMechanic) return [];
      const existingGroup = existingGroups.find((group) => (group.alternatives || []).some((choice) => choice.controlId === control.controlId));
      if (existingGroup?.selectedEvidence?.selected === true
        && existingGroup.selectedEvidence.structuredPrice) return [];
      if (control.state?.expanded === true) return [];
      const displayedValue = compactText(
        control.currentValue
        || control.state?.valueText
        || control.ownText
        || "",
        180
      );
      const source = elementById(control.stateElementId || control.preferredActivationElementId || "");
      if (!displayedValue || isPlaceholderChoiceValue(displayedValue, source)) return [];
      if (!source) return [];
      const section = sections.find((item) => item.id === control.sectionId)
        || sections.find((item) => (elementById(item.id || "") || item.element)?.contains?.(source));
      const boundary = elementById(section?.id || "")
        || section?.element
        || source.closest?.("section, fieldset, [role='group'], [role='region'], main")
        || document.body;
      let owner = null;
      let ownedPrice = control.structuredPrice || null;
      for (let current = source; current; current = current.parentElement) {
        if (!boundary.contains(current) && current !== boundary) break;
        const prices = structuredPricesFromText(current.innerText || current.textContent || "");
        const selectorCount = queryAllDeep("select, [role='combobox'], [aria-haspopup='listbox']", current)
          .filter((element) => isVisible(element)).length;
        if (current.contains(source) && selectorCount === 1 && prices.length === 1) {
          owner = current;
          ownedPrice = ownedPrice || prices[0];
          break;
        }
        if (current === boundary) break;
      }
      if (!owner || !ownedPrice) return [];
      const inferredSectionLabel = compactText(
        boundary.getAttribute?.("aria-label")
        || boundary.querySelector?.("legend, h1, h2, h3, h4, h5, h6, [role='heading']")?.textContent
        || "",
        140
      );
      const localOwnerLabel = decisionChoiceOwnerLabel(owner, source);
      const localOwnerText = compactText(owner.innerText || owner.textContent || "", 500);
      const sectionType = sectionTypeFor(localOwnerLabel, `${displayedValue} ${localOwnerText}`);
      const nearbySectionType = section?.type || sectionTypeFor(inferredSectionLabel, "");
      const sectionLabel = localOwnerLabel || inferredSectionLabel || "Selected choice";
      const decisionGroupId = existingGroup?.decisionGroupId || decisionGroupIdForContext({
        sectionType,
        sectionLabel,
        instance: `collapsed-selector:${control.stableKey || stableControlKeyForElement(source, source, "selector")}`
      });
      const disposition = Number(ownedPrice.amount) > 0 ? "paid" : (Number(ownedPrice.amount) === 0 ? "free" : "unknown");
      control.decisionGroupId = decisionGroupId;
      control.sectionId = section?.id || elementId(boundary);
      control.sectionType = sectionType;
      control.sectionLabel = sectionLabel;
      control.structuredPrice = ownedPrice;
      const group = {
        decisionGroupId,
        surfaceId: control.surfaceId || "surface-page",
        surfaceType: control.surfaceType || "page",
        sectionId: control.sectionId,
        sectionType,
        sectionLabel,
        requirementId: `${sectionType}:collapsed-selector`,
        required: Boolean(control.required || control.state?.required),
        status: "satisfied",
        selectedControlId: control.controlId,
        selectedLabel: displayedValue,
        selectedSemantic: disposition === "paid" ? "selected_paid_item" : "selected_current_value",
        semanticOwnership: {
          status: sectionType === "unknown" ? "unknown" : "observed",
          family: sectionType === "unknown" ? "" : sectionType,
          source: sectionType === "unknown" ? "local_evidence_insufficient" : "local_owner_evidence",
          nearbySectionType: nearbySectionType || "unknown",
          nearbySectionLabel: section?.label || inferredSectionLabel || "",
          ownerElementId: elementId(owner),
          controlId: control.controlId
        },
        selectedEvidence: {
          selected: true,
          disposition,
          effectRole: "commerce_option",
          economicEffect: "decision_outcome",
          structuredPrice: ownedPrice,
          source: "exact_selector_owner",
          ownerElementId: elementId(owner),
          selectedControlId: control.controlId,
          selectedLabel: displayedValue,
          semantic: disposition === "paid" ? "selected_paid_item" : "selected_current_value",
          risk: disposition === "paid" ? "money" : (disposition === "free" ? "safe_decline" : "uncertain")
        },
        alternatives: [{
          controlId: control.controlId,
          targetId: control.preferredActivationElementId || control.stateElementId || "",
          label: displayedValue,
          semantic: "open_choice_control",
          physicalEffect: "open_surface",
          risk: "safe",
          effectRole: "commerce_option",
          structuredPrice: ownedPrice,
          selected: true,
          ownership: { ownerElementId: elementId(owner), relation: "collapsed_current_value" }
        }],
        evidence: [`Current displayed value: ${displayedValue}`, `Owned structured price: ${ownedPrice.amount} ${ownedPrice.currency || ""}`.trim()]
      };
      if (existingGroup) {
        Object.assign(existingGroup, group, {
          alternatives: (existingGroup.alternatives || []).map((alternative) => (
            alternative.controlId === control.controlId
              ? { ...alternative, ...group.alternatives[0] }
              : alternative
          ))
        });
        return [];
      }
      return [group];
    }).slice(0, 40);
  }

  function sectionDecisionControls(section = {}, controls = []) {
    return (controls || []).filter((control) => {
      if (!control?.controlId || control.sectionId !== section.id) return false;
      // A profile-field opener is one component of a logical value, not a
      // commerce decision. Its exact options remain owned by the field
      // adapter when the popup is active.
      if (control.fieldType && control.operations?.open && !control.choiceContract?.decisionInstance) return false;
      const role = `${control.role || ""} ${control.domRole || ""} ${control.kind || ""}`.toLowerCase();
      const semantic = String(control.semantic || "").toLowerCase();
      const optionalCommand = /button/.test(role) && (
        /decline_paid_extra|decline_baggage|add_paid_extra/.test(semantic)
        || /safe_decline|money|paid/.test(String(control.risk || "").toLowerCase())
        || Number(control.structuredPrice?.amount) > 0
      );
      return /combobox|listbox|select/.test(role)
        || /required_dropdown_choice/.test(semantic)
        || semantic === "payment_method"
        || optionalCommand
        || Boolean(control.choiceContract?.decisionInstance)
        || Boolean(control.operations?.open);
    });
  }

  function decisionControlContext(control = {}, section = {}, controls = []) {
    const role = `${control.role || ""} ${control.domRole || ""} ${control.kind || ""}`.toLowerCase();
    const semantic = String(control.semantic || "").toLowerCase();
    if (semantic === "payment_method") {
      return {
        instance: control.choiceContract?.decisionInstance
          || `payment-method:${section.id || normalizeMatchText(section.label || "payment method")}`,
        label: control.choiceContract?.decisionLabel || section.label || "Payment method",
        // A payment-method selector is a required gateway to card entry even
        // when the native radio or image tile omits required/aria-required.
        required: true
      };
    }
    if (control.choiceContract?.decisionInstance) {
      const owner = elementById(control.choiceContract.decisionOwnerId || "");
      return {
        instance: control.choiceContract.decisionInstance,
        label: control.choiceContract.decisionLabel || section.label || section.type || "choice",
        required: Boolean(
          control.choiceContract.advancesOnSelection === true
          || control.choiceContract.required === true
          ||
          control.required
          || control.state?.required
          || owner?.getAttribute?.("aria-required") === "true"
          || /required|select one|choose one|\*/i.test(owner?.innerText || "")
        )
      };
    }
    const optionalCommand = /button/.test(role) && (
      /decline_paid_extra|decline_baggage|add_paid_extra/.test(semantic)
      || /safe_decline|money|paid/.test(String(control.risk || "").toLowerCase())
      || Number(control.structuredPrice?.amount) > 0
    );
    if (!optionalCommand) {
      return {
        instance: `control:${control.stableKey || control.controlId || control.semantic || control.label}`,
        label: control.label || control.accessibleName || "",
        required: Boolean(control.required || control.state?.required)
      };
    }
    const sectionElement = elementById(section.id || "");
    const sourceElement = elementById(control.preferredActivationElementId || control.stateElementId || "");
    const optionalPeers = (controls || []).filter((peer) => {
      if (peer.sectionId !== section.id) return false;
      const peerRole = `${peer.role || ""} ${peer.domRole || ""} ${peer.kind || ""}`.toLowerCase();
      return /button/.test(peerRole) && (
        /decline_paid_extra|decline_baggage|add_paid_extra/.test(String(peer.semantic || "").toLowerCase())
        || /safe_decline|money|paid/.test(String(peer.risk || "").toLowerCase())
        || Number(peer.structuredPrice?.amount) > 0
      );
    });
    let owner = null;
    for (let current = sourceElement?.parentElement; current; current = current.parentElement) {
      const peers = optionalPeers.filter((peer) => {
        const element = elementById(peer.preferredActivationElementId || peer.stateElementId || "");
        return element && current.contains(element);
      });
      const hasDecline = peers.some((peer) => (
        /decline_paid_extra|decline_baggage/.test(String(peer.semantic || "").toLowerCase())
        || /safe_decline/.test(String(peer.risk || "").toLowerCase())
      ));
      const hasAdd = peers.some((peer) => (
        /add_paid_extra/.test(String(peer.semantic || "").toLowerCase())
        || /money|paid/.test(String(peer.risk || "").toLowerCase())
        || Number(peer.structuredPrice?.amount) > 0
      ));
      const exactSectionPair = current === sectionElement && peers.length === 2;
      if (peers.length >= 2
        && peers.length <= 8
        && hasDecline
        && hasAdd
        && (current !== sectionElement || exactSectionPair)) {
        owner = current;
        break;
      }
      if (current === sectionElement) break;
    }
    // A paid-looking or descriptive button is not a choice set by itself.
    // Publish custom command choices only when perception proves a bounded
    // local owner containing both an affirmative and a decline actuator.
    // Unmatched buttons remain in the canonical control registry as context,
    // but cannot become singleton required obligations.
    if (!owner) return null;
    const ownerLabel = decisionChoiceOwnerLabel(owner, sourceElement)
      || compactText(owner.querySelector?.("h1, h2, h3, h4, h5, h6, [role='heading']")?.textContent || "", 140)
      || section.label
      || section.type
      || "optional decision";
    return {
      instance: `offer:${ownerLabel}:${stableControlKeyForElement(owner, owner, "decision")}`,
      label: ownerLabel,
      // A bounded paid/decline offer proves the local decision owner, not that
      // the user must make an affirmative selection. Requiredness must come
      // from the state control or explicit local accessibility semantics.
      required: Boolean(
        sourceElement?.required
        || sourceElement?.getAttribute?.("aria-required") === "true"
        || owner?.getAttribute?.("aria-required") === "true"
      )
    };
  }

  function buildCanonicalDecisionGroups(sections = [], controls = [], activeSurface = {}) {
    attachExactCommerceOptionPrices(controls);
    const byControlId = new Map((controls || []).map((control) => [control.controlId, control]));
    const sectionGroups = (sections || [])
      .filter((section) => (
        Array.isArray(section.choices) && section.choices.length
        || sectionDecisionFields(section).length
        || sectionDecisionControls(section, controls).length
      ))
      .flatMap((section) => {
        const decisionControls = sectionDecisionControls(section, controls);
        const choiceModels = (section.choices || []).map((choice) => {
          const control = byControlId.get(choice.controlId) || {};
          return {
            controlId: choice.controlId || control.controlId || "",
            targetId: control.preferredActivationElementId || choice.id || control.stateElementId || "",
            label: control.label || choice.label || "",
            semantic: control.semantic || choice.semantic || "",
            risk: control.risk || choice.risk || "",
            effectRole: control.effectRole || "unknown",
            selected: Boolean(choice.selected || control.selected || control.state?.checked || control.state?.selected),
            state: choice.controlState || control.state || null,
            priceText: structuredPriceFromText(choice.label || "") ? choice.label : "",
            decisionInstance: choice.decisionInstance || `choice:${choice.controlId || choice.id || choice.label}`,
            decisionLabel: choice.decisionLabel || "",
            decisionRequired: Boolean(choice.decisionRequired)
          };
        });
        const fieldModels = sectionDecisionFields(section).map((field) => ({
          ...choiceLikeModelFromDecisionField(field, byControlId.get(field.controlId) || {}),
          decisionInstance: `field:${field.controlId || field.id || field.field || field.label}`,
          decisionLabel: field.label || "",
          decisionRequired: Boolean(field.required)
        }));
        const controlModels = decisionControls.flatMap((control) => {
          const decision = decisionControlContext(control, section, controls);
          if (!decision) return [];
          return [{
            ...choiceLikeModelFromDecisionControl(control),
            decisionInstance: decision.instance,
            decisionLabel: decision.label,
            decisionRequired: decision.required
          }];
        });
        const buckets = new Map();
        for (const choice of [...choiceModels, ...fieldModels, ...controlModels]) {
          if (!choice.controlId && !choice.targetId && !choice.label) continue;
          const key = choice.decisionInstance || `control:${choice.controlId || choice.targetId || normalizeMatchText(choice.label)}`;
          if (!buckets.has(key)) buckets.set(key, []);
          buckets.get(key).push(choice);
        }
        const groups = [...buckets.entries()].map(([instance, rawChoices]) => {
          const choices = rawChoices.filter((choice, index, list) => {
            const key = `${choice.controlId || choice.targetId}:${normalizeMatchText(choice.label)}`;
            return list.findIndex((other) => `${other.controlId || other.targetId}:${normalizeMatchText(other.label)}` === key) === index;
          });
          const groupLabel = choices.find((choice) => choice.decisionLabel)?.decisionLabel || section.label || section.type || "decision";
          const exactControls = choices.map((choice) => byControlId.get(choice.controlId)).filter(Boolean);
          const exactTypes = [...new Set(exactControls
            .map((control) => control.sectionType)
            .filter((type) => type && type !== "unknown"))];
          const exactOwnerIds = [...new Set(exactControls
            .map((control) => control.choiceContract?.decisionOwnerId)
            .filter(Boolean))];
          // A bounded decision owner is stronger than the broad visual section
          // around it. This prevents an optional product embedded on a
          // passenger page from becoming a passenger-identity obligation.
          const groupType = exactTypes.length === 1 ? exactTypes[0] : (section.type || "decision");
          const groupSectionId = exactOwnerIds.length === 1 ? exactOwnerIds[0] : (section.id || "");
          const decisionGroupId = decisionGroupIdForContext({
            sectionType: groupType,
            sectionLabel: groupLabel,
            instance
          });
          for (const choice of choices) {
            const control = byControlId.get(choice.controlId);
            if (control) control.decisionGroupId = decisionGroupId;
            const model = (section.choices || []).find((item) => item.controlId === choice.controlId || item.id === choice.targetId);
            if (model) model.decisionGroupId = decisionGroupId;
          }
          const exclusive = choices.some((choice) => choice.exclusive === true)
            || /^radio:/.test(String(instance || ""));
          const selectedChoices = choices.filter((choice) => choice.selected);
          const selectionInvariantValid = !exclusive || selectedChoices.length <= 1;
          const selected = selectionInvariantValid && selectedChoices.length === 1
            ? selectedChoices[0]
            : null;
          // Requiredness belongs to the smallest logical control owner. Broad
          // section flags are context only and must not activate every product
          // or toggle contained by that visual region.
          const required = Boolean(
            choices.some((choice) => choice.decisionRequired || choice.state?.required)
          );
          const group = {
            decisionGroupId,
            surfaceId: choices.map((choice) => byControlId.get(choice.controlId)?.surfaceId).find(Boolean) || "surface-page",
            sectionId: groupSectionId,
            sectionType: groupType,
            sectionLabel: groupLabel,
            requirementId: `${groupType}:${slugControlPart(groupLabel || instance)}`,
            required,
            status: selected ? "satisfied" : (required ? "missing" : "optional"),
            selectedControlId: selected?.controlId || "",
            selectedLabel: selected?.label || "",
            selectedSemantic: selected?.semantic || "",
            selectionInvariant: {
              exclusive,
              valid: selectionInvariantValid,
              selectedCount: selectedChoices.length
            },
            alternatives: choices.map((choice) => ({
              controlId: choice.controlId,
              targetId: choice.targetId,
              label: choice.label,
              semantic: choice.semantic,
              physicalEffect: choice.physicalEffect || byControlId.get(choice.controlId)?.physicalEffect || "unknown",
              risk: choice.risk,
              effectRole: choice.effectRole || byControlId.get(choice.controlId)?.effectRole || "unknown",
              selected: choice.selected,
              structuredPrice: byControlId.get(choice.controlId)?.structuredPrice || choice.structuredPrice || null,
              priceText: choice.priceText
            })),
            evidence: selected
              ? [`Selected: ${selected.label}`]
              : selectionInvariantValid
                ? [`No selected option for ${groupLabel}`]
                : [`Ambiguous exclusive selection for ${groupLabel}: ${selectedChoices.length} options appear selected`]
          };
          return withOwnedSelectedEvidence(group, section, choices, byControlId);
        });
        // Some custom widgets render the affirmative products as one native
        // choice set and the free decline as a separate checkbox even though
        // both are one logical decision. Merge only when ownership is
        // unambiguous inside this section: exactly one paid-only set and one
        // decline-only set. Sections with several sibling products remain
        // split and continue through the exact decision-group queue.
        const paidOnlyGroups = groups.filter((group) => (
          group.alternatives.length > 0
          && (group.selectionInvariant?.exclusive === true || group.alternatives.length >= 2)
          && group.alternatives.every((choice) => (
            /money|paid/.test(String(choice.risk || "").toLowerCase())
            || /add_paid_extra/.test(String(choice.semantic || "").toLowerCase())
          ))
        ));
        const declineOnlyGroups = groups.filter((group) => (
          group.alternatives.length > 0
          && group.alternatives.every((choice) => (
            /safe_decline/.test(String(choice.risk || "").toLowerCase())
            || /decline_paid_extra|decline_baggage/.test(String(choice.semantic || "").toLowerCase())
          ))
        ));
        if (paidOnlyGroups.length === 1 && declineOnlyGroups.length === 1) {
          const affirmative = paidOnlyGroups[0];
          const decline = declineOnlyGroups[0];
          if (affirmative.decisionGroupId !== decline.decisionGroupId) {
            const alternatives = [...affirmative.alternatives, ...decline.alternatives];
            const selectedChoices = alternatives.filter((choice) => choice.selected);
            const exclusive = Boolean(
              affirmative.selectionInvariant?.exclusive
              || decline.selectionInvariant?.exclusive
            );
            const selectionInvariantValid = !exclusive || selectedChoices.length <= 1;
            const selected = selectionInvariantValid && selectedChoices.length === 1
              ? selectedChoices[0]
              : null;
            affirmative.alternatives = alternatives;
            affirmative.required = Boolean(affirmative.required || decline.required);
            affirmative.status = selected ? "satisfied" : (affirmative.required ? "missing" : "optional");
            affirmative.selectedControlId = selected?.controlId || "";
            affirmative.selectedLabel = selected?.label || "";
            affirmative.selectedSemantic = selected?.semantic || "";
            affirmative.selectionInvariant = {
              exclusive,
              valid: selectionInvariantValid,
              selectedCount: selectedChoices.length
            };
            affirmative.evidence = selected
              ? [`Selected: ${selected.label}`]
              : [`No selected option for ${affirmative.sectionLabel || section.label || section.type || "decision"}`];
            for (const choice of decline.alternatives) {
              const control = byControlId.get(choice.controlId);
              if (control) control.decisionGroupId = affirmative.decisionGroupId;
              const model = (section.choices || []).find((item) => item.controlId === choice.controlId || item.id === choice.targetId);
              if (model) model.decisionGroupId = affirmative.decisionGroupId;
            }
            return groups.filter((group) => group !== decline);
          }
        }
        return groups;
      })
      .slice(0, 80);
    const sectionOwnedControlIds = new Set(sectionGroups
      .flatMap((group) => group.alternatives || [])
      .map((choice) => choice.controlId)
      .filter(Boolean));
    const contractBuckets = new Map();
    for (const control of controls || []) {
      const contract = control.choiceContract || null;
      const instance = String(contract?.decisionInstance || "");
      if (!instance || !control.controlId) continue;
      if (!contractBuckets.has(instance)) contractBuckets.set(instance, []);
      contractBuckets.get(instance).push(control);
    }
    const controlOwnedChoiceGroups = [...contractBuckets.entries()].flatMap(([instance, rawControls]) => {
      const choices = rawControls.filter((control, index, list) => (
        list.findIndex((other) => other.controlId === control.controlId) === index
      ));
      if (choices.length < 2 || choices.some((control) => sectionOwnedControlIds.has(control.controlId))) return [];
      const first = choices[0];
      const decisionGroupId = first.decisionGroupId || decisionGroupIdForContext({
        sectionType: first.sectionType || "decision",
        sectionLabel: first.choiceContract?.decisionLabel || first.sectionLabel || "choice",
        instance
      });
      for (const control of choices) control.decisionGroupId = decisionGroupId;
      const selectedChoices = choices.filter((control) => (
        control.selected || control.state?.checked || control.state?.selected
      ));
      const selectionInvariantValid = selectedChoices.length <= 1;
      const selected = selectionInvariantValid && selectedChoices.length === 1
        ? selectedChoices[0]
        : null;
      const decisionLabel = first.choiceContract?.decisionLabel || first.sectionLabel || "choice";
      const paymentMethodGateway = choices.every((control) => (
        control.semantic === "payment_method"
        && control.physicalEffect === "reveal_control"
      ));
      const required = paymentMethodGateway || choices.some((control) => (
        control.choiceContract?.advancesOnSelection === true
        || control.choiceContract?.required === true
        || control.required
        || control.state?.required
      ));
      return [{
        decisionGroupId,
        surfaceId: first.surfaceId || "surface-page",
        sectionId: first.sectionId || first.choiceContract?.decisionOwnerId || "",
        sectionType: first.sectionType || "",
        sectionLabel: decisionLabel,
        requirementId: `${first.sectionType || "decision"}:${slugControlPart(decisionLabel)}`,
        required,
        status: selected ? "satisfied" : (required ? "missing" : "optional"),
        selectedControlId: selected?.controlId || "",
        selectedLabel: selected?.label || "",
        selectedSemantic: selected?.semantic || "",
        selectionInvariant: {
          exclusive: true,
          valid: selectionInvariantValid,
          selectedCount: selectedChoices.length
        },
        alternatives: choices.map((control) => ({
          controlId: control.controlId,
          targetId: control.preferredActivationElementId || control.stateElementId || "",
          label: control.label || "",
          semantic: control.semantic || "",
          physicalEffect: control.physicalEffect || "unknown",
          risk: control.risk || "uncertain",
          effectRole: control.effectRole || "unknown",
          selected: Boolean(control.selected || control.state?.checked || control.state?.selected),
          structuredPrice: control.structuredPrice || null,
          priceText: control.structuredPrice
            ? `${control.structuredPrice.amount} ${control.structuredPrice.currency || ""}`.trim()
            : ""
        })),
        evidence: selected
          ? [`Selected: ${selected.label}`]
          : [`No selected option for ${decisionLabel}`]
      }];
    });
    const representedControlIds = new Set([
      ...sectionGroups,
      ...controlOwnedChoiceGroups
    ].flatMap((group) => group.alternatives || []).map((choice) => choice.controlId).filter(Boolean));
    // A current required checkbox/radio is a unary attestation obligation,
    // not a product choice. Structural evidence keeps the obligation alive
    // even when its exact semantic classification remains unknown. Meaning
    // controls authorization; it must not decide whether the blocker exists.
    const requiredAttestationGroups = (controls || []).filter((control) => (
      control.controlId
      // Structural admission uses requiredness owned by the control itself,
      // never broad required context inherited from a containing form/section.
      // Some checkout frameworks expose their mandatory legal attestation
      // through the compiled field/section contract instead of the native
      // input attribute. Once the exact control is independently proven legal,
      // that contextual required flag is safe structural evidence as well.
      && (
        control.state?.required === true
        || control.choiceContract?.required === true
        || (control.required === true && control.semantic === "legal_acceptance")
      )
      && /checkbox|radio/.test(`${control.role || ""} ${control.kind || ""}`.toLowerCase())
      && (
        /checkbox/.test(`${control.role || ""} ${control.kind || ""}`.toLowerCase())
        || !representedControlIds.has(control.controlId)
      )
      && control.representationLifecycle?.active !== false
    )).map((control) => {
      const structuralText = `${control.semantic || ""} ${control.sectionType || ""} ${control.sectionLabel || ""} ${control.decisionGroupId || ""} ${control.stableKey || ""} ${control.label || ""}`;
      const legalAcceptance = control.semantic === "legal_acceptance"
        || /legal[_ -]?acceptance|terms?(?:[_ -]?and)?[_ -]?conditions?|termsandcondition/i.test(structuralText);
      const sectionType = legalAcceptance ? "legal_acceptance" : "unknown_attestation";
      const attestationSemantic = legalAcceptance ? "legal_acceptance" : "unknown_attestation";
      const decisionGroupId = control.decisionGroupId || decisionGroupIdForContext({
        sectionType,
        sectionLabel: control.sectionLabel || control.label || "required attestation",
        instance: `required-attestation:${control.controlId}`
      });
      control.decisionGroupId = decisionGroupId;
      const selected = Boolean(control.selected || control.state?.checked || control.state?.selected);
      return {
        decisionGroupId,
        surfaceId: control.surfaceId || "surface-page",
        sectionId: control.sectionId || control.stateElementId || "",
        sectionType,
        sectionLabel: control.sectionLabel || (legalAcceptance ? "Required booking terms" : "Required attestation"),
        requirementId: `${sectionType}:${slugControlPart(control.label || control.controlId)}`,
        required: true,
        status: selected ? "satisfied" : "missing",
        selectedControlId: selected ? control.controlId : "",
        selectedLabel: selected ? control.label || "" : "",
        selectedSemantic: selected ? attestationSemantic : "",
        selectionInvariant: { exclusive: false, valid: true, selectedCount: selected ? 1 : 0 },
        alternatives: [{
          controlId: control.controlId,
          targetId: control.preferredActivationElementId || control.stateElementId || "",
          label: control.label || "",
          semantic: attestationSemantic,
          physicalEffect: legalAcceptance ? "accept_legal_terms" : (control.physicalEffect || "unknown"),
          risk: legalAcceptance ? "legal" : "uncertain",
          effectRole: control.effectRole || "unknown",
          selected,
          structuredPrice: null,
          priceText: ""
        }],
        alternativeControlIds: [control.controlId],
        evidence: selected
          ? [`Accepted: ${control.label || "required attestation"}`]
          : [`Required attestation is not yet selected: ${control.label || "required attestation"}`]
      };
    });
    const structuralSurfaceChoices = (activeSurface?.options || []).filter((option) => (
      option.choiceStructure === true
      || /radio|checkbox|option/.test(String(option.accessibility?.role || "").toLowerCase())
    ));
    const explicitSurfaceDecline = (option = {}) => (
      /decline_paid_extra|decline_baggage|safe_decline|select_free_option/.test(
        `${option.semantic || ""} ${option.risk || ""} ${option.physicalEffect || ""}`.toLowerCase()
      )
      && /no,?\s*thanks|not now|skip|decline|go without|continue without|without|none/.test(
        String(option.label || "").toLowerCase()
      )
    );
    const surfaceDecisionOptions = structuralSurfaceChoices.length
      ? (activeSurface?.options || []).filter((option) => (
          option.choiceStructure === true
          || /radio|checkbox|option/.test(String(option.accessibility?.role || "").toLowerCase())
          || ["select_free_option", "select_paid_option"].includes(option.physicalEffect)
          || explicitSurfaceDecline(option)
        ))
      : (activeSurface?.options || []).filter(explicitSurfaceDecline);
    // A surface is not a decision merely because it contains several
    // commands. Only actual mutually-exclusive choice capabilities form a
    // decision group; review/edit/close/continue commands remain capabilities.
    const surfaceGroups = activeSurface?.type && activeSurface.type !== "page" && surfaceDecisionOptions.length >= 1
      ? [(() => {
          const decisionGroupId = activeSurface.decisionGroupId || decisionGroupIdForContext({ sectionType: activeSurface.taskHint || activeSurface.type || "", sectionLabel: activeSurface.parentSectionLabel || activeSurface.label || activeSurface.taskHint || "" });
          const alternatives = surfaceDecisionOptions.map((option) => {
            const control = byControlId.get(option.controlId) || {};
            const selected = Boolean(option.selected || control.selected || control.state?.checked || control.state?.selected);
            return {
              controlId: option.controlId || control.controlId || "",
              targetId: option.id || control.preferredActivationElementId || control.stateElementId || "",
              label: option.label || control.label || "",
              semantic: option.semantic || control.semantic || "",
              physicalEffect: option.physicalEffect || control.physicalEffect || "unknown",
              risk: option.risk || control.risk || "",
              effectRole: option.effectRole || control.effectRole || "unknown",
              selected,
              priceText: (option.label || "").match(/(?:\d+(?:[.,]\d{1,2})?\s?(?:EUR|€|USD|\$)|(?:EUR|€|USD|\$)\s?\d+(?:[.,]\d{1,2})?)/i)?.[0] || ""
            };
          }).filter((choice) => choice.controlId || choice.targetId || choice.label);
          const selected = alternatives.find((choice) => choice.selected) || null;
          return {
            decisionGroupId,
            surfaceId: activeSurface.id || "",
            sectionId: activeSurface.id || "",
            sectionType: activeSurface.parentSectionType || activeSurface.taskHint || activeSurface.type || "",
            sectionLabel: activeSurface.parentSectionLabel || activeSurface.label || activeSurface.taskHint || "",
            requirementId: activeSurface.taskHint || activeSurface.parentSectionType || activeSurface.type || activeSurface.id || "",
            required: surfaceDecisionOptions.some((option) => option.accessibility?.required === true || option.accessibility?.state?.required === true),
            status: selected
              ? "satisfied"
              : (surfaceDecisionOptions.some((option) => option.accessibility?.required === true || option.accessibility?.state?.required === true) ? "missing" : "optional"),
            selectedControlId: selected?.controlId || "",
            selectedLabel: selected?.label || "",
            selectedSemantic: selected?.semantic || "",
            alternatives,
            evidence: selected ? [`Selected: ${selected.label}`] : [`No selected option for ${activeSurface.label || activeSurface.type || "active surface"}`]
          };
        })()]
      : [];
    const ownedControlIds = new Set(sectionGroups
      .flatMap((group) => group.alternatives || [])
      .map((choice) => choice.controlId)
      .filter(Boolean));
    const unrepresentedSurfaceGroups = surfaceGroups.filter((group) => (
      !(group.alternatives || []).some((choice) => choice.controlId && ownedControlIds.has(choice.controlId))
    ));
    const requiredCheckboxIds = new Set(requiredAttestationGroups
      .flatMap((group) => group.alternatives || [])
      .map((choice) => choice.controlId)
      .filter(Boolean));
    const representedGroups = [
      ...sectionGroups,
      ...controlOwnedChoiceGroups,
      ...unrepresentedSurfaceGroups
    ].filter((group) => !(group.alternatives || []).some((choice) => requiredCheckboxIds.has(choice.controlId)));
    representedGroups.push(...requiredAttestationGroups);
    const representedToggleIds = new Set(representedGroups
      .flatMap((group) => group.alternatives || [])
      .map((choice) => choice.controlId)
      .filter(Boolean));
    const standaloneOptionalToggleGroups = (controls || []).filter((control) => {
      const shape = `${control.role || ""} ${control.domRole || ""} ${control.kind || ""}`.toLowerCase();
      const semantic = `${control.semantic || ""} ${control.risk || ""} ${control.effectRole || ""}`.toLowerCase();
      return control.controlId
        && !representedToggleIds.has(control.controlId)
        && control.representationLifecycle?.active !== false
        && /checkbox|switch|toggle/.test(shape)
        && /optional_consent|decline_paid_extra|decline_baggage|safe_decline/.test(semantic);
    }).map((control) => {
      const selected = Boolean(control.selected || control.state?.checked || control.state?.selected);
      const decisionGroupId = control.decisionGroupId || decisionGroupIdForContext({
        sectionType: control.sectionType || "decision",
        sectionLabel: control.sectionLabel || control.label || "optional toggle",
        instance: `optional-toggle:${control.stableKey || control.controlId}`
      });
      control.decisionGroupId = decisionGroupId;
      return {
        decisionGroupId,
        surfaceId: control.surfaceId || "surface-page",
        surfaceType: control.surfaceType || "page",
        sectionId: control.sectionId || control.stateElementId || "",
        sectionType: control.sectionType || "decision",
        sectionLabel: control.sectionLabel || control.label || "Optional toggle",
        requirementId: `${control.sectionType || "decision"}:${slugControlPart(control.label || control.controlId)}`,
        required: false,
        status: selected ? "satisfied" : "optional",
        selectedControlId: selected ? control.controlId : "",
        selectedLabel: selected ? control.label || "" : "",
        selectedSemantic: selected ? control.semantic || "" : "",
        selectionInvariant: { exclusive: false, valid: true, selectedCount: selected ? 1 : 0 },
        alternatives: [{
          controlId: control.controlId,
          targetId: control.preferredActivationElementId || control.stateElementId || "",
          label: control.label || "",
          semantic: control.semantic || "",
          physicalEffect: control.physicalEffect || "unknown",
          risk: control.risk || "uncertain",
          effectRole: control.effectRole || "unknown",
          selected,
          structuredPrice: null,
          priceText: ""
        }],
        selectedEvidence: selected ? {
          selected: true,
          disposition: "non_economic",
          effectRole: control.effectRole || "unknown",
          economicEffect: "none",
          structuredPrice: null,
          source: "selected_control_state",
          selectedControlId: control.controlId,
          selectedLabel: control.label || "",
          semantic: control.semantic || "",
          risk: control.risk || "uncertain"
        } : null,
        evidence: selected
          ? [`Selected: ${control.label || "optional toggle"}`]
          : [`Optional toggle is unselected: ${control.label || "optional toggle"}`]
      };
    });
    representedGroups.push(...standaloneOptionalToggleGroups);
    const collapsedSelectorGroups = ownedCollapsedSelectorDecisionGroups(sections, controls, representedGroups);
    const removalGroups = ownedRemovalDecisionGroups(sections, controls, [...representedGroups, ...collapsedSelectorGroups], activeSurface);
    return reconcileExclusiveDecisionControlOwnership(
      reconcileDecisionEffectGroups(
        [...representedGroups, ...collapsedSelectorGroups, ...removalGroups],
        controls
      ),
      byControlId
    ).slice(0, 80);
  }

  function decisionSubjectCue(value = "") {
    const text = normalizeMatchText(value);
    if (/lost bag|lost baggage|luggage protection|baggage protection|bag protection/.test(text)) return "baggage_protection";
    if (/checked bag|checked baggage|hold bag|hold baggage|checked luggage/.test(text)) return "checked_baggage";
    if (/cabin bag|cabin baggage|hand bag|hand baggage|carry on|personal item/.test(text)) return "cabin_baggage";
    if (/travel insurance|trip protection|cancellation insurance|cancellation protection/.test(text)) return "travel_insurance";
    if (/seat|seating/.test(text)) return "seat";
    if (/nationality|citizenship/.test(text)) return "nationality";
    if (/traveler title|passenger title|gender/.test(text)) return "traveler_title";
    return "";
  }

  function reconcileDecisionEffectGroups(groups = [], controls = []) {
    const byControlId = new Map((controls || []).map((control) => [control.controlId, control]));
    const roleFor = (value = {}) => value.effectRole
      || byControlId.get(value.controlId)?.effectRole
      || canonicalDecisionEffectRole(byControlId.get(value.controlId) || value);
    // A scope toggle is a mechanic of applying a choice, not a commerce
    // choice itself. Keeping it as a decision creates false selected extras.
    const result = (groups || []).filter((group) => {
      const requiredAttestation = group.required === true
        && (group.alternatives || []).some((choice) => /legal_acceptance|unknown_attestation/.test(choice.semantic || ""));
      if (requiredAttestation) return true;
      const exactAlternativeControls = (group.alternatives || [])
        .map((choice) => byControlId.get(choice.controlId))
        .filter(Boolean);
      const paymentMethodGateway = exactAlternativeControls.length > 0
        && exactAlternativeControls.length === (group.alternatives || []).length
        && exactAlternativeControls.every((control) => (
          control.semantic === "payment_method"
          && control.physicalEffect === "reveal_control"
        ));
      if (paymentMethodGateway) {
        // The observer already owns the payment semantic identity. This layer
        // preserves the required gateway but never repairs or reclassifies
        // group meaning after its identity and requirement were compiled.
        group.required = true;
        if (!group.selectedControlId) group.status = "missing";
        return true;
      }
      const roles = (group.alternatives || []).map(roleFor).filter((role) => role && role !== "unknown");
      if (roles.includes("optional_consent")) {
        // Requiredness for an optional consent can come only from its own
        // exact control, never from a required contact/form ancestor.
        group.required = (group.alternatives || []).some((choice) => {
          const control = byControlId.get(choice.controlId) || {};
          return control.state?.required === true;
        });
        if (!group.required && !group.selectedControlId) group.status = "optional";
        return true;
      }
      return !roles.length || roles.some((role) => !NON_ECONOMIC_EFFECT_ROLES.has(role));
    });
    const subjectFor = (control = {}) => decisionSubjectCue([
      control.label,
      control.accessibleName,
      control.ownText,
      control.ariaLabel,
      control.semantic,
      control.physicalEffect,
      control.sectionLabel
    ].filter(Boolean).join(" "));
    const buckets = new Map();
    for (const control of controls || []) {
      const role = roleFor(control);
      if (!["commerce_option", "free_decline", "included_entitlement"].includes(role)) continue;
      const subject = subjectFor(control);
      if (!subject) continue;
      const bucketKey = `${control.surfaceId || "surface-page"}:${subject}`;
      if (!buckets.has(bucketKey)) buckets.set(bucketKey, { subject, controls: [] });
      buckets.get(bucketKey).controls.push(control);
    }
    for (const { subject, controls: subjectControls } of buckets.values()) {
      const commerce = subjectControls.filter((control) => roleFor(control) === "commerce_option");
      const declines = subjectControls.filter((control) => roleFor(control) === "free_decline");
      if (!commerce.length || !declines.length) continue;
      const ids = new Set(subjectControls.map((control) => control.controlId));
      const owners = result.filter((group) => (group.alternatives || []).some((choice) => ids.has(choice.controlId)));
      const target = owners[0] || {
        decisionGroupId: `decision-effect:${subject}`,
        surfaceId: subjectControls[0]?.surfaceId || "surface-page",
        sectionId: subjectControls[0]?.sectionId || "",
        sectionType: subject.includes("baggage") ? "baggage" : subject,
        sectionLabel: subjectControls[0]?.sectionLabel || subject.replace(/_/g, " "),
        requirementId: `${subject}:decision`,
        required: false,
        status: "optional",
        selectedControlId: "",
        selectedLabel: "",
        selectedSemantic: "",
        alternatives: [],
        evidence: [`No selected option for ${subject.replace(/_/g, " ")}`]
      };
      if (!owners.length) result.push(target);
      const alternatives = [...(target.alternatives || [])];
      for (const control of subjectControls) {
        if (alternatives.some((choice) => choice.controlId === control.controlId)) continue;
        alternatives.push({
          controlId: control.controlId,
          targetId: control.preferredActivationElementId || control.stateElementId || "",
          label: control.label || "",
          semantic: control.semantic || "",
          physicalEffect: control.physicalEffect || "unknown",
          risk: control.risk || "uncertain",
          effectRole: roleFor(control),
          selected: Boolean(control.selected || control.state?.checked || control.state?.selected),
          structuredPrice: control.structuredPrice || null,
          priceText: control.structuredPrice
            ? `${control.structuredPrice.amount} ${control.structuredPrice.currency || ""}`.trim()
            : ""
        });
      }
      for (const owner of owners.slice(1)) {
        for (const alternative of owner.alternatives || []) {
          if (!alternatives.some((choice) => choice.controlId === alternative.controlId)) alternatives.push(alternative);
        }
        const index = result.indexOf(owner);
        if (index >= 0) result.splice(index, 1);
      }
      const selectedChoices = alternatives.filter((choice) => choice.selected && !NON_ECONOMIC_EFFECT_ROLES.has(roleFor(choice)));
      const selected = selectedChoices.length === 1 ? selectedChoices[0] : null;
      target.alternatives = alternatives;
      target.selectionInvariant = { exclusive: true, valid: selectedChoices.length <= 1, selectedCount: selectedChoices.length };
      target.selectedControlId = selected?.controlId || "";
      target.selectedLabel = selected?.label || "";
      target.selectedSemantic = selected?.semantic || "";
      target.status = selected ? "satisfied" : (target.required ? "missing" : "optional");
      target.evidence = selected
        ? [`Selected: ${selected.label}`]
        : [`No selected option for ${target.sectionLabel || subject.replace(/_/g, " ")}`];
      if (selected) {
        const selectedControl = byControlId.get(selected.controlId) || {};
        const disposition = selectedDisposition({ selected, selectedControl, structuredPrice: selected.structuredPrice });
        target.selectedEvidence = {
          selected: true,
          disposition,
          effectRole: roleFor(selected),
          economicEffect: "decision_outcome",
          structuredPrice: selected.structuredPrice || null,
          source: "selected_control_state",
          selectedControlId: selected.controlId,
          selectedLabel: selected.label,
          semantic: selected.semantic || selectedControl.semantic || "",
          risk: selected.risk || selectedControl.risk || ""
        };
      }
      for (const control of subjectControls) control.decisionGroupId = target.decisionGroupId;
    }
    return result;
  }

  function decisionGroupOwnershipScore(group = {}, control = {}) {
    const ownerText = [
      group.sectionLabel,
      group.requirementId,
      group.decisionGroupId
    ].filter(Boolean).join(" ");
    const alternativeText = (group.alternatives || []).map((choice) => choice.label || "").join(" ");
    const controlText = [
      control.label,
      control.semantic,
      control.meaning,
      control.fieldType
    ].filter(Boolean).join(" ");
    const ownerCue = decisionSubjectCue(ownerText);
    const groupCue = ownerCue || decisionSubjectCue(alternativeText);
    const controlCue = decisionSubjectCue(controlText);
    let score = 0;
    if (groupCue && controlCue && groupCue === controlCue) score += 100;
    if (ownerCue && controlCue && ownerCue !== controlCue) score -= 200;
    if (control.decisionGroupId === group.decisionGroupId) score += 10;
    if (group.selectedControlId === control.controlId) score += 2;
    return score;
  }

  function reconcileExclusiveDecisionControlOwnership(groups = [], byControlId = new Map()) {
    const ownersByControlId = new Map();
    for (const group of groups) {
      for (const alternative of group.alternatives || []) {
        if (!alternative.controlId) continue;
        if (!ownersByControlId.has(alternative.controlId)) ownersByControlId.set(alternative.controlId, []);
        ownersByControlId.get(alternative.controlId).push(group);
      }
    }
    const winnerByControlId = new Map();
    for (const [controlId, owners] of ownersByControlId) {
      if (owners.length === 1) {
        winnerByControlId.set(controlId, owners[0]);
        continue;
      }
      const control = byControlId.get(controlId) || {};
      const winner = [...owners].sort((left, right) => (
        decisionGroupOwnershipScore(right, control) - decisionGroupOwnershipScore(left, control)
      ))[0];
      winnerByControlId.set(controlId, winner);
      if (control?.controlId) control.decisionGroupId = winner.decisionGroupId;
    }
    return groups.flatMap((group) => {
      const alternatives = (group.alternatives || []).filter((alternative) => (
        !alternative.controlId || winnerByControlId.get(alternative.controlId) === group
      ));
      if (!alternatives.length) return [];
      const selectedChoices = alternatives.filter((alternative) => alternative.selected);
      const exclusive = group.selectionInvariant?.exclusive === true;
      const selectionInvariantValid = !exclusive || selectedChoices.length <= 1;
      const selected = selectionInvariantValid && selectedChoices.length === 1
        ? selectedChoices[0]
        : null;
      return [{
        ...group,
        alternatives,
        selectedControlId: selected?.controlId || "",
        selectedLabel: selected?.label || "",
        selectedSemantic: selected?.semantic || "",
        selectionInvariant: {
          exclusive,
          valid: selectionInvariantValid,
          selectedCount: selectedChoices.length
        },
        status: selected ? "satisfied" : (group.required ? "missing" : "optional"),
        evidence: selected
          ? [`Selected: ${selected.label}`]
          : [`No selected option for ${group.sectionLabel || group.requirementId || "decision"}`]
      }];
    });
  }


  return Object.freeze({
    applyControlToModel,
    syncRequiredProfileChoiceGroups,
    decisionGroupIdForContext,
    sectionDecisionFields,
    choiceLikeModelFromDecisionField,
    choiceLikeModelFromDecisionControl,
    decisionChoiceElement,
    ownedDecisionElement,
    selectedDisposition,
    withOwnedSelectedEvidence,
    attachExactCommerceOptionPrices,
    explicitOwnedSelectionState,
    ownedRemovalDecisionGroups,
    ownedCollapsedSelectorDecisionGroups,
    sectionDecisionControls,
    decisionControlContext,
    buildCanonicalDecisionGroups,
    decisionSubjectCue,
    reconcileDecisionEffectGroups,
    decisionGroupOwnershipScore,
    reconcileExclusiveDecisionControlOwnership
  });
}
