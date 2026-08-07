@echo off
setlocal
REM Ends the game: kills the server, frees the memory the headless browser holds, and
REM deletes every scraped TikTok list from disk.
REM
REM The work is in scraper\stop.ps1. Inline PowerShell inside a .cmd is quoting-fragile
REM and silently mangled an earlier version of this script.
title Guess The TikTok - stopping
cd /d "%~dp0"

echo.
echo   Shutting down and deleting this game's data...
echo.

REM The Chromium profile is TikTok cookies only - no player data - and rebuilding it
REM means a captcha on nearly every scrape. Kept unless asked. Defaults to N after 10s
REM so a double-click-and-walk-away never leaves the window sitting on a prompt.
set "WIPE="
choice /C YN /T 10 /D N /N /M "   Also delete the saved TikTok login cookies? Slower next game. [y/N] "
if errorlevel 2 goto :run
if errorlevel 1 set "WIPE=-WipeProfile"

:run
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scraper\stop.ps1" %WIPE%
set "RC=%ERRORLEVEL%"

echo.
if not "%RC%"=="0" (
  echo   [!] Cleanup did not finish cleanly ^(code %RC%^) - see the lines above.
  echo       Run this again; if a port is still in use, reboot.
) else (
  echo   Done. Memory freed, saved TikTok lists deleted.
)
echo.
echo   Player names, handles and votes live in Firebase, not on this PC. They are
echo   deleted when you close the host tab; anything left over is cleaned up the
echo   next time you open the host screen.
echo.
ping -n 5 127.0.0.1 >nul 2>&1
