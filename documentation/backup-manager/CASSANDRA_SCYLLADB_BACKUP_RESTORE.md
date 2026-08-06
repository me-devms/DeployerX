# Cassandra and ScyllaDB Backup and Restore

## Purpose

`BM-410` adds database-native protection for Apache Cassandra and ScyllaDB. These systems distribute immutable SSTables across replica-owning nodes, so a copy from one node is not a cluster backup. DeployerX must coordinate every required node, preserve exact SSTable component membership, capture schema and topology identity, and publish a RecoveryPoint only after it proves that every selected token range is recoverable.

The initial implementation has two explicit orchestration tiers:

1. Native local/SSH orchestration using `nodetool`, `cqlsh`, SSTable files, and optional commit-log archives.
2. ScyllaDB Manager integration using its cluster backup and restore lifecycle.

The tiers share the same authenticated RecoveryPoint contract but do not mix files or ownership state within one run.

## Vendor Research Baseline

The contract is based on official documentation reviewed on 2026-08-04:

- [Apache Cassandra backups](https://cassandra.apache.org/doc/5.0.8/cassandra/managing/operating/backups.html) defines snapshots as hard links to immutable SSTables plus `schema.cql`, incremental backups as hard links created after flush or streaming, and `sstableloader` or `nodetool refresh` as the principal restore paths.
- [Apache Cassandra commit-log archiving](https://cassandra.apache.org/doc/5.0.8/cassandra/managing/configuration/cass_cl_archive_file.html) defines `archive_command`, `restore_command`, `restore_directories`, `restore_point_in_time`, and timestamp precision for point-in-time replay.
- [ScyllaDB backup](https://docs.scylladb.com/manual/stable/operating-scylla/procedures/backup-restore/backup.html) states that native backup is per-node, snapshots flush and hard-link SSTables, complete incremental recovery requires a snapshot plus subsequent incremental files and commit logs, and old incremental files are not removed automatically.
- [ScyllaDB restore](https://docs.scylladb.com/manual/stable/operating-scylla/procedures/backup-restore/restore.html) requires exact same-node files for same-topology recovery, directs different-topology recovery through `sstableloader`, recommends rebuilding materialized views and secondary indexes, and requires repair after node-level restore.
- [ScyllaDB Manager backup](https://manager.docs.scylladb.com/stable/backup/) defines cluster scheduling, exact keyspace/data-center selection, deduplicated SSTable upload, retention, throttling, per-DC destinations, pause/resume, schema and manifest publication, token-range coverage checks, and tablet-migration fencing during snapshots.
- [ScyllaDB Manager restore](https://manager.docs.scylladb.com/stable/restore/) is the authoritative cluster-wide restore path for Manager-owned backups.
- [ScyllaDB Manager 3.11 Swagger API](https://manager.docs.scylladb.com/branch-3.11/swagger/) exposes versioned JSON contracts for managed clusters and health, task dry-run targets, creation/start/stop/history/progress, backup catalogs, snapshot tags, and restore targets. DeployerX uses this API rather than parsing human-formatted `sctool` tables.
- [ScyllaDB tablets](https://docs.scylladb.com/manual/stable/architecture/tablets.html) and [tablet keyspace settings](https://docs.scylladb.com/manual/stable/cql/ddl.html#tablets) define independently replicated/migrated table ranges, autonomous migration/splitting, and per-keyspace enablement. Native enrollment therefore fails closed for tablet-enabled or ambiguous keyspaces until DeployerX has an exact tablet inventory and supported migration fence; the later Manager tier owns that workflow initially.

These references guide planning; runtime probes and immutable evidence decide whether a concrete cluster is supported.

## Initial Support Tiers

| Product | Initial versions | Discovery | Backup and restore target |
| --- | --- | --- | --- |
| Apache Cassandra | 4.0, 4.1, and 5.x | Local or tested SSH execution with `cassandra`, `nodetool`, and `cqlsh` | Coordinated native snapshot/full chain, incremental SSTables, optional commit-log PITR, alternate-cluster streaming or offline bundle |
| ScyllaDB | Maintained 5.4/6.x and 2024.1-or-newer release lines that pass capability probes | Local or tested SSH execution with `scylla`, `nodetool`, and `cqlsh` | Coordinated native snapshot/incremental chain, alternate-cluster streaming or offline bundle |
| ScyllaDB Manager | Manager 3.x with a compatible managed ScyllaDB cluster | Manager API/CLI identity and location discovery | Manager-owned backup, retention, alternate-cluster restore, and recovery tests |

Support is fail closed. Unknown vendor builds, mixed product clusters, unsupported major versions, ambiguous product identity, mixed partitioners, and native-tool/server incompatibility remain discovery-only.

## Non-Goals

BM-410 does not:

- treat one node, one replica, one data directory, or one storage snapshot as a complete cluster backup;
- copy active SSTable files without a native snapshot or equivalent immutable membership boundary;
- restore `system`, `system_schema`, `system_auth`, topology, token, or cluster-local identity tables as ordinary user data;
- restore materialized-view, secondary-index, or transient native state when vendor guidance requires rebuilding it;
- overwrite an original running cluster or data directory before `BM-412` supplies an application write gate and destructive-recovery protocol;
- promise a globally instantaneous transaction boundary across independent partitions;
- use repair, replication, hinted handoff, multi-DC replicas, or commit-log retention as a backup substitute;
- infer that a successful command means a recoverable backup without manifest, coverage, repository, and restore evidence.

## Connection and Secret Model

Each Cassandra/Scylla connection is device-scoped and stores only non-secret configuration:

- expected product: `auto`, `cassandra`, or `scylladb`;
- execution binding: DeployerX-local tools or an existing tested SSH connection;
- CQL contact host and native port;
- optional CQL username and a password SecretRef ID;
- explicit `nodetool`, `cqlsh`, and product-binary paths;
- bounded command timeout;
- optional run-as user and approved non-interactive privilege mode;
- expected cluster name, product, deployment fingerprint, and topology fingerprint after testing.

SSH credentials remain owned by the existing SSH connection SecretRefs. CQL passwords are stored as separate device-scoped SecretRefs and supplied through a mode-0600 temporary `cqlshrc` or an equally protected native channel. Secrets must never enter command lines, environment diagnostics, endpoint records, logs, audit details, renderer responses, manifests, or error text. Temporary credential material is removed in `finally` cleanup and cleanup failure is surfaced.

## Discovery and Identity

Connection testing and discovery use bounded native commands and structured parsers to collect:

- actual product and product version from `cassandra -v` or `scylla --version` rather than Cassandra protocol compatibility versions;
- `nodetool` and `cqlsh` versions;
- cluster name, partitioner, schema version, local host ID, data center, rack, listen/broadcast address, and native transport state;
- every live/down/joining/leaving/moving node reported by `nodetool status`, with data center, rack, host ID, normalized address, ownership, and state;
- keyspaces, replication definitions, durable-writes settings, tables, table IDs, materialized views, secondary indexes, user-defined types, functions, aggregates, and service-level/security metadata when privileges allow;
- data directories and table-directory UUIDs without returning unrestricted filesystem contents;
- incremental-backup state, commit-log archive configuration, active snapshots, compaction activity, pending flush/compaction pressure, and available disk headroom;
- Scylla tablet usage and migration state when supported;
- Scylla Manager cluster ID, task/location capabilities, agent health, and storage-location identity for the Manager tier.

The deployment fingerprint binds product, cluster name, partitioner, and stable cluster identity evidence. The topology fingerprint binds sorted node IDs, data centers, racks, addresses, token/tablet ownership, and replication definitions. A changed identity or topology blocks Source execution until the operator retests and approves it.

## Source Selection

A Source supports:

- the complete user-data cluster;
- selected keyspaces;
- selected base tables within selected keyspaces;
- optional schema, roles, permissions, service levels, UDFs, and UDTs when supported and explicitly selected;
- explicit data-center scope only when every selected table token range remains represented by a live selected replica.

System keyspaces and derived structures are classified rather than exposed as ordinary selectable tables. Materialized views and secondary indexes are represented as rebuild instructions attached to their base tables. The immutable plan resolves names to keyspace/table IDs and freezes exact membership; wildcard rules are never the execution boundary.

## Consistency Model

### Full native snapshot

Each selected table on each required node receives an exact deterministic collision-resistant tag bound to the DeployerX workspace, run owner, host ID, keyspace, and table. The adapter does not use `--skip-flush`. A successful cluster recovery point requires:

1. Every required replica-owning node is live and bound to a tested execution connection.
2. Topology and schema fingerprints are identical before orchestration begins.
3. Snapshot creation succeeds on every required node.
4. Every selected table snapshot contains `manifest.json`, `schema.cql` where emitted, and the complete SSTable component set referenced by its TOC/manifest.
5. The final coverage proof shows every selected token range at least once and no selected table is missing.
6. Topology, schema, and tablet-migration state remain acceptable after all nodes complete.
7. All files are transferred, authenticated, and durably committed before local native snapshots are cleared.

The result is partition/application-consistent at each flushed replica and crash-consistent across the cluster coordination window. The UI must show the start/end window and must not claim a single global instant.

### Incremental SSTable chain

Incremental protection is a chain rooted in an authenticated full snapshot. It captures new SSTable component sets from each selected table's exact `backups/` directory under every approved data root. The canonical authenticated cursor records the source node, data-root index, keyspace, table, table ID, SSTable descriptor and format, and each TOC-defined component's name, size, modification time, and SHA-256 digest. Cursor metadata is capped at 24 MiB.

An incremental run is publishable only when:

- incremental backups are enabled on every required node and `nodetool netstats` proves idle `Mode: NORMAL` without active streaming;
- its explicit parent RecoveryPoint and full chain root are retained, verified, not deletion-eligible, and available in every repository configured on the Job;
- the parent manifest matches the Source, Job, Source revision, selection, cluster, topology, ring, schema, and authenticated lineage;
- every prior TOC-defined SSTable set remains present and byte-identical, and no file is selected only by timestamp;
- new files form complete, non-duplicated, non-orphaned TOC sets in an already authenticated SSTable format;
- every required node's cursor advances atomically with the parent RecoveryPoint publication.

The first incremental occurrence creates a full snapshot baseline and captures the initial cursor. A successful occurrence with no unseen complete sets creates no empty RecoveryPoint and leaves the Job's predecessor pointer unchanged. Invalid parent/root metadata, lineage ambiguity, cursor corruption, scope drift, missing or changed prior media, and format changes automatically roll to a fresh full baseline. Disabled native incrementals, active streaming, and cursor/file capacity failures remain hard failures. Jobs roll over after a configurable 1-1000 incremental points, default 30.

Incremental cancellation and failure are read-only with respect to source media. Automated deletion of old `backups/` files remains deferred until a later chain-safe native-media retention slice can prove that repository durability and retained-chain dependencies permit deletion.

### Commit-log PITR

Commit-log capture is an optional Cassandra-only chain, not an automatic consequence of incremental SSTables. Every token-owning node must enroll one operator-managed archive directory, a distinct `.deployerx-owner` marker, the exact inactive `commitlog-archiving.properties`, an approved timestamp precision, and an operator archive command. DeployerX stores only SHA-256 digests of the command and ownership marker. Enrollment is all-or-nothing across the Source, and refuses ScyllaDB or a source configuration whose restore settings are already active.

At execution time, preflight proves the enrolled directory, regular ownership marker, properties bytes, command digest, timestamp precision, node clock, and immutable segment inventory still match. Only complete regular files named `CommitLog-<version>-<id>.log` are eligible. The canonical authenticated cursor is capped at 24 MiB and 100,000 segments, binds every node to the exact Source, Job, revision, selection, cluster, topology, ring, schema, lineage, and archive configuration, and records exact sizes, modification times, and SHA-256 digests. Every previously observed segment must remain present and byte-identical. Gaps, rewrites, late segments, ordering changes, format changes, scope drift, configuration drift, future timestamps, and excessive clock skew fail closed.

The first native occurrence creates a full snapshot baseline, an authenticated initial archive cursor, and a UTC anchor. Later occurrences stream only unseen complete segments as transaction-log node artifacts and publish one authoritative `cassandra-commit-log` cluster manifest in every configured repository. The parent and full root must be retained, verified, available in every Job repository, and match the authenticated lineage. The global recovery watermark is the conservative UTC bound proved by every enrolled node; positive node clock offsets are subtracted. A run with no globally later completed segment publishes no RecoveryPoint and does not move the predecessor pointer.

An unsafe chain gap, rewrite, cursor/lineage corruption, or scope/format mismatch automatically rolls to a fresh parentless full baseline. Configuration, ownership, clock-skew, and capacity failures remain hard failures. Native Jobs accept a maximum commit-log chain length from 1 through 10,000, default 1,440; reaching it forces a new full baseline. Cancellation and failure never remove operator archive media.

Restore planning authenticates the complete chain, requires an exact UTC target at the enrolled precision, proves an unambiguous mapping for every source node, and generates mode-0600 `commitlog-archiving.properties` content with `restore_directories` and `restore_point_in_time`. Offline recovery now materializes the authenticated full anchor, new commit-log segments, manifests, schema, and protected replay properties beneath one new owned root without mutating a database service. Alternate-cluster commit-log replay remains unavailable because a safe workflow requires isolated replay followed by authenticated SSTable streaming.

ScyllaDB commit-log replay remains unavailable until an exact supported release and official tooling prove a safe, testable workflow. ScyllaDB continues to offer full snapshot and incremental SSTable protection without advertising time-target recovery.

## Preflight

Immediately before a run, DeployerX must:

1. Re-read product/version, cluster, schema, topology, and tool identities.
2. Refuse down, joining, leaving, moving, unreachable, or unbound required nodes.
3. Prove exact token/tablet coverage for the selected scope.
4. Refuse concurrent topology mutation, tablet migration, schema disagreement, or conflicting DeployerX/native snapshot ownership.
5. Check compaction/streaming pressure and bounded free space for hard-link retention and staging.
6. Verify incremental and commit-log settings for the selected mode on every node.
7. Resolve exact keyspace/table IDs and exclusions.
8. Verify repository capacity, encryption, immutability policy, and destination credentials through existing repository contracts.
9. Persist an immutable plan digest covering cluster, topology, schema, selection, node bindings, mode, chain parent, repository, and generated snapshot tags.

## Backup Execution and Publication

1. Acquire workspace, Source, cluster, and repository mutation locks.
2. Persist an owner record before the first native mutation.
3. Revalidate every node binding and fingerprint.
4. Capture schema and security/global objects through a version-qualified `cqlsh` export.
5. Execute the mode-specific snapshot or incremental boundary on every required node with bounded concurrency.
6. Enumerate files using rooted, no-follow filesystem operations; never glob outside approved table snapshot or backup directories.
7. Reject symlinks, devices, sockets, path escape, incomplete TOCs, duplicate generations, unstable files, and unsupported SSTable formats.
8. Stream files through the repository engine with per-file SHA-256 and authenticated metadata. Hard links are read as immutable files and are never recreated in the repository contract.
9. Re-read node, schema, topology, and native snapshot evidence.
10. Publish child node manifests and one parent cluster manifest only after complete coverage and repository commit succeed.
11. Advance incremental/log cursors and clear owned local snapshots only after publication is durable.

Recovery metadata includes the product/version, tools, cluster/topology/schema fingerprints, selection, node and token/tablet coverage, consistency window, snapshot tag, exact SSTable components, checksums, schema/security artifacts, exclusions/rebuild requirements, chain lineage, commit-log bounds, repository snapshot, and cleanup state.

## Cancellation, Failure, and Reconciliation

Cancellation stops new work, closes active streams, and clears only the exact DeployerX-owned snapshot tag after proving cluster, node, plan, and owner identity. Incremental files and commit logs are never deleted merely because a run was canceled.

Startup reconciliation reads owner records and native state. It may resume transfer or clear a snapshot only when all ownership fields still match. Foreign tags, changed topology, missing nodes, ambiguous partial publication, or changed file membership produce a cleanup-required state. No RecoveryPoint is published from a partial cluster run.

## Retention

Retention operates on complete chains:

- a chain root cannot be removed while a retained incremental or PITR point depends on it;
- parent cluster and child node manifests are retained or removed as one logical unit;
- repository deletion occurs before owned local snapshot cleanup when the recovery point is no longer retained;
- shared/deduplicated repository chunks are removed only through the repository engine;
- Cassandra/Scylla native snapshots are cleared through `nodetool clearsnapshot` using the exact owned tag;
- Scylla Manager backups are purged only through Manager ownership and retention APIs;
- legal hold, immutability, and replication rules override schedule retention.

## Restore Modes

### Offline alternate-directory bundle

Materialize authenticated schema, manifests, SSTables, and optional commit logs beneath a new absent directory. Validate checksums, component membership, format compatibility, ownership, and path containment. The output is an offline recovery bundle; DeployerX does not start or overwrite a database service.

### Alternate cluster

The initial online restore target is a separately tested alternate cluster.

- Recreate approved schema and global objects first.
- For changed topology, load base-table SSTables with the product-compatible `sstableloader` or supported import path.
- For an exactly matched offline topology, a later guarded workflow may place same-node files and use `nodetool import`/`refresh` only after proving node/token ownership.
- Rebuild materialized views and secondary indexes from schema rather than restoring their SSTables when vendor guidance requires it.
- Run repair/consistency verification after load.
- Never restore system-local topology identity as user data.

Original-path replacement, truncate-and-replace, commit-log directory replacement, and same-cluster destructive recovery remain disabled until `BM-412`.

## Restore Planning and Compatibility

Restore planning must verify:

- every artifact and parent/child manifest through repository authentication and raw checksums;
- source and target product compatibility, supported SSTable format, partitioner, schema/table IDs, and feature compatibility;
- exact recovery-chain continuity and PITR segment coverage;
- target keyspace/table conflicts and deterministic rename limitations;
- replication-factor and data-center consequences;
- target capacity, streaming throttle, repair plan, and operational timeout;
- encrypted SSTable key availability where applicable;
- explicit exclusions and objects that will be rebuilt.

The plan previews every target keyspace/table and destructive consequence. Alternate restore requires `RESTORE CASSANDRA ALTERNATE` or `RESTORE SCYLLA ALTERNATE`. Destructive confirmation strings are reserved for `BM-412`.

## Validation and Recovery Tests

Metadata verification proves artifact authentication, exact manifests, SSTable component completeness, chain continuity, schema parseability, topology coverage, and native snapshot/Manager identity where still available.

A full drill restores into an approved isolated cluster, then verifies:

- native connectivity and expected product/version;
- schema, keyspace, table, and table-ID mapping;
- row-count estimates plus bounded sampled queries or operator-provided validation queries;
- `nodetool status`, ownership, streaming completion, pending compactions, and repair completion;
- no missing SSTables, corrupt components, replay gaps, or unexpected system-table restoration;
- rebuilt materialized views/indexes where selected;
- cleanup of only drill-owned target resources.

Metadata verification and full drill are labeled separately and have separate objective/alert policies.

## Scheduling and Operations

Jobs support manual, interval, daily, weekly, monthly, and cron-compatible schedules through the shared scheduler. Recommended policies are:

- periodic full snapshot baselines;
- frequent incremental SSTable capture between fulls;
- continuous commit-log archival where supported and tested;
- regular metadata verification and scheduled isolated restore drills;
- independent retention for recovery chains, native snapshots, commit logs, and repository media.

Operators can cap node concurrency, bandwidth, staging space, and per-DC transfer routes. Runs expose per-node snapshot, enumeration, transfer, verification, cleanup, token-coverage, and chain progress. Alerts distinguish unavailable nodes, topology drift, archive gaps, disk pressure, stale local snapshots, repository failures, and recovery-test failures.

## UI Requirements

### Connections and Sources

- Choose Cassandra, ScyllaDB native, or ScyllaDB Manager.
- Bind local execution or tested SSH connections for every required node.
- Store CQL/Manager credentials only through SecretRefs.
- Test product, versions, cluster identity, tools, topology, schema agreement, incremental state, and privileges.
- Browse keyspaces/base tables and show derived/system exclusions.
- Display complete token/tablet coverage and block Source creation until mappings are complete.

### Jobs

- Offer only strategies proven by the selected tier: full snapshot, incremental SSTable chain, commit-log PITR, or Manager-native backup.
- Configure baseline frequency, incremental/log cadence, concurrency, throttling, staging limits, retention, objectives, notifications, and recovery tests.
- Show that a full snapshot is a coordinated window rather than a single global transaction instant.

### Recovery

- Show cluster, product/version, topology/schema fingerprints, node and token/tablet membership, consistency window, chain, PITR range, exclusions, and rebuild requirements.
- Offer offline bundle and tested alternate-cluster targets only.
- Preview compatibility, conflicts, schema actions, streaming/repair work, and target capacity.

### Activity

- Show per-node and parent-cluster state, bytes/files, token coverage, snapshot tags, incremental cursors, commit-log continuity, Manager task progress, cleanup, and bounded errors.
- Provide separate metadata-verification and full-drill evidence.
- Keep Sources, Jobs, Recovery, Activity, and Recovery Test workflows usable without horizontal overflow at 390 px.

## Delivery Slices

1. Connection and discovery: discovery-only adapter, local/SSH execution bindings, SecretRefs, product/tool/version identity, topology, keyspace/table discovery, incremental settings, and audited main/preload APIs.
2. Source enrollment: exact object selection, per-node bindings, system/derived exclusions, topology and token/tablet coverage proof.
3. Full snapshot: coordinated tags, immutable SSTable manifests, schema capture, repository streaming, parent/child RecoveryPoints, cancellation, cleanup, and reconciliation.
4. Incremental chains: per-node cursors, new SSTable capture, chain retention, rollover rules, and full-baseline enforcement.
5. Cassandra PITR: commit-log archive enrollment, continuity, time targets, restore configuration, and gap handling.
6. Alternate recovery: offline bundles, alternate-cluster loading/import, compatibility/conflict preview, native validation, repair, and restore lifecycle.
7. ScyllaDB Manager: managed cluster/location enrollment, backup scheduling and progress, Manager manifests, retention, restore, and ownership reconciliation.
8. Verification and UI: metadata checks, full drills, dashboards, notifications, responsive Electron workflows, and operator documentation.

All BM-410 delivery slices are complete. The native adapter is `executionReady: true` for physical full and incremental backup plus Cassandra-only native commit-log capture, authenticated offline bundles, and separately tested alternate-cluster SSTable streaming. The separate `deployerx.database.scylla-manager` adapter is execution-ready for Manager-owned native backup, alternate-cluster schema/table restore, and metadata/full-drill Recovery Tests. ScyllaDB PITR, alternate-cluster commit-log replay, original-cluster recovery, tablet-native execution, direct deletion of Manager media, and source-native incremental/log-media deletion remain unavailable.

## Current Implementation

The connection/discovery, complete-cluster Source-enrollment, coordinated full-snapshot, incremental SSTable-chain, Cassandra commit-log PITR, offline/alternate-cluster recovery, and ScyllaDB Manager integration slices are complete:

- `deployerx.database.cassandra-scylla` is registered with `sourceEnrollmentReady: true` and `executionReady: true` for physical full, incremental, and Cassandra-only native backup. Native mode maps to the `cassandra-commit-log` physical engine; ScyllaDB native/PITR admission fails closed. Recovery capabilities advertise authenticated offline bundles, alternate targets, SSTable streaming, and native validation; original-cluster, alternate commit-log replay, tablet-native, Manager execution, and source-native incremental/log-media deletion remain unavailable.
- Device-scoped connections bind either to local native tools or an already tested, host-key-pinned SSH connection.
- Optional CQL passwords are stored only as SecretRefs and are resolved into a mode-0600 temporary `cqlshrc`; local and remote cleanup is mandatory and cleanup failure is surfaced.
- Native command execution has bounded output, command deadlines, cancellation, safe argument quoting, canonical CQL host/port validation, and explicit executable paths.
- Product identity comes from `scylla --version` or `cassandra -v`; `nodetool version` is retained only as protocol/tool compatibility evidence.
- Discovery records cluster name, partitioner, local host/schema identity, schema agreement, multi-DC node membership, exact Murmur3 vnode-ring token counts/digests, product-compatible native tools, incremental-backup state, active snapshot names, keyspaces, tablet state, replication settings, base tables, table IDs, materialized views, secondary indexes, and system/derived exclusions.
- Successful testing pins product, cluster name, deployment fingerprint, and topology fingerprint. Changed deployment or topology identity fails closed until retested.
- Every successful node test persists a bounded, non-secret cluster inventory containing safe identity, node/ring coverage, schema, keyspace/table/tablet state, and derived-object rebuild evidence. Identity drift during the test/inventory window fails closed.
- Source enrollment requires one distinct, tested, trusted, same-device connection for every token-owning host ID. Every binding must resolve to its mapped local host and agree on product, cluster, topology, ring, schema, and per-node token digest.
- Selection is resolved against the tested inventory into exact keyspace and base-table IDs. System keyspaces, unknown/stale tables, materialized views, secondary indexes, and ScyllaDB tablet-enabled or ambiguous keyspaces are refused. Derived objects are retained only as restore-time rebuild instructions.
- Complete enrolled Sources are enabled with exact physical execution evidence. Shared Job readiness admits full mode and admits incremental mode only when every enrolled node's tested inventory proves native incremental backups enabled; every unimplemented mode remains rejected.
- Every run revalidates every enrolled node, node revision, server identity, cluster/topology/ring/schema fingerprints, token digest, table ID, health state, and approved data root before native mutation.
- A persisted source lease binds the exact workspace/run owner, Source, cluster, selection, nodes, and per-table tags. Snapshot creation, failure cleanup, cancellation, and startup reconciliation mutate only those exact tags; ambiguous cleanup leaves the lease active for operator action.
- Snapshot enumeration is rooted beneath approved Cassandra or Scylla data directories, rejects non-regular/nested entries, proves complete TOC membership, records exact size/mtime/SHA-256 membership, and streams one bounded `DXCSNP01` archive per node plus schema bytes.
- A final authoritative cluster-manifest artifact performs a second topology/ring/schema/tag check after node/schema transfer and before the repository manifest commits. Its evidence records the coordinated capture window, exact child manifests, postflight seal, and cleanup required after publication.
- After every configured repository manifest commits and verifies, DeployerX clears the exact owned native tags, persists the released source lease, and atomically publishes one full crash-consistent RecoveryPoint with node `physical-backup`, schema, metadata, and repository-manifest Artifact records.
- An incremental Job without a predecessor creates a full native baseline and a canonical SHA-256-authenticated cursor. The cursor binds node, approved data-root index, keyspace, table/table-ID, SSTable descriptor/format, and exact TOC component metadata; special files, nested paths, missing/orphaned/duplicate components, duplicate descriptors, unsupported formats, and cursor/file limits fail closed.
- Incremental capture first proves every node idle in `Mode: NORMAL`, enumerates only exact table `backups/` directories, authenticates every existing component, and streams only unseen complete SSTable sets in `cassandra-scylla-native-incremental` node archives. Child artifact metadata stays compact; only the authoritative cluster-manifest Artifact carries the bounded full cursor.
- The explicit `lastRecoveryPointId` Job field selects the predecessor deterministically. Parent and full root must be retained, verified, not deletion-eligible, available in every configured repository, and match authenticated Source/Job/revision/selection/cluster/topology/ring/schema lineage before any child can link to them.
- Missing or invalid parents/roots, ambiguous or mismatched metadata, cursor corruption, scope drift, lineage gaps, changed media, and SSTable format changes automatically produce a parentless full baseline with the rollover reason recorded. Disabled incrementals, active streaming, and capacity limits remain hard failures.
- Incremental Jobs accept a maximum chain length from 1 through 1000, default 30. Reaching it forces a fresh parentless full baseline. A no-change scan succeeds without repository publication or an empty RecoveryPoint and preserves the predecessor pointer.
- Cancellation and release never delete native incremental files. The manifest records read-only cleanup ownership; chain-safe source-media deletion remains deferred.
- Cassandra Sources may optionally enroll commit-log archival only when every token-owning node supplies a distinct ownership marker, exact archive properties, one approved UTC precision, and a matching archive-command digest. The command itself is never persisted, ScyllaDB enrollment is rejected, and partially enrolled clusters cannot create native Jobs.
- Cassandra native Jobs persist a maximum commit-log chain length from 1 through 10,000, default 1,440. Job cloning preserves both incremental-SSTable and commit-log chain policies.
- Native full baselines capture the initial authenticated commit-log cursor and UTC anchor. Later native runs revalidate archive ownership/configuration, retained parent/root availability in every repository, exact cluster lineage, immutable prior segments, filename/version/order continuity, node clocks, and bounded cursor/media capacity before streaming only unseen complete segments.
- Each successful advancing run publishes transaction-log node archives plus one authoritative `cassandra-commit-log` cluster manifest. Its global recovery time is the conservative bound proved by every node after positive clock-offset adjustment. A no-change scan publishes nothing and preserves `lastRecoveryPointId`.
- Gaps, rewrites, late segments, format or scope drift, and invalid lineage safely roll to a new parentless full baseline. Archive configuration/ownership drift, excessive clock skew, future timestamps, and capacity violations remain hard failures. Cancellation and release never delete operator archive media.
- The public RecoveryPoint projection exposes only the authenticated Cassandra UTC range and physical-engine identity. Archive paths, segment names, cursor internals, ownership data, and repository locators remain private.
- Recovery authenticates the self-rooted full anchor and every incremental or commit-log child against exact parent/root lineage, source/selection/cluster identity, node manifests, repository catalog metadata, raw file size/digest, and declared artifact completeness. The bounded streaming `DXCSNP01` parser refuses traversal, duplicates, truncation, trailing bytes, header drift, missing members, and content mutation.
- Offline recovery creates one absent ownership-marked root and materializes only authenticated selected-keyspace schema, cluster manifests, per-node SSTables, optional Cassandra commit logs, protected replay properties, and a SHA-256 inventory. Failure or cancellation removes the root only when its exact owner marker still matches; no database service is mutated.
- Alternate recovery requires a different empty same-product cluster on the same conservative major release line and partitioner, with a distinct trusted same-device connection for every token-owning target node. Planning refuses stale trust, unhealthy membership, incomplete mappings, source-cluster identity, schema conflicts, and authenticated targets whose `sstableloader` credentials would be exposed in process arguments.
- Execution re-discovers every mapped node before creating remote state and binds live product/version, partitioner, cluster, deployment, topology, ring, local host ID, healthy membership, and conflict evidence to the confirmed plan. It then applies selected schema, streams authenticated SSTables to an exact owned stage, runs `sstableloader`, repairs every mapped node, validates live topology and restored base tables, and proves exact stage cleanup.
- RestoreRun lifecycle support includes preview, list, start, wait, cancel, bounded progress/public errors, startup reconciliation, and audited main/preload mutations. Cancellation never claims rollback; interrupted or mutated alternate targets are preserved for operator inspection. Original/source-cluster restore and alternate commit-log replay remain explicitly unavailable.
- The public adapter backup contract delegates preflight and execution to the coordinated cluster host. Audited Cassandra/Scylla recovery preview/list/start/wait/cancel APIs and startup reconciliation are registered in the main process and preload bridge.
- `deployerx.database.scylla-manager` is a separate physical/native adapter and ownership domain. It uses the official Manager 3.x JSON API over identity-verified HTTPS, optional Basic/bearer SecretRefs, bounded responses, disabled redirects, and exact managed-cluster identity pinning.
- Successful Manager tests require one supported Manager 3.x endpoint, the exact selected managed cluster, and bounded agent inventory. Backup and restore preflight require every selected agent, CQL endpoint, and REST endpoint up; topology, Manager/ScyllaDB versions, data centers, cluster identity, and deployment fingerprints are persisted without Manager cluster credentials.
- Backup target verification dry-runs the exact keyspace/base-table patterns, data centers, locations and location fingerprints, method, schema capture, retention and retention lock, throttling, parallelism, and transfers. Purge-only and schema-skipping targets are refused.
- Manager Sources and native Jobs remain bound to the tested connection, healthy topology, exact target fingerprint, location identities, units, method, retention, throttle, transfer, and connection evidence. Runtime preflight repeats environment and target dry-runs before mutation.
- Backup execution creates one disabled, uniquely named, DeployerX-labeled Manager task, persists ownership before start, tracks the exact run and snapshot tag, validates terminal progress, and proves the task/snapshot pair in Manager's backup catalog. Pause/resume, stop, history, progress, catalog visibility, cancellation, and reconciliation never operate on an unowned task.
- Manager remains authoritative for locations, SSTables, manifests, retention, purge, task/run IDs, and snapshot tags. DeployerX stores only the bounded authenticated `scylla-manager/backup-metadata.json` artifact in its repositories and never copies or directly deletes Manager media.
- Manager recovery authenticates that metadata through a RecoveryPoint, requires a different tested managed cluster, compatible Manager and ScyllaDB major versions, exact snapshot/location/selection evidence, and `RESTORE SCYLLA MANAGER ALTERNATE` confirmation. It runs schema restore first, re-dry-runs table restore after schema exists, runs tables second, and validates final Manager/agent/CQL/REST health.
- Manager RestoreRuns persist exact owned schema/table task and run IDs. Cancellation and reconciliation stop only those labels and never claim rollback, delete source media, purge backups, truncate keyspaces, or mutate the original cluster.
- Manager Recovery Tests provide separate `scylla-manager-metadata` and `scylla-manager-full-drill` VerificationRuns. Metadata tests authenticate the repository artifact and then revalidate exact deployment/topology identity, owned task, run, snapshot tag, progress, catalog, location, and retention evidence against Manager without restoring data.
- Full Manager drills delegate to the authenticated two-phase alternate-cluster RestoreRun. Cancellation stops only the exact owned restore, reconciliation marks orphaned tests interrupted, and every terminal record states that restored data is preserved for inspection; automatic cleanup and rollback are never claimed.
- The public RecoveryPoint read model exposes only bounded Manager version, cluster/topology fingerprints, task/run/snapshot identity, locations and stable fingerprints, selected units/data centers, retention, byte progress, and completion time. Credentials, deployment identity, private catalog values, repository locators, and remote storage secret material are not projected.
- Sources expose exact Manager connection, cluster, scope, location, retention-lock, throttling, parallelism, transfer, and schedule verification. Jobs are Manager-native only. Recovery, Activity, and Recovery Tests expose restore/test progress, validation, ownership, retention, preserved-target, cancellation, and reconciliation evidence on desktop and 390 px layouts.

Verification on 2026-08-04:

- All 563 non-Electron Backup Manager tests passed.
- All 37 Electron test files passed in separate Electron processes.
- The focused Cassandra/Scylla, commit-log, physical snapshot, recovery, shared adapter, Source, and SSH execution matrix passes 62/62 tests. Recovery coverage includes chain and repository-catalog authentication, bounded archive parsing, owned cleanup, exact PITR materialization, cancellation/reconciliation, compatibility and conflict refusal, full per-node live preflight, SSTable loading, repair, native validation, and ScyllaDB alternate recovery.
- All 10 JavaScript files touched by the recovery slice passed syntax checks.
- The Cassandra/Scylla Electron integration proves encrypted secret persistence, protected temporary credential use and removal, bounded inventory persistence, and reopening an executable complete-cluster Source with its exact table identity intact.
- No development server, `npm run dev`, or build command was run.

The ScyllaDB Manager integration slice completed on 2026-08-04. Its implementation boundary is the official Manager 3.x JSON API over identity-verified HTTPS. Manager remains authoritative for remote storage credentials, task/run ownership, snapshot tags, manifests, retention, purge, pause/resume, and restore execution; DeployerX stores only bounded non-secret identities, immutable plans, authenticated external lifecycle evidence, and audit records.

Manager-slice verification on 2026-08-04:

- Focused Manager adapter, Source/Job, source-reader, and restore suites pass 21/21 tests.
- The exact final non-Electron Backup Manager matrix passes 584/584 tests.
- All 38 Electron test files pass in separate Electron processes. The Manager Electron integration proves encrypted SecretRef persistence, 13 authenticated API requests, bounded inventory/target trust, and absence of plaintext Manager credentials or returned cluster passwords.
- All 12 JavaScript files touched by the Manager slice pass syntax checks.
- No development server, `npm run dev`, or build command was run.

Final BM-410 verification on 2026-08-04:

- The focused Manager execution, source-reader, restore, verification, IPC, and public-projection matrix passes 40/40 tests.
- The complete non-Electron Backup Manager matrix passes 590/590 tests across 73 files.
- All 39 Electron test files pass in separate Electron processes. The dedicated Manager UI scenario proves exact Source and dry-run payloads, native-only Job selection, alternate-cluster restore, both Recovery Test modes, Activity/Recovery Tests evidence, and desktop/390 px containment without horizontal document overflow.
- The 390 px Manager Source capture was visually inspected. Its long form scrolls inside the modal, actions remain accessible, and no content overlaps or clips.
- Touched JavaScript files and the new Electron test pass syntax checks. No development server, `npm run dev`, or build command was run.

`BM-410` is complete. The unavailable capabilities listed above remain deliberate safety boundaries or belong to `BM-412` rather than incomplete BM-410 behavior.

## BM-410 Exit Criteria

`BM-410` is complete only when:

1. Supported Cassandra and ScyllaDB versions are identified from actual product binaries and native probes.
2. Every required node and token/tablet range is represented by a tested device-scoped execution binding.
3. Full snapshot RecoveryPoints publish only after exact cluster-wide membership, schema, topology, file, checksum, repository, and cleanup evidence succeeds.
4. Incremental chains are restorable, gap-free, parent-bound, retention-safe, and force a new baseline on unsafe change.
5. Cassandra PITR is exposed only with proven archive continuity and exact UTC target boundaries; unsupported Scylla PITR remains visibly unavailable.
6. Cancellation and reconciliation mutate only exact run-owned native state.
7. Offline and alternate-cluster restores verify compatibility, authenticated artifacts, native load/import, repair, and data checks without overwriting production.
8. ScyllaDB Manager operations preserve Manager ownership, manifest, retention, and location semantics.
9. Sources, Jobs, Recovery, Activity, and Recovery Tests expose complete desktop and 390 px workflows.
10. Focused unit/integration tests, every non-Electron Backup Manager test, and every Electron test in its own process pass without a development server or build command.
