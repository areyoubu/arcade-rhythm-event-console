@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto :no_node

if not exist "config\config.json" if exist "config\config.example.json" (
  copy /Y "config\config.example.json" "config\config.json" >nul
  echo [install] created config\config.json from example
)

echo [install] installing dependencies...
call npm install
if errorlevel 1 goto :fail

echo.
echo [install] done.
echo   Start the console:  start-main.bat
echo   Default admin password: Admin  (change it at /admin-setup)
pause
exit /b 0

:no_node
echo [install] Node.js not found. Install Node.js 20.11 or newer first.
pause
exit /b 1

:fail
echo.
echo [install] npm install failed. Check your network and try again.
pause
exit /b 1
