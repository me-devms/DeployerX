<p align="center">
  <img src="assets/deployerx-logo.png" alt="DeployerX" width="96" />
</p>

<h1 align="center">DeployerX</h1>

<p align="center">
  <strong>Operations, deployment, and observability for the servers you control.</strong>
</p>

<p align="center">
  A local-first Windows workspace for SSH, SFTP, deployments, uptime monitoring,
  backups, and remote server administration.
</p>

<p align="center">
  <a href="https://github.com/me-devms/DeployerX/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/me-devms/DeployerX?display_name=tag&style=flat-square&color=2ecfa6" /></a>
  <a href="https://github.com/me-devms/DeployerX/releases"><img alt="Downloads" src="https://img.shields.io/github/downloads/me-devms/DeployerX/total?style=flat-square&color=4ea1ff" /></a>
  <img alt="Windows" src="https://img.shields.io/badge/Windows-10%20%7C%2011-0078D4?style=flat-square&logo=windows" />
  <img alt="Electron" src="https://img.shields.io/badge/Electron-43-47848F?style=flat-square&logo=electron" />
  <a href="https://github.com/me-devms/DeployerX/issues"><img alt="Issues" src="https://img.shields.io/github/issues/me-devms/DeployerX?style=flat-square" /></a>
</p>

<p align="center">
  <a href="https://github.com/me-devms/DeployerX/releases/latest"><strong>Download DeployerX</strong></a>
  &nbsp;&middot;&nbsp;
  <a href="https://github.com/me-devms/DeployerX/issues">Report an issue</a>
</p>

<p align="center">
  <img src="assets/screenshots/deployerx-command-center.png" alt="DeployerX Command Center showing server, uptime, backup, and fleet health" width="100%" />
</p>

<p align="center"><sub>The DeployerX Command Center with sample infrastructure data.</sub></p>

## One workspace for infrastructure work

DeployerX brings the tools used throughout a server's lifecycle into one focused desktop application. Register a host once, then connect over SSH, browse files, run repeatable commands, watch availability, and manage protection workflows without moving between unrelated tools.

| Workspace | What it gives you |
| --- | --- |
| **Command Center** | Fleet health, active SSH sessions, uptime alerts, backup status, and quick navigation |
| **Hosts** | Searchable server inventory, groups, favorites, connection details, and saved commands |
| **SSH & SFTP** | Multi-tab terminals, per-user sessions, file browsing, transfers, folders, rename, and delete |
| **Real-Time Monitor** | Live CPU, memory, disk, network, process, and service visibility |
| **Uptime** | HTTP, TCP, and TLS checks with incidents, maintenance windows, reports, and notifications |
| **Backup Manager** | Jobs, sources, repositories, recovery points, retention policies, and verification |

## Built for daily operations

- Open an SSH terminal directly from the top navigation.
- Keep simultaneous terminal sessions clearly labeled by sequence and username.
- Save deployment commands per server and stream their output as they run.
- Browse remote files over SFTP without exposing plain FTP.
- Organize Linux and Windows hosts into groups and favorites.
- Connect to compatible Windows hosts through the embedded VNC workspace.
- Track endpoint incidents and backup health from the same command center.
- Work locally without an account, or configure an optional Firebase workspace for team sync.
- Expose bounded SSH, SFTP, monitoring, and uptime tools to trusted AI clients through a loopback-only MCP endpoint.
- Choose from light and dark themes designed for long operational sessions.

## What's new in v0.2.3

- Includes the current About section and the complete Theme settings page, with scrollable settings navigation on short windows.
- Adds automatic MySQL 8.4 client-tool setup with checksum verification and a clear retry flow when database tools are missing.
- Publishes the current desktop renderer, backup UI, website source, local assets, and deployment workflow together.

