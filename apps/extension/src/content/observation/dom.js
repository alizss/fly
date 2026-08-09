export function isVisible(element) {
  if (!element) return false;
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return rect.width > 0
    && rect.height > 0
    && style.visibility !== "hidden"
    && style.display !== "none";
}

export function queryAllDeep(selector, root = document) {
  const results = [];
  const visit = (scope) => {
    try {
      results.push(...scope.querySelectorAll(selector));
      for (const element of scope.querySelectorAll("*")) {
        if (element.shadowRoot) visit(element.shadowRoot);
      }
      for (const frame of scope.querySelectorAll("iframe")) {
        try {
          if (frame.contentDocument) visit(frame.contentDocument);
        } catch (error) {
          // Cross-origin frames are intentionally opaque to the content script.
        }
      }
    } catch (error) {
      // A root or frame may disappear while a checkout re-renders.
    }
  };
  visit(root);
  return [...new Set(results)];
}

export function textFromIds(ids = "") {
  return String(ids || "")
    .split(/\s+/)
    .map((id) => id && document.getElementById(id)?.innerText)
    .filter(Boolean)
    .join(" ");
}

export function implicitRole(element) {
  if (!element) return "";
  const tag = (element.tagName || "").toLowerCase();
  const type = (element.getAttribute?.("type") || "").toLowerCase();
  if (element.getAttribute?.("role")) return element.getAttribute("role");
  if (tag === "button" || ["button", "submit", "reset"].includes(type)) return "button";
  if (tag === "a" && element.getAttribute("href")) return "link";
  if (tag === "select") return "combobox";
  if (tag === "textarea") return "textbox";
  if (tag === "input") {
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "range") return "slider";
    return "textbox";
  }
  if (tag === "dialog") return "dialog";
  return "";
}
