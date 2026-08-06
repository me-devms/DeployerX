# Repository Pruning and Capacity Protection

## Status

- Task: `BM-205`
- Status: Implemented
- Last updated: 2026-08-03

## Safety Boundary

Retention classification and physical repository mutation are separate operations. `retention.deletionEligible` only makes a recovery-point copy a pruning candidate. It never authorizes deletion by itself.

A copy can be included in a prune plan only when all of these checks pass:

- the copy is still `available` and retention marks the point `deletionEligible`;
- the point and copy have no legal hold;
- `immutableUntil` is absent or elapsed;
- no active RestoreRun or VerificationRun references the point or repository;
- no retained recovery point depends on it as an incremental ancestor;
- every repository manifest can be bounded, authenticated, decrypted, and parsed;
- every chunk reference from all remaining manifests is known;
- the operation owns the repository's shared mutation lease.

Unknown, malformed, corrupt, oversized, or unauthenticated manifest data fails closed. Repository scans are bounded to 60,000 recovery points plus the sentinel point, 1,000,000 listed manifest objects, and 1,000,000 cumulative chunk references.

## Dry Run and Execution

Planning is read-only. It returns:

- a deterministic `planId` based on repository ID, recovery-point IDs and revisions, manifests, deletable chunks, blocked copies, and manifest count;
- exact manifest and unreferenced-chunk counts;
- blocked recovery points with safe reason codes;
- the candidate manifest evidence used by execution.

Execution acquires the same repository mutation scope used by backup writers, recomputes the complete plan under that lease, and refuses a missing or stale `planId`. This prevents a reviewed plan from being applied after retention, manifests, active operations, or copy revisions change.

Manifests are deleted before chunks. A chunk is deleted only when it was referenced by a candidate manifest and no remaining repository manifest references it. Shared deduplicated chunks therefore survive until the last referencing manifest is removed.

Provider deletion must return either `deleted` or idempotent `absent` evidence. The RecoveryPoint copy changes to `pruned` only after its manifest deletion is provider-confirmed. RecoveryPoint identity, capture evidence, retention evidence, artifacts, and audit history remain in the control database.

If execution stops after some confirmed deletions, those copies remain accurately marked `pruned`; undeleted objects remain safe storage leakage. A later dry run recalculates from current control and repository state. Control records are never removed ahead of provider evidence.

## Capacity Policy

Every repository has a normalized versioned storage policy:

| Field | Default | Meaning |
| --- | ---: | --- |
| `quotaBytes` | none | Optional upper capacity bound used with provider usage evidence |
| `reserveBytes` | 0 | Absolute space that backups cannot consume |
| `reservePercent` | 5 | Percentage reserve; the stricter byte or percentage reserve wins |
| `warningPercent` | 15 | Remaining-capacity warning threshold |
| `criticalPercent` | 5 | Remaining-capacity critical threshold |
| `minimumBackupBytes` | 64 MiB | Minimum projected allowance required before a backup starts |
| `requireCapacityProof` | false | Blocks backup when the adapter cannot prove capacity |

Capacity remains normalized as exact, quota-only, or unavailable. Exact and quota-only reports evaluate the configured quota, current free space, projected minimum write, and reserve. A projected reserve breach is `blocked`; warning and critical states remain writable until the reserve would be breached.

Unavailable capacity is reported honestly. It remains writable by default for providers such as generic S3 that have no portable capacity API. Enabling `requireCapacityProof` makes unavailable reporting fail closed.

Manual and scheduled backups use the immutable repository storage-policy snapshot and a live adapter capacity result before acquiring the mutation lease or writing objects. A blocked decision fails the Run with category `capacity`, allowing the existing retry policy to defer it.

## User Interface

Repository rows show ready, low, critical, blocked, busy, and unavailable capacity conditions. The settings action edits quota, reserves, thresholds, minimum backup allowance, and capacity-proof requirements with optimistic revision checking.

The prune action first calculates a dry run. If nothing is eligible, it reports protected or empty state without mutation. Otherwise, the confirmation shows exact manifest, unreferenced-chunk, and protected-copy counts. Execution submits only the reviewed `planId`.

## Deferred Scope

Complete legal-hold administration, retention-lock governance, and provider WORM workflows remain in `BM-601`. Automated low-capacity pruning schedules and notifications remain in their later policy and notification tasks. BM-205 provides the fail-closed deletion checks and explicit operator workflow they require.
