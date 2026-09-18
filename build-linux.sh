#!/bin/bash
cd "$(dirname "$0")" || exit 1
echo "Building the Zarc installer. Leave this window open."
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install it from your package manager or https://nodejs.org, then run this again."
  read -r -p "Press enter to close."
  exit 1
fi
npm install && npx electron-builder --linux --publish never
echo "Done — the AppImage and .deb are in ./dist"
read -r -p "Press enter to close."
