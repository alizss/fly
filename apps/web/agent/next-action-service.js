const { withUpdate } = require("../../../packages/shared/agent-state");
const { canonicalizeUserPolicy } = require("./policy-profile");

function createNextActionService({
  agentLoop,
  agentSessionStore,
  compactAgentPayload,
  createAgentLoopFailure,
  dataDir,
  logAgent,
  model,
  openAiApiKey,
  recoveryModel
}) {
  async function decideAgentNextActionViaLoop(body) {
    const serverTurnStartedAt = Date.now();
    const compactionStartedAt = Date.now();
    const payload = compactAgentPayload(body);
    const requestCompactionMs = Date.now() - compactionStartedAt;
    if (!payload.sessionId) throw new Error("DURABLE_SESSION_REQUIRED");
    const sessionReadStartedAt = Date.now();
    let state = agentSessionStore.getSession(payload.sessionId);
    const sessionReadMs = Date.now() - sessionReadStartedAt;
    if (!state) throw new Error("DURABLE_SESSION_NOT_FOUND");
    const previousObservationReadStartedAt = Date.now();
    const previousObservation = state.currentObservationId
      ? agentSessionStore.getObservation(state.id, state.currentObservationId)
      : null;
    const previousObservationReadMs = Date.now() - previousObservationReadStartedAt;
    // A full-page navigation creates a new content-script document, so the
    // request may not carry the result reported by the previous document. The
    // governed-action ledger is the durable execution authority: reattach only
    // the result matching the currently leased action, never arbitrary history.
    const durablePendingActionResult = payload.lastActionResult
      ? null
      : agentSessionStore.getPendingActionResult(state);
    const browserActionResult = payload.lastActionResult || durablePendingActionResult || null;
    const governedResultAction = browserActionResult?.actionId
      ? agentSessionStore.getGovernedAction(browserActionResult.actionId)?.action || null
      : null;
    // Browser receipts own only the local causal outcome. The durable ledger
    // owns the leased action and its expected contract, so hydrate that
    // metadata server-side instead of asking every page to transport another
    // copy of targets, options, pipelines, and semantic lineage.
    const hydratedActionResult = browserActionResult && governedResultAction
      ? {
          ...browserActionResult,
          action: governedResultAction,
          expectedOutcome: governedResultAction.pipelineContract?.expectedOutcome
            || governedResultAction.expectedOutcome
            || null
        }
      : browserActionResult;
  
    const observation = {
      observationId: payload.observationId,
      observationSnapshot: payload.observationSnapshot,
      observationUpdate: payload.observationUpdate,
      destinationReadiness: payload.destinationReadiness,
      userIntent: payload.userIntent,
      page: payload.page,
      lastActionResult: hydratedActionResult
    };
  
    // The loop owns the single authoritative state commit for this turn. The
    // immutable observation row is recorded first so governance can reference
    // it, but recording it must not rewrite the full transaction state.
    const observationWriteStartedAt = Date.now();
    agentSessionStore.recordObservation(state.id, observation, { updateSession: false });
    const observationWriteMs = Date.now() - observationWriteStartedAt;
    // Previous browser evidence is read from the durable ledger and attached
    // only for this turn. It is not nested into the newly persisted observation.
    observation.previousObservation = previousObservation;
    state = withUpdate(state, {
      currentObservationId: payload.observationId,
      currentObservationHash: payload.observationSnapshot?.snapshotHash || payload.page?.snapshotHash || "",
      site: {
        ...(state.site || {}),
        host: String(payload.page?.site || state.site?.host || ""),
        url: String(payload.page?.url || state.site?.url || "")
      },
      userIntent: payload.userIntent || state.userIntent || state.goal,
      travelerIds: [payload.traveler?.id || state.travelerId].filter(Boolean),
      userPolicy: canonicalizeUserPolicy({
        bookingRules: payload.traveler?.booking_rules || state.userPolicy?.bookingRules || state.policySnapshot?.bookingRules || "",
        baggagePreference: payload.traveler?.baggage_preference || state.userPolicy?.baggagePreference || state.policySnapshot?.baggagePreference || "",
        paymentPreference: payload.traveler?.payment_preference || state.userPolicy?.paymentPreference || state.policySnapshot?.paymentPreference || ""
      }, {
        ...payload.traveler,
        seatPolicy: payload.traveler?.seat_policy
          || state.userPolicy?.seatPolicy
          || state.policySnapshot?.seatPolicy,
        preferred_seat: payload.traveler?.preferred_seat
          || state.userPolicy?.preferredSeat
          || state.policySnapshot?.preferredSeat
      }),
      approvals: {
        ...(state.approvals || {}),
        skipPaidExtrasApproved: Boolean(payload.approvalState?.skipPaidExtrasApproved || state.approvals?.skipPaidExtrasApproved),
        paymentAuthorization: payload.approvalState?.paymentAuthorization || state.approvals?.paymentAuthorization || null,
        priceAuthorization: payload.approvalState?.priceAuthorization || state.approvals?.priceAuthorization || null
      }
    });
  
    logAgent("loop turn start", { clientTurnId: payload.clientTurnId, observationId: payload.observationId, sessionId: state.id, site: payload.page?.site, step: payload.page?.step || state.taskState?.stage || "unknown", stallCount: state.stallCount || 0 });
  
    try {
      const loopStartedAt = Date.now();
      const { state: nextState, clientDecision, debug } = await agentLoop.runLoopTurn({
        apiKey: openAiApiKey,
        model,
        recoveryModel,
        dataDir,
        state,
        observation,
        traveler: payload.traveler,
        userMessage: payload.userMessage,
        userResponse: payload.userResponse,
        transactionStore: agentSessionStore,
        clientTurnId: payload.clientTurnId
      });
      const loopMs = Date.now() - loopStartedAt;
      const serverLatency = {
        ...(debug?.latency || {}),
        server_request_compaction_ms: requestCompactionMs,
        server_session_read_ms: sessionReadMs,
        server_previous_observation_read_ms: previousObservationReadMs,
        server_observation_write_ms: observationWriteMs,
        server_loop_ms: loopMs,
        server_turn_total_ms: Date.now() - serverTurnStartedAt
      };
      const latency = serverLatency;
      const modelUsage = debug?.modelUsage || {};
      logAgent("loop turn decision", {
        sessionId: nextState.id,
        clientTurnId: payload.clientTurnId,
        observationId: payload.observationId,
        actionId: clientDecision.actionId || "",
        intent: clientDecision.intent || "",
        requirementId: clientDecision.requirementId || "",
        decisionGroupId: clientDecision.decisionGroupId || clientDecision.targetSnapshot?.decisionGroupId || "",
        action: clientDecision.action,
        target: clientDecision.targetLabel || clientDecision.value || clientDecision.targetId || "",
        targetKind: clientDecision.targetSnapshot?.kind || "",
        targetSource: clientDecision.targetSnapshot?.source || "",
        expectedOutcome: clientDecision.expectedOutcome?.type || "",
        risk: clientDecision.risk || "",
        stallCount: nextState.stallCount || 0,
        requirementsMissing: (nextState.taskState?.activeDecisions || []).filter((decision) => decision.required === true).length
          + (nextState.taskState?.validationBlockers || []).length,
        missing: (debug?.missing || []).map((item) => item.label).slice(0, 4),
        nav: (debug?.navigation || []).map((item) => `${item.action}:${item.label}:${item.enabled ? "on" : "off"}:${item.risk}`).slice(0, 5),
        riskGates: (debug?.riskGates || []).map((item) => `${item.type}:${item.label}:${item.status}:${item.risk}`).slice(0, 4),
        deterministic: Boolean(debug?.deterministic),
        classification_model_ms: latency.classification_model_ms ?? null,
        verify_plan_model_ms: latency.verify_plan_model_ms ?? null,
        policy_ms: latency.policy_ms ?? null,
        semantic_compile_ms: latency.semantic_compile_ms ?? null,
        task_state_ms: latency.task_state_ms ?? null,
        trace_write_ms: latency.trace_write_ms ?? null,
        final_state_persist_ms: latency.final_state_persist_ms ?? null,
        turn_total_ms: latency.turn_total_ms ?? null,
        server_request_compaction_ms: latency.server_request_compaction_ms,
        server_session_read_ms: latency.server_session_read_ms,
        server_previous_observation_read_ms: latency.server_previous_observation_read_ms,
        server_observation_write_ms: latency.server_observation_write_ms,
        server_loop_ms: latency.server_loop_ms,
        server_turn_total_ms: latency.server_turn_total_ms,
        input_tokens: modelUsage.input_tokens ?? null,
        output_tokens: modelUsage.output_tokens ?? null,
        model: modelUsage.model || model,
        reason: debug?.final?.reason || clientDecision.reason || ""
      });
      return {
        ...clientDecision,
        sessionId: nextState.id,
        debug: { ...(debug || {}), latency: serverLatency }
      };
    } catch (error) {
      const failure = createAgentLoopFailure(error, state.id);
      logAgent("loop turn ERROR", {
        sessionId: state.id,
        failureCode: failure.failureCode,
        message: failure.message
      });
      throw failure;
    }
  }
  

  return { decideAgentNextActionViaLoop };
}

module.exports = { createNextActionService };
