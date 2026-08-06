# PostgreSQL Base Backup, WAL Archiving, and Point-in-Time Recovery

## Scope

BM-403 adds physical PostgreSQL protection to the existing `deployerx.database.postgresql.logical` adapter. A physical Source protects one whole PostgreSQL cluster with full `pg_basebackup` anchors, captures completed archived WAL as incremental RecoveryPoints, and restores an authenticated chain to the original or an alternate Linux host.

Supported in the first release:

- PostgreSQL Server versions `>=14.0.0 <19.0.0` on Linux;
- one tested PostgreSQL connection paired with one tested host-key-pinned SSH connection owned by the current device;
- primary servers only;
- one whole cluster, with no database, schema, table, or global-object filters;
- no user-defined tablespaces;
- full plain-format `pg_basebackup` anchors with streamed WAL and SHA-256 backup manifests;
- `pg_verifybackup` data, checksum, system-identifier, and required-WAL verification before publication;
- completed WAL-segment capture from an administrator-configured local archive spool;
- ordered full-plus-WAL chains with timeline history files;
- original-host and alternate-host PITR to the end of available WAL, immediately after the base backup, or an explicit UTC time, LSN, transaction ID, or named restore point;
- local, SFTP, and S3 DeployerX repositories through the existing encrypted repository engine.

Standby base backups, user tablespaces, cascading or clustered topologies, automatic `postgresql.conf` mutation, direct repository writes from `archive_command`, cross-major recovery, Windows, partial physical backups, and recovery into an already populated data directory fail closed.

PostgreSQL 17 and 18 provide native block-incremental base backups through `pg_basebackup --incremental`, WAL summaries, and `pg_combinebackup`. That feature is not advertised in this release. Archived WAL RecoveryPoints already provide incremental transfer and PITR across all supported majors; native block-incremental anchors require a separate compatibility and retention contract because they cannot be started directly and every ancestor must remain available for combination.

## Native Prerequisites

The paired Linux host must provide the same PostgreSQL major-version client tools as the protected server:

- `psql` for identity, privilege, configuration, archive, and recovery checks;
- `pg_basebackup` for full anchors;
- `pg_verifybackup` for manifest verification;
- `pg_waldump` for WAL parse validation;
- GNU-compatible `tar` for bounded repository transport;
- `systemctl`, `install`, `find`, `stat`, `cp`, and `chown` for restore orchestration.

The PostgreSQL account must be a superuser or have `REPLICATION`, and `pg_hba.conf` must permit replication connections. It must also be able to execute `pg_control_system()`, inspect settings and `pg_stat_archiver`, and execute `pg_switch_wal()` when archived-WAL capture is enabled.

The server must prove:

- `wal_level` is `replica` or `logical`;
- `full_page_writes` is on;
- `max_wal_senders` leaves two senders available for `pg_basebackup --wal-method=stream`;
- `archive_mode` is `on`;
- exactly one of `archive_command` or, on PostgreSQL 15+, `archive_library` is active;
- the configured archive spool is a canonical absolute path, readable through the approved SSH privilege mode, and on the same host as the PostgreSQL service;
- `data_directory` equals the physical Source configuration;
- there are no user-defined tablespaces.

DeployerX does not rewrite PostgreSQL configuration. The administrator owns the archive command or library and must make completed WAL segment and timeline-history files durably visible in the configured spool. The archive implementation must return success only after durable storage, refuse different-content overwrites, and accept an existing byte-identical file as success. A failing archive must alert operators because `pg_wal` can fill until PostgreSQL shuts down.

## Source and Trust Boundary

A physical Source stores only bounded execution configuration:

- SSH connection ID;
- remote temporary directory;
- PostgreSQL data directory;
- WAL archive directory;
- PostgreSQL service name and filesystem owner/group;
- direct or non-interactive sudo privilege mode;
- approved native executable names or absolute paths.

The database password remains a device-scoped SecretRef. Each run resolves it only after SSH host-key verification and writes a permission-restricted remote passfile. Passwords are absent from command arguments, persisted plans, manifests, renderer responses, logs, and public errors. The passfile and run-owned workspace are removed after success, failure, or cancellation.

Every run compares the remotely queried `pg_control_system().system_identifier` with the identity pinned by the tested PostgreSQL connection. It also compares the remote `data_directory`, server major version, and recovery role. A different cluster, version, datadir, or a standby server stops the run before artifact bytes are published.

## Full Base Backup

The full operation allocates one run-owned remote directory and executes the matching-major `pg_basebackup` with:

```text
--format=plain
--wal-method=stream
--checkpoint=spread
--manifest-checksums=SHA256
--progress
--no-password
```

Plain format is required so `pg_verifybackup` can verify data files and parse the WAL needed to make the anchor self-contained. The operation uses the default temporary replication slot created by `pg_basebackup`; it does not create a persistent slot. Server-side target mode, `--no-sync`, missing manifests, and disabled checksums are refused.

After `pg_basebackup` completes, DeployerX parses `backup_manifest`, verifies its system identifier and WAL ranges, runs the matching-major `pg_verifybackup`, records the current timeline and WAL segment size, then streams a deterministic tar from the remote workspace into one encrypted `physical-backup` Artifact. A nonzero verifier result, malformed manifest, empty stream, changed identity, or unsafe archive entry prevents RecoveryPoint publication.

## Archived WAL Capture

An incremental Job requires a preceding full or WAL RecoveryPoint for the same job, Source, cluster system identifier, and PostgreSQL major version. DeployerX requests a WAL switch, waits for PostgreSQL to report the completed segment as archived, then inventories the configured spool.

