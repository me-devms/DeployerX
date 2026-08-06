# MySQL Physical Backup and Restore

## Status and scope

BM-402 uses Percona XtraBackup 8.4 as the approved physical backup engine. The first release is intentionally limited to a supportable, fail-closed compatibility envelope:

- MySQL Community or Percona Server 8.4.x on Linux.
- Percona XtraBackup 8.4.x and `xbstream` 8.4.x on the protected and restore host.
- One whole MySQL instance. Database, table, partition, and transportable-tablespace selection are not supported.
- One tested DeployerX MySQL connection paired with one tested, host-key-pinned Linux SSH connection on the current device.
- Hot full and LSN-based incremental backups.
- Repository encryption, authentication, retention dependency protection, and restore-chain verification through the existing Backup Manager repository engine.
- Original-host or explicitly paired alternate-host recovery after destructive confirmation and native preflight.

MySQL 8.0, MySQL 9.x, Windows servers, MariaDB, partial physical backup, MySQL Clone Plugin, MySQL Enterprise Backup, storage snapshots, replicas, Galera, Group Replication orchestration, and cross-major recovery are outside BM-402. MySQL 8.0 requires a separately maintained XtraBackup 8.0 compatibility line, which reached end of life in June 2026, so it is not silently accepted.

## Why Percona XtraBackup

Percona XtraBackup creates hot physical backups and supports full, incremental, prepare, and copy-back workflows. It produces repository-storable files and has a documented open format through `xbstream`. MySQL Clone Plugin copies data directly between instances and is not a general repository backup format. MySQL Enterprise Backup is commercial and cannot be assumed to exist on an operator's server.

Official references:

