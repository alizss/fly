// The V2 runtime has two mutually exclusive ambiguity modes per turn: grounded
// semantic-scene reconciliation and selection from an immutable candidate ID
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

function semanticSceneSchemaFor(controlIds = [], semanticTypes = [], factSources = [], validationIssueIds = [], decisionGroupIds = [], decisionTypes = []) {
  const controls = [...new Set(controlIds.map(String).filter(Boolean))];
  const semantics = [...new Set(semanticTypes.map(String).filter(Boolean))];
  const sources = [...new Set(factSources.map(String).filter(Boolean))];
  const issues = [...new Set(validationIssueIds.map(String).filter(Boolean))];
  const groups = [...new Set(decisionGroupIds.map(String).filter(Boolean))];
  const decisions = [...new Set(decisionTypes.map(String).filter(Boolean))];
  return {
    type: "object",
    additionalProperties: false,
    required: ["status", "hypotheses", "decisionHypotheses"],
    properties: {
      status: { type: "string", enum: ["grounded", "unknown"] },
      hypotheses: {
        type: "array",
        maxItems: 4,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["controlId", "semanticType", "factSource", "validationIssueId", "confidence", "evidence"],
          properties: {
            controlId: { type: "string", enum: ["", ...controls] },
            semanticType: { type: "string", enum: ["unknown", ...semantics] },
            factSource: { type: "string", enum: ["", ...sources] },
            validationIssueId: { type: "string", enum: ["", ...issues] },
            confidence: { type: "string", enum: ["high", "medium", "low"] },
            evidence: { type: "string" }
          }
        }
      },
      decisionHypotheses: {
        type: "array",
        maxItems: 4,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["decisionGroupId", "decisionType", "confidence", "evidence"],
          properties: {
            decisionGroupId: { type: "string", enum: ["", ...groups] },
            decisionType: { type: "string", enum: ["unknown", ...decisions] },
            confidence: { type: "string", enum: ["high", "medium", "low"] },
            evidence: { type: "string" }
          }
        }
      }
    }
  };
}

module.exports = {
  candidateSelectionSchema,
  candidateSelectionSchemaFor,
  semanticBindingSchemaFor,
  semanticSceneSchemaFor
};
