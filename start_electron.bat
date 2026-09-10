@echo off
setlocal
cd /d "%~dp0"
title My Study Table
echo ============================================
echo   My Study Table - Electron App
echo ============================================
echo Project: %CD%
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo ERROR: Node.js was not found. Install Node.js and try again.
  goto failed
)
where npm >nul 2>&1
if errorlevel 1 (
  echo ERROR: npm was not found. Repair your Node.js installation.
  goto failed
)

if exist "node_modules\.bin\electron.cmd" goto runtime
echo Installing missing dependencies...
call npm install
if errorlevel 1 goto failed

:runtime
if exist "node_modules\electron\dist\electron.exe" goto launch
echo Downloading missing Electron runtime. This may take a few minutes...
node "node_modules\electron\install.js"
if errorlevel 1 goto failed
if not exist "node_modules\electron\dist\electron.exe" (
  echo ERROR: Electron runtime is still missing. Check your network or proxy.
  goto failed
)

:launch
set ELECTRON_RUN_AS_NODE=
echo Starting My Study Table...
call npm start
if errorlevel 1 goto failed
exit /b 0

:failed
echo.
echo Startup failed. Please keep the error messages above for troubleshooting.
pause
exit /b 1

