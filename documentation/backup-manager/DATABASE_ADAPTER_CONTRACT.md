# Database Adapter Contract and Consistency Safeguards

## Purpose

This contract is the executable boundary between Backup Manager orchestration and database-specific tools. It applies to logical dumps, physical backups, transaction-log capture, point-in-time recovery, and native restore validation.

The contract prevents a generic file copy of live database files from being represented as a database backup. A database recovery point may be committed only after the selected adapter proves the requested consistency with current runtime evidence.

The implementation is in `src/backup-manager/database-adapter.js`. Workspace-scoped source persistence is in `src/backup-manager/database-source.js`. Concrete logical implementations are documented in `MYSQL_LOGICAL_BACKUP_RESTORE.md`, `MARIADB_LOGICAL_BACKUP_RESTORE.md`, and `POSTGRESQL_LOGICAL_BACKUP_RESTORE.md`; physical execution is documented in `MYSQL_PHYSICAL_BACKUP_RESTORE.md`, `POSTGRESQL_BASE_BACKUP_WAL_PITR.md`, `SQL_SERVER_BACKUP_RESTORE.md`, and the active `ORACLE_RMAN_BACKUP_RESTORE.md` contract. Shared object-selection and partial-restore rules are documented in `DATABASE_OBJECT_SELECTION.md`; native post-restore evidence is defined in `DATABASE_RESTORE_VALIDATION.md`; MySQL/MariaDB transaction-log capture and replay are defined in `MYSQL_MARIADB_POINT_IN_TIME_RECOVERY.md`.

## Scope of BM-301

BM-301 provides:

- adapter identity, API compatibility, capability, tool, and privilege validation;
- an adapter registry with duplicate-ID refusal;
- normalized database, schema, table, and global-object selection;
- runtime preflight evidence normalization;
- a fail-closed consistency resolver;
- immutable, digest-bound backup plans;
- SecretRef-only credential enforcement and redacted endpoint projection;
- workspace-scoped database Source persistence with optimistic revisions;
- audited main/preload APIs for adapter discovery and Source mutations.

BM-301 does not execute a database-native utility. MySQL, MariaDB, PostgreSQL, physical backup, transaction-log, and other concrete implementations belong to their tasks in `TASKS.md`.

## Adapter Interface

Every registered adapter implements all of these operations:

```js
manifest()
testConnection(context, request)
discover(context, request)
preflight(context, request)
planBackup(context, request)
executeBackup(context, plan, sink)
planRestore(context, request)
executeRestore(context, plan, source)
validateRestore(context, result)
```

`apiVersion` is currently `1`. Adapter IDs use the stable `deployerx.database.<engine>.<method>` namespace and adapter versions use semantic versioning. Duplicate IDs and incompatible API versions are rejected at registration.

The adapter owns engine-specific commands, identifier quoting, version parsing, consistency primitives, native output parsing, and restore validation. The registry owns cross-engine safety invariants and refuses incomplete adapters.

## Capability Manifest

Capabilities describe verified behavior, not planned behavior. An adapter declares:

- engine and supported server/restore version ranges;
- logical and physical backup methods independently;
- full, incremental, differential, and native modes that are actually implemented;
- database, schema, table, and global-object selection support;
- consistency strategies and the result each strategy produces;
- lock scope, downtime, and transaction-coordinate behavior;
- transaction-log type, PITR support, and recovery granularity;
- backup/restore streaming, compression, and encryption behavior;
- replica awareness, alternate-target restore, and native restore validation;
- required native tools with version ranges and operation scope;
- required and optional privileges with safe operator-facing descriptions.

The UI must render options from this manifest. It must not infer support from an adapter ID or database engine name.

## Database Selection

Selectors use `kind: database-objects` and include a SHA-256 digest. The normalized selector contains:

```js
{
  version: 1,
  kind: 'database-objects',
  allDatabases: false,
  databases: { include: [{ name }], exclude: [{ name }] },
  schemas: { include: [{ database, name }], exclude: [{ database, name }] },
  tables: { include: [{ database, schema, name }], exclude: [{ database, schema, name }] },
  includeGlobalObjects: false,
  digest: '<sha256>'
}
```

