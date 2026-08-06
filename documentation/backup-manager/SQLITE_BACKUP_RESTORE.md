# SQLite Backup and Restore Contract

## Release Scope

BM-407 adds application-consistent protection for SQLite databases on the current DeployerX device. The implemented production path targets supported SQLite 3 releases using native online backup semantics. Remote execution remains unadvertised until an approved execution connection can preserve the same path, ownership, process, and validation guarantees. A byte copy of an open database file is never labeled application-consistent.

Supported database identity is the normalized database path plus authenticated SQLite header/application identity evidence. The adapter must distinguish a plain SQLite database from SQLCipher or another encryption extension and fail closed when the required compatible runtime and key provider are unavailable.

## Consistency Methods

The preferred method is SQLite's Online Backup API through a proven runtime binding that copies a consistent snapshot while writers may continue. `VACUUM INTO` may be offered as a separate full-compaction method when its version, free-space, locking, and schema behavior are explicit. The CLI `.backup` command is acceptable only when DeployerX controls the exact SQLite CLI version, input channel, destination permissions, timeout, cancellation, and diagnostics.

Raw file copy is permitted only after DeployerX proves the database is closed and all rollback-journal/WAL state is resolved, and must be labeled offline rather than online. Copying the main file without `-wal`/`-shm`, racing a checkpoint, or assuming filesystem snapshots are consistent is prohibited.

## Connection and Discovery

A SQLite connection records a canonical absolute database path, device execution scope, and native executable/runtime selection. The implemented plain-SQLite path has no SecretRefs; remote execution and encryption-extension key providers remain deferred. Testing must prove:

- the path resolves to a regular file and is not a symlink escape;
- the SQLite header or approved encryption extension is recognized;
- the runtime version supports the selected backup method;
- `PRAGMA database_list`, `journal_mode`, `page_size`, `page_count`, `freelist_count`, `schema_version`, `user_version`, `application_id`, and `quick_check` return bounded valid evidence;
- attached databases are discovered and never silently omitted;
- the worker can create, fsync, and remove a protected temporary output beside an approved temporary root without overwriting an existing file.

Discovery exposes the main database and bounded attached database inventory. Object-level selection is not part of BM-407 because SQLite native online backup operates at database-file scope. System/internal objects remain visible only as validation evidence.

## Backup Workflow

Each full backup re-tests identity and integrity, creates a mode-0600 temporary destination with exclusive creation semantics, and invokes the native online backup operation. The resulting file must be closed, fsynced, reopened read-only, and validated before repository publication. Validation includes header identity, page count, schema fingerprint, expected object inventory, `PRAGMA quick_check`, and no unresolved temporary journal belonging to the backup output.

The repository Artifact records the method, SQLite/runtime version, canonical source identity, journal mode, page size/count, application/user/schema versions, attached-database policy, schema/object fingerprint, file size, and authenticated digest. Temporary native media is removed after repository streaming on success, cancellation, and failure.

BM-407 initially publishes independent full RecoveryPoints. Incremental page-level capture, session changesets, WAL archiving, and Litestream/LiteFS replication are separate future strategies and must not be inferred from an ordinary SQLite online backup.

## Restore Workflow

Restore supports a confirmed alternate absent path. Original-path replacement is deliberately unavailable and assigned to `BM-412`: it requires an application-specific quiescence integration that proves a closed target database across the commit boundary and a rollback-safe displacement operation on the same filesystem. Existing targets are never overwritten through truncate-in-place writes.

Repository bytes are authenticated before commit. DeployerX restores to a mode-0600 staging file in the destination directory, fsyncs the file and directory, opens the database read-only, compares the protected header/schema/object identity, and runs `PRAGMA quick_check`. Publication uses an exclusive same-filesystem hard link followed by staging unlink, so an existing or concurrently created target is never replaced. On failure or cancellation, owned staging is removed. A restored database is never exposed while validation is incomplete.

Attached databases require an explicit complete-set restore plan. BM-407 will fail closed rather than restore only `main` while claiming the application is recovered. SQLCipher/extension databases require the same compatible extension and SecretRef boundary used during backup validation.

## Security, Cancellation, and Reconciliation

Database contents, keys, CLI dot-command scripts, and filesystem paths beyond bounded display names are excluded from logs and audit details. Encryption values are resolved from SecretRefs only after path and runtime trust checks. Native commands use structured argument construction; no user path or key is interpolated into a shell command.

Backup and restore own AbortControllers. Cancellation terminates native work, waits for process exit, removes temporary media, and prevents RecoveryPoint/Artifact or destination publication. Startup reconciliation never retries uncertain native work automatically. It removes only deterministic exact-owned staging paths; ownership uncertainty leaves operator-action-required evidence.

## BM-407 Acceptance Matrix

BM-407 is complete only after automated coverage proves:

- canonical path, regular-file, symlink, version, header/encryption-extension, and SecretRef gates;
- WAL and rollback-journal databases are backed up through native online semantics without raw-copy races;
- bounded attached-database discovery and complete-set refusal;
- native output fsync, authenticated repository publication, temporary cleanup, and tamper refusal;
- alternate absent-path restore with exclusive publication and prior-target preservation;
- header, schema/object inventory, page evidence, and `quick_check` validation;
- cancellation and restart reconciliation without partial publication;
- audited IPC/preload APIs plus Sources, Jobs, Recovery, and Activity UI coverage on desktop and mobile;
- complete non-Electron and separate-process Electron regression verification without a development server or build.

## Official References

- [SQLite Online Backup API](https://www.sqlite.org/backup.html)
- [SQLite Backup API C Interface](https://www.sqlite.org/c3ref/backup_finish.html)
- [VACUUM INTO](https://www.sqlite.org/lang_vacuum.html#vacuuminto)
- [Write-Ahead Logging](https://www.sqlite.org/wal.html)
- [Atomic Commit](https://www.sqlite.org/atomiccommit.html)
- [PRAGMA quick_check](https://www.sqlite.org/pragma.html#pragma_quick_check)

## Implementation Progress

Connection, discovery, full-backup publication, alternate recovery, cancellation, and restart reconciliation are implemented. SQLite 3.38+ plain databases can be tested, saved as device-scoped connections and complete-main Sources, protected through controlled CLI `.backup`, validated after fsync, and published as encrypted full RecoveryPoints. Multiple repositories reuse the same validated temporary image. Alternate recovery authenticates repository metadata, verifies the plaintext SHA-256 digest and protected identity, runs native validation, and publishes only to an absent path.

Sources, Jobs, Recovery, and Activity expose the implemented contract without broader capability claims. Source scope is locked to complete `main`; Jobs are full-only; Recovery is alternate-path-only; Activity records the target basename, authenticated digest, expected-object evidence, and native validation. Focused coverage includes nine backend tests and a separate-process Electron UI test with 390 px containment.

BM-407 is complete. Destructive original-path replacement is tracked by `BM-412`, where application-specific quiescence and rollback contracts can be implemented without weakening the truthful alternate-path workflow. The complete regression matrix passes with 442 non-Electron tests and 32 Electron test files executed in separate processes. SQLCipher, attached-database complete sets, remote execution, page-level incremental capture, session changesets, WAL shipping, Litestream, and LiteFS are not advertised by this adapter. The current host has no `sqlite3` executable on PATH, so native semantics are verified through the bounded process-runner contract rather than a real host CLI invocation.
