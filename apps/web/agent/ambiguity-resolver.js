const { selectCandidate } = require("./select-candidate");
const {
  reconcileSemanticScene,
  semanticSceneUncertainty
} = require("./semantic-scene-reconciliation");

// One production model boundary for bounded ambiguity. The caller may request
// either grounded scene reconciliation or mechanical selection during a turn,
// never both. Both modes remain closed over supplied IDs and cannot create
// obligations, targets, effects, policy, or completion claims.
async function resolveAmbiguity(request = {}) {
  if (request.kind === "semantic_scene") {
    const result = await reconcileSemanticScene(request.input || {});
    return Object.freeze({
      kind: "semantic_scene",
      reconciliation: result.reconciliation || null,
      observation: result.observation,
      meta: result.meta || null
    });
  }
  if (request.kind === "mechanic_selection") {
    const selection = await selectCandidate(request.input || {});
    return Object.freeze({
      kind: "mechanic_selection",
      candidateId: selection.candidateId || "",
      selection,
      meta: selection.meta || null
    });
  }
  const error = new Error("AMBIGUITY_RESOLVER_MODE_REQUIRED");
  error.code = "AMBIGUITY_RESOLVER_MODE_REQUIRED";
  throw error;
}

module.exports = {
  resolveAmbiguity,
  semanticSceneUncertainty
};
