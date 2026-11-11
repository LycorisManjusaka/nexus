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

REM node_modules is gitignored, so a pull never brings it. Only act when the
REM lockfile actually moved.
git diff --name-only %BEFORE% %AFTER% | findstr /i "package-lock.json" >nul
if errorlevel 1 goto :nodeps

echo.
echo ==^> Dependencies changed - node_modules must be reinstalled with "npm ci".
echo.
echo     Do this ONLY with the Nexus server for THIS tree STOPPED. npm ci wipes
echo     node_modules: under a running server it breaks that server, and a being
echo     that runs this inside its OWN installation would delete the environment
echo     hosting its own turn. That is why it is never automatic.
echo.
REM `set /p` with stdin at EOF - a being running this through a shell, or a plain
REM double-click with nothing piped - leaves ANSWER = N untouched (measured same
REM as the pause below), so the npm ci branch is unreachable without a human
REM physically typing y. goto/labels, NOT a ( ) block, so %ANSWER% is read AFTER
REM set /p runs - inside a block it would expand once at parse time and always
REM see the old value (the classic delayed-expansion trap).
set "ANSWER=N"
set /p "ANSWER=    Server stopped? Type y to run npm ci now [y/N]: "
if /i not "%ANSWER%"=="y" goto :skipci
echo.
echo ==^> Running npm ci in web-app ...
pushd "%~dp0web-app"
call npm ci
popd
echo.
echo ==^> npm ci done.
goto :nodeps

:skipci
echo.
echo ==^> Skipped. Run "npm ci" inside web-app yourself before starting Nexus.

:nodeps

echo.
echo ==^> Updated. Restart Nexus if server-side code changed
echo     ^(client-side changes are picked up without a restart^).

:done
REM `pause` is safe here even when a being runs this through a shell: measured
REM 2026-10-09, with stdin at EOF it prints its prompt and falls straight
REM through instead of hanging. Keep it so a human double-clicking the file can
REM still read the output before the window closes.
pause
