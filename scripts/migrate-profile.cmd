@echo off
setlocal
echo Restoring saved Computer Use configuration after the package rename.
echo A backup is created before changing the desktop profile.
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0migrate-profile.ps1" -Apply
set "CU_RESULT=%ERRORLEVEL%"
pause
exit /b %CU_RESULT%
