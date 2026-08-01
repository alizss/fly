const {
  normalizeAction,
  isCandidateGrounded,
  semanticGoalKey,
  visualRegionsMatch
} = require("../../../packages/shared/agent-actions");
const agentContract = require("../../extension/src/shared/agent-contract");
const { conflictedControlIds } = require("./control-alias-index");
const { currentSurface: authoritativeCurrentSurface } = require("./surface-contract");
const { deriveActionSemantics } = require("./action-semantics");
const { normalizeCanonicalDate } = require("./date-field-codec");
const {
  DATE_FIELDS,
  normalizeProfileFieldType,
  semanticTypeForControl,
  canonicalValue: canonicalLogicalValue,
  desiredProfileValue,
  resolveLogicalFields,
  bindResolvedComponentToCurrentPage,
  logicalFieldSatisfied,
  verifyLogicalField
} = require("./logical-field");
const { profileFieldLabel } = require("./profile-context");

const COMPOUND_ACTIONS = new Set(["fill_known_fields", "fill_visible_profile_fields"]);
const PLACEHOLDER_FIELD_VALUE = /^(?:choose|select|please select|select one(?: option)?|please choose|month|day|year|title|gender|nationality|country)$/i;
const NON_BLOCKING_PROFILE_FIELDS = new Set([
  "middle_name",
  "second_last_name",
  "address_line2",
  "frequent_flyer_program",
  "frequent_flyer_number",
  "known_traveler_number",
  "redress_number",
  "emergency_contact_name",
  "emergency_contact_relationship",
  "emergency_contact_phone",
  "emergency_contact_email",
  "meal_preference",
  "special_assistance"
]);

const PROFILE_FIELDS = new Set([
  "email",
  "confirm_email",
  "phone_country_code",
  "phone",
  "title",
  "first_name",
  "middle_name",
  "last_name",
  "second_last_name",
  "full_name",
  "gender",
  "date_of_birth",
  "place_of_birth",
  "nationality",
  "country_of_residence",
  "document_type",
  "passport_number",
  "document_number",
  "issuing_country",
  "document_issue_date",
  "address_line1",
  "address_line2",
  "city",
  "state",
  "postal_code",
  "country",
  "passport_expiry",
  "document_expiry",
  "frequent_flyer_program",
  "frequent_flyer_number",
  "known_traveler_number",
  "redress_number",
  "emergency_contact_name",
  "emergency_contact_relationship",
  "emergency_contact_phone",
  "emergency_contact_email",
  "meal_preference",
  "special_assistance"
]);

const PROFILE_FIELD_ORDER = [
  "email",
  "confirm_email",
  "phone_country_code",
  "phone",
  "title",
  "first_name",
  "middle_name",
  "last_name",
  "second_last_name",
  "full_name",
  "date_of_birth",
  "place_of_birth",
  "nationality",
  "country_of_residence",
  "document_type",
  "passport_number",
  "document_number",
  "issuing_country",
  "document_issue_date",
  "address_line1",
  "address_line2",
  "city",
  "state",
  "postal_code",
  "country",
  "passport_expiry",
  "document_expiry",
  "frequent_flyer_program",
  "frequent_flyer_number",
  "known_traveler_number",
  "redress_number",
  "emergency_contact_name",
  "emergency_contact_relationship",
  "emergency_contact_phone",
  "emergency_contact_email",
  "meal_preference",
  "special_assistance"
];

function meaningfulObservedFieldValue(field = {}, control = {}) {
  const state = control.state || field.controlState || {};
  const raw = String(
    state.selectedValue
    || state.normalizedValue
    || control.currentValue
    || field.value
    || state.valueText
    || ""
  ).replace(/\s+/g, " ").trim();
  const selectLike = /select|combobox|listbox/.test(
    `${control.kind || field.kind || ""} ${control.role || field.role || ""} ${control.domRole || ""}`.toLowerCase()
  );
  if (selectLike && PLACEHOLDER_FIELD_VALUE.test(raw)) return "";
  if (raw) return raw;
  if (state.checked || state.selected) return "[selected]";
  return "";
}

function observedFieldHasValue(field = {}, control = {}) {
  const meaningfulValue = meaningfulObservedFieldValue(field, control);
  if (meaningfulValue) return true;
  const state = control.state || field.controlState || {};
  const selectLike = /select|combobox|listbox/.test(
    `${control.kind || field.kind || ""} ${control.role || field.role || ""} ${control.domRole || ""}`.toLowerCase()
  );
  if (selectLike) return false;
  return Boolean(field.hasValue || control.hasValue || state.valuePresent || state.checked || state.selected);
}

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function profileFieldsForPage(page = {}) {
  if (Array.isArray(page.fields) && page.fields.length) {
    return page.fields.map((field) => {
      const control = (page.controls || []).find((item) => item.controlId === field.controlId) || {};
      const fieldType = semanticTypeForControl(control, field);
      const normalized = {
        ...field,
        controlState: control.state || field.controlState || {},
        required: Boolean(
          field.required
          || control.required
          || control.state?.required
          || control.controlState?.required
        ),
        hasValue: observedFieldHasValue(field, control)
      };
      return fieldType ? { ...normalized, fieldType, field: fieldType } : normalized;
    });
  }
  return (page.controls || []).flatMap((control) => {
    const field = semanticTypeForControl(control, {});
    if (!PROFILE_FIELDS.has(field)) return [];
    const state = control.state || control.controlState || {};
    return [{
      ...control,
      id: control.stateElementId || control.controlId,
      field,
      fieldType: field,
      controlState: state,
      required: Boolean(control.required || state.required),
      hasValue: observedFieldHasValue({}, control),
      value: state.valuePresent ? "[filled]" : ""
    }];
  });
}

function disabledForwardNavigation(page = {}) {
  return (page.controls || []).filter((control) => {
    const text = String(
      `${control.semantic || ""} ${control.meaning || ""} ${control.label || ""} ${control.risk || ""}`
    ).toLowerCase();
    return /navigation|safe_continue|continue|next|proceed|advance|done|finish/.test(text)
      && (control.disabled === true || control.state?.disabled === true);
  });
}

function inferredProfileBlockers(page = {}, fields = [], traveler = {}) {
  const blockedNavigation = disabledForwardNavigation(page);
  if (!blockedNavigation.length) return [];
  const unresolvedRequiredDecision = (page.decisionGroups || []).some((group) => (
    group.required === true
    && !["satisfied", "waived", "waived_by_policy"].includes(String(group.status || "").toLowerCase())
  ));
  if (unresolvedRequiredDecision) return [];
  const candidates = fields.filter((field) => {
    const semanticType = normalizeProfileFieldType(field.fieldType || field.field || "");
    if (!PROFILE_FIELDS.has(semanticType) || NON_BLOCKING_PROFILE_FIELDS.has(semanticType)) return false;
    if (field.hasValue) return false;
    return !desiredProfileValue(semanticType, traveler);
  });
  const unique = candidates.filter((field, index, list) => {
    const semanticType = normalizeProfileFieldType(field.fieldType || field.field || "");
    return list.findIndex((other) => (
      normalizeProfileFieldType(other.fieldType || other.field || "") === semanticType
    )) === index;
  });
  // A disabled forward control proves that the form is incomplete. Preserve
  // every unresolved traveler fact as a queue instead of abandoning the form
  // when two airlines ask for different combinations of details.
  return unique
    .sort((left, right) => (
      PROFILE_FIELD_ORDER.indexOf(normalizeProfileFieldType(left.fieldType || left.field || ""))
      - PROFILE_FIELD_ORDER.indexOf(normalizeProfileFieldType(right.fieldType || right.field || ""))
    ))
    .map((field) => {
      const semanticType = normalizeProfileFieldType(field.fieldType || field.field || "");
      return {
        semanticType,
        controlId: String(field.controlId || ""),
        label: profileFieldLabel(semanticType),
        valueAvailable: false,
        inferredFrom: "disabled_navigation_unresolved_profile_fields",
        navigationControlIds: blockedNavigation.map((control) => control.controlId).filter(Boolean)
      };
    });
}

function ownedCurrentSurface(page = {}) {
  return authoritativeCurrentSurface(page);
}

function planScope(observation = {}) {
  const page = observation.page || {};
  const surface = ownedCurrentSurface(page);
  return {
    stage: String(page.step || "unknown"),
    surfaceId: String(surface?.id || ""),
    surfaceType: String(surface?.type || "page"),
    surfaceLabel: String(surface?.label || "").slice(0, 240)
  };
}

function fieldDescriptors(observation = {}, traveler = {}) {
  const page = observation.page || {};
  const logicalFields = resolveLogicalFields(page, traveler);
  const ordinals = new Map();
  const descriptors = logicalFields.flatMap((logicalField) => {
    if (!logicalField.desiredCanonicalValue) return [];
    const ordinal = ordinals.get(logicalField.semanticType) || 0;
    ordinals.set(logicalField.semanticType, ordinal + 1);
    const choiceComponents = logicalField.components.filter((component) => component.componentRole === "option");
    const components = choiceComponents.length
      ? choiceComponents.filter((component) => {
          const optionValue = component.control?.state?.optionValue
            || component.control?.value
            || component.control?.label
            || component.field?.label
            || "";
          return canonicalLogicalValue(logicalField.semanticType, optionValue)
            === canonicalLogicalValue(logicalField.semanticType, component.desiredValue);
        })
      : logicalField.components;

    return components.map((component) => {
      const control = component.control || {};
      const field = component.field || {};
      const descriptorSemanticType = component.semanticType || logicalField.semanticType;
      const choiceLike = component.componentRole === "option";
      const value = component.inputValue || component.desiredValue || "";
      const choiceTerms = [...(component.selectionTerms || [])];
      const dateCodec = component.expectedOutcome?.dateCodec || null;
      const selectedPeers = choiceLike
        ? logicalField.components.filter((candidate) => (
            candidate.controlId !== component.controlId
            && Boolean(
              candidate.control?.selected
              || candidate.control?.state?.selected
              || candidate.control?.state?.checked
            )
          ))
        : [];
      return {
        key: `${logicalField.logicalFieldId}:${component.componentRole}`,
        domOrder: Number(component.order ?? logicalField.order ?? 0),
        semanticType: descriptorSemanticType,
        ordinal,
        label: String(field.label || control.label || logicalField.semanticType).slice(0, 240),
        field,
        control,
        value,
        observedRole: control.role || field.role || "",
        observedCapabilities: control.capabilities || [],
        capabilityContracts: component.capabilityContracts || [],
        requirementContract: logicalField.requirementContract || component.requirementContract || null,
        bindingContract: component.bindingContract || null,
        expectedOutcome: component.expectedOutcome || null,
        validationOwnership: component.validationOwnership || null,
        choiceLike,
        choiceTerms,
        currentNormalizedValue: component.currentCanonicalValue || "",
        desiredNormalizedValue: component.desiredCanonicalValue || "",
        exactOption: component.exactOption || component.bindingContract?.component?.exactOption || null,
        canonicalValue: logicalField.desiredCanonicalValue || "",
        dateCodec,
        codecError: DATE_FIELDS.has(logicalField.semanticType) && !dateCodec ? {
          code: logicalField.ambiguity?.code || "AMBIGUOUS_DATE_FORMAT",
          reason: logicalField.ambiguity?.reason || "The observed date format is ambiguous."
        } : null,
        hasValue: logicalField.structure === "composite"
          ? component.status === "resolved"
          : component.status === "resolved" && logicalFieldSatisfied(logicalField),
        validationIssues: component.validationIssues || [],
        conflictingSelectedControlIds: selectedPeers.map((candidate) => candidate.controlId).filter(Boolean),
        logicalFieldId: logicalField.logicalFieldId,
        subjectId: logicalField.subjectId,
        componentRole: component.componentRole,
        logicalStructure: logicalField.structure,
        logicalCurrentCanonicalValue: logicalField.currentCanonicalValue || "",
        logicalDesiredCanonicalValue: logicalField.desiredCanonicalValue || "",
        logicalFieldSatisfied: logicalFieldSatisfied(logicalField),
        logicalFieldValidationIssues: logicalField.validationIssues || [],
        instructions: logicalField.instructions || [],
        options: logicalField.options || [],
        ambiguity: logicalField.ambiguity || null
      };
    });
  }).sort((left, right) => (
    left.domOrder - right.domOrder
    || left.ordinal - right.ordinal
    || String(left.componentRole).localeCompare(String(right.componentRole))
  ));
  return descriptors;
}

