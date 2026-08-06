# DeployerX

<p align="center">
  <img src="assets/deployerx-logo.png" alt="DeployerX logo" width="112" />
</p>

<p align="center">
  A Windows desktop operations workspace for servers, deployments, uptime, backups, databases, and AI-assisted administration.
</p>

<p align="center">
  <a href="https://github.com/me-devms/DeployerX/releases"><img alt="Release" src="https://img.shields.io/github/v/release/me-devms/DeployerX?display_name=tag" /></a>
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows-0078D4" />
  <img alt="Electron" src="https://img.shields.io/badge/Electron-43-47848F" />
  <a href="https://github.com/me-devms/DeployerX/issues"><img alt="Issues" src="https://img.shields.io/github/issues/me-devms/DeployerX" /></a>
</p>

> **Release status:** DeployerX `0.1.4` is an early public release. Use test servers and test data first, verify every backup by restoring it, and review commands before running them against production systems.

## Overview

DeployerX brings day-to-day infrastructure work into one local-first desktop application. It combines server profiles, SSH and SFTP, repeatable deployment commands, Windows Remote Desktop, endpoint monitoring, backup and recovery workflows, database tooling, optional Firebase workspaces, and a local MCP endpoint for trusted AI clients.

The app is designed for developers, system administrators, agencies, and small teams that want an inspectable, self-hosted alternative to stitching together several unrelated server tools.

## What's New in 0.1.4

- New **Uptime Monitor** workspace for HTTP/API, TCP, and TLS checks, incidents, maintenance windows, shared alerts, and PDF/CSV reports.
- New **Backup Manager** for scheduled and manual file/database protection, encrypted repositories, retention, verification, and guided recovery.
- New **Database Manager handoff** that downloads, verifies, caches, and launches the reviewed Tabularis portable release on Windows x64.
- Embedded **Windows Remote Desktop** sessions alongside SSH and SFTP server tools.
- New authenticated **DeployerX MCP** server for scoped SSH command and SFTP access from compatible local AI clients.
- Shared notification routes for desktop, email, generic webhooks, Slack, and Microsoft Teams.
- Expanded dashboard, navigation, settings, workspace controls, theme support, update handling, and security boundaries.

See the full [v0.1.4 release notes](documentation/releases/v0.1.4.md).

## Modules

| Module | Purpose | Main capabilities |
| --- | --- | --- |
| **Overview** | Workspace operations summary | Server inventory, activity, health, quick actions, import/export |
| **Servers** | Connection and deployment workspace | Profiles, groups, SSH authentication, command scripts, emergency stop |
| **SSH & SFTP** | Interactive remote administration | xterm.js terminal, file browser, upload/download, rename, folders, delete |
| **Remote Desktop** | Windows server control | Embedded RDP canvas, credential prompt, full-view session |
| **Uptime Monitor** | Availability and incident operations | HTTP/API, TCP, TLS, worker scheduling, incidents, maintenance, reports |
| **Backup Manager** | Backup, retention, and recovery | Sources, jobs, repositories, recovery points, activity, policies, tests |
| **Database Manager** | Database development and administration | Verified Tabularis portable-app handoff; native DeployerX database foundations remain in development |
| **Templates** | Reusable deployment commands | Categorized templates, variables, import/export |
| **Cloud Workspaces** | Optional collaboration and sync | Firebase authentication, teams, invites, encrypted shared secrets |
| **MCP Integration** | Local AI tool access | Authenticated SSH execution and bounded SFTP operations by saved server ID |

## Server and Deployment Module

Each server profile stores a deployable target and its operational tools:

- Password or private-key SSH authentication, including key passphrases.
- Interactive terminal sessions with reconnect and disconnect controls.
- Saved commands that run in sequence with streamed output.
- Optional file upload before deployment commands run.
- Server grouping, search, import, export, and activity history.
- Emergency stop for active operations.
- Reusable templates with variables such as `{{app_path}}`, `{{branch}}`, and `{{process_name}}`.

Example deployment script:

```bash
cd /var/www/my-app
git pull origin main
npm install
pm2 restart my-app
```

DeployerX executes the commands you provide. It does not validate application-specific deployment safety, so test the sequence on a non-production target first.

## SSH, SFTP, and Remote Desktop

The project view keeps remote access tools together:

- **SSH terminal:** interactive shell powered by xterm.js and `ssh2`.
- **SFTP browser:** browse directories; upload and download files or folders; create folders; rename, open, and delete remote entries.
- **Windows Remote Desktop:** connect to supported Windows hosts inside the project view through the bundled RDP client.

The file browser uses SSH File Transfer Protocol. Plain, unencrypted FTP is intentionally not exposed.

## Uptime Monitor

The Uptime module is a workspace-level operations console with five areas: Overview, Monitors, Incidents, Reports, and Maintenance.

