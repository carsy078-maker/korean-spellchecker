const HOST = "com.hyphen.spellcheck";

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "CHECK") {
    chrome.runtime.sendNativeMessage(
      HOST,
      { text: msg.text, model: msg.model },
      (resp) => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse(resp);
        }
      }
    );
    return true; // 비동기 응답 유지
  }
});

async function ensureAndRun(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "PING" });
  } catch (e) {
    try {
      await chrome.scripting.insertCSS({ target: { tabId }, files: ["content.css"] });
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    } catch (e2) {
      return; // chrome:// 등 주입 불가 페이지
    }
  }
  chrome.tabs.sendMessage(tabId, { type: "RUN_CHECK" }).catch(() => {});
}

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "check-spelling") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;
  ensureAndRun(tab.id);
});