function descriptorOwnsActiveRequirement(descriptor = {}) {
  const control = descriptor.control || {};
  const field = descriptor.field || {};
  const required = Boolean(
    field.required
    || control.required
    || control.state?.required
    || control.controlState?.required
    || descriptor.requirementContract?.required
  );
  const ownsValidation = Boolean(
    (descriptor.validationIssues || []).length
    || (descriptor.logicalFieldValidationIssues || []).length
  );
  const actionability = [
    ...(descriptor.capabilityContracts || []).flatMap((contract) => [
      contract?.actionability,
      ...Object.values(contract?.actionabilityByActuator || {})
    ]),
    ...Object.values(control.operations || {}).flatMap((capability) => [
      capability?.actionability,
      ...Object.values(capability?.actionabilityByActuator || {})
    ]),
    ...Object.values(control.recovery || {}).flatMap((recovery) => [
      recovery?.actionability,
      ...Object.values(recovery?.actionabilityByActuator || {})
    ])
  ].filter(Boolean);
  const belongsToCurrentLifecycle = actionability.some((state) => (
    state.executable === true
    || state.revealable === true
    || (state.rendered === true && state.visible === true && state.inCurrentSurface !== false)
  ));
  return required || ownsValidation || belongsToCurrentLifecycle;
}

function profileStageReadiness(observation = {}, traveler = {}) {
  const page = observation.page || {};
  const fields = profileFieldsForPage(page);
  const descriptors = fieldDescriptors(observation, traveler);
  const step = String(page.step || "").toLowerCase();
  const hasProfileControls = fields.some((field) => PROFILE_FIELDS.has(normalizeProfileFieldType(field.fieldType || field.field || "")));
  const profileStage = hasProfileControls || /traveler|traveller|passenger|contact|document/.test(step);
  const unresolvedKnown = descriptors
    .filter(descriptorOwnsActiveRequirement)
    .filter((descriptor) => !descriptor.hasValue)
    .map((descriptor) => ({
      semanticType: descriptor.semanticType,
      controlId: descriptor.control?.controlId || "",
      label: descriptor.label || descriptor.semanticType,
      currentNormalizedValue: descriptor.currentNormalizedValue || "",
      desiredNormalizedValue: descriptor.desiredNormalizedValue || ""
    }));
  const explicitUnresolvedRequired = fields.flatMap((field) => {
    if (!field.required) return [];
    const semanticType = normalizeProfileFieldType(field.fieldType || field.field || "");
    if (!PROFILE_FIELDS.has(semanticType)) return [];
    const canonicalValue = desiredProfileValue(semanticType, traveler);
    if (canonicalValue && descriptors.some((descriptor) => descriptor.semanticType === semanticType && descriptor.hasValue)) return [];
    if (canonicalValue && descriptors.some((descriptor) => descriptor.semanticType === semanticType && !descriptor.hasValue)) return [];
    const state = field.controlState || {};
    const satisfied = Boolean(field.hasValue || state.valuePresent || state.checked || state.selected);
    if (canonicalValue && satisfied) return [];
    return [{
      semanticType,
      controlId: String(field.controlId || ""),
      label: profileFieldLabel(semanticType),
      valueAvailable: Boolean(canonicalValue)
    }];
  });
  const unresolvedRequired = [
    ...explicitUnresolvedRequired,
    ...inferredProfileBlockers(page, fields, traveler)
  ].filter((item, index, list) => list.findIndex((other) => other.semanticType === item.semanticType) === index);
  const missingUserData = unresolvedRequired.filter((item) => item.valueAvailable === false);
  const profileControlIds = new Set(fields
    .filter((field) => PROFILE_FIELDS.has(normalizeProfileFieldType(field.fieldType || field.field || "")))
    .map((field) => String(field.controlId || ""))
    .filter(Boolean));
  const validationIssues = scopedValidationIssues(page, {
    controlIds: profileControlIds,
    sectionTypes: new Set(["contact", "passenger", "traveler", "traveller", "document"])
  });
  const visibleErrors = validationIssues.map(validationIssueMessage);
  return {
    profileStage,
    hasProfileControls,
    ready: !profileStage || (!unresolvedKnown.length && !unresolvedRequired.length && !visibleErrors.length),
    shouldOwn: profileStage && unresolvedKnown.length > 0,
    unresolvedKnown,
    unresolvedRequired,
    missingUserData,
    visibleErrors
  };
}

function atomFromDescriptor(planId, descriptor, observationId) {
  const desiredNormalizedValue = descriptor.desiredNormalizedValue
    || canonicalLogicalValue(descriptor.semanticType, descriptor.value);
  return {
    atomId: `${planId}:${descriptor.key}`,
    descriptorKey: descriptor.key,
    kind: "profile_field",
    semanticType: descriptor.semanticType,
    ordinal: descriptor.ordinal,
    logicalFieldId: descriptor.logicalFieldId || "",
    subjectId: descriptor.subjectId || "traveler_1",
    componentRole: descriptor.componentRole || "value",
    label: descriptor.label,
    semanticGoal: {
      semanticType: descriptor.semanticType,
      desiredValue: desiredNormalizedValue || descriptor.value || ""
    },
    postcondition: {
      type: DATE_FIELDS.has(descriptor.semanticType) ? "date_value_committed" : "normalized_value_changed",
      expectedValue: desiredNormalizedValue || descriptor.value || "",
      expectedCanonicalValue: descriptor.canonicalValue || "",
      dateCodec: descriptor.dateCodec || null
    },
    valueRef: `profile://${descriptor.semanticType}`,
    expectedValue: descriptor.value,
    expectedNormalizedValue: desiredNormalizedValue,
    expectedCanonicalValue: descriptor.canonicalValue || "",
    dateCodec: descriptor.dateCodec || null,
    choiceTerms: descriptor.choiceTerms || [],
    strategyHistory: [],
    maxStrategyAttempts: 3,
    status: descriptor.hasValue ? "satisfied" : "pending",
    attempts: 0,
    lastActionId: "",
    lastControlId: "",
    createdObservationId: observationId,
    completedObservationId: descriptor.hasValue ? observationId : "",
    completionSource: descriptor.hasValue ? "current_observation" : ""
  };
}

function createSkillPlan(action, observation = {}, traveler = {}) {
  if (!COMPOUND_ACTIONS.has(action?.type)) return null;
  const planId = uid("skill");
  const observationId = String(observation.observationId || "");
  const atoms = fieldDescriptors(observation, traveler)
    .map((descriptor) => atomFromDescriptor(planId, descriptor, observationId));
  return {
    planId,
    skillType: action.type,
    parentActionId: String(action.id || ""),
    status: atoms.some((atom) => atom.status === "pending") ? "running" : "complete",
    scope: planScope(observation),
    atoms,
    createdObservationId: observationId,
    lastObservedObservationId: observationId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: atoms.some((atom) => atom.status === "pending") ? "" : new Date().toISOString(),
    suspendedReason: ""
  };
}

function clonePlan(plan = {}) {
  return {
    ...plan,
    scope: { ...(plan.scope || {}) },
    atoms: (plan.atoms || []).map((atom) => ({
      ...atom,
      semanticGoal: { ...(atom.semanticGoal || {}) },
      postcondition: { ...(atom.postcondition || {}) },
      choiceTerms: [...(atom.choiceTerms || [])],
      strategyHistory: [...(atom.strategyHistory || [])]
    }))
  };
}

function currentProfileSkillAtom(plan = {}) {
  return (plan.atoms || []).find((atom) => !["complete", "satisfied"].includes(atom.status)) || null;
}

function suspendPlan(plan, reason, observationId = "") {
  return {
    ...plan,
    status: "suspended",
    suspendedReason: String(reason || "Skill execution became ambiguous.").slice(0, 500),
    lastObservedObservationId: observationId || plan.lastObservedObservationId || "",
    updatedAt: new Date().toISOString()
  };
}

function validationIssueMessage(issue = {}) {
  if (typeof issue === "string") return issue;
  return String(issue.message || issue.text || issue.label || "");
}

function scopedValidationIssues(page = {}, scope = {}) {
  const issues = Array.isArray(page.validationIssues) && page.validationIssues.length
    ? page.validationIssues
    : (page.errors || []).map((message) => ({ message: String(message || ""), stageWide: true }));
  const controlIds = scope.controlIds instanceof Set ? scope.controlIds : new Set(scope.controlIds || []);
  const sectionIds = scope.sectionIds instanceof Set ? scope.sectionIds : new Set(scope.sectionIds || []);
  const sectionTypes = scope.sectionTypes instanceof Set ? scope.sectionTypes : new Set(scope.sectionTypes || []);
  const surfaceIds = scope.surfaceIds instanceof Set ? scope.surfaceIds : new Set(scope.surfaceIds || []);
  return issues.filter((issue) => {
    if (!issue || !validationIssueMessage(issue)) return false;
    if (typeof issue === "string" || issue.stageWide === true) return true;
    // Ownership is hierarchical and exclusive: a control-owned issue cannot
    // fall through and invalidate every control in its containing section.
    if (issue.controlId) return controlIds.has(String(issue.controlId));
    if (issue.sectionId) return sectionIds.has(String(issue.sectionId));
    if (issue.sectionType) return sectionTypes.has(String(issue.sectionType).toLowerCase());
    if (issue.surfaceId) return surfaceIds.has(String(issue.surfaceId));
    return false;
  });
}

