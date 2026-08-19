const apiInput = document.getElementById("api-base");
const statusEl = document.getElementById("status");
const travelerSelect = document.getElementById("traveler");
const saveButton = document.getElementById("save");
const startButton = document.getElementById("start");

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

startButton.addEventListener("click", async () => {
  startButton.disabled = true;
  statusEl.textContent = "Starting Fly on the current checkout…";
  try {
    await chrome.storage.local.set({
      apiBase: apiInput.value.trim() || "http://localhost:4173/api",
      selectedTravelerId: travelerSelect.value
    });
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!Number.isInteger(tab?.id)) throw new Error("No active checkout tab is available.");
    const result = await chrome.runtime.sendMessage({
      type: "ATW_START_CHECKOUT",
      tabId: tab.id,
      autoStart: true
    });
    if (!result?.ok) throw new Error(result?.error || result?.code || "Fly could not start on this tab.");
    statusEl.textContent = result.startStatus === "started"
      ? "Fly started on the current checkout"
      : "Fly was injected and is starting";
    window.close();
  } catch (error) {
    statusEl.textContent = error.message;
    startButton.disabled = false;
  }
});

init();
