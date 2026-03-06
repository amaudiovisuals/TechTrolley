@echo off
set PATH=%PATH%;C:\Program Files\nodejs;C:\Users\amoff\AppData\Local\Programs\Python\Python312;C:\Users\amoff\AppData\Local\Programs\Python\Python312\Scripts
echo ==========================================
echo      Tech Trolley Asset Tracker Setup
echo ==========================================
echo.
powershell -ExecutionPolicy Bypass -File refresh_environment.ps1
if %errorlevel% neq 0 (
    echo [ERROR] Environment refresh failed.
    pause
    exit /b %errorlevel%
)
echo.
echo Setup Completed Successfully!
pause
