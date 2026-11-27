<#
.SYNOPSIS
  Prints the path of an Edge WebDriver (msedgedriver.exe) that matches this PC's WebView2 runtime, downloading the
  matching one from Microsoft when none is at hand.

.DESCRIPTION
  tauri-driver drives the app's WebView2 through msedgedriver, and their major versions must be equal: a driver left
  over from an older WebView2 fails every session. WebView2 updates itself every few weeks, so this runs before each
  real-app run instead of installing a driver once.

  It tries, in order: -Candidate (default $env:MSEDGEDRIVER; a path or a name on PATH), the cache
  (-Cache\<version>\msedgedriver.exe), then https://msedgedriver.microsoft.com/<version>/edgedriver_win64.zip into the
  cache, unless -NoDownload. The only thing written to the pipeline is the driver's path; everything else is Write-Host.

  Used by scripts/qa/nightlyTiming.ps1 and by the real-app job in .github/workflows/ci.yml.

.EXAMPLE
  $env:MSEDGEDRIVER = & scripts\qa\edgeDriver.ps1
#>
param(
  [string]$Candidate = $env:MSEDGEDRIVER,
  [string]$Cache = (Join-Path $env:LOCALAPPDATA 'artdaddy-timing\msedgedriver'),
  [switch]$NoDownload
)
$ErrorActionPreference = 'Stop'

function Get-WebView2Version {
  # The Evergreen WebView2 runtime's client id; the Edge browser's is the fallback (they ship the same versions).
  foreach ($id in @('{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', '{56EB18F8-B008-4CBD-B6D2-8C97FE7E9062}')) {
    foreach ($root in @('HKLM:\SOFTWARE\WOW6432Node', 'HKLM:\SOFTWARE', 'HKCU:\Software')) {
      $pv = (Get-ItemProperty -Path "$root\Microsoft\EdgeUpdate\Clients\$id" -ErrorAction SilentlyContinue).pv
      if ($pv -and $pv -ne '0.0.0.0') { return $pv }
    }
  }
  return $null
}

function Get-DriverVersion([string]$Exe) {
  if (-not $Exe -or -not (Test-Path -LiteralPath $Exe)) { return $null }
  $text = (& $Exe --version 2>$null) | Out-String
  if ($text -match '(\d+)\.(\d+)\.(\d+)\.(\d+)') { return $Matches[0] }
  return $null
}

function Test-Major([string]$A, [string]$B) { return $A -and $B -and ($A.Split('.')[0] -eq $B.Split('.')[0]) }

$runtime = Get-WebView2Version
if (-not $runtime) { throw 'No WebView2 runtime is registered on this PC, so the app cannot run here.' }

if ($Candidate) {
  $exe = $Candidate
  if (-not (Test-Path -LiteralPath $exe)) { $exe = (Get-Command $Candidate -ErrorAction SilentlyContinue).Source }
  $version = Get-DriverVersion $exe
  if (Test-Major $version $runtime) {
    Write-Host "msedgedriver $version matches WebView2 $runtime ($exe)"
    return $exe
  }
  Write-Host "msedgedriver at '$Candidate' is $(if ($version) { $version } else { 'missing' }); WebView2 is $runtime"
}

$cached = Join-Path $Cache "$runtime\msedgedriver.exe"
if (Test-Major (Get-DriverVersion $cached) $runtime) {
  Write-Host "msedgedriver $runtime from the cache ($cached)"
  return $cached
}

$url = "https://msedgedriver.microsoft.com/$runtime/edgedriver_win64.zip"
if ($NoDownload) { throw "No msedgedriver matches WebView2 $runtime. Download $url and set MSEDGEDRIVER to it." }

$folder = Split-Path $cached
New-Item -ItemType Directory -Force -Path $folder | Out-Null
$zip = Join-Path $folder 'edgedriver_win64.zip'
$saved = $ProgressPreference
$ProgressPreference = 'SilentlyContinue'
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing -TimeoutSec 120
} finally {
  $ProgressPreference = $saved
}
Expand-Archive -LiteralPath $zip -DestinationPath $folder -Force
Remove-Item -LiteralPath $zip -Force
$version = Get-DriverVersion $cached
if (-not (Test-Major $version $runtime)) { throw "The driver downloaded from $url reports '$version', not $runtime." }
Write-Host "msedgedriver $version downloaded for WebView2 $runtime ($cached)"
return $cached
