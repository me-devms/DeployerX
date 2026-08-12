## DeployerX 0.1.7

DeployerX 0.1.7 expands the project from Windows-only distribution to native packages for Windows, Linux, Intel Mac, and Apple Silicon Mac. It also includes focused Remote Desktop and case-preservation fixes.

### Highlights

- Added Windows x64 Setup and Portable packages.
- Added Linux x64 AppImage, DEB, and RPM packages.
- Added macOS DMG and ZIP packages for Intel and Apple Silicon.
- Added a GitHub Actions release matrix so every package is built on its native operating system.
- Added `build-all.bat` for starting, monitoring, downloading, and optionally publishing all platform packages from Windows.

### Fixes

- Allowed the Remote Desktop WebAssembly runtime under the renderer Content Security Policy without enabling general JavaScript evaluation.
- Reworked Remote Desktop status handling so detailed errors remain useful while compact headers stay bounded.
- Preserved original casing for SSH usernames, SFTP files and directories, project labels, database labels, and other dynamic UI values.

### Project updates

- Refreshed the README and release download table for all supported platforms.
- Updated project attribution and repository documentation.
- Moved the Windows-only DB Access Manager resource into Windows-specific packaging configuration.

### Important notes

- The hosted Windows packages do not include the local-only DeployerX DB Access Manager companion.
- The current Windows and macOS packages are unsigned. Windows SmartScreen or macOS Gatekeeper may require manual confirmation.
- Linux packages currently target x64 systems.

Compare changes: https://github.com/me-devms/DeployerX/compare/v0.1.6...v0.1.7
