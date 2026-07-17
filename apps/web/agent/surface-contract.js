const PAGE_SURFACE_ID = "surface-page";

function clean(value = "") {
  return String(value || "").trim();
}

function normalizeSurface(surface = {}, observationId = "") {
  const type = clean(surface.type || "page").toLowerCase() || "page";
  const isPage = type === "page";
  return {
    id: isPage ? PAGE_SURFACE_ID : clean(surface.id || surface.surfaceId),
    type,
    label: clean(surface.label || surface.accessibleName || (isPage ? "Page" : "")),
    role: clean(surface.role),
    blocksBackground: isPage ? false : surface.blocksBackground !== false,
    ownership: isPage ? "page" : "exclusive",
    decisionGroupId: clean(surface.decisionGroupId),
    parentSurfaceId: clean(surface.parentSurfaceId),
    memberControlIds: [...new Set((surface.memberControlIds || surface.controlIds || []).map(clean).filter(Boolean))],
    memberActuatorIds: [...new Set((surface.memberActuatorIds || []).map(clean).filter(Boolean))],
    observationId: clean(surface.observationId || observationId)
  };
}

function canonicalizePageSurface(page = {}) {
  const currentSurface = normalizeSurface(page.currentSurface || page.activeSurface || {});
  const normalized = { ...page, currentSurface };
  delete normalized.activeSurface;
  return normalized;
}

function currentSurface(page = {}) {
  return normalizeSurface(page.currentSurface || {});
}

function currentSurfaceId(page = {}) {
  return currentSurface(page).id;
}

function surfaceBinding(observation = {}) {
  const page = observation.page || {};
  return {
    observationId: clean(observation.observationId),
    observationHash: clean(observation.observationSnapshot?.snapshotHash || page.snapshotHash),
    surfaceId: currentSurfaceId(page),
    surfaceType: currentSurface(page).type
  };
}

function controlSurfaceId(control = {}, page = {}) {
  const explicit = clean(control.surfaceId);
  if (explicit) return explicit;
  return currentSurface(page).type === "page" ? PAGE_SURFACE_ID : "";
}

function controlBelongsToCurrentSurface(control = {}, page = {}) {
  const surface = currentSurface(page);
  const aliases = new Set([
    control.stateElementId,
    control.preferredActivationElementId,
    ...(control.actuators || []).map((actuator) => actuator?.nodeId),
    ...Object.values(control.operations || {}).flatMap((capability) => capability?.actuatorIds || [])
  ].map(clean).filter(Boolean));
  const explicitMembership = surface.memberControlIds.includes(clean(control.controlId))
    || surface.memberActuatorIds.some((id) => aliases.has(id));
  return explicitMembership || controlSurfaceId(control, page) === surface.id;
}

function sameSurface(left = {}, right = {}) {
  return normalizeSurface(left).id === normalizeSurface(right).id;
}

module.exports = {
  PAGE_SURFACE_ID,
  canonicalizePageSurface,
  controlBelongsToCurrentSurface,
  controlSurfaceId,
  currentSurface,
  currentSurfaceId,
  normalizeSurface,
  sameSurface,
  surfaceBinding
};
