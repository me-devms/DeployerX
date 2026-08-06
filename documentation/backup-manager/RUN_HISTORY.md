# Backup Manager Run History

## Status

- Task: `BM-206`
- Status: Implemented
- Last updated: 2026-08-03

## Activity Model

The Activity view combines durable backup Runs, RestoreRuns, and VerificationRuns into one newest-first operational history. Records remain owned by their existing control-database entities; the renderer creates a display-only normalized entry and never persists a second activity record.

The filter supports all activity, backups, restores, and verifications. Job names are resolved from current BackupJob summaries. A Run whose job was removed retains its durable metrics and appears as `Deleted backup job`.

Active state is type-specific:

- backup: `queued`, `preparing`, `running`, or `verifying`;
- restore: `queued`, `preparing`, `running`, or `validating`;
- verification: `queued` or `running`.

Activity polls once per second only while its tab is visible and at least one displayed operation is active. The same timer serves Jobs and Activity and stops outside those tabs.

## Backup Metrics

Public backup Run projection derives a stable `metrics` summary from durable progress and terminal result evidence:

| Metric | Source and meaning |
| --- | --- |
| `scannedItems` | Source entries observed by traversal |
| `scannedBytes` | Maximum durable source-byte evidence from progress or result |
| `readBytes` | Source payload bytes consumed |
| `uploadedBytes` | New encrypted repository bytes written across destinations |
| `reusedBytes` | Existing encrypted chunks reused across destinations |
| `deduplicationSavingsPercent` | `reusedBytes / scannedBytes`, bounded to 100% and shown to one decimal place |
| `throughputBytesPerSecond` | Rolling transfer rate from the latest five-second progress window |
| `durationMs` | Start to finish for terminal Runs, or start to latest durable update for active Runs |

Throughput sampling uses cumulative bytes and a rolling five-second baseline. It does not present the full-run average as a live rate. Repository completion remains available as committed destinations over configured destinations.

Restore history shows completed/total/skipped items, bytes written, throughput, and duration. The latest eligible succeeded or warning file-restore duration associated with a job's RecoveryPoint is also used as explicitly labeled observed RTO evidence; destinations and selected paths are excluded from that projection. Verification history shows completed/total recovery points, verified/total files, verified bytes, mode, and duration.

## Structured Run Logs

Backup execution writes redacted lifecycle records with component `backup-run` and correlation ID equal to the Run ID. Current events include:

- Run start with bounded job, trigger, attempt, and destination counts;
- each provider-confirmed repository copy commit with byte totals;
- successful or warning completion with recovery-point and byte summaries;
- stopped execution with only normalized safe failure evidence.

The detail modal requests logs for one selected Run. Main-process authorization verifies that the Run exists in the current workspace, forces the `backup-run` component, and returns newest entries first with a 500-entry UI limit. Credentials, signed URLs, connection strings, private keys, ciphertext, and credential-shaped text remain subject to the recursive structured-log redactor before persistence. The UI never receives a configuration snapshot, repository object locator, or credential.

Logs are operational and retention-bound; terminal Run metrics and results remain durable when detailed log files expire.

## User Interface

The Activity workspace uses full-width rows rather than nested cards. Desktop rows reserve stable columns for state and five metrics. At narrow widths, state and metrics stack below the run identity without horizontal document overflow.

The summary reports total and active runs, successful/warning completions, uploaded plus restored bytes, and deduplicated bytes. Selecting a row opens type-specific metrics. Backup rows also show the bounded structured Run log; restore and verification details explicitly state that backup lifecycle logs are not recorded for those run types.

## Deferred Work

Pause, cancel, forced retry, and other job lifecycle commands remain in `BM-209`. Historical recovery-objective trends and full workload recovery-test timing remain later work.
