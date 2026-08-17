const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const { createCheckoutSessionState, withUpdate } = require("../../../packages/shared/agent-state");
const {
  actionSignature,
  createActionLease
} = require("../../../packages/shared/agent-actions");
const { executionEpisodeFor, normalizeExecutionEpisode } = require("./execution-episode");

const LEGACY_REPLAY_DB_PATH = path.resolve(__dirname, "../../../work/agent-transactions.sqlite");
const DEFAULT_DB_PATH = process.env.ATW_TRANSACTION_DB
  || path.resolve(__dirname, "../../../work/agent-transactions-v2.sqlite");
const ACTIVE_OBSERVATION_PAYLOADS_PER_SESSION = 2;

function json(value, fallback = null) {
  try {
    return JSON.stringify(value ?? fallback);
  } catch {
    return JSON.stringify(fallback);
  }
}

function parse(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function eventSummary(value, depth = 0) {
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return value.length > 800 ? `${value.slice(0, 800)}…` : value;
  if (depth >= 4) return "[bounded]";
  if (Array.isArray(value)) return value.slice(0, 24).map((item) => eventSummary(item, depth + 1));
  if (typeof value !== "object") return String(value);
  const dropped = new Set([
    "observation",
    "previousObservation",
    "beforeObservation",
    "afterObservation",
    "page",
    "controls",
    "candidateSet",
    "candidates",
    "recoveryCandidates",
    "contextCapabilities",
    "screenshotDataUrl",
    // These collections are observation-local execution evidence. Persisting
    // them again inside every action/event duplicates the canonical
    // observation and can turn a single governed action into hundreds of KB.
    "operations",
    "actuators",
    "visualRegions",
    "strategies",
    "exactActuators",
    "actionabilityByActuator",
    "targetabilityByActuator"
  ]);
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !dropped.has(key))
    .slice(0, 80)
    .map(([key, item]) => [key, eventSummary(item, depth + 1)]));
}

function governedActionSummary(action = {}) {
  const summary = eventSummary(action) || {};
  const target = action.targetSnapshot || {};
  const pipeline = action.pipelineContract || {};
  const capability = pipeline.capability || {};
  const selectedStrategy = capability.selectedStrategy || {};
  return {
    ...summary,
    // Keep the exact durable identity and governed postcondition. The full
    // canonical control graph remains available from the immutable
    // observation referenced by observationId/observationHash.
    targetSnapshot: target && typeof target === "object" ? {
      id: String(target.id || ""),
      controlId: String(target.controlId || action.controlId || ""),
      stableKey: String(target.stableKey || ""),
      meaning: String(target.meaning || ""),
      label: String(target.label || "").slice(0, 240),
      normalizedLabel: String(target.normalizedLabel || "").slice(0, 240),
      role: String(target.role || ""),
      domRole: String(target.domRole || ""),
      semantic: String(target.semantic || ""),
      kind: String(target.kind || ""),
      fieldType: String(target.fieldType || ""),
      decisionGroupId: String(target.decisionGroupId || action.decisionGroupId || ""),
      sectionId: String(target.sectionId || ""),
      surfaceId: String(target.surfaceId || ""),
      surfaceType: String(target.surfaceType || ""),
      risk: String(target.risk || action.risk || ""),
      state: eventSummary(target.state || null),
      box: eventSummary(target.box || null)
    } : null,
    expectedOutcome: eventSummary(action.expectedOutcome || null),
    expectedPostconditions: eventSummary(action.expectedPostconditions || []),
    pipelineContract: pipeline && typeof pipeline === "object" ? {
      contractVersion: String(pipeline.contractVersion || ""),
      requirement: eventSummary(pipeline.requirement || null),
      component: eventSummary(pipeline.component || null),
      capability: {
        capabilityId: String(capability.capabilityId || ""),
        operation: String(capability.operation || action.operation || ""),
        status: String(capability.status || ""),
        actuatorId: String(capability.actuatorId || action.actuatorId || ""),
        selectedStrategy: selectedStrategy && typeof selectedStrategy === "object" ? {
          operation: String(selectedStrategy.operation || action.operation || ""),
          actuatorId: String(selectedStrategy.actuatorId || action.actuatorId || ""),
          method: String(selectedStrategy.method || action.interactionMethod || ""),
          actionType: String(selectedStrategy.actionType || action.type || ""),
          status: String(selectedStrategy.status || ""),
          strategyId: String(selectedStrategy.strategyId || ""),
          actuatorStableKey: String(selectedStrategy.actuatorStableKey || "")
        } : null
      },
      expectedOutcome: eventSummary(pipeline.expectedOutcome || action.expectedOutcome || null),
      validationOwnership: eventSummary(pipeline.validationOwnership || null)
    } : null
  };
}

