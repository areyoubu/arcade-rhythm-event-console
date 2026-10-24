@echo off
setlocal
cd /d "%~dp0"
title Remote entry (direct mode)

rem Main console address. Same machine: 127.0.0.1:3000
set "REMOTE_UPSTREAM=http://127.0.0.1:3000"
rem Public port. Only forward this port on the router.
set "REMOTE_PORT=8787"
rem Must match the main console LP_REMOTE_TOKEN.
set "REMOTE_TOKEN=CHANGE-ME-TO-A-LONG-RANDOM-STRING"
rem Set to 1 only when behind a trusted Caddy / nginx / Cloudflare proxy.
set "REMOTE_TRUST_PROXY=0"

echo [remote] upstream=%REMOTE_UPSTREAM% port=%REMOTE_PORT%
node index.mjs
pause
