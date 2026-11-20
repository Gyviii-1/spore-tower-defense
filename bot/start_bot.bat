@echo off
title Spore TD Bot
cd /d "%~dp0"
echo ========================================
echo   Spore TD Telegram Bot Starting...
echo   Do not close this window!
echo ========================================
echo.
"C:\Program Files\Python312\python.exe" bot.py
if %errorlevel% neq 0 (
    echo.
    echo Bot stopped with error.
    pause
)
pause
