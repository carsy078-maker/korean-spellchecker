# 설치 및 실행 가이드

## 0. 사전 준비 (완료됨)

- `claude` CLI 로그인 확인, `claude -p ... --output-format json` 출력 구조 확인 완료.
- **설계 문서와 다르게 구현한 부분**: 문서(5.3)는 `--bare`를 권장했지만, 실제 테스트 결과
  `--bare`는 `ANTHROPIC_API_KEY`/apiKeyHelper만 인증에 쓰고 **OAuth 구독 세션은 절대 읽지
  않는다** (`claude --help` 확인). 이 프로젝트의 핵심 목표(API 과금 없이 구독 세션 사용)와
  정면으로 충돌하므로 `--bare` 대신 `--system-prompt`(기본 시스템 프롬프트 완전 대체)와
  `--tools ""`(도구 비활성화)를 사용하도록 `host.py`를 작성했다. 이렇게 하면 OAuth 세션을
  유지하면서도 CLAUDE.md/환경 정보가 프롬프트에 끼어드는 것을 막을 수 있다.
- 모델 응답이 ` ```json ... ``` ` 코드블록으로 감싸져 오는 경우가 있어 `host.py`가
  이를 자동으로 벗겨내고, 실패 시 문자열에서 `{...}` 구간만 추출해 한 번 더 파싱을 시도한다.
- `host.py`를 콘솔에서 네이티브 메시징 프레이밍(4바이트 길이 + JSON)으로 직접 호출해
  정상 동작을 확인함 (구독 세션으로 실행되어 API 과금 없음).

## 1. 확장 프로그램 로드 및 EXTENSION_ID 확보

1. Chrome에서 `chrome://extensions` 접속.
2. 우측 상단 "개발자 모드" 켜기.
3. "압축해제된 확장 프로그램을 로드합니다" 클릭 → 이 폴더의 `extension` 하위 폴더 선택
   (`C:\Users\carsy\Desktop\spellchecker\extension`).
4. 로드된 카드에 표시되는 ID(32자 영문 문자열)를 복사한다.

## 2. 네이티브 호스트 매니페스트에 ID 반영

`host\host-manifest.json`의 `__EXTENSION_ID__`를 방금 복사한 ID로 교체한다.
(이 저장소는 이미 파일을 만들어 뒀으니, ID를 알려주면 대신 수정해줄 수 있음.)

## 3. 레지스트리에 네이티브 호스트 등록

PowerShell 또는 cmd에서 (현재 사용자 기준, 관리자 권한 불필요):

```bat
reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.hyphen.spellcheck" ^
  /ve /t REG_SZ /d "C:\Users\carsy\Desktop\spellchecker\host\host-manifest.json" /f
```

확인:

```bat
reg query "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.hyphen.spellcheck"
```

## 4. 동작 확인

1. 아무 웹페이지의 입력창(예: Google 검색창, textarea)을 클릭.
2. `Ctrl+Shift+K` 또는 확장 아이콘 → "현재 입력창 검사" 클릭.
3. 우측 하단에 오버레이가 뜨고, 잠시 후 교정 결과가 표시됨.
4. "적용"을 누르면 입력창 내용이 교정문으로 바뀐다.

문제가 생기면 `host\host.log`에 에러가 기록된다 (`host.py`가 예외 발생 시 로깅).

가장 흔한 실패 지점(설계 문서 10장과 동일):

- `host-manifest.json`의 `allowed_origins`와 실제 확장 ID 불일치
- `host-manifest.json`의 `path` 오타/상대경로 사용
- 레지스트리 키 이름(`com.hyphen.spellcheck`)과 `background.js`의 `HOST` 상수 불일치
- `run_host.bat`에서 `python` 실행 실패 (PATH 문제 — 이 PC에서는 확인 완료)

## 5. 설정

확장 아이콘 → "설정 열기"에서 모델을 변경할 수 있다 (기본값: Haiku, 속도/품질 균형).
API 키 입력란은 의도적으로 없음 — 구독 세션을 그대로 쓰기 때문.

## 참고: 비용에 대해

`claude -p ... --output-format json` 응답에는 `total_cost_usd` 필드가 항상 포함되지만,
이는 참고용 추정치이고 실제 청구 여부는 `ANTHROPIC_API_KEY` 존재 여부로 결정된다.
`host.py`는 매 호출마다 이 환경변수를 명시적으로 제거하므로 구독(Pro/Max) 세션으로
동작하며 별도 API 과금이 발생하지 않는다. 단, 대량/고빈도 호출 시 구독 플랜의
사용량 정책은 별도로 확인 권장 (설계 문서 3장 참고).
