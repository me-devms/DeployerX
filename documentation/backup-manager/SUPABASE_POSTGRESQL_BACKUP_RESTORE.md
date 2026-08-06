# Supabase PostgreSQL Backup and Restore

## Purpose and Scope

DeployerX supports Supabase as a constrained deployment profile of the existing `deployerx.database.postgresql.logical` adapter. It is not a separate database engine and it is not a whole-project backup product.

This profile protects accessible user PostgreSQL schema and data in one existing Supabase project database. It uses `pg_dump` for full logical backup and `psql` for restore. The Source, RecoveryPoint, and restore metadata bind the operation to the Supabase project reference and connection mode without storing credentials.

The word **full** in this document means a full logical backup of the selected PostgreSQL database scope. It does not mean full coverage of the Supabase project or infrastructure.

## Supported Connection Modes

Use the connection values shown in the Supabase dashboard for the intended project. DeployerX additionally verifies that the endpoint, port, username, and project reference agree.

| Connection mode | Endpoint contract | Port | Username contract | Backup and restore |
| --- | --- | ---: | --- | --- |
| Direct | Exactly `db.<project-ref>.supabase.co` | `5432` | The project database user, commonly `postgres` | Supported |
| Shared session pooler | A hosted `*.pooler.supabase.com` endpoint | `5432` | Must end with `.<project-ref>`, commonly `postgres.<project-ref>` | Supported |
| Transaction pooler | A hosted `*.pooler.supabase.com` endpoint | `6543` | Must end with `.<project-ref>` | Diagnostic-only; connection save and test are allowed, but Source creation, backup, and restore are refused |

The canonical saved field is `connectionMode`. Old records using `supabaseEndpointMode` can be read as a legacy alias, but new records and public metadata emit only `connectionMode`.

The project reference is normalized to lowercase and must contain exactly 20 lowercase letters or digits. It is public deployment identity, not a credential.

## Security Boundary

- TLS is mandatory. `disabled` and `preferred` TLS modes are rejected. Use identity verification whenever the worker trust configuration supports it.
- The database password is accepted only during connection creation and is stored through a device-scoped SecretRef. Backup plans, Source metadata, renderer responses, logs, errors, and artifacts must not contain the password.
- Native processes receive the resolved password only through a permission-restricted temporary PostgreSQL passfile. The passfile is removed after success or failure.
- Source platform metadata may contain only safe context such as `deploymentProfile: supabase`, `connectionMode`, `projectRef`, and `coverage: database-logical-only`.
- Original-target recovery is pinned to the project reference captured in the authenticated RecoveryPoint metadata.

## What Is Included

The current profile supports:

- one explicitly selected database matching the database configured on the Supabase endpoint, normally `postgres`;
- a full logical backup of that database's accessible user schemas and data;
- optional exact user-schema selection or exact table/view selection within that same database;
- PostgreSQL schema, tables, data, views, materialized views, sequences, functions, procedures, triggers, and other objects emitted by `pg_dump` within the admitted scope;
- an application-consistent PostgreSQL transaction snapshot;
- encrypted publication to the supported DeployerX local, SFTP, or S3-compatible repositories;
- manual and scheduled full backups, repository retention, authenticated RecoveryPoints, and restore validation;
- restore into the existing database of the original Supabase project;
- overwrite restore into the existing matching database of a different Supabase project.

The whole-database Supabase dump does not use `--create`. It uses logical cleanup and replacement controls for objects inside the existing database, omits ownership and privilege replay, and excludes Supabase platform-managed schemas.

## What Is Not Included

This profile does not claim or provide:

- PostgreSQL physical base backup;
- WAL archiving, incremental WAL backup, or point-in-time recovery;
- filesystem access to the managed PostgreSQL host;
- creation of a new database during recovery;
- Supabase provider-managed backup or snapshot ownership;
- restore of a Supabase RecoveryPoint into an ordinary PostgreSQL deployment profile;
- Supabase Storage objects or buckets, including the object bytes stored outside PostgreSQL;
- Supabase platform-managed schemas such as `auth`, `storage`, `realtime`, `supabase_functions`, `vault`, and other internal schemas excluded by the adapter;
- Edge Functions or deployed function code;
- project settings, API keys, JWT secrets, database passwords, service-role secrets, or other project secrets;
- authentication provider configuration;
- custom PostgreSQL role passwords, global role recreation, ownership migration, or grant replay;
- provider configuration, network configuration, extensions managed outside the selected logical scope, or provider snapshots.

Use Supabase's own platform facilities for those resources. DeployerX must not present this database artifact as a complete Supabase disaster-recovery package.

## Prerequisites

Before creating the connection:

