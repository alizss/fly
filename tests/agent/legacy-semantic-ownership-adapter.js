const { callStructured } = require("../../apps/web/agent/openai-client");
const { currentSurface, controlBelongsToCurrentSurface } = require("../../apps/web/agent/surface-contract");
const { seatPolicyFrom } = require("../../apps/web/agent/policy-profile");
const { currentObligation } = require("../../apps/web/agent/authority-frames");
const { legacyGoalFromObligation } = require("./legacy-obligation-goal-adapter");

const OWNERSHIP_FAMILIES = ["seat", "baggage", "bundle", "insurance", "extras", "unknown"];
const OWNERSHIP_REQUIREMENTS = ["required", "optional", "unknown"];
const PRICE_DISPOSITIONS = ["paid", "free", "unknown"];
const POLICY_COMPATIBILITY = ["conflict", "compatible", "unknown"];
const INTENDED_OUTCOMES = [
  "remove_paid_selection",
  "select_free_alternative",
  "deselect_paid_selection",
  "open_correction_surface",
  "unknown"
];
const MAX_RELATED_MODEL_CONTROLS = 20;
const OWNERSHIP_MODEL_PACKET_BYTES = 24_000;

function clean(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function transactionSelectionForGroup(group = {}, page = {}) {
  const decisionGroupId = clean(group.decisionGroupId || group.requirementId);
  return (page.transactionFacts?.selectedExtras || []).find((extra) => (
    clean(extra?.decisionGroupId) === decisionGroupId
    && (
      Number(extra?.priceAmount) > 0
      || (
        /paid|money|selected_paid/.test(clean(extra?.disposition).toLowerCase())
        && !/decline|free|remove|skip|without|none|not selected|no extra/.test(clean(extra?.disposition).toLowerCase())
      )
    )
  )) || null;
}

function isPaidSelection(group = {}, page = {}) {
  const evidence = group.selectedEvidence || {};
  const transactionSelection = transactionSelectionForGroup(group, page);
  const amount = Number(evidence.structuredPrice?.amount ?? transactionSelection?.priceAmount);
  const disposition = clean(evidence.disposition || transactionSelection?.disposition).toLowerCase();
  const strongPaidMeaning = /selected_paid|add_paid|paid|money|purchase/.test(clean([
    group.selectedSemantic,
    evidence.semantic,
    evidence.risk,
    disposition
  ].join(" ")).toLowerCase());
  const selectedTruth = evidence.selected === true
    || Boolean(transactionSelection)
    || Boolean(group.selectedLabel && group.selectedSemantic === "selected_paid_item");
  return selectedTruth
    && disposition !== "free"
    && (disposition === "paid" || (Number.isFinite(amount) && amount > 0) || strongPaidMeaning);
}

function ownedControlIds(group = {}, page = {}) {
  const ids = new Set([
    group.removalControlId,
    ...(group.alternativeControlIds || []),
    ...(group.alternatives || []).map((alternative) => alternative.controlId)
  ].map(clean).filter(Boolean));
  return (page.controls || [])
    .filter((control) => ids.has(clean(control.controlId)) && controlBelongsToCurrentSurface(control, page))
    .map((control) => clean(control.controlId));
}

function controlHasExecutableCapability(control = {}) {
  return Object.values(control.operations || {}).some((capability) => (
    capability?.actionability?.executable === true
    || capability?.actionability?.revealable === true
  ));
}

function controlIsForbiddenCorrectionCandidate(control = {}) {
  const meaning = clean([
    control.semantic,
    control.physicalEffect,
    control.risk,
    control.interactionRole,
    control.semanticEffect
  ].filter(Boolean).join(" ")).toLowerCase();
  const amount = Number(control.structuredPrice?.amount ?? control.priceAmount);
  return control.selected === true
    || control.state?.selected === true
    || control.state?.checked === true
    || (Number.isFinite(amount) && amount > 0)
    || /advance_checkout_stage/.test(meaning)
    || /select_paid_option|add_paid|money|payment|purchase|submit_purchase|accept_legal|legal/.test(meaning);
}

function currentSurfaceCorrectionControlIds(page = {}) {
  return (page.controls || [])
    .filter((control) => (
      controlBelongsToCurrentSurface(control, page)
      && controlHasExecutableCapability(control)
      && !controlIsForbiddenCorrectionCandidate(control)
    ))
    .map((control) => clean(control.controlId))
    .filter(Boolean);
}

function resolutionControlIdsForGroup(group = {}, page = {}) {
  const owned = ownedControlIds(group, page).filter((controlId) => {
    const control = (page.controls || []).find((item) => clean(item.controlId) === controlId);
    return control && controlHasExecutableCapability(control) && !controlIsForbiddenCorrectionCandidate(control);
  });
  return owned.length ? owned : currentSurfaceCorrectionControlIds(page);
}

function policyRejectsEveryPaidOptional(userPolicy = {}, traveler = {}) {
  const policyText = clean([
    userPolicy.bookingRules,
    userPolicy.extras,
    traveler.booking_rules
  ].filter(Boolean).join(" ")).toLowerCase();
  return /(?:decline|skip|remove|without|no)\s+(?:all\s+)?paid\s+(?:optional\s+)?(?:extras?|add[ -]?ons?|items?|products?)/.test(policyText)
    || /(?:nothing|no)\s+extra/.test(policyText);
}

function hasExactSafeAlternative(group = {}, page = {}, userPolicy = {}, traveler = {}) {
  const selectedControlId = clean(group.selectedControlId || group.selectedEvidence?.selectedControlId);
  const removalControlId = clean(group.removalControlId);
  const textSummaryOwnership = !selectedControlId
    && Boolean(removalControlId && clean(group.selectedEvidence?.ownerElementId));
  if (!selectedControlId && !textSummaryOwnership) return false;
  const ownedIds = new Set(ownedControlIds(group, page));
  const safeOwnedReversals = (page.controls || []).filter((control) => (
    (selectedControlId || clean(control.controlId) === removalControlId)
    && ownedIds.has(clean(control.controlId))
    && (!selectedControlId || clean(control.controlId) !== selectedControlId)
    && controlHasExecutableCapability(control)
    && !controlIsForbiddenCorrectionCandidate(control)
    && /remove|decline|free|skip|without|none|deselect|clear|safe_decline|select_free/.test(
      clean(`${control.semantic || ""} ${control.physicalEffect || ""} ${control.risk || ""}`).toLowerCase()
    )
  ));
  // A paid selection can be rendered as summary text with no actionable
  // selected control. One structurally owned safe reversal is still exact.
  // Unknown item families still need interpretation unless the user's policy
  // rejects every paid optional item regardless of family.
  const observedFamily = clean(group.semanticOwnership?.family || group.sectionType).toLowerCase();
  const ownershipKnown = group.semanticOwnership?.status === "hypothesis"
    || (observedFamily && observedFamily !== "unknown" && observedFamily !== "passenger" && observedFamily !== "payment");
  return safeOwnedReversals.length === 1
    && (ownershipKnown || policyRejectsEveryPaidOptional(userPolicy, traveler));
}

function ambiguousPaidSelections(observation = {}, userPolicy = {}, traveler = {}) {
  const page = observation.page || {};
  return (page.decisionGroups || []).filter((group) => (
    clean(group.decisionGroupId || group.requirementId)
    && (
      group.semanticOwnership?.status === "unknown"
      || group.semanticOwnership?.status === "unresolved"
      || (!group.semanticOwnership
        && !/seat|bag|luggage|bundle|flexible|insurance|protection|extra|add.?on/.test(
          clean(`${group.sectionType || ""} ${group.requirementId || ""}`).toLowerCase()
        ))
      || ownedControlIds(group, page).length === 0
    )
    && isPaidSelection(group, page)
    && !hasExactSafeAlternative(group, page, userPolicy, traveler)
    && resolutionControlIdsForGroup(group, page).length > 0
  ));
}

function ownershipResolutionSchemaFor(groups = [], page = {}) {
  const decisionGroupIds = groups.map((group) => clean(group.decisionGroupId || group.requirementId)).filter(Boolean);
  const controlIds = [...new Set(groups.flatMap((group) => resolutionControlIdsForGroup(group, page)))]
    .slice(0, MAX_RELATED_MODEL_CONTROLS);
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "decisionGroupId",
      "controlId",
      "family",
      "requirement",
      "priceDisposition",
      "policyCompatibility",
      "intendedOutcome",
      "confidence",
      "rationale"
    ],
    properties: {
      decisionGroupId: { type: "string", enum: decisionGroupIds },
      controlId: { type: "string", enum: controlIds },
      family: { type: "string", enum: OWNERSHIP_FAMILIES },
      requirement: { type: "string", enum: OWNERSHIP_REQUIREMENTS },
      priceDisposition: { type: "string", enum: PRICE_DISPOSITIONS },
      policyCompatibility: { type: "string", enum: POLICY_COMPATIBILITY },
      intendedOutcome: { type: "string", enum: INTENDED_OUTCOMES },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
      rationale: { type: "string" }
    }
  };
}

