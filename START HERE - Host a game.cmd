@echo off
setlocal
REM ===========================================================================
REM  Double-click this to host a game. Nothing else to run.
REM
REM  Starts one Node server that serves BOTH the host screen and the TikTok
REM  scraper, waits for it, then opens the host screen in your browser.
REM
REM  Uses only cmd-native tools (curl.exe, netstat - both ship with Windows 10+).
REM  Inline PowerShell inside a .cmd is quoting-fragile and silently mangled an
REM  earlier version of the wait loop.
REM ===========================================================================
title Guess The TikTok
cd /d "%~dp0"

echo.
echo   Guess The TikTok - starting up...
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo   [X] Node.js is not installed.
  echo       Get it from https://nodejs.org  ^(LTS^), then run this again.
  echo.
  pause
  exit /b 1
)

if not exist "scraper\node_modules" (
  echo   First run - installing dependencies. This takes a few minutes.
  echo   It also downloads a browser for the scraper. Please wait...
  echo.
  pushd scraper
  call npm install
  if errorlevel 1 (
    popd
    echo   [X] Install failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
  call npx playwright install chromium
  popd
  echo.
)

REM Reuse an already-running server instead of starting a second one that would
REM fail to bind and then linger invisibly.
netstat -ano | findstr /r /c:":8787 .*LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo   Already running - reusing it.
  goto :ready
)

echo   Starting server...
start "Guess-The-TikTok-Server" /min /d "%~dp0scraper" cmd /c "set GH_PAGES_ORIGIN=https://vlad94568.github.io&& npm start"

echo   Waiting for it to come up ^(the first start is slower - it cold-starts
echo   a headless browser^)...
for /l %%i in (1,1,90) do (
  curl -s -m 2 http://localhost:8787/health 2>nul | findstr /c:"\"ok\":true" >nul 2>&1 && goto :ready
  ping -n 2 127.0.0.1 >nul 2>&1
)

echo.
echo   [X] Server never came up. Open the minimised
echo       "Guess-The-TikTok-Server" window to see the error.
echo.
pause
exit /b 1

:ready
start "" "http://localhost:8787/host.html"
echo.
echo   ==================================================================
echo.
echo     Host screen is opening in your browser.
echo.
echo     Tell everyone else to go to:
echo.
echo       vlad94568.github.io/Guess-The-Tiktok/play.html
echo.
echo     Keep mode on "Reposts" unless everyone has turned on
echo     public Liked videos in TikTok.
echo.
echo     WHEN YOU ARE DONE, double-click:  STOP - End game.cmd
echo     ^(the server holds about 550 MB until you do^)
echo.
echo   ==================================================================
echo.
echo   You can close this window - the game keeps running.
echo.
ping -n 15 127.0.0.1 >nul 2>&1
exit /b 0
