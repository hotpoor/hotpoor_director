@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\restart-dev.ps1" %*
if errorlevel 1 (
  echo Restart failed. See the message above.
  pause
  exit /b 1
)
