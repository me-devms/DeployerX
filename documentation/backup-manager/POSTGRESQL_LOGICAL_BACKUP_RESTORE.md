# PostgreSQL Logical Backup and Restore

## Scope

BM-304 adds the `deployerx.database.postgresql.logical` adapter to Backup Manager. It protects explicitly selected PostgreSQL databases with `pg_dump`, stores one authenticated combined dump in each configured encrypted repository, and restores a RecoveryPoint through `psql` to the original cluster.

Supported in this release:

- PostgreSQL Server versions `>=14.0.0 <19.0.0`;
- explicit database selection, or explicit schema or table/view selection within one database;
- full logical backup using a separate MVCC snapshot for each selected database;
- schema, data, views, materialized views, sequences, functions, procedures, and triggers included by `pg_dump`;
- one completed dump reused byte-for-byte across repository copies;
- original-cluster restore with pinned cluster identity;
- per-database connectivity plus authenticated catalog, object, relation, definition, and index validation;
- local, SFTP, and S3 DeployerX repositories.

Each selected database is application-consistent independently. PostgreSQL does not provide one coordinated logical snapshot across multiple databases, so a multi-database RecoveryPoint is not transactionally consistent across database boundaries. The run records this limitation in its consistency evidence.

This logical path advertises full backups only. Adapter `1.4.0` separately supports whole-cluster physical base backups, archived-WAL incrementals, and PITR under `POSTGRESQL_BASE_BACKUP_WAL_PITR.md`. Differential logical backup, global-object selection, object exclusion rules, optional physical page scans, and row-level application checksum validation remain unsupported.

## Native Prerequisites

The worker device that owns the connection must have compatible PostgreSQL client tools available:

- `psql` for connection tests, discovery, preflight, restore, and connectivity validation;
- `pg_dump` for logical backup.

The server and both client tools must be PostgreSQL major versions 14 through 18. A client major version older than the server major is rejected before backup. Executable configuration accepts only `psql` and `pg_dump`, including explicit paths to those executables.

The backup account requires:

- `CONNECT` on every selected database;
- `USAGE` on every selected non-system schema;
- `SELECT` on every selected table, partitioned table, and materialized view;
- `SELECT` on every selected sequence;
- permission to execute `pg_control_system()` so DeployerX can capture the cluster system identifier.

The configured maintenance database must be connectable and must not be one of the protected databases. It is the restore control connection while the dump drops and recreates protected databases.

## Credential and TLS Boundary

The renderer sends a password only while creating a connection. The main process encrypts it in the device-scoped SecretRef store and persists only the SecretRef ID in the control database.

Each native operation resolves the password into a permission-restricted temporary PostgreSQL passfile. The native process receives only the passfile path in `PGPASSFILE`; the password is excluded from arguments, environment values, plans, database records, manifests, renderer responses, logs, and public errors. Backslashes and colons are escaped according to passfile syntax. Passwords containing CR, LF, or NUL are rejected. The passfile and containing directory are removed after success or failure.

DeployerX maps its TLS policies to libpq `sslmode` values:

| DeployerX policy | libpq value |
| --- | --- |
| `disabled` | `disable` |
| `preferred` | `prefer` |
| `required` | `require` |
| `verify-ca` | `verify-ca` |
| `verify-identity` | `verify-full` |

The mapped value is supplied as `PGSSLMODE`. Database selection is supplied as `PGDATABASE`, and all other connection values are bounded native arguments with no shell interpretation.

## Connection and Source Workflow

The Sources tab provides a PostgreSQL flow alongside local, SSH, MySQL, and MariaDB sources:

1. Enter name, host, port, maintenance database, TLS policy, username, and password.
2. Test the connection and record version, latency, TLS outcome, and cluster identity.
3. Discover connectable non-template databases in canonical order.
4. Exclude `template0`, `template1`, and the configured maintenance database from ordinary selection.
5. Choose entire-database, schema, or table/view protection.
6. For partial protection, select exactly one database and discover its non-system schemas or relations.
7. Select the databases or objects and save a Database Source.

Schema and relation discovery query PostgreSQL catalogs through the selected database, return canonical identifiers, exclude `pg_*` and `information_schema`, and refuse more than 10,000 objects. Table discovery includes ordinary tables, partitioned tables, views, and materialized views. Schema and table rules cannot be combined in one Source because `pg_dump -n` has no effect when `-t` is also present.

The cluster identity fingerprint is derived from the normalized host and port plus `pg_control_system().system_identifier`. A runtime identity change stops backup or restore before dump bytes are processed.

## Runtime Consistency Proof

Every run revalidates:

