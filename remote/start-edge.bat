@echo off
cd /d "%~dp0"
title Edge public entry

echo Tip: double-click the one-click setup script in this folder for GUI configuration.
echo This script reads edge.config.json directly; environment variables no longer override it.
echo.
node edge.mjs
pause
