# Backup Manager Audit and Logging

## Document Status

- Task: `BM-007`
- Status: Implemented
- Audit schema version: `1`
- Log schema version: `1`
- Last updated: 2026-08-03

## Storage

| Data | Location | Behavior |
| --- | --- | --- |
| Audit events | `userData/backup-manager/audit/<workspace-hash>.jsonl` | Append-only, workspace-isolated, sequential hash chain |
| Structured logs | `userData/backup-manager/logs/<workspace-hash>/<UTC-date>.jsonl` | Daily files, bounded entries, 30-day default retention |

Workspace IDs are hashed for filenames. The full workspace ID remains inside each audit/log record for authorization and verification.

## Audit Event

Each event contains:

- schema version, event ID, sequence, workspace ID, and UTC timestamp;
- actor type and actor ID;
- action, resource type, and optional resource ID;
- outcome: `attempt`, `success`, `failure`, or `denied`;
- severity: `info`, `warning`, or `critical`;
- correlation ID and recursively sanitized details;
- previous event hash and current event hash.

The hash is SHA-256 over stable key-ordered JSON for the complete event except its own `hash` field. The first event uses 64 zeroes as `previousHash`.

## Mutation Audit Sequence

Security-sensitive Backup Manager mutations follow this order:

1. Persist an `attempt` audit event.
2. Perform the mutation.
3. Persist `success` with the resulting resource ID/revision/version, or `failure` with a sanitized error.
4. Write a secret-safe operational log without changing the mutation result if logging is unavailable.

The mutation does not begin when the initial audit event cannot be written. Current audited actions are:

- `secret.create`
- `secret.rotate`
- `secret.delete`

New Backup Manager mutation handlers must use the same audited wrapper before they are considered complete.

## Redaction Rules

Redaction is recursive and occurs before persistence. It covers:

- passwords, passphrases, tokens, credentials, authorization headers, cookies, private keys, ciphertext, connection strings, and signed URLs;
- credential-shaped URL query parameters;
- Bearer and Basic authorization values;
- inline `password=`, `secret=`, `token=`, API-key, and access-key assignments;
- username/password URL authority sections;
- buffers and typed arrays;
- excessive depth, oversized strings, arrays, and object key counts.

Safe identifiers remain visible for diagnosis, including SecretRef IDs, secret type, provider key, key version, adapter ID, idempotency key, object key, and public-key fingerprint.

No logger caller may depend on redaction as permission to pass known plaintext secrets. Callers must use SecretRef IDs wherever possible; redaction is defense in depth.

## Integrity Verification

`BackupAuditStore.verify(workspaceId)` checks:

1. every event belongs to the expected workspace;
2. sequences start at 1 and are contiguous;
3. every `previousHash` matches the preceding event;
4. every stored event hash matches recomputed canonical content.

Verification returns `valid`, verified event count, last verified hash, and a safe failure code. The read-only preload API exposes verification and recent-event listing; renderer APIs cannot append or alter audit events.

## Structured Logger

`StructuredLogStore.logger()` returns a `RedactingLogger` with `debug`, `info`, `warn`, and `error` methods. Each entry contains component, correlation ID, message, context, level, timestamp, workspace ID, and a unique log ID.

Entries are limited to 64 KiB. Oversized context is replaced by an explicit truncation marker. Old daily files are pruned once per workspace/day according to the configured retention window.

`StructuredLogStore.list()` reads newest daily files and entries first, returns at most 1,000 records, and supports exact correlation ID, component, and level filters. The renderer API is narrower: it requires an existing Run in the current workspace, fixes the component to `backup-run`, and returns at most the requested bounded set of already-redacted entries. It cannot enumerate logs for other components or workspaces.

## Concurrency

Audit and log appends are serialized within the owning process. The worker gateway/main process is the single audit writer for protocol version 1. When remote/multi-process workers are implemented, events must continue through the gateway or move to the transactional control database; multiple processes must not append directly to the same JSONL chain.

## Verification Evidence

- Recursive field and credential-string redaction test passes.
- Raw log persistence contains no tested plaintext secrets.
- Log retention pruning test passes.
- Concurrent audit appends produce contiguous sequence/hash chains.
- Modified audit content fails verification with `event-hash-mismatch`.
- Workspace audit streams remain isolated.
- Secret create, rotate, and delete IPC mutations use the audited wrapper.
