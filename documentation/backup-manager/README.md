# Backup Manager Documentation

## Start Here

Use these documents in this order:

| Need | Document | Authority |
| --- | --- | --- |
| What is done, active, blocked, and next | [Backup Manager task list](./BACKUP_MANAGER_TASK_LIST.md) | Current operational queue |
| Detailed task acceptance and verification history | [Core delivery tasks](./CORE_TASKS.md) | Detailed evidence register |
| Supported versions, modes, topology, tools, privileges, repositories, and exclusions | [Core compatibility matrix](./CORE_COMPATIBILITY_MATRIX.md) | Product compatibility boundary |
| Operator preflight, backup, restore, drill, incident, and evidence steps | [Core recovery checklist](./CORE_RECOVERY_CHECKLIST.md) | Reusable operational checklist |
| Older implementation history | [Historical task log](./TASKS.md) | Historical evidence only; not the active queue |

The operational task list is the fastest way to resume work. Do not infer current priorities from filenames, historical entries, or removed-engine research.

## Active Product Scope

The current Backup Manager release includes:

- Local and SSH/SFTP file and server backup
- MySQL
- MariaDB
- PostgreSQL
- Supabase as a constrained PostgreSQL profile
- SQLite
- MongoDB
- Redis
- ClickHouse
- Local-folder, SFTP, and S3-compatible repositories

Every unlisted database is outside the active plan. In particular, Cassandra, ScyllaDB, CockroachDB, InfluxDB, Neo4j, Oracle, SQL Server, Elasticsearch, and OpenSearch must not create new release tasks. Their existing files may remain as historical research or compatibility evidence. Plain FTP is not a supported repository.

## Active Runbooks

### File And Repository Operations

- [Manual file backup](./MANUAL_FILE_BACKUP_EXECUTION.md)
- [Scheduled file backup worker](./SCHEDULED_FILE_BACKUP_WORKER.md)
- [File restore](./FILE_RESTORE_EXECUTION.md)
- [Snapshot browsing and version history](./SNAPSHOT_BROWSING_AND_VERSION_HISTORY.md)
- [Repository format](./REPOSITORY_FORMAT.md)
- [Repository operations](./REPOSITORY_OPERATIONS.md)
- [Repository and sampled-restore verification](./REPOSITORY_AND_SAMPLED_RESTORE_VERIFICATION.md)
- [Repository pruning](./REPOSITORY_PRUNING.md)
- [Retention policies](./RETENTION_POLICIES.md)

### Mainstream Database Operations

- [MySQL logical backup and restore](./MYSQL_LOGICAL_BACKUP_RESTORE.md)
- [MySQL physical backup and restore](./MYSQL_PHYSICAL_BACKUP_RESTORE.md)
- [MySQL and MariaDB point-in-time recovery](./MYSQL_MARIADB_POINT_IN_TIME_RECOVERY.md)
- [MariaDB logical backup and restore](./MARIADB_LOGICAL_BACKUP_RESTORE.md)
- [PostgreSQL logical backup and restore](./POSTGRESQL_LOGICAL_BACKUP_RESTORE.md)
- [PostgreSQL base backup, WAL, and PITR](./POSTGRESQL_BASE_BACKUP_WAL_PITR.md)
- [Supabase PostgreSQL backup and restore](./SUPABASE_POSTGRESQL_BACKUP_RESTORE.md)
- [SQLite backup and restore](./SQLITE_BACKUP_RESTORE.md)
- [MongoDB backup and restore](./MONGODB_BACKUP_RESTORE.md)
- [Redis backup and restore](./REDIS_BACKUP_RESTORE.md)
- [ClickHouse backup and restore](./CLICKHOUSE_BACKUP_RESTORE.md)

### Shared Contracts

- [Domain model](./DOMAIN_MODEL.md)
- [Adapter contracts](./ADAPTER_CONTRACTS.md)
- [Database adapter contract](./DATABASE_ADAPTER_CONTRACT.md)
- [Database object selection](./DATABASE_OBJECT_SELECTION.md)
- [Database alternate restore](./DATABASE_ALTERNATE_RESTORE.md)
- [Database restore validation](./DATABASE_RESTORE_VALIDATION.md)
- [Job configuration](./JOB_CONFIGURATION.md)
- [Job lifecycle](./JOB_LIFECYCLE.md)
- [Worker protocol](./WORKER_PROTOCOL.md)
- [Execution policies](./EXECUTION_POLICIES.md)
- [Schedule policies](./SCHEDULE_POLICIES.md)
- [Timezone and execution calendar policies](./TIMEZONE_AND_EXECUTION_CALENDAR_POLICIES.md)
- [Run history](./RUN_HISTORY.md)
- [Recovery objectives](./RECOVERY_OBJECTIVES.md)
- [Notifications](./NOTIFICATIONS.md)
- [Audit logging](./AUDIT_LOGGING.md)

## Progress Update Rules

For every implementation or documentation task:

1. Add or select a stable task ID in `BACKUP_MANAGER_TASK_LIST.md`.
2. Mark it `[~]` before making changes and add a dated start entry to the progress log.
3. Record scope changes, meaningful decisions, blockers, and exact resumption conditions while work is active.
4. Verify the task against its stated acceptance boundary.
5. Mark it `[x]` only after verification and record exact evidence, including test counts or other authoritative results.
6. Mark it `[!]` when blocked and state who or what must change before work can resume.
7. Update `CORE_TASKS.md` when the change affects detailed acceptance, release evidence, or core status.

Do not delete or rewrite historical evidence merely because a later task changes direction. Add a superseding entry and keep the present state explicit in the operational task list.

## Current Work

The current task, next action, blocker, and release state are maintained in [BACKUP_MANAGER_TASK_LIST.md](./BACKUP_MANAGER_TASK_LIST.md#current-status). Read that section before starting or assigning work.
