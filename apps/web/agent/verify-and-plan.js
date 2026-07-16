// Combines the old separate verifier.js + planner.js into one call: "given
// what just happened, is it actually done, and what's next" is one judgment,
// not two independent LLM round-trips. Cuts the loop from 3 sequential
// OpenAI calls per turn to 2 (this + the requirement extractor), which was
// the single biggest cause of the loop feeling slow in practice.
//
// Nothing here is written against any specific site's markup or wording —
// same discipline as the rest of the loop: it must hold up on a checkout
// flow this has never seen, not just the ones it's been tested against.

const { callStructured } = require("./openai-client");
const { verifyAndPlanSchema } = require("./schemas");
const { normalizeAction } = require("../../../packages/shared/agent-actions");
const { latestPrice } = require("../../../packages/shared/agent-state");

const INSTRUCTIONS = [
  "You are the verification + planning brain for a flight checkout copilot, working on a page you may never have seen the exact layout of before. Do not assume anything about this being any particular airline or booking site — reason only from what is actually visible right now.",
  "Return two things in one response: `verification` (did the last action actually work, what changed) and `action` (exactly one next step).",
  "PART 1 — verification:",
  "You are given the previous requirements list, the action just taken, and the freshly re-extracted current requirements/screenshot.",
  "changed=true only if something observably changed (a field now has a value it didn't before, a requirement's status flipped, the URL/step changed, a dropdown opened or closed). Do not assume an action worked just because it was dispatched without error.",
  "lastActionWorked judges whether the last action achieved what its own stated reason claimed it would.",
  "If the last action was a repeat of 'click Continue' (or similar) and the step/URL/fields did not change, that is NOT ok — list it as a blocker.",
  "priceChanged=true only if a total/price figure differs from the previous one given to you. riskChanged=true if something newly visible is money/payment/legal risk that wasn't flagged before.",
  "Only requirementUpdates can propose a requirement state change. A requirement update must reference the current observationId when available, identify concrete visible/current evidence, and only propose satisfied when the current page no longer shows that requirement as unresolved.",
  "If currentRequirements says a requirement is missing/needs_user/unknown, do not also mark it satisfied unless the screenshot/current page clearly proves the extracted requirement is stale. When unsure, leave it unresolved.",
  "PART 2 — action, informed by part 1:",
  "You are also given `pageState`, a typed classifier output. Treat it as the primary map of the page: requiredFields/requiredChoices are prerequisites, optionalPaidExtras are decline/skip candidates, navigationActions are buttons like Continue/Next/Close/Skip, and riskGates require approval.",
  "The page payload may include `foreground`, `visualState`, and `accessibility`. Use accessibility role/name/state plus visible boxes to identify controls. If foreground.active is true, that foreground surface owns the next action until its fingerprint/progress marker changes or closes.",
  "The page payload may include `decisionGroups`. Treat each decision group as one logical requirement. If a group has status='satisfied' with selectedControlId/selectedLabel, do not try to choose another unselected alternative in that same group. Unselected paid alternatives are not blockers by themselves.",
  "When resolving a missing choice, choose a control from the same unresolved decisionGroupId. Do not use evidence or controls from one group (for example flexible ticket) to satisfy another group (for example baggage).",
  "If the same modal remains open but `foreground.progressMarkers` changes (for example Flight 1 of 2 becomes Flight 2 of 2), treat that as progress from the previous action, not as a no-op.",
  "Never treat navigationActions as missing requirements. If all requiredFields and requiredChoices are satisfied and no blocking riskGate is present, choose the best enabled navigationAction.",
  "If a Continue/Next navigationAction is visible and enabled, and the only remaining issue is passive disclaimer text with no checkbox/control, click the navigationAction with risk='safe'.",
  "Prefer satisfying missing required=true requirements with confidence>=0.7 that are risk='safe' first. If several plain traveler/contact text fields are empty at once, use type='fill_visible_profile_fields' to fill all visible profile-mappable fields in one browser-side pass instead of one at a time.",
  "If the current page has an activeSurface whose type is modal/dropdown/popover, plan only within that active surface until it closes or changes. Choose a canonical controlId/targetId or screenshot visualRef from the current observation. Use click_xy only for a genuinely visual canvas/SVG control with current coordinates.",
  "If an active modal says seats were not selected / you have not selected a seat and offers Continue versus Choose seat, and the profile/intent says no specific seats or no extras, choose Continue with risk='safe'. That is declining optional seat selection; Choose seat is the upsell path.",
  "For seat maps, seat-selection popups, baggage popups, bundles, insurance, or other paid extras where the profile/intent says no extras/no specific seats, click the observed canonical safe option such as Next/Continue/Close/No thanks/Without/Skip. Do not choose a paid seat or paid add-on.",
  "For weird visual controls/canvas/SVG seat maps, do not invent a DOM target. Use click_xy only for a visible safe navigation/decline/close control, never for selecting a paid seat.",
  "Use type='scroll' when the next safe required control is likely offscreen. Use type='keypress' with keys='Escape' only to close a harmless dropdown/popover, not to bypass payment/legal/final review.",
  "Prefer declining paid extras (baggage/seat/insurance/bundle/flexible-ticket) when the traveler profile or approval state says no paid extras.",
  "Do not propose clicking Continue/Next while any required requirement's status is not 'satisfied' in the CURRENT requirements list — check it yourself, do not assume.",
  "If verification.changed is false and the previous action already looked like this same one, do not simply repeat it — try a different visible control for the same requirement, or ask_user.",
  "When activeSkillRecovery is present, that exact skill atom owns the next step even though its deterministic actuator is ambiguous. Recover only that atom; do not fill a later traveler field such as phone/name and do not navigate onward.",
  "For activeSkillRecovery, use evidence in this order: a canonical operation actuator, accessibility relationships, bounded geometry recovery regions, screenshot grounding, then click_xy inside one supplied recovery region. If none is defensible, use wait/scroll for one fresh observation or ask_user. Never invent coordinates outside a supplied region.",
  "The payload includes failedActuatorAttempts from this durable checkout session. Never propose the same type+operation+controlId+targetId+value signature again. Use another current actuator for the same control, reobserve, or ask_user.",
  "Never propose typing into or clicking a card number/CVC-looking field. Never propose a final payment/purchase action — use type='final_review' or type='ask_user' once nothing else is missing.",
  "For click/type/select, targetId must be a canonical controlId, screenshot visualRef, or exact registered element ID from the CURRENT observation. targetLabel is descriptive only and is never a fallback identity. If no current canonical target exists, return wait or ask_user instead of a label-only mutation.",
  "Use click_xy only when the target is genuinely visual canvas/SVG content with no canonical DOM control. Bind it to the current observation by setting x/y plus visualRegion={x,y,width,height,viewportWidth,viewportHeight,surfaceId}. The point must lie inside that region and the region must belong to the foreground surface. Never use click_xy to recover a DOM control by text.",
  "The action JSON schema requires x, y, visualRegion, scrollY, and keys on every action. For non-coordinate actions use x=0, y=0 and visualRegion={x:0,y:0,width:0,height:0,viewportWidth:0,viewportHeight:0,surfaceId:''}; use 0 for scrollY and empty string for keys when they do not apply.",
  "requirementId should reference the id of the requirement this action is trying to satisfy, when applicable; empty string if none. requiresApproval should be true whenever risk is 'money', 'payment', or 'legal'.",
  "Both `verification.evidence`/`blockers` and `action.reason` are short, concrete, user-visible text — not internal chain-of-thought."
].join(" ");

