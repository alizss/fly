const http = require("http");
const path = require("path");

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "127.0.0.1";
const ROOT = path.resolve(__dirname, "../..");
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = process.env.ATW_DATA_DIR || path.join(ROOT, "work");
const DIAGNOSTIC_DIR = process.env.ATW_DIAGNOSTIC_DIR || DATA_DIR;
const DB_FILE = process.env.ATW_PROFILE_DB || path.join(DATA_DIR, "air-travel-wallet-db.json");
const MAX_OBSERVATION_BYTES = 5_500_000;
const MAX_SCREENSHOT_UPLOAD_BYTES = 12_000_000;
const AGENT_MODEL = process.env.ATW_AGENT_MODEL || "gpt-4.1-mini";
const AGENT_RECOVERY_MODEL = process.env.ATW_AGENT_RECOVERY_MODEL || AGENT_MODEL;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const agentLoop = require("./agent/loop");
const agentSessionStore = require("./agent/session-store");
const agentTraceStore = require("./agent/trace-store");
const { agentLoopFailurePayload, createAgentLoopFailure } = require("./agent/http-errors");
const { createRequestDiagnostics, logAgent } = require("./agent/request-diagnostics");
const { createSessionService } = require("./agent/session-service");
const { createScreenshotStore } = require("./agent/screenshot-store");
const { createRequestPayloadAdapter } = require("./agent/request-payload");
const { createNextActionService } = require("./agent/next-action-service");
const { readBody } = require("./http/body");
const { sendJson } = require("./http/response");
const { createStaticHandler } = require("./http/static");
const { createAgentRoutes } = require("./routes/agent");
const { createWalletRoutes } = require("./routes/wallet");
const { createWalletStore } = require("./data/wallet-store");

function clampText(value, max = 4000) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

const { createAgentSession, reportAgentResult, summarizeAgentSession } = createSessionService(agentSessionStore);
const { screenshotForObservation, storeScreenshotUpload } = createScreenshotStore();
const { writeActionLedgerRow, writeClientFlowLog } = createRequestDiagnostics({
  diagnosticDir: DIAGNOSTIC_DIR,
  agentSessionStore
});
const walletStore = createWalletStore({
  dataDir: DATA_DIR,
  dbFile: DB_FILE,
  encryptionKey: process.env.ATW_ENCRYPTION_KEY || "local-dev-key-change-me"
});
const { compactAgentPayload } = createRequestPayloadAdapter({
  agentSessionStore,
  screenshotForObservation
});
const { decideAgentNextActionViaLoop } = createNextActionService({
  agentLoop,
  agentSessionStore,
  compactAgentPayload,
  createAgentLoopFailure,
  dataDir: DIAGNOSTIC_DIR,
  logAgent,
  model: AGENT_MODEL,
  openAiApiKey: OPENAI_API_KEY,
  recoveryModel: AGENT_RECOVERY_MODEL
});

const handleAgentRoutes = createAgentRoutes({
  MAX_OBSERVATION_BYTES,
  MAX_SCREENSHOT_UPLOAD_BYTES,
  agentLoopFailurePayload,
  agentSessionStore,
  agentTraceStore,
  clampText,
  createAgentSession,
  dataDir: DATA_DIR,
  decideAgentNextActionViaLoop,
  logAgent,
  readBody,
  reportAgentResult,
  sendJson,
  storeScreenshotUpload,
  summarizeAgentSession,
  writeActionLedgerRow,
  writeClientFlowLog
});

const handleWalletRoutes = createWalletRoutes({
  bootstrapPayload: walletStore.bootstrapPayload,
  extensionBootstrapPayload: walletStore.extensionBootstrapPayload,
  now: walletStore.now,
  readBody,
  sendJson,
  travelerFromBody: walletStore.travelerFromBody,
  uid: walletStore.uid,
  upsertTravelerDocument: walletStore.upsertTravelerDocument,
  writeDb: walletStore.writeDb
});

async function handleApi(req, res, pathname) {
  if (req.method === "OPTIONS") return sendJson(res, 204, {});
  if (await handleAgentRoutes(req, res, pathname)) return;
  const db = walletStore.readDb();
  if (await handleWalletRoutes(req, res, pathname, db)) return;

  sendJson(res, 404, { error: "Not found" });
}

const serveStatic = createStaticHandler(PUBLIC_DIR);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url.pathname);
    serveStatic(req, res, url.pathname);
  } catch (error) {
    if (error?.code && Number(error.status || 0) >= 400) {
      return sendJson(res, Number(error.status), {
        error: error.message || "Request failed",
        code: error.code,
        retryable: error.retryable === true,
        details: error.details || null
      });
    }
    console.error("Unhandled server request error:", error);
    sendJson(res, 500, {
      error: "Agent backend processing failed",
      code: "BACKEND_INTERNAL_ERROR",
      retryable: false
    });
  }
});

server.listen(PORT, HOST, () => {
  walletStore.ensureDb();
  console.log(`Air Travel Wallet running at http://localhost:${PORT}`);
});
