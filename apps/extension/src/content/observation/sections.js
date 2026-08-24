export function createSectionPerception(dependencies) {
  const {
    buttonText,
    candidateInputs,
    choiceLabel,
    controlText,
    elementBox,
    elementById,
    elementId,
    fieldValue,
    findSafeContinueButton,
    isGlobalChromeControl,
    isVisible,
    labelText,
    meaningfulActionBox,
    queryAllDeep
  } = dependencies;

  function sectionContainer(element) {
    let current = element;
    for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
      if (current.closest?.("#atw-sidebar")) return element;
      const rect = current.getBoundingClientRect();
      const text = (current.innerText || current.textContent || "").replace(/\s+/g, " ").trim();
      if (isSummaryLikeElement(current)) continue;
      if (rect.width > 260 && rect.height > 90 && text.length > 20 && text.length < 1800) return current;
    }
    return element;
  }

  function cardContainerForControl(control, headingPattern) {
    let best = null;
    let current = control;
    for (let depth = 0; current && depth < 10; depth += 1, current = current.parentElement) {
      if (current.closest?.("#atw-sidebar")) break;
      const rect = current.getBoundingClientRect();
      const text = (current.innerText || current.textContent || "").replace(/\s+/g, " ").trim();
      if (rect.width < 260 || rect.height < 70 || !text) continue;
      if (headingPattern.test(text) && !isSummaryLikeElement(current)) {
        best = current;
        if (text.length > 120 && text.length < 2800) break;
      }
    }
    return best || sectionContainer(control);
  }

  function isSummaryLikeElement(element) {
    const text = (element?.innerText || element?.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
    if (!text) return false;
    const summarySignals = [/your order/, /price overview/, /total amount/, /amount to pay/, /departure.*return.*bags/];
    const hasSummarySignal = summarySignals.some((pattern) => pattern.test(text));
    if (!hasSummarySignal) return false;
    const decisionControls = queryAllDeep("input[type='radio'], input[type='checkbox'], select, [role='combobox']", element)
      .filter((control) => isVisible(control) && !control.closest("#atw-sidebar"));
    return decisionControls.length === 0;
  }

  function checkoutHeadingCount(text) {
    return [
      /contact information/i,
      /passenger\s+\d+/i,
      /select baggage/i,
      /upgrade your trip/i,
      /flexible ticket/i,
      /cancellation guarantee/i,
      /your order/i,
      /price overview/i
    ].filter((pattern) => pattern.test(text)).length;
  }

  function sectionPlanDescription(section) {
    const text = (section.element.innerText || section.element.textContent || "").replace(/\s+/g, " ").trim();
    const controls = queryAllDeep("input[type='radio'], input[type='checkbox'], select, [role='combobox'], button, [role='button']", section.element)
      .filter((control) => isVisible(control) && !control.closest("#atw-sidebar"));
    const required = /\*|select one option|choose your bundle|mobile number|first name|surname|title/i.test(text);
    const paid = /eur|bundle|flexible ticket|cancellation|baggage|add to cart/i.test(text);
    return `${section.label}: ${controls.length} controls${required ? ", required" : ""}${paid ? ", paid-choice" : ""}`;
  }

  function plannedTargetForSection(label) {
    const targets = {
      contact: "fill email, confirm email, country code, phone",
      passenger: "title, first name, surname",
      baggage: "choose no checked baggage",
      bundle: "choose bundle footer: No, thanks",
      "flexible ticket": "choose None of the passengers",
      cancellation: "choose No thanks",
      continue: "click Continue only after verification"
    };
    return targets[label] || "resolve required controls";
  }

  function clearSectionHighlights() {
    queryAllDeep(".atw-section-highlight").forEach((element) => element.classList.remove("atw-section-highlight"));
  }

  function clearSectionOutlines() {
    queryAllDeep(".atw-section-outline").forEach((element) => element.remove());
    queryAllDeep(".atw-section-outline-source").forEach((element) => element.classList.remove("atw-section-outline-source"));
  }

  function highlightSection(element, label = "section") {
    // Retired for the same reason as outlineCoreSections: this box was only ever
    // refreshed by two narrow legacy code paths (the initial announceSectionQueue
    // call, and the JS auto-fill helper for simple named fields) — the main
    // AI-decision execution path never called or cleared it, so it froze on
    // whatever it last touched (usually "contact") while the cursor and the
    // sidebar's section checklist had already moved on. Those two are the
    // accurate, always-current source of "what's it working on" now.
    clearSectionHighlights();
    return element || null;
  }

  function outlineCoreSections(sections = []) {
    // Retired: the on-page section boxes guessed boundaries from DOM proximity
    // (sectionBand/sectionContainer), which can't reliably find pixel-accurate
    // edges on arbitrary site markup — they routinely overlapped adjacent
    // sections even with no modal involved. The sidebar's section checklist
    // (agentSectionsHtml) shows the same done/current/pending state without
    // guessing page coordinates, so this just clears any leftover boxes now.
    clearSectionOutlines();
    return liveSectionModels(sections).filter((section) => section.element && isVisible(section.element));
  }

  function sectionAnchorByText(pattern) {
    return queryAllDeep("section, article, form, div, fieldset")
      .filter((element) => isVisible(element) && !element.closest("#atw-sidebar, .atw-section-outline, #atw-agent-cursor"))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const text = (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
        if (!text || text.length < 12 || text.length > 2600 || rect.width < 220 || rect.height < 45) return null;
        let score = pattern.test(text) ? 40 : 0;
        if (!score) return null;
        if (isSummaryLikeElement(element)) score -= 80;
        const matchingControls = queryAllDeep("input, select, button, [role='button'], [role='combobox']", element)
          .filter((control) => isVisible(control) && !control.closest("#atw-sidebar"))
          .filter((control) => pattern.test(`${labelText(control)} ${controlText(control)} ${buttonText(control)}`));
        if (matchingControls.length) score += 35;
        const decisionControls = queryAllDeep("input[type='radio'], input[type='checkbox'], select, [role='combobox']", element)
          .filter((control) => isVisible(control) && !control.closest("#atw-sidebar"));
        if (decisionControls.length) score += Math.min(24, decisionControls.length * 4);
        const headingCount = checkoutHeadingCount(text);
        if (headingCount > 1) score -= headingCount * 22;
        if (/configure your trip/i.test(text) && headingCount > 2) score -= 60;
        if (/your order|price overview|total amount/i.test(text)) score -= 60;
        score -= Math.max(0, text.length - 600) / 200;
        score -= Math.max(0, rect.width - 900) / 40;
        return { element, score, top: rect.top };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score || a.top - b.top)[0]?.element || null;
  }

  function elementRectArea(element) {
    const rect = element.getBoundingClientRect();
    return Math.max(0, rect.width) * Math.max(0, rect.height);
  }

  function sectionCardByPattern(pattern, controlPattern = pattern, options = {}) {
    const requiredPatterns = options.require || [];
    const rejectedPatterns = options.reject || [];
    const candidates = queryAllDeep("section, article, form, fieldset, div")
      .filter((element) => isVisible(element) && !element.closest("#atw-sidebar, .atw-section-outline, #atw-agent-cursor"))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const text = (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
        if (!text || rect.width < 280 || rect.height < 120 || text.length > 3600) return null;
        if (!pattern.test(text)) return null;
        if (requiredPatterns.some((item) => !item.test(text))) return null;
        if (rejectedPatterns.some((item) => item.test(text))) return null;
        if (isSummaryLikeElement(element)) return null;
        const controls = queryAllDeep("input[type='radio'], input[type='checkbox'], select, [role='combobox'], button, [role='button']", element)
          .filter((control) => isVisible(control) && !control.closest("#atw-sidebar"));
        const matchingControls = controls.filter((control) => controlPattern.test(`${labelText(control)} ${controlText(control)} ${buttonText(control)} ${choiceLabel(control)}`));
        if (options.requireMatchingControl && !matchingControls.length) return null;
        const declineControls = controls.filter((control) => /no,?\s*thanks|none of the passengers|no checked baggage|without|go without/i.test(`${labelText(control)} ${controlText(control)} ${buttonText(control)} ${choiceLabel(control)}`));
        let score = 80;
        score += Math.min(50, controls.length * 6);
        score += matchingControls.length ? 60 : 0;
        score += declineControls.length ? 55 : 0;
        if (/no,?\s*thanks|none of the passengers|no checked baggage/i.test(text)) score += 40;
        if (/add to cart|eur|€|\$|premium|bundle|flexible ticket|cancellation/i.test(text)) score += 20;
        const headingCount = checkoutHeadingCount(text);
        score -= headingCount > 1 ? headingCount * (options.strictSingleTopic ? 36 : 12) : 0;
        if (options.rejectHuge && rect.height > 900) score -= Math.max(0, rect.height - 900) / 6;
        score -= Math.abs(rect.width - 760) / 90;
        return { element, score, area: elementRectArea(element), top: rect.top };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score || b.area - a.area || a.top - b.top);
    return candidates[0]?.element || (options.noFallback ? null : sectionAnchorByText(pattern));
  }

  function fieldsetLikeSection(pattern, label = "") {
    const controls = candidateInputs()
      .filter((input) => isVisible(input) && !input.closest("#atw-sidebar"))
      .filter((input) => pattern.test(`${labelText(input)} ${controlText(input)}`));
    const anchors = controls
      .map((control) => cardContainerForControl(control, pattern))
      .filter(Boolean)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const text = (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
        const headingCount = checkoutHeadingCount(text);
        let score = 120;
        score += controls.filter((control) => element.contains(control)).length * 30;
        score -= headingCount > 1 ? headingCount * 35 : 0;
        score -= Math.max(0, text.length - 900) / 12;
        if (label === "contact" && /passenger\s+\d+|select baggage|configure your trip/i.test(text)) score -= 120;
        if (label === "passenger" && /select baggage|configure your trip/i.test(text)) score -= 120;
        return { element, score, top: rect.top, area: rect.width * rect.height };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.area - b.area);
    return anchors[0]?.element || sectionAnchorByText(pattern);
  }

  function continueSectionElement() {
    const button = findSafeContinueButton()
      || queryAllDeep("button, a, input[type='button'], input[type='submit'], [role='button']")
        .filter((element) => isVisible(element) && !element.closest("#atw-sidebar"))
        .filter((element) => meaningfulActionBox(elementBox(element)))
        .find((element) => /^continue$/i.test(buttonText(element)) || /\bcontinue\b/i.test(buttonText(element)));
    return button ? sectionContainer(button) : sectionAnchorByText(/we protect your personal data|continue/i);
  }

  function detectCheckoutSections() {
    const patterns = [
      ["contact", /contact information|provide your contact details|e-?mail|mobile number/i, () => fieldsetLikeSection(/e-?mail|confirm e-?mail|mobile number|phone/i, "contact")],
      ["passenger", /passenger\s+\d+|traveller information|traveler information|first name|surname|passport/i, () => fieldsetLikeSection(/title|first name|surname|passport/i, "passenger")],
      ["baggage", /select baggage|checked baggage|hand baggage|personal item/i, null],
      ["bundle", /bundle|premium support|airhelp|booking number by sms/i, () => sectionCardByPattern(
        /upgrade your trip|choose your bundle|premium support|airhelp|booking number by sms/i,
        /no,?\s*thanks|standard|premium|premium\+|bundle/i,
        {
          require: [/choose your bundle/i],
          reject: [/flexible ticket|cancellation guarantee|voucher refund/i],
          requireMatchingControl: true,
          strictSingleTopic: true,
          rejectHuge: true,
          noFallback: true
        }
      )],
      ["flexible ticket", /flexible ticket|change your ticket/i, () => sectionCardByPattern(
        /flexible ticket|change your ticket/i,
        /choose|none of the passengers|no,?\s*thanks|add to cart/i,
        {
          require: [/flexible ticket/i, /select one option|select an option|choose|none of the passengers/i],
          reject: [/upgrade your trip|choose your bundle|cancellation guarantee|voucher refund/i],
          requireMatchingControl: true,
          strictSingleTopic: true,
          rejectHuge: true,
          noFallback: true
        }
      )],
      ["cancellation", /cancellation guarantee|voucher refund/i, () => sectionCardByPattern(
        /cancellation guarantee|voucher refund/i,
        /no,?\s*thanks|add to cart/i,
        {
          require: [/cancellation guarantee|voucher refund/i, /select one option|select an option|no,?\s*thanks|add to cart/i],
          reject: [/upgrade your trip|choose your bundle|flexible ticket/i],
          requireMatchingControl: true,
          strictSingleTopic: true,
          rejectHuge: true,
          noFallback: true
        }
      )],
      ["payment method", /select (?:a )?payment method|choose (?:a )?payment method|credit card payment|pay with/i, () => sectionAnchorByText(
        /select (?:a )?payment method|choose (?:a )?payment method|credit card payment|pay with/i
      )]
    ];
    const seen = new Set();
    const named = patterns
      .map(([label, pattern, resolver]) => {
        const element = resolver ? resolver() : sectionAnchorByText(pattern);
        if (!element) return null;
        const id = elementId(element);
        if (seen.has(id)) return null;
        seen.add(id);
        return { label, element, box: elementBox(element) };
      })
      .filter(Boolean);
    const generic = detectGenericSections(named.map((section) => section.element))
      .filter((section) => {
        const id = elementId(section.element);
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
    return [...named, ...generic].sort((a, b) => a.box.y - b.box.y);
  }

  function genericSectionLabel(text) {
    const firstLine = (text.split(/\n|(?<=[.!?])\s{2,}/)[0] || text).replace(/\s+/g, " ").trim();
    return (firstLine.length >= 4 ? firstLine : text.replace(/\s+/g, " ").trim()).slice(0, 60) || "additional section";
  }

  function detectGenericSections(claimedElements = []) {
    const isClaimed = (element) => claimedElements.some((claimed) => claimed === element || claimed.contains(element) || element.contains(claimed));
    const candidates = queryAllDeep("section, article, form, fieldset, div")
      .filter((element) => isVisible(element) && !element.closest("#atw-sidebar, .atw-section-outline, #atw-agent-cursor"))
      .filter((element) => !isClaimed(element))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        if (rect.width < 260 || rect.height < 90 || rect.height > 1400) return null;
        const text = (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
        if (!text || text.length < 8 || text.length > 2600) return null;
        if (isSummaryLikeElement(element)) return null;
        const decisionControls = queryAllDeep("input[type='radio'], input[type='checkbox'], select, [role='combobox'], [role='listbox']", element)
          .filter((control) => isVisible(control) && !control.closest("#atw-sidebar"));
        const emptyRequiredFields = candidateInputs()
          .filter((input) => element.contains(input) && isVisible(input) && !input.closest("#atw-sidebar") && !fieldValue(input) && (input.required || /\*/.test(labelText(input))));
        if (!decisionControls.length && !emptyRequiredFields.length) return null;
        const headingCount = checkoutHeadingCount(text);
        let score = 60;
        score += Math.min(40, decisionControls.length * 8);
        score += Math.min(40, emptyRequiredFields.length * 10);
        score -= headingCount > 1 ? headingCount * 20 : 0;
        score -= Math.abs(rect.width - 760) / 100;
        return { element, score, area: rect.width * rect.height, text };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score || a.area - b.area);
    const accepted = [];
    for (const candidate of candidates) {
      const overlapsAccepted = accepted.some((item) => item.element.contains(candidate.element) || candidate.element.contains(item.element));
      if (overlapsAccepted) continue;
      accepted.push(candidate);
    }
    return accepted.map(({ element, text }) => ({
      label: genericSectionLabel(text),
      element,
      box: elementBox(element)
    }));
  }

  function liveSectionModels(sections = []) {
    return sections
      .map((section) => {
        const element = elementById(section.id) || section.element;
        if (!element) return null;
        return { ...section, element, box: elementBox(element) };
      })
      .filter(Boolean)
      .sort((a, b) => a.box.y - b.box.y);
  }

  function sectionBand(section, allSections = []) {
    const ordered = [...allSections].sort((a, b) => a.box.y - b.box.y);
    const index = ordered.findIndex((item) => item.element === section.element || item.label === section.label && item.box.y === section.box.y);
    const next = index >= 0 ? ordered[index + 1] : null;
    const top = section.box.y - 24;
    const bottom = next ? next.box.y - 14 : section.box.y + section.box.height + 160;
    return {
      top,
      bottom: Math.max(bottom, section.box.y + section.box.height + 28),
      left: section.box.x - 56,
      right: section.box.x + section.box.width + 56
    };
  }

  function elementBelongsToSectionBand(element, section, allSections = []) {
    if (!element || !section?.element) return false;
    // Global utilities may visually overlap a checkout section (for example a
    // fixed feedback tab on the viewport edge). They are never owned by the
    // checkout merely because their boxes intersect the same geometric band.
    if (isGlobalChromeControl(element)) return false;
    if (section.element.contains(element)) return true;
    const box = elementBox(element);
    const liveSections = liveSectionModels(allSections.length ? allSections : [section]);
    const liveSection = liveSections.find((item) => item.id === section.id || item.element === section.element) || section;
    const band = sectionBand(liveSection, liveSections.length ? liveSections : allSections);
    if (box.width < 8 || box.height < 8) return false;
    const verticallyInside = box.centerY >= band.top && box.centerY < band.bottom;
    const horizontallyNear = box.centerX >= band.left && box.centerX <= band.right;
    return verticallyInside && horizontallyNear;
  }


  return {
    cardContainerForControl,
    checkoutHeadingCount,
    clearSectionHighlights,
    clearSectionOutlines,
    continueSectionElement,
    detectCheckoutSections,
    detectGenericSections,
    elementBelongsToSectionBand,
    elementRectArea,
    fieldsetLikeSection,
    genericSectionLabel,
    highlightSection,
    isSummaryLikeElement,
    liveSectionModels,
    outlineCoreSections,
    plannedTargetForSection,
    sectionAnchorByText,
    sectionBand,
    sectionCardByPattern,
    sectionContainer,
    sectionPlanDescription
  };
}
