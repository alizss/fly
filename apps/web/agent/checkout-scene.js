const crypto = require("node:crypto");
const agentContract = require("../../extension/src/shared/agent-contract");
const { decideStage } = require("./task-state/stage");
const { paymentReviewBoundaryEvidence } = require("./task-state/terminal");
const {
  classifyAttestation,
  mandateCoversAttestation,
  normalizeCheckoutMandate
} = require("../../../packages/shared/checkout-mandate");

const CHECKOUT_SCENE_VERSION = "checkout-scene/v1";
const SCENE_ITEM_VERSION = "scene-item/v1";
const SCENE_PATCH_VERSION = "scene-patch/v1";
const COMPILER_VERSION = "checkout-scene-compiler/v1";

const CLOSED_FACT_SOURCES = new Set([
  "SelectedBooking",
  "TravelerProfile",
  "UserPolicy",
  "ObservedControl",
  "DerivedFact",
  "ApprovedAuthorization",
  "CheckoutMandate",
  ""
]);

function clean(value = "", limit = 500) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function lower(value = "") {
  return clean(value, 2_000).toLowerCase();
}

function stableDigest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function unique(values = []) {
  return [...new Set(values.map((value) => clean(value, 180)).filter(Boolean))];
}

function controlExecutable(control = {}) {
  if (control.disabled === true || control.logicalDisabled === true || control.state?.disabled === true) return false;
  return Object.values(control.operations || {}).some((capability) => {
    if (!capability) return false;
    if (capability.actionability?.executable === true) return true;
    return (capability.strategies || []).some((strategy) => (
      strategy?.proof?.executable === true || strategy?.actionability?.executable === true
    ));
  });
}

function controlActuator(control = {}) {
  for (const [operation, capability] of Object.entries(control.operations || {})) {
    if (!capability) continue;
    const strategy = (capability.strategies || []).find((item) => (
      item?.proof?.executable === true || item?.actionability?.executable === true
    ));
    if (strategy) return { operation, actuatorId: strategy.actuatorId || capability.actuatorId || "", method: strategy.method || "" };
    if (capability.actionability?.executable === true) {
      return { operation, actuatorId: capability.actuatorId || capability.actuatorIds?.[0] || "", method: "" };
    }
  }
  return null;
}

function isChoiceControl(control = {}) {
  return /radio|checkbox|option|select|combobox|listbox/.test(lower(`${control.kind || ""} ${control.role || ""} ${control.domRole || ""}`));
}

function localControlText(control = {}) {
  return lower([
    control.label,
    control.accessibleName,
    control.name,
    control.ownedEvidence?.ownText,
    control.ownedEvidence?.ariaLabel,
    control.ownedEvidence?.title
  ].join(" "));
}

function exactProgressionControl(control = {}) {
  if (!control?.controlId || isChoiceControl(control)) return false;
  const stableMeaning = lower(control.stableKey || "").match(/(?:^|\|)meaning:([^|]+)/)?.[1] || "";
  const localText = localControlText(control);
  const text = lower(`${localText} ${stableMeaning}`);
  if (/\b(?:log\s*in|login|sign\s*in|register|create account)\b/.test(text)) return false;
  // Accessibility jump links such as "Skip to main content" or framework
  // identities such as "skip-to-alpi-page" move focus within the current
  // document; they do not advance checkout.  Treating their stable identity
  // as a semantic Skip action makes a real Continue button look ambiguous.
  const accessibilityJump = /^(?:skip\s+to\b|skip-to-)/.test(localText)
    || /^(?:skip\s+to\b|skip-to-)/.test(stableMeaning);
  if (accessibilityJump) return false;
  const progressionPattern = /^(?:continue|next|proceed|confirm|submit|go on|move on|skip(?: bags?| baggage| add-ons?| extras?)?|proceed without(?: seats?| bags?| extras?)?)\b/;
  const exactLabel = progressionPattern.test(localText) || progressionPattern.test(stableMeaning);
  const ownedEffect = ["advance_surface", "advance_checkout_stage", "advance_to_payment"]
    .includes(clean(control.physicalEffect || control.mechanicalEffect).toLowerCase());
  return exactLabel || ownedEffect || control.semanticSceneItem?.role === "navigation";
}

