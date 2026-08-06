# Neo4j, ClickHouse, InfluxDB, and CockroachDB Backup and Restore

Status: BM-411 executable acceptance contract  
Research date: 2026-08-05

## Purpose

This contract defines four independent database-adapter families. A shared UI must not imply that their backup media, consistency, incrementals, or restore semantics are interchangeable. Every advertised capability must be proven by the exact product, edition, deployment, native tool, target, and recovery point used by a run.

## Common Safety Contract

- Connections are workspace-scoped and device-bound. Local and SSH execution use saved, successfully tested execution bindings.
- Passwords, tokens, passphrases, private keys, KMS material, and storage credentials are SecretRefs. They never enter persisted endpoints, renderer responses, audit details, diagnostics, or command arguments when a native environment/file mechanism exists.
- Discovery records the product, edition, server and client versions, deployment identity, topology, database/object inventory, native feature availability, and a canonical fingerprint. A changed identity fails closed.
- A Job is admitted only when its Source has a fresh successful connection test, exact selection, compatible method, and all required privileges and storage capabilities.
- A RecoveryPoint is published only after every required native operation and repository artifact is complete, authenticated, and revalidated. Native job IDs, backup IDs, chain parents, timestamps, checksums, repository identities, and ownership labels are retained as evidence.
- Native-managed media and DeployerX repository media are separate ownership domains. DeployerX does not directly delete native-managed files. Retention uses the native lifecycle API or SQL statement and refuses deletion when ownership or chain safety is ambiguous.
- Restores default to an alternate, empty target. Original-target replacement is unavailable until BM-412 supplies application quiescence and a separate destructive confirmation contract.
- Cancellation stops only the exact owned native operation. It does not claim rollback. Partial targets and native media are preserved for reconciliation unless the native product proves an atomic cancel-and-cleanup contract.
- Metadata verification authenticates manifests and rechecks native catalogs without changing data. Full drills use isolated targets and validate object counts, native consistency checks, and selected probes.

## Neo4j

### Supported tiers

| Tier | Backup | Incremental | Restore |
| --- | --- | --- | --- |
| Community | Offline `neo4j-admin database dump` | No | Offline dump load into an empty alternate target |
| Enterprise | Online `neo4j-admin database backup` | Differential chain after a full baseline | Native backup restore into an empty alternate target |

Current support targets Neo4j 5.26 LTS and supported calendar-version Enterprise releases. The adapter must discover, not infer, edition and tool compatibility.

### Discovery and Source enrollment

- Run `neo4j`, `neo4j-admin`, and `cypher-shell` version probes on the selected execution host.
- Authenticate through `cypher-shell` using temporary mode-0600 environment material. Discover `dbms.components`, `SHOW DATABASES`, and, where supported, `SHOW SERVERS`.
- Persist edition, exact version, database IDs, server IDs, roles, writer state, access/status, default/home flags, composite constituents, server health, and topology fingerprints.
- Selection supports exact databases. The `system` database is metadata evidence, not an independently selectable user-data backup.
- Enterprise online execution requires every hosting server needed by the selected databases to have a tested execution binding and compatible `neo4j-admin` tooling.

### Backup

- Community full: prove downtime or a stopped database, run `neo4j-admin database dump`, capture command/tool identity, database ID, store format, size, and digest, then stream the dump through the repository engine.
- Enterprise full: run `neo4j-admin database backup --type=full` against an owned destination, retain the native backup identity and metadata, inspect it, and publish only after all selected databases complete.
- Enterprise incremental: bind to one healthy full/differential parent chain. Use the native differential mode, retain transaction-log range and parent evidence, and accept Neo4j's documented fallback to full only when the result is explicitly reclassified as a new full baseline.
- Multi-database runs are atomic at the DeployerX publication layer: a partial native result is not a RecoveryPoint.
- Online backups may include RBAC metadata; offline dumps do not. The UI and recovery manifest must state the achieved metadata scope.

### Restore and verification

- Inspect media before restore and require product-major/store-format compatibility.
- Community load and Enterprise restore target an empty alternate DBMS/database name by default. Existing data, duplicate database IDs, or ambiguous cluster membership fail closed.
- Validate with native consistency checks, successful start, `SHOW DATABASES`, database identity, and bounded Cypher probes.
- Enterprise clustered recovery additionally validates hosting, writer allocation, health, and restored RBAC scope. Sharded databases require complete shard backup evidence and native validation.

