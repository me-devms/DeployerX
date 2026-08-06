# MariaDB Logical Backup and Restore

## Scope

BM-303 adds a distinct MariaDB logical adapter to Backup Manager. It protects selected user databases with `mariadb-dump`, stores one authenticated dump in each configured encrypted repository, and restores a RecoveryPoint through the `mariadb` client to the original server.

Supported in this release:

- MariaDB Server versions `>=10.6.0 <12.0.0`;
- explicit user-database selection or explicit table/view selection within one database;
- application-consistent full logical backups when every selected base table is InnoDB;
- opt-in full-anchor coordinate capture and incremental binary-log protection for exactly one whole database;
- schema, data, views, routines, events, and triggers;
- one completed dump reused byte-for-byte across repository copies;
- original, alternate-server, and single-new-database restore;
- point-in-time recovery to a UTC timestamp or authenticated native file position;
- per-database connectivity, authenticated expected-object, and native `CHECK TABLE QUICK` validation;
- local, SFTP, and S3 DeployerX repositories.

Differential and physical backup, schema/global-object selection, object exclusion rules, multi-database or partial-object PITR, account migration, and row-level application checksum validation are not advertised. Binary-log protection is bounded by `MYSQL_MARIADB_POINT_IN_TIME_RECOVERY.md`.

## Native Prerequisites

The worker device that owns the connection must have compatible MariaDB client tools available:

- `mariadb` for connection tests, discovery, preflight, restore, and connectivity validation;
- `mariadb-dump` for logical backup.
- `mariadb-binlog` for PITR-enabled anchor preflight, raw binary-log capture, and replay.

Version detection requires the native output to contain a MariaDB distribution token such as `Distrib 10.11.6-MariaDB`. The client protocol version commonly shown as `Ver 15.1` is deliberately ignored. MySQL client output and MariaDB versions before 10.6 or at/after 12.0 are rejected.

The backup account requires effective `SELECT`, `SHOW VIEW`, `TRIGGER`, and `EVENT` grants for the selected databases.

## Credential and TLS Boundary

The renderer sends a password only while creating a connection. The main process encrypts it in the device-scoped SecretRef store and persists only the SecretRef ID in the control database.

Each native operation resolves the secret into a permission-restricted temporary `client.cnf` referenced by `--defaults-extra-file`. Passwords are excluded from process arguments, environment variables, adapter plans, database records, manifests, renderer responses, logs, and public errors. The option file and containing directory are removed after success or failure.

MariaDB option-file semantics are kept separate from MySQL:

- `disabled` writes `skip-ssl`;
- `preferred` does not force an SSL option;
- `required` writes `ssl`;
- `verify-ca` and `verify-identity` write `ssl` and `ssl-verify-server-cert`.

The adapter never writes MySQL's `ssl-mode=` setting into a MariaDB option file.

## Connection and Source Workflow

The Sources tab provides a MariaDB flow alongside local, SSH, and MySQL sources:

1. Enter name, host, port, TLS policy, username, and password.
2. Test the connection and record version, latency, TLS outcome, and server identity.
3. Discover databases with `SHOW DATABASES`.
4. Exclude `information_schema`, `mysql`, `performance_schema`, and `sys` by default.
5. Choose entire-database protection, or choose exactly one database and discover its tables and views.
6. Optionally enable point-in-time recovery for exactly one entire database.
7. Select the databases or objects and save a Database Source.

Object discovery reads `information_schema.tables`, returns tables and views in canonical order, and refuses more than 10,000 objects. A partial Source cannot use all-database or object-exclusion rules. MariaDB schemas are represented by their selected database, so the adapter does not advertise a separate schema selector.

The server identity fingerprint is derived from the normalized endpoint plus MariaDB `@@server_id` and `@@hostname`. A runtime identity change stops backup before dump bytes are produced.

## Runtime Consistency Proof

Every run revalidates:

- current-device ownership and last successful connection test;
- pinned server identity;
- supported server, `mariadb`, and `mariadb-dump` versions;
- required logical-backup grants;
- InnoDB use by every selected base table;
- server character set and collation;
- normalized selector and immutable plan data.

`--single-transaction` proves application consistency only for InnoDB tables. Any selected non-InnoDB base table fails the consistency proof; DeployerX does not silently publish a weaker RecoveryPoint.

