# 트러블슈팅 메모

개발/배포 과정에서 실제로 부딪힌 문제와 해결 방법 기록. (최신순 아님, 발생 순서)

---

## 1. 네이티브 호스트 인증 — `--bare` 가 구독 세션을 못 읽음

- **증상:** 호스트에서 `claude`를 실행하면 로그인/과금 관련으로 교정이 실패.
- **원인:** 설계 초안의 `--bare` 플래그는 CLAUDE.md/스킬/설정 자동탐색을 생략하는데, 이때 **OAuth(구독) 세션도 읽지 않아** 인증이 풀린다.
- **해결:** `--bare` 대신 다음 조합 사용.
  - `--system-prompt "<교정 지시>"` (커스텀 CLAUDE.md 개입 차단)
  - `--tools ""` (도구 로딩/권한 프롬프트 방지)
  - 매 호출 시 `ANTHROPIC_API_KEY` 환경변수 제거 → 구독 세션 강제.
- **위치:** `host/host.py` `run_claude()`

## 2. 배치 파일(.bat) 이 실행 자체가 안 됨 — 줄바꿈(LF) 문제

- **증상:** `install.bat` 실행 시 출력이 전혀 없거나 `'---' is not recognized` 류 오류, exit 255.
- **원인:** 에디터가 파일을 **LF 줄바꿈**으로 저장. Windows `cmd`는 `setlocal`·괄호 블록·`if` 구문에서 CRLF가 아니면 오작동한다. **배포 시 수신자 PC에서도 동일하게 깨질** 문제였음.
- **해결:** 모든 `.bat`를 **CRLF**로 변환.
- **점검법:** `head -c 12 install.bat | xxd` → `0d0a`(CRLF)여야 함. `0a`만 있으면 LF.

## 3. 확장 ID 가 PC마다 달라짐 → 네이티브 호스트 연결 실패

- **증상:** 다른 PC(혹은 재로드)에서 `allowed_origins`의 확장 ID가 달라 호스트 연결이 막힘.
- **원인:** 압축해제 확장은 로드 경로에 따라 ID가 생성됨.
- **해결:** RSA 키를 생성해 `manifest.json`에 **공개키(`key` 필드)**를 박아 ID를 고정.
  - 고정 ID: `igigjjnjaoalnlgnbcpbcbojihfdoleh`
  - 비공개키 `key.pem` 은 **저장소/배포에 절대 포함하지 않음** (`.gitignore`). 분실 시 같은 ID 재생성 불가하므로 별도 백업.

## 4. Python 의존성 → 수신자가 Python 설치해야 하는 부담

- **해결:** `host.py` 를 PyInstaller `--onefile` 로 **`host.exe`** 컴파일. 배포 zip에는 exe만 포함, `install.bat`이 매니페스트 `path`를 exe로 지정. 수신자는 Python 불필요.
- **재빌드:** `python -m PyInstaller --onefile --name host host.py`

## 5. 툴바 "현재 입력창 검사" 버튼 무반응 (v0.1.1)

- **증상:** 버튼을 눌러도 아무 반응 없음. (검출조차 안 됨)
- **원인:** 툴바 **팝업을 열면 페이지 포커스가 팝업으로 넘어가** `document.activeElement`가 `body`가 됨 → 검사할 입력칸을 못 찾음. 게다가 못 찾을 때 **조용히 return** 해서 아무 표시도 없었음.
- **해결(`content.js`):**
  - `focusin` + `pointerdown` 으로 포커스 잃기 **전에** 마지막 입력칸 기억.
  - 스크립트 지연 주입 시 로드 시점 `activeElement` 캡처.
  - contenteditable 자식/Shadow DOM 경계, same-origin iframe 내부까지 탐색.
  - 입력칸/텍스트 못 찾으면 **안내 메시지 표시**(조용한 실패 제거).
- **팁:** 가장 안정적인 실행은 입력칸 클릭 후 **Ctrl+Shift+K**(포커스를 안 뺏김).

## 6. 긴 텍스트(수백 자) 검사 시 간헐적 타임아웃 (v0.1.2)

