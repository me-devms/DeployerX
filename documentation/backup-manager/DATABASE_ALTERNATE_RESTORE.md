# Alternate Server and New Database Restore

## Scope

BM-307 extends the MySQL, MariaDB, and PostgreSQL logical adapters at version `1.3.0` with three explicit recovery targets:

| Mode | Destination | Name behavior | Collision behavior |
| --- | --- | --- | --- |
| `original` | Protected saved connection | Original database names | Replaces protected objects after destructive confirmation and identity pinning |
| `alternate` | Different tested same-engine connection | Original database names | Stops on any expected database collision unless `overwrite` is explicitly selected |
| `new-database` | Any tested same-engine connection, including the original server/cluster | One source database mapped to one absent target name | Always refuses an existing target name; overwrite is not available |

Alternate restore can recover any bounded database selection while preserving its original names. New-database restore requires exactly one protected source database because a single destination name cannot safely represent a multi-database or all-database recovery point.

## Request Contract

The engine-specific start APIs accept the same public request shape:

```js
{
  recoveryPointId,
  mode: 'original' | 'alternate' | 'new-database',
  targetConnectionId: string | null,
  targetDatabase: string | null,
  conflictPolicy: 'fail' | 'overwrite'
}
```

`targetConnectionId` is required outside original mode. `targetDatabase` is required only for new-database mode and is bounded to the native engine limit: 64 characters for MySQL/MariaDB and 63 characters for PostgreSQL. Control characters, empty names, wrong-engine connections, unhealthy connections, other-device connections, and unsupported modes fail before a RestoreRun starts.

The main process owns workspace/actor identity, displays a mode-specific confirmation, injects the matching non-renderer confirmation token, and records the redacted target fields in the audit event. Renderer input cannot convert one mode's confirmation into another mode.

## Target Preflight

Every non-original restore performs destination preflight after authenticating the repository Artifact and before streaming dump bytes:

1. reload and verify the saved target connection, current-device affinity, last successful test, TLS configuration, and pinned target identity;
2. verify the target belongs to the same database adapter and supported engine range;
3. resolve its password through SecretRef only into the permission-restricted native option/passfile;
4. discover a bounded native database inventory;
5. verify restore privileges;
6. apply collision policy;
7. create the missing destination database before partial-object restore, or leave whole-database creation to the authenticated dump;
8. create a versioned immutable restore plan and begin repository streaming.

MySQL and MariaDB require broad logical restore privileges covering database/object creation, removal, alteration, data modification, views, triggers, events, routines, indexes, and references. PostgreSQL alternate recovery requires `CREATEDB` or superuser capability plus ownership/DDL rights for objects it replaces. A connection test proves engine identity and reachability; restore preflight separately proves the stronger destination capabilities.

Alternate mode rejects a connection whose verified server/cluster fingerprint equals the captured original identity. A second saved connection pointing to the original server is not treated as an alternate target.

## Collision Rules

`fail` is the default alternate policy. If any expected database already exists on the alternate server/cluster, restore stops before the native consumer receives dump bytes. `overwrite` must be explicitly selected and confirmed; only then may the generated dump replace protected database objects on that alternate target.

New-database mode has no overwrite variant. The requested target name must be absent in the native inventory. A race or existing name causes `*_NEW_DATABASE_EXISTS` and no dump bytes are sent. Partial schema/table dumps create the absent database during preflight. Whole-database dumps create it through their authenticated native control statements.

## Whole-Database Name Mapping

Changing only the client's default database is unsafe because generated dumps contain database-control commands. MySQL/MariaDB dumps contain `CREATE DATABASE`, `USE`, and possibly qualified database identifiers. PostgreSQL plain dumps contain `CREATE/DROP/ALTER DATABASE` and `\connect` controls.

For new-database restore, DeployerX remaps only native database-identity positions while preserving strings, comments, table/column identifiers, schema names, and data. The UTF-8 stream transformer is bounded and does not buffer the dump body. It holds at most 2 MiB of the authenticated header and releases no bytes until both database creation and database selection/connection controls have been positively remapped. Missing or ambiguous controls fail with `*_DUMP_REMAP_UNSAFE` before native restore begins.

MySQL executable version comments and MariaDB executable comments are parsed as SQL control content. Normal comments and quoted string values are never rewritten. Qualified database identifiers are remapped only when they are the left side of a qualified name.

Partial MySQL/MariaDB table dumps and PostgreSQL schema/table dumps contain no database create/connect path. They are streamed unchanged while the native client connects directly to the newly created target database.

## Validation Mapping

New-database restore derives a mapped copy of the authenticated validation metadata. It changes the database identity in selected databases, expected databases, selected objects, expected schemas, and expected objects while preserving native object names and types. The source-to-target mapping is stored in the RestoreRun target evidence.

BM-306 validation then runs against the mapped target:

- native connectivity to every mapped database;
- exact expected-object and native-type comparison;
- MySQL/MariaDB bounded `CHECK TABLE ... QUICK` batches;
- PostgreSQL catalog/readability/storage/index validity checks.

Unrelated objects remain allowed for alternate overwrite because restore is in-place. New-database mode begins from an absent database name, but validation still proves the protected scope rather than claiming byte-for-byte database equivalence.

## Durable Evidence

The RestoreRun records:

- requested mode and conflict policy;
- target connection ID and verified target fingerprint;
- source and target database names for a mapping;
- target collision count and whether partial preflight created the database;
- authenticated bytes written and terminal result;
- complete BM-306 connectivity, expected-object, and native-integrity checks.

Activity identifies alternate restores and names mapped new-database restores. Startup reconciliation fails any abandoned non-terminal run without reusing its confirmation.

If native execution or validation fails after a new database has been created, DeployerX preserves the failed target for inspection. It does not automatically drop a database that may contain diagnostic evidence. The failed RestoreRun identifies the target and remains the authority for follow-up cleanup or retry.

## Security Boundaries

- Dump bytes remain encrypted and authenticated in the repository until streamed through the repository engine.
- Plaintext credentials never enter RestoreRun target evidence, audit details, renderer payloads, command arguments, or persistent artifacts.
- Native executables receive argument arrays with shell execution disabled.
- Database identifiers are parsed and emitted with engine-native identifier quoting; they are never evaluated as shell text.
- Target discovery, grants/role checks, transformation headers, native output, and persisted diagnostics are bounded.
- Alternate/new restore does not copy users, roles, account grants, tablespaces, PostgreSQL ownership, or cluster-global objects omitted by the logical backup contract.

## APIs and UI

Recovery uses the existing engine-specific IPC families:

- `backup:mysql-restores:list/start/wait`
- `backup:mariadb-restores:list/start/wait`
- `backup:postgresql-restores:list/start/wait`

The restore modal exposes target mode, tested same-engine connection, new database name, and alternate collision policy. PostgreSQL labels the destination as a cluster; MySQL and MariaDB label it as a server. Unhealthy, other-device, and original connections are unavailable where the selected mode forbids them.

## Deferred Capabilities

- One-to-many and many-to-many database name mapping require a separate reviewed mapping contract.
- Account/role, grant, ownership, tablespace, and other global-object migration remain outside logical restore scope.
- Transaction-log point-in-time recovery, physical backup restore, isolated disposable recovery tests, and automated failed-target cleanup remain assigned to later tasks.
