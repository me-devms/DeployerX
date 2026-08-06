# Oracle RMAN Backup and Recovery Contract

Status: BM-405 implemented and verified. This document is the acceptance contract for the supported Oracle release.

Implemented: TCPS/SecretRef connections, whole-database Sources, pinned-SSH RMAN execution, full and level-0 anchors, level-1 differential and cumulative backups, archived-redo capture, explicit control-file/SPFILE media, repository publication, RecoveryPoint projection, original-instance recovery, absent-target alternate-instance duplication, latest/SCN/sequence/UTC-time targets, independent RESETLOGS confirmation, validation, cancellation/reconciliation, audited main/preload APIs, and Sources/Jobs/Recovery/Activity UI workflows.

Alternate recovery uses an immutable, SSH-based absent-target profile rather than a normal Oracle Source. The profile pins the tested SSH connection, Oracle home and owner, SID/DB_NAME, DB_UNIQUE_NAME, private staging root, three separate non-nested Oracle Managed Files destinations, fast-recovery-area capacity, privilege mode, and constrained native tools. It proves that destination roots, SID parameter/password files, PMON identity, and `/etc/oratab` registration are absent immediately before creating the target.

## Release Scope

The first Oracle release protects one complete Oracle database per DeployerX Source by using Recovery Manager (RMAN). A Source represents one DBID and one incarnation lineage, not an arbitrary collection of schemas or pluggable databases.

The compatibility envelope is:

- Oracle Database 19c, 21c, and 23ai on Linux x86-64;
- a single-instance primary database, either a non-CDB or an entire CDB;
- an open read/write database in `ARCHIVELOG` mode for online backups;
- one tested, TCPS certificate-verified Oracle control connection paired with one tested host-key-pinned SSH execution connection;
- RMAN and SQL*Plus from the same Oracle home and major release as the protected database;
- disk backup sets staged in a private remote directory and then streamed into DeployerX repositories;
- full database, level-0, level-1 differential, level-1 cumulative, archived-redo, current control-file, and SPFILE backup artifacts;
- recovery to the original database or to an absent alternate database with an explicitly prepared Oracle home and storage layout.

The initial release does not silently approximate unsupported Oracle features. RAC, Data Guard role orchestration, PDB-only recovery, Windows, Exadata-specific orchestration, proxy copies, tape/SBT channels, Zero Data Loss Recovery Appliance integration, cross-platform transport, cross-major upgrade recovery, duplicate-from-active-database, and automatic catalog-database administration are outside this release. Such Sources fail compatibility checks or remain unavailable in the UI.

## Terminology and Mode Mapping

DeployerX exposes three policy modes while retaining exact RMAN semantics in Artifact metadata:

| DeployerX mode | RMAN operation | Chain meaning |
| --- | --- | --- |
| `full` | Full database backup or `INCREMENTAL LEVEL 0` anchor | Starts a new repository recovery chain |
| `incremental` | `INCREMENTAL LEVEL 1` differential plus required archived redo | Depends on the most recent valid level-0 anchor |
| `differential` | `INCREMENTAL LEVEL 1 CUMULATIVE` plus required archived redo | Depends directly on the most recent valid level-0 anchor |
| `native` | Archived redo plus a current control file | Extends the authenticated redo boundary without a data-file backup |

An RMAN full backup is not interchangeable with an incremental level-0 backup inside an incremental strategy. Every Artifact records `backupKind`, `incrementalLevel`, and `cumulative`; planners must never infer these fields from a display label.

Archived-redo capture is represented as a transaction-log RecoveryPoint. It carries exact thread, sequence, first-change, next-change, resetlogs-change, and incarnation evidence. It must not be labeled as a data-file incremental.

## Trust and Credential Boundary

The Oracle control connection uses Oracle SQL*Plus over TCPS with server certificate identity matching enabled. Plain TCP, `ssl_server_dn_match=no`, acceptance of an unknown certificate, and password-bearing process arguments are forbidden.

The control credential is a device-scoped SecretRef and is resolved only at execution time. The password is delivered to SQL*Plus through bounded process standard input, never through command arguments, persisted endpoint data, renderer payloads, logs, or audit details. The account connects with the `SYSBACKUP` administrative privilege. `SYSDBA` is not the default control-plane privilege.

Native RMAN execution occurs on the database host through the existing SSH connection contract. The SSH connection must have a pinned host-key fingerprint and current successful test evidence. RMAN uses operating-system authentication as a dedicated Oracle software owner through an explicit non-interactive privilege mode. DeployerX does not construct a remote `target user/password@service` command.

Before every backup or restore, DeployerX proves that the SQL control connection and SSH execution context reach the same database by comparing DBID, `DB_UNIQUE_NAME`, database name, platform, version, Oracle home evidence, and instance host identity. A mismatch is an integrity failure.

