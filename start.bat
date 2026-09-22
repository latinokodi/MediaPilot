@echo off
cd /d "%~dp0"
echo Starting MediaPilot...
echo.
echo Cleaning up any existing instances...
taskkill /f /im electron.exe >nul 2>&1
timeout /t 2 /nobreak >nul
echo.
call npm install
call npm run dev
