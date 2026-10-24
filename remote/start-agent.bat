@echo off
cd /d "%~dp0"
title Agent tunnel

echo Tip: double-click the one-click setup script in this folder for GUI configuration.
echo This script reads agent.config.json directly; environment variables no longer override it.
echo If the main console is not running, start start-main.bat in the project root first.
echo.
node agent.mjs
pause
