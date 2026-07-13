(async function bootAirTravelWallet() {
  if (document.getElementById("atw-sidebar")) return;

  const DEFAULT_API = "http://localhost:4173/api";
  const AGENT_SINGLE_BRAIN = true;
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
    apiBase: DEFAULT_API,
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
    userGoal: "",
    reasoningLog: [],
    actionHistory: [],
    sectionProgress: {},
    completedSections: {},
    completedFields: {},
    sectionPlan: [],
    taskQueue: [],
    debugLog: [],
    flowLog: [],
    flowSeq: 0,
    activeTurnId: "",
    activeObservationId: "",
    activeExecutionActionId: "",
    activeExecutionObservationId: "",
    activeExecutionDecisionAction: "",
    actionLedger: [],
    lastActionResult: null,
    lastBackendDebug: null,
    pageMap: null,
    pageUnderstanding: null,
    observerTab: "summary"
  };

  function storageGet(keys) {
    return chrome.storage.local.get(keys);
  }

  const RESUME_KEY = "atwAgentResume";
  const RESUME_MAX_AGE_MS = 3 * 60 * 1000;

  async function saveResumeMarker() {
    try {
      if (!agent.running) {
        await chrome.storage.local.remove(RESUME_KEY);
        return;
      }
      await chrome.storage.local.set({
        [RESUME_KEY]: {
          travelerId: selectedTravelerId,
          sessionId: agent.sessionId,
          skipPaidExtrasApproved: agent.skipPaidExtrasApproved,
          savedAt: Date.now()
        }
      });
    } catch (error) {
      // Best-effort: if the page is already tearing down, storage may be unavailable. Nothing to do.
    }
  }

  async function clearResumeMarker() {
    try {
      await chrome.storage.local.remove(RESUME_KEY);
    } catch (error) {
      // ignore
    }
  }

  async function readResumeMarker() {
    const stored = await chrome.storage.local.get(RESUME_KEY);
    return stored?.[RESUME_KEY] || null;
  }

  async function fetchData() {
    const settings = await storageGet(["apiBase", "selectedTravelerId"]);
    const apiBase = settings.apiBase || DEFAULT_API;
    agent.apiBase = apiBase;
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

  function userIntentText() {
    const base = `Complete this flight checkout safely using the selected traveler profile. Traveler rules: ${travelerRules() || "Ask before paid extras and stop at real payment."}`;
    const oneOff = (agent.userGoal || "").trim();
    return oneOff ? `${base} For this booking specifically, the user also said: "${oneOff}" — treat this as an explicit instruction for this session, on top of the saved traveler rules.` : base;
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

  function canUseCompletionMemoryForSectionType(type = "") {
    // Completion memory is safe for durable one-per-page profile sections.
    // Repeated paid-extra cards often share a coarse type like "bundle", while
    // each card has its own required choice. Those must be re-derived from the
    // current DOM every scan.
    return /^(contact|passenger)$/.test(String(type || ""));
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

  // Same info as formatLoopBubble but without the Context/Rule lines, which repeat
  // near-identically on every step and drown out the one thing that actually changes:
  // what the agent is looking at and why. Used for the on-page cursor tooltip only.
  function formatCursorBubble(loopStep, stage, detail = "") {
    return [`${loopStep}: ${stage || "current page"}`, detail].filter(Boolean).join("\n");
  }

  function pushReasoningLog(loopStep, stage, action, reason = "", ok = null) {
    agent.reasoningLog.push({ loopStep, stage, action, reason, ok, ts: Date.now() });
    agent.reasoningLog = agent.reasoningLog.slice(-8);
  }

  async function showAgentThought(anchor, stage, action, reason = "", pause = SLOW_STEP_MS) {
    agent.currentStage = stage || agent.currentStage || "";
    const loopStep = inferLoopStep(stage, action);
    const detail = reason ? `Goal: ${reason}` : "";
    const bubble = formatLoopBubble(loopStep, stage, action, detail);
    setAgentActivity(`${loopStep} -> ${action}`, bubble);
    if (anchor) showAgentCursor(anchor, `${loopStep}: ${action}`, formatCursorBubble(loopStep, stage, detail));
    pushReasoningLog(loopStep, stage, action, reason);
    logAgentEvent("visible_step", { loopStep, stage, action, reason });
    renderSidebar("agent");
    await sleep(pause);
  }

  async function verifyAgentStep(anchor, stage, message, ok = true, pause = VERIFY_STEP_MS) {
    const action = ok ? `Done: ${message}` : `Checking: ${message}`;
    const detail = ok
      ? `Result: verified on the live page. Remember: do not change it again unless a specific error appears.`
      : "Result: not verified yet. Re-observe before the next action.";
    const loopStep = ok ? "Remember" : "Verify";
    const bubble = formatLoopBubble(loopStep, stage, action, detail);
    setAgentActivity(`${loopStep} -> ${action}`, bubble);
    if (anchor) showAgentCursor(anchor, `${loopStep}: ${action}`, formatCursorBubble(loopStep, stage, detail));
    pushReasoningLog(loopStep, stage, message, "", ok);
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

  function nextFlowId(prefix = "flow") {
    agent.flowSeq += 1;
    return `${prefix}_${Date.now().toString(36)}_${agent.flowSeq}`;
  }

  function compactText(value = "", max = 140) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
  }

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
      surface: compactText(agent.pageMap?.activeSurface?.label || "", 220)
    };
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
    const activeSurface = map?.activeSurface || {};
    let surfaceId = "";
    let surfaceType = "page";
    let surfaceLabel = "";
    if (activeSurface?.type && activeSurface.type !== "page") {
      const surfaceElement = elementById(activeSurface.id);
      if (surfaceElement && (surfaceElement === element || surfaceElement.contains(element))) {
        surfaceId = activeSurface.id || "";
        surfaceType = activeSurface.type || "modal";
        surfaceLabel = activeSurface.label || "";
      }
    }
    const section = liveSectionForElement(map, element);
    const label = buttonText(element) || labelText(element) || element.innerText || element.textContent || "";
    const control = canonicalControlForElement(element, { section });
    return {
      id: elementId(element),
      label,
      normalizedLabel: normalizedElementLabel(element),
      role: implicitRole(element),
      accessibleName: accessibleName(element),
      accessibilityState: accessibilityState(element),
      kind: /radio|checkbox/i.test(element.type || "") ? "choice" : (element.tagName || "").toLowerCase(),
      semantic: semanticChoiceType(label),
      risk: choiceRisk(label),
      box: descriptor?.box || null,
      surfaceId,
      surfaceType,
      surfaceLabel,
      surfaceNormalizedLabel: normalizeMatchText(surfaceLabel),
      sectionId: section?.id || "",
      sectionType: section?.type || "",
      sectionLabel: section?.label || "",
      controlId: control?.controlId || element.dataset?.atwControlId || "",
      controlKind: control?.kind || "",
      state: control?.state || null,
      actuators: control?.actuators || [],
      stateElementId: control?.stateElementId || "",
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
    const surface = map.currentSurface || map.activeSurface || {};
    if (!surface?.type || surface.type === "page") return true;
    const surfaceElement = elementById(surface.id);
    if (!surfaceElement) return false;
    return surfaceElement === element || surfaceElement.contains(element);
  }

  function validateResolvedTarget(decision = {}, element, map = agent.pageMap || buildPageMap()) {
    const expected = decision.targetSnapshot;
    const live = liveTargetSnapshot(element, map);
    if (!targetBelongsToCurrentSurface(map, element)) {
      return {
        ok: false,
        code: "TARGET_OUTSIDE_CURRENT_SURFACE",
        expected: expected || {
          surfaceId: map.currentSurface?.id || map.activeSurface?.id || "",
          surfaceType: map.currentSurface?.type || map.activeSurface?.type || "page",
          surfaceLabel: map.currentSurface?.label || map.activeSurface?.label || ""
        },
        live
      };
    }
    if (!expected) return { ok: true, live, expected: null };
    if (!live) return { ok: false, code: "TARGET_MISSING", expected, live: null };
    const warnings = [];
    const strictSurface = isStrictActionSurfaceType(expected.surfaceType);
    const expectedControlId = expected.controlId || decision.controlId || "";
    const liveControlId = live.controlId || element?.dataset?.atwControlId || "";
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
        if (!expectedSurface || (expectedSurface !== element && !expectedSurface.contains(element))) {
          return { ok: false, code: "TARGET_SURFACE_MISMATCH", expected, live };
        }
      } else if (!live.surfaceId && map?.activeSurface?.type && map.activeSurface.type !== "page") {
        return { ok: false, code: "TARGET_NOT_IN_ACTIVE_SURFACE", expected, live };
      }
    }

    if (!boxesCloseEnough(expected.visualRegion || expected.box, live.visualRegion || live.box)) {
      if (strictSurface && !controlMatches) {
        return { ok: false, code: "TARGET_BOX_DRIFT", expected, live };
      }
      warnings.push("TARGET_BOX_DRIFT");
    }

    if (live.box && !clickPointIsClear(element)) {
      if (live.box.inViewport && strictSurface && !controlMatches && !(expected.id && labelMatches && idMatches)) {
        return { ok: false, code: "TARGET_COVERED", expected, live };
      }
      warnings.push("TARGET_COVERED");
    }

    return { ok: true, expected, live, warnings };
  }

  function pageSnapshot(label = "") {
    const map = agent.pageMap || buildPageMap();
    return {
      label,
      url: location.href,
      site: map.site,
      step: map.step,
      signature: pageSignature(map).slice(0, 900),
      snapshotHash: observationHashForMap(map),
      foreground: map.foreground || foregroundSurfaceState(map.currentSurface || map.activeSurface || {}),
      visualState: map.visualState || visualPageState(map),
      accessibility: map.accessibility ? {
        foregroundSurfaceId: map.accessibility.foregroundSurfaceId,
        foregroundSurfaceType: map.accessibility.foregroundSurfaceType,
        controls: (map.accessibility.controls || []).slice(0, 40)
      } : null,
      activeSurface: map.activeSurface ? {
        type: map.activeSurface.type,
        taskHint: map.activeSurface.taskHint,
        label: compactText(map.activeSurface.label, 220),
        visualState: map.activeSurface.visualState || null,
        accessibility: map.activeSurface.accessibility || null,
        options: (map.activeSurface.options || []).slice(0, 8).map((option) => ({
          id: option.id,
          label: compactText(option.label, 120),
          risk: option.risk,
          semantic: option.semantic,
          selected: Boolean(option.selected),
          accessibility: option.accessibility || null,
          box: option.box
        }))
      } : null,
      currentSurface: map.currentSurface ? {
        id: map.currentSurface.id || "",
        type: map.currentSurface.type || "page",
        label: compactText(map.currentSurface.label, 220),
        taskHint: map.currentSurface.taskHint || "",
        blocksBackground: Boolean(map.currentSurface.blocksBackground),
        expectedResolution: map.currentSurface.expectedResolution || "",
        foreground: map.currentSurface.foreground || foregroundSurfaceState(map.currentSurface),
        visualState: map.currentSurface.visualState || null,
        options: (map.currentSurface.options || []).slice(0, 20).map((option) => ({
          id: option.id,
          label: option.label,
          risk: option.risk,
          semantic: option.semantic,
          selected: Boolean(option.selected),
          accessibility: option.accessibility || null,
          box: option.box
        })),
        buttons: (map.currentSurface.buttons || []).slice(0, 20).map((button) => ({
          id: button.id,
          label: button.label,
          risk: button.risk,
          semantic: button.semantic,
          selected: Boolean(button.selected),
          accessibility: button.accessibility || null,
          box: button.box
        })),
        taskQueue: (map.currentSurface.taskQueue || []).map((task) => ({
          id: task.id,
          sectionType: task.sectionType,
          sectionLabel: task.sectionLabel,
          status: task.status
        })).slice(0, 8)
      } : null,
      surfaceStack: (map.surfaceStack || []).map((surface) => ({
        id: surface.id || "",
        type: surface.type || "page",
        label: compactText(surface.label, 160),
        isCurrent: Boolean(surface.isCurrent),
        blocksBackground: Boolean(surface.blocksBackground),
        taskTypes: (surface.taskQueue || []).map((task) => task.sectionType).slice(0, 8),
        expectedResolution: surface.expectedResolution || ""
      })),
      summary: map.summary,
      errors: actionableCheckoutErrors(map.errors),
      visibleControls: [...(map.buttons || []), ...(map.fields || [])]
        .filter((item) => item.box?.inViewport)
        .slice(0, 24)
        .map((item) => ({
          id: item.id,
          label: compactText(item.label || item.field || "", 100),
          risk: item.risk || "",
          field: item.field || "",
          box: item.box
        }))
    };
  }

  function sendFlowLog(entry) {
    const apiBase = agent.apiBase || DEFAULT_API;
    fetch(`${apiBase}/agent/client-log`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: agent.sessionId || "",
        clientTurnId: entry.turnId || agent.activeTurnId || "",
        entry
      })
    }).catch(() => {
      // Logging must never slow or break the checkout agent.
    });
  }

  function sendActionLedger(row) {
    const apiBase = agent.apiBase || DEFAULT_API;
    fetch(`${apiBase}/agent/action-ledger`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(row)
    }).catch(() => {
      // Best-effort durable audit trail; execution must not depend on logging.
    });
  }

  function logFlow(phase, payload = {}) {
    const entry = {
      seq: agent.flowSeq + 1,
      at: new Date().toISOString(),
      turnId: agent.activeTurnId || "",
      phase,
      payload
    };
    agent.flowSeq += 1;
    agent.flowLog.push(entry);
    agent.flowLog = agent.flowLog.slice(-160);
    logAgentEvent(`flow:${phase}`, payload);
    // eslint-disable-next-line no-console
    console.debug("[atw-flow]", phase, payload);
    sendFlowLog(entry);
    return entry;
  }

  function pushActionLedger(entry = {}) {
    const row = {
      at: new Date().toISOString(),
      transactionId: agent.sessionId || "",
      observationId: entry.observationId || agent.activeObservationId || "",
      turnId: entry.turnId || agent.activeTurnId || "",
      actionId: entry.actionId || nextFlowId("act"),
      ...entry
    };
    agent.actionLedger.push(row);
    agent.actionLedger = agent.actionLedger.slice(-120);
    sendActionLedger(row);
    logFlow("ledger.action", {
      actionId: row.actionId,
      observationId: row.observationId,
      turnId: row.turnId,
      stage: row.stage || "",
      action: row.action?.action || row.action?.type || row.actionType || "",
      result: row.result || null
    });
    return row;
  }

  function mapObservationSnapshot(map = buildPageMap()) {
    const signature = pageSignature(map);
    const structuralSignature = structuralPageSignature(map);
    return {
      observationId: agent.activeObservationId || "",
      signature,
      structuralSignature,
      snapshotHash: stableHash(structuralSignature),
      pageHash: stableHash(signature),
      url: location.href,
      site: map.site,
      step: map.step,
        activeSurfaceLabel: map.activeSurface?.label || "",
        activeSurfaceType: map.activeSurface?.type || "page",
      foreground: map.foreground || foregroundSurfaceState(map.currentSurface || map.activeSurface || {}),
      visualState: map.visualState || visualPageState(map),
      currentSurfaceLabel: map.currentSurface?.label || map.activeSurface?.label || "",
      currentSurfaceType: map.currentSurface?.type || map.activeSurface?.type || "page",
      currentSurfaceTasks: (map.currentSurfaceTasks || map.currentSurface?.taskQueue || []).map((task) => task.sectionType || task.sectionLabel).filter(Boolean).slice(0, 8),
      backgroundTasks: (map.backgroundTasks || []).map((task) => task.sectionType || task.sectionLabel).filter(Boolean).slice(0, 8),
      controls: [...(map.buttons || []), ...(map.fields || [])].length
    };
  }

  function observationChangedSince(map) {
    if (!map) return false;
    const before = observationHashForMap(map);
    const current = observationHashForMap(rememberPagePlan(buildPageMap()));
    return Boolean(before && current && before !== current);
  }

  function clearExecutionContext() {
    agent.activeExecutionActionId = "";
    agent.activeExecutionObservationId = "";
    agent.activeExecutionDecisionAction = "";
  }

  function rememberActionExecutionResult(actionId, observationId, decision = {}, expectedOutcome = {}, verification = {}) {
    const result = {
      at: new Date().toISOString(),
      actionId,
      observationId,
      plannedObservationId: decision.observationId || "",
      observationHash: decision.observationHash || "",
      requirementId: decision.requirementId || "",
      intent: decision.intent || "",
      executed: true,
      verified: Boolean(verification.ok),
      action: {
        id: decision.actionId || decision.id || actionId,
        action: decision.action || "",
        intent: decision.intent || "",
        targetId: decision.targetId || "",
        targetLabel: decision.targetLabel || "",
        value: decision.value || "",
        risk: decision.risk || "",
        reason: decision.reason || ""
      },
      targetSnapshot: decision.targetSnapshot || null,
      expectedOutcome,
      outcome: verification
    };
    agent.lastActionResult = result;
    agent.actionHistory.push({
      at: result.at,
      type: "action_result",
      actionId,
      observationId,
      observationHash: result.observationHash,
      intent: result.intent,
      requirementId: result.requirementId,
      verified: result.verified,
      payload: result
    });
    agent.actionHistory = agent.actionHistory.slice(-40);
    return result;
  }

  function guardedHelperAllowed(helperName, allowedActions = []) {
    const currentAction = agent.activeExecutionDecisionAction || "";
    const ok = Boolean(agent.running && agent.activeExecutionActionId && allowedActions.includes(currentAction));
    if (!ok) {
      logFlow("helper.blocked_ungoverned", {
        helperName,
        allowedActions,
        currentAction,
        actionId: agent.activeExecutionActionId || "",
        observationId: agent.activeExecutionObservationId || agent.activeObservationId || "",
        reason: "Checkout-mutating helper refused because it is not executing under a matching backend-approved action."
      });
    }
    return ok;
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
    if (agent.activeExecutionActionId) {
      pushActionLedger({
        actionId: `${agent.activeExecutionActionId}:atomic_${agent.actionHistory.length}`,
        parentActionId: agent.activeExecutionActionId,
        observationId: agent.activeExecutionObservationId || agent.activeObservationId || "",
        stage: "atomic_result",
        actionType: type,
        result: {
          ok: payload?.ok !== false,
          payload
        }
      });
    }
  }

  async function startAgentSession() {
    try {
      const settings = await storageGet(["apiBase"]);
      const response = await fetch(`${settings.apiBase || DEFAULT_API}/agent/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          goal: agent.userGoal || "Complete this flight checkout safely with one-click assistance.",
          userIntent: userIntentText(),
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
    logFlow("action.report", {
      result,
      page: pageSnapshot("report-action-result")
    });
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
        activeTurnId: agent.activeTurnId,
        activeObservationId: agent.activeObservationId,
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
      lastActionResult: agent.lastActionResult,
      actionLedger: agent.actionLedger,
      flowLog: agent.flowLog,
      lastBackendDebug: agent.lastBackendDebug,
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
    const box = isVisible(element) ? elementBox(element) : null;
    const surface = element.closest?.("[role='dialog'], [aria-modal='true'], .modal, .popover, [role='listbox'], [role='menu']")
      || activeOverlayElements()[0]
      || null;
    const surfaceText = surface ? overlayText(surface).slice(0, 260) : "";
    return [
      location.href,
      element.tagName,
      element.id,
      element.name,
      box ? `${Math.round(box.centerX)}:${Math.round(box.centerY)}:${Math.round(box.width)}x${Math.round(box.height)}` : "",
      surfaceText,
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

  function stableHash(value = "") {
    const text = String(value || "");
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return `h${(hash >>> 0).toString(36)}`;
  }

  function structuralPageSignature(map = buildPageMap()) {
    const activeSurface = map.activeSurface || {};
    const stableSection = (section) => [
      section.type || "",
      normalizeMatchText(section.label || ""),
      section.status || "",
      (section.selected || []).map(normalizeMatchText).join(",")
    ].join(":");
    const stableControl = (control) => [
      control.kind || control.role || control.type || "",
      control.field || "",
      normalizeMatchText(control.label || control.field || ""),
      control.hasValue ? "1" : "0",
      control.selected ? "1" : "0"
    ].join(":");
    const sections = (map.sections || [])
      .map(stableSection)
      .join("|");
    const controls = [...(map.buttons || []), ...(map.fields || [])]
      .map(stableControl)
      .join("|");
    return [
      pageSignature(map),
      `surface:${activeSurface.type || "page"}:${normalizeMatchText(activeSurface.label || "")}`,
      `sections:${sections}`,
      `controls:${controls}`
    ].join("||").slice(0, 4000);
  }

  function observationHashForMap(map = buildPageMap()) {
    return stableHash(structuralPageSignature(map));
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

  function textFromIds(ids = "") {
    return String(ids || "")
      .split(/\s+/)
      .map((id) => id && document.getElementById(id)?.innerText)
      .filter(Boolean)
      .join(" ");
  }

  function implicitRole(element) {
    if (!element) return "";
    const tag = (element.tagName || "").toLowerCase();
    const type = (element.getAttribute?.("type") || "").toLowerCase();
    if (element.getAttribute?.("role")) return element.getAttribute("role");
    if (tag === "button" || ["button", "submit", "reset"].includes(type)) return "button";
    if (tag === "a" && element.getAttribute("href")) return "link";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "range") return "slider";
      return "textbox";
    }
    if (tag === "dialog") return "dialog";
    return "";
  }

  function accessibleName(element) {
    if (!element) return "";
    return [
      element.getAttribute?.("aria-label"),
      textFromIds(element.getAttribute?.("aria-labelledby")),
      labelText(element),
      element.getAttribute?.("alt"),
      element.getAttribute?.("title"),
      element.value && /button|submit|reset/.test(element.type || "") ? element.value : "",
      buttonText(element),
      element.innerText || element.textContent
    ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim().slice(0, 240);
  }

  function accessibilityState(element) {
    if (!element) return {};
    return {
      disabled: isDisabledLike(element),
      checked: element.checked === true || element.getAttribute?.("aria-checked") === "true",
      selected: element.selected === true || element.getAttribute?.("aria-selected") === "true",
      expanded: element.getAttribute?.("aria-expanded") || "",
      pressed: element.getAttribute?.("aria-pressed") || "",
      required: element.required === true || element.getAttribute?.("aria-required") === "true",
      invalid: element.getAttribute?.("aria-invalid") === "true",
      hasPopup: element.getAttribute?.("aria-haspopup") || "",
      controls: element.getAttribute?.("aria-controls") || "",
      describedBy: textFromIds(element.getAttribute?.("aria-describedby")).slice(0, 240)
    };
  }

  function accessibilityNode(element, map = agent.pageMap || null) {
    if (!element || !isVisible(element) || element.closest?.("#atw-sidebar")) return null;
    const section = map ? liveSectionForElement(map, element) : null;
    const surface = map?.currentSurface || map?.activeSurface || {};
    const box = elementBox(element);
    return {
      id: elementId(element),
      controlId: element.dataset?.atwControlId || canonicalControlForElement(element, { section })?.controlId || "",
      role: implicitRole(element),
      name: accessibleName(element),
      state: accessibilityState(element),
      box,
      tag: (element.tagName || "").toLowerCase(),
      kind: /radio|checkbox/i.test(element.type || "") ? "choice" : ((element.tagName || "").toLowerCase()),
      sectionId: section?.id || "",
      sectionType: section?.type || "",
      sectionLabel: section?.label || "",
      surfaceId: surface?.id || "",
      surfaceType: surface?.type || "page",
      inViewport: Boolean(box?.inViewport)
    };
  }

  function accessibilitySnapshot(map = agent.pageMap || buildPageMap()) {
    const surface = map.currentSurface || map.activeSurface || {};
    const controls = [
      ...(map.fields || []).map((item) => item.element),
      ...(map.buttons || []).map((item) => item.element),
      ...(surface.id ? [elementById(surface.id)] : []),
      ...(surface.options || []).map((item) => elementById(item.id)),
      ...(surface.buttons || []).map((item) => elementById(item.id))
    ]
      .filter(Boolean)
      .map((element) => accessibilityNode(element, map))
      .filter(Boolean)
      .filter((node, index, list) => list.findIndex((item) => item.id === node.id) === index)
      .slice(0, 120);
    return {
      foregroundSurfaceId: surface.id || "",
      foregroundSurfaceType: surface.type || "page",
      controls,
      landmarkCount: queryAllDeep("main, [role='main'], form, nav, header, footer, aside").filter(isVisible).length
    };
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

  function activeSurfaceEntryForElement(map, element) {
    if (!element) return null;
    const id = elementId(element);
    return activeSurfaceEntries(map).find((entry) => entry.id === id) || null;
  }

  function isActionableClickTarget(element) {
    return Boolean(element?.matches?.("button, a, input[type='button'], input[type='submit'], [role='button'], [role='option'], [role='checkbox'], [role='radio'], label, input[type='checkbox'], input[type='radio'], [tabindex]"));
  }

  function visibleClickableCandidates(root = document) {
    return queryAllDeep([
      "button",
      "a",
      "input[type='button']",
      "input[type='submit']",
      "[role='button']",
      "[role='option']",
      "[role='menuitem']",
      "[role='checkbox']",
      "[role='radio']",
      "label",
      "input[type='checkbox']",
      "input[type='radio']",
      "li",
      "[tabindex]"
    ].join(","), root.shadowRoot || root)
      .map((element) => clickableAncestor(element) || element)
      .filter((element, index, list) => element && list.indexOf(element) === index)
      .filter((element) => isVisible(element) && !element.closest("#atw-sidebar") && !isPaymentField(element) && !isDisabledLike(element));
  }

  function scoreTargetCandidate(element, labels = []) {
    const descriptor = elementDescriptor(element);
    if (!descriptor?.box) return -Infinity;
    const text = normalizeMatchText(buttonText(element) || labelText(element) || element.innerText || element.textContent || element.getAttribute?.("aria-label") || "");
    const wanted = labels.map(normalizeMatchText).filter(Boolean);
    if (!wanted.length) return 0;
    const exact = wanted.some((label) => text === label);
    const contains = wanted.some((label) => text.includes(label) || label.includes(text));
    if (!exact && !contains) return -Infinity;
    let score = exact ? 200 : 100;
    if (isActionableClickTarget(element)) score += 60;
    if (descriptor.clickClear) score += 25;
    if (descriptor.box.inViewport) score += 25;
    if (descriptor.box.width > 520 || descriptor.box.height > 180) score -= 160;
    if ((descriptor.text || "").length > 180) score -= 120;
    if (/^(next|continue|back|close|skip|done)$/i.test(descriptor.text || "")) score += 80;
    return score;
  }

  function bestClickableForLabels(labels = [], root = document) {
    return visibleClickableCandidates(root)
      .map((element) => ({ element, score: scoreTargetCandidate(element, labels) }))
      .filter((item) => item.score > -Infinity)
      .sort((a, b) => b.score - a.score)[0]?.element || null;
  }

  function exactClickableForLabel(label = "", root = document) {
    const wanted = normalizeMatchText(label);
    if (!wanted) return null;
    return visibleClickableCandidates(root)
      .map((element) => {
        const descriptor = elementDescriptor(element);
        const text = normalizeMatchText(buttonText(element) || labelText(element) || element.innerText || element.textContent || element.getAttribute?.("aria-label") || "");
        if (text !== wanted) return null;
        let score = 200;
        if (descriptor?.box?.inViewport) score += 25;
        if (descriptor?.clickClear) score += 25;
        if ((descriptor?.text || "").length > 80) score -= 80;
        return { element, score };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)[0]?.element || null;
  }

  function resolveDecisionTarget(decision, map) {
    const primaryLabels = [
      decision.targetLabel,
      decision.value,
      ...activeSurfaceEntries(map)
        .filter((entry) => entry.id === decision.targetId)
        .map((entry) => entry.label)
    ].filter(Boolean);
    const labels = [
      ...primaryLabels,
      decision.message,
      decision.reason
    ].filter(Boolean);

    const activeSurfaceRoot = map?.activeSurface?.type && map.activeSurface.type !== "page" ? elementById(map.activeSurface.id) : null;
    const requestedControlId = decision.controlId || decision.targetSnapshot?.controlId || "";
    if (requestedControlId) {
      const control = (map.controls || []).find((item) => item.controlId === requestedControlId);
      const activationIds = [
        control?.preferredActivationElementId,
        ...(control?.actuators || [])
          .filter((item) => /activation|label|wrapper|state/.test(item.relation || ""))
          .map((item) => item.nodeId),
        control?.stateElementId
      ].filter(validTargetId);
      const controlTarget = activationIds.map((id) => elementById(id)).find((element) => element && isVisible(element) && !isDisabledLike(element));
      if (controlTarget) {
        logFlow("target.resolve", {
          method: "canonical-control",
          requested: { controlId: requestedControlId, targetId: decision.targetId, targetLabel: decision.targetLabel, value: decision.value },
          control: control ? {
            controlId: control.controlId,
            label: control.label,
            kind: control.kind,
            semantic: control.semantic,
            state: control.state
          } : null,
          resolved: elementDescriptor(controlTarget)
        });
        return controlTarget;
      }
    }
    const direct = validTargetId(decision.targetId) ? elementById(decision.targetId) : null;
    if (direct) {
      const directBox = isVisible(direct) ? elementBox(direct) : null;
      const directText = compactText(buttonText(direct) || labelText(direct) || direct.innerText || direct.textContent || "", 260);
      const directLooksLikeContainer = directBox && (directBox.width > 520 || directBox.height > 220 || directText.length > 220) && !isActionableClickTarget(direct);
      if (directLooksLikeContainer || scoreTargetCandidate(direct, primaryLabels.length ? primaryLabels : labels) < 0) {
        const nested = primaryLabels.map((label) => exactClickableForLabel(label, direct)).find(Boolean)
          || bestClickableForLabels(primaryLabels.length ? primaryLabels : labels, direct);
        if (nested) {
          logFlow("target.resolve", {
            method: "direct-id-descendant",
            requested: { targetId: decision.targetId, targetLabel: decision.targetLabel, value: decision.value },
            direct: elementDescriptor(direct),
            resolved: elementDescriptor(nested)
          });
          return nested;
        }
      }
      logFlow("target.resolve", {
        method: "direct-id",
        requested: { targetId: decision.targetId, targetLabel: decision.targetLabel, value: decision.value },
        resolved: elementDescriptor(direct)
      });
      return direct;
    }

    if (activeSurfaceRoot && primaryLabels.length) {
      const exactSurfaceTarget = primaryLabels.map((label) => exactClickableForLabel(label, activeSurfaceRoot)).find(Boolean);
      const surfaceTarget = exactSurfaceTarget || bestClickableForLabels(primaryLabels, activeSurfaceRoot);
      if (surfaceTarget) {
        logFlow("target.resolve", {
          method: "active-surface-descendant",
          requested: { targetId: decision.targetId, targetLabel: decision.targetLabel, value: decision.value },
          activeSurface: map.activeSurface,
          resolved: elementDescriptor(surfaceTarget)
        });
        return surfaceTarget;
      }
    }

    const ambiguousDecline = primaryLabels.some((label) => /^(no,?\s*thanks|none|without|decline)$/i.test(String(label || "").trim()));
    if (ambiguousDecline && shouldAutoDeclinePaidExtras()) {
      const pending = nextPendingTask(map, ["baggage", "bundle", "flexible_ticket", "cancellation_insurance", "seat"]);
      const pendingSection = (map.sections || []).find((section) => section.id === pending?.sectionId);
      const pendingRoot = elementById(pendingSection?.id);
      if (pendingRoot) {
        const scopedTarget = primaryLabels.map((label) => exactClickableForLabel(label, pendingRoot)).find(Boolean)
          || bestClickableForLabels(primaryLabels, pendingRoot);
        if (scopedTarget) {
          logFlow("target.resolve", {
            method: "pending-section-label",
            requested: { targetId: decision.targetId, targetLabel: decision.targetLabel, value: decision.value },
            pendingSection: { id: pendingSection.id, label: pendingSection.label, type: pendingSection.type },
            resolved: elementDescriptor(scopedTarget)
          });
          return scopedTarget;
        }
      }
    }

    for (const label of primaryLabels) {
      const entry = activeSurfaceEntries(map).find((item) => textMatchesIntent(elementById(item.id), label) || normalizeMatchText(item.label) === normalizeMatchText(label));
      const entryElement = elementById(entry?.id);
      if (entryElement) {
        const nested = exactClickableForLabel(label, entryElement) || bestClickableForLabels([label], entryElement);
        const resolved = nested || entryElement;
        logFlow("target.resolve", {
          method: "active-surface-label",
          label: compactText(label, 180),
          entry,
          resolved: elementDescriptor(resolved)
        });
        return resolved;
      }
    }

    const candidates = visibleClickableCandidates(document);

    for (const label of primaryLabels.length ? primaryLabels : labels) {
      const target = exactClickableForLabel(label, document) || bestClickableForLabels([label], document) || candidates.find((element) => textMatchesIntent(element, label));
      if (target) {
        logFlow("target.resolve", {
          method: "visible-text",
          label: compactText(label, 180),
          resolved: elementDescriptor(target),
          candidates: candidates.slice(0, 20).map((element) => elementDescriptor(element))
        });
        return target;
      }
    }

    logFlow("target.resolve_failed", {
      requested: { targetId: decision.targetId, targetLabel: decision.targetLabel, value: decision.value },
      labels: labels.map((label) => compactText(label, 180)).slice(0, 8),
      activeSurface: map.activeSurface,
      candidates: candidates.slice(0, 30).map((element) => elementDescriptor(element))
    });
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
    // Retired for the same reason as outlineCoreSections: this box was only ever
    // refreshed by two narrow legacy code paths (the initial announceSectionQueue
    // call, and the JS auto-fill helper for simple named fields) — the main
    // AI-decision execution path never called or cleared it, so it froze on
    // whatever it last touched (usually "contact") while the cursor and the
    // sidebar's section checklist had already moved on. Those two are the
    // accurate, always-current source of "what's it working on" now.
    clearSectionHighlights();
    return element || null;
  }

  function displaySectionStatus(section) {
    if (section.type === "continue" || section.status === "gate") {
      return (agent.pageMap?.taskQueue || []).some((task) => task.status === "pending") ? "gate blocked" : "gate ready";
    }
    return section.status || "unknown";
  }

  function outlineCoreSections(sections = []) {
    // Retired: the on-page section boxes guessed boundaries from DOM proximity
    // (sectionBand/sectionContainer), which can't reliably find pixel-accurate
    // edges on arbitrary site markup — they routinely overlapped adjacent
    // sections even with no modal involved. The sidebar's section checklist
    // (agentSectionsHtml) shows the same done/current/pending state without
    // guessing page coordinates, so this just clears any leftover boxes now.
    clearSectionOutlines();
    return liveSectionModels(sections).filter((section) => section.element && isVisible(section.element));
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
    const named = patterns
      .map(([label, pattern, resolver]) => {
        const element = resolver ? resolver() : sectionAnchorByText(pattern);
        if (!element) return null;
        const id = elementId(element);
        if (seen.has(id)) return null;
        seen.add(id);
        return { label, element, box: elementBox(element) };
      })
      .filter(Boolean);
    const generic = detectGenericSections(named.map((section) => section.element))
      .filter((section) => {
        const id = elementId(section.element);
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
    return [...named, ...generic].sort((a, b) => a.box.y - b.box.y);
  }

  function genericSectionLabel(text) {
    const firstLine = (text.split(/\n|(?<=[.!?])\s{2,}/)[0] || text).replace(/\s+/g, " ").trim();
    return (firstLine.length >= 4 ? firstLine : text.replace(/\s+/g, " ").trim()).slice(0, 60) || "additional section";
  }

  function detectGenericSections(claimedElements = []) {
    const isClaimed = (element) => claimedElements.some((claimed) => claimed === element || claimed.contains(element) || element.contains(claimed));
    const candidates = queryAllDeep("section, article, form, fieldset, div")
      .filter((element) => isVisible(element) && !element.closest("#atw-sidebar, .atw-section-outline, #atw-agent-cursor"))
      .filter((element) => !isClaimed(element))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        if (rect.width < 260 || rect.height < 90 || rect.height > 1400) return null;
        const text = (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
        if (!text || text.length < 8 || text.length > 2600) return null;
        if (isSummaryLikeElement(element)) return null;
        const decisionControls = queryAllDeep("input[type='radio'], input[type='checkbox'], select, [role='combobox'], [role='listbox']", element)
          .filter((control) => isVisible(control) && !control.closest("#atw-sidebar"));
        const emptyRequiredFields = candidateInputs()
          .filter((input) => element.contains(input) && isVisible(input) && !input.closest("#atw-sidebar") && !fieldValue(input) && (input.required || /\*/.test(labelText(input))));
        if (!decisionControls.length && !emptyRequiredFields.length) return null;
        const headingCount = checkoutHeadingCount(text);
        let score = 60;
        score += Math.min(40, decisionControls.length * 8);
        score += Math.min(40, emptyRequiredFields.length * 10);
        score -= headingCount > 1 ? headingCount * 20 : 0;
        score -= Math.abs(rect.width - 760) / 100;
        return { element, score, area: rect.width * rect.height, text };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score || a.area - b.area);
    const accepted = [];
    for (const candidate of candidates) {
      const overlapsAccepted = accepted.some((item) => item.element.contains(candidate.element) || candidate.element.contains(item.element));
      if (overlapsAccepted) continue;
      accepted.push(candidate);
    }
    return accepted.map(({ element, text }) => ({
      label: genericSectionLabel(text),
      element,
      box: elementBox(element)
    }));
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
      .map((field) => {
        const control = canonicalControlForElement(field.element, {
          section,
          sectionId: section.id,
          sectionType: section.type,
          sectionLabel: section.label,
          field: field.field,
          required: field.required
        });
        return applyControlToModel({
          id: field.id,
          label: field.label,
          field: field.field,
          kind: field.kind,
          semantic: semanticFieldType(field),
          role: field.role || field.accessibility?.role || "",
          accessibility: field.accessibility || null,
          required: field.required,
          hasValue: Boolean(field.value),
          value: field.value ? "[filled]" : "",
          box: field.box
        }, control);
      });
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
      .map((button) => {
        const control = canonicalControlForElement(button.element, {
          section,
          sectionId: section.id,
          sectionType: section.type,
          sectionLabel: section.label,
          field: button.semantic
        });
        return applyControlToModel({
          id: button.id,
          label: button.label,
          risk: button.risk,
          semantic: button.semantic,
          role: button.role || button.accessibility?.role || "",
          accessibility: button.accessibility || null,
          box: button.box
        }, control);
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

  function choiceRisk(label = "") {
    const semantic = semanticChoiceType(label);
    if (/decline_/.test(semantic)) return "safe_decline";
    if (semantic === "add_paid_extra") return "money";
    if (semantic === "continue" || semantic === "traveler_title") return "safe";
    return "uncertain";
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
    return root?.closest?.("label, [role='radio'], [role='checkbox'], [role='option'], [role='button'], li, tr, fieldset, [role='radiogroup'], [role='group'], div") || element;
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

  function controlStateForElement(element) {
    const value = currentElementValue(element);
    return {
      checked: Boolean(element?.checked === true || element?.getAttribute?.("aria-checked") === "true"),
      selected: Boolean(element?.selected === true || element?.getAttribute?.("aria-selected") === "true" || isChoiceSelected(element)),
      valuePresent: Boolean(value && String(value).trim()),
      value: value ? "[filled]" : "",
      disabled: isDisabledLike(element),
      required: Boolean(element?.required === true || element?.getAttribute?.("aria-required") === "true"),
      expanded: element?.getAttribute?.("aria-expanded") || "",
      pressed: element?.getAttribute?.("aria-pressed") || ""
    };
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
      label: compactText(buttonText(element) || labelText(element) || element.innerText || element.textContent || accessibleName(element), 180),
      box: elementBox(element)
    };
  }

  function canonicalControlForElement(element, context = {}) {
    if (!element || element.closest?.("#atw-sidebar")) return null;
    const stateElement = stateElementForControl(element);
    if (!stateElement || stateElement.closest?.("#atw-sidebar")) return null;
    const labelElement = labelElementForInput(stateElement);
    const wrapper = controlWrapperForElement(element, stateElement);
    const activationElement = labelElement || clickableAncestor(element) || clickableAncestor(wrapper) || wrapper || stateElement;
    const label = compactText(
      choiceLabel(stateElement)
      || buttonText(element)
      || labelText(stateElement)
      || accessibleName(element)
      || accessibleName(stateElement)
      || controlText(stateElement),
      220
    );
    const kind = controlKindForElement(stateElement);
    const semantic = /radio|checkbox|option/.test(kind) ? semanticChoiceType(label) : (semanticFieldType({ label, kind, field: context.field || "" }) || semanticChoiceType(label));
    const sectionType = context.sectionType || context.section?.type || "";
    const sectionLabel = context.sectionLabel || context.section?.label || "";
    const sectionId = context.sectionId || context.section?.id || "";
    const surface = context.surface || {};
    const members = [
      { element: stateElement, relation: "state" },
      { element: labelElement, relation: "label" },
      { element: wrapper, relation: "wrapper" },
      { element: activationElement, relation: "activation" },
      { element, relation: "source" }
    ].filter((item) => item.element);
    const boxes = members.map((item) => isVisible(item.element) ? elementBox(item.element) : null).filter(Boolean);
    const state = controlStateForElement(stateElement);
    const base = [
      surface.id || surface.type || "page",
      sectionId || sectionType || sectionLabel || "section",
      kind,
      semantic,
      label,
      elementId(stateElement)
    ].map(slugControlPart).join("_");
    const controlId = `ctrl_${base}`.slice(0, 118);
    members.forEach((item) => {
      try {
        item.element.dataset.atwControlId = controlId;
      } catch (_) {
        // Some SVG/foreign elements may not expose dataset. They still remain in the graph.
      }
    });
    const actuators = members
      .map((item) => actuatorEntry(item.element, item.relation))
      .filter(Boolean)
      .filter((entry, index, list) => list.findIndex((other) => other.nodeId === entry.nodeId && other.relation === entry.relation) === index);
    return {
      controlId,
      id: controlId,
      label,
      accessibleName: accessibleName(stateElement) || accessibleName(element),
      kind,
      role: implicitRole(stateElement) || implicitRole(element),
      semantic,
      risk: choiceRisk(label),
      state,
      selected: Boolean(state.checked || state.selected),
      required: Boolean(state.required || context.required),
      sectionId,
      sectionType,
      sectionLabel,
      surfaceId: surface.id || "",
      surfaceType: surface.type || "page",
      surfaceLabel: surface.label || "",
      stateElementId: elementId(stateElement),
      preferredActivationElementId: elementId(activationElement || stateElement),
      actuators,
      visualRegion: unionBoxes(boxes) || elementBox(stateElement)
    };
  }

  function applyControlToModel(model, control) {
    if (!model || !control) return model;
    model.controlId = control.controlId;
    model.controlKind = control.kind;
    model.controlState = control.state;
    model.stateElementId = control.stateElementId;
    model.preferredActivationElementId = control.preferredActivationElementId;
    model.actuators = control.actuators;
    model.visualRegion = control.visualRegion;
    return model;
  }

  function buildCanonicalControlGraph(sections = [], fields = [], buttons = [], activeSurface = {}) {
    const controls = new Map();
    const remember = (control) => {
      if (!control?.controlId) return;
      const existing = controls.get(control.controlId) || {};
      const actuators = [...(existing.actuators || []), ...(control.actuators || [])]
        .filter((entry, index, list) => entry?.nodeId && list.findIndex((other) => other.nodeId === entry.nodeId && other.relation === entry.relation) === index);
      controls.set(control.controlId, {
        ...existing,
        ...control,
        actuators,
        visualRegion: unionBoxes([existing.visualRegion, control.visualRegion].filter(Boolean)) || control.visualRegion || existing.visualRegion
      });
    };

    for (const field of fields || []) {
      const section = (sections || []).find((item) => field.element && elementById(item.id)?.contains?.(field.element));
      const control = canonicalControlForElement(field.element, {
        section,
        sectionId: section?.id || "",
        sectionType: section?.type || "",
        sectionLabel: section?.label || "",
        field: field.field,
        required: field.required
      });
      remember(control);
      applyControlToModel(field, control);
    }

    for (const button of buttons || []) {
      const control = canonicalControlForElement(button.element, {
        field: button.semantic,
        required: false
      });
      remember(control);
      applyControlToModel(button, control);
    }

    for (const section of sections || []) {
      for (const group of [section.fields || [], section.choices || [], section.buttons || []]) {
        for (const item of group) {
          const source = elementById(item.stateElementId || item.id);
          const control = source ? canonicalControlForElement(source, {
            section,
            sectionId: section.id,
            sectionType: section.type,
            sectionLabel: section.label,
            required: item.required
          }) : null;
          remember(control);
          applyControlToModel(item, control);
        }
      }
    }

    const surface = activeSurface?.type && activeSurface.type !== "page" ? activeSurface : null;
    if (surface) {
      for (const item of [...(surface.options || []), ...(surface.buttons || [])]) {
        const source = elementById(item.id);
        const control = source ? canonicalControlForElement(source, { surface }) : null;
        remember(control);
        applyControlToModel(item, control);
      }
    }

    return [...controls.values()].slice(0, 180);
  }

  function sectionChoiceModels(section, allSections = []) {
    return sectionChoiceInputs(section, allSections)
      .map((input) => {
        const label = choiceLabel(input);
        const control = canonicalControlForElement(input, {
          section,
          sectionId: section.id,
          sectionType: section.type,
          sectionLabel: section.label,
          required: true
        });
        return applyControlToModel({
          id: elementId(input),
          label,
          selected: Boolean(isChoiceSelected(input)),
          semantic: semanticChoiceType(label),
          risk: choiceRisk(label),
          role: implicitRole(input),
          accessibility: accessibilityNode(input, null),
          box: elementBox(input)
        }, control);
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
      let status = inferSectionStatus(sectionContext, sectionFields, sectionButtons, sections);
      if (type !== "continue" && canUseCompletionMemoryForSectionType(type) && sectionDone(type) && status !== "incomplete" && status !== "blocked") status = "complete";
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

  function stageExitBlockers(map = buildPageMap(), decision = {}) {
    const blockers = [];
    const label = normalizeMatchText(`${decision.targetLabel || ""} ${decision.value || ""}`);
    const navLabel = stageExitIntentLabel(decision, map);
    const currentSurface = map.currentSurface || map.activeSurface || { type: "page" };
    const surfaceActive = Boolean(currentSurface.type && currentSurface.type !== "page");
    const seatNoSelectionContinue = isSeatNoSelectionContinue(decision, map);
    const allowSeatSkipNavigation = seatNoSelectionContinue || (shouldAutoDeclinePaidExtras()
      && map.step === "seats"
      && Boolean(navLabel)
      && !/\b(choose|select|pick)\b.*\bseat\b|\bseat\b.*\b(choose|select|pick)\b/.test(label));
    const targetIsActiveSurfaceNavigation = surfaceActive
      && Boolean(navLabel);
    const pendingTasks = (surfaceActive ? (currentSurface.taskQueue || map.currentSurfaceTasks || []) : (map.taskQueue || []))
      .filter((task) => task.status === "pending");
    const actionableTasks = allowSeatSkipNavigation
      ? pendingTasks.filter((task) => task.sectionType !== "seat")
      : pendingTasks;
    if (actionableTasks.length) {
      const task = actionableTasks[0];
      blockers.push({
        code: "PENDING_REQUIRED_SECTION",
        message: `${task.sectionLabel || task.sectionType || "A required section"} is still unresolved.`
      });
    }
    const overlays = (map.overlays || []).filter((overlay) => overlay?.label || overlay?.text);
    if (overlays.length && !targetIsActiveSurfaceNavigation && !seatNoSelectionContinue) {
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
      const unresolvedChoice = (map.sections || []).find((section) => {
        if (!section || section.status === "complete" || section.status === "blocked") return false;
        if (allowSeatSkipNavigation && section.type === "seat") return false;
        return Boolean(section.required || section.choices?.length || section.paidChoice);
      });
      if (unresolvedChoice && !blockers.some((blocker) => blocker.code === "PENDING_REQUIRED_SECTION")) {
        blockers.push({
          code: "UNRESOLVED_VISIBLE_CHOICE",
          message: `${unresolvedChoice.label || unresolvedChoice.type || "A visible choice"} still needs a verified decision.`
        });
      }
    }
    return blockers;
  }

  function expectedOutcomeForDecision(decision = {}, map = buildPageMap(), target = null) {
    const targetId = target ? elementId(target) : decision.targetId || "";
    const targetControl = target ? canonicalControlForElement(target, { section: liveSectionForElement(map, target) }) : null;
    const snapshotControlId = decision.controlId || decision.targetSnapshot?.controlId || targetControl?.controlId || "";
    const label = decision.targetLabel || decision.value || (target ? buttonText(target) || labelText(target) || target.innerText || "" : "");
    const section = target ? liveSectionForElement(map, target) : null;
    const activeSurface = map.currentSurface || map.activeSurface || {};
    const base = {
      action: decision.action || "",
      targetId,
      controlId: snapshotControlId,
      stateElementId: decision.targetSnapshot?.stateElementId || targetControl?.stateElementId || "",
      targetLabel: String(label || "").replace(/\s+/g, " ").trim().slice(0, 180),
      beforeSignature: structuralPageSignature(map),
      beforeVisualState: visualPageState(map)
    };
    if (decision.expectedOutcome && typeof decision.expectedOutcome === "object") {
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
    logFlow("latency.span", {
      outcome_verification_ms: Math.round(performance.now() - startedAt),
      expectedOutcome: expected?.type || "",
      target: expected?.targetId || expected?.controlId || expected?.targetLabel || ""
    });
    return verification;
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
    const evidence = {
      beforeStep: beforeMap.step,
      afterStep: afterMap.step,
      beforeUrl: beforeMap.url || location.href,
      afterUrl: location.href,
      beforeSurface: beforeMap.activeSurface?.label || "",
      afterSurface: afterMap.activeSurface?.label || "",
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
    const afterControl = expectedControlId
      ? (afterMap.controls || []).find((control) => control.controlId === expectedControlId)
      : null;
    const afterControlState = afterControl?.state || null;
    const logicalControlSatisfied = Boolean(
      afterControl
      && (
        afterControl.selected
        || afterControlState?.checked
        || afterControlState?.selected
        || afterControlState?.valuePresent
      )
    );
    if (expected.type === "field_value_changed") {
      const liveTarget = target && isVisible(target) ? target : elementById(expected.stateElementId || expected.targetId);
      const value = currentElementValue(liveTarget);
      const ok = (Boolean(value) && (!expected.expectedValue || normalizeMatchText(value).includes(normalizeMatchText(expected.expectedValue).slice(0, 24))))
        || Boolean(afterControlState?.valuePresent);
      return {
        ok,
        code: ok ? "FIELD_VALUE_VERIFIED" : "FIELD_VALUE_NOT_VERIFIED",
        message: ok ? "Field value is present after the action." : "Field value was not retained after the action.",
        evidence: { ...evidence, value, control: afterControl || null }
      };
    }
    if (expected.type === "section_choice_verified") {
      const section = (afterMap.sections || []).find((item) => item.id === expected.sectionId)
        || (afterMap.sections || []).find((item) => item.type === expected.sectionType && item.label === expected.sectionLabel)
        || (afterMap.sections || []).find((item) => item.type === expected.sectionType);
      const ok = section?.status === "complete";
      return {
        ok,
        code: ok ? "SECTION_COMPLETE" : "SECTION_STILL_INCOMPLETE",
        message: ok ? `${expected.sectionLabel || expected.sectionType} is complete.` : `${expected.sectionLabel || expected.sectionType || "Section"} is still incomplete.`,
        evidence: { ...evidence, section: section ? { id: section.id, label: section.label, type: section.type, status: section.status, selected: section.selected || [] } : null }
      };
    }
    if (expected.type === "requirement_status") {
      const expectedRequirement = normalizeMatchText(expected.requirementId || expected.sectionLabel || expected.intent || "");
      const matchedSection = (afterMap.sections || []).find((item) =>
        item.id === expected.sectionId
        || item.id === expected.targetId
        || (expectedRequirement && normalizeMatchText(item.type || "") === expectedRequirement)
        || (expectedRequirement && normalizeMatchText(item.label || "").includes(expectedRequirement))
        || (normalizeMatchText(item.label || "") && normalizeMatchText(expected.sectionLabel || "").includes(normalizeMatchText(item.label || "")))
      );
      const targetSelected = expected.targetId
        ? [...(afterMap.buttons || []), ...(afterMap.fields || []), ...(afterMap.sections || []).flatMap((section) => section.choices || [])]
          .some((item) => (item.id === expected.targetId || item.controlId === expected.targetId || item.controlId === expectedControlId) && (item.selected || item.hasValue || item.controlState?.checked || item.controlState?.selected || item.controlState?.valuePresent))
        : false;
      const activeSurfaceProgress = beforeMap.activeSurface?.label && beforeMap.activeSurface?.label !== afterMap.activeSurface?.label;
      const ok = logicalControlSatisfied || targetSelected || matchedSection?.status === "complete" || (activeSurfaceProgress && !evidence.errors.length);
      return {
        ok,
        code: ok ? "REQUIREMENT_EVIDENCE_VERIFIED" : "REQUIREMENT_NOT_VERIFIED",
        message: ok
          ? `${expected.requirementId || expected.sectionLabel || "Requirement"} has evidence after the action.`
          : `${expected.requirementId || expected.sectionLabel || "Requirement"} is still missing evidence after the action.`,
        evidence: {
          ...evidence,
          control: afterControl || null,
          logicalControlSatisfied,
          targetSelected,
          section: matchedSection ? {
            id: matchedSection.id,
            label: matchedSection.label,
            type: matchedSection.type,
            status: matchedSection.status,
            selected: matchedSection.selected || []
          } : null
        }
      };
    }
    if (expected.type === "active_surface_change") {
      const afterSurface = afterMap.activeSurface || {};
      const afterSurfaceSignature = `${afterSurface.type || ""}:${afterSurface.label || ""}:${(afterSurface.options || []).map((entry) => entry.id).join(",")}`;
      const beforeSurface = beforeMap.activeSurface || {};
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
    if (expected.type === "stage_exit_or_feedback") {
      const errors = actionableCheckoutErrors(afterMap.errors || []);
      const blockers = stageExitBlockers(afterMap, expected);
      if (changed && beforeMap.step !== afterMap.step) {
        return { ok: true, code: "STAGE_CHANGED", message: `Stage changed to ${afterMap.step}.`, evidence };
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

  function pushVerificationLedger(actionId, observationId, decision, expectedOutcome, verification) {
    const executionResult = rememberActionExecutionResult(actionId, observationId, decision, expectedOutcome, verification);
    pushActionLedger({
      actionId,
      observationId,
      stage: "verified",
      action: decision,
      expectedOutcome,
      executionResult,
      result: {
        ok: Boolean(verification.ok),
        code: verification.code,
        message: verification.message,
        evidence: verification.evidence
      }
    });
    logFlow("outcome.verify", {
      actionId,
      observationId,
      expectedOutcome,
      verification,
      executionResult
    });
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

  function userLikeClick(element, meta = {}) {
    const rect = element.getBoundingClientRect();
    const eventInit = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: Math.round(rect.left + rect.width / 2),
      clientY: Math.round(rect.top + rect.height / 2)
    };
    logFlow("dom.click.dispatch", {
      meta,
      point: { x: eventInit.clientX, y: eventInit.clientY },
      target: elementDescriptor(element),
      pageBefore: pageSnapshot("before-click")
    });
    watchClickToFirstMutation("click", meta);
    element.dispatchEvent(new PointerEvent("pointerdown", eventInit));
    element.dispatchEvent(new MouseEvent("mousedown", eventInit));
    element.dispatchEvent(new PointerEvent("pointerup", eventInit));
    element.dispatchEvent(new MouseEvent("mouseup", eventInit));
    element.dispatchEvent(new MouseEvent("click", eventInit));
  }

  function watchClickToFirstMutation(method = "click", meta = {}) {
    const startedAt = performance.now();
    let done = false;
    const finish = (changed) => {
      if (done) return;
      done = true;
      observer.disconnect();
      logFlow("latency.span", {
        click_to_first_mutation_ms: changed ? Math.round(performance.now() - startedAt) : null,
        mutation_observed: Boolean(changed),
        method,
        meta
      });
    };
    const observer = new MutationObserver(() => finish(true));
    try {
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true
      });
      setTimeout(() => finish(false), 1600);
    } catch (error) {
      logFlow("latency.span", {
        click_to_first_mutation_ms: null,
        mutation_observed: false,
        method,
        error: error.message
      });
    }
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

  function clickViewportPoint(x = 18, y = 18, meta = {}) {
    const target = document.elementFromPoint(x, y) || document.body;
    const eventInit = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: x,
      clientY: y
    };
    logFlow("dom.click_xy.dispatch", {
      meta,
      point: { x, y },
      topElement: elementDescriptor(target),
      pageBefore: pageSnapshot("before-click-xy")
    });
    watchClickToFirstMutation("click_xy", meta);
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
    const startedAt = performance.now();
    await showAgentThought(document.activeElement || document.body, "Wait", "Watching page update", "Waiting for popups, dropdowns, validation, price/order changes, or URL changes.", 600);
    await waitForPaint(ms);
    logFlow("latency.span", {
      page_settle_ms: Math.round(performance.now() - startedAt),
      requested_settle_ms: ms
    });
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

  // Self-contained variant of classifyStep() that also returns a confidence score.
  // Kept separate from classifyStep() so existing callers are untouched; used only
  // by the Observer Mode page-understanding output.
  function classifyStepDetailed(text) {
    const lower = text.toLowerCase();
    const extrasEvidence = /select baggage|configure your trip|upgrade your trip|checked baggage|bundle|premium support|airhelp|cancellation guarantee|voucher refund|add to cart|no thanks|add baggage|choose your bundle/.test(lower);
    const travelerEvidence = /traveller information|traveler information|contact information|provide your contact details|passport|date of birth|surname|first name|first and middle names|mobile number|confirm e-?mail/.test(lower);
    const seatEvidence = /seat selection|select seat|choose seat/.test(lower);
    const strongSeatEvidence = /reserve seating|seat map|seat map key|standard seat|not selected|select a seat|choose a seat/.test(lower);
    const travelerRouteEvidence = /\/rf\/traveler-details|\/rf\/traveller-details|traveler-details|traveller-details/.test(lower);
    const paymentFormEvidence = /card number|security code|cvc|cvv|pay now|complete booking|confirm and pay|submit payment|billing card|cardholder/.test(lower);
    const paymentRouteEvidence = /\/rf\/payment|\/payment\b|[#?&/]payment\b/.test(lower);
    const confirmationEvidence = /booking confirmed|confirmation|booking reference|reservation number|pnr/.test(lower);
    const flightSelectionEvidence = /flight selection|select flight|choose flight|fare/.test(lower);

    if (confirmationEvidence) return { step: "confirmation", confidence: 0.95 };
    if (paymentFormEvidence) return { step: "payment", confidence: 0.95 };
    if (strongSeatEvidence) return { step: "seats", confidence: 0.9 };
    if (travelerRouteEvidence) return { step: "traveler_information", confidence: 0.9 };
    if (paymentRouteEvidence && extrasEvidence) return { step: "extras", confidence: 0.75 };
    if (paymentRouteEvidence && seatEvidence) return { step: "seats", confidence: 0.75 };
    if (travelerEvidence) return { step: "traveler_information", confidence: 0.8 };
    if (seatEvidence) return { step: "seats", confidence: 0.7 };
    if (extrasEvidence) return { step: "extras", confidence: 0.7 };
    if (paymentRouteEvidence) return { step: "payment", confidence: 0.6 };
    if (flightSelectionEvidence) return { step: "flight_selection", confidence: 0.6 };
    return { step: "unknown", confidence: 0.2 };
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

  function numericZIndex(element) {
    const value = Number.parseInt(getComputedStyle(element).zIndex || "0", 10);
    return Number.isFinite(value) ? value : 0;
  }

  function pointBelongsToElement(point, element) {
    const top = document.elementFromPoint(point.x, point.y);
    return Boolean(top && (top === element || element.contains(top)));
  }

  function overlayTopHitCount(element) {
    if (!element || !isVisible(element) || !isInViewport(element)) return 0;
    const rect = element.getBoundingClientRect();
    const left = Math.max(2, rect.left + Math.min(28, rect.width * 0.18));
    const right = Math.min(window.innerWidth - 2, rect.right - Math.min(28, rect.width * 0.18));
    const top = Math.max(2, rect.top + Math.min(28, rect.height * 0.18));
    const bottom = Math.min(window.innerHeight - 2, rect.bottom - Math.min(28, rect.height * 0.18));
    const centerX = Math.min(window.innerWidth - 2, Math.max(2, rect.left + rect.width / 2));
    const centerY = Math.min(window.innerHeight - 2, Math.max(2, rect.top + rect.height / 2));
    const points = [
      { x: centerX, y: centerY },
      { x: left, y: top },
      { x: right, y: top },
      { x: left, y: bottom },
      { x: right, y: bottom }
    ];
    return points.filter((point) => pointBelongsToElement(point, element)).length;
  }

  function overlayVisualScore(element) {
    const rect = element.getBoundingClientRect();
    return (overlayTopHitCount(element) * 1000000) + (numericZIndex(element) * 1000) + Math.round(Math.min(rect.width * rect.height, 900000));
  }

  function surfaceProgressMarkers(text = "") {
    const clean = String(text || "").replace(/\s+/g, " ");
    return {
      flightOrdinal: clean.match(/\bflight\s+\d+\s+of\s+\d+\b/i)?.[0] || "",
      route: clean.match(/\b[A-Z]{3}\s*(?:-|–|to)\s*[A-Z]{3}\b/)?.[0] || "",
      selectedText: clean.match(/\b(not selected|selected|seat not selected|random seating)\b/i)?.[0] || "",
      priceText: clean.match(/\b\d+(?:[.,]\d{1,2})?\s*(?:EUR|USD|GBP|€|\$|£)\b/i)?.[0] || ""
    };
  }

  function surfaceVisualFingerprint(surface = {}) {
    return stableHash([
      surface.type || "",
      normalizeMatchText(surface.label || ""),
      (surface.options || []).map((option) => `${normalizeMatchText(option.label)}:${option.selected ? "1" : "0"}`).join("|"),
      JSON.stringify(surfaceProgressMarkers(surface.label || ""))
    ].join("||"));
  }

  function foregroundSurfaceState(activeSurface = {}) {
    const active = Boolean(activeSurface?.type && activeSurface.type !== "page");
    const text = surfaceText(activeSurface);
    const optionCount = (activeSurface.options || []).length;
    const navCount = (activeSurface.options || []).filter((option) => /^(next|continue|close|done|confirm)\b/i.test(option.label || "")).length;
    const confidence = !active ? 0 : Math.min(0.99, 0.45
      + (activeSurface.role ? 0.1 : 0)
      + (activeSurface.box?.inViewport ? 0.15 : 0)
      + (optionCount ? 0.15 : 0)
      + (navCount ? 0.1 : 0)
      + (/seat|baggage|bundle|insurance|extra|are you sure|not selected/i.test(text) ? 0.05 : 0));
    return {
      active,
      id: activeSurface.id || "",
      type: activeSurface.type || "page",
      label: activeSurface.label || "",
      blocksBackground: active,
      confidence,
      reason: active ? "Visible foreground surface owns the next action until it closes or changes." : "No foreground surface detected.",
      progressMarkers: surfaceProgressMarkers(text),
      fingerprint: surfaceVisualFingerprint(activeSurface),
      optionCount,
      navigationControlCount: navCount,
      box: activeSurface.box || null
    };
  }

  function compactVisualControl(item = {}) {
    const box = item.box || {};
    const role = item.accessibility?.role || item.role || "";
    const name = item.accessibility?.name || item.label || item.field || "";
    return {
      id: item.id || "",
      role,
      name: String(name || "").replace(/\s+/g, " ").trim().slice(0, 160),
      label: String(item.label || item.field || "").replace(/\s+/g, " ").trim().slice(0, 160),
      kind: item.kind || item.field || "",
      semantic: item.semantic || item.field || "",
      risk: item.risk || "",
      selected: Boolean(item.selected),
      required: Boolean(item.required),
      hasValue: Boolean(item.hasValue || item.value),
      state: item.accessibility?.state || null,
      box: box ? {
        x: Math.round(box.x || 0),
        y: Math.round(box.y || 0),
        width: Math.round(box.width || 0),
        height: Math.round(box.height || 0),
        centerX: Math.round(box.centerX || 0),
        centerY: Math.round(box.centerY || 0),
        inViewport: Boolean(box.inViewport)
      } : null
    };
  }

  function visualPageState(map = agent.pageMap || {}) {
    const activeSurface = map.currentSurface && map.currentSurface.type !== "page" ? map.currentSurface : (map.activeSurface || {});
    const foreground = foregroundSurfaceState(activeSurface);
    const surfaceControls = foreground.active
      ? [...(activeSurface.buttons || []), ...(activeSurface.options || [])]
      : [];
    const pageControls = !foreground.active
      ? [
          ...(map.fields || []),
          ...(map.buttons || []),
          ...(map.sections || []).flatMap((section) => section.choices || [])
        ]
      : [];
    const controls = [...surfaceControls, ...pageControls]
      .filter((item, index, list) => item && (item.id || item.label || item.field) && list.findIndex((other) => other?.id === item.id && other?.label === item.label) === index)
      .map(compactVisualControl)
      .filter((item) => item.box?.inViewport || foreground.active)
      .slice(0, 120);
    const signature = [
      map.step || "",
      location.pathname,
      foreground.fingerprint || "",
      controls.map((item) => [
        item.id,
        normalizeMatchText(item.name || item.label),
        item.role,
        item.selected ? "1" : "0",
        item.hasValue ? "v" : "",
        item.box ? `${Math.round(item.box.centerX / 8)}:${Math.round(item.box.centerY / 8)}` : ""
      ].join(":")).join("|")
    ].join("||");
    return {
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        scrollX: Math.round(window.scrollX),
        scrollY: Math.round(window.scrollY),
        devicePixelRatio: window.devicePixelRatio || 1
      },
      foreground,
      controls,
      controlCount: controls.length,
      fingerprint: stableHash(signature)
    };
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
    return candidates
      .filter((element) => !candidates.some((other) => other !== element && element.contains(other) && overlayTopHitCount(other) > 0))
      .map((element) => ({ element, hitCount: overlayTopHitCount(element), score: overlayVisualScore(element) }))
      .filter((item) => item.hitCount > 0)
      .sort((a, b) => b.score - a.score)
      .map((item) => item.element);
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
    // HeadlessUI-style comboboxes often mark the outer wrapper with
    // data-headlessui-state="open" while role="listbox"/"option" lives on a nested
    // child — checking only the overlay's own role misses these, so the popover
    // never gets the auto-close (Escape/outside-click) treatment after a choice is
    // made and just lingers open, which is exactly what got mistaken for a stall.
    if (queryAllDeep("[role='listbox'], [role='option']", overlay).length) return true;
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
    const controls = optionControlCount(button);
    if (controls > 1 && /none of the passengers|none\s+of\s+the\s+travellers|none\s+of\s+the\s+travelers/.test(label) && /all passengers|all travellers|all travelers|passenger\s+\d|\badult\b/.test(label)) return -120;
    if (/none of the passengers|none\s+of\s+the\s+travellers|none\s+of\s+the\s+travelers/.test(label) && /0\s*(eur|€|usd|\$)|free/.test(label)) return 180;
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
    if (!guardedHelperAllowed("handleRoutineExtraOverlay", ["skip_optional_extra"])) return false;
    const text = overlayText(overlay);
    let kind = routineExtraOverlayKind(text, task);
    const buttons = overlayButtons(overlay);
    const hasSafeNoExtraOption = buttons.some((button) => {
      const label = overlayChoiceText(button);
      return overlayOptionRisk(label) === "safe_decline" || /none of the passengers|none of the travellers|none of the travelers|no,?\s*thanks|not now|without|0\s*(eur|€|usd|\$)|free/i.test(label);
    });
    if (!kind && hasSafeNoExtraOption) kind = "no-extra choice overlay";
    if (!kind || !shouldAutoDeclinePaidExtras()) {
      logAgentEvent("auto_decline_overlay_skipped", {
        context,
        reason: !kind ? "no routine kind or safe no-extra option detected" : "auto-decline not approved",
        text: text.slice(0, 180),
        options: buttons.map((button) => overlayChoiceText(button)).filter(Boolean).slice(0, 8)
      });
      return false;
    }
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

  function safeActiveSurfaceExitCandidate(overlay) {
    const kind = routineExtraOverlayKind(overlayText(overlay), null);
    return uniqueOverlayCandidates(overlayButtons(overlay)
      .map((button) => {
        const label = overlayChoiceText(button);
        let score = scoreAutoDeclineButton(button, kind);
        if (/^(next|continue|done|close|skip|no,?\s*thanks|not now|without|continue without)\b/i.test(label)) score += 80;
        if (isDangerousActionLabel(label)) score -= 200;
        if (overlayOptionRisk(label) === "paid") score -= 160;
        return { button, label, score };
      })
      .filter((item) => item.score > 0 && !item.button.disabled && item.button.getAttribute("aria-disabled") !== "true")
      .sort((a, b) => b.score - a.score))[0] || null;
  }

  async function skipOptionalExtraSurface(map = buildPageMap()) {
    if (!guardedHelperAllowed("skipOptionalExtraSurface", ["skip_optional_extra"])) return false;
    const overlay = activeOverlayElements()[0];
    const task = (map.taskQueue || []).find((item) => /baggage|bundle|flexible_ticket|cancellation_insurance|seat/.test(item.sectionType));
    if (overlay) {
      if (await handleRoutineExtraOverlay(overlay, "agent loop skip optional extra", task)) return true;
      const pick = safeActiveSurfaceExitCandidate(overlay);
      if (pick) {
        const before = overlaySignature(overlay);
        await showAgentThought(
          pick.button,
          "Active surface",
          `Skip optional extra`,
          `Using the safe visible control "${pick.label}" instead of selecting a paid seat/add-on.`,
          800
        );
        flashElement(pick.button);
        userLikeClick(pick.button);
        recordAction("skip_optional_extra", { label: pick.label, surface: routineExtraOverlayKind(overlayText(overlay), task) || "active surface" });
        const progress = await waitForOverlayProgress(overlay, before, 2200);
        await verifyAgentStep(pick.button, "Active surface", progress.ok ? `optional surface ${progress.reason}` : "optional surface did not change", progress.ok, 650);
        return progress.ok;
      }
      return false;
    }

    if (await skipNoExtraDropdownChoice(map)) return true;
    if (await autoResolveNoExtrasSection(map)) return true;
    const skip = findButtonByRisk(map, "skip_extra") || findClickableByVisibleText(/no,?\s*thanks|skip|without|none of the passengers/i);
    if (skip) {
      await showAgentThought(skip, "Extras", "Skip optional extra", "Saved rules say no paid seats/extras for this booking.", 800);
      flashElement(skip);
      userLikeClick(skip);
      recordAction("skip_optional_extra", { label: buttonText(skip) || labelText(skip) });
      await waitForUiSettle(700);
      return true;
    }
    return false;
  }

  function noExtraChoiceTerms() {
    return [
      "none of the passengers",
      "none of the travellers",
      "none of the travelers",
      "no thanks",
      "no, thanks",
      "not now",
      "without",
      "go without",
      "continue without",
      "0 eur",
      "0eur",
      "0 €",
      "no flexible",
      "no ticket",
      "decline"
    ];
  }

  async function chooseNoExtraFromControl(control, context = "optional extra") {
    if (!guardedHelperAllowed("chooseNoExtraFromControl", ["skip_optional_extra"])) return false;
    if (!control || !isVisible(control) || isPaymentField(control)) return false;
    const label = `${buttonText(control)} ${labelText(control)} ${control.innerText || ""}`.toLowerCase();
    if (isDangerousActionLabel(label)) return false;
    await showAgentThought(control, "Extras", "Choose no-extra option", `Saved rules say no paid extras. Opening ${context} and selecting the no-cost/no-thanks option.`, 650);
    let result = { ok: false };
    if (control.tagName === "SELECT") {
      result = await setSelectValue(control, noExtraChoiceTerms());
    } else {
      result = await selectComboboxOption(control, noExtraChoiceTerms());
    }
    recordAction("skip_optional_extra_dropdown", {
      ok: result.ok,
      context,
      method: result.method,
      option: result.option || result.value || "",
      reason: result.reason || "",
      target: control.id || control.name || buttonText(control) || labelText(control)
    });
    return Boolean(result.ok);
  }

  async function skipNoExtraDropdownChoice(map = buildPageMap(), decision = null) {
    if (!guardedHelperAllowed("skipNoExtraDropdownChoice", ["skip_optional_extra"])) return false;
    if (!shouldAutoDeclinePaidExtras()) return false;
    const explicit = decision ? resolveDecisionTarget(decision, map) : null;
    if (explicit && await chooseNoExtraFromControl(explicit, decision.targetLabel || decision.value || "optional extra")) return true;

    const pending = nextPendingTask(map, ["flexible_ticket", "bundle", "cancellation_insurance", "seat", "baggage"]);
    const pendingSection = (map.sections || []).find((section) => section.id === pending?.sectionId);
    const scopedControls = pendingSection
      ? queryAllDeep("select, [role='combobox'], button, [role='button'], [tabindex]", elementById(pendingSection.id) || document)
      : [];
    const candidates = [
      ...scopedControls,
      ...queryAllDeep("select, [role='combobox'], button, [role='button'], [tabindex]")
    ]
      .filter((element, index, list) => list.indexOf(element) === index)
      .filter((element) => isVisible(element) && !element.closest("#atw-sidebar") && !isPaymentField(element))
      .map((element) => {
        const text = `${currentElementValue(element)} ${buttonText(element)} ${labelText(element)} ${element.innerText || ""}`.replace(/\s+/g, " ").trim();
        const lower = text.toLowerCase();
        let score = 0;
        if (/choose|select an option|select one option|please select/.test(lower)) score += 70;
        if (/flexible ticket|premium support|airhelp|insurance|bundle|baggage|seat/.test(lower)) score += 40;
        if (pendingSection && elementBelongsToSectionBand(element, pendingSection, liveSectionModels(map.sections || []))) score += 50;
        if (/add to cart|premium|\b[1-9]\d*([.,]\d+)?\s*(eur|€|usd|\$)/.test(lower)) score -= 50;
        return { element, score, text };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score);

    for (const candidate of candidates.slice(0, 3)) {
      if (await chooseNoExtraFromControl(candidate.element, pending?.sectionLabel || candidate.text || "optional extra")) return true;
    }
    return false;
  }

  async function closeActiveSurface(map = buildPageMap()) {
    if (!guardedHelperAllowed("closeActiveSurface", ["close_modal"])) return false;
    const overlay = activeOverlayElements()[0];
    if (!overlay) return false;
    const closeButton = overlayButtons(overlay).find((button) => /^(close|done|no,?\s*thanks|not now|skip)\b|×|x$/i.test(overlayChoiceText(button)));
    const target = closeButton || elementById(map.activeSurface?.id) || overlay;
    const before = overlaySignature(overlay);
    await showAgentThought(target, "Active surface", closeButton ? "Close modal" : "Close modal with Escape", "Closing the active popup before continuing.", 700);
    if (closeButton) {
      flashElement(closeButton);
      userLikeClick(closeButton);
    } else {
      pressEscape(document.activeElement || document.body);
    }
    const progress = await waitForOverlayProgress(overlay, before, 1600);
    await verifyAgentStep(target, "Active surface", progress.ok ? `surface ${progress.reason}` : "surface still open", progress.ok, 550);
    return progress.ok;
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
      const activeSurface = buildActiveSurface([overlay]);
      if (AGENT_SINGLE_BRAIN) {
        logAgentEvent("active_surface_observed_single_brain", {
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
          "A popup/dropdown is active. I will send it to the backend planner instead of taking a local action.",
          650
        );
        return { blocked: false, handled: false, overlays: overlays.length, activeSurface };
      }
      const task = (map.taskQueue || []).find((item) => item.status === "pending" && /baggage|bundle|flexible_ticket|cancellation_insurance|seat/.test(item.sectionType));
      if (await handleRoutineExtraOverlay(overlay, context, task)) {
        logAgentEvent("active_surface_local_resolved", {
          context,
          type: activeSurface.type,
          taskHint: activeSurface.taskHint,
          reason: "routine no-extra active surface handled before backend"
        });
        await waitForPaint(500);
        return { blocked: false, handled: true, overlays: overlays.length };
      }
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
          "This popup/dropdown is the active screen. No deterministic no-extra action resolved it, so I will ask the visual agent.",
          750
        );
        return { blocked: false, handled: false, overlays: overlays.length, activeSurface };
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

  function isSeatNoSelectionConfirmationContext(map = agent.pageMap || buildPageMap()) {
    if (!shouldAutoDeclinePaidExtras()) return false;
    const surfaceText = [
      map?.activeSurface?.label,
      map?.activeSurface?.text,
      ...(map?.overlays || []).map((overlay) => `${overlay.label || ""} ${overlay.text || ""}`),
      map?.text
    ].filter(Boolean).join(" ").toLowerCase();
    return /are you sure|haven.?t selected a seat|not selected.*seat|seat.*not selected|without.*seat/.test(surfaceText)
      && /choose seat/.test(surfaceText)
      && /\bcontinue\b/.test(surfaceText);
  }

  function isSeatNoSelectionContinue(decision = {}, map = agent.pageMap || buildPageMap()) {
    const label = normalizeMatchText(`${decision.targetLabel || ""} ${decision.value || ""}`);
    return /\b(continue|next|proceed)\b/.test(label)
      && !/\b(choose|select|pick)\b.*\bseat\b|\bseat\b.*\b(choose|select|pick)\b/.test(label)
      && isSeatNoSelectionConfirmationContext(map);
  }

  function exactNavigationText(label = "") {
    const text = normalizeMatchText(label);
    return /^(continue|next|proceed|skip to next step)$/.test(text)
      || /^(continue|next|proceed)\s+(button|navigation|action)$/.test(text);
  }

  function declineChoiceIntent(decision = {}) {
    const snapshot = decision.targetSnapshot || {};
    if (decision.intent === "decline_optional_extra"
      || snapshot.semantic === "decline_paid_extra"
      || snapshot.semantic === "safe_decline"
      || snapshot.risk === "safe_decline") {
      return true;
    }
    const targetText = `${decision.targetLabel || ""} ${decision.value || ""}`.toLowerCase();
    const contextText = `${targetText} ${decision.reason || ""}`.toLowerCase();
    return overlayOptionRisk(targetText) === "safe_decline"
      || /no checked baggage|no baggage selected|no baggage|no,?\s*thanks|none of the passengers|i.?ll go without|go without|without bundle|without baggage|decline|skip|0\s*(eur|€|usd|\$)|no-cost|no cost/.test(contextText);
  }

  function stageExitIntentLabel(decision = {}, map = agent.pageMap || buildPageMap()) {
    const raw = `${decision.targetLabel || ""} ${decision.value || ""}`.trim();
    const snapshot = decision.targetSnapshot || {};
    const snapshotLabel = snapshot.normalizedLabel || snapshot.label || "";
    if (isSeatNoSelectionContinue(decision, map)) return normalizeMatchText(raw) || "continue";
    if (exactNavigationText(raw)) return normalizeMatchText(raw);
    if (exactNavigationText(snapshotLabel)) return normalizeMatchText(snapshotLabel);
    if (snapshot.risk === "safe_continue" || snapshot.semantic === "continue") return normalizeMatchText(snapshotLabel || raw);
    const targetId = decision.targetId || snapshot.id || "";
    const targetButton = targetId ? (map.buttons || []).find((button) => button.id === targetId) : null;
    if (targetButton?.risk === "safe_continue" || exactNavigationText(targetButton?.label || "")) {
      return normalizeMatchText(targetButton.label || raw);
    }
    return "";
  }

  function isStageExitDecision(decision = {}, map = agent.pageMap || buildPageMap()) {
    if (!["click", "click_xy", "keypress"].includes(decision.action)) return false;
    if (declineChoiceIntent(decision) && !exactNavigationText(`${decision.targetLabel || ""} ${decision.value || ""}`)) return false;
    return Boolean(stageExitIntentLabel(decision, map));
  }

  function backendApprovedSafeDeclineDecision(decision = {}, map = agent.pageMap || buildPageMap()) {
    const snapshot = decision.targetSnapshot || {};
    const targetText = `${decision.targetLabel || ""} ${decision.value || ""}`.toLowerCase();
    const contextText = `${targetText} ${decision.reason || ""}`.toLowerCase();
    if (!shouldAutoDeclinePaidExtras()) return false;
    if (!["click", "select", "skip_optional_extra", "keypress", "close_modal"].includes(decision.action)) return false;
    if (decision.intent === "decline_optional_extra"
      || snapshot.semantic === "decline_paid_extra"
      || snapshot.semantic === "safe_decline"
      || snapshot.risk === "safe_decline") {
      return true;
    }
    if (isDangerousActionLabel(targetText) || /add to cart|upgrade|premium\+|premium\b|all passengers|\badult\b.*\b(29|44|122|eur|€|\$)/i.test(targetText)) return false;
    if (isSeatNoSelectionContinue(decision, map)) return true;
    return declineChoiceIntent({ ...decision, targetLabel: targetText, reason: contextText });
  }

  function backendApprovedOpenChoiceControl(decision = {}) {
    const snapshot = decision.targetSnapshot || {};
    const text = normalizeMatchText(`${decision.targetLabel || ""} ${decision.value || ""} ${snapshot.label || ""} ${snapshot.sectionLabel || ""} ${snapshot.sectionType || ""}`);
    return decision.intent === "open_choice_control"
      || (decision.action === "click"
        && /\b(choose|select option|select one option|open)\b/.test(text)
        && !["money", "payment"].includes(snapshot.risk || "")
        && snapshot.semantic !== "add_paid_extra");
  }

  function transactionInvariantViolation(decision = {}, map = buildPageMap(), options = {}) {
    const label = `${decision.targetLabel || ""} ${decision.value || ""}`.trim();
    const text = label.toLowerCase();
    if (["ask_user", "stop", "wait", "scroll"].includes(decision.action)) return null;
    if (isDangerousActionLabel(label) || decision.risk === "payment") {
      return { code: "PAYMENT_OR_FINAL_ACTION", message: "Payment/final booking actions are blocked in the current agent mode." };
    }
    if (decision.risk === "money" && !options.safeDeclineDecision && !options.openChoiceControl) {
      return { code: "UNAPPROVED_MONEY_ACTION", message: "Money-risk action is not an approved no-cost decline option." };
    }
    if (/add to cart|upgrade|premium\+|all passengers|\badult\b.*\b(29|44|122|eur|€|\$)/i.test(text) && !options.safeDeclineDecision && !options.openChoiceControl) {
      return { code: "PAID_EXTRA_TARGET", message: "Target appears to select a paid extra." };
    }
    if (isStageExitDecision(decision, map)) {
      const blockers = stageExitBlockers(map, decision);
      if (blockers.length) {
        return {
          code: blockers[0].code || "STAGE_EXIT_BLOCKED",
          message: blockers[0].message || "A required visible section is unresolved before navigation.",
          blockers
        };
      }
    }
    return null;
  }

  function activeSurfaceEntries(surfaceOrMap) {
    const surface = surfaceOrMap?.activeSurface || surfaceOrMap || {};
    return [...(surface.options || []), ...(surface.buttons || [])]
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
        box: null,
        accessibility: null,
        visualState: foregroundSurfaceState({ type: "page" })
      };
    }
    const role = implicitRole(overlay);
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
        box: elementBox(option),
        accessibility: accessibilityNode(option, map)
      };
    }).filter((option) => option.label);
    // Large surfaces (a seat map can have 80+ individual seat buttons) blow past the
    // slice(0, 20) cap in raw DOM order, which is exactly backwards: seats are near the
    // top of the DOM, but the dialog's own dismiss/confirm control (Next/Close/Continue/
    // Done) is in the footer, last in DOM order — so it silently never made it into the
    // list the model could choose from. It correctly registers the choice, then has no
    // way to leave the dialog and stalls. Put navigation controls first so truncation
    // trims individual seat/choice buttons before it ever touches these.
    const NAV_CONTROL_LABEL = /^(next|continue|close( window)?|done|confirm|submit)\b/i;
    const prioritized = [
      ...options.filter((option) => NAV_CONTROL_LABEL.test(option.label)),
      ...options.filter((option) => !NAV_CONTROL_LABEL.test(option.label))
    ];
    const surface = {
      type,
      id: elementId(overlay),
      label: text.slice(0, 800),
      role,
      taskHint: task?.sectionType || routineExtraOverlayKind(text, task) || "",
      options: prioritized.slice(0, 20),
      buttons: prioritized.slice(0, 20),
      box: elementBox(overlay),
      accessibility: accessibilityNode(overlay, map)
    };
    return {
      ...surface,
      visualState: foregroundSurfaceState(surface)
    };
  }

  function surfaceText(surface = {}) {
    return `${surface.label || ""} ${surface.text || ""} ${(surface.options || []).map((option) => option.label || "").join(" ")}`.replace(/\s+/g, " ").trim();
  }

  function surfaceLooksLikeSeatSkip(surface = {}) {
    const text = surfaceText(surface).toLowerCase();
    return /are you sure|haven.?t selected a seat|not selected.*seat|seat.*not selected|without.*seat|skip seat selection/.test(text)
      && /\b(continue|next|proceed)\b/.test(text)
      && !/choose seat only|select seat only/.test(text);
  }

  function surfaceOwnsTask(surface = {}, task = {}) {
    if (!surface || surface.type === "page" || !task) return false;
    const text = surfaceText(surface).toLowerCase();
    const type = String(task.sectionType || "").toLowerCase();
    const label = String(task.sectionLabel || "").toLowerCase();
    if (surface.taskHint && surface.taskHint === task.sectionType) return true;
    if (type === "seat" && /seat|seating/.test(text)) return true;
    if (type === "baggage" && /bag|baggage|luggage/.test(text)) return true;
    if (type === "bundle" && /bundle|support|sms|premium/.test(text)) return true;
    if (type === "flexible_ticket" && /flexible ticket|reschedule|change your ticket/.test(text)) return true;
    if (type === "cancellation_insurance" && /cancellation|insurance|refund|protection/.test(text)) return true;
    return Boolean(label && normalizeMatchText(text).includes(normalizeMatchText(label).slice(0, 48)));
  }

  function buildSurfaceStack(activeSurface, sections = [], taskQueue = [], overlays = [], step = "unknown") {
    const pageSurface = {
      id: "surface-page",
      type: "page",
      label: step,
      role: "document",
      blocksBackground: false,
      isCurrent: !activeSurface?.type || activeSurface.type === "page",
      taskQueue,
      backgroundTaskQueue: [],
      sectionIds: (sections || []).map((section) => section.id).filter(Boolean),
      options: [],
      buttons: [],
      box: null
    };
    if (!activeSurface?.type || activeSurface.type === "page") {
      return {
        surfaceStack: [pageSurface],
        currentSurface: pageSurface,
        backgroundTasks: [],
        currentSurfaceTasks: taskQueue
      };
    }
    const ownedTasks = taskQueue.filter((task) => surfaceOwnsTask(activeSurface, task));
    const surface = {
      ...activeSurface,
      text: activeSurface.label || "",
      blocksBackground: true,
      isCurrent: true,
      taskQueue: ownedTasks,
      backgroundTaskQueue: taskQueue.filter((task) => !ownedTasks.some((owned) => owned.id === task.id)),
      expectedResolution: surfaceLooksLikeSeatSkip(activeSurface) ? "waive_or_skip_seat_selection" : "resolve_active_surface",
      foreground: foregroundSurfaceState(activeSurface)
    };
    return {
      surfaceStack: [{ ...pageSurface, isCurrent: false, backgroundTaskQueue: [] }, surface],
      currentSurface: surface,
      backgroundTasks: surface.backgroundTaskQueue,
      currentSurfaceTasks: ownedTasks
    };
  }

  function buildPageMap() {
    const text = primaryPageText();
    const fullText = visiblePageText();
    const step = classifyStep(`${location.href} ${text} ${fullText.slice(0, 2500)}`);
    const fields = candidateInputs().map((input) => {
      const detected = detectField(input);
      const semantic = detected?.field || "unknown";
      return {
        element: input,
        id: elementId(input),
        label: labelText(input),
        box: elementBox(input),
        kind: input.type || input.tagName.toLowerCase(),
        role: implicitRole(input),
        field: semantic,
        semantic,
        required: input.required || /\*/.test(labelText(input)),
        value: fieldValue(input),
        confidence: detected?.confidence || 0,
        accessibility: accessibilityNode(input, null)
      };
    });
    const buttons = queryAllDeep("button, a, input[type='button'], input[type='submit'], [role='button'], [role='option'], [role='menuitem'], [role='checkbox'], [role='radio']")
      .filter((button) => isVisible(button) && !button.closest("#atw-sidebar") && !isPaymentField(button))
      .map((button) => {
        const label = (button.innerText || button.value || button.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
        const lower = label.toLowerCase();
        const box = elementBox(button);
        return {
          element: button,
          id: elementId(button),
          label,
          box,
          role: implicitRole(button),
          semantic: semanticChoiceType(label),
          risk: meaningfulActionBox(box) ? actionRisk(lower) : "choice",
          accessibility: accessibilityNode(button, null)
        };
      });
    const errors = collectVisibleErrors(text);
    const paidChoices = collectPaidChoices(fullText);
    const price = priceFromText(fullText);
    const overlays = visibleOverlays();
    const activeSurface = buildActiveSurface(activeOverlayElements());
    const sections = buildSectionModels(detectCheckoutSections(), fields, buttons);
    const controls = buildCanonicalControlGraph(sections, fields, buttons, activeSurface);
    const taskQueue = buildTaskQueue(sections);
    const surfaceModel = buildSurfaceStack(activeSurface, sections, taskQueue, overlays, step);
    const stageExit = buildStageExit(taskQueue, buttons, overlays, errors, step);
    const map = {
      site: inferCheckoutSite(),
      step,
      text,
      fullText,
      coverage: pageCoverage(),
      fields,
      buttons,
      overlays,
      activeSurface,
      surfaceStack: surfaceModel.surfaceStack,
      currentSurface: surfaceModel.currentSurface,
      currentSurfaceTasks: surfaceModel.currentSurfaceTasks,
      backgroundTasks: surfaceModel.backgroundTasks,
      errors,
      paidChoices,
      price,
      priceText: price ? `${price.amount} ${price.currency}` : "",
      controls,
      sections,
      taskQueue,
      stageExit,
      summary: {
        fields: fields.length,
        knownFields: fields.filter((field) => field.field !== "unknown").length,
        buttons: buttons.length,
        controls: controls.length,
        overlays: overlays.length,
        errors: errors.length,
        paidChoices: paidChoices.length,
        sections: sections.length,
        pendingTasks: taskQueue.filter((task) => task.status === "pending").length,
        lockedTasks: taskQueue.filter((task) => task.status === "locked").length,
        continueAllowed: stageExit.continueAllowed,
        priceText: price ? `${price.amount} ${price.currency}` : "",
        price
      }
    };
    map.accessibility = accessibilitySnapshot(map);
    map.foreground = foregroundSurfaceState(map.currentSurface || map.activeSurface || {});
    map.visualState = visualPageState(map);
    return map;
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

  async function verifyAndRememberSection(sectionType, label = sectionType, sectionId = "") {
    const updated = rememberPagePlan(buildPageMap());
    outlineCoreSections(updated.sections || []);
    const section = (updated.sections || []).find((item) => item.id === sectionId)
      || (updated.sections || []).find((item) => item.type === sectionType && item.label === label)
      || (updated.sections || []).find((item) => item.type === sectionType);
    const target = elementById(section?.id) || document.body;
    if (section?.status === "complete") {
      if (canUseCompletionMemoryForSectionType(sectionType)) markSectionDone(sectionType, label);
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

  function visibleProfileFillCandidates(map, targetIds = []) {
    const wanted = new Set((targetIds || []).filter(Boolean));
    const seenFields = new Set();
    return (map.fields || [])
      .filter((field) => {
        if (!field?.element || !isVisible(field.element) || isPaymentField(field.element)) return false;
        if (wanted.size && !wanted.has(field.id)) return false;
        if (!field.field || field.field === "unknown") return false;
        if (field.element.type === "radio" || field.element.type === "checkbox") return false;
        const value = travelerValue(field.field);
        if (!value) return false;
        if (field.value && valueMatches(field.element, value, field.field === "phone" ? "digits" : "text")) return false;
        const key = `${field.field}:${Math.round((field.box?.y || 0) / 12)}`;
        if (seenFields.has(key) && !wanted.size) return false;
        seenFields.add(key);
        return true;
      })
      .sort((a, b) => (a.box?.y || 0) - (b.box?.y || 0) || (a.box?.x || 0) - (b.box?.x || 0));
  }

  async function fillVisibleProfileFieldsFromMap(map, options = {}) {
    if (!guardedHelperAllowed("fillVisibleProfileFieldsFromMap", ["fill_known_fields", "fill_visible_profile_fields"])) return 0;
    filledFields = [];
    let count = 0;
    const targetIds = options.targetIds || [];
    const activeSurface = map.activeSurface;
    if (activeSurface?.type && activeSurface.type !== "page" && !visibleProfileFillCandidates(map, targetIds).length) {
      logAgentEvent("fill_visible_profile_fields_skipped", { reason: "active surface has no profile fields", surfaceType: activeSurface.type });
      return 0;
    }

    if (!targetIds.length && fillTitleRadio(document)) count += 1;

    const phoneCount = await fillPhoneFieldsFromMap(map);
    count += phoneCount;
    if (transientOverlayOpen()) return count;

    for (const field of visibleProfileFillCandidates(rememberPagePlan(buildPageMap()), targetIds)) {
      const value = travelerValue(field.field);
      const result = await setFieldValue(field.element, value, {
        fieldType: field.field,
        compareMode: field.field === "phone" ? "digits" : "text"
      });
      if (result.ok) {
        count += 1;
        filledFields.push({
          fieldType: field.field,
          selector: field.element.name || field.element.id || field.element.tagName.toLowerCase(),
          confidence: field.confidence
        });
      }
      const interrupt = await settleAndHandleInterrupts(`${field.field} field`);
      if (interrupt.blocked && !interrupt.handled) return count;
    }

    if (count) {
      recordAction("visible_profile_fields_filled", { count, targetIds });
      logAgentEvent("visible_profile_fields_filled", { count, targetIds });
    }
    return count;
  }

  async function fillKnownFieldsFromMap(map) {
    if (!guardedHelperAllowed("fillKnownFieldsFromMap", ["fill_known_fields", "fill_visible_profile_fields"])) return 0;
    filledFields = [];
    const directCount = await fillVisibleProfileFieldsFromMap(map);
    if (directCount) return directCount;
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
    if (!guardedHelperAllowed("autoResolveNoExtrasSection", ["skip_optional_extra"])) return false;
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
    const updatedSection = (updated.sections || []).find((item) => item.id === section.id)
      || (updated.sections || []).find((item) => item.type === section.type && item.label === section.label);
    const verified = updatedSection?.status === "complete";
    if (verified && canUseCompletionMemoryForSectionType(section.type)) markSectionDone(section.type, section.label);
    await verifyAgentStep(elementById(updatedSection?.id) || target, "Section", verified ? `${section.label} complete` : `${section.label} still needs another choice`, verified, 800);
    return verified;
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
    // Everything below (sections/status/stageExit especially) is a client-side
    // heuristic best guess, not verified truth — the backend's requirement
    // extractor + verifier independently re-derive what's actually required
    // from the screenshot and do not treat these as authoritative. Keep
    // sending them; they're useful context, just not a gate.
    return {
      site: map.site,
      url: location.href,
      step: map.step,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        scrollX: Math.round(window.scrollX),
        scrollY: Math.round(window.scrollY),
        devicePixelRatio: window.devicePixelRatio || 1
      },
      text: map.text,
      fullText: map.fullText,
      snapshotHash: observationHashForMap(map),
      price: map.price || null,
      priceText: map.priceText || map.summary?.priceText || "",
      foreground: map.foreground || foregroundSurfaceState(map.currentSurface || map.activeSurface || {}),
      visualState: map.visualState || visualPageState(map),
      accessibility: map.accessibility ? {
        foregroundSurfaceId: map.accessibility.foregroundSurfaceId,
        foregroundSurfaceType: map.accessibility.foregroundSurfaceType,
        landmarkCount: map.accessibility.landmarkCount,
        controls: (map.accessibility.controls || []).map((node) => ({
          id: node.id,
          role: node.role,
          controlId: node.controlId || "",
          name: node.name,
          state: node.state,
          kind: node.kind,
          sectionId: node.sectionId,
          sectionType: node.sectionType,
          sectionLabel: node.sectionLabel,
          surfaceId: node.surfaceId,
          surfaceType: node.surfaceType,
          box: node.box
        })).slice(0, 120)
      } : null,
      controls: (map.controls || []).map((control) => ({
        controlId: control.controlId,
        label: control.label,
        accessibleName: control.accessibleName,
        kind: control.kind,
        role: control.role,
        semantic: control.semantic,
        risk: control.risk,
        state: control.state,
        selected: Boolean(control.selected),
        required: Boolean(control.required),
        sectionId: control.sectionId,
        sectionType: control.sectionType,
        sectionLabel: control.sectionLabel,
        surfaceId: control.surfaceId,
        surfaceType: control.surfaceType,
        surfaceLabel: control.surfaceLabel,
        stateElementId: control.stateElementId,
        preferredActivationElementId: control.preferredActivationElementId,
        actuators: (control.actuators || []).map((item) => ({
          nodeId: item.nodeId,
          relation: item.relation,
          role: item.role,
          label: item.label,
          box: item.box
        })).slice(0, 8),
        visualRegion: control.visualRegion
      })).slice(0, 180),
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
          controlId: choice.controlId || "",
          label: choice.label,
          selected: Boolean(choice.selected),
          semantic: choice.semantic,
          risk: choice.risk,
          role: choice.role || "",
          accessibility: choice.accessibility || null,
          controlState: choice.controlState || null,
          stateElementId: choice.stateElementId || "",
          preferredActivationElementId: choice.preferredActivationElementId || "",
          actuators: (choice.actuators || []).slice(0, 8),
          visualRegion: choice.visualRegion || null,
          box: choice.box
        })),
        box: section.box,
        fields: (section.fields || []).map((field) => ({
          id: field.id,
          controlId: field.controlId || "",
          label: field.label,
          field: field.field,
          kind: field.kind,
          semantic: field.semantic,
          role: field.role || "",
          accessibility: field.accessibility || null,
          required: Boolean(field.required),
          hasValue: Boolean(field.hasValue),
          controlState: field.controlState || null,
          stateElementId: field.stateElementId || "",
          preferredActivationElementId: field.preferredActivationElementId || "",
          actuators: (field.actuators || []).slice(0, 8),
          visualRegion: field.visualRegion || null,
          box: field.box
        })).slice(0, 20),
        buttons: (section.buttons || []).map((button) => ({
          id: button.id,
          controlId: button.controlId || "",
          label: button.label,
          risk: button.risk,
          semantic: button.semantic,
          role: button.role || "",
          accessibility: button.accessibility || null,
          controlState: button.controlState || null,
          stateElementId: button.stateElementId || "",
          preferredActivationElementId: button.preferredActivationElementId || "",
          actuators: (button.actuators || []).slice(0, 8),
          visualRegion: button.visualRegion || null,
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
        controlId: field.controlId || "",
        label: field.label,
        box: field.box,
        kind: field.kind,
        field: field.field,
        semantic: field.semantic || field.field,
        role: field.role || "",
        accessibility: field.accessibility || null,
        required: field.required,
        value: field.value ? "[filled]" : "",
        controlState: field.controlState || null,
        stateElementId: field.stateElementId || "",
        preferredActivationElementId: field.preferredActivationElementId || "",
        actuators: (field.actuators || []).slice(0, 8),
        visualRegion: field.visualRegion || null,
        confidence: field.confidence
      })),
      buttons: map.buttons.map((button) => ({
        id: button.id,
        controlId: button.controlId || "",
        label: button.label,
        box: button.box,
        role: button.role || "",
        semantic: button.semantic || "",
        risk: button.risk,
        controlState: button.controlState || null,
        stateElementId: button.stateElementId || "",
        preferredActivationElementId: button.preferredActivationElementId || "",
        actuators: (button.actuators || []).slice(0, 8),
        visualRegion: button.visualRegion || null,
        accessibility: button.accessibility || null
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
      currentSurface: map.currentSurface || map.activeSurface || {
        type: "page",
        id: "",
        label: "",
        taskQueue: []
      },
      surfaceStack: map.surfaceStack || [],
      currentSurfaceTasks: map.currentSurfaceTasks || [],
      backgroundTasks: map.backgroundTasks || [],
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

  async function requestAgentDecision(map, userMessage = "", clientLatency = {}) {
    const turnId = nextFlowId("turn");
    const observationId = nextFlowId("obs");
    agent.activeTurnId = turnId;
    agent.activeObservationId = observationId;
    const observationSnapshot = mapObservationSnapshot(map);
    logAgentEvent("agent_request", {
      turnId,
      observationId,
      userMessage: userMessage ? "[provided]" : "",
      step: map.step,
      summary: map.summary,
      errors: map.errors,
      paidChoices: map.paidChoices
    });
	    logFlow("backend.request.prepare", {
	      turnId,
	      observationId,
	      userMessage: Boolean(userMessage),
	      observation: observationSnapshot,
	      page: pageSnapshot("before-backend"),
	      lastAction: agent.lastActionResult || agent.actionHistory[agent.actionHistory.length - 1] || null
    });
    try {
      const settings = await storageGet(["apiBase"]);
      const screenshotStartedAt = performance.now();
      const screenshotDataUrl = await captureVisibleScreenshot();
      const screenshotCaptureMs = Math.round(performance.now() - screenshotStartedAt);
      logFlow("backend.request.send", {
        turnId,
        api: `${settings.apiBase || DEFAULT_API}/agent/next-action`,
        screenshotBytes: screenshotDataUrl.length,
        observation_build_ms: clientLatency.observation_build_ms ?? null,
        screenshot_capture_ms: screenshotCaptureMs,
        activeSurface: map.activeSurface ? {
          type: map.activeSurface.type,
          taskHint: map.activeSurface.taskHint,
          options: (map.activeSurface.options || []).map((option) => ({
            id: option.id,
            label: compactText(option.label, 100),
            risk: option.risk,
            semantic: option.semantic,
            selected: Boolean(option.selected),
            box: option.box
          })).slice(0, 12)
        } : null
      });
      const requestStartedAt = performance.now();
      const response = await fetch(`${settings.apiBase || DEFAULT_API}/agent/next-action`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: agent.sessionId,
          clientTurnId: turnId,
          observationId,
          observationSnapshot,
          userIntent: userIntentText(),
          userMessage,
          traveler: traveler(),
	          approvalState: {
	            skipPaidExtrasApproved: shouldAutoDeclinePaidExtras(),
	            paymentApproved: false
	          },
	          actionHistory: agent.actionHistory.slice(-12),
          // Best-effort context for the backend verifier — it independently judges
          // whether the last action actually worked from the fresh screenshot/DOM
          // rather than trusting this, so it doesn't need to be a strict schema.
	          lastActionResult: agent.lastActionResult || agent.actionHistory[agent.actionHistory.length - 1] || null,
          page: {
            ...compactPageMap(map),
            screenshotDataUrl
          }
        })
      });
      if (!response.ok) throw new Error(`agent returned ${response.status}`);
      const decision = await response.json();
      const requestUploadMs = Math.round(performance.now() - requestStartedAt);
      agent.lastBackendDebug = decision.debug || null;
      const backendLatency = decision.debug?.latency || {};
      const modelUsage = decision.debug?.modelUsage || {};
      logAgentEvent("agent_decision", {
        turnId,
        actionId: decision.actionId || decision.id || "",
        observationId: decision.observationId || "",
        source: decision.source,
        action: decision.action,
        intent: decision.intent || "",
        requirementId: decision.requirementId || "",
        targetId: decision.targetId,
        targetLabel: decision.targetLabel,
        targetSnapshot: decision.targetSnapshot || null,
        expectedOutcome: decision.expectedOutcome || null,
        risk: decision.risk,
        needsApproval: decision.needsApproval,
        message: decision.message,
        reason: decision.reason,
        debug: decision.debug || null
      });
      logFlow("latency.spans", {
        turnId,
        observationId,
        observation_build_ms: clientLatency.observation_build_ms ?? null,
        screenshot_capture_ms: screenshotCaptureMs,
        request_upload_ms: requestUploadMs,
        classification_model_ms: backendLatency.classification_model_ms ?? null,
        verify_plan_model_ms: backendLatency.verify_plan_model_ms ?? null,
        policy_ms: backendLatency.policy_ms ?? null,
        input_tokens: modelUsage.input_tokens ?? null,
        output_tokens: modelUsage.output_tokens ?? null,
        model: modelUsage.model || "",
        action: decision.action || "",
        actionId: decision.actionId || decision.id || ""
      });
      logFlow("backend.response", {
        turnId,
        observation_build_ms: clientLatency.observation_build_ms ?? null,
        screenshot_capture_ms: screenshotCaptureMs,
        request_upload_ms: requestUploadMs,
        classification_model_ms: backendLatency.classification_model_ms ?? null,
        verify_plan_model_ms: backendLatency.verify_plan_model_ms ?? null,
        policy_ms: backendLatency.policy_ms ?? null,
        input_tokens: modelUsage.input_tokens ?? null,
        output_tokens: modelUsage.output_tokens ?? null,
        model: modelUsage.model || "",
        decision: {
          source: decision.source,
          actionId: decision.actionId || decision.id || "",
          observationId: decision.observationId || "",
          action: decision.action,
          intent: decision.intent || "",
          requirementId: decision.requirementId || "",
          targetId: decision.targetId,
          targetLabel: decision.targetLabel,
          targetSnapshot: decision.targetSnapshot || null,
          expectedOutcome: decision.expectedOutcome || null,
          value: decision.value,
          x: decision.x,
          y: decision.y,
          risk: decision.risk,
          needsApproval: decision.needsApproval,
          reason: decision.reason
        },
        backendDebug: decision.debug || null
      });
      return decision;
    } catch (error) {
      const contextInvalidated = /extension context invalidated|context invalidated|receiving end does not exist/i.test(error.message || "");
      const decision = {
        source: "system",
        action: "stop",
        targetId: "",
        value: "",
        message: contextInvalidated
          ? "Chrome invalidated the extension context after reload. Refresh this checkout tab, then start the agent again."
          : `AI agent unavailable: ${error.message}. I stopped because AI-only mode is enabled.`,
        needsApproval: true,
        risk: "uncertain",
        reason: contextInvalidated
          ? "Extension lifecycle error: this page is still running the old content script after extension reload."
          : "AI-only mode: backend/OpenAI must provide the next action."
      };
      logAgentEvent("agent_decision", {
        turnId,
        actionId: decision.actionId || decision.id || "",
        observationId: decision.observationId || observationId,
        source: decision.source,
        action: decision.action,
        intent: decision.intent || "",
        requirementId: decision.requirementId || "",
        targetId: decision.targetId,
        targetSnapshot: decision.targetSnapshot || null,
        expectedOutcome: decision.expectedOutcome || null,
        risk: decision.risk,
        needsApproval: decision.needsApproval,
        message: decision.message,
        reason: decision.reason
      });
      logFlow(contextInvalidated ? "extension.context_invalidated" : "backend.error", { turnId, error: error.message, decision });
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
    logFlow("loop.schedule_next", {
      delay,
      next_loop_delay_ms: delay,
      pageAfterAction: pageSnapshot("after-action-before-next-loop"),
      lastAction: agent.actionHistory[agent.actionHistory.length - 1] || null
    });
    clearExecutionContext();
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
    if (!guardedHelperAllowed("clickAndVerifyAdvance", ["click"])) return false;
    const beforeMap = options.beforeMap || rememberPagePlan(buildPageMap());
    const expectedOutcome = options.expectedOutcome || expectedOutcomeForDecision({ action: "click", targetLabel: label }, beforeMap, element);
    const blockers = stageExitBlockers(beforeMap, { action: "click", targetLabel: label });
    if (blockers.length) {
      pushVerificationLedger(
        options.actionId || agent.activeExecutionActionId || nextFlowId("act"),
        options.observationId || agent.activeExecutionObservationId || agent.activeObservationId || "",
        { action: "click", targetLabel: label },
        expectedOutcome,
        {
          ok: false,
          code: blockers[0].code || "STAGE_EXIT_BLOCKED",
          message: blockers[0].message || "Stage exit is blocked.",
          evidence: { blockers }
        }
      );
      addAgentMessage("assistant", `I did not click ${label}: ${blockers[0].message}`);
      await continueAfterAction(250);
      return false;
    }
    addAgentMessage("assistant", `Clicking: ${label}.`);
    await showAgentThought(element, "Exit", `Act: click ${label}`, "Checking whether the page advances.");
    flashElement(element);
    element.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
    await sleep(250);
    userLikeClick(element);
    await waitForUiSettle(700);
    await sleep(delay);
    let afterMap = rememberPagePlan(buildPageMap());
    const verification = verifyExpectedOutcome(expectedOutcome, beforeMap, afterMap, element);
    let advanced = verification.ok;
    agent.pageMap = afterMap;
    setAgentActivity(advanced ? `Advanced to ${afterMap.step.replace(/_/g, " ")}` : `${label} did not advance`, advanced ? "Reading the next page state" : "Looking for the remaining blocker");
    pushVerificationLedger(
      options.actionId || agent.activeExecutionActionId || nextFlowId("act"),
      options.observationId || agent.activeExecutionObservationId || agent.activeObservationId || "",
      { action: "click", targetLabel: label },
      expectedOutcome,
      verification
    );
    logAgentEvent("verify_advance", {
      label,
      advanced,
      step: afterMap.step,
      errors: afterMap.errors,
      url: location.href,
      verification
    });
    reportActionResult({
      type: "navigation",
      action: "click_continue",
      target: label,
      ok: advanced && !afterMap.errors.length,
      message: advanced ? `Clicked ${label} and reached ${afterMap.step.replace(/_/g, " ")}.` : verification.message || `Clicked ${label}, but the page did not advance.`,
      errors: afterMap.errors,
      verification
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
    const actionId = decision.actionId || decision.id || nextFlowId("act");
    const executionId = nextFlowId("exec");
    const observation = mapObservationSnapshot(map);
    const actionObservationId = decision.observationId || observation.observationId || agent.activeObservationId || "";
    const actionObservationHash = decision.observationHash || observation.snapshotHash || "";
    agent.activeExecutionActionId = actionId;
    agent.activeExecutionObservationId = actionObservationId;
    agent.activeExecutionDecisionAction = decision.action || "";
    logFlow("execute.start", {
      executionId,
      actionId,
      observationId: actionObservationId,
      decision: {
        source: decision.source,
        observationId: decision.observationId || "",
        observationHash: decision.observationHash || "",
        action: decision.action,
        intent: decision.intent || "",
        requirementId: decision.requirementId || "",
        targetId: decision.targetId,
        targetLabel: decision.targetLabel,
        targetSnapshot: decision.targetSnapshot || null,
        expectedOutcome: decision.expectedOutcome || null,
        value: decision.value,
        x: decision.x,
        y: decision.y,
        risk: decision.risk,
        needsApproval: decision.needsApproval,
        reason: decision.reason
      },
      backendDebug: decision.debug || agent.lastBackendDebug || null,
      observation,
      pageBefore: pageSnapshot("before-execute")
    });
    pushActionLedger({
      actionId,
      observationId: actionObservationId,
      stage: "planned",
      action: decision,
      observation,
      observationHash: actionObservationHash
    });
    logAgentEvent("execute", {
      executionId,
      actionId,
      action: decision.action,
      targetId: decision.targetId,
      risk: decision.risk,
      source: decision.source
    });
    const currentObservation = mapObservationSnapshot(rememberPagePlan(buildPageMap()));
    if ((decision.observationHash && decision.observationHash !== currentObservation.snapshotHash) || observationChangedSince(map)) {
      pushActionLedger({
        actionId,
        observationId: actionObservationId,
        stage: "rejected",
        action: decision,
        observationHash: actionObservationHash,
        result: {
          ok: false,
          code: "OBSERVATION_HASH_MISMATCH",
          reason: "Observation changed before execution",
          expectedHash: decision.observationHash || "",
          currentHash: currentObservation.snapshotHash || ""
        }
      });
      logFlow("execute.stale_observation", {
        actionId,
        observationId: actionObservationId,
        expectedHash: decision.observationHash || "",
        currentHash: currentObservation.snapshotHash || "",
        before: observation,
        current: currentObservation
      });
      await continueAfterAction(150);
      return;
    }
    const message = decision.message || "I have a next action.";
    if (!agent.messages.at(-1) || agent.messages.at(-1).text !== message) {
      addAgentMessage("assistant", message);
    }
    if (decision.reason) {
      setAgentActivity(message, decision.reason);
    }

    const seatNoSelectionContinue = isSeatNoSelectionContinue(decision, map);
    const safeDeclineDecision = backendApprovedSafeDeclineDecision(decision, map);
    const openChoiceControl = backendApprovedOpenChoiceControl(decision);
    if (!["ask_user", "stop", "wait", "scroll"].includes(decision.action)
      && decision.risk === "money"
      && shouldAutoDeclinePaidExtras()
      && !safeDeclineDecision
      && !openChoiceControl) {
      agent.skipPaidExtrasApproved = true;
      if (AGENT_SINGLE_BRAIN) {
        pushActionLedger({
          actionId,
          observationId: actionObservationId,
          stage: "blocked",
          action: decision,
          result: { ok: false, code: "UNAPPROVED_MONEY_ACTION", message: "Money-risk action was not a verified no-cost/no-thanks decline option." }
        });
        logFlow("invariant.blocked_action", {
          actionId,
          observationId: actionObservationId,
          violation: { code: "UNAPPROVED_MONEY_ACTION" },
          target: decision.targetLabel || decision.value || ""
        });
        agent.awaiting = "extras";
        agent.running = false;
        addAgentMessage("assistant", "I stopped before a money-risk action because it was not clearly a no-cost/no-thanks decline option.");
        renderSidebar("agent");
        return;
      }
      const handled = await autoResolveNoExtrasSection(map);
      if (handled) {
        await continueAfterAction(350);
        return;
      }
      agent.pendingUserMessage = "Use the saved traveler rule: decline paid extras and continue without asking unless payment/final booking appears.";
      await continueAfterAction(350);
      return;
    }

    if (safeDeclineDecision) {
      decision = {
        ...decision,
        risk: "safe",
        needsApproval: false,
        reason: decision.reason || "Backend chose a no-cost/no-thanks decline option under saved no-extras rules."
      };
      logFlow("policy.safe_decline_allowed", {
        actionId,
        observationId: actionObservationId,
        target: decision.targetLabel || decision.value || "",
        reason: decision.reason,
        seatNoSelectionContinue
      });
    }

    const invariantViolation = transactionInvariantViolation(decision, map, { safeDeclineDecision, openChoiceControl });
    if (invariantViolation) {
      pushActionLedger({
        actionId,
        observationId: actionObservationId,
        stage: "blocked",
        action: decision,
        result: { ok: false, ...invariantViolation }
      });
      logFlow("invariant.blocked_action", {
        actionId,
        observationId: actionObservationId,
        violation: invariantViolation,
        target: decision.targetLabel || decision.value || ""
      });
      agent.awaiting = invariantViolation.code === "PAYMENT_OR_FINAL_ACTION" ? "final" : "manual";
      agent.running = false;
      addAgentMessage("assistant", invariantViolation.message);
      renderSidebar(invariantViolation.code === "PAYMENT_OR_FINAL_ACTION" ? "review" : "agent");
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

    if (decision.action === "scroll") {
      const amount = Number.isFinite(Number(decision.scrollY)) && Number(decision.scrollY) !== 0 ? Number(decision.scrollY) : 520;
      window.scrollBy({ top: amount, left: 0, behavior: "smooth" });
      recordAction("scroll", { amount });
      await waitForUiSettle(600);
      await continueAfterAction(350);
      return;
    }

    if (decision.action === "keypress") {
      const key = /escape/i.test(decision.keys || decision.value || "") ? "Escape" : /enter/i.test(decision.keys || decision.value || "") ? "Enter" : "";
      if (!key) {
        agent.awaiting = "manual";
        agent.running = false;
        addAgentMessage("assistant", "The AI requested an unsupported keypress, so I stopped.");
        renderSidebar("agent");
        return;
      }
      dispatchKey(document.activeElement || document.body, key);
      recordAction("keypress", { key });
      await waitForUiSettle(500);
      await continueAfterAction(350);
      return;
    }

    if (decision.action === "close_modal") {
      const closed = await closeActiveSurface(map);
      if (!closed) {
        agent.awaiting = "manual";
        agent.running = false;
        addAgentMessage("assistant", "I could not safely close the active popup, so I stopped.");
        renderSidebar("agent");
        return;
      }
      await continueAfterAction(450);
      return;
    }

    if (decision.action === "skip_optional_extra") {
      const skipped = await skipNoExtraDropdownChoice(map, decision) || await skipOptionalExtraSurface(map);
      if (!skipped) {
        agent.awaiting = "manual";
        agent.running = false;
        addAgentMessage("assistant", "I could not find a safe way to skip the optional extra on the active screen.");
        renderSidebar("agent");
        return;
      }
      await continueAfterAction(500);
      return;
    }

    if (decision.action === "fill_known_fields" || decision.action === "fill_visible_profile_fields") {
      const count = await fillVisibleProfileFieldsFromMap(map, { targetIds: [decision.targetId].filter(Boolean) });
      if (count) addAgentMessage("assistant", `Filled ${count} visible field${count === 1 ? "" : "s"} from the live page map.`);
      if (!count && decision.action === "fill_known_fields") {
        const fallbackCount = await fillKnownFieldsFromMap(map);
        if (fallbackCount) addAgentMessage("assistant", `Filled ${fallbackCount} field${fallbackCount === 1 ? "" : "s"} from the current checkout section.`);
      }
      await continueAfterAction(500);
      return;
    }

    if (decision.action === "click_xy") {
      const targetResolutionStartedAt = performance.now();
      const labelTarget = bestClickableForLabels([decision.targetLabel, decision.value].filter(Boolean), document);
      logFlow("latency.span", {
        target_resolution_ms: Math.round(performance.now() - targetResolutionStartedAt),
        actionId,
        action: decision.action,
        method: labelTarget ? "label_to_dom" : "coordinate"
      });
      if (labelTarget) {
        const validation = validateResolvedTarget(decision, labelTarget, map);
        if (!validation.ok) {
          pushActionLedger({
            actionId,
            observationId: actionObservationId,
            stage: "rejected",
            action: decision,
            targetFingerprint: targetFingerprint(labelTarget, decision),
            result: { ok: false, code: validation.code, expected: validation.expected, live: validation.live }
          });
          logFlow("target.validation_failed", {
            actionId,
            observationId: actionObservationId,
            code: validation.code,
            expected: validation.expected,
            live: validation.live
          });
          await continueAfterAction(150);
          return;
        }
        await showAgentThought(labelTarget, "Act", `Click visible control`, decision.targetLabel ? `Target: ${decision.targetLabel}` : "Resolved coordinate action to a visible control.", 650);
        pushActionLedger({
          actionId,
          observationId: actionObservationId,
          stage: "target_resolved",
          action: decision,
          targetFingerprint: targetFingerprint(labelTarget, decision),
          expectedOutcome: expectedOutcomeForDecision(decision, map, labelTarget),
          resolution: "click_xy_label_to_dom"
        });
        showAgentCursor(labelTarget, decision.targetLabel || decision.value || "click");
        flashElement(labelTarget);
        userLikeClick(labelTarget);
        recordAction("click_xy_resolved_to_dom", { label: decision.targetLabel || decision.value || buttonText(labelTarget) || labelText(labelTarget) });
        await waitForUiSettle(700);
        {
          const afterMap = rememberPagePlan(buildPageMap());
          const expectedOutcome = expectedOutcomeForDecision(decision, map, labelTarget);
          const verification = verifyExpectedOutcome(expectedOutcome, map, afterMap, labelTarget);
          pushVerificationLedger(actionId, actionObservationId, decision, expectedOutcome, verification);
        }
        await continueAfterAction(500);
        return;
      }
      const x = Number(decision.x);
      const y = Number(decision.y);
      if (decision.x == null || decision.y == null || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) {
        agent.awaiting = "manual";
        agent.running = false;
        addAgentMessage("assistant", "The AI gave an invalid click coordinate, so I stopped and rescanned.");
        renderSidebar("agent");
        return;
      }
      const hit = document.elementFromPoint(x, y);
      const target = clickableAncestor(hit) || hit;
      if (!target || target.closest?.("#atw-sidebar") || isPaymentField(target)) {
        agent.awaiting = "manual";
        agent.running = false;
        addAgentMessage("assistant", "The coordinate target is unavailable or sensitive, so I stopped.");
        renderSidebar("agent");
        return;
      }
      const coordinateValidation = validateResolvedTarget(decision, target, map);
      if (!coordinateValidation.ok) {
        pushActionLedger({
          actionId,
          observationId: actionObservationId,
          stage: "rejected",
          action: decision,
          targetFingerprint: targetFingerprint(target, decision),
          result: { ok: false, code: coordinateValidation.code, expected: coordinateValidation.expected, live: coordinateValidation.live }
        });
        logFlow("target.validation_failed", {
          actionId,
          observationId: actionObservationId,
          code: coordinateValidation.code,
          expected: coordinateValidation.expected,
          live: coordinateValidation.live
        });
        await continueAfterAction(150);
        return;
      }
      const targetLabel = decision.targetLabel || decision.value || buttonText(target) || labelText(target);
      if (isDangerousActionLabel(targetLabel)) {
        agent.awaiting = "final";
        agent.running = false;
        addAgentMessage("assistant", "I will not click payment or final booking coordinates automatically.");
        renderSidebar("review");
        return;
      }
      await showAgentThought(target, "Act", `Click visible point`, targetLabel ? `Target: ${targetLabel}` : "Coordinate fallback on the active visual surface.", 700);
      pushActionLedger({
        actionId,
        observationId: actionObservationId,
        stage: "target_resolved",
        action: decision,
        targetFingerprint: targetFingerprint(target, decision),
        expectedOutcome: expectedOutcomeForDecision(decision, map, target)
      });
      showAgentCursor(target, targetLabel || "click point");
      flashElement(target);
      clickViewportPoint(Math.round(x), Math.round(y));
      recordAction("click_xy", { x: Math.round(x), y: Math.round(y), label: targetLabel });
      await waitForUiSettle(700);
      {
        const afterMap = rememberPagePlan(buildPageMap());
        const expectedOutcome = expectedOutcomeForDecision(decision, map, target);
        const verification = verifyExpectedOutcome(expectedOutcome, map, afterMap, target);
        pushVerificationLedger(actionId, actionObservationId, decision, expectedOutcome, verification);
      }
      await continueAfterAction(500);
      return;
    }

    if (decision.action === "click") {
      const targetResolutionStartedAt = performance.now();
      const target = resolveDecisionTarget(decision, map);
      logFlow("latency.span", {
        target_resolution_ms: Math.round(performance.now() - targetResolutionStartedAt),
        actionId,
        action: decision.action,
        method: target ? "resolved" : "not_found",
        target: decision.controlId || decision.targetId || decision.targetLabel || decision.value || ""
      });
      if (!target) {
        agent.awaiting = "manual";
        agent.running = false;
        addAgentMessage("assistant", "The AI chose an element that is no longer visible, and I could not match its visible label on the active screen. I rescanned and stopped so you can guide me.");
        renderSidebar("agent");
        return;
      }
      const validation = validateResolvedTarget(decision, target, map);
      if (!validation.ok) {
        pushActionLedger({
          actionId,
          observationId: actionObservationId,
          stage: "rejected",
          action: decision,
          targetFingerprint: targetFingerprint(target, decision),
          result: { ok: false, code: validation.code, expected: validation.expected, live: validation.live }
        });
        logFlow("target.validation_failed", {
          actionId,
          observationId: actionObservationId,
          code: validation.code,
          expected: validation.expected,
          live: validation.live,
          decision: {
            targetId: decision.targetId,
            targetLabel: decision.targetLabel,
            value: decision.value
          }
        });
        await showAgentThought(
          target,
          "Verify",
          "Rejecting stale target",
          `The planned target no longer matches the live control (${validation.code}). Re-observing instead of clicking.`,
          650
        );
        await continueAfterAction(150);
        return;
      }
      pushActionLedger({
        actionId,
        observationId: actionObservationId,
        stage: "target_resolved",
        action: decision,
        targetFingerprint: targetFingerprint(target, decision),
        expectedOutcome: expectedOutcomeForDecision(decision, map, target)
      });
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
          await verifyAndRememberSection(section.type, section.label, section.id);
          await continueAfterAction(350);
          return;
        }
      }
      if (!seatNoSelectionContinue && !repeatGuardFor(target, "I tried the same action once and the page did not advance. I stopped so I do not loop.")) return;
      if (seatNoSelectionContinue) {
        logFlow("policy.seat_no_selection_continue_allowed", {
          actionId,
          observationId: actionObservationId,
          target: elementDescriptor(target),
          activeSurface: map.activeSurface
        });
      }
      if (button?.risk === "safe_continue") {
        await clickAndVerifyAdvance(target, button.label || "Continue", 1200, {
          actionId,
          observationId: actionObservationId,
          beforeMap: map,
          expectedOutcome: expectedOutcomeForDecision(decision, map, target)
        });
        return;
      }
      const actedSection = liveSectionForElement(map, target);
      const surfaceWasActive = Boolean(map.activeSurface?.type && map.activeSurface.type !== "page");
      const beforeOverlay = surfaceWasActive ? activeOverlayElements()[0] : null;
      const beforeOverlaySignature = beforeOverlay ? overlaySignature(beforeOverlay) : "";
      const expectedOutcome = expectedOutcomeForDecision(decision, map, target);
      showAgentCursor(target, button?.label || "clicking");
      flashElement(target);
      userLikeClick(target);
      if (surfaceWasActive) {
        const progress = await waitForOverlayProgress(beforeOverlay, beforeOverlaySignature, 2200);
        const afterMap = rememberPagePlan(buildPageMap());
        const verification = verifyExpectedOutcome(expectedOutcome, map, afterMap, target);
        pushVerificationLedger(actionId, actionObservationId, decision, expectedOutcome, {
          ...verification,
          ok: progress.ok || verification.ok,
          code: progress.ok ? "ACTIVE_SURFACE_PROGRESS" : verification.code,
          message: progress.ok ? `Active surface ${progress.reason}.` : verification.message
        });
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
      const afterMap = rememberPagePlan(buildPageMap());
      const verification = verifyExpectedOutcome(expectedOutcome, map, afterMap, target);
      pushVerificationLedger(actionId, actionObservationId, decision, expectedOutcome, verification);
      if (actedSection?.type && actedSection.type !== "unknown") {
        await verifyAndRememberSection(actedSection.type, actedSection.label, actedSection.id);
      }
      await continueAfterAction(900);
      return;
    }

    if (decision.action === "type" || decision.action === "select") {
      const targetResolutionStartedAt = performance.now();
      const target = resolveDecisionTarget(decision, map);
      logFlow("latency.span", {
        target_resolution_ms: Math.round(performance.now() - targetResolutionStartedAt),
        actionId,
        action: decision.action,
        method: target ? "resolved" : "not_found",
        target: decision.controlId || decision.targetId || decision.targetLabel || decision.value || ""
      });
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
        if (section?.type) await verifyAndRememberSection(section.type, section.label, section.id);
        {
          const afterMap = rememberPagePlan(buildPageMap());
          const expectedOutcome = expectedOutcomeForDecision(decision, map, target);
          const verification = verifyExpectedOutcome(expectedOutcome, map, afterMap, target);
          pushVerificationLedger(actionId, actionObservationId, decision, expectedOutcome, verification);
        }
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
      {
        const afterMap = rememberPagePlan(buildPageMap());
        const expectedOutcome = expectedOutcomeForDecision(decision, map, target);
        const verification = verifyExpectedOutcome(expectedOutcome, map, afterMap, target);
        pushVerificationLedger(actionId, actionObservationId, decision, expectedOutcome, verification);
      }
      await continueAfterAction(500);
      return;
    }

    agent.awaiting = "manual";
    agent.running = false;
    renderSidebar("agent");
  }

  // ---- Observer Mode: page-understanding projection (read-only, no actions) ----

  function maskFieldPreview(fieldType, value) {
    const text = String(value || "");
    if (!text) return "";
    if (["passport_number", "phone", "phone_country_code"].includes(fieldType)) {
      return text.length > 4 ? `${text.slice(0, Math.max(2, text.length - 4))}${"*".repeat(4)}` : "****";
    }
    if (fieldType === "email" || fieldType === "confirm_email") {
      const [user, domain] = text.split("@");
      if (!domain) return "***";
      return `${user.slice(0, 2)}${"*".repeat(Math.max(2, user.length - 2))}@${domain}`;
    }
    return text.length > 60 ? `${text.slice(0, 60)}…` : text;
  }

  function sectionEvidence(section) {
    const evidence = [];
    const filledFields = (section.fields || []).filter((field) => field.hasValue);
    const emptyRequired = (section.fields || []).filter((field) => field.required && !field.hasValue);
    if (filledFields.length) {
      evidence.push(`${filledFields.length} field(s) filled: ${filledFields.map((field) => (field.field !== "unknown" ? field.field : field.label.slice(0, 24))).join(", ")}`);
    }
    if (emptyRequired.length) {
      evidence.push(`${emptyRequired.length} required field(s) empty: ${emptyRequired.map((field) => (field.field !== "unknown" ? field.field : field.label.slice(0, 24))).join(", ")}`);
    }
    if (section.selected && section.selected.length) evidence.push(`Selected: ${section.selected.join(", ")}`);
    if (!evidence.length) evidence.push(`Status inferred as ${section.status}.`);
    return evidence;
  }

  function fieldEvidence(field) {
    const evidence = [`Label/placeholder: "${(field.label || "").slice(0, 60)}"`];
    evidence.push(field.hasValue ? "Field currently has a value" : "Field appears empty");
    if (field.required) evidence.push("Marked required");
    return evidence;
  }

  function priceFromText(text = "") {
    const normalized = String(text || "").replace(/\s+/g, " ");
    const totalMatch = normalized.match(/(?:amount to pay|total amount|total price|grand total|subtotal)[^0-9€$£]{0,80}(?:(EUR|USD|GBP|[€$£])\s?(\d+(?:[.,]\d{1,2})?)|(\d+(?:[.,]\d{1,2})?)\s?(EUR|USD|GBP|[€$£]))/i);
    const match = totalMatch
      || normalized.match(/(EUR|USD|GBP|[€$£])\s?(\d+(?:[.,]\d{1,2})?)/i)
      || text.match(/(\d+(?:[.,]\d{1,2})?)\s?(EUR|USD|GBP|[€$£])/i);
    if (!match) return null;
    const currencyMap = { "€": "EUR", "$": "USD", "£": "GBP" };
    const currencyToken = /[a-z€$£]/i.test(match[1] || "") ? match[1] : (match[4] || match[2]);
    const amountToken = currencyToken === match[1] ? match[2] : (match[3] || match[1]);
    const currency = currencyMap[currencyToken] || currencyToken.toUpperCase();
    const amount = Number(amountToken.replace(",", "."));
    return Number.isFinite(amount) ? { amount, currency } : null;
  }

  function includedBaggageOptions(section) {
    if (section.type !== "baggage") return [];
    const text = section.text || "";
    const items = [];
    if (/personal item[^.]{0,80}?included/i.test(text)) {
      items.push({
        id: `${section.id}-personal-item`,
        category: "baggage",
        label: "Personal item",
        status: "included",
        description: "Small bag included for all passengers.",
        confidence: 0.85,
        evidence: ["Section text mentions personal item as included"]
      });
    }
    if (/hand baggage[^.]{0,80}?included/i.test(text)) {
      items.push({
        id: `${section.id}-hand-baggage`,
        category: "baggage",
        label: "Hand baggage",
        status: "included",
        description: "Cabin bag included for all passengers.",
        confidence: 0.85,
        evidence: ["Section text mentions hand baggage as included"]
      });
    }
    return items;
  }

  function categoryForSectionType(type) {
    if (type === "baggage") return "baggage";
    if (type === "seat") return "seat";
    if (type === "cancellation_insurance") return "insurance";
    if (type === "payment") return "payment";
    return "unknown";
  }

  function extractPageOptions(sections = []) {
    const options = [];
    for (const section of sections) {
      options.push(...includedBaggageOptions(section));
      const category = categoryForSectionType(section.type);
      for (const choice of section.choices || []) {
        let status = "unknown";
        if (choice.selected) status = "selected";
        else if (choice.semantic === "add_paid_extra") status = "paid_extra";
        else if (choice.semantic === "decline_paid_extra" || choice.semantic === "decline_baggage") status = "not_selected";
        const price = priceFromText(choice.label);
        options.push({
          id: choice.id,
          category,
          label: (choice.label || "").slice(0, 80),
          status,
          price: price || undefined,
          confidence: status === "unknown" ? 0.5 : 0.8,
          evidence: [`Detected as a ${section.label} choice`, `Selected: ${choice.selected}`]
        });
      }
    }
    return options;
  }

  function actionTypeForSectionType(type) {
    if (type === "contact" || type === "passenger") return "fill_field";
    if (["baggage", "bundle", "flexible_ticket", "cancellation_insurance", "seat"].includes(type)) return "select_option";
    if (type === "continue") return "click_continue";
    return "ask_user";
  }

  function riskLevelForTask(task) {
    return task.rule && /no paid extras/i.test(task.rule) ? "safe" : "medium";
  }

  function buildProposedNextActions(taskQueue = []) {
    return taskQueue.slice(0, 8).map((task, index) => ({
      id: `action-${task.sectionId || index}`,
      actionType: actionTypeForSectionType(task.sectionType),
      label: task.objective || `Resolve ${task.sectionLabel}`,
      targetElementId: task.sectionId,
      riskLevel: riskLevelForTask(task),
      executableInObserverMode: false,
      reason: task.rule || "Pending section needs attention before continuing.",
      confidence: 0.75
    }));
  }

  function buildReasoningSummary(map, stepInfo, sections) {
    const incomplete = sections.filter((section) => section.status === "incomplete");
    const complete = sections.filter((section) => section.status === "complete");
    const blockerText = incomplete.length
      ? `${incomplete.length} incomplete: ${incomplete.map((section) => section.label).join(", ")}`
      : "no incomplete sections";
    const shortSummary = `This is a ${map.site} ${stepInfo.step.replace(/_/g, " ")} page. ${complete.length} section${complete.length === 1 ? "" : "s"} complete, ${blockerText}.`;
    const keyEvidence = sections.slice(0, 6).flatMap((section) => (section.evidence || []).slice(0, 1).map((item) => `${section.label}: ${item}`));
    const uncertainty = [
      ...map.fields.filter((field) => field.field !== "unknown" && field.confidence < 0.7).map((field) => `Low confidence field match: "${(field.label || "").slice(0, 40)}" (${Math.round(field.confidence * 100)}%)`),
      ...sections.filter((section) => section.status === "unknown").map((section) => `Section "${section.label}" status could not be determined.`)
    ].slice(0, 6);
    return { shortSummary, keyEvidence, uncertainty };
  }

  function buildPageUnderstanding(map) {
    const stepInfo = classifyStepDetailed(`${location.href} ${map.text} ${map.fullText.slice(0, 2500)}`);
    const sections = (map.sections || []).map((section) => ({
      id: section.id,
      label: section.label,
      type: section.type,
      status: section.status,
      confidence: section.type === "unknown" ? 0.5 : 0.85,
      evidence: sectionEvidence(section),
      box: section.box
    }));
    const fields = map.fields.map((field) => ({
      id: field.id,
      label: field.label,
      semanticType: field.field,
      required: field.required,
      visible: true,
      filled: Boolean(field.value),
      valuePreview: field.value ? maskFieldPreview(field.field, field.value) : undefined,
      confidence: field.confidence,
      evidence: fieldEvidence(field),
      box: field.box
    }));
    const options = extractPageOptions(map.sections || []);
    const warnings = runRiskChecks();
    const proposedNextActions = buildProposedNextActions(map.taskQueue || []);
    const reasoningSummary = buildReasoningSummary(map, stepInfo, sections);
    const blockers = sections
      .filter((section) => section.status === "incomplete")
      .map((section) => ({
        type: "incomplete_section",
        message: `${section.label} is incomplete.`,
        severity: section.type === "passenger" || section.type === "contact" ? "high" : "medium"
      }));

    return {
      pageIdentity: {
        host: location.host,
        url: location.href,
        siteName: map.site,
        pageType: stepInfo.step,
        confidence: stepInfo.confidence
      },
      checkoutState: {
        overallStatus: stepInfo.step === "unknown" ? "not_checkout" : (map.summary.continueAllowed ? "ready_to_continue" : (blockers.length ? "blocked" : "in_progress")),
        currentStep: stepInfo.step,
        completedSteps: sections.filter((section) => section.status === "complete").map((section) => section.label),
        incompleteSteps: sections.filter((section) => section.status === "incomplete").map((section) => section.label),
        blockers
      },
      sections,
      fields,
      options,
      warnings,
      proposedNextActions,
      reasoningSummary,
      debug: {
        scanId: `scan_${Date.now().toString(36)}`,
        scannedAt: new Date().toISOString(),
        engineVersion: "observer-v1",
        latencyMs: 0
      }
    };
  }

  // TEMP: perception-only debugging mode. Builds the page map and shows the section/field
  // breakdown in the sidebar + on-page outlines, but never calls the backend and never
  // fills/clicks anything. Safe to run repeatedly on any site while we tune section detection.
  async function observePageOnly() {
    agent.running = false;
    agent.awaiting = "";
    agent.messages = [];
    agent.reasoningLog = [];
    agent.actionHistory = [];
    agent.observerTab = agent.observerTab || "summary";
    setAgentActivity("Observing page (no actions will be taken)", travelerRules() || "Using saved traveler profile");
    agent.pageMap = rememberPagePlan(buildPageMap());
    const map = agent.pageMap;
    const started = Date.now();
    agent.pageUnderstanding = buildPageUnderstanding(map);
    agent.pageUnderstanding.debug.latencyMs = Date.now() - started;
    outlineCoreSections(map.sections || []);
    renderSidebar("observer");
    logAgentEvent("observe_only", {
      pageType: agent.pageUnderstanding.pageIdentity.pageType,
      pageConfidence: agent.pageUnderstanding.pageIdentity.confidence,
      sections: agent.pageUnderstanding.sections.map((s) => ({ label: s.label, type: s.type, status: s.status })),
      options: agent.pageUnderstanding.options.length,
      warnings: agent.pageUnderstanding.warnings.length
    });
  }

  function setObserverTab(tab) {
    agent.observerTab = tab;
    renderSidebar("observer");
  }

  async function takeOverCheckout() {
    agent.running = true;
    agent.sessionId = "";
    agent.awaiting = "";
    agent.messages = [];
    agent.reasoningLog = [];
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
    await saveResumeMarker();
    addAgentMessage("assistant", `${describePageMap(agent.pageMap)} I will work step by step and ask when money, payment, or uncertainty appears.`);
    renderSidebar("agent");
    await announceSectionQueue();
    await sleep(650);
    processCheckoutAgent();
  }

  async function resumeCheckoutAfterNavigation(marker) {
    agent.running = true;
    agent.sessionId = marker.sessionId || "";
    agent.awaiting = "";
    agent.messages = [];
    agent.reasoningLog = [];
    agent.lastClickSignature = "";
    agent.repeatClickCount = 0;
    agent.skipPaidExtrasApproved = Boolean(marker.skipPaidExtrasApproved);
    agent.autopilotMode = true;
    agent.actionHistory = [];
    resetSectionProgress();
    setAgentActivity("Continuing checkout agent after page change", travelerRules() || "Using saved traveler profile");
    agent.pageMap = rememberPagePlan(buildPageMap());
    if (!agent.sessionId) await startAgentSession();
    await saveResumeMarker();
    addAgentMessage("assistant", "Picking back up where I left off after the page changed.");
    renderSidebar("agent");
    await announceSectionQueue();
    await sleep(650);
    processCheckoutAgent();
  }

  async function processCheckoutAgent() {
    if (!agent.running) return;
    warnings = runRiskChecks();
    let observationBuildMs = 0;
    let observationStartedAt = performance.now();
    agent.pageMap = rememberPagePlan(buildPageMap());
    observationBuildMs += performance.now() - observationStartedAt;
    await showAgentThought(
      document.activeElement || document.body,
      "Observe",
      "Backend planner",
      "Reading the current page and sending it to the backend before taking any checkout action.",
      450
    );
    await waitForPaint(450);
    observationStartedAt = performance.now();
    const stableMap = rememberPagePlan(buildPageMap());
    observationBuildMs += performance.now() - observationStartedAt;
    agent.pageMap = stableMap;
    observationBuildMs = Math.round(observationBuildMs);
    logFlow("latency.span", {
      observation_build_ms: observationBuildMs,
      step: stableMap.step,
      controls: stableMap.controls?.length || 0,
      fields: stableMap.fields?.length || 0,
      buttons: stableMap.buttons?.length || 0
    });

    const userMessage = agent.pendingUserMessage;
    agent.pendingUserMessage = "";
    const decision = await requestAgentDecision(stableMap, userMessage, { observation_build_ms: observationBuildMs });
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
    return (errors || [])
      .map((error) => String(error || "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .filter((error) => !/no seat map available|not possible to reserve seats|requested random seating/i.test(error));
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

  function agentSectionsHtml(map) {
    const sections = (map.sections || []).filter((section) => section.type !== "continue");
    if (!sections.length) return "";
    let currentAssigned = false;
    return `
      <ol class="atw-section-progress">
        ${sections.map((section) => {
          const state = section.status === "complete" ? "done" : section.status === "blocked" ? "blocked" : "pending";
          const isCurrent = state === "pending" && !currentAssigned;
          if (isCurrent) currentAssigned = true;
          return `<li class="${state}${isCurrent ? " is-current" : ""}"><span class="atw-dot"></span>${escapeHtml(section.label)}</li>`;
        }).join("")}
      </ol>
    `;
  }

  function agentReasoningHtml() {
    if (!agent.reasoningLog.length) return "";
    return `
      <div class="atw-reasoning-log">
        ${agent.reasoningLog.slice(-5).reverse().map((entry) => `
          <div class="atw-reasoning-item ${entry.ok === false ? "is-warn" : ""}">
            <span class="atw-reasoning-step">${escapeHtml(entry.loopStep)}</span>
            <span class="atw-reasoning-text">${escapeHtml(entry.action)}</span>
            ${entry.reason ? `<span class="atw-reasoning-reason">${escapeHtml(entry.reason)}</span>` : ""}
          </div>
        `).join("")}
      </div>
    `;
  }

  // Sidebar is logs-only by design: it starts the agent and shows what it's doing
  // (section checklist, reasoning log). Anything that needs the user's input is
  // asked on the page itself, next to the AI cursor — see cursorPromptHtml().
  function agentChatHtml() {
    const map = agent.pageMap || rememberPagePlan(buildPageMap());
    return `
      ${agentStatusHtml(map)}
      <div class="atw-map-line">Reading ${map.site}: ${map.step.replace(/_/g, " ")} · ${map.summary.knownFields}/${map.summary.fields} fields · ${map.summary.paidChoices} paid areas</div>
      ${agentSectionsHtml(map)}
      ${agent.running ? agentReasoningHtml() : ""}
      ${agent.awaiting ? `<div class="atw-mini-note">Waiting for you — answer next to the AI cursor on the page.</div>` : ""}
    `;
  }

  function latestQuestionText() {
    const last = [...agent.messages].reverse().find((message) => message.role === "assistant");
    return last?.text || `I found ${routeSummary()}. Want me to complete checkout for ${traveler()?.first_name || "this traveler"}?`;
  }

  function cursorPromptHtml() {
    return `
      <div class="atw-cursor-prompt-message">${escapeHtml(latestQuestionText())}</div>
      ${agentDecisionHtml()}
      <form id="atw-chat-form" class="atw-chat-form">
        <input id="atw-chat-input" placeholder="Type: continue, skip extras, stop..." />
        <button class="atw-primary" type="submit">Send</button>
      </form>
    `;
  }

  function renderCursorPrompt() {
    const existing = document.getElementById("atw-cursor-prompt");
    if (!agent.awaiting) {
      existing?.remove();
      return;
    }
    const prompt = existing || document.createElement("div");
    prompt.id = "atw-cursor-prompt";
    prompt.innerHTML = cursorPromptHtml();
    if (!prompt.parentElement) document.body.appendChild(prompt);
    const cursor = document.getElementById("atw-agent-cursor");
    const anchorRect = cursor?.getBoundingClientRect();
    if (anchorRect && anchorRect.width) {
      const left = Math.min(Math.max(8, anchorRect.left), window.innerWidth - 340);
      const top = Math.min(anchorRect.bottom + 14, window.innerHeight - 40);
      prompt.style.left = `${Math.max(8, left)}px`;
      prompt.style.top = `${Math.max(8, top)}px`;
    } else {
      prompt.style.left = "50%";
      prompt.style.top = "auto";
      prompt.style.bottom = "24px";
      prompt.style.transform = "translateX(-50%)";
    }
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

  function escapeHtml(text) {
    return String(text || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function pct(value) {
    return `${Math.round((value || 0) * 100)}%`;
  }

  const OBSERVER_TABS = [
    ["summary", "Summary"],
    ["pagemap", "Page Map"],
    ["fields", "Fields"],
    ["options", "Options"],
    ["debug", "Debug JSON"]
  ];

  function observerTabsHtml() {
    return `
      <div class="atw-buttons" style="flex-wrap:wrap;">
        ${OBSERVER_TABS.map(([key, label]) => `
          <button class="atw-tab ${agent.observerTab === key ? "atw-primary" : ""}" data-observer-tab="${key}">${label}</button>
        `).join("")}
      </div>
    `;
  }

  function observerSummaryHtml(pu) {
    const blocker = pu.checkoutState.blockers[0]?.message || "None detected.";
    const nextAction = pu.proposedNextActions[0]?.label || "None — nothing pending.";
    return `
      <div class="atw-box">
        <strong>Page understood [Observer Mode — no actions taken]</strong>
        <div class="atw-muted">Current step: ${escapeHtml(pu.pageIdentity.pageType.replace(/_/g, " "))} (confidence ${pct(pu.pageIdentity.confidence)})</div>
        <div class="atw-muted">Overall status: ${escapeHtml(pu.checkoutState.overallStatus.replace(/_/g, " "))}</div>
        <div class="atw-muted">Detected sections: ${pu.sections.length}</div>
      </div>
      <div class="atw-box">
        <strong>Main blocker</strong>
        <div class="atw-muted">${escapeHtml(blocker)}</div>
      </div>
      <div class="atw-box">
        <strong>Recommended next step (not executed)</strong>
        <div class="atw-muted">${escapeHtml(nextAction)}</div>
      </div>
      <div class="atw-box">
        <strong>Reasoning</strong>
        <div class="atw-muted">${escapeHtml(pu.reasoningSummary.shortSummary)}</div>
        ${pu.reasoningSummary.keyEvidence.length ? `<ul class="atw-list">${pu.reasoningSummary.keyEvidence.map((e) => `<li>${escapeHtml(e)}</li>`).join("")}</ul>` : ""}
        ${pu.reasoningSummary.uncertainty.length ? `<div class="atw-muted" style="margin-top:6px;"><em>Uncertain about:</em><ul class="atw-list">${pu.reasoningSummary.uncertainty.map((e) => `<li>${escapeHtml(e)}</li>`).join("")}</ul></div>` : ""}
      </div>
      ${pu.warnings.length ? `
        <div class="atw-box">
          <strong>Warnings</strong>
          <ul class="atw-list">${pu.warnings.map((w) => `<li>[${w.severity}] ${escapeHtml(w.title || w.type)}: ${escapeHtml(w.message)}</li>`).join("")}</ul>
        </div>
      ` : ""}
    `;
  }

  function observerPageMapHtml(pu) {
    return `
      <div class="atw-box">
        <strong>Sections (${pu.sections.length})</strong>
        ${pu.sections.map((section, index) => `
          <div style="margin:10px 0;padding-top:8px;border-top:1px solid rgba(255,255,255,0.08);">
            <div><strong>${index + 1}. [${escapeHtml(section.type)}]</strong> ${escapeHtml(section.label)} — ${escapeHtml(section.status)} (${pct(section.confidence)})</div>
            <ul class="atw-list">${section.evidence.map((e) => `<li>${escapeHtml(e)}</li>`).join("")}</ul>
          </div>
        `).join("") || "<div class='atw-muted'>No sections detected.</div>"}
      </div>
    `;
  }

  function observerFieldsHtml(pu) {
    const known = pu.fields.filter((f) => f.semanticType !== "unknown");
    const unknownCount = pu.fields.length - known.length;
    return `
      <div class="atw-box">
        <strong>Recognized fields (${known.length}/${pu.fields.length})</strong>
        ${known.map((field) => `
          <div style="margin:8px 0;">
            <div>${field.filled ? "✓" : "✗"} <strong>${escapeHtml(field.semanticType)}</strong>${field.required ? " (required)" : ""} — ${field.filled ? escapeHtml(field.valuePreview || "filled") : "empty"} (${pct(field.confidence)})</div>
            <div class="atw-muted" style="font-size:11px;">${escapeHtml(field.label.slice(0, 60))}</div>
          </div>
        `).join("") || "<div class='atw-muted'>None recognized.</div>"}
        ${unknownCount ? `<div class="atw-muted">+${unknownCount} unrecognized field(s) on page (tracked within their section's choices, not shown here).</div>` : ""}
      </div>
    `;
  }

  function observerOptionsHtml(pu) {
    if (!pu.options.length) return `<div class="atw-box atw-muted">No paid/choice options detected on this page.</div>`;
    return `
      <div class="atw-box">
        <strong>Options (${pu.options.length})</strong>
        ${pu.options.map((option) => `
          <div style="margin:8px 0;padding-top:8px;border-top:1px solid rgba(255,255,255,0.08);">
            <div><strong>${escapeHtml(option.label)}</strong> — ${escapeHtml(option.category)} · ${escapeHtml(option.status)}${option.price ? ` · ${option.price.amount} ${option.price.currency}` : ""} (${pct(option.confidence)})</div>
          </div>
        `).join("")}
      </div>
    `;
  }

  function observerDebugHtml(pu) {
    return `
      <div class="atw-box">
        <button id="atw-copy-observer-json">Copy debug JSON</button>
        <pre style="white-space:pre-wrap;font-size:10px;line-height:1.4;max-height:400px;overflow-y:auto;margin-top:8px;">${escapeHtml(JSON.stringify(pu, null, 2))}</pre>
      </div>
    `;
  }

  function observerPanelHtml() {
    const pu = agent.pageUnderstanding;
    if (!pu) return `<div class="atw-box atw-muted">Click "Observe page" to scan.</div>`;
    const renderers = {
      summary: observerSummaryHtml,
      pagemap: observerPageMapHtml,
      fields: observerFieldsHtml,
      options: observerOptionsHtml,
      debug: observerDebugHtml
    };
    return (renderers[agent.observerTab] || observerSummaryHtml)(pu);
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
        <label class="atw-label">Anything specific for this booking? (optional)
          <textarea id="atw-user-goal" placeholder="e.g. book free, nothing extra, no seat" ${agent.running ? "disabled" : ""}>${escapeHtml(agent.userGoal)}</textarea>
        </label>
        <div class="atw-buttons">
          <button class="atw-primary" id="atw-takeover" ${detected ? "" : "disabled"}>Start agent</button>
          <button id="atw-observe-only" ${detected ? "" : "disabled"}>Observe page (no actions) [TEMP]</button>
        </div>
        ${mode === "observer" ? `
          <div class="atw-observer">
            ${observerTabsHtml()}
            ${observerPanelHtml()}
          </div>
        ` : `
          <div class="atw-agent-card">
            ${agentChatHtml()}
          </div>
        `}
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
    renderCursorPrompt();
    document.getElementById("atw-user-goal")?.addEventListener("input", (event) => { agent.userGoal = event.target.value; });
    document.getElementById("atw-takeover").addEventListener("click", () => takeOverCheckout().catch((error) => alert(error.message)));
    document.getElementById("atw-observe-only")?.addEventListener("click", () => observePageOnly().catch((error) => alert(error.message)));
    document.querySelectorAll("[data-observer-tab]").forEach((button) => {
      button.addEventListener("click", () => setObserverTab(button.dataset.observerTab));
    });
    document.getElementById("atw-copy-observer-json")?.addEventListener("click", () => {
      navigator.clipboard.writeText(JSON.stringify(agent.pageUnderstanding, null, 2))
        .then(() => alert("Debug JSON copied."))
        .catch((error) => alert(error.message));
    });
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

  window.addEventListener("pagehide", () => { saveResumeMarker(); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") saveResumeMarker();
  });

  try {
    await fetchData();
    warnings = runRiskChecks();
    const resumeMarker = await readResumeMarker();
    const resumeIsFresh = Boolean(resumeMarker) && (Date.now() - (resumeMarker.savedAt || 0) < RESUME_MAX_AGE_MS);
    if (resumeIsFresh && resumeMarker.travelerId) {
      selectedTravelerId = resumeMarker.travelerId;
      renderSidebar("agent");
      resumeCheckoutAfterNavigation(resumeMarker);
    } else {
      if (resumeMarker) await clearResumeMarker();
      renderSidebar();
    }
    watchForCheckoutChanges();
  } catch (error) {
    const root = document.createElement("aside");
    root.id = "atw-sidebar";
    root.innerHTML = `<div class="atw-panel"><h2>Air Travel Wallet</h2><p class="atw-muted">${error.message}</p></div>`;
    document.body.appendChild(root);
  }
})();
