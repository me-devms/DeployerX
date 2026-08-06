# Backup Manager Worker Protocol

## Document Status

- Task: `BM-005`
- Status: Defined
- Protocol version: `1`
- Last updated: 2026-08-03

## Purpose

Backup schedules must execute when the DeployerX window is closed. A persistent Backup Worker therefore owns scheduling and execution, while the Electron renderer remains a control and observation surface.

Protocol version 1 targets a worker on the same device. The envelopes, leases, fencing, and capability handshake are designed so a later remote worker can use the same semantics over an authenticated transport.

## Components

| Component | Responsibility |
| --- | --- |
| Renderer | Displays configuration, progress, history, and recovery controls through preload APIs |
| Main process | Validates user operations, writes control-plane records, and publishes safe summaries |
| Scheduler | Creates exactly one execution group for each due schedule occurrence |
| Worker gateway | Authenticates workers and mediates commands, events, heartbeats, leases, and secret leases |
| Backup Worker | Claims compatible work, invokes adapters/engine, checkpoints progress, and reports results |
| Control database | Transactional authority for configuration, commands, leases, runs, and acknowledged events |
| Backup repository | Authority for committed backup manifests and recovery data |

The scheduler and local worker may initially run in one service process, but their transactions and responsibilities remain separate.

## Service Ownership

- Windows: Backup Worker runs as a per-user Windows service or approved persistent background service with access limited to the DeployerX user data directory.
- Linux: Backup Worker runs as a systemd user service by default; system scope is explicit when privileged workloads require it.
- macOS: Backup Worker uses a per-user launch agent.
- The UI can request start, stop, drain, and status operations but does not own the execution loop.
- Closing or restarting the Electron window cannot cancel or pause scheduled work.

## Local Transport

Version 1 uses authenticated local IPC:

- Windows named pipe with a user-specific access control list.
- Unix domain socket with owner-only filesystem permissions.
- Each installation generates a device identity and worker authentication key in operating-system secure storage.
- The gateway challenges the worker before accepting registration, commands, events, or secret requests.
- IPC messages are length-prefixed, size-bounded JSON objects. Backup payloads never travel through the control protocol.

Future remote transport must provide mutual TLS, certificate rotation, workspace authorization, replay protection, and the same envelope semantics.

## Worker Registration

```ts
interface WorkerHello {
  protocolVersion: 1;
  workerId: string;
  deviceId: string;
  workerVersion: string;
  nonce: string;
  sentAt: string;
  platform: {
    os: 'windows' | 'linux' | 'macos';
    architecture: 'x64' | 'arm64';
    runtimeVersion: string;
  };
  capabilities: WorkerCapabilities;
}

interface WorkerCapabilities {
  adapterVersions: Record<string, string>;
  repositoryEngines: Record<string, string>;
  executables: Record<string, string>;
  privileges: string[];
  maximumConcurrentRuns: number;
  maximumConcurrentStreams: number;
  temporaryCapacityBytes: number | null;
  supportedSecretProviders: string[];
}
```

Registration sequence:

1. Worker connects to the local gateway and receives a one-use challenge.
2. Worker sends `WorkerHello` plus a challenge response using its secure-storage key.
3. Gateway validates device/workspace scope, timestamp skew, nonce, protocol, and worker version.
4. Gateway intersects worker capabilities with enabled adapter manifests.
5. Gateway stores or updates WorkerRegistration and returns the accepted capability set.
6. Worker begins heartbeat and command-claim loops only after acceptance.

Registration is rejected for duplicate live worker identity, revoked device, unsupported protocol, invalid authentication, or unsafe clock skew.

## Heartbeats and Availability

```ts
interface WorkerHeartbeat {
  workerId: string;
  sequence: number;
  sentAt: string;
  state: 'online' | 'draining';
  activeRunIds: string[];
  availableRunSlots: number;
  temporaryCapacityBytes: number | null;
  warnings: SafeWorkerWarning[];
}
```

- Heartbeat interval: 10 seconds.
- Worker becomes `offline` after 30 seconds without an accepted heartbeat.
- Heartbeat sequence is strictly increasing for a worker process generation.
- Gateway timestamps accepted heartbeats; worker wall-clock time is diagnostic only.
- A draining worker renews owned leases but does not claim new runs.
- Capability changes trigger a new registration rather than an oversized heartbeat.

## Command Envelope

```ts
interface WorkerCommand<T> {
  protocolVersion: 1;
  commandId: string;
  commandType: 'execute-run' | 'cancel-run' | 'pause-claims' | 'resume-claims' |
    'drain' | 'probe-capabilities' | 'rotate-auth';
  workspaceId: string;
  workerId: string;
  runId: string | null;
  issuedAt: string;
  expiresAt: string;
  idempotencyKey: string;
  expectedRevision: number | null;
  payloadDigest: string;
  payload: T;
}
```

