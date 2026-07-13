// In-memory store for CheckoutSessionState. Local JSON/Postgres can replace
// this later (spec §1) without changing loop.js's contract — it only needs
// get/create/save.

const { createCheckoutSessionState } = require("../../../packages/shared/agent-state");

const sessions = new Map();
const PRUNE_AFTER_MS = 1000 * 60 * 60 * 6;

function prune() {
  const cutoff = Date.now() - PRUNE_AFTER_MS;
  for (const [id, state] of sessions.entries()) {
    if (new Date(state.updatedAt).getTime() < cutoff) sessions.delete(id);
  }
}

function getOrCreateSession(sessionId, { goal, travelerId, site } = {}) {
  prune();
  if (sessionId && sessions.has(sessionId)) return sessions.get(sessionId);
  const state = createCheckoutSessionState({ goal, travelerId, site });
  if (sessionId) state.id = sessionId; // extension-supplied id, if any, wins for continuity
  sessions.set(state.id, state);
  return state;
}

function getSession(sessionId) {
  return sessions.get(sessionId) || null;
}

function saveSession(state) {
  sessions.set(state.id, state);
  return state;
}

module.exports = { getOrCreateSession, getSession, saveSession };
