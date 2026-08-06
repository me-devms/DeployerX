# Backup Manager Core Delivery Tasks

## Purpose

This is the active delivery tracker for Backup Manager. It replaces the broad database expansion roadmap with the explicitly selected mainstream database scope.

Start with the [Backup Manager documentation index](./README.md). For the concise step-by-step queue and current/next status, use [BACKUP_MANAGER_TASK_LIST.md](./BACKUP_MANAGER_TASK_LIST.md). This file remains the detailed acceptance and evidence register.

The historical implementation record remains in [TASKS.md](./TASKS.md). That file is evidence and history, not the queue for new database families.

Update this file whenever work starts, finishes, changes scope, becomes blocked, or produces verification evidence.

## Status Legend

- `[ ]` Planned
- `[~]` In progress
- `[x]` Completed and verified
- `[!]` Blocked; explain the blocker in the progress log
- `Removed` Not part of the active product or release plan

## Active Product Scope

### Backup workloads

- Server and file backup over local access and SSH/SFTP
- MySQL
- MariaDB
- PostgreSQL
- Supabase, implemented as a constrained PostgreSQL deployment profile
- SQLite
- MongoDB
- Redis
- ClickHouse

This is the complete product scope, not a priority tier or a deferred phase. Adding another database requires a separate future product decision and is not part of this plan.

The active release is intentionally optimized for the databases used by the broadest set of teams. Cassandra, CockroachDB, InfluxDB, Neo4j, and other specialist engines are not release prerequisites, and no implementation or research work for them should be added to this tracker.

### Backup destinations

- The computer or worker running DeployerX
- Local folders and attached storage
- SFTP repositories
- S3-compatible object storage

Additional repository providers may be added only after the core release gates below pass. Plain FTP is not a core target because it cannot provide the transport and integrity guarantees expected for backups.

## Removed Database Scope

No new connection, Source, Job, Recovery, renderer, documentation, or test work will be scheduled for database families outside the active list. Unlisted databases are not a later phase of this plan.

This currently removes Cassandra, ScyllaDB, CockroachDB, every InfluxDB tier, Neo4j, Oracle, SQL Server, Elasticsearch, OpenSearch, and any other unlisted database from the active delivery plan. Existing implementation and recovery history must not be destructively deleted. It may remain isolated for compatibility, but it must not delay the core release or appear as a new-work commitment.

## Release Definition

Each active database is complete only when all applicable gates are proven:

1. A secret-safe connection can be created, tested, retested, and diagnosed.
2. Discovery identifies the exact server, version, topology, and selectable scope.
3. Source creation records an explicit consistency method and selection.
4. Full backup works; incremental, log, or point-in-time modes are shown only where implemented and proven.
5. Backup data or authenticated metadata is committed to a supported encrypted repository.
6. Manual and scheduled jobs expose progress, cancellation, retry, and restart behavior.
7. Retention protects every required chain member and active recovery operation.
8. Restore supports only proven original or alternate targets and requires destructive confirmation where appropriate.
9. Recovery Tests authenticate backup media and perform an isolated drill where the adapter supports it.
10. Activity and Recovery views expose useful bounded evidence without credentials or private paths.
11. Focused service tests and the database's Electron workflow pass.
12. Compatibility, limitations, and an operator recovery runbook are current.

## Scope Definition Track

- [x] `CORE-001` Freeze the active database scope and create this tracker.
  - Acceptance: only file/server plus the seven underlying core database adapters generate new implementation tasks; Supabase is an eighth database entry only because it is a PostgreSQL profile.
  - Acceptance: Supabase reuses PostgreSQL contracts and is not presented as a separate database engine.
  - Acceptance: historical work remains available without controlling current priorities.
- [x] `CORE-002` Enforce the active database allowlist in product entry points.
  - Hide removed database families from new connection and Source creation.
  - Preserve read-only visibility and recovery access for previously created records where removal would risk user data.
  - Keep the allowlist centralized so main-process and renderer behavior cannot drift.
  - Add a focused contract test proving exactly the active engine set.