Command rules:

1. Commands are immutable after publication.
2. Worker verifies scope, destination worker, expiry, payload digest, and expected revision before acknowledgment.
3. Command acknowledgment is idempotent and records `accepted`, `duplicate`, `rejected`, or `expired`.
4. Re-delivery of an acknowledged command cannot repeat a completed side effect.
5. Large plans and manifests are referenced by digest and bounded local locator, not embedded without size limits.

## Event Envelope

```ts
interface WorkerEvent<T> {
  protocolVersion: 1;
  eventId: string;
  workerId: string;
  workerGeneration: string;
  runId: string;
  sequence: number;
  eventType: 'lease-acquired' | 'state-changed' | 'phase-changed' | 'progress' |
    'checkpoint' | 'warning' | 'repository-committed' | 'verification-result' |
    'completed' | 'lease-lost';
  occurredAt: string;
  payloadDigest: string;
  payload: T;
}
```

- Event sequence is strictly increasing per run and worker generation.
- Gateway inserts by `eventId` and ignores exact duplicates.
- A sequence gap pauses state projection and requests replay from the last acknowledged sequence.
- Events are acknowledged only after their database transaction commits.
- Progress events may be coalesced; state, checkpoint, warning, commit, and terminal events are durable.
- Payloads and logs are redacted and size-bounded.

## Scheduling and Execution Groups

The scheduler calculates due occurrences from Policy, timezone, and missed-run behavior. It writes an execution group and initial Run in one transaction.

```ts
interface ExecutionOccurrence {
  executionGroupId: string;
  jobId: string;
  jobRevision: number;
  trigger: 'schedule' | 'manual' | 'policy' | 'api';
  scheduledFor: string | null;
  idempotencyKey: string;
  createdAt: string;
}
```

- Scheduled idempotency key: hash of workspace, job ID, job revision, and canonical `scheduledFor` time.
- Manual/API idempotency key: caller-provided request ID or generated one-use request ID.
- Unique storage constraint prevents two execution groups for the same scheduled occurrence.
- Every retry receives a new Run ID and attempt number but keeps `executionGroupId`.
- A job revision captured at occurrence creation cannot change while the occurrence executes.
- Missed-run policy explicitly chooses `skip`, `run-latest`, or bounded `catch-up`; unbounded catch-up is forbidden.

## Worker Selection

A queued run can be claimed only by a worker satisfying all of these conditions:

1. Worker is online, not draining, enabled, and protocol-compatible.
2. Worker capability snapshot satisfies source, repository, engine, native-tool, privilege, and secret-provider requirements.
3. Worker matches explicit job affinity, source locality, and device-bound SecretRefs.
4. Worker has available concurrency, temporary capacity, and resource tokens.
5. No source-consistency mutex or incompatible repository maintenance lock is held.
6. Run is not canceled, expired, terminal, or already protected by an unexpired lease.

Selection order is deterministic: explicit worker, required locality, available slots, least active weight, then stable worker ID.

## Run Lease and Fencing

```ts
interface RunLease {
  leaseId: string;
  runId: string;
  workerId: string;
  workerGeneration: string;
  fencingToken: number;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
}
```

- Lease duration: 60 seconds.
- Renewal interval: 15 seconds.
- Acquisition and renewal use control-plane database time and compare-and-swap transactions.
- Every new lease for a run increments its monotonic fencing token.
- Repository locks, checkpoints, and commit records include the fencing token.
- A worker cannot commit a manifest, checkpoint, or terminal event using an older fencing token.
- A worker that cannot renew must stop starting new side effects immediately and abort execution before lease expiry.
- An expired lease moves a nonterminal Run to `interrupted` after reconciliation.

Fencing is mandatory because a network partition or suspended process can otherwise resume after a replacement worker has acquired the run.

## Run Lifecycle

| State | Owner | Required entry evidence | Allowed next state |
| --- | --- | --- | --- |
| `queued` | Scheduler/gateway | Valid occurrence and compatible plan | `preparing`, `canceled` |
| `preparing` | Leased worker | Accepted command and run lease | `running`, `failed`, `canceled`, `interrupted` |
| `running` | Leased worker | Valid plan, required locks, and initialized adapters | `verifying`, `failed`, `canceled`, `interrupted` |
| `verifying` | Leased worker | Repository commit evidence | `succeeded`, `warning`, `failed`, `canceled`, `interrupted` |
| `interrupted` | Reconciler | Expired/lost lease or worker crash | New retry Run or terminal `failed` projection |
| terminal | Gateway | Terminal event with evidence and valid fence | None |

Worker phases refine states without changing the persisted state machine:

