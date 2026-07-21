// Combines the old separate verifier.js + planner.js into one call: "given
// what just happened, is it actually done, and what's next" is one judgment,
// not two independent LLM round-trips. Cuts the loop from 3 sequential
// OpenAI calls per turn to 2 (this + the requirement extractor), which was
// the single biggest cause of the loop feeling slow in practice.
//
// Nothing here is written against any specific site's markup or wording —
// same discipline as the rest of the loop: it must hold up on a checkout
// flow this has never seen, not just the ones it's been tested against.

const { callStructured } = require("./openai-client");
const { verifyAndPlanSchemaFor } = require("./schemas");
const { latestPrice } = require("../../../packages/shared/agent-state");
const {
  semanticActionContext,
  modelObservationContext,
  sanitizedActionHistory,
  sanitizedFailureHistory
} = require("./model-context");

const INSTRUCTIONS = [
  "You verify semantic checkout progress and select one server-grounded candidate for the next goal.",
  "Return `verification` plus `action={candidateId}`. candidateId is the complete planner action contract.",
  "Use pageMarkdown for current whole-page state and observationDiffMarkdown for what changed. Treat an appeared popup, changed progress marker, committed selection, or validation response as meaningful current-state evidence and replan from it.",
  "Historical actions are semantic context only. They intentionally contain no DOM identity and must never be treated as executable targets.",
  "The candidate list is generated exclusively from the current observation's canonical registry. Select exactly one listed candidateId. Do not return a semantic goal or restate the server's goal wording.",
  "Never invent or return targetId, controlId, coordinates, snapshots, geometry, actuators, operations, values, keys, or another action.",
  "PART 1 — verification:",
  "You are given semantic information about the previous action and freshly extracted current requirements/screenshot.",
  "changed=true only if something observably changed (a field now has a value it didn't before, a requirement's status flipped, the URL/step changed, a dropdown opened or closed). Do not assume an action worked just because it was dispatched without error.",
  "lastActionWorked judges whether the semantic outcome was achieved.",
  "priceChanged=true only if a total/price figure differs from the previous one given to you. riskChanged=true if something newly visible is money/payment/legal risk that wasn't flagged before.",
  "Verification is diagnostic only. Browser observations and browser-confirmed postconditions are the sole authority for requirement and action success. Do not use requirementUpdates to override currentRequirements.",
  "PART 2 — candidate selection:",
  "Prefer a visible safe decline/no-extra candidate for baggage, bundles, seats, flexible tickets, cancellation, and insurance when policy says no extras.",
  "For a closed required dropdown, select its current `open` candidate. On the next fresh observation, select a free/no-extra observed option; never reuse an old modal candidate.",
  "Do not select Continue while a current required decision is unresolved.",
  "If the browser rejected a stale identity, select a newly listed current candidate for the same semantic goal. If none exists, select the grounded handoff candidate.",
  "Both verification evidence and blockers must be short, concrete, user-visible text."
].join(" ");

class PlannerContractError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "PlannerContractError";
    this.code = code;
    this.details = details;
  }
}

function resolvePlannerSelection(rawAction = {}, candidateSet = {}) {
  const candidateId = String(rawAction?.candidateId || "");
  const candidates = Array.isArray(candidateSet?.candidates) ? candidateSet.candidates : [];
  const candidate = candidates.find((item) => item.candidateId === candidateId) || null;
  if (!candidate) {
    throw new PlannerContractError(
      "PLANNER_CANDIDATE_NOT_CURRENT",
      "Planner returned a candidateId outside the current observation-bound candidate set.",
      { candidateId, observationId: candidateSet?.observationId || "" }
    );
  }
  return {
    candidateId,
    candidate
  };
}

async function selectFromImmutableCandidateSet({ candidateSet = {}, maxAttempts = 3, requestSelection }) {
  let lastError = null;
  const metas = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await requestSelection(attempt);
    if (response?.meta) metas.push(response.meta);
    try {
      return {
        raw: response?.data || {},
        meta: response?.meta || null,
        metas,
        attempt,
        selection: resolvePlannerSelection(response?.data?.action || response?.data || {}, candidateSet)
      };
    } catch (error) {
      if (!(error instanceof PlannerContractError)) throw error;
      lastError = error;
    }
  }
  throw new PlannerContractError(
    lastError?.code || "PLANNER_CANDIDATE_NOT_CURRENT",
    "Planner exhausted bounded reselection against the unchanged immutable candidate set.",
    {
      ...(lastError?.details || {}),
      selectionAttempts: maxAttempts,
      observationId: candidateSet.observationId || "",
      observationHash: candidateSet.observationHash || "",
      surfaceId: candidateSet.surfaceId || ""
    }
  );
}

