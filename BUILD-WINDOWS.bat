@echo off
setlocal enabledelayedexpansion
title GameCut - Build Windows App
cd /d "%~dp0"

echo.
echo   ==========================================
echo     GameCut  -  building the Windows app
echo   ==========================================
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
echo   [1/4] Node.js !NODEV! found.
echo.

:: ---- Close a running copy ---------------------------------------------
:: Windows will not overwrite a file that is open. Building or installing
:: over a running GameCut is what produces "Error opening file for writing".
taskkill /F /IM "GameCut.exe" /T >nul 2>nul
echo   [2/4] Closed any running copy of GameCut.
echo.

:: ---- Install ----------------------------------------------------------
echo   [3/4] Installing build tools ^(first run downloads ~250 MB^)...
echo.
call npm install --no-audit --no-fund
if errorlevel 1 (
  echo.
  echo   [X] Install failed. Check your internet connection and try again.
  echo.
  pause
  exit /b 1
)

:: ---- Build ------------------------------------------------------------
echo.
echo   [4/4] Building GameCut ^(takes 1-3 minutes^)...
echo.
call npx electron-builder --win --x64
if errorlevel 1 (
  echo.
  echo   [X] Build failed. The error is above this line.
  echo.
  pause
  exit /b 1
)

echo.
echo   ==========================================
echo     Done. Two ways to run it, both in "dist":
echo.
echo     1. NO INSTALL  ^(recommended^)
echo          dist\win-unpacked\GameCut.exe
echo        Double-click it and it runs. Right-click it
echo        once and "Show more options ^> Send to ^>
echo        Desktop" to get a shortcut.
echo.
echo     2. INSTALLER
echo          dist\GameCut-1.0.0-x64.exe
echo        Adds Start menu and desktop shortcuts.
echo   ==========================================
echo.
if exist "dist" start "" "dist"
pause
