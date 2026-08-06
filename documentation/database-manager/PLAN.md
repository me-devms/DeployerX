# Database Manager Implementation Plan

## Objective

Deliver a first-class Database Manager inside DeployerX that lets a workspace add, organize, open, inspect, query, edit, import, export, and protect databases without leaving the application.

The implementation selectively adopts Apache-2.0 code and contracts from Tabularis v0.18.0 at commit `147777c59947178c54e1a9894d52f5abc9db9208`. Tabularis is a Tauri application rather than an embeddable library, so DeployerX will reuse its database concepts, JSON-RPC protocol, headless Rust driver logic, and compatible standalone logic behind Electron-specific interfaces instead of launching a second desktop application.

## Upstream Review Conclusions

- Tabularis cannot be inherited as a normal application library. Its built-in drivers are Rust modules inside a Tauri application, and its primary UI is React 19/TypeScript while DeployerX is an Electron application with a vanilla HTML/CSS/JavaScript renderer.
- The practical reuse boundary is one `DatabaseDriverRuntime` contract with two built-in implementations. DeployerX prefers the pinned Tabularis-derived native host when its executable is present and valid; otherwise it falls back in-process to `pg` for PostgreSQL, `mysql2` for MySQL/MariaDB, and the existing `sql.js` runtime for SQLite in development and packaged operation. Electron owns runtime selection and exposes a narrow versioned preload API.
- Tabularis driver plugins are independently executable and use newline-delimited JSON-RPC 2.0 over stdin/stdout. That protocol is suitable for direct compatibility after host-level contract and security testing.
- `@tabularis/explain` contains reusable Apache-2.0 parsing and analysis logic. Its React renderer cannot be mounted directly without adding React to DeployerX, so DeployerX will reuse or port the headless parser and render the result in its own UI.
- `@tabularis/plugin-api` is specifically a React host API for plugin UI extensions. It is not a drop-in fit for DeployerX and plugin-provided UI bundles will not execute in the main renderer in the initial release.
- The Tabularium API is rooted at `https://registry.tabularis.dev/api/plugins`; the site root is HTML. Signed releases expose Ed25519 JWS integrity data and the public key at `/.well-known/registry-key.json`.
- The Tabularium catalog is dynamic. At this review snapshot, eight entries are approved, but only CSV Folder, Elasticsearch, and IBM Db2 expose currently resolvable compatible signed assets. A release is installable only while it remains approved, signature-valid, host-compatible, platform-compatible, and resolvable.

## Product Decisions

- Database Manager is a primary top-bar module after Backup Manager.
- Database profiles belong to a DeployerX workspace and may optionally link to an existing server profile for SSH tunneling.
- Database Manager and Backup Manager share connection identities and encrypted secret references.
- PostgreSQL, MySQL/MariaDB, and SQLite are built-in drivers through the preferred native host or the in-process fallback.
- Other databases use the Tabularis JSON-RPC driver protocol and the Tabularium API. Only approved, compatible signed releases with a currently resolvable Windows x64 or universal asset are installable; unsigned releases remain non-runnable.
- Compatible signed plugins are resolved dynamically and installed on demand per device rather than bundled into the DeployerX installer.
- Cloud workspaces synchronize non-secret connection metadata only. Credentials, tokens, connection URIs, certificates, keys, local database paths, and plugin binaries remain device-bound.
- Read-only profiles reject mutations. Destructive operations always require confirmation, and every mutation on a production profile requires confirmation.
- PostgreSQL and MySQL/MariaDB expose structured user, role, membership, and scoped grant/revoke administration. SQLite reports the capability as unavailable, and plugins do not receive the capability until their reviewed protocol declares an equivalent structured contract.
- Database-account passwords are selected from existing device-bound password SecretRefs. The main process resolves them only inside an opaque definition execution after policy confirmation; credential-bearing SQL is never added to query history, results, events, task records, or renderer state snapshots.
- Principal inventory is bounded to 500 accounts and direct visible privilege inspection is bounded to 1,000 grants. Both use fixed system-catalog reads that do not select password hashes or authentication strings and do not create query-history entries. Privileges and object scopes are selected from driver-specific allowlists rather than accepted as arbitrary SQL.
- Operational logs are a read-only projection over existing durable query-history, task, and device-driver-health evidence plus one purpose-built store for terminal connection lifecycle and structured schema/principal outcomes that have no other durable source. The supplemental store retains at most 5,000 allowlisted records and only IDs, category, operation, state, safe code, and timestamp; log results remain capped at 500 sanitized entries, expose partial-source status, and omit SQL, object/account names, task labels/messages, endpoints, paths, credentials, stderr, and raw diagnostics.
- The module includes the database workspace features from Tabularis, but not Tabularis branding, updater, community screens, AI assistant, separate MCP server, duplicate application settings, or untrusted plugin UI bundles.
- Initial packaged support targets Windows 10/11 x64 while keeping driver and IPC contracts portable.

## Database Coverage Contract

