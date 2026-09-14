# Put the app window on top at a known position and report its client-area origin.
#
# The OS-drop test needs the drop point to actually BE the app: synthetic input goes to whatever
# window is under the cursor, and the helper aborts (correctly, but uselessly) if something else
# is there. `SetForegroundWindow` alone is refused whenever the caller is not already the
# foreground process, so this attaches to the foreground thread's input queue first — the standard
# way to be granted foreground rights.
#
# Prints "<clientX>,<clientY>,<fg|bg>".
# The process name is a PARAMETER: it was hardcoded to "app", so this reported "noapp" for
# every run after the product rename and took the OS-level lanes down with it.
param([string]$Process = "artdaddy")
Add-Type -MemberDefinition '
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int t, uint f);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
[DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool alt);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint from, uint to, bool attach);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
public struct POINT { public int X; public int Y; }' -Name R -Namespace Raise | Out-Null

[Raise.R]::SetProcessDPIAware() | Out-Null
$p = Get-Process $Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { Write-Output "0,0,noapp"; exit 1 }
$h = $p.MainWindowHandle

[Raise.R]::ShowWindow($h, 9) | Out-Null                                    # SW_RESTORE
[Raise.R]::SetWindowPos($h, [IntPtr](-1), 60, 60, 1500, 1000, 0x0040) | Out-Null  # HWND_TOPMOST

$fgWin = [Raise.R]::GetForegroundWindow()
$fgThread = [Raise.R]::GetWindowThreadProcessId($fgWin, [IntPtr]::Zero)
$me = [Raise.R]::GetCurrentThreadId()
$attached = [Raise.R]::AttachThreadInput($me, $fgThread, $true)
[Raise.R]::BringWindowToTop($h) | Out-Null
[Raise.R]::SetForegroundWindow($h) | Out-Null
[Raise.R]::SwitchToThisWindow($h, $true)
if ($attached) { [Raise.R]::AttachThreadInput($me, $fgThread, $false) | Out-Null }

Start-Sleep -Milliseconds 900
$pt = New-Object Raise.R+POINT
[Raise.R]::ClientToScreen($h, [ref]$pt) | Out-Null
$state = if ([Raise.R]::GetForegroundWindow() -eq $h) { "fg" } else { "bg" }
Write-Output "$($pt.X),$($pt.Y),$state"
