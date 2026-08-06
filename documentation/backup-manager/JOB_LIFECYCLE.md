# Backup Job Lifecycle Operations

## Status

- Task: `BM-209`
- Status: Implemented
- Last updated: 2026-08-03

## Scope

Backup Manager supports pause, resume, clone, disable, and delete operations for BackupJobs, plus cancel and retry operations for backup Runs. Every mutation is workspace-scoped, derives actor identity in the main process, uses optimistic job revisions where applicable, and is recorded in the tamper-evident audit chain.

These operations do not edit immutable Run snapshots, RecoveryPoints, Artifacts, or restore history.

## Job States

| Command | Required state | Result | Active Run behavior |
| --- | --- | --- | --- |
| Pause | `enabled` | `paused` | Existing Run may finish; no new manual, scheduled, resumed, or automatic retry Run starts |
| Resume schedule | `paused` | `enabled` | Preserved schedule is eligible again; missed-run policy decides overdue occurrences |
| Disable | `enabled` or `paused` | `disabled` | Refused while a Run is active |
| Delete | `disabled` | soft-deleted | Refused while a Run is active |
| Clone | any active record | new `enabled` job | Does not affect the source job or its Runs |

Pause is reversible and preserves `nextRunAt`, schedule state, and Policy state. It is suitable for temporary maintenance. Resume applies only to paused jobs; it does not re-enable a disabled job.

Disable is an administrative terminal configuration state in the current UI. It blocks manual execution and scheduler dispatch and is required before deletion. It intentionally differs from pause so an operator cannot accidentally resume a job prepared for removal.

Every state transition requires the exact current BackupJob revision. Stale commands fail with a refresh-and-retry conflict instead of overwriting a newer lifecycle decision. Lifecycle timestamps and actor IDs are stored as bounded job metadata.

## Cancel

Cancel accepts only a Run in `queued`, `preparing`, `running`, or `verifying`. One transaction projects the Run and its ExecutionGroup to `canceled`, clears the lease, records terminal time, changes the progress phase to `canceled`, and stores bounded cancellation evidence and a safe result. A second cancel or cancellation of another terminal Run is rejected.

Terminal projection is the publication fence: an executor holding an older Run revision cannot later publish a RecoveryPoint or move the Run to success. Provider work already inside an uninterruptible operation is not force-killed. An immutable object that completes after the terminal fence is not added to the recovery catalog; repository orphan reconciliation and cleanup remain future maintenance work.

Canceled Runs stay in Activity history and can be retried when their job is enabled and currently ready.

## Resume Versus Retry

Resume and retry are separate operations:

- **Resume interrupted backup** continues a nonterminal interrupted ExecutionGroup from authenticated checkpoint evidence. It preserves the immutable snapshot, attempt sequence, and parent Run. The current job must be enabled. The worker also leaves interrupted work untouched while a job is paused or disabled.
- **Retry failed or canceled backup** creates a fresh manual ExecutionGroup after revalidating the job's current source, destinations, credentials, Policy, and readiness. Its first Run has trigger `retry` and a bounded `retryOfRunId` link to the selected terminal Run. It does not reuse the terminal Run's configuration snapshot or checkpoint.

Only failed and canceled Runs can use the fresh retry action. Interrupted Runs use resume, and successful/warning Runs require a normal new manual execution if another backup is desired. The usual one-active-Run-per-job rule still applies.

## Clone

Clone requires the exact current source-job revision and reuses the current mutable configuration through the same validation path as ordinary job creation. It copies:

- source and ordered repository identities;
- backup mode, compression, verification, retention, and schedule;
- priority, retry, and bandwidth policy;
- RPO and RTO targets;
- enabled notification-route assignments.

Clone creates new BackupJob and Policy identities, recalculates the first schedule occurrence from clone time, resets lifecycle and scheduling evidence, and sets `lastSuccessfulRunId` to null. Runs, ExecutionGroups, RecoveryPoints, Artifacts, RestoreRuns, and VerificationRuns are never copied.

Without an explicit name, cloning uses `<source name> copy`, then deterministic numeric suffixes. The current UI uses automatic naming; the backend accepts an optional explicit name for future editing workflows.

## Delete

Delete is a soft delete and requires an idle disabled job. Run and recovery history remain addressable by their durable IDs and immutable snapshots even though the job no longer appears in the active Jobs list.

The job-owned Policy is soft-deleted only when no other active BackupJob references it. Before deleting such a Policy, notification-route bindings are removed through a normal revisioned Policy update so route referential indexes remain accurate. Shared Policies remain intact.

Delete does not remove repository data, RecoveryPoints, Artifacts, logs, audit records, SecretRefs, Sources, Repositories, or notification routes. Recovery data deletion remains governed by retention and confirmed repository pruning.

## User Interface

Each Jobs row exposes familiar icon controls with labels and tooltips:

- run, cancel, resume interrupted work, or retry as the context-sensitive primary action;
- pause or resume schedule;
- clone;
- disable;
- delete.

Unsafe cancel, disable, and delete actions require confirmation. Disable is unavailable while a Run is active. Delete is unavailable until the job is disabled. On narrow screens the five-action toolbar moves to its own row and remains inside the job surface.

## IPC Surface

- `backup:jobs:pause`
- `backup:jobs:resume`
- `backup:jobs:clone`
- `backup:jobs:disable`
- `backup:jobs:delete`
- `backup:runs:cancel`
- `backup:runs:retry`

No lifecycle IPC accepts workspace or actor identity from the renderer. Job operations accept the current revision; Run operations authorize the Run through the current workspace lookup.

## Deferred Work

- Re-enable and edit workflows for disabled jobs;
- bulk lifecycle operations and maintenance-mode grouping;
- cancellation propagation into provider-specific abort signals;
- orphan-object reconciliation after a provider commit races cancellation;
- configurable clone naming in the UI;
- approval workflows, role-based lifecycle permissions, and remote worker command queues.

