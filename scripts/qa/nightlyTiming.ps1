<#
.SYNOPSIS
  The nightly timing run on the lab PC: build the app, run every timed test a few times, compare the times with
  e2e/timing-budgets.json and write a short report.

.DESCRIPTION
  1. -Refresh first moves this checkout to the newest origin/staging (only when no tracked file is changed) and
     reinstalls the packages from the npm cache when package-lock.json changed.
  2. -ReadyCheck names a gate script that must print READY: a time taken on a busy or battery-powered PC is noise.
  3. Desktop lanes (the timed e2e/desktop/*.desktop.mjs): takes the real-app lock (-LockFile), checks that MCP port
     19787, the page port 5173 and the app itself are free (an installed ArtDaddy would receive the lanes' calls),
     finds an Edge WebDriver matching WebView2 (edgeDriver.ps1), builds the dev app (cargo build, debug: it loads its
     page from vite), starts the stand-in service (standInServer.mjs on -ServicePort: it answers the app's build check
     and refuses everything else, so nothing can reach a real server or a model), serves the page on 5173 pointed at it
     with the sign-in bypass, runs the lanes -Runs times, then stops what it started and releases the lock.
  4. Browser lane (the timed e2e/ui specs): Playwright starts its own page server; no lock.
  5. Compares with the budgets and writes <ReportRoot>\<date_time>\report.txt (also latest.txt and the console), with
     results.jsonl and run.log beside it.
  Exit 0 only when every budgeted wait was measured within its budget and every lane ran; 1 otherwise.

  -Calibrate gives each timed wait that has no budget one (the median of -Runs runs plus 20%) instead of only
  comparing; it never changes a budget that exists (scripts/qa/timingBudgets.mjs says why).

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\qa\nightlyTiming.ps1 -Runs 3 -LockFile <lock file> -ReadyCheck <gate script>

.EXAMPLE
  # Daily at 02:00 as the signed-in user (the app needs a desktop), from a checkout kept for this run:
  $a = New-ScheduledTaskAction -Execute powershell.exe -WorkingDirectory <checkout> -Argument '-NoProfile -ExecutionPolicy Bypass -File <checkout>\scripts\qa\nightlyTiming.ps1 -Refresh -LockFile <lock file>'
  Register-ScheduledTask -TaskName 'ArtDaddy nightly timing' -Action $a -Trigger (New-ScheduledTaskTrigger -Daily -At 02:00) -Settings (New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 3) -MultipleInstances IgnoreNew)
#>
param(
  [ValidateRange(1, 20)][int]$Runs = 3,
  [string]$LockFile = $env:ARTDADDY_REAL_APP_LOCK,
  [ValidateRange(0, 600)][int]$LockWaitMinutes = 30,
  [string]$ReadyCheck = $env:ARTDADDY_LAB_READY,
  [string]$CargoTargetDir = $env:CARGO_TARGET_DIR,
  [string]$EdgeDriver = $env:MSEDGEDRIVER,
  [ValidateRange(1024, 65535)][int]$ServicePort = 8790,
  [string]$ReportRoot = '',
  [switch]$Refresh,
  [switch]$SkipBrowser,
  [switch]$SkipDesktop,
  [switch]$Calibrate
)
Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not $ReportRoot) { $ReportRoot = Join-Path $repo 'reports\qa\timing' }
$outDir = Join-Path $ReportRoot (Get-Date -Format 'yyyy-MM-dd_HHmm')
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$log = Join-Path $outDir 'run.log'
$results = Join-Path $outDir 'results.jsonl'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$problems = New-Object System.Collections.Generic.List[string]
$runSummary = New-Object System.Collections.Generic.List[string]

function Write-Log([string]$Text) {
  $line = '[{0:HH:mm:ss}] {1}' -f (Get-Date), $Text
  Write-Host $line
  [System.IO.File]::AppendAllText($log, $line + [Environment]::NewLine, $utf8)
}

# Runs a program with its output (both streams) in the log; returns its exit code and its lines.
function Invoke-Native([string]$Exe, [string[]]$Arguments) {
  if (-not (Get-Command $Exe -ErrorAction SilentlyContinue)) { throw "$Exe is not installed or not on PATH" }
  $lines = New-Object System.Collections.Generic.List[string]
  $saved = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $Exe @Arguments 2>&1 | ForEach-Object {
      $text = "$_"
      $lines.Add($text)
      Write-Log "  $text"
    }
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $saved
  }
  return @{ Code = $code; Lines = $lines }
}

function Invoke-Timing([string[]]$Arguments) {
  $run = Invoke-Native 'node' (@((Join-Path $repo 'scripts\qa\timingBudgets.mjs')) + $Arguments)
  foreach ($line in $run.Lines) {
    if ($line -match '^(Timed runs:|  FAILED|  NOT RUN|  ADDED|  KEPT|  SKIPPED|Wrote |No budget added)') { $runSummary.Add($line) }
  }
  if ($run.Code -ne 0) { $problems.Add("timingBudgets $($Arguments[0]) --lanes $($Arguments[2]) exited $($run.Code)") }
}

function Get-ListenerPid([int]$Port) {
  $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($listener) { return $listener.OwningProcess }
  return $null
}

function Stop-Tree([int]$ProcessId) {
  & taskkill.exe /PID $ProcessId /T /F 2>&1 | Out-Null
}

Write-Log "nightly timing in $repo, $Runs run(s) per test$(if ($Calibrate) { ', calibrating' })"

# --- 1. the checkout -------------------------------------------------------------------------------------------
Push-Location $repo
try {
  if ($Refresh) {
    $changed = (Invoke-Native 'git' @('status', '--porcelain', '--untracked-files=no')).Lines
    if ($changed.Count) {
      $problems.Add('refresh: tracked files are changed in this checkout, so it was timed as it is')
    } else {
      $lockBefore = (Invoke-Native 'git' @('rev-parse', 'HEAD:package-lock.json')).Lines -join ''
      $fetch = Invoke-Native 'git' @('fetch', '--quiet', 'origin', 'staging')
      $checkout = Invoke-Native 'git' @('checkout', '--quiet', '--detach', 'origin/staging')
      if ($fetch.Code -ne 0 -or $checkout.Code -ne 0) { $problems.Add('refresh: could not move to origin/staging') }
      $lockAfter = (Invoke-Native 'git' @('rev-parse', 'HEAD:package-lock.json')).Lines -join ''
      if ($lockBefore -ne $lockAfter) {
        Write-Log 'package-lock.json changed: npm ci from the cache'
        $install = Invoke-Native 'cmd.exe' @('/c', 'npm', 'ci', '--os=win32', '--cpu=x64', '--offline')
        if ($install.Code -ne 0 -or -not (Test-Path (Join-Path $repo 'node_modules\.package-lock.json'))) {
          $problems.Add('refresh: npm ci did not finish; the lanes ran on the packages that were there')
        }
      }
    }
  }
  $commit = ((Invoke-Native 'git' @('rev-parse', 'HEAD')).Lines -join '').Trim()
  $clean = -not (Invoke-Native 'git' @('status', '--porcelain', '--untracked-files=no')).Lines.Count
  $env:ARTDADDY_BUILD = if ($clean) { $commit } else { "$commit+dirty" }

  # --- 2. is the PC quiet enough to time anything (asked again after a wait for the lock) -------------------------
  function Get-NotReady {
    if (-not $ReadyCheck) { return $null }
    $ready = ((& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ReadyCheck 2>&1) | Out-String).Trim()
    Write-Log "ready check: $ready"
    if ($ready -match '^READY') { return $null }
    return "the PC is not ready ($ready)"
  }
  $notReady = Get-NotReady
  if ($notReady) {
    $SkipDesktop = $true
    $SkipBrowser = $true
    $problems.Add("not run: $notReady")
  }

  # --- 3. desktop lanes, under the real-app lock -----------------------------------------------------------------
  if (-not $SkipDesktop) {
    $conf = Get-Content (Join-Path $repo 'src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json
    $name = if ($conf.PSObject.Properties['mainBinaryName'] -and $conf.mainBinaryName) { $conf.mainBinaryName } else { $conf.productName }
    $target = if ($CargoTargetDir) { $CargoTargetDir } else { Join-Path $repo 'src-tauri\target' }
    $binary = Join-Path $target "debug\$name.exe"
    $haveLock = $false
    $vite = $null
    $service = $null
    $driver = $null
    try {
      if ($LockFile) {
        if (-not (Test-Path (Split-Path $LockFile))) { throw "the lock folder $(Split-Path $LockFile) does not exist" }
        $deadline = (Get-Date).AddMinutes($LockWaitMinutes)
        $waited = $false
        while (-not $haveLock) {
          try {
            New-Item -ItemType File -Path $LockFile -Value "nightly timing ($repo) took it at $(Get-Date -Format o)" -ErrorAction Stop | Out-Null
            $haveLock = $true
          } catch {
            $holder = (Get-Content -LiteralPath $LockFile -ErrorAction SilentlyContinue) -join ' '
            if ((Get-Date) -ge $deadline) { throw "the real-app lock stayed taken for $LockWaitMinutes min ($holder)" }
            Write-Log "the real-app lock is taken ($holder); trying again in 2 minutes"
            $waited = $true
            Start-Sleep -Seconds 120
          }
        }
        Write-Log "took the real-app lock $LockFile"
        if ($waited) {
          $notReady = Get-NotReady
          if ($notReady) {
            $SkipBrowser = $true
            throw $notReady
          }
        }
      } else {
        Write-Log 'no -LockFile: running the real app without the lab lock'
      }

      $mcp = Get-ListenerPid 19787
      if ($mcp) {
        $holder = Get-Process -Id $mcp -ErrorAction SilentlyContinue
        throw "MCP port 19787 is held by process $($mcp) ($(if ($holder) { $holder.Path })): the lanes would drive that app"
      }
      $page = Get-ListenerPid 5173
      if ($page) { throw "port 5173 is held by process $($page): the app would load another checkout's page" }
      $taken = Get-ListenerPid $ServicePort
      if ($taken) { throw "port $ServicePort (the stand-in service) is held by process $($taken)" }
      $running = @(Get-Process -Name $name -ErrorAction SilentlyContinue)
      if ($running.Count) { throw "$name is already running (process $($running[0].Id)): the app is single-instance, so a launch would hand over to it" }
      if (-not (Get-Command tauri-driver -ErrorAction SilentlyContinue)) { throw 'tauri-driver is not installed (cargo install tauri-driver --locked)' }
      $driver = & (Join-Path $PSScriptRoot 'edgeDriver.ps1') -Candidate $EdgeDriver
      $env:MSEDGEDRIVER = $driver

      if ($CargoTargetDir) { $env:CARGO_TARGET_DIR = $CargoTargetDir }
      Write-Log "building the dev app into $target"
      $build = Invoke-Native 'cargo' @('build', '--locked', '--manifest-path', (Join-Path $repo 'src-tauri\Cargo.toml'))
      if ($build.Code -ne 0 -or -not (Test-Path $binary)) { throw "cargo build exited $($build.Code)" }

      # The app checks its build with the service before it opens anything; the stand-in answers that check and
      # refuses every other request, so nothing can reach a real server (scripts/qa/standInServer.mjs).
      $serviceLog = Join-Path $outDir 'service.log'
      $service = Start-Process -FilePath 'node' -WorkingDirectory $repo -WindowStyle Hidden -PassThru `
        -ArgumentList @('scripts\qa\standInServer.mjs', '--port', "$ServicePort", '--log', "`"$serviceLog`"") `
        -RedirectStandardOutput (Join-Path $outDir 'service.out.log') -RedirectStandardError (Join-Path $outDir 'service.err.log')
      $env:VITE_API_BASE_URL = "http://127.0.0.1:$ServicePort"
      $env:VITE_E2E_AUTH_BYPASS = '1'
      $viteLog = Join-Path $outDir 'vite.log'
      # On 127.0.0.1, which a WebView2 always tries for "localhost": left to itself Node puts vite on ::1 only, which a
      # WebView2 with no IPv6 route never asks (on GitHub's runner the app's page never loaded).
      $vite = Start-Process -FilePath 'node' -WorkingDirectory $repo -WindowStyle Hidden -PassThru `
        -ArgumentList @('node_modules\vite\bin\vite.js', '--host', '127.0.0.1', '--port', '5173', '--strictPort') `
        -RedirectStandardOutput $viteLog -RedirectStandardError "$viteLog.err"
      $served = $false
      for ($i = 0; $i -lt 120 -and -not $served; $i++) {
        try {
          $served = (Invoke-WebRequest -Uri 'http://127.0.0.1:5173/' -UseBasicParsing -TimeoutSec 5).StatusCode -eq 200
        } catch {
          Start-Sleep -Seconds 1
        }
      }
      if (-not $served) { throw 'vite did not serve http://127.0.0.1:5173 within 2 minutes (see vite.log)' }
      if (-not (Get-ListenerPid $ServicePort)) { throw "the stand-in service did not start on port $ServicePort (see service.err.log)" }

      $env:ARTDADDY_APP_BINARY = $binary
      # A cold dev server takes far longer than the lanes' default 40 s to boot the app the first time.
      $env:ARTDADDY_E2E_TIMEOUT_MS = '180000'
      Write-Log "desktop lanes with $binary"
      Invoke-Timing @($(if ($Calibrate) { 'calibrate' } else { 'run' }), '--lanes', 'desktop', '--runs', "$Runs", '--results', $results)
    } catch {
      $problems.Add("desktop lanes not run: $($_.Exception.Message)")
      Write-Log "desktop lanes not run: $($_.Exception.Message)"
    } finally {
      if ($vite) { Stop-Tree $vite.Id }
      if ($service) { Stop-Tree $service.Id }
      # Whatever a lane left behind, found by its exact program file: never the installed app, never by name alone.
      foreach ($exe in @($binary, $driver)) {
        if (-not $exe) { continue }
        Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe } | ForEach-Object {
          Write-Log "stopping leftover process $($_.Id) ($exe)"
          Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
        }
      }
      if ($haveLock) {
        Remove-Item -LiteralPath $LockFile -Force -ErrorAction SilentlyContinue
        Write-Log 'released the real-app lock'
      }
    }
  }

  # --- 4. browser lane ------------------------------------------------------------------------------------------
  if (-not $SkipBrowser) {
    Write-Log 'browser lane'
    Invoke-Timing @($(if ($Calibrate) { 'calibrate' } else { 'run' }), '--lanes', 'browser', '--runs', "$Runs", '--results', $results)
  }

  # --- 5. compare and report ------------------------------------------------------------------------------------
  $compare = Invoke-Native 'node' @((Join-Path $repo 'scripts\qa\timingBudgets.mjs'), 'compare', $results)
  $verdict = if ($compare.Code -eq 0 -and -not $problems.Count) { 'PASS' } else { 'FAIL' }
  $report = New-Object System.Collections.Generic.List[string]
  $report.Add("ArtDaddy nightly timing $(Get-Date -Format 'yyyy-MM-dd HH:mm') on $($env:COMPUTERNAME): $verdict")
  $report.Add("Build: $env:ARTDADDY_BUILD (checkout $repo)")
  $report.Add('')
  foreach ($line in $compare.Lines) { $report.Add($line) }
  if ($runSummary.Count) {
    $report.Add('')
    foreach ($line in $runSummary) { $report.Add($line) }
  }
  if ($problems.Count) {
    $report.Add('')
    foreach ($line in $problems) { $report.Add("Problem: $line") }
  }
  $report.Add('')
  $report.Add("Results: $results")
  $report.Add("Log: $log")
  $text = ($report -join [Environment]::NewLine) + [Environment]::NewLine
  [System.IO.File]::WriteAllText((Join-Path $outDir 'report.txt'), $text, $utf8)
  [System.IO.File]::WriteAllText((Join-Path $ReportRoot 'latest.txt'), $text, $utf8)
  Write-Host ''
  Write-Host $text
  exit $(if ($verdict -eq 'PASS') { 0 } else { 1 })
} finally {
  Pop-Location
}
