# MongoDB Backup and Recovery Contract

Status: BM-406 implementation in progress. This document is the acceptance contract for MongoDB support and distinguishes implemented behavior from planned behavior.

Implemented slices: the TLS/SecretRef connection and discovery boundary; whole-replica-set streamed logical anchors; authenticated continuous BSON oplog capture; encrypted RecoveryPoint chain publication; original/alternate logical recovery with bounded oplog replay; coordinated-snapshot provider, encrypted publication, and empty-target restore contracts; active logical backup/restore cancellation; durable snapshot-backup provider ownership; owned physical-restore provider lease commit, rollback, and restart reconciliation; sharded Source/Job/encrypted multi-component publication with durable balancer, write-gate, and provider ownership; and isolated sharded-cluster restore orchestration for MongoDB 7.0 and 8.0.

Remaining under BM-406: concrete runtime provider, approved application write-gate, and approved cluster-controller registration; isolated scheduled recovery tests; and complete Sources/Jobs/Recovery/Activity UI workflows.

## Release Scope

One MongoDB Source represents one authenticated deployment identity and an explicit selection. Supported deployment shapes are:

- a standalone `mongod` for logical dump/restore without point-in-time guarantees;
- a replica set for logical dump, bounded oplog recovery, and coordinated member snapshots;
- a sharded cluster reached through `mongos`, with config-server and every shard identity captured;
- MongoDB Community or Enterprise 7.0 and 8.0 on Linux for native host execution;
- TLS with certificate identity verification and SCRAM authentication through a device-scoped SecretRef;
- MongoDB Database Tools compatible with the protected server release;
- host-key-pinned SSH execution for native dump, oplog, snapshot, and restore operations.

Atlas managed backups, Cloud Manager/Ops Manager automation, Percona Backup for MongoDB, Kubernetes operators, and storage-provider snapshots are separate adapters or orchestration backends. DeployerX must not claim that a generic `mongodump` is an atomic sharded-cluster backup.

MongoDB 6.0 and earlier, Windows native execution, in-memory storage, MMAPv1, unsupported feature-compatibility versions, mixed-version upgrade windows, hidden credentials in connection strings, disabled TLS verification, and direct copying of live WiredTiger files without a valid snapshot protocol fail closed.

## Mode Mapping

| DeployerX mode | MongoDB operation | Recovery meaning |
| --- | --- | --- |
| `full` logical | `mongodump --archive --gzip` | Selected databases/collections at the dump consistency boundary |
| `native` oplog | Oplog range captured after an authenticated logical anchor | Extends a replica-set recovery window without duplicating data |
| `full` physical | Coordinated storage snapshot | Complete deployment files at one proven snapshot boundary |
| `incremental` physical | Provider-native changed-block snapshot when the selected provider proves chain semantics | Depends on a full provider snapshot; never inferred from file timestamps |

`mongodump --oplog` is a logical full-dump option for a replica set, not a general incremental backup. It is allowed only for an unrestricted deployment-wide dump where MongoDB Database Tools support it. Database, collection, query, or namespace filtering cannot be silently combined with a deployment-wide oplog guarantee.

Synchronization, replication, delayed secondaries, and filesystem mirrors are not versioned backup. They may provide a read source or snapshot location but do not replace repository RecoveryPoints.

## Trust and Credential Boundary

Connections require TLS with hostname verification. `tlsAllowInvalidCertificates`, `tlsAllowInvalidHostnames`, plaintext `mongodb://` operation without TLS, and trust-on-first-use database certificates are not supported.

The SCRAM password is stored only in a device-scoped SecretRef. For control-plane discovery it is inserted into a bounded `mongosh` program delivered through standard input. It never appears in native process arguments, environment variables, persisted endpoints, audit details, renderer payloads, or error messages. Native Database Tools use a mode-restricted temporary configuration mechanism; command-line passwords and persisted connection URIs are forbidden.

Every authenticated operation records the tested seed endpoint, replica-set name or sharded cluster ID, deployment type, server version, feature-compatibility version, storage engine, member/shard identity, TLS requirement, and current-device affinity. A changed deployment ID is an integrity failure, not an automatic retarget.

