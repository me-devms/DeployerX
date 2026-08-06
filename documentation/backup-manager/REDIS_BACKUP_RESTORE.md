# Redis Backup and Restore Contract

## Scope

`BM-408` protects Redis data with Redis-native persistence artifacts. It does not copy a live Redis data directory as a generic file source and does not describe replication as backup.

This contract covers:

- authenticated Redis connection enrollment and topology discovery;
- full RDB recovery points;
- Redis 7 and later multipart AOF protection;
- Redis 8.10 and later sealed `BACKUP` artifact sets;
- standalone, replication, and Redis Cluster deployments;
- repository publication, retention, restore, and verification requirements;
- honest consistency and recovery-chain evidence.

Destructive replacement of a running Redis service belongs to `BM-412`. BM-408 restores standalone/replication artifacts only into an isolated alternate Redis instance and restores cluster artifacts as an offline, non-running recovery bundle.

## Authoritative Semantics

The implementation follows Redis' published behavior rather than treating persistence files as ordinary files:

- [Redis persistence](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/) defines RDB snapshots, AOF durability, Redis 7 multipart AOF, safe RDB copying, and rewrite behavior.
- [Redis replication](https://redis.io/docs/latest/operate/oss_and_stack/management/replication/) defines asynchronous replication and the replication ID/offset identity boundary.
- [Redis Cluster](https://redis.io/docs/latest/operate/oss_and_stack/management/scaling/) defines the 16,384 hash-slot topology, node identity, and acknowledged-write loss limitations.
- [Redis command reference](https://redis.io/docs/latest/commands/) is authoritative for `INFO`, `ROLE`, `CONFIG GET`, `BGSAVE`, and the Redis 8.10 `BACKUP` command family.

## Product Truths

1. An RDB file is a full point-in-time image. It is not an incremental backup.
2. An AOF is a write-history persistence format. Redis 7 and later may publish one BASE file, multiple INCR files, and a manifest as one indivisible recovery set.
3. Copying an AOF directory while a rewrite is changing its manifest is unsafe. The adapter must use Redis 8.10 sealed backup semantics or a bounded rewrite-disabled publication protocol.
4. Replication improves availability but is asynchronous and is not a retained recovery history.
5. A replica recovery point is identified by its upstream master replication ID and the exact applied offset, not just by the replica endpoint.
6. Redis Cluster has 16,384 slots. A complete recovery point must include every healthy master that owns slots and must prove exactly-once slot coverage.
7. Independent cluster-master snapshots are crash-consistent across the cluster unless an approved application write gate covers the entire capture interval.
8. Redis protocol commands do not transfer persistence files. Every executable backup plan must pair the Redis endpoint with a device-local or SSH filesystem execution path that resolves the authenticated server paths.
9. Every artifact is encrypted and authenticated by the configured DeployerX repository. A directory mirror is not presented as versioned backup.

## Supported Tiers

| Server and topology | Backup path | Advertised result | Restore path |
| --- | --- | --- | --- |
| Redis 8.10+ standalone or replica | `BACKUP START`, enumerate, `BACKUP SEAL`, verify status, publish the sealed manifest and exact BASE/INCR files | Full sealed recovery point; subsequent sets may reuse repository chunks but remain independently described | Isolated Redis with startup-only `preload-file aof:<manifest>` or `preload-file rdb:<file>` |
| Redis 7+ standalone or replica | Successful `BGSAVE` RDB plus coordinated multipart-AOF set when AOF is enabled | RDB full; application-consistent AOF chain captured during a bounded write pause with exact manifest membership | Isolated Redis started against a staged RDB or complete multipart-AOF directory |
| Redis 6.2+ standalone or replica | Successful `BGSAVE`, then copy the atomically published RDB | Full RDB only | Isolated Redis started against the staged RDB |
| Redis Cluster | Apply the applicable tier independently to every healthy slot-owning master | Complete cluster recovery point only when all 16,384 slots and all master artifacts publish; crash-consistent unless write-gated | Offline isolated recovery bundle with per-master native validation and authenticated topology mapping; no service is exposed |
| Sentinel | Discovery/control only in a future integration | Never accepted as a data endpoint | Not applicable |

Redis versions older than 6.2, unknown forks, modules with undisclosed external persistence, incomplete clusters, and unverified TLS endpoints fail closed.

## Connection Contract

Adapter ID: `deployerx.database.redis.native`

Device-scoped connection configuration:

- hostname or IP address;
- port, default `6379`;
- optional ACL username; omission means the Redis `default` user;
- password stored only as a device-bound `SecretRef`;
- TLS mode fixed to certificate identity verification;
- optional absolute CA, client certificate, and client key paths;
- bounded connection/command timeout;
- approved `redis-cli` executable;
- expected topology: `auto`, `standalone`, `replication`, or `cluster`;
- optional paired filesystem connection ID for later backup execution.

`REDISCLI_AUTH` carries the resolved password in the controlled child-process environment. The password must never appear in process arguments, persisted endpoints, diagnostics, audit events, or support summaries. Mutual-TLS certificate and key paths may be persisted, but private-key contents may not.

## Discovery Evidence

The connection test executes bounded, non-interactive `redis-cli` commands and records safe evidence from:

- `PING`;
- `INFO server`;
- `INFO persistence`;
- `INFO replication`;
- `INFO keyspace`;
- `ROLE`;
- `CONFIG GET dir dbfilename appendonly appendfilename appenddirname auto-aof-rewrite-percentage backupdirname backup-sealed-ttl`;
- `COMMAND INFO BACKUP`;
- `CLUSTER INFO` and `CLUSTER NODES` only for a cluster endpoint.

The normalized identity contains:

- Redis version, mode, and process run ID;
- role and authenticated replication ID/offset;
- RDB and AOF enablement, health, and active save/rewrite state;
- Redis persistence directory, RDB filename, AOF directory name, and rewrite policy;
- logical database/key counts and expiry counts;
- endpoint node ID for a cluster;
- healthy slot-owning master inventory and exact 0-16383 coverage;
- the best available backup strategy for this server.

The persisted trust fingerprint binds the server mode, run ID, role, replication history, and cluster node identity. A new run ID or replication history is visible on retest and must be re-evaluated before reusing a recovery chain.

## Preflight Refusals

Connection discovery or backup planning fails closed for:

- authentication or required-command authorization failure;
- TLS without certificate identity verification;
- unsupported Redis version or Sentinel used as a data endpoint;
- expected topology mismatch;
- `loading:1`, failed RDB/AOF status, an active save/rewrite at a required publication boundary, or a disabled persistence mode that cannot produce the requested artifact;
- `ROLE` offset inconsistent with `INFO replication`;
- a replica without a stable upstream master replication ID and applied offset;
- cluster state other than `ok`, unhealthy slot masters, duplicate slots, missing slots, or an inventory over the bounded node limit;
- absence of a paired filesystem execution path when artifact capture is planned;
- Redis modules whose durable state cannot be proven to be contained in the selected Redis persistence artifact.

## Full RDB Workflow

1. Re-read identity and bind the plan to the deployment fingerprint and, for replicas, the master replication ID/offset.
2. Require a paired filesystem executor that addresses the same host as the authenticated Redis endpoint.
3. Invoke `BGSAVE` without falling back to `SAVE`.
4. Poll `INFO persistence` until `rdb_bgsave_in_progress:0`, require `rdb_last_bgsave_status:ok`, and require `rdb_last_save_time` to have advanced for this run.
5. Resolve `dir` plus `dbfilename` through the paired executor; reject links, path escape, or identity changes.
6. Stream the immutable published RDB into the repository and record size plus SHA-256 before releasing the recovery point.
7. Re-read Redis identity. Record the capture-end replication offset and refuse a changed replication history.

## Multipart AOF Workflow

Redis 8.10 and later uses the `BACKUP` family when available:

1. Require `backup-sealed-ttl=0`, an initially `idle` `BACKUP STATUS`, and an empty server-owned backup directory.
2. `BACKUP START` establishes the server-side session. Bind run ownership to the first positive `start_time`; Redis does not return a separate session ID.
3. Poll `BACKUP STATUS` through `pending`/`snapshotting` until `incrementing`, refusing a changed `start_time`, `failed`, or any unexpected state.
4. `BACKUP SEAL` freezes the recoverable set, then poll until the same owned session reports `sealed` with a valid end time.
5. `BACKUP LIST` must return exactly one `*.base.rdb`, one `*.incr.aof`, and one `*.manifest`, all directly inside the configured `dir/backupdirname` boundary.
6. Copy the three stable regular files into mode-0700 run staging, validate size/mtime stability, SHA-256, the native BASE RDB header, and exact manifest membership.
7. Re-read Redis identity and replication history, run `BACKUP CLEANUP`, prove the server returned to `idle`, and clear persisted session ownership before repository streaming.
8. On cancellation or failure before seal, run `BACKUP ABORT` followed by `BACKUP CLEANUP`; after seal, run `BACKUP CLEANUP`. Mutate only a session whose deployment fingerprint and `start_time` match the run owner record.

Redis 7 through pre-8.10 fallback:

1. Require AOF enabled, multipart layout, healthy last rewrite/write status, and no active rewrite.
2. Atomically persist an owner record containing the deployment fingerprint and exact prior `auto-aof-rewrite-percentage`, then set the runtime value to `0` and verify it before reading files.
3. Establish a bounded five-minute `CLIENT PAUSE ... WRITE` interval and record the applied replication offset after the pause begins.
4. Read `appendfilename.manifest` through the paired filesystem executor. Require exactly one unique BASE entry, one or more unique INCR entries, safe direct-child filenames, and supported `.base.rdb`, `.base.aof`, and `.incr.aof` forms.
5. Stream every manifest member into mode-0700 run staging with mode-0600 files, stable size/mtime checks, SHA-256, and an RDB header check when the BASE uses the RDB preamble.
6. Re-read the manifest and require byte identity. Re-read Redis identity and require the same deployment, replication history, zero rewrite percentage, and unchanged replication offset throughout the write pause.
7. Issue `CLIENT UNPAUSE`, restore the exact prior rewrite percentage, re-read configuration, and clear the owner record only after both cleanup operations are proven.
8. On cancellation or failure, attempt unpause and policy restoration without the canceled signal. Surface an explicit cleanup-unproven error if either action cannot be verified; startup reconciliation restores only a matching owner whose current rewrite percentage is still `0`.

The fallback deliberately fails and retries when a manifest member changes or the applied replication offset advances. A recovery point is never published from a copy that outlives or escapes the bounded write-pause proof.

## Cluster Workflow

1. Discover and normalize `CLUSTER NODES`; prove exactly-once coverage of all 16,384 slots by healthy masters.
2. Resolve an authenticated connection and paired filesystem executor for every master.
3. Re-read each node ID and the complete topology fingerprint immediately before its child capture, then re-read it again after capture.
4. Capture each master with its supported RDB, Redis 7 multipart-AOF, or Redis 8.10 sealed-backup protocol. The cross-master result remains crash-consistent because the captures are independent.
5. Store every master beneath a unique repository path and record its exact slot ranges, server identity, logical database evidence, coordinates, and artifact membership.
6. Re-read the authenticated seed topology after all children complete. Slot migration, failover, changed master identity, incomplete artifact membership, or anything other than exactly 16,384 uniquely covered slots invalidates the entire attempt.
7. Publish one parent `redis-cluster-backup` recovery manifest only after every child artifact and the topology evidence are complete.
8. Label the recovery point `crash` consistency unless an approved application write gate proves the entire cross-master interval.

## Restore Contract

Restore is staged and isolated:

1. Materialize artifacts into a new empty directory and verify repository authentication plus every recorded digest.
2. Validate manifest membership, RDB/AOF filenames, permissions, and absence of unlisted mutable files.
3. Start a compatible isolated Redis executable with network exposure disabled or restricted to a test namespace.
4. Redis 8.10 sealed sets use the official startup-only `preload-file aof:<manifest>` mechanism; older artifacts use an isolated configuration pointing at the staged RDB/AOF layout.
5. Never attach the staged files to the original running process in BM-408.
6. For clusters, require the exact `RESTORE REDIS CLUSTER ALTERNATE` confirmation, authenticate the complete parent set from one repository snapshot, and validate exactly-once ownership of all 16,384 slots.
7. Materialize and natively load every master independently, stop every validation process, then publish all validated masters together under `<target>/masters/<nodeId>/` with an authenticated-safe `topology.json`.
8. The published cluster target is an offline recovery bundle with `serviceRunning: false`. BM-408 does not join nodes, expose a recovered cluster, remap live endpoints, or attach to the source cluster.

Restore must refuse incompatible major versions, a non-empty alternate target, missing AOF members, checksum mismatch, unexpected cluster topology, or any attempt to overwrite the original service without a BM-412 quiescence provider.

## Validation Evidence

Every successful restore records:

- authenticated digest validation for every artifact;
- successful isolated Redis startup with no loading or AOF/RDB error;
- `PING` and role result;
- expected Redis version compatibility;
- source/target logical database key counts and expiry counts;
- replication-history metadata as historical evidence, not as a new target identity;
- per-master native-load results, master count, and exactly 16,384 covered slots for an offline cluster recovery bundle;
- sampled key/type/TTL/value-digest checks when a policy enables content sampling.

Key counts alone are not proof of byte-equivalent recovery. Recovery tests must retain native startup results, artifact digests, topology evidence, and any configured sample evidence.

## Cancellation and Reconciliation

- Cancellation stops new commands, terminates the bounded native process, aborts an open Redis backup session, restores any modified rewrite policy, and removes only run-owned staging paths.
- Startup reconciliation finds open server-side backup sessions, rewrite settings changed by a fenced run, local staging paths, and repository uploads without a committed recovery point.
- Cleanup is idempotent and fenced by run/lease identity. It must never delete Redis persistence files or repository objects owned by another run.
- A canceled or interrupted run never exposes a recovery point unless the complete artifact set and manifest were committed atomically.

## Delivery Slices

1. Connection, SecretRef, bounded `redis-cli`, identity parsing, topology validation, discovery, IPC, and preload APIs.
2. Paired local/SSH filesystem path binding and RDB full-backup execution.
3. Redis 8.10 sealed AOF and Redis 7 multipart-AOF fallback.
4. Repository source reader, job execution, recovery-point metadata, and cancellation reconciliation.
5. Alternate isolated restore and native validation.
6. Cluster orchestration and cross-master failure tests.
7. Sources, Jobs, Recovery, Activity, and Recovery Tests UI plus separate Electron coverage.

## Current Implementation Status

Completed and executable:

- device-scoped SecretRef-backed connection enrollment;
- bounded verified-TLS `redis-cli` identity, persistence, replication, logical database, and cluster discovery;
- standalone and replication-topology full RDB Source configuration;
- same-host loopback/local and exact-host SSH/SFTP filesystem pairing;
- run-owned `BGSAVE` invocation and completion proof using authenticated save counters/timestamps plus published-file identity;
- regular-file, no-link, size, stable-read, native RDB-header, SHA-256, replication-history, and final-identity validation;
- run-scoped local staging, encrypted repository source streaming, cancellation propagation, release cleanup, and startup reconciliation;
- Redis 8.10 sealed `BACKUP START`/`STATUS`/`SEAL`/`LIST` execution for standalone and replication endpoints;
- exact three-file BASE/INCR/manifest classification, containment, stable capture, RDB-header, SHA-256, manifest-membership, and replication-history validation;
- owner-file persistence by Redis `start_time`, fail-closed foreign-session handling, verified abort/cleanup-to-idle behavior, and startup session reconciliation;
- multi-artifact repository source streaming with component media types, digests, coordinates, and sealed-session evidence;
- Redis 7 multipart-AOF execution with exact manifest membership, multiple INCR support, a bounded write-pause coordinate fence, stable local/SFTP capture, and byte-identical manifest revalidation;
- owner-fenced automatic-rewrite suppression, exact prior-value restoration, cancellation-safe `CLIENT UNPAUSE`, cleanup-failure visibility, and startup rewrite-policy reconciliation;
- worker source-reader routing and execution-ready full RDB plus sealed and multipart-AOF adapter registration;
- repository-authenticated isolated alternate restore for RDB, Redis 7 multipart AOF, and Redis 8.10 sealed artifact sets, with Artifact-record and manifest HMAC agreement plus independent raw SHA-256 and exact-size verification after decryption;
- dual materialization that keeps the publish candidate untouched while a disposable loopback-only Redis instance performs native load, `PING`, persistence, independent-master, version, and logical-keyspace validation;
- a 1 MiB authenticated manifest ceiling, exact AOF membership checks, expiration-bounded key-count warnings, bounded validation-process shutdown, cancellation cleanup, and exclusive absent-target publication that cannot replace a concurrently created directory;
- audited RestoreRun list/start/wait/cancel IPC and preload APIs plus interrupted-run reconciliation that removes only deterministic staging directories and preserves a published alternate target.
- exact Redis Cluster Source enrollment with one tested Redis and same-host filesystem connection per slot-owning master, topology-fingerprint fencing, and refusal when any master cannot satisfy the selected RDB/AOF strategy;
- one crash-consistent parent recovery point containing unique per-master repository paths, exact child artifact membership, node identities, slot ranges, coordinates, logical database evidence, post-capture topology verification, and all-slot coverage;
- repository-authenticated offline cluster recovery from one snapshot with exact confirmation, duplicate/missing-slot and duplicate-artifact refusal, independent native validation of every master, exclusive target claiming, uncertain-publication reporting, and a non-running `topology.json` bundle;
- cancellation and interrupted-run reconciliation that remove only run-owned cluster staging and never delete a concurrently created or partially published target;
- Redis Source enrollment for verified-TLS credentials, paired filesystem execution, RDB/AOF/automatic persistence selection, whole-deployment locking, and exact per-master cluster mappings constrained to tested node identities and topology fingerprints;
- full-only Redis Job configuration with the selected persistence strategy and deployment-wide protection boundary made explicit;
- standalone and cluster Recovery workflows with the correct typed confirmation, alternate absent-target selection, cancellation, validation port configuration, and explicit offline-cluster bundle state;
- Redis-specific Activity and Recovery Test presentation for persistence mode, validation, topology, logical database, artifact-authentication, and all-slot coverage evidence;
- dedicated Electron workflow coverage at desktop and 390 px widths, including contained, internally scrollable Source and Recovery modals without horizontal document overflow.

## BM-408 Exit Criteria

BM-408 is complete only when automated tests prove:

- secrets never enter arguments, persisted endpoints, diagnostics, logs, or recovery metadata;
- RDB publication occurs only after a successful run-owned `BGSAVE`;
- multipart AOF publication contains the exact manifest set and survives cancellation at every phase;
- replica recovery points bind the correct master replication history and applied offset;
- cluster recovery points cannot publish with fewer or more than exactly 16,384 uniquely owned slots;
- every artifact is repository-authenticated and an isolated restore starts successfully;
- original-service replacement remains unavailable without BM-412;
- desktop and 390 px workflows expose only supported modes without overflow;
- all non-Electron tests pass and each Electron test file passes in its own Electron process.

All exit criteria are covered by the completed implementation and automated verification: 491 non-Electron Backup Manager tests pass, and all 34 Electron test files pass in separate Electron processes.
