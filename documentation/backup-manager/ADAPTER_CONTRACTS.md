# Backup Manager Adapter Contracts

## Document Status

- Task: `BM-004`
- Status: Defined
- Adapter API version: `1`
- Last updated: 2026-08-04

## Purpose

Adapters isolate workload-specific consistency and destination-specific storage behavior from the scheduler, UI, repository engine, and recovery catalog. Adding a database or storage provider must not require branching on provider names throughout DeployerX.

The first supported adapters are expected to be:

- Sources: `files.local`, `files.ssh`, `database.mysql.logical`, `database.mariadb.logical`, and `database.postgresql.logical`.
- Repositories: `repository.local`, `repository.sftp`, and `repository.s3-compatible`.

## Adapter Layers

| Layer | Responsibility | Must not own |
| --- | --- | --- |
| Connection adapter | Validate and establish access to a host, service, cluster, or storage endpoint | Backup policy or retention |
| Source adapter | Discover workload objects, produce a consistent backup stream/artifact set, and restore workload data | Repository credentials or repository object layout |
| Repository adapter | Provide reliable object, lock, capacity, immutability, and deletion primitives for a destination | Workload consistency or database commands |
| Repository engine | Chunking, deduplication, compression, encryption, manifests, pruning, and repository-format verification | Source discovery or destination-specific authentication |

Data flow is `Source adapter -> Repository engine -> Repository adapter`. Restore reverses that flow. Database-native artifacts pass through the repository engine and never bypass encryption, manifests, or retention tracking.

## Identifier Rules

- Adapter IDs use lowercase dot-separated names and are permanent after release.
- Built-in adapters use the `deployerx.` prefix internally, for example `deployerx.files.ssh`.
- Display names are mutable and localized; persisted configuration references only adapter IDs.
- Adapter versions use semantic versioning.
- `apiVersion` identifies the DeployerX contract, independently of adapter or repository-format versions.

## Shared Adapter Manifest

```ts
interface AdapterManifest {
  apiVersion: 1;
  adapterId: string;
  adapterVersion: string;
  kind: 'connection' | 'source' | 'repository';
  displayName: string;
  description: string;
  lifecycle: 'experimental' | 'preview' | 'stable' | 'deprecated';
  supportedWorkers: Array<{
    os: 'windows' | 'linux' | 'macos' | 'any';
    architectures: Array<'x64' | 'arm64' | 'any'>;
  }>;
  minimumDeployerXVersion: string;
  configurationSchema: JsonSchema;
  secretSchema: SecretFieldSchema[];
  capabilities: SourceCapabilities | RepositoryCapabilities;
  requiredExecutables: ExecutableRequirement[];
  requiredPrivileges: PrivilegeRequirement[];
}
```

Manifest rules:

1. `configurationSchema` contains no secret values or secret defaults.
2. Secret fields are declared separately and persisted only as SecretRefs.
3. Capabilities describe verified behavior, not aspirational functionality.
4. Runtime capability probes may reduce declared capabilities but may not add undeclared destructive behavior.
5. Missing required executables or privileges make the adapter unavailable with an actionable compatibility result.

## Source Capabilities

```ts
interface SourceCapabilities {
  workloadTypes: Array<'files' | 'database' | 'kubernetes' | 'volume' | 'virtual-machine'>;
  discovery: {
    supported: boolean;
    pagination: boolean;
    searchable: boolean;
    lazyHierarchy: boolean;
  };
  selectionModels: Array<'paths' | 'include-exclude' | 'database' | 'schema' | 'table' | 'namespace' | 'volume'>;
  backupModes: Array<'full' | 'incremental' | 'differential' | 'forever-incremental' | 'native'>;
  consistencyModes: Array<'application' | 'filesystem-snapshot' | 'crash-consistent' | 'offline'>;
  pointInTimeRecovery: boolean;
  continuousLogCapture: boolean;
  resumableBackup: boolean;
  resumableRestore: boolean;
  itemLevelRestore: boolean;
  alternateTargetRestore: boolean;
  metadata: {
    permissions: boolean;
    ownership: boolean;
    timestamps: boolean;
    acl: boolean;
    extendedAttributes: boolean;
    symbolicLinks: boolean;
    hardLinks: boolean;
    sparseFiles: boolean;
  };
  hooks: Array<'pre-backup' | 'post-backup' | 'pre-restore' | 'post-restore'>;
}
```

