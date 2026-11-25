; Installer hooks for Strike.
;
; electron-builder inserts these macros into its own NSIS template. Three
; screens, all dark: Start (what it is, where it goes, Install), Installing,
; Ready. The folder choice lives on the first screen, so the template's own
; folder page is off (allowToChangeInstallationDirectory: false in package.json).
;
; The pictures come from tools/make-installer-art.cjs.
; To look at the pages without installing anything: node qa/installer-preview.mjs

!define ST_BG   "0A0E19"
!define ST_CARD "121829"
!define ST_TEXT "FFFFFF"
!define ST_DIM  "9FB0D0"
!define ST_VOLT "C6FF3D"

; Modern UI's own colours: the strip at the top of the progress screen, and the uninstaller.
!define MUI_BGCOLOR   "${ST_BG}"
!define MUI_TEXTCOLOR "${ST_TEXT}"

; ── Closing a running copy ─────────────────────────────────────
; Windows will not let anyone overwrite a file that is open, and the installer
; writes into a folder it may well be running out of. If Strike is open — or a
; previous uninstaller is still shutting down — the install stops partway with
; "Error opening file for writing: ... Uninstall Strike.exe", which reads like
; a broken download and is nothing of the kind.
;
; So close it first, rather than asking the person to know that.

; It asks first when a person is doing the installing. Updates Strike started by
; itself (and silent installs) were already agreed to, so those just close it.
; Closing is polite to begin with (Strike saves), forced only if that is ignored.
!macro StrikeClose IMAGE
  nsExec::Exec 'cmd /c taskkill /IM "${IMAGE}"'
  Pop $0
  StrCpy $1 0
  ${Do}
    nsExec::Exec 'cmd /c tasklist /FI "IMAGENAME eq ${IMAGE}" | find /I "${IMAGE}"'
    Pop $0
    ${If} $0 != 0
      ${ExitDo}
    ${EndIf}
    Sleep 500
    IntOp $1 $1 + 1
  ${LoopUntil} $1 >= 16
  ; /T takes the process tree with it: Chromium leaves helper processes, and one
  ; of those still holding a file is enough to fail the write.
  nsExec::Exec 'cmd /c taskkill /F /IM "${IMAGE}" /T'
  Pop $0
!macroend

!macro StrikeAskAndClose ASK
  StrCpy $2 "no"
  nsExec::Exec 'cmd /c tasklist /FI "IMAGENAME eq Strike.exe" | find /I "Strike.exe"'
  Pop $0
  ${If} $0 = 0
    StrCpy $2 "yes"
  ${EndIf}
  nsExec::Exec 'cmd /c tasklist /FI "IMAGENAME eq GameCut.exe" | find /I "GameCut.exe"'
  Pop $0
  ${If} $0 = 0
    StrCpy $2 "yes"
  ${EndIf}
  ${If} $2 == "yes"
    ${IfNot} ${Silent}
    ${AndIfNot} ${isUpdated}
      MessageBox MB_OKCANCEL|MB_ICONINFORMATION "${ASK}" /SD IDOK IDOK +2
      Quit
    ${EndIf}
    !insertmacro StrikeClose "Strike.exe"
    !insertmacro StrikeClose "GameCut.exe"
    Sleep 500
  ${EndIf}
!macroend

!macro customInit
  !insertmacro StrikeAskAndClose "Strike is open.$\r$\n$\r$\nPress OK to let the installer save and close it, or Cancel to go back to what you were doing."
  !insertmacro StrikeGuardOld HKCU
!macroend

!macro customUnInit
  !insertmacro StrikeAskAndClose "Strike is open.$\r$\n$\r$\nPress OK to close it and carry on uninstalling, or Cancel to keep Strike."
!macroend


; ── Other programs' files ──────────────────────────────────────
; "Strike" is not a rare name. A folder with someone else's program in it must
; never be installed into, and never be emptied: on 23 Nov 2026 the uninstaller
; that clears the whole folder took a different program called STRIKE with it.

