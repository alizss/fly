const { callStructured } = require("./openai-client");
const crypto = require("node:crypto");
const {
  semanticSceneSchemaFor,
  SEMANTIC_SCENE_STAGES,
  SEMANTIC_SCENE_ROLES,
  SEMANTIC_SCENE_REQUIREDNESS,
  SEMANTIC_SCENE_CONSEQUENCES
} = require("./schemas");
const { availableSemanticFacts } = require("./active-component-grounding");
const { controlBelongsToCurrentSurface } = require("./surface-contract");
const agentContract = require("../../extension/src/shared/agent-contract");

const MAX_COMPONENTS = 16;
const MAX_FACTS = 24;
const MAX_PACKET_BYTES = 32_000;
const INTERACTIVE_ROLE = /textbox|input|textarea|select|combobox|listbox|radio|checkbox|spinbutton|date|button|link|option|menuitem|^a$/i;
const SCENE_MEANING = /payment|card|cvc|cvv|security code|purchase|pay now|legal|terms|conditions|consent|insurance|bundle|baggage|seat|promotion|promo|voucher|discount|time to think|no thanks|confirm|continue|next|proceed|submit|age|over 18|adult/i;
const PROFILE_ROLES = new Set(["profile_field", "personal_attestation"]);
const PROFILE_TYPES = new Set(agentContract.PROFILE_FIELD_TYPES || []);
const NON_PROFILE_TYPES_BY_ROLE = Object.freeze({
  optional_credential: new Set(["promotion_code", "loyalty_number", "billing_tax_id"]),
  optional_free: new Set(["information_only"]),
  optional_paid_accept: new Set(["paid_optional_product"]),
  optional_paid_decline: new Set(["paid_optional_product"]),
  legal_attestation: new Set(["legal_terms"]),
  payment_entry: new Set(["payment_credential"]),
  navigation: new Set(["checkout_navigation"]),
  transaction_commit: new Set(["transaction_confirmation"]),
  informational: new Set(["information_only"]),
  unknown: new Set(["unknown"])
});