Secrets and sensitive locators are redacted before errors cross an IPC boundary. Temporary password/script files are mode-restricted, removed during normal cleanup, and reconciled after interruption.

## Source Contract

An Oracle Source stores:

- the Oracle connection ID and paired SSH connection ID;
- exactly one discovered database identity: DBID, database name, and `DB_UNIQUE_NAME`;
- the authenticated incarnation ID, resetlogs SCN/time, platform, role, open mode, log mode, CDB flag, and Oracle version;
- the remote temporary directory and backup-piece directory;
- Oracle owner and group, Oracle home, Oracle SID, and non-interactive privilege mode;
- configurable `sqlplus`, `rman`, `stat`, `dd`, and `rm` executable names constrained to their expected basenames;
- optional data-file, fast-recovery-area, and redo-log destination roots for restore planning;
- an immutable capability snapshot and current-device affinity.

Selection is database-wide. Schema, table, PDB, tablespace, data-file, and system-object filters are rejected for native RMAN Sources. A user can create separate Sources for separate Oracle databases, but two Sources cannot share RecoveryPoint ownership.

Source readiness requires current successful Oracle and SSH tests, matching worker affinity, unchanged endpoint trust, a supported version and Linux platform, `PRIMARY` role, `READ WRITE` open mode, `ARCHIVELOG`, one enabled instance, no RAC topology, and sufficient `SYSBACKUP` and operating-system privileges.

## Native Preflight

Every run repeats mutable checks rather than trusting Source-creation evidence:

1. Resolve the Oracle SecretRef and verify the TCPS control connection.
2. Open the pinned SSH session and create a private run directory.
3. Resolve the configured Oracle home and prove `sqlplus` and `rman` versions.
4. Connect locally as `SYSBACKUP` and prove DBID, database unique name, role, open mode, log mode, incarnation, and instance count.
5. Refuse RAC, standby roles, changed DBID, changed resetlogs lineage, and inconsistent Oracle homes.
6. Verify writable staging space and obtain bounded free-space evidence.
7. Inspect RMAN configuration without mutating global retention, channel, encryption, compression, control-file-autobackup, or deletion policies.
8. Determine the required parent/root RecoveryPoints and authenticate their manifests before starting RMAN.

Warnings are allowed only for declared non-integrity conditions. Missing chain evidence, ambiguous incarnations, log gaps, unsupported media, or identity mismatch always fail closed.

## Backup Workflows

### Full and Level-0 Anchors

A full anchor creates data-file backup sets plus separate current-control-file and SPFILE backup sets. The RMAN command uses a unique DeployerX tag and collision-resistant piece format constrained to the private run directory.

The job configuration distinguishes a true RMAN full from an incremental level-0 anchor. Incremental policies use level 0. A standalone full policy may use a true full backup but cannot later be used as a level-1 parent.

After RMAN exits successfully, DeployerX queries authenticated RMAN/control-file metadata for every piece and records checkpoint SCN/time, completion time, DBID, database name, incarnation, resetlogs SCN/time, file count, piece count, tag, compression/encryption flags, and RMAN status. Every piece is size-bounded, hashed while streaming, published through the repository engine, and deleted only after all required repository copies commit.

### Level-1 Differential and Cumulative

A level-1 differential requires the newest usable level-0 anchor in the same Source, job, DBID, incarnation, and resetlogs lineage. Its parent is the most recent accepted level-0 or level-1 data-file RecoveryPoint; its chain root is the level-0 RecoveryPoint.

A level-1 cumulative requires the same authenticated level-0 anchor but depends directly on that anchor for data-file reconstruction. The Artifact still records the most recent log boundary so redo continuity remains explicit.

Block Change Tracking may improve RMAN performance when already enabled, but DeployerX does not enable it automatically. BCT state and file identity are evidence, not correctness prerequisites.

### Archived Redo

An archived-redo run forces the current redo to archive, waits for completion, then captures every required archived log after the last authenticated boundary. Each thread/sequence range must have continuous first-change/next-change coverage and the same resetlogs lineage.

The first release supports a single redo thread because RAC is excluded. `DELETE INPUT`, `DELETE ALL INPUT`, and RMAN repository cleanup are forbidden. Repository retention, not RMAN deletion policy, controls DeployerX copies.

The log Artifact records the start/end SCN and UTC coverage window, sequence range, thread, resetlogs SCN/time, incarnation, parent RecoveryPoint, and level-0 chain root. No-log and gap conditions are explicit outcomes; they are never published as successful continuous log points.

### Control File and SPFILE

Every data-file anchor includes explicit `BACKUP CURRENT CONTROLFILE` and `BACKUP SPFILE` pieces. Archived-redo policies can additionally capture a current control file when its structural checkpoint is newer than the last protected copy.

