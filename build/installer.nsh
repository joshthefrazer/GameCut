; Installer hooks for GameCut.
;
; electron-builder inserts these macros into its own NSIS template. A macro the
; template does not reference is simply never expanded, so defining one it does
; not know about is harmless — and the three it does know about here are
; customInit, customWelcomePage and customFinishPage.

; ── Closing a running copy ─────────────────────────────────────
; Windows will not let anyone overwrite a file that is open, and the installer
; writes into a folder it may well be running out of. If GameCut is open — or a
; previous uninstaller is still shutting down — the install stops partway with
; "Error opening file for writing: ... Uninstall GameCut.exe", which reads like
; a broken download and is nothing of the kind.
;
; So close it first, rather than asking the person to know that.

!macro customInit
  ; /T takes the process tree with it — Chromium leaves helper processes, and a
  ; single one of those still holding a handle is enough to fail the write.
  nsExec::Exec 'cmd /c taskkill /F /IM "GameCut.exe" /T'
  Sleep 800
!macroend

!macro customUnInit
  nsExec::Exec 'cmd /c taskkill /F /IM "GameCut.exe" /T'
  Sleep 800
!macroend


; ── The first page ─────────────────────────────────────────────
; Without this the installer opens straight onto "choose a folder", which tells
; someone who has just downloaded a 90MB file from a stranger's website nothing
; at all about what they are about to run. A page with the name on it, what the
; thing is, and who made it is the least an installer can do.

!macro customWelcomePage
  ; electron-builder ALREADY passes MUI_WELCOMEFINISHPAGE_BITMAP on the makensis
  ; command line, pointed at the stock nsis3-metro.bmp. A plain !define on top of
  ; that is not "the last one wins" — NSIS stops the build with
  ;   !define: "MUI_WELCOMEFINISHPAGE_BITMAP" already defined!
  ; so the side panel has to be swapped in, not merely set.
  !ifdef MUI_WELCOMEFINISHPAGE_BITMAP
    !undef MUI_WELCOMEFINISHPAGE_BITMAP
  !endif
  !define MUI_WELCOMEFINISHPAGE_BITMAP "${BUILD_RESOURCES_DIR}\installer-side.bmp"
  !ifdef MUI_WELCOMEPAGE_TITLE
    !undef MUI_WELCOMEPAGE_TITLE
  !endif
  !define MUI_WELCOMEPAGE_TITLE "GameCut"
  !ifdef MUI_WELCOMEPAGE_TEXT
    !undef MUI_WELCOMEPAGE_TEXT
  !endif
  !define MUI_WELCOMEPAGE_TEXT "A video editor for gaming clips, made by Frazer's Softwares.$\r$\n$\r$\nMulti-track timeline, transitions, graphics and titles, and export straight to MP4. Everything happens on this computer: no account, no upload, no subscription, and your footage never leaves the machine.$\r$\n$\r$\nThis installs for you only, so it will not ask for an administrator password.$\r$\n$\r$\nClick Next to choose where it goes."
  !insertmacro MUI_PAGE_WELCOME
!macroend


; ── The last page ──────────────────────────────────────────────
; Two offers: open it, and pin it.
;
; Pinning is not as simple as it should be. Microsoft closed the documented way
; for a program to pin itself to the taskbar, and every "trick" that still works
; is one Windows update away from not working. So this tries the shell verb, and
; when that is refused — which on a current Windows 11 it usually is — it opens
; the folder with the shortcut selected and says, in one sentence, what to drag
; where. That is worse than a button that just works, and much better than a
; checkbox that silently does nothing.