const INSTRUCTIONS = [
  "Reconcile the complete foreground checkout scene when deterministic interpretation is uncertain or contradictory.",
  "Classify supplied controls, their relationships, the likely current stage, requiredness evidence, and consequence class.",
  "You may understand traveler fields, attestations, optional credentials, paid products, legal consent, payment entry, navigation, and transaction confirmation.",
  "Return only grounded hypotheses using supplied controlId, semanticType, factSource, and validationIssueId values.",
  "Every hypothesis must cite current local labels, helper text, state, owner region, options, validation, stage markers, or current page context.",
  "Requiredness is a hypothesis about the observed scene, never permission or transaction truth.",
  "Do not create an action, obligation, traveler fact, permission, price, transaction claim, successful completion, or legal authorization.",
  "Understanding a dangerous element never authorizes interacting with it.",
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

function controlSceneText(control = {}) {
  return clean([
    control.label,
    control.accessibleName,
    control.name,
    control.placeholder,
    control.accessibleDescription,
    control.description,
    control.helperText,
    control.sectionLabel,
    control.stableKey,
    control.semantic,
    control.fieldType,
    control.risk
  ].join(" "), 1_200);
}

function activeCurrentControl(control = {}, page = {}) {
  const lifecycle = control.representationLifecycle || {};
  const active = lifecycle.active === true || lifecycle.status === "active_rendered";
  return Boolean(
    active
    && controlBelongsToCurrentSurface(control, page)
    && INTERACTIVE_ROLE.test(clean(`${control.role || ""} ${control.kind || ""} ${control.domRole || ""}`))
  );
}

function controlSemantic(control = {}) {
  return clean(control.fieldType || control.field || control.semantic).toLowerCase();
}

function semanticallyUnknown(control = {}) {
  const semantic = controlSemantic(control);
  return !semantic || ["unknown", "choice", "field", "value_field", "input", "control"].includes(semantic);
}

function sceneStageContradiction(page = {}, controls = []) {
  const declaredStage = clean(page.step || "unknown").toLowerCase() || "unknown";
  const signals = page.terminalEvidence?.signals || {};
  const terminalSignalCount = ["route", "progress", "form", "method", "commit", "legal", "review", "heading", "entry"]
    .filter((key) => signals[key] === true).length;
  const activeProfileControls = controls.filter((control) => PROFILE_TYPES.has(
    clean(control.fieldType || control.field || control.semantic).toLowerCase()
  ));
  const context = clean([
    page.text,
    page.heading,
    page.sceneContext?.primaryText,
    page.sceneContext?.headingText,
    page.sceneContext?.activeProgressText,
    ...controls.slice(0, 60).map(controlSceneText)
  ].join(" "), 8_000).toLowerCase();
  const paymentReviewCopy = /(?:^|\b)(?:pay|payment|total to be paid|amount to pay|purchase conditions|general conditions of carriage|confirm)(?:\b|$)/.test(context);
  const travelerCopy = /travell?er information|passenger details|contact information/.test(context);
  const reasons = [];
  if (declaredStage === "traveler_information" && activeProfileControls.length === 0 && terminalSignalCount >= 2) {
    reasons.push("declared_traveler_stage_without_profile_controls_but_terminal_signals_present");
  }
  if (declaredStage === "traveler_information" && activeProfileControls.length === 0 && paymentReviewCopy) {
    reasons.push("declared_traveler_stage_conflicts_with_payment_review_scene");
  }
  if (["extras", "seats"].includes(declaredStage) && terminalSignalCount >= 3) {
    reasons.push("declared_ancillary_stage_conflicts_with_terminal_scene");
  }
  if (declaredStage === "payment" && travelerCopy && activeProfileControls.length >= 2 && terminalSignalCount === 0) {
    reasons.push("declared_payment_stage_conflicts_with_active_traveler_form");
  }
  const suggestedStage = activeProfileControls.length === 0
    && terminalSignalCount >= 2
    && paymentReviewCopy
      ? "review"
      : "unknown";
  return Object.freeze({
    contradictory: reasons.length > 0,
    reasons: Object.freeze(reasons),
    declaredStage,
    suggestedStage,
    terminalSignalCount,
    paymentReviewCopy,
    activeProfileControlCount: activeProfileControls.length
  });
}

function semanticScenePriority(
  control = {},
  validationIssues = [],
  unownedControlIds = new Set(),
  stageContradiction = false,
  progressionBlocked = false
) {
  if (control.semanticSceneItem?.grounded === true && control.semanticSceneItem?.deterministic === true) {
    return 0;
  }
  const text = controlSceneText(control).toLowerCase();
  const required = control.required === true || control.state?.required === true;
  const ownsValidation = validationIssues.some((issue) => issue.controlId === control.controlId);
  const ambiguous = Boolean(control.fieldClassification?.ambiguity);
  const unknown = semanticallyUnknown(control);
  let score = 0;
  if (unownedControlIds.has(control.controlId)) score += 120;
  if (ownsValidation) score += 110;
  if (required && unknown) score += 100;
  if (ambiguous) score += 90;
  const locallyContextual = required
    || ownsValidation
    || unownedControlIds.has(control.controlId)
    || progressionBlocked
    || stageContradiction;
  if (SCENE_MEANING.test(text) && (unknown || ambiguous) && locallyContextual) score += 80;
  if (stageContradiction) score += 40;
  if (/checkbox|radio|button|select|combobox/.test(clean(`${control.role || ""} ${control.kind || ""}`).toLowerCase())) score += 10;
  return score;
}

function semanticSceneUncertainty({ observation = {}, semanticCompilation = null, checkoutScene = null, traveler = {}, transactionReview = null } = {}) {
  const rawPage = observation.page || {};
  const page = semanticCompilation
    ? { ...rawPage, controls: semanticCompilation.controls, decisionGroups: semanticCompilation.decisionGroups }
    : rawPage;
  const validationIssues = (page.validationIssues || []).filter((issue) => (
    !agentContract.isNonBlockingValidationSummary(issue)
  ));
  const activeControls = (page.controls || []).filter((control) => (
    !control.globalChrome && activeCurrentControl(control, page)
  ));
  const stageContradiction = sceneStageContradiction(page, activeControls);
  const terminalBoundary = page.terminalEvidence?.boundaryObserved === true
    || page.terminalEvidence?.verified === true;
  const controlsById = new Map(activeControls.map((control) => [control.controlId, control]));
  // Logical profile fields do not need another semantic interpretation merely
  // because they are not owned by a choice group. Keep model admission for
  // genuinely unknown material controls only.
  const unownedControlIds = new Set((semanticCompilation?.unownedMaterialControls || [])
    .map((item) => controlsById.get(item.controlId) || item)
    .filter((control) => control?.controlId && semanticallyUnknown(control))
    .map((control) => control.controlId));
  const semanticClosureIncomplete = Boolean(
    checkoutScene
    && checkoutScene.closure?.status !== "closed"
  );
  const progressionBlocked = Boolean(
    page.stageExit?.continueDisabled === true
    || ["disabled", "blocked", "blocked_by_validation"].includes(page.stageExit?.navigationState)
    || checkoutScene?.closure?.missingStageExit === true
  );
  const unownedValidationIssues = validationIssues.filter((issue) => (
    !issue.controlId
    && !issue.logicalOwnerKey
    && issue.stageWide !== true
  )).slice(0, 6);
  const rankedControls = activeControls
    .map((control) => ({
      control,
      priority: semanticScenePriority(
        control,
        validationIssues,
        unownedControlIds,
        stageContradiction.contradictory,
        progressionBlocked
      )
    }))
    .filter((entry) => entry.priority > 0)
    // Once the verified review boundary is visible, optional informational
    // buttons and post-review legal/purchase mechanics are outside the V1
    // objective. They cannot justify a scene-model call. Keep interpretation
    // available only for an unresolved data-entry control or owned validation
    // that could still represent missing traveler/contact information.
    .filter((entry) => {
      if (!terminalBoundary) return true;
      const control = entry.control;
      const shape = clean(`${control.role || ""} ${control.kind || ""} ${control.domRole || ""}`).toLowerCase();
      const ownsValidation = validationIssues.some((issue) => issue.controlId === control.controlId);
      const unresolvedEntry = /textbox|input|textarea|select|combobox|spinbutton|date/.test(shape)
        && (
          control.required === true
          || control.state?.required === true
          || ownsValidation
        );
      return unresolvedEntry;
    })
    .sort((left, right) => right.priority - left.priority);
  const candidateControls = rankedControls.slice(0, MAX_COMPONENTS).map((entry) => entry.control);
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
  const hasUnknownRequiredControl = candidateControls.some((control) => {
    const semantic = controlSemantic(control);
    return (control.required === true || control.state?.required === true)
      && (!semantic || ["unknown", "choice", "field", "value_field", "input", "control"].includes(semantic));
  });
  return Object.freeze({
    needed: Boolean(candidateControls.length && (
      semanticClosureIncomplete
      ||
      stageContradiction.contradictory
      || hasUnknownRequiredControl
      || unownedValidationIssues.length
      || unownedControlIds.size
      || rankedControls.some((entry) => (
        entry.priority >= 80
        && (progressionBlocked || stageContradiction.contradictory)
      ))
    )),
    components: candidateControls,
    facts,
    validationIssues: unownedValidationIssues,
    allowedBindings,
    allowedValidationOwners,
    stageContradiction,
    pageContext: Object.freeze({
      declaredStage: clean(page.step || "unknown"),
      url: clean(page.url || observation.url, 1_000),
      text: clean(page.text || page.sceneContext?.primaryText, 3_500),
      headingText: clean(page.heading || page.sceneContext?.headingText, 800),
      activeProgressText: clean(page.sceneContext?.activeProgressText, 500),
      terminalEvidence: page.terminalEvidence || null,
      stageExit: page.stageExit || null,
      checkoutSceneClosure: checkoutScene?.closure || null,
      price: page.price || null
    })
  });
}

function applyScenePatch(semanticCompilation = {}, response = {}, uncertainty = {}, observation = {}) {
  const allowedBindings = new Set((uncertainty.allowedBindings || []).map((binding) => (
    `${binding.controlId}|${binding.semanticType}|${binding.factSource}`
  )));
  const allowedOwners = new Set((uncertainty.allowedValidationOwners || []).map((owner) => (
    `${owner.validationIssueId}|${owner.controlId}`
  )));
  const candidateControlIds = new Set((uncertainty.components || []).map((control) => control.controlId));
  const accepted = (response.hypotheses || []).filter((hypothesis) => {
    if (!["high", "medium"].includes(hypothesis.confidence)) return false;
    if (!candidateControlIds.has(hypothesis.controlId)) return false;
    if (!SEMANTIC_SCENE_ROLES.includes(hypothesis.role)) return false;
    if (!SEMANTIC_SCENE_REQUIREDNESS.includes(hypothesis.requiredness)) return false;
    if (!SEMANTIC_SCENE_CONSEQUENCES.includes(hypothesis.consequence)) return false;
    if ((hypothesis.relatedControlIds || []).some((controlId) => !candidateControlIds.has(controlId))) return false;
    const bindingAllowed = PROFILE_ROLES.has(hypothesis.role)
      ? allowedBindings.has(`${hypothesis.controlId}|${hypothesis.semanticType}|${hypothesis.factSource}`)
      : Boolean(
          hypothesis.factSource === ""
          && NON_PROFILE_TYPES_BY_ROLE[hypothesis.role]?.has(hypothesis.semanticType)
        );
    const ownerAllowed = !hypothesis.validationIssueId
      || allowedOwners.has(`${hypothesis.validationIssueId}|${hypothesis.controlId}`);
    return bindingAllowed && ownerAllowed;
  }).slice(0, 10);
  const bindingByControl = new Map(accepted.map((hypothesis) => [hypothesis.controlId, hypothesis]));
  // ScenePatch is a closed-ID semantic annotation over the already-compiled
  // deterministic result. It never mutates the raw observation and never
  // reruns the semantic compiler. In particular it cannot change requiredness,
  // risk, stage, navigation, permission, transaction truth or completion.
  const controls = (semanticCompilation.controls || []).map((control) => {
    const hypothesis = bindingByControl.get(control.controlId);
    if (!hypothesis) return control;
    const sceneItem = {
      role: hypothesis.role,
      semanticType: hypothesis.semanticType,
      factSource: hypothesis.factSource,
      requiredness: hypothesis.requiredness,
      consequence: hypothesis.consequence,
      confidence: hypothesis.confidence,
      evidence: clean(hypothesis.evidence),
      relatedControlIds: [...new Set([control.controlId, ...(hypothesis.relatedControlIds || [])])],
      grounded: true
    };
    if (!PROFILE_ROLES.has(hypothesis.role)) return { ...control, semanticSceneItem: sceneItem };
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
      },
      semanticSceneItem: sceneItem
    };
  });
  const fields = (semanticCompilation.fields || observation.page?.fields || []).map((field) => {
    const hypothesis = bindingByControl.get(field.controlId);
    if (!hypothesis) return field;
    if (!PROFILE_ROLES.has(hypothesis.role)) return { ...field, semanticSceneItem: hypothesis };
    const control = controls.find((candidate) => candidate.controlId === field.controlId) || {};
    return {
      ...field,
      field: hypothesis.semanticType,
      fieldType: hypothesis.semanticType,
      semantic: hypothesis.semanticType,
      required: field.required,
      semanticSceneItem: hypothesis
    };
  });
  const validationIssues = (semanticCompilation.validationIssues || observation.page?.validationIssues || []).map((issue) => {
    const hypothesis = accepted.find((candidate) => candidate.validationIssueId === issue.issueId);
    return hypothesis
      ? { ...issue, controlId: hypothesis.controlId, semanticType: hypothesis.semanticType, ownershipSource: "grounded_semantic_scene" }
      : issue;
  });
  const proposedStage = SEMANTIC_SCENE_STAGES.includes(response.stage) ? response.stage : "unknown";
  const stageGrounded = ["high", "medium"].includes(response.stageConfidence) && proposedStage !== "unknown";
  const grounded = accepted.length > 0 || stageGrounded;
  return {
    ...semanticCompilation,
    controls,
    fields,
    validationIssues,
    semanticSceneReconciliation: {
      status: grounded ? "grounded" : "unknown",
      authority: "hypothesis_only",
      declaredStage: clean(observation.page?.step || "unknown"),
      stage: proposedStage,
      stageApplied: false,
      stageConfidence: response.stageConfidence || "low",
      stageEvidence: clean(response.stageEvidence),
      contradictionReasons: [...(uncertainty.stageContradiction?.reasons || [])],
      hypotheses: accepted.map((hypothesis) => ({ ...hypothesis, evidence: clean(hypothesis.evidence) }))
    }
  };
}

