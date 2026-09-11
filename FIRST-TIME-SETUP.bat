@echo off
setlocal enabledelayedexpansion
title GameCut - First time setup
cd /d "%~dp0"

echo.
echo   ==========================================
echo     GameCut  -  first time setup
echo   ==========================================
echo.
echo   You only ever do this once.
echo.

:: ---- Node check -------------------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo   [X] Node.js is not installed.
  echo.
  echo       Download the LTS installer from:
  echo         https://nodejs.org
  echo.
  echo       Run it, accept the defaults, then CLOSE this window
  echo       and double-click this file again.
  echo.
  pause
  exit /b 1
)
for /f "tokens=*" %%v in ('node -v') do set NODEV=%%v
echo   [1/3] Node.js !NODEV! found.
echo.

:: ---- Install ----------------------------------------------------------
if not exist "node_modules\" (
  echo   [2/3] Installing build tools ^(first run downloads ~250 MB^)...
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo   [X] npm install failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
) else (
  echo   [2/3] Build tools already installed.
)
echo.

:: ---- The signing key --------------------------------------------------
:: This is the whole point of the script. Everything an install accepts as an
:: update has to be signed with this key, so it has to exist before anything
:: can be published - and it has to be made on THIS machine, by you.
echo   [3/3] Making your signing key...
echo.
call npm run --silent keygen
if errorlevel 1 (
  echo.
  echo   [X] Could not make the signing key.
  pause
  exit /b 1
)

echo.
echo   ==========================================
echo     Done. What just happened:
echo   ==========================================
echo.
echo     A key was made. The PUBLIC half is now inside GameCut, and
echo     every copy you build from here on carries it. The PRIVATE half
echo     is in your user folder, under .gamecut
echo.
echo     That private file is a password. Anyone who has it can send an
echo     update to every copy of GameCut you have ever handed out.
echo     Do not put it in the GameCut folder. Do not upload it anywhere.
echo.
echo     Next: double-click PUBLISH.bat
echo.
pause
