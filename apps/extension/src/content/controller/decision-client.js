export function createDecisionClient({
  DEFAULT_API,
  agent,
  captureVisibleScreenshot,
  clearDestinationWait,
  compactActionResultForTransport,
  compactPageMap,
  compactText,
  emptyPageStateDiff,
  isDestinationReadinessDecision,
  logAgentEvent,
  logFlow,
  mapObservationSnapshot,
  nextFlowId,
  observationHashForMap,
  observationNeedsScreenshot,
  pageSnapshot,
  plannerRequestIsCurrent,
  postObservationWithSizeRecovery,
  prepareScreenshotAnnotations,
  renderSidebar,
  setAgentActivity,
  shouldAutoDeclinePaidExtras,
  stableHash,
  storageGet,
  traveler,
  uploadObservationScreenshot,
  userIntentText
}) {
  function decisionFromActionLease(rawDecision = {}) {
    const lease = rawDecision.actionLease || null;
    if (lease?.contractVersion !== "action-lease/v1") return rawDecision;
    const operation = String(lease.mechanic?.operation || "");
    const semanticEffect = String(lease.expected?.semanticEffect || "");
    const actionType = String(lease.mechanic?.actionType || rawDecision.action || "stop");
    const interactionRole = ["choose", "select"].includes(operation)
      ? "choice"
      : operation === "open"
        ? "opener"
        : ["type", "select"].includes(actionType)
          ? "field"
          : /advance|navigate/.test(semanticEffect)
            ? "navigation"
            : "command";
    const successCondition = lease.expected?.successCondition || null;
    return {
      ...rawDecision,
      actionId: lease.actionId || rawDecision.actionId || "",
      observationId: lease.observation?.id || "",
      observationHash: lease.observation?.hash || "",
      action: actionType,
      intent: String(lease.expected?.objective || semanticEffect || actionType),
      operation,
      mechanicalEffect: String(lease.mechanic?.effect || operation),
      physicalEffect: String(lease.mechanic?.effect || operation),
      interactionRole,
      semanticEffect,
      expectedEvidence: String(successCondition?.type || ""),
      semanticIntent: semanticEffect,
      expectedPostconditions: successCondition ? [successCondition] : [],
      goalId: lease.obligationId || "",
      governorDecisionId: lease.governorDecisionId || "",
      semanticOwner: lease.semanticOwner || null,
      semanticOwnerId: lease.semanticOwnerId || "",
      decisionInstanceId: lease.semanticOwner?.repeatedInstance || "",
      candidateId: lease.candidateId || "",
      logicalControlId: lease.target?.controlId || "",
      controlId: lease.target?.controlId || "",
      actuatorId: lease.target?.actuatorId || "",
      targetId: lease.target?.actuatorId || "",
      targetSnapshot: null,
      decisionGroupId: String(
        successCondition?.decisionGroupId
        || successCondition?.parentDecisionGroupId
        || ""
      ),
      expectedOutcome: successCondition,
      affordance: null,
      pipelineContract: lease.capabilityProof || null,
      interactionMethod: lease.mechanic?.method || "",
      boundedRecovery: lease.mechanic?.boundedRecovery === true,
      exactOption: lease.mechanic?.exactOption || null,
      value: lease.mechanic?.value || "",
      keys: lease.mechanic?.keys || "",
      x: lease.mechanic?.x,
      y: lease.mechanic?.y,
      scrollY: lease.mechanic?.scrollY,
      visualRegion: lease.mechanic?.visualRegion || null,
      risk: lease.risk || rawDecision.risk || "uncertain"
    };
  }

  async function requestAgentDecision(map, userMessage = "", clientLatency = {}, loopToken = {}, userResponse = null) {
    const turnId = nextFlowId("turn");
    const observationId = nextFlowId("obs");
    const materialHash = observationHashForMap(map);
    const feedbackKey = stableHash(JSON.stringify({
      actionId: agent.lastActionResult?.actionId || "",
      code: agent.lastActionResult?.code || agent.lastActionResult?.failureCode || "",
      verified: agent.lastActionResult?.verified,
      postconditionSatisfied: agent.lastActionResult?.postconditionSatisfied
    }));
    const destinationReadinessRetry = Boolean(
      agent.destinationWait?.status === "WAITING_FOR_DESTINATION"
    );
    const reobserveRetryToken = String(agent.destinationWait?.retryToken || "");
    const retryTokenAvailable = Boolean(
      destinationReadinessRetry
      && reobserveRetryToken
      && !agent.honoredReobserveRetryTokens.has(reobserveRetryToken)
    );
    const unchangedObservation = Boolean(
      agent.lastSentMaterialHash === materialHash
      && agent.lastSentFeedbackKey === feedbackKey
    );
    const referenceRetryAuthorized = Boolean(retryTokenAvailable && unchangedObservation);
    if (
      !userMessage
      && !destinationReadinessRetry
      && agent.lastSentMaterialHash === materialHash
      && agent.lastSentFeedbackKey === feedbackKey
    ) {
      logFlow("backend.request.unchanged_material_suppressed", {
        materialHash,
        feedbackKey,
        mutationDiff: clientLatency.observation_diff || emptyPageStateDiff()
      });
      setAgentActivity(
        "Waiting for page changes",
        "The checkout state is unchanged. I will resume when the page exposes new actionable state."
      );
      renderSidebar("agent");
      return null;
    }
    if (
      destinationReadinessRetry
      && !userMessage
      && unchangedObservation
      && agent.destinationWait.deadlineObservationSent !== true
      && !referenceRetryAuthorized
    ) {
      logFlow("backend.request.unchanged_readiness_retry_suppressed", {
        materialHash,
        feedbackKey,
        attempts: agent.destinationWait.attempts,
        elapsedMs: Date.now() - agent.destinationWait.startedAt
      });
      setAgentActivity(
        "Waiting for page changes",
        "The checkout state is unchanged. I will resume on a material page mutation or at the readiness deadline."
      );
      renderSidebar("agent");
      return null;
    }
    if (agent.activePlannerRequest) {
      logFlow("backend.request.duplicate_suppressed", {
        turnId,
        observationId,
        activeTurnId: agent.activePlannerRequest.turnId,
        activeObservationId: agent.activePlannerRequest.observationId
      });
      agent.loopRerunQueued = true;
      return null;
    }
    const request = {
      turnId,
      observationId,
      loopRunId: loopToken.loopRunId || agent.activeLoopRunId,
      lifecycleId: loopToken.lifecycleId ?? agent.lifecycleId,
      controller: new AbortController()
    };
    agent.activePlannerRequest = request;
    agent.activeTurnId = turnId;
    agent.activeObservationId = observationId;
    const observationSnapshot = mapObservationSnapshot(map);
    const lastActionForTransport = compactActionResultForTransport(
      agent.lastActionResult || agent.actionHistory[agent.actionHistory.length - 1] || null
    );
    logAgentEvent("agent_request", {
      turnId,
      observationId,
      userMessage: userMessage ? "[provided]" : "",
      step: map.step,
      summary: map.summary,
      errors: map.errors,
      paidChoices: map.paidChoices
    });
	    logFlow("backend.request.prepare", {
	      turnId,
	      observationId,
	      userMessage: Boolean(userMessage),
	      observation: observationSnapshot,
	      page: pageSnapshot("before-backend"),
	      lastAction: lastActionForTransport
    });
    try {
      const settings = await storageGet(["apiBase"]);
      const screenshotRequired = observationNeedsScreenshot(map);
      const screenshotAnnotations = screenshotRequired ? prepareScreenshotAnnotations(map, observationId) : [];
      const screenshotStartedAt = performance.now();
      const screenshotCacheKey = `${map.currentSurface?.id || "surface-page"}:${materialHash}`;
      let screenshotDataUrl = screenshotRequired ? agent.screenshotCache.get(screenshotCacheKey) || "" : "";
      const screenshotCacheHit = Boolean(screenshotDataUrl);
      if (screenshotRequired && !screenshotDataUrl) {
        screenshotDataUrl = await captureVisibleScreenshot(screenshotAnnotations);
        if (screenshotDataUrl) {
          agent.screenshotCache.set(screenshotCacheKey, screenshotDataUrl);
          while (agent.screenshotCache.size > 3) agent.screenshotCache.delete(agent.screenshotCache.keys().next().value);
        }
      }
      const screenshotCaptureMs = Math.round(performance.now() - screenshotStartedAt);
      const apiBase = settings.apiBase || DEFAULT_API;
      const screenshotId = await uploadObservationScreenshot(apiBase, {
        sessionId: agent.sessionId,
        observationId,
        screenshotDataUrl,
        signal: request.controller.signal
      });
      logFlow("backend.request.send", {
        turnId,
        api: `${settings.apiBase || DEFAULT_API}/agent/next-action`,
        screenshotBytes: screenshotDataUrl.length,
        screenshotRequired,
        screenshotCacheHit,
        screenshotAnnotations: screenshotAnnotations.length,
        observation_build_ms: clientLatency.observation_build_ms ?? null,
        observationMode: clientLatency.observation_mode || "full_snapshot",
        screenshot_capture_ms: screenshotCaptureMs,
        currentSurface: map.currentSurface ? {
          type: map.currentSurface.type,
          taskHint: map.currentSurface.taskHint,
          options: (map.currentSurface.options || []).map((option) => ({
            id: option.id,
            label: compactText(option.label, 100),
            risk: option.risk,
            semantic: option.semantic,
            selected: Boolean(option.selected),
            box: option.box
          })).slice(0, 12)
        } : null
      });
      const requestStartedAt = performance.now();
      const canonicalPage = compactPageMap(map, observationId);
      const observationMode = referenceRetryAuthorized
        ? "reference"
        : clientLatency.observation_mode || "full_snapshot";
      const observationPayload = {
        sessionId: agent.sessionId,
        clientTurnId: turnId,
        observationId,
        observationSnapshot,
        observationUpdate: {
          mode: observationMode,
          baseSnapshotHash: referenceRetryAuthorized
            ? materialHash
            : clientLatency.base_snapshot_hash || "",
          snapshotHash: materialHash,
          diff: clientLatency.observation_diff || emptyPageStateDiff()
        },
        userIntent: userIntentText(),
        userMessage,
        userResponse,
        traveler: traveler(),
        destinationReadiness: agent.destinationWait ? {
          status: agent.destinationWait.status,
          startedAt: agent.destinationWait.startedAt,
          deadlineAt: agent.destinationWait.deadlineAt,
          attempts: agent.destinationWait.attempts,
          backendWaits: agent.destinationWait.backendWaits,
          deadlineObservationSent: agent.destinationWait.deadlineObservationSent,
          retryToken: agent.destinationWait.retryToken || ""
        } : null,
	      approvalState: {
	        skipPaidExtrasApproved: shouldAutoDeclinePaidExtras(),
	        paymentApproved: false
	      },
        // Best-effort context for the backend verifier — it independently judges
        // whether the last action actually worked from fresh browser evidence.
	      lastActionResult: lastActionForTransport,
        page: {
          ...canonicalPage,
          screenshotId,
          screenshotAnnotations: screenshotAnnotations.map((annotation) => ({
            visualRef: annotation.visualRef || "",
            controlId: annotation.controlId || "",
            decisionGroupId: annotation.decisionGroupId || "",
            box: annotation.box || null
          }))
        }
      };
      const transport = await postObservationWithSizeRecovery(apiBase, observationPayload, request.controller.signal);
      const response = transport.response;
      const decision = decisionFromActionLease(await response.json());
      if (!agent.sessionId || !decision.sessionId || decision.sessionId !== agent.sessionId) {
        throw new Error("backend did not preserve the active durable checkout session");
      }
      if (!plannerRequestIsCurrent(request)) {
        logFlow("backend.response.stale_ignored", {
          turnId,
          observationId,
          decisionObservationId: decision.observationId || "",
          decisionActionId: decision.actionId || decision.id || "",
          activeTurnId: agent.activePlannerRequest?.turnId || "",
          activeObservationId: agent.activePlannerRequest?.observationId || "",
          lifecycleId: agent.lifecycleId,
          requestLifecycleId: request.lifecycleId
        });
        return null;
      }
      agent.lastSentMaterialHash = materialHash;
      agent.lastSentFeedbackKey = feedbackKey;
      if (referenceRetryAuthorized) {
        agent.honoredReobserveRetryTokens.add(reobserveRetryToken);
      }
      const requestUploadMs = Math.round(performance.now() - requestStartedAt);
      logFlow("backend.request.transport", {
        turnId,
        observationId,
        screenshotId,
        observationBytes: transport.bytes,
        transportMode: transport.transportMode
      });
      agent.lastBackendDebug = decision.debug || null;
      const diagnosticTaskState = decision.debug?.taskState || null;
      const processAwareness = decision.debug?.processAwareness
        || diagnosticTaskState?.processAwareness
        || null;
      const transactionReview = decision.debug?.transactionReview
        || diagnosticTaskState?.transactionReview
        || null;
      agent.processDiagnostics = processAwareness || transactionReview ? {
        processAwareness,
        transactionReview,
        updatedAt: Date.now()
      } : agent.processDiagnostics;
      const backendLatency = decision.debug?.latency || {};
      const modelUsage = decision.debug?.modelUsage || {};
      logAgentEvent("agent_decision", {
        turnId,
        actionId: decision.actionId || decision.id || "",
        observationId: decision.observationId || "",
        source: decision.source,
        action: decision.action,
        intent: decision.intent || "",
        requirementId: decision.requirementId || "",
        decisionGroupId: decision.decisionGroupId || decision.targetSnapshot?.decisionGroupId || "",
        targetId: decision.targetId,
        targetLabel: decision.targetLabel,
        targetSnapshot: decision.targetSnapshot || null,
        expectedOutcome: decision.expectedOutcome || null,
        risk: decision.risk,
        needsApproval: decision.needsApproval,
        message: decision.message,
        reason: decision.reason,
        debug: decision.debug || null
      });
      logFlow("latency.spans", {
        turnId,
        observationId,
        observation_build_ms: clientLatency.observation_build_ms ?? null,
        screenshot_capture_ms: screenshotCaptureMs,
        request_upload_ms: requestUploadMs,
        classification_model_ms: backendLatency.classification_model_ms ?? null,
        verify_plan_model_ms: backendLatency.verify_plan_model_ms ?? null,
        policy_ms: backendLatency.policy_ms ?? null,
        semantic_compile_ms: backendLatency.semantic_compile_ms ?? null,
        task_state_ms: backendLatency.task_state_ms ?? null,
        trace_write_ms: backendLatency.trace_write_ms ?? null,
        final_state_persist_ms: backendLatency.final_state_persist_ms ?? null,
        turn_total_ms: backendLatency.turn_total_ms ?? null,
        input_tokens: modelUsage.input_tokens ?? null,
        output_tokens: modelUsage.output_tokens ?? null,
        model: modelUsage.model || "",
        action: decision.action || "",
        actionId: decision.actionId || decision.id || ""
      });
      logFlow("backend.response", {
        turnId,
        observation_build_ms: clientLatency.observation_build_ms ?? null,
        screenshot_capture_ms: screenshotCaptureMs,
        request_upload_ms: requestUploadMs,
        classification_model_ms: backendLatency.classification_model_ms ?? null,
        verify_plan_model_ms: backendLatency.verify_plan_model_ms ?? null,
        policy_ms: backendLatency.policy_ms ?? null,
        semantic_compile_ms: backendLatency.semantic_compile_ms ?? null,
        task_state_ms: backendLatency.task_state_ms ?? null,
        trace_write_ms: backendLatency.trace_write_ms ?? null,
        final_state_persist_ms: backendLatency.final_state_persist_ms ?? null,
        turn_total_ms: backendLatency.turn_total_ms ?? null,
        input_tokens: modelUsage.input_tokens ?? null,
        output_tokens: modelUsage.output_tokens ?? null,
        model: modelUsage.model || "",
        decision: {
          source: decision.source,
          actionId: decision.actionId || decision.id || "",
          observationId: decision.observationId || "",
          action: decision.action,
          intent: decision.intent || "",
          requirementId: decision.requirementId || "",
          decisionGroupId: decision.decisionGroupId || decision.targetSnapshot?.decisionGroupId || "",
          targetId: decision.targetId,
          targetLabel: decision.targetLabel,
          targetSnapshot: decision.targetSnapshot || null,
          expectedOutcome: decision.expectedOutcome || null,
          value: decision.value,
          x: decision.x,
          y: decision.y,
          risk: decision.risk,
          needsApproval: decision.needsApproval,
          reason: decision.reason
        },
        backendDebug: decision.debug || null
      });
      if (agent.destinationWait && !isDestinationReadinessDecision(decision)) {
        clearDestinationWait("semantic_destination_ready");
      }
      return decision;
    } catch (error) {
      if (error?.name === "AbortError" || request.controller.signal.aborted) {
        logFlow("backend.request.aborted", {
          turnId,
          observationId,
          reason: String(request.controller.signal.reason || error.message || "aborted")
        });
        return null;
      }
      if (error?.code === "OBSERVATION_TOO_LARGE" && error.retryable === true) {
        logFlow("backend.observation_too_large_blocked", {
          turnId,
          observationId,
          code: error.code,
          reason: error.message
        });
        setAgentActivity("Blocked", "The compact browser payload is still oversized. Automatic retries were stopped.");
      }
      const contextInvalidated = /extension context invalidated|context invalidated|receiving end does not exist/i.test(error.message || "");
      const backendFailure = ["AGENT_LOOP_FAILED", "BACKEND_INTERNAL_ERROR"].includes(error?.code)
        || /^HTTP_5\d\d$/.test(error?.code || "");
      const oversizedObservation = error?.code === "OBSERVATION_TOO_LARGE";
      const decision = {
        source: "system",
        action: "stop",
        fatalBackendFailure: backendFailure,
        targetId: "",
        value: "",
        message: contextInvalidated
          ? "Chrome invalidated the extension context after reload. Refresh this checkout tab, then start the agent again."
          : oversizedObservation
            ? "The checkout observation remained too large after compact recovery. I stopped instead of retrying indefinitely."
          : backendFailure
            ? `Agent backend error${error.failureCode ? ` (${error.failureCode})` : ""}: ${error.message}. No browser action was dispatched.`
          : `AI agent unavailable: ${error.message}. I stopped because AI-only mode is enabled.`,
        needsApproval: !backendFailure,
        risk: backendFailure ? "system" : "uncertain",
        reason: contextInvalidated
          ? "Extension lifecycle error: this page is still running the old content script after extension reload."
          : oversizedObservation
            ? "Observation transport circuit breaker: compact recovery was exhausted."
          : backendFailure
            ? "The backend failed while processing the current observation; this is separate from AI service availability."
          : "AI-only mode: backend/OpenAI must provide the next action."
      };
      logAgentEvent("agent_decision", {
        turnId,
        actionId: decision.actionId || decision.id || "",
        observationId: decision.observationId || observationId,
        source: decision.source,
        action: decision.action,
        intent: decision.intent || "",
        requirementId: decision.requirementId || "",
        decisionGroupId: decision.decisionGroupId || decision.targetSnapshot?.decisionGroupId || "",
        targetId: decision.targetId,
        targetSnapshot: decision.targetSnapshot || null,
        expectedOutcome: decision.expectedOutcome || null,
        risk: decision.risk,
        needsApproval: decision.needsApproval,
        message: decision.message,
        reason: decision.reason
      });
      logFlow(
        contextInvalidated
          ? "extension.context_invalidated"
          : oversizedObservation
            ? "backend.observation_too_large_stopped"
            : backendFailure
              ? "backend.processing_error"
              : "backend.error",
        { turnId, error: error.message, code: error.code || "", decision }
      );
      return decision;
    } finally {
      if (agent.activePlannerRequest === request) agent.activePlannerRequest = null;
    }
  }


  return {
    decisionFromActionLease,
    requestAgentDecision
  };
}
