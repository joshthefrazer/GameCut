; Installer hooks for GameCut.
;
; Windows will not let anyone overwrite a file that is open, and the installer
; writes into a folder it may well be running out of. If GameCut is open — or a
; previous uninstaller is still shutting down — the install stops partway with
; "Error opening file for writing: ... Uninstall GameCut.exe", which reads like
; a broken download and is nothing of the kind.
;
; So close it first, rather than asking the person to know that.
;
; electron-builder inserts these macros into its own NSIS template. A macro the
; template does not reference is simply never expanded, so defining both the
; install and uninstall hooks is safe either way.

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
