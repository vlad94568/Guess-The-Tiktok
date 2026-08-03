@echo off
REM Shuts the game down and frees the memory the headless browser holds.
title Guess The TikTok - stopping
echo.
echo   Shutting down...
echo.

REM Match on the COMMAND LINE, not on who owns the port. On Windows a second server
REM can bind an in-use port via SO_REUSEADDR, so killing only the socket owner can
REM leave a survivor running and the port still listening.
powershell -NoProfile -Command ^
  "$ErrorActionPreference='SilentlyContinue';" ^
  "$targets = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*server.mjs*' -or $_.CommandLine -like '*http.server 3000*' };" ^
  "foreach($t in $targets){ Stop-Process -Id $t.ProcessId -Force; Write-Host ('   stopped ' + $t.Name) }" ^
  "if(-not $targets){ Write-Host '   nothing was running' }"

REM A forced stop skips the server's clean shutdown, so sweep up any headless
REM Chromium left behind. Only processes from the playwright cache are touched.
powershell -NoProfile -Command ^
  "$ErrorActionPreference='SilentlyContinue';" ^
  "$p = Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '*ms-playwright*' };" ^
  "if($p){ $p | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; Write-Host ('   freed ' + @($p).Count + ' browser process(es)') } else { Write-Host '   no leftover browser processes' }"

powershell -NoProfile -Command ^
  "Start-Sleep -Milliseconds 800;" ^
  "foreach($port in 8787,3000){" ^
  "  $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue;" ^
  "  if($c){ Write-Host ('   [!] port ' + $port + ' STILL in use') }" ^
  "}"

echo.
echo   Done. Memory freed.
echo.
ping -n 4 127.0.0.1 >nul 2>&1