function compactOwnershipControl(control = {}) {
  const state = control.state || control.controlState || {};
  return {
    controlId: clean(control.controlId),
    decisionGroupId: clean(control.decisionGroupId),
    label: clean(control.label || control.accessibleName || control.ownText),
    ownText: clean(control.ownText),
    ariaLabel: clean(control.ariaLabel),
    title: clean(control.title),
    testId: clean(control.testId),
    semantic: clean(control.semantic),
    physicalEffect: clean(control.physicalEffect || "unknown"),
    effectRole: clean(control.effectRole || "unknown"),
    risk: clean(control.risk || "uncertain"),
    selected: Boolean(control.selected || state.selected || state.checked),
    currentValue: clean(control.currentValue || state.valueText || state.normalizedValue),
    disabled: Boolean(control.disabled || state.disabled),
    structuredPrice: control.structuredPrice || null,
    sectionId: clean(control.sectionId),
    sectionType: clean(control.sectionType || "unknown"),
    sectionLabel: clean(control.sectionLabel),
    surfaceId: clean(control.surfaceId || "surface-page")
  };
}

function semanticOwnershipPayload(observation = {}, groups = [], userPolicy = {}, traveler = {}, taskState = {}) {
  const page = observation.page || {};
  const surface = currentSurface(page);
  const prioritizedControlIds = new Set(groups.flatMap((group) => resolutionControlIdsForGroup(group, page)));
  const surfaceControls = (page.controls || []).filter((control) => controlBelongsToCurrentSurface(control, page));
  const controls = [
    ...surfaceControls.filter((control) => prioritizedControlIds.has(clean(control.controlId))),
    ...surfaceControls.filter((control) => !prioritizedControlIds.has(clean(control.controlId)))
  ].filter((control, index, list) => (
    list.findIndex((item) => clean(item.controlId) === clean(control.controlId)) === index
  )).slice(0, MAX_RELATED_MODEL_CONTROLS).map(compactOwnershipControl);
  const groupIds = new Set(groups.map((group) => clean(group.decisionGroupId || group.requirementId)));
  const relatedSectionIds = new Set(controls.map((control) => clean(control.sectionId)).filter(Boolean));
  const bindingGoal = legacyGoalFromObligation(currentObligation(taskState));
  const compactGoal = bindingGoal ? {
    goalId: clean(bindingGoal.goalId),
    semanticType: clean(bindingGoal.semanticType),
    semanticGoal: clean(bindingGoal.semanticGoal),
    decisionGroupId: clean(bindingGoal.decisionGroupId),
    desiredPolicyOutcome: clean(bindingGoal.desiredPolicyOutcome),
    desiredSemanticOutcome: clean(bindingGoal.desiredSemanticOutcome)
  } : null;
  return {
    observationId: clean(observation.observationId),
    currentSurface: {
      id: clean(surface.id || "surface-page"),
      type: clean(surface.type || "page"),
      label: clean(surface.label),
      surfaceClass: clean(surface.surfaceClass || page.surfaceClass || "unknown"),
      taskHint: clean(surface.taskHint)
    },
    checkoutContext: {
      step: clean(page.step || "unknown"),
      url: clean(page.url || observation.url),
      summary: clean(page.summary?.title || page.summary?.text),
      foregroundHeading: clean(page.foreground?.heading),
      totalPrice: page.price || null,
      priceText: clean(page.priceText),
      recentTransition: observation.transitionEvaluation
        ? {
            status: clean(observation.transitionEvaluation.status),
            priceChanged: observation.transitionEvaluation.diff?.priceChanged || null,
            progressChanged: observation.transitionEvaluation.diff?.progressChanged || null,
            surfaceChanged: observation.transitionEvaluation.diff?.surfaceChanged || false
          }
        : null,
      sections: (page.sections || []).filter((section) => (
        relatedSectionIds.has(clean(section.id)) || clean(section.id) === clean(surface.id)
      )).map((section) => ({
        id: clean(section.id),
        type: clean(section.type || "unknown"),
        label: clean(section.label),
        status: clean(section.status || "unknown")
      })).slice(0, 8)
    },
    userPolicy: {
      bookingRules: clean(userPolicy.bookingRules || traveler.booking_rules),
      seatPolicy: seatPolicyFrom({ userPolicy, traveler }),
      baggage: clean(userPolicy.baggage || traveler.baggage_preference),
      insurance: clean(userPolicy.insurance),
      extras: clean(userPolicy.extras)
    },
    taskState: {
      stage: clean(taskState.stage || "unknown"),
      currentGoal: compactGoal,
      // The model binds mechanics for one admitted obligation. It must not
      // receive a second decision list that could reopen or reprioritize work.
      terminalStatus: clean(taskState.terminalStatus || "active")
    },
    ambiguousSelections: groups.slice(0, 3).map((group) => ({
      decisionGroupId: clean(group.decisionGroupId || group.requirementId),
      selectedLabel: clean(group.selectedLabel || group.selectedEvidence?.selectedLabel),
      price: group.selectedEvidence?.structuredPrice || (() => {
        const selected = transactionSelectionForGroup(group, page);
        return selected && Number.isFinite(Number(selected.priceAmount))
          ? { amount: Number(selected.priceAmount), currency: clean(selected.currency) }
          : null;
      })(),
      ownerElementId: clean(group.selectedEvidence?.ownerElementId),
      sectionType: clean(group.sectionType || "unknown"),
      sectionLabel: clean(group.sectionLabel),
      nearbySectionType: clean(group.semanticOwnership?.nearbySectionType || "unknown"),
      nearbySectionLabel: clean(group.semanticOwnership?.nearbySectionLabel),
      ownedControlIds: ownedControlIds(group, page),
      candidateCorrectionControlIds: resolutionControlIdsForGroup(group, page),
      evidence: (group.evidence || []).map(clean).filter(Boolean).slice(0, 8)
    })),
    currentSurfaceCapabilities: controls,
    lastActionResult: observation.lastActionResult ? {
      actionId: clean(observation.lastActionResult.actionId),
      dispatched: observation.lastActionResult.dispatched === true,
      verified: observation.lastActionResult.verified === true,
      code: clean(observation.lastActionResult.outcome?.code || observation.lastActionResult.failureCode),
      mechanicalEffect: clean(observation.lastActionResult.action?.mechanicalEffect || observation.lastActionResult.mechanicalEffect)
    } : null
  };
}

