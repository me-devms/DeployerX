# Third-Party Notices

## noVNC

DeployerX includes noVNC v1.6.0 for browser-native VNC sessions.

- Project: noVNC
- Source: https://github.com/novnc/noVNC/tree/v1.6.0
- License: Mozilla Public License 2.0
- License text: `src/renderer/vendor/novnc/LICENSE.MPL-2.0`

## pako

The vendored noVNC runtime includes pako for compressed VNC encodings.

- Project: pako
- Source: https://github.com/nodeca/pako
- License: MIT License
- License text: `src/renderer/vendor/novnc/PAKO-LICENSE`

## Devicon Brand Icons

Database brand icons displayed by Backup Manager are sourced from Devicon v2.17.0.

- Project: Devicon
- Source: https://github.com/devicons/devicon/tree/v2.17.0
- License: MIT License
- License text: `third_party_licenses/MIT.txt`

The MySQL, MariaDB, PostgreSQL, Supabase, MongoDB, ClickHouse, Redis, and SQLite names and logos remain trademarks of their respective owners and are used only to identify compatible source types.

## Tabularis

DeployerX includes two distinct adaptations of Tabularis: the separately launched DeployerX DB Access Manager companion and portions of the built-in Database Manager driver host. Both adaptations are modified by the DeployerX project and remain subject to the attribution and license below.

- Project: Tabularis
- Source: https://github.com/TabularisDB/tabularis
- Release: v0.18.0
- Approved upstream base commit: `147777c59947178c54e1a9894d52f5abc9db9208`
- Copyright: 2026 Andrea Debernardi
- License: Apache License 2.0
- Packaged companion license text: `licenses/Tabularis-LICENSE.txt`

### DeployerX DB Access Manager Companion

Windows releases that include database access ship a modified and rebranded executable built from the source in `DeployerX DB Manager/`. The executable is named `deployerx-db-access-manager.exe`, is launched by DeployerX as a separate process after the user selects Access, and uses DeployerX product branding and visual design. It is not an unmodified Tabularis release and is not downloaded separately at runtime.

The companion retains Tabularis's database workspace capabilities needed by DeployerX. Connection creation, saved-connection management, standalone onboarding, upstream update services, community links, and other standalone Tabularis product surfaces are removed or disabled. DeployerX supplies an ephemeral connection handoff and does not represent the modified companion as an official Tabularis distribution.

The packaged companion directory includes this notice and the upstream Apache License 2.0 text. DeployerX's modifications are available with the rest of the open-source DeployerX repository.

Each packaged companion also includes `artifact-manifest.json`. Its `sourceRevision` identifies the exact DeployerX companion commit used for that artifact, while `modifiedFrom.commit` identifies the approved Tabularis base above. Release staging rejects companion revisions outside that approved history and rejects tracked or untracked source changes, so the manifest never substitutes the upstream base commit for the actual modified source revision.

The companion's Rust and production frontend dependency notices are generated
from `DeployerX DB Manager/src-tauri/Cargo.lock`, `DeployerX DB
Manager/package.json`, and `DeployerX DB Manager/pnpm-lock.yaml`. The generated
inventories are distributed in the packaged companion as
`licenses/dependencies/db-access-manager-rust.json` and
`licenses/dependencies/db-access-manager-frontend.json`, together with every
content-addressed license file they reference. Development-only frontend
dependencies are excluded; production workspace links, transitive packages,
and optional runtime dependencies are included.

Legal acceptance is distributed in the packaged companion as
`licenses/dependencies/db-access-manager-review.json`. The approval is bound to
the exact companion source revision, Cargo lock, pnpm lock, companion package
manifest, production workspace manifests, both inventories, this notice, the
upstream license, every referenced license file, package counts, and accepted
license-expression set. Companion preparation and validation fail when an
inventory, referenced license file, or approval is missing, changed,
incomplete, unlocked, or stale. Releases are rejected until the exact human
approval required by the dependency-license gate is present.

### Built-In Database Driver Host

Portions of the DeployerX Database Manager built-in driver host are derived from or informed by the reviewed Tabularis source. This host remains a separate DeployerX implementation behind the existing Electron renderer and design system. DeployerX keeps its own navigation, profile storage, IPC, query workspace, schema tools, result grid, notebooks, tasks, and logs.

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
