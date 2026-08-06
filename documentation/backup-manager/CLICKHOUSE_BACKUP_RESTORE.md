# ClickHouse Backup and Restore Contract

## Core Release Scope

The DeployerX core ClickHouse adapter protects self-managed ClickHouse 23.x through 26.x with the server's native `BACKUP` and `RESTORE` statements. The executable scope is deliberately narrow:

- one standalone, non-replicated ClickHouse deployment;
- local `clickhouse-client` execution or execution through one tested, device-bound SSH connection;
- one tested database and either every supported table in that database or an exact included table list;
- one explicitly approved writable configured ClickHouse `Disk` destination;
- application-consistent native full and incremental backups;
- recovery into an empty alternate database only;
- exact-version target compatibility and exact backup-disk identity;
- authenticated metadata validation or a confirmed full alternate-database recovery drill.

This adapter does not advertise replicated tables, shards, `ON CLUSTER`, ClickHouse Cloud, S3, Azure Blob, named-collection destinations, original-database replacement, point-in-time recovery, or transaction-log shipping. Discovering configured clusters or rows in `system.replicas` blocks backup and restore admission, even if the selected objects appear local.

The adapter model calls this a `physical` backup method because the recoverable bytes are external native media rather than a logical row export. It is not a filesystem snapshot or a copy of the ClickHouse data directory.

Adapter ID: `deployerx.database.clickhouse`

## Native Media Boundary

ClickHouse writes each native backup as a ZIP file on the approved configured disk. DeployerX does not stream that ZIP into its repository.

DeployerX stores an encrypted, authenticated metadata Artifact containing the exact native operation, destination, selected objects, row/part evidence, and chain lineage. The metadata declares `externalNativeMedia: true`. Successful recovery therefore requires both:

1. the complete authenticated DeployerX metadata chain; and
2. every referenced ClickHouse native backup file still present on a disk with the authenticated identity.

Reconciliation never deletes native ClickHouse media. Repository retention must not be interpreted as native-disk cleanup. Operators remain responsible for disk capacity and for retaining or copying every full and incremental ZIP required by a retained chain.

## Connection and Secret Contract

A ClickHouse connection contains:

- execution mode `local` or `ssh`;
- a saved SSH connection ID when SSH execution is selected;
- host and native TCP port;
- TLS mode `required` or `disabled`;
- username;
- optional password held only in a device-scoped SecretRef;
- an approved `clickhouse-client` executable name or absolute path;
- a command timeout from 1 to 300 seconds;
- the exact tested product version, deployment fingerprint, and topology fingerprint.

TLS-required connections default to port `9440`; TLS-disabled connections default to `9000`. This slice does not expose custom CA, client certificate, or client key fields. Deployments that need those settings must provide them through an approved client or host configuration outside the stored DeployerX connection.

The password is resolved only on the owning device. DeployerX writes it to a temporary `clickhouse-client` XML configuration with mode `0600`, passes only the configuration path in process arguments, suppresses client logs, and removes the file after the bounded operation. SSH execution writes the same protected file under a random `/tmp` name and removes it before closing the session. If credential-file cleanup cannot be proven, the operation fails with an integrity error.

No password, destination credential, native backup encryption key, or private storage locator is embedded in persisted SQL, renderer payloads, audit details, or recovery metadata. Configured-disk media encryption, if required, is owned by the ClickHouse host or its storage layer; the current adapter does not configure native backup passwords or DeployerX encryption for the external ZIP.

## Discovery and Admission

Connection testing and discovery issue bounded `JSONEachRow` queries for:

- exact server version, timezone, host name, and current user;
- non-system databases, database UUIDs, engines, and data paths;
- non-system tables, table UUIDs, engines, and temporary-table state;
- cluster and replica inventory;
- active partition, part, row, and byte counts;
- configured disks and their writable state;
- named-collection names when visible;
- current-user grants when visible;
- availability of the native `system.backups` catalog.

