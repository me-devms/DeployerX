# SQL Server Native Backup and Restore

## Scope

BM-404 protects selected SQL Server user databases with engine-native full, differential, transaction-log, and tail-log backups. Native media is created on the database host, validated by SQL Server, streamed over a pinned SSH connection into an encrypted DeployerX repository, and removed from the host after publication.

Supported in the first release:

- SQL Server 2019, 2022, and 2025 on Linux, represented by server majors 15, 16, and 17;
- one tested SQL Server connection paired with one tested, host-key-pinned Linux SSH connection owned by the current device;
- SQL authentication over encrypted TDS with certificate verification;
- exactly one explicitly selected online user database per Source, preserving one unambiguous differential and log chain per RecoveryPoint;
- conventional full backups, differential backups, transaction-log backups, and pre-restore tail-log backups;
- Full and Bulk-Logged recovery models for transaction-log and point-in-time recovery;
- original-instance and alternate-instance restore to an explicit database name;
- end-of-chain or UTC `STOPAT` recovery targets;
- local, SFTP, and S3 DeployerX repositories through the existing authenticated and encrypted repository engine.

Windows hosts, named instances requiring SQL Browser discovery, integrated authentication, contained availability groups, distributed availability groups, failover orchestration, log shipping orchestration, URL/device backups, striped or mirrored media sets, partial/file/filegroup backups, snapshots, system-database restore, page restore, piecemeal restore, marked-transaction recovery, and cross-major downgrade fail closed. A restore may target the same major or a newer supported major; SQL Server does not support restoring a database onto an older engine.

The release protects user databases only. `master`, `model`, `msdb`, `tempdb`, Resource, distribution, and database snapshots are excluded. Read-only, suspect, emergency, restoring, recovering, offline, and inaccessible databases are rejected at backup preflight. Read-only databases can be addressed later with an explicit differential-base policy.

## Native Prerequisites

The paired Linux host must provide:

- `sqlcmd` from the current Microsoft command-line tools for connection, discovery, backup, restore, and validation;
- GNU-compatible `stat`, `dd`, and `rm` for bounded media streaming and cleanup;
- a canonical absolute backup staging directory writable by the SQL Server service account and readable through the approved SSH privilege mode.

The SQL login must be a member of `sysadmin` in this release. SQL Server permits narrower role combinations for individual operations, but native restore, tail-log handling, database state changes, and metadata inspection form a security-sensitive lifecycle. A later release may split backup-only and restore operators after every permission path has independent coverage.

Every run proves:

- `SERVERPROPERTY('ProductMajorVersion')` is 15, 16, or 17;
- `SERVERPROPERTY('EngineEdition')` is a supported standalone SQL Server engine;
- the SQL Server instance is running on Linux;
- the SQL endpoint identity captured by the tested connection matches the identity queried through remote `sqlcmd`;
- every selected database is a normal user database, online, writable, and not a snapshot;
- differential backups have an authenticated conventional full base for that database;
- log backups have an authenticated full anchor and the database uses Full or Bulk-Logged recovery;
- the backup staging directory is canonical, bounded, and contains no user-supplied filename components.

## Source and Trust Boundary

A SQL Server physical Source stores only:

- its SQL Server connection ID and selected database names;
- SSH execution connection ID;
- remote temporary and backup staging directories;
- direct or non-interactive sudo privilege mode;
- approved `sqlcmd`, `stat`, `dd`, and `rm` executable names or absolute paths;
- compression preference and backup timeout.

The SQL password remains a device-scoped SecretRef. A run resolves it only after SSH host-key verification and passes it to `sqlcmd` through the process-scoped `SQLCMDPASSWORD` environment variable. Passwords are never placed in arguments, generated SQL, persisted plans, manifests, renderer responses, logs, or public errors. Generated SQL contains only adapter-quoted identifiers and adapter-owned literal values.

