export function createFieldEvidence({
  queryAllDeep,
  implicitRole,
  choiceLabel,
  elementId,
  normalizedFieldAlias,
  canonicalProfileFieldType,
  profileFieldTypesFromText,
  normalizedProfileChoiceValue
}) {
  function labelText(input) {
    const direct = input.closest("label")?.innerText || "";
    const idLabel = input.id ? queryAllDeep(`label[for="${CSS.escape(input.id)}"]`)[0]?.innerText || "" : "";
    const labelledBy = (input.getAttribute("aria-labelledby") || "")
      .split(/\s+/)
      .map((id) => id && document.getElementById(id)?.innerText)
      .filter(Boolean)
      .join(" ");
    const primary = [
      input.name,
      input.id,
      input.placeholder,
      input.getAttribute("aria-label"),
      input.getAttribute("aria-describedby"),
      direct,
      idLabel,
      labelledBy
    ].filter(Boolean).join(" ");
    const usefulPrimary = primary
      .replace(/headlessui|combobox|input|select|field|control|react|aria|describedby|labelledby|[-_\d]/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    const nearby = [input.parentElement, input.parentElement?.parentElement]
      .map((element) => (element?.innerText || "").replace(/\s+/g, " ").trim())
      .filter((text) => text && text.length < 260)
      .join(" ");
    return [primary, usefulPrimary.length < 4 ? nearby : ""].filter(Boolean).join(" ").toLowerCase();
  }

  function localLabelText(input) {
    const direct = input.closest("label")?.innerText || "";
    const idLabel = input.id ? queryAllDeep(`label[for="${CSS.escape(input.id)}"]`)[0]?.innerText || "" : "";
    const labelledBy = (input.getAttribute("aria-labelledby") || "")
      .split(/\s+/)
      .map((id) => id && document.getElementById(id)?.innerText)
      .filter(Boolean)
      .join(" ");
    return [
      input.name,
      input.id,
      input.placeholder,
      input.getAttribute("aria-label"),
      direct,
      idLabel,
      labelledBy
    ].filter(Boolean).join(" ").replace(/\s+/g, " ").toLowerCase();
  }

  function stableProfileFieldOwnerKey(group) {
    if (!group) return "";
    const explicit = [
      group.getAttribute?.("name") ? `name:${group.getAttribute("name")}` : "",
      group.getAttribute?.("data-testid") ? `testid:${group.getAttribute("data-testid")}` : "",
      group.getAttribute?.("aria-labelledby") ? `labelledby:${group.getAttribute("aria-labelledby")}` : "",
      group.getAttribute?.("aria-label") ? `arialabel:${normalizedFieldAlias(group.getAttribute("aria-label"))}` : "",
      group.id && !/^atw[-_]/i.test(group.id) ? `id:${group.id}` : ""
    ].filter(Boolean);
    if (explicit.length) return explicit.join("|");
    const path = [];
    for (let current = group, depth = 0; current && depth < 5; current = current.parentElement, depth += 1) {
      const tag = String(current.tagName || "node").toLowerCase();
      const role = String(current.getAttribute?.("role") || "").toLowerCase();
      const siblings = current.parentElement
        ? [...current.parentElement.children].filter((item) => (
            String(item.tagName || "").toLowerCase() === tag
            && String(item.getAttribute?.("role") || "").toLowerCase() === role
          ))
        : [current];
      path.push(`${tag}:${role || "none"}:${Math.max(0, siblings.indexOf(current))}`);
    }
    return `path:${path.join("/")}`;
  }

  function profileFieldGroupEvidence(input) {
    let group = input?.closest?.("fieldset, [role='radiogroup'], [role='group']") || null;
    if (!group && (input?.type === "radio" || implicitRole(input) === "radio")) {
      const name = input.getAttribute?.("name") || "";
      const peers = name
        ? queryAllDeep(`input[type='radio'][name="${CSS.escape(name)}"], [role='radio'][name="${CSS.escape(name)}"]`)
        : [];
      for (let current = input.parentElement, depth = 0; current && depth < 5; current = current.parentElement, depth += 1) {
        if (peers.length > 1 && peers.every((peer) => current.contains(peer))) {
          group = current;
          break;
        }
      }
    }
    const labelledBy = String(group?.getAttribute?.("aria-labelledby") || "")
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent || "")
      .join(" ");
    const label = [
      group?.querySelector?.("legend")?.textContent,
      group?.querySelector?.(":scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > label")?.textContent,
      group?.getAttribute?.("aria-label"),
      labelledBy
    ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    const optionLabels = group
      ? queryAllDeep("input[type='radio'], [role='radio'], option, [role='option']", group)
        .map((option) => choiceLabel(option))
        .filter(Boolean)
        .slice(0, 12)
      : [];
    const controlCount = group
      ? queryAllDeep("input, select, textarea, [role='radio'], [role='combobox'], [role='spinbutton']", group)
        .filter((control, index, list) => list.indexOf(control) === index)
        .length
      : 0;
    const role = String(group?.getAttribute?.("role") || "").toLowerCase();
    const tight = Boolean(group && label && (
      group.tagName === "FIELDSET"
      || role === "radiogroup"
      || (role === "group" && controlCount > 0 && controlCount <= 4)
    ));
    return {
      group,
      label,
      optionLabels,
      tight,
      ownerId: tight ? elementId(group) : "",
      ownerKey: tight ? stableProfileFieldOwnerKey(group) : "",
      controlCount
    };
  }

  function explicitProfileLabelEvidence(input) {
    const nestedLabel = input.closest?.("label");
    const idLabel = input.id ? queryAllDeep(`label[for="${CSS.escape(input.id)}"]`)[0] : null;
    const labelledBy = String(input.getAttribute?.("aria-labelledby") || "")
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent || "")
      .join(" ");
    return [
      input.getAttribute?.("aria-label"),
      nestedLabel?.textContent,
      idLabel?.textContent,
      labelledBy,
      input.getAttribute?.("placeholder")
    ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  }

  function classifyProfileField(input, hintedField = "") {
    const hinted = canonicalProfileFieldType(hintedField);
    if (!input) return { fieldType: "", source: "none", confidence: 0, evidence: [] };
    const tag = String(input.tagName || "").toUpperCase();
    const type = String(input.getAttribute?.("type") || input.type || "").toLowerCase();
    const role = String(implicitRole(input) || "").toLowerCase();
    const autocomplete = String(input.getAttribute?.("autocomplete") || "").toLowerCase();
    const group = profileFieldGroupEvidence(input);
    const editable = !["radio", "checkbox", "button", "submit", "reset"].includes(type)
      && !["radio", "checkbox", "button", "option"].includes(role);
    const explicitLabel = explicitProfileLabelEvidence(input);
    const result = (fieldType, source, confidence, used = "", extra = {}) => ({
      fieldType,
      source,
      confidence,
      evidence: [used].filter(Boolean).slice(0, 4),
      evidenceByChannel: {
        rawAttributes: [input.name, input.id, input.getAttribute?.("data-testid"), autocomplete].filter(Boolean),
        explicitLabel: explicitLabel ? [explicitLabel] : [],
        tightLocalOwner: group.tight && group.label ? [group.label] : [],
        sectionContext: []
      },
      tightOwnerId: group.ownerId || "",
      tightOwnerKey: group.ownerKey || "",
      ...extra
    });
    const resolveTier = (candidates = [], source = "", confidence = 0, used = "") => {
      const unique = [...new Set(candidates.filter(Boolean))];
      if (unique.length === 1) return result(unique[0], source, confidence, used);
      if (unique.length > 1) {
        return result("", "semantic_conflict", 0, used, {
          ambiguity: { code: "AMBIGUOUS_FIELD_SEMANTICS", source, candidates: unique }
        });
      }
      return null;
    };
    // Profile facts belong to value-entry controls. Activation-only controls
    // and checkboxes often carry long descriptive copy (legal terms are the
    // important example), so words such as "names", "e-mail", or "age" in
    // that copy are not evidence that the control edits that profile fact.
    // Radios remain eligible because tightly-owned option groups can encode
    // actual profile values such as title or gender.
    const activationOnly = ["A", "BUTTON"].includes(tag)
      || ["button", "link", "option"].includes(role)
      || ["button", "submit", "reset"].includes(type);
    const profileChoiceActivator = ["combobox", "listbox"].includes(role)
      || String(input.getAttribute?.("aria-haspopup") || "").toLowerCase() === "listbox";
    if (profileChoiceActivator) {
      const choiceEvidence = [
        input.name,
        input.id,
        input.getAttribute?.("data-testid"),
        autocomplete,
        explicitLabel
      ].filter(Boolean).join(" ");
      const choiceMachineCandidates = [input.name, input.id, input.getAttribute?.("data-testid"), autocomplete]
        .map(canonicalProfileFieldType)
        .filter(Boolean);
      const exactMachineChoice = resolveTier(
        choiceMachineCandidates,
        "profile_choice_machine_identity",
        1,
        [input.name, input.id, input.getAttribute?.("data-testid"), autocomplete].filter(Boolean).join(" ")
      );
      if (exactMachineChoice) return exactMachineChoice;
      const choiceCandidates = profileFieldTypesFromText(choiceEvidence, { editable: false });
      const resolvedChoice = resolveTier(
        choiceCandidates,
        "profile_choice_activator",
        0.98,
        choiceEvidence
      );
      if (resolvedChoice) return resolvedChoice;
    }
    if (activationOnly || type === "checkbox" || role === "checkbox") {
      return result(
        "",
        "direct_non_profile_control",
        0.99,
        [input.name, input.id, input.getAttribute?.("data-testid"), input.getAttribute?.("aria-label")]
          .filter(Boolean)
          .join(" ")
      );
    }
    if (hinted) return result(hinted, "canonical_hint", 1, hintedField);

    const autocompleteAliases = {
      "given-name": "first_name", "additional-name": "middle_name", "family-name": "last_name", name: "full_name",
      email: "email", tel: "phone", "tel-national": "phone", "tel-country-code": "phone_country_code",
      bday: "date_of_birth", "bday-day": "date_of_birth", "bday-month": "date_of_birth", "bday-year": "date_of_birth",
      country: "nationality", "country-name": "nationality"
    };
    const directMachineText = [
      input.name,
      input.id,
      input.getAttribute?.("data-testid"),
      autocomplete,
      input.getAttribute?.("aria-label"),
      input.getAttribute?.("placeholder")
    ].filter(Boolean).join(" ");
    const rawCandidates = [
      autocompleteAliases[autocomplete],
      ...[input.name, input.id, input.getAttribute?.("data-testid")]
        .map(canonicalProfileFieldType)
        .filter(Boolean)
    ];
    const explicitLabelTypes = profileFieldTypesFromText(explicitLabel, { editable });
    if (
      explicitLabelTypes.length === 1
      && explicitLabelTypes[0] === "given_names"
      && rawCandidates.every((candidate) => ["first_name", "given_names"].includes(candidate))
    ) {
      return result("given_names", "explicit_composite_label", 0.99, explicitLabel);
    }
    const radioChoice = type === "radio" || role === "radio";
    const rawResolution = resolveTier(
      rawCandidates,
      autocompleteAliases[autocomplete] ? "autocomplete_or_control_attribute" : "control_attribute",
      0.99,
      [input.name, input.id, input.getAttribute?.("data-testid"), autocomplete].filter(Boolean).join(" ")
    );
    // Value-entry controls have one machine-owned fact identity. Radios are
    // different: their name may describe one candidate value while the tight
    // group owner names another fact (for example name=title in a Gender
    // group), so that direct contradiction must still fail closed below.
    if (rawResolution && !radioChoice) return rawResolution;
    const optionCodecCandidates = (() => {
      if (!(type === "radio" || role === "radio") || !group.tight) return [];
      const titleValues = group.optionLabels.map((label) => normalizedProfileChoiceValue(label, "title"));
      const genderValues = group.optionLabels.map((label) => normalizedProfileChoiceValue(label, "gender"));
      if (genderValues.includes("male") && genderValues.includes("female")) return ["gender"];
      if (titleValues.includes("mr") && titleValues.includes("mrs/ms")) return ["title"];
      return [];
    })();
    const ownershipFamily = (fieldType = "") => {
      if (["passport_number", "document_number"].includes(fieldType)) return "document_number";
      if (["passport_expiry", "document_expiry"].includes(fieldType)) return "document_expiry";
      return fieldType;
    };
    const crossChannelCandidates = [...new Set([
      ...rawCandidates,
      ...profileFieldTypesFromText(directMachineText, { editable }),
      ...explicitLabelTypes,
      ...optionCodecCandidates
    ].filter(Boolean).map(ownershipFamily))];
    if (crossChannelCandidates.length > 1) {
      return result("", "semantic_conflict", 0, `${directMachineText} ${explicitLabel}`, {
        ambiguity: {
          code: "AMBIGUOUS_FIELD_SEMANTICS",
          source: "conflicting_direct_evidence",
          candidates: crossChannelCandidates
        }
      });
    }
    if (rawResolution) return rawResolution;
    const directMachineResolution = resolveTier(
      profileFieldTypesFromText(directMachineText, { editable }),
      "direct_machine_evidence",
      0.98,
      directMachineText
    );
    if (directMachineResolution) return directMachineResolution;
    const directMachineAlias = normalizedFieldAlias(directMachineText);
    if (!explicitLabelTypes.length && /(?:passenger|travell?er|adult)_(?:category|type|class)|(?:category|type|class)_(?:passenger|travell?er|adult)/.test(directMachineAlias)) {
      return result("", "direct_non_profile_control", 0.99, directMachineText);
    }

    const explicitResolution = resolveTier(
      profileFieldTypesFromText(explicitLabel, { editable }),
      "explicit_label_or_aria",
      0.96,
      explicitLabel
    );
    if (explicitResolution) return explicitResolution;
    if (String(input.tagName || "").toUpperCase() === "SELECT") {
      const optionLabels = [...(input.options || [])]
        .flatMap((option) => [option.value, choiceLabel(option)])
        .filter(Boolean)
        .slice(0, 24);
      const titleValues = optionLabels.map((label) => normalizedProfileChoiceValue(label, "title"));
      const genderValues = optionLabels.map((label) => normalizedProfileChoiceValue(label, "gender"));
      const titleOptions = titleValues.includes("mr") && titleValues.includes("mrs/ms");
      const genderOptions = genderValues.includes("male") && genderValues.includes("female");
      // Option labels are a deterministic fallback, not a reason to override
      // stronger machine or explicit-label evidence. If the same values could
      // mean either title or gender, leave the control unresolved.
      if (titleOptions !== genderOptions) {
        return result(
          titleOptions ? "title" : "gender",
          "native_select_options",
          0.9,
          optionLabels.join(" ")
        );
      }
    }
    if (type === "tel") return result("phone", "input_type", 0.9, type);

    const titleGroup = /(?:^|\s)(?:title|salutation|honorific)(?:\s|$)/.test(group.label.toLowerCase());
    const normalizedTitleOptions = group.optionLabels.map((label) => normalizedProfileChoiceValue(label, "title"));
    const titleOptions = normalizedTitleOptions.includes("mr") && normalizedTitleOptions.includes("mrs/ms");
    if (group.tight && (type === "radio" || role === "radio") && (titleGroup || titleOptions)) {
      return result("title", titleGroup ? "radio_group_label" : "radio_group_options", titleGroup ? 0.98 : 0.9, `${group.label} ${group.optionLabels.join(" ")}`);
    }
    const genderGroup = /(?:^|\s)(?:gender|sex)(?:\s|$)/.test(group.label.toLowerCase());
    const normalizedGenderOptions = group.optionLabels.map((label) => normalizedProfileChoiceValue(label, "gender"));
    const genderOptions = normalizedGenderOptions.includes("male") && normalizedGenderOptions.includes("female");
    if (group.tight && (type === "radio" || role === "radio") && (genderGroup || genderOptions)) {
      return result("gender", genderGroup ? "radio_group_label" : "radio_group_options", genderGroup ? 0.98 : 0.9, `${group.label} ${group.optionLabels.join(" ")}`);
    }
    return result("", "none", 0);
  }

  return Object.freeze({
    labelText,
    localLabelText,
    stableProfileFieldOwnerKey,
    profileFieldGroupEvidence,
    explicitProfileLabelEvidence,
    classifyProfileField
  });
}
