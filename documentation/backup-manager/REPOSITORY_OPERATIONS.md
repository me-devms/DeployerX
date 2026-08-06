# Repository Health, Capacity, and Locking

## Purpose

This document defines the operational repository behavior implemented by `BM-111`. It applies to local-folder, SFTP, and S3-compatible repositories and is the contract later job, worker, restore, prune, and verification tasks must use.

## Health Check Sequence

A repository health check runs on its owning device and persists one revision containing the result.

1. Load the repository and resolve its device-bound encryption key and transport SecretRefs.
2. Run the adapter connection test using bounded, provider-safe diagnostics.
3. Normalize destination capacity as exact, quota-only, or unavailable.
4. Read and validate the repository-format marker through the repository engine.
5. Revalidate destination immutability capabilities.
6. Acquire a 30-second `health-check` repository lease, renew it once, and release it.
7. Persist capacity, immutability, capability probe, lock state, repository-format version, checked time, and a safe error code.

`ready` means access, format validation, and locking succeeded. `needs-attention` means one of those required checks failed. A valid repository currently locked by another operation remains structurally healthy and records `lockState.status = contended` so the UI can show `Busy` without claiming corruption.

## Capacity Model

| Reporting mode | Required fields | Meaning |
| --- | --- | --- |
| `exact` | `totalBytes`, `usedBytes`, `freeBytes` | Adapter measured a complete filesystem/storage total and the values balance exactly. |
| `quota-only` | `quotaBytes`, `usedBytes`, derived `freeBytes` | Provider exposes an account or repository quota but not physical destination capacity. |
| `unavailable` | No byte values | The destination cannot truthfully report capacity through the configured protocol. |

All values are non-negative safe integers. Invalid, inconsistent, oversized, or incomplete provider values are reduced to `unavailable`. Local repositories use operating-system filesystem statistics. SFTP uses OpenSSH `statvfs@openssh.com` when advertised. Generic S3 has no portable bucket-capacity API and therefore reports `unavailable`.

## Lease Ownership

Every lease contains:

- repository ID;
- operation and scope;
- worker ID and run ID;
- random lease ID;
- issue, heartbeat, and expiry timestamps;
- bounded TTL from 5 seconds through 15 minutes.

Lease records are encrypted and authenticated with AES-256-GCM. A lock-specific key is derived from the repository master key with HKDF-SHA-256 and a destination-specific binding. Worker IDs, run IDs, and repository IDs are not stored as plaintext lease payloads at the destination.

Renewal fails after expiry. Release and renewal verify the complete lease ownership tuple and never remove or replace another owner's active lease. Expired leases can be taken over using the destination's atomic primitive.

## Adapter Strategies

### Local Folder

Each scope uses a hashed lock directory beneath `.deployerx-repository/locks`. Atomic directory creation selects the owner. Renewal updates the encrypted record and verifies it again through the stable scope path. Release and expired takeover atomically rename the entire directory before cleanup, preventing a stale owner from deleting a replacement lease.

### SFTP

SFTP mirrors the local lock-directory protocol on the remote server. It uses exclusive file creation, standard directory rename, bounded encrypted lease reads, optional server `fsync`, and explicit cleanup. The existing pinned-host-key and SecretRef ordering applies to every lease operation.

### S3-Compatible

Each scope uses a hashed encrypted lock object beneath the repository lock prefix. Acquisition uses `If-None-Match: *`; renewal uses the current ETag with `If-Match`; release and expired takeover use ETag-guarded conditional deletion. The connection probe rejects providers that do not enforce conditional creation, replacement, and deletion.

## Failure and Recovery Rules

- Lock contention is retryable and does not imply repository damage.
- Missing, unauthenticated, malformed, or oversized lease records fail closed as integrity errors and are not silently removed.
- A worker that loses its lease must stop repository mutation before another commit.
- An expired lease may be replaced, but the previous owner cannot renew it afterward.
- Health and capacity failures expose bounded safe codes and messages; raw filesystem, SSH, SDK, credential, and provider details do not cross IPC.
- Repository creation runs the same health and lock check before returning the final persisted repository state.

## Shared Mutation Scope

Backup writers and repository pruning use `repository:<repository-id>:mutation` as the exclusive lease scope. This serializes manifest/chunk publication and removal across jobs and maintenance operations. Pruning additionally recomputes its reviewed dry-run plan after acquiring this lease.

## Capacity Admission

Repositories persist a versioned quota, byte/percentage reserve, warning/critical thresholds, minimum backup allowance, and optional capacity-proof requirement. Health checks persist the current evaluated capacity state. Backup execution repeats the evaluation from a live adapter result before any repository write. See `REPOSITORY_PRUNING.md` for the complete policy and deletion contract.

## User Interface

Every current-device repository row has a refresh action that tests connection access, capacity, repository format, immutability, and locking. Exact and quota capacity are shown beside the destination. Unsupported capacity is labeled unavailable. Other-device repository checks and destructive actions remain disabled.
