@echo off
setlocal
cd /d "%~dp0"
title Public side - Edge setup

where node >nul 2>nul
if errorlevel 1 goto :no_node

rem Install ws when only the remote/ folder was copied to this machine.
if not exist "node_modules\ws" if not exist "..\node_modules\ws" (
  echo [setup] First run: installing dependency ws ...
  call npm install --omit=dev
  if errorlevel 1 goto :install_fail
)

echo [setup] Opening local setup console: http://127.0.0.1:8788/
echo.
node setup.mjs --role=edge --auto-start
set "CODE=%errorlevel%"
echo.
echo [setup] Setup console exited (code %CODE%).
pause
exit /b %CODE%

:no_node
echo [setup] Node.js not found. Install Node.js 18 or newer first.
pause
exit /b 1

:install_fail
echo.
echo [setup] Dependency install failed. Run: npm install --omit=dev
pause
exit /b 1
