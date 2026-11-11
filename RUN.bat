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
  echo         Run INSTALL.bat once, or run this inside web-app:  npm ci
  pause
  exit /b 1
)

REM Marker so the running instance can identify itself later.
set NEXUS_INSTANCE=default

REM Clear the dev build cache before starting. On 2026-11-11 a stylesheet
REM change arrived by git pull and the server kept serving the old CSS out of
REM .next across several restarts; deleting .next fixed it. Cost: the first
REM page after each start compiles from scratch and is slower.
REM Skipped when something already listens on the port, so a second launch
REM cannot delete the cache under a running server.
netstat -ano | findstr /R /C:":3000 .*LISTENING" >nul
if errorlevel 1 if exist ".next" rmdir /s /q ".next"

REM Open the browser once the dev server is actually answering on :3000.
REM Runs detached so it can poll while `npm run dev` holds this window.
REM Polls for up to ~90s; if the server never comes up, it just gives up
REM silently rather than opening a browser tab pointed at nothing.
echo Nexus is starting - your browser will open when the server is ready.
start "" /b powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$url='http://localhost:3000/';" ^
  "for ($i=0; $i -lt 90; $i++) {" ^
  "  try { Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2 | Out-Null; Start-Process $url; break }" ^
  "  catch { Start-Sleep -Seconds 1 } }"

npm run dev -- -p 3000
pause
