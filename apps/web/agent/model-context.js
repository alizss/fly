const { compactWholePageMarkdown } = require("./observation-markdown");
const { conciseActionFeedback, diffObservations, formatObservationDiffMarkdown } = require("./observation-diff");

function text(value, fallback = "") {
  return String(value ?? fallback).slice(0, 300);
}

function semanticOutcome(result = {}) {
  const outcome = result?.outcome && typeof result.outcome === "object" ? result.outcome : {};
  return text(
    outcome.message
    || outcome.code
    || result.message
    || result.failureCode
    || (result.verified === true ? "verified" : result.verified === false ? "not verified" : "unknown")
  );
}

function semanticActionContext(action = {}, result = {}) {
  const goal = text(
    action.semanticGoal
    || action.goal
    || action.goalId
    || action.intent
    || action.requirementId
    || "checkout progress"
  );
  const actionSummary = text(
    action.semanticAction
    || action.summary
    || action.operation
    || action.type
    || action.action
    || "observe"
  );
  const feedback = result.feedback && typeof result.feedback === "object"
    ? {
        dispatched: result.feedback.dispatched === true,
        targetReacted: result.feedback.targetReacted === true,
        selectionChanged: result.feedback.selectionChanged === true,
        surfaceChanged: result.feedback.surfaceChanged === true,
        progressChanged: result.feedback.progressChanged === true,
        priceChanged: result.feedback.priceChanged === true
      }
    : null;
  return {
    goal,
    action: actionSummary,
    verified: result.verified === true || result.postconditionSatisfied === true,
    outcome: semanticOutcome(result),
    ...(feedback ? { feedback } : {})
  };
}

function modelObservationContext(observation = {}, traveler = {}) {
  const compact = compactWholePageMarkdown(observation, { traveler });
  const diff = diffObservations(observation.previousObservation || null, observation);
  return {
    pageMarkdown: compact.markdown,
    pageCompression: compact.stats,
    observationDiff: diff,
    observationDiffMarkdown: formatObservationDiffMarkdown(diff, observation),
    actionFeedback: conciseActionFeedback(diff, observation.lastActionResult || {})
  };
}

function sanitizedActionHistory(history = []) {
  return (Array.isArray(history) ? history : []).slice(-12).map((entry) => {
    const payload = entry?.payload && typeof entry.payload === "object" ? entry.payload : {};
    return semanticActionContext({
      semanticGoal: entry.semanticGoal || entry.goal || entry.intent || entry.requirementId,
      semanticAction: entry.semanticAction || entry.summary || entry.type || entry.action
    }, {
      verified: entry.verified,
      postconditionSatisfied: entry.postconditionSatisfied,
      outcome: entry.outcome || payload.outcome || null,
      message: entry.message || payload.message || ""
    });
  });
}

function sanitizedFailureHistory(failures = []) {
  return (Array.isArray(failures) ? failures : []).slice(-30).map((failure) => ({
    goal: text(failure.semanticGoal || failure.intent || "recover current checkout goal"),
    action: text(failure.semanticAction || failure.operation || failure.type || "browser action"),
    verified: false,
    outcome: text(failure.code || failure.message || "browser rejected stale action")
  }));
}

module.exports = {
  modelObservationContext,
  semanticActionContext,
  sanitizedActionHistory,
  sanitizedFailureHistory
};
