# Upstream Tracking

This headless driver host is derived from the architecture and PostgreSQL, MySQL/MariaDB, and SQLite behavior of Tabularis:

- Repository: `https://github.com/TabularisDB/tabularis`
- Release: `v0.18.0`
- Commit: `147777c59947178c54e1a9894d52f5abc9db9208`
- Reviewed paths: `src-tauri/src/drivers/postgres`, `src-tauri/src/drivers/mysql`, `src-tauri/src/drivers/sqlite`, `src-tauri/src/drivers/common`, `src-tauri/src/drivers/driver_trait.rs`, and `src-tauri/src/pool_manager.rs`
- License: Apache License 2.0
- Upstream copyright: Copyright 2026 Andrea Debernardi
- Packaged license: `../../third_party_licenses/Apache-2.0.txt`

DeployerX does not embed or launch the Tabularis Tauri application. This crate is a separate, stdin/stdout JSON-RPC host with DeployerX-specific process, security, cancellation, and response-limit behavior. Keep copied or materially adapted upstream code attributable here and in the product notices.

## Modified DeployerX File Inventory

All files below are DeployerX modifications or clean-room adaptations against the reviewed Tabularis behavior. They are not byte-for-byte upstream copies.

| DeployerX file | Reviewed upstream area | Modification boundary |
| --- | --- | --- |
| `src/main.rs` | Tauri command and driver dispatch architecture | Replaced Tauri with bounded stdin/stdout JSON-RPC, cancellation, and process isolation. |
| `src/protocol.rs` | Driver command/error contracts | Added DeployerX protocol versioning, safe errors, and response envelopes. |
| `src/drivers/mod.rs` | `driver_trait.rs` and driver models | Added renderer-independent connection, query, and schema contracts. |
| `src/drivers/common.rs` | `drivers/common` and `pool_manager.rs` | Added shared validation, limits, classification, credential access, and serialization. |
| `src/drivers/postgresql.rs` | `drivers/postgres` | Adapted connection, query paging, typed values, and schema discovery for the headless host. |
| `src/drivers/mysql.rs` | `drivers/mysql` | Adapted MySQL/MariaDB connection, query paging, typed values, and schema discovery. |
| `src/drivers/sqlite.rs` | `drivers/sqlite` | Adapted non-creating local-file access, paging, typed values, and schema discovery. |

The upstream repository did not contain a `NOTICE` file at the pinned commit. The required copyright, license, modification, source, release, and commit notices are included in `THIRD_PARTY_NOTICES.md`, this file, and the modified Rust source headers.
