# 한국어 맞춤법 검사기 크롬 확장 프로그램 설계 문서

교정 엔진: 로컬 Claude Code CLI (네이티브 메시징 브리지) / 대상 언어: 한국어 중심 / Manifest V3 / OS: Windows 10 기준

---

## 1. 개요

웹 페이지 입력 필드의 한국어 텍스트를, **API 키나 토큰 과금 없이** 로컬에 설치된
Claude Code CLI로 교정하는 확장 프로그램이다.

브라우저 확장은 직접 `claude` 명령을 실행할 수 없다. 그래서 Chrome의
네이티브 메시징(Native Messaging)으로 로컬 프로그램("네이티브 호스트")과 통신하고,
그 호스트가 `claude -p` 를 실행해 교정 결과를 돌려받는 구조를 쓴다.

핵심 이점:

- 네 Claude 구독(Pro/Max) 로그인 세션을 그대로 사용 → 별도 API 키 불필요, 토큰 과금 없음.
- 교정 로직이 로컬 CLI라 프롬프트/모델을 자유롭게 조정.

핵심 제약:

- Claude Code가 설치·로그인된 본인 PC에서만 동작한다. 타인 배포 불가.
- 네이티브 호스트 등록(레지스트리) 세팅이 필요해 초기 구성이 API 방식보다 번거롭다.

---

## 2. 전체 구조

```
[웹 페이지]
   │  (텍스트 선택 + 단축키 Ctrl+Shift+K)
   ▼
[content script]  ── 텍스트 추출 / UI 오버레이 / 치환
   │  chrome.runtime.sendMessage
   ▼
[background service worker]
   │  chrome.runtime.sendNativeMessage("com.hyphen.spellcheck", {text})
   ▼
[네이티브 호스트 (Python)]  ── stdin으로 요청 수신
   │  subprocess: claude -p "<프롬프트>" --output-format json --bare
   ▼
[Claude Code CLI]  ── 구독 세션으로 교정 수행
   │  JSON stdout
   ▼  (호스트가 파싱해 stdout으로 응답)
[background] → [content script] → 오버레이 표시 → 승인 시 치환
```

| 컴포넌트 | 역할 |
|---|---|
| `manifest.json` | 권한(`nativeMessaging`), 스크립트/단축키 등록 |
| `background.js` | 네이티브 호스트와 송수신, content script 중계 |
| `content.js` | 대상 필드 감지, 텍스트 추출, diff 오버레이, 치환 |
| `content.css` | 오버레이/하이라이트 스타일 |
| `popup.html`/`js` | 켜기/끄기, 검사 실행 |
| `options.html`/`js` | 모델 선택, 교정 강도 설정 (API 키 입력란은 불필요) |
| `host.py` | 네이티브 호스트. stdin/stdout으로 Chrome과 통신, `claude` 실행 |
| `host-manifest.json` | 네이티브 호스트 매니페스트 (레지스트리에 경로 등록) |
| `run_host.bat` | Windows에서 Chrome이 파이썬 호스트를 실행하기 위한 래퍼 |

---

## 3. 인증: 구독 세션을 쓰는 법 (중요)

목표는 API 과금 없이 구독을 쓰는 것이다. 인증 우선순위상
`ANTHROPIC_API_KEY` 환경변수가 설정돼 있으면 CLI가 **그걸 먼저** 쓴다(=API 과금).
따라서 호스트가 `claude`를 실행할 때 **`ANTHROPIC_API_KEY`가 환경에 없어야** 구독
로그인 세션(OAuth 토큰)으로 동작한다.

준비 절차:

1. 터미널에서 `claude` 한 번 실행해 구독 계정으로 로그인해 둔다.
   (Windows 자격 저장 위치: `%USERPROFILE%\.claude\.credentials.json`)
2. 호스트 프로세스 환경에 `ANTHROPIC_API_KEY`를 넣지 않는다.
   (시스템 전역에 이 변수를 걸어놨다면 호스트에서 명시적으로 제거)

> 확인 필요: 구독(Pro/Max) 크레딧을 자동화 백엔드처럼 호출하는 건 개인 도구 수준에선
> 문제없으나, 사용량/레이트리밋 정책은 플랜에 따라 다를 수 있다. 대량 호출 전엔
> 본인 플랜 약관을 확인하는 걸 권장한다.

---

## 4. 네이티브 메시징 프로토콜 기본

Chrome ↔ 호스트는 stdin/stdout으로 **길이 프리픽스 + JSON**을 주고받는다.

- 각 메시지 앞에 4바이트(리틀엔디언 UInt32) 길이가 붙고, 이어서 UTF-8 JSON 본문.
- 호스트→Chrome 단일 메시지 최대 1MB. 교정 텍스트엔 충분.
- `sendNativeMessage`는 1회 요청/1회 응답 후 프로세스 종료.
  (연결 유지가 필요하면 `connectNative`로 포트를 열지만, 맞춤법 검사는 단발성이라 전자로 충분)

