const { callStructured } = require("./openai-client");
const { semanticBindingSchemaFor } = require("./schemas");
const { compileInteractionView } = require("./interaction-view");
const { controlBelongsToCurrentSurface } = require("./surface-contract");
const {
  PROFILE_FIELDS,
  derivedTravelerFacts,
  desiredProfileValue,
  semanticTypeForControl
} = require("./logical-field");

const MAX_GROUNDING_COMPONENTS = 6;
const MAX_GROUNDING_FACTS = 24;
const GROUNDING_PACKET_BYTES = 24_000;
const PROFILE_STAGE = /traveler|traveller|passenger|contact|document/i;
const INPUT_ROLE = /textbox|input|textarea|select|combobox|listbox|radio|checkbox|spinbutton|date/i;
const FORBIDDEN_MEANING = /payment|card|cvc|cvv|security code|purchase|pay now|legal|terms|consent/i;
const SENSITIVE_FACT = /passport|document_number|known_traveler|redress/i;

const INSTRUCTIONS = [
  "Bind at most one supplied active checkout component to one supplied semantic fact source.",
  "This is semantic grounding only. Do not choose, invent, or describe a browser action.",
  "Use only a supplied componentId, semanticType, and factSource combination from allowedSemanticBindings.",
  "The component must be asking for that traveler fact in its local label, owner, options, placeholder, or validation evidence.",
  "A disabled Continue may prove incompleteness but does not identify a hidden or unrelated field.",
  "Return unknown when the evidence is insufficient. Never bind payment, purchase, legal consent, marketing, loyalty enrollment, or an optional product.",
  "Identity and derived values are authoritative inputs; do not calculate or alter them."
].join(" ");

function clean(value = "", limit = 240) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function operationCapabilities(control = {}) {
  return Object.entries(control.operations || {}).flatMap(([operation, capability]) => {
    if (!capability) return [];
    const actionability = capability.actionability || {};
    return [{
      candidateId: `semantic:${control.controlId}:${operation}`,
      controlId: control.controlId,
      logicalControlId: control.controlId,
      actuatorId: capability.actuatorId || control.preferredActivationElementId || control.stateElementId || "",
      targetId: capability.actuatorId || control.preferredActivationElementId || control.stateElementId || "",
      targetLabel: control.label || control.accessibleName || "",
      label: control.label || control.accessibleName || "",
      operation,
      interactionMethod: capability.strategies?.[0]?.method || "",
      capabilityStatus: capability.status || "",
      executionChannel: actionability.executable === true
        ? "execute"
        : actionability.revealable === true
          ? "reveal"
          : "unavailable",
      actionability,
      selectable: false,
      semantic: "unknown_active_component"
    }];
  });
}

function unblockedStageExitReady(page = {}) {
  const exit = page.stageExit || {};
  if (exit.continueDisabled === true || exit.navigationState === "disabled") return false;
  const readyCandidate = (exit.candidates || []).some((candidate) => (
    candidate.executable === true || candidate.status === "ready"
  ));
  return Boolean(readyCandidate && !(exit.blockers || []).length);
}