function stageExitForScene(page = {}, controls = [], stage = "unknown") {
  const rawCandidates = new Map((page.stageExit?.candidates || []).map((candidate) => [candidate.controlId, candidate]));
  const currentSurfaceId = clean(page.currentSurface?.id || page.activeSurface?.id || "surface-page");
  const currentSurfaceType = lower(page.currentSurface?.type || page.activeSurface?.type || "page");
  const decisionControlIds = new Set((page.decisionGroups || []).flatMap((group) => [
    ...(group.alternativeControlIds || []),
    ...(group.alternatives || []).map((option) => option.controlId),
    ...(group.controls || []).map((option) => option.controlId)
  ]).filter(Boolean));
  const candidates = controls.filter((control) => {
    if (!control?.controlId || isChoiceControl(control)) return false;
    const controlSurfaceId = clean(control.surfaceId || control.surfaceOwnership?.surfaceId || "surface-page");
    if (currentSurfaceType !== "page" && controlSurfaceId !== currentSurfaceId) return false;
    if (currentSurfaceType === "page" && !["", "surface-page", currentSurfaceId].includes(controlSurfaceId)) return false;
    if (/\b(?:log\s*in|login|sign\s*in|register|create account)\b/.test(localControlText(control))) return false;
    if (lower(control.semantic) === "selection_cta" && control.semanticSceneItem?.role !== "navigation") {
      return false;
    }
    const exactProgression = exactProgressionControl(control);
    if (!exactProgression && (lower(control.semantic) === "selection_cta"
      || (lower(control.risk) === "uncertain" && lower(control.physicalEffect) === "unknown"))) {
      return false;
    }
    if (decisionControlIds.has(control.controlId)
      && !/navigation|advance_checkout_stage|advance_to_payment/.test(lower(`${control.semantic || ""} ${control.physicalEffect || ""}`))) {
      return false;
    }
    const raw = rawCandidates.get(control.controlId);
    // The browser may prove an unfamiliar exact actuator mechanically. That
    // proof is admissible scene evidence; inherited text semantics are not.
    return exactProgression
      || Boolean(raw && (raw.executable === true || raw.status === "ready"));
  }).map((control) => {
    const raw = rawCandidates.get(control.controlId) || {};
    const actuator = controlActuator(control) || {};
    const disabled = control.disabled === true || control.logicalDisabled === true || control.state?.disabled === true;
    const executable = !disabled && controlExecutable(control);
    return Object.freeze({
      controlId: control.controlId,
      actuatorId: actuator.actuatorId || raw.actuatorId || control.preferredActivationElementId || control.stateElementId || "",
      operation: actuator.operation || raw.operation || "activate",
      method: actuator.method || raw.method || "",
      status: disabled ? "disabled" : executable ? "ready" : (raw.status || "not_safely_actionable"),
      rendered: raw.rendered !== false,
      visible: raw.visible !== false,
      enabled: !disabled,
      inViewport: raw.inViewport !== false,
      inCurrentSurface: raw.inCurrentSurface !== false,
      executable,
      semanticEffect: ["payment_method_selection", "pre_payment_review", "legal_gate"].includes(stage)
        ? agentContract.SEMANTIC_EFFECT.ADVANCE_TO_PAYMENT
        : agentContract.SEMANTIC_EFFECT.ADVANCE_CHECKOUT_STAGE,
      evidence: Object.freeze([{ source: "owned_control_label", controlId: control.controlId, value: clean(control.label || control.accessibleName) }])
    });
  });
  const readyCandidates = candidates.filter((candidate) => candidate.executable === true);
  const soleSemantic = candidates.length === 1 ? candidates[0] : null;
  const soleExecutable = readyCandidates.length === 1 ? readyCandidates[0] : null;
  return Object.freeze({
    authority: "checkout_scene",
    continueAllowed: Boolean(soleExecutable),
    continueObserved: candidates.length > 0,
    continueDisabled: Boolean(candidates.length && candidates.every((candidate) => candidate.status === "disabled")),
    navigationState: soleExecutable
      ? "ready"
      : candidates.length && candidates.every((candidate) => candidate.status === "disabled")
        ? "disabled"
        : readyCandidates.length > 1
          ? "ambiguous"
          : (candidates.length ? "not_safely_actionable" : "not_observed"),
    candidates: Object.freeze(candidates),
    // Semantic ownership does not depend on already knowing the framework's
    // click implementation. Mechanics may bind the exact current element
    // separately; execution still requires capability proof and governance.
    authoritativeCandidate: soleSemantic,
    executableCandidate: soleExecutable,
    blockers: Object.freeze(candidates.length > 1 ? ["multiple scene exits require resolution"] : []),
    expectedPostcondition: soleSemantic ? Object.freeze(
      stage === "payment_method_selection"
        ? {
            type: "payment_entry_reached",
            expectedBoundary: "PAYMENT_ENTRY",
            requiredEvidence: Object.freeze(["hosted_payment_widget_or_payment_credentials"])
          }
        : {
            type: "checkout_stage_advanced",
            expectedBoundary: ["pre_payment_review", "legal_gate"].includes(stage)
              ? "PAYMENT_METHOD_SELECTION_OR_PAYMENT_ENTRY"
              : "",
            requiredEvidence: Object.freeze(["material_scene_change"])
          }
    ) : null
  });
}

function inferredStage(page = {}, controls = []) {
  const boundary = clean(page.terminalEvidence?.boundary || page.checkoutBoundary).toUpperCase();
  if (boundary === "PAYMENT_ENTRY") return "payment_entry";
  if (boundary === "LEGAL_GATE") return "legal_gate";
  if (boundary === "PRE_PAYMENT_REVIEW") return "pre_payment_review";
  const hasMethodChoice = controls.some((control) => (
    isChoiceControl(control) && /credit|debit|payment method|card payment|meansofpayment/.test(localControlText(control))
  ));
  if (hasMethodChoice) return "payment_method_selection";
  return "unknown";
}

