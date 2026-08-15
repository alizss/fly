export function createObservationTransport({
  maxObservationTransportBytes,
  compactObservationActionContext,
  compactText,
  emptyPageStateDiff,
  observationTransportBytes,
  stableHash,
  uniqueControlIds
}) {

  function normalizedTransportText(value = "") {
    return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
  }
  
  function transportProfileValues(payload = {}) {
    const values = [];
    const visit = (value) => {
      if (value == null) return;
      if (typeof value === "string" || typeof value === "number") {
        const clean = normalizedTransportText(value);
        if (clean.length >= 3) values.push(clean);
        return;
      }
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      if (typeof value === "object") Object.values(value).forEach(visit);
    };
    visit(payload.traveler || {});
    visit(payload.userPolicy || {});
    visit(payload.userIntent || "");
    const traveler = payload.traveler || {};
    const regionCodes = [
      traveler.nationality,
      traveler.country,
      traveler.country_of_residence,
      traveler.address_country,
      traveler.address?.country,
      traveler.document?.issuing_country
    ].map((value) => String(value || "").trim().toUpperCase())
      .filter((value) => /^[A-Z]{2}$/.test(value));
    for (const code of regionCodes) {
      values.push(code.toLowerCase());
      for (const locale of [globalThis.navigator?.language || "en", "en"]) {
        try {
          const label = new Intl.DisplayNames([locale], { type: "region" }).of(code);
          if (label) values.push(normalizedTransportText(label));
        } catch (_) {
          // The ISO code remains available when DisplayNames is unavailable.
        }
      }
    }
    return [...new Set(values)].slice(0, 80);
  }
  
  function seatTransportProfileMode(payload = {}) {
    const travelerProfile = payload.traveler || {};
    const explicit = normalizedTransportText([
      travelerProfile.seat_policy,
      travelerProfile.seat_preference,
      travelerProfile.preferred_seat,
      payload.userPolicy?.seatPolicy,
      payload.userPolicy?.preferredSeat,
      payload.userIntent
    ].filter(Boolean).join(" "));
    const rules = normalizedTransportText(`${travelerProfile.booking_rules || ""} ${payload.userPolicy?.bookingRules || ""}`);
    if (/random assignment|random seat|no preference|no specific seat|skip seat|no paid seat/.test(`${explicit} ${rules}`)) {
      return "random_assignment";
    }
    if (/\baisle\b|\bwindow\b|sit together|seats together|specific seat|\bseat [a-z]?\d+[a-z]?\b|\b\d{1,2}[a-k]\b/.test(explicit)) {
      return "explicit_selection";
    }
    return "unspecified";
  }
  
  function transportControlText(control = {}) {
    return normalizedTransportText([
      control.label,
      control.accessibleName,
      control.semantic,
      control.meaning,
      control.sectionType,
      control.sectionLabel
    ].filter(Boolean).join(" "));
  }
  
  function controlLooksLikeRepeatedChoice(control = {}) {
    const meaning = normalizedTransportText(`${control.kind || ""} ${control.role || ""} ${control.semantic || ""} ${control.physicalEffect || ""}`);
    const optionMember = /(?:^| )option(?: |$)|menuitemradio/.test(meaning);
    // Keep the semantic field owner losslessly, but its hundreds of child
    // option controls are a collection even when a site copies the owner's
    // field type onto each option.
    if (control.globalChrome === true || (control.fieldType && !optionMember)) return false;
    if (/continue|next|proceed|advance|navigation|back|submit|payment|dismiss|open surface/.test(meaning)) return false;
    return /choice|radio|checkbox|option|seat|select paid|select free/.test(meaning);
  }
  
  function repeatedChoiceGroupKey(control = {}) {
    if (!controlLooksLikeRepeatedChoice(control)) return "";
    const role = normalizedTransportText(`${control.role || ""} ${control.kind || ""}`);
    // Decision/section ownership is often unreliable for portalled custom
    // dropdown options. On an active non-page surface, role + surface is the
    // stable structural collection boundary and prevents one option per
    // accidental group from bypassing compaction.
    if ((control.surfaceId || "surface-page") !== "surface-page" && /option|menuitemradio/.test(role)) {
      return [control.surfaceId, "active_choice_options"].join("|");
    }
    return [
      control.surfaceId || "surface-page",
      control.decisionGroupId || "",
      control.sectionId || control.sectionType || "",
      normalizedTransportText(control.semantic || control.kind || control.role || "choice")
    ].join("|");
  }
  
  function controlStateForTransport(control = {}) {
    return control.state || control.controlState || {};
  }
  
  function transportControlDisabled(control = {}) {
    const state = controlStateForTransport(control);
    return state.disabled === true || control.disabled === true || control.logicalDisabled === true;
  }
  
  function transportControlSelected(control = {}) {
    const state = controlStateForTransport(control);
    return control.selected === true || state.selected === true || state.checked === true;
  }
  
  function transportControlPrice(control = {}) {
    const amount = Number(control.structuredPrice?.amount ?? control.priceAmount);
    return Number.isFinite(amount) ? amount : null;
  }
  
  function controlMatchesTransportProfile(control = {}, profileValues = []) {
    const text = transportControlText(control);
    if (!text) return false;
    return profileValues.some((value) => (
      value.length >= 3
      && (text.includes(value) || value.includes(text))
    ));
  }
  
  function collectionTypeForControls(page = {}, controls = []) {
    const context = normalizedTransportText([
      page.step,
      page.currentSurface?.label,
      controls[0]?.sectionType,
      controls[0]?.sectionLabel,
      controls[0]?.semantic,
      ...controls.slice(0, 8).map((control) => control.label || control.accessibleName || "")
    ].filter(Boolean).join(" "));
    return /seat|seating/.test(context) ? "seat_inventory" : "repeated_choices";
  }
  
  function collectionSummary(collectionId, type, controls = [], retained = [], profileMode = "unspecified") {
    const prices = controls.map(transportControlPrice).filter((value) => value != null);
    const currencies = [...new Set(controls.map((control) => control.structuredPrice?.currency).filter(Boolean))];
    return {
      collectionId,
      type,
      decisionGroupId: controls[0]?.decisionGroupId || "",
      sectionId: controls[0]?.sectionId || "",
      sectionType: controls[0]?.sectionType || "",
      surfaceId: controls[0]?.surfaceId || "surface-page",
      totalCount: controls.length,
      retainedCount: retained.length,
      omittedCount: Math.max(0, controls.length - retained.length),
      availableCount: controls.filter((control) => !transportControlDisabled(control)).length,
      disabledCount: controls.filter(transportControlDisabled).length,
      selectedCount: controls.filter(transportControlSelected).length,
      paidCount: controls.filter((control) => Number(transportControlPrice(control)) > 0 || /money|paid/.test(normalizedTransportText(control.risk))).length,
      freeCount: controls.filter((control) => transportControlPrice(control) === 0 || /free|safe decline|included/.test(normalizedTransportText(`${control.risk || ""} ${control.label || ""}`))).length,
      priceRange: prices.length ? {
        minimum: Math.min(...prices),
        maximum: Math.max(...prices),
        currency: currencies.length === 1 ? currencies[0] : ""
      } : null,
      profileMode,
      requiresExpansion: type === "seat_inventory" && profileMode === "explicit_selection" && retained.length < controls.length
    };
  }
  
  function filterTransportReferences(page = {}, retainedIds = new Set(), collections = []) {
    const collectionByDecisionGroup = new Map(collections
      .filter((collection) => collection.decisionGroupId)
      .map((collection) => [collection.decisionGroupId, collection]));
    const filterIds = (items = []) => uniqueControlIds(items).filter((controlId) => retainedIds.has(controlId));
    const decisionGroups = (page.decisionGroups || []).map((group) => {
      const collection = collectionByDecisionGroup.get(group.decisionGroupId);
      const alternativeControlIds = filterIds(group.alternativeControlIds || group.alternatives || []);
      const alternatives = (group.alternatives || []).filter((alternative) => retainedIds.has(alternative.controlId));
      return {
        ...group,
        alternativeControlIds,
        alternatives,
        semanticCorrectionControlIds: filterIds(group.semanticCorrectionControlIds || []),
        ...(collection ? {
          transportCollectionId: collection.collectionId,
          transportOriginalAlternativeCount: collection.totalCount,
          transportOmittedAlternativeCount: collection.omittedCount
        } : {})
      };
    }).filter((group) => {
      const collection = collectionByDecisionGroup.get(group.decisionGroupId);
      if (!collection) return true;
      if (group.required === true) return true;
      return group.alternativeControlIds.length > 0;
    });
    const compactSurface = (surface = null) => surface ? {
      ...surface,
      memberControlIds: filterIds(surface.memberControlIds || surface.controlIds || [])
    } : surface;
    return {
      ...page,
      controlAliases: (page.controlAliases || []).filter((alias) => retainedIds.has(alias.controlId)),
      decisionGroups,
      sections: (page.sections || []).map((section) => ({
        ...section,
        controlIds: filterIds(section.controlIds || [])
      })),
      accessibility: page.accessibility ? {
        ...page.accessibility,
        controlIds: filterIds(page.accessibility.controlIds || [])
      } : page.accessibility,
      currentSurface: compactSurface(page.currentSurface),
      surfaceStack: (page.surfaceStack || []).map(compactSurface),
      screenshotAnnotations: (page.screenshotAnnotations || []).filter((annotation) => retainedIds.has(annotation.controlId)),
      controlCollections: collections,
      transportCompleteness: "task_complete",
      summary: {
        ...(page.summary || {}),
        sourceControls: (page.controls || []).length,
        transportedControls: retainedIds.size,
        controlCollections: collections.length
      },
      coverage: page.coverage ? {
        ...page.coverage,
        sourceControlCount: (page.controls || []).length,
        transportedControlCount: retainedIds.size,
        collectionCount: collections.length
      } : page.coverage
    };
  }
  
  function boundedObservationTransport(payload = {}) {
    const page = payload.page || {};
    const controls = Array.isArray(page.controls) ? page.controls : [];
    if (controls.length < 64) return payload;
    const grouped = new Map();
    controls.forEach((control) => {
      const key = repeatedChoiceGroupKey(control);
      if (!key) return;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(control);
    });
    const repeatedGroups = [...grouped.values()].filter((group) => group.length >= 64);
    if (!repeatedGroups.length) return payload;
  
    const profileValues = transportProfileValues(payload);
    // The semantic owner may already have resolved the exact site option
    // (often from an ISO-valued native select) while the visible portalled
    // option exposes only a localized label. Carry that owned goal evidence
    // into collection retention rather than trying to infer aliases again.
    const goalOptionValues = controls.flatMap((control) => (control.options || [])
      .filter((option) => option.goalMatch === true)
      .flatMap((option) => [option.value, option.label])
      .map(normalizedTransportText)
      .filter(Boolean));
    const taskValues = [...new Set([...profileValues, ...goalOptionValues])];
    const seatProfileMode = seatTransportProfileMode(payload);
    const omittedIds = new Set();
    const collections = [];
    repeatedGroups.forEach((group, index) => {
      const type = collectionTypeForControls(page, group);
      const profileMode = type === "seat_inventory" ? seatProfileMode : "unspecified";
      const alwaysKeep = group.filter((control) => (
        transportControlSelected(control)
        || control.required === true
        || controlStateForTransport(control).invalid === true
        || controlMatchesTransportProfile(control, taskValues)
        || /no thanks|without|skip|random|automatic|free assignment/.test(transportControlText(control))
      ));
      const keepLimit = type === "seat_inventory" && profileMode === "random_assignment"
        ? 0
        : type === "seat_inventory" && profileMode === "explicit_selection"
          ? 96
          : 24;
      const ranked = group.filter((control) => !alwaysKeep.includes(control)).sort((left, right) => {
        const score = (control) => {
          const region = control.visualRegion || control.visualRegions?.[0] || {};
          const price = transportControlPrice(control);
          return (controlMatchesTransportProfile(control, taskValues) ? 1000000 : 0)
            + (!transportControlDisabled(control) ? 100000 : 0)
            + (region.inViewport === true ? 10000 : 0)
            + (price === 0 ? 1000 : 0)
            - (Number.isFinite(price) ? Math.min(price, 999) : 0);
        };
        return score(right) - score(left);
      });
      const retained = [...new Map([...alwaysKeep, ...ranked.slice(0, Math.max(0, keepLimit - alwaysKeep.length))]
        .map((control) => [control.controlId, control])).values()];
      const retainedIds = new Set(retained.map((control) => control.controlId));
      group.forEach((control) => {
        if (!retainedIds.has(control.controlId)) omittedIds.add(control.controlId);
      });
      collections.push(collectionSummary(
        `collection_${stableHash(`${type}:${group[0]?.decisionGroupId || index}:${group.length}`)}`,
        type,
        group,
        retained,
        profileMode
      ));
    });
  
    const retainedControls = controls.filter((control) => !omittedIds.has(control.controlId));
    const retainedIds = new Set(retainedControls.map((control) => control.controlId));
    const boundedPage = filterTransportReferences({ ...page, controls: retainedControls }, retainedIds, collections);
    return {
      ...payload,
      transportMode: payload.transportMode || "bounded_semantic",
      page: boundedPage
    };
  }
  
  function smallerObservationTransport(payload = {}) {
    const safePayload = boundedObservationTransport(compactObservationActionContext(payload));
    const page = safePayload.page || {};
    return {
      ...safePayload,
      transportMode: "compact_retry",
      observationUpdate: safePayload.observationUpdate ? {
        ...safePayload.observationUpdate,
        // A compact retry is a self-contained authoritative snapshot. It must
        // not carry an incremental base/diff for controls intentionally
        // omitted by collection compaction.
        mode: "full_snapshot",
        baseSnapshotHash: "",
        diff: emptyPageStateDiff()
      } : safePayload.observationUpdate,
      page: {
        ...page,
        text: compactText(page.text || "", 2_000),
        foreground: page.foreground ? {
          kind: page.foreground.kind || "",
          label: page.foreground.label || "",
          surfaceId: page.foreground.surfaceId || "",
          progressMarkers: page.foreground.progressMarkers || null
        } : null,
        coverage: page.coverage ? {
          controlCount: page.controls?.length || 0,
          sectionCount: page.sections?.length || 0
        } : null,
        summary: page.summary ? {
          title: compactText(page.summary.title || "", 200),
          priceText: compactText(page.summary.priceText || "", 80)
        } : null
      }
    };
  }
  
  function incrementalObservationTransport(payload = {}) {
    const update = payload.observationUpdate || {};
    const page = payload.page || {};
    if (update.mode !== "incremental" || !update.baseSnapshotHash) return payload;
    const diff = update.diff || emptyPageStateDiff();
    const changedControlIds = new Set([
      ...(diff.addedControls || []).map((entry) => entry.controlId),
      ...(diff.stateChanges || []).map((entry) => entry.controlId),
      ...(diff.textChanges || []).map((entry) => entry.controlId)
    ].filter(Boolean));
    const currentSurfaceId = page.currentSurface?.id || "surface-page";
    for (const control of page.controls || []) {
      if ((control.surfaceId || "surface-page") === currentSurfaceId) changedControlIds.add(control.controlId);
    }
    const controls = (page.controls || []).filter((control) => changedControlIds.has(control.controlId));
    const controlIds = new Set(controls.map((control) => control.controlId));
    const decisionGroups = (page.decisionGroups || []).filter((group) => (
      group.surfaceId === currentSurfaceId
      || controlIds.has(group.selectedControlId)
      || controlIds.has(group.removalControlId)
      || (group.alternativeControlIds || []).some((controlId) => controlIds.has(controlId))
    ));
    const decisionGroupIds = new Set(decisionGroups.map((group) => group.decisionGroupId));
    const sections = (page.sections || []).filter((section) => (
      (section.controlIds || []).some((controlId) => controlIds.has(controlId))
    ));
    return {
      ...payload,
      transportMode: "incremental_diff",
      page: {
        ...page,
        incremental: true,
        controls,
        controlAliases: (page.controlAliases || []).filter((entry) => controlIds.has(entry.controlId)),
        decisionGroups,
        sections,
        surfaceStack: page.surfaceStack || [],
        currentSurface: page.currentSurface || null,
        screenshotAnnotations: (page.screenshotAnnotations || []).filter((entry) => (
          controlIds.has(entry.controlId) || decisionGroupIds.has(entry.decisionGroupId)
        ))
      }
    };
  }
  
  function referenceObservationTransport(payload = {}) {
    const update = payload.observationUpdate || {};
    if (update.mode !== "reference" || !update.baseSnapshotHash) return payload;
    return {
      ...compactObservationActionContext(payload),
      transportMode: "observation_reference",
      page: {
        referenceOnly: true,
        snapshotHash: update.snapshotHash || update.baseSnapshotHash
      }
    };
  }
  
  async function uploadObservationScreenshot(apiBase, { sessionId, observationId, screenshotDataUrl, signal }) {
    if (!screenshotDataUrl) return "";
    const response = await fetch(`${apiBase}/agent/screenshot`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal,
      body: JSON.stringify({ sessionId, observationId, screenshotDataUrl })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.screenshotId) {
      const error = new Error(body.error || `screenshot upload returned ${response.status}`);
      error.code = body.code || "SCREENSHOT_UPLOAD_FAILED";
      error.retryable = body.retryable === true;
      throw error;
    }
    return body.screenshotId;
  }
  
  async function postObservationWithSizeRecovery(apiBase, payload, signal) {
    const canonicalPayload = boundedObservationTransport(compactObservationActionContext(payload));
    const referenceOnly = payload.observationUpdate?.mode === "reference";
    const fullPayload = referenceOnly
      ? {
          ...canonicalPayload,
          transportMode: "full_resynchronization",
          observationUpdate: {
            ...(canonicalPayload.observationUpdate || {}),
            mode: "full_snapshot",
            baseSnapshotHash: "",
            diff: emptyPageStateDiff()
          }
        }
      : canonicalPayload;
    let outgoing = referenceOnly
      ? referenceObservationTransport(canonicalPayload)
      : incrementalObservationTransport(fullPayload);
    let bytes = observationTransportBytes(outgoing);
    if (bytes > maxObservationTransportBytes) {
      outgoing = smallerObservationTransport(outgoing);
      bytes = observationTransportBytes(outgoing);
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await fetch(`${apiBase}/agent/next-action`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal,
        body: JSON.stringify(outgoing)
      });
      if (response.ok) return { response, bytes, transportMode: outgoing.transportMode || "canonical" };
      const body = await response.json().catch(() => ({}));
      if (body.code === "OBSERVATION_RESYNC_REQUIRED" && body.retryable === true && outgoing !== fullPayload) {
        outgoing = {
          ...fullPayload,
          transportMode: "full_resynchronization",
          observationUpdate: {
            ...(fullPayload.observationUpdate || {}),
            mode: "full_snapshot",
            baseSnapshotHash: "",
            diff: emptyPageStateDiff()
          }
        };
        bytes = observationTransportBytes(outgoing);
        continue;
      }
      if (body.code === "OBSERVATION_TOO_LARGE" && body.retryable === true && attempt === 0) {
        outgoing = smallerObservationTransport(outgoing);
        bytes = observationTransportBytes(outgoing);
        continue;
      }
      const error = new Error(body.error || `agent returned ${response.status}`);
      error.code = body.code || `HTTP_${response.status}`;
      error.failureCode = body.failureCode || "";
      error.sessionId = body.sessionId || "";
      error.retryable = body.retryable === true;
      throw error;
    }
    throw Object.assign(new Error("Observation transport retry exhausted."), {
      code: "OBSERVATION_TOO_LARGE",
      retryable: true
    });
  }
  
  return Object.freeze({
    boundedObservationTransport,
    incrementalObservationTransport,
    normalizedTransportText,
    postObservationWithSizeRecovery,
    referenceObservationTransport,
    seatTransportProfileMode,
    smallerObservationTransport,
    uploadObservationScreenshot
  });
}