The tested connection must require encryption and certificate validation. Trust-server-certificate mode is not accepted for physical protection. SSH and SQL connections must both be successful current-device connections. Native media remains plaintext or TDE-encrypted on the remote staging filesystem only for the duration of the run, then the existing repository layer encrypts and authenticates it in transit and at rest.

## Backup Operations

Each Source produces one database media file and Artifact. Protecting several databases uses separate Sources and Jobs so scheduling, cancellation, retry, retention, differential bases, log forks, and recovery remain database-scoped. A run never creates a multi-database media set.

All backup statements use an isolated file with `WITH INIT`, `CHECKSUM`, `STATS = 5`, an adapter-generated backup name and description, and `COMPRESSION` when the server proves support. DeployerX does not use `FORMAT`, append to existing media, set passwords on backup sets, or overwrite an unowned path.

### Full

A scheduled or manual full operation issues `BACKUP DATABASE`. Conventional full backups are the default and establish the base for later differentials. Optional copy-only full backups may be added as a manual export feature, but they are not chain anchors and must not update the Job's differential base.

### Differential

A differential operation issues `BACKUP DATABASE ... WITH DIFFERENTIAL`. It requires the newest authenticated conventional full backup for the same workspace, Job, Source, database identity, database family, and recovery fork. After backup, `RESTORE HEADERONLY` must report a `DatabaseBackupLSN` and differential-base identity matching that full point. A differential never depends on an earlier differential.

### Transaction log

A transaction-log operation issues `BACKUP LOG`. It requires Full or Bulk-Logged recovery and at least one authenticated full anchor. Log chains remain independent of later full and differential backups. Each point records `FirstLSN`, `LastLSN`, `CheckpointLSN`, recovery-fork identifiers, `BeginsLogChain`, and `HasBulkLoggedData` from authenticated header metadata.

The new point must continue the selected database's authenticated recovery fork without an unexplained gap. Overlap at media boundaries is accepted because SQL Server backup-set LSN ranges can overlap; a strict numeric equality between one `LastLSN` and the next `FirstLSN` is not assumed. Restore planning asks SQL Server to validate the ordered headers and refuses missing parents, fork changes without a valid fork point, or a log whose database backup LSN predates the selected anchor.

Bulk-Logged backups containing bulk-logged changes are recoverable only to the end of that log backup, not to an arbitrary time inside it. The UI and restore planner must refuse a `STOPAT` target that would stop inside an authenticated `HasBulkLoggedData` interval.

### Tail log

Tail-log backup is a restore safety operation, not a recurring Job mode. Before an original-database destructive restore, DeployerX offers or requires a tail capture when the target database is online and uses Full or Bulk-Logged recovery.

- Online destructive recovery uses `BACKUP LOG ... WITH NORECOVERY, CHECKSUM, INIT`; this captures the tail and leaves the database in the restoring state so no later writes can escape the chain.
- An offline database with an accessible log may use `NO_TRUNCATE` after explicit warning.
- A damaged database may add `CONTINUE_AFTER_ERROR` only after a second high-risk confirmation; the resulting point is marked degraded.
- `NORECOVERY` and `NO_TRUNCATE` are not combined.

The tail media is validated and published before the selected restore overwrites database files. Failure to publish a required tail point stops the restore. A header with `HasIncompleteMetadata` is preserved as such and never silently treated as a normal complete log point. Simple-recovery databases have no tail-log workflow.

## Native Media Authentication

After each backup, DeployerX queries `RESTORE HEADERONLY`, `RESTORE FILELISTONLY`, and `RESTORE VERIFYONLY WITH CHECKSUM`. Publication requires exactly one expected backup set, a successful verify, nonempty bounded media, safe logical file metadata, and identity equality with the live database.

Authenticated metadata includes:

- backup type and position;
- database name, database version, recovery model, and compatibility level;
- backup start/finish times and first/last/checkpoint/database-backup LSNs;
- differential-base LSN and GUID;
- backup-set, family, media-family, and recovery-fork GUIDs;
- fork-point LSN, begins-log-chain, copy-only, bulk-logged-data, incomplete-metadata, and checksum flags;
- SQL Server product version, instance identity, database ID, database family GUID, and source connection revision;
- logical file names, types, sizes, and unique IDs from `FILELISTONLY`;
- media size, repository digest, parent RecoveryPoint, and chain root.

