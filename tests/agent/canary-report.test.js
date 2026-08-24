const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { latestSessionId, summarizeCanary } = require("../../scripts/report-canary");

function fixture() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fly-canary-report-"));
}

function writeTrace(workDir, sessionId, turnId, record) {
  const directory = path.join(workDir, "agent-traces", sessionId);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${turnId}.json`), JSON.stringify({ sessionId, turnId, ...record }));
}

function writeClientEvents(workDir, sessionId, events) {
  const directory = path.join(workDir, "agent-client-logs");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${sessionId}.jsonl`), `${events.map(JSON.stringify).join("\n")}\n`);
}

function cardEntryEvidence() {
  return {
    contractVersion: "terminal-evidence/v2",
    verified: true,
    boundaryObserved: true,
    cardCredentialEntryObserved: true,
    paymentCredentialKinds: ["card_number", "card_expiry", "card_security_code"]
  };
}

test("summarizes a verified payment-review canary and its latency", () => {
  const workDir = fixture();
  const sessionId = "chk_turkish_success";
  writeTrace(workDir, sessionId, "1000", {
    at: "2026-08-10T10:00:00.000Z",
    observation: { page: { url: "https://www.turkishairlines.com/booking/passenger-details", step: "traveler_information" } },
    plannedAction: { type: "fill" },
    policyDecision: { allow: true },
    debug: { latency: { turn_total_ms: 40, semantic_compile_ms: 5, task_state_ms: 2, final_state_persist_ms: 3 }, modelUsage: { calls: [] } }
  });
  writeTrace(workDir, sessionId, "2000", {
    at: "2026-08-10T10:00:05.000Z",
    observation: { page: {
      url: "https://www.turkishairlines.com/booking/payments",
      step: "payment",
      terminalEvidence: cardEntryEvidence(),
      transactionFacts: {
        itinerary: { completeness: "complete", segments: [{ origin: "LJU", destination: "IST" }] },
        travelers: [{ travelerId: "trav_1" }],
        totalPrice: { amount: 241, currency: "EUR" },
        selectedExtras: []
      }
    } },
    plannedAction: { type: "final_review", intent: "card_credential_entry_reached" },
    policyDecision: { allow: false, code: "CARD_CREDENTIAL_ENTRY_REACHED", decision: "terminal" },
    executionResult: { stopped: false, stopCategory: "card_credential_entry_reached" },
    debug: {
      taskState: { terminalGoalLatch: { terminalStatus: "card_credential_entry_reached" } },
      latency: { turn_total_ms: 60, semantic_compile_ms: 7, task_state_ms: 4, final_state_persist_ms: 5 },
      modelUsage: { calls: [{ duration_ms: 20, input_tokens: 100, output_tokens: 10 }] }
    }
  });
  writeClientEvents(workDir, sessionId, [
    { phase: "backend.request.transport", entry: { payload: { observationBytes: 1000 } } },
    { phase: "latency.spans", entry: { payload: { request_upload_ms: 50, observation_build_ms: 25 } } },
    { phase: "backend.request.transport", entry: { payload: { observationBytes: 3000 } } },
    { phase: "latency.spans", entry: { payload: { request_upload_ms: 150, observation_build_ms: 75 } } }
  ]);

  const report = summarizeCanary({ workDir, sessionId, manualIntervention: "none" });
  assert.equal(report.site, "Turkish Airlines");
  assert.equal(report.result.status, "accepted");
  assert.equal(report.result.paymentBoundaryVerified, true);
  assert.equal(report.result.transactionReconciled, true);
  assert.equal(report.result.paymentReviewReached, true);
  assert.equal(report.result.transactionComplete, true);
  assert.equal(report.safety.passed, true);
  assert.equal(report.wallTimeMs, 5000);
  assert.deepEqual(report.stages, ["traveler_information", "payment"]);
  assert.equal(report.latency.clientRoundTripMs.median, 50);
  assert.equal(report.latency.clientRoundTripMs.p95, 150);
  assert.equal(report.latency.observationBytes.total, 4000);
  assert.equal(report.model.calls, 1);
});

