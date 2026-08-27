const { callStructured } = require("./openai-client");
const { semanticSceneSchemaFor } = require("./schemas");
const { availableSemanticFacts } = require("./active-component-grounding");
const { controlBelongsToCurrentSurface } = require("./surface-contract");

const MAX_COMPONENTS = 12;
const MAX_FACTS = 24;
const MAX_PACKET_BYTES = 24_000;
const INPUT_ROLE = /textbox|input|textarea|select|combobox|listbox|radio|checkbox|spinbutton|date/i;
const HARD_FORBIDDEN = /card number|cardholder|expiry|expiration|cvc|cvv|security code|purchase|pay now|place order|book now|confirm and pay/i;
const DECISION_TYPES = Object.freeze([
  "baggage",
  "seat",
  "insurance",
  "bundle",
  "flexible_ticket",
  "check_in_method",
  "optional_support",
  "loyalty_enrollment",
  "legal_acceptance",
  "payment_method",
  "stage_exit"
]);
const CONTROL_ROLES = Object.freeze([
  "payment_method",
  "stage_exit",
  "choice_option",
  "reveal_control",
  "dismiss_surface",
  "legal_acceptance"
]);
const CONSEQUENCE_CLASSES = Object.freeze([
  "checkout_progress",
  "policy_choice",
  "payment_route",
  "legal_attestation",
  "monetary_selection",
  "authentication"
]);
const EXPECTED_EFFECTS = Object.freeze([
  "reveal_control",
  "advance_checkout_stage",
  "select_option",
  "dismiss_surface"
]);

const INSTRUCTIONS = [
  "Reconcile uncertain semantic meaning in the supplied current checkout scene.",
  "Return only grounded hypotheses using supplied controlId, semanticType, factSource, and validationIssueId values.",
  "A field hypothesis may identify a traveler field and may attribute a supplied validation issue to that exact control.",
  "A decision hypothesis may map one supplied decisionGroupId to one supplied closed decisionType.",
  "A control hypothesis may explain one supplied observed control, attach it to one supplied decision group, and describe its likely reversible effect.",
  "Every hypothesis must be supported by the control's local label, attributes, helper text, owner region, options, or validation text.",
  "Do not create an action, obligation, fact, permission, transaction claim, requiredness claim, or completion claim.",
  "A decision type is descriptive evidence only. Do not decide its requiredness, policy outcome, permission, next action, price effect, or completion.",
  "A payment-method selector may be classified as payment_method; payment credential fields and purchase submission must remain unknown.",
  "Return unknown when the supplied evidence is insufficient."
].join(" ");

function clean(value = "", limit = 300) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function operationNames(control = {}) {
  return Object.entries(control.operations || {})
    .filter(([, capability]) => Boolean(capability))
    .map(([operation]) => operation);
}

function semanticBindingIdentity(control = {}) {
  return clean(
    control.stableKey
    || control.semanticIdentity
    || control.componentContract?.logicalIdentity
    || control.name
    || control.controlId,
    500
  );
}

function semanticBindingEvidenceSignature(control = {}) {
  const options = (control.options || control.choiceOptions || control.dateField?.options || [])
    .slice(0, 24)
    .map((option) => clean(typeof option === "string" ? option : `${option?.value || ""}|${option?.label || ""}`, 120));
  return JSON.stringify({
    identity: semanticBindingIdentity(control),
    role: clean(`${control.role || ""}|${control.kind || ""}|${control.domRole || ""}`, 120),
    name: clean(`${control.name || ""}|${control.id || ""}|${control.testId || ""}|${control.autocomplete || ""}`, 240),
    label: clean(`${control.label || ""}|${control.accessibleName || ""}|${control.placeholder || ""}`, 360),
    helper: clean(control.accessibleDescription, 240),
    owner: clean(`${control.sectionId || ""}|${control.sectionType || ""}|${control.sectionLabel || ""}|${control.semanticOwnerKey || ""}`, 300),
    operations: operationNames(control).sort(),
    options
  });
}

