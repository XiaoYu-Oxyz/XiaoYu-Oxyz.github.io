@echo off
REM Thin double-click wrapper. Real logic lives in scripts\crsecue.ps1
chcp 65001 >nul
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\crsecue.ps1" -Task release %*
set "code=%ERRORLEVEL%"
echo.
if not "%code%"=="0" echo [FAILED] release failed - do NOT upload.
pause
exit /b %code%