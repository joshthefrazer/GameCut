@echo off
setlocal enabledelayedexpansion
title GameCut - Publish a release
cd /d "%~dp0"

echo.
echo   ==========================================
echo     GameCut  -  publishing a release
echo   ==========================================
echo.

:: ---- Node check -------------------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo   [X] Node.js is not installed. Run FIRST-TIME-SETUP.bat first.
  echo.
  pause
  exit /b 1
)
if not exist "node_modules\" (
  echo   [X] Build tools are missing. Run FIRST-TIME-SETUP.bat first.
  echo.
  pause
  exit /b 1
)

:: ---- Close a running copy ---------------------------------------------
:: Windows will not overwrite a file that is open, and the build writes over
:: the last .exe.
taskkill /F /IM "GameCut.exe" /T >nul 2>nul

:: ---- Build the site ---------------------------------------------------
:: The release tool answers with exit code 3 when this version needs a Windows
:: build that does not exist yet. That is not an error - it is the one question
:: this script exists to answer, so it builds one and asks again.
echo   [1/2] Building the release...
echo.
call npm run --silent release -- --require-installer
set CODE=%errorlevel%

if "%CODE%"=="3" (
  echo.
  echo   ------------------------------------------
  echo     This one needs a new GameCut.exe.
  echo     Building it now - about three minutes.
  echo   ------------------------------------------
  echo.
  call npm run --silent dist
  if errorlevel 1 (
    echo.
    echo   [X] The build failed. Nothing was published.
    echo.
    pause
    exit /b 1
  )
  echo.
  echo   [2/2] Building the release again, with the installer...
  echo.
  call npm run --silent release
  if errorlevel 1 goto :failed
) else if not "%CODE%"=="0" (
  goto :failed
)

echo.
echo   ==========================================
echo     Built. Now put it on GitHub:
echo   ==========================================
echo.
echo     1. Open GitHub Desktop
echo     2. It will list the files that changed
echo     3. Type a message in the box, bottom left  ^(e.g. "Release 1.6.0"^)
echo     4. Click  Commit to main
echo     5. Click  Push origin       ^(top right^)
echo.
echo     Give it a minute, then check:
echo       https://joshthefrazer.github.io/GameCut/
echo.
echo     Everyone running GameCut finds it within six hours, or straight
echo     away if they click the version number and press Check now.
echo.
pause
exit /b 0

:failed
echo.
echo   [X] Something went wrong above. Nothing was published.
echo       Read the message, fix it, and run this again.
echo.
pause
exit /b 1