PITR-enabled runs additionally require binary logging in `ROW` format with full row images, a compatible `mariadb-binlog`, snapshot-coordinate capture, and the engine-specific monitoring/read privileges. Incremental mode is available only to the opted-in one-whole-database Source.

## Dump Execution

The MariaDB dump plan uses:

```text
--single-transaction
--quick
--skip-lock-tables
--routines
--events
--triggers
--hex-blob
--default-character-set=utf8mb4
--max-allowed-packet=1073741824
--net-buffer-length=16384
```

It deliberately omits MySQL-specific `--set-gtid-purged=OFF`, `--column-statistics=0`, and `--no-tablespaces` flags. Selected database names are passed as separate native arguments with no shell interpretation.

PITR-enabled full anchors add `--master-data=2`; the coordinate emitted in the bounded dump header is authenticated before publication.

For table/view Sources, `mariadb-dump` receives the single database followed by exact selected object names. It retains triggers but adds `--skip-routines` and `--skip-events`, because those database-level objects cannot be scoped to the selected tables. Dependencies outside the selection are not added automatically. Whole-database Sources retain routines, events, and `--databases` or `--all-databases` behavior.

The source reader spools one permission-restricted `mariadb/logical-dump.sql` per run and feeds those identical bytes to every repository. Logical database execution is not resumable; an interrupted attempt starts a new dump and cannot publish partial output as a RecoveryPoint.

## Recovery and Restore

Successful execution publishes a full, application-consistent RecoveryPoint with a `database-dump` Artifact. The authenticated metadata includes adapter/version, selector digest, selection mode, selected databases and table/view identifiers, bounded expected tables/views, routines, triggers and events, consistency evidence, native tool versions, server version and fingerprint, character set, collation, `server_id`, and hostname.

Adapter `1.3.0` supports the pinned original MariaDB server, a different tested server with preserved database names, and one absent new database name on any tested MariaDB connection. Before sending data, it verifies:

- a mode-specific in-app confirmation and matching main-process confirmation token;
- MariaDB adapter ownership and application consistency;
- an available repository copy and matching database-dump Artifact;
- authenticated manifest path, size, and digest;
- a healthy current-device MariaDB 10.6-11.x connection;
- original mode equality between current and captured server identity;
- alternate mode uses a different verified identity, has broad logical restore privileges, and passes explicit collision policy;
- new-database mode has one protected source database and an absent target name.

The repository decrypts and authenticates chunks while streaming them directly into `mariadb` standard input. Original and alternate whole-database restores preserve the generated database names. New-database mode maps database create/use and qualified database identifiers without changing strings, comments, or same-named objects, and releases no bytes until generated controls are proven. A partial dump binds the client to the selected target database; an absent target is created during preflight. After restore, the adapter validates the original or mapped native inventory and runs bounded `CHECK TABLE ... QUICK` batches for every expected table/view. Complete evidence succeeds; missing/type-changed objects or native errors fail with durable checks. Pre-`1.2.0` recovery points remain connectivity-validated warning restores because they lack authenticated object inventory.

MariaDB reconciliation is isolated from MySQL and file RestoreRuns. An abandoned non-terminal MariaDB restore becomes a durable failed run at startup.

Incremental PITR runs publish encrypted raw `transaction-log` Artifacts and parent-linked `log` RecoveryPoints. Recovery authenticates the full/log chain, restores the logical anchor, replays through `mariadb-binlog` and `mariadb`, and reruns native validation. Unchanged coordinates complete without an empty point.

## Main and Preload APIs

Connection operations:

- `backup:connections:mariadb:list`
- `backup:connections:mariadb:create`
- `backup:connections:mariadb:test`
- `backup:connections:mariadb:discover`

Database Sources use the shared database-source APIs. Original, alternate, and new-database restore use:

- `backup:mariadb-restores:list`
- `backup:mariadb-restores:start`
- `backup:mariadb-restores:wait`

Point-in-time recovery uses:

- `backup:mariadb-pitr:list`
- `backup:mariadb-pitr:start`
- `backup:mariadb-pitr:wait`

All mutations use the Backup Manager audit wrapper. Workspace and actor identity remain main-process owned.

## Deferred Work

- One-to-many database mapping and account/grant migration remain outside logical restore scope.
- MariaDB physical backup through an approved native engine remains future work.
- Replica-aware capture and delayed-replica strategies remain future work.
