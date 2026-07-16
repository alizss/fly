function cleanId(value = "") {
  return String(value || "").trim();
}

function aliasRecordsForControl(control = {}) {
  const operationRecords = Object.entries(control.operations || {}).flatMap(([operation, capability]) =>
    (capability?.actuatorIds || []).map((aliasId) => ({ aliasId, kind: `operation:${operation}` }))
  );
  const records = [
    { aliasId: control.controlId, kind: "control" },
    { aliasId: control.stateElementId, kind: "state" },
    { aliasId: control.preferredActivationElementId, kind: "activation" },
    { aliasId: control.visualRef, kind: "visual" },
    ...(control.actuators || []).map((actuator) => ({
      aliasId: actuator?.nodeId,
      kind: actuator?.relation || "actuator"
    })),
    ...operationRecords
  ];
  return records
    .map((record) => ({ ...record, aliasId: cleanId(record.aliasId) }))
    .filter((record, index, list) => record.aliasId
      && list.findIndex((item) => item.aliasId === record.aliasId) === index);
}

function buildControlAliasIndex(page = {}) {
  const byControlId = new Map();
  const byAlias = new Map();
  const aliasKinds = new Map();
  const aliasesByControlId = new Map();
  const ambiguousAliases = new Set();
  const conflicts = [];

  for (const control of page.controls || []) {
    const controlId = cleanId(control?.controlId);
    if (!controlId) continue;
    if (byControlId.has(controlId) && byControlId.get(controlId) !== control) {
      conflicts.push({ aliasId: controlId, controlIds: [controlId], code: "DUPLICATE_CONTROL_ID" });
      ambiguousAliases.add(controlId);
      byAlias.delete(controlId);
      continue;
    }
    byControlId.set(controlId, control);
  }

  const register = (aliasIdValue, controlIdValue, kind = "alias", source = "control") => {
    const aliasId = cleanId(aliasIdValue);
    const controlId = cleanId(controlIdValue);
    if (!aliasId || !controlId) return;
    if (!byControlId.has(controlId)) {
      conflicts.push({ aliasId, controlIds: [controlId], code: "UNKNOWN_CONTROL_ID", source });
      ambiguousAliases.add(aliasId);
      byAlias.delete(aliasId);
      return;
    }
    if (ambiguousAliases.has(aliasId)) return;
    const owner = byAlias.get(aliasId);
    if (owner && owner !== controlId) {
      conflicts.push({ aliasId, controlIds: [owner, controlId].sort(), code: "ALIAS_OWNERSHIP_CONFLICT", source });
      ambiguousAliases.add(aliasId);
      byAlias.delete(aliasId);
      aliasKinds.delete(aliasId);
      aliasesByControlId.get(owner)?.delete(aliasId);
      return;
    }
    byAlias.set(aliasId, controlId);
    aliasKinds.set(aliasId, kind || "alias");
    if (!aliasesByControlId.has(controlId)) aliasesByControlId.set(controlId, new Set());
    aliasesByControlId.get(controlId).add(aliasId);
  };

  for (const control of byControlId.values()) {
    for (const record of aliasRecordsForControl(control)) {
      register(record.aliasId, control.controlId, record.kind, "control");
    }
  }

  for (const annotation of page.screenshotAnnotations || []) {
    const controlId = cleanId(annotation?.controlId);
    if (!controlId) continue;
    register(annotation.visualRef, controlId, "visual", "screenshot_annotation");
    register(annotation.targetId, controlId, "annotation_target", "screenshot_annotation");
  }

  for (const group of page.decisionGroups || []) {
    for (const alternative of group?.alternatives || []) {
      const controlId = cleanId(alternative?.controlId);
      if (!controlId) continue;
      register(alternative.targetId, controlId, "decision_target", "decision_group");
      register(alternative.visualRef, controlId, "visual", "decision_group");
    }
  }

  for (const entry of page.controlAliases || []) {
    register(entry?.aliasId, entry?.controlId, entry?.kind || "serialized_alias", "observation_alias_index");
  }

  const entries = [...byAlias.entries()]
    .map(([aliasId, controlId]) => ({ aliasId, controlId, kind: aliasKinds.get(aliasId) || "alias" }))
    .sort((a, b) => a.aliasId.localeCompare(b.aliasId));

  return {
    byAlias,
    byControlId,
    aliasesByControlId,
    ambiguousAliases,
    conflicts,
    entries,
    resolve(aliasIdValue) {
      const aliasId = cleanId(aliasIdValue);
      if (!aliasId || ambiguousAliases.has(aliasId)) return null;
      const controlId = byAlias.get(aliasId);
      return controlId ? byControlId.get(controlId) || null : null;
    }
  };
}

function actionTargetAliases(action = {}) {
  const target = action.targetSnapshot || {};
  return [
    action.controlId,
    action.targetId,
    action.visualRef,
    target.controlId,
    target.id,
    target.visualRef,
    target.stateElementId,
    target.preferredActivationElementId,
    ...(target.actuators || []).map((actuator) => actuator?.nodeId),
    ...Object.values(target.operations || {}).flatMap((capability) => capability?.actuatorIds || [])
  ].map(cleanId).filter((aliasId, index, list) => aliasId && list.indexOf(aliasId) === index);
}

function resolveActionControl(action = {}, page = {}) {
  const index = buildControlAliasIndex(page);
  const aliasIds = actionTargetAliases(action);
  if (!aliasIds.length) return { ok: false, code: "CANONICAL_ALIAS_REQUIRED", control: null, aliasIds, index };

  const unresolved = aliasIds.filter((aliasId) => !index.resolve(aliasId));
  if (unresolved.length) {
    return { ok: false, code: "CANONICAL_ALIAS_UNRESOLVED", control: null, aliasIds, unresolved, index };
  }

  const controls = aliasIds.map((aliasId) => index.resolve(aliasId));
  const controlIds = [...new Set(controls.map((control) => control?.controlId).filter(Boolean))];
  if (controlIds.length !== 1) {
    return { ok: false, code: "CANONICAL_ALIAS_CONFLICT", control: null, aliasIds, controlIds, index };
  }
  return { ok: true, code: "CANONICAL_ALIAS_RESOLVED", control: controls[0], aliasIds, controlIds, index };
}

module.exports = {
  actionTargetAliases,
  aliasRecordsForControl,
  buildControlAliasIndex,
  resolveActionControl
};