Backup operations execute `RESTORE HEADERONLY`, `RESTORE FILELISTONLY`, and `RESTORE VERIFYONLY`; stable chain metadata is then projected from `msdb` through bounded `FOR JSON` queries. JSON structure, field types, lengths, identity, and duplicate bounds are validated. Localized human-readable command output is not treated as evidence.

## Restore Chain

A restore plan is built for exactly one database:

1. Select one authenticated conventional full backup.
2. For a differential RecoveryPoint, append that differential only after proving its exact base GUID against the full.
3. For a transaction-log RecoveryPoint, select the ordered, gap-free log parent chain on the compatible recovery fork after the full. This release deliberately restores full plus logs rather than opportunistically inserting a differential; the sequence remains valid but can restore more log media.
4. Optionally append a newly captured tail-log point from the original target.
5. Stop at the end of the chain or at an explicit UTC timestamp covered by a log backup.

The full and optional differential are restored with `NORECOVERY`. Logs are restored in SQL Server-approved order with `NORECOVERY`; the final operation uses `RECOVERY`, or the final log uses `STOPAT` and `RECOVERY`. Original recovery requires exact destructive confirmation and verified target identity. `REPLACE`, `KEEP_REPLICATION`, `KEEP_CDC`, `STANDBY`, `RESTART`, and restricted-user modes are outside this release.

Every media file is authenticated by the repository before it reaches SQL Server. DeployerX stages files into a unique run-owned remote directory, verifies their byte counts and digests, reruns `RESTORE HEADERONLY` and `RESTORE VERIFYONLY`, and compares all chain fields with the stored Artifact metadata before changing the target.

## File Relocation and Target Modes

Original restore uses the protected database name. Alternate restore requires an explicit valid target database name and fails if it already exists. Alternate replacement is intentionally outside this release so a native restore cannot silently overwrite an unrelated database.

`RESTORE FILELISTONLY` is authoritative for logical files. Every logical file receives an explicit `MOVE` destination beneath configured canonical SQL Server data or log roots. Names are adapter-generated from a hash and stable ordinal; logical names never become filesystem path components. Existing paths, symlink escapes, duplicate targets, FILESTREAM containers, memory-optimized containers, and files outside approved roots are refused. The configured SQL Server service account must own the destination roots.

After recovery, DeployerX reconnects through the target SQL Server connection and proves database state `ONLINE`, expected target name, supported server version, database family identity policy, recovery model, and a database query at the recorded recovery point. `DBCC CHECKDB` is available as an explicit deep-validation option because it can be resource intensive; default validation runs `DBCC CHECKDB ... WITH PHYSICAL_ONLY, NO_INFOMSGS` when enabled by policy.

## TDE and Encrypted Backups

Repository encryption does not replace SQL Server Transparent Data Encryption prerequisites. A TDE-protected database can be backed up, but restore requires the protecting certificate or asymmetric key and private key to already exist in `master` on the target instance. DeployerX detects encryption metadata and blocks alternate restore until the target proves the matching thumbprint is available.

Native SQL Server backup encryption is not created by BM-404 because repository encryption owns storage keys and rotation. Existing externally created encrypted media is not imported unless a future workflow can resolve its encryptor without exposing secrets.

## Availability Groups and Replicas

BM-404 does not orchestrate availability groups. A database participating in an availability group is rejected by default. A future replica-aware mode must honor the availability-group backup preference, prove replica synchronization and role, preserve backup priority, coordinate copy-only full behavior, and prevent automated original restore from breaking the topology. Operators must remove or isolate a database from HA, replication, log shipping, and dependent jobs before current restore workflows can target it.

## Retention and Failure Semantics