- [Percona XtraBackup 8.4 documentation](https://docs.percona.com/percona-xtrabackup/8.4/index.html)
- [Create a full backup](https://docs.percona.com/percona-xtrabackup/8.4/create-full-backup.html)
- [Create an incremental backup](https://docs.percona.com/percona-xtrabackup/8.4/create-incremental-backup.html)
- [Take a streaming backup](https://docs.percona.com/percona-xtrabackup/8.4/take-streaming-backup.html)
- [Prepare a full backup](https://docs.percona.com/percona-xtrabackup/8.4/prepare-full-backup.html)
- [Prepare an incremental backup](https://docs.percona.com/percona-xtrabackup/8.4/prepare-incremental-backup.html)
- [Restore a backup](https://docs.percona.com/percona-xtrabackup/8.4/restore-a-backup.html)
- [Privileges needed](https://docs.percona.com/percona-xtrabackup/8.4/privileges.html)

The upstream contract requires a prepared backup before restore, an empty datadir, and a stopped MySQL server for copy-back. Incremental prepare applies the full backup with `--apply-log-only`, applies every incremental directory in order, and performs the final prepare without `--apply-log-only`.

## Source model

A physical Source retains the MySQL adapter ID so discovery, server identity, and credential ownership remain attached to the tested MySQL connection. Its consistency request uses `backupMethod: physical` and stores a separate execution binding:

```json
{
  "backupMethod": "physical",
  "backupMode": "full",
  "requestedLevel": "application",
  "physicalExecution": {
    "sshConnectionId": "conn_...",
    "remoteTemporaryDirectory": "/var/tmp",
    "dataDirectory": "/var/lib/mysql",
    "serviceName": "mysql",
    "mysqlOwner": "mysql",
    "mysqlGroup": "mysql",
    "privilegeMode": "sudo-noninteractive",
    "xtrabackupExecutable": "xtrabackup",
    "xbstreamExecutable": "xbstream",
    "mysqlExecutable": "mysql"
  }
}
```

The selected SSH connection is a second connection boundary, not a credential embedded in the MySQL Source. Both connections must be successful, current-device connections. Every use revalidates the pinned SSH host key before resolving SSH secrets.

## Preflight

Every physical run repeats these checks before creating data:

1. The Source selects the whole instance and has no database, schema, table, or global-object filters.
2. The MySQL and SSH records still match the immutable run snapshot and remain tested on the current device.
3. MySQL reports an 8.4.x version and stable `@@server_uuid`.
4. The remote MySQL client reaches the same `@@server_uuid`; equality prevents a paired SSH host from backing up a different local instance.
5. XtraBackup and xbstream both report compatible 8.4.x versions.
6. The configured datadir is the server's reported datadir after canonical normalization.
7. The SSH identity can read and traverse the datadir, create a mode-0700 working directory, and run the configured privilege mode without an interactive prompt.
8. The MySQL account exposes the required XtraBackup privileges. The baseline is `BACKUP_ADMIN`, `PROCESS`, `RELOAD`, `LOCK TABLES`, and `REPLICATION CLIENT`, plus documented performance-schema reads where required by the installed engine.
9. Incremental runs have one authenticated predecessor for the same workspace, Source, job, MySQL server UUID, adapter, engine major/minor, and full anchor.

Preflight output and stderr are bounded and secret-redacted. Passwords and private keys never appear in a process argument, renderer payload, Run, Artifact, or log record. A temporary MySQL option file is uploaded with mode 0600 and removed in cleanup.

## Backup execution

The remote backup is created in a unique mode-0700 directory below the configured temporary root:

```text
xtrabackup --defaults-extra-file=<secret-file> --backup --target-dir=<run-dir>/data
```

An incremental adds:

```text
--incremental-lsn=<authenticated previous to_lsn>
```

DeployerX reads and validates `xtrabackup_checkpoints`, including `backup_type`, `from_lsn`, `to_lsn`, and `last_lsn`, before publication. It then streams the completed directory as one xbstream artifact over the already verified SSH session. The existing repository engine chunks, authenticates, encrypts, and publishes that stream. Plaintext is not written to local disk. The remote working directory is removed after publication or failure.

An incremental is accepted only when its `from_lsn` equals the authenticated predecessor `to_lsn`, its `to_lsn` is not lower, and its full anchor is unchanged. Percona warns that an incorrect `--incremental-lsn` is not detected automatically, so this equality and the repository-authenticated chain are mandatory DeployerX safeguards.

## RecoveryPoint and Artifact metadata

Each physical Artifact records bounded authenticated metadata:

- engine and adapter version;
- XtraBackup and xbstream versions;
- MySQL server UUID and identity fingerprint;
- full or incremental backup type;
- `fromLsn`, `toLsn`, and `lastLsn` as decimal strings;
- full-anchor RecoveryPoint ID and direct parent RecoveryPoint ID;
- source and SSH connection IDs and revisions;
- datadir, service name, owner/group, and privilege mode;
- xbstream byte count and repository checksum.

Physical RecoveryPoints use type `full` for an anchor and `incremental` for a delta. Retention cannot remove an anchor or intermediate delta while a retained descendant depends on it. A new full anchor starts a new independent chain.

## Restore contract

Restore materializes every authenticated Artifact from the full anchor through the selected point into separate mode-0700 directories on the target host. Extraction rejects absolute paths, parent traversal, links escaping the extraction root, device nodes, sockets, and paths outside the allocated restore workspace.

Preparation is ordered:

1. Extract the full xbstream.
2. Run `xtrabackup --prepare --apply-log-only` against the full directory when deltas follow.
3. Extract and apply each incremental exactly once with `--incremental-dir`, retaining `--apply-log-only` until the last delta.
4. Run the final prepare without `--apply-log-only`.
5. Re-read checkpoint metadata and require the prepared `to_lsn` to equal the selected RecoveryPoint.

Before copy-back, DeployerX requires the target MySQL connection and paired SSH connection to pass identity and compatibility preflight. The operator must enter the exact destructive confirmation. DeployerX then:

1. Stops the configured service and proves it is inactive.
2. Resolves and verifies the configured datadir.
3. Requires the datadir to be empty. BM-402 never deletes or renames an existing datadir automatically.
4. Runs `xtrabackup --copy-back` with the explicit target and datadir.
5. Recursively sets the explicitly configured MySQL owner and group without following external links.
6. Starts the service and waits for it to become active.
7. Connects through the target MySQL record, requires MySQL 8.4, validates the expected server UUID for original recovery or a regenerated UUID for alternate recovery, and persists service, connectivity, version, and identity evidence in the RestoreRun.

If service restart or validation fails, the RestoreRun fails and leaves the restored datadir for operator inspection. DeployerX does not attempt an automatic rollback or delete restored files.

## Cancellation and crash behavior

Cancellation closes active SSH channels and performs best-effort removal of only the recorded run-owned working directory. It never removes the datadir. A process restart marks an active physical run interrupted. Physical backups and restores are retried from a fresh remote workspace; prepare and copy-back are never resumed from an unknown partial state.

## Security boundaries

- SSH always uses the approved SHA-256 host-key fingerprint.
- SSH and MySQL secrets remain SecretRefs and are resolved only after trust checks.
- Remote paths are canonical absolute Linux paths and shell arguments are generated only by the adapter with single-argument quoting.
- Executable and service identifiers are allowlisted; arbitrary shell fragments are rejected.
- All command output is bounded, classified, and redacted before persistence.
- Repository encryption is mandatory. XtraBackup's optional native encryption is not used in BM-402 because repository encryption already owns keys, rotation, and verification.
- `sudo-noninteractive` uses only `sudo -n --`; an interactive prompt is a preflight failure.

## Known limitations

- Whole-instance restore includes system schemas and server-level physical state. It is intentionally not an item-level restore path.
- The target must have enough temporary capacity for the materialized full chain plus the final datadir copy.
- Alternate-host restore requires a separately tested MySQL 8.4 and pinned SSH pair with matching XtraBackup 8.4 tools and an empty approved datadir.
- Keyring, encrypted tablespace, component, plugin, and external tablespace configurations must already exist compatibly on the restore host. DeployerX reports detected configuration but does not migrate external key management in BM-402.
- Group Replication, InnoDB Cluster, asynchronous replica reconfiguration, and Galera bootstrap are operator-owned after physical restore.

## Acceptance evidence

BM-402 is complete only after focused tests prove full and incremental planning, incorrect LSN refusal, server-pair mismatch refusal, secret-safe remote execution, encrypted publication, authenticated chain restore, unsafe extraction refusal, non-empty datadir refusal, stopped-service enforcement, ownership repair planning, restart, native validation, cancellation cleanup, and UI containment. All existing Backup Manager unit and Electron integration suites must also pass.
