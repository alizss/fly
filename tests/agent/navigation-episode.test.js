const test = require("node:test");
const assert = require("node:assert/strict");

const { createSessionService } = require("../../apps/web/agent/session-service");

function navigationState() {
  return {
    id: "chk_navigation",
    travelerId: "trav_1",
    executionEpisode: {
      contractVersion: "execution-episode/v2",
      actionId: "act_continue",
      observationId: "obs_review",
      obligationId: "obligation_advance",
      status: "leased",
      leasedAction: {
        actionLease: {
          contractVersion: "action-lease/v1",
          actionId: "act_continue",
          obligationId: "obligation_advance",
          candidateId: "candidate_continue",
          observation: { id: "obs_review", hash: "hash_review" },
          target: { controlId: "continue", actuatorId: "continue:click", surfaceId: "review" },
          mechanic: { actionType: "click", operation: "activate", method: "native", value: "Continue" },
          expected: {
            objective: "reach_actual_payment_entry",
            semanticEffect: "advance_to_payment",
            successCondition: { type: "payment_entry_reached", expectedBoundary: "PAYMENT_ENTRY" }
          },
          capabilityProof: { actionability: "executable" },
          risk: "reversible"
        }
      }
    }
  };
}

function storeFor(initial) {
  let state = structuredClone(initial);
  return {
    getSession(id) {
      return id === state.id ? structuredClone(state) : null;
    },
    saveSession(next) {
      state = structuredClone(next);
      return structuredClone(state);
    },
    recordActionEvent() {},
    current() {
      return structuredClone(state);
    }
  };
}

test("one durable ExecutionEpisode owns arm, destination claim, and ready state", () => {
  const store = storeFor(navigationState());
  const service = createSessionService(store);

  const armed = service.armNavigationEpisode({
    sessionId: "chk_navigation",
    actionId: "act_continue",
    observationId: "obs_review",
    sourceDocumentId: "document_review",
    sourceUrl: "https://booking.example/review",
    sourceOrigin: "https://booking.example"
  });
  assert.equal(armed.status, "ARMED");
  assert.equal(armed.episodeId, "navigation:chk_navigation:act_continue");
  assert.equal(store.current().executionEpisode.navigationEpisodeId, armed.episodeId);

  const claimed = service.claimNavigationEpisode({
    sessionId: "chk_navigation",
    episodeId: armed.episodeId,
    actionId: "act_continue",
    destinationDocumentId: "document_payment",
    tabContextId: "12",
    destinationUrl: "https://payments.example/form",
    destinationOrigin: "https://payments.example"
  });
  assert.equal(claimed.status, "DESTINATION_CLAIMED");
  assert.equal(claimed.destinationDocument.documentId, "document_payment");
  assert.equal(store.current().executionEpisode.closed, false);

  const ready = service.readyNavigationEpisode({
    sessionId: "chk_navigation",
    episodeId: armed.episodeId,
    actionId: "act_continue",
    destinationDocumentId: "document_payment",
    tabContextId: "12",
    observationId: "obs_payment",
    observationHash: "hash_payment",
    destinationUrl: "https://payments.example/form"
  });
  assert.equal(ready.status, "DESTINATION_READY");
  assert.equal(store.current().executionEpisode.destinationObservation.observationId, "obs_payment");
  assert.equal(store.current().executionEpisode.actionId, "act_continue");
});

