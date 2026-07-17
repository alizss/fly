// Replaces "section = baggage, status = complete" with a flat list of
// individual requirements, each with its own evidence and confidence. This
// is the fix for the bundled-baggage bug: two radio groups inside one
// visual "section" are two separate requirements here, not one.

const { callStructured } = require("./openai-client");
const { requirementExtractorSchema } = require("./schemas");
const { normalizeRequirement } = require("../../../packages/shared/requirements");
const { modelObservationContext, semanticActionContext } = require("./model-context");

const INSTRUCTIONS = [
  "You extract checkout REQUIREMENTS from a flight booking page, not section summaries.",
  "Use pageMarkdown for compact whole-page state and observationDiffMarkdown for the exact fresh transition. Seat cells may be aggregated; do not expand them into individual requirements.",
  "Treat any DOM-derived section labels/status you're given as hints only — they have been wrong before (e.g. one radio group in a bundled section gets resolved and the whole section is reported 'complete' while a second, separate required radio group in the same visual section is still empty).",
  "Look at the screenshot yourself. Identify every distinct thing still required before this step of checkout can be considered done: passenger/contact fields, document fields, baggage decisions (cabin AND checked are separate requirements if both exist), seat decisions, paid extras, legal/terms acceptance, and the final Continue/payment action.",
  "If currentSurface is a modal/dropdown/popover, treat it as the current screen. Extract requirements for that surface first, especially whether it is an optional seat/baggage/extra selection that can be skipped.",
  "Stable references and typed states in pageMarkdown are evidence for radios, checkboxes, listbox options, buttons, required fields, selected values, disabled options, and expanded popups.",
  "If the visible foreground surface has progress markers such as Flight 1 of 2 / Flight 2 of 2, treat each marker as a distinct current surface state, not the same stale modal.",
  "A required radio/checkbox group counts as satisfied only if one of its own options is visibly selected — not because a differently-labeled nearby control was resolved.",
  "Mark clearly-optional paid upsells (insurance, bundles, seat upgrades) as required=false, risk='money'.",
  "Mark anything resembling payment/card entry as risk='payment' and required=true only once the user is ready to pay — do not invent a payment requirement before the payment step is actually visible.",
  "Passive legal/disclaimer text beside an intermediate Continue button, such as names matching passports, is evidence/context, not a separate required legal_acceptance requirement unless there is a visible checkbox, radio, signature, explicit I-agree control, or final purchase/payment button.",
  "For every requirement, give short evidence strings (what you actually saw that led to this judgment) and a confidence 0-1. Confidence below 0.7 means: do not treat this as settled.",
  "List uncertainties explicitly if the page is ambiguous, partially loaded, or you're not sure something applies here.",
  "Do not invent requirements that aren't visible or implied on the current page.",
  "The summary field is one short sentence a human could read to understand the current state."
].join(" ");

/**
 * @param {Object} args
 * @param {string} args.apiKey
 * @param {string} args.model
 * @param {Object} args.observation AgentObservation (page fields/buttons/sectionHints/etc.)
 * @param {string} [args.screenshotDataUrl]
 * @param {Object} [args.traveler]
 * @returns {Promise<{pageStep: string, requirements: Array, uncertainties: string[], summary: string}>}
 */
async function extractRequirements({ apiKey, model, observation, screenshotDataUrl, traveler }) {
  const observationContext = modelObservationContext(observation, traveler);
  const raw = await callStructured({
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
    schema: requirementExtractorSchema,
    schemaName: "requirement_extraction",
    maxOutputTokens: 1400
  });

  return {
    pageStep: raw.pageStep || "unknown",
    requirements: (raw.requirements || []).map((req, index) => normalizeRequirement(req, index)),
    uncertainties: Array.isArray(raw.uncertainties) ? raw.uncertainties.map(String).slice(0, 10) : [],
    summary: String(raw.summary || "").slice(0, 400)
  };
}

module.exports = { extractRequirements };
