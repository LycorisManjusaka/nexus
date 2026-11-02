@echo off

REM ---------------------------------------------------------------------------
REM MIGRATE_TEXT_1_CHECK.bat   --   STEP 1 of 2.  WRITES NOTHING.
REM
REM Text attachments currently store the same bytes TWICE: once inline in the
REM conversation JSON, once in the attachment store. The inline copy is ~26% of
REM every conversation that has one, and it crosses the network on every open.
REM
REM This step only LOOKS. It prints which conversations would change and how
REM much each one would shrink. Nothing is written - not one byte, anywhere.
REM Read the output, then run MIGRATE_TEXT_2_APPLY.bat if it looks right.
REM
REM It targets the local_data NEXT TO THIS SCRIPT, so running it inside another
REM installation's folder checks THAT installation.
REM
REM Same %~dp0 trick UPDATE.bat and RUN.bat use: a .bat runs in whatever
REM directory the CALLER was in, not where the file lives.
REM ---------------------------------------------------------------------------

cd /d "%~dp0web-app"

if not exist "scripts\migrate-drop-text-data.mjs" (
  echo [ERROR] Migration script not found.
  echo         This .bat must stay in the Nexus repo root.
  echo         Looked in: %~dp0web-app\scripts\
  pause
  exit /b 1
)

if not exist "..\local_data\beings" (
  echo [ERROR] No local_data\beings next to this script.
  echo         Expected: %~dp0local_data\beings
  echo         If that folder exists but is unreadable, run this as the
  echo         account that owns the store.
  pause
  exit /b 1
)

echo ==^> CHECKING ONLY. Nothing will be written.
echo.

node scripts\migrate-drop-text-data.mjs
if errorlevel 1 (
  echo.
  echo [ERROR] The check failed - see the message above. Nothing was written.
  pause
  exit /b 1
)

echo.
echo ==^> Done checking. Nothing was written.
echo     If the numbers look right, run MIGRATE_TEXT_2_APPLY.bat
pause
