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

test("selected paid evidence and owned reversal survive the extension-to-backend boundary", async ({ request }) => {
  const started = await request.post(`${API}/agent/session`, {
    data: {
      goal: "Continue without paid extras",
      traveler: { id: `trav_paid_boundary_${Date.now()}`, booking_rules: "No paid extras" },
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
    removalControlId: "ctrl_remove_paid",
    selectedEvidence: {
      selected: true,
      disposition: "paid",
      structuredPrice: { amount: 23, currency: "EUR" },
      ownerElementId: "selected-item-node"
    },
    semanticOwnership: {
      status: "resolved",
      family: "seat",
      controlId: "ctrl_remove_paid",
      policyCompatibility: "conflict"
    }
  });
});

test("incremental observation transport reconstructs the canonical page and rejects a stale base", async ({ request }) => {
  const started = await request.post(`${API}/agent/session`, {
    data: {
      goal: "Continue without paid extras",
      traveler: { id: `trav_incremental_${Date.now()}`, booking_rules: "No paid extras" },
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
    fieldType: "title",
    currentValue: "mr",
    selected: true,
    state: { selectedValue: "mr", optionValue: "mr" },
    fieldClassification: { fieldType: "title", source: "radio_group_label" }
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
});
