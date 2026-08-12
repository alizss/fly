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

const SEMANTIC_SCENE_STAGES = Object.freeze([
  "unknown",
  "flight_selection",
  "traveler_information",
  "seats",
  "extras",
  "review",
  "payment",
  "confirmation"
]);

const SEMANTIC_SCENE_ROLES = Object.freeze([
  "unknown",
  "profile_field",
  "personal_attestation",
  "optional_credential",
  "optional_free",
  "optional_paid_accept",
  "optional_paid_decline",
  "legal_attestation",
  "payment_entry",
  "navigation",
  "transaction_commit",
  "informational"
]);

const SEMANTIC_SCENE_REQUIREDNESS = Object.freeze([
  "unknown",
  "html_required",
  "visually_required",
  "progression_required",
  "optional_meaningful",
  "safely_ignorable"
]);

const SEMANTIC_SCENE_CONSEQUENCES = Object.freeze([
  "unknown",
  "informational",
  "navigation",
  "optional_free",
  "optional_paid",
  "personal_attestation",
  "legal_attestation",
  "payment_entry",
  "transaction_commit"
]);

const SEMANTIC_SCENE_TYPES = Object.freeze([
  "unknown",
  "promotion_code",
  "loyalty_number",
  "billing_tax_id",
  "age_attestation",
  "paid_optional_product",
  "legal_terms",
  "payment_credential",
  "checkout_navigation",
  "transaction_confirmation",
  "information_only"
]);

function semanticSceneSchemaFor(controlIds = [], semanticTypes = [], factSources = [], validationIssueIds = []) {
  const controls = [...new Set(controlIds.map(String).filter(Boolean))];
  const semantics = [...new Set([...SEMANTIC_SCENE_TYPES, ...semanticTypes.map(String).filter(Boolean)])];
  const sources = [...new Set(factSources.map(String).filter(Boolean))];
  const issues = [...new Set(validationIssueIds.map(String).filter(Boolean))];
  return {
    type: "object",
    additionalProperties: false,
    required: ["status", "stage", "stageConfidence", "stageEvidence", "hypotheses"],
    properties: {
      status: { type: "string", enum: ["grounded", "unknown"] },
      stage: { type: "string", enum: SEMANTIC_SCENE_STAGES },
      stageConfidence: { type: "string", enum: ["high", "medium", "low"] },
      stageEvidence: { type: "string" },
      hypotheses: {
        type: "array",
        maxItems: 10,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "controlId",
            "role",
            "semanticType",
            "factSource",
            "validationIssueId",
            "relatedControlIds",
            "requiredness",
            "consequence",
            "confidence",
            "evidence"
          ],
          properties: {
            controlId: { type: "string", enum: ["", ...controls] },
            role: { type: "string", enum: SEMANTIC_SCENE_ROLES },
            semanticType: { type: "string", enum: semantics },
            factSource: { type: "string", enum: ["", ...sources] },
            validationIssueId: { type: "string", enum: ["", ...issues] },
            relatedControlIds: {
              type: "array",
              maxItems: 8,
              items: { type: "string", enum: controls }
            },
            requiredness: { type: "string", enum: SEMANTIC_SCENE_REQUIREDNESS },
            consequence: { type: "string", enum: SEMANTIC_SCENE_CONSEQUENCES },
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
  semanticSceneSchemaFor,
  SEMANTIC_SCENE_STAGES,
  SEMANTIC_SCENE_ROLES,
  SEMANTIC_SCENE_REQUIREDNESS,
  SEMANTIC_SCENE_CONSEQUENCES,
  SEMANTIC_SCENE_TYPES
};
