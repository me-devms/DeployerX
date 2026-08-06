# Elasticsearch and OpenSearch Snapshot Backup and Restore

## Purpose

`BM-409` adds database-native protection for Elasticsearch and OpenSearch through their snapshot repository APIs. A snapshot is the only supported backup mechanism for these distributed search clusters. DeployerX must never represent copies of node data directories, Lucene shard paths, or live repository blobs as valid backups.

The native snapshot repository is the authoritative data store. DeployerX orchestrates snapshots, records authenticated control metadata, schedules work, validates recovery, and invokes native retention operations. It does not ingest repository blobs into the generic Backup Manager repository engine and does not modify repository storage directly.

## Vendor Research Baseline

The contract is based on the current official documentation reviewed on 2026-08-04:

- [Elastic snapshot and restore](https://www.elastic.co/docs/deploy-manage/tools/snapshot-and-restore) states that snapshots are the only reliable supported cluster backup, are segment-deduplicated, include shard states from points between the snapshot start and end times, and must not be replaced by node-directory copies.
- [Elastic self-managed snapshot repositories](https://www.elastic.co/docs/deploy-manage/tools/snapshot-and-restore/self-managed) requires repository verification on master and data nodes, one writer cluster per repository, read-only registration on other clusters, and engine-managed cleanup. A repository-level archive is safe only while writes are prevented or from an atomic storage snapshot.
- [Elastic restore guidance](https://www.elastic.co/docs/deploy-manage/tools/snapshot-and-restore/restore-snapshot) defines index, data-stream, alias, global-state, feature-state, rename, compatibility, and recovery monitoring behavior.
- [OpenSearch snapshot and restore](https://docs.opensearch.org/latest/tuning-your-cluster/availability-and-recovery/snapshots/snapshot-restore/) defines incremental native snapshots, repository registration, snapshot states, restore renaming, one-major-version forward compatibility, remote-backed repository requirements, and Security plugin restrictions.
- [OpenSearch snapshot APIs](https://docs.opensearch.org/latest/api-reference/snapshots/) are the authoritative control surface for repository, snapshot, status, restore, clone, cleanup, and deletion operations.

These links are research references, not runtime dependencies. The adapter must validate actual server identity and capabilities rather than assuming behavior from a configured product label.

## Support Tiers

Initial executable support targets:

| Product | Versions | Backup | Restore |
| --- | --- | --- | --- |
| Elasticsearch | 7.17 and supported 8.x/9.x releases | Existing writable native repository, complete or selected snapshot, cluster metadata, feature states where supported | Existing repository registered on an alternate target cluster, renamed indices/data streams, optional compatible feature states |
| OpenSearch | 1.x-3.x | Existing writable native repository, complete or selected snapshot, optional global state with security restrictions | Existing repository registered read-only on an alternate target cluster, renamed indices, security index excluded |

The delivered adapter is execution-ready after repository verification, exact resource selection, snapshot polling, cancellation fencing, and durable recovery metadata checks succeed.

Managed services are supported only when their public snapshot APIs expose the same required operations and identity evidence. Provider-owned automatic snapshots, inaccessible system repositories, and service-specific restore controllers are discovery-only until a provider adapter proves their complete lifecycle.

## Non-Goals

BM-409 does not:

- copy node data directories, individual shard paths, translogs, or repository blobs;
- claim an instantaneous cluster-wide point in time;
- register storage credentials into cluster keystores or install repository plugins;
- make a repository writable from more than one cluster;
- treat searchable snapshots, remote-backed storage, or cross-cluster replication as backup substitutes;
- restore over existing production indices or replace original cluster state without the `BM-412` application-quiescence and destructive-restore contract;
- bypass Elasticsearch restricted-index privileges or use an OpenSearch admin certificate to overwrite `.opendistro_security`;
- promise compatibility beyond what the target server reports for the snapshot and every contained index.

## Connection and Secret Model

Each connection is device-scoped and stores:

- product expectation: `auto`, `elasticsearch`, or `opensearch`;
- HTTPS host and port, with no path, query, fragment, or embedded credentials;
- optional bounded base path for a managed-service proxy;
- authentication mode: Basic credentials, Elastic API key, or bearer token when the discovered product supports it;
- username plus SecretRef ID, or a token/API-key SecretRef ID;
- mandatory TLS certificate identity verification;
- optional CA certificate path and optional client certificate/key paths;
- bounded request and operation timeouts;
- expected cluster UUID, populated after explicit successful testing.

Resolved secrets exist only in the request authorization header or TLS client context. They never enter URLs, native arguments, diagnostics, persisted endpoint records, audit details, recovery metadata, or renderer responses. Redirects are disabled so authorization headers cannot cross origins.

## Authenticated Cluster Identity

Connection testing performs bounded JSON requests and proves:

- product identity from the root response and product-specific headers/fields;
- exact server version and supported-version range;
- stable cluster UUID, cluster name, and normalized endpoint authority;
- TLS identity verification and authentication success;
- current cluster health status and manager/master discovery;
- required snapshot and repository privileges through safe read-only probes;
- whether global metadata is write-blocked;
- supported feature-state, data-stream, repository-analysis, and snapshot-status capabilities.

A configured product expectation or cluster UUID mismatch fails before snapshot discovery. HTML, redirects, oversized bodies, duplicate JSON keys where detectable, invalid content types, and raw provider errors are reduced to bounded diagnostics.

## Repository Enrollment

DeployerX initially binds a Source to an already registered native repository. It discovers repositories through `GET /_snapshot/_all` and persists only an allowlisted projection:

- repository name and native type;
- non-secret location identity such as bucket/container and hashed base path;
- read-only state;
- repository generation or UUID evidence when the product exposes it;
- verification nodes and verification timestamp;
- repository-analysis result when requested and supported;
- the writer cluster UUID approved by the operator;
- a stable settings fingerprint with credential-shaped and provider-sensitive values removed.

Backup Sources require a writable repository and a successful `POST /_snapshot/<repository>/_verify` result from the same authenticated cluster. Restore targets require the repository to be visible and should register it read-only when a second cluster accesses the same storage.

The repository binding fails closed when:

- repository verification fails on any required node;
- the repository is read-only for a backup Source;
- another cluster is recorded or observed as writer;
- repository type, safe settings fingerprint, or location identity changes;
- the repository is an inaccessible provider-owned system repository;
- required plugins or secure settings are missing;
- an object-storage compatibility analysis fails when the operator requests it;
- repository metadata cannot be read without exposing secrets.

DeployerX never modifies a repository's underlying files or objects. Snapshot deletion, retention, and cleanup use only native APIs. Repository archival into another backup system is outside the initial executable slice and is permitted later only after unregister/read-only fencing or an atomic storage snapshot exactly as required by the vendor.

## Source Selection

A Source can protect:

- the complete cluster snapshot scope;
- explicit regular indices and data streams;
- supported feature states on Elasticsearch;
- aliases together with their selected indices;
- optional global cluster state when explicitly enabled and supported.

Discovery uses structured JSON APIs and records stable names, UUIDs, open/closed state, hidden/system classification, data-stream backing relationships, feature states, aliases, shard counts, primary-store bytes, and index creation versions. Closed Elasticsearch indices are excluded because current Elasticsearch snapshots protect only open indices.

Selection rules are explicit, bounded, sorted, deduplicated, and digest-bound. Wildcards may be offered for display convenience, but the immutable execution plan contains the resolved concrete membership. A plan refuses if the concrete membership changes between preflight and snapshot start unless the Source explicitly uses whole-cluster dynamic membership.

For Elasticsearch 8 and later, system indices and system data streams are protected and restored only through feature states. For OpenSearch with the Security plugin, `.opendistro_security` is excluded and `include_global_state` defaults to false. BM-409 does not offer the high-risk admin-certificate security-index restore path.

## Consistency and Backup Semantics

Every successful recovery point is application-consistent at the shard level and crash-consistent across the selected cluster scope. It is logically full but physically incremental and deduplicated inside the native repository.

The UI presents one backup mode: `Native incremental snapshot`. It must explain through concise status labels, not unsupported full/differential toggles, that every snapshot is independently restorable while unchanged segments are reused.

A snapshot is not a single instant. Each primary shard contributes a view from a point between the recorded snapshot start and end times. Unavailable primary shards fail the run because DeployerX always sends `partial: false`.

## Backup Preflight

Immediately before planning, the adapter must:

1. Re-read product, version, cluster UUID, and health.
2. Refuse red health and unavailable selected primary shards.
3. Re-read repository settings and require the persisted safe fingerprint.
4. Verify the repository on the current cluster.
5. Require no conflicting in-progress snapshot or repository cleanup operation for the bound repository.
6. Resolve and freeze concrete selected indices, data streams, feature states, aliases, UUIDs, shard counts, and creation versions.
7. Refuse closed or missing selected resources unless an explicit ignore-unavailable policy was saved; complete protection remains fail closed.
8. Prove the required snapshot/repository privileges without relying on renderer claims.
9. Record cluster/global write blocks, product security restrictions, and version compatibility evidence.

The immutable plan binds the cluster UUID, product/version, repository fingerprint, exact selection digest, global/feature-state flags, `partial: false`, generated snapshot name, and plan digest.

## Snapshot Execution

1. Acquire a workspace/source lock and a repository mutation lock.
2. Re-read cluster and repository identity.
3. Create a collision-resistant lowercase snapshot name containing the job/run identity and UTC timestamp. User input is never used directly as a path segment.
4. Call the native create-snapshot API with `partial: false`, the exact selection, metadata containing bounded DeployerX run IDs and plan digest, and without blocking the HTTP request for the complete operation.
5. Poll the exact repository/snapshot record and current snapshot status with bounded backoff.
6. Accept only `SUCCESS`. `PARTIAL`, `FAILED`, `INCOMPATIBLE`, missing, or identity-changing responses fail the run.
7. Re-read snapshot metadata and require exact repository, name, UUID when exposed, selection, shard success counts, version, start/end times, global-state flag, feature states, and DeployerX metadata.
8. Re-read repository and cluster identity before publication.
9. Commit a small authenticated DeployerX metadata artifact and RecoveryPoint that references the native repository snapshot. The repository snapshot itself remains external native media.

Recovery metadata includes product/version, cluster UUID, repository identity/fingerprint, snapshot name/UUID, exact indices/data streams/feature states, index UUIDs and creation versions, aliases, total/successful shard counts, start/end timestamps, physical incremental/logically full semantics, global-state flag, native response digest, and repository verification evidence.

## Cancellation, Failure, and Reconciliation

Cancellation stops polling and invokes the native delete-snapshot API for the exact owned snapshot. Deleting an in-progress snapshot is the only supported cancellation/cleanup path. DeployerX then polls until the owned snapshot is absent or terminally removed.

An ownership record is persisted before snapshot creation and binds workspace, run, cluster UUID, repository fingerprint, snapshot name, and plan digest. Startup reconciliation may inspect or delete only a snapshot whose native metadata matches that owner record. Foreign snapshots are never canceled or deleted.

If cancellation or failure cannot prove deletion, the run ends with an explicit cleanup-unproven condition and preserves the owner record for reconciliation. A RecoveryPoint is never published for `PARTIAL`, ambiguous, missing, or unauthenticated snapshot state.

## Retention and Repository Maintenance

Native snapshots share segments, so retention must call `DELETE /_snapshot/<repository>/<snapshot>` and must never remove backing objects directly. DeployerX retention owns only snapshots bearing authenticated DeployerX metadata for the matching workspace/source.

Repository cleanup is a separate guarded maintenance action. It requires no DeployerX mutation in progress, explicit operator confirmation, a fresh repository verification, and the native cleanup API. Returned deleted-byte/blob counts are operational evidence, not proof of recoverability.

Snapshot Lifecycle Management and OpenSearch Snapshot Management policies may coexist only when naming and ownership scopes are disjoint. DeployerX does not delete policy-owned snapshots and must surface a conflict when a native lifecycle policy can mutate the same snapshot namespace.

## Restore Modes

BM-409 initially supports alternate-cluster restore from an already registered repository. The target connection must be independently tested, use a compatible product, see the exact repository contents, and have a different approved target identity unless a future isolated namespace provider proves same-cluster safety.

Supported restore scopes:

- all selected regular indices/data streams renamed with a generated, collision-free prefix or suffix;
- a bounded selected subset from the recovery point;
- compatible Elasticsearch feature states only when explicitly selected and target privileges permit them;
- aliases when their renamed targets remain unambiguous;
- global state only in an explicit whole-cluster disaster-recovery mode delivered with `BM-412`, not in the initial alternate restore.

Restore planning must:

- read the exact snapshot from the target cluster and match all authenticated recovery metadata;
- apply vendor snapshot/index compatibility rules using the target's current version response;
- refuse cross-product restore unless a separately tested migration adapter exists;
- refuse existing target index, data-stream, alias, or template conflicts;
- produce deterministic rename patterns and preview every resulting name;
- exclude OpenSearch `.opendistro_security` and global state;
- refuse Elastic restricted feature states without required elevated privileges;
- require `RESTORE SEARCH ALTERNATE` confirmation and an absent logical target namespace.

Destructive same-name restore, delete-and-replace, full cluster-state replacement, and original-cluster rollback remain unavailable until `BM-412` supplies an application write gate and destructive recovery protocol.

## Restore Execution and Validation

1. Persist a RestoreRun and acquire source snapshot plus target-cluster mutation locks.
2. Re-read source snapshot identity through the target cluster's repository registration.
3. Re-check target conflicts and compatibility.
4. Invoke native restore with exact selection, `include_global_state: false`, explicit feature-state handling, deterministic rename rules, and no permissive partial restore.
5. Poll cluster recovery/task evidence until every expected primary shard is recovered or a bounded deadline/cancellation occurs.
6. Require no failed or initializing expected shards, then verify cluster health for the restored names.
7. Compare expected and restored index/data-stream membership, index UUID provenance where exposed, primary shard counts, document counts with declared refresh timing, aliases, settings, mappings digests, and feature-state results.
8. Record warnings for replica under-allocation separately from primary recovery failure.

Cancellation stops further orchestration but cannot claim that server-side restore work was rolled back. Any already-created alternate indices are reported explicitly for operator cleanup. DeployerX must never silently delete partially restored target indices.

## Recovery Tests

An authenticated Recovery Test may use either:

- metadata validation: re-read the native snapshot, verify repository access, exact membership, successful shard counts, compatibility, and DeployerX metadata; or
- full drill: restore into a dedicated alternate target namespace or disposable approved cluster, validate native recovery, then delete only drill-owned indices after explicit ownership proof.

Metadata validation is useful but does not satisfy a full restore drill. Activity and Recovery Test views must distinguish them.

## UI Requirements

### Sources

- Add Elasticsearch/OpenSearch connection with verified TLS and SecretRef-backed authentication.
- Test product/version/cluster identity and display bounded health and privilege diagnostics.
- Select a verified native repository and show type, read/write role, writer cluster, verification nodes, and settings fingerprint.
- Select complete scope or exact indices/data streams/feature states.
- Show native incremental/logically full semantics, `partial: false`, cluster-state choice, security exclusions, and one-writer repository warning.

### Jobs

- Offer only the implemented native snapshot strategy.
- Support manual and scheduled execution, retention, objectives, notifications, and repository mutation serialization.
- Do not expose generic full/incremental/differential controls that misrepresent native snapshot behavior.

### Recovery

- Show repository/snapshot identity, product/version, start/end consistency window, selected objects, feature/global state, shard counts, and compatibility.
- Restore only to a tested alternate target with a complete rename preview and conflict check.
- Display partial server-side cancellation consequences and destructive-mode unavailability.

### Activity and Recovery Tests

- Show snapshot state, shard progress/failures, repository verification, cleanup status, and bounded native reasons.
- Distinguish metadata verification from a full alternate restore drill.
- Never show authorization headers, secure repository settings, raw provider errors, or credential-bearing endpoints.

All workflows require desktop and 390 px coverage without horizontal document overflow or modal content escaping the viewport.

## Delivery Slices

1. Connection, SecretRef authentication, verified-TLS JSON client, product/version/cluster identity, health, privilege diagnostics, IPC, and preload APIs.
2. Repository and resource discovery, repository verification, safe settings fingerprints, Source enrollment, and selector normalization.
3. Snapshot preflight, immutable planning, create/poll/cancel/reconcile execution, authenticated metadata artifact, and worker routing.
4. Native retention deletion, ownership fencing, and guarded repository cleanup.
5. Alternate-target restore, compatibility/conflict planning, recovery polling, native validation, cancellation reporting, and RestoreRun APIs.
6. Metadata and full-drill Recovery Tests.
7. Sources, Jobs, Recovery, Activity, and Recovery Tests UI plus separate Electron coverage.

## Current Implementation Status

Completed and executable:

- device-scoped SecretRef-backed Basic, Elastic API key, and bearer-token connection enrollment;
- a bounded HTTPS JSON transport with mandatory certificate identity verification, optional CA and mutual-TLS material, disabled redirects, response-size limits, canonical managed-service base paths, request deadlines, and cancellation;
- authenticated Elasticsearch/OpenSearch product detection, supported-version gates, cluster UUID/name identity, cluster health, global metadata block, snapshot repository, and current snapshot-status probes;
- expected-product and cluster-UUID pinning after the first successful test, with identity changes refused on later tests and discovery;
- allowlisted repository discovery with read-only state plus credential-safe settings, location, and repository fingerprints, followed by writer-cluster verification and Source binding;
- exact regular index and data-stream discovery with UUIDs, backing membership, aliases, shard counts, creation versions, hidden/system exclusions, and Elasticsearch feature-state discovery with explicit OpenSearch refusal;
- a native-only, logically full and physically incremental Job strategy with immutable concrete selection, `partial: false`, repository mutation serialization, scheduling, objectives, notifications, and retention policy integration;
- collision-resistant snapshot creation, exact snapshot/status polling, total primary-shard success enforcement, authenticated DeployerX ownership metadata, cancellation deletion, and startup reconciliation;
- authenticated metadata publication to the generic repository while native repository blobs remain external, plus a bounded Recovery read model for product/version, cluster, repository/snapshot identity, exact protected resources, and shard evidence;
- ownership-fenced retention plans and native deletion evidence, plus confirmed and freshly verified native repository cleanup with active-operation refusal;
- alternate-cluster restore with exact target-side snapshot inspection, read-only repository enforcement, same-product conservative version compatibility, deterministic rename preview, complete conflict checks, native recovery polling, expected-resource validation, and persisted RestoreRun lifecycle;
- cancellation that aborts monitoring without claiming server-side rollback or deleting created alternate targets;
- metadata-only validation and full alternate restore drills as distinct persisted VerificationRun classes, with UUID-fenced cleanup of drill-owned resources;
- audited main-process and preload APIs for connection, discovery, repository verification, restore, retention, cleanup, and recovery-test operations;
- Sources, Jobs, Recovery, Activity, retention, cleanup, restore, and Recovery Test renderer workflows with a dedicated 390 px Electron workflow test;
- automated coverage proving credential isolation, repository and snapshot identity fencing, exact successful publication, cancellation ownership, retention, cleanup, compatibility and conflict refusal, native restore validation, drill cleanup, and responsive UI behavior.

BM-409 is complete. Deliberately unavailable behavior remains outside its scope: cross-product migration, global-state alternate restore, OpenSearch security-state restore, same-name destructive replacement, and original-cluster rollback. Those require a separately tested migration path or the `BM-412` application-quiescence and destructive-restore contract.

## Verification Record

Final verification on 2026-08-04:

- 519 of 519 non-Electron Backup Manager tests passed;
- all 36 Electron test files passed, each in a separate Electron process;
- the three focused search snapshot suites passed 26 tests;
- the dedicated search snapshot Electron workflow passed source enrollment, restore preview/execution, native retention, both Recovery Test classes, Activity evidence, and 390 px containment checks;
- all 1,148 HTML IDs are unique;
- every touched JavaScript file passes `node --check`;
- no development server, `npm run dev`, or build command was run.

The first full non-Electron attempt had one transient Windows `EPERM` while opening the control-database test lock. The control-database file then passed 16 of 16 tests in isolation, and the immediate complete rerun passed all 519 tests.

## BM-409 Exit Criteria

BM-409 is complete only when automated tests prove:

- credentials never enter URLs, persisted configuration, diagnostics, logs, or recovery metadata;
- TLS certificate identity and cluster UUID are revalidated before every mutation;
- unsupported products/versions, redirects, oversized responses, and raw provider errors fail safely;
- a backup RecoveryPoint publishes only for an exact native `SUCCESS` snapshot with all selected primary shards successful;
- repository identity changes, multiple writers, partial snapshots, selection drift, and foreign lifecycle ownership refuse publication;
- cancellation and reconciliation mutate only an exactly owned snapshot;
- retention uses native snapshot deletion and never repository-object deletion;
- restore refuses product/version incompatibility and every target-name conflict before mutation;
- alternate restore validates expected primary shards, membership, mappings/settings evidence, aliases, and feature states;
- OpenSearch security state and destructive original-cluster restore remain unavailable;
- metadata checks and full recovery drills are labeled distinctly;
- desktop and 390 px workflows expose only supported behavior without overflow;
- all non-Electron tests pass and every Electron test file passes in its own Electron process.
