@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Install Node.js 22 or newer from https://nodejs.org/ and try again.
  pause
  exit /b 1
)
echo Open http://127.0.0.1:47861/ after the server starts.
echo Keep this window open while using the add-on. Press Ctrl+C to stop.
node server.mjs
pause