; Is there a program in DIR that is not Strike's? Answer in $1: "yes" or "no".
!macro StrikeForeign DIR
  StrCpy $1 "no"
  FindFirst $2 $3 "${DIR}\*.exe"
  ${DoWhile} $3 != ""
    ${If} $3 != "Strike.exe"
    ${AndIf} $3 != "GameCut.exe"
    ${AndIf} $3 != "Uninstall Strike.exe"
    ${AndIf} $3 != "Uninstall GameCut.exe"
      StrCpy $1 "yes"
    ${EndIf}
    FindNext $2 $3
  ${Loop}
  FindClose $2
!macroend

; The uninstaller removes what Strike put there, by name, and the folder only if
; that leaves it empty.
!macro customRemoveFiles
  Delete "$INSTDIR\Strike.exe"
  Delete "$INSTDIR\GameCut.exe"
  Delete "$INSTDIR\Uninstall Strike.exe"
  Delete "$INSTDIR\Uninstall GameCut.exe"
  Delete "$INSTDIR\chrome_100_percent.pak"
  Delete "$INSTDIR\chrome_200_percent.pak"
  Delete "$INSTDIR\d3dcompiler_47.dll"
  Delete "$INSTDIR\dxcompiler.dll"
  Delete "$INSTDIR\dxil.dll"
  Delete "$INSTDIR\ffmpeg.dll"
  Delete "$INSTDIR\icudtl.dat"
  Delete "$INSTDIR\libEGL.dll"
  Delete "$INSTDIR\libGLESv2.dll"
  Delete "$INSTDIR\LICENSE.electron.txt"
  Delete "$INSTDIR\LICENSES.chromium.html"
  Delete "$INSTDIR\resources.pak"
  Delete "$INSTDIR\snapshot_blob.bin"
  Delete "$INSTDIR\v8_context_snapshot.bin"
  Delete "$INSTDIR\vk_swiftshader.dll"
  Delete "$INSTDIR\vk_swiftshader_icd.json"
  Delete "$INSTDIR\vulkan-1.dll"
  Delete "$INSTDIR\resources\app.asar"
  Delete "$INSTDIR\resources\elevate.exe"
  RMDir /r "$INSTDIR\resources\app.asar.unpacked"
  RMDir "$INSTDIR\resources"
  Delete "$INSTDIR\locales\*.pak"
  RMDir "$INSTDIR\locales"
  SetOutPath "$TEMP"
  RMDir "$INSTDIR"
!macroend

; The copy already installed may carry the old uninstaller, which empties its
; whole folder. If another program lives there too, do not let it run: Strike's
; own files are taken out by name instead.
!macro StrikeGuardOld ROOT
  ReadRegStr $5 ${ROOT} "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  ${If} $5 != ""
    !insertmacro StrikeForeign "$5"
    ${If} $1 == "yes"
      DeleteRegValue ${ROOT} "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
      DeleteRegValue ${ROOT} "${INSTALL_REGISTRY_KEY}" "InstallLocation"
      Push $INSTDIR
      StrCpy $INSTDIR $5
      !insertmacro customRemoveFiles
      Pop $INSTDIR
    ${EndIf}
  ${EndIf}
!macroend

; ── Dark window ────────────────────────────────────────────────
; Every call here is a nicety: on a Windows that does not know one it fails
; quietly and the window is simply lighter.
!ifndef BUILD_UNINSTALLER
  !define MUI_CUSTOMFUNCTION_GUIINIT StrikeGui
!endif

!macro StrikeDark HWND
  System::Call 'uxtheme::#133(p ${HWND}, i 1)'
  System::Call 'uxtheme::SetWindowTheme(p ${HWND}, w "DarkMode_Explorer", p 0)'
!macroend

