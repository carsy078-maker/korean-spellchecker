(() => {
  const OVERLAY_ID = "__ko-spellcheck-overlay__";
  const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
  const VERSION = "0.1.4";

  let lastEditable = null;
  let loadingTimer = null;

  function headerHtml() {
    return (
      `<div class="ko-sc-header">한국어 맞춤법 검사 ` +
      `<span class="ko-sc-ver">v${VERSION}</span>` +
      `<button class="ko-sc-close" data-action="close">✕</button></div>`
    );
  }

  function clearLoadingTimer() {
    if (loadingTimer) {
      clearInterval(loadingTimer);
      loadingTimer = null;
    }
  }

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

  // 입력칸(input/textarea)에 교정문을 적용한다. 실제로 값이 바뀌면 true 를 반환한다.
  function applyToField(el, newText, s, e) {
    el.focus();
    const before = el.value;
    const len = before.length;
    const start = Math.min(s, len);
    const end = Math.min(e, len);
    try {
      el.setSelectionRange(start, end);
    } catch (_) {
      /* 일부 input type 은 setSelectionRange 미지원 */
    }

    // 방법 1: execCommand insertText → 브라우저 입력 파이프라인을 타서
    // React/Vue 등 프레임워크의 onChange 가 정상 발동한다.
    try {
      if (document.execCommand("insertText", false, newText) && el.value !== before) {
        return true;
      }
    } catch (_) {
      /* 폴백으로 진행 */
    }

    // 방법 2: 네이티브 value setter + 이벤트 강제 발생 (React value tracker 우회)
    try {
      const proto =
        el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      setter.call(el, before.slice(0, start) + newText + before.slice(end));
      el.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "insertText", data: newText })
      );
      el.dispatchEvent(new Event("change", { bubbles: true }));
      if (el.value !== before) return true;
    } catch (_) {
      /* 실패 */
    }
    return false;
  }

  // contenteditable 에 교정문을 적용한다. 실제로 내용이 바뀌면 true 를 반환한다.
  function applyToEditable(el, newText, range) {
    el.focus();
    const before = el.innerText;
    const sel = window.getSelection();
    sel.removeAllRanges();
    if (range) {
      sel.addRange(range);
    } else {
      const r = document.createRange();
      r.selectNodeContents(el);
      sel.addRange(r);
    }

    // 방법 1: execCommand insertText → Draft.js/Lexical 등 프레임워크 에디터도 반영됨
    try {
      if (document.execCommand("insertText", false, newText) && el.innerText !== before) {
        return true;
      }
    } catch (_) {
      /* 폴백으로 진행 */
    }

    // 방법 2: DOM 직접 조작
    try {
      if (range) {
        range.deleteContents();
        range.insertNode(document.createTextNode(newText));
      } else {
        el.innerText = newText;
      }
      el.dispatchEvent(new InputEvent("input", { bubbles: true }));
      if (el.innerText !== before) return true;
    } catch (_) {
      /* 실패 */
    }
    return false;
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
    clearLoadingTimer();
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
      ${headerHtml()}
      <div class="ko-sc-body ko-sc-loading">검사 중... <span class="ko-sc-elapsed">0초</span><div class="ko-sc-hint">텍스트가 길면 시간이 걸릴 수 있어요.</div></div>
    `;
    box.querySelector('[data-action="close"]').addEventListener("click", removeOverlay);
    const started = Date.now();
    const elapsedEl = box.querySelector(".ko-sc-elapsed");
    loadingTimer = setInterval(() => {
      if (!elapsedEl.isConnected) return;
      elapsedEl.textContent = Math.round((Date.now() - started) / 1000) + "초";
    }, 1000);
  }

  function showError(message) {
    clearLoadingTimer();
    const box = document.getElementById(OVERLAY_ID) || createOverlayShell();
    box.innerHTML = `
      ${headerHtml()}
      <div class="ko-sc-body ko-sc-error">${escapeHtml(message).replace(/\n/g, "<br>")}</div>
    `;
    box.querySelector('[data-action="close"]').addEventListener("click", removeOverlay);
  }

  // 자동 적용이 실패한 사이트를 위해 교정문을 복사할 수 있게 보여준다.
  function showCopyFallback(correctedText) {
    const box = document.getElementById(OVERLAY_ID) || createOverlayShell();
    box.innerHTML = `
      ${headerHtml()}
      <div class="ko-sc-body">
        <div class="ko-sc-error">이 사이트에서는 자동 적용이 안 돼요.<br>아래 교정문을 복사해 직접 붙여넣으세요.</div>
        <textarea class="ko-sc-copybox" readonly></textarea>
        <div class="ko-sc-actions">
          <button class="ko-sc-apply" data-action="copy">교정문 복사</button>
          <button class="ko-sc-cancel" data-action="cancel">닫기</button>
        </div>
      </div>
    `;
    const ta = box.querySelector(".ko-sc-copybox");
    ta.value = correctedText;
    box.querySelector('[data-action="close"]').addEventListener("click", removeOverlay);
    box.querySelector('[data-action="cancel"]').addEventListener("click", removeOverlay);
    box.querySelector('[data-action="copy"]').addEventListener("click", async (ev) => {
      try {
        await navigator.clipboard.writeText(correctedText);
      } catch (_) {
        ta.focus();
        ta.select();
        document.execCommand("copy");
      }
      ev.target.textContent = "복사됨 ✓";
    });
  }

  function showResult(info, result, onApply) {
    clearLoadingTimer();
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
      ${headerHtml()}
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
        const applied = onApply(result.corrected);
        if (applied) {
          removeOverlay();
        } else {
          // 자동 적용 실패 → 복사 폴백 제공
          showCopyFallback(result.corrected);
        }
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
          return applyToField(info.el, correctedText, info.s, info.e);
        }
        return applyToEditable(info.el, correctedText, info.range);
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
