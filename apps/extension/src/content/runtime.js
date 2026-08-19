import {
  approvedSelectedBookingAcquisitionFromMap,
  authoritativeSelectedBookingFacts,
  composeSelectedBookingContract,
  validStoredSelectedBookingContract
} from "./selected-booking.js";
import { createAgentRuntimeContext } from "./runtime-context.js";
import { createSelectedBookingAcquisition } from "./selected-booking-acquisition.js";
import { currentNavigationUrl } from "./navigation-identity.js";
import { createActionTransport } from "./observation/action-transport.js";
import { createAccessibilityProjection } from "./observation/accessibility.js";
import {
  buildCanonicalAliasIndex,
  decisionTargetAliasIds
} from "./observation/control-aliases.js";
import { createControlRegistryTools } from "./observation/control-registry.js";
import { createElementRegistry } from "./observation/element-registry.js";
import { createControlGraphCompiler } from "./observation/control-graph.js";
import { createDecisionGroupCompiler } from "./observation/decision-groups.js";
import { implicitRole, isVisible, queryAllDeep, textFromIds } from "./observation/dom.js";
import { createPageStateStore } from "./observation/page-state-store.js";
import { createPageStateSupport } from "./observation/page-state-support.js";
import { createPageMapCompiler } from "./observation/page-map.js";
import { createPageUnderstanding } from "./observation/page-understanding.js";
import { createPerceptionFacade } from "./observation/perception.js";
import { createSectionPerception } from "./observation/sections.js";
import { createStageExitCompiler } from "./observation/stage-exit.js";
import { createTransactionEvidenceCompiler } from "./observation/transaction-evidence.js";
import { createObservationTransport } from "./observation/transport.js";
import { createScreenshotObservation } from "./observation/screenshot.js";
import { createObservationSignatures } from "./observation/signatures.js";
import {
  actionableCheckoutErrors,
  validationLifecycle
} from "./observation/validation.js";
import {
  boundedPhrase,
  normalizedFieldAlias,
  profileFieldTypesFromText
} from "./observation/field-semantics.js";
import { createFieldEvidence } from "./observation/field-evidence.js";
import { createForegroundSurfaceCompiler } from "./observation/foreground-surface.js";
import { createLogicalControlCompiler } from "./observation/logical-controls.js";
import { createTargeting } from "./execution/targeting.js";
import { createInteractionMechanics } from "./execution/interaction.js";
import { createFieldInteraction } from "./execution/field-interaction.js";
import { createExecutionOrchestrator } from "./execution/orchestrator.js";
import { createOutcomeVerification } from "./verification/outcomes.js";
import { createAgentLifecycle } from "./controller/lifecycle.js";
import { createDecisionClient } from "./controller/decision-client.js";
import { createSessionClient } from "./controller/session-client.js";
import { createCheckoutController } from "./controller/checkout-controller.js";
import { createCheckoutWatcher } from "./controller/checkout-watch.js";
import { createTripService } from "./controller/trip-service.js";
import { createSidebarUi } from "./ui/sidebar.js";
import { createFlowDiagnostics } from "./diagnostics/flow.js";
import { createDebugDiagnostics } from "./diagnostics/debug.js";
import {
  currentCommercialOptionPrice,
  localizedPriceAmount,
  normalizedCurrencyToken,
  structuredPriceFromText,
  structuredPricesFromText
} from "./observation/prices.js";