function redactedObservation(observation = {}) {
  const page = { ...(observation.page || {}) };
  if (page.screenshotDataUrl) page.screenshotDataUrl = "[redacted-persisted-separately]";
  return { ...observation, page };
}

function compactDecision(decision = {}) {
  const subject = decision.subject || {};
  const observed = decision.observed || decision.observation || {};
  return eventSummary({
    decisionId: decision.decisionId,
    decisionGroupId: decision.decisionGroupId,
    decisionInstanceId: decision.decisionInstanceId,
    requirementId: decision.requirementId,
    canonicalOwnerId: decision.canonicalOwnerId,
    family: decision.family,
    kind: decision.kind,
    semanticType: decision.semanticType,
    status: decision.status,
    outcome: decision.outcome,
    completionReason: decision.completionReason,
    required: decision.required,
    requiresResolution: decision.requiresResolution,
    optional: decision.optional,
    selectedControlId: decision.selectedControlId,
    selectedValue: decision.selectedValue,
    desiredValue: decision.desiredValue,
    currentValue: decision.currentValue,
    surfaceId: decision.surfaceId,
    subjectId: decision.subjectId,
    subject: {
      id: subject.id,
      subjectId: subject.subjectId,
      kind: subject.kind,
      semanticType: subject.semanticType,
      travelerIndex: subject.travelerIndex,
      required: subject.required
    },
    observed: {
      value: observed.value,
      selectedValue: observed.selectedValue,
      selectedControlId: observed.selectedControlId,
      satisfied: observed.satisfied,
      required: observed.required
    }
  });
}

function compactCurrentObligation(obligation = null) {
  if (!obligation || typeof obligation !== "object") return obligation || null;
  // The obligation is already the compact durable semantic contract. Fresh
  // controls and actuator candidates remain exclusively observation-local.
  // Drop the pre-v2 mechanics shadow if an old in-memory fixture/session still
  // carries it; the structured binding is the only supported continuation.
  const { mechanics: _legacyMechanics, ...durable } = obligation;
  return durable;
}

function compactTaskState(taskState = null) {
  if (!taskState || typeof taskState !== "object") return taskState || null;
  const verificationDecisionMemory = taskState.verificationDecisionMemory || taskState.canonicalDecisions;
  return {
    contractVersion: String(taskState.contractVersion || "task-state/v2"),
    goal: eventSummary(taskState.goal || null),
    userPreferences: eventSummary(taskState.userPreferences || {}),
    safetyRestrictions: eventSummary(taskState.safetyRestrictions || {}),
    terminalGoalLatch: eventSummary(taskState.terminalGoalLatch || null),
    checkoutBoundary: eventSummary(taskState.checkoutBoundary || null),
    stage: String(taskState.stage || "unknown"),
    transactionOutcome: eventSummary(taskState.transactionOutcome || null),
    stageOutcome: eventSummary(taskState.stageOutcome || null),
    surfaceSubgoal: eventSummary(taskState.surfaceSubgoal || null),
    decisionEpisode: eventSummary(taskState.decisionEpisode || null),
    verifiedCommerceObligations: eventSummary(taskState.verifiedCommerceObligations || []),
    verifiedProfileComponents: eventSummary(taskState.verifiedProfileComponents || []),
    outcomeJournal: eventSummary(taskState.outcomeJournal || []),
    outcomeCoverage: eventSummary(taskState.outcomeCoverage || null),
    completedOutcomes: eventSummary(taskState.completedOutcomes || []),
    currentObligation: compactCurrentObligation(taskState.currentObligation),
    disposition: eventSummary(taskState.disposition || null),
    decisionFrameId: String(taskState.decisionFrameId || ""),
    terminalStatus: String(taskState.terminalStatus || "active"),
    surfaceFingerprint: String(taskState.surfaceFingerprint || ""),
    meaningfulSurfaceChange: taskState.meaningfulSurfaceChange === true,
    clearObsoleteRecovery: taskState.clearObsoleteRecovery === true,
    parentObjective: eventSummary(taskState.parentObjective || null),
    verificationDecisionMemory: Array.isArray(verificationDecisionMemory)
      ? verificationDecisionMemory.slice(-80).map(compactDecision)
      : []
  };
}

function compactFactEvidence(evidence = null) {
  if (!evidence || typeof evidence !== "object") return null;
  return {
    source: String(evidence.source || "").slice(0, 80),
    ownerKey: String(evidence.ownerKey || "").slice(0, 180),
    role: String(evidence.role || "").slice(0, 40),
    ownerType: String(evidence.ownerType || "").slice(0, 60),
    qualification: String(evidence.qualification || "").slice(0, 80),
    observationId: String(evidence.observationId || "").slice(0, 120),
    confidence: Math.max(0, Math.min(1, Number(evidence.confidence) || 0)),
    authoritative: evidence.authoritative === true
  };
}

