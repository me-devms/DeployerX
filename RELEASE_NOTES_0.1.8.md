## DeployerX 0.1.8

DeployerX 0.1.8 adds application update delivery, shared workspace synchronization for operational configuration, and a redesigned multi-server monitoring experience.

### Application updates

- Added automatic GitHub release checks through Electron Updater.
- Added update availability, download progress, completion, and error states to Settings.
- Added a compact topbar update action and notification entry.
- Added restart-to-install handling after an update is downloaded.
- Published Windows updater metadata and blockmaps with the release artifacts.

### Shared workspaces

- Added Firestore synchronization for uptime monitors, check windows, incidents, and maintenance windows.
- Added synchronization for shared backup connections, sources, repositories, notification routes, policies, and jobs.
- Preserved device-local credentials, filesystem paths, worker bindings, and runtime state during synchronization.
- Added deterministic conflict resolution and snapshot imports without creating synchronization loops.
- Expanded Firestore team-member rules for the new shared workspace collections.

### Real-Time Monitor

- Replaced the single-server monitoring surface with a responsive fleet card board.
- Added All Servers and By Group views, drag ordering, responsive column layouts, and fullscreen group rotation.
- Added per-card SSH connection controls and Connect All using each server's default SSH user.
- Reused established terminal SSH connections without taking ownership of or closing them.
- Kept transient sampling failures from incorrectly disconnecting otherwise healthy sessions.
- Added compact CPU, memory, storage, and uptime rows for every monitored server.

### Reliability and interface fixes

- Kept the Electron main entry valid CommonJS during uptime synchronization changes.
- Added exact snapshot import support to backup and uptime control databases.
- Improved Backup Manager settings layout and responsive update controls.
- Kept monitoring sidebar behavior under user control.

### Important notes

- The hosted Windows packages do not include the local-only DeployerX DB Access Manager companion.
- The current Windows and macOS packages are unsigned. Windows SmartScreen or macOS Gatekeeper may require manual confirmation.
- Linux packages currently target x64 systems.

Compare changes: https://github.com/me-devms/DeployerX/compare/v0.1.7...v0.1.8
