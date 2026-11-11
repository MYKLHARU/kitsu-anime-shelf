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
if not exist node_modules\sharp (
  call npm ci
  if errorlevel 1 (
    echo Could not install the image library. Check the internet connection and try again.
    pause
    exit /b 1
  )
)
node server.mjs
pause
