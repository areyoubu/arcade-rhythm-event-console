@echo off
cd /d "%~dp0"
if not exist "node_modules" (
  echo [edge] dependencies missing. Run install.bat first.
  pause
  exit /b 1
)
call remote\start-edge-gui.bat
