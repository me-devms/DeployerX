# DeployerX DB Access Manager

## Purpose

This document is the implementation plan and progress ledger for integrating a
stripped, rebranded Tabularis workspace into DeployerX. Update it whenever a
milestone changes state or an implementation decision changes.

## Approved Product Boundary

- DeployerX remains the only place where users create, edit, test, connect, and
  delete database profiles.
- After a DeployerX profile is connected, an **Access** action opens a separate
  **DeployerX DB Access Manager** window.
- The separate window uses the post-connection Tabularis database workspace,
  but does not expose Tabularis connection management or standalone product
  features.
- The separate window has DeployerX branding, iconography, colors, typography,
  spacing, controls, and theme mode. No Tabularis product branding is visible.
- Tabularis remains credited in repository and packaged third-party notices in
  accordance with Apache-2.0.
- A DeployerX release produces one installer/portable artifact containing the
  Electron application and the access-manager companion.

## Upstream Pin

- Repository: `https://github.com/TabularisDB/tabularis.git`
- Release: `v0.18.0`
- Commit: `147777c59947178c54e1a9894d52f5abc9db9208`
- License: Apache-2.0
- Local path: `DeployerX DB Manager/`
- Integration branch: `deployerx/access-only`

The upstream pin matches the Tabularis revision already documented by
DeployerX. Do not integrate from the moving upstream `main` branch without a
separate review and an update to this document.

## Runtime Architecture

1. The user connects a supported profile in DeployerX.
2. DeployerX enables the profile's Access action.
3. The Electron main process resolves the profile, local resource, credentials,
   SSL settings, access mode, and any DeployerX-owned tunnel.
4. Electron starts the packaged DeployerX DB Access Manager companion.
5. A randomized one-time Windows named pipe transfers a bounded, versioned
   connection payload. Secrets are never placed in renderer IPC, command-line
   arguments, environment variables, logs, or temporary files.
6. The companion creates an in-memory connection and opens directly into the
   database workspace.
7. Repeated Access actions focus the existing process for that profile.
8. Companion exit closes its pool, clears secrets, releases its pipe, and
   releases any tunnel owned for the handoff.

A live Node database socket cannot be transferred to the Rust/Tauri process.
The companion therefore establishes its own database connection using the same
resolved profile material.

## Kept Tabularis Surface

- PostgreSQL, MySQL/MariaDB, and SQLite built-in drivers.
- Database and schema explorer.
- SQL tabs and Monaco editor.
- Query execution and cancellation.
- Result grid, table browsing, and supported row operations.
- Result export and clipboard operations needed by the workspace.
- Visual EXPLAIN and required auxiliary inspection windows.
- Connection health needed by an open workspace.
- Backend-enforced read-only behavior supplied by DeployerX.

## Removed Tabularis Surface

- Connection creation, editing, importing, exporting, grouping, and saved
  connection lists.
- Tabularis connection persistence and credential/keychain ownership.
- MCP server and AI-provider configuration.
- Plugin marketplace, plugin installation, and driver management.
- Settings navigation not required by the workspace.
- Standalone updater, deep links, welcome, community, sponsor, social, release,
  and onboarding surfaces.
- Tabularis name, logo, product icon, URLs, and standalone application wording
  from visible UI.
- Standalone Tabularis installer generation.

## Driver Compatibility

Phase one enables Access for:

- `postgresql`
- `mysql` (including MariaDB profiles handled by the built-in driver contract)
- `sqlite`

DeployerX and Tabularis plugins are different executable contracts. Access must
be disabled with an explicit reason for every driver without a reviewed mapping.

## DeployerX Changes

- Add an Access action and its launching/active/error states to the database
  profile row.
- Add a narrow preload method for opening/focusing the access manager.
- Add main-process IPC validation and a dedicated access-manager lifecycle
  service.
- Reuse DeployerX profile, secret, local-resource, and tunnel services without
  returning secret material to the renderer.
- Resolve development and packaged companion paths safely.
- Close companion processes and owned resources during application shutdown.
- Add packaging inputs, stale-artifact validation, and license inventory gates.

## Companion Changes

