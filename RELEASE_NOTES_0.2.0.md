## DeployerX 0.2.0

DeployerX 0.2.0 improves long-running SSH operations, server monitoring, terminal navigation, and SFTP compatibility.

### Server monitoring

- Server Monitoring now opens and owns a dedicated SSH connection instead of depending on an interactive terminal session.
- Monitoring continues when terminal tabs are disconnected or closed.
- Added SSH keepalives and automatic reconnection with bounded backoff for unstable or long-lived connections.
- Preserved routed SSH connection behavior for VPN and bastion configurations.

### Terminal and SFTP fixes

- Fixed startup-directory handling so terminals open in the requested remote path without duplicate prompts.
- Improved SFTP subsystem failure detection, including SSH channel-open failures reported by minimal server configurations.
- Kept terminal directory navigation available when SFTP is unsupported while disabling SFTP-only controls.
- Updated disconnect actions with a clearer consistent icon.

### Reliability carried forward

- Includes the packaged Firebase and Google authentication validation introduced in 0.1.9.
- Includes Uptime Monitor local-first operation, reduced database lock contention, and improved worker heartbeat reliability.

### Important notes

- The hosted Windows packages do not include the local-only DeployerX DB Access Manager companion.
- The current Windows and macOS packages are unsigned. Windows SmartScreen or macOS Gatekeeper may require manual confirmation.
- Linux packages currently target x64 systems.

Compare changes: https://github.com/me-devms/DeployerX/compare/v0.1.9...v0.2.0
