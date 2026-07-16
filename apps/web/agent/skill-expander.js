const { normalizeAction } = require("../../../packages/shared/agent-actions");

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

function activeSurface(page = {}) {
  return [page.currentSurface, page.activeSurface]
    .find((surface) => surface?.type && surface.type !== "page") || null;
}

function planScope(observation = {}) {
  const page = observation.page || {};
  const surface = activeSurface(page);
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
  return (page.fields || []).flatMap((field) => {
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
    const nativeSelect = String(field.kind || "").toLowerCase() === "select";
    const customCombobox = !nativeSelect && ["combobox", "listbox"].includes(String(control.role || field.role || "").toLowerCase());
    const choiceTerms = profileChoiceTerms(semanticType, value, traveler);
    const currentNormalizedValue = String(control.state?.normalizedValue || "");
    const desiredNormalizedValue = normalizedProfileValue(semanticType, value);
    const valueSatisfied = choiceLike
      ? Boolean(control.selected || control.state?.checked || control.state?.selected)
      : Boolean(desiredNormalizedValue && currentNormalizedValue === desiredNormalizedValue);
    return [{
      key: `${semanticType}:${ordinal}`,
      semanticType,
      ordinal,
      label: String(field.label || control.label || semanticType).slice(0, 240),
      field,
      control,
      value,
      actionType: choiceLike ? "click" : nativeSelect ? "select" : customCombobox ? "click" : "type",
      choiceMode: customCombobox ? "custom_combobox" : nativeSelect ? "native_select" : choiceLike ? "choice" : "field",
      choiceTerms,
      currentNormalizedValue,
      desiredNormalizedValue,
      hasValue: valueSatisfied
    }];
  }).sort((a, b) => {
    const ai = PROFILE_FIELD_ORDER.indexOf(a.semanticType);
    const bi = PROFILE_FIELD_ORDER.indexOf(b.semanticType);
    return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi) || a.ordinal - b.ordinal;
  });
}

function profileStageReadiness(observation = {}, traveler = {}) {
  const page = observation.page || {};
  const fields = Array.isArray(page.fields) ? page.fields : [];
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
      label: String(field.label || field.field || "Required traveler field")
    }];
  });
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
    visibleErrors
  };
}

function atomFromDescriptor(planId, descriptor, observationId) {
  return {
    atomId: `${planId}:${descriptor.key}`,
    kind: "profile_field",
    semanticType: descriptor.semanticType,
    ordinal: descriptor.ordinal,
    label: descriptor.label,
    valueRef: `profile://${descriptor.semanticType}`,
    actionType: descriptor.actionType || "",
    choiceMode: descriptor.choiceMode || "field",
    phase: descriptor.choiceMode === "custom_combobox" ? "open" : "apply",
    expectedValue: descriptor.value,
    expectedNormalizedValue: descriptor.desiredNormalizedValue || normalizedProfileValue(descriptor.semanticType, descriptor.value),
    ownerControlId: descriptor.control?.controlId || "",
    choiceTerms: descriptor.choiceTerms || [],
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
    atoms: (plan.atoms || []).map((atom) => ({ ...atom }))
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

function recoveryOperationForAtom(atom = {}) {
  if (atom.choiceMode === "custom_combobox" && atom.phase === "open") return "open";
  if (atom.choiceMode === "custom_combobox" && atom.phase === "choose") return "choose";
  if (atom.choiceMode === "choice") return "choose";
  if (atom.actionType === "select") return "select";
  if (atom.actionType === "type") return "type";
  return "activate";
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
    if (issue.controlId && controlIds.has(String(issue.controlId))) return true;
    if (issue.sectionId && sectionIds.has(String(issue.sectionId))) return true;
    if (issue.sectionType && sectionTypes.has(String(issue.sectionType).toLowerCase())) return true;
    if (issue.surfaceId && surfaceIds.has(String(issue.surfaceId))) return true;
    return false;
  });
}

