@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul

echo ============================================
echo   한국어 맞춤법 검사기 - 설치
echo ============================================
echo.

set "ROOT=%~dp0"
set "HOSTDIR=%ROOT%host"
set "MANIFEST=%HOSTDIR%\host-manifest.json"
set "HOSTEXE=%HOSTDIR%\host.exe"
set "EXTID=igigjjnjaoalnlgnbcpbcbojihfdoleh"
set "HOSTNAME=com.hyphen.spellcheck"

REM --- 1. host.exe 존재 확인 ---
if not exist "%HOSTEXE%" (
  echo [실패] host.exe 를 찾을 수 없습니다. 압축을 폴더째로 풀었는지 확인하세요.
  echo.
  pause
  exit /b 1
)
echo [확인] 프로그램 파일 발견

REM --- 2. Claude CLI 확인 ---
where claude >nul 2>&1
if errorlevel 1 (
  echo [안내] Claude Code 프로그램이 아직 없습니다.
  echo        이 확장은 당신의 Claude 로그인으로 맞춤법을 고칩니다.
  echo        먼저 Claude Code를 설치하고 로그인해야 작동합니다.
  echo        설명서.txt 의 "먼저 준비할 것" 부분을 참고하세요.
  echo.
  echo        (지금 없어도 설치는 계속 진행합니다. 나중에 Claude 설치 후
  echo         이 파일을 다시 실행하지 않아도 됩니다.)
  echo.
) else (
  echo [확인] Claude Code 발견
)

REM --- 3. host-manifest.json 을 이 PC 경로에 맞게 생성 ---
echo [작업] 설정 파일 생성 중...
set "HOSTEXE_ESC=%HOSTEXE:\=\\%"
(
  echo {
  echo   "name": "%HOSTNAME%",
  echo   "description": "Korean spellcheck native host",
  echo   "path": "!HOSTEXE_ESC!",
  echo   "type": "stdio",
  echo   "allowed_origins": ["chrome-extension://%EXTID%/"]
  echo }
) > "%MANIFEST%"

REM --- 4. 레지스트리 등록 (현재 사용자, 관리자 권한 불필요) ---
echo [작업] 크롬 연결 등록 중...
reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\%HOSTNAME%" /ve /t REG_SZ /d "%MANIFEST%" /f >nul
if errorlevel 1 (
  echo [실패] 등록에 실패했습니다.
  pause
  exit /b 1
)

echo.
echo ============================================
echo   설치 완료!
echo ============================================
echo.
echo 이제 크롬에 확장을 한 번만 등록하면 됩니다:
echo   1. 크롬 주소창에 다음을 입력:  chrome://extensions
echo   2. 오른쪽 위 "개발자 모드" 스위치를 켜기
echo   3. "압축해제된 확장 프로그램 로드" 버튼 클릭
echo   4. 아래 폴더를 선택:
echo        %ROOT%extension
echo.
echo 사용법: 웹사이트 입력칸을 클릭한 뒤 키보드로  Ctrl + Shift + K
echo.
echo 자세한 내용은 "설명서.txt" 를 참고하세요.
echo.
pause