### Monitor Types

- HTTP/API requests with status expectations, headers, body assertions, redirects, JSONPath checks, and bounded response capture.
- TCP port availability checks.
- TLS certificate checks with hostname validation and expiry thresholds.

### Operations

- Scheduled checks with persisted due times and bounded concurrency.
- Warning, critical, failure, and recovery thresholds.
- Incident opening, acknowledgement, escalation, and resolution history.
- Maintenance windows that preserve check evidence without generating incidents.
- Desktop, email, webhook, Slack, and Microsoft Teams notification routes.
- Availability, coverage, downtime, latency percentiles, daily trends, and monitor comparisons.
- Summary, checks, incidents, and daily CSV exports plus printable PDF reports.
- Configurable worker start-at-login, concurrency, and retention settings.

Monitoring data is stored locally in a versioned SQLite control database. Sensitive request headers are stored through encrypted secret references rather than monitor records.

## Backup Manager

Backup Manager organizes protection work into Overview, Jobs, Sources, Repositories, Recovery, Activity, Policies, and Tests.

### Core Capabilities

- Manual and scheduled file backups from the local device or a host-key-pinned SSH/SFTP server.
- Encrypted, authenticated, parent-linked recovery points.
- Local-folder, SFTP, and S3-compatible repositories.
- Source include/exclude rules, snapshot browsing, version history, and guided restore conflict handling.
- Retention policies, repository pruning, capacity and health checks, repository locking, and verification.
- Recovery objectives, execution calendars, checkpoints, audit history, and shared notifications.
- Database-native logical, physical, incremental, and point-in-time workflows where the selected engine and topology explicitly support them.

### Active Core Scope

The documented core release scope covers:

- Files and directories
- MySQL and MariaDB
- PostgreSQL and constrained Supabase PostgreSQL profiles
- SQLite
- MongoDB
- Redis
- ClickHouse

Support is bounded by database versions, topology, native tools, privileges, destination type, and recovery mode. Read the [Backup Manager documentation](documentation/backup-manager/README.md) and [compatibility matrix](documentation/backup-manager/CORE_COMPATIBILITY_MATRIX.md) before relying on a database recovery workflow.

Code and research for additional engines may exist in the repository, but an engine is not part of the supported core scope unless it appears in that compatibility matrix.

## Database Manager

The top-level Database Manager action launches the pinned Tabularis `0.18.0` Windows x64 portable release. DeployerX downloads the official GitHub asset on first use, verifies its exact size and SHA-256 digest, caches the reviewed executable under the current user's app data, and starts it as a separate desktop application.

The repository also contains an in-progress native DeployerX database module with:

- Workspace-scoped connection profiles with test, connect, disconnect, and device-local resource binding.
- Built-in PostgreSQL, MySQL/MariaDB, and SQLite driver boundaries.
- Multi-tab SQL editing with Monaco, formatting, paging, cancellation, query history, and saved queries.
- Streamed full-result export with bounded page sizes.
- Schema exploration, definition inspection, ER relationships, explain plans, and capability-gated object actions.
- User, role, and privilege inspection or administration when supported by the driver.
- Notebooks, background tasks, sanitized operational logs, and durable connection evidence.
- Signed plugin catalog, integrity checks, health status, quarantine, and isolated plugin processes.
- Shared connection handoff to Backup Manager.

This native module is not the primary v0.1.4 Database Manager navigation path and is still completing packaged Windows, live-driver, tunnel, plugin, and assistive-technology acceptance. See its [progress and compatibility notes](documentation/database-manager/PROGRESS.md) before evaluating or contributing to it.

## MCP Integration

Settings > Integrations can start a local Streamable HTTP MCP server for compatible AI clients. It listens on `127.0.0.1`, requires a bearer token, and resolves credentials internally from an opaque saved server ID.

Available tools:

- `deployerx_list_servers`
- `deployerx_ssh_execute`
- `deployerx_sftp_list`
- `deployerx_sftp_read`
- `deployerx_sftp_write`
- `deployerx_sftp_mkdir`
- `deployerx_sftp_move`
- `deployerx_sftp_delete`

The desktop app must remain open while the endpoint is in use. Treat the bearer token like an SSH credential. Do not expose the local MCP port directly to the public internet.

## Local and Cloud Workspaces

DeployerX works without a hosted backend.

### Local Mode

- Projects, templates, settings, and operational data stay on the current Windows user profile.
- No Firebase account or network sync is required.
- Project, template, and account backup import/export remain available.

### Optional Firebase Mode

- Email/password authentication and optional Google sign-in.
- Cloud workspaces, team members, and invitations.
- Firestore synchronization for supported workspace data.
- A team passphrase encrypts SSH passwords, private keys, and private-key passphrases before cloud storage.

