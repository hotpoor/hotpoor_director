@echo off
setlocal
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=
if not exist "node_modules\electron\dist\electron.exe" (
  echo Electron is missing. Run scripts\setup.ps1 first.
  pause
  exit /b 1
)
if not exist ".venv\Scripts\python.exe" (
  echo Python environment is missing. Run scripts\setup.ps1 first.
  pause
  exit /b 1
)
"node_modules\electron\dist\electron.exe" . --dev
