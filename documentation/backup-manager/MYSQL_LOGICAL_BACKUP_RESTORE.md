# MySQL Logical Backup and Restore

## Scope

BM-302 adds a concrete MySQL 8 logical adapter to Backup Manager. It protects selected user databases with `mysqldump`, stores the authenticated dump in one or more encrypted DeployerX repositories, and can stream a RecoveryPoint back through the `mysql` client to the original server.

This release supports:

- MySQL Community or compatible MySQL Server versions `>=8.0.0 <9.0.0`;
- explicit user-database selection or explicit table/view selection within one database;
- application-consistent full logical backups when every selected base table is InnoDB;
- opt-in full-anchor coordinate capture and incremental binary-log protection for exactly one whole database;
- routines, events, triggers, views, schema, and table data included by `mysqldump`;
- one dump reused byte-for-byte across every repository copy;
- restore to the original server, an alternate tested server, or one new database;
- point-in-time recovery to a UTC timestamp or authenticated native file position;
- per-database connectivity, authenticated expected-object, and native `CHECK TABLE QUICK` validation after restore;
- local, SFTP, and S3-backed DeployerX repositories through the existing repository engine.

The logical workflow does not execute differential or physical backup, schema/global-object selection, object exclusion rules, multi-database PITR, partial-object PITR, account migration, or row-level application checksum validation. Binary-log protection is bounded by `MYSQL_MARIADB_POINT_IN_TIME_RECOVERY.md`; the same MySQL Source family delegates whole-instance MySQL 8.4 physical execution to the separate `MYSQL_PHYSICAL_BACKUP_RESTORE.md` contract.

## Native Prerequisites

The worker device that owns the connection must have MySQL 8 versions of both tools available:

- `mysql` for connection tests, discovery, preflight queries, restore, and connectivity validation;
- `mysqldump` for logical backup.
- `mysqlbinlog` for PITR-enabled anchor preflight, raw binary-log capture, and replay.

Both executables must report a supported 8.x version during runtime preflight. The adapter invokes executables directly with argument arrays and `shell: false`.

The backup account requires the effective grants:

- `SELECT`;
- `SHOW VIEW`;
- `TRIGGER`;
- `EVENT`.

The account must also be able to connect under the configured TLS policy. DeployerX supports `verify-identity`, `required`, `preferred`, and `disabled`; the UI defaults to identity verification.

## Credential Boundary

The renderer sends a password only during connection creation. The main process encrypts it in the device-scoped SecretRef store and persists only the SecretRef ID in the control database.

Before a native call, the adapter creates a permission-restricted run directory and a `client.cnf` supplied through `--defaults-extra-file`. The password is never placed in:

- process arguments;
- process environment variables;
- persisted connection records;
- adapter plans;
- RecoveryPoint metadata;
- Artifact metadata;
- renderer responses;
- logs or public errors.

The temporary option file and directory are removed after the command succeeds or fails.

## Connection and Source Workflow

The Sources tab provides a MySQL connection flow:

1. Enter connection name, host, port, TLS policy, username, and password.
2. Test the connection. A successful test records MySQL version, latency, TLS outcome, and a stable server identity fingerprint derived from host, port, and `@@server_uuid`.
3. Discover databases with `SHOW DATABASES`.
4. Exclude `information_schema`, `mysql`, `performance_schema`, and `sys` by default.
5. Choose entire-database protection, or choose exactly one database and discover its tables and views.
6. Optionally enable point-in-time recovery for exactly one entire database.
7. Select the databases or objects and save a Database Source.

Object discovery reads `information_schema.tables`, returns tables and views in canonical order, and refuses more than 10,000 objects. A partial Source must contain explicit includes and cannot use all-database or object-exclusion rules. MySQL represents its schema boundary as the selected database, so separate schema selection is not advertised.

The Source records application-consistency intent and full logical mode. PITR opt-in additionally records `captureCoordinates: true`; only that one-whole-database Source can be assigned incremental mode. It does not claim consistency or log recoverability until runtime preflight.

## Runtime Preflight

Every run revalidates current state before dump planning:

- the connection belongs to the current device;
- the last connection test succeeded;
- the current server identity matches the pinned connection identity;
- the server and both native tools are supported MySQL 8.x versions;
- all required grants are present;
- all selected base tables use InnoDB;
- server character set and collation are captured;
- the normalized selector and immutable plan digest still match the Source and Job snapshots.

PITR-enabled runs also prove binary logging, `ROW` format, full row images, compatible `mysqlbinlog`, snapshot-coordinate capture, and required replication-monitoring/read privileges. Incremental runs authenticate the preceding coordinate and complete log inventory before download.

Any failed proof stops the run before dump bytes are produced. A selected non-InnoDB table prevents an application-consistent RecoveryPoint rather than silently downgrading consistency.

## Dump Execution

The logical plan uses these safety and completeness options:

