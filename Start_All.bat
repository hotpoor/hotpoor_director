@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-all.ps1" %*
if errorlevel 1 (
  echo Startup failed. See the message above.
  pause
  exit /b 1
)