/**
 * @param {Object} args
 * @param {string} args.apiKey
 * @param {string} args.model
 * @param {import("../../../packages/shared/agent-state").CheckoutSessionState} args.state previous state
 * @param {Object} args.observation current AgentObservation
 * @param {Array} args.currentRequirements freshly derived requirements for the current page
 * @param {Object} [args.pageState] typed page state from classifier
 * @param {Object} args.traveler
 * @param {Array} [args.actionHistory]
 * @param {string} [args.screenshotDataUrl]
 * @returns {Promise<{ verification: Object, action: import("../../../packages/shared/agent-actions").AgentAction }>}
 */
async function verifyAndPlan({ apiKey, model, state, observation, currentRequirements, pageState = null, traveler, actionHistory = [], screenshotDataUrl, skillRecovery = null }) {
  const previousPrice = latestPrice(state);
  const { data: raw, meta } = await callStructured({
    apiKey,
    model,
    instructions: INSTRUCTIONS,
    payload: {
      previousRequirements: (state?.requirements || []).map((req) => ({ id: req.id, label: req.label, status: req.status, required: req.required })),
      lastAction: state?.lastAction || null,
      currentStep: state?.currentStep || "unknown",
      currentRequirements,
      pageState,
      previousPrice,
      currentPriceText: observation?.page?.priceText || "",
      lastActionResultFromClient: observation?.lastActionResult || null,
      page: observation?.page || {},
      traveler: traveler || {},
      approvalState: state?.approvals || {},
      activeSkillRecovery: skillRecovery,
      failedActuatorAttempts: (state?.failures || []).map((failure) => ({
        actuatorSignature: failure.actuatorSignature || failure.actionSignature || "",
        actionId: failure.actionId || "",
        observationId: failure.observationId || "",
        controlId: failure.controlId || "",
        targetId: failure.targetId || "",
        operation: failure.operation || "",
        code: failure.code || "",
        message: failure.message || ""
      })).slice(-30),
      actionHistory: actionHistory.slice(-12),
      userIntent: observation?.userIntent || ""
    },
    screenshotDataUrl,
    schema: verifyAndPlanSchema,
    schemaName: "checkout_verify_and_plan",
    maxOutputTokens: 1400,
    returnMeta: true
  });

  const v = raw.verification || {};
  const verification = {
    ok: Boolean(v.ok),
    changed: Boolean(v.changed),
    lastActionWorked: Boolean(v.lastActionWorked),
    blockers: Array.isArray(v.blockers) ? v.blockers.map(String).slice(0, 10) : [],
    priceChanged: Boolean(v.priceChanged),
    riskChanged: Boolean(v.riskChanged),
    evidence: Array.isArray(v.evidence) ? v.evidence.map(String).slice(0, 10) : [],
    confidence: Math.max(0, Math.min(1, Number(v.confidence) || 0)),
    requirementUpdates: Array.isArray(v.requirementUpdates) ? v.requirementUpdates.map((item) => ({
      requirementId: String(item?.requirementId || ""),
      proposedStatus: String(item?.proposedStatus || ""),
      observationId: String(item?.observationId || ""),
      evidence: item?.evidence && typeof item.evidence === "object" ? {
        controlId: String(item.evidence.controlId || ""),
        selectedValue: String(item.evidence.selectedValue || ""),
        visibleText: String(item.evidence.visibleText || "")
      } : null,
      confidence: Math.max(0, Math.min(1, Number(item?.confidence) || 0))
    })).filter((item) => item.requirementId) : []
  };

  return { verification, action: normalizeAction(raw.action || {}), meta };
}

module.exports = { verifyAndPlan };