function recoveryExpectedOutcome(context = {}, observation = {}) {
  if (context.operation === "open") {
    const surface = activeSurface(observation.page || {});
    return {
      type: "options_surface_appeared",
      controlId: context.controlId || "",
      previousSurfaceId: surface?.id || "",
      previousExpanded: Boolean(context.state?.expanded)
    };
  }
  if (context.expectedNormalizedValue) {
    return {
      type: "normalized_value_changed",
      controlId: context.controlId || "",
      expectedNormalizedValue: context.expectedNormalizedValue
    };
  }
  return {
    type: context.capability?.expectedOutcome || "observable_change",
    controlId: context.controlId || ""
  };
}

function blockedObligationForPlan(plan = {}, observation = {}, traveler = {}, existing = null, blocker = {}) {
  const context = skillRecoveryContext(plan, observation, traveler);
  if (!context?.atomId || !context?.controlId) return null;
  const sameOwner = existing
    && existing.owner?.skillPlanId === context.planId
    && existing.owner?.atomId === context.atomId;
  const at = new Date().toISOString();
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
      surfaceId: String(observation.page?.currentSurface?.id || observation.page?.activeSurface?.id || "")
    },
    control: {
      controlId: context.controlId,
      label: context.controlLabel || context.label,
      semanticType: context.semanticType
    },
    operation: context.operation,
    blocker: {
      code: String(blocker.code || existing?.blocker?.code || "ACTUATOR_UNPROVEN"),
      message: String(blocker.message || plan.suspendedReason || context.suspendedReason || "The owned atomic operation has no proven actuator.").slice(0, 500),
      observationId: String(observation.observationId || ""),
      at
    },
    recoveryExpectedOutcome: recoveryExpectedOutcome(context, observation),
    expectedResult: {
      type: context.expectedNormalizedValue ? "normalized_value_changed" : recoveryExpectedOutcome(context, observation).type,
      controlId: context.controlId,
      expectedNormalizedValue: context.expectedNormalizedValue || ""
    },
    attempts: sameOwner ? [...(existing.attempts || [])] : [],
    proofs: sameOwner ? [...(existing.proofs || [])] : [],
    status: sameOwner && !["resolved", "handed_off", "failed"].includes(existing.status) ? existing.status : "blocked",
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
    control_selected: "CONTROL_SELECTED"
  }[expectedType] || "";
}

function exactRecoveryProof(obligation = {}, result = {}) {
  const expected = obligation.recoveryExpectedOutcome || {};
  const resultExpected = result.expectedOutcome || {};
  const outcomeCode = resultCode(result);
  const expectedCode = expectedSuccessCode(expected.type);
  const resultControlId = String(result.controlId || result.action?.controlId || result.targetSnapshot?.controlId || resultExpected.controlId || "");
  return Boolean(
    result.executed === true
    && result.verified === true
    && result.skillPlanId === obligation.owner?.skillPlanId
    && result.skillAtomId === obligation.owner?.atomId
    && resultControlId === obligation.control?.controlId
    && result.operation === obligation.operation
    && resultExpected.type === expected.type
    && String(resultExpected.controlId || "") === String(expected.controlId || "")
    && (!expectedCode || outcomeCode === expectedCode)
  );
}

function recordBlockedObligationAttempt(obligation = {}, action = {}) {
  if (!obligation?.obligationId || !["click", "type", "select", "click_xy"].includes(action.type)) return obligation;
  const at = new Date().toISOString();
  return {
    ...obligation,
    status: "recovering",
    attempts: [
      ...(obligation.attempts || []),
      {
        attempt: (obligation.attempts || []).length + 1,
        actionId: action.id || "",
        observationId: action.observationId || "",
        controlId: action.controlId || "",
        targetId: action.targetId || "",
        visualRegion: action.visualRegion || null,
        operation: action.operation || "",
        actionType: action.type || "",
        expectedOutcome: action.expectedOutcome || null,
        status: "dispatched",
        resultCode: "",
        at
      }
    ],
    updatedAt: at
  };
}

