const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { normalizeCanonicalDate } = require("../agent/date-field-codec");
const { requestBodyError } = require("../http/body");

function uid(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function now() {
  return new Date().toISOString();
}

function normalizeTravelPurpose(value, fallback = "leisure") {
  const normalized = String(value || "").trim().toLowerCase();
  return ["leisure", "business"].includes(normalized) ? normalized : fallback;
}

function createWalletStore({ dataDir, dbFile, encryptionKey }) {
  const key = crypto.createHash("sha256").update(encryptionKey || "local-dev-key-change-me").digest();

  function encryptSensitive(value) {
    if (!value) return null;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString("base64")}.${tag.toString("base64")}.${encrypted.toString("base64")}`;
  }

  function decryptSensitive(value) {
    if (!value) return "";
    const [iv, tag, encrypted] = String(value).split(".");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]).toString("utf8");
  }

  function maskDocument(prefix, documentLast4) {
    if (!documentLast4) return "Not added";
    return `${prefix || "P"}****${documentLast4}`;
  }

  function seedDb() {
    const workspaceId = uid("wrk");
    const travelerId = uid("trav");
    return {
      workspaces: [{ id: workspaceId, name: "Northstar Ops", owner_user_id: "local_user", created_at: now() }],
      workspace_members: [{
        id: uid("mem"),
        workspace_id: workspaceId,
        user_id: "local_user",
        email: "ops@example.com",
        role: "owner",
        created_at: now()
      }],
      traveler_profiles: [{
        id: travelerId,
        workspace_id: workspaceId,
        created_by_user_id: "local_user",
        first_name: "Maya",
        middle_name: "",
        last_name: "Patel",
        second_last_name: "",
        date_of_birth: "1990-04-12",
        place_of_birth: "San Francisco",
        gender: "female",
        nationality: "US",
        country_of_residence: "US",
        email: "maya.patel@example.test",
        phone: "+1 202 555 0147",
        address_line1: "100 Test Avenue",
        address_line2: "Suite 4",
        city: "San Francisco",
        state: "CA",
        postal_code: "94105",
        country: "US",
        frequent_flyer_program: "Demo Miles",
        frequent_flyer_number: "DM123456789",
        known_traveler_number: "999999999",
        redress_number: "9999999",
        emergency_contact_name: "Jordan Example",
        emergency_contact_relationship: "Friend",
        emergency_contact_phone: "+1 202 555 0188",
        emergency_contact_email: "jordan.example@example.test",
        meal_preference: "standard meal",
        special_assistance: "none",
        travel_purpose: "leisure",
        preferred_seat: "aisle",
        baggage_preference: "cabin bag",
        default_cabin: "economy",
        invoice_company: "Northstar Ops LLC",
        billing_tax_id: "US-123456789",
        billing_address: "22 Market Street, San Francisco, CA 94105",
        billing_email: "invoices@example.com",
        payment_preference: "browser saved card",
        paid_extras_policy: "decline",
        standard_booking_terms: "accept",
        marketing_consent: "decline",
        payment_submission: "never",
        booking_rules: "Avoid paid seats, insurance, support bundles, SMS updates, and paid extras unless I explicitly approve. Stop before real payment.",
        created_at: now(),
        updated_at: now()
      }],
      traveler_documents: [{
        id: uid("doc"),
        traveler_profile_id: travelerId,
        document_type: "passport",
        issuing_country: "US",
        issue_date: "2024-10-21",
        encrypted_document_number: encryptSensitive("P1234567"),
        document_number_last4: "4567",
        expiry_date: "2026-10-20",
        created_at: now(),
        updated_at: now()
      }],
      trips: [{
        id: uid("trip"),
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
      }],
      invites: [],
      preferences: { selected_traveler_id: travelerId }
    };
  }

  function writeDb(db) {
    fs.writeFileSync(dbFile, JSON.stringify(db, null, 2));
  }

  function ensureDb() {
    fs.mkdirSync(dataDir || path.dirname(dbFile), { recursive: true });
    if (!fs.existsSync(dbFile)) writeDb(seedDb());
  }

  function readDb() {
    ensureDb();
    const raw = fs.readFileSync(dbFile, "utf8");
    const db = raw.trim() ? JSON.parse(raw) : seedDb();
    if (!raw.trim()) writeDb(db);
    let changed = false;
    for (const traveler of db.traveler_profiles || []) {
      const defaults = {
        billing_tax_id: "US-123456789",
        billing_address: "22 Market Street, San Francisco, CA 94105",
        billing_email: traveler.email || "invoices@example.com",
        payment_preference: "browser saved card",
        paid_extras_policy: "decline",
        standard_booking_terms: "accept",
        marketing_consent: "decline",
        payment_submission: "never",
        travel_purpose: "leisure",
        booking_rules: "Avoid paid seats, insurance, support bundles, SMS updates, and paid extras unless I explicitly approve. Stop before real payment."
      };
      for (const [field, value] of Object.entries(defaults)) {
        if (traveler[field] === undefined) {
          traveler[field] = value;
          changed = true;
        }
      }
      const normalizedPurpose = normalizeTravelPurpose(traveler.travel_purpose);
      if (traveler.travel_purpose !== normalizedPurpose) {
        traveler.travel_purpose = normalizedPurpose;
        changed = true;
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

  function publicTraveler(db, traveler) {
    const document = db.traveler_documents.find((item) => item.traveler_profile_id === traveler.id);
    return {
      ...traveler,
      travel_purpose: normalizeTravelPurpose(traveler.travel_purpose),
      document: document ? {
        id: document.id,
        document_type: document.document_type,
        issuing_country: document.issuing_country,
        issue_date: document.issue_date || "",
        document_number_last4: document.document_number_last4,
        masked_document_number: maskDocument("P", document.document_number_last4),
        expiry_date: document.expiry_date
      } : null
    };
  }

  function extensionTraveler(db, traveler) {
    const document = db.traveler_documents.find((item) => item.traveler_profile_id === traveler.id);
    return {
      ...publicTraveler(db, traveler),
      document: document ? {
        id: document.id,
        document_type: document.document_type,
        issuing_country: document.issuing_country,
        issue_date: document.issue_date || "",
        document_number: decryptSensitive(document.encrypted_document_number),
        document_number_last4: document.document_number_last4,
        masked_document_number: maskDocument("P", document.document_number_last4),
        expiry_date: document.expiry_date
      } : null
    };
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
    const rawDateOfBirth = String(body.date_of_birth || "").trim();
    const dateOfBirth = normalizeCanonicalDate(rawDateOfBirth);
    if (rawDateOfBirth && !dateOfBirth) {
      throw requestBodyError("INVALID_DATE_OF_BIRTH", "Date of birth must be a real date stored as YYYY-MM-DD.", 400);
    }
    return {
      ...existing,
      workspace_id: body.workspace_id || existing.workspace_id || "",
      created_by_user_id: existing.created_by_user_id || "local_user",
      first_name: String(body.first_name || "").trim(),
      middle_name: String(body.middle_name || "").trim(),
      last_name: String(body.last_name || "").trim(),
      second_last_name: String(body.second_last_name || "").trim(),
      date_of_birth: dateOfBirth,
      place_of_birth: body.place_of_birth || "",
      gender: body.gender || "",
      nationality: body.nationality || "",
      country_of_residence: body.country_of_residence || body.country || "",
      email: body.email || "",
      phone: body.phone || "",
      address_line1: body.address_line1 || "",
      address_line2: body.address_line2 || "",
      city: body.city || "",
      state: body.state || "",
      postal_code: body.postal_code || "",
      country: body.country || "",
      frequent_flyer_program: body.frequent_flyer_program || "",
      frequent_flyer_number: body.frequent_flyer_number || "",
      known_traveler_number: body.known_traveler_number || "",
      redress_number: body.redress_number || "",
      emergency_contact_name: body.emergency_contact_name || "",
      emergency_contact_relationship: body.emergency_contact_relationship || "",
      emergency_contact_phone: body.emergency_contact_phone || "",
      emergency_contact_email: body.emergency_contact_email || "",
      meal_preference: body.meal_preference || "",
      special_assistance: body.special_assistance || "",
      travel_purpose: normalizeTravelPurpose(body.travel_purpose || existing.travel_purpose),
      preferred_seat: body.preferred_seat || "no preference",
      baggage_preference: body.baggage_preference || "personal item",
      default_cabin: body.default_cabin || "economy",
      invoice_company: body.invoice_company || "",
      billing_tax_id: body.billing_tax_id || "",
      billing_address: body.billing_address || "",
      billing_email: body.billing_email || body.email || "",
      payment_preference: body.payment_preference || "browser saved card",
      paid_extras_policy: body.paid_extras_policy || existing.paid_extras_policy || "decline",
      standard_booking_terms: body.standard_booking_terms || existing.standard_booking_terms || "accept",
      marketing_consent: body.marketing_consent || existing.marketing_consent || "decline",
      // The current milestone never submits payment. This is persisted as an
      // explicit standing policy instead of being inferred from free text.
      payment_submission: "never",
      booking_rules: body.booking_rules || "Avoid paid seats, insurance, support bundles, SMS updates, and paid extras unless I explicitly approve. Stop before real payment.",
      updated_at: now()
    };
  }

  function upsertTravelerDocument(db, travelerId, body) {
    const hasDocumentInput = body.document_number || body.issue_date || body.expiry_date || body.issuing_country || body.document_type;
    if (!hasDocumentInput) return;
    let document = db.traveler_documents.find((item) => item.traveler_profile_id === travelerId);
    if (!document) {
      document = { id: uid("doc"), traveler_profile_id: travelerId, created_at: now() };
      db.traveler_documents.push(document);
    }
    document.document_type = body.document_type || document.document_type || "passport";
    document.issuing_country = body.issuing_country || body.nationality || document.issuing_country || "";
    document.issue_date = body.issue_date || document.issue_date || "";
    if (body.document_number) {
      document.encrypted_document_number = encryptSensitive(body.document_number);
      document.document_number_last4 = String(body.document_number).replace(/\s+/g, "").slice(-4);
    }
    document.expiry_date = body.expiry_date || document.expiry_date || "";
    document.updated_at = now();
  }

  return {
    bootstrapPayload,
    ensureDb,
    extensionBootstrapPayload,
    now,
    readDb,
    travelerFromBody,
    uid,
    upsertTravelerDocument,
    writeDb
  };
}

module.exports = { createWalletStore, normalizeTravelPurpose };