Output is bounded to 4 MiB, 10,000 rows, and validated scalar fields. Optional grant, named-collection, or backup-catalog discovery failures are represented as unavailable evidence; native execution stays disabled when the backup catalog or required grant evidence is unavailable.

The deployment fingerprint binds the exact product version, host identity, and discovered database/table names, UUIDs, and engines. The topology fingerprint binds cluster and replica evidence without persisting coordination paths. Any mismatch against the tested connection fails closed.

Backup admission requires visible `BACKUP` or `ALL` evidence. Restore admission requires accepted `RESTORE`, `BACKUP`, or `ALL` evidence and a queryable native backup catalog. The current adapter does not infer privilege from a role name.

## Destination Approval

Only `Disk` destinations returned by `system.disks` are executable. S3, Azure, named collections, ad hoc URLs, and inline credentials are not accepted by this core adapter.

An operator must choose exactly one non-read-only, non-write-once disk and type:

```text
USE CLICKHOUSE BACKUP DISK
```

Approval records a fingerprint over disk name, type, path, total size, read-only state, and write-once state, tied to the tested deployment and topology. Free space is discovered for display but is not part of the stable identity. A connection retest retains approval only while the exact disk, deployment, and topology still match; otherwise the operator must approve the destination again.

Approval proves identity and writability at that moment. It does not reserve capacity or copy native media to another server.

## Source Selection

One Source selects exactly one database. It may protect:

- the complete database, meaning every currently discovered selectable table using a supported engine; or
- an exact include list of tables in that database.

All-database scope, exclusions, schema rules, global objects, temporary tables, partitions, and mixed-database table lists are rejected. The selected database and table UUIDs and engines are pinned into the plan.

Supported table engines are:

- `MergeTree`;
- `ReplacingMergeTree`;
- `SummingMergeTree`;
- `AggregatingMergeTree`;
- `CollapsingMergeTree`;
- `VersionedCollapsingMergeTree`;
- `GraphiteMergeTree`;
- `Log`, `TinyLog`, and `StripeLog`;
- `View` and `MaterializedView`;
- `Dictionary`.

`Replicated*`, `Distributed`, and every unlisted engine are outside this release scope. Dependencies outside the exact selection are not added implicitly.

## Full Backup Workflow

1. Re-read discovery through the tested local or SSH execution path.
2. Require standalone topology, visible native backup/grant evidence, the approved disk fingerprint, and exact database/table identities.
3. Create a deterministic run-owned operation ID and a bounded path of the form `deployerx/<workspace-digest>/<operation-id>.zip`.
4. Build `BACKUP DATABASE ...` or an exact `BACKUP TABLE ...` list to `Disk(...)`.
5. Persist exact ownership before submission. Passwords are absent from SQL and process arguments.
6. Execute synchronously or, by default, with `ASYNC`; poll `system.backups` by the exact operation ID and exact destination name.
7. Accept only one unambiguous `BACKUP_CREATED` row with positive file, entry, total, compressed, and uncompressed size evidence.
8. Re-read deployment, topology, selection UUIDs/engines, and row/part/partition statistics.
9. Publish the encrypted metadata Artifact only if the pre-backup and post-backup evidence is identical.

The native backup is application-consistent, but the current publication gate also requires stable row/part statistics so later restore validation has an exact expected value. A busy selected table may therefore cause DeployerX to refuse publication even when ClickHouse completed native media successfully. The native media is preserved for inspection and is not automatically deleted.

## Incremental Chain

An incremental Job execution requires the latest RecoveryPoint from the same exact Source and Job. DeployerX authenticates the complete lineage back to one full baseline before issuing a new native backup with `base_backup = Disk(...)`.

Every ancestor must be:

- full or incremental as appropriate;
- application-consistent and successfully verified;
- retained and not deletion-eligible;
- available in one selected DeployerX repository;
- bound to the same Source, Job, selection digest, deployment, topology, and disk fingerprint;
- backed by a complete `BACKUP_CREATED` native operation and exact external-media path.