function reconcileBlockedObligationResult(obligation = {}, result = {}) {
  if (!obligation?.obligationId || !result?.actionId) return { obligation, exact: false };
  const attempts = (obligation.attempts || []).map((attempt) => attempt.actionId === result.actionId
    ? {
        ...attempt,
        status: result.verified === true ? "verified" : result.executed === true ? "failed" : "rejected",
        resultCode: resultCode(result) || "",
        completedAt: new Date().toISOString()
      }
    : attempt);
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
      proofs: proof ? [...(obligation.proofs || []), proof] : [...(obligation.proofs || [])],
      status: exact ? "recovered" : obligation.status,
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

const RETRYABLE_MECHANICAL_RESULT_CODES = new Set([
  "ACTIVE_SURFACE_NOT_CHANGED",
  "OPTIONS_SURFACE_NOT_APPEARED",
  "CANONICAL_ACTUATOR_UNAVAILABLE",
  "ACTION_OPERATION_ACTUATOR_MISMATCH",
  "TARGET_NOT_ACTIONABLE",
  "TARGET_COVERED"
]);

function resultCode(result = {}) {
  return String(result?.outcome?.code || result?.code || result?.result?.code || "");
}

function shouldReissueUnexecutedAtom(result = {}) {
  return result.executed === false && REISSUABLE_STALE_RESULT_CODES.has(resultCode(result));
}

function reconcileDispatchedAtom(plan, lastActionResult = {}, observationId = "") {
  const dispatched = plan.atoms.find((atom) => atom.status === "dispatched");
  if (!dispatched) return { plan, ambiguous: false };
  const resultActionId = String(lastActionResult?.actionId || "");
  if (!resultActionId || resultActionId !== dispatched.lastActionId) {
    return {
      plan: suspendPlan(plan, `No exact result was received for skill atom ${dispatched.atomId}.`, observationId),
      ambiguous: true
    };
  }
  if (shouldReissueUnexecutedAtom(lastActionResult)) {
    dispatched.status = "pending";
    dispatched.lastRejectedActionId = dispatched.lastActionId;
    dispatched.lastRejectedObservationId = dispatched.lastObservationId || "";
    dispatched.lastRejectionCode = resultCode(lastActionResult);
    dispatched.lastActionId = "";
    dispatched.lastControlId = "";
    dispatched.lastObservationId = "";
    dispatched.reissueCount = Number(dispatched.reissueCount || 0) + 1;
    return { plan, ambiguous: false, reissue: true };
  }
  if (lastActionResult.verified !== true) {
    const code = resultCode(lastActionResult) || "OUTCOME_NOT_VERIFIED";
    const maxAttempts = Math.max(1, Number(dispatched.operationActuatorCount || 1));
    if (RETRYABLE_MECHANICAL_RESULT_CODES.has(code) && Number(dispatched.attempts || 0) < Math.min(3, maxAttempts)) {
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
  if (dispatched.choiceMode === "custom_combobox" && dispatched.phase === "open") {
    dispatched.status = "pending";
    dispatched.phase = "choose";
    dispatched.openedObservationId = observationId;
    dispatched.lastActionId = "";
    dispatched.lastControlId = "";
    dispatched.lastObservationId = "";
    return { plan, ambiguous: false };
  }
  dispatched.status = "complete";
  dispatched.completedObservationId = observationId;
  dispatched.completionSource = "verified_action_result";
  dispatched.verificationCode = String(lastActionResult?.outcome?.code || "VERIFIED");
  return { plan, ambiguous: false };
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
  const customChoice = descriptorForCustomChoiceAtom(atom, observation);
  if (customChoice) return customChoice;
  return fieldDescriptors(observation, traveler)
    .find((descriptor) => descriptor.semanticType === atom.semanticType && descriptor.ordinal === atom.ordinal) || null;
}

function skillRecoveryContext(plan = {}, observation = {}, traveler = {}) {
  const atom = currentProfileSkillAtom(plan);
  if (!atom) return null;
  const descriptor = descriptorForAtom(atom, observation, traveler);
  const control = descriptor?.control || (observation.page?.controls || [])
    .find((item) => item.controlId === atom.ownerControlId) || null;
  const operation = recoveryOperationForAtom(atom);
  const capability = control?.operations?.[operation] || null;
  const recovery = control?.recovery?.[operation] || null;
  return {
    planId: plan.planId || "",
    skillType: plan.skillType || "",
    atomId: atom.atomId || "",
    semanticType: atom.semanticType || "",
    ordinal: Number(atom.ordinal || 0),
    label: atom.label || descriptor?.label || atom.semanticType || "",
    phase: atom.phase || "apply",
    operation,
    expectedNormalizedValue: atom.expectedNormalizedValue || "",
    choiceTerms: atom.choiceTerms || [],
    controlId: control?.controlId || atom.ownerControlId || "",
    controlLabel: control?.label || descriptor?.label || "",
    state: control?.state || null,
    capability,
    recovery,
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

  const exactRecoveryResult = Boolean(blockedObligation && exactRecoveryProof(blockedObligation, lastActionResult));
  if (exactRecoveryResult && atom.choiceMode === "custom_combobox" && atom.phase === "open" && activeSurface(observation.page || {})) {
    atom.phase = "choose";
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
    && atom.choiceMode === "custom_combobox"
    && atom.phase === "choose");
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
  if (atom.choiceMode !== "custom_combobox" || atom.phase !== "choose") return null;
  const page = observation.page || {};
  const surface = activeSurface(page);
  if (!surface) return null;
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
    actionType: "click",
    choiceMode: "custom_combobox_option",
    choiceTerms: atom.choiceTerms || [],
    hasValue: Boolean(control.selected || control.state?.selected || control.state?.checked)
  };
}

function atomicActionForAtom(plan, atom, descriptor, observation = {}) {
  const control = descriptor.control;
  const nativeSelect = descriptor.field.kind === "select"
    || control.kind === "select"
    || control.role === "listbox" && control.state?.native === true;
  const actionId = uid("act_skill");
  const openingCustomChoice = atom.choiceMode === "custom_combobox" && atom.phase === "open";
  const choosingCustomOption = atom.choiceMode === "custom_combobox" && atom.phase === "choose";
  const operation = openingCustomChoice
    ? "open"
    : choosingCustomOption
      ? "choose"
      : actionTypeForOperation(atom, descriptor, nativeSelect);
  const actionType = openingCustomChoice || choosingCustomOption
    ? "click"
    : atom.actionType || descriptor.actionType || (nativeSelect ? "select" : "type");
  const surface = activeSurface(observation.page || {});
  const capability = control.operations?.[operation] || null;
  if (!capability?.actuatorIds?.length) return null;
  const actuatorIds = capability?.actuatorIds || [];
  const actuatorIndex = Math.min(Number(atom.attempts || 0), Math.max(0, actuatorIds.length - 1));
  const operationTargetId = actuatorIds[actuatorIndex] || capability?.actuatorId || "";
  atom.operationActuatorCount = actuatorIds.length;
  const expectedOutcome = openingCustomChoice
    ? {
        type: "options_surface_appeared",
        controlId: control.controlId,
        previousSurfaceId: surface?.id || "",
        previousExpanded: Boolean(control.state?.expanded)
      }
    : choosingCustomOption && surface
      ? {
          type: "normalized_value_changed",
          controlId: atom.ownerControlId || "",
          expectedNormalizedValue: atom.expectedNormalizedValue || "",
          surfaceId: surface.id || "",
          surfaceType: surface.type || "",
          surfaceLabel: surface.label || "",
          requireSurfaceDismissed: true
        }
      : actionType === "type" || actionType === "select"
        ? {
            type: "field_value_changed",
            controlId: control.controlId,
            expectedValue: descriptor.value,
            expectedNormalizedValue: atom.expectedNormalizedValue || normalizedProfileValue(atom.semanticType, descriptor.value)
          }
        : operation === "choose"
          ? {
              type: "control_selected",
              controlId: control.controlId,
              expectedNormalizedValue: atom.expectedNormalizedValue || ""
            }
          : null;
  return normalizeAction({
    id: actionId,
    observationId: observation.observationId || "",
    observationHash: observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "",
    type: actionType,
    intent: openingCustomChoice ? "open_profile_choice" : "satisfy_field",
    operation,
    skillPlanId: plan.planId,
    skillAtomId: atom.atomId,
    controlId: control.controlId,
    decisionGroupId: control.decisionGroupId || "",
    targetId: operationTargetId || control.controlId,
    targetLabel: control.label || descriptor.label || descriptor.semanticType,
    value: actionType === "click" ? "" : descriptor.value,
    risk: "safe",
    requiresApproval: false,
    reason: openingCustomChoice
      ? `Atomic ${plan.skillType} step: open ${descriptor.semanticType}.`
      : `Atomic ${plan.skillType} step: fill ${descriptor.semanticType}.`,
    targetSnapshot: null,
    expectedOutcome
  });
}

function actionTypeForOperation(atom, descriptor, nativeSelect) {
  if (atom.choiceMode === "choice" || descriptor.choiceMode === "choice") return "choose";
  if (atom.actionType === "type" || descriptor.actionType === "type") return "type";
  if (atom.actionType === "select" || descriptor.actionType === "select" || nativeSelect) return "select";
  return "activate";
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
    const profileFields = (observation.page?.fields || []).filter((field) => PROFILE_FIELDS.has(String(field.field || "")));
    const unresolvedRequired = profileFields.filter((field) => {
      if (!field.required || field.hasValue || field.controlState?.valuePresent) return false;
      if (["title", "gender"].includes(String(field.field || ""))) {
        return !profileFields.some((peer) => peer.field === field.field && (peer.hasValue || peer.controlState?.checked || peer.controlState?.selected));
      }
      return true;
    });
    const planControlIds = new Set((plan.atoms || []).map((item) => item.ownerControlId).filter(Boolean));
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

  const action = atomicActionForAtom(plan, atom, descriptor, observation);
  if (!action) {
    plan = suspendPlan(plan, `The canonical ${atom.semanticType} control does not publish an executable ${atom.phase === "open" ? "open" : atom.actionType || "activate"} operation.`, observationId);
    return { plan, action: null, status: "ambiguous", reason: plan.suspendedReason };
  }
  atom.status = "dispatched";
  atom.attempts = Number(atom.attempts || 0) + 1;
  atom.lastActionId = action.id;
  atom.lastControlId = descriptor.control.controlId;
  atom.lastObservationId = observationId;
  plan.status = "running";
  return { plan, action, atom, status: "action" };
}

function failSkillAction(rawPlan, actionId, reason, observationId = "") {
  const plan = clonePlan(rawPlan);
  const atom = plan.atoms.find((item) => item.lastActionId === actionId && item.status === "dispatched");
  if (atom) atom.status = "blocked";
  return suspendPlan(plan, reason, observationId);
}

function prepareSkillViewportRecovery(rawPlan, actionId, observationId = "", maxRecoveries = 2) {
  const plan = clonePlan(rawPlan);
  const atom = plan.atoms.find((item) => item.lastActionId === actionId && item.status === "dispatched");
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
    action: normalizeAction({
      id: action.id,
      observationId: action.observationId,
      observationHash: action.observationHash,
      type: "ask_user",
      reason: advanced.reason || "No canonical profile-field atom can be executed from the current observation.",
      risk: "uncertain",
      requiresApproval: true
    }),
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
  prepareSkillViewportRecovery,
  profileStageReadiness,
  profileValue,
  resumeSuspendedSkillPlan,
  skillRecoveryContext,
  blockedObligationForPlan,
  exactRecoveryProof,
  recordBlockedObligationAttempt,
  reconcileBlockedObligationResult,
  scopedValidationIssues,
  validationIssueMessage,
  normalizedPhoneParts,
  dateValueForField
};