- Built in through the native-host-or-fallback runtime: PostgreSQL, MySQL/MariaDB, and SQLite.
- Plugin candidates at the v0.18.0 protocol baseline: DuckDB, CSV Folder, Redis, ClickHouse, HackerNews, IBM Db2, Google Sheets, Firestore, IBM Informix, MongoDB, DM/Dameng, Cloudflare D1, Elasticsearch, and DynamoDB. Inclusion in this list does not make a release installable.
- Duplicate implementations, such as the Go and Rust Redis drivers or the two Cloudflare D1 drivers, appear as separate catalog driver candidates but one database family in product copy.
- Registry contents are dynamic. A listed plugin is not shown as installable unless an approved, host-compatible signed release currently resolves to a Windows x64 or universal asset and passes integrity and manifest validation.
- Claimed, scoped, open, and coming-soon drivers such as SQL Server, Oracle, BigQuery, Snowflake, Cassandra, and others are not advertised as supported until a compatible release actually exists and passes DeployerX acceptance tests.

## Delivery Tasks

### 1. Documentation and Work Log

- Maintain this decision-complete plan as the implementation contract.
- Update `PROGRESS.md` after every completed or deferred task with changes, verification, remaining work, decisions, and errors or limitations.
- Never mark a task complete without task-specific verification evidence.

### 2. Shared Domain, Storage, and Migration

- Add a standalone `src/database-manager` module instead of adding the domain to `main.js`.
- Define versioned profiles, driver manifests, connection state, schema nodes, query requests/results, tasks, notebooks, and structured errors.
- Add workspace-scoped profile, credential-binding, saved-query, history, notebook, session, plugin-state, and task persistence.
- Persist bounded terminal connection and structured schema/principal operational evidence atomically with workspace/profile isolation, strict operation/state allowlists, and no user-authored SQL, identifiers, labels, messages, endpoints, paths, secrets, or diagnostics.
- Extend the existing control-plane data model additively so Backup Manager connection identities and secret references remain valid.
- Import current-device, query-capable Backup Manager database connections without duplication or destructive cleanup; preserve a deleted imported profile as an explicit opt-out.
- Add revision-based updates, workspace isolation, indexed queries, integrity checks, and redacted audit evidence.

### 3. Driver Runtime

- Define one `DatabaseDriverRuntime` contract for built-in and plugin drivers.
- Maintain a pinned `deployerx-db-host` Rust sidecar as the preferred built-in implementation by extracting the Tabularis PostgreSQL, MySQL/MariaDB, SQLite, pooling, schema, CRUD, dialect, and EXPLAIN behavior without Tauri window, updater, AI, MCP, or application-settings dependencies.
- Vendor the selected upstream files or maintain a small patch series against the pinned commit; do not depend on the moving Tabularis `main` branch or launch the Tabularis desktop executable.
- When a release includes the Windows x64 sidecar, resolve and validate it from the development or packaged resource path before use. The sidecar is optional and is not a required Electron `extraResource`; when it is absent or invalid, select the in-process `pg`, `mysql2`, and `sql.js` fallback through the same contract.
- Before any release that includes the native host, commit `native/deployerx-db-host/Cargo.lock` from the declared Rust 1.77.2 toolchain. Generate an exact transitive crate license inventory from that locked graph, include every required license text in the packaged notice set, and fail native-host release preflight when the lockfile, inventory, or accepted-license review is missing.
- Resolve the native-host lock with Cargo 1.77.2 and retain compatible transitive pins when open semver ranges move to a higher MSRV or Edition 2024. Inventory generation must reject every dependency that declares a Rust version above the root toolchain; a parseable lockfile alone is not compatibility evidence.
- Add lifecycle management, health checks, cancellation, timeouts, response-size limits, crash recovery, and safe logs.
- Resolve a profile's linked DeployerX server at operation time and open an SSH direct-TCP forward bound only to an ephemeral `127.0.0.1` port. Keep the original database endpoint inside the tunnel service, pass only the loopback endpoint to drivers and native transfer utilities, and never mix the server SSH credential with database credential slots.
- Keep operation-scoped tunnels alive through connection tests, queries, schema discovery, opaque definitions, and native imports/dumps, then close them after database credentials are cleared. Transfer physical-session tunnel ownership to the connection session and close the driver pool before the tunnel on explicit close, idle expiry, profile revision changes, driver removal, or application shutdown.
- Treat a missing/wrong linked project, RDP-only project, invalid endpoint, incomplete SSH configuration, authentication failure, timeout, cancellation, local bind failure, and forwarding failure as safe structured tunnel errors. Tunnel setup must be cancellable and must not expose server/database hosts, ports, credentials, or raw SSH diagnostics through Database Manager results.
- Expose bounded, user-controlled connection open/close/status sessions owned by workspace, actor, profile revision, and driver. Built-in sessions retain the selected runtime's physical pool or connection: SQLx in the native host, `pg` or `mysql2` pools, or a `sql.js` database handle in-process. Active-operation leases prevent idle pruning until cancellation or completion. Expire inactive sessions, cap session count, drain runtime resources after user close or replacement, close them on profile or driver lifecycle changes and app quit, and report plugin drivers without portable session methods as operation-scoped.
- Make built-in connection status probe the retained pool or connection with a bounded driver query instead of reporting registry presence alone. Health checks must not extend idle lifetime, unhealthy resources must be evicted, and only syntax-constrained safe error codes may cross into main-process or renderer status.
- Preserve support for schema discovery, queries, batches, CRUD, BLOBs, DDL, views, materialized views, routines, triggers, ER snapshots, EXPLAIN, and driver-supported user/privilege administration. Built-in administration uses bounded PostgreSQL/MySQL/MariaDB account and direct-grant inventory, structured account changes, role membership where supported, and allowlisted scoped grants/revokes through an opaque non-history executor.
- Resolve secrets only at connection time and never include them in persisted profiles, events, logs, or renderer state snapshots.