function compactInvariantFacts(facts = null) {
  if (!facts || typeof facts !== "object") return facts || null;
  const segments = (facts.itinerary?.segments || []).slice(0, 12).map((segment) => ({
    segmentId: String(segment.segmentId || "").slice(0, 120),
    origin: String(segment.origin || "").slice(0, 80),
    destination: String(segment.destination || "").slice(0, 80),
    departureDate: String(segment.departureDate || "").slice(0, 40),
    departureTime: String(segment.departureTime || "").slice(0, 20),
    arrivalTime: String(segment.arrivalTime || "").slice(0, 20),
    flightNumber: String(segment.flightNumber || "").slice(0, 30),
    evidence: compactFactEvidence(segment.evidence)
  }));
  return {
    contractVersion: String(facts.contractVersion || "").slice(0, 40),
    evidenceMode: String(facts.evidenceMode || "").slice(0, 20),
    itinerary: {
      completeness: String(facts.itinerary?.completeness || "unknown").slice(0, 20),
      segments
    },
    travelers: (facts.travelers || []).slice(0, 12).map((traveler) => ({
      travelerId: String(traveler.travelerId || traveler.id || "").slice(0, 120),
      name: String(traveler.name || "").slice(0, 160)
    })),
    currency: String(facts.currency || facts.totalPrice?.currency || "").slice(0, 20),
    basePrice: facts.basePrice ? {
      amount: Number.isFinite(Number(facts.basePrice.amount)) ? Number(facts.basePrice.amount) : null,
      currency: String(facts.basePrice.currency || "").slice(0, 20)
    } : null,
    totalPrice: facts.totalPrice ? {
      amount: Number.isFinite(Number(facts.totalPrice.amount)) ? Number(facts.totalPrice.amount) : null,
      currency: String(facts.totalPrice.currency || facts.currency || "").slice(0, 20)
    } : null,
    fareBrand: String(facts.fareBrand || "").slice(0, 160),
    selectedExtras: eventSummary(facts.selectedExtras || []),
    factEvidence: {
      itinerary: (facts.factEvidence?.itinerary || []).slice(0, 12).map((entry) => ({
        segmentId: String(entry.segmentId || "").slice(0, 120),
        ...compactFactEvidence(entry)
      })),
      fareBrand: compactFactEvidence(facts.factEvidence?.fareBrand),
      totalPrice: compactFactEvidence(facts.factEvidence?.totalPrice),
      travelers: compactFactEvidence(facts.factEvidence?.travelers)
    },
    provenance: (facts.provenance || []).slice(0, 20).map((entry) => ({
      source: String(entry.source || "").slice(0, 80),
      observationId: String(entry.observationId || "").slice(0, 120),
      confidence: Math.max(0, Math.min(1, Number(entry.confidence) || 0))
    }))
  };
}

function compactTransactionInvariants(envelope = null) {
  if (!envelope || typeof envelope !== "object") return envelope || null;
  return {
    version: envelope.version,
    baseline: compactInvariantFacts(envelope.baseline || null),
    current: compactInvariantFacts(envelope.current || null),
    outcomeLedger: eventSummary(envelope.outcomeLedger || []),
    reviewFacts: compactInvariantFacts(envelope.reviewFacts || null),
    baselineStatus: String(envelope.baselineStatus || ""),
    baselineObservationId: String(envelope.baselineObservationId || ""),
    approvedAt: String(envelope.approvedAt || ""),
    // Price/itinerary history is needed for consequence checks, but sixty full
    // transaction graphs are not. Keep only a bounded recent safety window.
    evidence: Array.isArray(envelope.evidence)
      ? envelope.evidence.slice(-8).map((entry) => ({
          observationId: String(entry.observationId || ""),
          observedAt: String(entry.observedAt || ""),
          facts: {
            totalPrice: eventSummary(entry.facts?.totalPrice || null),
            currency: String(entry.facts?.currency || entry.facts?.totalPrice?.currency || "")
          }
        }))
      : [],
    // Review is deterministically rebuilt from baseline/current/outcomes on
    // the next observation; persisting it copied the same transaction graph.
    review: null
  };
}

