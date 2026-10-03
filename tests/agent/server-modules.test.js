const { EventEmitter } = require("events");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { readBody } = require("../../apps/web/http/body");
const { sendJson } = require("../../apps/web/http/response");
const { createStaticHandler } = require("../../apps/web/http/static");
const { createAgentRoutes } = require("../../apps/web/routes/agent");
const { createScreenshotStore } = require("../../apps/web/agent/screenshot-store");
const { createRequestPayloadAdapter } = require("../../apps/web/agent/request-payload");
const { createNextActionService } = require("../../apps/web/agent/next-action-service");
const { createSessionService } = require("../../apps/web/agent/session-service");
const {
  normalizeBookingProposal,
  proposeBookingCandidate
} = require("../../apps/web/agent/booking-proposal");
const {
  summarizeActionLedgerRow,
  summarizeClientFlowLog
} = require("../../apps/web/agent/request-diagnostics");
const { createWalletStore } = require("../../apps/web/data/wallet-store");
const { createCheckoutSessionState } = require("../../packages/shared/agent-state");

function request(body, headers = {}) {
  const req = new EventEmitter();
  req.headers = headers;
  queueMicrotask(() => {
    if (body) req.emit("data", Buffer.from(body));
    req.emit("end");
  });
  return req;
}

function response() {
  return {
    status: 0,
    headers: {},
    body: "",
    writeHead(status, headers = {}) {
      this.status = status;
      this.headers = headers;
    },
    end(body = "") {
      this.body = String(body);
    }
  };
}

function memorySessionStore() {
  const sessions = new Map();
  return {
    getSession: (id) => sessions.get(id) || null,
    getOrCreateSession(id, seed) {
      const session = createCheckoutSessionState(seed);
      if (id) session.id = id;
      sessions.set(session.id, session);
      return session;
    },
    saveSession(session) {
      sessions.set(session.id, session);
      return session;
    },
    recordActionResult: () => null
  };
}

function routineDevelopmentTraveler(id = "trav_development") {
  return {
    id,
    first_name: "Ali",
    last_name: "Example",
    date_of_birth: "2003-05-31",
    email: "ali@example.test",
    phone: "+38640111222",
    paid_extras_policy: "decline",
    standard_booking_terms: "accept",
    marketing_consent: "decline",
    payment_preference: "card",
    payment_submission: "never"
  };
}

test("only a development-enabled server can admit a mechanics run without SelectedBooking", () => {
  const body = {
    traveler: routineDevelopmentTraveler(),
    developmentCheckout: true,
    page: { site: "unfamiliar.test", url: "https://unfamiliar.test/passengers" }
  };
  const strict = createSessionService(memorySessionStore());
  assert.throws(
    () => strict.createAgentSession(body),
    (error) => error.code === "SELECTED_BOOKING_REQUIRED"
  );

  const development = createSessionService(memorySessionStore(), { allowDevelopmentCheckout: true });
  const session = development.createAgentSession(body);
  assert.equal(session.developmentCheckout, true);
  assert.equal(session.travelerId, "trav_development");
  assert.equal(session.transactionInvariants, null);
});

test("HTTP body parsing owns JSON, empty bodies, and typed size failures", async () => {
  assert.deepEqual(await readBody(request("")), {});
  assert.deepEqual(await readBody(request('{"ok":true}')), { ok: true });
  await assert.rejects(
    readBody(request("12345", { "content-length": "5" }), { maxBytes: 4, tooLargeCode: "TOO_BIG" }),
    (error) => error.code === "TOO_BIG" && error.status === 413
  );
});

test("JSON response owns the common API and CORS envelope", () => {
  const res = response();
  sendJson(res, 201, { ok: true });
  assert.equal(res.status, 201);
  assert.equal(res.headers["content-type"], "application/json");
  assert.equal(res.headers["access-control-allow-origin"], "*");
  assert.deepEqual(JSON.parse(res.body), { ok: true });
});

