export function createFieldInteraction(dependencies) {
  const {
    filledFields,
    flashElement,
    isPaymentField,
    isVisible,
    labelText,
    logAgentEvent,
    normalizeMatchText,
    overlayChoiceText,
    queryAllDeep,
    recordAction,
    reportActionResult,
    setAgentActivity,
    settleAndHandleInterrupts,
    showAgentCursor,
    showAgentThought,
    sleep,
    traveler,
    travelerPhoneParts,
    userLikeClick,
    verifyAgentStep
  } = dependencies;

  function dispatchKey(input, key) {
    const code = key === " " ? "Space" : key;
    input.dispatchEvent(new KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { key, code, bubbles: true, cancelable: true }));
  }

  function currentElementValue(element) {
    if (!element) return "";
    if (element.type === "checkbox" || element.type === "radio") return element.checked ? "checked" : "";
    if (element.tagName === "SELECT") {
      const option = element.selectedOptions?.[0];
      return String(element.value || option?.textContent || "").trim();
    }
    if (element.getAttribute?.("role") === "combobox" || element.getAttribute?.("aria-haspopup") || element.matches?.("button, [role='button']")) {
      return (element.value || element.innerText || element.textContent || element.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
    }
    if (element.isContentEditable) return element.innerText || element.textContent || "";
    return element.value || "";
  }

  function normalizedValue(value, mode = "text") {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    if (mode === "digits" || mode === "country_code") return text.replace(/\D/g, "");
    return text.toLowerCase();
  }

  function valueMatches(element, expected, mode = "text") {
    const actual = normalizedValue(currentElementValue(element), mode);
    const wanted = normalizedValue(expected, mode);
    if (!wanted) return true;
    if (mode === "digits") return actual === wanted || actual.endsWith(wanted);
    if (mode === "country_code") return actual === wanted || actual.includes(wanted);
    return actual === wanted || actual.includes(wanted);
  }

  function setNativeElementValue(element, value) {
    if (element.isContentEditable) {
      element.textContent = value;
      return;
    }
    const proto = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : element instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : Object.getPrototypeOf(element);
    const descriptor = Object.getOwnPropertyDescriptor(proto, "value")
      || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")
      || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
    if (descriptor?.set) descriptor.set.call(element, value);
    else element.value = value;
  }

  function dispatchFieldEvents(element) {
    element.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: element.value || "" }));
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: element.value || "" }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function setSelectValue(select, values, exactOption = null) {
    const options = [...select.options];
    const wanted = values.map((value) => String(value || "").trim()).filter(Boolean);
    const exactSiteValue = String(exactOption?.siteValue || "").trim().toLowerCase();
    const exactLabel = normalizeMatchText(exactOption?.label || "");
    const uniqueMatch = (matches) => matches.length === 1 ? matches[0] : null;
    let option = exactSiteValue
      ? uniqueMatch(options.filter((item) => String(item.value || "").trim().toLowerCase() === exactSiteValue))
      : null;
    if (!option && exactLabel) {
      option = uniqueMatch(options.filter((item) => normalizeMatchText(item.textContent || item.label || "") === exactLabel));
    }
    if (!option && !exactOption) {
      for (const value of wanted) {
        const normalizedValue = value.toLowerCase();
        option = uniqueMatch(options.filter((item) => String(item.value || "").trim().toLowerCase() === normalizedValue));
        if (option) break;
      }
      if (!option) {
        for (const value of wanted) {
          const normalizedLabel = normalizeMatchText(value);
          option = uniqueMatch(options.filter((item) => normalizeMatchText(item.textContent || item.label || "") === normalizedLabel));
          if (option) break;
        }
      }
    }
    if (!option) return { ok: false, method: "select-option", reason: "No matching option" };
    showAgentCursor(select, `select ${option.textContent?.trim() || option.value}`);
    select.value = option.value;
    dispatchFieldEvents(select);
    flashElement(select);
    await sleep(120);
    const selected = select.options?.[select.selectedIndex] || null;
    return {
      ok: Boolean(
        selected
        && String(selected.value || "") === String(option.value || "")
        && normalizeMatchText(selected.textContent || selected.label || "") === normalizeMatchText(option.textContent || option.label || "")
      ),
      method: "select-option",
      value: currentElementValue(select),
      option: {
        value: String(option.value || ""),
        label: String(option.textContent || option.label || "").replace(/\s+/g, " ").trim()
      }
    };
  }

  function optionControlElement(option) {
    if (option.matches?.("input[type='checkbox'], input[type='radio']")) return option;
    return option.querySelector?.("input[type='checkbox'], input[type='radio']") || null;
  }

  function optionSelectedSignature(option, control) {
    if (control) {
      if (control.type === "checkbox" || control.type === "radio") return control.checked ? "checked" : "unchecked";
      const aria = control.getAttribute?.("aria-checked") || control.getAttribute?.("aria-selected");
      if (aria) return aria;
    }
    const optionAria = option.getAttribute?.("aria-checked") || option.getAttribute?.("aria-selected");
    if (optionAria) return optionAria;
    return option.className || "";
  }

  function optionControlCount(option) {
    if (!option?.querySelectorAll) return option?.matches?.("input[type='checkbox'], input[type='radio'], [role='checkbox'], [role='radio']") ? 1 : 0;
    return option.querySelectorAll("input[type='checkbox'], input[type='radio'], [role='checkbox'], [role='radio']").length;
  }

  function optionMatchText(option) {
    return (overlayChoiceText(option) || option?.innerText || option?.textContent || option?.value || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function optionMatchScore(option, wanted) {
    if (!option || !isVisible(option) || option.closest?.("#atw-sidebar")) return null;
    const text = optionMatchText(option);
    const normalized = normalizeMatchText(text);
    if (!normalized || !wanted.some((term) => normalized.includes(normalizeMatchText(term)))) return null;
    const rect = option.getBoundingClientRect();
    const controls = optionControlCount(option);
    const noExtra = /none of the passengers|none of the travellers|none of the travelers|no thanks|no thanks|without|decline|0 eur|0 €|0eur/i.test(text);
    let score = 100;
    if (option.matches?.("input[type='checkbox'], input[type='radio']")) score += 35;
    if (option.matches?.("label, [role='option'], li, [role='checkbox'], [role='radio']")) score += 25;
    if (/none of the passengers|none of the travellers|none of the travelers/i.test(text)) score += 160;
    if (/0\s*(eur|€|usd|\$)|free/i.test(text)) score += 80;
    if (/all passengers|all travellers|all travelers|passenger\s+\d|adult/i.test(text) && !/none/i.test(text)) score -= 200;
    if (/all passengers|passenger\s+\d|adult/i.test(text) && /none of the passengers|none of the travellers|none of the travelers/i.test(text)) score -= 240;
    if (controls > 1) score -= controls * 75;
    if (text.length > 180) score -= Math.min(260, Math.round((text.length - 180) / 2));
    if (rect.width > 420 || rect.height > 140) score -= 80;
    if (noExtra) score += 20;
    return { option, score, text };
  }

  function bestVisibleOptionForTerms(terms) {
    const wanted = terms.map((term) => String(term || "").toLowerCase()).filter((term) => term.length >= 2);
    return queryAllDeep("input[type='checkbox'], input[type='radio'], [role='checkbox'], [role='radio'], [role='option'], li, label, button, [data-headlessui-state]")
      .map((element) => optionMatchScore(element, wanted))
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)[0] || null;
  }

  async function selectComboboxOption(input, terms) {
    showAgentCursor(input, "open dropdown");
    userLikeClick(input);
    await sleep(220);
    dispatchKey(input, "ArrowDown");
    await sleep(180);
    const wanted = terms.map((term) => String(term || "").toLowerCase()).filter((term) => term.length >= 2);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const pick = bestVisibleOptionForTerms(wanted);
      if (pick?.option) {
        const option = pick.option;
        const control = optionControlElement(option);
        const before = optionSelectedSignature(option, control);
        const beforeInputValue = normalizedValue(currentElementValue(input), "country_code");
        showAgentCursor(option, pick.text || option.innerText || "option");
        userLikeClick(option);
        flashElement(option);
        await sleep(220);
        await settleAndHandleInterrupts("combobox option selected");

        let verified = control
          ? optionSelectedSignature(option, control) !== before
          : normalizedValue(currentElementValue(input), "country_code") !== beforeInputValue || valueMatches(input, terms[0], "country_code");

        if (!verified && control) {
          showAgentCursor(control, "retry: click checkbox directly");
          userLikeClick(control);
          await sleep(220);
          verified = optionSelectedSignature(option, control) !== before;
        }

        return {
          ok: verified,
          method: "combobox-option",
          value: currentElementValue(input),
          option: pick.text.slice(0, 160),
          reason: verified ? "" : "Clicked the option but its selected state did not change."
        };
      }
      await sleep(160);
    }
    dispatchKey(input, "Enter");
    await sleep(180);
    return { ok: valueMatches(input, terms[0], "country_code"), method: "combobox-enter", value: currentElementValue(input) };
  }

  function countrySearchTerms(split, t) {
    const numericCode = split.countryCode.replace(/\D/g, "");
    const countryNames = {
      "386": ["slovenia", "slovenija", "si"],
      "1": ["united states", "usa", "us", "canada"],
      "44": ["united kingdom", "uk", "gb", "great britain"]
    };
    return [
      split.countryCode,
      numericCode,
      ...(countryNames[numericCode] || []),
      t.nationality,
      t.country,
      t.country_code,
      t.address_country
    ].filter(Boolean);
  }

  function controlText(element) {
    if (!element) return "";
    return [currentElementValue(element), element.innerText, element.textContent, element.getAttribute("aria-label")]
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isCountryCodeCandidate(input, localInput) {
    if (!input || input === localInput || isPaymentField(input)) return false;
    const text = `${labelText(input)} ${controlText(input)}`;
    const value = String(input.value || "");
    const role = input.getAttribute("role") || "";
    const localRect = localInput?.getBoundingClientRect?.();
    const rect = input.getBoundingClientRect();
    const nearPhone = localRect
      ? Math.abs(rect.top - localRect.top) < 130 && rect.left <= localRect.left + 40
      : false;
    const codeLikeValue = /^\s*\+\d{1,4}/.test(value);
    const comboLike = role === "combobox" || input.getAttribute("aria-autocomplete") || /combobox|country|dial|calling/i.test(text);
    return codeLikeValue || comboLike || nearPhone && /country|code|\+\d|headlessui/i.test(text || input.id || input.name || "");
  }

  function countryCodeCandidates(localInput) {
    const controls = queryAllDeep("input, select, button, [role='button'], [role='combobox'], [aria-haspopup='listbox']")
      .filter((element) => !element.closest("#atw-sidebar") && !element.disabled && isVisible(element));
    const localRect = localInput?.getBoundingClientRect?.();
    return controls
      .filter((element) => {
        if (element === localInput || isPaymentField(element)) return false;
        if (element.tagName === "INPUT" || element.tagName === "SELECT") return isCountryCodeCandidate(element, localInput);
        const rect = element.getBoundingClientRect();
        const text = controlText(element).toLowerCase();
        const nearPhone = localRect
          ? Math.abs(rect.top - localRect.top) < 95 && rect.left < localRect.left && rect.right <= localRect.left + 36
          : false;
        return nearPhone && (/^\s*\+\d/.test(text) || /country|code|calling|dial/.test(text));
      });
  }

  function findPhoneCountryInput(map, localInput) {
    const explicit = map.fields.find((field) => field.field === "phone_country_code" && field.element);
    if (explicit) return explicit.element;
    const candidates = countryCodeCandidates(localInput);
    if (!candidates.length) return null;
    const localRect = localInput?.getBoundingClientRect?.();
    return candidates
      .map((input) => {
        const rect = input.getBoundingClientRect();
        const text = `${labelText(input)} ${controlText(input)}`;
        let score = 0;
        if (/country|dial|calling|phone country/i.test(text)) score += 20;
        if (/^\s*\+\d{1,4}/.test(controlText(input))) score += 18;
        if (input.tagName === "BUTTON" || input.getAttribute("role") === "button") score += 8;
        if (input.getAttribute("role") === "combobox" || input.getAttribute("aria-autocomplete")) score += 12;
        if (/headlessui-combobox/i.test(input.id || input.name || "")) score += 10;
        if (localRect) {
          if (Math.abs(rect.top - localRect.top) < 90) score += 16;
          if (rect.left < localRect.left) score += 8;
          score -= Math.abs(rect.top - localRect.top) / 40;
        }
        return { input, score };
      })
      .sort((a, b) => b.score - a.score)[0]?.input || null;
  }

  function countryOptionScore(element, terms) {
    const text = controlText(element).toLowerCase();
    if (!text || text.length > 220) return 0;
    const normalizedTerms = terms.map((term) => String(term || "").toLowerCase()).filter(Boolean);
    let score = 0;
    for (const term of normalizedTerms) {
      if (!term) continue;
      if (text === term) score += 40;
      else if (text.includes(term)) score += term.startsWith("+") ? 32 : 18;
    }
    if (/slovenia|slovenija/.test(text)) score += 30;
    if (/\+386|386/.test(text)) score += 26;
    if (/guernsey|jersey|\+44-?1481|\+44-?1534/.test(text)) score -= 50;
    return score;
  }

  async function selectCountryCodeControl(control, terms, split) {
    if (!control) return { ok: false, method: "country-control", value: "" };
    if (control.tagName === "SELECT") return setSelectValue(control, terms);
    setAgentActivity(`Selecting ${split.countryCode}`, "Opening country code selector");
    showAgentCursor(control, `Select ${split.countryCode}`, "Open country code menu");
    flashElement(control);
    userLikeClick(control);
    await sleep(260);
    if (control.tagName === "INPUT") {
      try {
        setNativeElementValue(control, terms.find((term) => /[a-z]/i.test(term)) || split.countryCode);
        dispatchFieldEvents(control);
        await sleep(220);
      } catch (error) {
        logAgentEvent("country_code_type_failed", { error: error.message });
      }
    }
    const option = queryAllDeep("[role='option'], li, button, [data-headlessui-state], [aria-selected], div")
      .filter((element) => isVisible(element) && !element.closest("#atw-sidebar"))
      .map((element) => ({ element, score: countryOptionScore(element, terms) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)[0]?.element || null;
    if (option) {
      showAgentCursor(option, `Choose ${split.countryCode}`, controlText(option).slice(0, 90));
      flashElement(option);
      userLikeClick(option);
      await sleep(420);
      await settleAndHandleInterrupts("country code selected");
    } else if (control.tagName === "INPUT") {
      dispatchKey(control, "Enter");
      await sleep(260);
      await settleAndHandleInterrupts("country code entered");
    }
    const value = controlText(control);
    const ok = normalizedValue(value, "country_code").includes(split.countryCode.replace(/\D/g, "")) || Boolean(option);
    return { ok, method: option ? "country-option-click" : "country-input-enter", value, option: controlText(option).slice(0, 120) };
  }

  async function fillPhoneFieldsFromMap(map) {
    const t = traveler();
    const split = travelerPhoneParts(t);
    if (!split.local && !split.countryCode) return 0;

    const phoneFields = map.fields.filter((field) => field.field === "phone" && field.element);
    const localField = phoneFields.find((field) => !/country|dial|calling/i.test(field.label)) || phoneFields[0];
    const localInput = localField?.element || null;
    let count = 0;

    const countryInput = findPhoneCountryInput(map, localInput);
    if (countryInput && split.countryCode) {
      const terms = countrySearchTerms(split, t);
      const result = countryInput.tagName === "SELECT"
        ? await setSelectValue(countryInput, terms)
        : (countryInput.tagName === "INPUT" || countryInput.tagName === "TEXTAREA")
          ? await (async () => {
            const fillResult = await setFieldValue(countryInput, split.countryCode, { fieldType: "phone_country_code", compareMode: "country_code" });
            const optionResult = await selectComboboxOption(countryInput, terms);
            return optionResult.ok ? optionResult : fillResult;
          })()
          : await selectCountryCodeControl(countryInput, terms, split);
      if (result.ok) {
        filledFields.push({
          fieldType: "phone_country_code",
          selector: countryInput.name || countryInput.id || countryInput.tagName.toLowerCase(),
          confidence: 0.88
        });
        count += 1;
      }
      setAgentActivity(result.ok ? `Country code ${split.countryCode} accepted` : `Country code ${split.countryCode} not accepted`, result.ok ? "Now checking the local phone number" : "Will rescan the phone selector");
      await reportActionResult({
        type: "phone_country_code",
        action: "select_country_code",
        fieldType: "phone_country_code",
        target: countryInput.name || countryInput.id || countryInput.tagName.toLowerCase(),
        ok: result.ok,
        message: result.ok ? `Country code ${split.countryCode} accepted.` : `Country code ${split.countryCode} did not stick.`,
        payload: {
          method: result.method,
          value: result.value,
          option: result.option
        }
      });
      const interrupt = await settleAndHandleInterrupts("phone country code");
      if (interrupt.blocked && !interrupt.handled) return count;
    }

    if (localInput && split.local) {
      const current = String(localInput.value || "").replace(/\D/g, "");
      if (current !== split.local) {
        const result = await setFieldValue(localInput, split.local, { fieldType: "phone", compareMode: "digits" });
        if (result.ok) {
          filledFields.push({
            fieldType: "phone",
            selector: localInput.name || localInput.id || localInput.tagName.toLowerCase(),
            confidence: localField?.confidence || 0.9
          });
          count += 1;
        }
      }
    }

    const interrupt = await settleAndHandleInterrupts("phone fields");
    if (interrupt.blocked && !interrupt.handled) return count;

    if (count) {
      logAgentEvent("phone_fill", {
        countryCode: split.countryCode,
        localDigits: split.local.length,
        countryControl: countryInput ? countryInput.name || countryInput.id || countryInput.tagName.toLowerCase() : "",
        localControl: localInput ? localInput.name || localInput.id || localInput.tagName.toLowerCase() : ""
      });
    }
    return count;
  }

  async function typeWithFallback(element, value) {
    showAgentCursor(element, `type ${String(value).slice(0, 12)}`);
    userLikeClick(element);
    await sleep(80);
    element.focus({ preventScroll: true });
    if (typeof element.select === "function") element.select();
    setNativeElementValue(element, "");
    dispatchFieldEvents(element);
    await sleep(180);
    for (const char of String(value)) {
      setNativeElementValue(element, `${element.value || ""}${char}`);
      element.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: char }));
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: char }));
      await sleep(45);
    }
    element.dispatchEvent(new Event("change", { bubbles: true }));
    element.blur?.();
    await sleep(360);
  }

  async function setFieldValue(element, value, options = {}) {
    const mode = options.compareMode || "text";
    const fieldType = options.fieldType || "unknown";
    const fieldLabel = fieldType.replace(/_/g, " ");
    const expected = String(value || "");
    const resolveLiveElement = typeof options.resolveLiveElement === "function"
      ? options.resolveLiveElement
      : () => element;
    const reportLocalResult = options.reportResult !== false;
    const reportFieldResult = async (payload) => {
      if (reportLocalResult) await reportActionResult(payload);
    };
    const result = {
      ok: false,
      fieldType,
      selector: element?.name || element?.id || element?.tagName?.toLowerCase() || "",
      expected: mode === "digits" ? expected.replace(/\D/g, "").length : expected.slice(0, 80),
      method: "",
      actual: ""
    };
    if (!element || !expected) {
      result.method = "skipped";
      result.reason = "Missing element or value";
      recordAction("field_fill", result);
      setAgentActivity(result.ok ? `${fieldLabel} accepted` : `${fieldLabel} not accepted`, result.ok ? "Moving to the next required item" : "Will rescan and recover");
      await verifyAgentStep(element, "Field", result.ok ? `${fieldLabel} accepted` : `${fieldLabel} not accepted`, result.ok, 700);
      await reportFieldResult({
        type: "field_fill",
        action: "fill_text",
        fieldType,
        target: result.selector,
        ok: false,
        message: result.reason
      });
      return result;
    }

    await showAgentThought(element, "Field", `Filling ${fieldLabel}`, "Using saved traveler profile, then verifying the value sticks.", 900);
    flashElement(element);

    if (element.tagName === "SELECT") {
      const selectResult = await setSelectValue(element, [expected], options.exactOption || null);
      result.ok = selectResult.ok;
      result.method = selectResult.method;
      result.actual = selectResult.value || currentElementValue(element);
      recordAction("field_fill", result);
      await reportFieldResult({
        type: "field_fill",
        action: "select_dropdown",
        fieldType,
        target: result.selector,
        ok: result.ok,
        message: result.ok ? `${fieldLabel} accepted.` : `${fieldLabel} did not accept the selected option.`
      });
      return result;
    }

    try {
      element.focus({ preventScroll: true });
      setNativeElementValue(element, expected);
      dispatchFieldEvents(element);
      element.blur?.();
      await sleep(520);
      const liveElement = resolveLiveElement() || element;
      if (valueMatches(liveElement, expected, mode)) {
        element = liveElement;
        result.ok = true;
        result.method = "native-setter";
        result.actual = currentElementValue(element);
        recordAction("field_fill", result);
        setAgentActivity(`${fieldLabel} accepted`, "Moving to the next required item");
        await verifyAgentStep(element, "Field", `${fieldLabel} accepted`, true, 700);
        await reportFieldResult({
          type: "field_fill",
          action: "fill_text",
          fieldType,
          target: result.selector,
          ok: true,
          message: `${fieldLabel} accepted.`
        });
        return result;
      }
    } catch (error) {
      result.reason = error.message;
    }

    try {
      element = resolveLiveElement() || element;
      await typeWithFallback(element, expected);
      element = resolveLiveElement() || element;
      result.ok = valueMatches(element, expected, mode);
      result.method = "clear-and-type";
      result.actual = currentElementValue(element);
      recordAction("field_fill", result);
      setAgentActivity(result.ok ? `${fieldLabel} accepted` : `${fieldLabel} not accepted`, result.ok ? "Moving to the next required item" : "Will rescan and recover");
      await reportFieldResult({
        type: "field_fill",
        action: "fill_text",
        fieldType,
        target: result.selector,
        ok: result.ok,
        message: result.ok ? `${fieldLabel} accepted.` : `${fieldLabel} did not keep the typed value.`
      });
      return result;
    } catch (error) {
      result.ok = false;
      result.method = "clear-and-type";
      result.reason = error.message;
      result.actual = currentElementValue(element);
      recordAction("field_fill", result);
      await reportFieldResult({
        type: "field_fill",
        action: "fill_text",
        fieldType,
        target: result.selector,
        ok: false,
        message: error.message
      });
      return result;
    }
  }


  return {
    bestVisibleOptionForTerms,
    controlText,
    countryCodeCandidates,
    countryOptionScore,
    countrySearchTerms,
    currentElementValue,
    dispatchFieldEvents,
    dispatchKey,
    fillPhoneFieldsFromMap,
    findPhoneCountryInput,
    isCountryCodeCandidate,
    normalizedValue,
    optionControlCount,
    optionControlElement,
    optionMatchScore,
    optionMatchText,
    optionSelectedSignature,
    selectComboboxOption,
    selectCountryCodeControl,
    setFieldValue,
    setNativeElementValue,
    setSelectValue,
    typeWithFallback,
    valueMatches
  };
}
