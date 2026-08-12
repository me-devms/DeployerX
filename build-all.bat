@echo off
setlocal EnableExtensions EnableDelayedExpansion

cd /d "%~dp0"

if /i "%~1"=="/?" goto :usage
if /i "%~1"=="--help" goto :usage

set "BUILD_VERSION="
set "PUBLISH_RELEASE=false"

:parse_arguments
if "%~1"=="" goto :arguments_done
if /i "%~1"=="--release" (
  set "PUBLISH_RELEASE=true"
) else if not defined BUILD_VERSION (
  set "BUILD_VERSION=%~1"
) else (
  echo Unknown argument: %~1
  goto :usage_error
)
shift
goto :parse_arguments

:arguments_done
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required to read the project version.
  exit /b 1
)

if not defined BUILD_VERSION (
  for /f "usebackq delims=" %%V in (`node -p "require('./package.json').version"`) do set "BUILD_VERSION=%%V"
)

where git >nul 2>nul
if errorlevel 1 (
  echo Git is required to select the branch to build.
  exit /b 1
)

where gh >nul 2>nul
if errorlevel 1 (
  echo GitHub CLI is required. Install it with: winget install GitHub.cli
  exit /b 1
)

gh auth status >nul 2>nul
if errorlevel 1 (
  echo Sign in to GitHub first with: gh auth login
  exit /b 1
)

for /f "usebackq delims=" %%B in (`git branch --show-current`) do set "BUILD_BRANCH=%%B"
if not defined BUILD_BRANCH (
  echo The project must be on a named Git branch before starting the build.
  exit /b 1
)

set "PREVIOUS_RUN="
for /f "usebackq delims=" %%R in (`gh run list --workflow build-all.yml --branch "!BUILD_BRANCH!" --event workflow_dispatch --limit 1 --json databaseId --jq ".[0].databaseId" 2^>nul`) do set "PREVIOUS_RUN=%%R"

echo Starting all-platform build %BUILD_VERSION% from branch %BUILD_BRANCH%...
gh workflow run build-all.yml --ref "%BUILD_BRANCH%" -f version="%BUILD_VERSION%" -f publish_release="%PUBLISH_RELEASE%"
if errorlevel 1 (
  echo The workflow could not be started. Commit and push .github/workflows/build-all.yml to this branch, then try again.
  exit /b 1
)

set "RUN_ID="
for /l %%A in (1,1,30) do (
  set "CURRENT_RUN="
  for /f "usebackq delims=" %%R in (`gh run list --workflow build-all.yml --branch "!BUILD_BRANCH!" --event workflow_dispatch --limit 1 --json databaseId --jq ".[0].databaseId" 2^>nul`) do set "CURRENT_RUN=%%R"
  if defined CURRENT_RUN if not "!CURRENT_RUN!"=="!PREVIOUS_RUN!" (
    set "RUN_ID=!CURRENT_RUN!"
    goto :run_found
  )
  timeout /t 2 /nobreak >nul
)

echo GitHub accepted the workflow, but its run ID was not found. Check: gh run list --workflow build-all.yml
exit /b 1

:run_found
echo Watching GitHub Actions run %RUN_ID%...
gh run watch "%RUN_ID%" --exit-status
if errorlevel 1 (
  echo One or more platform builds failed. Inspect them with: gh run view %RUN_ID% --log-failed
  exit /b 1
)

set "DOWNLOAD_DIR=dist\all-platforms-%RUN_ID%"
gh run download "%RUN_ID%" --dir "%DOWNLOAD_DIR%"
if errorlevel 1 (
  echo The build passed, but its artifacts could not be downloaded.
  exit /b 1
)

echo.
echo All packages are available in %DOWNLOAD_DIR%.
if /i "%PUBLISH_RELEASE%"=="true" echo Release v%BUILD_VERSION% was published to GitHub.
exit /b 0

:usage_error
echo.
:usage
echo Usage: build-all.bat [version] [--release]
echo Example: build-all.bat 1.2.3
echo Example: build-all.bat 1.2.3 --release
echo.
echo Without a version, package.json version is used. --release also publishes the packages.
exit /b 0
