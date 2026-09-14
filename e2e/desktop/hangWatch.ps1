# Poll a process's main window with Windows' OWN definition of "Not Responding"
# (IsHungAppWindow) and report the longest continuous hang. Used to prove that a large
# import no longer blocks the UI thread.
#
# Writes the running result to -Out after every sample: a caller that kills this watcher when
# its work finishes would otherwise lose a summary printed only at exit.
param([string]$Process = "artdaddy", [int]$Seconds = 150, [string]$Out = "")

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Hung {
  [DllImport("user32.dll")] public static extern bool IsHungAppWindow(IntPtr hWnd);
}
"@

$deadline = (Get-Date).AddSeconds($Seconds)
$longest = 0.0
$hangStart = $null
$samples = 0
$hungSamples = 0

while ((Get-Date) -lt $deadline) {
  $p = Get-Process -Name $Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if (-not $p) { Start-Sleep -Milliseconds 200; continue }
  $samples++
  if ([Hung]::IsHungAppWindow($p.MainWindowHandle)) {
    $hungSamples++
    if (-not $hangStart) { $hangStart = Get-Date }
    $span = ((Get-Date) - $hangStart).TotalSeconds
    if ($span -gt $longest) { $longest = $span }
  } else {
    $hangStart = $null
  }
  $line = "samples=$samples hung=$hungSamples longestHangSec=$([math]::Round($longest,1))"
  if ($Out) { Set-Content -Path $Out -Value $line -Encoding ascii }
  Start-Sleep -Milliseconds 200
}

"samples=$samples hung=$hungSamples longestHangSec=$([math]::Round($longest,1))"