(async function bootAirTravelWallet() {
  if (globalThis.__ATW_RUNTIME_V1__ === true) return;
  globalThis.__ATW_RUNTIME_V1__ = true;

  let explicitStartRequested = false;
  let runtimeReadyForExplicitStart = false;
  let executeExplicitStart = null;
  globalThis.chrome?.runtime?.onMessage?.addListener?.((message, _sender, sendResponse) => {
    if (message?.type !== "ATW_START_AGENT") return false;
    explicitStartRequested = true;
    if (!executeExplicitStart || !runtimeReadyForExplicitStart) {
      sendResponse({ ok: true, status: "queued" });
      return false;
    }
    Promise.resolve(executeExplicitStart())
      .then((started) => sendResponse({
        ok: started !== false,
        status: started === false ? "failed" : "started",
        code: started === false ? String(agent.sessionStartFailure?.code || "SESSION_START_FAILED") : ""
      }))
      .catch((error) => sendResponse({ ok: false, status: "failed", error: error.message }));
    return true;
  });

  const DEFAULT_API = "http://localhost:4173/api";
  const MAX_OBSERVATION_TRANSPORT_BYTES = 5_250_000;
  const ACTION_REPORT_TIMEOUT_MS = 8_000;
  const ACTION_REPORT_MAX_ATTEMPTS = 2;
  const AGENT_SINGLE_BRAIN = true;
  const AGENT_CONTRACT = globalThis.AtwAgentContract || null;
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
    "please enter a valid",
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
  let watchForCheckoutChanges = () => null;
  let stopWatchingCheckoutChanges = () => undefined;
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
  const { owner: agent, scopes: runtimeScopes } = createAgentRuntimeContext(DEFAULT_API);
  let pageStateStore = null;
  let buildPageMap = null;
  let activeObservationControlRegistry = null;
  const {
    normalizeMatchText,
    stableHash,
    elementSignature,
    pageSignature,
    itineraryActionEvidence,
    structuralPageSignature,
    materialObservationSignature,
    observationHashForMap
  } = createObservationSignatures({
    activeOverlayElements: (...args) => activeOverlayElements(...args),
    buildPageMap: (...args) => buildPageMap(...args),
    buttonText: (...args) => buttonText(...args),
    directControlName: (...args) => directControlName(...args),
    elementBox: (...args) => elementBox(...args),
    isVisible,
    overlayText: (...args) => overlayText(...args)
  });
  const elementRegistry = createElementRegistry({
    compactText,
    directControlName: (...args) => directControlName(...args),
    queryAllDeep
  });
  const { elementId, elementById } = elementRegistry;
  const {
    observationTransportBytes,
    compactActionTransportValue,
    compactActionResultForTransport,
    compactObservationActionContext
  } = createActionTransport({
    compactText,
    compactChoiceCommitEvidence: (...args) => compactChoiceCommitEvidence(...args)
  });
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
    isActionableClickTarget: (...args) => isActionableClickTarget(...args),
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

  const SELECTED_BOOKING_DURABLE_PREFIX = "atwSelectedBookingAcquisitionV1";
  let tabContextPromise = null;

  async function tabContextId() {
    if (!tabContextPromise) {
      tabContextPromise = Promise.resolve(chrome.runtime.sendMessage({ type: "ATW_TAB_CONTEXT" }))
        .then((response) => Number.isInteger(response?.tabId) ? String(response.tabId) : "")
        .catch(() => "");
    }
    return tabContextPromise;
  }

  async function selectedBookingDurableKey() {
    const contextId = await tabContextId();
    return contextId ? `${SELECTED_BOOKING_DURABLE_PREFIX}:${contextId}` : "";
  }

  async function readCheckoutContext() {
    try {
      const response = await chrome.runtime.sendMessage({ type: "ATW_CHECKOUT_CONTEXT" });
      return response?.ok === true ? response.context || null : null;
    } catch (error) {
      return null;
    }
  }

  async function readStartupDiagnostics() {
    try {
      const response = await chrome.runtime.sendMessage({ type: "ATW_STARTUP_DIAGNOSTICS" });
      return response?.ok === true && Array.isArray(response.events) ? response.events : [];
    } catch (_error) {
      return [];
    }
  }

  async function beginCheckoutLineage({ rotate = false } = {}) {
    try {
      const response = await chrome.runtime.sendMessage({
        type: "ATW_CHECKOUT_LINEAGE_BEGIN",
        rotate: rotate === true
      });
      return response?.ok === true ? response.context || null : null;
    } catch (error) {
      return null;
    }
  }

  async function readDurableSelectedBookingAcquisition() {
    const key = await selectedBookingDurableKey();
    if (!key) return null;
    const stored = await storageGet(key);
    return stored?.[key] || null;
  }

  async function writeDurableSelectedBookingAcquisition(acquisition = null) {
    const key = await selectedBookingDurableKey();
    if (!key || !acquisition) return false;
    await chrome.storage.local.set({ [key]: acquisition });
    return true;
  }

  async function clearDurableSelectedBookingAcquisition() {
    const key = await selectedBookingDurableKey();
    if (!key) return false;
    await chrome.storage.local.remove(key);
    return true;
  }

  const RESUME_KEY = "atwAgentResume";
  const RESUME_MAX_AGE_MS = 3 * 60 * 1000;
  const DESTINATION_WAIT_TIMEOUT_MS = 20_000;
  const DESTINATION_RETRY_INTERVAL_MS = 300;
  const DESTINATION_MUTATION_SETTLE_MS = 450;
  async function saveResumeMarker() {
    try {
      if (!agent.running || !agent.sessionId) {
        await chrome.storage.local.remove(RESUME_KEY);
        return;
      }
      await chrome.storage.local.set({
        [RESUME_KEY]: {
          tabContextId: await tabContextId(),
          travelerId: selectedTravelerId,
          sessionId: agent.sessionId,
          skipPaidExtrasApproved: agent.skipPaidExtrasApproved,
          navigationUrl: currentNavigationUrl(),
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
      url: currentNavigationUrl()
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

  const {
    compactFlowLogPage,
    compactFlowLogPayload,
    compactFlowLogTarget,
    logFlow,
    pageSnapshot,
    sendActionLedger
  } = createFlowDiagnostics({
    DEFAULT_API,
    actionableCheckoutErrors,
    agent: runtimeScopes.flow,
    buildPageMap: (...args) => buildPageMap(...args),
    compactText,
    foregroundSurfaceState: (...args) => foregroundSurfaceState(...args),
    logAgentEvent,
    observationHashForMap,
    pageSignature,
    visualPageState: (...args) => visualPageState(...args)
  });

  const {
    abortActivePlannerRequest,
    beginAgentLoop,
    beginDestinationWait,
    clearDestinationWait,
    expireDestinationWait,
    finishAgentLoop,
    isDestinationReadinessDecision,
    plannerRequestIsCurrent,
    resetAgentLoopLifecycle,
    scheduleDestinationObservation
  } = createAgentLifecycle({
    DESTINATION_RETRY_INTERVAL_MS,
    DESTINATION_WAIT_TIMEOUT_MS,
    addAgentMessage,
    agent: runtimeScopes.lifecycle,
    logFlow,
    processCheckoutAgent: (...args) => processCheckoutAgent(...args),
    renderSidebar: (...args) => renderSidebar(...args),
    setAgentActivity
  });

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
      url: currentNavigationUrl(),
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
      semanticOwner: decision.semanticOwner || null,
      semanticOwnerId: decision.semanticOwnerId || "",
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
        semanticOwner: decision.semanticOwner || null,
        semanticOwnerId: decision.semanticOwnerId || "",
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
      semanticOwner: decision.semanticOwner || null,
      semanticOwnerId: decision.semanticOwnerId || "",
      decisionInstanceId: decision.decisionInstanceId || "",
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
        reason: decision.reason || "",
        semanticOwner: decision.semanticOwner || null,
        semanticOwnerId: decision.semanticOwnerId || "",
        decisionInstanceId: decision.decisionInstanceId || ""
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

  const { transactionFactsEvidence } = createTransactionEvidenceCompiler({
    AGENT_CONTRACT,
    agent: runtimeScopes.transactionEvidence,
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
    controlText: (...args) => controlText(...args),
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
    controlText: (...args) => controlText(...args),
    currentCommercialOptionPrice,
    currentElementValue: (...args) => currentElementValue(...args),
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
    controlText: (...args) => controlText(...args),
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
    controlText: (...args) => controlText(...args),
    controlsAreCompatibleAliases,
    createObservationControlRegistry,
    currentElementValue: (...args) => currentElementValue(...args),
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
        routePath = new URL(String(evidence.url || currentNavigationUrl()), currentNavigationUrl()).pathname.toLowerCase();
      } catch (error) {
        routePath = String(location.pathname || "").toLowerCase();
      }
    }
    return {
      visibleText: String(evidence.visibleText || evidence.text || ""),
      routePath,
      structuralEvidence: evidence.structuralEvidence || structuralEvidence || {},
      terminalEvidence: evidence.terminalEvidence || null,
      url: String(evidence.url || currentNavigationUrl() || "")
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
    const paymentReviewConfirmPresent = visibleActions.some((element) => (
      /^(?:confirm|review\s+and\s+confirm)$/i.test(actionElementLabel(element).trim())
    ));
    const visibleHeadingLabels = queryAllDeep("h1, h2, h3, legend, [role='heading']")
      .filter((element) => isVisible(element) && !element.closest("#atw-sidebar"))
      .map((element) => String(element.innerText || element.textContent || "").replace(/\s+/g, " ").trim())
      .filter(Boolean);
    const visibleHeadingText = visibleHeadingLabels.join(" ").slice(0, 1200);
    const exactPaymentHeadingPresent = visibleHeadingLabels.some((label) => (
      /^(?:\d+\.\s*)?(?:pay|payment)(?:\s+(?:pay|payment))?$/i.test(label)
    ));
    const activeProgressText = visibleTerminalNodes
      .filter((element) => element.matches("[aria-current='step'], [data-current='true'], [data-active='true']"))
      .map((element) => actionElementLabel(element) || element.textContent || "")
      .join(" ")
      .slice(0, 500);
    const normalized = String(fullText || "").replace(/\s+/g, " ");
    const activePaymentProgress = /\bpayment\b|\bpay\b/i.test(activeProgressText)
      || /\bcurrent\s+step\s+pay\b|(?:^|\s)3\.\s*pay(?:\s+pay)?(?:\s|$)/i.test(normalized);
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
      paymentReviewConfirmPresent,
      legalAcceptancePresent: visibleInputs.some((input) => input.type === "checkbox" && (
        AGENT_CONTRACT?.isLegalAcceptanceText?.(labelText(input))
        || /terms|conditions|privacy|purchase/i.test(labelText(input))
      )),
      reviewSummaryPresent: /\b(?:amount\s+to\s+pay|total)\b/i.test(normalized)
        && /\b(?:departure|return|itinerary|travel\s+details|your\s+(?:order|booking))\b/i.test(normalized),
      paymentHeadingPresent: exactPaymentHeadingPresent
        || /\b(?:payment\s+details|choose\s+payment\s+method|pay\s+securely|overview\s*(?:&|and)\s*payment)\b/i.test(visibleHeadingText),
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
    agent: runtimeScopes.perception,
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
    agent: runtimeScopes.foregroundSurface,
    boundHighCardinalityActionElements,
    boundedSurfaceEvidenceOptions,
    buttonText,
    choiceLabel,
    classifyStep,
    clickableAncestor,
    compactText,
    controlOwnedEvidence,
    controlText: (...args) => controlText(...args),
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
    waitForPaint: (...args) => waitForPaint(...args)
  });

  const {
    boxesCloseEnough,
    currentSurfaceEntryForElement,
    elementDescriptor,
    failedLocalStrategyForDecision,
    isActionableClickTarget,
    isAuthorizedCompletedChoiceSurfaceExit,
    isStrictActionSurfaceType,
    liveTargetSnapshot,
    normalizedElementLabel,
    rememberFailedLocalStrategy,
    resolveDecisionTarget,
    shortNavLabel,
    targetBelongsToCurrentSurface,
    targetFingerprint,
    targetLocalDispatchIdentity,
    validateResolvedTarget,
    validateVisualCoordinateTarget,
    validTargetId
  } = createTargeting({
    AGENT_CONTRACT,
    accessibleName,
    accessibilityState,
    actuatorActionability,
    agent: runtimeScopes.targeting,
    buildCanonicalAliasIndex,
    buildPageMap,
    buttonText,
    choiceRisk,
    clickPointIsClear,
    compactText,
    controlMemberNodeIds,
    currentElementValue: (...args) => currentElementValue(...args),
    currentSurfaceEntries,
    decisionTargetAliasIds,
    elementBox,
    elementById,
    elementId,
    implicitRole,
    isDangerousActionLabel,
    isDisabledLike,
    isPaymentField,
    isVisible,
    labelText,
    liveSectionForElement,
    logFlow,
    lookupControlForElement,
    meaningfulActionBox,
    normalizeMatchText,
    semanticChoiceType,
    stableHash,
    surfaceMembershipForElement,
    visualRegionContractsMatch
  });

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
    elementRegistry.begin();
    activeObservationControlRegistry = null;
  }

  function currentObservationCompilation() {
    return {
      elementRegistry: elementRegistry.current(),
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
    priceFromText: (...args) => priceFromText(...args),
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
  const {
    emptyPageStateDiff,
    canonicalPageStateDiff,
    pageStateDiffIsMaterial,
    mutationOwnedControlId,
    mutationMayBeMaterial,
    syncIncrementalControlModels
  } = createPageStateSupport({ applyControlToModel, compactText });

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
    validationLifecycle,
    actionableCheckoutErrors,
    hasActiveActionAttempt: () => Boolean(agent.activeExecutionActionId),
    logFlow,
    sleep,
    onMaterialMutation: (timestamp) => {
      agent.lastPageMutationAt = timestamp;
    }
  });

  const {
    admitForStart: admitSelectedBookingForStart,
    acquireForStart: acquireSelectedBookingForStart,
    approveVisibleSummary: approveVisibleSelectedBookingSummary,
    armSelectionCapture: armSelectedBookingCapture,
    cancel: cancelSelectedBookingCapture,
    capture: captureSelectedBookingFromMap,
    disarmSelectionCapture: disarmSelectedBookingCapture,
    hydrate: hydrateSelectedBookingAcquisition,
    read: readSelectedBookingAcquisition,
    schedule: scheduleSelectedBookingCapture
  } = createSelectedBookingAcquisition({
    checkoutContextRead: readCheckoutContext,
    checkoutLineageBegin: beginCheckoutLineage,
    durableClear: clearDurableSelectedBookingAcquisition,
    durableRead: readDurableSelectedBookingAcquisition,
    durableWrite: writeDurableSelectedBookingAcquisition,
    isSessionActive: () => Boolean(agent.running || agent.sessionId),
    observationHashForMap,
    pageStateStore
  });

  const {
    copyDebugLog,
    debugSnapshot
  } = createDebugDiagnostics({
    addAgentMessage,
    agent: runtimeScopes.debug,
    buildPageMap,
    getFilledFields: () => filledFields,
    getWarnings: () => warnings,
    renderSidebar: (...args) => renderSidebar(...args),
    traveler
  });

  const {
    reportActionResult,
    startAgentSession
  } = createSessionClient({
    ACTION_REPORT_MAX_ATTEMPTS,
    ACTION_REPORT_TIMEOUT_MS,
    DEFAULT_API,
    actionableCheckoutErrors,
    admitSelectedBookingForStart,
    addAgentMessage,
    agent: runtimeScopes.session,
    compactActionResultForTransport,
    compactPageMap: (...args) => compactPageMap(...args),
    composeSelectedBookingContract,
    logAgentEvent,
    logFlow,
    observationHashForMap,
    pageSnapshot,
    pageStateStore,
    readStartupDiagnostics,
    renderSidebar: (...args) => renderSidebar(...args),
    resetAgentLoopLifecycle,
    setAgentActivity,
    storageGet,
    traveler,
    userIntentText,
    validStoredSelectedBookingContract
  });

  const {
    boundedLocalClickMechanicAllowed,
    choiceEpisodeEvidence,
    clickResolvedViewportTarget,
    clickViewportPoint,
    composedParent,
    dispatchGovernedClickMechanic,
    isEffectiveScrollContainer,
    localMechanicReactionSnapshot,
    nativeElementClick,
    nearestEffectiveScrollContainer,
    pressEscape,
    scrollElementWithinNearestContainer,
    settleTrustedChoiceInteraction,
    transientOverlayOpen,
    trustedBrowserChoice,
    trustedBrowserClick,
    trustedBrowserKey,
    userLikeClick,
    visibleChoiceSurfacesForValue,
    waitForLocalMechanicReaction,
    waitForPaint,
    waitForScrollSettle,
    waitForUiSettle,
    watchClickToFirstMutation
  } = createInteractionMechanics({
    activeOverlayElements,
    choiceInteractionStates,
    elementBox,
    elementById,
    elementDescriptor,
    elementId,
    isStageExitDecision,
    isTransientChoiceOverlay,
    isVisible,
    logFlow,
    normalizeMatchText,
    pageSnapshot,
    pageStateStore,
    pushActionLedger,
    queryAllDeep,
    rememberChoiceActuatorBinding,
    resolveDecisionTarget,
    setAgentActivity,
    sleep,
    updateChoiceInteractionState,
    validateResolvedTarget,
    withAgentUiPointerPassthrough
  });

  const {
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
  } = createFieldInteraction({
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
  });

  const {
    compactChoiceCommitEvidence,
    currentOwnedValidationErrors,
    exactChildChoiceSettlementEvidence,
    expectedOutcomeForDecision,
    stageExitBlockers,
    transitionFeedbackForMaps,
    verifyExpectedOutcome,
    verifyExpectedOutcomeInternal,
    withChoiceCommitEvidence,
    withOverlayProgressEvidence
  } = createOutcomeVerification({
    AGENT_CONTRACT,
    actionableCheckoutErrors,
    boundedPhrase,
    buildPageMap,
    buttonText,
    canonicalProfileFieldType,
    canonicalSelectionCommitments,
    compactText,
    currentElementValue,
    declineChoiceIntent,
    elementById,
    elementId,
    isStageExitDecision,
    isVisible,
    labelText,
    liveSectionForElement,
    logFlow,
    lookupControlForElement,
    normalizeMatchText,
    normalizedFieldAlias,
    normalizedProfileChoiceValue,
    observationHashForMap,
    pageSignature,
    structuralPageSignature,
    unfilledRequiredFields,
    visualPageState
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
      const issueText = compactText(element.innerText || element.textContent || "", 240).toLowerCase();
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
      if (!nearestField && !logicalGroupOwned) {
        const ownershipRoot = semanticSectionElement || containingSection?.element || surfaceElement || document.body;
        const invalidFields = fields.filter((field) => {
          const input = field.element;
          if (!input || !ownershipRoot?.contains?.(input) || !isVisible(input)) return false;
          const invalid = input.getAttribute?.("aria-invalid") === "true"
            || (typeof input.matches === "function" && input.matches(":invalid"));
          if (!invalid) return false;
          if (/phone|mobile|telephone/.test(issueText)) {
            return ["phone", "phone_country_code", "emergency_contact_phone"].includes(field.field || field.fieldType || "");
          }
          if (/e-?mail/.test(issueText)) {
            return ["email", "confirm_email"].includes(field.field || field.fieldType || "");
          }
          return true;
        });
        if (invalidFields.length === 1) nearestField = invalidFields[0];
      }
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
      const referencedByOwner = Boolean(element?.id && fields.some((field) => (
        `${field.element?.getAttribute?.("aria-errormessage") || ""} ${field.element?.getAttribute?.("aria-describedby") || ""}`
          .split(/\s+/)
          .includes(element.id)
      )));
      const ownedControlId = explicitOwner.controlId || owner.controlId || "";
      const ownedState = ownedControlId
        ? controls.find((control) => control.controlId === ownedControlId)?.state || {}
        : {};
      const invalidControlIds = ownedControlId && (
        ownedState.invalid === true
        || fields.some((field) => field.controlId === ownedControlId && (
          field.element?.getAttribute?.("aria-invalid") === "true"
          || field.element?.matches?.(":invalid")
        ))
      ) ? [ownedControlId] : [];
      const lifecycle = validationLifecycle({
        message: normalizedMessage,
        visible: element ? isVisible(element) : true,
        controlId: ownedControlId,
        invalidControlIds,
        ownerReferenced: referencedByOwner,
        stageWide: explicitOwner.stageWide === true || owner.stageWide === true,
        active: Boolean(invalidControlIds.length || referencedByOwner || explicitOwner.active === true)
      });
      const issue = {
        issueId: element ? `validation:${elementId(element)}` : `validation:${explicitOwner.controlId || explicitOwner.semanticType || issues.length}`,
        message: normalizedMessage,
        status: lifecycle.status,
        visible: lifecycle.visible,
        active: lifecycle.active,
        errorCount: lifecycle.errorCount,
        introducedAfterAction: lifecycle.introducedAfterAction,
        invalidControlIds: lifecycle.invalidControlIds,
        controlId: lifecycle.controlId,
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
      if (VALIDATION_TERMS.some((term) => normalized.includes(term)) && /must enter|too long|too short|invalid|not valid|please enter a valid|error|you must|required.+field|field.+required/.test(normalized)) {
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
      url: currentNavigationUrl(),
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

  const {
    captureVisibleScreenshot,
    clearScreenshotAnnotationOverlay,
    observationNeedsScreenshot,
    prepareScreenshotAnnotations,
    renderScreenshotAnnotationOverlay
  } = createScreenshotObservation({
    agent: runtimeScopes.screenshot,
    compactText,
    controlMemberNodeIds,
    elementBox,
    elementById,
    isVisible,
    logAgentEvent,
    meaningfulActionBox,
    normalizeMatchText,
    normalizeVisualRegionContract,
    unionBoxes,
    waitForPaint
  });

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
  const {
    decisionFromActionLease,
    requestAgentDecision
  } = createDecisionClient({
    DEFAULT_API,
    agent: runtimeScopes.decision,
    captureVisibleScreenshot,
    clearDestinationWait,
    compactActionResultForTransport,
    compactPageMap,
    compactText,
    emptyPageStateDiff,
    isDestinationReadinessDecision,
    logAgentEvent,
    logFlow,
    mapObservationSnapshot,
    nextFlowId,
    observationHashForMap,
    observationNeedsScreenshot,
    pageSnapshot,
    plannerRequestIsCurrent,
    postObservationWithSizeRecovery,
    prepareScreenshotAnnotations,
    renderSidebar: (...args) => renderSidebar(...args),
    setAgentActivity,
    shouldAutoDeclinePaidExtras,
    stableHash,
    storageGet,
    traveler,
    uploadObservationScreenshot,
    userIntentText
  });
  const {
    clickAndVerifyAdvance,
    continueAfterAction,
    exactChoiceCommitReadiness,
    executeAgentDecision,
    finalizeGovernedAction,
    holdDispatchedStageExit,
    pushVerificationLedger,
    repeatGuardFor,
    settleExactChoiceOutcome,
    verificationFromSurfaceFeedback,
    visibleValidationElement
  } = createExecutionOrchestrator({
    AGENT_CONTRACT,
    activeOverlayElements,
    addAgentMessage,
    agent: runtimeScopes.execution,
    beginDestinationWait,
    buildPageMap,
    buttonText,
    clearExecutionContext,
    clickResolvedViewportTarget,
    clickableAncestor,
    currentSurfaceEntryForElement,
    dispatchGovernedClickMechanic,
    dispatchKey,
    elementById,
    elementId,
    elementSignature,
    expectedOutcomeForDecision,
    failedLocalStrategyForDecision,
    flashElement,
    guardedHelperAllowed,
    inferCheckoutSite,
    isChoiceSelected,
    isDangerousActionLabel,
    isDestinationReadinessDecision,
    isPaymentField,
    isVisible,
    labelText,
    logAgentEvent,
    logFlow,
    mapObservationSnapshot,
    nextFlowId,
    observationChangedSince,
    observationHashForMap,
    observePageStateAfterMutation,
    overlaySignature,
    pageSnapshot,
    pageStateStore,
    persistControlFlowDecision,
    processCheckoutAgent: (...args) => processCheckoutAgent(...args),
    pushActionLedger,
    queryAllDeep,
    recordAction,
    rejectMechanicalAction,
    rememberActionExecutionResult,
    rememberCanonicalSelectionCommitment,
    rememberChoiceVisualStateBeforeDispatch,
    rememberExactChoiceCommitment,
    rememberUnexecutedActionResult,
    renderSidebar: (...args) => renderSidebar(...args),
    reportActionResult,
    resolveDecisionTarget,
    scrollElementWithinNearestContainer,
    setAgentActivity,
    setFieldValue,
    settleTrustedChoiceInteraction,
    showAgentCursor,
    showAgentThought,
    sleep,
    stableHash,
    targetFingerprint,
    targetLocalDispatchIdentity,
    traveler,
    validateResolvedTarget,
    validateVisualCoordinateTarget,
    verifyAgentStep,
    verifyExpectedOutcome,
    waitForOverlayProgress,
    waitForScrollSettle,
    waitForUiSettle,
    withChoiceCommitEvidence,
    withOverlayProgressEvidence
  });

  const {
    runRiskChecks,
    saveTrip
  } = createTripService({
    defaultApi: DEFAULT_API,
    getAppData: () => appData,
    renderSaved: () => renderSidebar("saved"),
    setAppData: (value) => { appData = value; },
    storageGet,
    traveler
  });

  const {
    buildPageUnderstanding,
    buildProposedNextActions,
    buildReasoningSummary,
    extractPageOptions,
    fieldEvidence,
    maskFieldPreview,
    priceFromText,
    sectionEvidence
  } = createPageUnderstanding({
    classifyStepDetailed,
    runRiskChecks,
    structuredPriceFromText
  });

  const {
    handleAgentChoice,
    handleChatSubmit,
    observePageOnly,
    processCheckoutAgent,
    resumeCheckoutAfterNavigation,
    setObserverTab,
    takeOverCheckout
  } = createCheckoutController({
    DESTINATION_MUTATION_SETTLE_MS,
    addAgentMessage,
    agent: runtimeScopes.checkout,
    announceSectionQueue,
    beginAgentLoop,
    buildPageUnderstanding,
    clearResumeMarker,
    describePageMap,
    executeAgentDecision,
    finishAgentLoop,
    logAgentEvent,
    logFlow,
    outlineCoreSections,
    pageStateStore,
    persistControlFlowDecision,
    rememberPagePlan,
    renderSidebar: (...args) => renderSidebar(...args),
    requestAgentDecision,
    resetAgentLoopLifecycle,
    resetFieldProgress,
    runRiskChecks,
    saveResumeMarker,
    scheduleDestinationObservation,
    setAgentActivity,
    setWarnings: (nextWarnings) => {
      warnings = nextWarnings;
    },
    shouldAutoDeclinePaidExtras,
    showAgentThought,
    sleep,
    startWatchingCheckoutChanges: () => watchForCheckoutChanges(),
    startAgentSession,
    stopWatchingCheckoutChanges: () => stopWatchingCheckoutChanges(),
    travelerRules
  });
  executeExplicitStart = async () => {
    if (!runtimeReadyForExplicitStart) {
      explicitStartRequested = true;
      return null;
    }
    if (agent.running || agent.loopBusy) return true;
    return takeOverCheckout();
  };

  const {
    agentDecisionHtml,
    agentProcessDiagnosticsHtml,
    agentStatusHtml,
    escapeHtml,
    renderCursorPrompt,
    renderSidebar,
    selectedBookingAcquisitionHtml,
    warningHtml
  } = createSidebarUi({
    agent: runtimeScopes.sidebar,
    bookingDetected,
    copyDebugLog,
    getAppData: () => appData,
    getFilledFields: () => filledFields,
    getWarnings: () => warnings,
    handleAgentChoice,
    handleChatSubmit,
    inferCheckoutSite,
    observePageOnly,
    pageStateStore,
    readSelectedBookingAcquisition,
    routeSummary,
    runRiskChecks,
    saveTrip,
    setObserverTab,
    setSelectedTravelerId: (travelerId) => {
      selectedTravelerId = travelerId;
    },
    setUserGoal: (value) => {
      agent.userGoal = String(value || "");
    },
    setWarnings: (nextWarnings) => {
      warnings = nextWarnings;
    },
    takeOverCheckout,
    traveler,
    travelerRules
  });

  ({ watch: watchForCheckoutChanges, stop: stopWatchingCheckoutChanges } = createCheckoutWatcher({
    destinationMutationSettleMs: DESTINATION_MUTATION_SETTLE_MS,
    getDestinationWait: () => agent.destinationWait,
    hasFilledFields: () => Boolean(filledFields.length),
    pageStateStore,
    refreshSidebarWarnings: () => {
      warnings = runRiskChecks();
      renderSidebar();
    },
    scheduleDestinationObservation
  }));

  window.addEventListener("pagehide", () => {
    stopWatchingCheckoutChanges();
    cancelSelectedBookingCapture();
    disarmSelectedBookingCapture();
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
      setActiveExecutionForTest: (actionId = "", observationId = "") => {
        agent.activeExecutionActionId = String(actionId || "");
        agent.activeExecutionObservationId = String(observationId || "");
      },
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
      approvedSelectedBookingAcquisitionFromMap,
      admitSelectedBookingForStart,
      composeSelectedBookingContract,
      validStoredSelectedBookingContract,
      captureSelectedBookingFromMap,
      approveVisibleSelectedBookingSummary,
      armSelectedBookingCapture,
      acquireSelectedBookingForStart,
      disarmSelectedBookingCapture,
      hydrateSelectedBookingAcquisition,
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
      holdDispatchedStageExit,
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
    if (window.__ATW_TEST_BOOT__ !== true) return;
  }

  try {
    await fetchData();
    await hydrateSelectedBookingAcquisition();
    armSelectedBookingCapture();
    runtimeReadyForExplicitStart = true;
    warnings = [];
    const resumeMarker = await readResumeMarker();
    const currentTabContextId = await tabContextId();
    const resumeIsFresh = Boolean(resumeMarker)
      && Boolean(currentTabContextId)
      && resumeMarker.tabContextId === currentTabContextId
      && (Date.now() - (resumeMarker.savedAt || 0) < RESUME_MAX_AGE_MS);
    if (resumeIsFresh && resumeMarker.travelerId) {
      selectedTravelerId = resumeMarker.travelerId;
      resumeCheckoutAfterNavigation(resumeMarker);
    } else {
      if (resumeMarker) await clearResumeMarker();
      renderSidebar();
    }
    if (explicitStartRequested && !agent.running) await executeExplicitStart();
  } catch (error) {
    const root = document.createElement("aside");
    root.id = "atw-sidebar";
    root.innerHTML = `<div class="atw-panel"><h2>Air Travel Wallet</h2><p class="atw-muted">${error.message}</p></div>`;
    document.body.appendChild(root);
  }
})();