```text
--single-transaction
--quick
--skip-lock-tables
--routines
--events
--triggers
--hex-blob
--no-tablespaces
--set-gtid-purged=OFF
--column-statistics=0
--default-character-set=utf8mb4
--max-allowed-packet=1073741824
--net-buffer-length=16384
```

PITR-enabled full anchors additionally use `--source-data=2`; DeployerX parses and authenticates the generated coordinate before publication.

Selected database names are normalized identifiers passed as separate native arguments. They are never interpreted as shell text.

For table/view Sources, `mysqldump` receives the single database followed by the selected object names as positional arguments. The adapter retains `--triggers` but adds `--skip-routines` and `--skip-events`; database-level routines and events cannot be safely attributed to the selected tables. Dependencies outside the selected set are not added automatically, and the warning is recorded in preflight evidence. Whole-database Sources retain `--routines`, `--events`, and `--databases` or `--all-databases` behavior.

The source reader streams `mysqldump` once into a permission-restricted run directory. Repository writes consume the same completed file, which guarantees identical plaintext dump bytes for the primary and every copy destination. The dump is not regenerated per repository.

Database backup execution is intentionally not resumable. If any repository copy is incomplete or the process stops before publication, retry starts a fresh dump and no partial output is represented as a RecoveryPoint.

## RecoveryPoint and Artifact Records

A successful run publishes one full, application-consistent RecoveryPoint. Each available repository copy has:

- an authenticated encrypted manifest Artifact;
- a `database-dump` Artifact for `mysql/logical-dump.sql`;
- dump size and SHA-256 content digest;
- adapter ID and version;
- server version and identity fingerprint;
- selected database digest and summary;
- selection mode plus selected database and table/view identifiers;
- bounded expected databases, tables/views, routines, triggers, and events for native restore validation;
- requested and achieved consistency;
- tool, privilege, charset, and collation evidence.

Temporary dump data is removed after all repository operations finish.

An incremental PITR run publishes encrypted `transaction-log` Artifacts and a parent-linked `log` RecoveryPoint. Its durable coordinate summary identifies the full anchor, previous point, exact start/end coordinate, and recoverable window without exposing repository locators. A no-change interval succeeds without publishing an empty point.

## Restore Targets

The Recovery tab identifies MySQL RecoveryPoints separately from file snapshots. Adapter `1.3.0` supports the pinned original server, a different tested MySQL server with preserved database names, and one absent new database name on any tested MySQL connection. Every mode requires both an in-app confirmation and its matching main-process token; renderer input alone cannot reuse another mode's confirmation.

Before modification, restore verifies:

- the point is a full application-consistent MySQL logical backup;
- at least one available repository copy contains a matching `database-dump` Artifact;
- the authenticated manifest path, size, and content digest match the Artifact record;
- the selected connection is healthy, belongs to the current device, and is MySQL 8.x;
- original mode matches the captured server identity;
- alternate mode uses a different verified identity, has broad logical restore privileges, and either has no expected database collision or has explicit overwrite approval;
- new-database mode has exactly one protected source database and the requested target name is absent.

The repository engine authenticates and decrypts chunks while streaming the dump directly to `mysql` standard input. DeployerX does not write a plaintext restore copy outside the repository stream. Original and alternate whole-database dumps retain their database create/use statements. New-database mode safely remaps database create/use and qualified database identifiers without changing strings, comments, or same-named objects, and releases no bytes before generated controls are proven. A table/view dump is restored with the selected target database supplied explicitly to `mysql`; an absent partial target is created during preflight.

After native restore succeeds, the adapter connects to every expected database, compares the current `information_schema` inventory with the authenticated backup inventory, and runs bounded `CHECK TABLE ... QUICK` batches for every expected table and view. Complete positive evidence finishes the RestoreRun as `succeeded`; missing objects, type changes, or native errors fail the run and retain validation evidence. Recovery points created before adapter `1.2.0` lack an authenticated inventory and finish with a compatibility warning after connectivity passes.

Interrupted non-terminal MySQL RestoreRuns are reconciled to a durable failed state at startup. File and MySQL restore reconciliation are isolated even though both record types share the RestoreRun table.

## Main and Preload APIs

Connection and discovery:

- `backup:connections:mysql:list`
- `backup:connections:mysql:create`
- `backup:connections:mysql:test`
- `backup:connections:mysql:discover`

Database Sources use the general database-source APIs. Original, alternate, and new-database restore use:

- `backup:mysql-restores:list`
- `backup:mysql-restores:start`
- `backup:mysql-restores:wait`

Point-in-time recovery uses:

- `backup:mysql-pitr:list`
- `backup:mysql-pitr:start`
- `backup:mysql-pitr:wait`

All mutations use the Backup Manager audit wrapper. Workspace and actor identity remain main-process owned.

## Deferred Work

- One-to-many database mapping and account/grant migration remain outside logical restore scope.
- Whole-instance MySQL 8.4 physical backup and recovery are implemented separately under BM-402 and `MYSQL_PHYSICAL_BACKUP_RESTORE.md`.
- Replica-aware capture and delayed-replica strategies remain future work.
