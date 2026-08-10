import { currentNavigationUrl } from "../navigation-identity.js";

export function createPageUnderstanding({
  classifyStepDetailed,
  runRiskChecks,
  structuredPriceFromText
}) {
  function maskFieldPreview(fieldType, value) {
    const text = String(value || "");
    if (!text) return "";
    if (["passport_number", "phone", "phone_country_code"].includes(fieldType)) {
      return text.length > 4 ? `${text.slice(0, Math.max(2, text.length - 4))}${"*".repeat(4)}` : "****";
    }
    if (fieldType === "email" || fieldType === "confirm_email") {
      const [user, domain] = text.split("@");
      if (!domain) return "***";
      return `${user.slice(0, 2)}${"*".repeat(Math.max(2, user.length - 2))}@${domain}`;
    }
    return text.length > 60 ? `${text.slice(0, 60)}…` : text;
  }

  function sectionEvidence(section) {
    const evidence = [];
    const filledFields = (section.fields || []).filter((field) => field.hasValue);
    const emptyRequired = (section.fields || []).filter((field) => field.required && !field.hasValue);
    if (filledFields.length) {
      evidence.push(`${filledFields.length} field(s) filled: ${filledFields.map((field) => (field.field !== "unknown" ? field.field : field.label.slice(0, 24))).join(", ")}`);
    }
    if (emptyRequired.length) {
      evidence.push(`${emptyRequired.length} required field(s) empty: ${emptyRequired.map((field) => (field.field !== "unknown" ? field.field : field.label.slice(0, 24))).join(", ")}`);
    }
    if (section.selected && section.selected.length) evidence.push(`Selected: ${section.selected.join(", ")}`);
    if (!evidence.length) evidence.push(`Status inferred as ${section.status}.`);
    return evidence;
  }

  function fieldEvidence(field) {
    const evidence = [`Label/placeholder: "${(field.label || "").slice(0, 60)}"`];
    evidence.push(field.hasValue ? "Field currently has a value" : "Field appears empty");
    if (field.required) evidence.push("Marked required");
    return evidence;
  }

  function priceFromText(text = "") {
    const normalized = String(text || "").replace(/\s+/g, " ");
    const totalLabel = normalized.match(/\b(?:amount to pay|total(?: amount| price)?|grand total|subtotal)\b/i);
    const ownedTotal = totalLabel
      ? structuredPriceFromText(normalized.slice(totalLabel.index, totalLabel.index + 160))
      : null;
    if (ownedTotal) return ownedTotal;
    const totalMatch = normalized.match(/(?:amount to pay|total amount|total price|grand total|subtotal)[^0-9€$£]{0,80}(?:(EUR|USD|GBP|[€$£])\s?(\d+(?:[.,]\d{1,2})?)|(\d+(?:[.,]\d{1,2})?)\s?(EUR|USD|GBP|[€$£]))/i);
    const match = totalMatch
      || normalized.match(/(EUR|USD|GBP|[€$£])\s?(\d+(?:[.,]\d{1,2})?)/i)
      || text.match(/(\d+(?:[.,]\d{1,2})?)\s?(EUR|USD|GBP|[€$£])/i);
    if (!match) return null;
    const currencyMap = { "€": "EUR", "$": "USD", "£": "GBP" };
    const currencyToken = /[a-z€$£]/i.test(match[1] || "") ? match[1] : (match[4] || match[2]);
    const amountToken = currencyToken === match[1] ? match[2] : (match[3] || match[1]);
    const currency = currencyMap[currencyToken] || currencyToken.toUpperCase();
    const amount = Number(amountToken.replace(",", "."));
    return Number.isFinite(amount) ? { amount, currency } : null;
  }

  function includedBaggageOptions(section) {
    if (section.type !== "baggage") return [];
    const text = section.text || "";
    const items = [];
    if (/personal item[^.]{0,80}?included/i.test(text)) {
      items.push({
        id: `${section.id}-personal-item`,
        category: "baggage",
        label: "Personal item",
        status: "included",
        description: "Small bag included for all passengers.",
        confidence: 0.85,
        evidence: ["Section text mentions personal item as included"]
      });
    }
    if (/hand baggage[^.]{0,80}?included/i.test(text)) {
      items.push({
        id: `${section.id}-hand-baggage`,
        category: "baggage",
        label: "Hand baggage",
        status: "included",
        description: "Cabin bag included for all passengers.",
        confidence: 0.85,
        evidence: ["Section text mentions hand baggage as included"]
      });
    }
    return items;
  }

  function categoryForSectionType(type) {
    if (type === "baggage") return "baggage";
    if (type === "seat") return "seat";
    if (type === "cancellation_insurance") return "insurance";
    if (type === "payment") return "payment";
    return "unknown";
  }

  function extractPageOptions(sections = []) {
    const options = [];
    for (const section of sections) {
      options.push(...includedBaggageOptions(section));
      const category = categoryForSectionType(section.type);
      for (const choice of section.choices || []) {
        let status = "unknown";
        if (choice.selected) status = "selected";
        else if (choice.semantic === "add_paid_extra") status = "paid_extra";
        else if (choice.semantic === "decline_paid_extra" || choice.semantic === "decline_baggage") status = "not_selected";
        const price = priceFromText(choice.label);
        options.push({
          id: choice.id,
          category,
          label: (choice.label || "").slice(0, 80),
          status,
          price: price || undefined,
          confidence: status === "unknown" ? 0.5 : 0.8,
          evidence: [`Detected as a ${section.label} choice`, `Selected: ${choice.selected}`]
        });
      }
    }
    return options;
  }

  function actionTypeForSectionType(type) {
    if (type === "contact" || type === "passenger") return "fill_field";
    if (["baggage", "bundle", "flexible_ticket", "cancellation_insurance", "seat"].includes(type)) return "select_option";
    if (type === "continue") return "click_continue";
    return "ask_user";
  }

  function riskLevelForTask(task) {
    return task.rule && /no paid extras/i.test(task.rule) ? "safe" : "medium";
  }

  function buildProposedNextActions(taskQueue = []) {
    return taskQueue.slice(0, 8).map((task, index) => ({
      id: `action-${task.sectionId || index}`,
      actionType: actionTypeForSectionType(task.sectionType),
      label: task.objective || `Resolve ${task.sectionLabel}`,
      targetElementId: task.sectionId,
      riskLevel: riskLevelForTask(task),
      executableInObserverMode: false,
      reason: task.rule || "Pending section needs attention before continuing.",
      confidence: 0.75
    }));
  }

  function buildReasoningSummary(map, stepInfo, sections) {
    const incomplete = sections.filter((section) => section.status === "incomplete");
    const complete = sections.filter((section) => section.status === "complete");
    const blockerText = incomplete.length
      ? `${incomplete.length} incomplete: ${incomplete.map((section) => section.label).join(", ")}`
      : "no incomplete sections";
    const shortSummary = `This is a ${map.site} ${stepInfo.step.replace(/_/g, " ")} page. ${complete.length} section${complete.length === 1 ? "" : "s"} complete, ${blockerText}.`;
    const keyEvidence = sections.slice(0, 6).flatMap((section) => (section.evidence || []).slice(0, 1).map((item) => `${section.label}: ${item}`));
    const uncertainty = [
      ...map.fields.filter((field) => field.field !== "unknown" && field.confidence < 0.7).map((field) => `Low confidence field match: "${(field.label || "").slice(0, 40)}" (${Math.round(field.confidence * 100)}%)`),
      ...sections.filter((section) => section.status === "unknown").map((section) => `Section "${section.label}" status could not be determined.`)
    ].slice(0, 6);
    return { shortSummary, keyEvidence, uncertainty };
  }

  function buildPageUnderstanding(map) {
    const stepInfo = classifyStepDetailed({
      visibleText: `${map.text} ${map.fullText.slice(0, 2500)}`,
      url: currentNavigationUrl(),
      structuralEvidence: {
        seatInventoryCount: (map.collections || [])
          .filter((collection) => collection.type === "seat_inventory")
          .reduce((total, collection) => total + Number(collection.totalCount || collection.members?.length || 0), 0)
      }
    });
    const sections = (map.sections || []).map((section) => ({
      id: section.id,
      label: section.label,
      type: section.type,
      status: section.status,
      confidence: section.type === "unknown" ? 0.5 : 0.85,
      evidence: sectionEvidence(section),
      box: section.box
    }));
    const fields = map.fields.map((field) => ({
      id: field.id,
      label: field.label,
      semanticType: field.field,
      required: field.required,
      visible: true,
      filled: Boolean(field.value),
      valuePreview: field.value ? maskFieldPreview(field.field, field.value) : undefined,
      confidence: field.confidence,
      evidence: fieldEvidence(field),
      box: field.box
    }));
    const options = extractPageOptions(map.sections || []);
    const warnings = runRiskChecks();
    const proposedNextActions = buildProposedNextActions(map.taskQueue || []);
    const reasoningSummary = buildReasoningSummary(map, stepInfo, sections);
    const blockers = sections
      .filter((section) => section.status === "incomplete")
      .map((section) => ({
        type: "incomplete_section",
        message: `${section.label} is incomplete.`,
        severity: section.type === "passenger" || section.type === "contact" ? "high" : "medium"
      }));

    return {
      pageIdentity: {
        host: location.host,
        url: currentNavigationUrl(),
        siteName: map.site,
        pageType: stepInfo.step,
        confidence: stepInfo.confidence
      },
      checkoutState: {
        overallStatus: stepInfo.step === "unknown" ? "not_checkout" : (map.summary.continueAllowed ? "ready_to_continue" : (blockers.length ? "blocked" : "in_progress")),
        currentStep: stepInfo.step,
        completedSteps: sections.filter((section) => section.status === "complete").map((section) => section.label),
        incompleteSteps: sections.filter((section) => section.status === "incomplete").map((section) => section.label),
        blockers
      },
      sections,
      fields,
      options,
      warnings,
      proposedNextActions,
      reasoningSummary,
      debug: {
        scanId: `scan_${Date.now().toString(36)}`,
        scannedAt: new Date().toISOString(),
        engineVersion: "observer-v1",
        latencyMs: 0
      }
    };
  }


  return {
    buildPageUnderstanding,
    buildProposedNextActions,
    buildReasoningSummary,
    extractPageOptions,
    fieldEvidence,
    maskFieldPreview,
    priceFromText,
    sectionEvidence
  };
}