function blockedObligationForPlan(plan = {}, observation = {}, traveler = {}, existing = null, blocker = {}) {
  const context = skillRecoveryContext(plan, observation, traveler, { blockedObligation: existing });
  if (!context?.atomId || !context?.controlId) return null;
  const sameOwner = existing
    && existing.owner?.skillPlanId === context.planId
    && existing.owner?.atomId === context.atomId;
  const at = new Date().toISOString();
  const attemptedStrategyIds = new Set([
    ...(sameOwner ? existing.attempts || [] : []),
    ...(sameOwner ? existing.rejectedBeforeDispatch || [] : [])
  ].map((attempt) => attempt.strategyId).filter(Boolean));
  const supportedStrategies = (context.supportedStrategies || [])
    .filter((strategy) => !attemptedStrategyIds.has(strategy.strategyId));
  return {
    obligationId: sameOwner ? existing.obligationId : `blocked:${context.planId}:${context.atomId}`,
    kind: "skill_atom_recovery",
    owner: {
      skillPlanId: context.planId,
      atomId: context.atomId,
      skillType: context.skillType,
      semanticType: context.semanticType,
      ordinal: context.ordinal
    },
    scope: {
      stage: String(observation.page?.step || ""),
      surfaceId: String(authoritativeCurrentSurface(observation.page || {}).id || "")
    },
    control: {
      controlId: context.controlId,
      label: context.controlLabel || context.label,
      semanticType: context.semanticType
    },
    semanticGoal: { ...(context.semanticGoal || {}) },
    postcondition: { ...(context.expectedPostcondition || {}) },
    supportedStrategies: supportedStrategies.map((strategy) => ({ ...strategy })),
    blocker: {
      code: String(blocker.code || existing?.blocker?.code || "ACTUATOR_UNPROVEN"),
      message: String(blocker.message || plan.suspendedReason || context.suspendedReason || "The owned atomic operation has no proven actuator.").slice(0, 500),
      observationId: String(observation.observationId || ""),
      at
    },
    expectedResult: {
      type: "normalized_value_changed",
      controlId: context.controlId,
      expectedNormalizedValue: context.expectedNormalizedValue || ""
    },
    attempts: sameOwner ? [...(existing.attempts || [])] : [],
    proofs: sameOwner ? [...(existing.proofs || [])] : [],
    status: "blocked",
    finalStatus: sameOwner ? existing.finalStatus || "pending" : "pending",
    finalReason: sameOwner ? existing.finalReason || "" : "",
    createdAt: sameOwner ? existing.createdAt || at : at,
    updatedAt: at
  };
}

function expectedSuccessCode(expectedType = "") {
  return {
    options_surface_appeared: "OPTIONS_SURFACE_APPEARED",
    normalized_value_changed: "NORMALIZED_VALUE_VERIFIED",
    date_value_committed: "DATE_VALUE_VERIFIED",
    field_value_changed: "FIELD_VALUE_VERIFIED",
    control_selected: "CONTROL_SELECTED",
    semantic_progress: "SEMANTIC_PROGRESS_OBSERVED"
  }[expectedType] || "";
}

function exactRecoveryProof(obligation = {}, result = {}) {
  const pending = obligation.pendingAction || {};
  const expected = pending.expectedOutcome || {};
  const resultExpected = result.expectedOutcome || {};
  const outcomeCode = resultCode(result);
  const expectedCode = expectedSuccessCode(expected.type);
  const resultControlId = String(result.controlId || result.action?.controlId || result.targetSnapshot?.controlId || resultExpected.controlId || "");
  return Boolean(
    browserDispatched(result)
    && result.verified === true
    && result.skillPlanId === obligation.owner?.skillPlanId
    && result.skillAtomId === obligation.owner?.atomId
    && resultControlId === pending.controlId
    && result.operation === pending.operation
    && resultExpected.type === expected.type
    && String(resultExpected.controlId || "") === String(expected.controlId || "")
    && (!expectedCode || outcomeCode === expectedCode)
  );
}

function recordBlockedObligationAttempt(obligation = {}, action = {}) {
  if (!obligation?.obligationId || !["click", "type", "select", "click_xy", "keypress"].includes(action.type)) return obligation;
  const at = new Date().toISOString();
  return {
    ...obligation,
    status: "governed",
    pendingAction: {
      strategyId: actionSignatureForStrategy(action),
      actionId: action.id || "",
      observationId: action.observationId || "",
      controlId: action.controlId || "",
      targetId: action.targetId || "",
      visualRegion: action.visualRegion || null,
      operation: action.operation || "",
      actionType: action.type || "",
      interactionMethod: action.interactionMethod || "",
      value: action.value || "",
      keys: action.keys || "",
      expectedOutcome: action.expectedOutcome || null,
      status: "governed",
      at
    },
    updatedAt: at
  };
}

function actionSignatureForStrategy(action = {}) {
  const targetIdentity = ["type", "select", "keypress"].includes(action.type || "")
    ? ""
    : action.targetId || "";
  return [
    action.type || "",
    action.operation || "",
    targetIdentity,
    action.interactionMethod || "",
    action.value || "",
    action.keys || "",
    action.visualRegion ? `${action.visualRegion.x || 0},${action.visualRegion.y || 0}` : ""
  ].join(":");
}

function reconcileBlockedObligationResult(obligation = {}, result = {}) {
  if (!obligation?.obligationId || !result?.actionId) return { obligation, exact: false };
  const pending = obligation.pendingAction?.actionId === result.actionId ? obligation.pendingAction : null;
  if (!pending) return { obligation, exact: false };
  const dispatched = browserDispatched(result);
  const completedAt = new Date().toISOString();
  const attempts = dispatched ? [
    ...(obligation.attempts || []),
    {
      ...pending,
      attempt: (obligation.attempts || []).length + 1,
      status: result.verified === true ? "verified" : "failed",
      resultCode: resultCode(result) || "",
      completedAt
    }
  ] : [...(obligation.attempts || [])];
  const rejectedBeforeDispatch = dispatched ? [...(obligation.rejectedBeforeDispatch || [])] : [
    ...(obligation.rejectedBeforeDispatch || []),
    {
      ...pending,
      status: "rejected_before_dispatch",
      resultCode: resultCode(result) || "",
      completedAt
    }
  ];
  const exact = exactRecoveryProof(obligation, result);
  const proof = exact ? {
    skillPlanId: result.skillPlanId,
    atomId: result.skillAtomId,
    controlId: obligation.control?.controlId || "",
    operation: result.operation,
    expectedOutcome: result.expectedOutcome,
    outcomeCode: resultCode(result),
    actionId: result.actionId,
    observationId: result.observationId || "",
    at: new Date().toISOString()
  } : null;
  return {
    exact,
    obligation: {
      ...obligation,
      attempts,
      rejectedBeforeDispatch,
      pendingAction: null,
      proofs: proof ? [...(obligation.proofs || []), proof] : [...(obligation.proofs || [])],
      status: exact ? "progressed" : "blocked",
      updatedAt: new Date().toISOString()
    }
  };
}

const REISSUABLE_STALE_RESULT_CODES = new Set([
  "OBSERVATION_HASH_MISMATCH",
  "STALE_OBSERVATION",
  "PAGE_CHANGED_BEFORE_ACTION",
  "TARGET_OBSERVATION_DRIFT"
]);

function resultCode(result = {}) {
  return String(result?.outcome?.code || result?.code || result?.result?.code || "");
}

function shouldReissueUnexecutedAtom(result = {}) {
  return !browserDispatched(result) && REISSUABLE_STALE_RESULT_CODES.has(resultCode(result));
}

function browserDispatched(result = {}) {
  return result.dispatched === true || result.executed === true || result.verified === true;
}

function reconcileDispatchedAtom(plan, lastActionResult = {}, observationId = "") {
  const dispatched = plan.atoms.find((atom) => ["proposed", "governed", "dispatched"].includes(atom.status));
  if (!dispatched) return { plan, ambiguous: false };
  const resultActionId = String(lastActionResult?.actionId || "");
  if (!resultActionId || resultActionId !== dispatched.lastActionId) {
    return {
      plan: suspendPlan(plan, `No exact result was received for skill atom ${dispatched.atomId}.`, observationId),
      ambiguous: true
    };
  }
  if (!browserDispatched(lastActionResult)) {
    const stale = shouldReissueUnexecutedAtom(lastActionResult);
    if (!stale && dispatched.lastStrategyId) {
      dispatched.strategyHistory = [
        ...(dispatched.strategyHistory || []),
        {
          strategyId: dispatched.lastStrategyId,
          operation: dispatched.lastOperation || "",
          targetId: dispatched.lastTargetId || "",
          value: dispatched.lastStrategyValue || "",
          keys: dispatched.lastStrategyKeys || "",
          status: "rejected_before_dispatch",
          resultCode: resultCode(lastActionResult) || "ACTION_NOT_DISPATCHED",
          observationId,
          at: new Date().toISOString()
        }
      ].slice(-20);
    }
    dispatched.lastRejectedActionId = dispatched.lastActionId;
    dispatched.lastRejectedObservationId = dispatched.lastObservationId || "";
    dispatched.lastRejectionCode = resultCode(lastActionResult);
    dispatched.lastActionId = "";
    dispatched.lastControlId = "";
    dispatched.lastObservationId = "";
    dispatched.reissueCount = Number(dispatched.reissueCount || 0) + 1;
    if (stale) {
      dispatched.status = "pending";
      return { plan, ambiguous: false, reissue: true, rejectedBeforeDispatch: true };
    }
    dispatched.status = "pending";
    return { plan, ambiguous: false, rejectedBeforeDispatch: true, recovery: true };
  }
  dispatched.attempts = Number(dispatched.attempts || 0) + 1;
  dispatched.lastDispatchedActionId = dispatched.lastActionId;
  dispatched.strategyHistory = [
    ...(dispatched.strategyHistory || []),
    {
      strategyId: dispatched.lastStrategyId || "",
      operation: dispatched.lastOperation || lastActionResult.operation || "",
      targetId: dispatched.lastTargetId || "",
      value: dispatched.lastStrategyValue || "",
      keys: dispatched.lastStrategyKeys || "",
      status: lastActionResult.verified === true ? "verified_intermediate" : "failed",
      resultCode: resultCode(lastActionResult) || (lastActionResult.verified === true ? "VERIFIED" : "OUTCOME_NOT_VERIFIED"),
      observationId,
      at: new Date().toISOString()
    }
  ].slice(-20);
  if (lastActionResult.verified !== true) {
    const code = resultCode(lastActionResult) || "OUTCOME_NOT_VERIFIED";
    if (Number(dispatched.attempts || 0) < Number(dispatched.maxStrategyAttempts || 4)) {
      dispatched.status = "pending";
      dispatched.lastFailedActionId = dispatched.lastActionId;
      dispatched.lastFailureCode = code;
      dispatched.lastActionId = "";
      dispatched.lastControlId = "";
      dispatched.lastObservationId = "";
      dispatched.recoveryCount = Number(dispatched.recoveryCount || 0) + 1;
      return { plan, ambiguous: false, recovery: true };
    }
    return {
      plan: suspendPlan(plan, `Skill atom ${dispatched.atomId} failed exact verification (${code}).`, observationId),
      ambiguous: true
    };
  }
  dispatched.status = "pending";
  dispatched.lastProgressObservationId = observationId;
  dispatched.lastActionId = "";
  dispatched.lastControlId = "";
  dispatched.lastObservationId = "";
  dispatched.verificationCode = String(lastActionResult?.outcome?.code || "VERIFIED");
  return { plan, ambiguous: false, progress: true };
}

