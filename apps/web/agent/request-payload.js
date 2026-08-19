const agentContract = require("../../extension/src/shared/agent-contract");
const { PAGE_SURFACE_ID, normalizeSurface } = require("./surface-contract");
const { seatPolicyFrom } = require("./policy-profile");

function createRequestPayloadAdapter({ agentSessionStore, screenshotForObservation }) {
  function finiteNumberOrNull(value) {
    if (value === null || value === undefined || value === "" || typeof value === "object") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  
  function normalizeTravelPurpose(value, fallback = "leisure") {
    const normalized = String(value || "").trim().toLowerCase();
    return ["leisure", "business"].includes(normalized) ? normalized : fallback;
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
      surfaceClass: clampText(surface.surfaceClass || "unknown", 40),
      blocksBackground: Boolean(surface.blocksBackground),
      parentSurfaceId: clampText(surface.parentSurfaceId, 80),
      parentControlId: clampText(surface.parentControlId, 140),
      parentElementId: clampText(surface.parentElementId, 80),
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
      physicalEffect: clampText(item.physicalEffect, 80),
      testId: clampText(item.testId, 160),
      formAction: clampText(item.formAction, 300),
      formMethod: clampText(item.formMethod, 40),
      formId: clampText(item.formId, 160),
      ownText: clampText(item.ownText, 220),
      ariaLabel: clampText(item.ariaLabel, 220),
      title: clampText(item.title, 220),
      iconOnly: Boolean(item.iconOnly),
      semanticConflict: Boolean(item.semanticConflict),
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
      fieldClassification: item.fieldClassification?.fieldType ? {
        fieldType: clampText(item.fieldClassification.fieldType, 80),
        source: clampText(item.fieldClassification.source, 80),
        confidence: Number(item.fieldClassification.confidence || 0),
        evidence: Array.isArray(item.fieldClassification.evidence)
          ? item.fieldClassification.evidence.map((value) => clampText(value, 180)).filter(Boolean).slice(0, 4)
          : [],
        evidenceByChannel: item.fieldClassification.evidenceByChannel || null,
        tightOwnerId: clampText(item.fieldClassification.tightOwnerId, 100),
        tightOwnerKey: clampText(item.fieldClassification.tightOwnerKey, 240),
        ambiguity: item.fieldClassification.ambiguity || null
      } : null,
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
        actionability: compactActuatorActionability(capability.actionability),
        actionabilityByActuator: Object.fromEntries(Object.entries(capability.actionabilityByActuator || {})
          .slice(0, 8)
          .map(([id, evidence]) => [clampText(id, 80), compactActuatorActionability(evidence)])),
        precondition: capability.precondition || null,
        expectedOutcome: clampText(capability.expectedOutcome, 80)
      } : null
    ]));
  }
  
  function compactActuatorActionability(evidence = null) {
    if (!evidence || typeof evidence !== "object") return null;
    return {
      rendered: evidence.rendered === true,
      visible: evidence.visible === true,
      enabled: evidence.enabled === true,
      inViewport: evidence.inViewport === true,
      inCurrentSurface: evidence.inCurrentSurface === true,
      hitTested: evidence.hitTested === true,
      notOccluded: evidence.notOccluded === true,
      operationAuthorized: evidence.operationAuthorized === true,
      executable: evidence.executable === true,
      revealable: evidence.revealable === true,
      code: clampText(evidence.code, 80),
      surfaceId: clampText(evidence.surfaceId, 80),
      operation: clampText(evidence.operation, 40)
    };
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
    // The request is already bounded and JSON-decoded. Preserve every observed
    // semantic/capability property and normalize the shared contract in place;
    // do not reconstruct a second, lossy control schema here.
    return agentContract.serializeObservedControl(control);
  }
  
  function compactStructuredPrice(price = null) {
    if (!price || !Number.isFinite(Number(price.amount))) return null;
    return {
      amount: Number(price.amount),
      currency: clampText(price.currency, 12)
    };
  }
  
  function compactDecisionGroup(group = {}, controlsById = new Map(), selectedExtras = []) {
    const alternativeControlIds = Array.isArray(group.alternativeControlIds)
      ? group.alternativeControlIds
      : (group.alternatives || []).map((choice) => choice.controlId);
    const ids = [...new Set(alternativeControlIds.map((id) => clampText(id, 140)).filter(Boolean))];
    const decisionGroupId = clampText(group.decisionGroupId, 140);
    const transactionSelection = (selectedExtras || []).find((extra) => (
      clampText(extra?.decisionGroupId, 140) === decisionGroupId
      && (
        Number(extra?.priceAmount) > 0
        || (
          /paid|money|selected_paid/.test(clampText(extra?.disposition, 80).toLowerCase())
          && !/decline|free|remove|skip|without|none|not selected|no extra/.test(clampText(extra?.disposition, 80).toLowerCase())
        )
      )
    )) || null;
    const ownedReversalId = clampText(group.removalControlId, 140)
      || ids.find((controlId) => {
        const control = controlsById.get(controlId) || {};
        return /remove|decline|free|skip|without|none|deselect|clear/.test(
          `${control.semantic || ""} ${control.physicalEffect || ""} ${control.risk || ""}`.toLowerCase()
        );
      })
      || "";
    const rawEvidence = group.selectedEvidence || null;
    const selectedEvidence = rawEvidence || transactionSelection
      ? {
          selected: rawEvidence?.selected === true || Boolean(transactionSelection),
          disposition: clampText(rawEvidence?.disposition || transactionSelection?.disposition || "unknown", 40),
          structuredPrice: compactStructuredPrice(rawEvidence?.structuredPrice)
            || (transactionSelection && Number.isFinite(Number(transactionSelection.priceAmount))
              ? { amount: Number(transactionSelection.priceAmount), currency: clampText(transactionSelection.currency, 12) }
              : null),
          source: clampText(rawEvidence?.source || (transactionSelection ? "transaction_selected_extra" : ""), 80),
          ownerElementId: clampText(rawEvidence?.ownerElementId, 140),
          selectedControlId: clampText(rawEvidence?.selectedControlId || group.selectedControlId, 140),
          selectedLabel: clampText(rawEvidence?.selectedLabel || group.selectedLabel || transactionSelection?.label, 220),
          semantic: clampText(rawEvidence?.semantic || group.selectedSemantic || (transactionSelection ? "selected_paid_item" : ""), 80),
          risk: clampText(rawEvidence?.risk || (transactionSelection ? "money" : ""), 80)
        }
      : null;
    const rawOwnership = group.semanticOwnership || null;
    const semanticOwnership = rawOwnership || (transactionSelection && ownedReversalId)
      ? {
          status: clampText(rawOwnership?.status || "unknown", 40),
          family: clampText(rawOwnership?.family, 40),
          source: clampText(rawOwnership?.source || "transaction_fact_requires_semantic_resolution", 100),
          nearbySectionType: clampText(rawOwnership?.nearbySectionType || group.sectionType || "unknown", 80),
          nearbySectionLabel: clampText(rawOwnership?.nearbySectionLabel || group.sectionLabel, 160),
          ownerElementId: clampText(rawOwnership?.ownerElementId || selectedEvidence?.ownerElementId, 140),
          controlId: clampText(rawOwnership?.controlId || ownedReversalId, 140),
          requirement: clampText(rawOwnership?.requirement, 40),
          priceDisposition: clampText(rawOwnership?.priceDisposition || selectedEvidence?.disposition, 40),
          policyCompatibility: clampText(rawOwnership?.policyCompatibility, 40),
          confidence: clampText(rawOwnership?.confidence, 40),
          rationale: clampText(rawOwnership?.rationale, 240)
        }
      : null;
    return {
      ...agentContract.cloneSerializable(group),
      decisionGroupId,
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
      semanticOwnership,
      selectedEvidence,
      removalControlId: ownedReversalId,
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
          physicalEffect: control.physicalEffect || "unknown",
          risk: control.risk || "",
          selected: Boolean(control.selected || control.state?.selected || control.state?.checked),
          structuredPrice: compactStructuredPrice(control.structuredPrice),
          priceText: ""
        }];
      }),
      evidence: Array.isArray(group.evidence) ? group.evidence.map((item) => clampText(item, 180)).slice(0, 5) : []
    };
  }
  
  function mergeObservationRecords(previous = [], incoming = [], key, removedIds = new Set()) {
    const records = new Map();
    for (const item of previous || []) {
      const id = String(key(item) || "");
      if (id && !removedIds.has(id)) records.set(id, item);
    }
    for (const item of incoming || []) {
      const id = String(key(item) || "");
      if (id) records.set(id, item);
    }
    return [...records.values()];
  }
  
  function hydrateIncrementalAgentBody(body = {}) {
    const update = body.observationUpdate || {};
    if (update.mode === "reference" || body.page?.referenceOnly === true) {
      const sessionId = clampText(body.sessionId || "", 120);
      const previous = sessionId ? agentSessionStore.getCurrentObservation(sessionId) : null;
      const previousHash = String(previous?.observationSnapshot?.snapshotHash || previous?.page?.snapshotHash || "");
      const requestedHash = String(update.baseSnapshotHash || body.page?.snapshotHash || "");
      if (!previous?.page || !requestedHash || requestedHash !== previousHash) {
        const error = new Error("Observation reference does not match the current immutable page.");
        error.code = "OBSERVATION_RESYNC_REQUIRED";
        error.retryable = true;
        throw error;
      }
      return {
        ...body,
        transportMode: "observation_reference",
        page: {
          ...previous.page,
          referenceOnly: false,
          incremental: false,
          snapshotHash: previousHash
        }
      };
    }
    if (update.mode !== "incremental" || body.page?.incremental !== true) return body;
    const sessionId = clampText(body.sessionId || "", 120);
    const previous = sessionId ? agentSessionStore.getCurrentObservation(sessionId) : null;
    const previousHash = String(previous?.observationSnapshot?.snapshotHash || previous?.page?.snapshotHash || "");
    if (!previous?.page || !update.baseSnapshotHash || update.baseSnapshotHash !== previousHash) {
      const error = new Error("Incremental observation base does not match the current canonical page.");
      error.code = "OBSERVATION_RESYNC_REQUIRED";
      error.retryable = true;
      throw error;
    }
    const delta = body.page || {};
    const diff = update.diff || {};
    const removedControlIds = new Set((diff.removedControls || []).map((entry) => String(entry.controlId || "")).filter(Boolean));
    const changedControlIds = new Set([
      ...(delta.controls || []).map((control) => String(control.controlId || "")),
      ...removedControlIds
    ].filter(Boolean));
    const previousAliases = (previous.page.controlAliases || []).filter((entry) => !changedControlIds.has(String(entry.controlId || "")));
    const controls = mergeObservationRecords(
      previous.page.controls,
      delta.controls,
      (control) => control.controlId,
      removedControlIds
    );
    const aliases = mergeObservationRecords(
      previousAliases,
      delta.controlAliases,
      (entry) => entry.aliasId
    ).filter((entry) => controls.some((control) => control.controlId === entry.controlId));
    const decisionGroups = mergeObservationRecords(
      previous.page.decisionGroups,
      delta.decisionGroups,
      (group) => group.decisionGroupId
    ).filter((group) => (
      !group.selectedControlId || controls.some((control) => control.controlId === group.selectedControlId)
    ));
    const sections = mergeObservationRecords(
      previous.page.sections,
      delta.sections,
      (section) => section.id
    );
    return {
      ...body,
      transportMode: body.transportMode || "incremental_diff",
      page: {
        ...previous.page,
        ...delta,
        incremental: false,
        controls,
        controlAliases: aliases,
        decisionGroups,
        sections
      }
    };
  }
  
  function compactTransactionFactEvidence(entry = null) {
    if (!entry || typeof entry !== "object") return null;
    return {
      source: clampText(entry.source || "unknown", 80),
      ownerKey: clampText(entry.ownerKey, 180),
      role: clampText(entry.role, 40),
      ownerType: clampText(entry.ownerType, 60),
      qualification: clampText(entry.qualification, 80),
      observationId: clampText(entry.observationId, 120),
      confidence: Math.max(0, Math.min(1, Number(entry.confidence) || 0)),
      authoritative: entry.authoritative === true
    };
  }
  
  function compactTransactionFacts(facts = null) {
    if (!facts || typeof facts !== "object") return null;
    const compactItineraryEvidence = Array.isArray(facts.factEvidence?.itinerary)
      ? facts.factEvidence.itinerary.map((entry) => ({
          segmentId: clampText(entry?.segmentId, 120),
          ...compactTransactionFactEvidence(entry)
        })).filter((entry) => entry.segmentId && entry.ownerKey).slice(0, 12)
      : [];
    return {
      contractVersion: clampText(facts.contractVersion, 40),
      evidenceMode: clampText(facts.evidenceMode, 20),
      itinerary: {
        completeness: clampText(facts.itinerary?.completeness || "unknown", 20),
        segments: Array.isArray(facts.itinerary?.segments)
          ? facts.itinerary.segments.map((segment) => ({
              segmentId: clampText(segment.segmentId, 120),
              origin: clampText(segment.origin, 80),
              destination: clampText(segment.destination, 80),
              departureDate: clampText(segment.departureDate, 40),
              departureTime: clampText(segment.departureTime, 20),
              arrivalTime: clampText(segment.arrivalTime, 20),
              flightNumber: clampText(segment.flightNumber, 30),
              evidence: compactTransactionFactEvidence(segment.evidence)
            })).slice(0, 12)
          : []
      },
      travelers: Array.isArray(facts.travelers)
        ? facts.travelers.map((entry) => ({
            travelerId: clampText(entry.travelerId || entry.id, 120),
            name: clampText(entry.name, 160)
          })).slice(0, 12)
        : [],
      currency: clampText(facts.currency, 20),
      basePrice: facts.basePrice && typeof facts.basePrice === "object" ? {
        amount: finiteNumberOrNull(facts.basePrice.amount),
        currency: clampText(facts.basePrice.currency, 20)
      } : null,
      totalPrice: facts.totalPrice && typeof facts.totalPrice === "object" ? {
        amount: finiteNumberOrNull(facts.totalPrice.amount),
        currency: clampText(facts.totalPrice.currency, 20)
      } : null,
      fareBrand: clampText(facts.fareBrand, 120),
      selectedExtras: Array.isArray(facts.selectedExtras)
        ? facts.selectedExtras.map((extra) => ({
            decisionGroupId: clampText(extra.decisionGroupId, 140),
            outcomeKey: clampText(extra.outcomeKey, 180),
            family: clampText(extra.family || extra.subjectFamily, 40),
            subjectKey: clampText(extra.subjectKey || extra.subject, 120),
            label: clampText(extra.label, 180),
            disposition: clampText(extra.disposition, 80),
            outcome: clampText(extra.outcome || extra.semanticOutcome, 80),
            priceAmount: finiteNumberOrNull(extra.priceAmount),
            currency: clampText(extra.currency, 20)
          })).slice(0, 40)
        : [],
      factEvidence: {
        itinerary: compactItineraryEvidence,
        fareBrand: compactTransactionFactEvidence(facts.factEvidence?.fareBrand),
        totalPrice: compactTransactionFactEvidence(facts.factEvidence?.totalPrice),
        travelers: compactTransactionFactEvidence(facts.factEvidence?.travelers)
      },
      provenance: Array.isArray(facts.provenance)
        ? facts.provenance.map((entry) => ({
            source: clampText(entry.source, 80),
            observationId: clampText(entry.observationId, 120),
            confidence: Math.max(0, Math.min(1, Number(entry.confidence) || 0))
          })).slice(0, 20)
        : []
    };
  }
  
  function compactTerminalEvidence(evidence = null) {
    if (!evidence || typeof evidence !== "object") return null;
    const compiled = agentContract.compileTerminalEvidence({ terminalEvidence: evidence });
    const signals = compiled.signals || {};
    const signalStates = compiled.signalStates || {};
    return {
      contractVersion: clampText(compiled.contractVersion, 80),
      stage: clampText(compiled.stage, 80),
      signals: Object.fromEntries(Object.entries(signals).map(([key, value]) => [clampText(key, 40), value === true])),
      signalStates: Object.fromEntries(Object.entries(signalStates).map(([key, value]) => [clampText(key, 40), clampText(value, 20)])),
      signalCount: Number(compiled.signalCount || 0),
      boundaryObserved: compiled.boundaryObserved === true,
      verified: compiled.verified === true,
      evidenceOnly: true,
      paymentCredentialKinds: Array.isArray(compiled.paymentCredentialKinds)
        ? compiled.paymentCredentialKinds.map((kind) => clampText(kind, 60)).slice(0, 12)
        : [],
      evidenceSources: Array.isArray(compiled.evidenceSources)
        ? compiled.evidenceSources.map((source) => clampText(source, 80)).slice(0, 16)
        : [],
      capabilities: { paymentActionsAllowed: false }
    };
  }
  
  function compactAgentPayload(rawBody) {
    const body = hydrateIncrementalAgentBody(rawBody);
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
      observationUpdate: body.observationUpdate && typeof body.observationUpdate === "object" ? {
        mode: clampText(body.observationUpdate.mode || "full_snapshot", 40),
        baseSnapshotHash: clampText(body.observationUpdate.baseSnapshotHash, 120),
        snapshotHash: clampText(body.observationUpdate.snapshotHash, 120),
        diff: body.observationUpdate.diff && typeof body.observationUpdate.diff === "object"
          ? body.observationUpdate.diff
          : null
      } : null,
      destinationReadiness: body.destinationReadiness && typeof body.destinationReadiness === "object" ? {
        status: clampText(body.destinationReadiness.status, 60),
        startedAt: Number(body.destinationReadiness.startedAt || 0),
        deadlineAt: Number(body.destinationReadiness.deadlineAt || 0),
        attempts: Number(body.destinationReadiness.attempts || 0),
        backendWaits: Number(body.destinationReadiness.backendWaits || 0),
        deadlineObservationSent: Boolean(body.destinationReadiness.deadlineObservationSent),
        retryToken: clampText(body.destinationReadiness.retryToken, 180)
      } : null,
      userIntent: clampText(body.userIntent || "Complete checkout safely for the selected traveler.", 800),
      userMessage: clampText(body.userMessage || "", 800),
      userResponse: body.userResponse && typeof body.userResponse === "object"
        ? {
            requestId: clampText(body.userResponse.requestId, 160),
            field: clampText(body.userResponse.field, 120),
            value: clampText(body.userResponse.value, 600),
            valueRef: clampText(body.userResponse.valueRef, 160),
            hasValue: body.userResponse.hasValue === true
          }
        : null,
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
      lastActionResult: body.lastActionResult && typeof body.lastActionResult === "object" ? body.lastActionResult : null,
      traveler: {
        id: clampText(traveler.id, 120),
        first_name: clampText(traveler.first_name, 80),
        middle_name: clampText(traveler.middle_name, 80),
        last_name: clampText(traveler.last_name, 80),
        second_last_name: clampText(traveler.second_last_name, 80),
        name: clampText([traveler.first_name, traveler.middle_name, traveler.last_name, traveler.second_last_name].filter(Boolean).join(" "), 160),
        email: clampText(traveler.email, 160),
        phone: clampText(traveler.phone, 80),
        gender: clampText(traveler.gender, 40),
        date_of_birth: clampText(traveler.date_of_birth, 40),
        place_of_birth: clampText(traveler.place_of_birth, 120),
        nationality: clampText(traveler.nationality, 80),
        country_of_residence: clampText(traveler.country_of_residence, 80),
        address_line1: clampText(traveler.address?.line1 || traveler.address_line1 || traveler.billing_address, 240),
        address_line2: clampText(traveler.address?.line2 || traveler.address_line2, 240),
        city: clampText(traveler.address?.city || traveler.city || traveler.billing_city, 120),
        state: clampText(traveler.address?.state || traveler.address?.province || traveler.state || traveler.province, 120),
        postal_code: clampText(traveler.address?.postal_code || traveler.address?.postcode || traveler.postal_code || traveler.billing_postal_code, 40),
        country: clampText(traveler.address?.country || traveler.address_country || traveler.country, 80),
        frequent_flyer_program: clampText(traveler.frequent_flyer_program, 120),
        frequent_flyer_number: clampText(traveler.frequent_flyer_number, 120),
        known_traveler_number: clampText(traveler.known_traveler_number, 120),
        redress_number: clampText(traveler.redress_number, 120),
        emergency_contact_name: clampText(traveler.emergency_contact_name, 160),
        emergency_contact_relationship: clampText(traveler.emergency_contact_relationship, 80),
        emergency_contact_phone: clampText(traveler.emergency_contact_phone, 80),
        emergency_contact_email: clampText(traveler.emergency_contact_email, 160),
        meal_preference: clampText(traveler.meal_preference, 120),
        special_assistance: clampText(traveler.special_assistance, 500),
        travel_purpose: normalizeTravelPurpose(traveler.travel_purpose),
        payment_preference: clampText(traveler.payment_preference, 120),
        baggage_preference: clampText(traveler.baggage_preference, 120),
        preferred_seat: clampText(traveler.preferred_seat, 120),
        seat_policy: seatPolicyFrom({ traveler }),
        booking_rules: clampText(traveler.booking_rules, 800),
        document: traveler.document ? {
          document_type: clampText(traveler.document.document_type, 60),
          issuing_country: clampText(traveler.document.issuing_country, 80),
          issue_date: clampText(traveler.document.issue_date, 40),
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
        terminalEvidence: compactTerminalEvidence(page.terminalEvidence),
        transactionFacts: compactTransactionFacts(page.transactionFacts),
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
        readiness: page.readiness && typeof page.readiness === "object" ? {
          documentReadyState: clampText(page.readiness.documentReadyState, 24),
          ariaBusy: Boolean(page.readiness.ariaBusy),
          loadingIndicatorCount: Number(page.readiness.loadingIndicatorCount || 0),
          mainTextLength: Number(page.readiness.mainTextLength || 0),
          visibleMainCount: Number(page.readiness.visibleMainCount || 0),
          stableForMs: Number(page.readiness.stableForMs || 0)
        } : {},
        visibleText: clampText(page.text || page.fullText, 6000),
        errors: Array.isArray(page.errors) ? page.errors.map((item) => clampText(item, 220)).slice(0, 8) : [],
        validationIssues: Array.isArray(page.validationIssues)
          ? page.validationIssues.map((issue) => ({
              issueId: clampText(issue.issueId, 140),
              message: clampText(issue.message, 220),
              controlId: clampText(issue.controlId, 140),
              logicalFieldId: clampText(issue.logicalFieldId, 180),
              logicalOwnerKey: clampText(issue.logicalOwnerKey, 240),
              componentRole: clampText(issue.componentRole, 40),
              semanticType: clampText(issue.semanticType, 80),
              sectionId: clampText(issue.sectionId, 80),
              sectionType: clampText(issue.sectionType, 80),
              surfaceId: clampText(issue.surfaceId, 80),
              stageWide: Boolean(issue.stageWide),
              status: clampText(issue.status, 40),
              visible: issue.visible !== false,
              active: issue.active === true,
              errorCount: Number.isFinite(Number(issue.errorCount)) ? Number(issue.errorCount) : null,
              introducedAfterAction: issue.introducedAfterAction === true,
              invalidControlIds: Array.isArray(issue.invalidControlIds)
                ? issue.invalidControlIds.map((value) => clampText(value, 140)).filter(Boolean).slice(0, 8)
                : []
            })).filter((issue) => issue.message).slice(0, 12)
          : [],
        paidChoices: Array.isArray(page.paidChoices) ? page.paidChoices.map((item) => clampText(item, 160)).slice(0, 8) : [],
        completedFields: page.completedFields && typeof page.completedFields === "object" ? page.completedFields : {},
        sections,
        controls: canonicalControls,
        controlCollections: Array.isArray(page.controlCollections)
          ? page.controlCollections.map((collection) => ({
              collectionId: clampText(collection.collectionId, 140),
              type: clampText(collection.type, 80),
              decisionGroupId: clampText(collection.decisionGroupId, 140),
              sectionId: clampText(collection.sectionId, 100),
              sectionType: clampText(collection.sectionType, 80),
              surfaceId: clampText(collection.surfaceId, 100),
              totalCount: Math.max(0, Number(collection.totalCount || 0)),
              retainedCount: Math.max(0, Number(collection.retainedCount || 0)),
              omittedCount: Math.max(0, Number(collection.omittedCount || 0)),
              availableCount: Math.max(0, Number(collection.availableCount || 0)),
              disabledCount: Math.max(0, Number(collection.disabledCount || 0)),
              selectedCount: Math.max(0, Number(collection.selectedCount || 0)),
              paidCount: Math.max(0, Number(collection.paidCount || 0)),
              freeCount: Math.max(0, Number(collection.freeCount || 0)),
              priceRange: collection.priceRange && typeof collection.priceRange === "object" ? {
                minimum: Number.isFinite(Number(collection.priceRange.minimum)) ? Number(collection.priceRange.minimum) : null,
                maximum: Number.isFinite(Number(collection.priceRange.maximum)) ? Number(collection.priceRange.maximum) : null,
                currency: clampText(collection.priceRange.currency, 20)
              } : null,
              profileMode: clampText(collection.profileMode, 60),
              requiresExpansion: collection.requiresExpansion === true
            })).filter((collection) => collection.collectionId && collection.totalCount > 0).slice(0, 24)
          : [],
        transportCompleteness: clampText(page.transportCompleteness, 40),
        controlAliases: Array.isArray(page.controlAliases)
          ? page.controlAliases.map((entry) => ({
              aliasId: clampText(entry.aliasId, 140),
              controlId: clampText(entry.controlId, 140),
              kind: clampText(entry.kind, 40)
            })).filter((entry) => entry.aliasId && entry.controlId)
          : [],
        decisionGroups: Array.isArray(page.decisionGroups)
          ? page.decisionGroups.map((group) => compactDecisionGroup(
              group,
              canonicalControlsById,
              page.transactionFacts?.selectedExtras || []
            )).filter((group) => group.decisionGroupId)
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

  return { compactAgentPayload, hydrateIncrementalAgentBody };
}

module.exports = { createRequestPayloadAdapter };
