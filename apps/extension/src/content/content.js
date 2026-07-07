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
  const SLOW_STEP_MS = 2200;
  const VERIFY_STEP_MS = 1400;
  const VALIDATION_TERMS = [
    "required",
    "must enter",
    "too long",
    "too short",
    "invalid",
    "not valid",
    "confirm",
    "missing",
    "select one option",
    "select an option",
    "choose one option",
    "please select",
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
    autopilotMode: true,
    pendingUserMessage: "",
    currentAction: "",
    currentReason: "",
    currentStage: "",
    actionHistory: [],
    sectionProgress: {},
    completedSections: {},
    completedFields: {},
    sectionPlan: [],
    taskQueue: [],
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

  function profileAllowsPaidExtras() {
    return /allow paid|add baggage|checked bag|seat selection|add extras|wants extras|buy insurance|add bundle/i.test(travelerRules());
  }

  function shouldAutoDeclinePaidExtras() {
    return agent.skipPaidExtrasApproved || prefersNoPaidExtras() || (agent.autopilotMode && !profileAllowsPaidExtras());
  }

  function resetSectionProgress() {
    agent.sectionProgress = {};
    agent.completedSections = {};
    agent.completedFields = {};
  }

  function markSectionDone(key, label = key) {
    agent.sectionProgress[key] = {
      status: "done",
      label,
      at: Date.now()
    };
    agent.completedSections[key] = {
      label,
      at: Date.now()
    };
    logAgentEvent("section_progress", { key, status: "done", label });
  }

  function sectionDone(key) {
    return agent.sectionProgress?.[key]?.status === "done";
  }

  function progressSummary() {
    return Object.values(agent.sectionProgress || {})
      .filter((item) => item.status === "done")
      .map((item) => item.label)
      .join(", ");
  }

  function rememberPagePlan(map) {
    agent.sectionPlan = map?.sections || [];
    agent.taskQueue = map?.taskQueue || [];
    return map;
  }

  function currentSectionTask(map, types = []) {
    const wanted = new Set(types);
    const task = (map.taskQueue || []).find((item) => item.status === "pending" && (!wanted.size || wanted.has(item.sectionType)));
    if (!task) return null;
    return (map.sections || []).find((section) => section.id === task.sectionId) || null;
  }

  function setAgentActivity(action, reason = "") {
    agent.currentAction = action;
    agent.currentReason = reason;
    const cursor = document.getElementById("atw-agent-cursor");
    if (cursor) {
      cursor.dataset.action = action ? action.slice(0, 80) : "working";
      cursor.dataset.reason = reason ? reason.slice(0, 520) : "";
    }
  }

  function pageContextSummary() {
    const map = agent.pageMap;
    if (!map) return `Context: ${inferCheckoutSite()} | ${location.pathname || location.hostname}`;
    return `Context: ${map.site} | ${map.step.replace(/_/g, " ")} | ${map.summary?.knownFields || 0}/${map.summary?.fields || 0} fields | ${map.summary?.paidChoices || 0} paid areas`;
  }

  function activeRuleSummary(stage = "", action = "") {
    const text = `${stage} ${action}`.toLowerCase();
    if (/payment|pay|final/.test(text)) return "Rule: payment/final booking needs explicit confirmation.";
    if (/dropdown|menu/.test(text)) return "Rule: finish the open dropdown before anything else.";
    if (/popup|modal/.test(text)) return "Rule: modal owns the next action.";
    if (/paid|extra|baggage|bundle|flexible|cancellation/.test(text)) return "Rule: saved preference says decline paid extras.";
    if (/continue|advance/.test(text)) return "Rule: Continue only after all required sections verify complete.";
    return "Rule: one action at a time, then verify.";
  }

  function inferLoopStep(stage = "", action = "") {
    const text = `${stage} ${action}`.toLowerCase();
    if (/observe|reading visible|reading page|queue/.test(text)) return "Observe";
    if (/understand|classify|meaning|recognized|detected/.test(text)) return "Understand";
    if (/planning|plan /.test(text)) return "Plan";
    if (/waiting|watching|settle|page update|dom|loading/.test(text)) return "Wait";
    if (/done:|checking:|verified|verify/.test(text)) return "Verify";
    if (/remember|accepted|stored|locked/.test(text)) return "Remember";
    if (/choosing|filling|clicking|selecting|opening|closing|confirming|type /.test(text)) return "Act";
    return "Understand";
  }

  function formatLoopBubble(loopStep, stage, action, detail = "") {
    return [
      `${loopStep}: ${stage || "current page"}`,
      detail,
      pageContextSummary(),
      activeRuleSummary(stage, action)
    ].filter(Boolean).join("\n");
  }

  async function showAgentThought(anchor, stage, action, reason = "", pause = SLOW_STEP_MS) {
    agent.currentStage = stage || agent.currentStage || "";
    const loopStep = inferLoopStep(stage, action);
    const detail = reason ? `Goal: ${reason}` : "";
    const bubble = formatLoopBubble(loopStep, stage, action, detail);
    setAgentActivity(`${loopStep} -> ${action}`, bubble);
    if (anchor) showAgentCursor(anchor, `${loopStep}: ${action}`, bubble);
    logAgentEvent("visible_step", { loopStep, stage, action, reason });
    renderSidebar("agent");
    await sleep(pause);
  }

  async function verifyAgentStep(anchor, stage, message, ok = true, pause = VERIFY_STEP_MS) {
    const action = ok ? `Done: ${message}` : `Checking: ${message}`;
    const detail = ok
      ? `Result: verified on the live page. Remember: do not change it again unless a specific error appears.`
      : "Result: not verified yet. Re-observe before the next action.";
    const bubble = formatLoopBubble(ok ? "Remember" : "Verify", stage, action, detail);
    setAgentActivity(`${ok ? "Remember" : "Verify"} -> ${action}`, bubble);
    if (anchor) showAgentCursor(anchor, `${ok ? "Remember" : "Verify"}: ${action}`, bubble);
    logAgentEvent("visible_verify", { stage, message, ok });
    renderSidebar("agent");
    await sleep(pause);
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
    showAgentCursor(input, "open dropdown");
    userLikeClick(input);
    await sleep(220);
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
        await settleAndHandleInterrupts("combobox option selected");
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
    element.focus();
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
    await sleep(360);
    await showAgentThought(element, "Field", `Filling ${fieldLabel}`, "Using saved traveler profile, then verifying the value sticks.", 900);
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
      await sleep(520);
      if (valueMatches(element, expected, mode)) {
        result.ok = true;
        result.method = "native-setter";
        result.actual = currentElementValue(element);
        recordAction("field_fill", result);
        setAgentActivity(`${fieldLabel} accepted`, "Moving to the next required item");
        await verifyAgentStep(element, "Field", `${fieldLabel} accepted`, true, 700);
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
    await fillPhoneFieldsFromMap(rememberPagePlan(buildPageMap()));
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

  function fillTitleRadio(root = document) {
    const title = travelerValue("title");
    if (!title) return false;
    const radios = queryAllDeep("input[type='radio']", root).filter((radio) => !radio.disabled && isVisible(radio));
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
    agent.completedFields.title = {
      actual: travelerValue("title"),
      at: Date.now()
    };
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
    if (type === "field_fill" && payload?.ok && payload.fieldType) {
      agent.completedFields[payload.fieldType] = {
        selector: payload.selector || "",
        actual: payload.actual || "",
        at: Date.now()
      };
    }
    if (type === "phone_fill") {
      agent.completedFields.phone_country_code = {
        actual: payload.countryCode || "",
        at: Date.now()
      };
      agent.completedFields.phone = {
        actual: `${payload.localDigits || 0} digits`,
        at: Date.now()
      };
    }
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
          page: compactPageMap(agent.pageMap || rememberPagePlan(buildPageMap()))
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
      const map = rememberPagePlan(buildPageMap());
      await fetch(`${settings.apiBase || DEFAULT_API}/agent/report`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: agent.sessionId,
          result: {
            ...result,
            stage: result.stage || map.step,
            errors: result.errors || actionableCheckoutErrors(map.errors)
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
      addAgentMessage("assistant", "Debug log copied with alternate clipboard method. Paste it here.");
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

  function normalizeMatchText(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/€|eur/g, " eur ")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function liveElementText(element) {
    if (!element) return "";
    return [
      currentElementValue(element),
      element.innerText,
      element.textContent,
      element.getAttribute?.("aria-label"),
      element.getAttribute?.("title"),
      labelText(element)
    ].filter(Boolean).join(" ");
  }

  function textMatchesIntent(element, intent) {
    const wanted = normalizeMatchText(intent);
    if (!wanted) return false;
    const actual = normalizeMatchText(liveElementText(element));
    if (!actual) return false;
    if (actual === wanted || actual.includes(wanted) || wanted.includes(actual)) return true;
    const wantedNoPrice = wanted.replace(/\b\d+(?:\s*[\.,]\s*\d+)?\s*(eur|usd|gbp|dollars?)\b/g, "").replace(/\s+/g, " ").trim();
    const actualNoPrice = actual.replace(/\b\d+(?:\s*[\.,]\s*\d+)?\s*(eur|usd|gbp|dollars?)\b/g, "").replace(/\s+/g, " ").trim();
    return Boolean(wantedNoPrice && actualNoPrice && (actualNoPrice.includes(wantedNoPrice) || wantedNoPrice.includes(actualNoPrice)));
  }

  function activeSurfaceEntries(map) {
    return [
      ...(map?.activeSurface?.options || []),
      ...(map?.activeSurface?.buttons || [])
    ].filter(Boolean);
  }

  function activeSurfaceEntryForElement(map, element) {
    if (!element) return null;
    const id = elementId(element);
    return activeSurfaceEntries(map).find((entry) => entry.id === id) || null;
  }

  function resolveDecisionTarget(decision, map) {
    const direct = elementById(decision.targetId);
    if (direct) return direct;

    const labels = [
      decision.value,
      decision.message,
      decision.reason,
      ...activeSurfaceEntries(map)
        .filter((entry) => entry.id === decision.targetId)
        .map((entry) => entry.label)
    ].filter(Boolean);

    for (const label of labels) {
      const entry = activeSurfaceEntries(map).find((item) => textMatchesIntent(elementById(item.id), label) || normalizeMatchText(item.label) === normalizeMatchText(label));
      const entryElement = elementById(entry?.id);
      if (entryElement) return entryElement;
    }

    const candidates = queryAllDeep([
      "button",
      "[role='button']",
      "[role='option']",
      "[role='menuitem']",
      "[role='checkbox']",
      "[role='radio']",
      "label",
      "input[type='checkbox']",
      "input[type='radio']"
    ].join(","))
      .filter((element) => isVisible(element) && !element.closest("#atw-sidebar"));

    for (const label of labels) {
      const target = candidates.find((element) => textMatchesIntent(element, label));
      if (target) return target;
    }

    return null;
  }

  function flashElement(element) {
    if (!element) return;
    element.classList.add("atw-highlight");
    setTimeout(() => element.classList.remove("atw-highlight"), 900);
  }

  function sectionContainer(element) {
    let current = element;
    for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
      if (current.closest?.("#atw-sidebar")) return element;
      const rect = current.getBoundingClientRect();
      const text = (current.innerText || current.textContent || "").replace(/\s+/g, " ").trim();
      if (isSummaryLikeElement(current)) continue;
      if (rect.width > 260 && rect.height > 90 && text.length > 20 && text.length < 1800) return current;
    }
    return element;
  }

  function cardContainerForControl(control, headingPattern) {
    let best = null;
    let current = control;
    for (let depth = 0; current && depth < 10; depth += 1, current = current.parentElement) {
      if (current.closest?.("#atw-sidebar")) break;
      const rect = current.getBoundingClientRect();
      const text = (current.innerText || current.textContent || "").replace(/\s+/g, " ").trim();
      if (rect.width < 260 || rect.height < 70 || !text) continue;
      if (headingPattern.test(text) && !isSummaryLikeElement(current)) {
        best = current;
        if (text.length > 120 && text.length < 2800) break;
      }
    }
    return best || sectionContainer(control);
  }

  function isSummaryLikeElement(element) {
    const text = (element?.innerText || element?.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
    if (!text) return false;
    const summarySignals = [/your order/, /price overview/, /total amount/, /amount to pay/, /departure.*return.*bags/];
    const hasSummarySignal = summarySignals.some((pattern) => pattern.test(text));
    if (!hasSummarySignal) return false;
    const decisionControls = queryAllDeep("input[type='radio'], input[type='checkbox'], select, [role='combobox']", element)
      .filter((control) => isVisible(control) && !control.closest("#atw-sidebar"));
    return decisionControls.length === 0;
  }

  function checkoutHeadingCount(text) {
    return [
      /contact information/i,
      /passenger\s+\d+/i,
      /select baggage/i,
      /upgrade your trip/i,
      /flexible ticket/i,
      /cancellation guarantee/i,
      /your order/i,
      /price overview/i
    ].filter((pattern) => pattern.test(text)).length;
  }

  function sectionPlanDescription(section) {
    const text = (section.element.innerText || section.element.textContent || "").replace(/\s+/g, " ").trim();
    const controls = queryAllDeep("input[type='radio'], input[type='checkbox'], select, [role='combobox'], button, [role='button']", section.element)
      .filter((control) => isVisible(control) && !control.closest("#atw-sidebar"));
    const required = /\*|select one option|choose your bundle|mobile number|first name|surname|title/i.test(text);
    const paid = /eur|bundle|flexible ticket|cancellation|baggage|add to cart/i.test(text);
    return `${section.label}: ${controls.length} controls${required ? ", required" : ""}${paid ? ", paid-choice" : ""}`;
  }

  function plannedTargetForSection(label) {
    const targets = {
      contact: "fill email, confirm email, country code, phone",
      passenger: "title, first name, surname",
      baggage: "choose no checked baggage",
      bundle: "choose bundle footer: No, thanks",
      "flexible ticket": "choose None of the passengers",
      cancellation: "choose No thanks",
      continue: "click Continue only after verification"
    };
    return targets[label] || "resolve required controls";
  }

  function clearSectionHighlights() {
    queryAllDeep(".atw-section-highlight").forEach((element) => element.classList.remove("atw-section-highlight"));
  }

  function clearSectionOutlines() {
    queryAllDeep(".atw-section-outline").forEach((element) => element.remove());
    queryAllDeep(".atw-section-outline-source").forEach((element) => element.classList.remove("atw-section-outline-source"));
  }

  function highlightSection(element, label = "section") {
    if (!element) return null;
    const container = sectionContainer(element);
    clearSectionHighlights();
    container.classList.add("atw-section-highlight");
    logAgentEvent("section_highlight", { label, text: (container.innerText || "").replace(/\s+/g, " ").slice(0, 180) });
    return container;
  }

  function displaySectionStatus(section) {
    if (section.type === "continue" || section.status === "gate") {
      return (agent.pageMap?.taskQueue || []).some((task) => task.status === "pending") ? "gate blocked" : "gate ready";
    }
    return section.status || "unknown";
  }

  function outlineCoreSections(sections = []) {
    clearSectionOutlines();
    const visibleSections = liveSectionModels(sections)
      .filter((section) => section.element && isVisible(section.element));
    visibleSections.forEach((section) => {
      const band = sectionBand(section, visibleSections);
      const rect = {
        left: band.left,
        top: band.top,
        width: Math.max(0, band.right - band.left),
        height: Math.max(0, band.bottom - band.top)
      };
      if (rect.width < 80 || rect.height < 35) return;
      section.element.classList.add("atw-section-outline-source");
      const outline = document.createElement("div");
      const visualStatus = displaySectionStatus(section);
      outline.className = `atw-section-outline is-${section.status || "unknown"}`;
      outline.style.left = `${Math.max(0, window.scrollX + rect.left)}px`;
      outline.style.top = `${Math.max(0, window.scrollY + rect.top)}px`;
      outline.style.width = `${Math.round(rect.width)}px`;
      outline.style.height = `${Math.round(rect.height)}px`;
      outline.innerHTML = `
        <span class="atw-section-badge">
          <strong>${section.order}</strong>
          ${section.label}
          <em>${visualStatus}</em>
        </span>
      `;
      document.body.appendChild(outline);
    });
    logAgentEvent("section_outlines", {
      sections: visibleSections.map((section) => ({
        order: section.order,
        label: section.label,
        status: section.status,
        objective: section.objective
      }))
    });
    return visibleSections;
  }

  function sectionAnchorByText(pattern) {
    return queryAllDeep("section, article, form, div, fieldset")
      .filter((element) => isVisible(element) && !element.closest("#atw-sidebar, .atw-section-outline, #atw-agent-cursor"))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const text = (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
        if (!text || text.length < 12 || text.length > 2600 || rect.width < 220 || rect.height < 45) return null;
        let score = pattern.test(text) ? 40 : 0;
        if (!score) return null;
        if (isSummaryLikeElement(element)) score -= 80;
        const matchingControls = queryAllDeep("input, select, button, [role='button'], [role='combobox']", element)
          .filter((control) => isVisible(control) && !control.closest("#atw-sidebar"))
          .filter((control) => pattern.test(`${labelText(control)} ${controlText(control)} ${buttonText(control)}`));
        if (matchingControls.length) score += 35;
        const decisionControls = queryAllDeep("input[type='radio'], input[type='checkbox'], select, [role='combobox']", element)
          .filter((control) => isVisible(control) && !control.closest("#atw-sidebar"));
        if (decisionControls.length) score += Math.min(24, decisionControls.length * 4);
        const headingCount = checkoutHeadingCount(text);
        if (headingCount > 1) score -= headingCount * 22;
        if (/configure your trip/i.test(text) && headingCount > 2) score -= 60;
        if (/your order|price overview|total amount/i.test(text)) score -= 60;
        score -= Math.max(0, text.length - 600) / 200;
        score -= Math.max(0, rect.width - 900) / 40;
        return { element, score, top: rect.top };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score || a.top - b.top)[0]?.element || null;
  }

  function elementRectArea(element) {
    const rect = element.getBoundingClientRect();
    return Math.max(0, rect.width) * Math.max(0, rect.height);
  }

  function sectionCardByPattern(pattern, controlPattern = pattern, options = {}) {
    const requiredPatterns = options.require || [];
    const rejectedPatterns = options.reject || [];
    const candidates = queryAllDeep("section, article, form, fieldset, div")
      .filter((element) => isVisible(element) && !element.closest("#atw-sidebar, .atw-section-outline, #atw-agent-cursor"))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const text = (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
        if (!text || rect.width < 280 || rect.height < 120 || text.length > 3600) return null;
        if (!pattern.test(text)) return null;
        if (requiredPatterns.some((item) => !item.test(text))) return null;
        if (rejectedPatterns.some((item) => item.test(text))) return null;
        if (isSummaryLikeElement(element)) return null;
        const controls = queryAllDeep("input[type='radio'], input[type='checkbox'], select, [role='combobox'], button, [role='button']", element)
          .filter((control) => isVisible(control) && !control.closest("#atw-sidebar"));
        const matchingControls = controls.filter((control) => controlPattern.test(`${labelText(control)} ${controlText(control)} ${buttonText(control)} ${choiceLabel(control)}`));
        if (options.requireMatchingControl && !matchingControls.length) return null;
        const declineControls = controls.filter((control) => /no,?\s*thanks|none of the passengers|no checked baggage|without|go without/i.test(`${labelText(control)} ${controlText(control)} ${buttonText(control)} ${choiceLabel(control)}`));
        let score = 80;
        score += Math.min(50, controls.length * 6);
        score += matchingControls.length ? 60 : 0;
        score += declineControls.length ? 55 : 0;
        if (/no,?\s*thanks|none of the passengers|no checked baggage/i.test(text)) score += 40;
        if (/add to cart|eur|€|\$|premium|bundle|flexible ticket|cancellation/i.test(text)) score += 20;
        const headingCount = checkoutHeadingCount(text);
        score -= headingCount > 1 ? headingCount * (options.strictSingleTopic ? 36 : 12) : 0;
        if (options.rejectHuge && rect.height > 900) score -= Math.max(0, rect.height - 900) / 6;
        score -= Math.abs(rect.width - 760) / 90;
        return { element, score, area: elementRectArea(element), top: rect.top };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score || b.area - a.area || a.top - b.top);
    return candidates[0]?.element || (options.noFallback ? null : sectionAnchorByText(pattern));
  }

  function fieldsetLikeSection(pattern, label = "") {
    const controls = candidateInputs()
      .filter((input) => isVisible(input) && !input.closest("#atw-sidebar"))
      .filter((input) => pattern.test(`${labelText(input)} ${controlText(input)}`));
    const anchors = controls
      .map((control) => cardContainerForControl(control, pattern))
      .filter(Boolean)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const text = (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
        const headingCount = checkoutHeadingCount(text);
        let score = 120;
        score += controls.filter((control) => element.contains(control)).length * 30;
        score -= headingCount > 1 ? headingCount * 35 : 0;
        score -= Math.max(0, text.length - 900) / 12;
        if (label === "contact" && /passenger\s+\d+|select baggage|configure your trip/i.test(text)) score -= 120;
        if (label === "passenger" && /select baggage|configure your trip/i.test(text)) score -= 120;
        return { element, score, top: rect.top, area: rect.width * rect.height };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.area - b.area);
    return anchors[0]?.element || sectionAnchorByText(pattern);
  }

  function continueSectionElement() {
    const button = findSafeContinueButton()
      || queryAllDeep("button, a, input[type='button'], input[type='submit'], [role='button']")
        .filter((element) => isVisible(element) && !element.closest("#atw-sidebar"))
        .filter((element) => meaningfulActionBox(elementBox(element)))
        .find((element) => /^continue$/i.test(buttonText(element)) || /\bcontinue\b/i.test(buttonText(element)));
    return button ? sectionContainer(button) : sectionAnchorByText(/we protect your personal data|continue/i);
  }

  function detectCheckoutSections() {
    const patterns = [
      ["contact", /contact information|provide your contact details|e-?mail|mobile number/i, () => fieldsetLikeSection(/e-?mail|confirm e-?mail|mobile number|phone/i, "contact")],
      ["passenger", /passenger\s+\d+|traveller information|traveler information|first name|surname|passport/i, () => fieldsetLikeSection(/title|first name|surname|passport/i, "passenger")],
      ["baggage", /select baggage|checked baggage|hand baggage|personal item/i, null],
      ["bundle", /bundle|premium support|airhelp|booking number by sms/i, () => sectionCardByPattern(
        /upgrade your trip|choose your bundle|premium support|airhelp|booking number by sms/i,
        /no,?\s*thanks|standard|premium|premium\+|bundle/i,
        {
          require: [/choose your bundle/i],
          reject: [/flexible ticket|cancellation guarantee|voucher refund/i],
          requireMatchingControl: true,
          strictSingleTopic: true,
          rejectHuge: true,
          noFallback: true
        }
      )],
      ["flexible ticket", /flexible ticket|change your ticket/i, () => sectionCardByPattern(
        /flexible ticket|change your ticket/i,
        /choose|none of the passengers|no,?\s*thanks|add to cart/i,
        {
          require: [/flexible ticket/i, /select one option|select an option|choose|none of the passengers/i],
          reject: [/upgrade your trip|choose your bundle|cancellation guarantee|voucher refund/i],
          requireMatchingControl: true,
          strictSingleTopic: true,
          rejectHuge: true,
          noFallback: true
        }
      )],
      ["cancellation", /cancellation guarantee|voucher refund/i, () => sectionCardByPattern(
        /cancellation guarantee|voucher refund/i,
        /no,?\s*thanks|add to cart/i,
        {
          require: [/cancellation guarantee|voucher refund/i, /select one option|select an option|no,?\s*thanks|add to cart/i],
          reject: [/upgrade your trip|choose your bundle|flexible ticket/i],
          requireMatchingControl: true,
          strictSingleTopic: true,
          rejectHuge: true,
          noFallback: true
        }
      )]
    ];
    const seen = new Set();
    return patterns
      .map(([label, pattern, resolver]) => {
        const element = resolver ? resolver() : sectionAnchorByText(pattern);
        if (!element) return null;
        const id = elementId(element);
        if (seen.has(id)) return null;
        seen.add(id);
        return { label, element, box: elementBox(element) };
      })
      .filter(Boolean)
      .sort((a, b) => a.box.y - b.box.y);
  }

  function liveSectionModels(sections = []) {
    return sections
      .map((section) => {
        const element = elementById(section.id) || section.element;
        if (!element) return null;
        return { ...section, element, box: elementBox(element) };
      })
      .filter(Boolean)
      .sort((a, b) => a.box.y - b.box.y);
  }

  function sectionBand(section, allSections = []) {
    const ordered = [...allSections].sort((a, b) => a.box.y - b.box.y);
    const index = ordered.findIndex((item) => item.element === section.element || item.label === section.label && item.box.y === section.box.y);
    const next = index >= 0 ? ordered[index + 1] : null;
    const top = section.box.y - 24;
    const bottom = next ? next.box.y - 14 : section.box.y + section.box.height + 160;
    return {
      top,
      bottom: Math.max(bottom, section.box.y + section.box.height + 28),
      left: section.box.x - 56,
      right: section.box.x + section.box.width + 56
    };
  }

  function elementBelongsToSectionBand(element, section, allSections = []) {
    if (!element || !section?.element) return false;
    if (section.element.contains(element)) return true;
    const box = elementBox(element);
    const liveSections = liveSectionModels(allSections.length ? allSections : [section]);
    const liveSection = liveSections.find((item) => item.id === section.id || item.element === section.element) || section;
    const band = sectionBand(liveSection, liveSections.length ? liveSections : allSections);
    if (box.width < 8 || box.height < 8) return false;
    const verticallyInside = box.centerY >= band.top && box.centerY < band.bottom;
    const horizontallyNear = box.centerX >= band.left && box.centerX <= band.right;
    return verticallyInside && horizontallyNear;
  }

  function meaningfulActionBox(box = {}) {
    if (!box) return false;
    if (box.width < 24 || box.height < 16) return false;
    if (box.centerX < -200 || box.centerX > window.innerWidth + 200) return false;
    return true;
  }

  function sectionTypeFor(label, text = "") {
    const source = `${label} ${text}`.toLowerCase();
    if (/contact|e-?mail|mobile/.test(source)) return "contact";
    if (/passenger|traveller|traveler|surname|first name|passport|title/.test(source)) return "passenger";
    if (/baggage|bag|personal item|hand baggage|checked/.test(source)) return "baggage";
    if (/bundle|premium support|airhelp|sms/.test(source)) return "bundle";
    if (/flexible ticket|reschedule|change your ticket/.test(source)) return "flexible_ticket";
    if (/cancellation|voucher refund|insurance|refund/.test(source)) return "cancellation_insurance";
    if (/continue|protect your personal data/.test(source)) return "continue";
    if (/seat|reserve seating|seat map/.test(source)) return "seat";
    if (/payment|pay|card|cvc/.test(source)) return "payment";
    return "unknown";
  }

  function sectionFieldModels(section, fields, allSections = []) {
    return fields
      .filter((field) => field.element && elementBelongsToSectionBand(field.element, section, allSections))
      .map((field) => ({
        id: field.id,
        label: field.label,
        field: field.field,
        kind: field.kind,
        semantic: semanticFieldType(field),
        required: field.required,
        hasValue: Boolean(field.value),
        value: field.value ? "[filled]" : "",
        box: field.box
      }));
  }

  function semanticFieldType(field) {
    const text = `${field.label || ""} ${field.kind || ""} ${field.value || ""}`.toLowerCase();
    if (field.field && field.field !== "unknown") return field.field;
    if (/choose|select an option|select one option/.test(text)) return "required_dropdown_choice";
    if (/email/.test(text)) return "email";
    if (/phone|mobile/.test(text)) return "phone";
    if (/first|given/.test(text)) return "first_name";
    if (/surname|last|family/.test(text)) return "last_name";
    return "unknown";
  }

  function sectionButtonModels(section, buttons, allSections = []) {
    return buttons
      .filter((button) => button.element && elementBelongsToSectionBand(button.element, section, allSections))
      .map((button) => ({
        id: button.id,
        label: button.label,
        risk: button.risk,
        box: button.box
      }));
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

  function isChoiceSelected(input) {
    if (!input) return false;
    return Boolean(
      input.checked ||
      input.getAttribute?.("aria-checked") === "true" ||
      input.getAttribute?.("aria-selected") === "true" ||
      /\b(is-)?(selected|checked|active)\b/i.test(String(input.className || ""))
    );
  }

  function choiceLabel(input) {
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

  function semanticChoiceType(label = "") {
    const text = label.toLowerCase();
    if (/no checked baggage|no baggage|without baggage|i.ll go without|go without/.test(text)) return "decline_baggage";
    if (/no,?\s*thanks|none of the passengers|none\b|without/.test(text)) return "decline_paid_extra";
    if (/add to cart|add to my trip|premium|bundle|checked baggage|\b\d+\s*x\s*\d+\s*kg|eur|€|\$/.test(text)) return "add_paid_extra";
    if (/continue|next|proceed/.test(text)) return "continue";
    if (/mr|mrs|ms|title/.test(text)) return "traveler_title";
    return "choice";
  }

  function sectionChoiceModels(section, allSections = []) {
    return sectionChoiceInputs(section, allSections)
      .map((input) => {
        const label = choiceLabel(input);
        return {
          id: elementId(input),
          label,
          selected: Boolean(isChoiceSelected(input)),
          semantic: semanticChoiceType(label),
          box: elementBox(input)
        };
      })
      .filter((choice) => choice.label)
      .slice(0, 20);
  }

  function unfilledRequiredFields(fields = []) {
    return fields.filter((field) => field.required && field.field !== "unknown" && !field.hasValue);
  }

  function inferSectionStatus(section, fields, buttons, allSections = []) {
    const type = sectionTypeFor(section.label, section.text);
    const selected = selectedControlLabels(section, allSections);
    const lower = section.text.toLowerCase();
    const requiredMissing = unfilledRequiredFields(fields);
    const hasSelectPlaceholder = queryAllDeep("select, [role='combobox']", section.element)
      .filter((control) => isVisible(control) && !control.closest("#atw-sidebar"))
      .some((control) => /choose|select/.test(currentElementValue(control).toLowerCase() || controlText(control).toLowerCase()));
    const hasDecisionPrompt = /select one option|select an option|choose one option|please select/.test(lower);
    const hasValidationText = /must enter|invalid|not valid|too long|too short/.test(lower)
      || (/\bfield required\b/.test(lower) && requiredMissing.length > 0)
      || hasDecisionPrompt;

    if (type === "contact" || type === "passenger") {
      const stillMissing = requiredMissing.length || /must enter|invalid|not valid|too long|too short/.test(lower);
      return stillMissing ? "incomplete" : "complete";
    }
    if (type === "baggage") {
      const choices = sectionChoiceInputs(section, allSections);
      const checkedFields = checkedFieldLabels(fields);
      const hasBaggageDecision = choices.some((input) => /baggage|checked|kg|without|no checked/i.test(choiceLabel(input)));
      const selectedNoBaggage = [...selected, ...checkedFields].some((label) => /no checked baggage|no baggage|without/i.test(label));
      if (hasBaggageDecision) return selectedNoBaggage ? "complete" : "incomplete";
      return /checked baggage\s+no baggage selected/i.test(lower) && !hasValidationText ? "complete" : "incomplete";
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
      const sectionFields = sectionFieldModels(section, fields, sections);
      const sectionButtons = sectionButtonModels(section, buttons, sections);
      let status = inferSectionStatus({ ...section, text }, sectionFields, sectionButtons, sections);
      if (type !== "continue" && sectionDone(type) && status !== "incomplete" && status !== "blocked") status = "complete";
      const paidChoice = /eur|€|\$|add to cart|premium|bundle|insurance|cancellation|flexible|checked baggage|paid/i.test(text);
      return {
        id: elementId(section.element),
        label: section.label,
        type,
        order: index + 1,
        status,
        required: /required|\*|select one option|choose your bundle|mobile number|first name|surname|title/i.test(text),
        paidChoice,
        objective: sectionObjective(section, type, status),
        selected: selectedControlLabels(section, sections),
        choices: sectionChoiceModels(section, sections),
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

  function buildStageExit(taskQueue, buttons, overlays, errors, step) {
    const continueButton = buttons.find((button) => (
      button.risk === "safe_continue" &&
      !/skip to/i.test(button.label || "") &&
      meaningfulActionBox(button.box)
    ));
    const blockers = [];
    if (taskQueue.some((task) => task.status === "pending")) blockers.push(`pending: ${taskQueue.find((task) => task.status === "pending")?.sectionLabel}`);
    if (overlays.length) blockers.push("visible overlay/menu/modal");
    if (actionableCheckoutErrors(errors).length) blockers.push(`visible errors: ${actionableCheckoutErrors(errors).slice(0, 2).join("; ")}`);
    if (!continueButton) blockers.push("no safe Continue button");
    return {
      continueAllowed: Boolean(
        continueButton &&
        !taskQueue.some((task) => task.status === "pending") &&
        !overlays.length &&
        !actionableCheckoutErrors(errors).length &&
        !["payment", "confirmation"].includes(step)
      ),
      continueTargetId: continueButton?.id || "",
      blockers
    };
  }

  async function announceSectionQueue() {
    const map = agent.pageMap || buildPageMap();
    const sections = map.sections || [];
    const label = sections.map((section) => `${section.order}. ${section.label}`).join(" -> ") || "current visible checkout page";
    const details = sections.map((section) => `${section.order}. ${section.label}: ${section.status} -> ${section.objective}`).join("\n");
    outlineCoreSections(sections);
    const anchor = elementById(sections[0]?.id) || queryAllDeep("main, form, body").find(isVisible) || document.body;
    const section = highlightSection(anchor, "page structure");
    await showAgentThought(section, "Observe", "Reading visible checkout sections", `Visible text, inputs, buttons, dropdowns, radios, checkboxes, prices, errors, URL, scroll, and coordinates.`);
    await showAgentThought(section, "Plan", "Outlined core checkout sections", `Order: ${label}\nTargets:\n${details}`);
    addAgentMessage("assistant", `Outlined core checkout sections on the page: ${label}`);
    logAgentEvent("section_plan", { order: sections.map((section) => section.label), tasks: map.taskQueue || [], details });
    return sections;
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
    cursor.dataset.action = derivedLabel ? derivedLabel.slice(0, 80) : "working";
    cursor.dataset.reason = reason ? reason.slice(0, 520) : (agent.currentReason || "").slice(0, 520);
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

  async function waitForPaint(ms = 300) {
    await sleep(ms);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }

  function pressEscape(target = document.activeElement || document.body) {
    const eventInit = { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true, cancelable: true };
    target?.dispatchEvent?.(new KeyboardEvent("keydown", eventInit));
    document.dispatchEvent(new KeyboardEvent("keydown", eventInit));
    target?.dispatchEvent?.(new KeyboardEvent("keyup", eventInit));
    document.dispatchEvent(new KeyboardEvent("keyup", eventInit));
    target?.blur?.();
  }

  function clickViewportPoint(x = 18, y = 18) {
    const target = document.elementFromPoint(x, y) || document.body;
    const eventInit = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: x,
      clientY: y
    };
    target.dispatchEvent(new PointerEvent("pointerdown", eventInit));
    target.dispatchEvent(new MouseEvent("mousedown", eventInit));
    target.dispatchEvent(new PointerEvent("pointerup", eventInit));
    target.dispatchEvent(new MouseEvent("mouseup", eventInit));
    target.dispatchEvent(new MouseEvent("click", eventInit));
  }

  function transientOverlayOpen() {
    return activeOverlayElements().some((overlay) => isTransientChoiceOverlay(overlay));
  }

  async function waitForUiSettle(ms = 650) {
    await showAgentThought(document.activeElement || document.body, "Wait", "Watching page update", "Waiting for popups, dropdowns, validation, price/order changes, or URL changes.", 600);
    await waitForPaint(ms);
  }

  function activeDemoStepName() {
    return queryAllDeep("[data-checkout-step].is-active")[0]?.dataset.checkoutStep || "";
  }

  function findSafeContinueButton() {
    const buttons = queryAllDeep("button, a, input[type='button'], input[type='submit']").filter(isVisible);
    return buttons.find((button) => {
      if (button.closest("#atw-sidebar")) return false;
      if (!meaningfulActionBox(elementBox(button))) return false;
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
      .filter((element) => element.id !== "atw-sidebar" && element.id !== "atw-agent-cursor" && !element.classList?.contains("atw-section-outline"))
      .map((element) => element.innerText || element.textContent || "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function primaryPageText() {
    const activeModal = activeOverlayElements().find((overlay) => !isTransientChoiceOverlay(overlay));
    if (activeModal) {
      const text = overlayText(activeModal);
      if (text.length > 40) return text;
    }
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
    const strongSeatEvidence = /reserve seating|seat map|seat map key|standard seat|not selected|select a seat|choose a seat/.test(lower);
    const travelerRouteEvidence = /\/rf\/traveler-details|\/rf\/traveller-details|traveler-details|traveller-details/.test(lower);
    const paymentFormEvidence = /card number|security code|cvc|cvv|pay now|complete booking|confirm and pay|submit payment|billing card|cardholder/.test(lower);
    const paymentRouteEvidence = /\/rf\/payment|\/payment\b|[#?&/]payment\b/.test(lower);

    if (/booking confirmed|confirmation|booking reference|reservation number|pnr/.test(lower)) return "confirmation";
    if (paymentFormEvidence) return "payment";
    if (strongSeatEvidence) return "seats";
    if (travelerRouteEvidence) return "traveler_information";
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
    return activeOverlayElements()
      .map((element) => {
        const text = overlayText(element);
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

  function isInViewport(element) {
    const rect = element.getBoundingClientRect();
    return rect.bottom >= 0 && rect.right >= 0 && rect.top <= window.innerHeight && rect.left <= window.innerWidth;
  }

  function activeOverlayElements() {
    const selectors = "[role='dialog'], [aria-modal='true'], [role='listbox'], [role='menu'], [data-headlessui-state], .modal, .popover";
    const explicit = queryAllDeep(selectors);
    const floating = queryAllDeep("body *")
      .filter((element) => {
        if (!isVisible(element) || element.closest("#atw-sidebar")) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const text = overlayText(element);
        if (!/fixed|absolute/.test(style.position)) return false;
        if (!isInViewport(element) || rect.width < 260 || rect.height < 120) return false;
        if (!text || text.length > 5000) return false;
        if (!overlayButtons(element).length) return false;
        const z = Number.parseInt(style.zIndex || "0", 10);
        return Number.isNaN(z) || z >= 1;
      });
    const candidates = [...new Set([...explicit, ...floating])]
      .filter((element) => isVisible(element) && !element.closest("#atw-sidebar"))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        if (rect.width < 12 || rect.height < 12) return false;
        const text = overlayText(element);
        const role = element.getAttribute("role") || "";
        const style = getComputedStyle(element);
        const modal = element.getAttribute("aria-modal") === "true" || role === "dialog";
        const menu = role === "listbox" || role === "menu";
        const expanded = element.getAttribute("aria-expanded") === "true";
        const hasVisibleOption = queryAllDeep("[role='option']", element).some(isVisible);
        const floating = /fixed|absolute|sticky/.test(style.position);
        if (role === "option" || role === "combobox") return false;
        if (modal) return Boolean(text);
        if (!isInViewport(element)) return false;
        if (/fixed|absolute/.test(style.position) && overlayButtons(element).length && text.length < 5000) return true;
        if (menu || expanded || hasVisibleOption) return Boolean(text || role);
        if (element.matches(".modal,.popover") || floating) return Boolean(text);
        return false;
      });
    return candidates.filter((element) => !candidates.some((other) => other !== element && other.contains(element)));
  }

  function overlayText(element) {
    if (!element) return "";
    return (element.innerText || element.textContent || element.getAttribute("aria-label") || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function buttonText(element) {
    return (element?.innerText || element?.textContent || element?.value || element?.getAttribute?.("aria-label") || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function overlayChoiceText(element) {
    if (!element) return "";
    const direct = buttonText(element) || choiceLabel(element) || labelText(element) || controlText(element);
    if (direct && direct.trim() && !/^(on|true|false)$/i.test(direct.trim())) {
      return direct.replace(/\s+/g, " ").trim();
    }
    const row = element.closest?.("label, li, tr, [role='option'], [role='checkbox'], [role='radio'], [data-headlessui-state], div");
    return (row?.innerText || row?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function overlayChoiceTarget(element) {
    if (!element) return null;
    if (element.matches?.("input[type='checkbox'], input[type='radio']")) {
      return element.closest("label, [role='option'], li, [role='checkbox'], [role='radio']") || element;
    }
    return clickableAncestor(element) || element.closest?.("label, [role='option'], li, [role='checkbox'], [role='radio']") || element;
  }

  function overlayButtons(overlay) {
    return queryAllDeep("button, [role='button'], [role='option'], [role='checkbox'], [role='radio'], li, label, input[type='checkbox'], input[type='radio'], input[type='button'], input[type='submit']", overlay.shadowRoot || overlay)
      .map((button) => overlayChoiceTarget(button))
      .filter((button, index, list) => button && list.indexOf(button) === index)
      .filter((button) => isVisible(button) && !button.closest("#atw-sidebar"));
  }

  function isTransientChoiceOverlay(overlay) {
    const role = overlay.getAttribute("role") || "";
    const text = overlayText(overlay).toLowerCase();
    if (role === "listbox" || role === "menu") return true;
    return /slovenia\s*\(\+386\)|sierra leone\s*\(\+232\)|singapore\s*\(\+65\)|sint maarten|country code|calling code/.test(text);
  }

  function routineExtraOverlayKind(text, task = null) {
    const lower = String(text || "").toLowerCase();
    if (/seat|reserve seating|seat map/.test(lower)) return "seat selection popup";
    if (/checked baggage|baggage|bag allowance|without baggage/.test(lower)) return "baggage popup";
    if (/bundle|premium support|airhelp|sms|booking number by sms/.test(lower)) return "bundle popup";
    if (/flexible ticket|change your ticket|reschedule/.test(lower)) return "flexible ticket popup";
    if (/cancellation|voucher refund|insurance|refund product/.test(lower)) return "insurance/refund popup";
    if (/add to my trip|add to cart|paid extra|add-?on/.test(lower)) return "paid extra popup";
    if (task?.sectionType === "seat") return "seat selection popup";
    if (task?.sectionType === "baggage") return "baggage popup";
    if (task?.sectionType === "bundle") return "bundle popup";
    if (task?.sectionType === "flexible_ticket") return "flexible ticket popup";
    if (task?.sectionType === "cancellation_insurance") return "insurance/refund popup";
    return "";
  }

  function scoreAutoDeclineButton(button, overlayKind = "") {
    const label = overlayChoiceText(button).toLowerCase();
    if (!label) return 0;
    if (/flexible ticket popup/.test(overlayKind) && /none of the passengers|none\s+of\s+the\s+travellers|none\s+of\s+the\s+travelers|0\s*eur|0\s*€/.test(label)) return 160;
    if (/flexible ticket popup/.test(overlayKind) && /all passengers|all travellers|all travelers|\badult\b/.test(label) && !/none/.test(label)) return -120;
    if (/i.ll go without|go without|without baggage|without seat|continue without/.test(label)) return 120;
    if (/no thanks|no, thanks|not now|skip|decline|none of the passengers|no seat|random seat/.test(label)) return 110;
    if (/next|continue/.test(label) && /seat selection popup|seat/.test(overlayKind)) return 70;
    if (/next|continue/.test(label) && /baggage popup|flexible ticket popup|insurance\/refund popup|bundle popup|paid extra popup/.test(overlayKind)) return 55;
    if (/add|buy|select|upgrade|premium|cart|trip|choose/.test(label)) return -80;
    return 0;
  }

  function overlaySignature(overlay) {
    if (!overlay || !document.contains(overlay) || !isVisible(overlay)) return "";
    const role = overlay.getAttribute("role") || "";
    const rect = overlay.getBoundingClientRect();
    const selectedState = overlayButtons(overlay)
      .map((button) => `${normalizeMatchText(overlayChoiceText(button)).slice(0, 80)}:${isChoiceSelected(button) || button.getAttribute?.("aria-selected") === "true" || button.getAttribute?.("aria-checked") === "true" ? "1" : "0"}`)
      .join(";");
    return [
      role,
      Math.round(rect.left),
      Math.round(rect.top),
      Math.round(rect.width),
      Math.round(rect.height),
      selectedState,
      overlayText(overlay).slice(0, 1200)
    ].join("|");
  }

  async function waitForOverlayProgress(overlay, beforeSignature, timeout = 2200) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      await waitForPaint(240);
      const overlays = activeOverlayElements();
      if (!overlays.length) return { ok: true, reason: "overlay closed" };
      if (!overlay || !document.contains(overlay) || !isVisible(overlay)) {
        return { ok: true, reason: "overlay removed" };
      }
      if (!overlays.includes(overlay)) return { ok: true, reason: "active overlay changed" };
      const afterSignature = overlaySignature(overlay);
      if (beforeSignature && afterSignature && afterSignature !== beforeSignature) {
        return { ok: true, reason: "overlay content changed" };
      }
    }
    return { ok: false, reason: "overlay did not change" };
  }

  function uniqueOverlayCandidates(items) {
    const seen = new Set();
    return items.filter((item) => {
      const key = `${normalizeMatchText(item.label)}:${Math.round(item.button.getBoundingClientRect().top / 8)}`;
      if (!normalizeMatchText(item.label) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  async function handleRoutineExtraOverlay(overlay, context = "", task = null) {
    const text = overlayText(overlay);
    const kind = routineExtraOverlayKind(text, task);
    if (!kind || !shouldAutoDeclinePaidExtras()) return false;
    const candidates = uniqueOverlayCandidates(overlayButtons(overlay)
      .map((button) => ({ button, score: scoreAutoDeclineButton(button, kind), label: overlayChoiceText(button) }))
      .filter((item) => item.score > 0 && !item.button.disabled && item.button.getAttribute("aria-disabled") !== "true")
      .sort((a, b) => b.score - a.score));
    for (const pick of candidates.slice(0, 5)) {
      const before = overlaySignature(overlay);
      await showAgentThought(
        pick.button,
        "Interrupt",
        `Handle ${kind}`,
        `Saved rules say no paid seats/extras. Trying "${pick.label}" and verifying the popup changes before moving on.`,
        900
      );
      flashElement(pick.button);
      userLikeClick(pick.button);
      recordAction("auto_decline_overlay", { context, kind, label: pick.label });
      const progress = await waitForOverlayProgress(overlay, before, 1800);
      await verifyAgentStep(pick.button, "Interrupt", `${kind}: ${progress.reason}`, progress.ok, 600);
      if (progress.ok) return true;
    }
    return false;
  }

  async function closeTransientOverlay(overlay, context = "") {
    if (!isTransientChoiceOverlay(overlay)) return false;
    await showAgentThought(
      overlay,
      "Interrupt",
      "Close open menu",
      `The control menu is still open after ${context || "the last action"}; closing it before the next step.`,
      650
    );
    const active = document.activeElement || document.body;
    pressEscape(active);
    dispatchKey(active, "Escape");
    await waitForPaint(500);
    if (!transientOverlayOpen()) {
      await verifyAgentStep(overlay, "Interrupt", "open menu closed", true, 500);
      return true;
    }
    active?.blur?.();
    clickViewportPoint(18, 18);
    await waitForPaint(650);
    if (!transientOverlayOpen()) {
      await verifyAgentStep(document.body, "Interrupt", "open menu closed by outside click", true, 500);
      return true;
    }
    pressEscape(document.body);
    await waitForPaint(650);
    const closed = !transientOverlayOpen();
    await verifyAgentStep(document.body, "Interrupt", closed ? "open menu closed" : "open menu still open", closed, 500);
    return closed;
  }

  async function settleAndHandleInterrupts(context = "") {
    await showAgentThought(document.activeElement || document.body, "Wait", "Letting the page react", `After ${context || "the last action"}: check modal, dropdown, loading, errors, disabled buttons, and DOM changes.`, 700);
    await waitForPaint(1200);
    const overlays = activeOverlayElements();
    if (overlays.length) {
      logAgentEvent("interrupt_detected", {
        context,
        overlays: overlays.map((overlay) => overlayText(overlay).slice(0, 160)).slice(0, 4)
      });
      const overlay = overlays[0];
      const map = agent.pageMap || buildPageMap();
      const task = (map.taskQueue || []).find((item) => item.status === "pending" && /baggage|bundle|flexible_ticket|cancellation_insurance|seat/.test(item.sectionType));
      const activeSurface = buildActiveSurface([overlay]);
      if (/agent loop/i.test(context) && shouldDeferActiveSurfaceToAgent(activeSurface)) {
        logAgentEvent("active_surface_deferred", {
          context,
          type: activeSurface.type,
          taskHint: activeSurface.taskHint,
          options: activeSurface.options.map((option) => ({
            label: option.label,
            risk: option.risk,
            semantic: option.semantic
          })).slice(0, 8)
        });
        await showAgentThought(
          overlay,
          "Observe",
          "Active surface",
          "This open popup/dropdown is the active screen. I will send its visible options to the visual agent before doing any local fallback.",
          750
        );
        return { blocked: false, handled: false, overlays: overlays.length, activeSurface };
      }
      if (await handleRoutineExtraOverlay(overlay, context, task)) {
        await waitForPaint(500);
        return { blocked: false, handled: true, overlays: overlays.length };
      }
      if (await closeTransientOverlay(overlay, context)) {
        await waitForPaint(400);
        return { blocked: false, handled: true, overlays: overlays.length };
      }
      await showAgentThought(overlay, "Observe", "Interrupt detected", "A popup or modal is active and I do not have a safe automatic choice. I will stop background actions and ask the AI/user only about this popup.", 1000);
      return { blocked: true, handled: false, overlays: overlays.length };
    }
    await waitForPaint(500);
    return { blocked: false, handled: false, overlays: overlays.length };
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

  function overlayOptionSemantic(label = "") {
    const text = String(label || "").toLowerCase();
    if (/none of the passengers|none of the travellers|none of the travelers|no,?\s*thanks|not now|skip|decline|go without|without/.test(text)) {
      return "decline_paid_extra";
    }
    if (/0\s*(eur|€|usd|\$)|free/.test(text) && !/all passengers|adult/.test(text)) return "decline_paid_extra";
    if (/all passengers|all travellers|all travelers|\badult\b|add|cart|upgrade|premium|\b[1-9]\d*([.,]\d+)?\s*(eur|€|usd|\$)/.test(text)) {
      return "add_paid_extra";
    }
    return "choice";
  }

  function overlayOptionRisk(label = "") {
    const semantic = overlayOptionSemantic(label);
    if (semantic === "decline_paid_extra") return "safe_decline";
    if (semantic === "add_paid_extra") return "paid";
    return "unknown";
  }

  function activeSurfaceEntries(surface) {
    return [...(surface?.options || []), ...(surface?.buttons || [])]
      .filter((entry, index, list) => entry?.id && list.findIndex((item) => item?.id === entry.id) === index);
  }

  function activeSurfaceHasSafeChoice(surface) {
    return activeSurfaceEntries(surface).some((entry) => {
      const label = entry.label || "";
      return entry.risk === "safe_decline"
        || entry.semantic === "decline_paid_extra"
        || /none of the passengers|none of the travellers|none of the travelers|no,?\s*thanks|not now|skip|decline|go without|without|0\s*(eur|€|usd|\$)/i.test(label);
    });
  }

  function activeSurfaceLooksDangerous(surface) {
    const text = `${surface?.label || ""} ${activeSurfaceEntries(surface).map((entry) => entry.label).join(" ")}`;
    return /pay now|submit payment|confirm payment|confirm booking|complete booking|book now|accept terms|terms and conditions/i.test(text);
  }

  function shouldDeferActiveSurfaceToAgent(surface) {
    if (!surface || surface.type === "page") return false;
    if (activeSurfaceLooksDangerous(surface) && !activeSurfaceHasSafeChoice(surface)) return false;
    return true;
  }

  function buildActiveSurface(overlays = activeOverlayElements()) {
    const overlay = overlays[0];
    if (!overlay) {
      return {
        type: "page",
        id: "",
        label: "",
        role: "",
        taskHint: "",
        options: [],
        buttons: [],
        box: null
      };
    }
    const role = overlay.getAttribute("role") || "";
    const text = overlayText(overlay);
    const type = isTransientChoiceOverlay(overlay) ? "dropdown" : /dialog|modal/i.test(role) || overlay.getAttribute("aria-modal") === "true" ? "modal" : "popover";
    const map = agent.pageMap || null;
    const task = map ? nextPendingTask(map, ["baggage", "bundle", "flexible_ticket", "cancellation_insurance", "seat"]) : null;
    const options = overlayButtons(overlay).map((option) => {
      const label = overlayChoiceText(option);
      return {
        id: elementId(option),
        label,
        semantic: overlayOptionSemantic(label),
        risk: overlayOptionRisk(label),
        selected: isChoiceSelected(option) || option.getAttribute?.("aria-selected") === "true",
        box: elementBox(option)
      };
    }).filter((option) => option.label);
    return {
      type,
      id: elementId(overlay),
      label: text.slice(0, 800),
      role,
      taskHint: task?.sectionType || routineExtraOverlayKind(text, task) || "",
      options: options.slice(0, 20),
      buttons: options.slice(0, 20),
      box: elementBox(overlay)
    };
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
        const box = elementBox(button);
        return {
          element: button,
          id: elementId(button),
          label,
          box,
          risk: meaningfulActionBox(box) ? actionRisk(lower) : "choice"
        };
      });
    const errors = collectVisibleErrors(text);
    const paidChoices = collectPaidChoices(fullText);
    const overlays = visibleOverlays();
    const activeSurface = buildActiveSurface(activeOverlayElements());
    const sections = buildSectionModels(detectCheckoutSections(), fields, buttons);
    const taskQueue = buildTaskQueue(sections);
    const stageExit = buildStageExit(taskQueue, buttons, overlays, errors, step);
    return {
      site: inferCheckoutSite(),
      step,
      text,
      fullText,
      coverage: pageCoverage(),
      fields,
      buttons,
      overlays,
      activeSurface,
      errors,
      paidChoices,
      sections,
      taskQueue,
      stageExit,
      summary: {
        fields: fields.length,
        knownFields: fields.filter((field) => field.field !== "unknown").length,
        buttons: buttons.length,
        overlays: overlays.length,
        errors: errors.length,
        paidChoices: paidChoices.length,
        sections: sections.length,
        pendingTasks: taskQueue.filter((task) => task.status === "pending").length,
        lockedTasks: taskQueue.filter((task) => task.status === "locked").length,
        continueAllowed: stageExit.continueAllowed
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
    const planCopy = map.summary.sections
      ? ` ${map.summary.sections} sections, ${map.summary.pendingTasks} pending tasks.`
      : "";
    return `I see ${stepCopy[map.step] || map.step}: ${map.summary.knownFields}/${map.summary.fields} recognizable fields, ${map.summary.buttons} actions, ${map.summary.paidChoices} paid-choice areas.${planCopy}`;
  }

  function sectionFieldsFromMap(map, section) {
    if (!section) return [];
    const liveSections = liveSectionModels(map.sections || []);
    const liveSection = liveSections.find((item) => item.id === section.id || item.type === section.type) || section;
    return map.fields.filter((field) => field.element && elementBelongsToSectionBand(field.element, liveSection, liveSections));
  }

  function sectionStillPending(map, sectionType) {
    return (map.sections || []).find((section) => section.type === sectionType && section.status !== "complete" && section.status !== "blocked") || null;
  }

  async function verifyAndRememberSection(sectionType, label = sectionType) {
    const updated = rememberPagePlan(buildPageMap());
    outlineCoreSections(updated.sections || []);
    const section = (updated.sections || []).find((item) => item.type === sectionType);
    const target = elementById(section?.id) || document.body;
    if (section?.status === "complete") {
      markSectionDone(sectionType, label);
      await verifyAgentStep(target, "Section", `${label} complete`, true, 900);
      return true;
    }
    await verifyAgentStep(target, "Section", `${label} still incomplete`, false, 900);
    return false;
  }

  async function fillKnownFieldsFromSection(map, section) {
    if (!section || section.status === "complete" || section.status === "blocked") return 0;
    const root = elementById(section.id);
    if (!root) return 0;
    const fields = sectionFieldsFromMap(map, section);
    const orderedTypes = section.type === "contact"
      ? ["email", "confirm_email"]
      : ["first_name", "last_name"];
    let count = 0;

    highlightSection(root, section.label);
    await showAgentThought(root, "Plan", `Work only inside ${section.label}`, section.objective || "Resolve this section before moving down the page.", 800);

    if (section.type === "contact") {
      for (const type of orderedTypes) {
        const field = fields.find((item) => item.field === type && item.element && item.element.type !== "radio" && item.element.type !== "checkbox");
        const value = travelerValue(type);
        if (!field || !value) continue;
        if (field.value && field.value.trim() === String(value).trim()) continue;
        const result = await setFieldValue(field.element, value, { fieldType: type });
        if (result.ok) count += 1;
        const interrupt = await settleAndHandleInterrupts(`${type} field`);
        if (interrupt.blocked && !interrupt.handled) return count;
      }
      const phoneCount = await fillPhoneFieldsFromMap(map);
      count += phoneCount;
      if (transientOverlayOpen()) return count;
      if (await verifyAndRememberSection("contact", "contact")) return count || 1;
      return count;
    }

    if (section.type === "passenger") {
      if (fillTitleRadio(root)) count += 1;
      await settleAndHandleInterrupts("title selection");
      for (const type of orderedTypes) {
        const field = fields.find((item) => item.field === type && item.element && item.element.type !== "radio" && item.element.type !== "checkbox");
        const value = travelerValue(type);
        if (!field || !value) continue;
        if (field.value && field.value.trim() === String(value).trim()) continue;
        const result = await setFieldValue(field.element, value, { fieldType: type });
        if (result.ok) count += 1;
        const interrupt = await settleAndHandleInterrupts(`${type} field`);
        if (interrupt.blocked && !interrupt.handled) return count;
      }
      if (await verifyAndRememberSection("passenger", "passenger")) return count || 1;
      return count;
    }

    return 0;
  }

  async function fillKnownFieldsFromMap(map) {
    filledFields = [];
    const section = currentSectionTask(map, ["contact", "passenger"]) || sectionStillPending(map, "contact") || sectionStillPending(map, "passenger");
    if (!section) return 0;
    const count = await fillKnownFieldsFromSection(map, section);
    if (count) recordAction("section_profile_fields_filled", { section: section.label, type: section.type, count });
    return count;
  }

  function firstFieldFor(map, fieldType) {
    return map.fields.find((field) => field.field === fieldType && field.element && field.element.type !== "radio" && field.element.type !== "checkbox");
  }

  function sectionPatternForField(fieldType) {
    if (["email", "confirm_email", "phone", "phone_country_code"].includes(fieldType)) {
      return /contact information|provide your contact details|e-?mail|mobile number/i;
    }
    return /passenger\s+\d+|traveller information|traveler information|first name|surname|title|passport/i;
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
    return safeButtons[0]?.element || findClickableByVisibleText(/^continue$/i) || findClickableByVisibleText(/\bcontinue\b/i) || findSafeContinueButton();
  }

  function nextPendingTask(map, types = []) {
    const wanted = new Set(types);
    return (map.taskQueue || []).find((item) => item.status === "pending" && (!wanted.size || wanted.has(item.sectionType))) || null;
  }

  function liveSectionForElement(map, element) {
    if (!element) return null;
    const sections = liveSectionModels(map.sections || []);
    return sections.find((section) => elementBelongsToSectionBand(element, section, sections)) || null;
  }

  function actionAllowedForCurrentTask(map, element) {
    if (!element) return true;
    if (map.activeSurface?.type && map.activeSurface.type !== "page") return true;
    const surfaceIds = new Set([
      ...(map.activeSurface?.options || []).map((option) => option.id),
      ...(map.activeSurface?.buttons || []).map((button) => button.id)
    ].filter(Boolean));
    if (surfaceIds.has(elementId(element))) return true;
    const text = `${buttonText(element)} ${labelText(element)} ${element.innerText || ""}`;
    if (isDangerousActionLabel(text)) return false;
    return isVisible(element) && !element.closest("#atw-sidebar");
  }

  async function autoResolveNoExtrasSection(map) {
    if (!shouldAutoDeclinePaidExtras()) return false;
    const task = nextPendingTask(map, ["baggage", "bundle", "flexible_ticket", "cancellation_insurance", "seat"]);
    const section = (map.sections || []).find((item) => item.id === task?.sectionId);
    if (!section) return false;
    if (section.status === "complete") {
      markSectionDone(section.type, section.label);
      await verifyAgentStep(elementById(section.id) || document.body, "Section", `${section.label} already complete`, true, 650);
      return true;
    }
    const declineChoice = (section.choices || []).find((choice) => /decline_baggage|decline_paid_extra/.test(choice.semantic));
    const target = elementById(declineChoice?.id);
    if (declineChoice?.selected) {
      markSectionDone(section.type, section.label);
      await verifyAgentStep(elementById(section.id) || target || document.body, "Section", `${section.label} complete: ${declineChoice.label}`, true, 700);
      return true;
    }
    if (!target) return false;
    await showAgentThought(
      target,
      "Plan",
      `Apply saved no-extras rule`,
      `${section.label}: choosing "${declineChoice.label}" without asking because the traveler profile says no seats, bags, add-ons, bundle, or insurance.`,
      900
    );
    flashElement(target);
    userLikeClick(target);
    await waitForUiSettle(900);
    await settleAndHandleInterrupts(`${section.label} choice`);
    const updated = rememberPagePlan(buildPageMap());
    outlineCoreSections(updated.sections || []);
    const updatedSection = (updated.sections || []).find((item) => item.type === section.type);
    const verified = updatedSection?.status === "complete";
    if (verified) markSectionDone(section.type, section.label);
    await verifyAgentStep(elementById(updatedSection?.id) || target, "Section", verified ? `${section.label} complete` : `${section.label} still needs another choice`, verified, 800);
    return verified;
  }

  function canUseContinueGate(map) {
    if (!map || ["payment", "confirmation"].includes(map.step)) return false;
    if (!map.stageExit?.continueAllowed) return false;
    if ((map.taskQueue || []).some((task) => task.status === "pending")) return false;
    if (actionableCheckoutErrors(map.errors).length) return false;
    if (transientOverlayOpen()) return false;
    const blockingModal = activeOverlayElements().find((overlay) => !isTransientChoiceOverlay(overlay));
    if (blockingModal) return false;
    const button = findPreferredContinueButton(map);
    return Boolean(button && isVisible(button) && !isDisabledLike(button));
  }

  async function clickContinueGate(map) {
    const button = elementById(map.stageExit?.continueTargetId) || findPreferredContinueButton(map);
    if (!button || isDisabledLike(button)) return false;
    outlineCoreSections(map.sections || []);
    await showAgentThought(
      button,
      "Gate",
      "All required sections verified",
      "Task queue is empty, no modal/dropdown/error is open, so Continue is now allowed.",
      900
    );
    await clickAndVerifyAdvance(button, "Continue");
    return true;
  }

  function isDisabledLike(element) {
    if (!element) return false;
    return Boolean(
      element.disabled ||
      element.getAttribute("aria-disabled") === "true" ||
      /disabled|is-disabled/.test(element.className || "")
    );
  }

  function clickableAncestor(element) {
    let current = element;
    for (let depth = 0; current && depth < 7; depth += 1, current = current.parentElement) {
      if (current.closest?.("#atw-sidebar")) return null;
      if (current.matches?.("button, a, input[type='button'], input[type='submit'], [role='button'], [tabindex]")) return current;
      const style = getComputedStyle(current);
      if (style.cursor === "pointer" && current.getBoundingClientRect().width > 40 && current.getBoundingClientRect().height > 24) return current;
    }
    return null;
  }

  function clickPointIsClear(element) {
    const rect = element.getBoundingClientRect();
    const x = Math.min(window.innerWidth - 2, Math.max(2, rect.left + rect.width / 2));
    const y = Math.min(window.innerHeight - 2, Math.max(2, rect.top + rect.height / 2));
    const top = document.elementFromPoint(x, y);
    return Boolean(top && (top === element || element.contains(top) || top.contains(element)));
  }

  function findClickableByVisibleText(pattern) {
    const candidates = queryAllDeep("button, a, input[type='button'], input[type='submit'], [role='button'], [tabindex], div, span")
      .filter((element) => isVisible(element) && !element.closest("#atw-sidebar"))
      .map((element) => {
        const text = (element.innerText || element.value || element.getAttribute("aria-label") || element.textContent || "").replace(/\s+/g, " ").trim();
        if (!text || text.length > 80 || !pattern.test(text) || isDangerousActionLabel(text)) return null;
        const clickable = clickableAncestor(element) || element;
        if (!isVisible(clickable) || isDisabledLike(clickable)) return null;
        const rect = clickable.getBoundingClientRect();
        if (!meaningfulActionBox(elementBox(clickable))) return null;
        let score = 40;
        if (/^continue$/i.test(text)) score += 40;
        if (clickable.matches?.("button, [role='button'], input[type='button'], input[type='submit']")) score += 20;
        if (clickPointIsClear(clickable)) score += 12;
        if (rect.width < 80 || rect.height < 28) score -= 30;
        if (rect.top < 0 || rect.bottom > window.innerHeight) score -= 8;
        return { element: clickable, score, text, box: elementBox(clickable) };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score || b.box.y - a.box.y);
    const match = candidates[0]?.element || null;
    if (match) logAgentEvent("visible_text_clickable", { text: candidates[0].text, score: candidates[0].score, box: candidates[0].box });
    return match;
  }

  function compactPageMap(map) {
    return {
      site: map.site,
      url: location.href,
      step: map.step,
      text: map.text,
      fullText: map.fullText,
      errors: actionableCheckoutErrors(map.errors),
      paidChoices: map.paidChoices,
      sectionProgress: agent.sectionProgress || {},
      completedSections: agent.completedSections || {},
      completedFields: agent.completedFields || {},
      sections: (map.sections || []).map((section) => ({
        id: section.id,
        label: section.label,
        type: section.type,
        order: section.order,
        status: section.status,
        required: Boolean(section.required),
        paidChoice: Boolean(section.paidChoice),
        objective: section.objective,
        selected: section.selected || [],
        choices: (section.choices || []).map((choice) => ({
          id: choice.id,
          label: choice.label,
          selected: Boolean(choice.selected),
          semantic: choice.semantic,
          box: choice.box
        })),
        box: section.box,
        fields: (section.fields || []).map((field) => ({
          id: field.id,
          label: field.label,
          field: field.field,
          kind: field.kind,
          semantic: field.semantic,
          required: Boolean(field.required),
          hasValue: Boolean(field.hasValue),
          box: field.box
        })).slice(0, 20),
        buttons: (section.buttons || []).map((button) => ({
          id: button.id,
          label: button.label,
          risk: button.risk,
          box: button.box
        })).slice(0, 20),
        text: section.text
      })).slice(0, 20),
      taskQueue: (map.taskQueue || []).map((task) => ({
        id: task.id,
        sectionId: task.sectionId,
        sectionLabel: task.sectionLabel,
        sectionType: task.sectionType,
        order: task.order,
        status: task.status,
        objective: task.objective,
        rule: task.rule
      })).slice(0, 30),
      stageExit: map.stageExit || {},
      summary: map.summary,
      coverage: map.coverage,
      fields: map.fields.map((field) => ({
        id: field.id,
        label: field.label,
        box: field.box,
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
      activeSurface: map.activeSurface || {
        type: "page",
        id: "",
        label: "",
        role: "",
        taskHint: "",
        options: [],
        buttons: [],
        box: null
      },
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
            skipPaidExtrasApproved: shouldAutoDeclinePaidExtras(),
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
      const decision = {
        source: "system",
        action: "stop",
        targetId: "",
        value: "",
        message: `AI agent unavailable: ${error.message}. I stopped because AI-only mode is enabled.`,
        needsApproval: true,
        risk: "uncertain",
        reason: "AI-only mode: backend/OpenAI must provide the next action."
      };
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

  function visibleValidationElement() {
    return queryAllDeep("body *")
      .filter((element) => isVisible(element) && !element.closest("#atw-sidebar"))
      .map((element) => {
        const text = (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
        if (!text || text.length > 220) return null;
        return /select one option|select an option|choose one option|please select|required|must enter|invalid|not valid|too long|too short/i.test(text)
          ? { element, text }
          : null;
      })
      .filter(Boolean)[0] || null;
  }

  async function clickAndVerifyAdvance(element, label = "Continue", delay = 1200, options = {}) {
    const before = pageSignature();
    addAgentMessage("assistant", `Clicking: ${label}.`);
    await showAgentThought(element, "Exit", `Act: click ${label}`, "Checking whether the page advances.");
    flashElement(element);
    element.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
    await sleep(250);
    userLikeClick(element);
    await waitForUiSettle(700);
    await sleep(delay);
    let afterMap = rememberPagePlan(buildPageMap());
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
      if (agent.running) {
        addAgentMessage("assistant", `${label} did not advance, so I am rescanning and sending the updated page back to the AI.`);
        if (afterMap.errors.length) addAgentMessage("assistant", `Visible issue: ${afterMap.errors.slice(0, 2).join("; ")}.`);
        await continueAfterAction(350);
        return false;
      }
      return false;
    }
    await continueAfterAction(250);
    return true;
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
      addAgentMessage("assistant", message);
    }
    if (decision.reason) {
      setAgentActivity(message, decision.reason);
    }

    if ((decision.risk === "money" || decision.action === "ask_user") && shouldAutoDeclinePaidExtras()) {
      agent.skipPaidExtrasApproved = true;
      const handled = await autoResolveNoExtrasSection(map);
      if (handled) {
        await continueAfterAction(350);
        return;
      }
      agent.pendingUserMessage = "Use the saved traveler rule: decline paid extras and continue without asking unless payment/final booking appears.";
      await continueAfterAction(350);
      return;
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

    if (decision.action === "click") {
      const target = resolveDecisionTarget(decision, map);
      if (!target) {
        agent.awaiting = "manual";
        agent.running = false;
        addAgentMessage("assistant", "The AI chose an element that is no longer visible, and I could not match its visible label on the active screen. I rescanned and stopped so you can guide me.");
        renderSidebar("agent");
        return;
      }
      if (!actionAllowedForCurrentTask(map, target)) {
        const pending = nextPendingTask(map);
        const targetSection = liveSectionForElement(map, target);
        logAgentEvent("scoped_action_rejected", {
          targetId: decision.targetId,
          targetSection: targetSection?.type || "",
          pendingSection: pending?.sectionType || ""
        });
        await showAgentThought(
          elementById(pending?.sectionId) || document.body,
          "Verify",
          "Rejecting stale action",
          `The AI picked ${targetSection?.label || "another section"}, but the next unresolved section is ${pending?.sectionLabel || "current task"}. Rescanning instead of going backward.`,
          900
        );
        await continueAfterAction(400);
        return;
      }
      const resolvedTargetId = elementId(target);
      const button = map.buttons.find((item) => item.id === decision.targetId || item.id === resolvedTargetId);
      const surfaceEntry = activeSurfaceEntryForElement(map, target);
      const targetText = labelText(target) || target.innerText || button?.label || "";
      if (surfaceEntry?.risk === "paid") {
        agent.awaiting = "extras";
        agent.running = false;
        addAgentMessage("assistant", `I stopped before selecting a paid option: ${surfaceEntry.label}.`);
        renderSidebar("agent");
        return;
      }
      if (button?.risk === "payment" || isDangerousActionLabel(button?.label || "")) {
        agent.awaiting = "final";
        agent.running = false;
        addAgentMessage("assistant", "I will not click payment or final booking buttons automatically on a real site.");
        renderSidebar("review");
        return;
      }
      if ((target.matches?.("input[type='checkbox'], input[type='radio'], [role='checkbox'], [role='radio']") && isChoiceSelected(target))
        || /true/.test(target.getAttribute?.("aria-checked") || "")) {
        const section = liveSectionForElement(map, target);
        if (section) {
          await verifyAndRememberSection(section.type, section.label);
          await continueAfterAction(350);
          return;
        }
      }
      if (!repeatGuardFor(target, "I tried the same action once and the page did not advance. I stopped so I do not loop.")) return;
      if (button?.risk === "safe_continue") {
        await clickAndVerifyAdvance(target, button.label || "Continue");
        return;
      }
      const actedSection = liveSectionForElement(map, target);
      const surfaceWasActive = Boolean(map.activeSurface?.type && map.activeSurface.type !== "page");
      const beforeOverlay = surfaceWasActive ? activeOverlayElements()[0] : null;
      const beforeOverlaySignature = beforeOverlay ? overlaySignature(beforeOverlay) : "";
      showAgentCursor(target, button?.label || "clicking");
      flashElement(target);
      userLikeClick(target);
      if (surfaceWasActive) {
        const progress = await waitForOverlayProgress(beforeOverlay, beforeOverlaySignature, 2200);
        await verifyAgentStep(target, "Interrupt", progress.ok ? `active surface ${progress.reason}` : "active surface did not change", progress.ok, 650);
        if (!progress.ok) {
          addAgentMessage("assistant", "That visible popup/dropdown did not change after the click, so I am rescanning it instead of marking it done.");
          await continueAfterAction(450);
          return;
        }
        await continueAfterAction(500);
        return;
      }
      await waitForUiSettle(800);
      if (actedSection?.type && actedSection.type !== "unknown") {
        await verifyAndRememberSection(actedSection.type, actedSection.label);
      }
      await continueAfterAction(900);
      return;
    }

    if (decision.action === "type" || decision.action === "select") {
      const target = resolveDecisionTarget(decision, map);
      if (!target || isPaymentField(target)) {
        agent.awaiting = "manual";
        agent.running = false;
        addAgentMessage("assistant", "The requested field is unavailable or sensitive, so I stopped.");
        renderSidebar("agent");
        return;
      }
      if (decision.action === "select" && target.tagName !== "SELECT") {
        const terms = [
          decision.value,
          "none of the passengers",
          "none",
          "no thanks",
          "0eur",
          "0 eur",
          "without"
        ].filter(Boolean);
        const result = await selectComboboxOption(target, terms);
        recordAction("field_fill", {
          ok: result.ok,
          fieldType: "required_dropdown_choice",
          selector: target.id || target.getAttribute("aria-label") || "combobox",
          expected: decision.value || terms[0],
          actual: result.option || result.value || currentElementValue(target),
          method: result.method
        });
        reportActionResult({
          type: "field_fill",
          action: "select_dropdown",
          fieldType: "required_dropdown_choice",
          target: target.id || target.getAttribute("aria-label") || "combobox",
          ok: result.ok,
          message: result.ok ? "Dropdown option accepted." : "Dropdown option was not accepted."
        });
        if (!result.ok) {
          agent.awaiting = "manual";
          agent.running = false;
          addAgentMessage("assistant", "I opened the dropdown but could not verify the safe no-extras option.");
          renderSidebar("agent");
          return;
        }
        const section = liveSectionForElement(map, target);
        if (section?.type) await verifyAndRememberSection(section.type, section.label);
        await continueAfterAction(700);
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
    agent.skipPaidExtrasApproved = false;
    agent.autopilotMode = true;
    agent.skipPaidExtrasApproved = shouldAutoDeclinePaidExtras();
    agent.actionHistory = [];
    resetSectionProgress();
    setAgentActivity("Starting checkout agent", travelerRules() || "Using saved traveler profile");
    agent.pageMap = rememberPagePlan(buildPageMap());
    await startAgentSession();
    addAgentMessage("assistant", `${describePageMap(agent.pageMap)} I will work step by step and ask when money, payment, or uncertainty appears.`);
    renderSidebar("agent");
    await announceSectionQueue();
    await sleep(650);
    processCheckoutAgent();
  }

  async function processCheckoutAgent() {
    if (!agent.running) return;
    warnings = runRiskChecks();
    const map = rememberPagePlan(buildPageMap());
    agent.pageMap = map;
    const interrupt = await settleAndHandleInterrupts("agent loop");
    if (interrupt.handled) {
      await continueAfterAction(500);
      return;
    }
    if (interrupt.blocked) {
      agent.running = false;
      agent.awaiting = "manual";
      addAgentMessage("assistant", "A popup is open and I do not have a safe automatic choice. I stopped so I do not keep working in the background.");
      renderSidebar("agent");
      return;
    }
    let stableMap = rememberPagePlan(buildPageMap());
    agent.pageMap = stableMap;

    const userMessage = agent.pendingUserMessage;
    agent.pendingUserMessage = "";
    const decision = await requestAgentDecision(stableMap, userMessage);
    await executeAgentDecision(decision, stableMap);
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
      agent.pendingUserMessage = "Use my saved no-extras preference and continue safely.";
      await processCheckoutAgent();
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
      agent.pendingUserMessage = "Use my saved no-extras preference and continue safely.";
      await processCheckoutAgent();
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

    if (/add.*bag|checked bag|baggage/.test(normalized) && !/no|skip|dont|don't/.test(normalized)) {
      await handleAgentChoice("add_bag");
      return;
    }

    if (agent.awaiting === "extras" && /continue|try again|fixed|done|yes|ok|go ahead|proceed/.test(normalized)) {
      agent.pendingUserMessage = text;
      agent.running = true;
      agent.awaiting = "";
      renderSidebar("agent");
      await sleep(300);
      processCheckoutAgent();
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

  function actionableCheckoutErrors(errors = []) {
    return errors;
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
    const map = agent.pageMap || rememberPagePlan(buildPageMap());
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
