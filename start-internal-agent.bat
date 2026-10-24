@echo off
cd /d "%~dp0"
if not exist "node_modules" (
  echo [agent] dependencies missing. Run install.bat first.
  pause
  exit /b 1
)
call remote\start-agent-gui.bat