/**
 * @param {Object} args
 * @param {string} args.apiKey
 * @param {string} args.model
 * @param {import("../../../packages/shared/agent-state").CheckoutSessionState} args.state previous state
 * @param {Object} args.observation current AgentObservation
 * @param {Array} args.currentRequirements freshly derived requirements for the current page
 * @param {Object} [args.pageState] typed page state from classifier
 * @param {Object} args.traveler
 * @param {Array} [args.actionHistory]
 * @param {string} [args.screenshotDataUrl]
 * @returns {Promise<{ verification: Object, action: import("../../../packages/shared/agent-actions").AgentAction }>}
 */
async function verifyAndPlan({ apiKey, model, state, observation, currentRequirements, pageState = null, traveler, actionHistory = [], screenshotDataUrl, candidateSet = null, semanticGoal = null }) {
  const previousPrice = latestPrice(state);
  const observationContext = modelObservationContext(observation, traveler);
  const boundCandidateSet = candidateSet || {
    observationId: observation?.observationId || "",
    observationHash: observation?.observationSnapshot?.snapshotHash || observation?.page?.snapshotHash || "",
    surfaceId: "",
    candidates: []
  };
  const candidates = Array.isArray(boundCandidateSet.candidates) ? boundCandidateSet.candidates : [];
  const plannerPayload = {
    previousRequirements: (state?.legacyRequirementsDiagnostic?.requirements || []).map((req) => ({ id: req.id, label: req.label, status: req.status, required: req.required })),
    lastAction: semanticActionContext(state?.lastAction || {}, observation?.lastActionResult || {}),
    currentStep: state?.currentStep || "unknown",
    currentRequirements,
    pageState,
    previousPrice,
    currentPriceText: observation?.page?.priceText || "",
    lastActionResultFromClient: semanticActionContext(state?.lastAction || {}, observation?.lastActionResult || {}),
    ...observationContext,
    traveler: traveler || {},
    approvalState: state?.approvals || {},
    semanticGoal,
    candidateSet: {
      observationId: boundCandidateSet.observationId || "",
      observationHash: boundCandidateSet.observationHash || "",
      surfaceId: boundCandidateSet.surfaceId || "",
      candidates: candidates.map((candidate) => ({
        candidateId: candidate.candidateId,
        controlId: candidate.controlId || "",
        semantic: candidate.semantic || "",
        operation: candidate.operation || "",
        interactionRole: candidate.interactionRole || "",
        semanticEffect: candidate.semanticEffect || "",
        expectedEvidence: candidate.expectedEvidence || "",
        affordance: candidate.affordance || null,
        risk: candidate.risk || "uncertain",
        visible: candidate.visible === true,
        summary: candidate.summary || ""
      }))
    },
    failedActionOutcomes: sanitizedFailureHistory(state?.failures || []),
    actionHistory: sanitizedActionHistory(actionHistory),
    userIntent: observation?.userIntent || ""
  };
  const selected = await selectFromImmutableCandidateSet({
    candidateSet: boundCandidateSet,
    maxAttempts: 3,
    requestSelection: (attempt) => callStructured({
    apiKey,
    model,
    instructions: INSTRUCTIONS,
    payload: {
      ...plannerPayload,
      candidateSelectionAttempt: attempt
    },
    screenshotDataUrl,
    schema: verifyAndPlanSchemaFor(candidates.map((candidate) => candidate.candidateId)),
    schemaName: "checkout_verify_and_plan",
    maxOutputTokens: 1400,
    returnMeta: true
    })
  });
  const raw = selected.raw;
  const meta = {
    ...(selected.meta || {}),
    candidateSelectionAttempts: selected.attempt,
    retryMetas: selected.metas
  };

  const v = raw.verification || {};
  const verification = {
    ok: Boolean(v.ok),
    changed: Boolean(v.changed),
    lastActionWorked: Boolean(v.lastActionWorked),
    blockers: Array.isArray(v.blockers) ? v.blockers.map(String).slice(0, 10) : [],
    priceChanged: Boolean(v.priceChanged),
    riskChanged: Boolean(v.riskChanged),
    evidence: Array.isArray(v.evidence) ? v.evidence.map(String).slice(0, 10) : [],
    confidence: Math.max(0, Math.min(1, Number(v.confidence) || 0)),
    requirementUpdates: Array.isArray(v.requirementUpdates) ? v.requirementUpdates.map((item) => ({
      requirementId: String(item?.requirementId || ""),
      proposedStatus: String(item?.proposedStatus || ""),
      observationId: String(item?.observationId || ""),
      evidence: item?.evidence && typeof item.evidence === "object" ? {
        controlId: String(item.evidence.controlId || ""),
        selectedValue: String(item.evidence.selectedValue || ""),
        visibleText: String(item.evidence.visibleText || "")
      } : null,
      confidence: Math.max(0, Math.min(1, Number(item?.confidence) || 0))
    })).filter((item) => item.requirementId) : []
  };

  const selection = selected.selection;
  return { verification, selection, meta };
}

module.exports = { PlannerContractError, resolvePlannerSelection, selectFromImmutableCandidateSet, verifyAndPlan };