Database adapters must additionally declare:

- supported server versions and compatible restore versions;
- logical and physical methods separately;
- database, schema, table, and role/global-object selection support;
- transaction-log type and PITR granularity;
- replica-aware backup support;
- required native tools and their acceptable versions;
- whether backup and restore require downtime, locks, superuser access, or elevated privileges.

The executable database-specific form of this contract, including normalized selectors, runtime evidence, fail-closed consistency resolution, SecretRef boundaries, and engine-adapter conformance requirements, is defined in `DATABASE_ADAPTER_CONTRACT.md`. Current logical implementations are defined in `MYSQL_LOGICAL_BACKUP_RESTORE.md`, `MARIADB_LOGICAL_BACKUP_RESTORE.md`, and `POSTGRESQL_LOGICAL_BACKUP_RESTORE.md`; approved or active physical paths are defined in `MYSQL_PHYSICAL_BACKUP_RESTORE.md`, `POSTGRESQL_BASE_BACKUP_WAL_PITR.md`, `SQL_SERVER_BACKUP_RESTORE.md`, and `ORACLE_RMAN_BACKUP_RESTORE.md`.

## Repository Capabilities

```ts
interface RepositoryCapabilities {
  operations: {
    list: boolean;
    stat: boolean;
    read: boolean;
    rangeRead: boolean;
    write: boolean;
    resumeWrite: boolean;
    multipartWrite: boolean;
    atomicCommit: boolean;
    copy: boolean;
    delete: boolean;
  };
  locking: 'native' | 'conditional-write' | 'lease-object' | 'single-writer';
  consistency: 'strong' | 'read-after-write' | 'eventual-list';
  checksums: string[];
  versioning: boolean;
  objectImmutability: boolean;
  legalHold: boolean;
  storageClasses: boolean;
  serverSideEncryption: boolean;
  clientSideEncryptionCompatible: boolean;
  capacityReporting: 'exact' | 'quota-only' | 'unavailable';
  maximumObjectSizeBytes: number | null;
  minimumPartSizeBytes: number | null;
  caseSensitiveKeys: boolean;
}
```

Repository capability rules:

1. Plain FTP cannot claim confidentiality, integrity, locking, or immutable retention and is disabled by default.
2. A repository without reliable locking is limited to one writer and cannot run prune concurrently with backup or restore.
3. Eventual list consistency requires manifest-driven reads and bounded retry after commit.
4. Object immutability is available only after the adapter validates destination-side enforcement.
5. Provider-side encryption does not replace repository-engine client-side encryption.

## Configuration and Secret Schemas

Adapters expose bounded JSON Schemas for non-secret configuration. DeployerX renders supported control types from these schemas and validates again in the main process and worker.

```ts
interface SecretFieldSchema {
  key: string;
  label: string;
  secretType: 'password' | 'private-key' | 'token' | 'access-key' | 'encryption-key' | 'certificate';
  required: boolean;
  scope: Array<'device' | 'workspace'>;
  rotatable: boolean;
}
```

- Configuration values are length-bounded and reject unknown fields unless the schema explicitly allows them.
- Paths, bucket prefixes, database identifiers, commands, and hook references receive adapter-specific validation.
- Secret resolvers return values only inside the worker execution scope and never serialize them into results.
- Adapter errors, progress, checkpoints, and debug output pass through the redacting logger.

## Shared Execution Context

```ts
interface AdapterExecutionContext {
  workspaceId: string;
  jobId: string;
  runId: string;
  workerId: string;
  attempt: number;
  abortSignal: AbortSignal;
  deadline: string | null;
  logger: RedactingLogger;
  reportProgress(update: ProgressUpdate): Promise<void>;
  checkpoint: CheckpointStore;
  resolveSecret(secretRefId: string, version?: number): Promise<SecretLease>;
  capabilities: WorkerCapabilities;
  temp: ScopedTemporaryStorage;
}
```

Execution-context rules:

