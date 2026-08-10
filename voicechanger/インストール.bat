@echo off
echo [1/3] Checking Python installation...
where python >nul 2>nul
if errorlevel 1 (
    echo Python is not installed or not in PATH.
    echo Please install Python from https://www.python.org/downloads/
    pause
    exit /b
)

echo [2/3] Installing required packages from requirements.txt...
pip install --upgrade pip
pip install -r requirements.txt

IF %ERRORLEVEL% NEQ 0 (
    echo.
    echo Some packages may have failed to install.
    echo If you're having issues with PyAudio, try the following:
    echo    pip install pipwin
    echo    pipwin install pyaudio
    echo.
)

echo [3/3] Installation complete.
pause
