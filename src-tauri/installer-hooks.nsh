; NSIS hooks for the ArtDaddy installer.
;
; The app shipped as productName "akaru" up to 0.6.0 and is "artdaddy" from 0.7.0. Tauri's NSIS
; keys its uninstall entry and its install directory by PRODUCT NAME, not by the bundle
; identifier — verified on a real 0.6.0 install: key "akaru", dir %LOCALAPPDATA%\artdaddy. Without
; this hook the rename installs a SECOND copy: two Add/Remove entries, two install dirs, and the
; old Start Menu shortcut still launching 0.6.0.
;
; !! NOT VERIFIED END TO END. Do not ship until a real 0.6.0 -> current upgrade has been run on
; a machine that has 0.6.0 installed. Two specific things to prove, in this order:
;   1. The old uninstaller must NOT remove %APPDATA%\ArtDaddy. A 0.6.0 user's projects still live
;      there — the new app only migrates them at FIRST LAUNCH, which is after this hook. If the
;      uninstaller deletes app data, this hook destroys their work.
;   2. The install must still complete if the uninstaller is missing, refuses, or is cancelled.
; If (1) does not hold, do not uninstall from here: install alongside, and have the app offer to
; remove the old copy AFTER its data migration has run.

!macro NSIS_HOOK_PREINSTALL
  ; Per-user install (the default for this app), then the machine-wide key as a fallback.
  ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\akaru" "UninstallString"
  ${If} $R0 == ""
    ReadRegStr $R0 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\akaru" "UninstallString"
  ${EndIf}
  ${If} $R0 != ""
    ReadRegStr $R1 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\akaru" "InstallLocation"
    ${If} $R1 == ""
      ReadRegStr $R1 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\akaru" "InstallLocation"
    ${EndIf}
    ; _?= keeps the uninstaller in place so ExecWait actually waits; without it NSIS copies
    ; itself to temp and returns immediately. No /P: the shipped 0.6.0 uninstaller does not
    ; carry that flag, so passing it was guesswork.
    ${If} $R1 != ""
      ExecWait '$R0 /S _?=$R1'
    ${Else}
      ExecWait '$R0 /S'
      Sleep 1500
    ${EndIf}
  ${EndIf}
!macroend
