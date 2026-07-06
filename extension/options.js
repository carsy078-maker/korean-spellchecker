const modelSelect = document.getElementById("model");
const statusEl = document.getElementById("status");
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

chrome.storage.sync.get({ model: DEFAULT_MODEL }, ({ model }) => {
  modelSelect.value = model;
});

modelSelect.addEventListener("change", () => {
  chrome.storage.sync.set({ model: modelSelect.value }, () => {
    statusEl.textContent = "저장됨";
    setTimeout(() => (statusEl.textContent = ""), 1500);
  });
});
