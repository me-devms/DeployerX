# Backup Execution Policies

## Status

- Task: `BM-203`
- Status: Implemented
- Last updated: 2026-08-03

## Policy Contract

Every new backup Policy stores normalized execution controls before the Policy and BackupJob transaction begins. Invalid input therefore leaves neither record behind.

- Priority is `low`, `normal`, `high`, or `critical`.
- Maximum attempts are bounded from 1 through 10 and include the first attempt.
- Backoff is `fixed`, `linear`, or `exponential`.
- Initial and maximum delays are bounded from 1 second through 7 days; maximum delay cannot be below the initial delay.
- Jitter is bounded from 0 through 100 percent and is derived from a SHA-256 value bound to the ExecutionGroup and next attempt. Restarting a worker cannot move an already calculated retry.
- Retryable categories are an explicit subset of connectivity, timeout, capacity, source, repository, worker, and execution failures.
- Default and scheduled bandwidth limits are either unlimited or 64 KiB/s through 10 GiB/s.
- Bandwidth schedules use an IANA timezone, up to 32 weekly windows, weekday sets, and different `HH:mm` start/end values. Cross-midnight windows are supported.

The creation wizard captures all retry controls, priority, an optional default limit, and one weekly bandwidth window. The backend contract supports 32 windows for later editing and API workflows.

## Retry Lifecycle

Only interrupted schedule- or retry-triggered Runs are automatic-retry candidates. The worker reads retry settings from the Run's immutable configuration snapshot, so later Policy changes cannot alter an occurrence already in progress.

When an interrupted Run becomes visible to the worker:

1. A nonretryable result, or a category excluded by the snapshot, terminally fails the Run and ExecutionGroup.
2. An attempt at the configured limit terminally fails with bounded safe evidence.
3. Otherwise, the worker calculates and persists `retryState`, including the next attempt, delay, `notBefore`, backoff, jitter, failure category, and scheduling time.
4. The Run remains interrupted and is not resumed before `notBefore`, including after process restart.
5. When eligible and a slot is available, resume creates the next Run in the same ExecutionGroup and retains checkpoint and repository idempotency guarantees.

A retryable failure while creating the next Run keeps the parent interrupted and persists a bounded 60-second redispatch time. A nonretryable resume failure terminally fails the occurrence.

The failed timestamp is recorded with runtime failures. Legacy interrupted records fall back to their durable completion/update timestamp.

## Concurrency And Priority

The persistent worker has two execution slots by default and accepts a validated 1-16 slot configuration. Slots are counted from the union of persisted nonterminal Runs and Runs tracked in the current process.

Concurrency applies to independent BackupJobs. A job can have only one active Run, and repository copies inside a Run remain sequential so repository leases, checkpoints, and progress stay authoritative.

Eligible delayed retries and due scheduled jobs share one queue. Ordering is:

1. priority from critical through low;
2. retry eligibility or scheduled occurrence time;
3. durable creation time;
4. stable record ID.

Calendar and missed-run decisions can defer or consume one candidate without blocking unrelated candidates from filling remaining slots.

## Bandwidth Enforcement

One `BandwidthLimiter` is created per Run from the immutable Policy snapshot. The same limiter is passed to every local or SSH/SFTP source payload stream and reused across sequential repository copies.

At each 64 KiB source block, the limiter evaluates the current local-time windows. When windows overlap, the lowest active limit wins; otherwise the default applies. Unlimited policy returns immediately. The limiter serializes consumers against one run-level availability clock, so changing files or repository copies does not reset the allowance.

Durable Run progress records the current `bandwidthLimitBytesPerSecond` and cumulative `throttleWaitMilliseconds` alongside bytes and throughput. The Jobs view displays the active limit.

## UI And Public Status

The Protection step validates and reviews priority, attempts, backoff, initial/maximum delay, jitter, default bandwidth, and a weekly window. The layout remains contained at desktop and 390px mobile widths.

Public Run projections expose only the normalized priority and retry state, not the complete configuration snapshot. Job rows show queued priority, the next automatic retry time, and active bandwidth limiting without exposing connection or credential configuration.

## Verification

- Execution-policy tests cover normalization, bounds, all backoff modes, deterministic jitter, caps, priority ranking, cross-midnight windows, overlapping limits, and shared pacing.
- Job tests prove normalized policy persistence and invalid-policy atomicity.
- Local and SSH source-reader tests prove every payload block passes through the supplied run limiter.
- Worker tests prove durable delayed retry, category refusal, retry limits, two simultaneous independent jobs, slot enforcement, and priority ordering.
- The Jobs Electron integration verifies the complete payload, review, queued/retry/throttle states, desktop and 390px containment, and no horizontal overflow.
- The separate-process Electron worker still completes an encrypted zoned backup with one RecoveryPoint and no BrowserWindow.

## Deferred Work

Retention classification is implemented by `BM-204`; safe pruning and capacity protection belong to `BM-205`. Detailed run history and logs belong to `BM-206`. Pause, cancel, forced retry, policy editing, and other job lifecycle controls belong to `BM-209`.
