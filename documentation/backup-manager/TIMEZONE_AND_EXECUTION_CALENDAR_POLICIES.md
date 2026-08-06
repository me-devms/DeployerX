# Timezone And Execution Calendar Policies

## Scope

`BM-202` extends recurring file-backup schedules with IANA timezones, explicit daylight-saving behavior, missed-run decisions, weekly maintenance windows, and absolute blackout ranges. These policies are normalized before Policy and BackupJob creation, evaluated by the persistent scheduled worker, and recorded in durable `BackupJob.scheduleState` evidence.

Manual execution remains available regardless of automatic scheduling windows. Calendar policy controls automatic starts only.

## IANA Timezones

Calendar schedules persist one IANA timezone, validated with the pinned `luxon` dependency. UTC remains the default. Hourly, daily, weekly, monthly, and cron occurrences are interpreted as wall-clock values in that zone and emitted as canonical UTC instants.

Interval schedules remain elapsed-time schedules anchored to an absolute instant. Their fixed minute cadence does not change at a daylight-saving boundary, although their timezone remains available for display and execution-calendar evaluation.

The timezone is part of the immutable Policy snapshot captured by each Run. A system timezone change therefore cannot silently change an existing job.

## Daylight-Saving Policy

Non-UTC calendar schedules persist two independent choices:

| Condition | Choices | Meaning |
| --- | --- | --- |
| Nonexistent wall time during a spring gap | `shift-forward`, `skip` | Use the corresponding shifted valid time or omit that occurrence. |
| Repeated wall time during a fall overlap | `first`, `second`, `both` | Use the earlier offset, later offset, or create one occurrence at each distinct instant. |

The same policy applies to hourly, daily, weekly, monthly, and five-field cron schedules. For `both`, the two instants have different canonical scheduled timestamps and therefore different occurrence-idempotency keys.

UTC schedules persist `not-applicable` for both choices. Invalid zones or DST options are rejected before the control-database transaction.

## Missed Runs

Each recurring schedule persists:

- `behavior`: `run-latest`, `run-all`, or `skip`;
- `graceMinutes`: 0 through 10,080.

An occurrence no more than the grace period late is dispatched normally. Beyond grace:

| Behavior | Result |
| --- | --- |
| `run-latest` | Coalesce all currently due occurrences and dispatch only the newest scheduled instant. |
| `run-all` | Dispatch the oldest occurrence; recurrence leaves the next overdue timestamp pending for a later worker slot. |
| `skip` | Consume every currently due occurrence and persist the first future timestamp without creating a Run. |

Scanning is bounded to 1,000 occurrences per worker decision. If more remain due, the worker persists an `advance` decision and continues from that checkpoint on a later tick without dispatching an inaccurate "latest" occurrence.

Every coalesce, skip, or bounded advance records the original timestamp, selected timestamp, next timestamp, skipped count, lateness, evaluation time, and scan-limit state. No source paths, credentials, or provider errors are included.

## Maintenance Windows

A schedule can persist up to 32 weekly maintenance windows. Each contains:

- one or more weekdays in the schedule timezone;
- a local `HH:mm` start and end;
- derived cross-midnight behavior when end is earlier than start.

No configured windows means automatic execution is unrestricted. With windows configured, starts are allowed only inside an active window. Ambiguous boundaries use the earliest start and latest end so an overlap does not unexpectedly shorten a permitted window. Nonexistent boundaries shift to the next valid local time.

Outside-window behavior is:

- `defer`: retain the scheduled occurrence and set `nextDispatchAttemptAt` to the next local opening;
- `skip`: consume all blocked occurrences through the current instant and materialize the next future recurrence.

## Blackouts

A schedule can persist up to 32 absolute blackout ranges. Each range contains canonical `startsAt` and `endsAt` instants, with end strictly after start. Absolute instants avoid ambiguity during DST changes and remain stable if timezone rules are updated later.

During an active blackout:

- `defer` retains the occurrence and retries after the latest end among overlapping active ranges;
- `skip` consumes blocked occurrences through the current instant.

Blackouts are evaluated before maintenance windows. Execution-calendar gating is evaluated before missed-run policy, so a deferred occurrence is not consumed while its calendar gate remains closed. When the gate opens, the configured missed-run policy decides whether to replay, coalesce, or skip the overdue occurrence.

## Worker Persistence

For each due job the worker:

1. checks blackout and maintenance policy;
2. persists a defer or skip decision when blocked;
3. evaluates lateness and persists any coalesce, replay, skip, or bounded advance decision;
4. dispatches the selected canonical timestamp through the existing idempotent `startScheduled()` contract;
5. advances recurrence from that selected timestamp only after a Run exists.

Calendar and missed-run projections use optimistic BackupJob revisions. The worker status API reports the later of `nextRunAt` and `nextDispatchAttemptAt`, so a deferred job does not advertise an already-past execution as its effective next start.

## Job UI

The Create backup job wizard exposes:

- all runtime-supported IANA zones;
- spring-gap and fall-overlap choices for non-UTC calendar schedules;
- missed-run behavior and grace period;
- one optional weekly maintenance window with weekday, local-time, and defer/skip controls;
- one optional absolute UTC blackout with defer/skip behavior.

The backend contract supports 32 maintenance windows and 32 blackout ranges even though initial creation UI intentionally captures one of each. Review shows the cadence and calendar policy summary. Job rows show cadence plus the next occurrence, or an explicit deferred-until time from durable worker state.

No new IPC surface is required. The existing audited `backup:jobs:create`, job list, worker status, and scheduled execution APIs carry the normalized Policy and public schedule state. Audit details continue to store only the schedule type, not timezone rules or blackout values.

## Limits And Deferred Work

- Timezone rule behavior follows the packaged IANA data supplied by `luxon` and the Electron runtime.
- Initial creation UI supports one maintenance window and one blackout; the persisted contract supports 32 each for later editing and API workflows.
- Blackouts are absolute ranges, not recurring holiday calendars.
- Schedule editing and job lifecycle commands remain assigned to `BM-209`.
- Retry backoff, concurrency, priority, and timezone-aware bandwidth windows are implemented by `BM-203`.
- Notifications for skipped, deferred, and overdue work remain assigned to `BM-207`.

## Verification

- Schedule tests use real 2026 `America/New_York` transitions and prove shift/skip behavior for spring gaps plus first/second/both behavior for fall overlaps, including cron.
- Policy tests cover normalization, invalid inputs, all missed-run choices, grace, 1,000-occurrence scan bounds, cross-midnight maintenance windows, local deferral boundaries, and blackout defer/skip.
- Job tests prove timezone, DST, missed-run, maintenance, and blackout data persist atomically with a timezone-correct first occurrence.
- Worker tests prove durable coalescing, skip, maintenance defer, blackout skip, and effective status time without breaking single-slot, restart, or retry behavior.
- A real separate-process Electron integration executes an encrypted `America/New_York` scheduled backup, creates one RecoveryPoint, persists the exact next zoned occurrence, and creates no BrowserWindow.
- The Jobs UI Electron harness verifies 419 timezone choices, DST controls, exact policy payload, review, deferred status, desktop/mobile containment, and no horizontal overflow.