- Every adapter operation receives cancellation and deadline signals.
- Temporary storage is run-scoped, capacity-bounded, permission-restricted, and cleaned after terminal state.
- Checkpoints contain no plaintext secrets and are safe to discard.
- Adapters cannot access renderer APIs or global application state.
- Native process execution uses argument arrays, explicit working directories, controlled environment variables, output limits, and an executable allowlist.

## Connection Adapter Contract

```ts
interface ConnectionAdapter {
  manifest(): AdapterManifest;
  normalizeConfig(input: unknown): NormalizedConnectionConfig;
  validateConfig(config: NormalizedConnectionConfig): ValidationIssue[];
  testConnection(context: AdapterExecutionContext, config: ResolvedConnection): Promise<ConnectionTestResult>;
  probeCapabilities(context: AdapterExecutionContext, config: ResolvedConnection): Promise<CapabilityProbeResult>;
}
```

`testConnection` verifies authentication, endpoint identity, protocol negotiation, minimum privileges, and required tools without modifying workload data. SSH tests must validate the stored host key before authentication succeeds.

## Source Adapter Contract

```ts
interface SourceAdapter {
  manifest(): AdapterManifest;
  normalizeConfig(input: unknown): NormalizedSourceConfig;
  validateConfig(config: NormalizedSourceConfig): ValidationIssue[];
  discover(context: AdapterExecutionContext, request: DiscoveryRequest): AsyncIterable<DiscoveryPage>;
  validateSelection(context: AdapterExecutionContext, request: SelectionRequest): Promise<SelectionValidation>;
  planBackup(context: AdapterExecutionContext, request: BackupPlanRequest): Promise<BackupPlan>;
  executeBackup(context: AdapterExecutionContext, plan: BackupPlan, sink: ArtifactSink): Promise<BackupExecutionResult>;
  planRestore(context: AdapterExecutionContext, request: RestorePlanRequest): Promise<RestorePlan>;
  executeRestore(context: AdapterExecutionContext, plan: RestorePlan, source: ArtifactSource): Promise<RestoreExecutionResult>;
  validateRestore(context: AdapterExecutionContext, result: RestoreExecutionResult): Promise<RestoreValidationResult>;
}
```

Source adapter invariants:

1. `planBackup` is read-only and declares locks, snapshots, downtime, space, tools, and privilege requirements before execution.
2. `executeBackup` emits typed artifacts and a consistency result; it does not choose retention or delete repository data.
3. A backup that cannot achieve the requested consistency fails before repository commit unless policy explicitly allows a weaker mode.
4. Database adapters capture the metadata needed to validate compatible restores, including engine version, encoding, log coordinates, and global objects where applicable.
5. Restore planning detects incomplete chains, incompatible versions, target conflicts, missing tools, and insufficient capacity before modification.
6. Restore validation uses native workload checks and returns evidence, not only process exit code.

## Repository Adapter Contract

```ts
interface RepositoryAdapter {
  manifest(): AdapterManifest;
  normalizeConfig(input: unknown): NormalizedRepositoryConfig;
  validateConfig(config: NormalizedRepositoryConfig): ValidationIssue[];
  testConnection(context: AdapterExecutionContext, config: ResolvedRepository): Promise<RepositoryTestResult>;
  probeCapabilities(context: AdapterExecutionContext, config: ResolvedRepository): Promise<CapabilityProbeResult>;
  getCapacity(context: AdapterExecutionContext): Promise<CapacityResult>;
  stat(context: AdapterExecutionContext, key: RepositoryKey): Promise<ObjectStat | null>;
  list(context: AdapterExecutionContext, request: ListRequest): AsyncIterable<ListPage>;
  read(context: AdapterExecutionContext, request: ReadRequest): Promise<ReadableStream>;
  write(context: AdapterExecutionContext, request: WriteRequest): Promise<WriteSession>;
  commit(context: AdapterExecutionContext, session: WriteSession): Promise<CommittedObject>;
  abort(context: AdapterExecutionContext, session: WriteSession): Promise<void>;
  copy(context: AdapterExecutionContext, request: CopyRequest): Promise<CommittedObject>;
  delete(context: AdapterExecutionContext, request: DeleteRequest): Promise<DeleteResult>;
  acquireLock(context: AdapterExecutionContext, request: LockRequest): Promise<RepositoryLease>;
  renewLock(context: AdapterExecutionContext, lease: RepositoryLease): Promise<RepositoryLease>;
  releaseLock(context: AdapterExecutionContext, lease: RepositoryLease): Promise<void>;
  validateImmutability(context: AdapterExecutionContext, request: ImmutabilityProbe): Promise<ImmutabilityResult>;
}
```

