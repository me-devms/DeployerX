# MySQL and MariaDB Point-in-Time Recovery

## Scope

BM-401 adds binary-log protection and point-in-time recovery for the existing MySQL 8 and MariaDB 10.6-11 logical adapters. It uses an application-consistent logical full RecoveryPoint as the chain anchor, captures ordered native binary-log files as `transaction-log` Artifacts, and replays an authenticated chain to an operator-selected timestamp or native file position.

The first release is deliberately bounded to exactly one whole user database per PITR-enabled Source. Table/view selections, all-database selection, multiple selected databases, system databases, global accounts, and cross-database dependency reconstruction do not claim PITR support. This boundary allows native ROW events to be filtered to the protected database and mapped to one alternate database without replaying unrelated server workloads.

Supported engines and native tools:

- MySQL Server `>=8.0.0 <9.0.0` with `mysqldump`, `mysqlbinlog`, and `mysql` from a compatible MySQL 8 toolset;
- MariaDB Server `>=10.6.0 <12.0.0` with `mariadb-dump`, `mariadb-binlog`, and `mariadb` from a compatible MariaDB toolset.

## Source Opt-In

A MySQL or MariaDB Source must explicitly enable transaction-coordinate capture. Opt-in is persisted in the normalized consistency request as `captureCoordinates: true`. Existing Sources remain ordinary logical full-backup Sources until edited; enabling PITR does not silently alter their privilege or server requirements.

PITR opt-in requires:

- exactly one selected whole user database;
- no schema, table/view, global-object, or exclusion rules;
- native binary logging enabled;
- `ROW` binary-log format;
- full row images;
- stable server identity;
- a supported native binlog client on the worker device;
- binary-log monitoring and remote-read privileges appropriate to the engine.

The runtime preflight rechecks these conditions before every full anchor and log capture. A downgrade to an ordinary logical backup is never automatic because it would create a RecoveryPoint that appears to extend a recoverable chain when it does not.

## Coordinates and Full Anchors

The logical dump must contain a native coordinate captured against the same consistent transaction snapshot:

- MySQL uses `--source-data=2`;
- MariaDB uses `--master-data=2`.

DeployerX parses the generated coordinate from a bounded dump header after the native tool completes. A PITR-enabled full backup fails before publication when the expected coordinate is absent, malformed, refers to another server identity, or cannot be related to the current binary-log inventory.

The full RecoveryPoint remains type `full`. Its authenticated `database-dump` metadata additionally records:

- coordinate schema version and engine;
- server identity fingerprint;
- binary-log file and byte position;
- bounded GTID set when the engine emits one;
- coordinate capture time;
- protected database identity;
- binary-log format, row-image, checksum, and encryption observations;
- native tool and privilege evidence.

An ordinary full backup without authenticated coordinate metadata cannot become a PITR chain anchor retroactively.

## Incremental Log Capture

The first run of an incremental PITR Job automatically produces the required coordinate-bearing full anchor. Later runs capture binary logs from the latest authenticated full or log point.

An incremental run finds the latest available RecoveryPoint for the same Job and requires it to be either a coordinate-bearing full anchor or a valid child log point. It captures from that point's authenticated end coordinate to a newly queried current coordinate.

Before native download, DeployerX reads the server's bounded binary-log inventory and creates one segment plan per required file. The planner verifies:

- start and end coordinates use the same engine and server identity;
- file names have one stable prefix and numeric sequence width;
- the sequence never moves backwards;
- every required rotated file is still present;
- byte positions stay inside the server-reported file sizes;
- capture time does not move backwards;
- no plan exceeds 10,000 log files.

A missing or purged intermediate file fails the run with a chain-gap error. DeployerX never skips forward and never publishes a partial log interval. An unchanged coordinate is a successful no-change run but does not publish an empty RecoveryPoint.

The engine-native binlog client downloads raw log files into a permission-restricted run directory. Each file is published under an engine-specific `binary-logs/` path with authenticated metadata containing its source file, source size, covered start/stop positions, server encryption observation, content size, and digest. Repository encryption remains mandatory regardless of source-side binlog encryption.

Native raw download retrieves the complete current server file. Its Artifact can therefore contain authenticated bytes after the capture stop position. The segment metadata records the exact covered byte interval, and replay always enforces that stop position; bytes outside the interval are never claimed as protected events or replayed for that RecoveryPoint.

