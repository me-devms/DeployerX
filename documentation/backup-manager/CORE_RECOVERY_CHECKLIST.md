# Backup Manager Core Recovery Checklist

Use this checklist for operator preflight, backup, restore, recovery drills, and incidents. The [core compatibility matrix](./CORE_COMPATIBILITY_MATRIX.md) is the authority for supported versions, topology, scope, tools, privileges, repositories, and restore targets. Stop when the selected workload falls outside that boundary; do not infer support from a successful connection test.

Record each checked item in the change, drill, or incident record. Mark an item not applicable only when the compatibility matrix or linked runbook explicitly permits it.

Checklist boxes are reusable operator actions. One-time release completion and its evidence are tracked in [the core delivery task list](./CORE_TASKS.md).

## Core Runbook Index

| Workload | Required runbook |
| --- | --- |
| File/server | [Manual file backup](./MANUAL_FILE_BACKUP_EXECUTION.md) and [file restore](./FILE_RESTORE_EXECUTION.md) |
| MySQL logical | [MySQL logical backup and restore](./MYSQL_LOGICAL_BACKUP_RESTORE.md) and [MySQL/MariaDB point-in-time recovery](./MYSQL_MARIADB_POINT_IN_TIME_RECOVERY.md) |
| MySQL physical | [MySQL physical backup and restore](./MYSQL_PHYSICAL_BACKUP_RESTORE.md) |
| MariaDB logical | [MariaDB logical backup and restore](./MARIADB_LOGICAL_BACKUP_RESTORE.md) and [MySQL/MariaDB point-in-time recovery](./MYSQL_MARIADB_POINT_IN_TIME_RECOVERY.md) |
| PostgreSQL logical | [PostgreSQL logical backup and restore](./POSTGRESQL_LOGICAL_BACKUP_RESTORE.md) |
| PostgreSQL physical, WAL, and PITR | [PostgreSQL base backup, WAL, and PITR](./POSTGRESQL_BASE_BACKUP_WAL_PITR.md) |
| Supabase PostgreSQL profile | [Supabase PostgreSQL backup and restore](./SUPABASE_POSTGRESQL_BACKUP_RESTORE.md) |
| SQLite | [SQLite backup and restore](./SQLITE_BACKUP_RESTORE.md) |
| MongoDB | [MongoDB backup and recovery](./MONGODB_BACKUP_RESTORE.md) |
| Redis standalone, replication, and cluster | [Redis backup and restore](./REDIS_BACKUP_RESTORE.md) |
| ClickHouse | [ClickHouse backup and restore](./CLICKHOUSE_BACKUP_RESTORE.md) |

Repository procedures are defined in [repository operations](./REPOSITORY_OPERATIONS.md), [repository and sampled-restore verification](./REPOSITORY_AND_SAMPLED_RESTORE_VERIFICATION.md), [repository pruning](./REPOSITORY_PRUNING.md), and [retention policies](./RETENTION_POLICIES.md). Restore acceptance is defined in [database restore validation](./DATABASE_RESTORE_VALIDATION.md), [database alternate restore](./DATABASE_ALTERNATE_RESTORE.md), and [audit logging](./AUDIT_LOGGING.md).

## Preflight