test("requires an explicit no-intervention annotation before autonomous acceptance", () => {
  const workDir = fixture();
  const sessionId = "chk_unknown_intervention";
  writeTrace(workDir, sessionId, "1000", {
    at: "2026-08-10T10:00:00.000Z",
    observation: { page: {
      url: "https://www.kiwi.com/booking/payment",
      step: "payment",
      terminalEvidence: cardEntryEvidence(),
      transactionFacts: {
        itinerary: { completeness: "complete", segments: [{ origin: "LJU", destination: "LHR" }] },
        travelers: [{ travelerId: "trav_1" }],
        totalPrice: { amount: 100, currency: "EUR" }
      }
    } },
    plannedAction: { type: "final_review", intent: "card_credential_entry_reached" },
    policyDecision: { code: "CARD_CREDENTIAL_ENTRY_REACHED", decision: "terminal" }
  });
  const report = summarizeCanary({ workDir, sessionId });
  assert.equal(report.result.status, "technical_pass_manual_unknown");
  assert.equal(report.result.transactionReconciled, true);
  assert.equal(report.result.manualIntervention, "unknown");
});

test("does not accept a stopped checkout or an incomplete transaction", () => {
  const workDir = fixture();
  const sessionId = "chk_easyjet_stopped";
  writeTrace(workDir, sessionId, "1000", {
    at: "2026-08-10T11:00:00.000Z",
    observation: { page: { url: "https://www.easyjet.com/checkout/bags", step: "baggage" } },
    plannedAction: { type: "stop", reason: "No safe exact actuator." },
    policyDecision: { decision: "stop", code: "MECHANICS_UNAVAILABLE" },
    executionResult: { stopped: true, stopCategory: "internal_failure" }
  });

  const report = summarizeCanary({ workDir, sessionId });
  assert.equal(report.site, "EasyJet");
  assert.equal(report.result.status, "checkout_incomplete");
  assert.equal(report.result.stopCode, "MECHANICS_UNAVAILABLE");
  assert.equal(report.result.transactionComplete, false);
});

test("separates a verified payment boundary from incomplete transaction reconciliation", () => {
  const workDir = fixture();
  const sessionId = "chk_kiwi_reconciliation_incomplete";
  writeTrace(workDir, sessionId, "1000", {
    at: "2026-08-10T12:00:00.000Z",
    observation: { page: {
      url: "https://www.kiwi.com/en/booking/payment",
      step: "payment",
      terminalEvidence: cardEntryEvidence(),
      transactionFacts: {
        itinerary: { completeness: "complete", segments: [{ origin: "LJU", destination: "LHR" }] },
        travelers: [{ travelerId: "trav_1" }],
        totalPrice: { amount: 100, currency: "EUR" }
      }
    } },
    plannedAction: { type: "ask_user" },
    policyDecision: { code: "TRANSACTION_REVIEW_INCOMPLETE", decision: "request_approval" },
    debug: {
      transactionReview: {
        ready: false,
        missingFacts: ["verified_decision_outcomes"],
        contradictions: []
      }
    }
  });

  const report = summarizeCanary({ workDir, sessionId });
  assert.equal(report.result.classification, "reconciliation_incomplete");
  assert.equal(report.result.paymentBoundaryVerified, true);
  assert.equal(report.result.transactionReconciled, false);
  assert.equal(report.result.safetyPassed, true);
});

test("classifies a changed transaction at a verified boundary as an expected safety handoff", () => {
  const workDir = fixture();
  const sessionId = "chk_turkish_changed";
  writeTrace(workDir, sessionId, "1000", {
    at: "2026-08-10T13:00:00.000Z",
    observation: { page: {
      url: "https://www.turkishairlines.com/booking/payments",
      step: "payment",
      terminalEvidence: cardEntryEvidence(),
      transactionFacts: {
        itinerary: { completeness: "complete", segments: [{ origin: "LJU", destination: "IST" }] },
        travelers: [{ travelerId: "trav_1" }],
        totalPrice: { amount: 285, currency: "EUR" }
      }
    } },
    plannedAction: { type: "ask_user" },
    policyDecision: { code: "TRANSACTION_REVIEW_INCOMPLETE", decision: "request_approval" },
    debug: {
      transactionReview: {
        ready: false,
        missingFacts: [],
        contradictions: ["UNAPPROVED_PRICE_CHANGE"]
      }
    }
  });

  const report = summarizeCanary({ workDir, sessionId });
  assert.equal(report.result.classification, "expected_safety_handoff");
  assert.equal(report.result.paymentBoundaryVerified, true);
  assert.equal(report.result.transactionChanged, true);
  assert.deepEqual(report.result.transactionContradictions, ["UNAPPROVED_PRICE_CHANGE"]);
  assert.equal(report.safety.passed, true);
});

test("selects the most recently modified trace session", async () => {
  const workDir = fixture();
  writeTrace(workDir, "chk_old", "1000", { at: "2026-08-10T10:00:00.000Z" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  writeTrace(workDir, "chk_new", "2000", { at: "2026-08-10T10:01:00.000Z" });
  assert.equal(latestSessionId(workDir), "chk_new");
});