function extendPlan(plan, observation = {}, traveler = {}) {
  const observationId = String(observation.observationId || "");
  const existing = new Set((plan.atoms || []).map((atom) => atom.descriptorKey || `${atom.semanticType}:${atom.ordinal}`));
  for (const descriptor of fieldDescriptors(observation, traveler)) {
    if (existing.has(descriptor.key)) continue;
    plan.atoms.push(atomFromDescriptor(plan.planId, descriptor, observationId));
    existing.add(descriptor.key);
  }
  return plan;
}

function descriptorForAtom(atom, observation = {}, traveler = {}) {
  const descriptors = fieldDescriptors(observation, traveler);
  const base = (
    (atom.descriptorKey
      ? descriptors.find((descriptor) => descriptor.key === atom.descriptorKey)
      : null)
    || (atom.logicalFieldId
      ? descriptors.find((descriptor) => (
          descriptor.logicalFieldId === atom.logicalFieldId
          && descriptor.componentRole === atom.componentRole
        ))
      : null)
    || descriptors.find((descriptor) => (
      descriptor.semanticType === atom.semanticType
      && descriptor.ordinal === atom.ordinal
    ))
    || null
  );
  const currentBinding = bindResolvedComponentToCurrentPage(observation.page || {}, {
    selectionTerms: base?.choiceTerms || atom.choiceTerms || [],
    requirementContract: base?.requirementContract || null,
    componentBinding: base?.bindingContract?.component || null,
    controlId: base?.control?.controlId || "",
    desiredValue: base?.desiredNormalizedValue || atom.expectedNormalizedValue || "",
    desiredCanonicalValue: base?.canonicalValue || atom.expectedCanonicalValue || "",
    inputValue: base?.value || atom.expectedValue || "",
    expectedOutcome: base?.expectedOutcome || atom.postcondition || null,
    validationOwnership: base?.validationOwnership || null
  });
  if (currentBinding) {
    return {
      ...(base || {}),
      label: currentBinding.control.label || atom.label,
      field: { kind: currentBinding.control.kind || currentBinding.control.role || "option" },
      control: currentBinding.control,
      observedOption: true,
      exactOption: currentBinding.componentBinding?.exactOption || base?.exactOption || null,
      choiceTerms: currentBinding.selectionTerms,
      value: currentBinding.inputValue,
      requirementContract: currentBinding.requirementContract,
      bindingContract: currentBinding.pipelineBinding,
      capabilityContracts: currentBinding.capabilityContracts,
      expectedOutcome: currentBinding.expectedOutcome,
      validationOwnership: currentBinding.validationOwnership,
      hasValue: base?.reconciliation
        ? false
        : Boolean(
            currentBinding.control.selected
            || currentBinding.control.state?.selected
            || currentBinding.control.state?.checked
          ),
      reconciliation: base?.reconciliation || null,
      goalControl: base?.control || null,
      goalControlId: currentBinding.goalControlId
    };
  }
  return base;
}

function skillRecoveryContext(plan = {}, observation = {}, traveler = {}, state = {}) {
  const atom = currentProfileSkillAtom(plan);
  if (!atom) return null;
  const descriptor = descriptorForAtom(atom, observation, traveler);
  const control = descriptor?.goalControl || descriptor?.control || null;
  const supportedStrategies = strategyCandidatesForAtom(atom, descriptor, observation);
  const page = observation.page || {};
  const accessibilityCandidates = (page.accessibility?.controls || [])
    .filter((item) => item.controlId === control?.controlId)
    .slice(0, 12);
  const browserHitTargets = supportedStrategies.flatMap((strategy) => strategy.targetIds || []).slice(0, 12);
  const screenshotTargets = (page.screenshotAnnotations || [])
    .filter((item) => item.controlId === control?.controlId)
    .slice(0, 12);
  const failedDispatchedAttempts = (state.failures || [])
    .filter((failure) => failure.controlId === control?.controlId)
    .slice(-12);
  return {
    observationId: observation.observationId || "",
    planId: plan.planId || "",
    skillType: plan.skillType || "",
    atomId: atom.atomId || "",
    semanticType: atom.semanticType || "",
    ordinal: Number(atom.ordinal || 0),
    label: atom.label || descriptor?.label || atom.semanticType || "",
    semanticGoal: atom.semanticGoal || {
      semanticType: atom.semanticType || "",
      desiredValue: atom.expectedNormalizedValue || atom.expectedValue || ""
    },
    desiredValue: atom.semanticGoal?.desiredValue || atom.expectedNormalizedValue || atom.expectedValue || "",
    currentValue: control?.state?.normalizedValue || control?.state?.valueText || "",
    expectedPostcondition: atom.postcondition || {
      type: "normalized_value_changed",
      expectedValue: atom.expectedNormalizedValue || ""
    },
    expectedNormalizedValue: atom.expectedNormalizedValue || "",
    choiceTerms: atom.choiceTerms || [],
    controlId: control?.controlId || "",
    controlLabel: control?.label || descriptor?.label || "",
    state: control?.state || null,
    canonicalControl: control,
    observedCapabilities: control?.capabilities || [],
    supportedStrategies,
    accessibilityCandidates,
    browserHitTargets,
    screenshotTargets,
    boundedVisualRegions: supportedStrategies.flatMap((strategy) => strategy.visualRegion ? [strategy.visualRegion] : []),
    currentSurface: ownedCurrentSurface(page),
    foregroundOwnership: page.foreground || null,
    failedDispatchedAttempts,
    validationErrors: scopedValidationIssues(page, {
      controlIds: new Set([control?.controlId].filter(Boolean)),
      sectionIds: new Set([control?.sectionId].filter(Boolean)),
      sectionTypes: new Set([String(control?.sectionType || "").toLowerCase()].filter(Boolean)),
      surfaceIds: new Set([control?.surfaceId].filter(Boolean))
    }),
    risk: control?.risk || "safe",
    hasValue: Boolean(descriptor?.hasValue),
    suspendedReason: plan.suspendedReason || ""
  };
}

function resumeSuspendedSkillPlan(rawPlan, observation = {}, traveler = {}, lastActionResult = {}, blockedObligation = null) {
  const plan = clonePlan(rawPlan);
  if (plan.status !== "suspended") return { plan, resumable: plan.status === "running", context: skillRecoveryContext(plan, observation, traveler) };
  const context = skillRecoveryContext(plan, observation, traveler);
  const atom = currentProfileSkillAtom(plan);
  if (!atom || !context) return { plan, resumable: false, context };

  const exactRecoveryResult = Boolean(
    blockedObligation
    && (
      exactRecoveryProof(blockedObligation, lastActionResult)
      || (blockedObligation.proofs || []).some((proof) => proof.actionId === lastActionResult.actionId)
    )
  );
  if (exactRecoveryResult) {
    const recoveredAttempt = (blockedObligation.attempts || []).findLast?.((attempt) => attempt.actionId === lastActionResult.actionId)
      || (blockedObligation.attempts || []).slice(-1)[0];
    if (recoveredAttempt?.strategyId) {
      atom.strategyHistory = [
        ...(atom.strategyHistory || []),
        {
          strategyId: recoveredAttempt.strategyId,
          operation: recoveredAttempt.operation || "",
          targetId: recoveredAttempt.targetId || "",
          value: recoveredAttempt.value || "",
          keys: recoveredAttempt.keys || "",
          status: "verified_intermediate",
          resultCode: recoveredAttempt.resultCode || resultCode(lastActionResult),
          observationId: observation.observationId || "",
          at: new Date().toISOString()
        }
      ].slice(-20);
    }
    atom.status = "pending";
    atom.recoveredObservationId = observation.observationId || "";
  } else {
    return { plan, resumable: false, context };
  }

  atom.lastActionId = "";
  atom.lastControlId = "";
  atom.lastObservationId = "";
  plan.status = "running";
  plan.suspendedReason = "";
  plan.lastObservedObservationId = observation.observationId || plan.lastObservedObservationId || "";
  plan.updatedAt = new Date().toISOString();
  return { plan, atom, resumable: true, context: skillRecoveryContext(plan, observation, traveler) };
}

function scopeInterruption(plan, observation = {}) {
  const current = planScope(observation);
  if (plan.scope?.stage && current.stage && plan.scope.stage !== current.stage) {
    return { complete: true, reason: `Checkout stage changed from ${plan.scope.stage} to ${current.stage}.` };
  }
  const plannedSurface = plan.scope?.surfaceId || "";
  const currentSurface = current.surfaceId || "";
  const activeCustomChoice = (plan.atoms || []).find((atom) => atom.status === "pending"
    && (atom.choiceTerms || []).length);
  if (activeCustomChoice && currentSurface) return null;
  if (plannedSurface !== currentSurface) {
    return {
      complete: false,
      reason: currentSurface
        ? `A new foreground surface interrupted the ${plan.skillType} skill.`
        : `The foreground surface for the ${plan.skillType} skill disappeared.`
    };
  }
  return null;
}

function strategyKey(strategy = {}) {
  const targetIdentity = ["type", "select", "keypress"].includes(strategy.actionType || "")
    ? ""
    : strategy.targetId || "";
  return [
    strategy.actionType || "",
    strategy.operation || "",
    targetIdentity,
    strategy.interactionMethod || "",
    strategy.value || "",
    strategy.keys || "",
    strategy.visualRegion ? `${strategy.visualRegion.x || 0},${strategy.visualRegion.y || 0}` : ""
  ].join(":");
}