function controlNeedsVisualEvidence(control = {}) {
  const localIdentity = clean([
    control.ownText,
    control.ariaLabel,
    control.title,
    control.testId,
    control.label,
    control.accessibleName
  ].join(" "));
  return Boolean(!localIdentity && control.visualRegion);
}

function applySemanticOwnershipResolution(observation = {}, resolution = {}) {
  const page = observation.page || {};
  const decisionGroupId = clean(resolution.decisionGroupId);
  const controlId = clean(resolution.controlId);
  const group = (page.decisionGroups || []).find((item) => clean(item.decisionGroupId || item.requirementId) === decisionGroupId);
  const control = (page.controls || []).find((item) => clean(item.controlId) === controlId);
  const eligibleControlIds = group ? resolutionControlIdsForGroup(group, page) : [];
  const currentSurfaceOwned = Boolean(control && controlBelongsToCurrentSurface(control, page));
  const executable = Boolean(control && controlHasExecutableCapability(control));
  const forbiddenCorrectionCandidate = Boolean(control && controlIsForbiddenCorrectionCandidate(control));
  if (!group
    || !control
    || !eligibleControlIds.includes(controlId)
    || !currentSurfaceOwned
    || !executable
    || forbiddenCorrectionCandidate) {
    const error = new Error(`Semantic ownership resolution did not reference a grounded executable correction control (${JSON.stringify({
      decisionGroupObserved: Boolean(group),
      controlObserved: Boolean(control),
      eligibleControlIds,
      currentSurfaceOwned,
      executable,
      forbiddenCorrectionCandidate
    })}).`);
    error.code = "SEMANTIC_OWNERSHIP_NOT_GROUNDED";
    throw error;
  }
  const family = OWNERSHIP_FAMILIES.includes(resolution.family) ? resolution.family : "unknown";
  if (family === "unknown") return { observation, resolution: { ...resolution, status: "unknown" } };
  const intendedOutcome = INTENDED_OUTCOMES.includes(resolution.intendedOutcome)
    ? resolution.intendedOutcome
    : "unknown";
  const semanticOwnership = Object.freeze({
    status: "hypothesis",
    authority: "interpretation_only",
    browserFactsMutated: false,
    family,
    source: "grounded_ai",
    controlId,
    ...(OWNERSHIP_REQUIREMENTS.includes(resolution.requirement)
      ? { requirement: resolution.requirement }
      : {}),
    ...(PRICE_DISPOSITIONS.includes(resolution.priceDisposition)
      ? { priceDisposition: resolution.priceDisposition }
      : {}),
    ...(POLICY_COMPATIBILITY.includes(resolution.policyCompatibility)
      ? { policyCompatibility: resolution.policyCompatibility }
      : {}),
    confidence: resolution.confidence,
    intendedOutcome,
    rationale: clean(resolution.rationale)
  });
  const resolvesPolicyConflict = semanticOwnership.policyCompatibility === "conflict"
    && semanticOwnership.priceDisposition === "paid"
    && intendedOutcome !== "unknown"
    && ["high", "medium"].includes(clean(resolution.confidence).toLowerCase());
  const ownershipLinkId = resolvesPolicyConflict
    ? `${clean(observation.observationId || "observation")}:ownership:${decisionGroupId}:${controlId}`
    : "";
  const correctionDecisionGroupId = clean(control.decisionGroupId);
  const ownershipLink = ownershipLinkId
    ? Object.freeze({
        linkId: ownershipLinkId,
        observationId: clean(observation.observationId),
        sourceDecisionGroupId: decisionGroupId,
        correctionDecisionGroupId,
        correctionControlId: controlId,
        surfaceId: clean(control.surfaceId || currentSurface(page).id || "surface-page"),
        status: "resolved",
        source: "grounded_ai",
        family,
        intendedOutcome,
        hypothesizedEffect: intendedOutcome,
        observedControlFacts: Object.freeze({
          semantic: clean(control.semantic || "unknown"),
          physicalEffect: clean(control.physicalEffect || "unknown"),
          risk: clean(control.risk || "uncertain"),
          selected: Boolean(control.selected || control.state?.selected || control.state?.checked),
          structuredPrice: control.structuredPrice || null
        }),
        confidence: resolution.confidence
      })
    : null;
  const decisionGroups = (page.decisionGroups || []).map((item) => (
    clean(item.decisionGroupId || item.requirementId) === decisionGroupId
      ? {
          ...item,
          semanticOwnership,
          ...(resolvesPolicyConflict
            ? {
                semanticCorrectionControlIds: [...new Set([...(item.semanticCorrectionControlIds || []), controlId])]
              }
            : {})
        }
      : item
  ));
  return {
    observation: {
      ...observation,
      page: {
        ...page,
        // Browser mechanics are immutable. AI interpretation lives only in the
        // observation-scoped ownership link and never rewrites these controls.
        controls: page.controls || [],
        decisionGroups,
        semanticOwnershipLinks: ownershipLink
          ? [
              ...(page.semanticOwnershipLinks || []).filter((item) => item.sourceDecisionGroupId !== decisionGroupId),
              ownershipLink
            ]
          : (page.semanticOwnershipLinks || []),
        semanticOwnershipResolutions: [
          ...(page.semanticOwnershipResolutions || []).filter((item) => item.decisionGroupId !== decisionGroupId),
          { decisionGroupId, ...semanticOwnership }
        ]
      }
    },
    resolution: { decisionGroupId, ...semanticOwnership }
  };
}