test("booking proposal accepts only a coherent itinerary and exact booking total", async () => {
  const calls = [];
  const result = await proposeBookingCandidate({
    apiKey: "test-key",
    model: "test-model",
    sourceUrl: "https://unfamiliar.test/checkout",
    pageText: "LJU to LGW 17 October 2026. Return 1 November 2026. Basket EUR 86.97.",
    screenshotDataUrl: "data:image/jpeg;base64,test",
    referenceDate: "2026-09-01",
    callStructuredFn: async (request) => {
      calls.push(request);
      return {
        data: {
          status: "proposed",
          segments: [
            { origin: "Ljubljana", originAliases: ["Ljubljana", "LJU"], destination: "London Gatwick", destinationAliases: ["London Gatwick", "LGW"], departureDate: "2026-10-17" },
            { origin: "London Gatwick", originAliases: ["London Gatwick", "LGW"], destination: "Ljubljana", destinationAliases: ["Ljubljana", "LJU"], departureDate: "2026-11-01" }
          ],
          approvedTotal: { amount: 86.97, currency: "eur" },
          confidence: "high",
          evidence: [{ fact: "booking total", value: "Basket €86.97", source: "screenshot" }]
        },
        meta: { attempts: 1 }
      };
    }
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].schemaName, "booking_proposal");
  assert.equal(calls[0].returnMeta, true);
  assert.equal(result.proposal.status, "proposed");
  assert.deepEqual(result.proposal.approvedTotal, { amount: 86.97, currency: "EUR" });
  assert.deepEqual(result.proposal.segments[0].originAliases, ["Ljubljana", "LJU"]);
});

test("booking proposal retains only structurally proven endpoint aliases", () => {
  const proposal = normalizeBookingProposal({
    status: "proposed",
    segments: [
      { origin: "Zagreb", originAliases: ["Zagreb"], destination: "Sarajevo", destinationAliases: ["Sarajevo"], departureDate: "2026-09-15" },
      { origin: "Sarajevo", originAliases: ["Sarajevo"], destination: "Zagreb", destinationAliases: ["Zagreb"], departureDate: "2026-09-30" }
    ],
    approvedTotal: { amount: 167.62, currency: "EUR" },
    confidence: "high",
    evidence: []
  }, {
    observed: {
      itinerary: {
        segments: [
          { origin: "ZAG", originAliases: ["ZAG", "Zagreb"], destination: "SJJ", destinationAliases: ["SJJ", "Sarajevo"], departureDate: "2026-09-15" },
          { origin: "SJJ", originAliases: ["SJJ", "Sarajevo"], destination: "ZAG", destinationAliases: ["ZAG", "Zagreb"], departureDate: "2026-09-30" }
        ]
      }
    }
  });

  assert.deepEqual(proposal.segments[0].originAliases, ["Zagreb", "ZAG"]);
  assert.deepEqual(proposal.segments[0].destinationAliases, ["Sarajevo", "SJJ"]);
});

test("booking proposal cannot turn partial or invalid model output into approval", () => {
  assert.deepEqual(
    normalizeBookingProposal({
      status: "proposed",
      segments: [{ origin: "LJU", destination: "LGW", departureDate: "17 October" }],
      approvedTotal: { amount: 49.99, currency: "EUR" },
      confidence: "high",
      evidence: []
    }),
    {
      status: "unknown",
      segments: [],
      approvedTotal: { amount: 0, currency: "" },
      confidence: "high",
      evidence: []
    }
  );
});

test("DEV booking proposal route is proposal-only and available without a durable session", async () => {
  let proposed = null;
  const handle = createAgentRoutes({
    MAX_OBSERVATION_BYTES: 1000,
    MAX_SCREENSHOT_UPLOAD_BYTES: 10_000,
    allowDevBookingProposal: true,
    agentLoopFailurePayload: (error) => ({ code: error.code }),
    agentSessionStore: { getSession: () => null },
    agentTraceStore: { listTraces: () => [] },
    clampText: (value, max) => String(value || "").slice(0, max),
    createAgentSession: () => null,
    dataDir: "",
    decideAgentNextActionViaLoop: () => assert.fail("loop must not run"),
    logAgent: () => {},
    model: "test-model",
    openAiApiKey: "test-key",
    proposeBookingCandidate: async (input) => {
      proposed = input;
      return {
        proposal: {
          status: "proposed",
          segments: [{ origin: "LJU", destination: "LGW", departureDate: "2026-10-17" }],
          approvedTotal: { amount: 86.97, currency: "EUR" },
          confidence: "high",
          evidence: []
        },
        meta: { attempts: 1 }
      };
    },
    readBody,
    reportAgentResult: () => null,
    sendJson,
    storeScreenshotUpload: () => "",
    summarizeAgentSession: (session) => session,
    writeActionLedgerRow: async () => ({}),
    writeClientFlowLog: async () => ({})
  });
  const req = request(JSON.stringify({
    sourceUrl: "https://unfamiliar.test/checkout",
    pageText: "visible booking",
    screenshotDataUrl: "data:image/jpeg;base64,test"
  }));
  req.method = "POST";
  const res = response();
  assert.equal(await handle(req, res, "/api/agent/dev/booking-proposal"), true);
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).proposal.status, "proposed");
  assert.equal(proposed.apiKey, "test-key");
  assert.equal(proposed.model, "test-model");
  assert.equal(proposed.screenshotDataUrl, "data:image/jpeg;base64,test");
});

