(async function bootAirTravelWallet() {
  if (document.getElementById("atw-sidebar")) return;

  const DEFAULT_API = "http://localhost:4173/api";
  const MAX_OBSERVATION_TRANSPORT_BYTES = 5_250_000;
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
  const canonicalSelectionCommitments = new Map();
  function rememberCanonicalSelectionCommitment(option, decision = {}) {
    if (!option?.matches?.("[role='option'], option, [role='menuitem']")) return null;
    const surface = option.closest?.("[role='listbox'], [role='menu']") || option.parentElement?.closest?.("[id]");
    const surfaceId = surface?.id || "";
    const controlId = decision.controlId || option.dataset?.atwControlId || "";
    if (!surfaceId || !controlId) return null;
    const label = (decision.targetLabel || controlText(option) || option.textContent || "").replace(/\s+/g, " ").trim();
    const commitment = {
      controlId,
      targetId: decision.targetId || elementId(option),
      label,
      semantic: decision.targetSnapshot?.semantic || semanticChoiceType(label),
      risk: decision.targetSnapshot?.risk || choiceRisk(label)
    };
    canonicalSelectionCommitments.set(surfaceId, commitment);
    return commitment;
  }
  document.addEventListener("click", (event) => {
    const option = event.target?.closest?.("[role='option'], option, [role='menuitem']");
    if (option) rememberCanonicalSelectionCommitment(option);
  }, true);
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
    observerTab: "summary",
    lifecycleId: 0,
    loopRunSerial: 0,
    activeLoopRunId: 0,
    loopBusy: false,
    loopRerunQueued: false,
    activePlannerRequest: null
  };
  let activeObservationElementRegistry = null;
  let activeObservationControlRegistry = null;

  function storageGet(keys) {
    return chrome.storage.local.get(keys);
  }

  const RESUME_KEY = "atwAgentResume";
  const RESUME_MAX_AGE_MS = 3 * 60 * 1000;

  async function saveResumeMarker() {
    try {
      if (!agent.running || !agent.sessionId) {
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
    const travelers = Array.isArray(appData?.travelers) ? appData.travelers : [];
    return travelers.find((item) => item.id === selectedTravelerId) || travelers[0] || null;
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

  function resetFieldProgress() {
    agent.completedFields = {};
  }

  function rememberPagePlan(map) {
    agent.sectionPlan = map?.sections || [];
    agent.taskQueue = map?.taskQueue || [];
    return map;
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
      await reportActionResult({
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
      const selectResult = await setSelectValue(element, [expected]);
      result.ok = selectResult.ok;
      result.method = selectResult.method;
      result.actual = selectResult.value || currentElementValue(element);
      recordAction("field_fill", result);
      await reportActionResult({
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
        await reportActionResult({
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
      await reportActionResult({
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
      await reportActionResult({
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
      surface: compactText(agent.pageMap?.currentSurface?.label || "", 220)
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
      decisionGroupId: control?.decisionGroupId || "",
      controlKind: control?.kind || "",
      state: control?.state || null,
      operations: control?.operations || {},
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
    const surface = map.currentSurface || { id: "surface-page", type: "page" };
    return surfaceMembershipForElement(element, surface).surfaceId === (surface.id || "surface-page");
  }

  function validateResolvedTarget(decision = {}, element, map = agent.pageMap || buildPageMap()) {
    const expected = decision.targetSnapshot;
    const live = liveTargetSnapshot(element, map);
    if (!targetBelongsToCurrentSurface(map, element)) {
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
    if (live.box?.inViewport !== true) {
      return { ok: false, code: "TARGET_OUT_OF_VIEW", expected: expected || null, live };
    }
    if (!expected) return { ok: true, live, expected: null };
    const warnings = [];
    const strictSurface = isStrictActionSurfaceType(expected.surfaceType);
    const expectedControlId = expected.controlId || decision.controlId || "";
    const liveControlId = live.controlId || element?.dataset?.atwControlId || "";
    const expectedDecisionGroupId = expected.decisionGroupId || decision.decisionGroupId || "";
    if (expectedDecisionGroupId && live.decisionGroupId && expectedDecisionGroupId !== live.decisionGroupId) {
      return { ok: false, code: "TARGET_DECISION_GROUP_MISMATCH", expected, live };
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
      const allowed = new Set(capability?.actuatorIds || []);
      if (!capability || !allowed.has(live.id)) {
        return { ok: false, code: "ACTION_OPERATION_ACTUATOR_MISMATCH", expected, live };
      }
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

    if (live.box && !clickPointIsClear(element)) {
      if (live.box.inViewport && strictSurface && !controlMatches && !(expected.id && labelMatches && idMatches)) {
        return { ok: false, code: "TARGET_COVERED", expected, live };
      }
      warnings.push("TARGET_COVERED");
    }

    return { ok: true, expected, live, warnings };
  }

  function validateVisualCoordinateTarget(decision = {}, hit, map = agent.pageMap || buildPageMap()) {
    const expected = decision.targetSnapshot || {};
    const region = decision.visualRegion || expected.visualRegion || null;
    const x = Number(decision.x);
    const y = Number(decision.y);
    const values = [x, y, Number(region?.x), Number(region?.y), Number(region?.width), Number(region?.height)];
    const controlledRecovery = expected.source === "visual_control_recovery";
    if (!["visual_fallback", "visual_control_recovery"].includes(expected.source) || !region || values.some((value) => !Number.isFinite(value))) {
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
    if (rect.width < 2 || rect.height < 2 || style.visibility === "hidden" || style.display === "none" || style.pointerEvents === "none" || Number(style.opacity || 1) < 0.15 || isDisabledLike(hit)) {
      return { ok: false, code: "VISUAL_TARGET_NOT_ACTIONABLE", expected, live: liveTargetSnapshot(hit, map) };
    }
    if (decision.risk !== "safe") {
      return { ok: false, code: "VISUAL_RISK_UNAPPROVED", expected, live: liveTargetSnapshot(hit, map) };
    }
    return { ok: true, expected, live: liveTargetSnapshot(hit, map), warnings: [] };
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
      graphIntegrity: map.graphIntegrity || null,
      foreground: map.foreground || foregroundSurfaceState(map.currentSurface || {}),
      visualState: map.visualState || visualPageState(map),
      accessibility: map.accessibility ? {
        foregroundSurfaceId: map.accessibility.foregroundSurfaceId,
        foregroundSurfaceType: map.accessibility.foregroundSurfaceType,
        controls: (map.accessibility.controls || []).slice(0, 40)
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

  function shouldSendFlowLog(phase = "") {
    if (agent.sessionId || agent.activeTurnId || agent.running || agent.awaiting) return true;
    return /^(backend|execute|ledger|action|invariant|policy|target|outcome|latency)\./.test(String(phase || ""));
  }

  function logFlow(phase, payload = {}) {
    const entry = {
      seq: agent.flowSeq + 1,
      at: new Date().toISOString(),
      turnId: payload.turnId || agent.activeTurnId || "",
      phase,
      payload
    };
    agent.flowSeq += 1;
    agent.flowLog.push(entry);
    agent.flowLog = agent.flowLog.slice(-160);
    logAgentEvent(`flow:${phase}`, payload);
    // eslint-disable-next-line no-console
    console.debug("[atw-flow]", phase, payload);
    if (shouldSendFlowLog(phase)) sendFlowLog(entry);
    return entry;
  }

  function abortActivePlannerRequest(reason = "superseded") {
    const request = agent.activePlannerRequest;
    if (!request) return false;
    agent.activePlannerRequest = null;
    request.controller?.abort(reason);
    logFlow("backend.request.abort", {
      turnId: request.turnId,
      observationId: request.observationId,
      loopRunId: request.loopRunId,
      reason
    });
    return true;
  }

  function resetAgentLoopLifecycle(reason = "reset") {
    agent.lifecycleId += 1;
    agent.loopRerunQueued = false;
    abortActivePlannerRequest(reason);
    return agent.lifecycleId;
  }

  function beginAgentLoop() {
    if (agent.loopBusy) {
      agent.loopRerunQueued = true;
      logFlow("loop.duplicate_suppressed", {
        activeLoopRunId: agent.activeLoopRunId,
        lifecycleId: agent.lifecycleId,
        reason: "A checkout loop turn is already active; one fresh rerun was queued."
      });
      return null;
    }
    const token = {
      loopRunId: agent.loopRunSerial + 1,
      lifecycleId: agent.lifecycleId
    };
    agent.loopRunSerial = token.loopRunId;
    agent.activeLoopRunId = token.loopRunId;
    agent.loopBusy = true;
    return token;
  }

  function finishAgentLoop(token) {
    if (!token || agent.activeLoopRunId !== token.loopRunId) return false;
    const shouldRerun = Boolean(agent.loopRerunQueued && agent.running);
    agent.loopBusy = false;
    agent.activeLoopRunId = 0;
    agent.loopRerunQueued = false;
    return shouldRerun;
  }

  function plannerRequestIsCurrent(request) {
    return Boolean(
      request
      && agent.activePlannerRequest === request
      && request.lifecycleId === agent.lifecycleId
      && request.loopRunId === agent.activeLoopRunId
    );
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
    const materialSignature = materialObservationSignature(map);
    return {
      observationId: agent.activeObservationId || "",
      signature,
      structuralSignature,
      materialSignature,
      snapshotHash: stableHash(materialSignature),
      diagnosticHash: stableHash(structuralSignature),
      pageHash: stableHash(signature),
      url: location.href,
      site: map.site,
      step: map.step,
      foreground: map.foreground || foregroundSurfaceState(map.currentSurface || {}),
      visualState: map.visualState || visualPageState(map),
      currentSurfaceLabel: map.currentSurface?.label || "",
      currentSurfaceType: map.currentSurface?.type || "page",
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
    const feedback = verification.feedback && typeof verification.feedback === "object"
      ? verification.feedback
      : {
          dispatched: true,
          targetReacted: Boolean(verification.ok),
          selectionChanged: false,
          surfaceChanged: Boolean(verification.evidence?.visual?.foregroundChanged),
          progressChanged: Boolean(verification.evidence?.visual?.progressMarkerChanged),
          priceChanged: false
        };
    const pageChanged = Boolean(
      feedback.domChanged
      || feedback.visualChanged
      || verification.evidence?.visual?.visualChanged
      || verification.evidence?.visual?.foregroundChanged
      || verification.code === "PAGE_CHANGED"
      || verification.code === "STAGE_CHANGED"
      || verification.code === "OBSERVABLE_CHANGE"
    );
    const postconditionSatisfied = Boolean(
      verification.ok
      && (
        ["normalized_value_changed", "field_value_changed", "control_selected"].includes(expectedOutcome.type)
        || verification.evidence?.goalSatisfied === true
      )
    );
    const result = {
      at: new Date().toISOString(),
      actionId,
      observationId,
      plannedObservationId: decision.observationId || "",
      observationHash: decision.observationHash || "",
      requirementId: decision.requirementId || "",
      intent: decision.intent || "",
      operation: decision.operation || "",
      goalId: decision.goalId || "",
      candidateId: decision.candidateId || "",
      controlId: decision.controlId || decision.targetSnapshot?.controlId || "",
      skillPlanId: decision.skillPlanId || "",
      skillAtomId: decision.skillAtomId || "",
      dispatched: true,
      targetResolved: feedback.targetFound !== false,
      clickReachedPage: ["click", "click_xy"].includes(decision.action || ""),
      pageChanged,
      activeSurfaceChanged: Boolean(feedback.surfaceChanged),
      feedback,
      expectedOutcomeObserved: Boolean(verification.ok),
      postconditionSatisfied,
      failureCode: verification.ok ? "" : String(verification.code || "OUTCOME_NOT_VERIFIED"),
      resultObservationHash: String(verification.evidence?.afterObservationHash || ""),
      executed: true,
      verified: Boolean(verification.ok),
      action: {
        id: decision.actionId || decision.id || actionId,
        action: decision.action || "",
        intent: decision.intent || "",
        operation: decision.operation || "",
        controlId: decision.controlId || decision.targetSnapshot?.controlId || "",
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

  function rememberUnexecutedActionResult(actionId, observationId, decision = {}, outcome = {}) {
    const mechanicallyAttempted = outcome.dispatched === true || outcome.executed === true;
    const result = {
      at: new Date().toISOString(),
      actionId,
      observationId,
      plannedObservationId: decision.observationId || observationId || "",
      observationHash: decision.observationHash || "",
      requirementId: decision.requirementId || "",
      intent: decision.intent || "",
      operation: decision.operation || "",
      goalId: decision.goalId || "",
      candidateId: decision.candidateId || "",
      controlId: decision.controlId || decision.targetSnapshot?.controlId || "",
      skillPlanId: decision.skillPlanId || "",
      skillAtomId: decision.skillAtomId || "",
      dispatched: mechanicallyAttempted,
      targetResolved: Boolean(outcome.targetResolved),
      clickReachedPage: Boolean(outcome.clickReachedPage),
      pageChanged: Boolean(outcome.pageChanged),
      activeSurfaceChanged: Boolean(outcome.activeSurfaceChanged),
      expectedOutcomeObserved: false,
      postconditionSatisfied: false,
      failureCode: String(outcome.code || "ACTION_NOT_DISPATCHED"),
      resultObservationHash: String(outcome.resultObservationHash || ""),
      executed: mechanicallyAttempted,
      verified: false,
      action: {
        id: decision.actionId || decision.id || actionId,
        action: decision.action || "",
        intent: decision.intent || "",
        operation: decision.operation || "",
        controlId: decision.controlId || decision.targetSnapshot?.controlId || "",
        targetId: decision.targetId || "",
        targetLabel: decision.targetLabel || "",
        value: decision.value || "",
        risk: decision.risk || "",
        reason: decision.reason || ""
      },
      targetSnapshot: decision.targetSnapshot || null,
      expectedOutcome: decision.expectedOutcome || null,
      outcome
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
      verified: false,
      payload: result
    });
    agent.actionHistory = agent.actionHistory.slice(-40);
    return result;
  }

  async function rejectMechanicalAction(actionId, observationId, decision = {}, outcome = {}, target = null) {
    const result = rememberUnexecutedActionResult(actionId, observationId, decision, outcome);
    pushActionLedger({
      actionId,
      observationId,
      stage: "rejected",
      action: decision,
      targetFingerprint: target ? targetFingerprint(target, decision) : null,
      result: { ok: false, ...outcome }
    });
    logFlow("mechanical_action.rejected", { actionId, observationId, outcome, result });
    await reportActionResult(result);
    await continueAfterAction(150);
    return result;
  }

  async function persistControlFlowDecision(decision = {}, actionId = "", observationId = "") {
    return reportActionResult({
      at: new Date().toISOString(),
      type: decision.action || "stop",
      actionId: actionId || decision.actionId || decision.id || nextFlowId("act"),
      observationId: observationId || decision.observationId || agent.activeObservationId || "",
      executed: true,
      verified: true,
      action: {
        id: actionId || decision.actionId || decision.id || "",
        action: decision.action || "stop",
        intent: decision.intent || "",
        targetId: decision.targetId || "",
        targetLabel: decision.targetLabel || "",
        value: decision.value || "",
        risk: decision.risk || "safe",
        reason: decision.reason || ""
      },
      targetSnapshot: decision.targetSnapshot || null,
      expectedOutcome: decision.expectedOutcome || null,
      outcome: {
        code: "CONTROL_FLOW_PERSISTED",
        message: decision.message || decision.reason || `Checkout agent entered ${decision.action || "stop"}.`
      }
    });
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

  async function startAgentSession(resumeSessionId = "") {
    try {
      const settings = await storageGet(["apiBase"]);
      const response = await fetch(`${settings.apiBase || DEFAULT_API}/agent/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: resumeSessionId || "",
          resumeOnly: Boolean(resumeSessionId),
          goal: agent.userGoal || "Complete this flight checkout safely with one-click assistance.",
          userIntent: userIntentText(),
          traveler: traveler(),
          page: compactPageMap(agent.pageMap || rememberPagePlan(buildPageMap()))
        })
      });
      if (!response.ok) throw new Error(`session returned ${response.status}`);
      const session = await response.json();
      const sessionId = String(session.id || "");
      if (!sessionId) throw new Error("session handshake returned an empty id");
      if (resumeSessionId && sessionId !== resumeSessionId) {
        throw new Error("session handshake returned a replacement transaction id");
      }
      agent.sessionId = sessionId;
      logAgentEvent("agent_session_started", { sessionId: agent.sessionId });
      return session;
    } catch (error) {
      logAgentEvent("agent_session_failed", { error: error.message });
      agent.sessionId = "";
      return null;
    }
  }

  async function reportActionResult(result = {}) {
    if (!agent.sessionId) {
      if (!agent.running) return false;
      throw new Error("Cannot report an action result without the durable checkout session.");
    }
    if (agent.activeExecutionActionId && !result.actionId && typeof result.verified !== "boolean") {
      logFlow("action.report.helper_suppressed", {
        actionId: agent.activeExecutionActionId,
        resultType: result.type || "",
        reason: "Only the final governed verification result may update the transaction."
      });
      return false;
    }
    logFlow("action.report", {
      result,
      page: pageSnapshot("report-action-result")
    });
    try {
      const settings = await storageGet(["apiBase"]);
      const map = rememberPagePlan(buildPageMap());
      const authoritativeResult = {
        ...(agent.lastActionResult || {}),
        ...result,
        actionId: result.actionId || agent.lastActionResult?.actionId || agent.activeExecutionActionId || "",
        observationId: result.observationId || agent.lastActionResult?.observationId || agent.activeExecutionObservationId || ""
      };
      const response = await fetch(`${settings.apiBase || DEFAULT_API}/agent/report`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: agent.sessionId,
          result: {
            ...authoritativeResult,
            stage: authoritativeResult.stage || map.step,
            errors: authoritativeResult.errors || actionableCheckoutErrors(map.errors)
          },
          page: compactPageMap(map)
        })
      });
      if (!response.ok) throw new Error(`agent report returned ${response.status}`);
      const session = await response.json();
      if (!session?.id || session.id !== agent.sessionId) {
        throw new Error("agent report did not acknowledge the active durable session");
      }
      return true;
    } catch (error) {
      logAgentEvent("agent_report_failed", { error: error.message });
      resetAgentLoopLifecycle("action_result_persistence_failed");
      agent.running = false;
      agent.awaiting = "manual";
      addAgentMessage("assistant", "I could not persist the verified action result in the active checkout session, so I stopped before taking another action.");
      renderSidebar("agent");
      throw error;
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

  function transactionFactsEvidence({ step = "unknown", price = null, decisionGroups = [], activeSurface = {} } = {}) {
    const text = String(primaryPageText() || visiblePageText() || "")
      .replace(/[\u200e\u200f\u202a-\u202e]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const normalizeCurrency = (value = "") => ({ "€": "EUR", "$": "USD", "£": "GBP" }[String(value).toUpperCase()] || String(value).toUpperCase());
    const attributeSegments = queryAllDeep("[data-origin][data-destination], [data-departure-airport][data-arrival-airport]")
      .map((element, index) => ({
        segmentId: element.getAttribute("data-segment-id") || `structured_${index + 1}`,
        origin: (element.getAttribute("data-origin") || element.getAttribute("data-departure-airport") || "").toUpperCase(),
        destination: (element.getAttribute("data-destination") || element.getAttribute("data-arrival-airport") || "").toUpperCase(),
        departureDate: element.getAttribute("data-departure-date") || "",
        departureTime: element.getAttribute("data-departure-time") || "",
        arrivalTime: element.getAttribute("data-arrival-time") || "",
        flightNumber: (element.getAttribute("data-flight-number") || "").toUpperCase(),
        confidence: 0.95
      }))
      .filter((segment) => segment.origin || segment.destination);
    const routeMatches = [...text.matchAll(/\b([A-Z]{3})\b(?:\s+[\p{L}.'-]+){0,3}\s*(?:-|–|—|→|\bto\b)\s*\b([A-Z]{3})\b/gu)];
    const dates = [
      ...[...text.matchAll(/\b20\d{2}-\d{2}-\d{2}\b/g)].map((match) => match[0]),
      ...[...text.matchAll(/\b(?:mon|tue|wed|thu|fri|sat|sun)(?:day)?\s+\d{1,2}\s+[\p{L}]+\s+20\d{2}\b/giu)].map((match) => match[0])
    ];
    const timePairs = [...text.matchAll(/\b(\d{1,2}:\d{2})\s*(?:-|–|—|to)\s*(\d{1,2}:\d{2})\b/gi)];
    const flights = [...text.matchAll(/\b([A-Z]{2}|[A-Z]\d|\d[A-Z])\s*([0-9]{2,4})\b/g)]
      .map((match) => `${match[1]}${match[2]}`)
      .filter((value) => !/^20\d{2}$/.test(value));
    const textSegments = routeMatches.map((match, index) => ({
      segmentId: `observed_${index + 1}_${stableHash(`${match[1]}:${match[2]}:${dates[index] || ""}:${flights[index] || ""}`)}`,
      origin: match[1].toUpperCase(),
      destination: match[2].toUpperCase(),
      departureDate: dates[index] || (dates.length === 1 ? dates[0] : ""),
      departureTime: timePairs[index]?.[1] || (timePairs.length === 1 ? timePairs[0][1] : ""),
      arrivalTime: timePairs[index]?.[2] || (timePairs.length === 1 ? timePairs[0][2] : ""),
      flightNumber: flights[index] || (flights.length === 1 ? flights[0] : ""),
      confidence: 0.68
    }));
    const segments = (attributeSegments.length ? attributeSegments : textSegments).map(({ confidence, ...segment }) => segment).slice(0, 12);
    const completeness = !segments.length
      ? "unknown"
      : segments.every((segment) => segment.origin && segment.destination && segment.departureDate)
        ? "complete"
        : "partial";
    const baseFareMatch = text.match(/\b(?:price per (?:adult|passenger)|flight ticket|base fare)\s*[:\-]?\s*(\d+(?:[.,]\d{1,2})?)\s*(EUR|USD|GBP|CHF|CAD|AUD|€|\$|£)\b/i);
    const fareBrandMatch = text.match(/\b(?:fare|ticket)\s*(?:brand|type|class)?\s*[:\-]\s*([\p{L}][\p{L}0-9 +_-]{1,40})/iu);
    const currentTraveler = traveler() || {};
    const source = step === "payment"
      ? "payment_summary"
      : activeSurface?.type && activeSurface.type !== "page"
        ? "popup"
        : segments.length
          ? "travel_details"
          : "order_summary";
    const selectedExtras = decisionGroups
      .filter((group) => group.status === "satisfied" && group.selectedLabel)
      .map((group) => ({
        decisionGroupId: group.decisionGroupId || "",
        label: group.selectedLabel || "",
        disposition: group.selectedSemantic || "",
        priceAmount: null,
        currency: price?.currency || ""
      }))
      .slice(0, 40);
    return {
      itinerary: { completeness, segments },
      travelers: currentTraveler.id ? [{
        travelerId: currentTraveler.id,
        name: [currentTraveler.first_name, currentTraveler.middle_name, currentTraveler.last_name].filter(Boolean).join(" ")
      }] : [],
      currency: normalizeCurrency(price?.currency || baseFareMatch?.[2] || ""),
      basePrice: baseFareMatch ? {
        amount: Number(baseFareMatch[1].replace(",", ".")),
        currency: normalizeCurrency(baseFareMatch[2])
      } : { amount: null, currency: normalizeCurrency(price?.currency || "") },
      totalPrice: price ? { amount: Number(price.amount), currency: normalizeCurrency(price.currency) } : { amount: null, currency: "" },
      fareBrand: fareBrandMatch?.[1]?.trim() || "",
      selectedExtras,
      provenance: [{
        source,
        observationId: agent.activeObservationId || "",
        confidence: attributeSegments.length ? 0.95 : segments.length ? 0.68 : price ? 0.75 : 0.35
      }]
    };
  }

  function structuralPageSignature(map = buildPageMap()) {
    const activeSurface = map.currentSurface || {};
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

  function materialObservationSignature(map = buildPageMap()) {
    const materialUrl = (() => {
      try {
        const url = new URL(map.url || location.href, location.href);
        return `${url.origin}${url.pathname}${url.search}`;
      } catch (error) {
        return String(map.url || location.href || "").split("#")[0];
      }
    })();
    const foreground = map.currentSurface?.type && map.currentSurface.type !== "page"
      ? map.currentSurface
      : {};
    const stableState = (state = {}) => ({
      checked: Boolean(state.checked),
      selected: Boolean(state.selected),
      disabled: Boolean(state.disabled),
      expanded: Boolean(state.expanded),
      valuePresent: Boolean(state.valuePresent),
      normalizedValue: String(state.normalizedValue || ""),
      required: Boolean(state.required)
    });
    const controls = (map.controls || [])
      .map((control) => ({
        controlId: control.controlId || "",
        decisionGroupId: control.decisionGroupId || "",
        semantic: control.semantic || control.field || "",
        kind: control.kind || control.role || control.type || "",
        risk: control.risk || "",
        surfaceId: control.surfaceId || "",
        sectionId: control.sectionId || "",
        state: stableState(control.state || {
          checked: control.checked,
          selected: control.selected,
          disabled: control.disabled,
          valuePresent: control.hasValue,
          required: control.required
        })
      }))
      .sort((a, b) => a.controlId.localeCompare(b.controlId));
    const decisionGroups = (map.decisionGroups || [])
      .map((group) => ({
        decisionGroupId: group.decisionGroupId || "",
        requirementId: group.requirementId || "",
        semanticType: group.semanticType || group.sectionType || "",
        stage: group.stage || map.step || "",
        surfaceId: group.surfaceId || "",
        instanceId: group.instanceId || "",
        status: group.status || "",
        selectedControlId: group.selectedControlId || group.selected?.controlId || "",
        selectedValue: group.selectedValue || group.selected?.value || ""
      }))
      .sort((a, b) => a.decisionGroupId.localeCompare(b.decisionGroupId));
    const fields = (map.fields || [])
      .map((field) => ({
        controlId: field.controlId || "",
        semantic: field.field || "",
        decisionGroupId: field.decisionGroupId || "",
        hasValue: Boolean(field.hasValue),
        required: Boolean(field.required),
        disabled: Boolean(field.disabled || field.element?.disabled)
      }))
      .sort((a, b) => `${a.controlId}:${a.semantic}`.localeCompare(`${b.controlId}:${b.semantic}`));
    return JSON.stringify({
      url: materialUrl,
      step: map.step || "unknown",
      foreground: {
        id: foreground.id || "",
        type: foreground.type || "page",
        decisionGroupId: foreground.decisionGroupId || ""
      },
      graphIntegrity: {
        ok: map.graphIntegrity?.ok !== false,
        unresolvedConflictCount: Number(map.graphIntegrity?.unresolvedConflictCount || 0)
      },
      transactionFacts: map.transactionFacts ? {
        itinerary: map.transactionFacts.itinerary,
        travelers: map.transactionFacts.travelers,
        currency: map.transactionFacts.currency,
        basePrice: map.transactionFacts.basePrice,
        totalPrice: map.transactionFacts.totalPrice,
        fareBrand: map.transactionFacts.fareBrand,
        selectedExtras: map.transactionFacts.selectedExtras
      } : null,
      price: map.price || null,
      controls,
      decisionGroups,
      fields
    });
  }

  function observationHashForMap(map = buildPageMap()) {
    return stableHash(materialObservationSignature(map));
  }

  function nextElementId(reservedIds = new Set()) {
    let id = "";
    do {
      elementIdCounter += 1;
      id = `atw-el-${elementIdCounter}`;
    } while (reservedIds.has(id));
    reservedIds.add(id);
    return id;
  }

  function createObservationElementRegistry() {
    const byElement = new WeakMap();
    const byId = new Map();
    const duplicateRekeys = [];
    const initialOwners = new Map();
    for (const element of queryAllDeep("[data-atw-element-id]")) {
      const id = element.dataset?.atwElementId || "";
      if (!id) continue;
      if (!initialOwners.has(id)) initialOwners.set(id, []);
      initialOwners.get(id).push(element);
    }
    const reservedIds = new Set(initialOwners.keys());

    const assign = (element) => {
      if (!element) return "";
      const assigned = byElement.get(element);
      if (assigned) return assigned;

      const inheritedId = element.dataset?.atwElementId || "";
      const inheritedOwners = inheritedId ? (initialOwners.get(inheritedId) || []) : [];
      const inheritedIsUnique = Boolean(inheritedId)
        && inheritedOwners.length <= 1
        && (!byId.has(inheritedId) || byId.get(inheritedId) === element);
      const id = inheritedIsUnique ? inheritedId : nextElementId(reservedIds);

      if (inheritedId && inheritedId !== id) {
        duplicateRekeys.push({
          inheritedId,
          assignedId: id,
          duplicateCount: Math.max(inheritedOwners.length, byId.has(inheritedId) ? 2 : 1),
          tag: (element.tagName || "").toLowerCase(),
          label: compactText(directControlName(element) || element.getAttribute?.("aria-label") || element.textContent || "", 140)
        });
      }
      try {
        element.dataset.atwElementId = id;
      } catch (_) {
        // SVG/foreign elements may not expose a mutable dataset.
      }
      byElement.set(element, id);
      byId.set(id, element);
      return id;
    };

    for (const owners of initialOwners.values()) {
      if (owners.length < 2) continue;
      owners.forEach(assign);
    }

    return {
      assign,
      idFor: (element) => byElement.get(element) || "",
      elementFor: (id) => byId.get(id) || null,
      duplicateRekeys
    };
  }

  function elementId(element) {
    if (!element) return "";
    if (!activeObservationElementRegistry) {
      activeObservationElementRegistry = createObservationElementRegistry();
    }
    return activeObservationElementRegistry.assign(element);
  }

  function elementById(id) {
    if (!id) return null;
    const owned = activeObservationElementRegistry?.elementFor?.(id);
    if (owned) return owned;
    const matches = queryAllDeep(`[data-atw-element-id="${CSS.escape(id)}"]`);
    if (matches.length !== 1) return null;
    const assignedId = elementId(matches[0]);
    return assignedId === id ? matches[0] : null;
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

  function directControlName(element) {
    if (!element) return "";
    const role = implicitRole(element);
    const tag = (element.tagName || "").toLowerCase();
    const type = (element.getAttribute?.("type") || "").toLowerCase();
    const labelledBy = textFromIds(element.getAttribute?.("aria-labelledby"));
    const direct = [
      element.getAttribute?.("aria-label"),
      labelledBy,
      element.getAttribute?.("alt"),
      element.getAttribute?.("title"),
      /button|submit|reset/.test(type) ? element.value : "",
      tag === "button" || role === "button" ? (element.innerText || element.textContent || "") : "",
      tag === "option" || role === "option" ? (element.innerText || element.textContent || "") : ""
    ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    if (direct && !/^(on|true|false)$/i.test(direct)) return compactText(direct, 220);
    if (tag === "input" && (type === "radio" || type === "checkbox")) {
      const label = labelText(element) || element.value || "";
      if (label && !/^(on|true|false)$/i.test(label)) return compactText(label, 220);
    }
    return "";
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
      element.getAttribute?.("alt"),
      element.getAttribute?.("title"),
      element.value && /button|submit|reset/.test(element.type || "") ? element.value : "",
      buttonText(element),
      labelText(element),
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
    const surface = map?.currentSurface || {};
    const control = map ? lookupControlForElement(map, element) : null;
    const box = elementBox(element);
    return {
      id: elementId(element),
      controlId: control?.controlId || element.dataset?.atwControlId || "",
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
    const surface = map.currentSurface || {};
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

  function currentSurfaceEntryForElement(map, element) {
    if (!element) return null;
    const id = elementId(element);
    return currentSurfaceEntries(map).find((entry) => entry.id === id) || null;
  }

  function isActionableClickTarget(element) {
    return Boolean(element?.matches?.("button, a, input[type='button'], input[type='submit'], [role='button'], [role='option'], [role='checkbox'], [role='radio'], label, input[type='checkbox'], input[type='radio'], [tabindex]"));
  }

  function canonicalAliasRecords(control = {}) {
    const operationAliases = Object.entries(control.operations || {}).flatMap(([operation, capability]) =>
      (capability?.actuatorIds || []).map((aliasId) => ({ aliasId, kind: `operation:${operation}` }))
    );
    return [
      { aliasId: control.controlId, kind: "control" },
      { aliasId: control.stateElementId, kind: "state" },
      { aliasId: control.preferredActivationElementId, kind: "activation" },
      { aliasId: control.visualRef, kind: "visual" },
      ...(control.actuators || []).map((actuator) => ({
        aliasId: actuator?.nodeId,
        kind: actuator?.relation || "actuator"
      })),
      ...operationAliases
    ]
      .map((entry) => ({ ...entry, aliasId: String(entry.aliasId || "").trim() }))
      .filter((entry, index, list) => entry.aliasId
        && list.findIndex((item) => item.aliasId === entry.aliasId) === index);
  }

  function buildCanonicalAliasIndex(map = {}) {
    const byControlId = new Map();
    const byAlias = new Map();
    const aliasKinds = new Map();
    const ambiguousAliases = new Set();
    const conflicts = [];

    for (const control of map.controls || []) {
      const controlId = String(control?.controlId || "").trim();
      if (!controlId) continue;
      if (byControlId.has(controlId) && byControlId.get(controlId) !== control) {
        conflicts.push({ code: "DUPLICATE_CONTROL_ID", aliasId: controlId, controlIds: [controlId] });
        ambiguousAliases.add(controlId);
        byAlias.delete(controlId);
        continue;
      }
      byControlId.set(controlId, control);
    }

    const register = (aliasValue, controlValue, kind = "alias", source = "control") => {
      const aliasId = String(aliasValue || "").trim();
      const controlId = String(controlValue || "").trim();
      if (!aliasId || !controlId) return;
      if (!byControlId.has(controlId)) {
        conflicts.push({ code: "UNKNOWN_CONTROL_ID", aliasId, controlIds: [controlId], source });
        ambiguousAliases.add(aliasId);
        byAlias.delete(aliasId);
        return;
      }
      if (ambiguousAliases.has(aliasId)) return;
      const owner = byAlias.get(aliasId);
      if (owner && owner !== controlId) {
        conflicts.push({ code: "ALIAS_OWNERSHIP_CONFLICT", aliasId, controlIds: [owner, controlId].sort(), source });
        ambiguousAliases.add(aliasId);
        byAlias.delete(aliasId);
        aliasKinds.delete(aliasId);
        return;
      }
      byAlias.set(aliasId, controlId);
      aliasKinds.set(aliasId, kind || "alias");
    };

    for (const control of byControlId.values()) {
      canonicalAliasRecords(control).forEach((entry) => register(entry.aliasId, control.controlId, entry.kind));
    }
    for (const annotation of map.screenshotAnnotations || []) {
      if (!annotation?.controlId) continue;
      register(annotation.visualRef, annotation.controlId, "visual", "screenshot_annotation");
      register(annotation.targetId, annotation.controlId, "annotation_target", "screenshot_annotation");
    }
    for (const group of map.decisionGroups || []) {
      for (const alternative of group?.alternatives || []) {
        if (!alternative?.controlId) continue;
        register(alternative.targetId, alternative.controlId, "decision_target", "decision_group");
        register(alternative.visualRef, alternative.controlId, "visual", "decision_group");
      }
    }

    const entries = [...byAlias.entries()]
      .map(([aliasId, controlId]) => ({ aliasId, controlId, kind: aliasKinds.get(aliasId) || "alias" }))
      .sort((a, b) => a.aliasId.localeCompare(b.aliasId));
    return {
      byAlias,
      byControlId,
      aliasKinds,
      ambiguousAliases,
      conflicts,
      entries,
      resolve(aliasValue) {
        const aliasId = String(aliasValue || "").trim();
        if (!aliasId || ambiguousAliases.has(aliasId)) return null;
        const controlId = byAlias.get(aliasId);
        return controlId ? byControlId.get(controlId) || null : null;
      }
    };
  }

  function decisionTargetAliasIds(decision = {}) {
    const target = decision.targetSnapshot || {};
    return [
      decision.controlId,
      decision.targetId,
      decision.visualRef,
      target.controlId,
      target.id,
      target.visualRef,
      target.stateElementId,
      target.preferredActivationElementId,
      ...(target.actuators || []).map((actuator) => actuator?.nodeId),
      ...Object.values(target.operations || {}).flatMap((capability) => capability?.actuatorIds || [])
    ]
      .map((aliasId) => String(aliasId || "").trim())
      .filter((aliasId, index, list) => aliasId && list.indexOf(aliasId) === index);
  }

  function resolveDecisionTarget(decision, map) {
    const mutatingTargetAction = ["click", "type", "select", "keypress"].includes(decision.action);
    if (!mutatingTargetAction) return null;

    const requestedVisualRef = decision.visualRef || decision.targetSnapshot?.visualRef || "";
    const requestedControlId = decision.controlId || decision.targetSnapshot?.controlId || "";
    const aliasIndex = buildCanonicalAliasIndex(map);
    const requestedAliases = decisionTargetAliasIds(decision);
    const unresolvedAliases = requestedAliases.filter((aliasId) => !aliasIndex.resolve(aliasId));
    const resolvedControlIds = [...new Set(requestedAliases
      .map((aliasId) => aliasIndex.resolve(aliasId)?.controlId || "")
      .filter(Boolean))];
    const visualAnnotation = requestedVisualRef
      ? (map.screenshotAnnotations || []).find((item) => item.visualRef === requestedVisualRef) || null
      : null;
    const control = requestedAliases.length && !unresolvedAliases.length && resolvedControlIds.length === 1
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
    if (decision.operation && !capability) {
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
      return decision.action === "click"
        ? ["state", "activation", "label", "annotation_target", "decision_target"].includes(kind)
        : kind === "state" && aliasId === control.stateElementId;
    }) || "";
    const candidateIds = (capability
      ? [
          requestedElementId,
          capability.actuatorId,
          ...(capability.actuatorIds || [])
        ]
      : decision.action === "click"
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
        && (decision.action !== "click" || meaningfulActionBox(elementBox(element))));

    if (controlTarget) {
      logFlow("target.resolve", {
        method: requestedElementId ? "exact-canonical-member" : "canonical-control",
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

  function isAuxiliaryNavigationAction(element) {
    if (!element?.matches?.("a, [role='link']")) return false;
    if (element.matches("[role='button'], [aria-haspopup], [aria-controls]")) return false;
    if (element.closest("form, [role='dialog'], [aria-modal='true']")) return false;
    return Boolean(element.closest("footer, [role='contentinfo'], nav, [role='navigation'], header, [role='banner']"));
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
        return {
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
          sourceElementId: field.id,
          box: field.box
        };
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

  function structuredPriceFromText(value = "") {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    const after = text.match(/(-?\d+(?:[.,]\d{1,2})?)\s*(EUR|USD|GBP|CHF|€|\$|£)/i);
    const before = text.match(/(EUR|USD|GBP|CHF|€|\$|£)\s*(-?\d+(?:[.,]\d{1,2})?)/i);
    const amountText = after?.[1] || before?.[2] || "";
    const currencyText = String(after?.[2] || before?.[1] || "").toUpperCase();
    if (!amountText || !currencyText) return null;
    const currency = currencyText === "€" ? "EUR" : currencyText === "$" ? "USD" : currencyText === "£" ? "GBP" : currencyText;
    const amount = Number(amountText.replace(",", "."));
    return Number.isFinite(amount) ? { amount, currency } : null;
  }

  function semanticChoiceType(label = "") {
    const text = label.toLowerCase();
    const structuredPrice = structuredPriceFromText(label);
    if (/no checked baggage|no baggage|without baggage|i.ll go without|go without/.test(text)) return "decline_baggage";
    if (/no,?\s*thanks|none of the passengers|none\b|without/.test(text)) return "decline_paid_extra";
    if ((structuredPrice && structuredPrice.amount > 0)
      || /add to cart|add to my trip|premium|bundle|checked baggage|\b\d+\s*x\s*\d+\s*kg/.test(text)) return "add_paid_extra";
    if (/continue|next|proceed/.test(text)) return "continue";
    if (/mr|mrs|ms|title/.test(text)) return "traveler_title";
    return "choice";
  }

  function choiceRisk(label = "") {
    const structuredPrice = structuredPriceFromText(label);
    if (structuredPrice?.amount === 0) return "safe";
    if (structuredPrice && structuredPrice.amount > 0) return "money";
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

  function isPlaceholderChoiceValue(value = "") {
    return /^(choose|select|please select|select one|select one option|please choose)$/i.test(String(value || "").replace(/\s+/g, " ").trim());
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
    if (element?.type === "radio" || element?.type === "checkbox") return element.checked ? "selected" : "";
    return text.toLowerCase();
  }

  function controlStateForElement(element, semantic = "") {
    const value = currentElementValue(element);
    const exposesChoiceValue = isDropdownLikeElement(element) || implicitRole(element) === "option";
    const valueText = exposesChoiceValue && value && !isPlaceholderChoiceValue(value)
      ? compactText(value, 180)
      : "";
    return {
      checked: Boolean(element?.checked === true || element?.getAttribute?.("aria-checked") === "true"),
      selected: Boolean(element?.selected === true || element?.getAttribute?.("aria-selected") === "true" || isChoiceSelected(element)),
      valuePresent: Boolean(value && String(value).trim()),
      value: value ? "[filled]" : "",
      valueText,
      normalizedValue: normalizedControlValue(value, semantic, element),
      normalizationMode: semantic === "phone_country_code" ? "country_code" : semantic === "phone" ? "phone" : "text",
      disabled: isDisabledLike(element),
      required: Boolean(element?.required === true || element?.getAttribute?.("aria-required") === "true"),
      expanded: element?.getAttribute?.("aria-expanded") === "true",
      pressed: element?.getAttribute?.("aria-pressed") === "true",
      native: element?.tagName === "SELECT"
    };
  }

  function effectiveOperationActuator(element) {
    if (!element || !isVisible(element) || isDisabledLike(element)) return null;
    const box = elementBox(element);
    if (!meaningfulActionBox(box)) return null;
    if (box.inViewport === false) return element;
    const x = Math.min(window.innerWidth - 2, Math.max(2, box.centerX));
    const y = Math.min(window.innerHeight - 2, Math.max(2, box.centerY));
    const hit = document.elementFromPoint(x, y);
    if (!hit || !(hit === element || element.contains(hit) || hit.contains(element))) return null;
    const actionableHit = clickableAncestor(hit);
    if (actionableHit && (actionableHit === element || element.contains(actionableHit) || actionableHit.contains(element))) {
      return actionableHit;
    }
    return element;
  }

  function operationActuatorCandidates(stateElement, sourceElement, activationElement) {
    const candidates = [];
    const add = (element, score, reason) => {
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
        box: elementBox(effectiveElement)
      };
      if (!current) candidates.push(entry);
      else if (score > current.score) Object.assign(current, entry);
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
          const provenCandidate = explicitMatch || popupContract || buttonContract || pointerContract;
          if (provenCandidate) {
            const target = clickable && clickable !== stateElement ? clickable : candidate;
            add(
              target,
              explicitMatch ? 130 : popupContract ? 115 : buttonContract ? 100 : rightEdgeControl ? 95 : 85,
              explicitMatch
                ? "shared-aria-controls"
                : popupContract
                  ? "popup-contract"
                  : buttonContract
                    ? "button-in-control"
                    : rightEdgeControl
                      ? "pointer-right-edge-toggle"
                      : "pointer-actuator"
            );
          }
        });
    }
    const stateRole = implicitRole(stateElement);
    const stateStyle = stateElement ? getComputedStyle(stateElement) : null;
    const stateProvesActivation = stateElement?.tagName === "BUTTON"
      || stateRole === "button"
      || stateElement?.hasAttribute?.("onclick")
      || stateStyle?.cursor === "pointer";
    if (stateProvesActivation) add(stateElement, 90, "state-proves-activation");
    if (activationElement && activationElement !== stateElement) {
      const activationRole = implicitRole(activationElement);
      const activationStyle = getComputedStyle(activationElement);
      const activationProvesOpen = activationElement.tagName === "BUTTON"
        || activationRole === "button"
        || activationElement.getAttribute?.("aria-haspopup") === "listbox"
        || activationElement.hasAttribute?.("onclick")
        || activationStyle.cursor === "pointer";
      if (activationProvesOpen) add(activationElement, 80, "activation-member");
    }
    if (sourceElement && sourceElement !== stateElement) {
      const sourceStyle = getComputedStyle(sourceElement);
      const sourceContract = sourceElement.getAttribute?.("aria-haspopup") === "listbox"
        || sourceElement.getAttribute?.("aria-expanded") != null
        || sourceElement.tagName === "BUTTON"
        || implicitRole(sourceElement) === "button"
        || sourceElement.hasAttribute?.("onclick")
        || sourceStyle.cursor === "pointer";
      if (sourceContract) add(sourceElement, 110, "source-popup-contract");
    }
    return candidates.sort((a, b) => b.score - a.score);
  }

  function recoveryRegion(box = {}, surfaceId = "", evidence = "", confidence = 0.5) {
    if (!box || box.width < 4 || box.height < 4) return null;
    return normalizeVisualRegionContract({
      ...box,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      surfaceId,
      inViewport: box.inViewport !== false,
      evidence,
      confidence
    });
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
      observationId: String(raw.observationId || context.observationId || "").slice(0, 120),
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

  function visualRecoveryForOpenOperation(stateElement, wrapper, surfaceId = "") {
    if (!stateElement || !wrapper) return null;
    const stateBox = elementBox(stateElement);
    const wrapperBox = elementBox(wrapper);
    const candidates = [];
    const add = (box, evidence, confidence) => {
      const region = recoveryRegion(box, surfaceId, evidence, confidence);
      if (!region || !meaningfulActionBox(region)) return;
      if (candidates.some((item) => boxesCloseEnough(item, region))) return;
      candidates.push(region);
    };

    const geometricSibling = [...(wrapper.children || [])]
      .filter((child) => child !== stateElement && isVisible(child) && !child.closest?.("#atw-sidebar"))
      .map((child) => ({ child, box: elementBox(child) }))
      .filter(({ box }) => box.width >= 8
        && box.height >= 8
        && box.width <= Math.max(100, wrapperBox.width * 0.5)
        && box.x >= stateBox.x + stateBox.width * 0.45
        && box.y < stateBox.y + stateBox.height
        && box.y + box.height > stateBox.y)
      .sort((a, b) => (a.box.width * a.box.height) - (b.box.width * b.box.height))[0];
    if (geometricSibling) add(geometricSibling.box, "geometric_right_edge_sibling", 0.68);

    const ownerBox = wrapperBox.width <= Math.max(520, window.innerWidth * 0.7) && wrapperBox.height <= 180
      ? wrapperBox
      : stateBox;
    const edgeWidth = Math.min(Math.max(28, ownerBox.width * 0.28), 76);
    add({
      x: ownerBox.x + ownerBox.width - edgeWidth,
      y: ownerBox.y,
      width: edgeWidth,
      height: ownerBox.height,
      inViewport: ownerBox.inViewport
    }, "bounded_right_edge_hit_region", 0.52);

    if (!candidates.length) return null;
    return {
      operation: "open",
      status: "unproven",
      strategy: "semantic_accessibility_geometry_visual",
      requiresFreshObservation: true,
      requiresVisualConfirmation: true,
      regions: candidates.slice(0, 3)
    };
  }

  function controlOperationsForElement({ element, stateElement, activationElement, kind, role, state }) {
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
          reason: candidate.reason || "canonical-member"
        })),
        precondition,
        expectedOutcome
      };
    };
    const stateId = elementId(stateElement);
    const activationId = activationElement ? elementId(activationElement) : "";
    const tag = String(stateElement?.tagName || "").toLowerCase();
    const inputType = String(stateElement?.getAttribute?.("type") || "").toLowerCase();
    const dropdownLike = tag === "select" || role === "combobox" || role === "listbox" || stateElement?.getAttribute?.("aria-haspopup") === "listbox";
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
    if (tag === "select") operations.select = make("select", [stateId], "normalized_value_changed", { disabled: false });
    if (dropdownLike && tag !== "select") {
      const openCandidates = operationActuatorCandidates(stateElement, element, activationElement);
      operations.open = make("open", openCandidates, "options_surface_appeared", { expanded: false });
      operations.keyboard = make("keyboard", [stateId], "semantic_progress", { disabled: false });
    }
    if (["option", "radio", "checkbox"].includes(kind) || ["option", "radio", "checkbox"].includes(role)) {
      operations.choose = make("choose", [activationId, stateId], "control_selected", { disabled: false });
    } else if (kind === "button" || role === "button") {
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
    const localMeaning = normalizeMatchText(
      associatedLabelText
      || buttonText(target)
      || target.getAttribute?.("aria-label")
      || target.getAttribute?.("title")
      || target.getAttribute?.("placeholder")
      || ""
    ).slice(0, 140);
    const stableAttributes = [
      target.getAttribute?.("name") ? `name:${target.getAttribute("name")}` : "",
      target.getAttribute?.("type") ? `type:${target.getAttribute("type")}` : "",
      target.getAttribute?.("value") ? `value:${target.getAttribute("value")}` : "",
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

  function canonicalControlForElement(element, context = {}) {
    if (!element || element.closest?.("#atw-sidebar")) return null;
    const stateElement = stateElementForControl(element);
    if (!stateElement || stateElement.closest?.("#atw-sidebar")) return null;
    const labelElement = labelElementForInput(stateElement);
    const wrapper = controlWrapperForElement(element, stateElement);
    const activationElement = labelElement || clickableAncestor(element) || clickableAncestor(wrapper) || stateElement;
    const kind = controlKindForElement(stateElement);
    const directName = directControlName(stateElement) || directControlName(element);
    const label = compactText(
      kind === "button"
        ? (directName || buttonText(stateElement) || buttonText(element) || accessibleName(stateElement) || accessibleName(element))
        : (choiceLabel(stateElement)
          || directName
          || buttonText(element)
          || labelText(stateElement)
          || accessibleName(element)
          || accessibleName(stateElement)
          || controlText(stateElement)),
      220
    );
    const semantic = /radio|checkbox|option/.test(kind) ? semanticChoiceType(label) : (semanticFieldType({ label, kind, field: context.field || "" }) || semanticChoiceType(label));
    const sectionType = context.sectionType || context.section?.type || "";
    const sectionLabel = context.sectionLabel || context.section?.label || "";
    const sectionId = context.sectionId || context.section?.id || "";
    const surface = context.surface || {};
    const surfaceDecisionGroupId = surface?.type && surface.type !== "page"
      ? (surface.decisionGroupId || decisionGroupIdForContext({ sectionType: surface.taskHint || surface.type || "", sectionLabel: surface.parentSectionLabel || surface.label || surface.taskHint || "" }))
      : "";
    const decisionGroupId = context.decisionGroupId || decisionGroupIdForContext({ sectionType, sectionLabel, field: context.field || "" }) || surfaceDecisionGroupId;
    const members = [
      { element: stateElement, relation: "state" },
      { element: labelElement, relation: "label" },
      { element: wrapper, relation: "wrapper" },
      { element: activationElement, relation: "activation" },
      { element, relation: "source" }
    ].filter((item) => item.element);
    const boxes = members.map((item) => isVisible(item.element) ? elementBox(item.element) : null).filter(Boolean);
    const state = controlStateForElement(stateElement, semantic);
    const domRole = implicitRole(stateElement) || implicitRole(element);
    const operations = controlOperationsForElement({ element, stateElement, activationElement, kind, role: domRole, state });
    const recovery = {
      open: isDropdownLikeElement(stateElement) && !operations.open
        ? visualRecoveryForOpenOperation(stateElement, wrapper, surface.id || "")
        : null
    };
    const stableKey = stableControlKeyForElement(element, stateElement, kind);
    const identityHash = stableHash(stableKey);
    const controlId = `ctrl_${slugControlPart(kind).slice(0, 24)}_${identityHash}`.slice(0, 140);
    if (recovery.open?.regions?.length) {
      recovery.open.regions = recovery.open.regions.map((region) => normalizeVisualRegionContract(region, {
        controlId,
        operation: "open",
        source: "control.recovery.open",
        surfaceId: surface.id || ""
      }));
    }
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
      kind,
      role: perceptionRole,
      domRole,
      semantic,
      semanticIntent: semantic,
      risk: choiceRisk(label),
      structuredPrice: structuredPriceFromText(label),
      state,
      currentValue: state.normalizedValue || state.valueText || "",
      capabilities: observedCapabilities(operations, perceptionRole),
      operations,
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
      stateElementId: elementId(stateElement),
      preferredActivationElementId: elementId(activationElement || stateElement),
      actuators,
      visualRegion
    };
  }

  function applyControlToModel(model, control) {
    if (!model || !control) return model;
    model.controlId = control.controlId;
    model.stableKey = control.stableKey || model.stableKey || "";
    model.meaning = control.meaning || model.meaning || control.semantic || "";
    model.structuredPrice = control.structuredPrice || model.structuredPrice || null;
    model.decisionGroupId = control.decisionGroupId || model.decisionGroupId || "";
    model.controlKind = control.kind;
    model.controlState = control.state;
    model.currentValue = control.currentValue || "";
    model.capabilities = control.capabilities || [];
    model.operations = control.operations;
    model.recovery = control.recovery || {};
    model.stateElementId = control.stateElementId;
    model.preferredActivationElementId = control.preferredActivationElementId;
    model.actuators = control.actuators;
    model.operations = control.operations;
    model.visualRegion = control.visualRegion;
    model.visualRegions = control.visualRegions || [];
    model.semantic = model.semantic || control.semantic;
    model.semanticIntent = model.semanticIntent || control.semanticIntent || control.semantic;
    model.risk = control.risk || model.risk;
    model.role = control.role || model.role;
    model.domRole = control.domRole || model.domRole || "";
    if (model.field || Object.prototype.hasOwnProperty.call(model, "value")) {
      model.hasValue = Boolean(
        model.value
        || control.state?.valuePresent
        || control.state?.checked
        || control.state?.selected
      );
    }
    return model;
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
    const selectedLabel = field.controlState?.valueText || control.state?.valueText || "";
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
    const selectedLabel = observedValue && !isPlaceholderChoiceValue(observedValue)
      ? observedValue
      : "";
    const stateElement = elementById(control.stateElementId || control.preferredActivationElementId || "");
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
      risk: matchingCommitment?.risk || (selectedLabel ? choiceRisk(selectedLabel) : (control.risk || "uncertain")),
      selected: Boolean(selectedLabel),
      state: control.state || null,
      priceText: selectedLabel.match(/(?:\d+(?:[.,]\d{1,2})?\s?(?:EUR|€|USD|\$)|(?:EUR|€|USD|\$)\s?\d+(?:[.,]\d{1,2})?)/i)?.[0] || ""
    };
  }

  function sectionDecisionControls(section = {}, controls = []) {
    return (controls || []).filter((control) => {
      if (!control?.controlId || control.sectionId !== section.id) return false;
      const role = `${control.role || ""} ${control.domRole || ""} ${control.kind || ""}`.toLowerCase();
      const semantic = String(control.semantic || "").toLowerCase();
      return /combobox|listbox|select/.test(role)
        || /required_dropdown_choice/.test(semantic)
        || Boolean(control.operations?.open);
    });
  }

  function buildCanonicalDecisionGroups(sections = [], controls = [], activeSurface = {}) {
    const byControlId = new Map((controls || []).map((control) => [control.controlId, control]));
    const sectionGroups = (sections || [])
      .filter((section) => (
        Array.isArray(section.choices) && section.choices.length
        || sectionDecisionFields(section).length
        || sectionDecisionControls(section, controls).length
      ))
      .map((section) => {
        const decisionControls = sectionDecisionControls(section, controls);
        const decisionGroupId = decisionControls[0]?.decisionGroupId
          || decisionGroupIdForContext({ sectionType: section.type, sectionLabel: section.label });
        const choiceModels = (section.choices || []).map((choice) => {
          const control = byControlId.get(choice.controlId) || {};
          return {
            controlId: choice.controlId || control.controlId || "",
            targetId: choice.id || control.preferredActivationElementId || control.stateElementId || "",
            label: choice.label || control.label || "",
            semantic: choice.semantic || control.semantic || "",
            risk: choice.risk || control.risk || "",
            selected: Boolean(choice.selected || control.selected || control.state?.checked || control.state?.selected),
            state: choice.controlState || control.state || null,
            priceText: (choice.label || "").match(/(?:\d+(?:[.,]\d{1,2})?\s?(?:EUR|€|USD|\$)|(?:EUR|€|USD|\$)\s?\d+(?:[.,]\d{1,2})?)/i)?.[0] || ""
          };
        });
        const fieldModels = sectionDecisionFields(section).map((field) => choiceLikeModelFromDecisionField(field, byControlId.get(field.controlId) || {}));
        const controlModels = decisionControls.map(choiceLikeModelFromDecisionControl);
        const choices = [...choiceModels, ...fieldModels, ...controlModels]
          .filter((choice) => choice.controlId || choice.targetId || choice.label)
          .filter((choice, index, list) => {
            const key = `${choice.controlId || choice.targetId}:${normalizeMatchText(choice.label)}`;
            return list.findIndex((other) => `${other.controlId || other.targetId}:${normalizeMatchText(other.label)}` === key) === index;
          });
        const selected = choices.find((choice) => choice.selected) || null;
        return {
          decisionGroupId,
          surfaceId: decisionControls[0]?.surfaceId || "surface-page",
          sectionId: section.id || "",
          sectionType: section.type || "",
          sectionLabel: section.label || "",
          requirementId: section.type || section.id || "",
          required: Boolean(section.required || section.paidChoice || choices.some((choice) => choice.state?.required)),
          status: selected ? "satisfied" : (section.required || section.paidChoice || choices.some((choice) => choice.state?.required) ? "missing" : "optional"),
          selectedControlId: selected?.controlId || "",
          selectedLabel: selected?.label || "",
          selectedSemantic: selected?.semantic || "",
          alternatives: choices.map((choice) => ({
            controlId: choice.controlId,
            targetId: choice.targetId,
            label: choice.label,
            semantic: choice.semantic,
            risk: choice.risk,
            selected: choice.selected,
            priceText: choice.priceText
          })),
          evidence: selected ? [`Selected: ${selected.label}`] : [`No selected option for ${section.label || section.type || "decision"}`]
        };
      })
      .slice(0, 80);
    const surfaceGroups = activeSurface?.type && activeSurface.type !== "page" && Array.isArray(activeSurface.options) && activeSurface.options.length
      ? [(() => {
          const decisionGroupId = activeSurface.decisionGroupId || decisionGroupIdForContext({ sectionType: activeSurface.taskHint || activeSurface.type || "", sectionLabel: activeSurface.parentSectionLabel || activeSurface.label || activeSurface.taskHint || "" });
          const alternatives = (activeSurface.options || []).map((option) => {
            const control = byControlId.get(option.controlId) || {};
            const selected = Boolean(option.selected || control.selected || control.state?.checked || control.state?.selected);
            return {
              controlId: option.controlId || control.controlId || "",
              targetId: option.id || control.preferredActivationElementId || control.stateElementId || "",
              label: option.label || control.label || "",
              semantic: option.semantic || control.semantic || "",
              risk: option.risk || control.risk || "",
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
            required: true,
            status: selected ? "satisfied" : "missing",
            selectedControlId: selected?.controlId || "",
            selectedLabel: selected?.label || "",
            selectedSemantic: selected?.semantic || "",
            alternatives,
            evidence: selected ? [`Selected: ${selected.label}`] : [`No selected option for ${activeSurface.label || activeSurface.type || "active surface"}`]
          };
        })()]
      : [];
    return [...surfaceGroups, ...sectionGroups].slice(0, 80);
  }

  function controlsAreCompatibleAliases(a = {}, b = {}) {
    const sameControl = a.controlId && b.controlId && a.controlId === b.controlId;
    if (sameControl) return true;
    const sameMeaning = normalizeMatchText(a.label || "") === normalizeMatchText(b.label || "")
      && (a.semantic || "") === (b.semantic || "")
      && (a.risk || "") === (b.risk || "")
      && (a.decisionGroupId || "") === (b.decisionGroupId || "");
    return Boolean(sameMeaning);
  }

  function controlMemberNodeIds(control = {}) {
    const operationActuatorIds = Object.values(control.operations || {})
      .flatMap((capability) => capability?.actuatorIds || []);
    return [
      control.stateElementId,
      control.preferredActivationElementId,
      ...(control.actuators || []).map((actuator) => actuator.nodeId),
      ...operationActuatorIds
    ].filter((nodeId, index, list) => nodeId && list.indexOf(nodeId) === index);
  }

  function controlExclusiveNodeIds(control = {}) {
    const operationActuatorIds = Object.values(control.operations || {})
      .flatMap((capability) => capability?.actuatorIds || []);
    const ids = new Set([
      control.stateElementId,
      control.preferredActivationElementId,
      ...operationActuatorIds
    ].filter(Boolean));
    for (const actuator of control.actuators || []) {
      if (!actuator?.nodeId) continue;
      if (["state", "activation", "label"].includes(actuator.relation)) {
        ids.add(actuator.nodeId);
        continue;
      }
      if (actuator.relation === "source") {
        const node = elementById(actuator.nodeId);
        if (node && isActionableClickTarget(node)) ids.add(actuator.nodeId);
      }
    }
    return [...ids];
  }

  function controlContextPriority(context = {}) {
    const surface = context.surface || {};
    if (surface?.type && surface.type !== "page") return 100;
    if (context.section?.id || context.sectionId) return 50;
    return 10;
  }

  function createObservationControlRegistry() {
    const controls = new Map();
    const byDomNode = new Map();
    const priorityByControlId = new Map();
    const conflicts = [];

    const removeOwnedControl = (control) => {
      if (!control?.controlId) return;
      controls.delete(control.controlId);
      priorityByControlId.delete(control.controlId);
      for (const [nodeId, owner] of byDomNode.entries()) {
        if (owner?.controlId !== control.controlId) continue;
        byDomNode.delete(nodeId);
        const node = elementById(nodeId);
        if (node?.dataset?.atwControlId === control.controlId) {
          try {
            delete node.dataset.atwControlId;
          } catch (_) {
            // SVG/foreign elements may not expose a mutable dataset.
          }
        }
      }
    };

    const registerOwnedControl = (control, priority) => {
      if (!control?.controlId) return null;
      const existing = controls.get(control.controlId) || {};
      const actuators = [...(existing.actuators || []), ...(control.actuators || [])]
        .filter((entry, index, list) => entry?.nodeId && list.findIndex((other) => other.nodeId === entry.nodeId && other.relation === entry.relation) === index);
      const merged = {
        ...existing,
        ...control,
        actuators,
        visualRegion: unionBoxes([existing.visualRegion, control.visualRegion].filter(Boolean)) || control.visualRegion || existing.visualRegion
      };
      controls.set(merged.controlId, merged);
      priorityByControlId.set(merged.controlId, Math.max(priority, priorityByControlId.get(merged.controlId) || 0));
      for (const nodeId of controlExclusiveNodeIds(merged)) {
        byDomNode.set(nodeId, merged);
        const node = elementById(nodeId);
        if (node) {
          try {
            node.dataset.atwControlId = merged.controlId;
          } catch (_) {
            // SVG/foreign elements may not expose dataset.
          }
        }
      }
      return merged;
    };

    const lookupElement = (element) => {
      if (!element) return null;
      const nodeIds = [
        elementId(element),
        element.dataset?.atwControlId,
        stateElementForControl(element) ? elementId(stateElementForControl(element)) : ""
      ].filter(Boolean);
      for (const id of nodeIds) {
        if (controls.has(id)) return controls.get(id);
        if (byDomNode.has(id)) return byDomNode.get(id);
      }
      return null;
    };

    const register = (element, context = {}, explicitPriority = null) => {
      if (!element || element.closest?.("#atw-sidebar")) return null;
      const priority = Number.isFinite(explicitPriority) ? explicitPriority : controlContextPriority(context);
      const existing = lookupElement(element);
      if (existing && priority <= (priorityByControlId.get(existing.controlId) || 0)) {
        return existing;
      }

      const control = canonicalControlForElement(element, context);
      if (!control?.controlId) return existing || null;
      const memberIds = controlExclusiveNodeIds(control);
      const existingOwners = memberIds
        .map((nodeId) => byDomNode.get(nodeId))
        .filter(Boolean)
        .filter((owner, index, list) => list.findIndex((other) => other.controlId === owner.controlId) === index);
      const incompatibleOwner = existingOwners.find((owner) => !controlsAreCompatibleAliases(owner, control));
      if (incompatibleOwner) {
        const ownerPriority = priorityByControlId.get(incompatibleOwner.controlId) || 0;
        const resolvedBy = priority > ownerPriority
          ? "foreground_or_higher_priority"
          : (priority < ownerPriority ? "existing_higher_priority" : "unresolved_equal_priority");
        conflicts.push({
          nodeIds: memberIds,
          existing: {
            controlId: incompatibleOwner.controlId,
            label: incompatibleOwner.label,
            semantic: incompatibleOwner.semantic,
            risk: incompatibleOwner.risk,
            decisionGroupId: incompatibleOwner.decisionGroupId,
            surfaceId: incompatibleOwner.surfaceId
          },
          incoming: {
            controlId: control.controlId,
            label: control.label,
            semantic: control.semantic,
            risk: control.risk,
            decisionGroupId: control.decisionGroupId,
            surfaceId: control.surfaceId
          },
          resolved: resolvedBy !== "unresolved_equal_priority",
          resolvedBy
        });
        if (priority <= ownerPriority) return incompatibleOwner;
        removeOwnedControl(incompatibleOwner);
      }
      return registerOwnedControl(control, priority);
    };

    return {
      register,
      lookupElement,
      controls: () => [...controls.values()],
      conflicts
    };
  }

  function lookupControlForElement(map = agent.pageMap || null, element = null) {
    if (!element) return null;
    const live = activeObservationControlRegistry?.lookupElement?.(element);
    if (live) return live;
    const elementNodeId = elementId(element);
    const dataControlId = element.dataset?.atwControlId || "";
    const state = stateElementForControl(element);
    const stateNodeId = state ? elementId(state) : "";
    const controls = map?.controls || [];
    return controls.find((control) => dataControlId && control.controlId === dataControlId)
      || controls.find((control) => controlMemberNodeIds(control).includes(elementNodeId) || controlMemberNodeIds(control).includes(stateNodeId))
      || null;
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
            actuatorId: conflictingNodes.has(capability.actuatorId) ? "" : capability.actuatorId
          } : null
        ])),
        actuators
      };
    });
  }

  function buildCanonicalControlGraph(sections = [], fields = [], buttons = [], activeSurface = {}) {
    const registry = createObservationControlRegistry();
    activeObservationControlRegistry = registry;
    const register = (element, context, priority = null) => registry.register(element, context, priority);

    const surface = activeSurface?.type && activeSurface.type !== "page" ? activeSurface : null;
    if (surface) {
      for (const item of [...(surface.options || []), ...(surface.buttons || [])]) {
        const source = elementById(item.id);
        const control = source ? register(source, { surface }, 100) : null;
        applyControlToModel(item, control);
      }
    }

    for (const field of fields || []) {
      const section = (sections || []).find((item) => field.element && elementById(item.id)?.contains?.(field.element));
      const control = register(field.element, {
        section,
        sectionId: section?.id || "",
        sectionType: section?.type || "",
        sectionLabel: section?.label || "",
        field: field.field,
        required: field.required
      }, section ? 50 : 10);
      applyControlToModel(field, control);
    }

    for (const button of buttons || []) {
      const control = register(button.element, {
        field: button.semantic,
        required: false
      }, 10);
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

  function sectionChoiceModels(section, allSections = []) {
    return sectionChoiceInputs(section, allSections)
      .map((input) => {
        const label = choiceLabel(input);
        return {
          id: elementId(input),
          label,
          selected: Boolean(isChoiceSelected(input)),
          semantic: semanticChoiceType(label),
          risk: choiceRisk(label),
          role: implicitRole(input),
          accessibility: accessibilityNode(input, null),
          sourceElementId: elementId(input),
          box: elementBox(input)
        };
      })
      .filter((choice) => choice.label)
      .slice(0, 20);
  }

  function unfilledRequiredFields(fields = []) {
    return fields.filter((field) => {
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

  function buildStageExit(decisionGroups, fields, buttons, overlays, errors, step) {
    const continueButton = buttons.find((button) => (
      button.risk === "safe_continue" &&
      !/skip to/i.test(button.label || "") &&
      meaningfulActionBox(button.box)
    ));
    const blockers = [];
    const unresolvedGroup = (decisionGroups || []).find((group) => group.required && !["satisfied", "waived", "waived_by_policy"].includes(group.status));
    const unresolvedField = unfilledRequiredFields(fields)[0];
    if (unresolvedGroup) blockers.push(`unresolved decision: ${unresolvedGroup.sectionLabel || unresolvedGroup.requirementId || unresolvedGroup.decisionGroupId}`);
    if (unresolvedField) blockers.push(`required field: ${unresolvedField.label || unresolvedField.field || unresolvedField.controlId}`);
    if (overlays.length) blockers.push("visible overlay/menu/modal");
    if (actionableCheckoutErrors(errors).length) blockers.push(`visible errors: ${actionableCheckoutErrors(errors).slice(0, 2).join("; ")}`);
    if (!continueButton) blockers.push("no safe Continue button");
    return {
      continueAllowed: Boolean(
        continueButton &&
        !unresolvedGroup &&
        !unresolvedField &&
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
    const currentSurface = map.currentSurface || { type: "page" };
    const surfaceActive = Boolean(currentSurface.type && currentSurface.type !== "page");
    const targetControlId = decision.controlId || decision.targetSnapshot?.controlId || "";
    const targetControl = targetControlId
      ? (map.controls || []).find((control) => control.controlId === targetControlId)
      : null;
    const targetIsActiveSurfaceNavigation = Boolean(
      surfaceActive
      && targetControl?.surfaceId
      && targetControl.surfaceId === currentSurface.id
    );
    const overlays = (map.overlays || []).filter((overlay) => overlay?.label || overlay?.text);
    if (overlays.length && !targetIsActiveSurfaceNavigation) {
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
      const unresolvedGroup = (map.decisionGroups || []).find((group) => group.required && !["satisfied", "waived", "waived_by_policy"].includes(group.status));
      if (unresolvedGroup) {
        blockers.push({
          code: "UNRESOLVED_DECISION_GROUP",
          message: `${unresolvedGroup.sectionLabel || unresolvedGroup.requirementId || "A visible choice"} still needs a verified decision.`
        });
      }
      const unresolvedField = unfilledRequiredFields(map.fields || [])[0];
      if (unresolvedField) blockers.push({
        code: "REQUIRED_FIELD_EMPTY",
        message: `${unresolvedField.label || unresolvedField.field || "A required field"} is empty.`
      });
    }
    return blockers;
  }

  function expectedOutcomeForDecision(decision = {}, map = buildPageMap(), target = null) {
    const targetId = target ? elementId(target) : decision.targetId || "";
    const targetControl = target ? lookupControlForElement(map, target) : null;
    const snapshotControlId = decision.controlId || decision.targetSnapshot?.controlId || targetControl?.controlId || "";
    const label = decision.targetLabel || decision.value || (target ? buttonText(target) || labelText(target) || target.innerText || "" : "");
    const section = target ? liveSectionForElement(map, target) : null;
    const activeSurface = map.currentSurface || {};
    const base = {
      action: decision.action || "",
      targetId,
      controlId: snapshotControlId,
      stateElementId: decision.targetSnapshot?.stateElementId || targetControl?.stateElementId || "",
      targetLabel: String(label || "").replace(/\s+/g, " ").trim().slice(0, 180),
      beforeSignature: structuralPageSignature(map),
      beforeVisualState: visualPageState(map)
    };
    const activeForegroundSurface = activeSurface?.type && activeSurface.type !== "page" ? activeSurface : null;
    const foregroundDecline = activeForegroundSurface && (
      declineChoiceIntent(decision)
      || /decline|safe_decline/.test(`${decision.intent || ""} ${decision.targetSnapshot?.semantic || ""} ${decision.targetSnapshot?.risk || ""}`)
    );
    const choiceSurface = /dropdown|listbox|popover|menu/.test(String(activeForegroundSurface?.type || targetControl?.surfaceType || decision.targetSnapshot?.surfaceType || "").toLowerCase());
    const foregroundChoiceSelection = Boolean(
      /choice|radio|checkbox|option/.test(String(targetControl?.kind || targetControl?.role || decision.targetSnapshot?.kind || "").toLowerCase())
      || (choiceSurface && (targetControl?.decisionGroupId || decision.decisionGroupId || decision.targetSnapshot?.decisionGroupId))
    );
    if (decision.expectedOutcome && typeof decision.expectedOutcome === "object") {
      if (foregroundDecline && !foregroundChoiceSelection && decision.expectedOutcome.type === "requirement_status") {
        return {
          ...base,
          ...decision.expectedOutcome,
          type: "active_surface_dismissed",
          surfaceId: activeForegroundSurface.id || decision.expectedOutcome.surfaceId || decision.targetSnapshot?.surfaceId || "",
          surfaceType: activeForegroundSurface.type || decision.targetSnapshot?.surfaceType || "",
          surfaceLabel: activeForegroundSurface.label || decision.targetSnapshot?.surfaceLabel || "",
          surfaceSignature: activeForegroundSurface.signature || pageSignature(map),
          mustNotIncreasePrice: true
        };
      }
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
        if (foregroundDecline && !foregroundChoiceSelection) {
          return {
            ...base,
            type: "active_surface_dismissed",
            surfaceId: activeSurface.id || "",
            surfaceType: activeSurface.type,
            surfaceLabel: activeSurface.label || "",
            surfaceSignature: `${activeSurface.type || ""}:${activeSurface.id || ""}:${activeSurface.label || ""}:${(activeSurface.options || []).map((entry) => entry.id).join(",")}`
          };
        }
        if (foregroundChoiceSelection) {
          return {
            ...base,
            type: "control_selected",
            decisionGroupId: targetControl?.decisionGroupId || ""
          };
        }
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
    const feedback = transitionFeedbackForMaps(expected, beforeMap, afterMap, target, verification);
    logFlow("latency.span", {
      outcome_verification_ms: Math.round(performance.now() - startedAt),
      expectedOutcome: expected?.type || "",
      target: expected?.targetId || expected?.controlId || expected?.targetLabel || ""
    });
    return { ...verification, feedback };
  }

  function transitionFeedbackForMaps(expected = {}, beforeMap = {}, afterMap = {}, target = null, verification = {}) {
    const controlId = expected.controlId || expected.targetSnapshot?.controlId || "";
    const beforeControl = controlId ? (beforeMap.controls || []).find((control) => control.controlId === controlId) : null;
    const afterControl = controlId ? (afterMap.controls || []).find((control) => control.controlId === controlId) : null;
    const beforeControlState = beforeControl?.state || beforeControl?.controlState || {};
    const afterControlState = afterControl?.state || afterControl?.controlState || {};
    const controlChanged = JSON.stringify({
      selected: Boolean(beforeControl?.selected || beforeControlState.selected || beforeControlState.checked),
      value: beforeControlState.normalizedValue || beforeControlState.value || "",
      expanded: beforeControlState.expanded
    }) !== JSON.stringify({
      selected: Boolean(afterControl?.selected || afterControlState.selected || afterControlState.checked),
      value: afterControlState.normalizedValue || afterControlState.value || "",
      expanded: afterControlState.expanded
    });
    const decisionGroupId = expected.decisionGroupId || beforeControl?.decisionGroupId || afterControl?.decisionGroupId || "";
    const beforeGroup = decisionGroupId ? (beforeMap.decisionGroups || []).find((group) => group.decisionGroupId === decisionGroupId) : null;
    const afterGroup = decisionGroupId ? (afterMap.decisionGroups || []).find((group) => group.decisionGroupId === decisionGroupId) : null;
    const selectionChanged = Boolean(
      (beforeGroup || afterGroup)
      && `${beforeGroup?.selectedControlId || ""}:${beforeGroup?.status || ""}` !== `${afterGroup?.selectedControlId || ""}:${afterGroup?.status || ""}`
    ) || Boolean(controlChanged && (
      beforeControl?.selected !== afterControl?.selected
      || beforeControlState.checked !== afterControlState.checked
      || beforeControlState.normalizedValue !== afterControlState.normalizedValue
    ));
    const beforeSurface = beforeMap.currentSurface || {};
    const afterSurface = afterMap.currentSurface || {};
    const surfaceChanged = `${beforeSurface.id || ""}:${beforeSurface.type || "page"}:${beforeSurface.label || ""}`
      !== `${afterSurface.id || ""}:${afterSurface.type || "page"}:${afterSurface.label || ""}`;
    const beforeProgress = beforeMap.foreground?.progressMarkers || beforeMap.visualState?.foreground?.progressMarkers || beforeSurface.foreground?.progressMarkers || null;
    const afterProgress = afterMap.foreground?.progressMarkers || afterMap.visualState?.foreground?.progressMarkers || afterSurface.foreground?.progressMarkers || null;
    const progressChanged = JSON.stringify(beforeProgress) !== JSON.stringify(afterProgress);
    const beforeErrors = [
      ...actionableCheckoutErrors(beforeMap.errors || []),
      ...(beforeMap.validationIssues || []).map((issue) => issue.message).filter(Boolean)
    ];
    const afterErrors = [
      ...actionableCheckoutErrors(afterMap.errors || []),
      ...(afterMap.validationIssues || []).map((issue) => issue.message).filter(Boolean)
    ];
    const validationAppeared = afterErrors.some((error) => !beforeErrors.includes(error));
    const beforePrice = `${beforeMap.price?.amount ?? ""}:${beforeMap.price?.currency || ""}:${beforeMap.priceText || ""}`;
    const afterPrice = `${afterMap.price?.amount ?? ""}:${afterMap.price?.currency || ""}:${afterMap.priceText || ""}`;
    const domChanged = structuralPageSignature(beforeMap) !== structuralPageSignature(afterMap);
    const beforeVisual = visualPageState(beforeMap);
    const afterVisual = visualPageState(afterMap);
    const visualChanged = beforeVisual?.fingerprint !== afterVisual?.fingerprint;
    const navigationOccurred = beforeMap.step !== afterMap.step || (beforeMap.url || location.href) !== (afterMap.url || location.href);
    const beforeOverlay = Boolean(beforeSurface.type && beforeSurface.type !== "page");
    const afterOverlay = Boolean(afterSurface.type && afterSurface.type !== "page");
    const overlayAppeared = Boolean(afterOverlay && (!beforeOverlay || surfaceChanged));
    const targetFound = Boolean(target || beforeControl);
    const targetVisible = Boolean((target && isVisible(target)) || (beforeControl && beforeControl.visualRegion?.inViewport !== false));
    const targetReacted = Boolean(controlChanged || selectionChanged || surfaceChanged || progressChanged || navigationOccurred || validationAppeared || (!afterControl && beforeControl));
    return {
      dispatched: true,
      targetFound,
      targetVisible,
      dispatchSucceeded: true,
      targetReacted,
      selectionChanged,
      surfaceChanged,
      progressChanged,
      domChanged,
      visualChanged,
      navigationOccurred,
      overlayAppeared,
      validationAppeared,
      priceChanged: beforePrice !== afterPrice,
      outcomeVerified: verification.ok === true
    };
  }

  function withOverlayProgressEvidence(verification = {}, progress = {}) {
    const existingEvidence = verification.evidence && typeof verification.evidence === "object" && !Array.isArray(verification.evidence)
      ? verification.evidence
      : { verifierEvidence: verification.evidence || null };
    return {
      ...verification,
      evidence: {
        ...existingEvidence,
        overlayProgress: {
          ok: Boolean(progress.ok),
          reason: String(progress.reason || "")
        }
      }
    };
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
    const beforeTransitionSurface = beforeMap.currentSurface || {};
    const afterTransitionSurface = afterMap.currentSurface || {};
    const surfaceChanged = `${beforeTransitionSurface.id || ""}:${beforeTransitionSurface.type || "page"}:${beforeTransitionSurface.label || ""}`
      !== `${afterTransitionSurface.id || ""}:${afterTransitionSurface.type || "page"}:${afterTransitionSurface.label || ""}`;
    const overlayAppeared = Boolean(
      afterTransitionSurface.type
      && afterTransitionSurface.type !== "page"
      && (!beforeTransitionSurface.type || beforeTransitionSurface.type === "page" || surfaceChanged)
    );
    const beforeErrors = [
      ...actionableCheckoutErrors(beforeMap.errors || []),
      ...(beforeMap.validationIssues || []).map((issue) => issue.message).filter(Boolean)
    ];
    const afterErrors = [
      ...actionableCheckoutErrors(afterMap.errors || []),
      ...(afterMap.validationIssues || []).map((issue) => issue.message).filter(Boolean)
    ];
    const validationAppeared = afterErrors.some((error) => !beforeErrors.includes(error));
    const evidence = {
      beforeObservationHash: observationHashForMap(beforeMap),
      afterObservationHash: observationHashForMap(afterMap),
      beforeStep: beforeMap.step,
      afterStep: afterMap.step,
      beforeUrl: beforeMap.url || location.href,
      afterUrl: location.href,
      beforeSurface: beforeMap.currentSurface?.label || "",
      afterSurface: afterMap.currentSurface?.label || "",
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
    const expectedDecisionGroupId = expected.decisionGroupId || expected.targetSnapshot?.decisionGroupId || "";
    const afterControl = expectedControlId
      ? (afterMap.controls || []).find((control) => control.controlId === expectedControlId)
      : null;
    const afterDecisionGroup = expectedDecisionGroupId
      ? (afterMap.decisionGroups || []).find((group) => group.decisionGroupId === expectedDecisionGroupId)
      : null;
    const afterControlState = afterControl?.state || null;
    const logicalDecisionSatisfied = Boolean(afterDecisionGroup && afterDecisionGroup.status === "satisfied");
    const logicalControlSatisfied = Boolean(
      afterControl
      && (
        afterControl.selected
        || afterControlState?.checked
        || afterControlState?.selected
        || afterControlState?.valuePresent
      )
    );
    if (expected.type === "semantic_progress") {
      const currentSurface = afterMap.currentSurface || {};
      const actualNormalizedValue = String(afterControlState?.normalizedValue || "");
      const wantedNormalizedValue = String(expected.expectedNormalizedValue || "");
      const valueChanged = actualNormalizedValue !== String(expected.previousValue || "");
      const goalSatisfied = Boolean(wantedNormalizedValue && actualNormalizedValue === wantedNormalizedValue);
      const optionsAppeared = Boolean(
        afterControlState?.expanded === true
        || (currentSurface.type && currentSurface.type !== "page" && currentSurface.id !== String(expected.previousSurfaceId || ""))
      );
      const ok = goalSatisfied || optionsAppeared || valueChanged || foregroundChanged || progressMarkerChanged;
      return {
        ok,
        code: ok ? "SEMANTIC_PROGRESS_OBSERVED" : "SEMANTIC_PROGRESS_NOT_OBSERVED",
        message: ok
          ? "The interaction produced fresh semantic progress for the unresolved control."
          : "The interaction did not change the value, options surface, or foreground state.",
        evidence: {
          ...evidence,
          goalSatisfied,
          optionsAppeared,
          valueChanged,
          actualNormalizedValue,
          wantedNormalizedValue,
          control: afterControl || null,
          currentSurface
        }
      };
    }
    if (expected.type === "options_surface_appeared") {
      const currentSurface = afterMap.currentSurface || {};
      const surfaceAppeared = Boolean(
        currentSurface.type
        && currentSurface.type !== "page"
        && currentSurface.id !== (expected.previousSurfaceId || "")
      );
      const expanded = afterControlState?.expanded === true;
      const ok = surfaceAppeared || expanded;
      return {
        ok,
        code: ok ? "OPTIONS_SURFACE_APPEARED" : "OPTIONS_SURFACE_NOT_APPEARED",
        message: ok ? "The canonical choice options are now visible." : "The canonical open operation did not expose its options surface.",
        evidence: { ...evidence, control: afterControl || null, currentSurface }
      };
    }
    if (expected.type === "normalized_value_changed") {
      const actualNormalizedValue = String(afterControlState?.normalizedValue || "");
      const wantedNormalizedValue = String(expected.expectedNormalizedValue || "");
      const currentSurface = afterMap.currentSurface || {};
      const surfaceDismissed = !expected.requireSurfaceDismissed
        || !expected.surfaceId
        || currentSurface.id !== expected.surfaceId;
      const ownedValidationErrors = (afterMap.validationIssues || []).filter((issue) => (
        issue.stageWide === true || (expected.controlId && issue.controlId === expected.controlId)
      ));
      const ok = Boolean(
        wantedNormalizedValue
        && actualNormalizedValue === wantedNormalizedValue
        && surfaceDismissed
        && ownedValidationErrors.length === 0
      );
      return {
        ok,
        code: ok ? "NORMALIZED_VALUE_VERIFIED" : "NORMALIZED_VALUE_NOT_VERIFIED",
        message: ok ? "The canonical control retained the expected normalized value." : "The canonical control did not retain the expected normalized value or close its options surface.",
        evidence: {
          ...evidence,
          actualNormalizedValue,
          wantedNormalizedValue,
          surfaceDismissed,
          ownedValidationErrors,
          control: afterControl || null,
          currentSurface
        }
      };
    }
    if (expected.type === "field_value_changed") {
      const liveTarget = target && isVisible(target) ? target : elementById(expected.stateElementId || expected.targetId);
      const value = currentElementValue(liveTarget);
      const expectedNormalizedValue = String(expected.expectedNormalizedValue || "");
      const ok = expectedNormalizedValue
        ? afterControlState?.normalizedValue === expectedNormalizedValue
        : (Boolean(value) && (!expected.expectedValue || normalizeMatchText(value).includes(normalizeMatchText(expected.expectedValue).slice(0, 24))))
          || Boolean(afterControlState?.valuePresent);
      return {
        ok,
        code: ok ? "FIELD_VALUE_VERIFIED" : "FIELD_VALUE_NOT_VERIFIED",
        message: ok ? "Field value is present after the action." : "Field value was not retained after the action.",
        evidence: { ...evidence, value, control: afterControl || null }
      };
    }
    if (expected.type === "control_selected") {
      const ok = Boolean(afterControl && (afterControl.selected || afterControlState?.checked || afterControlState?.selected));
      return {
        ok,
        code: ok ? "CONTROL_SELECTED" : "CONTROL_NOT_SELECTED",
        message: ok ? "The canonical choice control is selected." : "The canonical choice control was not selected.",
        evidence: { ...evidence, control: afterControl || null }
      };
    }
    if (expected.type === "section_choice_verified") {
      const group = expectedDecisionGroupId
        ? (afterMap.decisionGroups || []).find((item) => item.decisionGroupId === expectedDecisionGroupId)
        : null;
      const ok = group?.status === "satisfied";
      return {
        ok,
        code: ok ? "DECISION_GROUP_SATISFIED" : "DECISION_GROUP_NOT_SATISFIED",
        message: ok ? `${expected.sectionLabel || expected.sectionType} is satisfied.` : `${expected.sectionLabel || expected.sectionType || "Decision"} is still unresolved.`,
        evidence: { ...evidence, decisionGroup: group }
      };
    }
    if (expected.type === "exact_free_option_selected") {
      const group = afterDecisionGroup || (afterMap.decisionGroups || []).find((item) => (
        (expected.sectionId && item.sectionId === expected.sectionId)
        || (expected.sectionType && item.sectionType === expected.sectionType)
        || (expected.requirementId && (item.requirementId === expected.requirementId || item.decisionGroupId === expected.requirementId))
        || (expected.expectedSelectedLabel && (() => {
          const observed = normalizeMatchText(item.selectedLabel || "");
          const wanted = normalizeMatchText(expected.expectedSelectedLabel);
          return Boolean(observed && wanted && (observed === wanted || observed.includes(wanted) || wanted.includes(observed)));
        })())
        || (expected.expectedSelectedControlId
          && (item.alternatives || []).some((option) => option.controlId === expected.expectedSelectedControlId && option.selected))
      )) || null;
      const groupSelectedControlId = String(group?.selectedControlId || group?.selected?.controlId || "");
      const expectedControlId = String(expected.expectedSelectedControlId || expected.controlId || "");
      const exactCommitment = [...canonicalSelectionCommitments.values()].find((commitment) => {
        if (!expectedControlId || commitment.controlId !== expectedControlId) return false;
        const committed = normalizeMatchText(commitment.label || "");
        const observed = normalizeMatchText(group?.selectedLabel || "");
        return Boolean(committed && observed && (committed === observed || committed.includes(observed) || observed.includes(committed)));
      }) || null;
      const selectedControlId = exactCommitment?.controlId || groupSelectedControlId;
      const selectedOption = (group?.alternatives || []).find((option) => (
        option.selected === true || (groupSelectedControlId && option.controlId === groupSelectedControlId)
      )) || null;
      const selectedText = normalizeMatchText(`${exactCommitment?.semantic || ""} ${exactCommitment?.risk || ""} ${exactCommitment?.label || ""} ${selectedOption?.semantic || ""} ${selectedOption?.risk || ""} ${selectedOption?.label || group?.selectedSemantic || ""} ${group?.selectedLabel || ""}`);
      const semanticDispositionVerified = /decline|safe decline|free|no extra|no thanks|none|without|skip/.test(selectedText);
      const paidAlternativesSelected = (group?.alternatives || []).filter((option) => {
        if (!(option.selected === true || (groupSelectedControlId && option.controlId === groupSelectedControlId))) return false;
        const risk = normalizeMatchText(option.risk || "");
        const semantic = normalizeMatchText(option.semantic || "");
        return /money|payment/.test(risk) || /add paid extra|add extra|purchase|upgrade/.test(semantic);
      });
      const exactControlSelected = Boolean(expectedControlId && selectedControlId === expectedControlId);
      const beforePriceAmount = expected.beforePriceAmount == null ? null : Number(expected.beforePriceAmount);
      const afterPriceAmount = afterMap.price?.amount == null ? null : Number(afterMap.price.amount);
      const priceDidNotIncrease = Number.isFinite(beforePriceAmount) && Number.isFinite(afterPriceAmount)
        ? afterPriceAmount <= beforePriceAmount
        : String(afterMap.priceText || "") === String(expected.beforePriceText || "");
      const ownedValidationErrors = (afterMap.validationIssues || []).filter((issue) => (
        issue.stageWide === true
        || (expectedControlId && issue.controlId === expectedControlId)
        || (expected.sectionId && issue.sectionId === expected.sectionId)
        || (expected.sectionType && issue.sectionType === expected.sectionType)
      ));
      const currentSurface = afterMap.currentSurface || {};
      const surfaceDismissed = !expected.requireSurfaceDismissed
        || !expected.expectedSurfaceId
        || currentSurface.id !== expected.expectedSurfaceId;
      const ok = Boolean(
        group?.status === "satisfied"
        && exactControlSelected
        && semanticDispositionVerified
        && paidAlternativesSelected.length === 0
        && priceDidNotIncrease
        && ownedValidationErrors.length === 0
        && surfaceDismissed
      );
      return {
        ok,
        code: ok ? "EXACT_FREE_OPTION_VERIFIED" : "EXACT_FREE_OPTION_NOT_VERIFIED",
        message: ok
          ? "The exact canonical free/no-extra option is selected without a price increase or validation error."
          : "The decision is not proven to be the exact canonical free/no-extra selection.",
        evidence: {
          ...evidence,
          decisionGroup: group || null,
          observedDecisionGroups: (afterMap.decisionGroups || []).map((item) => ({
            decisionGroupId: item.decisionGroupId,
            sectionType: item.sectionType,
            sectionLabel: item.sectionLabel,
            status: item.status,
            selectedControlId: item.selectedControlId,
            selectedLabel: item.selectedLabel,
            alternatives: item.alternatives
          })),
          expectedControlId,
          selectedControlId,
          groupSelectedControlId,
          exactCommitment,
          exactControlSelected,
          semanticDispositionVerified,
          paidAlternativesSelected,
          beforePriceAmount: Number.isFinite(beforePriceAmount) ? beforePriceAmount : null,
          afterPriceAmount: Number.isFinite(afterPriceAmount) ? afterPriceAmount : null,
          priceDidNotIncrease,
          ownedValidationErrors,
          surfaceDismissed,
          currentSurface
        }
      };
    }
    if (expected.type === "requirement_status") {
      const activeSurfaceProgress = beforeMap.currentSurface?.label && beforeMap.currentSurface?.label !== afterMap.currentSurface?.label;
      const ok = logicalDecisionSatisfied || logicalControlSatisfied || (activeSurfaceProgress && !evidence.errors.length);
      return {
        ok,
        code: ok ? "REQUIREMENT_EVIDENCE_VERIFIED" : "REQUIREMENT_NOT_VERIFIED",
        message: ok
          ? `${expected.requirementId || expected.sectionLabel || "Requirement"} has evidence after the action.`
          : `${expected.requirementId || expected.sectionLabel || "Requirement"} is still missing evidence after the action.`,
        evidence: {
          ...evidence,
          decisionGroup: afterDecisionGroup || null,
          logicalDecisionSatisfied,
          control: afterControl || null,
          logicalControlSatisfied
        }
      };
    }
    if (expected.type === "active_surface_change") {
      const afterSurface = afterMap.currentSurface || {};
      const afterSurfaceSignature = `${afterSurface.type || ""}:${afterSurface.label || ""}:${(afterSurface.options || []).map((entry) => entry.id).join(",")}`;
      const beforeSurface = beforeMap.currentSurface || {};
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
    if (expected.type === "active_surface_dismissed") {
      const afterSurface = afterMap.currentSurface || {};
      const beforeSurface = beforeMap.currentSurface || {};
      const sameSurfaceId = expected.surfaceId && afterSurface.id === expected.surfaceId;
      const sameSurfaceLabel = normalizeMatchText(afterSurface.label || "") && normalizeMatchText(afterSurface.label || "") === normalizeMatchText(expected.surfaceLabel || "");
      const foregroundGone = !afterSurface.type || afterSurface.type === "page";
      const stepAdvanced = beforeMap.step !== afterMap.step || location.href !== (beforeMap.url || location.href);
      const ok = Boolean(stepAdvanced || foregroundGone || (!sameSurfaceId && !sameSurfaceLabel && (foregroundChanged || visualChanged || changed)));
      return {
        ok,
        code: ok ? "ACTIVE_SURFACE_DISMISSED" : "ACTIVE_SURFACE_STILL_PRESENT",
        message: ok ? "Foreground surface was dismissed or advanced." : "Foreground surface is still present after the action.",
        evidence: {
          ...evidence,
          expectedSurface: {
            id: expected.surfaceId || "",
            type: expected.surfaceType || "",
            label: expected.surfaceLabel || ""
          },
          afterSurface: {
            id: afterSurface.id || "",
            type: afterSurface.type || "page",
            label: afterSurface.label || ""
          }
        }
      };
    }
    if (expected.type === "stage_exit_or_feedback") {
      const errors = actionableCheckoutErrors(afterMap.errors || []);
      const blockers = stageExitBlockers(afterMap, expected);
      if (changed && beforeMap.step !== afterMap.step) {
        return { ok: true, code: "STAGE_CHANGED", message: `Stage changed to ${afterMap.step}.`, evidence };
      }
      if (progressMarkerChanged) {
        return { ok: true, code: "NAVIGATION_PROGRESS_CHANGED", message: "Navigation advanced the current progress marker.", evidence };
      }
      if (overlayAppeared || surfaceChanged) {
        return {
          ok: true,
          code: overlayAppeared ? "NAVIGATION_POPUP_APPEARED" : "NAVIGATION_SURFACE_CHANGED",
          message: overlayAppeared ? "Navigation produced a new foreground popup." : "Navigation changed the active surface.",
          evidence
        };
      }
      if (validationAppeared) {
        return {
          ok: true,
          code: "NAVIGATION_VALIDATION_APPEARED",
          message: "Navigation reached the page and produced fresh validation feedback.",
          evidence: { ...evidence, errors }
        };
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

  async function pushVerificationLedger(actionId, observationId, decision, expectedOutcome, verification) {
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
    await reportActionResult(executionResult);
    return executionResult;
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
    if (isOffscreen) {
      cursor.classList.remove("is-visible", "is-clicking");
      return;
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
    const hitTarget = document.elementFromPoint(
      Math.min(window.innerWidth - 2, Math.max(2, rect.left + rect.width / 2)),
      Math.min(window.innerHeight - 2, Math.max(2, rect.top + rect.height / 2))
    );
    const eventInit = {
      bubbles: true,
      cancelable: true,
      view: window,
      button: 0,
      buttons: 1,
      detail: 1,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      clientX: Math.round(rect.left + rect.width / 2),
      clientY: Math.round(rect.top + rect.height / 2)
    };
    logFlow("dom.click.dispatch", {
      meta,
      point: { x: eventInit.clientX, y: eventInit.clientY },
      target: elementDescriptor(element),
      hitTarget: elementDescriptor(hitTarget),
      pageBefore: pageSnapshot("before-click")
    });
    watchClickToFirstMutation("click", meta);
    element.dispatchEvent(new PointerEvent("pointerdown", eventInit));
    element.dispatchEvent(new MouseEvent("mousedown", eventInit));
    element.dispatchEvent(new PointerEvent("pointerup", { ...eventInit, buttons: 0 }));
    element.dispatchEvent(new MouseEvent("mouseup", { ...eventInit, buttons: 0 }));
    if (typeof element.click === "function") element.click();
    else element.dispatchEvent(new MouseEvent("click", { ...eventInit, buttons: 0 }));
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
    await showAgentThought(null, "Wait", "Watching page update", "Waiting for popups, dropdowns, validation, price/order changes, or URL changes.", 600);
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
      .filter((element) => element.id !== "atw-sidebar" && element.id !== "atw-agent-cursor" && element.id !== "atw-screenshot-annotations" && !element.classList?.contains("atw-section-outline"))
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
      .filter((element) => isVisible(element) && !element.closest("#atw-sidebar, #atw-agent-cursor, #atw-screenshot-annotations, .atw-section-outline"))
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
    const activeSurface = map.currentSurface || {};
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
        if (!isVisible(element) || element.closest("#atw-sidebar, #atw-agent-cursor, .atw-section-outline")) return false;
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
      .filter((element) => isVisible(element) && !element.closest("#atw-sidebar, #atw-agent-cursor, .atw-section-outline"))
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

  function surfaceActionElements(overlay) {
    if (!overlay) return [];
    const roots = [overlay];
    `${overlay.getAttribute?.("aria-owns") || ""} ${overlay.getAttribute?.("aria-controls") || ""}`
      .split(/\s+/)
      .filter(Boolean)
      .forEach((id) => {
        const root = document.getElementById(id);
        if (root && isVisible(root)) roots.push(root);
      });
    return roots
      .flatMap((root) => overlayButtons(root))
      .filter((element, index, list) => element && list.indexOf(element) === index);
  }

  function surfaceMembershipForElement(element, surface = {}) {
    if (!element) return { surfaceId: "", evidence: "missing_element" };
    if (!surface?.type || surface.type === "page") return { surfaceId: "surface-page", evidence: "page_surface" };
    const elementNodeId = elementId(element);
    const registeredIds = new Set([
      ...(surface.memberActuatorIds || []),
      ...(surface.options || []).flatMap((item) => [item.id, item.stateElementId, item.preferredActivationElementId]),
      ...(surface.buttons || []).flatMap((item) => [item.id, item.stateElementId, item.preferredActivationElementId])
    ].filter(Boolean));
    if (registeredIds.has(elementNodeId)) return { surfaceId: surface.id || "", evidence: "registered_surface_member" };
    const surfaceElement = surface.id ? elementById(surface.id) : null;
    if (surfaceElement && (surfaceElement === element || surfaceElement.contains(element))) {
      return { surfaceId: surface.id || "", evidence: "dom_descendant" };
    }
    const ownedIds = `${surfaceElement?.getAttribute?.("aria-owns") || ""} ${surfaceElement?.getAttribute?.("aria-controls") || ""}`
      .split(/\s+/)
      .filter(Boolean);
    if (ownedIds.some((id) => {
      const root = document.getElementById(id);
      return root && (root === element || root.contains(element));
    })) return { surfaceId: surface.id || "", evidence: "aria_owned_root" };
    const surfaceBox = surface.box;
    const targetBox = elementBox(element);
    if (surfaceBox && targetBox) {
      const centerX = Number(targetBox.centerX ?? (targetBox.x + targetBox.width / 2));
      const centerY = Number(targetBox.centerY ?? (targetBox.y + targetBox.height / 2));
      const visuallyContained = centerX >= Number(surfaceBox.x)
        && centerX <= Number(surfaceBox.x) + Number(surfaceBox.width)
        && centerY >= Number(surfaceBox.y)
        && centerY <= Number(surfaceBox.y) + Number(surfaceBox.height);
      // Geometry is supporting evidence only: background controls can sit
      // directly underneath an overlay and share its rectangle. Without DOM,
      // ARIA, or registered-member proof, visual overlap must not grant
      // foreground ownership.
      if (visuallyContained) return { surfaceId: "surface-page", evidence: "visual_overlap_unconfirmed" };
    }
    return { surfaceId: "surface-page", evidence: "background_page" };
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

  async function settleAndHandleInterrupts(context = "") {
    await showAgentThought(null, "Wait", "Letting the page react", `After ${context || "the last action"}: check modal, dropdown, loading, errors, disabled buttons, and DOM changes.`, 700);
    await waitForPaint(1200);
    const overlays = activeOverlayElements();
    if (overlays.length) {
      logAgentEvent("interrupt_detected", {
        context,
        overlays: overlays.map((overlay) => overlayText(overlay).slice(0, 160)).slice(0, 4)
      });
      const overlay = overlays[0];
      const activeSurface = buildActiveSurface([overlay]);
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
        "A popup/dropdown is active. I will send its canonical controls to the backend planner before taking another action.",
        650
      );
      return { blocked: false, handled: false, overlays: overlays.length, activeSurface };
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
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    let inViewport = centerX >= 0 && centerX <= window.innerWidth && centerY >= 0 && centerY <= window.innerHeight;
    for (let current = composedParent(element); inViewport && current && current !== document.body && current !== document.documentElement; current = composedParent(current)) {
      const style = getComputedStyle(current);
      const overflowX = style.overflowX || style.overflow || "visible";
      const overflowY = style.overflowY || style.overflow || "visible";
      if (!/(auto|scroll|overlay|hidden|clip)/.test(`${overflowX} ${overflowY}`)) continue;
      const containerRect = current.getBoundingClientRect();
      if (/(auto|scroll|overlay|hidden|clip)/.test(overflowX)) {
        inViewport = inViewport && centerX >= containerRect.left && centerX <= containerRect.right;
      }
      if (/(auto|scroll|overlay|hidden|clip)/.test(overflowY)) {
        inViewport = inViewport && centerY >= containerRect.top && centerY <= containerRect.bottom;
      }
    }
    return {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      centerX: Math.round(centerX),
      centerY: Math.round(centerY),
      inViewport
    };
  }

  function composedParent(element) {
    if (!element) return null;
    return element.parentElement || element.getRootNode?.()?.host || null;
  }

  function isEffectiveScrollContainer(element) {
    if (!element || element === document.body || element === document.documentElement) return false;
    const style = getComputedStyle(element);
    return /(auto|scroll|overlay)/.test(`${style.overflowY || ""} ${style.overflow || ""}`)
      && element.scrollHeight > element.clientHeight + 2;
  }

  function nearestEffectiveScrollContainer(element) {
    let current = composedParent(element);
    for (let depth = 0; current && depth < 24; depth += 1, current = composedParent(current)) {
      if (isEffectiveScrollContainer(current)) return current;
    }
    return document.scrollingElement || document.documentElement;
  }

  function scrollElementWithinNearestContainer(element, options = {}) {
    if (options.authority !== "governed_executor") {
      return { ok: false, code: "UNGOVERNED_SCROLL_BLOCKED", container: null, moved: false };
    }
    if (!element) return { ok: false, code: "TARGET_DISAPPEARED", container: null, moved: false };
    const container = nearestEffectiveScrollContainer(element);
    const behavior = options.behavior || "smooth";
    const amount = Number(options.amount || 0);
    const strategy = options.strategy === "nearest_container" ? "nearest_container" : "target_center";
    const documentScroller = container === document.scrollingElement
      || container === document.documentElement
      || container === document.body;
    const before = documentScroller ? Number(window.scrollY || 0) : Number(container.scrollTop || 0);
    if (strategy === "target_center") {
      element.scrollIntoView({ block: "center", inline: "nearest", behavior });
    } else {
      const targetBox = element.getBoundingClientRect();
      const viewportCenter = documentScroller
        ? window.innerHeight / 2
        : (() => {
            const containerBox = container.getBoundingClientRect();
            return containerBox.top + containerBox.height / 2;
          })();
      const centeredDelta = targetBox.top + targetBox.height / 2 - viewportCenter;
      if (documentScroller) window.scrollBy({ top: centeredDelta || amount, left: 0, behavior });
      else container.scrollBy({ top: centeredDelta || amount, left: 0, behavior });
    }
    const after = documentScroller ? Number(window.scrollY || 0) : Number(container.scrollTop || 0);
    return {
      ok: true,
      code: "SCROLL_DISPATCHED",
      container,
      containerId: documentScroller ? "document" : elementId(container),
      containerType: documentScroller ? "document" : "element",
      strategy,
      before,
      after,
      moved: after !== before
    };
  }

  async function waitForScrollSettle(element, options = {}) {
    const container = options.container || nearestEffectiveScrollContainer(element);
    const timeoutMs = Math.max(250, Number(options.timeoutMs || 3000));
    const quietMs = Math.max(80, Number(options.quietMs || 140));
    const documentScroller = container === document.scrollingElement
      || container === document.documentElement
      || container === document.body;
    const sample = () => {
      const rect = element?.getBoundingClientRect?.() || null;
      return {
        windowX: Number(window.scrollX || 0),
        windowY: Number(window.scrollY || 0),
        containerTop: documentScroller ? Number(window.scrollY || 0) : Number(container?.scrollTop || 0),
        targetX: Number(rect?.left || 0),
        targetY: Number(rect?.top || 0)
      };
    };
    const changed = (before, after) => Object.keys(before).some((key) => Math.abs(before[key] - after[key]) > 0.5);
    const startedAt = performance.now();
    let lastChangeAt = startedAt;
    let previous = sample();
    while (performance.now() - startedAt < timeoutMs) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const current = sample();
      if (changed(previous, current)) lastChangeAt = performance.now();
      previous = current;
      if (performance.now() - startedAt >= quietMs && performance.now() - lastChangeAt >= quietMs) {
        return {
          settled: true,
          timedOut: false,
          durationMs: Math.round(performance.now() - startedAt),
          targetInViewport: element ? elementBox(element).inViewport === true : false
        };
      }
    }
    return {
      settled: false,
      timedOut: true,
      durationMs: Math.round(performance.now() - startedAt),
      targetInViewport: element ? elementBox(element).inViewport === true : false
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

  function declineChoiceIntent(decision = {}) {
    const snapshot = decision.targetSnapshot || {};
    return decision.intent === "decline_optional_extra"
      || snapshot.semantic === "decline_paid_extra"
      || snapshot.semantic === "decline_baggage"
      || snapshot.semantic === "safe_decline"
      || snapshot.risk === "safe_decline";
  }

  function isStageExitDecision(decision = {}) {
    if (!["click", "click_xy", "keypress"].includes(decision.action)) return false;
    const snapshot = decision.targetSnapshot || {};
    return decision.intent === "navigate_stage"
      || snapshot.semantic === "continue"
      || snapshot.risk === "safe_continue";
  }

  function currentSurfaceEntries(surfaceOrMap) {
    const surface = surfaceOrMap?.currentSurface || surfaceOrMap || {};
    return [...(surface.options || []), ...(surface.buttons || [])]
      .filter((entry, index, list) => entry?.id && list.findIndex((item) => item?.id === entry.id) === index);
  }

  function inferSurfaceParentDecisionContext(overlay, sections = []) {
    const expandedControls = queryAllDeep("select, [role='combobox'], button, [role='button'], [aria-haspopup], [aria-controls], [aria-owns]")
      .filter((element) => isVisible(element) && !element.closest("#atw-sidebar, #atw-agent-cursor, .atw-section-outline"))
      .map((element) => {
        const owns = [element.getAttribute("aria-controls"), element.getAttribute("aria-owns")]
          .filter(Boolean)
          .flatMap((value) => String(value).split(/\s+/).filter(Boolean));
        const active = document.activeElement === element || element.contains(document.activeElement);
        const expanded = element.getAttribute("aria-expanded") === "true";
        const linkedToOverlay = owns.some((id) => {
          const owned = document.getElementById(id);
          return owned && (owned === overlay || overlay.contains(owned) || owned.contains(overlay));
        });
        const box = elementBox(element);
        const overlayBox = elementBox(overlay);
        const nearOverlay = Math.abs((box.centerX || 0) - (overlayBox.centerX || 0)) < Math.max(260, overlayBox.width || 0)
          && Math.abs((box.centerY || 0) - (overlayBox.centerY || 0)) < 420;
        let score = 0;
        if (linkedToOverlay) score += 100;
        if (active) score += 50;
        if (expanded) score += 35;
        if (nearOverlay) score += 15;
        return { element, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score);
    const parent = expandedControls[0]?.element || null;
    const section = parent
      ? (sections || []).find((item) => {
          const sectionElement = elementById(item.id) || item.element;
          return sectionElement && (sectionElement.contains(parent) || elementBelongsToSectionBand(parent, item, liveSectionModels(sections || [])));
        })
      : null;
    const sectionType = section?.type || "";
    const sectionLabel = section?.label || "";
    const overlayIsRepresentation = isTransientChoiceOverlay(overlay);
    const overlayId = elementId(overlay);
    const decisionGroupId = overlayIsRepresentation
      ? decisionGroupIdForContext({ sectionType, sectionLabel })
      : decisionGroupIdForContext({
          sectionType,
          sectionLabel,
          surfaceId: overlayId,
          surfaceType: "modal",
          stage: classifyStep(`${location.href} ${primaryPageText()}`),
          instance: overlayText(overlay).slice(0, 120)
        });
    return {
      parentControlId: parent?.dataset?.atwControlId || "",
      parentElementId: parent ? elementId(parent) : "",
      parentSectionId: section?.id || "",
      parentSectionType: sectionType,
      parentSectionLabel: sectionLabel,
      decisionGroupId
    };
  }

  function buildActiveSurface(overlays = activeOverlayElements(), sections = [], taskQueue = []) {
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
    const parentContext = inferSurfaceParentDecisionContext(overlay, sections);
    const options = surfaceActionElements(overlay).map((option) => {
      const label = overlayChoiceText(option);
      const box = elementBox(option);
      return {
        id: elementId(option),
        label,
        semantic: overlayOptionSemantic(label),
        risk: overlayOptionRisk(label),
        selected: isChoiceSelected(option) || option.getAttribute?.("aria-selected") === "true",
        decisionGroupId: parentContext.decisionGroupId || "",
        box,
        accessibility: accessibilityNode(option, map)
      };
    }).filter((option) => option.label && meaningfulActionBox(option.box));
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
      decisionGroupId: parentContext.decisionGroupId || "",
      parentControlId: parentContext.parentControlId || "",
      parentElementId: parentContext.parentElementId || "",
      parentSectionId: parentContext.parentSectionId || "",
      parentSectionType: parentContext.parentSectionType || "",
      parentSectionLabel: parentContext.parentSectionLabel || "",
      label: text.slice(0, 800),
      role,
      taskHint: parentContext.parentSectionType || "",
      options: prioritized,
      buttons: prioritized,
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
    const surface = {
      ...activeSurface,
      text: activeSurface.label || "",
      blocksBackground: true,
      isCurrent: true,
      taskQueue: [],
      backgroundTaskQueue: taskQueue,
      expectedResolution: surfaceLooksLikeSeatSkip(activeSurface) ? "waive_or_skip_seat_selection" : "resolve_active_surface",
      foreground: foregroundSurfaceState(activeSurface)
    };
    return {
      surfaceStack: [{ ...pageSurface, isCurrent: false, backgroundTaskQueue: [] }, surface],
      currentSurface: surface,
      backgroundTasks: surface.backgroundTaskQueue,
      currentSurfaceTasks: []
    };
  }

  function buildPageMap() {
    activeObservationElementRegistry = createObservationElementRegistry();
    activeObservationControlRegistry = null;
    const text = primaryPageText();
    const fullText = visiblePageText();
    const step = classifyStep(`${location.href} ${text} ${fullText.slice(0, 2500)}`);
    const fields = candidateInputs().map((input) => {
      const detected = detectField(input);
      const semantic = detected?.field || "unknown";
      const value = fieldValue(input);
      return {
        element: input,
        id: elementId(input),
        label: labelText(input),
        name: input.getAttribute("name") || "",
        placeholder: input.getAttribute("placeholder") || "",
        autocomplete: input.getAttribute("autocomplete") || "",
        inputMode: input.getAttribute("inputmode") || "",
        formatHint: [input.getAttribute("placeholder"), input.getAttribute("aria-label"), input.getAttribute("name")]
          .filter(Boolean).join(" ").slice(0, 180),
        options: input.tagName === "SELECT"
          ? [...input.options].map((option) => ({ value: option.value, label: compactText(option.textContent || option.label || option.value, 120) })).slice(0, 120)
          : [],
        box: elementBox(input),
        kind: input.type || input.tagName.toLowerCase(),
        role: implicitRole(input),
        field: semantic,
        semantic,
        required: input.required || /\*/.test(labelText(input)),
        value,
        hasValue: Boolean(value),
        confidence: detected?.confidence || 0,
        accessibility: accessibilityNode(input, null)
      };
    });
    const buttons = queryAllDeep("button, a, input[type='button'], input[type='submit'], [role='button'], [role='option'], [role='menuitem'], [role='checkbox'], [role='radio']")
      .filter((button) => isVisible(button) && !button.closest("#atw-sidebar") && !isPaymentField(button) && !isAuxiliaryNavigationAction(button) && meaningfulActionBox(elementBox(button)))
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
          risk: actionRisk(lower),
          accessibility: accessibilityNode(button, null)
        };
      });
    const paidChoices = collectPaidChoices(fullText);
    const price = priceFromText(fullText);
    const overlays = visibleOverlays();
    const sections = buildSectionModels(detectCheckoutSections(), fields, buttons);
    const taskQueue = buildTaskQueue(sections);
    const activeSurface = buildActiveSurface(activeOverlayElements(), sections, taskQueue);
    const controls = buildCanonicalControlGraph(sections, fields, buttons, activeSurface);
    const validationIssues = collectValidationIssues(text, fields, controls, sections, activeSurface);
    const errors = validationIssues.map((issue) => issue.message);
    const registryConflicts = activeObservationControlRegistry?.conflicts || [];
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
    const duplicateElementRekeys = activeObservationElementRegistry?.duplicateRekeys || [];
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
    const stageExit = buildStageExit(decisionGroups, fields, buttons, overlays, errors, step);
    const transactionFacts = transactionFactsEvidence({ step, price, decisionGroups, activeSurface });
    const map = {
      site: inferCheckoutSite(),
      step,
      text,
      fullText,
      coverage: pageCoverage(),
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
      graphIntegrity,
      decisionGroups,
      sections,
      taskQueue,
      stageExit,
      summary: {
        fields: fields.length,
        knownFields: fields.filter((field) => field.field !== "unknown").length,
        buttons: buttons.length,
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

  function collectValidationIssues(pageText, fields = [], controls = [], sections = [], activeSurface = {}) {
    const step = classifyStep(pageText);
    if (["extras", "seats", "payment", "confirmation"].includes(step)) {
      return [];
    }
    const issues = [];
    const referencedErrorIds = new Set(fields
      .flatMap((field) => `${field.element?.getAttribute?.("aria-errormessage") || ""} ${field.element?.getAttribute?.("aria-describedby") || ""}`.split(/\s+/))
      .filter(Boolean));
    const visibleText = queryAllDeep("body *")
      .filter((element) => isVisible(element) && !element.closest("#atw-sidebar"))
      .map((element) => ({
        element,
        text: (element.innerText || element.textContent || "").trim()
      }))
      .filter((entry) => entry.text)
      .filter(({ element }) => {
        if (referencedErrorIds.has(element.id) || element.matches?.("[role='alert'], [aria-live='assertive']")) return true;
        return ![...element.children].some((child) => {
          if (!isVisible(child)) return false;
          const childText = (child.innerText || child.textContent || "").trim().toLowerCase();
          return childText && VALIDATION_TERMS.some((term) => childText.includes(term));
        });
      });

    const issueOwnership = (element) => {
      const errorId = element.id || "";
      const directlyOwnedField = fields.find((field) => {
        const input = field.element;
        const references = `${input?.getAttribute?.("aria-errormessage") || ""} ${input?.getAttribute?.("aria-describedby") || ""}`
          .split(/\s+/)
          .filter(Boolean);
        return errorId && references.includes(errorId);
      });
      const containingSection = sections.find((section) => section.element?.contains?.(element));
      const semanticSectionElement = element.closest?.("section, fieldset, form, [role='group'], [role='region']") || null;
      const semanticSectionLabel = semanticSectionElement
        ? compactText(
            semanticSectionElement.querySelector?.("h1, h2, h3, legend, [aria-label]")?.textContent
              || semanticSectionElement.getAttribute?.("aria-label")
              || "",
            160
          )
        : "";
      const semanticSectionType = semanticSectionElement
        ? sectionTypeFor(semanticSectionLabel, compactText(semanticSectionElement.innerText || semanticSectionElement.textContent || "", 500))
        : "";
      const surfaceElement = activeSurface.id ? elementById(activeSurface.id) : null;
      const inSurface = Boolean(surfaceElement?.contains?.(element));
      let nearestField = directlyOwnedField || null;
      if (!nearestField && containingSection) {
        const errorBox = elementBox(element);
        nearestField = fields
          .filter((field) => containingSection.element?.contains?.(field.element))
          .map((field) => ({
            field,
            distance: Math.abs(Number(field.box?.centerY || 0) - Number(errorBox.centerY || 0))
              + Math.abs(Number(field.box?.centerX || 0) - Number(errorBox.centerX || 0)) * 0.25
          }))
          .filter((entry) => entry.distance < 260)
          .sort((left, right) => left.distance - right.distance)[0]?.field || null;
      }
      const control = nearestField
        ? controls.find((item) => item.controlId === nearestField.controlId || item.stateElementId === nearestField.id)
        : null;
      const stageWide = !control && !containingSection && !inSurface && Boolean(
        element.matches?.("[role='alert'], [aria-live='assertive']")
        || /error-summary|validation-summary|alert-banner|error-banner/i.test(element.className || "")
      );
      return {
        controlId: control?.controlId || nearestField?.controlId || "",
        semanticType: control?.semantic || nearestField?.field || "",
        sectionId: control?.sectionId || containingSection?.id || (semanticSectionElement ? elementId(semanticSectionElement) : ""),
        sectionType: control?.sectionType || containingSection?.type || (semanticSectionType === "unknown" ? "" : semanticSectionType),
        surfaceId: inSurface ? activeSurface.id || "" : "",
        stageWide
      };
    };

    const addIssue = (message, element = null, explicitOwner = {}) => {
      const normalizedMessage = String(message || "").replace(/\s+/g, " ").trim();
      if (!normalizedMessage) return;
      const owner = element ? issueOwnership(element) : {};
      const issue = {
        issueId: element ? `validation:${elementId(element)}` : `validation:${explicitOwner.controlId || explicitOwner.semanticType || issues.length}`,
        message: normalizedMessage,
        controlId: explicitOwner.controlId || owner.controlId || "",
        semanticType: explicitOwner.semanticType || owner.semanticType || "",
        sectionId: explicitOwner.sectionId || owner.sectionId || "",
        sectionType: explicitOwner.sectionType || owner.sectionType || "",
        surfaceId: explicitOwner.surfaceId || owner.surfaceId || "",
        stageWide: explicitOwner.stageWide === true || owner.stageWide === true
      };
      const duplicate = issues.some((existing) => (
        existing.message === issue.message
        && existing.controlId === issue.controlId
        && existing.sectionId === issue.sectionId
        && existing.surfaceId === issue.surfaceId
      ));
      if (!duplicate) issues.push(issue);
    };

    for (const { element, text } of visibleText) {
      const normalized = text.toLowerCase();
      if (normalized.length > 180) continue;
      if (/^\*?\s*field required\.?$/.test(normalized)) continue;
      if (/^passenger\s+\d+,\s*(adult|child|infant)\s+\*?field required\.?$/.test(normalized)) continue;
      if (/please enter your name and surname exactly/.test(normalized)) continue;
      if (VALIDATION_TERMS.some((term) => normalized.includes(term)) && /must enter|too long|too short|invalid|not valid|error|you must|required.+field|field.+required/.test(normalized)) {
        addIssue(text, element);
      }
      if (issues.length >= 12) break;
    }

    const emailInputs = candidateInputs().filter((input) => labelText(input).includes("email"));
    const confirmEmail = emailInputs.find((input) => labelText(input).includes("confirm"));
    if (confirmEmail && !confirmEmail.value) {
      const field = fields.find((item) => item.element === confirmEmail);
      const control = controls.find((item) => item.controlId === field?.controlId || item.stateElementId === field?.id);
      addIssue("confirm email is empty", confirmEmail, {
        controlId: control?.controlId || field?.controlId || "",
        semanticType: "confirm_email"
      });
    }

    const titleAreaVisible = document.body.innerText.toLowerCase().includes("title *") || document.body.innerText.toLowerCase().includes("you must enter a gender");
    const anyTitleChecked = queryAllDeep("input[type='radio']")
      .filter((radio) => /mr|mrs|ms|title|gender/.test(labelText(radio)))
      .some((radio) => radio.checked);
    if (titleAreaVisible && !anyTitleChecked && !travelerValue("title")) {
      const titleField = fields.find((field) => ["title", "gender"].includes(field.field));
      const titleControl = controls.find((control) => control.controlId === titleField?.controlId || control.stateElementId === titleField?.id);
      addIssue("title/gender is required but no traveler title preference is saved", titleField?.element || null, {
        controlId: titleControl?.controlId || titleField?.controlId || "",
        semanticType: titleField?.field || "title",
        sectionId: titleControl?.sectionId || "",
        sectionType: titleControl?.sectionType || ""
      });
    }

    return issues;
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

  function firstFieldFor(map, fieldType) {
    return map.fields.find((field) => field.field === fieldType && field.element && field.element.type !== "radio" && field.element.type !== "checkbox");
  }

  function liveSectionForElement(map, element) {
    if (!element) return null;
    const sections = liveSectionModels(map.sections || []);
    return sections.find((section) => elementBelongsToSectionBand(element, section, sections)) || null;
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

  function uniqueControlIds(items = []) {
    return [...new Set(items.map((item) => typeof item === "string" ? item : item?.controlId).filter(Boolean))];
  }

  function compactSurfaceReference(surface = {}) {
    return {
      id: surface.id || "",
      type: surface.type || "page",
      label: surface.label || "",
      role: surface.role || "",
      taskHint: surface.taskHint || "",
      blocksBackground: Boolean(surface.blocksBackground),
      parentSurfaceId: surface.parentSurfaceId || "",
      observationId: surface.observationId || "",
      memberControlIds: uniqueControlIds(surface.memberControlIds || surface.controlIds || surface.options || []),
      memberActuatorIds: [...new Set(surface.memberActuatorIds || [])].filter(Boolean),
      foreground: surface.foreground || surface.visualState?.foreground || null
    };
  }

  function compactPageMap(map) {
    // Section and task summaries are local diagnostics. The governed backend
    // receives canonical controls, decision groups, surfaces, and field/error
    // evidence; it never receives remembered section completion or task status.
    const aliasIndex = buildCanonicalAliasIndex(map);
    const graphIntegrity = {
      ...(map.graphIntegrity || {}),
      ok: map.graphIntegrity?.ok !== false && aliasIndex.conflicts.length === 0,
      aliasConflictCount: aliasIndex.conflicts.length,
      aliasConflicts: aliasIndex.conflicts.slice(0, 12)
    };
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
      text: map.text || map.fullText,
      snapshotHash: observationHashForMap(map),
      graphIntegrity,
      transactionFacts: map.transactionFacts || null,
      controlAliases: aliasIndex.entries,
      price: map.price || null,
      priceText: map.priceText || map.summary?.priceText || "",
      foreground: map.foreground || foregroundSurfaceState(map.currentSurface || {}),
      accessibility: map.accessibility ? {
        foregroundSurfaceId: map.accessibility.foregroundSurfaceId,
        foregroundSurfaceType: map.accessibility.foregroundSurfaceType,
        landmarkCount: map.accessibility.landmarkCount,
        controlIds: uniqueControlIds(map.accessibility.controls || [])
      } : null,
      controls: (map.controls || []).map((control) => ({
        controlId: control.controlId,
        stableKey: control.stableKey || "",
        meaning: control.meaning || control.semantic || "",
        structuredPrice: control.structuredPrice || null,
        visualRef: control.visualRef || "",
        decisionGroupId: control.decisionGroupId || "",
        label: control.label,
        accessibleName: control.accessibleName,
        kind: control.kind,
        field: control.field || "",
        role: control.role,
        domRole: control.domRole || "",
        semantic: control.semantic,
        risk: control.risk,
        state: control.state,
        currentValue: control.currentValue || "",
        capabilities: control.capabilities || [],
        selected: Boolean(control.selected),
        required: Boolean(control.required),
        hasValue: Boolean(control.hasValue || control.state?.valuePresent || control.controlState?.valuePresent),
        sectionId: control.sectionId,
        sectionType: control.sectionType,
        sectionLabel: control.sectionLabel,
        surfaceId: control.surfaceId,
        surfaceType: control.surfaceType,
        surfaceLabel: control.surfaceLabel,
        stateElementId: control.stateElementId,
        preferredActivationElementId: control.preferredActivationElementId,
        operations: control.operations || {},
        recovery: control.recovery || {},
        visualRegions: control.visualRegions || [],
        actuators: (control.actuators || []).map((item) => ({
          nodeId: item.nodeId,
          relation: item.relation,
          role: item.role,
          label: item.label,
          box: item.box
        })).slice(0, 8),
        visualRegion: control.visualRegion
      // Preserve the whole canonical page for local/server compression. The
      // model never receives this raw registry; seat cells are aggregated by
      // observation-markdown before any model call.
      })),
      decisionGroups: (map.decisionGroups || []).map((group) => ({
        decisionGroupId: group.decisionGroupId,
        sectionId: group.sectionId,
        sectionType: group.sectionType,
        sectionLabel: group.sectionLabel,
        requirementId: group.requirementId,
        required: Boolean(group.required),
        status: group.status,
        selectedControlId: group.selectedControlId,
        selectedLabel: group.selectedLabel,
        selectedSemantic: group.selectedSemantic,
        alternativeControlIds: uniqueControlIds(group.alternatives || []),
        evidence: (group.evidence || []).slice(0, 5)
      })),
      errors: actionableCheckoutErrors(map.errors),
      validationIssues: (map.validationIssues || []).map((issue) => ({
        issueId: issue.issueId || "",
        message: issue.message || "",
        controlId: issue.controlId || "",
        semanticType: issue.semanticType || "",
        sectionId: issue.sectionId || "",
        sectionType: issue.sectionType || "",
        surfaceId: issue.surfaceId || "",
        stageWide: Boolean(issue.stageWide)
      })).slice(0, 12),
      paidChoices: map.paidChoices,
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
        controlIds: uniqueControlIds([
          ...(section.fields || []),
          ...(section.choices || []),
          ...(section.buttons || [])
        ]),
        box: section.box,
        text: section.text
      })),
      stageExit: map.stageExit || {},
      summary: map.summary,
      coverage: map.coverage,
      currentSurface: compactSurfaceReference(map.currentSurface || {
        type: "page",
        id: "surface-page",
        label: "",
        taskQueue: []
      }),
      surfaceStack: (map.surfaceStack || []).map(compactSurfaceReference),
      overlays: (map.overlays || []).map((overlay) => ({
        id: overlay.id,
        label: overlay.label,
        box: overlay.box,
        role: overlay.role
      })),
      screenshotAnnotations: (map.screenshotAnnotations || []).map((annotation) => ({
        visualRef: annotation.visualRef || "",
        controlId: annotation.controlId || "",
        decisionGroupId: annotation.decisionGroupId || "",
        box: annotation.box || null
      }))
    };
  }

  function annotationBox(item = {}) {
    const box = item.visualRegion || item.box || null;
    if (box?.width > 0 && box?.height > 0) return box;
    const id = item.preferredActivationElementId || item.stateElementId || item.id || "";
    const element = id ? elementById(id) : null;
    return element && isVisible(element) ? elementBox(element) : null;
  }

  function annotationPrefix(item = {}) {
    const kind = normalizeMatchText(`${item.kind || ""} ${item.role || ""} ${item.field || ""} ${item.semantic || ""} ${item.risk || ""}`);
    if (/\b(field|input|textbox|textarea|select|combobox|email|phone|name|date)\b/.test(kind)) return "F";
    if (/\b(button|continue|next|close|back|submit)\b/.test(kind)) return "B";
    if (/\b(choice|radio|checkbox|option|listbox|decline|extra|seat|baggage|bundle|insurance)\b/.test(kind)) return "O";
    return "C";
  }

  function annotationLabel(item = {}) {
    return compactText(item.label || item.accessibleName || item.field || item.semantic || item.id || item.controlId || "", 90);
  }

  function addScreenshotAnnotationCandidate(groups, item, source) {
    if (!item) return;
    const box = annotationBox(item);
    if (!box?.inViewport || !meaningfulActionBox(box)) return;
    if (box.x > window.innerWidth || box.y > window.innerHeight || box.x + box.width < 0 || box.y + box.height < 0) return;
    const key = item.annotationKey || item.controlId || item.id || item.stateElementId || item.preferredActivationElementId || "";
    if (!key) return;
    const existing = groups.get(key) || {
      key,
      items: [],
      box: null,
      label: "",
      prefix: item.prefix || annotationPrefix(item),
      targetId: item.id || item.preferredActivationElementId || item.stateElementId || "",
      controlId: item.controlId || "",
      decisionGroupId: item.decisionGroupId || "",
      kind: item.kind || item.field || item.role || "",
      role: item.role || "",
      semantic: item.semantic || "",
      risk: item.risk || "",
      selected: Boolean(item.selected),
      required: Boolean(item.required),
      source
    };
    existing.items.push(item);
    existing.box = unionBoxes([existing.box, box].filter(Boolean)) || box;
    existing.label = existing.label || annotationLabel(item);
    existing.targetId = existing.targetId || item.id || item.preferredActivationElementId || item.stateElementId || "";
    existing.controlId = existing.controlId || item.controlId || "";
    existing.decisionGroupId = existing.decisionGroupId || item.decisionGroupId || "";
    existing.kind = existing.kind || item.kind || item.field || item.role || "";
    existing.role = existing.role || item.role || "";
    existing.semantic = existing.semantic || item.semantic || "";
    existing.risk = existing.risk || item.risk || "";
    existing.selected = existing.selected || Boolean(item.selected);
    existing.required = existing.required || Boolean(item.required);
    groups.set(key, existing);
  }

  function assignVisualRefToAliases(map, group) {
    const matches = (item) => item && (
      (group.controlId && item.controlId === group.controlId)
      || (group.targetId && item.id === group.targetId)
      || (group.targetId && item.stateElementId === group.targetId)
      || (group.targetId && item.preferredActivationElementId === group.targetId)
    );
    const touch = (item) => {
      if (matches(item)) item.visualRef = group.visualRef;
    };
    (map.controls || []).forEach(touch);
    (map.fields || []).forEach(touch);
    (map.buttons || []).forEach(touch);
    (map.sections || []).forEach((section) => {
      (section.choices || []).forEach(touch);
      (section.fields || []).forEach(touch);
      (section.buttons || []).forEach(touch);
    });
    [map.currentSurface].filter(Boolean).forEach((surface) => {
      (surface.options || []).forEach(touch);
      (surface.buttons || []).forEach(touch);
    });
    (map.accessibility?.controls || []).forEach(touch);
    (map.decisionGroups || []).forEach((decisionGroup) => {
      (decisionGroup.alternatives || []).forEach(touch);
    });
  }

  function prepareScreenshotAnnotations(map, observationId = agent.activeObservationId || "") {
    const groups = new Map();
    const addList = (items, source) => (items || []).forEach((item) => addScreenshotAnnotationCandidate(groups, item, source));
    const finalControls = (map.controls || []).filter((control) => control?.controlId);
    const controlsById = new Map(finalControls.map((control) => [control.controlId, control]));
    (map.controls || []).forEach((control) => {
      (control.recovery?.open?.regions || []).forEach((region, index) => {
        const canonicalRegion = normalizeVisualRegionContract(region, {
          observationId,
          controlId: control.controlId,
          operation: "open",
          source: "control.recovery.open",
          surfaceId: control.surfaceId || ""
        });
        Object.assign(region, canonicalRegion);
        addScreenshotAnnotationCandidate(groups, {
          annotationKey: `recovery:${control.controlId}:open:${index}`,
          controlId: control.controlId,
          decisionGroupId: control.decisionGroupId || "",
          label: `${control.label || control.semantic || "Control"} open region`,
          kind: "visual_recovery",
          role: "visual_region",
          semantic: control.semantic || "",
          risk: "safe",
          prefix: "R",
          visualRegion: canonicalRegion
        }, "control.recovery.open");
      });
    });
    // Screenshot grounding is a projection of the finalized canonical
    // registry. Copied field/section/surface models can retain identities for
    // controls that lost ownership during registry reconciliation, so they are
    // intentionally not annotation sources.
    addList(finalControls, "control");

    const counters = { B: 0, F: 0, O: 0, C: 0 };
    const annotations = [...groups.values()]
      .filter((group) => {
        const control = controlsById.get(group.controlId);
        if (!control) return false;
        if (!group.targetId) return group.source === "control.recovery.open";
        return controlMemberNodeIds(control).includes(group.targetId)
          || group.targetId === control.controlId;
      })
      .filter((group) => group.box?.width > 0 && group.box?.height > 0)
      .sort((a, b) => (a.box.y - b.box.y) || (a.box.x - b.box.x))
      .slice(0, 80)
      .map((group) => {
        const prefix = group.prefix || "C";
        counters[prefix] = (counters[prefix] || 0) + 1;
        const visualRef = `${prefix}${counters[prefix]}`;
        const annotation = {
          visualRef,
          targetId: group.targetId,
          controlId: group.controlId,
          decisionGroupId: group.decisionGroupId,
          label: group.label,
          kind: group.kind,
          role: group.role,
          semantic: group.semantic,
          risk: group.risk,
          selected: group.selected,
          required: group.required,
          source: group.source,
          box: group.box
        };
        group.visualRef = visualRef;
        group.items.forEach((item) => { item.visualRef = visualRef; });
        assignVisualRefToAliases(map, group);
        return annotation;
      });
    map.screenshotAnnotations = annotations;
    return annotations;
  }

  function clearScreenshotAnnotationOverlay() {
    document.getElementById("atw-screenshot-annotations")?.remove();
  }

  function renderScreenshotAnnotationOverlay(annotations = []) {
    clearScreenshotAnnotationOverlay();
    const visibleAnnotations = (annotations || []).filter((item) => item.box?.inViewport).slice(0, 80);
    if (!visibleAnnotations.length) return null;
    const root = document.createElement("div");
    root.id = "atw-screenshot-annotations";
    root.setAttribute("aria-hidden", "true");
    Object.assign(root.style, {
      position: "fixed",
      inset: "0",
      pointerEvents: "none",
      zIndex: "2147483646",
      fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif"
    });
    for (const item of visibleAnnotations) {
      const box = item.box;
      const outline = document.createElement("div");
      Object.assign(outline.style, {
        position: "absolute",
        left: `${Math.max(0, Math.min(window.innerWidth - 4, box.x))}px`,
        top: `${Math.max(0, Math.min(window.innerHeight - 4, box.y))}px`,
        width: `${Math.max(8, Math.min(window.innerWidth, box.width))}px`,
        height: `${Math.max(8, Math.min(window.innerHeight, box.height))}px`,
        border: "2px solid rgba(14, 132, 255, 0.95)",
        boxShadow: "0 0 0 2px rgba(255,255,255,0.9), 0 0 14px rgba(14,132,255,0.65)",
        borderRadius: "4px",
        boxSizing: "border-box"
      });
      const tag = document.createElement("div");
      tag.textContent = `[${item.visualRef}]`;
      Object.assign(tag.style, {
        position: "absolute",
        left: `${Math.max(4, Math.min(window.innerWidth - 56, box.x))}px`,
        top: `${Math.max(4, Math.min(window.innerHeight - 24, box.y - 24))}px`,
        padding: "2px 6px",
        borderRadius: "5px",
        background: "rgba(6, 20, 38, 0.94)",
        color: "#fff",
        border: "1px solid rgba(255,255,255,0.8)",
        fontSize: "12px",
        fontWeight: "800",
        lineHeight: "16px",
        letterSpacing: "0"
      });
      root.append(outline, tag);
    }
    document.documentElement.appendChild(root);
    return root;
  }

  async function captureVisibleScreenshot(annotations = []) {
    const overlay = renderScreenshotAnnotationOverlay(annotations);
    try {
      if (overlay) await waitForPaint(60);
      const response = await chrome.runtime.sendMessage({ type: "ATW_CAPTURE_VISIBLE_TAB" });
      if (!response?.ok) {
        logAgentEvent("screenshot", { ok: false, error: response?.error || "unavailable" });
        return "";
      }
      logAgentEvent("screenshot", { ok: true, bytes: response.dataUrl.length, annotations: annotations.length });
      return response.dataUrl;
    } catch (error) {
      logAgentEvent("screenshot", { ok: false, error: error.message });
      return "";
    } finally {
      clearScreenshotAnnotationOverlay();
    }
  }

  function observationTransportBytes(payload = {}) {
    return new Blob([JSON.stringify(payload)]).size;
  }

  function smallerObservationTransport(payload = {}) {
    const page = payload.page || {};
    return {
      ...payload,
      transportMode: "compact_retry",
      page: {
        ...page,
        text: compactText(page.text || "", 2_000),
        foreground: page.foreground ? {
          kind: page.foreground.kind || "",
          label: page.foreground.label || "",
          surfaceId: page.foreground.surfaceId || "",
          progressMarkers: page.foreground.progressMarkers || null
        } : null,
        coverage: page.coverage ? {
          controlCount: page.controls?.length || 0,
          sectionCount: page.sections?.length || 0
        } : null,
        summary: page.summary ? {
          title: compactText(page.summary.title || "", 200),
          priceText: compactText(page.summary.priceText || "", 80)
        } : null
      }
    };
  }

  async function uploadObservationScreenshot(apiBase, { sessionId, observationId, screenshotDataUrl, signal }) {
    if (!screenshotDataUrl) return "";
    const response = await fetch(`${apiBase}/agent/screenshot`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal,
      body: JSON.stringify({ sessionId, observationId, screenshotDataUrl })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.screenshotId) {
      const error = new Error(body.error || `screenshot upload returned ${response.status}`);
      error.code = body.code || "SCREENSHOT_UPLOAD_FAILED";
      error.retryable = body.retryable === true;
      throw error;
    }
    return body.screenshotId;
  }

  async function postObservationWithSizeRecovery(apiBase, payload, signal) {
    let outgoing = payload;
    let bytes = observationTransportBytes(outgoing);
    if (bytes > MAX_OBSERVATION_TRANSPORT_BYTES) {
      outgoing = smallerObservationTransport(outgoing);
      bytes = observationTransportBytes(outgoing);
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetch(`${apiBase}/agent/next-action`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal,
        body: JSON.stringify(outgoing)
      });
      if (response.ok) return { response, bytes, transportMode: outgoing.transportMode || "canonical" };
      const body = await response.json().catch(() => ({}));
      if (body.code === "OBSERVATION_TOO_LARGE" && body.retryable === true && attempt === 0) {
        outgoing = smallerObservationTransport(outgoing);
        bytes = observationTransportBytes(outgoing);
        continue;
      }
      const error = new Error(body.error || `agent returned ${response.status}`);
      error.code = body.code || `HTTP_${response.status}`;
      error.retryable = body.retryable === true;
      throw error;
    }
    throw Object.assign(new Error("Observation transport retry exhausted."), {
      code: "OBSERVATION_TOO_LARGE",
      retryable: true
    });
  }

  async function requestAgentDecision(map, userMessage = "", clientLatency = {}, loopToken = {}) {
    const turnId = nextFlowId("turn");
    const observationId = nextFlowId("obs");
    if (agent.activePlannerRequest) {
      logFlow("backend.request.duplicate_suppressed", {
        turnId,
        observationId,
        activeTurnId: agent.activePlannerRequest.turnId,
        activeObservationId: agent.activePlannerRequest.observationId
      });
      agent.loopRerunQueued = true;
      return null;
    }
    const request = {
      turnId,
      observationId,
      loopRunId: loopToken.loopRunId || agent.activeLoopRunId,
      lifecycleId: loopToken.lifecycleId ?? agent.lifecycleId,
      controller: new AbortController()
    };
    agent.activePlannerRequest = request;
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
      const screenshotAnnotations = prepareScreenshotAnnotations(map, observationId);
      const screenshotStartedAt = performance.now();
      const screenshotDataUrl = await captureVisibleScreenshot(screenshotAnnotations);
      const screenshotCaptureMs = Math.round(performance.now() - screenshotStartedAt);
      const apiBase = settings.apiBase || DEFAULT_API;
      const screenshotId = await uploadObservationScreenshot(apiBase, {
        sessionId: agent.sessionId,
        observationId,
        screenshotDataUrl,
        signal: request.controller.signal
      });
      logFlow("backend.request.send", {
        turnId,
        api: `${settings.apiBase || DEFAULT_API}/agent/next-action`,
        screenshotBytes: screenshotDataUrl.length,
        screenshotAnnotations: screenshotAnnotations.length,
        observation_build_ms: clientLatency.observation_build_ms ?? null,
        screenshot_capture_ms: screenshotCaptureMs,
        currentSurface: map.currentSurface ? {
          type: map.currentSurface.type,
          taskHint: map.currentSurface.taskHint,
          options: (map.currentSurface.options || []).map((option) => ({
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
      const canonicalPage = compactPageMap(map);
      const observationPayload = {
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
        // whether the last action actually worked from fresh browser evidence.
	      lastActionResult: agent.lastActionResult || agent.actionHistory[agent.actionHistory.length - 1] || null,
        page: {
          ...canonicalPage,
          screenshotId,
          screenshotAnnotations: screenshotAnnotations.map((annotation) => ({
            visualRef: annotation.visualRef || "",
            controlId: annotation.controlId || "",
            decisionGroupId: annotation.decisionGroupId || "",
            box: annotation.box || null
          }))
        }
      };
      const transport = await postObservationWithSizeRecovery(apiBase, observationPayload, request.controller.signal);
      const response = transport.response;
      const decision = await response.json();
      if (!agent.sessionId || !decision.sessionId || decision.sessionId !== agent.sessionId) {
        throw new Error("backend did not preserve the active durable checkout session");
      }
      if (!plannerRequestIsCurrent(request)) {
        logFlow("backend.response.stale_ignored", {
          turnId,
          observationId,
          decisionObservationId: decision.observationId || "",
          decisionActionId: decision.actionId || decision.id || "",
          activeTurnId: agent.activePlannerRequest?.turnId || "",
          activeObservationId: agent.activePlannerRequest?.observationId || "",
          lifecycleId: agent.lifecycleId,
          requestLifecycleId: request.lifecycleId
        });
        return null;
      }
      const requestUploadMs = Math.round(performance.now() - requestStartedAt);
      logFlow("backend.request.transport", {
        turnId,
        observationId,
        screenshotId,
        observationBytes: transport.bytes,
        transportMode: transport.transportMode
      });
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
        decisionGroupId: decision.decisionGroupId || decision.targetSnapshot?.decisionGroupId || "",
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
          decisionGroupId: decision.decisionGroupId || decision.targetSnapshot?.decisionGroupId || "",
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
      if (error?.name === "AbortError" || request.controller.signal.aborted) {
        logFlow("backend.request.aborted", {
          turnId,
          observationId,
          reason: String(request.controller.signal.reason || error.message || "aborted")
        });
        return null;
      }
      if (error?.code === "OBSERVATION_TOO_LARGE" && error.retryable === true) {
        logFlow("backend.observation_too_large_retry", {
          turnId,
          observationId,
          code: error.code,
          reason: error.message
        });
        agent.loopRerunQueued = true;
        setAgentActivity("Rebuilding page observation", "The browser payload was oversized; retrying with the compact transport.");
        return null;
      }
      const contextInvalidated = /extension context invalidated|context invalidated|receiving end does not exist/i.test(error.message || "");
      const backendFailure = error?.code === "BACKEND_INTERNAL_ERROR" || /^HTTP_5\d\d$/.test(error?.code || "");
      const decision = {
        source: "system",
        action: "stop",
        targetId: "",
        value: "",
        message: contextInvalidated
          ? "Chrome invalidated the extension context after reload. Refresh this checkout tab, then start the agent again."
          : backendFailure
            ? `Agent backend error: ${error.message}. No browser action was dispatched.`
          : `AI agent unavailable: ${error.message}. I stopped because AI-only mode is enabled.`,
        needsApproval: true,
        risk: "uncertain",
        reason: contextInvalidated
          ? "Extension lifecycle error: this page is still running the old content script after extension reload."
          : backendFailure
            ? "The backend failed while processing the current observation; this is separate from AI service availability."
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
        decisionGroupId: decision.decisionGroupId || decision.targetSnapshot?.decisionGroupId || "",
        targetId: decision.targetId,
        targetSnapshot: decision.targetSnapshot || null,
        expectedOutcome: decision.expectedOutcome || null,
        risk: decision.risk,
        needsApproval: decision.needsApproval,
        message: decision.message,
        reason: decision.reason
      });
      logFlow(contextInvalidated ? "extension.context_invalidated" : backendFailure ? "backend.processing_error" : "backend.error", { turnId, error: error.message, code: error.code || "", decision });
      return decision;
    } finally {
      if (agent.activePlannerRequest === request) agent.activePlannerRequest = null;
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
    const governedDecision = options.decision || { action: "stop", reason: "Missing governed navigation decision." };
    const expectedOutcome = options.expectedOutcome || expectedOutcomeForDecision(governedDecision, beforeMap, element);
    addAgentMessage("assistant", `Clicking: ${label}.`);
    await showAgentThought(element, "Exit", `Act: click ${label}`, "Checking whether the page advances.");
    flashElement(element);
    pushActionLedger({
      actionId: options.actionId || agent.activeExecutionActionId || nextFlowId("act"),
      observationId: options.observationId || agent.activeExecutionObservationId || agent.activeObservationId || "",
      stage: "dispatched",
      action: governedDecision,
      targetFingerprint: targetFingerprint(element, governedDecision)
    });
    userLikeClick(element);
    await waitForUiSettle(700);
    await sleep(delay);
    let afterMap = rememberPagePlan(buildPageMap());
    const verification = verifyExpectedOutcome(expectedOutcome, beforeMap, afterMap, element);
    let advanced = verification.ok;
    agent.pageMap = afterMap;
    setAgentActivity(advanced ? `Advanced to ${afterMap.step.replace(/_/g, " ")}` : `${label} did not advance`, advanced ? "Reading the next page state" : "Looking for the remaining blocker");
    await pushVerificationLedger(
      options.actionId || agent.activeExecutionActionId || nextFlowId("act"),
      options.observationId || agent.activeExecutionObservationId || agent.activeObservationId || "",
      governedDecision,
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
    await reportActionResult({
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
      const staleOutcome = {
        ok: false,
        code: "OBSERVATION_HASH_MISMATCH",
        reason: "The page materially changed before execution.",
        expectedHash: decision.observationHash || "",
        currentHash: currentObservation.snapshotHash || ""
      };
      const staleResult = rememberUnexecutedActionResult(
        actionId,
        actionObservationId,
        decision,
        staleOutcome
      );
      pushActionLedger({
        actionId,
        observationId: actionObservationId,
        stage: "rejected",
        action: decision,
        observationHash: actionObservationHash,
        result: staleOutcome
      });
      logFlow("execute.stale_observation", {
        actionId,
        observationId: actionObservationId,
        expectedHash: decision.observationHash || "",
        currentHash: currentObservation.snapshotHash || "",
        before: observation,
        current: currentObservation
      });
      await reportActionResult(staleResult);
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

    if (decision.risk !== "safe" && decision.needsApproval) {
      await persistControlFlowDecision({ ...decision, action: "ask_user" }, actionId, actionObservationId);
      agent.awaiting = decision.risk === "money" ? "extras" : decision.risk === "payment" ? "final" : "manual";
      agent.running = false;
      renderSidebar("agent");
      return;
    }

    if (decision.action === "ask_user") {
      await persistControlFlowDecision(decision, actionId, actionObservationId);
      agent.awaiting = decision.risk === "money" ? "extras" : "manual";
      agent.running = false;
      renderSidebar("agent");
      return;
    }

    if (decision.action === "final_review") {
      await persistControlFlowDecision(decision, actionId, actionObservationId);
      agent.awaiting = "final";
      agent.running = false;
      renderSidebar("review");
      return;
    }

    if (decision.action === "save_trip") {
      await persistControlFlowDecision(decision, actionId, actionObservationId);
      agent.awaiting = "";
      agent.running = false;
      renderSidebar("saved");
      return;
    }

    if (decision.action === "stop") {
      await persistControlFlowDecision(decision, actionId, actionObservationId);
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
      const targetBefore = resolveDecisionTarget(decision, map)
        || elementById(decision.targetId || decision.targetSnapshot?.id || "");
      const beforeScrollY = Math.round(window.scrollY);
      const scrollStrategy = decision.expectedOutcome?.scrollStrategy === "nearest_container"
        ? "nearest_container"
        : "target_center";
      const scrollResult = scrollElementWithinNearestContainer(targetBefore, {
        amount,
        behavior: "smooth",
        strategy: scrollStrategy,
        authority: "governed_executor"
      });
      recordAction("scroll", {
        amount,
        controlId: decision.controlId || "",
        targetId: decision.targetId || "",
        containerId: scrollResult.containerId || "",
        containerType: scrollResult.containerType || "",
        strategy: scrollResult.strategy || scrollStrategy,
        ok: scrollResult.ok
      });
      const scrollSettle = targetBefore && scrollResult.ok
        ? await waitForScrollSettle(targetBefore, { container: scrollResult.container })
        : { settled: false, timedOut: false, durationMs: 0, targetInViewport: false };
      const afterScrollY = Math.round(window.scrollY);
      const containerAfter = scrollResult.containerType === "element"
        ? Number(scrollResult.container?.scrollTop || 0)
        : afterScrollY;
      const moved = Boolean(scrollResult.moved || afterScrollY !== beforeScrollY || containerAfter !== scrollResult.before);
      const code = targetBefore
        ? "SCROLL_DISPATCHED_AWAITING_FRESH_OBSERVATION"
        : "TARGET_DISAPPEARED";
      await pushVerificationLedger(
        actionId,
        actionObservationId,
        decision,
        decision.expectedOutcome || { type: "viewport_scrolled" },
        {
          ok: false,
          code,
          message: code === "TARGET_DISAPPEARED"
            ? "The canonical recovery target disappeared before scrolling could be dispatched."
            : "Scroll was dispatched. A fresh browser observation must confirm the target exists and is in the viewport before the pending action can resume.",
          evidence: {
            beforeScrollY,
            afterScrollY,
            containerId: scrollResult.containerId || "",
            containerType: scrollResult.containerType || "",
            containerBefore: scrollResult.before ?? null,
            containerAfter,
            scrollStrategy: scrollResult.strategy || scrollStrategy,
            moved,
            scrollSettled: scrollSettle.settled,
            scrollSettleTimedOut: scrollSettle.timedOut,
            scrollSettleDurationMs: scrollSettle.durationMs,
            controlId: decision.controlId || "",
            targetFoundBefore: Boolean(targetBefore),
            requiresFreshObservation: true
          }
        }
      );
      await continueAfterAction(0);
      return;
    }

    if (decision.action === "keypress") {
      const requestedKey = String(decision.keys || decision.value || "");
      const key = /escape/i.test(requestedKey)
        ? "Escape"
        : /enter/i.test(requestedKey)
          ? "Enter"
          : /arrowdown/i.test(requestedKey)
            ? "ArrowDown"
            : /arrowup/i.test(requestedKey)
              ? "ArrowUp"
              : "";
      if (!key) {
        agent.awaiting = "manual";
        agent.running = false;
        addAgentMessage("assistant", "The AI requested an unsupported keypress, so I stopped.");
        renderSidebar("agent");
        return;
      }
      const target = resolveDecisionTarget(decision, map);
      if (!target || isPaymentField(target)) {
        await rejectMechanicalAction(actionId, actionObservationId, decision, {
          code: "CANONICAL_ACTUATOR_UNAVAILABLE",
          message: "The governed keyboard strategy has no safe live target."
        });
        return;
      }
      const validation = validateResolvedTarget(decision, target, map);
      if (!validation.ok) {
        await rejectMechanicalAction(actionId, actionObservationId, decision, {
          code: validation.code,
          message: "The governed keyboard target failed live validation.",
          expected: validation.expected,
          live: validation.live
        }, target);
        return;
      }
      pushActionLedger({
        actionId,
        observationId: actionObservationId,
        stage: "target_resolved",
        action: decision,
        targetFingerprint: targetFingerprint(target, decision)
      });
      target.focus?.({ preventScroll: true });
      pushActionLedger({
        actionId,
        observationId: actionObservationId,
        stage: "dispatched",
        action: decision,
        targetFingerprint: targetFingerprint(target, decision)
      });
      dispatchKey(target, key);
      recordAction("keypress", { key, targetId: decision.targetId || "" });
      await waitForUiSettle(500);
      const afterMap = rememberPagePlan(buildPageMap());
      const expectedOutcome = expectedOutcomeForDecision(decision, map, target);
      const verification = verifyExpectedOutcome(expectedOutcome, map, afterMap, target);
      await pushVerificationLedger(actionId, actionObservationId, decision, expectedOutcome, verification);
      await continueAfterAction(350);
      return;
    }

    if (decision.action === "fill_known_fields" || decision.action === "fill_visible_profile_fields") {
      agent.awaiting = "manual";
      agent.running = false;
      addAgentMessage("assistant", "The backend sent an unexpanded mutating skill. I stopped because every field change must now be an atomic governed action.");
      renderSidebar("agent");
      return;
    }

    if (decision.action === "click_xy") {
      const targetResolutionStartedAt = performance.now();
      logFlow("latency.span", {
        target_resolution_ms: Math.round(performance.now() - targetResolutionStartedAt),
        actionId,
        action: decision.action,
        method: "coordinate"
      });
      const x = Number(decision.x);
      const y = Number(decision.y);
      if (decision.x == null || decision.y == null || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) {
        await rejectMechanicalAction(actionId, actionObservationId, decision, {
          code: "INVALID_CLICK_COORDINATE",
          message: "The governed coordinate is outside the current viewport."
        });
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
      const coordinateValidation = validateVisualCoordinateTarget(decision, target, map);
      if (!coordinateValidation.ok) {
        logFlow("target.validation_failed", {
          actionId,
          observationId: actionObservationId,
          code: coordinateValidation.code,
          expected: coordinateValidation.expected,
          live: coordinateValidation.live
        });
        await rejectMechanicalAction(actionId, actionObservationId, decision, {
          code: coordinateValidation.code,
          message: "The governed visual region failed live validation.",
          expected: coordinateValidation.expected,
          live: coordinateValidation.live
        }, target);
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
      pushActionLedger({
        actionId,
        observationId: actionObservationId,
        stage: "dispatched",
        action: decision,
        targetFingerprint: targetFingerprint(target, decision)
      });
      clickViewportPoint(Math.round(x), Math.round(y));
      recordAction("click_xy", { x: Math.round(x), y: Math.round(y), label: targetLabel });
      await waitForUiSettle(700);
      {
        const afterMap = rememberPagePlan(buildPageMap());
        const expectedOutcome = expectedOutcomeForDecision(decision, map, target);
        const verification = verifyExpectedOutcome(expectedOutcome, map, afterMap, target);
        await pushVerificationLedger(actionId, actionObservationId, decision, expectedOutcome, verification);
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
        await rejectMechanicalAction(actionId, actionObservationId, decision, {
          code: "CANONICAL_ACTUATOR_UNAVAILABLE",
          message: "The planned canonical control has no valid live actuator in the fresh observation."
        });
        return;
      }
      const validation = validateResolvedTarget(decision, target, map);
      if (!validation.ok) {
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
        await rejectMechanicalAction(actionId, actionObservationId, decision, {
          code: validation.code,
          message: "The governed canonical target failed live validation.",
          expected: validation.expected,
          live: validation.live
        }, target);
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
      const resolvedTargetId = elementId(target);
      const button = map.buttons.find((item) => item.id === decision.targetId || item.id === resolvedTargetId);
      const surfaceEntry = currentSurfaceEntryForElement(map, target);
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
        const expectedOutcome = expectedOutcomeForDecision(decision, map, target);
        const verification = verifyExpectedOutcome(expectedOutcome, map, map, target);
        await pushVerificationLedger(actionId, actionObservationId, decision, expectedOutcome, verification);
        await continueAfterAction(350);
        return;
      }
      if (!repeatGuardFor(target, "I tried the same action once and the page did not advance. I stopped so I do not loop.")) return;
      if (button?.risk === "safe_continue") {
        await clickAndVerifyAdvance(target, button.label || "Continue", 1200, {
          actionId,
          observationId: actionObservationId,
          beforeMap: map,
          decision,
          expectedOutcome: expectedOutcomeForDecision(decision, map, target)
        });
        return;
      }
      const surfaceWasActive = Boolean(map.currentSurface?.type && map.currentSurface.type !== "page");
      const beforeOverlay = surfaceWasActive ? activeOverlayElements()[0] : null;
      const beforeOverlaySignature = beforeOverlay ? overlaySignature(beforeOverlay) : "";
      const expectedOutcome = expectedOutcomeForDecision(decision, map, target);
      showAgentCursor(target, button?.label || "clicking");
      flashElement(target);
      pushActionLedger({
        actionId,
        observationId: actionObservationId,
        stage: "dispatched",
        action: decision,
        targetFingerprint: targetFingerprint(target, decision)
      });
      rememberCanonicalSelectionCommitment(target, decision);
      userLikeClick(target);
      if (surfaceWasActive) {
        const progress = await waitForOverlayProgress(beforeOverlay, beforeOverlaySignature, 2200);
        const afterMap = rememberPagePlan(buildPageMap());
        const verification = verifyExpectedOutcome(expectedOutcome, map, afterMap, target);
        const verifiedResult = withOverlayProgressEvidence(verification, progress);
        await pushVerificationLedger(actionId, actionObservationId, decision, expectedOutcome, verifiedResult);
        await verifyAgentStep(
          target,
          "Interrupt",
          verification.ok ? verification.message : `expected outcome not observed${progress.ok ? ` (surface ${progress.reason})` : ""}`,
          verification.ok,
          650
        );
        if (!verification.ok) {
          addAgentMessage("assistant", `The active surface changed, but the exact expected outcome was not verified (${verification.code || "OUTCOME_NOT_VERIFIED"}). I am rescanning instead of marking it done.`);
          await continueAfterAction(450);
          return;
        }
        await continueAfterAction(500);
        return;
      }
      await waitForUiSettle(800);
      const afterMap = rememberPagePlan(buildPageMap());
      const verification = verifyExpectedOutcome(expectedOutcome, map, afterMap, target);
      await pushVerificationLedger(actionId, actionObservationId, decision, expectedOutcome, verification);
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
        if (target && isPaymentField(target)) {
          agent.awaiting = "manual";
          agent.running = false;
          addAgentMessage("assistant", "The requested field is sensitive, so I stopped before changing it.");
          renderSidebar("agent");
        } else {
          await rejectMechanicalAction(actionId, actionObservationId, decision, {
            code: "CANONICAL_ACTUATOR_UNAVAILABLE",
            message: "The canonical field has no live actuator for this operation."
          });
        }
        return;
      }
      if (decision.action === "select" && target.tagName !== "SELECT") {
        await rejectMechanicalAction(actionId, actionObservationId, decision, {
          code: "ACTION_OPERATION_ACTUATOR_MISMATCH",
          message: "A select operation resolved to a non-native select actuator."
        }, target);
        return;
      }
      const validation = validateResolvedTarget(decision, target, map);
      if (!validation.ok) {
        logFlow("target.validation_failed", {
          actionId,
          observationId: actionObservationId,
          code: validation.code,
          expected: validation.expected,
          live: validation.live
        });
        await rejectMechanicalAction(actionId, actionObservationId, decision, {
          code: validation.code,
          message: "The governed field actuator failed live validation.",
          expected: validation.expected,
          live: validation.live
        }, target);
        return;
      }
      const governedValue = decision.value === "profile://document_number"
        ? String(traveler()?.document?.document_number || "")
        : decision.value || "";
      if (decision.value === "profile://document_number" && !governedValue) {
        agent.awaiting = "manual";
        agent.running = false;
        addAgentMessage("assistant", "The governed document field has no saved local document value, so I stopped.");
        renderSidebar("agent");
        return;
      }
      const resolveLiveElement = () => {
        const freshMap = rememberPagePlan(buildPageMap());
        return resolveDecisionTarget({
          action: decision.action,
          operation: decision.operation,
          controlId: decision.controlId || decision.targetSnapshot?.controlId || "",
          targetSnapshot: {
            controlId: decision.controlId || decision.targetSnapshot?.controlId || ""
          }
        }, freshMap);
      };
      pushActionLedger({
        actionId,
        observationId: actionObservationId,
        stage: "dispatched",
        action: decision,
        targetFingerprint: targetFingerprint(target, decision)
      });
      const result = await setFieldValue(target, governedValue, {
        fieldType: decision.action,
        resolveLiveElement
      });
      if (!result.ok) {
        await rejectMechanicalAction(actionId, actionObservationId, decision, {
          code: "FIELD_VALUE_NOT_VERIFIED",
          message: `The ${decision.action} operation did not retain the governed value.`,
          dispatched: true,
          targetResolved: true,
          details: result
        }, target);
        return;
      }
      {
        const afterMap = rememberPagePlan(buildPageMap());
        const expectedOutcome = expectedOutcomeForDecision(decision, map, target);
        const verification = verifyExpectedOutcome(expectedOutcome, map, afterMap, target);
        await pushVerificationLedger(actionId, actionObservationId, decision, expectedOutcome, verification);
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
    if (agent.running || agent.loopBusy) {
      logFlow("loop.start_duplicate_suppressed", {
        activeLoopRunId: agent.activeLoopRunId,
        lifecycleId: agent.lifecycleId
      });
      return;
    }
    resetAgentLoopLifecycle("start_agent");
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
    resetFieldProgress();
    setAgentActivity("Starting checkout agent", travelerRules() || "Using saved traveler profile");
    agent.pageMap = rememberPagePlan(buildPageMap());
    const session = await startAgentSession();
    if (!session || !agent.sessionId) {
      agent.running = false;
      agent.awaiting = "manual";
      await clearResumeMarker();
      addAgentMessage("assistant", "I could not establish one durable checkout session, so I stopped before planning or changing the page.");
      renderSidebar("agent");
      return;
    }
    await saveResumeMarker();
    addAgentMessage("assistant", `${describePageMap(agent.pageMap)} I will work step by step and ask when money, payment, or uncertainty appears.`);
    renderSidebar("agent");
    await announceSectionQueue();
    await sleep(650);
    processCheckoutAgent();
  }

  async function resumeCheckoutAfterNavigation(marker) {
    resetAgentLoopLifecycle("resume_after_navigation");
    agent.running = true;
    agent.sessionId = "";
    agent.awaiting = "";
    agent.messages = [];
    agent.reasoningLog = [];
    agent.lastClickSignature = "";
    agent.repeatClickCount = 0;
    agent.skipPaidExtrasApproved = Boolean(marker.skipPaidExtrasApproved);
    agent.autopilotMode = true;
    agent.actionHistory = [];
    resetFieldProgress();
    setAgentActivity("Continuing checkout agent after page change", travelerRules() || "Using saved traveler profile");
    agent.pageMap = rememberPagePlan(buildPageMap());
    const resumeSessionId = String(marker.sessionId || "");
    const session = resumeSessionId ? await startAgentSession(resumeSessionId) : null;
    if (!session || agent.sessionId !== resumeSessionId) {
      agent.running = false;
      agent.awaiting = "manual";
      await clearResumeMarker();
      addAgentMessage("assistant", "The prior checkout session could not be resumed, so I stopped instead of starting a replacement transaction.");
      renderSidebar("agent");
      return;
    }
    await saveResumeMarker();
    addAgentMessage("assistant", "Picking back up where I left off after the page changed.");
    renderSidebar("agent");
    await announceSectionQueue();
    await sleep(650);
    processCheckoutAgent();
  }

  async function processCheckoutAgent() {
    if (!agent.running) return;
    if (!agent.sessionId) {
      agent.running = false;
      agent.awaiting = "manual";
      addAgentMessage("assistant", "The durable checkout session is missing, so I stopped before observing or acting.");
      renderSidebar("agent");
      return;
    }
    const loopToken = beginAgentLoop();
    if (!loopToken) return;
    let shouldRerun = false;
    try {
      warnings = runRiskChecks();
      let observationBuildMs = 0;
      let observationStartedAt = performance.now();
      agent.pageMap = rememberPagePlan(buildPageMap());
      observationBuildMs += performance.now() - observationStartedAt;
      await showAgentThought(
        null,
        "Observe",
        "Backend planner",
        "Reading the current page and sending it to the backend before taking any checkout action.",
        450
      );
      await waitForPaint(450);
      if (loopToken.lifecycleId !== agent.lifecycleId || !agent.running) return;
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
      if (stableMap.graphIntegrity && !stableMap.graphIntegrity.ok) {
        logFlow("control.graph_conflicts_diagnostic", {
          actionableConflictCount: Number(stableMap.graphIntegrity.actionableConflictCount || 0),
          diagnosticConflictCount: Number(stableMap.graphIntegrity.diagnosticConflictCount || 0),
          conflicts: (stableMap.graphIntegrity.conflicts || []).slice(0, 8)
        });
      }

      const userMessage = agent.pendingUserMessage;
      agent.pendingUserMessage = "";
      const decision = await requestAgentDecision(
        stableMap,
        userMessage,
        { observation_build_ms: observationBuildMs },
        loopToken
      );
      if (!decision || loopToken.lifecycleId !== agent.lifecycleId || !agent.running) return;
      await executeAgentDecision(decision, stableMap);
    } finally {
      shouldRerun = finishAgentLoop(loopToken);
      if (shouldRerun) {
        setTimeout(() => processCheckoutAgent(), 0);
      }
    }
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
      resetAgentLoopLifecycle("user_stop");
      agent.running = false;
      agent.awaiting = "";
      if (agent.sessionId) {
        await persistControlFlowDecision({
          action: "stop",
          message: "Checkout stopped by the user.",
          reason: "The user explicitly stopped the active checkout session.",
          risk: "safe"
        });
      }
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
      .map((error) => String(typeof error === "string" ? error : error?.message || "").replace(/\s+/g, " ").trim())
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
          <button class="atw-primary" id="atw-takeover" ${detected && !agent.running ? "" : "disabled"}>Start agent</button>
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

  if (window.__ATW_ENABLE_TEST_HOOKS__ === true) {
    window.__ATW_TEST__ = Object.freeze({
      buildPageMap,
      buildCanonicalAliasIndex,
      beginAgentLoop,
      finishAgentLoop,
      resetAgentLoopLifecycle,
      plannerRequestIsCurrent,
      setAppDataForTest: (data, travelerId = "") => {
        appData = data;
        selectedTravelerId = travelerId || data?.travelers?.[0]?.id || null;
      },
      setAgentRunningForTest: (running) => { agent.running = Boolean(running); },
      agentLoopState: () => ({
        lifecycleId: agent.lifecycleId,
        loopBusy: agent.loopBusy,
        loopRerunQueued: agent.loopRerunQueued,
        activeLoopRunId: agent.activeLoopRunId,
        activePlannerRequest: agent.activePlannerRequest ? {
          turnId: agent.activePlannerRequest.turnId,
          observationId: agent.activePlannerRequest.observationId,
          loopRunId: agent.activePlannerRequest.loopRunId,
          lifecycleId: agent.activePlannerRequest.lifecycleId
        } : null
      }),
      createObservationControlRegistry,
      compactPageMap,
      compactSurfaceReference,
      observationTransportBytes,
      smallerObservationTransport,
      uploadObservationScreenshot,
      postObservationWithSizeRecovery,
      prepareScreenshotAnnotations,
      mapObservationSnapshot,
      materialObservationSignature,
      observationHashForMap,
      meaningfulActionBox,
      liveTargetSnapshot,
      validateResolvedTarget,
      validateVisualCoordinateTarget,
      resolveDecisionTarget,
      normalizeVisualRegionContract,
      visualRegionContractsMatch,
      nearestEffectiveScrollContainer,
      scrollElementWithinNearestContainer,
      waitForScrollSettle,
      showAgentCursor,
      rememberCanonicalSelectionCommitment,
      userLikeClick,
      clickViewportPoint,
      dispatchKey,
      setFieldValue,
      expectedOutcomeForDecision,
      verifyExpectedOutcome,
      transitionFeedbackForMaps,
      rememberActionExecutionResult,
      withOverlayProgressEvidence
    });
    return;
  }

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
