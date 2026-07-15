const enabledCheckbox = document.getElementById("enabled");
const autoCheckCheckbox = document.getElementById("autoCheck");
const runButton = document.getElementById("run");

document.getElementById("ver").textContent = "v" + chrome.runtime.getManifest().version;

chrome.storage.sync.get({ enabled: true, autoCheck: false }, ({ enabled, autoCheck }) => {
  enabledCheckbox.checked = enabled;
  autoCheckCheckbox.checked = autoCheck;
});

enabledCheckbox.addEventListener("change", () => {
  chrome.storage.sync.set({ enabled: enabledCheckbox.checked });
});

autoCheckCheckbox.addEventListener("change", () => {
  chrome.storage.sync.set({ autoCheck: autoCheckCheckbox.checked });
});

async function ensureContentScript(tabId) {
  // content script가 이미 있으면 ping 성공, 없으면 주입 후 재시도
  try {
    await chrome.tabs.sendMessage(tabId, { type: "PING" });
    return true;
  } catch (e) {
    try {
      await chrome.scripting.insertCSS({ target: { tabId }, files: ["content.css"] });
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
      return true;
    } catch (e2) {
      return false;
    }
  }
}

runButton.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;

  const ok = await ensureContentScript(tab.id);
  if (!ok) {
    alert("이 페이지에서는 실행할 수 없습니다 (chrome:// 등 특수 페이지이거나 권한 없음).");
    return;
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { type: "RUN_CHECK" });
    window.close();
  } catch (e) {
    alert("실행 실패: " + e.message);
  }
});