Repository adapter invariants:

1. Object keys are opaque, normalized, traversal-safe, and scoped to the configured repository prefix.
2. `commit` is idempotent for a run-scoped idempotency key.
3. A successful commit returns size and checksum evidence or explicitly reports that the provider cannot supply it.
4. Delete is idempotent but must distinguish absent objects, immutable objects, authorization failure, and transient failure.
5. Lock ownership includes repository ID, operation, worker ID, run ID, issued time, heartbeat, and expiry.
6. The adapter never weakens retention, bypasses governance locks, or removes legal holds automatically.
7. Listing is paginated and bounded; restore paths use manifests rather than broad exploratory listing.

## Planning Results

Backup and restore plans are immutable after execution begins and include:

- adapter ID and version;
- normalized redacted configuration digest;
- worker and native-tool compatibility result;
- source selection digest;
- expected consistency and backup mode;
- repository requirements and minimum capabilities;
- estimated temporary and destination capacity when available;
- required restore-chain inputs;
- required locks and expected scope;
- resumability mode and checkpoint format version;
- warnings that require explicit policy or user acceptance.

The orchestrator hashes the normalized plan and stores it in the Run configuration snapshot.

## Capability Negotiation

The orchestrator resolves a job using this sequence:

1. Load declared adapter manifests by exact ID and compatible API version.
2. Validate worker OS, architecture, privileges, and required executable versions.
3. Validate non-secret configuration schemas and resolve required SecretRefs.
4. Probe endpoint/runtime capabilities using a read-only operation.
5. Intersect declared capabilities, probed capabilities, worker capabilities, repository-engine requirements, and policy requirements.
6. Reject unsupported combinations with structured incompatibility reasons.
7. Persist the resolved capability snapshot in the run plan.

The renderer consumes resolved capability metadata. It must not infer support from adapter IDs or display unsupported options that will later be ignored.

## Result and Error Contract

```ts
interface AdapterError {
  code: string;
  category: 'validation' | 'authentication' | 'authorization' | 'connectivity' |
    'compatibility' | 'capacity' | 'consistency' | 'integrity' | 'immutability' |
    'conflict' | 'canceled' | 'timeout' | 'internal';
  retryable: boolean;
  safeMessage: string;
  retryAfterSeconds: number | null;
  details: Record<string, string | number | boolean | null>;
  causeFingerprint: string | null;
}
```

- Errors crossing process boundaries are plain structured data.
- Stack traces, command lines, environment values, credentials, signed URLs, and raw provider responses are excluded.
- Retryability is adapter-classified but policy-controlled.
- Authentication, authorization, validation, consistency, integrity, immutability, and cancellation errors are not retried automatically unless a specific error code documents a safe exception.
- Progress is monotonic within a phase and bounded to known totals when available.

## Resumability and Cancellation

- Adapters declare backup and restore resumability independently.
- Checkpoints include adapter version, checkpoint format, plan digest, committed object IDs, and native-tool coordinates.
- Resume rejects a changed plan, incompatible adapter version, expired snapshot, lost repository lease, or unavailable secret version.
- Cancellation is cooperative first, then escalates to controlled native-process termination after a bounded grace period.
- Canceling a run aborts uncommitted uploads and preserves only repository-engine-confirmed immutable objects that are safe for later garbage collection.

## Compatibility and Upgrades

- API version changes only for breaking contract changes.
- Adapter semantic versions may add optional capabilities without changing the API version.
- Persisted adapter configuration has its own `configVersion` and an explicit migrator.
- Checkpoints are readable only by declared compatible adapter versions.
- Repository adapter upgrades cannot change object-key or checksum semantics for an existing repository.
- Deprecated adapters remain restore-capable for their supported recovery points until an explicit migration path is available.

## Security Requirements