- Add a `--deployerx-access --pipe <name>` launch mode.
- Validate the handoff before showing a window.
- Create only an ephemeral connection and route directly to the editor.
- Remove connection, MCP, settings, updater, deep-link, onboarding, and plugin
  routes and commands outside the approved workspace boundary.
- Rename product metadata and runtime identifiers to DeployerX DB Access
  Manager.
- Apply DeployerX design tokens before first paint.
- Enforce read-only profiles in the Rust command boundary, not only in UI.
- Remove unreachable dependencies and assets after routing is narrowed.

## Theme And Branding

- Window title: `DeployerX DB Access Manager - <profile name>`.
- Product/executable identity: DeployerX DB Access Manager.
- Use DeployerX icons and database-identification assets already approved for
  the main application.
- Pass only the active approved DeployerX theme identifier in the handoff; the
  companion maps that identifier to bundled design tokens before first paint.
- Remove Tabularis-specific social, product, update, community, and sponsor
  content.
- Keep Apache-2.0 license and attribution in packaged legal material; legal
  attribution is not product branding.

## Packaging

- Track the modified upstream repository at `DeployerX DB Manager/` as a Git
  submodule so the parent repository records an exact companion revision.
- Produce a raw Windows companion executable/resources, not a second installer.
- Include companion artifacts through Electron Builder `extraResources`.
- Keep the existing DeployerX NSIS and portable artifacts as the only delivered
  installers.
- Quote all paths containing `DeployerX DB Manager`.
- Validate the companion commit, architecture, artifacts, and license inventory
  before packaging.
- Do not run a development server or any build/package command while carrying
  out this task, per project instructions.

## Dependency License Release Gate

The companion has separate generated inventories for the complete Cargo lock
and the production pnpm closure:

- `third_party_licenses/db-access-manager-rust.json`
- `third_party_licenses/db-access-manager-rust/`
- `third_party_licenses/db-access-manager-frontend.json`
- `third_party_licenses/db-access-manager-frontend/`
- `third_party_licenses/db-access-manager-review.json`

The frontend graph begins with `package.json` `dependencies` and
`optionalDependencies`, follows transitive optional runtime dependencies, and
resolves production workspace links through the matching pnpm importer.
`devDependencies` are not inventoried
unless the same locked package is independently reachable from the production
graph. The Cargo inventory must cover every locked package except the companion
root package.

Inventory generation requires the exact frozen frontend dependencies and Cargo
registry sources to be locally available. Run these commands from the DeployerX
root only when preparing the legal review; they are not part of normal app
startup:

```powershell
pnpm --dir "DeployerX DB Manager" install --frozen-lockfile
npm run database-access:licenses
npm run database-access:license-review-request
```

The last command writes
`documentation/database-manager/DB-ACCESS-MANAGER-LICENSE-REVIEW-REQUEST.json`.
A human reviewer must inspect every package, expression, and copied license or
notice file, then create `third_party_licenses/db-access-manager-review.json`
with `decision` set to `approved`, reviewer identity and review time, and the
exact binding fields from the request. The request itself is not an approval,
and tooling must never create or infer an approval automatically.

After approval, verify the gate without building or packaging:

```powershell
npm run database-access:license-check
npm run database-access:test
```

`--build` and `--validate-only` preparation both run this gate. Unverified
`--stage-only` preparation is rejected; staging requires the executable hash
returned by the successful companion build for the exact current revision.
They reject missing or stale inventories, packages absent from or added beyond
the locked graphs, altered evidence, stale hashes, and missing or unapproved
review data. Staging copies both inventories, the approval, and every referenced
license text; validation compares their hashes with the current approved source
files.

## Security Invariants

- No credential or connection string is exposed to the renderer.
- No credential is present in process arguments, environment variables, disk
  handoff files, logs, diagnostics, or error messages.
- Named-pipe payloads are single-use, size bounded, schema validated, and
  timeout bounded.
- The companion never persists a DeployerX-owned profile or credential.
- Read-only mode is enforced at the backend boundary.
- Tunnel lifetime is tied to companion lifetime.
- Unsupported drivers fail before process launch.

## Verification Scope