function applyRememberedSemanticBindings(observation = {}, memory = [], {
  traveler = {},
  transactionReview = null
} = {}) {
  if (!Array.isArray(memory) || !memory.length) return observation;
  const page = observation.page || {};
  const allowedFacts = new Set(availableSemanticFacts(traveler, { page, transactionReview }).map((fact) => (
    `${fact.semanticType}|${fact.factSource}`
  )));
  const receipts = new Map(memory.flatMap((entry) => {
    const identity = clean(entry?.identity, 500);
    const signature = String(entry?.evidenceSignature || "");
    const semanticType = clean(entry?.semanticType, 120);
    const factSource = clean(entry?.factSource, 180);
    if (!identity || !signature || !allowedFacts.has(`${semanticType}|${factSource}`)) return [];
    return [[`${identity}|${signature}`, { ...entry, semanticType, factSource }]];
  }));
  if (!receipts.size) return observation;
  const semanticFieldHints = [...(page.semanticFieldHints || [])];
  const reusedControlIds = [];
  for (const control of (page.controls || [])) {
    const existing = clean(control.fieldType || control.semantic).toLowerCase();
    const mayNeedBinding = !existing || ["unknown", "choice", "field", "value_field", "input", "control"].includes(existing)
      || Boolean(control.fieldClassification?.ambiguity);
    if (!mayNeedBinding || !controlBelongsToCurrentSurface(control, page)) continue;
    const identity = semanticBindingIdentity(control);
    const evidenceSignature = semanticBindingEvidenceSignature(control);
    const receipt = receipts.get(`${identity}|${evidenceSignature}`);
    if (!receipt) continue;
    reusedControlIds.push(control.controlId);
    semanticFieldHints.push({
      controlId: control.controlId,
      semanticType: receipt.semanticType,
      factSource: receipt.factSource,
      confidence: Number(receipt.confidence || 0.82) >= 0.9 ? "high" : "medium",
      authority: "grounded_hypothesis_only",
      source: "remembered_evidence_identical_binding",
      evidence: "Reused an evidence-identical grounded semantic binding."
    });
  }
  if (!reusedControlIds.length) return observation;
  return {
    ...observation,
    page: {
      ...page,
      semanticFieldHints,
      semanticBindingReuse: {
        status: "reused",
        controlIds: reusedControlIds,
        authority: "evidence_identical_hypothesis"
      }
    }
  };
}

function rememberSemanticBindings(memory = [], observation = {}) {
  const hypotheses = observation.page?.semanticSceneReconciliation?.hypotheses || [];
  if (!hypotheses.length) return Array.isArray(memory) ? memory : [];
  const controls = new Map((observation.page?.controls || []).map((control) => [control.controlId, control]));
  const additions = hypotheses.flatMap((hypothesis) => {
    const control = controls.get(hypothesis.controlId);
    if (!control || !["high", "medium"].includes(hypothesis.confidence)) return [];
    const identity = semanticBindingIdentity(control);
    const evidenceSignature = semanticBindingEvidenceSignature(control);
    if (!identity || !evidenceSignature) return [];
    return [{
      identity,
      evidenceSignature,
      semanticType: hypothesis.semanticType,
      factSource: hypothesis.factSource,
      confidence: hypothesis.confidence === "high" ? 0.95 : 0.82
    }];
  });
  const combined = [...(Array.isArray(memory) ? memory : []), ...additions];
  const deduped = new Map(combined.map((entry) => [
    `${entry.identity}|${entry.evidenceSignature}`,
    entry
  ]));
  return [...deduped.values()].slice(-64);
}