- [x] `CORE-003` Publish one honest core compatibility matrix.
  - Record supported versions, backup modes, restore targets, topology limits, native tools, privileges, and repository requirements.
  - Link each row to its engine runbook.

## Foundation Track

- [x] `CORE-FND-001` Dedicated Backup Manager module and navigation.
  - Evidence: historical `BM-001` through `BM-002`.
- [x] `CORE-FND-002` Transactional control database, SecretRefs, audit logging, and worker lifecycle.
  - Evidence: historical `BM-003` through `BM-008`.
- [x] `CORE-FND-003` Local and SSH/SFTP file Sources with selection controls.
  - Evidence: historical `BM-101` through `BM-106`.
- [x] `CORE-FND-004` Encrypted, versioned repositories for local folders, SFTP, and S3-compatible storage.
  - Evidence: historical `BM-107` through `BM-111`.
- [x] `CORE-FND-005` Manual and scheduled backup, browsing, restore, and repository verification.
  - Evidence: historical `BM-112` through `BM-117`.
- [x] `CORE-FND-006` Scheduling, retention, pruning, history, notifications, RPO/RTO, and job controls.
  - Evidence: historical `BM-201` through `BM-209`.
- [x] `CORE-FND-007` Complete the core release resilience matrix.
  - Interrupted transfer and process restart
  - Expired credentials and network recovery
  - Retention, repository exhaustion, concurrency, and lock recovery
  - Timezone and daylight-saving transitions
  - Ransomware-style change protection
  - Secret and dependency audit
  - Evidence: the 19-file core resilience suite passed 132/132 tests with zero failures, cancellations, skips, or todos.
  - Evidence: the ransomware-style mass-change regression retained an earlier authenticated RecoveryPoint after deletion and encryption-like source mutations, then reproduced all 12 original files byte-for-byte.
  - Evidence: full and production lockfile audits both reported zero vulnerabilities.

## MySQL Track

- [x] `CORE-MYSQL-001` Logical full backup and original/alternate restore.
  - Evidence: historical `BM-302`, `BM-306`, and `BM-307`; `MYSQL_LOGICAL_BACKUP_RESTORE.md`.
- [x] `CORE-MYSQL-002` Binary-log capture and point-in-time recovery.
  - Evidence: historical `BM-401`; `MYSQL_MARIADB_POINT_IN_TIME_RECOVERY.md`.
- [x] `CORE-MYSQL-003` Physical backup and restore through the approved native engine.
  - Evidence: historical `BM-402`; `MYSQL_PHYSICAL_BACKUP_RESTORE.md`.
- [x] `CORE-MYSQL-004` Run the final focused service, restart, secret, and desktop/mobile workflow gate.

## MariaDB Track

- [x] `CORE-MARIADB-001` Logical full backup and original/alternate restore.
  - Evidence: historical `BM-303`, `BM-306`, and `BM-307`; `MARIADB_LOGICAL_BACKUP_RESTORE.md`.
- [x] `CORE-MARIADB-002` Binary-log capture and point-in-time recovery.
  - Evidence: historical `BM-401`; `MYSQL_MARIADB_POINT_IN_TIME_RECOVERY.md`.
- [x] `CORE-MARIADB-003` Run the final focused service, restart, secret, and desktop/mobile workflow gate.

## PostgreSQL And Supabase Track

- [x] `CORE-POSTGRES-001` PostgreSQL logical full backup and original/alternate restore.
  - Evidence: historical `BM-304`, `BM-306`, and `BM-307`; `POSTGRESQL_LOGICAL_BACKUP_RESTORE.md`.
- [x] `CORE-POSTGRES-002` PostgreSQL base backup, WAL archive, and point-in-time recovery.
  - Evidence: historical `BM-403`; `POSTGRESQL_BASE_BACKUP_WAL_PITR.md`.
- [x] `CORE-POSTGRES-003` Add the Supabase PostgreSQL profile.
  - Require TLS and a SecretRef-backed database password.
  - Distinguish direct or session-pooler connections from transaction-pooler endpoints that are unsafe for native backup workflows.
  - Reuse PostgreSQL logical backup, restore, validation, repository, scheduling, and retention behavior.
  - Do not advertise filesystem base backup, WAL archive control, superuser operations, or platform snapshot ownership without explicit Supabase support and privileges.
  - Add alternate-project restore guidance and a focused renderer workflow.