- IPC/preload allowlist and response-contract tests.
- Access availability tests for connection state and driver compatibility.
- Lifecycle tests for launch, focus, crash, timeout, and shutdown.
- Named-pipe protocol validation and secret non-disclosure tests.
- Connection mapping tests for PostgreSQL, MySQL/MariaDB, and SQLite.
- Backend read-only rejection tests.
- Theme/branding tests proving removed Tabularis UI is unreachable and no
  visible Tabularis product strings remain.
- Packaged-path and artifact-input tests.
- Third-party notice and license-inventory tests.
- Only permitted targeted tests and static checks will be executed; no dev,
  build, or package command will be run.

## Milestone Status

| ID | Milestone | Status | Evidence / next action |
| --- | --- | --- | --- |
| M0 | Record approved plan and progress ledger | Complete | This document created 2026-08-07. |
| M1 | Add pinned Tabularis repository under `DeployerX DB Manager/` | Complete | Submodule pinned to `v0.18.0` commit `147777c59947178c54e1a9894d52f5abc9db9208`; local branch `deployerx/access-only`. |
| M2 | Inventory exact post-connection dependency boundary | Complete | The access compiler graph contains 199 source files, exactly 37 frontend invokes matching exactly 37 Rust handlers, and only the clipboard, dialog, and filesystem Tauri plugins. |
| M3 | Implement secure DeployerX handoff/lifecycle service | In progress | The bounded pipe-only v1 handoff, actor/workspace/profile session isolation, focus control, transition cleanup, ephemeral secret mapping, read-only enforcement, and regression tests are implemented. Rust compile/test verification is blocked until a Rust toolchain is available. |
| M4 | Add DeployerX Access UI and IPC bridge | Complete | The Access action, lifecycle states, narrow preload API, validated main-process IPC, and separate-window launch/focus behavior are wired and covered by focused tests. |
| M5 | Strip companion to access-only workspace | Complete | The runtime boots only the dedicated access entrypoint. Connection CRUD, settings persistence, AI, MCP, plugins, updater, onboarding, notebooks, history, import/dump, user management, and DDL UI are absent from the reachable access graph. |
| M6 | Apply DeployerX branding and theme | Complete | Product metadata, window titles, startup/failure UI, icons, and the six approved theme mappings use DeployerX identity. Tabularis remains only as source/package attribution or internal upstream identifiers, not visible product branding. |
| M7 | Integrate single-installer packaging inputs | Complete | Build workflow stages a validated raw companion, Electron Builder installs it under `resources/db-access-manager`, and release gates verify PE identity, hashes, upstream ancestry, clean source, exact revision, and runtime path alignment. |
| M8 | Update attribution and dependency notices | In progress | Apache-2.0 attribution and fail-closed Cargo/pnpm inventory, evidence, approval-binding, and staging gates are implemented and fixture-tested. Real inventories and schema-v2 human approval still need to be generated and committed. |
| M9 | Complete targeted verification and acceptance audit | In progress | Electron/release tests, focused frontend tests, access typecheck, lint, invoke parity, capability/CSP checks, dependency-lock checks, and independent source review pass. Rust tests, live companion execution, and installer acceptance remain blocked or prohibited in this workspace session. |

## Progress Log

### 2026-08-07

- Plan approved by the user.
- Confirmed the project root has no `AI.md` file.
- Confirmed DeployerX is Electron-based and Tabularis v0.18.0 is React/Tauri.
- Confirmed Apache-2.0 permits modification and redistribution while requiring
  preservation of applicable license and attribution material.
- Confirmed the separate companion-window architecture and removal of visible
  Tabularis branding.
- Created this implementation ledger before repository or source changes.
- Added `DeployerX DB Manager/` as a tracked Git submodule from the approved
  upstream repository.
- Checked out the approved `v0.18.0` commit and created local branch
  `deployerx/access-only`; no commit or push was made.
- Added the Windows-only `DatabaseAccessCompanionService` with a randomized
  256-bit named pipe, bounded/versioned JSON handoff, launch and handshake
  timeouts, one child per profile, and deterministic cleanup.
- Kept the accepted pipe as a credential-free control channel. Repeated Access
  requests send `deployerx.db-access.focus`; closed or failed control channels
  return an actionable error instead of claiming the window was focused.
- Added `profileName`, backend `readOnly`, and the six approved DeployerX theme
  IDs to the v1 handoff. Arbitrary theme/token payloads are not accepted.
