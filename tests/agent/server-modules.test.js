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
const {
  summarizeActionLedgerRow,
  summarizeClientFlowLog
} = require("../../apps/web/agent/request-diagnostics");
const { createWalletStore } = require("../../apps/web/data/wallet-store");

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
