// Strict JSON schemas for each OpenAI call in the loop. Kept in one file so
// the shape of "what the model must return" is easy to audit in one place.

const requirementSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "type", "label", "status", "required", "risk", "evidence", "confidence", "targetIds"],
  properties: {
    id: { type: "string" },
    type: {
      type: "string",
      enum: ["traveler_field", "contact_field", "document_field", "baggage_decision", "seat_decision", "paid_extra_decision", "legal_acceptance", "payment", "continue", "unknown"]
    },
    label: { type: "string" },
    status: { type: "string", enum: ["missing", "satisfied", "blocked", "needs_user", "unknown", "conflicted"] },
    required: { type: "boolean" },
    risk: { type: "string", enum: ["safe", "money", "payment", "legal", "uncertain"] },
    evidence: { type: "array", items: { type: "string" } },
    confidence: { type: "number" },
    targetIds: { type: "array", items: { type: "string" } }
  }
};

const requirementExtractorSchema = {
  type: "object",
  additionalProperties: false,
  required: ["pageStep", "requirements", "uncertainties", "summary"],
  properties: {
    pageStep: {
      type: "string",
      enum: ["flight_selection", "traveler_information", "extras", "seats", "payment", "confirmation", "unknown"]
    },
    requirements: { type: "array", items: requirementSchema },
    uncertainties: { type: "array", items: { type: "string" } },
    summary: { type: "string" }
  }
};

const pageStateItemBase = {
  id: { type: "string" },
  label: { type: "string" },
  status: { type: "string", enum: ["missing", "satisfied", "blocked", "needs_user", "unknown"] },
  required: { type: "boolean" },
  risk: { type: "string", enum: ["safe", "money", "payment", "legal", "uncertain"] },
  targetIds: { type: "array", items: { type: "string" } },
  evidence: { type: "array", items: { type: "string" } },
  confidence: { type: "number" }
};

const pageStateSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "pageStep",
    "requiredFields",
    "requiredChoices",
    "optionalPaidExtras",
    "navigationActions",
    "riskGates",
    "currentSurface",
    "uncertainties",
    "summary"
  ],
  properties: {
    pageStep: {
      type: "string",
      enum: ["flight_selection", "traveler_information", "extras", "seats", "payment", "confirmation", "unknown"]
    },
    requiredFields: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "kind", "label", "status", "required", "risk", "targetIds", "evidence", "confidence"],
        properties: {
          ...pageStateItemBase,
          kind: { type: "string", enum: ["traveler", "contact", "document", "billing", "unknown"] }
        }
      }
    },
    requiredChoices: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "kind", "label", "status", "required", "risk", "targetIds", "evidence", "confidence"],
        properties: {
          ...pageStateItemBase,
          kind: { type: "string", enum: ["baggage", "seat", "paid_extra", "legal", "unknown"] }
        }
      }
    },
    optionalPaidExtras: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "label", "status", "risk", "priceText", "targetIds", "evidence", "confidence"],
        properties: {
          id: { type: "string" },
          label: { type: "string" },
          status: { type: "string", enum: ["missing", "satisfied", "blocked", "needs_user", "unknown"] },
          risk: { type: "string", enum: ["safe", "money", "payment", "legal", "uncertain"] },
          priceText: { type: "string" },
          targetIds: { type: "array", items: { type: "string" } },
          evidence: { type: "array", items: { type: "string" } },
          confidence: { type: "number" }
        }
      }
    },
    navigationActions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "action", "label", "enabled", "risk", "targetId", "x", "y", "evidence", "confidence"],
        properties: {
          id: { type: "string" },
          action: { type: "string", enum: ["continue", "next", "back", "close", "skip", "final_purchase", "unknown"] },
          label: { type: "string" },
          enabled: { type: "boolean" },
          risk: { type: "string", enum: ["safe", "money", "payment", "legal", "uncertain"] },
          targetId: { type: "string" },
          x: { type: "number" },
          y: { type: "number" },
          evidence: { type: "array", items: { type: "string" } },
          confidence: { type: "number" }
        }
      }
    },
    riskGates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "type", "label", "status", "risk", "targetIds", "evidence", "confidence"],
        properties: {
          id: { type: "string" },
          type: { type: "string", enum: ["payment", "final_purchase", "legal_checkbox", "price_increase", "identity", "unknown"] },
          label: { type: "string" },
          status: { type: "string", enum: ["missing", "satisfied", "blocked", "needs_user", "unknown"] },
          risk: { type: "string", enum: ["safe", "money", "payment", "legal", "uncertain"] },
          targetIds: { type: "array", items: { type: "string" } },
          evidence: { type: "array", items: { type: "string" } },
          confidence: { type: "number" }
        }
      }
    },
    currentSurface: {
      type: "object",
      additionalProperties: false,
      required: ["present", "type", "label", "taskHint", "targetIds", "summary"],
      properties: {
        present: { type: "boolean" },
        type: { type: "string", enum: ["page", "modal", "dropdown", "popover", "unknown"] },
        label: { type: "string" },
        taskHint: { type: "string" },
        targetIds: { type: "array", items: { type: "string" } },
        summary: { type: "string" }
      }
    },
    uncertainties: { type: "array", items: { type: "string" } },
    summary: { type: "string" }
  }
};

const verifierSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ok", "changed", "lastActionWorked", "blockers", "priceChanged", "riskChanged", "evidence", "confidence", "requirementUpdates"],
  properties: {
    ok: { type: "boolean" },
    changed: { type: "boolean" },
    lastActionWorked: { type: "boolean" },
    blockers: { type: "array", items: { type: "string" } },
    priceChanged: { type: "boolean" },
    riskChanged: { type: "boolean" },
    evidence: { type: "array", items: { type: "string" } },
    confidence: { type: "number" },
    requirementUpdates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["requirementId", "proposedStatus", "observationId", "evidence", "confidence"],
        properties: {
          requirementId: { type: "string" },
          proposedStatus: { type: "string", enum: ["missing", "satisfied", "blocked", "needs_user", "unknown", "conflicted"] },
          observationId: { type: "string" },
          evidence: {
            type: "object",
            additionalProperties: false,
            required: ["controlId", "selectedValue", "visibleText"],
            properties: {
              controlId: { type: "string" },
              selectedValue: { type: "string" },
              visibleText: { type: "string" }
            }
          },
          confidence: { type: "number" }
        }
      }
    }
  }
};

const plannerSchema = {
  type: "object",
  additionalProperties: false,
  required: ["type", "targetId", "targetLabel", "value", "x", "y", "visualRegion", "scrollY", "keys", "reason", "requirementId", "risk", "requiresApproval"],
  properties: {
    type: {
      type: "string",
      enum: [
        "click",
        "click_xy",
        "type",
        "select",
        "scroll",
        "keypress",
        "wait",
        "ask_user",
        "final_review",
        "stop"
      ]
    },
    targetId: { type: "string" },
    targetLabel: { type: "string" },
    value: { type: "string" },
    x: { type: "number" },
    y: { type: "number" },
    visualRegion: {
      type: "object",
      additionalProperties: false,
      required: ["x", "y", "width", "height", "centerX", "centerY", "viewportWidth", "viewportHeight", "surfaceId", "observationId", "controlId", "operation", "source", "confidence", "evidence"],
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        width: { type: "number" },
        height: { type: "number" },
        centerX: { type: "number" },
        centerY: { type: "number" },
        viewportWidth: { type: "number" },
        viewportHeight: { type: "number" },
        surfaceId: { type: "string" },
        observationId: { type: "string" },
        controlId: { type: "string" },
        operation: { type: "string" },
        source: { type: "string" },
        confidence: { type: "number" },
        evidence: { type: "string" }
      }
    },
    scrollY: { type: "number" },
    keys: { type: "string" },
    reason: { type: "string" },
    requirementId: { type: "string" },
    risk: { type: "string", enum: ["safe", "money", "payment", "legal", "uncertain"] },
    requiresApproval: { type: "boolean" }
  }
};

// Verify + plan combined into one call — they're one judgment ("given what
// just happened, what's next"), not two independent questions, and splitting
// them cost a full extra round-trip per turn for no accuracy benefit.
const verifyAndPlanSchema = {
  type: "object",
  additionalProperties: false,
  required: ["verification", "action"],
  properties: {
    verification: verifierSchema,
    action: {
      type: "object",
      additionalProperties: false,
      required: ["candidateId"],
      properties: {
        candidateId: { type: "string" }
      }
    }
  }
};

const candidateSelectionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["candidateId", "semanticOutcome"],
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
    }
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

function verifyAndPlanSchemaFor(candidateIds = []) {
  const ids = [...new Set((candidateIds || []).map(String).filter(Boolean))];
  return {
    ...verifyAndPlanSchema,
    properties: {
      ...verifyAndPlanSchema.properties,
      action: {
        ...verifyAndPlanSchema.properties.action,
        properties: {
          candidateId: ids.length
            ? { type: "string", enum: ids }
            : { type: "string" }
        }
      }
    }
  };
}

module.exports = {
  requirementSchema,
  requirementExtractorSchema,
  pageStateSchema,
  verifierSchema,
  plannerSchema,
  verifyAndPlanSchema,
  candidateSelectionSchema,
  candidateSelectionSchemaFor,
  verifyAndPlanSchemaFor
};
