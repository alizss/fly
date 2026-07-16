const { test, expect } = require("@playwright/test");

const API = `http://127.0.0.1:${Number(process.env.ATW_TEST_PORT || 4173)}/api`;

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