function semanticIdentity({ stage, surfaceId, region, role, subject, repeatedInstance }) {
  return [stage, surfaceId || "surface-page", region || "page", role || "unknown", subject || "global", repeatedInstance || "0"]
    .map((part) => lower(part).replace(/[^a-z0-9:_-]+/g, "-").replace(/^-|-$/g, ""))
    .join(":");
}

function sceneItem({ stage, surfaceId, region, role, subject, selectedValue = "", repeatedInstance, controlIds = [], actuatorIds = [], status = "unresolved", requiredness = "unknown", consequence = "unknown", factSource = "", authority = "observed", legalTextDigest = "", attestationClasses = [], ownedValidationControlIds = [], expectedPostcondition = null, evidence = [], contradictions = [] }) {
  const stableIdentity = semanticIdentity({ stage, surfaceId, region, role, subject, repeatedInstance });
  return Object.freeze({
    contractVersion: SCENE_ITEM_VERSION,
    sceneItemId: stableIdentity,
    semanticOwnerId: stableIdentity,
    stage,
    surfaceId: surfaceId || "surface-page",
    region: region || "page",
    role,
    subject,
    selectedValue: clean(selectedValue, 240),
    repeatedInstance: repeatedInstance || "",
    controlIds: Object.freeze(unique(controlIds)),
    actuatorIds: Object.freeze(unique(actuatorIds)),
    status,
    requiredness,
    consequence,
    factSource: CLOSED_FACT_SOURCES.has(factSource) ? factSource : "",
    authority: clean(authority, 120),
    legalTextDigest: clean(legalTextDigest, 80),
    attestationClasses: Object.freeze(unique(attestationClasses)),
    ownedValidationControlIds: Object.freeze(unique(ownedValidationControlIds)),
    expectedPostcondition: expectedPostcondition ? Object.freeze({ ...expectedPostcondition }) : null,
    evidence: Object.freeze(evidence.map((item) => Object.freeze({ ...item }))),
    contradictions: Object.freeze(contradictions.map(clean).filter(Boolean))
  });
}

function controlPhysicalIds(control = {}) {
  return unique([
    control.controlId,
    control.stateElementId,
    control.visibleWidgetElementId,
    control.preferredActivationElementId,
    ...(control.representationLifecycle?.renderedMemberIds || []),
    ...(control.actuators || []).map((actuator) => actuator.nodeId),
    ...Object.values(control.operations || {}).flatMap((operation) => [
      operation?.actuatorId,
      ...(operation?.actuatorIds || [])
    ])
  ]);
}

function referencedLegalControl(controls = [], reference = "") {
  const id = clean(reference, 180);
  return controls.find((control) => controlPhysicalIds(control).includes(id)) || null;
}

function canOwnLegalAcceptance(control = {}) {
  const shape = lower(`${control.kind || ""} ${control.role || ""} ${control.domRole || ""}`);
  const stateful = /checkbox|radio|switch|toggle/.test(shape)
    || control.state?.checked !== undefined
    || control.state?.pressed !== undefined;
  return Boolean(stateful && control.controlId && control.state?.disabled !== true && control.disabled !== true);
}

