const { callStructured } = require("./openai-client");
const { pageStateSchema } = require("./schemas");
const { normalizePageState, requirementsFromPageState } = require("../../../packages/shared/page-state");
const { modelObservationContext, semanticActionContext } = require("./model-context");

const INSTRUCTIONS = [
  "You classify a flight checkout page into a typed PageState. This is NOT a free-form requirements list.",
  "Use pageMarkdown as the compact whole-page source of truth and observationDiffMarkdown for the exact transition since the previous observation. Do not assume the screenshot viewport is the whole page.",
  "Use these buckets exactly:",
  "requiredFields: fields the user must fill before the current step can proceed.",
  "requiredChoices: required radio/checkbox/select decisions such as baggage choice, seat decision, required legal checkbox.",
  "optionalPaidExtras: paid upsells/add-ons/seat upgrades/insurance/bundles that should usually be declined or skipped.",
  "navigationActions: visible buttons/links that move the flow, e.g. Continue, Next, Close, Skip. Navigation actions are actions, never missing requirements.",
  "riskGates: explicit controls that require user approval: payment/card/final purchase, legal checkbox/I agree/signature, price increase, identity uncertainty. Passive explanatory text is not a risk gate.",
  "currentSurface: the authoritative current modal/dropdown/popover/page; classify its requirements/options/navigation before background evidence.",
  "Stable references in pageMarkdown identify the current canonical controls. Aggregated seat-cell counts are context, not hundreds of separate requirements.",
  "Use the typed decision and control state preserved in pageMarkdown. A decision group is one logical requirement with alternatives. If one member is selected, the group is satisfied; unselected paid alternatives inside that same group are available alternatives, not missing requirements.",
  "Never create separate missing requirements for unselected paid alternatives when their decision group already has a selected no-cost/decline member.",
  "If foreground.active is true, classify the foreground surface as the current screen, even when the URL/background checkout step did not change. Use foreground.progressMarkers such as Flight 1 of 2 / Flight 2 of 2 to distinguish repeated seat-selection legs.",
  "Hard rule: never put Continue/Next/Proceed/Close/Skip into requiredFields or requiredChoices. Put them only in navigationActions.",
  "Hard rule: passive copy like 'By booking you confirm names match passports' is context only unless there is an explicit checkbox/radio/I agree/final purchase control.",
  "Hard rule: payment/final booking is a riskGate and navigationAction with risk payment/legal, not a normal safe Continue.",
  "For no paid extras/no specific seats user intent, optional seats/bags/bundles/insurance stay optionalPaidExtras; do not mark them required unless the page visibly blocks progress until a decline/skip choice is made.",
  "If a modal warns that seats were not selected and offers Continue versus Choose seat, classify Continue as a safe navigation/decline action when user intent says no specific seats/no extras. Classify Choose seat as the optional seat-selection path.",
  "Prefer targetIds from the supplied DOM page map. If unsure, leave targetIds empty and use evidence/uncertainties.",
  "Return short evidence strings. Do not include hidden chain-of-thought."
].join(" ");

async function classifyPageState({ apiKey, model, observation, screenshotDataUrl, traveler }) {
  const observationContext = modelObservationContext(observation, traveler);
  const { data: raw, meta } = await callStructured({
    apiKey,
    model,
    instructions: INSTRUCTIONS,
    payload: {
      ...observationContext,
      traveler: traveler || {},
      userIntent: observation?.userIntent || "",
      lastActionResult: semanticActionContext({}, observation?.lastActionResult || {})
    },
    screenshotDataUrl,
    schema: pageStateSchema,
    schemaName: "checkout_page_state",
    maxOutputTokens: 1800,
    returnMeta: true
  });

  const pageState = normalizePageState(raw);
  return {
    pageState,
    pageStep: pageState.pageStep,
    requirements: requirementsFromPageState(pageState),
    uncertainties: pageState.uncertainties,
    summary: pageState.summary,
    meta
  };
}

module.exports = { classifyPageState };
