@echo off
setlocal

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required to create the Windows EXE.
  echo Install Node.js LTS, then run this file again.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo npm is required to create the Windows EXE.
  echo Install Node.js LTS, then run this file again.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo Dependency installation failed.
    pause
    exit /b 1
  )
)

echo Creating DeployerX Windows installer and portable EXE...
call npm run package:win
if errorlevel 1 (
  echo EXE creation failed.
  pause
  exit /b 1
)

echo.
echo Done. Your files are in the dist folder.
echo Use the Portable EXE to run DeployerX directly on another Windows PC.
pause