## ClickHouse

### Native contract

- Use native `BACKUP` and `RESTORE`; support synchronous or `ASYNC` execution and monitor `system.backups` by exact operation ID.
- Scope supports database, table, partition, dictionary, view, temporary table, `ALL`, exclusions, and `ON CLUSTER`. DeployerX initially admits database/table selection and expands only when each scope has restore coverage.
- Destinations are configured ClickHouse disks, S3/S3-compatible storage, or Azure Blob. Prefer named collections so credentials are absent from SQL and logs.
- Full and incremental backups are distinct. Every incremental records its `base_backup`; all ancestors are required for restore and retention.
- Compression and password-protected ZIP are policy options. Passwords are SecretRefs and never appear in persisted SQL.

### Admission and execution

- Discover server version, cluster/replica topology, databases, tables, engines, partitions, dictionaries, views, storage policies, configured backup disks/named collections, RBAC backup eligibility, and `system.backups` capability.
- Reject unsupported table engines or incomplete replicated/cluster scope. Pin cluster, shard, replica, database UUID, and table UUID identities.
- For `ASYNC`, persist the operation ID before polling. Reconcile running, completed, failed, canceled, and missing operations after restart.
- A completed native status is necessary but insufficient: inspect counts, compressed/uncompressed sizes, errors, media existence, and selected object membership before publication.
- Config-file-defined access control is not included even when SQL-managed access entities are. Report exact RBAC scope.

### Restore and verification

- Default to new database/table names or an isolated cluster. Restore into non-empty tables is disabled because it can duplicate data.
- Resolve the entire incremental chain, authenticate each link, then issue one native restore against the selected recovery point.
- Validate `system.backups`, object UUID/name mapping, row/part counts, replica health, and bounded queries. Distributed and replicated objects require cluster-wide validation.

## InfluxDB

### Product matrix

| Product | Backup contract |
| --- | --- |
| InfluxDB OSS v2 | `influx backup` and `influx restore` for data and metadata |
| InfluxDB 3 Core | No built-in command; ordered copy of persisted object-storage state |
| InfluxDB 3 Enterprise, upgraded storage engine | Built-in `influxdb3` full/incremental backup and asynchronous live restore |
| InfluxDB 3 Enterprise, legacy Parquet engine | Ordered manual object-storage copy across cluster and node state |

InfluxDB 3 Cloud/Clustered and provider-managed products require a separate provider API contract and are not treated as self-managed filesystem access.

### OSS v2

- Discover exact server/CLI versions, organization, bucket IDs, retention rules, shard groups, metadata scope, and token-hashing behavior.
- Support full native backup and alternate-instance restore. Hashed tokens may be restored, but plaintext tokens cannot be recovered or displayed.
- Persist organization/bucket selection, backup manifest, compression, start/end time, and tool identity. Validate restored organizations, buckets, retention, and bounded Flux/InfluxQL queries.

### InfluxDB 3 Core

- Back up only filesystem, S3/S3-compatible, Azure Blob, or GCS persistence; memory object stores are unsupported.
- Preserve the documented order: `snapshots/`, `dbs/`, `wal/`, `catalog/`, then `_catalog_checkpoint`. Exclude regenerable `table-snapshots/` by default.
- Prefer downtime, low load, or an atomic storage snapshot. An active ordered copy without a proven snapshot is reported as weaker consistency and is not silently upgraded.
- Restore in reverse logical order while the node is stopped, preserve node ID and directory structure, fix ownership, then start and validate.
- Recovery is to the latest included snapshot. Unreferenced Parquet files are ignored and post-snapshot writes may be absent.

### InfluxDB 3 Enterprise