## Connection and Identity Contract

A connection stores:

- one seed host and port, optional expected replica-set name, and expected topology (`auto`, standalone, replica set, or sharded);
- authentication database and username, with only a password SecretRef ID persisted;
- `verify-identity` TLS mode and optional absolute CA-file path;
- bounded selection/connect timeouts and constrained `mongosh` executable;
- last tested server version, topology, deployment fingerprint, replica-set ID or sharded cluster ID, primary/router identity, storage engine, member list, and database list;
- a trust record tied to the authenticated deployment fingerprint.

Discovery uses `hello`, `buildInfo`, `serverStatus`, `connectionStatus`, `listDatabases`, replica-set configuration, and sharded config metadata as applicable. MongoDB 7.0 or 8.0 is required. WiredTiger is required for physical snapshot workflows. Standalone connections remain eligible only for logical dump workflows.

The backup principal must be authenticated and hold the effective privileges needed by the selected operation. Built-in `backup` plus monitoring privileges is the expected source role. Restore credentials are evaluated independently and require the effective privileges to create collections, indexes, users/roles when selected, and write restored documents. DeployerX records effective privilege checks rather than trusting a role name alone.

## Logical Dump Workflow

Logical backup streams one archive from `mongodump` to the repository engine and never writes plaintext credentials or an unbounded local archive. The plan authenticates selection and database UUID evidence before execution.

Supported selections are complete deployment, complete databases, and exact namespaces where Database Tools support them. Views, time-series collections, encrypted fields, users/roles, and config metadata are represented explicitly. System databases and authorization data are included only through dedicated options with separate restore consequences.

For a replica-set-wide anchor, `--oplog` may capture writes that occur during the dump and produce `oplog.bson`. The Artifact records the start/end operation times, term/hash evidence where available, replica-set ID, tool/server versions, namespaces, archive size/digest, and whether oplog replay is valid. A dump without valid oplog evidence is not labeled point-in-time capable.

`mongorestore --oplogReplay` may replay only the oplog paired with its authenticated anchor. Namespace remapping, include/exclude filters, archive metadata, and index options must be validated before bytes reach the target. Destructive drop behavior requires an independent confirmation.

## Oplog Recovery Chain

Oplog capture is supported only for replica sets and sharded workflows whose every shard has an independently authenticated continuous oplog range. A standalone has no oplog recovery mode.

Each oplog Artifact records replica-set ID, member/source identity, earliest and latest available timestamps, captured start/end timestamps, term/hash boundaries when present, namespace scope, parent RecoveryPoint, and full logical or physical chain root. Capture must detect rollover before and after reading. A missing operation, changed replica-set ID, rollback, divergent history, invalid BSON stream, or non-advancing boundary breaks the chain.

Point-in-time recovery selects a MongoDB timestamp inside the intersection of all required ranges. For a replica set this is one range. For a sharded cluster it is the intersection of config-server and every shard range. DeployerX never advertises a cluster-wide timestamp outside that intersection.

## Coordinated Snapshot Workflow

A physical backup protects the complete `dbPath`, journal, and required key/config files through a proven snapshot mechanism. Copying a running WiredTiger directory directly is forbidden.

For a replica set, DeployerX selects a healthy data-bearing member with matching deployment identity and sufficient replication headroom. The workflow records majority-committed operation time, flushes and locks writes on the selected member when the provider requires it, creates the atomic volume/filesystem snapshot, then always unlocks in cleanup. Snapshot provider identity, volume mapping, filesystem freeze, lock duration, operation time, checkpoint evidence, and copied byte/digest evidence are persisted.

Provider-native crash-consistent snapshots may be accepted only when MongoDB and storage documentation prove recoverability for the exact layout, including journal co-location. Application-consistent labeling requires the coordinated protocol. LVM, ZFS, Btrfs, cloud-volume, CSI, and enterprise backup-cursor implementations remain separate provider capabilities behind one snapshot contract.