1. Built-in adapters are bundled with DeployerX and loaded from trusted application paths.
2. Future third-party adapters require signed packages, declared permissions, isolated execution, and an administrator allowlist.
3. Adapters request the minimum credential and operating-system privileges required for each operation.
4. SSH host keys and TLS identities are verified before secrets are transmitted.
5. Native command arguments and environment variables are redacted before logging.
6. Adapter output is treated as untrusted, size-bounded, parsed with structured formats where available, and never evaluated as code.
7. Hooks are separately approved resources; adapters cannot inject arbitrary hooks into a job.

## Conformance Test Suite

Every adapter must pass the applicable shared suite before it is marked stable:

| Area | Required evidence |
| --- | --- |
| Manifest | Valid API version, unique ID, schemas, truthful capabilities, and compatible platform declaration |
| Configuration | Unknown-field rejection, boundary validation, canonical normalization, and no secret persistence |
| Connection | Success, authentication failure, identity mismatch, timeout, cancellation, and safe diagnostics |
| Discovery | Pagination, stable IDs, bounded results, cancellation, and inaccessible-object handling |
| Backup | Consistency proof, progress, cancellation, interruption, retry safety, artifact manifest, and committed output |
| Restore | Original/alternate target planning, conflict handling, interruption, integrity, and native validation |
| Repository | Read/write round trip, checksums, pagination, idempotent commit/delete, lock contention, capacity, and cleanup |
| Immutability | Supported enforcement proof or explicit unsupported result; never a UI-only claim |
| Security | Secret redaction, traversal rejection, command argument safety, certificate/host-key failure, and output bounds |
| Upgrade | Configuration migration, checkpoint compatibility, and recovery-point restore compatibility |

Stable adapters also require a destructive test environment for restore, delete, retention, and immutability tests. Production credentials or repositories must never be used for conformance testing.

## Initial Capability Baseline

| Adapter | Initial scope |
| --- | --- |
| `deployerx.files.local` | Local path discovery, include/exclude selection, full and repository-engine incremental snapshots, metadata capture, item restore |
| `deployerx.files.ssh` | Lazy path discovery over SSH/SFTP, remote metadata, streamed backup, alternate-path restore, host-key verification |
| `deployerx.database.mysql.logical` | Database or single-database table/view selection, consistent full logical dump, original/alternate-server and single-new-database restore, collision preflight, native validation, opt-in one-database binary-log capture and PITR, plus whole-instance MySQL 8.4 physical full/incremental XtraBackup and original/alternate physical restore over paired pinned SSH; schema/global selection, partial-object PITR, partial physical backup, and other MySQL release lines remain unsupported |
| `deployerx.database.mariadb.logical` | Database or single-database table/view selection, consistent full logical dump, original/alternate-server and single-new-database restore, collision preflight, native validation, plus opt-in one-database binary-log capture and PITR; schema/global selection, partial-object PITR, and physical backup are later |
| `deployerx.database.postgresql.logical` | Database or single-database schema-or-table/view logical protection plus whole-cluster PostgreSQL 14-18 physical protection on Linux; full `pg_basebackup` anchors, contiguous archived-WAL incrementals, original/alternate-host PITR, collision preflight, repository authentication, and native validation; global logical selection, standby/tablespace/cluster automation, block-incremental base backups, and cross-major recovery remain unsupported |
| `deployerx.database.sqlserver.native` | Exactly one user database on SQL Server 2019, 2022, or 2025 for Linux; verified-TLS SQL authentication plus paired pinned SSH; native full, differential, transaction-log, and restore-time tail-log media; authenticated LSN/GUID/fork chains; original/alternate native restore, safe data/log relocation, UTC `STOPAT`, TDE prerequisite checks, and optional `DBCC CHECKDB PHYSICAL_ONLY`; Windows, Availability Groups, replicas, and system databases remain unsupported |
| `deployerx.repository.local` | Strong consistency, atomic local commit, exact capacity, encrypted atomic lock directories, single-device paths |
| `deployerx.repository.sftp` | SFTP transport, encrypted atomic lock directories, capacity probe, immutable commits, host-key verification |
| `deployerx.repository.s3-compatible` | Multipart writes, range reads, ETag-conditional locking, checksums, versioning and object-lock capability probes |

Any capability not listed or proven by a runtime probe is unsupported and must remain unavailable in the UI.
