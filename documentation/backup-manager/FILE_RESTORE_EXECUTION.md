# File Restore Execution

## Scope

`BM-116` restores one or more authenticated snapshot files or directories to their original location or beneath an alternate destination. Local-computer and SSH/SFTP targets use the same planning, conflict, progress, validation, and `RestoreRun` contracts.

Database-native restore is outside this contract and remains in the database backup phases.

## Request Contract

A restore request contains:

- one `recoveryPointId`;
- between 1 and 500 canonical snapshot paths;
- one current-device `targetConnectionId`;
- `mode`: `original` or `alternate`;
- an absolute `destinationPath` for alternate restores;
- `conflictPolicy`: `fail`, `overwrite`, `rename`, or `skip`.

Redundant descendant selections are removed. A selected directory expands to authenticated manifest descendants, with a maximum of 100,000 planned items. POSIX, Windows-drive, and UNC archive roots remain distinct. Alternate restores preserve their source hierarchy beneath the destination, for example `/srv/app/a.txt` becomes `<destination>/srv/app/a.txt`.

## Snapshot Trust

The restore service calls `SnapshotBrowserService.openAuthenticatedSnapshot()` rather than opening a repository directly. That shared path:

1. checks RecoveryPoint and repository-copy catalog membership;
2. tries only available, workspace-scoped copies;
3. opens and authenticates the encrypted engine manifest;
4. verifies catalog locator and checksum agreement;
5. fails over to another independently cataloged copy when needed.

File content is read with `FileRepositoryEngine.streamFile()`. Every encrypted chunk is authenticated and the engine verifies the complete file byte count and keyed digest before the stream completes. The target writer independently checks the written byte count before commit.

## Target Validation

The target must:

- exist in the same workspace;
- be assigned to the running device;
- have a latest successful connection test;
- be a supported local or SSH connection.

Original-location restore additionally requires the target connection to equal the RecoveryPoint source connection. Platform-incompatible original paths are rejected. Alternate locations must be absolute and every mapped item must remain below the chosen destination.

SSH authentication verifies the saved SHA-256 host-key fingerprint before resolving any SecretRef. A changed or unavailable host fails without exposing credentials or provider error text.

## Planning And Conflict Policies

All selected items are expanded and preflighted before the first destination modification.

| Policy | Behavior |
| --- | --- |
| `fail` | Any existing target fails the complete preflight. Nothing is written. |
| `overwrite` | Existing files or links are replaced through same-directory staging. Existing directories are merged. |
| `rename` | The selected root receives the first available deterministic name, such as `report (restored 1).txt`, up to 1,000 attempts. Directory descendants remain below the renamed root. |
| `skip` | Existing items are retained and counted as skipped. Existing directories are traversed so missing descendants can still be restored. |

Path traversal, destination escape, NUL input, relative destination paths, and symbolic-link/reparse-point parents are rejected. Existing destination links may be replaced as leaf items but are never followed.

## Commit Semantics

### Local

- Parent directories are created one component at a time and re-inspected.
- Files use exclusive same-directory staging files with mode `0600`.
- Content is synchronized before commit.
- Non-conflicting commits use rename.
- Where the platform refuses direct replacement, overwrite uses a rollback rename so failed commits restore the prior target.
- Staging and rollback artifacts are cleaned after success or failure.

### SFTP

- Parent components are checked with `lstat`; links and non-directories are rejected.
- Files use exclusive same-directory SFTP staging handles.
- OpenSSH `fsync` is used when advertised.
- Non-conflicting commits use SFTP rename.
- Overwrite requires the OpenSSH atomic rename extension. Servers without it return `RESTORE_ATOMIC_OVERWRITE_UNAVAILABLE`; users can choose rename or skip.

## Item And Metadata Behavior

- Directories are created before descendants.
- Files are streamed without whole-file materialization.
- Directory metadata is applied after children, deepest directory first.
- Supported ownership, permission, and timestamp metadata is restored.
- Unsupported or failed non-critical metadata operations become bounded warnings and produce a `warning` terminal state.
- Safe relative symbolic links are restored explicitly. Absolute links, escaping `..` targets, and links without authenticated target metadata fail closed.
- Hard-linked file entries restore as independently verified file content; hard-link topology recreation is deferred until a repository manifest carries a complete safe link-group contract.
- Other file types fail as unsupported rather than being converted silently.

## Durable RestoreRun

`RestoreRun` uses controlled optimistic projection and these transitions:

```text
queued -> preparing -> running -> validating -> succeeded | warning
   |          |           |            |
   +----------+-----------+------------+-> failed | canceled | interrupted
interrupted -> failed | canceled
```

Ordinary CRUD cannot mutate a RestoreRun. Progress records the phase, item totals, completed and skipped counts, total and written bytes, a safe current basename, throughput, timestamps, and bounded warnings. Terminal results record restored/skipped items, verified bytes, warnings, or a normalized safe error.

On process startup, non-terminal RestoreRuns without an in-process executor are projected through `interrupted` to `failed` with retryable `RESTORE_PROCESS_INTERRUPTED` evidence. Partial targets are not automatically resumed because there is no restore checkpoint contract yet.

## API And UI

Main-process APIs:

- `backup:restores:list`
- `backup:restores:start`
- `backup:restores:wait`

Start is an audited mutation. Audit details contain only IDs, mode, policy, and selection count, never selected paths, destination paths, credentials, or provider messages.

The Recovery view supports multi-select across browse and search results. The restore dialog provides original/alternate location, current-device local and SSH targets, absolute destination entry, and all four conflict policies. It displays completion, skipped count, and verified bytes, and prevents closing while a restore is active.

## Limits And Deferred Work

- One RecoveryPoint per selected-file RestoreRun.
- 500 selection roots and 100,000 expanded items per run.
- No pause, cancel control, bandwidth throttle, or checkpoint resume yet.
- No Windows VSS-aware in-place restore orchestration yet.
- No privileged elevation broker for ownership or protected operating-system paths.
- No unsafe absolute symbolic-link recreation.
- Repository-wide verification and sampled restore verification remain `BM-117`.

## Verification

- Focused unit coverage verifies selection normalization and expansion, alternate mapping, authenticated streaming, fail-with-zero-write, overwrite planning, deterministic rename, skip-directory merge, link-parent rejection, SSH host-key-before-secret ordering, RestoreRun transitions, and restart reconciliation.
- A no-window Electron integration creates a real encrypted local backup, verifies fail-with-no-change, restores through rename, reads exact plaintext, checks verified bytes, and confirms durable RestoreRun history.
- The Recovery Electron UI harness verifies desktop and 390px layouts, multi-selection, local/SSH target choices, the restore modal, terminal status, and no horizontal overflow.