Implemented provider boundary: authenticated replica status now includes majority-committed optime and per-member state, health, optime, uptime, sync source, arbiter/hidden/delay, votes, and priority evidence. Selection prefers a healthy current secondary, enforces lag and majority-commit headroom, and permits primary fallback only when explicitly configured. Direct-member `fsync` lock/unlock uses verified TLS with the SecretRef resolved only into bounded `mongosh` stdin. The provider registry accepts only atomic providers that support export, discard, and the MongoDB fsync-lock protocol; preflight must prove complete volume coverage, journal co-location, immutable per-volume snapshot identities, and exportability. Create failure always attempts unlock, and unlock failure, excessive lock duration, or post-capture identity/health divergence discards the snapshot set.

Provider-aware capability is dynamic: an adapter with an empty registry remains logical-only, while an adapter with a validated provider exposes coordinated physical full backup. The persisted Source profile binds provider ID, normalized database/journal/key paths, member policy, and lock bound without provider credentials. Runtime preflight repeats deployment, topology, privileges, health, provider, and layout checks before the provider export is streamed through the normal encrypted repository engine as a physical RecoveryPoint; provider snapshot media is discarded after publication.

Implemented empty-target restore boundary: only a restore-capable provider matching the authenticated snapshot format may be selected. The provider must prove an absent destination, stopped MongoDB service, stable target identity, exact layout, and rollback lease before repository bytes are released. DeployerX verifies the encrypted repository manifest and Artifact digest, streams media under the lease, requires exact byte completion with the service still stopped, and accepts success only after isolated provider validation with no service exposure. Occupied targets receive no media, failed validation invokes provider rollback, and success requires an explicit provider lease commit.

Physical RestoreRuns persist the provider ID, lease ID, exact run-derived owner ID, target identity, and active/rolled-back/committed state. Cancellation aborts provider preflight/restore/validation and rolls back with a non-canceled cleanup signal. Restart reconciliation rolls back only an exact owner match, retries owned cleanup after an earlier provider failure, and otherwise leaves an unchanged `interrupted` run requiring operator inspection. It never takes over or rolls back a lease whose ownership cannot be proven.

Snapshot-backup Runs now persist a `sourceLease` before `fsyncLock` with provider identity, deterministic owner `mongodb-snapshot-backup:<workspaceId>:<runId>`, deployment/member identity, and `acquiring` state. The provider receives that owner during creation and must echo it before the lease becomes `active` with a snapshot-set ID. Normal publication and cancellation discard the provider media before the Run becomes terminal and persist `discarded` evidence. If creation may have completed without returning an ID, restart reconciliation requests owner-scoped discard with a null snapshot ID; exact-owned cleanup may be retried after a transient failure, while owner mismatch or unproven provider acknowledgement remains idempotently `interrupted` with operator action required.

The stock desktop runtime still has no concrete LVM, ZFS, Btrfs, cloud-volume, CSI, or enterprise provider registered, so user-visible physical Source configuration remains unavailable despite the durable provider contract and tested in-memory provider integration.

Restore never overlays a non-empty `dbPath`. It materializes into an absent destination, verifies ownership and media, starts an isolated `mongod`, runs validation, and only then exposes the target. Original replacement requires an explicit stop, empty-target proof or separately approved displacement workflow, and rollback evidence.

## Replica-Set Workflow

Topology discovery records set name, stable replica-set ID, members, votes, arbiter/data-bearing state, hidden/delayed flags, primary, election/operation times, and replication lag. Backup reads may use a secondary only when it is healthy, data-bearing, not in rollback/recovering state, and within the configured lag budget.

One logical archive or physical member snapshot is not itself a running replica set. Restore modes are:

- recover one standalone validation instance from a replica-set backup;
- seed an absent replica set under an explicit topology plan;
- restore data logically into an existing alternate replica set;
- replace the original deployment only through a separately confirmed outage and member-by-member orchestration.

DeployerX never rewrites replica-set configuration, member hostnames, votes, priorities, or authentication keys implicitly.

## Sharded-Cluster Workflow

The router connection must prove `mongos`, cluster ID, config-server replica-set identity, shard IDs, each shard replica-set ID, chunk metadata, balancer state, and feature-compatibility version. Every shard and config server must have a tested execution path before a cluster backup can start.

