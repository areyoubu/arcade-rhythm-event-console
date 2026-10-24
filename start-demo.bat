@echo off
cd /d "%~dp0"
if not exist "node_modules" (
  echo [demo] dependencies missing. Run install.bat first.
  pause
  exit /b 1
)
echo [demo] starting mock OBS/vMix in one window and the console in another...
start "Mock OBS / vMix" cmd /k "npm run mock"
timeout /t 2 >nul
start "Main console" cmd /k "node server\index.js"
echo.
echo [demo] open http://127.0.0.1:3000
echo [demo] enable OBS / vMix / Replay / Transitions in Settings - Feature switches.
pause