function sceneItems({ page, stage, profileItems, decisionItems, commerceItems, stateItems, stageExit, checkoutMandate = null }) {
  const surfaceId = clean(page.currentSurface?.id || "surface-page");
  const items = [];
  const representedControlIds = new Set();
  const controls = page.controls || [];
  const optionalLoginControls = controls.filter((control) => {
    const meaning = lower(`${control.label || ""} ${control.accessibleName || ""} ${control.name || ""} ${control.autocomplete || ""}`);
    return /\b(?:login|log in|sign in)\b|loginemail|loginpassword|current-password/.test(meaning);
  });
  const optionalLoginControlIds = new Set(optionalLoginControls.map((control) => control.controlId));
  for (const descriptor of profileItems || []) {
    const controlIds = unique([
      descriptor.controlId,
      descriptor.control?.controlId,
      descriptor.bindingContract?.component?.controlId,
      ...(descriptor.componentBinding?.representationControlIds || []),
      ...(descriptor.componentBinding?.stateControlIds || [])
    ]);
    items.push(sceneItem({
      stage,
      surfaceId: descriptor.surfaceId || surfaceId,
      region: descriptor.owner?.sectionId || descriptor.sectionType || "traveler",
      role: "profile_field",
      subject: descriptor.semanticType || descriptor.field || descriptor.logicalFieldId,
      repeatedInstance: descriptor.ordinal,
      controlIds,
      status: descriptor.hasValue === true ? "resolved" : "unresolved",
      requiredness: descriptor.required === true ? "progression_required" : "optional_meaningful",
      consequence: "profile_data",
      factSource: "TravelerProfile",
      expectedPostcondition: { type: "canonical_value", semanticType: descriptor.semanticType || descriptor.field || "" },
      evidence: [{ source: "logical_profile_descriptor", controlId: descriptor.controlId || "", value: descriptor.label || descriptor.semanticType || "" }]
    }));
    controlIds.forEach((controlId) => representedControlIds.add(controlId));
  }
  const stageExitControlId = clean(stageExit.authoritativeCandidate?.controlId);
  for (const decision of [...(decisionItems || []), ...(commerceItems || [])]) {
    const selected = clean(decision.selectedControlId);
    const controlIds = unique([
      ...(decision.physicalControlIds || []),
      ...(decision.eligibleAlternativeControlIds || []),
      ...(decision.alternativeControlIds || []),
      ...(decision.alternatives || []).map((option) => option.controlId),
      ...(decision.decisionContract?.options || []).map((option) => option.controlId)
    ]);
    // One material control has one scene meaning. A pre-payment Confirm or
    // framework submit anchor that owns forward navigation must not also be
    // published as a transaction commit or generic checkout decision.
    const decisionOwnedControlIds = controlIds.filter((controlId) => (
      controlId !== stageExitControlId
      && !optionalLoginControlIds.has(controlId)
      && !representedControlIds.has(controlId)
    ));
    if (stageExitControlId && controlIds.includes(stageExitControlId)) {
      representedControlIds.add(stageExitControlId);
    }
    if (!decisionOwnedControlIds.length) continue;
    const paymentMethodDecision = decision.observed?.progressionRole === "payment_method";
    items.push(sceneItem({
      stage,
      surfaceId: decision.surfaceId || surfaceId,
      region: decision.sectionType || decision.family || "decision",
      role: paymentMethodDecision
        ? "payment_method"
        : decision.family === "profile" ? "personal_attestation" : "checkout_decision",
      subject: decision.semanticType || decision.subjectKey || decision.decisionGroupId,
      repeatedInstance: decision.decisionInstanceId,
      controlIds: decisionOwnedControlIds,
      // An untouched optional choice may be waived only when the same scene
      // has an owned way to leave it. If no stage exit exists, the choice is
      // the remaining local work (for example an insurance Yes/No gate), so
      // preserve it as unresolved for TaskState policy resolution.
      status: selected
        || (
          ["satisfied", "waived", "waived_by_policy"].includes(decision.status)
          && Boolean(stageExit.authoritativeCandidate)
        )
          ? "resolved"
          : "unresolved",
      requiredness: decision.required === true ? "progression_required" : "optional_meaningful",
      consequence: paymentMethodDecision ? "advance_to_payment" : (decision.riskClass || decision.family || "unknown"),
      factSource: "ObservedControl",
      expectedPostcondition: { type: "decision_resolved", decisionGroupId: decision.decisionGroupId || "" },
      evidence: [{ source: "canonical_decision", controlId: selected, value: decision.status || "" }]
    }));
    decisionOwnedControlIds.forEach((controlId) => representedControlIds.add(controlId));
  }
  for (const group of stateItems || []) {
    const state = group.sceneState || {};
    const controlIds = unique([
      ...(group.alternativeControlIds || []),
      ...(group.alternatives || []).map((option) => option.controlId),
      ...(group.decisionContract?.options || []).map((option) => option.controlId)
    ]);
    const selectedControl = controls.find((control) => (
      control.controlId === (group.selectedControlId || controlIds[0] || "")
    )) || null;
    const policyDeclineConsent = ["survey_consent", "marketing_consent"].includes(state.semanticType)
      && state.status === "unresolved";
    items.push(sceneItem({
      stage,
      surfaceId: group.surfaceId || surfaceId,
      region: group.sectionLabel || group.sectionType || "scene_state",
      role: state.semanticType || "scene_state",
      subject: state.semanticType || group.requirementId || group.decisionGroupId,
      selectedValue: state.selectedValue || "",
      controlIds,
      status: state.status || (["satisfied", "waived", "waived_by_policy", "optional"].includes(group.status) ? "resolved" : "unresolved"),
      requiredness: state.requiredness || (group.required === true ? "progression_required" : "optional_meaningful"),
      consequence: state.consequence || "non_commerce",
      factSource: "ObservedControl",
      expectedPostcondition: policyDeclineConsent
        ? {
            type: "control_state_equals",
            controlId: group.selectedControlId || controlIds[0] || "",
            stateElementId: selectedControl?.stateElementId || selectedControl?.preferredActivationElementId || "",
            desiredState: Object.freeze({ checked: false })
          }
        : { type: "selected_value_preserved", selectedControlId: group.selectedControlId || "" },
      evidence: [{ source: "explicit_scene_selection", controlId: group.selectedControlId || "", value: group.selectedLabel || group.status || "" }]
    }));
    controlIds.forEach((controlId) => representedControlIds.add(controlId));
  }
  const hasSceneRole = (role) => items.some((item) => item.role === role);
  const addObservedStateItem = ({ role, subject, matchingControls, selectedValue = "" }) => {
    if (hasSceneRole(role) || !matchingControls.length) return;
    const selectedControl = matchingControls.find((control) => agentContract.controlSelectionCommitted(control)) || null;
    items.push(sceneItem({
      stage,
      surfaceId,
      region: matchingControls[0].sectionId || matchingControls[0].sectionType || "scene_state",
      role,
      subject,
      selectedValue: selectedControl ? selectedValue || "selected" : "not_selected",
      controlIds: matchingControls.map((control) => control.controlId),
      actuatorIds: matchingControls.flatMap((control) => controlPhysicalIds(control)),
      status: selectedControl ? "resolved" : "unresolved",
      requiredness: "optional_meaningful",
      consequence: "non_commerce",
      factSource: "ObservedControl",
      authority: "checkout_scene",
      expectedPostcondition: {
        type: "selected_value_preserved",
        selectedControlId: selectedControl?.controlId || ""
      },
      evidence: matchingControls.map((control) => ({
        source: "typed_scene_state_control",
        controlId: control.controlId,
        value: control.label || control.accessibleName || control.name || ""
      }))
    }));
    matchingControls.forEach((control) => representedControlIds.add(control.controlId));
  };
  const paymentMethodControls = controls.filter((control) => {
    if (!isChoiceControl(control)) return false;
    const meaning = localControlText(control);
    return /meansofpayment|payment method|credit.*debit.*card|saved card/.test(meaning);
  });
  const selectedPaymentMethod = paymentMethodControls.find((control) => agentContract.controlSelectionCommitted(control));
  addObservedStateItem({
    role: "payment_method",
    subject: "payment_method",
    matchingControls: paymentMethodControls,
    selectedValue: selectedPaymentMethod
      ? (/saved/.test(localControlText(selectedPaymentMethod)) ? "saved_card" : "credit_debit_card")
      : ""
  });
  const singletonStateControls = [
    {
      role: "survey_consent",
      pattern: /survey|customer satisfaction/
    },
    {
      role: "marketing_consent",
      pattern: /marketing|promotional|third.party offers|receive information/
    }
  ];
  for (const state of singletonStateControls) {
    addObservedStateItem({
      role: state.role,
      subject: state.role,
      matchingControls: controls.filter((control) => (
        isChoiceControl(control) && state.pattern.test(localControlText(control))
      ))
    });
  }
  if (optionalLoginControls.length) {
    items.push(sceneItem({
      stage,
      surfaceId,
      region: "optional_login",
      role: "optional_login",
      subject: "existing_account_login",
      controlIds: optionalLoginControls.map((control) => control.controlId),
      actuatorIds: optionalLoginControls.flatMap((control) => controlPhysicalIds(control)),
      status: "intentionally_ignored",
      requiredness: "safely_ignorable",
      consequence: "authentication_optional",
      factSource: "DerivedFact",
      authority: "checkout_scene",
      expectedPostcondition: { type: "no_action_required" },
      evidence: optionalLoginControls.map((control) => ({
        source: "optional_login_control",
        controlId: control.controlId,
        value: control.label || control.accessibleName || control.name || ""
      }))
    }));
    optionalLoginControls.forEach((control) => representedControlIds.add(control.controlId));
  }
  // The authoritative navigation meaning is appended below. Mark its exact
  // control as represented now so the generic-control fallback cannot publish
  // a second, competing meaning for the same physical element.
  if (stageExitControlId) representedControlIds.add(stageExitControlId);
  const legalReferences = page.terminalEvidence?.legalAcceptanceControlIds || [];
  const referencedLegalControlIds = new Set(legalReferences
    .map((reference) => referencedLegalControl(controls, reference)?.controlId)
    .filter(Boolean));
  const legalTextEvidence = controls.filter((control) => (
    agentContract.isLegalAcceptanceText(`${control.semantic || ""} ${control.label || ""} ${control.accessibleName || ""}`)
  ));
  const legalOwners = controls.filter((control) => {
    if (!canOwnLegalAcceptance(control)) return false;
    const semanticItem = control.semanticSceneItem || {};
    return referencedLegalControlIds.has(control.controlId)
      || (semanticItem.grounded === true && semanticItem.role === "legal_attestation")
      || agentContract.isLegalAcceptanceText(`${control.semantic || ""} ${control.label || ""} ${control.accessibleName || ""}`);
  });
  const mandate = normalizeCheckoutMandate(checkoutMandate);
  for (const control of legalOwners) {
    const semanticItem = control.semanticSceneItem || {};
    const ownedEvidenceControls = legalTextEvidence.filter((candidate) => (
      candidate.controlId !== control.controlId
      && (
        legalOwners.length === 1
        || (candidate.sectionId && candidate.sectionId === control.sectionId)
        || referencedLegalControlIds.has(control.controlId)
      )
    ));
    const legalText = [
      control.label,
      control.accessibleName,
      page.terminalEvidence?.legalAcceptanceText,
      ...ownedEvidenceControls.map((candidate) => candidate.label || candidate.accessibleName)
    ].filter(Boolean).join(" ");
    const classification = classifyAttestation(legalText);
    const covered = mandateCoversAttestation(mandate, classification);
    const actuator = controlActuator(control);
    items.push(sceneItem({
      stage,
      surfaceId: control.surfaceId || surfaceId,
      region: control.sectionId || control.sectionType || "legal",
      role: "legal_attestation",
      subject: semanticItem.semanticType || "legal_terms",
      repeatedInstance: `legal:${classification.legalTextDigest.slice(0, 20)}`,
      controlIds: [control.controlId],
      actuatorIds: [actuator?.actuatorId, ...controlPhysicalIds(control).filter((id) => id !== control.controlId)],
      status: agentContract.controlSelectionCommitted(control) ? "resolved" : "unresolved",
      requiredness: "progression_required",
      consequence: covered ? "standard_checkout_attestation" : "exceptional_legal_attestation",
      factSource: covered ? "CheckoutMandate" : "ObservedControl",
      authority: covered ? "checkout_mandate" : "exceptional_handoff",
      legalTextDigest: classification.legalTextDigest,
      attestationClasses: classification.classes,
      ownedValidationControlIds: ownedEvidenceControls.map((candidate) => candidate.controlId),
      expectedPostcondition: {
        type: "legal_attestation_accepted",
        controlId: control.controlId,
        legalTextDigest: classification.legalTextDigest
      },
      evidence: [
        { source: "owned_legal_control", controlId: control.controlId, value: control.label || control.accessibleName || "" },
        ...ownedEvidenceControls.map((candidate) => ({
          source: "owned_legal_evidence",
          controlId: candidate.controlId,
          ownerControlId: control.controlId,
          value: candidate.label || candidate.accessibleName || ""
        }))
      ],
      contradictions: semanticItem.contradictions || []
    }));
    representedControlIds.add(control.controlId);
    ownedEvidenceControls.forEach((candidate) => representedControlIds.add(candidate.controlId));
  }
  // Every current executable representation receives a scene identity even
  // when its higher-level meaning is intentionally generic. TaskState may
  // bind mechanics only through one of these scene-owned IDs; an unrepresented
  // raw control can never become an executable obligation downstream.
  for (const control of controls) {
    if (!control?.controlId || representedControlIds.has(control.controlId) || control.globalChrome === true) continue;
    if (!controlExecutable(control) && control.state?.required !== true && control.required !== true) continue;
    const semanticItem = control.semanticSceneItem || {};
    items.push(sceneItem({
      stage,
      surfaceId: control.surfaceId || surfaceId,
      region: control.sectionId || control.sectionType || "current_surface",
      role: semanticItem.role || "observed_control",
      subject: semanticItem.semanticType || control.fieldType || control.semantic || control.kind || "control",
      repeatedInstance: control.logicalControlId || control.controlId,
      controlIds: [control.controlId],
      actuatorIds: controlPhysicalIds(control).filter((id) => id !== control.controlId),
      status: agentContract.controlSelectionCommitted(control) ? "resolved" : "unresolved",
      requiredness: control.required === true || control.state?.required === true
        ? "progression_required"
        : "optional_meaningful",
      consequence: control.risk || control.semantic || "reversible_mechanic",
      factSource: "ObservedControl",
      authority: "checkout_scene",
      expectedPostcondition: { type: "observable_change", controlId: control.controlId },
      evidence: [{ source: "current_observed_control", controlId: control.controlId, value: control.label || control.accessibleName || "" }]
    }));
    representedControlIds.add(control.controlId);
  }
  if (stageExit.authoritativeCandidate) {
    items.push(sceneItem({
      stage,
      surfaceId,
      region: "stage_exit",
      role: "navigation",
      subject: stageExit.authoritativeCandidate.semanticEffect,
      controlIds: [stageExit.authoritativeCandidate.controlId],
      actuatorIds: [stageExit.authoritativeCandidate.actuatorId],
      status: "unresolved",
      requiredness: "progression_required",
      consequence: "reversible_navigation",
      factSource: "ObservedControl",
      expectedPostcondition: stageExit.expectedPostcondition,
      evidence: stageExit.authoritativeCandidate.evidence
    }));
  }
  return Object.freeze(items);
}