; The version text at the bottom and the etched lines are light grey by nature,
; and Modern UI shows them again on every page change.
!macro StrikeHideTrim
  ShowWindow $mui.Branding.Background ${SW_HIDE}
  ShowWindow $mui.Branding.Text ${SW_HIDE}
  ShowWindow $mui.Line.Standard ${SW_HIDE}
  ShowWindow $mui.Line.FullWindow ${SW_HIDE}
  GetDlgItem $R9 $HWNDPARENT 1036
  ShowWindow $R9 ${SW_HIDE}
!macroend

!macro customHeader
  !ifndef BUILD_UNINSTALLER
    Function StrikeGui
      System::Call 'uxtheme::#135(i 2)'
      System::Call 'uxtheme::#133(p $HWNDPARENT, i 1)'
      System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 20, *i 1, i 4)'
      SetCtlColors $HWNDPARENT "${ST_TEXT}" "${ST_BG}"
      CreateFont $StFontTitle "Segoe UI Semibold" 15 600
      CreateFont $StFontText "Segoe UI" 9 400
      CreateFont $StFontSmall "Segoe UI" 8 600
      CreateFont $StFontButton "Segoe UI" 9 400
      GetDlgItem $0 $HWNDPARENT 1
      !insertmacro StrikeDark $0
      SetCtlColors $0 "${ST_TEXT}" "${ST_BG}"
      SendMessage $0 ${WM_SETFONT} $StFontButton 1
      GetDlgItem $0 $HWNDPARENT 2
      !insertmacro StrikeDark $0
      SetCtlColors $0 "${ST_TEXT}" "${ST_BG}"
      SendMessage $0 ${WM_SETFONT} $StFontButton 1
      GetDlgItem $0 $HWNDPARENT 3
      !insertmacro StrikeDark $0
      SetCtlColors $0 "${ST_TEXT}" "${ST_BG}"
      SendMessage $0 ${WM_SETFONT} $StFontButton 1
    FunctionEnd
  !endif
!macroend


; ── Who it is for ──────────────────────────────────────────────
; Only for the person installing it, without asking, unless an all-users copy
; is already on this computer; then the choice is shown as before.
!macro customInstallMode
  !ifndef BUILD_UNINSTALLER
    ${If} $hasPerMachineInstallation == "0"
      StrCpy $isForceCurrentInstall "1"
    ${EndIf}
  !endif
!macroend