- [x] `CORE-POSTGRES-004` Run the final PostgreSQL and Supabase service, restart, secret, and desktop/mobile workflow gate.

## SQLite Track

- [x] `CORE-SQLITE-001` Online consistent backup, encrypted publication, and restore.
  - Evidence: historical `BM-407`; `SQLITE_BACKUP_RESTORE.md`.
- [x] `CORE-SQLITE-002` Run the final local-file replacement, lock, restart, and desktop/mobile workflow gate.

## MongoDB Track

- [x] `CORE-MONGODB-001` Logical dump backup and restore.
- [x] `CORE-MONGODB-002` Coordinated snapshot, oplog, replica-set, and sharded workflows supported by current deployment contracts.
  - Evidence: historical `BM-406`; `MONGODB_BACKUP_RESTORE.md`.
- [x] `CORE-MONGODB-003` Run the final standalone and replica-set recovery, restart, secret, and desktop/mobile workflow gate.
  - Automatic platform-specific sharded write-gate integrations are not a core release blocker.

## Redis Track

- [x] `CORE-REDIS-001` RDB backup and restore.
- [x] `CORE-REDIS-002` AOF and multipart-AOF backup and restore.
- [x] `CORE-REDIS-003` Redis Cluster orchestration supported by the current adapter contract.
  - Evidence: historical `BM-408`; `REDIS_BACKUP_RESTORE.md`.
- [x] `CORE-REDIS-004` Run the final RDB/AOF/cluster restart, secret, and desktop/mobile workflow gate.

## ClickHouse Track

- [x] `CORE-CLICKHOUSE-001` Secret-safe connection, discovery, topology binding, and configured-disk approval.
- [x] `CORE-CLICKHOUSE-002` Native full and incremental backup with authenticated base chains.
- [x] `CORE-CLICKHOUSE-003` Alternate-target native restore, validation, cancellation, and restart reconciliation.
- [x] `CORE-CLICKHOUSE-004` Metadata/full Recovery Tests and complete renderer workflows.
  - Evidence: the ClickHouse sections in historical `BM-411`; `CLICKHOUSE_BACKUP_RESTORE.md`.
- [x] `CORE-CLICKHOUSE-005` Extract the ClickHouse contract into a core-only runbook and run the final focused release gate.

## Core Release Track

- [x] `CORE-REL-001` Finish `CORE-002` and prove removed engines cannot be selected for new configurations.
- [x] `CORE-REL-002` Complete the Supabase PostgreSQL profile.
- [x] `CORE-REL-003` Execute each pending final engine gate in this order: MySQL, MariaDB, PostgreSQL/Supabase, SQLite, MongoDB, Redis, ClickHouse.
- [x] `CORE-REL-004` Execute the shared file/server backup release matrix.
- [x] `CORE-REL-005` Verify the complete core renderer workflow at desktop and 390 px mobile widths.
- [x] `CORE-REL-006` Publish the compatibility matrix, operator runbooks, known limitations, and recovery checklist.
- [!] `CORE-REL-007` Mark the core Backup Manager implementation release-ready only when every task above is complete and evidenced here. Electron 43 metadata and isolated-runtime validation are complete; physical replacement remains blocked below.
  - [x] Update the manifest and lockfile to the current Electron release, `43.3.0`.
  - [x] Complete the isolated Electron 43 runtime and core workflow matrix.
  - [!] Close all live DeployerX/Electron processes, refresh the primary workspace dependency install, confirm the physical installed Electron version is `43.3.0`, and rerun the security/runtime checks. Current evidence: 18 `electron.exe` processes still hold the workspace runtime at `30.5.1`; they were not terminated by the agent.
  - [x] Complete and record the disposable real OpenSSH/SFTP release smoke defined in `CORE_RECOVERY_CHECKLIST.md`, including abrupt-loss reconciliation and repository lease takeover. Evidence: disposable Windows OpenSSH `10.0p2` on loopback port `64041`; all 12 checks passed, including `SFTP_REPOSITORY_WRITE_FAILED` in 1,055 ms after exact channel loss, no partial publication, aged orphan removal, expired-lease takeover, stale-owner fencing, byte-exact retry, and lease release. The listener, sessions, and port were cleared afterward.

