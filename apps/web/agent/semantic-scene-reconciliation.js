const { callStructured } = require("./openai-client");
const { semanticSceneSchemaFor } = require("./schemas");
const { availableSemanticFacts } = require("./active-component-grounding");
const { controlBelongsToCurrentSurface } = require("./surface-contract");

const MAX_COMPONENTS = 8;
const MAX_FACTS = 24;
const MAX_PACKET_BYTES = 24_000;
const INPUT_ROLE = /textbox|input|textarea|select|combobox|listbox|radio|checkbox|spinbutton|date/i;
const FORBIDDEN = /payment|card|cvc|cvv|security code|purchase|pay now|legal|terms|consent|insurance|bundle|baggage|seat/i;
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
  "stage_exit"
]);

const INSTRUCTIONS = [
  "Reconcile uncertain semantic meaning in the supplied current checkout scene.",
  "Return only grounded hypotheses using supplied controlId, semanticType, factSource, and validationIssueId values.",
  "A field hypothesis may identify a traveler field and may attribute a supplied validation issue to that exact control.",
  "A decision hypothesis may map one supplied decisionGroupId to one supplied closed decisionType.",
  "Every hypothesis must be supported by the control's local label, attributes, helper text, owner region, options, or validation text.",
  "Do not create an action, obligation, fact, permission, transaction claim, requiredness claim, or completion claim.",
  "A decision type is descriptive evidence only. Do not decide its requiredness, policy outcome, permission, next action, price effect, or completion.",
  "Never classify payment credential entry or purchase submission as a checkout decision.",
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
  const bindingByControl = new Map();
  const controls = (page.controls || []).map((control) => {
    const existing = clean(control.fieldType || control.semantic).toLowerCase();
    const mayNeedBinding = !existing || ["unknown", "choice", "field", "value_field", "input", "control"].includes(existing)
      || Boolean(control.fieldClassification?.ambiguity);
    if (!mayNeedBinding || !controlBelongsToCurrentSurface(control, page)) return control;
    const identity = semanticBindingIdentity(control);
    const evidenceSignature = semanticBindingEvidenceSignature(control);
    const receipt = receipts.get(`${identity}|${evidenceSignature}`);
    if (!receipt) return control;
    bindingByControl.set(control.controlId, receipt);
    return {
      ...control,
      fieldType: receipt.semanticType,
      semantic: receipt.semanticType,
      fieldClassification: {
        fieldType: receipt.semanticType,
        source: "remembered_grounded_semantic_scene",
        confidence: Number(receipt.confidence || 0.82),
        evidence: ["Reused an evidence-identical grounded semantic binding."],
        semanticGrounding: { factSource: receipt.factSource }
      }
    };
  });
  if (!bindingByControl.size) return observation;
  const fields = (page.fields || []).map((field) => {
    const receipt = bindingByControl.get(field.controlId);
    return receipt
      ? { ...field, field: receipt.semanticType, fieldType: receipt.semanticType, semantic: receipt.semanticType }
      : field;
  });
  return {
    ...observation,
    page: {
      ...page,
      controls,
      fields,
      semanticBindingReuse: {
        status: "reused",
        controlIds: [...bindingByControl.keys()],
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

function semanticSceneUncertainty({ observation = {}, semanticCompilation = null, traveler = {}, transactionReview = null } = {}) {
  const rawPage = observation.page || {};
  const page = semanticCompilation
    ? { ...rawPage, controls: semanticCompilation.controls, decisionGroups: semanticCompilation.decisionGroups }
    : rawPage;
  const validationIssues = (page.validationIssues || []).filter((issue) => (
    !["clear", "diagnostic"].includes(clean(issue.status).toLowerCase())
  ));
  const components = (page.controls || []).filter((control) => {
    const lifecycle = control.representationLifecycle || {};
    const active = lifecycle.active === true || lifecycle.status === "active_rendered";
    if (!active || !controlBelongsToCurrentSurface(control, page)) return false;
    if (!INPUT_ROLE.test(clean(`${control.role || ""} ${control.kind || ""} ${control.domRole || ""}`))) return false;
    if (!operationNames(control).length) return false;
    const text = clean([
      control.label,
      control.accessibleName,
      control.name,
      control.placeholder,
      control.accessibleDescription,
      control.sectionLabel
    ].join(" ")).toLowerCase();
    if (control.globalChrome || FORBIDDEN.test(text)) return false;
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
    return (unknown && (required || ownsValidation)) || ambiguous;
  }).slice(0, MAX_COMPONENTS);

  const unownedValidationIssues = validationIssues.filter((issue) => (
    !issue.controlId
    && !issue.logicalOwnerKey
    && issue.stageWide !== true
  )).slice(0, 6);
  const validationCandidateControls = unownedValidationIssues.length
    ? (page.controls || []).filter((control) => {
        const lifecycle = control.representationLifecycle || {};
        return (lifecycle.active === true || lifecycle.status === "active_rendered")
          && controlBelongsToCurrentSurface(control, page)
          && INPUT_ROLE.test(clean(`${control.role || ""} ${control.kind || ""} ${control.domRole || ""}`))
          && operationNames(control).length;
      }).slice(0, MAX_COMPONENTS)
    : [];
  const candidateMap = new Map([...components, ...validationCandidateControls]
    .map((control) => [control.controlId, control]));
  const candidateControls = [...candidateMap.values()];
  const uncertainDecisionGroups = (page.decisionGroups || []).filter((group) => {
    const subject = clean(`${group.subject?.key || group.subject || ""} ${group.sectionType || ""}`).toLowerCase();
    const material = group.material === true || group.required === true || (group.alternatives || []).length > 0;
    return material && (!subject || /unknown|decision|additional/.test(subject));
  }).slice(0, 6);
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
  return Object.freeze({
    needed: Boolean(
      ((components.length || unownedValidationIssues.length) && candidateControls.length && facts.length)
      || uncertainDecisionGroups.length
    ),
    components: candidateControls,
    facts,
    validationIssues: unownedValidationIssues,
    allowedBindings,
    allowedValidationOwners,
    decisionGroups: uncertainDecisionGroups,
    decisionTypes: DECISION_TYPES,
    allowedDecisionBindings
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
  const bindingByControl = new Map(accepted.map((hypothesis) => [hypothesis.controlId, hypothesis]));
  const controls = (observation.page?.controls || []).map((control) => {
    const hypothesis = bindingByControl.get(control.controlId);
    if (!hypothesis) return control;
    return {
      ...control,
      fieldType: hypothesis.semanticType,
      semantic: hypothesis.semanticType,
      fieldClassification: {
        fieldType: hypothesis.semanticType,
        source: "grounded_semantic_scene",
        confidence: hypothesis.confidence === "high" ? 0.95 : 0.82,
        evidence: [clean(hypothesis.evidence)],
        semanticGrounding: { factSource: hypothesis.factSource }
      }
    };
  });
  const fields = (observation.page?.fields || []).map((field) => {
    const hypothesis = bindingByControl.get(field.controlId);
    return hypothesis
      ? { ...field, field: hypothesis.semanticType, fieldType: hypothesis.semanticType, semantic: hypothesis.semanticType }
      : field;
  });
  const validationIssues = (observation.page?.validationIssues || []).map((issue) => {
    const hypothesis = accepted.find((candidate) => candidate.validationIssueId === issue.issueId);
    return hypothesis
      ? { ...issue, controlId: hypothesis.controlId, semanticType: hypothesis.semanticType, ownershipSource: "grounded_semantic_scene" }
      : issue;
  });
  return {
    ...observation,
    page: {
      ...(observation.page || {}),
      controls,
      fields,
      validationIssues,
      semanticSceneReconciliation: {
        status: accepted.length || acceptedDecisionHypotheses.length ? "grounded" : "unknown",
        authority: "hypothesis_only",
        hypotheses: accepted.map((hypothesis) => ({ ...hypothesis, evidence: clean(hypothesis.evidence) })),
        decisionHypotheses: acceptedDecisionHypotheses.map((hypothesis) => ({
          ...hypothesis,
          evidence: clean(hypothesis.evidence)
        }))
      },
      semanticDecisionHints: acceptedDecisionHypotheses.map((hypothesis) => ({
        ...hypothesis,
        authority: "grounded_hypothesis_only",
        evidence: clean(hypothesis.evidence)
      }))
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
  screenshotDataUrl = "",
  uncertainty = null
} = {}) {
  const scene = uncertainty || semanticSceneUncertainty({ observation, semanticCompilation, traveler, transactionReview });
  if (!scene.needed) return { observation, reconciliation: null, meta: null };
  const { data, meta } = await callStructured({
    apiKey,
    model,
    instructions: INSTRUCTIONS,
    payload: {
      scene: {
        stage: observation.page?.step || "unknown",
        surface: observation.page?.currentSurface || null,
        components: scene.components.map((control) => ({
          controlId: control.controlId,
          label: clean(control.label || control.accessibleName),
          name: clean(control.name),
          placeholder: clean(control.placeholder),
          helperText: clean(control.accessibleDescription),
          sectionLabel: clean(control.sectionLabel),
          required: control.required === true || control.state?.required === true,
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
      allowedSemanticBindings: scene.allowedBindings,
      allowedValidationOwners: scene.allowedValidationOwners,
      allowedDecisionBindings: scene.allowedDecisionBindings,
      outputAuthority: "grounded_hypothesis_only"
    },
    screenshotDataUrl,
    schema: semanticSceneSchemaFor(
      scene.components.map((control) => control.controlId),
      scene.facts.map((fact) => fact.semanticType),
      scene.facts.map((fact) => fact.factSource),
      scene.validationIssues.map((issue) => issue.issueId),
      scene.decisionGroups.map((group) => group.decisionGroupId || group.requirementId),
      scene.decisionTypes
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
    })) : []
  };
  const reconciled = response.status === "grounded"
    ? applySemanticSceneHypotheses(observation, response, scene)
    : {
        ...observation,
        page: {
          ...(observation.page || {}),
          semanticSceneReconciliation: { status: "unknown", authority: "hypothesis_only", hypotheses: [] }
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