Implemented discovery foundation: the authenticated `mongos` probe now records the config-server replica-set connection string, exact shard IDs and normalized replica-set member strings, database-primary assignments, collection count and up to 10,000 UUID/shard-key records, chunk count plus the first and last 32 chunk records and exact per-shard counts, balancer mode/round evidence, and the router cluster operation time. A deterministic topology fingerprint binds the config server, shard map, database primaries, and collection/chunk evidence. Canonical Extended JSON numeric wrappers are decoded without losing opaque UUID, epoch, term, or hash evidence.

Implemented component-path foundation: one enrolled verified-TLS/SecretRef connection is mandatory for the config-server replica set and for every router-reported shard. Component preflight requires an exact role, shard ID, set name, member set, stable replica-set ID, deployment fingerprint, healthy current data-bearing member, majority-commit evidence, and non-empty oplog bounds. Missing, extra, duplicate, mismatched, unhealthy, or identity-changed paths fail before the maintenance gate is acquired.

Implemented intersection rule: each authenticated config-server/shard path supplies exact earliest and latest oplog coordinates. The cluster start is the latest component start and the cluster end is the earliest component end. An empty interval, a component-local empty range, or loss of coverage for the selected cluster recovery time refuses the entire capture.

Logical sharded backup is application-consistent only when writes are quiesced by an approved application maintenance gate and the balancer is stopped for the bounded backup window. `mongodump` from `mongos` without this coordination is labeled best-effort logical export and is not a cluster RecoveryPoint.

Coordinated physical backup stops balancing, obtains a common committed cluster time, executes the supported snapshot protocol on the config-server replica set and every shard, proves that all snapshots cover the common time, then resumes balancing and the maintenance gate in `finally` cleanup. Partial shard snapshots are discarded and never projected as a restorable cluster point.

Implemented coordinator foundation: `MongoDbShardedSnapshotCoordinator` enters only an injected approved application write gate, authenticates balancer status, stops and verifies balancing, re-authenticates router topology, captures the config server followed by every shard through the existing coordinated component snapshot service, rechecks router metadata and every component identity/range, then resumes the balancer and releases the write gate in reverse-order cleanup. Any component failure, topology mutation, unproven balancer/write-gate cleanup, or partial result discards every prepared component snapshot and produces no cluster result.

Implemented durable coordination contract: a caller supplies one deterministic lease owner and persists each `onLease` callback. Before the gate is entered, the coordinator emits an `acquiring` record binding owner, cluster ID, router deployment/topology fingerprints, unknown gate ID, and unchecked balancer state. The approved gate must echo the exact owner; the coordinator then persists gate-active, balancer-stopping, balancer-stopped, balancer-restored, gate-released, and final released or cleanup-unproven states around the corresponding external mutations. Cancellation uses the same reverse-order cleanup with an uncanceled signal.

`MongoDbShardedSnapshotCoordinator.reconcile` accepts that persisted record, refuses an owner mismatch before any external call, inspects the exact gate lease, re-authenticates router/cluster/topology identity, restores the balancer only when the record proves it was previously running, and releases the exact gate. Transient cleanup can be retried idempotently; missing inspection support, mismatched lease evidence, changed topology, or unacknowledged release remains unproven.

Implemented Source and Job boundary: the tested `mongos` identity persists a bounded config-server/shard map. A physical sharded Source binds one approved write-gate ID, exactly one tested config-server connection, every router-reported shard connection, per-component provider/layout/member policy, and the enrolled router, topology, replica-set, role, membership, and deployment fingerprints. Source creation refuses missing, extra, duplicate, unhealthy, mismatched, identity-changed, or other-device component paths. Job readiness repeats the health, device-affinity, provider, and identity checks before scheduling.

Implemented publication boundary: `MongoDbPhysicalSnapshotBackupService` assigns deterministic owner `mongodb-sharded-backup:<workspaceId>:<runId>`, attaches coordinator callbacks to `Run.sourceLease`, nests each component provider lease under the cluster lease, and streams one config-server artifact plus one artifact per shard through the encrypted repository engine. The cluster manifest binds routing identity, common recovery interval, component replica-set evidence, artifact paths, provider/layout restore inputs, and application-consistency proof. Publication succeeds only when every planned component file is committed; normal completion and cancellation discard all component media before terminal Run projection.