test("one transaction uses separate action-scoped episodes for Croatia Confirm and PaymentForm Continue", () => {
  const initial = navigationState();
  initial.executionEpisode.actionId = "act_confirm";
  initial.executionEpisode.observationId = "obs_review";
  initial.executionEpisode.leasedAction.actionLease.actionId = "act_confirm";
  initial.executionEpisode.leasedAction.actionLease.observation = { id: "obs_review", hash: "hash_review" };
  const store = storeFor(initial);
  const service = createSessionService(store);

  const confirmEpisode = service.armNavigationEpisode({
    sessionId: "chk_navigation",
    actionId: "act_confirm",
    observationId: "obs_review",
    sourceDocumentId: "document_review",
    sourceUrl: "https://booking.croatiaairlines.com/review",
    sourceOrigin: "https://booking.croatiaairlines.com"
  });
  service.claimNavigationEpisode({
    sessionId: "chk_navigation",
    episodeId: confirmEpisode.episodeId,
    actionId: "act_confirm",
    destinationDocumentId: "document_payment_form",
    tabContextId: "12",
    destinationUrl: "https://www.croatiaairlines.com/en/PaymentForm",
    destinationOrigin: "https://www.croatiaairlines.com"
  });
  service.readyNavigationEpisode({
    sessionId: "chk_navigation",
    episodeId: confirmEpisode.episodeId,
    actionId: "act_confirm",
    destinationDocumentId: "document_payment_form",
    tabContextId: "12",
    observationId: "obs_payment_form",
    observationHash: "hash_payment_form",
    destinationUrl: "https://www.croatiaairlines.com/en/PaymentForm"
  });

  const afterConfirm = store.current();
  store.saveSession({
    ...afterConfirm,
    executionEpisode: {
      ...afterConfirm.executionEpisode,
      actionId: "act_payment_form_continue",
      observationId: "obs_payment_form",
      obligationId: "obligation_provider_handoff",
      status: "leased",
      navigationEpisodeId: "",
      navigationStatus: "",
      destinationDocument: null,
      destinationObservation: null,
      leasedAction: {
        actionLease: {
          contractVersion: "action-lease/v1",
          actionId: "act_payment_form_continue",
          obligationId: "obligation_provider_handoff",
          candidateId: "candidate_payment_form_continue",
          observation: { id: "obs_payment_form", hash: "hash_payment_form" },
          target: { controlId: "btnsubmit", actuatorId: "btnsubmit:activate", surfaceId: "payment_form" },
          mechanic: { actionType: "click", operation: "activate", method: "native", value: "Continue" },
          expected: {
            objective: "reach_actual_payment_entry",
            semanticEffect: "advance_to_payment",
            successCondition: { type: "payment_entry_reached", expectedBoundary: "PAYMENT_ENTRY" }
          },
          capabilityProof: { actionability: "executable" },
          risk: "reversible"
        }
      }
    }
  });

  const continueEpisode = service.armNavigationEpisode({
    sessionId: "chk_navigation",
    actionId: "act_payment_form_continue",
    observationId: "obs_payment_form",
    sourceDocumentId: "document_payment_form",
    sourceUrl: "https://www.croatiaairlines.com/en/PaymentForm",
    sourceOrigin: "https://www.croatiaairlines.com"
  });
  assert.notEqual(continueEpisode.episodeId, confirmEpisode.episodeId);
  assert.equal(continueEpisode.episodeId, "navigation:chk_navigation:act_payment_form_continue");
  const provider = service.claimNavigationEpisode({
    sessionId: "chk_navigation",
    episodeId: continueEpisode.episodeId,
    actionId: "act_payment_form_continue",
    destinationDocumentId: "document_wspay",
    tabContextId: "12",
    destinationUrl: "https://form.wspay.biz/authorization",
    destinationOrigin: "https://form.wspay.biz"
  });
  assert.equal(provider.sessionId, "chk_navigation");
  assert.equal(provider.actionId, "act_payment_form_continue");
  assert.equal(provider.destinationDocument.documentId, "document_wspay");
});

test("navigation claim is idempotent only for the exact destination document", () => {
  const store = storeFor(navigationState());
  const service = createSessionService(store);
  const armed = service.armNavigationEpisode({
    sessionId: "chk_navigation",
    actionId: "act_continue",
    sourceDocumentId: "document_review"
  });
  const destination = {
    sessionId: "chk_navigation",
    episodeId: armed.episodeId,
    actionId: "act_continue",
    destinationDocumentId: "document_payment",
    tabContextId: "12",
    destinationUrl: "https://payments.example/form",
    destinationOrigin: "https://payments.example"
  };

  const first = service.claimNavigationEpisode(destination);
  const retry = service.claimNavigationEpisode(destination);
  const competing = service.claimNavigationEpisode({
    ...destination,
    destinationDocumentId: "document_competing_controller",
    tabContextId: "13"
  });

  assert.equal(first.status, "DESTINATION_CLAIMED");
  assert.equal(retry.status, "DESTINATION_CLAIMED");
  assert.equal(retry.destinationDocument.documentId, "document_payment");
  assert.equal(competing, null);
  assert.equal(store.current().executionEpisode.destinationDocument.documentId, "document_payment");
});

