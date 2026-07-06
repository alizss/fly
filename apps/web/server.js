const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "127.0.0.1";
const ROOT = path.resolve(__dirname, "../..");
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(ROOT, "work");
const DB_FILE = path.join(DATA_DIR, "air-travel-wallet-db.json");
const KEY = crypto.createHash("sha256").update(process.env.ATW_ENCRYPTION_KEY || "local-dev-key-change-me").digest();
const AGENT_MODEL = process.env.ATW_AGENT_MODEL || "gpt-4.1-mini";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const agentSessions = new Map();

function uid(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function now() {
  return new Date().toISOString();
}

function pruneAgentSessions() {
  const cutoff = Date.now() - 1000 * 60 * 60 * 6;
  for (const [id, session] of agentSessions.entries()) {
    if (new Date(session.updated_at).getTime() < cutoff) agentSessions.delete(id);
  }
}

function summarizeAgentSession(session) {
  if (!session) return null;
  return {
    id: session.id,
    status: session.status,
    goal: session.goal,
    currentStage: session.currentStage,
    travelerName: session.travelerName,
    approvals: session.approvals,
    completedFields: [...session.completedFields].slice(-30),
    lockedFields: session.lockedFields || {},
    retryCounts: session.retryCounts,
    lastAction: session.lastAction,
    lastResult: session.lastResult,
    lastPageSummary: session.lastPageSummary,
    failures: session.failures.slice(-8),
    events: session.events.slice(-12).map((event) => ({
      at: event.at,
      type: event.type,
      summary: event.summary || "",
      ok: event.ok,
      stage: event.stage
    }))
  };
}

function createAgentSession(body = {}) {
  pruneAgentSessions();
  const traveler = body.traveler || {};
  const session = {
    id: uid("agt"),
    created_at: now(),
    updated_at: now(),
    status: "running",
    goal: clampText(body.goal || body.userIntent || "Complete checkout safely.", 500),
    travelerId: clampText(traveler.id || body.travelerId || "", 120),
    travelerName: clampText([traveler.first_name, traveler.middle_name, traveler.last_name].filter(Boolean).join(" ") || body.travelerName || "", 160),
    currentStage: "unknown",
    approvals: {
      skipPaidExtrasApproved: false,
      paymentApproved: false,
      legalApproved: false
    },
    completedFields: [],
    lockedFields: {},
    retryCounts: {},
    lastAction: null,
    lastResult: null,
    lastPageSummary: null,
    failures: [],
    events: []
  };
  agentSessions.set(session.id, session);
  return session;
}

function getAgentSession(id) {
  if (!id) return null;
  const session = agentSessions.get(id);
  if (!session) return null;
  session.updated_at = now();
  return session;
}

function rememberAgentEvent(session, event) {
  if (!session) return;
  const safeEvent = {
    at: now(),
    type: clampText(event.type || "event", 80),
    ok: typeof event.ok === "boolean" ? event.ok : undefined,
    stage: clampText(event.stage || session.currentStage || "unknown", 80),
    summary: clampText(event.summary || event.message || "", 280),
    payload: event.payload || {}
  };
  session.events.push(safeEvent);
  session.events = session.events.slice(-80);
  session.updated_at = safeEvent.at;
}

function updateAgentSessionFromPayload(session, payload) {
  if (!session) return null;
  session.currentStage = payload.page?.step || session.currentStage || "unknown";
  session.approvals = {
    ...session.approvals,
    ...(payload.approvalState || {})
  };
  session.lastPageSummary = {
    site: payload.page?.site,
    step: payload.page?.step,
    errors: payload.page?.errors || [],
    paidChoices: payload.page?.paidChoices || [],
    overlays: payload.page?.overlays || [],
    sectionProgress: payload.page?.sectionProgress || {},
    sections: (payload.page?.sections || []).map((section) => ({
      label: section.label,
      type: section.type,
      status: section.status,
      objective: section.objective
    })).slice(0, 20),
    taskQueue: (payload.page?.taskQueue || []).map((task) => ({
      sectionLabel: task.sectionLabel,
      sectionType: task.sectionType,
      status: task.status,
      objective: task.objective
    })).slice(0, 30),
    coverage: payload.page?.coverage || {},
    fields: payload.page?.fields?.length || 0,
    buttons: payload.page?.buttons?.length || 0
  };
  rememberAgentEvent(session, {
    type: "observe_page",
    stage: session.currentStage,
    ok: !(payload.page?.errors || []).length,
    summary: `${payload.page?.site || "site"} ${payload.page?.step || "unknown"}: ${(payload.page?.fields || []).length} fields, ${(payload.page?.buttons || []).length} actions, ${(payload.page?.sections || []).length} sections`
  });
  return session;
}

function reportAgentResult(body = {}) {
  const session = getAgentSession(body.sessionId);
  if (!session) return null;
  const result = body.result || {};
  const action = result.action || result.type || "";
  const target = result.target || result.fieldType || result.label || "";
  const ok = Boolean(result.ok);
  const signature = clampText([action, target, result.stage || session.currentStage].filter(Boolean).join("|"), 220);

  session.lastAction = {
    action: clampText(action, 80),
    target: clampText(target, 160),
    stage: clampText(result.stage || session.currentStage, 80)
  };
  session.lastResult = {
    ok,
    message: clampText(result.message || result.reason || "", 300),
    errors: Array.isArray(result.errors) ? result.errors.map((item) => clampText(item, 160)).slice(0, 6) : []
  };
  if (ok && result.fieldType) {
    session.completedFields = [...new Set([...session.completedFields, clampText(result.fieldType, 80)])];
    session.lockedFields = {
      ...(session.lockedFields || {}),
      [clampText(result.fieldType, 80)]: clampText(result.value || result.payload?.value || result.message || "accepted", 180)
    };
  }
  if (!ok) {
    session.retryCounts[signature] = (session.retryCounts[signature] || 0) + 1;
    session.failures.push({
      at: now(),
      signature,
      message: session.lastResult.message,
      errors: session.lastResult.errors
    });
    session.failures = session.failures.slice(-20);
  }
  rememberAgentEvent(session, {
    type: "action_result",
    stage: result.stage || session.currentStage,
    ok,
    summary: result.message || `${action || "action"} ${ok ? "worked" : "failed"}`,
    payload: {
      action,
      target,
      errors: session.lastResult.errors
    }
  });
  return session;
}

function encryptSensitive(value) {
  if (!value) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${tag.toString("base64")}.${encrypted.toString("base64")}`;
}

function decryptSensitive(value) {
  if (!value) return "";
  const [iv, tag, encrypted] = String(value).split(".");
  const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]).toString("utf8");
}

function last4(value) {
  const cleaned = String(value || "").replace(/\s+/g, "");
  return cleaned.slice(-4);
}

function maskDocument(prefix, documentLast4) {
  if (!documentLast4) return "Not added";
  return `${prefix || "P"}****${documentLast4}`;
}

function seedDb() {
  const workspaceId = uid("wrk");
  const travelerId = uid("trav");
  const tripId = uid("trip");
  return {
    workspaces: [
      {
        id: workspaceId,
        name: "Northstar Ops",
        owner_user_id: "local_user",
        created_at: now()
      }
    ],
    workspace_members: [
      {
        id: uid("mem"),
        workspace_id: workspaceId,
        user_id: "local_user",
        email: "ops@example.com",
        role: "owner",
        created_at: now()
      }
    ],
    traveler_profiles: [
      {
        id: travelerId,
        workspace_id: workspaceId,
        created_by_user_id: "local_user",
        first_name: "Maya",
        middle_name: "",
        last_name: "Patel",
        date_of_birth: "1990-04-12",
        gender: "female",
        nationality: "US",
        email: "maya@example.com",
        phone: "+1 415 555 0199",
        preferred_seat: "aisle",
        baggage_preference: "cabin bag",
        default_cabin: "economy",
        invoice_company: "Northstar Ops LLC",
        billing_tax_id: "US-123456789",
        billing_address: "22 Market Street, San Francisco, CA 94105",
        billing_email: "invoices@example.com",
        payment_preference: "browser saved card",
        booking_rules: "Avoid paid seats, insurance, support bundles, SMS updates, and paid extras unless I explicitly approve. Stop before real payment.",
        created_at: now(),
        updated_at: now()
      }
    ],
    traveler_documents: [
      {
        id: uid("doc"),
        traveler_profile_id: travelerId,
        document_type: "passport",
        issuing_country: "US",
        encrypted_document_number: encryptSensitive("P1234567"),
        document_number_last4: "4567",
        expiry_date: "2026-10-20",
        created_at: now(),
        updated_at: now()
      }
    ],
    trips: [
      {
        id: tripId,
        workspace_id: workspaceId,
        traveler_profile_id: travelerId,
        created_by_user_id: "local_user",
        airline: "Demo Air",
        seller: "airline direct",
        origin_airport: "SFO",
        destination_airport: "LHR",
        departure_at: "2026-09-18T09:30:00.000Z",
        return_at: "2026-09-24T16:00:00.000Z",
        booking_reference: "DEMO42",
        ticket_number: "",
        price_amount: 642,
        price_currency: "USD",
        baggage_summary: "Personal item only",
        booking_url: "http://localhost:4173/demo/checkout",
        status: "booked",
        invoice_status: "missing",
        warnings: ["Baggage may not be included.", "This city has multiple airports. Confirm the correct airport."],
        notes: "Seed trip for dashboard preview.",
        created_at: now(),
        updated_at: now()
      }
    ],
    invites: [],
    preferences: {
      selected_traveler_id: travelerId
    }
  };
}

function ensureDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify(seedDb(), null, 2));
  }
}

function readDb() {
  ensureDb();
  const db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  let changed = false;
  for (const traveler of db.traveler_profiles || []) {
    const defaults = {
      billing_tax_id: "US-123456789",
      billing_address: "22 Market Street, San Francisco, CA 94105",
      billing_email: traveler.email || "invoices@example.com",
      payment_preference: "browser saved card",
      booking_rules: "Avoid paid seats, insurance, support bundles, SMS updates, and paid extras unless I explicitly approve. Stop before real payment."
    };
    for (const [key, value] of Object.entries(defaults)) {
      if (traveler[key] === undefined) {
        traveler[key] = value;
        changed = true;
      }
    }
    if (!traveler.gender && traveler.first_name === "Maya" && traveler.last_name === "Patel") {
      traveler.gender = "female";
      changed = true;
    }
  }
  if (!db.preferences) {
    db.preferences = { selected_traveler_id: db.traveler_profiles?.[0]?.id || "" };
    changed = true;
  }
  if (!db.preferences.selected_traveler_id && db.traveler_profiles?.[0]?.id) {
    db.preferences.selected_traveler_id = db.traveler_profiles[0].id;
    changed = true;
  }
  if (changed) writeDb(db);
  return db;
}

function writeDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function publicTraveler(db, traveler) {
  const document = db.traveler_documents.find((doc) => doc.traveler_profile_id === traveler.id);
  return {
    ...traveler,
    document: document
      ? {
          id: document.id,
          document_type: document.document_type,
          issuing_country: document.issuing_country,
          document_number_last4: document.document_number_last4,
          masked_document_number: maskDocument("P", document.document_number_last4),
          expiry_date: document.expiry_date
        }
      : null
  };
}

function extensionTraveler(db, traveler) {
  const document = db.traveler_documents.find((doc) => doc.traveler_profile_id === traveler.id);
  return {
    ...publicTraveler(db, traveler),
    document: document
      ? {
          id: document.id,
          document_type: document.document_type,
          issuing_country: document.issuing_country,
          document_number: decryptSensitive(document.encrypted_document_number),
          document_number_last4: document.document_number_last4,
          masked_document_number: maskDocument("P", document.document_number_last4),
          expiry_date: document.expiry_date
        }
      : null
  };
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type"
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 6_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function clampText(value, max = 4000) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function compactAgentPayload(body) {
  const page = body.page || {};
  const traveler = body.traveler || {};
  const screenshotDataUrl = String(page.screenshotDataUrl || "");
  const sections = Array.isArray(page.sections)
    ? page.sections.map((section) => ({
        id: clampText(section.id, 80),
        label: clampText(section.label, 120),
        type: clampText(section.type, 80),
        order: Number(section.order || 0),
        status: clampText(section.status, 80),
        required: Boolean(section.required),
        paidChoice: Boolean(section.paidChoice),
        objective: clampText(section.objective, 260),
        selected: Array.isArray(section.selected) ? section.selected.map((item) => clampText(item, 120)).slice(0, 8) : [],
        box: section.box || null,
        fields: Array.isArray(section.fields)
          ? section.fields.map((field) => ({
              id: clampText(field.id, 80),
              label: clampText(field.label, 160),
              field: clampText(field.field, 80),
              kind: clampText(field.kind, 40),
              required: Boolean(field.required),
              hasValue: Boolean(field.hasValue),
              box: field.box || null
            })).slice(0, 20)
          : [],
        buttons: Array.isArray(section.buttons)
          ? section.buttons.map((button) => ({
              id: clampText(button.id, 80),
              label: clampText(button.label, 160),
              risk: clampText(button.risk, 80),
              box: button.box || null
            })).slice(0, 20)
          : [],
        text: clampText(section.text, 900)
      })).slice(0, 20)
    : [];
  const taskQueue = Array.isArray(page.taskQueue)
    ? page.taskQueue.map((task) => ({
        id: clampText(task.id, 80),
        sectionId: clampText(task.sectionId, 80),
        sectionLabel: clampText(task.sectionLabel, 120),
        sectionType: clampText(task.sectionType, 80),
        order: Number(task.order || 0),
        status: clampText(task.status, 80),
        objective: clampText(task.objective, 260),
        rule: clampText(task.rule, 260)
      })).slice(0, 30)
    : [];
  return {
    sessionId: clampText(body.sessionId || "", 120),
    userIntent: clampText(body.userIntent || "Complete checkout safely for the selected traveler.", 800),
    userMessage: clampText(body.userMessage || "", 800),
    approvalState: {
      skipPaidExtrasApproved: Boolean(body.approvalState?.skipPaidExtrasApproved),
      paymentApproved: Boolean(body.approvalState?.paymentApproved)
    },
    actionHistory: Array.isArray(body.actionHistory)
      ? body.actionHistory.map((item) => ({
          type: clampText(item.type, 80),
          payload: item.payload || {}
        })).slice(-12)
      : [],
    traveler: {
      id: clampText(traveler.id, 120),
      first_name: clampText(traveler.first_name, 80),
      middle_name: clampText(traveler.middle_name, 80),
      last_name: clampText(traveler.last_name, 80),
      name: clampText([traveler.first_name, traveler.middle_name, traveler.last_name].filter(Boolean).join(" "), 120),
      email: clampText(traveler.email, 160),
      phone: clampText(traveler.phone, 80),
      gender: clampText(traveler.gender, 40),
      date_of_birth: clampText(traveler.date_of_birth, 40),
      nationality: clampText(traveler.nationality, 80),
      payment_preference: clampText(traveler.payment_preference, 120),
      baggage_preference: clampText(traveler.baggage_preference, 120),
      preferred_seat: clampText(traveler.preferred_seat, 120),
      booking_rules: clampText(traveler.booking_rules, 800),
      document: traveler.document ? {
        document_type: clampText(traveler.document.document_type, 60),
        issuing_country: clampText(traveler.document.issuing_country, 80),
        expiry_date: clampText(traveler.document.expiry_date, 40),
        document_number_last4: clampText(traveler.document.document_number_last4, 20),
        has_document_number: Boolean(traveler.document.document_number)
      } : null
    },
    page: {
      site: clampText(page.site, 80),
      url: clampText(page.url, 500),
      step: clampText(page.step, 80),
      screenshotDataUrl: screenshotDataUrl.startsWith("data:image/") ? screenshotDataUrl.slice(0, 5_000_000) : "",
      coverage: page.coverage || {},
      visibleText: clampText(page.text || page.fullText, 6000),
      errors: Array.isArray(page.errors) ? page.errors.map((item) => clampText(item, 220)).slice(0, 8) : [],
      paidChoices: Array.isArray(page.paidChoices) ? page.paidChoices.map((item) => clampText(item, 160)).slice(0, 8) : [],
      sectionProgress: page.sectionProgress && typeof page.sectionProgress === "object" ? page.sectionProgress : {},
      sections,
      taskQueue,
      fields: Array.isArray(page.fields)
        ? page.fields.map((field) => ({
            id: clampText(field.id, 80),
            label: clampText(field.label, 220),
            box: field.box || null,
            kind: clampText(field.kind, 40),
            field: clampText(field.field, 80),
            required: Boolean(field.required),
            hasValue: Boolean(field.value),
            confidence: Number(field.confidence || 0)
          })).slice(0, 80)
        : [],
      buttons: Array.isArray(page.buttons)
        ? page.buttons.map((button) => ({
            id: clampText(button.id, 80),
            label: clampText(button.label, 180),
            box: button.box || null,
            risk: clampText(button.risk, 80)
          })).slice(0, 80)
        : [],
      overlays: Array.isArray(page.overlays)
        ? page.overlays.map((overlay) => ({
            id: clampText(overlay.id, 80),
            label: clampText(overlay.label, 220),
            box: overlay.box || null,
            role: clampText(overlay.role, 80)
          })).slice(0, 20)
        : [],
      summary: page.summary || {}
    }
  };
}

function aiUnavailableDecision(reason) {
  return {
    source: "system",
    action: "stop",
    targetId: "",
    value: "",
    message: `AI agent unavailable: ${sanitizeAgentError(reason)}. I stopped because AI-only mode is enabled.`,
    needsApproval: true,
    risk: "uncertain",
    reason: "AI-only mode: OpenAI must provide the next browser action."
  };
}

function sanitizeAgentError(reason) {
  const text = clampText(reason, 220)
    .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted-key]")
    .replace(/sk-proj-[A-Za-z0-9_*.-]+/g, "[redacted-key]");
  if (/incorrect api key/i.test(text)) return "OpenAI rejected the configured API key";
  if (/OPENAI_API_KEY is not set/i.test(text)) return "OPENAI_API_KEY is not set";
  return text;
}

function normalizeAgentDecision(decision) {
  const allowedActions = new Set(["click", "type", "select", "fill_known_fields", "ask_user", "final_review", "save_trip", "wait", "stop"]);
  const allowedRisks = new Set(["safe", "money", "payment", "legal", "uncertain"]);
  const action = allowedActions.has(decision?.action) ? decision.action : "stop";
  const risk = allowedRisks.has(decision?.risk) ? decision.risk : "uncertain";
  return {
    source: "openai",
    action,
    targetId: clampText(decision?.targetId || "", 120),
    value: clampText(decision?.value || "", 600),
    message: clampText(decision?.message || "The AI returned an incomplete action, so I stopped.", 600),
    needsApproval: Boolean(decision?.needsApproval),
    risk,
    reason: clampText(decision?.reason || "Validated OpenAI structured action.", 400)
  };
}

function extractResponseText(response) {
  if (typeof response.output_text === "string") return response.output_text;
  for (const item of response.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) return content.text;
    }
  }
  return "";
}

function adapterHints(site) {
  const hints = {
    gotogate: [
      "GoToGate commonly shows paid bundles, baggage, SMS updates, AirHelp, and cancellation guarantee upsells.",
      "Treat Configure your trip, Select baggage, bundle, voucher refund, and cancellation guarantee as extras, not payment.",
      "Prefer No thanks / no checked baggage / no add-on when approvalState.skipPaidExtrasApproved is true; that approval may come from the saved traveler profile rules.",
      "Do not infer payment step from an order summary mentioning payment options."
    ],
    "croatia-airlines": [
      "Croatia Airlines checkout may use custom controls and step progress labels.",
      "Use active page content and visible required-field errors over inactive stepper labels.",
      "Stop before any final purchase or payment submission."
    ],
    skyscanner: [
      "Skyscanner is usually flight search/redirect, not final checkout.",
      "Summarize selected itinerary and expect redirect to airline or OTA checkout.",
      "After redirect, reclassify the new seller page from scratch."
    ],
    demo: [
      "Local demo pages use data attributes for safe test actions.",
      "Demo payment may be clicked only when the demo payment action is explicitly selected."
    ],
    generic: [
      "Prefer visible labels, ARIA labels, and nearby text to infer fields and safe actions.",
      "If page structure is unclear, ask the user instead of guessing."
    ]
  };
  return hints[site] || hints.generic;
}

async function callOpenAiAgent(payload) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");
  const screenshotDataUrl = payload.page?.screenshotDataUrl || "";
  const promptPayload = {
    ...payload,
    page: {
      ...payload.page,
      screenshotDataUrl: screenshotDataUrl ? "[attached separately]" : ""
    },
    adapterHints: adapterHints(payload.page?.site)
  };
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["action", "targetId", "value", "message", "needsApproval", "risk", "reason"],
    properties: {
      action: { type: "string", enum: ["click", "type", "select", "fill_known_fields", "ask_user", "final_review", "save_trip", "wait", "stop"] },
      targetId: { type: "string" },
      value: { type: "string" },
      message: { type: "string" },
      needsApproval: { type: "boolean" },
      risk: { type: "string", enum: ["safe", "money", "payment", "legal", "uncertain"] },
      reason: { type: "string" }
    }
  };
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "authorization": `Bearer ${OPENAI_API_KEY}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: AGENT_MODEL,
      instructions: [
        "You are the planning brain for Air Travel Wallet, a browser checkout copilot.",
        "Return one structured action only. The Chrome extension will validate and execute it.",
        "Never approve payment, final booking, legal terms, or price increases without asking the user.",
        "Routine declines of paid extras are safe when approvalState.skipPaidExtrasApproved is true because that reflects saved traveler profile rules.",
        "Follow traveler.booking_rules as durable user preference context unless the user says otherwise in the current chat.",
        "Do not ask the user for saved traveler/profile details that are present in traveler or can be filled by fill_known_fields.",
        "If contact or passenger fields are visible and empty, prefer fill_known_fields before asking the user.",
        "If traveler.booking_rules says avoid/no paid extras, no seats, no insurance, no bundles, or no add-ons, treat routine decline/skip/no-thanks choices as safe.",
        "Use page.sections as the current page decomposition. Each section has type, status, objective, fields, buttons, selected values, and coordinates.",
        "Use page.taskQueue as the ordered work plan. Prefer the first task with status pending, and do not jump ahead unless a visible interrupt requires it.",
        "If any page.taskQueue item before Continue is pending, do not click Continue yet. Resolve the pending section first.",
        "If the only pending task is Continue and no overlay/dropdown/error/loading state is active, choose the visible safe Continue/Next button.",
        "Do not modify sections whose status is complete unless page.errors explicitly targets that section.",
        "Prefer filling known traveler fields, declining routine paid extras when approvalState.skipPaidExtrasApproved is true, and clicking safe Continue buttons.",
        "When skipPaidExtrasApproved is true and an overlay is a seat, baggage, bundle, cancellation, flexible ticket, insurance, or add-on popup, do not ask the user; choose the safe decline/skip/next action if one is available.",
        "Do not select controls that are already selected; if skip choices are already selected, proceed with a safe Continue action.",
        "Use element boxes to match screenshot-visible controls to targetIds; prefer visible primary/bottom Continue buttons over header/footer or skip links.",
        "If an element appears outside the active checkout content, avoid it unless no safer target exists.",
        "Use the screenshot as visual context when DOM text is incomplete or confusing.",
        "If page.overlays contains a visible dialog, menu, or listbox, resolve that overlay before assuming the previous page is done.",
        "If page.overlays is non-empty, the overlay owns the next action. Do not continue working on background page sections until it closes.",
        "Use actionHistory to avoid repeating actions that already failed verification.",
        "Use adapter hints as guidance, but trust current visible page state over assumptions.",
        "Choose targetId only from the provided fields/buttons. Use empty string when no target is needed.",
        "If unsure, ask_user with a short clear question.",
        "The reason field is a concise user-visible rationale, not hidden chain-of-thought."
      ].join(" "),
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: JSON.stringify(promptPayload) },
            ...(screenshotDataUrl ? [{ type: "input_image", image_url: screenshotDataUrl }] : [])
          ]
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "checkout_agent_action",
          strict: true,
          schema
        }
      },
      max_output_tokens: 700
    })
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI agent request failed: ${response.status} ${errorText.slice(0, 200)}`);
  }
  const data = await response.json();
  return JSON.parse(extractResponseText(data));
}

async function decideAgentNextAction(body) {
  const payload = compactAgentPayload(body);
  const existingSession = getAgentSession(payload.sessionId);
  const session = updateAgentSessionFromPayload(existingSession, payload);
  if (session) payload.taskState = summarizeAgentSession(session);
  try {
    const aiDecision = await callOpenAiAgent(payload);
    if (!aiDecision) return aiUnavailableDecision("OpenAI returned no decision");
    return normalizeAgentDecision({ ...aiDecision, source: "openai" });
  } catch (error) {
    return aiUnavailableDecision(error.message);
  }
}

function bootstrapPayload(db) {
  return {
    workspaces: db.workspaces,
    members: db.workspace_members,
    travelers: db.traveler_profiles.map((traveler) => publicTraveler(db, traveler)),
    trips: db.trips,
    invites: db.invites,
    preferences: db.preferences || {}
  };
}

function extensionBootstrapPayload(db) {
  return {
    workspaces: db.workspaces,
    travelers: db.traveler_profiles.map((traveler) => extensionTraveler(db, traveler)),
    trips: db.trips,
    preferences: db.preferences || {}
  };
}

function travelerFromBody(body, existing = {}) {
  return {
    ...existing,
    workspace_id: body.workspace_id || existing.workspace_id || "",
    created_by_user_id: existing.created_by_user_id || "local_user",
    first_name: String(body.first_name || "").trim(),
    middle_name: String(body.middle_name || "").trim(),
    last_name: String(body.last_name || "").trim(),
    date_of_birth: body.date_of_birth || "",
    gender: body.gender || "",
    nationality: body.nationality || "",
    email: body.email || "",
    phone: body.phone || "",
    preferred_seat: body.preferred_seat || "no preference",
    baggage_preference: body.baggage_preference || "personal item",
    default_cabin: body.default_cabin || "economy",
    invoice_company: body.invoice_company || "",
    billing_tax_id: body.billing_tax_id || "",
    billing_address: body.billing_address || "",
    billing_email: body.billing_email || body.email || "",
    payment_preference: body.payment_preference || "browser saved card",
    booking_rules: body.booking_rules || "Avoid paid seats, insurance, support bundles, SMS updates, and paid extras unless I explicitly approve. Stop before real payment.",
    updated_at: now()
  };
}

function upsertTravelerDocument(db, travelerId, body) {
  const hasDocumentInput = body.document_number || body.expiry_date || body.issuing_country || body.document_type;
  if (!hasDocumentInput) return;
  let document = db.traveler_documents.find((doc) => doc.traveler_profile_id === travelerId);
  if (!document) {
    document = {
      id: uid("doc"),
      traveler_profile_id: travelerId,
      created_at: now()
    };
    db.traveler_documents.push(document);
  }
  document.document_type = body.document_type || document.document_type || "passport";
  document.issuing_country = body.issuing_country || body.nationality || document.issuing_country || "";
  if (body.document_number) {
    document.encrypted_document_number = encryptSensitive(body.document_number);
    document.document_number_last4 = last4(body.document_number);
  }
  document.expiry_date = body.expiry_date || document.expiry_date || "";
  document.updated_at = now();
}

async function handleApi(req, res, pathname) {
  if (req.method === "OPTIONS") return sendJson(res, 204, {});
  const db = readDb();

  if (req.method === "GET" && pathname === "/api/bootstrap") {
    return sendJson(res, 200, bootstrapPayload(db));
  }

  if (req.method === "GET" && pathname === "/api/extension/bootstrap") {
    return sendJson(res, 200, extensionBootstrapPayload(db));
  }

  if (req.method === "POST" && pathname === "/api/agent/next-action") {
    const body = await readBody(req);
    const decision = await decideAgentNextAction(body);
    return sendJson(res, 200, decision);
  }

  if (req.method === "POST" && pathname === "/api/agent/session") {
    const body = await readBody(req);
    const session = createAgentSession(body);
    return sendJson(res, 201, summarizeAgentSession(session));
  }

  if (req.method === "POST" && pathname === "/api/agent/report") {
    const body = await readBody(req);
    const session = reportAgentResult(body);
    if (!session) return sendJson(res, 404, { error: "Agent session not found" });
    return sendJson(res, 200, summarizeAgentSession(session));
  }

  if (req.method === "POST" && pathname === "/api/workspaces") {
    const body = await readBody(req);
    const workspace = {
      id: uid("wrk"),
      name: String(body.name || "Personal Workspace").slice(0, 80),
      owner_user_id: "local_user",
      created_at: now()
    };
    db.workspaces.push(workspace);
    db.workspace_members.push({
      id: uid("mem"),
      workspace_id: workspace.id,
      user_id: "local_user",
      email: "ops@example.com",
      role: "owner",
      created_at: now()
    });
    writeDb(db);
    return sendJson(res, 201, bootstrapPayload(db));
  }

  if (req.method === "POST" && pathname === "/api/travelers") {
    const body = await readBody(req);
    const workspaceId = body.workspace_id || db.workspaces[0]?.id;
    const traveler = travelerFromBody({ ...body, workspace_id: workspaceId }, {
      id: uid("trav"),
      created_at: now(),
      updated_at: now()
    });
    db.traveler_profiles.push(traveler);
    upsertTravelerDocument(db, traveler.id, body);
    db.preferences = db.preferences || {};
    if (!db.preferences.selected_traveler_id) db.preferences.selected_traveler_id = traveler.id;
    writeDb(db);
    return sendJson(res, 201, bootstrapPayload(db));
  }

  const travelerMatch = pathname.match(/^\/api\/travelers\/([^/]+)$/);
  if (travelerMatch && req.method === "POST") {
    const body = await readBody(req);
    const travelerId = travelerMatch[1];
    const index = db.traveler_profiles.findIndex((traveler) => traveler.id === travelerId);
    if (index === -1) return sendJson(res, 404, { error: "Traveler not found" });
    db.traveler_profiles[index] = travelerFromBody(body, db.traveler_profiles[index]);
    upsertTravelerDocument(db, travelerId, body);
    writeDb(db);
    return sendJson(res, 200, bootstrapPayload(db));
  }

  if (travelerMatch && req.method === "DELETE") {
    const travelerId = travelerMatch[1];
    const before = db.traveler_profiles.length;
    db.traveler_profiles = db.traveler_profiles.filter((traveler) => traveler.id !== travelerId);
    if (db.traveler_profiles.length === before) return sendJson(res, 404, { error: "Traveler not found" });
    db.traveler_documents = db.traveler_documents.filter((doc) => doc.traveler_profile_id !== travelerId);
    db.trips = db.trips.filter((trip) => trip.traveler_profile_id !== travelerId);
    db.preferences = db.preferences || {};
    if (db.preferences.selected_traveler_id === travelerId) {
      db.preferences.selected_traveler_id = db.traveler_profiles[0]?.id || "";
    }
    writeDb(db);
    return sendJson(res, 200, bootstrapPayload(db));
  }

  if (req.method === "POST" && pathname === "/api/preferences") {
    const body = await readBody(req);
    db.preferences = {
      ...(db.preferences || {}),
      selected_traveler_id: body.selected_traveler_id || db.preferences?.selected_traveler_id || ""
    };
    writeDb(db);
    return sendJson(res, 200, bootstrapPayload(db));
  }

  if (req.method === "POST" && pathname === "/api/trips") {
    const body = await readBody(req);
    const trip = {
      id: uid("trip"),
      workspace_id: body.workspace_id || db.workspaces[0]?.id,
      traveler_profile_id: body.traveler_profile_id || db.traveler_profiles[0]?.id,
      created_by_user_id: "local_user",
      airline: body.airline || "",
      seller: body.seller || "",
      origin_airport: body.origin_airport || "",
      destination_airport: body.destination_airport || "",
      departure_at: body.departure_at || "",
      return_at: body.return_at || "",
      booking_reference: body.booking_reference || "",
      ticket_number: body.ticket_number || "",
      price_amount: Number(body.price_amount || 0),
      price_currency: body.price_currency || "USD",
      baggage_summary: body.baggage_summary || "",
      booking_url: body.booking_url || "",
      status: body.status || "booked",
      invoice_status: body.invoice_status || "missing",
      warnings: Array.isArray(body.warnings) ? body.warnings.slice(0, 8) : [],
      notes: body.notes || "",
      created_at: now(),
      updated_at: now()
    };
    db.trips.unshift(trip);
    writeDb(db);
    return sendJson(res, 201, bootstrapPayload(db));
  }

  if (req.method === "POST" && pathname === "/api/invites") {
    const body = await readBody(req);
    db.invites.push({
      id: uid("inv"),
      workspace_id: body.workspace_id || db.workspaces[0]?.id,
      email: body.email || "",
      role: body.role || "member",
      created_at: now()
    });
    writeDb(db);
    return sendJson(res, 201, bootstrapPayload(db));
  }

  sendJson(res, 404, { error: "Not found" });
}

function serveStatic(req, res, pathname) {
  const routeFile = pathname === "/" || pathname === "/login" || pathname === "/onboarding" || pathname === "/dashboard" || pathname.startsWith("/travelers") || pathname.startsWith("/trips") || pathname.startsWith("/settings")
    ? "index.html"
    : pathname === "/demo/checkout"
      ? "checkout.html"
      : pathname.slice(1);
  const filePath = path.normalize(path.join(PUBLIC_DIR, routeFile));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    return res.end("Not found");
  }
  const ext = path.extname(filePath);
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8"
  };
  res.writeHead(200, { "content-type": types[ext] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url.pathname);
    serveStatic(req, res, url.pathname);
  } catch (error) {
    sendJson(res, 500, { error: "Server error" });
  }
});

server.listen(PORT, HOST, () => {
  ensureDb();
  console.log(`Air Travel Wallet running at http://localhost:${PORT}`);
});
