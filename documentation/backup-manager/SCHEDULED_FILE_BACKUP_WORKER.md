# Scheduled File Backup Worker

## Scope

`BM-114` executes due file backup occurrences in a persistent, windowless Electron worker. It uses the encrypted, resumable execution pipeline from `BM-113` and supports local and SSH/SFTP sources with local-folder, SFTP, and S3-compatible repositories.

This task consumes a canonical `BackupJob.nextRunAt` value. `BM-201` calculates manual and recurring occurrences; `BM-202` adds IANA timezone, daylight-saving, missed-run, maintenance-window, and blackout decisions before dispatch; `BM-203` adds delayed retry, slot, priority, and bandwidth policy.

## Process Ownership

The existing detached `--uptime-worker` process owns both uptime monitoring and scheduled backup execution. One per-user background process opens the Backup Manager control database, initializes Electron `safeStorage`, creates the source and repository services, and starts the scheduled worker for the active workspace. No `BrowserWindow` is required.

Control-database access is safe across the foreground and detached processes:

- an atomic PID/token lock serializes reads that can lead to writes and all transactions;
- every operation reloads the latest committed SQLite bytes before reading;
- writes use same-directory temporary files and atomic replacement;
- dead-owner and expired locks are removed, while live lock contention uses bounded retry and timeout behavior.

## Worker Protocol

Protocol version 1 identifies a worker by `device:<deviceId>` and a process generation by PID plus a random UUID. A durable WorkerRegistration records:

- worker and device identity;
- protocol version and process generation;
- online, draining, or offline state;
- process ID, heartbeat, and last tick times;
- active Run IDs and configured concurrency;
- supported source adapters, repository adapters, and repository engines.

The default heartbeat interval is 10 seconds and the dispatch poll interval is 15 seconds. The UI considers the device worker online only when its latest registration is online and its heartbeat is no more than 30 seconds old.

## Dispatch Contract

Each tick performs these steps in order:

1. Persist the heartbeat and tick time.
2. Reconcile stale nonterminal Runs from a stopped process.
3. Persist missing retry schedules for interrupted occurrences and terminally fail disallowed categories or exhausted attempts.
4. Count the union of durable nonterminal Runs and in-process Runs against the configured slots; the default is two and the validated range is 1-16.
5. Combine eligible retries and due enabled jobs, exclude paused/disabled jobs and jobs that already have an active Run, and order critical through low priority before eligible/scheduled time, creation time, and stable ID.
6. Resume or start candidates until the slots are full. Calendar or missed-run handling for one job does not block another eligible job.
7. Advance a consumed `nextRunAt` from its scheduled timestamp and persist dispatch evidence only after the Run exists. Manual policies clear the occurrence.

A dispatch failure leaves `nextRunAt` intact and records a bounded safe failure plus a retry time 60 seconds later. Unknown errors do not expose stack traces, credentials, provider responses, or filesystem details.

## Occurrence Idempotency

Scheduled execution derives a deterministic occurrence key from workspace ID, BackupJob ID and revision, and canonical scheduled time. ExecutionGroup and Run creation occurs transactionally under uniqueness constraints.

Delivering the same occurrence more than once returns the existing Run. A foreground process and background process racing to dispatch the same occurrence therefore cannot create duplicate executions or RecoveryPoints.

## Restart And Retry

Queued Runs are treated as stale after 60 seconds. Preparing, running, and verifying Runs are stale only after their lease expires. Reconciliation projects stale work to `interrupted` with a bounded process-interruption result.

For scheduled and retry-triggered Runs, the worker uses the immutable Run snapshot rather than the current editable Policy:

- excluded categories and nonretryable failures terminally fail both the interrupted Run and its ExecutionGroup;
- below the limit, fixed, linear, or exponential backoff plus deterministic jitter is persisted as `retryState.notBefore` before a retry can run;
- at the limit, it terminally fails both the interrupted Run and its ExecutionGroup;
- eligible work creates a new retry Run in the same ExecutionGroup and resumes from authenticated checkpoint evidence.

Repository snapshot idempotency, encrypted checkpoints, manifest verification, and atomic RecoveryPoint publication retain the `BM-113` guarantees across worker restarts.

Paused and disabled jobs are also excluded from retry dispatch. Pausing preserves the persisted retry deadline and schedule occurrence; resuming makes it eligible again without moving either timestamp.

## Status API And UI

`backup:worker:status` returns the current device registration, freshness-derived online state, active Run IDs, protocol version, heartbeat, process generation, and earliest enabled job `nextRunAt`. The preload bridge exposes this as `getBackupWorkerStatus()`.

The Jobs view displays online/offline worker state and the earliest pending worker execution. Each scheduled job also displays its own next execution time. Public Run status includes queued priority, delayed retry time, active bandwidth limit, and cumulative throttle delay without exposing the immutable configuration snapshot.

## Verification

The no-window Electron integration performs setup through the real local connection, file source, local repository, and job services. It closes the setup database, starts a separate Electron process against the same Backup Manager root, and proves that the worker:

- resolves the persisted Electron `safeStorage` repository key;
- executes the due local-file occurrence through the encrypted repository engine;
- persists one succeeded schedule-triggered Run and one RecoveryPoint;
- consumes `nextRunAt` exactly once;
- creates no BrowserWindow in either process.

Focused unit coverage additionally proves worker registration and heartbeat, priority ordering, multi-slot filling, slot enforcement, duplicate-delivery idempotency, cross-instance database serialization, durable delayed retry, retry-category refusal, and retry-limit finalization.

## Deferred Work

Operating-system service installation and login-start policy can be added separately if the detached Electron process is later replaced by a native service host. Remote-worker command delivery and provider-specific cancellation propagation remain future protocol work.