test("static handler preserves app routes and rejects path traversal", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fly-static-"));
  fs.writeFileSync(path.join(directory, "index.html"), "ok");
  const serveStatic = createStaticHandler(directory);
  const appResponse = response();
  const chunks = [];
  appResponse.write = (chunk) => chunks.push(Buffer.from(chunk));
  appResponse.on = () => appResponse;
  appResponse.once = () => appResponse;
  appResponse.emit = () => true;
  serveStatic({}, appResponse, "/dashboard");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(appResponse.status, 200);

  const forbidden = response();
  serveStatic({}, forbidden, "/../secret");
  assert.equal(forbidden.status, 403);
});

test("agent route rejects planning without replacing the durable session", async () => {
  const timings = [];
  const handle = createAgentRoutes({
    MAX_OBSERVATION_BYTES: 1000,
    MAX_SCREENSHOT_UPLOAD_BYTES: 1000,
    agentLoopFailurePayload: (error) => ({ code: error.code }),
    agentSessionStore: { getSession: () => null },
    agentTraceStore: { listTraces: () => [] },
    clampText: (value) => String(value || ""),
    createAgentSession: () => null,
    dataDir: "",
    decideAgentNextActionViaLoop: () => assert.fail("loop must not run"),
    logAgent: (_label, value) => timings.push(value),
    readBody,
    reportAgentResult: () => null,
    sendJson,
    storeScreenshotUpload: () => "",
    summarizeAgentSession: (session) => session,
    writeActionLedgerRow: async () => ({}),
    writeClientFlowLog: async () => ({})
  });
  const req = request("{}");
  req.method = "POST";
  const res = response();
  assert.equal(await handle(req, res, "/api/agent/next-action"), true);
  assert.equal(res.status, 409);
  assert.equal(JSON.parse(res.body).code, "DURABLE_SESSION_REQUIRED");
  assert.equal(timings.at(-1).outcome, "durable_session_required");
});

test("next-action joins a compact browser receipt to its durable governed action", async () => {
  const governedAction = {
    id: "act_compact_country",
    type: "click",
    operation: "select",
    controlId: "ctrl_country",
    targetLabel: "Turkey",
    pipelineContract: {
      expectedOutcome: {
        type: "logical_component_committed",
        controlId: "ctrl_country",
        expectedCanonicalValue: "tr"
      }
    }
  };
  const compactReceipt = {
    actionId: governedAction.id,
    observationId: "obs_country_before",
    resultObservationHash: "hash_country_after",
    dispatched: true,
    executed: true,
    verified: true,
    expectedOutcomeObserved: true,
    postconditionSatisfied: true,
    failureCode: "",
    actionOutcome: {
      contractVersion: "action-outcome/v1",
      status: "SATISFIED",
      causedByActionId: governedAction.id,
      exactPostconditionSatisfied: true,
      code: "LOGICAL_COMPONENT_COMMITTED"
    }
  };
  let loopObservation = null;
  const state = {
    id: "chk_compact_receipt",
    goal: "Reach card entry",
    travelerId: "trav_compact_receipt",
    userPolicy: {},
    approvals: {},
    site: {},
    stallCount: 0
  };
  const service = createNextActionService({
    agentLoop: {
      runLoopTurn: async ({ observation }) => {
        loopObservation = observation;
        return {
          state,
          clientDecision: { action: "wait", actionId: "", reason: "test complete" },
          debug: { deterministic: true, latency: {}, modelUsage: {} }
        };
      }
    },
    agentSessionStore: {
      getSession: () => state,
      getObservation: () => null,
      getPendingActionResult: () => null,
      getGovernedAction: (actionId) => actionId === governedAction.id
        ? { action: governedAction }
        : null,
      recordObservation: () => null
    },
    compactAgentPayload: (body) => body,
    createAgentLoopFailure: (error) => error,
    dataDir: "",
    logAgent: () => {},
    model: "test-model",
    openAiApiKey: "",
    recoveryModel: "test-model"
  });

  await service.decideAgentNextActionViaLoop({
    sessionId: state.id,
    clientTurnId: "turn_compact_receipt",
    observationId: "obs_country_after",
    observationSnapshot: { snapshotHash: "hash_country_after" },
    page: { site: "gateway.test", url: "https://gateway.test/pay", step: "traveler_information" },
    traveler: { id: state.travelerId },
    approvalState: {},
    lastActionResult: compactReceipt
  });

  assert.deepEqual(loopObservation.lastActionResult.action, governedAction);
  assert.deepEqual(
    loopObservation.lastActionResult.expectedOutcome,
    governedAction.pipelineContract.expectedOutcome
  );
  assert.equal(loopObservation.lastActionResult.actionOutcome, compactReceipt.actionOutcome);
  assert.equal(compactReceipt.action, undefined);
});

