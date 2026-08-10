@echo off
rem Check if Python is installed and available in PATH
python --version >nul 2>&1
if errorlevel 1 (
    echo Python is not installed or not in your PATH.
    pause
    exit /b
)

rem Run speech11.py from the current folder
python test.py

rem Optional: Keep the window open after execution
pause
