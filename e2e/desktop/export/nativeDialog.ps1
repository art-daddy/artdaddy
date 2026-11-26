# Answer one native window of the app: the Save As dialog, a message box, or the main window's close button.
#
# The Save As dialog is a Windows common dialog: the page cannot reach it, and the app has no test hook to
# stand in for it, so this script is what a person's hands would do there, written down so it repeats.
# UI Automation finds the dialog and its controls (by window class and control id); the actions are the
# window messages the controls answer to (set the file name, press Save), posted to those windows. Nothing
# moves the mouse, types on the keyboard or takes the foreground, so a person using this PC at the same time
# is not disturbed and no input can land in another program.
#
#   -Kind save     wait for the file dialog titled -Title (the app's "Export video"; a title ending in * matches
#                  its start, for File > Import Media's long one), report the name it suggests and the folder it
#                  opened in, then type -Path and press its OK button (Save, or Open), or press Cancel
#                  (-Button Cancel). -Overwrite answers Yes when Windows asks whether to replace a file that
#                  is there; without it the answer is No.
#   -Kind message  wait for a message box titled -Title, report its text and press -Button (OK, Cancel,
#                  Yes or No).
#   -Kind close    ask the main window to close, as its X button does.
#
# Prints one JSON line. Exit code 0 when the action was taken, 1 when it was not.
param(
  [Parameter(Mandatory = $true)][int]$ProcessId,
  [Parameter(Mandatory = $true)][ValidateSet('save', 'message', 'close')][string]$Kind,
  [string]$Title = '',
  [string]$Path = '',
  [string]$Button = '',
  [switch]$Overwrite,
  [int]$TimeoutMs = 30000
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -Namespace QaExport -Name Win32 -MemberDefinition @'
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, System.Text.StringBuilder lParam);
[DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
'@
$AE = [System.Windows.Automation.AutomationElement]
$Scope = [System.Windows.Automation.TreeScope]
$WM_GETTEXT = 0x000D; $WM_CHAR = 0x0102; $EM_SETSEL = 0x00B1; $WM_COMMAND = 0x0111; $WM_CLOSE = 0x0010; $TDM_CLICK_BUTTON = 0x0466
$IDS = @{ 'ok' = 1; 'cancel' = 2; 'yes' = 6; 'no' = 7 }

function Out-Result($result, [int]$code) {
  $result | ConvertTo-Json -Compress -Depth 4
  exit $code
}
function Prop($property, $value) { New-Object System.Windows.Automation.PropertyCondition($property, $value) }
function Both($a, $b) { New-Object System.Windows.Automation.AndCondition($a, $b) }
function Hwnd($element) { [IntPtr]$element.Current.NativeWindowHandle }

# The app's top-level windows and the dialogs they own (an owned dialog is listed under its owner, and a
# dialog a dialog opens, like Windows' "Confirm Save As", under that dialog).
function Get-Dialogs {
  $found = @()
  foreach ($window in $AE::RootElement.FindAll($Scope::Children, (Prop $AE::ProcessIdProperty $ProcessId))) {
    try {
      $level = @()
      if ($window.Current.ClassName -eq '#32770') { $level += $window }
      $level += @($window.FindAll($Scope::Children, (Prop $AE::ClassNameProperty '#32770')))
      while ($level.Count -gt 0) {
        $found += $level
        $next = @()
        foreach ($d in $level) { try { $next += @($d.FindAll($Scope::Children, (Prop $AE::ClassNameProperty '#32770'))) } catch {} }
        $level = $next
      }
    } catch {}
  }
  return $found
}
function Find-Dialog([string]$name) {
  # -like: a title may end in * to match the start of a long one (the import dialog's).
  foreach ($d in Get-Dialogs) { try { if ($name -eq '' -or $d.Current.Name -like $name) { return $d } } catch {} }
  return $null
}
function Wait-Dialog([string]$name, [int]$ms) {
  $deadline = [DateTime]::UtcNow.AddMilliseconds($ms)
  while ([DateTime]::UtcNow -lt $deadline) {
    $d = Find-Dialog $name
    if ($d) { return $d }
    Start-Sleep -Milliseconds 150
  }
  return $null
}
function Text-Of([IntPtr]$h) {
  $sb = New-Object System.Text.StringBuilder 2048
  [void][QaExport.Win32]::SendMessage($h, $WM_GETTEXT, [IntPtr]2048, $sb)
  return $sb.ToString()
}
# A dialog's buttons answer WM_COMMAND with their control id (IDOK is Save in a Save As dialog).
function Press-Id($dialog, [int]$id) {
  [void][QaExport.Win32]::PostMessage((Hwnd $dialog), $WM_COMMAND, [IntPtr]$id, [IntPtr]::Zero)
}
function Texts($dialog) {
  $lines = @()
  foreach ($t in $dialog.FindAll($Scope::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
    try {
      $c = $t.Current
      if ($c.Name -and ($c.ClassName -eq 'Static' -or $c.ControlType -eq [System.Windows.Automation.ControlType]::Text)) { $lines += $c.Name }
    } catch {}
  }
  return ($lines -join "`n")
}

if ($Kind -eq 'close') {
  foreach ($window in $AE::RootElement.FindAll($Scope::Children, (Prop $AE::ProcessIdProperty $ProcessId))) {
    if ($window.Current.ClassName -eq 'Tauri Window') {
      [void][QaExport.Win32]::PostMessage((Hwnd $window), $WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero)
      Out-Result @{ ok = $true; window = $window.Current.Name } 0
    }
  }
  Out-Result @{ ok = $false; reason = 'no main window' } 1
}

if ($Kind -eq 'message') {
  $dialog = Wait-Dialog $Title $TimeoutMs
  if (-not $dialog) { Out-Result @{ ok = $false; reason = "no message box titled '$Title'" } 1 }
  $text = Texts $dialog
  $want = $Button.Replace('&', '').Trim().ToLowerInvariant()
  # A plain message box: Win32 buttons, pressed by their control id.
  foreach ($b in $dialog.FindAll($Scope::Children, (Prop $AE::ClassNameProperty 'Button'))) {
    if ($b.Current.Name.Replace('&', '').Trim().ToLowerInvariant() -eq $want) {
      Press-Id $dialog ([int]$b.Current.AutomationId)
      Out-Result @{ ok = $true; title = $dialog.Current.Name; text = $text; pressed = $Button } 0
    }
  }
  # A task dialog: its buttons are drawn inside it; the common ones have the standard ids.
  if ($IDS.ContainsKey($want)) {
    [void][QaExport.Win32]::PostMessage((Hwnd $dialog), $TDM_CLICK_BUTTON, [IntPtr]$IDS[$want], [IntPtr]::Zero)
    Out-Result @{ ok = $true; title = $dialog.Current.Name; text = $text; pressed = $Button; via = 'task dialog' } 0
  }
  Out-Result @{ ok = $false; reason = "no button '$Button'"; text = $text } 1
}

# -Kind save
$dialog = Wait-Dialog $Title $TimeoutMs
if (-not $dialog) { Out-Result @{ ok = $false; reason = "no Save As dialog titled '$Title'" } 1 }
# The File name box (an Edit: control 1001 in a Save dialog, 1148 in an Open dialog) appears a moment after
# the dialog's frame does.
$edit = $null
$nameBox = New-Object System.Windows.Automation.OrCondition((Prop $AE::AutomationIdProperty '1001'), (Prop $AE::AutomationIdProperty '1148'))
$deadline = [DateTime]::UtcNow.AddMilliseconds(10000)
while (-not $edit -and [DateTime]::UtcNow -lt $deadline) {
  $edit = $dialog.FindFirst($Scope::Descendants, (Both $nameBox (Prop $AE::ClassNameProperty 'Edit')))
  if (-not $edit) { Start-Sleep -Milliseconds 150 }
}
if (-not $edit) { Press-Id $dialog 2; Out-Result @{ ok = $false; reason = 'no File name box (the dialog was cancelled)' } 1 }
$suggested = Text-Of (Hwnd $edit)
$folder = $null
$address = $dialog.FindFirst($Scope::Descendants, (Both (Prop $AE::AutomationIdProperty '1001') (Prop $AE::ClassNameProperty 'ToolbarWindow32')))
if ($address -and $address.Current.Name -match '^Address: (.+)$') { $folder = $Matches[1] }
$type = $null
$typeHost = $dialog.FindFirst($Scope::Descendants, (Prop $AE::AutomationIdProperty 'FileTypeControlHost'))
if ($typeHost) {
  $combo = $typeHost.FindFirst($Scope::Descendants, (Prop $AE::ClassNameProperty 'ComboBox'))
  if ($combo) { $type = Text-Of (Hwnd $combo) }
}
$result = [ordered]@{ ok = $true; title = $dialog.Current.Name; suggested = $suggested; folder = $folder; type = $type; overwriteAsked = $false }
if ($Button -ieq 'Cancel') {
  Press-Id $dialog 2
  $result.pressed = 'Cancel'
} else {
  # Typed, one character at a time, over the suggested name. Setting the box's text directly (WM_SETTEXT)
  # changes what it shows but not what the dialog returns: it saved under the suggested name, in the
  # suggested folder, on 26 Nov. A typed character is what the dialog listens to.
  $h = Hwnd $edit
  [void][QaExport.Win32]::SendMessage($h, $EM_SETSEL, [IntPtr]0, [IntPtr](-1))
  foreach ($ch in $Path.ToCharArray()) { [void][QaExport.Win32]::SendMessage($h, $WM_CHAR, [IntPtr][int]$ch, [IntPtr]::Zero) }
  $typed = Text-Of $h
  if ($typed -ne $Path) { Out-Result @{ ok = $false; reason = "the File name box reads '$typed' after typing"; suggested = $suggested } 1 }
  Press-Id $dialog 1
  $result.pressed = 'Save'
  # Windows asks before replacing a file that is there ("Confirm Save As").
  $confirm = Wait-Dialog 'Confirm Save As' 3000
  if ($confirm) {
    $result.overwriteAsked = $true
    $result.overwriteText = Texts $confirm
    $answer = if ($Overwrite) { 'yes' } else { 'no' }
    $hit = $false
    foreach ($b in $confirm.FindAll($Scope::Children, (Prop $AE::ClassNameProperty 'Button'))) {
      if ($b.Current.Name.Replace('&', '').Trim() -ieq $answer) { Press-Id $confirm ([int]$b.Current.AutomationId); $hit = $true }
    }
    if (-not $hit) { [void][QaExport.Win32]::PostMessage((Hwnd $confirm), $TDM_CLICK_BUTTON, [IntPtr]$IDS[$answer], [IntPtr]::Zero) }
    $result.overwriteAnswer = $answer
  }
}
# The dialog must be gone: a name Windows refused, or a No to the replace question, leaves it open. A dialog
# left open would hold the app for every later step, so it is cancelled, and the run is told.
$deadline = [DateTime]::UtcNow.AddMilliseconds(6000)
while ([DateTime]::UtcNow -lt $deadline -and (Find-Dialog $Title)) { Start-Sleep -Milliseconds 150 }
$still = Find-Dialog $Title
if ($still) {
  $result.ok = $false
  $result.reason = 'the Save As dialog is still open'
  foreach ($d in Get-Dialogs) {
    try {
      if ($d.Current.Name -ne $still.Current.Name) {
        $result.reason += "; another dialog is open: '$($d.Current.Name)' $(Texts $d)"
        [void][QaExport.Win32]::PostMessage((Hwnd $d), $TDM_CLICK_BUTTON, [IntPtr]$IDS['no'], [IntPtr]::Zero)
        Press-Id $d $IDS['no']
      }
    } catch {}
  }
  Start-Sleep -Milliseconds 500
  Press-Id $still 2
  $result.reason += ' (it was cancelled)'
}
Out-Result $result ($(if ($result.ok) { 0 } else { 1 }))
