const crypto = require('crypto');
const { ADAPTER_ID } = require('./cockroachdb');
const { ARTIFACT_PATH, normalizePublishedMetadata } = require('./cockroachdb-source-reader');

const MAXIMUM_ARTIFACTS = 10000;
const MAXIMUM_CATALOG_RECORDS = 1000;
const MAXIMUM_MANIFESTS = 10000;
const MAXIMUM_CHUNK_REFERENCES = 1000000;
const TERMINAL_STATES = new Set(['succeeded', 'warning', 'failed', 'canceled']);
const MANIFEST_PATTERN = /^manifests\/v1\/(snp_[a-f0-9]{40})[.]dxb$/;

class CockroachDbRetentionAdapterError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'CockroachDbRetentionAdapterError';
    this.code = code;
    this.category = options.category || 'retention';
    this.retryable = Boolean(options.retryable);
  }
}

function fail(code, message, category = 'retention', retryable = false) {
  throw new CockroachDbRetentionAdapterError(code, message, { category, retryable });
}

function requiredText(value, label, maximumLength = 4096) {
  const text = String(value ?? '').trim();
  if (!text || text.includes('\0') || text.length > maximumLength) throw new TypeError(`${label} is invalid.`);
  return text;
}

function positiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER, minimum = 1) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw new TypeError(`${label} is invalid.`);
  return number;
}

function fingerprint(value, label) {
  const text = requiredText(value, label, 80);
  if (!/^sha256:[0-9a-f]{64}$/.test(text)) throw new TypeError(`${label} is invalid.`);
  return text;
}

