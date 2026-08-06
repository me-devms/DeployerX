# Backup Manager Task List

## Purpose

This is the step-by-step operational queue for the DeployerX Backup Manager module. It answers four questions at a glance:

1. What is in scope?
2. What is complete?
3. What is being worked on now?
4. What must happen next?

Update this file whenever a task starts, completes, becomes blocked, or produces new verification evidence. Detailed acceptance criteria, engine evidence, and the append-only implementation history remain in [CORE_TASKS.md](./CORE_TASKS.md).

## Status Legend

- `[ ]` Not started
- `[~]` In progress
- `[x]` Completed and verified
- `[!]` Blocked; the blocker and resumption step must be recorded
- `Removed` Outside the active product scope

## Fixed Product Scope

The active release includes only:

- Local and SSH/SFTP file and server backup
- MySQL
- MariaDB
- PostgreSQL
- Supabase as a constrained PostgreSQL profile
- SQLite
- MongoDB
- Redis
- ClickHouse
- Local-folder, SFTP, and S3-compatible repositories

Cassandra, ScyllaDB, CockroachDB, InfluxDB, Neo4j, Oracle, SQL Server, Elasticsearch, OpenSearch, and every other unlisted database are outside this release. Existing compatibility or recovery code may remain, but it must not create new delivery work or delay the active scope. Plain FTP is not supported because it cannot meet the required transport, integrity, and atomic-publication guarantees.

## Current Status

- **Current task:** `BM-REL-001` physical workspace dependency refresh
- **State:** Blocked only on physical workspace replacement by 18 live workspace `electron.exe` processes
- **Registry target:** Electron `43.3.0`, confirmed with `npm view electron version` on 2026-08-06
- **Manifest target:** Electron `43.3.0` exactly
- **Lockfile target:** Electron `43.3.0` exactly
- **Physical installed version:** Electron `30.5.1`
- **Next action:** Close all DeployerX/Electron instances, verify the workspace process count is zero, rerun normal `npm install`, and complete the final physical-runtime checks.
- **After this task:** Mark `CORE-REL-007` complete. There is no later database-family phase in this plan.

## Step-By-Step Delivery Queue

### 1. Documentation And Scope

- [x] `BM-DOC-001` Create `documentation/backup-manager` for module plans, runbooks, compatibility boundaries, recovery procedures, and progress tracking.
- [x] `BM-DOC-002` Create this step-by-step task list and link it to the detailed core evidence tracker.
- [x] `BM-DOC-003` Create a folder-level documentation index that identifies the current queue, detailed evidence register, compatibility boundary, recovery checklist, and active runbooks.
- [x] `BM-DOC-004` Audit the documentation system against the original tracking requirements and record authoritative evidence.
- [x] `BM-SCOPE-001` Freeze the mainstream workload scope listed above.
- [x] `BM-SCOPE-002` Centralize and enforce the active database allowlist in connection, Source, main-process, and renderer entry points.
- [x] `BM-SCOPE-003` Preserve existing removed-engine records and recovery access without advertising new configuration work.

### 2. Module Foundation

- [x] `BM-FND-001` Provide dedicated Backup Manager navigation instead of routing to Settings Backup & Restore.
- [x] `BM-FND-002` Provide the transactional control database, SecretRefs, audit records, worker lifecycle, restart reconciliation, and bounded diagnostics.
- [x] `BM-FND-003` Provide local and SSH/SFTP Sources with file/folder selection and inclusion/exclusion rules.
- [x] `BM-FND-004` Provide encrypted, authenticated, versioned repositories backed by local folders, SFTP, and S3-compatible object storage.
- [x] `BM-FND-005` Provide manual and scheduled execution, progress, cancellation, retry, retention, pruning, RPO/RTO, notifications, and history.
- [x] `BM-FND-006` Provide snapshot browsing, repository verification, selective restore, alternate-target restore, and destructive confirmation controls.

### 3. Mainstream Database Workloads

- [x] `BM-DB-001` MySQL logical backup/restore, binary-log PITR, and approved physical backup/restore.
- [x] `BM-DB-002` MariaDB logical backup/restore and binary-log PITR.
- [x] `BM-DB-003` PostgreSQL logical backup/restore plus base backup, WAL archive, and PITR.
- [x] `BM-DB-004` Supabase PostgreSQL profile with TLS, SecretRefs, eligible endpoint checks, logical backup, and constrained restore.
- [x] `BM-DB-005` SQLite online consistent full backup and safe alternate-path restore.
- [x] `BM-DB-006` MongoDB logical, replica-set, oplog, validation, and supported coordinated snapshot workflows.
- [x] `BM-DB-007` Redis RDB, AOF, multipart-AOF, and supported cluster orchestration.
- [x] `BM-DB-008` ClickHouse native full/incremental chains and empty alternate-target restore inside the documented standalone boundary.