test("a same-tab redirect chain advances ownership through a proved post-ready provider redirect", () => {
  const store = storeFor(navigationState());
  const service = createSessionService(store);
  const armed = service.armNavigationEpisode({
    sessionId: "chk_navigation",
    actionId: "act_continue",
    sourceDocumentId: "document_review"
  });
  const intermediate = service.claimNavigationEpisode({
    sessionId: "chk_navigation",
    episodeId: armed.episodeId,
    actionId: "act_continue",
    destinationDocumentId: "document_intermediate",
    tabContextId: "12",
    destinationUrl: "https://booking.example/handoff",
    destinationOrigin: "https://booking.example"
  });
  const finalDestination = service.claimNavigationEpisode({
    sessionId: "chk_navigation",
    episodeId: armed.episodeId,
    actionId: "act_continue",
    destinationDocumentId: "document_payment",
    tabContextId: "12",
    destinationUrl: "https://payments.example/form",
    destinationOrigin: "https://payments.example"
  });

  assert.equal(intermediate.destinationDocument.documentId, "document_intermediate");
  assert.equal(finalDestination.destinationDocument.documentId, "document_payment");
  assert.equal(store.current().executionEpisode.destinationClaimHistory.length, 1);
  assert.equal(store.current().executionEpisode.destinationClaimHistory[0].documentId, "document_intermediate");

  const staleReady = service.readyNavigationEpisode({
    sessionId: "chk_navigation",
    episodeId: armed.episodeId,
    actionId: "act_continue",
    destinationDocumentId: "document_intermediate",
    tabContextId: "12",
    observationId: "obs_intermediate",
    observationHash: "hash_intermediate",
    destinationUrl: "https://booking.example/handoff"
  });
  assert.equal(staleReady, null);

  service.readyNavigationEpisode({
    sessionId: "chk_navigation",
    episodeId: armed.episodeId,
    actionId: "act_continue",
    destinationDocumentId: "document_payment",
    tabContextId: "12",
    observationId: "obs_payment",
    observationHash: "hash_payment",
    destinationUrl: "https://payments.example/form"
  });
  const afterReady = service.claimNavigationEpisode({
    sessionId: "chk_navigation",
    episodeId: armed.episodeId,
    actionId: "act_continue",
    destinationDocumentId: "document_unrelated",
    tabContextId: "12",
    destinationUrl: "https://unrelated.example/",
    destinationOrigin: "https://unrelated.example"
  });
  assert.equal(afterReady, null);
  const providerRedirect = service.claimNavigationEpisode({
    sessionId: "chk_navigation",
    episodeId: armed.episodeId,
    actionId: "act_continue",
    destinationDocumentId: "document_provider",
    tabContextId: "12",
    destinationUrl: "https://payments.example/authorization",
    destinationOrigin: "https://payments.example",
    redirectContinuation: true
  });
  assert.equal(providerRedirect.status, "DESTINATION_CLAIMED");
  assert.equal(providerRedirect.destinationDocument.documentId, "document_provider");
  assert.equal(store.current().executionEpisode.destinationObservation, null);

  const providerReady = service.readyNavigationEpisode({
    sessionId: "chk_navigation",
    episodeId: armed.episodeId,
    actionId: "act_continue",
    destinationDocumentId: "document_provider",
    tabContextId: "12",
    observationId: "obs_provider",
    observationHash: "hash_provider",
    destinationUrl: "https://payments.example/authorization"
  });
  assert.equal(providerReady.status, "DESTINATION_READY");
  assert.equal(store.current().executionEpisode.destinationDocument.documentId, "document_provider");
});

test("a destination cannot claim a stale action-scoped navigation episode", () => {
  const store = storeFor(navigationState());
  const service = createSessionService(store);
  const armed = service.armNavigationEpisode({
    sessionId: "chk_navigation",
    actionId: "act_continue",
    sourceDocumentId: "document_review"
  });

  assert.equal(service.claimNavigationEpisode({
    sessionId: "chk_navigation",
    episodeId: armed.episodeId,
    actionId: "act_other",
    destinationDocumentId: "document_wrong"
  }), null);
  assert.equal(store.current().executionEpisode.destinationDocument, null);
});
