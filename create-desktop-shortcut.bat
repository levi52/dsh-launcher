@echo off
setlocal
cd /d "%~dp0"

rem All real logic lives in scripts\create-desktop-shortcut.ps1 (UTF-8 with BOM),
rem so cmd never has to parse long commands or non-ASCII text.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\create-desktop-shortcut.ps1"

if errorlevel 1 (
  echo [ERROR] Failed to create the shortcut. See messages above.
  pause
  exit /b 1
)
echo.
echo Done. The shortcut has been created on your desktop.
pause