function semanticSceneUncertainty({
  observation = {},
  semanticCompilation = null,
  traveler = {},
  transactionReview = null,
  currentObligation = null
} = {}) {
  const rawPage = observation.page || {};
  const page = semanticCompilation
    ? { ...rawPage, controls: semanticCompilation.controls, decisionGroups: semanticCompilation.decisionGroups }
    : rawPage;
  const admittedControlIds = new Set(
    currentObligation
      ? (currentObligation.admittedControlIds || []).map(String).filter(Boolean)
      : []
  );
  const admittedDecisionGroupId = clean(currentObligation?.desiredStateDelta?.decisionGroupId, 180);
  if (page.terminalEvidence?.verified === true || page.semanticTerminal === true) {
    return Object.freeze({
      needed: false,
      reason: "TERMINAL_EVIDENCE_PRESENT",
      components: [],
      facts: [],
      validationIssues: [],
      allowedBindings: [],
      allowedValidationOwners: [],
      decisionGroups: [],
      decisionTypes: DECISION_TYPES,
      allowedDecisionBindings: [],
      allowedControlIds: [],
      allowedDecisionGroupIds: [],
      controlRoles: CONTROL_ROLES,
      consequenceClasses: CONSEQUENCE_CLASSES,
      expectedEffects: EXPECTED_EFFECTS
    });
  }
  const validationIssues = (page.validationIssues || []).filter((issue) => (
    !["clear", "diagnostic"].includes(clean(issue.status).toLowerCase())
    && (!admittedControlIds.size || !issue.controlId || admittedControlIds.has(String(issue.controlId)))
  ));
  const componentScore = (control) => {
    if (admittedControlIds.has(String(control.controlId || ""))) return 0;
    if (control.required === true || control.state?.required === true || control.invalid === true || control.state?.invalid === true) return 1;
    if (control.fieldClassification?.ambiguity) return 2;
    const semantic = clean(control.fieldType || control.semantic).toLowerCase();
    if (!semantic || ["unknown", "choice", "field", "value_field", "input", "control", "open_surface"].includes(semantic)) return 3;
    const local = clean(`${control.label || ""} ${control.accessibleName || ""}`).toLowerCase();
    if (/credit|debit|payment method|continue|next|proceed|terms|insurance|seat|baggage/.test(local)) return 4;
    return 5;
  };
  const components = (page.controls || []).filter((control) => {
    if (admittedControlIds.size && !admittedControlIds.has(String(control.controlId || ""))) return false;
    const lifecycle = control.representationLifecycle || {};
    const active = lifecycle.active === true || lifecycle.status === "active_rendered";
    if (!active || !controlBelongsToCurrentSurface(control, page)) return false;
    if (!operationNames(control).length) return false;
    const text = clean([
      control.label,
      control.accessibleName,
      control.name,
      control.placeholder,
      control.accessibleDescription,
      control.sectionLabel
    ].join(" ")).toLowerCase();
    if (control.globalChrome || HARD_FORBIDDEN.test(text)) return false;
    const semantic = clean(control.fieldType || control.semantic).toLowerCase();
    const unknown = !semantic || [
      "unknown",
      "choice",
      "field",
      "value_field",
      "input",
      "control"
    ].includes(semantic);
    const ambiguous = Boolean(control.fieldClassification?.ambiguity);
    const ownsValidation = validationIssues.some((issue) => issue.controlId === control.controlId);
    const required = control.required === true || control.state?.required === true;
    if (!admittedControlIds.size) {
      const shape = clean(`${control.role || ""} ${control.kind || ""} ${control.domRole || ""}`);
      const knownProfileInput = INPUT_ROLE.test(shape) && !unknown && !ambiguous && !ownsValidation;
      if (knownProfileInput) return false;
      const knownDecisionMember = Boolean(
        control.decisionGroupId
        && (page.decisionGroups || []).some((group) => (
          clean(group.decisionGroupId || group.requirementId, 180) === clean(control.decisionGroupId, 180)
        ))
        && !unknown
      );
      const knownCommand = [
        "continue",
        "navigation",
        "safe_continue",
        "decline_paid_extra",
        "safe_decline",
        "dismiss_surface",
        "legal_acceptance",
        "payment_method"
      ].includes(semantic);
      return unknown || ambiguous || ownsValidation || (!knownDecisionMember && !knownCommand);
    }
    if (!["profile_field", "profile_fact", "unknown_required", "unknown_validation"].includes(clean(currentObligation?.desiredStateDelta?.kind))) return true;
    return (unknown && (required || ownsValidation)) || ambiguous;
  }).sort((left, right) => componentScore(left) - componentScore(right)).slice(0, MAX_COMPONENTS);

  const unownedValidationIssues = validationIssues.filter((issue) => (
    !issue.controlId
    && !issue.logicalOwnerKey
    && issue.stageWide !== true
  )).slice(0, 6);
  const validationCandidateControls = unownedValidationIssues.length
    ? (page.controls || []).filter((control) => {
        const lifecycle = control.representationLifecycle || {};
        return (!admittedControlIds.size || admittedControlIds.has(String(control.controlId || "")))
          && (lifecycle.active === true || lifecycle.status === "active_rendered")
          && controlBelongsToCurrentSurface(control, page)
          && INPUT_ROLE.test(clean(`${control.role || ""} ${control.kind || ""} ${control.domRole || ""}`))
          && operationNames(control).length;
      }).slice(0, MAX_COMPONENTS)
    : [];
  const candidateMap = new Map([...components, ...validationCandidateControls]
    .map((control) => [control.controlId, control]));
  const candidateControls = [...candidateMap.values()];
  const uncertainDecisionGroups = (page.decisionGroups || []).filter((group) => {
    if (admittedDecisionGroupId
      && clean(group.decisionGroupId || group.requirementId, 180) !== admittedDecisionGroupId) return false;
    const subject = clean(`${group.subject?.key || group.subject || ""} ${group.sectionType || ""}`).toLowerCase();
    const material = group.material === true || group.required === true || (group.alternatives || []).length > 0;
    if (!material) return false;
    const typedContract = group.decisionContract?.valid === true
      && Boolean(group.decisionContract?.kind)
      && Boolean(subject)
      && !/unknown|decision|additional/.test(subject);
    return !typedContract && (!subject || /unknown|decision|additional|payment/.test(subject));
  }).slice(0, 8);
  const facts = availableSemanticFacts(traveler, { page, transactionReview }).slice(0, MAX_FACTS);
  const allowedBindings = candidateControls.flatMap((control) => facts.map((fact) => ({
    controlId: control.controlId,
    semanticType: fact.semanticType,
    factSource: fact.factSource
  })));
  const allowedValidationOwners = unownedValidationIssues.flatMap((issue) => candidateControls.map((control) => ({
    validationIssueId: issue.issueId,
    controlId: control.controlId
  })));
  const allowedDecisionBindings = uncertainDecisionGroups.flatMap((group) => DECISION_TYPES.map((decisionType) => ({
    decisionGroupId: clean(group.decisionGroupId || group.requirementId, 180),
    decisionType
  }))).filter((binding) => binding.decisionGroupId);
  const allowedControlIds = candidateControls.map((control) => clean(control.controlId, 180)).filter(Boolean);
  const allowedDecisionGroupIds = uncertainDecisionGroups
    .map((group) => clean(group.decisionGroupId || group.requirementId, 180))
    .filter(Boolean);
  // A hypothesis may describe an observed membership, but it may not invent
  // topology. Only control/group pairs already present in the structural
  // graph are admissible.
  const allowedControlDecisionBindings = uncertainDecisionGroups.flatMap((group) => {
    const decisionGroupId = clean(group.decisionGroupId || group.requirementId, 180);
    return [
      ...(group.alternativeControlIds || []),
      ...(group.alternatives || []).map((option) => option.controlId)
    ].map((controlId) => ({
      controlId: clean(controlId, 180),
      decisionGroupId
    })).filter((binding) => binding.controlId && binding.decisionGroupId);
  });
  return Object.freeze({
    needed: Boolean(
      ((components.length || unownedValidationIssues.length) && candidateControls.length && facts.length)
      || uncertainDecisionGroups.length
      || (!currentObligation && candidateControls.length)
    ),
    reason: currentObligation ? "ADMITTED_OBLIGATION_AMBIGUOUS" : "CURRENT_SURFACE_SEMANTICALLY_INCOMPLETE",
    components: candidateControls,
    facts,
    validationIssues: unownedValidationIssues,
    allowedBindings,
    allowedValidationOwners,
    decisionGroups: uncertainDecisionGroups,
    decisionTypes: DECISION_TYPES,
    allowedDecisionBindings,
    allowedControlIds,
    allowedDecisionGroupIds,
    allowedControlDecisionBindings,
    controlRoles: CONTROL_ROLES,
    consequenceClasses: CONSEQUENCE_CLASSES,
    expectedEffects: EXPECTED_EFFECTS
  });
}

