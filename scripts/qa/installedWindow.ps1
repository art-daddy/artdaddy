$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'Installed window qualification is restricted to a disposable CI runner' }
$installed = [System.IO.Path]::GetFullPath($env:ARTDADDY_QA_INSTALLED_EXE)
$temporary = [System.IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\') + '\'
if (-not $installed.StartsWith($temporary, [StringComparison]::OrdinalIgnoreCase)) { throw 'Installed path must be under RUNNER_TEMP' }
$application = Get-Process -Id ([int]$env:ARTDADDY_QA_INSTALLED_PID) -ErrorAction Stop
if ($application.Path -ne $installed) { throw 'Unexpected installed process identity' }
if ($application.Handle -eq [IntPtr]::Zero) { throw 'Cannot retain installed process handle' }
$version = (Get-Item -LiteralPath $installed).VersionInfo.ProductVersion
if ($version -notmatch '^0\.21\.6(?:\.0)?$') { throw "Unexpected installed version $version" }
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class InstalledCandidateWindow {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window,out Rect rect);
}
'@
[InstalledCandidateWindow]::SetProcessDPIAware() | Out-Null
$application.Refresh()
$window = $application.MainWindowHandle
if ($window -eq [IntPtr]::Zero) { throw 'Installed app has no native window' }
$root = [System.Windows.Automation.AutomationElement]::FromHandle($window)
if ($root.Current.ProcessId -ne $application.Id) { throw 'Unexpected native window owner' }
$controls = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$names = @($controls | ForEach-Object { $_.Current.Name } | Where-Object { $_ } | Select-Object -Unique)
$semanticContentExposed = [bool]($names | Where-Object { $_ -match 'Sign in to continue|Log in or sign up|Check for update|Update required' })
[InstalledCandidateWindow]::SetForegroundWindow($window) | Out-Null
if ([InstalledCandidateWindow]::GetForegroundWindow() -ne $window) { throw 'Refusing screenshot without verified foreground ownership' }
$rectangle = New-Object InstalledCandidateWindow+Rect
if (-not [InstalledCandidateWindow]::GetWindowRect($window, [ref]$rectangle)) { throw 'Cannot measure installed window' }
$width = $rectangle.Right - $rectangle.Left
$height = $rectangle.Bottom - $rectangle.Top
if ($width -lt 900 -or $height -lt 500) { throw 'Installed window has invalid dimensions' }
$bitmap = New-Object System.Drawing.Bitmap($width, $height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
    $graphics.CopyFromScreen($rectangle.Left, $rectangle.Top, 0, 0, $bitmap.Size)
    $colors = New-Object 'System.Collections.Generic.HashSet[int]'
    for ($vertical = 40; $vertical -lt $height; $vertical += 6) {
        for ($horizontal = 0; $horizontal -lt $width; $horizontal += 6) { $null = $colors.Add($bitmap.GetPixel($horizontal, $vertical).ToArgb()) }
    }
    if ($colors.Count -lt 10) { throw 'Installed client content is blank or unpainted' }
    $output = Join-Path $PWD 'reports/qa/installed'
    New-Item -ItemType Directory -Force $output | Out-Null
    $bitmap.Save((Join-Path $output 'installed-native.png'), [System.Drawing.Imaging.ImageFormat]::Png)
    $status = if ($semanticContentExposed) { 'INSTALLED_NATIVE_ACCESSIBILITY_AND_PAINT_VERIFIED' } else { 'INSTALLED_WINDOW_CAPTURED_REQUIRES_VISUAL_REVIEW' }
    $proof = @{ status=$status; semanticContentExposed=$semanticContentExposed; automaticPaintSignoff=$semanticContentExposed; checkedAt=[DateTime]::UtcNow.ToString('o'); version=$version; expectedIdentifierFromCandidate='com.artdaddy.app'; identifierMeasuredFromIpc=$false; title=$root.Current.Name; width=$width; height=$height; contentColors=$colors.Count; accessibleNames=$names; executableSha256=(Get-FileHash -LiteralPath $installed -Algorithm SHA256).Hash.ToLowerInvariant(); ephemeralHostedRunner=$true; normalUserMachineAccessed=$false; cdpRequired=$false; installerSourceSha=$env:ARTDADDY_QA_ARTIFACT_SOURCE_SHA }
    [System.IO.File]::WriteAllText((Join-Path $output 'installed-native.json'), ($proof | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
    $proof | ConvertTo-Json -Depth 6
} finally {
    $graphics.Dispose()
    $bitmap.Dispose()
}
if (-not $application.CloseMainWindow()) { throw 'Installed app did not accept normal native close' }
if (-not $application.WaitForExit(30000)) { throw 'Installed app did not exit normally after native close' }
$exitCode = $application.ExitCode
$proof.nativeCloseAccepted = $true
$proof.processExited = $true
$proof.exitCode = $exitCode
[System.IO.File]::WriteAllText((Join-Path $output 'installed-native.json'), ($proof | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
if ($null -eq $exitCode -or $exitCode -ne 0) { throw "Installed app exit code was not zero: $exitCode" }
$proof | ConvertTo-Json -Depth 6