The metadata chain records parent, root, ordered ancestor IDs, base operation ID, base path, and base metadata digest. Cycles, gaps, changed identities, missing manifests, unavailable repository copies, missing native catalog evidence, or more than 1,000 chain points fail closed.

A restore authenticates every metadata link, then asks ClickHouse to restore from the selected terminal native backup. ClickHouse resolves its native `base_backup` ancestry, so all referenced ZIP files must remain available on the approved disk.

## Alternate Restore Contract

Recovery requires a tested current-device ClickHouse connection, the exact source product version, standalone non-replicated topology, visible restore/catalog evidence, and an approved disk matching the recovery point. The operator must make the referenced native media available under that exact configured-disk identity before preview or restore.

Only `alternate` mode is accepted. The confirmation text is:

```text
RESTORE CLICKHOUSE ALTERNATE
```

Target rules depend on Source scope:

- Whole-database restore requires the alternate database not to exist and to contain no tables.
- Exact-table restore requires one existing alternate database containing zero tables.
- The target database cannot be `system` or `information_schema`.
- Existing target tables are never overwritten or merged.
- Table names are preserved; arbitrary per-table renaming is not implemented.
- On the protected deployment, the alternate database name must differ from the source database.

The adapter submits one run-owned asynchronous `RESTORE` operation, monitors only its exact operation ID and source destination name, and requires `RESTORED` with positive entry, file-read, and byte-read evidence. Original-database replacement, in-place recovery, automatic drop, and rollback are unavailable.

## Restore Validation

After `RESTORED`, DeployerX re-discovers the target while allowing the expected deployment fingerprint change caused by newly restored objects. It still requires the same host name, exact product version, and topology fingerprint.

Validation proves:

- the target database exists;
- the exact expected table count is present;
- every table name and engine matches authenticated source metadata;
- a same-deployment restore did not reuse a protected table UUID;
- row count, active part count, and partition count match the protected evidence for every table;
- a bounded query against every restored table returns valid evidence;
- native restore status and object mappings are persisted in the RestoreRun.

This is native structural and count validation. It is not a byte-for-byte comparison of external ZIP media and does not run application-specific semantic queries.

## Cancellation and Restart Reconciliation

Backup cancellation stops DeployerX submission or monitoring. It does not claim that ClickHouse canceled an already submitted native operation. Run ownership and native media are preserved. Startup reconciliation queries the exact operation ID and destination name; it removes only the exact-owned temporary metadata directory after a terminal native state is proven and never deletes native media.

Restore cancellation has two outcomes:

- before native submission, the RestoreRun can finish as canceled;
- after submission, the RestoreRun becomes interrupted with `operator-action-required`, and the target is preserved for inspection.

Restore reconciliation queries the exact persisted native operation. A proven `RESTORED` operation is revalidated and may become succeeded with `reconciledAfterRestart: true`. Any unproven, failed, canceled, still-running, missing, or invalid result remains interrupted after submission. No target rollback, database drop, or native-media cleanup is claimed.

Recovery Test reconciliation also preserves an alternate drill target. An orphaned full drill becomes interrupted and requires operator inspection; cleanup and rollback remain false. These rules make retry behavior conservative: inspect `system.backups` and the target database before starting another restore, preferably using a fresh empty alternate database.

## Recovery Tests

Two ClickHouse-specific verification modes are implemented:

`clickhouse-metadata`

- authenticates the complete repository metadata chain;
- retests the protected Source;
- verifies exact version, deployment, topology, selected object UUIDs/engines, and approved disk identity;
- does not restore data.

`clickhouse-full-drill`

- requires `RUN CLICKHOUSE RECOVERY DRILL`;
- runs the ordinary confirmed alternate-database restore;
- requires native integrity validation;
- preserves the restored target for inspection;
- performs no automatic cleanup or rollback.

## Operator Procedure

### Enroll and approve

