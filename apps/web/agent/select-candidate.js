const { callStructured } = require("./openai-client");
const { candidateSelectionSchemaFor } = require("./schemas");
const {
  MAX_RELATED_MODEL_CONTROLS,
  clipped,
  compileInteractionView
} = require("./interaction-view");

const CANDIDATE_MODEL_PACKET_BYTES = 24_000;

const INSTRUCTIONS = [
  "Interpret only the current foreground surface, then select exactly one supplied candidateId and one semanticOutcome.",
  "Context capabilities describe only mechanics admitted for the current obligation; unrelated surface controls are intentionally absent.",
  "Selectable candidates are grounded, actionable, and policy-safe. Choose only from selectableCandidates.",
  "A mechanical_hypothesis is one reversible, exact-actuator discovery action. Use it only to reveal the current obligation's owned child surface; never treat it as semantic completion.",
  "After one mechanical hypothesis the browser must reobserve. Do not infer or emit a second action.",
  "When adaptiveEnvelope is present, remain inside its exact surface, operations, risk limits, step budget, and semantic objective.",
  "Do not invent targets, values, keys, geometry, or another action.",
  "Semantic intent and outcome compatibility are guidance only. You may select a grounded safe candidate whose semantic classification is unknown when it is relevant to the visible foreground surface.",
  "Prefer the simplest direct candidate likely to satisfy the semantic postcondition.",
  "For editable comboboxes, direct typing is usually preferable to opening a list; a country-name query is useful when typing the code is unlikely to commit.",
  "Use a visual candidate only when the DOM/accessibility candidates are not credible.",
  "Return only a candidateId that appears in the supplied candidates, a semanticOutcome, and your confidence from the schema."
].join(" ");

async function selectCandidate({
  apiKey,
  model,
  goal,
  taskState = {},
  candidates,
  contextCapabilities = [],
  observation,
  screenshotDataUrl = ""
}) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    const error = new Error("No current executable candidates were published for planner selection.");
    error.code = "NO_CURRENT_CANDIDATES";
    throw error;
  }
  const selectableCandidates = candidates.slice(0, MAX_RELATED_MODEL_CONTROLS);
  const suppliedCapabilities = Array.isArray(contextCapabilities) && contextCapabilities.length
    ? contextCapabilities
    : candidates;
  const capabilityById = new Map();
  for (const capability of [...selectableCandidates, ...suppliedCapabilities]) {
    const id = capability.candidateId || capability.capabilityId || capability.controlId;
    if (!id) continue;
    if (capabilityById.has(id)) {
      capabilityById.set(id, { ...capabilityById.get(id), ...capability });
    } else if (capabilityById.size < MAX_RELATED_MODEL_CONTROLS) {
      capabilityById.set(id, capability);
    }
  }
  const allCapabilities = [...capabilityById.values()];
  const needsScreenshot = ["adaptive_surface", "adaptive_interaction"].includes(goal.kind) || allCapabilities.some((candidate) => (
    candidate.type === "click_xy"
    || candidate.mechanicalHypothesis === true
    || (!candidate.controlId && candidate.visualRegion)
    || candidate.affordance?.actuator?.source === "visual_fallback"
  ));
  const payload = {
    interactionView: compileInteractionView({
      goal,
      taskState,
      candidates: selectableCandidates,
      contextCapabilities: allCapabilities,
      observation
    }),
    selectableCandidates: selectableCandidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      candidateClass: candidate.mechanicalHypothesis === true ? "mechanical_hypothesis" : "proven_action",
      logicalControlId: candidate.logicalControlId || candidate.controlId || "",
      actuatorId: candidate.actuatorId || candidate.targetId || "",
      type: candidate.type,
      operation: candidate.operation,
      interactionRole: candidate.interactionRole || "",
      semanticEffect: candidate.semanticEffect || "",
      expectedEvidence: candidate.expectedEvidence || "",
      mechanicalEffect: candidate.mechanicalEffect || candidate.physicalEffect || candidate.affordance?.mechanicalEffect || candidate.affordance?.effect || "unknown",
      semanticIntent: candidate.semanticIntent || "unknown",
      expectedPostconditions: (candidate.expectedPostconditions || []).slice(0, 3).map((item) => ({
        type: item.type || "",
        decisionGroupId: item.decisionGroupId || "",
        controlId: item.controlId || ""
      })),
      outcomeCompatibility: candidate.outcomeCompatibility || "compatible",
      stableControlIdentity: candidate.affordance?.stableKey || candidate.stableKey || candidate.controlId || "",
      risk: candidate.risk || "uncertain",
      structuredPrice: candidate.structuredPrice || null,
      value: candidate.value || "",
      keys: candidate.keys || "",
      summary: clipped(candidate.summary, 240),
      visual: Boolean(candidate.visualRegion)
    }))
  };
  const { data, meta } = await callStructured({
    apiKey,
    model,
    instructions: INSTRUCTIONS,
    payload: { ...payload, candidateSelectionAttempt: 1 },
    screenshotDataUrl: needsScreenshot ? screenshotDataUrl : "",
    schema: candidateSelectionSchemaFor(selectableCandidates.map((candidate) => candidate.candidateId)),
    schemaName: "checkout_candidate_selection",
    maxOutputTokens: 400,
    returnMeta: true,
    maxPayloadBytes: CANDIDATE_MODEL_PACKET_BYTES
  });
  const candidateId = String(data?.candidateId || "");
  if (selectableCandidates.some((candidate) => candidate.candidateId === candidateId)) {
    return {
      candidateId,
      semanticOutcome: String(data?.semanticOutcome || ""),
      confidence: ["high", "medium", "low"].includes(String(data?.confidence || "").toLowerCase())
        ? String(data.confidence).toLowerCase()
        : "unknown",
      meta: { ...(meta || {}), candidateSelectionAttempts: 1, retryMetas: [meta] }
    };
  }
  const error = new Error("Candidate selector returned an ID outside the unchanged closed candidate set.");
  error.code = "PLANNER_CANDIDATE_NOT_CURRENT";
  error.selectionAttempts = 1;
  throw error;
}

module.exports = { selectCandidate };
