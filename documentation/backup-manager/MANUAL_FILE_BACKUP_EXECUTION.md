# Manual File Backup Execution

## Scope

`BM-113` executes enabled file backup jobs on demand. It supports local and SSH/SFTP file sources and local-folder, SFTP, and S3-compatible repositories. A job can commit to one primary repository and multiple ordered copy repositories. Scheduling and detached worker execution remain part of `BM-114`.

## Start Contract

The main process derives the workspace and actor from the current application session. The renderer supplies only a BackupJob ID. Before creating execution records, the service verifies:

- the job is enabled and has an enabled Policy;
- the file source is enabled, its selector is valid, and its connection passed its latest health test;
- the source connection and every repository belong to the current device;
- every destination is ready and has an available repository lock capability;
- all referenced source, connection, repository, adapter, engine, repository-format, key, and SecretRef versions can be captured.

One control-database transaction creates the ExecutionGroup and first queued Run. The Run stores an immutable configuration snapshot and a canonical SHA-256 plan digest. A second active Run for the same job is refused.

## Execution Sequence

1. Acquire a fenced Run lease and project `queued -> preparing` while the ExecutionGroup becomes `running`.
2. Revalidate the captured source, connection, SecretRef, repository, adapter, engine, and key versions.
3. Project `preparing -> running` and traverse the source with bounded local filesystem or SFTP readers.
4. Acquire an encrypted repository lease for each destination in configured order.
5. Stream source entries into the encrypted deduplicating repository engine. Full jobs omit a parent; incremental jobs link to the latest available repository copy.
6. Confirm the immutable manifest object exists, record its size and SHA-256 checksum, and persist an encrypted checkpoint.
7. Release the repository lease even when transfer or commit fails.
8. Project `running -> verifying` and reopen every committed manifest. Locator, ciphertext checksum, and object size must match checkpoint evidence.
9. In one transaction, publish the RecoveryPoint and Artifact records, update the job's last successful Run, and terminally project the Run and ExecutionGroup.
10. Remove current and parent checkpoint files only after successful publication.

Repository snapshot idempotency keys are derived from the ExecutionGroup and repository ID. Retrying the same occurrence cannot create a conflicting second manifest.

## Progress Model

The renderer receives only public Run projections. Progress writes are throttled to 250 ms and renew the Run lease. Fields include:

- phase and current source path;
- repository index/count and committed repository count;
- scanned entries, files, directories, and symbolic links;
- discovered source bytes, bytes read, uploaded bytes, and deduplicated bytes reused;
- measured byte throughput, start time, and last update time.

The Jobs and Activity views poll once per second while visible and a relevant Backup Run, RestoreRun, or VerificationRun is active. Polling stops when no displayed operation remains active, the user selects another Backup Manager tab, or the user leaves Backup Manager.

## Checkpoint And Resume

After each repository commit, the service writes a versioned AES-256-GCM checkpoint beneath Backup Manager's private data directory. HKDF derives a checkpoint key from the primary repository master key. Authenticated data binds the checkpoint to workspace, Run, and primary repository identities.

The checkpoint contains the execution group, fencing token, monotonic sequence, plan digest, adapter and engine versions, committed artifact evidence, source adapter state, and public progress. Replacement is atomic.

Resume creates a new retry Run in the same ExecutionGroup and preserves the parent Run. Before launch it authenticates the checkpoint, revalidates the immutable plan, and reopens each committed manifest. Confirmed repositories are skipped; uncommitted destinations continue in order. A retry checkpoint may reference its parent Run until the retry commits another destination. Missing, modified, foreign, or incompatible advertised checkpoints are quarantined and fail closed.

Resume is allowed only while the current BackupJob is enabled. Paused and disabled jobs retain interrupted evidence without dispatching it.

## Cancel And Fresh Retry

User cancellation atomically terminally projects an active Run and its ExecutionGroup to `canceled`. Optimistic Run revisions fence any older executor from publishing a RecoveryPoint after cancellation. Provider calls already in flight are not force-killed; see `JOB_LIFECYCLE.md` for the orphan-reconciliation boundary.

Fresh retry applies only to failed or canceled Runs. It revalidates the current enabled job configuration and creates a new manual ExecutionGroup whose first Run has trigger `retry` and `retryOfRunId` evidence. This differs from interrupted resume, which retains the original group, snapshot, attempt sequence, and checkpoint.

## Failure Semantics

- A failure before any durable checkpoint becomes `failed` unless it is retryable, in which case the Run may be `interrupted` without a resume action.
- A failure after any repository commit becomes `interrupted` and retains checkpoint evidence.
- A nonretryable terminal failure also terminally fails the ExecutionGroup.
- A partially committed multi-repository Run never publishes a RecoveryPoint.
- Manifest verification failure never publishes RecoveryPoint or Artifact records.
- On application startup, stale queued, preparing, running, or verifying Runs are projected to `interrupted` with a bounded process-interruption result.

Errors exposed to the renderer contain a bounded safe code, safe message, category, and retryability flag. Unknown implementation errors do not expose platform paths, credentials, adapter responses, or stack details.

## Desktop API

- `backup:jobs:runs:list`: list public Run projections, optionally for one job.
- `backup:jobs:run`: start an on-demand file backup.
- `backup:runs:resume`: create a retry Run from an interrupted Run.
- `backup:runs:cancel`: terminally cancel an active Run and its ExecutionGroup.
- `backup:runs:retry`: start a fresh execution for a failed or canceled Run from current job configuration.
- `backup:logs:list`: list redacted `backup-run` log entries for one existing workspace Run.

Start, resume, cancel, and retry use the existing tamper-evident audit chain. Workspace and actor identifiers are never accepted from renderer payloads.

## Deferred Work

Scheduled execution, occurrence idempotency, snapshot browsing, restore, sampled verification, source-stream bandwidth enforcement, and lifecycle commands are implemented through `BM-209`. Richer ETA calculation, provider abort propagation, and orphan-object reconciliation remain later work.