The encryption key is derived with PBKDF2 and secrets are encrypted using AES-256-GCM. Firebase does not receive plaintext SSH secrets through the DeployerX cloud save path. Keep the workspace passphrase in a separate password manager; it cannot be recovered by DeployerX.

## Requirements

### Run from Source

- Windows 10 or Windows 11
- Node.js LTS and npm
- Git
- An SSH server for remote workflows

### Feature-Specific Requirements

- Firebase project for cloud workspaces.
- Compatible database clients, server versions, and privileges for database-native backup or administration.
- Trusted SSH host keys for remote backup connections.
- Code-signing configuration for official Windows packaging.

## Install and Run

### Release Downloads

Open [GitHub Releases](https://github.com/me-devms/DeployerX/releases) and review the notes for the selected version. When installer or portable assets are attached, verify the publisher and release version before running them.

### Run from Source

```powershell
git clone https://github.com/me-devms/DeployerX.git
cd DeployerX
npm install
npm start
```

On first run, choose local mode or configure a Firebase-backed cloud workspace.

## Firebase Setup

Firebase is optional. For cloud workspaces:

1. Create a Firebase project and web app.
2. Enable Email/Password authentication; Google authentication is optional.
3. Create a Cloud Firestore database.
4. Deploy the repository's `firestore.rules`.
5. Copy `firebase.config.example.json` to `firebase.config.json` and add your project values.

Minimal configuration:

```json
{
  "apiKey": "YOUR_FIREBASE_WEB_API_KEY",
  "authDomain": "YOUR_PROJECT.firebaseapp.com",
  "projectId": "YOUR_PROJECT_ID"
}
```

`firebase.config.json` is ignored by Git. Do not commit real credentials, exported account data, or private keys.

Google desktop OAuth uses this loopback redirect by default:

```text
http://127.0.0.1:42813/oauth/google
```

## Project Layout

```text
DeployerX/
|-- assets/                         App icons and brand assets
|-- documentation/
|   |-- backup-manager/             Compatibility contracts and runbooks
|   |-- database-manager/           Architecture and progress evidence
|   `-- uptime-monitor/             Architecture and progress evidence
|-- native/deployerx-db-host/       Rust database-driver host
|-- src/
|   |-- backup-manager/             Backup engines, repositories, policy, recovery
|   |-- database-manager/           Profiles, queries, drivers, schema, plugins
|   |-- uptime-monitor/             Checks, incidents, worker, reports, storage
|   |-- renderer/                   Desktop UI and RDP client
|   |-- main.js                     Electron main process and IPC composition
|   |-- mcp-server.js               Local authenticated MCP endpoint
|   |-- preload.js                  Sandboxed renderer bridge
|   `-- rdp-session.js              Remote Desktop session boundary
|-- third_party_licenses/           Bundled dependency licenses
|-- firestore.rules                 Cloud workspace authorization rules
|-- package.json                    Runtime, scripts, and packaging configuration
`-- THIRD_PARTY_NOTICES.md          Attribution and third-party notices
```

## Development and Verification

Useful checks:

```powershell
node --check src/main.js
node --check src/preload.js
node --check src/renderer/renderer.js
node --test src/uptime-monitor/*.test.js
node --test src/database-manager/*.test.js
```

Backup Manager has engine-specific and Electron acceptance tests under `src/backup-manager`. Some tests require database services, native tools, Firebase emulators, signed Windows artifacts, or other external prerequisites; read the corresponding module documentation before running them.

Windows packaging is configured through Electron Builder and emits an NSIS installer and portable executable. Official packages require the project's signing setup and should be published with Electron Builder update metadata.

## Security

- Prefer least-privilege SSH and database accounts.
- Prefer SSH keys over passwords.
- Verify SSH host keys before remote backup operations.
- Keep Firebase configuration, workspace exports, bearer tokens, private keys, and database credentials out of Git.
- Review every deployment command and destructive database action.
- Restore backups regularly; a completed backup job alone is not recovery proof.
- Keep DeployerX and its native database tools updated.
- Report vulnerabilities privately to the maintainer before opening a public issue with exploit details.

## Contributing

1. Fork the repository.
2. Create a focused branch.
3. Add or update tests and module documentation with the implementation.
4. Run the relevant syntax and test checks.
5. Open a pull request that explains behavior, risk, compatibility, and verification evidence.

Issues and feature requests are welcome in the [GitHub issue tracker](https://github.com/me-devms/DeployerX/issues).

## Licensing and Attribution

Third-party software notices are recorded in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) with full texts under `third_party_licenses/`.

This repository does not currently contain a top-level project license. Until the maintainer adds one, source availability should not be interpreted as permission to redistribute or create derivative works. A recognized open-source license is required before the project can be formally described as open source.

## Maintainer

Created and maintained by [Manish K](https://github.com/me-devms).
