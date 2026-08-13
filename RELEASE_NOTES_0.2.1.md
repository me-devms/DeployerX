## DeployerX 0.2.1

DeployerX 0.2.1 improves MCP restart reliability, managed SSH execution, live command visibility, and terminal interaction.

### MCP reliability

- Persisted the encrypted MCP access token in a dedicated user-data file so application updates and restart handoffs keep the same client authorization.
- Migrated existing encrypted settings tokens into the durable token file without exposing plaintext credentials.
- Kept durable token data intact when operating-system secure storage is temporarily unavailable.
- Extended listener handoff retries while the previous application process releases the loopback MCP port.

### Managed SSH execution

- Routed MCP SSH commands through DeployerX-managed connections, including configured VPN and bastion routes.
- Reused active terminal or managed SSH connections where available and closed managed connections during application shutdown.
- Added Streamable HTTP event notifications for live stdout and stderr while preserving the final structured command result.
- Mirrored MCP command activity into a read-only DeployerX terminal tab.
- Expanded error redaction to cover stored passwords, private keys, passphrases, proxy credentials, and multi-user SSH credentials.

### Terminal fixes

- Restored terminal sizing, repainting, and keyboard focus after switching views or reconnecting.
- Kept typed shell input visible by preserving PTY echo behavior.
- Adjusted confirmation-dialog footer spacing for clearer action separation.

### Important notes

- The hosted Windows packages do not include the local-only DeployerX DB Access Manager companion.
- The current Windows and macOS packages are unsigned. Windows SmartScreen or macOS Gatekeeper may require manual confirmation.
- Linux packages currently target x64 systems.

Compare changes: https://github.com/me-devms/DeployerX/compare/v0.2.0...v0.2.1
