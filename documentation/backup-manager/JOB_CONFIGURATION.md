# Backup Job Configuration

## Status

- Task: `BM-112`
- Status: Implemented
- Last updated: 2026-08-03

## Scope

The Create backup job wizard connects one saved file source to one or more initialized repositories. It persists configuration only; it does not start a backup. Manual execution is owned by `BM-113`, persistent scheduling by `BM-114`, schedule/calendar policy by `BM-201` and `BM-202`, execution policy by `BM-203`, notification routing by `BM-207`, and RPO/RTO reporting by `BM-208`.

## Readiness Gates

A job can be created only when all of the following are true:

- the source belongs to the active workspace, is enabled, and contains at least one saved file or directory;
- the source connection belongs to the current device and its latest connection test succeeded;
- every selected repository belongs to the active workspace and current device;
- every selected repository has a persisted `ready` health result and usable destination locking;
- at least one repository is selected, with no duplicate IDs and no more than eight destinations.
- every selected notification route belongs to the workspace, is enabled, is unique, and no more than 20 routes are selected;
- optional RPO and RTO targets are independent integers from 1 to 525,600 minutes.

Unavailable sources and repositories remain visible in the wizard with a safe reason, but cannot be selected. The main process re-evaluates every gate during creation, so renderer state cannot bypass readiness or workspace isolation.

## Persisted Records

One transaction creates:

1. An enabled `Policy` with a normalized manual or recurring schedule, full, incremental, or adapter-supported differential mode, timezone-aware keep-last/hourly/daily/weekly/monthly/yearly retention, checksum-verification preference, compression/performance settings, bounded retry behavior, optional RPO and RTO targets, selected NotificationRoute references, and empty approved hooks.
2. An enabled `BackupJob` with one source, ordered repository bindings, the normalized source selection and metadata policy, filesystem consistency settings, current-device affinity, and no projected next run.

The first selected repository has role `primary`; later selections have role `copy`. Each binding captures repository adapter, engine, and revision information plus encryption, locking, and immutable-object requirements. The job captures the source revision and normalized selector so future runs can create immutable execution snapshots.

If either record fails validation or persistence, the transaction rolls back and does not leave an orphan policy.

## Wizard Flow

1. **Basics** validates a workspace-unique job name.
2. **Source** selects exactly one ready file source.
3. **Destinations** selects one or more ordered ready repositories.
4. **Protection** selects full or incremental mode, or SQL Server differential mode for an eligible native Source, plus keep-last and five calendar retention tiers, compression, checksum verification, priority, retry backoff, bandwidth limits, optional RPO and RTO targets, and enabled notification routes. SQL Server renders incremental as transaction-log capture.
5. **Review** displays the normalized choices, both recovery-objective targets, route names, and readiness before creation.

The Jobs panel lists persisted jobs with source, backup mode, destination count, retention summary, schedule, current readiness, execution state, and the lifecycle actions defined in `JOB_LIFECYCLE.md`.

## API Surface

- `backup:jobs:readiness`: workspace-scoped read model for wizard choices.
- `backup:jobs:list`: enriched workspace-scoped job list.
- `backup:jobs:create`: audited main-process mutation; workspace and actor are derived from the active application context.
- `backup:objectives:status`: read-only current-workspace RPO/RTO status and safe observed-restore evidence.
- `backup:jobs:pause`, `backup:jobs:resume`, `backup:jobs:clone`, `backup:jobs:disable`, and `backup:jobs:delete`: audited revisioned lifecycle mutations.

No IPC request accepts a renderer-provided workspace or actor ID.

## Deferred Capabilities

- policy editing, re-enabling disabled jobs, and hooks;
- database, Kubernetes, volume, and virtual-machine source choices;
- repository copy repair and execution-time capacity forecasting.