test("screenshot references remain bounded to their durable session and observation", () => {
  const screenshots = createScreenshotStore({ maxEntries: 2 });
  const screenshotId = screenshots.storeScreenshotUpload({
    sessionId: "chk_1",
    observationId: "obs_1",
    screenshotDataUrl: "data:image/jpeg;base64,YQ=="
  });
  assert.equal(
    screenshots.screenshotForObservation({ screenshotId }, { sessionId: "chk_1", observationId: "obs_1" }).screenshotDataUrl,
    "data:image/jpeg;base64,YQ=="
  );
  assert.throws(
    () => screenshots.screenshotForObservation({ screenshotId }, { sessionId: "chk_2", observationId: "obs_1" }),
    (error) => error.code === "SCREENSHOT_SESSION_MISMATCH"
  );
});

test("reference observations replace the prior screenshot with the current observation reference", () => {
  const previous = {
    observationSnapshot: { snapshotHash: "hash_same_page" },
    page: {
      snapshotHash: "hash_same_page",
      screenshotId: "shot_previous_observation",
      screenshotAnnotations: [{ visualRef: "F0" }]
    }
  };
  const { hydrateIncrementalAgentBody } = createRequestPayloadAdapter({
    agentSessionStore: { getCurrentObservation: () => previous },
    screenshotForObservation: () => ({ screenshotId: "", screenshotDataUrl: "" })
  });
  const hydrated = hydrateIncrementalAgentBody({
    sessionId: "chk_reference",
    observationId: "obs_current",
    observationUpdate: {
      mode: "reference",
      baseSnapshotHash: "hash_same_page",
      snapshotHash: "hash_same_page"
    },
    page: {
      referenceOnly: true,
      snapshotHash: "hash_same_page",
      screenshotId: "shot_current_observation",
      screenshotAnnotations: [{ visualRef: "F1" }]
    }
  });

  assert.equal(hydrated.page.screenshotId, "shot_current_observation");
  assert.deepEqual(hydrated.page.screenshotAnnotations, [{ visualRef: "F1" }]);
  assert.equal(hydrated.page.referenceOnly, false);
});

test("wallet store owns encrypted persistence and extension-only document disclosure", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fly-wallet-"));
  const dbFile = path.join(directory, "wallet.json");
  const store = createWalletStore({
    dataDir: directory,
    dbFile,
    encryptionKey: "test-key"
  });
  const db = store.readDb();
  const dashboard = store.bootstrapPayload(db);
  const extension = store.extensionBootstrapPayload(db);

  assert.equal(dashboard.travelers.length, 1);
  assert.equal(dashboard.travelers[0].document.document_number, undefined);
  assert.equal(extension.travelers[0].document.document_number, "P1234567");
  assert.doesNotMatch(fs.readFileSync(dbFile, "utf8"), /P1234567/);
  assert.throws(
    () => store.travelerFromBody({ first_name: "Maya", date_of_birth: "2026-02-31" }),
    (error) => error.code === "INVALID_DATE_OF_BIRTH" && error.status === 400
  );
});

test("request diagnostics project bounded searchable summaries", () => {
  const flow = summarizeClientFlowLog({
    sessionId: "chk_1",
    entry: {
      phase: "execute",
      payload: {
        actionId: "act_1",
        action: "click",
        targetLabel: "Continue",
        page: { site: "easyjet", step: "bags", visibleControls: [{}, {}] }
      }
    }
  });
  const ledger = summarizeActionLedgerRow({
    transactionId: "chk_1",
    action: { type: "click", targetLabel: "Skip bags" },
    result: { ok: true }
  });

  assert.deepEqual(
    { phase: flow.phase, target: flow.target, controls: flow.controls },
    { phase: "execute", target: "Continue", controls: 2 }
  );
  assert.deepEqual(
    { target: ledger.target, result: ledger.result },
    { target: "Skip bags", result: "ok" }
  );
});
