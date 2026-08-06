@echo off
REM Puts a "Guess The TikTok" shortcut on the Desktop so hosting does not require
REM finding this folder. Safe to run more than once - it overwrites the same shortcut.
title Guess The TikTok - create shortcut

powershell -NoProfile -Command ^
  "$ErrorActionPreference='Stop';" ^
  "$desktop = [Environment]::GetFolderPath('Desktop');" ^
  "$link = Join-Path $desktop 'Guess The TikTok.lnk';" ^
  "$target = Join-Path '%~dp0' 'START HERE - Host a game.cmd';" ^
  "$w = New-Object -ComObject WScript.Shell;" ^
  "$s = $w.CreateShortcut($link);" ^
  "$s.TargetPath = $target;" ^
  "$s.WorkingDirectory = '%~dp0'.TrimEnd('\');" ^
  "$s.Description = 'Host a game of Guess The TikTok';" ^
  "$s.IconLocation = \"$env:SystemRoot\system32\shell32.dll,137\";" ^
  "$s.WindowStyle = 7;" ^
  "$s.Save();" ^
  "Write-Host ''; Write-Host ('  Created: ' + $link)"

if errorlevel 1 (
  echo.
  echo   Could not create the shortcut. You can still host by double-clicking
  echo   "START HERE - Host a game.cmd" in this folder.
) else (
  echo.
  echo   Double-click "Guess The TikTok" on your Desktop to host from now on.
)
echo.
pause
