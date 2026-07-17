const { callStructured } = require("./openai-client");
const { candidateSelectionSchema } = require("./schemas");

const INSTRUCTIONS = [
  "Select exactly one candidateId for the current semantic checkout goal.",
  "Candidates are already grounded to the current browser observation and contain the complete executable operation.",
  "Do not invent targets, values, keys, geometry, or another action.",
  "Prefer the simplest direct candidate likely to satisfy the semantic postcondition.",
  "For editable comboboxes, direct typing is usually preferable to opening a list; a country-name query is useful when typing the code is unlikely to commit.",
  "Use a visual candidate only when the DOM/accessibility candidates are not credible.",
  "Return only a candidateId that appears in the supplied candidates."
].join(" ");

async function selectCandidate({
  apiKey,
  model,
  goal,
  candidates,
  observation,
  screenshotDataUrl = ""
}) {
  const needsScreenshot = candidates.some((candidate) => candidate.visualRegion);
  const payload = {
      observationId: observation.observationId || "",
      goal: {
        goalId: goal.goalId,
        semanticType: goal.semanticType,
        desiredValue: goal.desiredValue,
        currentValue: goal.currentValue || "",
        postcondition: goal.postcondition
      },
      candidates: candidates.map((candidate) => ({
        candidateId: candidate.candidateId,
        type: candidate.type,
        operation: candidate.operation,
        interactionRole: candidate.interactionRole || "",
        semanticEffect: candidate.semanticEffect || "",
        expectedEvidence: candidate.expectedEvidence || "",
        affordance: candidate.affordance || null,
        value: candidate.value || "",
        keys: candidate.keys || "",
        summary: candidate.summary || "",
        visual: Boolean(candidate.visualRegion)
      }))
    };
  const metas = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const { data, meta } = await callStructured({
      apiKey,
      model,
      instructions: INSTRUCTIONS,
      payload: { ...payload, candidateSelectionAttempt: attempt },
      screenshotDataUrl: needsScreenshot ? screenshotDataUrl : "",
      schema: candidateSelectionSchema,
      schemaName: "checkout_candidate_selection",
      maxOutputTokens: 120,
      returnMeta: true
    });
    metas.push(meta);
    const candidateId = String(data?.candidateId || "");
    if (candidates.some((candidate) => candidate.candidateId === candidateId)) {
      return {
        candidateId,
        meta: { ...(meta || {}), candidateSelectionAttempts: attempt, retryMetas: metas }
      };
    }
  }
  const error = new Error("Candidate selector exhausted bounded reselection against the unchanged candidate set.");
  error.code = "PLANNER_CANDIDATE_NOT_CURRENT";
  error.selectionAttempts = 3;
  throw error;
}

module.exports = { selectCandidate };