### 4. Plugin Registry and Compatibility

- Consume `https://registry.tabularis.dev/api/plugins`, fetch plugin detail and release integrity through the documented API, and filter releases by approval state, Windows x64 or universal assets, and host compatibility.
- Verify release identity, Ed25519 JWS, and SHA-256 before installation.
- Bind signed release verification to the JWS schema version, key ID, registry origin, plugin ID, release version, exact signed manifest SHA-256, and selected archive name/size/SHA-256. A valid archive signature must not authorize registry-supplied manifest bytes with a different hash.
- Derive a `.exe` suffix only for extensionless entrypoints selected from Windows-specific assets. Keep script and universal entrypoints unchanged, then require the derived path to exist inside the verified extracted tree before publication.
- Reject invalid signatures, hash mismatches, malformed manifests, archive traversal, out-of-root executables, oversized messages, and malformed JSON-RPC.
- Revalidate installed plugin state before every startup registration: reject unsafe version/entrypoint segments, duplicate IDs, malformed runtime mappings, invalid driver manifests, missing or non-file entrypoints, persisted install paths that differ from the derived registry location, and realpath escapes through linked directories. Persisted state must never be sufficient to redirect execution outside the plugin registry after installation.
- Persist a deterministic schema-versioned SHA-256 inventory of every extracted regular file, bounded to 10,000 filesystem entries, 32 directory levels, and 512 MiB. Reject links and unsupported filesystem entries, stream file hashing with before/after change detection, and revalidate realpath containment after hashing.
- Verify the complete installed inventory during startup, before re-enabling a disabled plugin, and immediately before every fresh plugin process spawn. A changed, added, removed, linked, or otherwise unverifiable file disables the plugin and exposes only a fixed failed-integrity recovery state; existing schema-one records migrate disabled and require reinstall because no trusted inventory exists for them.
- Extract each release into a unique registry-local staging directory, validate and inventory it there, and publish the complete directory by same-volume rename. Same-version reinstalls must not retain obsolete files, and a failed extraction, validation, publication, or registry-state write must preserve or restore the prior installation and persisted record.
- Keep file inventories, hashes, and installation paths out of renderer-facing catalog/install results. Show `Integrity failed` or `Reinstall required`, suppress enable/runtime checks for blocked plugins, and offer reinstall only when a compatible approved catalog release exists.
- Spawn every plugin with only an explicit system environment allowlist (`PATH`, Windows process/runtime roots, temporary-directory variables, locale, and timezone) plus its fixed plugin ID. Never inherit cloud keys, acceptance configuration, database credentials, `NODE_OPTIONS`, or other parent-process environment values; a plugin receives only the active profile's credentials through its operation-scoped JSON-RPC request.
- Treat plugin-originated JSON-RPC error codes, messages, retry flags, and details as untrusted. Replace them with one fixed plugin-operation failure at the runtime boundary while retaining trusted structured errors from the built-in `DatabaseDriverRuntime`.
- Keep legacy unsigned releases visible only as signature-required and non-runnable. Reject installation before download, disable unsigned persisted state during startup normalization, and reject enable, integrity verification, acceptance, and process spawn without `signatureVerified`. If an explicit local unsigned-trust mode is designed later, it requires a separate persisted trust decision, origin/hash disclosure, workspace-policy boundary, and threat review; never silently fall back after a missing or bad signature.
- Refresh the catalog only through the main-process Tabularium client and its signed release-resolution path. Do not expose a renderer/preload IPC that can replace the catalog with arbitrary release metadata.
- Support declarative driver settings, but do not load plugin-provided React/IIFE UI extensions into the DeployerX renderer in the initial release.
- Treat a nonempty signed `connection_string_example` capability as a connection-URI credential requirement even when an upstream manifest also claims no connection is required. Store the value only through a device-bound `connection-uri` SecretRef, pass it transiently in both the current connection-URI field and the legacy Tabularis `database` field, and never accept a reflected plugin URI in connection-test evidence.
- Apply driver-specific connection-URI adaptation only after verifying the signed implementation contract. Db2 `db2://user:password@host:port/database` URIs are parsed transiently into the host, port, database, username, and password fields expected by the signed ODBC plugin; malformed schemes, query/fragment data, invalid ports, malformed encoding, and multi-segment database paths fail with one path-free code before plugin initialization. Other connection-string plugins retain the opaque URI bridge until independently reviewed.
- Use Tabularis `initialize` as the default connection-independent plugin health handshake and normalize only explicit success/readiness. Allowlist plugin connection-test success fields so arbitrary plugin-returned values, endpoints, and credentials cannot cross the runtime boundary.
- Accept JSON-RPC `result: null` as success only for a completed default `initialize` handshake and connection test, matching the signed Db2 protocol. Do not broaden null acceptance to query, schema, declared-health, or arbitrary plugin methods.
- When a legacy plugin has no declared health method and returns a well-formed JSON-RPC error for `initialize`, treat only process/protocol liveness as ready and still require the subsequent real connection test. A declared health method or a non-error invalid health result must fail rather than use the legacy fallback.
- Before every connection-bound plugin operation, serialize access to the shared plugin process, initialize it with that profile's declared settings and device-bound sensitive setting credentials, execute the operation, then reset initialization settings to an empty object. A failed reset stops the process and fails with a fixed host-owned code; health checks and raw host calls share the same bounded queue so they cannot interleave with profile settings. Send both `page_size` and legacy Tabularis `limit` for bounded query pagination.
- Reclassify manifest settings whose keys can carry credentials, including free-form extra/connection properties, as device-bound credential slots. Reapply that policy while normalizing persisted installed manifests, reject undeclared/wrong-type/invalid-option profile settings, enforce required setting and credential slots server-side, and never persist free-form ODBC properties in ordinary profile metadata.
- Interpret Tabularis `schemas` as namespace support rather than the whole explorer capability: signed file- and folder-based drivers still expose their bounded table snapshots. Fail plugin mutation capability closed unless the signed manifest explicitly declares `crud: true` or `readonly: false`; omitted/contradictory flags must not enable write controls or mutation queries.
- Treat script launchers such as Python as device prerequisites unless DeployerX packages a reviewed runtime. A `.py` entrypoint declares a Python 3.8+ host requirement. Probe only the launcher DeployerX will actually execute (`python.exe` on Windows or `python3` elsewhere) with a shell-free `--version` call bounded to two seconds and 8 KiB of output; reduce all failures, old versions, and malformed output to a fixed path-free unavailable reason. Cache the device result for 30 seconds and invalidate it on explicit catalog refresh.
- Return the derived prerequisite and sanitized available/unavailable state with renderer-safe plugin catalog rows. Show the detected version or a `Runtime unavailable` warning, suppress runtime checks, and prevent enabling a disabled script plugin while the requirement is unavailable. Enforce the same prerequisite in main-process runtime registration so direct IPC cannot bypass the UI; installation or enable rollback leaves the plugin disabled when registration cannot satisfy the runtime requirement. The real process spawn remains authoritative if device state changes after the bounded probe.
- Provide an explicit device-only prerequisite recheck for an installed disabled plugin. The action must invalidate the short-lived main-process probe cache without requiring a network catalog refresh, return only the renderer-safe plugin projection, and leave enable/runtime registration as a separate server-enforced step.
- Treat the current signed Db2 Windows plugin as requiring a registered 64-bit IBM Db2 ODBC driver. Probe the 64-bit machine/user ODBC driver registry keys through two parallel, shell-free `reg.exe query` calls with the same two-second and 8 KiB bounds, return only a fixed available/unavailable result, and enforce the result before runtime registration. Installation may stage the signed artifact, but enabling remains blocked until a matching driver is installed and an explicit device prerequisite recheck succeeds.
- Track installed versions per device and support install, update, disable, remove, and crash diagnostics.