- [ ] Identify the workload, Source, protected scope, RecoveryPoint objective, RPO, RTO, owner, operator, and approval record.
- [ ] Confirm the engine/server version, deployment topology, operating system, selected objects, and restore mode are admitted by the matrix and selected runbook.
- [ ] Confirm source and target identities are current. Re-run discovery after upgrades, failover, endpoint changes, or topology changes.
- [ ] Confirm every credential is a current device-scoped `SecretRef`. Do not place plaintext secrets in jobs, commands, logs, screenshots, evidence, or tickets.
- [ ] Verify TLS certificate identity and policy where required. For SSH/SFTP, verify the saved SHA-256 host key before resolving any `SecretRef`; stop on a missing or changed key.
- [ ] Verify required native tools, exact or compatible tool versions, executable paths, temporary credential-file permissions, and cleanup behavior from the runbook.
- [ ] Prove the backup identity has the listed read, discovery, monitoring, log, or snapshot privileges. Prove the restore identity has only the required create, write, DDL, service, filesystem, or validation privileges.
- [ ] Verify the repository is reachable and authenticated, its encryption/authentication key is available, and the selected local, SFTP, or S3-compatible destination passes bounded write, finalize, read-back, and cleanup checks.
- [ ] Confirm repository free capacity and working-space headroom cover the backup, dependent chain, restore staging, validation, and expected retention window.
- [ ] For an SFTP interruption, allow the startup or next worker reconciliation to acquire the repository mutation lease and remove only aged generated `.tmp` staging files; never delete remote staging or lock records manually.
- [ ] Confirm repository immutability or object-lock settings protect required points without blocking the runbook's publish, prune, or cleanup operations.
- [ ] Verify the selected full anchor and every required incremental, binary-log, WAL, oplog, or native-media ancestor. Resolve missing, corrupt, quarantined, expired, or held chain members before proceeding.
- [ ] Preview retention and pruning. Confirm the proposed operation preserves the recovery chain, legal/incident holds, minimum restore points, and the point selected for this operation.
- [ ] Confirm maintenance windows, application write gates, service-stop requirements, empty-target requirements, and source quiescence rules from the runbook.
- [ ] Confirm monitoring, notifications, cancellation ownership, escalation contacts, and enough time for native validation before the change window closes.

## Special Admission Gates

- [ ] For Supabase, use only an eligible direct endpoint or shared session pooler with mandatory TLS. Treat a transaction pooler as diagnostic-only. Protect exactly one existing database and only admitted user scope; do not claim managed platform resources, physical backup, WAL/PITR, or new-database restore.
- [ ] For ClickHouse, confirm a self-managed standalone non-replicated deployment, the exact supported source version, and the approved writable configured disk. Confirm every required native ZIP ancestor remains on that same disk; the DeployerX repository contains authenticated metadata, not the native media. Restore only to the admitted empty alternate database/table target, with no original-target, PITR, cluster, managed-service, or cross-version claim.
- [ ] For module release evidence, run a disposable real OpenSSH/SFTP smoke. Record extension negotiation and fail-closed behavior, pinned host-key and `SecretRef` authentication, abrupt socket/channel loss, remote fsync/hardlink/atomic-rename semantics, and repository lease takeover after loss. Use an isolated target, capture evidence, and remove only exact smoke-owned data afterward. The one-time completion state is authoritative in `CORE_TASKS.md`; packaging and publishing are separate release decisions.

## Backup

- [ ] Reconfirm the Source snapshot, include/exclude rules, database/object selection, backup mode, schedule, timezone, retention policy, and repository immediately before execution.
- [ ] For an incremental or PITR-capable run, verify the exact parent/anchor and continuity cursor before reading new data. If continuity cannot be proven, stop or take a new full anchor as the runbook directs.
- [ ] Start the backup using the reviewed immutable plan. Record the Job, Run, Source, repository, parent RecoveryPoint, tool versions, and start time.
- [ ] Monitor native process state, bytes/items, chain progress, repository publication, cancellation, and errors. Do not treat native command success alone as a published backup.
- [ ] Require complete native validation, artifact authentication, manifest publication, and repository verification before the RecoveryPoint becomes restorable.
- [ ] Confirm retention evaluation protects all dependencies and does not prune an anchor or log segment required by a retained point.
- [ ] Capture sanitized evidence and the final RecoveryPoint ID, end time, duration, size, validation result, and any RPO variance.

## Restore

