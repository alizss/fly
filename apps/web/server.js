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
const agentLoop = require("./agent/loop");
const agentSessionStore = require("./agent/session-store");
const agentTraceStore = require("./agent/trace-store");
const { withUpdate, normalizeStep } = require("../../packages/shared/agent-state");

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
    completedSections: {},
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
  const state = agentSessionStore.getOrCreateSession(body.sessionId || "", {
    goal: clampText(body.goal || body.userIntent || "Complete checkout safely.", 500),
    travelerId: clampText(traveler.id || body.travelerId || "", 120),
    site: { host: body.page?.site || "", url: body.page?.url || "" }
  });
  const updated = withUpdate(state, {
    status: "running",
    currentStep: normalizeStep(body.page?.step || state.currentStep || "unknown"),
    approvals: {
      ...state.approvals,
      skipPaidExtrasApproved: Boolean(body.approvalState?.skipPaidExtrasApproved || /no paid|no extras|no add-?ons|no seat|avoid paid/i.test(traveler.booking_rules || "")),
      paymentApproved: false
    }
  });
  agentSessionStore.saveSession(updated);
  return updated;
}

function getAgentSession(id) {
  if (!id) return null;
  return agentSessionStore.getSession(id);
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
  if (payload.page?.completedFields && typeof payload.page.completedFields === "object") {
    session.completedFields = [
      ...new Set([
        ...session.completedFields,
        ...Object.keys(payload.page.completedFields).map((field) => clampText(field, 80))
      ])
    ].slice(-60);
    session.lockedFields = {
      ...(session.lockedFields || {}),
      ...Object.fromEntries(Object.entries(payload.page.completedFields).map(([field, value]) => [
        clampText(field, 80),
        clampText(value?.actual || value?.selector || "accepted", 180)
      ]))
    };
  }
  if (payload.page?.completedSections && typeof payload.page.completedSections === "object") {
    session.completedSections = {
      ...(session.completedSections || {}),
      ...payload.page.completedSections
    };
  }
  session.lastPageSummary = {
    site: payload.page?.site,
    step: payload.page?.step,
    errors: payload.page?.errors || [],
    paidChoices: payload.page?.paidChoices || [],
    overlays: payload.page?.overlays || [],
    sectionProgress: payload.page?.sectionProgress || {},
    completedSections: payload.page?.completedSections || {},
    completedFields: payload.page?.completedFields || {},
    stageExit: payload.page?.stageExit || {},
    reconciliation: payload.page?.reconciliation || {},
    sections: (payload.page?.sections || []).map((section) => ({
      label: section.label,
      type: section.type,
      status: section.status,
      objective: section.objective,
      selected: section.selected || []
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
  const checkoutState = agentSessionStore.getSession(body.sessionId);
  if (!checkoutState) return null;
  const result = body.result || {};
  const updated = withUpdate(checkoutState, {
    currentStep: normalizeStep(body.page?.step || checkoutState.currentStep || "unknown"),
    lastActionResult: result,
    status: result.type === "final_review" ? "awaiting_user" : checkoutState.status
  });
  agentSessionStore.saveSession(updated);
  return updated;
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

function lowerText(value) {
  return clampText(value, 4000).toLowerCase();
}

function compactAccessibilityNode(node = {}) {
  if (!node || typeof node !== "object") return null;
  return {
    id: clampText(node.id, 80),
    controlId: clampText(node.controlId, 140),
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
    return { type: "page", id: "", label: "", role: "", taskHint: "", box: null, options: [], buttons: [] };
  }
  return {
    type: clampText(surface.type || "page", 40),
    id: clampText(surface.id || "", 80),
    label: clampText(surface.label || "", 1200),
    role: clampText(surface.role || "", 80),
    taskHint: clampText(surface.taskHint || "", 120),
    blocksBackground: Boolean(surface.blocksBackground),
    expectedResolution: clampText(surface.expectedResolution || "", 180),
    foreground: compactVisualState({ foreground: surface.foreground || surface.visualState?.foreground || null })?.foreground || null,
    visualState: compactVisualState(surface.visualState),
    accessibility: compactAccessibilityNode(surface.accessibility),
    box: surface.box || null,
    taskQueue: Array.isArray(surface.taskQueue)
      ? surface.taskQueue.map((task) => ({
          id: clampText(task.id, 80),
          sectionLabel: clampText(task.sectionLabel, 120),
          sectionType: clampText(task.sectionType, 80),
          status: clampText(task.status, 80)
        })).slice(0, 12)
      : [],
    options: Array.isArray(surface.options)
      ? surface.options.map((option) => ({
          id: clampText(option.id, 80),
          controlId: clampText(option.controlId, 140),
          label: clampText(option.label, 220),
          semantic: clampText(option.semantic, 80),
          risk: clampText(option.risk, 80),
          role: clampText(option.role, 80),
          selected: Boolean(option.selected),
          controlState: option.controlState || option.state || null,
          stateElementId: clampText(option.stateElementId, 80),
          preferredActivationElementId: clampText(option.preferredActivationElementId, 80),
          actuators: compactActuators(option.actuators),
          visualRegion: option.visualRegion || null,
          accessibility: compactAccessibilityNode(option.accessibility),
          box: option.box || null
        })).slice(0, 24)
      : [],
    buttons: Array.isArray(surface.buttons)
      ? surface.buttons.map((button) => ({
          id: clampText(button.id, 80),
          controlId: clampText(button.controlId, 140),
          label: clampText(button.label, 220),
          semantic: clampText(button.semantic, 80),
          risk: clampText(button.risk, 80),
          role: clampText(button.role, 80),
          selected: Boolean(button.selected),
          controlState: button.controlState || button.state || null,
          stateElementId: clampText(button.stateElementId, 80),
          preferredActivationElementId: clampText(button.preferredActivationElementId, 80),
          actuators: compactActuators(button.actuators),
          visualRegion: button.visualRegion || null,
          accessibility: compactAccessibilityNode(button.accessibility),
          box: button.box || null
        })).slice(0, 24)
      : []
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
    controlKind: clampText(item.controlKind || item.kind, 80),
    controlState: item.controlState || item.state || null,
    stateElementId: clampText(item.stateElementId, 80),
    preferredActivationElementId: clampText(item.preferredActivationElementId, 80),
    actuators: compactActuators(item.actuators),
    visualRegion: item.visualRegion || null
  };
}

function compactLogicalControl(control = {}) {
  return {
    controlId: clampText(control.controlId, 140),
    label: clampText(control.label, 220),
    accessibleName: clampText(control.accessibleName, 220),
    kind: clampText(control.kind, 80),
    role: clampText(control.role, 80),
    semantic: clampText(control.semantic, 80),
    risk: clampText(control.risk, 80),
    state: control.state || null,
    selected: Boolean(control.selected),
    required: Boolean(control.required),
    sectionId: clampText(control.sectionId, 80),
    sectionType: clampText(control.sectionType, 80),
    sectionLabel: clampText(control.sectionLabel, 160),
    surfaceId: clampText(control.surfaceId, 80),
    surfaceType: clampText(control.surfaceType, 80),
    surfaceLabel: clampText(control.surfaceLabel, 220),
    stateElementId: clampText(control.stateElementId, 80),
    preferredActivationElementId: clampText(control.preferredActivationElementId, 80),
    actuators: compactActuators(control.actuators),
    visualRegion: control.visualRegion || null
  };
}

function includesAny(value, patterns) {
  const text = lowerText(value);
  return patterns.some((pattern) => pattern.test(text));
}

function selectedChoiceLabels(section) {
  return Array.isArray(section.choices)
    ? section.choices.filter((choice) => choice.selected).map((choice) => choice.label || "")
    : [];
}

function sectionHasChoice(section, matcher) {
  return Array.isArray(section.choices) && section.choices.some((choice) => matcher(choice));
}

function sectionHasSelectedChoice(section, matcher) {
  return Array.isArray(section.choices) && section.choices.some((choice) => choice.selected && matcher(choice));
}

function meaningfulActionBox(box = {}) {
  return Boolean(
    box &&
    Number(box.width || 0) >= 24 &&
    Number(box.height || 0) >= 16 &&
    Number(box.centerX ?? box.x ?? 0) > -200
  );
}

function fieldBySemantic(section, names) {
  const wanted = new Set(names);
  return (section.fields || []).filter((field) => wanted.has(field.semantic || field.field));
}

function fieldsComplete(section, names) {
  const fields = fieldBySemantic(section, names);
  if (!fields.length) return false;
  return fields.every((field) => field.hasValue);
}

function checkedFieldLabels(section) {
  return (section.fields || [])
    .filter((field) => /radio|checkbox/i.test(field.kind || "") && field.hasValue)
    .map((field) => field.label || "")
    .filter(Boolean)
    .map((text) => clampText(text, 240));
}

function hasBlockingErrorsForSection(page, section) {
  const text = lowerText([section.label, section.type, section.text].join(" "));
  return (page.errors || []).some((error) => {
    const err = lowerText(error);
    if (/select one option|select an option|choose one option|please select/.test(err)) return false;
    if (section.type === "contact" && /email|phone|mobile|contact/.test(err)) return true;
    if (section.type === "passenger" && /title|gender|first|surname|last|passenger|traveller|traveler/.test(err)) return true;
    return text && err.includes(text.slice(0, 30));
  });
}

function deriveSectionStatus(section, page) {
  const type = section.type || "unknown";
  const text = lowerText(`${section.label} ${section.text}`);
  const selectedLabels = selectedChoiceLabels(section).join(" ");
  const selectedText = lowerText(`${selectedLabels} ${(section.selected || []).join(" ")}`);
  const hasRequiredChoice = sectionHasChoice(section, (choice) => (
    /required_dropdown_choice|decline_baggage|decline_paid_extra|add_paid_extra|traveler_title/.test(choice.semantic || "")
    || /select one|select an option|choose|no checked baggage|no,?\s*thanks|add to cart|premium|standard|mrs|mr\b/i.test(choice.label || "")
  ));
  const hasSelectedChoice = sectionHasSelectedChoice(section, () => true);
  const hasBlockingError = hasBlockingErrorsForSection(page, section);

  if (type === "continue") return "gate";
  if (type === "payment") return "blocked";

  if (type === "contact") {
    const hasContactFields = fieldBySemantic(section, ["email", "confirm_email", "phone", "phone_country_code"]).length > 0;
    const missingRequired = (section.fields || []).some((field) => field.required && !field.hasValue);
    return hasContactFields && !missingRequired && !hasBlockingError ? "complete" : "incomplete";
  }

  if (type === "passenger") {
    const namesDone = fieldsComplete(section, ["first_name", "last_name"]);
    const titleDone = sectionHasSelectedChoice(section, (choice) => choice.semantic === "traveler_title" || /\bmr\b|mrs|ms/i.test(choice.label || ""))
      || sectionHasSelectedChoice(section, () => /title|gender/i.test(text));
    return namesDone && titleDone && !hasBlockingError ? "complete" : "incomplete";
  }

  if (type === "baggage") {
    const selectedNoBaggage = /no checked baggage|no baggage|without baggage|go without/.test(selectedText)
      || sectionHasSelectedChoice(section, (choice) => choice.semantic === "decline_baggage")
      || checkedFieldLabels(section).some((label) => /no checked baggage|no baggage|without baggage|go without/.test(lowerText(label)));
    const summarySaysNoBaggage = /checked baggage\s+no baggage selected/.test(lowerText(page.visibleText));
    const hasBaggageDecision = hasRequiredChoice
      || sectionHasChoice(section, (choice) => /decline_baggage|add_paid_extra/.test(choice.semantic || "") || /checked baggage|no checked baggage|\d+\s*x\s*\d+\s*kg|eur|€|\$/.test(choice.label || ""))
      || /checked baggage|no checked baggage|\d+\s*x\s*\d+\s*kg/.test(text);
    if (hasBaggageDecision) return selectedNoBaggage && !hasBlockingError ? "complete" : "incomplete";
    return summarySaysNoBaggage ? "complete" : "unknown";
  }

  if (type === "bundle") {
    const selectedDecline = /no,?\s*thanks|none/.test(selectedText)
      || sectionHasSelectedChoice(section, (choice) => choice.semantic === "decline_paid_extra")
      || checkedFieldLabels(section).some((label) => /no,?\s*thanks|none|without bundle/.test(lowerText(label)));
    return selectedDecline && !hasBlockingError ? "complete" : "incomplete";
  }

  if (type === "flexible_ticket") {
    const dropdowns = fieldBySemantic(section, ["required_dropdown_choice", "unknown"]).filter((field) => /choose|select|option|dropdown|combobox/i.test(`${field.label} ${field.kind}`));
    const dropdownDone = dropdowns.length ? dropdowns.every((field) => field.hasValue) : false;
    const selectedDecline = /none of the passengers|none|no,?\s*thanks|without/.test(selectedText)
      || sectionHasSelectedChoice(section, (choice) => choice.semantic === "decline_paid_extra");
    return (dropdownDone || selectedDecline) && !hasBlockingError ? "complete" : "incomplete";
  }

  if (type === "cancellation_insurance" || /cancellation|insurance|refund/.test(text)) {
    const selectedDecline = /no,?\s*thanks|none|without/.test(selectedText)
      || sectionHasSelectedChoice(section, (choice) => choice.semantic === "decline_paid_extra")
      || checkedFieldLabels(section).some((label) => /no,?\s*thanks|none|without/.test(lowerText(label)));
    return selectedDecline && !hasBlockingError ? "complete" : "incomplete";
  }

  if (hasRequiredChoice) return hasSelectedChoice ? "complete" : "incomplete";
  if ((section.fields || []).some((field) => field.required && !field.hasValue)) return "incomplete";
  if (hasBlockingError) return "incomplete";
  return section.status || "unknown";
}

function objectiveForSection(section, status) {
  if (status === "complete") return "Verified from current page state; do not touch unless a targeted error appears.";
  const objectives = {
    contact: "Fill contact fields from saved traveler profile.",
    passenger: "Fill passenger title, first name, and surname from saved traveler profile.",
    baggage: "Choose no checked baggage unless user explicitly approved paid bags.",
    bundle: "Choose No thanks for paid bundle/support/SMS extras.",
    flexible_ticket: "Choose None/no-passenger/zero-cost option for flexible ticket.",
    cancellation_insurance: "Choose No thanks for cancellation/refund insurance.",
    seat: "Skip paid seat selection unless included or explicitly approved.",
    continue: "Stage exit gate; click only when no required tasks remain.",
    payment: "Stop before real payment or final booking."
  };
  return objectives[section.type] || section.objective || "Resolve required visible controls safely.";
}

function reconcilePageState(payload, session) {
  const page = payload.page || {};
  const sections = (page.sections || []).map((section) => {
    const status = deriveSectionStatus(section, page);
    return {
      ...section,
      status,
      objective: objectiveForSection(section, status)
    };
  });
  const pendingTasks = sections
    .filter((section) => !["continue", "payment"].includes(section.type))
    .filter((section) => section.status !== "complete" && section.status !== "blocked")
    .filter((section) => section.required || section.paidChoice || ["contact", "passenger", "baggage", "bundle", "flexible_ticket", "cancellation_insurance", "seat"].includes(section.type))
    .map((section) => ({
      id: `task-${section.id}`,
      sectionId: section.id,
      sectionLabel: section.label,
      sectionType: section.type,
      order: section.order,
      status: "pending",
      objective: section.objective,
      rule: section.paidChoice ? "Saved traveler rules decide routine paid extras before asking." : "Use saved traveler profile and verify current page state."
    }));
  const continueButton = (page.buttons || []).find((button) => (
    button.risk === "safe_continue" &&
    !/skip to/i.test(button.label || "") &&
    meaningfulActionBox(button.box)
  ));
  const blockers = [];
  if (pendingTasks.length) blockers.push(`pending: ${pendingTasks[0].sectionLabel}`);
  if ((page.overlays || []).length) blockers.push("visible overlay/menu/modal");
  if ((page.errors || []).length) blockers.push(`visible errors: ${page.errors.slice(0, 2).join("; ")}`);
  if (!continueButton) blockers.push("no safe Continue button");
  const stageExit = {
    continueAllowed: Boolean(!pendingTasks.length && !(page.overlays || []).length && !(page.errors || []).length && continueButton && !["payment", "confirmation"].includes(page.step)),
    continueTargetId: continueButton?.id || "",
    blockers
  };

  if (session) {
    session.completedSections = session.completedSections || {};
    for (const section of sections) {
      if (section.status === "complete") {
        session.completedSections[section.type] = {
          label: section.label,
          at: now()
        };
      }
    }
  }

  payload.page = {
    ...page,
    sections,
    taskQueue: pendingTasks,
    stageExit,
    reconciliation: {
      completedSections: sections.filter((section) => section.status === "complete").map((section) => section.type),
      pendingSections: pendingTasks.map((task) => task.sectionType),
      nextTask: pendingTasks[0] || null
    },
    summary: {
      ...(page.summary || {}),
      pendingTasks: pendingTasks.length,
      completedSections: sections.filter((section) => section.status === "complete").length
    }
  };
  return payload;
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
              ...compactControlFields(field),
              label: clampText(field.label, 160),
              field: clampText(field.field, 80),
              kind: clampText(field.kind, 40),
              semantic: clampText(field.semantic || field.field, 80),
              role: clampText(field.role, 80),
              accessibility: compactAccessibilityNode(field.accessibility),
              required: Boolean(field.required),
              hasValue: Boolean(field.hasValue),
              box: field.box || null
            })).slice(0, 20)
          : [],
        choices: Array.isArray(section.choices)
          ? section.choices.map((choice) => ({
              id: clampText(choice.id, 80),
              ...compactControlFields(choice),
              label: clampText(choice.label, 160),
              selected: Boolean(choice.selected),
              semantic: clampText(choice.semantic, 80),
              risk: clampText(choice.risk, 80),
              role: clampText(choice.role, 80),
              accessibility: compactAccessibilityNode(choice.accessibility),
              box: choice.box || null
            })).slice(0, 20)
          : [],
        buttons: Array.isArray(section.buttons)
          ? section.buttons.map((button) => ({
              id: clampText(button.id, 80),
              ...compactControlFields(button),
              label: clampText(button.label, 160),
              risk: clampText(button.risk, 80),
              semantic: clampText(button.semantic, 80),
              role: clampText(button.role, 80),
              accessibility: compactAccessibilityNode(button.accessibility),
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
  const activeSurface = compactSurface(page.activeSurface || {});
  const currentSurface = compactSurface(page.currentSurface || page.activeSurface || {});
  const surfaceStack = Array.isArray(page.surfaceStack)
    ? page.surfaceStack.map(compactSurface).slice(0, 6)
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
      paymentApproved: Boolean(body.approvalState?.paymentApproved)
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
      snapshotHash: clampText(page.snapshotHash, 120),
      priceText: clampText(page.priceText, 80),
      price: page.price && typeof page.price === "object" ? page.price : null,
      screenshotDataUrl: screenshotDataUrl.startsWith("data:image/") ? screenshotDataUrl.slice(0, 5_000_000) : "",
      foreground: compactVisualState({ foreground: page.foreground || page.visualState?.foreground || null })?.foreground || null,
      visualState: compactVisualState(page.visualState),
      accessibility: page.accessibility && typeof page.accessibility === "object" ? {
        foregroundSurfaceId: clampText(page.accessibility.foregroundSurfaceId, 80),
        foregroundSurfaceType: clampText(page.accessibility.foregroundSurfaceType, 80),
        landmarkCount: Number(page.accessibility.landmarkCount || 0),
        controls: Array.isArray(page.accessibility.controls)
          ? page.accessibility.controls.map(compactAccessibilityNode).filter(Boolean).slice(0, 120)
          : []
      } : null,
      coverage: page.coverage || {},
      visibleText: clampText(page.text || page.fullText, 6000),
      errors: Array.isArray(page.errors) ? page.errors.map((item) => clampText(item, 220)).slice(0, 8) : [],
      paidChoices: Array.isArray(page.paidChoices) ? page.paidChoices.map((item) => clampText(item, 160)).slice(0, 8) : [],
      sectionProgress: page.sectionProgress && typeof page.sectionProgress === "object" ? page.sectionProgress : {},
      completedSections: page.completedSections && typeof page.completedSections === "object" ? page.completedSections : {},
      completedFields: page.completedFields && typeof page.completedFields === "object" ? page.completedFields : {},
      sections,
      controls: Array.isArray(page.controls)
        ? page.controls.map(compactLogicalControl).filter((control) => control.controlId).slice(0, 180)
        : [],
      taskQueue,
      stageExit: page.stageExit || {},
      reconciliation: page.reconciliation || {},
      activeSurface,
      currentSurface,
      surfaceStack,
      currentSurfaceTasks: Array.isArray(page.currentSurfaceTasks) ? page.currentSurfaceTasks.slice(0, 20) : [],
      backgroundTasks: Array.isArray(page.backgroundTasks) ? page.backgroundTasks.slice(0, 20) : [],
      fields: Array.isArray(page.fields)
        ? page.fields.map((field) => ({
            id: clampText(field.id, 80),
            ...compactControlFields(field),
            label: clampText(field.label, 220),
            box: field.box || null,
            kind: clampText(field.kind, 40),
            field: clampText(field.field, 80),
            semantic: clampText(field.semantic || field.field, 80),
            role: clampText(field.role, 80),
            accessibility: compactAccessibilityNode(field.accessibility),
            required: Boolean(field.required),
            hasValue: Boolean(field.value),
            confidence: Number(field.confidence || 0)
          })).slice(0, 80)
        : [],
      buttons: Array.isArray(page.buttons)
        ? page.buttons.map((button) => ({
            id: clampText(button.id, 80),
            ...compactControlFields(button),
            label: clampText(button.label, 180),
            box: button.box || null,
            role: clampText(button.role, 80),
            semantic: clampText(button.semantic, 80),
            risk: clampText(button.risk, 80),
            accessibility: compactAccessibilityNode(button.accessibility)
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

// The new decision path: observe -> verify -> plan -> policy -> act, with
// canonical session state and per-turn traces. Supersedes decideAgentNextAction
// (kept below, unused by default) which trusted JS-computed section status as
// ground truth — reconcilePageState/deriveSectionStatus are intentionally NOT
// called here; that JS-guessed status is exactly what the requirement
// extractor + verifier replace.
async function decideAgentNextActionViaLoop(body) {
  const payload = compactAgentPayload(body);
  const state = agentSessionStore.getOrCreateSession(payload.sessionId, {
    goal: payload.userIntent,
    travelerId: payload.traveler?.id || "",
    site: { host: payload.page?.site || "", url: payload.page?.url || "" }
  });

  const observation = {
    observationId: payload.observationId,
    observationSnapshot: payload.observationSnapshot,
    userIntent: payload.userIntent,
    page: payload.page,
    lastActionResult: payload.lastActionResult || null
  };

  logAgent("loop turn start", { clientTurnId: payload.clientTurnId, observationId: payload.observationId, sessionId: state.id, site: payload.page?.site, step: state.currentStep, stallCount: state.stallCount || 0 });

  try {
    const { state: nextState, clientDecision, debug } = await agentLoop.runLoopTurn({
      apiKey: OPENAI_API_KEY,
      model: AGENT_MODEL,
      dataDir: DATA_DIR,
      state,
      observation,
      traveler: payload.traveler,
      actionHistory: payload.actionHistory
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
    return { ...clientDecision, debug };
  } catch (error) {
    logAgent("loop turn ERROR", { message: error.message });
    return aiUnavailableDecision(error.message);
  }
}

function scopedSection(section, isCurrent) {
  if (isCurrent) return section;
  return {
    ...section,
    fields: [],
    choices: [],
    buttons: [],
    text: clampText(section.text, 260)
  };
}

function allowedTargetIdsForSection(section) {
  if (!section) return [];
  return [
    ...(section.fields || []).map((field) => field.controlId),
    ...(section.choices || []).map((choice) => choice.controlId),
    ...(section.buttons || []).map((button) => button.controlId),
    ...(section.fields || []).map((field) => field.id),
    ...(section.choices || []).map((choice) => choice.id),
    ...(section.buttons || []).map((button) => button.id)
  ].filter(Boolean);
}

function activeSurfaceTargetIds(activeSurface) {
  if (!activeSurface || activeSurface.type === "page") return [];
  return [
    ...(activeSurface.options || []).map((option) => option.controlId),
    ...(activeSurface.buttons || []).map((button) => button.controlId),
    ...(activeSurface.options || []).map((option) => option.id),
    ...(activeSurface.buttons || []).map((button) => button.id)
  ].filter(Boolean);
}

function defaultActiveSurface() {
  return { type: "page", id: "", label: "", role: "", taskHint: "", options: [], buttons: [] };
}

function scopePayloadToCurrentTask(payload) {
  const page = payload.page || {};
  const activeSurface = page.activeSurface || defaultActiveSurface();
  const surfaceActive = activeSurface.type && activeSurface.type !== "page";
  const nextTask = page.reconciliation?.nextTask || null;
  const currentTask = surfaceActive
    ? {
        id: `active_surface:${activeSurface.type}:${activeSurface.id || "visible"}`,
        sectionId: activeSurface.id || "",
        sectionLabel: activeSurface.label || activeSurface.taskHint || activeSurface.type,
        sectionType: "active_surface",
        order: 0,
        status: "pending",
        objective: `Resolve the visible ${activeSurface.type} before touching the background page.`,
        rule: "Foreground surfaces usually own the next action, but the background page is still a valid target if that's what the screenshot actually shows is correct."
      }
    : nextTask;

  // Union everything the page/detectors found, current-task or not, surface or not.
  // classifyStep/section-type guesses only ever narrow this list, which is exactly what
  // caused the agent to see a control on screen but have no id it was "allowed" to touch.
  // The only real gate left is: does this id exist anywhere on the page at all, plus the
  // structural guardrails upstream (payment fields are excluded from candidateInputs()
  // before they ever reach this payload, see content.js isPaymentField).
  const allowedTargetIds = new Set([
    ...(page.controls || []).map((control) => control.controlId),
    ...(page.fields || []).map((field) => field.id),
    ...(page.fields || []).map((field) => field.controlId),
    ...(page.buttons || []).map((button) => button.id),
    ...(page.buttons || []).map((button) => button.controlId),
    ...(page.sections || []).flatMap((section) => allowedTargetIdsForSection(section)),
    ...activeSurfaceTargetIds(activeSurface)
  ].filter(Boolean));
  if (page.stageExit?.continueAllowed && page.stageExit.continueTargetId) allowedTargetIds.add(page.stageExit.continueTargetId);

  return {
    ...payload,
    page: {
      ...page,
      currentTask,
      allowedTargetIds: [...allowedTargetIds],
      activeSurface,
      sections: (page.sections || []).map((section) => scopedSection(section, !surfaceActive)),
      fields: page.fields || [],
      buttons: page.buttons || [],
      paidChoices: (page.paidChoices || []).slice(0, 4)
    }
  };
}

function decisionInsideCurrentScope(decision, payload) {
  if (!["click", "type", "select"].includes(decision?.action)) return true;
  const allowed = new Set(payload.page?.allowedTargetIds || []);
  if (!allowed.size) return true;
  if (decision.targetId && allowed.has(decision.targetId)) return true;
  // targetId missing or stale (e.g. the DOM node it pointed at got replaced by a
  // React re-render between scans) — as long as there's a visible-text label to go
  // on, let it through so the client's live-page label match (resolveDecisionTarget)
  // gets a chance instead of discarding the whole turn.
  return Boolean(decision.value || decision.coordinate);
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

function noExtrasApprovedForPayload(payload) {
  return payload.approvalState?.skipPaidExtrasApproved
    || includesAny(payload.traveler?.booking_rules, [/no paid/i, /no extras/i, /no add-?ons/i, /no seat/i, /no insurance/i, /no bundle/i]);
}

function safeDeclineSurfaceOption(activeSurface) {
  const options = [...(activeSurface?.options || []), ...(activeSurface?.buttons || [])]
    .filter((option, index, list) => option?.id && !option.selected && list.findIndex((item) => item?.id === option.id) === index);
  const surfaceText = `${activeSurface?.taskHint || ""} ${activeSurface?.label || ""}`.toLowerCase();
  const isSeatSurface = /seat|reserve seating|seat map/.test(surfaceText);
  const scoreOption = (option) => {
    const label = String(option.label || "").toLowerCase();
    if (!label) return -1000;
    if (/add|buy|upgrade|premium|cart|add to my trip/.test(label) && !/no|none|without|0\s*(eur|€|usd|\$)/.test(label)) return -100;
    if (/safe_decline/i.test(option.risk || "") || /decline_paid_extra/i.test(option.semantic || "")) return 120;
    if (/none of the passengers|none of the travellers|none of the travelers/.test(label)) return 115;
    if (/0\s*(eur|€|usd|\$)|free/.test(label)) return 105;
    if (/i.ll go without|go without|continue without/.test(label)) return 95;
    if (/no,?\s*thanks|not now|skip|decline|no checked baggage|no baggage/.test(label)) return 90;
    if (isSeatSurface && /\bnext\b|skip seat selection|random seat|no seat/.test(label)) return 70;
    return -10;
  };
  return options
    .map((option) => ({ option, score: scoreOption(option) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)[0]?.option || null;
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
    source: clampText(decision?.source || "openai", 40),
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
        "Operate visual-first: decide from the current visible screen using the screenshot plus DOM controls, then let the extension execute precisely.",
        "When page.controls is present, prefer returning its controlId as targetId. A controlId represents one logical control across input, label, wrapper, ARIA proxy, and visual region; the executor will choose the safest actuator.",
        "page.activeSurface, when present, is usually the right thing to resolve first (dropdown, modal, popover, confirmation) — but it is a detector's best guess, not ground truth. If the screenshot clearly shows something else is the correct next action, trust the screenshot over activeSurface.type being 'page'.",
        "For activeSurface dropdown/listbox options, prefer options marked safe_decline when saved traveler rules approve skipping paid extras. Avoid options marked paid unless the user explicitly approves.",
        "If a modal/dialog surface's own choice is already selected/registered (e.g. a decline option shows selected, or actionHistory shows you already picked it) but the surface is still open, do not repeat that same choice — look in activeSurface.options for its own dismiss/confirm control (Next, Continue, Close, Done, Confirm) and click that instead to actually leave the dialog.",
        "targetId is a best-effort DOM id from a heuristic scan and can be missing or stale for things like custom dropdowns, popovers, and canvas/visual widgets (e.g. seat maps) even when you can clearly see them in the screenshot. Whenever you are not fully confident in targetId — or have none — set value to the exact visible text label of the control you mean. The extension will re-resolve that label against the live page at click time, which is more reliable than a guessed id.",
        "Use page.sections as visual decomposition and memory, not as a hard script. Each section has type, status, objective, fields, buttons, selected values, and coordinates.",
        "Use page.taskQueue and page.currentTask as hints for unresolved background work, but choose the best next visible safe action from the whole screen.",
        "Choose targetId only from page.allowedTargetIds unless you are returning wait, stop, ask_user, or final_review. For normal pages this contains all visible actionable controls.",
        "Do not let a stale section/task label block an obvious visible safe action. Active visible UI and latest screenshot are more authoritative than old queue assumptions.",
        "page.stageExit.continueAllowed is a cheap backend guess, not proof — it has been wrong before (e.g. missing a second required radio group bundled into a section that already had one choice made). Before clicking page.stageExit.continueTargetId, look at the ENTIRE screenshot yourself: any required-looking radio group, checkbox, or dropdown that still shows a placeholder/unselected state, or any red/warning icon or asterisk near an empty control, even if page.sections or page.taskQueue call that area 'complete'. If you find one, act on that control instead of clicking Continue, regardless of what continueAllowed says.",
        "If actionHistory shows you already clicked page.stageExit.continueTargetId and the page did not advance (same fields, same step, still here), do not click it again — that is a strong signal something required is still unanswered somewhere on the visible page; scan the screenshot for it instead of repeating Continue.",
        "Continue is represented by page.stageExit, not as a normal task. Only choose page.stageExit.continueTargetId after the visual check above finds nothing outstanding.",
        "Do not modify sections whose status is complete unless page.errors explicitly targets that section.",
        "Prefer filling known traveler fields, declining routine paid extras when approvalState.skipPaidExtrasApproved is true, and clicking safe Continue buttons.",
        "When skipPaidExtrasApproved is true and an overlay is a seat, baggage, bundle, cancellation, flexible ticket, insurance, or add-on popup, do not ask the user; choose the safe decline/skip/next action if one is available.",
        "Do not select controls that are already selected; if skip choices are already selected, proceed with a safe Continue action.",
        "Use element boxes to match screenshot-visible controls to targetIds; prefer visible primary/bottom Continue buttons over header/footer or skip links.",
        "If an element appears outside the active checkout content, avoid it unless no safer target exists.",
        "Use the screenshot as visual context when DOM text is incomplete or confusing.",
        "If page.overlays contains a visible dialog, menu, or listbox, resolving it is normally the priority before assuming the previous page is done — unless the screenshot shows it's already effectively resolved or irrelevant to the current goal.",
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

function deterministicReconciledDecision(payload) {
  const page = payload.page || {};
  const nextTask = page.reconciliation?.nextTask;
  const activeSurface = page.activeSurface || {};
  const noExtrasApproved = noExtrasApprovedForPayload(payload);
  if (activeSurface.type && activeSurface.type !== "page" && noExtrasApproved) {
    const decline = safeDeclineSurfaceOption(activeSurface);
    if (decline?.id) {
      return normalizeAgentDecision({
        source: "reconciler",
        action: "click",
        targetId: decline.id,
        value: "",
        message: `Resolving the open ${activeSurface.type}: ${decline.label}.`,
        needsApproval: false,
        risk: "safe",
        reason: "Active surface resolver found a visible safe decline / zero-cost option and saved traveler rules approve skipping paid extras."
      });
    }
  }
  if (page.stageExit?.continueAllowed && page.stageExit.continueTargetId) {
    return normalizeAgentDecision({
      source: "reconciler",
      action: "click",
      targetId: page.stageExit.continueTargetId,
      value: "",
      message: "All required sections are verified. Continuing to the next checkout step.",
      needsApproval: false,
      risk: "safe",
      reason: "Backend reconciler found no pending tasks, no overlays, no errors, and a safe Continue button."
    });
  }

  if (nextTask && ["contact", "passenger"].includes(nextTask.sectionType)) {
    return normalizeAgentDecision({
      source: "reconciler",
      action: "fill_known_fields",
      targetId: nextTask.sectionId,
      value: "",
      message: `Filling ${nextTask.sectionLabel} from the saved traveler profile.`,
      needsApproval: false,
      risk: "safe",
      reason: "Backend reconciler found a pending profile section."
    });
  }

  if (nextTask && noExtrasApproved && /baggage|bundle|flexible_ticket|cancellation_insurance|seat/.test(nextTask.sectionType)) {
    const section = (page.sections || []).find((item) => item.id === nextTask.sectionId);
    const decline = (section?.choices || []).find((choice) => (
      /decline_baggage|decline_paid_extra/.test(choice.semantic || "")
      || /no checked baggage|no,?\s*thanks|none of the passengers|go without|random seat/i.test(choice.label || "")
    ));
    if (decline?.id) {
      return normalizeAgentDecision({
        source: "reconciler",
        action: "click",
        targetId: decline.id,
        value: "",
        message: `Applying saved no-extras rule: ${decline.label}.`,
        needsApproval: false,
        risk: "safe",
        reason: `Backend reconciler selected the safe decline choice for ${nextTask.sectionLabel}.`
      });
    }
    const dropdown = (section?.fields || []).find((field) => (
      /required_dropdown_choice|unknown/.test(field.semantic || field.field || "")
      && /choose|select|option|dropdown|combobox/i.test(`${field.label || ""} ${field.kind || ""}`)
      && !field.hasValue
    ));
    if (dropdown?.id) {
      return normalizeAgentDecision({
        source: "reconciler",
        action: "select",
        targetId: dropdown.id,
        value: "None of the passengers",
        message: `Applying saved no-extras rule for ${nextTask.sectionLabel}: selecting the zero-cost/no-passenger option.`,
        needsApproval: false,
        risk: "safe",
        reason: "Backend reconciler found a pending no-extras dropdown and selected the safe decline value."
      });
    }
  }

  return null;
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
    activeSurface: clampText(page.activeSurface?.label || page.activeSurface?.type || "", 140),
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
  return summarizeActionLedgerRow(row);
}

function findFieldById(scopedPayload, targetId) {
  if (!targetId) return null;
  const page = scopedPayload.page || {};
  const direct = (page.fields || []).find((field) => field.id === targetId);
  if (direct) return direct;
  for (const section of page.sections || []) {
    const match = (section.fields || []).find((field) => field.id === targetId);
    if (match) return match;
  }
  return null;
}

function correctActionForFieldKind(decision, scopedPayload) {
  if (decision.action !== "type") return decision;
  const field = findFieldById(scopedPayload, decision.targetId);
  if (!field || !["radio", "checkbox"].includes(field.kind)) return decision;
  logAgent("auto-corrected decision: type -> click on radio/checkbox field", { targetId: decision.targetId, kind: field.kind, originalValue: decision.value });
  return {
    ...decision,
    action: "click",
    value: "",
    reason: `${decision.reason} (Auto-corrected: target is a ${field.kind} control, so clicking instead of typing.)`
  };
}

async function decideAgentNextAction(body) {
  const payload = compactAgentPayload(body);
  const existingSession = getAgentSession(payload.sessionId);
  const reconciledPayload = reconcilePageState(payload, existingSession);
  const session = updateAgentSessionFromPayload(existingSession, reconciledPayload);
  const scopedPayload = scopePayloadToCurrentTask(reconciledPayload);
  logAgent("request", {
    sessionId: payload.sessionId,
    site: reconciledPayload.page?.site,
    step: reconciledPayload.page?.step,
    activeSurface: reconciledPayload.page?.activeSurface?.type || "page",
    summary: reconciledPayload.page?.summary
  });
  logAgent("sections detected", (reconciledPayload.page?.sections || []).map((section) => ({
    label: section.label,
    type: section.type,
    status: section.status,
    paidChoice: section.paidChoice,
    fieldCount: (section.fields || []).length,
    choiceCount: (section.choices || []).length
  })));
  logAgent("fields on page", (reconciledPayload.page?.fields || []).map((field) => ({
    label: field.label?.slice(0, 60),
    kind: field.kind,
    detectedAs: field.field,
    confidence: field.confidence,
    hasValue: field.hasValue
  })));
  logAgent("task queue", (reconciledPayload.page?.taskQueue || []).map((task) => ({
    section: task.sectionLabel,
    type: task.sectionType,
    status: task.status,
    objective: task.objective
  })));
  if (reconciledPayload.page?.activeSurface?.type && reconciledPayload.page.activeSurface.type !== "page") {
    logAgent("active surface (popup/dropdown open)", {
      type: reconciledPayload.page.activeSurface.type,
      label: reconciledPayload.page.activeSurface.label,
      options: (reconciledPayload.page.activeSurface.options || []).map((option) => option.label)
    });
  }
  try {
    if (session) scopedPayload.taskState = summarizeAgentSession(session);
    logAgent("calling openai", { model: AGENT_MODEL, currentTask: scopedPayload.page?.currentTask?.sectionLabel || "" });
    const aiDecision = await callOpenAiAgent(scopedPayload);
    if (!aiDecision) {
      logAgent("openai returned no decision");
      return aiUnavailableDecision("OpenAI returned no decision");
    }
    logAgent("openai decision", aiDecision);
    const normalized = correctActionForFieldKind(normalizeAgentDecision({ ...aiDecision, source: "openai" }), scopedPayload);
    if (!decisionInsideCurrentScope(normalized, scopedPayload)) {
      logAgent("decision rejected: target not found on page and no usable label", { targetId: normalized.targetId, value: normalized.value, currentTask: scopedPayload.page?.currentTask?.sectionLabel || "" });
      return normalizeAgentDecision({
        source: "reconciler",
        action: "wait",
        targetId: "",
        value: "",
        message: "The control the AI picked isn't on the page anymore (likely replaced by the page re-rendering) and there was no visible label to fall back on, so I'm rescanning.",
        needsApproval: false,
        risk: "safe",
        reason: `Current task is ${scopedPayload.page?.currentTask?.sectionLabel || "unknown"}.`
      });
    }
    if (session) {
      const sectionSnapshot = (reconciledPayload.page?.sections || []).map((section) => `${section.type}:${section.status}`).join("|");
      const decisionSignature = `${normalized.action}:${normalized.targetId}:${normalized.value}`;
      const isRepeat = decisionSignature === session.lastDecisionSignature && sectionSnapshot === session.lastSectionSnapshot;
      session.stallCount = isRepeat ? (session.stallCount || 0) + 1 : 0;
      session.lastDecisionSignature = decisionSignature;
      session.lastSectionSnapshot = sectionSnapshot;
      if (session.stallCount >= 3) {
        logAgent("stall detected: same decision repeated with no section progress", { decisionSignature, repeats: session.stallCount });
        return normalizeAgentDecision({
          source: "reconciler",
          action: "ask_user",
          targetId: "",
          value: "",
          message: `I tried the same action ${session.stallCount + 1} times without any visible progress (last attempt: ${normalized.message || normalized.reason || "no message"}). Stopping here so you can take over this step.`,
          needsApproval: true,
          risk: "uncertain",
          reason: "Stalled: identical decision repeated with no detected section progress."
        });
      }
    }
    logAgent("decision accepted", { action: normalized.action, targetId: normalized.targetId, risk: normalized.risk });
    return normalized;
  } catch (error) {
    logAgent("ERROR", { message: error.message });
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

  if (req.method === "POST" && pathname === "/api/agent/next-action") {
    const body = await readBody(req);
    const decision = await decideAgentNextActionViaLoop(body);
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

  if (req.method === "GET" && pathname.startsWith("/api/agent/session/")) {
    const sessionId = pathname.slice("/api/agent/session/".length);
    const state = agentSessionStore.getSession(sessionId);
    if (!state) return sendJson(res, 404, { error: "Checkout session not found" });
    return sendJson(res, 200, state);
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
    sendJson(res, 500, { error: "Server error" });
  }
});

server.listen(PORT, HOST, () => {
  ensureDb();
  console.log(`Air Travel Wallet running at http://localhost:${PORT}`);
});