Control-file and SPFILE pieces remain separately typed inside the Artifact manifest so restore ordering is deterministic. DeployerX does not enable or disable RMAN control-file autobackup globally. Existing autobackups may be inventoried but are not treated as DeployerX recovery media unless they were explicitly captured and authenticated by a run.

## Artifact and RecoveryPoint Contract

The Oracle manifest contains no password, command script, repository locator, or Oracle wallet secret. Authenticated metadata includes:

- format version, adapter ID/version, Source/job/run identity, creation time, and native operation;
- DBID, database name, `DB_UNIQUE_NAME`, CDB flag, platform, version, role, and Oracle home fingerprint;
- incarnation key, resetlogs SCN/time, checkpoint SCN/time, and database control-file type;
- backup kind, incremental level, cumulative flag, tag, RMAN session/command identifiers, and completion status;
- each backup set and piece key, handle digest, media type, status, byte size, checksum, compression/encryption flags, and repository object mapping;
- data-file checkpoint bounds and archived-log thread/sequence/SCN/time ranges;
- current control-file and SPFILE piece identities;
- parent, level-0 root, and previous-log RecoveryPoint IDs;
- preflight, native validation, publication, cleanup, cancellation, and warning evidence.

A RecoveryPoint is available only when all required pieces and repository copies are committed and the manifest validates. Partial RMAN output remains run evidence and is never projected as a restorable point.

## Chain and Retention Rules

Restore-chain selection authenticates every manifest and requires one DBID, adapter compatibility family, Source/job lineage, incarnation/resetlogs lineage, and continuous redo coverage. An incompatible incarnation is never bridged automatically.

Level-1 and archived-redo points retain their level-0 root and all required parents. Expiring a root expires or re-roots dependent points as one planned retention mutation. Copy repair and repository deletion operate on complete multi-piece Artifacts.

DeployerX does not issue RMAN `DELETE OBSOLETE`, change the RMAN retention policy, or assume that RMAN catalog state is the source of truth for DeployerX retention.

## Restore Workflows

Restore is a staged, cancelable operation with durable execution state. Planning verifies the selected RecoveryPoint, all required pieces, repository checksums, target compatibility, storage destinations, free space, Oracle owner, Oracle home, listener expectations, and destructive confirmations before stopping or creating an instance.

The native sequence is:

1. Materialize authenticated pieces in a private target staging directory.
2. Validate byte sizes and hashes before Oracle reads the media.
3. Start the target instance in `NOMOUNT` with a generated, reviewed bootstrap PFILE when required.
4. Restore the SPFILE when selected, restart `NOMOUNT`, then restore the authenticated control file.
5. Mount the database and catalog only the materialized DeployerX pieces.
6. Restore the level-0/full plus required level-1 data-file sets.
7. Recover with continuous archived redo to the selected latest point, SCN, sequence, or UTC time.
8. Open normally when no resetlogs boundary was introduced, or require explicit `OPEN RESETLOGS` confirmation and record the new incarnation.
9. Prove database identity, role, open mode, incarnation, data-file status, redo status, and SQL connectivity.
10. Optionally run deep native validation and record exact checks without exposing SQL or media locators.

Original restore is destructive and requires an exact confirmation phrase. It starts from a generated minimal PFILE, so recovery does not depend on the original SPFILE still being available locally, then restores the authenticated SPFILE and control file in native order.

Alternate restore requires a second exact confirmation and an absent Oracle SID/database destination. It stages and authenticates media before mutation, repeats the absence preflight, creates only the three requested destinations, starts an auxiliary instance from a generated PFILE, and runs backup-based `DUPLICATE DATABASE ... BACKUP LOCATION ... SPFILE`. RMAN receives `DB_CREATE_FILE_DEST`, `DB_CREATE_ONLINE_LOG_DEST_1`, and `DB_RECOVERY_FILE_DEST`; `NOFILENAMECHECK` is never used. The duplicate must open with a new DBID and the requested DB_NAME/DB_UNIQUE_NAME, then pass local identity, optional logical block, and listener-registration validation. Existing targets are never overwritten or deleted.

ASM source media, TDE wallets/keystores, RAC, Data Guard orchestration, external password-file provisioning, and application-specific external dependencies remain unsupported and fail before mutation.

## Recovery Targets

The UI exposes only targets supported by the authenticated chain:

- latest available point;
- exact SCN within captured coverage;
- archived-log sequence for thread 1;
- UTC time within captured archived-redo coverage.

Time targets are normalized to UTC and mapped to RMAN `SET UNTIL TIME` without locale-dependent formatting. SCNs and sequences are bounded decimal integers and are never interpolated without validation. The planner shows the chosen incarnation and whether `OPEN RESETLOGS` will be required.

## Validation Boundary