### 5. Electron Interfaces

- Add a versioned IPC contract with stable success and structured-error envelopes.
- Expose profile CRUD/test, connection open/close/status, schema discovery, query execute/batch/cancel, row CRUD, import/export, notebook, task, operational-log, and plugin APIs through preload.
- Use request IDs for cancellation and emit authoritative events for connection status, schema changes, query progress, batch completion, tasks, and plugin state.
- Version every Database Manager event, scope workspace events to the active workspace, monotonically sequence them, and expose only whitelisted IDs, states, counts, percentages, operation names, and safe error codes through one constrained preload subscription.
- Keep Electron context isolation enabled and expose no raw `ipcRenderer`, filesystem, process, or child-process access to the renderer.
- Keep the renderer sandboxed, deny renderer-created windows and navigation, and retain a restrictive Content Security Policy.

### 6. Database Manager User Interface

- Add the top-bar button, route, active state, and responsive navigation behavior.
- Mount a Database Manager workspace that uses DeployerX colors, typography, spacing, modals, buttons, loading states, and error states.
- Use a dense connection/schema explorer, tabbed editor/results workspace, and optional details or row inspector.
- Add a guided connection flow for driver, endpoint or local resource, credentials, SSL, optional linked-server SSH tunnel, environment, read-only policy, test, and save.
- Add Monaco editing, formatting, autocomplete, run selected/all, multi-statement batches, cancellation, saved queries, history, split tabs, and result pagination.
- Add virtualized results, copy/export, JSON/BLOB inspection, inline and batch edits, inserts, deletes, and driver-aware value editors.
- Add schema tools, dump/import, ER diagrams, visual EXPLAIN, SQL notebooks with Markdown and charts, capability-gated user/privilege administration, task progress, and operational logs. Logs must reconstruct query, task, driver, connection, and schema/principal evidence across restart; provide connection/category/severity/search filters, partial-source disclosure, bounded chronological rows, and desktop/mobile layouts without exposing raw source records. The administration dialog must support existing-account selection, bounded direct visible privilege inspection, device-bound password SecretRefs, driver-specific role/account fields, bounded privilege choices, production/destructive confirmation, cancellation, and safe failure states.
- Add `Protect with Backup Manager` without silently creating backup jobs or sources.
- Implement WAI-ARIA tab relationships, roving keyboard focus, visible focus indicators, dialog focus containment, Escape handling, opener-focus restoration, and native `inert` isolation of the underlying application shell while a Database Manager dialog is open. Exercise the live Chromium accessibility tree for named tabs, selection state, named interactive controls, dialog naming, and background exclusion; retain NVDA/JAWS workflow acceptance as a separate human gate.

