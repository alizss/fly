export function createSidebarUi({
  agent,
  bookingDetected,
  copyDebugLog,
  getAppData,
  getFilledFields,
  getWarnings,
  handleAgentChoice,
  handleChatSubmit,
  inferCheckoutSite,
  observePageOnly,
  pageStateStore,
  readSelectedBookingContract,
  routeSummary,
  runRiskChecks,
  saveTrip,
  scanPageForSelectedBooking,
  setObserverTab,
  setSelectedTravelerId,
  setUserGoal,
  setWarnings,
  takeOverCheckout,
  traveler,
  travelerRules
}) {
  let bookingScanResult = null;

  function warningHtml(dormant = false) {
    if (dormant) return "<p class='atw-muted'>Risk checks begin after Start.</p>";
    const currentWarnings = getWarnings();
    // Rendering is presentation-only. During an active checkout, the
    // observation loop owns page reads and publishes warnings; the sidebar
    // must not crawl a still-hydrating document merely to paint itself.
    if (!currentWarnings.length && agent.running) {
      return "<p class='atw-muted'>Risk checks update after the current page observation.</p>";
    }
    const list = currentWarnings.length ? currentWarnings : runRiskChecks();
    if (!list.length) return "<p class='atw-muted'>No booking risks detected.</p>";
    return list.map((warning) => `
      <div class="atw-warning ${warning.severity}">
        <strong>${warning.title}</strong>
        <span>${warning.message}</span>
      </div>
    `).join("");
  }

  function paymentInstruction() {
    const preference = traveler()?.payment_preference || "browser saved card";
    const copy = {
      "browser saved card": "Use the browser's saved card autofill on the payment step. Air Travel Wallet will not fill card number or CVC.",
      "Apple Pay / Google Pay": "Use Apple Pay or Google Pay if the checkout offers it. Confirm the payment yourself.",
      "company virtual card": "Use your company virtual card provider for the card step. Keep final purchase confirmation manual.",
      "manual payment": "Payment is set to manual. Review the fare and complete payment yourself."
    };
    return copy[preference] || copy["browser saved card"];
  }

  function agentStatusHtml(map) {
    const startFailed = Boolean(agent.sessionStartFailure && !agent.running && !agent.sessionId);
    const label = startFailed
      ? "Not started"
      : agent.running
      ? agent.skipRoutineRunning
        ? "Acting"
        : "Thinking"
      : agent.awaiting
        ? "Waiting"
        : "Ready";
    const detail = startFailed
      ? agent.sessionStartFailure.message
      : agent.currentAction
      ? agent.currentAction
      : agent.awaiting === "extras"
      ? "Needs your choice on paid extras"
      : agent.awaiting === "final"
        ? "Paused before payment"
        : agent.awaiting === "manual"
          ? "Needs guidance"
          : `${map.step.replace(/_/g, " ")} · ${map.summary.buttons} actions`;
    return `
      <div class="atw-agent-live">
        <div class="atw-live-dot ${agent.running ? "is-running" : ""}"></div>
        <div>
          <strong>${label}</strong>
          <span>${detail}</span>
          ${agent.currentReason ? `<em>${agent.currentReason}</em>` : ""}
        </div>
      </div>
    `;
  }

  function agentSectionsHtml(map) {
    const sections = (map.sections || []).filter((section) => section.type !== "continue");
    if (!sections.length) return "";
    let currentAssigned = false;
    return `
      <ol class="atw-section-progress">
        ${sections.map((section) => {
          const state = section.status === "complete" ? "done" : section.status === "blocked" ? "blocked" : "pending";
          const isCurrent = state === "pending" && !currentAssigned;
          if (isCurrent) currentAssigned = true;
          return `<li class="${state}${isCurrent ? " is-current" : ""}"><span class="atw-dot"></span>${escapeHtml(section.label)}</li>`;
        }).join("")}
      </ol>
    `;
  }

  function agentReasoningHtml() {
    if (!agent.reasoningLog.length) return "";
    return `
      <div class="atw-reasoning-log">
        ${agent.reasoningLog.slice(-5).reverse().map((entry) => `
          <div class="atw-reasoning-item ${entry.ok === false ? "is-warn" : ""}">
            <span class="atw-reasoning-step">${escapeHtml(entry.loopStep)}</span>
            <span class="atw-reasoning-text">${escapeHtml(entry.action)}</span>
            ${entry.reason ? `<span class="atw-reasoning-reason">${escapeHtml(entry.reason)}</span>` : ""}
          </div>
        `).join("")}
      </div>
    `;
  }

  function diagnosticRoute(facts = {}) {
    return (facts.itinerary?.segments || [])
      .map((segment) => `${segment.origin || "?"} → ${segment.destination || "?"}`)
      .filter(Boolean)
      .join(" · ");
  }

  function diagnosticPrice(facts = {}) {
    const amount = facts.totalPrice?.amount;
    const currency = facts.totalPrice?.currency || facts.currency || "";
    return amount == null ? "unknown" : `${amount} ${currency}`.trim();
  }

  function agentProcessDiagnosticsHtml() {
    const diagnostics = agent.processDiagnostics;
    if (!diagnostics) return "";
    const awareness = diagnostics.processAwareness || {};
    const review = diagnostics.transactionReview || {};
    const baseline = review.baseline || {};
    const current = review.reviewFacts || review.current || {};
    const achievements = (awareness.achievements || []).slice(-4).reverse();
    const unresolved = (awareness.unresolved || []).slice(0, 4);
    const contradictions = review.contradictions || [];
    const missing = review.missingFacts || [];
    const route = diagnosticRoute(baseline) || diagnosticRoute(current) || "not established";
    return `
      <details class="atw-process-diagnostics" open>
        <summary>Agent state · testing</summary>
        <div class="atw-process-grid">
          <div><span>Where</span><strong>${escapeHtml(awareness.currentPosition?.stage || agent.pageMap?.step || "observing")}</strong></div>
          <div><span>Status</span><strong>${escapeHtml(awareness.status || (agent.running ? "in progress" : "waiting"))}</strong></div>
          <div class="is-wide"><span>Doing</span><strong>${escapeHtml(awareness.currentObjective || agent.currentAction || "observe and plan the next safe action")}</strong></div>
          <div class="is-wide"><span>Selected booking</span><strong>${escapeHtml(route)} · ${escapeHtml(diagnosticPrice(baseline))} · ${escapeHtml(review.baselineStatus || "unavailable")}</strong></div>
          <div class="is-wide"><span>Current/review evidence</span><strong>${escapeHtml(diagnosticPrice(current))}${review.ready === true ? " · verified" : ""}</strong></div>
        </div>
        ${achievements.length ? `<div class="atw-process-list"><span>Done</span>${achievements.map((item) => `<em>✓ ${escapeHtml(item.label || item.kind || item.achievementId)}</em>`).join("")}</div>` : ""}
        ${unresolved.length || missing.length || contradictions.length ? `<div class="atw-process-list is-warn"><span>Still unresolved</span>${[...unresolved, ...missing.map((item) => `transaction: ${item}`), ...contradictions.map((item) => `conflict: ${item}`)].slice(0, 6).map((item) => `<em>${escapeHtml(item)}</em>`).join("")}</div>` : ""}
      </details>
    `;
  }

  function selectedBookingAdmissionHtml() {
    const contract = readSelectedBookingContract();
    const durable = agent.processDiagnostics?.transactionReview?.baseline || null;
    const facts = contract || durable || null;
    const segments = facts?.itinerary?.segments || [];
    const captured = segments.length > 0 && segments.every((segment) => (
      segment.origin && segment.destination && segment.departureDate
    ));
    const route = captured ? diagnosticRoute(facts) : "not captured";
    const dates = captured
      ? segments.map((segment) => segment.departureDate).filter(Boolean).join(" · ")
      : "departure date unavailable";
    const source = contract
      ? contract.testOnlyPageConfirmation === true
        ? "DEV page confirmation"
        : String(contract.selectionId || "").includes("_page_scan_")
          ? "captured from this page"
        : "selected before session"
      : captured
        ? "durable baseline"
        : "unavailable";
    const total = facts?.approvedTotal || facts?.totalPrice || null;
    const price = total?.amount == null
      ? "total unavailable"
      : `${total.amount} ${total.currency || facts?.currency || ""}`.trim();
    const selectedTraveler = traveler();
    const travelerName = [selectedTraveler?.first_name, selectedTraveler?.middle_name, selectedTraveler?.last_name]
      .filter(Boolean)
      .join(" ") || "traveler unavailable";
    const missingFacts = bookingScanResult?.missingFacts
      || agent.sessionStartFailure?.details?.missingFacts
      || ["itinerary", "approved_total", "currency"];
    const observed = bookingScanResult?.observed || null;
    const canonicalObservedRoute = observed ? diagnosticRoute(observed) : "";
    const observedRoute = canonicalObservedRoute || (
      observed?.observedRoute?.origin && observed?.observedRoute?.destination
        ? `${observed.observedRoute.origin} → ${observed.observedRoute.destination}`
        : ""
    );
    const observedTotal = observed?.approvedTotal;
    const scanStatus = bookingScanResult
      ? String(bookingScanResult.code || "").includes("AMBIGUOUS")
        ? `Scan found ${bookingScanResult.candidateCount || "multiple"} conflicting bookings. Open one selected-booking summary and scan again.`
        : `Scan found ${observedRoute || "no complete itinerary"} · ${observedTotal?.amount == null ? "no approved total" : `${observedTotal.amount} ${observedTotal.currency || ""}`.trim()}. Missing: ${missingFacts.join(", ") || "nothing"}.`
      : "Use this on the page where your selected itinerary and final approved total are visible.";
    return `
      <div class="atw-booking-admission ${captured ? "is-ready" : "is-missing"}">
        <div class="atw-map-line">Checkout baseline: <strong>${captured ? "captured" : "unavailable"}</strong></div>
        <div class="atw-booking-facts">
          <span>Route</span><strong>${escapeHtml(route)}</strong>
          <span>Dates</span><strong>${escapeHtml(dates)}</strong>
          <span>Total</span><strong>${escapeHtml(price)}</strong>
          <span>Traveler</span><strong>${escapeHtml(travelerName)}</strong>
          <span>Source</span><strong>${escapeHtml(source)}</strong>
        </div>
        ${captured ? "" : `<div class="atw-mini-note">Start needs an approved booking. Missing: ${missingFacts.map(escapeHtml).join(", ")}.</div>`}
      </div>
      ${captured || agent.running ? "" : `
        <div class="atw-booking-scan">
          <button class="atw-primary" id="atw-scan-booking" type="button">Scan &amp; use observed booking [DEV]</button>
          <div class="atw-muted">${escapeHtml(scanStatus)} Confirmation always starts a fresh checkout identity; production uses the selected-booking handoff.</div>
        </div>
      `}
    `;
  }

  // Sidebar is logs-only by design: it starts the agent and shows what it's doing
  // (section checklist, reasoning log). Anything that needs the user's input is
  // asked on the page itself, next to the AI cursor — see cursorPromptHtml().
  function sidebarPageMap() {
    return agent.pageMap || pageStateStore.current() || {
      site: location.host,
      step: "loading_checkout",
      sections: [],
      summary: {
        fields: 0,
        knownFields: 0,
        buttons: 0,
        paidChoices: 0
      }
    };
  }

  function agentChatHtml(dormant = false) {
    if (dormant) {
      return `
        <div class="atw-agent-live">
          <div class="atw-live-dot"></div>
          <div><strong>Ready</strong><span>Fly is idle until you press Start.</span></div>
        </div>
        ${selectedBookingAdmissionHtml()}
      `;
    }
    const map = sidebarPageMap();
    return `
      ${agentStatusHtml(map)}
      <div class="atw-map-line">Reading ${map.site}: ${map.step.replace(/_/g, " ")} · ${map.summary.knownFields}/${map.summary.fields} fields · ${map.summary.paidChoices} paid areas</div>
      ${selectedBookingAdmissionHtml()}
      ${agentProcessDiagnosticsHtml()}
      ${agentSectionsHtml(map)}
      ${agent.running ? agentReasoningHtml() : ""}
      ${agent.awaiting ? `<div class="atw-mini-note">Waiting for you — answer next to the AI cursor on the page.</div>` : ""}
    `;
  }

  function latestQuestionText() {
    const last = [...agent.messages].reverse().find((message) => message.role === "assistant");
    return last?.text || `I found ${routeSummary()}. Want me to complete checkout for ${traveler()?.first_name || "this traveler"}?`;
  }

  function cursorPromptHtml() {
    return `
      <div class="atw-cursor-prompt-message">${escapeHtml(latestQuestionText())}</div>
      ${agentDecisionHtml()}
      <form id="atw-chat-form" class="atw-chat-form">
        <input id="atw-chat-input" placeholder="Type: continue, skip extras, stop..." />
        <button class="atw-primary" type="submit">Send</button>
      </form>
    `;
  }

  function renderCursorPrompt() {
    const existing = document.getElementById("atw-cursor-prompt");
    if (!agent.awaiting) {
      existing?.remove();
      return;
    }
    const prompt = existing || document.createElement("div");
    prompt.id = "atw-cursor-prompt";
    prompt.innerHTML = cursorPromptHtml();
    if (!prompt.parentElement) document.body.appendChild(prompt);
    const cursor = document.getElementById("atw-agent-cursor");
    const anchorRect = cursor?.getBoundingClientRect();
    if (anchorRect && anchorRect.width) {
      const left = Math.min(Math.max(8, anchorRect.left), window.innerWidth - 340);
      const top = Math.min(anchorRect.bottom + 14, window.innerHeight - 40);
      prompt.style.left = `${Math.max(8, left)}px`;
      prompt.style.top = `${Math.max(8, top)}px`;
    } else {
      prompt.style.left = "50%";
      prompt.style.top = "auto";
      prompt.style.bottom = "24px";
      prompt.style.transform = "translateX(-50%)";
    }
  }

  function agentDecisionHtml() {
    if (agent.awaiting === "extras") {
      const demoAddBag = inferCheckoutSite() === "demo" ? '<button id="atw-add-bag">Add cabin bag</button>' : "";
      return `
        <div class="atw-choice-grid">
          <button id="atw-stop">Review manually</button>
          <button class="atw-primary" id="atw-skip-extras">Skip paid extras</button>
          ${demoAddBag}
        </div>
      `;
    }
    if (agent.awaiting === "final") {
      if (inferCheckoutSite() === "demo") {
        return `
          <div class="atw-choice-grid">
            <button id="atw-stop">No, stop</button>
            <button class="atw-primary" id="atw-confirm-pay">Confirm demo payment</button>
          </div>
        `;
      }
      return `
        <div class="atw-choice-grid">
          <button id="atw-stop">Stop</button>
          <button class="atw-primary" id="atw-save-after-payment">Payment done, save</button>
        </div>
      `;
    }
    if (agent.awaiting === "manual") {
      return `
        <div class="atw-choice-grid">
          <button id="atw-stop">Stop</button>
          <button class="atw-primary" id="atw-retry">I fixed it, continue</button>
        </div>
        <button id="atw-skip-paid" class="atw-wide-action">Skip paid extras</button>
      `;
    }
    return "";
  }

  function escapeHtml(text) {
    return String(text || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function pct(value) {
    return `${Math.round((value || 0) * 100)}%`;
  }

  const OBSERVER_TABS = [
    ["summary", "Summary"],
    ["pagemap", "Page Map"],
    ["fields", "Fields"],
    ["options", "Options"],
    ["debug", "Debug JSON"]
  ];

  function observerTabsHtml() {
    return `
      <div class="atw-buttons" style="flex-wrap:wrap;">
        ${OBSERVER_TABS.map(([key, label]) => `
          <button class="atw-tab ${agent.observerTab === key ? "atw-primary" : ""}" data-observer-tab="${key}">${label}</button>
        `).join("")}
      </div>
    `;
  }

  function observerSummaryHtml(pu) {
    const blocker = pu.checkoutState.blockers[0]?.message || "None detected.";
    const nextAction = pu.proposedNextActions[0]?.label || "None — nothing pending.";
    return `
      <div class="atw-box">
        <strong>Page understood [Observer Mode — no actions taken]</strong>
        <div class="atw-muted">Current step: ${escapeHtml(pu.pageIdentity.pageType.replace(/_/g, " "))} (confidence ${pct(pu.pageIdentity.confidence)})</div>
        <div class="atw-muted">Overall status: ${escapeHtml(pu.checkoutState.overallStatus.replace(/_/g, " "))}</div>
        <div class="atw-muted">Detected sections: ${pu.sections.length}</div>
      </div>
      <div class="atw-box">
        <strong>Main blocker</strong>
        <div class="atw-muted">${escapeHtml(blocker)}</div>
      </div>
      <div class="atw-box">
        <strong>Recommended next step (not executed)</strong>
        <div class="atw-muted">${escapeHtml(nextAction)}</div>
      </div>
      <div class="atw-box">
        <strong>Reasoning</strong>
        <div class="atw-muted">${escapeHtml(pu.reasoningSummary.shortSummary)}</div>
        ${pu.reasoningSummary.keyEvidence.length ? `<ul class="atw-list">${pu.reasoningSummary.keyEvidence.map((e) => `<li>${escapeHtml(e)}</li>`).join("")}</ul>` : ""}
        ${pu.reasoningSummary.uncertainty.length ? `<div class="atw-muted" style="margin-top:6px;"><em>Uncertain about:</em><ul class="atw-list">${pu.reasoningSummary.uncertainty.map((e) => `<li>${escapeHtml(e)}</li>`).join("")}</ul></div>` : ""}
      </div>
      ${pu.warnings.length ? `
        <div class="atw-box">
          <strong>Warnings</strong>
          <ul class="atw-list">${pu.warnings.map((w) => `<li>[${w.severity}] ${escapeHtml(w.title || w.type)}: ${escapeHtml(w.message)}</li>`).join("")}</ul>
        </div>
      ` : ""}
    `;
  }

  function observerPageMapHtml(pu) {
    return `
      <div class="atw-box">
        <strong>Sections (${pu.sections.length})</strong>
        ${pu.sections.map((section, index) => `
          <div style="margin:10px 0;padding-top:8px;border-top:1px solid rgba(255,255,255,0.08);">
            <div><strong>${index + 1}. [${escapeHtml(section.type)}]</strong> ${escapeHtml(section.label)} — ${escapeHtml(section.status)} (${pct(section.confidence)})</div>
            <ul class="atw-list">${section.evidence.map((e) => `<li>${escapeHtml(e)}</li>`).join("")}</ul>
          </div>
        `).join("") || "<div class='atw-muted'>No sections detected.</div>"}
      </div>
    `;
  }

  function observerFieldsHtml(pu) {
    const known = pu.fields.filter((f) => f.semanticType !== "unknown");
    const unknownCount = pu.fields.length - known.length;
    return `
      <div class="atw-box">
        <strong>Recognized fields (${known.length}/${pu.fields.length})</strong>
        ${known.map((field) => `
          <div style="margin:8px 0;">
            <div>${field.filled ? "✓" : "✗"} <strong>${escapeHtml(field.semanticType)}</strong>${field.required ? " (required)" : ""} — ${field.filled ? escapeHtml(field.valuePreview || "filled") : "empty"} (${pct(field.confidence)})</div>
            <div class="atw-muted" style="font-size:11px;">${escapeHtml(field.label.slice(0, 60))}</div>
          </div>
        `).join("") || "<div class='atw-muted'>None recognized.</div>"}
        ${unknownCount ? `<div class="atw-muted">+${unknownCount} unrecognized field(s) on page (tracked within their section's choices, not shown here).</div>` : ""}
      </div>
    `;
  }

  function observerOptionsHtml(pu) {
    if (!pu.options.length) return `<div class="atw-box atw-muted">No paid/choice options detected on this page.</div>`;
    return `
      <div class="atw-box">
        <strong>Options (${pu.options.length})</strong>
        ${pu.options.map((option) => `
          <div style="margin:8px 0;padding-top:8px;border-top:1px solid rgba(255,255,255,0.08);">
            <div><strong>${escapeHtml(option.label)}</strong> — ${escapeHtml(option.category)} · ${escapeHtml(option.status)}${option.price ? ` · ${option.price.amount} ${option.price.currency}` : ""} (${pct(option.confidence)})</div>
          </div>
        `).join("")}
      </div>
    `;
  }

  function observerDebugHtml(pu) {
    return `
      <div class="atw-box">
        <button id="atw-copy-observer-json">Copy debug JSON</button>
        <pre style="white-space:pre-wrap;font-size:10px;line-height:1.4;max-height:400px;overflow-y:auto;margin-top:8px;">${escapeHtml(JSON.stringify(pu, null, 2))}</pre>
      </div>
    `;
  }

  function observerPanelHtml() {
    const pu = agent.pageUnderstanding;
    if (!pu) return `<div class="atw-box atw-muted">Click "Observe page" to scan.</div>`;
    const renderers = {
      summary: observerSummaryHtml,
      pagemap: observerPageMapHtml,
      fields: observerFieldsHtml,
      options: observerOptionsHtml,
      debug: observerDebugHtml
    };
    return (renderers[agent.observerTab] || observerSummaryHtml)(pu);
  }

  function renderSidebar(mode = "ready") {
    const t = traveler();
    const dormant = mode === "ready" && !agent.running && !agent.pageMap;
    // Cached/running state is sufficient to render. Booking detection is an
    // expensive page scan and is only needed before the first checkout start.
    const detected = agent.running
      || Boolean(agent.pageMap || pageStateStore.current())
      || dormant
      || bookingDetected();
    const bookingReady = Boolean(readSelectedBookingContract() || agent.sessionId);
    const root = document.getElementById("atw-sidebar") || document.createElement("aside");
    root.id = "atw-sidebar";
    root.innerHTML = `
      <div class="atw-panel">
        <div class="atw-head">
          <div>
            <h2>Air Travel Agent</h2>
            <p>${location.host}</p>
          </div>
          <span class="atw-pill">${mode === "saved" ? "Saved" : detected ? "Live" : "Idle"}</span>
        </div>
        <label class="atw-label">Traveler
          <select id="atw-traveler">
            ${getAppData().travelers.map((item) => {
              const name = [item.first_name, item.middle_name, item.last_name].filter(Boolean).join(" ");
              return `<option value="${item.id}" ${item.id === t.id ? "selected" : ""}>${name}</option>`;
            }).join("")}
          </select>
        </label>
        <label class="atw-label">Anything specific for this booking? (optional)
          <textarea id="atw-user-goal" placeholder="e.g. book free, nothing extra, no seat" ${agent.running ? "disabled" : ""}>${escapeHtml(agent.userGoal)}</textarea>
        </label>
        <div class="atw-buttons">
          <button class="atw-primary" id="atw-takeover" ${detected && !agent.running && bookingReady ? "" : "disabled"}>Start agent</button>
          <button id="atw-observe-only" ${detected ? "" : "disabled"}>Observe page (no actions) [TEMP]</button>
        </div>
        ${!agent.running ? `<div class="atw-mini-note">Start binds Fly to this checkout and traveler. Visible trip facts are preserved as they appear. Fly stops at card entry.</div>` : ""}
        ${mode === "observer" ? `
          <div class="atw-observer">
            ${observerTabsHtml()}
            ${observerPanelHtml()}
          </div>
        ` : `
          <div class="atw-agent-card">
            ${agentChatHtml(dormant)}
          </div>
        `}
        <details class="atw-details">
          <summary>Profile and logs</summary>
          <div class="atw-box">
            <strong>${t.first_name} ${t.last_name}</strong>
            <div class="atw-muted">${t.nationality} · ${t.document?.masked_document_number || "No document"} · expires ${t.document?.expiry_date || "not set"}</div>
          </div>
          <div class="atw-box">
            <strong>Payment helper</strong>
            <div class="atw-muted">${paymentInstruction()}</div>
          </div>
          <div class="atw-box">
            <strong>Booking rules</strong>
            <div class="atw-muted">${travelerRules() || "Ask before paid extras. Stop before real payment."}</div>
          </div>
          <button id="atw-copy-debug">Copy debug log</button>
          <button id="atw-save">Save confirmed trip</button>
          <div class="atw-box">
            <strong>Filled fields</strong>
            ${getFilledFields().length ? `<ul class="atw-list">${getFilledFields().map((field) => `<li>${field.fieldType} (${Math.round(field.confidence * 100)}%)</li>`).join("")}</ul>` : "<p class='atw-muted'>Nothing filled yet.</p>"}
          </div>
          <div>${warningHtml(dormant)}</div>
        </details>
      </div>
    `;
    if (!root.parentElement) document.body.appendChild(root);
    renderCursorPrompt();
    document.getElementById("atw-user-goal")?.addEventListener("input", (event) => setUserGoal(event.target.value));
    document.getElementById("atw-takeover").addEventListener("click", () => takeOverCheckout().catch((error) => alert(error.message)));
    document.getElementById("atw-scan-booking")?.addEventListener("click", async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      button.textContent = "Observing and confirming test booking…";
      try {
        bookingScanResult = await scanPageForSelectedBooking();
      } catch (error) {
        bookingScanResult = {
          ok: false,
          captured: false,
          code: "BOOKING_SCAN_UNAVAILABLE",
          missingFacts: [error.message],
          observed: null
        };
      }
      renderSidebar("ready");
    });
    document.getElementById("atw-observe-only")?.addEventListener("click", () => observePageOnly().catch((error) => alert(error.message)));
    document.querySelectorAll("[data-observer-tab]").forEach((button) => {
      button.addEventListener("click", () => setObserverTab(button.dataset.observerTab));
    });
    document.getElementById("atw-copy-observer-json")?.addEventListener("click", () => {
      navigator.clipboard.writeText(JSON.stringify(agent.pageUnderstanding, null, 2))
        .then(() => alert("Debug JSON copied."))
        .catch((error) => alert(error.message));
    });
    document.getElementById("atw-copy-debug")?.addEventListener("click", () => copyDebugLog().catch((error) => alert(error.message)));
    document.getElementById("atw-save")?.addEventListener("click", () => saveTrip().catch((error) => alert(error.message)));
    document.getElementById("atw-skip-extras")?.addEventListener("click", () => handleAgentChoice("skip_extras"));
    document.getElementById("atw-add-bag")?.addEventListener("click", () => handleAgentChoice("add_bag"));
    document.getElementById("atw-confirm-pay")?.addEventListener("click", () => handleAgentChoice("confirm_pay"));
    document.getElementById("atw-save-after-payment")?.addEventListener("click", () => saveTrip().catch((error) => alert(error.message)));
    document.getElementById("atw-stop")?.addEventListener("click", () => handleAgentChoice("stop"));
    document.getElementById("atw-retry")?.addEventListener("click", () => handleAgentChoice("retry"));
    document.getElementById("atw-skip-paid")?.addEventListener("click", () => handleAgentChoice("skip_paid"));
    document.getElementById("atw-chat-form")?.addEventListener("submit", handleChatSubmit);
    document.getElementById("atw-traveler").addEventListener("change", async (event) => {
      const nextTravelerId = event.target.value;
      setSelectedTravelerId(nextTravelerId);
      await chrome.storage.local.set({ selectedTravelerId: nextTravelerId });
      setWarnings(runRiskChecks());
      renderSidebar(mode);
    });
  }


  return {
    agentDecisionHtml,
    agentProcessDiagnosticsHtml,
    agentStatusHtml,
    escapeHtml,
    renderCursorPrompt,
    renderSidebar,
    selectedBookingAdmissionHtml,
    warningHtml
  };
}
