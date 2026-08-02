@echo off
echo ============================================
echo   My Study Table - Electron App
echo ============================================
echo.
echo Installing dependencies...
call npm install
echo.
echo Starting Electron app...
call npm start 2>&1 | findstr /V /C:"Qt:" /C:"log4cplus" /C:"AdSyncNamespace"
pause

