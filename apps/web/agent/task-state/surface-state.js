const { currentSurface, controlBelongsToCurrentSurface } = require("../surface-contract");

function clean(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function lower(value = "") {
  return clean(value).toLowerCase();
}

/**
 * Structural description only. This helper does not schedule work, create a
 * subgoal, or grant action authority; DecisionFrame and TaskState retain those
 * responsibilities.
 */
function surfaceClassFrom(page = {}) {
  const surface = currentSurface(page);
  if (surface.type === "page") return "navigation";
  if (["choice_set", "form", "review_confirmation", "site_failure", "warning", "navigation", "information"].includes(surface.surfaceClass)) {
    return surface.surfaceClass;
  }
  const controls = (page.controls || []).filter((control) => controlBelongsToCurrentSurface(control, page));
  const effects = new Set(controls.map((control) => control.physicalEffect).filter(Boolean));
  const text = lower(`${surface.label || ""} ${controls.map((control) => control.ownText || control.label || "").join(" ")}`);
  const strongReviewSubmit = (page.controls || []).some((control) => (
    /review-submit|continue.*payment|proceed.*payment/.test(lower(`${control.testId || ""} ${control.ownText || ""} ${control.label || ""}`))
    && (/submit|button/.test(lower(`${control.inputType || ""} ${control.kind || ""} ${control.role || ""}`))
      || /payment/.test(lower(control.formAction || "")))
  ));
  if (/checkout error|something went wrong|technical (?:problem|error)|unable to (?:continue|complete)|back to search.*try again/.test(text)) return "site_failure";
  if (controls.filter((control) => /radio|checkbox|option/.test(lower(`${control.kind || ""} ${control.role || ""}`))).length >= 2) return "choice_set";
  if (controls.some((control) => control.physicalEffect === "set_field_value" || /field|textbox|combobox/.test(lower(`${control.kind || ""} ${control.role || ""}`)))) return "form";
  if (/review|verify|check your (?:details|information)/.test(text)
    && (effects.has("advance_surface") || effects.has("advance_checkout_stage") || /continue.*payment/.test(text) || strongReviewSubmit)) return "review_confirmation";
  const confirmationQuestion = /\?\s*$/.test(lower(surface.label))
    && controls.some((control) => /^(?:continue|confirm|proceed|yes|ok)\b/.test(lower(control.ownText || control.label)));
  if (/warning|are you sure|attention|problem|error|continue without/.test(text) || confirmationQuestion) return "warning";
  if (effects.has("advance_surface") || effects.has("advance_checkout_stage") || /\bnext|continue|proceed\b/.test(text)) return "navigation";
  if (!controls.length) return "information";
  return "unknown";
}

module.exports = {
  surfaceClassFrom
};