Retention protects every full base, selected differential, transaction-log point, recovery-fork transition, and tail point needed by a retained descendant. Deleting a conventional full does not break the independent log chain when another retained full can seed recovery, but a retained differential always pins its exact full base. A new conventional full starts a new differential base; it does not start a new log chain.

Cancellation terminates active SSH and `sqlcmd` processes and removes only the recorded run-owned staging paths. An interrupted backup publishes no point. An interrupted restore is never auto-resumed after the first database state change; the RestoreRun is reconciled as requiring operator attention. DeployerX never claims rollback after `NORECOVERY`, `DROP DATABASE`, or the first `RESTORE` statement.

## Recovery and Activity UI

SQL Server Sources expose tested engine identity, selected databases, recovery models, staging configuration, and operation readiness. Job configuration offers full, differential, or transaction-log mode only when every selected database is eligible. Tail-log capture appears only inside destructive recovery.

Recovery groups points by database and chain. It displays full base, matching differential, ordered logs, fork, coverage window, bulk-logged limitations, and whether a new tail capture is required. The restore form supports original or alternate instance, target database name, end-of-chain or UTC time, optional deep validation, and explicit data/log roots. High-risk tail options and destructive replacement each require independent confirmation.

Activity records the normalized operation, database, backup type, LSN/fork range, base and parent IDs, copy-only/bulk-logged/incomplete flags, native verification, media size, restore target, tail-log result, validation evidence, cancellation boundary, and terminal state. Repository locators, SQL text containing secrets, and credentials are never returned to the renderer.

## Verification Boundary

`RESTORE VERIFYONLY` checks that SQL Server can read and interpret the complete backup set; it does not validate the logical structure of the database or prove that a restore will succeed on a different instance. Therefore restore completion requires authenticated media checks, native header and verify checks, an actual restore sequence, online database state, SQL connectivity, identity/version evidence, and optional `DBCC CHECKDB` evidence.

BM-404 acceptance requires focused tests for identifier/literal quoting, header parsing, version and platform checks, secret isolation, selected-database execution, full/differential/log eligibility, differential-base authentication, recovery-fork ordering, bulk-logged `STOPAT` refusal, tail-log modes and confirmations, multi-repository byte identity, remote cleanup, media tamper refusal, relocation safety, TDE prerequisite refusal, availability-group refusal, cancellation, startup reconciliation, audited IPC, and responsive renderer containment.

## Official Microsoft References

- [Backup overview](https://learn.microsoft.com/en-us/sql/relational-databases/backup-restore/backup-overview-sql-server?view=sql-server-ver17)
- [Differential backups](https://learn.microsoft.com/en-us/sql/relational-databases/backup-restore/differential-backups-sql-server?view=sql-server-ver17)
- [Transaction-log backups](https://learn.microsoft.com/en-us/sql/relational-databases/backup-restore/transaction-log-backups-sql-server?view=sql-server-ver17)
- [Tail-log backups](https://learn.microsoft.com/en-us/sql/relational-databases/backup-restore/tail-log-backups-sql-server?view=sql-server-ver17)
- [`BACKUP` Transact-SQL](https://learn.microsoft.com/en-us/sql/t-sql/statements/backup-transact-sql?view=sql-server-ver17)
- [Plan and perform restore sequences](https://learn.microsoft.com/en-us/sql/relational-databases/backup-restore/plan-and-perform-restore-sequences-full-recovery-model?view=sql-server-ver17)
- [`RESTORE HEADERONLY`](https://learn.microsoft.com/en-us/sql/t-sql/statements/restore-statements-headeronly-transact-sql?view=sql-server-ver17)
- [`RESTORE FILELISTONLY`](https://learn.microsoft.com/en-us/sql/t-sql/statements/restore-statements-filelistonly-transact-sql?view=sql-server-ver17)
- [`RESTORE VERIFYONLY`](https://learn.microsoft.com/en-us/sql/t-sql/statements/restore-statements-verifyonly-transact-sql?view=sql-server-ver17)
