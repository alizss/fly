function createWalletRoutes({
  bootstrapPayload,
  extensionBootstrapPayload,
  now,
  readBody,
  sendJson,
  travelerFromBody,
  uid,
  upsertTravelerDocument,
  writeDb
}) {
  return async function handleWalletRoutes(req, res, pathname, db) {
    if (req.method === "GET" && pathname === "/api/bootstrap") {
      sendJson(res, 200, bootstrapPayload(db));
      return true;
    }
    if (req.method === "GET" && pathname === "/api/extension/bootstrap") {
      sendJson(res, 200, extensionBootstrapPayload(db));
      return true;
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
      sendJson(res, 201, bootstrapPayload(db));
      return true;
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
      sendJson(res, 201, bootstrapPayload(db));
      return true;
    }
    const travelerMatch = pathname.match(/^\/api\/travelers\/([^/]+)$/);
    if (travelerMatch && req.method === "POST") {
      const body = await readBody(req);
      const travelerId = travelerMatch[1];
      const index = db.traveler_profiles.findIndex((traveler) => traveler.id === travelerId);
      if (index === -1) {
        sendJson(res, 404, { error: "Traveler not found" });
        return true;
      }
      db.traveler_profiles[index] = travelerFromBody(body, db.traveler_profiles[index]);
      upsertTravelerDocument(db, travelerId, body);
      writeDb(db);
      sendJson(res, 200, bootstrapPayload(db));
      return true;
    }
    if (travelerMatch && req.method === "DELETE") {
      const travelerId = travelerMatch[1];
      const before = db.traveler_profiles.length;
      db.traveler_profiles = db.traveler_profiles.filter((traveler) => traveler.id !== travelerId);
      if (db.traveler_profiles.length === before) {
        sendJson(res, 404, { error: "Traveler not found" });
        return true;
      }
      db.traveler_documents = db.traveler_documents.filter((document) => document.traveler_profile_id !== travelerId);
      db.trips = db.trips.filter((trip) => trip.traveler_profile_id !== travelerId);
      db.preferences = db.preferences || {};
      if (db.preferences.selected_traveler_id === travelerId) {
        db.preferences.selected_traveler_id = db.traveler_profiles[0]?.id || "";
      }
      writeDb(db);
      sendJson(res, 200, bootstrapPayload(db));
      return true;
    }
    if (req.method === "POST" && pathname === "/api/preferences") {
      const body = await readBody(req);
      db.preferences = {
        ...(db.preferences || {}),
        selected_traveler_id: body.selected_traveler_id || db.preferences?.selected_traveler_id || ""
      };
      writeDb(db);
      sendJson(res, 200, bootstrapPayload(db));
      return true;
    }
    if (req.method === "POST" && pathname === "/api/trips") {
      const body = await readBody(req);
      db.trips.unshift({
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
      });
      writeDb(db);
      sendJson(res, 201, bootstrapPayload(db));
      return true;
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
      sendJson(res, 201, bootstrapPayload(db));
      return true;
    }
    return false;
  };
}

module.exports = { createWalletRoutes };