- Scrubbed the serialized handoff buffer and resolved credential fields as soon
  as the companion acknowledges acceptance while retaining only the resource
  ownership needed to close a linked-server tunnel on process exit.
- Wired `database-manager:access:open` in Electron main behind supported-driver
  and connected/ready profile checks. Connection material is resolved only in
  the main process through the existing secret, local-resource, and tunnel
  services.
- Added the exact development staged path and packaged resources path contract,
  shutdown disposal, and stale companion cleanup on profile edits/deletion and
  database reconnect/disconnect.
- Verified the focused companion service, Electron main integration, and IPC
  contract suites: 18 tests passed. `node --check` also passed for `main.js`
  and the companion service; no development server, build, or package command
  was run.
- Added a deterministic companion staging workflow and artifact manifest. The
  build batch routes through preparation and validation before Electron Builder
  creates the existing NSIS and portable outputs.
- Confirmed path alignment from
  `native/dist/deployerx-db-access-manager/win32-x64` to packaged
  `resources/db-access-manager` and the Electron runtime resolver.
- Hardened staging and validation so companion `HEAD` must descend from the
  approved Tabularis base, the companion tree must contain no tracked or
  untracked changes, and staged `sourceRevision` must equal the current clean
  companion commit.
- Constrained staging overrides to a non-root child beneath DeployerX
  `native/dist` before any recursive cleanup; arbitrary external paths and the
  project/staging roots are rejected.
- Updated the Tabularis notice to distinguish the approved upstream base from
  the exact modified source revision recorded in each artifact manifest. The
  complete companion dependency-license inventory remains an M8 requirement.
- Verified the focused packaging/provenance/legal suite: 11 tests passed, with
  script syntax checks also passing. No development server, build, or package
  command was run.
- Added deterministic companion dependency inventory tooling. Cargo coverage is
  checked against every locked non-root package; pnpm coverage starts from root
  production dependencies and follows transitive, optional-runtime, and
  workspace-linked production dependencies while excluding dev-only packages.
- Added content-addressed, package-owned license evidence with bounded file and
  total sizes. Inventory generation fails clearly when Cargo registry sources,
  installed frontend packages, or required license texts are unavailable.
- Added a separate human approval contract bound to the exact companion
  revision; SHA-256 hashes of Cargo.lock, pnpm-lock.yaml, the companion package
  manifest, both inventories, the DeployerX notice, the upstream license,
  production workspace manifests, and every license-evidence file; plus the
  exact package counts and accepted license expressions. No approval was
  generated automatically.
- Wired the dependency-license gate before every companion preparation mode and
  required all approved inventories, review data, and referenced evidence in
  the staged artifact manifest. Validation rejects stale staged legal files.
- Verified 41 focused dependency-compliance and preparation tests, including
  exact graph coverage, root/workspace optional dependencies, dev-only
  exclusion, missing and unlocked packages, missing or tampered evidence,
  revision/legal-input binding, junction rejection, build provenance, and
  required legal-file staging. The real-tree audit currently
  fails closed only because the two inventories and human approval have not yet
  been produced. No development server, build, or package command was run.
- Added strict companion startup for exactly
  `--deployerx-access --pipe <randomized-name>` before any standalone CLI,
  debug, MCP, askpass, plugin, or persistence initialization. Missing, extra,
  reordered, malformed, and non-Windows-pipe arguments fail closed.
- Added companion-side protocol v1 handling with 256 KiB handoff and 8 KiB
  control-frame limits, five-second pipe/connect timeouts, exact profile/driver
  identity checks, approved theme IDs, ready/accepted frames, and a retained
  focus channel. EOF or an invalid control frame now exits the companion.
- Mapped the secret-bearing handoff only into the in-memory connection cache.
  Renderer-visible bootstrap and connection commands return a separate
  sanitized profile without host, port, username, password, URI, SSL paths, or
  other credential material; consumed secret buffers are overwritten.
- Aligned SSL mapping with the DeployerX payload: CA verification uses the
  selected driver mode and system trust because certificate paths are not
  handed off. Client-certificate-required profiles fail explicitly as not yet
  supported.