; ── Start ──────────────────────────────────────────────────────
; (This hook runs after "who it is for", which is what decides $INSTDIR.)
!macro customPageAfterChangeDir
  Var StFontTitle
  Var StFontText
  Var StFontSmall
  Var StFontButton
  Var StDialog
  Var StHero
  Var StHeroImage
  Var StPath
  Var StRun
  Var StPin

  !insertmacro MUI_PAGE_INIT
  !insertmacro MUI_PAGE_FUNCTION_FULLWINDOW

  Function StrikeHero
    nsDialogs::Create 1044
    Pop $StDialog
    SetCtlColors $StDialog "${ST_TEXT}" "${ST_BG}"
    InitPluginsDir
    File "/oname=$PLUGINSDIR\hero.bmp" "${BUILD_RESOURCES_DIR}\installer-hero.bmp"
    ${NSD_CreateBitmap} 0 0 100% 150 ""
    Pop $StHero
    ${NSD_SetStretchedImage} $StHero "$PLUGINSDIR\hero.bmp" $StHeroImage
  FunctionEnd

  Function StrikeStart
    ${If} ${isUpdated}
      Abort
    ${EndIf}
    ; Somebody else's "Strike" is already in the usual place: use a folder of our own.
    !insertmacro StrikeForeign "$INSTDIR"
    ${If} $1 == "yes"
      StrCpy $INSTDIR "$LOCALAPPDATA\Programs\Strike Editor"
    ${EndIf}
    Call muiPageLoadFullWindow
    !insertmacro StrikeHideTrim
    Call StrikeHero

    ${NSD_CreateLabel} 24 160 440 28 "Cut it. Caption it. Post it."
    Pop $0
    SetCtlColors $0 "${ST_TEXT}" "${ST_BG}"
    SendMessage $0 ${WM_SETFONT} $StFontTitle 1
    ${NSD_CreateLabel} 24 191 440 18 "Everything stays on this PC. No account, no uploads."
    Pop $0
    SetCtlColors $0 "${ST_DIM}" "${ST_BG}"
    SendMessage $0 ${WM_SETFONT} $StFontText 1

    ; The card with the folder in it. Its pieces are made before the card: the first made is on top.
    ${NSD_CreateLabel} 38 235 300 16 "INSTALLS TO"
    Pop $0
    SetCtlColors $0 "${ST_VOLT}" "${ST_CARD}"
    SendMessage $0 ${WM_SETFONT} $StFontSmall 1
    ${NSD_CreateLabel} 38 254 324 20 "$INSTDIR"
    Pop $StPath
    ${NSD_AddStyle} $StPath 0x8000
    SetCtlColors $StPath "${ST_TEXT}" "${ST_CARD}"
    SendMessage $StPath ${WM_SETFONT} $StFontText 1
    ${NSD_CreateButton} 374 242 86 28 "Change..."
    Pop $0
    !insertmacro StrikeDark $0
    SetCtlColors $0 "${ST_TEXT}" "${ST_CARD}"
    SendMessage $0 ${WM_SETFONT} $StFontButton 1
    ${NSD_OnClick} $0 StrikeBrowse
    ${NSD_CreateLabel} 24 225 449 62 ""
    Pop $0
    SetCtlColors $0 "" "${ST_CARD}"

    GetDlgItem $0 $HWNDPARENT 1
    SendMessage $0 ${WM_SETTEXT} 0 "STR:Install"
    GetDlgItem $1 $HWNDPARENT 3
    ShowWindow $1 ${SW_HIDE}
    System::Call 'user32::SetFocus(p r0)'
    nsDialogs::Show
    Call muiPageUnloadFullWindow
    ${NSD_FreeImage} $StHeroImage
  FunctionEnd

  ; A folder you pick gets a Strike folder inside it, unless it already is one:
  ; uninstalling empties the folder Strike is in, so it has to be Strike's own.
  Function StrikeBrowse
    Pop $0
    nsDialogs::SelectFolderDialog "Where should Strike go?" "$INSTDIR"
    Pop $0
    ${If} $0 == "error"
      Return
    ${EndIf}
    ${GetFileName} "$0" $1
    ${If} $1 != "${APP_FILENAME}"
    ${AndIf} $1 != "Strike"
    ${AndIf} $1 != "Strike Editor"
      StrCpy $2 $0 1 -1
      ${If} $2 == "\"
        StrCpy $0 "$0${APP_FILENAME}"
      ${Else}
        StrCpy $0 "$0\${APP_FILENAME}"
      ${EndIf}
    ${EndIf}
    StrCpy $INSTDIR $0
    ${NSD_SetText} $StPath "$INSTDIR"
  FunctionEnd

  Function StrikeStartLeave
    ; Something else's folder? Never install over it.
    !insertmacro StrikeForeign "$INSTDIR"
    ${If} $1 == "yes"
      MessageBox MB_OK|MB_ICONEXCLAMATION "Another program is already in that folder:$\r$\n$\r$\n$INSTDIR$\r$\n$\r$\nStrike needs a folder of its own. Please choose another one."
      Abort
    ${EndIf}
    ${If} ${FileExists} "$INSTDIR\*.*"
    ${AndIfNot} ${FileExists} "$INSTDIR\Strike.exe"
    ${AndIfNot} ${FileExists} "$INSTDIR\GameCut.exe"
    ${AndIfNot} ${FileExists} "$INSTDIR\Uninstall Strike.exe"
    ${AndIfNot} ${FileExists} "$INSTDIR\Uninstall GameCut.exe"
      ${DirState} "$INSTDIR" $0
      ${If} $0 = 1
        MessageBox MB_OK|MB_ICONEXCLAMATION "That folder already has other files in it:$\r$\n$\r$\n$INSTDIR$\r$\n$\r$\nStrike needs a folder of its own. Please choose another one."
        Abort
      ${EndIf}
    ${EndIf}
    ${GetRoot} "$INSTDIR" $0
    ClearErrors
    ${DriveSpace} "$0\" "/D=F /S=M" $1
    ${IfNot} ${Errors}
    ${AndIf} $1 < 700
      MessageBox MB_OK|MB_ICONEXCLAMATION "There is not enough room on $0 ($1 MB free, Strike needs about 700 MB).$\r$\n$\r$\nFree some space or choose another drive."
      Abort
    ${EndIf}
    ClearErrors
    CreateDirectory "$INSTDIR"
    FileOpen $0 "$INSTDIR\strike-write-test.tmp" w
    ${If} ${Errors}
      MessageBox MB_OK|MB_ICONEXCLAMATION "Windows will not let Strike write to that folder:$\r$\n$\r$\n$INSTDIR$\r$\n$\r$\nPlease choose another one."
      Abort
    ${EndIf}
    FileClose $0
    Delete "$INSTDIR\strike-write-test.tmp"
  FunctionEnd

  Page custom StrikeStart StrikeStartLeave

  ; ── Installing ───────────────────────────────────────────────
  Function StrikeWork
    !insertmacro StrikeHideTrim
    FindWindow $0 "#32770" "" $HWNDPARENT
    SetCtlColors $0 "${ST_TEXT}" "${ST_BG}"
    GetDlgItem $1 $0 1006
    SetCtlColors $1 "${ST_DIM}" "${ST_BG}"
    ; The bar in Strike's own green (0x00BBGGRR), on the card colour.
    GetDlgItem $1 $0 1004
    System::Call 'uxtheme::SetWindowTheme(p r1, w " ", w " ")'
    SendMessage $1 0x409 0 0x3DFFC6
    SendMessage $1 0x2001 0 0x29180F
    ; The "show details" button and list are never used.
    GetDlgItem $1 $0 1027
    ShowWindow $1 ${SW_HIDE}
    GetDlgItem $1 $0 1016
    ShowWindow $1 ${SW_HIDE}
    File "/oname=$PLUGINSDIR\work.bmp" "${BUILD_RESOURCES_DIR}\installer-work.bmp"
    System::Call 'user32::LoadImage(p 0, t "$PLUGINSDIR\work.bmp", i 0, i 0, i 0, i 0x10) p .r2'
    System::Call 'user32::CreateWindowEx(i 0, t "STATIC", t "", i 0x5000000E, i 0, i 74, i 450, i 118, p r0, p 0, p 0, p 0) p .r3'
    SendMessage $3 0x172 0 $2
    GetDlgItem $1 $HWNDPARENT 1
    ShowWindow $1 ${SW_HIDE}
    GetDlgItem $1 $HWNDPARENT 2
    ShowWindow $1 ${SW_HIDE}
    GetDlgItem $1 $HWNDPARENT 3
    ShowWindow $1 ${SW_HIDE}
  FunctionEnd
  AutoCloseWindow true
  !define MUI_INSTFILESPAGE_PROGRESSBAR "smooth"
  !define MUI_PAGE_HEADER_TEXT "Installing Strike"
  !define MUI_PAGE_HEADER_SUBTEXT "Less than a minute on most computers."
  !define MUI_INSTFILESPAGE_FINISHHEADER_TEXT "Installed"
  !define MUI_INSTFILESPAGE_FINISHHEADER_SUBTEXT "Strike is ready."
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW StrikeWork
!macroend


