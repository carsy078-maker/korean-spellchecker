(() => {
  const OVERLAY_ID = "__ko-spellcheck-overlay__";
  const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

  let lastEditable = null;

  document.addEventListener(
    "focusin",
    (e) => {
      const el = e.target;
      if (isEditable(el)) lastEditable = el;
    },
    true
  );

  function isEditable(el) {
    if (!el) return false;
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") return true;
    if (el.isContentEditable) return true;
    return false;
  }

  function getActiveEditable() {
    const active = document.activeElement;
    if (isEditable(active)) return active;
    return lastEditable;
  }

  function getTargetText(el) {
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      const s = el.selectionStart;
      const e = el.selectionEnd;
      const hasSel = s !== null && e !== null && s !== e;
      return {
        kind: "field",
        el,
        text: hasSel ? el.value.slice(s, e) : el.value,
        s: hasSel ? s : 0,
        e: hasSel ? e : el.value.length,
      };
    }
    if (el.isContentEditable) {
      const sel = window.getSelection();
      const hasSel = sel && sel.rangeCount > 0 && !sel.isCollapsed;
      if (hasSel) {
        return { kind: "editable", el, text: sel.toString(), range: sel.getRangeAt(0).cloneRange() };
      }
      return { kind: "editable", el, text: el.innerText, range: null };
    }
    return null;
  }

  function replaceFieldValue(el, newText, s, e) {
    const proto =
      el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    const newValue = el.value.slice(0, s) + newText + el.value.slice(e);
    setter.call(el, newValue);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function replaceEditableValue(el, newText, range) {
    if (range) {
      range.deleteContents();
      range.insertNode(document.createTextNode(newText));
    } else {
      el.innerText = newText;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function escapeHtml(str) {
    return str.replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c]));
  }

  function highlightCorrected(corrected, edits) {
    let html = escapeHtml(corrected);
    for (const edit of edits || []) {
      if (!edit.after) continue;
      const safe = escapeHtml(edit.after);
      const marked = `<mark title="${escapeHtml(edit.reason || "")}">${safe}</mark>`;
      html = html.split(safe).join(marked);
    }
    return html;
  }

  function removeOverlay() {
    const existing = document.getElementById(OVERLAY_ID);
    if (existing) existing.remove();
  }

  function createOverlayShell() {
    removeOverlay();
    const box = document.createElement("div");
    box.id = OVERLAY_ID;
    document.body.appendChild(box);
    return box;
  }

  function showLoading() {
    const box = createOverlayShell();
    box.innerHTML = `
      <div class="ko-sc-header">한국어 맞춤법 검사 <button class="ko-sc-close" data-action="close">✕</button></div>
      <div class="ko-sc-body ko-sc-loading">검사 중...</div>
    `;
    box.querySelector('[data-action="close"]').addEventListener("click", removeOverlay);
  }

  function showError(message) {
    const box = document.getElementById(OVERLAY_ID) || createOverlayShell();
    box.innerHTML = `
      <div class="ko-sc-header">한국어 맞춤법 검사 <button class="ko-sc-close" data-action="close">✕</button></div>
      <div class="ko-sc-body ko-sc-error">오류: ${escapeHtml(message)}</div>
    `;
    box.querySelector('[data-action="close"]').addEventListener("click", removeOverlay);
  }

  function showResult(info, result, onApply) {
    const box = document.getElementById(OVERLAY_ID) || createOverlayShell();
    const edits = result.edits || [];
    const unchanged = !edits.length || result.corrected === info.text;

    const editListHtml = edits
      .map(
        (ed) =>
          `<li><span class="ko-sc-before">${escapeHtml(ed.before)}</span> → <span class="ko-sc-after">${escapeHtml(
            ed.after
          )}</span><div class="ko-sc-reason">${escapeHtml(ed.reason || "")}</div></li>`
      )
      .join("");

    box.innerHTML = `
      <div class="ko-sc-header">한국어 맞춤법 검사 <button class="ko-sc-close" data-action="close">✕</button></div>
      <div class="ko-sc-body">
        ${
          unchanged
            ? `<div class="ko-sc-ok">수정할 내용이 없습니다.</div>`
            : `
          <div class="ko-sc-corrected">${highlightCorrected(result.corrected, edits)}</div>
          <ul class="ko-sc-edits">${editListHtml}</ul>
          <div class="ko-sc-actions">
            <button class="ko-sc-apply" data-action="apply">적용</button>
            <button class="ko-sc-cancel" data-action="cancel">취소</button>
          </div>
        `
        }
      </div>
    `;
    box.querySelector('[data-action="close"]').addEventListener("click", removeOverlay);
    const cancelBtn = box.querySelector('[data-action="cancel"]');
    if (cancelBtn) cancelBtn.addEventListener("click", removeOverlay);
    const applyBtn = box.querySelector('[data-action="apply"]');
    if (applyBtn) {
      applyBtn.addEventListener("click", () => {
        onApply(result.corrected);
        removeOverlay();
      });
    }
  }

  async function handleRunCheck() {
    const el = getActiveEditable();
    if (!el) return;
    const info = getTargetText(el);
    if (!info || !info.text.trim()) return;

    const { enabled = true, model = DEFAULT_MODEL } = await chrome.storage.sync.get({
      enabled: true,
      model: DEFAULT_MODEL,
    });
    if (!enabled) return;

    showLoading();

    chrome.runtime.sendMessage({ type: "CHECK", text: info.text, model }, (resp) => {
      if (chrome.runtime.lastError) {
        showError(chrome.runtime.lastError.message);
        return;
      }
      if (!resp || !resp.ok) {
        showError((resp && resp.error) || "알 수 없는 오류");
        return;
      }
      showResult(info, resp.result, (correctedText) => {
        if (info.kind === "field") {
          replaceFieldValue(info.el, correctedText, info.s, info.e);
        } else {
          replaceEditableValue(info.el, correctedText, info.range);
        }
      });
    });
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "PING") {
      sendResponse({ pong: true });
      return;
    }
    if (msg.type === "RUN_CHECK") {
      handleRunCheck();
    }
  });
})();