## Execution Order

Work strictly in this order unless the progress log records an explicit reason to change it:

1. Enforce the active engine allowlist (`CORE-002`).
2. Add the Supabase PostgreSQL profile (`CORE-POSTGRES-003`).
3. Run and repair each engine's focused release gate.
4. Run and repair the shared file/server resilience gate.
5. Run the complete core-only service and Electron matrices.
6. Publish operator documentation and release status.
7. Close all live DeployerX/Electron processes, refresh and verify the primary workspace dependency installation, and rerun the security/runtime checks.
8. Close `CORE-REL-007` only after the physical version and rerun evidence are recorded. The real OpenSSH/SFTP smoke is already complete.

The remaining release work is governed by `CORE-REL-007`. Do not add another database family to this closed scope. Parallel work is allowed only for tests or documentation that cannot conflict with the primary implementation task.

## Progress Log

### 2026-08-05 - Core scope reset completed

- Stopped active InfluxDB and CockroachDB hardening work after the product scope changed.
- Defined the active database set as MySQL, MariaDB, PostgreSQL, Supabase, SQLite, MongoDB, Redis, and ClickHouse.
- Classified Supabase as a PostgreSQL deployment profile so it reuses one proven adapter and does not create another long engine track.
- Removed all unlisted database families from the active roadmap while preserving existing implementation and recovery history.
- Audited the historical tracker and confirmed completed implementation records for the core file/server foundation and all seven underlying database engines.
- Created this short tracker so current, completed, and next work no longer depends on the much larger historical log.

### 2026-08-05 - CORE-002 started

- Next task at the time of this entry: centralize the active database allowlist and apply it to new connection and Source entry points.
- Safety rule: do not delete existing records or remove recovery access merely because their database family left the active plan.

### 2026-08-05 - CORE-002 completed; Supabase profile started

- Centralized the exact active adapter IDs in `src/backup-manager/core-database-scope.js`.
- Production now advertises and accepts new Sources only for MySQL, MariaDB, PostgreSQL/Supabase, MongoDB, Redis, SQLite, and ClickHouse.
- Every database connection-creation IPC path now uses the same allowlist. Removed engines return `BACKUP_DATABASE_ADAPTER_OUT_OF_SCOPE` for new connections.
- The renderer shows only the seven underlying core database adapters. Existing removed-engine rows remain available for diagnostics and recovery, but their new-Source action is disabled.
- Preserved existing removed-engine implementations, records, tests, diagnostics, and recovery paths without scheduling further delivery work for them.
- Verification evidence: 15 focused allowlist, Source compatibility, and main-process contract tests passed; `src/main.js` and `src/renderer/renderer.js` passed syntax checks; the static renderer contract found exactly seven visible core database buttons; the ClickHouse Electron UI integration test passed.
- Next task at the time of this entry: `CORE-POSTGRES-003`, implemented as a constrained profile of the existing PostgreSQL adapter rather than a new engine.

### 2026-08-05 - Supabase PostgreSQL profile completed; MySQL final gate started

- Supabase remains a deployment profile of `deployerx.database.postgresql.logical`; no separate adapter or database-family roadmap was created.
- Added endpoint-bound direct and session-pooler support, required TLS, SecretRef-only credentials, logical full backup, managed-schema exclusions, and existing-database restore with original/alternate project identity checks.
- Transaction-pooler connections remain available for diagnostics but cannot create Sources, back up, or restore. Physical base backup, WAL, PITR, and whole-project recovery are explicitly outside the profile.
- Added the focused 390 px renderer workflow and `SUPABASE_POSTGRESQL_BACKUP_RESTORE.md` with database-only coverage and platform exclusions.
- Verification evidence: 33 focused allowlist, Source, main-process, PostgreSQL, and Supabase tests passed; the Supabase and existing PostgreSQL object-selection Electron workflows passed; all modified JavaScript passed syntax checks; `git diff --check` reported no whitespace errors.
- Completed `CORE-POSTGRES-003` and `CORE-REL-002`.
- Next task at the time of this entry: `CORE-MYSQL-004`. No work is scheduled for rare or removed database families.

