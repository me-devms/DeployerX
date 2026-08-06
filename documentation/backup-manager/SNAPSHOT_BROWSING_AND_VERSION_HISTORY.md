# Snapshot Browsing And Version History

## Scope

`BM-115` makes file RecoveryPoints inspectable before restore. Operators can list RecoveryPoints, browse an authenticated snapshot as a virtual filesystem, search paths inside the selected snapshot, and inspect the history of one file across the originating BackupJob.

Restore execution, overwrite decisions, alternate destinations, and metadata application remain assigned to `BM-116`.

## Trust Boundary

The renderer supplies only RecoveryPoint IDs, canonical snapshot paths, search filters, page sizes, and opaque cursors. The main process derives the active workspace from the application session and opens repositories through the existing device-scoped adapter services.

The service never returns:

- repository master keys or SecretRef values;
- encrypted or decrypted raw manifests;
- chunk IDs, chunk locators, content-authentication digests, or adapter handles;
- repository provider errors, filesystem errors, stack traces, or credentials.

Public file entries contain canonical path, parent, name, type, size, modified time, mode, owner summary, and whether a displayed directory was synthesized for navigation.

## RecoveryPoint Catalog

The catalog is workspace-scoped and ordered newest first. Each public item includes its BackupJob and Source names, recovery type, consistency, chain relationship, capture interval, verification and retention summaries, and repository-copy availability without opaque engine locators.

Catalog pages accept 1 to 200 items. The current control-database repository boundary returns at most the latest 1,000 active RecoveryPoints per workspace; retention and scalable catalog pruning remain part of later policy work.

## Authenticated Snapshot Open

Browsing starts from the ordered `repositoryCopies` recorded on a RecoveryPoint. For each available copy, the service:

1. Confirms the repository and matching manifest Artifact still exist in the workspace catalog.
2. Opens the repository through its local-folder, SFTP, or S3-compatible adapter service.
3. Resolves the device-bound repository key in the main process.
4. Authenticates and parses the encrypted manifest with the repository engine.
5. Confirms the engine snapshot ID, manifest locator, and SHA-256 ciphertext checksum match both the RecoveryPoint copy and Artifact catalog records.

An unavailable or invalid copy is skipped in favor of the next independently cataloged copy. If none can be authenticated, the caller receives one bounded retryable `SNAPSHOT_COPY_UNAVAILABLE` failure without underlying provider details.

## Path Model And Browsing

Snapshot paths remain canonical absolute archive paths. The browser supports:

- POSIX roots such as `/srv/application`;
- Windows drive roots such as `C:/Services/Application`;
- UNC roots such as `//fileserver/share/application`.

Empty path represents the virtual workspace root. POSIX `/`, each drive, and each UNC share appear beneath it. Browsing scans the bounded authenticated manifest and derives only immediate children. Missing intermediate directories can be synthesized without changing the manifest. Directories sort before files and symbolic links, followed by case-insensitive name and canonical path.

Paths reject null bytes, traversal segments, relative forms, repeated separators, invalid UNC roots, and values beyond the repository path limit. A requested path that is missing or resolves to a file is refused as a directory.

Browse pages contain at most 200 entries. Cursors are canonical base64url records with a scope-bound checksum over workspace, RecoveryPoint, operation, path or query, type filter, and offset. A cursor cannot be reused for another directory, search, RecoveryPoint, or workspace.

## Search

Search operates inside one selected RecoveryPoint and matches a case-insensitive query against canonical paths. Results can be filtered to files, directories, symbolic links, or all types. Query length is limited to 200 characters and result pages to 200 entries.

Search returns the same bounded public entry projection used by browsing. It does not read file chunks or materialize file content.

## Per-File Version History

Version history uses the selected RecoveryPoint to identify its BackupJob and Source, then inspects up to the latest 100 RecoveryPoints for that protection chain. Each point is authenticated independently and reports:

- whether the path exists in that point;
- availability of an authenticated repository copy;
- file type and public metadata when present;
- change classification: `added`, `modified`, `metadata-changed`, `unchanged`, `deleted`, `absent`, or `unknown`.

File content changes compare the repository engine's keyed content digest and size without exposing that digest. Metadata-only changes compare the canonical metadata digest. Unavailable copies produce `unknown` and do not prevent other versions from being listed. Responses include `examinedRecoveryPoints` and `truncated` when the 100-point safety bound is reached.

## Desktop API

- `backup:recovery-points:list`: list workspace RecoveryPoints with safe catalog summaries.
- `backup:snapshots:browse`: list one page of immediate children in an authenticated snapshot directory.
- `backup:snapshots:search`: search one authenticated snapshot with an optional type filter.
- `backup:snapshots:file-versions`: compare one canonical path across the job's RecoveryPoints.

The preload bridge exposes `listBackupRecoveryPoints`, `browseBackupSnapshot`, `searchBackupSnapshot`, and `listBackupFileVersions`. All are read-only and workspace identity is never accepted from renderer payloads.

## Recovery UI

The Recovery view provides a persistent RecoveryPoint list and a filesystem-style browser. It includes:

- verified/copy state and capture time for each RecoveryPoint;
- root and folder breadcrumbs;
- path search with a file-type menu and explicit clear action;
- bounded result counts and load-more controls;
- directory navigation and a file-version modal;
- responsive desktop and 390px mobile layouts.

File rows open version history. They do not offer restore commands until the `BM-116` restore service can enforce destination, conflict, and metadata policies.

## Verification

Focused unit coverage verifies POSIX, drive, and UNC normalization; traversal refusal; workspace-scoped catalog paging; canonical cursor rejection; virtual-root browsing; copy failover; type-filtered search; missing-directory errors; added, modified, deleted, unchanged, and metadata-only history classification.

The no-window Electron integration creates a real local Source, safeStorage-backed encrypted Repository, and incremental BackupJob. It executes two backups with changed content, then proves the service can authenticate the latest manifest, search and browse the file, and report `modified` followed by `added` across two RecoveryPoints.

The Recovery UI Electron integration verifies RecoveryPoint pagination, folder navigation, search, version history, desktop bounds, 390px mobile bounds, modal containment, and absence of horizontal document overflow.

## Deferred Work

`BM-116` will add selected-file restore to original and alternate locations with overwrite, rename, and skip policies. Repository checksum and sampled-restore verification belong to `BM-117`. Retention deletion, scalable catalog pruning, and long-term secondary search indexes remain with their later policy and operations tasks.
