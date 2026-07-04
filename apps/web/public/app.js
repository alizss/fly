const API = "/api";

const state = {
  data: null,
  route: location.hash || "#/dashboard"
};

window.addEventListener("hashchange", () => {
  state.route = location.hash || "#/dashboard";
  render();
});

async function api(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    headers: { "content-type": "application/json" },
    ...options
  });
  if (!response.ok) throw new Error(`API error: ${response.status}`);
  return response.json();
}

function fmtDate(value) {
  if (!value) return "Not set";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
}

function travelerName(traveler) {
  return [traveler.first_name, traveler.middle_name, traveler.last_name].filter(Boolean).join(" ");
}

function activeWorkspace() {
  return state.data?.workspaces?.[0];
}

function activeTraveler(id) {
  const selectedId = id || state.data.preferences?.selected_traveler_id;
  return state.data.travelers.find((traveler) => traveler.id === selectedId) || state.data.travelers[0];
}

function card(title, value, detail) {
  return `<article class="metric"><span>${title}</span><strong>${value}</strong><p>${detail}</p></article>`;
}

function routeLabel(trip) {
  if (!trip) return "No active route";
  return `${escapeHtml(trip.origin_airport)} → ${escapeHtml(trip.destination_airport)}`;
}

function warningList(warnings = []) {
  if (!warnings.length) return "<span class='muted'>No warnings</span>";
  return `<ul class="compact-list">${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul>`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}

function selected(value, expected) {
  return String(value || "") === String(expected || "") ? "selected" : "";
}

function inputValue(value) {
  return escapeHtml(value || "");
}

function dashboardView() {
  const upcoming = state.data.trips.filter((trip) => new Date(trip.departure_at) >= new Date());
  const missingInvoices = state.data.trips.filter((trip) => trip.invoice_status === "missing").length;
  const selected = activeTraveler();
  const nextTrip = upcoming[0] || state.data.trips[0];
  const bookingRules = selected?.booking_rules || "No paid seats, extras, insurance, or bundles unless explicitly approved. Stop before payment.";
  const travelerOptions = state.data.travelers.map((traveler) => `<option value="${traveler.id}" ${traveler.id === selected?.id ? "selected" : ""}>${escapeHtml(travelerName(traveler))}</option>`).join("");
  return `
    <section class="flight-hero">
      <div class="flight-hero-copy">
        <p class="eyebrow">Live booking control</p>
        <h2>${routeLabel(nextTrip)}</h2>
        <p>The extension uses saved traveler data, booking rules, and visible page state to move through checkout while pausing before money or uncertain choices.</p>
        <div class="hero-actions">
          <a class="primary" href="/demo/checkout">Open demo checkout</a>
          <a class="button" href="#/travelers/${selected?.id || ""}/edit">Edit traveler rules</a>
        </div>
      </div>
      <div class="flight-radar-card">
        <div class="radar-orbit"><span></span></div>
        <div>
          <span class="card-kicker">Default traveler</span>
          <strong>${escapeHtml(travelerName(selected))}</strong>
          <p>${escapeHtml(bookingRules)}</p>
        </div>
      </div>
    </section>
    <div class="metrics">
      ${card("Upcoming trips", upcoming.length, "Booked or draft trips still ahead")}
      ${card("Traveler profiles", state.data.travelers.length, "Reusable passenger data")}
      ${card("Missing invoices", missingInvoices, "Company records needing attention")}
    </div>
    <div class="split">
      <section class="panel">
        <div class="section-head">
          <h2>Upcoming trips</h2>
          <a class="button" href="#/trips/new">Add trip</a>
        </div>
        ${tripTable(upcoming.slice(0, 5))}
      </section>
      <section class="panel">
        <div class="section-head">
          <h2>Quick actions</h2>
        </div>
        <div class="action-stack">
          <form id="default-traveler-form" class="mini-form">
            <label>Default checkout traveler
              <select name="selected_traveler_id">${travelerOptions}</select>
            </label>
            <button class="button" type="submit">Use this traveler</button>
          </form>
          <a class="primary" href="#/travelers/new">Add traveler</a>
          <a class="button" href="/demo/checkout">Open demo checkout</a>
          <a class="button" href="#/settings/team">Invite team member</a>
        </div>
      </section>
    </div>
  `;
}

