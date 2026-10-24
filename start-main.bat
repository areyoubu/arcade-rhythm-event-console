@echo off
cd /d "%~dp0"

if not exist "node_modules" (
  echo [main] dependencies missing. Run install.bat first.
  pause
  exit /b 1
)
if not exist "config\config.json" if exist "config\config.example.json" (
  copy /Y "config\config.example.json" "config\config.json" >nul
)

echo [main] http://127.0.0.1:3000
echo [main] default admin password: Admin (change it at /admin-setup)
node server\index.js
pause
