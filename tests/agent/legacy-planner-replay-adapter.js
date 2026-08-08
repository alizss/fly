// Historical V1 planner-contract helpers retained only for saved replay and
// contract tests. Production V2 selects directly from the fresh mechanics
// binder in select-candidate.js and never imports this adapter.

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
  return { candidateId, candidate };
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

module.exports = {
  PlannerContractError,
  resolvePlannerSelection,
  selectFromImmutableCandidateSet
};