- [ ] Authenticate repository metadata and content, then verify the complete chain and any required native media before changing the target.
- [ ] Select the exact RecoveryPoint and stop coordinate, if supported. Record the reviewed recovery plan ID and resolved source/target identities.
- [ ] Prefer an isolated alternate target. Prove its version, topology, capacity, network isolation, empty/absent state, ownership, and cleanup boundary satisfy the runbook.
- [ ] Review the preview for scope, target, conflict policy, service actions, files/objects affected, chain members, expected data loss, and validation plan.
- [ ] Obtain a destructive confirmation that names the exact target and operation before overwrite, drop, copy-back, service stop, or original-target recovery. A generic confirmation is insufficient.
- [ ] Confirm rollback or forward-recovery actions, maintenance ownership, application write fencing, and a stop condition for every destructive step.
- [ ] Execute only the reviewed plan. Stop if its plan ID, target identity, chain, credentials, host key, native version, or repository generation changes.
- [ ] Monitor restore and cancellation to a terminal state. Preserve the source RecoveryPoint and evidence until validation and incident closure are complete.

## Post-Restore Validation

- [ ] Require the runbook's native integrity validation and verify restored version, identity, topology, scope, timestamps, and selected stop coordinate.
- [ ] Validate application startup, schema/object inventory, representative reads, counts or checksums where defined, permissions, indexes, and dependency health.
- [ ] Confirm network exposure, service state, replication role, scheduled jobs, credentials, and application write access match the approved target plan.
- [ ] Measure achieved RPO and RTO. Record all omissions, warnings, manual repairs, and semantic checks that remain application-owned.
- [ ] Capture sanitized logs, screenshots, native validation output, operator approvals, and final status without secrets, raw repository locators, or sensitive content.
- [ ] Release the maintenance/write gate only after the recovery owner accepts the validation evidence.

## Recovery Drill

- [ ] Choose a recent retained point and exercise its complete dependency chain, not only repository download or manifest verification.
- [ ] Provision an isolated, disposable alternate target that cannot serve production traffic or write to the source environment.
- [ ] Perform the same preview, exact-target confirmation, restore, and post-restore validation required during an incident.
- [ ] Test cancellation and failure cleanup where the runbook supports it. Destroy only resources whose exact drill ownership is proven; escalate foreign or ambiguous ownership.
- [ ] Record achieved RPO/RTO, validation results, evidence locations, cleanup proof, defects, owners, and due dates. Keep the drill failed until material gaps are remediated and retested.

## Incident Recovery

- [ ] Open the incident record, assign recovery and approval owners, record the incident start, and preserve relevant audit and repository evidence.
- [ ] Freeze automated pruning or expiration only through the approved hold mechanism; do not mutate repository contents manually.
- [ ] Establish the last known good point and acceptable data-loss boundary from authenticated chain evidence, application evidence, and the incident timeline.
- [ ] Re-run preflight against current source, repository, credentials, target, tools, and topology. Incident urgency does not waive compatibility or integrity gates.
- [ ] Obtain and record the exact destructive approval, then execute the reviewed restore plan with continuous operator observation.
- [ ] Complete native and application validation before traffic cutover. Record achieved RPO/RTO and any degraded or excluded capability.
- [ ] Preserve the selected chain and incident hold until root cause, evidence export, stakeholder acceptance, and follow-up backup verification are complete.
- [ ] Rotate affected `SecretRef` values and re-pin trust only when compromise or an authorized infrastructure change requires it; never accept an unexplained host-key or TLS identity change.
- [ ] After closure, verify a new backup, schedule an alternate-target drill, release holds deliberately, and review retention/pruning previews before normal automation resumes.

## Evidence Record

- [ ] Change, drill, or incident ID; operator and approver; UTC start/end timestamps.
- [ ] Workload/runbook, Source and target IDs, versions/topology, Job/Run/RecoveryPoint IDs, reviewed plan ID, and chain identifiers.
- [ ] Repository ID and generation, immutability/hold state, capacity evidence, verification result, and sanitized native-tool versions/output.
- [ ] Confirmation record, cancellation/failure events, post-restore checks, achieved RPO/RTO, screenshots/log locations, cleanup proof, and final acceptance.
