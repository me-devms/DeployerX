## DeployerX 0.1.9

DeployerX 0.1.9 is an authentication and Uptime Monitor reliability update for packaged desktop releases.

### Uptime Monitor fixes

- Fixed monitor lists, changes, checks, incidents, maintenance, and reports failing when workspace cloud synchronization is temporarily unavailable.
- Kept local monitoring operational while cloud synchronization is pending, with automatic best-effort reconciliation.
- Reduced SQL.js database reloads and lock contention that could incorrectly report the background worker as offline.
- Increased worker heartbeat tolerance and throttled cloud reconciliation retries during dashboard refreshes.

### Authentication fixes

- Fixed Google sign-in failing with `Error 401: invalid_client` in installed builds.
- Fixed Firebase email/password account access in packages that had been built with public placeholder values.
- Packaged the validated production Firebase and Google OAuth configuration across Windows, Linux, Intel macOS, and Apple Silicon macOS.
- Added strict runtime handling so placeholder or malformed OAuth values are treated as unconfigured instead of being sent to Google.

### Release safeguards

- Added build-time checks for required Firebase and Google OAuth values.
- Added a live preflight against Firebase Authentication and Google's OAuth authorization endpoint before platform builds can start.
- Prevented release publishing when the configured OAuth client is missing or explicitly rejected as `invalid_client`.

### Important notes

- The hosted Windows packages do not include the local-only DeployerX DB Access Manager companion.
- The current Windows and macOS packages are unsigned. Windows SmartScreen or macOS Gatekeeper may require manual confirmation.
- Linux packages currently target x64 systems.

Compare changes: https://github.com/me-devms/DeployerX/compare/v0.1.8...v0.1.9
