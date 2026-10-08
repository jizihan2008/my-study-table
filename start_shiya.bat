@echo off
setlocal
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=
rem Always use the real MST profile, even when launched from a test shell.
set MST_E2E=
set MST_USER_DATA_PATH=
set MST_PET_E2E=
set MST_PET_PREVIEW=
if not exist "node_modules\electron\dist\electron.exe" (
  echo Electron runtime is missing. Please run start_electron.bat first.
  pause
  exit /b 1
)
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0." --show-pet --pet-only