async function resolveSemanticOwnership({
  apiKey,
  model,
  observation = {},
  userPolicy = {},
  traveler = {},
  taskState = {},
  screenshotDataUrl = ""
} = {}) {
  const groups = ambiguousPaidSelections(observation, userPolicy, traveler).slice(0, 3);
  if (!groups.length) return { observation, resolution: null, meta: null };
  const page = observation.page || {};
  const instructions = [
    "Resolve only the semantic ownership of one currently selected paid item from the complete current-surface evidence.",
    "Choose exactly one supplied paid decisionGroupId and one supplied grounded current-surface correction controlId.",
    "The paid item and correction control may be rendered in different components, surfaces, or decision groups; map them when the complete evidence supports that ownership.",
    "Classify the item as seat, baggage, bundle, insurance, extras, or unknown.",
    "Report whether the item appears required, optional, or unknown; whether its current price is paid, free, or unknown; and whether it conflicts with the supplied user policy.",
    "Return the intended outcome as a hypothesis. Never rewrite the control's observed semantic, physical effect, risk, selected state, price, or available operations.",
    "A navigation-looking control may be returned only when its intended outcome is open_correction_surface and it does not advance checkout past the unresolved conflict.",
    "controlId must be an exact supplied observed control that could safely resolve the conflict; never return payment, purchase, legal consent, another paid selection, or an unrelated control.",
    "Nearby broad layout headings are context, not authoritative ownership.",
    "Do not invent controls, decision groups, selectors, actions, coordinates, or checkout steps.",
    "Return unknown when the current evidence is insufficient."
  ].join(" ");
  const { data, meta } = await callStructured({
    apiKey,
    model,
    instructions,
    payload: semanticOwnershipPayload(observation, groups, userPolicy, traveler, taskState),
    screenshotDataUrl: (page.controls || []).some((control) => (
      controlBelongsToCurrentSurface(control, page) && controlNeedsVisualEvidence(control)
    )) ? screenshotDataUrl : "",
    schema: ownershipResolutionSchemaFor(groups, page),
    schemaName: "checkout_semantic_ownership_resolution",
    maxOutputTokens: 350,
    returnMeta: true,
    maxPayloadBytes: OWNERSHIP_MODEL_PACKET_BYTES
  });
  return { ...applySemanticOwnershipResolution(observation, data), meta };
}