function activeUnknownComponents(observation = {}, { admittedControlIds = [] } = {}) {
  const page = observation.page || {};
  if (!PROFILE_STAGE.test(String(page.step || ""))) return [];
  const admitted = new Set((admittedControlIds || []).map(String).filter(Boolean));
  // Semantic grounding is not a page scanner. TaskState must first admit one
  // exact Current Obligation; only controls owned by that obligation may be
  // considered for a profile binding hypothesis.
  if (!admitted.size) return [];
  // Grounding is semantic evidence for an already admitted unknown
  // requirement, never an independent source of work. A fresh executable
  // stage exit with no blockers proves that dormant/optional unknown controls
  // do not own the current task.
  if (unblockedStageExitReady(page)) return [];
  return (page.controls || []).filter((control) => {
    if (!admitted.has(String(control.controlId || ""))) return false;
    const lifecycle = control.representationLifecycle || {};
    const explicitlyActive = lifecycle.active === true || lifecycle.status === "active_rendered";
    if (!explicitlyActive || !controlBelongsToCurrentSurface(control, page)) return false;
    if (control.globalChrome || FORBIDDEN_MEANING.test(clean([
      control.label,
      control.accessibleName,
      control.semantic,
      control.fieldType,
      control.name,
      control.autocomplete
    ].join(" ")).toLowerCase())) return false;
    if (!INPUT_ROLE.test(clean(`${control.role || ""} ${control.kind || ""} ${control.domRole || ""}`))) return false;
    if (semanticTypeForControl(control, {})) return false;
    const state = control.state || {};
    const unresolved = !state.valuePresent && !state.selected && !state.checked;
    const locallyRequired = control.required === true || state.required === true;
    const ownsValidation = (page.validationIssues || []).some((issue) => (
      issue.controlId && issue.controlId === control.controlId
    ));
    const localMeaning = clean([
      control.label,
      control.accessibleName,
      control.placeholder,
      control.name
    ].join(" ")).toLowerCase();
    const genericContainer = /^(?:passenger|traveler|traveller|contact|details|information|passenger information|traveler information|traveller information)$/i.test(localMeaning);
    if (!unresolved || (!locallyRequired && !ownsValidation) || genericContainer) return false;
    return operationCapabilities(control).length > 0;
  }).slice(0, MAX_GROUNDING_COMPONENTS);
}

function unknownComponentsForObligation(observation = {}, obligation = null) {
  if (!obligation || typeof obligation !== "object") return [];
  if (obligation.authority !== "task_state"
    || obligation.policyDecision?.status !== "admitted") return [];
  const family = clean(
    obligation.subject?.family
  ).toLowerCase();
  if (family !== "profile") return [];
  return activeUnknownComponents(observation, {
    admittedControlIds: obligation.admittedControlIds || []
  });
}

function availableSemanticFacts(traveler = {}, context = {}) {
  const derived = derivedTravelerFacts(traveler, context);
  return [...PROFILE_FIELDS].flatMap((semanticType) => {
    const derivedFact = derived[semanticType] || null;
    const value = derivedFact?.value || desiredProfileValue(semanticType, traveler, context);
    if (!value) return [];
    return [{
      semanticType,
      factSource: derivedFact?.source || `profile.${semanticType}`,
      value: String(value),
      valuePreview: SENSITIVE_FACT.test(semanticType) ? "[available]" : String(value).slice(0, 80),
      derivation: derivedFact ? {
        inputs: [...(derivedFact.inputs || [])],
        departureDate: derivedFact.departureDate || ""
      } : null
    }];
  }).slice(0, MAX_GROUNDING_FACTS);
}

function allowedBindings(components = [], facts = []) {
  return components.flatMap((component) => facts.map((fact) => ({
    componentId: component.controlId,
    semanticType: fact.semanticType,
    factSource: fact.factSource,
    valuePreview: fact.valuePreview
  })));
}

function withGroundingState(observation = {}, grounding = {}) {
  return {
    ...observation,
    page: {
      ...(observation.page || {}),
      activeRequirementGrounding: {
        ...grounding
      }
    }
  };
}

function applySemanticBinding(observation = {}, resolution = {}, bindings = []) {
  const binding = bindings.find((candidate) => (
    candidate.componentId === resolution.componentId
    && candidate.semanticType === resolution.semanticType
    && candidate.factSource === resolution.factSource
  ));
  if (!binding || !["high", "medium"].includes(resolution.confidence)) {
    return withGroundingState(observation, {
      status: "unknown",
      reasonCode: "ACTIVE_REQUIREMENT_UNRESOLVED",
      candidateComponentIds: [...new Set(bindings.map((candidate) => candidate.componentId))],
      evidence: clean(resolution.evidence, 400)
    });
  }
  const controls = (observation.page?.controls || []).map((control) => (
    control.controlId !== binding.componentId
      ? control
      : {
          ...control,
          fieldType: binding.semanticType,
          fieldClassification: {
            fieldType: binding.semanticType,
            source: "bounded_semantic_grounding",
            confidence: resolution.confidence === "high" ? 0.95 : 0.82,
            evidence: [clean(resolution.evidence, 400)],
            semanticGrounding: {
              factSource: binding.factSource
            }
          }
        }
  ));
  const fields = (observation.page?.fields || []).map((field) => (
    field.controlId !== binding.componentId
      ? field
      : { ...field, field: binding.semanticType, fieldType: binding.semanticType }
  ));
  return {
    ...observation,
    page: {
      ...(observation.page || {}),
      controls,
      fields,
      activeRequirementGrounding: {
        status: "bound",
        componentId: binding.componentId,
        semanticType: binding.semanticType,
        factSource: binding.factSource,
        confidence: resolution.confidence,
        evidence: clean(resolution.evidence, 400)
      }
    }
  };
}