1. Obtain the project reference and connection details from the target Supabase project's Connect panel.
2. Choose a direct or session-pooler endpoint for backup and restore. A transaction-pooler endpoint can be retained for diagnostics only.
3. Confirm that the DeployerX worker can resolve and reach the endpoint over TLS.
4. Install compatible `psql` and `pg_dump` clients on the worker. The current adapter accepts PostgreSQL server and client major versions 14 through 18 and refuses a client older than the server.
5. Use a database account with `CONNECT` on the selected database, `USAGE` on selected user schemas, `SELECT` on selected tables/materialized views, and `SELECT` on selected sequences.
6. For restore, ensure the account can create, alter, and drop the selected objects in the existing target database. DeployerX does not rely on Supabase superuser or `CREATEDB` access for this profile.
7. Select an encrypted DeployerX repository and verify that its retention policy has enough capacity for repeated full logical backups.

## Connection Setup

1. Open Backup Manager and add a PostgreSQL connection.
2. Select the **Supabase** deployment profile.
3. Enter the 20-character project reference.
4. Select **Direct** or **Session pooler**.
5. Enter the exact endpoint, port, database, and username for that mode.
6. Enter the database password. DeployerX converts it to a SecretRef and does not persist the plaintext.
7. Select a required TLS policy; identity verification is preferred.
8. Save and test the connection.

A successful test proves supported server/tool versions, TLS connectivity, endpoint/project binding, database access, and safe project identity metadata. A transaction-pooler test can succeed but returns a diagnostic warning that backup and restore are ineligible.

## Source Setup

1. Select a successfully tested direct or session-pooler Supabase connection.
2. Select exactly one database. It must equal the database configured on the endpoint; the normal Supabase value is `postgres`.
3. Choose one scope:
   - the admitted user-visible database scope;
   - exact user schemas; or
   - exact user tables/views.
4. Do not select platform-managed Supabase schemas. Whole-database backup excludes them automatically; explicit managed-schema selection is refused.
5. Select **Logical**, **Full**, and **Transaction snapshot** or **Auto** consistency.
6. Save the Source, then attach it to a manual or scheduled Job and an encrypted repository.

Source admission refuses all-database selection, multiple databases, a database that differs from the configured endpoint database, incremental mode, physical execution settings, coordinate capture, and consistency downgrade.

## Backup Behavior

Before each backup, DeployerX revalidates:

- the Supabase deployment profile and project reference;
- direct or session-pooler eligibility;
- the endpoint/database binding;
- TLS and SecretRef-backed authentication;
- supported PostgreSQL server, `psql`, and `pg_dump` versions;
- database, schema, table, and sequence read privileges;
- the exact selector and exclusion of platform-managed schemas;
- application consistency through a PostgreSQL transaction snapshot;
- the expected schema and object inventory used for restore validation.

The adapter streams a plain SQL logical dump into one authenticated `postgresql/logical-dump.sql` artifact. For the Supabase whole-database scope it omits database creation, uses `--clean` and `--if-exists` for selected objects, omits ownership and grant replay, and excludes the platform-managed schema list.

Logical execution is not resumable. If native execution or repository publication is interrupted, the partial attempt cannot become a RecoveryPoint; a retry starts a new full dump.

Authenticated metadata records the Supabase profile, `connectionMode`, project reference, logical-only coverage, selected database/object scope, excluded managed schemas, tool/server versions, expected validation inventory, and `platformSnapshotsIncluded: false`. It must not contain passwords or claim non-database coverage.

## Original-Project Restore

Original restore means the target connection has the same Supabase project reference captured by the RecoveryPoint.

1. Test an eligible direct or session-pooler connection for the original project.
2. Confirm that the configured existing database has the same name as the single database in the RecoveryPoint.
3. Review the selected database/schema/table scope and the destructive replacement warning.
4. Enter the explicit original-restore confirmation.
5. Start restore. DeployerX authenticates and decrypts the repository artifact while streaming it to `psql` connected to the existing project database.
6. Review catalog/object/index validation evidence when execution finishes.

The restore does not create or drop the project database. It can drop and recreate selected objects inside that database because the logical dump uses cleanup statements. Application writes should be stopped or otherwise controlled by the operator before destructive recovery.

## Alternate-Project Restore

Alternate restore means the target is a different Supabase project, proven by a different project reference.

1. Provision the alternate Supabase project and its existing target database before starting DeployerX recovery.
2. Create and test a direct or session-pooler connection for that project.
3. Ensure the target database name matches the single database recorded in the RecoveryPoint.
4. Ensure the target role has the required object-level restore privileges.
5. Choose alternate-target restore and explicitly approve overwrite of the existing database objects.
6. Complete destination preflight and the destructive confirmation, then start restore.
7. Review the post-restore inventory validation and any omitted ownership/grant warnings.

The alternate project reference must differ from the source project reference. A same-project target belongs to original mode. New-database mode is unavailable, and DeployerX does not clone Supabase project settings or external services into the alternate project.

## Validation and Expected Errors