- current-device ownership and last successful connection test;
- pinned cluster identity;
- supported server, `psql`, and `pg_dump` versions;
- client/server major-version compatibility;
- required database, schema, relation, sequence, and identity privileges;
- server encoding, collation, and character classification;
- an unprotected maintenance database;
- normalized selector and immutable plan data.

`pg_dump` creates a consistent MVCC snapshot for one database without blocking normal readers and writers. Selected databases are dumped sequentially in canonical order. DeployerX fails before publication if it cannot prove the requested application consistency or any selected database lacks required access.

## Dump Execution

Whole-database Sources dump each selected database with:

```text
--format=plain
--create
--clean
--if-exists
--no-owner
--no-privileges
--encoding=UTF8
--no-password
```

Plain SQL is required for the current streamed original-cluster restore path. `--create`, `--clean`, and `--if-exists` make database replacement explicit. Ownership and grants are not replayed in this release, avoiding dependency on source-cluster roles that are outside the selected database scope.

Schema Sources omit `--create` and add one exact quoted `--schema=` pattern per selected schema. Table/view Sources omit `--create` and add one exact quoted `--table=` pattern per selected relation. Both retain `--clean` and `--if-exists`, and both target exactly one existing database. PostgreSQL table selection does not automatically include dependent objects such as sequences or functions outside the selected relations; preflight and recovery metadata preserve that warning. Object exclusion rules are refused rather than translated into broader native patterns.

The adapter concatenates the selected database dumps into one permission-restricted `postgresql/logical-dump.sql` in canonical database order. The source reader produces that file once per run and feeds identical bytes to every repository. Logical execution is not resumable; an interrupted attempt starts a new dump and cannot publish partial output as a RecoveryPoint.

## Recovery and Restore

Successful execution publishes a full, application-consistent RecoveryPoint with one `database-dump` Artifact. Authenticated metadata includes adapter and version, selector digest, selection mode, selected databases, schemas and tables/views, bounded expected schemas/relations/indexes/triggers/routines, consistency evidence and warning, native tool versions, server version and cluster fingerprint, encoding, collation, and character classification.

Adapter `1.3.0` supports the pinned original PostgreSQL cluster, a different tested cluster with preserved database names, and one absent new database name on any tested PostgreSQL connection. Before sending data, it verifies:

- explicit in-app destructive confirmation and the main-process confirmation token;
- PostgreSQL adapter ownership and application consistency;
- an available repository copy and matching database-dump Artifact;
- authenticated manifest path, size, and digest;
- a healthy current-device PostgreSQL 14-18 connection;
- original mode equality between the current and captured cluster identity;
- alternate mode uses a different cluster identity, passes collision policy, and has `CREATEDB` or superuser capability plus required object ownership/DDL rights;
- new-database mode has exactly one protected source database and an absent target name;
- a maintenance database that is not protected by the dump.

The repository decrypts and authenticates chunks while streaming SQL directly into `psql` standard input. Original and alternate whole-database recovery connect to the maintenance database and preserve protected database names. New-database recovery maps native database create/drop/alter and `\connect` controls after positively identifying them within a bounded header. Schema and table/view recovery connects directly to the selected target database; an absent target is created during preflight. After restore, the adapter validates the original or mapped expected inventory through catalog identity/type, relation storage access, view/trigger/routine definition readability, and index readiness/validity. Complete evidence succeeds; missing or invalid objects fail with durable checks. Pre-`1.2.0` points remain connectivity-validated warning restores.

PostgreSQL core has no universally available server command equivalent to `CHECK TABLE`. Optional `pg_amcheck` requires additional tool, extension, and privilege deployment, so this adapter truthfully advertises native catalog/index validation rather than a physical page scan.

PostgreSQL reconciliation is isolated from MySQL, MariaDB, and file RestoreRuns. An abandoned non-terminal PostgreSQL restore becomes a durable failed run at startup.

## Main and Preload APIs

Connection operations:

- `backup:connections:postgresql:list`
- `backup:connections:postgresql:create`
- `backup:connections:postgresql:test`
- `backup:connections:postgresql:discover`

Database Sources use the shared database-source APIs. Original, alternate-cluster, and new-database restore use:

- `backup:postgresql-restores:list`
- `backup:postgresql-restores:start`
- `backup:postgresql-restores:wait`

All mutations use the Backup Manager audit wrapper. Workspace and actor identity remain main-process owned.

## Deferred Work

- One-to-many database mapping and role/ownership migration remain outside logical restore scope.
- Whole-cluster base backup, WAL archiving, and point-in-time recovery are implemented separately under BM-403 and do not change this logical dump contract.
