const { test, expect } = require("@playwright/test");

const API = `http://127.0.0.1:${Number(process.env.ATW_TEST_PORT || 4273)}/api`;

function selectedBookingAcquisition(observationId, travelerId = "trav_selected_booking") {
  const itineraryEvidence = {
    segmentId: "segment_sjj_ist",
    source: "itinerary_owner",
    ownerKey: "itinerary:SJJ:IST:2026-10-15",
    role: "itinerary_segment",
    ownerType: "selected_flight",
    qualification: "owned_route_with_departure_date",
    observationId,
    confidence: 1,
    authoritative: true
  };
  return {
    contractVersion: "selected-booking-acquisition/v1",
    capturedAt: new Date().toISOString(),
    sourceUrl: "https://example.test/flights/selected",
    observationId,
    facts: {
      contractVersion: "transaction-facts/v2",
      evidenceMode: "typed",
      itinerary: {
        completeness: "complete",
        segments: [{
          segmentId: "segment_sjj_ist",
          origin: "SJJ",
          destination: "IST",
          departureDate: "2026-10-15",
          evidence: itineraryEvidence
        }]
      },
      travelers: [{ travelerId, name: "Selected Traveler" }],
      currency: "EUR",
      basePrice: null,
      totalPrice: { amount: 362, currency: "EUR" },
      fareBrand: "Economy Light",
      selectedExtras: [],
      factEvidence: {
        itinerary: [itineraryEvidence],
        fareBrand: {
          source: "owned_fare_summary_line",
          ownerKey: "fare:Economy Light",
          role: "fare_brand",
          ownerType: "selected_booking_summary",
          qualification: "owned_fare_brand",
          observationId,
          confidence: 1,
          authoritative: true
        },
        totalPrice: {
          source: "owned_price_summary",
          ownerKey: "booking-total:SJJ-IST:362:EUR",
          role: "booking_total",
          ownerType: "selected_booking_summary",
          qualification: "booking_total",
          observationId,
          confidence: 1,
          authoritative: true
        }
      },
      provenance: [{ source: "flight_selection", observationId, confidence: 1 }]
    }
  };
}

function selectedBookingContract(observationId, travelerId = "trav_selected_booking") {
  const acquisition = selectedBookingAcquisition(observationId, travelerId);
  return {
    contractVersion: "selected-booking/v1",
    selectionId: observationId,
    selectedAt: acquisition.capturedAt,
    sourceUrl: acquisition.sourceUrl,
    itinerary: acquisition.facts.itinerary,
    approvedTotal: acquisition.facts.totalPrice,
    fareBrand: acquisition.facts.fareBrand,
    travelerIds: travelerId ? [travelerId] : []
  };
}

function routineTraveler(id, overrides = {}) {
  return {
    id,
    first_name: "Ali",
    last_name: "Example",
    date_of_birth: "2003-05-31",
    email: "ali@example.test",
    phone: "+38640111222",
    paid_extras_policy: "decline",
    standard_booking_terms: "accept",
    marketing_consent: "decline",
    payment_preference: "card",
    payment_submission: "never",
    ...overrides
  };
}

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

test("a final selected booking contract starts the durable transaction", async ({ request }) => {
  const travelerId = `trav_composed_booking_${Date.now()}`;
  const bookingContract = selectedBookingContract(`obs_composed_${Date.now()}`, travelerId);
  const response = await request.post(`${API}/agent/session`, {
    data: {
      goal: "Complete checkout safely.",
      traveler: routineTraveler(travelerId),
      selectedBookingContract: bookingContract,
      page: { site: "example.test", url: "https://example.test/checkout", step: "traveler_information" }
    }
  });
  expect(response.status()).toBe(201);
  const started = await response.json();
  expect(started.id).toMatch(/^chk_/);
  const durable = await (await request.get(`${API}/agent/session/${started.id}`)).json();
  expect(durable).toMatchObject({
    travelerId,
    transactionInvariants: {
      baselineStatus: "approved",
      baseline: {
        travelers: [{ travelerId }],
        totalPrice: { amount: 362, currency: "EUR" }
      }
    }
  });
});

test("a malformed captured route is rejected before durable transaction creation", async ({ request }) => {
  const travelerId = `trav_malformed_booking_${Date.now()}`;
  const bookingContract = selectedBookingContract(`obs_malformed_${Date.now()}`, travelerId);
  bookingContract.itinerary.segments[0] = {
    ...bookingContract.itinerary.segments[0],
    origin: "ADD",
    destination: "ONS"
  };
  const response = await request.post(`${API}/agent/session`, {
    data: {
      goal: "Complete checkout safely.",
      traveler: routineTraveler(travelerId),
      selectedBookingContract: bookingContract,
      page: { site: "example.test", url: "https://example.test/checkout", step: "traveler_information" }
    }
  });
  expect(response.status()).toBe(422);
  expect(await response.json()).toMatchObject({
    code: "SELECTED_BOOKING_INVALID",
    details: { missingFacts: expect.arrayContaining(["itinerary_route"]) }
  });
});

