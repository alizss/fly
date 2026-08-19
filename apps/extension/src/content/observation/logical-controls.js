export function createLogicalControlCompiler(dependencies) {
  const {
    AGENT_CONTRACT,
    accessibleName,
    actuatorActionability,
    buttonText,
    canonicalProfileFieldType,
    choiceActuatorBindings,
    choiceInteractionStates,
    classifyProfileField,
    clickableAncestor,
    compactText,
    controlOwnedEvidence,
    controlText,
    currentCommercialOptionPrice,
    currentElementValue,
    decisionChoiceOwnerLabel,
    decisionGroupIdForContext,
    directControlName,
    elementBelongsToSectionBand,
    elementBox,
    elementById,
    elementId,
    exclusiveDecisionOwner,
    implicitRole,
    isDisabledLike,
    isVisible,
    itineraryActionEvidence,
    labelText,
    normalizeMatchText,
    queryAllDeep,
    resolveOwnedControlMeaning,
    stableHash,
    structuralDecisionChoiceKind,
    structuralDecisionChoicePeers,
    structuredPriceFromText,
    structuredPricesFromText,
    surfaceLooksLikeSeatSkip,
    travelerValue,
    updateChoiceInteractionState
  } = dependencies;

  function meaningfulActionBox(box = {}) {
    if (!box) return false;
    if (box.width < 24 || box.height < 16) return false;
    if (box.centerX < -200 || box.centerX > window.innerWidth + 200) return false;
    return true;
  }
  
  function isAuxiliaryNavigationAction(element) {
    if (!element?.matches?.("a, [role='link']")) return false;
    if (element.matches("[role='button'], [aria-haspopup], [aria-controls]")) return false;
    if (element.closest("form, [role='dialog'], [aria-modal='true']")) return false;
    return Boolean(element.closest("footer, [role='contentinfo'], nav, [role='navigation'], header, [role='banner']"));
  }
  
  function isGlobalChromeControl(element) {
    if (!element) return false;
    // Selected-itinerary Edit/Change/View controls are context evidence only.
    // Marking them non-task chrome prevents planning from ever clicking them
    // while retaining their route/date facts in transaction evidence.
    if (itineraryActionEvidence(element)) return true;
    const meaning = normalizeMatchText([
      directControlName(element),
      buttonText(element),
      accessibleName(element),
      element.getAttribute?.("aria-label"),
      element.getAttribute?.("title"),
      element.getAttribute?.("data-testid")
    ].filter(Boolean).join(" "));
    const utilityMeaning = /\bfeedback\b|\bhelp(?: and | &)support\b|\bsign in\b|\bregional settings\b|\bcurrency (?:selector|switcher)\b|\bopen sidebar\b/.test(meaning);
    const style = getComputedStyle(element);
    const box = elementBox(element);
    const viewportEdgeUtility = utilityMeaning && (
      ["fixed", "sticky"].includes(style.position)
      || box.centerX <= 48
      || box.centerX >= window.innerWidth - 48
    );
    if (viewportEdgeUtility) return true;
    if (element.closest?.("form, [role='dialog'], [aria-modal='true']")) return false;
    if (utilityMeaning) return true;
    return Boolean(element.closest?.("footer, [role='contentinfo'], nav, [role='navigation'], header, [role='banner']"));
  }
  
  function sectionTypeFor(label, text = "") {
    const source = `${label} ${text}`.toLowerCase();
    if (AGENT_CONTRACT?.isLegalAcceptanceText?.(source)) return "legal_acceptance";
    if (/contact|e-?mail|mobile/.test(source)) return "contact";
    if (/passenger|traveller|traveler|surname|first name|passport|title/.test(source)) return "passenger";
    if (/baggage|bag|personal item|hand baggage|checked/.test(source)) return "baggage";
    if (/bundle|premium support|airhelp|sms/.test(source)) return "bundle";
    if (/flexible ticket|reschedule|change your ticket/.test(source)) return "flexible_ticket";
    if (AGENT_CONTRACT?.isInsuranceOfferText?.(source)
      || (!AGENT_CONTRACT?.isInsuranceOfferText && /cancellation|voucher refund|insurance|refund/.test(source))) {
      return "cancellation_insurance";
    }
    if (/continue|protect your personal data/.test(source)) return "continue";
    if (/seat|reserve seating|seat map/.test(source)) return "seat";
    if (/payment|pay|card|cvc/.test(source)) return "payment";
    return "unknown";
  }
  
  function sectionFieldModels(section, fields, allSections = []) {
    return fields
      .filter((field) => field.element && elementBelongsToSectionBand(field.element, section, allSections))
      .map((field) => {
        return {
          id: field.id,
          label: field.label,
          field: field.fieldType || field.field,
          fieldType: field.fieldType || field.field || "",
          fieldClassification: field.fieldClassification || null,
          kind: field.kind,
          semantic: semanticFieldType(field),
          role: field.role || field.accessibility?.role || "",
          accessibility: field.accessibility || null,
          required: field.required,
          hasValue: Boolean(field.value),
          value: field.value ? "[filled]" : "",
          sourceElementId: field.id,
          box: field.box
        };
      });
  }
  
  function semanticFieldType(field) {
    const canonical = canonicalProfileFieldType(field.fieldType || field.field || field.semantic || "");
    if (canonical) return canonical;
    const text = `${field.label || ""} ${field.kind || ""} ${field.value || ""}`.toLowerCase();
    if (/choose|select an option|select one option/.test(text)) return "required_dropdown_choice";
    return "unknown";
  }
  
  function sectionButtonModels(section, buttons, allSections = []) {
    return buttons
      .filter((button) => button.element && elementBelongsToSectionBand(button.element, section, allSections))
      .map((button) => {
        return {
          id: button.id,
          label: button.label,
          risk: button.risk,
          semantic: button.semantic,
          role: button.role || button.accessibility?.role || "",
          accessibility: button.accessibility || null,
          sourceElementId: button.id,
          box: button.box
        };
      });
  }
  
  function selectedControlLabels(section, allSections = []) {
    return sectionChoiceInputs(section, allSections)
      .filter((input) => isChoiceSelected(input))
      .map((input) => choiceLabel(input))
      .filter(Boolean)
      .map((text) => text.replace(/\s+/g, " ").trim())
      .slice(0, 8);
  }
  
  function sectionChoiceInputs(section, allSections = []) {
    if (!section?.element) return [];
    return queryAllDeep("input[type='radio'], input[type='checkbox'], [role='radio'], [role='checkbox']")
      .filter((input) => isVisible(input) && !input.closest("#atw-sidebar"))
      .filter((input) => elementBelongsToSectionBand(input, section, allSections));
  }
  
  function explicitChoiceBooleanState(element) {
    if (!element) return null;
    if (element.matches?.("input[type='checkbox'], input[type='radio']")) {
      return element.checked === true;
    }
    if (element.matches?.("option")) return element.selected === true;
    const attributes = ["aria-checked", "aria-selected", "aria-pressed"];
    for (const attribute of attributes) {
      if (!element.hasAttribute?.(attribute)) continue;
      return element.getAttribute(attribute) === "true";
    }
    if (element.hasAttribute?.("data-selected")) {
      const value = String(element.getAttribute("data-selected") || "");
      if (/^(?:false|unchecked|unselected|off|inactive)$/i.test(value)) return false;
      if (/^(?:true|checked|selected|on|active)$/i.test(value)) return true;
    }
    if (element.hasAttribute?.("data-checked")) {
      const value = String(element.getAttribute("data-checked") || "");
      if (/^(?:false|unchecked|unselected|off|inactive)$/i.test(value)) return false;
      if (/^(?:true|checked|selected|on|active)$/i.test(value)) return true;
    }
    if (element.hasAttribute?.("data-state")) {
      const state = String(element.getAttribute("data-state") || "");
      if (/^(?:unchecked|unselected|off|inactive|false|closed)$/i.test(state)) return false;
      if (/^(?:checked|selected|on|active|true)$/i.test(state)) return true;
    }
    return null;
  }
  
  function isChoiceSelected(input) {
    if (!input) return false;
    // Native browser state is authoritative. A surrounding card may use
    // "active" for focus, hover, validation or layout; it must never turn an
    // explicitly unchecked native control into a selected paid item.
    const ownExplicitState = explicitChoiceBooleanState(input);
    if (ownExplicitState !== null) return ownExplicitState;
  
    // Direct selected classes are useful for genuinely custom controls that
    // expose no native or ARIA state. Do not infer through ancestors.
    if (/\b(is-)?(selected|checked)\b/i.test(String(input.className || ""))) return true;
    const ownedState = input.querySelector?.(
      "input:checked, option:checked, [aria-checked='true'], [aria-selected='true'], [aria-pressed='true'], [data-state='checked'], [data-state='selected'], [data-state='on'], [data-selected='true'], [data-checked='true']"
    );
    return Boolean(ownedState);
  }
  
  function choiceLabel(input) {
    const own = directControlName(input);
    if (own) return own;
    const direct = labelText(input) || input.value || controlText(input);
    if (direct && direct.trim() && !/^(on|true|false)$/i.test(direct.trim())) return direct;
    const row = input.closest("label, li, tr, [role='radio'], [role='checkbox'], div");
    return (row?.innerText || row?.textContent || "").replace(/\s+/g, " ").trim();
  }
  
  function sectionHasRequiredChoice(section, allSections = []) {
    return sectionChoiceInputs(section, allSections).some((input) => {
      const label = choiceLabel(input);
      const nearby = (input.closest("fieldset, [role='radiogroup'], [role='group'], div")?.innerText || "").replace(/\s+/g, " ");
      return /\*|choose|select one|select an option|required/i.test(`${label} ${nearby}`);
    });
  }
  
  function sectionChoiceSelected(section, allSections = []) {
    return sectionChoiceInputs(section, allSections).some((input) => isChoiceSelected(input));
  }
  
  function checkedFieldLabels(fields = []) {
    return fields
      .filter((field) => /radio|checkbox/i.test(field.kind || "") && field.hasValue)
      .map((field) => field.label || "")
      .filter(Boolean)
      .map((text) => text.replace(/\s+/g, " ").trim());
  }
  
  function choiceGoalTerms(semantic = "", dateField = null) {
    const field = canonicalProfileFieldType(semantic) || String(semantic || "").toLowerCase();
    let desired = String(travelerValue(field) || "").trim();
    if (dateField?.component && desired) {
      const match = desired.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (match) {
        desired = dateField.component === "year"
          ? match[1]
          : dateField.component === "month"
            ? match[2]
            : match[3];
      }
    }
    const terms = [desired];
    if (/^(nationality|country|country_of_residence|issuing_country)$/.test(field) && /^[a-z]{2}$/i.test(desired)) {
      for (const locale of [observedLocale(), "en"]) {
        try {
          const label = new Intl.DisplayNames([locale || "en"], { type: "region" }).of(desired.toUpperCase());
          if (label) terms.push(label);
        } catch (_) {
          // The ISO value itself remains an exact match when DisplayNames is unavailable.
        }
      }
    }
    if (field === "phone_country_code") {
      terms.push(
        desired.replace(/\D/g, ""),
        travelerValue("nationality"),
        travelerValue("country"),
        travelerValue("country_of_residence")
      );
    }
    if (["title", "gender"].includes(field)) {
      const normalized = normalizedProfileChoiceValue(desired, field);
      if (normalized === "mr" || normalized === "male") terms.push("Mr", "Male");
      if (normalized === "mrs/ms" || normalized === "female") terms.push("Mrs", "Ms", "Miss", "Female");
    }
    return [...new Set(terms.map((term) => String(term || "").replace(/\s+/g, " ").trim()).filter(Boolean))];
  }
  
  function choiceOptionMatchesGoal(option = {}, terms = [], semantic = "") {
    const field = canonicalProfileFieldType(semantic) || String(semantic || "").toLowerCase();
    const values = [option.value, option.label].map((value) => String(value || "").replace(/\s+/g, " ").trim()).filter(Boolean);
    return terms.some((term) => {
      const normalizedTerm = normalizeMatchText(term);
      if (!normalizedTerm) return false;
      return values.some((value) => {
        if (normalizedProfileChoiceValue(value, field) === normalizedProfileChoiceValue(term, field)) return true;
        const normalizedValue = normalizeMatchText(value);
        if (normalizedValue === normalizedTerm) return true;
        if (normalizedTerm.length <= 2) {
          return normalizedValue.split(" ").includes(normalizedTerm);
        }
        if (field === "phone_country_code") {
          const digits = value.replace(/\D/g, "");
          const termDigits = String(term).replace(/\D/g, "");
          return Boolean(termDigits && digits.includes(termDigits));
        }
        return ` ${normalizedValue} `.includes(` ${normalizedTerm} `);
      });
    });
  }
  
  function observedChoiceOptionsForControl(stateElement, controlRegion = null, context = {}) {
    if (!stateElement) return { options: [], totalCount: 0, truncated: false, goalMatchedCount: 0 };
    const optionElements = [];
    if (stateElement.tagName === "SELECT") {
      optionElements.push(...stateElement.options);
    } else {
      const ownedIds = [
        stateElement.getAttribute?.("aria-controls"),
        stateElement.getAttribute?.("aria-owns")
      ].flatMap((value) => String(value || "").split(/\s+/)).filter(Boolean);
      for (const id of ownedIds) {
        const owned = queryAllDeep(`#${CSS.escape(id)}`)[0];
        if (owned) optionElements.push(...queryAllDeep("[role='option'], option, [role='menuitemradio']", owned));
      }
      if (!optionElements.length && controlRegion?.matches?.("[role='listbox'], [role='menu']")) {
        optionElements.push(...queryAllDeep("[role='option'], option, [role='menuitemradio']", controlRegion));
      }
    }
    const allOptions = optionElements.map((option) => ({
      value: String(
        option.value
        || option.getAttribute?.("data-value")
        || option.getAttribute?.("aria-value")
        || ""
      ),
      label: compactText(
        option.textContent
        || option.getAttribute?.("aria-label")
        || option.value
        || "",
        120
      ),
      selected: Boolean(option.selected === true || option.getAttribute?.("aria-selected") === "true")
    })).filter((option, index, list) => (
      (option.value || option.label)
      && list.findIndex((candidate) => (
        candidate.value === option.value && candidate.label === option.label
      )) === index
    ));
    const goalTerms = choiceGoalTerms(context.semantic || "", context.dateField || null);
    const prioritized = allOptions.map((option) => ({
      ...option,
      goalMatch: choiceOptionMatchesGoal(option, goalTerms, context.semantic || "")
    })).sort((left, right) => (
      Number(right.goalMatch) - Number(left.goalMatch)
      || Number(right.selected) - Number(left.selected)
    ));
    const options = prioritized.slice(0, 120);
    return {
      options,
      totalCount: allOptions.length,
      truncated: allOptions.length > options.length,
      goalMatchedCount: options.filter((option) => option.goalMatch).length
    };
  }
  
  function semanticChoiceType(label = "") {
    const text = label.toLowerCase();
    const structuredPrice = structuredPriceFromText(label);
    if (AGENT_CONTRACT?.isLegalAcceptanceText?.(label)) return "legal_acceptance";
    if (/no checked baggage|no baggage|without baggage|i.ll go without|go without/.test(text)) return "decline_baggage";
    if (/skip (?:seat|seating)|random seating|random assignment|continue without (?:a )?seat|no seat selection/.test(text)) return "decline_paid_extra";
    if (/\b(?:do not|don.t|not)\s+(?:wish|want|agree|consent)\s+to\s+(?:receive|join|subscribe)|\bopt(?:ing)?\s*out\b|\bunsubscribe\b/.test(text)) return "decline_paid_extra";
    if (/^\s*(?:no|without)\b|no,?\s*thanks|none of the passengers|none\b|without|(?:i(?:’|'| wi)?ll\s+)?take the risk|keep (?:my|the) current/.test(text)) return "decline_paid_extra";
    if ((structuredPrice && structuredPrice.amount > 0)
      || /add to cart|add to my trip|premium|bundle|checked baggage|\b\d+\s*x\s*\d+\s*kg/.test(text)) return "add_paid_extra";
    if (/^\s*(?:continue|choose|select|book|pick)\s+(?:with\s+)?\S+/i.test(text)
      && !/^\s*(?:continue|choose|select|book|pick)\s+(?:to\s+)?(?:payment|checkout|next|proceed)\s*$/i.test(text)) {
      return "selection_cta";
    }
    if (/continue|next|proceed/.test(text)) return "continue";
    return "choice";
  }
  
  function choiceRisk(label = "") {
    const structuredPrice = structuredPriceFromText(label);
    if (structuredPrice?.amount === 0) return "safe";
    if (structuredPrice && structuredPrice.amount > 0) return "money";
    const semantic = semanticChoiceType(label);
    if (semantic === "legal_acceptance") return "legal";
    if (/decline_/.test(semantic)) return "safe_decline";
    if (semantic === "add_paid_extra") return "money";
    if (semantic === "selection_cta") return "uncertain";
    if (semantic === "continue" || semantic === "traveler_title") return "safe";
    return "uncertain";
  }
  
  const NON_ECONOMIC_EFFECT_ROLES = new Set(["scope_toggle", "information_only", "navigation", "presentation_mode"]);
  
  function canonicalDecisionEffectRole(control = {}) {
    const localMeaning = normalizeMatchText([
      control.label,
      control.ownText,
      control.ariaLabel,
      control.title,
      control.semantic,
      control.physicalEffect,
      control.testId
    ].filter(Boolean).join(" "));
    const meaning = normalizeMatchText([
      control.label,
      control.accessibleName,
      control.ownText,
      control.ariaLabel,
      control.title,
      control.semantic,
      control.physicalEffect,
      control.testId,
      control.sectionLabel
    ].filter(Boolean).join(" "));
    const shape = normalizeMatchText(`${control.kind || ""} ${control.role || ""} ${control.domRole || ""} ${control.inputType || ""}`);
    const disabledStateRepresentation = Boolean(
      control.disabled === true
      || control.logicalDisabled === true
      || control.state?.disabled === true
    ) && /radio|checkbox|switch|toggle/.test(shape)
      && !control.structuredPrice;
    if (disabledStateRepresentation) return "presentation_mode";
    if (/same for all|apply (?:this )?to all|both (?:flights|legs|journeys)|copy (?:to|for) all/.test(localMeaning)
      && /checkbox|switch|toggle|button/.test(shape)) return "scope_toggle";
    if (/decline paid extra|decline baggage|safe decline|select free option/.test(meaning)
      || /no,? thanks|skip (?:bags?|baggage|luggage|seats?|seating|selection)|go without|continue without|random (?:seat|assignment)|none/.test(meaning)) {
      return "free_decline";
    }
    if (/included|already (?:have|selected)|personal item/.test(meaning)
      && !/add|buy|upgrade|select paid|purchase/.test(meaning)) return "included_entitlement";
    if (/show details|learn more|more info|information|allowance|dimensions|what.s included/.test(meaning)
      && !/add|buy|upgrade|select|choose/.test(meaning)) return "information_only";
    if (/add paid extra|select paid option|purchase|upgrade|buy|\badd\b.{0,40}\b(?:bag|baggage|luggage)\b|bring onboard/.test(meaning)
      || Number(control.structuredPrice?.amount) > 0) return "commerce_option";
    if (/continue|next|proceed|navigate stage|advance checkout|close|done|back/.test(meaning)
      && !/continue without/.test(meaning)) return "navigation";
    return "unknown";
  }
  
  function slugControlPart(value = "") {
    return normalizeMatchText(value).replace(/\s+/g, "-").slice(0, 54) || "unknown";
  }
  
  function labelElementForInput(input) {
    if (!input) return null;
    const id = input.getAttribute?.("id");
    if (id) {
      const explicit = queryAllDeep(`label[for="${CSS.escape(id)}"]`)[0];
      if (explicit) return explicit;
    }
    return input.closest?.("label") || null;
  }
  
  function controlWrapperForElement(element, stateElement = element) {
    const root = stateElement || element;
    if (root?.tagName === "SELECT" && isDisabledLike(root)) {
      const region = root.parentElement?.closest?.("label, [role='group'], [role='combobox'], li, fieldset, div");
      if (region && region !== root) return region;
    }
    return root?.closest?.("button, input, select, textarea, label, [role='radio'], [role='checkbox'], [role='option'], [role='button'], li, tr, fieldset, [role='radiogroup'], [role='group'], div") || element;
  }
  
  function controlKindForElement(element) {
    const tag = (element?.tagName || "").toLowerCase();
    const type = (element?.getAttribute?.("type") || "").toLowerCase();
    const role = implicitRole(element);
    if (type === "radio" || role === "radio") return "radio";
    if (type === "checkbox" || role === "checkbox") return "checkbox";
    if (tag === "select" || role === "combobox" || role === "listbox") return "select";
    if (tag === "textarea" || (tag === "input" && !["button", "submit", "reset", "radio", "checkbox"].includes(type))) return "field";
    if (tag === "button" || role === "button" || ["button", "submit", "reset"].includes(type)) return "button";
    if (role === "option") return "option";
    return role || tag || "control";
  }
  
  function isDropdownLikeElement(element) {
    const tag = (element?.tagName || "").toLowerCase();
    const role = implicitRole(element);
    return tag === "select" || role === "combobox" || role === "listbox" || element?.getAttribute?.("aria-haspopup") === "listbox";
  }
  
  function isPlaceholderChoiceValue(value = "", element = null) {
    const normalized = String(value || "").replace(/\s+/g, " ").trim();
    const selectedOption = element?.tagName === "SELECT" && element.selectedIndex >= 0
      ? element.options?.[element.selectedIndex]
      : null;
    if (AGENT_CONTRACT?.isPlaceholderChoiceValue?.(normalized, {
      optionValue: selectedOption?.value ?? normalized,
      optionLabel: selectedOption?.textContent || selectedOption?.label || "",
      optionDisabled: selectedOption?.disabled === true,
      optionIndex: Number(element?.selectedIndex ?? -1)
    })) {
      return true;
    }
    if (!normalized) return false;
    if (!element || !isDropdownLikeElement(element)) return false;
    const explicitPlaceholders = [
      element.getAttribute?.("placeholder"),
      element.getAttribute?.("aria-placeholder"),
      element.tagName === "SELECT" && element.selectedIndex >= 0
        && !String(element.options?.[element.selectedIndex]?.value || "").trim()
        ? element.options?.[element.selectedIndex]?.textContent
        : ""
    ].map((candidate) => normalizeMatchText(candidate || "")).filter(Boolean);
    const normalizedValue = normalizeMatchText(normalized);
    if (explicitPlaceholders.includes(normalizedValue)) return true;
    const stablePrompt = normalizeMatchText(
      element.getAttribute?.("aria-label")
      || element.getAttribute?.("title")
      || ""
    );
    return Boolean(
      stablePrompt
      && stablePrompt === normalizedValue
      && !isChoiceSelected(element)
    );
  }
  
  function normalizedProfileChoiceValue(value = "", semantic = "") {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    const type = canonicalProfileFieldType(semantic) || String(semantic || "").toLowerCase();
    if (!text) return "";
    if (type === "title" || type === "gender") {
      if (/mrs\.?\s*\/\s*ms\.?/i.test(text) || /(?:^|\s)(?:mrs\.?|ms\.?|miss)(?:\s|$)/i.test(text)) return "mrs/ms";
      if (/(?:^|\s)mr\.?(?:\s|$)/i.test(text)) return "mr";
      if (type === "title" && /(?:^|\s)female(?:\s|$)/i.test(text)) return "mrs/ms";
      if (type === "title" && /(?:^|\s)male(?:\s|$)/i.test(text)) return "mr";
      if (type === "gender" && /(?:^|\s)female(?:\s|$)/i.test(text)) return "female";
      if (type === "gender" && /(?:^|\s)male(?:\s|$)/i.test(text)) return "male";
    }
    return text.toLowerCase();
  }
  
  function stateElementForControl(element) {
    if (!element) return null;
    if (element.matches?.("input, select, textarea, [role='radio'], [role='checkbox'], [role='option'], [role='combobox'], [role='listbox'], [role='button'], button")) return element;
    const labelledInput = element.getAttribute?.("for")
      ? document.getElementById(element.getAttribute("for"))
      : null;
    if (labelledInput) return labelledInput;
    return queryAllDeep("input, select, textarea, [role='radio'], [role='checkbox'], [role='option'], [role='combobox'], [role='listbox'], button, [role='button']", element)
      .filter((candidate) => isVisible(candidate) && !candidate.closest("#atw-sidebar"))[0] || element;
  }
  
  function exclusiveChoicePresentationText(element) {
    return compactText(
      element?.getAttribute?.("aria-label")
      || element?.getAttribute?.("title")
      || element?.innerText
      || element?.textContent
      || "",
      160
    );
  }
  
  function isNestedExclusiveChoiceActuator(candidate, stateRadio) {
    if (
      !candidate
      || !stateRadio
      || candidate === stateRadio
      || candidate.closest?.("[role='radio']") !== stateRadio
      || candidate.matches?.("input, select, textarea")
      || candidate.getAttribute?.("name")
      || candidate.getAttribute?.("value")
      || isInformationalChoiceUtility(candidate)
    ) {
      return false;
    }
    const nestedMeaning = exclusiveChoicePresentationText(candidate);
    if (!nestedMeaning) return true;
    const optionMeaning = exclusiveChoicePresentationText(stateRadio) || compactText(choiceLabel(stateRadio), 160);
    const nestedKey = normalizeMatchText(nestedMeaning);
    const optionKey = normalizeMatchText(optionMeaning);
    return Boolean(nestedKey && optionKey && (
      nestedKey === optionKey
      || nestedKey.includes(optionKey)
      || optionKey.includes(nestedKey)
    ));
  }
  
  // Some component libraries split one exclusive option across an outer node
  // that owns selection state and a nested node that owns click activation.
  // Resolve that alias before assigning identity or semantics; otherwise the
  // wrapper and actuator are published as two competing decisions.
  function canonicalExclusiveChoiceState(element, context = {}) {
    const initial = stateElementForControl(element);
    if (!element || !initial || structuralDecisionChoiceKind(initial) === "radio") return initial;
    const radio = element.closest?.("[role='radio']") || null;
    if (!radio || radio === initial || !isVisible(radio)) return initial;
    const owner = exclusiveDecisionOwner(radio, context.section || {});
    if (!owner) return initial;
    const peers = structuralDecisionChoicePeers(owner, radio);
    const optionOwner = boundedChoiceOptionOwner(radio, owner, peers);
    if (!optionOwner || !optionOwner.contains(element)) return initial;
  
    // Native inputs and explicitly named nested controls remain independent.
    // Only presentation actuators without their own stable meaning alias the
    // state-bearing radio option.
    return isNestedExclusiveChoiceActuator(initial, radio) ? radio : initial;
  }
  
  function normalizedControlValue(value = "", semantic = "", element = null) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    const type = String(semantic || "").toLowerCase();
    if (!text) return "";
    if (type === "phone_country_code") {
      const digits = text.replace(/[^0-9]/g, "");
      return digits ? `+${digits}` : "";
    }
    if (type === "phone") return text.replace(/[^0-9]/g, "").replace(/^0+/, "");
    if (type === "email" || type === "confirm_email") return text.toLowerCase();
    if (type === "title") {
      if (/mrs\.?\s*\/\s*ms\.?/i.test(text) || /(?:^|\s)(?:mrs\.?|ms\.?|miss)(?:\s|$)/i.test(text)) return "mrs/ms";
      if (/(?:^|\s)mr\.?(?:\s|$)/i.test(text)) return "mr";
    }
    if (type === "gender") {
      if (/(?:^|\s)female(?:\s|$)/i.test(text)) return "female";
      if (/(?:^|\s)male(?:\s|$)/i.test(text)) return "male";
    }
    if (element?.type === "radio" || element?.type === "checkbox" || ["radio", "checkbox"].includes(implicitRole(element))) {
      if (!isChoiceSelected(element)) return "";
      const optionText = choiceLabel(element) || element?.getAttribute?.("value") || value;
      return normalizedProfileChoiceValue(optionText || "selected", type);
    }
    return text.toLowerCase();
  }
  
  function describedText(element) {
    return String(element?.getAttribute?.("aria-describedby") || "")
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent || "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 500);
  }
  
  function observedLocale() {
    return String(document.documentElement?.lang || navigator.language || "").trim();
  }
  
  function dateFormatFromTokens(hint = "") {
    const normalized = String(hint || "").toLowerCase()
      .replace(/year/g, "yyyy")
      .replace(/month/g, "mm")
      .replace(/day/g, "dd");
    const tokens = [...normalized.matchAll(/yyyy|yy|mm|dd/g)].map((match) => ({
      token: match[0].startsWith("y") ? "y" : match[0].startsWith("m") ? "m" : "d",
      index: match.index
    }));
    const unique = [];
    for (const token of tokens) {
      if (!unique.some((item) => item.token === token.token)) unique.push(token);
    }
    if (unique.length !== 3) return null;
    unique.sort((a, b) => a.index - b.index);
    const format = unique.map((item) => item.token).join("");
    if (!/^(dmy|mdy|ymd)$/.test(format)) return null;
    return {
      format,
      separator: normalized.match(/[-/.]/)?.[0] || "-",
      source: "explicit_format_hint"
    };
  }
  
  function dateFormatFromLocale(locale = "") {
    if (!/^[a-z]{2,3}[-_][a-z]{2}$/i.test(String(locale || ""))) return null;
    try {
      const parts = new Intl.DateTimeFormat(String(locale).replace("_", "-"), {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        timeZone: "UTC"
      }).formatToParts(new Date(Date.UTC(2003, 10, 22)));
      const format = parts.filter((part) => ["day", "month", "year"].includes(part.type))
        .map((part) => part.type[0]).join("");
      if (!/^(dmy|mdy|ymd)$/.test(format)) return null;
      return {
        format,
        separator: parts.find((part) => part.type === "literal")?.value?.match(/[-/.]/)?.[0] || "/",
        source: "explicit_locale"
      };
    } catch (_) {
      return null;
    }
  }
  
  function dateFieldEvidenceForElement(element) {
    if (!element) return null;
    const inputType = String(element.getAttribute?.("type") || element.type || "").toLowerCase();
    const autocomplete = String(element.getAttribute?.("autocomplete") || "").toLowerCase();
    const placeholder = String(element.getAttribute?.("placeholder") || "");
    const pattern = String(element.getAttribute?.("pattern") || "");
    const description = describedText(element);
    const label = labelText(element) || accessibleName(element) || "";
    const name = String(element.getAttribute?.("name") || "");
    const locale = observedLocale();
    const hint = `${label} ${name} ${placeholder}`.toLowerCase();
    let component = "";
    if (/bday-day/.test(autocomplete)) component = "day";
    else if (/bday-month/.test(autocomplete)) component = "month";
    else if (/bday-year/.test(autocomplete)) component = "year";
    else {
      const hasFullTokens = Boolean(dateFormatFromTokens(`${placeholder} ${pattern} ${description} ${label} ${name}`));
      if (!hasFullTokens) {
        const matches = [
          ["day", /(^|[^a-z])(day|dd)([^a-z]|$)/],
          ["month", /(^|[^a-z])(month|mm)([^a-z]|$)/],
          ["year", /(^|[^a-z])(year|yyyy)([^a-z]|$)/]
        ].filter(([, regex]) => regex.test(hint));
        if (matches.length === 1) component = matches[0][0];
      }
    }
    const explicit = dateFormatFromTokens(`${placeholder} ${pattern} ${description} ${label} ${name} ${autocomplete}`);
    const localized = !explicit && inputType !== "date" && !component ? dateFormatFromLocale(locale) : null;
    const contract = inputType === "date"
      ? { format: "ymd", separator: "-", source: "native_date_input" }
      : component
        ? { component, source: "component_semantics" }
        : explicit || localized;
    return {
      inputType,
      placeholder: placeholder.slice(0, 120),
      pattern: pattern.slice(0, 180),
      description,
      label: String(label).slice(0, 220),
      name: name.slice(0, 120),
      autocomplete: autocomplete.slice(0, 80),
      inputMode: String(element.getAttribute?.("inputmode") || "").slice(0, 40),
      locale: locale.slice(0, 40),
      options: element.tagName === "SELECT"
        ? [...element.options].map((option) => ({ value: option.value, label: compactText(option.textContent || option.label || option.value, 120) })).slice(0, 120)
        : [],
      format: contract?.format || "",
      component: contract?.component || "",
      separator: contract?.separator || "",
      source: contract?.source || "",
      ambiguous: !contract
    };
  }
  
  function validCanonicalDate(value = "") {
    const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return "";
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
      ? `${match[1]}-${match[2]}-${match[3]}`
      : "";
  }
  
  function decodeObservedDateValue(value = "", dateField = {}) {
    const raw = String(value || "").trim();
    if (dateField.component) {
      const digits = raw.match(/\d{1,4}/)?.[0] || "";
      if (!digits) return {};
      return {
        component: dateField.component,
        componentValue: digits.padStart(dateField.component === "year" ? 4 : 2, "0")
      };
    }
    if (!dateField.format) return {};
    const values = raw.match(/\d+/g) || [];
    if (values.length !== 3) return {};
    const parts = Object.fromEntries(dateField.format.split("").map((token, index) => [token, values[index]]));
    const canonicalDateValue = validCanonicalDate(
      `${String(parts.y || "").padStart(4, "0")}-${String(parts.m || "").padStart(2, "0")}-${String(parts.d || "").padStart(2, "0")}`
    );
    return canonicalDateValue ? { canonicalDateValue } : {};
  }
  
  function controlStateForElement(element, semantic = "", choiceBinding = null) {
    const value = currentElementValue(element);
    const meaningfulValue = value && !isPlaceholderChoiceValue(value, element) ? value : "";
    const dateField = semantic === "date_of_birth" ? dateFieldEvidenceForElement(element) : null;
    const decodedDate = dateField ? decodeObservedDateValue(value, dateField) : {};
    const exposesChoiceValue = isDropdownLikeElement(element) || implicitRole(element) === "option";
    const valueText = exposesChoiceValue && value && !isPlaceholderChoiceValue(value, element)
      ? compactText(value, 180)
      : "";
    const choiceLike = Boolean(
      choiceBinding
      || element?.type === "radio"
      || element?.type === "checkbox"
      || ["radio", "checkbox", "option"].includes(implicitRole(element))
    );
    const optionValue = choiceLike
      ? normalizedProfileChoiceValue(
          choiceBinding?.optionLabels?.[choiceBinding.optionIndex]
          || choiceBinding?.label
          || choiceLabel(element)
          || element?.getAttribute?.("value")
          || "",
          semantic
        )
      : "";
    const normalizedValue = !meaningfulValue
      ? ""
      : semantic === "date_of_birth"
        ? (decodedDate.canonicalDateValue || decodedDate.componentValue || "")
        : normalizedControlValue(meaningfulValue, semantic, element);
    const choiceSelected = choiceBinding
      ? choiceBinding.selection?.selected === true
      : (choiceLike ? isChoiceSelected(element) : false);
    return {
      checked: Boolean(choiceBinding
        ? choiceSelected
        : element?.matches?.("input[type='checkbox'], input[type='radio']")
        ? element.checked === true
        : element?.getAttribute?.("aria-checked") === "true"),
      selected: Boolean(choiceSelected),
      selectionEvidence: choiceBinding ? {
        source: choiceBinding.selection?.source || "",
        probeElementId: choiceBinding.selection?.probeElementId || "",
        selectedCount: Number(choiceBinding.selection?.selectedCount || 0),
        exclusive: choiceBinding.selection?.exclusive === true,
        invariantValid: choiceBinding.selection?.valid !== false,
        decisionOwnerId: elementId(choiceBinding.decisionOwner),
        optionOwnerId: elementId(choiceBinding.optionOwner)
      } : null,
      valuePresent: Boolean(meaningfulValue && String(meaningfulValue).trim()),
      value: meaningfulValue ? "[filled]" : "",
      valueText,
      normalizedValue,
      optionValue,
      selectedValue: choiceSelected ? (optionValue || normalizedValue) : "",
      canonicalDateValue: decodedDate.canonicalDateValue || "",
      dateComponent: decodedDate.component || "",
      dateComponentValue: decodedDate.componentValue || "",
      normalizationMode: semantic === "phone_country_code" ? "country_code" : semantic === "phone" ? "phone" : semantic === "date_of_birth" ? "date_codec" : "text",
      disabled: isDisabledLike(element),
      required: Boolean(element?.required === true || element?.getAttribute?.("aria-required") === "true"),
      invalid: Boolean(element?.getAttribute?.("aria-invalid") === "true" || element?.matches?.(":invalid") === true),
      validationMessage: compactText(element?.validationMessage || describedText(element), 240),
      expanded: element?.getAttribute?.("aria-expanded") === "true",
      pressable: element?.hasAttribute?.("aria-pressed") === true,
      pressed: element?.getAttribute?.("aria-pressed") === "true",
      native: element?.tagName === "SELECT"
    };
  }
  
  function effectiveOperationActuator(element) {
    if (!element || !isVisible(element) || isDisabledLike(element)) return null;
    const elementStyle = getComputedStyle(element);
    if (
      elementStyle.display === "none"
      || elementStyle.visibility === "hidden"
      || elementStyle.pointerEvents === "none"
      || Number(elementStyle.opacity || 1) < 0.15
    ) {
      return null;
    }
    const box = elementBox(element);
    if (!meaningfulActionBox(box)) return null;
    if (box.inViewport === false) return element;
    const x = Math.min(window.innerWidth - 2, Math.max(2, box.centerX));
    const y = Math.min(window.innerHeight - 2, Math.max(2, box.centerY));
    const hit = document.elementFromPoint(x, y);
    if (!hit || !(hit === element || element.contains(hit) || hit.contains(element))) return null;
    const elementRole = implicitRole(element);
    const elementOwnsActivation = element.matches?.("button, a, input[type='button'], input[type='submit'], [role='button'], [tabindex]")
      || elementRole === "button"
      || (
        elementStyle.cursor === "pointer"
        && box.width > 40
        && box.height > 24
      );
    if (elementOwnsActivation) return element;
    const actionableHit = clickableAncestor(hit);
    if (actionableHit && (actionableHit === element || element.contains(actionableHit) || actionableHit.contains(element))) {
      return actionableHit;
    }
    return element;
  }
  
  function operationActuatorCandidates(stateElement, sourceElement, activationElement, controlRegion = null) {
    const candidates = [];
    const add = (element, score, reason, {
      operationProven = false,
      proofEvidence = ""
    } = {}) => {
      if (!element || !isVisible(element) || isDisabledLike(element) || element.closest?.("#atw-sidebar")) return;
      const effectiveElement = effectiveOperationActuator(element);
      if (!effectiveElement) return;
      const nodeId = elementId(effectiveElement);
      const current = candidates.find((entry) => entry.nodeId === nodeId);
      const entry = {
        element: effectiveElement,
        nodeId,
        score,
        reason,
        sourceNodeId: elementId(element),
        role: implicitRole(effectiveElement),
        tagName: String(effectiveElement.tagName || "").toLowerCase(),
        box: elementBox(effectiveElement),
        targetable: true,
        operationProven: operationProven === true,
        proofEvidence: proofEvidence || ""
      };
      if (!current) candidates.push(entry);
      else {
        const proven = current.operationProven === true || entry.operationProven === true;
        const evidence = [current.proofEvidence, entry.proofEvidence].filter(Boolean).join("|");
        if (score > current.score) Object.assign(current, entry);
        current.operationProven = proven;
        current.proofEvidence = evidence;
      }
    };
    const controlledId = stateElement?.getAttribute?.("aria-controls") || stateElement?.getAttribute?.("aria-owns") || "";
    const stateBox = stateElement?.getBoundingClientRect?.() || null;
    const scopes = [];
    let scope = stateElement?.parentElement || null;
    for (let depth = 0; scope && depth < 3; depth += 1, scope = scope.parentElement) {
      if (scope.closest?.("#atw-sidebar")) break;
      const box = scope.getBoundingClientRect?.();
      if (!box || box.width > Math.max(720, window.innerWidth * 0.75) || box.height > 260) break;
      scopes.push(scope);
    }
    for (const container of scopes) {
      queryAllDeep("button, [role='button'], [aria-haspopup='listbox'], [aria-controls], [aria-owns], [tabindex], [onclick], [class*='arrow'], [class*='chevron'], [class*='toggle'], [class*='indicator'], svg", container)
        .forEach((candidate) => {
          if (candidate === stateElement) return;
          const candidateControls = candidate.getAttribute?.("aria-controls") || candidate.getAttribute?.("aria-owns") || "";
          const explicitMatch = Boolean(controlledId && candidateControls === controlledId);
          const popupContract = candidate.getAttribute?.("aria-haspopup") === "listbox" || candidate.getAttribute?.("aria-expanded") != null;
          const role = implicitRole(candidate);
          const buttonContract = candidate.tagName === "BUTTON" || role === "button";
          const clickable = clickableAncestor(candidate);
          const candidateStyle = getComputedStyle(candidate);
          const pointerContract = candidateStyle.cursor === "pointer" || candidate.hasAttribute?.("onclick");
          const candidateBox = candidate.getBoundingClientRect?.();
          const rightEdgeControl = Boolean(
            stateBox
            && candidateBox
            && candidateBox.width >= 8
            && candidateBox.height >= 8
            && candidateBox.width <= Math.max(96, stateBox.width * 0.45)
            && candidateBox.left >= stateBox.left + stateBox.width * 0.55
            && candidateBox.top < stateBox.bottom
            && candidateBox.bottom > stateBox.top
          );
          const localActivationMember = candidate === activationElement
            || candidate === sourceElement
            || candidate.contains?.(stateElement)
            || stateElement?.contains?.(candidate);
          const operationProven = explicitMatch
            || popupContract
            || candidate.hasAttribute?.("onclick")
            || (localActivationMember && buttonContract);
          const targetableCandidate = operationProven
            || localActivationMember
            || rightEdgeControl
            || pointerContract;
          if (targetableCandidate) {
            const target = clickable && clickable !== stateElement ? clickable : candidate;
            add(
              target,
              explicitMatch ? 130 : popupContract ? 115 : operationProven ? 100 : rightEdgeControl ? 95 : 85,
              explicitMatch
                ? "shared-aria-controls"
                : popupContract
                  ? "popup-contract"
                  : operationProven
                    ? "button-in-control"
                    : rightEdgeControl
                      ? "targetable-right-edge"
                      : "targetable-local-node",
              {
                operationProven,
                proofEvidence: explicitMatch
                  ? "shared_aria_controls"
                  : popupContract
                    ? "popup_contract"
                    : candidate.hasAttribute?.("onclick")
                      ? "inline_activation_handler"
                      : operationProven
                        ? "button_control_member"
                        : ""
              }
            );
          }
        });
    }
    const stateRole = implicitRole(stateElement);
    const stateProvesActivation = stateElement?.tagName === "BUTTON"
      || stateRole === "button"
      || stateElement?.hasAttribute?.("onclick");
    if (stateProvesActivation) {
      add(stateElement, 90, "state-proves-activation", {
        operationProven: true,
        proofEvidence: "state_activation_contract"
      });
    }
    if (activationElement && activationElement !== stateElement) {
      const activationRole = implicitRole(activationElement);
      const activationStyle = getComputedStyle(activationElement);
      const activationProvesOpen = activationElement.tagName === "BUTTON"
        || activationRole === "button"
        || activationElement.getAttribute?.("aria-haspopup") === "listbox"
        || activationElement.hasAttribute?.("onclick");
      if (activationProvesOpen || activationStyle.cursor === "pointer") {
        add(activationElement, 80, activationProvesOpen ? "activation-member" : "targetable-activation-member", {
          operationProven: activationProvesOpen,
          proofEvidence: activationProvesOpen ? "activation_member_contract" : ""
        });
      }
    }
    if (sourceElement && sourceElement !== stateElement) {
      const sourceStyle = getComputedStyle(sourceElement);
      const sourceContract = sourceElement.getAttribute?.("aria-haspopup") === "listbox"
        || sourceElement.getAttribute?.("aria-expanded") != null
        || sourceElement.tagName === "BUTTON"
        || implicitRole(sourceElement) === "button"
        || sourceElement.hasAttribute?.("onclick");
      if (sourceContract || sourceStyle.cursor === "pointer") {
        add(sourceElement, 110, sourceContract ? "source-popup-contract" : "targetable-source-member", {
          operationProven: sourceContract,
          proofEvidence: sourceContract ? "source_activation_contract" : ""
        });
      }
    }
    if (controlRegion && controlRegion !== stateElement) {
      const regionProvesOpen = controlRegion.getAttribute?.("aria-haspopup") === "listbox"
        || controlRegion.getAttribute?.("aria-expanded") != null
        || controlRegion.tagName === "BUTTON"
        || implicitRole(controlRegion) === "button"
        || controlRegion.hasAttribute?.("onclick");
      add(controlRegion, regionProvesOpen ? 105 : 70, regionProvesOpen ? "control-region-contract" : "targetable-control-region", {
        operationProven: regionProvesOpen,
        proofEvidence: regionProvesOpen ? "control_region_activation_contract" : ""
      });
    }
    return candidates.sort((a, b) => b.score - a.score);
  }
  
  function boundedLocalControlRegionBox(stateElement, controlRegion) {
    if (!stateElement
      || !controlRegion
      || controlRegion === stateElement
      || !isVisible(controlRegion)
      || isDisabledLike(controlRegion)
      || controlRegion.closest?.("#atw-sidebar")) {
      return null;
    }
    const stateBox = stateElement.getBoundingClientRect?.();
    const regionBox = elementBox(controlRegion);
    const local = Boolean(
      meaningfulActionBox(regionBox)
      && stateBox
      && regionBox.width <= Math.max(560, stateBox.width * 3)
      && regionBox.height <= Math.max(160, stateBox.height * 4)
      && regionBox.x < stateBox.right
      && regionBox.x + regionBox.width > stateBox.left
      && regionBox.y < stateBox.bottom
      && regionBox.y + regionBox.height > stateBox.top
      && regionBox.inViewport !== false
    );
    return local ? regionBox : null;
  }
  
  function normalizeVisualRegionContract(raw = {}, context = {}) {
    if (!raw || typeof raw !== "object") return null;
    const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
    const x = Math.round(finite(raw.x));
    const y = Math.round(finite(raw.y));
    const width = Math.max(0, Math.round(finite(raw.width)));
    const height = Math.max(0, Math.round(finite(raw.height)));
    return {
      x,
      y,
      width,
      height,
      centerX: Math.round(finite(raw.centerX, x + width / 2)),
      centerY: Math.round(finite(raw.centerY, y + height / 2)),
      viewportWidth: Math.max(0, Math.round(finite(raw.viewportWidth, context.viewportWidth || window.innerWidth))),
      viewportHeight: Math.max(0, Math.round(finite(raw.viewportHeight, context.viewportHeight || window.innerHeight))),
      surfaceId: String(raw.surfaceId || context.surfaceId || "").slice(0, 120),
      observationId: String(context.observationId || raw.observationId || "").slice(0, 120),
      controlId: String(raw.controlId || context.controlId || "").slice(0, 140),
      operation: String(raw.operation || context.operation || "").slice(0, 40),
      source: String(raw.source || context.source || "").slice(0, 120),
      confidence: Math.max(0, Math.min(1, finite(raw.confidence, context.confidence))),
      evidence: String(raw.evidence || context.evidence || "").slice(0, 240),
      inViewport: raw.inViewport !== false
    };
  }
  
  function visualRegionContractsMatch(left = {}, right = {}, tolerance = 2) {
    const a = normalizeVisualRegionContract(left);
    const b = normalizeVisualRegionContract(right);
    if (!a || !b) return false;
    if (!["x", "y", "width", "height", "centerX", "centerY"].every((key) => Math.abs(a[key] - b[key]) <= tolerance)) {
      return false;
    }
    return ["viewportWidth", "viewportHeight", "surfaceId", "observationId", "controlId", "operation", "source"]
      .every((key) => !a[key] || !b[key] || a[key] === b[key]);
  }
  
  function controlOperationsForElement({
    element,
    stateElement,
    activationElement,
    controlRegion,
    kind,
    role,
    state,
    profileChoiceOpener = false,
    openTargetCandidates = [],
    choiceActuatorCandidates = []
  }) {
    const operations = { activate: null, open: null, choose: null, type: null, select: null, keyboard: null };
    const make = (name, actuatorCandidates, expectedOutcome, precondition = {}) => {
      const candidates = (actuatorCandidates || []).map((candidate) => typeof candidate === "string"
        ? { nodeId: candidate }
        : candidate).filter((candidate) => candidate?.nodeId);
      const ids = [...new Set(candidates.map((candidate) => candidate.nodeId))];
      if (!ids.length) return null;
      return {
        operation: name,
        actuatorId: ids[0],
        actuatorIds: ids,
        candidates: candidates.map((candidate) => ({
          nodeId: candidate.nodeId,
          sourceNodeId: candidate.sourceNodeId || candidate.nodeId,
          role: candidate.role || "",
          tagName: candidate.tagName || "",
          box: candidate.box || null,
          reason: candidate.reason || "canonical-member",
          targetable: candidate.targetable !== false,
          operationProven: candidate.operationProven !== false,
          proofEvidence: candidate.proofEvidence || ""
        })),
        precondition,
        expectedOutcome
      };
    };
    const stateId = elementId(stateElement);
    const activationId = activationElement ? elementId(activationElement) : "";
    const tag = String(stateElement?.tagName || "").toLowerCase();
    const inputType = String(stateElement?.getAttribute?.("type") || "").toLowerCase();
    const dropdownLike = profileChoiceOpener || tag === "select" || role === "combobox" || role === "listbox" || stateElement?.getAttribute?.("aria-haspopup") === "listbox";
    const editable = stateElement?.isContentEditable
      || tag === "textarea"
      || (tag === "input" && !["button", "submit", "reset", "radio", "checkbox", "file", "hidden"].includes(inputType));
    if (editable) {
      operations.type = make(
        "type",
        [stateId],
        dropdownLike ? "semantic_progress" : "normalized_value_changed",
        { disabled: false }
      );
    }
    if (tag === "select" && state.disabled !== true) {
      operations.select = make("select", [stateId], "normalized_value_changed", { disabled: false });
    }
    if (dropdownLike) {
      const openCandidates = (openTargetCandidates || []).filter((candidate) => candidate.operationProven === true);
      if (tag !== "select" || state.disabled === true) {
        operations.open = make("open", openCandidates, "options_surface_appeared", { expanded: false });
      }
      if (tag !== "select") {
        operations.keyboard = make("keyboard", [stateId], "semantic_progress", { disabled: false });
      }
    }
    if (["option", "radio", "checkbox"].includes(kind) || ["option", "radio", "checkbox"].includes(role)) {
      operations.choose = make(
        "choose",
        [...choiceActuatorCandidates, activationId, stateId],
        "control_selected",
        { disabled: false }
      );
    } else if (!dropdownLike && (kind === "button" || role === "button")) {
      operations.activate = make("activate", [activationId, stateId], "observable_change", { disabled: false });
    }
    return operations;
  }
  
  function perceptionRoleForControl(stateElement, kind, domRole, operations = {}) {
    const tag = String(stateElement?.tagName || "").toLowerCase();
    const editable = Boolean(operations.type);
    const dropdownLike = tag === "select"
      || ["combobox", "listbox"].includes(String(domRole || "").toLowerCase())
      || stateElement?.getAttribute?.("aria-haspopup") === "listbox";
    if (editable && dropdownLike && tag !== "select") return "editable_combobox";
    if (tag === "select") return "select";
    return domRole || kind || "control";
  }
  
  function observedCapabilities(operations = {}, perceptionRole = "") {
    const capabilities = [];
    if (operations.type) capabilities.push(perceptionRole === "editable_combobox" ? "type_query" : "type");
    if (operations.select) capabilities.push("select");
    if (operations.open) capabilities.push("open");
    if (operations.choose) capabilities.push("choose");
    if (operations.keyboard) capabilities.push("keyboard");
    if (operations.activate) capabilities.push("activate");
    return capabilities;
  }
  
  function unionBoxes(boxes = []) {
    const valid = boxes.filter((box) => box && Number.isFinite(Number(box.x)) && Number.isFinite(Number(box.y)));
    if (!valid.length) return null;
    const left = Math.min(...valid.map((box) => Number(box.x)));
    const top = Math.min(...valid.map((box) => Number(box.y)));
    const right = Math.max(...valid.map((box) => Number(box.x) + Number(box.width || 0)));
    const bottom = Math.max(...valid.map((box) => Number(box.y) + Number(box.height || 0)));
    const width = Math.max(0, right - left);
    const height = Math.max(0, bottom - top);
    return {
      x: Math.round(left),
      y: Math.round(top),
      width: Math.round(width),
      height: Math.round(height),
      centerX: Math.round(left + width / 2),
      centerY: Math.round(top + height / 2),
      inViewport: valid.some((box) => box.inViewport)
    };
  }
  
  function actuatorEntry(element, relation) {
    if (!element) return null;
    return {
      nodeId: elementId(element),
      relation,
      role: implicitRole(element),
      label: compactText(directControlName(element) || buttonText(element) || labelText(element) || element.innerText || element.textContent || accessibleName(element), 180),
      box: elementBox(element)
    };
  }
  
  function controlDomFingerprint(element, stateElement, label = "") {
    const target = stateElement || element;
    const parent = target?.parentElement || null;
    const siblings = parent
      ? [...parent.children].filter((child) => {
          const role = implicitRole(child);
          return child === target
            || child.matches?.("button, input, select, textarea, [role='button'], [role='radio'], [role='checkbox'], [role='option'], label, [tabindex]")
            || /button|radio|checkbox|option|combobox/.test(role);
        })
      : [];
    const ordinal = Math.max(0, siblings.indexOf(target));
    return stableHash([
      (target?.tagName || "").toLowerCase(),
      implicitRole(target),
      target?.getAttribute?.("type") || "",
      normalizeMatchText(directControlName(target) || label),
      parent ? normalizeMatchText(directControlName(parent) || parent.getAttribute?.("role") || parent.tagName || "").slice(0, 80) : "",
      `ord:${ordinal}`
    ].join("|"));
  }
  
  function stableControlKeyForElement(element, stateElement, kind = "control") {
    const target = stateElement || element;
    if (!target) return "";
    const associatedLabel = labelElementForInput(target);
    const associatedLabelText = associatedLabel && associatedLabel !== target
      ? (associatedLabel.innerText || associatedLabel.textContent || "")
      : "";
    const isMutableValueControl = target.matches?.("input, select, textarea") === true;
    const localMeaning = normalizeMatchText(
      associatedLabelText
      || target.getAttribute?.("aria-label")
      || target.getAttribute?.("title")
      || target.getAttribute?.("placeholder")
      || (!isMutableValueControl ? buttonText(target) : "")
      || ""
    ).slice(0, 140);
    const stableAttributes = [
      target.getAttribute?.("name") ? `name:${target.getAttribute("name")}` : "",
      target.getAttribute?.("type") ? `type:${target.getAttribute("type")}` : "",
      target.getAttribute?.("autocomplete") ? `autocomplete:${target.getAttribute("autocomplete")}` : "",
      target.getAttribute?.("data-testid") ? `testid:${target.getAttribute("data-testid")}` : "",
      localMeaning ? `meaning:${localMeaning}` : ""
    ].filter(Boolean);
    const path = [];
    let current = target;
    for (let depth = 0; current && depth < 5; depth += 1, current = current.parentElement) {
      const tag = String(current.tagName || "node").toLowerCase();
      const role = implicitRole(current) || "";
      const siblings = current.parentElement
        ? [...current.parentElement.children].filter((item) => String(item.tagName || "").toLowerCase() === tag && implicitRole(item) === role)
        : [current];
      const ordinal = Math.max(0, siblings.indexOf(current));
      path.push(`${tag}:${role || "none"}:${ordinal}`);
    }
    return [kind, ...stableAttributes, `path:${path.join("/")}`].join("|");
  }
  
  function boundedChoiceOptionOwner(element, decisionOwner, peers = []) {
    if (!element || !decisionOwner || !decisionOwner.contains(element)) return null;
    let best = element;
    for (let current = element; current && current !== decisionOwner; current = current.parentElement) {
      const ownedPeers = peers.filter((peer) => current === peer || current.contains(peer));
      if (ownedPeers.length !== 1 || ownedPeers[0] !== element) break;
      best = current;
    }
    return best;
  }
  
  function selectedClassEvidence(element) {
    const tokens = String(element?.getAttribute?.("class") || "")
      .split(/\s+/)
      .map((token) => token.trim())
      .filter(Boolean);
    const token = tokens.find((item) => /^(?:is[-_])?(?:selected|checked|chosen)$|[-_](?:selected|checked|chosen)(?:[-_]|$)/i.test(item));
    return token ? `class:${token}` : "";
  }
  
  function choiceVisualStateSignature(element) {
    if (!element) return "";
    const visualNodes = [
      element,
      ...queryAllDeep("svg, svg *, [aria-hidden='true']", element)
    ].filter((node, index, list) => node && list.indexOf(node) === index).slice(0, 32);
    return visualNodes.map((node) => {
      const style = getComputedStyle(node);
      return [
        String(node.tagName || "").toLowerCase(),
        node.getAttribute?.("class") || "",
        node.getAttribute?.("style") || "",
        node.getAttribute?.("fill") || "",
        node.getAttribute?.("stroke") || "",
        node.getAttribute?.("opacity") || "",
        node.getAttribute?.("visibility") || "",
        style.fill || "",
        style.stroke || "",
        style.opacity || "",
        style.visibility || "",
        style.display || ""
      ].join(":");
    }).join("|");
  }
  
  function rememberChoiceVisualStateBeforeDispatch(element, decision = {}) {
    const controlId = String(decision.controlId || element?.dataset?.atwControlId || "").trim();
    const decisionGroupId = String(
      decision.decisionGroupId
      || decision.targetSnapshot?.decisionGroupId
      || decision.semanticOwnerId
      || decision.goalId
      || ""
    ).trim();
    const exactChoiceSelection = ["choose", "select"].includes(String(decision.operation || ""))
      || ["exact_free_option_selected", "control_selected"].includes(String(decision.expectedOutcome?.type || ""));
    if (
      !controlId
      || !decisionGroupId
      || !exactChoiceSelection
      || !element?.matches?.("button, [role='button']")
      || element.matches?.("[role='option'], [role='menuitem']")
    ) {
      return null;
    }
    return updateChoiceInteractionState(controlId, {
      status: "dispatching",
      exactChoiceCommitted: false,
      decisionGroupId,
      actuatorId: elementId(element),
      visualStateBefore: choiceVisualStateSignature(element),
      visualStateAfter: "",
      evidenceSource: "",
      pageKey: `${location.origin}${location.pathname}`
    });
  }
  
  function visualChoiceTransitionEvidence(actuator) {
    if (!actuator) return "";
    const actuatorId = elementId(actuator);
    const pageKey = `${location.origin}${location.pathname}`;
    const entry = [...choiceInteractionStates.entries()]
      .filter(([, state]) => (
        state?.actuatorId === actuatorId
        && state?.pageKey === pageKey
        && state?.visualStateBefore
        && Date.now() - Number(state.updatedAt || 0) < 30_000
      ))
      .sort((left, right) => Number(right[1]?.updatedAt || 0) - Number(left[1]?.updatedAt || 0))[0];
    if (!entry) return "";
    const [controlId, state] = entry;
    const current = choiceVisualStateSignature(actuator);
    if (!current) return "";
    if (state.visualStateAfter) {
      return state.exactChoiceCommitted === true && current === state.visualStateAfter
        ? "owned_visual_state_transition"
        : "";
    }
    if (current === state.visualStateBefore) return "";
    updateChoiceInteractionState(controlId, {
      status: "committed",
      exactChoiceCommitted: true,
      visualStateAfter: current,
      evidenceSource: "owned_visual_state_transition"
    });
    return "owned_visual_state_transition";
  }
  
  function customChoiceStateEvidence(optionOwner, actuator) {
    const probes = [
      actuator,
      optionOwner,
      ...queryAllDeep(
        "input[type='radio'], input[type='checkbox'], option, [role='radio'], [role='checkbox'], [role='option'], [aria-checked], [aria-selected], [aria-pressed], [data-state], [data-selected], [data-checked]",
        optionOwner || actuator
      ),
      ...queryAllDeep("[class*='selected'], [class*='checked'], [class*='chosen']", optionOwner || actuator)
    ].filter((element, index, list) => element && list.indexOf(element) === index);
    const native = probes.filter((element) => element.matches?.("input[type='radio'], input[type='checkbox'], option"));
    if (native.length) {
      const selected = native.filter((element) => explicitChoiceBooleanState(element) === true);
      return {
        selected: selected.length === 1,
        explicit: true,
        source: selected.length === 1 ? "owned_native_state" : "owned_native_unselected",
        probeElementId: elementId(selected[0] || native[0])
      };
    }
    const explicit = probes
      .map((element) => ({ element, value: explicitChoiceBooleanState(element) }))
      .filter((entry) => entry.value !== null);
    const explicitSelected = explicit.filter((entry) => entry.value === true);
    if (explicitSelected.length) {
      return {
        selected: true,
        explicit: true,
        source: "owned_explicit_state",
        probeElementId: elementId(explicitSelected[0].element)
      };
    }
    const classProbe = probes
      .map((element) => ({ element, evidence: selectedClassEvidence(element) }))
      .find((entry) => entry.evidence);
    if (classProbe) {
      return {
        selected: true,
        explicit: true,
        source: classProbe.evidence,
        probeElementId: elementId(classProbe.element)
      };
    }
    if (explicit.length) {
      return {
        selected: false,
        explicit: true,
        source: "owned_explicit_unselected",
        probeElementId: elementId(explicit[0].element)
      };
    }
    const visualTransition = visualChoiceTransitionEvidence(actuator);
    if (visualTransition) {
      return {
        selected: true,
        explicit: true,
        source: visualTransition,
        probeElementId: elementId(actuator)
      };
    }
    return {
      selected: false,
      explicit: false,
      source: "no_owned_selection_state",
      probeElementId: ""
    };
  }
  
  function customButtonChoicePeers(owner) {
    if (!owner) return [];
    return queryAllDeep("button, [role='button']", owner)
      .filter((candidate, index, list) => (
        isVisible(candidate)
        && !isDisabledLike(candidate)
        && !candidate.closest?.("#atw-sidebar")
        && !isGlobalChromeControl(candidate)
        && list.indexOf(candidate) === index
        && !/^(?:continue|next|proceed|back|close|done)$/i.test(buttonText(candidate).trim())
        && !isInformationalChoiceUtility(candidate)
      ));
  }
  
  function isInformationalChoiceUtility(element) {
    const text = compactText(
      directControlName(element)
      || buttonText(element)
      || element?.innerText
      || element?.textContent
      || accessibleName(element)
      || "",
      180
    );
    return /\b(?:learn more|learn .*details|more info(?:rmation)?|view details|view price breakdown|price breakdown|details & terms|comparison and terms|included in premium|terms and conditions)\b/i.test(text);
  }
  
  function elementExplicitlyTargetsChoiceState(element, stateElement) {
    if (!element || !stateElement) return false;
    if (element === stateElement || element.contains?.(stateElement)) return true;
    const stateId = String(stateElement.getAttribute?.("id") || "").trim();
    if (!stateId) return false;
    const references = [
      element.getAttribute?.("for"),
      element.getAttribute?.("aria-controls"),
      element.getAttribute?.("data-controls"),
      element.getAttribute?.("data-target"),
      element.getAttribute?.("data-selects"),
      element.getAttribute?.("data-radio"),
      element.getAttribute?.("data-input-id")
    ].filter(Boolean).flatMap((value) => String(value).split(/\s+/)).map((value) => value.replace(/^#/, ""));
    return references.includes(stateId);
  }
  
  function exactNativeChoiceActuators(stateElement, optionOwner) {
    const associatedLabel = labelElementForInput(stateElement);
    const nearestLabel = stateElement.closest?.("label") || null;
    const nestedPresentationActuators = queryAllDeep("button, [role='button'], [role='checkbox']", optionOwner || stateElement)
      .filter((candidate) => isNestedExclusiveChoiceActuator(candidate, stateElement));
    const candidates = [
      associatedLabel,
      nearestLabel,
      optionOwner?.matches?.("label") ? optionOwner : null,
      ...nestedPresentationActuators,
      ...queryAllDeep("button, [role='button']", optionOwner || stateElement.parentElement)
        .filter((candidate) => elementExplicitlyTargetsChoiceState(candidate, stateElement))
    ].filter(Boolean);
    return candidates.filter((candidate, index, list) => (
      candidate !== stateElement
      && (!candidate.matches?.("button, [role='button']") || !isInformationalChoiceUtility(candidate))
      && (nestedPresentationActuators.includes(candidate) || elementExplicitlyTargetsChoiceState(candidate, stateElement))
      && list.indexOf(candidate) === index
    ));
  }
  
  function customButtonSelectionCtaDescriptor(peer) {
    if (!peer) return null;
    const controlLabel = compactText(
      directControlName(peer)
      || buttonText(peer)
      || peer.innerText
      || peer.textContent
      || "",
      220
    );
    const match = controlLabel.match(/^\s*(continue|choose|select|book|pick)\s+(?:with\s+)?(.+?)\s*$/i);
    if (!match) return null;
    return {
      command: String(match[1] || "").toLowerCase(),
      optionName: normalizeMatchText(match[2] || "")
    };
  }
  
  function signedCommercialOptionPrice(value = "") {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    const numberPattern = "\\d(?:[\\d\\s.,'’]*\\d)?";
    const currencyPattern = "(?:\\b(?:[A-Za-z]{3}|TL)\\b|€|\\$|£|¥|₩|₹|₺)";
    const amountThenCurrency = text.match(new RegExp(`\\+\\s*(${numberPattern})\\s*(${currencyPattern})`, "i"));
    if (amountThenCurrency) return structuredPriceFromText(amountThenCurrency[0]);
    const currencyThenAmount = text.match(new RegExp(`\\+\\s*(${currencyPattern})\\s*(${numberPattern})`, "i"));
    return currencyThenAmount ? structuredPriceFromText(currencyThenAmount[0]) : null;
  }
  
  function customButtonSelectionCtaEvidence(owner, peers = []) {
    if (!owner || peers.length < 2) return null;
    const selectionPeers = peers.filter((peer) => customButtonSelectionCtaDescriptor(peer));
    if (selectionPeers.length < 2) return null;
    const parsed = selectionPeers.map((peer) => {
      const descriptor = customButtonSelectionCtaDescriptor(peer);
      const optionOwner = boundedChoiceOptionOwner(peer, owner, selectionPeers);
      const optionText = compactText(
        optionOwner?.innerText
        || optionOwner?.textContent
        || "",
        500
      );
      const prices = structuredPricesFromText(optionText);
      const currentPrice = currentCommercialOptionPrice(optionText);
      const explicitlyIncluded = /\b(?:included|free|no extra (?:cost|charge)|at no extra (?:cost|charge))\b/i.test(optionText)
        || /\b0(?:[.,]0{1,2})?\s*(?:eur|usd|try|tl|€|\$|₺)\b/i.test(optionText);
      return {
        peer,
        command: descriptor?.command || "",
        optionName: descriptor?.optionName || "",
        optionOwner,
        optionText,
        prices,
        explicitlyIncluded,
        structuredPrice: currentPrice
          || signedCommercialOptionPrice(optionText)
          || (explicitlyIncluded
            ? { amount: 0, currency: "" }
            : (prices.length === 1 ? prices[0] : null))
      };
    });
    const paidCurrencies = [...new Set(parsed
      .map((item) => item.structuredPrice)
      .filter((price) => Number(price?.amount) > 0 && price.currency)
      .map((price) => price.currency))];
    if (paidCurrencies.length === 1) {
      parsed.forEach((item) => {
        if (Number(item.structuredPrice?.amount) === 0 && !item.structuredPrice.currency) {
          item.structuredPrice.currency = paidCurrencies[0];
        }
      });
    }
    const commands = new Set(parsed.map((item) => item.command).filter(Boolean));
    const optionNames = new Set(parsed.map((item) => item.optionName).filter(Boolean));
    const optionOwners = new Set(parsed.map((item) => item.optionOwner).filter(Boolean));
    const everyOptionHasOwnedCommercialEvidence = parsed.every((item) => (
      item.optionOwner
      && item.structuredPrice
    ));
    const hasPaidOption = parsed.some((item) => Number(item.structuredPrice?.amount) > 0);
    const hasIncludedOption = parsed.some((item) => Number(item.structuredPrice?.amount) === 0);
    if (
      commands.size !== 1
      || optionNames.size !== selectionPeers.length
      || optionOwners.size !== selectionPeers.length
      || !everyOptionHasOwnedCommercialEvidence
      || !hasPaidOption
      || !hasIncludedOption
    ) {
      return null;
    }
    return {
      kind: "commercial_option_cta_set",
      command: [...commands][0],
      parsed
    };
  }
  
  function paidDeclineSetEvidence(peers = []) {
    if (peers.length < 2) return { valid: false, hasDecline: false, hasPaid: false };
    const facts = peers.map((peer) => {
      const text = directControlName(peer) || buttonText(peer) || peer.innerText || peer.textContent || "";
      const semantic = semanticChoiceType(text);
      const risk = choiceRisk(text);
      return {
        semantic,
        risk,
        decisionLike: /decline_/.test(semantic)
          || semantic === "add_paid_extra"
          || /safe_decline|money|paid/.test(risk)
      };
    });
    const hasDecline = facts.some((fact) => /decline_/.test(fact.semantic) || fact.risk === "safe_decline");
    const hasPaid = facts.some((fact) => fact.semantic === "add_paid_extra" || /money|paid/.test(fact.risk));
    return {
      valid: hasDecline && hasPaid && facts.every((fact) => fact.decisionLike),
      hasDecline,
      hasPaid
    };
  }
  
  function customDecisionEvidence(owner, peers = []) {
    const role = String(owner?.getAttribute?.("role") || "").toLowerCase();
    const explicit = ["radiogroup", "listbox"].includes(role)
      || owner?.getAttribute?.("aria-required") != null
      || owner?.hasAttribute?.("data-choice-group");
    const paidDecline = paidDeclineSetEvidence(peers).valid;
    const commercial = Boolean(customButtonSelectionCtaEvidence(owner, peers));
    return { explicit, paidDecline, commercial };
  }
  
  function containsNestedCustomDecision(owner, peers = []) {
    if (!owner || peers.length < 3) return false;
    for (const peer of peers) {
      for (let current = peer.parentElement; current && current !== owner; current = current.parentElement) {
        const nestedPeers = customButtonChoicePeers(current);
        if (nestedPeers.length < 2 || nestedPeers.length >= peers.length) continue;
        const evidence = customDecisionEvidence(current, nestedPeers);
        if (evidence.explicit || evidence.paidDecline || evidence.commercial) return true;
      }
    }
    return false;
  }
  
  function validCustomButtonDecisionOwner(owner, element, context = {}) {
    if (!owner || !element || !owner.contains(element)) return false;
    if (owner.matches?.("html, body, main, form")) return false;
    if (context.section?.element && !context.section.element.contains(owner)) return false;
    const peers = customButtonChoicePeers(owner);
    if (peers.length < 2 || peers.length > 10 || !peers.includes(element)) return false;
    const role = String(owner.getAttribute?.("role") || "").toLowerCase();
    const explicitChoiceOwner = ["radiogroup", "listbox"].includes(role)
      || owner.getAttribute?.("aria-required") != null
      || owner.hasAttribute?.("data-choice-group");
    const paidDeclineSet = paidDeclineSetEvidence(peers).valid;
    const commercialOptionSet = customButtonSelectionCtaEvidence(owner, peers);
    // Inferred custom decisions are atomic and non-overlapping. Once a
    // descendant already proves a coherent choice, a page-layout ancestor may
    // not absorb unrelated buttons from a sibling summary or utility region.
    const crossesNestedDecision = !explicitChoiceOwner && containsNestedCustomDecision(owner, peers);
    if (crossesNestedDecision) return false;
    return explicitChoiceOwner
      || paidDeclineSet
      || Boolean(commercialOptionSet?.parsed.some((item) => item.peer === element));
  }
  
  function customButtonDecisionOwner(element, context = {}) {
    if (!element?.matches?.("button, [role='button']")) return null;
    const boundary = context.section?.element || null;
    const candidates = [];
    for (let current = element.parentElement, depth = 0; current; current = current.parentElement, depth += 1) {
      if (validCustomButtonDecisionOwner(current, element, context)) {
        const peers = customButtonChoicePeers(current);
        const commercialEvidence = customButtonSelectionCtaEvidence(current, peers);
        candidates.push({
          owner: current,
          depth,
          commercialOptionCount: commercialEvidence?.parsed.length || 0
        });
      }
      if (current === boundary) break;
      if (current.matches?.("main, form, body, html")) break;
    }
    if (!candidates.length) return null;
    const commercial = candidates
      .filter((candidate) => candidate.commercialOptionCount >= 2)
      .sort((left, right) => (
        right.commercialOptionCount - left.commercialOptionCount
        || left.depth - right.depth
      ))[0];
    return commercial?.owner || candidates[0].owner;
  }
  
  function nearestChoiceOwnerLabel(owner, boundary = null) {
    for (let current = owner; current; current = current.parentElement) {
      const heading = [...(current.children || [])].find((child) => (
        child.matches?.("legend, h1, h2, h3, h4, h5, h6, [role='heading']")
      ));
      const label = compactText(
        current.getAttribute?.("aria-label")
        || heading?.textContent
        || "",
        140
      );
      if (label) return label;
      if (current === boundary) break;
    }
    return "";
  }
  
  function choicePresentationBinding(stateElement, context = {}) {
    if (!stateElement) return null;
    const section = context.section || {};
    const nativeRadio = structuralDecisionChoiceKind(stateElement) === "radio";
    const decisionOwner = nativeRadio
      ? exclusiveDecisionOwner(stateElement, section)
      : customButtonDecisionOwner(stateElement, context);
    if (!decisionOwner) return null;
    const rawDecisionPeers = nativeRadio
      ? structuralDecisionChoicePeers(decisionOwner, stateElement)
      : customButtonChoicePeers(decisionOwner);
    const selectionCtaEvidence = nativeRadio
      ? null
      : customButtonSelectionCtaEvidence(decisionOwner, rawDecisionPeers);
    const decisionPeers = selectionCtaEvidence
      ? selectionCtaEvidence.parsed.map((item) => item.peer)
      : rawDecisionPeers;
    if (decisionPeers.length < 2) return null;
    const optionOwner = boundedChoiceOptionOwner(stateElement, decisionOwner, decisionPeers);
    if (!optionOwner) return null;
  
    const candidates = nativeRadio
      ? exactNativeChoiceActuators(stateElement, optionOwner)
      : [stateElement];
    const actuatorCandidates = candidates
      .filter((candidate, index, list) => (
        isVisible(candidate)
        && !isDisabledLike(candidate)
        && !candidate.closest?.("#atw-sidebar")
        && decisionPeers.filter((peer) => candidate === peer || candidate.contains(peer)).length <= 1
        && list.indexOf(candidate) === index
      ))
      .map((candidate) => {
        const box = elementBox(candidate);
        const text = compactText(
          directControlName(candidate)
          || buttonText(candidate)
          || candidate.innerText
          || candidate.textContent
          || accessibleName(candidate),
          220
        );
        const area = Math.max(0, Number(box?.width || 0) * Number(box?.height || 0));
        return {
          element: candidate,
          nodeId: elementId(candidate),
          sourceNodeId: elementId(candidate),
          role: implicitRole(candidate),
          tagName: String(candidate.tagName || "").toLowerCase(),
          box,
          reason: nativeRadio
            ? "single-option-owner-presentation-actuator"
            : "button-choice-option-actuator",
          targetable: true,
          operationProven: true,
          proofEvidence: nativeRadio
            ? "Visible actuator belongs to exactly one state-bearing radio inside a proven exclusive-choice owner."
            : "Visible button is one alternative inside a bounded exclusive choice owner.",
          score: (candidate.contains(stateElement) || candidate === stateElement ? 200000 : 0)
            + (text && !/^\s*(?:[+−-]?\s*)?\d[\d.,]*\s*(?:eur|usd|try|tl|€|\$|₺)?\s*$/i.test(text) ? 100000 : 0)
            + Math.min(area, 90000)
        };
      })
      .sort((left, right) => right.score - left.score);
    if (!actuatorCandidates.length) return null;
  
    const optionOwners = decisionPeers.map((peer) => boundedChoiceOptionOwner(peer, decisionOwner, decisionPeers));
    const optionTexts = optionOwners.map((owner, index) => compactText(
      owner?.innerText
      || owner?.textContent
      || decisionPeers[index]?.innerText
      || decisionPeers[index]?.textContent
      || "",
      500
    ));
    const optionLabels = decisionPeers.map((peer, index) => compactText(
      optionTexts[index]
      || peer.innerText
      || peer.textContent
      || choiceLabel(peer)
      || directControlName(peer)
      || "",
      160
    ));
    const siblingCurrencies = [...new Set(optionTexts
      .flatMap((text) => structuredPricesFromText(text))
      .map((price) => price.currency)
      .filter(Boolean))];
    const peerStates = decisionPeers.map((peer, index) => customChoiceStateEvidence(optionOwners[index], peer));
    const selectedIndexes = peerStates
      .map((state, index) => state.selected === true ? index : -1)
      .filter((index) => index >= 0);
    const optionIndex = decisionPeers.indexOf(stateElement);
    const selectionInvariantValid = selectedIndexes.length <= 1;
    const selection = {
      selected: selectionInvariantValid && selectedIndexes[0] === optionIndex,
      selectedCount: selectedIndexes.length,
      exclusive: true,
      valid: selectionInvariantValid,
      source: peerStates[optionIndex]?.source || "no_owned_selection_state",
      probeElementId: peerStates[optionIndex]?.probeElementId || ""
    };
    const rawOptionText = [
      optionTexts[optionIndex]
        || actuatorCandidates[0].element.innerText
        || actuatorCandidates[0].element.textContent
        || "",
      nativeRadio ? choiceLabel(stateElement) : "",
      // ARIA descriptions are explicit option-owned evidence even when the
      // rendered price node is a sibling rather than a DOM descendant of the
      // label/card. This is common in OTA bundle components.
      describedText(stateElement)
    ].filter(Boolean).join(" ");
    const optionText = compactText(rawOptionText, 220);
    const directOptionPrices = structuredPricesFromText(rawOptionText);
    const currentOptionPrice = currentCommercialOptionPrice(rawOptionText);
    const directActuatorText = compactText(
      directControlName(stateElement)
      || buttonText(stateElement)
      || stateElement.innerText
      || stateElement.textContent
      || accessibleName(stateElement)
      || "",
      220
    );
    const directActuatorPrice = structuredPriceFromText(directActuatorText);
    const directActuatorSemantic = semanticChoiceType(directActuatorText);
    // Commercial price evidence must belong to this option. Prefer an exact
    // signed delta ("+ 25 EUR") over unrelated monetary amounts in product
    // copy such as compensation limits or coverage benefits.
    const signedOptionPrice = signedCommercialOptionPrice(rawOptionText);
    const optionExplicitlyIncluded = /\b(?:included|free|no extra (?:cost|charge)|at no extra (?:cost|charge))\b/i.test(rawOptionText)
      || /\b0(?:[.,]0{1,2})?\s*(?:eur|usd|try|tl|€|\$|₺)\b/i.test(rawOptionText);
    const commercialOption = selectionCtaEvidence?.parsed.find((item) => item.peer === stateElement) || null;
    let structuredPrice = commercialOption?.structuredPrice
      || currentOptionPrice
      || signedOptionPrice
      || (optionExplicitlyIncluded
        ? { amount: 0, currency: siblingCurrencies.length === 1 ? siblingCurrencies[0] : "" }
        : (directOptionPrices.length === 1 ? directOptionPrices[0] : null));
    // The exact actuator is the authority for the action it will perform.
    // Surrounding option/summary copy may supply missing context, but it may
    // never turn a directly priced paid action into a free action.
    if (!nativeRadio && Number(directActuatorPrice?.amount) > 0) {
      structuredPrice = directActuatorPrice;
    } else if (!nativeRadio && directActuatorSemantic === "add_paid_extra" && Number(structuredPrice?.amount) === 0) {
      structuredPrice = null;
    }
    const ownerLabel = decisionChoiceOwnerLabel(decisionOwner, stateElement)
      || compactText(decisionOwner.querySelector?.("h1, h2, h3, h4, h5, h6, [role='heading']")?.textContent || "", 140)
      || nearestChoiceOwnerLabel(decisionOwner, section.element || null)
      || context.sectionLabel
      || section.label
      || "choice";
    const stableDecisionOwnerKey = stableControlKeyForElement(decisionOwner, decisionOwner, "decision")
      .split("|")
      // Decision identity must survive mutable product copy and prices. The
      // exact owner label plus structural path remain stable across selection.
      .filter((part) => !part.startsWith("meaning:"))
      .join("|");
    const ownerKey = [
      normalizeMatchText(ownerLabel),
      stableDecisionOwnerKey
    ].filter(Boolean).join("|");
    const nativeChoiceName = nativeRadio ? String(stateElement.getAttribute?.("name") || "").trim() : "";
    return {
      decisionOwner,
      optionOwner,
      activationElement: actuatorCandidates[0].element,
      actuatorCandidates,
      label: optionText,
      optionIndex,
      optionCount: decisionPeers.length,
      optionLabels,
      ownerLabel,
      ownerKey,
      decisionInstance: nativeRadio && nativeChoiceName
        ? `radio:name:${nativeChoiceName}`
        : `${nativeRadio ? "radio" : "custom-choice"}:owner:${ownerKey}`,
      structuredPrice,
      priceEvidenceSource: commercialOption
        ? (Number(commercialOption.structuredPrice?.amount) === 0
          ? "bounded_option_owner_included"
          : "bounded_option_owner_signed_delta")
        : currentOptionPrice
          ? "bounded_option_owner_current_price"
        : signedOptionPrice
          ? "bounded_option_owner_signed_delta"
        : directOptionPrices.length === 1
          ? "bounded_option_owner"
          : (optionExplicitlyIncluded ? "bounded_option_owner_included" : ""),
      advancesOnSelection: Boolean(selectionCtaEvidence),
      required: Boolean(
        stateElement.required
        || stateElement.getAttribute?.("aria-required") === "true"
        || decisionOwner.getAttribute?.("aria-required") === "true"
      ),
      selection
    };
  }
  
  function canonicalControlForElement(element, context = {}) {
    if (!element || element.closest?.("#atw-sidebar")) return null;
    const stateElement = canonicalExclusiveChoiceState(element, context);
    if (!stateElement || stateElement.closest?.("#atw-sidebar")) return null;
    const labelElement = labelElementForInput(stateElement);
    const wrapper = controlWrapperForElement(element, stateElement);
    const kind = controlKindForElement(stateElement);
    const presentationBinding = choicePresentationBinding(stateElement, context);
    const activationElement = presentationBinding?.activationElement
      || labelElement
      || clickableAncestor(element)
      || clickableAncestor(wrapper)
      || stateElement;
    const ownedEvidence = controlOwnedEvidence(stateElement);
    const directName = directControlName(stateElement) || directControlName(element);
    const label = compactText(
      kind === "button"
        ? (presentationBinding?.label
          || directName
          || buttonText(stateElement)
          || buttonText(element)
          || accessibleName(stateElement)
          || accessibleName(element))
        : (presentationBinding?.label
          || choiceLabel(stateElement)
          || directName
          || buttonText(element)
          || labelText(stateElement)
          || accessibleName(element)
          || accessibleName(stateElement)
          || controlText(stateElement)),
      220
    );
    const baseFieldClassification = classifyProfileField(stateElement, context.fieldType || context.field || "");
    const ownedOptionSetClassification = (() => {
      if (!presentationBinding || baseFieldClassification.fieldType || baseFieldClassification.ambiguity) return null;
      const labels = (presentationBinding.optionLabels || []).filter(Boolean);
      if (labels.length < 2 || labels.length !== presentationBinding.optionCount) return null;
      const titleValues = labels.map((value) => normalizedProfileChoiceValue(value, "title"));
      const genderValues = labels.map((value) => normalizedProfileChoiceValue(value, "gender"));
      const exactTitleSet = titleValues.includes("mr")
        && titleValues.includes("mrs/ms")
        && titleValues.every((value) => ["mr", "mrs/ms"].includes(value));
      const exactGenderSet = genderValues.includes("male")
        && genderValues.includes("female")
        && genderValues.every((value) => ["male", "female"].includes(value));
      const fieldType = exactTitleSet ? "title" : (exactGenderSet ? "gender" : "");
      if (!fieldType) return null;
      return {
        fieldType,
        source: "owned_exclusive_option_set",
        confidence: 0.98,
        evidence: labels,
        evidenceByChannel: {
          rawAttributes: [],
          explicitLabel: [],
          tightLocalOwner: [presentationBinding.ownerLabel, ...labels].filter(Boolean),
          sectionContext: []
        },
        tightOwnerId: elementId(presentationBinding.decisionOwner),
        tightOwnerKey: presentationBinding.ownerKey || ""
      };
    })();
    const fieldClassification = ownedOptionSetClassification || baseFieldClassification;
    const fieldType = fieldClassification.fieldType || "";
    const fieldSemantic = semanticFieldType({ label, kind, fieldType, field: context.field || "" });
    const contextualSectionType = context.sectionType || context.section?.type || "";
    const sectionLabel = context.sectionLabel || context.section?.label || "";
    const sectionId = context.sectionId || context.section?.id || "";
    const surface = context.surface || {};
    const explicitChoiceSemantic = /radio|checkbox|option/.test(kind)
      ? semanticChoiceType(label)
      : "";
    // Consequence-bearing attestations outrank incidental profile words in
    // their prose. For example, legal copy can mention travelers' surnames;
    // that must not turn the checkbox into a last-name field.
    const fallbackSemantic = explicitChoiceSemantic === "legal_acceptance"
      ? explicitChoiceSemantic
      : fieldType || (/radio|checkbox|option/.test(kind) || presentationBinding
      ? explicitChoiceSemantic || semanticChoiceType(label)
      : (fieldSemantic !== "unknown" ? fieldSemantic : semanticChoiceType(label)));
    const ownedMeaning = resolveOwnedControlMeaning(ownedEvidence, fallbackSemantic, surface.type || "page");
    // Once an exclusive option owner has been reconstructed, broad label
    // parsing must not reintroduce prices from descriptive benefits or sibling
    // content. A missing exact option price remains unknown, not inherited.
    const structuredPrice = fieldType
      ? null
      : presentationBinding
        ? (presentationBinding.structuredPrice || null)
        : structuredPriceFromText(label);
    const choiceControl = Boolean(presentationBinding)
      || /radio|checkbox|option|choice/.test(`${kind || ""} ${ownedEvidence.role || ""} ${ownedEvidence.type || ""} ${fallbackSemantic || ""}`.toLowerCase());
    let physicalEffect = presentationBinding && Number(structuredPrice?.amount) === 0
      ? "select_free_option"
      : presentationBinding && Number(structuredPrice?.amount) > 0
        ? "select_paid_option"
        : presentationBinding?.advancesOnSelection
          ? "unknown"
          : ownedMeaning.physicalEffect === "unknown" && choiceControl && Number(structuredPrice?.amount) === 0
            ? "select_free_option"
            : ownedMeaning.physicalEffect === "unknown" && choiceControl && Number(structuredPrice?.amount) > 0
              ? "select_paid_option"
              : ownedMeaning.physicalEffect;
    if (surface.surfaceClass === "warning"
      && surfaceLooksLikeSeatSkip(surface)
      && /^(continue|next|proceed|go without|continue without)\b/i.test(label)) {
      physicalEffect = "dismiss_surface";
    }
    const semantic = explicitChoiceSemantic === "legal_acceptance"
      ? explicitChoiceSemantic
      : fieldType
      || (presentationBinding && Number(structuredPrice?.amount) === 0 ? "select_free_option" : "")
      || (presentationBinding && Number(structuredPrice?.amount) > 0 ? "add_paid_extra" : "")
      || ownedMeaning.semantic
      || fallbackSemantic
      || "unknown";
    const exactDecisionLabelType = presentationBinding
      ? sectionTypeFor(presentationBinding.ownerLabel || "", "")
      : "unknown";
    const exactDecisionSectionType = exactDecisionLabelType !== "unknown"
      ? exactDecisionLabelType
      : presentationBinding
        ? sectionTypeFor(
            "",
            compactText(presentationBinding.decisionOwner?.innerText || presentationBinding.decisionOwner?.textContent || "", 500)
          )
        : "unknown";
    const contextualDecisionSectionType = exactDecisionSectionType && exactDecisionSectionType !== "unknown"
      ? exactDecisionSectionType
      : contextualSectionType;
    // A proven profile-choice semantic owns its logical decision. The broad
    // visual section (for example "passenger") remains layout context only.
    const sectionType = presentationBinding && fieldType
      ? fieldType
      : contextualDecisionSectionType;
    const decisionLabel = presentationBinding && fieldType
      ? fieldType
      : (presentationBinding?.ownerLabel || sectionLabel);
    const surfaceDecisionGroupId = surface?.type && surface.type !== "page"
      ? (surface.decisionGroupId || decisionGroupIdForContext({ sectionType: surface.taskHint || surface.type || "", sectionLabel: surface.parentSectionLabel || surface.label || surface.taskHint || "" }))
      : "";
    const decisionGroupId = context.decisionGroupId || surfaceDecisionGroupId || decisionGroupIdForContext({
      sectionType,
      sectionLabel: decisionLabel,
      field: fieldType || context.field || "",
      instance: presentationBinding?.decisionInstance || ""
    });
    const members = [
      { element: stateElement, relation: "state" },
      { element: labelElement, relation: "label" },
      { element: wrapper, relation: "wrapper" },
      { element: presentationBinding?.optionOwner, relation: "option_owner" },
      { element: activationElement, relation: "activation" },
      { element, relation: "source" }
    ].filter((item) => item.element);
    const boxes = members.map((item) => isVisible(item.element) ? elementBox(item.element) : null).filter(Boolean);
    const state = controlStateForElement(stateElement, semantic, presentationBinding);
    const dateField = semantic === "date_of_birth" ? dateFieldEvidenceForElement(stateElement) : null;
    const phoneField = ["phone", "phone_country_code"].includes(fieldType)
      ? AGENT_CONTRACT?.inferPhoneFieldCodec?.({
          semanticType: fieldType,
          label,
          name: stateElement.getAttribute?.("name") || "",
          placeholder: stateElement.getAttribute?.("placeholder") || "",
          pattern: stateElement.getAttribute?.("pattern") || "",
          autocomplete: stateElement.getAttribute?.("autocomplete") || "",
          inputMode: stateElement.getAttribute?.("inputmode") || "",
          accessibleDescription: describedText(stateElement)
        }) || null
      : null;
    if (fieldType === "phone" && phoneField?.representation === "combined_international") {
      const rawPhoneValue = String(stateElement.value || stateElement.getAttribute?.("value") || "").trim();
      const phoneDigits = rawPhoneValue.replace(/\D/g, "");
      state.normalizedValue = phoneDigits
        ? `${rawPhoneValue.startsWith("+") ? "+" : ""}${phoneDigits}`
        : "";
    }
    const domRole = implicitRole(stateElement) || implicitRole(element);
    const stateTag = String(stateElement.tagName || "").toLowerCase();
    const baseStableKey = stableControlKeyForElement(element, stateElement, kind);
    const stableKey = presentationBinding
      ? [
          baseStableKey,
          `decision:${presentationBinding.ownerKey || presentationBinding.decisionInstance || ""}`,
          `option:${normalizeMatchText(label || presentationBinding.label || "")}`,
          `ordinal:${Math.max(0, Number(presentationBinding.optionIndex || 0))}`
        ].join("|")
      : baseStableKey;
    const identityHash = stableHash(stableKey);
    const controlId = `ctrl_${slugControlPart(kind).slice(0, 24)}_${identityHash}`.slice(0, 140);
    const profileChoiceOpener = fieldType === "phone_country_code"
      && (kind === "button" || domRole === "button")
      && /select|choose|country.*code|dial.*code|calling.*code/i.test(label || "");
    const selectLike = profileChoiceOpener || stateTag === "select"
      || ["combobox", "listbox"].includes(String(domRole || "").toLowerCase())
      || stateElement.getAttribute?.("aria-haspopup") === "listbox";
    let openTargetCandidates = selectLike
      ? operationActuatorCandidates(stateElement, element, activationElement, wrapper)
      : [];
    const rememberedChoiceBinding = selectLike ? choiceActuatorBindings.get(controlId) : null;
    const rememberedActuator = rememberedChoiceBinding
      ? elementById(rememberedChoiceBinding.actuatorId)
      : null;
    if (
      rememberedActuator
      && isVisible(rememberedActuator)
      && !isDisabledLike(rememberedActuator)
      && !openTargetCandidates.some((candidate) => candidate.nodeId === rememberedChoiceBinding.actuatorId)
    ) {
      openTargetCandidates = [
        {
          element: rememberedActuator,
          nodeId: rememberedChoiceBinding.actuatorId,
          sourceNodeId: rememberedChoiceBinding.actuatorId,
          score: 140,
          reason: "remembered-choice-actuator",
          role: implicitRole(rememberedActuator),
          tagName: String(rememberedActuator.tagName || "").toLowerCase(),
          box: elementBox(rememberedActuator),
          targetable: true,
          operationProven: true,
          proofEvidence: "previous_trusted_choice_actuator"
        },
        ...openTargetCandidates
      ];
    }
    const choiceObservation = selectLike
      ? observedChoiceOptionsForControl(stateElement, wrapper, { semantic, dateField })
      : { options: [], totalCount: 0, truncated: false, goalMatchedCount: 0 };
    const observedChoiceOptions = choiceObservation.options;
    const operations = controlOperationsForElement({
      element,
      stateElement,
      activationElement,
      controlRegion: wrapper,
      kind,
      role: domRole,
      state,
      profileChoiceOpener,
      openTargetCandidates,
      choiceActuatorCandidates: presentationBinding?.actuatorCandidates || []
    });
    const recovery = { open: null, select: null };
    for (const [operation, capability] of Object.entries(operations)) {
      if (!capability) continue;
      const actionabilityByActuator = Object.fromEntries((capability?.actuatorIds || []).map((nodeId) => {
        const candidate = (capability.candidates || []).find((item) => item.nodeId === nodeId);
        return [
          nodeId,
          actuatorActionability(elementById(nodeId), surface, operation, {
            operationProven: candidate?.operationProven !== false,
            operationProof: candidate?.proofEvidence || ""
          })
        ];
      }));
      const preferred = (capability?.actuatorIds || []).find((nodeId) => actionabilityByActuator[nodeId]?.executable)
        || (capability?.actuatorIds || []).find((nodeId) => actionabilityByActuator[nodeId]?.revealable)
        || capability?.actuatorIds?.[0]
        || "";
      capability.actuatorId = preferred;
      capability.actionabilityByActuator = actionabilityByActuator;
      capability.actionability = preferred
        ? actionabilityByActuator[preferred]
        : {
            rendered: false,
            visible: false,
            enabled: false,
            inViewport: false,
            inCurrentSurface: false,
            hitTested: false,
            notOccluded: false,
            operationAuthorized: true,
            executable: false,
            revealable: false,
            code: "CANONICAL_ACTUATOR_UNAVAILABLE",
            surfaceId: "",
            operation
          };
      const methods = operation === "type"
        ? ["direct_input"]
        : operation === "select"
          ? ["native_select"]
          : operation === "keyboard"
            ? ["focus_arrow_down"]
            : operation === "open"
              ? ["native_click"]
              : operation === "activate" && physicalEffect === "advance_checkout_stage"
              ? ["browser_trusted_input", "native_click"]
                : ["native_click", "pointer_sequence"];
      capability.strategies = (capability.actuatorIds || []).flatMap((actuatorId) => methods.map((method) => ({
        operation,
        actuatorId,
        method,
        actionType: method === "direct_input"
          ? "type"
          : method === "native_select"
            ? "select"
            : method.startsWith("focus_")
              ? "keypress"
              : "click",
        keys: method === "focus_arrow_down" ? "ArrowDown" : "",
        actionability: actionabilityByActuator[actuatorId],
        operationProven: actionabilityByActuator[actuatorId]?.operationProven === true,
        expectedOutcome: capability.expectedOutcome
      })));
    }
    if (selectLike && state.expanded !== true) {
      const regionBox = boundedLocalControlRegionBox(stateElement, wrapper);
      const recoveryTargets = openTargetCandidates
        .filter((candidate) => (
          candidate.targetable === true
          && (
            candidate.nodeId !== elementId(stateElement)
            || stateTag !== "select"
            || state.disabled !== true
          )
        ))
        .filter((candidate, index, list) => list.findIndex((item) => item.nodeId === candidate.nodeId) === index);
      if (regionBox || recoveryTargets.length) {
        const targetabilityByActuator = Object.fromEntries(recoveryTargets.map((candidate) => [
          candidate.nodeId,
          actuatorActionability(candidate.element || elementById(candidate.nodeId), surface, "open", {
            operationProven: false,
            operationProof: ""
          })
        ]));
        const unprovenDomClicks = recoveryTargets
          .filter((candidate) => candidate.operationProven !== true)
          .map((candidate) => ({
            operation: "open",
            actuatorId: candidate.nodeId,
            method: "native_click",
            actionType: "click",
            status: "unproven_experiment",
            operationProven: false,
            actionability: targetabilityByActuator[candidate.nodeId],
            evidence: "Exact targetable control-owned node without structural activation proof."
          }));
        const syntheticPointers = recoveryTargets.map((candidate) => ({
          operation: "open",
          actuatorId: candidate.nodeId,
          method: "pointer_sequence",
          actionType: "click",
          status: "unproven_experiment",
          operationProven: false,
          actionability: targetabilityByActuator[candidate.nodeId],
          evidence: "Synthetic pointer experiment on an exact targetable control-owned node."
        }));
        const keyboardStrategies = recoveryTargets.flatMap((candidate) => {
          const actuator = candidate.element || elementById(candidate.nodeId);
          if (!actuator?.matches?.("button, [tabindex], [role='button'], [role='combobox'], [role='listbox']")) return [];
          return [
            ["focus_enter", "Enter"],
            ["focus_space", "Space"],
            ["focus_arrow_down", "ArrowDown"]
          ].map(([method, keys]) => ({
            operation: "open",
            actuatorId: candidate.nodeId,
            method,
            actionType: "keypress",
            keys,
            status: "unproven_experiment",
            operationProven: false,
            actionability: targetabilityByActuator[candidate.nodeId],
            evidence: "Keyboard activation experiment on an exact focusable control-owned node."
          }));
        });
        const hasAtomicTrustedChoice = observedChoiceOptions.some((option) => (
          option.value
          || !/^(select|choose|month|day|year|title|nationality|gender)$/i.test(option.label)
        ))
          && recoveryTargets.length > 0;
        const trustedStrategies = hasAtomicTrustedChoice ? [] : recoveryTargets.map((candidate) => ({
          operation: "open",
          actuatorId: candidate.nodeId,
          method: "browser_trusted_input",
          actionType: "click",
          status: "unproven_experiment",
          operationProven: false,
          actionability: targetabilityByActuator[candidate.nodeId],
          evidence: "Governed browser-level trusted input on an exact targetable control-owned node."
        }));
        recovery.open = {
          operation: "open",
          status: "unproven",
          requiresVisualConfirmation: true,
          actuatorIds: recoveryTargets.map((candidate) => candidate.nodeId),
          targetabilityByActuator,
          strategies: [
            ...unprovenDomClicks,
            ...syntheticPointers,
            ...keyboardStrategies,
            ...trustedStrategies
          ],
          regions: !recoveryTargets.length && regionBox
            ? [normalizeVisualRegionContract(regionBox, {
                operation: "open",
                source: "select-like-control-region",
                surfaceId: surface.id || "",
                confidence: 0.95,
                evidence: "Exact visible region for a select-like control without a targetable DOM actuator."
              })]
            : []
        };
        if (hasAtomicTrustedChoice) {
          const choiceTargetabilityByActuator = Object.fromEntries(recoveryTargets.map((candidate) => [
            candidate.nodeId,
            actuatorActionability(candidate.element || elementById(candidate.nodeId), surface, "select", {
              operationProven: false,
              operationProof: ""
            })
          ]));
          recovery.select = {
            operation: "select",
            status: "unproven",
            requiresVisualConfirmation: true,
            actuatorIds: recoveryTargets.map((candidate) => candidate.nodeId),
            targetabilityByActuator: choiceTargetabilityByActuator,
            strategies: recoveryTargets.map((candidate) => ({
              operation: "select",
              actuatorId: candidate.nodeId,
              method: "browser_trusted_choice",
              actionType: "click",
              status: "unproven_experiment",
              operationProven: false,
              actionability: choiceTargetabilityByActuator[candidate.nodeId],
              evidence: "Atomic trusted choice on a visible select-like widget with an observed exact option."
            })),
            regions: []
          };
        }
      }
    }
    for (const [operation, capability] of Object.entries(operations)) {
      if (!capability) continue;
      for (const strategy of capability.strategies || []) {
        const candidate = (capability.candidates || []).find((item) => item.nodeId === strategy.actuatorId) || {};
        strategy.actuatorStableKey = [
          stableKey,
          operation,
          candidate.reason || "canonical-actuator",
          candidate.role || "",
          candidate.tagName || ""
        ].join("::");
      }
    }
    for (const [operation, recoveryStrategy] of Object.entries(recovery)) {
      if (!recoveryStrategy) continue;
      for (const strategy of recoveryStrategy.strategies || []) {
        const actuator = elementById(strategy.actuatorId);
        const candidate = openTargetCandidates.find((item) => item.nodeId === strategy.actuatorId) || {};
        strategy.actuatorStableKey = [
          stableKey,
          operation,
          candidate.reason || "visible-widget-experiment",
          implicitRole(actuator),
          String(actuator?.tagName || "").toLowerCase(),
          stableHash(stableControlKeyForElement(actuator, actuator, "actuator"))
        ].join("::");
      }
    }
    if (recovery.open?.regions?.length) {
      recovery.open.regions = recovery.open.regions.map((region) => normalizeVisualRegionContract(region, {
        controlId,
        operation: "open",
        source: "control.recovery.open",
        surfaceId: surface.id || ""
      }));
    }
    const interactionLadder = selectLike ? [
      {
        order: 1,
        operation: "select",
        method: "native_select",
        actuatorId: elementId(stateElement),
        status: operations.select?.actionability?.executable === true
          ? "proven_executable"
          : "unavailable",
        targetable: operations.select?.actionability?.targetable === true,
        operationProven: operations.select?.actionability?.operationProven === true
      },
      ...(operations.open?.strategies || []).map((strategy) => ({
        order: 2,
        operation: "open",
        method: strategy.method,
        actuatorId: strategy.actuatorId,
        status: strategy.actionability?.executable === true ? "proven_executable" : "recoverable",
        targetable: strategy.actionability?.targetable === true,
        operationProven: strategy.actionability?.operationProven === true
      })),
      ...(recovery.open?.strategies || []).map((strategy, index) => ({
        order: 3 + index,
        operation: "open",
        method: strategy.method,
        actuatorId: strategy.actuatorId,
        status: "unproven_experiment",
        targetable: strategy.actionability?.targetable === true,
        operationProven: false
      })),
      ...(recovery.open?.regions || []).map((region, index) => ({
        order: 3 + (recovery.open?.strategies || []).length + index,
        operation: "open",
        method: "visual_coordinate",
        actuatorId: "",
        visualRegion: region,
        status: "unproven_experiment",
        targetable: true,
        operationProven: false
      })),
      ...(recovery.select?.strategies || []).map((strategy) => ({
        order: 0,
        operation: "select",
        method: strategy.method,
        actuatorId: strategy.actuatorId,
        status: "unproven_experiment",
        targetable: strategy.actionability?.targetable === true,
        operationProven: false
      }))
    ].map((strategy, index) => ({ ...strategy, order: index + 1 })) : [];
    members.forEach((item) => {
      try {
        item.element.dataset.atwControlId = controlId;
      } catch (_) {
        // Some SVG/foreign elements may not expose dataset. They still remain in the graph.
      }
    });
    const operationMembers = Object.entries(operations)
      .flatMap(([operation, capability]) => (capability?.actuatorIds || []).map((nodeId) => ({
        element: elementById(nodeId),
        relation: `operation:${operation}`
      })))
      .filter((item) => item.element);
    const actuators = [...members, ...operationMembers]
      .map((item) => actuatorEntry(item.element, item.relation))
      .filter(Boolean)
      .filter((entry, index, list) => list.findIndex((other) => other.nodeId === entry.nodeId && other.relation === entry.relation) === index);
    const perceptionRole = perceptionRoleForControl(stateElement, kind, domRole, operations);
    const effectRole = canonicalDecisionEffectRole({
      label,
      accessibleName: accessibleName(stateElement) || accessibleName(element),
      ownText: ownedEvidence.ownText,
      ariaLabel: ownedEvidence.ariaLabel,
      title: ownedEvidence.title,
      semantic,
      physicalEffect,
      testId: ownedEvidence.testId,
      sectionLabel: context.sectionLabel || context.section?.label || "",
      kind,
      role: perceptionRole,
      domRole,
      inputType: stateElement.getAttribute?.("type") || "",
      structuredPrice,
      disabled: state.disabled === true,
      logicalDisabled: state.disabled === true && !Object.values(operations).some((capability) => (
        capability?.actionability?.executable === true
        || capability?.actionability?.revealable === true
      )),
      state
    });
    const economicStructuredPrice = NON_ECONOMIC_EFFECT_ROLES.has(effectRole) ? null : structuredPrice;
    const hasActionableActuator = Boolean(
      Object.values(operations).some((capability) => (
        capability?.actionability?.executable === true
        || capability?.actionability?.revealable === true
      ))
      || Object.values(recovery).some((capability) => (
        (capability?.strategies || []).some((strategy) => (
          strategy.actionability?.targetable === true
          && strategy.actionability?.visible === true
          && strategy.actionability?.enabled === true
        ))
        || (capability?.regions || []).some((region) => region?.inViewport !== false)
      ))
    );
    const renderedRepresentationMembers = members
      .filter((item) => item.relation !== "wrapper" && isVisible(item.element))
      .filter((item) => {
        const box = elementBox(item.element);
        return box.width > 0 && box.height > 0;
      });
    const representationLifecycle = {
      status: renderedRepresentationMembers.length || hasActionableActuator
        ? "active_rendered"
        : "dormant_hidden",
      active: Boolean(renderedRepresentationMembers.length || hasActionableActuator),
      stateRendered: isVisible(stateElement),
      renderedMemberIds: [...new Set(renderedRepresentationMembers.map((item) => elementId(item.element)).filter(Boolean))]
    };
    const visualRegion = unionBoxes(boxes) || elementBox(stateElement);
    const visualRegions = [
      visualRegion ? normalizeVisualRegionContract(visualRegion, {
        controlId,
        source: "control.visual_region",
        surfaceId: surface.id || ""
      }) : null,
      ...Object.entries(recovery).flatMap(([operation, strategy]) => (strategy?.regions || []).map((region) => (
        normalizeVisualRegionContract(region, {
          controlId,
          operation,
          source: `control.recovery.${operation}`,
          surfaceId: surface.id || ""
        })
      )))
    ].filter(Boolean);
    return {
      controlId,
      id: controlId,
      stableKey,
      meaning: semantic || label,
      label,
      accessibleName: accessibleName(stateElement) || accessibleName(element),
      testId: ownedEvidence.testId,
      formAction: ownedEvidence.formAction,
      formMethod: ownedEvidence.formMethod,
      formId: ownedEvidence.formId,
      ownText: ownedEvidence.ownText,
      ariaLabel: ownedEvidence.ariaLabel,
      title: ownedEvidence.title,
      iconOnly: ownedEvidence.iconOnly,
      kind,
      name: stateElement.getAttribute?.("name") || "",
      autocomplete: stateElement.getAttribute?.("autocomplete") || "",
      placeholder: stateElement.getAttribute?.("placeholder") || "",
      options: observedChoiceOptions,
      optionCount: choiceObservation.totalCount,
      optionsTruncated: choiceObservation.truncated,
      goalMatchedOptionCount: choiceObservation.goalMatchedCount,
      accessibleDescription: describedText(stateElement),
      fieldType,
      fieldClassification,
      role: perceptionRole,
      domRole,
      semantic,
      semanticIntent: semantic,
      physicalEffect: physicalEffect || "unknown",
      effectRole,
      economicEffect: NON_ECONOMIC_EFFECT_ROLES.has(effectRole) ? "none" : "decision_outcome",
      semanticConflict: ownedMeaning.conflict === true,
      risk: Number(economicStructuredPrice?.amount) > 0
        ? "money"
        : Number(economicStructuredPrice?.amount) === 0
          ? "safe"
          : effectRole === "scope_toggle"
            ? "safe"
            : choiceRisk(label),
      structuredPrice: economicStructuredPrice,
      dateField,
      phoneField,
      state,
      representationLifecycle,
      choiceContract: presentationBinding ? {
        decisionOwnerId: elementId(presentationBinding.decisionOwner),
        optionOwnerId: elementId(presentationBinding.optionOwner),
        stateControlId: elementId(stateElement),
        actuatorIds: (presentationBinding.actuatorCandidates || []).map((candidate) => candidate.nodeId).filter(Boolean),
        decisionInstance: presentationBinding.decisionInstance || "",
        decisionLabel: decisionLabel || "",
        optionSemantic: semantic,
        optionPhysicalEffect: physicalEffect || "unknown",
        structuredPrice: economicStructuredPrice || null,
        ownershipComplete: Boolean(
          presentationBinding.decisionOwner
          && presentationBinding.optionOwner
          && (presentationBinding.actuatorCandidates || []).length
        ),
        optionIndex: Number(presentationBinding.optionIndex || 0),
        optionCount: Number(presentationBinding.optionCount || 0),
        advancesOnSelection: presentationBinding.advancesOnSelection === true,
        required: presentationBinding.required === true,
        priceEvidenceSource: presentationBinding.priceEvidenceSource || "",
        exclusive: true,
        selectionInvariant: {
          selectedCount: Number(presentationBinding.selection?.selectedCount || 0),
          valid: presentationBinding.selection?.valid !== false
        }
      } : null,
      commitState: choiceInteractionStates.get(controlId) || null,
      sourceStateDisabled: state.disabled === true,
      logicalDisabled: state.disabled === true && !hasActionableActuator,
      hasActionableActuator,
      currentValue: state.selectedValue || state.normalizedValue || state.valueText || "",
      capabilities: observedCapabilities(operations, perceptionRole),
      operations,
      actionability: Object.fromEntries(Object.entries(operations)
        .filter(([, capability]) => Boolean(capability))
        .map(([operation, capability]) => [operation, capability.actionability])),
      interactionLadder,
      recovery,
      visualRegions,
      selected: Boolean(state.checked || state.selected),
      required: Boolean(state.required || context.required),
      decisionGroupId,
      sectionId,
      sectionType,
      sectionLabel,
      surfaceId: surface.id || "",
      surfaceType: surface.type || "page",
      surfaceLabel: surface.label || "",
      // A header/footer/sticky wrapper inside the active local checkout
      // surface is local task mechanics, never site-wide chrome. Broad
      // container shape may classify page controls only; otherwise a modal's
      // exact Continue/Skip actuator is admitted by TaskState and then
      // incorrectly discarded during mechanical binding.
      globalChrome: !(
        surface.type !== "page"
        && surface.blocksBackground === true
        && ["navigation", "free_decline"].includes(effectRole)
      ) && (isGlobalChromeControl(stateElement) || isGlobalChromeControl(element)),
      stateElementId: elementId(stateElement),
      visibleWidgetElementId: elementId(wrapper || activationElement || stateElement),
      preferredActivationElementId: elementId(activationElement || stateElement),
      actuators,
      visualRegion
    };
  }
  
  
  return Object.freeze({
    NON_ECONOMIC_EFFECT_ROLES,
    canonicalControlForElement,
    canonicalDecisionEffectRole,
    choiceLabel,
    choiceRisk,
    dateFieldEvidenceForElement,
    describedText,
    isAuxiliaryNavigationAction,
    isChoiceSelected,
    isGlobalChromeControl,
    isPlaceholderChoiceValue,
    labelElementForInput,
    meaningfulActionBox,
    normalizeVisualRegionContract,
    normalizedProfileChoiceValue,
    observedLocale,
    rememberChoiceVisualStateBeforeDispatch,
    sectionButtonModels,
    sectionChoiceInputs,
    sectionChoiceSelected,
    sectionFieldModels,
    sectionHasRequiredChoice,
    sectionTypeFor,
    selectedControlLabels,
    semanticChoiceType,
    slugControlPart,
    stableControlKeyForElement,
    stateElementForControl,
    unionBoxes,
    visualRegionContractsMatch,
    checkedFieldLabels
  });
}
