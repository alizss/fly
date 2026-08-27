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

  function compactValidationIssue(issue = {}, index = 0) {
    if (typeof issue === "string") {
      return {
        issueId: `browser-validation-${index + 1}`,
        message: compactText(issue, 240)
      };
    }
    return {
      issueId: String(issue.issueId || `browser-validation-${index + 1}`),
      controlId: String(issue.controlId || ""),
      ownerId: String(issue.ownerId || ""),
      code: String(issue.code || ""),
      message: compactText(issue.message || issue.label || "", 240)
    };
  }

  function compactCanonicalOutcome(outcome = {}, result = {}) {
    const evidence = outcome.observedEvidence && typeof outcome.observedEvidence === "object"
      ? outcome.observedEvidence
      : {};
    return {
      contractVersion: String(outcome.contractVersion || "action-outcome/v1"),
      status: String(outcome.status || "NO_RESULT"),
      causedByActionId: String(outcome.causedByActionId || result.actionId || ""),
      exactPostconditionSatisfied: outcome.exactPostconditionSatisfied === true,
      code: String(outcome.code || result.failureCode || ""),
      observedEvidence: {
        beforeObservationHash: String(evidence.beforeObservationHash || ""),
        afterObservationHash: String(evidence.afterObservationHash || result.resultObservationHash || ""),
        mechanicalEffect: compactText(evidence.mechanicalEffect || result.mechanicalEffect || "", 160),
        actualNormalizedValue: compactText(evidence.actualNormalizedValue || "", 240),
        wantedNormalizedValue: compactText(evidence.wantedNormalizedValue || "", 240),
        actualSemanticValue: compactText(evidence.actualSemanticValue || "", 240),
        wantedSemanticValue: compactText(evidence.wantedSemanticValue || "", 240),
        interactionKind: String(evidence.interactionKind || ""),
        commitRequirement: String(evidence.commitRequirement || ""),
        exactObservedOption: evidence.exactObservedOption === true,
        activeChoiceSurface: evidence.activeChoiceSurface === true,
        commitSettled: evidence.commitSettled === true
      },
      introducedValidation: (outcome.introducedValidation || [])
        .slice(0, 8)
        .map(compactValidationIssue),
      candidateOwnerControlIds: (outcome.candidateOwnerControlIds || [])
        .map((value) => String(value || ""))
        .filter(Boolean)
        .slice(0, 8),
      changes: {
        surfaceChanged: outcome.changes?.surfaceChanged === true,
        urlChanged: outcome.changes?.urlChanged === true,
        progressChanged: outcome.changes?.progressChanged === true,
        priceChanged: outcome.changes?.priceChanged === true,
        transactionChanged: outcome.changes?.transactionChanged === true
      },
      repeatProhibited: outcome.repeatProhibited === true
    };
  }

  function compactFeedback(feedback = {}) {
    return {
      dispatched: feedback.dispatched === true,
      dispatchSucceeded: feedback.dispatchSucceeded === true,
      targetFound: feedback.targetFound !== false,
      targetReacted: feedback.targetReacted === true,
      selectionChanged: feedback.selectionChanged === true,
      surfaceChanged: feedback.surfaceChanged === true,
      progressChanged: feedback.progressChanged === true,
      domChanged: feedback.domChanged === true,
      visualChanged: feedback.visualChanged === true,
      navigationOccurred: feedback.navigationOccurred === true,
      validationAppeared: feedback.validationAppeared === true,
      priceChanged: feedback.priceChanged === true,
      outcomeVerified: feedback.outcomeVerified === true
    };
  }

  function minimalActionResultForTransport(result = {}) {
    const outcome = result.outcome && typeof result.outcome === "object" ? result.outcome : {};
    const choiceCommit = compactChoiceCommitEvidence(outcome.evidence?.choiceCommit || null);
    const exactChildSettlement = compactActionTransportValue(
      outcome.evidence?.exactChildSettlement || null
    );
    return {
      at: result.at || "",
      type: String(result.type || ""),
      userActionRequired: result.userActionRequired === true,
      actionId: String(result.actionId || ""),
      observationId: String(result.observationId || ""),
      plannedObservationId: String(result.plannedObservationId || ""),
      observationHash: String(result.observationHash || ""),
      resultObservationHash: String(result.resultObservationHash || ""),
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
      actionOutcome: compactCanonicalOutcome(result.actionOutcome || {}, result),
      failureCode: String(result.failureCode || ""),
      outcome: {
        ok: outcome.ok === true,
        code: String(outcome.code || result.failureCode || ""),
        message: compactText(outcome.message || "", 600),
        feedback: compactFeedback(outcome.feedback || result.feedback || {}),
        evidence: {
          ...(choiceCommit ? { choiceCommit } : {}),
          ...(exactChildSettlement ? { exactChildSettlement } : {})
        }
      }
    };
  }

  function compactActionResultForTransport(result = null) {
    if (!result || typeof result !== "object") return null;
    // The durable governed-action ledger already owns the complete action,
    // actuator, expected contract, and semantic lineage.  The browser sends
    // only its exact causal receipt and the backend joins it to that lease by
    // actionId.  Re-sending target snapshots, pipelines, or hundreds of
    // observed options creates a second contract copy and can exceed browser
    // keepalive quotas on ordinary country/nationality selectors.
    const compact = minimalActionResultForTransport(result);
    if (observationTransportBytes(compact) > MAX_ACTION_RESULT_TRANSPORT_BYTES) {
      throw new Error("Canonical action-result receipt exceeds its transport budget.");
    }
    return compact;
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