function strategyWasTried(atom = {}, strategy = {}) {
  const id = strategy.strategyId || strategyKey(strategy);
  return (atom.strategyHistory || []).some((attempt) => attempt.strategyId === id);
}

function expectedOutcomeForStrategy(atom, descriptor, strategy, observation = {}) {
  const targetControl = descriptor.control || {};
  const goalControl = descriptor.goalControl || targetControl;
  const surface = ownedCurrentSurface(observation.page || {});
  const logicalExpectation = {
    logicalFieldId: descriptor.logicalFieldId || atom.logicalFieldId || "",
    subjectId: descriptor.subjectId || atom.subjectId || "traveler_1",
    semanticType: descriptor.semanticType || atom.semanticType || "",
    componentRole: descriptor.componentRole || atom.componentRole || "value",
    expectedComponentValue: atom.expectedNormalizedValue || descriptor.desiredNormalizedValue || "",
    expectedCanonicalValue: atom.expectedCanonicalValue
      || descriptor.logicalDesiredCanonicalValue
      || descriptor.canonicalValue
      || ""
  };
  if (strategy.operation === "open") {
    return {
      type: "options_surface_appeared",
      controlId: targetControl.controlId,
      previousSurfaceId: surface?.id || "",
      previousExpanded: Boolean(targetControl.state?.expanded),
      ...logicalExpectation
    };
  }
  if (strategy.operation === "type" && targetControl.role === "editable_combobox") {
    return {
      type: "semantic_progress",
      controlId: goalControl.controlId,
      expectedNormalizedValue: atom.expectedNormalizedValue || "",
      previousSurfaceId: surface?.id || "",
      previousValue: goalControl.state?.normalizedValue || "",
      ...logicalExpectation
    };
  }
  if (strategy.operation === "keyboard") {
    return {
      type: "semantic_progress",
      controlId: goalControl.controlId,
      expectedNormalizedValue: atom.expectedNormalizedValue || "",
      previousSurfaceId: surface?.id || "",
      previousValue: goalControl.state?.normalizedValue || "",
      ...logicalExpectation
    };
  }
  if (descriptor.observedOption && strategy.operation === "choose") {
    return {
      type: "normalized_value_changed",
      controlId: goalControl.controlId,
      expectedNormalizedValue: atom.expectedNormalizedValue || "",
      surfaceId: surface?.id || "",
      surfaceType: surface?.type || "",
      surfaceLabel: surface?.label || "",
      requireSurfaceDismissed: Boolean(surface),
      ...logicalExpectation
    };
  }
  if (["type", "select"].includes(strategy.operation)) {
    if (DATE_FIELDS.has(descriptor.semanticType) && (strategy.dateCodec || descriptor.dateCodec)) {
      return {
        type: "date_value_committed",
        controlId: goalControl.controlId,
        expectedValue: strategy.value || descriptor.value || "",
        expectedNormalizedValue: atom.expectedNormalizedValue || descriptor.desiredNormalizedValue || "",
        dateCodec: strategy.dateCodec || atom.dateCodec || descriptor.dateCodec,
        requireNoValidationError: true,
        ...logicalExpectation
      };
    }
    return {
      type: atom.postcondition?.type || "normalized_value_changed",
      controlId: goalControl.controlId,
      expectedValue: strategy.value || descriptor.value || "",
      expectedNormalizedValue: atom.postcondition?.expectedValue || atom.expectedNormalizedValue || "",
      ...logicalExpectation
    };
  }
  if (strategy.operation === "choose") {
    return {
      type: descriptor.choiceLike ? "control_selected" : "normalized_value_changed",
      controlId: goalControl.controlId,
      decisionGroupId: goalControl.decisionGroupId || targetControl.decisionGroupId || "",
      expectedSelectedControlId: goalControl.controlId,
      conflictingControlIds: descriptor.conflictingSelectedControlIds || [],
      expectedNormalizedValue: atom.expectedNormalizedValue || "",
      ...logicalExpectation
    };
  }
  return {
    type: "semantic_progress",
    controlId: goalControl.controlId,
    expectedNormalizedValue: atom.expectedNormalizedValue || "",
    previousSurfaceId: surface?.id || "",
    previousValue: goalControl.state?.normalizedValue || "",
    ...logicalExpectation
  };
}

function trustedChoiceLabel(atom = {}, descriptor = {}) {
  const exactLabel = String(
    descriptor.exactOption?.label
    || descriptor.bindingContract?.component?.exactOption?.label
    || ""
  ).trim();
  if (exactLabel) return exactLabel;
  const optionRows = [
    ...(descriptor.control?.options || []),
    ...(descriptor.control?.dateField?.options || []),
    ...(descriptor.options || [])
  ].map((option) => typeof option === "string"
    ? { value: option, label: option }
    : {
        value: String(option?.value ?? option?.id ?? ""),
        label: String(option?.label ?? option?.text ?? option?.name ?? option?.value ?? "")
      }).filter((option, index, list) => (
    (option.value || option.label)
    && list.findIndex((candidate) => candidate.value === option.value && candidate.label === option.label) === index
  ));
  const desiredTerms = [
    descriptor.value,
    atom.expectedValue,
    atom.expectedNormalizedValue,
    descriptor.desiredNormalizedValue,
    ...(descriptor.choiceTerms || []),
    ...(atom.choiceTerms || [])
  ].map((value) => String(value || "").trim()).filter(Boolean);
  if (!optionRows.length || !desiredTerms.length) return "";
  const normalized = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const desiredCanonical = canonicalLogicalValue(
    descriptor.semanticType || atom.semanticType || "",
    atom.expectedNormalizedValue || descriptor.desiredNormalizedValue || descriptor.value || ""
  );
  const scored = optionRows.map((option) => {
    const values = [option.value, option.label].filter(Boolean);
    let score = 0;
    for (const value of values) {
      const normalizedValue = normalized(value);
      for (const term of desiredTerms) {
        const normalizedTerm = normalized(term);
        if (!normalizedTerm) continue;
        if (normalizedValue === normalizedTerm) score = Math.max(score, 100);
        else if (normalizedValue.includes(normalizedTerm) || normalizedTerm.includes(normalizedValue)) score = Math.max(score, 70);
      }
      if (desiredCanonical && canonicalLogicalValue(descriptor.semanticType || atom.semanticType || "", value) === desiredCanonical) {
        score = Math.max(score, 120);
      }
    }
    if (!option.value && /^(select|choose|month|day|year|title)$/i.test(option.label)) score -= 200;
    return { option, score };
  }).sort((left, right) => right.score - left.score);
  const best = scored[0];
  const tied = best?.score > 0 && scored.slice(1).some((candidate) => (
    candidate.score === best.score
    && (
      candidate.option.value !== best.option.value
      || candidate.option.label !== best.option.label
    )
  ));
  return best?.score > 0 && !tied
    ? String(best.option.label || best.option.value).trim()
    : "";
}