Implemented restart cleanup: stale Run reconciliation first proves and cleans the exact write-gate/balancer lease, then discards only exact-owned active or acquiring component snapshots. Proven cleanup finalizes the non-resumable Run as failed; transient or mismatched ownership remains interrupted for operator action and can be retried without touching another owner's resources.

The stock desktop runtime still registers neither an approved application write gate, approved restore cluster controller, nor concrete per-component snapshot providers. The persistence, backup, restore, cancellation, and reconciliation boundaries are available for injected approved implementations and covered by encrypted repository tests, but sharded controls remain unavailable to users until those production backends are registered. A `mongodump` against `mongos` remains insufficient to create a cluster RecoveryPoint.

Implemented cluster restore boundary: `MongoDbShardedRestoreService` accepts only a physical full RecoveryPoint whose authenticated manifest contains the exact config-server/shard artifact inventory, cluster/topology fingerprints, component identities, provider IDs, and common recovery interval. The target profile must map exactly one distinct tested current-device execution connection, provider, empty target identity, and canonical layout to the config server and every protected shard. Missing, duplicate, extra, provider-mismatched, checksum-divergent, occupied, non-isolated, or wrong-owner targets fail before unverified media can be committed.

The injected approved cluster controller owns deterministic lease `mongodb-sharded-restore:<workspaceId>:<restoreRunId>` and must prove an absent cluster, all services stopped, isolation, rollback capability, and exact target identity. The RestoreRun persists that controller lease before component work and persists each exact-owned provider lease before repository bytes are decrypted. Restoration stages the config server first, then each shard. Every component must prove exact byte completion with its service stopped and pass isolated native provider validation.

After all media is staged, the controller must prove the ordered stages `config-server`, `shards`, `routing-metadata`, `routers`, and `validation`; exact component identities; routing-metadata match; common recovery-time match; isolated connectivity; and no service exposure. Provider leases are then committed individually, followed by the controller lease. Success deliberately leaves the cluster isolated with `activationRequired: true`; the restore operation never exposes a partially validated cluster.

Cancellation and failure roll back uncommitted provider leases in reverse component order and then roll back the controller with an uncanceled cleanup signal. Restart reconciliation mutates only exact-owned active leases. A foreign owner, rollback failure, controller uncertainty, or any partial component commit leaves the RestoreRun idempotently `interrupted` with operator action required; proven complete rollback finalizes it as failed. Because provider commits cannot be made atomically across independent storage systems, a partial-commit state is never labeled canceled, failed-clean, or restorable automatically.

## Product UI and Scheduled Recovery Drills

The dedicated Backup Manager UI now exposes MongoDB as a database Source without routing users into DeployerX account backup and restore. The shared database modal supports verified-TLS MongoDB connections, authentication database, expected standalone or replica-set topology, optional replica-set name, and an absolute CA file. A backup Source requires a tested complete replica set, selects every discovered user database, hides object-level selection, and locks continuous oplog recovery on. A tested standalone connection may be retained only as an alternate logical restore target.

MongoDB Jobs present `Continuous oplog` for incremental mode and explain that the first execution creates the full logical anchor while later executions capture authenticated BSON oplog intervals. Full mode is labeled `Full logical anchor`; differential mode remains unavailable. Recovery recognizes `deployerx.database.mongodb.native` logical anchor and oplog RecoveryPoints, supports original or alternate standalone/replica-set recovery, latest boundary or exact BSON timestamp `{ t, i }`, alternate conflict policy, destructive confirmation, and active cancellation. Physical and sharded controls stay hidden because the stock runtime has no approved providers or controllers. Activity identifies MongoDB logical/PITR restores and scheduled isolated recovery drills, including deployment mode, authenticated recovery boundary, chain/oplog points, collection/index/UUID status, native validation, isolation, target destruction, and measured RTO. Focused Electron coverage proves the desktop and 390 px mobile workflows without horizontal overflow.