!macro customFinishPage
  ; Mirrors what electron-builder's own template does for "run after finish";
  ; defining this macro replaces that whole block, so it has to be repeated.
  Function StartApp
    ${if} ${isUpdated}
      StrCpy $1 "--updated"
    ${else}
      StrCpy $1 ""
    ${endif}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd

  Function PinGameCut
    ; The script is written out rather than passed with -Command: quoting a
    ; PowerShell one-liner through NSIS and then through cmd is three levels of
    ; escaping, and every one of them is a chance to ship something that fails
    ; only on somebody else's machine.
    InitPluginsDir
    FileOpen $9 "$PLUGINSDIR\pin.ps1" w
    FileWrite $9 "$$lnk = '$launchLink'$\r$\n"
    FileWrite $9 "if (-not (Test-Path $$lnk)) { exit 1 }$\r$\n"
    FileWrite $9 "try {$\r$\n"
    FileWrite $9 "  $$sh = New-Object -ComObject Shell.Application$\r$\n"
    FileWrite $9 "  $$item = $$sh.Namespace((Split-Path $$lnk)).ParseName((Split-Path $$lnk -Leaf))$\r$\n"
    FileWrite $9 "  $$verb = $$item.Verbs() | Where-Object { ($$_.Name -replace '&','') -match '^Pin to tas' }$\r$\n"
    FileWrite $9 "  if ($$verb) { $$verb.DoIt(); exit 0 }$\r$\n"
    FileWrite $9 "} catch { }$\r$\n"
    FileWrite $9 "exit 1$\r$\n"
    FileClose $9

    nsExec::Exec 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "$PLUGINSDIR\pin.ps1"'
    Pop $0

    ${If} $0 != 0
      MessageBox MB_OK|MB_ICONINFORMATION "Windows no longer lets a program pin itself to the taskbar.$\r$\n$\r$\nI will open the folder with GameCut in it — drag the GameCut icon down onto your taskbar, or right-click it and choose Pin to taskbar."
      ExecShell "open" "explorer.exe" '/select,"$launchLink"'
    ${EndIf}
  FunctionEnd

  ; Already set by the welcome page above; MUI keeps one bitmap for both.
  !ifndef MUI_WELCOMEFINISHPAGE_BITMAP
    !define MUI_WELCOMEFINISHPAGE_BITMAP "${BUILD_RESOURCES_DIR}\installer-side.bmp"
  !endif
  !ifdef MUI_FINISHPAGE_TITLE
    !undef MUI_FINISHPAGE_TITLE
  !endif
  !define MUI_FINISHPAGE_TITLE "GameCut is ready"
  !ifdef MUI_FINISHPAGE_TEXT
    !undef MUI_FINISHPAGE_TEXT
  !endif
  !define MUI_FINISHPAGE_TEXT "It is in your Start menu and on your desktop.$\r$\n$\r$\nGameCut checks for its own updates and will tell you when there is one — you will not have to come back here."

  !ifdef MUI_FINISHPAGE_RUN
    !undef MUI_FINISHPAGE_RUN
  !endif
  !define MUI_FINISHPAGE_RUN
  !ifdef MUI_FINISHPAGE_RUN_FUNCTION
    !undef MUI_FINISHPAGE_RUN_FUNCTION
  !endif
  !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !ifdef MUI_FINISHPAGE_RUN_TEXT
    !undef MUI_FINISHPAGE_RUN_TEXT
  !endif
  !define MUI_FINISHPAGE_RUN_TEXT "Open GameCut now"

  ; SHOWREADME is NSIS's second finish-page checkbox. Pointed at a function, it
  ; is simply "an extra thing to offer", which is what it is being used for.
  !ifdef MUI_FINISHPAGE_SHOWREADME
    !undef MUI_FINISHPAGE_SHOWREADME
  !endif
  !define MUI_FINISHPAGE_SHOWREADME ""
  !ifdef MUI_FINISHPAGE_SHOWREADME_TEXT
    !undef MUI_FINISHPAGE_SHOWREADME_TEXT
  !endif
  !define MUI_FINISHPAGE_SHOWREADME_TEXT "Pin GameCut to my taskbar"
  !ifdef MUI_FINISHPAGE_SHOWREADME_FUNCTION
    !undef MUI_FINISHPAGE_SHOWREADME_FUNCTION
  !endif
  !define MUI_FINISHPAGE_SHOWREADME_FUNCTION "PinGameCut"

  !ifdef MUI_FINISHPAGE_LINK
    !undef MUI_FINISHPAGE_LINK
  !endif
  !define MUI_FINISHPAGE_LINK "Frazer's Softwares"
  !ifdef MUI_FINISHPAGE_LINK_LOCATION
    !undef MUI_FINISHPAGE_LINK_LOCATION
  !endif
  !define MUI_FINISHPAGE_LINK_LOCATION "https://joshthefrazer.github.io/GameCut/"

  !insertmacro MUI_PAGE_FINISH
!macroend
