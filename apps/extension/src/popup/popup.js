const apiInput = document.getElementById("api-base");
const statusEl = document.getElementById("status");
const travelerSelect = document.getElementById("traveler");
const saveButton = document.getElementById("save");

async function getSettings() {
  return chrome.storage.local.get(["apiBase", "selectedTravelerId"]);
}

async function loadTravelers(apiBase, selectedTravelerId) {
  const response = await fetch(`${apiBase}/extension/bootstrap`);
  if (!response.ok) throw new Error("Dashboard API is not reachable");
  const data = await response.json();
  const selectedId = selectedTravelerId || data.preferences?.selected_traveler_id;
  travelerSelect.innerHTML = data.travelers.map((traveler) => {
    const name = [traveler.first_name, traveler.middle_name, traveler.last_name].filter(Boolean).join(" ");
    return `<option value="${traveler.id}" ${traveler.id === selectedId ? "selected" : ""}>${name}</option>`;
  }).join("");
  statusEl.textContent = `Connected to ${data.workspaces[0]?.name || "workspace"}`;
}

async function init() {
  const settings = await getSettings();
  const apiBase = settings.apiBase || "http://localhost:4173/api";
  apiInput.value = apiBase;
  try {
    await loadTravelers(apiBase, settings.selectedTravelerId);
  } catch (error) {
    statusEl.textContent = error.message;
  }
}

saveButton.addEventListener("click", async () => {
  await chrome.storage.local.set({
    apiBase: apiInput.value.trim() || "http://localhost:4173/api",
    selectedTravelerId: travelerSelect.value
  });
  statusEl.textContent = "Settings saved";
});

init();