function compactRecoveryState(recovery = null) {
  if (!recovery || typeof recovery !== "object") return recovery || null;
  const compactFailure = (entry = {}) => ({
    goalKey: String(entry.goalKey || ""),
    semanticGoalKey: String(entry.semanticGoalKey || ""),
    decisionInstanceId: String(entry.decisionInstanceId || ""),
    strategySignature: String(entry.strategySignature || entry.actuatorSignature || ""),
    controlId: String(entry.controlId || ""),
    stableControlKey: String(entry.stableControlKey || ""),
    targetId: String(entry.targetId || ""),
    capability: String(entry.capability || entry.operation || ""),
    operation: String(entry.operation || entry.capability || ""),
    semanticEffect: String(entry.semanticEffect || ""),
    observationId: String(entry.observationId || ""),
    pageStateHash: String(entry.pageStateHash || ""),
    actuatorStableKey: String(entry.actuatorStableKey || ""),
    surfaceInstanceKey: String(entry.surfaceInstanceKey || ""),
    targetLocalStateKey: String(entry.targetLocalStateKey || ""),
    failureCount: Number(entry.failureCount || 0),
    code: String(entry.code || "")
  });
  return {
    attempts: Number(recovery.attempts || 0),
    phase: String(recovery.phase || "idle"),
    stateHash: String(recovery.stateHash || ""),
    attemptedCandidateIds: Array.isArray(recovery.attemptedCandidateIds)
      ? recovery.attemptedCandidateIds.slice(-40).map(String)
      : [],
    failedStrategies: Array.isArray(recovery.failedStrategies)
      ? recovery.failedStrategies.slice(-80).map(compactFailure)
      : [],
    failedStrategySignatures: Array.isArray(recovery.failedStrategySignatures)
      ? recovery.failedStrategySignatures.slice(-80).map(String)
      : [],
    staleRebind: eventSummary(recovery.staleRebind || null),
    // This tiny sample is durable recovery state, not page perception. It is
    // required to distinguish a genuinely stuck reveal from measurable
    // viewport progress after a restart/round trip.
    lastRevealSample: recovery.lastRevealSample && typeof recovery.lastRevealSample === "object"
      ? {
          observationId: String(recovery.lastRevealSample.observationId || ""),
          exists: recovery.lastRevealSample.exists === true,
          inViewport: recovery.lastRevealSample.inViewport === true,
          distanceToViewport: Number.isFinite(Number(recovery.lastRevealSample.distanceToViewport))
            ? Number(recovery.lastRevealSample.distanceToViewport)
            : null,
          measurableProgress: recovery.lastRevealSample.measurableProgress === true
        }
      : null,
    lastCode: String(recovery.lastCode || ""),
    updatedAt: String(recovery.updatedAt || "")
  };
}

function compactPendingAction(pending = null) {
  if (!pending || typeof pending !== "object") return pending || null;
  const { originalAction, schemaVersion: _legacySchemaVersion, ...canonical } = pending;
  const actionLease = pending.actionLease || (originalAction ? createActionLease(originalAction) : null);
  const compactLease = actionLease ? {
    ...eventSummary(actionLease),
    // `eventSummary` intentionally removes properties named `observation`
    // because they normally contain a complete browser graph. An ActionLease
    // is different: its observation is only the immutable source id/hash and
    // is required to invalidate the lease after a cross-document navigation.
    observation: {
      id: String(actionLease.observation?.id || ""),
      hash: String(actionLease.observation?.hash || "")
    }
  } : null;
  const compact = eventSummary({
    ...canonical,
    contractVersion: "leased-action/v1",
    actionLease: compactLease,
    candidateIdentity: pending.candidateIdentity ? eventSummary(pending.candidateIdentity) : undefined
  });
  // The outer bounded traversal also encounters the nested key name, so put
  // the two scalar identity fields back after generic compaction.
  if (compact?.actionLease && compactLease?.observation) {
    compact.actionLease.observation = compactLease.observation;
  }
  return compact;
}

function compactExecutionEpisode(state = {}) {
  const obligation = state.taskState?.currentObligation || null;
  const current = executionEpisodeFor(state);
  const recovery = compactRecoveryState(current);
  const pending = compactPendingAction(current.leasedAction);
  if (!obligation && !pending && current.status === "idle" && !recovery?.attempts && !current.mechanicalEvidence) return null;
  return {
    ...eventSummary(current),
    contractVersion: "execution-episode/v2",
    obligationId: String(obligation?.obligationId || current.obligationId || pending?.obligationId || ""),
    leasedAction: pending,
    status: String(current.status || recovery?.phase || (pending ? "leased" : "idle")),
    failedStrategies: eventSummary(recovery?.failedStrategies || []),
    failedStrategySignatures: eventSummary(recovery?.failedStrategySignatures || []),
    attemptedCandidateIds: eventSummary(recovery?.attemptedCandidateIds || []),
    staleRebind: eventSummary(recovery?.staleRebind || null),
    attempts: Math.max(0, Number(recovery?.attempts || 0)),
    remainingAttempts: Math.max(0, Number(current.remainingAttempts || 0)),
    stateHash: String(recovery?.stateHash || ""),
    lastCode: String(recovery?.lastCode || ""),
    lastRevealSample: eventSummary(recovery?.lastRevealSample || null),
    mechanicalEvidence: eventSummary(current.mechanicalEvidence || null),
    updatedAt: String(recovery?.updatedAt || state.updatedAt || "")
  };
}

