@echo off
title Building Zarc
echo Building the Zarc installer. Leave this window open.
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed.
  echo Install it from https://nodejs.org (the LTS button), then run this file again.
  pause
  exit /b 1
)
call npm install || goto :failed
call npx electron-builder --win --publish never || goto :failed
echo.
echo Done. Your installer is in the "dist" folder next to this file.
start "" "%~dp0dist"
pause
exit /b 0
:failed
echo.
echo The build stopped early. The messages above say why.
pause
exit /b 1