async function resolveActiveComponentSemantics({
  apiKey,
  model,
  observation = {},
  traveler = {},
  transactionReview = null,
  screenshotDataUrl = "",
  attemptedStrategies = [],
  admittedControlIds = []
} = {}) {
  const components = activeUnknownComponents(observation, { admittedControlIds });
  if (!components.length) return { observation, resolution: null, meta: null };
  const facts = availableSemanticFacts(traveler, {
    page: observation.page || {},
    transactionReview
  });
  const bindings = allowedBindings(components, facts);
  if (!bindings.length) {
    const unresolved = withGroundingState(observation, {
      status: "unknown",
      reasonCode: "ACTIVE_REQUIREMENT_UNRESOLVED",
      candidateComponentIds: components.map((component) => component.controlId),
      evidence: "No supplied profile or derived fact can satisfy the active component."
    });
    return { observation: unresolved, resolution: unresolved.page.activeRequirementGrounding, meta: null };
  }
  const capabilities = components.flatMap(operationCapabilities);
  const interactionView = compileInteractionView({
    goal: {
      goalId: "ground_active_component_semantics",
      semanticType: "unknown",
      postcondition: { type: "semantic_binding_validated" }
    },
    taskState: {
      stage: observation.page?.step || "unknown",
      foregroundSurface: observation.page?.currentSurface || observation.page?.activeSurface || null
    },
    candidates: [],
    contextCapabilities: capabilities,
    observation,
    allowedSemanticBindings: bindings,
    attemptedStrategies,
    forbiddenEffects: ["browser_mutation", "payment", "purchase", "legal_consent", "paid_selection"],
    successCondition: { type: "semantic_binding_validated", semanticType: "supported_ontology" }
  });
  const { data, meta } = await callStructured({
    apiKey,
    model,
    instructions: INSTRUCTIONS,
    payload: {
      interactionView,
      derivedFacts: facts.filter((fact) => fact.derivation).map((fact) => ({
        semanticType: fact.semanticType,
        factSource: fact.factSource,
        value: fact.valuePreview,
        derivation: fact.derivation
      })),
      outputAuthority: "binding_hypothesis_only"
    },
    screenshotDataUrl,
    schema: semanticBindingSchemaFor(
      components.map((component) => component.controlId),
      facts.map((fact) => fact.semanticType),
      facts.map((fact) => fact.factSource)
    ),
    schemaName: "active_component_semantic_binding",
    maxOutputTokens: 350,
    returnMeta: true,
    maxPayloadBytes: GROUNDING_PACKET_BYTES
  });
  const resolution = {
    status: String(data?.status || "unknown"),
    componentId: String(data?.componentId || ""),
    semanticType: String(data?.semanticType || "unknown"),
    factSource: String(data?.factSource || ""),
    confidence: String(data?.confidence || "low").toLowerCase(),
    evidence: clean(data?.evidence, 400)
  };
  const groundedObservation = resolution.status === "bound"
    ? applySemanticBinding(observation, resolution, bindings)
    : withGroundingState(observation, {
        status: "unknown",
        reasonCode: "ACTIVE_REQUIREMENT_UNRESOLVED",
        candidateComponentIds: components.map((component) => component.controlId),
        evidence: resolution.evidence
      });
  return {
    observation: groundedObservation,
    resolution: groundedObservation.page.activeRequirementGrounding,
    meta
  };
}

module.exports = {
  activeUnknownComponents,
  unknownComponentsForObligation,
  availableSemanticFacts,
  applySemanticBinding,
  resolveActiveComponentSemantics
};
