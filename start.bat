@echo off
echo Starting Study Table server...
echo.
echo Open http://localhost:8765 in your browser
echo Press Ctrl+C to stop
echo.
cd /d "%~dp0"
python -m http.server 8765
pause