function closureForScene({ page, semanticState, items, stageExit, stage }) {
  const contradictions = items.flatMap((item) => item.contradictions || []);
  const controlsById = new Map((semanticState.controls || []).map((control) => [control.controlId, control]));
  const representedControlIds = new Set(items.flatMap((item) => item.controlIds || []));
  const unresolvedRequiredControls = (semanticState.unownedMaterialControls || []).filter((item) => {
    if (representedControlIds.has(clean(item.controlId))) return false;
    const control = controlsById.get(item.controlId) || {};
    const activeSurfaceId = clean(page.currentSurface?.id || page.activeSurface?.id || "surface-page");
    if (control.surfaceId && clean(control.surfaceId) !== activeSurfaceId) return false;
    return control.required === true
      || control.state?.required === true
      || control.state?.invalid === true
      || Boolean(clean(control.state?.validationMessage));
  });
  const activeSurfaceId = clean(page.currentSurface?.id || page.activeSurface?.id || "surface-page");
  const groupsById = new Map((semanticState.decisionGroups || []).map((group) => [
    clean(group.decisionGroupId || group.requirementId),
    group
  ]));
  const unresolvedCurrentDecisions = (semanticState.unresolvedDecisions || []).filter((decision) => {
    const group = groupsById.get(clean(decision.decisionId)) || {};
    if (["satisfied", "waived", "waived_by_policy", "optional"].includes(group.status)
      || group.satisfied === true
      || Boolean(clean(group.selectedControlId))) {
      return false;
    }
    if (group.required !== true && group.decisionContract?.requiresResolution !== true) return false;
    return !group.surfaceId || clean(group.surfaceId) === activeSurfaceId;
  });
  const legalItems = items.filter((item) => item.role === "legal_attestation" && item.requiredness === "progression_required");
  const missingLegalOwner = stage === "legal_gate" && legalItems.length === 0;
  const unresolvedOwnedProgression = items.filter((item) => (
    item.requiredness === "progression_required"
    && item.status !== "resolved"
    && !["navigation", "legal_attestation"].includes(item.role)
  ));
  const executableUnresolvedItem = items.some((item) => (
    item.status !== "resolved"
    && item.role === "checkout_decision"
    && (item.controlIds || []).some((controlId) => controlExecutable(controlsById.get(controlId) || {}))
  ));
  const readiness = page.readiness || {};
  const stableCurrentPage = readiness.documentReadyState === "complete"
    && readiness.ariaBusy !== true
    && Number(readiness.loadingIndicatorCount || 0) === 0
    && Number(readiness.stableForMs || 0) >= 400;
  const knownActiveNonterminalStage = Boolean(stage && !["unknown", "flight_selection", "payment_entry"].includes(stage));
  const missingStageExit = Boolean(
    stableCurrentPage
    && knownActiveNonterminalStage
    && !stageExit.authoritativeCandidate
    && unresolvedOwnedProgression.length === 0
    && !executableUnresolvedItem
    && !missingLegalOwner
  );
  const unresolvedUnknown = unresolvedRequiredControls.length
    + unresolvedCurrentDecisions.length
    + (missingLegalOwner ? 1 : 0)
    + (missingStageExit ? 1 : 0);
  const status = contradictions.length
    ? "contradictory"
    : unresolvedUnknown
      ? "open"
      : "closed";
  return Object.freeze({
    status,
    contradictions: Object.freeze(contradictions),
    unresolvedUnknownCount: unresolvedUnknown,
    missingLegalOwner,
    missingStageExit,
    authoritativeExitCount: stageExit.authoritativeCandidate ? 1 : 0
  });
}

