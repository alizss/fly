export function createElementRegistry({ compactText, directControlName, queryAllDeep }) {
  let counter = 0;
  let active = null;

  function nextElementId(reservedIds = new Set()) {
    let id = "";
    do {
      counter += 1;
      id = `atw-el-${counter}`;
    } while (reservedIds.has(id));
    reservedIds.add(id);
    return id;
  }

  function createRegistry() {
    const byElement = new WeakMap();
    const byId = new Map();
    const duplicateRekeys = [];
    const initialOwners = new Map();
    for (const element of queryAllDeep("[data-atw-element-id]")) {
      const id = element.dataset?.atwElementId || "";
      if (!id) continue;
      if (!initialOwners.has(id)) initialOwners.set(id, []);
      initialOwners.get(id).push(element);
    }
    const reservedIds = new Set(initialOwners.keys());

    const assign = (element) => {
      if (!element) return "";
      const assigned = byElement.get(element);
      if (assigned) return assigned;
      const inheritedId = element.dataset?.atwElementId || "";
      const inheritedOwners = inheritedId ? (initialOwners.get(inheritedId) || []) : [];
      const inheritedIsUnique = Boolean(inheritedId)
        && inheritedOwners.length <= 1
        && (!byId.has(inheritedId) || byId.get(inheritedId) === element);
      const id = inheritedIsUnique ? inheritedId : nextElementId(reservedIds);
      if (inheritedId && inheritedId !== id) {
        duplicateRekeys.push({
          inheritedId,
          assignedId: id,
          duplicateCount: Math.max(inheritedOwners.length, byId.has(inheritedId) ? 2 : 1),
          tag: (element.tagName || "").toLowerCase(),
          label: compactText(directControlName(element) || element.getAttribute?.("aria-label") || element.textContent || "", 140)
        });
      }
      try {
        element.dataset.atwElementId = id;
      } catch (_) {
        // SVG/foreign elements may not expose a mutable dataset.
      }
      byElement.set(element, id);
      byId.set(id, element);
      return id;
    };

    for (const owners of initialOwners.values()) {
      if (owners.length < 2) continue;
      owners.forEach(assign);
    }
    return {
      assign,
      idFor: (element) => byElement.get(element) || "",
      elementFor: (id) => byId.get(id) || null,
      duplicateRekeys
    };
  }

  function begin() {
    active = createRegistry();
    return active;
  }

  function current() {
    return active;
  }

  function elementId(element) {
    if (!element) return "";
    if (!active) begin();
    return active.assign(element);
  }

  function elementById(id) {
    if (!id) return null;
    const owned = active?.elementFor?.(id);
    if (owned) return owned;
    const matches = queryAllDeep(`[data-atw-element-id="${CSS.escape(id)}"]`);
    if (matches.length !== 1) return null;
    const assignedId = elementId(matches[0]);
    return assignedId === id ? matches[0] : null;
  }

  return Object.freeze({ begin, current, elementId, elementById });
}
