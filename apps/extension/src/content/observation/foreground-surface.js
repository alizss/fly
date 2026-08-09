export function createForegroundSurfaceCompiler(dependencies) {
  const {
    accessibilityNode,
    actionElementLabel,
    agent,
    boundHighCardinalityActionElements,
    boundedSurfaceEvidenceOptions,
    buttonText,
    choiceLabel,
    classifyStep,
    clickableAncestor,
    compactText,
    controlOwnedEvidence,
    controlText,
    decisionGroupIdForContext,
    elementBelongsToSectionBand,
    elementBox,
    elementById,
    elementId,
    foregroundSurfaceState,
    implicitRole,
    isChoiceSelected,
    isDisabledLike,
    isInViewport,
    isVisible,
    labelText,
    liveSectionModels,
    meaningfulActionBox,
    normalizeMatchText,
    overlayTopHitCount,
    overlayVisualScore,
    pointBelongsToElement,
    primaryPageText,
    queryAllDeep,
    resolveOwnedControlMeaning,
    stableHash,
    waitForPaint
  } = dependencies;

  function activeOverlayElements() {
    // Headless UI places data-headlessui-state on every option as well as the
    // open owner. Only an open state can be a foreground surface; treating each
    // seat option as an overlay multiplies observation work before compilation.
    const selectors = "[role='dialog'], [aria-modal='true'], [role='listbox'], [role='menu'], [data-headlessui-state~='open'], .modal, .popover";
    const explicit = queryAllDeep(selectors);
    const floating = queryAllDeep("body *")
      .filter((element) => {
        if (!isVisible(element) || element.closest("#atw-sidebar, #atw-agent-cursor, .atw-section-outline")) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const text = overlayText(element);
        if (!/fixed|absolute/.test(style.position)) return false;
        if (!isInViewport(element) || rect.width < 260 || rect.height < 120) return false;
        if (!text || text.length > 5000) return false;
        if (!overlayButtons(element).length) return false;
        const z = Number.parseInt(style.zIndex || "0", 10);
        return Number.isNaN(z) || z >= 1;
      });
    const candidates = [...new Set([...explicit, ...floating])]
      .filter((element) => isVisible(element) && !element.closest("#atw-sidebar, #atw-agent-cursor, .atw-section-outline"))
      .filter((element) => !isPersistentEdgeCheckoutChrome(element))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        if (rect.width < 12 || rect.height < 12) return false;
        const text = overlayText(element);
        const role = element.getAttribute("role") || "";
        const style = getComputedStyle(element);
        const modal = element.getAttribute("aria-modal") === "true" || role === "dialog";
        const menu = role === "listbox" || role === "menu";
        const expanded = element.getAttribute("aria-expanded") === "true";
        const hasVisibleOption = queryAllDeep("[role='option']", element).some(isVisible);
        const floating = /fixed|absolute|sticky/.test(style.position);
        if (role === "option" || role === "combobox") return false;
        if (modal) return Boolean(text);
        if (!isInViewport(element)) return false;
        if (/fixed|absolute/.test(style.position) && overlayButtons(element).length && text.length < 5000) return true;
        if (menu || expanded || hasVisibleOption) return Boolean(text || role);
        if (element.matches(".modal,.popover") || floating) return Boolean(text);
        return false;
      });
    return candidates
      .filter((element) => !candidates.some((other) => other !== element && element.contains(other) && overlayTopHitCount(other) > 0))
      .map((element) => ({ element, hitCount: overlayTopHitCount(element), score: overlayVisualScore(element) }))
      .filter((item) => item.hitCount > 0)
      .sort((a, b) => b.score - a.score)
      .map((item) => item.element);
  }

  // Fixed/sticky itinerary and price summaries are checkout page chrome, not
  // foreground decisions. Treating every positioned panel as a modal hides the
  // actual traveler fields and page Continue action from the planner. A real
  // dialog, menu, listbox, expanded choice owner, or choice form keeps owning
  // the foreground even when it happens to touch a viewport edge.
  function isPersistentEdgeCheckoutChrome(element) {
    if (!element || !isVisible(element)) return false;
    const role = String(element.getAttribute?.("role") || "").toLowerCase();
    if (element.getAttribute?.("aria-modal") === "true" || ["dialog", "alertdialog", "listbox", "menu"].includes(role)) return false;
    if (element.getAttribute?.("aria-expanded") === "true" || queryAllDeep("[aria-expanded='true'], [role='option']", element).some(isVisible)) return false;
    if (queryAllDeep("input:not([type='hidden']), select, textarea, [role='radio'], [role='checkbox']", element).some(isVisible)) return false;

    const style = getComputedStyle(element);
    if (!/fixed|sticky|absolute/.test(style.position)) return false;
    const rect = element.getBoundingClientRect();
    const viewportWidth = Math.max(1, window.innerWidth || document.documentElement.clientWidth || 1);
    const viewportHeight = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1);
    const edgeTolerance = 8;
    const bottomStrip = rect.bottom >= viewportHeight - edgeTolerance
      && rect.width >= viewportWidth * 0.55
      && rect.height <= Math.max(190, viewportHeight * 0.24);
    const sidePanel = rect.right >= viewportWidth - edgeTolerance
      && rect.height >= viewportHeight * 0.5
      && rect.width <= Math.max(520, viewportWidth * 0.34);
    if (!bottomStrip && !sidePanel) return false;

    const text = overlayText(element).toLowerCase();
    const pageChromeEvidence = /(?:departure|return|flight|route|itinerary|price|total|amount|booking summary|your order|details)/.test(text);
    // Text such as "Choose seats for me" can legitimately appear inside a
    // persistent price/itinerary summary. Lexical action words do not make the
    // entire positioned panel modal. Structural modal/choice evidence above is
    // the authority for exclusivity.
    return pageChromeEvidence;
  }

  function surfaceStructurallyBlocksBackground(overlay, type = "popover") {
    if (!overlay) return false;
    const role = String(overlay.getAttribute?.("role") || implicitRole(overlay) || "").toLowerCase();
    if (overlay.getAttribute?.("aria-modal") === "true" || ["dialog", "alertdialog"].includes(role)) return true;
    if (type === "dropdown" || ["listbox", "menu"].includes(role)) return true;
    if (overlay.getAttribute?.("aria-expanded") === "true") return true;
    if (queryAllDeep("[role='option']", overlay).some(isVisible)) return true;
    if (overlay.matches?.(".modal, [data-modal='true'], [data-state='open'][role='dialog']")) return true;

    const viewportWidth = Math.max(1, window.innerWidth || document.documentElement.clientWidth || 1);
    const viewportHeight = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1);
    const backdrop = queryAllDeep("[inert], .modal-backdrop, .backdrop, [data-backdrop]")
      .some((element) => {
        if (element === overlay || !isVisible(element)) return false;
        const backdropRect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return /fixed|absolute/.test(style.position)
          && backdropRect.width >= viewportWidth * 0.6
          && backdropRect.height >= viewportHeight * 0.6;
      });
    const bodyLocked = /hidden/.test(getComputedStyle(document.body).overflow || "");
    const focusOwned = Boolean(document.activeElement && overlay.contains(document.activeElement));
    if (backdrop || (bodyLocked && focusOwned)) return true;

    // Some checkout panels are interaction-exclusive without exposing dialog
    // or aria-modal markup. Admit them from combined mechanical evidence: the
    // panel owns several top-hit points, contains a local resolution boundary,
    // and occupies a material interaction region. Persistent edge chrome is
    // filtered before this function, so geometry alone never grants ownership.
    const rect = overlay.getBoundingClientRect();
    const localActions = surfaceActionElements(overlay).filter(isVisible);
    const ownsResolutionAction = localActions.some((element) => (
      /^(?:next|continue|proceed|done|close(?: window)?|skip|back)\b/i.test(actionElementLabel(element))
    ));
    const materialRegion = rect.width >= viewportWidth * 0.32
      && rect.height >= viewportHeight * 0.32
      && rect.width * rect.height >= viewportWidth * viewportHeight * 0.16;
    const backgroundActions = queryAllDeep(
      "button, input:not([type='hidden']), select, textarea, [role='button'], [role='radio'], [role='checkbox'], [role='option']"
    ).filter((element) => (
      isVisible(element)
      && !overlay.contains(element)
      && !element.closest("#atw-sidebar, #atw-agent-cursor, .atw-section-outline")
    ));
    const suppressedBackgroundActions = backgroundActions.filter((element) => {
      if (isDisabledLike(element)) return true;
      const box = elementBox(element);
      return Boolean(box && !pointBelongsToElement({ x: box.centerX, y: box.centerY }, element));
    });
    const backgroundInteractionSuppressed = backgroundActions.length > 0
      && suppressedBackgroundActions.length / backgroundActions.length >= 0.75;
    const interactionExclusive = overlayTopHitCount(overlay) >= 3
      && localActions.length >= 2
      && ownsResolutionAction
      && materialRegion
      && backgroundInteractionSuppressed;
    if (interactionExclusive) return true;

    return false;
  }

  function overlayText(element) {
    if (!element) return "";
    return (element.innerText || element.textContent || element.getAttribute("aria-label") || "")
      .replace(/\s+/g, " ")
      .trim();
  }


  function overlayChoiceText(element) {
    if (!element) return "";
    const direct = buttonText(element) || choiceLabel(element) || labelText(element) || controlText(element);
    if (direct && direct.trim() && !/^(on|true|false)$/i.test(direct.trim())) {
      return direct.replace(/\s+/g, " ").trim();
    }
    const row = element.closest?.("label, li, tr, [role='option'], [role='checkbox'], [role='radio'], [data-headlessui-state], div");
    return (row?.innerText || row?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function overlayChoiceTarget(element) {
    if (!element) return null;
    if (element.matches?.("input[type='checkbox'], input[type='radio']")) {
      return element.closest("label, [role='option'], li, [role='checkbox'], [role='radio']") || element;
    }
    return clickableAncestor(element) || element.closest?.("label, [role='option'], li, [role='checkbox'], [role='radio']") || element;
  }

  function overlayButtons(overlay) {
    return queryAllDeep("button, [role='button'], [role='option'], [role='checkbox'], [role='radio'], li, label, input[type='checkbox'], input[type='radio'], input[type='button'], input[type='submit']", overlay.shadowRoot || overlay)
      .map((button) => overlayChoiceTarget(button))
      .filter((button, index, list) => button && list.indexOf(button) === index)
      .filter((button) => isVisible(button) && !button.closest("#atw-sidebar"));
  }

  function surfaceActionElements(overlay) {
    if (!overlay) return [];
    const roots = [overlay];
    `${overlay.getAttribute?.("aria-owns") || ""} ${overlay.getAttribute?.("aria-controls") || ""}`
      .split(/\s+/)
      .filter(Boolean)
      .forEach((id) => {
        const root = document.getElementById(id);
        if (root && isVisible(root)) roots.push(root);
      });
    return roots
      .flatMap((root) => overlayButtons(root))
      .filter((element, index, list) => element && list.indexOf(element) === index);
  }

  function surfaceMembershipForElement(element, surface = {}) {
    if (!element) return { surfaceId: "", evidence: "missing_element" };
    if (!surface?.type || surface.type === "page" || surface.blocksBackground !== true) {
      return {
        surfaceId: "surface-page",
        evidence: surface.blocksBackground === false ? "nonblocking_context_surface" : "page_surface"
      };
    }
    const elementNodeId = elementId(element);
    const registeredIds = new Set([
      ...(surface.memberActuatorIds || []),
      ...(surface.options || []).flatMap((item) => [item.id, item.stateElementId, item.preferredActivationElementId]),
      ...(surface.buttons || []).flatMap((item) => [item.id, item.stateElementId, item.preferredActivationElementId])
    ].filter(Boolean));
    if (registeredIds.has(elementNodeId)) return { surfaceId: surface.id || "", evidence: "registered_surface_member" };
    const surfaceElement = surface.id ? elementById(surface.id) : null;
    if (surfaceElement && (surfaceElement === element || surfaceElement.contains(element))) {
      return { surfaceId: surface.id || "", evidence: "dom_descendant" };
    }
    const ownedIds = `${surfaceElement?.getAttribute?.("aria-owns") || ""} ${surfaceElement?.getAttribute?.("aria-controls") || ""}`
      .split(/\s+/)
      .filter(Boolean);
    if (ownedIds.some((id) => {
      const root = document.getElementById(id);
      return root && (root === element || root.contains(element));
    })) return { surfaceId: surface.id || "", evidence: "aria_owned_root" };
    // Combobox search/filter inputs commonly live beside a portalled listbox
    // and point to it with aria-controls/aria-owns. That reverse relation is
    // as strong as DOM containment and must keep the deterministic filter in
    // the foreground surface. Geometry alone still grants no ownership.
    const controlledIds = `${element.getAttribute?.("aria-controls") || ""} ${element.getAttribute?.("aria-owns") || ""}`
      .split(/\s+/)
      .filter(Boolean);
    const reverseOwnedFilter = element.matches?.("input:not([readonly]):not([disabled]), textarea:not([readonly]):not([disabled])")
      && (
        String(element.getAttribute?.("type") || "").toLowerCase() === "search"
        || /\b(?:search|filter|find|query)\b/i.test(`${labelText(element)} ${element.getAttribute?.("placeholder") || ""} ${element.getAttribute?.("name") || ""}`)
      );
    if (reverseOwnedFilter && surfaceElement && controlledIds.some((id) => {
      const controlled = document.getElementById(id);
      return controlled && (controlled === surfaceElement || surfaceElement.contains(controlled) || controlled.contains(surfaceElement));
    })) return { surfaceId: surface.id || "", evidence: "reverse_aria_owned_surface" };
    const surfaceBox = surface.box;
    const targetBox = elementBox(element);
    if (surfaceBox && targetBox) {
      const centerX = Number(targetBox.centerX ?? (targetBox.x + targetBox.width / 2));
      const centerY = Number(targetBox.centerY ?? (targetBox.y + targetBox.height / 2));
      const visuallyContained = centerX >= Number(surfaceBox.x)
        && centerX <= Number(surfaceBox.x) + Number(surfaceBox.width)
        && centerY >= Number(surfaceBox.y)
        && centerY <= Number(surfaceBox.y) + Number(surfaceBox.height);
      // Geometry is supporting evidence only: background controls can sit
      // directly underneath an overlay and share its rectangle. Without DOM,
      // ARIA, or registered-member proof, visual overlap must not grant
      // foreground ownership.
      if (visuallyContained) return { surfaceId: "surface-page", evidence: "visual_overlap_unconfirmed" };
    }
    return { surfaceId: "surface-page", evidence: "background_page" };
  }

  function isTransientChoiceOverlay(overlay) {
    const role = overlay.getAttribute("role") || "";
    const text = overlayText(overlay).toLowerCase();
    if (role === "listbox" || role === "menu") return true;
    // HeadlessUI-style comboboxes often mark the outer wrapper with
    // data-headlessui-state="open" while role="listbox"/"option" lives on a nested
    // child — checking only the overlay's own role misses these, so the popover
    // never gets the auto-close (Escape/outside-click) treatment after a choice is
    // made and just lingers open, which is exactly what got mistaken for a stall.
    if (queryAllDeep("[role='listbox'], [role='option']", overlay).length) return true;
    return /slovenia\s*\(\+386\)|sierra leone\s*\(\+232\)|singapore\s*\(\+65\)|sint maarten|country code|calling code/.test(text);
  }

  function overlaySignature(overlay) {
    if (!overlay || !document.contains(overlay) || !isVisible(overlay)) return "";
    const role = overlay.getAttribute("role") || "";
    const rect = overlay.getBoundingClientRect();
    const selectedState = overlayButtons(overlay)
      .map((button) => `${normalizeMatchText(overlayChoiceText(button)).slice(0, 80)}:${isChoiceSelected(button) || button.getAttribute?.("aria-selected") === "true" || button.getAttribute?.("aria-checked") === "true" ? "1" : "0"}`)
      .join(";");
    return [
      role,
      Math.round(rect.left),
      Math.round(rect.top),
      Math.round(rect.width),
      Math.round(rect.height),
      selectedState,
      overlayText(overlay).slice(0, 1200)
    ].join("|");
  }

  async function waitForOverlayProgress(overlay, beforeSignature, timeout = 2200) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      await waitForPaint(240);
      const overlays = activeOverlayElements();
      if (!overlays.length) return { ok: true, reason: "overlay closed" };
      if (!overlay || !document.contains(overlay) || !isVisible(overlay)) {
        return { ok: true, reason: "overlay removed" };
      }
      if (!overlays.includes(overlay)) return { ok: true, reason: "active overlay changed" };
      const afterSignature = overlaySignature(overlay);
      if (beforeSignature && afterSignature && afterSignature !== beforeSignature) {
        return { ok: true, reason: "overlay content changed" };
      }
    }
    return { ok: false, reason: "overlay did not change" };
  }

  // Normalize conclusive live mechanical feedback into the same verification
  // contract consumed by the durable action ledger. This stays deliberately
  // narrow: field values, stage navigation, validation, and price-sensitive
  // outcomes still require a fresh canonical observation.

  function isDangerousActionLabel(label) {
    return /\b(pay|purchase|book)\b|book now|complete booking|confirm booking|submit payment|confirm payment|confirm and pay/i.test(label);
  }

  function isSafeContinueLabel(label) {
    return /\b(continue|next|proceed)\b|skip to next step/i.test(label) && !isDangerousActionLabel(label);
  }

  function isSkipChoiceLabel(label) {
    return /no,?\s+thanks|no checked baggage|no baggage|none of the passengers|\bnone\b/i.test(label);
  }

  function actionRisk(label) {
    if (isDangerousActionLabel(label)) return "payment";
    if (isSafeContinueLabel(label)) return "safe_continue";
    if (isSkipChoiceLabel(label)) return "skip_extra";
    return "choice";
  }

  function overlayOptionSemantic(label = "") {
    const text = String(label || "").toLowerCase();
    if (/none of the passengers|none of the travellers|none of the travelers|no,?\s*thanks|not now|skip|decline|go without|without/.test(text)) {
      return "decline_paid_extra";
    }
    if (/0\s*(eur|€|usd|\$)|free/.test(text) && !/all passengers|adult/.test(text)) return "decline_paid_extra";
    if (/all passengers|all travellers|all travelers|\badult\b|add|cart|upgrade|premium|\b[1-9]\d*([.,]\d+)?\s*(eur|€|usd|\$)/.test(text)) {
      return "add_paid_extra";
    }
    return "choice";
  }

  function overlayOptionRisk(label = "") {
    const semantic = overlayOptionSemantic(label);
    if (semantic === "decline_paid_extra") return "safe_decline";
    if (semantic === "add_paid_extra") return "paid";
    return "unknown";
  }

  function declineChoiceIntent(decision = {}) {
    const snapshot = decision.targetSnapshot || {};
    return decision.intent === "decline_optional_extra"
      || snapshot.semantic === "decline_paid_extra"
      || snapshot.semantic === "decline_baggage"
      || snapshot.semantic === "safe_decline"
      || snapshot.risk === "safe_decline";
  }

  function isStageExitDecision(decision = {}) {
    if (!["click", "click_xy", "keypress"].includes(decision.action)) return false;
    const snapshot = decision.targetSnapshot || {};
    return decision.intent === "navigate_stage"
      || snapshot.semantic === "continue"
      || snapshot.risk === "safe_continue";
  }

  function currentSurfaceEntries(surfaceOrMap) {
    const surface = surfaceOrMap?.currentSurface || surfaceOrMap || {};
    return [...(surface.options || []), ...(surface.buttons || [])]
      .filter((entry, index, list) => entry?.id && list.findIndex((item) => item?.id === entry.id) === index);
  }

  function inferSurfaceParentDecisionContext(overlay, sections = []) {
    const expandedControls = queryAllDeep("select, [role='combobox'], button, [role='button'], [aria-haspopup], [aria-controls], [aria-owns]")
      .filter((element) => isVisible(element) && !element.closest("#atw-sidebar, #atw-agent-cursor, .atw-section-outline"))
      .map((element) => {
        const owns = [element.getAttribute("aria-controls"), element.getAttribute("aria-owns")]
          .filter(Boolean)
          .flatMap((value) => String(value).split(/\s+/).filter(Boolean));
        const active = document.activeElement === element || element.contains(document.activeElement);
        const expanded = element.getAttribute("aria-expanded") === "true";
        const linkedToOverlay = owns.some((id) => {
          const owned = document.getElementById(id);
          return owned && (owned === overlay || overlay.contains(owned) || owned.contains(overlay));
        });
        const box = elementBox(element);
        const overlayBox = elementBox(overlay);
        const nearOverlay = Math.abs((box.centerX || 0) - (overlayBox.centerX || 0)) < Math.max(260, overlayBox.width || 0)
          && Math.abs((box.centerY || 0) - (overlayBox.centerY || 0)) < 420;
        let score = 0;
        if (linkedToOverlay) score += 100;
        if (active) score += 50;
        if (expanded) score += 35;
        if (nearOverlay) score += 15;
        return { element, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score);
    const parent = expandedControls[0]?.element || null;
    const section = parent
      ? (sections || []).find((item) => {
          const sectionElement = elementById(item.id) || item.element;
          return sectionElement && (sectionElement.contains(parent) || elementBelongsToSectionBand(parent, item, liveSectionModels(sections || [])));
        })
      : null;
    const sectionType = section?.type || "";
    const sectionLabel = section?.label || "";
    const overlayIsRepresentation = isTransientChoiceOverlay(overlay);
    const overlayId = elementId(overlay);
    const decisionGroupId = overlayIsRepresentation
      ? decisionGroupIdForContext({ sectionType, sectionLabel })
      : decisionGroupIdForContext({
          sectionType,
          sectionLabel,
          surfaceId: overlayId,
          surfaceType: "modal",
          stage: classifyStep({ visibleText: primaryPageText(), url: location.href }),
          instance: overlayText(overlay).slice(0, 120)
        });
    return {
      parentControlId: parent?.dataset?.atwControlId || "",
      parentElementId: parent ? elementId(parent) : "",
      parentSectionId: section?.id || "",
      parentSectionType: sectionType,
      parentSectionLabel: sectionLabel,
      decisionGroupId
    };
  }

  function classifySurfaceSemantics(overlay, options = [], type = "popover") {
    const localText = compactText(overlayText(overlay), 1200).toLowerCase();
    const structuralChoices = options.filter((option) => (
      option.choiceStructure === true
      || /radio|checkbox|option/.test(String(option.accessibility?.role || "").toLowerCase())
    ));
    const choiceOptions = structuralChoices.length
      ? options.filter((option) => (
          option.choiceStructure === true
          || /radio|checkbox|option/.test(String(option.accessibility?.role || "").toLowerCase())
          || ["select_free_option", "select_paid_option"].includes(option.physicalEffect)
        ))
      : [];
    const fieldCount = overlay?.querySelectorAll?.("input:not([type='hidden']), select, textarea")?.length || 0;
    const effects = new Set(options.map((option) => option.physicalEffect).filter(Boolean));
    const failureEvidence = /something went wrong|technical (?:issue|problem|error)|service unavailable|temporarily unavailable|unable to (?:continue|complete|process)|could(?:n'?t| not) (?:continue|complete|process)/.test(localText);
    const terminalRecoveryEvidence = /try again later|back to (?:search|home|start)|start (?:again|over)|report (?:this )?error|reference id|visitor id|contact support/.test(localText);
    // This is a typed terminal website state, not a validation warning. It must
    // own the foreground before any stale form fields behind the surface.
    if (failureEvidence && terminalRecoveryEvidence) return "site_failure";
    if (choiceOptions.length >= 2) return "choice_set";
    if (fieldCount > 0) return "form";
    if (/review|verify|check your (details|information)/.test(localText)
      && (effects.has("advance_surface") || effects.has("advance_checkout_stage"))) return "review_confirmation";
    if (/warning|are you sure|attention|unable|problem|error|continue without|haven.?t selected a seat|not selected.*seat|seat.*not selected|without.*seat|skip seat selection/.test(localText)) return "warning";
    if (effects.has("advance_surface") || effects.has("advance_checkout_stage")) return "navigation";
    if (type !== "page" && options.length === 0) return "information";
    return "unknown";
  }

  function buildActiveSurface(overlays = activeOverlayElements(), sections = [], taskQueue = [], structuralCollections = []) {
    const overlay = overlays[0];
    if (!overlay) {
      return {
        type: "page",
        id: "",
        label: "",
        role: "",
        taskHint: "",
        options: [],
        buttons: [],
        controlCollections: [],
        box: null,
        accessibility: null,
        visualState: foregroundSurfaceState({ type: "page" })
      };
    }
    const role = implicitRole(overlay);
    const text = overlayText(overlay);
    const type = isTransientChoiceOverlay(overlay) ? "dropdown" : /dialog|modal/i.test(role) || overlay.getAttribute("aria-modal") === "true" ? "modal" : "popover";
    const map = agent.pageMap || null;
    const parentContext = inferSurfaceParentDecisionContext(overlay, sections);
    const overlayId = elementId(overlay);
    const boundedSurfaceActions = boundHighCardinalityActionElements(
      surfaceActionElements(overlay),
      structuralCollections,
      { surfaceId: overlayId }
    );
    const options = boundedSurfaceActions.elements.map((option) => {
      const label = overlayChoiceText(option);
      const ownedEvidence = controlOwnedEvidence(option);
      const fallbackSemantic = overlayOptionSemantic(label);
      const meaning = resolveOwnedControlMeaning(ownedEvidence, fallbackSemantic, type);
      const box = elementBox(option);
      const choiceStructure = Boolean(
        option.matches?.("input[type='radio'], input[type='checkbox'], [role='option']")
        || option.querySelector?.("input[type='radio'], input[type='checkbox'], [role='option']")
      );
      return {
        id: elementId(option),
        label,
        semantic: meaning.semantic,
        physicalEffect: meaning.physicalEffect,
        semanticConflict: meaning.conflict === true,
        testId: ownedEvidence.testId,
        formAction: ownedEvidence.formAction,
        formMethod: ownedEvidence.formMethod,
        formId: ownedEvidence.formId,
        ownText: ownedEvidence.ownText,
        ariaLabel: ownedEvidence.ariaLabel,
        title: ownedEvidence.title,
        iconOnly: ownedEvidence.iconOnly,
        choiceStructure,
        risk: overlayOptionRisk(label),
        selected: isChoiceSelected(option) || option.getAttribute?.("aria-selected") === "true",
        decisionGroupId: parentContext.decisionGroupId || "",
        box,
        accessibility: accessibilityNode(option, map)
      };
    }).filter((option) => option.label && meaningfulActionBox(option.box));
    // Large surfaces (a seat map can have 80+ individual seat buttons) blow past the
    // slice(0, 20) cap in raw DOM order, which is exactly backwards: seats are near the
    // top of the DOM, but the dialog's own dismiss/confirm control (Next/Close/Continue/
    // Done) is in the footer, last in DOM order — so it silently never made it into the
    // list the model could choose from. It correctly registers the choice, then has no
    // way to leave the dialog and stalls. Put navigation controls first so truncation
    // trims individual seat/choice buttons before it ever touches these.
    const NAV_CONTROL_LABEL = /^(next|continue|close( window)?|done|confirm|submit)\b/i;
    const prioritized = [
      ...options.filter((option) => NAV_CONTROL_LABEL.test(option.label)),
      ...options.filter((option) => !NAV_CONTROL_LABEL.test(option.label))
    ];
    const surfaceClass = classifySurfaceSemantics(overlay, prioritized, type);
    let surface = {
      type,
      id: overlayId,
      decisionGroupId: parentContext.decisionGroupId || "",
      parentControlId: parentContext.parentControlId || "",
      parentElementId: parentContext.parentElementId || "",
      parentSectionId: parentContext.parentSectionId || "",
      parentSectionType: parentContext.parentSectionType || "",
      parentSectionLabel: parentContext.parentSectionLabel || "",
      label: text.slice(0, 800),
      role,
      taskHint: parentContext.parentSectionType || "",
      surfaceClass,
      blocksBackground: surfaceStructurallyBlocksBackground(overlay, type),
      options: prioritized,
      buttons: prioritized,
      controlCollections: boundedSurfaceActions.collections,
      sourceActionCount: boundedSurfaceActions.sourceCount,
      omittedActionCount: boundedSurfaceActions.omittedCount,
      box: elementBox(overlay),
      accessibility: accessibilityNode(overlay, map)
    };
    if (surface.surfaceClass === "warning" && surfaceLooksLikeSeatSkip(surface)) {
      const corrected = surface.options.map((option) => (
        /^(continue|next|proceed|go without|continue without)\b/i.test(option.label || "")
          ? { ...option, physicalEffect: "dismiss_surface" }
          : option
      ));
      surface = { ...surface, options: corrected, buttons: corrected };
    }
    return {
      ...surface,
      visualState: foregroundSurfaceState(surface)
    };
  }

  function surfaceText(surface = {}) {
    const collectionEvidence = (surface.controlCollections || [])
      .map((collection) => `${collection.type || "collection"} ${collection.totalCount || 0} items`)
      .join(" ");
    return `${surface.label || ""} ${surface.text || ""} ${boundedSurfaceEvidenceOptions(surface).map((option) => option.label || "").join(" ")} ${collectionEvidence}`.replace(/\s+/g, " ").trim();
  }

  function surfaceLooksLikeSeatSkip(surface = {}) {
    const text = surfaceText(surface).toLowerCase();
    return /are you sure|haven.?t selected a seat|not selected.*seat|seat.*not selected|without.*seat|skip seat selection/.test(text)
      && /\b(continue|next|proceed)\b/.test(text)
      && !/choose seat only|select seat only/.test(text);
  }

  function buildSurfaceStack(activeSurface, sections = [], taskQueue = [], overlays = [], step = "unknown") {
    const blocksBackground = activeSurface?.blocksBackground === true;
    const pageSurface = {
      id: "surface-page",
      type: "page",
      label: step,
      role: "document",
      blocksBackground: false,
      isCurrent: !activeSurface?.type || activeSurface.type === "page" || !blocksBackground,
      taskQueue,
      backgroundTaskQueue: [],
      sectionIds: (sections || []).map((section) => section.id).filter(Boolean),
      options: [],
      buttons: [],
      box: null
    };
    if (!activeSurface?.type || activeSurface.type === "page") {
      return {
        surfaceStack: [pageSurface],
        currentSurface: pageSurface,
        backgroundTasks: [],
        currentSurfaceTasks: taskQueue
      };
    }
    const surface = {
      ...activeSurface,
      text: activeSurface.label || "",
      blocksBackground,
      isCurrent: blocksBackground,
      taskQueue: [],
      backgroundTaskQueue: taskQueue,
      expectedResolution: surfaceLooksLikeSeatSkip(activeSurface) ? "waive_or_skip_seat_selection" : "resolve_active_surface",
      foreground: foregroundSurfaceState(activeSurface)
    };
    if (!blocksBackground) {
      return {
        surfaceStack: [pageSurface, surface],
        currentSurface: pageSurface,
        backgroundTasks: [],
        currentSurfaceTasks: taskQueue
      };
    }
    return {
      surfaceStack: [{ ...pageSurface, isCurrent: false, backgroundTaskQueue: [] }, surface],
      currentSurface: surface,
      backgroundTasks: surface.backgroundTaskQueue,
      currentSurfaceTasks: []
    };
  }


  return Object.freeze({
    activeOverlayElements,
    isPersistentEdgeCheckoutChrome,
    surfaceStructurallyBlocksBackground,
    overlayText,
    overlayChoiceText,
    overlayChoiceTarget,
    overlayButtons,
    surfaceActionElements,
    surfaceMembershipForElement,
    isTransientChoiceOverlay,
    overlaySignature,
    waitForOverlayProgress,
    isDangerousActionLabel,
    isSafeContinueLabel,
    isSkipChoiceLabel,
    actionRisk,
    overlayOptionSemantic,
    overlayOptionRisk,
    declineChoiceIntent,
    isStageExitDecision,
    currentSurfaceEntries,
    inferSurfaceParentDecisionContext,
    classifySurfaceSemantics,
    buildActiveSurface,
    surfaceText,
    surfaceLooksLikeSeatSkip,
    buildSurfaceStack
  });
}
