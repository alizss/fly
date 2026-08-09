function clean(value = "", limit = 900) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function token(value = "", fallback = "global", limit = 120) {
  const normalized = clean(value, 600)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return (normalized || fallback).slice(0, limit);
}

function hash(value = "") {
  const text = clean(value, 1_800);
  let result = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    result ^= text.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0).toString(36);
}

function normalizeSemanticOwner(raw = {}, fallback = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const defaults = fallback && typeof fallback === "object" ? fallback : {};
  return Object.freeze({
    stage: clean(source.stage || defaults.stage, 120),
    family: clean(source.family || defaults.family, 120),
    subjectId: clean(source.subjectId || defaults.subjectId || "global", 160),
    passengerId: clean(source.passengerId || defaults.passengerId, 160),
    segmentId: clean(source.segmentId || defaults.segmentId, 160),
    repeatedInstance: clean(source.repeatedInstance || defaults.repeatedInstance, 900)
  });
}

function semanticOwnerId(raw = {}, fallback = {}) {
  const owner = normalizeSemanticOwner(raw, fallback);
  return [
    "owner",
    token(owner.stage, "unknown", 40),
    token(owner.family, "unknown", 40),
    token(owner.subjectId, "global", 64),
    token(owner.passengerId, "global", 48),
    token(owner.segmentId, "global", 48),
    hash(owner.repeatedInstance || "global")
  ].join(":");
}

function semanticOwnerFromLegacy(source = {}, fallback = {}) {
  const raw = source && typeof source === "object" ? source : {};
  return normalizeSemanticOwner(raw.semanticOwner, {
    stage: raw.stage || fallback.stage,
    family: raw.family || raw.subjectFamily || fallback.family,
    subjectId: raw.subjectId || fallback.subjectId || "global",
    passengerId: raw.passengerId || raw.travelerId || fallback.passengerId,
    segmentId: raw.segmentId || fallback.segmentId,
    repeatedInstance: raw.semanticOwnerId
      || raw.decisionInstanceId
      || raw.canonicalOwnerId
      || raw.decisionOwnerKey
      || raw.requirementId
      || raw.decisionGroupId
      || fallback.repeatedInstance
  });
}

module.exports = {
  normalizeSemanticOwner,
  semanticOwnerFromLegacy,
  semanticOwnerId
};