- Discover storage engine before capability exposure. Upgraded-engine commands return unavailable responses on the legacy engine; node roles also constrain endpoints.
- Bind upgraded-engine operations to `/api/v3/enterprise/backup[/{name}]` and `/api/v3/enterprise/restore[/{id}]`. A legacy-engine or ingest-only endpoint can return `404`; a query-only node can return `503`. Neither response is treated as a transient proof that backup is available on that node.
- Built-in backups must run on a compactor-capable node with admin authentication. Full backup establishes a uniquely named baseline and never uses the native force-overwrite option. Incrementals name one completed parent; children cannot start before the parent reaches `completed`.
- Native creation is asynchronous. Poll only the exact owned backup name through `in_progress`, `completed`, or `failed`; retain name, parent chain, persisted-data watermark, cluster ID, engine, and compactor identity. A backup covers persisted object-store state, not acknowledged writes that remain buffered outside the WAL persistence boundary.
- Cancel only an exact owned in-progress backup. Deleting an incremental can delete every descendant, so retention must compute, display, and explicitly authorize the complete native deletion closure before submission.
- Restore is asynchronous, in place, live, and cluster-wide with only one concurrent restore; a competing restore returns `409`. Treat it as a destructive point-in-time rollback, not an additive merge. Persist the `202` HTTP response `restore_id` before polling because CLI create/status restore output is human-readable rather than JSON.
- Restore rewrites catalog state and a later checkpoint and truncates WAL to the backup watermark. It may leave newer compacted files unreferenced for later garbage collection, so success never claims a physical pre-clean of the object store.
- Document the current row-delete limitation: row-delete state files are not captured and deletes may persist across restore. This limitation is shown during planning, confirmation, completion, and Recovery Test evidence.
- Legacy-engine manual backup preserves compactor `cs/cd/c`, all nodes' `snapshots/dbs/wal`, cluster catalog/checkpoint/configuration, and applicable license files in documented order.
- Legacy restore reverses that dependency order: cluster catalog/checkpoint/configuration and licenses, every node's state, then compactor state, while all nodes are stopped. Automated original-store clearing remains unavailable under BM-411.
- Upgraded-engine disaster recovery copies the exact `{cluster_id}/backups/{name}/` hierarchy into an empty object store with the same cluster and node IDs. A different object-store identity or cluster requires a separately provisioned license; validate the provider-specific endpoint/bucket/region, account/container, base-URL/bucket, or filesystem-path license binding before execution.

## CockroachDB

### Native contract

- Use SQL `BACKUP`, `RESTORE`, `SHOW BACKUP`, job control, and `CREATE SCHEDULE FOR BACKUP` against supported CockroachDB releases. Removed pre-v24.3 `BACKUP ... TO`/`RESTORE ... FROM` syntax must not be generated for current releases.
- Scope supports full cluster, database, and whole table/view. Subsets of rows are unsupported. Dependent objects must be selected together or recovery must explicitly use a documented skip option.
- A full-cluster backup includes relevant system tables, every database/table/index/view, owned backup schedules, and the cluster license. Database and table backup privileges do not implicitly cascade, so preflight must prove the exact system, database, table, and external-I/O privileges required by the chosen scope.
- Full backups create collections; incrementals append to a specific full backup, normally `LATEST`. Locality-aware backups preserve every locality URI ever used.
- Destinations include tested S3, GCS, Azure Blob, external connections, and `nodelocal`. HTTP is unsupported; untested S3-compatible storage is reported as unverified.

### Consistency, PITR, and scheduling

- Native backups are transactionally consistent at their timestamp. Prefer an explicit timestamp at least ten seconds in the past for manual runs when policy permits.
- `BACKUP` and `RESTORE` block by default. DeployerX uses `DETACHED`, persists the exact native job ID before polling, and never infers ownership from description text, destination URI, or timestamps.
- `revision_history` retains changes within the GC window and enables point-in-time restore. Without it, PITR is limited to timestamps covered by full/incremental backup boundaries.
- Scheduled backups use UTC cron, protect required timestamps from garbage collection, and may create separate full and incremental schedules. Persist both schedule IDs and policies.
- Default full cadence depends on incremental frequency; DeployerX displays the resolved cadence. Expose `on_previous_running`, `on_execution_failure`, and first-run behavior.
- Backup compaction increases chain limits only when the required cluster setting is enabled. Chain admission and retention use the discovered limit.

### Security and restore