---

## 5. 네이티브 호스트 구현 (host.py)

Windows에서 Chrome은 매니페스트의 `path`를 직접 실행한다. `.py`는 바로 실행되지
않으므로 `.bat` 래퍼로 파이썬을 호출한다.

### 5.1 host.py (핵심)

```python
import sys, json, struct, subprocess, os

def read_message():
    raw_len = sys.stdin.buffer.read(4)
    if not raw_len:
        sys.exit(0)
    length = struct.unpack("<I", raw_len)[0]
    return json.loads(sys.stdin.buffer.read(length).decode("utf-8"))

def send_message(obj):
    data = json.dumps(obj).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()

SYSTEM = (
    "너는 한국어 맞춤법/띄어쓰기 교정기다. 입력 문장을 표준 맞춤법에 맞게 교정하고 "
    "아래 JSON만 출력한다. 의미는 바꾸지 말고 맞춤법/띄어쓰기/명백한 오타만 고친다. "
    '형식: {"corrected":"<교정문>","edits":[{"before":"","after":"","reason":""}]}'
)

def correct(text, model):
    env = os.environ.copy()
    env.pop("ANTHROPIC_API_KEY", None)   # 구독 세션 강제

    prompt = f"{SYSTEM}\n\n입력:\n{text}"
    proc = subprocess.run(
        ["claude", "-p", prompt, "--output-format", "json", "--bare", "--model", model],
        capture_output=True, text=True, env=env, encoding="utf-8"
    )
    cli = json.loads(proc.stdout)
    answer = cli["result"]           # 5.3 참고: 실제 필드 확정 필요
    return json.loads(answer)        # {"corrected":..., "edits":[...]}

if __name__ == "__main__":
    msg = read_message()
    result = correct(msg["text"], msg.get("model", "claude-haiku-4-5-20251001"))
    send_message({"ok": True, "result": result})
```

### 5.2 run_host.bat

```bat
@echo off
python "%~dp0host.py"
```

`%~dp0`는 배치 파일이 있는 폴더 경로다. host.py를 같은 폴더에 두면 된다.

### 5.3 CLI 플래그 및 출력 구조 (확인 필요 항목)

문서 작성 시 확인한 내용이지만 버전에 따라 다를 수 있어 실제 설치본에서 검증 권장:

- `-p "<프롬프트>"` : 비대화형 print 모드. stdin 파이프도 가능.
- `--output-format json` : JSON 래퍼로 출력. `stream-json`은 스트리밍용.
- `--model <이름>` : 모델 지정. 맞춤법은 Haiku 계열이 비용/속도상 유리.
- `--bare` : CLAUDE.md/스킬/플러그인/MCP 자동탐색 생략 → 빠른 시작.
  (특히 네가 세팅한 커스텀 CLAUDE.md 규칙이 교정에 끼어드는 걸 막아줌)
- 맞춤법 교정은 도구(Bash/Read/Edit)를 안 쓰므로 권한 승인 프롬프트가 뜨지 않지만,
  혹시 대비하려면 `--permission-mode` 또는 `--allowedTools ""`로 명시 가능.

> 확인 필요: `--output-format json` 결과에서 실제 응답 텍스트가 담기는 필드가
> 최상위 `result`(문자열)인지, `result.content[0].text` 같은 중첩 구조인지는
> 설치 버전마다 다를 수 있다. 구현 전 `claude -p "테스트" --output-format json`을
> 직접 실행해 구조를 눈으로 확인하고 파싱 코드를 맞춰라. (`claude --help`도 병행)

---

## 6. 네이티브 호스트 등록 (Windows)

### 6.1 host-manifest.json

```json
{
  "name": "com.hyphen.spellcheck",
  "description": "Korean spellcheck native host",
  "path": "C:\\tools\\spellcheck\\run_host.bat",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://<EXTENSION_ID>/"]
}
```

- `name`은 background.js에서 호출하는 이름과 정확히 일치해야 한다.
- `path`는 절대경로. 위 `run_host.bat`을 가리킨다.
- `<EXTENSION_ID>`는 확장을 Chrome에 로드한 뒤 `chrome://extensions`에서 확인해 채운다.

### 6.2 레지스트리 등록

Chrome이 매니페스트를 찾도록 레지스트리 키를 만든다. (현재 사용자 기준)

```
HKEY_CURRENT_USER\Software\Google\Chrome\NativeMessagingHosts\com.hyphen.spellcheck
  (기본값) = C:\tools\spellcheck\host-manifest.json
```

명령줄로:

```bat
reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.hyphen.spellcheck" ^
  /ve /t REG_SZ /d "C:\tools\spellcheck\host-manifest.json" /f
```

---

## 7. background.js (핵심)

```javascript
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
          sendResponse(resp);   // { ok: true, result: {corrected, edits} }
        }
      }
    );
    return true;   // 비동기 응답 유지
  }
});
```

---

## 8. manifest.json (핵심)

