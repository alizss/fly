const { callStructured } = require("./openai-client");
const { semanticSceneSchemaFor } = require("./schemas");
const { availableSemanticFacts } = require("./active-component-grounding");
const { controlBelongsToCurrentSurface } = require("./surface-contract");

const MAX_COMPONENTS = 8;
const MAX_FACTS = 24;
const MAX_PACKET_BYTES = 24_000;
const INPUT_ROLE = /textbox|input|textarea|select|combobox|listbox|radio|checkbox|spinbutton|date/i;
const FORBIDDEN = /payment|card|cvc|cvv|security code|purchase|pay now|legal|terms|consent|insurance|bundle|baggage|seat/i;

const INSTRUCTIONS = [
  "Reconcile uncertain semantic meaning in the supplied current checkout scene.",
  "Return only grounded hypotheses using supplied controlId, semanticType, factSource, and validationIssueId values.",
  "A hypothesis may identify a traveler field and may attribute a supplied validation issue to that exact control.",
  "Every hypothesis must be supported by the control's local label, attributes, helper text, owner region, options, or validation text.",
  "Do not create an action, obligation, fact, permission, transaction claim, requiredness claim, or completion claim.",
  "Do not bind payment, purchase, legal consent, marketing, loyalty enrollment, or optional products.",
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

function semanticSceneUncertainty({ observation = {}, semanticCompilation = null, traveler = {}, transactionReview = null } = {}) {
  const rawPage = observation.page || {};
  const page = semanticCompilation
    ? { ...rawPage, controls: semanticCompilation.controls, decisionGroups: semanticCompilation.decisionGroups }
    : rawPage;
  const validationIssues = page.validationIssues || [];
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
    const unknown = !semantic || semantic === "unknown";
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
  return Object.freeze({
    needed: Boolean((components.length || unownedValidationIssues.length) && candidateControls.length && facts.length),
    components: candidateControls,
    facts,
    validationIssues: unownedValidationIssues,
    allowedBindings,
    allowedValidationOwners
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
        status: accepted.length ? "grounded" : "unknown",
        authority: "hypothesis_only",
        hypotheses: accepted.map((hypothesis) => ({ ...hypothesis, evidence: clean(hypothesis.evidence) }))
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
        }))
      },
      availableFacts: scene.facts.map((fact) => ({
        semanticType: fact.semanticType,
        factSource: fact.factSource,
        valuePreview: fact.valuePreview
      })),
      allowedSemanticBindings: scene.allowedBindings,
      allowedValidationOwners: scene.allowedValidationOwners,
      outputAuthority: "grounded_hypothesis_only"
    },
    screenshotDataUrl,
    schema: semanticSceneSchemaFor(
      scene.components.map((control) => control.controlId),
      scene.facts.map((fact) => fact.semanticType),
      scene.facts.map((fact) => fact.factSource),
      scene.validationIssues.map((issue) => issue.issueId)
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
  applySemanticSceneHypotheses,
  reconcileSemanticScene
};
