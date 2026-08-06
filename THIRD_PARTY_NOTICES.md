# Third-Party Notices

## Devicon Brand Icons

Database brand icons displayed by Backup Manager are sourced from Devicon v2.17.0.

- Project: Devicon
- Source: https://github.com/devicons/devicon/tree/v2.17.0
- License: MIT License
- License text: `third_party_licenses/MIT.txt`

The MySQL, MariaDB, PostgreSQL, Supabase, MongoDB, ClickHouse, Redis, and SQLite names and logos remain trademarks of their respective owners and are used only to identify compatible source types.

## Tabularis

Portions of the DeployerX Database Manager built-in driver host are derived from or informed by Tabularis.

- Project: Tabularis
- Source: https://github.com/TabularisDB/tabularis
- Release: v0.18.0
- Commit: `147777c59947178c54e1a9894d52f5abc9db9208`
- Copyright: 2026 Andrea Debernardi
- License: Apache License 2.0
- License text: `third_party_licenses/Apache-2.0.txt`

The derived host files have been modified for DeployerX and implement a standalone, bounded JSON-RPC process. The Database Manager navigation entry does not reproduce the Tabularis interface: it downloads the reviewed official Windows portable release from the upstream GitHub release, verifies its pinned SHA-256 digest, and launches Tabularis as a separate application. Tabularis retains its own interface, connection management, data storage, update behavior, and product identity.

The exact reviewed upstream paths and DeployerX file inventory are maintained in `native/deployerx-db-host/UPSTREAM.md`.

## Built-In JavaScript Database Fallback

The built-in fallback uses these runtime dependencies under the MIT License:

- node-postgres (`pg`): https://github.com/brianc/node-postgres
- mysql2: https://github.com/sidorares/node-mysql2
- sql.js: https://github.com/sql-js/sql.js

The fallback follows the existing Tabularis-derived built-in connection, query, and schema contract described above. It does not replace or alter the Tabularis attribution. The MIT license text is included at `third_party_licenses/MIT.txt`.

## Database Manager Rust Dependencies

When a Windows release includes the optional native database host, its packaging is gated on the exact dependency graph in `native/deployerx-db-host/Cargo.lock`. The generated 239-package SPDX and license-file inventory is distributed as `third_party_licenses/database-manager-rust.json`, and its referenced license texts are included in `third_party_licenses`.

Crates that publish recognized license files retain content-addressed copies of those files. A crate that declares only a supported SPDX expression and omits license files receives package-owned copies of the canonical MIT, Apache-2.0, or BSL-1.0 text declared by that expression; unrecognized expressions still fail inventory generation.

Legal acceptance is recorded separately in `third_party_licenses/database-manager-rust-review.json` and is bound to the SHA-256 of both the lockfile and generated inventory. That approval has not been created yet. A release that includes the optional host must reject packaging when the exact review, complete inventory, referenced license texts, or compiled sidecar is missing or stale. A fallback-only release does not ship the Rust host and instead uses the JavaScript dependencies disclosed above.

## Runtime Driver Plugins

Database plugins installed from Tabularium are separate programs downloaded by the user. Their registry origin, version, signature identity, and release hash are retained in device-local plugin state. Each plugin remains subject to the license distributed by its publisher; installation does not relicense the plugin as part of DeployerX.
