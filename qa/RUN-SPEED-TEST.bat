@echo off
rem  Strike export speed test: old behaviour against new, on this computer.
rem  Drag a 1080p60 video onto this file, or:  RUN-SPEED-TEST.bat "C:\path\clip.mp4"
rem  Extra options are passed on, e.g.:  RUN-SPEED-TEST.bat "clip.mp4" --secs 10 --rounds 3
setlocal
title Strike speed test
cd /d "%~dp0.."

echo.
echo   Strike export speed test
echo   ------------------------

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed on this computer.
  echo   Install the LTS version from https://nodejs.org ^(default options^), then run this again.
  goto :end
)

if "%~1"=="" (
  echo.
  echo   Drag a 1080p60 video onto this file, or run it as:
  echo      RUN-SPEED-TEST.bat "C:\path\clip.mp4"
  goto :end
)
if not exist "%~1" (
  echo.
  echo   Cannot find that video: %~1
  goto :end
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo.
  echo   First run: installing the app's tools. This downloads about 300 MB and can take a few minutes...
  call npm install --no-package-lock --no-audit --no-fund
  if errorlevel 1 goto :fail
)
if not exist "node_modules\playwright\package.json" (
  call npm install --no-save --no-package-lock --no-audit --no-fund playwright
  if errorlevel 1 goto :fail
)

echo.
echo   Running. It opens Strike windows by itself. Please leave the computer alone until it says Done.
echo   This takes roughly 5 to 15 minutes depending on the computer.
echo.

set "CLIP=%~1"
shift
node qa\speed-test.mjs --file "%CLIP%" %1 %2 %3 %4 %5 %6 %7 %8 %9
if errorlevel 1 goto :fail

echo.
echo   Finished. The results were saved in:  %CD%\qa\out
echo   Please send or paste the newest speed-test-*.txt file.
start "" explorer "%CD%\qa\out"
goto :end

:fail
echo.
echo   Something went wrong ^(see the messages above^). Take a photo or copy them and send them over.

:end
echo.
pause
endlocal
