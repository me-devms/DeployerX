# Repository And Sampled Restore Verification

## Scope

`BM-117` provides two on-demand integrity checks for file backups:

- repository checksum verification authenticates every cataloged RecoveryPoint available in one exact repository copy and streams every regular file;
- sampled restore verification deterministically selects files from one RecoveryPoint and reads their complete authenticated content without writing a restore destination.

Both modes prove that protected content can be opened and read now. They do not prove that an arbitrary restore target has enough capacity, permissions, compatible metadata support, or application-level consistency.

## Trust Model

Verification begins from workspace-scoped control-database records and uses `SnapshotBrowserService.openAuthenticatedSnapshot()`. The open path:

1. validates RecoveryPoint and repository-copy catalog membership;
2. optionally binds the operation to one exact repository ID;
3. opens the encrypted repository manifest with the retained repository key;
4. authenticates the manifest and compares its locator and ciphertext checksum with the catalog;
5. exposes an internal streaming handle only to the main-process verification service.

Every selected file is consumed through `FileRepositoryEngine.streamFile()`. That stream authenticates every encrypted chunk and verifies the complete file size and keyed content digest. Verification independently compares the streamed byte count with the manifest size.

The renderer never receives repository keys, SecretRefs, raw manifests, chunk locators, content digests, file paths in evidence, or provider error details.

## Checksum Mode

Checksum mode requires a `repositoryId`. The repository must:

- belong to the active workspace;
- be assigned to the current DeployerX device;
- have persisted `ready` health;
- not have an unavailable lock state.

The service reads up to the newest 1,000 RecoveryPoints and selects only points with an `available` copy in that exact repository. It authenticates each selected manifest and fully streams every regular file. It does not silently fail over to another repository copy because the requested repository itself is the subject of the test.

Reaching the 1,000-point boundary produces a terminal warning so the result never implies an unbounded full-catalog check. An empty repository copy also succeeds with a warning rather than claiming that content was tested.

## Sampled Restore Mode

Sampled restore mode requires a `recoveryPointId` and may include a `repositoryId` to test a specific copy. Without an exact copy, the authenticated snapshot browser may use another available cataloged copy if opening the first copy fails.

The policy accepts:

- `samplePercent`: 1 through 100, default 10;
- `minimumFiles`: 1 through 1,000, default 1;
- `maximumFiles`: 1 through 1,000, default 1,000.

The selected count is the requested percentage rounded up, raised to the minimum, and bounded by the maximum and the number of regular files in the manifest.

## Deterministic Selection

For each file, selection calculates SHA-256 over:

```text
<recoveryPointId> NUL <canonical manifest path>
```

Files are ranked by that digest and the first required entries are selected. The same RecoveryPoint and policy therefore select the same files on every run, while paths are not stored in the VerificationRun result or evidence. Changing the RecoveryPoint ID changes the ranking even when paths are identical.

This is deterministic coverage, not a cryptographically random audit. Scheduled rotation and historical coverage accounting are deferred to later policy and notification work.

## Durable VerificationRun

Each request creates a workspace-scoped `VerificationRun` before execution:

```text
queued -> running -> succeeded | warning | failed | canceled
```

Terminal records are immutable. State and progress changes use controlled optimistic projection rather than ordinary CRUD. Progress records:

- phase and timestamps;
- RecoveryPoints total and verified;
- files total and verified;
- bytes verified;
- only the safe basename of the current file.

Successful and warning results contain the mode, scoped IDs, counts, verified bytes, bounded warnings, completion time, and an evidence SHA-256 digest. The evidence digest commits to authenticated manifest checksums and verified file facts while hashing file paths before inclusion. It is operational evidence, not a replacement for the repository's keyed content authentication.

Unexpected errors are reduced to stable codes, categories, retryability, and safe messages. On startup, abandoned `queued` or `running` records are converted to retryable failed records with `VERIFICATION_PROCESS_INTERRUPTED`; verification currently restarts from the beginning instead of resuming a checkpoint.

## API And Audit

Main-process APIs:

- `backup:verifications:list`
- `backup:verifications:start`
- `backup:verifications:wait`

Workspace and actor identity are derived in the main process. Starting verification is audited using IDs, mode, and bounded policy values. Paths, keys, credentials, evidence inputs, and provider errors are excluded.

## Recovery UI

The Recovery view exposes verification for the selected RecoveryPoint. The dialog supports:

- sampled restore or full repository mode;
- an exact available repository-copy selector;
- sample percentage for sampled verification;
- active, completion, warning, and failure feedback.

RecoveryPoint rows show the latest sampled-verification status. Repository checksum history remains available through the verification APIs; a repository-centric operations screen and scheduled verification policies are deferred.

## Limits And Deferred Work

- Checksum mode examines at most the newest 1,000 catalog records per run.
- Sampled mode verifies at most 1,000 regular files per run.
- Directory metadata and symbolic-link target behavior are authenticated through the manifest but are not materialized into a test destination.
- No scratch destination is mounted, so destination filesystem semantics, free capacity, permissions, and metadata application are not tested.
- Verification has no pause, resume, or user cancellation control yet.
- Periodic verification schedules, rotating sample coverage, alerts, reports, RPO/RTO integration, and notification routes belong to later operations tasks.
- Database-native validation belongs to the database adapter phases.

## Verification

- Focused tests cover deterministic sampling, exact-copy binding, all-file repository traversal, authenticated corruption failure, restart reconciliation, and real SQLite `VerificationRun` transitions.
- A no-window Electron integration creates a real encrypted repository and completes both sampled and checksum runs while confirming durable history and zero BrowserWindows.
- The Recovery UI harness covers both modes, copy selection, percentage selection, completion feedback, latest sampled status, and a bounded 390px dialog without horizontal overflow.

