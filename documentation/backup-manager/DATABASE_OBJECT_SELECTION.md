# Database Object Selection

## Scope

BM-305 adds native object selection to the logical database adapters. Adapter version `1.1.0` supports:

| Engine | Whole database | Schema | Table/view | Global objects |
| --- | --- | --- | --- | --- |
| MySQL 8 | One, many, or all user databases | No; database is the schema boundary | Yes, inside exactly one database | No |
| MariaDB 10.6-11.x | One, many, or all user databases | No; database is the schema boundary | Yes, inside exactly one database | No |
| PostgreSQL 14-18 | One or many databases | Yes, inside exactly one database | Yes, inside exactly one database | No |

All partial-object modes remain full logical backups. "Partial" describes object scope, not incremental or differential behavior. BM-401 later adds incremental binary-log protection only for a separately opted-in MySQL/MariaDB Source containing exactly one whole database.

## Selector Invariants

The saved Source uses the shared `database-objects` selector and a digest over its canonical contents. The following rules are enforced before planning:

- at least one database must be included, unless the Source explicitly protects all databases;
- schema and table rules must reference an included database;
- all-database selection cannot contain schema or table rules;
- MySQL and MariaDB table mode requires exactly one included database and matching database/schema fields on every selected object;
- PostgreSQL schema or table mode requires exactly one included database;
- PostgreSQL schema and table includes are mutually exclusive;
- object exclusion rules and global-object inclusion are unsupported by these adapters and fail closed;
- identifiers are bounded canonical values, not SQL expressions, wildcard requests, or command-line fragments.

The Job snapshots the complete selector and digest. Later Source edits do not silently change an existing Job.

## Discovery

Connection discovery is hierarchical and read-only:

```text
connection -> databases -> schemas or tables/views
```

The main/preload connection APIs pass `kind`, `database`, and `schema` to the owning adapter. Each request returns one canonical page with no continuation cursor. Database discovery is capped at 1,000 items and object discovery at 10,000 items; exceeding a cap returns a capacity error instead of truncating the selection silently.

MySQL and MariaDB read tables and views from `information_schema.tables`. PostgreSQL reads non-system schemas from `pg_namespace` and relations from `pg_class`/`pg_namespace`; relations include tables, partitioned tables, views, and materialized views. System and maintenance databases remain unavailable for protection.

Discovery does not replace runtime authorization checks. Every backup revalidates server identity, tool compatibility, privileges, object scope, and application-consistency evidence before writing dump bytes.

## Native Dump Mapping

### MySQL and MariaDB

Whole-database mode retains `--databases` or `--all-databases`, routines, events, and triggers. Table/view mode supplies the selected database and exact object names positionally, retains triggers, and adds `--skip-routines --skip-events`.

Routines and events are database-level objects and cannot be attributed safely to a selected table set. Dependencies outside the selected objects are not included automatically. Both limitations are recorded in preflight warnings and authenticated RecoveryPoint metadata.

### PostgreSQL

Whole-database mode retains `--create --clean --if-exists`. Schema mode omits `--create` and adds exact quoted `--schema=` patterns. Table/view mode omits `--create` and adds exact quoted `--table=` patterns. Schema and table patterns are never mixed because PostgreSQL documents that `-n` has no effect when `-t` is used.

`pg_dump` table selection does not automatically include dependent objects outside the selected relations. The adapter records this limitation rather than claiming a self-contained dependency closure.

## Consistency and Privileges

Object selection narrows the native preflight predicates but does not weaken the requested consistency level:

- MySQL and MariaDB still require every selected base table to be InnoDB and require the logical-read grants declared by the adapter;
- PostgreSQL checks `CONNECT` on the selected database, `USAGE` on selected schemas, and relevant relation/sequence `SELECT` access for the chosen scope;
- native tool versions, server identity, TLS behavior, credentials, repository publication, and cancellation boundaries are unchanged from the engine contracts.

A selected view may reference objects outside the selection. Backup Manager does not claim those dependencies are protected.

## RecoveryPoint Metadata

Every database dump records authenticated scope metadata:

```js
{
  selectionMode: 'databases' | 'schemas' | 'tables',
  selectedDatabases: string[],
  selectedSchemas: Array<{ database, name }>,
  selectedTables: Array<{ database, schema, name }>
}
```

The selector digest remains the authoritative configuration fingerprint. The explicit arrays make recovery scope visible and bind partial restore to the intended existing database.

## Original-Target Restore

Restore remains destructive and requires the existing in-app confirmation plus the main-process confirmation token. Repository manifests, Artifact size/digest, current-device ownership, connection health, and pinned server/cluster identity are verified before native input begins.

Whole-database RecoveryPoints retain their existing database create/drop path. Partial RecoveryPoints never use that path:

- MySQL/MariaDB connect the native restore client to the one protected database;
- PostgreSQL connects `psql` to the one protected database instead of the maintenance database;
- native clean/drop statements affect only objects emitted by the partial dump.

Partial-object recovery supports the original target, a tested alternate target, or one absent newly created database. Alternate collision policy never performs dependency repair or merge resolution: it either stops on an existing protected database or explicitly replaces the emitted object scope. Adapter `1.2.0+` validates per-database connectivity, the authenticated expected-object inventory, and engine-native integrity evidence after restore as defined in `DATABASE_RESTORE_VALIDATION.md`; adapter `1.3.0` adds mapped target planning as defined in `DATABASE_ALTERNATE_RESTORE.md`.

## UI Behavior

The Database Source dialog derives available scope modes from adapter capabilities. Whole-database mode allows existing multi-database selection. Schema and table/view modes require one database before object discovery and keep the selected object list bounded and scrollable. Jobs and source summaries label the selected object kind and count rather than presenting every partial Source as a database count.

The renderer cannot invent unsupported modes. Main-process selector normalization and adapter preflight remain authoritative even if a renderer payload is stale or manipulated.

## Deferred Capabilities

- object exclusion rules and dependency-closure planning;
- accounts, roles, tablespaces, extensions, and other global objects;
- WAL, physical, differential, and partial-object point-in-time recovery assigned to later phases.