Selection is explicit: at least one database is required unless `allDatabases` is explicitly true. Entries are bounded, deduplicated, sorted, and checked for include/exclude conflicts. Schema, table, and global-object rules are rejected when the adapter does not advertise them.

Schema and table rules must reference a database in `databases.include`. They cannot be attached to `allDatabases`, because that would leave their scope ambiguous. Concrete logical adapters may impose stricter native-tool rules. The current adapters require exactly one included database for any schema/table Source, reject object exclusion rules, and fail closed when selector levels cannot be combined safely.

Selectors contain identifiers, never SQL fragments or native command arguments. Concrete adapters must pass normalized identifiers to native tools as separate arguments and apply engine-specific exact quoting where required. Discovery is a read-only convenience and never grants authority to protect an undiscovered or inaccessible object; runtime preflight remains authoritative.

## Consistency Request

A request records:

- requested consistency: `application`, `crash`, `filesystem`, or `unknown`;
- strategy: a named method or `auto`;
- backup method and mode;
- whether transaction coordinates are required;
- whether an explicitly configured policy permits a weaker result.

The default is application-consistent, logical, full backup with no downgrade permission. Saving a Source records intent only. It does not claim that consistency has been achieved.

## Runtime Preflight

Preflight is adapter-owned, read-only, and runs immediately before planning. Evidence includes:

- check timestamp;
- server version and a positive compatibility result;
- stable server identity fingerprint;
- each available consistency method and the result it can prove now;
- native-tool name, version compatibility, and executable fingerprint;
- required privilege checks and bounded evidence;
- transaction-coordinate capture availability;
- bounded warnings.

The main process or worker supplies credentials through SecretRef resolution. Renderer data cannot assert successful preflight.

## Fail-Closed Resolution

The registry produces a consistency plan only when all of these are true:

1. The adapter and API versions are registered and compatible.
2. The server version is currently supported.
3. The requested backup method and mode are declared.
4. The selected consistency strategy is declared for that method.
5. Runtime evidence independently verifies the same strategy and result.
6. Every required backup tool is present and version-compatible.
7. Every required backup privilege has positive evidence.
8. Requested transaction coordinates can be captured by both the declared strategy and runtime probe.
9. The achieved consistency exactly matches the request, unless policy explicitly permits a weaker result.

Missing, stale, contradictory, or negative evidence refuses planning. A native tool's zero exit code alone is not consistency evidence.

When downgrade is allowed, the resolver chooses only a proven weaker level and records both requested and achieved levels. The RecoveryPoint must use the achieved level, and warnings must remain visible in run and recovery history.

## Immutable Plan

After successful preflight, the registry calls the adapter's read-only `planBackup` and creates an immutable plan containing:

- exact adapter ID/version and engine;
- normalized selector and selection digest;
- proven consistency plan and bounded evidence;
- adapter-specific plan data;
- canonical SHA-256 plan digest.

Execution must reject changes to the adapter version, source selection, connection identity, consistency evidence, or plan digest. A checkpoint must bind to this digest.

## Credentials and Endpoint Identity

Plaintext passwords, passphrases, tokens, private keys, connection strings, DSNs, and credential-bearing URLs are rejected recursively. Persisted records may contain only SecretRef IDs for credential values.

Public endpoint projections are allowlisted to host, port, default database, username, TLS mode, and server identity fingerprint. Raw provider responses, commands, environment values, resolved paths to credential files, and secret values never cross IPC.

The server identity fingerprint is part of preflight and plan evidence. Concrete adapters must define how identity is established, including TLS verification rules and SSH host-key pinning when a database tool runs through SSH.

## Native Process Rules

Concrete adapters must:

- invoke allowlisted executables with argument arrays, never concatenated shell commands;
- use a controlled environment and run-scoped working directory;
- bound stdout/stderr and redact structured diagnostics;
- stream artifacts through the repository engine;
- support cancellation and deadlines;
- terminate child processes with a bounded escalation path;
- clean uncommitted temporary data after terminal state;
- capture native tool version and executable fingerprint;
- never interpret user identifiers as command options.

## Artifact and Manifest Requirements