```json
{
  "manifest_version": 3,
  "name": "한국어 맞춤법 검사기",
  "version": "0.1.0",
  "permissions": ["storage", "activeTab", "scripting", "nativeMessaging"],
  "background": { "service_worker": "background.js" },
  "content_scripts": [
    { "matches": ["<all_urls>"], "js": ["content.js"], "css": ["content.css"] }
  ],
  "options_page": "options.html",
  "action": { "default_popup": "popup.html" },
  "commands": {
    "check-spelling": {
      "suggested_key": { "default": "Ctrl+Shift+K" },
      "description": "선택한 텍스트 맞춤법 검사"
    }
  }
}
```

API 방식과 달리 `host_permissions`(anthropic.com)는 필요 없고, 대신
`nativeMessaging` 권한이 핵심이다.

---

## 9. content script 핵심 로직

### 9.1 대상 텍스트 추출

```javascript
function getTargetText(el) {
  if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
    const { selectionStart: s, selectionEnd: e } = el;
    const hasSel = s !== e;
    return { text: hasSel ? el.value.slice(s, e) : el.value, el, s, e, hasSel };
  }
  if (el.isContentEditable) {
    const sel = window.getSelection();
    return { text: sel.toString(), el, range: sel.getRangeAt(0) };
  }
  return null;
}
```

### 9.2 치환 (프레임워크 대응)

React/Vue 관리 필드는 `.value`만 바꾸면 상태가 안 바뀐다. 네이티브 setter로 값을
넣고 `input` 이벤트를 발생시킨다.

```javascript
function replaceValue(el, newText) {
  const proto = el.tagName === "TEXTAREA"
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
  setter.call(el, newText);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}
```

### 9.3 diff 하이라이팅

`edits`의 `before`를 교정문에서 찾아 `<mark>`로 감싸 오버레이에 렌더. 초기 버전은
문자열 치환으로 충분하고, 정밀도가 필요하면 문자 단위 diff(Myers 등)로 확장한다.

---

## 10. 구현 단계 (권장 순서)

1. 사전 준비: `claude` 로그인 확인, `claude -p "테스트" --output-format json` 직접 실행해
   **출력 JSON 구조 확정**(5.3). 파싱 코드를 이 구조에 맞춘다.
2. 호스트 단독 검증: host.py를 콘솔에서 수동으로 돌려 교정 JSON이 나오는지 확인
   (네이티브 메시징 없이 함수 단위 테스트).
3. 확장 스캐폴딩: manifest + 빈 background/content 로드, `EXTENSION_ID` 확보.
4. 호스트 등록: host-manifest.json 작성 → 레지스트리 등록 → background에서
   `sendNativeMessage`로 왕복 성공시키기 (이 연결이 가장 자주 막히는 지점).
5. content script: 텍스트 추출 → background → 콘솔에 결과 출력.
6. UI: 오버레이 + 하이라이트 + 적용 버튼.
7. 치환: textarea/input/contenteditable 각각 검증(React 사이트 포함).
8. 마무리: 단축키, 로딩 상태, 에러 처리.

가장 흔한 실패 지점은 4번(네이티브 호스트 연결)이다. 순서대로:
`allowed_origins`의 확장 ID 일치 → `path` 절대경로 정확성 → `.bat` 래퍼에서
python 실행 가능 여부 → 레지스트리 키 이름과 `HOST` 문자열 일치를 점검한다.

---

## 11. 주요 리스크 및 검토 사항

| 항목 | 내용 |
|---|---|
| CLI 출력 구조 | `result` 필드 위치는 버전 의존적 → 구현 전 실측 필수 (5.3) |
| 인증 | `ANTHROPIC_API_KEY`가 환경에 있으면 구독 대신 API 과금됨. 호스트에서 제거 (3장) |
| 호스트 연결 실패 | 확장 ID/경로/키 이름 불일치가 주원인. 10-4 체크리스트 참고 |
| 응답 지연 | CLI 콜드스타트 + 모델 추론으로 API 직접호출보다 느릴 수 있음. `--bare`로 완화 |
| 배포 불가 | 본인 PC 전용. 남에게 주려면 API/프록시 방식 별도 필요 |
| JSON 파싱 실패 | 모델이 JSON 외 텍스트를 붙일 수 있음. 프롬프트로 "JSON만" 강제, 필요시 재시도 |
| 개인정보 | 입력 텍스트가 Claude로 전송됨을 사용자에게 고지 |

---

## 12. 확장 아이디어

- 실시간 검사(타이핑 중 debounce) vs 수동 검사 토글
- 교정 이유 툴팁으로 학습 효과 제공
- 자주 틀리는 표현 통계/오답 노트
- 문체 옵션(격식/비격식)을 프롬프트 파라미터로
- `connectNative` 상시 연결로 호스트를 워밍업해 콜드스타트 지연 감소
- (배포 필요 시) 동일 프롬프트/스키마를 API 방식으로 스왑하는 어댑터 계층 분리
