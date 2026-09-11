# Building GameCut.exe

## The short version

Double-click **`BUILD-WINDOWS.bat`**.

It checks for Node.js, installs the build tools, and produces the app. No
terminal, no commands to type. First run takes a few minutes because it
downloads the Electron runtime (~250 MB); after that it's under a minute.

When it finishes, the `dist` folder opens with two ways to run it:

| | What it is |
|---|---|
| `dist\win-unpacked\GameCut.exe` | **Recommended.** Double-click and it runs. No install, nothing written outside this folder, starts instantly. Right-click it once and *Send to → Desktop* for a shortcut. |
| `dist\GameCut-1.0.0-x64.exe` | Installer. Adds Start-menu and desktop shortcuts and an uninstaller. |

For one person on one machine the folder is the better of the two: there is no
install step to go wrong, updating means replacing the folder, and it starts
immediately rather than unpacking itself first.

### "Error opening file for writing … Uninstall GameCut.exe"

Windows will not overwrite a file that is open, and the installer writes into a
folder it may be running out of. If GameCut — or a helper process of it, or a
previous uninstaller — still has a handle on anything in there, the install
stops partway with that message. It is a file lock, not a corrupt download.

The installer now runs `taskkill` on GameCut before it copies anything, which
covers the usual cause. If it still happens:

1. **Abort**, and close GameCut. Check Task Manager for any leftover
   `GameCut.exe` entries and end them.
2. Delete the folder it named —
   `C:\Users\<you>\AppData\Local\Programs\GameCut`.
3. Run the installer again.

Or skip it entirely and use `dist\win-unpacked\GameCut.exe`, which has no
installer and therefore none of this.

If Node.js isn't installed the script tells you and stops. Get the **LTS**
build from <https://nodejs.org>, run it with the default options, then
double-click `BUILD-WINDOWS.bat` again.

## Why isn't there a prebuilt .exe in this folder?

Windows installers can only be assembled on Windows. The packaging step has to
stamp the icon and version into the executable and run the NSIS installer
compiler, and both are Windows programs. Building this on Linux needs Wine, and
the result is less reliable than just building it on the machine that will run
it. Everything else — the app, the config, the icon — is done; the `.bat` file
runs the last step where it belongs.

## From a terminal instead

```powershell
npm install
npm run dist              # installer + no-install folder, x64
npm start                 # run the app without packaging it
```

## Other platforms

```bash
npx electron-builder --mac      # .dmg   (must run on macOS)
npx electron-builder --linux    # AppImage
```

## Regenerating the icon

`build/icon.ico` is committed, so you only need this if you change the artwork:

```bash
npm run icon              # requires python3 + Pillow
```

## Tests

```bash
npm test                  # core application suite: 90 checks
npm run test:electron     # shell, isolation and security boundaries
npm run test:media        # real video/audio files, end to end
npm run test:packaged     # boots the packaged build from its asar
```

Each suite fails on any console error, page error or failed request — there is
no "expected noise" allowance beyond a documented filter for the harness's own
pixel reads and Chromium's GPU chatter under a virtual display.