`MongoDbRecoveryDrillService` implements the MongoDB-specific portion of automated recovery testing without claiming the generic cross-adapter platform reserved for BM-604. A successful scheduled backup occurrence becomes eligible only when its immutable Policy has `verification.fullRecoveryTest: true`; dispatch is deduplicated by the triggering backup Run and bounded to one active MongoDB drill. Repository checksum/sample verification and adapter-owned drill reconciliation are intentionally separate.

Each drill creates a durable `VerificationRun` in `mongodb-recovery-drill` mode and persists deterministic owner `mongodb-recovery-drill:<workspaceId>:<verificationRunId>` in `acquiring` state before provisioning. An injected approved controller must echo its ID, exact owner, lease ID, target ID, tested current-device MongoDB connection, standalone/replica-set topology, empty target, isolation, and no application-service exposure. Exact-owned occupied targets are destroyed without releasing repository bytes; foreign ownership is never touched. The service then invokes the existing authenticated alternate logical restore path, requires collection/index/UUID and native validation success, reinspects isolation, measures RTO, and destroys the exact-owned disposable target in `finally`.

Timeout and user cancellation abort the active restore before cleanup. Validation failure or target exposure fails the drill after proven destruction. Cleanup failure persists `interrupted` plus `operator-action-required` evidence under control-database schema version 3; restart reconciliation inspects and destroys only exact ownership, converts proven cleanup to a failed interrupted-process result, and is idempotent. The stock runtime does not register a disposable-target controller, so it does not advertise or dispatch this policy until an approved backend exists.

## Artifact, Retention, and Validation

MongoDB manifests contain no password, URI, TLS private material, SSH credential, repository locator, or unredacted native script. They authenticate deployment/topology identity, server/tool versions, selection, namespace UUIDs, consistency protocol, operation-time bounds, oplog ranges, archive/snapshot objects, repository copies, parents/roots, and validation evidence.

Retention preserves every anchor and oplog/snapshot dependency required by a RecoveryPoint. Oplog capture does not extend recoverability past the earliest required range. DeployerX does not resize or truncate the source oplog, run compact/repair, change write concern, stop balancing outside a leased window, or alter replica-set/shard configuration as a backup side effect.

Implemented logical inventory contract: immediately before dump planning, authenticated `mongosh` records at most 1,000 user databases, 1,000 collections/views/time-series namespaces, and 10,000 indexes. Each entry binds namespace/type, collection UUID where MongoDB supplies one, bounded collection options, index name/key/options, exact counts, and a deterministic inventory fingerprint. `find`, `listCollections`, `listDatabases`, and `listIndexes` privileges are proven before publication. Exceeding any bound or returning duplicate, malformed, missing-UUID, or fingerprint-divergent evidence fails before a RecoveryPoint is created.

Inventory-backed logical recovery uses `mongorestore --drop --preserveUUID` after original/alternate collision and confirmation checks, and therefore proves `dropCollection`, `listIndexes`, and `validate` privileges during target preflight. After full archive restore and bounded oplog replay, the adapter re-authenticates deployment identity, recaptures the protected inventory, compares every expected database, namespace type, collection option, UUID, index key, and index option, then runs bounded background `{ validate: <collection>, full: false }` commands for every stored collection. Any missing/type/option/UUID/index mismatch, native command failure, `valid !== true`, or reported validation error fails the durable RestoreRun even when `mongorestore` exited successfully. Native warnings are retained as bounded warnings without being treated as corruption when MongoDB still reports the collection valid.

RecoveryPoints created before validation inventory version 1 remain restorable. They finish with a warning after deployment identity and expected-database checks and explicitly report `MONGODB_VALIDATION_INVENTORY_UNAVAILABLE`; they never claim native integrity validation. Current original and alternate recovery validates the selected target in place. A successful production RestoreRun is not treated as an isolated recovery drill; only a completed `mongodb-recovery-drill` VerificationRun with exact controller lease, isolation, validation, RTO, and destruction evidence makes that claim.

Physical validation starts isolated media with the expected server family and runs connectivity, topology, WiredTiger, collection/index, and optionally `validate` checks. A process exit code or `mongodump` completion line alone is insufficient.