function createCheckoutScene({
  observation,
  observationFrame,
  semanticState,
  compiledObservation,
  profileItems,
  decisionItems,
  stateItems,
  commerceItems,
  transactionFacts,
  terminalEvidence,
  validationBlockers,
  checkoutMandate = null,
  patch = null
}) {
  const page = compiledObservation.page || {};
  const stageDecision = decideStage({ ...compiledObservation, page });
  const sceneSpecificStage = inferredStage(page, semanticState.controls || page.controls || []);
  const stage = sceneSpecificStage !== "unknown" ? sceneSpecificStage : (stageDecision.stage || "unknown");
  const stageExit = stageExitForScene(page, semanticState.controls || page.controls || [], stage);
  const authoritativePage = Object.freeze({ ...page, step: stage, stageExit });
  const items = sceneItems({ page: authoritativePage, stage, profileItems, decisionItems, commerceItems, stateItems, stageExit, checkoutMandate });
  const closure = closureForScene({ page: authoritativePage, semanticState, items, stageExit, stage });
  const compiledBoundary = paymentReviewBoundaryEvidence(
    { ...compiledObservation, page: authoritativePage },
    stageDecision.evidence,
    null,
    {}
  );
  const boundary = clean(compiledBoundary.boundary || authoritativePage.terminalEvidence?.boundary || "").toUpperCase();
  const legalItems = items.filter((item) => item.role === "legal_attestation");
  // Payment entry is the current task boundary, not completion of the
  // provider's payment form. Once exact terminal evidence owns that boundary,
  // billing fields, method selection, legal purchase gates and Pay controls are
  // all beyond this task and cannot reopen work.
  const terminalBlockingItems = compiledBoundary.paymentEntry
    ? []
    : items.filter((item) => (
      item.requiredness === "progression_required"
      && item.status !== "resolved"
      && item.role !== "navigation"
    ));
  const terminalState = Object.freeze({
    boundary,
    observed: compiledBoundary.observed || ["pre_payment_review", "legal_gate", "payment_entry", "payment_method_selection"].includes(stage),
    prePaymentReview: compiledBoundary.prePaymentReview || stage === "pre_payment_review",
    legalGate: compiledBoundary.legalGate || stage === "legal_gate" || legalItems.some((item) => item.status !== "resolved"),
    paymentEntry: compiledBoundary.paymentEntry || stage === "payment_entry",
    purchaseCommit: compiledBoundary.purchaseCommit,
    pendingContactControlIds: Object.freeze(unique(compiledBoundary.pendingContactControlIds || [])),
    pendingRequiredSceneItemIds: Object.freeze(unique(terminalBlockingItems.map((item) => item.sceneItemId))),
    pendingRequiredControlIds: Object.freeze(unique(terminalBlockingItems.flatMap((item) => item.controlIds || []))),
    pendingRequiredProfileControlIds: Object.freeze(unique(terminalBlockingItems
      .filter((item) => item.role === "profile_field")
      .flatMap((item) => item.controlIds || []))),
    legalSceneItemIds: Object.freeze(legalItems.map((item) => item.sceneItemId)),
    advanceToPaymentControlIds: Object.freeze(unique([
      ...(compiledBoundary.advanceToPaymentControlIds || []),
      ...(stageExit.authoritativeCandidate ? [stageExit.authoritativeCandidate.controlId] : [])
    ])),
    terminalEvidence: compiledBoundary.terminalEvidence || authoritativePage.terminalEvidence || null
  });
  const scenePage = Object.freeze({
    ...authoritativePage,
    checkoutSceneItems: items,
    checkoutSceneClosure: closure,
    checkoutSceneTerminalState: terminalState
  });
  const authoritativeObservation = Object.freeze({ ...compiledObservation, page: scenePage });
  const sceneIdentity = {
    compilerVersion: COMPILER_VERSION,
    observationId: observationFrame.observationId,
    sourceSnapshotHash: observationFrame.observationHash,
    stage,
    surfaceId: observationFrame.surface.id,
    items: items.map((item) => ({ id: item.sceneItemId, status: item.status, controls: item.controlIds })),
    stageExit: stageExit.authoritativeCandidate?.controlId || "",
    patch: patch?.patchId || ""
  };
  const sceneHash = stableDigest(sceneIdentity);
  return Object.freeze({
    contractVersion: CHECKOUT_SCENE_VERSION,
    compilerVersion: COMPILER_VERSION,
    sceneId: `${observationFrame.observationId || "observation"}:${sceneHash.slice(0, 20)}`,
    sceneHash,
    observationId: observationFrame.observationId,
    sourceSnapshotHash: observationFrame.observationHash,
    observationFrame,
    observation: authoritativeObservation,
    stage,
    stageDecisionEvidence: Object.freeze({ ...stageDecision.evidence }),
    surface: observationFrame.surface,
    items,
    profileItems: Object.freeze([...(profileItems || [])]),
    decisionItems: Object.freeze([...(decisionItems || [])]),
    stateItems: Object.freeze([...(stateItems || [])]),
    commerceItems: Object.freeze([...(commerceItems || [])]),
    semanticState: Object.freeze({
      semanticReadiness: semanticState.semanticReadiness,
      unownedMaterialControls: Object.freeze(semanticState.unownedMaterialControls || []),
      unresolvedDecisions: Object.freeze(semanticState.unresolvedDecisions || []),
      currentExecutableObligations: Object.freeze(semanticState.currentExecutableObligations || [])
    }),
    stageExit,
    closure,
    terminalState,
    transactionSummary: transactionFacts,
    transactionFacts,
    checkoutMandate: normalizeCheckoutMandate(checkoutMandate),
    terminalEvidence: terminalEvidence || null,
    validationBlockers: Object.freeze(validationBlockers || []),
    appliedPatch: patch ? Object.freeze({ contractVersion: SCENE_PATCH_VERSION, ...patch }) : null,
    provenance: Object.freeze({
      compiler: COMPILER_VERSION,
      sourceObservationId: observationFrame.observationId,
      sourceSnapshotHash: observationFrame.observationHash,
      semanticExtractorVersion: clean(semanticState.contractVersion || agentContract.CONTRACT_VERSION)
    })
  });
}

function checkoutSceneOwnsObservation(scene = null, observation = {}) {
  const hash = clean(observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash);
  return Boolean(
    scene?.contractVersion === CHECKOUT_SCENE_VERSION
    && scene.observationId === clean(observation.observationId)
    && scene.sourceSnapshotHash === hash
  );
}

module.exports = {
  CHECKOUT_SCENE_VERSION,
  SCENE_ITEM_VERSION,
  SCENE_PATCH_VERSION,
  COMPILER_VERSION,
  CLOSED_FACT_SOURCES,
  createCheckoutScene,
  checkoutSceneOwnsObservation,
  exactProgressionControl,
  stageExitForScene
};