- **증상:** 300자쯤부터 "응답 시간 초과".
- **진단:** 직접 측정 시 300자가 7~10초로 정상 → **항상 느린 게 아니라 간헐적**.
- **원인 추정:** `claude` CLI 시작 시 **자동 업데이트 체크/다운로드·텔레메트리**가 가끔 수십 초 지연.
- **해결(`host.py` 실행 env):**
  - `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `DISABLE_AUTOUPDATER=1`, `DISABLE_TELEMETRY=1`, `DISABLE_ERROR_REPORTING=1`, `DISABLE_BUG_COMMAND=1`
  - 타임아웃 `60s → 180s`.
  - 오버레이에 **경과 시간(초)** 표시로 대기 UX 개선.

## 7. 교정 결과 "적용"이 반영 안 됨 (v0.1.3 ~ v0.1.4)

- **증상:** 검출은 되는데 적용을 눌러도 글자가 안 바뀜.
- **원인:** React/Vue 관리 input·textarea, contenteditable(Draft/Lexical 등)은 **값을 직접 세팅하면 프레임워크가 즉시 되돌림.**
- **해결(`content.js`):**
  - **`document.execCommand("insertText")` 를 1순위** 사용 → 브라우저 입력 파이프라인을 타서 `onChange`/`beforeinput` 정상 발동.
  - 실패 시 **네이티브 value setter + `input`/`change` 이벤트** 폴백(React value tracker 우회).
  - 적용 후 **실제로 값이 바뀌었는지 검증**(before≠after). 실패하면 **"교정문 복사" UI** 제공(어떤 사이트에서도 붙여넣기 가능).
- **자주 헷갈린 점:** 확장을 새로고침해도 **이미 열린 탭에는 옛 content.js가 그대로** 돎 → 반드시 **페이지 새로고침**(또는 탭 새로 열기) 필요.

## 8. 실행 중 버전 확인 장치 (v0.1.4 ~ v0.1.5)

- **왜:** "적용 안 됨"의 상당수가 (7)의 *페이지 미새로고침*이라, 지금 도는 코드 버전을 눈으로 봐야 진단 가능.
- **추가:**
  - **결과 오버레이** 우상단 버전 배지 = 그 **페이지에서 도는 코드** 버전(새로고침 여부 확인).
  - **팝업** 제목 옆 버전 = 크롬에 **설치된 확장** 버전(새 zip 로드 여부 확인).
  - 둘 다 `chrome.runtime.getManifest().version` 에서 읽어 자동 동기화(하드코딩 제거).

---

## 배포/깃 관련 메모

- **배포 zip 빌드:** `package.ps1` 실행 → `ko-spellcheck-dist.zip`. `key.pem`/`manifest_key.txt`/`host.py`/내부 메모는 제외, `host.exe`·`extension/`·`install.bat`·`uninstall.bat`·`README.md` 포함.
- **PowerShell 5.1 함정:** `Compress-Archive` 가 한글 파일명/리터럴에서 깨짐 → 출력 zip은 ASCII 이름, 스크립트 내 한글 리터럴 최소화.
- **릴리스 업로드:** `gh` 미설치. Git Credential Manager에 저장된 토큰(`git credential fill`)으로 GitHub REST API 직접 호출해 Release 생성 + asset 업로드.
- **push 충돌:** GitHub 웹에서 직접 편집한 커밋과 로컬이 갈라지면 **force push 금지**, `git rebase origin/main` 으로 원격 편집을 보존하며 얹기.
- **다운로드 링크:** `releases/latest/download/ko-spellcheck-dist.zip` 는 항상 최신 릴리스 asset을 가리킴.

## 근본 한계 (설계상)

- 각 PC에 **Claude Code CLI + 로그인 + 본인 구독**이 있어야 동작. 로컬 CLI를 부르는 구조라 남의 로그인 세션은 배포 불가.
- 불특정 다수 배포가 필요하면 **API 직접 호출(사용자 키)** 또는 **자체 서버/프록시** 방식으로 전환해야 함(교정 프롬프트/스키마는 재사용 가능).
