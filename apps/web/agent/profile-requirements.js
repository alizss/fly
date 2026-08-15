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
  PROFILE_FIELDS,
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

const PROFILE_FIELD_ORDER = [
  "email",
  "confirm_email",
  "phone_country_code",
  "phone",
  "travel_purpose",
  "title",
  "first_name",
  "given_names",
  "middle_name",
  "last_name",
  "second_last_name",
  "full_name",
  "date_of_birth",
  "age_at_departure",
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

const { obligationField } = require("./current-obligation");

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
  if (selectLike && agentContract.isPlaceholderChoiceValue(raw, {
    label: control.label || field.label || "",
    optionValue: state.selectedValue || state.normalizedValue || raw
  })) return "";
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

function mergedRepresentationLifecycle(field = {}, control = {}) {
  const contracts = [field.representationLifecycle, control.representationLifecycle]
    .filter((contract) => contract && typeof contract === "object");
  if (!contracts.length) return null;
  const active = contracts.some((contract) => (
    contract.active === true || contract.status === "active_rendered"
  ));
  return {
    status: active ? "active_rendered" : "dormant_hidden",
    active,
    stateRendered: contracts.some((contract) => contract.stateRendered === true),
    renderedMemberIds: [...new Set(contracts.flatMap((contract) => contract.renderedMemberIds || []))]
  };
}

function ownsActiveRepresentation(field = {}, control = {}) {
  return mergedRepresentationLifecycle(field, control)?.status !== "dormant_hidden";
}

function profileFieldsForPage(page = {}) {
  if (Array.isArray(page.fields) && page.fields.length) {
    return page.fields.map((field) => {
      const control = (page.controls || []).find((item) => item.controlId === field.controlId) || {};
      const fieldType = semanticTypeForControl(control, field);
      const normalized = {
        ...field,
        controlState: control.state || field.controlState || {},
        representationLifecycle: mergedRepresentationLifecycle(field, control),
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
      representationLifecycle: mergedRepresentationLifecycle({}, control),
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
    if (!ownsActiveRepresentation(field, {})) return false;
    const semanticType = normalizeProfileFieldType(field.fieldType || field.field || "");
    if (!PROFILE_FIELDS.has(semanticType) || NON_BLOCKING_PROFILE_FIELDS.has(semanticType)) return false;
    if (field.hasValue) return false;
    return !desiredProfileValue(semanticType, traveler, { page });
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

const PROFILE_COMPONENT_DEPENDENCIES = new Map([
  ["phone", ["phone_country_code"]],
  ["confirm_email", ["email"]]
]);

const PROFILE_COMPONENT_ORDER = new Map([
  ["country_code", 0],
  ["day", 0],
  ["month", 1],
  ["year", 2],
  ["value", 10]
]);

function orderedProfileDescriptors(descriptors = []) {
  const spatiallyOrdered = [...descriptors].sort((left, right) => {
    if (left.logicalFieldId && left.logicalFieldId === right.logicalFieldId) {
      const leftComponentOrder = PROFILE_COMPONENT_ORDER.get(left.componentRole) ?? 5;
      const rightComponentOrder = PROFILE_COMPONENT_ORDER.get(right.componentRole) ?? 5;
      if (leftComponentOrder !== rightComponentOrder) return leftComponentOrder - rightComponentOrder;
    }
    const leftRegion = left.control?.visualRegion || left.control?.box || {};
    const rightRegion = right.control?.visualRegion || right.control?.box || {};
    const leftY = Number(leftRegion.y);
    const rightY = Number(rightRegion.y);
    const leftX = Number(leftRegion.x);
    const rightX = Number(rightRegion.x);
    const bothVisual = Number.isFinite(leftY) && Number.isFinite(rightY);
    if (bothVisual && leftY !== rightY) return leftY - rightY;
    if (bothVisual && Number.isFinite(leftX) && Number.isFinite(rightX) && leftX !== rightX) return leftX - rightX;
    return left.domOrder - right.domOrder
      || left.ordinal - right.ordinal
      || String(left.componentRole).localeCompare(String(right.componentRole));
  });
  const remaining = [...spatiallyOrdered];
  const ordered = [];
  while (remaining.length) {
    const nextIndex = remaining.findIndex((descriptor) => (
      (PROFILE_COMPONENT_DEPENDENCIES.get(descriptor.semanticType) || [])
        .every((dependency) => !remaining.some((candidate) => candidate.semanticType === dependency))
    ));
    ordered.push(...remaining.splice(nextIndex >= 0 ? nextIndex : 0, 1));
  }
  return ordered;
}

function fieldDescriptors(observation = {}, traveler = {}) {
  const page = observation.page || {};
  const logicalFields = resolveLogicalFields(page, traveler);
  const ordinals = new Map();
  const descriptors = logicalFields.flatMap((logicalField) => {
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
        required: Boolean(
          field.required
          || control.required
          || control.state?.required
          || control.controlState?.required
          || logicalField.requirementContract?.required
          || component.requirementContract?.required
        ),
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
        ambiguity: logicalField.ambiguity || null,
        representationLifecycle: mergedRepresentationLifecycle(field, control)
      };
    });
  });
  return orderedProfileDescriptors(descriptors);
}

function decisionGroupForDescriptor(descriptor = {}, page = {}) {
  const control = descriptor.control || {};
  const exactDecisionGroupId = String(
    control.decisionGroupId
    || descriptor.field?.decisionGroupId
    || descriptor.requirementContract?.decisionGroupId
    || ""
  );
  return (page.decisionGroups || []).find((group) => {
    if (exactDecisionGroupId && String(group.decisionGroupId || "") === exactDecisionGroupId) return true;
    const ownedControlIds = new Set([
      group.selectedControlId,
      ...(group.alternativeControlIds || []),
      ...(group.alternatives || []).flatMap((alternative) => [alternative.controlId, alternative.targetId])
    ].filter(Boolean).map(String));
    return Boolean(control.controlId && ownedControlIds.has(String(control.controlId)));
  }) || null;
}

function unblockedStageExitReady(page = {}) {
  const exit = page.stageExit || {};
  if (exit.continueDisabled === true || exit.navigationState === "disabled") return false;
  const readyCandidate = (exit.candidates || []).some((candidate) => (
    candidate.executable === true
    || candidate.status === "ready"
  ));
  return Boolean(
    (exit.continueAllowed === true || exit.continueObserved === true || readyCandidate)
    && readyCandidate
    && !(exit.blockers || []).length
  );
}

function descriptorOwnsActiveRequirement(descriptor = {}, page = {}) {
  const control = descriptor.control || {};
  const field = descriptor.field || {};
  if (!ownsActiveRepresentation(
    { ...field, representationLifecycle: descriptor.representationLifecycle || field.representationLifecycle },
    control
  )) return false;
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
  const decisionGroup = decisionGroupForDescriptor(descriptor, page);
  const decisionStatus = String(decisionGroup?.status || "").toLowerCase();
  const decisionRequiresResolution = decisionGroup?.requiresResolution === true
    || (decisionGroup?.required === true
      && !["satisfied", "waived", "waived_by_policy", "optional"].includes(decisionStatus));
  if (NON_BLOCKING_PROFILE_FIELDS.has(descriptor.semanticType) && !required && !ownsValidation) {
    return false;
  }
  if (required || ownsValidation || decisionRequiresResolution) return true;

  // Actionability describes how a control can be operated; it is never proof
  // that the control represents work. A fresh, unblocked stage exit is an
  // explicit statement that no optional blank profile representation owns
  // the current task. This is the live EasyJet boundary where a blank
  // framework parent survived after the exact age choice was already settled.
  if (unblockedStageExitReady(page)) return false;

  // Some checkout forms omit HTML `required` and canonical decision metadata.
  // While their stage exit is absent or blocked, an exact active logical field
  // remains admissible from current-owner evidence. This fallback depends on
  // semantic ownership and form state, never on executable/revealable mechanics.
  const lifecycle = descriptor.representationLifecycle || mergedRepresentationLifecycle(field, control);
  const surface = authoritativeCurrentSurface(page);
  const renderingEvidence = Object.values(control.operations || {}).flatMap((capability) => (
    capability
      ? [
          capability.actionability,
          ...Object.values(capability.actionabilityByActuator || {}),
          ...(capability.exactActuators || []).map((actuator) => actuator.proof)
        ]
      : []
  )).filter(Boolean);
  const explicitlyNotRendered = renderingEvidence.length > 0
    && renderingEvidence.every((evidence) => evidence.rendered === false);
  const currentSurfaceOwner = Boolean(
    control.controlId
    && !explicitlyNotRendered
    && (
      !surface?.id
      || surface.type === "page"
      || control.surfaceId === surface.id
      || (surface.memberControlIds || []).includes(control.controlId)
    )
  );
  return Boolean(
    lifecycle?.active === true
    || lifecycle?.status === "active_rendered"
    || currentSurfaceOwner
    || field.required === true
    || control.required === true
  );
}

function descriptorHasActiveRepresentation(descriptor = {}) {
  return ownsActiveRepresentation(
    { ...(descriptor.field || {}), representationLifecycle: descriptor.representationLifecycle || descriptor.field?.representationLifecycle },
    descriptor.control || {}
  );
}

function verifiedProfileComponentMatchesDescriptor(completion = {}, descriptor = {}) {
  if (completion?.status !== "verified" || completion?.contractVersion !== "verified-profile-component/v1") return false;
  const sameOwner = Boolean(
    completion.logicalFieldId
    && descriptor.logicalFieldId
    && completion.logicalFieldId === descriptor.logicalFieldId
  ) || Boolean(
    completion.semanticType === descriptor.semanticType
    && String(completion.subjectId || "traveler_1") === String(descriptor.subjectId || "traveler_1")
    && String(completion.componentRole || "value") === String(descriptor.componentRole || "value")
  );
  if (!sameOwner) return false;
  const desiredValue = descriptor.desiredNormalizedValue
    || canonicalLogicalValue(descriptor.semanticType, descriptor.value)
    || descriptor.value
    || "";
  return agentContract.profileChoiceValueCompatible(
    completion.selectedCanonicalValue,
    desiredValue,
    descriptor.semanticType
  );
}

function profileStageReadiness(observation = {}, traveler = {}, verifiedProfileComponents = [], options = {}) {
  const page = observation.page || {};
  const fields = profileFieldsForPage(page);
  const descriptors = Array.isArray(options.descriptors)
    ? options.descriptors
    : fieldDescriptors(observation, traveler);
  const step = String(page.step || "").toLowerCase();
  const hasProfileControls = fields.some((field) => PROFILE_FIELDS.has(normalizeProfileFieldType(field.fieldType || field.field || "")));
  const profileStage = hasProfileControls || /traveler|traveller|passenger|contact|document/.test(step);
  const unresolvedKnown = descriptors
    .filter((descriptor) => descriptorOwnsActiveRequirement(descriptor, page))
    .filter((descriptor) => !descriptor.hasValue)
    .filter((descriptor) => !(verifiedProfileComponents || []).some((completion) => (
      verifiedProfileComponentMatchesDescriptor(completion, descriptor)
    )))
    .map((descriptor) => ({
      semanticType: descriptor.semanticType,
      controlId: descriptor.control?.controlId || "",
      label: descriptor.label || descriptor.semanticType,
      currentNormalizedValue: descriptor.currentNormalizedValue || "",
      desiredNormalizedValue: descriptor.desiredNormalizedValue || ""
    }));
  const explicitUnresolvedRequired = fields.flatMap((field) => {
    if (!ownsActiveRepresentation(field, {})) return [];
    if (!field.required) return [];
    const semanticType = normalizeProfileFieldType(field.fieldType || field.field || "");
    if (!PROFILE_FIELDS.has(semanticType)) return [];
    const descriptorForField = descriptors.find((descriptor) => (
      descriptor.semanticType === semanticType
      && (
        !field.controlId
        || descriptor.control?.controlId === field.controlId
        || descriptor.logicalFieldId === field.logicalFieldId
      )
    ));
    if (descriptorForField && (verifiedProfileComponents || []).some((completion) => (
      verifiedProfileComponentMatchesDescriptor(completion, descriptorForField)
    ))) return [];
    const canonicalValue = desiredProfileValue(semanticType, traveler, { page });
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
    .filter((field) => (
      ownsActiveRepresentation(field, {})
      && PROFILE_FIELDS.has(normalizeProfileFieldType(field.fieldType || field.field || ""))
    ))
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


module.exports = {
  PROFILE_FIELDS,
  PROFILE_FIELD_ORDER,
  normalizeProfileFieldType,
  profileStageReadiness,
  scopedValidationIssues,
  validationIssueMessage,
  fieldDescriptors,
  descriptorOwnsActiveRequirement,
  descriptorHasActiveRepresentation,
  mergedRepresentationLifecycle,
  ownedCurrentSurface,
  ownsActiveRepresentation,
  verifiedProfileComponentMatchesDescriptor
};