Backup completion requires successful RMAN status, complete piece inventory, exact size and checksum evidence, authenticated database/control-file metadata, repository publication, and cleanup evidence. RMAN success text alone is insufficient.

Native validation uses RMAN `RESTORE ... VALIDATE` or `VALIDATE BACKUPSET` against the captured pieces without restoring production files. Restore completion additionally proves the actual opened database and connectivity boundary. Original recovery repeats the configured TCPS identity check. Alternate recovery proves its new DBID, requested database identity, role/open/log mode, CDB topology, and listener service registration. Optional deep validation may include `VALIDATE DATABASE CHECK LOGICAL`; it is a separately disclosed, potentially expensive operation.

RMAN validation cannot prove application-level correctness. The UI describes native structural validation accurately and does not label it as application verification.

## Cancellation and Reconciliation

Cancellation terminates the active SSH/RMAN process group, prevents new repository commits, waits for process termination, removes unpublished temporary media, and persists a terminal canceled run. Already committed immutable objects are reconciled through the repository transaction rules.

Startup reconciliation inspects durable Oracle execution records, repository mutations, temporary-path leases, and restore stages. It resumes only idempotent publication/cleanup work. Native RMAN backup or restore commands are never blindly replayed after an uncertain interruption.

## UI and Activity Requirements

Sources must support Oracle connection creation, testing, database discovery, SSH pairing, Oracle home/SID/owner settings, staging and restore roots, executable settings, and a read-only compatibility summary.

Jobs expose full/level-0, level-1 differential, level-1 cumulative, and archived-redo scheduling without collapsing their chain semantics. Recovery displays DBID, database unique name, incarnation, checkpoint SCN, archived-log bounds, control-file/SPFILE availability, required chain, target mode, resetlogs consequence, and validation options.

Activity records backup level, piece counts/bytes, checkpoint and redo coverage, parent/root IDs, RMAN validation, repository copies, restore target, recovered SCN, new incarnation, cancellation boundary, warnings, and terminal state. Credentials, wallet details, native scripts, and media/repository locators never enter renderer payloads.

## BM-405 Acceptance Matrix

BM-405 is complete only after focused automated coverage proves:

- TCPS identity enforcement, SecretRef isolation, SQL*Plus/RMAN tool validation, and safe error mapping;
- DBID/incarnation/version/platform parsing and connection-to-SSH identity pairing;
- one-database selection and fail-closed RAC, standby, PDB-only, NOARCHIVELOG, and unsupported-version behavior;
- full/level-0, level-1 differential, level-1 cumulative, archived-redo, control-file, and SPFILE execution;
- exact piece inventory, checksums, multi-repository byte identity, parent/root linkage, redo continuity, and incarnation refusal;
- remote cleanup, cancellation, restart reconciliation, retention dependencies, and tamper refusal;
- original/alternate restore, destination safety, control-file/SPFILE ordering, recovery targets, resetlogs confirmation, and post-restore validation;
- audited main/preload APIs and complete Sources, Jobs, Recovery, and Activity UI workflows;
- focused backend tests, repository integration, Electron integration, mobile containment, and regression coverage without running a development server or build.

## Official Oracle References

- [Oracle Database Backup and Recovery User's Guide 19c](https://docs.oracle.com/en/database/oracle/oracle-database/19/bradv/)
- [Oracle Database Backup and Recovery User's Guide 23ai](https://docs.oracle.com/en/database/oracle/oracle-database/23/bradv/)
- [RMAN backup concepts](https://docs.oracle.com/en/database/oracle/oracle-database/19/bradv/rman-backup-concepts.html)
- [Backing up the database with RMAN](https://docs.oracle.com/en/database/oracle/oracle-database/19/bradv/backing-up-database.html)
- [RMAN incremental backups](https://docs.oracle.com/en/database/oracle/oracle-database/19/bradv/backing-up-database.html#GUID-4A1A6A10-3A8D-4C98-8D6A-7D662AC1818A)
- [Recovering the database with RMAN](https://docs.oracle.com/en/database/oracle/oracle-database/19/bradv/recovering-database.html)
- [Performing complete and point-in-time recovery](https://docs.oracle.com/en/database/oracle/oracle-database/19/bradv/rman-performing-flashback-dbpitr.html)
- [RMAN DUPLICATE command reference](https://docs.oracle.com/en/database/oracle/oracle-database/19/rcmrf/DUPLICATE.html)
- [Validating database files and backups](https://docs.oracle.com/en/database/oracle/oracle-database/19/bradv/validating-database-files-backups.html)
- [Managing archived redo logs](https://docs.oracle.com/en/database/oracle/oracle-database/19/admin/managing-archived-redo-log-files.html)
- [Administrative privilege authentication](https://docs.oracle.com/en/database/oracle/oracle-database/19/dbseg/configuring-authentication.html)
