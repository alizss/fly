const { canonicalDecisionOwnerKey } = require("../transaction-facts");
const { actionPostconditions } = require("./action-result");
const {
  normalizeSemanticOwner,
  semanticOwnerFromLegacy,
  semanticOwnerId
} = require("../../../../packages/shared/semantic-owner");

const DECISION_EPISODE_FAMILIES = new Set(["fare", "baggage", "seat", "insurance", "extras"]);

function clean(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function lower(value = "") {
  return clean(value).toLowerCase();
}

function createCommerceLedger({
  actionDecisionLineage,
  episodeFamilyForDecision,
  semanticIdentity,
  taskMechanics,
  verifiedActionSucceeded,
  verifiedEpisodeAction
}) {
  function verifiedCommercePostcondition(result = null) {
    return actionPostconditions(result).find((postcondition) => (
      postcondition.type === "exact_free_option_selected"
      || postcondition.type === "exact_paid_option_selected"
    )) || null;
  }
  
  function isVerifiedCommerceAction(result = null) {
    if (!verifiedActionSucceeded(result)) return false;
    const action = result.action || {};
    const effect = clean(
      result.mechanicalEffect
      || action.mechanicalEffect
      || action.affordance?.physicalEffect
      || action.affordance?.effect
    );
    return Boolean(
      verifiedCommercePostcondition(result)
      || ["select_free_option", "select_paid_option"].includes(effect)
    );
  }
  
  // A verified browser result is an immutable receipt.  It must survive even
  // when the next observation rerenders away the decision that produced it.
  // Keep this contract deliberately narrower than general successful actions:
  // profile entry, navigation, opening a selector, waits, and stale results do
  // not create commerce obligations.
  function verifiedCommerceObligationFromActionResult(result = null, observationId = "", context = {}) {
    if (!isVerifiedCommerceAction(result)) return null;
    const action = result.action || {};
    const task = action.affordance?.task || {};
    const postcondition = verifiedCommercePostcondition(result) || {};
    const decisionEpisode = context.decisionEpisode || context.taskState?.decisionEpisode || null;
    const currentGoal = context.currentGoal || taskMechanics(context.taskState || {});
    const lineage = actionDecisionLineage(result, currentGoal, decisionEpisode || {});
    const actionSurfaceId = clean(
      postcondition.surfaceId
      || result.targetSnapshot?.surfaceId
      || action.targetSnapshot?.surfaceId
      || action.surfaceId
      || result.surfaceId
    );
    // A foreground confirmation may have its own transient decision wrapper,
    // while still being the child of one durable parent episode. Reuse the
    // parent identity only when lineage explicitly agrees or the exact current
    // foreground surface is the episode's recorded child. Never aggregate
    // ordinary page siblings merely because they share `surface-page`.
    const episodeOwnsReceipt = Boolean(
      decisionEpisode?.episodeId
      && clean(decisionEpisode.childSurfaceId)
      && clean(decisionEpisode.childSurfaceId) !== "surface-page"
      && actionSurfaceId === clean(decisionEpisode.childSurfaceId)
    );
    const actionId = clean(result.actionId || action.id);
    const decisionGroupId = clean(
      (episodeOwnsReceipt ? decisionEpisode.parentDecisionGroupId : "")
      || postcondition.decisionGroupId
      || task.parentDecisionGroupId
      || task.decisionGroupId
      || action.decisionGroupId
      || result.decisionGroupId
      || action.targetSnapshot?.decisionGroupId
      || result.targetSnapshot?.decisionGroupId
    );
    const semantic = lower(`${task.semanticType || ""} ${action.intent || result.semanticIntent || ""}`);
    const family = clean(episodeOwnsReceipt ? decisionEpisode.family : "") || (/seat/.test(semantic)
      ? "seat"
      : /bag|luggage/.test(semantic)
        ? "baggage"
        : /insurance|protection|cancel/.test(semantic)
          ? "insurance"
          : /fare|ticket/.test(semantic)
            ? "fare"
            : "extras");
    const mechanicalEffect = clean(result.mechanicalEffect || action.mechanicalEffect);
    const paid = postcondition.type === "exact_paid_option_selected" || mechanicalEffect === "select_paid_option";
    const declined = !paid && (
      postcondition.expectedDisposition === "decline_free_no_extra"
      || /declin|without|no thanks|skip|none/.test(lower(
        `${postcondition.expectedSelectedLabel || ""} ${action.targetLabel || ""} ${result.targetLabel || ""}`
      ))
    );
    const legacyDecisionInstanceId = clean(
      (episodeOwnsReceipt ? decisionEpisode.canonicalOwnerId || decisionEpisode.decisionInstanceId : "")
      || task.canonicalOwnerId
      || task.decisionInstanceId
      || action.canonicalOwnerId
      || action.decisionInstanceId
      || result.canonicalOwnerId
      || result.decisionInstanceId
      || decisionGroupId
    );
    if (!actionId || !decisionGroupId) return null;
    const episodeIdentityOwnsReceipt = Boolean(
      episodeOwnsReceipt
      || (
        decisionEpisode?.episodeId
        && clean(lineage.decisionEpisodeId) === clean(decisionEpisode.episodeId)
        && clean(lineage.parentDecisionGroupId || lineage.decisionGroupId) === decisionGroupId
      )
    );
    const targetSnapshot = result.targetSnapshot || action.targetSnapshot || {};
    const semanticOwner = action.semanticOwner
      ? semanticOwnerFromLegacy(action)
      : normalizeSemanticOwner({
          stage: context.taskState?.stage || decisionEpisode?.stage,
          family: episodeIdentityOwnsReceipt ? decisionEpisode?.family : family,
          subjectId: (episodeIdentityOwnsReceipt ? decisionEpisode?.subjectKey : "")
            || task.semanticType
            || task.requirementId
            || family,
          passengerId: task.passengerId || decisionEpisode?.passengerId,
          segmentId: task.segmentId || decisionEpisode?.segmentId,
          repeatedInstance: (episodeIdentityOwnsReceipt
            ? decisionEpisode?.canonicalOwnerId || decisionEpisode?.decisionInstanceId
            : "") || legacyDecisionInstanceId
        });
    const ownerId = clean(
      action.semanticOwnerId
      || result.semanticOwnerId
      || task.semanticOwnerId
      || semanticOwnerId(semanticOwner)
      || legacyDecisionInstanceId
    );
    if (!ownerId) return null;
    return Object.freeze({
      semanticOwner,
      semanticOwnerId: ownerId,
      actionId,
      observationId: clean(observationId || result.observationId),
      decisionGroupId,
      decisionInstanceId: ownerId,
      decisionOwnerKey: ownerId,
      canonicalOwnerId: ownerId,
      decisionEpisodeId: clean(episodeOwnsReceipt ? decisionEpisode.episodeId : lineage.decisionEpisodeId),
      family,
      subjectKey: clean(
        (episodeOwnsReceipt ? decisionEpisode.subjectKey : "")
        || task.semanticType
        || task.requirementId
        || postcondition.requirementId
        || family
      ),
      label: clean(postcondition.expectedSelectedLabel || action.targetLabel || result.targetLabel),
      disposition: paid ? "paid" : declined ? "declined" : "selected",
      outcome: paid ? "paid_affirmative" : declined ? "declined" : "selected",
      priceAmount: paid ? (targetSnapshot.structuredPrice?.amount ?? null) : 0,
      currency: clean(targetSnapshot.structuredPrice?.currency),
      verified: true,
      originKind: "verified_commerce_obligation",
      // Store only the compiled receipt. Reconstructing meaning from a later
      // page is exactly the lossy path this register replaces.
      receipt: Object.freeze({
        mechanicalEffect,
        expectedOutcomeType: clean(postcondition.type),
        expectedDisposition: clean(postcondition.expectedDisposition),
        objective: clean(action.intent || result.semanticIntent)
      })
    });
  }
  
  function verifiedCommerceObligations(previous = [], supplied = []) {
    const byActionId = new Map();
    const add = (entry) => {
      if (!entry?.actionId || entry.verified !== true || entry.originKind !== "verified_commerce_obligation") return;
      byActionId.set(clean(entry.actionId), Object.freeze({ ...entry }));
    };
    for (const entry of Array.isArray(previous) ? previous : []) add(entry);
    for (const entry of Array.isArray(supplied) ? supplied : []) add(entry);
    return Object.freeze([...byActionId.values()].slice(-120));
  }
  
  function commerceOutcomeFromVerifiedObligation(obligation = {}) {
    if (!obligation?.actionId || obligation.verified !== true || obligation.originKind !== "verified_commerce_obligation") return null;
    if (!DECISION_EPISODE_FAMILIES.has(clean(obligation.family))) return null;
    const ownerId = semanticIdentity(obligation);
    return Object.freeze({
      semanticOwner: obligation.semanticOwner || null,
      semanticOwnerId: ownerId,
      decisionGroupId: clean(obligation.decisionGroupId),
      decisionInstanceId: ownerId,
      decisionOwnerKey: ownerId,
      canonicalOwnerId: ownerId,
      originKind: "verified_commerce_decision",
      admissionSource: "verified_action_obligation",
      actionId: clean(obligation.actionId),
      family: clean(obligation.family),
      subjectKey: clean(obligation.subjectKey),
      label: clean(obligation.label),
      disposition: clean(obligation.disposition || "selected"),
      outcome: clean(obligation.outcome || "selected"),
      priceAmount: obligation.priceAmount ?? null,
      currency: clean(obligation.currency),
      segmentOutcomes: Object.freeze([]),
      verified: true,
      observationId: clean(obligation.observationId)
    });
  }
  
  function decisionForVerifiedCommerceAction({
    actionResult = null,
    canonicalDecisions = [],
    previousTaskState = {},
    decisionEpisode = null
  } = {}) {
    const lineage = actionDecisionLineage(
      actionResult,
      taskMechanics(previousTaskState),
      decisionEpisode || previousTaskState.decisionEpisode || {}
    );
    const action = actionResult?.action || {};
    // The action's exact target owner is stronger than a parent/episode hint
    // copied from an earlier planning snapshot. Parent lineage remains useful
    // for true child surfaces, which are aggregated by the episode path before
    // this direct committer is reached.
    const exactActionDecisionGroupId = clean(
      actionResult?.decisionGroupId
      || action.decisionGroupId
      // Browser-result compaction keeps the resolved target separately from
      // the planned action. That exact target is first-class ownership proof,
      // never a reason to fall back to a transient episode.
      || actionResult?.targetSnapshot?.decisionGroupId
      || action.targetSnapshot?.decisionGroupId
    );
    const explicit = lineage.explicitLineage || {};
    const ownerIds = [
      exactActionDecisionGroupId,
      explicit.parentDecisionGroupId,
      explicit.decisionGroupId,
      ...(lineage.explicit ? [] : [lineage.fallbackLineage?.parentDecisionGroupId, lineage.fallbackLineage?.decisionGroupId])
    ].filter(Boolean);
    const decisions = [
      ...(Array.isArray(canonicalDecisions) ? canonicalDecisions : []),
      ...(Array.isArray(previousTaskState.verificationDecisionMemory)
        ? previousTaskState.verificationDecisionMemory
        : Array.isArray(previousTaskState.canonicalDecisions)
          ? previousTaskState.canonicalDecisions
          : [])
    ];
    return decisions.find((decision) => ownerIds.includes(clean(decision.decisionGroupId))) || null;
  }
  
  function commerceOutcomeFromVerifiedAction({
    actionResult = null,
    canonicalDecisions = [],
    previousTaskState = {},
    decisionEpisode = null,
    observationId = ""
  } = {}) {
    if (!isVerifiedCommerceAction(actionResult)) return null;
    const postcondition = verifiedCommercePostcondition(actionResult);
    const lineage = actionDecisionLineage(
      actionResult,
      taskMechanics(previousTaskState),
      decisionEpisode || previousTaskState.decisionEpisode || {}
    );
    const decision = decisionForVerifiedCommerceAction({
      actionResult,
      canonicalDecisions,
      previousTaskState,
      decisionEpisode
    });
    const family = episodeFamilyForDecision(decision)
      || clean(decisionEpisode?.family || previousTaskState.decisionEpisode?.family);
    // A verified choice is consequential only when its exact canonical owner
    // is a commerce decision. This keeps profile fields, navigation, and
    // optional marketing controls out of the transaction journal.
    if (!DECISION_EPISODE_FAMILIES.has(family)) return null;
    const explicit = lineage.explicitLineage || {};
    const exactActionDecisionGroupId = clean(
      actionResult?.decisionGroupId
      || actionResult?.action?.decisionGroupId
      || actionResult?.action?.targetSnapshot?.decisionGroupId
    );
    const decisionGroupId = clean(
      decision?.decisionGroupId
      || exactActionDecisionGroupId
      || explicit.parentDecisionGroupId
      || explicit.decisionGroupId
      || (!lineage.explicit ? lineage.fallbackLineage?.parentDecisionGroupId : "")
      || (!lineage.explicit ? lineage.fallbackLineage?.decisionGroupId : "")
    );
    const legacyDecisionInstanceId = clean(
      explicit.decisionInstanceId
      || decision?.canonicalOwnerId
      || decisionGroupId
    );
    if (!decisionGroupId) return null;
    const action = actionResult.action || {};
    const targetSnapshot = actionResult.targetSnapshot || {};
    const effect = clean(
      actionResult.mechanicalEffect
      || action.mechanicalEffect
      || action.affordance?.physicalEffect
      || action.affordance?.effect
    );
    const paid = postcondition?.type === "exact_paid_option_selected"
      || effect === "select_paid_option"
      || decision?.commitmentPhase === "committed_paid"
      || decision?.currentOutcome === "paid_affirmative";
    const declined = !paid && (
      postcondition?.expectedDisposition === "decline_free_no_extra"
      || /declin|without|no thanks|skip|random/.test(lower(
        `${postcondition?.expectedSelectedLabel || ""} ${action.targetLabel || ""} ${decision?.selectedLabel || ""}`
      ))
    );
    const price = targetSnapshot.structuredPrice
      || decision?.priceRisk
      || {};
    const subjectKey = clean(
      decision?.subject?.key
      || decision?.requirementId
      || explicit.requirementId
      || (!lineage.explicit ? lineage.fallbackLineage?.requirementId : "")
      || family
    );
    const semanticOwner = action.semanticOwner
      ? semanticOwnerFromLegacy(action)
      : normalizeSemanticOwner({
          stage: previousTaskState.stage,
          family,
          subjectId: subjectKey,
          passengerId: decision?.subject?.passengerId || explicit.passengerId,
          segmentId: decision?.subject?.segmentId || explicit.segmentId,
          repeatedInstance: legacyDecisionInstanceId
        });
    const ownerId = clean(
      action.semanticOwnerId
      || actionResult.semanticOwnerId
      || semanticOwnerId(semanticOwner)
      || legacyDecisionInstanceId
    );
    if (!ownerId) return null;
    return Object.freeze({
      semanticOwner,
      semanticOwnerId: ownerId,
      decisionGroupId,
      decisionInstanceId: ownerId,
      decisionOwnerKey: ownerId,
      canonicalOwnerId: ownerId,
      originKind: "verified_commerce_decision",
      admissionSource: "verified_action_contract",
      actionId: clean(actionResult.actionId || action.id),
      family,
      subjectKey,
      label: clean(
        postcondition?.expectedSelectedLabel
        || decision?.selectedLabel
        || action.targetLabel
        || actionResult.targetLabel
      ),
      disposition: paid ? "paid" : declined ? "declined" : "selected",
      outcome: paid ? "paid_affirmative" : family === "seat" && declined ? "random_assignment" : declined ? "declined" : "selected",
      priceAmount: paid ? (price.amount ?? null) : 0,
      currency: clean(price.currency || decision?.priceRisk?.currency),
      segmentOutcomes: Object.freeze([]),
      verified: true,
      observationId: clean(observationId)
    });
  }
  
  function mergeVerifiedCommerceOutcome(previous = {}, next = {}) {
    const segmentOutcomes = [...(previous.segmentOutcomes || []), ...(next.segmentOutcomes || [])];
    const mergedSegments = [...new Map(segmentOutcomes
      .filter((entry) => entry?.segmentKey)
      .map((entry) => [clean(entry.segmentKey), entry])).values()];
    const prefersNext = next.outcome === "random_assignment"
      || next.disposition === "paid"
      || !previous.outcome;
    return Object.freeze({
      ...previous,
      ...next,
      label: clean(next.label || previous.label),
      disposition: prefersNext ? next.disposition : previous.disposition,
      outcome: prefersNext ? next.outcome : previous.outcome,
      priceAmount: next.priceAmount ?? previous.priceAmount ?? null,
      currency: clean(next.currency || previous.currency),
      segmentOutcomes: Object.freeze(mergedSegments),
      verified: previous.verified === true || next.verified === true,
      observationId: clean(next.observationId || previous.observationId)
    });
  }
  
  function admittedVerifiedCommerceOutcomes({
    actionResult = null,
    canonicalDecisions = [],
    previousTaskState = {},
    decisionEpisode = null,
    observationId = ""
  } = {}) {
    const outcomes = [];
    const terminal = decisionEpisode?.terminalOutcome;
    const episodeOwnsResult = verifiedEpisodeAction(actionResult, decisionEpisode);
    const episodeHasUnfinishedChild = Boolean(
      episodeOwnsResult
      && clean(decisionEpisode?.childSurfaceId)
      && ["active", "awaiting_child_confirmation"].includes(decisionEpisode?.status)
    );
    const terminalEpisodeAdmitted = Boolean(
      ["completed", "completed_pending_surface_exit"].includes(decisionEpisode?.status)
      && decisionEpisode.outcomeVerified === true
      && terminal?.verified === true
      && terminal.originKind === "verified_commerce_decision"
      && terminal.decisionInstanceId
      && episodeOwnsResult
    );
    // A direct verified action is the durable fallback for ordinary choices.
    // A proven episode supersedes it only when it is still resolving a real
    // child confirmation or has already emitted the richer terminal aggregate.
    if (!episodeHasUnfinishedChild && !terminalEpisodeAdmitted) {
      const direct = commerceOutcomeFromVerifiedAction({
        actionResult,
        canonicalDecisions,
        previousTaskState,
        decisionEpisode,
        observationId
      });
      if (direct) outcomes.push(direct);
    }
    if (terminalEpisodeAdmitted) {
      outcomes.push(Object.freeze({
        ...terminal,
        admissionSource: "decision_episode_aggregation",
        observationId: clean(observationId || decisionEpisode.observationId)
      }));
    }
    return Object.freeze([...new Map(outcomes
      .map((outcome) => [semanticIdentity(outcome), outcome])
      .filter(([ownerId]) => Boolean(ownerId))).values()]);
  }
  
  function verifiedOutcomeJournal(previousJournal = [], admittedOutcomes = []) {
    const journal = new Map();
    const actionOwners = new Map();
    const identityRank = (entry = {}) => entry.admissionSource === "decision_episode_aggregation"
      ? 3
      : entry.admissionSource === "verified_action_obligation"
        ? 2
        : 1;
    const add = (outcome = {}) => {
      const ownerId = semanticIdentity(outcome);
      if (!ownerId || outcome?.verified !== true) return;
      const actionId = clean(outcome.actionId);
      const existingActionOwner = actionId ? actionOwners.get(actionId) : "";
      const existingOwner = existingActionOwner || ownerId;
      const existing = journal.get(existingOwner);
      if (!existing) {
        journal.set(ownerId, outcome);
        if (actionId) actionOwners.set(actionId, ownerId);
        return;
      }
      // A receipt and the direct action committer can observe the same physical
      // action through different transient wrappers. Merge them once by action
      // ID, retaining the richer canonical receipt/episode identity.
      const identity = identityRank(outcome) > identityRank(existing) ? outcome : existing;
      const targetOwner = semanticIdentity(identity) || existingOwner;
      const merged = mergeVerifiedCommerceOutcome(existing, outcome);
      const canonical = Object.freeze({
        ...merged,
        semanticOwner: identity.semanticOwner || merged.semanticOwner || null,
        semanticOwnerId: targetOwner,
        decisionGroupId: clean(identity.decisionGroupId || merged.decisionGroupId),
        decisionInstanceId: targetOwner,
        decisionOwnerKey: targetOwner,
        canonicalOwnerId: targetOwner,
        admissionSource: clean(identity.admissionSource || merged.admissionSource),
        actionId: clean(identity.actionId || merged.actionId)
      });
      if (existingOwner !== targetOwner) journal.delete(existingOwner);
      journal.set(targetOwner, canonical);
      if (actionId) actionOwners.set(actionId, targetOwner);
    };
    for (const entry of Array.isArray(previousJournal) ? previousJournal : []) add(entry);
    for (const outcome of admittedOutcomes) {
      add(outcome);
    }
    return Object.freeze([...journal.values()].slice(-80));
  }
  
  function verifiedOutcomeCoverage(
    obligations = [],
    journal = [],
    transactionOutcomeLedger = []
  ) {
    const coverageId = (entry = "") => canonicalDecisionOwnerKey(
      typeof entry === "object"
        ? {
            semanticOwnerId: semanticIdentity(entry),
            decisionOwnerKey: entry?.decisionOwnerKey,
            decisionInstanceId: entry?.decisionInstanceId,
            ownerKey: entry?.canonicalOwnerId
          }
        : { semanticOwnerId: entry }
    );
    // The durable receipt register is the sole expectation authority. Rebuild
    // coverage from it every turn rather than copying a second memory or
    // allowing journal/direct outcomes to invent expected identities.
    const expected = new Set();
    const expectedActionIds = new Set();
    // The receipt register, not the journal, establishes what must be
    // reconciled. A journal admission can be delayed or lost during a rerender;
    // the verified browser action cannot be allowed to disappear with it.
    for (const obligation of obligations) {
      if (obligation?.verified !== true || obligation?.originKind !== "verified_commerce_obligation") continue;
      expected.add(semanticIdentity(obligation));
      expectedActionIds.add(clean(obligation.actionId));
    }
    const journaledDecisionInstanceIds = (Array.isArray(journal) ? journal : [])
      .filter((entry) => entry?.verified === true && entry?.originKind === "verified_commerce_decision")
      .map((entry) => semanticIdentity(entry))
      .filter(Boolean);
    const journaled = new Set((Array.isArray(journal) ? journal : [])
      .filter((entry) => entry?.verified === true && entry?.originKind === "verified_commerce_decision")
      .map(coverageId)
      .filter(Boolean));
    const expectedDecisionInstanceIds = [...expected].slice(-80);
    const reportedJournaledDecisionInstanceIds = journaledDecisionInstanceIds.slice(-80);
    const ledgerEntries = (Array.isArray(transactionOutcomeLedger) ? transactionOutcomeLedger : []);
    const ledgered = new Set(ledgerEntries
      .map(coverageId)
      .filter(Boolean));
    const ledgeredDecisionInstanceIds = ledgerEntries
      .map((entry) => semanticIdentity(entry))
      .filter(Boolean)
      .slice(-80);
    const missingJournalDecisionInstanceIds = expectedDecisionInstanceIds.filter((id) => !journaled.has(coverageId(id)));
    const missingLedgerDecisionInstanceIds = expectedDecisionInstanceIds.filter((id) => !ledgered.has(coverageId(id)));
    const missingDecisionInstanceIds = [...new Set([
      ...missingJournalDecisionInstanceIds,
      ...missingLedgerDecisionInstanceIds
    ])];
    const missingActionIds = [...expectedActionIds].filter((actionId) => {
      const obligation = (Array.isArray(obligations) ? obligations : []).find((entry) => clean(entry?.actionId) === actionId);
      const ownerId = semanticIdentity(obligation);
      return !ownerId || !journaled.has(coverageId(ownerId)) || !ledgered.has(coverageId(ownerId));
    });
    return Object.freeze({
      expectedDecisionInstanceIds: Object.freeze(expectedDecisionInstanceIds),
      journaledDecisionInstanceIds: Object.freeze(reportedJournaledDecisionInstanceIds),
      ledgeredDecisionInstanceIds: Object.freeze(ledgeredDecisionInstanceIds),
      missingJournalDecisionInstanceIds: Object.freeze(missingJournalDecisionInstanceIds),
      missingLedgerDecisionInstanceIds: Object.freeze(missingLedgerDecisionInstanceIds),
      missingDecisionInstanceIds: Object.freeze(missingDecisionInstanceIds),
      expectedActionIds: Object.freeze([...expectedActionIds].slice(-120)),
      missingActionIds: Object.freeze(missingActionIds),
      complete: missingDecisionInstanceIds.length === 0 && missingActionIds.length === 0
    });
  }

  return {
    admittedVerifiedCommerceOutcomes,
    commerceOutcomeFromVerifiedObligation,
    verifiedCommerceObligations,
    verifiedCommerceObligationFromActionResult,
    verifiedOutcomeCoverage,
    verifiedOutcomeJournal
  };
}

module.exports = { createCommerceLedger };
