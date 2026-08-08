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

function descriptorFromPublishedProfileGoal(atom, observation = {}) {
  if (atom.kind !== "profile_field") return null;
  const page = observation.page || {};
  const publishedControlId = atom.controlId || atom.componentBinding?.controlId || "";
  const control = (page.controls || []).find((candidate) => candidate.controlId === publishedControlId) || null;
  if (!control || !ownsActiveRepresentation({}, control)) return null;

  const field = (page.fields || []).find((candidate) => candidate.controlId === control.controlId) || {};
  const desiredValue = atom.expectedNormalizedValue
    || atom.semanticGoal?.desiredValue
    || atom.expectedValue
    || "";
  // The admitted logical-field postcondition is the semantic success fact.
  // An observed actuator may expose a narrower mechanical outcome (for
  // example `control_selected`), but it must not replace that fact. Split
  // state/actuator widgets often retain the canonical value on the logical
  // component rather than the clicked presentation node.
  const expectedOutcome = atom.postcondition || atom.expectedOutcome || null;
  const freshCapabilityContracts = (agentContract.observedComponentContract(control, {
    surfaceId: control.surfaceId || "surface-page"
  }).capabilities || []).map((capability) => ({
    ...capability,
    expectedOutcome: expectedOutcome || {}
  }));
  const componentBinding = atom.componentBinding || {
    logicalFieldId: atom.logicalFieldId || "",
    componentIdentity: atom.descriptorKey || `${atom.logicalFieldId || control.stableKey || control.controlId}:${atom.componentRole || "value"}`,
    componentRole: atom.componentRole || "value",
    controlId: control.controlId,
    controlRole: control.role || field.role || "",
    currentCanonicalValue: control.state?.normalizedValue || "",
    desiredCanonicalValue: desiredValue,
    exactOption: null,
    observedOptions: control.options || []
  };
  return {
    key: atom.descriptorKey || componentBinding.componentIdentity,
    domOrder: Number(control.order || 0),
    semanticType: atom.semanticType || atom.requirementContract?.semanticType || "",
    ordinal: Number(atom.ordinal || 0),
    label: control.label || field.label || atom.label || atom.semanticType || "",
    field,
    control,
    value: atom.expectedValue || desiredValue,
    observedRole: control.role || field.role || componentBinding.controlRole || "",
    observedCapabilities: control.capabilities || [],
    // Capabilities are mechanics from the immutable current observation. They
    // are rebuilt here and never persisted in CurrentObligation.
    capabilityContracts: freshCapabilityContracts,
    requirementContract: atom.requirementContract || null,
    bindingContract: agentContract.canonicalPipelineContract({
      requirement: atom.requirementContract || {},
      component: {
        ...componentBinding,
        controlId: control.controlId,
        controlRole: control.role || field.role || componentBinding.controlRole || ""
      },
      capability: {},
      expectedOutcome: expectedOutcome || {},
      validationOwnership: atom.validationOwnership || {}
    }),
    expectedOutcome,
    validationOwnership: atom.validationOwnership || null,
    choiceLike: Boolean(
      atom.choiceLike
      || control.choiceContract
      || ["radio", "checkbox", "option"].includes(control.role || control.kind)
    ),
    choiceTerms: [...(atom.choiceTerms || [])],
    currentNormalizedValue: control.state?.normalizedValue || "",
    desiredNormalizedValue: desiredValue,
    exactOption: componentBinding.exactOption || null,
    canonicalValue: atom.expectedCanonicalValue || desiredValue,
    dateCodec: atom.dateCodec || null,
    codecError: atom.codecError || null,
    hasValue: false,
    validationIssues: [],
    conflictingSelectedControlIds: [],
    logicalFieldId: atom.logicalFieldId || componentBinding.logicalFieldId || "",
    subjectId: atom.subjectId || atom.requirementContract?.subjectId || "traveler_1",
    componentRole: atom.componentRole || componentBinding.componentRole || "value",
    logicalStructure: atom.logicalStructure || "scalar",
    logicalCurrentCanonicalValue: "",
    logicalDesiredCanonicalValue: atom.expectedCanonicalValue || desiredValue,
    logicalFieldSatisfied: false,
    logicalFieldValidationIssues: [],
    instructions: [...(atom.instructions || [])],
    options: [...(atom.options || [])],
    ambiguity: atom.ambiguity || null,
    representationLifecycle: mergedRepresentationLifecycle(field, control)
  };
}

