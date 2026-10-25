@echo off
cd /d "%~dp0"

rem Main console (internal machine).
rem remoteToken is read from remote\agent.config.json by start-main.mjs.
rem Backend login password is stored (scrypt-hashed) in config\config.json server.adminPasswordHash.
rem Change it with: node tools\set-admin-password.mjs

node remote\start-main.mjs
pause
