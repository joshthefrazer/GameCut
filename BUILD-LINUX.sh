#!/usr/bin/env bash
# GameCut - build the Linux app (AppImage + .deb) from this folder.
#   Run it from a terminal:  bash BUILD-LINUX.sh
set -e
cd "$(dirname "$0")"

echo
echo "  =========================================="
echo "    GameCut  -  building the Linux app"
echo "  =========================================="
echo

if ! command -v node >/dev/null 2>&1; then
  echo "  [X] Node.js is not installed."
  echo
  echo "      Ubuntu / Mint / Pop!_OS / Debian:"
  echo "        curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -"
  echo "        sudo apt install -y nodejs"
  echo "      Fedora:  sudo dnf install nodejs"
  echo "      Arch:    sudo pacman -S nodejs npm"
  echo
  echo "      Then run this script again."
  exit 1
fi
echo "  [1/4] Node.js $(node -v) found."

# A running copy keeps its files open.
pkill -x gamecut >/dev/null 2>&1 || true
echo "  [2/4] Closed any running copy of GameCut."

echo "  [3/4] Installing build tools (first run downloads ~250 MB)..."
npm install --no-audit --no-fund
# Electron 44+ fetches its own program on first use; get it now.
node node_modules/electron/install.js

echo
echo "  [4/4] Building GameCut (takes 1-3 minutes)..."
npx electron-builder --linux AppImage deb --x64

echo
echo "  =========================================="
echo "    Done. Both are in the \"dist\" folder:"
echo
echo "    Ubuntu, Mint, Pop!_OS, Debian (recommended there):"
echo "      sudo apt install ./dist/GameCut-*-amd64.deb"
echo "      then open GameCut from your app menu."
echo
echo "    Any other Linux:"
echo "      chmod +x dist/GameCut-*-x86_64.AppImage"
echo "      ./dist/GameCut-*-x86_64.AppImage"
echo "  =========================================="
