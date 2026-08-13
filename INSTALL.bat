@echo off

powershell -ExecutionPolicy Bypass -File "%~dp0install.ps1"

if errorlevel 1 (
  echo.
  echo [ERROR] Installation did not finish. Nexus was not started.
  echo         Fix the error above, then run INSTALL.bat again.
  pause
  exit /b 1
)

echo.
echo ==^> Installation complete - starting Nexus
echo.

call "%~dp0RUN.bat"