function semanticScenePayload(observation = {}, scene = {}) {
  return {
    scene: {
      stage: observation.page?.step || "unknown",
      pageContext: scene.pageContext || null,
      contradiction: scene.stageContradiction || null,
      surface: observation.page?.currentSurface
        ? {
            id: clean(observation.page.currentSurface.id),
            type: clean(observation.page.currentSurface.type),
            label: clean(observation.page.currentSurface.label),
            taskHint: clean(observation.page.currentSurface.taskHint)
          }
        : null,
      components: (scene.components || []).map((control) => ({
        controlId: control.controlId,
        label: clean(control.label || control.accessibleName),
        name: clean(control.name),
        placeholder: clean(control.placeholder),
        helperText: clean(control.accessibleDescription || control.helperText || control.description, 500),
        sectionLabel: clean(control.sectionLabel),
        required: control.required === true || control.state?.required === true,
        state: {
          valuePresent: control.state?.valuePresent === true,
          selected: control.state?.selected === true,
          checked: control.state?.checked === true,
          pressed: control.state?.pressed === true,
          disabled: control.state?.disabled === true,
          invalid: control.state?.invalid === true,
          expanded: control.state?.expanded === true
        },
        semantic: clean(control.fieldType || control.field || control.semantic),
        risk: clean(control.risk),
        structuredPrice: control.structuredPrice || null,
        options: (control.options || []).slice(0, 20).map((option) => ({
          value: clean(option?.value, 120),
          label: clean(option?.label || option?.text, 180),
          selected: option?.selected === true,
          disabled: option?.disabled === true
        })),
        operations: operationNames(control)
      })),
      validationIssues: (scene.validationIssues || []).map((issue) => ({
        validationIssueId: issue.issueId,
        message: clean(issue.message)
      }))
    },
    availableFacts: (scene.facts || []).map((fact) => ({
      semanticType: fact.semanticType,
      factSource: fact.factSource,
      valuePreview: fact.valuePreview
    })),
    outputAuthority: "grounded_hypothesis_only"
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
  if (!scene.needed) return { scenePatch: null, reconciliation: null, meta: null };
  const { data, meta } = await callStructured({
    apiKey,
    model,
    instructions: INSTRUCTIONS,
    payload: semanticScenePayload(observation, scene),
    screenshotDataUrl,
    schema: semanticSceneSchemaFor(
      scene.components.map((control) => control.controlId),
      scene.facts.map((fact) => fact.semanticType),
      scene.facts.map((fact) => fact.factSource),
      scene.validationIssues.map((issue) => issue.issueId)
    ),
    schemaName: "semantic_scene_reconciliation",
    maxOutputTokens: 1_100,
    returnMeta: true,
    maxPayloadBytes: MAX_PACKET_BYTES
  });
  const response = {
    status: String(data?.status || "unknown"),
    stage: String(data?.stage || "unknown"),
    stageConfidence: String(data?.stageConfidence || "low").toLowerCase(),
    stageEvidence: clean(data?.stageEvidence),
    hypotheses: Array.isArray(data?.hypotheses) ? data.hypotheses.map((hypothesis) => ({
      controlId: String(hypothesis?.controlId || ""),
      role: String(hypothesis?.role || "unknown"),
      semanticType: String(hypothesis?.semanticType || "unknown"),
      factSource: String(hypothesis?.factSource || ""),
      validationIssueId: String(hypothesis?.validationIssueId || ""),
      relatedControlIds: Array.isArray(hypothesis?.relatedControlIds)
        ? hypothesis.relatedControlIds.map(String).filter(Boolean).slice(0, 8)
        : [],
      requiredness: String(hypothesis?.requiredness || "unknown"),
      consequence: String(hypothesis?.consequence || "unknown"),
      confidence: String(hypothesis?.confidence || "low").toLowerCase(),
      evidence: clean(hypothesis?.evidence)
    })) : []
  };
  // The model returns a neutral closed-ID patch. It does not mutate the
  // observation and cannot publish action, risk, permission, completion or a
  // stage exit. CheckoutScene validates/applies this patch exactly once.
  const scenePatch = response.status === "grounded"
    ? Object.freeze({
        contractVersion: "scene-patch/v1",
        patchId: `patch:${clean(observation.observationId || "observation")}:${crypto.createHash("sha256").update(JSON.stringify(response)).digest("hex").slice(0, 16)}`,
        ...response,
        uncertainty: scene
      })
    : null;
  const reconciliation = scenePatch
    ? Object.freeze({
        status: "grounded",
        authority: "hypothesis_only",
        stage: response.stage,
        stageConfidence: response.stageConfidence,
        stageEvidence: response.stageEvidence,
        hypothesisCount: response.hypotheses.length
      })
    : Object.freeze({
        status: "unknown",
        authority: "hypothesis_only",
        stage: response.stage,
        stageConfidence: response.stageConfidence,
        stageEvidence: response.stageEvidence,
        hypothesisCount: 0
      });
  return {
    scenePatch,
    reconciliation,
    meta
  };
}

module.exports = {
  semanticSceneUncertainty,
  semanticScenePayload,
  applyScenePatch,
  reconcileSemanticScene
};
