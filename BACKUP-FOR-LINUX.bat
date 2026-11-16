@echo off
setlocal enabledelayedexpansion
title GameCut - Backup before moving to Linux

echo.
echo   ==========================================
echo     Backup before moving to Linux
echo   ==========================================
echo.
echo   This COPIES (never moves or deletes) to your backup drive:
echo     1. Your GameCut signing key  (without it you can never ship an update again)
echo     2. Your whole Dev folder     (GameCut 1.7.0 and your other projects)
echo     3. Your GameCut projects     (saved edits and frozen frames)
echo     4. Your OBS settings         (scenes and profiles, OBS runs on Linux too)
echo.

:ask
set "DRIVE="
set /p "DRIVE=  Type the letter of your backup drive (for example E) and press Enter: "
set "DRIVE=!DRIVE::=!"
set "DRIVE=!DRIVE: =!"
if "!DRIVE!"=="" goto ask
if /i "!DRIVE!"=="C" (
  echo   [X] C is this computer's own drive. Pick the external hard drive.
  goto ask
)
if not exist "!DRIVE!:\" (
  echo   [X] There is no drive !DRIVE!: plugged in. Check This PC for its letter.
  goto ask
)

set "DEST=!DRIVE!:\GameCut-Backup"
echo.
echo   Copying to !DEST! ...
echo.

set FAILED=0

echo   [1/4] Signing key...
robocopy "%USERPROFILE%\.gamecut" "!DEST!\gamecut-signing-key" /E /R:1 /W:1 /NFL /NDL /NP /NJH /NJS
if errorlevel 8 set FAILED=1

echo   [2/4] Dev folder (this one takes the longest)...
robocopy "%USERPROFILE%\Dev" "!DEST!\Dev" /E /R:1 /W:1 /NFL /NDL /NP /NJH /NJS /XD node_modules .probe-electron win-unpacked
if errorlevel 8 set FAILED=1

echo   [3/4] GameCut projects...
if exist "%APPDATA%\gamecut" (
  robocopy "%APPDATA%\gamecut" "!DEST!\GameCut-projects" /E /R:1 /W:1 /NFL /NDL /NP /NJH /NJS /XD Cache "Code Cache" GPUCache DawnGraphiteCache DawnWebGPUCache "Service Worker" blob_storage Crashpad
  if errorlevel 8 set FAILED=1
)

echo   [4/4] OBS settings...
if exist "%APPDATA%\obs-studio" (
  robocopy "%APPDATA%\obs-studio" "!DEST!\obs-studio-settings" /E /R:1 /W:1 /NFL /NDL /NP /NJH /NJS /XD logs crashes updates plugin_config\obs-browser\Cache
  if errorlevel 8 set FAILED=1
)

echo.
echo   ==========================================
if exist "!DEST!\gamecut-signing-key\signing-key.pem" (
  echo     Signing key: SAVED
) else (
  echo     Signing key: NOT FOUND IN THE BACKUP - tell Claude before wiping anything!
  set FAILED=1
)
if exist "!DEST!\Dev\GameCut\package.json" (
  echo     GameCut code: SAVED
) else (
  echo     GameCut code: NOT FOUND IN THE BACKUP
  set FAILED=1
)
if "!FAILED!"=="0" (
  echo.
  echo     All done. Everything is in !DEST!
) else (
  echo.
  echo     Something did not copy. Do NOT wipe Windows yet.
)
echo.
echo     Not included - copy these yourself if you want them:
echo       - your recordings  (Videos folder, and C:\Medal)
echo       - anything else on your Desktop / Documents / Downloads
echo   ==========================================
echo.
pause