function observationDecisionHash(observation = {}) {
  return String(observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "");
}

function decisionConflictId(goal = {}) {
  return String(goal.decisionGroupId || goal.requirementId || goal.goalId || "");
}

function reusableSemanticOwnershipDecision(cache = null, observation = {}, policyFingerprint = "") {
  const entry = cache?.semanticOwnership;
  if (!entry || entry.observationHash !== observationDecisionHash(observation)) return null;
  if (entry.policyFingerprint !== policyFingerprint) return null;
  if (!entry.conflictId || !entry.stableControlIdentity || !entry.intendedOutcome || !entry.confidence) return null;
  const groupExists = (observation.page?.decisionGroups || []).some((group) => (
    String(group.decisionGroupId || group.requirementId || "") === entry.conflictId
  ));
  const currentControl = (observation.page?.controls || []).find((control) => (
    String(control.stableKey || control.controlId || "") === entry.stableControlIdentity
  ));
  if (!groupExists || !currentControl) return null;
  try {
    return applySemanticOwnershipResolution(observation, {
      ...(entry.resolution || {}),
      decisionGroupId: entry.conflictId,
      controlId: currentControl.controlId
    });
  } catch {
    return null;
  }
}

function semanticOwnershipCacheEntry(observation = {}, policyFingerprint = "", resolution = null) {
  if (!resolution?.decisionGroupId || !resolution?.controlId || !resolution?.intendedOutcome) return null;
  const control = (observation.page?.controls || []).find((item) => item.controlId === resolution.controlId) || {};
  return Object.freeze({
    observationId: String(observation.observationId || ""),
    observationHash: observationDecisionHash(observation),
    policyFingerprint,
    conflictId: String(resolution.decisionGroupId),
    controlId: String(resolution.controlId),
    stableControlIdentity: String(control.stableKey || control.controlId || resolution.controlId),
    intendedOutcome: String(resolution.intendedOutcome),
    confidence: String(resolution.confidence || "unknown"),
    resolution: Object.freeze({ ...resolution })
  });
}

module.exports = {
  ambiguousPaidSelections,
  applySemanticOwnershipResolution,
  ownershipResolutionSchemaFor,
  resolveSemanticOwnership,
  reusableSemanticOwnershipDecision,
  semanticOwnershipCacheEntry,
  semanticOwnershipPayload
};