Accepted archive files are uppercase 24-hex WAL segment names and uppercase 8-hex timeline history names ending in `.history`. Segment files must be regular, non-link files with the exact server WAL segment size. A run captures a bounded contiguous sequence after the preceding authenticated segment, plus required timeline history files. Missing segments, duplicate names with inconsistent sizes, timeline regressions, more than the per-run segment limit, or an archive timeout fail without publishing a partial point.

The selected files are streamed as one tar into a `transaction-log` Artifact. Authenticated metadata records every member name and size, first and last segment, observed timelines, segment size, parent RecoveryPoint, chain root, source/job identity, server major, and system identifier. A switch with no new completed WAL produces a successful no-change run rather than an empty RecoveryPoint.

Repository retention must keep the full anchor and every WAL point needed by a retained descendant. Timeline history files are retained with the chain. Deleting files from the server spool is intentionally outside BM-403; repository verification and retention must succeed before a later cleanup feature may own that responsibility.

## Recovery Targets

A PITR request selects exactly one target:

| Target | PostgreSQL setting |
| --- | --- |
| End of captured WAL | no stopping target |
| Base-backup consistency point | `recovery_target = 'immediate'` |
| UTC timestamp with numeric offset | `recovery_target_time` |
| PostgreSQL LSN | `recovery_target_lsn` |
| Transaction ID | `recovery_target_xid` |
| Named restore point | `recovery_target_name` |

Time, LSN, and transaction targets also accept an explicit inclusive flag. The timeline is `latest` by default and can be `current` or an authenticated positive timeline ID. Recovery uses `recovery_target_action = 'promote'`; pause and shutdown workflows are deferred because they require an operator-controlled validation and resume lifecycle.

The request must fall after the base anchor and within the selected authenticated chain. PostgreSQL remains authoritative for whether a named, time, transaction, or LSN target is actually reached. If archived WAL ends first, PostgreSQL fails recovery and DeployerX records a failed RestoreRun.

## Restore Orchestration

Recovery requires exact destructive confirmation. Before stopping PostgreSQL, DeployerX:

1. authenticates an acyclic full-plus-WAL chain and every repository manifest, size, digest, artifact kind, parent, and cluster identity;
2. verifies the target Source, tested PostgreSQL/SSH pairing, supported same major, service configuration, and current-device affinity;
3. materializes the base and WAL archives into a run-owned remote workspace;
4. rejects absolute paths, traversal, links, devices, pipes, sockets, unexpected members, duplicate WAL names, and manifest or WAL verification failures;
5. runs matching-major `pg_verifybackup` against the materialized base.

DeployerX then stops the configured service and proves it inactive. It creates the configured data directory if absent but requires it to be empty; it never deletes or overwrites an existing cluster. The verified base is copied in, ownership is repaired, archived WAL is kept in the run workspace, bounded recovery settings are appended to `postgresql.auto.conf`, and `recovery.signal` is created.

The service starts and PostgreSQL retrieves WAL through an exact local `restore_command`. DeployerX waits for promotion, proves service activity, reconnects with the target PostgreSQL connection, verifies the protected system identifier and server major, and records the final replay LSN and timeline. Alternate-host recovery preserves the protected PostgreSQL system identifier by design; the target must be isolated from the original cluster and any replication topology before restore.

Run-owned temporary files are removed only after recovery reaches a terminal state. Cancellation aborts active SSH commands and repository streams, records a canceled RestoreRun, and removes only the run-owned workspace. Once the target service has been stopped or the base copied, cancellation does not claim rollback; the operator must inspect the target before retrying.

## Recovery and Activity UI

Recovery projects physical base and WAL points without exposing repository locators. A WAL point shows its authenticated capture window, timeline, and first/last segment. The recovery form supports latest, immediate, UTC time, LSN, transaction ID, and named restore-point targets; inclusivity for time/LSN/XID; and latest, current, or a positive specific timeline. Original and alternate physical Sources are filtered to tested current-device PostgreSQL physical configurations. Active recovery exposes cancellation, and Activity records the target mode, normalized recovery target, final LSN, final timeline, chain length, byte count, and terminal validation state.

Main/preload operations are:

- `backup:postgresql-pitr:list`;
- `backup:postgresql-pitr:start`;
- `backup:postgresql-pitr:wait`;
- `backup:postgresql-pitr:cancel`.

## Verification Boundary

`pg_verifybackup` verifies the backup manifest, system identifier, file presence and size, SHA-256 checksums, and required WAL parsing for the full anchor. It does not prove that PostgreSQL can start or that application data is semantically correct. Therefore every restore also requires a real server start, completed recovery/promotion, SQL connectivity, system-identifier equality, major-version equality, final timeline, and replay-LSN evidence.

Automated isolated recovery drills, `pg_amcheck`, application checksums, user-tablespace remapping, and replica topology validation remain separate release work.

## Official PostgreSQL References

- [pg_basebackup](https://www.postgresql.org/docs/18/app-pgbasebackup.html)
- [pg_verifybackup](https://www.postgresql.org/docs/18/app-pgverifybackup.html)
- [Continuous archiving and PITR](https://www.postgresql.org/docs/18/continuous-archiving.html)
- [Archive recovery settings](https://www.postgresql.org/docs/18/runtime-config-wal.html#RUNTIME-CONFIG-WAL-ARCHIVE-RECOVERY)
- [Recovery target settings](https://www.postgresql.org/docs/18/runtime-config-wal.html#RUNTIME-CONFIG-WAL-RECOVERY-TARGET)
- [PostgreSQL 14 pg_basebackup](https://www.postgresql.org/docs/14/app-pgbasebackup.html)
- [PostgreSQL 17 incremental backup](https://www.postgresql.org/docs/17/continuous-archiving.html#BACKUP-INCREMENTAL-BACKUP)