### 7. Cloud Metadata and Shared Connections

- Synchronize profile IDs, names, drivers, endpoints, database defaults, tags, environments, read-only policy, and server links in cloud workspaces.
- Add Firestore rules consistent with existing workspace roles and permissions.
- Keep profile reads independent of write-only `request.resource` state. Validate creates and updates separately through an exact versioned document/metadata schema, bounded scalar and collection fields, exact endpoint/SSL/tunnel/appearance maps, bounded tag and credential-slot elements, path/profile identity, and monotonically increasing revisions.
- Keep the Database Manager Firestore emulator on `127.0.0.1:8180`, disable its UI, and run only the Firestore emulator against the dedicated demo project and rules file. The acceptance runner must compile the real rules and exercise owner/member/non-member/anonymous reads, valid and invalid creates, monotonic updates, and authorized/unauthorized deletes.
- Respect Firestore's 1,000-expression evaluation limit. Rules validate tags as a list capped at 50, while the strict JavaScript cloud boundary validates every tag as a bounded nonempty string. Credential slots remain capped at 20 and explicitly type-checked at every allowed index in rules because they define the credential-sensitive schema. Duplicate credential-slot IDs remain rejected by JavaScript normalization.
- Normalize Firestore REST transport fields (`id`, document path, create time, and update time) separately from persisted profile metadata. Reject mismatched transport identity/path and discard transport fields after extracting compare-and-set evidence.
- Keep device credential bindings, local paths, certificates, query history, notebooks, tabs, and plugins out of cloud documents.
- Project normalized cloud documents again after every inbound or outbox normalization so local `settings`, startup scripts, query timeouts, credential references, and device resources cannot re-enter delivery state. Strip API URL query and fragment data before cloud projection.
- Migrate legacy cloud outbox records through the safe projection and persist the current schema atomically; live remote documents must satisfy the strict current schema and must not use the migration exception.
- Show a clear credential-required or driver-required state when another team member receives shared metadata.
- Use revision and Firestore update-time preconditions for metadata writes, surface concurrent edits as explicit conflicts, and require the user to choose the local or cloud version instead of silently overwriting either one.
- Allow Backup Manager to consume compatible shared profiles while preserving its existing adapters, sources, jobs, repositories, and recovery history.

### 8. SQL Safety and Resource Limits

- Classify statements as read, mutation, destructive, or unknown with dialect-aware parsing and conservative fallbacks.
- Reject mutation, destructive, and unknown statements on read-only profiles before driver invocation.
- Confirm destructive statements on every environment and mutation or unknown statements on production profiles.
- Require typed confirmation for production DROP, TRUNCATE, and destructive schema changes.
- Apply the same policy to SQL, notebooks, imports, schema dialogs, grid edits, context actions, and plugin-issued operations.
- Default result pages to 100 rows, allow configuration up to 5,000 rows, stream large exports, and avoid retaining unbounded results in renderer memory.
- Run full-result exports only for one policy-classified read query, fetch bounded pages in the main process, cap exports at 1,000,000 rows and 1 GiB, publish through a same-directory temporary file, and keep selected-row, batch-result, and plan exports page-bound.

### 9. Licensing and Upstream Maintenance