function applySemanticSceneHypotheses(observation = {}, response = {}, uncertainty = {}) {
  const allowedBindings = new Set((uncertainty.allowedBindings || []).map((binding) => (
    `${binding.controlId}|${binding.semanticType}|${binding.factSource}`
  )));
  const allowedOwners = new Set((uncertainty.allowedValidationOwners || []).map((owner) => (
    `${owner.validationIssueId}|${owner.controlId}`
  )));
  const accepted = (response.hypotheses || []).filter((hypothesis) => {
    if (!["high", "medium"].includes(hypothesis.confidence)) return false;
    const bindingAllowed = allowedBindings.has(`${hypothesis.controlId}|${hypothesis.semanticType}|${hypothesis.factSource}`);
    const ownerAllowed = !hypothesis.validationIssueId
      || allowedOwners.has(`${hypothesis.validationIssueId}|${hypothesis.controlId}`);
    return bindingAllowed && ownerAllowed;
  }).slice(0, 4);
  const allowedDecisionBindings = new Set((uncertainty.allowedDecisionBindings || []).map((binding) => (
    `${binding.decisionGroupId}|${binding.decisionType}`
  )));
  const acceptedDecisionHypotheses = (response.decisionHypotheses || []).filter((hypothesis) => (
    ["high", "medium"].includes(hypothesis.confidence)
    && allowedDecisionBindings.has(`${hypothesis.decisionGroupId}|${hypothesis.decisionType}`)
  )).slice(0, 4);
  const allowedControlIds = new Set(uncertainty.allowedControlIds || []);
  const allowedDecisionGroupIds = new Set(uncertainty.allowedDecisionGroupIds || []);
  const allowedControlDecisionBindings = new Set((uncertainty.allowedControlDecisionBindings || []).map((binding) => (
    `${binding.controlId}|${binding.decisionGroupId}`
  )));
  const acceptedControlHypotheses = (response.controlHypotheses || []).filter((hypothesis) => (
    ["high", "medium"].includes(hypothesis.confidence)
    && allowedControlIds.has(hypothesis.controlId)
    && (uncertainty.controlRoles || []).includes(hypothesis.semanticRole)
    && (uncertainty.consequenceClasses || []).includes(hypothesis.consequenceClass)
    && (uncertainty.expectedEffects || []).includes(hypothesis.expectedReversibleEffect)
    && (!hypothesis.decisionGroupId || (
      allowedDecisionGroupIds.has(hypothesis.decisionGroupId)
      && allowedControlDecisionBindings.has(`${hypothesis.controlId}|${hypothesis.decisionGroupId}`)
    ))
    && (!hypothesis.prerequisiteOf
      || allowedControlIds.has(hypothesis.prerequisiteOf)
      || allowedDecisionGroupIds.has(hypothesis.prerequisiteOf))
    && (!hypothesis.decisionType || hypothesis.decisionType === "unknown" || (uncertainty.decisionTypes || []).includes(hypothesis.decisionType))
  )).slice(0, 6);
  const withAuthority = (hypothesis) => ({
    ...hypothesis,
    authority: "grounded_hypothesis_only",
    evidence: clean(hypothesis.evidence)
  });
  const dedupe = (items, keyFor) => [...new Map(items.map((item) => [keyFor(item), item])).values()];
  const fieldHints = accepted.map(withAuthority);
  const validationHints = accepted.filter((hypothesis) => hypothesis.validationIssueId).map((hypothesis) => withAuthority({
    validationIssueId: hypothesis.validationIssueId,
    controlId: hypothesis.controlId,
    semanticType: hypothesis.semanticType,
    confidence: hypothesis.confidence,
    evidence: hypothesis.evidence
  }));
  const decisionHints = [
    ...acceptedDecisionHypotheses,
    ...acceptedControlHypotheses.filter((hypothesis) => (
      hypothesis.decisionGroupId && hypothesis.decisionType !== "unknown"
    )).map((hypothesis) => ({
      decisionGroupId: hypothesis.decisionGroupId,
      decisionType: hypothesis.decisionType,
      confidence: hypothesis.confidence,
      evidence: hypothesis.evidence
    }))
  ].map(withAuthority);
  const controlHints = acceptedControlHypotheses.map(withAuthority);
  return {
    ...observation,
    page: {
      ...(observation.page || {}),
      // The resolver publishes only bounded evidence. It cannot rewrite a
      // control, assign validation ownership, create a decision group, or
      // change group membership. DecisionFrame validates and interprets these
      // hints once on its next compilation.
      semanticFieldHints: dedupe([
        ...(observation.page?.semanticFieldHints || []),
        ...fieldHints
      ], (hint) => `${hint.controlId}|${hint.semanticType}|${hint.factSource}`),
      semanticValidationHints: dedupe([
        ...(observation.page?.semanticValidationHints || []),
        ...validationHints
      ], (hint) => `${hint.validationIssueId}|${hint.controlId}`),
      semanticControlHints: dedupe([
        ...(observation.page?.semanticControlHints || []),
        ...controlHints
      ], (hint) => `${hint.controlId}|${hint.semanticRole}`),
      semanticDecisionHints: dedupe([
        ...(observation.page?.semanticDecisionHints || []),
        ...decisionHints
      ], (hint) => `${hint.decisionGroupId}|${hint.decisionType}`),
      semanticSceneReconciliation: {
        status: accepted.length || acceptedDecisionHypotheses.length || acceptedControlHypotheses.length ? "grounded" : "unknown",
        authority: "hypothesis_only",
        hypotheses: accepted.map((hypothesis) => ({ ...hypothesis, evidence: clean(hypothesis.evidence) })),
        decisionHypotheses: acceptedDecisionHypotheses.map((hypothesis) => ({
          ...hypothesis,
          evidence: clean(hypothesis.evidence)
        })),
        controlHypotheses: acceptedControlHypotheses.map((hypothesis) => ({
          ...hypothesis,
          evidence: clean(hypothesis.evidence)
        }))
      }
    }
  };
}