Read the complete changes on the [v0.2.3 release page](https://github.com/me-devms/DeployerX/releases/tag/v0.2.3).

## What's new in v0.2.2

- Detects supported local MCP clients, including Codex, Claude Code, and OpenCode, and configures or disconnects them from Settings.
- Starts MCP automatically for connected clients, recovers encrypted credentials when the local key changes, and falls back to a nearby port when the preferred port is busy.
- Adds clearer MCP reachability, connection, and credential error states with bundled agent logos and a more responsive connection guide.
- Bundles DM Sans fonts for consistent desktop and printable Uptime report rendering.

> [!NOTE]
> The hosted Windows artifacts for v0.2.2 intentionally exclude the local-only DeployerX DB Access Manager payload.

## Download

DeployerX is distributed for 64-bit Windows and Linux, plus Intel and Apple Silicon Macs.

| Platform | Package | Download |
| --- | --- | --- |
| **Windows x64** | Setup | [DeployerX-0.2.3-Setup-x64.exe](https://github.com/me-devms/DeployerX/releases/download/v0.2.3/DeployerX-0.2.3-Setup-x64.exe) |
| **Windows x64** | Portable | [DeployerX-0.2.3-Portable-x64.exe](https://github.com/me-devms/DeployerX/releases/download/v0.2.3/DeployerX-0.2.3-Portable-x64.exe) |
| **Linux x64** | AppImage | [DeployerX-0.2.3-x86_64.AppImage](https://github.com/me-devms/DeployerX/releases/download/v0.2.3/DeployerX-0.2.3-x86_64.AppImage) |
| **Linux x64** | Debian/Ubuntu | [DeployerX-0.2.3-amd64.deb](https://github.com/me-devms/DeployerX/releases/download/v0.2.3/DeployerX-0.2.3-amd64.deb) |
| **Linux x64** | Fedora/RHEL | [DeployerX-0.2.3-x86_64.rpm](https://github.com/me-devms/DeployerX/releases/download/v0.2.3/DeployerX-0.2.3-x86_64.rpm) |
| **macOS Intel** | DMG | [DeployerX-0.2.3-x64.dmg](https://github.com/me-devms/DeployerX/releases/download/v0.2.3/DeployerX-0.2.3-x64.dmg) |
| **macOS Intel** | ZIP | [DeployerX-0.2.3-x64.zip](https://github.com/me-devms/DeployerX/releases/download/v0.2.3/DeployerX-0.2.3-x64.zip) |
| **macOS Apple Silicon** | DMG | [DeployerX-0.2.3-arm64.dmg](https://github.com/me-devms/DeployerX/releases/download/v0.2.3/DeployerX-0.2.3-arm64.dmg) |
| **macOS Apple Silicon** | ZIP | [DeployerX-0.2.3-arm64.zip](https://github.com/me-devms/DeployerX/releases/download/v0.2.3/DeployerX-0.2.3-arm64.zip) |

Windows may show a SmartScreen warning and macOS may require manual approval because the current release artifacts are unsigned. Confirm that every file came from this repository's release page before running it.

## Run from source

Requirements:

- Windows, Linux, or macOS
- Node.js LTS and npm
- Git

```powershell
git clone https://github.com/me-devms/DeployerX.git
cd DeployerX
npm install
npm start
```

Choose **Local Workspace** on first launch to use DeployerX without a hosted backend. Firebase configuration is optional and only required for cloud workspace features.

## Build release packages

Windows setup and portable executables can be built locally with `build-exe.bat`.
To build every supported package from Windows, commit and push the repository, sign in with the GitHub CLI, and run:

```powershell
build-all.bat 1.2.3
```

The command starts native GitHub-hosted builds for Windows x64, Linux x64, macOS Intel, and macOS Apple Silicon, waits for them, and downloads the packages into `dist`. Add `--release` to also create or update the matching `v1.2.3` GitHub release. The hosted Windows package excludes the local-only DB Access Manager companion; use `build-exe.bat` when that payload is required. The macOS packages are unsigned until Apple signing and notarization credentials are configured in the repository.

## Local-first by default

Server profiles, templates, settings, and operational data can remain on the current Windows user profile. DeployerX does not require a hosted service for local mode.

Optional cloud workspaces support team membership and synchronized workspace data. Sensitive SSH values are encrypted before cloud storage using a key derived from the team passphrase. Keep that passphrase in a separate password manager because DeployerX cannot recover it.

## Security model

- SSH and MCP credentials are resolved inside the desktop main process, not exposed as browser state.
- The MCP integration listens on `127.0.0.1` by default and requires bearer authentication.
- Remote backup connections support trusted SSH host-key checks.
- Cloud workspace secrets use authenticated encryption before synchronization.
- Emergency Stop provides one place to interrupt active operations.

Use least-privilege accounts, prefer SSH keys, verify host keys, review deployment commands, and test restores before relying on any backup workflow in production.

## Technology

DeployerX is built with Electron and Node.js. Its operational stack includes xterm.js, `ssh2`, SQLite, noVNC, Monaco, and provider SDKs for supported storage and workspace integrations.

```text
DeployerX/
|-- assets/                  Brand assets and product screenshots
|-- src/
|   |-- backup-manager/      Backup, retention, repository, and recovery workflows
|   |-- renderer/            Desktop interface, terminal, SFTP, and VNC views
|   |-- uptime-monitor/      Checks, incidents, workers, reports, and storage
|   |-- main.js              Electron lifecycle and IPC composition
|   |-- mcp-server.js        Authenticated local MCP endpoint
|   `-- preload.js           Sandboxed renderer bridge
|-- third_party_licenses/    Bundled dependency licenses
|-- package.json             Runtime and packaging configuration
`-- THIRD_PARTY_NOTICES.md   Third-party attribution
```

## Contributing

Focused bug reports and feature requests are welcome in [GitHub Issues](https://github.com/me-devms/DeployerX/issues). For code changes, create a branch, add relevant tests, run the focused checks for the affected module, and open a pull request describing the behavior and verification performed.

## License and attribution

Third-party software notices are recorded in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), with license texts under `third_party_licenses/`.

This repository does not currently contain a top-level project license. Source availability should not be interpreted as permission to redistribute or create derivative works until the maintainer adds one.

<p align="center">
  Created and maintained by <a href="https://everythingx.in/">EverythingX</a>.
</p>