test("a final booking contract without a selected request traveler creates no transaction", async ({ request }) => {
  const contractTravelerId = `trav_contract_only_${Date.now()}`;
  const response = await request.post(`${API}/agent/session`, {
    data: {
      goal: "Complete checkout safely.",
      traveler: {},
      selectedBookingContract: selectedBookingContract(`obs_no_traveler_${Date.now()}`, contractTravelerId),
      page: { site: "example.test", url: "https://example.test/checkout", step: "traveler_information" }
    }
  });
  expect(response.status()).toBe(422);
  expect(await response.json()).toMatchObject({
    code: "SELECTED_TRAVELER_REQUIRED",
    error: "Select at least one wallet traveler before starting checkout."
  });
});

test("raw airline acquisition cannot create a transaction without a final selected booking", async ({ request }) => {
  const travelerId = `trav_raw_acquisition_${Date.now()}`;
  const response = await request.post(`${API}/agent/session`, {
    data: {
      goal: "Complete checkout safely.",
      traveler: routineTraveler(travelerId),
      selectedBooking: selectedBookingAcquisition(`obs_raw_acquisition_${Date.now()}`, travelerId),
      page: { site: "example.test", url: "https://example.test/checkout", step: "traveler_information" }
    }
  });
  expect(response.status()).toBe(422);
  expect(await response.json()).toMatchObject({
    code: "SELECTED_BOOKING_REQUIRED"
  });
});

test("a traveler checkout with hidden itinerary creates no provisional session", async ({ request }) => {
  const travelerId = `trav_no_booking_${Date.now()}`;
  const response = await request.post(`${API}/agent/session`, {
    data: {
      goal: "Complete checkout safely.",
      traveler: routineTraveler(travelerId),
      page: { site: "example.test", url: "https://example.test/checkout", step: "traveler_information" }
    }
  });
  expect(response.status()).toBe(422);
  expect(await response.json()).toMatchObject({
    code: "SELECTED_BOOKING_REQUIRED"
  });
});

test("an engine-only stop remains the same resumable durable transaction", async ({ request }) => {
  const travelerId = `trav_engine_pause_${Date.now()}`;
  const startedResponse = await request.post(`${API}/agent/session`, {
    data: {
      goal: "Continue checkout safely.",
      traveler: routineTraveler(travelerId),
      selectedBookingContract: selectedBookingContract(`obs_engine_pause_${Date.now()}`, travelerId),
      page: { site: "example.test", url: "https://example.test/checkout", step: "payment" }
    }
  });
  expect(startedResponse.status()).toBe(201);
  const started = await startedResponse.json();

  const reported = await request.post(`${API}/agent/report`, {
    data: {
      sessionId: started.id,
      result: {
        type: "stop",
        actionId: "act_engine_reconciliation",
        userActionRequired: false,
        outcome: { code: "MISSING_DECISION_FACT" }
      },
      page: { site: "example.test", url: "https://example.test/checkout", step: "payment" }
    }
  });
  expect(reported.status()).toBe(200);
  expect((await reported.json()).status).toBe("stopped");

  const resumed = await request.post(`${API}/agent/session`, {
    data: {
      sessionId: started.id,
      resumeOnly: true,
      traveler: { id: travelerId },
      page: { site: "example.test", url: "https://example.test/checkout", step: "payment" }
    }
  });
  expect(resumed.status()).toBe(201);
  expect(await resumed.json()).toMatchObject({ id: started.id, status: "running" });
});

