<#
  Shutdown + data purge. Driven by "STOP - End game.cmd"; safe to run by hand.

  Three jobs, in this order:

    1. kill the server (and the npm/cmd wrapper that started it),
    2. kill the headless Chromium it left behind — a forced kill skips the server's
       SIGTERM handler, so closeBrowser() never runs,
    3. delete every scraped result on disk: scraper/.cache/*.json, one file per
       handle:mode, each holding a player's TikTok @handle and up to 100 video ids.

  Step 3 is the point. The server only sweeps entries that have EXPIRED (24h TTL), so
  without this the handles and video ids of everyone at the party sit on disk until the
  next day. "The game is over" and "the data is gone" should be the same event.

  The Chromium profile in .cache/browser-profile is kept unless -WipeProfile is passed:
  it holds the TikTok cookies that stop every scrape being challenged, and it contains
  nothing about the players.

  Firebase is NOT touched here — this script has no credentials, and the rules only let
  a room's own host delete it. That cleanup lives in the host page (onDisconnect while
  the room is in lobby/finished, plus a sweep of its own abandoned rooms on next load).

  Params:
    -WipeProfile  also delete .cache/browser-profile (TikTok cookies)
    -DryRun       report what would be killed/deleted, change nothing
    -CacheDir     override the cache location (tests)
#>
[CmdletBinding()]
param(
  [switch]$WipeProfile,
  [switch]$DryRun,
  # Resolved below, not here: under Windows PowerShell 5.1 invoked with -File, param
  # defaults are bound before $PSScriptRoot exists, and the script dies on startup.
  [string]$CacheDir
)

$ErrorActionPreference = 'Stop'

if (-not $CacheDir) {
  $here = $PSScriptRoot
  if (-not $here) { $here = Split-Path -Parent $MyInvocation.MyCommand.Path }
  $CacheDir = Join-Path $here '.cache'
}
$ProfileDir = Join-Path $CacheDir 'browser-profile'
$stillListening = @()

function Say([string]$msg) { Write-Host "   $msg" }
function SayDry([string]$msg) { Write-Host "   [dry run] $msg" -ForegroundColor Yellow }

function Get-AllProcesses {
  # One snapshot per pass. CommandLine is the field everything below matches on, so
  # Win32_Process is required — Get-Process does not expose it.
  @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
}

function Stop-Pid([int]$id, [string]$label) {
  if ($DryRun) { SayDry "would stop $label (pid $id)"; return $true }
  try {
    Stop-Process -Id $id -Force -ErrorAction Stop
    return $true
  } catch {
    # Already gone is the common case: killing a parent often takes the child with it.
    return $false
  }
}

# ===========================================================================
# 1. the server
# ===========================================================================
$all = Get-AllProcesses

# Never kill this script, or whatever launched it. A "*server.mjs*" command-line match
# hits ANY process that merely mentions the file — including a shell that was told to go
# looking for it. The previous version of this script matched from a
# `powershell -Command "...'*server.mjs*'..."` one-liner, whose own command line contains
# that very text, so it could stop itself the moment it reached its own row and leave the
# real server running. Walk our own ancestry once and exclude all of it.
$selfChain = @()
$walk = $PID
for ($hop = 0; $hop -lt 12 -and $walk; $hop++) {
  $selfChain += [int]$walk
  $up = $all | Where-Object { $_.ProcessId -eq $walk } | Select-Object -First 1
  if (-not $up) { break }
  $walk = [int]$up.ParentProcessId
}

# Match on the COMMAND LINE, not on who owns the port. On Windows a second server can
# bind an in-use port via SO_REUSEADDR, so killing only the socket owner can leave a
# survivor running with the port still listening. The interpreter name is checked too,
# so only something actually RUNNING the server qualifies.
$server = @($all | Where-Object {
    ($_.Name -like 'node*' -and $_.CommandLine -like '*server.mjs*') -or
    ($_.Name -like 'python*' -and $_.CommandLine -like '*http.server 3000*')
  } | Where-Object { $selfChain -notcontains [int]$_.ProcessId })

# `npm start` and the minimised `cmd /c ... npm start` window are the server's parents.
# Node dying normally takes them with it, but not always, and a surviving npm wrapper is
# what leaves a stray console sitting on the desktop.
$wrappers = @()
foreach ($p in $server) {
  $parent = $all | Where-Object { $_.ProcessId -eq $p.ParentProcessId }
  foreach ($w in @($parent)) {
    if ($null -eq $w) { continue }
    if ($w.CommandLine -like '*npm*' -or $w.CommandLine -like '*Guess-The-TikTok-Server*') {
      $wrappers += $w
    }
  }
}

$serverPids = @()
foreach ($p in @($server) + @($wrappers)) {
  $id = [int]$p.ProcessId
  if ($serverPids -contains $id) { continue }
  if ($selfChain -contains $id) { continue }
  $serverPids += $id
  if (Stop-Pid $id $p.Name) { if (-not $DryRun) { Say "stopped $($p.Name)" } }
}
if (-not $serverPids.Count) { Say 'nothing was running' }

# ===========================================================================
# 2. leftover headless Chromium
# ===========================================================================
Start-Sleep -Milliseconds 400
$all = Get-AllProcesses
$live = @{}
foreach ($p in $all) { $live[[int]$p.ProcessId] = $true }

$browsers = @($all | Where-Object { $_.ExecutablePath -like '*ms-playwright*' })

# Only ever OUR browser. Matching every ms-playwright process on the machine would kill
# an unrelated project's Playwright run that happened to be going at the time. Ours is
# identified three ways: it was launched with our profile directory, or its parent was
# the server we just killed, or it has been orphaned by that kill.
$kill = @{}
foreach ($b in $browsers) {
  $cmd = [string]$b.CommandLine
  $parent = [int]$b.ParentProcessId
  if ($cmd.Contains($ProfileDir) -or ($serverPids -contains $parent) -or (-not $live.ContainsKey($parent))) {
    $kill[[int]$b.ProcessId] = $b
  }
}
# Renderer/GPU children carry different arguments, so pull in anything descended from a
# browser process already marked. Loops until the set stops growing.
$growing = $true
while ($growing) {
  $growing = $false
  foreach ($b in $browsers) {
    $id = [int]$b.ProcessId
    if ($kill.ContainsKey($id)) { continue }
    if ($kill.ContainsKey([int]$b.ParentProcessId)) { $kill[$id] = $b; $growing = $true }
  }
}

$freed = 0
foreach ($id in @($kill.Keys)) { if (Stop-Pid $id 'chromium') { $freed++ } }
if ($freed) {
  if (-not $DryRun) { Say "freed $freed browser process(es)" }
} else {
  Say 'no leftover browser processes'
}

# ===========================================================================
# 3. scraped TikTok data on disk
# ===========================================================================
# Everything, not just what has expired — the server's startup sweep handles expiry, this
# handles "the party is over".
$files = @(Get-ChildItem -LiteralPath $CacheDir -Filter '*.json' -File -ErrorAction SilentlyContinue)
if ($files.Count) {
  if ($DryRun) {
    SayDry "would delete $($files.Count) cached scrape file(s) from $CacheDir"
  } else {
    $gone = 0
    foreach ($f in $files) {
      try { Remove-Item -LiteralPath $f.FullName -Force -ErrorAction Stop; $gone++ } catch {
        Say "could not delete $($f.Name): $($_.Exception.Message)"
      }
    }
    Say "deleted $gone saved TikTok list(s) - handles and video ids"
  }
} else {
  Say 'no saved TikTok data on disk'
}

if ($WipeProfile) {
  if (Test-Path -LiteralPath $ProfileDir) {
    if ($DryRun) {
      SayDry "would delete the browser profile at $ProfileDir"
    } else {
      try {
        Remove-Item -LiteralPath $ProfileDir -Recurse -Force -ErrorAction Stop
        Say 'deleted the saved TikTok browser profile (cookies)'
      } catch {
        Say "could not delete the browser profile: $($_.Exception.Message)"
      }
    }
  } else {
    Say 'no browser profile to delete'
  }
} else {
  Say 'kept the TikTok browser profile (cookies) - it holds nothing about players'
}

# ===========================================================================
# 4. verify
# ===========================================================================
if (-not $DryRun) {
  Start-Sleep -Milliseconds 800
  foreach ($port in 8787, 3000) {
    $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($c) { $stillListening += $port }
  }
  $left = @(Get-AllProcesses | Where-Object {
      $_.Name -like 'node*' -and $_.CommandLine -like '*server.mjs*' -and $selfChain -notcontains [int]$_.ProcessId
    })
  if ($left.Count) {
    Write-Host "   [!] $($left.Count) server process(es) survived - reboot or end 'node.exe' in Task Manager" -ForegroundColor Red
  }
  foreach ($port in $stillListening) {
    Write-Host "   [!] port $port is STILL in use" -ForegroundColor Red
  }
}

if ($stillListening.Count) { exit 1 }
exit 0
