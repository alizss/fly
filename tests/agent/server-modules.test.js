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
