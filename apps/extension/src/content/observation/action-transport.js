const MAX_ACTION_RESULT_TRANSPORT_BYTES = 16_000;
const OMITTED_ACTION_TRANSPORT_KEYS = new Set([
  "map",
  "page",
  "beforeMap",
  "afterMap",
  "observation",
  "fullText",
  "html",
  "innerHTML",
  "outerHTML",
  "screenshot",
  "screenshotDataUrl"
]);

export function createActionTransport({ compactText, compactChoiceCommitEvidence }) {
  function observationTransportBytes(payload = {}) {
    return new Blob([JSON.stringify(payload)]).size;
  }

  function compactActionTransportValue(value, depth = 0, seen = new WeakSet()) {
    if (value == null || typeof value === "boolean" || typeof value === "number") return value;
    if (typeof value === "string") return compactText(value, 2_000);
    if (typeof value !== "object" || depth >= 7) return undefined;
    if (seen.has(value)) return undefined;
    seen.add(value);
    if (Array.isArray(value)) {
      return value
        .slice(0, 60)
        .map((item) => compactActionTransportValue(item, depth + 1, seen))
        .filter((item) => item !== undefined);
    }
    const compact = {};
    for (const [key, item] of Object.entries(value).slice(0, 120)) {
      if (OMITTED_ACTION_TRANSPORT_KEYS.has(key)) continue;
      const next = compactActionTransportValue(item, depth + 1, seen);
      if (next !== undefined) compact[key] = next;
    }
    return compact;
  }

  function minimalActionResultForTransport(result = {}) {
    const outcome = result.outcome && typeof result.outcome === "object" ? result.outcome : {};
    const choiceCommit = compactChoiceCommitEvidence(outcome.evidence?.choiceCommit || null);
    const exactChildSettlement = compactActionTransportValue(
      outcome.evidence?.exactChildSettlement || null
    );
    return {
      at: result.at || "",
      actionId: String(result.actionId || ""),
      observationId: String(result.observationId || ""),
      plannedObservationId: String(result.plannedObservationId || ""),
      observationHash: String(result.observationHash || ""),
      resultObservationHash: String(result.resultObservationHash || ""),
      requirementId: String(result.requirementId || ""),
      intent: compactText(result.intent || "", 500),
      semanticIntent: compactText(result.semanticIntent || "", 500),
      mechanicalEffect: compactText(result.mechanicalEffect || "", 500),
      operation: String(result.operation || ""),
      goalId: String(result.goalId || ""),
      semanticOwner: compactActionTransportValue(result.semanticOwner || null),
      semanticOwnerId: String(result.semanticOwnerId || ""),
      decisionInstanceId: String(result.decisionInstanceId || ""),
      candidateId: String(result.candidateId || ""),
      controlId: String(result.controlId || ""),
      dispatched: result.dispatched === true,
      targetResolved: result.targetResolved === true,
      clickReachedPage: result.clickReachedPage === true,
      pageChanged: result.pageChanged === true,
      activeSurfaceChanged: result.activeSurfaceChanged === true,
      expectedOutcomeObserved: result.expectedOutcomeObserved === true,
      postconditionSatisfied: result.postconditionSatisfied === true,
      executed: result.executed === true,
      verified: result.verified === true,
      superseded: result.superseded === true,
      actionOutcome: compactActionTransportValue(result.actionOutcome || null),
      failureCode: String(result.failureCode || ""),
      action: compactActionTransportValue(result.action || {}),
      targetSnapshot: compactActionTransportValue(result.targetSnapshot || {}),
      expectedOutcome: compactActionTransportValue(result.expectedOutcome || {}),
      outcome: {
        ok: outcome.ok === true,
        code: String(outcome.code || result.failureCode || ""),
        message: compactText(outcome.message || "", 600),
        feedback: compactActionTransportValue(outcome.feedback || {}),
        evidence: {
          ...(choiceCommit ? { choiceCommit } : {}),
          ...(exactChildSettlement ? { exactChildSettlement } : {})
        }
      }
    };
  }

  function compactActionResultForTransport(result = null) {
    if (!result || typeof result !== "object") return null;
    const compact = compactActionTransportValue(result);
    if (observationTransportBytes(compact) <= MAX_ACTION_RESULT_TRANSPORT_BYTES) return compact;
    return minimalActionResultForTransport(result);
  }

  function compactObservationActionContext(payload = {}) {
    const { actionHistory: _retiredActionHistory, ...canonicalPayload } = payload;
    return {
      ...canonicalPayload,
      lastActionResult: compactActionResultForTransport(payload.lastActionResult)
    };
  }

  return Object.freeze({
    observationTransportBytes,
    compactActionTransportValue,
    minimalActionResultForTransport,
    compactActionResultForTransport,
    compactObservationActionContext
  });
}