Connection input errors are returned before any native backup or restore process starts. They identify invalid project references, endpoint/port/username mismatches, unsupported TLS policy, or unsupported client configuration without exposing credentials.

Stable compatibility and safety errors include:

| Condition | Error code | Operator action |
| --- | --- | --- |
| Backup or restore requested through port `6543` transaction pooling | `POSTGRESQL_SUPABASE_TRANSACTION_POOLER_INELIGIBLE` | Use a direct or session-pooler connection |
| Physical, base-backup, or WAL settings requested during Source enrollment | `POSTGRESQL_SUPABASE_PHYSICAL_BACKUP_UNAVAILABLE` | Select logical full transaction-snapshot backup |
| Incremental or incompatible consistency requested | `POSTGRESQL_SUPABASE_SOURCE_CONSISTENCY_INVALID` or `POSTGRESQL_SUPABASE_BACKUP_MODE_UNSUPPORTED` | Use logical, full, application-consistent transaction snapshot/auto |
| Source database count/name does not match the endpoint | `POSTGRESQL_SUPABASE_SOURCE_SELECTION_INVALID` or `POSTGRESQL_SUPABASE_DATABASE_SCOPE_INVALID` | Select exactly the configured existing database |
| Explicit selection includes a platform-managed schema | `POSTGRESQL_SUPABASE_MANAGED_SCHEMA_UNSUPPORTED` | Select user-owned schemas or tables only |
| RecoveryPoint or target is not a Supabase profile | `POSTGRESQL_SUPABASE_RESTORE_PROFILE_MISMATCH` | Use a tested Supabase target |
| Original mode uses a different project | `POSTGRESQL_SUPABASE_RESTORE_PROJECT_MISMATCH` | Use the captured project or choose alternate mode |
| Alternate mode uses the original project | `POSTGRESQL_SUPABASE_ALTERNATE_TARGET_IS_ORIGINAL` | Choose a different project reference |
| New-database restore requested | `POSTGRESQL_SUPABASE_NEW_DATABASE_RESTORE_UNSUPPORTED` | Restore into the existing project database |
| Recovery database and target endpoint database differ | `POSTGRESQL_SUPABASE_RESTORE_DATABASE_MISMATCH` | Configure the matching existing database |
| Existing target database is absent | `POSTGRESQL_SUPABASE_RESTORE_DATABASE_MISSING` | Provision or select the existing project database first |
| RecoveryPoint lacks valid project identity | `POSTGRESQL_SUPABASE_RECOVERY_IDENTITY_INVALID` | Use an authenticated compatible Supabase RecoveryPoint |

A backup is publishable only after preflight proves the requested transaction-snapshot consistency and required read privileges. A restore is successful only after the artifact authenticates, native execution completes, and expected database objects pass bounded catalog/object/index validation. This is logical validation, not a physical page scan or provider snapshot verification.

## Operational Limits

- Exactly one configured Supabase database per Source and RecoveryPoint.
- Full logical backups only; no incremental chain or PITR timeline.
- Direct and session-pooler modes only for backup and restore.
- Existing-database restore only.
- Original restore requires the same project reference; alternate restore requires a different project reference.
- Schema and table include rules cannot be mixed in one Source.
- Object exclusion rules are not supported, except the adapter's mandatory exclusion of known Supabase platform-managed schemas.
- Table-only dumps may not include dependent objects outside the selected tables.
- Ownership, grants, global roles, and role passwords are not replayed.
- An interrupted logical dump restarts from the beginning.
- Compatibility depends on the selected account retaining object access; Supabase platform changes or permission changes can make a later run fail preflight.

For the underlying artifact, repository, scheduling, cancellation, and validation mechanics, also see [PostgreSQL Logical Backup and Restore](./POSTGRESQL_LOGICAL_BACKUP_RESTORE.md).

## Official Supabase References

The following official pages describe the Supabase platform concepts used by this DeployerX profile. They do not expand DeployerX coverage beyond the limits above.

- [Connect to your database](https://supabase.com/docs/guides/database/connecting-to-postgres): direct and pooler connection choices and dashboard connection details.
- [Database Backups](https://supabase.com/docs/guides/platform/backups): Supabase-managed database backups and PITR, which remain separate from DeployerX logical RecoveryPoints.
- [Migrating within Supabase](https://supabase.com/docs/guides/platform/migrating-within-supabase): Supabase's migration guidance for moving database content between projects.
- [Postgres Roles](https://supabase.com/docs/guides/database/postgres/roles): Supabase PostgreSQL role concepts and privilege context.
- [Storage](https://supabase.com/docs/guides/storage): Supabase Storage, which is outside this logical PostgreSQL artifact.
- [Auth](https://supabase.com/docs/guides/auth): Supabase Auth and provider configuration, which are outside this profile.
- [Edge Functions](https://supabase.com/docs/guides/functions): Edge Functions, which are outside this profile.

Official links were verified as reachable on 2026-08-05.
