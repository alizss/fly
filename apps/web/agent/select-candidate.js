const { callStructured } = require("./openai-client");
const { candidateSelectionSchemaFor } = require("./schemas");

const INSTRUCTIONS = [
  "Interpret only the current foreground surface, then select exactly one supplied candidateId and one semanticOutcome.",
  "Context capabilities describe every grounded control on the current surface, including blocked controls.",
  "Selectable candidates are grounded, actionable, and policy-safe. Choose only from selectableCandidates.",
  "Do not invent targets, values, keys, geometry, or another action.",
  "Semantic intent and outcome compatibility are guidance only. You may select a grounded safe candidate whose semantic classification is unknown when it is relevant to the visible foreground surface.",
  "Prefer the simplest direct candidate likely to satisfy the semantic postcondition.",
  "For editable comboboxes, direct typing is usually preferable to opening a list; a country-name query is useful when typing the code is unlikely to commit.",
  "Use a visual candidate only when the DOM/accessibility candidates are not credible.",
  "Return only a candidateId that appears in the supplied candidates and a semanticOutcome from the schema."
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
  const allCapabilities = Array.isArray(contextCapabilities) && contextCapabilities.length
    ? contextCapabilities
    : candidates;
  const needsScreenshot = allCapabilities.some((candidate) => candidate.visualRegion);
  const payload = {
      observationId: observation.observationId || "",
      taskState: {
        stage: taskState.stage || "unknown",
        foregroundSurface: taskState.foregroundSurface || null,
        activeDecisions: taskState.activeDecisions || [],
        validationBlockers: taskState.validationBlockers || [],
        completedOutcomes: taskState.completedOutcomes || [],
        currentGoal: taskState.currentGoal || goal,
        terminalStatus: taskState.terminalStatus || "active"
      },
      goal: {
        goalId: goal.goalId,
        semanticType: goal.semanticType,
        desiredValue: goal.desiredValue,
        currentValue: goal.currentValue || "",
        postcondition: goal.postcondition,
        outcomeContract: goal.outcomeContract || null
      },
      contextCapabilities: allCapabilities.map((candidate) => ({
        id: candidate.capabilityId || candidate.candidateId,
        label: candidate.targetLabel || candidate.label || "",
        meaning: candidate.meaning || candidate.semantic || "",
        semanticType: candidate.semantic || candidate.interactionRole || "",
        mechanicalEffect: candidate.mechanicalEffect || candidate.physicalEffect || candidate.affordance?.mechanicalEffect || candidate.affordance?.effect || "unknown",
        semanticIntent: candidate.semanticIntent || "unknown",
        outcomeCompatibility: candidate.outcomeCompatibility || "unknown",
        risk: candidate.risk || "uncertain",
        policyStatus: candidate.policyStatus || (candidate.policyDecision?.allow === true ? "allowed" : String(candidate.policyDecision?.decision || "denied")),
        selectable: candidate.selectable === true
      })),
      selectableCandidates: candidates.map((candidate) => ({
        candidateId: candidate.candidateId,
        type: candidate.type,
        operation: candidate.operation,
        interactionRole: candidate.interactionRole || "",
        semanticEffect: candidate.semanticEffect || "",
        expectedEvidence: candidate.expectedEvidence || "",
        mechanicalEffect: candidate.mechanicalEffect || candidate.physicalEffect || candidate.affordance?.mechanicalEffect || candidate.affordance?.effect || "unknown",
        semanticIntent: candidate.semanticIntent || "unknown",
        expectedPostconditions: candidate.expectedPostconditions || [],
        outcomeCompatibility: candidate.outcomeCompatibility || "compatible",
        affordance: candidate.affordance || null,
        risk: candidate.risk || "uncertain",
        structuredPrice: candidate.structuredPrice || null,
        value: candidate.value || "",
        keys: candidate.keys || "",
        summary: candidate.summary || "",
        visual: Boolean(candidate.visualRegion)
      }))
    };
  const metas = [];
  for (let attempt = 1; attempt <= 1; attempt += 1) {
    const { data, meta } = await callStructured({
      apiKey,
      model,
      instructions: INSTRUCTIONS,
      payload: { ...payload, candidateSelectionAttempt: attempt },
      screenshotDataUrl: needsScreenshot ? screenshotDataUrl : "",
      schema: candidateSelectionSchemaFor(candidates.map((candidate) => candidate.candidateId)),
      schemaName: "checkout_candidate_selection",
      // Keep the response compact, but leave enough room for the structured
      // output machinery to emit the observation-bound enum value reliably.
      maxOutputTokens: 400,
      returnMeta: true
    });
    metas.push(meta);
    const candidateId = String(data?.candidateId || "");
    if (candidates.some((candidate) => candidate.candidateId === candidateId)) {
      return {
        candidateId,
        semanticOutcome: String(data?.semanticOutcome || ""),
        meta: { ...(meta || {}), candidateSelectionAttempts: attempt, retryMetas: metas }
      };
    }
  }
  const error = new Error("Candidate selector exhausted bounded reselection against the unchanged candidate set.");
  error.code = "PLANNER_CANDIDATE_NOT_CURRENT";
  error.selectionAttempts = 1;
  throw error;
}

module.exports = { selectCandidate };