### 2026-08-05 - Core relational release gates completed; SQLite gate started

- MySQL evidence: 49 focused logical, physical, binlog/PITR, restore, cancellation, and restart tests passed; four SecretRef tests passed; five Electron workflows passed at their defined desktop/mobile widths.
- Added direct MySQL process-restart regression coverage for abandoned physical and PITR RestoreRuns. The physical interruption remains non-retryable and requires datadir inspection; PITR interruption remains explicitly retryable.
- MariaDB evidence: 20 focused adapter, backup, restore, binlog/PITR, validation, and restart tests plus four shared SecretRef tests passed; three Electron workflows passed. Added isolated and idempotent logical/PITR startup-reconciliation coverage.
- PostgreSQL/Supabase evidence: 37 focused logical, physical, WAL/PITR, restore, Supabase, and SecretRef tests passed; 32 shared checkpoint/control-database restart tests passed; six Electron workflows passed. Added abandoned PITR startup-reconciliation coverage.
- Fixed one test-only MySQL recovery selector so it reads the active recovery modal instead of an unrelated warning with the same class. No production behavior changed for the three final gates.
- Completed `CORE-MYSQL-004`, `CORE-MARIADB-003`, and `CORE-POSTGRES-004`.
- Next task at the time of this entry: `CORE-SQLITE-002`.

### 2026-08-05 - MongoDB and Redis final gates completed in parallel

- MongoDB evidence: 61 focused standalone, replica-set, sharded, logical, physical, oplog, restore, validation, cancellation, restart, recovery-drill, and SecretRef tests passed; connection and desktop/mobile Electron workflows passed.
- Added a replica-set-to-distinct-standalone restore regression proving oplog replay, destructive/UUID controls, credential-free arguments, and native collection/index/UUID validation.
- Redis evidence: 53 focused RDB, Redis 7 multipart-AOF, Redis 8 sealed AOF, cluster, restore, validation, cancellation, restart, publication-safety, TLS, environment-only password, and SecretRef tests passed; three Electron workflows passed.
- Automatic platform-specific MongoDB sharded write-gate integration remains explicitly outside the core release blocker; supported coordinated sharded workflows retain their existing fail-closed contracts.
- Completed `CORE-MONGODB-003` and `CORE-REDIS-004` without reopening any removed database family.
- Active task at the time of this entry remained `CORE-SQLITE-002`; `CORE-CLICKHOUSE-005` documentation and focused tests were running in parallel.

### 2026-08-05 - ClickHouse final gate completed

- Published `CLICKHOUSE_BACKUP_RESTORE.md` as a core-only runbook aligned to the implemented adapter rather than the removed-engine research document.
- The supported envelope is self-managed ClickHouse 23.x through 26.x, standalone and non-replicated, with one approved configured writable Disk destination, exact database/table selection, native full/incremental chains, and empty alternate-target restore.
- The runbook explicitly excludes cluster/replica backup, cloud-managed services, S3/Azure/named-collection destinations, original-target overwrite, PITR, native-media deletion, and rollback claims.
- Verification evidence: 29 focused connection, discovery, destination, backup-chain, source-reader, restore, validation, cancellation, restart, Recovery Test, and SecretRef tests passed; three Electron workflows passed at desktop and 390 px mobile widths without horizontal overflow.
- Completed `CORE-CLICKHOUSE-005`; `CORE-SQLITE-002` remains the only unfinished database final gate.

### 2026-08-05 - All core database gates and compatibility matrix completed