Database execution may emit `database-dump`, `physical-backup`, `transaction-log`, `schema`, `metadata`, and `index` artifacts. A successful database RecoveryPoint manifest records at least:

- adapter ID/version and plan digest;
- database engine and exact server version;
- server identity fingerprint;
- logical or physical method and backup mode;
- requested and achieved consistency;
- consistency strategy, lock scope, and downtime evidence;
- selection digest and selected object summary;
- selection mode and canonical database/schema/table identifiers needed to reproduce the restore scope;
- character set, encoding, collation, and locale where applicable;
- transaction coordinates and timeline/log identity where applicable;
- native tool name/version/fingerprint;
- artifact checksums, sizes, ordering, and chain parents;
- warnings, excluded global objects, and reduced capabilities.

The repository commit occurs only after the adapter returns complete consistency and artifact evidence. Partial native output is not a RecoveryPoint.

## Restore Safeguards

Restore planning must refuse incomplete chains, unsupported source-to-target versions, target conflicts, missing native tools, missing keys, and insufficient destination privileges before modification. Restore execution must use an explicit original, alternate, or new-database target and must not silently overwrite an existing database. Original restore is an explicit destructive exception. Alternate restore stops on expected database collisions by default and requires separate overwrite confirmation. New-database restore always requires an absent name and exactly one protected source database. Whole-database name remapping must parse only native database-identity positions and release no bytes until generated create/connect controls are positively mapped; partial schema/table points bind the native client directly to the selected target database.

Validation uses engine-native checks plus connectivity and authenticated expected-object evidence. Process exit status alone is insufficient. MySQL/MariaDB `1.2.0+` use per-database connectivity, inventory comparison, and `CHECK TABLE QUICK`; PostgreSQL `1.2.0+` uses per-database connectivity plus catalog, relation/definition, and index-validity checks. Adapter `1.3.0` maps this evidence to alternate and new-database targets. MySQL/MariaDB `1.4.0` adds authenticated full-anchor coordinates, raw transaction-log capture, and bounded native replay. PostgreSQL `1.4.0` adds whole-cluster `pg_basebackup`, archived-WAL chains, `pg_verifybackup`/`pg_waldump` validation, and bounded PITR with service, promotion, system-identifier, timeline, and final-LSN evidence. SQL Server native `1.0.0` adds checksum-bearing full/differential/log media, authenticated database/backup/family/fork identity, restore-time tail capture, `HEADERONLY`/`FILELISTONLY`/`VERIFYONLY`, ordered `NORECOVERY`/`RECOVERY`, online/connectivity evidence, and optional identifier-safe `DBCC CHECKDB ... PHYSICAL_ONLY`.

## Main and Preload APIs

The main process exposes:

- `backup:database-adapters:list`
- `backup:database-sources:list`
- `backup:database-sources:save`
- `backup:database-sources:delete`

Concrete connection discovery APIs accept adapter-owned `kind`, `database`, and `schema` fields for bounded hierarchy discovery. Unsupported kinds fail closed.

Workspace and actor identity remain main-process owned. Source create, update, and delete use the existing audited mutation wrapper. Updates and deletes require optimistic revisions.

BM-301 registers no concrete adapter by itself. BM-302 registers `deployerx.database.mysql.logical` and adds its connection, discovery, execution, and original-server restore APIs. Other engines remain unavailable until their own adapter tasks are completed.

## Required Conformance Tests for Every Engine Adapter

An engine adapter is not releasable until tests prove:

- supported and unsupported server/tool version behavior;
- minimum privilege success and each required privilege failure;
- authentication failure without secret leakage;
- selection at every advertised object level;
- application-consistent backup during concurrent writes;
- lock acquisition, timeout, and cleanup behavior;
- coordinate capture and PITR boundaries when advertised;
- cancellation and native-process termination;
- repository interruption without a false RecoveryPoint;
- restore to a clean alternate target;
- native validation and deliberate corruption detection;
- encoding, collation, global-object, and large-object handling;
- downgrade refusal and explicit downgrade recording;
- source-newer-than-target and target-newer-than-source compatibility behavior.

Passing unit mocks is not enough. Each advertised mode requires an integration recovery test against supported database versions.
