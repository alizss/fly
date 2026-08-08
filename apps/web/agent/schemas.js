// The V2 runtime has only two model boundaries: bounded semantic binding for
// an already-admitted component and selection from an immutable candidate ID
// set. Historical extractor/verifier/planner schemas were removed with V1.

const candidateSelectionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["candidateId", "semanticOutcome", "confidence"],
  properties: {
    candidateId: { type: "string" },
    semanticOutcome: {
      type: "string",
      enum: [
        "satisfy_current_decision",
        "advance_current_surface",
        "dismiss_current_surface",
        "request_user_input",
        "stop_for_payment_review"
      ]
    },
    confidence: { type: "string", enum: ["high", "medium", "low"] }
  }
};

function candidateSelectionSchemaFor(candidateIds = []) {
  const ids = [...new Set((candidateIds || []).map(String).filter(Boolean))];
  return {
    ...candidateSelectionSchema,
    properties: {
      ...candidateSelectionSchema.properties,
      candidateId: ids.length
        ? { type: "string", enum: ids }
        : { type: "string" }
    }
  };
}

function semanticBindingSchemaFor(componentIds = [], semanticTypes = [], factSources = []) {
  const components = [...new Set(componentIds.map(String).filter(Boolean))];
  const semantics = [...new Set(semanticTypes.map(String).filter(Boolean))];
  const sources = [...new Set(factSources.map(String).filter(Boolean))];
  return {
    type: "object",
    additionalProperties: false,
    required: ["status", "componentId", "semanticType", "factSource", "confidence", "evidence"],
    properties: {
      status: { type: "string", enum: ["bound", "unknown"] },
      componentId: { type: "string", enum: ["", ...components] },
      semanticType: { type: "string", enum: ["unknown", ...semantics] },
      factSource: { type: "string", enum: ["", ...sources] },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
      evidence: { type: "string" }
    }
  };
}

module.exports = {
  candidateSelectionSchema,
  candidateSelectionSchemaFor,
  semanticBindingSchemaFor
};