- Preserve upstream copyright and attribution notices and mark copied files as modified.
- Add Apache-2.0 and third-party notices without using Tabularis trademarks as DeployerX branding.
- Record the pinned upstream commit and copied components.
- For a release that includes the native host, audit the complete locked Rust dependency graph, including target-specific crates, declared SPDX expressions, license files, and any build-time/native-library notices. Direct dependency declarations alone are not sufficient evidence for this gate. Fallback-only releases retain the normal JavaScript dependency notices for `pg`, `mysql2`, and `sql.js` and do not require a Rust inventory.
- When the native host is included, enforce its gate through `src/database-manager/native-release-preflight.js --require-ready` in the Windows prepackage lifecycle. It must reject graph/inventory mismatches, unsafe or missing license-file paths, excluded notices, a non-PE included sidecar, and packaging configuration that bypasses the conditional preflight. License evidence must be a bounded regular file inside the generated notice directory, remain assigned to its normalized crate/version identity, and retain the SHA-256 prefix published in its deterministic filename; duplicate, reassigned, changed, symlinked, noncanonical, or excessive evidence fails closed. An included host must contain a bounded PE signature, AMD64 COFF identity, executable characteristic, PE32+ optional header, and a section table that fits inside the artifact; an `MZ` prefix alone or an x86/PE32 file is not release evidence. A package that intentionally omits the host uses the in-process fallback and must not fail solely because the executable is absent.
- For native-host releases, generate `third_party_licenses/database-manager-rust.json` through `src/database-manager/native-license-inventory.js` from `cargo metadata --locked`. The generator must exclude only the root crate, retain every distinct dependency name/version, preserve declared SPDX expressions or a license-file reference marker, copy bounded recognized license/notice files through realpath containment, publish deterministic paths, and leave legal acceptance as an explicit human review.
- When a crate package declares only an approved SPDX expression and ships no recognized license file, permit fallback only when every expression identifier maps to a reviewed canonical license text in `third_party_licenses`; copy those texts into package-owned content-addressed files. Unknown identifiers, license references, malformed expressions, missing canonical texts, and excessive evidence fail generation.
- For native-host releases, record human legal acceptance in `third_party_licenses/database-manager-rust-review.json`. Require an explicit approved decision, bounded reviewer/timestamp, exact package count and sorted license-expression set, and SHA-256 bindings to both `Cargo.lock` and the generated inventory. Missing, malformed, or stale review evidence must fail native-host release preflight, and automated generation must never create an approval.
- Before legal review of a native-host release, generate `documentation/database-manager/NATIVE-LICENSE-REVIEW-REQUEST.json` as a deterministic pending handoff. It must reject a lock/inventory graph mismatch, bind the exact source hashes, report package and evidence-file counts plus the sorted expression set, and use a schema that cannot satisfy the release approval validator. Regeneration may update only the request; a human must create the separate approval file.
- Review upstream protocol, security, and driver changes manually; never auto-merge the upstream desktop application.

### 10. Verification and Acceptance

