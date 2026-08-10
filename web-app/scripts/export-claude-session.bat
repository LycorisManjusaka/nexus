@echo off
REM ---------------------------------------------------------------------------
REM Export a Claude Code session to a Nexus-importable Cairn_<N>.md
REM
REM Double-click this file, or run it from any directory.
REM
REM %~dp0 is the folder THIS batch file lives in, so the .mjs is addressed
REM absolutely. The previous version used a path relative to the CURRENT
REM directory, which broke when run from inside scripts\ (it looked for
REM scripts\scripts\). The .mjs resolves its own data paths internally, so the
REM working directory genuinely does not matter.
REM ---------------------------------------------------------------------------
setlocal

REM UTF-8, so Japanese entity names and box-drawing characters render correctly.
chcp 65001 >nul

set "SCRIPT=%~dp0export-claude-session.mjs"

echo.
node "%SCRIPT%"
if errorlevel 1 goto :fail

echo.
set "PICK="
set /p "PICK=Session number to export (Enter to cancel): "
if not defined PICK goto :cancelled

echo.
echo --- preview (nothing written yet) ---
node "%SCRIPT%" --pick=%PICK%
if errorlevel 1 goto :fail

echo.
set "CONFIRM="
set /p "CONFIRM=Write this file? (y/N): "
if /i not "%CONFIRM%"=="y" goto :cancelled

echo.
node "%SCRIPT%" --pick=%PICK% --write
if errorlevel 1 goto :fail
goto :done

:cancelled
echo.
echo Cancelled - nothing was written.
goto :done

:fail
echo.
echo Script reported an error (see above).

:done
echo.
pause
endlocal
