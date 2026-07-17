const { normalizeAction } = require("../../../packages/shared/agent-actions");
const { conflictedControlIds } = require("./control-alias-index");
const { currentSurface: authoritativeCurrentSurface } = require("./surface-contract");
const { deriveActionSemantics } = require("./action-semantics");

const COMPOUND_ACTIONS = new Set(["fill_known_fields", "fill_visible_profile_fields"]);

const PROFILE_FIELDS = new Set([
  "email",
  "confirm_email",
  "phone_country_code",
  "phone",
  "title",
  "first_name",
  "middle_name",
  "last_name",
  "full_name",
  "gender",
  "date_of_birth",
  "nationality",
  "passport_number",
  "document_number",
  "issuing_country",
  "passport_expiry",
  "document_expiry"
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
  "full_name",
  "date_of_birth",
  "nationality",
  "passport_number",
  "document_number",
  "issuing_country",
  "passport_expiry",
  "document_expiry"
];

const COUNTRY_DIAL_CODES = new Map([
  ["slovenia", "+386"], ["si", "+386"], ["svn", "+386"],
  ["croatia", "+385"], ["hr", "+385"], ["hrv", "+385"],
  ["bosnia and herzegovina", "+387"], ["bosnia", "+387"], ["ba", "+387"], ["bih", "+387"],
  ["serbia", "+381"], ["rs", "+381"], ["srb", "+381"],
  ["united kingdom", "+44"], ["uk", "+44"], ["gb", "+44"], ["gbr", "+44"],
  ["united states", "+1"], ["usa", "+1"], ["us", "+1"],
  ["germany", "+49"], ["de", "+49"], ["deu", "+49"],
  ["austria", "+43"], ["at", "+43"], ["aut", "+43"],
  ["italy", "+39"], ["it", "+39"], ["ita", "+39"],
  ["france", "+33"], ["fr", "+33"], ["fra", "+33"],
  ["spain", "+34"], ["es", "+34"], ["esp", "+34"],
  ["switzerland", "+41"], ["ch", "+41"], ["che", "+41"]
]);

function normalizedPhoneParts(traveler = {}) {
  const explicitCode = String(
    traveler.phone_country_code
      || traveler.phoneCountryCode
      || traveler.country_code
      || traveler.dial_code
      || ""
  ).trim();
  const explicitLocal = String(
    traveler.phone_local_number
      || traveler.local_phone_number
      || traveler.phoneLocalNumber
      || ""
  ).replace(/[^0-9]/g, "");
  const raw = String(traveler.phone || traveler.mobile || "").trim();
  const digits = raw.replace(/[^0-9]/g, "");
  let countryCode = explicitCode ? `+${explicitCode.replace(/[^0-9]/g, "")}` : "";
  if (!countryCode) {
    const nationality = String(traveler.nationality || traveler.country || "").trim().toLowerCase();
    countryCode = COUNTRY_DIAL_CODES.get(nationality) || "";
  }
  if (!countryCode && raw.startsWith("+")) {
    const knownCodes = [...new Set(COUNTRY_DIAL_CODES.values())].sort((a, b) => b.length - a.length);
    countryCode = knownCodes.find((code) => digits.startsWith(code.slice(1))) || "";
  }
  const codeDigits = countryCode.replace(/[^0-9]/g, "");
  const localNumber = explicitLocal
    || (codeDigits && digits.startsWith(codeDigits) ? digits.slice(codeDigits.length) : digits).replace(/^0+/, "");
  return { countryCode, localNumber };
}

function normalizedTitle(traveler = {}) {
  const explicit = String(traveler.title || traveler.salutation || "").trim();
  if (explicit) return explicit;
  const gender = String(traveler.gender || traveler.sex || "").toLowerCase();
  if (/female|woman|mrs|ms|miss/.test(gender)) return "Mrs/Ms";
  if (/male|man|mr/.test(gender)) return "Mr";
  return "";
}

function parsedDate(value = "") {
  const raw = String(value || "").trim();
  let match = raw.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (match) return { year: match[1], month: match[2].padStart(2, "0"), day: match[3].padStart(2, "0") };
  match = raw.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (match) return { year: match[3], month: match[2].padStart(2, "0"), day: match[1].padStart(2, "0") };
  return null;
}

function matchingOptionValue(field = {}, wanted = "", alternatives = []) {
  const options = Array.isArray(field.options) ? field.options : [];
  const candidates = [wanted, ...alternatives].map((item) => String(item || "").trim().toLowerCase()).filter(Boolean);
  const option = options.find((item) => {
    const value = String(item.value || "").trim().toLowerCase();
    const label = String(item.label || "").trim().toLowerCase();
    return candidates.some((candidate) => value === candidate || label === candidate);
  });
  return option ? String(option.value) : String(wanted || "");
}

function normalizedComparableValue(value = "") {
  return String(value || "").toLowerCase().replace(/[^a-z0-9+]+/g, " ").replace(/\s+/g, " ").trim();
}

function normalizedProfileValue(semanticType = "", value = "") {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (semanticType === "phone_country_code") {
    const digits = text.replace(/[^0-9]/g, "");
    return digits ? `+${digits}` : "";
  }
  if (semanticType === "phone") return text.replace(/[^0-9]/g, "").replace(/^0+/, "");
  return text.toLowerCase();
}

function profileChoiceTerms(semanticType = "", value = "", traveler = {}) {
  const terms = [value];
  if (semanticType === "phone_country_code") {
    terms.push(
      String(value || "").replace(/[^0-9]/g, ""),
      traveler.nationality,
      traveler.country,
      traveler.country_code,
      traveler.address_country
    );
  }
  if (["title", "gender"].includes(semanticType)) {
    if (/^mr$/i.test(value)) terms.push("male");
    if (/mrs|ms|miss/i.test(value)) terms.push("female", "mrs", "ms", "miss");
  }
  return [...new Set(terms.map(normalizedComparableValue).filter(Boolean))];
}

function valueMatchesChoice(actual = "", terms = []) {
  const normalized = normalizedComparableValue(actual);
  if (!normalized) return false;
  return terms.some((term) => {
    if (!term) return false;
    if (term.startsWith("+")) {
      const actualDigits = normalized.replace(/[^0-9]/g, "");
      const wantedDigits = term.replace(/[^0-9]/g, "");
      return actualDigits === wantedDigits;
    }
    return normalized === term || normalized.includes(term);
  });
}

function dateValueForField(value, field = {}) {
  const date = parsedDate(value);
  if (!date) return String(value || "");
  const hint = [field.label, field.placeholder, field.name, field.autocomplete, field.formatHint]
    .filter(Boolean).join(" ").toLowerCase();
  const monthNames = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  if (/\bday\b|\bdd\b/.test(hint) && !/month|year|yyyy|mm[-/.]dd/.test(hint)) {
    return matchingOptionValue(field, date.day, [String(Number(date.day))]);
  }
  if (/\bmonth\b|\bmm\b/.test(hint) && !/day|year|yyyy|dd[-/.]mm/.test(hint)) {
    return matchingOptionValue(field, date.month, [String(Number(date.month)), monthNames[Number(date.month) - 1]]);
  }
  if (/\byear\b|\byyyy\b/.test(hint) && !/day|month|dd|mm/.test(hint)) {
    return matchingOptionValue(field, date.year);
  }
  if (field.kind === "date") return `${date.year}-${date.month}-${date.day}`;
  if (/mm[-/.]dd[-/.]yyyy|month.+day.+year/.test(hint)) return `${date.month}/${date.day}/${date.year}`;
  if (/yyyy[-/.]mm[-/.]dd|year.+month.+day/.test(hint)) return `${date.year}-${date.month}-${date.day}`;
  const separator = hint.includes("/") ? "/" : hint.includes(".") ? "." : "-";
  return `${date.day}${separator}${date.month}${separator}${date.year}`;
}

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function profileValue(fieldType = "", traveler = {}, field = {}) {
  const document = traveler.document || {};
  const phone = normalizedPhoneParts(traveler);
  const title = normalizedTitle(traveler);
  const values = {
    first_name: traveler.first_name,
    middle_name: traveler.middle_name,
    last_name: traveler.last_name,
    full_name: [traveler.first_name, traveler.middle_name, traveler.last_name].filter(Boolean).join(" "),
    email: traveler.email,
    confirm_email: traveler.email,
    phone_country_code: phone.countryCode,
    phone: phone.localNumber,
    title,
    gender: traveler.gender,
    date_of_birth: traveler.date_of_birth,
    nationality: traveler.nationality,
    passport_number: document.has_document_number ? "profile://document_number" : "",
    document_number: document.has_document_number ? "profile://document_number" : "",
    issuing_country: document.issuing_country,
    passport_expiry: document.expiry_date,
    document_expiry: document.expiry_date
  };
  const value = String(values[fieldType] || "");
  if (fieldType === "date_of_birth") return dateValueForField(value, field);
  if (["title", "gender"].includes(fieldType) && field.kind === "select") {
    return matchingOptionValue(field, title, title === "Mrs/Ms" ? ["Mrs", "Ms", "Miss"] : [title]);
  }
  return value;
}

function canonicalField(page = {}, field = {}) {
  const controlId = field.controlId || "";
  return (page.controls || []).find((control) => control.controlId === controlId) || null;
}

function profileFieldsForPage(page = {}) {
  if (Array.isArray(page.fields) && page.fields.length) return page.fields;
  return (page.controls || []).flatMap((control) => {
    const field = String(control.field || control.semantic || "");
    if (!PROFILE_FIELDS.has(field)) return [];
    const state = control.state || control.controlState || {};
    return [{
      ...control,
      id: control.stateElementId || control.controlId,
      field,
      controlState: state,
      hasValue: Boolean(control.hasValue || state.valuePresent || state.checked || state.selected),
      value: state.valuePresent ? "[filled]" : ""
    }];
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
  const ordinals = new Map();
  return profileFieldsForPage(page).flatMap((field) => {
    const semanticType = String(field.field || "");
    if (!PROFILE_FIELDS.has(semanticType)) return [];
    const ordinal = ordinals.get(semanticType) || 0;
    ordinals.set(semanticType, ordinal + 1);
    const control = canonicalField(page, field);
    const value = profileValue(semanticType, traveler, field);
    if (!control || !value || control.state?.disabled === true) return [];
    const choiceLike = ["title", "gender"].includes(semanticType)
      && (["radio", "checkbox", "choice"].includes(String(field.kind || "").toLowerCase())
        || ["radio", "checkbox"].includes(String(control.role || "").toLowerCase()));
    if (choiceLike) {
      const candidate = `${field.label || ""} ${control.label || ""} ${control.accessibleName || ""}`.toLowerCase();
      const wanted = value.toLowerCase();
      const matches = wanted === "mrs/ms"
        ? /\bmrs\b|\bms\b|\bmiss\b/.test(candidate)
        : new RegExp(`\\b${wanted.replace(/[^a-z0-9]+/g, "\\s*")}\\b`, "i").test(candidate);
      if (!matches) return [];
    }
    const choiceTerms = profileChoiceTerms(semanticType, value, traveler);
    const currentNormalizedValue = String(control.state?.normalizedValue || "");
    const desiredNormalizedValue = normalizedProfileValue(semanticType, value);
    const valueSatisfied = choiceLike
      ? Boolean(control.selected || control.state?.checked || control.state?.selected)
      : Boolean(desiredNormalizedValue && currentNormalizedValue === desiredNormalizedValue);
    const validationIssues = scopedValidationIssues(page, {
      controlIds: new Set([control.controlId].filter(Boolean)),
      sectionIds: new Set([control.sectionId].filter(Boolean)),
      sectionTypes: new Set([String(control.sectionType || field.sectionType || "").toLowerCase()].filter(Boolean)),
      surfaceIds: new Set([control.surfaceId].filter(Boolean))
    });
    return [{
      key: `${semanticType}:${ordinal}`,
      semanticType,
      ordinal,
      label: String(field.label || control.label || semanticType).slice(0, 240),
      field,
      control,
      value,
      observedRole: control.role || field.role || "",
      observedCapabilities: control.capabilities || [],
      choiceLike,
      choiceTerms,
      currentNormalizedValue,
      desiredNormalizedValue,
      hasValue: valueSatisfied && validationIssues.length === 0,
      validationIssues
    }];
  }).sort((a, b) => {
    const ai = PROFILE_FIELD_ORDER.indexOf(a.semanticType);
    const bi = PROFILE_FIELD_ORDER.indexOf(b.semanticType);
    return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi) || a.ordinal - b.ordinal;
  });
}

function profileStageReadiness(observation = {}, traveler = {}) {
  const page = observation.page || {};
  const fields = profileFieldsForPage(page);
  const descriptors = fieldDescriptors(observation, traveler);
  const step = String(page.step || "").toLowerCase();
  const hasProfileControls = fields.some((field) => PROFILE_FIELDS.has(String(field.field || "")));
  const profileStage = hasProfileControls || /traveler|traveller|passenger|contact|document/.test(step);
  const unresolvedKnown = descriptors
    .filter((descriptor) => !descriptor.hasValue)
    .map((descriptor) => ({
      semanticType: descriptor.semanticType,
      controlId: descriptor.control?.controlId || "",
      label: descriptor.label || descriptor.semanticType,
      currentNormalizedValue: descriptor.currentNormalizedValue || "",
      desiredNormalizedValue: descriptor.desiredNormalizedValue || ""
    }));
  const unresolvedRequired = fields.flatMap((field) => {
    if (!field.required) return [];
    const state = field.controlState || {};
    const satisfied = Boolean(field.hasValue || state.valuePresent || state.checked || state.selected);
    if (satisfied) return [];
    if (["title", "gender"].includes(String(field.field || ""))) {
      const peerSatisfied = fields.some((peer) => peer.field === field.field
        && Boolean(peer.hasValue || peer.controlState?.checked || peer.controlState?.selected));
      if (peerSatisfied) return [];
    }
    return [{
      semanticType: String(field.field || "unknown"),
      controlId: String(field.controlId || ""),
      label: String(field.label || field.field || "Required traveler field"),
      valueAvailable: Boolean(profileValue(String(field.field || ""), traveler, field))
    }];
  });
  const missingUserData = unresolvedRequired.filter((item) => item.valueAvailable === false);
  const profileControlIds = new Set(fields
    .filter((field) => PROFILE_FIELDS.has(String(field.field || "")))
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
  const desiredNormalizedValue = descriptor.desiredNormalizedValue || normalizedProfileValue(descriptor.semanticType, descriptor.value);
  return {
    atomId: `${planId}:${descriptor.key}`,
    kind: "profile_field",
    semanticType: descriptor.semanticType,
    ordinal: descriptor.ordinal,
    label: descriptor.label,
    semanticGoal: {
      semanticType: descriptor.semanticType,
      desiredValue: desiredNormalizedValue || descriptor.value || ""
    },
    postcondition: {
      type: "normalized_value_changed",
      expectedValue: desiredNormalizedValue || descriptor.value || ""
    },
    valueRef: `profile://${descriptor.semanticType}`,
    expectedValue: descriptor.value,
    expectedNormalizedValue: desiredNormalizedValue,
    choiceTerms: descriptor.choiceTerms || [],
    strategyHistory: [],
    maxStrategyAttempts: 4,
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
  const existing = new Set((plan.atoms || []).map((atom) => `${atom.semanticType}:${atom.ordinal}`));
  for (const descriptor of fieldDescriptors(observation, traveler)) {
    if (existing.has(descriptor.key)) continue;
    plan.atoms.push(atomFromDescriptor(plan.planId, descriptor, observationId));
    existing.add(descriptor.key);
  }
  return plan;
}

function descriptorForAtom(atom, observation = {}, traveler = {}) {
  const base = fieldDescriptors(observation, traveler)
    .find((descriptor) => descriptor.semanticType === atom.semanticType && descriptor.ordinal === atom.ordinal) || null;
  const customChoice = descriptorForCustomChoiceAtom(atom, observation);
  if (customChoice) {
    return {
      ...customChoice,
      goalControl: base?.control || null,
      goalControlId: base?.control?.controlId || ""
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

function choiceOptionScore(control = {}, terms = [], surface = {}) {
  if (!control?.controlId) return 0;
  if (surface?.id && control.surfaceId && surface.id !== control.surfaceId) return 0;
  const role = String(control.role || control.kind || "").toLowerCase();
  if (!/option|radio|checkbox|button/.test(role)) return 0;
  const label = normalizedComparableValue(`${control.label || ""} ${control.accessibleName || ""}`);
  if (!label) return 0;
  let score = 0;
  for (const term of terms) {
    if (label === term) score += 100;
    else if (term && label.includes(term)) score += term.startsWith("+") ? 70 : 35;
  }
  if (control.risk === "money" || /paid|accept_paid|add_to/.test(String(control.semantic || ""))) score -= 100;
  if (control.state?.disabled) score -= 100;
  return score;
}

function descriptorForCustomChoiceAtom(atom, observation = {}) {
  if (!(atom.choiceTerms || []).length) return null;
  const page = observation.page || {};
  const surface = ownedCurrentSurface(page);
  if (!surface || surface.type === "page") return null;
  const ranked = (page.controls || [])
    .map((control) => ({ control, score: choiceOptionScore(control, atom.choiceTerms || [], surface) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!ranked.length || (ranked[1] && ranked[0].score === ranked[1].score)) return null;
  const control = ranked[0].control;
  return {
    semanticType: atom.semanticType,
    ordinal: atom.ordinal,
    label: control.label || atom.label,
    field: { kind: control.kind || control.role || "option" },
    control,
    value: atom.expectedValue,
    observedOption: true,
    choiceTerms: atom.choiceTerms || [],
    hasValue: Boolean(control.selected || control.state?.selected || control.state?.checked)
  };
}

function strategyKey(strategy = {}) {
  const targetIdentity = ["type", "select", "keypress"].includes(strategy.actionType || "")
    ? ""
    : strategy.targetId || "";
  return [
    strategy.actionType || "",
    strategy.operation || "",
    targetIdentity,
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
  if (strategy.operation === "open") {
    return {
      type: "options_surface_appeared",
      controlId: targetControl.controlId,
      previousSurfaceId: surface?.id || "",
      previousExpanded: Boolean(targetControl.state?.expanded)
    };
  }
  if (strategy.operation === "type" && targetControl.role === "editable_combobox") {
    return {
      type: "semantic_progress",
      controlId: goalControl.controlId,
      expectedNormalizedValue: atom.expectedNormalizedValue || "",
      previousSurfaceId: surface?.id || "",
      previousValue: goalControl.state?.normalizedValue || ""
    };
  }
  if (strategy.operation === "keyboard") {
    return {
      type: "semantic_progress",
      controlId: goalControl.controlId,
      expectedNormalizedValue: atom.expectedNormalizedValue || "",
      previousSurfaceId: surface?.id || "",
      previousValue: goalControl.state?.normalizedValue || ""
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
      requireSurfaceDismissed: Boolean(surface)
    };
  }
  if (["type", "select"].includes(strategy.operation)) {
    return {
      type: atom.postcondition?.type || "normalized_value_changed",
      controlId: goalControl.controlId,
      expectedValue: strategy.value || descriptor.value || "",
      expectedNormalizedValue: atom.postcondition?.expectedValue || atom.expectedNormalizedValue || ""
    };
  }
  if (strategy.operation === "choose") {
    return {
      type: descriptor.choiceLike ? "control_selected" : "normalized_value_changed",
      controlId: goalControl.controlId,
      expectedNormalizedValue: atom.expectedNormalizedValue || ""
    };
  }
  return {
    type: "semantic_progress",
    controlId: goalControl.controlId,
    expectedNormalizedValue: atom.expectedNormalizedValue || "",
    previousSurfaceId: surface?.id || "",
    previousValue: goalControl.state?.normalizedValue || ""
  };
}

function strategyCandidatesForAtom(atom = {}, descriptor = null, observation = {}) {
  if (!descriptor?.control) return [];
  const control = descriptor.control;
  const operations = control.operations || {};
  const candidates = [];
  const nextTarget = (capability) => (capability?.actuatorIds || [])
    .find((targetId) => !(atom.strategyHistory || []).some((attempt) => (
      attempt.operation === capability.operation && attempt.targetId === targetId
    ))) || capability?.actuatorId || "";
  const add = (strategy) => {
    if (!strategy.targetId && !strategy.visualRegion) return;
    const candidate = {
      ...strategy,
      controlId: control.controlId,
      targetIds: strategy.targetId ? [strategy.targetId] : [],
      strategyId: strategyKey({ ...strategy, controlId: control.controlId })
    };
    candidate.expectedOutcome = expectedOutcomeForStrategy(atom, descriptor, candidate, observation);
    if (!strategyWasTried(atom, candidate)) candidates.push(candidate);
  };

  if (descriptor.observedOption && operations.choose) {
    add({ operation: "choose", actionType: "click", targetId: nextTarget(operations.choose), value: "", keys: "" });
    return candidates;
  }
  if (operations.select) {
    add({ operation: "select", actionType: "select", targetId: nextTarget(operations.select), value: descriptor.value || atom.expectedValue || "", keys: "" });
  }
  if (operations.type) {
    const queryValues = control.role === "editable_combobox"
      ? [...new Set([
          descriptor.value || atom.expectedValue || "",
          ...(atom.choiceTerms || []).filter((term) => /[a-z]/i.test(term))
        ].filter(Boolean))].slice(0, 3)
      : [descriptor.value || atom.expectedValue || ""];
    for (const value of queryValues) {
      add({ operation: "type", actionType: "type", targetId: nextTarget(operations.type), value, keys: "" });
    }
  }
  if (operations.open && control.state?.expanded !== true) {
    add({ operation: "open", actionType: "click", targetId: nextTarget(operations.open), value: "", keys: "" });
  }
  if (operations.choose) {
    add({ operation: "choose", actionType: "click", targetId: nextTarget(operations.choose), value: "", keys: "" });
  }
  if (operations.keyboard) {
    add({
      operation: "keyboard",
      actionType: "keypress",
      targetId: nextTarget(operations.keyboard),
      value: "",
      keys: control.state?.expanded === true ? "Enter" : "ArrowDown"
    });
  }
  if (operations.activate) {
    add({ operation: "activate", actionType: "click", targetId: nextTarget(operations.activate), value: "", keys: "" });
  }
  for (const [operation, recovery] of Object.entries(control.recovery || {})) {
    if (!recovery?.requiresVisualConfirmation) continue;
    for (const region of recovery.regions || []) {
      add({
        operation,
        actionType: "click_xy",
        targetId: "",
        value: "",
        keys: "",
        visualRegion: region,
        requiresAI: true
      });
    }
  }
  return candidates.slice(0, 12);
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
    semanticType: goal.semanticType || "",
    ordinal: Number(goal.ordinal || 0),
    label: goal.label || goal.semanticType || "",
    semanticGoal: {
      semanticType: goal.semanticType || "",
      desiredValue: goal.desiredValue || ""
    },
    postcondition: {
      type: goal.postcondition?.type || "normalized_value_changed",
      expectedValue: goal.postcondition?.expectedValue || goal.desiredValue || ""
    },
    expectedValue: goal.inputValue || goal.desiredValue || "",
    expectedNormalizedValue: goal.desiredValue || "",
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

function deriveProfileGoal(observation = {}, traveler = {}, currentGoal = null) {
  const observationId = String(observation.observationId || "");
  if (currentGoal?.goalId) {
    const descriptor = descriptorForSemanticGoal(currentGoal, observation, traveler);
    if (descriptor && !descriptor.hasValue) {
      const goalControl = descriptor.goalControl || descriptor.control || {};
      return {
        ...currentGoal,
        controlId: goalControl.controlId || currentGoal.controlId || "",
        currentValue: goalControl.state?.normalizedValue || "",
        observationId,
        updatedAt: new Date().toISOString()
      };
    }
    // A satisfied current goal is not a terminal signal. Fall through and
    // select the next unresolved semantic descriptor from this observation.
  }

  const descriptor = fieldDescriptors(observation, traveler)
    .find((item) => !item.hasValue);
  if (!descriptor) return null;
  const desiredValue = descriptor.desiredNormalizedValue
    || normalizedProfileValue(descriptor.semanticType, descriptor.value)
    || descriptor.value;
  return {
    goalId: `profile:${descriptor.semanticType}:${descriptor.ordinal}`,
    kind: "profile_field",
    semanticType: descriptor.semanticType,
    ordinal: descriptor.ordinal,
    label: descriptor.label || descriptor.semanticType,
    desiredValue,
    inputValue: descriptor.value,
    choiceTerms: [...(descriptor.choiceTerms || [])],
    controlId: descriptor.control?.controlId || "",
    currentValue: descriptor.currentNormalizedValue || "",
    postcondition: {
      type: "normalized_value_changed",
      expectedValue: desiredValue
    },
    observationId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function profileGoalSatisfied(goal = {}, observation = {}, traveler = {}) {
  if (!goal?.goalId) return false;
  const descriptor = descriptorForSemanticGoal(goal, observation, traveler);
  if (!descriptor?.hasValue) return false;
  const goalControl = descriptor.goalControl || descriptor.control || {};
  const issues = scopedValidationIssues(observation.page || {}, {
    controlIds: new Set([goalControl.controlId, goal.controlId].filter(Boolean)),
    sectionIds: new Set([goalControl.sectionId].filter(Boolean)),
    sectionTypes: new Set([String(goalControl.sectionType || "").toLowerCase()].filter(Boolean)),
    surfaceIds: new Set([goalControl.surfaceId].filter(Boolean))
  });
  return issues.length === 0;
}

function candidatesForProfileGoal(goal = {}, observation = {}, traveler = {}, attemptedCandidateIds = []) {
  if (!goal?.goalId) return [];
  const descriptor = descriptorForSemanticGoal(goal, observation, traveler);
  if (!descriptor || descriptor.hasValue) return [];
  if (conflictedControlIds(observation.page || {}).has(descriptor.control?.controlId)) return [];
  const atom = semanticGoalAtom(goal, attemptedCandidateIds);
  return strategyCandidatesForAtom(atom, descriptor, observation).map((strategy) => ({
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
    value: strategy.value || "",
    keys: strategy.keys || "",
    visualRegion: strategy.visualRegion || null,
    expectedOutcome: strategy.expectedOutcome,
    requiresJudgment: Boolean(strategy.requiresAI),
    summary: [
      strategy.operation,
      strategy.value ? `value=${strategy.value}` : "",
      strategy.keys ? `keys=${strategy.keys}` : "",
      strategy.visualRegion ? `visual=${strategy.visualRegion.source || "bounded-region"}` : ""
    ].filter(Boolean).join(" ")
  }));
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
  COMPOUND_ACTIONS,
  PROFILE_FIELDS,
  PROFILE_FIELD_ORDER,
  advanceSkillPlan,
  createSkillPlan,
  currentProfileSkillAtom,
  expandSkillAction,
  failSkillAction,
  markSkillActionGoverned,
  prepareSkillViewportRecovery,
  profileStageReadiness,
  profileValue,
  resumeSuspendedSkillPlan,
  skillRecoveryContext,
  strategyCandidatesForAtom,
  blockedObligationForPlan,
  exactRecoveryProof,
  recordBlockedObligationAttempt,
  reconcileBlockedObligationResult,
  scopedValidationIssues,
  validationIssueMessage,
  normalizedPhoneParts,
  dateValueForField,
  deriveProfileGoal,
  profileGoalSatisfied,
  candidatesForProfileGoal,
  actionForProfileCandidate
};