function descriptorForAtom(atom, observation = {}, traveler = {}, {
  publishedSemanticAuthority = false
} = {}) {
  const published = publishedSemanticAuthority
    ? descriptorFromPublishedProfileGoal(atom, observation)
    : null;
  const descriptors = published
    ? []
    : fieldDescriptors(observation, traveler).filter(descriptorHasActiveRepresentation);
  let base = published || (
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
  // Legacy skill atoms do not always carry the full field contract. Preserve
  // this narrow compatibility fallback; current profile-goal execution uses
  // the published contract above and never runs a second semantic pass.
  if (!base && atom.kind === "profile_field") {
    base = descriptorFromPublishedProfileGoal(atom, observation);
  }
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
  if (currentBinding && ownsActiveRepresentation({}, currentBinding.control || {})) {
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
  if (descriptor.observedOption && strategy.operation === "choose" && !descriptor.choiceLike) {
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
    // Capability contracts prove *how* the actuator can be operated. The
    // profile obligation owns what must be true afterwards. Keeping the
    // semantic postcondition authoritative avoids verifying a split widget
    // against the clicked presentation node's generic mechanical outcome.
    candidate.expectedOutcome = expectedOutcomeForStrategy(atom, descriptor, candidate, observation);
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

function semanticGoalAtom(goal = {}, attemptedCandidateIds = []) {
  return {
    atomId: obligationField(goal, "goalId") || "",
    kind: obligationField(goal, "kind") || "profile_field",
    descriptorKey: obligationField(goal, "descriptorKey") || "",
    semanticType: obligationField(goal, "semanticType") || "",
    ordinal: Number(obligationField(goal, "ordinal") || 0),
    logicalFieldId: obligationField(goal, "logicalFieldId") || "",
    subjectId: obligationField(goal, "subjectId") || "traveler_1",
    componentRole: obligationField(goal, "componentRole") || "value",
    label: obligationField(goal, "label") || obligationField(goal, "semanticType") || "",
    semanticGoal: {
      semanticType: obligationField(goal, "semanticType") || "",
      desiredValue: obligationField(goal, "desiredValue") || ""
    },
    postcondition: {
      type: obligationField(goal, "postcondition")?.type || "normalized_value_changed",
      expectedValue: obligationField(goal, "postcondition")?.expectedValue || obligationField(goal, "desiredValue") || "",
      expectedCanonicalValue: obligationField(goal, "postcondition")?.expectedCanonicalValue || obligationField(goal, "canonicalValue") || "",
      dateCodec: obligationField(goal, "postcondition")?.dateCodec || obligationField(goal, "dateCodec") || null
    },
    expectedValue: obligationField(goal, "inputValue") || obligationField(goal, "desiredValue") || "",
    expectedNormalizedValue: obligationField(goal, "desiredValue") || "",
    expectedCanonicalValue: obligationField(goal, "canonicalValue") || "",
    dateCodec: obligationField(goal, "dateCodec") || null,
    codecError: obligationField(goal, "codecError") || null,
    ambiguity: obligationField(goal, "ambiguity") || null,
    logicalStructure: obligationField(goal, "logicalStructure") || "scalar",
    label: obligationField(goal, "label") || obligationField(goal, "semanticType") || "",
    instructions: [...(obligationField(goal, "instructions") || [])],
    options: [...(obligationField(goal, "options") || [])],
    controlId: obligationField(goal, "controlId") || obligationField(goal, "componentBinding")?.controlId || "",
    requirementContract: obligationField(goal, "requirementContract") || null,
    componentBinding: obligationField(goal, "componentBinding") || null,
    capabilityContracts: [...(obligationField(goal, "capabilityContracts") || [])],
    validationOwnership: obligationField(goal, "validationOwnership") || null,
    expectedOutcome: obligationField(goal, "expectedOutcome") || obligationField(goal, "postcondition") || null,
    choiceTerms: [...(obligationField(goal, "choiceTerms") || [])],
    strategyHistory: (attemptedCandidateIds || []).map((strategyId) => ({
      strategyId,
      status: "attempted"
    }))
  };
}

function descriptorForSemanticGoal(goal = {}, observation = {}, traveler = {}, options = {}) {
  const atom = semanticGoalAtom(goal);
  return descriptorForAtom(atom, observation, traveler, options);
}

function profileGoalForDescriptor(descriptor = {}, observation = {}, previousGoal = null) {
  const {
    semanticGoal: _discardedAdaptiveSemanticGoal,
    selectionMode: _discardedSelectionMode,
    adaptiveEnvelope: _discardedAdaptiveEnvelope,
    sourceGoal: _discardedSourceGoal,
    sourceGoalId: _discardedSourceGoalId,
    surfaceId: _discardedAdaptiveSurfaceId,
    ...stablePreviousGoal
  } = previousGoal || {};
  const observationId = String(observation.observationId || "");
  const goalControl = descriptor.goalControl || descriptor.control || {};
  const desiredValue = descriptor.desiredNormalizedValue
    || canonicalLogicalValue(descriptor.semanticType, descriptor.value)
    || descriptor.value;
  return {
    ...stablePreviousGoal,
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

function selectNextProfileRequirement(observation = {}, traveler = {}, currentGoal = null, verifiedProfileComponents = [], options = {}) {
  const page = observation.page || {};
  const descriptors = (Array.isArray(options.descriptors)
    ? options.descriptors
    : fieldDescriptors(observation, traveler))
    .filter((descriptor) => descriptorOwnsActiveRequirement(descriptor, page))
    .filter((descriptor) => !descriptor.hasValue)
    .filter((descriptor) => !(verifiedProfileComponents || []).some((completion) => (
      verifiedProfileComponentMatchesDescriptor(completion, descriptor)
    )));

  // Requirement ordering is semantic authority only. Current DOM mechanics
  // must not decide which traveler fact Fly works on next.
  if (currentGoal?.goalId) {
    const rebound = descriptorForSemanticGoal(currentGoal, observation, traveler);
    if (
      rebound
      && descriptorOwnsActiveRequirement(rebound, page)
      && !rebound.hasValue
      && !(verifiedProfileComponents || []).some((completion) => (
        verifiedProfileComponentMatchesDescriptor(completion, rebound)
      ))
    ) {
      return {
        goal: profileGoalForDescriptor(rebound, observation, currentGoal),
        candidates: [],
        blockedFields: [],
        failureCode: ""
      };
    }
  }
  const descriptor = descriptors[0] || null;
  return {
    goal: descriptor ? profileGoalForDescriptor(descriptor, observation) : null,
    candidates: [],
    blockedFields: [],
    failureCode: ""
  };
}

function profileGoalSatisfied(goal = {}, observation = {}, traveler = {}) {
  if (!obligationField(goal, "goalId")) return false;
  const verification = verifyLogicalField(observation.page || {}, {
    logicalFieldId: obligationField(goal, "logicalFieldId") || "",
    subjectId: obligationField(goal, "subjectId") || "traveler_1",
    semanticType: obligationField(goal, "semanticType") || "",
    componentRole: obligationField(goal, "componentRole") || "value",
    controlId: obligationField(goal, "controlId") || "",
    expectedComponentValue: obligationField(goal, "desiredValue") || "",
    expectedCanonicalValue: obligationField(goal, "canonicalValue") || ""
  });
  if (!verification.logicalField) return false;
  if (obligationField(goal, "reconciliation")) {
    const commit = verification.component?.control?.commitState || {};
    return Boolean(
      commit.status === "settled"
      && commit.popupClosed === true
      && commit.focusSettled === true
      && Number(commit.attempts || 0) > Number(obligationField(goal, "reconciliation").priorCommitAttempts || 0)
    );
  }
  return obligationField(goal, "logicalStructure") === "composite"
    ? verification.componentResult.satisfied
    : verification.componentResult.satisfied && verification.logicalFieldResult.satisfied;
}

function candidatesForProfileGoal(goal = {}, observation = {}, traveler = {}, attemptedCandidateIds = [], options = {}) {
  if (!obligationField(goal, "goalId")) return [];
  const descriptor = descriptorForSemanticGoal(goal, observation, traveler, {
    // TaskState already compiled the semantic type and desired value. This
    // layer only rebinds that contract to the current exact actuator.
    publishedSemanticAuthority: true
  });
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
    goalId: obligationField(goal, "goalId"),
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
    goalId: obligationField(goal, "goalId"),
    candidateId: candidate.candidateId,
    candidateClass: candidate.candidateClass || "proven_action",
    mechanicalHypothesis: candidate.mechanicalHypothesis === true,
    discoveryEnvelope: candidate.discoveryEnvelope || null,
    logicalControlId: candidate.logicalControlId || candidate.controlId || obligationField(goal, "controlId") || "",
    actuatorId: candidate.actuatorId || candidate.targetId || "",
    controlId: candidate.controlId || obligationField(goal, "controlId") || "",
    targetId: candidate.targetId || "",
    interactionMethod: candidate.interactionMethod || "",
    boundedRecovery: candidate.boundedRecovery === true,
    exactOption: candidate.exactOption || candidate.pipelineContract?.component?.exactOption || null,
    targetLabel: obligationField(goal, "label") || obligationField(goal, "semanticType") || "",
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
    reason: `Execute candidate ${candidate.candidateId} for ${obligationField(goal, "semanticType")}=${obligationField(goal, "desiredValue")}.`
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
  verifiedProfileComponentMatchesDescriptor,
  selectNextProfileRequirement,
  profileGoalSatisfied,
  candidatesForProfileGoal,
  actionForProfileCandidate
};