- Enforce scoped `BACKUP`/`RESTORE` privileges and external-I/O privileges. Prefer external connections or implicit credentials; URI secrets are not persisted.
- Support passphrase or KMS encryption with SecretRefs. Persist only KMS identity and encryption mode.
- Restores default to an empty alternate cluster/database/name. A full-cluster restore requires no user-created objects. Multi-region backups cannot restore into single-region databases.
- Reconcile detached jobs with `SHOW JOBS`; pause, resume, and cancel only exact owned jobs.
- Validate checksums through native restore reads. Metadata verification may use `schema_only`; full validation adds `verify_backup_table_data` where supported.
- Restore version compatibility is same major or the next major, never from a newer version into an older one. Validate regions, zone configurations, users/grants, schedules, changefeeds, dependencies, and bounded SQL probes.
- Full-cluster restore replaces destination zone configurations with those captured by the backup. Planning and completion evidence must call out that mutation explicitly. Restoring a backup does not itself require an Enterprise license, but use of licensed backup features and destinations is still capability-gated at creation time.

## Scheduling and Retention UX

- DeployerX scheduling remains the default orchestration layer. A Job selects full, incremental/differential, native/PITR, cadence, timezone, blackout calendar, overlap policy, retention, repository copies, verification, and notifications.
- Native schedules are opt-in and visibly owned by the database product. DeployerX stores native schedule IDs, reconciles their state, and never creates a duplicate schedule when ownership cannot be proven.
- Retention previews chain closure before deletion. Full baselines with retained descendants, ClickHouse base backups, Neo4j differential ancestors, InfluxDB Enterprise parents, and CockroachDB collection dependencies cannot be removed independently.
- Each engine exposes its actual RPO: Neo4j transaction-log boundary, ClickHouse backup completion, InfluxDB persisted snapshot/watermark, or CockroachDB backup timestamp/revision range.

## Delivery Slices

1. Neo4j connection and discovery: local/SSH binding, SecretRefs, edition/version/database/server inventory, identity pinning, IPC.
2. Neo4j Community offline dump/load, then Enterprise online full/differential chains, restore, verification, retention, and UI.
3. ClickHouse connection/discovery and native full backup; then async lifecycle, incrementals, restore, validation, retention, and UI.
4. InfluxDB OSS v2 connection/discovery/full backup/restore; InfluxDB 3 Core ordered-copy tier; Enterprise upgraded-engine full/incremental lifecycle; legacy-engine copy; validation and UI.
5. CockroachDB connection/discovery, full backup, incremental/revision-history/PITR chains, native scheduling, restore, validation, retention, and UI.
6. Cross-engine recovery tests, startup reconciliation, public projections, audit coverage, desktop and 390 px renderer tests, and complete regression verification.

## Exit Criteria

- All four adapters are registered and expose only capabilities proven for the discovered product/edition/deployment.
- Connection create/test/discover, Source enrollment, Job admission/execution, RecoveryPoint publication, restore, validation, cancellation, reconciliation, retention, scheduling, Activity, and Recovery Tests are implemented for every advertised tier.
- Credentials and private storage locators remain encrypted and absent from renderer/audit/diagnostic surfaces.
- Full and incremental recovery succeeds in focused fixtures; missing parents, changed identity, incomplete topology, incompatible versions, unsafe targets, unsupported editions, and ambiguous native ownership fail closed.
- Every changed JavaScript file passes syntax checks, all focused and complete non-Electron Backup Manager tests pass, and every Electron test runs in its own process and passes. No development server, `npm run dev`, or build command is used.

## Official References

- Neo4j backup and restore: https://neo4j.com/docs/operations-manual/current/backup-restore/
- Neo4j backup modes: https://neo4j.com/docs/operations-manual/current/backup-restore/modes/
- ClickHouse backup and restore: https://clickhouse.com/docs/concepts/features/backup-restore/overview
- InfluxDB OSS v2 backup and restore: https://docs.influxdata.com/influxdb/v2/admin/backup-restore/
- InfluxDB 3 Core backup and restore: https://docs.influxdata.com/influxdb3/core/admin/backup-restore/
- InfluxDB 3 Enterprise backup and restore: https://docs.influxdata.com/influxdb3/enterprise/admin/backup-restore/
- CockroachDB `BACKUP`: https://www.cockroachlabs.com/docs/stable/backup
- CockroachDB `RESTORE`: https://www.cockroachlabs.com/docs/stable/restore
- CockroachDB scheduled backups: https://www.cockroachlabs.com/docs/stable/create-schedule-for-backup