- Added per-connection read-only initialization for PostgreSQL
  (`SET default_transaction_read_only = on`), MySQL
  (`SET SESSION TRANSACTION READ ONLY`), and SQLite
  (`PRAGMA query_only = ON`). Row mutations and arbitrary query/batch commands
  also fail closed through the existing SQL classifier, with explicit guards
  for SQLite `PRAGMA query_only=OFF`, PostgreSQL `set_config`, and MySQL
  transaction-mode variants.
- Kept database and schema selection state in memory for the handed-off
  profile, resolved connection tests from the secret in-memory cache, and
  prevented the companion from writing the DeployerX profile to
  `connections.json` or the OS keychain.
- Replaced the full upstream invoke surface with an explicit allowlist for the
  retained workspace and Visual Explain, schema diagram, JSON, results, and
  task-manager windows. AI, MCP, updater, deep link, plugin marketplace,
  connection CRUD/import/export, SSH/Kubernetes, backup, dump/import, custom
  theme, settings-write, and community commands are not exposed.
- Rebranded the main and retained native auxiliary window titles to
  DeployerX DB Access Manager, including a backend title guard that replaces a
  stale Tabularis prefix from retained frontend code.
- GitNexus upstream impact analysis was LOW for every edited indexed symbol:
  `run`, `get_connections`, `get_connection_by_id`, `test_connection`,
  `set_selected_databases`, all three row mutations, query and batch execution,
  four session-only schema preference functions, the MySQL startup preflight,
  and all retained native window builders/title setters. No HIGH or CRITICAL
  result occurred.
- Added focused Rust tests for strict launch parsing, bounded frames, profile
  identity, secret non-disclosure, all three read-only mappings and bypasses,
  SSL policy, and focus-frame validation. They have not run because `cargo`,
  `rustc`, `rustfmt`, and `rust-analyzer` are unavailable on this machine; no
  development server or build command was run.
- Completed the access-only frontend entrypoint and providers. The retained UI
  exposes schema exploration, SQL editing/execution, results, export, JSON
  viewing, ER diagrams, and non-AI Visual Explain without connection CRUD,
  standalone settings, AI, MCP, plugins, updater, onboarding, notebooks,
  history persistence, import/dump, user management, or DDL controls.
- Applied the six approved DeployerX themes and DeployerX-only visible product
  metadata, titles, icons, startup state, and failure state. Tabularis remains
  credited in repository and packaged legal material as required by
  Apache-2.0.
- Reduced the native surface to exactly 37 commands and four narrow window
  capabilities. The frontend invoke set and Rust handler set match exactly;
  CSP is self-only with Tauri IPC and bundled Monaco workers.
- Resolved the final pnpm workspace policy issue by removing an invalid
  placeholder `allowBuilds` block without approving dependency install scripts.
  The workspace now contains only `packages/explain`, and lock importers match
  the root plus that production workspace.
- Independent review found a SQLite read-only bypass through
  `PRAGMA query_only=0x0`, connection details in pool logs, and raw driver
  errors crossing the access command boundary. Read-only access now rejects
  every user-issued SQLite `PRAGMA`; pool logs contain no username, host,
  database path, key, password length, or raw driver failure; retained
  metadata, query, batch, row-write, and export commands return fixed safe
  errors instead of driver text.
- Added Rust regression cases for hexadecimal `query_only`, mutating
  `user_version`, other SQLite PRAGMAs, and sentinel driver-error disclosure.
  Added executable source-boundary tests for the same invariants because the
  Rust toolchain is unavailable.
- Final permitted verification passed: 60 Electron lifecycle/IPC/release/legal
  tests, 120 focused companion frontend/native-boundary tests, access
  TypeScript checking, targeted frontend ESLint, JavaScript syntax checks,
  exact 37-command invoke parity, capability/CSP checks, and package/workspace/
  lock validation. No development server, build, package, installer, dependency
  installation, or Rust command was run.
- Release remains blocked until Rust compiles/tests run, real Cargo and pnpm
  license inventories exist, schema-v2 human legal approval exists, the
  modified companion is committed and pushed to a reachable fork, the parent
  submodule URL/pin records that revision, and the actual combined artifact is
  built and accepted outside this restricted task.