- Unit-test normalization, storage, migrations, revisions, isolation, secret redaction, cloud projection, SQL policy, result serialization, and IPC envelopes.
- Source-contract test the Firestore profile read/write split, exact cloud key lists, bounded tag/credential elements, excluded local fields, API URL policy, monotonic revision requirement, loopback-only emulator configuration, disabled emulator UI, acceptance command, and authorization runner matrix. Keep Firebase emulator compilation plus owner/member/non-member allow/deny behavior as a mandatory environment-backed acceptance gate.
- Contract-test every built-in driver method and the JSON-RPC plugin host, including cancellation, timeouts, malformed responses, crashes, and restart behavior.
- Run built-in live acceptance through `src/database-manager/native-live-acceptance.js` and the `database-native:accept` script. The runner must always exercise the in-process `pg`, `mysql2`, and `sql.js` implementation of `DatabaseDriverRuntime` and additionally exercise the real versioned sidecar protocol when a valid host is included. It must generate and remove its own temporary SQLite database and accept direct PostgreSQL/MySQL connection objects only through `DEPLOYERX_DB_ACCEPT_POSTGRESQL_JSON` and `DEPLOYERX_DB_ACCEPT_MYSQL_JSON` environment variables.
- Accept live linked-server coverage only through bounded `DEPLOYERX_DB_ACCEPT_POSTGRESQL_SSH_JSON` and `DEPLOYERX_DB_ACCEPT_MYSQL_SSH_JSON` environment objects containing separate `connection` and `ssh` records. Validate password/key SSH settings, open the production loopback forwarding transport to the declared remote database endpoint, pass only `127.0.0.1` and the ephemeral port to the selected runtime, run the same full driver lifecycle, and close the tunnel after success or failure.
- Require `DEPLOYERX_DB_ACCEPT_MUTATIONS=I_UNDERSTAND_THIS_USES_DISPOSABLE_DATABASES` before any configured network database is mutated. Acceptance databases must be disposable and independently provisioned; the runner may create only a unique generated table and must attempt table removal, session close, runtime shutdown, and SQLite fixture removal after success or failure.
- For each executed built-in and transport, verify connection test/open/status, create, insert, select, update plus readback, bounded schema visibility, stateless read-only mutation rejection, delete plus readback, drop, and connection close. SSH runs must additionally verify tunnel open/close. Versioned reports may contain only fixed driver IDs, transport modes, check names, statuses, counts, and syntax-constrained codes, never credentials, endpoints, database names, SQL, file paths, or raw driver diagnostics.
- Treat invalid runtime configuration, absent network mutation acknowledgement, cleanup failure, or any failed runtime contract check as non-passing evidence. A missing host is non-passing only when the native path was explicitly selected or the artifact declares that it includes the host; otherwise acceptance must exercise the fallback. The runner is an explicit acceptance command and must not run automatically during packaging or ordinary automated regression tests.
- Run externally produced Windows installed/portable artifact acceptance through `src/database-manager/windows-artifact-acceptance.js` and the `database-windows:accept` script. Accept exactly two distinct absolute layouts only through `DEPLOYERX_DB_WINDOWS_ARTIFACTS_JSON`, never command-line paths; require an application executable and resources directory for each. Require one exact 64-character signer-certificate SHA-256 through `DEPLOYERX_DB_WINDOWS_SIGNER_CERT_SHA256`; use a fixed PowerShell Authenticode query with an isolated environment to require valid timestamped signatures from that certificate on the application, every reviewed non-system direct import, and the sidecar when included. Force Windows package signing and DLL signing in electron-builder configuration. Parse bounded PE32+ standard and delay-import tables directly, reject malformed/path-bearing/excessive modules and imports outside the explicit reviewed Windows/Electron baseline, and require packaged direct imports such as `ffmpeg.dll` to be regular, contained, PE-valid, same-signer, dependency-reviewed, and stable. Reject non-Windows/x64 hosts, malformed/oversized/extra configuration, linked or non-regular artifacts, resource escapes, a non-PE32+ x64 application or included sidecar, incompatible health, and failed shutdown. When the sidecar is included, resolve it only through the production packaged path, launch it for a bounded real protocol health check, and always stop it; when omitted, exercise the packaged in-process fallback and do not fail for host absence. Emit only layout kinds, fixed check states, counts, and safe codes without paths, certificate bytes, imports, or diagnostics.
- Before process launch, use the exact pinned official `@electron/asar` reader to require a bounded, contained, stable `resources/app.asar`; always validate the Database Manager and JavaScript dependency notices, and when the native host is included also extract and validate its strict inventory and human approval, bind the approval to the packaged inventory hash, count, and sorted expression set, and verify every uniquely assigned content-addressed license file within per-file and aggregate bounds.
- Require the declared `resources` directory to be the real, non-linked `resources` sibling of the accepted application executable so legal evidence, an optional native host, and application execution cannot be validated from different layouts. Before launching the packaged application, resolve `MpCmdRun.exe` only from the newest bounded Microsoft Defender platform directory or its protected legacy installation root, require the scanner binary to remain stable with valid timestamped Authenticode, and run one shell-free non-remediating custom scan over the complete application directory. Isolate the scanner environment, cap execution at 180 seconds and output at 1 MiB, discard all path-bearing scanner output, and fail before UI smoke or runtime execution when Defender is missing, untrusted, changed, times out, reports a threat, or otherwise returns failure.
- After archive/legal validation and before runtime execution, launch the real packaged Electron executable in a hidden, read-only smoke mode with an isolated temporary user-data directory and a minimal credential-free Windows environment. Bound the launch to 45 seconds and 1 MiB of output, require one exact ordered schema-one report, and always remove the temporary state. The smoke path must use the production BrowserWindow, preload, sandbox, context isolation, navigation policy, and actual renderer assets; open Database Manager through its real top navigation control; verify the exact Connections, Query, Notebooks, Tasks, Logs, and Drivers tabs plus the add-database control; reject Node-specific `require` capabilities, `Buffer`, Electron IPC, and unrestricted process access in renderer scope; and fail before runtime health when any application UI check is missing, reordered, duplicated, malformed, or failed.
- Hold the smoke process through a one-shot release signal contained inside its isolated user-data directory while the acceptance parent enumerates the live Electron process tree with one bounded, fixed PowerShell query. Require the exact application executable to appear in the observed module set; reject malformed, duplicate, excessive, missing, non-file, or escaped module evidence; allow loaded modules only under the real Windows directory or the application directory; and require every application-local loaded module to remain stable and carry a valid timestamped Authenticode signature from the approved application signer. The source-Electron contract may skip release signing only when explicit source application arguments are used, and cannot count as release evidence. Synthetic fixtures and source-Electron execution prove the runner contract only; the installed/portable exit gate remains open until externally produced signed artifacts pass every check. Real Defender scan evidence, independent antivirus/reputation review, SmartScreen behavior, and independent Windows, GPU-vendor, installer, uninstaller, and updater provenance remain external gates.
- Run installed-plugin live compatibility through `src/database-manager/plugin-live-acceptance.js` and the `database-plugin:accept` script. Accept an absolute existing plugin-registry root only through `DEPLOYERX_DB_PLUGIN_REGISTRY_ROOT` and a bounded array of read-only plugin connection/query configurations only through `DEPLOYERX_DB_PLUGIN_ACCEPT_JSON`; reject command-line configuration and do not install, update, enable, or remove plugins from this runner.
- Require `DEPLOYERX_DB_PLUGIN_ACCEPT_QUERY=I_UNDERSTAND_PLUGIN_ACCEPTANCE_QUERY_MUST_BE_READ_ONLY` before registry access or process spawn whenever a configured query is present. The operator must provide a driver-appropriate non-mutating smoke query; the runner cannot infer semantics for every non-SQL Tabularis protocol implementation.
- For every configured installed plugin, reverify its complete content inventory and declared credential slots, launch it through the same production factory used by Electron, verify health and connection testing, validate capability-declared schema/query results through the Database Manager domain normalizers, enforce a ten-row acceptance page, clear transient credentials, and wait for bounded graceful/forced process termination. Versioned reports may contain only plugin ID/version, fixed check names/states/codes, and aggregate counts, never registry paths, endpoints, database names, queries, credentials, remote error text, or diagnostics.
- Test registry signature/archive-hash checks, unsigned pre-download rejection, persisted unsigned-state disablement, signature-required UI/acceptance states, absence of renderer catalog injection, full extracted-tree inventory, changed/added/removed dependency quarantine, legacy reinstall migration, unsupported platforms, staged failed-install rollback, same-version replacement, registry-write rollback, traversal rejection, upgrades, removals, valid restart loading, persisted-state tampering, duplicate installed IDs, missing entrypoints, install/startup realpath containment, enable-time verification, and fresh-process pre-spawn verification.
- Add Electron tests for navigation, connection creation, SSH linkage, explorer loading, query execution/cancellation, result editing, production guards, notebooks, operational logs, plugins, and Backup Manager handoff. Operational-log acceptance must cover restart persistence, strict redaction, workspace/profile isolation, bounded retention, partial-source failure, connection/schema filters, and desktop/mobile layout.
- Verify current signed registry drivers on Windows where their required external services or credentials are available.
- A signed plugin binary exercised against a bounded protocol-compatible fixture proves installer, integrity, process, and JSON-RPC compatibility only. Keep the driver-specific live-service gate open until the same runner passes against the real external database or API with reviewed read-only acceptance configuration.
- Run only targeted checks and tests. Do not run `npm run dev`, development servers, or build commands.