function compactSessionState(state = {}) {
  // This is an allowlist, not a blacklist. Browser controls, observations,
  // candidate graphs, model caches, read models, and diagnostic projections
  // are reconstructed from the immutable current observation each turn.
  return {
    id: String(state.id || ""),
    status: String(state.status || "running"),
    goal: String(state.goal || ""),
    travelerId: String(state.travelerId || ""),
    travelerIds: eventSummary(state.travelerIds || []),
    userPolicy: eventSummary(state.userPolicy || {}),
    sessionProfileOverrides: eventSummary(state.sessionProfileOverrides || {}),
    semanticBindingMemory: eventSummary(state.semanticBindingMemory || []),
    pendingUserInput: eventSummary(state.pendingUserInput || null),
    site: eventSummary(state.site || {}),
    approvals: eventSummary(state.approvals || {}),
    lastAction: state.lastAction ? governedActionSummary(state.lastAction) : null,
    currentObservationId: String(state.currentObservationId || ""),
    currentObservationHash: String(state.currentObservationHash || ""),
    taskState: compactTaskState(state.taskState),
    observationReadiness: eventSummary(state.observationReadiness || null),
    executionEpisode: compactExecutionEpisode(state),
    transactionInvariants: compactTransactionInvariants(state.transactionInvariants),
    paymentState: eventSummary(state.paymentState || {}),
    stallCount: Math.max(0, Number(state.stallCount || 0)),
    createdAt: String(state.createdAt || ""),
    updatedAt: String(state.updatedAt || "")
  };
}