function strategyCandidatesForAtom(atom = {}, descriptor = null, observation = {}) {
  if (!descriptor?.control) return [];
  const control = descriptor.control;
  const operations = control.operations || {};
  const exactOption = descriptor.exactOption
    || descriptor.bindingContract?.component?.exactOption
    || null;
  const observedEnumOptions = [
    ...(descriptor.control?.observedOptions || []),
    ...(descriptor.control?.options || []),
    ...(descriptor.options || [])
  ];
  const enumOptionRequiresExactBinding = Array.isArray(observedEnumOptions) && observedEnumOptions.length > 0;
  const candidates = [];
  const capabilityFor = (operation = "", targetId = "", boundedRecovery = false, interactionMethod = "") => {
    const contracts = descriptor.capabilityContracts || [];
    const capability = contracts.find((item) => (
      item.operation === operation
      && (
        boundedRecovery
          ? item.status === agentContract.CAPABILITY_STATUS.UNPROVEN_EXPERIMENT
          : !targetId || item.actuatorIds?.includes(targetId)
      )
    )) || contracts.find((item) => item.operation === operation) || {};
    const exact = (capability.exactActuators || []).find((item) => item.actuatorId === targetId);
    const exactStrategy = (capability.strategies || []).find((item) => (
      item.actuatorId === targetId
      && (!interactionMethod || item.method === interactionMethod)
    )) || (capability.strategies || []).find((item) => (
      boundedRecovery && (
        !interactionMethod
        || item.method === interactionMethod
      )
    ));
    return {
      ...capability,
      actuatorId: targetId || capability.actuatorId || "",
      status: boundedRecovery || descriptor.ambiguity || descriptor.codecError
        ? agentContract.CAPABILITY_STATUS.UNPROVEN_EXPERIMENT
        : exactStrategy?.status || exact?.status || capability.status || agentContract.CAPABILITY_STATUS.UNAVAILABLE,
      strategy: exactStrategy || null,
      proof: exactStrategy?.proof || exact?.proof || capability.actionability || null
    };
  };
  const nextTarget = (capability) => capability?.actuatorId || capability?.actuatorIds?.[0] || "";
  const strategyTemplates = (operation = "") => {
    const capability = (descriptor.capabilityContracts || []).find((item) => item.operation === operation)
      || agentContract.normalizeCapability(control, operation, operations[operation]);
    return (capability?.strategies || []).filter((strategy) => (
      strategy.status === agentContract.CAPABILITY_STATUS.PROVEN_EXECUTABLE
      && strategy.method !== agentContract.INTERACTION_METHOD.VISUAL_COORDINATE
    ));
  };
  const add = (strategy) => {
    if (!isCandidateGrounded(strategy, observation)) return;
    const candidate = {
      ...strategy,
      controlId: control.controlId,
      exactOption: strategy.exactOption || exactOption,
      targetIds: strategy.targetId ? [strategy.targetId] : [],
      strategyId: strategyKey({ ...strategy, controlId: control.controlId })
    };
    const capability = capabilityFor(
      candidate.operation,
      candidate.targetId,
      candidate.actionType === "click_xy" || candidate.boundedRecovery === true,
      candidate.interactionMethod || ""
    );
    candidate.capabilityStatus = capability.status;
    candidate.expectedOutcome = capability.expectedOutcome
      || descriptor.expectedOutcome
      || expectedOutcomeForStrategy(atom, descriptor, candidate, observation);
    candidate.pipelineContract = agentContract.canonicalPipelineContract({
      requirement: descriptor.requirementContract || {},
      component: descriptor.bindingContract?.component || {
        logicalFieldId: descriptor.logicalFieldId,
        componentIdentity: descriptor.key,
        componentRole: descriptor.componentRole,
        controlId: control.controlId,
        controlRole: descriptor.observedRole,
        currentCanonicalValue: descriptor.currentNormalizedValue,
        desiredCanonicalValue: descriptor.desiredNormalizedValue,
        observedOptions: descriptor.options
      },
      capability,
      expectedOutcome: candidate.expectedOutcome,
      validationOwnership: descriptor.validationOwnership || {}
    });
    candidate.executionChannel = agentContract.classifyExecutionLane({
      action: {
        ...candidate,
        type: candidate.actionType,
        observationId: observation.observationId || "",
        surfaceId: control.surfaceId || observation.page?.currentSurface?.id || "surface-page",
        risk: "safe",
        requiresApproval: false,
        pipelineContract: candidate.pipelineContract
      },
      pipelineContract: candidate.pipelineContract,
      control,
      observation,
      strategyAlreadyFailed: strategyWasTried(atom, candidate)
    });
    if (!strategyWasTried(atom, candidate)) candidates.push(candidate);
  };

  const deterministicDateComponent = Boolean(
    descriptor.dateCodec?.ok === true
    && descriptor.dateCodec?.kind === "component"
  );
  const ambiguousDate = DATE_FIELDS.has(descriptor.semanticType)
    && !deterministicDateComponent
    && (
      descriptor.ambiguity?.code === "AMBIGUOUS_DATE_FORMAT"
      || descriptor.codecError?.code === "AMBIGUOUS_DATE_FORMAT"
    );
  if (ambiguousDate && operations.type) {
    const canonical = normalizeCanonicalDate(
      atom.expectedCanonicalValue
      || descriptor.canonicalValue
      || atom.expectedNormalizedValue
    );
    const [year, month, day] = String(canonical || "").split("-");
    const targetId = nextTarget(operations.type);
    if (year && month && day && targetId) {
      [
        { format: "dmy", separator: "/", value: `${day}/${month}/${year}` },
        { format: "mdy", separator: "/", value: `${month}/${day}/${year}` },
        { format: "ymd", separator: "-", value: `${year}-${month}-${day}` }
      ].forEach((hypothesis) => add({
        operation: "type",
        actionType: "type",
        targetId,
        value: hypothesis.value,
        keys: "",
        requiresAI: true,
        dateCodec: {
          ok: true,
          kind: "full",
          format: hypothesis.format,
          separator: hypothesis.separator,
          source: "bounded_semantic_hypothesis",
          confidence: 0.5
        }
      }));
    }
    return candidates.slice(0, 3);
  }

  if (descriptor.observedOption && operations.choose) {
    for (const strategy of strategyTemplates("choose")) {
      add({
        operation: "choose",
        actionType: strategy.actionType || "click",
        targetId: strategy.actuatorId,
        interactionMethod: strategy.method,
        value: "",
        keys: strategy.keys || ""
      });
    }
    return candidates;
  }
  if (operations.select && (!enumOptionRequiresExactBinding || exactOption)) {
    add({
      operation: "select",
      actionType: "select",
      targetId: nextTarget(operations.select),
      interactionMethod: agentContract.INTERACTION_METHOD.NATIVE_SELECT,
      value: exactOption?.siteValue || exactOption?.label || descriptor.value || atom.expectedValue || "",
      exactOption,
      keys: ""
    });
  }
  if (operations.type) {
    const queryValues = control.role === "editable_combobox"
      ? [...new Set([
          descriptor.value || atom.expectedValue || "",
          ...(atom.choiceTerms || []).filter((term) => /[a-z]/i.test(term))
        ].filter(Boolean))].slice(0, 3)
      : [descriptor.value || atom.expectedValue || ""];
    for (const value of queryValues) {
      add({
        operation: "type",
        actionType: "type",
        targetId: nextTarget(operations.type),
        interactionMethod: agentContract.INTERACTION_METHOD.DIRECT_INPUT,
        value,
        keys: ""
      });
    }
  }
  const trustedSelectRecovery = control.recovery?.select;
  if (trustedSelectRecovery?.requiresVisualConfirmation && (!enumOptionRequiresExactBinding || exactOption)) {
    const choiceLabel = trustedChoiceLabel(atom, descriptor);
    if (choiceLabel) {
      for (const strategy of trustedSelectRecovery.strategies || []) {
        add({
          operation: "select",
          actionType: strategy.actionType || "click",
          targetId: strategy.actuatorId || "",
          interactionMethod: strategy.method || "",
          value: choiceLabel,
          exactOption,
          keys: strategy.keys || "",
          boundedRecovery: true,
          requiresAI: false
        });
      }
    }
  }
  if (operations.open && control.state?.expanded !== true) {
    for (const strategy of strategyTemplates("open")) {
      add({
        operation: "open",
        actionType: strategy.actionType || "click",
        targetId: strategy.actuatorId,
        interactionMethod: strategy.method,
        value: "",
        keys: strategy.keys || ""
      });
    }
  }
  if (operations.choose) {
    for (const strategy of strategyTemplates("choose")) {
      add({
        operation: "choose",
        actionType: strategy.actionType || "click",
        targetId: strategy.actuatorId,
        interactionMethod: strategy.method,
        value: "",
        keys: strategy.keys || ""
      });
    }
  }
  if (operations.keyboard) {
    for (const strategy of strategyTemplates("keyboard")) {
      add({
        operation: "keyboard",
        actionType: strategy.actionType || "keypress",
        targetId: strategy.actuatorId,
        interactionMethod: strategy.method,
        value: "",
        keys: control.state?.expanded === true ? "Enter" : (strategy.keys || "ArrowDown")
      });
    }
  }
  if (operations.activate) {
    for (const strategy of strategyTemplates("activate")) {
      add({
        operation: "activate",
        actionType: strategy.actionType || "click",
        targetId: strategy.actuatorId,
        interactionMethod: strategy.method,
        value: "",
        keys: strategy.keys || ""
      });
    }
  }
  for (const [operation, recovery] of Object.entries(control.recovery || {})) {
    if (operation === "select") continue;
    if (!recovery?.requiresVisualConfirmation) continue;
    for (const strategy of recovery.strategies || []) {
      add({
        operation,
        actionType: strategy.actionType || "click",
        targetId: strategy.actuatorId || "",
        interactionMethod: strategy.method || "",
        value: "",
        keys: strategy.keys || "",
        boundedRecovery: true,
        requiresAI: false
      });
    }
    for (const region of recovery.regions || []) {
      add({
        operation,
        actionType: "click_xy",
        targetId: "",
        interactionMethod: agentContract.INTERACTION_METHOD.VISUAL_COORDINATE,
        boundedRecovery: true,
        value: "",
        keys: "",
        visualRegion: region,
        requiresAI: false
      });
    }
  }
  const boundedCandidates = candidates.slice(0, 12);
  const atomicChoice = candidates.find((candidate) => (
    candidate.interactionMethod === agentContract.INTERACTION_METHOD.BROWSER_TRUSTED_CHOICE
  ));
  if (atomicChoice && !boundedCandidates.some((candidate) => candidate.strategyId === atomicChoice.strategyId)) {
    if (boundedCandidates.length < 12) boundedCandidates.push(atomicChoice);
    else boundedCandidates[boundedCandidates.length - 1] = atomicChoice;
  }
  return boundedCandidates;
}

function atomicActionForStrategy(plan, atom, descriptor, strategy, observation = {}) {
  const control = descriptor.control;
  const actionId = uid("act_skill");
  atom.lastStrategyId = strategy.strategyId;
  atom.lastOperation = strategy.operation;
  atom.lastTargetId = strategy.targetId || "";
  atom.lastStrategyValue = strategy.value || "";
  atom.lastStrategyKeys = strategy.keys || "";
  return normalizeAction({
    id: actionId,
    observationId: observation.observationId || "",
    observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
    type: strategy.actionType,
    intent: "satisfy_semantic_goal",
    operation: strategy.operation,
    skillPlanId: plan.planId,
    skillAtomId: atom.atomId,
    controlId: control.controlId,
    decisionGroupId: control.decisionGroupId || "",
    targetId: strategy.targetId || "",
    interactionMethod: strategy.interactionMethod || "",
    boundedRecovery: strategy.boundedRecovery === true,
    exactOption: strategy.exactOption || descriptor.exactOption || descriptor.bindingContract?.component?.exactOption || null,
    targetLabel: control.label || descriptor.label || descriptor.semanticType,
    value: strategy.value || "",
    keys: strategy.keys || "",
    x: strategy.visualRegion?.centerX,
    y: strategy.visualRegion?.centerY,
    visualRegion: strategy.visualRegion || null,
    risk: "safe",
    requiresApproval: false,
    reason: `Atomic ${plan.skillType} strategy ${strategy.operation} for semantic goal ${atom.semanticType}=${atom.semanticGoal?.desiredValue || atom.expectedNormalizedValue}.`,
    targetSnapshot: null,
    expectedOutcome: strategy.expectedOutcome
  });
}

function semanticGoalAtom(goal = {}, attemptedCandidateIds = []) {
  return {
    atomId: goal.goalId || "",
    descriptorKey: goal.descriptorKey || "",
    semanticType: goal.semanticType || "",
    ordinal: Number(goal.ordinal || 0),
    logicalFieldId: goal.logicalFieldId || "",
    subjectId: goal.subjectId || "traveler_1",
    componentRole: goal.componentRole || "value",
    label: goal.label || goal.semanticType || "",
    semanticGoal: {
      semanticType: goal.semanticType || "",
      desiredValue: goal.desiredValue || ""
    },
    postcondition: {
      type: goal.postcondition?.type || "normalized_value_changed",
      expectedValue: goal.postcondition?.expectedValue || goal.desiredValue || "",
      expectedCanonicalValue: goal.postcondition?.expectedCanonicalValue || goal.canonicalValue || "",
      dateCodec: goal.postcondition?.dateCodec || goal.dateCodec || null
    },
    expectedValue: goal.inputValue || goal.desiredValue || "",
    expectedNormalizedValue: goal.desiredValue || "",
    expectedCanonicalValue: goal.canonicalValue || "",
    dateCodec: goal.dateCodec || null,
    choiceTerms: [...(goal.choiceTerms || [])],
    strategyHistory: (attemptedCandidateIds || []).map((strategyId) => ({
      strategyId,
      status: "attempted"
    }))
  };
}

function descriptorForSemanticGoal(goal = {}, observation = {}, traveler = {}) {
  const atom = semanticGoalAtom(goal);
  return descriptorForAtom(atom, observation, traveler);
}

