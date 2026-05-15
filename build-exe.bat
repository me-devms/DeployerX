@echo off
setlocal

cd /d "%~dp0"

if /i "%~1"=="/?" (
  echo Usage: build-exe.bat [version]
  echo Example: build-exe.bat 1.2.3
  pause
  exit /b 0
)

set "VERSION_ARG=%~1"
set "PACKAGE_BACKUP="

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

if defined VERSION_ARG (
  set "PACKAGE_BACKUP=%TEMP%\deployerx-package.%RANDOM%%RANDOM%.json.bak"
  copy /y "package.json" "%PACKAGE_BACKUP%" >nul
  if errorlevel 1 (
    echo Failed to create a package.json backup.
    pause
    exit /b 1
  )

  echo Using build version %VERSION_ARG%...
  node -e "const fs=require('fs');const path='package.json';const pkg=JSON.parse(fs.readFileSync(path,'utf8'));pkg.version=process.argv[1];fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');" "%VERSION_ARG%"
  if errorlevel 1 (
    echo Failed to update package.json version.
    copy /y "%PACKAGE_BACKUP%" "package.json" >nul
    del /q "%PACKAGE_BACKUP%" >nul 2>nul
    pause
    exit /b 1
  )
)

if defined VERSION_ARG (
  echo Creating DeployerX Windows installer and portable EXE for version %VERSION_ARG%...
) else (
  echo Creating DeployerX Windows installer and portable EXE...
)

call npm run package:win
set "BUILD_EXIT=%ERRORLEVEL%"

if defined PACKAGE_BACKUP (
  copy /y "%PACKAGE_BACKUP%" "package.json" >nul
  if errorlevel 1 (
    echo Warning: failed to restore the original package.json from backup.
    pause
    exit /b 1
  )
  del /q "%PACKAGE_BACKUP%" >nul 2>nul
)

if not "%BUILD_EXIT%"=="0" (
  echo EXE creation failed.
  pause
  exit /b %BUILD_EXIT%
)

echo.
echo Done. Your files are in the dist folder.
echo Use the Portable EXE to run DeployerX directly on another Windows PC.
if defined VERSION_ARG echo Built version %VERSION_ARG%.
pause
