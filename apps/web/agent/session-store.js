const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const { createCheckoutSessionState, withUpdate } = require("../../../packages/shared/agent-state");
const { actionSignature, actuatorSignature, normalizeAction, semanticGoalKey } = require("../../../packages/shared/agent-actions");

const DEFAULT_DB_PATH = process.env.ATW_TRANSACTION_DB
  || path.resolve(__dirname, "../../../work/agent-transactions.sqlite");

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

function redactedObservation(observation = {}) {
  const page = { ...(observation.page || {}) };
  if (page.screenshotDataUrl) page.screenshotDataUrl = "[redacted-persisted-separately]";
  return { ...observation, page };
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

  function getSession(sessionId) {
    if (!sessionId) return null;
    const row = readTransaction.get(String(sessionId));
    return row ? parse(row.state_json, null) : null;
  }

  function saveSession(state) {
    if (!state?.id) throw new Error("Transaction state requires an id");
    const existing = readTransaction.get(state.id);
    const at = nowIso();
    const saved = { ...state, updatedAt: state.updatedAt || at };
    if (existing) updateTransaction.run(json(saved, {}), at, state.id);
    else insertTransaction.run(state.id, json(saved, {}), state.createdAt || at, at);
    return saved;
  }

  function getOrCreateSession(sessionId, { goal, travelerId, site } = {}) {
    const existing = sessionId ? getSession(sessionId) : null;
    if (existing) return existing;
    const state = createCheckoutSessionState({ goal, travelerId, site });
    if (sessionId) state.id = String(sessionId);
    return saveSession(state);
  }

  function recordObservation(transactionId, observation = {}) {
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
      const currentState = getSession(transactionId);
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
    `).run(action.id, transactionId, turnId, observationId, observationHash, signature, json(action, {}), at, at);
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

  function actionAttemptFromResult(result = {}) {
    const reportedAction = result.action || {};
    const target = result.targetSnapshot || {};
    return normalizeAction({
      id: result.actionId || reportedAction.id || "",
      type: reportedAction.action || reportedAction.type || "",
      operation: result.operation || reportedAction.operation || "",
      controlId: reportedAction.controlId || target.controlId || "",
      targetId: reportedAction.targetId || target.id || "",
      targetSnapshot: target,
      value: reportedAction.value || "",
      affordance: reportedAction.affordance || null,
      semanticEffect: reportedAction.semanticEffect || "",
      goalId: reportedAction.goalId || "",
      decisionInstanceId: result.decisionInstanceId || reportedAction.decisionInstanceId || "",
      requirementId: reportedAction.requirementId || ""
    });
  }

  function failureFromResult(result = {}, state = {}) {
    if (result.verified === true) return null;
    const code = String(result.outcome?.code || result.code || "");
    const provenNoEffectCodes = new Set([
      "NO_OBSERVABLE_CHANGE",
      "NO_OBSERVABLE_STAGE_CHANGE",
      "TRANSITION_NO_EFFECT"
    ]);
    const staleCodes = new Set([
      "OBSERVATION_HASH_MISMATCH",
      "STALE_OBSERVATION",
      "PAGE_CHANGED_BEFORE_ACTION",
      "TARGET_OBSERVATION_DRIFT"
    ]);
    if (staleCodes.has(code)) return null;
    const attempted = result.dispatched === true || result.executed === true;
    if (!attempted) return null;
    if (!provenNoEffectCodes.has(code)) return null;
    const action = actionAttemptFromResult(result);
    if (!action.decisionInstanceId) return null;
    if (!["click", "type", "select", "click_xy", "keypress"].includes(action.type)) return null;
    const signature = actuatorSignature(action);
    return {
      at: String(result.at || nowIso()),
      actionSignature: actionSignature(action),
      actuatorSignature: signature,
      goalKey: semanticGoalKey(action.affordance?.task ? action : (state.taskState?.currentGoal || action)),
      decisionInstanceId: action.decisionInstanceId,
      actionId: String(result.actionId || action.id || ""),
      observationId: String(result.observationId || ""),
      controlId: String(action.controlId || ""),
      targetId: String(action.targetId || ""),
      operation: String(action.operation || ""),
      code: code || "OUTCOME_NOT_VERIFIED",
      message: String(result.outcome?.message || result.outcome?.reason || result.message || "The actuator did not produce its governed outcome.").slice(0, 500)
    };
  }

  function recordActionResult(transactionId, result = {}, patch = {}) {
    const state = getSession(transactionId);
    if (!state) return null;
    const failure = failureFromResult(result, state);
    const failures = [...(state.failures || [])];
    if (failure && !failures.some((item) => (
      item.actuatorSignature === failure.actuatorSignature
      && item.goalKey === failure.goalKey
      && item.decisionInstanceId === failure.decisionInstanceId
    ))) {
      failures.push(failure);
    }
    const updated = saveSession(withUpdate(state, {
      ...patch,
      lastActionResult: result,
      failures: failures.slice(-80)
    }));
    const actionId = String(result.actionId || result.action?.id || "");
    if (actionId) {
      const dispatched = result.dispatched === true || result.executed === true;
      const status = dispatched ? "dispatched" : "rejected_before_dispatch";
      advanceGovernedAction(actionId, ["allowed", "approved", "dispatched"], status, result);
      recordActionEvent(updated.id, {
        actionId,
        observationId: String(result.observationId || ""),
        stage: status,
        result
      });
    }
    return updated;
  }

  function recordActionEvent(transactionId, event = {}) {
    if (!transactionId) return null;
    const at = String(event.at || nowIso());
    const outcome = db.prepare(`
      INSERT INTO action_events(transaction_id, action_id, turn_id, observation_id, stage, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      transactionId,
      String(event.actionId || ""),
      String(event.turnId || ""),
      String(event.observationId || ""),
      String(event.stage || "event"),
      json(event, {}),
      at
    );
    return Number(outcome.lastInsertRowid);
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
    recordActionResult,
    recordActionEvent,
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
  "recordActionResult",
  "recordActionEvent",
  "reconstructTransaction"
];

const singleton = Object.fromEntries(DEFAULT_METHODS.map((method) => [
  method,
  (...args) => getDefaultStore()[method](...args)
]));

module.exports = {
  ...singleton,
  createStore,
  getDefaultStore,
  DEFAULT_DB_PATH
};
