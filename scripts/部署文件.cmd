@echo off
REM Thin double-click wrapper. Real logic lives in scripts\crsecue.ps1
chcp 65001 >nul
setlocal
cd /d "%~dp0.."
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0crsecue.ps1" -Task build %*
set "code=%ERRORLEVEL%"
echo.
if not "%code%"=="0" echo [FAILED] build/verify failed - do NOT upload.
pause
exit /b %code%