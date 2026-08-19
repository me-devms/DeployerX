# DeployerX 0.2.2

## MCP client connections

- Detect installed Codex, Claude Code, and OpenCode clients from their local configuration and installation paths.
- Connect or disconnect a client from Settings with one click while preserving each client's existing configuration.
- Show bundled agent logos, connection state, and actionable MCP errors in the desktop UI.

## MCP reliability

- Start MCP automatically when a connected client is detected at sign-in.
- Recover by generating and persisting a fresh encrypted MCP token when the previous device key is unavailable.
- Retry nearby local ports when the preferred port is already in use and refresh connected client configurations after handoff.
- Keep external MCP listener reachability separate from local process state for more accurate status reporting.

## UI and reporting

- Added responsive MCP connection documentation and security guidance.
- Bundled DM Sans font assets for consistent login, application, and printable Uptime report rendering.
- Preserved the existing Uptime metrics, filters, CSV output, and coverage calculations while improving report typography.

The hosted release includes Windows x64 setup and portable packages, Linux x64 AppImage/deb/rpm packages, and Intel plus Apple Silicon macOS dmg/zip packages. Hosted Windows artifacts intentionally exclude the local-only DeployerX DB Access Manager payload.