## Cancellation and Reconciliation

Each active manual backup Run owns an `AbortController`. User cancellation durably projects the Run and ExecutionGroup to `canceled`, aborts source execution, waits for cleanup, and prevents RecoveryPoint or Artifact publication. The signal reaches MongoDB inventory/tool preflight, streamed `mongodump`, native BSON oplog capture, temporary artifact reads, coordinated snapshot creation/export, and repository transfer. Focused tests terminate blocked `mongodump` and oplog processes and prove temporary media removal with no new recovery record.

Each active logical RestoreRun independently owns an `AbortController`. Cancellation reaches target preflight, `mongorestore`, encrypted repository streaming, temporary BSON materialization, oplog replay, and post-restore native validation. The durable result is `canceled` with `MONGODB_RESTORE_CANCELED`; temporary media is removed in `finally`. Audited main-process IPC and the preload API expose this operation.

Each active physical RestoreRun owns an `AbortController` and the durable provider lease described above. Cancellation rolls back the exact owned lease even though the work signal is canceled. Successful validation cannot finish the run until the provider explicitly commits that lease.

Startup reconciliation never blindly replays a native dump, restore, lock, or cluster mutation after uncertain completion. Interrupted logical restores become non-retryable failures with `operator-action-required`. Snapshot-backup reconciliation discards only the deterministic exact owner, including owner-scoped uncertain creation, and physical restore reconciliation releases only an exact owned lease. Both remain idempotently interrupted when ownership or cleanup is uncertain.

The sharded Source reader attaches the coordinator callbacks to durable Run lease state when approved providers and a write gate are injected. Startup reconciliation proves the exact gate/balancer owner and component provider owners before cleanup. The stock runtime has no approved sharded registrations, so it does not expose user-visible sharded backup or restore controls.

## BM-406 Acceptance Matrix

BM-406 is complete only after focused automated coverage proves:

- TLS identity enforcement, SecretRef isolation, bounded `mongosh` execution, safe errors, and stable deployment identity;
- standalone, replica-set, and `mongos` topology discovery with version/FCV/storage/privilege gates;
- selection-safe streamed logical archives and exact restore routing;
- replica-set `--oplog` anchors, continuous oplog capture, rollover/rollback refusal, and timestamp recovery;
- coordinated snapshot provider contracts, lock/freeze cleanup, empty-target restore, and integrity validation;
- replica-aware member selection and lag/health refusal;
- config-server and every-shard coordination, common recovery-time intersection, balancer/write-gate cleanup, and partial-cluster refusal;
- original and alternate recovery, destructive confirmations, identity/collision safeguards, and post-restore validation;
- cancellation, restart reconciliation, retention dependencies, tamper refusal, audited IPC/preload APIs, and complete UI workflows;
- focused backend, repository, Electron, mobile containment, and regression coverage without running a development server or build.

## Official References

- [MongoDB Backup Methods](https://www.mongodb.com/docs/manual/core/backups/)
- [Back Up and Restore with MongoDB Tools](https://www.mongodb.com/docs/database-tools/mongodump/)
- [`mongodump --oplog`](https://www.mongodb.com/docs/database-tools/mongodump/#std-option-mongodump.--oplog)
- [`mongorestore --oplogReplay`](https://www.mongodb.com/docs/database-tools/mongorestore/#std-option-mongorestore.--oplogReplay)
- [Back Up and Restore with Filesystem Snapshots](https://www.mongodb.com/docs/manual/tutorial/backup-with-filesystem-snapshots/)
- [`db.fsyncLock()`](https://www.mongodb.com/docs/manual/reference/method/db.fsyncLock/)
- [Back Up a Sharded Cluster](https://www.mongodb.com/docs/manual/administration/backup-sharded-clusters/)
- [Restore a Sharded Cluster](https://www.mongodb.com/docs/manual/tutorial/restore-sharded-cluster/)
- [Built-In Roles: `backup` and `restore`](https://www.mongodb.com/docs/manual/reference/built-in-roles/)
- [MongoDB Database Tools Compatibility](https://www.mongodb.com/docs/database-tools/mongodump/mongodump-compatibility-and-installation/)
