# Backup Manager Recovery Objectives

## Status

- Task: `BM-208`
- Status: Implemented
- Last updated: 2026-08-03

## Scope

Backup Manager reports current recovery-point-objective (RPO) posture and observed recovery-time-objective (RTO) evidence for every backup job in the active workspace. The report is an operational read model calculated from durable Policy, BackupJob, Run, RecoveryPoint, and RestoreRun records. It does not persist a second source of truth.

RPO and RTO targets are optional independent integer values from 1 to 525,600 minutes. They are stored on `Policy.objectives` as `rpoMinutes` and `rtoMinutes`. Job creation validates both values before starting its transaction, then stores them atomically with the Policy and BackupJob.

## Definitions

**RPO** is the maximum intended age of the latest successful backup. It answers: "How much source-data time could be lost if recovery were required now?"

**RTO** is the maximum intended recovery duration. The current implementation compares the target with the latest completed file RestoreRun linked to one of the job's RecoveryPoints. It answers only: "How long did the latest observed DeployerX file restore take?"

The RTO measurement is labeled `observed-file-restore`. It is evidence, not a promise and not proof of full workload recovery. It excludes application startup, database replay beyond represented file activity, DNS or traffic switching, validation by an operator, and business-service acceptance.

## RPO Evaluation

The report uses the newest Run whose state is `succeeded`. Failed, warning, active, and canceled Runs do not replace a successful baseline. Before the first successful backup, the BackupJob creation time is the baseline.

For a target `T` and elapsed age `A`:

- `not-configured`: no valid RPO target;
- `pending-first-backup`: a target exists but no successful Run exists and the first deadline has not passed;
- `healthy`: a successful baseline exists and `A < 0.8T`;
- `at-risk`: a successful baseline exists and `0.8T <= A <= T`;
- `overdue`: current time is later than the baseline plus `T`.

The exact 80% boundary is `at-risk`. The exact deadline is not overdue; overdue begins after it. The report includes target, age, percentage consumed, baseline, deadline, remaining minutes, and the latest successful Run ID. Percentage consumption may exceed 100 in the service result; the UI caps the progress bar at 100 while retaining the overdue detail.

The persistent-worker overdue notification from `BM-207` and this report use the same successful-Run and first-backup baselines. Reporting does not send notifications or mutate notification idempotency state.

## RTO Evaluation

RestoreRuns are associated with a job only through their RecoveryPoint IDs. Only `succeeded` and `warning` restores with valid start and completion timestamps are eligible. Failed, active, malformed, negative-duration, or unrelated restores are ignored. The newest eligible completion is the measurement.

- `not-configured`: no valid RTO target;
- `unmeasured`: a target exists but no eligible completed restore exists;
- `within-target`: observed duration is at or below target and the restore succeeded;
- `within-target-warning`: observed duration is at or below target but the restore completed with warnings;
- `over-target`: observed duration is greater than target.

An unmeasured target is never presented as compliant. Measurement includes only bounded identifiers, completion time, observed duration, result state, mode, item and byte counts, and the `observed-file-restore` coverage label.

## Overall State

Each job receives one overall state:

| State | Rule |
| --- | --- |
| `critical` | RPO is overdue or observed RTO is over target |
| `warning` | RPO is at risk or awaiting its first backup, or RTO is unmeasured or completed within target with warnings |
| `healthy` | At least one objective is configured and no critical or warning condition applies |
| `inactive` | The BackupJob or Policy is not enabled |
| `not-configured` | The active job has neither objective configured |

Critical status takes precedence over warning. Disabled jobs remain visible for context but are excluded from active configured and breach aggregates.

## Workspace Summary

The report returns exact counts for total jobs, monitored jobs, healthy/warning/critical jobs, configured and overdue RPO targets, configured/over-target/unmeasured RTO targets, and all RecoveryPoints in the workspace. `monitoredJobs` excludes inactive and unconfigured jobs.

The Overview cards display:

- active workloads by healthy, attention, and breached state;
- RPO targets not overdue over active configured RPO targets;
- measured RTO targets over active configured RTO targets, with over-target and unmeasured counts;
- total RecoveryPoints and report evaluation time.

Full-width objective rows show workload identity, RecoveryPoint count, optional next run, target, status, bounded detail, progress, and overall state. Rows stack into one column at 390px without horizontal document overflow.

## Safe Projection and IPC

The read-only `backup:objectives:status` IPC derives workspace identity in the main process and accepts no renderer-provided workspace or actor ID. The preload exposes `getBackupObjectiveStatus()`.

The status projection does not include Policy configuration snapshots, source selections, repository locations, RestoreRun destinations, selected restore paths, connection details, SecretRefs, credentials, logs, or manifest data. Reporting performs no mutation and produces no audit event.

Repository reads are bounded to 1,000 records per entity for the current local implementation. Invalid report time fails closed rather than producing misleading age calculations.

## Current Limits

- RTO uses the latest eligible observed file restore; it is not a rolling percentile, trend, forecast, or service-level guarantee.
- VerificationRun checksum and sampled-restore outcomes are not treated as RTO evidence because they do not share the RestoreRun duration contract.
- Full application, database, cluster, virtual-machine, disaster-recovery, and isolated recovery-test timing remain future evidence types.
- Policy editing and lifecycle effects are deferred to `BM-209` and later configuration work.
- Historical objective snapshots, trend charts, breach-duration reporting, SLO windows, and exported compliance reports are not yet implemented.

