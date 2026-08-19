# DeployerX 0.2.3

## Correct current release contents

- Rebuilt all Windows, Linux, Intel macOS, and Apple Silicon macOS packages from the current source tree.
- Includes the current desktop renderer and backup-manager changes that were missing from the previous upload.

## Settings and themes

- Restores the complete Theme settings page and keeps Theme and About reachable on short windows.
- Restores the About section with product information, version metadata, update controls, and company links.
- Keeps all supported themes and themed form controls available across the desktop UI.

## Database tooling

- Adds guided MySQL 8.4 client-tool setup when the native tools are missing.
- Downloads only the pinned official archive, verifies its SHA-256 checksum, installs it privately, and retries the connection.

## Website

- Publishes the current website source, local assets, contributor portraits, technology logos, and cache-busted release links.
- Updates website release fallbacks and download links to v0.2.3 so the hosted site no longer serves the old v0.2.2 copy.