- SQLite now propagates cancellation into repository streaming, digesting, and staged writes; treats only `ENOENT` as path absence; returns safe stable access/busy/probe errors; and preserves uncertain or concurrently published targets for operator inspection.
- SQLite startup reconciliation scans bounded pages across more than 200 mixed restore records and mutates only nonterminal SQLite runs owned by the exact worker. Unowned staging and other-device/other-engine runs are preserved.
- Verification evidence: 23 focused SQLite, audit, and SecretRef tests passed; the desktop/390 px Electron workflow passed with no overflow; all modified SQLite JavaScript and whitespace checks passed.
- Published `CORE_COMPATIBILITY_MATRIX.md` with 12 implementation-aligned rows covering file/server and every supported core adapter/profile, including versions, modes, source scope, restore targets, topology limits, tools, privileges, repositories, exclusions, and linked runbooks.
- Completed `CORE-003`, `CORE-SQLITE-002`, and aggregate `CORE-REL-003`. All seven underlying core database adapters now pass their final release gates.
- Next task at the time of this entry: `CORE-REL-004`. Existing file/server coverage was green; focused SFTP interruption/retry and pruning dry-run/apply UI evidence was being added before closure.

### 2026-08-05 - Shared file/server release matrix completed

- Existing file/server evidence passed 160 focused local, SSH/SFTP, repository, encryption, verification, backup/restore, cancellation, restart, SecretRef, retention, pruning, and control-database tests with zero skips.
- Added a deterministic service-path integration from an SFTP Source through encrypted/authenticated SFTP repository publication, Snapshot Browser, and SFTP target restore. Exact restored bytes match and plaintext is absent from repository objects.
- Added mid-transfer SFTP publication and restore interruption coverage. Fresh-service reconciliation leaves no partial RecoveryPoint, Artifact, final target, or owned staging; backup resumes as attempt 2 and restore succeeds on a fresh retry.
- Added a focused pruning Electron workflow covering dry-run before apply, cancel without mutation, exact reviewed plan ID, protected-chain refusal, destructive styling and focus, post-apply reload, and 390 px containment.
- Verification evidence: the new SFTP suite passed 9/9 and the combined file/SFTP/SSH gate passed 67/67; the pruning Electron gate passed with no horizontal overflow; existing 13 file/server Electron workflows, including dedicated Backup Manager navigation, passed separately.
- A disposable real OpenSSH/SFTP smoke remains an external release-environment gate covering extension negotiation, pinned-host-key/SecretRef authentication, abrupt TCP/channel loss, remote fsync/hardlink/atomic-rename semantics, and repository lease takeover; deterministic product contracts are complete.
- Completed `CORE-REL-004`. Next task at the time of this entry: `CORE-REL-005` complete core renderer verification.

### 2026-08-05 - Core operator documentation completed

- Published `CORE_RECOVERY_CHECKLIST.md` covering operator preflight, backup, restore, post-restore validation, alternate-target drills, incidents, and evidence capture for file/server and exactly the core database scope.
- Linked the compatibility matrix, all core engine/profile runbooks, repository operations, verification, pruning, retention, alternate restore, validation, and audit contracts.
- Recorded special Supabase database-only and ClickHouse external-native-media boundaries plus the disposable real OpenSSH/SFTP release smoke requirement.
- Known limitations remain explicit in each matrix row and runbook; an unsupported capability is not inferred from a successful connection test.
- Completed `CORE-REL-006`. Renderer verification and final resilience/release evidence remain active.

### 2026-08-05 - Complete core renderer gate completed

- Using an isolated Electron `39.8.5` runtime, all 16 required core Electron workflows passed as separate processes; all four core-scope contracts also passed separately.
- Five screenshot harnesses now clear and assert against a stale setup-error toast so visual captures cannot pass while content is obscured.
- Dedicated Backup Manager navigation now proves both desktop and exact 390x844 behavior: the module is visible, Settings is hidden, the Settings Backup & Restore panel is not rendered, Overview is active, and the view has no horizontal overflow.
- File/server, repository, job, recovery, pruning, and all core database workflows passed their existing desktop/mobile containment assertions; repaired captures were manually inspected.
- Completed `CORE-REL-005` with no Electron 39 compatibility, containment, overflow, or routing regression.

### 2026-08-05 - Core resilience and dependency security gate completed