async function reconcileSemanticScene({
  apiKey,
  model,
  observation = {},
  semanticCompilation = null,
  traveler = {},
  transactionReview = null,
  currentObligation = null,
  policyConstraints = {},
  failedMethods = [],
  screenshotDataUrl = "",
  uncertainty = null
} = {}) {
  const scene = uncertainty || semanticSceneUncertainty({
    observation,
    semanticCompilation,
    traveler,
    transactionReview,
    currentObligation
  });
  if (!scene.needed) return { observation, reconciliation: null, meta: null };
  const { data, meta } = await callStructured({
    apiKey,
    model,
    instructions: INSTRUCTIONS,
    payload: {
      scene: {
        surface: observation.page?.currentSurface || null,
        objective: "Resolve the current checkout surface toward verified card credential entry without entering credentials or submitting payment.",
        currentObligation: currentObligation ? {
          id: clean(currentObligation.id, 180),
          kind: clean(currentObligation.desiredStateDelta?.kind, 80),
          objective: clean(`satisfy ${currentObligation.semanticOwner?.family || currentObligation.desiredStateDelta?.kind || "current obligation"}`, 240),
          desiredEffect: clean(currentObligation.desiredStateDelta?.desiredEffect, 100),
          admittedControlIds: (currentObligation.admittedControlIds || []).map((id) => clean(id, 160)).filter(Boolean),
          evidenceStrength: clean(currentObligation.desiredStateDelta?.evidenceStrength, 40),
          successCondition: currentObligation.successCondition || null
        } : null,
        components: scene.components.map((control) => ({
          controlId: control.controlId,
          rawEvidenceChannels: {
            name: clean(control.rawEvidenceChannels?.name || control.name),
            label: clean(control.rawEvidenceChannels?.label || control.label || control.accessibleName),
            heading: clean(control.rawEvidenceChannels?.heading),
            section: {
              id: clean(control.rawEvidenceChannels?.section?.id || control.sectionId, 160),
              type: clean(control.rawEvidenceChannels?.section?.type || control.sectionType, 100),
              label: clean(control.rawEvidenceChannels?.section?.label || control.sectionLabel)
            },
            validity: {
              required: control.rawEvidenceChannels?.validity?.required === true
                || control.required === true
                || control.state?.required === true,
              invalid: control.rawEvidenceChannels?.validity?.invalid === true
                || control.invalid === true
                || control.state?.invalid === true,
              validationMessage: clean(
                control.rawEvidenceChannels?.validity?.validationMessage
                || control.state?.validationMessage
              )
            },
            relationships: {
              decisionGroupId: clean(control.rawEvidenceChannels?.relationships?.decisionGroupId || control.decisionGroupId, 180),
              logicalFieldId: clean(control.rawEvidenceChannels?.relationships?.logicalFieldId || control.logicalFieldId, 180),
              stateElementId: clean(control.rawEvidenceChannels?.relationships?.stateElementId || control.stateElementId, 160),
              preferredActivationElementId: clean(
                control.rawEvidenceChannels?.relationships?.preferredActivationElementId
                || control.preferredActivationElementId,
                160
              )
            }
          },
          placeholder: clean(control.placeholder),
          helperText: clean(control.accessibleDescription),
          operations: operationNames(control)
        })),
        validationIssues: scene.validationIssues.map((issue) => ({
          validationIssueId: issue.issueId,
          message: clean(issue.message)
        })),
        decisions: scene.decisionGroups.map((group) => ({
          decisionGroupId: clean(group.decisionGroupId || group.requirementId, 180),
          label: clean(group.sectionLabel || group.label || group.decisionContract?.subjectLabel),
          subject: clean(group.subject?.key || group.subject || group.sectionType),
          requiredObserved: group.required === true,
          options: (group.alternatives || []).slice(0, 12).map((option) => ({
            controlId: clean(option.controlId, 160),
            label: clean(option.label, 180),
            selected: option.selected === true,
            price: option.structuredPrice || null
          }))
        }))
      },
      availableFacts: scene.facts.map((fact) => ({
        semanticType: fact.semanticType,
        factSource: fact.factSource,
        valuePreview: fact.valuePreview
      })),
      // The full Cartesian binding sets remain server-local for validating a
      // returned hypothesis. Sending every control x fact and group x type
      // pair repeats the same closed enums and can exceed the model packet
      // before unfamiliarity reasoning even begins.
      allowedSemanticBindings: {
        controlIds: [...new Set(scene.allowedBindings.map((binding) => binding.controlId))],
        semanticTypes: [...new Set(scene.allowedBindings.map((binding) => binding.semanticType))],
        factSources: [...new Set(scene.allowedBindings.map((binding) => binding.factSource))]
      },
      allowedValidationOwners: scene.allowedValidationOwners,
      allowedDecisionBindings: {
        decisionGroupIds: [...new Set(scene.allowedDecisionBindings.map((binding) => binding.decisionGroupId))],
        decisionTypes: [...new Set(scene.allowedDecisionBindings.map((binding) => binding.decisionType))]
      },
      allowedControlInterpretation: {
        controlIds: scene.allowedControlIds,
        decisionGroupIds: scene.allowedDecisionGroupIds,
        semanticRoles: scene.controlRoles,
        consequenceClasses: scene.consequenceClasses,
        expectedEffects: scene.expectedEffects
      },
      policyConstraints: {
        bookingRules: clean(policyConstraints.bookingRules || policyConstraints.booking_rules, 300),
        seatPolicy: clean(policyConstraints.seatPolicy || policyConstraints.seat_policy, 100),
        baggage: clean(policyConstraints.baggage || policyConstraints.baggagePreference, 120),
        declinePaidExtras: policyConstraints.declinePaidExtras === true
      },
      failedMethods: (failedMethods || []).map((method) => ({
        operation: clean(method.operation, 80),
        method: clean(method.method, 80),
        result: clean(method.result, 120)
      })).slice(-8),
      forbiddenConsequences: [
        "invent_control_or_fact",
        "create_obligation",
        "grant_permission",
        "declare_payment_completion",
        "select_unknown_paid_legal_or_payment_action",
        "unrestricted_page_exploration"
      ],
      outputAuthority: "grounded_hypothesis_only"
    },
    screenshotDataUrl,
    schema: semanticSceneSchemaFor(
      scene.components.map((control) => control.controlId),
      scene.facts.map((fact) => fact.semanticType),
      scene.facts.map((fact) => fact.factSource),
      scene.validationIssues.map((issue) => issue.issueId),
      scene.decisionGroups.map((group) => group.decisionGroupId || group.requirementId),
      scene.decisionTypes,
      scene.controlRoles,
      scene.consequenceClasses,
      scene.expectedEffects
    ),
    schemaName: "semantic_scene_reconciliation",
    maxOutputTokens: 650,
    returnMeta: true,
    maxPayloadBytes: MAX_PACKET_BYTES
  });
  const response = {
    status: String(data?.status || "unknown"),
    hypotheses: Array.isArray(data?.hypotheses) ? data.hypotheses.map((hypothesis) => ({
      controlId: String(hypothesis?.controlId || ""),
      semanticType: String(hypothesis?.semanticType || "unknown"),
      factSource: String(hypothesis?.factSource || ""),
      validationIssueId: String(hypothesis?.validationIssueId || ""),
      confidence: String(hypothesis?.confidence || "low").toLowerCase(),
      evidence: clean(hypothesis?.evidence)
    })) : [],
    decisionHypotheses: Array.isArray(data?.decisionHypotheses) ? data.decisionHypotheses.map((hypothesis) => ({
      decisionGroupId: String(hypothesis?.decisionGroupId || ""),
      decisionType: String(hypothesis?.decisionType || "unknown"),
      confidence: String(hypothesis?.confidence || "low").toLowerCase(),
      evidence: clean(hypothesis?.evidence)
    })) : [],
    controlHypotheses: Array.isArray(data?.controlHypotheses) ? data.controlHypotheses.map((hypothesis) => ({
      controlId: String(hypothesis?.controlId || ""),
      semanticRole: String(hypothesis?.semanticRole || "unknown"),
      decisionGroupId: String(hypothesis?.decisionGroupId || ""),
      decisionType: String(hypothesis?.decisionType || "unknown"),
      prerequisiteOf: String(hypothesis?.prerequisiteOf || ""),
      consequenceClass: String(hypothesis?.consequenceClass || "unknown"),
      expectedReversibleEffect: String(hypothesis?.expectedReversibleEffect || "unknown"),
      confidence: String(hypothesis?.confidence || "low").toLowerCase(),
      evidence: clean(hypothesis?.evidence)
    })) : []
  };
  const reconciled = response.status === "grounded"
    ? applySemanticSceneHypotheses(observation, response, scene)
    : {
        ...observation,
        page: {
          ...(observation.page || {}),
          semanticSceneReconciliation: {
            status: "unknown",
            authority: "hypothesis_only",
            hypotheses: [],
            decisionHypotheses: [],
            controlHypotheses: []
          }
        }
      };
  return {
    observation: reconciled,
    reconciliation: reconciled.page.semanticSceneReconciliation,
    meta
  };
}

module.exports = {
  semanticSceneUncertainty,
  semanticBindingEvidenceSignature,
  applyRememberedSemanticBindings,
  rememberSemanticBindings,
  applySemanticSceneHypotheses,
  reconcileSemanticScene
};
