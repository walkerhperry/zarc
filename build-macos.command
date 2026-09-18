#!/bin/bash
cd "$(dirname "$0")" || exit 1
echo "Building the Zarc installer. Leave this window open."
echo
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed."
  echo "Install it from https://nodejs.org (the LTS button), then double-click this file again."
  read -r -p "Press return to close."
  exit 1
fi
npm install && npx electron-builder --mac --publish never || {
  echo
  echo "The build stopped early. The messages above say why."
  read -r -p "Press return to close."
  exit 1
}
echo
echo "Done. Opening the dist folder — the .dmg is inside."
open dist
read -r -p "Press return to close."