- The exact 19-file core resilience suite passed 132/132 tests in 15.4 seconds with zero failures, cancellations, skips, or todos.
- Added and passed a ransomware-style mass-change regression: an authenticated clean RecoveryPoint remained immutable after source deletion, `.locked` renames, and content replacement, and all 12 original files restored byte-for-byte.
- `package.json` and `package-lock.json` now resolve Electron `39.8.5`, `electron-updater` `6.8.9`, DOMPurify `3.4.13`, and js-yaml `4.3.0`; DOMPurify and js-yaml are enforced through package overrides.
- Full and production lockfile audits both returned zero vulnerabilities.
- The primary workspace still has Electron `30.5.1` installed because live DeployerX/Electron processes held the runtime open during replacement (`EBUSY`). Those processes were not terminated; the isolated Electron 39 validation covers compatibility until the normal workspace install can be refreshed.
- A real portable OpenSSH `10.0p2` smoke passed `hardlink`, `fsync`, and `posix-rename` extension negotiation; missing-hardlink fail-closed behavior; wrong-pin rejection before SecretRef resolution; correct pinned-key authentication; remote fsync/hardlink/rename semantics; immutable commit/readback; and real `ECONNRESET` induction. At the time of this entry, abrupt-loss reconciliation and repository lease takeover remained unproven; the later hardened rerun is recorded below.
- At the time of this entry, `CORE-REL-007` remained pending on the workspace dependency refresh and the disposable real OpenSSH/SFTP release smoke. The later entries below supersede that transient status; no work is planned for any unlisted database.

### 2026-08-05 - SFTP abrupt-loss hardening and fresh-worker reconciliation added

- SFTP repository operations now reject pending calls on transport `error`, `close`, `end`, `exit`, and `timeout` events, poison a timed-out session so cleanup cannot stack unbounded waits, and retain the bounded operation deadline.
- SFTP lock publication treats OpenSSH `SSH_FX_FAILURE` status `4` for an existing canonical lock target as contention in the narrow publication path, then follows the normal expired-lease takeover and ownership-fencing rules. Invalid or ambiguous records remain fail-closed.
- Startup now invokes the SFTP repository service reconciliation for current-device repositories. It acquires the same mutation scope as backup workers, skips live owners, removes only aged generated staging files, releases the lease, and returns bounded sanitized evidence. Each newly acquired SFTP backup lease also reconciles its repository before writing.
- Fresh-worker tests prove orphan staging removal after the original worker remains pending, preserve young/non-generated entries, refuse foreign lease renewal, and retry safely. Focused SFTP plus repository-engine verification is currently `27/27`; manual backup is `14/14`; core scope contracts are `4/4`; and main registration contracts are `13/13`.
- At the time of this entry, the disposable real OpenSSH/SFTP rerun was in progress against the hardened implementation. The later entry records its completion; the physical Electron workspace refresh remains the sole open gate.
- The disposable real OpenSSH/SFTP rerun then passed all 12 release checks on loopback port `64041` and was fully cleaned up. `CORE-REL-007` now remains open only for the physical Electron workspace dependency refresh; no additional database work is authorized or planned.

### 2026-08-05 - Release tracker clarified for the mainstream core scope

- Reconfirmed that the complete active scope is file/server plus MySQL, MariaDB, PostgreSQL, Supabase (constrained PostgreSQL profile), SQLite, MongoDB, Redis, and ClickHouse.
- Reconfirmed that Cassandra, CockroachDB, InfluxDB, Neo4j, and every other unlisted or specialist database are outside this release and must not create new work items.
- Recorded the only remaining gate as blocked on the primary workspace dependency refresh: 18 live Electron processes still use the physical Electron `30.5.1` installation while the manifest and lockfile target `39.8.5`.
- The isolated Electron `39.8.5` workflows, focused service/security checks, and real OpenSSH/SFTP smoke are already complete. No development server or build command was run.
- Final non-Electron verification in this workspace: standalone SFTP `16/16`; repository engine, manual backup, SSH connection, file restore, and repository-lock checks `50/50`; core scope contracts `4/4`; modified JavaScript syntax and `git diff --check` clean.
- `npm ls electron --depth=0` remains intentionally invalid until the live processes are closed: declared `39.8.5`, lockfile `39.8.5`, physical installation `30.5.1`.

