(async function bootAirTravelWallet() {
  if (document.getElementById("atw-sidebar")) return;

  const DEFAULT_API = "http://localhost:4173/api";
  const MAX_OBSERVATION_TRANSPORT_BYTES = 5_250_000;
  const ACTION_REPORT_TIMEOUT_MS = 8_000;
  const ACTION_REPORT_MAX_ATTEMPTS = 2;
  const AGENT_SINGLE_BRAIN = true;
  const AGENT_CONTRACT = globalThis.AtwAgentContract || null;
  const BAGGAGE_TERMS = ["no cabin bag", "baggage not included", "personal item only", "without baggage", "checked baggage not included"];
  const MULTI_AIRPORT_CODES = new Set(["LHR", "LGW", "LTN", "STN", "LCY", "CDG", "ORY", "BVA", "IST", "SAW"]);
  const PROFILE_FIELD_ALIASES = new Map(Object.entries({
    title: ["title", "traveler_title", "traveller_title", "salutation", "gender_title", "honorific"],
    gender: ["gender", "sex"],
    first_name: ["first_name", "firstname", "given_name", "given_names", "forename"],
    middle_name: ["middle_name", "middlename"],
    last_name: ["last_name", "lastname", "surname", "family_name"],
    second_last_name: ["second_last_name", "second_surname", "additional_surname", "maternal_surname"],
    full_name: ["full_name", "fullname", "passenger_name", "traveler_name", "traveller_name"],
    email: ["email", "email_address", "e_mail"],
    confirm_email: ["confirm_email", "email_confirmation", "repeat_email", "confirm_email_address"],
    phone: ["phone", "phone_number", "mobile", "mobile_number", "telephone", "tel"],
    phone_country_code: ["phone_country_code", "country_dial_code", "dial_code", "calling_code", "country_calling_code"],
    date_of_birth: ["date_of_birth", "birth_date", "birthdate", "dob", "bday"],
    place_of_birth: ["place_of_birth", "birth_place", "birth_city"],
    nationality: ["nationality", "citizenship"],
    country_of_residence: ["country_of_residence", "residence_country", "resident_country"],
    document_type: ["document_type", "travel_document_type", "identity_document_type", "id_type"],
    passport_number: ["passport_number", "passport_no"],
    document_number: ["document_number", "travel_document_number", "identity_document_number"],
    issuing_country: ["issuing_country", "document_issuing_country", "passport_issuing_country"],
    document_issue_date: ["document_issue_date", "passport_issue_date", "date_of_issue", "issue_date"],
    address_line1: ["address_line1", "address1", "street_address", "billing_address", "billing_address_line1"],
    address_line2: ["address_line2", "address2", "billing_address_line2"],
    city: ["city", "address_city", "billing_city", "locality"],
    state: ["state", "province", "region", "address_state", "billing_state"],
    postal_code: ["postal_code", "postcode", "zip", "zip_code", "billing_postal_code"],
    country: ["country", "address_country", "billing_country", "country_name"],
    passport_expiry: ["passport_expiry", "passport_expiration", "passport_expiry_date"],
    document_expiry: ["document_expiry", "document_expiration", "document_expiry_date"],
    frequent_flyer_program: ["frequent_flyer_program", "loyalty_program", "airline_loyalty_program"],
    frequent_flyer_number: ["frequent_flyer_number", "loyalty_number", "membership_number"],
    known_traveler_number: ["known_traveler_number", "known_traveller_number", "ktn"],
    redress_number: ["redress_number", "redress_control_number"],
    emergency_contact_name: ["emergency_contact_name", "emergency_name"],
    emergency_contact_relationship: ["emergency_contact_relationship", "emergency_relationship"],
    emergency_contact_phone: ["emergency_contact_phone", "emergency_phone"],
    emergency_contact_email: ["emergency_contact_email", "emergency_email"],
    meal_preference: ["meal_preference", "meal_request", "special_meal"],
    special_assistance: ["special_assistance", "assistance_request", "accessibility_request"]
  }).flatMap(([canonical, aliases]) => aliases.map((alias) => [alias, canonical])));
  const PAYMENT_TERMS = ["card", "cvc", "cvv", "security code", "payment", "cc-number", "cc-csc"];
  const SLOW_STEP_MS = 160;
  const VERIFY_STEP_MS = 120;
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
  const choiceActuatorBindings = new Map();
  const choiceInteractionStates = new Map();

  function rememberChoiceActuatorBinding(controlId = "", actuator = null, decision = {}) {
    const canonicalControlId = String(controlId || decision.controlId || "").trim();
    if (!canonicalControlId || !actuator || !isVisible(actuator)) return null;
    const binding = {
      controlId: canonicalControlId,
      actuatorId: elementId(actuator),
      desiredLabel: String(decision.value || decision.targetLabel || "").trim(),
      updatedAt: Date.now()
    };
    choiceActuatorBindings.set(canonicalControlId, binding);
    return binding;
  }

  function updateChoiceInteractionState(controlId = "", update = {}) {
    const canonicalControlId = String(controlId || "").trim();
    if (!canonicalControlId) return null;
    const next = {
      ...(choiceInteractionStates.get(canonicalControlId) || {}),
      controlId: canonicalControlId,
      ...update,
      updatedAt: Date.now()
    };
    choiceInteractionStates.set(canonicalControlId, next);
    return next;
  }

  function clearCommittedChoicesForGroup(decisionGroupId = "", exceptControlId = "") {
    const groupId = String(decisionGroupId || "").trim();
    if (!groupId) return;
    for (const [controlId, state] of choiceInteractionStates.entries()) {
      if (state.decisionGroupId !== groupId || controlId === exceptControlId) continue;
      choiceInteractionStates.set(controlId, {
        ...state,
        exactChoiceCommitted: false,
        status: "superseded",
        updatedAt: Date.now()
      });
    }
  }

  function rememberExactChoiceCommitment(target, decision = {}, evidence = {}) {
    const controlId = String(decision.controlId || target?.dataset?.atwControlId || "").trim();
    if (!controlId) return null;
    const decisionGroupId = String(decision.decisionGroupId || decision.targetSnapshot?.decisionGroupId || "").trim();
    clearCommittedChoicesForGroup(decisionGroupId, controlId);
    return updateChoiceInteractionState(controlId, {
      status: "committed",
      exactChoiceCommitted: true,
      decisionGroupId,
      desiredLabel: String(decision.targetLabel || decision.value || controlText(target) || "").replace(/\s+/g, " ").trim(),
      evidenceSource: String(evidence.source || "observed_selected_state"),
      pageKey: `${location.origin}${location.pathname}`
    });
  }

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
    const clicked = event.target?.closest?.("button, [role='button'], input[type='radio'], input[type='checkbox'], [role='radio'], [role='checkbox']");
    const control = clicked && agent.pageMap ? lookupControlForElement(agent.pageMap, clicked) : null;
    if (control?.decisionGroupId) clearCommittedChoicesForGroup(control.decisionGroupId);
  }, true);
  let agent = {
    running: false,
    sessionId: "",
    apiBase: DEFAULT_API,
    awaiting: "",
    messages: [],
    lastClickSignature: "",
    repeatClickCount: 0,
    lastClickAt: 0,
    failedLocalStrategies: [],
    skipPaidExtrasApproved: false,
    skipRoutineRunning: false,
    autopilotMode: true,
    pendingUserMessage: "",
    pendingUserResponse: null,
    pendingInputRequest: null,
    sessionProfileOverrides: {},
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
    lastPageMutationAt: Date.now(),
    pageUnderstanding: null,
    observerTab: "summary",
    lifecycleId: 0,
    loopRunSerial: 0,
    activeLoopRunId: 0,
    loopBusy: false,
    loopRerunQueued: false,
    activePlannerRequest: null,
    destinationWait: null,
    destinationWaitTimer: null,
    lastSentMaterialHash: "",
    lastSentFeedbackKey: "",
    screenshotCache: new Map()
  };
  let pageStateStore = null;
  let activeObservationElementRegistry = null;
  let activeObservationControlRegistry = null;

  function storageGet(keys) {
    return chrome.storage.local.get(keys);
  }

  const RESUME_KEY = "atwAgentResume";
  const RESUME_MAX_AGE_MS = 3 * 60 * 1000;
  const DESTINATION_WAIT_TIMEOUT_MS = 20_000;
  const DESTINATION_RETRY_INTERVAL_MS = 300;

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

  function shouldAutoDeclinePaidExtras() {
    // Only an explicit, session-scoped approval may set this transport flag.
    // Saved rules and booking-specific instructions are resolved once by the
    // backend profile-to-decision resolver; autopilot is never a preference.
    return agent.skipPaidExtrasApproved === true;
  }

  function resetFieldProgress() {
    agent.completedFields = {};
  }

  function rememberPagePlan(map) {
    agent.sectionPlan = (map?.sections || []).map((section) => ({
      id: section.id,
      label: section.label,
      type: section.type,
      controlIds: uniqueControlIds([
        ...(section.fields || []),
        ...(section.choices || []),
        ...(section.buttons || [])
      ])
    }));
    // Legacy extension task queues are diagnostic-only and are no longer
    // allowed to compete with the backend TaskState reducer.
    agent.taskQueue = [];
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
    if (/paid|extra|baggage|bundle|flexible|cancellation/.test(text)) {
      return shouldAutoDeclinePaidExtras()
        ? "Rule: this session explicitly authorizes declining paid extras."
        : "Rule: apply the traveler profile and booking instruction; ask if price authority is missing.";
    }
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
    await sleep(Math.min(Math.max(0, pause), 180));
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
    await sleep(Math.min(Math.max(0, pause), 150));
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

  function normalizedFieldAlias(value = "") {
    return String(value || "")
      .trim()
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
  }

  function canonicalProfileFieldType(value = "") {
    const alias = normalizedFieldAlias(value);
    if (!alias) return "";
    if (PROFILE_FIELD_ALIASES.has(alias)) return PROFILE_FIELD_ALIASES.get(alias);
    const withoutSubject = alias
      .replace(/^(?:passengers?|travell?ers?|adults?)_\d+_/, "")
      .replace(/^(?:contact|profile)_/, "");
    if (PROFILE_FIELD_ALIASES.has(withoutSubject)) return PROFILE_FIELD_ALIASES.get(withoutSubject);
    if (/^(?:birth|dob|bday)_(?:day|month|year)$/.test(withoutSubject)) return "date_of_birth";
    if (/^(?:passport_)?nationality$|^country_of_citizenship$/.test(withoutSubject)) return "nationality";
    if (/^(?:travell?er_)?title$|^salutation$|^gender_title$/.test(withoutSubject)) return "title";
    if (/^(?:passport_)?id_number$|^travel_document_(?:number|no)$/.test(withoutSubject)) {
      return withoutSubject.startsWith("passport") ? "passport_number" : "document_number";
    }
    if (/^(?:passport|document)_(?:expiry|expiration)_(?:day|month|year)$/.test(withoutSubject)) {
      return withoutSubject.startsWith("passport") ? "passport_expiry" : "document_expiry";
    }
    if (/^(?:passport|document)_(?:issue|issued)_(?:day|month|year)$/.test(withoutSubject)) {
      return "document_issue_date";
    }
    return "";
  }

  function boundedPhrase(text = "", phrase = "") {
    const source = String(text || "").toLowerCase().replace(/[^a-z0-9+]+/g, " ").replace(/\s+/g, " ").trim();
    const wanted = String(phrase || "").toLowerCase().replace(/[^a-z0-9+]+/g, " ").replace(/\s+/g, " ").trim();
    if (!source || !wanted) return false;
    return new RegExp(`(?:^|\\s)${wanted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\ /g, "\\s+")}(?:$|\\s)`).test(source);
  }

  function stableProfileFieldOwnerKey(group) {
    if (!group) return "";
    const explicit = [
      group.getAttribute?.("name") ? `name:${group.getAttribute("name")}` : "",
      group.getAttribute?.("data-testid") ? `testid:${group.getAttribute("data-testid")}` : "",
      group.getAttribute?.("aria-labelledby") ? `labelledby:${group.getAttribute("aria-labelledby")}` : "",
      group.getAttribute?.("aria-label") ? `arialabel:${normalizedFieldAlias(group.getAttribute("aria-label"))}` : "",
      group.id && !/^atw[-_]/i.test(group.id) ? `id:${group.id}` : ""
    ].filter(Boolean);
    if (explicit.length) return explicit.join("|");
    const path = [];
    for (let current = group, depth = 0; current && depth < 5; current = current.parentElement, depth += 1) {
      const tag = String(current.tagName || "node").toLowerCase();
      const role = String(current.getAttribute?.("role") || "").toLowerCase();
      const siblings = current.parentElement
        ? [...current.parentElement.children].filter((item) => (
            String(item.tagName || "").toLowerCase() === tag
            && String(item.getAttribute?.("role") || "").toLowerCase() === role
          ))
        : [current];
      path.push(`${tag}:${role || "none"}:${Math.max(0, siblings.indexOf(current))}`);
    }
    return `path:${path.join("/")}`;
  }

  function profileFieldGroupEvidence(input) {
    let group = input?.closest?.("fieldset, [role='radiogroup'], [role='group']") || null;
    if (!group && (input?.type === "radio" || implicitRole(input) === "radio")) {
      const name = input.getAttribute?.("name") || "";
      const peers = name
        ? queryAllDeep(`input[type='radio'][name="${CSS.escape(name)}"], [role='radio'][name="${CSS.escape(name)}"]`)
        : [];
      for (let current = input.parentElement, depth = 0; current && depth < 5; current = current.parentElement, depth += 1) {
        if (peers.length > 1 && peers.every((peer) => current.contains(peer))) {
          group = current;
          break;
        }
      }
    }
    const labelledBy = String(group?.getAttribute?.("aria-labelledby") || "")
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent || "")
      .join(" ");
    const label = [
      group?.querySelector?.("legend")?.textContent,
      group?.querySelector?.(":scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > label")?.textContent,
      group?.getAttribute?.("aria-label"),
      labelledBy
    ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    const optionLabels = group
      ? queryAllDeep("input[type='radio'], [role='radio'], option, [role='option']", group)
        .map((option) => choiceLabel(option))
        .filter(Boolean)
        .slice(0, 12)
      : [];
    const controlCount = group
      ? queryAllDeep("input, select, textarea, [role='radio'], [role='combobox'], [role='spinbutton']", group)
        .filter((control, index, list) => list.indexOf(control) === index)
        .length
      : 0;
    const role = String(group?.getAttribute?.("role") || "").toLowerCase();
    const tight = Boolean(
      group
      && label
      && (
        group.tagName === "FIELDSET"
        || role === "radiogroup"
        || (role === "group" && controlCount > 0 && controlCount <= 4)
      )
    );
    return {
      group,
      label,
      optionLabels,
      tight,
      ownerId: tight ? elementId(group) : "",
      ownerKey: tight ? stableProfileFieldOwnerKey(group) : "",
      controlCount
    };
  }

  function profileFieldTypesFromText(value = "", { editable = true } = {}) {
    const evidence = String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
    if (!evidence) return [];
    const matches = [];
    const add = (fieldType) => {
      if (fieldType && !matches.includes(fieldType)) matches.push(fieldType);
    };
    if (/emergency contact.*e[ -]?mail|e[ -]?mail.*emergency contact/.test(evidence)) add("emergency_contact_email");
    else if (/confirm.*e[ -]?mail|repeat.*e[ -]?mail/.test(evidence)) add("confirm_email");
    else if (editable && /(?:^|\s)e[ -]?mail(?:\s|$)/.test(evidence)) add("email");
    if (/emergency contact.*name|name.*emergency contact/.test(evidence)) add("emergency_contact_name");
    if (/emergency contact.*relationship|relationship.*emergency contact/.test(evidence)) add("emergency_contact_relationship");
    if (/emergency contact.*(?:phone|mobile|telephone)|(?:phone|mobile|telephone).*emergency contact/.test(evidence)) add("emergency_contact_phone");
    if (boundedPhrase(evidence, "surname") || /family[ _-]?name|last[ _-]?name/.test(evidence)) add("last_name");
    if (/first[ _-]?name|given[ _-]?name|forename/.test(evidence)) add("first_name");
    if (/middle[ _-]?name/.test(evidence)) add("middle_name");
    if (/second (?:last name|surname)|additional surname|maternal surname/.test(evidence)) add("second_last_name");
    if (editable && /(?:^|\s)(?:birth|date of birth|dob|bday)(?:\s|$)/.test(evidence)) add("date_of_birth");
    if (editable && /(?:^|\s)(?:place of birth|birth place|birth city)(?:\s|$)/.test(evidence)) add("place_of_birth");
    if (editable && /(?:^|\s)(?:nationality|citizenship|country of citizenship)(?:\s|$)/.test(evidence)) add("nationality");
    if (editable && /country of residence|residence country|resident country/.test(evidence)) add("country_of_residence");
    if (editable && /(?:travel|identity)?\s*document type|passport or id|id type/.test(evidence)) add("document_type");
    if (editable && /passport.*(?:number|no)|(?:number|no).*passport/.test(evidence)) add("passport_number");
    if (editable && /(?:travel|identity)?.*document.*(?:number|no)|(?:number|no).*document/.test(evidence)) add("document_number");
    if (editable && /(?:issuing|issue).*(?:country|nation)|(?:country|nation).*(?:issuing|issue)/.test(evidence)) add("issuing_country");
    if (editable && /(?:passport|document).*(?:issue date|date of issue)|(?:issue date|date of issue).*(?:passport|document)/.test(evidence)) add("document_issue_date");
    if (editable && /passport.*(?:expiry|expiration)|(?:expiry|expiration).*passport/.test(evidence)) add("passport_expiry");
    if (editable && /document.*(?:expiry|expiration)|(?:expiry|expiration).*document/.test(evidence)) add("document_expiry");
    if (editable && /frequent[ -]?flyer.*(?:program|programme|airline)|loyalty program/.test(evidence)) add("frequent_flyer_program");
    if (editable && /frequent[ -]?flyer.*(?:number|no)|loyalty (?:number|no)|membership (?:number|no)/.test(evidence)) add("frequent_flyer_number");
    if (editable && /known travell?er (?:number|no)|\bktn\b/.test(evidence)) add("known_traveler_number");
    if (editable && /redress (?:control )?(?:number|no)/.test(evidence)) add("redress_number");
    if (editable && /meal preference|special meal|meal request/.test(evidence)) add("meal_preference");
    if (editable && /special assistance|assistance request|accessibility request/.test(evidence)) add("special_assistance");
    if (editable && (/(?:^|\s)(?:phone|telephone|mobile)(?:\s|$)/.test(evidence))
      && !/(?:plan|bundle|package|insurance|addon|add on|emergency contact)/.test(evidence)) {
      add(/country.*code|dial.*code|calling.*code/.test(evidence) ? "phone_country_code" : "phone");
    } else if (editable && /country.*code|dial.*code|calling.*code/.test(evidence)) {
      add("phone_country_code");
    }
    if (/(?:^|\s)(?:title|salutation|honorific)(?:\s|$)/.test(evidence)) add("title");
    if (/(?:^|\s)(?:gender|sex)(?:\s|$)/.test(evidence)) add("gender");
    return matches;
  }

  function explicitProfileLabelEvidence(input) {
    const nestedLabel = input.closest?.("label");
    const idLabel = input.id ? queryAllDeep(`label[for="${CSS.escape(input.id)}"]`)[0] : null;
    const labelledBy = String(input.getAttribute?.("aria-labelledby") || "")
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent || "")
      .join(" ");
    return [
      input.getAttribute?.("aria-label"),
      nestedLabel?.textContent,
      idLabel?.textContent,
      labelledBy,
      input.getAttribute?.("placeholder")
    ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  }

  function classifyProfileField(input, hintedField = "") {
    const hinted = canonicalProfileFieldType(hintedField);
    if (!input) return { fieldType: "", source: "none", confidence: 0, evidence: [] };
    const type = String(input.getAttribute?.("type") || input.type || "").toLowerCase();
    const role = String(implicitRole(input) || "").toLowerCase();
    const autocomplete = String(input.getAttribute?.("autocomplete") || "").toLowerCase();
    const group = profileFieldGroupEvidence(input);
    const editable = !["radio", "checkbox", "button", "submit", "reset"].includes(type)
      && !["radio", "checkbox", "button", "option"].includes(role);
    const explicitLabel = explicitProfileLabelEvidence(input);
    const result = (fieldType, source, confidence, used = "", extra = {}) => ({
      fieldType,
      source,
      confidence,
      evidence: [used].filter(Boolean).slice(0, 4),
      evidenceByChannel: {
        rawAttributes: [input.name, input.id, input.getAttribute?.("data-testid"), autocomplete].filter(Boolean),
        explicitLabel: explicitLabel ? [explicitLabel] : [],
        tightLocalOwner: group.tight && group.label ? [group.label] : [],
        sectionContext: []
      },
      tightOwnerId: group.ownerId || "",
      tightOwnerKey: group.ownerKey || "",
      ...extra
    });
    const resolveTier = (candidates = [], source = "", confidence = 0, used = "") => {
      const unique = [...new Set(candidates.filter(Boolean))];
      if (unique.length === 1) return result(unique[0], source, confidence, used);
      if (unique.length > 1) {
        return result("", "semantic_conflict", 0, used, {
          ambiguity: {
            code: "AMBIGUOUS_FIELD_SEMANTICS",
            source,
            candidates: unique
          }
        });
      }
      return null;
    };
    if (hinted) return result(hinted, "canonical_hint", 1, hintedField);

    const autocompleteAliases = {
      "given-name": "first_name", "additional-name": "middle_name", "family-name": "last_name", name: "full_name",
      email: "email", tel: "phone", "tel-national": "phone", "tel-country-code": "phone_country_code",
      bday: "date_of_birth", "bday-day": "date_of_birth", "bday-month": "date_of_birth", "bday-year": "date_of_birth",
      country: "nationality", "country-name": "nationality"
    };
    const directMachineText = [
      input.name,
      input.id,
      input.getAttribute?.("data-testid"),
      autocomplete,
      input.getAttribute?.("aria-label"),
      input.getAttribute?.("placeholder")
    ].filter(Boolean).join(" ");
    const rawCandidates = [
      autocompleteAliases[autocomplete],
      ...[input.name, input.id, input.getAttribute?.("data-testid")]
        .map(canonicalProfileFieldType)
        .filter(Boolean)
    ];
    const optionCodecCandidates = (() => {
      if (!(type === "radio" || role === "radio") || !group.tight) return [];
      const titleValues = group.optionLabels.map((label) => normalizedProfileChoiceValue(label, "title"));
      const genderValues = group.optionLabels.map((label) => normalizedProfileChoiceValue(label, "gender"));
      if (genderValues.includes("male") && genderValues.includes("female")) return ["gender"];
      if (titleValues.includes("mr") && titleValues.includes("mrs/ms")) return ["title"];
      return [];
    })();
    const ownershipFamily = (fieldType = "") => {
      if (["passport_number", "document_number"].includes(fieldType)) return "document_number";
      if (["passport_expiry", "document_expiry"].includes(fieldType)) return "document_expiry";
      return fieldType;
    };
    const crossChannelCandidates = [...new Set([
      ...rawCandidates,
      ...profileFieldTypesFromText(directMachineText, { editable }),
      ...profileFieldTypesFromText(explicitLabel, { editable }),
      ...optionCodecCandidates
    ].filter(Boolean).map(ownershipFamily))];
    if (crossChannelCandidates.length > 1) {
      return result("", "semantic_conflict", 0, `${directMachineText} ${explicitLabel}`, {
        ambiguity: {
          code: "AMBIGUOUS_FIELD_SEMANTICS",
          source: "conflicting_direct_evidence",
          candidates: crossChannelCandidates
        }
      });
    }
    const rawResolution = resolveTier(
      rawCandidates,
      autocompleteAliases[autocomplete] ? "autocomplete_or_control_attribute" : "control_attribute",
      0.99,
      [input.name, input.id, input.getAttribute?.("data-testid"), autocomplete].filter(Boolean).join(" ")
    );
    if (rawResolution) return rawResolution;

    const directMachineResolution = resolveTier(
      profileFieldTypesFromText(directMachineText, { editable }),
      "direct_machine_evidence",
      0.98,
      directMachineText
    );
    if (directMachineResolution) return directMachineResolution;
    const directMachineAlias = normalizedFieldAlias(directMachineText);
    if (/(?:passenger|travell?er|adult)_(?:category|type|class)|(?:category|type|class)_(?:passenger|travell?er|adult)/.test(directMachineAlias)) {
      return result("", "direct_non_profile_control", 0.99, directMachineText);
    }

    const explicitResolution = resolveTier(
      profileFieldTypesFromText(explicitLabel, { editable }),
      "explicit_label_or_aria",
      0.96,
      explicitLabel
    );
    if (explicitResolution) return explicitResolution;
    if (type === "tel") return result("phone", "input_type", 0.9, type);

    const titleGroup = /(?:^|\s)(?:title|salutation|honorific)(?:\s|$)/.test(group.label.toLowerCase());
    const normalizedTitleOptions = group.optionLabels.map((label) => normalizedProfileChoiceValue(label, "title"));
    const titleOptions = normalizedTitleOptions.includes("mr") && normalizedTitleOptions.includes("mrs/ms");
    if (group.tight && (type === "radio" || role === "radio") && (titleGroup || titleOptions)) {
      return result("title", titleGroup ? "radio_group_label" : "radio_group_options", titleGroup ? 0.98 : 0.9, `${group.label} ${group.optionLabels.join(" ")}`);
    }
    const genderGroup = /(?:^|\s)(?:gender|sex)(?:\s|$)/.test(group.label.toLowerCase());
    const normalizedGenderOptions = group.optionLabels.map((label) => normalizedProfileChoiceValue(label, "gender"));
    const genderOptions = normalizedGenderOptions.includes("male") && normalizedGenderOptions.includes("female");
    if (group.tight && (type === "radio" || role === "radio") && (genderGroup || genderOptions)) {
      return result("gender", genderGroup ? "radio_group_label" : "radio_group_options", genderGroup ? 0.98 : 0.9, `${group.label} ${group.optionLabels.join(" ")}`);
    }
    return result("", "none", 0);
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
        const semanticStateElement = Boolean(classifyProfileField(input).fieldType);
        return !input.closest("#atw-sidebar")
          && (!input.disabled || semanticStateElement)
          && (!input.readOnly || comboboxLike)
          && (isVisible(input) || semanticStateElement)
          && !isPaymentField(input);
      });
  }

  function detectField(input) {
    const classification = classifyProfileField(input);
    return classification.fieldType ? { field: classification.fieldType, ...classification } : null;
  }

  function bookingDetected() {
    const matches = candidateInputs().map(detectField).filter(Boolean);
    const step = classifyStep({
      visibleText: `${primaryPageText()} ${visiblePageText().slice(0, 1200)}`,
      url: location.href
    });
    const checkoutCopy = /checkout|traveller information|traveler information|configure your trip|select baggage|seat selection|payment|booking confirmed/i.test(visiblePageText());
    return matches.length >= 3 || step !== "unknown" || checkoutCopy;
  }

  function travelerValue(field) {
    // Observation also runs on non-profile checkout surfaces and in the brief
    // interval before a traveler is selected. Goal-aware option ranking must
    // remain inert there instead of making page observation depend on profile
    // availability.
    const t = traveler() || {};
    if (agent.sessionProfileOverrides?.[field]) return agent.sessionProfileOverrides[field];
    const values = {
      confirm_email: t.email,
      first_name: t.first_name,
      middle_name: t.middle_name,
      last_name: t.last_name,
      second_last_name: t.second_last_name,
      full_name: [t.first_name, t.middle_name, t.last_name, t.second_last_name].filter(Boolean).join(" "),
      date_of_birth: t.date_of_birth,
      place_of_birth: t.place_of_birth,
      title: titleValue(t),
      gender: t.gender,
      nationality: t.nationality,
      country_of_residence: t.country_of_residence || t.address?.country || t.country || "",
      document_type: t.document?.document_type || "",
      passport_number: t.document?.document_number || "",
      document_number: t.document?.document_number || "",
      issuing_country: t.document?.issuing_country || "",
      document_issue_date: t.document?.issue_date || "",
      passport_expiry: t.document?.expiry_date || "",
      document_expiry: t.document?.expiry_date || "",
      address_line1: t.address?.line1 || t.address_line1 || t.billing_address || "",
      address_line2: t.address?.line2 || t.address_line2 || "",
      city: t.address?.city || t.city || t.billing_city || "",
      state: t.address?.state || t.address?.province || t.state || t.province || "",
      postal_code: t.address?.postal_code || t.address?.postcode || t.postal_code || t.billing_postal_code || "",
      country: t.address?.country || t.address_country || t.country || t.nationality || "",
      billing_company: t.invoice_company || "",
      billing_tax_id: t.billing_tax_id || "",
      billing_email: t.billing_email || t.email,
      billing_address: t.billing_address || "",
      frequent_flyer_program: t.frequent_flyer_program || "",
      frequent_flyer_number: t.frequent_flyer_number || "",
      known_traveler_number: t.known_traveler_number || "",
      redress_number: t.redress_number || "",
      emergency_contact_name: t.emergency_contact_name || "",
      emergency_contact_relationship: t.emergency_contact_relationship || "",
      emergency_contact_phone: t.emergency_contact_phone || "",
      emergency_contact_email: t.emergency_contact_email || "",
      meal_preference: t.meal_preference || "",
      special_assistance: t.special_assistance || "",
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
      const selectResult = await setSelectValue(element, [expected], options.exactOption || null);
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

  function targetLocalDispatchIdentity(decision = {}, map = agent.pageMap || buildPageMap()) {
    const controlId = decision.controlId || decision.targetSnapshot?.controlId || "";
    const control = (map.controls || []).find((item) => item.controlId === controlId) || null;
    const selectedStrategy = decision.pipelineContract?.capability?.selectedStrategy || {};
    const actuatorStableKey = selectedStrategy.actuatorStableKey
      || [
        control?.stableKey || controlId,
        decision.operation || "",
        (control?.actuators || []).find((item) => item.nodeId === decision.targetId)?.relation || "",
        decision.targetId || (decision.visualRegion ? "visual-region" : "")
      ].join("::");
    const surface = map.currentSurface || {};
    const surfaceInstanceKey = stableHash(JSON.stringify({
      step: map.step || "unknown",
      surfaceId: surface.id || "surface-page",
      surfaceType: surface.type || "page",
      surfaceInstanceId: surface.instanceId || "",
      decisionGroupId: decision.decisionGroupId || control?.decisionGroupId || "",
      requirementId: decision.requirementId
        || decision.pipelineContract?.requirement?.requirementId
        || ""
    }));
    const strategySignature = [
      decision.pipelineContract?.requirement?.requirementId || decision.requirementId || "",
      decision.pipelineContract?.component?.componentIdentity || control?.stableKey || controlId,
      actuatorStableKey,
      decision.operation || "",
      decision.interactionMethod || decision.action || ""
    ].join("::");
    const localStrategies = [
      ...Object.values(control?.operations || {}).flatMap((capability) => capability?.strategies || []),
      ...Object.values(control?.recovery || {}).flatMap((recovery) => recovery?.strategies || [])
    ].filter((strategy) => !selectedStrategy.actuatorStableKey
      || strategy.actuatorStableKey === selectedStrategy.actuatorStableKey);
    const targetLocalStateKey = stableHash(JSON.stringify({
      stableControlKey: control?.stableKey || controlId,
      state: control ? {
        disabled: control.state?.disabled === true || control.disabled === true,
        expanded: control.state?.expanded === true,
        checked: control.state?.checked === true,
        selected: control.state?.selected === true || control.selected === true,
        normalizedValue: String(
          control.state?.canonicalDateValue
          || control.state?.selectedValue
          || control.state?.normalizedValue
          || control.currentCanonicalValue
          || control.currentValue
          || ""
        ),
        optionValue: String(control.state?.optionValue || ""),
        visibleWidgetElementId: String(control.visibleWidgetElementId || "")
      } : null,
      actuator: localStrategies.map((strategy) => ({
        actuatorStableKey: strategy.actuatorStableKey || "",
        status: strategy.status || "",
        visible: strategy.proof?.visible === true,
        enabled: strategy.proof?.enabled === true,
        hitTested: strategy.proof?.hitTested === true,
        notOccluded: strategy.proof?.notOccluded === true
      })).sort((a, b) => a.actuatorStableKey.localeCompare(b.actuatorStableKey))
    }));
    return {
      strategySignature,
      actuatorStableKey,
      surfaceInstanceKey,
      targetLocalStateKey
    };
  }

  function failedLocalStrategyForDecision(decision = {}, map = agent.pageMap || buildPageMap()) {
    const identity = targetLocalDispatchIdentity(decision, map);
    return (agent.failedLocalStrategies || []).find((entry) => (
      entry.strategySignature === identity.strategySignature
      && entry.surfaceInstanceKey === identity.surfaceInstanceKey
      && entry.targetLocalStateKey === identity.targetLocalStateKey
    )) || null;
  }

  function rememberFailedLocalStrategy(decision = {}, map = agent.pageMap || buildPageMap(), code = "") {
    const identity = targetLocalDispatchIdentity(decision, map);
    const existing = failedLocalStrategyForDecision(decision, map);
    if (existing) {
      existing.failureCount = Number(existing.failureCount || 1) + 1;
      existing.code = code || existing.code || "";
      return existing;
    }
    const entry = {
      ...identity,
      controlId: decision.controlId || decision.targetSnapshot?.controlId || "",
      operation: decision.operation || "",
      interactionMethod: decision.interactionMethod || decision.action || "",
      code: String(code || "OUTCOME_NOT_VERIFIED"),
      failureCount: 1
    };
    agent.failedLocalStrategies = [...(agent.failedLocalStrategies || []), entry].slice(-80);
    return entry;
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
      stableKey: control?.stableKey || "",
      decisionGroupId: control?.decisionGroupId || "",
      controlKind: control?.kind || "",
      state: control?.state || null,
      operations: control?.operations || {},
      recovery: control?.recovery || {},
      ownershipIntegrity: control?.ownershipIntegrity || null,
      actuators: control?.actuators || [],
      stateElementId: control?.stateElementId || "",
      visibleWidgetElementId: control?.visibleWidgetElementId || "",
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
    const exactActionability = actuatorActionability(
      element,
      map.currentSurface || { id: "surface-page", type: "page" },
      decision.operation || decision.action || "activate"
    );
    if (!exactActionability.rendered) return { ok: false, code: "TARGET_NOT_RENDERED", expected: expected || null, live, actionability: exactActionability };
    if (!exactActionability.visible) return { ok: false, code: "TARGET_NOT_VISIBLE", expected: expected || null, live, actionability: exactActionability };
    if (!exactActionability.enabled) return { ok: false, code: "TARGET_DISABLED", expected: expected || null, live, actionability: exactActionability };
    if (!exactActionability.inCurrentSurface) return { ok: false, code: "TARGET_OUTSIDE_CURRENT_SURFACE", expected: expected || null, live, actionability: exactActionability };
    if (!exactActionability.inViewport) return { ok: false, code: "TARGET_OUT_OF_VIEW", expected: expected || null, live, actionability: exactActionability };
    if (!exactActionability.hitTested || !exactActionability.notOccluded) {
      return { ok: false, code: "TARGET_OCCLUDED", expected: expected || null, live, actionability: exactActionability };
    }
    if (!expected) return { ok: true, live, expected: null };
    const warnings = [];
    const strictSurface = isStrictActionSurfaceType(expected.surfaceType);
    const expectedControlId = expected.controlId || decision.controlId || "";
    const liveControlId = live.controlId || element?.dataset?.atwControlId || "";
    const expectedDecisionGroupId = expected.decisionGroupId || decision.decisionGroupId || "";
    if (expectedDecisionGroupId && live.decisionGroupId && expectedDecisionGroupId !== live.decisionGroupId) {
      const observationScopedOwnershipLink = Boolean(
        expected.semanticOwnershipLinkId
        && expected.policyCorrectionForDecisionGroupId
        && expected.policyCorrectionForDecisionGroupId === decision.decisionGroupId
        && expectedControlId
        && liveControlId
        && expectedControlId === liveControlId
      );
      if (!observationScopedOwnershipLink) {
        return { ok: false, code: "TARGET_DECISION_GROUP_MISMATCH", expected, live };
      }
      warnings.push({
        code: "TARGET_DECISION_GROUP_LINKED_ACROSS_SURFACES",
        expectedDecisionGroupId,
        liveDecisionGroupId: live.decisionGroupId,
        semanticOwnershipLinkId: expected.semanticOwnershipLinkId
      });
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
      const recovery = decision.boundedRecovery === true
        ? expected.recovery?.[governedOperation] || live.recovery?.[governedOperation] || null
        : null;
      const allowed = new Set(recovery
        ? [
            ...(recovery.actuatorIds || []),
            ...(recovery.strategies || []).map((strategy) => strategy.actuatorId)
          ]
        : capability?.actuatorIds || []);
      if ((!capability && !recovery) || !allowed.has(live.id)) {
        return { ok: false, code: "ACTION_OPERATION_ACTUATOR_MISMATCH", expected, live };
      }
    }
    if (
      live.ownershipIntegrity?.ok === false
      && (live.ownershipIntegrity.conflictingNodeIds || []).includes(live.id)
    ) {
      return { ok: false, code: "SELECTED_ACTUATOR_OWNERSHIP_CONFLICT", expected, live };
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

    return { ok: true, expected, live, warnings, actionability: exactActionability };
  }

  function validateVisualCoordinateTarget(decision = {}, hit, map = agent.pageMap || buildPageMap()) {
    const expected = decision.targetSnapshot || {};
    const region = decision.visualRegion || expected.visualRegion || null;
    const x = Number(decision.x);
    const y = Number(decision.y);
    const values = [x, y, Number(region?.x), Number(region?.y), Number(region?.width), Number(region?.height)];
    const controlledRecovery = expected.source === "visual_control_recovery";
    let controlledRecoveryControl = null;
    let controlledRecoveryWrapper = null;
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
      const wrapperMember = (control.actuators || []).find((item) => (
        item.relation === "wrapper"
        && item.nodeId
        && item.nodeId !== control.stateElementId
        && boxesCloseEnough(item.box, region)
      ));
      controlledRecoveryControl = control;
      controlledRecoveryWrapper = wrapperMember ? elementById(wrapperMember.nodeId) : null;
      if (!controlledRecoveryWrapper
        || !isVisible(controlledRecoveryWrapper)
        || isDisabledLike(controlledRecoveryWrapper)) {
        return { ok: false, code: "VISUAL_CONTROL_WRAPPER_UNAVAILABLE", expected, live: liveTargetSnapshot(hit, map) };
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
    const disabledStateIntercept = Boolean(
      controlledRecoveryWrapper
      && controlledRecoveryControl
      && elementId(hit) === controlledRecoveryControl.stateElementId
      && isDisabledLike(hit)
    );
    if (!disabledStateIntercept && (
      rect.width < 2
      || rect.height < 2
      || style.visibility === "hidden"
      || style.display === "none"
      || style.pointerEvents === "none"
      || Number(style.opacity || 1) < 0.15
      || isDisabledLike(hit)
    )) {
      return { ok: false, code: "VISUAL_TARGET_NOT_ACTIONABLE", expected, live: liveTargetSnapshot(hit, map) };
    }
    if (decision.risk !== "safe") {
      return { ok: false, code: "VISUAL_RISK_UNAPPROVED", expected, live: liveTargetSnapshot(hit, map) };
    }
    return {
      ok: true,
      expected,
      live: liveTargetSnapshot(hit, map),
      warnings: [],
      dispatchTarget: controlledRecoveryWrapper || hit
    };
  }

  function pageSnapshot(label = "") {
    const map = agent.pageMap || buildPageMap();
    return {
      label,
      url: location.href,
      site: map.site,
      // The extension reports observed facts and capabilities only. Checkout
      // stage is reduced authoritatively by the backend from this payload.
      step: "unknown",
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

  function isDestinationReadinessDecision(decision = {}) {
    if (decision.action !== "wait") return false;
    const intent = `${decision.intent || ""} ${decision.semanticIntent || ""}`.toLowerCase();
    return /wait_for_ready_observation|reobserve_after_transient_observation|reobserve_degraded_loading_destination|wait_for_navigation_enablement|reobserve_blocked_navigation_settling|reobserve_after_grounding_rejection/.test(intent)
      || (decision.expectedPostconditions || []).some((postcondition) => (
        (postcondition?.type === "observation_readiness" && postcondition?.status === "READY")
        || postcondition?.type === "navigation_enabled_or_blocker_identified"
      ));
  }

  function clearDestinationWait(reason = "cleared") {
    if (agent.destinationWaitTimer) {
      clearTimeout(agent.destinationWaitTimer);
      agent.destinationWaitTimer = null;
    }
    if (agent.destinationWait) {
      logFlow("destination_wait.exit", {
        reason,
        startedAt: agent.destinationWait.startedAt,
        attempts: agent.destinationWait.attempts,
        backendWaits: agent.destinationWait.backendWaits
      });
    }
    agent.destinationWait = null;
  }

  function expireDestinationWait(reason = "timeout") {
    const wait = agent.destinationWait;
    clearDestinationWait(reason);
    if (!agent.running) return;
    agent.running = false;
    agent.awaiting = "manual";
    setAgentActivity(
      "Destination did not become ready",
      "The page did not expose usable checkout controls before the bounded readiness timeout."
    );
    addAgentMessage(
      "assistant",
      "The destination stayed incomplete for too long. I stopped without guessing; please check whether the site is still loading."
    );
    renderSidebar("agent");
  }

  function beginDestinationWait(decision = {}) {
    const now = Date.now();
    const existing = agent.destinationWait;
    const backendStartedAt = Number(decision.readinessStartedAt || 0);
    const backendDeadlineAt = Number(decision.readinessDeadlineAt || 0);
    agent.destinationWait = {
      status: "WAITING_FOR_DESTINATION",
      startedAt: backendStartedAt > 0 ? backendStartedAt : (existing?.startedAt || now),
      deadlineAt: backendDeadlineAt > 0 ? backendDeadlineAt : (existing?.deadlineAt || (now + DESTINATION_WAIT_TIMEOUT_MS)),
      attempts: Number(existing?.attempts || 0),
      backendWaits: Number(existing?.backendWaits || 0) + 1,
      wakeRequested: true,
      lastWakeReason: "backend_wait",
      lastMutationAt: Number(existing?.lastMutationAt || 0),
      deadlineObservationSent: Boolean(existing?.deadlineObservationSent),
      observationId: decision.observationId || existing?.observationId || "",
      actionId: decision.actionId || decision.id || existing?.actionId || ""
    };
    agent.loopRerunQueued = true;
    setAgentActivity(
      "Waiting for destination",
      "Navigation completed, but the destination controls are still hydrating. I will continue automatically."
    );
    renderSidebar("agent");
    logFlow("destination_wait.enter", {
      observationId: agent.destinationWait.observationId,
      backendWaits: agent.destinationWait.backendWaits,
      deadlineAt: new Date(agent.destinationWait.deadlineAt).toISOString()
    });
    return agent.destinationWait;
  }

  function scheduleDestinationObservation(reason = "scheduled", delay = DESTINATION_RETRY_INTERVAL_MS) {
    const wait = agent.destinationWait;
    if (!wait || !agent.running) return false;
    wait.wakeRequested = true;
    wait.lastWakeReason = reason;
    if (reason === "dom_mutation") wait.lastMutationAt = Date.now();
    if (Date.now() >= wait.deadlineAt) {
      if (wait.deadlineObservationSent) {
        expireDestinationWait("backend_deadline_confirmed");
        return false;
      }
      wait.deadlineObservationSent = true;
      delay = 0;
    }
    // A loop/request already in progress owns the next observation. Its
    // finally block will consume the durable wake request.
    if (agent.loopBusy || agent.activePlannerRequest || agent.destinationWaitTimer) return false;
    const remaining = Math.max(0, wait.deadlineAt - Date.now());
    const boundedDelay = Math.min(Math.max(0, delay), remaining);
    agent.destinationWaitTimer = setTimeout(() => {
      agent.destinationWaitTimer = null;
      const current = agent.destinationWait;
      if (!current || !agent.running) return;
      if (Date.now() >= current.deadlineAt && !current.deadlineObservationSent) {
        current.deadlineObservationSent = true;
      }
      if (agent.loopBusy || agent.activePlannerRequest) {
        scheduleDestinationObservation("request_still_active", DESTINATION_RETRY_INTERVAL_MS);
        return;
      }
      current.wakeRequested = false;
      current.attempts += 1;
      logFlow("destination_wait.reobserve", {
        reason: current.lastWakeReason || reason,
        attempts: current.attempts,
        elapsedMs: Date.now() - current.startedAt
      });
      processCheckoutAgent();
    }, boundedDelay);
    return true;
  }

  function resetAgentLoopLifecycle(reason = "reset") {
    agent.lifecycleId += 1;
    agent.loopRerunQueued = false;
    clearDestinationWait(reason);
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
    const currentMap = pageStateStore
      ? pageStateStore.observe({ reason: "stale_action_check" }).map
      : rememberPagePlan(buildPageMap());
    const current = observationHashForMap(currentMap);
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
    // This flag describes only the browser-local postcondition. Durable parent
    // progress is evaluated by TaskState after the fresh observation, so the
    // result can never claim verified=true while postconditionSatisfied=false.
    const postconditionSatisfied = Boolean(verification.ok);
    const result = {
      at: new Date().toISOString(),
      actionId,
      observationId,
      plannedObservationId: decision.observationId || "",
      observationHash: decision.observationHash || "",
      requirementId: decision.requirementId || "",
      intent: decision.intent || "",
      semanticIntent: decision.semanticIntent || decision.intent || "",
      mechanicalEffect: decision.mechanicalEffect || decision.physicalEffect || "",
      expectedPostconditions: Array.isArray(decision.expectedPostconditions) ? decision.expectedPostconditions : [],
      operation: decision.operation || "",
      goalId: decision.goalId || "",
      decisionInstanceId: decision.decisionInstanceId || "",
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
        semanticIntent: decision.semanticIntent || decision.intent || "",
        mechanicalEffect: decision.mechanicalEffect || decision.physicalEffect || "",
        expectedPostconditions: Array.isArray(decision.expectedPostconditions) ? decision.expectedPostconditions : [],
        operation: decision.operation || "",
        interactionMethod: decision.interactionMethod || "",
        boundedRecovery: decision.boundedRecovery === true,
        pipelineContract: decision.pipelineContract || null,
        capabilityStatus: decision.capabilityStatus || "",
        executionChannel: decision.executionChannel || "",
        affordance: decision.affordance || null,
        controlId: decision.controlId || decision.targetSnapshot?.controlId || "",
        targetId: decision.targetId || "",
        targetLabel: decision.targetLabel || "",
        value: decision.value || "",
        risk: decision.risk || "",
        reason: decision.reason || "",
        decisionInstanceId: decision.decisionInstanceId || ""
      },
      targetSnapshot: decision.targetSnapshot || null,
      expectedOutcome,
      outcome: verification
    };
    if (!verification.ok) {
      rememberFailedLocalStrategy(decision, agent.pageMap || buildPageMap(), verification.code || "OUTCOME_NOT_VERIFIED");
    }
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
      semanticIntent: decision.semanticIntent || decision.intent || "",
      mechanicalEffect: decision.mechanicalEffect || decision.physicalEffect || "",
      expectedPostconditions: Array.isArray(decision.expectedPostconditions) ? decision.expectedPostconditions : [],
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
        semanticIntent: decision.semanticIntent || decision.intent || "",
        mechanicalEffect: decision.mechanicalEffect || decision.physicalEffect || "",
        expectedPostconditions: Array.isArray(decision.expectedPostconditions) ? decision.expectedPostconditions : [],
        operation: decision.operation || "",
        interactionMethod: decision.interactionMethod || "",
        boundedRecovery: decision.boundedRecovery === true,
        pipelineContract: decision.pipelineContract || null,
        capabilityStatus: decision.capabilityStatus || "",
        executionChannel: decision.executionChannel || "",
        affordance: decision.affordance || null,
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
          page: compactPageMap(agent.pageMap || pageStateStore.observe({ reason: "session_start" }).map)
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
      const map = pageStateStore.observe({ reason: "action_report" }).map;
      const authoritativeResult = compactActionResultForTransport({
        ...(agent.lastActionResult || {}),
        ...result,
        actionId: result.actionId || agent.lastActionResult?.actionId || agent.activeExecutionActionId || "",
        observationId: result.observationId || agent.lastActionResult?.observationId || agent.activeExecutionObservationId || ""
      });
      const pageReference = {
        site: map.site || location.host,
        url: location.href,
        step: map.step || "unknown",
        snapshotHash: observationHashForMap(map),
        surfaceId: map.currentSurface?.id || "surface-page",
        surfaceType: map.currentSurface?.type || "page",
        errors: actionableCheckoutErrors(map.errors || []).slice(0, 4)
      };
      const reportBody = JSON.stringify({
        sessionId: agent.sessionId,
        result: {
          ...authoritativeResult,
          stage: authoritativeResult.stage || pageReference.step,
          errors: authoritativeResult.errors || pageReference.errors
        },
        // The next observation carries the complete canonical page. Result
        // persistence only needs enough fresh identity to advance the durable
        // action lifecycle, not hundreds of destination controls.
        page: pageReference
      });
      let session = null;
      let lastError = null;
      for (let attempt = 1; attempt <= ACTION_REPORT_MAX_ATTEMPTS; attempt += 1) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), ACTION_REPORT_TIMEOUT_MS);
        const startedAt = performance.now();
        try {
          const response = await fetch(`${settings.apiBase || DEFAULT_API}/agent/report`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: reportBody,
            signal: controller.signal
          });
          if (!response.ok) {
            const error = new Error(`agent report returned ${response.status}`);
            error.retryable = response.status >= 500;
            throw error;
          }
          session = await response.json();
          logFlow("action.report.acknowledged", {
            actionId: authoritativeResult.actionId || "",
            attempt,
            duration_ms: Math.round(performance.now() - startedAt),
            resultAt: authoritativeResult.at || "",
            page: pageReference
          });
          break;
        } catch (error) {
          lastError = error;
          const retryable = error.name === "AbortError" || error.retryable === true || error instanceof TypeError;
          logFlow("action.report.attempt_failed", {
            actionId: authoritativeResult.actionId || "",
            attempt,
            retryable,
            duration_ms: Math.round(performance.now() - startedAt),
            error: error.message || error.name || "Action report failed"
          });
          if (!retryable || attempt >= ACTION_REPORT_MAX_ATTEMPTS) throw error;
          setAgentActivity("Saving action result", `Retrying durable result acknowledgement (${attempt + 1}/${ACTION_REPORT_MAX_ATTEMPTS}).`);
        } finally {
          clearTimeout(timeout);
        }
      }
      if (!session) throw lastError || new Error("agent report did not return a session");
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
    const normalizeRouteEndpoint = (value = "") => {
      const endpoint = String(value || "")
        .replace(/^(?:from|to|departure|arrival)\s*:?\s*/i, "")
        .replace(/\s+/g, " ")
        .trim();
      const airportCode = endpoint.match(/(?:^|\s|\()([A-Z]{3})(?:\)|\s|$)/)?.[1];
      return (airportCode || endpoint).slice(0, 80).toUpperCase();
    };
    const reservedRouteEndpoint = (value = "") => {
      const tokens = String(value || "").toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
      const reserved = new Set([
        "trip", "summary", "primary", "passenger", "checked", "baggage",
        "travel", "insurance", "direct", "flight", "booking", "payment",
        "overview", "contact", "details", "ticket", "fare", "seat", "seating"
      ]);
      return !tokens.length || tokens.every((token) => reserved.has(token));
    };
    const routeUtilityText = (value = "") => /\b(?:phone|mobile|telephone|sms|text message|email|e-mail|wifi|wi-fi|data plan|valid number|enter a number|country code)\b/i.test(String(value || ""));
    const directElementText = (element) => Array.from(element?.childNodes || [])
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent || "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    const visibleElementText = (element, limit = 720) => String(
      element?.innerText || element?.textContent || element?.getAttribute?.("aria-label") || ""
    ).replace(/\s+/g, " ").trim().slice(0, limit);
    const itineraryCommand = (element) => /\b(?:view|show|open)\s+(?:full\s+)?(?:flight\s+)?(?:itinerary|trip details|flight details)\b/i.test(
      String(element?.innerText || element?.textContent || element?.getAttribute?.("aria-label") || "")
    );
    const routeSeparator = /(?:→|–|—|\bto\b)/i;
    const routeDateCue = /\b(?:mon|tue|wed|thu|fri|sat|sun)(?:day)?\s+\d{1,2}(?:\s+[\p{L}]+)?(?:\s+20\d{2})?\b|\b20\d{2}-\d{2}-\d{2}\b/iu;
    const itineraryControlOwners = queryAllDeep("button, a, [role='button'], [role='link']")
      .filter((element) => isVisible(element) && itineraryCommand(element))
      .map((control) => {
        let owner = control.parentElement;
        for (let depth = 0; owner && depth < 7; depth += 1, owner = owner.parentElement) {
          if (!isVisible(owner)) continue;
          const ownerText = visibleElementText(owner);
          if (!ownerText || ownerText.length > 720 || routeUtilityText(ownerText)) continue;
          const prefix = ownerText.split(routeDateCue)[0].replace(/\b(?:view|show|open)\s+(?:full\s+)?(?:flight\s+)?(?:itinerary|trip details|flight details)\b.*$/i, "").trim();
          const unseparatedPair = /^\p{L}[\p{L}.'’-]*(?:\s+\p{L}[\p{L}.'’-]*)?\s+\p{L}[\p{L}.'’-]*(?:\s+\p{L}[\p{L}.'’-]*)?$/u.test(prefix);
          if ((routeSeparator.test(ownerText) || unseparatedPair) && routeDateCue.test(ownerText)) return owner;
        }
        return null;
      })
      .filter(Boolean);
    // Checkout sites frequently render the persistent selected route as an
    // ordinary styled div/span rather than a semantic heading. Read only a
    // small, exact route-shaped owner; never infer a route from page-wide text.
    const checkoutRouteContext = Boolean(
      price
      || decisionGroups.length
      || /\b(?:booking|checkout|passengers?|ticket fare|seating|overview\s*(?:&|and)\s*payment)\b/i.test(text)
    );
    const boundedRouteSegments = queryAllDeep("h1, h2, h3, h4, h5, h6, [role='heading'], [aria-label*='route' i], [data-testid*='route' i], main div, main span, [role='main'] div, [role='main'] span, form div, form span")
      .filter((element) => isVisible(element))
      .map((element) => {
        const directText = directElementText(element);
        const label = directText || ((element.children?.length || 0) <= 6 ? visibleElementText(element, 180) : "");
        return { element, label };
      })
      .filter(({ label }) => label.length >= 5 && label.length <= 180 && !routeUtilityText(label))
      .map(({ element, label }, index) => {
        const semanticOwner = /^h[1-6]$/i.test(element.tagName || "")
          || implicitRole(element) === "heading"
          || /route|itinerary/i.test(`${element.getAttribute?.("aria-label") || ""} ${element.getAttribute?.("data-testid") || ""}`);
        const explicitVisualSeparator = /[→–—]/.test(label);
        if (!semanticOwner && (!checkoutRouteContext || !explicitVisualSeparator)) return null;
        const match = label.match(/^(.{2,80}?)\s*(?:→|–|—|\bto\b)\s*(.{2,80}?)$/i);
        if (!match) return null;
        const origin = normalizeRouteEndpoint(match[1]);
        const destination = normalizeRouteEndpoint(match[2]);
        if (!origin || !destination || origin === destination || reservedRouteEndpoint(origin) || reservedRouteEndpoint(destination)) return null;
        const localText = visibleElementText(element.parentElement, 320);
        const ownedDate = localText.match(routeDateCue)?.[0] || "";
        return {
          segmentId: `bounded_route_${index + 1}_${stableHash(`${origin}:${destination}:${ownedDate}`)}`,
          origin,
          destination,
          departureDate: ownedDate,
          departureTime: "",
          arrivalTime: "",
          flightNumber: "",
          confidence: semanticOwner ? 0.88 : 0.84,
          evidence: {
            source: semanticOwner ? "owned_route_heading" : "bounded_checkout_route",
            ownerKey: stableHash(`${element.tagName || "element"}:${label}`),
            authoritative: true
          }
        };
      })
      .filter(Boolean)
      .filter((segment, index, segments) => segments.findIndex((candidate) => (
        candidate.origin === segment.origin
        && candidate.destination === segment.destination
        && candidate.departureDate === segment.departureDate
      )) === index);
    const explicitRouteOwners = queryAllDeep("[data-testid*='itinerary' i], [data-testid*='route' i], [aria-label*='itinerary' i], [aria-label*='route' i], h1, h2, h3");
    const ownedRouteSegments = [...new Set([...explicitRouteOwners, ...itineraryControlOwners])]
      .filter((element) => isVisible(element))
      .map((element) => ({
        element,
        label: String(element.innerText || element.textContent || element.getAttribute("aria-label") || "")
          .replace(/\s+/g, " ")
          .trim()
      }))
      .filter(({ label }) => label.length >= 5 && label.length <= 520 && !routeUtilityText(label))
      .map(({ element, label }, index) => {
        const separated = label.match(/(?:^|\b)([\p{L}][\p{L} .'’-]{1,70}?(?:\s+[A-Z]{3})?)\s*(?:→|–|—|\bto\b)\s*((?:[A-Z]{3}\s+)?[\p{L}][\p{L} .'’-]{1,70}?)(?=\s+(?:mon|tue|wed|thu|fri|sat|sun|view|passenger|flight|booking|$)|$)/iu);
        const prefix = label
          .split(/\b(?:mon|tue|wed|thu|fri|sat|sun)(?:day)?\b|\bview\s+(?:full\s+)?itinerary\b/i)[0]
          .trim();
        const ownedItineraryCue = itineraryControlOwners.includes(element)
          || /itinerary|route/i.test(`${element.getAttribute?.("aria-label") || ""} ${element.getAttribute?.("data-testid") || ""}`)
          || (/\b(?:view|show|open)\s+(?:full\s+)?(?:flight\s+)?(?:itinerary|trip details|flight details)\b/i.test(label)
            && /\b(?:mon|tue|wed|thu|fri|sat|sun)(?:day)?\b/i.test(label));
        const unseparated = !separated
          && ownedItineraryCue
          && /^\p{L}[\p{L}.'’-]*\s+\p{L}[\p{L}.'’-]*$/u.test(prefix)
          ? prefix.split(/\s+/)
          : null;
        const origin = normalizeRouteEndpoint(separated?.[1] || unseparated?.[0] || "");
        const destination = normalizeRouteEndpoint(separated?.[2] || unseparated?.[1] || "");
        if (!origin || !destination || origin === destination || reservedRouteEndpoint(origin) || reservedRouteEndpoint(destination)) return null;
        const ownedDate = label.match(/\b(?:mon|tue|wed|thu|fri|sat|sun)(?:day)?\s+\d{1,2}\s+[\p{L}]+(?:\s+20\d{2})?\b/iu)?.[0] || "";
        const flight = label.match(/\b([A-Z]{2}|[A-Z]\d|\d[A-Z])\s*([0-9]{2,4})\b/) || null;
        return {
          segmentId: `owned_route_${index + 1}_${stableHash(`${origin}:${destination}:${ownedDate}`)}`,
          origin,
          destination,
          departureDate: ownedDate,
          departureTime: "",
          arrivalTime: "",
          flightNumber: flight ? `${flight[1]}${flight[2]}` : "",
          confidence: /itinerary|flight|booking|view full/i.test(label) ? 0.88 : 0.8,
          evidence: {
            source: itineraryControlOwners.includes(element) ? "itinerary_control_owner" : "owned_route_structure",
            ownerKey: stableHash(`${element.tagName || "element"}:${label.slice(0, 240)}`),
            authoritative: true
          }
        };
      })
      .filter(Boolean)
      .filter((segment, index, segments) => segments.findIndex((candidate) => (
        candidate.origin === segment.origin
        && candidate.destination === segment.destination
        && candidate.departureDate === segment.departureDate
      )) === index);
    const dates = [
      ...[...text.matchAll(/\b20\d{2}-\d{2}-\d{2}\b/g)].map((match) => match[0]),
      ...[...text.matchAll(/\b(?:mon|tue|wed|thu|fri|sat|sun)(?:day)?\s+\d{1,2}\s+[\p{L}]+\s+20\d{2}\b/giu)].map((match) => match[0])
    ];
    const timePairs = [...text.matchAll(/\b(\d{1,2}:\d{2})\s*(?:-|–|—|to)\s*(\d{1,2}:\d{2})\b/gi)];
    const flights = [...text.matchAll(/\b([A-Z]{2}|[A-Z]\d|\d[A-Z])\s*([0-9]{2,4})\b/g)]
      .map((match) => `${match[1]}${match[2]}`)
      .filter((value) => !/^20\d{2}$/.test(value));
    const segments = (attributeSegments.length
      ? attributeSegments.map((segment) => ({
          ...segment,
          evidence: { source: "structured_itinerary_attributes", ownerKey: segment.segmentId, authoritative: true }
        }))
      : ownedRouteSegments.length
        ? ownedRouteSegments
        : boundedRouteSegments.length
          ? boundedRouteSegments
          : [])
      .map(({ confidence, ...segment }) => segment)
      .slice(0, 12);
    const completeness = !segments.length
      ? "unknown"
      : segments.every((segment) => segment.origin && segment.destination && segment.departureDate)
        ? "complete"
        : "partial";
    const baseFareMatch = text.match(/\b(?:price per (?:adult|passenger)|flight ticket|base fare)\s*[:\-]?\s*(\d+(?:[.,]\d{1,2})?)\s*(EUR|USD|GBP|CHF|CAD|AUD|€|\$|£)\b/i);
    const canonicalFareLabel = (value = "") => String(value || "")
      .replace(/\b(?:continue with|ticket type|fare type|fare brand|ticket class|fare class|cabin class|travel class)\b/gi, " ")
      .replace(/^\s*\d+\s*x\s*/i, "")
      .replace(/\s+\b(?:edit|change|modify|details|selected)\b.*$/i, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    const ownedFareRows = queryAllDeep("h1, h2, h3, h4, h5, h6, [role='heading'], dt, th, [data-testid*='fare' i], [data-testid*='ticket' i], [aria-label*='fare' i], [aria-label*='ticket' i]")
      .filter((element) => isVisible(element))
      .filter((element) => /^(?:ticket type|fare type|fare brand|ticket class|fare class|cabin class|travel class)$/i.test(
        directElementText(element) || visibleElementText(element, 120)
      ))
      .map((heading) => {
        let sibling = heading.nextElementSibling;
        for (let offset = 0; sibling && offset < 4; offset += 1, sibling = sibling.nextElementSibling) {
          if (!isVisible(sibling)) continue;
          const siblingText = visibleElementText(sibling, 180);
          if (!siblingText) continue;
          if (/^h[1-6]$/i.test(sibling.tagName || "") || implicitRole(sibling) === "heading") break;
          if (/^(?:edit|change|modify|details)$/i.test(siblingText)) continue;
          const candidate = canonicalFareLabel(siblingText);
          if (candidate && candidate.length <= 120) {
            return { label: candidate, ownerKey: stableHash(`${heading.tagName || "heading"}:${siblingText}`) };
          }
        }
        let owner = heading.parentElement;
        for (let depth = 0; owner && depth < 5; depth += 1, owner = owner.parentElement) {
          if (!isVisible(owner)) continue;
          const ownerText = visibleElementText(owner, 420);
          if (ownerText.length <= 420 && /\b(?:ticket|fare|cabin|travel)\s+(?:type|brand|class)\b/i.test(ownerText)) {
            const candidate = canonicalFareLabel(ownerText);
            if (candidate && !/^(?:type|brand|class)$/i.test(candidate)) {
              return { label: candidate, ownerKey: stableHash(`${heading.tagName || "heading"}:${ownerText}`) };
            }
          }
        }
        return null;
      })
      .filter(Boolean);
    const ownedFareSummaryLines = queryAllDeep("p, li, dd, td, th, [class*='fare' i], [data-testid*='fare' i], [data-testid*='ticket' i], [aria-label*='fare' i], [aria-label*='ticket' i]")
      .filter((element) => isVisible(element))
      .map((element) => {
        const semanticOwner = /fare|ticket/i.test(`${element.getAttribute?.("class") || ""} ${element.getAttribute?.("data-testid") || ""} ${element.getAttribute?.("aria-label") || ""}`);
        const label = directElementText(element)
          || (semanticOwner ? visibleElementText(element, 140) : "");
        if (!label || label.length > 140) return null;
        const match = label.match(/^(?:\d+\s*x\s*)?([\p{L}][\p{L}0-9 +_'-]{1,80}?)\s+(?:fare|ticket)$/iu);
        const candidate = canonicalFareLabel(match?.[1] || "");
        if (!candidate || /^(?:base|flight|ticket|fare|total|price)$/i.test(candidate)) return null;
        return {
          label: candidate,
          ownerKey: stableHash(`${element.tagName || "element"}:${label}`)
        };
      })
      .filter(Boolean);
    const ownedFare = ownedFareRows[0] || ownedFareSummaryLines[0] || null;
    const fareBrand = canonicalFareLabel(ownedFare?.label || "");
    const currentTraveler = traveler() || {};
    const finalReviewSurface = ["payment", "confirmation"].includes(step)
      && /\b(?:overview\s*(?:&|and)\s*payment|payment review|review your booking|order summary|contact details|pay securely|pay\s+[\d.,]+\s*(?:eur|usd|gbp|try|tl|€|\$|£))\b/i.test(text);
    const source = finalReviewSurface
      ? "payment_summary"
      : activeSurface?.type && activeSurface.type !== "page"
        ? "popup"
        : segments.length
          ? "travel_details"
          : "order_summary";
    const canonicalOutcome = (family = "", label = "", disposition = "") => {
      const meaning = `${label} ${disposition}`.toLowerCase();
      if (family === "seat" && /random|automatic|skip|without.*seat/.test(meaning)) return "random_assignment";
      if (family === "insurance" && /no insurance|without insurance|take the risk|decline|none/.test(meaning)) return "not_included";
      if (family === "baggage" && /included|\b\d+\s*x/.test(meaning) && !/not included|no checked|without/.test(meaning)) return "included";
      if (family === "baggage" && /not included|no checked|without|decline/.test(meaning)) return "not_included";
      if (family === "fare") return "selected";
      return disposition || "selected";
    };
    const outcomeSubject = (family = "", label = "", subjectKey = "") => {
      const meaning = `${subjectKey} ${label}`.toLowerCase();
      if (family === "fare") return "ticket";
      if (family === "seat") return "seat_assignment";
      if (family === "insurance") return "trip_insurance";
      if (family === "baggage" && /checked|hold/.test(meaning)) return "checked_baggage";
      if (family === "baggage" && /cabin|carry.on|hand bag/.test(meaning)) return "cabin_baggage";
      if (family === "baggage" && /personal item/.test(meaning)) return "personal_item";
      return String(subjectKey || label || "selection").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 100);
    };
    const selectedExtras = decisionGroups
      .filter((group) => group.status === "satisfied" && group.selectedLabel)
      .map((group) => {
        const family = group.subject?.family || group.family || "";
        const subjectKey = outcomeSubject(family, group.selectedLabel || "", group.subject?.key || "");
        const disposition = group.selectedEvidence?.disposition || group.selectedSemantic || "";
        return {
          decisionGroupId: group.decisionGroupId || "",
          outcomeKey: family && subjectKey ? `${family}:${subjectKey}` : "",
          family,
          subjectKey,
          label: group.selectedLabel || "",
          disposition,
          outcome: canonicalOutcome(family, group.selectedLabel || "", disposition),
          priceAmount: group.selectedEvidence?.structuredPrice?.amount ?? null,
          currency: group.selectedEvidence?.structuredPrice?.currency || price?.currency || ""
        };
      });
    if (finalReviewSurface) {
      const addReviewOutcome = ({ family, subjectKey, label, outcome, disposition = outcome }) => {
        if (!family || !subjectKey || !label) return;
        selectedExtras.push({
          decisionGroupId: `review_${family}_${subjectKey}`,
          outcomeKey: `${family}:${subjectKey}`,
          family,
          subjectKey,
          label,
          disposition,
          outcome,
          priceAmount: null,
          currency: price?.currency || ""
        });
      };
      const reviewFare = fareBrand;
      if (reviewFare) addReviewOutcome({ family: "fare", subjectKey: "ticket", label: reviewFare, outcome: "selected" });
      if (/\bno travel insurance\b|\bwithout (?:travel )?insurance\b/i.test(text)) {
        addReviewOutcome({ family: "insurance", subjectKey: "trip_insurance", label: "No travel insurance", outcome: "not_included", disposition: "declined" });
      }
      const randomSeat = text.match(/\b(?:\d+\s*x\s*)?(random seat|automatic(?:ally)? assigned seat|seat assigned at check[ -]?in)\b/i)?.[1] || "";
      if (randomSeat) addReviewOutcome({ family: "seat", subjectKey: "seat_assignment", label: randomSeat, outcome: "random_assignment", disposition: "included" });
      const cabinBag = text.match(/\b(?:\d+\s*x\s*)?(cabin baggage|cabin bag|carry[ -]?on bag|hand baggage)(?:\s+\d+(?:[.,]\d+)?\s*kg)?\b/i)?.[0] || "";
      if (cabinBag) addReviewOutcome({ family: "baggage", subjectKey: "cabin_baggage", label: cabinBag, outcome: "included", disposition: "included" });
      const checkedBag = text.match(/\b(?:\d+\s*x\s*)?(checked baggage|checked bag|hold baggage)(?:\s+\d+(?:[.,]\d+)?\s*kg)?\b/i)?.[0] || "";
      if (checkedBag) addReviewOutcome({ family: "baggage", subjectKey: "checked_baggage", label: checkedBag, outcome: "included", disposition: "included" });
    }
    const selectedOutcomes = [...new Map(selectedExtras
      .filter((extra) => extra.family && extra.subjectKey)
      .map((extra) => [extra.outcomeKey || `${extra.family}:${extra.subjectKey}`, extra])).values()]
      .slice(0, 40);
    return {
      evidenceMode: "typed",
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
      fareBrand,
      selectedExtras: selectedOutcomes,
      factEvidence: {
        itinerary: segments.map((segment) => ({
          segmentId: segment.segmentId,
          source: segment.evidence?.source || "owned_route_structure",
          ownerKey: segment.evidence?.ownerKey || segment.segmentId,
          observationId: agent.activeObservationId || "",
          confidence: segment.evidence?.source === "structured_itinerary_attributes" ? 0.95 : 0.88,
          authoritative: segment.evidence?.authoritative === true
        })),
        fareBrand: fareBrand ? {
          source: ownedFareRows[0] ? "review_summary_row" : "owned_fare_summary_line",
          ownerKey: ownedFare?.ownerKey || "",
          observationId: agent.activeObservationId || "",
          confidence: ownedFareRows[0] ? 0.92 : 0.88,
          authoritative: true
        } : null,
        totalPrice: price ? {
          source: finalReviewSurface ? "payment_summary_total" : "owned_price_summary",
          ownerKey: "page_total",
          observationId: agent.activeObservationId || "",
          confidence: 0.9,
          authoritative: true
        } : null,
        travelers: currentTraveler.id ? {
          source: "selected_traveler_profile",
          ownerKey: currentTraveler.id,
          observationId: agent.activeObservationId || "",
          confidence: 1,
          authoritative: true
        } : null
      },
      provenance: [{
        source,
        observationId: agent.activeObservationId || "",
        confidence: attributeSegments.length ? 0.95 : segments.length ? 0.88 : price ? 0.75 : 0.35
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
        commitState: control.commitState ? {
          status: control.commitState.status || "",
          popupClosed: control.commitState.popupClosed === true,
          focusSettled: control.commitState.focusSettled === true,
          actuatorId: control.commitState.actuatorId || ""
        } : null,
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
        selectedValue: group.selectedValue || group.selected?.value || "",
        selectedDisposition: group.selectedEvidence?.disposition || "",
        selectedPrice: group.selectedEvidence?.structuredPrice || null,
        removalControlId: group.removalControlId || ""
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
      transactionFacts: map.transactionFacts ? {
        evidenceMode: map.transactionFacts.evidenceMode,
        itinerary: map.transactionFacts.itinerary,
        travelers: map.transactionFacts.travelers,
        currency: map.transactionFacts.currency,
        basePrice: map.transactionFacts.basePrice,
        totalPrice: map.transactionFacts.totalPrice,
        fareBrand: map.transactionFacts.fareBrand,
        selectedExtras: map.transactionFacts.selectedExtras,
        factEvidence: map.transactionFacts.factEvidence
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

  function controlOwnedText(element) {
    if (!element) return "";
    const role = implicitRole(element);
    const tag = String(element.tagName || "").toLowerCase();
    if (!/button|option|link/.test(`${role} ${tag}`)) return "";
    return compactText(element.innerText || element.textContent || "", 220);
  }

  function controlOwnedEvidence(element) {
    const form = element?.form || element?.closest?.("form") || null;
    return {
      testId: compactText(element?.getAttribute?.("data-testid") || element?.getAttribute?.("data-test-id") || element?.getAttribute?.("data-test") || "", 160),
      formAction: compactText(element?.getAttribute?.("formaction") || form?.getAttribute?.("action") || "", 300),
      formMethod: compactText(element?.getAttribute?.("formmethod") || form?.getAttribute?.("method") || "", 40).toLowerCase(),
      formId: compactText(form?.getAttribute?.("id") || form?.getAttribute?.("name") || "", 160),
      ownText: controlOwnedText(element),
      ariaLabel: compactText(element?.getAttribute?.("aria-label") || "", 220),
      title: compactText(element?.getAttribute?.("title") || "", 220),
      tagName: String(element?.tagName || "").toLowerCase(),
      role: String(implicitRole(element) || "").toLowerCase(),
      type: compactText(element?.getAttribute?.("type") || "", 40).toLowerCase(),
      iconOnly: Boolean(element?.querySelector?.("svg, [class*='icon'], [data-icon]") && !controlOwnedText(element))
    };
  }

  function resolveOwnedControlMeaning(evidence = {}, fallbackSemantic = "", surfaceType = "page") {
    const identity = `${evidence.testId || ""} ${evidence.formId || ""} ${evidence.formAction || ""}`.trim().toLowerCase();
    const ownMeaning = `${evidence.ownText || ""} ${evidence.title || ""}`.trim().toLowerCase();
    const accessibleHint = String(evidence.ariaLabel || "").trim().toLowerCase();
    const strongDismiss = /(?:^|[-_])(dialog|modal|seatmap)?[-_]?close(?:$|[-_])|dismiss|close-button/.test(identity)
      || /^(close|dismiss)( window| dialog| modal)?$/.test(ownMeaning)
      || (evidence.iconOnly && /^(close|dismiss|x)$/.test(accessibleHint));
    const strongAdvance = /submit|continue|proceed|next|saveandcontinue|payment/.test(identity)
      || evidence.type === "submit"
      || /^(continue|next|proceed|submit)( to payment)?$/.test(ownMeaning);
    const strongOpen = /edit|change|open/.test(identity)
      || /^(edit|change|open)\b/.test(ownMeaning);
    const choiceControl = /radio|checkbox|option/.test(`${evidence.role || ""} ${evidence.type || ""}`);
    const explicitDeclineCommand = /^(?:no,?\s*thanks|not now|skip|decline|(?:i(?:'|’)ll )?go without|continue without|without)\b/.test(ownMeaning);

    // Conflicting structural identities are not guessed. A misleading ARIA
    // label alone is contextual evidence and cannot overwrite test-id/form/
    // own-text identity (for example an icon X labelled by its parent CTA).
    if (strongDismiss && (evidence.type === "submit" || /submit|payment/.test(identity))) {
      return { semantic: "unknown", physicalEffect: "unknown", conflict: true };
    }
    if (strongDismiss) return { semantic: "dismiss_surface", physicalEffect: "dismiss_surface", conflict: false };
    if (strongOpen) return { semantic: "open_surface", physicalEffect: "open_surface", conflict: false };
    if (strongAdvance) {
      const checkoutStage = /payment/.test(`${identity} ${ownMeaning}`) || surfaceType === "page";
      return {
        semantic: "continue",
        physicalEffect: checkoutStage ? "advance_checkout_stage" : "advance_surface",
        conflict: false
      };
    }
    if (/decline_paid_extra|decline_baggage|safe_decline|select_free_option/.test(fallbackSemantic)) {
      if (!choiceControl && surfaceType !== "page" && explicitDeclineCommand) {
        return { semantic: fallbackSemantic, physicalEffect: "dismiss_surface", conflict: false };
      }
      return { semantic: fallbackSemantic, physicalEffect: "select_free_option", conflict: false };
    }
    if (/add_paid_extra|select_paid_option/.test(fallbackSemantic)) {
      return { semantic: fallbackSemantic, physicalEffect: "select_paid_option", conflict: false };
    }
    if (/email|phone|name|date_of_birth|passport|field/.test(fallbackSemantic)) {
      return { semantic: fallbackSemantic, physicalEffect: "set_field_value", conflict: false };
    }
    return { semantic: fallbackSemantic || "unknown", physicalEffect: "unknown", conflict: false };
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
    const recoveryAliases = Object.entries(control.recovery || {}).flatMap(([operation, recovery]) =>
      [
        ...(recovery?.actuatorIds || []),
        ...(recovery?.strategies || []).map((strategy) => strategy.actuatorId)
      ].map((aliasId) => ({ aliasId, kind: `recovery:${operation}` }))
    );
    return [
      { aliasId: control.controlId, kind: "control" },
      { aliasId: control.stableKey, kind: "stable_key" },
      { aliasId: control.stateElementId, kind: "state" },
      { aliasId: control.preferredActivationElementId, kind: "activation" },
      { aliasId: control.visualRef, kind: "visual" },
      ...(control.actuators || []).map((actuator) => ({
        aliasId: actuator?.nodeId,
        kind: actuator?.relation || "actuator"
      })),
      ...operationAliases,
      ...recoveryAliases
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
      decision.stableKey,
      decision.targetId,
      decision.visualRef,
      target.controlId,
      target.stableKey,
      target.id,
      target.visualRef,
      target.stateElementId,
      target.preferredActivationElementId,
      ...(target.actuators || []).map((actuator) => actuator?.nodeId),
      ...Object.values(target.operations || {}).flatMap((capability) => capability?.actuatorIds || []),
      ...Object.values(target.recovery || {}).flatMap((recovery) => [
        ...(recovery?.actuatorIds || []),
        ...(recovery?.strategies || []).map((strategy) => strategy.actuatorId)
      ])
    ]
      .map((aliasId) => String(aliasId || "").trim())
      .filter((aliasId, index, list) => aliasId && list.indexOf(aliasId) === index);
  }

  function resolveDecisionTarget(decision, map) {
    const canonicalTargetAction = ["click", "type", "select", "keypress", "scroll"].includes(decision.action);
    if (!canonicalTargetAction) return null;

    const requestedVisualRef = decision.visualRef || decision.targetSnapshot?.visualRef || "";
    const requestedControlId = decision.controlId || decision.targetSnapshot?.controlId || "";
    const aliasIndex = buildCanonicalAliasIndex(map);
    const requestedAliases = decisionTargetAliasIds(decision);
    const unresolvedAliases = requestedAliases.filter((aliasId) => !aliasIndex.resolve(aliasId));
    const resolvedControlIds = [...new Set(requestedAliases
      .map((aliasId) => aliasIndex.resolve(aliasId)?.controlId || "")
      .filter(Boolean))];
    const stableIdentityAliases = [
      requestedControlId,
      decision.stableKey,
      decision.targetSnapshot?.stableKey
    ].map((value) => String(value || "").trim()).filter(Boolean);
    const stableIdentityControlIds = [...new Set(stableIdentityAliases
      .map((aliasId) => aliasIndex.resolve(aliasId)?.controlId || "")
      .filter(Boolean))];
    const visualAnnotation = requestedVisualRef
      ? (map.screenshotAnnotations || []).find((item) => item.visualRef === requestedVisualRef) || null
      : null;
    const boundedStableRebind = stableIdentityControlIds.length === 1;
    const control = boundedStableRebind
      ? aliasIndex.byControlId.get(stableIdentityControlIds[0]) || null
      : requestedAliases.length && !unresolvedAliases.length && resolvedControlIds.length === 1
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
    const recovery = decision.boundedRecovery === true && decision.operation
      ? control.recovery?.[decision.operation] || null
      : null;
    if (decision.operation && !capability && !recovery) {
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
      return ["click", "scroll"].includes(decision.action)
        ? ["state", "activation", "label", "annotation_target", "decision_target"].includes(kind)
          || kind === `recovery:${decision.operation}`
        : kind === "state" && aliasId === control.stateElementId;
    }) || "";
    const candidateIds = (recovery
      ? [
          requestedElementId,
          ...(recovery.actuatorIds || []),
          ...(recovery.strategies || []).map((strategy) => strategy.actuatorId)
        ]
      : capability
      ? [
          requestedElementId,
          capability.actuatorId,
          ...(capability.actuatorIds || [])
        ]
      : ["click", "scroll"].includes(decision.action)
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
        && (!["click", "scroll"].includes(decision.action) || meaningfulActionBox(elementBox(element))));

    if (controlTarget) {
      logFlow("target.resolve", {
        method: requestedElementId ? "exact-canonical-member" : boundedStableRebind && unresolvedAliases.length ? "bounded-stable-rebind" : "canonical-control",
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
    // Global utilities may visually overlap a checkout section (for example a
    // fixed feedback tab on the viewport edge). They are never owned by the
    // checkout merely because their boxes intersect the same geometric band.
    if (isGlobalChromeControl(element)) return false;
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

  function isGlobalChromeControl(element) {
    if (!element) return false;
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

  const FALLBACK_CURRENCY_CODES = new Set([
    "AED", "ARS", "AUD", "BGN", "BHD", "BRL", "CAD", "CHF", "CLP", "CNY",
    "COP", "CZK", "DKK", "EGP", "EUR", "GBP", "HKD", "HRK", "HUF", "IDR",
    "ILS", "INR", "ISK", "JPY", "KRW", "KWD", "MAD", "MXN", "MYR", "NOK",
    "NZD", "OMR", "PEN", "PHP", "PLN", "QAR", "RON", "RSD", "RUB", "SAR",
    "SEK", "SGD", "THB", "TRY", "TWD", "UAH", "USD", "VND", "ZAR"
  ]);
  const SUPPORTED_CURRENCY_CODES = (() => {
    try {
      const supported = typeof Intl.supportedValuesOf === "function"
        ? Intl.supportedValuesOf("currency")
        : [];
      return new Set([...FALLBACK_CURRENCY_CODES, ...supported.map((code) => String(code).toUpperCase())]);
    } catch (_) {
      return FALLBACK_CURRENCY_CODES;
    }
  })();

  function normalizedCurrencyToken(value = "") {
    const token = String(value || "").trim().toUpperCase();
    const symbols = { "€": "EUR", "$": "USD", "£": "GBP", "¥": "JPY", "₩": "KRW", "₹": "INR", "₺": "TRY" };
    if (symbols[token]) return symbols[token];
    if (token === "TL") return "TRY";
    return SUPPORTED_CURRENCY_CODES.has(token) ? token : "";
  }

  function localizedPriceAmount(value = "") {
    const raw = String(value || "").replace(/[\s'’]/g, "");
    if (!/^-?\d[\d.,]*$/.test(raw)) return null;
    const lastDot = raw.lastIndexOf(".");
    const lastComma = raw.lastIndexOf(",");
    const separator = Math.max(lastDot, lastComma);
    let normalized = raw;
    if (separator >= 0) {
      const fractionalDigits = raw.length - separator - 1;
      if (fractionalDigits >= 1 && fractionalDigits <= 2) {
        normalized = `${raw.slice(0, separator).replace(/[.,]/g, "")}.${raw.slice(separator + 1)}`;
      } else {
        normalized = raw.replace(/[.,]/g, "");
      }
    }
    const amount = Number(normalized);
    return Number.isFinite(amount) ? amount : null;
  }

  function structuredPricesFromText(value = "") {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    const numberPattern = "-?\\d(?:[\\d\\s.,'’]*\\d)?";
    // Alphabetic currency codes must be standalone tokens. Without both word
    // boundaries, ordinary labels such as "Country 001" are parsed as
    // "TRY 001", incorrectly turning a free form control into a money-risk
    // action that policy will reject.
    const currencyPattern = "(?:\\b(?:[A-Za-z]{3}|TL)\\b|€|\\$|£|¥|₩|₹|₺)";
    const matches = [
      ...text.matchAll(new RegExp(`(${numberPattern})\\s*(${currencyPattern})`, "gi"))
    ].map((match) => ({
      amount: localizedPriceAmount(match[1]),
      currency: normalizedCurrencyToken(match[2])
    })).concat([
      ...text.matchAll(new RegExp(`(${currencyPattern})\\s*(${numberPattern})`, "gi"))
    ].map((match) => ({
      amount: localizedPriceAmount(match[2]),
      currency: normalizedCurrencyToken(match[1])
    }))).filter((price) => price.amount != null && price.currency);
    return matches.filter((price, index, list) => (
      list.findIndex((other) => other.amount === price.amount && other.currency === price.currency) === index
    ));
  }

  function structuredPriceFromText(value = "") {
    return structuredPricesFromText(value)[0] || null;
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
    if (/no checked baggage|no baggage|without baggage|i.ll go without|go without/.test(text)) return "decline_baggage";
    if (/skip (?:seat|seating)|random seating|random assignment|continue without (?:a )?seat|no seat selection/.test(text)) return "decline_paid_extra";
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
    if (/decline_/.test(semantic)) return "safe_decline";
    if (semantic === "add_paid_extra") return "money";
    if (semantic === "selection_cta") return "uncertain";
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

  function isPlaceholderChoiceValue(value = "") {
    return /^(choose|select|please select|select one|select one option|please choose|month|day|year|title|gender|nationality|country)$/i.test(
      String(value || "").replace(/\s+/g, " ").trim()
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
    const meaningfulValue = value && !isPlaceholderChoiceValue(value) ? value : "";
    const dateField = semantic === "date_of_birth" ? dateFieldEvidenceForElement(element) : null;
    const decodedDate = dateField ? decodeObservedDateValue(value, dateField) : {};
    const exposesChoiceValue = isDropdownLikeElement(element) || implicitRole(element) === "option";
    const valueText = exposesChoiceValue && value && !isPlaceholderChoiceValue(value)
      ? compactText(value, 180)
      : "";
    const choiceLike = Boolean(
      choiceBinding
      || element?.type === "radio"
      || element?.type === "checkbox"
      || ["radio", "checkbox", "option"].includes(implicitRole(element))
    );
    const optionValue = choiceLike
      ? normalizedProfileChoiceValue(choiceLabel(element) || element?.getAttribute?.("value") || "", semantic)
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
    const decisionGroupId = String(decision.decisionGroupId || decision.targetSnapshot?.decisionGroupId || "").trim();
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
    const candidates = [
      associatedLabel,
      nearestLabel,
      optionOwner?.matches?.("label") ? optionOwner : null,
      ...queryAllDeep("button, [role='button']", optionOwner || stateElement.parentElement)
        .filter((candidate) => elementExplicitlyTargetsChoiceState(candidate, stateElement))
    ].filter(Boolean);
    return candidates.filter((candidate, index, list) => (
      candidate !== stateElement
      && (!candidate.matches?.("button, [role='button']") || !isInformationalChoiceUtility(candidate))
      && elementExplicitlyTargetsChoiceState(candidate, stateElement)
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
        structuredPrice: explicitlyIncluded
          ? { amount: 0, currency: "" }
          : (signedCommercialOptionPrice(optionText) || (prices.length === 1 ? prices[0] : null))
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
      nativeRadio ? choiceLabel(stateElement) : ""
    ].filter(Boolean).join(" ");
    const optionText = compactText(rawOptionText, 220);
    const directOptionPrices = structuredPricesFromText(rawOptionText);
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
      || signedOptionPrice
      || (directOptionPrices.length === 1
        ? directOptionPrices[0]
        : optionExplicitlyIncluded
          ? { amount: 0, currency: siblingCurrencies.length === 1 ? siblingCurrencies[0] : "" }
          : null);
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
    const stateElement = stateElementForControl(element);
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
    const fieldClassification = classifyProfileField(stateElement, context.fieldType || context.field || "");
    const fieldType = fieldClassification.fieldType || "";
    const fieldSemantic = semanticFieldType({ label, kind, fieldType, field: context.field || "" });
    const contextualSectionType = context.sectionType || context.section?.type || "";
    const sectionLabel = context.sectionLabel || context.section?.label || "";
    const sectionId = context.sectionId || context.section?.id || "";
    const surface = context.surface || {};
    const fallbackSemantic = fieldType || (/radio|checkbox|option/.test(kind) || presentationBinding
      ? semanticChoiceType(label)
      : (fieldSemantic !== "unknown" ? fieldSemantic : semanticChoiceType(label)));
    const ownedMeaning = resolveOwnedControlMeaning(ownedEvidence, fallbackSemantic, surface.type || "page");
    // Once an exclusive option owner has been reconstructed, broad label
    // parsing must not reintroduce prices from descriptive benefits or sibling
    // content. A missing exact option price remains unknown, not inherited.
    const structuredPrice = presentationBinding
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
    const semantic = fieldType
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
    const sectionType = exactDecisionSectionType && exactDecisionSectionType !== "unknown"
      ? exactDecisionSectionType
      : contextualSectionType;
    const surfaceDecisionGroupId = surface?.type && surface.type !== "page"
      ? (surface.decisionGroupId || decisionGroupIdForContext({ sectionType: surface.taskHint || surface.type || "", sectionLabel: surface.parentSectionLabel || surface.label || surface.taskHint || "" }))
      : "";
    const decisionGroupId = context.decisionGroupId || surfaceDecisionGroupId || decisionGroupIdForContext({
      sectionType,
      sectionLabel: presentationBinding?.ownerLabel || sectionLabel,
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
    const selectLike = stateTag === "select"
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
      semanticConflict: ownedMeaning.conflict === true,
      risk: Number(structuredPrice?.amount) > 0
        ? "money"
        : Number(structuredPrice?.amount) === 0
          ? "safe"
          : choiceRisk(label),
      structuredPrice,
      dateField,
      state,
      choiceContract: presentationBinding ? {
        decisionOwnerId: elementId(presentationBinding.decisionOwner),
        optionOwnerId: elementId(presentationBinding.optionOwner),
        stateControlId: elementId(stateElement),
        actuatorIds: (presentationBinding.actuatorCandidates || []).map((candidate) => candidate.nodeId).filter(Boolean),
        decisionInstance: presentationBinding.decisionInstance || "",
        decisionLabel: presentationBinding.ownerLabel || "",
        optionSemantic: semantic,
        optionPhysicalEffect: physicalEffect || "unknown",
        structuredPrice: structuredPrice || null,
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
      globalChrome: isGlobalChromeControl(stateElement) || isGlobalChromeControl(element),
      stateElementId: elementId(stateElement),
      visibleWidgetElementId: elementId(wrapper || activationElement || stateElement),
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
    model.dateField = control.dateField || model.dateField || null;
    model.decisionGroupId = control.decisionGroupId || model.decisionGroupId || "";
    model.controlKind = control.kind;
    model.controlState = control.state;
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
        (modelValue && !isPlaceholderChoiceValue(modelValue))
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
    const buttonLike = /button/.test(`${control.role || ""} ${control.domRole || ""} ${control.kind || ""}`.toLowerCase());
    const selectedLabel = selectedByState
      ? (control.label || observedValue)
      : (!buttonLike && observedValue && !isPlaceholderChoiceValue(observedValue) ? observedValue : "");
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
    const directPrice = selectedControl.structuredPrice
      || structuredPriceFromText(selected.priceText || "")
      || structuredPriceFromText(selected.label || "");
    const exactDisposition = selectedDisposition({ selected, selectedControl, structuredPrice: directPrice });
    const owner = directPrice ? null : ownedDecisionElement(section, choices, byControlId);
    const ownedPrices = owner ? structuredPricesFromText(owner.innerText || owner.textContent || "") : [];
    const eligibleOwnedPrices = exactDisposition === "free"
      ? ownedPrices.filter((price) => Number(price.amount) === 0)
      : ownedPrices;
    const ownedPrice = eligibleOwnedPrices.length === 1 ? eligibleOwnedPrices[0] : null;
    const structuredPrice = directPrice || ownedPrice || null;
    const disposition = selectedDisposition({ selected, selectedControl, structuredPrice });
    return {
      ...group,
      selectedEvidence: {
        selected: true,
        disposition,
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
          source: "owned_selected_item_summary",
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
      if (!control?.controlId || !control.operations?.open) return [];
      const existingGroup = existingGroups.find((group) => (group.alternatives || []).some((choice) => choice.controlId === control.controlId));
      if (existingGroup?.selectedEvidence?.selected === true) return [];
      if (control.state?.expanded === true) return [];
      const displayedValue = compactText(
        control.currentValue
        || control.state?.valueText
        || control.ownText
        || "",
        180
      );
      if (!displayedValue || isPlaceholderChoiceValue(displayedValue)) return [];
      const source = elementById(control.stateElementId || control.preferredActivationElementId || "");
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
          structuredPrice: ownedPrice,
          source: "owned_decision_section",
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
      const role = `${control.role || ""} ${control.domRole || ""} ${control.kind || ""}`.toLowerCase();
      const semantic = String(control.semantic || "").toLowerCase();
      const optionalCommand = /button/.test(role) && (
        /decline_paid_extra|decline_baggage|add_paid_extra/.test(semantic)
        || /safe_decline|money|paid/.test(String(control.risk || "").toLowerCase())
        || Number(control.structuredPrice?.amount) > 0
      );
      return /combobox|listbox|select/.test(role)
        || /required_dropdown_choice/.test(semantic)
        || optionalCommand
        || Boolean(control.choiceContract?.decisionInstance)
        || Boolean(control.operations?.open);
    });
  }

  function decisionControlContext(control = {}, section = {}, controls = []) {
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
    const role = `${control.role || ""} ${control.domRole || ""} ${control.kind || ""}`.toLowerCase();
    const semantic = String(control.semantic || "").toLowerCase();
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
              risk: choice.risk,
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
      return [{
        decisionGroupId,
        surfaceId: first.surfaceId || "surface-page",
        sectionId: first.sectionId || first.choiceContract?.decisionOwnerId || "",
        sectionType: first.sectionType || "",
        sectionLabel: decisionLabel,
        requirementId: `${first.sectionType || "decision"}:${slugControlPart(decisionLabel)}`,
        required: choices.some((control) => (
          control.choiceContract?.advancesOnSelection === true
          || control.choiceContract?.required === true
          || control.required
          || control.state?.required
        )),
        status: selected ? "satisfied" : (choices.some((control) => (
          control.choiceContract?.advancesOnSelection === true
          || control.choiceContract?.required === true
          || control.required
          || control.state?.required
        )) ? "missing" : "optional"),
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
    const structuralSurfaceChoices = (activeSurface?.options || []).filter((option) => (
      option.choiceStructure === true
      || /radio|checkbox|option/.test(String(option.accessibility?.role || "").toLowerCase())
    ));
    const surfaceDecisionOptions = structuralSurfaceChoices.length
      ? (activeSurface?.options || []).filter((option) => (
          option.choiceStructure === true
          || /radio|checkbox|option/.test(String(option.accessibility?.role || "").toLowerCase())
          || ["select_free_option", "select_paid_option"].includes(option.physicalEffect)
        ))
      : [];
    // A surface is not a decision merely because it contains several
    // commands. Only actual mutually-exclusive choice capabilities form a
    // decision group; review/edit/close/continue commands remain capabilities.
    const surfaceGroups = activeSurface?.type && activeSurface.type !== "page" && surfaceDecisionOptions.length >= 2
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
    const representedGroups = [...sectionGroups, ...controlOwnedChoiceGroups, ...unrepresentedSurfaceGroups];
    const collapsedSelectorGroups = ownedCollapsedSelectorDecisionGroups(sections, controls, representedGroups);
    const removalGroups = ownedRemovalDecisionGroups(sections, controls, [...representedGroups, ...collapsedSelectorGroups], activeSurface);
    return reconcileExclusiveDecisionControlOwnership(
      [...representedGroups, ...collapsedSelectorGroups, ...removalGroups],
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
    const recoveryActuatorIds = Object.values(control.recovery || {})
      .flatMap((recovery) => [
        ...(recovery?.actuatorIds || []),
        ...(recovery?.strategies || []).map((strategy) => strategy.actuatorId)
      ]);
    return [
      control.stateElementId,
      control.preferredActivationElementId,
      ...(control.actuators || []).map((actuator) => actuator.nodeId),
      ...operationActuatorIds,
      ...recoveryActuatorIds
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
    return authoritative || activeObservationControlRegistry?.lookupElement?.(element) || null;
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
        field: field.fieldType || field.field,
        fieldType: field.fieldType || field.field,
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
      || /required|select one|choose one|\*/i.test(owner?.innerText || "")
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

  function buildStageExit(decisionGroups, fields, buttons, overlays, errors, step, controls = []) {
    const isUnboundSelectionCta = (control) => (
      /selection[_ -]?cta/.test(`${control?.semantic || ""} ${control?.semanticType || ""} ${control?.meaning || ""}`.toLowerCase())
      && !control?.choiceContract
    );
    const rawContinueButton = buttons.find((button) => (
      button.risk === "safe_continue" &&
      !/skip to/i.test(button.label || "") &&
      meaningfulActionBox(button.box)
    ));
    const buttonOwnedContinueControl = rawContinueButton
      ? controls.find((control) => (
          controlMemberNodeIds(control).includes(rawContinueButton.id)
          || control.preferredActivationElementId === rawContinueButton.id
          || control.stateElementId === rawContinueButton.id
        )) || null
      : null;
    const continueButton = isUnboundSelectionCta(buttonOwnedContinueControl)
      ? null
      : rawContinueButton;
    const observedContinueControl = controls.find((control) => (
      !isUnboundSelectionCta(control)
      && (
        control.semantic === "continue"
        || control.semanticType === "continue"
        || ["advance_surface", "advance_checkout_stage"].includes(control.physicalEffect)
        || /(?:^|\s)(?:continue|next)(?:\s|$)/i.test(control.label || "")
      )
    )) || null;
    const continueControl = buttonOwnedContinueControl || observedContinueControl;
    const continueObserved = Boolean(continueButton || continueControl);
    const continueDisabled = Boolean(
      continueControl?.logicalDisabled === true
      || continueControl?.disabled === true
      || continueControl?.state?.disabled === true
    );
    const blockers = [];
    const unresolvedGroup = (decisionGroups || []).find((group) => group.required && !["satisfied", "waived", "waived_by_policy"].includes(group.status));
    const unresolvedField = unfilledRequiredFields(fields)[0];
    if (unresolvedGroup) blockers.push(`unresolved decision: ${unresolvedGroup.sectionLabel || unresolvedGroup.requirementId || unresolvedGroup.decisionGroupId}`);
    if (unresolvedField) blockers.push(`required field: ${unresolvedField.label || unresolvedField.field || unresolvedField.controlId}`);
    if (overlays.length) blockers.push("visible overlay/menu/modal");
    if (actionableCheckoutErrors(errors).length) blockers.push(`visible errors: ${actionableCheckoutErrors(errors).slice(0, 2).join("; ")}`);
    if (!continueObserved) blockers.push("Continue not observed");
    else if (continueDisabled) blockers.push("Continue is disabled");
    else if (!continueButton) blockers.push("Continue is not safely actionable");
    return {
      continueAllowed: Boolean(
        continueButton &&
        !continueDisabled &&
        !unresolvedGroup &&
        !unresolvedField &&
        !overlays.length &&
        !actionableCheckoutErrors(errors).length &&
        !["payment", "confirmation"].includes(step)
      ),
      continueTargetId: continueButton?.id
        || continueControl?.preferredActivationElementId
        || continueControl?.stateElementId
        || "",
      continueControlId: continueControl?.controlId || "",
      continueObserved,
      continueDisabled,
      continueInViewport: continueControl?.visualRegion?.inViewport === true,
      navigationState: !continueObserved
        ? "not_observed"
        : continueDisabled
          ? "disabled"
          : continueButton
            ? "ready"
            : "not_safely_actionable",
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
      beforeUrl: map.url || location.href,
      beforeVisualState: visualPageState(map),
      policyAuthorized: Boolean(
        decision.policy?.allow === true
        || decision.policyDecision?.allow === true
        || decision.affordance?.policy?.allow === true
      )
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

  function compactChoiceCommitEvidence(commit = null) {
    if (!commit || typeof commit !== "object") return null;
    const compactEpisode = (episode = null) => {
      if (!episode || typeof episode !== "object") return null;
      return {
        activeChoiceSurface: Boolean(episode.activeChoiceSurface),
        expanded: Boolean(episode.expanded),
        visibleChoiceSurfaceCount: Number(episode.visibleChoiceSurfaceCount || 0),
        popupOpen: Boolean(episode.popupOpen),
        focusInsideTarget: Boolean(episode.focusInsideTarget),
        activeElementId: String(episode.activeElementId || ""),
        surfaceId: String(episode.surfaceId || ""),
        surfaceType: String(episode.surfaceType || "page"),
        continueDisabled: episode.continueDisabled === true
      };
    };
    const compactKeyResult = (result = null) => {
      if (!result || typeof result !== "object") return null;
      return {
        ok: result.ok === true,
        code: String(result.code || ""),
        error: compactText(result.error || "", 240)
      };
    };
    return {
      ok: commit.ok === true,
      code: String(commit.code || ""),
      controlId: String(commit.controlId || ""),
      actuatorId: String(commit.actuatorId || ""),
      desiredLabel: compactText(commit.desiredLabel || "", 160),
      popupClosed: commit.popupClosed === true,
      focusSettled: commit.focusSettled === true,
      escapeAttempted: commit.escapeAttempted === true,
      tabAttempted: commit.tabAttempted === true,
      escapeResult: compactKeyResult(commit.escapeResult),
      tabResult: compactKeyResult(commit.tabResult),
      beforeCleanup: compactEpisode(commit.beforeCleanup),
      afterEscape: compactEpisode(commit.afterEscape),
      afterCleanup: compactEpisode(commit.afterCleanup)
    };
  }

  function withChoiceCommitEvidence(verification = {}, commit = null) {
    if (!commit) return verification;
    const compactCommit = compactChoiceCommitEvidence(commit);
    const existingEvidence = verification.evidence && typeof verification.evidence === "object" && !Array.isArray(verification.evidence)
      ? verification.evidence
      : { verifierEvidence: verification.evidence || null };
    if (commit.ok && verification.ok) {
      return {
        ...verification,
        code: verification.code || "CHOICE_COMMIT_SETTLED",
        evidence: {
          ...existingEvidence,
          choiceCommit: compactCommit
        }
      };
    }
    return {
      ...verification,
      ok: false,
      code: commit.ok ? (verification.code || "CHOICE_VALUE_NOT_VERIFIED") : "CHOICE_COMMIT_NOT_SETTLED",
      message: commit.ok
        ? verification.message
        : "The intended value may be visible, but the choice popup/focus episode did not close and settle.",
      evidence: {
        ...existingEvidence,
        choiceCommit: compactCommit
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
      beforeUrl: expected.beforeUrl || beforeMap.url || location.href,
      afterUrl: afterMap.url || location.href,
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
    const beforeDecisionGroup = expectedDecisionGroupId
      ? (beforeMap.decisionGroups || []).find((group) => group.decisionGroupId === expectedDecisionGroupId)
      : null;
    const directlyMatchedControl = expectedControlId
      ? (afterMap.controls || []).find((control) => control.controlId === expectedControlId)
      : null;
    const validationOwnerControlId = String(expected.validationOwnership?.controlId || "");
    const validationOwnerControl = validationOwnerControlId
      ? (afterMap.controls || []).find((control) => control.controlId === validationOwnerControlId)
      : null;
    const expectedSemanticType = canonicalProfileFieldType(expected.semanticType || "")
      || normalizedFieldAlias(expected.semanticType || "");
    const expectedComponentRole = String(expected.componentRole || "value");
    const semanticRebindCandidates = expectedSemanticType
      ? (afterMap.controls || []).filter((control) => {
          const controlSemanticType = canonicalProfileFieldType(
            control.fieldType
            || control.fieldClassification?.fieldType
            || control.field
            || control.semantic
            || control.name
            || ""
          );
          if (controlSemanticType !== expectedSemanticType) return false;
          if (expectedComponentRole === "value") return true;
          return String(control.dateField?.component || "") === expectedComponentRole
            || boundedPhrase(`${control.name || ""} ${control.autocomplete || ""}`, expectedComponentRole);
        })
      : [];
    const expectedReboundValue = String(
      expected.expectedNormalizedValue
      || expected.expectedComponentValue
      || ""
    );
    const afterControl = directlyMatchedControl
      || validationOwnerControl
      || semanticRebindCandidates.find((control) => (
        expectedReboundValue
        && String(
          control.state?.normalizedValue
          || control.state?.dateComponentValue
          || ""
        ) === expectedReboundValue
      ))
      || (semanticRebindCandidates.length === 1 ? semanticRebindCandidates[0] : null);
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
    if (expected.type === "date_value_committed") {
      const codec = expected.dateCodec || afterControl?.dateField || {};
      const actualCanonicalValue = String(afterControlState?.canonicalDateValue || "");
      const actualComponentValue = String(afterControlState?.dateComponentValue || "");
      const wantedCanonicalValue = String(expected.expectedCanonicalValue || "");
      const wantedComponentValue = String(expected.expectedNormalizedValue || "");
      const ownedValidationErrors = (afterMap.validationIssues || []).filter((issue) => (
        issue.stageWide === true || (expected.controlId && issue.controlId === expected.controlId)
      ));
      const exactValue = codec.kind === "component"
        ? Boolean(wantedComponentValue && actualComponentValue === wantedComponentValue)
        : Boolean(wantedCanonicalValue && actualCanonicalValue === wantedCanonicalValue);
      const ok = exactValue && ownedValidationErrors.length === 0;
      return {
        ok,
        code: ok ? "DATE_VALUE_VERIFIED" : "DATE_VALUE_NOT_VERIFIED",
        message: ok
          ? "The live date value parses back to the saved canonical date."
          : "The live date value did not parse back to the saved canonical date, or validation remains visible.",
        evidence: {
          ...evidence,
          codec,
          actualCanonicalValue,
          wantedCanonicalValue,
          actualComponentValue,
          wantedComponentValue,
          ownedValidationErrors,
          control: afterControl || null
        }
      };
    }
    if (expected.type === "normalized_value_changed") {
      const actualNormalizedValue = String(afterControlState?.normalizedValue || "");
      const wantedNormalizedValue = String(expected.expectedNormalizedValue || "");
      const semanticType = expected.semanticType || afterControl?.fieldType || afterControl?.semantic || "";
      const actualSemanticValue = normalizedProfileChoiceValue(actualNormalizedValue, semanticType);
      const wantedSemanticValue = normalizedProfileChoiceValue(wantedNormalizedValue, semanticType);
      const currentSurface = afterMap.currentSurface || {};
      const surfaceDismissed = !expected.requireSurfaceDismissed
        || !expected.surfaceId
        || currentSurface.id !== expected.surfaceId;
      const ownedValidationErrors = (afterMap.validationIssues || []).filter((issue) => (
        issue.stageWide === true || (expected.controlId && issue.controlId === expected.controlId)
      ));
      const ok = Boolean(
        wantedNormalizedValue
        && (
          actualNormalizedValue === wantedNormalizedValue
          || (
            actualSemanticValue
            && wantedSemanticValue
            && actualSemanticValue === wantedSemanticValue
          )
        )
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
          actualSemanticValue,
          wantedSemanticValue,
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
      const expectedSelectedControlId = expected.expectedSelectedControlId || expectedControlId;
      const selectedControlId = afterDecisionGroup?.selectedControlId
        || (afterControl && (afterControl.selected || afterControlState?.checked || afterControlState?.selected) ? afterControl.controlId : "");
      const conflictingSelected = (expected.conflictingControlIds || []).filter((controlId) => {
        const control = (afterMap.controls || []).find((candidate) => candidate.controlId === controlId);
        return Boolean(control && (control.selected || control.state?.checked || control.state?.selected));
      });
      const ownedValidationErrors = (afterMap.validationIssues || []).filter((issue) => (
        issue.stageWide === true || (expectedControlId && issue.controlId === expectedControlId)
      ));
      const ok = Boolean(
        expectedSelectedControlId
        && selectedControlId === expectedSelectedControlId
        && conflictingSelected.length === 0
        && ownedValidationErrors.length === 0
      );
      return {
        ok,
        code: ok ? "CONTROL_SELECTED" : "CONTROL_NOT_SELECTED",
        message: ok ? "The exact canonical choice is selected and conflicting peers are clear." : "The exact desired choice was not selected, a conflicting peer remains selected, or validation is still visible.",
        evidence: {
          ...evidence,
          control: afterControl || null,
          expectedSelectedControlId,
          selectedControlId,
          conflictingSelected,
          ownedValidationErrors
        }
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
    if (expected.type === "policy_conflict_resolved") {
      const selectedPaid = (map = {}) => {
        const transaction = (map.transactionFacts?.selectedExtras || []).find((extra) => (
          String(extra.decisionGroupId || "") === expectedDecisionGroupId
          && (Number(extra.priceAmount) > 0 || /paid|money|selected paid/.test(normalizeMatchText(extra.disposition || "")))
          && !/decline|free|remove|skip|without|none|no extra/.test(normalizeMatchText(extra.disposition || ""))
        ));
        const group = (map.decisionGroups || []).find((item) => item.decisionGroupId === expectedDecisionGroupId);
        const groupAmount = Number(group?.selectedEvidence?.structuredPrice?.amount);
        const groupPaid = Boolean(group?.selectedEvidence?.selected === true && (
          group.selectedEvidence.disposition === "paid"
          || (Number.isFinite(groupAmount) && groupAmount > 0)
          || /selected paid|add paid|money|purchase/.test(normalizeMatchText(`${group?.selectedSemantic || ""} ${group?.selectedEvidence?.semantic || ""} ${group?.selectedEvidence?.risk || ""}`))
        ));
        return { transaction: transaction || null, groupPaid };
      };
      const beforePaid = selectedPaid(beforeMap);
      const afterPaid = selectedPaid(afterMap);
      const beforeConflict = Boolean(beforePaid.transaction || beforePaid.groupPaid);
      const beforeGroup = (beforeMap.decisionGroups || []).find((item) => item.decisionGroupId === expectedDecisionGroupId);
      const afterGroup = (afterMap.decisionGroups || []).find((item) => item.decisionGroupId === expectedDecisionGroupId);
      const selectedControlId = String(
        beforeGroup?.selectedEvidence?.selectedControlId
        || beforeGroup?.selectedControlId
        || ""
      );
      const afterSelectedControl = (afterMap.controls || []).find((control) => control.controlId === selectedControlId);
      const afterSelectedText = normalizeMatchText(
        afterMap.foreground?.progressMarkers?.selectedText
        || afterMap.visualState?.foreground?.progressMarkers?.selectedText
        || ""
      );
      const exactControlUnselected = Boolean(
        selectedControlId
        && (!afterSelectedControl
          || !(afterSelectedControl.selected || afterSelectedControl.state?.checked || afterSelectedControl.state?.selected))
      );
      const explicitUnselectedState = /not selected|unselected|no selection|none selected/.test(afterSelectedText);
      const groupSelectionCleared = Boolean(
        !afterGroup
        || (afterGroup.selectedEvidence?.selected !== true && !afterGroup.selectedControlId)
      );
      const selectedItemCleared = Boolean(
        beforeConflict
        && (exactControlUnselected || explicitUnselectedState || groupSelectionCleared)
      );
      const afterConflictMetadata = Boolean(afterPaid.transaction || afterPaid.groupPaid);
      const afterConflict = Boolean(afterPaid.transaction || (afterPaid.groupPaid && !selectedItemCleared));
      const chargeCleared = beforePaid.transaction ? !afterPaid.transaction : !afterConflict;
      const beforePriceAmount = expected.beforePriceAmount == null ? null : Number(expected.beforePriceAmount);
      const afterPriceAmount = afterMap.price?.amount == null ? null : Number(afterMap.price.amount);
      const priceDidNotIncrease = Number.isFinite(beforePriceAmount) && Number.isFinite(afterPriceAmount)
        ? afterPriceAmount <= beforePriceAmount
        : afterConflict === false;
      const ownedValidationErrors = (afterMap.validationIssues || []).filter((issue) => (
        issue.stageWide === true || (expectedControlId && issue.controlId === expectedControlId)
      ));
      const ok = Boolean(
        expected.semanticOwnershipLinkId
        && beforeConflict
        && selectedItemCleared
        && !afterConflict
        && chargeCleared
        && priceDidNotIncrease
        && ownedValidationErrors.length === 0
      );
      return {
        ok,
        code: ok ? "POLICY_CONFLICT_RESOLVED" : "POLICY_CONFLICT_STILL_PRESENT",
        message: ok
          ? "Fresh browser facts prove the selected paid item and its charge are gone."
          : "Fresh browser facts do not yet prove the selected paid item and charge are gone.",
        evidence: {
          ...evidence,
          semanticOwnershipLinkId: expected.semanticOwnershipLinkId || "",
          intendedOutcome: expected.intendedOutcome || "unknown",
          beforeConflict,
          afterConflict,
          afterConflictMetadata,
          selectedItemCleared,
          exactControlUnselected,
          explicitUnselectedState,
          groupSelectionCleared,
          chargeCleared,
          beforePriceAmount: Number.isFinite(beforePriceAmount) ? beforePriceAmount : null,
          afterPriceAmount: Number.isFinite(afterPriceAmount) ? afterPriceAmount : null,
          priceDidNotIncrease,
          ownedValidationErrors
        }
      };
    }
    if (expected.type === "exact_free_option_selected") {
      const beforeExpectedControl = (beforeMap.controls || []).find((control) => (
        control.controlId === String(expected.expectedSelectedControlId || expected.controlId || "")
      )) || null;
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
      const ownedRemovalVerified = Boolean(
        beforeDecisionGroup?.removalControlId
        && beforeDecisionGroup.removalControlId === expectedControlId
        && beforeDecisionGroup.selectedEvidence?.selected === true
        && beforeDecisionGroup.selectedEvidence?.disposition === "paid"
        && !afterControl
        && (!group || group.selectedEvidence?.disposition !== "paid")
      );
      const paidTransactionForGroup = (map = {}) => (map.transactionFacts?.selectedExtras || []).find((extra) => (
        String(extra.decisionGroupId || "") === expectedDecisionGroupId
        && (
          Number(extra.priceAmount) > 0
          || /paid|money|selected paid/.test(normalizeMatchText(extra.disposition || ""))
        )
        && !/decline|free|remove|skip|without|none|no extra/.test(normalizeMatchText(extra.disposition || ""))
      )) || null;
      const linkedPaidSelectionCleared = Boolean(
        expected.semanticOwnershipLinkId
        && paidTransactionForGroup(beforeMap)
        && !paidTransactionForGroup(afterMap)
      );
      const beforeLinkedPaidSelection = Boolean(
        beforeDecisionGroup?.selectedEvidence?.selected === true
        && (
          beforeDecisionGroup.selectedEvidence.disposition === "paid"
          || Number(beforeDecisionGroup.selectedEvidence.structuredPrice?.amount) > 0
        )
      );
      const afterLinkedPaidSelection = Boolean(
        afterDecisionGroup?.selectedEvidence?.selected === true
        && (
          afterDecisionGroup.selectedEvidence.disposition === "paid"
          || Number(afterDecisionGroup.selectedEvidence.structuredPrice?.amount) > 0
        )
      );
      const linkedSourceSelectionCleared = Boolean(
        expected.semanticOwnershipLinkId
        && beforeLinkedPaidSelection
        && !afterLinkedPaidSelection
      );
      const exactReversalVerified = ownedRemovalVerified || linkedPaidSelectionCleared || linkedSourceSelectionCleared;
      const selectedText = normalizeMatchText(`${beforeExpectedControl?.semantic || ""} ${beforeExpectedControl?.meaning || ""} ${beforeExpectedControl?.label || ""} ${exactCommitment?.semantic || ""} ${exactCommitment?.risk || ""} ${exactCommitment?.label || ""} ${selectedOption?.semantic || ""} ${selectedOption?.risk || ""} ${selectedOption?.label || group?.selectedSemantic || ""} ${group?.selectedLabel || ""}`);
      const intendedOutcome = normalizeMatchText(expected.intendedOutcome || "");
      const semanticPolicyOutcomeVerified = (() => {
        if (exactReversalVerified) return true;
        if (!intendedOutcome || intendedOutcome === "declined or free") return true;
        if (intendedOutcome === "random assignment") {
          return /random seating|random (?:seat )?assignment|automatic seat assignment|skip seat|continue without (?:a )?seat|go without (?:a )?seat|no seat selection/.test(selectedText);
        }
        if (intendedOutcome === "included base fare") {
          return /included|base fare|basic(?: fare)?|saver(?: fare)?|economy light|light fare/.test(selectedText);
        }
        if (intendedOutcome === "no insurance") {
          return /no (?:travel |trip )?(?:insurance|protection)|without (?:insurance|protection)|decline (?:insurance|protection)|skip (?:insurance|protection)|no thanks/.test(selectedText);
        }
        if (intendedOutcome === "included allowance") {
          return /included|personal item|underseat|cabin bag|hand baggage|carry on|checked bag|hold baggage/.test(selectedText);
        }
        return true;
      })();
      const semanticDispositionVerified = exactReversalVerified
        || /decline|safe decline|free|included|no extra|no thanks|none|without|skip|remove/.test(selectedText)
        || (
          ["random assignment", "included base fare", "no insurance", "included allowance"].includes(intendedOutcome)
          && semanticPolicyOutcomeVerified
        );
      const paidAlternativesSelected = (group?.alternatives || []).filter((option) => {
        if (!(option.selected === true || (groupSelectedControlId && option.controlId === groupSelectedControlId))) return false;
        const risk = normalizeMatchText(option.risk || "");
        const semantic = normalizeMatchText(option.semantic || "");
        return /money|payment/.test(risk) || /add paid extra|add extra|purchase|upgrade/.test(semantic);
      });
      const exactControlSelected = exactReversalVerified || Boolean(expectedControlId && selectedControlId === expectedControlId);
      const selectedChargeAmount = Number(group?.selectedEvidence?.structuredPrice?.amount ?? selectedOption?.structuredPrice?.amount);
      const selectedChargeRemoved = expected.requireChargeRemoved !== true || Boolean(
        exactReversalVerified
        || (
          group?.selectedEvidence?.disposition === "free"
          && (!Number.isFinite(selectedChargeAmount) || selectedChargeAmount <= 0)
        )
        || (Number.isFinite(selectedChargeAmount) && selectedChargeAmount === 0)
      );
      const selectedTruth = (item = {}) => {
        const selectedEvidence = item.selectedEvidence || {};
        const controlId = String(item.selectedControlId || selectedEvidence.selectedControlId || "");
        if (selectedEvidence.selected !== true && !controlId) return null;
        const amount = Number(selectedEvidence.structuredPrice?.amount);
        return {
          controlId,
          disposition: normalizeMatchText(selectedEvidence.disposition || item.selectedSemantic || "unknown"),
          priceAmount: Number.isFinite(amount) ? amount : null
        };
      };
      const beforeSelections = new Map((beforeMap.decisionGroups || []).map((item) => [
        String(item.decisionGroupId || item.requirementId || ""),
        selectedTruth(item)
      ]).filter(([decisionGroupId, truth]) => decisionGroupId && truth));
      const unrelatedSelectionChanges = (afterMap.decisionGroups || []).flatMap((item) => {
        const decisionGroupId = String(item.decisionGroupId || item.requirementId || "");
        if (!decisionGroupId || decisionGroupId === expectedDecisionGroupId || decisionGroupId === expected.correctionDecisionGroupId) return [];
        const afterSelection = selectedTruth(item);
        if (!afterSelection) return [];
        const beforeSelection = beforeSelections.get(decisionGroupId) || null;
        if (!beforeSelection) return [];
        if (beforeSelection && JSON.stringify(beforeSelection) === JSON.stringify(afterSelection)) return [];
        // Some widgets expose an option in a foreground listbox, then collapse
        // it back into the owning field after selection. When the exact option
        // commitment and selected label identify this group as the expected
        // free result, the field's paid→free change is the postcondition—not
        // an unrelated mutation merely because the presentation group changed.
        const expectedCollapsedSelection = Boolean(
          item === group
          && exactCommitment
          && /free|decline|without|none|no extra|included/.test(afterSelection.disposition)
        );
        if (expectedCollapsedSelection) return [];
        return [{ decisionGroupId, before: beforeSelection, after: afterSelection }];
      });
      const beforePriceAmount = expected.beforePriceAmount == null ? null : Number(expected.beforePriceAmount);
      const afterPriceAmount = afterMap.price?.amount == null ? null : Number(afterMap.price.amount);
      const checkoutStageAdvanced = Boolean(
        String(beforeMap.step || "") !== String(afterMap.step || "")
        || String(expected.beforeUrl || beforeMap.url || "") !== String(afterMap.url || location.href)
        || progressMarkerChanged
        || (
          surfaceChanged
          && beforeTransitionSurface.type === "page"
          && afterTransitionSurface.type === "page"
        )
      );
      const afterControlAvailability = afterControl && AGENT_CONTRACT?.controlAvailability
        ? AGENT_CONTRACT.controlAvailability(afterControl)
        : (afterControl ? "active" : "inactive");
      const afterDecisionAvailability = afterDecisionGroup && AGENT_CONTRACT?.decisionAvailability
        ? AGENT_CONTRACT.decisionAvailability(afterDecisionGroup, afterMap.controls || [])
        : (afterDecisionGroup ? "active" : "inactive");
      const sourceRetired = Boolean(
        beforeExpectedControl
        && afterControlAvailability === "inactive"
        && afterDecisionAvailability === "inactive"
      );
      const activeSuccessorDecision = (afterMap.decisionGroups || []).some((item) => (
        item.decisionGroupId !== expectedDecisionGroupId
        && (
          !AGENT_CONTRACT?.decisionAvailability
          || AGENT_CONTRACT.decisionAvailability(item, afterMap.controls || []) === "active"
        )
      ));
      const advancingFreeOptionDisappeared = Boolean(
        beforeExpectedControl?.choiceContract?.advancesOnSelection === true
        && Number(beforeExpectedControl?.structuredPrice?.amount) === 0
        && sourceRetired
        && changed
      );
      const freeCommandDismissed = Boolean(
        beforeExpectedControl
        && beforeExpectedControl.surfaceType
        && beforeExpectedControl.surfaceType !== "page"
        && /decline|safe decline|free|no thanks|without|skip/.test(selectedText)
        && sourceRetired
        && changed
        && (afterMap.currentSurface?.id !== beforeExpectedControl.surfaceId || afterMap.currentSurface?.type === "page")
      );
      const policySafeTransitionCandidate = Boolean(
        beforeExpectedControl
        && expected.policyAuthorized === true
        && (
          Number(beforeExpectedControl.structuredPrice?.amount) === 0
          || /decline|safe decline|free|included|without|skip|no thanks|no extra/.test(
            normalizeMatchText(`${expected.expectedDisposition || ""} ${beforeExpectedControl.physicalEffect || ""} ${beforeExpectedControl.semantic || ""} ${beforeExpectedControl.risk || ""} ${beforeExpectedControl.label || ""}`)
          )
        )
        && sourceRetired
        && checkoutStageAdvanced
      );
      const priceDidNotIncrease = (exactReversalVerified || advancingFreeOptionDisappeared || freeCommandDismissed || policySafeTransitionCandidate)
        && Number.isFinite(beforePriceAmount)
        && !Number.isFinite(afterPriceAmount)
        ? true
        : Number.isFinite(beforePriceAmount) && Number.isFinite(afterPriceAmount)
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
      const contractPolicySafeAdvance = Boolean(
        beforeExpectedControl
        && beforeExpectedControl.choiceContract?.advancesOnSelection === true
        && Number(beforeExpectedControl.structuredPrice?.amount) === 0
        && beforeDecisionGroup
        && semanticPolicyOutcomeVerified
        && (beforeDecisionGroup.alternatives || []).some((option) => (
          option.controlId === beforeExpectedControl.controlId
          && (
            Number(option.structuredPrice?.amount) === 0
            || /select_free_option|safe_decline|free|included|without|skip/.test(
              normalizeMatchText(`${option.physicalEffect || ""} ${option.semantic || ""} ${option.risk || ""} ${option.label || ""}`)
            )
          )
        ))
        && sourceRetired
        && changed
        && (activeSuccessorDecision || checkoutStageAdvanced)
        && priceDidNotIncrease
        && ownedValidationErrors.length === 0
        && actionableCheckoutErrors(afterMap.errors || []).length === 0
      );
      const policySafeChoiceAdvanced = Boolean(
        policySafeTransitionCandidate
        && semanticPolicyOutcomeVerified
        && priceDidNotIncrease
        && unrelatedSelectionChanges.length === 0
        && paidAlternativesSelected.length === 0
        && ownedValidationErrors.length === 0
        && actionableCheckoutErrors(afterMap.errors || []).length === 0
      );
      const exactPolicySafeAdvance = contractPolicySafeAdvance || policySafeChoiceAdvanced;
      const ok = Boolean(
        (group?.status === "satisfied" || exactReversalVerified || exactPolicySafeAdvance || freeCommandDismissed)
        && (exactControlSelected || exactPolicySafeAdvance || freeCommandDismissed)
        && (semanticDispositionVerified || exactPolicySafeAdvance || freeCommandDismissed)
        && semanticPolicyOutcomeVerified
        && selectedChargeRemoved
        && unrelatedSelectionChanges.length === 0
        && paidAlternativesSelected.length === 0
        && priceDidNotIncrease
        && ownedValidationErrors.length === 0
        && surfaceDismissed
      );
      return {
        ok,
        code: policySafeChoiceAdvanced
          ? "POLICY_SAFE_CHOICE_ADVANCED"
          : (ok ? "EXACT_FREE_OPTION_VERIFIED" : "EXACT_FREE_OPTION_NOT_VERIFIED"),
        message: ok
          ? (policySafeChoiceAdvanced
              ? "The profile-authorized free/no-extra choice safely advanced checkout to a fresh stage."
              : "The exact canonical free/no-extra option is selected without a price increase or validation error.")
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
          afterControlAvailability,
          afterDecisionAvailability,
          sourceRetired,
          activeSuccessorDecision,
          exactPolicySafeAdvance,
          contractPolicySafeAdvance,
          policySafeChoiceAdvanced,
          checkoutStageAdvanced,
          completionMode: policySafeChoiceAdvanced ? "safe_stage_transition" : "same_surface_selection",
          freeCommandDismissed,
          intendedOutcome: expected.intendedOutcome || "",
          semanticPolicyOutcomeVerified,
          ownedRemovalVerified,
          linkedPaidSelectionCleared,
          linkedSourceSelectionCleared,
          semanticOwnershipLinkId: expected.semanticOwnershipLinkId || "",
          semanticDispositionVerified,
          selectedChargeRemoved,
          selectedChargeAmount: Number.isFinite(selectedChargeAmount) ? selectedChargeAmount : null,
          unrelatedSelectionChanges,
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
      const advancedInPlace = Boolean(progressMarkerChanged);
      const ok = Boolean(stepAdvanced || advancedInPlace || foregroundGone || (!sameSurfaceId && !sameSurfaceLabel && (foregroundChanged || visualChanged || changed)));
      return {
        ok,
        code: ok
          ? (advancedInPlace && !foregroundGone ? "ACTIVE_SURFACE_ADVANCED" : "ACTIVE_SURFACE_DISMISSED")
          : "ACTIVE_SURFACE_STILL_PRESENT",
        message: ok
          ? (advancedInPlace && !foregroundGone
              ? "Foreground surface advanced to a fresh internal step."
              : "Foreground surface was dismissed or advanced.")
          : "Foreground surface is still present after the action.",
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
          },
          advancedInPlace,
          progressMarkerChanged
        }
      };
    }
    if (expected.type === "current_surface_advanced") {
      const stepChanged = beforeMap.step !== afterMap.step;
      const urlChanged = String(beforeMap.url || "") !== String(afterMap.url || location.href);
      const ok = Boolean(stepChanged || urlChanged || progressMarkerChanged || (surfaceChanged && !overlayAppeared));
      return {
        ok,
        code: ok ? "CURRENT_SURFACE_ADVANCED" : "CURRENT_SURFACE_NOT_ADVANCED",
        message: ok ? "The current surface produced fresh forward-progress evidence." : "The current surface did not produce forward-progress evidence.",
        evidence: { ...evidence, stepChanged, urlChanged, progressMarkerChanged, surfaceChanged, overlayAppeared }
      };
    }
    if (expected.type === "checkout_stage_advanced") {
      const stepChanged = beforeMap.step !== afterMap.step;
      const urlChanged = String(beforeMap.url || "") !== String(afterMap.url || location.href);
      const ok = Boolean(stepChanged || urlChanged || progressMarkerChanged);
      return {
        ok,
        code: ok ? "CHECKOUT_STAGE_ADVANCED" : "CHECKOUT_STAGE_NOT_ADVANCED",
        message: ok ? "Fresh stage, URL, or progress-marker evidence proves checkout advanced." : "No fresh checkout-stage evidence was observed.",
        evidence: { ...evidence, stepChanged, urlChanged, progressMarkerChanged, overlayAppeared, surfaceChanged }
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

  async function finalizeGovernedAction(actionId, observationId, decision, expectedOutcome, verification, delay = 500) {
    const executionResult = await pushVerificationLedger(
      actionId,
      observationId,
      decision,
      expectedOutcome,
      verification
    );
    logFlow("action.lifecycle.finalized", {
      actionId,
      observationId,
      resultAt: executionResult.at || "",
      verified: executionResult.verified === true,
      outcomeCode: executionResult.outcome?.code || executionResult.failureCode || "",
      resultObservationHash: executionResult.resultObservationHash || "",
      next: "fresh_observation"
    });
    await continueAfterAction(delay);
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
    element.dispatchEvent(new MouseEvent("click", { ...eventInit, buttons: 0 }));
  }

  function nativeElementClick(element, meta = {}) {
    if (!element || typeof element.click !== "function") return false;
    logFlow("dom.native_click.dispatch", {
      meta,
      target: elementDescriptor(element),
      pageBefore: pageSnapshot("before-native-click")
    });
    watchClickToFirstMutation("native_click", meta);
    element.click();
    return true;
  }

  async function trustedBrowserClick(element, decision = {}) {
    if (!element) return { ok: false, code: "CANONICAL_ACTUATOR_UNAVAILABLE" };
    const rect = element.getBoundingClientRect();
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);
    if (typeof globalThis.__ATW_TEST_TRUSTED_INPUT__ === "function") {
      return globalThis.__ATW_TEST_TRUSTED_INPUT__({ element, x, y, decision });
    }
    if (!globalThis.chrome?.runtime?.sendMessage) {
      return { ok: false, code: "TRUSTED_INPUT_UNAVAILABLE" };
    }
    try {
      return await chrome.runtime.sendMessage({
        type: "ATW_TRUSTED_POINTER_CLICK",
        governed: true,
        actionId: decision.actionId || decision.id || "",
        observationId: decision.observationId || "",
        controlId: decision.controlId || "",
        x,
        y
      });
    } catch (error) {
      return { ok: false, code: "TRUSTED_INPUT_UNAVAILABLE", error: error.message };
    }
  }

  async function trustedBrowserChoice(element, decision = {}) {
    if (!element) return { ok: false, code: "CANONICAL_ACTUATOR_UNAVAILABLE" };
    const choiceLabel = String(decision.value || "").trim();
    if (!choiceLabel) return { ok: false, code: "TRUSTED_CHOICE_VALUE_MISSING" };
    rememberChoiceActuatorBinding(decision.controlId, element, decision);
    const previousInteraction = choiceInteractionStates.get(String(decision.controlId || "").trim()) || {};
    updateChoiceInteractionState(decision.controlId, {
      status: "dispatched",
      actuatorId: elementId(element),
      desiredLabel: choiceLabel,
      attempts: Number(previousInteraction.attempts || 0) + 1,
      popupClosed: false,
      focusSettled: false
    });
    const rect = element.getBoundingClientRect();
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);
    if (typeof globalThis.__ATW_TEST_TRUSTED_CHOICE__ === "function") {
      const result = await globalThis.__ATW_TEST_TRUSTED_CHOICE__({ element, x, y, choiceLabel, decision });
      if (result?.ok !== true) {
        updateChoiceInteractionState(decision.controlId, {
          status: "unsettled",
          code: result?.code || "TRUSTED_INPUT_UNAVAILABLE"
        });
      }
      return result;
    }
    if (!globalThis.chrome?.runtime?.sendMessage) {
      return { ok: false, code: "TRUSTED_INPUT_UNAVAILABLE" };
    }
    try {
      const result = await chrome.runtime.sendMessage({
        type: "ATW_TRUSTED_CHOICE",
        governed: true,
        actionId: decision.actionId || decision.id || "",
        observationId: decision.observationId || "",
        controlId: decision.controlId || "",
        choiceLabel,
        x,
        y
      });
      if (result?.ok !== true) {
        updateChoiceInteractionState(decision.controlId, {
          status: "unsettled",
          code: result?.code || "TRUSTED_INPUT_UNAVAILABLE"
        });
      }
      return result;
    } catch (error) {
      updateChoiceInteractionState(decision.controlId, {
        status: "unsettled",
        code: "TRUSTED_INPUT_UNAVAILABLE"
      });
      return { ok: false, code: "TRUSTED_INPUT_UNAVAILABLE", error: error.message };
    }
  }

  async function trustedBrowserKey(key = "", decision = {}) {
    const normalizedKey = String(key || "");
    if (!["Escape", "Tab"].includes(normalizedKey)) {
      return { ok: false, code: "TRUSTED_KEY_UNSUPPORTED" };
    }
    if (typeof globalThis.__ATW_TEST_TRUSTED_KEY__ === "function") {
      return globalThis.__ATW_TEST_TRUSTED_KEY__({ key: normalizedKey, decision });
    }
    if (!globalThis.chrome?.runtime?.sendMessage) {
      return { ok: false, code: "TRUSTED_INPUT_UNAVAILABLE" };
    }
    try {
      return await chrome.runtime.sendMessage({
        type: "ATW_TRUSTED_KEY",
        governed: true,
        actionId: decision.actionId || decision.id || "",
        observationId: decision.observationId || "",
        controlId: decision.controlId || "",
        key: normalizedKey
      });
    } catch (error) {
      return { ok: false, code: "TRUSTED_INPUT_UNAVAILABLE", error: error.message };
    }
  }

  function visibleChoiceSurfacesForValue(choiceLabel = "") {
    const wanted = normalizeMatchText(choiceLabel);
    return queryAllDeep("[role='listbox'], [role='menu'], [role='tree'], [data-headlessui-state~='open']")
      .filter((surface) => (
        isVisible(surface)
        && !surface.closest?.("#atw-sidebar")
        && (
          !wanted
          || normalizeMatchText(surface.innerText || surface.textContent || "").includes(wanted)
        )
      ));
  }

  function choiceEpisodeEvidence(target, decision = {}, map = null) {
    const control = (map?.controls || []).find((item) => item.controlId === decision.controlId) || null;
    const activeSurface = map?.currentSurface || {};
    const liveChoiceSurfaces = queryAllDeep("[role='listbox'], [role='menu'], [data-headlessui-state='open'], [aria-expanded='true'], .popover")
      .filter((surface) => !surface.closest?.("#atw-sidebar") && isVisible(surface))
      .filter((surface) => (
        isTransientChoiceOverlay(surface)
        || /dropdown|listbox|menu|popover|choice|option|tree/.test(String(surface.getAttribute?.("role") || "").toLowerCase())
      ));
    const activeChoiceSurface = Boolean(
      liveChoiceSurfaces.length
      || (
        activeSurface.type
        && activeSurface.type !== "page"
        && /dropdown|listbox|menu|popover|choice|option|tree/.test(String(activeSurface.type || "").toLowerCase())
      )
    );
    const expanded = Boolean(
      control?.state?.expanded === true
      || target?.getAttribute?.("aria-expanded") === "true"
      || target?.closest?.("[aria-expanded='true']")
    );
    const visibleChoiceSurfaces = visibleChoiceSurfacesForValue(decision.value || decision.targetLabel || "");
    const relatedElements = [
      target,
      elementById(control?.stateElementId || ""),
      elementById(control?.preferredActivationElementId || ""),
      ...Object.values(control?.operations || {}).flatMap((capability) => (
        capability?.actuatorIds || []
      )).map(elementById)
    ].filter(Boolean);
    const focusInsideTarget = Boolean(
      document.activeElement
      && relatedElements.some((element) => (
        document.activeElement === element
        || element.contains?.(document.activeElement)
      ))
    );
    return {
      activeChoiceSurface,
      expanded,
      visibleChoiceSurfaceCount: visibleChoiceSurfaces.length,
      popupOpen: Boolean(activeChoiceSurface || expanded || visibleChoiceSurfaces.length),
      focusInsideTarget,
      activeElementId: document.activeElement ? elementId(document.activeElement) : "",
      surfaceId: activeSurface.id || (liveChoiceSurfaces[0] ? elementId(liveChoiceSurfaces[0]) : ""),
      surfaceType: activeSurface.type || (liveChoiceSurfaces.length ? "choice_overlay" : "page"),
      continueDisabled: map?.stageExit?.continueDisabled === true
    };
  }

  async function settleTrustedChoiceInteraction(target, decision = {}) {
    await waitForUiSettle(180);
    const beforeCleanup = choiceEpisodeEvidence(target, decision);
    let escapeAttempted = false;
    let tabAttempted = false;
    let escapeResult = null;
    let tabResult = null;

    if (beforeCleanup.popupOpen) {
      escapeAttempted = true;
      escapeResult = await trustedBrowserKey("Escape", decision);
      if (escapeResult?.ok !== true) pressEscape(document.activeElement || target);
      await waitForUiSettle(180);
    }

    const afterEscape = choiceEpisodeEvidence(target, decision);
    if (afterEscape.popupOpen || afterEscape.focusInsideTarget) {
      tabAttempted = true;
      tabResult = await trustedBrowserKey("Tab", decision);
      if (tabResult?.ok !== true) target?.blur?.();
      await waitForUiSettle(220);
    }

    const afterCleanup = choiceEpisodeEvidence(target, decision);
    const popupClosed = !afterCleanup.popupOpen;
    const focusSettled = !afterCleanup.focusInsideTarget;
    const settled = popupClosed && focusSettled;
    const state = updateChoiceInteractionState(decision.controlId, {
      status: settled ? "settled" : "unsettled",
      actuatorId: elementId(target),
      desiredLabel: String(decision.value || "").trim(),
      popupClosed,
      focusSettled,
      escapeAttempted,
      tabAttempted,
      code: settled ? "CHOICE_COMMIT_SETTLED" : "CHOICE_COMMIT_NOT_SETTLED"
    });
    pageStateStore?.invalidate?.("choice_commit_state");
    return {
      ok: settled,
      code: state?.code || "CHOICE_COMMIT_NOT_SETTLED",
      controlId: String(decision.controlId || ""),
      actuatorId: state?.actuatorId || elementId(target),
      desiredLabel: state?.desiredLabel || String(decision.value || "").trim(),
      popupClosed,
      focusSettled,
      escapeAttempted,
      tabAttempted,
      escapeResult,
      tabResult,
      beforeCleanup,
      afterEscape,
      afterCleanup
    };
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

  function clickResolvedViewportTarget(target, x = 18, y = 18, meta = {}) {
    if (!target) return false;
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
    return true;
  }

  function clickViewportPoint(x = 18, y = 18, meta = {}) {
    const target = document.elementFromPoint(x, y) || document.body;
    return clickResolvedViewportTarget(target, x, y, meta);
  }

  function transientOverlayOpen() {
    return activeOverlayElements().some((overlay) => isTransientChoiceOverlay(overlay));
  }

  async function waitForUiSettle(ms = 650) {
    const startedAt = performance.now();
    setAgentActivity("Wait -> Watching page update", "Waiting for a material popup, selection, validation, price, progress, or route change.");
    const settled = await pageStateStore.waitForQuiet({
      maxWaitMs: ms,
      minQuietMs: 80,
      awaitMutationMs: Math.min(180, Math.max(60, Math.round(ms * 0.25)))
    });
    logFlow("latency.span", {
      page_settle_ms: Math.round(performance.now() - startedAt),
      requested_settle_ms: ms,
      mutation_settled: settled.settled
    });
  }

  function exactChoiceCommitReadiness(target, decision = {}) {
    if (isChoiceSelected(target)) {
      return { ready: true, source: "observed_selected_state" };
    }
    const continueButton = findSafeContinueButton();
    if (continueButton && !isDisabledLike(continueButton)) {
      return {
        ready: true,
        source: "stage_exit_enabled",
        continueControlId: lookupControlForElement(agent.pageMap || {}, continueButton)?.controlId || ""
      };
    }
    return { ready: false, source: "not_ready" };
  }

  async function settleExactChoiceOutcome(
    target,
    decision = {},
    expectedOutcome = {},
    beforeMap = {},
    initialAfterMap = null,
    timeoutMs = 4200
  ) {
    let afterMap = initialAfterMap || buildPageMap();
    let verification = verifyExpectedOutcome(expectedOutcome, beforeMap, afterMap, target);
    if (expectedOutcome.type !== "exact_free_option_selected" || verification.ok) {
      return { afterMap, verification, commitment: null };
    }
    const startedAt = performance.now();
    while (performance.now() - startedAt < timeoutMs) {
      const readiness = exactChoiceCommitReadiness(target, decision);
      if (readiness.ready) {
        const commitment = rememberExactChoiceCommitment(target, decision, readiness);
        pageStateStore.invalidate("exact_choice_commitment");
        afterMap = (await observePageStateAfterMutation("verify_exact_choice_commitment", 700)).map;
        verification = verifyExpectedOutcome(expectedOutcome, beforeMap, afterMap, target);
        if (verification.ok) {
          return { afterMap, verification, commitment };
        }
      }
      await sleep(120);
    }
    if (pageStateStore.isDirty()) {
      afterMap = (await observePageStateAfterMutation("verify_exact_choice_timeout", 500)).map;
      verification = verifyExpectedOutcome(expectedOutcome, beforeMap, afterMap, target);
    }
    return { afterMap, verification, commitment: null };
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

  function stepEvidenceInput(input, structuralEvidence = {}) {
    const evidence = input && typeof input === "object"
      ? input
      : { visibleText: String(input || "") };
    let routePath = String(evidence.routePath || "").toLowerCase();
    if (!routePath) {
      try {
        routePath = new URL(String(evidence.url || location.href), location.href).pathname.toLowerCase();
      } catch (error) {
        routePath = String(location.pathname || "").toLowerCase();
      }
    }
    return {
      visibleText: String(evidence.visibleText || evidence.text || ""),
      routePath,
      structuralEvidence: evidence.structuralEvidence || structuralEvidence || {}
    };
  }

  // One classifier owns both runtime and observer output. Evidence channels
  // stay separate so query parameters never become visible checkout semantics.
  function classifyStepDetailed(input, structuralEvidence = {}) {
    const evidence = stepEvidenceInput(input, structuralEvidence);
    const lower = evidence.visibleText.toLowerCase();
    const route = evidence.routePath;
    const newSearchRoute = /(?:^|\/)rf\/start\/?$/.test(route)
      || /(?:^|\/)(?:flight-)?search\/?$/.test(route);
    const extrasEvidence = /select baggage|configure your trip|upgrade your trip|checked baggage|bundle|premium support|airhelp|cancellation guarantee|voucher refund|add to cart|no thanks|add baggage|choose your bundle/.test(lower);
    const travelerEvidence = /traveller information|traveler information|contact information|provide your contact details|passport|date of birth|surname|first name|first and middle names|mobile number|confirm e-?mail/.test(lower);
    const seatEvidence = /seat selection|select (?:your )?seats?\b|choose (?:your )?seats?\b/.test(lower);
    const strongSeatEvidence = /reserve seating|seat map|seat map key|standard seat|not selected|select a seat|choose a seat/.test(lower);
    const travelerRouteEvidence = /\/rf\/traveler-details|\/rf\/traveller-details|traveler-details|traveller-details/.test(route);
    const paymentFormEvidence = /card number|security code|cvc|cvv|pay now|complete booking|confirm and pay|submit payment|billing card|cardholder/.test(lower);
    const paymentRouteEvidence = /\/rf\/payment|\/payment\b/.test(route);
    const confirmationEvidence = /booking confirmed|confirmation|booking reference|reservation number|pnr/.test(lower);
    const flightSelectionEvidence = /flight selection|select flight|choose flight|fare/.test(lower);
    const repeatedSeatInventory = Number(evidence.structuralEvidence.seatInventoryCount || 0) >= 64;
    const loadingEvidence = /\bplease\s+wait\b|\b(?:loading|fetching|preparing)\b.{0,80}\b(?:option|seat|fare|checkout|payment|travell?er|passenger|detail|trip)\b/.test(lower);
    const result = (step, confidence, positiveEvidence = []) => ({
      step,
      confidence,
      positiveEvidence,
      loadingEvidence
    });

    if (newSearchRoute) return result("flight_selection", 0.98, ["route_path"]);
    if (repeatedSeatInventory && strongSeatEvidence) return result("seats", 0.98, ["seat_inventory", "seat_copy"]);
    if (confirmationEvidence) return result("confirmation", 0.95, ["confirmation_copy"]);
    if (paymentFormEvidence) return result("payment", 0.95, ["payment_controls_copy"]);
    if (strongSeatEvidence) return result("seats", 0.9, ["seat_controls_copy"]);
    if (travelerRouteEvidence) return result("traveler_information", 0.9, ["route_path"]);
    if (paymentRouteEvidence && extrasEvidence) return result("extras", 0.75, ["payment_route", "extras_copy"]);
    if (paymentRouteEvidence && seatEvidence) return result("seats", 0.75, ["payment_route", "seat_copy"]);
    if (travelerEvidence) return result("traveler_information", 0.8, ["traveler_copy"]);
    if (seatEvidence) return result("seats", 0.8, ["seat_copy"]);
    if (extrasEvidence) return result("extras", 0.7, ["extras_copy"]);
    if (paymentRouteEvidence) return result("payment", 0.6, ["route_path"]);
    if (flightSelectionEvidence) return result("flight_selection", 0.6, ["flight_selection_copy"]);
    return result("unknown", 0.2, []);
  }

  function classifyStep(input, structuralEvidence = {}) {
    return classifyStepDetailed(input, structuralEvidence).step;
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
      blockedIframes: Math.max(0, iframes.length - accessibleIframes),
      scroll: {
        scrollY: Math.round(window.scrollY),
        viewportHeight: Math.round(window.innerHeight),
        documentHeight: Math.round(Math.max(
          document.documentElement?.scrollHeight || 0,
          document.body?.scrollHeight || 0
        )),
        atTop: window.scrollY <= 2,
        atBottom: window.scrollY + window.innerHeight >= Math.max(
          document.documentElement?.scrollHeight || 0,
          document.body?.scrollHeight || 0
        ) - 2
      }
    };
  }

  function pageReadinessFacts() {
    const loadingSelectors = [
      "[aria-busy='true']",
      "[role='progressbar']",
      "[data-loading='true']",
      "[data-testid*='loading']",
      ".loading",
      ".loader",
      ".spinner",
      "[class*='skeleton']"
    ].join(",");
    const loadingIndicators = queryAllDeep(loadingSelectors)
      .filter((element) => isVisible(element) && !element.closest("#atw-sidebar, #atw-agent-cursor"));
    const main = queryAllDeep("main, [role='main']").find((element) => isVisible(element)) || document.body;
    const mainText = compactText(main?.innerText || main?.textContent || "", 10_000);
    const loadingTextEvidence = /\bplease\s+wait\b|\b(?:loading|fetching|preparing)\b.{0,80}\b(?:option|seat|fare|checkout|payment|travell?er|passenger|detail|trip)\b/i.test(mainText);
    return {
      documentReadyState: document.readyState || "unknown",
      ariaBusy: Boolean(queryAllDeep("[aria-busy='true']").some((element) => isVisible(element))),
      loadingIndicatorCount: loadingIndicators.length,
      loadingTextEvidence,
      mainTextLength: mainText.length,
      visibleMainCount: queryAllDeep("main, [role='main']").filter(isVisible).length,
      stableForMs: Math.max(0, Date.now() - Number(agent.lastPageMutationAt || Date.now()))
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
          stage: classifyStep({ visibleText: primaryPageText(), url: location.href }),
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

  function classifySurfaceSemantics(overlay, options = [], type = "popover") {
    const localText = compactText(overlayText(overlay), 1200).toLowerCase();
    const structuralChoices = options.filter((option) => (
      option.choiceStructure === true
      || /radio|checkbox|option/.test(String(option.accessibility?.role || "").toLowerCase())
    ));
    const choiceOptions = structuralChoices.length
      ? options.filter((option) => (
          option.choiceStructure === true
          || /radio|checkbox|option/.test(String(option.accessibility?.role || "").toLowerCase())
          || ["select_free_option", "select_paid_option"].includes(option.physicalEffect)
        ))
      : [];
    const fieldCount = overlay?.querySelectorAll?.("input:not([type='hidden']), select, textarea")?.length || 0;
    const effects = new Set(options.map((option) => option.physicalEffect).filter(Boolean));
    const failureEvidence = /something went wrong|technical (?:issue|problem|error)|service unavailable|temporarily unavailable|unable to (?:continue|complete|process)|could(?:n'?t| not) (?:continue|complete|process)/.test(localText);
    const terminalRecoveryEvidence = /try again later|back to (?:search|home|start)|start (?:again|over)|report (?:this )?error|reference id|visitor id|contact support/.test(localText);
    // This is a typed terminal website state, not a validation warning. It must
    // own the foreground before any stale form fields behind the surface.
    if (failureEvidence && terminalRecoveryEvidence) return "site_failure";
    if (choiceOptions.length >= 2) return "choice_set";
    if (fieldCount > 0) return "form";
    if (/review|verify|check your (details|information)/.test(localText)
      && (effects.has("advance_surface") || effects.has("advance_checkout_stage"))) return "review_confirmation";
    if (/warning|are you sure|attention|unable|problem|error|continue without|haven.?t selected a seat|not selected.*seat|seat.*not selected|without.*seat|skip seat selection/.test(localText)) return "warning";
    if (effects.has("advance_surface") || effects.has("advance_checkout_stage")) return "navigation";
    if (type !== "page" && options.length === 0) return "information";
    return "unknown";
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
      const ownedEvidence = controlOwnedEvidence(option);
      const fallbackSemantic = overlayOptionSemantic(label);
      const meaning = resolveOwnedControlMeaning(ownedEvidence, fallbackSemantic, type);
      const box = elementBox(option);
      const choiceStructure = Boolean(
        option.matches?.("input[type='radio'], input[type='checkbox'], [role='option']")
        || option.querySelector?.("input[type='radio'], input[type='checkbox'], [role='option']")
      );
      return {
        id: elementId(option),
        label,
        semantic: meaning.semantic,
        physicalEffect: meaning.physicalEffect,
        semanticConflict: meaning.conflict === true,
        testId: ownedEvidence.testId,
        formAction: ownedEvidence.formAction,
        formMethod: ownedEvidence.formMethod,
        formId: ownedEvidence.formId,
        ownText: ownedEvidence.ownText,
        ariaLabel: ownedEvidence.ariaLabel,
        title: ownedEvidence.title,
        iconOnly: ownedEvidence.iconOnly,
        choiceStructure,
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
    const surfaceClass = classifySurfaceSemantics(overlay, prioritized, type);
    let surface = {
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
      surfaceClass,
      options: prioritized,
      buttons: prioritized,
      box: elementBox(overlay),
      accessibility: accessibilityNode(overlay, map)
    };
    if (surface.surfaceClass === "warning" && surfaceLooksLikeSeatSkip(surface)) {
      const corrected = surface.options.map((option) => (
        /^(continue|next|proceed|go without|continue without)\b/i.test(option.label || "")
          ? { ...option, physicalEffect: "dismiss_surface" }
          : option
      ));
      surface = { ...surface, options: corrected, buttons: corrected };
    }
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

  function actionElementLabel(element) {
    return String(
      element?.innerText
      || element?.value
      || element?.getAttribute?.("aria-label")
      || element?.getAttribute?.("title")
      || ""
    ).replace(/\s+/g, " ").trim();
  }

  function structuralActionSignature(element) {
    if (!element) return "";
    const tag = String(element.tagName || "").toLowerCase();
    const role = String(element.getAttribute?.("role") || (tag === "button" ? "button" : "")).toLowerCase();
    const type = String(element.getAttribute?.("type") || element.type || "").toLowerCase();
    const popup = String(element.getAttribute?.("aria-haspopup") || "").toLowerCase();
    const pressable = element.hasAttribute?.("aria-pressed") ? "pressable" : "";
    const selectable = element.hasAttribute?.("aria-selected") || element.hasAttribute?.("aria-checked") ? "selectable" : "";
    const disabled = isDisabledLike(element) ? "disabled" : "enabled";
    return [tag, role, type, popup, pressable, selectable, disabled].join("|");
  }

  function structuralElementDepth(element) {
    let depth = 0;
    for (let current = element; current?.parentElement; current = current.parentElement) depth += 1;
    return depth;
  }

  function structuralCollectionContext(root, pageText = "") {
    if (!root) return normalizedTransportText(pageText).slice(0, 1200);
    const labelledBy = String(root.getAttribute?.("aria-labelledby") || "")
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent || "")
      .join(" ");
    const localOwner = root.closest?.("section, fieldset, main, [role='main'], [role='group'], [role='grid']") || root;
    const heading = localOwner.querySelector?.("h1, h2, h3, legend, [role='heading']")?.textContent || "";
    return normalizedTransportText([
      root.getAttribute?.("aria-label"),
      root.getAttribute?.("title"),
      labelledBy,
      heading,
      String(pageText || "").slice(0, 1200)
    ].filter(Boolean).join(" "));
  }

  function structuralCollectionType(context = "") {
    return /seat selection|select (?:a )?seat|choose (?:a )?seat|seat map|seating|standard seat|extra legroom/.test(context)
      ? "seat_inventory"
      : "repeated_choices";
  }

  function taskCriticalCollectionElement(element) {
    if (!element) return false;
    if (isChoiceSelected(element)
      || element.getAttribute?.("aria-selected") === "true"
      || element.getAttribute?.("aria-checked") === "true") return true;
    const label = normalizedTransportText(actionElementLabel(element));
    return /continue|next|proceed|skip|without|random|automatic|free assignment|no thanks|remove|back|done|confirm/.test(label);
  }

  // Discover high-cardinality UI from repeated DOM topology before individual
  // controls receive expensive geometry, accessibility, ownership, and option
  // compilation. Individual wording and currency formatting are deliberately
  // absent from membership: one logical item may be split across an activation
  // node ("1688") and a separate state node ("Seat 4F Standard").
  function discoverStructuralActionCollections(elements = [], pageText = "") {
    const source = [...elements];
    if (source.length < 64) return [];
    const ancestors = new Map();
    source.forEach((element) => {
      let current = element.parentElement;
      for (let depth = 0; current && depth < 9 && current !== document.documentElement; depth += 1, current = current.parentElement) {
        if (current.closest?.("#atw-sidebar")) break;
        if (!ancestors.has(current)) ancestors.set(current, []);
        ancestors.get(current).push(element);
        if (current === document.body) break;
      }
    });

    const candidates = [];
    for (const [root, descendants] of ancestors.entries()) {
      if (descendants.length < 64) continue;
      const signatures = new Map();
      descendants.forEach((element) => {
        const signature = structuralActionSignature(element);
        if (!signature) return;
        if (!signatures.has(signature)) signatures.set(signature, []);
        signatures.get(signature).push(element);
      });
      // Split widgets commonly expose two repeated physical signatures. A
      // threshold of 24 admits those halves while the combined collection must
      // still contain at least 64 members.
      const repeated = [...signatures.values()]
        .filter((group) => group.length >= 24)
        .flat();
      const members = [...new Set(repeated)];
      if (members.length < 64) continue;
      const context = structuralCollectionContext(root, pageText);
      candidates.push({
        root,
        type: structuralCollectionType(context),
        context,
        members,
        memberSet: new Set(members),
        depth: structuralElementDepth(root)
      });
    }

    // The tightest root with the largest repeated membership is the collection
    // owner. This excludes surrounding checkout chrome even when it shares a
    // broad ancestor with the collection.
    const selected = [];
    const claimed = new Set();
    candidates
      .sort((left, right) => right.members.length - left.members.length || right.depth - left.depth)
      .forEach((candidate) => {
        const unclaimed = candidate.members.filter((element) => !claimed.has(element));
        if (unclaimed.length < 64) return;
        // An ancestor with identical membership is redundant; keep the deeper
        // local owner selected earlier by the tie-break above.
        if (selected.some((item) => item.members.length === candidate.members.length
          && item.members.every((element) => candidate.memberSet.has(element)))) return;
        unclaimed.forEach((element) => claimed.add(element));
        selected.push({ ...candidate, members: unclaimed, memberSet: new Set(unclaimed) });
      });
    return selected;
  }

  function boundHighCardinalityActionElements(elements = [], descriptors = []) {
    const source = [...elements];
    if (source.length < 120) {
      return { elements: source, collections: [], sourceCount: source.length, omittedCount: 0 };
    }
    const profileMode = seatTransportProfileMode({ traveler: traveler() || {} });
    if (profileMode !== "random_assignment") {
      return { elements: source, collections: [], sourceCount: source.length, omittedCount: 0 };
    }
    const descriptor = descriptors
      .filter((item) => item.type === "seat_inventory")
      .sort((left, right) => right.members.length - left.members.length)[0] || null;
    const inventory = descriptor?.members || [];
    if (inventory.length < 64) {
      return { elements: source, collections: [], sourceCount: source.length, omittedCount: 0 };
    }
    const retainedInventory = inventory.filter(taskCriticalCollectionElement);
    const retainedSet = new Set(retainedInventory);
    const inventorySet = new Set(inventory);
    const retained = source.filter((element) => !inventorySet.has(element) || retainedSet.has(element));
    const prices = inventory
      .map((element) => structuredPriceFromText(actionElementLabel(element))?.amount)
      .filter((amount) => Number.isFinite(amount));
    const collection = {
      collectionId: `collection_${stableHash(`seat_inventory:${inventory.length}:${location.pathname}`)}`,
      type: "seat_inventory",
      decisionGroupId: "",
      sectionId: "",
      sectionType: "seat",
      surfaceId: "surface-page",
      totalCount: inventory.length,
      retainedCount: retainedInventory.length,
      omittedCount: Math.max(0, inventory.length - retainedInventory.length),
      availableCount: inventory.filter((element) => !isDisabledLike(element)).length,
      disabledCount: inventory.filter(isDisabledLike).length,
      selectedCount: retainedInventory.length,
      paidCount: prices.filter((amount) => amount > 0).length,
      freeCount: prices.filter((amount) => amount === 0).length,
      priceRange: prices.length ? {
        minimum: Math.min(...prices),
        maximum: Math.max(...prices),
        currency: ""
      } : null,
      profileMode,
      requiresExpansion: false,
      source: "structural_pre_compilation_collection",
      evidence: {
        ownerRole: descriptor.root.getAttribute?.("role") || "",
        ownerLabel: compactText(descriptor.root.getAttribute?.("aria-label") || "", 120),
        repeatedSignatureCount: new Set(inventory.map(structuralActionSignature)).size
      }
    };
    return {
      elements: retained,
      collections: [collection],
      sourceCount: source.length,
      omittedCount: inventory.length - retainedInventory.length
    };
  }

  function buildPageMap() {
    activeObservationElementRegistry = createObservationElementRegistry();
    activeObservationControlRegistry = null;
    const text = primaryPageText();
    const fullText = visiblePageText();
    const sourceActionElements = queryAllDeep("button, a, input[type='button'], input[type='submit'], [role='button'], [role='option'], [role='menuitem'], [role='checkbox'], [role='radio']")
      .filter((button) => isVisible(button) && !button.closest("#atw-sidebar") && !isPaymentField(button) && !isAuxiliaryNavigationAction(button));
    const structuralCollections = discoverStructuralActionCollections(sourceActionElements, `${text} ${fullText.slice(0, 2500)}`);
    const seatInventoryCount = structuralCollections
      .filter((collection) => collection.type === "seat_inventory")
      .reduce((total, collection) => total + collection.members.length, 0);
    const step = classifyStep({
      visibleText: `${text} ${fullText.slice(0, 2500)}`,
      url: location.href,
      structuralEvidence: { seatInventoryCount }
    });
    const fields = candidateInputs().map((input) => {
      const detected = detectField(input);
      const semantic = detected?.fieldType || detected?.field || "unknown";
      const value = fieldValue(input);
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
        value,
      hasValue: Boolean(value && !isPlaceholderChoiceValue(value)),
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
    const activeSurface = buildActiveSurface(activeOverlayElements(), sections, taskQueue);
    let controls = buildCanonicalControlGraph(sections, fields, buttons, activeSurface);
    syncRequiredProfileChoiceGroups(fields, controls, sections);
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
    let decisionGroups = buildCanonicalDecisionGroups(sections, controls, activeSurface);
    const semanticCompilation = AGENT_CONTRACT?.compileSemanticCheckout
      ? AGENT_CONTRACT.compileSemanticCheckout({
          step,
          text,
          fullText,
          visibleText: fullText,
          readiness: pageReadinessFacts(),
          currentSurface: activeSurface,
          controls,
          decisionGroups
        })
      : {
          semanticReadiness: "ready",
          controls,
          decisionGroups,
          decisionContracts: [],
          unownedMaterialControls: [],
          unresolvedDecisions: [],
          currentExecutableObligations: []
        };
    controls = semanticCompilation.controls;
    decisionGroups = semanticCompilation.decisionGroups;
    const surfaceModel = buildSurfaceStack(activeSurface, sections, taskQueue, overlays, step);
    const stageExit = buildStageExit(decisionGroups, fields, buttons, overlays, errors, step, controls);
    const transactionFacts = transactionFactsEvidence({ step, price, decisionGroups, activeSurface });
    const map = {
      site: inferCheckoutSite(),
      step,
      text,
      fullText,
      coverage: pageCoverage(),
      readiness: pageReadinessFacts(),
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
      controlCollections: boundedActions.collections,
      graphIntegrity,
      decisionGroups,
      decisionContracts: semanticCompilation.decisionContracts,
      semanticReadiness: semanticCompilation.semanticReadiness,
      semanticCompilation: {
        contractVersion: semanticCompilation.contractVersion || AGENT_CONTRACT?.CONTRACT_VERSION || "",
        semanticReadiness: semanticCompilation.semanticReadiness,
        unownedMaterialControls: semanticCompilation.unownedMaterialControls,
        unresolvedDecisions: semanticCompilation.unresolvedDecisions,
        currentExecutableObligations: semanticCompilation.currentExecutableObligations,
        evidence: semanticCompilation.evidence || {}
      },
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
        semanticReadiness: semanticCompilation.semanticReadiness,
        unownedMaterialControls: semanticCompilation.unownedMaterialControls.length,
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

  function emptyPageStateDiff() {
    return {
      addedControls: [],
      removedControls: [],
      stateChanges: [],
      textChanges: [],
      validationChanges: [],
      priceChanges: [],
      surfaceChanges: []
    };
  }

  function canonicalPageStateDiff(before = null, after = null) {
    if (!before || !after) return emptyPageStateDiff();
    const diff = emptyPageStateDiff();
    const beforeControls = new Map((before.controls || []).map((control) => [control.controlId, control]));
    const afterControls = new Map((after.controls || []).map((control) => [control.controlId, control]));
    const stateFor = (control = {}) => ({
      checked: Boolean(control.state?.checked),
      selected: Boolean(control.state?.selected || control.selected),
      disabled: Boolean(control.state?.disabled),
      expanded: Boolean(control.state?.expanded),
      valuePresent: Boolean(control.state?.valuePresent),
      normalizedValue: String(control.state?.normalizedValue || control.currentValue || ""),
      selectedValue: String(control.state?.selectedValue || ""),
      fieldType: String(control.fieldType || ""),
      executable: Object.values(control.operations || {}).some((operation) => operation?.actionability?.executable === true)
    });
    for (const [controlId, control] of afterControls) {
      const prior = beforeControls.get(controlId);
      if (!prior) {
        diff.addedControls.push({ controlId, stableKey: control.stableKey || "", surfaceId: control.surfaceId || "" });
        continue;
      }
      const beforeState = stateFor(prior);
      const afterState = stateFor(control);
      if (JSON.stringify(beforeState) !== JSON.stringify(afterState)) {
        diff.stateChanges.push({ controlId, before: beforeState, after: afterState });
      }
      const beforeText = compactText([prior.ownText, prior.ariaLabel, prior.title, prior.label].filter(Boolean).join(" "), 240);
      const afterText = compactText([control.ownText, control.ariaLabel, control.title, control.label].filter(Boolean).join(" "), 240);
      if (beforeText !== afterText) diff.textChanges.push({ controlId, before: beforeText, after: afterText });
    }
    for (const [controlId, control] of beforeControls) {
      if (!afterControls.has(controlId)) {
        diff.removedControls.push({ controlId, stableKey: control.stableKey || "", surfaceId: control.surfaceId || "" });
      }
    }
    const validationKey = (issue = {}) => `${issue.issueId || issue.controlId || ""}:${issue.message || issue}`;
    const beforeValidation = new Set([...(before.validationIssues || []).map(validationKey), ...(before.errors || []).map(String)]);
    const afterValidation = new Set([...(after.validationIssues || []).map(validationKey), ...(after.errors || []).map(String)]);
    const appeared = [...afterValidation].filter((value) => !beforeValidation.has(value));
    const cleared = [...beforeValidation].filter((value) => !afterValidation.has(value));
    if (appeared.length || cleared.length) diff.validationChanges.push({ appeared, cleared });
    if (JSON.stringify(before.price || null) !== JSON.stringify(after.price || null)
      || JSON.stringify(before.transactionFacts?.selectedExtras || []) !== JSON.stringify(after.transactionFacts?.selectedExtras || [])) {
      diff.priceChanges.push({
        before: before.price || null,
        after: after.price || null,
        selectedExtrasBefore: before.transactionFacts?.selectedExtras || [],
        selectedExtrasAfter: after.transactionFacts?.selectedExtras || []
      });
    }
    const surfaceFor = (map = {}) => ({
      id: map.currentSurface?.id || "surface-page",
      type: map.currentSurface?.type || "page",
      label: map.currentSurface?.label || "",
      progressMarkers: map.foreground?.progressMarkers || map.currentSurface?.foreground?.progressMarkers || null
    });
    const beforeSurface = surfaceFor(before);
    const afterSurface = surfaceFor(after);
    if (JSON.stringify(beforeSurface) !== JSON.stringify(afterSurface)) {
      diff.surfaceChanges.push({ before: beforeSurface, after: afterSurface });
    }
    return Object.fromEntries(Object.entries(diff).map(([key, value]) => [key, value.slice(0, 40)]));
  }

  function pageStateDiffIsMaterial(diff = emptyPageStateDiff()) {
    return Object.values(diff).some((entries) => Array.isArray(entries) && entries.length > 0);
  }

  function mutationOwnedControlId(target) {
    if (!target || target.nodeType !== Node.ELEMENT_NODE) target = target?.parentElement || null;
    return target?.closest?.("[data-atw-control-id]")?.dataset?.atwControlId
      || target?.dataset?.atwControlId
      || "";
  }

  function mutationMayBeMaterial(mutation) {
    const target = mutation?.target?.nodeType === Node.ELEMENT_NODE
      ? mutation.target
      : mutation?.target?.parentElement;
    if (!target || target.closest?.("#atw-sidebar, #atw-screenshot-annotation-overlay")) return false;
    if (mutation.type === "viewport") return true;
    if (mutation.type === "attributes") {
      if (/^data-atw-/.test(mutation.attributeName || "")) return false;
      const materialAttributes = new Set([
        "checked", "selected", "value", "disabled", "required", "hidden", "open",
        "aria-checked", "aria-selected", "aria-expanded", "aria-disabled", "aria-invalid",
        "aria-hidden", "aria-valuenow", "data-price", "data-selected", "data-value"
      ]);
      if (materialAttributes.has(mutation.attributeName)) return true;
      if (["class", "style"].includes(mutation.attributeName)) {
        return Boolean(mutationOwnedControlId(target)
          || target.matches?.("[role='dialog'], [aria-modal='true'], .modal, .popover, [role='listbox'], [role='menu'], [role='alert'], progress"));
      }
      return false;
    }
    if (mutation.type === "characterData") {
      return Boolean(mutationOwnedControlId(target)
        || target.closest?.("[role='dialog'], [aria-modal='true'], [role='alert'], [aria-live], h1, h2, [data-checkout-step], [class*='step'], [class*='progress'], [data-price], [class*='price'], [class*='total'], progress"));
    }
    if (mutation.type === "childList") {
      const nodes = [...(mutation.addedNodes || []), ...(mutation.removedNodes || [])];
      const selector = "button, input, select, textarea, [role='button'], [role='option'], [role='radio'], [role='checkbox'], [role='dialog'], [aria-modal='true'], .modal, .popover, [role='listbox'], [role='menu'], [role='alert'], [aria-live], [data-price], [class*='price'], [class*='total'], progress";
      return nodes.some((node) => {
        if (node.nodeType === Node.TEXT_NODE) return Boolean(mutationOwnedControlId(target)
          || target.matches?.("h1, h2, [data-checkout-step], [class*='step'], [class*='progress'], [role='alert'], [aria-live], [data-price], [class*='price'], [class*='total'], progress")
          || target.closest?.("[role='dialog'], [aria-modal='true']"));
        return Boolean(node.matches?.(selector) || node.querySelector?.(selector));
      });
    }
    return mutation.type === "input" || mutation.type === "change";
  }

  function syncIncrementalControlModels(map, controlsById) {
    const sync = (items = []) => items.map((item) => {
      const control = controlsById.get(item.controlId || item.id);
      return control ? applyControlToModel({ ...item }, control) : item;
    });
    map.fields = sync(map.fields || []);
    map.buttons = sync(map.buttons || []);
    map.sections = (map.sections || []).map((section) => ({
      ...section,
      fields: sync(section.fields || []),
      choices: sync(section.choices || []),
      buttons: sync(section.buttons || [])
    }));
    if (map.currentSurface?.type && map.currentSurface.type !== "page") {
      map.currentSurface = {
        ...map.currentSurface,
        options: sync(map.currentSurface.options || []),
        buttons: sync(map.currentSurface.buttons || [])
      };
    }
    return map;
  }

  function createPageStateStore() {
    let canonical = null;
    let canonicalUrl = "";
    let dirty = true;
    let pendingMutations = [];
    let lastMaterialMutationAt = 0;
    let mutationVersion = 0;
    const mutationObservers = new Set();
    let incrementalUpdates = 0;
    let update = {
      mode: "uninitialized",
      reason: "initial",
      baseSnapshotHash: "",
      snapshotHash: "",
      diff: emptyPageStateDiff(),
      material: true,
      timings: {}
    };

    const recordMutation = (mutation) => {
      if (!mutationMayBeMaterial(mutation)) return false;
      mutationVersion += 1;
      pendingMutations.push(mutation);
      pendingMutations = pendingMutations.slice(-240);
      lastMaterialMutationAt = performance.now();
      dirty = true;
      agent.lastPageMutationAt = Date.now();
      return true;
    };

    const noteMutations = (mutations = []) => {
      let material = false;
      for (const mutation of mutations) material = recordMutation(mutation) || material;
      return material;
    };
    const noteEvent = (event) => recordMutation({ type: event.type, target: event.target });

    const attachMutationObserver = (observer) => {
      if (observer?.takeRecords) mutationObservers.add(observer);
      return observer;
    };

    const drainMutationRecords = () => {
      let material = false;
      for (const observer of mutationObservers) {
        const records = observer.takeRecords?.() || [];
        if (records.length) material = noteMutations(records) || material;
      }
      return material;
    };

    const mutationTargets = () => [...new Set(pendingMutations.map((mutation) => (
      mutation.target?.nodeType === Node.ELEMENT_NODE ? mutation.target : mutation.target?.parentElement
    )).filter(Boolean))];

    const canRefreshIncrementally = () => {
      if (!canonical || !pendingMutations.length || incrementalUpdates >= 24) return false;
      if (pendingMutations.some((mutation) => mutation.type === "childList" || mutation.type === "characterData")) return false;
      const ids = mutationTargets().map(mutationOwnedControlId).filter(Boolean);
      return ids.length > 0 && ids.length === mutationTargets().length;
    };

    const refreshControls = () => {
      const next = {
        ...canonical,
        controls: [...(canonical.controls || [])],
        transactionFacts: canonical.transactionFacts ? { ...canonical.transactionFacts } : null
      };
      const controlsById = new Map(next.controls.map((control) => [control.controlId, control]));
      const dirtyIds = [...new Set(mutationTargets().map(mutationOwnedControlId).filter(Boolean))];
      for (const controlId of dirtyIds) {
        const prior = controlsById.get(controlId);
        if (!prior) return null;
        const live = elementById(prior.stateElementId)
          || document.querySelector(`[data-atw-control-id="${CSS.escape(controlId)}"]`);
        if (!live || !live.isConnected) return null;
        const surface = prior.surfaceId === canonical.currentSurface?.id ? canonical.currentSurface : {
          id: prior.surfaceId || "surface-page",
          type: prior.surfaceType || "page",
          label: prior.surfaceLabel || ""
        };
        const refreshed = canonicalControlForElement(live, {
          field: prior.fieldType || prior.field || "",
          fieldType: prior.fieldType || "",
          required: prior.required,
          decisionGroupId: prior.decisionGroupId || "",
          sectionId: prior.sectionId || "",
          sectionType: prior.sectionType || "",
          sectionLabel: prior.sectionLabel || "",
          surface
        });
        if (!refreshed || refreshed.controlId !== controlId) return null;
        const fieldType = refreshed.fieldType || prior.fieldType || "";
        controlsById.set(controlId, {
          ...refreshed,
          fieldType,
          fieldClassification: refreshed.fieldClassification?.fieldType
            ? refreshed.fieldClassification
            : (prior.fieldClassification || null),
          semantic: fieldType || (refreshed.semantic && refreshed.semantic !== "unknown" ? refreshed.semantic : prior.semantic),
          semanticIntent: fieldType || (refreshed.semanticIntent && refreshed.semanticIntent !== "unknown" ? refreshed.semanticIntent : prior.semanticIntent),
          meaning: fieldType || refreshed.meaning || prior.meaning
        });
      }
      next.controls = next.controls.map((control) => controlsById.get(control.controlId) || control);
      syncIncrementalControlModels(next, controlsById);
      syncRequiredProfileChoiceGroups(next.fields || [], next.controls || [], next.sections || []);
      next.decisionGroups = buildCanonicalDecisionGroups(next.sections || [], next.controls, next.currentSurface || {});
      if (AGENT_CONTRACT?.compileSemanticCheckout) {
        const semanticCompilation = AGENT_CONTRACT.compileSemanticCheckout({
          ...next,
          visibleText: next.fullText || next.text || ""
        });
        next.controls = semanticCompilation.controls;
        next.decisionGroups = semanticCompilation.decisionGroups;
        next.decisionContracts = semanticCompilation.decisionContracts;
        next.semanticReadiness = semanticCompilation.semanticReadiness;
        next.semanticCompilation = {
          contractVersion: semanticCompilation.contractVersion,
          semanticReadiness: semanticCompilation.semanticReadiness,
          unownedMaterialControls: semanticCompilation.unownedMaterialControls,
          unresolvedDecisions: semanticCompilation.unresolvedDecisions,
          currentExecutableObligations: semanticCompilation.currentExecutableObligations,
          evidence: semanticCompilation.evidence || {}
        };
      }
      // transactionFacts.selectedExtras is the observation's canonical outcome
      // snapshot. Compact recovery may refresh controls and decisions, but it
      // must not replace that snapshot with only the choices still visible
      // after a rerender. The backend compiler safely enriches it from the
      // refreshed canonical decisions and the durable outcome ledger.
      next.stageExit = buildStageExit(next.decisionGroups, next.fields, next.buttons, next.overlays, next.errors, next.step, next.controls);
      next.summary = {
        ...(next.summary || {}),
        fields: next.fields.length,
        knownFields: next.fields.filter((field) => field.field !== "unknown").length,
        buttons: next.buttons.length,
        controls: next.controls.length,
        decisionGroups: next.decisionGroups.length,
        semanticReadiness: next.semanticReadiness || "ready",
        unownedMaterialControls: next.semanticCompilation?.unownedMaterialControls?.length || 0,
        continueAllowed: next.stageExit.continueAllowed
      };
      return next;
    };

    const observe = ({ forceFull = false, reason = "observe" } = {}) => {
      const startedAt = performance.now();
      drainMutationRecords();
      const urlChanged = Boolean(canonicalUrl && canonicalUrl !== location.href);
      if (canonical && !dirty && !forceFull && !urlChanged) {
        update = {
          ...update,
          mode: "cached",
          reason,
          diff: emptyPageStateDiff(),
          material: false,
          fresh: true,
          captureStartVersion: mutationVersion,
          captureEndVersion: mutationVersion,
          timings: { observationBuildMs: Math.round(performance.now() - startedAt) }
        };
        return { map: canonical, ...update };
      }
      const before = canonical;
      const baseSnapshotHash = before ? observationHashForMap(before) : "";
      const captureStartVersion = mutationVersion;
      let next = null;
      let mode = "full_snapshot";
      if (!forceFull && !urlChanged && canRefreshIncrementally()) {
        next = refreshControls();
        if (next) {
          mode = "incremental";
          incrementalUpdates += 1;
        }
      }
      if (!next) {
        next = rememberPagePlan(buildPageMap());
        incrementalUpdates = 0;
        mode = before && !urlChanged && !forceFull ? "material_rescan" : "full_snapshot";
      }
      // MutationObserver callbacks do not run while a synchronous page-map
      // build owns the main thread. Drain their queued records before deciding
      // that this snapshot is current; otherwise a control that appeared
      // during a long build can be absent from a snapshot incorrectly cached
      // as clean.
      drainMutationRecords();
      const captureEndVersion = mutationVersion;
      const fresh = captureStartVersion === captureEndVersion;
      const diff = canonicalPageStateDiff(before, next);
      canonical = next;
      canonicalUrl = location.href;
      dirty = !fresh;
      if (fresh) pendingMutations = [];
      update = {
        mode,
        reason,
        baseSnapshotHash,
        snapshotHash: observationHashForMap(next),
        diff,
        material: !before || pageStateDiffIsMaterial(diff),
        fresh,
        captureStartVersion,
        captureEndVersion,
        timings: { observationBuildMs: Math.round(performance.now() - startedAt) }
      };
      logFlow("page_state.updated", {
        mode,
        reason,
        material: update.material,
        fresh,
        captureStartVersion,
        captureEndVersion,
        baseSnapshotHash,
        snapshotHash: update.snapshotHash,
        counts: Object.fromEntries(Object.entries(diff).map(([key, entries]) => [key, entries.length])),
        observation_build_ms: update.timings.observationBuildMs
      });
      return { map: canonical, ...update };
    };

    const waitForQuiet = async ({ maxWaitMs = 650, minQuietMs = 70, awaitMutationMs = 0 } = {}) => {
      const startedAt = performance.now();
      while (!dirty && awaitMutationMs > 0 && performance.now() - startedAt < Math.min(awaitMutationMs, maxWaitMs)) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      while (dirty && performance.now() - startedAt < maxWaitMs) {
        const dynamicQuietMs = Math.min(240, minQuietMs + pendingMutations.length * 3);
        const elapsedQuiet = performance.now() - lastMaterialMutationAt;
        if (elapsedQuiet >= dynamicQuietMs) break;
        await sleep(Math.min(40, Math.max(8, dynamicQuietMs - elapsedQuiet)));
      }
      return { waitedMs: Math.round(performance.now() - startedAt), settled: !dirty || performance.now() - lastMaterialMutationAt >= minQuietMs };
    };

    const observeFresh = async ({
      reason = "fresh_observation",
      maxWaitMs = 800,
      maxAttempts = 2,
      postBuildGraceMs = 100
    } = {}) => {
      let lastObserved = null;
      const attempts = Math.max(1, Math.min(3, Number(maxAttempts || 2)));
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        await waitForQuiet({
          maxWaitMs,
          minQuietMs: 80,
          // A clean cached observation is already safe to reuse immediately.
          // Waiting speculatively for a future mutation slows destination
          // readiness polling and cannot make that cached state more atomic.
          // The post-build grace below protects the expensive-scan boundary
          // where framework work can be delayed by our synchronous capture.
          awaitMutationMs: 0
        });
        const observed = observe({
          forceFull: attempt > 1,
          reason: attempt === 1 ? reason : `${reason}:fresh_retry_${attempt}`
        });
        lastObserved = observed;

        // Yield once after an expensive synchronous scan. This lets queued
        // framework timers and MutationObserver delivery expose controls that
        // hydrated while the main thread was occupied by observation.
        if (observed.mode !== "cached" && postBuildGraceMs > 0) {
          await waitForQuiet({
            maxWaitMs: postBuildGraceMs,
            minQuietMs: 40,
            awaitMutationMs: postBuildGraceMs
          });
        }
        drainMutationRecords();
        const stable = observed.fresh !== false
          && observed.captureEndVersion === mutationVersion
          && !dirty;
        if (stable) {
          return {
            ...observed,
            fresh: true,
            freshnessAttempts: attempt,
            mutationVersion
          };
        }
        logFlow("page_state.stale_capture_discarded", {
          reason,
          attempt,
          mode: observed.mode,
          captureStartVersion: observed.captureStartVersion,
          captureEndVersion: observed.captureEndVersion,
          currentMutationVersion: mutationVersion,
          pendingMutations: pendingMutations.length
        });
      }
      return {
        ...(lastObserved || { map: canonical, ...update }),
        fresh: false,
        freshnessAttempts: attempts,
        mutationVersion
      };
    };

    const invalidate = (reason = "integrity_recovery") => {
      dirty = true;
      pendingMutations.push({ type: "integrity", target: document.documentElement, reason });
      lastMaterialMutationAt = performance.now();
    };

    return {
      observe,
      observeFresh,
      waitForQuiet,
      noteMutations,
      noteEvent,
      attachMutationObserver,
      invalidate,
      current: () => canonical,
      lastUpdate: () => update,
      isDirty: () => dirty,
      pendingCount: () => pendingMutations.length,
      mutationVersion: () => mutationVersion
    };
  }

  pageStateStore = createPageStateStore();

  async function observePageStateAfterMutation(reason = "post_action_verification", maxWaitMs = 800) {
    const observed = await pageStateStore.observeFresh({
      reason,
      maxWaitMs,
      maxAttempts: 2,
      postBuildGraceMs: 120
    });
    agent.pageMap = rememberPagePlan(observed.map);
    return observed;
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
      const directlyOwnedFields = fields.filter((field) => {
        const input = field.element;
        const references = `${input?.getAttribute?.("aria-errormessage") || ""} ${input?.getAttribute?.("aria-describedby") || ""}`
          .split(/\s+/)
          .filter(Boolean);
        return errorId && references.includes(errorId);
      });
      const directlyOwnedField = directlyOwnedFields.length === 1 ? directlyOwnedFields[0] : null;
      const sharedOwnerKeys = [...new Set(directlyOwnedFields.map((field) => (
        field.fieldClassification?.tightOwnerKey
        || classifyProfileField(field.element, field.fieldType || field.field || "").tightOwnerKey
        || ""
      )).filter(Boolean))];
      const sharedSemanticTypes = [...new Set(directlyOwnedFields.map((field) => (
        field.fieldType || field.field || ""
      )).filter(Boolean))];
      const logicalGroupOwned = Boolean(
        directlyOwnedFields.length > 1
        && sharedOwnerKeys.length === 1
        && sharedSemanticTypes.length === 1
      );
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
      let nearestField = logicalGroupOwned ? null : (directlyOwnedField || null);
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
        logicalOwnerKey: logicalGroupOwned ? sharedOwnerKeys[0] : "",
        componentRole: logicalGroupOwned
          ? ""
          : (nearestField?.dateField?.component || control?.dateField?.component || ""),
        semanticType: control?.semantic || nearestField?.field || sharedSemanticTypes[0] || "",
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
        logicalOwnerKey: explicitOwner.logicalOwnerKey || owner.logicalOwnerKey || "",
        componentRole: explicitOwner.componentRole || owner.componentRole || "",
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
    const dataDisabled = element.getAttribute?.("data-disabled");
    const explicitDisabledClass = [...(element.classList || [])]
      .some((token) => /^(?:is[-_])?disabled$/i.test(token));
    return Boolean(
      element.disabled === true
      || element.matches?.(":disabled") === true
      || element.getAttribute?.("aria-disabled") === "true"
      || (dataDisabled !== null && !/^(?:false|0|off)$/i.test(String(dataDisabled)))
      || element.matches?.("[inert]") === true
      || element.closest?.("[inert]")
      || explicitDisabledClass
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

  function revealabilityForElement(element, box = null) {
    if (!element || !box || box.inViewport === true) {
      return { revealable: false, clippedInactive: false };
    }
    const rect = element.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    let clippedInactive = false;
    let scrollReachable = false;
    for (let current = composedParent(element); current && current !== document.body && current !== document.documentElement; current = composedParent(current)) {
      const style = getComputedStyle(current);
      const overflowX = style.overflowX || style.overflow || "visible";
      const overflowY = style.overflowY || style.overflow || "visible";
      const containerRect = current.getBoundingClientRect();
      const clippedX = /(auto|scroll|overlay|hidden|clip)/.test(overflowX)
        && (centerX < containerRect.left || centerX > containerRect.right);
      const clippedY = /(auto|scroll|overlay|hidden|clip)/.test(overflowY)
        && (centerY < containerRect.top || centerY > containerRect.bottom);
      if (!clippedX && !clippedY) continue;
      const xScrollable = clippedX
        && /(auto|scroll|overlay)/.test(overflowX)
        && current.scrollWidth > current.clientWidth + 2;
      const yScrollable = clippedY
        && /(auto|scroll|overlay)/.test(overflowY)
        && current.scrollHeight > current.clientHeight + 2;
      if ((clippedX && !xScrollable) || (clippedY && !yScrollable)) {
        clippedInactive = true;
        break;
      }
      scrollReachable = scrollReachable || xScrollable || yScrollable;
    }
    if (clippedInactive) return { revealable: false, clippedInactive: true };

    const outsideWindowX = centerX < 0 || centerX > window.innerWidth;
    const outsideWindowY = centerY < 0 || centerY > window.innerHeight;
    const documentScroller = document.scrollingElement || document.documentElement;
    const documentReachable = Boolean(
      (outsideWindowX && documentScroller.scrollWidth > window.innerWidth + 2)
      || (outsideWindowY && documentScroller.scrollHeight > window.innerHeight + 2)
    );
    return {
      revealable: scrollReachable || documentReachable,
      clippedInactive: false
    };
  }

  function actuatorActionability(element, surface = {}, operation = "", {
    operationProven = true,
    operationProof = ""
  } = {}) {
    const rendered = Boolean(element?.isConnected && isVisible(element));
    const style = rendered ? getComputedStyle(element) : null;
    const visible = Boolean(rendered
      && style?.visibility !== "hidden"
      && style?.display !== "none"
      && Number(style?.opacity || 1) >= 0.15
      && style?.pointerEvents !== "none");
    const enabled = Boolean(visible && !isDisabledLike(element));
    const box = rendered ? elementBox(element) : null;
    const inViewport = box?.inViewport === true;
    const expectedSurfaceId = surface.id || "surface-page";
    const membership = element
      ? surfaceMembershipForElement(element, surface)
      : { surfaceId: "", evidence: [] };
    const inCurrentSurface = Boolean(element && membership.surfaceId === expectedSurfaceId);
    const hitTested = Boolean(enabled && inViewport && clickPointIsClear(element));
    const notOccluded = hitTested;
    const revealability = revealabilityForElement(element, box);
    const operationAuthorized = Boolean(operation);
    const targetable = Boolean(
      rendered
      && visible
      && enabled
      && inCurrentSurface
      && inViewport
      && hitTested
      && notOccluded
    );
    const executable = Boolean(
      targetable
      && operationAuthorized
      && operationProven === true
    );
    const revealable = Boolean(
      rendered
      && visible
      && enabled
      && inCurrentSurface
      && !inViewport
      && revealability.revealable
      && operationAuthorized
      && operationProven === true
    );
    const code = executable
      ? "ACTIONABLE"
      : !rendered
        ? "ACTUATOR_NOT_RENDERED"
        : !visible
          ? "ACTUATOR_NOT_VISIBLE"
          : !enabled
            ? "ACTUATOR_DISABLED"
            : !inCurrentSurface
              ? "ACTUATOR_OUTSIDE_CURRENT_SURFACE"
              : !inViewport
                ? (revealability.clippedInactive
                    ? "ACTUATOR_CLIPPED_INACTIVE"
                    : (revealable ? "ACTUATOR_OUT_OF_VIEW" : "ACTUATOR_OUT_OF_VIEW_UNREACHABLE"))
                : !hitTested || !notOccluded
                ? "ACTUATOR_OCCLUDED"
                : operationProven !== true
                  ? "OPERATION_NOT_PROVEN"
                  : "OPERATION_NOT_AUTHORIZED";
    return {
      rendered,
      visible,
      enabled,
      inViewport,
      inCurrentSurface,
      hitTested,
      notOccluded,
      targetable,
      operationAuthorized,
      operationProven: operationProven === true,
      operationProof: String(operationProof || ""),
      executable,
      revealable,
      code,
      surfaceId: membership.surfaceId || "",
      operation,
      box
    };
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
      surfaceClass: surface.surfaceClass || "unknown",
      blocksBackground: Boolean(surface.blocksBackground),
      parentSurfaceId: surface.parentSurfaceId || "",
      observationId: surface.observationId || "",
      memberControlIds: uniqueControlIds(surface.memberControlIds || surface.controlIds || surface.options || []),
      memberActuatorIds: [...new Set(surface.memberActuatorIds || [])].filter(Boolean),
      foreground: surface.foreground || surface.visualState?.foreground || null
    };
  }

  function compactPageMap(map, observationId = "") {
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
      step: map.step || "unknown",
      stepEvidence: {
        source: "extension_fresh_observation",
        value: map.step || "unknown",
        snapshotHash: observationHashForMap(map)
      },
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        scrollX: Math.round(window.scrollX),
        scrollY: Math.round(window.scrollY),
        devicePixelRatio: window.devicePixelRatio || 1
      },
      coverage: map.coverage || null,
      readiness: map.readiness || null,
      stageExit: map.stageExit || null,
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
      // This is intentionally lossless. Meaning is resolved once by the
      // backend Logical Field Adapter; transport only refreshes observation
      // binding (not semantic ownership) and preserves the complete control.
      controls: (map.controls || []).map((control) => {
        const outgoing = {
          ...control,
          recovery: Object.fromEntries(Object.entries(control.recovery || {}).map(([operation, recovery]) => [
            operation,
            recovery
              ? {
                  ...recovery,
                  regions: (recovery.regions || []).map((region) => normalizeVisualRegionContract(region, {
                    observationId,
                    controlId: control.controlId,
                    operation,
                    source: `control.recovery.${operation}`,
                    surfaceId: control.surfaceId || ""
                  }))
                }
              : null
          ])),
          visualRegions: (control.visualRegions || []).map((region) => normalizeVisualRegionContract(region, {
            observationId,
            controlId: control.controlId,
            operation: region.operation || "",
            source: region.source || "control.visual_region",
            surfaceId: control.surfaceId || ""
          })),
          visualRegion: control.visualRegion
            ? normalizeVisualRegionContract(control.visualRegion, {
                observationId,
                controlId: control.controlId,
                source: control.visualRegion.source || "control.visual_region",
                surfaceId: control.surfaceId || ""
              })
            : null
        };
        return AGENT_CONTRACT?.serializeObservedControl
          ? AGENT_CONTRACT.serializeObservedControl(outgoing, { observationId })
          : JSON.parse(JSON.stringify(outgoing));
      }),
      controlCollections: (map.controlCollections || []).map((collection) => ({
        ...(AGENT_CONTRACT?.cloneSerializable?.(collection) || JSON.parse(JSON.stringify(collection)))
      })),
      transportCompleteness: (map.controlCollections || []).some((collection) => Number(collection.omittedCount || 0) > 0)
        ? "task_complete"
        : "full",
      decisionGroups: (map.decisionGroups || []).map((group) => ({
        ...(AGENT_CONTRACT?.cloneSerializable?.(group) || JSON.parse(JSON.stringify(group))),
        alternativeControlIds: uniqueControlIds(group.alternativeControlIds || group.alternatives || [])
      })),
      errors: actionableCheckoutErrors(map.errors),
      validationIssues: (map.validationIssues || []).map((issue) => (
        AGENT_CONTRACT?.cloneSerializable?.(issue) || JSON.parse(JSON.stringify(issue))
      )).slice(0, 12),
      paidChoices: map.paidChoices,
      completedFields: agent.completedFields || {},
      sections: (map.sections || []).map((section) => ({
        id: section.id,
        label: section.label,
        type: section.type,
        order: section.order,
        required: Boolean(section.required),
        paidChoice: Boolean(section.paidChoice),
        controlIds: uniqueControlIds([
          ...(section.fields || []),
          ...(section.choices || []),
          ...(section.buttons || [])
        ]),
        box: section.box,
        text: section.text
      })),
      summary: {
        fields: map.fields?.length || 0,
        buttons: map.buttons?.length || 0,
        controls: map.controls?.length || 0,
        sourceControls: map.summary?.sourceControls || map.controls?.length || 0,
        perceptionOmittedControls: map.summary?.perceptionOmittedControls || 0,
        controlCollections: map.controlCollections?.length || 0,
        decisionGroups: map.decisionGroups?.length || 0,
        overlays: map.overlays?.length || 0,
        priceText: map.priceText || ""
      },
      coverage: map.coverage,
      readiness: map.readiness || {},
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

  function observationNeedsScreenshot(map = {}) {
    const graph = map.graphIntegrity || {};
    if (graph.ok === false && Number(graph.actionableConflictCount || graph.aliasConflictCount || 0) > 0) return true;
    const surfaceId = map.currentSurface?.id || map.currentSurface?.surfaceId || "surface-page";
    return (map.controls || []).some((control) => {
      if (control.surfaceId && control.surfaceId !== surfaceId) return false;
      const executable = Object.values(control.operations || {}).some((operation) => (
        operation?.actionability?.executable === true || operation?.actionability?.revealable === true
      ));
      if (!executable || !control.visualRegion) return false;
      const localIdentity = compactText([
        control.ownText,
        control.ariaLabel,
        control.title,
        control.testId,
        control.label,
        control.accessibleName
      ].filter(Boolean).join(" "), 240);
      return !localIdentity;
    });
  }

  function observationTransportBytes(payload = {}) {
    return new Blob([JSON.stringify(payload)]).size;
  }

  const MAX_ACTION_RESULT_TRANSPORT_BYTES = 96_000;
  const OMITTED_ACTION_TRANSPORT_KEYS = new Set([
    "map",
    "page",
    "beforeMap",
    "afterMap",
    "observation",
    "fullText",
    "html",
    "innerHTML",
    "outerHTML",
    "screenshot",
    "screenshotDataUrl"
  ]);

  function compactActionTransportValue(value, depth = 0, seen = new WeakSet()) {
    if (value == null || typeof value === "boolean" || typeof value === "number") return value;
    if (typeof value === "string") return compactText(value, 2_000);
    if (typeof value !== "object" || depth >= 7) return undefined;
    if (seen.has(value)) return undefined;
    seen.add(value);
    if (Array.isArray(value)) {
      return value
        .slice(0, 60)
        .map((item) => compactActionTransportValue(item, depth + 1, seen))
        .filter((item) => item !== undefined);
    }
    const compact = {};
    for (const [key, item] of Object.entries(value).slice(0, 120)) {
      if (OMITTED_ACTION_TRANSPORT_KEYS.has(key)) continue;
      const next = compactActionTransportValue(item, depth + 1, seen);
      if (next !== undefined) compact[key] = next;
    }
    return compact;
  }

  function minimalActionResultForTransport(result = {}) {
    const outcome = result.outcome && typeof result.outcome === "object" ? result.outcome : {};
    const choiceCommit = compactChoiceCommitEvidence(outcome.evidence?.choiceCommit || null);
    return {
      at: result.at || "",
      actionId: String(result.actionId || ""),
      observationId: String(result.observationId || ""),
      plannedObservationId: String(result.plannedObservationId || ""),
      observationHash: String(result.observationHash || ""),
      resultObservationHash: String(result.resultObservationHash || ""),
      requirementId: String(result.requirementId || ""),
      intent: compactText(result.intent || "", 500),
      semanticIntent: compactText(result.semanticIntent || "", 500),
      mechanicalEffect: compactText(result.mechanicalEffect || "", 500),
      operation: String(result.operation || ""),
      goalId: String(result.goalId || ""),
      decisionInstanceId: String(result.decisionInstanceId || ""),
      candidateId: String(result.candidateId || ""),
      controlId: String(result.controlId || ""),
      skillPlanId: String(result.skillPlanId || ""),
      skillAtomId: String(result.skillAtomId || ""),
      dispatched: result.dispatched === true,
      targetResolved: result.targetResolved === true,
      clickReachedPage: result.clickReachedPage === true,
      pageChanged: result.pageChanged === true,
      activeSurfaceChanged: result.activeSurfaceChanged === true,
      expectedOutcomeObserved: result.expectedOutcomeObserved === true,
      postconditionSatisfied: result.postconditionSatisfied === true,
      executed: result.executed === true,
      verified: result.verified === true,
      failureCode: String(result.failureCode || outcome.code || ""),
      action: compactActionTransportValue(result.action || {}),
      targetSnapshot: compactActionTransportValue(result.targetSnapshot || {}),
      expectedOutcome: compactActionTransportValue(result.expectedOutcome || {}),
      outcome: {
        ok: outcome.ok === true,
        code: String(outcome.code || result.failureCode || ""),
        message: compactText(outcome.message || "", 600),
        feedback: compactActionTransportValue(outcome.feedback || {}),
        evidence: choiceCommit ? { choiceCommit } : {}
      }
    };
  }

  function compactActionResultForTransport(result = null) {
    if (!result || typeof result !== "object") return null;
    const compact = compactActionTransportValue(result);
    if (observationTransportBytes(compact) <= MAX_ACTION_RESULT_TRANSPORT_BYTES) return compact;
    return minimalActionResultForTransport(result);
  }

  function compactObservationActionContext(payload = {}) {
    return {
      ...payload,
      actionHistory: Array.isArray(payload.actionHistory)
        ? payload.actionHistory.slice(-12).map(compactActionResultForTransport).filter(Boolean)
        : [],
      lastActionResult: compactActionResultForTransport(payload.lastActionResult)
    };
  }

  function normalizedTransportText(value = "") {
    return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
  }

  function transportProfileValues(payload = {}) {
    const values = [];
    const visit = (value) => {
      if (value == null) return;
      if (typeof value === "string" || typeof value === "number") {
        const clean = normalizedTransportText(value);
        if (clean.length >= 3) values.push(clean);
        return;
      }
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      if (typeof value === "object") Object.values(value).forEach(visit);
    };
    visit(payload.traveler || {});
    visit(payload.userPolicy || {});
    visit(payload.userIntent || "");
    return [...new Set(values)].slice(0, 80);
  }

  function seatTransportProfileMode(payload = {}) {
    const travelerProfile = payload.traveler || {};
    const explicit = normalizedTransportText([
      travelerProfile.seat_policy,
      travelerProfile.seat_preference,
      travelerProfile.preferred_seat,
      payload.userPolicy?.seatPolicy,
      payload.userPolicy?.preferredSeat,
      payload.userIntent
    ].filter(Boolean).join(" "));
    const rules = normalizedTransportText(`${travelerProfile.booking_rules || ""} ${payload.userPolicy?.bookingRules || ""}`);
    if (/random assignment|random seat|no preference|no specific seat|skip seat|no paid seat/.test(`${explicit} ${rules}`)) {
      return "random_assignment";
    }
    if (/\baisle\b|\bwindow\b|sit together|seats together|specific seat|\bseat [a-z]?\d+[a-z]?\b|\b\d{1,2}[a-k]\b/.test(explicit)) {
      return "explicit_selection";
    }
    return "unspecified";
  }

  function transportControlText(control = {}) {
    return normalizedTransportText([
      control.label,
      control.accessibleName,
      control.semantic,
      control.meaning,
      control.sectionType,
      control.sectionLabel
    ].filter(Boolean).join(" "));
  }

  function controlLooksLikeRepeatedChoice(control = {}) {
    const meaning = normalizedTransportText(`${control.kind || ""} ${control.role || ""} ${control.semantic || ""} ${control.physicalEffect || ""}`);
    if (control.globalChrome === true || control.fieldType) return false;
    if (/continue|next|proceed|advance|navigation|back|submit|payment|dismiss|open surface/.test(meaning)) return false;
    return /choice|radio|checkbox|option|seat|select paid|select free/.test(meaning);
  }

  function repeatedChoiceGroupKey(control = {}) {
    if (!controlLooksLikeRepeatedChoice(control)) return "";
    return [
      control.surfaceId || "surface-page",
      control.decisionGroupId || "",
      control.sectionId || control.sectionType || "",
      normalizedTransportText(control.semantic || control.kind || control.role || "choice")
    ].join("|");
  }

  function controlStateForTransport(control = {}) {
    return control.state || control.controlState || {};
  }

  function transportControlDisabled(control = {}) {
    const state = controlStateForTransport(control);
    return state.disabled === true || control.disabled === true || control.logicalDisabled === true;
  }

  function transportControlSelected(control = {}) {
    const state = controlStateForTransport(control);
    return control.selected === true || state.selected === true || state.checked === true;
  }

  function transportControlPrice(control = {}) {
    const amount = Number(control.structuredPrice?.amount ?? control.priceAmount);
    return Number.isFinite(amount) ? amount : null;
  }

  function controlMatchesTransportProfile(control = {}, profileValues = []) {
    const text = transportControlText(control);
    if (!text) return false;
    return profileValues.some((value) => (
      value.length >= 3
      && (text.includes(value) || value.includes(text))
    ));
  }

  function collectionTypeForControls(page = {}, controls = []) {
    const context = normalizedTransportText([
      page.step,
      page.currentSurface?.label,
      controls[0]?.sectionType,
      controls[0]?.sectionLabel,
      controls[0]?.semantic,
      ...controls.slice(0, 8).map((control) => control.label || control.accessibleName || "")
    ].filter(Boolean).join(" "));
    return /seat|seating/.test(context) ? "seat_inventory" : "repeated_choices";
  }

  function collectionSummary(collectionId, type, controls = [], retained = [], profileMode = "unspecified") {
    const prices = controls.map(transportControlPrice).filter((value) => value != null);
    const currencies = [...new Set(controls.map((control) => control.structuredPrice?.currency).filter(Boolean))];
    return {
      collectionId,
      type,
      decisionGroupId: controls[0]?.decisionGroupId || "",
      sectionId: controls[0]?.sectionId || "",
      sectionType: controls[0]?.sectionType || "",
      surfaceId: controls[0]?.surfaceId || "surface-page",
      totalCount: controls.length,
      retainedCount: retained.length,
      omittedCount: Math.max(0, controls.length - retained.length),
      availableCount: controls.filter((control) => !transportControlDisabled(control)).length,
      disabledCount: controls.filter(transportControlDisabled).length,
      selectedCount: controls.filter(transportControlSelected).length,
      paidCount: controls.filter((control) => Number(transportControlPrice(control)) > 0 || /money|paid/.test(normalizedTransportText(control.risk))).length,
      freeCount: controls.filter((control) => transportControlPrice(control) === 0 || /free|safe decline|included/.test(normalizedTransportText(`${control.risk || ""} ${control.label || ""}`))).length,
      priceRange: prices.length ? {
        minimum: Math.min(...prices),
        maximum: Math.max(...prices),
        currency: currencies.length === 1 ? currencies[0] : ""
      } : null,
      profileMode,
      requiresExpansion: type === "seat_inventory" && profileMode === "explicit_selection" && retained.length < controls.length
    };
  }

  function filterTransportReferences(page = {}, retainedIds = new Set(), collections = []) {
    const collectionByDecisionGroup = new Map(collections
      .filter((collection) => collection.decisionGroupId)
      .map((collection) => [collection.decisionGroupId, collection]));
    const filterIds = (items = []) => uniqueControlIds(items).filter((controlId) => retainedIds.has(controlId));
    const decisionGroups = (page.decisionGroups || []).map((group) => {
      const collection = collectionByDecisionGroup.get(group.decisionGroupId);
      const alternativeControlIds = filterIds(group.alternativeControlIds || group.alternatives || []);
      const alternatives = (group.alternatives || []).filter((alternative) => retainedIds.has(alternative.controlId));
      return {
        ...group,
        alternativeControlIds,
        alternatives,
        semanticCorrectionControlIds: filterIds(group.semanticCorrectionControlIds || []),
        ...(collection ? {
          transportCollectionId: collection.collectionId,
          transportOriginalAlternativeCount: collection.totalCount,
          transportOmittedAlternativeCount: collection.omittedCount
        } : {})
      };
    }).filter((group) => {
      const collection = collectionByDecisionGroup.get(group.decisionGroupId);
      if (!collection) return true;
      if (group.required === true) return true;
      return group.alternativeControlIds.length > 0;
    });
    const compactSurface = (surface = null) => surface ? {
      ...surface,
      memberControlIds: filterIds(surface.memberControlIds || surface.controlIds || [])
    } : surface;
    return {
      ...page,
      controlAliases: (page.controlAliases || []).filter((alias) => retainedIds.has(alias.controlId)),
      decisionGroups,
      sections: (page.sections || []).map((section) => ({
        ...section,
        controlIds: filterIds(section.controlIds || [])
      })),
      accessibility: page.accessibility ? {
        ...page.accessibility,
        controlIds: filterIds(page.accessibility.controlIds || [])
      } : page.accessibility,
      currentSurface: compactSurface(page.currentSurface),
      surfaceStack: (page.surfaceStack || []).map(compactSurface),
      screenshotAnnotations: (page.screenshotAnnotations || []).filter((annotation) => retainedIds.has(annotation.controlId)),
      controlCollections: collections,
      transportCompleteness: "task_complete",
      summary: {
        ...(page.summary || {}),
        sourceControls: (page.controls || []).length,
        transportedControls: retainedIds.size,
        controlCollections: collections.length
      },
      coverage: page.coverage ? {
        ...page.coverage,
        sourceControlCount: (page.controls || []).length,
        transportedControlCount: retainedIds.size,
        collectionCount: collections.length
      } : page.coverage
    };
  }

  function boundedObservationTransport(payload = {}) {
    const page = payload.page || {};
    const controls = Array.isArray(page.controls) ? page.controls : [];
    if (controls.length < 64) return payload;
    const grouped = new Map();
    controls.forEach((control) => {
      const key = repeatedChoiceGroupKey(control);
      if (!key) return;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(control);
    });
    const repeatedGroups = [...grouped.values()].filter((group) => group.length >= 64);
    if (!repeatedGroups.length) return payload;

    const profileValues = transportProfileValues(payload);
    const seatProfileMode = seatTransportProfileMode(payload);
    const omittedIds = new Set();
    const collections = [];
    repeatedGroups.forEach((group, index) => {
      const type = collectionTypeForControls(page, group);
      const profileMode = type === "seat_inventory" ? seatProfileMode : "unspecified";
      const alwaysKeep = group.filter((control) => (
        transportControlSelected(control)
        || control.required === true
        || controlStateForTransport(control).invalid === true
        || controlMatchesTransportProfile(control, profileValues)
        || /no thanks|without|skip|random|automatic|free assignment/.test(transportControlText(control))
      ));
      const keepLimit = type === "seat_inventory" && profileMode === "random_assignment"
        ? 0
        : type === "seat_inventory" && profileMode === "explicit_selection"
          ? 96
          : 24;
      const ranked = group.filter((control) => !alwaysKeep.includes(control)).sort((left, right) => {
        const score = (control) => {
          const region = control.visualRegion || control.visualRegions?.[0] || {};
          const price = transportControlPrice(control);
          return (controlMatchesTransportProfile(control, profileValues) ? 1000000 : 0)
            + (!transportControlDisabled(control) ? 100000 : 0)
            + (region.inViewport === true ? 10000 : 0)
            + (price === 0 ? 1000 : 0)
            - (Number.isFinite(price) ? Math.min(price, 999) : 0);
        };
        return score(right) - score(left);
      });
      const retained = [...new Map([...alwaysKeep, ...ranked.slice(0, Math.max(0, keepLimit - alwaysKeep.length))]
        .map((control) => [control.controlId, control])).values()];
      const retainedIds = new Set(retained.map((control) => control.controlId));
      group.forEach((control) => {
        if (!retainedIds.has(control.controlId)) omittedIds.add(control.controlId);
      });
      collections.push(collectionSummary(
        `collection_${stableHash(`${type}:${group[0]?.decisionGroupId || index}:${group.length}`)}`,
        type,
        group,
        retained,
        profileMode
      ));
    });

    const retainedControls = controls.filter((control) => !omittedIds.has(control.controlId));
    const retainedIds = new Set(retainedControls.map((control) => control.controlId));
    const boundedPage = filterTransportReferences({ ...page, controls: retainedControls }, retainedIds, collections);
    return {
      ...payload,
      transportMode: payload.transportMode || "bounded_semantic",
      page: boundedPage
    };
  }

  function smallerObservationTransport(payload = {}) {
    const safePayload = boundedObservationTransport(compactObservationActionContext(payload));
    const page = safePayload.page || {};
    return {
      ...safePayload,
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

  function incrementalObservationTransport(payload = {}) {
    const update = payload.observationUpdate || {};
    const page = payload.page || {};
    if (update.mode !== "incremental" || !update.baseSnapshotHash) return payload;
    const diff = update.diff || emptyPageStateDiff();
    const changedControlIds = new Set([
      ...(diff.addedControls || []).map((entry) => entry.controlId),
      ...(diff.stateChanges || []).map((entry) => entry.controlId),
      ...(diff.textChanges || []).map((entry) => entry.controlId)
    ].filter(Boolean));
    const currentSurfaceId = page.currentSurface?.id || "surface-page";
    for (const control of page.controls || []) {
      if ((control.surfaceId || "surface-page") === currentSurfaceId) changedControlIds.add(control.controlId);
    }
    const controls = (page.controls || []).filter((control) => changedControlIds.has(control.controlId));
    const controlIds = new Set(controls.map((control) => control.controlId));
    const decisionGroups = (page.decisionGroups || []).filter((group) => (
      group.surfaceId === currentSurfaceId
      || controlIds.has(group.selectedControlId)
      || controlIds.has(group.removalControlId)
      || (group.alternativeControlIds || []).some((controlId) => controlIds.has(controlId))
    ));
    const decisionGroupIds = new Set(decisionGroups.map((group) => group.decisionGroupId));
    const sections = (page.sections || []).filter((section) => (
      (section.controlIds || []).some((controlId) => controlIds.has(controlId))
    ));
    return {
      ...payload,
      transportMode: "incremental_diff",
      page: {
        ...page,
        incremental: true,
        controls,
        controlAliases: (page.controlAliases || []).filter((entry) => controlIds.has(entry.controlId)),
        decisionGroups,
        sections,
        surfaceStack: page.surfaceStack || [],
        currentSurface: page.currentSurface || null,
        screenshotAnnotations: (page.screenshotAnnotations || []).filter((entry) => (
          controlIds.has(entry.controlId) || decisionGroupIds.has(entry.decisionGroupId)
        ))
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
    const fullPayload = boundedObservationTransport(compactObservationActionContext(payload));
    let outgoing = incrementalObservationTransport(fullPayload);
    let bytes = observationTransportBytes(outgoing);
    if (bytes > MAX_OBSERVATION_TRANSPORT_BYTES) {
      outgoing = smallerObservationTransport(outgoing);
      bytes = observationTransportBytes(outgoing);
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await fetch(`${apiBase}/agent/next-action`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal,
        body: JSON.stringify(outgoing)
      });
      if (response.ok) return { response, bytes, transportMode: outgoing.transportMode || "canonical" };
      const body = await response.json().catch(() => ({}));
      if (body.code === "OBSERVATION_RESYNC_REQUIRED" && body.retryable === true && outgoing !== fullPayload) {
        outgoing = {
          ...fullPayload,
          transportMode: "full_resynchronization",
          observationUpdate: {
            ...(fullPayload.observationUpdate || {}),
            mode: "full_snapshot",
            baseSnapshotHash: ""
          }
        };
        bytes = observationTransportBytes(outgoing);
        continue;
      }
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

  async function requestAgentDecision(map, userMessage = "", clientLatency = {}, loopToken = {}, userResponse = null) {
    const turnId = nextFlowId("turn");
    const observationId = nextFlowId("obs");
    const materialHash = observationHashForMap(map);
    const feedbackKey = stableHash(JSON.stringify({
      actionId: agent.lastActionResult?.actionId || "",
      code: agent.lastActionResult?.code || agent.lastActionResult?.failureCode || "",
      verified: agent.lastActionResult?.verified,
      postconditionSatisfied: agent.lastActionResult?.postconditionSatisfied
    }));
    const destinationReadinessRetry = Boolean(
      agent.destinationWait?.status === "WAITING_FOR_DESTINATION"
    );
    if (
      !userMessage
      && !destinationReadinessRetry
      && agent.lastSentMaterialHash === materialHash
      && agent.lastSentFeedbackKey === feedbackKey
    ) {
      logFlow("backend.request.unchanged_material_suppressed", {
        materialHash,
        feedbackKey,
        mutationDiff: clientLatency.observation_diff || emptyPageStateDiff()
      });
      setAgentActivity(
        "Waiting for page changes",
        "The checkout state is unchanged. I will resume when the page exposes new actionable state."
      );
      renderSidebar("agent");
      return null;
    }
    if (
      destinationReadinessRetry
      && !userMessage
      && agent.lastSentMaterialHash === materialHash
      && agent.lastSentFeedbackKey === feedbackKey
    ) {
      logFlow("backend.request.unchanged_readiness_retry_allowed", {
        materialHash,
        feedbackKey,
        attempts: agent.destinationWait.attempts,
        elapsedMs: Date.now() - agent.destinationWait.startedAt
      });
    }
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
    const actionHistoryForTransport = agent.actionHistory
      .slice(-12)
      .map(compactActionResultForTransport)
      .filter(Boolean);
    const lastActionForTransport = compactActionResultForTransport(
      agent.lastActionResult || agent.actionHistory[agent.actionHistory.length - 1] || null
    );
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
	      lastAction: lastActionForTransport
    });
    try {
      const settings = await storageGet(["apiBase"]);
      const screenshotRequired = observationNeedsScreenshot(map);
      const screenshotAnnotations = screenshotRequired ? prepareScreenshotAnnotations(map, observationId) : [];
      const screenshotStartedAt = performance.now();
      const screenshotCacheKey = `${map.currentSurface?.id || "surface-page"}:${materialHash}`;
      let screenshotDataUrl = screenshotRequired ? agent.screenshotCache.get(screenshotCacheKey) || "" : "";
      const screenshotCacheHit = Boolean(screenshotDataUrl);
      if (screenshotRequired && !screenshotDataUrl) {
        screenshotDataUrl = await captureVisibleScreenshot(screenshotAnnotations);
        if (screenshotDataUrl) {
          agent.screenshotCache.set(screenshotCacheKey, screenshotDataUrl);
          while (agent.screenshotCache.size > 3) agent.screenshotCache.delete(agent.screenshotCache.keys().next().value);
        }
      }
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
        screenshotRequired,
        screenshotCacheHit,
        screenshotAnnotations: screenshotAnnotations.length,
        observation_build_ms: clientLatency.observation_build_ms ?? null,
        observationMode: clientLatency.observation_mode || "full_snapshot",
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
      const canonicalPage = compactPageMap(map, observationId);
      const observationPayload = {
        sessionId: agent.sessionId,
        clientTurnId: turnId,
        observationId,
        observationSnapshot,
        observationUpdate: {
          mode: clientLatency.observation_mode || "full_snapshot",
          baseSnapshotHash: clientLatency.base_snapshot_hash || "",
          snapshotHash: materialHash,
          diff: clientLatency.observation_diff || emptyPageStateDiff()
        },
        userIntent: userIntentText(),
        userMessage,
        userResponse,
        traveler: traveler(),
        destinationReadiness: agent.destinationWait ? {
          status: agent.destinationWait.status,
          startedAt: agent.destinationWait.startedAt,
          deadlineAt: agent.destinationWait.deadlineAt,
          attempts: agent.destinationWait.attempts,
          backendWaits: agent.destinationWait.backendWaits,
          deadlineObservationSent: agent.destinationWait.deadlineObservationSent
        } : null,
	      approvalState: {
	        skipPaidExtrasApproved: shouldAutoDeclinePaidExtras(),
	        paymentApproved: false
	      },
	      actionHistory: actionHistoryForTransport,
        // Best-effort context for the backend verifier — it independently judges
        // whether the last action actually worked from fresh browser evidence.
	      lastActionResult: lastActionForTransport,
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
      agent.lastSentMaterialHash = materialHash;
      agent.lastSentFeedbackKey = feedbackKey;
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
      if (agent.destinationWait && !isDestinationReadinessDecision(decision)) {
        clearDestinationWait("semantic_destination_ready");
      }
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
        logFlow("backend.observation_too_large_blocked", {
          turnId,
          observationId,
          code: error.code,
          reason: error.message
        });
        setAgentActivity("Blocked", "The compact browser payload is still oversized. Automatic retries were stopped.");
      }
      const contextInvalidated = /extension context invalidated|context invalidated|receiving end does not exist/i.test(error.message || "");
      const backendFailure = error?.code === "BACKEND_INTERNAL_ERROR" || /^HTTP_5\d\d$/.test(error?.code || "");
      const oversizedObservation = error?.code === "OBSERVATION_TOO_LARGE";
      const decision = {
        source: "system",
        action: "stop",
        targetId: "",
        value: "",
        message: contextInvalidated
          ? "Chrome invalidated the extension context after reload. Refresh this checkout tab, then start the agent again."
          : oversizedObservation
            ? "The checkout observation remained too large after compact recovery. I stopped instead of retrying indefinitely."
          : backendFailure
            ? `Agent backend error: ${error.message}. No browser action was dispatched.`
          : `AI agent unavailable: ${error.message}. I stopped because AI-only mode is enabled.`,
        needsApproval: true,
        risk: "uncertain",
        reason: contextInvalidated
          ? "Extension lifecycle error: this page is still running the old content script after extension reload."
          : oversizedObservation
            ? "Observation transport circuit breaker: compact recovery was exhausted."
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
      logFlow(
        contextInvalidated
          ? "extension.context_invalidated"
          : oversizedObservation
            ? "backend.observation_too_large_stopped"
            : backendFailure
              ? "backend.processing_error"
              : "backend.error",
        { turnId, error: error.message, code: error.code || "", decision }
      );
      return decision;
    } finally {
      if (agent.activePlannerRequest === request) agent.activePlannerRequest = null;
    }
  }

  function repeatGuardFor(element, message, decision = null, map = agent.pageMap || null) {
    if (decision && failedLocalStrategyForDecision(decision, map || buildPageMap())) {
      logFlow("repeat_guard.blocked", {
        signature: targetLocalDispatchIdentity(decision, map || buildPageMap()).strategySignature,
        message: String(message || "")
      });
      return false;
    }
    const signature = elementSignature(element);
    const now = Date.now();
    const navigationLike = Boolean(decision && (
      decision.interactionRole === "navigation"
      || decision.semanticEffect === "advance"
      || /navigate|advance|continue|next_stage/.test(String(decision.intent || decision.physicalEffect || "").toLowerCase())
    ));
    const sameSignature = signature === agent.lastClickSignature;
    if (sameSignature) {
      agent.repeatClickCount += 1;
    } else {
      agent.lastClickSignature = signature;
      agent.repeatClickCount = 0;
    }
    if (navigationLike && sameSignature && agent.lastClickAt && now - agent.lastClickAt < 4_000) {
      logFlow("repeat_guard.navigation_settling", {
        signature,
        elapsedMs: now - agent.lastClickAt,
        message: String(message || "")
      });
      return false;
    }
    agent.lastClickAt = now;
    if (agent.repeatClickCount >= 2) {
      logFlow("repeat_guard.diagnostic", {
        signature,
        repeatClickCount: agent.repeatClickCount,
        message: String(message || ""),
        page: pageSnapshot("repeat-guard-diagnostic")
      });
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
    await sleep(Math.min(Math.max(0, delay), 80));
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
    const beforeMap = options.beforeMap || pageStateStore.observe({ reason: "before_advance" }).map;
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
    const postActionObservation = await observePageStateAfterMutation("verify_advance", 900);
    let afterMap = postActionObservation.map;
    const verification = verifyExpectedOutcome(expectedOutcome, beforeMap, afterMap, element);
    let advanced = verification.ok;
    agent.pageMap = afterMap;
    setAgentActivity(advanced ? `Advanced to ${afterMap.step.replace(/_/g, " ")}` : `${label} did not advance`, advanced ? "Reading the next page state" : "Looking for the remaining blocker");
    logAgentEvent("verify_advance", {
      label,
      advanced,
      step: afterMap.step,
      errors: afterMap.errors,
      url: location.href,
      verification
    });
    const actionId = options.actionId || agent.activeExecutionActionId || nextFlowId("act");
    const observationId = options.observationId || agent.activeExecutionObservationId || agent.activeObservationId || "";
    if (!advanced && inferCheckoutSite() !== "demo") {
      if (agent.running) {
        addAgentMessage("assistant", `${label} did not advance, so I am rescanning and sending the updated page back to the AI.`);
        if (afterMap.errors.length) addAgentMessage("assistant", `Visible issue: ${afterMap.errors.slice(0, 2).join("; ")}.`);
        await finalizeGovernedAction(actionId, observationId, governedDecision, expectedOutcome, verification, 350);
        return false;
      }
      await pushVerificationLedger(actionId, observationId, governedDecision, expectedOutcome, verification);
      return false;
    }
    await finalizeGovernedAction(actionId, observationId, governedDecision, expectedOutcome, verification, 250);
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
    await pageStateStore.waitForQuiet({ maxWaitMs: 260 });
    const currentObservation = mapObservationSnapshot(pageStateStore.observe({ reason: "pre_execution" }).map);
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
      agent.pendingInputRequest = decision.inputRequest || null;
      agent.awaiting = decision.risk === "money" ? "extras" : "manual";
      agent.running = false;
      renderSidebar("agent");
      return;
    }
    agent.pendingInputRequest = null;

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
      if (isDestinationReadinessDecision(decision)) {
        beginDestinationWait(decision);
        return;
      }
      await continueAfterAction(900);
      return;
    }

    let failedLocalStrategy = null;
    if (["click", "type", "select", "keypress", "click_xy"].includes(decision.action)) {
      failedLocalStrategy = failedLocalStrategyForDecision(decision, map);
    }

    if (decision.candidateId && ["click", "type", "select", "keypress", "click_xy"].includes(decision.action)) {
      const pipeline = decision.pipelineContract || null;
      const control = (map.controls || []).find((item) => item.controlId === decision.controlId) || {};
      const executionLane = AGENT_CONTRACT?.classifyExecutionLane?.({
        action: {
          ...decision,
          type: decision.action,
          observationId: actionObservationId,
          pipelineContract: pipeline
        },
        pipelineContract: pipeline,
        control,
        observation: {
          observationId: actionObservationId,
          page: map
        },
        strategyAlreadyFailed: Boolean(failedLocalStrategy)
      }) || "deny";
      const contractValid = pipeline?.contractVersion === AGENT_CONTRACT?.CONTRACT_VERSION
        && ["normal", "bounded_recovery"].includes(executionLane);
      if (!contractValid) {
        await rejectMechanicalAction(actionId, actionObservationId, decision, {
          code: failedLocalStrategy
            ? "FAILED_STRATEGY_REUSE"
            : "CAPABILITY_EXECUTION_LANE_DENIED",
          message: "The authoritative capability contract did not survive to dispatch with valid current proof."
        });
        return;
      }
    }

    if (["click", "type", "select", "keypress", "click_xy"].includes(decision.action)) {
      if (failedLocalStrategy) {
        logFlow("repeat_guard.blocked", {
          actionId,
          observationId: actionObservationId,
          controlId: decision.controlId || "",
          operation: decision.operation || "",
          interactionMethod: decision.interactionMethod || decision.action || "",
          failedLocalStrategy
        });
        await rejectMechanicalAction(actionId, actionObservationId, decision, {
          code: "FAILED_STRATEGY_REUSE",
          message: "The identical failed actuator strategy is blocked while its target-local state is unchanged.",
          dispatched: false
        });
        return;
      }
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
      await finalizeGovernedAction(
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
        },
        0
      );
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
              : /space/i.test(requestedKey)
                ? " "
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
      const afterMap = (await observePageStateAfterMutation("verify_keypress", 650)).map;
      const expectedOutcome = expectedOutcomeForDecision(decision, map, target);
      const verification = verifyExpectedOutcome(expectedOutcome, map, afterMap, target);
      await finalizeGovernedAction(actionId, actionObservationId, decision, expectedOutcome, verification, 350);
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
      const dispatchTarget = coordinateValidation.dispatchTarget || target;
      const targetLabel = decision.targetLabel || decision.value || buttonText(dispatchTarget) || labelText(dispatchTarget);
      if (isDangerousActionLabel(targetLabel)) {
        agent.awaiting = "final";
        agent.running = false;
        addAgentMessage("assistant", "I will not click payment or final booking coordinates automatically.");
        renderSidebar("review");
        return;
      }
      await showAgentThought(dispatchTarget, "Act", `Click visible point`, targetLabel ? `Target: ${targetLabel}` : "Coordinate fallback on the active visual surface.", 700);
      pushActionLedger({
        actionId,
        observationId: actionObservationId,
        stage: "target_resolved",
        action: decision,
        targetFingerprint: targetFingerprint(dispatchTarget, decision),
        expectedOutcome: expectedOutcomeForDecision(decision, map, dispatchTarget)
      });
      showAgentCursor(dispatchTarget, targetLabel || "click point");
      flashElement(dispatchTarget);
      pushActionLedger({
        actionId,
        observationId: actionObservationId,
        stage: "dispatched",
        action: decision,
        targetFingerprint: targetFingerprint(dispatchTarget, decision)
      });
      clickResolvedViewportTarget(dispatchTarget, Math.round(x), Math.round(y), {
        actionId,
        observationId: actionObservationId,
        source: coordinateValidation.expected?.source || ""
      });
      recordAction("click_xy", { x: Math.round(x), y: Math.round(y), label: targetLabel });
      await waitForUiSettle(700);
      {
        const afterMap = (await observePageStateAfterMutation("verify_coordinate_click", 750)).map;
        const expectedOutcome = expectedOutcomeForDecision(decision, map, dispatchTarget);
        const verification = verifyExpectedOutcome(expectedOutcome, map, afterMap, dispatchTarget);
        await finalizeGovernedAction(actionId, actionObservationId, decision, expectedOutcome, verification, 500);
      }
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
        await finalizeGovernedAction(actionId, actionObservationId, decision, expectedOutcome, verification, 350);
        return;
      }
      // Diagnostic only. The shared execution-lane gate above consumes the
      // page-scoped failed-strategy memory and is the sole dispatch authority.
      const repeatAllowed = repeatGuardFor(target, "The same failed local strategy was observed diagnostically.", decision, map);
      if (!repeatAllowed) {
        const settlingResult = rememberUnexecutedActionResult(
          actionId,
          actionObservationId,
          decision,
          {
            ok: false,
            code: "NAVIGATION_SETTLING",
            message: "An identical navigation action was dispatched recently; reobserve before retrying.",
            retryable: true
          }
        );
        await reportActionResult(settlingResult);
        await continueAfterAction(500);
        return;
      }
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
      rememberChoiceVisualStateBeforeDispatch(target, decision);
      let choiceCommitResult = null;
      if (decision.interactionMethod === "native_click") {
        rememberCanonicalSelectionCommitment(target, decision);
        nativeElementClick(target, {
          actionId,
          observationId: actionObservationId,
          operation: decision.operation || ""
        });
      } else if (decision.interactionMethod === "browser_trusted_input") {
        const trustedResult = await trustedBrowserClick(target, {
          ...decision,
          actionId,
          observationId: actionObservationId
        });
        if (trustedResult?.ok !== true) {
          await rejectMechanicalAction(actionId, actionObservationId, decision, {
            code: trustedResult?.code || "TRUSTED_INPUT_UNAVAILABLE",
            message: "The governed browser-level trusted-input strategy was unavailable before dispatch.",
            dispatched: false
          }, target);
          return;
        }
        rememberCanonicalSelectionCommitment(target, decision);
      } else if (decision.interactionMethod === "browser_trusted_choice") {
        const trustedResult = await trustedBrowserChoice(target, {
          ...decision,
          actionId,
          observationId: actionObservationId
        });
        if (trustedResult?.ok !== true) {
          await rejectMechanicalAction(actionId, actionObservationId, decision, {
            code: trustedResult?.code || "TRUSTED_INPUT_UNAVAILABLE",
            message: "The governed browser-level choice episode was unavailable before dispatch.",
            dispatched: false
          }, target);
          return;
        }
        rememberCanonicalSelectionCommitment(target, decision);
        choiceCommitResult = await settleTrustedChoiceInteraction(target, {
          ...decision,
          actionId,
          observationId: actionObservationId
        });
      } else {
        rememberCanonicalSelectionCommitment(target, decision);
        userLikeClick(target, {
          actionId,
          observationId: actionObservationId,
          operation: decision.operation || "",
          method: decision.interactionMethod || "pointer_sequence"
        });
      }
      const customChoiceEpisode = Boolean(
        !choiceCommitResult
        && !target.matches?.("input[type='checkbox'], input[type='radio']")
        && (
          decision.interactionRole === "choice"
          || decision.semanticEffect === "select"
          || ["choose", "select"].includes(decision.operation)
        )
      );
      if (customChoiceEpisode) {
        choiceCommitResult = await settleTrustedChoiceInteraction(target, {
          ...decision,
          actionId,
          observationId: actionObservationId
        });
      }
      pushActionLedger({
        actionId,
        observationId: actionObservationId,
        stage: "dispatched",
        action: decision,
        targetFingerprint: targetFingerprint(target, decision)
      });
      if (surfaceWasActive) {
        const progress = await waitForOverlayProgress(beforeOverlay, beforeOverlaySignature, 2200);
        const afterMap = (await observePageStateAfterMutation("verify_foreground_action", 650)).map;
        const verification = verifyExpectedOutcome(expectedOutcome, map, afterMap, target);
        const verifiedResult = withChoiceCommitEvidence(
          withOverlayProgressEvidence(verification, progress),
          choiceCommitResult
        );
        await pushVerificationLedger(actionId, actionObservationId, decision, expectedOutcome, verifiedResult);
        await verifyAgentStep(
          target,
          "Interrupt",
          verifiedResult.ok ? verifiedResult.message : `expected outcome not observed${progress.ok ? ` (surface ${progress.reason})` : ""}`,
          verifiedResult.ok,
          650
        );
        if (!verifiedResult.ok) {
          addAgentMessage("assistant", `The active surface changed, but the exact expected outcome was not verified (${verifiedResult.code || "OUTCOME_NOT_VERIFIED"}). I am rescanning instead of marking it done.`);
          await continueAfterAction(450);
          return;
        }
        await continueAfterAction(500);
        return;
      }
      await waitForUiSettle(800);
      let afterMap = (await observePageStateAfterMutation("verify_click", 750)).map;
      let verification = verifyExpectedOutcome(expectedOutcome, map, afterMap, target);
      if (!verification.ok && expectedOutcome.type === "exact_free_option_selected") {
        const settledChoice = await settleExactChoiceOutcome(
          target,
          decision,
          expectedOutcome,
          map,
          afterMap
        );
        afterMap = settledChoice.afterMap;
        verification = settledChoice.verification;
      }
      const verifiedResult = withChoiceCommitEvidence(verification, choiceCommitResult);
      await finalizeGovernedAction(actionId, actionObservationId, decision, expectedOutcome, verifiedResult, 900);
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
        ? String(
            agent.sessionProfileOverrides?.passport_number
            || agent.sessionProfileOverrides?.document_number
            || traveler()?.document?.document_number
            || ""
          )
        : decision.value || "";
      if (decision.value === "profile://document_number" && !governedValue) {
        agent.awaiting = "manual";
        agent.running = false;
        addAgentMessage("assistant", "The governed document field has no saved local document value, so I stopped.");
        renderSidebar("agent");
        return;
      }
      const resolveLiveElement = () => {
        const freshMap = pageStateStore.observe({ reason: "field_rebind" }).map;
        const stableKey = decision.stableKey || decision.targetSnapshot?.stableKey || "";
        return resolveDecisionTarget({
          action: decision.action,
          operation: decision.operation,
          controlId: decision.controlId || decision.targetSnapshot?.controlId || "",
          stableKey,
          targetSnapshot: {
            controlId: decision.controlId || decision.targetSnapshot?.controlId || "",
            stableKey
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
        exactOption: decision.exactOption || decision.pipelineContract?.component?.exactOption || null,
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
        const afterMap = (await observePageStateAfterMutation("verify_field_change", 650)).map;
        const expectedOutcome = expectedOutcomeForDecision(decision, map, target);
        const verification = verifyExpectedOutcome(expectedOutcome, map, afterMap, target);
        await finalizeGovernedAction(actionId, actionObservationId, decision, expectedOutcome, verification, 500);
      }
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
    const totalLabel = normalized.match(/\b(?:amount to pay|total(?: amount| price)?|grand total|subtotal)\b/i);
    const ownedTotal = totalLabel
      ? structuredPriceFromText(normalized.slice(totalLabel.index, totalLabel.index + 160))
      : null;
    if (ownedTotal) return ownedTotal;
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
    const stepInfo = classifyStepDetailed({
      visibleText: `${map.text} ${map.fullText.slice(0, 2500)}`,
      url: location.href,
      structuralEvidence: {
        seatInventoryCount: (map.collections || [])
          .filter((collection) => collection.type === "seat_inventory")
          .reduce((total, collection) => total + Number(collection.totalCount || collection.members?.length || 0), 0)
      }
    });
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
    agent.pageMap = pageStateStore.observe({ forceFull: true, reason: "observe_only" }).map;
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
    agent.lastClickAt = 0;
    agent.skipPaidExtrasApproved = false;
    agent.autopilotMode = true;
    agent.pendingUserMessage = "";
    agent.pendingUserResponse = null;
    agent.pendingInputRequest = null;
    agent.sessionProfileOverrides = {};
    agent.skipPaidExtrasApproved = shouldAutoDeclinePaidExtras();
    agent.actionHistory = [];
    resetFieldProgress();
    setAgentActivity("Starting checkout agent", travelerRules() || "Using saved traveler profile");
    agent.pageMap = pageStateStore.observe({ forceFull: true, reason: "agent_start" }).map;
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
    agent.lastClickAt = 0;
    agent.skipPaidExtrasApproved = Boolean(marker.skipPaidExtrasApproved);
    agent.autopilotMode = true;
    agent.pendingUserMessage = "";
    agent.pendingUserResponse = null;
    agent.pendingInputRequest = null;
    agent.sessionProfileOverrides = {};
    agent.actionHistory = [];
    resetFieldProgress();
    setAgentActivity("Continuing checkout agent after page change", travelerRules() || "Using saved traveler profile");
    agent.pageMap = pageStateStore.observe({ forceFull: true, reason: "navigation_resume" }).map;
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
      await showAgentThought(
        null,
        "Observe",
        "Backend planner",
        "Reading the current page and sending it to the backend before taking any checkout action.",
        120
      );
      if (loopToken.lifecycleId !== agent.lifecycleId || !agent.running) return;
      const observationStartedAt = performance.now();
      const observed = await pageStateStore.observeFresh({
        reason: "planning_turn",
        maxWaitMs: 650,
        maxAttempts: 2,
        postBuildGraceMs: 100
      });
      if (!observed.fresh) {
        logFlow("planning.stale_observation_deferred", {
          attempts: observed.freshnessAttempts,
          mutationVersion: observed.mutationVersion,
          observation_build_ms: observed.timings?.observationBuildMs || 0
        });
        setAgentActivity(
          "Waiting for one fresh page state",
          "The checkout changed while I was reading it. I will observe again instead of planning from mixed state."
        );
        agent.loopRerunQueued = true;
        return;
      }
      const stableMap = rememberPagePlan(observed.map);
      agent.pageMap = stableMap;
      const observationBuildMs = observed.timings.observationBuildMs;
      const observationElapsedMs = Math.round(performance.now() - observationStartedAt);
      logFlow("latency.span", {
        observation_build_ms: observationBuildMs,
        observation_mode: observed.mode,
        observation_total_ms: observationElapsedMs,
        observation_freshness_attempts: observed.freshnessAttempts,
        mutation_version: observed.mutationVersion,
        material: observed.material,
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
      const userResponse = agent.pendingUserResponse;
      agent.pendingUserMessage = "";
      agent.pendingUserResponse = null;
      const decision = await requestAgentDecision(
        stableMap,
        userMessage,
        {
          observation_build_ms: observationBuildMs,
          observation_mode: observed.mode,
          observation_diff: observed.diff,
          base_snapshot_hash: observed.baseSnapshotHash
        },
        loopToken,
        userResponse
      );
      if (!decision || loopToken.lifecycleId !== agent.lifecycleId || !agent.running) return;
      await executeAgentDecision(decision, stableMap);
    } finally {
      shouldRerun = finishAgentLoop(loopToken);
      if (agent.destinationWait?.status === "WAITING_FOR_DESTINATION") {
        if (shouldRerun || agent.destinationWait.wakeRequested) {
          scheduleDestinationObservation("active_loop_closed", DESTINATION_RETRY_INTERVAL_MS);
        }
      } else if (shouldRerun) {
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
      agent.lastClickAt = 0;
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

    if (agent.pendingInputRequest?.field) {
      const request = agent.pendingInputRequest;
      const sensitive = request.sensitive === true;
      agent.sessionProfileOverrides[request.field] = text;
      agent.pendingUserMessage = text;
      agent.pendingUserResponse = {
        requestId: request.requestId || "",
        field: request.field,
        ...(sensitive
          ? {
              value: "",
              valueRef: "profile://session/document_number",
              hasValue: true
            }
          : {
              value: text,
              valueRef: "",
              hasValue: true
            })
      };
      addAgentMessage("assistant", `Got it. I will use that ${request.label || request.field.replace(/_/g, " ")} for this checkout and continue.`);
      agent.running = true;
      agent.awaiting = "";
      renderSidebar("agent");
      await sleep(300);
      processCheckoutAgent();
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
    const map = agent.pageMap || pageStateStore.observe({ reason: "sidebar_render" }).map;
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
      const pageChanged = pageStateStore.noteMutations(mutations);
      if (pageChanged && agent.destinationWait?.status === "WAITING_FOR_DESTINATION") {
        scheduleDestinationObservation("dom_mutation", 0);
      }
      if (!pageChanged || renderTimer) return;
      renderTimer = setTimeout(() => {
        renderTimer = null;
        if (!filledFields.length) {
          warnings = runRiskChecks();
          renderSidebar();
        }
      }, 180);
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeOldValue: true,
      attributeFilter: [
        "checked", "selected", "value", "disabled", "required", "hidden", "open", "class", "style",
        "aria-checked", "aria-selected", "aria-expanded", "aria-disabled", "aria-invalid", "aria-hidden", "aria-valuenow",
        "data-price", "data-selected", "data-value"
      ]
    });
    pageStateStore.attachMutationObserver(observer);
    document.addEventListener("input", pageStateStore.noteEvent, true);
    document.addEventListener("change", pageStateStore.noteEvent, true);
    document.addEventListener("scroll", (event) => pageStateStore.noteEvent({
      type: "viewport",
      target: event.target === document ? document.documentElement : event.target
    }), true);
    window.addEventListener("resize", () => pageStateStore.noteEvent({ type: "viewport", target: document.documentElement }), { passive: true });
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
      setAgentSessionForTest: (sessionId) => { agent.sessionId = String(sessionId || ""); },
      repeatGuardFor,
      repeatGuardState: () => ({
        lastClickSignature: agent.lastClickSignature,
        repeatClickCount: agent.repeatClickCount,
        lastClickAt: agent.lastClickAt,
        failedLocalStrategies: (agent.failedLocalStrategies || []).map((entry) => ({ ...entry })),
        running: agent.running,
        awaiting: agent.awaiting
      }),
      agentLoopState: () => ({
        lifecycleId: agent.lifecycleId,
        loopBusy: agent.loopBusy,
        loopRerunQueued: agent.loopRerunQueued,
        activeLoopRunId: agent.activeLoopRunId,
        destinationWait: agent.destinationWait ? { ...agent.destinationWait } : null,
        destinationWaitTimerActive: Boolean(agent.destinationWaitTimer),
        activePlannerRequest: agent.activePlannerRequest ? {
          turnId: agent.activePlannerRequest.turnId,
          observationId: agent.activePlannerRequest.observationId,
          loopRunId: agent.activePlannerRequest.loopRunId,
          lifecycleId: agent.activePlannerRequest.lifecycleId
        } : null
      }),
      processCheckoutAgent,
      watchForCheckoutChanges,
      beginDestinationWait,
      scheduleDestinationObservation,
      clearDestinationWait,
      isDestinationReadinessDecision,
      createObservationControlRegistry,
      compactPageMap,
      compactSurfaceReference,
      observationTransportBytes,
      observationNeedsScreenshot,
      compactActionResultForTransport,
      compactObservationActionContext,
      boundedObservationTransport,
      boundHighCardinalityActionElements,
      smallerObservationTransport,
      incrementalObservationTransport,
      uploadObservationScreenshot,
      postObservationWithSizeRecovery,
      prepareScreenshotAnnotations,
      mapObservationSnapshot,
      materialObservationSignature,
      observationHashForMap,
      canonicalPageStateDiff,
      pageStateDiffIsMaterial,
      mutationMayBeMaterial,
      observePageState: (options = {}) => pageStateStore.observe(options),
      observeFreshPageState: (options = {}) => pageStateStore.observeFresh(options),
      notePageMutations: (mutations = []) => pageStateStore.noteMutations(mutations),
      notePageEvent: (event = {}) => pageStateStore.noteEvent(event),
      pageStateStoreState: () => ({
        dirty: pageStateStore.isDirty(),
        pendingMutations: pageStateStore.pendingCount(),
        mutationVersion: pageStateStore.mutationVersion(),
        lastUpdate: pageStateStore.lastUpdate()
      }),
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
      rememberChoiceVisualStateBeforeDispatch,
      userLikeClick,
      nativeElementClick,
      trustedBrowserClick,
      trustedBrowserChoice,
      trustedBrowserKey,
      settleTrustedChoiceInteraction,
      settleExactChoiceOutcome,
      choiceEpisodeEvidence,
      compactChoiceCommitEvidence,
      structuredPriceFromText,
      structuredPricesFromText,
      selectedDisposition,
      clickViewportPoint,
      clickResolvedViewportTarget,
      dispatchKey,
      setFieldValue,
      expectedOutcomeForDecision,
      verifyExpectedOutcome,
      transitionFeedbackForMaps,
      rememberActionExecutionResult,
      withOverlayProgressEvidence,
      withChoiceCommitEvidence
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