function profileGoalForDescriptor(descriptor = {}, observation = {}, previousGoal = null) {
  const observationId = String(observation.observationId || "");
  const goalControl = descriptor.goalControl || descriptor.control || {};
  const desiredValue = descriptor.desiredNormalizedValue
    || canonicalLogicalValue(descriptor.semanticType, descriptor.value)
    || descriptor.value;
  return {
    ...(previousGoal || {}),
    goalId: previousGoal?.goalId || (descriptor.logicalFieldId && descriptor.logicalStructure === "composite"
      ? `profile:${descriptor.logicalFieldId}:${descriptor.componentRole || "value"}`
      : `profile:${descriptor.semanticType}:${descriptor.ordinal}`),
    kind: "profile_field",
    descriptorKey: descriptor.key || previousGoal?.descriptorKey || "",
    semanticType: descriptor.semanticType,
    ordinal: Number(descriptor.ordinal ?? previousGoal?.ordinal ?? 0),
    logicalFieldId: descriptor.logicalFieldId || previousGoal?.logicalFieldId || "",
    subjectId: descriptor.subjectId || previousGoal?.subjectId || "traveler_1",
    componentRole: descriptor.componentRole || previousGoal?.componentRole || "value",
    logicalStructure: descriptor.logicalStructure || previousGoal?.logicalStructure || "scalar",
    ambiguity: descriptor.ambiguity || null,
    instructions: [...(descriptor.instructions || previousGoal?.instructions || [])],
    options: [...(descriptor.options || previousGoal?.options || [])],
    requirementContract: descriptor.requirementContract || previousGoal?.requirementContract || null,
    componentBinding: descriptor.bindingContract?.component
      || previousGoal?.componentBinding
      || null,
    capabilityContracts: [...(descriptor.capabilityContracts || previousGoal?.capabilityContracts || [])],
    validationOwnership: descriptor.validationOwnership || previousGoal?.validationOwnership || null,
    label: descriptor.label || descriptor.semanticType,
    desiredValue,
    inputValue: descriptor.value,
    choiceTerms: [...(descriptor.choiceTerms || [])],
    controlId: goalControl.controlId || "",
    currentValue: goalControl.state?.normalizedValue || descriptor.currentNormalizedValue || "",
    reconciliation: descriptor.reconciliation || previousGoal?.reconciliation || null,
    canonicalValue: descriptor.canonicalValue || previousGoal?.canonicalValue || "",
    dateCodec: descriptor.dateCodec || previousGoal?.dateCodec || null,
    codecError: descriptor.codecError || null,
    postcondition: descriptor.expectedOutcome || previousGoal?.postcondition || {
      type: DATE_FIELDS.has(descriptor.semanticType) ? "date_value_committed" : "normalized_value_changed",
      expectedValue: desiredValue,
      expectedCanonicalValue: descriptor.canonicalValue || previousGoal?.canonicalValue || "",
      dateCodec: descriptor.dateCodec || previousGoal?.dateCodec || null
    },
    observationId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function deriveProfileGoal(observation = {}, traveler = {}, currentGoal = null) {
  if (currentGoal?.goalId) {
    const descriptor = descriptorForSemanticGoal(currentGoal, observation, traveler);
    if (descriptor && !descriptor.hasValue) {
      return profileGoalForDescriptor(descriptor, observation, currentGoal);
    }
    // A satisfied current goal is not a terminal signal. Fall through and
    // select the next unresolved semantic descriptor from this observation.
  }

  const descriptor = fieldDescriptors(observation, traveler)
    .find((item) => !item.hasValue);
  return descriptor ? profileGoalForDescriptor(descriptor, observation) : null;
}

function executableProfileCandidate(candidate = {}, observation = {}) {
  if (!candidate?.controlId || candidate.requiresJudgment || !isCandidateGrounded(candidate, observation)) return false;
  if (candidate.capabilityStatus !== agentContract.CAPABILITY_STATUS.PROVEN_EXECUTABLE) return false;
  const control = (observation.page?.controls || [])
    .find((item) => item.controlId === candidate.controlId);
  if (!control) return false;
  if (candidate.type === "click_xy") {
    const recovery = control.recovery?.[candidate.operation || ""];
    return Boolean(
      candidate.visualRegion
      && recovery?.requiresVisualConfirmation === true
      && (recovery.regions || []).some((region) => visualRegionsMatch(region, candidate.visualRegion))
    );
  }
  const capability = control.operations?.[candidate.operation];
  if (!capability) return false;
  const actionability = capability.actionabilityByActuator?.[candidate.targetId]
    || (capability.actuatorId === candidate.targetId ? capability.actionability : null);
  const disabledState = control.disabled === true || control.state?.disabled === true;
  if (disabledState && candidate.targetId === control.stateElementId) return false;
  return actionability?.executable === true;
}

function selectExecutableProfileGoal(observation = {}, traveler = {}, currentGoal = null, {
  blockedGoalKeys = []
} = {}) {
  const descriptors = fieldDescriptors(observation, traveler)
    .filter(descriptorOwnsActiveRequirement)
    .filter((descriptor) => !descriptor.hasValue);
  const blockedGoals = new Set(blockedGoalKeys || []);
  const ordered = [];
  let rebound = null;
  if (currentGoal?.goalId) {
    rebound = descriptorForSemanticGoal(currentGoal, observation, traveler);
    const surface = ownedCurrentSurface(observation.page || {});
    if (rebound && !rebound.hasValue && surface?.type && surface.type !== "page") {
      ordered.push({ descriptor: rebound, previousGoal: currentGoal });
    }
  }
  for (const descriptor of descriptors) {
    if (ordered.some((item) => item.descriptor.key === descriptor.key)) continue;
    ordered.push({
      descriptor,
      previousGoal: rebound?.key === descriptor.key ? currentGoal : null
    });
  }

  const blockedFields = [];
  let boundedRecoveryFallback = null;
  for (const item of ordered) {
    const goal = profileGoalForDescriptor(item.descriptor, observation, item.previousGoal);
    if (blockedGoals.has(semanticGoalKey(goal))) {
      blockedFields.push({
        semanticType: item.descriptor.semanticType,
        componentRole: item.descriptor.componentRole || "value",
        controlId: item.descriptor.control?.controlId || "",
        reasonCode: "STRATEGIES_EXHAUSTED"
      });
      continue;
    }
    const candidates = candidatesForProfileGoal(goal, observation, traveler);
    const executable = candidates.filter((candidate) => executableProfileCandidate(candidate, observation));
    if (executable.length) {
      return {
        goal,
        candidates: executable,
        blockedFields,
        failureCode: ""
      };
    }
    const boundedRecovery = candidates.filter((candidate) => (
      !candidate.requiresJudgment
      && isCandidateGrounded(candidate, observation)
      && [
        agentContract.CAPABILITY_STATUS.RECOVERABLE,
        agentContract.CAPABILITY_STATUS.UNPROVEN_EXPERIMENT
      ].includes(candidate.capabilityStatus)
    ));
    if (!boundedRecoveryFallback && boundedRecovery.length) {
      boundedRecoveryFallback = { goal, candidates: boundedRecovery };
    }
    const ambiguous = Boolean(item.descriptor.ambiguity || item.descriptor.codecError);
    blockedFields.push({
      semanticType: item.descriptor.semanticType,
      componentRole: item.descriptor.componentRole || "value",
      controlId: item.descriptor.control?.controlId || "",
      reasonCode: ambiguous ? "SEMANTIC_AMBIGUITY" : "MISSING_EXECUTABLE_ACTUATOR"
    });
  }

  if (boundedRecoveryFallback) {
    return {
      goal: boundedRecoveryFallback.goal,
      candidates: boundedRecoveryFallback.candidates,
      blockedFields,
      failureCode: ""
    };
  }

  const reasonCodes = new Set(blockedFields.map((item) => item.reasonCode));
  const uniformReason = reasonCodes.size === 1 ? blockedFields[0]?.reasonCode || "" : "";
  return {
    goal: null,
    candidates: [],
    blockedFields,
    failureCode: uniformReason || (blockedFields.length ? "PROFILE_FIELDS_TEMPORARILY_BLOCKED" : "")
  };
}

function profileGoalSatisfied(goal = {}, observation = {}, traveler = {}) {
  if (!goal?.goalId) return false;
  const verification = verifyLogicalField(observation.page || {}, {
    logicalFieldId: goal.logicalFieldId || "",
    subjectId: goal.subjectId || "traveler_1",
    semanticType: goal.semanticType || "",
    componentRole: goal.componentRole || "value",
    controlId: goal.controlId || "",
    expectedComponentValue: goal.desiredValue || "",
    expectedCanonicalValue: goal.canonicalValue || ""
  });
  if (!verification.logicalField) return false;
  if (goal.reconciliation) {
    const commit = verification.component?.control?.commitState || {};
    return Boolean(
      commit.status === "settled"
      && commit.popupClosed === true
      && commit.focusSettled === true
      && Number(commit.attempts || 0) > Number(goal.reconciliation.priorCommitAttempts || 0)
    );
  }
  return goal.logicalStructure === "composite"
    ? verification.componentResult.satisfied
    : verification.componentResult.satisfied && verification.logicalFieldResult.satisfied;
}

function candidatesForProfileGoal(goal = {}, observation = {}, traveler = {}, attemptedCandidateIds = [], options = {}) {
  if (!goal?.goalId) return [];
  const descriptor = descriptorForSemanticGoal(goal, observation, traveler);
  if (!descriptor || descriptor.hasValue) return [];
  const boundedDateAmbiguity = DATE_FIELDS.has(descriptor.semanticType)
    && (
      descriptor.ambiguity?.code === "AMBIGUOUS_DATE_FORMAT"
      || descriptor.codecError?.code === "AMBIGUOUS_DATE_FORMAT"
    );
  const deterministicDateComponent = Boolean(
    DATE_FIELDS.has(descriptor.semanticType)
    && descriptor.dateCodec?.ok === true
    && descriptor.dateCodec?.kind === "component"
    && (
      descriptor.control?.operations?.type
      || descriptor.control?.operations?.select
      || descriptor.control?.operations?.open
      || descriptor.control?.recovery?.open?.regions?.length
    )
  );
  if (descriptor.ambiguity && !boundedDateAmbiguity && !deterministicDateComponent) return [];
  if (descriptor.codecError && !boundedDateAmbiguity) return [];
  if (conflictedControlIds(observation.page || {}).has(descriptor.control?.controlId)) return [];
  const atom = semanticGoalAtom(goal, attemptedCandidateIds);
  const mapped = strategyCandidatesForAtom(atom, descriptor, observation).map((strategy) => ({
    candidateId: strategy.strategyId,
    goalId: goal.goalId,
    type: strategy.actionType,
    operation: strategy.operation,
    ...deriveActionSemantics({
      control: descriptor.control,
      operation: strategy.operation,
      type: strategy.actionType,
      goal,
      expectedOutcome: strategy.expectedOutcome
    }),
    controlId: strategy.controlId,
    targetId: strategy.targetId || "",
    interactionMethod: strategy.interactionMethod || "",
    boundedRecovery: strategy.boundedRecovery === true,
    exactOption: strategy.exactOption || null,
    value: strategy.value || "",
    keys: strategy.keys || "",
    visualRegion: strategy.visualRegion || null,
    expectedOutcome: strategy.expectedOutcome,
    capabilityStatus: strategy.capabilityStatus || agentContract.CAPABILITY_STATUS.UNAVAILABLE,
    executionChannel: strategy.executionChannel || "unavailable",
    pipelineContract: strategy.pipelineContract || null,
    requiresJudgment: Boolean(strategy.requiresAI),
    summary: [
      strategy.operation,
      strategy.value ? `value=${strategy.value}` : "",
      strategy.keys ? `keys=${strategy.keys}` : "",
      strategy.visualRegion ? `visual=${strategy.visualRegion.source || "bounded-region"}` : ""
    ].filter(Boolean).join(" ")
  }));
  if (options.includeAlternates === true) return mapped;
  const selected = new Set();
  return mapped.filter((candidate) => {
    if (!["click", "keypress"].includes(candidate.type)) return true;
    const key = `${candidate.controlId}::${candidate.operation}`;
    if (selected.has(key)) return false;
    selected.add(key);
    return true;
  });
}

function actionForProfileCandidate(goal = {}, candidate = {}, observation = {}) {
  return normalizeAction({
    id: uid("act_goal"),
    observationId: observation.observationId || "",
    observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
    type: candidate.type,
    intent: "satisfy_semantic_goal",
    operation: candidate.operation,
    goalId: goal.goalId,
    candidateId: candidate.candidateId,
    controlId: candidate.controlId || goal.controlId || "",
    targetId: candidate.targetId || "",
    interactionMethod: candidate.interactionMethod || "",
    boundedRecovery: candidate.boundedRecovery === true,
    exactOption: candidate.exactOption || candidate.pipelineContract?.component?.exactOption || null,
    targetLabel: goal.label || goal.semanticType || "",
    value: candidate.value || "",
    keys: candidate.keys || "",
    x: candidate.visualRegion
      ? Number(candidate.visualRegion.centerX ?? (Number(candidate.visualRegion.x || 0) + Number(candidate.visualRegion.width || 0) / 2))
      : null,
    y: candidate.visualRegion
      ? Number(candidate.visualRegion.centerY ?? (Number(candidate.visualRegion.y || 0) + Number(candidate.visualRegion.height || 0) / 2))
      : null,
    visualRegion: candidate.visualRegion || null,
    expectedOutcome: candidate.expectedOutcome,
    pipelineContract: candidate.pipelineContract || null,
    capabilityStatus: candidate.capabilityStatus || "",
    executionChannel: candidate.executionChannel || "",
    interactionRole: candidate.interactionRole,
    semanticEffect: candidate.semanticEffect,
    expectedEvidence: candidate.expectedEvidence,
    affordance: candidate.affordance || null,
    risk: "safe",
    requiresApproval: false,
    reason: `Execute candidate ${candidate.candidateId} for ${goal.semanticType}=${goal.desiredValue}.`
  });
}

function advanceSkillPlan(rawPlan, observation = {}, traveler = {}, lastActionResult = {}) {
  let plan = clonePlan(rawPlan);
  const observationId = String(observation.observationId || "");
  plan.lastObservedObservationId = observationId;
  plan.updatedAt = new Date().toISOString();

  const reconciled = reconcileDispatchedAtom(plan, lastActionResult, observationId);
  plan = reconciled.plan;
  if (reconciled.ambiguous) {
    return { plan, action: null, status: "ambiguous", reason: plan.suspendedReason };
  }

  const interrupted = scopeInterruption(plan, observation);
  if (interrupted?.complete) {
    plan.status = "complete";
    plan.completedAt = new Date().toISOString();
    return { plan, action: null, status: "complete", reason: interrupted.reason };
  }
  if (interrupted) {
    plan = suspendPlan(plan, interrupted.reason, observationId);
    return { plan, action: null, status: "ambiguous", reason: interrupted.reason };
  }

  plan = extendPlan(plan, observation, traveler);
  for (const atom of plan.atoms.filter((item) => item.status === "pending")) {
    const descriptor = descriptorForAtom(atom, observation, traveler);
    if (descriptor?.hasValue) {
      atom.status = "satisfied";
      atom.completedObservationId = observationId;
      atom.completionSource = "current_observation";
    }
  }

  const atom = plan.atoms.find((item) => item.status === "pending");
  if (!atom) {
    const profileFields = profileFieldsForPage(observation.page || {}).filter((field) => PROFILE_FIELDS.has(String(field.field || "")));
    const unresolvedRequired = profileFields.filter((field) => {
      if (!field.required || field.hasValue || field.controlState?.valuePresent) return false;
      if (["title", "gender"].includes(String(field.field || ""))) {
        return !profileFields.some((peer) => peer.field === field.field && (peer.hasValue || peer.controlState?.checked || peer.controlState?.selected));
      }
      return true;
    });
    const planControlIds = new Set(profileFieldsForPage(observation.page || {})
      .filter((field) => PROFILE_FIELDS.has(String(field.field || "")))
      .map((field) => field.controlId)
      .filter(Boolean));
    const visibleErrors = scopedValidationIssues(observation.page || {}, {
      controlIds: planControlIds,
      sectionTypes: new Set(["contact", "passenger", "traveler", "traveller", "document"])
    }).map(validationIssueMessage);
    if (unresolvedRequired.length || visibleErrors.length) {
      const labels = unresolvedRequired.map((field) => field.label || field.field).filter(Boolean).slice(0, 5);
      const reason = unresolvedRequired.length
        ? `Required profile controls remain unresolved: ${labels.join(", ")}.`
        : `Visible validation errors remain: ${visibleErrors.slice(0, 3).join("; ")}.`;
      plan = suspendPlan(plan, reason, observationId);
      return { plan, action: null, status: "ambiguous", reason };
    }
    plan.status = "complete";
    plan.completedAt = new Date().toISOString();
    return { plan, action: null, status: "complete", reason: "All required profile-field atoms are satisfied with no visible validation errors." };
  }
  const descriptor = descriptorForAtom(atom, observation, traveler);
  if (!descriptor || descriptor.hasValue) {
    plan = suspendPlan(plan, `The current canonical field for ${atom.atomId} could not be resolved unambiguously.`, observationId);
    return { plan, action: null, status: "ambiguous", reason: plan.suspendedReason };
  }

  const strategies = strategyCandidatesForAtom(atom, descriptor, observation);
  if (strategies.length !== 1 || strategies[0]?.requiresAI) {
    const reason = strategies.length
      ? `The semantic goal ${atom.semanticType}=${atom.semanticGoal?.desiredValue || atom.expectedNormalizedValue} has multiple grounded strategies and requires bounded strategy selection.`
      : `The semantic goal ${atom.semanticType}=${atom.semanticGoal?.desiredValue || atom.expectedNormalizedValue} has no untried grounded strategy in the current observation.`;
    plan = suspendPlan(plan, reason, observationId);
    return { plan, action: null, status: "ambiguous", reason: plan.suspendedReason };
  }
  const action = atomicActionForStrategy(plan, atom, descriptor, strategies[0], observation);
  atom.status = "proposed";
  atom.lastActionId = action.id;
  atom.lastControlId = descriptor.control.controlId;
  atom.lastObservationId = observationId;
  plan.status = "running";
  return { plan, action, atom, status: "action" };
}

function markSkillActionGoverned(rawPlan, actionId, observationId = "") {
  const plan = clonePlan(rawPlan);
  const atom = plan.atoms.find((item) => item.lastActionId === actionId && item.status === "proposed");
  if (atom) {
    atom.status = "governed";
    atom.governedObservationId = observationId || atom.lastObservationId || "";
  }
  plan.updatedAt = new Date().toISOString();
  return plan;
}

function failSkillAction(rawPlan, actionId, reason, observationId = "") {
  const plan = clonePlan(rawPlan);
  const atom = plan.atoms.find((item) => item.lastActionId === actionId && ["proposed", "governed", "dispatched"].includes(item.status));
  if (atom) atom.status = "blocked";
  return suspendPlan(plan, reason, observationId);
}

function prepareSkillViewportRecovery(rawPlan, actionId, observationId = "", maxRecoveries = 2) {
  const plan = clonePlan(rawPlan);
  const atom = plan.atoms.find((item) => item.lastActionId === actionId && ["proposed", "governed", "dispatched"].includes(item.status));
  if (!atom) {
    return { plan: suspendPlan(plan, "The recoverable action no longer belongs to an active skill atom.", observationId), recovered: false, exhausted: true };
  }
  atom.viewportRecoveryCount = Number(atom.viewportRecoveryCount || 0) + 1;
  if (atom.viewportRecoveryCount > maxRecoveries) {
    return {
      plan: suspendPlan(plan, `Skill atom ${atom.atomId} remained outside the viewport after ${maxRecoveries} governed recovery attempts.`, observationId),
      recovered: false,
      exhausted: true
    };
  }
  atom.status = "pending";
  atom.attempts = Math.max(0, Number(atom.attempts || 0) - 1);
  atom.lastViewportRejectedActionId = atom.lastActionId;
  atom.lastActionId = "";
  atom.lastControlId = "";
  atom.lastObservationId = "";
  plan.status = "running";
  plan.suspendedReason = "";
  plan.lastObservedObservationId = observationId || plan.lastObservedObservationId || "";
  plan.updatedAt = new Date().toISOString();
  return { plan, atom, recovered: true, exhausted: false };
}

// Compatibility wrapper for callers/tests that need to expand a newly chosen
// skill. The returned plan must be persisted before dispatching its atom.
function expandSkillAction(action, observation = {}, traveler = {}) {
  if (!COMPOUND_ACTIONS.has(action?.type)) return { action, expanded: false, plan: null };
  const plan = createSkillPlan(action, observation, traveler);
  const advanced = advanceSkillPlan(plan, observation, traveler, {});
  if (advanced.action) {
    return {
      action: advanced.action,
      expanded: true,
      exhausted: false,
      skill: action.type,
      field: advanced.atom?.semanticType || "",
      atom: advanced.atom || null,
      plan: advanced.plan
    };
  }
  return {
    action: null,
    handoffReason: advanced.reason || "No canonical profile-field atom can be executed from the current observation.",
    expanded: true,
    exhausted: true,
    skill: action.type,
    field: "",
    atom: null,
    plan: advanced.plan
  };
}

module.exports = {
  PROFILE_FIELDS,
  PROFILE_FIELD_ORDER,
  normalizeProfileFieldType,
  profileStageReadiness,
  scopedValidationIssues,
  validationIssueMessage,
  fieldDescriptors,
  descriptorOwnsActiveRequirement,
  deriveProfileGoal,
  selectExecutableProfileGoal,
  profileGoalSatisfied,
  candidatesForProfileGoal,
  actionForProfileCandidate
};