### 2026-08-05 - Step-by-step operational task list created

- Added `BACKUP_MANAGER_TASK_LIST.md` as the concise module queue for completed, current, blocked, and next work.
- Kept this file as the detailed evidence authority and linked both documents to prevent the operational view from replacing acceptance evidence.
- The current task remains the physical Electron dependency refresh. No removed database family was reopened.
- Relabeled historical progress-log task pointers so they cannot be mistaken for the current operational task.

### 2026-08-05 - Physical dependency blocker rechecked

- Rechecked the exact workspace Electron executable and found the same 18 live processes using `node_modules/electron/dist/electron.exe`.
- Reconfirmed manifest and lockfile Electron `39.8.5` versus the physical installed Electron `30.5.1`.
- The normal dependency refresh remains blocked until those user-owned processes are closed. No process was terminated and no install, development server, build, or packaging command was run.

### 2026-08-05 - Documentation index completed

- Added `README.md` as the folder-level entry point for current status, detailed delivery evidence, compatibility boundaries, recovery procedures, active runbooks, shared contracts, and historical records.
- Documented the update protocol that keeps in-progress, completed, blocked, and next work explicit across turns.
- Verification: all 41 local links resolve and the three current documentation files have no trailing whitespace.

### 2026-08-05 - Documentation tracking objective audited

- Audited the module documentation folder, operational task list, ordered work sections, status model, dated progress history, update protocol, and resumption guidance against the original request.
- Added a requirement-to-evidence table to `BACKUP_MANAGER_TASK_LIST.md` and completed `BM-DOC-004` only after every documentation requirement was directly proven.
- All 41 documentation-index links resolve. The documentation goal is complete while `BM-REL-001` and `CORE-REL-007` remain explicitly blocked on the separate physical Electron refresh.

### 2026-08-06 - Electron 43 dependency refresh started

- The user authorized the Electron update through npm.
- Confirmed the current npm registry release is Electron `43.3.0`; this supersedes the earlier `39.8.5` target.
- Started the manifest/lockfile and isolated-runtime phase. Physical workspace replacement remains fenced by the same 18 live workspace Electron processes using `30.5.1`; no process was terminated.

### 2026-08-06 - Electron 43 metadata and initial compatibility gates passed

- Updated and exactly pinned `package.json` and `package-lock.json` to Electron `43.3.0` through npm; the metadata install reported zero vulnerabilities.
- Installed and launched a disposable official Electron `43.3.0` binary without modifying the live workspace runtime.
- The control-database, OS-backed secret-storage, encrypted repository-engine, and dedicated Backup Manager navigation gates all exited successfully under Electron 43.
- Desktop and 390 x 844 mobile navigation evidence remained contained and routed to the dedicated Backup Manager module. Broader isolated workflow verification remains active.

### 2026-08-06 - Electron 43 isolated release matrix completed

- Electron `43.3.0` passed `4/4` direct runtime gates, `10/10` shared module renderer workflows, `8/8` mainstream database/profile renderer workflows, and `70/70` focused SFTP, repository, backup, SSH, restore, lock, and core-scope checks.
- Repaired stale Activity and Notifications Electron selectors so they measure rendered rows and the current Settings notification surface.
- Fixed the mobile `.app-shell.sidebar-collapsed` grid override that collapsed the workspace to zero width. The corrected 390 px Notifications page and modal are contained without horizontal document overflow.
- The authorized normal `npm install` then failed atomically with `EBUSY` on the live Electron `icudtl.dat`. Manifest and lockfile remain exactly `43.3.0`, the intact physical runtime remains `30.5.1`, and no npm staging directory remains.
- The metadata install reported zero vulnerabilities; subsequent explicit full and production audit retries hit `ENOTFOUND registry.npmjs.org` and remain part of the post-install gate.
- `CORE-REL-007` is now blocked only on closing the 18 workspace Electron processes, completing the physical install, and rerunning the final physical-runtime and audit checks.
