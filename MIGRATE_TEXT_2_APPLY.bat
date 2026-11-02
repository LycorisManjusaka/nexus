@echo off

REM ---------------------------------------------------------------------------
REM MIGRATE_TEXT_2_APPLY.bat   --   STEP 2 of 2.  THIS ONE WRITES.
REM
REM Run MIGRATE_TEXT_1_CHECK.bat first and read its output.
REM
REM WHAT IT DOES
REM Replaces the inline copy of each text attachment with a 501-character
REM preview, keeping the `ref` that already points at the same bytes in the
REM attachment store. Conversations get ~26% smaller; nothing is lost.
REM
REM BEFORE DROPPING ANYTHING it verifies, for every single attachment, that the
REM store file exists and its bytes are identical to the inline copy. If even
REM one check fails, that whole conversation is skipped and left untouched.
REM
REM WHAT IS NOT TOUCHED
REM   - attachments with no ref in the store        (7 in this house)
REM   - attachments with no recorded size           (1 in this house)
REM   - attachments already 501 characters or less  (nothing to save)
REM
REM YOU CAN UNDO THIS
REM Every original is copied to local_data\pre_migration_dropdata\<being>\
REM BEFORE the new version is swapped in. To undo, copy them back over
REM local_data\beings\<being>\logs\.
REM
REM SAFE TO RE-RUN. A second run finds nothing left to do.
REM
REM NEXUS CAN STAY RUNNING, but do NOT run this while a being is mid-turn.
REM An open tab notices the new version and pulls it in by itself; press
REM Ctrl+Shift+R in it afterwards to be sure.
REM
REM IMPORTANT: the NEXUS code must already know about the preview shape. If
REM this installation has not pulled the 2026-11-01 update yet, run UPDATE.bat
REM first - otherwise text previews will render empty until you do.
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
  pause
  exit /b 1
)

REM Confirm the checkout understands `textPreview`.
REM
REM This is NEARLY a tautology -- that file and this .bat arrive in the same
REM commit -- and it is kept only for the case it does catch: this .bat copied
REM by hand into an older installation. UPDATE.bat already gets carried around
REM that way. It does NOT catch a dev server holding older code in memory;
REM nothing a .bat can read would. That is what the Ctrl+Shift+R at the end is
REM for.
findstr /m "textPreview" "src\lib\attachmentText.ts" >nul 2>&1
if errorlevel 1 (
  echo [ERROR] This installation does not have the preview-shape code yet.
  echo         Run UPDATE.bat first, then try again.
  echo.
  echo         Missing: web-app\src\lib\attachmentText.ts
  pause
  exit /b 1
)

echo ==^> THIS WILL MODIFY CONVERSATION FILES.
echo     Originals are copied to local_data\pre_migration_dropdata\ first.
echo.
echo     Press Ctrl+C to stop, or
pause

node scripts\migrate-drop-text-data.mjs --write
if errorlevel 1 (
  echo.
  echo [ERROR] Some conversations FAILED - see the messages above.
  echo         Those originals were left untouched. The ones marked with a
  echo         check mark did succeed.
  pause
  exit /b 1
)

echo.
echo ==^> Done. If a NEXUS tab is open, press Ctrl+Shift+R in it now.
pause
