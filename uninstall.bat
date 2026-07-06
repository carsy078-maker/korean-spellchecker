@echo off
chcp 65001 >nul
set "HOSTNAME=com.hyphen.spellcheck"
echo 네이티브 호스트 레지스트리 등록을 제거합니다...
reg delete "HKCU\Software\Google\Chrome\NativeMessagingHosts\%HOSTNAME%" /f >nul 2>&1
echo 완료. Chrome의 chrome://extensions 에서 확장도 직접 삭제하세요.
pause
