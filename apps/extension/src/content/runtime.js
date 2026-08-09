import {
  SELECTED_BOOKING_MAX_AGE_MS,
  authoritativeSelectedBookingFacts,
  composeSelectedBookingContract,
  validStoredSelectedBookingContract
} from "./selected-booking.js";
import { createActionTransport } from "./observation/action-transport.js";
import { createAccessibilityProjection } from "./observation/accessibility.js";
import {
  buildCanonicalAliasIndex,
  decisionTargetAliasIds
} from "./observation/control-aliases.js";
import { createControlRegistryTools } from "./observation/control-registry.js";
import { createControlGraphCompiler } from "./observation/control-graph.js";
import { createDecisionGroupCompiler } from "./observation/decision-groups.js";
import { implicitRole, isVisible, queryAllDeep, textFromIds } from "./observation/dom.js";
import { createPageStateStore } from "./observation/page-state-store.js";
import { createPageMapCompiler } from "./observation/page-map.js";
import { createPerceptionFacade } from "./observation/perception.js";
import { createSectionPerception } from "./observation/sections.js";
import { createStageExitCompiler } from "./observation/stage-exit.js";
import { createTransactionEvidenceCompiler } from "./observation/transaction-evidence.js";
import { createObservationTransport } from "./observation/transport.js";
import {
  boundedPhrase,
  normalizedFieldAlias,
  profileFieldTypesFromText
} from "./observation/field-semantics.js";
import { createFieldEvidence } from "./observation/field-evidence.js";
import { createForegroundSurfaceCompiler } from "./observation/foreground-surface.js";
import { createLogicalControlCompiler } from "./observation/logical-controls.js";
import {
  currentCommercialOptionPrice,
  localizedPriceAmount,
  normalizedCurrencyToken,
  structuredPriceFromText,
  structuredPricesFromText
} from "./observation/prices.js";

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
    // ActionLease intentionally carries only fresh mechanical target identity.
    // Use semantic ownership as the local exclusive-choice episode key when a
    // legacy decision-group projection is not present on the lease.
    const decisionGroupId = String(
      decision.decisionGroupId
      || decision.targetSnapshot?.decisionGroupId
      || decision.semanticOwnerId
      || decision.goalId
      || ""
    ).trim();
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
    processDiagnostics: null,
    sessionStartFailure: null,
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
    honoredReobserveRetryTokens: new Set(),
    lastSentMaterialHash: "",
    lastSentFeedbackKey: "",
    screenshotCache: new Map()
  };
  let pageStateStore = null;
  let buildPageMap = null;
  let activeObservationElementRegistry = null;
  let activeObservationControlRegistry = null;
  const {
    observationTransportBytes,
    compactActionTransportValue,
    compactActionResultForTransport,
    compactObservationActionContext
  } = createActionTransport({ compactText, compactChoiceCommitEvidence });
  const {
    labelText,
    localLabelText,
    stableProfileFieldOwnerKey,
    profileFieldGroupEvidence,
    explicitProfileLabelEvidence,
    classifyProfileField
  } = createFieldEvidence({
    queryAllDeep,
    implicitRole,
    choiceLabel,
    elementId,
    normalizedFieldAlias,
    canonicalProfileFieldType,
    profileFieldTypesFromText,
    normalizedProfileChoiceValue
  });
  const {
    accessibleName,
    accessibilityState,
    accessibilityNode,
    accessibilitySnapshot
  } = createAccessibilityProjection({
    textFromIds,
    implicitRole,
    buttonText,
    labelText,
    isDisabledLike,
    isVisible,
    liveSectionForElement,
    lookupControlForElement,
    elementBox,
    elementId,
    elementById,
    queryAllDeep,
    currentPageMap: () => agent.pageMap || null,
    buildPageMap: () => buildPageMap()
  });
  const {
    controlsAreCompatibleAliases,
    controlMemberNodeIds,
    controlExclusiveNodeIds,
    exactAtomicControlNodeId,
    narrowerExactControlOwner,
    controlContextPriority,
    createObservationControlRegistry
  } = createControlRegistryTools({
    normalizeMatchText,
    elementById,
    isActionableClickTarget,
    elementId,
    stateElementForControl,
    canonicalControlForElement,
    unionBoxes
  });
  const {
    buildStageExit,
    buildAuthoritativeStageExit
  } = createStageExitCompiler({
    meaningfulActionBox,
    controlMemberNodeIds,
    unfilledRequiredFields,
    actionableCheckoutErrors
  });

  function storageGet(keys) {
    return chrome.storage.local.get(keys);
  }

  const RESUME_KEY = "atwAgentResume";
  const SELECTED_BOOKING_KEY = "atwSelectedBookingAcquisitionV1";
  const RESUME_MAX_AGE_MS = 3 * 60 * 1000;
  const DESTINATION_WAIT_TIMEOUT_MS = 20_000;
  const DESTINATION_RETRY_INTERVAL_MS = 300;
  const DESTINATION_MUTATION_SETTLE_MS = 450;
  const SELECTED_BOOKING_UNCHANGED_RETRY_MS = 30_000;
  let selectedBookingCaptureTimer = null;
  let selectedBookingCaptureAttempt = {
    url: "",
    snapshotHash: "",
    retryAfter: 0
  };

  function captureSelectedBookingFromMap(map = null) {
    const facts = authoritativeSelectedBookingFacts(map?.transactionFacts);
    if (!facts) return null;
    const existing = readSelectedBookingAcquisition();
    // Once checkout has started rendering traveler/extras/payment pages, the
    // selected flight is immutable. Only the actual flight-selection stage
    // may replace a prior capture when the user chooses a different flight.
    if (existing && map?.step !== "flight_selection") return existing;
    const acquisition = {
      contractVersion: "selected-booking-acquisition/v1",
      capturedAt: new Date().toISOString(),
      sourceOrigin: location.origin,
      sourceUrl: location.href,
      observationId: `booking_capture_${Date.now().toString(36)}`,
      facts
    };
    try {
      sessionStorage.setItem(SELECTED_BOOKING_KEY, JSON.stringify(acquisition));
      return acquisition;
    } catch (error) {
      // Sandboxed/opaque documents may deny sessionStorage. The acquisition
      // is still valid for the current page/session handshake even though it
      // cannot survive navigation in that environment.
      return acquisition;
    }
  }

  function readSelectedBookingAcquisition() {
    try {
      const acquisition = JSON.parse(sessionStorage.getItem(SELECTED_BOOKING_KEY) || "null");
      const capturedAt = Date.parse(acquisition?.capturedAt || "");
      if (
        acquisition?.contractVersion !== "selected-booking-acquisition/v1"
        || acquisition.sourceOrigin !== location.origin
        || !Number.isFinite(capturedAt)
        || Date.now() - capturedAt > SELECTED_BOOKING_MAX_AGE_MS
        || !authoritativeSelectedBookingFacts(acquisition.facts)
      ) {
        sessionStorage.removeItem(SELECTED_BOOKING_KEY);
        return null;
      }
      return acquisition;
    } catch (error) {
      return null;
    }
  }

  function scheduleSelectedBookingCapture(reason = "page_update") {
    if (agent.running || agent.sessionId || selectedBookingCaptureTimer) return false;
    if (
      selectedBookingCaptureAttempt.url === location.href
      && Date.now() < selectedBookingCaptureAttempt.retryAfter
    ) return false;
    selectedBookingCaptureTimer = setTimeout(() => {
      selectedBookingCaptureTimer = null;
      if (agent.running) return;
      const observed = pageStateStore.observe({ reason: `selected_booking_${reason}` });
      const captured = captureSelectedBookingFromMap(observed.map);
      const snapshotHash = String(observed.snapshotHash || observationHashForMap(observed.map));
      const unchangedMiss = !captured
        && selectedBookingCaptureAttempt.url === location.href
        && selectedBookingCaptureAttempt.snapshotHash === snapshotHash
        && observed.material === false;
      selectedBookingCaptureAttempt = {
        url: location.href,
        snapshotHash,
        retryAfter: captured
          ? Number.POSITIVE_INFINITY
          : Date.now() + (unchangedMiss ? SELECTED_BOOKING_UNCHANGED_RETRY_MS : 1_500)
      };
    }, 350);
    return true;
  }

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

  function canonicalProfileFieldType(value = "") {
    return AGENT_CONTRACT?.canonicalProfileFieldType?.(value) || "";
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
      given_names: t.given_names || [t.first_name, t.middle_name].filter(Boolean).join(" "),
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
      travel_purpose: t.travel_purpose || "leisure",
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

  function isAuthorizedCompletedChoiceSurfaceExit(decision = {}, element, map = agent.pageMap || buildPageMap()) {
    const targetControl = lookupControlForElement(map, element);
    return Boolean(targetControl && AGENT_CONTRACT?.parentSurfaceExitOwnershipIsCurrent({
      action: decision,
      pipelineContract: decision.pipelineContract || {},
      control: targetControl,
      observation: { observationId: decision.observationId || map.observationId || "", page: map }
    }));
  }

  function validateResolvedTarget(decision = {}, element, map = agent.pageMap || buildPageMap()) {
    const expected = decision.targetSnapshot;
    const live = liveTargetSnapshot(element, map);
    const authorizedCompletedChoiceExit = isAuthorizedCompletedChoiceSurfaceExit(decision, element, map);
    if (!targetBelongsToCurrentSurface(map, element) && !authorizedCompletedChoiceExit) {
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
    let exactActionability = actuatorActionability(
      element,
      map.currentSurface || { id: "surface-page", type: "page" },
      decision.operation || decision.action || "activate"
    );
    if (authorizedCompletedChoiceExit && exactActionability.inCurrentSurface !== true) {
      exactActionability = {
        ...exactActionability,
        inCurrentSurface: true,
        operationAuthorized: true,
        operationProof: "The single expanded choice opener owns dismissal of the active completed choice surface."
      };
    }
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
      const expectedActuatorIdentity = new Set([
        expected.id,
        expected.stateElementId,
        expected.preferredActivationElementId,
        expected.actuatorId
      ].filter(validTargetId));
      const liveActuatorIdentity = [
        live.id,
        live.stateElementId,
        live.preferredActivationElementId
      ].filter(validTargetId);
      const exactCompiledControlLease = Boolean(
        expectedControlId
        && liveControlId
        && expectedControlId === liveControlId
        && liveActuatorIdentity.some((id) => expectedActuatorIdentity.has(id))
      );
      const observationScopedOwnershipLink = Boolean(
        expected.semanticOwnershipLinkId
        && expected.policyCorrectionForDecisionGroupId
        && expected.policyCorrectionForDecisionGroupId === decision.decisionGroupId
        && expectedControlId
        && liveControlId
        && expectedControlId === liveControlId
      );
      if (!observationScopedOwnershipLink && !exactCompiledControlLease) {
        return { ok: false, code: "TARGET_DECISION_GROUP_MISMATCH", expected, live };
      }
      warnings.push({
        code: exactCompiledControlLease
          ? "TARGET_DECISION_GROUP_RECOMPILED_FOR_EXACT_LEASE"
          : "TARGET_DECISION_GROUP_LINKED_ACROSS_SURFACES",
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
    const controlledRecovery = expected.source === "visual_control_recovery"
      || (
        decision.boundedRecovery === true
        && decision.interactionMethod === "visual_coordinate"
        && decision.pipelineContract?.capability?.status === "unproven_experiment"
      );
    const visualFallback = expected.source === "visual_fallback"
      || decision.mechanicalHypothesis === true;
    let controlledRecoveryControl = null;
    let controlledRecoveryWrapper = null;
    if ((!visualFallback && !controlledRecovery) || !region || values.some((value) => !Number.isFinite(value))) {
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

  function compactFlowLogTarget(target = {}) {
    if (!target || typeof target !== "object") return target || null;
    return {
      id: String(target.id || target.targetId || ""),
      controlId: String(target.controlId || ""),
      actuatorId: String(target.actuatorId || target.targetId || ""),
      stableKey: compactText(target.stableKey || "", 240),
      label: compactText(target.label || target.targetLabel || target.accessibleName || "", 240),
      role: String(target.role || target.kind || ""),
      semantic: String(target.semantic || target.fieldType || ""),
      risk: String(target.risk || ""),
      surfaceId: String(target.surfaceId || ""),
      decisionGroupId: String(target.decisionGroupId || ""),
      state: target.state ? {
        selected: target.state.selected === true || target.state.checked === true,
        valuePresent: target.state.valuePresent === true,
        normalizedValue: compactText(target.state.normalizedValue || target.state.selectedValue || "", 160),
        disabled: target.state.disabled === true,
        expanded: target.state.expanded === true
      } : null,
      box: target.box || target.visualRegion || null
    };
  }

  function compactFlowLogPage(page = {}) {
    if (!page || typeof page !== "object") return page || null;
    return {
      site: String(page.site || ""),
      url: compactText(page.url || "", 500),
      step: String(page.step || ""),
      snapshotHash: String(page.snapshotHash || page.observationSnapshot?.snapshotHash || ""),
      currentSurface: page.currentSurface ? {
        id: String(page.currentSurface.id || ""),
        type: String(page.currentSurface.type || "page"),
        label: compactText(page.currentSurface.label || "", 240),
        blocksBackground: page.currentSurface.blocksBackground === true
      } : null,
      summary: page.summary ? {
        fields: Number(page.summary.fields || 0),
        controls: Number(page.summary.controls || 0),
        decisionGroups: Number(page.summary.decisionGroups || 0),
        errors: Number(page.summary.errors || 0),
        paidChoices: Number(page.summary.paidChoices || 0),
        pendingTasks: Number(page.summary.pendingTasks || 0),
        continueAllowed: page.summary.continueAllowed === true,
        priceText: compactText(page.summary.priceText || "", 100)
      } : null,
      errors: (page.errors || []).slice(0, 8).map((error) => compactText(
        typeof error === "string" ? error : error.message || error.label || "",
        240
      ))
    };
  }

  function compactFlowLogValue(value, key = "", depth = 0) {
    if (value == null || typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value === "string") return compactText(value, 900);
    if (depth >= 4) return "[bounded]";
    if (key === "page" || key === "pageBefore" || key === "pageAfterAction") {
      return compactFlowLogPage(value);
    }
    if (key === "targetSnapshot" || key === "target" || key === "resolved") {
      return compactFlowLogTarget(value);
    }
    if (Array.isArray(value)) {
      return value.slice(0, 24).map((item) => compactFlowLogValue(item, "", depth + 1));
    }
    if (typeof value !== "object") return compactText(String(value), 900);
    const dropped = new Set([
      "observation",
      "previousObservation",
      "beforeObservation",
      "afterObservation",
      "pageMap",
      "controls",
      "controlAliases",
      "candidateSet",
      "contextCapabilities",
      "normalCandidates",
      "recoveryCandidates",
      "excludedCandidates",
      "operations",
      "actuators",
      "strategies",
      "exactActuators",
      "actionabilityByActuator",
      "targetabilityByActuator",
      "visualRegions",
      "backendDebug",
      "debug",
      "processAwareness",
      "transactionReview",
      "canonicalDecisions",
      "observedDecisions",
      "semanticCompilation",
      "interactionView",
      "screenshotDataUrl"
    ]);
    const compact = {};
    for (const [childKey, childValue] of Object.entries(value).slice(0, 100)) {
      if (dropped.has(childKey)) continue;
      compact[childKey] = compactFlowLogValue(childValue, childKey, depth + 1);
    }
    return compact;
  }

  function compactFlowLogPayload(phase = "", payload = {}) {
    const compact = compactFlowLogValue(payload, "", 0) || {};
    if (JSON.stringify(compact).length <= 32_000) return compact;
    const decision = payload.decision || {};
    return {
      truncated: true,
      phase: String(phase || ""),
      turnId: String(payload.turnId || ""),
      observationId: String(payload.observationId || decision.observationId || ""),
      actionId: String(payload.actionId || decision.actionId || decision.id || ""),
      action: String(typeof payload.action === "string" ? payload.action : decision.action || ""),
      intent: String(payload.intent || decision.intent || ""),
      targetLabel: compactText(payload.targetLabel || decision.targetLabel || "", 240),
      code: String(payload.code || payload.failureCode || payload.result?.code || ""),
      reason: compactText(payload.reason || decision.reason || "", 500),
      observationBytes: Number(payload.observationBytes || 0),
      request_upload_ms: Number(payload.request_upload_ms || 0),
      turn_total_ms: Number(payload.turn_total_ms || 0),
      page: compactFlowLogPage(payload.page || payload.pageAfterAction || payload.pageBefore || {}),
      targetSnapshot: compactFlowLogTarget(payload.targetSnapshot || decision.targetSnapshot || {})
    };
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
    const diagnosticPayload = compactFlowLogPayload(phase, payload);
    const entry = {
      seq: agent.flowSeq + 1,
      at: new Date().toISOString(),
      turnId: payload.turnId || agent.activeTurnId || "",
      phase,
      payload: diagnosticPayload
    };
    agent.flowSeq += 1;
    agent.flowLog.push(entry);
    agent.flowLog = agent.flowLog.slice(-160);
    logAgentEvent(`flow:${phase}`, diagnosticPayload);
    // eslint-disable-next-line no-console
    console.debug("[atw-flow]", phase, diagnosticPayload);
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
    return /wait_for_ready_observation|reobserve_after_transient_observation|reobserve_degraded_loading_destination|reobserve_after_grounding_rejection|task_state_reobserve/.test(intent)
      || (decision.expectedPostconditions || []).some((postcondition) => (
        postcondition?.type === "observation_readiness" && postcondition?.status === "READY"
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
    const taskStateWait = /task_state_reobserve/.test(`${decision.intent || ""} ${decision.semanticIntent || ""}`.toLowerCase());
    const retryToken = String(decision.reobserveRetryToken || "");
    agent.destinationWait = {
      status: "WAITING_FOR_DESTINATION",
      kind: taskStateWait ? "current_surface" : "destination",
      startedAt: backendStartedAt > 0 ? backendStartedAt : (existing?.startedAt || now),
      deadlineAt: backendDeadlineAt > 0 ? backendDeadlineAt : (existing?.deadlineAt || (now + DESTINATION_WAIT_TIMEOUT_MS)),
      attempts: Number(existing?.attempts || 0),
      backendWaits: Number(existing?.backendWaits || 0) + 1,
      wakeRequested: false,
      lastWakeReason: "backend_wait",
      lastMutationAt: Number(existing?.lastMutationAt || 0),
      deadlineObservationSent: Boolean(existing?.deadlineObservationSent),
      observationId: decision.observationId || existing?.observationId || "",
      actionId: decision.actionId || decision.id || existing?.actionId || "",
      retryToken: retryToken || existing?.retryToken || ""
    };
    setAgentActivity(
      taskStateWait ? "Watching the current checkout surface" : "Waiting for destination",
      taskStateWait
        ? "No safe current actuator is available yet. I will resume on a material page change or stop at the bounded deadline."
        : "Navigation completed, but the destination controls are still hydrating. I will continue automatically."
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
    // DOM mutation is the only early wake-up. Replace the deadline timer with
    // one settled material observation; unchanged timer polling is forbidden.
    if (reason === "dom_mutation" && agent.destinationWaitTimer) {
      clearTimeout(agent.destinationWaitTimer);
      agent.destinationWaitTimer = null;
    }
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
    agent.honoredReobserveRetryTokens.clear();
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
      agent.sessionStartFailure = null;
      const settings = await storageGet(["apiBase", "selectedBookingContract"]);
      const selectedTraveler = traveler();
      if (!selectedTraveler?.id) {
        const error = new Error("Select at least one wallet traveler before starting checkout.");
        error.code = "SELECTED_TRAVELER_REQUIRED";
        throw error;
      }
      const immediateAcquisition = resumeSessionId
        ? null
        : readSelectedBookingAcquisition()
          || captureSelectedBookingFromMap(agent.pageMap || pageStateStore.current());
      const selectedBookingContract = resumeSessionId
        ? null
        : validStoredSelectedBookingContract(settings.selectedBookingContract, selectedTraveler)
          || composeSelectedBookingContract(immediateAcquisition, selectedTraveler);
      const response = await fetch(`${settings.apiBase || DEFAULT_API}/agent/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: resumeSessionId || "",
          resumeOnly: Boolean(resumeSessionId),
          goal: agent.userGoal || "Complete this flight checkout safely with one-click assistance.",
          userIntent: userIntentText(),
          traveler: traveler(),
          selectedBookingContract,
          page: compactPageMap(agent.pageMap || pageStateStore.observe({ reason: "session_start" }).map)
        })
      });
      const session = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(session.error || `session returned ${response.status}`);
        error.code = session.code || `HTTP_${response.status}`;
        error.retryable = session.retryable === true;
        throw error;
      }
      const sessionId = String(session.id || "");
      if (!sessionId) throw new Error("session handshake returned an empty id");
      if (resumeSessionId && sessionId !== resumeSessionId) {
        throw new Error("session handshake returned a replacement transaction id");
      }
      agent.sessionId = sessionId;
      logAgentEvent("agent_session_started", { sessionId: agent.sessionId });
      return session;
    } catch (error) {
      agent.sessionStartFailure = {
        code: String(error.code || "SESSION_START_FAILED"),
        message: String(error.message || "Checkout session could not be started.")
      };
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

  function canonicalItineraryActionDate(value = "") {
    const text = String(value || "").replace(/(\d{1,2})(?:st|nd|rd|th)\b/gi, "$1").trim();
    const iso = text.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
    const months = new Map([
      ["january", 1], ["february", 2], ["march", 3], ["april", 4], ["may", 5], ["june", 6],
      ["july", 7], ["august", 8], ["september", 9], ["october", 10], ["november", 11], ["december", 12],
      ["jan", 1], ["feb", 2], ["mar", 3], ["apr", 4], ["jun", 6], ["jul", 7], ["aug", 8],
      ["sep", 9], ["sept", 9], ["oct", 10], ["nov", 11], ["dec", 12]
    ]);
    const dayFirst = text.match(/\b(\d{1,2})\s+([\p{L}.]+)\s+(20\d{2})\b/iu);
    const monthFirst = text.match(/\b([\p{L}.]+)\s+(\d{1,2})(?:,)?\s+(20\d{2})\b/iu);
    const match = dayFirst || monthFirst;
    if (!match) return "";
    const day = Number(dayFirst ? match[1] : match[2]);
    const monthName = String(dayFirst ? match[2] : match[1]).toLowerCase().replace(/\.$/, "");
    const year = Number(match[3]);
    const month = months.get(monthName) || 0;
    const date = new Date(Date.UTC(year, month - 1, day));
    if (!month || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return "";
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  function itineraryActionEvidence(element) {
    if (!element?.matches?.("button, a, [role='button'], [role='link']")) return null;
    const labels = [
      element.getAttribute?.("aria-label"),
      directControlName(element),
      buttonText(element),
      element.getAttribute?.("title")
    ].map((value) => String(value || "").replace(/\s+/g, " ").trim()).filter(Boolean);
    for (const label of [...new Set(labels)]) {
      const match = label.match(/^(?:edit|change|modify|view)\s+([\p{L}][\p{L} .'’-]{1,78}?)\s+(?:to|→|–|—)\s+([\p{L}][\p{L} .'’-]{1,78}?)\s+flight\s+(?:on|departing(?:\s+on)?)\s+(.{5,60}?)(?:[.!]|$)/iu);
      if (!match) continue;
      const departureDate = canonicalItineraryActionDate(match[3]);
      const origin = match[1].trim();
      const destination = match[2].trim();
      if (!departureDate || origin.toLowerCase() === destination.toLowerCase()) continue;
      return { label, origin, destination, departureDate };
    }
    return null;
  }

  const { transactionFactsEvidence } = createTransactionEvidenceCompiler({
    AGENT_CONTRACT,
    agent,
    implicitRole,
    isVisible,
    itineraryActionEvidence,
    primaryPageText,
    queryAllDeep,
    stableHash,
    structuredPricesFromText,
    traveler,
    visiblePageText
  });

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
    const controlledIds = String(element?.getAttribute?.("aria-controls") || "")
      .split(/\s+/)
      .filter(Boolean);
    const controlledElements = controlledIds
      .map((id) => document.getElementById(id))
      .filter(Boolean);
    const controlsInformationOnly = controlledElements.length > 0
      && controlledElements.every((controlled) => (
        !controlled.matches?.("[role='dialog'], [role='listbox'], [role='menu'], [role='option']")
        && !controlled.querySelector?.("input, select, textarea, button, [role='option'], [role='radio'], [role='checkbox']")
      ));
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
      ariaControls: controlledIds.join(" "),
      ariaExpanded: element?.hasAttribute?.("aria-expanded")
        ? String(element.getAttribute("aria-expanded"))
        : "",
      ariaHasPopup: compactText(element?.getAttribute?.("aria-haspopup") || "", 40).toLowerCase(),
      controlsInformationOnly,
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
    const informationDisclosure = evidence.controlsInformationOnly === true
      && Boolean(evidence.ariaControls)
      && evidence.ariaExpanded !== ""
      && !evidence.ariaHasPopup
      && !choiceControl
      && /detail|characteristic|information|info|read|learn|description|benefit/.test(
        `${identity} ${evidence.ariaControls || ""}`
      );
    const explicitDeclineCommand = /^(?:no,?\s*thanks|not now|skip|decline|(?:i(?:'|’)ll )?go without|continue without|without)\b/.test(ownMeaning);

    // Conflicting structural identities are not guessed. A misleading ARIA
    // label alone is contextual evidence and cannot overwrite test-id/form/
    // own-text identity (for example an icon X labelled by its parent CTA).
    if (strongDismiss && (evidence.type === "submit" || /submit|payment/.test(identity))) {
      return { semantic: "unknown", physicalEffect: "unknown", conflict: true };
    }
    if (strongDismiss) return { semantic: "dismiss_surface", physicalEffect: "dismiss_surface", conflict: false };
    if (informationDisclosure) return { semantic: "reveal_information", physicalEffect: "open_surface", conflict: false };
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

  function currentSurfaceEntryForElement(map, element) {
    if (!element) return null;
    const id = elementId(element);
    return currentSurfaceEntries(map).find((entry) => entry.id === id) || null;
  }

  function isActionableClickTarget(element) {
    return Boolean(element?.matches?.("button, a, input[type='button'], input[type='submit'], [role='button'], [role='option'], [role='checkbox'], [role='radio'], label, input[type='checkbox'], input[type='radio'], [tabindex]"));
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

  const {
    cardContainerForControl,
    checkoutHeadingCount,
    clearSectionHighlights,
    clearSectionOutlines,
    continueSectionElement,
    detectCheckoutSections,
    detectGenericSections,
    elementBelongsToSectionBand,
    elementRectArea,
    fieldsetLikeSection,
    genericSectionLabel,
    highlightSection,
    isSummaryLikeElement,
    liveSectionModels,
    outlineCoreSections,
    plannedTargetForSection,
    sectionAnchorByText,
    sectionBand,
    sectionCardByPattern,
    sectionContainer,
    sectionPlanDescription
  } = createSectionPerception({
    buttonText,
    candidateInputs,
    choiceLabel,
    controlText,
    elementBox,
    elementById,
    elementId,
    fieldValue,
    findSafeContinueButton,
    isGlobalChromeControl,
    isVisible,
    labelText,
    meaningfulActionBox,
    queryAllDeep
  });

  let logicalControlCompiler = null;

  function canonicalControlForElement(...args) {
    return logicalControlCompiler.canonicalControlForElement(...args);
  }
  function canonicalDecisionEffectRole(...args) {
    return logicalControlCompiler.canonicalDecisionEffectRole(...args);
  }
  function choiceLabel(...args) {
    return logicalControlCompiler.choiceLabel(...args);
  }
  function choiceRisk(...args) {
    return logicalControlCompiler.choiceRisk(...args);
  }
  function dateFieldEvidenceForElement(...args) {
    return logicalControlCompiler.dateFieldEvidenceForElement(...args);
  }
  function describedText(...args) {
    return logicalControlCompiler.describedText(...args);
  }
  function isAuxiliaryNavigationAction(...args) {
    return logicalControlCompiler.isAuxiliaryNavigationAction(...args);
  }
  function isChoiceSelected(...args) {
    return logicalControlCompiler.isChoiceSelected(...args);
  }
  function isGlobalChromeControl(...args) {
    return logicalControlCompiler.isGlobalChromeControl(...args);
  }
  function isPlaceholderChoiceValue(...args) {
    return logicalControlCompiler.isPlaceholderChoiceValue(...args);
  }
  function labelElementForInput(...args) {
    return logicalControlCompiler.labelElementForInput(...args);
  }
  function meaningfulActionBox(...args) {
    return logicalControlCompiler.meaningfulActionBox(...args);
  }
  function normalizeVisualRegionContract(...args) {
    return logicalControlCompiler.normalizeVisualRegionContract(...args);
  }
  function normalizedProfileChoiceValue(...args) {
    return logicalControlCompiler.normalizedProfileChoiceValue(...args);
  }
  function observedLocale(...args) {
    return logicalControlCompiler.observedLocale(...args);
  }
  function rememberChoiceVisualStateBeforeDispatch(...args) {
    return logicalControlCompiler.rememberChoiceVisualStateBeforeDispatch(...args);
  }
  function sectionButtonModels(...args) {
    return logicalControlCompiler.sectionButtonModels(...args);
  }
  function sectionChoiceInputs(...args) {
    return logicalControlCompiler.sectionChoiceInputs(...args);
  }
  function sectionChoiceSelected(...args) {
    return logicalControlCompiler.sectionChoiceSelected(...args);
  }
  function sectionFieldModels(...args) {
    return logicalControlCompiler.sectionFieldModels(...args);
  }
  function sectionHasRequiredChoice(...args) {
    return logicalControlCompiler.sectionHasRequiredChoice(...args);
  }
  function sectionTypeFor(...args) {
    return logicalControlCompiler.sectionTypeFor(...args);
  }
  function selectedControlLabels(...args) {
    return logicalControlCompiler.selectedControlLabels(...args);
  }
  function semanticChoiceType(...args) {
    return logicalControlCompiler.semanticChoiceType(...args);
  }
  function slugControlPart(...args) {
    return logicalControlCompiler.slugControlPart(...args);
  }
  function stableControlKeyForElement(...args) {
    return logicalControlCompiler.stableControlKeyForElement(...args);
  }
  function stateElementForControl(...args) {
    return logicalControlCompiler.stateElementForControl(...args);
  }
  function unionBoxes(...args) {
    return logicalControlCompiler.unionBoxes(...args);
  }
  function visualRegionContractsMatch(...args) {
    return logicalControlCompiler.visualRegionContractsMatch(...args);
  }
  function checkedFieldLabels(...args) {
    return logicalControlCompiler.checkedFieldLabels(...args);
  }

  logicalControlCompiler = createLogicalControlCompiler({
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
    travelerValue,
    updateChoiceInteractionState,
    decisionGroupIdForContext: (...args) => decisionGroupIdForContext(...args),
    surfaceLooksLikeSeatSkip: (...args) => surfaceLooksLikeSeatSkip(...args)
  });
  const NON_ECONOMIC_EFFECT_ROLES = logicalControlCompiler.NON_ECONOMIC_EFFECT_ROLES;

  const {
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
  } = createDecisionGroupCompiler({
    NON_ECONOMIC_EFFECT_ROLES,
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
    surfaceProgressMarkers: (...args) => surfaceProgressMarkers(...args)
  });

  let controlGraphCompiler = null;

  function buildCanonicalControlGraph(...args) {
    return controlGraphCompiler.buildCanonicalControlGraph(...args);
  }
  function buildSectionModels(...args) {
    return controlGraphCompiler.buildSectionModels(...args);
  }
  function buildTaskQueue(...args) {
    return controlGraphCompiler.buildTaskQueue(...args);
  }
  function decisionChoiceOwnerLabel(...args) {
    return controlGraphCompiler.decisionChoiceOwnerLabel(...args);
  }
  function exclusiveDecisionOwner(...args) {
    return controlGraphCompiler.exclusiveDecisionOwner(...args);
  }
  function lookupControlForElement(...args) {
    return controlGraphCompiler.lookupControlForElement(...args);
  }
  function structuralDecisionChoiceKind(...args) {
    return controlGraphCompiler.structuralDecisionChoiceKind(...args);
  }
  function structuralDecisionChoicePeers(...args) {
    return controlGraphCompiler.structuralDecisionChoicePeers(...args);
  }
  function unfilledRequiredFields(...args) {
    return controlGraphCompiler.unfilledRequiredFields(...args);
  }

  controlGraphCompiler = createControlGraphCompiler({
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
    stableControlKeyForElement,
    stateElementForControl,
    currentObservationControlRegistry: () => activeObservationControlRegistry,
    currentPageMap: () => agent.pageMap || null,
    isSafeContinueLabel: (...args) => isSafeContinueLabel(...args),
    setObservationControlRegistry: (registry) => {
      activeObservationControlRegistry = registry;
    },
    surfaceMembershipForElement: (...args) => surfaceMembershipForElement(...args)
  });

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

  function exactChildChoiceSettlementEvidence(verification = {}, commit = null, expected = {}, decision = {}) {
    if (!commit || expected.type !== "logical_component_committed" || verification.ok === true) return null;
    const evidence = verification.evidence && typeof verification.evidence === "object" && !Array.isArray(verification.evidence)
      ? verification.evidence
      : {};
    const semanticType = canonicalProfileFieldType(expected.semanticType || "") || String(expected.semanticType || "");
    const desiredCanonicalValue = String(
      expected.expectedCanonicalValue
      || expected.expectedNormalizedValue
      || expected.expectedComponentValue
      || ""
    );
    const selectedCanonicalValue = String(
      decision.value
      || decision.targetLabel
      || commit.desiredLabel
      || ""
    );
    const ownedValidationErrors = Array.isArray(evidence.ownedValidationErrors)
      ? evidence.ownedValidationErrors
      : null;
    const validationClear = Boolean(ownedValidationErrors && ownedValidationErrors.length === 0);
    const exactCompatibleChoice = AGENT_CONTRACT?.profileChoiceValueCompatible?.(
      selectedCanonicalValue,
      desiredCanonicalValue,
      semanticType
    ) === true;
    const actualNormalizedValue = String(evidence.actualNormalizedValue || "");
    const settled = Boolean(
      verification.code === "LOGICAL_COMPONENT_NOT_COMMITTED"
      && !actualNormalizedValue
      && desiredCanonicalValue
      && selectedCanonicalValue
      && exactCompatibleChoice
      && commit.ok === true
      && commit.popupClosed === true
      && commit.focusSettled === true
      && evidence.commitSettled === true
      && evidence.activeChoiceSurface === false
      && validationClear
      && verification.feedback?.priceChanged !== true
    );
    return {
      contractVersion: "exact-child-choice-settlement/v1",
      settled,
      reasonCode: settled
        ? "EXACT_CHILD_CHOICE_SEMANTICALLY_COMMITTED"
        : "EXACT_CHILD_CHOICE_NOT_PROVEN",
      logicalFieldId: String(expected.logicalFieldId || ""),
      subjectId: String(expected.subjectId || "traveler_1"),
      semanticType,
      componentRole: String(expected.componentRole || "value"),
      parentControlId: String(expected.controlId || ""),
      selectedControlId: String(decision.controlId || commit.controlId || ""),
      selectedActuatorId: String(decision.actuatorId || decision.targetId || commit.actuatorId || ""),
      desiredCanonicalValue,
      selectedCanonicalValue,
      actualStateBlank: !actualNormalizedValue,
      validationClear,
      popupClosed: commit.popupClosed === true,
      focusSettled: commit.focusSettled === true
    };
  }

  function withChoiceCommitEvidence(verification = {}, commit = null, expected = {}, decision = {}) {
    if (!commit) return verification;
    const compactCommit = compactChoiceCommitEvidence(commit);
    const existingEvidence = verification.evidence && typeof verification.evidence === "object" && !Array.isArray(verification.evidence)
      ? verification.evidence
      : { verifierEvidence: verification.evidence || null };
    const exactChildSettlement = exactChildChoiceSettlementEvidence(
      verification,
      compactCommit,
      expected,
      decision
    );
    if (exactChildSettlement?.settled === true) {
      return {
        ...verification,
        ok: true,
        code: "LOGICAL_COMPONENT_COMMITTED",
        message: "The exact compatible child choice settled the logical component with clear validation and no price change.",
        evidence: {
          ...existingEvidence,
          choiceCommit: compactCommit,
          exactChildSettlement
        }
      };
    }
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
        choiceCommit: compactCommit,
        ...(exactChildSettlement ? { exactChildSettlement } : {})
      }
    };
  }

  function currentOwnedValidationErrors(map = {}, expected = {}, controlState = {}) {
    return (map.validationIssues || []).filter((issue) => {
      const owned = issue.stageWide === true || (expected.controlId && issue.controlId === expected.controlId);
      if (!owned) return false;
      const contradictedPresenceError = Boolean(
        issue.controlId === expected.controlId
        && controlState?.valuePresent === true
        && controlState?.invalid !== true
        && !String(controlState?.validationMessage || "").trim()
        && /\b(?:empty|required|missing|fill|enter|provide)\b/i.test(String(issue.message || issue.text || issue.label || ""))
      );
      return !contradictedPresenceError;
    });
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
    const beforeExpectedControl = expectedControlId
      ? (beforeMap.controls || []).find((control) => control.controlId === expectedControlId)
      : null;
    const stableStateElementId = String(
      expected.stateElementId
      || beforeExpectedControl?.stateElementId
      || beforeExpectedControl?.componentContract?.controlIdentity?.stateElementId
      || ""
    );
    const stateElementReboundControl = stableStateElementId
      ? (afterMap.controls || []).find((control) => String(
          control.stateElementId
          || control.componentContract?.controlIdentity?.stateElementId
          || ""
        ) === stableStateElementId)
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
          // Some sites expose a split requirement (for example phone country
          // code) as its own exact semantic control whose local component role
          // is simply "value". The exact semantic identity is sufficient to
          // rebind that control after its visible label and hashed control id
          // change on selection.
          if (String(control.componentContract?.componentRole || control.componentRole || "") === "value") return true;
          return String(
            control.componentRole
            || control.componentContract?.componentRole
            || control.fieldClassification?.componentRole
            || control.dateField?.component
            || ""
          ) === expectedComponentRole
            || boundedPhrase(`${control.name || ""} ${control.autocomplete || ""}`, expectedComponentRole);
        })
      : [];
    const expectedReboundValue = String(
      expected.expectedNormalizedValue
      || expected.expectedComponentValue
      || ""
    );
    const expectedSemanticValue = normalizedProfileChoiceValue(
      expectedReboundValue,
      expectedSemanticType
    );
    const controlMatchesExpectedValue = (control) => {
      if (!control || !expectedReboundValue) return false;
      const rawValue = String(
        control.state?.normalizedValue
        || control.state?.dateComponentValue
        || control.state?.canonicalDateValue
        || ""
      );
      if (rawValue === expectedReboundValue) return true;
      const semanticValue = normalizedProfileChoiceValue(rawValue, expectedSemanticType);
      return Boolean(semanticValue && expectedSemanticValue && semanticValue === expectedSemanticValue);
    };
    const exactStateControlIds = new Set([
      ...(Array.isArray(expected.stateControlIds) ? expected.stateControlIds : []),
      expected.controlId || ""
    ].filter(Boolean));
    const expectedRepresentationIdentity = String(expected.representationIdentity || "");
    const ownerStateControls = (afterMap.controls || []).filter((control) => (
      exactStateControlIds.has(control.controlId)
      || Boolean(
        expectedRepresentationIdentity
        && String(
          control.componentContract?.componentIdentity
          || control.componentIdentity
          || ""
        ) === expectedRepresentationIdentity
      )
    ));
    // A custom control may keep mechanics on a visible combobox while writing
    // its canonical value into a hidden state sibling. Prefer fresh value
    // evidence from that exact logical owner over a blank actuator shell.
    const valueMatchedOwnerControl = ownerStateControls.find(controlMatchesExpectedValue);
    const valueMatchedSemanticControl = semanticRebindCandidates.find(controlMatchesExpectedValue);
    const afterControl = valueMatchedOwnerControl
      || (controlMatchesExpectedValue(directlyMatchedControl) ? directlyMatchedControl : null)
      || (controlMatchesExpectedValue(stateElementReboundControl) ? stateElementReboundControl : null)
      || valueMatchedSemanticControl
      || directlyMatchedControl
      || validationOwnerControl
      || stateElementReboundControl
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
      const compatibleProfileChoice = AGENT_CONTRACT?.profileChoiceValueCompatible?.(
        actualNormalizedValue,
        wantedNormalizedValue,
        canonicalProfileFieldType(semanticType) || semanticType
      ) === true;
      const currentSurface = afterMap.currentSurface || {};
      const surfaceDismissed = !expected.requireSurfaceDismissed
        || !expected.surfaceId
        || currentSurface.id !== expected.surfaceId;
      const ownedValidationErrors = currentOwnedValidationErrors(afterMap, expected, afterControlState);
      const ok = Boolean(
        wantedNormalizedValue
        && (
          actualNormalizedValue === wantedNormalizedValue
          || (
            actualSemanticValue
            && wantedSemanticValue
            && actualSemanticValue === wantedSemanticValue
          )
          || compatibleProfileChoice
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
    if (expected.type === "logical_component_committed") {
      const actualNormalizedValue = String(afterControlState?.normalizedValue || "");
      const wantedNormalizedValue = String(expected.expectedNormalizedValue || expected.expectedComponentValue || "");
      const semanticType = expected.semanticType || afterControl?.fieldType || afterControl?.semantic || "";
      const actualSemanticValue = normalizedProfileChoiceValue(actualNormalizedValue, semanticType);
      const wantedSemanticValue = normalizedProfileChoiceValue(wantedNormalizedValue, semanticType);
      const compatibleProfileChoice = AGENT_CONTRACT?.profileChoiceValueCompatible?.(
        actualNormalizedValue,
        wantedNormalizedValue,
        canonicalProfileFieldType(semanticType) || semanticType
      ) === true;
      const currentSurface = afterMap.currentSurface || {};
      const expectedChildSurfaceId = String(expected.surfaceId || "");
      const activeChoiceSurface = Boolean(
        currentSurface.type
        && currentSurface.type !== "page"
        && (
          afterControlState?.expanded === true
          || currentSurface.parentControlId === expected.controlId
          || (expectedChildSurfaceId && currentSurface.id === expectedChildSurfaceId)
        )
      );
      const commitState = afterControl?.commitState || null;
      const commitSettled = commitState
        ? Boolean(
            commitState.status === "settled"
            && commitState.popupClosed !== false
            && commitState.focusSettled !== false
          )
        : !activeChoiceSurface;
      const ownedValidationErrors = currentOwnedValidationErrors(afterMap, expected, afterControlState);
      const exactValue = Boolean(
        wantedNormalizedValue
        && (
          actualNormalizedValue === wantedNormalizedValue
          || (
            actualSemanticValue
            && wantedSemanticValue
            && actualSemanticValue === wantedSemanticValue
          )
          || compatibleProfileChoice
        )
      );
      const ok = Boolean(
        exactValue
        && commitSettled
        && ownedValidationErrors.length === 0
      );
      return {
        ok,
        code: ok ? "LOGICAL_COMPONENT_COMMITTED" : "LOGICAL_COMPONENT_NOT_COMMITTED",
        message: ok
          ? "The logical component retained its canonical value and its owned choice interaction settled."
          : "The logical component has not proven both its canonical value and choice-interaction settlement.",
        evidence: {
          ...evidence,
          actualNormalizedValue,
          wantedNormalizedValue,
          actualSemanticValue,
          wantedSemanticValue,
          interactionKind: expected.interactionKind || "choice",
          commitRequirement: expected.commitRequirement || "logical_component_committed",
          activeChoiceSurface,
          commitSettled,
          commitState,
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
          selectedChargeRemoved: chargeCleared,
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
        && /decline|safe decline|free|no thanks|without|skip/.test(selectedText)
        && sourceRetired
        && changed
        && (
          (beforeExpectedControl.surfaceType
            && beforeExpectedControl.surfaceType !== "page"
            && (afterMap.currentSurface?.id !== beforeExpectedControl.surfaceId || afterMap.currentSurface?.type === "page"))
          || (beforeExpectedControl.surfaceType === "page" && checkoutStageAdvanced)
        )
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
      const beforeUrl = String(expected.beforeUrl || beforeMap.url || location.href);
      const afterUrl = String(afterMap.url || location.href);
      const urlChanged = beforeUrl !== afterUrl;
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
      // The canonical page map intentionally does not need to duplicate the
      // browser URL on every internal snapshot. Compare against the governed
      // pre-action URL when it is supplied; treating a missing beforeMap.url
      // as an empty string made every same-page click look like navigation.
      const beforeUrl = String(expected.beforeUrl || beforeMap.url || location.href);
      const afterUrl = String(afterMap.url || location.href);
      const urlChanged = beforeUrl !== afterUrl;
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
    return withAgentUiPointerPassthrough(async () => {
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
    });
  }

  function boundedLocalClickMechanicAllowed(decision = {}) {
    const operation = String(decision.operation || "").toLowerCase();
    const risk = String(decision.risk || decision.targetSnapshot?.risk || "").toLowerCase();
    const effect = String([
      decision.intent,
      decision.semanticEffect,
      decision.physicalEffect,
      decision.mechanicalEffect,
      decision.targetSnapshot?.semantic
    ].filter(Boolean).join(" ")).toLowerCase();
    return ["open", "choose", "select", "activate"].includes(operation)
      && !isStageExitDecision(decision)
      && !/money|paid|payment|purchase|legal|consent|account|login|itinerary/.test(`${risk} ${effect}`);
  }

  function localMechanicReactionSnapshot(element) {
    return JSON.stringify({
      connected: Boolean(element?.isConnected),
      expanded: element?.getAttribute?.("aria-expanded") || "",
      checked: element?.getAttribute?.("aria-checked") || element?.checked || false,
      selected: element?.getAttribute?.("aria-selected") || element?.selected || false,
      value: element?.value || "",
      text: String(element?.innerText || element?.textContent || "").replace(/\s+/g, " ").trim()
    });
  }

  async function waitForLocalMechanicReaction(element, before, timeoutMs = 320) {
    const startedAt = performance.now();
    while (performance.now() - startedAt < timeoutMs) {
      if (localMechanicReactionSnapshot(element) !== before) return true;
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    return localMechanicReactionSnapshot(element) !== before;
  }

  async function dispatchGovernedClickMechanic(element, decision = {}, meta = {}) {
    const reactionBefore = localMechanicReactionSnapshot(element);
    let choiceCommitResult = null;
    let primary = { ok: true, method: decision.interactionMethod || "pointer_sequence" };
    if (decision.interactionMethod === "native_click") {
      primary = nativeElementClick(element, meta)
        ? { ok: true, method: "native_click" }
        : { ok: false, code: "NATIVE_CLICK_UNAVAILABLE", method: "native_click" };
    } else if (decision.interactionMethod === "browser_trusted_input") {
      primary = await trustedBrowserClick(element, { ...decision, ...meta });
    } else if (decision.interactionMethod === "browser_trusted_choice") {
      primary = await trustedBrowserChoice(element, { ...decision, ...meta });
      if (primary?.ok === true) {
        choiceCommitResult = await settleTrustedChoiceInteraction(element, { ...decision, ...meta });
      }
    } else {
      userLikeClick(element, { ...meta, method: decision.interactionMethod || "pointer_sequence" });
    }
    if (primary?.ok !== true) return { ...primary, choiceCommitResult };

    const mayFallback = boundedLocalClickMechanicAllowed(decision)
      && !["browser_trusted_input", "browser_trusted_choice"].includes(decision.interactionMethod);
    const reactionObserved = mayFallback
      ? await waitForLocalMechanicReaction(element, reactionBefore)
      : false;
    if (!mayFallback || reactionObserved) {
      return {
        ok: true,
        method: primary.method || decision.interactionMethod || "pointer_sequence",
        choiceCommitResult,
        reactionObserved
      };
    }

    // Reuse the same fresh action lease and exact actuator. This is one local
    // mechanic, not a new semantic decision or a silently rebound target.
    const freshMap = pageStateStore.observe({ reason: "bounded_local_click_revalidate" }).map;
    const freshTarget = resolveDecisionTarget(decision, freshMap);
    const validation = freshTarget && freshTarget === element
      ? validateResolvedTarget(decision, freshTarget, freshMap)
      : { ok: false, code: "TARGET_DISAPPEARED" };
    if (!validation.ok) {
      return { ok: true, method: primary.method || decision.interactionMethod || "pointer_sequence", choiceCommitResult };
    }
    const fallback = await trustedBrowserClick(freshTarget, { ...decision, ...meta });
    pushActionLedger({
      actionId: meta.actionId || decision.actionId || decision.id || "",
      observationId: meta.observationId || decision.observationId || "",
      stage: "local_mechanic_fallback",
      action: decision,
      primaryMethod: primary.method || decision.interactionMethod || "pointer_sequence",
      fallbackMethod: "browser_trusted_input",
      fallbackCode: fallback?.code || ""
    });
    return {
      // The primary mechanic was dispatched. An unavailable optional fallback
      // must not rewrite that fact as a pre-dispatch failure; canonical
      // verification below decides whether the action worked.
      ok: true,
      code: fallback?.ok === true ? "LOCAL_FALLBACK_DISPATCHED" : (fallback?.code || "LOCAL_FALLBACK_UNAVAILABLE"),
      method: fallback?.ok === true ? "browser_trusted_input" : (primary.method || decision.interactionMethod || "pointer_sequence"),
      fallbackUsed: fallback?.ok === true,
      choiceCommitResult
    };
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
    return withAgentUiPointerPassthrough(async () => {
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
    });
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

  function exactChoiceCommitReadiness(target, decision = {}, pageMap = agent.pageMap || {}) {
    if (isChoiceSelected(target)) {
      return { ready: true, source: "observed_selected_state" };
    }
    const readyStageExitCandidates = (pageMap?.stageExit?.candidates || []).filter((candidate) => (
      candidate.status === "ready" || candidate.executable === true
    ));
    if (readyStageExitCandidates.length) {
      return {
        ready: true,
        source: "stage_exit_enabled",
        candidateControlIds: readyStageExitCandidates.map((candidate) => candidate.controlId).filter(Boolean)
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
      // The site may enable its forward action asynchronously without changing
      // the selected card itself. Recompile the current surface on every bounded
      // probe so commitment never depends on an old agent.pageMap snapshot.
      afterMap = buildPageMap();
      const readiness = exactChoiceCommitReadiness(target, decision, afterMap);
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
      structuralEvidence: evidence.structuralEvidence || structuralEvidence || {},
      terminalEvidence: evidence.terminalEvidence || null,
      url: String(evidence.url || location.href || "")
    };
  }

  // One classifier owns both runtime and observer output. Evidence channels
  // stay separate so query parameters never become visible checkout semantics.
  function classifyStepDetailed(input, structuralEvidence = {}) {
    const evidence = stepEvidenceInput(input, structuralEvidence);
    const lower = evidence.visibleText.toLowerCase();
    const route = evidence.routePath;
    const terminalEvidence = AGENT_CONTRACT?.compileTerminalEvidence?.({
      url: evidence.url,
      visibleText: evidence.visibleText,
      structuralEvidence: evidence.structuralEvidence,
      terminalEvidence: evidence.terminalEvidence
    }) || null;
    const newSearchRoute = /(?:^|\/)rf\/start\/?$/.test(route)
      || /(?:^|\/)(?:flight-)?search\/?$/.test(route);
    const extrasEvidence = /select baggage|configure your trip|upgrade your trip|checked baggage|hold (?:bags?|baggage|luggage)|add your hold bags|cabin bags?|bundle|premium support|airhelp|cancellation guarantee|voucher refund|add to cart|no thanks|add baggage|choose your bundle/.test(lower);
    const strongExtrasEvidence = /add your hold bags|hold (?:bag|baggage|luggage) options?|select (?:your )?(?:cabin|checked|hold) bags?|add (?:a |your )?(?:cabin|checked|hold) bags?/.test(lower);
    const travelerEvidence = /traveller information|traveler information|contact information|provide your contact details|passport|date of birth|surname|first name|first and middle names|mobile number|confirm e-?mail/.test(lower);
    const seatEvidence = /seat selection|select (?:your )?seats?\b|choose (?:your )?seats?\b/.test(lower);
    const strongSeatEvidence = /reserve seating|seat map|seat map key|standard seat|not selected|select a seat|choose a seat/.test(lower);
    const travelerRouteEvidence = /\/rf\/traveler-details|\/rf\/traveller-details|traveler-details|traveller-details/.test(route);
    const paymentFormEvidence = /card number|security code|cvc|cvv|pay now|complete booking|confirm and pay|submit payment|billing card|cardholder/.test(lower);
    const paymentRouteEvidence = /\/rf\/payments?|\/payments?\b/.test(route);
    const extrasRouteEvidence = /\/(?:cabin-?bags?|hold-?bags?|bags?|baggage|luggage|extras?|ancillar(?:y|ies)|insurance|bundles?)(?:\/|$)/.test(route);
    const confirmationEvidence = /booking confirmed|confirmation number|booking reference|reservation number|\bpnr\b/.test(lower);
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
    if (terminalEvidence?.boundaryObserved === true) return result("payment", 0.99, ["terminal_evidence_contract"]);
    if (confirmationEvidence) return result("confirmation", 0.95, ["confirmation_copy"]);
    if (paymentFormEvidence) return result("payment", 0.95, ["payment_controls_copy"]);
    // The active destination route outranks checkout-progress links retained
    // in the page shell. A hold-bag page commonly contains a visible "Seat
    // selection" breadcrumb, but that is navigation history, not page state.
    if (extrasRouteEvidence) return result("extras", 0.92, ["route_path"]);
    if (strongExtrasEvidence) return result("extras", 0.9, ["baggage_controls_copy"]);
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

  function observeTerminalStructure(fullText = "") {
    // One traversal keeps this evidence probe cheap on large seat maps.
    const visibleTerminalNodes = queryAllDeep("input, select, textarea, button, [role='button'], [aria-current='step'], [data-current='true'], [data-active='true']")
      .filter((element) => isVisible(element) && !element.closest("#atw-sidebar"));
    const visibleInputs = visibleTerminalNodes.filter((element) => element.matches("input, select, textarea"));
    const credentialKindsFromText = (value = "") => {
      const descriptor = String(value || "").toLowerCase().replace(/\s+/g, " ");
      const kinds = new Set();
      if (/card.?number|cc-number/.test(descriptor)) kinds.add("card_number");
      if (/expir|expiration|valid.?through|cc-exp/.test(descriptor)) kinds.add("card_expiry");
      if (/\bcvc\b|\bcvv\b|security.?code|cc-csc/.test(descriptor)) kinds.add("card_security_code");
      if (/cardholder|name.?on.?card/.test(descriptor)) kinds.add("cardholder");
      return kinds;
    };
    const credentialKinds = new Set();
    for (const input of visibleInputs) {
      const descriptor = `${labelText(input)} ${input.getAttribute("name") || ""} ${input.getAttribute("autocomplete") || ""} ${input.getAttribute("placeholder") || ""} ${input.getAttribute("aria-label") || ""}`.toLowerCase();
      credentialKindsFromText(descriptor).forEach((kind) => credentialKinds.add(kind));
    }
    const visibleActions = visibleTerminalNodes.filter((element) => element.matches("button, input[type='button'], input[type='submit'], [role='button']"));
    const payControlPresent = visibleActions.some((element) => (
      AGENT_CONTRACT?.isPaymentCommitText?.(actionElementLabel(element))
      || /^(?:pay(?:\s+now|\s+securely|\s+by\s+(?:card|bank|wallet)|\s+[\d.,]+)|confirm\s+and\s+pay|submit\s+payment|complete\s+purchase|place\s+order)\b/i.test(actionElementLabel(element))
    ));
    const activeProgressText = visibleTerminalNodes
      .filter((element) => element.matches("[aria-current='step'], [data-current='true'], [data-active='true']"))
      .map((element) => actionElementLabel(element) || element.textContent || "")
      .join(" ")
      .slice(0, 500);
    const normalized = String(fullText || "").replace(/\s+/g, " ");
    const activePaymentProgress = /\bpayment\b|\bpay\b/i.test(activeProgressText);
    const paymentRoute = /(?:^|\/)payments?(?:\/|$)/i.test(String(location.pathname || ""));
    const visiblePaymentOwners = queryAllDeep([
      "main",
      "form",
      "fieldset",
      "section",
      "[role='form']",
      "[aria-label*='payment' i]",
      "[aria-label*='card' i]",
      "[data-testid*='payment' i]",
      "[data-testid*='card' i]",
      "[id*='payment' i]",
      "[id*='card' i]"
    ].join(", "))
      .filter((element) => isVisible(element) && !element.closest("#atw-sidebar"))
      .map((element) => {
        const ownerText = String(element.innerText || element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 4000);
        const metadata = `${element.getAttribute?.("aria-label") || ""} ${element.getAttribute?.("data-testid") || ""} ${element.id || ""}`;
        const kinds = credentialKindsFromText(`${metadata} ${ownerText}`);
        const paymentAnchored = paymentRoute
          || activePaymentProgress
          || /\bpayment\b|\bdebit\s*card\b|\bcredit\s*card\b/i.test(`${metadata} ${ownerText}`);
        return { element, kinds, paymentAnchored };
      })
      .filter((owner) => owner.paymentAnchored && owner.kinds.size >= 2);
    const paymentCredentialLabelKinds = new Set();
    visiblePaymentOwners.forEach((owner) => owner.kinds.forEach((kind) => paymentCredentialLabelKinds.add(kind)));
    const visibleHostedPaymentFrames = queryAllDeep("iframe")
      .filter((frame) => isVisible(frame) && !frame.closest("#atw-sidebar"))
      .filter((frame) => /payment|card|checkout|secure|adyen|stripe|braintree|worldpay/i.test([
        frame.title,
        frame.name,
        frame.getAttribute("aria-label"),
        frame.getAttribute("src")
      ].filter(Boolean).join(" ")));
    const paymentOwnerPresent = visiblePaymentOwners.length > 0;
    const hostedPaymentWidgetPresent = visibleHostedPaymentFrames.length > 0 && (
      paymentOwnerPresent || activePaymentProgress || paymentRoute
    );
    const visibleFromToItinerary = /\bFROM\s+[\p{L} .'’-]{1,60}\s*\([A-Z]{3}\).{0,120}\bTO\s+[\p{L} .'’-]{1,60}\s*\([A-Z]{3}\)/iu.test(normalized);
    const visiblePaymentCurrencyPrompt = /\b(?:which|choose|select)\s+(?:the\s+)?currency\b.{0,100}\bpayment\b|\bpayment\b.{0,100}\bcurrency\b/i.test(normalized);
    const visibleExactCurrencyTotal = /\b(?:EUR|USD|GBP|CHF|CAD|AUD)\s*\d+(?:[.,]\d{1,2})\b|\b\d+(?:[.,]\d{1,2})\s*(?:EUR|USD|GBP|CHF|CAD|AUD)\b/i.test(normalized);
    const progressivePaymentEntryPresent = visibleFromToItinerary
      && visiblePaymentCurrencyPrompt
      && visibleExactCurrencyTotal;
    const terminalEvidenceSources = [
      ...(credentialKinds.size ? ["visible_native_payment_credentials"] : []),
      ...(paymentOwnerPresent ? ["visible_owned_payment_labels"] : []),
      ...(hostedPaymentWidgetPresent ? ["visible_hosted_payment_widget"] : []),
      ...(activePaymentProgress ? ["active_payment_progress"] : []),
      ...(paymentRoute ? ["payment_route"] : []),
      ...(progressivePaymentEntryPresent ? ["visible_progressive_payment_entry"] : [])
    ];
    return {
      paymentCredentialKinds: [...credentialKinds],
      paymentCredentialCount: credentialKinds.size,
      paymentFormPresent: credentialKinds.size >= 2,
      paymentCredentialProbeState: credentialKinds.size >= 2 ? "observed_present" : "unknown",
      paymentCredentialLabelKinds: [...paymentCredentialLabelKinds],
      paymentOwnerPresent,
      paymentOwnerProbeState: paymentOwnerPresent ? "observed_present" : "unknown",
      hostedPaymentWidgetPresent,
      visibleTextFallbackAllowed: paymentOwnerPresent,
      paymentMethodPresent: /\bpayment\s+(?:method|option)\b|\bdebit\s*card\b|\bcredit\s*card\b/i.test(normalized),
      payControlPresent,
      legalAcceptancePresent: visibleInputs.some((input) => input.type === "checkbox" && (
        AGENT_CONTRACT?.isLegalAcceptanceText?.(labelText(input))
        || /terms|conditions|privacy|purchase/i.test(labelText(input))
      )),
      reviewSummaryPresent: /\b(?:amount\s+to\s+pay|total)\b/i.test(normalized)
        && /\b(?:departure|return|itinerary|travel\s+details|your\s+order)\b/i.test(normalized),
      paymentHeadingPresent: /\b(?:payment\s+details|choose\s+payment\s+method|pay\s+securely|overview\s*(?:&|and)\s*payment)\b/i.test(normalized),
      activePaymentProgress,
      activeProgressText,
      progressivePaymentEntryPresent,
      terminalEvidenceSources
    };
  }

  const {
    boundedSurfaceEvidenceOptions,
    foregroundSurfaceState,
    isInViewport,
    overlayTopHitCount,
    overlayVisualScore,
    pageCoverage,
    pageReadinessFacts,
    pointBelongsToElement,
    surfaceProgressMarkers,
    visualPageState,
    visibleOverlays
  } = createPerceptionFacade({
    activeOverlayElements: (...args) => activeOverlayElements(...args),
    agent,
    compactText,
    elementBox,
    elementId,
    isVisible,
    normalizeMatchText,
    overlayText: (...args) => overlayText(...args),
    queryAllDeep,
    stableHash,
    surfaceText: (...args) => surfaceText(...args)
  });

  function buttonText(element) {
    return (element?.innerText || element?.textContent || element?.value || element?.getAttribute?.("aria-label") || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  const {
    activeOverlayElements,
    isPersistentEdgeCheckoutChrome,
    surfaceStructurallyBlocksBackground,
    overlayText,
    overlayChoiceText,
    overlayChoiceTarget,
    overlayButtons,
    surfaceActionElements,
    surfaceMembershipForElement,
    isTransientChoiceOverlay,
    overlaySignature,
    waitForOverlayProgress,
    isDangerousActionLabel,
    isSafeContinueLabel,
    isSkipChoiceLabel,
    actionRisk,
    overlayOptionSemantic,
    overlayOptionRisk,
    declineChoiceIntent,
    isStageExitDecision,
    currentSurfaceEntries,
    inferSurfaceParentDecisionContext,
    classifySurfaceSemantics,
    buildActiveSurface,
    surfaceText,
    surfaceLooksLikeSeatSkip,
    buildSurfaceStack
  } = createForegroundSurfaceCompiler({
    accessibilityNode,
    actionElementLabel,
    agent,
    boundHighCardinalityActionElements,
    boundedSurfaceEvidenceOptions,
    buttonText,
    choiceLabel,
    classifyStep,
    clickableAncestor,
    compactText,
    controlOwnedEvidence,
    controlText,
    decisionGroupIdForContext,
    elementBelongsToSectionBand,
    elementBox,
    elementById,
    elementId,
    foregroundSurfaceState,
    implicitRole,
    isChoiceSelected,
    isDisabledLike,
    isInViewport,
    isVisible,
    labelText,
    liveSectionModels,
    meaningfulActionBox,
    normalizeMatchText,
    overlayTopHitCount,
    overlayVisualScore,
    pointBelongsToElement,
    primaryPageText,
    queryAllDeep,
    resolveOwnedControlMeaning,
    stableHash,
    waitForPaint
  });

  function verificationFromSurfaceFeedback(expected = {}, beforeMap = {}, target = null, {
    beforeOverlaySignature = "",
    progress = null
  } = {}) {
    if (expected.mustNotIncreasePrice === true) return null;
    const allowed = new Set([
      "options_surface_appeared",
      "active_surface_dismissed",
      "active_surface_change",
      "observable_change"
    ]);
    if (!allowed.has(String(expected.type || ""))) return null;

    const afterOverlay = activeOverlayElements()[0] || null;
    const afterOverlaySignature = afterOverlay ? overlaySignature(afterOverlay) : "";
    const overlayAppeared = Boolean(
      afterOverlaySignature
      && (!beforeOverlaySignature || afterOverlaySignature !== beforeOverlaySignature)
    );
    const overlayDismissed = Boolean(beforeOverlaySignature && !afterOverlaySignature);
    const overlayChanged = Boolean(
      beforeOverlaySignature
      && afterOverlaySignature
      && beforeOverlaySignature !== afterOverlaySignature
    );
    const urlChanged = Boolean(expected.beforeUrl && location.href !== expected.beforeUrl);

    let ok = false;
    if (expected.type === "options_surface_appeared") ok = overlayAppeared;
    else if (expected.type === "active_surface_dismissed") ok = overlayDismissed || progress?.ok === true;
    else if (expected.type === "active_surface_change") ok = overlayChanged || overlayDismissed || progress?.ok === true;
    else if (expected.type === "observable_change") ok = overlayAppeared || overlayChanged || overlayDismissed || urlChanged;
    if (!ok) return null;

    return {
      ok: true,
      code: "MECHANICAL_SURFACE_FEEDBACK_VERIFIED",
      message: "The governed action produced its bounded local surface transition.",
      evidence: {
        source: "live_mechanical_feedback",
        expectedType: expected.type,
        beforeObservationHash: observationHashForMap(beforeMap),
        afterObservationHash: "pending_fresh_observation",
        beforeOverlaySignature: stableHash(beforeOverlaySignature),
        afterOverlaySignature: stableHash(afterOverlaySignature),
        overlayAppeared,
        overlayDismissed,
        overlayChanged,
        urlChanged,
        progress: progress || null,
        targetConnected: Boolean(target?.isConnected)
      },
      feedback: {
        dispatched: true,
        targetFound: Boolean(target),
        targetVisible: Boolean(target && isVisible(target)),
        dispatchSucceeded: true,
        targetReacted: true,
        surfaceChanged: overlayAppeared || overlayDismissed || overlayChanged,
        overlayAppeared,
        navigationOccurred: urlChanged,
        validationAppeared: false,
        priceChanged: false,
        pageChanged: true,
        expectedOutcomeObserved: true,
        postconditionSatisfied: true
      }
    };
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

    // The deepest repeated owner is the collection boundary. Choosing the
    // largest ancestor first can absorb dialog footer controls into a seat
    // inventory and then hide the exact Continue/Back actuators we must keep.
    const selected = [];
    const claimed = new Set();
    candidates
      .sort((left, right) => right.depth - left.depth || right.members.length - left.members.length)
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

  function boundHighCardinalityActionElements(elements = [], descriptors = [], options = {}) {
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
      surfaceId: options.surfaceId || "surface-page",
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

  function beginObservationCompilation() {
    activeObservationElementRegistry = createObservationElementRegistry();
    activeObservationControlRegistry = null;
  }

  function currentObservationCompilation() {
    return {
      elementRegistry: activeObservationElementRegistry,
      controlRegistry: activeObservationControlRegistry
    };
  }

  ({ buildPageMap } = createPageMapCompiler({
    accessibilityNode,
    accessibilitySnapshot,
    actionElementLabel,
    actionRisk,
    activeOverlayElements,
    agentContract: AGENT_CONTRACT,
    beginObservationCompilation,
    boundHighCardinalityActionElements,
    buildActiveSurface,
    buildAuthoritativeStageExit,
    buildCanonicalControlGraph,
    buildCanonicalDecisionGroups,
    buildSectionModels,
    buildSurfaceStack,
    buildTaskQueue,
    candidateInputs,
    classifyStep,
    clickableAncestor,
    collectPaidChoices,
    collectValidationIssues,
    compactText,
    controlMemberNodeIds,
    currentObservationCompilation,
    dateFieldEvidenceForElement,
    describedText,
    detectCheckoutSections,
    detectField,
    discoverStructuralActionCollections,
    elementBox,
    elementId,
    fieldValue,
    foregroundSurfaceState,
    implicitRole,
    inferCheckoutSite,
    isAuxiliaryNavigationAction,
    isPaymentField,
    isPlaceholderChoiceValue,
    isVisible,
    labelElementForInput,
    labelText,
    logFlow,
    meaningfulActionBox,
    observeTerminalStructure,
    observedLocale,
    pageCoverage,
    pageReadinessFacts,
    priceFromText,
    primaryPageText,
    profileFieldGroupEvidence,
    queryAllDeep,
    semanticChoiceType,
    syncRequiredProfileChoiceGroups,
    transactionFactsEvidence,
    visibleOverlays,
    visiblePageText,
    visualPageState
  }));
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

  pageStateStore = createPageStateStore({
    buildPageMap,
    rememberPagePlan,
    observationHashForMap,
    emptyPageStateDiff,
    canonicalPageStateDiff,
    pageStateDiffIsMaterial,
    mutationMayBeMaterial,
    mutationOwnedControlId,
    elementById,
    canonicalControlForElement,
    syncIncrementalControlModels,
    syncRequiredProfileChoiceGroups,
    buildCanonicalDecisionGroups,
    buildAuthoritativeStageExit,
    logFlow,
    sleep,
    onMaterialMutation: (timestamp) => {
      agent.lastPageMutationAt = timestamp;
    }
  });

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

  const AGENT_OWNED_SELECTOR = "#atw-sidebar, #atw-agent-cursor, #atw-screenshot-annotations, .atw-section-outline";

  function isAgentOwnedElement(element) {
    return Boolean(element?.closest?.(AGENT_OWNED_SELECTOR));
  }

  function agentOwnedInteractionRoots() {
    return [...new Set([
      document.getElementById("atw-sidebar"),
      document.getElementById("atw-agent-cursor"),
      document.getElementById("atw-screenshot-annotations"),
      ...document.querySelectorAll(".atw-section-outline")
    ].filter(Boolean))];
  }

  async function withAgentUiPointerPassthrough(callback) {
    const previous = agentOwnedInteractionRoots().map((element) => ({
      element,
      pointerEvents: element.style.getPropertyValue("pointer-events"),
      pointerEventsPriority: element.style.getPropertyPriority("pointer-events"),
      userSelect: element.style.getPropertyValue("user-select"),
      userSelectPriority: element.style.getPropertyPriority("user-select")
    }));
    for (const { element } of previous) {
      element.style.setProperty("pointer-events", "none", "important");
      element.style.setProperty("user-select", "none", "important");
    }
    try {
      // Inline style mutation is synchronous. Force style resolution without
      // requestAnimationFrame: background tabs may throttle rAF indefinitely,
      // but trusted dispatch must behave identically when Fly is not focused.
      document.documentElement.getBoundingClientRect();
      return await callback();
    } finally {
      for (const {
        element,
        pointerEvents,
        pointerEventsPriority,
        userSelect,
        userSelectPriority
      } of previous) {
        if (!element?.isConnected) continue;
        if (pointerEvents) element.style.setProperty("pointer-events", pointerEvents, pointerEventsPriority);
        else element.style.removeProperty("pointer-events");
        if (userSelect) element.style.setProperty("user-select", userSelect, userSelectPriority);
        else element.style.removeProperty("user-select");
      }
    }
  }

  function clickPointEvidence(element) {
    const rect = element.getBoundingClientRect();
    const x = Math.min(window.innerWidth - 2, Math.max(2, rect.left + rect.width / 2));
    const y = Math.min(window.innerHeight - 2, Math.max(2, rect.top + rect.height / 2));
    const stack = typeof document.elementsFromPoint === "function"
      ? document.elementsFromPoint(x, y)
      : [document.elementFromPoint(x, y)].filter(Boolean);
    const top = stack[0] || null;
    const underlying = stack.find((candidate) => !isAgentOwnedElement(candidate)) || null;
    const directlyClear = Boolean(top && (top === element || element.contains(top) || top.contains(element)));
    const underlyingClear = Boolean(
      underlying
      && (underlying === element || element.contains(underlying) || underlying.contains(element))
    );
    const selfOccluded = Boolean(!directlyClear && isAgentOwnedElement(top) && underlyingClear);
    const clear = directlyClear || selfOccluded;
    const topRect = top?.getBoundingClientRect?.() || null;
    const underlyingRect = underlying?.getBoundingClientRect?.() || null;
    return {
      clear,
      directlyClear,
      selfOccluded,
      point: { x: Math.round(x), y: Math.round(y) },
      target: {
        tag: String(element?.tagName || "").toLowerCase(),
        id: String(element?.id || ""),
        rect: {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }
      },
      topElement: top ? {
        tag: String(top.tagName || "").toLowerCase(),
        id: String(top.id || ""),
        role: String(top.getAttribute?.("role") || ""),
        ariaLabel: String(top.getAttribute?.("aria-label") || "").slice(0, 120),
        agentOwned: isAgentOwnedElement(top),
        rect: topRect ? {
          x: Math.round(topRect.left),
          y: Math.round(topRect.top),
          width: Math.round(topRect.width),
          height: Math.round(topRect.height)
        } : null
      } : null,
      underlyingElement: underlying ? {
        tag: String(underlying.tagName || "").toLowerCase(),
        id: String(underlying.id || ""),
        role: String(underlying.getAttribute?.("role") || ""),
        ariaLabel: String(underlying.getAttribute?.("aria-label") || "").slice(0, 120),
        agentOwned: isAgentOwnedElement(underlying),
        rect: underlyingRect ? {
          x: Math.round(underlyingRect.left),
          y: Math.round(underlyingRect.top),
          width: Math.round(underlyingRect.width),
          height: Math.round(underlyingRect.height)
        } : null
      } : null
    };
  }

  function clickPointIsClear(element) {
    return clickPointEvidence(element).clear;
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
    const hitTest = enabled && inViewport ? clickPointEvidence(element) : null;
    const hitTested = Boolean(hitTest?.clear);
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
      visualRegion: box ? normalizeVisualRegionContract(box, {
        operation,
        source: "exact-actuator-actionability",
        surfaceId: surface.id || ""
      }) : null,
      rendered,
      visible,
      enabled,
      inViewport,
      inCurrentSurface,
      hitTested,
      notOccluded,
      selfOccluded: hitTest?.selfOccluded === true,
      targetable,
      operationAuthorized,
      operationProven: operationProven === true,
      operationProof: String(operationProof || ""),
      executable,
      revealable,
      code,
      hitTestEvidence: hitTest && (!hitTest.clear || hitTest.selfOccluded) ? hitTest : null,
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
      terminalEvidence: map.terminalEvidence || null,
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

  const {
    boundedObservationTransport,
    incrementalObservationTransport,
    normalizedTransportText,
    postObservationWithSizeRecovery,
    referenceObservationTransport,
    seatTransportProfileMode,
    smallerObservationTransport,
    uploadObservationScreenshot
  } = createObservationTransport({
    maxObservationTransportBytes: MAX_OBSERVATION_TRANSPORT_BYTES,
    compactObservationActionContext,
    compactText,
    emptyPageStateDiff,
    observationTransportBytes,
    stableHash,
    uniqueControlIds
  });
  function decisionFromActionLease(rawDecision = {}) {
    const lease = rawDecision.actionLease || null;
    if (lease?.contractVersion !== "action-lease/v1") return rawDecision;
    const operation = String(lease.mechanic?.operation || "");
    const semanticEffect = String(lease.expected?.semanticEffect || "");
    const actionType = String(lease.mechanic?.actionType || rawDecision.action || "stop");
    const interactionRole = ["choose", "select"].includes(operation)
      ? "choice"
      : operation === "open"
        ? "opener"
        : ["type", "select"].includes(actionType)
          ? "field"
          : /advance|navigate/.test(semanticEffect)
            ? "navigation"
            : "command";
    const successCondition = lease.expected?.successCondition || null;
    return {
      ...rawDecision,
      actionId: lease.actionId || rawDecision.actionId || "",
      observationId: lease.observation?.id || "",
      observationHash: lease.observation?.hash || "",
      action: actionType,
      intent: String(lease.expected?.objective || semanticEffect || actionType),
      operation,
      mechanicalEffect: String(lease.mechanic?.effect || operation),
      physicalEffect: String(lease.mechanic?.effect || operation),
      interactionRole,
      semanticEffect,
      expectedEvidence: String(successCondition?.type || ""),
      semanticIntent: semanticEffect,
      expectedPostconditions: successCondition ? [successCondition] : [],
      goalId: lease.obligationId || "",
      semanticOwner: lease.semanticOwner || null,
      semanticOwnerId: lease.semanticOwnerId || "",
      decisionInstanceId: lease.semanticOwner?.repeatedInstance || "",
      candidateId: lease.candidateId || "",
      logicalControlId: lease.target?.controlId || "",
      controlId: lease.target?.controlId || "",
      actuatorId: lease.target?.actuatorId || "",
      targetId: lease.target?.actuatorId || "",
      targetSnapshot: null,
      decisionGroupId: String(
        successCondition?.decisionGroupId
        || successCondition?.parentDecisionGroupId
        || ""
      ),
      expectedOutcome: successCondition,
      affordance: lease.expected?.policyAuthorization ? {
        policy: lease.expected.policyAuthorization
      } : null,
      pipelineContract: lease.capabilityProof || null,
      interactionMethod: lease.mechanic?.method || "",
      boundedRecovery: lease.mechanic?.boundedRecovery === true,
      exactOption: lease.mechanic?.exactOption || null,
      value: lease.mechanic?.value || "",
      keys: lease.mechanic?.keys || "",
      x: lease.mechanic?.x,
      y: lease.mechanic?.y,
      scrollY: lease.mechanic?.scrollY,
      visualRegion: lease.mechanic?.visualRegion || null,
      risk: lease.risk || rawDecision.risk || "uncertain"
    };
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
    const reobserveRetryToken = String(agent.destinationWait?.retryToken || "");
    const retryTokenAvailable = Boolean(
      destinationReadinessRetry
      && reobserveRetryToken
      && !agent.honoredReobserveRetryTokens.has(reobserveRetryToken)
    );
    const unchangedObservation = Boolean(
      agent.lastSentMaterialHash === materialHash
      && agent.lastSentFeedbackKey === feedbackKey
    );
    const referenceRetryAuthorized = Boolean(retryTokenAvailable && unchangedObservation);
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
      && unchangedObservation
      && agent.destinationWait.deadlineObservationSent !== true
      && !referenceRetryAuthorized
    ) {
      logFlow("backend.request.unchanged_readiness_retry_suppressed", {
        materialHash,
        feedbackKey,
        attempts: agent.destinationWait.attempts,
        elapsedMs: Date.now() - agent.destinationWait.startedAt
      });
      setAgentActivity(
        "Waiting for page changes",
        "The checkout state is unchanged. I will resume on a material page mutation or at the readiness deadline."
      );
      renderSidebar("agent");
      return null;
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
      const observationMode = referenceRetryAuthorized
        ? "reference"
        : clientLatency.observation_mode || "full_snapshot";
      const observationPayload = {
        sessionId: agent.sessionId,
        clientTurnId: turnId,
        observationId,
        observationSnapshot,
        observationUpdate: {
          mode: observationMode,
          baseSnapshotHash: referenceRetryAuthorized
            ? materialHash
            : clientLatency.base_snapshot_hash || "",
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
          deadlineObservationSent: agent.destinationWait.deadlineObservationSent,
          retryToken: agent.destinationWait.retryToken || ""
        } : null,
	      approvalState: {
	        skipPaidExtrasApproved: shouldAutoDeclinePaidExtras(),
	        paymentApproved: false
	      },
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
      const decision = decisionFromActionLease(await response.json());
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
      if (referenceRetryAuthorized) {
        agent.honoredReobserveRetryTokens.add(reobserveRetryToken);
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
      const diagnosticTaskState = decision.debug?.taskState || null;
      const processAwareness = decision.debug?.processAwareness
        || diagnosticTaskState?.processAwareness
        || null;
      const transactionReview = decision.debug?.transactionReview
        || diagnosticTaskState?.transactionReview
        || null;
      agent.processDiagnostics = processAwareness || transactionReview ? {
        processAwareness,
        transactionReview,
        updatedAt: Date.now()
      } : agent.processDiagnostics;
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
        semantic_compile_ms: backendLatency.semantic_compile_ms ?? null,
        task_state_ms: backendLatency.task_state_ms ?? null,
        trace_write_ms: backendLatency.trace_write_ms ?? null,
        final_state_persist_ms: backendLatency.final_state_persist_ms ?? null,
        turn_total_ms: backendLatency.turn_total_ms ?? null,
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
        semantic_compile_ms: backendLatency.semantic_compile_ms ?? null,
        task_state_ms: backendLatency.task_state_ms ?? null,
        trace_write_ms: backendLatency.trace_write_ms ?? null,
        final_state_persist_ms: backendLatency.final_state_persist_ms ?? null,
        turn_total_ms: backendLatency.turn_total_ms ?? null,
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
      const backendFailure = ["AGENT_LOOP_FAILED", "BACKEND_INTERNAL_ERROR"].includes(error?.code)
        || /^HTTP_5\d\d$/.test(error?.code || "");
      const oversizedObservation = error?.code === "OBSERVATION_TOO_LARGE";
      const decision = {
        source: "system",
        action: "stop",
        fatalBackendFailure: backendFailure,
        targetId: "",
        value: "",
        message: contextInvalidated
          ? "Chrome invalidated the extension context after reload. Refresh this checkout tab, then start the agent again."
          : oversizedObservation
            ? "The checkout observation remained too large after compact recovery. I stopped instead of retrying indefinitely."
          : backendFailure
            ? `Agent backend error${error.failureCode ? ` (${error.failureCode})` : ""}: ${error.message}. No browser action was dispatched.`
          : `AI agent unavailable: ${error.message}. I stopped because AI-only mode is enabled.`,
        needsApproval: !backendFailure,
        risk: backendFailure ? "system" : "uncertain",
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
    const dispatch = await dispatchGovernedClickMechanic(element, governedDecision, {
      actionId: options.actionId || agent.activeExecutionActionId || "",
      observationId: options.observationId || agent.activeExecutionObservationId || "",
      operation: governedDecision.operation || ""
    });
    if (dispatch?.ok !== true) {
      await rejectMechanicalAction(
        options.actionId || agent.activeExecutionActionId || nextFlowId("act"),
        options.observationId || agent.activeExecutionObservationId || agent.activeObservationId || "",
        governedDecision,
        {
          code: dispatch?.code || "CLICK_DISPATCH_UNAVAILABLE",
          message: "The governed stage-exit strategy was unavailable before dispatch.",
          dispatched: false
        },
        element
      );
      return false;
    }
    pushActionLedger({
      actionId: options.actionId || agent.activeExecutionActionId || nextFlowId("act"),
      observationId: options.observationId || agent.activeExecutionObservationId || agent.activeObservationId || "",
      stage: "dispatched",
      action: governedDecision,
      targetFingerprint: targetFingerprint(element, governedDecision)
    });
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

    if (decision.fatalBackendFailure === true) {
      // A backend exception is neither a user question nor a semantic stop.
      // Preserve the durable transaction and surface the typed failure without
      // writing an ask_user/stop outcome into its verified history.
      agent.running = false;
      agent.awaiting = "";
      renderSidebar("agent");
      return;
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
            code: "DUPLICATE_ACTION_PENDING_OBSERVATION",
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
      // The canonical page surface proves there is no foreground owner, so do
      // not rescan the DOM for an overlay before dispatch. After dispatch, one
      // bounded live probe can prove that a new modal/listbox appeared.
      const beforeOverlay = surfaceWasActive ? activeOverlayElements()[0] : null;
      const beforeOverlaySignature = beforeOverlay ? overlaySignature(beforeOverlay) : "";
      const expectedOutcome = expectedOutcomeForDecision(decision, map, target);
      showAgentCursor(target, button?.label || "clicking");
      flashElement(target);
      rememberChoiceVisualStateBeforeDispatch(target, decision);
      rememberCanonicalSelectionCommitment(target, decision);
      const clickDispatch = await dispatchGovernedClickMechanic(target, decision, {
        actionId,
        observationId: actionObservationId,
        operation: decision.operation || ""
      });
      if (clickDispatch?.ok !== true) {
        await rejectMechanicalAction(actionId, actionObservationId, decision, {
          code: clickDispatch?.code || "CLICK_DISPATCH_UNAVAILABLE",
          message: "The governed click mechanic was unavailable before dispatch.",
          dispatched: false
        }, target);
        return;
      }
      let choiceCommitResult = clickDispatch.choiceCommitResult || null;
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
        const verification = verificationFromSurfaceFeedback(
          expectedOutcome,
          map,
          target,
          { beforeOverlaySignature, progress }
        ) || verifyExpectedOutcome(
          expectedOutcome,
          map,
          (await observePageStateAfterMutation("verify_foreground_action", 650)).map,
          target
        );
        const verifiedResult = withChoiceCommitEvidence(
          withOverlayProgressEvidence(verification, progress),
          choiceCommitResult,
          expectedOutcome,
          decision
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
      const mechanicalVerification = verificationFromSurfaceFeedback(
        expectedOutcome,
        map,
        target,
        { beforeOverlaySignature }
      );
      let afterMap = map;
      let verification = mechanicalVerification;
      if (!verification) {
        afterMap = (await observePageStateAfterMutation("verify_click", 750)).map;
        verification = verifyExpectedOutcome(expectedOutcome, map, afterMap, target);
      }
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
      const verifiedResult = withChoiceCommitEvidence(
        verification,
        choiceCommitResult,
        expectedOutcome,
        decision
      );
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
        resolveLiveElement,
        // The governed action lifecycle below emits the one authoritative
        // result. The low-level setter must not independently POST a second
        // anonymous field-fill result for the same operation.
        reportResult: false
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
    agent.processDiagnostics = null;
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
    agent.processDiagnostics = null;
    resetFieldProgress();
    setAgentActivity("Starting checkout agent", travelerRules() || "Using saved traveler profile");
    agent.pageMap = pageStateStore.observe({ forceFull: true, reason: "agent_start" }).map;
    const session = await startAgentSession();
    if (!session || !agent.sessionId) {
      agent.running = false;
      agent.awaiting = "manual";
      await clearResumeMarker();
      addAgentMessage(
        "assistant",
        ["SELECTED_BOOKING_REQUIRED", "SELECTED_TRAVELER_REQUIRED"].includes(agent.sessionStartFailure?.code)
          ? agent.sessionStartFailure.message
          : `I could not establish one durable checkout session, so I stopped before planning or changing the page.${agent.sessionStartFailure?.message ? ` ${agent.sessionStartFailure.message}` : ""}`
      );
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
    agent.processDiagnostics = null;
    resetFieldProgress();
    setAgentActivity("Continuing checkout agent after page change", travelerRules() || "Using saved traveler profile");
    // A newly loaded checkout document is still hydrating when the content
    // script starts. Building the entire page map immediately and then again
    // after the old 650 ms delay caused two multi-second DOM scans on large
    // airline pages. Let initial framework work land first, then create one
    // atomic fresh observation which the first planning turn can reuse.
    await sleep(650);
    const resumedObservation = await pageStateStore.observeFresh({
      reason: "navigation_resume",
      maxWaitMs: 650,
      maxAttempts: 2,
      postBuildGraceMs: 100
    });
    agent.pageMap = rememberPagePlan(resumedObservation.map);
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
        const remaining = Math.max(0, agent.destinationWait.deadlineAt - Date.now());
        const materialWakePending = agent.destinationWait.wakeRequested === true
          && agent.destinationWait.lastWakeReason === "dom_mutation";
        // A material MutationObserver event may wake earlier. Otherwise send
        // exactly one deadline observation instead of polling every interval.
        scheduleDestinationObservation(
          materialWakePending ? "dom_mutation" : "readiness_deadline",
          materialWakePending ? DESTINATION_MUTATION_SETTLE_MS : remaining
        );
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

  function diagnosticRoute(facts = {}) {
    return (facts.itinerary?.segments || [])
      .map((segment) => `${segment.origin || "?"} → ${segment.destination || "?"}`)
      .filter(Boolean)
      .join(" · ");
  }

  function diagnosticPrice(facts = {}) {
    const amount = facts.totalPrice?.amount;
    const currency = facts.totalPrice?.currency || facts.currency || "";
    return amount == null ? "unknown" : `${amount} ${currency}`.trim();
  }

  function agentProcessDiagnosticsHtml() {
    const diagnostics = agent.processDiagnostics;
    if (!diagnostics) return "";
    const awareness = diagnostics.processAwareness || {};
    const review = diagnostics.transactionReview || {};
    const baseline = review.baseline || {};
    const current = review.reviewFacts || review.current || {};
    const achievements = (awareness.achievements || []).slice(-4).reverse();
    const unresolved = (awareness.unresolved || []).slice(0, 4);
    const contradictions = review.contradictions || [];
    const missing = review.missingFacts || [];
    const route = diagnosticRoute(baseline) || diagnosticRoute(current) || "not established";
    return `
      <details class="atw-process-diagnostics" open>
        <summary>Agent state · testing</summary>
        <div class="atw-process-grid">
          <div><span>Where</span><strong>${escapeHtml(awareness.currentPosition?.stage || agent.pageMap?.step || "observing")}</strong></div>
          <div><span>Status</span><strong>${escapeHtml(awareness.status || (agent.running ? "in progress" : "waiting"))}</strong></div>
          <div class="is-wide"><span>Doing</span><strong>${escapeHtml(awareness.currentObjective || agent.currentAction || "observe and plan the next safe action")}</strong></div>
          <div class="is-wide"><span>Selected booking</span><strong>${escapeHtml(route)} · ${escapeHtml(diagnosticPrice(baseline))} · ${escapeHtml(review.baselineStatus || "collecting")}</strong></div>
          <div class="is-wide"><span>Current/review evidence</span><strong>${escapeHtml(diagnosticPrice(current))}${review.ready === true ? " · verified" : ""}</strong></div>
        </div>
        ${achievements.length ? `<div class="atw-process-list"><span>Done</span>${achievements.map((item) => `<em>✓ ${escapeHtml(item.label || item.kind || item.achievementId)}</em>`).join("")}</div>` : ""}
        ${unresolved.length || missing.length || contradictions.length ? `<div class="atw-process-list is-warn"><span>Still unresolved</span>${[...unresolved, ...missing.map((item) => `transaction: ${item}`), ...contradictions.map((item) => `conflict: ${item}`)].slice(0, 6).map((item) => `<em>${escapeHtml(item)}</em>`).join("")}</div>` : ""}
      </details>
    `;
  }

  function selectedBookingAcquisitionHtml() {
    const acquisition = readSelectedBookingAcquisition();
    const durable = agent.processDiagnostics?.transactionReview?.baseline || null;
    const facts = acquisition?.facts || durable || null;
    const segments = facts?.itinerary?.segments || [];
    const captured = segments.length > 0 && segments.every((segment) => (
      segment.origin && segment.destination && segment.departureDate
    ));
    const route = captured ? diagnosticRoute(facts) : "missing";
    const dates = captured
      ? segments.map((segment) => segment.departureDate).filter(Boolean).join(" · ")
      : "departure date unavailable";
    const source = acquisition
      ? "captured before session"
      : captured
        ? "durable baseline"
        : "not acquired";
    return `<div class="atw-map-line">Selected booking: <strong>${captured ? "captured" : "missing"}</strong> · ${escapeHtml(route)} · ${escapeHtml(dates)} · ${escapeHtml(source)}</div>`;
  }

  // Sidebar is logs-only by design: it starts the agent and shows what it's doing
  // (section checklist, reasoning log). Anything that needs the user's input is
  // asked on the page itself, next to the AI cursor — see cursorPromptHtml().
  function agentChatHtml() {
    const map = agent.pageMap || pageStateStore.observe({ reason: "sidebar_render" }).map;
    return `
      ${agentStatusHtml(map)}
      <div class="atw-map-line">Reading ${map.site}: ${map.step.replace(/_/g, " ")} · ${map.summary.knownFields}/${map.summary.fields} fields · ${map.summary.paidChoices} paid areas</div>
      ${selectedBookingAcquisitionHtml()}
      ${agentProcessDiagnosticsHtml()}
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
      const externalPageMutation = mutations.some((mutation) => {
        const target = mutation.target?.nodeType === Node.ELEMENT_NODE
          ? mutation.target
          : mutation.target?.parentElement;
        return !target?.closest?.("#atw-sidebar, #atw-agent-cursor, .atw-agent-cursor");
      });
      if (pageChanged && externalPageMutation) {
        scheduleSelectedBookingCapture("dom_mutation");
      }
      if (pageChanged && agent.destinationWait?.status === "WAITING_FOR_DESTINATION") {
        scheduleDestinationObservation("dom_mutation", DESTINATION_MUTATION_SETTLE_MS);
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

  window.addEventListener("pagehide", () => {
    if (!agent.running) captureSelectedBookingFromMap(pageStateStore.current());
    saveResumeMarker();
  });
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
      setProcessDiagnosticsForTest: (diagnostics = null) => { agent.processDiagnostics = diagnostics; },
      renderSidebarForTest: (mode = "agent") => renderSidebar(mode),
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
        honoredReobserveRetryTokens: [...agent.honoredReobserveRetryTokens],
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
      narrowerExactControlOwner,
      compactPageMap,
      authoritativeSelectedBookingFacts,
      composeSelectedBookingContract,
      validStoredSelectedBookingContract,
      captureSelectedBookingFromMap,
      readSelectedBookingAcquisition,
      scheduleSelectedBookingCapture,
      startAgentSession,
      compactSurfaceReference,
      observationTransportBytes,
      observationNeedsScreenshot,
      compactActionResultForTransport,
      compactObservationActionContext,
      decisionFromActionLease,
      compactFlowLogPayload,
      boundedObservationTransport,
      boundHighCardinalityActionElements,
      smallerObservationTransport,
      incrementalObservationTransport,
      referenceObservationTransport,
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
      verificationFromSurfaceFeedback,
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
      boundedLocalClickMechanicAllowed,
      dispatchGovernedClickMechanic,
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
    captureSelectedBookingFromMap(pageStateStore.observe({ forceFull: true, reason: "selected_booking_initial" }).map);
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