function createStore({ dbPath = DEFAULT_DB_PATH } = {}) {
  if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      state_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS observations (
      observation_id TEXT PRIMARY KEY,
      transaction_id TEXT NOT NULL,
      snapshot_hash TEXT NOT NULL,
      page_url TEXT NOT NULL DEFAULT '',
      page_step TEXT NOT NULL DEFAULT '',
      payload_json TEXT NOT NULL,
      is_current INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      FOREIGN KEY(transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS observations_transaction_idx
      ON observations(transaction_id, created_at);
    CREATE INDEX IF NOT EXISTS observations_current_idx
      ON observations(transaction_id, is_current);
    CREATE TABLE IF NOT EXISTS governed_actions (
      action_id TEXT PRIMARY KEY,
      transaction_id TEXT NOT NULL,
      turn_id TEXT NOT NULL DEFAULT '',
      observation_id TEXT NOT NULL,
      observation_hash TEXT NOT NULL DEFAULT '',
      signature TEXT NOT NULL,
      status TEXT NOT NULL,
      action_json TEXT NOT NULL,
      result_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(transaction_id) REFERENCES transactions(id) ON DELETE CASCADE,
      FOREIGN KEY(observation_id) REFERENCES observations(observation_id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS governed_actions_transaction_idx
      ON governed_actions(transaction_id, created_at);
    CREATE INDEX IF NOT EXISTS governed_actions_duplicate_idx
      ON governed_actions(transaction_id, observation_id, signature, status);
    CREATE TABLE IF NOT EXISTS action_events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_id TEXT NOT NULL,
      action_id TEXT NOT NULL DEFAULT '',
      turn_id TEXT NOT NULL DEFAULT '',
      observation_id TEXT NOT NULL DEFAULT '',
      stage TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS action_events_transaction_idx
      ON action_events(transaction_id, event_id);
  `);

  const readTransaction = db.prepare("SELECT state_json FROM transactions WHERE id = ?");
  const insertTransaction = db.prepare(`
    INSERT INTO transactions(id, state_json, created_at, updated_at)
    VALUES (?, ?, ?, ?)
  `);
  const updateTransaction = db.prepare(`
    UPDATE transactions SET state_json = ?, updated_at = ? WHERE id = ?
  `);
  const compactHistoricalPayloads = db.prepare(`
    UPDATE observations
    SET payload_json = 'null'
    WHERE transaction_id = ?
      AND payload_json <> 'null'
      AND observation_id NOT IN (
        SELECT observation_id FROM observations
        WHERE transaction_id = ?
        ORDER BY created_at DESC, rowid DESC
        LIMIT ?
      )
  `);

  function compactObservationPayloads(transactionId) {
    if (!transactionId) return 0;
    return Number(compactHistoricalPayloads.run(
      String(transactionId),
      String(transactionId),
      ACTIVE_OBSERVATION_PAYLOADS_PER_SESSION
    ).changes || 0);
  }

  function compactAllObservationPayloads() {
    const transactionIds = db.prepare("SELECT id FROM transactions").all().map((row) => row.id);
    return transactionIds.reduce((total, transactionId) => total + compactObservationPayloads(transactionId), 0);
  }

  function observationStorageStats() {
    const row = db.prepare(`
      SELECT
        COUNT(*) AS observation_count,
        SUM(CASE WHEN payload_json <> 'null' THEN 1 ELSE 0 END) AS active_payload_count,
        SUM(LENGTH(payload_json)) AS payload_bytes
      FROM observations
    `).get();
    return {
      observationCount: Number(row?.observation_count || 0),
      activePayloadCount: Number(row?.active_payload_count || 0),
      payloadBytes: Number(row?.payload_bytes || 0)
    };
  }

  function reclaimObservationStorage({ vacuum = false } = {}) {
    const before = observationStorageStats();
    const compactedPayloads = compactAllObservationPayloads();
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    if (vacuum) db.exec("VACUUM");
    return { before, after: observationStorageStats(), compactedPayloads, vacuumed: vacuum === true };
  }

  function getSession(sessionId) {
    if (!sessionId) return null;
    const row = readTransaction.get(String(sessionId));
    const parsed = row ? parse(row.state_json, null) : null;
    if (!parsed) return null;
    // One-time read migration for sessions written before TaskState became
    // the sole terminal/stage authority.
    if (parsed.terminalGoalLatch && !parsed.taskState?.terminalGoalLatch) {
      parsed.taskState = { ...(parsed.taskState || {}), terminalGoalLatch: parsed.terminalGoalLatch };
    }
    delete parsed.terminalGoalLatch;
    delete parsed.confirmationState;
    const episode = parsed.executionEpisode || (
      parsed.pendingAction || parsed.actionLifecycle || parsed.recoveryState || parsed.pendingMechanicalEvidence
        ? {
            ...(parsed.actionLifecycle || {}),
            ...(parsed.recoveryState || {}),
            leasedAction: parsed.pendingAction || null,
            mechanicalEvidence: parsed.pendingMechanicalEvidence || null
          }
        : null
    );
    parsed.executionEpisode = normalizeExecutionEpisode(episode
      ? {
          ...(episode.lifecycle || {}),
          ...episode,
          phase: episode.phase || episode.status || "idle",
          failedStrategies: episode.failedStrategies || episode.attemptedStrategies || [],
          failedStrategySignatures: episode.failedStrategySignatures || episode.attemptedStrategySignatures || []
        }
      : null);
    delete parsed.pendingAction;
    delete parsed.actionLifecycle;
    delete parsed.recoveryState;
    delete parsed.pendingMechanicalEvidence;
    delete parsed.currentStep;
    return parsed;
  }

  function saveSession(state) {
    if (!state?.id) throw new Error("Transaction state requires an id");
    const existing = readTransaction.get(state.id);
    const at = nowIso();
    const saved = { ...state, updatedAt: state.updatedAt || at };
    const persisted = compactSessionState(saved);
    if (existing) updateTransaction.run(json(persisted, {}), at, state.id);
    else insertTransaction.run(state.id, json(persisted, {}), state.createdAt || at, at);
    return saved;
  }

  function getOrCreateSession(sessionId, { goal, travelerId, site } = {}) {
    const existing = sessionId ? getSession(sessionId) : null;
    if (existing) return existing;
    const state = createCheckoutSessionState({ goal, travelerId, site });
    if (sessionId) state.id = String(sessionId);
    return saveSession(state);
  }

  function recordObservation(transactionId, observation = {}, { updateSession = true } = {}) {
    const observationId = String(observation.observationId || "");
    const snapshotHash = String(observation.observationSnapshot?.snapshotHash || observation.page?.snapshotHash || "");
    if (!transactionId || !observationId || !snapshotHash) {
      throw new Error("Observation persistence requires transactionId, observationId, and snapshotHash");
    }
    const existing = db.prepare("SELECT transaction_id, snapshot_hash, payload_json FROM observations WHERE observation_id = ?").get(observationId);
    if (existing) {
      if (existing.transaction_id !== transactionId || existing.snapshot_hash !== snapshotHash) {
        throw new Error(`Immutable observation conflict for ${observationId}`);
      }
      db.prepare("UPDATE observations SET is_current = CASE WHEN observation_id = ? THEN 1 ELSE 0 END WHERE transaction_id = ?")
        .run(observationId, transactionId);
      compactObservationPayloads(transactionId);
      return parse(existing.payload_json, null);
    }
    const payload = redactedObservation(observation);
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("UPDATE observations SET is_current = 0 WHERE transaction_id = ?").run(transactionId);
      db.prepare(`
        INSERT INTO observations(
          observation_id, transaction_id, snapshot_hash, page_url, page_step,
          payload_json, is_current, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 1, ?)
      `).run(
        observationId,
        transactionId,
        snapshotHash,
        String(observation.page?.url || ""),
        String(observation.page?.step || ""),
        json(payload, {}),
        nowIso()
      );
      // Observation identity is durable; full perception is not. Keep only
      // the current payload and its immediate predecessor for transition
      // verification. Governed actions retain the observation id/hash and a
      // compact target proof, so finalized actions never pin full DOM graphs.
      compactObservationPayloads(transactionId);
      const currentState = updateSession ? getSession(transactionId) : null;
      if (currentState) {
        saveSession(withUpdate(currentState, {
          currentObservationId: observationId,
          currentObservationHash: snapshotHash,
          site: {
            ...(currentState.site || {}),
            host: String(observation.page?.site || currentState.site?.host || ""),
            url: String(observation.page?.url || currentState.site?.url || "")
          }
        }));
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return payload;
  }

  function getObservation(transactionId, observationId) {
    const row = db.prepare(`
      SELECT payload_json FROM observations
      WHERE transaction_id = ? AND observation_id = ?
    `).get(transactionId, observationId);
    return row ? parse(row.payload_json, null) : null;
  }

  function getCurrentObservation(transactionId) {
    const row = db.prepare(`
      SELECT payload_json FROM observations
      WHERE transaction_id = ? AND is_current = 1
      ORDER BY created_at DESC LIMIT 1
    `).get(transactionId);
    return row ? parse(row.payload_json, null) : null;
  }

  function isCurrentObservation(transactionId, observationId, snapshotHash = "") {
    const row = db.prepare(`
      SELECT snapshot_hash FROM observations
      WHERE transaction_id = ? AND observation_id = ? AND is_current = 1
    `).get(transactionId, observationId);
    if (!row) return false;
    return !snapshotHash || row.snapshot_hash === snapshotHash;
  }

  function reserveGovernedAction({ transactionId, turnId = "", action, observationId, observationHash = "" }) {
    if (!transactionId || !action?.id || !observationId) {
      return { ok: false, code: "ACTION_IDENTITY_MISSING", reason: "Governed action identity is incomplete." };
    }
    const signature = actionSignature(action);
    const existingId = db.prepare("SELECT status, action_json FROM governed_actions WHERE action_id = ?").get(action.id);
    if (existingId) {
      return { ok: false, code: "DUPLICATE_ACTION_ID", reason: `Action ${action.id} was already governed.`, existing: parse(existingId.action_json, null) };
    }
    const duplicate = db.prepare(`
      SELECT action_id, status FROM governed_actions
      WHERE transaction_id = ? AND observation_id = ? AND signature = ?
        AND status IN ('allowed', 'approved', 'dispatched', 'observed', 'verified')
      ORDER BY created_at DESC LIMIT 1
    `).get(transactionId, observationId, signature);
    if (duplicate) {
      return { ok: false, code: "DUPLICATE_ACTION_ATTEMPT", reason: `Equivalent action ${duplicate.action_id} is already ${duplicate.status}.` };
    }
    const at = nowIso();
    db.prepare(`
      INSERT INTO governed_actions(
        action_id, transaction_id, turn_id, observation_id, observation_hash,
        signature, status, action_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?)
    `).run(
      action.id,
      transactionId,
      turnId,
      observationId,
      observationHash,
      signature,
      json(governedActionSummary(action), {}),
      at,
      at
    );
    return { ok: true, actionId: action.id, signature };
  }

  function updateGovernedAction(actionId, status, result = null) {
    if (!actionId) return false;
    const outcome = db.prepare(`
      UPDATE governed_actions SET status = ?, result_json = ?, updated_at = ?
      WHERE action_id = ?
    `).run(String(status || "reported"), result == null ? null : json(result, {}), nowIso(), actionId);
    return outcome.changes > 0;
  }

  function advanceGovernedAction(actionId, fromStatuses, status, result = null) {
    if (!actionId) return false;
    const allowed = [...new Set((Array.isArray(fromStatuses) ? fromStatuses : [fromStatuses]).filter(Boolean).map(String))];
    if (!allowed.length) return false;
    const placeholders = allowed.map(() => "?").join(", ");
    const outcome = db.prepare(`
      UPDATE governed_actions SET status = ?, result_json = ?, updated_at = ?
      WHERE action_id = ? AND status IN (${placeholders})
    `).run(String(status || "reported"), result == null ? null : json(result, {}), nowIso(), actionId, ...allowed);
    return outcome.changes > 0;
  }

  function getGovernedAction(actionId) {
    const row = db.prepare("SELECT * FROM governed_actions WHERE action_id = ?").get(actionId);
    if (!row) return null;
    return { ...row, action: parse(row.action_json, null), result: parse(row.result_json, null) };
  }

  function getPendingActionResult(state = {}) {
    const actionId = String(
      executionEpisodeFor(state).leasedAction?.actionLease?.actionId || ""
    );
    if (!actionId) return null;
    const governed = getGovernedAction(actionId);
    const result = governed?.result;
    if (!result || String(result.actionId || result.action?.id || "") !== actionId) return null;
    return result;
  }

  function recordActionResult(transactionId, result = {}, patch = {}) {
    const state = getSession(transactionId);
    if (!state) return null;
    db.exec("BEGIN IMMEDIATE");
    try {
      const updated = saveSession(withUpdate(state, {
        ...patch,
        lastActionResult: result
      }));
      const actionId = String(result.actionId || result.action?.id || "");
      if (actionId) {
        const dispatched = result.dispatched === true || result.executed === true;
        const status = dispatched ? "dispatched" : "rejected_before_dispatch";
        advanceGovernedAction(actionId, ["allowed", "approved", "dispatched"], status, result);
        insertActionEventRow(updated.id, {
          actionId,
          observationId: String(result.observationId || ""),
          stage: status,
          result
        });
      }
      db.exec("COMMIT");
      return updated;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  const insertActionEvent = db.prepare(`
      INSERT INTO action_events(transaction_id, action_id, turn_id, observation_id, stage, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

  function insertActionEventRow(transactionId, event = {}) {
    const at = String(event?.at || nowIso());
    const outcome = insertActionEvent.run(
      transactionId,
      String(event?.actionId || ""),
      String(event?.turnId || ""),
      String(event?.observationId || ""),
      String(event?.stage || "event"),
      json(eventSummary(event || {}), {}),
      at
    );
    return Number(outcome.lastInsertRowid);
  }

  function recordActionEvents(transactionId, events = []) {
    if (!transactionId || !Array.isArray(events) || !events.length) return [];
    const ids = [];
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const event of events) {
        ids.push(insertActionEventRow(transactionId, event));
      }
      db.exec("COMMIT");
      return ids;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function recordActionEvent(transactionId, event = {}) {
    return recordActionEvents(transactionId, [event])[0] || null;
  }

  function reconstructTransaction(transactionId) {
    const state = getSession(transactionId);
    if (!state) return null;
    const observations = db.prepare(`
      SELECT observation_id, snapshot_hash, page_url, page_step, is_current, created_at
      FROM observations WHERE transaction_id = ? ORDER BY created_at
    `).all(transactionId);
    const actions = db.prepare(`
      SELECT action_id, turn_id, observation_id, observation_hash, signature, status,
             action_json, result_json, created_at, updated_at
      FROM governed_actions WHERE transaction_id = ? ORDER BY created_at
    `).all(transactionId).map((row) => ({
      ...row,
      action: parse(row.action_json, null),
      result: parse(row.result_json, null),
      action_json: undefined,
      result_json: undefined
    }));
    const events = db.prepare(`
      SELECT event_id, action_id, turn_id, observation_id, stage, payload_json, created_at
      FROM action_events WHERE transaction_id = ? ORDER BY event_id
    `).all(transactionId).map((row) => ({ ...row, payload: parse(row.payload_json, null), payload_json: undefined }));
    return { state, currentObservation: getCurrentObservation(transactionId), observations, actions, events };
  }

  function close() {
    db.close();
  }

  return {
    dbPath,
    getOrCreateSession,
    getSession,
    saveSession,
    recordObservation,
    getObservation,
    getCurrentObservation,
    isCurrentObservation,
    reserveGovernedAction,
    advanceGovernedAction,
    updateGovernedAction,
    getGovernedAction,
    getPendingActionResult,
    recordActionResult,
    recordActionEvent,
    recordActionEvents,
    compactObservationPayloads,
    compactAllObservationPayloads,
    observationStorageStats,
    reclaimObservationStorage,
    reconstructTransaction,
    close
  };
}

let defaultStore = null;

function getDefaultStore() {
  if (!defaultStore) defaultStore = createStore();
  return defaultStore;
}

const DEFAULT_METHODS = [
  "getOrCreateSession",
  "getSession",
  "saveSession",
  "recordObservation",
  "getObservation",
  "getCurrentObservation",
  "isCurrentObservation",
  "reserveGovernedAction",
  "advanceGovernedAction",
  "updateGovernedAction",
  "getGovernedAction",
  "getPendingActionResult",
  "recordActionResult",
  "recordActionEvent",
  "recordActionEvents",
  "compactObservationPayloads",
  "compactAllObservationPayloads",
  "observationStorageStats",
  "reclaimObservationStorage",
  "reconstructTransaction"
];

const singleton = Object.fromEntries(DEFAULT_METHODS.map((method) => [
  method,
  (...args) => getDefaultStore()[method](...args)
]));

module.exports = {
  ...singleton,
  createStore,
  compactSessionState,
  getDefaultStore,
  DEFAULT_DB_PATH,
  // The multi-GB V1 evidence store is intentionally never migrated or
  // rewritten by the V2 runtime. Replay tooling may opt into this explicit
  // path, while all fresh live sessions use the compact V2 database above.
  LEGACY_REPLAY_DB_PATH
};