test("P0.2 one session handshake resumes the exact transaction and rejects replacement", async ({ request }) => {
  const travelerId = `trav_${Date.now()}`;
  const started = await request.post(`${API}/agent/session`, {
    data: {
      goal: "Complete checkout safely.",
      traveler: routineTraveler(travelerId, { booking_rules: "No paid extras" }),
      selectedBookingContract: selectedBookingContract(`obs_session_${Date.now()}`, travelerId),
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

test("new session rejects a request traveler outside the immutable selected booking", async ({ request }) => {
  const contractTravelerId = `trav_contract_${Date.now()}`;
  const requestTravelerId = `trav_request_${Date.now()}`;
  const response = await request.post(`${API}/agent/session`, {
    data: {
      goal: "Complete checkout safely.",
      traveler: { id: requestTravelerId },
      selectedBookingContract: selectedBookingContract(`obs_traveler_mismatch_${Date.now()}`, contractTravelerId),
      page: { site: "example.test", url: "https://example.test/checkout", step: "traveler_information" }
    }
  });
  expect(response.status()).toBe(409);
  expect(await response.json()).toMatchObject({
    code: "TRAVELER_IDENTITY_MISMATCH",
    error: "The selected wallet traveler is not authorized by the selected booking contract."
  });
});

test("resume rejects a changed wallet traveler and preserves the durable identity", async ({ request }) => {
  const durableTravelerId = `trav_durable_${Date.now()}`;
  const started = await request.post(`${API}/agent/session`, {
    data: {
      goal: "Complete checkout safely.",
      traveler: routineTraveler(durableTravelerId),
      selectedBookingContract: selectedBookingContract(`obs_durable_traveler_${Date.now()}`, durableTravelerId),
      page: { site: "example.test", url: "https://example.test/checkout", step: "traveler_information" }
    }
  });
  const initial = await started.json();
  expect(started.status(), JSON.stringify(initial)).toBe(201);

  const conflicting = await request.post(`${API}/agent/session`, {
    data: {
      sessionId: initial.id,
      resumeOnly: true,
      traveler: { id: `trav_changed_${Date.now()}` },
      selectedBookingContract: selectedBookingContract(`obs_ignored_resume_${Date.now()}`, `trav_changed_contract_${Date.now()}`),
      page: { site: "example.test", url: "https://example.test/checkout", step: "traveler_information" }
    }
  });
  expect(conflicting.status()).toBe(409);
  expect(await conflicting.json()).toMatchObject({ code: "TRAVELER_IDENTITY_MISMATCH" });

  const durable = await (await request.get(`${API}/agent/session/${initial.id}`)).json();
  expect(durable.travelerId).toBe(durableTravelerId);
  expect(durable.transactionInvariants.baseline.travelers).toEqual([
    expect.objectContaining({ travelerId: durableTravelerId })
  ]);
});

test("selected flight facts enter the durable baseline before the passenger page hides them", async ({ request }) => {
  const observationId = `obs_selected_booking_${Date.now()}`;
  const travelerId = `trav_selected_booking_${Date.now()}`;
  const started = await request.post(`${API}/agent/session`, {
    data: {
      goal: "Complete checkout safely.",
      traveler: routineTraveler(travelerId),
      selectedBookingContract: selectedBookingContract(observationId, travelerId),
      page: {
        site: "example.test",
        url: "https://example.test/checkout/passengers",
        step: "traveler_information",
        transactionFacts: { itinerary: { completeness: "unknown", segments: [] } }
      }
    }
  });
  const session = await started.json();
  expect(started.status(), JSON.stringify(session)).toBe(201);

  const durable = await request.get(`${API}/agent/session/${session.id}`);
  const state = await durable.json();
  expect(durable.status()).toBe(200);
  expect(state.transactionInvariants.baseline.itinerary.segments).toEqual([
    expect.objectContaining({ origin: "SJJ", destination: "IST", departureDate: "2026-10-15" })
  ]);
  expect(state.transactionInvariants.baselineObservationId).toBe(observationId);
  expect(state.transactionInvariants.baseline.totalPrice).toEqual({ amount: 362, currency: "EUR" });
  expect(state.transactionInvariants.baseline.currency).toBe("EUR");
  expect(state.transactionInvariants.baseline.travelers).toEqual([
    expect.objectContaining({ travelerId })
  ]);
  expect(state.transactionInvariants.baseline.fareBrand).toBe("Economy Light");

  const resumed = await request.post(`${API}/agent/session`, {
    data: {
      sessionId: session.id,
      resumeOnly: true,
      traveler: { id: state.travelerId, date_of_birth: "2003-05-31" },
      page: {
        site: "example.test",
        url: "https://example.test/checkout/passengers",
        step: "traveler_information"
      }
    }
  });
  expect(resumed.status()).toBe(201);
  const afterResume = await (await request.get(`${API}/agent/session/${session.id}`)).json();
  expect(afterResume.transactionInvariants.baseline.itinerary.segments[0].departureDate).toBe("2026-10-15");
});

test("a structured missing traveler answer crosses HTTP and resumes the exact field", async ({ request }) => {
  const traveler = {
    ...routineTraveler(`trav_missing_nationality_${Date.now()}`),
    nationality: "",
    booking_rules: "No paid extras"
  };
  const started = await request.post(`${API}/agent/session`, {
    data: {
      goal: "Complete traveler information",
      traveler,
      selectedBookingContract: selectedBookingContract(`obs_session_${Date.now()}`, traveler.id),
      page: {
        site: "example.test",
        url: "https://example.test/checkout/traveler",
        step: "traveler_information"
      }
    }
  });
  const session = await started.json();
  expect(started.status(), JSON.stringify(session)).toBe(201);

  const pageFor = (observationId) => ({
    observationContract: "structural-observation/v1",
    site: "example.test",
    url: "https://example.test/checkout/traveler",
    step: "traveler_information",
    heading: "Traveler information",
    snapshotHash: `hash_${observationId}`,
    currentSurface: {
      id: "surface-page",
      type: "page",
      blocksBackground: false,
      memberControlIds: ["ctrl_nationality"],
      memberActuatorIds: ["nationality_select"],
      observationId
    },
    fields: [{
      id: "nationality_select",
      controlId: "ctrl_nationality",
      field: "nationality",
      fieldType: "nationality",
      label: "Nationality",
      kind: "select",
      role: "combobox",
      required: true,
      hasValue: false,
      controlState: { valuePresent: false, normalizedValue: "" },
      sectionType: "passenger"
    }],
    controls: [{
      controlId: "ctrl_nationality",
      label: "Nationality",
      kind: "select",
      role: "combobox",
      semantic: "nationality",
      fieldType: "nationality",
      risk: "safe",
      surfaceId: "surface-page",
      surfaceType: "page",
      state: { disabled: false, required: true, valuePresent: false, normalizedValue: "" },
      stateElementId: "nationality_select",
      preferredActivationElementId: "nationality_select",
      options: [
        { value: "TR", label: "Türkiye" },
        { value: "US", label: "United States" }
      ],
      operations: {
        select: {
          operation: "select",
          actuatorId: "nationality_select",
          actuatorIds: ["nationality_select"],
          actionability: {
            rendered: true,
            visible: true,
            enabled: true,
            inViewport: true,
            inCurrentSurface: true,
            hitTested: true,
            notOccluded: true,
            targetable: true,
            operationAuthorized: true,
            operationProven: true,
            executable: true,
            revealable: false,
            code: "ACTIONABLE",
            operation: "select"
          }
        }
      }
    }],
    decisionGroups: [],
    validationIssues: []
  });

  const firstObservationId = `obs_missing_nationality_${Date.now()}`;
  const first = await request.post(`${API}/agent/next-action`, {
    data: {
      sessionId: session.id,
      observationId: firstObservationId,
      observationSnapshot: { snapshotHash: `hash_${firstObservationId}` },
      traveler,
      page: pageFor(firstObservationId)
    }
  });
  const ask = await first.json();
  expect(first.status(), JSON.stringify(ask)).toBe(200);
  expect(ask).toMatchObject({
    action: "ask_user",
    inputRequest: {
      field: "nationality",
      label: "nationality",
      subjectId: traveler.id,
      sensitive: false
    }
  });

  const secondObservationId = `obs_answered_nationality_${Date.now()}`;
  const second = await request.post(`${API}/agent/next-action`, {
    data: {
      sessionId: session.id,
      observationId: secondObservationId,
      observationSnapshot: { snapshotHash: `hash_${secondObservationId}` },
      userMessage: "TR",
      userResponse: {
        requestId: ask.inputRequest.requestId,
        field: "nationality",
        value: "TR",
        hasValue: true
      },
      traveler,
      page: pageFor(secondObservationId)
    }
  });
  const resumed = await second.json();
  expect(second.status(), JSON.stringify(resumed)).toBe(200);
  expect(resumed).toMatchObject({
    action: "select",
    actionLease: {
      target: {
        controlId: "ctrl_nationality",
        actuatorId: "nationality_select"
      },
      mechanic: { value: "TR" }
    }
  });
});

test("oversized observations receive a typed retryable transport error", async ({ request }) => {
  const travelerId = `trav_large_${Date.now()}`;
  const started = await request.post(`${API}/agent/session`, {
    data: {
      goal: "Test observation transport",
      traveler: routineTraveler(travelerId, { booking_rules: "No paid extras" }),
      selectedBookingContract: selectedBookingContract(`obs_session_${Date.now()}`, travelerId),
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
        observationContract: "structural-observation/v1",
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

test("the selected booking contract creates authoritative ownership evidence in the durable baseline", async ({ request }) => {
  const travelerId = `trav_transaction_evidence_${Date.now()}`;
  const observationId = `obs_transaction_evidence_${Date.now()}`;
  const observedRouteEvidence = {
    source: "bounded_checkout_route",
    ownerKey: "route_owner_1",
    role: "itinerary_segment",
    ownerType: "selected_flight",
    qualification: "airport_code_pair",
    observationId,
    confidence: 0.88,
    authoritative: true
  };
  const bookingContract = selectedBookingContract(observationId, travelerId);
  bookingContract.itinerary.segments = [{
    segmentId: "segment_1",
    origin: "LHR",
    destination: "LJU",
    departureDate: "2026-08-10",
    departureTime: "10:20",
    arrivalTime: "13:30",
    flightNumber: ""
  }];
  bookingContract.approvedTotal = { amount: 208, currency: "EUR" };
  bookingContract.fareBrand = "Economy Light";
  const started = await request.post(`${API}/agent/session`, {
    data: {
      goal: "Reach verified payment review",
      traveler: routineTraveler(travelerId, { booking_rules: "No paid extras" }),
      selectedBookingContract: bookingContract,
      page: { site: "example.test", url: "https://example.test/checkout", step: "traveler_information" }
    }
  });
  const session = await started.json();
  expect(started.status(), JSON.stringify(session)).toBe(201);
  const admittedState = await (await request.get(`${API}/agent/session/${session.id}`)).json();
  expect(admittedState.transactionInvariants.baseline.itinerary.segments).toEqual([
    expect.objectContaining({ origin: "LHR", destination: "LJU", departureDate: "2026-08-10" })
  ]);

  const response = await request.post(`${API}/agent/next-action`, {
    data: {
      sessionId: session.id,
      observationId,
      observationSnapshot: { snapshotHash: `hash_${observationId}` },
      traveler: { id: travelerId, first_name: "Ali", last_name: "Example", booking_rules: "No paid extras" },
      page: {
        observationContract: "structural-observation/v1",
        site: "example.test",
        url: "https://example.test/checkout",
        step: "traveler_information",
        currentSurface: { id: "surface-page", type: "page", blocksBackground: false },
        controls: [],
        decisionGroups: [],
        transactionFacts: {
          contractVersion: "transaction-facts/v2",
          evidenceMode: "typed",
          itinerary: {
            completeness: "complete",
            segments: [{
              segmentId: "segment_1",
              origin: "LHR",
              destination: "LJU",
              departureDate: "2026-08-10",
              departureTime: "10:20",
              arrivalTime: "13:30",
              flightNumber: "",
              evidence: observedRouteEvidence
            }]
          },
          travelers: [{ travelerId, name: "Ali Example" }],
          currency: "EUR",
          basePrice: { amount: null, currency: "EUR" },
          totalPrice: { amount: 208, currency: "EUR" },
          fareBrand: "Economy Light",
          selectedExtras: [],
          factEvidence: {
            itinerary: [{ segmentId: "segment_1", ...observedRouteEvidence }],
            fareBrand: {
              source: "owned_fare_summary_line",
              ownerKey: "fare_owner_1",
              observationId,
              confidence: 0.9,
              authoritative: true
            },
            totalPrice: {
              source: "owned_price_summary",
              ownerKey: "selected_booking_summary",
              role: "booking_total",
              ownerType: "selected_booking_summary",
              qualification: "coherent_itinerary_and_total",
              observationId,
              confidence: 0.9,
              authoritative: true
            },
            travelers: {
              source: "selected_traveler_profile",
              ownerKey: travelerId,
              observationId,
              confidence: 1,
              authoritative: true
            }
          },
          provenance: [{ source: "order_summary", observationId, confidence: 0.88 }]
        }
      }
    }
  });
  const body = await response.json();
  expect(response.status(), JSON.stringify(body)).toBe(200);
  expect(body.debug.transactionReview.baseline).toMatchObject({
    itinerary: {
      segments: [{
        origin: "LHR",
        destination: "LJU",
        evidence: {
          source: "product_selected_booking",
          authoritative: true
        }
      }]
    },
    fareBrand: "Economy Light",
    factEvidence: {
      itinerary: [{
        source: "product_selected_booking",
        authoritative: true
      }],
      fareBrand: {
        source: "product_selected_booking",
        authoritative: true
      }
    }
  });
  expect(body.debug.transactionReview.baselineStatus).toBe("approved");
});

test("authoritative terminal evidence survives HTTP compaction without payment capabilities", async ({ request }) => {
  const travelerId = `trav_terminal_transport_${Date.now()}`;
  const started = await request.post(`${API}/agent/session`, {
    data: {
      goal: "Reach verified payment review",
      traveler: routineTraveler(travelerId, { booking_rules: "Stop before real payment" }),
      selectedBookingContract: selectedBookingContract(`obs_session_${Date.now()}`, travelerId),
      page: { site: "example.test", url: "https://example.test/checkout", step: "traveler_information" }
    }
  });
  const session = await started.json();
  expect(started.status(), JSON.stringify(session)).toBe(201);

  const observationId = `obs_terminal_transport_${Date.now()}`;
  const response = await request.post(`${API}/agent/next-action`, {
    data: {
      sessionId: session.id,
      observationId,
      observationSnapshot: { snapshotHash: `hash_${observationId}` },
      traveler: { id: travelerId, first_name: "Ali", last_name: "Example", booking_rules: "Stop before real payment" },
      page: {
        observationContract: "structural-observation/v1",
        site: "example.test",
        url: "https://example.test/checkout/payment",
        step: "payment",
        currentSurface: { id: "surface-page", type: "page", blocksBackground: false },
        controls: [],
        decisionGroups: [],
        terminalEvidence: {
          contractVersion: "terminal-evidence/v2",
          stage: "card_credential_entry",
          signals: { route: true, progress: true, form: true, method: true, commit: false, legal: false, review: true, heading: true },
          signalStates: { route: "present", progress: "present", form: "present", method: "present", commit: "unknown", legal: "unknown", review: "present", heading: "present" },
          signalCount: 6,
          boundaryObserved: true,
          verified: true,
          cardCredentialEntryObserved: true,
          hostedCardEntryPresent: true,
          evidenceOnly: true,
          paymentCredentialKinds: [],
          evidenceSources: ["visible_owned_payment_labels", "visible_hosted_payment_widget", "active_payment_progress"],
          capabilities: { paymentActionsAllowed: false }
        }
      }
    }
  });
  const body = await response.json();
  expect(response.status(), JSON.stringify(body)).toBe(200);
  expect(body.debug.paymentEvidence).toMatchObject({
    boundaryObserved: true,
    contractVersion: "terminal-evidence/v2",
    signals: { route: true, progress: true, form: true, method: true, review: true },
    paymentActionsAllowed: false,
    boundary: {
      observed: true,
      hostedCardEntryPresent: true
    }
  });
  expect(body.debug.stageDecisionEvidence.terminalEvidence).toMatchObject({
    boundaryObserved: true,
    cardCredentialEntryObserved: true,
    hostedCardEntryPresent: true,
    evidenceOnly: true,
    evidenceSources: expect.arrayContaining([
      "visible_owned_payment_labels",
      "visible_hosted_payment_widget",
      "active_payment_progress"
    ]),
    capabilities: { paymentActionsAllowed: false }
  });
});

test("non-empty decision-group alternatives survive HTTP compaction with their control identity", async ({ request }) => {
  const travelerId = `trav_decision_group_${Date.now()}`;
  const started = await request.post(`${API}/agent/session`, {
    data: {
      goal: "Decline paid seats safely",
      traveler: routineTraveler(travelerId, { booking_rules: "No paid seats" }),
      selectedBookingContract: selectedBookingContract(`obs_session_${Date.now()}`, travelerId),
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
        observationContract: "structural-observation/v1",
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
      label: "No thanks"
    }]
  });
});

test("selected paid evidence and owned reversal survive the extension-to-backend boundary", async ({ request }) => {
  const travelerId = `trav_paid_boundary_${Date.now()}`;
  const started = await request.post(`${API}/agent/session`, {
    data: {
      goal: "Continue without paid extras",
      traveler: routineTraveler(travelerId, { booking_rules: "No paid extras" }),
      selectedBookingContract: selectedBookingContract(`obs_session_${Date.now()}`, travelerId),
      page: { site: "example.test", url: "https://example.test/checkout", step: "seats" }
    }
  });
  const session = await started.json();
  expect(started.status(), JSON.stringify(session)).toBe(201);

  const observationId = `obs_paid_boundary_${Date.now()}`;
  const response = await request.post(`${API}/agent/next-action`, {
    data: {
      sessionId: session.id,
      observationId,
      observationSnapshot: { snapshotHash: `hash_${observationId}` },
      userIntent: "No paid extras",
      traveler: { id: session.travelerId || "trav_paid_boundary", booking_rules: "No paid extras" },
      page: {
        observationContract: "structural-observation/v1",
        site: "example.test",
        url: "https://example.test/checkout/seats",
        step: "seats",
        snapshotHash: `hash_${observationId}`,
        currentSurface: {
          id: "surface_paid_summary",
          type: "modal",
          blocksBackground: true,
          memberControlIds: ["ctrl_remove_paid"],
          memberActuatorIds: ["remove-paid-node"],
          observationId
        },
        controls: [{
          controlId: "ctrl_remove_paid",
          decisionGroupId: "dg_paid_summary",
          label: "Undo",
          accessibleName: "Undo",
          kind: "button",
          role: "button",
          semantic: "remove_paid_extra",
          physicalEffect: "select_free_option",
          risk: "safe_decline",
          surfaceId: "surface_paid_summary",
          surfaceType: "modal",
          stateElementId: "remove-paid-node",
          preferredActivationElementId: "remove-paid-node",
          operations: {
            activate: {
              operation: "activate",
              actuatorId: "remove-paid-node",
              actuatorIds: ["remove-paid-node"],
              actionability: {
                rendered: true,
                visible: true,
                enabled: true,
                inViewport: true,
                inCurrentSurface: true,
                hitTested: true,
                notOccluded: true,
                operationAuthorized: true,
                executable: true,
                revealable: false,
                code: "ACTIONABLE"
              }
            }
          }
        }],
        decisionGroups: [{
          decisionGroupId: "dg_paid_summary",
          surfaceId: "surface_paid_summary",
          sectionType: "unknown",
          sectionLabel: "Traveller information",
          requirementId: "unknown:selected-item",
          required: false,
          status: "satisfied",
          selectedControlId: "",
          selectedLabel: "Selected item 23 EUR",
          selectedSemantic: "selected_paid_item",
          selectedEvidence: {
            selected: true,
            disposition: "paid",
            structuredPrice: { amount: 23, currency: "EUR" },
            source: "owned_selected_item_summary",
            ownerElementId: "selected-item-node",
            selectedControlId: "",
            selectedLabel: "Selected item 23 EUR",
            semantic: "selected_paid_item",
            risk: "money"
          },
          semanticOwnership: {
            status: "resolved",
            family: "seat",
            source: "grounded_ai",
            controlId: "ctrl_remove_paid",
            requirement: "optional",
            priceDisposition: "paid",
            policyCompatibility: "conflict",
            confidence: "high",
            rationale: "Grounded selected item and exact reversal."
          },
          removalControlId: "ctrl_remove_paid",
          alternativeControlIds: ["ctrl_remove_paid"]
        }],
        transactionFacts: {
          selectedExtras: [{
            decisionGroupId: "dg_paid_summary",
            label: "Selected item 23 EUR",
            disposition: "paid",
            priceAmount: 23,
            currency: "EUR"
          }]
        },
        validationIssues: []
      }
    }
  });
  const decision = await response.json();
  expect(response.status(), JSON.stringify(decision)).toBe(200);

  const transactionResponse = await request.get(`${API}/agent/transaction/${session.id}`);
  expect(transactionResponse.status()).toBe(200);
  const transaction = await transactionResponse.json();
  const group = transaction.currentObservation.page.decisionGroups.find((item) => item.decisionGroupId === "dg_paid_summary");
  expect(group).toMatchObject({
    alternativeControlIds: ["ctrl_remove_paid"],
    selectedEvidence: {
      selected: true,
      structuredPrice: { amount: 23, currency: "EUR" },
      ownerElementId: "selected-item-node"
    }
  });
  expect(group.removalControlId).toBeUndefined();
  expect(group.semanticOwnership).toBeUndefined();
});

test("incremental observation transport reconstructs the canonical page and rejects a stale base", async ({ request }) => {
  const travelerId = `trav_incremental_${Date.now()}`;
  const started = await request.post(`${API}/agent/session`, {
    data: {
      goal: "Continue without paid extras",
      traveler: routineTraveler(travelerId, { booking_rules: "No paid extras" }),
      selectedBookingContract: selectedBookingContract(`obs_session_${Date.now()}`, travelerId),
      page: { site: "example.test", url: "https://example.test/checkout", step: "extras" }
    }
  });
  const session = await started.json();
  expect(started.status(), JSON.stringify(session)).toBe(201);
  const initialId = `obs_incremental_initial_${Date.now()}`;
  const initialHash = `hash_${initialId}`;
  const unchangedControl = {
    controlId: "ctrl_background_help",
    stableKey: "button|testid:background-help",
    label: "Help",
    kind: "button",
    role: "button",
    semantic: "open_surface",
    risk: "safe",
    surfaceId: "surface-page",
    stateElementId: "background-help",
    preferredActivationElementId: "background-help",
    operations: {}
  };
  const freeControl = {
    controlId: "ctrl_free_option",
    stableKey: "radio|name:extra|value:none",
    decisionGroupId: "dg_extra",
    label: "No extra",
    kind: "radio",
    role: "radio",
    semantic: "decline_paid_extra",
    physicalEffect: "select_free_option",
    risk: "safe_decline",
    surfaceId: "surface-page",
    stateElementId: "free-option",
    preferredActivationElementId: "free-option",
    state: { selected: false, checked: false },
    operations: {}
  };
  const profileControl = {
    controlId: "ctrl_profile_title_mr",
    stableKey: "radio|name:title|value:mr",
    decisionGroupId: "dg_profile_title",
    label: "Mr",
    kind: "radio",
    role: "radio",
    field: "title",
    fieldType: "title",
    fieldClassification: { fieldType: "title", source: "radio_group_label", confidence: 0.98, evidence: ["Title"] },
    semantic: "title",
    risk: "safe",
    surfaceId: "surface-page",
    stateElementId: "profile-title-mr",
    preferredActivationElementId: "profile-title-mr",
    currentValue: "",
    state: { selected: false, checked: false, optionValue: "mr", selectedValue: "", normalizedValue: "" },
    operations: {}
  };
  const initial = await request.post(`${API}/agent/next-action`, {
    data: {
      sessionId: session.id,
      observationId: initialId,
      observationSnapshot: { snapshotHash: initialHash },
      traveler: { id: session.travelerId || "trav_incremental", booking_rules: "No paid extras" },
      page: {
        observationContract: "structural-observation/v1",
        site: "example.test",
        url: "https://example.test/checkout",
        step: "extras",
        snapshotHash: initialHash,
        controls: [unchangedControl, freeControl, profileControl],
        controlAliases: [
          { aliasId: unchangedControl.controlId, controlId: unchangedControl.controlId, kind: "control" },
          { aliasId: freeControl.controlId, controlId: freeControl.controlId, kind: "control" },
          { aliasId: profileControl.controlId, controlId: profileControl.controlId, kind: "control" }
        ],
        decisionGroups: [{
          decisionGroupId: "dg_extra",
          surfaceId: "surface-page",
          required: false,
          status: "active",
          alternativeControlIds: [freeControl.controlId]
        }],
        currentSurface: { id: "surface-page", type: "page", memberControlIds: [unchangedControl.controlId, freeControl.controlId, profileControl.controlId] }
      }
    }
  });
  expect(initial.status(), await initial.text()).toBe(200);

  const nextId = `obs_incremental_next_${Date.now()}`;
  const nextHash = `hash_${nextId}`;
  const selectedFree = { ...freeControl, selected: true, state: { selected: true, checked: true } };
  const selectedProfile = {
    ...profileControl,
    selected: true,
    currentValue: "mr",
    state: { ...profileControl.state, selected: true, checked: true, selectedValue: "mr", normalizedValue: "mr" }
  };
  const incremental = await request.post(`${API}/agent/next-action`, {
    data: {
      sessionId: session.id,
      observationId: nextId,
      observationSnapshot: { snapshotHash: nextHash },
      observationUpdate: {
        mode: "incremental",
        baseSnapshotHash: initialHash,
        snapshotHash: nextHash,
        diff: { stateChanges: [{ controlId: freeControl.controlId }], removedControls: [] }
      },
      traveler: { id: session.travelerId || "trav_incremental", booking_rules: "No paid extras" },
      page: {
        incremental: true,
        site: "example.test",
        url: "https://example.test/checkout",
        step: "extras",
        snapshotHash: nextHash,
        controls: [selectedFree, selectedProfile],
        controlAliases: [
          { aliasId: selectedFree.controlId, controlId: selectedFree.controlId, kind: "control" },
          { aliasId: selectedProfile.controlId, controlId: selectedProfile.controlId, kind: "control" }
        ],
        decisionGroups: [{
          decisionGroupId: "dg_extra",
          surfaceId: "surface-page",
          required: false,
          status: "satisfied",
          selectedControlId: selectedFree.controlId,
          selectedLabel: selectedFree.label,
          alternativeControlIds: [selectedFree.controlId]
        }],
        currentSurface: { id: "surface-page", type: "page", memberControlIds: [unchangedControl.controlId, selectedFree.controlId, selectedProfile.controlId] }
      }
    }
  });
  expect(incremental.status(), await incremental.text()).toBe(200);
  const transaction = await (await request.get(`${API}/agent/transaction/${session.id}`)).json();
  expect(transaction.currentObservation.page.controls).toHaveLength(3);
  expect(transaction.currentObservation.page.controls.find((control) => control.controlId === freeControl.controlId)?.selected).toBe(true);
  expect(transaction.currentObservation.page.controls.some((control) => control.controlId === unchangedControl.controlId)).toBe(true);
  expect(transaction.currentObservation.page.controls.find((control) => control.controlId === profileControl.controlId)).toMatchObject({
    currentValue: "mr",
    selected: true,
    state: { selectedValue: "mr", optionValue: "mr" }
  });

  const stale = await request.post(`${API}/agent/next-action`, {
    data: {
      sessionId: session.id,
      observationId: `obs_incremental_stale_${Date.now()}`,
      observationSnapshot: { snapshotHash: "hash_stale_delta" },
      observationUpdate: {
        mode: "incremental",
        baseSnapshotHash: "wrong_base_hash",
        snapshotHash: "hash_stale_delta",
        diff: {}
      },
      page: { incremental: true, controls: [], currentSurface: { id: "surface-page", type: "page" } }
    }
  });
  expect(stale.status()).toBe(409);
  expect(await stale.json()).toMatchObject({ code: "OBSERVATION_RESYNC_REQUIRED", retryable: true });

  const referenceId = `obs_reference_retry_${Date.now()}`;
  const reference = await request.post(`${API}/agent/next-action`, {
    data: {
      sessionId: session.id,
      observationId: referenceId,
      observationSnapshot: { snapshotHash: nextHash },
      observationUpdate: {
        mode: "reference",
        baseSnapshotHash: nextHash,
        snapshotHash: nextHash,
        material: false,
        diff: {}
      },
      page: {
        referenceOnly: true,
        snapshotHash: nextHash
      },
      destinationReadiness: { retryToken: "retry_current_surface_once" }
    }
  });
  expect(reference.status(), await reference.text()).toBe(200);
  const referencedTransaction = await (await request.get(`${API}/agent/transaction/${session.id}`)).json();
  expect(referencedTransaction.currentObservation.observationId).toBe(referenceId);
  expect(referencedTransaction.currentObservation.page.controls).toHaveLength(3);
  expect(referencedTransaction.currentObservation.page.controls.some((control) => control.controlId === unchangedControl.controlId)).toBe(true);

  const staleReference = await request.post(`${API}/agent/next-action`, {
    data: {
      sessionId: session.id,
      observationId: `obs_reference_stale_${Date.now()}`,
      observationSnapshot: { snapshotHash: "hash_reference_stale" },
      observationUpdate: {
        mode: "reference",
        baseSnapshotHash: "wrong_reference_base",
        snapshotHash: "hash_reference_stale",
        material: false,
        diff: {}
      },
      page: { referenceOnly: true, snapshotHash: "hash_reference_stale" }
    }
  });
  expect(staleReference.status()).toBe(409);
  expect(await staleReference.json()).toMatchObject({
    code: "OBSERVATION_RESYNC_REQUIRED",
    retryable: true
  });
});