1. Ensure `clickhouse-client` compatible with the self-managed 23.x-26.x server is available locally or through a tested SSH connection.
2. Configure a ClickHouse backup disk that appears in `system.disks`, is writable, is not write-once, and is permitted for native backup operations.
3. Create the ClickHouse connection with local or SSH execution and an optional password SecretRef.
4. Test the connection and review version, host, database/table identities, topology, grants, native catalog, and disk inventory.
5. Approve the intended disk with `USE CLICKHOUSE BACKUP DISK`.
6. Create a Source for exactly one database and, optionally, exact tables.

### Protect

1. Run a full Job first.
2. Confirm that the RecoveryPoint is application-consistent and that native operation evidence is `BACKUP_CREATED`.
3. Run incremental mode only while the complete full/incremental ancestry and native disk media remain available.
4. Use metadata verification regularly. A changed deployment, table UUID, engine, topology, or disk requires investigation and usually a retest, reapproval, and new full baseline.

### Recover

1. Choose a retained and verified full or incremental RecoveryPoint.
2. Prepare a tested standalone target on the exact source version.
3. Expose the same configured backup disk identity and every required native ZIP to the target, then approve that disk on the target connection.
4. Prepare an absent database for whole-database recovery, or an existing empty database for exact-table recovery.
5. Preview the authenticated chain and compatibility result.
6. Confirm with `RESTORE CLICKHOUSE ALTERNATE` and monitor the exact native operation.
7. Review native validation and keep the alternate target isolated until application checks are complete.
8. Promote or remove the alternate database manually under the operator's own change procedure.

## Fail-Closed Conditions

Do not proceed when any of these conditions exists:

- server version is outside 23.x-26.x or the restore target version is not exact;
- cluster or replica evidence is present;
- the native backup catalog or required grant evidence is unavailable;
- the selected database/table identity or supported engine set changed;
- disk approval is missing, stale, read-only, write-once, or bound to another identity;
- an incremental ancestor, repository copy, metadata Artifact, manifest digest, or native base operation is missing;
- native operation ownership is ambiguous or status evidence is invalid;
- the alternate target violates its empty-database rule;
- source and target media identities do not match;
- restore validation finds an object, UUID, engine, row, part, partition, or bounded-query mismatch;
- credential-file cleanup, submitted-operation state, or target mutation state cannot be proven.

## Explicit Non-Goals

The core ClickHouse adapter does not currently provide:

- replicated, sharded, or distributed backup and restore;
- `ON CLUSTER` orchestration;
- ClickHouse Cloud or managed-provider APIs;
- S3, S3-compatible, Azure Blob, or named-collection destinations;
- native backup password configuration or external-media encryption;
- all-database, exclusion, partition, RBAC, user, role, quota, or global-object scope;
- original target replacement, overwrite, merge, or automatic target cleanup;
- point-in-time recovery or transaction-log capture;
- automatic deletion of ClickHouse native media;
- resumable native transfer through the DeployerX repository;
- compatibility across different ClickHouse versions, including different patch or revision strings.

## Focused Release Gate

Run the service and restart/verification gate without a development server or build:

```text
node --test src/backup-manager/clickhouse.test.js src/backup-manager/clickhouse-source-reader.test.js src/backup-manager/clickhouse-verification.test.js src/backup-manager/secrets.test.js
```

Run each Electron workflow in its own process:

```text
node_modules/.bin/electron.cmd src/backup-manager/secrets.electron.test.js
node_modules/.bin/electron.cmd src/backup-manager/clickhouse.electron.test.js
node_modules/.bin/electron.cmd src/backup-manager/backup-clickhouse-ui.electron.test.js
```

The UI gate covers connection and SecretRef handling, destination approval, one-database/table Source enrollment, full and incremental Job modes, alternate restore preview and execution, metadata verification, full drill, Activity evidence, and contained desktop plus 390 px mobile layouts.

## Official Reference

- [ClickHouse backup and restore overview](https://clickhouse.com/docs/concepts/features/backup-restore/overview)
