(() => {
  const OVERLAY_ID = "__ko-spellcheck-overlay__";
  const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

  let lastEditable = null;

  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") return true;
    if (el.isContentEditable) return true;
    return false;
  }

  // 클릭/포커스한 노드에서 위로 올라가며 편집 가능한 조상 요소를 찾는다
  // (contenteditable 안의 자식 노드를 눌러도 편집 루트를 잡기 위함)
  function editableAncestor(node) {
    let el = node;
    while (el) {
      if (isEditable(el)) return el;
      if (el.parentNode) el = el.parentNode;
      else if (el.host) el = el.host; // ShadowRoot -> 호스트 요소로 경계 넘기
      else break;
    }
    return null;
  }

  function remember(target) {
    const ed = editableAncestor(target);
    if (ed) lastEditable = ed;
  }

  // 포커스가 팝업으로 넘어가기 "전에" 마지막 입력칸을 기억해 둔다.
  // 툴바 팝업을 열면 document.activeElement 가 body 로 바뀌므로 이 추적이 필수다.
  document.addEventListener("focusin", (e) => remember(e.target), true);
  document.addEventListener("pointerdown", (e) => remember(e.target), true);

  // 스크립트가 페이지 로드 후 나중에 주입된 경우(기존 탭)에도 현재 포커스된 칸을 즉시 잡는다
  if (isEditable(document.activeElement)) lastEditable = document.activeElement;

  // same-origin iframe 안쪽까지 파고들어 실제 포커스된 요소를 찾는다
  function deepActiveElement() {
    let a = document.activeElement;
    while (a && a.tagName === "IFRAME") {
      let doc = null;
      try {
        doc = a.contentDocument;
      } catch (e) {
        break; // cross-origin
      }
      if (!doc || !doc.activeElement) break;
      a = doc.activeElement;
    }
    return a;
  }

  function getActiveEditable() {
    const active = deepActiveElement();
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
      <div class="ko-sc-body ko-sc-error">${escapeHtml(message).replace(/\n/g, "<br>")}</div>
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
    if (!el) {
      showError(
        "검사할 입력칸을 찾지 못했어요.\n" +
          "① 글자를 입력하는 칸을 한 번 클릭한 뒤\n" +
          "② 단축키 Ctrl+Shift+K 로 실행해 보세요.\n" +
          "(예전부터 열려 있던 페이지라면 새로고침 후 다시 시도)"
      );
      return;
    }
    const info = getTargetText(el);
    if (!info || !info.text.trim()) {
      showError("입력칸에 검사할 글자가 없어요.\n글자를 입력한 뒤 다시 시도하세요.");
      return;
    }

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
