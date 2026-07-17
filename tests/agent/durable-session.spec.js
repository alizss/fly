const { test, expect } = require("@playwright/test");

const API = `http://127.0.0.1:${Number(process.env.ATW_TEST_PORT || 4273)}/api`;

test("P0.2 next-action refuses to create a replacement transaction without a session", async ({ request }) => {
  const response = await request.post(`${API}/agent/next-action`, {
    data: {
      sessionId: "",
      observationId: "obs_missing_session",
      observationSnapshot: { snapshotHash: "hash_missing_session" },
      page: { site: "example.test", url: "https://example.test/checkout", step: "traveler_information" }
    }
  });
  expect(response.status()).toBe(409);
  expect(await response.json()).toMatchObject({ code: "DURABLE_SESSION_REQUIRED" });
});

test("P0.2 one session handshake resumes the exact transaction and rejects replacement", async ({ request }) => {
  const travelerId = `trav_${Date.now()}`;
  const started = await request.post(`${API}/agent/session`, {
    data: {
      goal: "Complete checkout safely.",
      traveler: { id: travelerId, booking_rules: "No paid extras" },
      page: { site: "example.test", url: "https://example.test/checkout", step: "traveler_information" }
    }
  });
  const initialSession = await started.json();
  expect(started.status(), JSON.stringify(initialSession)).toBe(201);
  expect(initialSession.id).toMatch(/^chk_/);

  const resumed = await request.post(`${API}/agent/session`, {
    data: {
      sessionId: initialSession.id,
      resumeOnly: true,
      traveler: { id: travelerId, booking_rules: "No paid extras" },
      page: { site: "example.test", url: "https://example.test/checkout", step: "traveler_information" }
    }
  });
  expect(resumed.status()).toBe(201);
  expect((await resumed.json()).id).toBe(initialSession.id);

  const missing = await request.post(`${API}/agent/session`, {
    data: {
      sessionId: `missing_${Date.now()}`,
      resumeOnly: true,
      traveler: { id: "trav_missing" },
      page: { site: "example.test", url: "https://example.test/checkout", step: "traveler_information" }
    }
  });
  expect(missing.status()).toBe(409);
  expect(await missing.json()).toMatchObject({ code: "DURABLE_SESSION_NOT_FOUND" });
});

test("oversized observations receive a typed retryable transport error", async ({ request }) => {
  const started = await request.post(`${API}/agent/session`, {
    data: {
      goal: "Test observation transport",
      traveler: { id: `trav_large_${Date.now()}`, booking_rules: "No paid extras" },
      page: { site: "example.test", url: "https://example.test/checkout", step: "seats" }
    }
  });
  const session = await started.json();
  expect(started.status()).toBe(201);

  const response = await request.post(`${API}/agent/next-action`, {
    data: {
      sessionId: session.id,
      observationId: `obs_large_${Date.now()}`,
      observationSnapshot: { snapshotHash: "hash_large" },
      page: {
        site: "example.test",
        url: "https://example.test/checkout",
        step: "seats",
        oversizedDiagnostic: "x".repeat(5_600_000)
      }
    }
  });
  expect(response.status()).toBe(413);
  expect(await response.json()).toMatchObject({
    code: "OBSERVATION_TOO_LARGE",
    retryable: true
  });
});

test("non-empty decision-group alternatives survive HTTP compaction with their control identity", async ({ request }) => {
  const started = await request.post(`${API}/agent/session`, {
    data: {
      goal: "Decline paid seats safely",
      traveler: { id: `trav_decision_group_${Date.now()}`, booking_rules: "No paid seats" },
      page: { site: "example.test", url: "https://example.test/checkout", step: "seats" }
    }
  });
  const session = await started.json();
  expect(started.status(), JSON.stringify(session)).toBe(201);

  const observationId = `obs_decision_group_${Date.now()}`;
  const response = await request.post(`${API}/agent/next-action`, {
    data: {
      sessionId: session.id,
      observationId,
      observationSnapshot: { snapshotHash: `hash_${observationId}` },
      userIntent: "Continue without paid seats",
      traveler: { id: session.travelerId || "trav_decision_group", booking_rules: "No paid seats" },
      page: {
        site: "example.test",
        url: "https://example.test/checkout",
        step: "seats",
        controls: [{
          controlId: "ctrl_no_thanks",
          decisionGroupId: "dg_seat",
          label: "No thanks",
          accessibleName: "No thanks",
          kind: "radio",
          role: "radio",
          semantic: "decline_paid_extra",
          risk: "safe",
          surfaceId: "surface_seats",
          surfaceType: "modal",
          stateElementId: "seat-free",
          preferredActivationElementId: "seat-free",
          operations: {
            choose: {
              operation: "choose",
              actuatorId: "seat-free",
              expectedOutcome: "exact_option_selected"
            }
          }
        }],
        decisionGroups: [{
          decisionGroupId: "dg_seat",
          surfaceId: "surface_seats",
          required: true,
          status: "missing",
          alternativeControlIds: ["ctrl_no_thanks"]
        }],
        currentSurface: {
          id: "surface_seats",
          type: "modal",
          blocksBackground: true,
          memberControlIds: ["ctrl_no_thanks"],
          memberActuatorIds: ["seat-free"],
          observationId
        }
      }
    }
  });
  const decision = await response.json();
  expect(response.status(), JSON.stringify(decision)).toBe(200);

  const transactionResponse = await request.get(`${API}/agent/transaction/${session.id}`);
  expect(transactionResponse.status()).toBe(200);
  const transaction = await transactionResponse.json();
  expect(transaction.currentObservation.page.decisionGroups[0]).toMatchObject({
    decisionGroupId: "dg_seat",
    alternativeControlIds: ["ctrl_no_thanks"],
    alternatives: [{
      controlId: "ctrl_no_thanks",
      targetId: "seat-free",
      label: "No thanks",
      semantic: "decline_paid_extra"
    }]
  });
});
