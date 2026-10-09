@echo off

REM A .bat runs in whatever directory the CALLER was in, not where the file
REM lives. Without this line `git pull` ran inside the caller's cwd - for a
REM digital being that is its own workspace, which is not a repo, so the whole
REM script failed with "fatal: not a git repository". Same %~dp0 trick RUN.bat
REM already uses.
cd /d "%~dp0"

if not exist ".git" (
  echo [ERROR] No .git next to this script.
  echo         UPDATE.bat must stay in the Nexus repo root.
  echo         Looked in: %~dp0
  pause
  exit /b 1
)

REM Remember where we were so we can report what the pull actually changed.
for /f %%H in ('git rev-parse HEAD') do set "BEFORE=%%H"

git pull
if errorlevel 1 (
  echo.
  echo [ERROR] git pull failed - see the message above. Nothing was updated.
  pause
  exit /b 1
)

for /f %%H in ('git rev-parse HEAD') do set "AFTER=%%H"

if "%BEFORE%"=="%AFTER%" (
  echo.
  echo ==^> Already up to date - nothing changed.
  goto :done
)

REM node_modules is gitignored, so a pull never brings it. Only say something
REM when the lockfile actually moved. Deliberately NOT running `npm ci` here:
REM it takes minutes, and this script is also run non-interactively by digital
REM beings, where a multi-minute child process would stall their turn.
git diff --name-only %BEFORE% %AFTER% | findstr /i "package-lock.json" >nul
if not errorlevel 1 (
  echo.
  echo ==^> Dependencies changed. Run this inside web-app before starting Nexus:
  echo         npm ci
)

echo.
echo ==^> Updated. Restart Nexus if server-side code changed
echo     ^(client-side changes are picked up without a restart^).

:done
REM `pause` is safe here even when a being runs this through a shell: measured
REM 2026-10-09, with stdin at EOF it prints its prompt and falls straight
REM through instead of hanging. Keep it so a human double-clicking the file can
REM still read the output before the window closes.
pause