### 4. Verification And Operations

- [x] `BM-OPS-001` Publish the core compatibility matrix and engine-specific operator runbooks.
- [x] `BM-OPS-002` Publish the reusable recovery checklist and repository operations guidance.
- [x] `BM-TEST-001` Verify focused service, restart, cancellation, secret, retention, pruning, and ransomware-style resilience contracts.
- [x] `BM-TEST-002` Verify the complete core renderer workflow at desktop and 390 px mobile widths using Electron `43.3.0` in an isolated runtime.
- [x] `BM-TEST-003` Verify real OpenSSH/SFTP host-key authentication, abrupt channel loss, atomic publication, orphan reconciliation, lease takeover, stale-owner fencing, and byte-exact retry.

### 5. Release Closure

- [!] `BM-REL-001` Refresh and verify the primary workspace dependencies.
  - [x] Update `package.json` and `package-lock.json` to the current Electron release, `43.3.0`, using npm's lockfile-only install path.
  - [x] Validate Electron `43.3.0` in a disposable isolated runtime before replacing the live workspace binary.
  - [!] Close every DeployerX/Electron process that is using the workspace runtime. Do not terminate user processes automatically.
  - [ ] Confirm `Get-Process electron -ErrorAction SilentlyContinue` returns no workspace Electron process.
  - [ ] Run normal `npm install`. Do not run `npm run dev`, `npm run build`, or a packaging command.
  - [ ] Confirm `node -p "require('./node_modules/electron/package.json').version"` returns `43.3.0`.
  - [ ] Confirm `npm ls electron --depth=0` succeeds without `ELSPROBLEMS`.
  - [ ] Rerun the focused runtime, security, core-scope, SFTP, repository, and Electron workflow gates.
  - [ ] Record exact results here and in `CORE_TASKS.md`.
- [ ] `BM-REL-002` Mark the core Backup Manager implementation release-ready after `BM-REL-001` is fully evidenced.

## Verification Evidence

- Core resilience suite: `132/132` passed.
- Latest standalone SFTP suite: `16/16` passed.
- Latest repository engine, manual backup, SSH, file restore, and repository-lock set: `50/50` passed.
- Latest core database-scope contracts: `4/4` passed.
- Real OpenSSH/SFTP release smoke: all `12/12` checks passed on Windows OpenSSH `10.0p2`; the disposable listener, sessions, and port were cleared.
- Isolated Electron `43.3.0` runtime gates: `4/4` passed for the control database, OS-backed secret storage, encrypted repository engine, and dedicated Backup Manager navigation.
- Isolated Electron `43.3.0` renderer matrix: shared module workflows `10/10` and mainstream database/profile workflows `8/8` passed at their specified desktop and mobile widths.
- Latest focused SFTP, repository, manual backup, SSH, file restore, repository-lock, and core-scope set: `70/70` passed.
- Modified JavaScript syntax checks and `git diff --check`: passed.

## Documentation Goal Audit

| Original requirement | Authoritative evidence | Result |
| --- | --- | --- |
| Create a module documentation folder inside the repository documentation folder | `documentation/backup-manager` exists as a directory | Complete |
| Create a Backup Manager task-list Markdown file | `BACKUP_MANAGER_TASK_LIST.md` exists and is linked from `README.md` and `CORE_TASKS.md` | Complete |
| Organize work step by step | Five ordered delivery sections contain stable task IDs and status markers | Complete |
| Show completed work | Completed tasks use `[x]` and verification evidence is retained | Complete |
| Show ongoing, blocked, and next work | `Current Status`, `[~]`, `[!]`, planned tasks, and `Next action` are defined | Complete |
| Keep progress updated while work proceeds | The dated progress log records task start, completion, decisions, blockers, and resume conditions | Complete |
| Make later resumption unambiguous | `README.md` defines the update protocol and links the current queue, evidence register, compatibility matrix, and recovery checklist | Complete |

Audit evidence: all required artifacts and status markers exist, all update-rule markers exist, all 41 index links resolve, and the current release blocker remains explicitly documented.

## Progress Log

### 2026-08-05 - Operational task list created

