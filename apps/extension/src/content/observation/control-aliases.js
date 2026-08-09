export function canonicalAliasRecords(control = {}) {
  const operationAliases = Object.entries(control.operations || {}).flatMap(([operation, capability]) =>
    (capability?.actuatorIds || []).map((aliasId) => ({ aliasId, kind: `operation:${operation}` }))
  );
  const recoveryAliases = Object.entries(control.recovery || {}).flatMap(([operation, recovery]) =>
    [
      ...(recovery?.actuatorIds || []),
      ...(recovery?.strategies || []).map((strategy) => strategy.actuatorId)
    ].map((aliasId) => ({ aliasId, kind: `recovery:${operation}` }))
  );
  return [
    { aliasId: control.controlId, kind: "control" },
    { aliasId: control.stableKey, kind: "stable_key" },
    { aliasId: control.stateElementId, kind: "state" },
    { aliasId: control.preferredActivationElementId, kind: "activation" },
    { aliasId: control.visualRef, kind: "visual" },
    ...(control.actuators || []).map((actuator) => ({
      aliasId: actuator?.nodeId,
      kind: actuator?.relation || "actuator"
    })),
    ...operationAliases,
    ...recoveryAliases
  ]
    .map((entry) => ({ ...entry, aliasId: String(entry.aliasId || "").trim() }))
    .filter((entry, index, list) => entry.aliasId
      && list.findIndex((item) => item.aliasId === entry.aliasId) === index);
}

export function buildCanonicalAliasIndex(map = {}) {
  const byControlId = new Map();
  const byAlias = new Map();
  const aliasKinds = new Map();
  const ambiguousAliases = new Set();
  const conflicts = [];

  for (const control of map.controls || []) {
    const controlId = String(control?.controlId || "").trim();
    if (!controlId) continue;
    if (byControlId.has(controlId) && byControlId.get(controlId) !== control) {
      conflicts.push({ code: "DUPLICATE_CONTROL_ID", aliasId: controlId, controlIds: [controlId] });
      ambiguousAliases.add(controlId);
      byAlias.delete(controlId);
      continue;
    }
    byControlId.set(controlId, control);
  }

  const register = (aliasValue, controlValue, kind = "alias", source = "control") => {
    const aliasId = String(aliasValue || "").trim();
    const controlId = String(controlValue || "").trim();
    if (!aliasId || !controlId) return;
    if (!byControlId.has(controlId)) {
      conflicts.push({ code: "UNKNOWN_CONTROL_ID", aliasId, controlIds: [controlId], source });
      ambiguousAliases.add(aliasId);
      byAlias.delete(aliasId);
      return;
    }
    if (ambiguousAliases.has(aliasId)) return;
    const owner = byAlias.get(aliasId);
    if (owner && owner !== controlId) {
      conflicts.push({ code: "ALIAS_OWNERSHIP_CONFLICT", aliasId, controlIds: [owner, controlId].sort(), source });
      ambiguousAliases.add(aliasId);
      byAlias.delete(aliasId);
      aliasKinds.delete(aliasId);
      return;
    }
    byAlias.set(aliasId, controlId);
    aliasKinds.set(aliasId, kind || "alias");
  };

  for (const control of byControlId.values()) {
    canonicalAliasRecords(control).forEach((entry) => register(entry.aliasId, control.controlId, entry.kind));
  }
  for (const annotation of map.screenshotAnnotations || []) {
    if (!annotation?.controlId) continue;
    register(annotation.visualRef, annotation.controlId, "visual", "screenshot_annotation");
    register(annotation.targetId, annotation.controlId, "annotation_target", "screenshot_annotation");
  }
  for (const group of map.decisionGroups || []) {
    for (const alternative of group?.alternatives || []) {
      if (!alternative?.controlId) continue;
      register(alternative.targetId, alternative.controlId, "decision_target", "decision_group");
      register(alternative.visualRef, alternative.controlId, "visual", "decision_group");
    }
  }

  const entries = [...byAlias.entries()]
    .map(([aliasId, controlId]) => ({ aliasId, controlId, kind: aliasKinds.get(aliasId) || "alias" }))
    .sort((a, b) => a.aliasId.localeCompare(b.aliasId));
  return {
    byAlias,
    byControlId,
    aliasKinds,
    ambiguousAliases,
    conflicts,
    entries,
    resolve(aliasValue) {
      const aliasId = String(aliasValue || "").trim();
      if (!aliasId || ambiguousAliases.has(aliasId)) return null;
      const controlId = byAlias.get(aliasId);
      return controlId ? byControlId.get(controlId) || null : null;
    }
  };
}

export function decisionTargetAliasIds(decision = {}) {
  const target = decision.targetSnapshot || {};
  return [
    decision.controlId,
    decision.stableKey,
    decision.targetId,
    decision.visualRef,
    target.controlId,
    target.stableKey,
    target.id,
    target.visualRef,
    target.stateElementId,
    target.preferredActivationElementId,
    ...(target.actuators || []).map((actuator) => actuator?.nodeId),
    ...Object.values(target.operations || {}).flatMap((capability) => capability?.actuatorIds || []),
    ...Object.values(target.recovery || {}).flatMap((recovery) => [
      ...(recovery?.actuatorIds || []),
      ...(recovery?.strategies || []).map((strategy) => strategy.actuatorId)
    ])
  ]
    .map((aliasId) => String(aliasId || "").trim())
    .filter((aliasId, index, list) => aliasId && list.indexOf(aliasId) === index);
}
