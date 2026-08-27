export function isVisible(element) {
  if (!element) return false;
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return rect.width > 0
    && rect.height > 0
    && style.visibility !== "hidden"
    && style.display !== "none";
}

let activeDeepQueryPass = null;

export function beginDeepQueryPass() {
  const pass = { roots: new WeakMap() };
  activeDeepQueryPass = pass;
  return () => {
    if (activeDeepQueryPass === pass) activeDeepQueryPass = null;
  };
}

function deepQueryScopes(root, pass) {
  const cached = pass.roots.get(root);
  if (cached) return cached;
  const records = [];
  const visited = new Set();
  const visit = (scope) => {
    if (!scope || visited.has(scope)) return;
    visited.add(scope);
    try {
      const elements = [...scope.querySelectorAll("*")];
      records.push({ scope, elements });
      for (const element of elements) {
        if (element.shadowRoot) visit(element.shadowRoot);
        if (element.tagName === "IFRAME") {
          try {
            if (element.contentDocument) visit(element.contentDocument);
          } catch (error) {
            // Cross-origin frames are intentionally opaque to the content script.
          }
        }
      }
    } catch (error) {
      // A root or frame may disappear while a checkout re-renders.
    }
  };
  visit(root);
  pass.roots.set(root, records);
  return records;
}

export function queryAllDeep(selector, root = document) {
  const results = [];
  const pass = activeDeepQueryPass || { roots: new WeakMap() };
  for (const { scope, elements } of deepQueryScopes(root, pass)) {
    try {
      results.push(...(selector === "*" ? elements : scope.querySelectorAll(selector)));
    } catch (error) {
      // A root or frame may disappear while a checkout re-renders.
    }
  }
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
