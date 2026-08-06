# Schedule Policies

## Scope

`BM-201` adds persisted manual, interval, cron, hourly, daily, weekly, and monthly schedules to file backup Policies. Schedule calculation is isolated from execution: the schedule engine produces canonical occurrence timestamps and the existing windowless worker dispatches those timestamps through the idempotent scheduled-backup contract.

`BM-201` introduced UTC recurrence. `BM-202` extends the same contract with IANA timezones, daylight-saving decisions, missed-run choices, maintenance windows, and blackout calendars, documented in `TIMEZONE_AND_EXECUTION_CALENDAR_POLICIES.md`.

## Canonical Contract

Every normalized schedule contains:

- `version: 1`;
- one supported `type`;
- `timezone: UTC`;
- `dstBehavior: not-applicable`;
- `missedRunBehavior: pending-policy`.

Legacy `on-demand` input normalizes to `manual`. New records use `manual` consistently.

| Type | Required fields | Next-occurrence behavior |
| --- | --- | --- |
| `manual` | none | No automatic occurrence. |
| `interval` | `intervalMinutes`, `anchorAt` | Fixed 1-525,600 minute cadence from an immutable UTC anchor. |
| `cron` | five-field `expression` | Standard minute, hour, day-of-month, month, and day-of-week expression in UTC. |
| `hourly` | `minute` | Once per hour at minute 0-59. |
| `daily` | `time` | Once per UTC day at `HH:mm`. |
| `weekly` | `daysOfWeek`, `time` | One or more weekdays, where Sunday is 0 and Saturday is 6. |
| `monthly` | `dayOfMonth`, `time` | Day 1-31; a month without that day is skipped. |

Five-field cron validation and occurrence calculation use the pinned `cron-parser` dependency. Second-level cron is intentionally not accepted because the worker polls on a minute-scale operational cadence and backup jobs should not create second-frequency work.

## First Occurrence

`BackupJobService.create()` normalizes the requested schedule before opening the control-database transaction. Invalid schedule input therefore cannot leave an orphan Policy or BackupJob.

The first `nextRunAt` is calculated strictly after the job creation timestamp. Manual policies store `null`. Interval schedules persist the creation timestamp as `anchorAt`, including seconds, so their cadence does not change across restarts.

Policy and BackupJob creation remain atomic. The Policy holds the normalized schedule; the BackupJob holds the next materialized occurrence and schedule dispatch state.

## Recurrence And Idempotency

The scheduled worker dispatches the exact persisted `nextRunAt` through `ManualBackupService.startScheduled()`. That service derives its occurrence key from workspace, job ID and revision, and the canonical scheduled timestamp. Duplicate foreground/background delivery still resolves to one ExecutionGroup and Run.

Only after the Run exists does the worker:

1. mark the occurrence as dispatched;
2. calculate the next timestamp from the consumed `scheduledFor`, not from wall-clock completion time;
3. persist the new `nextRunAt` and calculation evidence with an optimistic job revision.

Using `scheduledFor` prevents backup duration, retries, or worker polling delay from shifting the cadence. A malformed persisted recurrence is consumed safely after its Run is created, records a bounded non-retryable recurrence error, and disables automatic recurrence instead of repeatedly redelivering the completed occurrence.

BM-201 does not skip past overdue occurrences. The worker can consume the next persisted due timestamp on a later tick after the execution slot is free. Explicit skip, coalesce, or catch-up policy belongs to BM-202.

## Job UI

The Protection step in the existing Create backup job wizard includes:

- a schedule-type menu with all seven modes;
- bounded interval minutes;
- a five-field cron input;
- hourly minute;
- daily UTC time;
- seven weekday checkboxes and weekly UTC time;
- monthly day and UTC time.

The Review step shows the normalized human-readable cadence. Persisted job rows show cadence and the next calculated execution together. Manual execution remains available for every recurring job.

The audited `backup:jobs:create` mutation records the schedule type but not the cron expression or other schedule details. The existing job list, worker-status, manual-run, and scheduled-run APIs require no new tenant inputs.

## Limits And Deferred Work

- UTC remains the default; BM-202 accepts validated IANA timezones.
- Monthly days absent from a month are skipped; alternative last-day behavior is not yet configurable.
- Cron uses five fields and has no seconds field.
- Interval cadence is fixed-duration minutes and does not represent calendar months.
- Schedule edits, enable/disable, cloning, deletion, and other lifecycle commands belong to BM-209.
- Timezone, DST, missed-run, maintenance-window, and blackout behavior are implemented by BM-202.
- Concurrency, priority, bandwidth windows, and richer retry backoff are implemented by BM-203.

## Verification

- Schedule-engine tests cover normalization, stable interval anchoring, every schedule family, strictly later occurrences, monthly absent-day skipping, five-field cron parsing, bounds, empty weekly selections, and timezone refusal.
- Job-service tests create all six recurring schedule families, validate their first `nextRunAt`, and prove invalid cron leaves no Policy or BackupJob.
- Worker tests prove a daily occurrence advances from `scheduledFor` without cadence drift while preserving single-slot, retry, and restart behavior.
- A real no-window Electron integration executes an encrypted scheduled backup in a second process and persists the exact next daily occurrence with one RecoveryPoint and zero BrowserWindows.
- The Jobs Electron UI harness verifies all seven options, weekly-field switching, the daily payload and review, cadence rendering, desktop and 390px mobile containment, seven bounded weekday controls, and no horizontal overflow.
