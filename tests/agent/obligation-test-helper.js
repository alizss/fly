const {
  compileCurrentObligation: compileProductionCurrentObligation
} = require("../../apps/web/agent/authority-frames");
const { compileDesiredStateDeltas } = require("../../apps/web/agent/desired-state-delta");

// Test-only provenance for historical goal-shaped fixtures. Production
// CurrentObligation intentionally carries no compatibility payload.
const legacyWorkByObligation = new WeakMap();

function admittedControlIds(work = {}) {
  const explicit = [...(work.actionableControlIds || []), ...(work.candidateControlIds || [])].filter(Boolean);
  if (explicit.length) return [...new Set(explicit)];
  if (work.policyChoiceBounded === true) return [...new Set((work.policyAllowedControlIds || []).filter(Boolean))];
  if (work.kind === "profile_field") {
    return [...new Set([
      work.controlId,
      work.componentBinding?.controlId,
      ...(work.componentBinding?.representationControlIds || []),
      ...(work.componentBinding?.stateControlIds || [])
    ].filter(Boolean))];
  }
  return [...new Set((work.eligibleAlternativeControlIds || []).filter(Boolean))];
}

function compileCurrentObligation({ work = null, decisionFrame = null } = {}) {
  if (!work) return null;
  const [desiredStateDelta = null] = work.desiredStateDelta
    ? [work.desiredStateDelta]
    : compileDesiredStateDeltas({ work, admittedControlIds: admittedControlIds(work) });
  const obligation = compileProductionCurrentObligation({
    work: desiredStateDelta ? { ...work, desiredStateDelta } : work,
    decisionFrame
  });
  if (obligation) legacyWorkByObligation.set(obligation, work);
  return obligation;
}

function legacyWorkForObligation(obligation) {
  return obligation && typeof obligation === "object"
    ? legacyWorkByObligation.get(obligation) || null
    : null;
}

module.exports = { compileCurrentObligation, legacyWorkForObligation };
