const {
  reconcileSemanticScene,
  semanticSceneUncertainty
} = require("./semantic-scene-reconciliation");

// One production model boundary for semantic uncertainty only. Execution
// mechanics are selected deterministically from the canonical control graph
// after TaskState has admitted an exact obligation.
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
  const error = new Error("AMBIGUITY_RESOLVER_MODE_REQUIRED");
  error.code = "AMBIGUITY_RESOLVER_MODE_REQUIRED";
  throw error;
}

module.exports = {
  resolveAmbiguity,
  semanticSceneUncertainty
};