; ── Ready ──────────────────────────────────────────────────────
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

  Function PinStrike
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
      MessageBox MB_OK|MB_ICONINFORMATION "Windows no longer lets a program pin itself to the taskbar.$\r$\n$\r$\nI will open the folder with Strike in it — drag the Strike icon down onto your taskbar, or right-click it and choose Pin to taskbar."
      ExecShell "open" "explorer.exe" '/select,"$launchLink"'
    ${EndIf}
  FunctionEnd

  ; A tick box's own words cannot be coloured in a dark window, so the words sit
  ; beside it as a label, and clicking them ticks the box.
  Function StrikeTickRun
    Pop $0
    SendMessage $StRun ${BM_CLICK} 0 0
  FunctionEnd
  Function StrikeTickPin
    Pop $0
    SendMessage $StPin ${BM_CLICK} 0 0
  FunctionEnd
  Function StrikeSite
    Pop $0
    ExecShell "open" "https://joshthefrazer.github.io/GameCut/"
  FunctionEnd

  Function StrikeReady
    ${If} ${isUpdated}
    ${AndIf} ${Silent}
      Abort
    ${EndIf}
    Call muiPageLoadFullWindow
    !insertmacro StrikeHideTrim
    Call StrikeHero

    ${NSD_CreateLabel} 24 160 440 28 "Strike is ready"
    Pop $0
    SetCtlColors $0 "${ST_TEXT}" "${ST_BG}"
    SendMessage $0 ${WM_SETFONT} $StFontTitle 1
    ${NSD_CreateLabel} 24 191 440 18 "It's in your Start menu and on your desktop, and tells you about updates."
    Pop $0
    SetCtlColors $0 "${ST_DIM}" "${ST_BG}"
    SendMessage $0 ${WM_SETFONT} $StFontText 1

    ${NSD_CreateCheckBox} 24 226 16 18 "Open Strike now"
    Pop $StRun
    !insertmacro StrikeDark $StRun
    SetCtlColors $StRun "" "${ST_BG}"
    ${NSD_Check} $StRun
    ${NSD_CreateLabel} 46 227 300 18 "Open Strike now"
    Pop $0
    SetCtlColors $0 "${ST_TEXT}" "${ST_BG}"
    SendMessage $0 ${WM_SETFONT} $StFontText 1
    ${NSD_OnClick} $0 StrikeTickRun
    ${NSD_CreateCheckBox} 24 252 16 18 "Pin Strike to my taskbar"
    Pop $StPin
    !insertmacro StrikeDark $StPin
    SetCtlColors $StPin "" "${ST_BG}"
    ${NSD_CreateLabel} 46 253 300 18 "Pin Strike to my taskbar"
    Pop $0
    SetCtlColors $0 "${ST_TEXT}" "${ST_BG}"
    SendMessage $0 ${WM_SETFONT} $StFontText 1
    ${NSD_OnClick} $0 StrikeTickPin

    ${NSD_CreateLink} 24 288 200 18 "Made by Frazer's Softwares"
    Pop $0
    SetCtlColors $0 "${ST_VOLT}" "${ST_BG}"
    ${NSD_OnClick} $0 StrikeSite

    GetDlgItem $0 $HWNDPARENT 1
    SendMessage $0 ${WM_SETTEXT} 0 "STR:Finish"
    EnableWindow $0 1
    ShowWindow $0 ${SW_SHOW}
    GetDlgItem $1 $HWNDPARENT 2
    EnableWindow $1 0
    ShowWindow $1 ${SW_HIDE}
    GetDlgItem $1 $HWNDPARENT 3
    ShowWindow $1 ${SW_HIDE}
    System::Call 'user32::SetFocus(p r0)'
    nsDialogs::Show
    Call muiPageUnloadFullWindow
    ${NSD_FreeImage} $StHeroImage
  FunctionEnd

  Function StrikeReadyLeave
    ${NSD_GetState} $StPin $0
    ${If} $0 = ${BST_CHECKED}
      Call PinStrike
    ${EndIf}
    ${NSD_GetState} $StRun $0
    ${If} $0 = ${BST_CHECKED}
      Call StartApp
    ${EndIf}
  FunctionEnd

  Page custom StrikeReady StrikeReadyLeave
!macroend