A successful incremental capture publishes a `log` RecoveryPoint:

- `chainRootId` points to the logical full anchor;
- `parentRecoveryPointId` points to the immediately preceding full or log point;
- `capturedFrom` and `capturedTo` bound the newly protected interval;
- authenticated chain metadata records the exact start/end coordinate and segment list;
- every repository copy contains the same logical interval.

Repository pruning already walks `parentRecoveryPointId`; therefore a retained log point protects its full anchor and every required intermediate point from deletion. A log point is not independently restorable.

## Recovery Window and Stop Point

Recovery chooses one terminal log RecoveryPoint and walks its parent links back to one full anchor. The chain must be bounded, acyclic, single-source, single-job, single-engine, identity-consistent, coordinate-contiguous, and available in at least one common repository path or through verified per-point repository failover.

The operator selects exactly one stop point:

- an ISO-8601 timestamp inside the authenticated capture window; or
- a native binary-log file and byte position inside the authenticated coordinate range.

Timestamp recovery uses native `--stop-datetime` behavior while coordinate recovery uses native stop-position behavior on the terminal file. Timestamps are shown and accepted with an explicit timezone and normalized to UTC. DeployerX does not claim transaction-name, GTID-subset, or before/after-event targeting in BM-401.

## Restore Targets and Replay

PITR uses the BM-307 target modes with separate confirmation tokens:

- original server and original database;
- different tested same-engine server with the original database name;
- one absent new database on a tested same-engine server.

The full anchor is restored first through the existing authenticated logical restore path. DeployerX then authenticates and materializes only the required raw binlog files in a permission-restricted temporary directory, invokes the engine-native binlog decoder with database filtering and optional database-name rewriting, and streams decoded output directly into the native SQL client.

Before replay, DeployerX verifies target health, current-device ownership, engine/tool compatibility, source and target identities, database collision policy, chain manifests, Artifact sizes and digests, and every adjacent coordinate. No log event is sent until the complete chain and requested stop point pass preflight.

Replay always specifies the one protected source database. New-database mode additionally applies the native database rewrite from the source name to the authenticated target name. Original and alternate modes preserve the source database name. Statement-based or mixed-format chains are refused because database filtering and mapping cannot provide the required isolation guarantee.

## Validation and Evidence

After log replay, BM-306 validation runs against the target database using the full anchor's authenticated expected-object inventory remapped to the destination name. It proves connectivity, expected objects and types, and the available engine-native structural checks. It does not claim row-by-row business checksum equivalence at the selected instant.

RestoreRuns persist:

- mode, target connection, target identity, source and target database;
- full anchor and ordered log RecoveryPoint IDs;
- requested timestamp or native coordinate;
- replayed file/segment count and byte count;
- anchor-restore evidence and log-replay evidence;
- final coordinate and native validation result;
- bounded warnings and safe terminal error.

Failed replay leaves the target available for inspection. DeployerX does not automatically drop a newly created database after native bytes may have been applied.

## Failure and Security Boundaries

- Passwords remain in SecretRefs and permission-restricted native option files; they never enter arguments, logs, Artifacts, manifests, renderer responses, or RestoreRuns.
- Native tools are invoked with argument arrays, `shell: false`, bounded output, deadlines, cancellation, and cleanup.
- Raw binlogs may contain sensitive row data and are always stored through the encrypted authenticated repository engine.
- Server purge policy remains operator-owned. Missing required files fail as a chain gap; DeployerX does not change server retention automatically.
- A failed, canceled, or interrupted capture cannot publish a log RecoveryPoint. A failed restore cannot be reported as successful and retains its evidence for diagnosis.
- Replica capture, delayed replicas, GTID subset recovery, transaction inspection, cross-database atomic recovery, and continuous streaming remain outside BM-401.

## Implementation Status

The shared safety planner, MySQL/MariaDB `1.4.0` adapters, coordinate-bearing source reader, encrypted incremental publication, full/log chain restore service, audit-wrapped IPC, Source and Job controls, Recovery workflow, UTC timestamp/native-coordinate targeting, activity evidence, and engine-specific Electron coverage are implemented. The complete BM-401 unit, Electron, syntax, document, and read-only dependency-audit gates pass.