- Created this task list inside the existing Backup Manager documentation folder.
- Reconciled the queue with `CORE_TASKS.md`, the compatibility matrix, recovery checklist, current package metadata, and current process state.
- Recorded every completed workstream, the fixed mainstream database scope, the sole active release blocker, and the exact resumption checklist.
- No development server, build, packaging command, dependency installation, or automatic process termination was performed.

### 2026-08-05 - BM-REL-001 blocker rechecked

- Rechecked the exact workspace Electron executable path before attempting the dependency refresh.
- The same 18 workspace `electron.exe` processes remain active; their recorded start times span 2026-08-04 and 2026-08-05.
- Reconfirmed declared Electron `39.8.5`, lockfile Electron `39.8.5`, and physical installed Electron `30.5.1`.
- `BM-REL-001` cannot resume until all workspace Electron processes are closed. No process was terminated and `npm install` was not run.

### 2026-08-05 - BM-DOC-003 started

- Started a folder-level documentation index so future work has one unambiguous entry point.
- The index will distinguish the active mainstream plan from historical and removed-engine research documents.

### 2026-08-05 - BM-DOC-003 completed

- Added `README.md` as the Backup Manager documentation entry point.
- Indexed the operational queue, detailed evidence register, compatibility matrix, recovery checklist, active file/repository runbooks, mainstream database runbooks, and shared contracts.
- Documented the required progress-update workflow so a task is marked in progress before work, completed only after verification, or blocked with an exact resumption condition.
- Verification: all 41 local Markdown links in the index resolve and the index, operational task list, and detailed tracker contain no trailing whitespace.

### 2026-08-05 - BM-DOC-004 started

- Started a requirement-by-requirement completion audit of the original documentation and progress-tracking request.
- The audit does not treat the blocked physical Electron refresh as completed; it verifies that incomplete work remains visible and resumable.

### 2026-08-05 - BM-DOC-004 completed

- Audited every explicit requirement from the original documentation-tracking request and recorded the evidence in the `Documentation Goal Audit` table.
- Verification before completion: 25 earlier module tasks were marked complete, one documentation task was in progress, one release task was blocked, one release task was planned, and five dated progress entries existed.
- All required artifacts, current/next/status markers, and update rules exist; all 41 local index links resolve.
- Closed only the documentation audit. `BM-REL-001` and `BM-REL-002` remain accurately incomplete.

### 2026-08-06 - BM-REL-001 resumed for Electron 43

- The user authorized the Electron dependency update through npm.
- `npm view electron version` returned `43.3.0`; this replaces `39.8.5` as the intended manifest, lockfile, isolated-runtime, and physical-install target.
- Started the safe metadata phase while the existing runtime remains open. The physical replacement is still fenced by 18 workspace Electron processes and no process will be terminated automatically.

### 2026-08-06 - Electron 43 metadata and initial isolated gates completed

- Updated `package.json` and `package-lock.json` through npm and pinned Electron exactly to `43.3.0`; the npm metadata install reported zero vulnerabilities.
- Installed the official Electron `43.3.0` package and binary in a disposable validation directory. The executable reports `v43.3.0`.
- Direct Electron gates passed for the control database, OS-backed secret storage, encrypted repository engine, and dedicated Backup Manager navigation.
- Navigation passed at desktop and exact 390 x 844 mobile window bounds with Overview selected, Settings hidden, no visible setup-error toast, and no horizontal document overflow.
- The broader isolated Electron 43 workflow matrix is now active. The physical workspace runtime remains untouched at `30.5.1`.

### 2026-08-06 - Electron 43 isolated matrix completed; physical install blocked

- Completed the post-fix Electron `43.3.0` matrix: runtime gates `4/4`, shared renderer workflows `10/10`, mainstream database/profile workflows `8/8`, and focused service/security contracts `70/70`.
- Corrected two stale Electron harnesses: Activity now counts only rendered rows, and Notifications validates the current Settings notification surface instead of the retired Backup policies location.
- Fixed the production 390 px layout regression where `.app-shell.sidebar-collapsed` overrode the responsive one-column grid and left the workspace at zero width. The corrected Notifications view spans the mobile workspace, contains its rows and modal, and has no horizontal document overflow.
- A normal workspace `npm install` was attempted as authorized and failed atomically with Windows `EBUSY` while renaming the live Electron `icudtl.dat`. The physical runtime remains intact at `30.5.1`; no npm staging directory remains.
- The metadata install reported zero vulnerabilities. Later explicit audit retries were unavailable because DNS resolution for `registry.npmjs.org` returned `ENOTFOUND`; rerun both audits after the physical install.
- `BM-REL-001` is blocked only until all 18 workspace Electron processes are closed. No process was terminated automatically.