function travelersView() {
  return `
    <section class="panel">
      <div class="section-head">
        <h2>Traveler profiles</h2>
        <a class="primary" href="#/travelers/new">Add traveler</a>
      </div>
      <table>
        <thead><tr><th>Name</th><th>Nationality</th><th>Passport</th><th>Expiry</th><th>Rules</th><th>Actions</th></tr></thead>
        <tbody>
          ${state.data.travelers.map((traveler) => `
            <tr>
              <td><a href="#/travelers/${traveler.id}">${escapeHtml(travelerName(traveler))}</a></td>
              <td>${escapeHtml(traveler.nationality)}</td>
              <td>${escapeHtml(traveler.document?.masked_document_number || "Not added")}</td>
              <td>${fmtDate(traveler.document?.expiry_date)}</td>
              <td>${escapeHtml(traveler.booking_rules || traveler.baggage_preference || "Not set")}</td>
              <td><a class="button compact-action" href="#/travelers/${traveler.id}/edit">Edit</a></td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </section>
  `;
}

function travelerFormView(id = "") {
  const traveler = id ? activeTraveler(id) : {};
  const document = traveler.document || {};
  const isEdit = Boolean(id && traveler?.id);
  return `
    <section class="panel narrow">
      <div class="section-head">
        <div>
          <p class="eyebrow">${isEdit ? "Edit traveler" : "New traveler"}</p>
          <h2>${isEdit ? escapeHtml(travelerName(traveler)) : "New traveler"}</h2>
        </div>
        ${isEdit ? `<button class="button danger" id="delete-traveler" type="button" data-id="${traveler.id}">Delete</button>` : ""}
      </div>
      <form id="traveler-form" class="form-grid" data-id="${isEdit ? traveler.id : ""}">
        <input type="hidden" name="workspace_id" value="${inputValue(traveler.workspace_id || activeWorkspace().id)}" />
        <label>First name <input name="first_name" value="${inputValue(traveler.first_name)}" required /></label>
        <label>Middle name <input name="middle_name" value="${inputValue(traveler.middle_name)}" /></label>
        <label>Last name <input name="last_name" value="${inputValue(traveler.last_name)}" required /></label>
        <label>Date of birth <input name="date_of_birth" type="date" value="${inputValue(traveler.date_of_birth)}" required /></label>
        <label>Title / gender
          <select name="gender">
            <option value="" ${selected(traveler.gender, "")}>Not set</option>
            <option value="male" ${selected(traveler.gender, "male")}>Mr</option>
            <option value="female" ${selected(traveler.gender, "female")}>Mrs/Ms</option>
          </select>
        </label>
        <label>Nationality <input name="nationality" value="${inputValue(traveler.nationality)}" required /></label>
        <label>Email <input name="email" type="email" value="${inputValue(traveler.email)}" required /></label>
        <label>Phone <input name="phone" value="${inputValue(traveler.phone)}" /></label>
        <label>Document type <select name="document_type"><option ${selected(document.document_type, "passport")}>passport</option><option ${selected(document.document_type, "national ID")}>national ID</option></select></label>
        <label>Passport number <input name="document_number" placeholder="${document.masked_document_number ? `Current: ${escapeHtml(document.masked_document_number)}` : ""}" ${isEdit ? "" : "required"} /></label>
        <label>Issuing country <input name="issuing_country" value="${inputValue(document.issuing_country || traveler.nationality)}" /></label>
        <label>Passport expiry <input name="expiry_date" type="date" value="${inputValue(document.expiry_date)}" required /></label>
        <label>Seat preference <select name="preferred_seat"><option ${selected(traveler.preferred_seat, "aisle")}>aisle</option><option ${selected(traveler.preferred_seat, "window")}>window</option><option ${selected(traveler.preferred_seat, "no preference")}>no preference</option></select></label>
        <label>Baggage preference <select name="baggage_preference"><option ${selected(traveler.baggage_preference, "personal item")}>personal item</option><option ${selected(traveler.baggage_preference, "cabin bag")}>cabin bag</option><option ${selected(traveler.baggage_preference, "checked bag")}>checked bag</option></select></label>
        <label>Cabin <select name="default_cabin"><option ${selected(traveler.default_cabin, "economy")}>economy</option><option ${selected(traveler.default_cabin, "business")}>business</option></select></label>
        <label>Invoice company <input name="invoice_company" value="${inputValue(traveler.invoice_company)}" /></label>
        <label>Billing tax ID <input name="billing_tax_id" value="${inputValue(traveler.billing_tax_id)}" /></label>
        <label>Billing address <input name="billing_address" value="${inputValue(traveler.billing_address)}" /></label>
        <label>Billing email <input name="billing_email" type="email" value="${inputValue(traveler.billing_email)}" /></label>
        <label>Payment preference
          <select name="payment_preference">
            <option ${selected(traveler.payment_preference, "browser saved card")}>browser saved card</option>
            <option ${selected(traveler.payment_preference, "Apple Pay / Google Pay")}>Apple Pay / Google Pay</option>
            <option ${selected(traveler.payment_preference, "company virtual card")}>company virtual card</option>
            <option ${selected(traveler.payment_preference, "manual payment")}>manual payment</option>
          </select>
        </label>
        <label>Booking rules / agent context
          <textarea name="booking_rules" placeholder="Example: No paid seats, no insurance, no bundles, no SMS updates, personal item only, stop before payment.">${escapeHtml(traveler.booking_rules || "")}</textarea>
        </label>
        <button class="primary" type="submit">${isEdit ? "Save traveler" : "Create traveler"}</button>
      </form>
    </section>
  `;
}

function travelerDetailView(id) {
  const traveler = activeTraveler(id);
  return `
    <section class="panel narrow">
      <p class="eyebrow">Traveler profile</p>
      <h2>${escapeHtml(travelerName(traveler))}</h2>
      <dl class="detail-list">
        <div><dt>Nationality</dt><dd>${escapeHtml(traveler.nationality)}</dd></div>
        <div><dt>Title / gender</dt><dd>${escapeHtml(traveler.gender || "Not set")}</dd></div>
        <div><dt>Date of birth</dt><dd>${fmtDate(traveler.date_of_birth)}</dd></div>
        <div><dt>Passport</dt><dd>${escapeHtml(traveler.document?.masked_document_number || "Not added")}</dd></div>
        <div><dt>Passport expiry</dt><dd>${fmtDate(traveler.document?.expiry_date)}</dd></div>
        <div><dt>Email</dt><dd>${escapeHtml(traveler.email)}</dd></div>
        <div><dt>Phone</dt><dd>${escapeHtml(traveler.phone)}</dd></div>
        <div><dt>Default baggage</dt><dd>${escapeHtml(traveler.baggage_preference)}</dd></div>
        <div><dt>Booking rules</dt><dd>${escapeHtml(traveler.booking_rules || "Not set")}</dd></div>
        <div><dt>Invoice company</dt><dd>${escapeHtml(traveler.invoice_company || "Not set")}</dd></div>
        <div><dt>Billing email</dt><dd>${escapeHtml(traveler.billing_email || "Not set")}</dd></div>
        <div><dt>Payment preference</dt><dd>${escapeHtml(traveler.payment_preference || "browser saved card")}</dd></div>
      </dl>
      <div class="button-row">
        <a class="primary" href="#/travelers/${traveler.id}/edit">Edit traveler</a>
        <a class="button" href="#/travelers">Back to travelers</a>
      </div>
      <p class="security-note">Sensitive document values are stored encrypted by the local API and masked by default in UI responses. Card numbers are not stored; payment preference only guides the checkout step.</p>
    </section>
  `;
}

function tripsView() {
  return `
    <section class="panel">
      <div class="section-head">
        <h2>Trips</h2>
        <a class="primary" href="#/trips/new">Add trip</a>
      </div>
      ${tripTable(state.data.trips)}
    </section>
  `;
}

function tripTable(trips) {
  if (!trips.length) return "<p class='muted'>No trips yet.</p>";
  return `
    <table>
      <thead><tr><th>Traveler</th><th>Route</th><th>Date</th><th>Airline</th><th>PNR</th><th>Invoice</th><th>Warnings</th></tr></thead>
      <tbody>
        ${trips.map((trip) => {
          const traveler = activeTraveler(trip.traveler_profile_id);
          return `
            <tr>
              <td>${escapeHtml(travelerName(traveler))}</td>
              <td>${escapeHtml(trip.origin_airport)} → ${escapeHtml(trip.destination_airport)}</td>
              <td>${fmtDate(trip.departure_at)}</td>
              <td>${escapeHtml(trip.airline)}</td>
              <td>${escapeHtml(trip.booking_reference)}</td>
              <td><span class="status ${trip.invoice_status}">${escapeHtml(trip.invoice_status)}</span></td>
              <td>${warningList(trip.warnings)}</td>
            </tr>
          `;
        }).join("")}
      </tbody>
    </table>
  `;
}

function tripFormView() {
  const travelerOptions = state.data.travelers.map((traveler) => `<option value="${traveler.id}">${escapeHtml(travelerName(traveler))}</option>`).join("");
  return `
    <section class="panel narrow">
      <h2>Manual trip</h2>
      <form id="trip-form" class="form-grid">
        <input type="hidden" name="workspace_id" value="${activeWorkspace().id}" />
        <label>Traveler <select name="traveler_profile_id">${travelerOptions}</select></label>
        <label>Airline <input name="airline" required /></label>
        <label>Seller <select name="seller"><option>airline direct</option><option>known OTA</option><option>unknown OTA</option></select></label>
        <label>Origin airport <input name="origin_airport" required /></label>
        <label>Destination airport <input name="destination_airport" required /></label>
        <label>Departure <input name="departure_at" type="datetime-local" required /></label>
        <label>Return <input name="return_at" type="datetime-local" /></label>
        <label>Booking reference <input name="booking_reference" /></label>
        <label>Price <input name="price_amount" type="number" min="0" step="0.01" /></label>
        <label>Currency <input name="price_currency" value="USD" /></label>
        <label>Baggage <input name="baggage_summary" /></label>
        <label>Invoice <select name="invoice_status"><option>missing</option><option>received</option><option>not_required</option></select></label>
        <label>Notes <textarea name="notes"></textarea></label>
        <button class="primary" type="submit">Create trip</button>
      </form>
    </section>
  `;
}

function teamView() {
  return `
    <section class="panel narrow">
      <h2>Team settings</h2>
      <form id="invite-form" class="inline-form">
        <input type="hidden" name="workspace_id" value="${activeWorkspace().id}" />
        <input name="email" type="email" placeholder="teammate@example.com" required />
        <select name="role"><option>member</option><option>admin</option></select>
        <button class="primary" type="submit">Invite</button>
      </form>
      <h3>Members</h3>
      <table>
        <tbody>${state.data.members.map((member) => `<tr><td>${escapeHtml(member.email)}</td><td>${escapeHtml(member.role)}</td></tr>`).join("")}</tbody>
      </table>
      <h3>Pending invites</h3>
      ${state.data.invites.length ? `<table><tbody>${state.data.invites.map((invite) => `<tr><td>${escapeHtml(invite.email)}</td><td>${escapeHtml(invite.role)}</td></tr>`).join("")}</tbody></table>` : "<p class='muted'>No invites sent.</p>"}
    </section>
  `;
}

function setTitle(title) {
  document.getElementById("page-title").textContent = title;
}

function bindForms() {
  const travelerForm = document.getElementById("traveler-form");
  if (travelerForm) {
    const travelerId = travelerForm.dataset.id;
    travelerForm.addEventListener("submit", submitForm(travelerId ? `/travelers/${travelerId}` : "/travelers", travelerId ? `#/travelers/${travelerId}` : "#/travelers"));
  }
  const deleteTraveler = document.getElementById("delete-traveler");
  if (deleteTraveler) {
    deleteTraveler.addEventListener("click", async () => {
      if (!confirm("Delete this traveler and their linked trips from this local demo?")) return;
      state.data = await api(`/travelers/${deleteTraveler.dataset.id}`, { method: "DELETE" });
      location.hash = "#/travelers";
      render();
    });
  }
  const defaultTravelerForm = document.getElementById("default-traveler-form");
  if (defaultTravelerForm) defaultTravelerForm.addEventListener("submit", submitForm("/preferences", "#/dashboard"));
  const tripForm = document.getElementById("trip-form");
  if (tripForm) tripForm.addEventListener("submit", submitForm("/trips", "#/trips"));
  const inviteForm = document.getElementById("invite-form");
  if (inviteForm) inviteForm.addEventListener("submit", submitForm("/invites", "#/settings/team"));
}