function timestamp(value, label) {
  const date = new Date(requiredText(value, label, 100));
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${label} is invalid.`);
  return date.toISOString();
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function stableDigest(value) {
  return `sha256:${crypto.createHash('sha256').update(stable(value)).digest('hex')}`;
}

function same(left, right) {
  return stable(left) === stable(right);
}

function boundedList(records, limit, message) {
  if (!Array.isArray(records) || records.length >= limit) fail('COCKROACH_RETENTION_SCAN_LIMIT', message, 'capacity');
  return records;
}

function intersects(values, expected) {
  return Array.isArray(values) && values.some((value) => expected.has(value));
}

function isActive(record) {
  return record && !TERMINAL_STATES.has(record.state);
}

class CockroachDbRetentionCatalog {
  constructor({ controlDatabase, clock = () => new Date().toISOString() } = {}) {
    if (!controlDatabase || typeof controlDatabase.repository !== 'function' || typeof controlDatabase.transaction !== 'function') throw new TypeError('CockroachDB retention catalog dependencies are required.');
    this.controlDatabase = controlDatabase;
    this.clock = clock;
  }

  async listRecoveryPoints(workspaceId, sourceId, options = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const sourceKey = requiredText(sourceId, 'CockroachDB Source ID', 200);
    const limit = positiveInteger(options.limit || MAXIMUM_CATALOG_RECORDS, 'CockroachDB RecoveryPoint scan limit', MAXIMUM_CATALOG_RECORDS);
    const source = await this.controlDatabase.repository('source').get(tenant, sourceKey);
    if (!source || source.adapterId !== ADAPTER_ID || source.physicalExecution?.engine !== 'cockroachdb') {
      fail('COCKROACH_RETENTION_SOURCE_INVALID', 'The selected Source is not an enrolled CockroachDB Source.', 'validation');
    }
    const points = boundedList(
      await this.controlDatabase.repository('recoveryPoint').list(tenant, { limit }),
      limit,
      'CockroachDB retention could not inspect the complete RecoveryPoint catalog.'
    );
    return points.filter((point) => point.sourceId === sourceKey);
  }

  async listActiveOperations(workspaceId, recoveryPointIds, options = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    if (!Array.isArray(recoveryPointIds) || recoveryPointIds.length < 1) throw new TypeError('CockroachDB active-operation RecoveryPoint IDs are required.');
    const pointIds = new Set(recoveryPointIds.map((id) => requiredText(id, 'CockroachDB RecoveryPoint ID', 200)));
    const limit = positiveInteger(options.limit || MAXIMUM_CATALOG_RECORDS, 'CockroachDB active-operation scan limit', MAXIMUM_CATALOG_RECORDS);
    const [points, runs, restores, verifications] = await Promise.all([
      this.controlDatabase.repository('recoveryPoint').list(tenant, { limit }),
      this.controlDatabase.repository('run').list(tenant, { limit }),
      this.controlDatabase.repository('restoreRun').list(tenant, { limit }),
      this.controlDatabase.repository('verificationRun').list(tenant, { limit })
    ]);
    boundedList(points, limit, 'CockroachDB retention could not inspect the complete RecoveryPoint catalog.');
    boundedList(runs, limit, 'CockroachDB retention could not inspect the complete backup-run catalog.');
    boundedList(restores, limit, 'CockroachDB retention could not inspect the complete restore-run catalog.');
    boundedList(verifications, limit, 'CockroachDB retention could not inspect the complete Recovery Test catalog.');
    const selected = points.filter((point) => pointIds.has(point.id));
    if (selected.length !== pointIds.size) fail('COCKROACH_RETENTION_POINT_NOT_FOUND', 'A selected CockroachDB RecoveryPoint changed during active-operation inspection.', 'conflict');
    const sourceIds = new Set(selected.map((point) => point.sourceId));
    const jobIds = new Set(selected.map((point) => point.jobId));
    const operations = new Map();
    for (const run of runs) {
      const source = run.configSnapshot?.source;
      if (isActive(run) && (sourceIds.has(source?.id) || jobIds.has(run.jobId))) operations.set(run.id, { id: run.id });
    }
    for (const run of restores) if (isActive(run) && intersects(run.recoveryPointIds, pointIds)) operations.set(run.id, { id: run.id });
    for (const run of verifications) {
      if (isActive(run) && (pointIds.has(run.recoveryPointId) || intersects(run.recoveryPointIds, pointIds))) operations.set(run.id, { id: run.id });
    }
    return [...operations.values()].sort((left, right) => left.id.localeCompare(right.id, 'en-US'));
  }

  async markRepositoryCopyPruned(workspaceId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const pointId = requiredText(input.recoveryPointId, 'CockroachDB RecoveryPoint ID', 200);
    const repositoryId = requiredText(input.repositoryId, 'Backup repository ID', 200);
    const actorId = requiredText(input.actorId, 'Actor ID', 200);
    const expectedRevision = positiveInteger(input.recoveryPointRevision, 'CockroachDB RecoveryPoint revision');
    const prunedAt = timestamp(input.prunedAt || this.clock(), 'CockroachDB repository-copy prune time');
    const planId = requiredText(input.planId, 'CockroachDB retention plan ID', 100);
    const ownershipFingerprint = fingerprint(input.ownershipFingerprint, 'CockroachDB ownership fingerprint');
    const mediaFingerprint = fingerprint(input.mediaFingerprint, 'CockroachDB repository media fingerprint');
    if (input.externalNativeMediaPreserved !== true) throw new TypeError('CockroachDB native media must remain preserved.');
    return this.controlDatabase.transaction((transaction) => {
      const point = transaction.get('recoveryPoint', tenant, pointId);
      if (!point || point.revision !== expectedRevision || point.sourceId === undefined) fail('COCKROACH_RETENTION_POINT_CHANGED', 'The CockroachDB RecoveryPoint changed during retention.', 'conflict');
      const matching = (point.repositoryCopies || []).filter((copy) => copy.repositoryId === repositoryId);
      if (matching.length !== 1 || matching[0].state !== 'available') fail('COCKROACH_RETENTION_COPY_CHANGED', 'The CockroachDB repository copy changed during retention.', 'conflict');
      const copies = point.repositoryCopies.map((copy) => copy.repositoryId === repositoryId ? {
        ...copy,
        state: 'pruned',
        prunedAt,
        retentionPlanId: planId,
        retentionOwnershipFingerprint: ownershipFingerprint,
        retentionMediaFingerprint: mediaFingerprint,
        externalNativeMediaPreserved: true,
        nativeMediaDeletionAttempted: false,
        manifestDeletion: { confirmed: true, absent: false }
      } : copy);
      return transaction.projectRecoveryPointRepositoryCopies(tenant, pointId, copies, { expectedRevision, actorId });
    });
  }
}

async function listManifestKeys(adapter) {
  const keys = [];
  let cursor = null;
  do {
    let page = null;
    for await (const value of adapter.list({}, { prefix: 'manifests/v1/', cursor, pageSize: 200 })) {
      if (page) fail('COCKROACH_RETENTION_REPOSITORY_INVALID', 'The repository returned more than one manifest page.', 'integrity');
      page = value;
    }
    if (!page || !Array.isArray(page.items)) fail('COCKROACH_RETENTION_REPOSITORY_INVALID', 'The repository returned an invalid manifest listing.', 'integrity');
    for (const item of page.items) {
      const key = requiredText(item?.key, 'Repository manifest key', 500);
      if (!MANIFEST_PATTERN.test(key)) fail('COCKROACH_RETENTION_REPOSITORY_INVALID', 'The repository contains an unrecognized manifest object.', 'integrity');
      keys.push(key);
      if (keys.length >= MAXIMUM_MANIFESTS) fail('COCKROACH_RETENTION_SCAN_LIMIT', 'CockroachDB retention exceeded its bounded manifest scan.', 'capacity');
    }
    cursor = page.hasMore ? requiredText(page.nextCursor, 'Repository manifest cursor', 1000) : null;
  } while (cursor);
  return [...new Set(keys)].sort();
}

function snapshotIdFromManifestKey(key) {
  const match = MANIFEST_PATTERN.exec(key);
  if (!match) fail('COCKROACH_RETENTION_REPOSITORY_INVALID', 'The repository manifest identity is invalid.', 'integrity');
  return match[1];
}

function manifestChunks(manifest) {
  const chunks = new Set();
  let references = 0;
  for (const file of manifest?.files || []) {
    for (const chunk of file.chunks || []) {
      const key = requiredText(chunk?.key, 'Repository chunk key', 500);
      chunks.add(key);
      references += 1;
      if (references > MAXIMUM_CHUNK_REFERENCES) fail('COCKROACH_RETENTION_SCAN_LIMIT', 'CockroachDB retention exceeded its bounded chunk-reference scan.', 'capacity');
    }
  }
  return chunks;
}

function ancestorIds(point, points) {
  const byId = new Map(points.map((record) => [record.id, record]));
  const reversed = [];
  const seen = new Set([point.id]);
  let current = point;
  while (current.parentRecoveryPointId) {
    const parent = byId.get(current.parentRecoveryPointId);
    if (!parent || parent.sourceId !== point.sourceId || parent.jobId !== point.jobId || seen.has(parent.id)) fail('COCKROACH_RETENTION_CHAIN_INCOMPLETE', 'CockroachDB repository ownership has incomplete or cyclic ancestry.', 'integrity');
    seen.add(parent.id);
    reversed.push(parent.id);
    current = parent;
  }
  const ancestors = reversed.reverse();
  if (current.type !== 'full' || current.id !== point.chainRootId) fail('COCKROACH_RETENTION_CHAIN_INCOMPLETE', 'CockroachDB repository ownership has no exact full chain root.', 'integrity');
  return ancestors;
}

class CockroachDbRepositoryMedia {
  constructor({ controlDatabase, openRepository, deviceId, randomUUID = crypto.randomUUID } = {}) {
    if (!controlDatabase || typeof openRepository !== 'function') throw new TypeError('CockroachDB repository-media dependencies are required.');
    this.controlDatabase = controlDatabase;
    this.openRepository = openRepository;
    this.deviceId = requiredText(deviceId, 'Device ID', 200);
    this.randomUUID = randomUUID;
    this.leases = new Map();
  }

  async #openOwned(workspaceId, repositoryId) {
    const repository = await this.controlDatabase.repository('repository').get(workspaceId, repositoryId);
    if (!repository || !(repository.workerAffinity || []).includes(`device:${this.deviceId}`)) fail('COCKROACH_RETENTION_REPOSITORY_UNAVAILABLE', 'CockroachDB repository retention must run on the repository owner device.', 'authorization');
    const opened = await this.openRepository(workspaceId, repositoryId);
    if (!opened?.adapter || !opened.engine || !opened.masterKey) fail('COCKROACH_RETENTION_REPOSITORY_UNAVAILABLE', 'The CockroachDB metadata repository is unavailable.', 'not-found', true);
    return { repository, opened };
  }

  async acquireRetentionLock(input = {}) {
    const workspaceId = requiredText(input.workspaceId, 'Workspace ID', 200);
    const repositoryId = requiredText(input.repositoryId, 'Backup repository ID', 200);
    const sourceId = requiredText(input.sourceId, 'CockroachDB Source ID', 200);
    const key = `${workspaceId}:${repositoryId}`;
    if (this.leases.has(key)) fail('COCKROACH_RETENTION_LOCK_UNAVAILABLE', 'The repository already has an active retention mutation.', 'conflict', true);
    const { opened } = await this.#openOwned(workspaceId, repositoryId);
    const lease = await opened.adapter.acquireLock({ masterKey: opened.masterKey }, {
      repositoryId,
      operation: 'prune',
      scope: `repository:${repositoryId}:mutation`,
      workerId: `device:${this.deviceId}`,
      runId: `cockroach-retention:${this.randomUUID()}`,
      ttlMs: 15 * 60 * 1000
    });
    const held = { key, workspaceId, repositoryId, sourceId, opened, lease };
    this.leases.set(key, held);
    return held;
  }

  async releaseRetentionLock(value) {
    if (!value || this.leases.get(value.key) !== value) return false;
    this.leases.delete(value.key);
    await value.opened.adapter.releaseLock({ masterKey: value.opened.masterKey }, value.lease);
    return true;
  }

  async #inspect(input, suppliedOpened = null) {
    const workspaceId = requiredText(input.workspaceId, 'Workspace ID', 200);
    const repositoryId = requiredText(input.repositoryId, 'Backup repository ID', 200);
    const point = input.recoveryPoint;
    const copy = input.copy;
    if (!point || typeof point !== 'object' || !copy || typeof copy !== 'object') throw new TypeError('CockroachDB repository ownership input is invalid.');
    const pointId = requiredText(point.id, 'CockroachDB RecoveryPoint ID', 200);
    const pointRevision = positiveInteger(point.revision, 'CockroachDB RecoveryPoint revision');
    if (copy.repositoryId !== repositoryId || copy.state !== 'available') fail('COCKROACH_RETENTION_OWNERSHIP_AMBIGUOUS', 'The selected CockroachDB repository copy is not available.', 'integrity');
    const { opened } = suppliedOpened ? { opened: suppliedOpened } : await this.#openOwned(workspaceId, repositoryId);
    const [points, artifacts, manifestKeys] = await Promise.all([
      this.controlDatabase.repository('recoveryPoint').list(workspaceId, { limit: MAXIMUM_CATALOG_RECORDS }),
      this.controlDatabase.repository('artifact').list(workspaceId, { limit: MAXIMUM_ARTIFACTS }),
      listManifestKeys(opened.adapter)
    ]);
    boundedList(points, MAXIMUM_CATALOG_RECORDS, 'CockroachDB retention could not inspect the complete RecoveryPoint catalog.');
    boundedList(artifacts, MAXIMUM_ARTIFACTS, 'CockroachDB retention could not inspect the complete Artifact catalog.');
    const current = points.find((record) => record.id === pointId);
    if (!current || current.revision !== pointRevision || !same(current, point)) fail('COCKROACH_RETENTION_POINT_CHANGED', 'The CockroachDB RecoveryPoint changed during repository inspection.', 'conflict');
    const source = await this.controlDatabase.repository('source').get(workspaceId, point.sourceId);
    if (!source || source.adapterId !== ADAPTER_ID || source.physicalExecution?.engine !== 'cockroachdb') fail('COCKROACH_RETENTION_SOURCE_INVALID', 'The RecoveryPoint is not owned by an enrolled CockroachDB Source.', 'integrity');
    const manifestKey = requiredText(copy.manifestLocator, 'CockroachDB manifest locator', 500);
    const snapshotId = requiredText(copy.engineSnapshotId, 'CockroachDB repository snapshot ID', 200);
    const manifestChecksum = fingerprint(copy.manifestChecksum?.digest, 'CockroachDB manifest checksum');
    if (!manifestKeys.includes(manifestKey) || snapshotIdFromManifestKey(manifestKey) !== snapshotId) fail('COCKROACH_RETENTION_OWNERSHIP_AMBIGUOUS', 'The CockroachDB manifest identity is unavailable or changed.', 'integrity');

    const snapshots = new Map();
    for (const key of manifestKeys) {
      const snapshot = await opened.engine.openSnapshot({}, { repositoryId, snapshotId: snapshotIdFromManifestKey(key), masterKey: opened.masterKey });
      if (snapshot?.summary?.manifestKey !== key || !snapshot.manifest) fail('COCKROACH_RETENTION_OWNERSHIP_AMBIGUOUS', 'A repository manifest could not be authenticated.', 'integrity');
      snapshots.set(key, snapshot);
    }
    const candidate = snapshots.get(manifestKey);
    if (candidate.summary.manifestChecksum?.digest !== manifestChecksum) fail('COCKROACH_RETENTION_OWNERSHIP_AMBIGUOUS', 'The CockroachDB manifest checksum changed.', 'integrity');
    const metadataArtifacts = artifacts.filter((artifact) => artifact.recoveryPointId === pointId && artifact.repositoryId === repositoryId && artifact.kind === 'metadata');
    if (metadataArtifacts.length !== 1) fail('COCKROACH_RETENTION_OWNERSHIP_AMBIGUOUS', 'CockroachDB metadata Artifact ownership is missing or ambiguous.', 'integrity');
    const artifact = metadataArtifacts[0];
    const locatorPath = decodeURIComponent(String(artifact.locator || '').split('#').slice(1).join('#'));
    const file = locatorPath === ARTIFACT_PATH ? (candidate.manifest.files || []).find((entry) => entry.type === 'file' && entry.path === ARTIFACT_PATH) : null;
    if (!file || file.metadata?.artifactKind !== 'metadata' || file.metadata?.externalNativeMedia !== true
      || file.sizeBytes !== artifact.sizeBytes || file.contentDigest?.digest !== artifact.checksum?.digest || !same(file.metadata.database, artifact.metadata)) {
      fail('COCKROACH_RETENTION_OWNERSHIP_AMBIGUOUS', 'The CockroachDB metadata Artifact does not match its authenticated repository manifest.', 'integrity');
    }
    let metadata;
    try {
      metadata = normalizePublishedMetadata(JSON.parse((await opened.engine.readFile({}, { repositoryId, manifest: candidate.manifest, path: ARTIFACT_PATH, masterKey: opened.masterKey })).toString('utf8')));
    } catch {
      fail('COCKROACH_RETENTION_OWNERSHIP_AMBIGUOUS', 'The CockroachDB repository metadata could not be authenticated.', 'integrity');
    }
    const ancestors = ancestorIds(point, points.filter((record) => record.sourceId === point.sourceId));
    const expectedRoot = point.type === 'full' ? null : point.chainRootId;
    if (!same(metadata, artifact.metadata) || metadata.sourceId !== point.sourceId || metadata.jobId !== point.jobId || metadata.backupMode !== point.type
      || metadata.nativeChain.headExecutionId !== point.runId || metadata.nativeChain.incrementalCount !== ancestors.length
      || metadata.chain.parentRecoveryPointId !== point.parentRecoveryPointId || metadata.chain.chainRootRecoveryPointId !== expectedRoot
      || !same(metadata.chain.ancestorRecoveryPointIds, ancestors)) {
      fail('COCKROACH_RETENTION_OWNERSHIP_AMBIGUOUS', 'Authenticated CockroachDB metadata does not match its RecoveryPoint and chain owner.', 'integrity');
    }

    const candidateChunks = manifestChunks(candidate.manifest);
    const retainedChunks = new Set();
    for (const [key, snapshot] of snapshots) if (key !== manifestKey) for (const chunk of manifestChunks(snapshot.manifest)) retainedChunks.add(chunk);
    const exclusiveChunkKeys = [...candidateChunks].filter((key) => !retainedChunks.has(key)).sort();
    const sharedChunkKeys = [...candidateChunks].filter((key) => retainedChunks.has(key)).sort();
    const manifestFingerprint = stableDigest({ manifestKey, manifestChecksum, snapshotId, keyVersion: candidate.manifest.keyVersion, fileDigest: stableDigest(candidate.manifest.files || []) });
    const mediaFingerprint = stableDigest({ manifestFingerprint, metadataDigest: metadata.publication.metadataDigest, chunks: [...candidateChunks].sort() });
    const collectionFingerprint = stableDigest({ destinationFingerprint: metadata.destination.destinationFingerprint, localityFingerprint: metadata.destination.localityFingerprint });
    const deletionEvidence = {
      version: 1,
      workspaceId,
      repositoryId,
      recoveryPointId: pointId,
      recoveryPointRevision: pointRevision,
      manifestKey,
      manifestFingerprint,
      mediaFingerprint,
      ownershipFingerprint: metadata.ownershipFingerprint,
      exclusiveChunkFingerprint: stableDigest(exclusiveChunkKeys),
      sharedChunkFingerprint: stableDigest(sharedChunkKeys)
    };
    return {
      public: {
        ownershipState: 'owned',
        ownerKind: 'deployerx-repository',
        manifestFingerprint,
        mediaFingerprint,
        ownershipFingerprint: metadata.ownershipFingerprint,
        deletionToken: stableDigest(deletionEvidence),
        objectCount: 1 + candidateChunks.size,
        exclusiveObjectCount: 1 + exclusiveChunkKeys.length,
        sharedObjectCount: sharedChunkKeys.length,
        sizeBytes: Number(file.sizeBytes || 0),
        immutableUntil: copy.immutableUntil || null,
        chainEvidence: {
          authenticated: true,
          sourceId: point.sourceId,
          jobId: point.jobId,
          recoveryPointId: pointId,
          backupMode: point.type,
          parentRecoveryPointId: point.parentRecoveryPointId,
          chainRootId: point.chainRootId,
          ancestorRecoveryPointIds: ancestors,
          collectionFingerprint,
          incrementalCount: ancestors.length,
          maximumIncrementals: 48,
          compactionEnabled: false,
          compactionSettingFingerprint: null
        }
      },
      manifestKey,
      exclusiveChunkKeys,
      sharedChunkKeys
    };
  }

  async inspectOwnedCopy(input = {}) {
    return (await this.#inspect(input)).public;
  }

  async deleteOwnedCopy(input = {}) {
    const workspaceId = requiredText(input.workspaceId, 'Workspace ID', 200);
    const repositoryId = requiredText(input.repositoryId, 'Backup repository ID', 200);
    const pointId = requiredText(input.recoveryPointId, 'CockroachDB RecoveryPoint ID', 200);
    const pointRevision = positiveInteger(input.recoveryPointRevision, 'CockroachDB RecoveryPoint revision');
    const key = `${workspaceId}:${repositoryId}`;
    const held = this.leases.get(key);
    if (!held) fail('COCKROACH_RETENTION_LOCK_REQUIRED', 'CockroachDB repository deletion requires the active repository mutation lease.', 'conflict');
    if (input.preserveSharedObjects !== true) throw new TypeError('CockroachDB repository deletion must preserve shared objects.');
    const point = await this.controlDatabase.repository('recoveryPoint').get(workspaceId, pointId);
    const copy = point?.repositoryCopies?.find((item) => item.repositoryId === repositoryId);
    if (!point || point.revision !== pointRevision || !copy) fail('COCKROACH_RETENTION_POINT_CHANGED', 'The CockroachDB RecoveryPoint changed before repository deletion.', 'conflict');
    const inspected = await this.#inspect({ workspaceId, repositoryId, recoveryPoint: point, copy }, held.opened);
    if (inspected.public.deletionToken !== requiredText(input.deletionToken, 'CockroachDB deletion token', 4096)
      || inspected.public.ownershipFingerprint !== fingerprint(input.ownershipFingerprint, 'CockroachDB ownership fingerprint')
      || inspected.public.mediaFingerprint !== fingerprint(input.mediaFingerprint, 'CockroachDB media fingerprint')) {
      fail('COCKROACH_RETENTION_PLAN_STALE', 'CockroachDB repository ownership changed after retention review.', 'conflict');
    }
    const manifestDeletion = await held.opened.adapter.delete({}, { key: inspected.manifestKey });
    if (!manifestDeletion?.deleted && !manifestDeletion?.absent) fail('COCKROACH_RETENTION_DELETE_UNCONFIRMED', 'The repository did not confirm CockroachDB manifest deletion.', 'integrity', true);
    for (let index = 0; index < inspected.exclusiveChunkKeys.length; index += 1) {
      const deletion = await held.opened.adapter.delete({}, { key: inspected.exclusiveChunkKeys[index] });
      if (!deletion?.deleted && !deletion?.absent) fail('COCKROACH_RETENTION_DELETE_UNCONFIRMED', 'The repository did not confirm CockroachDB exclusive-chunk deletion.', 'integrity', true);
      if ((index + 1) % 100 === 0) {
        held.lease = await held.opened.adapter.renewLock({ masterKey: held.opened.masterKey }, held.lease);
      }
    }
    return {
      deleted: true,
      mediaFingerprint: inspected.public.mediaFingerprint,
      exclusiveObjectsDeleted: inspected.public.exclusiveObjectCount,
      sharedObjectsPreserved: inspected.public.sharedObjectCount
    };
  }
}

function createCockroachDbRetentionAdapters(options = {}) {
  return {
    catalog: new CockroachDbRetentionCatalog(options),
    repositoryMedia: new CockroachDbRepositoryMedia(options)
  };
}

module.exports = {
  MAXIMUM_ARTIFACTS,
  MAXIMUM_CATALOG_RECORDS,
  MAXIMUM_CHUNK_REFERENCES,
  MAXIMUM_MANIFESTS,
  CockroachDbRepositoryMedia,
  CockroachDbRetentionAdapterError,
  CockroachDbRetentionCatalog,
  createCockroachDbRetentionAdapters,
  listManifestKeys,
  stableDigest
};