- Preparing: resolve secrets, probe capabilities, validate plan, reserve capacity, acquire source and repository locks.
- Running: create consistency boundary, produce artifacts, transfer, checkpoint, commit manifest, and release source boundary.
- Verifying: verify repository commit, checksums, configured sample/full restore, and catalog recovery point.
- Finalizing: release locks, revoke secret leases, clean temporary storage, publish terminal evidence.

The run reaches `succeeded` only after a committed recovery-point manifest and required verification. A restorable commit with nonfatal policy warnings becomes `warning`, not `failed`.

## Checkpoints and Resume

```ts
interface RunCheckpoint {
  checkpointId: string;
  runId: string;
  fencingToken: number;
  sequence: number;
  planDigest: string;
  adapterVersions: Record<string, string>;
  repositoryEngineVersion: string;
  formatVersion: number;
  phase: string;
  committedArtifacts: Array<{ locator: string; checksum: string; sizeBytes: number }>;
  adapterState: unknown;
  createdAt: string;
}
```

Resume requires:

- same execution group, plan digest, adapter-compatible checkpoint format, repository engine, source identity, and required secret versions;
- a new valid run lease and repository lock with a higher fencing token;
- repository confirmation for every checkpointed committed artifact;
- source-side confirmation that any native snapshot/log coordinate remains valid.

If resume validation fails, the checkpoint is quarantined for cleanup and retry starts a safe new attempt. Checkpoints never cause an uncommitted recovery point to appear in the catalog.

## Cancellation

Cancellation is a durable request, not only an in-memory signal.

1. Main process writes `cancellationRequestedAt`, actor, and reason code for a nonterminal Run.
2. Gateway publishes an idempotent `cancel-run` command and makes cancellation visible to lease renewal.
3. Worker stops beginning new phases and propagates AbortSignal to adapters and repository engine.
4. Native processes receive a cooperative interrupt and a 10-second grace period, then controlled termination.
5. Worker aborts uncommitted uploads, removes temporary consistency boundaries, releases locks, and revokes secret leases.
6. Worker emits terminal `canceled` only after cleanup evidence; if the worker disappears, reconciliation records `interrupted` and completes cleanup before cancellation finalization.

After `repository-committed`, cancellation cannot pretend no backup exists. The recovery point is cataloged and the run becomes `warning` or `canceled-with-recovery-point` in result metadata while persisted state remains `warning` or `canceled` according to policy.

## Retry Policy

Notification delivery is outside the Run state machine. Terminal backup and verification records commit before notification dispatch, and a provider failure cannot change those outcomes. Successful route/event deliveries are idempotent; failed provider attempts retain bounded retry deferral and safe evidence in the NotificationRoute.

The persistent scheduled worker also evaluates enabled job RPO targets on each tick. This evaluation is isolated from scheduling and dispatch: an unavailable notification provider or evaluator cannot stop recurrence, retry, heartbeat, or backup execution. The newest succeeded Run is the RPO baseline; job creation time is used until the first success.

Retries create new Run records under the same execution group.

- Default backoff: exponential with jitter, `min(15 minutes, 15 seconds * 2^(attempt-1))`, plus 0-20% jitter.
- Adapter `retryAfterSeconds` raises the delay when longer.
- Default maximum attempts: 3; Policy may lower or raise this within a bounded system maximum.
- Retries re-run compatibility and capacity probes and acquire new leases/fencing tokens.
- Retry does not change job revision, scheduled time, original configuration snapshot, or execution group.

Automatically retryable categories:

- bounded connectivity failures;
- provider throttling or service unavailable;
- interrupted resumable transfer;
- transient repository lock contention;
- worker crash after lease expiry and reconciliation.

Not automatically retryable without a documented safe error code:

- authentication or authorization;
- invalid configuration or incompatible version;
- source consistency failure;
- checksum/integrity failure;
- immutable-retention conflict;
- insufficient capacity;
- explicit cancellation;
- destructive target conflict during restore.

## Crash and Restart Recovery

### Worker Restart

1. Worker generates a new `workerGeneration` and registers again.
2. It loads local checkpoints but does not resume from them directly.
3. Gateway reconciles old-generation leases and waits for expiry or explicitly revokes them.
4. Scheduler/gateway creates or requeues a retry Run according to policy.
5. New attempt validates and adopts a compatible checkpoint with a higher fencing token.

### Gateway or Scheduler Restart

1. Service opens the transactional control database and runs integrity/migration checks.
2. It reconstructs due schedules from policy, not from in-memory timers.
3. It reconciles unacknowledged commands, event sequence gaps, expired leases, and terminal repository commits.
4. It republishes unexpired unacknowledged commands with the same command and idempotency IDs.
5. It never creates a second execution group for an existing occurrence.

### Device Reboot

- Persistent service starts before the UI.
- Missed-run policy determines bounded catch-up.
- Active runs become `interrupted` after lease reconciliation.
- Repository locks are checked and stale locks are broken only through engine-defined safe recovery using fencing evidence.

