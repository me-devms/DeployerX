# Recovery Point Retention Policies

## Status

- Task: `BM-204`
- Status: Implemented
- Last updated: 2026-08-03

## Scope

Backup Manager supports Grandfather-Father-Son style retention for completed recovery points. A Policy combines a mandatory keep-last-N safety floor with optional hourly, daily, weekly, monthly, and yearly calendar tiers.

`BM-204` classifies and marks recovery points. It does not delete manifests, chunks, artifacts, or repository objects. Safe pruning, dependency checks, immutability enforcement, quotas, and low-capacity response remain owned by `BM-205`.

## Normalized Policy

The persisted Policy contains:

| Field | Bounds | Meaning |
| --- | --- | --- |
| `timezone` | Valid IANA zone | Local calendar used for every bucket |
| `keepLast` | 1-10,000 | Always retain the newest N points |
| `hourly` | 0-10,000 | Retain the newest point in each of the newest N local hours |
| `daily` | 0-10,000 | Retain the newest point in each of the newest N local dates |
| `weekly` | 0-10,000 | Retain the newest point in each of the newest N ISO local weeks |
| `monthly` | 0-10,000 | Retain the newest point in each of the newest N local months |
| `yearly` | 0-10,000 | Retain the newest point in each of the newest N local years |

Zero disables a calendar tier. The schedule timezone is the default, including for manual-only policies where UTC is used. Invalid counts or timezones fail before Policy and BackupJob creation, preserving transaction atomicity.

The model retains a fail-safe `legalHold` flag, but legal-hold workflows and WORM validation remain assigned to `BM-601`.

## Classification

After repository manifests are committed and verified, successful recovery-point publication performs one control-database transaction:

1. Create the new RecoveryPoint with the immutable Run's retention Policy snapshot.
2. Load the bounded recovery-point history for that BackupJob.
3. Sort by `capturedTo` descending and stable recovery-point ID.
4. Mark the newest `keepLast` points with `last-n`.
5. For each enabled calendar tier, mark the newest point in each distinct bucket until the tier count is satisfied.
6. Union all matching rules for each point.
7. Project changed retention metadata on existing points and create Artifact records.
8. Publish the successful Run and ExecutionGroup.

Any failure rolls back the new point, all reclassification, artifacts, and successful execution state together.

Calendar bucketing uses local wall time. Repeated daylight-saving hours remain distinct through their UTC offsets; missing spring-forward hours simply have no bucket. Weeks use the ISO week-year and week number.

## Recovery Point Metadata

Each point records:

- `ruleMatches`, such as `last-n`, `hourly`, `daily`, `weekly`, `monthly`, and `yearly`;
- the complete normalized count and timezone snapshot;
- `policyRevision` from the immutable Run configuration;
- `deletionEligible`, which becomes true only when no rule matches and no legal hold applies;
- `expireAt`, set to the first evaluation instant at which the point becomes eligible;
- `evaluatedAt`, recording the classification change.

Retention is the only projected field on an otherwise immutable RecoveryPoint. Ordinary CRUD remains prohibited. Unchanged points are not rewritten on every backup, and an already eligible point preserves its original eligibility time.

`deletionEligible` is policy evidence, not permission to delete. `BM-205` now additionally proves chain safety, repository-copy state, immutable-until constraints, active operations, legal holds, complete manifest references, shared mutation-lease ownership, and provider-confirmed deletion before marking a copy `pruned`.

## UI

The Protection step captures keep-last plus all five calendar tiers. Review shows the complete policy and timezone. Job rows show a compact retention summary.

The Recovery view shows the exact rules retaining each point. A point with no matches is labeled `Retention elapsed`; it remains browsable and restorable until a later safe-pruning task removes it.

## Limits

- Each rule is bounded at 10,000 selections.
- Evaluation is bounded at 60,001 points, the maximum possible union of all six configured rules plus one newly displacing point.
- Classification does not forecast future backup times or promise a future deletion date.
- Editing existing policies and immediate re-evaluation outside backup completion remain assigned to `BM-209`.

## Verification

- Unit tests cover all rule bounds, deterministic newest-per-bucket selection, union behavior, IANA local day/year boundaries, repeated DST hours, legal hold, and invalid input.
- Control-database tests prove retention-only projection while all other RecoveryPoint fields remain immutable.
- Backup-job tests prove timezone inheritance, normalized persistence, and invalid-policy atomicity.
- Real backup tests prove a second successful backup atomically displaces and marks the older point while the newest remains retained.
- Jobs and Recovery Electron integrations verify policy payload/review/list summaries, per-point rule labels, retention-elapsed state, desktop and 390px containment, and no horizontal overflow.
