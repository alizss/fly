export function createControlRegistryTools({
  normalizeMatchText,
  elementById,
  isActionableClickTarget,
  elementId,
  stateElementForControl,
  canonicalControlForElement,
  unionBoxes
}) {
  function controlsAreCompatibleAliases(a = {}, b = {}) {
    if (a.controlId && b.controlId && a.controlId === b.controlId) return true;
    return normalizeMatchText(a.label || "") === normalizeMatchText(b.label || "")
      && (a.semantic || "") === (b.semantic || "")
      && (a.risk || "") === (b.risk || "")
      && (a.decisionGroupId || "") === (b.decisionGroupId || "");
  }

  function controlMemberNodeIds(control = {}) {
    const operationActuatorIds = Object.values(control.operations || {})
      .flatMap((capability) => capability?.actuatorIds || []);
    const recoveryActuatorIds = Object.values(control.recovery || {})
      .flatMap((recovery) => [
        ...(recovery?.actuatorIds || []),
        ...(recovery?.strategies || []).map((strategy) => strategy.actuatorId)
      ]);
    return [
      control.stateElementId,
      control.preferredActivationElementId,
      ...(control.actuators || []).map((actuator) => actuator.nodeId),
      ...operationActuatorIds,
      ...recoveryActuatorIds
    ].filter((nodeId, index, list) => nodeId && list.indexOf(nodeId) === index);
  }

  function controlExclusiveNodeIds(control = {}) {
    const operationActuatorIds = Object.values(control.operations || {})
      .flatMap((capability) => capability?.actuatorIds || []);
    const ids = new Set([
      control.stateElementId,
      control.preferredActivationElementId,
      ...operationActuatorIds
    ].filter(Boolean));
    for (const actuator of control.actuators || []) {
      if (!actuator?.nodeId) continue;
      if (["state", "activation", "label"].includes(actuator.relation)) {
        ids.add(actuator.nodeId);
      } else if (actuator.relation === "source") {
        const node = elementById(actuator.nodeId);
        if (node && isActionableClickTarget(node)) ids.add(actuator.nodeId);
      }
    }
    return [...ids];
  }

  function exactAtomicControlNodeId(control = {}) {
    const exclusiveIds = controlExclusiveNodeIds(control);
    if (exclusiveIds.length !== 1) return "";
    const [nodeId] = exclusiveIds;
    if (control.stateElementId && control.stateElementId !== nodeId) return "";
    if (control.preferredActivationElementId && control.preferredActivationElementId !== nodeId) return "";
    const operationIds = [...new Set(Object.values(control.operations || {})
      .flatMap((capability) => capability?.actuatorIds || [])
      .filter(Boolean))];
    if (!operationIds.length || operationIds.some((id) => id !== nodeId)) return "";
    return nodeId;
  }

  function narrowerExactControlOwner(existing = {}, incoming = {}) {
    const existingIds = new Set(controlExclusiveNodeIds(existing));
    const incomingIds = new Set(controlExclusiveNodeIds(incoming));
    const existingAtomicId = exactAtomicControlNodeId(existing);
    const incomingAtomicId = exactAtomicControlNodeId(incoming);
    if (existingAtomicId && incomingIds.has(existingAtomicId) && incomingIds.size > existingIds.size) return existing;
    if (incomingAtomicId && existingIds.has(incomingAtomicId) && existingIds.size > incomingIds.size) return incoming;
    return null;
  }

  function controlContextPriority(context = {}) {
    const surface = context.surface || {};
    if (surface?.type && surface.type !== "page") return 100;
    if (context.section?.id || context.sectionId) return 50;
    return 10;
  }

  function createObservationControlRegistry() {
    const controls = new Map();
    const byDomNode = new Map();
    const priorityByControlId = new Map();
    const conflicts = [];

    const removeOwnedControl = (control) => {
      if (!control?.controlId) return;
      controls.delete(control.controlId);
      priorityByControlId.delete(control.controlId);
      for (const [nodeId, owner] of byDomNode.entries()) {
        if (owner?.controlId !== control.controlId) continue;
        byDomNode.delete(nodeId);
        const node = elementById(nodeId);
        if (node?.dataset?.atwControlId === control.controlId) {
          try { delete node.dataset.atwControlId; } catch (_) { /* foreign elements may not expose a mutable dataset */ }
        }
      }
    };

    const registerOwnedControl = (control, priority) => {
      if (!control?.controlId) return null;
      const existing = controls.get(control.controlId) || {};
      const actuators = [...(existing.actuators || []), ...(control.actuators || [])]
        .filter((entry, index, list) => entry?.nodeId
          && list.findIndex((other) => other.nodeId === entry.nodeId && other.relation === entry.relation) === index);
      const merged = {
        ...existing,
        ...control,
        actuators,
        visualRegion: unionBoxes([existing.visualRegion, control.visualRegion].filter(Boolean))
          || control.visualRegion
          || existing.visualRegion
      };
      controls.set(merged.controlId, merged);
      priorityByControlId.set(merged.controlId, Math.max(priority, priorityByControlId.get(merged.controlId) || 0));
      for (const nodeId of controlExclusiveNodeIds(merged)) {
        byDomNode.set(nodeId, merged);
        const node = elementById(nodeId);
        if (node) {
          try { node.dataset.atwControlId = merged.controlId; } catch (_) { /* foreign elements may not expose dataset */ }
        }
      }
      return merged;
    };

    const lookupElement = (element) => {
      if (!element) return null;
      const state = stateElementForControl(element);
      const nodeIds = [elementId(element), element.dataset?.atwControlId, state ? elementId(state) : ""].filter(Boolean);
      for (const id of nodeIds) {
        if (controls.has(id)) return controls.get(id);
        if (byDomNode.has(id)) return byDomNode.get(id);
      }
      return null;
    };

    const register = (element, context = {}, explicitPriority = null) => {
      if (!element || element.closest?.("#atw-sidebar")) return null;
      const priority = Number.isFinite(explicitPriority) ? explicitPriority : controlContextPriority(context);
      const existing = lookupElement(element);
      if (existing && priority <= (priorityByControlId.get(existing.controlId) || 0)) return existing;

      const control = canonicalControlForElement(element, context);
      if (!control?.controlId) return existing || null;
      const memberIds = controlExclusiveNodeIds(control);
      const existingOwners = memberIds
        .map((nodeId) => byDomNode.get(nodeId))
        .filter(Boolean)
        .filter((owner, index, list) => list.findIndex((other) => other.controlId === owner.controlId) === index);
      const incompatibleOwner = existingOwners.find((owner) => !controlsAreCompatibleAliases(owner, control));
      if (incompatibleOwner) {
        const ownerPriority = priorityByControlId.get(incompatibleOwner.controlId) || 0;
        const exactOwner = priority === ownerPriority ? narrowerExactControlOwner(incompatibleOwner, control) : null;
        const resolvedBy = exactOwner
          ? "narrower_exact_actuator_owner"
          : priority > ownerPriority
            ? "foreground_or_higher_priority"
            : (priority < ownerPriority ? "existing_higher_priority" : "unresolved_equal_priority");
        conflicts.push({
          nodeIds: memberIds,
          existing: {
            controlId: incompatibleOwner.controlId,
            label: incompatibleOwner.label,
            semantic: incompatibleOwner.semantic,
            risk: incompatibleOwner.risk,
            decisionGroupId: incompatibleOwner.decisionGroupId,
            surfaceId: incompatibleOwner.surfaceId
          },
          incoming: {
            controlId: control.controlId,
            label: control.label,
            semantic: control.semantic,
            risk: control.risk,
            decisionGroupId: control.decisionGroupId,
            surfaceId: control.surfaceId
          },
          resolved: resolvedBy !== "unresolved_equal_priority",
          resolvedBy
        });
        if (exactOwner === incompatibleOwner) return incompatibleOwner;
        if (exactOwner === control) {
          removeOwnedControl(incompatibleOwner);
          return registerOwnedControl(control, priority);
        }
        if (priority <= ownerPriority) return incompatibleOwner;
        removeOwnedControl(incompatibleOwner);
      }
      return registerOwnedControl(control, priority);
    };

    return { register, lookupElement, controls: () => [...controls.values()], conflicts };
  }

  return Object.freeze({
    controlsAreCompatibleAliases,
    controlMemberNodeIds,
    controlExclusiveNodeIds,
    exactAtomicControlNodeId,
    narrowerExactControlOwner,
    controlContextPriority,
    createObservationControlRegistry
  });
}