## Delivery Order

1. Documentation, domain contracts, storage, migration, and tests.
2. Electron IPC/preload, top-bar route, and Database Manager shell.
3. Built-in driver runtime, connections, explorer, editor, results, CRUD, and safety.
4. Schema tooling, import/export, ER, EXPLAIN, notebooks, tasks, and administration.
5. Registry/plugins, cloud metadata, shared Backup Manager connections, accessibility, and responsive polish.
6. Full regression, compatibility, security, and acceptance audit.

## Release Slices And Exit Gates

### Slice A - Integrated Connection Catalog

- Add the top navigation entry after Backup Manager, profile list, add/edit/test/delete flow, encrypted credential bindings, workspace isolation, linked-server SSH tunneling, and empty/loading/error states.
- Exit gate: a PostgreSQL, MySQL/MariaDB, and SQLite profile can be created, reopened after restart, tested, and removed without exposing plaintext secrets or regressing Backup Manager connections.

### Slice B - Query Workspace MVP

- Add connection open/close, schema explorer, tabbed Monaco editor, run selected/all, cancellation, paginated results, copy/CSV/JSON export, saved queries, and history.
- Enforce read-only and production confirmation policies before driver invocation.
- Exit gate: all three built-ins pass the same driver contract suite and the main query workflow passes Electron navigation and IPC tests.

### Slice C - Database Administration

- Add row insert/update/delete, table and column tooling, indexes, foreign keys, views, routines, triggers, import/dump, BLOB/JSON inspection, ER diagrams, visual EXPLAIN, notebooks, and task progress.
- Show controls only when the selected driver advertises and implements the required capability.
- Exit gate: every mutation path is covered by the same environment policy and long-running operations remain cancellable and memory bounded.

### Slice D - Plugin Ecosystem

- Add the Tabularium catalog, signed installer, plugin lifecycle, declarative settings, JSON-RPC runtime, crash isolation, and compatibility reporting.
- Validate each currently available Windows driver independently; unsupported or failing releases remain visible only as unavailable with a concrete reason.
- Exit gate: signature/hash failures, traversal attempts, malformed messages, timeouts, and plugin crashes are tested, and no plugin process receives credentials belonging to another profile.

### Slice E - Shared Operations And Release Hardening

- Add cloud-safe metadata sync, role rules, credential-required states, shared connection import, and the explicit `Protect with Backup Manager` handoff.
- Complete licensing notices, accessibility, responsive behavior, portable/install path tests, security review, and regression coverage.
- Exit gate: the acceptance matrix passes for local and cloud workspaces, installed and portable Windows packages, and all supported drivers.

## Deferred Beyond The Initial Database Workspace

- Tabularis AI assistant and AI-generated SQL.
- A second database-specific MCP server; any future database tools must extend DeployerX's existing MCP integration.
- Automatic synchronization of database credentials between team members.
- Drivers that are only roadmap claims and do not have a compatible published release.
- Tabularis React plugin UI-extension bundles. A later release may add an isolated extension host after a separate threat model and API compatibility design; they will not run in the privileged DeployerX renderer.
- Platforms outside the current Windows x64 packaging target.

## Constraints

- Preserve existing user changes and current Backup Manager, Uptime Monitor, SSH, SFTP, cloud, and MCP behavior.
- Prefer module-local files and thin registration points over adding substantial new logic to `main.js`, `preload.js`, or the monolithic renderer.
- Use structured parsers and protocols rather than ad hoc string handling where practical.
- A task is complete only when implementation and verification evidence are recorded in `PROGRESS.md`.
