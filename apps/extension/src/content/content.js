(async function bootAirTravelWallet() {
  if (document.getElementById("atw-sidebar")) return;

  const DEFAULT_API = "http://localhost:4173/api";
  const BAGGAGE_TERMS = ["no cabin bag", "baggage not included", "personal item only", "without baggage", "checked baggage not included"];
  const MULTI_AIRPORT_CODES = new Set(["LHR", "LGW", "LTN", "STN", "LCY", "CDG", "ORY", "BVA", "IST", "SAW"]);
  const FIELD_MATCHERS = {
    confirm_email: ["confirm email", "confirm e-mail", "repeat email", "repeat e-mail"],
    first_name: ["first", "given", "forename"],
    last_name: ["last", "surname", "family"],
    date_of_birth: ["birth", "date of birth", "dob"],
    title: ["title", "salutation", "mr", "mrs", "ms"],
    nationality: ["nationality", "citizenship"],
    passport_number: ["passport", "document number", "travel document"],
    passport_expiry: ["expiry", "expiration"],
    billing_company: ["billing company", "invoice company", "company name", "legal name"],
    billing_tax_id: ["tax id", "vat", "tax number"],
    billing_email: ["billing email", "invoice email"],
    billing_address: ["billing address", "invoice address"],
    email: ["email"],
    phone_country_code: ["country code", "country dial", "dial code", "calling code", "phone country"],
    phone: ["phone", "mobile", "telephone"]
  };
  const PAYMENT_TERMS = ["card", "cvc", "cvv", "security code", "payment", "cc-number", "cc-csc"];
  const VALIDATION_TERMS = [
    "required",
    "must enter",
    "too long",
    "too short",
    "invalid",
    "not valid",
    "confirm",
    "missing",
    "error"
  ];

  let appData = null;
  let selectedTravelerId = null;
  let filledFields = [];
  let warnings = [];
  let renderTimer = null;
  let elementIdCounter = 0;
  let agent = {
    running: false,
    sessionId: "",
    awaiting: "",
    messages: [],
    lastClickSignature: "",
    repeatClickCount: 0,
    skipPaidExtrasApproved: false,
    skipRoutineRunning: false,
    pendingUserMessage: "",
    currentAction: "",
    currentReason: "",
    actionHistory: [],
    debugLog: [],
    pageMap: null
  };

  function storageGet(keys) {
    return chrome.storage.local.get(keys);
  }

  async function fetchData() {
    const settings = await storageGet(["apiBase", "selectedTravelerId"]);
    const apiBase = settings.apiBase || DEFAULT_API;
    const response = await fetch(`${apiBase}/extension/bootstrap`);
    if (!response.ok) throw new Error("Could not connect to dashboard API");
    appData = await response.json();
    selectedTravelerId = settings.selectedTravelerId || appData.preferences?.selected_traveler_id || appData.travelers[0]?.id;
    return { apiBase };
  }

  function traveler() {
    return appData.travelers.find((item) => item.id === selectedTravelerId) || appData.travelers[0];
  }

  function travelerRules() {
    return traveler()?.booking_rules || "";
  }

  function prefersNoPaidExtras() {
    const t = traveler();
    return /no paid|no extras|no add-?ons|no add ons|no seat|no insurance|no bundle|personal item only|avoid paid/i.test(travelerRules())
      || /personal item|no checked|no bag|no baggage/i.test(t?.baggage_preference || "");
  }

  function setAgentActivity(action, reason = "") {
    agent.currentAction = action;
    agent.currentReason = reason;
    const cursor = document.getElementById("atw-agent-cursor");
    if (cursor) {
      cursor.dataset.action = action ? action.slice(0, 48) : "working";
      cursor.dataset.reason = reason ? reason.slice(0, 120) : "";
    }
  }

  function labelText(input) {
    const direct = input.closest("label")?.innerText || "";
    const idLabel = input.id ? queryAllDeep(`label[for="${CSS.escape(input.id)}"]`)[0]?.innerText || "" : "";
    const labelledBy = (input.getAttribute("aria-labelledby") || "")
      .split(/\s+/)
      .map((id) => id && document.getElementById(id)?.innerText)
      .filter(Boolean)
      .join(" ");
    const primary = [input.name, input.id, input.placeholder, input.getAttribute("aria-label"), input.getAttribute("aria-describedby"), direct, idLabel, labelledBy].filter(Boolean).join(" ");
    const usefulPrimary = primary.replace(/headlessui|combobox|input|select|field|control|react|aria|describedby|labelledby|[-_\d]/gi, " ").replace(/\s+/g, " ").trim();
    const nearby = [input.parentElement, input.parentElement?.parentElement]
      .map((element) => (element?.innerText || "").replace(/\s+/g, " ").trim())
      .filter((text) => text && text.length < 260)
      .join(" ");
    return [primary, usefulPrimary.length < 4 ? nearby : ""].filter(Boolean).join(" ").toLowerCase();
  }

  function localLabelText(input) {
    const direct = input.closest("label")?.innerText || "";
    const idLabel = input.id ? queryAllDeep(`label[for="${CSS.escape(input.id)}"]`)[0]?.innerText || "" : "";
    const labelledBy = (input.getAttribute("aria-labelledby") || "")
      .split(/\s+/)
      .map((id) => id && document.getElementById(id)?.innerText)
      .filter(Boolean)
      .join(" ");
    return [
      input.name,
      input.id,
      input.placeholder,
      input.getAttribute("aria-label"),
      direct,
      idLabel,
      labelledBy
    ].filter(Boolean).join(" ").replace(/\s+/g, " ").toLowerCase();
  }

  function inferCheckoutSite() {
    const host = location.hostname.toLowerCase();
    if (host.includes("gotogate")) return "gotogate";
    if (host.includes("croatiaairlines")) return "croatia-airlines";
    if (host.includes("skyscanner")) return "skyscanner";
    if (host.includes("localhost")) return "demo";
    return "generic";
  }

  function isPaymentField(input) {
    const text = labelText(input);
    return input.type === "password" || PAYMENT_TERMS.some((term) => text.includes(term));
  }

  function candidateInputs() {
    return queryAllDeep("input, select, textarea")
      .filter((input) => {
        const comboboxLike = input.getAttribute("role") === "combobox" || input.getAttribute("aria-autocomplete") || /combobox/i.test(input.id || input.name || "");
        return !input.closest("#atw-sidebar") && !input.disabled && (!input.readOnly || comboboxLike) && isVisible(input) && !isPaymentField(input);
      });
  }

  function detectField(input) {
    const text = labelText(input);
    const localText = localLabelText(input);
    if (/confirm.*e-?mail|repeat.*e-?mail/.test(localText)) return { field: "confirm_email", confidence: 0.95 };
    if (/\bsurname\b|family.?name|last.?name/.test(localText)) return { field: "last_name", confidence: 0.93 };
    if (/first.*middle|first.?name|given.?name|forename/.test(localText)) return { field: "first_name", confidence: 0.93 };
    if (/mobile|phone|telephone/.test(localText) && !/country|dial|calling/.test(localText)) return { field: "phone", confidence: 0.92 };
    if (/country.*code|dial.*code|calling.*code/.test(localText)) return { field: "phone_country_code", confidence: 0.9 };
    if (/\be-?mail\b/.test(localText)) return { field: "email", confidence: 0.9 };
    if (/birth|dob/.test(localText)) return { field: "date_of_birth", confidence: 0.9 };
    if (/nationality|citizenship/.test(localText)) return { field: "nationality", confidence: 0.9 };
    let best = null;
    for (const [field, terms] of Object.entries(FIELD_MATCHERS)) {
      const score = terms.reduce((total, term) => total + (text.includes(term) ? 1 : 0), 0);
      if (score && (!best || score > best.score)) best = { field, score };
    }
    return best ? { field: best.field, confidence: Math.min(0.95, 0.55 + best.score * 0.18) } : null;
  }

  function bookingDetected() {
    const matches = candidateInputs().map(detectField).filter(Boolean);
    const step = classifyStep(`${location.href} ${primaryPageText()} ${visiblePageText().slice(0, 1200)}`);
    const checkoutCopy = /checkout|traveller information|traveler information|configure your trip|select baggage|seat selection|payment|booking confirmed/i.test(visiblePageText());
    return matches.length >= 3 || step !== "unknown" || checkoutCopy;
  }

  function travelerValue(field) {
    const t = traveler();
    const values = {
      confirm_email: t.email,
      first_name: t.first_name,
      last_name: t.last_name,
      date_of_birth: t.date_of_birth,
      title: titleValue(t),
      nationality: t.nationality,
      passport_number: t.document?.document_number || "",
      passport_expiry: t.document?.expiry_date || "",
      billing_company: t.invoice_company || "",
      billing_tax_id: t.billing_tax_id || "",
      billing_email: t.billing_email || t.email,
      billing_address: t.billing_address || "",
      email: t.email,
      phone_country_code: travelerPhoneParts(t).countryCode,
      phone: travelerPhoneParts(t).local || phoneValueForField(t.phone)
    };
    return values[field] || "";
  }

  function titleValue(t) {
    const gender = String(t.gender || "").toLowerCase();
    if (gender.includes("female") || gender === "f") return "Mrs/Ms";
    if (gender.includes("male") || gender === "m") return "Mr";
    return "";
  }

  function splitPhone(phone) {
    const raw = String(phone || "").trim();
    const digits = raw.replace(/\D/g, "");
    if (!digits) return { countryCode: "", local: "" };
    if (raw.startsWith("+1") && digits.startsWith("1")) return { countryCode: "+1", local: digits.slice(1) };
    if (raw.startsWith("+386") && digits.startsWith("386")) return { countryCode: "+386", local: digits.slice(3) };
    if (raw.startsWith("+44") && digits.startsWith("44")) return { countryCode: "+44", local: digits.slice(2) };
    return { countryCode: "", local: digits };
  }

  function countryCodeFromTraveler(t) {
    const text = [t.nationality, t.country, t.country_code, t.address_country].filter(Boolean).join(" ").toLowerCase();
    if (/slovenia|slovenija|\bsi\b/.test(text)) return "+386";
    if (/united states|usa|\bus\b|canada/.test(text)) return "+1";
    if (/united kingdom|\buk\b|\bgb\b|great britain/.test(text)) return "+44";
    return "";
  }

  function travelerPhoneParts(t = traveler()) {
    const split = splitPhone(t.phone);
    return {
      countryCode: split.countryCode || countryCodeFromTraveler(t),
      local: split.local
    };
  }

  function phoneValueForField(phone) {
    const split = splitPhone(phone);
    return split.local || splitPhone(phone).local;
  }

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
      return [element.value, option?.textContent || ""].filter(Boolean).join(" ");
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

  async function setSelectValue(select, values) {
    const wanted = values.map((value) => String(value || "").toLowerCase()).filter(Boolean);
    const option = [...select.options].find((item) => {
      const text = [item.value, item.textContent].join(" ").toLowerCase();
      return wanted.some((value) => text.includes(value));
    });
    if (!option) return { ok: false, method: "select-option", reason: "No matching option" };
    showAgentCursor(select, `select ${option.textContent?.trim() || option.value}`);
    select.value = option.value;
    dispatchFieldEvents(select);
    flashElement(select);
    await sleep(120);
    return {
      ok: wanted.some((value) => currentElementValue(select).toLowerCase().includes(value)),
      method: "select-option",
      value: currentElementValue(select)
    };
  }

  async function selectComboboxOption(input, terms) {
    dispatchKey(input, "ArrowDown");
    await sleep(180);
    const wanted = terms.map((term) => String(term || "").toLowerCase()).filter((term) => term.length >= 2);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const option = queryAllDeep("[role='option'], li, button, [data-headlessui-state]")
        .filter((element) => isVisible(element) && !element.closest("#atw-sidebar"))
        .find((element) => {
          const text = (element.innerText || element.textContent || element.value || "").replace(/\s+/g, " ").toLowerCase();
          return wanted.some((term) => text.includes(term));
        });
      if (option) {
        showAgentCursor(option, option.innerText || "country code");
        userLikeClick(option);
        flashElement(option);
        await sleep(220);
        return { ok: true, method: "combobox-option", value: currentElementValue(input), option: (option.innerText || "").slice(0, 120) };
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
    } else if (control.tagName === "INPUT") {
      dispatchKey(control, "Enter");
      await sleep(260);
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
      reportActionResult({
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
    element.focus();
    if (typeof element.select === "function") element.select();
    setNativeElementValue(element, "");
    dispatchFieldEvents(element);
    await sleep(50);
    for (const char of String(value)) {
      setNativeElementValue(element, `${element.value || ""}${char}`);
      element.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: char }));
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: char }));
      await sleep(8);
    }
    element.dispatchEvent(new Event("change", { bubbles: true }));
    element.blur?.();
    await sleep(120);
  }

  async function setFieldValue(element, value, options = {}) {
    const mode = options.compareMode || "text";
    const fieldType = options.fieldType || "unknown";
    const expected = String(value || "");
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
      reportActionResult({
        type: "field_fill",
        action: "fill_text",
        fieldType,
        target: result.selector,
        ok: false,
        message: result.reason
      });
      return result;
    }

    element.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
    await sleep(120);
    const fieldLabel = fieldType.replace(/_/g, " ");
    setAgentActivity(`Filling ${fieldLabel}`, "Checking saved traveler profile");
    showAgentCursor(element, `Filling ${fieldLabel}`, "From saved traveler profile");
    flashElement(element);

    if (element.tagName === "SELECT") {
      const selectResult = await setSelectValue(element, [expected]);
      result.ok = selectResult.ok;
      result.method = selectResult.method;
      result.actual = selectResult.value || currentElementValue(element);
      recordAction("field_fill", result);
      reportActionResult({
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
      element.focus();
      setNativeElementValue(element, expected);
      dispatchFieldEvents(element);
      element.blur?.();
      await sleep(160);
      if (valueMatches(element, expected, mode)) {
        result.ok = true;
        result.method = "native-setter";
        result.actual = currentElementValue(element);
        recordAction("field_fill", result);
        setAgentActivity(`${fieldLabel} accepted`, "Moving to the next required item");
        reportActionResult({
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
      await typeWithFallback(element, expected);
      result.ok = valueMatches(element, expected, mode);
      result.method = "clear-and-type";
      result.actual = currentElementValue(element);
      recordAction("field_fill", result);
      setAgentActivity(result.ok ? `${fieldLabel} accepted` : `${fieldLabel} not accepted`, result.ok ? "Moving to the next required item" : "Will rescan and recover");
      reportActionResult({
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
      reportActionResult({
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

  async function fillTravelerDetails(options = {}) {
    filledFields = [];
    const used = new Set();
    fillTitleRadio();
    await fillPhoneFieldsFromMap(buildPageMap());
    for (const input of candidateInputs()) {
      const detected = detectField(input);
      if (!detected || used.has(detected.field)) continue;
      if (detected.field === "phone" || detected.field === "phone_country_code") continue;
      if (input.type === "radio" || input.type === "checkbox") continue;
      const value = travelerValue(detected.field);
      if (!value) continue;
      const result = await setFieldValue(input, value, { fieldType: detected.field });
      if (!result.ok) continue;
      used.add(detected.field);
      filledFields.push({
        fieldType: detected.field,
        selector: input.name || input.id || input.tagName.toLowerCase(),
        confidence: detected.confidence
      });
    }
    warnings = runRiskChecks();
    if (!options.silent) renderSidebar("filled");
  }

  function fillTitleRadio() {
    const title = travelerValue("title");
    if (!title) return false;
    const radios = [...document.querySelectorAll("input[type='radio']")].filter((radio) => !radio.disabled && isVisible(radio));
    const match = radios.find((radio) => {
      const text = labelText(radio);
      if (title === "Mr") return /\bmr\b/.test(text);
      return text.includes("mrs") || text.includes("ms") || text.includes("mrs/ms");
    });
    if (!match) return false;
    showAgentCursor(match);
    match.click();
    flashElement(match);
    setAgentActivity("Title accepted", "Moving to passenger names");
    filledFields.push({
      fieldType: "title",
      selector: match.name || match.id || "radio",
      confidence: 0.8
    });
    return true;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function addAgentMessage(role, text) {
    agent.messages.push({ role, text });
    agent.messages = agent.messages.slice(-8);
  }

  function logAgentEvent(type, payload = {}) {
    agent.debugLog.push({
      at: new Date().toISOString(),
      type,
      payload
    });
    agent.debugLog = agent.debugLog.slice(-80);
  }

  function recordAction(type, payload = {}) {
    agent.actionHistory.push({
      at: new Date().toISOString(),
      type,
      payload
    });
    agent.actionHistory = agent.actionHistory.slice(-40);
    logAgentEvent(type, payload);
  }

  async function startAgentSession() {
    try {
      const settings = await storageGet(["apiBase"]);
      const response = await fetch(`${settings.apiBase || DEFAULT_API}/agent/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          goal: "Complete this flight checkout safely with one-click assistance.",
          userIntent: `Complete checkout safely for ${traveler()?.first_name || "the traveler"}.`,
          traveler: traveler(),
          page: compactPageMap(buildPageMap())
        })
      });
      if (!response.ok) throw new Error(`session returned ${response.status}`);
      const session = await response.json();
      agent.sessionId = session.id || "";
      logAgentEvent("agent_session_started", { sessionId: agent.sessionId });
      return session;
    } catch (error) {
      logAgentEvent("agent_session_failed", { error: error.message });
      agent.sessionId = "";
      return null;
    }
  }

  async function reportActionResult(result = {}) {
    if (!agent.sessionId) return;
    try {
      const settings = await storageGet(["apiBase"]);
      const map = buildPageMap();
      await fetch(`${settings.apiBase || DEFAULT_API}/agent/report`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: agent.sessionId,
          result: {
            ...result,
            stage: result.stage || map.step,
            errors: result.errors || map.errors
          },
          page: compactPageMap(map)
        })
      });
    } catch (error) {
      logAgentEvent("agent_report_failed", { error: error.message });
    }
  }

  function debugSnapshot() {
    const map = agent.pageMap || buildPageMap();
    return {
      captured_at: new Date().toISOString(),
      url: location.href,
      host: location.host,
      traveler: traveler() ? [traveler().first_name, traveler().last_name].filter(Boolean).join(" ") : "",
      agent_state: {
        sessionId: agent.sessionId,
        running: agent.running,
        awaiting: agent.awaiting,
        skipPaidExtrasApproved: agent.skipPaidExtrasApproved,
        skipRoutineRunning: agent.skipRoutineRunning,
        repeatClickCount: agent.repeatClickCount
      },
      page: {
        site: map.site,
        step: map.step,
        coverage: map.coverage,
        summary: map.summary,
        errors: map.errors,
        paidChoices: map.paidChoices,
        fields: map.fields.map((field) => ({
          id: field.id,
          label: field.label,
          box: field.box,
          kind: field.kind,
          field: field.field,
          required: field.required,
          hasValue: Boolean(field.value),
          confidence: field.confidence
        })),
        buttons: map.buttons.map((button) => ({
          id: button.id,
          label: button.label,
          box: button.box,
          risk: button.risk
        })),
        overlays: (map.overlays || []).map((overlay) => ({
          id: overlay.id,
          label: overlay.label,
          box: overlay.box,
          role: overlay.role
        })),
        text_sample: map.text.slice(0, 1500)
      },
      messages: agent.messages,
      actionHistory: agent.actionHistory,
      filledFields,
      warnings,
      events: agent.debugLog
    };
  }

  async function copyDebugLog() {
    const text = JSON.stringify(debugSnapshot(), null, 2);
    try {
      await navigator.clipboard.writeText(text);
      addAgentMessage("assistant", "Debug log copied. Paste it here and I can see what the agent saw and decided.");
    } catch (error) {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.left = "-9999px";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
      addAgentMessage("assistant", "Debug log copied with fallback copy. Paste it here.");
    }
    renderSidebar("agent");
  }

  function isVisible(element) {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  }

  function queryAllDeep(selector, root = document) {
    const results = [];
    const visit = (scope) => {
      try {
        results.push(...scope.querySelectorAll(selector));
        const nested = scope.querySelectorAll("*");
        for (const element of nested) {
          if (element.shadowRoot) visit(element.shadowRoot);
        }
        for (const frame of scope.querySelectorAll("iframe")) {
          try {
            if (frame.contentDocument) visit(frame.contentDocument);
          } catch (error) {
            // Cross-origin frames are intentionally opaque to the content script.
          }
        }
      } catch (error) {
        // Some roots/frames can disappear while checkout pages re-render.
      }
    };
    visit(root);
    return [...new Set(results)];
  }

  function elementSignature(element) {
    if (!element) return "";
    return [
      location.href,
      element.tagName,
      element.id,
      element.name,
      element.innerText || element.value || element.getAttribute("aria-label") || ""
    ].join("|").slice(0, 500);
  }

  function pageSignature(map = buildPageMap()) {
    return [
      location.href,
      map.step,
      map.errors.join("|"),
      map.text.slice(0, 800)
    ].join("||");
  }

  function elementId(element) {
    if (!element.dataset.atwElementId) {
      elementIdCounter += 1;
      element.dataset.atwElementId = `atw-el-${elementIdCounter}`;
    }
    return element.dataset.atwElementId;
  }

  function elementById(id) {
    if (!id) return null;
    return queryAllDeep(`[data-atw-element-id="${CSS.escape(id)}"]`)[0] || null;
  }

  function flashElement(element) {
    if (!element) return;
    element.classList.add("atw-highlight");
    setTimeout(() => element.classList.remove("atw-highlight"), 900);
  }

  function showAgentCursor(element, actionLabel = "", reason = "") {
    if (!element) return;
    let cursor = document.getElementById("atw-agent-cursor");
    if (!cursor) {
      cursor = document.createElement("div");
      cursor.id = "atw-agent-cursor";
      cursor.innerHTML = "<span class='atw-cursor-mark'>AI</span>";
      document.body.appendChild(cursor);
    }
    const firstRect = element.getBoundingClientRect();
    const isOffscreen = firstRect.bottom < 0 || firstRect.top > window.innerHeight || firstRect.right < 0 || firstRect.left > window.innerWidth;
    if (isOffscreen && element.scrollIntoView) {
      element.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
    }
    const rect = element.getBoundingClientRect();
    const derivedLabel = actionLabel || (element.innerText || element.value || element.getAttribute("aria-label") || "working").replace(/\s+/g, " ").trim();
    cursor.dataset.action = derivedLabel ? derivedLabel.slice(0, 32) : "working";
    cursor.dataset.reason = reason ? reason.slice(0, 96) : agent.currentReason || "";
    const x = rect.left + Math.min(Math.max(rect.width / 2, 18), Math.max(rect.width - 18, 18));
    const y = rect.top + Math.min(Math.max(rect.height / 2, 18), Math.max(rect.height - 18, 18));
    cursor.style.transform = `translate3d(${Math.max(8, x - 23)}px, ${Math.max(8, y - 23)}px, 0)`;
    cursor.classList.add("is-visible", "is-clicking");
    setTimeout(() => cursor.classList.remove("is-clicking"), 350);
  }

  function userLikeClick(element) {
    const rect = element.getBoundingClientRect();
    const eventInit = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: Math.round(rect.left + rect.width / 2),
      clientY: Math.round(rect.top + rect.height / 2)
    };
    element.dispatchEvent(new PointerEvent("pointerdown", eventInit));
    element.dispatchEvent(new MouseEvent("mousedown", eventInit));
    element.dispatchEvent(new PointerEvent("pointerup", eventInit));
    element.dispatchEvent(new MouseEvent("mouseup", eventInit));
    element.dispatchEvent(new MouseEvent("click", eventInit));
  }

  async function waitForUiSettle(ms = 650) {
    setAgentActivity("Watching page update", "Waiting for popups, dropdowns, or validation to settle");
    await sleep(ms);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }

  function activeDemoStepName() {
    return queryAllDeep("[data-checkout-step].is-active")[0]?.dataset.checkoutStep || "";
  }

  function findSafeContinueButton() {
    const buttons = queryAllDeep("button, a, input[type='button'], input[type='submit']").filter(isVisible);
    return buttons.find((button) => {
      if (button.closest("#atw-sidebar")) return false;
      if (button.matches("[data-demo-pay]")) return false;
      if (button.matches("[data-atw-safe-continue], [data-continue-step]")) return true;
      const text = (button.innerText || button.value || button.getAttribute("aria-label") || "").toLowerCase();
      const safe = ["continue", "next", "proceed"].some((term) => text.includes(term));
      const dangerous = ["pay", "book", "purchase", "confirm", "complete booking", "submit payment"].some((term) => text.includes(term));
      return safe && !dangerous;
    });
  }

  function routeSummary() {
    const origin = document.querySelector("[data-origin]")?.textContent?.trim() || "origin";
    const destination = document.querySelector("[data-destination]")?.textContent?.trim() || "destination";
    const departure = document.querySelector("[data-departure]")?.textContent?.trim() || "selected date";
    const price = document.querySelector("[data-price]")?.textContent?.trim() || "current price";
    return `${origin} to ${destination}, ${departure}, ${price}`;
  }

  function visiblePageText() {
    return [...document.body.children]
      .filter((element) => element.id !== "atw-sidebar")
      .map((element) => element.innerText || element.textContent || "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function primaryPageText() {
    const candidates = queryAllDeep("main, [role='main'], form, section, article")
      .filter((element) => isVisible(element) && !element.closest("#atw-sidebar"))
      .map((element) => {
        const text = (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
        const headingScore = /traveller information|traveler information|configure your trip|select baggage|seat selection|payment|confirmation/i.test(text) ? 1200 : 0;
        const formScore = element.matches("form") ? 500 : 0;
        return { text, score: Math.min(text.length, 4000) + headingScore + formScore };
      })
      .filter((item) => item.text.length > 40)
      .sort((a, b) => b.score - a.score);
    return candidates[0]?.text || visiblePageText();
  }

  function classifyStep(text) {
    const lower = text.toLowerCase();
    const extrasEvidence = /select baggage|configure your trip|upgrade your trip|checked baggage|bundle|premium support|airhelp|cancellation guarantee|voucher refund|add to cart|no thanks|add baggage|choose your bundle/.test(lower);
    const travelerEvidence = /traveller information|traveler information|contact information|provide your contact details|passport|date of birth|surname|first name|first and middle names|mobile number|confirm e-?mail/.test(lower);
    const seatEvidence = /seat selection|select seat|choose seat/.test(lower);
    const travelerRouteEvidence = /\/rf\/traveler-details|\/rf\/traveller-details|traveler-details|traveller-details/.test(lower);
    const paymentFormEvidence = /card number|security code|cvc|cvv|pay now|complete booking|confirm and pay|submit payment|billing card|cardholder/.test(lower);
    const paymentRouteEvidence = /\/rf\/payment|\/payment\b|[#?&/]payment\b/.test(lower);

    if (/booking confirmed|confirmation|booking reference|reservation number|pnr/.test(lower)) return "confirmation";
    if (travelerRouteEvidence) return "traveler_information";
    if (paymentFormEvidence) return "payment";
    if (paymentRouteEvidence && extrasEvidence) return "extras";
    if (paymentRouteEvidence && seatEvidence) return "seats";
    if (travelerEvidence) return "traveler_information";
    if (seatEvidence) return "seats";
    if (extrasEvidence) return "extras";
    if (paymentRouteEvidence) return "payment";
    if (/flight selection|select flight|choose flight|fare/.test(lower)) return "flight_selection";
    return "unknown";
  }

  function pageCoverage() {
    const iframes = [...document.querySelectorAll("iframe")];
    let accessibleIframes = 0;
    for (const frame of iframes) {
      try {
        if (frame.contentDocument) accessibleIframes += 1;
      } catch (error) {
        // Cross-origin frame.
      }
    }
    return {
      openShadowRoots: queryAllDeep("*").filter((element) => element.shadowRoot).length,
      iframes: iframes.length,
      accessibleIframes,
      blockedIframes: Math.max(0, iframes.length - accessibleIframes)
    };
  }

  function visibleOverlays() {
    return queryAllDeep("[role='dialog'], [aria-modal='true'], [role='listbox'], [role='menu'], [data-headlessui-state], .modal, .popover")
      .filter((element) => isVisible(element) && !element.closest("#atw-sidebar"))
      .map((element) => {
        const text = (element.innerText || element.textContent || element.getAttribute("aria-label") || "")
          .replace(/\s+/g, " ")
          .trim();
        return {
          id: elementId(element),
          label: text.slice(0, 220),
          box: elementBox(element),
          role: element.getAttribute("role") || ""
        };
      })
      .filter((item) => item.label || item.role)
      .slice(0, 12);
  }

  function fieldValue(input) {
    if (input.type === "radio" || input.type === "checkbox") return input.checked ? "checked" : "";
    return input.value || "";
  }

  function elementBox(element) {
    const rect = element.getBoundingClientRect();
    return {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      centerX: Math.round(rect.left + rect.width / 2),
      centerY: Math.round(rect.top + rect.height / 2),
      inViewport: rect.bottom >= 0 && rect.right >= 0 && rect.top <= window.innerHeight && rect.left <= window.innerWidth
    };
  }

  function isDangerousActionLabel(label) {
    return /\b(pay|purchase|book)\b|book now|complete booking|confirm booking|submit payment|confirm payment|confirm and pay/i.test(label);
  }

  function isSafeContinueLabel(label) {
    return /\b(continue|next|proceed)\b|skip to next step/i.test(label) && !isDangerousActionLabel(label);
  }

  function isSkipChoiceLabel(label) {
    return /no,?\s+thanks|no checked baggage|no baggage|none of the passengers|\bnone\b/i.test(label);
  }

  function actionRisk(label) {
    if (isDangerousActionLabel(label)) return "payment";
    if (isSafeContinueLabel(label)) return "safe_continue";
    if (isSkipChoiceLabel(label)) return "skip_extra";
    return "choice";
  }

  function buildPageMap() {
    const text = primaryPageText();
    const fullText = visiblePageText();
    const step = classifyStep(`${location.href} ${text} ${fullText.slice(0, 2500)}`);
    const fields = candidateInputs().map((input) => {
      const detected = detectField(input);
      return {
        element: input,
        id: elementId(input),
        label: labelText(input),
        box: elementBox(input),
        kind: input.type || input.tagName.toLowerCase(),
        field: detected?.field || "unknown",
        required: input.required || /\*/.test(labelText(input)),
        value: fieldValue(input),
        confidence: detected?.confidence || 0
      };
    });
    const buttons = queryAllDeep("button, a, input[type='button'], input[type='submit'], [role='button']")
      .filter((button) => isVisible(button) && !button.closest("#atw-sidebar"))
      .map((button) => {
        const label = (button.innerText || button.value || button.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
        const lower = label.toLowerCase();
        return {
          element: button,
          id: elementId(button),
          label,
          box: elementBox(button),
          risk: actionRisk(lower)
        };
      });
    const errors = collectVisibleErrors(text);
    const paidChoices = collectPaidChoices(fullText);
    const overlays = visibleOverlays();
    return {
      site: inferCheckoutSite(),
      step,
      text,
      fullText,
      coverage: pageCoverage(),
      fields,
      buttons,
      overlays,
      errors,
      paidChoices,
      summary: {
        fields: fields.length,
        knownFields: fields.filter((field) => field.field !== "unknown").length,
        buttons: buttons.length,
        overlays: overlays.length,
        errors: errors.length,
        paidChoices: paidChoices.length
      }
    };
  }

  function collectVisibleErrors(pageText) {
    const step = classifyStep(pageText);
    if (["extras", "seats", "payment", "confirmation"].includes(step)) {
      return [];
    }
    const issues = [];
    const visibleText = queryAllDeep("body *")
      .filter((element) => isVisible(element) && !element.closest("#atw-sidebar"))
      .map((element) => (element.innerText || element.textContent || "").trim())
      .filter(Boolean);

    for (const text of visibleText) {
      const normalized = text.toLowerCase();
      if (normalized.length > 180) continue;
      if (/^\*?\s*field required\.?$/.test(normalized)) continue;
      if (/^passenger\s+\d+,\s*(adult|child|infant)\s+\*?field required\.?$/.test(normalized)) continue;
      if (/please enter your name and surname exactly/.test(normalized)) continue;
      if (VALIDATION_TERMS.some((term) => normalized.includes(term)) && /must enter|too long|too short|invalid|not valid|error|you must|required.+field|field.+required/.test(normalized)) {
        issues.push(text.replace(/\s+/g, " "));
      }
      if (issues.length >= 4) break;
    }

    const emailInputs = candidateInputs().filter((input) => labelText(input).includes("email"));
    const confirmEmail = emailInputs.find((input) => labelText(input).includes("confirm"));
    if (confirmEmail && !confirmEmail.value) issues.unshift("confirm email is empty");

    const titleAreaVisible = document.body.innerText.toLowerCase().includes("title *") || document.body.innerText.toLowerCase().includes("you must enter a gender");
    const anyTitleChecked = queryAllDeep("input[type='radio']")
      .filter((radio) => /mr|mrs|ms|title|gender/.test(labelText(radio)))
      .some((radio) => radio.checked);
    if (titleAreaVisible && !anyTitleChecked && !travelerValue("title")) {
      issues.unshift("title/gender is required but no traveler title preference is saved");
    }

    return [...new Set(issues)];
  }

  function collectPaidChoices(pageText = visiblePageText()) {
    const text = pageText.toLowerCase();
    const choices = [];
    if (/eur|€|\$|usd|gbp/.test(text) && /baggage|bundle|support|sms|cancellation|add to cart|premium/.test(text)) {
      if (/checked baggage|add baggage/.test(text)) choices.push("paid checked baggage");
      if (/bundle|premium support|airhelp|sms/.test(text)) choices.push("paid bundle or support add-on");
      if (/cancellation guarantee|voucher refund/.test(text)) choices.push("paid cancellation/refund product");
    }
    return [...new Set(choices)];
  }

  function describePageMap(map) {
    const stepCopy = {
      traveler_information: "traveler information",
      extras: "baggage/extras",
      seats: "seat selection",
      payment: "payment",
      confirmation: "confirmation",
      flight_selection: "flight selection",
      unknown: "unknown step"
    };
    return `I see ${stepCopy[map.step] || map.step}: ${map.summary.knownFields}/${map.summary.fields} recognizable fields, ${map.summary.buttons} actions, ${map.summary.paidChoices} paid-choice areas.`;
  }

  async function fillKnownFieldsFromMap(map) {
    filledFields = [];
    fillTitleRadio();
    const phoneCount = await fillPhoneFieldsFromMap(map);
    const fillable = map.fields.filter((field) => !["unknown", "phone", "phone_country_code"].includes(field.field) && field.element && field.element.type !== "radio" && field.element.type !== "checkbox");
    let failed = 0;
    for (const field of fillable) {
      const value = travelerValue(field.field);
      if (!value) continue;
      if (field.value && field.value.trim() === value.trim()) continue;
      const result = await setFieldValue(field.element, value, { fieldType: field.field });
      if (!result.ok) {
        failed += 1;
        continue;
      }
      filledFields.push({
        fieldType: field.field,
        selector: field.element.name || field.element.id || field.element.tagName.toLowerCase(),
        confidence: field.confidence
      });
    }
    if (failed) {
      addAgentMessage("assistant", `I tried ${failed} field${failed === 1 ? "" : "s"} that did not accept input, so I will rescan before deciding next.`);
    }
    if (phoneCount) recordAction("phone_fields_filled", { count: phoneCount });
    return filledFields.length;
  }

  function firstFieldFor(map, fieldType) {
    return map.fields.find((field) => field.field === fieldType && field.element && field.element.type !== "radio" && field.element.type !== "checkbox");
  }

  async function stepFillTravelerInformation(startMap = buildPageMap()) {
    let map = startMap.step === "traveler_information" ? startMap : buildPageMap();
    if (map.step !== "traveler_information") return false;

    filledFields = [];
    setAgentActivity("Preparing traveler details", "Will continue automatically once valid");
    addAgentMessage("assistant", "Step mode: I will fill traveler details slowly, verify the page, then continue if it is valid.");
    renderSidebar("agent");
    await sleep(500);

    const steps = [
      { field: "email", label: "email" },
      { field: "confirm_email", label: "confirm email" },
      { field: "phone", label: "mobile number", phone: true },
      { field: "title", label: "title", title: true },
      { field: "first_name", label: "first name" },
      { field: "last_name", label: "surname" },
      { field: "date_of_birth", label: "date of birth" },
      { field: "nationality", label: "nationality" },
      { field: "passport_number", label: "passport number" },
      { field: "passport_expiry", label: "passport expiry" }
    ];

    for (const step of steps) {
      map = buildPageMap();
      if (step.phone) {
        setAgentActivity("Filling mobile number", "Country code + local number");
        addAgentMessage("assistant", "Step: mobile number.");
        renderSidebar("agent");
        const count = await fillPhoneFieldsFromMap(map);
        addAgentMessage("assistant", count ? "Mobile number accepted." : "Mobile number not filled; I could not identify a working phone control.");
        renderSidebar("agent");
        await sleep(850);
        continue;
      }

      if (step.title) {
        setAgentActivity("Selecting title", "From saved traveler gender");
        addAgentMessage("assistant", "Step: title.");
        renderSidebar("agent");
        const ok = fillTitleRadio();
        recordAction("step_title", { ok });
        addAgentMessage("assistant", ok ? "Title selected." : "Title not selected; no matching saved gender/title or control found.");
        renderSidebar("agent");
        await sleep(850);
        continue;
      }

      const value = travelerValue(step.field);
      const field = firstFieldFor(map, step.field);
      if (!value || !field) {
        recordAction("step_fill_skip", { field: step.field, hasValue: Boolean(value), hasField: Boolean(field) });
        continue;
      }

      addAgentMessage("assistant", `Step: ${step.label}.`);
      setAgentActivity(`Filling ${step.label}`, "From saved traveler profile");
      renderSidebar("agent");
      const result = await setFieldValue(field.element, value, { fieldType: step.field });
      if (result.ok) {
        filledFields.push({
          fieldType: step.field,
          selector: field.element.name || field.element.id || field.element.tagName.toLowerCase(),
          confidence: field.confidence
        });
      }
      addAgentMessage("assistant", result.ok ? `${step.label} accepted.` : `${step.label} did not stick; I logged the failure.`);
      renderSidebar("agent");
      await sleep(850);
    }

    let after = buildPageMap();
    const phoneProblem = after.errors.some((issue) => /phone|mobile|too long|too short/i.test(issue));
    if (phoneProblem) {
      setAgentActivity("Repairing mobile number", "Country prefix or phone format still rejected");
      addAgentMessage("assistant", "Phone validation is still visible, so I am retrying country code + local number before continuing.");
      renderSidebar("agent");
      await fillPhoneFieldsFromMap(after);
      await sleep(600);
      after = buildPageMap();
    }
    agent.pageMap = after;
    agent.awaiting = "manual";
    const issues = after.errors.slice(0, 3);
    if (issues.length) {
      agent.running = false;
      addAgentMessage("assistant", `I filled traveler details, but the page still shows: ${issues.join("; ")}.`);
      addAgentMessage("assistant", "I will not guess past a real validation error. Tell me what to use or fix it and type continue.");
      renderSidebar("agent");
      return true;
    }
    if (after.paidChoices.length && (agent.skipPaidExtrasApproved || prefersNoPaidExtras())) {
      agent.skipPaidExtrasApproved = true;
      setAgentActivity("Skipping paid extras", "Saved traveler rules prefer no paid add-ons");
      addAgentMessage("assistant", "Traveler details are complete. I see paid extras on this page, so I am selecting the no-thanks choices before continuing.");
      renderSidebar("agent");
      const skipped = selectNoThanksOptions();
      reportActionResult({
        type: "skip_paid_extras",
        action: "skip_paid_extras",
        target: "paid extras on traveler page",
        ok: true,
        message: skipped ? `Selected ${skipped} no-thanks option${skipped === 1 ? "" : "s"}.` : "No visible no-thanks choices needed changing."
      });
      await sleep(700);
      after = buildPageMap();
      agent.pageMap = after;
    }
    const next = findPreferredContinueButton(after);
    if (next) {
      agent.awaiting = "";
      addAgentMessage("assistant", "Traveler details look valid. Continuing to the next step.");
      renderSidebar("agent");
      await clickAndVerifyAdvance(next, next.innerText || next.value || "Continue");
      return true;
    }
    agent.running = false;
    addAgentMessage("assistant", "Traveler details look valid, but I do not see a safe Continue button yet.");
    renderSidebar("agent");
    return true;
  }

  function findButtonByRisk(map, risk) {
    return map.buttons.find((button) => button.risk === risk)?.element || null;
  }

  function findPreferredContinueButton(map = buildPageMap()) {
    const safeButtons = map.buttons.filter((button) => {
      if (button.risk !== "safe_continue") return false;
      if (/skip to main content|skip to next step/i.test(button.label)) return false;
      if (button.box && (button.box.width <= 2 || button.box.height <= 2)) return false;
      return true;
    });
    const exactContinue = safeButtons.find((button) => /^continue$/i.test(button.label))?.element;
    if (exactContinue) return exactContinue;
    const containsContinue = safeButtons.find((button) => /\bcontinue\b/i.test(button.label))?.element;
    if (containsContinue) return containsContinue;
    return safeButtons[0]?.element || findSafeContinueButton();
  }

  function compactPageMap(map) {
    return {
      site: map.site,
      url: location.href,
      step: map.step,
      text: map.text,
      fullText: map.fullText,
      errors: map.errors,
      paidChoices: map.paidChoices,
      summary: map.summary,
      coverage: map.coverage,
      fields: map.fields.map((field) => ({
        id: field.id,
        label: field.label,
        kind: field.kind,
        field: field.field,
        required: field.required,
        value: field.value ? "[filled]" : "",
        confidence: field.confidence
      })),
      buttons: map.buttons.map((button) => ({
        id: button.id,
        label: button.label,
        box: button.box,
        risk: button.risk
      })),
      overlays: (map.overlays || []).map((overlay) => ({
        id: overlay.id,
        label: overlay.label,
        box: overlay.box,
        role: overlay.role
      }))
    };
  }

  async function captureVisibleScreenshot() {
    try {
      const response = await chrome.runtime.sendMessage({ type: "ATW_CAPTURE_VISIBLE_TAB" });
      if (!response?.ok) {
        logAgentEvent("screenshot", { ok: false, error: response?.error || "unavailable" });
        return "";
      }
      logAgentEvent("screenshot", { ok: true, bytes: response.dataUrl.length });
      return response.dataUrl;
    } catch (error) {
      logAgentEvent("screenshot", { ok: false, error: error.message });
      return "";
    }
  }

  function localAgentDecision(map, reason = "local fallback") {
    const safeButton = map.buttons.find((button) => button.risk === "safe_continue");
    const skipButton = map.buttons.find((button) => button.risk === "skip_extra");
    if (map.step === "payment") {
      return { source: "local", action: "final_review", targetId: "", value: "", message: `I reached payment. Summary: ${routeSummary()}. I will not pay unless you explicitly confirm on the site.`, needsApproval: true, risk: "payment", reason };
    }
    if (map.step === "confirmation") {
      return { source: "local", action: "save_trip", targetId: "", value: "", message: "Booking confirmation detected. I can save this confirmed trip to the dashboard.", needsApproval: false, risk: "safe", reason };
    }
    if ((map.step === "extras" || map.step === "seats") && !agent.skipPaidExtrasApproved) {
      const paidCopy = map.paidChoices.length ? `I found ${map.paidChoices.join(", ")}.` : "I found optional baggage/seat/add-on choices.";
      return { source: "local", action: "ask_user", targetId: "", value: "", message: `${paidCopy} Your default is to avoid paid extras unless you say otherwise. Skip paid extras and continue?`, needsApproval: true, risk: "money", reason };
    }
    if ((map.step === "extras" || map.step === "seats") && agent.skipPaidExtrasApproved) {
      return { source: "local", action: "skip_paid_extras", targetId: skipButton?.id || "", value: "", message: "I will select no-thanks choices for paid extras, then continue if the page allows it.", needsApproval: false, risk: "safe", reason };
    }
    if (map.errors.length) {
      return { source: "local", action: "ask_user", targetId: "", value: "", message: `I paused because the page still shows: ${map.errors.slice(0, 3).join("; ")}.`, needsApproval: true, risk: "uncertain", reason };
    }
    if (map.step === "traveler_information" || map.step === "unknown") {
      return { source: "local", action: "fill_known_fields", targetId: "", value: "", message: "I will fill recognizable traveler fields from the saved profile.", needsApproval: false, risk: "safe", reason };
    }
    if (safeButton) {
      return { source: "local", action: "click", targetId: safeButton.id, value: "", message: `Continuing safely: ${safeButton.label || "next step"}.`, needsApproval: false, risk: "safe", reason };
    }
    return { source: "local", action: "ask_user", targetId: "", value: "", message: `${describePageMap(map)} I do not see a safe next action. Tell me what to do.`, needsApproval: true, risk: "uncertain", reason };
  }

  async function requestAgentDecision(map, userMessage = "") {
    logAgentEvent("agent_request", {
      userMessage: userMessage ? "[provided]" : "",
      step: map.step,
      summary: map.summary,
      errors: map.errors,
      paidChoices: map.paidChoices
    });
    try {
      const settings = await storageGet(["apiBase"]);
      const screenshotDataUrl = await captureVisibleScreenshot();
      const response = await fetch(`${settings.apiBase || DEFAULT_API}/agent/next-action`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: agent.sessionId,
          userIntent: `Complete this flight checkout safely using the selected traveler profile. Traveler rules: ${travelerRules() || "Ask before paid extras and stop at real payment."}`,
          userMessage,
          traveler: traveler(),
          approvalState: {
            skipPaidExtrasApproved: agent.skipPaidExtrasApproved || prefersNoPaidExtras(),
            paymentApproved: false
          },
          actionHistory: agent.actionHistory.slice(-12),
          page: {
            ...compactPageMap(map),
            screenshotDataUrl
          }
        })
      });
      if (!response.ok) throw new Error(`agent returned ${response.status}`);
      const decision = await response.json();
      logAgentEvent("agent_decision", {
        source: decision.source,
        action: decision.action,
        targetId: decision.targetId,
        risk: decision.risk,
        needsApproval: decision.needsApproval,
        message: decision.message,
        reason: decision.reason
      });
      return decision;
    } catch (error) {
      const decision = localAgentDecision(map, error.message);
      logAgentEvent("agent_decision", {
        source: decision.source,
        action: decision.action,
        targetId: decision.targetId,
        risk: decision.risk,
        needsApproval: decision.needsApproval,
        message: decision.message,
        reason: decision.reason
      });
      return decision;
    }
  }

  function repeatGuardFor(element, message) {
    const signature = elementSignature(element);
    if (signature === agent.lastClickSignature) {
      agent.repeatClickCount += 1;
    } else {
      agent.lastClickSignature = signature;
      agent.repeatClickCount = 0;
    }
    if (agent.repeatClickCount >= 2 && inferCheckoutSite() !== "demo") {
      agent.awaiting = "manual";
      agent.running = false;
      addAgentMessage("assistant", message);
      renderSidebar("agent");
      return false;
    }
    return true;
  }

  async function continueAfterAction(delay = 800) {
    renderSidebar("agent");
    await sleep(delay);
    processCheckoutAgent();
  }

  async function clickAndVerifyAdvance(element, label = "Continue", delay = 1200) {
    const before = pageSignature();
    addAgentMessage("assistant", `Clicking: ${label}.`);
    setAgentActivity(`Clicking ${label}`, "Checking whether the page advances");
    showAgentCursor(element, `Clicking ${label}`, "Safe navigation step");
    flashElement(element);
    element.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
    await sleep(250);
    userLikeClick(element);
    await waitForUiSettle(700);
    await sleep(delay);
    let afterMap = buildPageMap();
    let advanced = before !== pageSignature(afterMap);
    agent.pageMap = afterMap;
    setAgentActivity(advanced ? `Advanced to ${afterMap.step.replace(/_/g, " ")}` : `${label} did not advance`, advanced ? "Reading the next page state" : "Looking for the remaining blocker");
    logAgentEvent("verify_advance", {
      label,
      advanced,
      step: afterMap.step,
      errors: afterMap.errors,
      url: location.href
    });
    reportActionResult({
      type: "navigation",
      action: "click_continue",
      target: label,
      ok: advanced && !afterMap.errors.length,
      message: advanced ? `Clicked ${label} and reached ${afterMap.step.replace(/_/g, " ")}.` : `Clicked ${label}, but the page did not advance.`,
      errors: afterMap.errors
    });
    if (!advanced && inferCheckoutSite() !== "demo") {
      if (!afterMap.errors.length && agent.running) {
        addAgentMessage("assistant", `${label} did not advance, so I am rescanning for a remaining required choice instead of stopping.`);
        await continueAfterAction(350);
        return false;
      }
      agent.awaiting = "manual";
      agent.running = false;
      addAgentMessage("assistant", `I clicked ${label}, but the page did not advance. Something is still unresolved on this step.`);
      if (afterMap.errors.length) addAgentMessage("assistant", `Visible issue: ${afterMap.errors.slice(0, 2).join("; ")}.`);
      addAgentMessage("assistant", "Tell me what to select, or choose it on the page and type continue.");
      renderSidebar("agent");
      return false;
    }
    await continueAfterAction(250);
    return true;
  }

  async function skipPaidExtrasAndContinue() {
    if (agent.skipRoutineRunning) return;
    agent.skipRoutineRunning = true;
    agent.skipPaidExtrasApproved = true;
    try {
      const skipped = selectNoThanksOptions();
      logAgentEvent("skip_paid_extras", { changedChoices: skipped });
      reportActionResult({
        type: "skip_paid_extras",
        action: "skip_paid_extras",
        target: "paid extras",
        ok: true,
        message: skipped ? `Selected ${skipped} no-thanks option${skipped === 1 ? "" : "s"}.` : "No unchecked paid-extra choices needed changing."
      });
      if (skipped) addAgentMessage("assistant", `Selected ${skipped} unchecked no-thanks option${skipped === 1 ? "" : "s"}.`);
      renderSidebar("agent");
      await sleep(700);

      const refreshedMap = buildPageMap();
      agent.pageMap = refreshedMap;
      const next = findPreferredContinueButton(refreshedMap);
      if (!next) {
        agent.awaiting = "manual";
        agent.running = false;
        addAgentMessage("assistant", "I set the no-paid-extra choices I could find, but I do not see a safe Continue button. Tell me what to do next.");
        renderSidebar("agent");
        return;
      }

      if (!repeatGuardFor(next, "I tried Continue after setting no-paid-extra choices and the page did not advance. I stopped so I do not loop. Tell me which visible choice is still required, or choose it and say continue.")) return;
      await clickAndVerifyAdvance(next, next.innerText || next.value || "Continue");
    } finally {
      agent.skipRoutineRunning = false;
    }
  }

  async function executeAgentDecision(decision, map) {
    logAgentEvent("execute", {
      action: decision.action,
      targetId: decision.targetId,
      risk: decision.risk,
      source: decision.source
    });
    const message = decision.message || "I have a next action.";
    if (!agent.messages.at(-1) || agent.messages.at(-1).text !== message) {
      addAgentMessage("assistant", `${message}${decision.source === "openai" ? "" : " (fallback)"}`);
    }
    if (decision.reason) {
      setAgentActivity(message, decision.reason);
    }

    if (decision.risk !== "safe" && decision.needsApproval) {
      agent.awaiting = decision.risk === "money" ? "extras" : decision.risk === "payment" ? "final" : "manual";
      agent.running = false;
      renderSidebar("agent");
      return;
    }

    if (decision.action === "ask_user") {
      agent.awaiting = decision.risk === "money" ? "extras" : "manual";
      agent.running = false;
      renderSidebar("agent");
      return;
    }

    if (decision.action === "final_review") {
      agent.awaiting = "final";
      agent.running = false;
      renderSidebar("review");
      return;
    }

    if (decision.action === "save_trip") {
      agent.awaiting = "";
      agent.running = false;
      renderSidebar("saved");
      return;
    }

    if (decision.action === "stop") {
      agent.running = false;
      agent.awaiting = "";
      renderSidebar("agent");
      return;
    }

    if (decision.action === "wait") {
      await continueAfterAction(900);
      return;
    }

    if (decision.action === "fill_known_fields") {
      const count = await fillKnownFieldsFromMap(map);
      if (count) addAgentMessage("assistant", `Filled ${count} visible field${count === 1 ? "" : "s"} from the live page map.`);
      await continueAfterAction(500);
      return;
    }

    if (decision.action === "skip_paid_extras") {
      await skipPaidExtrasAndContinue();
      return;
    }

    if (decision.action === "click") {
      const target = elementById(decision.targetId);
      if (!target) {
        agent.awaiting = "manual";
        agent.running = false;
        addAgentMessage("assistant", "The AI chose an element that is no longer visible. I rescanned and stopped so you can guide me.");
        renderSidebar("agent");
        return;
      }
      const button = map.buttons.find((item) => item.id === decision.targetId);
      const targetText = labelText(target) || target.innerText || button?.label || "";
      if (agent.skipPaidExtrasApproved && (button?.risk === "skip_extra" || isSkipChoiceLabel(targetText))) {
        await skipPaidExtrasAndContinue();
        return;
      }
      if (button?.risk === "payment" || isDangerousActionLabel(button?.label || "")) {
        agent.awaiting = "final";
        agent.running = false;
        addAgentMessage("assistant", "I will not click payment or final booking buttons automatically on a real site.");
        renderSidebar("review");
        return;
      }
      if (!repeatGuardFor(target, "I tried the same action once and the page did not advance. I stopped so I do not loop.")) return;
      if (button?.risk === "safe_continue") {
        await clickAndVerifyAdvance(target, button.label || "Continue");
        return;
      }
      showAgentCursor(target, button?.label || "clicking");
      flashElement(target);
      target.click();
      await continueAfterAction(900);
      return;
    }

    if (decision.action === "type" || decision.action === "select") {
      const target = elementById(decision.targetId);
      if (!target || isPaymentField(target)) {
        agent.awaiting = "manual";
        agent.running = false;
        addAgentMessage("assistant", "The requested field is unavailable or sensitive, so I stopped.");
        renderSidebar("agent");
        return;
      }
      const result = await setFieldValue(target, decision.value || "", { fieldType: decision.action });
      if (!result.ok) {
        agent.awaiting = "manual";
        agent.running = false;
        addAgentMessage("assistant", `I tried to ${decision.action} that field, but the page did not keep the value. I logged the failure for debugging.`);
        renderSidebar("agent");
        return;
      }
      await continueAfterAction(500);
      return;
    }

    agent.awaiting = "manual";
    agent.running = false;
    renderSidebar("agent");
  }

  async function takeOverCheckout() {
    agent.running = true;
    agent.sessionId = "";
    agent.awaiting = "";
    agent.messages = [];
    agent.lastClickSignature = "";
    agent.repeatClickCount = 0;
    agent.skipPaidExtrasApproved = prefersNoPaidExtras();
    agent.actionHistory = [];
    setAgentActivity("Starting checkout agent", travelerRules() || "Using saved traveler profile");
    agent.pageMap = buildPageMap();
    await startAgentSession();
    addAgentMessage("assistant", `${describePageMap(agent.pageMap)} I will work step by step and ask when money, payment, or uncertainty appears.`);
    renderSidebar("agent");
    await sleep(450);
    if (agent.pageMap.step === "traveler_information") {
      await stepFillTravelerInformation(agent.pageMap);
      return;
    }
    processCheckoutAgent();
  }

  async function processCheckoutAgent() {
    if (!agent.running) return;
    warnings = runRiskChecks();
    const map = buildPageMap();
    agent.pageMap = map;
    if ((map.step === "extras" || map.step === "seats") && agent.skipPaidExtrasApproved) {
      await executeAgentDecision(localAgentDecision(map, "policy override after user approved skipping paid extras"), map);
      return;
    }
    const userMessage = agent.pendingUserMessage;
    agent.pendingUserMessage = "";
    const decision = await requestAgentDecision(map, userMessage);
    await executeAgentDecision(decision, map);
    return;

    const demoStep = activeDemoStepName();

    if (map.step === "payment") {
      agent.awaiting = "final";
      agent.running = false;
      addAgentMessage("assistant", `I reached payment. Summary: ${routeSummary()}. I will not pay unless you explicitly confirm on the site.`);
      renderSidebar("review");
      return;
    }

    if (map.step === "confirmation") {
      agent.awaiting = "";
      agent.running = false;
      addAgentMessage("assistant", "Booking confirmation detected. I can save this confirmed trip to the dashboard.");
      renderSidebar("saved");
      return;
    }

    if (map.step === "extras" || map.step === "seats") {
      if (!agent.skipPaidExtrasApproved) {
        agent.awaiting = "extras";
        agent.running = false;
        const paidCopy = map.paidChoices.length ? `I found ${map.paidChoices.join(", ")}.` : "I found optional baggage/seat/add-on choices.";
        addAgentMessage("assistant", `${paidCopy} Your default is to avoid paid extras unless you say otherwise. Skip paid extras and continue?`);
        renderSidebar("agent");
        return;
      }

      const skipped = selectNoThanksOptions();
      if (skipped) {
        addAgentMessage("assistant", `Selected ${skipped} no-thanks/skip option${skipped === 1 ? "" : "s"}.`);
        renderSidebar("agent");
        await sleep(500);
      }

      const nextFromExtras = findButtonByRisk(buildPageMap(), "safe_continue") || findSafeContinueButton();
      if (nextFromExtras) {
        const signature = elementSignature(nextFromExtras);
        if (signature === agent.lastClickSignature) {
          agent.repeatClickCount += 1;
        } else {
          agent.lastClickSignature = signature;
          agent.repeatClickCount = 0;
        }
        if (agent.repeatClickCount >= 1 && inferCheckoutSite() !== "demo") {
          agent.awaiting = "manual";
          agent.running = false;
          addAgentMessage("assistant", "I tried Continue once after skipping extras and the page did not advance. I stopped so I do not loop. Tell me which visible choice to pick, or choose it and say continue.");
          renderSidebar("agent");
          return;
        }
        addAgentMessage("assistant", `Continuing safely: ${nextFromExtras.innerText || nextFromExtras.value || "next step"}.`);
        showAgentCursor(nextFromExtras);
        flashElement(nextFromExtras);
        nextFromExtras.click();
        renderSidebar("agent");
        await sleep(900);
        processCheckoutAgent();
        return;
      }

      agent.awaiting = "manual";
      agent.running = false;
      addAgentMessage("assistant", "I skipped the no-thanks choices I could find, but I do not see a safe Continue button yet. Tell me what to do next.");
      renderSidebar("agent");
      return;
    }

    if (map.step === "traveler_information" || map.step === "unknown") {
      const count = await fillKnownFieldsFromMap(map);
      if (count) {
        addAgentMessage("assistant", `Filled ${count} visible field${count === 1 ? "" : "s"} from the live page map.`);
        renderSidebar("agent");
        await sleep(450);
      }
    }

    if (demoStep === "extras") {
      agent.awaiting = "extras";
      agent.running = false;
      addAgentMessage("assistant", "Baggage is not included. Add cabin bag for $32 or skip extras?");
      renderSidebar("agent");
      return;
    }

    if (demoStep === "review") {
      agent.awaiting = "final";
      agent.running = false;
      addAgentMessage("assistant", `Ready to book: ${routeSummary()}. Review payment yourself, then confirm or stop.`);
      renderSidebar("review");
      return;
    }

    if (demoStep === "confirmation") {
      agent.awaiting = "";
      agent.running = false;
      addAgentMessage("assistant", "Booking confirmation detected. I can save this confirmed trip to the dashboard.");
      renderSidebar("saved");
      return;
    }

    const issues = map.errors;
    if (issues.length) {
      agent.awaiting = "manual";
      agent.running = false;
      addAgentMessage("assistant", `I paused because the page still shows: ${issues.slice(0, 3).join("; ")}.`);
      addAgentMessage("assistant", "Tell me what to do in chat, or fix it on the page and say continue.");
      renderSidebar("agent");
      return;
    }

    const next = findButtonByRisk(map, "safe_continue") || findSafeContinueButton();
    if (next) {
      const signature = elementSignature(next);
      if (signature === agent.lastClickSignature) {
        agent.repeatClickCount += 1;
      } else {
        agent.lastClickSignature = signature;
        agent.repeatClickCount = 0;
      }
      if (agent.repeatClickCount >= 1 && inferCheckoutSite() !== "demo") {
        agent.awaiting = "manual";
        agent.running = false;
        addAgentMessage("assistant", "I tried Continue once and the page did not advance. I stopped so I do not loop. Please review the visible validation errors.");
        addAgentMessage("assistant", "After you adjust the page, click 'I fixed it, continue'.");
        renderSidebar("agent");
        return;
      }
      addAgentMessage("assistant", `Continuing safely: ${next.innerText || next.value || "next step"}.`);
      showAgentCursor(next);
      flashElement(next);
      next.click();
      renderSidebar("agent");
      await sleep(800);
      processCheckoutAgent();
      return;
    }

    agent.awaiting = "manual";
    addAgentMessage("assistant", `${describePageMap(map)} I do not see a safe next action. Tell me what to do.`);
    renderSidebar("agent");
  }

  function collectBlockingIssues() {
    const issues = [];
    const visibleText = [...document.querySelectorAll("body *")]
      .filter((element) => isVisible(element) && !element.closest("#atw-sidebar"))
      .map((element) => (element.innerText || element.textContent || "").trim())
      .filter(Boolean);

    for (const text of visibleText) {
      const normalized = text.toLowerCase();
      if (normalized.length > 180) continue;
      if (VALIDATION_TERMS.some((term) => normalized.includes(term)) && /required|must enter|too long|invalid|not valid|error/.test(normalized)) {
        issues.push(text.replace(/\s+/g, " "));
      }
      if (issues.length >= 4) break;
    }

    const emailInputs = candidateInputs().filter((input) => labelText(input).includes("email"));
    const confirmEmail = emailInputs.find((input) => labelText(input).includes("confirm"));
    if (confirmEmail && !confirmEmail.value) issues.unshift("confirm email is empty");

    const titleAreaVisible = document.body.innerText.toLowerCase().includes("title *") || document.body.innerText.toLowerCase().includes("you must enter a gender");
    const anyTitleChecked = [...document.querySelectorAll("input[type='radio']")]
      .filter((radio) => /mr|mrs|ms|title|gender/.test(labelText(radio)))
      .some((radio) => radio.checked);
    if (titleAreaVisible && !anyTitleChecked && !travelerValue("title")) {
      issues.unshift("title/gender is required but no traveler title preference is saved");
    }

    return [...new Set(issues)];
  }

  async function handleAgentChoice(choice) {
    logAgentEvent("user_choice", { choice });
    if (choice === "skip_extras") {
      addAgentMessage("user", "Skip extras.");
      agent.skipPaidExtrasApproved = true;
      document.querySelector("[data-demo-skip-extras]")?.click();
      agent.awaiting = "";
      agent.running = true;
      await skipPaidExtrasAndContinue();
    }

    if (choice === "add_bag") {
      addAgentMessage("user", "Add cabin bag.");
      document.querySelector("[data-demo-add-bag]")?.click();
      agent.awaiting = "";
      renderSidebar("agent");
      await sleep(600);
      processCheckoutAgent();
    }

    if (choice === "confirm_pay") {
      addAgentMessage("user", "Confirm demo payment.");
      const demoPay = document.querySelector("[data-demo-pay]");
      if (demoPay) {
        demoPay.click();
        await sleep(500);
        processCheckoutAgent();
      } else {
        addAgentMessage("assistant", "I will not click payment on real sites in this prototype. Please confirm payment manually.");
        renderSidebar("review");
      }
    }

    if (choice === "stop") {
      agent.running = false;
      agent.awaiting = "";
      addAgentMessage("user", "Stop checkout.");
      addAgentMessage("assistant", "Stopped. Nothing was paid or submitted by me.");
      renderSidebar("agent");
    }

    if (choice === "retry") {
      addAgentMessage("user", "I fixed it. Continue.");
      agent.running = true;
      agent.awaiting = "";
      agent.repeatClickCount = 0;
      renderSidebar("agent");
      await sleep(300);
      processCheckoutAgent();
    }

    if (choice === "skip_paid") {
      addAgentMessage("user", "Skip paid extras.");
      agent.skipPaidExtrasApproved = true;
      agent.running = true;
      agent.awaiting = "";
      await skipPaidExtrasAndContinue();
    }
  }

  async function handleChatSubmit(event) {
    event.preventDefault();
    const input = document.getElementById("atw-chat-input");
    const text = (input?.value || "").trim();
    if (!text) return;
    if (input) input.value = "";
    addAgentMessage("user", text);
    const normalized = text.toLowerCase();
    logAgentEvent("chat", { text });

    if (/stop|cancel|pause/.test(normalized)) {
      await handleAgentChoice("stop");
      return;
    }

    if (/skip|no thanks|no extra|no add|do not add|dont add|don't add/.test(normalized)) {
      await handleAgentChoice("skip_paid");
      return;
    }

    if (/add.*bag|checked bag|baggage/.test(normalized) && !/no|skip|dont|don't/.test(normalized)) {
      await handleAgentChoice("add_bag");
      return;
    }

    if (agent.awaiting === "extras" && /continue|try again|fixed|done|yes|ok|go ahead|proceed/.test(normalized)) {
      await handleAgentChoice("skip_paid");
      return;
    }

    if (/continue|try again|fixed|done|yes|ok|go ahead|proceed/.test(normalized)) {
      await handleAgentChoice("retry");
      return;
    }

    if (/pay|book|confirm/.test(normalized)) {
      addAgentMessage("assistant", "For safety, I will not click real payment from chat. Review the site payment screen and confirm there manually.");
      renderSidebar("review");
      return;
    }

    agent.pendingUserMessage = text;
    addAgentMessage("assistant", "Got it. I will send that to the agent, rescan the page, and continue only if the next action is safe.");
    agent.running = true;
    agent.awaiting = "";
    renderSidebar("agent");
    await sleep(300);
    processCheckoutAgent();
  }

  function clickUncheckedInputByLabel(pattern, description) {
    const inputs = queryAllDeep("input[type='radio'], input[type='checkbox']")
      .filter((candidate) => isVisible(candidate) && !candidate.closest("#atw-sidebar"));
    const match = inputs.find((candidate) => pattern.test(labelText(candidate)) && !candidate.checked);
    if (!match) return false;

    setAgentActivity(`Selecting ${description}`, "Traveler rules avoid paid extras");
    showAgentCursor(match, description, "Rule: avoid paid extras");
    userLikeClick(match);
    match.dispatchEvent(new Event("input", { bubbles: true }));
    match.dispatchEvent(new Event("change", { bubbles: true }));
    flashElement(match);
    logAgentEvent("adapter_click", { description, label: labelText(match).slice(0, 160) });
    return true;
  }

  function selectGoToGateNoPaidExtras() {
    if (inferCheckoutSite() !== "gotogate") return 0;
    const changed = [
      clickUncheckedInputByLabel(/checkinbaggage.*false|no checked baggage/i, "no checked baggage"),
      clickUncheckedInputByLabel(/ancillarybundle.*no,?\s+thanks|continue without bundle/i, "no bundle"),
      clickUncheckedInputByLabel(/cancellationguarantee_false|cancellation.*no,?\s+thanks/i, "no cancellation guarantee")
    ].filter(Boolean).length;
    if (changed) logAgentEvent("gotogate_adapter", { changed });
    return changed;
  }

  function selectNoThanksOptions() {
    let clicked = selectGoToGateNoPaidExtras();
    const candidates = queryAllDeep("input[type='radio'], input[type='checkbox'], button, [role='button']")
      .filter((candidate) => isVisible(candidate) && !candidate.closest("#atw-sidebar"));
    for (const candidate of candidates) {
      const text = labelText(candidate) || candidate.innerText?.toLowerCase() || "";
      if (!isSkipChoiceLabel(text)) continue;
      if ((candidate.type === "radio" || candidate.type === "checkbox") && candidate.checked) continue;
      if (/skip to main content|skip to next step/i.test(text)) continue;

      try {
        setAgentActivity("Selecting No thanks", "Traveler rules avoid paid extras");
        showAgentCursor(candidate, "No thanks", "Rule: avoid paid extras");
        userLikeClick(candidate);
        candidate.dispatchEvent(new Event("input", { bubbles: true }));
        candidate.dispatchEvent(new Event("change", { bubbles: true }));
        flashElement(candidate);
        clicked += 1;
      } catch (error) {
        logAgentEvent("skip_click_failed", { label: text.slice(0, 120), error: error.message });
      }
    }
    return clicked;
  }

  function monthsAfter(dateString, months) {
    const date = new Date(dateString);
    date.setMonth(date.getMonth() + months);
    return date;
  }

  function extractPrice() {
    const priceEl = document.querySelector("[data-price]");
    if (!priceEl) return null;
    const amount = Number(priceEl.textContent.replace(/[^0-9.]/g, ""));
    return Number.isFinite(amount) ? { amount, currency: priceEl.dataset.currency || "USD" } : null;
  }

  function extractTrip() {
    const t = traveler();
    const price = extractPrice();
    const departure = document.querySelector("[data-departure]")?.textContent?.trim() || "";
    return {
      workspace_id: appData.workspaces[0]?.id,
      traveler_profile_id: t.id,
      airline: document.querySelector("[data-airline]")?.textContent?.trim() || "Demo Air",
      seller: document.querySelector("[data-seller]")?.textContent?.trim() || location.host,
      origin_airport: document.querySelector("[data-origin]")?.textContent?.trim() || "",
      destination_airport: document.querySelector("[data-destination]")?.textContent?.trim() || "",
      departure_at: departure ? new Date(departure).toISOString() : "",
      return_at: "",
      booking_reference: document.querySelector("[data-booking-reference]")?.textContent?.trim() || "",
      price_amount: price?.amount || 0,
      price_currency: price?.currency || "USD",
      baggage_summary: document.querySelector("[data-baggage-summary]")?.textContent?.trim() || "",
      booking_url: location.href,
      invoice_status: "missing",
      warnings: runRiskChecks().map((warning) => warning.message)
    };
  }

  function runRiskChecks() {
    const t = traveler();
    const pageText = document.body.innerText.toLowerCase();
    const trip = extractTripShallow();
    const results = [];

    if (BAGGAGE_TERMS.some((term) => pageText.includes(term))) {
      results.push({ type: "missing_baggage", severity: "medium", title: "Baggage may not be included", message: "This fare appears to exclude cabin or checked baggage." });
    }

    if (t?.document?.expiry_date && trip.departureDate) {
      const minValid = monthsAfter(trip.departureDate, 6);
      if (new Date(t.document.expiry_date) < minValid) {
        results.push({ type: "passport_expiry", severity: "high", title: "Passport expiry risk", message: "Passport may expire too soon for this trip." });
      }
    }

    const first = document.querySelector("[name='first_name']")?.value;
    const last = document.querySelector("[name='last_name']")?.value;
    if ((first && first.trim().toLowerCase() !== t.first_name.toLowerCase()) || (last && last.trim().toLowerCase() !== t.last_name.toLowerCase())) {
      results.push({ type: "name_mismatch", severity: "high", title: "Name mismatch", message: "Passenger name may not match saved travel document." });
    }

    if (MULTI_AIRPORT_CODES.has(trip.destinationAirport)) {
      results.push({ type: "multiple_airport", severity: "low", title: "Confirm airport", message: "This city has multiple airports. Confirm the correct airport." });
    }

    if (pageText.includes("invoice") && !pageText.includes("tax id")) {
      results.push({ type: "invoice_missing", severity: "medium", title: "Invoice details missing", message: "Company workspace is active and invoice fields may not be complete." });
    }

    return results;
  }

  function extractTripShallow() {
    const departureText = document.querySelector("[data-departure]")?.textContent?.trim();
    return {
      departureDate: departureText ? new Date(departureText) : null,
      destinationAirport: document.querySelector("[data-destination]")?.textContent?.trim()
    };
  }

  async function saveTrip() {
    const settings = await storageGet(["apiBase"]);
    const response = await fetch(`${settings.apiBase || DEFAULT_API}/trips`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(extractTrip())
    });
    if (!response.ok) throw new Error("Could not save trip");
    appData = await response.json();
    renderSidebar("saved");
  }

  function warningHtml() {
    const list = warnings.length ? warnings : runRiskChecks();
    if (!list.length) return "<p class='atw-muted'>No booking risks detected.</p>";
    return list.map((warning) => `
      <div class="atw-warning ${warning.severity}">
        <strong>${warning.title}</strong>
        <span>${warning.message}</span>
      </div>
    `).join("");
  }

  function paymentInstruction() {
    const preference = traveler()?.payment_preference || "browser saved card";
    const copy = {
      "browser saved card": "Use the browser's saved card autofill on the payment step. Air Travel Wallet will not fill card number or CVC.",
      "Apple Pay / Google Pay": "Use Apple Pay or Google Pay if the checkout offers it. Confirm the payment yourself.",
      "company virtual card": "Use your company virtual card provider for the card step. Keep final purchase confirmation manual.",
      "manual payment": "Payment is set to manual. Review the fare and complete payment yourself."
    };
    return copy[preference] || copy["browser saved card"];
  }

  function agentStatusHtml(map) {
    const label = agent.running
      ? agent.skipRoutineRunning
        ? "Acting"
        : "Thinking"
      : agent.awaiting
        ? "Waiting"
        : "Ready";
    const detail = agent.currentAction
      ? agent.currentAction
      : agent.awaiting === "extras"
      ? "Needs your choice on paid extras"
      : agent.awaiting === "final"
        ? "Paused before payment"
        : agent.awaiting === "manual"
          ? "Needs guidance"
          : `${map.step.replace(/_/g, " ")} · ${map.summary.buttons} actions`;
    return `
      <div class="atw-agent-live">
        <div class="atw-live-dot ${agent.running ? "is-running" : ""}"></div>
        <div>
          <strong>${label}</strong>
          <span>${detail}</span>
          ${agent.currentReason ? `<em>${agent.currentReason}</em>` : ""}
        </div>
      </div>
    `;
  }

  function agentChatHtml() {
    const shouldShowThread = Boolean(agent.awaiting) || !agent.running;
    const visibleMessages = shouldShowThread
      ? agent.messages
        .filter((message) => message.role === "user" || /failed|stopped|issue|ready|payment|confirm|debug|question|tell me|skip|continue|review|manually/i.test(message.text))
        .slice(-3)
      : [];
    const messages = visibleMessages.length
      ? visibleMessages
      : [{ role: "assistant", text: `I found ${routeSummary()}. Want me to complete checkout for ${traveler()?.first_name || "this traveler"}?` }];
    const map = agent.pageMap || buildPageMap();
    return `
      ${agentStatusHtml(map)}
      <div class="atw-map-line">Reading ${map.site}: ${map.step.replace(/_/g, " ")} · ${map.summary.knownFields}/${map.summary.fields} fields · ${map.summary.paidChoices} paid areas</div>
      ${shouldShowThread ? `
        <div class="atw-chat">
          ${messages.slice(-3).map((message) => `<div class="atw-message ${message.role}">${message.text}</div>`).join("")}
        </div>
      ` : `<div class="atw-mini-note">Live steps appear beside the moving AI cursor.</div>`}
      ${agentDecisionHtml()}
      <form id="atw-chat-form" class="atw-chat-form">
        <input id="atw-chat-input" placeholder="Type: continue, skip extras, stop..." />
        <button class="atw-primary" type="submit">Send</button>
      </form>
    `;
  }

  function agentDecisionHtml() {
    if (agent.awaiting === "extras") {
      const demoAddBag = inferCheckoutSite() === "demo" ? '<button id="atw-add-bag">Add cabin bag</button>' : "";
      return `
        <div class="atw-choice-grid">
          <button id="atw-stop">Review manually</button>
          <button class="atw-primary" id="atw-skip-extras">Skip paid extras</button>
          ${demoAddBag}
        </div>
      `;
    }
    if (agent.awaiting === "final") {
      if (inferCheckoutSite() === "demo") {
        return `
          <div class="atw-choice-grid">
            <button id="atw-stop">No, stop</button>
            <button class="atw-primary" id="atw-confirm-pay">Confirm demo payment</button>
          </div>
        `;
      }
      return `
        <div class="atw-choice-grid">
          <button id="atw-stop">Stop</button>
          <button class="atw-primary" id="atw-save-after-payment">Payment done, save</button>
        </div>
      `;
    }
    if (agent.awaiting === "manual") {
      return `
        <div class="atw-choice-grid">
          <button id="atw-stop">Stop</button>
          <button class="atw-primary" id="atw-retry">I fixed it, continue</button>
        </div>
        <button id="atw-skip-paid" class="atw-wide-action">Skip paid extras</button>
      `;
    }
    return "";
  }

  function renderSidebar(mode = "ready") {
    const t = traveler();
    const detected = bookingDetected();
    const root = document.getElementById("atw-sidebar") || document.createElement("aside");
    root.id = "atw-sidebar";
    root.innerHTML = `
      <div class="atw-panel">
        <div class="atw-head">
          <div>
            <h2>Air Travel Agent</h2>
            <p>${location.host}</p>
          </div>
          <span class="atw-pill">${mode === "saved" ? "Saved" : detected ? "Live" : "Idle"}</span>
        </div>
        <label class="atw-label">Traveler
          <select id="atw-traveler">
            ${appData.travelers.map((item) => {
              const name = [item.first_name, item.middle_name, item.last_name].filter(Boolean).join(" ");
              return `<option value="${item.id}" ${item.id === t.id ? "selected" : ""}>${name}</option>`;
            }).join("")}
          </select>
        </label>
        <div class="atw-buttons">
          <button class="atw-primary" id="atw-takeover" ${detected ? "" : "disabled"}>Start agent</button>
        </div>
        <div class="atw-agent-card">
          ${agentChatHtml()}
        </div>
        <details class="atw-details">
          <summary>Profile and logs</summary>
          <div class="atw-box">
            <strong>${t.first_name} ${t.last_name}</strong>
            <div class="atw-muted">${t.nationality} · ${t.document?.masked_document_number || "No document"} · expires ${t.document?.expiry_date || "not set"}</div>
          </div>
          <div class="atw-box">
            <strong>Payment helper</strong>
            <div class="atw-muted">${paymentInstruction()}</div>
          </div>
          <div class="atw-box">
            <strong>Booking rules</strong>
            <div class="atw-muted">${travelerRules() || "Ask before paid extras. Stop before real payment."}</div>
          </div>
          <button id="atw-copy-debug">Copy debug log</button>
          <button id="atw-save">Save confirmed trip</button>
          <div class="atw-box">
            <strong>Filled fields</strong>
            ${filledFields.length ? `<ul class="atw-list">${filledFields.map((field) => `<li>${field.fieldType} (${Math.round(field.confidence * 100)}%)</li>`).join("")}</ul>` : "<p class='atw-muted'>Nothing filled yet.</p>"}
          </div>
          <div>${warningHtml()}</div>
        </details>
      </div>
    `;
    if (!root.parentElement) document.body.appendChild(root);
    document.getElementById("atw-takeover").addEventListener("click", () => takeOverCheckout().catch((error) => alert(error.message)));
    document.getElementById("atw-copy-debug")?.addEventListener("click", () => copyDebugLog().catch((error) => alert(error.message)));
    document.getElementById("atw-save")?.addEventListener("click", () => saveTrip().catch((error) => alert(error.message)));
    document.getElementById("atw-skip-extras")?.addEventListener("click", () => handleAgentChoice("skip_extras"));
    document.getElementById("atw-add-bag")?.addEventListener("click", () => handleAgentChoice("add_bag"));
    document.getElementById("atw-confirm-pay")?.addEventListener("click", () => handleAgentChoice("confirm_pay"));
    document.getElementById("atw-save-after-payment")?.addEventListener("click", () => saveTrip().catch((error) => alert(error.message)));
    document.getElementById("atw-stop")?.addEventListener("click", () => handleAgentChoice("stop"));
    document.getElementById("atw-retry")?.addEventListener("click", () => handleAgentChoice("retry"));
    document.getElementById("atw-skip-paid")?.addEventListener("click", () => handleAgentChoice("skip_paid"));
    document.getElementById("atw-chat-form")?.addEventListener("submit", handleChatSubmit);
    document.getElementById("atw-traveler").addEventListener("change", async (event) => {
      selectedTravelerId = event.target.value;
      await chrome.storage.local.set({ selectedTravelerId });
      warnings = runRiskChecks();
      renderSidebar(mode);
    });
  }

  function watchForCheckoutChanges() {
    const observer = new MutationObserver((mutations) => {
      const pageChanged = mutations.some((mutation) => !mutation.target.closest?.("#atw-sidebar"));
      if (!pageChanged || renderTimer) return;
      renderTimer = setTimeout(() => {
        renderTimer = null;
        if (!filledFields.length) {
          warnings = runRiskChecks();
          renderSidebar();
        }
      }, 600);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  try {
    await fetchData();
    warnings = runRiskChecks();
    renderSidebar();
    watchForCheckoutChanges();
  } catch (error) {
    const root = document.createElement("aside");
    root.id = "atw-sidebar";
    root.innerHTML = `<div class="atw-panel"><h2>Air Travel Wallet</h2><p class="atw-muted">${error.message}</p></div>`;
    document.body.appendChild(root);
  }
})();
