# Native Database Restore Validation

## Scope

BM-306 adds durable post-restore validation to the MySQL, MariaDB, and PostgreSQL logical adapters. Adapter version `1.2.0` validates three independent properties before a new RestoreRun can finish successfully:

1. every protected database accepts a native connection;
2. every object captured in the authenticated backup inventory exists with the expected native type;
3. the engine-specific native integrity checks return positive evidence.

A successful restore process exit code is necessary but is not validation evidence. Validation runs after all authenticated dump bytes have been consumed and is persisted in the RestoreRun.

## Authenticated Backup Inventory

Runtime preflight captures the validation inventory immediately before dump planning. The inventory is stored inside the authenticated database manifest metadata with:

```js
{
  validationInventoryVersion: 1,
  expectedDatabases: string[],
  expectedSchemas: Array<{ database, name }>,
  expectedObjects: Array<{
    database,
    schema,
    name,
    kind,
    objectType
  }>
}
```

MySQL and MariaDB inventory databases, tables, views, routines, events, and triggers. Table/view Sources omit routines and events consistently with their dump scope. PostgreSQL inventories non-system schemas, relations, sequences, foreign tables, indexes, triggers, functions, and procedures inside the selected database/schema/table scope.

The inventory is canonical, bounded to 1,000 databases/schemas and 10,000 objects, and captured with bounded native output. A Source that exceeds the supported validation inventory fails before dump publication instead of creating a recovery point that cannot be validated later.

Original and alternate overwrite restore are in-place. Validation requires every expected object to exist with its captured type but allows unrelated objects created after the recovery point. New-database restore maps the authenticated database identity before validation and begins from an absent database name. These checks prove restoration of the protected scope without claiming the target is an exact historical clone. See `DATABASE_ALTERNATE_RESTORE.md`.

## MySQL and MariaDB Validation

The native client connects to every expected database and runs `SELECT 1`. Backup Manager then reads the current scoped inventory from `information_schema` and compares every expected database, relation, routine, trigger, and event.

After the inventory matches, the adapter runs bounded batches of:

```sql
CHECK TABLE `database`.`object` QUICK;
```

Every expected table and view must return a native `status / OK` row. Native error or warning rows, missing status rows, missing objects, and type changes fail validation. The existing `SELECT` and `SHOW VIEW` privileges cover these read-only checks; passwords remain in the same permission-restricted temporary option file used by other adapter operations.

`QUICK` is a bounded structural/storage-engine check. It is not a row-by-row application checksum and does not prove semantic correctness of application data.

## PostgreSQL Validation

The adapter connects with `psql` to every expected protected database and runs `SELECT 1`. One scoped catalog query then verifies:

- expected schemas and object identities;
- relation kinds for tables, partitioned tables, views, materialized views, sequences, and foreign tables;
- relation storage access through `pg_relation_size` where storage exists;
- view definitions through `pg_get_viewdef`;
- trigger definitions through `pg_get_triggerdef`;
- function and procedure definitions through `pg_get_functiondef`;
- index storage access plus `pg_index.indisvalid` and `pg_index.indisready`.

Any missing object, type mismatch, unreadable definition/storage metadata, invalid index, or non-ready index fails validation.

Core PostgreSQL has no universally available server command equivalent to MySQL `CHECK TABLE`. `pg_amcheck` is optional and depends on client-tool deployment, the `amcheck` extension, and additional privileges. BM-306 therefore advertises native catalog/index validation, not a full physical page scan. Physical corruption testing and optional deep verification can be added as a separate capability without weakening this contract.

## RestoreRun Outcomes

The durable `validation` record contains:

```js
{
  state: 'succeeded' | 'warning' | 'failed',
  connectivity: 'pass' | 'fail',
  expectedObjects: 'pass' | 'warning' | 'fail',
  nativeIntegrityValidation: boolean,
  checks: Array<ValidationCheck>,
  completedAt
}
```

Outcomes are fail closed:

| Evidence | RestoreRun state |
| --- | --- |
| Connectivity, expected objects, and native integrity all pass | `succeeded` |
| Restore succeeds but an older recovery point has no authenticated inventory | `warning` |
| Any required connection, object, type, or native integrity check fails | `failed` |

Failed validation evidence remains attached to the failed RestoreRun with bounded missing/invalid object diagnostics. A validation failure never changes the fact that dump bytes may already have modified the original target; operators must inspect the failed run and decide whether to retry or recover from another point.

## Legacy Recovery Points

Recovery points created before adapter `1.2.0` have no authenticated expected-object inventory. They remain restorable to preserve recovery compatibility. The adapter runs connectivity validation, records `*_VALIDATION_INVENTORY_UNAVAILABLE`, and finishes the RestoreRun with a warning. Backup Manager does not infer historical objects from the current target or claim native integrity without backup-time evidence.

## Security and Operational Bounds

- Validation uses the same SecretRef resolution, TLS policy, pinned server identity, current-device ownership, and native-process timeout boundaries as restore.
- Identifiers are canonical metadata and are quoted/encoded as native identifiers or literals; they are never concatenated as shell commands.
- Native output, persisted checks, and missing-object diagnostics are bounded.
- Credentials, option/passfile contents, process environment, raw command output, and native query text do not enter RestoreRun records or renderer responses.
- Validation is read-only. It does not repair tables, rebuild indexes, install PostgreSQL extensions, or mutate application data.

MySQL physical recovery has a distinct whole-instance validation contract under BM-402. After copy-back it proves the configured service is active, reconnects through the tested MySQL record, requires the supported 8.4 release line, and validates original or regenerated alternate server identity. Logical expected-object and `CHECK TABLE QUICK` validation do not apply to the opaque whole-instance xbstream Artifact.

PostgreSQL physical recovery has a distinct whole-cluster validation contract under BM-403. Before service shutdown it authenticates the complete base-plus-WAL chain, validates tar members, runs matching-major `pg_verifybackup`, and parses every selected segment with `pg_waldump`. After copy-back it proves recovery completed and promoted, the service is active, the protected system identifier and supported major are unchanged, and the final timeline and replay LSN are valid. Logical expected-object validation and optional `pg_amcheck` do not apply to the opaque base-backup and WAL tar Artifacts.

## Deferred Work

- one-to-many database mapping and automated failed-target cleanup remain outside the single-new-database BM-307 contract;
- scheduled full recovery tests and isolated disposable targets belong to later recovery-testing work;
- MySQL/MariaDB row-level checksums and PostgreSQL optional `pg_amcheck` integration require separately declared performance, privilege, and tool capabilities;
- deeper physical page validation and row-level application validation remain assigned to later phases; MySQL physical validation is defined in `MYSQL_PHYSICAL_BACKUP_RESTORE.md`, PostgreSQL base/WAL recovery validation is defined in `POSTGRESQL_BASE_BACKUP_WAL_PITR.md`, and MySQL/MariaDB transaction-log chain validation and PITR use the BM-306 checks under `MYSQL_MARIADB_POINT_IN_TIME_RECOVERY.md`.