### Repository Commit Without Terminal Event

If a worker commits a manifest and crashes before its terminal event:

1. Reconciler finds `repository-committed` evidence or probes the exact manifest ID.
2. It validates manifest checksum, run ID, source, plan digest, and fencing token.
3. It creates the missing RecoveryPoint catalog record idempotently.
4. It schedules configured verification.
5. It marks the run `warning` or `succeeded` only after required evidence; otherwise it remains `interrupted` and alerts an operator.

## Resource and Concurrency Control

Worker advertises capacity and acquires bounded tokens for:

- total active runs;
- CPU-intensive compression/encryption;
- network streams;
- temporary storage reservations;
- per-source consistency operations;
- per-repository write/maintenance operations;
- native database backup concurrency.

Restore and verification use separate policy limits. User-initiated restore may receive higher priority but cannot bypass repository safety locks or starve lease renewals.

## Secret Leases

- Worker requests each SecretRef only after acquiring the Run lease.
- Gateway validates workspace, run, adapter, operation, secret version, and worker scope.
- Returned secret lease is memory-only, operation-scoped, and expires no later than the Run lease.
- Renewal requires the current fencing token.
- Worker revokes/discards secret leases during finalization, cancellation, or lease loss.
- Commands, events, checkpoints, environment diagnostics, and logs contain SecretRef IDs and versions only.

## Logs and Progress

- Structured logs contain timestamp, run ID, phase, severity, component, safe code, and redacted fields.
- Worker stores bounded detailed logs locally and publishes safe summaries/events.
- Progress is monotonic per phase and includes scanned items, logical bytes, transferred bytes, deduplicated bytes, throughput, and ETA when known.
- Heartbeats stay small; run progress uses event coalescing no more frequently than once per second unless a phase changes.
- Terminal reports retain verification and cleanup evidence even when detailed logs expire.

## Protocol Compatibility

- Worker and gateway negotiate a single protocol version during registration.
- Additive optional fields do not change protocol version and are ignored safely by older compatible peers.
- Breaking envelope, authentication, lease, fencing, or state semantics require a new protocol version.
- A worker with unsupported protocol is marked `incompatible` and cannot claim work.
- Rolling upgrades drain workers, finish or checkpoint active runs, then replace the service.
- Repository restore compatibility is governed by adapter and repository-engine versions captured in the RecoveryPoint, not only worker version.

## Security Requirements

1. Local IPC accepts only the owning OS user/service identity.
2. Worker authentication keys live in operating-system secure storage and rotate without changing worker ID.
3. Commands are scope-bound, expiring, digest-protected, replay-safe, and idempotent.
4. Worker never trusts renderer-originated plans; main process and worker both validate schemas and capability requirements.
5. Native processes run with minimum privileges, bounded output, controlled environment, and explicit executable paths.
6. Repository operations require current run lease and fencing token.
7. Remote protocol support cannot ship without mutual TLS, revocation, workspace authorization, and audited enrollment.

## Required Failure Tests

| Scenario | Expected result |
| --- | --- |
| Duplicate schedule tick | One execution group and one initial Run |
| Duplicate execute command | One lease and no repeated committed side effect |
| Worker killed while preparing | Lease expires, run interrupts, locks/secrets reconcile, safe retry |
| Worker killed during upload | No recovery point from uncommitted data; resumable checkpoint is validated |
| Worker killed after manifest commit | Reconciler catalogs exact committed recovery point idempotently |
| Gateway killed during event commit | Worker replays unacknowledged event; duplicate is ignored |
| Network/IPC partition | Worker stops side effects before lease expiry; replacement uses higher fence |
| Suspended worker resumes late | Stale fencing token blocks checkpoint, commit, and terminal event |
| Cancel during native dump | Cooperative interrupt, bounded termination, cleanup, terminal evidence |
| Authentication expires | Secret renewal fails safely; classified result follows retry policy |
| Repository lock contention | No concurrent unsafe writer/prune; bounded retry |
| Repository fills mid-run | Abort uncommitted output, preserve existing recovery points, capacity error |
| Clock skew | Gateway time controls leases; unsafe registration skew is rejected |
| Service reboot with missed runs | Configured bounded missed-run policy is applied exactly once |
| Adapter upgrade with checkpoint | Resume only when declared checkpoint compatibility passes |

## Version 1 Exit Criteria

- Scheduled jobs execute with the Electron window closed.
- Duplicate schedule and command delivery cannot create duplicate committed recovery points.
- Lease loss and stale workers are fenced from repository commit.
- Cancellation reaches adapters/native processes and produces cleanup evidence.
- Retry grouping preserves the original occurrence and configuration snapshot.
- Worker, gateway, and device restart tests pass at every execution phase.
- No command, event, checkpoint, progress record, or log contains plaintext secrets.
