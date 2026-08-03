"use strict";

const { resolveProfileDecision } = require("./policy-profile");

const CONTROL_TYPES = Object.freeze({
  VALUE_FIELD: "value_field",
  EXCLUSIVE_CHOICE: "exclusive_choice",
  OPTIONAL_TOGGLE: "optional_toggle",
  NAVIGATION_ACTION: "navigation_action"
});

const CONTRACT_VERSION = "canonical-decision/v1";
const COMPLETED = new Set(["satisfied", "waived", "waived_by_policy"]);

function clean(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function lower(value = "") {
  return clean(value).toLowerCase();
}

function slug(value = "") {
  return lower(value)
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function groupId(group = {}) {
  return clean(group.decisionGroupId || group.requirementId);
}

function optionPrice(option = {}) {
  const rawAmount = option.structuredPrice?.amount
    ?? option.price?.amount
    ?? option.priceAmount;
  if (rawAmount === null || rawAmount === undefined || rawAmount === "") return null;
  const amount = Number(rawAmount);
  return Number.isFinite(amount) ? amount : null;
}

function explicitlyFree(option = {}) {
  return optionPrice(option) === 0
    || /safe_decline|decline|free|\bincluded\b|no[_ -]?extra|no (?:checked|hand|cabin|hold) (?:bag|baggage)|without|none|skip|remove|opt[_ -]?out|not included/.test(
      lower(`${option.risk || ""} ${option.semantic || ""} ${option.meaning || ""} ${option.label || ""}`)
    );
}

function explicitSeatSkip(option = {}) {
  return /skip (?:seat|seating)|continue without (?:a )?seat|go without (?:a )?seat|random seating|random (?:seat )?assignment|automatic seat assignment|seat not selected|no seat selection/.test(
    lower(`${option.semantic || ""} ${option.meaning || ""} ${option.label || ""}`)
  );
}

function explicitInsuranceDecline(option = {}) {
  return /no (?:travel |trip )?(?:insurance|protection)|without (?:insurance|protection)|decline (?:insurance|protection)|skip (?:insurance|protection)|remove (?:insurance|protection)|not now|no thanks/.test(
    lower(`${option.semantic || ""} ${option.meaning || ""} ${option.label || ""}`)
  );
}

function explicitPaidRemoval(option = {}) {
  return /remove|deselect|unselect|undo|delete|clear selection|remove_paid/.test(
    lower(`${option.semantic || ""} ${option.meaning || ""} ${option.label || ""}`)
  );
}

function explicitIncludedFare(option = {}) {
  return explicitlyFree(option) && /included|base (?:fare|option)|basic(?: fare)?|saver(?: fare)?|economy light|light fare/.test(
    lower(`${option.canonicalValue || ""} ${option.semantic || ""} ${option.meaning || ""} ${option.label || ""}`)
  );
}

function baggagePreferenceKind(value = "") {
  const text = lower(value);
  if (/personal item|small personal|underseat/.test(text)) return "personal_item";
  if (/cabin|hand|carry.?on/.test(text)) return "cabin_bag";
  if (/checked|hold/.test(text)) return "checked_bag";
  return "";
}

function optionBaggageKind(option = {}) {
  return baggagePreferenceKind(`${option.canonicalValue || ""} ${option.value || ""} ${option.label || ""}`);
}

function paid(option = {}) {
  if (explicitlyFree(option)) return false;
  return Number(optionPrice(option)) > 0
    || /money|payment|paid|purchase|premium|upgrade|add_paid/.test(
      lower(`${option.risk || ""} ${option.semantic || ""} ${option.meaning || ""}`)
    );
}

function forwardMeaning(control = {}) {
  return lower([
    control.physicalEffect,
    control.mechanicalEffect,
    control.semanticEffect,
    control.semanticIntent,
    control.semanticType,
    control.semantic,
    control.meaning,
    control.interactionRole,
    control.risk
  ].filter(Boolean).join(" "));
}

function isTypedNavigationControl(control = {}, { explicitStageExit = false } = {}) {
  if (!executable(control)) return false;
  const meaning = forwardMeaning(control);
  const label = lower(control.label);
  const amount = optionPrice(control);
  if (
    paid(control)
    || (Number.isFinite(amount) && amount > 0)
    || /select_paid_option|add_paid|submit_purchase|enter_payment|accept_legal|money|payment|purchase/.test(meaning)
  ) return false;
  if (/^(?:back|previous|edit|change)(?:\s|$)/.test(label)) return false;
  if (explicitStageExit) return true;
  return /advance_surface|advance_checkout_stage|dismiss_surface|safe_continue|navigate_stage|(?:^|\s)(?:navigation|continue|next|proceed|done|finish|close|dismiss)(?:\s|$)/.test(meaning);
}

function executable(control = {}) {
  return Object.values(control.operations || {}).some((capability) => (
    capability?.actionability?.executable === true
    || capability?.actionability?.revealable === true
  ));
}

function isPlaceholderValue(value = "") {
  return /^(?:choose|select|please select|select one(?: option)?|please choose|month|day|year|title|gender|nationality|country)$/i.test(
    clean(value)
  );
}

function meaningfulControlValue(control = {}) {
  const state = control.state || {};
  const raw = clean(
    state.selectedValue
    || state.normalizedValue
    || control.canonicalValue
    || control.currentValue
    || control.value
    || state.valueText
  );
  const selectLike = /select|combobox|listbox/.test(lower(
    `${control.kind || ""} ${control.role || ""} ${control.domRole || ""}`
  ));
  if (!raw) return "";
  if (selectLike && isPlaceholderValue(raw)) return "";
  if (state.valuePresent === false && !state.checked && !state.selected) return "";
  return raw;
}

function controlsForGroup(group = {}, page = {}) {
  const ids = new Set([
    ...(group.alternativeControlIds || []),
    ...(group.semanticCorrectionControlIds || []),
    ...(group.alternatives || []).map((option) => option.controlId)
  ].filter(Boolean));
  return (page.controls || []).filter((control) => (
    ids.has(control.controlId)
    || (!ids.size && control.decisionGroupId === groupId(group))
  ));
}

function exactSubject(group = {}, controls = []) {
  const declaredSubject = lower(group.subject?.key || group.subject || group.decisionContract?.subject);
  if (declaredSubject === "fare_package") {
    return { key: "fare_package", label: clean(group.sectionLabel || group.decisionContract?.subjectLabel || "Fare package"), family: "fare" };
  }
  const ownership = group.semanticOwnership || {};
  const authoritative = ownership.status === "resolved"
    ? clean(ownership.subject || ownership.exactSubject || ownership.meaning)
    : "";
  const localLabel = clean(group.label || group.sectionLabel || group.subject || group.requirementId);
  const alternatives = clean([
    ...(group.alternatives || []).map((option) => `${option.label || ""} ${option.semantic || ""} ${option.meaning || ""}`),
    ...controls.map((control) => `${control.label || ""} ${control.semantic || ""} ${control.meaning || ""}`)
  ].join(" "));
  const evidence = lower(`${authoritative} ${localLabel} ${alternatives}`);
  const ownerEvidence = lower(`${authoritative} ${localLabel} ${ownership.family || ""}`);
  const ownedFamily = ["seat", "baggage", "insurance", "extras"].includes(lower(ownership.family))
    ? lower(ownership.family)
    : "";

  // The order is deliberate. Protection and quantity are different subjects,
  // even when their smallest local owners share a broader baggage section.
  if (/fare (?:package|option|family)|base fare|basic fare|basic (?:saver|standard|flexi)|saver fare|continue with (?:saver|standard|flexi)|economy light|light fare/.test(ownerEvidence)) {
    return { key: "fare_package", label: authoritative || localLabel || "Fare package", family: "fare" };
  }
  if (/lost (?:bag|baggage|luggage)|baggage protection|luggage protection|bag protection|baggage insurance/.test(evidence)) {
    return { key: "baggage_protection", label: authoritative || localLabel || "Baggage protection", family: "insurance" };
  }
  if (/checked (?:bag|baggage)|hold (?:bag|baggage)|\bchecked luggage\b/.test(evidence)) {
    return { key: "checked_baggage_quantity", label: authoritative || localLabel || "Checked baggage quantity", family: "baggage" };
  }
  if (/cabin (?:bag|baggage)|hand (?:bag|baggage)|carry.?on|personal item/.test(evidence)) {
    return { key: "cabin_baggage_quantity", label: authoritative || localLabel || "Cabin baggage quantity", family: "baggage" };
  }
  if (/travel insurance|trip protection|cancellation protection|cancellation insurance|cancellation (?:cover|coverage)|medical cancellation|trip cancellation|refund protection|\binsurance\b/.test(evidence)) {
    return { key: "travel_insurance", label: authoritative || localLabel || "Travel insurance", family: "insurance" };
  }
  if (/seat|seating/.test(evidence)) {
    return { key: "seat_selection", label: authoritative || localLabel || "Seat selection", family: "seat" };
  }
  if (ownedFamily === "seat") {
    return { key: "seat_selection", label: authoritative || localLabel || "Seat selection", family: "seat" };
  }
  if (/newsletter|marketing|promotional|email offers/.test(evidence)) {
    return { key: "marketing_subscription", label: authoritative || localLabel || "Marketing subscription", family: "contact" };
  }
  if (/\btitle\b|traveler_title|passenger_title/.test(evidence)) {
    return { key: "traveler_title", label: authoritative || localLabel || "Traveler title", family: "profile" };
  }
  if (/nationality|citizenship/.test(evidence)) {
    return { key: "nationality", label: authoritative || localLabel || "Nationality", family: "profile" };
  }
  if (/flexible[_ -]ticket|flexibility/.test(evidence)) {
    return { key: "flexible_ticket", label: authoritative || localLabel || "Flexible ticket", family: "extras" };
  }
  if (ownedFamily) {
    return {
      key: `${ownedFamily}_${slug(authoritative || localLabel || groupId(group)) || "decision"}`,
      label: authoritative || localLabel || `${ownedFamily} decision`,
      family: ownedFamily
    };
  }
  if (/bundle|support|sms|extra|add.?on/.test(evidence)) {
    return { key: `extras_${slug(localLabel || groupId(group))}`, label: authoritative || localLabel || "Optional extra", family: "extras" };
  }
  if (/legal|terms|consent/.test(evidence)) {
    return { key: `legal_${slug(localLabel || groupId(group))}`, label: authoritative || localLabel || "Legal acceptance", family: "legal" };
  }
  if (/payment|card|pay/.test(evidence)) {
    return { key: `payment_${slug(localLabel || groupId(group))}`, label: authoritative || localLabel || "Payment", family: "payment" };
  }
  return {
    key: `decision_${slug(authoritative || localLabel || groupId(group)) || "unknown"}`,
    label: authoritative || localLabel || "Unknown decision",
    family: "decision"
  };
}

function controlTypeFor(group = {}, controls = []) {
  const shape = lower([
    ...controls.map((control) => `${control.kind || ""} ${control.role || ""} ${control.domRole || ""} ${control.inputType || ""}`),
    ...(group.alternatives || []).map((option) => `${option.kind || ""} ${option.role || ""}`)
  ].join(" "));
  if (group.required !== true && controls.length === 1 && /checkbox|switch|toggle/.test(shape)) {
    return CONTROL_TYPES.OPTIONAL_TOGGLE;
  }
  return CONTROL_TYPES.EXCLUSIVE_CHOICE;
}

function parseRequestedCount(value = "") {
  const text = lower(value);
  const word = text.match(/\b(one|two|three|four)\b/)?.[1];
  if (word) return { one: 1, two: 2, three: 3, four: 4 }[word];
  const numeric = text.match(/\b(\d+)\s*(?:checked|hold|cabin|hand|carry.?on)?\s*(?:bag|baggage|luggage)/)?.[1];
  return numeric === undefined ? null : Number(numeric);
}

function optionCount(option = {}) {
  const text = lower(`${option.canonicalValue || ""} ${option.value || ""} ${option.label || ""}`);
  if (/no checked|without checked|zero checked|0\s*(?:checked )?bag/.test(text)) return 0;
  return parseRequestedCount(text);
}

function exactUserIntent(subject = {}, group = {}, transitions = [], userPolicy = {}, traveler = {}) {
  const alternativesById = new Map((group.alternatives || []).map((option) => [option.controlId, option]));
  const resolution = resolveProfileDecision({
    decisionGroupId: groupId(group),
    subject,
    required: group.required === true,
    material: group.material === true,
    kind: group.kind || group.decisionContract?.kind,
    controlType: group.controlType,
    options: transitions.map((transition) => {
      const alternative = alternativesById.get(transition.controlId) || {};
      return {
        ...transition,
        optionId: alternative.optionId || transition.controlId,
        priceDelta: transition.price?.amount,
        currency: transition.price?.currency || "",
        included: alternative.included === true || explicitlyFree(transition),
        canonicalAttributes: alternative.canonicalAttributes || {}
      };
    })
  }, { userPolicy, traveler });
  const desiredControlIds = resolution.preferredControlId
    ? [resolution.preferredControlId]
    : [];
  const desiredOutcome = subject.key === "fare_package" && resolution.match === "constraint"
    ? "included_base_fare"
    : ["travel_insurance", "baggage_protection"].includes(subject.key) && resolution.match === "constraint"
      ? "no_insurance"
      : subject.key === "seat_selection" && resolution.match === "constraint"
        ? "random_assignment"
        : desiredControlIds.length
          ? "selected"
          : resolution.match === "constraint"
            ? "declined_or_free"
            : "";
  return {
    match: resolution.match,
    source: resolution.source,
    desiredOutcome,
    desiredCanonicalValue: resolution.preferredOptionId || null,
    desiredControlIds,
    eligibleOptionIds: resolution.eligibleOptionIds,
    preferredOptionId: resolution.preferredOptionId,
    authorization: resolution.authorization,
    reason: resolution.reason,
    evidence: resolution.evidence
  };
}

function transitionFor(control = {}, alternative = {}) {
  const operation = Object.entries(control.operations || {}).find(([, capability]) => (
    capability?.actionability?.executable === true || capability?.actionability?.revealable === true
  ))?.[0] || "";
  const price = control.structuredPrice || alternative.structuredPrice || (
    optionPrice(control) !== null ? { amount: optionPrice(control), currency: clean(control.currency) } : null
  );
  const merged = { ...alternative, ...control, structuredPrice: price };
  return Object.freeze({
    transitionId: `${clean(control.controlId || alternative.controlId)}:${operation || "unavailable"}`,
    controlId: clean(control.controlId || alternative.controlId),
    targetId: clean(control.preferredActivationElementId || control.stateElementId || alternative.targetId),
    operation,
    label: clean(alternative.label || control.label),
    canonicalValue: alternative.canonicalValue ?? control.canonicalValue ?? alternative.value ?? control.currentValue ?? clean(alternative.label || control.label),
    selected: Boolean(control.selected || control.state?.checked || control.state?.selected || alternative.selected),
    executable: executable(control),
    paid: paid(merged),
    price,
    risk: clean(control.risk || alternative.risk || "unknown"),
    semantic: clean(control.semantic || alternative.semantic)
  });
}

function selectedControl(group = {}, controls = []) {
  const selectedId = clean(group.selectedControlId);
  return controls.find((control) => control.controlId === selectedId)
    || controls.find((control) => control.selected || control.state?.checked || control.state?.selected)
    || null;
}

function selectedOutcome(selected = null, transitions = [], controlType = "") {
  if (!selected) {
    const affirmativePaidToggle = controlType === CONTROL_TYPES.OPTIONAL_TOGGLE
      && transitions.some((transition) => transition.paid);
    return affirmativePaidToggle ? "declined" : "unknown";
  }
  const transition = transitions.find((item) => item.controlId === selected.controlId);
  if (transition?.paid) return "paid_affirmative";
  if (transition && explicitlyFree(transition)) return "declined";
  return "selected";
}

function terminalEpisodeCommitment(episode = {}) {
  return ["committed", "committed_free", "committed_paid", "declined_free"].includes(
    clean(episode.commitmentPhase).toLowerCase()
  ) || episode.status === "completed" && Boolean(episode.terminalOutcome);
}

function episodeOwnsDecision(episode = {}, decisionGroupId = "", subject = {}) {
  if (!episode || typeof episode !== "object") return false;
  if (clean(episode.parentDecisionGroupId) === clean(decisionGroupId)) return true;
  const owner = clean(episode.canonicalOwnerId || episode.decisionInstanceId);
  const decisionOwner = clean(subject.canonicalOwnerId || subject.decisionInstanceId);
  return Boolean(owner && decisionOwner && owner === decisionOwner);
}

function deferredChoiceCommitment({
  group = {},
  page = {},
  subject = {},
  selected = null,
  selectedTransition = null,
  decisionEpisode = null
} = {}) {
  const surface = page.currentSurface || {};
  if (!selected || !selectedTransition?.paid || !surface.type || surface.type === "page") return false;
  const sourceSurfaceId = clean(selected.surfaceId || group.surfaceId || "surface-page");
  if (sourceSurfaceId === clean(surface.id)) return false;

  const ownedEpisode = episodeOwnsDecision(decisionEpisode, groupId(group), subject);
  if (ownedEpisode && terminalEpisodeCommitment(decisionEpisode)) {
    return clean(decisionEpisode.terminalOutcome?.disposition).toLowerCase() !== "paid";
  }

  const surfaceEvidence = lower([
    surface.taskHint,
    surface.parentSectionType,
    surface.parentSectionLabel,
    surface.label,
    surface.foreground?.progressMarkers?.selectedText,
    surface.expectedResolution
  ].filter(Boolean).join(" "));
  const sameSubject = subject.family === "seat"
    ? /seat|seating/.test(surfaceEvidence)
    : subject.family === "baggage"
      ? /bag|baggage|luggage/.test(surfaceEvidence)
      : subject.family === "insurance"
        ? /insurance|protection|cover/.test(surfaceEvidence)
        : subject.family === "extras"
          ? /extra|bundle|meal|priority|support|subscription/.test(surfaceEvidence)
          : false;
  if (!sameSubject) return false;

  const exactParentSection = clean(surface.parentSectionId)
    && clean(group.sectionId) === clean(surface.parentSectionId);
  const matchingSelectedParents = (page.decisionGroups || []).filter((candidateGroup) => {
    const candidateControls = controlsForGroup(candidateGroup, page);
    const candidateSubject = exactSubject(candidateGroup, candidateControls);
    if (candidateSubject.family !== subject.family) return false;
    const candidateSelected = selectedControl(candidateGroup, candidateControls);
    if (!candidateSelected) return false;
    const candidateAlternative = (candidateGroup.alternatives || []).find((option) => (
      option.controlId === candidateSelected.controlId
    )) || {};
    return paid({ ...candidateAlternative, ...candidateSelected });
  });
  const uniquePendingParent = matchingSelectedParents.length === 1
    && groupId(matchingSelectedParents[0]) === groupId(group);
  if (!exactParentSection && !uniquePendingParent) return false;

  // A selected background opener is presentation state while its exact child
  // decision remains foreground-owned. Wording may identify the subject, but
  // it cannot commit a purchase. Only a verified terminal episode can do so.
  return ownedEpisode || exactParentSection || uniquePendingParent;
}

function canonicalDecisionForGroup({
  group = {},
  page = {},
  previousCompletion = null,
  userPolicy = {},
  traveler = {},
  decisionEpisode = null
} = {}) {
  const id = groupId(group);
  const controls = controlsForGroup(group, page);
  const alternativesById = new Map((group.alternatives || []).map((option) => [option.controlId, option]));
  const transitions = controls.map((control) => transitionFor(control, alternativesById.get(control.controlId) || {}));
  for (const alternative of group.alternatives || []) {
    if (!alternative.controlId || transitions.some((item) => item.controlId === alternative.controlId)) continue;
    transitions.push(transitionFor({}, alternative));
  }
  const subject = exactSubject(group, controls);
  const controlType = controlTypeFor(group, controls);
  const selected = selectedControl(group, controls);
  const selectedId = clean(selected?.controlId || group.selectedControlId);
  const selectedTransition = transitions.find((item) => item.controlId === selectedId) || null;
  const transactionSelection = (page.transactionFacts?.selectedExtras || []).find((item) => (
    clean(item?.decisionGroupId) === id
  )) || null;
  const selectedEvidence = group.selectedEvidence || null;
  const evidencePaid = Boolean(
    (transactionSelection && (
      Number(transactionSelection.priceAmount) > 0
      || /paid|money|selected_paid/.test(lower(transactionSelection.disposition))
    ))
    || (selectedEvidence?.selected === true && (
      selectedEvidence.disposition === "paid"
      || Number(selectedEvidence.structuredPrice?.amount) > 0
      || /paid|money|purchase/.test(lower(`${selectedEvidence.risk || ""} ${selectedEvidence.semantic || ""}`))
    ))
  );
  let intent = exactUserIntent(subject, group, transitions, userPolicy, traveler);
  const discoveryControlIds = new Set(controls.filter((control) => (
    executable(control)
    && (
      Object.keys(control.operations || {}).includes("open")
      || /open_choice_control|open_surface/.test(lower(`${control.semantic || ""} ${control.physicalEffect || ""}`))
      || /combobox|listbox/.test(lower(`${control.kind || ""} ${control.role || ""} ${control.domRole || ""}`))
      || control.hasPopup === true
      || Boolean(control.ariaHasPopup)
    )
  )).map((control) => control.controlId));
  const discoveryTransitions = transitions.filter((transition) => discoveryControlIds.has(transition.controlId));
  if (["ambiguous", "unavailable"].includes(intent.match) && discoveryTransitions.length === 1) {
    intent = {
      ...intent,
      desiredControlIds: [...new Set([...intent.desiredControlIds, discoveryTransitions[0].controlId])],
      eligibleOptionIds: [...new Set([...intent.eligibleOptionIds, discoveryTransitions[0].controlId])],
      reason: `${intent.reason || "The exact choice is not yet visible."} Open the owned choice control to observe its bounded alternatives.`
    };
  }
  if (evidencePaid && intent.match === "constraint") {
    intent = {
      ...intent,
      desiredControlIds: [...new Set([
        ...intent.desiredControlIds,
        ...transitions.filter((item) => item.executable && explicitPaidRemoval(item)).map((item) => item.controlId)
      ])]
    };
  }
  const optionPending = deferredChoiceCommitment({
    group,
    page,
    subject,
    selected,
    selectedTransition,
    decisionEpisode
  });
  const currentOutcome = optionPending
    ? "option_pending"
    : evidencePaid && !explicitlyFree(selectedTransition || {}) && intent.match !== "exact"
    ? "paid_affirmative"
    : selectedOutcome(selected, transitions, controlType);
  const commitmentPhase = optionPending
    ? "option_pending"
    : currentOutcome === "paid_affirmative"
      ? "committed_paid"
      : selected && explicitlyFree(selectedTransition || {})
        ? "declined_free"
        : selected
          ? "committed"
          : "unresolved";
  const required = group.required === true;
  const validation = (page.validationIssues || []).find((issue) => (
    issue.stageWide === true
    || [id, group.requirementId, group.sectionId, selectedId].filter(Boolean).includes(
      clean(issue.decisionGroupId || issue.requirementId || issue.sectionId || issue.controlId)
    )
  )) || null;
  const selectionChanged = Boolean(
    previousCompletion?.selectedControlId
    && selectedId
    && clean(previousCompletion.selectedControlId) !== selectedId
  );
  const desiredSelected = intent.desiredControlIds.includes(selectedId)
    || (intent.desiredCanonicalValue !== null
      && selectedTransition
      && optionCount(selectedTransition) === intent.desiredCanonicalValue);
  const policyCompatibleSelected = desiredSelected || Boolean(
    selectedId
    && intent.match === "constraint"
    && intent.eligibleOptionIds.includes(selectedId)
  );
  const paidAuthorization = intent.authorization || (userPolicy.paidExtraAuthorizations || []).find((authorization) => (
    authorization?.authorizationId && authorization.decisionGroupId === id
  )) || null;
  const paidConflict = currentOutcome === "paid_affirmative" && (
    intent.match === "constraint"
    || intent.match === "ambiguous"
    || (!paidAuthorization && intent.match !== "exact")
    || group.semanticOwnership?.policyCompatibility === "conflict"
  );
  const paidOnlyWithSafeForward = !selected
    && intent.match === "constraint"
    && intent.desiredControlIds.length === 0
    && transitions.some((transition) => transition.executable)
    && transitions.filter((transition) => transition.executable).every((transition) => transition.paid)
    && (page.controls || []).some((control) => {
      const explicitStageExitIds = new Set([
        page.stageExit?.continueControlId,
        page.stageExit?.continueTargetId
      ].map(clean).filter(Boolean));
      const explicitStageExit = [
        control.controlId,
        control.stateElementId,
        control.preferredActivationElementId
      ].map(clean).some((id) => explicitStageExitIds.has(id));
      return clean(control.surfaceId || "surface-page") === clean(group.surfaceId || "surface-page")
        && isTypedNavigationControl(control, { explicitStageExit });
    });
  const exactProfileTransitionAvailable = intent.desiredControlIds.some((controlId) => (
    transitions.some((transition) => transition.controlId === controlId && transition.executable)
  ));
  const constraintNeedsResolution = !selected
    && intent.match === "constraint"
    && (intent.desiredControlIds.length > 0 || intent.eligibleOptionIds.length > 0)
    && (
      required
      || (controlType === CONTROL_TYPES.EXCLUSIVE_CHOICE && exactProfileTransitionAvailable)
      || clean(group.surfaceType || "page") !== "page"
      || page.stageExit?.continueDisabled === true
      || (
        clean(group.surfaceId || "surface-page") !== "surface-page"
        && clean(page.currentSurface?.id) === clean(group.surfaceId)
      )
    );

  let status = "stale";
  let needsAction = false;
  let actionReason = "optional_untouched_unknown";
  let completionReason = "";
  let reopenEvidence = null;

  if (validation) {
    status = "blocked";
    needsAction = true;
    actionReason = "fresh_validation";
    reopenEvidence = { code: "FRESH_VALIDATION_REQUIRES_DECISION", issue: validation };
  } else if (optionPending) {
    // The child surface owns the unresolved choice. Keeping the parent out of
    // the goal queue prevents a disabled/open-intent radio from competing
    // with the exact Skip/No-thanks actuator in the foreground.
    status = "pending";
    needsAction = false;
    actionReason = "owned_child_choice_pending";
  } else if (paidConflict) {
    status = paidAuthorization ? "blocked" : "conflicted";
    needsAction = true;
    actionReason = "selected_paid_option_conflicts_with_policy";
    reopenEvidence = {
      code: paidAuthorization
        ? "PAID_SELECTION_POLICY_AUTHORIZATION_CONFLICT"
        : (Number(selectedTransition?.price?.amount ?? selectedEvidence?.structuredPrice?.amount ?? transactionSelection?.priceAmount) > 0
          ? "EXACT_SELECTED_OPTION_PRICE_EXCEEDS_POLICY"
          : "EXACT_SELECTED_OPTION_CONTRADICTS_POLICY"),
      decisionGroupId: id,
      controlId: selectedId,
      structuredPrice: selectedTransition?.price
        || selectedEvidence?.structuredPrice
        || (transactionSelection ? { amount: Number(transactionSelection.priceAmount), currency: clean(transactionSelection.currency) } : null),
      semantic: selectedTransition?.semantic || "",
      risk: selectedTransition?.risk || "",
      ...(paidAuthorization ? { authorizationId: clean(paidAuthorization.authorizationId) } : {})
    };
  } else if (["ambiguous", "unavailable"].includes(intent.match) && !selected && !previousCompletion) {
    const canDiscoverOptions = discoveryTransitions.length === 1
      && intent.desiredControlIds.includes(discoveryTransitions[0].controlId);
    status = canDiscoverOptions ? "active" : "blocked";
    needsAction = true;
    actionReason = canDiscoverOptions
      ? "open_owned_choice_to_observe_options"
      : intent.match === "unavailable"
        ? "profile_constraint_unavailable"
        : "profile_authority_required";
    reopenEvidence = {
      code: canDiscoverOptions
        ? "PROFILE_DECISION_OPTIONS_NOT_YET_OBSERVED"
        : intent.match === "unavailable"
        ? "PROFILE_CONSTRAINT_UNAVAILABLE"
        : "PROFILE_DECISION_AMBIGUOUS",
      decisionGroupId: id,
      reason: intent.reason || "No applicable profile rule resolves this consequential decision."
    };
  } else if (selected && (
    policyCompatibleSelected
    || (intent.match === "ambiguous" && currentOutcome !== "paid_affirmative")
    || (intent.match === "none" && !selectionChanged)
  )) {
    status = "satisfied";
    actionReason = policyCompatibleSelected ? "exact_user_intent_already_matches" : "observed_selection_satisfies_decision";
    completionReason = policyCompatibleSelected ? "exact_user_intent_match" : "exact_browser_selection";
  } else if (selectionChanged) {
    status = required ? "active" : "stale";
    needsAction = required;
    actionReason = "selected_control_changed";
    reopenEvidence = {
      code: "EXACT_SELECTED_CONTROL_CHANGED",
      decisionGroupId: id,
      previousControlId: clean(previousCompletion.selectedControlId),
      selectedControlId: selectedId
    };
  } else if (controlType === CONTROL_TYPES.OPTIONAL_TOGGLE && currentOutcome === "declined" && intent.match === "constraint") {
    status = "satisfied";
    actionReason = "optional_paid_affirmative_already_declined";
    completionReason = "policy_constraint_already_satisfied";
  } else if (paidOnlyWithSafeForward) {
    status = "waived";
    actionReason = "constraint_does_not_require_paid_selection";
    completionReason = "policy_constraint_satisfied_without_selection";
  } else if (constraintNeedsResolution) {
    status = "active";
    needsAction = true;
    actionReason = "blocking_surface_has_exact_safe_transition";
  } else if (previousCompletion) {
    status = previousCompletion.status;
    completionReason = "preserved_exact_outcome";
    actionReason = "preserved_verified_completion";
  } else if (required && !selected) {
    status = "active";
    needsAction = true;
    actionReason = "required_unresolved";
  } else if (intent.match === "exact" && !desiredSelected) {
    status = "active";
    needsAction = true;
    actionReason = "exact_user_intent_requires_transition";
  } else if (COMPLETED.has(lower(group.status))) {
    status = lower(group.status) === "satisfied" ? "satisfied" : "waived";
    completionReason = "fresh_browser_status";
    actionReason = "fresh_observed_completion";
  } else if (intent.match === "constraint" && !selected && intent.desiredControlIds.length === 0) {
    status = "waived";
    completionReason = "policy_constraint_satisfied_without_selection";
    actionReason = "constraint_does_not_require_affirmative_action";
  }

  return Object.freeze({
    contractVersion: CONTRACT_VERSION,
    decisionId: id,
    decisionGroupId: id,
    requirementId: clean(group.requirementId || id),
    subject: Object.freeze(subject),
    family: subject.family,
    controlType,
    physicalControlIds: Object.freeze(controls.map((control) => control.controlId).filter(Boolean)),
    stateControlIds: Object.freeze(controls.map((control) => control.stateElementId || control.controlId).filter(Boolean)),
    currentState: Object.freeze({
      selectedControlId: selectedId,
      selectedLabel: clean(selectedTransition?.label || group.selectedLabel),
      canonicalValue: selectedTransition?.canonicalValue ?? null,
      selected: Boolean(selected),
      checked: Boolean(selected?.state?.checked),
      empty: !selected
    }),
    required,
    optional: !required,
    currentOutcome,
    commitmentPhase,
    availableTransitions: Object.freeze(transitions),
    priceRisk: Object.freeze({
      selectedPaid: Boolean(commitmentPhase === "committed_paid"),
      observedPaidIntent: Boolean(evidencePaid && !explicitlyFree(selectedTransition || {})),
      amount: selectedTransition?.price?.amount
        ?? selectedEvidence?.structuredPrice?.amount
        ?? transactionSelection?.priceAmount
        ?? null,
      currency: clean(
        selectedTransition?.price?.currency
        || selectedEvidence?.structuredPrice?.currency
        || transactionSelection?.currency
      ),
      risk: selectedTransition?.risk || "unknown"
    }),
    userIntent: Object.freeze(intent),
    profileResolution: Object.freeze(intent),
    needsAction,
    actionReason,
    status,
    completionReason,
    reopenEvidence,
    surfaceId: clean(group.surfaceId || "surface-page"),
    surfaceType: clean(group.surfaceType || "page"),
    selectedControlId: selectedId,
    selectedLabel: clean(selectedTransition?.label || group.selectedLabel),
    observed: group
  });
}

function standaloneControlDecision(control = {}, ownedControlIds = new Set()) {
  if (!control.controlId || ownedControlIds.has(control.controlId)) return null;
  const shape = lower(`${control.kind || ""} ${control.role || ""} ${control.domRole || ""} ${control.inputType || ""}`);
  const semantic = lower(`${control.fieldType || ""} ${control.field || ""} ${control.semantic || ""} ${control.meaning || ""}`);
  if (/continue|next|proceed|advance|done|finish|navigation/.test(semantic)) {
    return Object.freeze({
      contractVersion: CONTRACT_VERSION,
      decisionId: `control:${control.controlId}`,
      subject: Object.freeze({ key: "checkout_navigation", label: clean(control.label || "Continue"), family: "navigation" }),
      controlType: CONTROL_TYPES.NAVIGATION_ACTION,
      physicalControlIds: Object.freeze([control.controlId]),
      stateControlIds: Object.freeze([control.stateElementId || control.controlId]),
      currentState: Object.freeze({ available: executable(control) }),
      required: false,
      optional: true,
      currentOutcome: "available",
      availableTransitions: Object.freeze([transitionFor(control)]),
      priceRisk: Object.freeze({ selectedPaid: false, amount: null, currency: "", risk: control.risk || "safe" }),
      userIntent: Object.freeze({ match: "none", source: "", desiredOutcome: "", desiredCanonicalValue: null, desiredControlIds: [] }),
      needsAction: false,
      actionReason: "navigation_is_scheduled_after_requirements",
      status: "stale",
      surfaceId: clean(control.surfaceId || "surface-page"),
      observed: control
    });
  }
  if (/field|textbox|input|combobox|select/.test(shape) || control.fieldType || control.field) {
    const value = meaningfulControlValue(control);
    const required = control.required === true || control.state?.required === true;
    return Object.freeze({
      contractVersion: CONTRACT_VERSION,
      decisionId: `control:${control.controlId}`,
      subject: Object.freeze({
        key: slug(control.fieldType || control.field || control.semantic || control.controlId),
        label: clean(control.label || control.fieldType || control.field || "Value field"),
        family: "profile"
      }),
      controlType: CONTROL_TYPES.VALUE_FIELD,
      physicalControlIds: Object.freeze([control.controlId]),
      stateControlIds: Object.freeze([control.stateElementId || control.controlId]),
      currentState: Object.freeze({ canonicalValue: value || null, empty: !value }),
      required,
      optional: !required,
      currentOutcome: value ? "value_set" : "unresolved",
      availableTransitions: Object.freeze(executable(control) ? [transitionFor(control)] : []),
      priceRisk: Object.freeze({ selectedPaid: false, amount: null, currency: "", risk: control.risk || "safe" }),
      userIntent: Object.freeze({ match: "delegated_profile_requirement", source: "logical_field_adapter", desiredOutcome: "canonical_value", desiredCanonicalValue: null, desiredControlIds: [] }),
      needsAction: Boolean(required && !value),
      actionReason: value ? "value_present" : "logical_field_adapter_owns_desired_value",
      status: value ? "satisfied" : (required ? "active" : "stale"),
      surfaceId: clean(control.surfaceId || "surface-page"),
      observed: control
    });
  }
  return null;
}

function buildCanonicalDecisions({
  page = {},
  previousCompletions = new Map(),
  userPolicy = {},
  traveler = {},
  decisionEpisode = null
} = {}) {
  const grouped = (page.decisionGroups || []).filter((group) => groupId(group)).map((group) => (
    canonicalDecisionForGroup({
      group,
      page,
      previousCompletion: previousCompletions.get(groupId(group)) || null,
      userPolicy,
      traveler,
      decisionEpisode
    })
  ));
  const ownedControlIds = new Set(grouped.flatMap((decision) => decision.physicalControlIds));
  const standalone = (page.controls || [])
    .map((control) => standaloneControlDecision(control, ownedControlIds))
    .filter(Boolean);
  return Object.freeze([...grouped, ...standalone]);
}

module.exports = {
  CONTRACT_VERSION,
  CONTROL_TYPES,
  buildCanonicalDecisions,
  canonicalDecisionForGroup,
  exactSubject,
  exactUserIntent,
  isTypedNavigationControl,
  meaningfulControlValue
};
