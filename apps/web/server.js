const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "127.0.0.1";
const ROOT = path.resolve(__dirname, "../..");
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = process.env.ATW_DATA_DIR || path.join(ROOT, "work");
const DB_FILE = process.env.ATW_PROFILE_DB || path.join(DATA_DIR, "air-travel-wallet-db.json");
const MAX_OBSERVATION_BYTES = 5_500_000;
const MAX_SCREENSHOT_UPLOAD_BYTES = 12_000_000;
const screenshotUploads = new Map();
const KEY = crypto.createHash("sha256").update(process.env.ATW_ENCRYPTION_KEY || "local-dev-key-change-me").digest();
const AGENT_MODEL = process.env.ATW_AGENT_MODEL || "gpt-4.1-mini";
const AGENT_RECOVERY_MODEL = process.env.ATW_AGENT_RECOVERY_MODEL || AGENT_MODEL;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const agentLoop = require("./agent/loop");
const agentSessionStore = require("./agent/session-store");
const agentTraceStore = require("./agent/trace-store");
const { withUpdate, normalizeStep } = require("../../packages/shared/agent-state");
const { PAGE_SURFACE_ID, normalizeSurface } = require("./agent/surface-contract");

function uid(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function now() {
  return new Date().toISOString();
}

function summarizeAgentSession(session) {
  if (!session) return null;
  return {
    id: session.id,
    status: session.status,
    goal: session.goal,
    currentStage: session.currentStep,
    travelerName: "",
    approvals: session.approvals,
    completedFields: [],
    lockedFields: {},
    retryCounts: {},
    lastAction: session.lastAction,
    lastResult: session.lastActionResult || null,
    lastPageSummary: {
      site: session.site?.host || "",
      url: session.site?.url || "",
      requirements: (session.requirements || []).length,
      missing: (session.requirements || []).filter((req) => req.required && req.status !== "satisfied").length
    },
    failures: session.failures || [],
    events: []
  };
}

function createAgentSession(body = {}) {
  const traveler = body.traveler || {};
  const requestedSessionId = clampText(body.sessionId || "", 120);
  if (body.resumeOnly && (!requestedSessionId || !agentSessionStore.getSession(requestedSessionId))) {
    return null;
  }
  const state = agentSessionStore.getOrCreateSession(requestedSessionId, {
    goal: clampText(body.goal || body.userIntent || "Complete checkout safely.", 500),
    travelerId: clampText(traveler.id || body.travelerId || "", 120),
    site: { host: body.page?.site || "", url: body.page?.url || "" }
  });
  const updated = withUpdate(state, {
    status: "running",
    userIntent: clampText(body.userIntent || body.goal || state.userIntent || state.goal, 800),
    travelerIds: [traveler.id || body.travelerId || state.travelerId].filter(Boolean),
    userPolicy: {
      bookingRules: clampText(traveler.booking_rules, 800),
      baggagePreference: clampText(traveler.baggage_preference, 120),
      preferredSeat: clampText(traveler.preferred_seat, 120),
      paymentPreference: clampText(traveler.payment_preference, 120)
    },
    currentStep: normalizeStep(body.page?.step || state.currentStep || "unknown"),
    approvals: {
      ...state.approvals,
      skipPaidExtrasApproved: Boolean(body.approvalState?.skipPaidExtrasApproved || /no paid|no extras|no add-?ons|no seat|avoid paid/i.test(traveler.booking_rules || "")),
      paymentApproved: false,
      paymentAuthorization: body.approvalState?.paymentAuthorization || state.approvals?.paymentAuthorization || null,
      priceAuthorization: body.approvalState?.priceAuthorization || state.approvals?.priceAuthorization || null
    }
  });
  agentSessionStore.saveSession(updated);
  return updated;
}

function reportAgentResult(body = {}) {
  const checkoutState = agentSessionStore.getSession(body.sessionId);
  if (!checkoutState) return null;
  const result = body.result || {};
  const status = result.type === "final_review"
    ? "ready_for_payment"
    : result.type === "save_trip"
      ? "complete"
      : ["ask_user", "stop"].includes(result.type)
        ? "awaiting_user"
        : checkoutState.status;
  return agentSessionStore.recordActionResult(checkoutState.id, result, {
    currentStep: normalizeStep(body.page?.step || checkoutState.currentStep || "unknown"),
    status
  });
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
  const raw = fs.readFileSync(DB_FILE, "utf8");
  const db = raw.trim() ? JSON.parse(raw) : seedDb();
  if (!raw.trim()) writeDb(db);
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

function requestBodyError(code, message, status = 413) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.retryable = code === "OBSERVATION_TOO_LARGE";
  return error;
}

function readBody(req, { maxBytes = 6_000_000, tooLargeCode = "REQUEST_TOO_LARGE" } = {}) {
  return new Promise((resolve, reject) => {
    let body = "";
    let bytes = 0;
    let oversized = false;
    const contentLength = Number(req.headers["content-length"] || 0);
    if (contentLength > maxBytes) {
      oversized = true;
    }
    req.on("data", (chunk) => {
      if (oversized) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes) {
        oversized = true;
        body = "";
        return;
      }
      body += chunk;
    });
    req.on("end", () => {
      if (oversized) {
        return reject(requestBodyError(tooLargeCode, `Request body exceeds ${maxBytes} bytes.`));
      }
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function storeScreenshotUpload({ sessionId = "", observationId = "", screenshotDataUrl = "" } = {}) {
  if (!screenshotDataUrl.startsWith("data:image/")) {
    throw requestBodyError("SCREENSHOT_INVALID", "Screenshot upload must be a data:image URL.", 400);
  }
  const screenshotId = uid("shot");
  screenshotUploads.set(screenshotId, {
    screenshotId,
    sessionId: clampText(sessionId, 120),
    observationId: clampText(observationId, 120),
    screenshotDataUrl,
    createdAt: Date.now()
  });
  while (screenshotUploads.size > 40) {
    screenshotUploads.delete(screenshotUploads.keys().next().value);
  }
  return screenshotId;
}

function screenshotForObservation(page = {}, body = {}) {
  const screenshotId = clampText(page.screenshotId, 120);
  if (!screenshotId) return { screenshotId: "", screenshotDataUrl: String(page.screenshotDataUrl || "") };
  const upload = screenshotUploads.get(screenshotId);
  if (!upload) throw requestBodyError("SCREENSHOT_REFERENCE_EXPIRED", "Screenshot reference is unknown or expired.", 409);
  if (upload.sessionId && upload.sessionId !== clampText(body.sessionId, 120)) {
    throw requestBodyError("SCREENSHOT_SESSION_MISMATCH", "Screenshot reference belongs to another checkout session.", 409);
  }
  if (upload.observationId && upload.observationId !== clampText(body.observationId, 120)) {
    throw requestBodyError("SCREENSHOT_OBSERVATION_MISMATCH", "Screenshot reference belongs to another observation.", 409);
  }
  return { screenshotId, screenshotDataUrl: upload.screenshotDataUrl };
}

function clampText(value, max = 4000) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function lowerText(value) {
  return clampText(value, 4000).toLowerCase();
}

function compactAccessibilityNode(node = {}) {
  if (!node || typeof node !== "object") return null;
  return {
    id: clampText(node.id, 80),
    controlId: clampText(node.controlId, 140),
    visualRef: clampText(node.visualRef, 40),
    decisionGroupId: clampText(node.decisionGroupId, 140),
    role: clampText(node.role, 80),
    name: clampText(node.name, 220),
    state: node.state && typeof node.state === "object" ? {
      disabled: Boolean(node.state.disabled),
      checked: clampText(node.state.checked, 40),
      selected: clampText(node.state.selected, 40),
      expanded: clampText(node.state.expanded, 40),
      pressed: clampText(node.state.pressed, 40),
      required: Boolean(node.state.required),
      invalid: Boolean(node.state.invalid),
      hasPopup: clampText(node.state.hasPopup, 80),
      controls: clampText(node.state.controls, 120),
      describedBy: clampText(node.state.describedBy, 240)
    } : null,
    kind: clampText(node.kind, 80),
    sectionId: clampText(node.sectionId, 80),
    sectionType: clampText(node.sectionType, 80),
    sectionLabel: clampText(node.sectionLabel, 160),
    surfaceId: clampText(node.surfaceId, 80),
    surfaceType: clampText(node.surfaceType, 80),
    box: node.box || null
  };
}

function compactVisualState(state = {}) {
  if (!state || typeof state !== "object") return null;
  return {
    fingerprint: clampText(state.fingerprint, 120),
    viewport: state.viewport || null,
    controlCount: Number(state.controlCount || 0),
    foreground: state.foreground && typeof state.foreground === "object" ? {
      active: Boolean(state.foreground.active),
      id: clampText(state.foreground.id, 80),
      type: clampText(state.foreground.type, 80),
      label: clampText(state.foreground.label, 400),
      blocksBackground: Boolean(state.foreground.blocksBackground),
      confidence: Number(state.foreground.confidence || 0),
      reason: clampText(state.foreground.reason, 240),
      progressMarkers: state.foreground.progressMarkers || {},
      fingerprint: clampText(state.foreground.fingerprint, 120),
      optionCount: Number(state.foreground.optionCount || 0),
      navigationControlCount: Number(state.foreground.navigationControlCount || 0),
      box: state.foreground.box || null
    } : null,
    controls: Array.isArray(state.controls)
      ? state.controls.map((control) => ({
          id: clampText(control.id, 80),
          visualRef: clampText(control.visualRef, 40),
          role: clampText(control.role, 80),
          name: clampText(control.name, 180),
          label: clampText(control.label, 180),
          kind: clampText(control.kind, 80),
          semantic: clampText(control.semantic, 80),
          risk: clampText(control.risk, 80),
          selected: Boolean(control.selected),
          required: Boolean(control.required),
          hasValue: Boolean(control.hasValue),
          state: control.state || null,
          box: control.box || null
        })).slice(0, 80)
      : []
  };
}

function compactSurface(surface = {}) {
  if (!surface || typeof surface !== "object") {
    return { type: "page", id: "", label: "", role: "", taskHint: "", box: null, memberControlIds: [], memberActuatorIds: [] };
  }
  const surfaceMembers = [
    ...(surface.memberControlIds || surface.controlIds || []),
    ...(surface.options || []).map((item) => item.controlId),
    ...(surface.buttons || []).map((item) => item.controlId)
  ];
  const surfaceActuators = [
    ...(surface.memberActuatorIds || []),
    ...(surface.options || []).flatMap((item) => [item.stateElementId, item.preferredActivationElementId]),
    ...(surface.buttons || []).flatMap((item) => [item.stateElementId, item.preferredActivationElementId])
  ];
  return {
    type: clampText(surface.type || "page", 40),
    id: clampText(surface.id || "", 80),
    label: clampText(surface.label || "", 1200),
    role: clampText(surface.role || "", 80),
    taskHint: clampText(surface.taskHint || "", 120),
    blocksBackground: Boolean(surface.blocksBackground),
    parentSurfaceId: clampText(surface.parentSurfaceId, 80),
    observationId: clampText(surface.observationId, 120),
    memberControlIds: [...new Set(surfaceMembers.map((id) => clampText(id, 140)).filter(Boolean))],
    memberActuatorIds: [...new Set(surfaceActuators.map((id) => clampText(id, 80)).filter(Boolean))],
    expectedResolution: clampText(surface.expectedResolution || "", 180),
    foreground: compactVisualState({ foreground: surface.foreground || surface.visualState?.foreground || null })?.foreground || null,
    visualState: compactVisualState(surface.visualState),
    box: surface.box || null
  };
}

function compactActuators(actuators = []) {
  return Array.isArray(actuators)
    ? actuators.map((item) => ({
        nodeId: clampText(item.nodeId, 80),
        relation: clampText(item.relation, 40),
        role: clampText(item.role, 80),
        label: clampText(item.label, 180),
        box: item.box || null
      })).filter((item) => item.nodeId).slice(0, 10)
    : [];
}

function compactControlFields(item = {}) {
  return {
    controlId: clampText(item.controlId, 140),
    stableKey: clampText(item.stableKey, 240),
    meaning: clampText(item.meaning, 220),
    structuredPrice: item.structuredPrice && Number.isFinite(Number(item.structuredPrice.amount)) ? {
      amount: Number(item.structuredPrice.amount),
      currency: clampText(item.structuredPrice.currency, 12)
    } : null,
    visualRef: clampText(item.visualRef, 40),
    decisionGroupId: clampText(item.decisionGroupId, 140),
    controlKind: clampText(item.controlKind || item.kind, 80),
    controlState: item.controlState || item.state || null,
    stateElementId: clampText(item.stateElementId, 80),
    preferredActivationElementId: clampText(item.preferredActivationElementId, 80),
    operations: compactControlOperations(item.operations),
    recovery: compactControlRecovery(item.recovery),
    actuators: compactActuators(item.actuators),
    visualRegion: item.visualRegion || null
  };
}

function compactControlOperations(operations = {}) {
  return Object.fromEntries(Object.entries(operations || {}).map(([name, capability]) => [
    clampText(name, 40),
    capability ? {
      operation: clampText(capability.operation || name, 40),
      actuatorId: clampText(capability.actuatorId, 80),
      actuatorIds: Array.isArray(capability.actuatorIds) ? capability.actuatorIds.map((id) => clampText(id, 80)).filter(Boolean).slice(0, 8) : [],
      precondition: capability.precondition || null,
      expectedOutcome: clampText(capability.expectedOutcome, 80)
    } : null
  ]));
}

function compactControlRecovery(recovery = {}) {
  return Object.fromEntries(Object.entries(recovery || {}).map(([name, capability]) => [
    clampText(name, 40),
    capability ? {
      operation: clampText(capability.operation || name, 40),
      status: clampText(capability.status, 40),
      strategy: clampText(capability.strategy, 120),
      requiresFreshObservation: Boolean(capability.requiresFreshObservation),
      requiresVisualConfirmation: Boolean(capability.requiresVisualConfirmation),
      regions: Array.isArray(capability.regions)
        ? capability.regions.map((region) => ({
            x: Number(region.x || 0),
            y: Number(region.y || 0),
            width: Number(region.width || 0),
            height: Number(region.height || 0),
            centerX: Number(region.centerX || 0),
            centerY: Number(region.centerY || 0),
            viewportWidth: Number(region.viewportWidth || 0),
            viewportHeight: Number(region.viewportHeight || 0),
            surfaceId: clampText(region.surfaceId, 80),
            observationId: clampText(region.observationId, 120),
            controlId: clampText(region.controlId, 140),
            operation: clampText(region.operation, 40),
            source: clampText(region.source, 120),
            inViewport: region.inViewport !== false,
            evidence: clampText(region.evidence, 120),
            confidence: Number(region.confidence || 0)
          })).slice(0, 4)
        : []
    } : null
  ]));
}

function compactLogicalControl(control = {}) {
  return {
    controlId: clampText(control.controlId, 140),
    stableKey: clampText(control.stableKey, 240),
    meaning: clampText(control.meaning, 220),
    structuredPrice: control.structuredPrice && Number.isFinite(Number(control.structuredPrice.amount)) ? {
      amount: Number(control.structuredPrice.amount),
      currency: clampText(control.structuredPrice.currency, 12)
    } : null,
    visualRef: clampText(control.visualRef, 40),
    decisionGroupId: clampText(control.decisionGroupId, 140),
    label: clampText(control.label, 220),
    accessibleName: clampText(control.accessibleName, 220),
    kind: clampText(control.kind, 80),
    field: clampText(control.field, 80),
    role: clampText(control.role, 80),
    semantic: clampText(control.semantic, 80),
    risk: clampText(control.risk, 80),
    state: control.state || null,
    selected: Boolean(control.selected),
    required: Boolean(control.required),
    hasValue: Boolean(control.hasValue || control.state?.valuePresent || control.controlState?.valuePresent),
    sectionId: clampText(control.sectionId, 80),
    sectionType: clampText(control.sectionType, 80),
    sectionLabel: clampText(control.sectionLabel, 160),
    surfaceId: clampText(control.surfaceId, 80),
    surfaceType: clampText(control.surfaceType, 80),
    surfaceLabel: clampText(control.surfaceLabel, 220),
    stateElementId: clampText(control.stateElementId, 80),
    preferredActivationElementId: clampText(control.preferredActivationElementId, 80),
    operations: compactControlOperations(control.operations),
    recovery: compactControlRecovery(control.recovery),
    actuators: compactActuators(control.actuators),
    visualRegion: control.visualRegion || null
  };
}

function compactDecisionGroup(group = {}, controlsById = new Map()) {
  const alternativeControlIds = Array.isArray(group.alternativeControlIds)
    ? group.alternativeControlIds
    : (group.alternatives || []).map((choice) => choice.controlId);
  const ids = [...new Set(alternativeControlIds.map((id) => clampText(id, 140)).filter(Boolean))];
  return {
    decisionGroupId: clampText(group.decisionGroupId, 140),
    surfaceId: clampText(group.surfaceId, 80),
    sectionId: clampText(group.sectionId, 80),
    sectionType: clampText(group.sectionType, 80),
    sectionLabel: clampText(group.sectionLabel, 160),
    requirementId: clampText(group.requirementId, 120),
    required: Boolean(group.required),
    status: clampText(group.status, 40),
    selectedControlId: clampText(group.selectedControlId, 140),
    selectedLabel: clampText(group.selectedLabel, 220),
    selectedSemantic: clampText(group.selectedSemantic, 80),
    alternativeControlIds: ids,
    alternatives: ids.flatMap((controlId) => {
      const control = controlsById.get(controlId);
      if (!control) return [];
      return [{
        controlId,
        targetId: control.preferredActivationElementId || control.stateElementId || "",
        visualRef: control.visualRef || "",
        label: control.label || "",
        semantic: control.semantic || "",
        risk: control.risk || "",
        selected: Boolean(control.selected || control.state?.selected || control.state?.checked),
        priceText: ""
      }];
    }),
    evidence: Array.isArray(group.evidence) ? group.evidence.map((item) => clampText(item, 180)).slice(0, 5) : []
  };
}

function compactAgentPayload(body) {
  const page = body.page || {};
  const traveler = body.traveler || {};
  const screenshot = screenshotForObservation(page, body);
  const screenshotDataUrl = screenshot.screenshotDataUrl;
  const sections = Array.isArray(page.sections)
    ? page.sections.map((section) => ({
        id: clampText(section.id, 80),
        label: clampText(section.label, 120),
        type: clampText(section.type, 80),
        order: Number(section.order || 0),
        required: Boolean(section.required),
        paidChoice: Boolean(section.paidChoice),
        selected: Array.isArray(section.selected) ? section.selected.map((item) => clampText(item, 120)).slice(0, 8) : [],
        box: section.box || null,
        controlIds: [...new Set((section.controlIds || [
          ...(section.fields || []).map((item) => item.controlId),
          ...(section.choices || []).map((item) => item.controlId),
          ...(section.buttons || []).map((item) => item.controlId)
        ]).map((id) => clampText(id, 140)).filter(Boolean))],
        text: clampText(section.text, 900)
      }))
    : [];
  const observedCurrentSurface = compactSurface(page.currentSurface || page.activeSurface || {});
  const currentSurface = {
    ...observedCurrentSurface,
    ...normalizeSurface(observedCurrentSurface, clampText(body.observationId || "", 120))
  };
  const canonicalControls = Array.isArray(page.controls)
    ? page.controls.map(compactLogicalControl).filter((control) => control.controlId).map((control) => {
        const surfaceId = control.surfaceId || (currentSurface.type === "page" ? PAGE_SURFACE_ID : "");
        const belongsToCurrent = Boolean(surfaceId && surfaceId === currentSurface.id);
        return {
          ...control,
          surfaceId,
          surfaceType: control.surfaceType || (belongsToCurrent ? currentSurface.type : surfaceId === PAGE_SURFACE_ID ? "page" : ""),
          surfaceLabel: control.surfaceLabel || (belongsToCurrent ? currentSurface.label : surfaceId === PAGE_SURFACE_ID ? "Page" : "")
        };
      })
    : [];
  const canonicalControlIds = new Set(canonicalControls.map((control) => control.controlId));
  const canonicalControlsById = new Map(canonicalControls.map((control) => [control.controlId, control]));
  const surfaceStack = Array.isArray(page.surfaceStack)
    ? page.surfaceStack.map(compactSurface)
    : [];
  return {
    sessionId: clampText(body.sessionId || "", 120),
    clientTurnId: clampText(body.clientTurnId || "", 120),
    observationId: clampText(body.observationId || "", 120),
    observationSnapshot: body.observationSnapshot || null,
    userIntent: clampText(body.userIntent || "Complete checkout safely for the selected traveler.", 800),
    userMessage: clampText(body.userMessage || "", 800),
    approvalState: {
      skipPaidExtrasApproved: Boolean(body.approvalState?.skipPaidExtrasApproved),
      paymentApproved: Boolean(body.approvalState?.paymentApproved),
      paymentAuthorization: body.approvalState?.paymentAuthorization && typeof body.approvalState.paymentAuthorization === "object"
        ? body.approvalState.paymentAuthorization
        : null,
      priceAuthorization: body.approvalState?.priceAuthorization && typeof body.approvalState.priceAuthorization === "object"
        ? body.approvalState.priceAuthorization
        : null
    },
    actionHistory: Array.isArray(body.actionHistory)
      ? body.actionHistory.map((item) => ({
        type: clampText(item.type, 80),
        actionId: clampText(item.actionId, 120),
        observationId: clampText(item.observationId, 120),
        observationHash: clampText(item.observationHash, 120),
        intent: clampText(item.intent, 120),
        requirementId: clampText(item.requirementId, 120),
        verified: typeof item.verified === "boolean" ? item.verified : undefined,
        payload: item.payload || {}
      })).slice(-12)
      : [],
    lastActionResult: body.lastActionResult && typeof body.lastActionResult === "object" ? body.lastActionResult : null,
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
      viewport: page.viewport && typeof page.viewport === "object" ? page.viewport : null,
      snapshotHash: clampText(page.snapshotHash, 120),
      graphIntegrity: page.graphIntegrity && typeof page.graphIntegrity === "object" ? {
        ok: page.graphIntegrity.ok !== false,
        conflicts: Array.isArray(page.graphIntegrity.conflicts) ? page.graphIntegrity.conflicts.slice(0, 20) : [],
        resolvedConflictCount: Number(page.graphIntegrity.resolvedConflictCount || 0),
        duplicateElementRekeyCount: Number(page.graphIntegrity.duplicateElementRekeyCount || 0),
        aliasConflictCount: Number(page.graphIntegrity.aliasConflictCount || 0),
        aliasConflicts: Array.isArray(page.graphIntegrity.aliasConflicts) ? page.graphIntegrity.aliasConflicts.slice(0, 20) : []
      } : null,
      itineraryFingerprint: clampText(page.itineraryFingerprint || page.summary?.itineraryFingerprint, 160),
      offerFingerprint: clampText(page.offerFingerprint || page.summary?.offerFingerprint, 160),
      transactionFacts: page.transactionFacts && typeof page.transactionFacts === "object" ? {
        itinerary: {
          completeness: clampText(page.transactionFacts.itinerary?.completeness || "unknown", 20),
          segments: Array.isArray(page.transactionFacts.itinerary?.segments)
            ? page.transactionFacts.itinerary.segments.map((segment) => ({
                segmentId: clampText(segment.segmentId, 120),
                origin: clampText(segment.origin, 12),
                destination: clampText(segment.destination, 12),
                departureDate: clampText(segment.departureDate, 40),
                departureTime: clampText(segment.departureTime, 20),
                arrivalTime: clampText(segment.arrivalTime, 20),
                flightNumber: clampText(segment.flightNumber, 30)
              })).slice(0, 12)
            : []
        },
        travelers: Array.isArray(page.transactionFacts.travelers)
          ? page.transactionFacts.travelers.map((entry) => ({
              travelerId: clampText(entry.travelerId || entry.id, 120),
              name: clampText(entry.name, 160)
            })).slice(0, 12)
          : [],
        currency: clampText(page.transactionFacts.currency, 20),
        basePrice: page.transactionFacts.basePrice && typeof page.transactionFacts.basePrice === "object" ? {
          amount: Number.isFinite(Number(page.transactionFacts.basePrice.amount)) ? Number(page.transactionFacts.basePrice.amount) : null,
          currency: clampText(page.transactionFacts.basePrice.currency, 20)
        } : null,
        totalPrice: page.transactionFacts.totalPrice && typeof page.transactionFacts.totalPrice === "object" ? {
          amount: Number.isFinite(Number(page.transactionFacts.totalPrice.amount)) ? Number(page.transactionFacts.totalPrice.amount) : null,
          currency: clampText(page.transactionFacts.totalPrice.currency, 20)
        } : null,
        fareBrand: clampText(page.transactionFacts.fareBrand, 120),
        selectedExtras: Array.isArray(page.transactionFacts.selectedExtras)
          ? page.transactionFacts.selectedExtras.map((extra) => ({
              decisionGroupId: clampText(extra.decisionGroupId, 140),
              label: clampText(extra.label, 180),
              disposition: clampText(extra.disposition, 80),
              priceAmount: Number.isFinite(Number(extra.priceAmount)) ? Number(extra.priceAmount) : null,
              currency: clampText(extra.currency, 20)
            })).slice(0, 40)
          : [],
        provenance: Array.isArray(page.transactionFacts.provenance)
          ? page.transactionFacts.provenance.map((entry) => ({
              source: clampText(entry.source, 80),
              observationId: clampText(entry.observationId, 120),
              confidence: Math.max(0, Math.min(1, Number(entry.confidence) || 0))
            })).slice(0, 20)
          : []
      } : null,
      priceText: clampText(page.priceText, 80),
      price: page.price && typeof page.price === "object" ? page.price : null,
      screenshotId: screenshot.screenshotId,
      screenshotDataUrl: screenshotDataUrl.startsWith("data:image/") ? screenshotDataUrl : "",
      screenshotAnnotations: Array.isArray(page.screenshotAnnotations)
        ? page.screenshotAnnotations.map((item) => ({
            visualRef: clampText(item.visualRef, 40),
            targetId: clampText(item.targetId, 80),
            controlId: clampText(item.controlId, 140),
            decisionGroupId: clampText(item.decisionGroupId, 140),
            label: clampText(item.label, 220),
            kind: clampText(item.kind, 80),
            role: clampText(item.role, 80),
            semantic: clampText(item.semantic, 80),
            risk: clampText(item.risk, 80),
            selected: Boolean(item.selected),
            required: Boolean(item.required),
            source: clampText(item.source, 80),
            box: item.box || null
          })).filter((item) => item.visualRef && item.controlId && canonicalControlIds.has(item.controlId)).slice(0, 80)
        : [],
      foreground: compactVisualState({ foreground: page.foreground || page.visualState?.foreground || null })?.foreground || null,
      visualState: compactVisualState(page.visualState),
      accessibility: page.accessibility && typeof page.accessibility === "object" ? {
        foregroundSurfaceId: clampText(page.accessibility.foregroundSurfaceId, 80),
        foregroundSurfaceType: clampText(page.accessibility.foregroundSurfaceType, 80),
        landmarkCount: Number(page.accessibility.landmarkCount || 0),
        controlIds: Array.isArray(page.accessibility.controlIds)
          ? page.accessibility.controlIds.map((id) => clampText(id, 140)).filter(Boolean)
          : []
      } : null,
      coverage: page.coverage || {},
      visibleText: clampText(page.text || page.fullText, 6000),
      errors: Array.isArray(page.errors) ? page.errors.map((item) => clampText(item, 220)).slice(0, 8) : [],
      validationIssues: Array.isArray(page.validationIssues)
        ? page.validationIssues.map((issue) => ({
            issueId: clampText(issue.issueId, 140),
            message: clampText(issue.message, 220),
            controlId: clampText(issue.controlId, 140),
            semanticType: clampText(issue.semanticType, 80),
            sectionId: clampText(issue.sectionId, 80),
            sectionType: clampText(issue.sectionType, 80),
            surfaceId: clampText(issue.surfaceId, 80),
            stageWide: Boolean(issue.stageWide)
          })).filter((issue) => issue.message).slice(0, 12)
        : [],
      paidChoices: Array.isArray(page.paidChoices) ? page.paidChoices.map((item) => clampText(item, 160)).slice(0, 8) : [],
      completedFields: page.completedFields && typeof page.completedFields === "object" ? page.completedFields : {},
      sections,
      controls: canonicalControls,
      controlAliases: Array.isArray(page.controlAliases)
        ? page.controlAliases.map((entry) => ({
            aliasId: clampText(entry.aliasId, 140),
            controlId: clampText(entry.controlId, 140),
            kind: clampText(entry.kind, 40)
          })).filter((entry) => entry.aliasId && entry.controlId)
        : [],
      decisionGroups: Array.isArray(page.decisionGroups)
        ? page.decisionGroups.map((group) => compactDecisionGroup(group, canonicalControlsById)).filter((group) => group.decisionGroupId)
        : [],
      stageExit: page.stageExit || {},
      reconciliation: page.reconciliation || {},
      currentSurface,
      surfaceStack,
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

// The decision path: observe -> verify -> plan -> policy -> act, with canonical
// session state and per-turn traces.
async function decideAgentNextActionViaLoop(body) {
  const payload = compactAgentPayload(body);
  if (!payload.sessionId) throw new Error("DURABLE_SESSION_REQUIRED");
  let state = agentSessionStore.getSession(payload.sessionId);
  if (!state) throw new Error("DURABLE_SESSION_NOT_FOUND");
  const previousObservation = state.currentObservationId
    ? agentSessionStore.getObservation(state.id, state.currentObservationId)
    : null;

  const observation = {
    observationId: payload.observationId,
    observationSnapshot: payload.observationSnapshot,
    userIntent: payload.userIntent,
    page: payload.page,
    lastActionResult: payload.lastActionResult || null
  };

  agentSessionStore.recordObservation(state.id, observation);
  // Previous browser evidence is read from the durable ledger and attached
  // only for this turn. It is not nested into the newly persisted observation.
  observation.previousObservation = previousObservation;
  state = agentSessionStore.getSession(state.id) || state;
  state = agentSessionStore.saveSession(withUpdate(state, {
    userIntent: payload.userIntent || state.userIntent || state.goal,
    travelerIds: [payload.traveler?.id || state.travelerId].filter(Boolean),
    userPolicy: {
      bookingRules: payload.traveler?.booking_rules || state.userPolicy?.bookingRules || state.policySnapshot?.bookingRules || "",
      baggagePreference: payload.traveler?.baggage_preference || state.userPolicy?.baggagePreference || state.policySnapshot?.baggagePreference || "",
      preferredSeat: payload.traveler?.preferred_seat || state.userPolicy?.preferredSeat || state.policySnapshot?.preferredSeat || "",
      paymentPreference: payload.traveler?.payment_preference || state.userPolicy?.paymentPreference || state.policySnapshot?.paymentPreference || ""
    },
    approvals: {
      ...(state.approvals || {}),
      skipPaidExtrasApproved: Boolean(payload.approvalState?.skipPaidExtrasApproved || state.approvals?.skipPaidExtrasApproved),
      paymentAuthorization: payload.approvalState?.paymentAuthorization || state.approvals?.paymentAuthorization || null,
      priceAuthorization: payload.approvalState?.priceAuthorization || state.approvals?.priceAuthorization || null
    }
  }));

  logAgent("loop turn start", { clientTurnId: payload.clientTurnId, observationId: payload.observationId, sessionId: state.id, site: payload.page?.site, step: state.currentStep, stallCount: state.stallCount || 0 });

  try {
    const { state: nextState, clientDecision, debug } = await agentLoop.runLoopTurn({
      apiKey: OPENAI_API_KEY,
      model: AGENT_MODEL,
      recoveryModel: AGENT_RECOVERY_MODEL,
      dataDir: DATA_DIR,
      state,
      observation,
      traveler: payload.traveler,
      actionHistory: payload.actionHistory,
      transactionStore: agentSessionStore,
      clientTurnId: payload.clientTurnId
    });
    agentSessionStore.saveSession(nextState);
    const latency = debug?.latency || {};
    const modelUsage = debug?.modelUsage || {};
    logAgent("loop turn decision", {
      sessionId: nextState.id,
      clientTurnId: payload.clientTurnId,
      observationId: payload.observationId,
      actionId: clientDecision.actionId || "",
      intent: clientDecision.intent || "",
      requirementId: clientDecision.requirementId || "",
      decisionGroupId: clientDecision.decisionGroupId || clientDecision.targetSnapshot?.decisionGroupId || "",
      action: clientDecision.action,
      target: clientDecision.targetLabel || clientDecision.value || clientDecision.targetId || "",
      targetKind: clientDecision.targetSnapshot?.kind || "",
      targetSource: clientDecision.targetSnapshot?.source || "",
      expectedOutcome: clientDecision.expectedOutcome?.type || "",
      risk: clientDecision.risk || "",
      stallCount: nextState.stallCount || 0,
      requirementsMissing: (nextState.requirements || []).filter((r) => r.required && r.status !== "satisfied").length,
      missing: (debug?.missing || []).map((item) => item.label).slice(0, 4),
      nav: (debug?.navigation || []).map((item) => `${item.action}:${item.label}:${item.enabled ? "on" : "off"}:${item.risk}`).slice(0, 5),
      riskGates: (debug?.riskGates || []).map((item) => `${item.type}:${item.label}:${item.status}:${item.risk}`).slice(0, 4),
      deterministic: Boolean(debug?.deterministic),
      classification_model_ms: latency.classification_model_ms ?? null,
      verify_plan_model_ms: latency.verify_plan_model_ms ?? null,
      policy_ms: latency.policy_ms ?? null,
      input_tokens: modelUsage.input_tokens ?? null,
      output_tokens: modelUsage.output_tokens ?? null,
      model: modelUsage.model || AGENT_MODEL,
      reason: debug?.final?.reason || clientDecision.reason || ""
    });
    return { ...clientDecision, sessionId: nextState.id, debug };
  } catch (error) {
    logAgent("loop turn ERROR", { message: error.message });
    return aiUnavailableDecision(error.message);
  }
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

function logAgent(label, data) {
  const stamp = new Date().toISOString().slice(11, 23);
  if (data === undefined) {
    console.log(`[agent ${stamp}] ${label}`);
  } else {
    console.log(`[agent ${stamp}] ${label}`, JSON.stringify(data));
  }
}

function safeLogFilePart(value) {
  return clampText(value || "no-session", 120).replace(/[^a-zA-Z0-9_.-]/g, "_") || "no-session";
}

function summarizeClientFlowLog(body) {
  const entry = body.entry || {};
  const payload = entry.payload || {};
  const page = payload.page || payload.pageBefore || payload.pageAfterAction || {};
  const decision = payload.decision || {};
  const target = payload.target || payload.resolved || {};
  const point = payload.point || {};
  return {
    sessionId: clampText(body.sessionId || "", 80),
    clientTurnId: clampText(body.clientTurnId || entry.turnId || "", 80),
    observationId: clampText(payload.observationId || payload.observation?.observationId || "", 80),
    actionId: clampText(payload.actionId || payload.executionId || "", 80),
    seq: entry.seq,
    phase: clampText(entry.phase || "unknown", 80),
    action: clampText(payload.action || decision.action || "", 80),
    target: clampText(payload.targetLabel || target.text || target.label || decision.targetLabel || decision.targetId || payload.targetId || "", 140),
    method: clampText(payload.method || "", 80),
    point: point.x !== undefined && point.y !== undefined ? `${Math.round(point.x)},${Math.round(point.y)}` : "",
    site: clampText(page.site || "", 80),
    step: clampText(page.step || "", 80),
    controls: Array.isArray(page.visibleControls) ? page.visibleControls.length : undefined,
    currentSurface: clampText(page.currentSurface?.label || page.currentSurface?.type || "", 140),
    reason: clampText(payload.reason || decision.reason || "", 180)
  };
}

function writeClientFlowLog(body) {
  const sessionId = safeLogFilePart(body.sessionId || body.entry?.turnId || "no-session");
  const dir = path.join(DATA_DIR, "agent-client-logs");
  fs.mkdirSync(dir, { recursive: true });
  const row = {
    receivedAt: now(),
    ...body
  };
  fs.appendFileSync(path.join(dir, `${sessionId}.jsonl`), `${JSON.stringify(row)}\n`);
  return summarizeClientFlowLog(body);
}

function summarizeActionLedgerRow(body = {}) {
  const action = body.action || {};
  const result = body.result || {};
  const target = body.targetFingerprint || {};
  return {
    transactionId: clampText(body.transactionId || "", 80),
    observationId: clampText(body.observationId || "", 80),
    turnId: clampText(body.turnId || "", 80),
    actionId: clampText(body.actionId || "", 80),
    stage: clampText(body.stage || "", 80),
    action: clampText(action.action || action.type || "", 80),
    target: clampText(action.targetLabel || action.value || target.text || target.id || "", 160),
    result: result.ok === undefined ? "" : result.ok ? "ok" : "failed",
    code: clampText(result.code || "", 80),
    reason: clampText(result.reason || result.message || action.reason || "", 180)
  };
}

function writeActionLedgerRow(body = {}) {
  const transactionId = safeLogFilePart(body.transactionId || body.sessionId || body.turnId || "no-session");
  const dir = path.join(DATA_DIR, "agent-ledger");
  fs.mkdirSync(dir, { recursive: true });
  const row = {
    receivedAt: now(),
    ...body
  };
  fs.appendFileSync(path.join(dir, `${transactionId}.jsonl`), `${JSON.stringify(row)}\n`);
  const realTransactionId = clampText(body.transactionId || body.sessionId || "", 120);
  if (realTransactionId && agentSessionStore.getSession(realTransactionId)) {
    agentSessionStore.recordActionEvent(realTransactionId, row);
  }
  return summarizeActionLedgerRow(row);
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

  if (req.method === "POST" && pathname === "/api/agent/client-log") {
    const body = await readBody(req);
    const summary = writeClientFlowLog(body);
    logAgent("client flow", summary);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && pathname === "/api/agent/action-ledger") {
    const body = await readBody(req);
    const summary = writeActionLedgerRow(body);
    logAgent("action ledger", summary);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && pathname === "/api/agent/screenshot") {
    const body = await readBody(req, { maxBytes: MAX_SCREENSHOT_UPLOAD_BYTES, tooLargeCode: "SCREENSHOT_TOO_LARGE" });
    const sessionId = clampText(body.sessionId || "", 120);
    const observationId = clampText(body.observationId || "", 120);
    if (!sessionId || !agentSessionStore.getSession(sessionId)) {
      return sendJson(res, 409, { error: "A current checkout session is required for screenshot upload.", code: "DURABLE_SESSION_NOT_FOUND", retryable: false });
    }
    if (!observationId) return sendJson(res, 400, { error: "observationId is required.", code: "OBSERVATION_ID_REQUIRED", retryable: false });
    const screenshotId = storeScreenshotUpload({ sessionId, observationId, screenshotDataUrl: String(body.screenshotDataUrl || "") });
    return sendJson(res, 201, { screenshotId });
  }

  if (req.method === "POST" && pathname === "/api/agent/next-action") {
    const body = await readBody(req, { maxBytes: MAX_OBSERVATION_BYTES, tooLargeCode: "OBSERVATION_TOO_LARGE" });
    const sessionId = clampText(body.sessionId || "", 120);
    if (!sessionId) return sendJson(res, 409, { error: "A durable checkout session is required before planning.", code: "DURABLE_SESSION_REQUIRED" });
    if (!agentSessionStore.getSession(sessionId)) {
      return sendJson(res, 409, { error: "The checkout session no longer exists; refusing to create a replacement transaction.", code: "DURABLE_SESSION_NOT_FOUND" });
    }
    try {
      const decision = await decideAgentNextActionViaLoop(body);
      return sendJson(res, 200, decision);
    } catch (error) {
      if (/^DURABLE_SESSION_/.test(error.message || "")) {
        return sendJson(res, 409, { error: error.message, code: error.message });
      }
      throw error;
    }
  }

  if (req.method === "POST" && pathname === "/api/agent/session") {
    const body = await readBody(req);
    const session = createAgentSession(body);
    if (!session) {
      return sendJson(res, 409, {
        error: "The saved checkout session could not be resumed; refusing to create a replacement transaction.",
        code: "DURABLE_SESSION_NOT_FOUND"
      });
    }
    return sendJson(res, 201, summarizeAgentSession(session));
  }

  if (req.method === "POST" && pathname === "/api/agent/report") {
    const body = await readBody(req);
    const session = reportAgentResult(body);
    if (!session) return sendJson(res, 404, { error: "Agent session not found" });
    return sendJson(res, 200, summarizeAgentSession(session));
  }

  if (req.method === "GET" && pathname.startsWith("/api/agent/session/")) {
    const sessionId = pathname.slice("/api/agent/session/".length);
    const state = agentSessionStore.getSession(sessionId);
    if (!state) return sendJson(res, 404, { error: "Checkout session not found" });
    return sendJson(res, 200, state);
  }

  if (req.method === "GET" && pathname.startsWith("/api/agent/transaction/")) {
    const sessionId = pathname.slice("/api/agent/transaction/".length);
    const transaction = agentSessionStore.reconstructTransaction(sessionId);
    if (!transaction) return sendJson(res, 404, { error: "Checkout transaction not found" });
    return sendJson(res, 200, transaction);
  }

  if (req.method === "GET" && pathname.startsWith("/api/agent/traces/")) {
    const sessionId = pathname.slice("/api/agent/traces/".length);
    return sendJson(res, 200, { sessionId, traces: agentTraceStore.listTraces(DATA_DIR, sessionId) });
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
    if (error?.code && Number(error.status || 0) >= 400) {
      return sendJson(res, Number(error.status), {
        error: error.message || "Request failed",
        code: error.code,
        retryable: error.retryable === true
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
  ensureDb();
  console.log(`Air Travel Wallet running at http://localhost:${PORT}`);
});
