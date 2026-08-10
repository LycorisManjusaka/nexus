@echo off

cd /d "%~dp0web-app"

if not exist "package.json" (
  echo [ERROR] web-app not found next to this script.
  echo         Expected: %~dp0web-app
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [ERROR] node_modules is missing in web-app.
  echo         node_modules is gitignored, so `git pull` does NOT bring it.
  echo         Run this once inside web-app:  npm ci
  pause
  exit /b 1
)

REM Marker so the running instance can identify itself later.
set NEXUS_INSTANCE=default

npm run dev -- -p 3000
pause