function submitForm(path, nextHash) {
  return async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget).entries());
    state.data = await api(path, { method: "POST", body: JSON.stringify(data) });
    location.hash = nextHash;
    render();
  };
}

function render() {
  if (!state.data) return;
  const app = document.getElementById("app");
  const route = state.route.replace(/^#/, "");
  if (route === "/dashboard" || route === "/") {
    setTitle("Dashboard");
    app.innerHTML = dashboardView();
  } else if (route === "/travelers") {
    setTitle("Travelers");
    app.innerHTML = travelersView();
  } else if (route === "/travelers/new") {
    setTitle("New traveler");
    app.innerHTML = travelerFormView();
  } else if (route.match(/^\/travelers\/[^/]+\/edit$/)) {
    setTitle("Edit traveler");
    app.innerHTML = travelerFormView(route.split("/")[2]);
  } else if (route.startsWith("/travelers/")) {
    setTitle("Traveler detail");
    app.innerHTML = travelerDetailView(route.split("/").pop());
  } else if (route === "/trips") {
    setTitle("Trips");
    app.innerHTML = tripsView();
  } else if (route === "/trips/new") {
    setTitle("New trip");
    app.innerHTML = tripFormView();
  } else if (route === "/settings/team") {
    setTitle("Team settings");
    app.innerHTML = teamView();
  } else {
    location.hash = "#/dashboard";
  }
  bindForms();
}

async function init() {
  state.data = await api("/bootstrap");
  if (!location.hash) location.hash = "#/dashboard";
  render();
}

init().catch((error) => {
  document.getElementById("app").innerHTML = `<section class="panel"><h2>Could not load app</h2><p>${escapeHtml(error.message)}</p></section>`;
});
