const crypto = require('crypto');
const { digestJson } = require('./database-adapter');
const { ADAPTER_ID } = require('./influxdb3-enterprise');
const { normalizeLegacyMedia } = require('./influxdb3-enterprise-legacy');
const { containsAbsolutePath } = require('./influxdb3-enterprise-legacy-restore');
const {
  ARTIFACT_KIND,
  MEDIA_PREFIX,
  METADATA_PATH,
  SOURCE_TIER,
  isLegacyFilesystemSource,
  normalizeLegacySourceExecution,
  repositoryPath
} = require('./influxdb3-enterprise-legacy-source-reader');
const { DRILL_MODE, METADATA_MODE } = require('./influxdb3-enterprise-legacy-verification');

const MAXIMUM_POINTS = 1000;
const MAXIMUM_ARTIFACTS = 2000;
const MAXIMUM_OPERATIONS = 1000;
const MAXIMUM_MANIFESTS = 1000;
const MAXIMUM_CHUNK_REFERENCES = 1000000;
const RESOLVED_STATES = new Set(['succeeded', 'warning', 'failed', 'canceled']);

class InfluxDb3EnterpriseLegacyRetentionError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'InfluxDb3EnterpriseLegacyRetentionError';
    this.code = code;
    this.category = options.category || 'retention';
    this.retryable = Boolean(options.retryable);
  }
}

function requiredText(value, label, maximumLength = 4096) {
  const text = String(value ?? '').trim();
  if (!text || text.includes('\0') || text.length > maximumLength) throw new TypeError(`${label} is invalid.`);
  return text;
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function stableDigest(value) {
  return `sha256:${crypto.createHash('sha256').update(stable(value)).digest('hex')}`;
}

function deletionPlanId(evidence) {
  return `legacy_delete_${crypto.createHash('sha256').update(stable(evidence)).digest('hex')}`;
}

function immutable(value, now) {
  if (value === null || value === undefined || value === '') return false;
  const parsed = Date.parse(String(value));
  return !Number.isFinite(parsed) || parsed > now;
}

function held(value) {
  return value !== undefined && value !== null && value !== false;
}

async function listManifestKeys(adapter) {
  const keys = [];
  let cursor = null;
  do {
    let page = null;
    for await (const value of adapter.list({}, { prefix: 'manifests/v1/', cursor, pageSize: 200 })) {
      if (page) throw new InfluxDb3EnterpriseLegacyRetentionError('INFLUXDB3_ENTERPRISE_LEGACY_RETENTION_LIST_INVALID', 'The repository returned an invalid manifest listing.', { category: 'integrity' });
      page = value;
    }
    if (!page || !Array.isArray(page.items)) throw new InfluxDb3EnterpriseLegacyRetentionError('INFLUXDB3_ENTERPRISE_LEGACY_RETENTION_LIST_INVALID', 'The repository returned an invalid manifest listing.', { category: 'integrity' });
    for (const item of page.items) {
      const key = String(item?.key || '');
      if (!/^manifests\/v1\/snp_[a-f0-9]{40}[.]dxb$/.test(key)) throw new InfluxDb3EnterpriseLegacyRetentionError('INFLUXDB3_ENTERPRISE_LEGACY_RETENTION_OWNERSHIP_INCOMPLETE', 'The repository contains an unrecognized or unowned manifest.', { category: 'integrity' });
      keys.push(key);
      if (keys.length >= MAXIMUM_MANIFESTS) throw new InfluxDb3EnterpriseLegacyRetentionError('INFLUXDB3_ENTERPRISE_LEGACY_RETENTION_SCAN_LIMIT', 'Legacy retention could not prove bounded repository ownership.', { category: 'capacity' });
    }
    cursor = page.hasMore ? page.nextCursor : null;
    if (page.hasMore && !cursor) throw new InfluxDb3EnterpriseLegacyRetentionError('INFLUXDB3_ENTERPRISE_LEGACY_RETENTION_LIST_INVALID', 'The repository manifest continuation is invalid.', { category: 'integrity' });
  } while (cursor);
  return keys.sort();
}

function exactLegacyArtifact(metadata, point, source, execution) {
  return metadata?.kind === ARTIFACT_KIND
    && metadata.adapterId === ADAPTER_ID
    && metadata.tier === SOURCE_TIER
    && metadata.sourceId === source.id
    && metadata.selectionDigest === source.selector?.digest
    && metadata.backupMethod === 'physical'
    && metadata.backupMode === 'full'
    && metadata.artifact?.path === METADATA_PATH
    && metadata.artifact?.restoreSupported === true
    && metadata.capture?.completeMediaAuthenticated === true
    && metadata.capture?.achievedConsistency === point.consistency
    && metadata.publication?.localPathsPublished === false
    && metadata.source?.clusterId === execution.clusterId
    && metadata.source?.compactorNodeId === execution.compactorNodeId
    && stableDigest(metadata.source?.dataNodeIds) === stableDigest(execution.dataNodeIds)
    && metadata.source?.topologyFingerprint === execution.topologyFingerprint
    && metadata.source?.storageFingerprint === execution.storageFingerprint
    && !containsAbsolutePath(metadata);
}

class InfluxDb3EnterpriseLegacyRetentionService {
  constructor({ controlDatabase, openRepository, deviceId, clock = () => new Date().toISOString(), randomUUID = crypto.randomUUID } = {}) {
    if (!controlDatabase || typeof openRepository !== 'function') throw new TypeError('InfluxDB 3 Enterprise legacy retention dependencies are required.');
    this.controlDatabase = controlDatabase;
    this.openRepository = openRepository;
    this.deviceId = requiredText(deviceId, 'Device ID', 200);
    this.clock = clock;
    this.randomUUID = randomUUID;
  }

  async planDeletion(workspaceId, recoveryPointId, repositoryId) {
    const plan = await this.#build(requiredText(workspaceId, 'Workspace ID', 200), requiredText(recoveryPointId, 'RecoveryPoint ID', 200), requiredText(repositoryId, 'Repository ID', 200), this.clock());
    return {
      version: 1,
      planId: plan.planId,
      evaluatedAt: plan.evaluatedAt,
      recoveryPointId: plan.recoveryPointId,
      repositoryId: plan.repositoryId,
      eligible: plan.blockedReason === null,
      blockedReason: plan.blockedReason,
      activeOperationIds: plan.activeOperationIds,
      ownership: plan.ownership,
      chain: plan.chain,
      summary: { manifestsToDelete: plan.blockedReason ? 0 : 1, chunksToDelete: plan.blockedReason ? 0 : plan.chunkKeys.length }
    };
  }

  async executeDeletion(workspaceId, actorId, recoveryPointId, repositoryId, expectedPlanId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const pointId = requiredText(recoveryPointId, 'RecoveryPoint ID', 200);
    const repositoryKey = requiredText(repositoryId, 'Repository ID', 200);
    const repository = await this.controlDatabase.repository('repository').get(tenant, repositoryKey);
    if (!repository || !(repository.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new InfluxDb3EnterpriseLegacyRetentionError('INFLUXDB3_ENTERPRISE_LEGACY_RETENTION_REPOSITORY_UNAVAILABLE', 'Legacy RecoveryPoint deletion must run on the repository owner device.', { category: 'authorization' });
    const opened = await this.openRepository(tenant, repositoryKey);
    let lease = await opened.adapter.acquireLock({ masterKey: opened.masterKey }, { repositoryId: repositoryKey, operation: 'prune', scope: `repository:${repositoryKey}:mutation`, workerId: `device:${this.deviceId}`, runId: `legacy-delete:${this.randomUUID()}`, ttlMs: 15 * 60 * 1000 });
    try {
      const plan = await this.#build(tenant, pointId, repositoryKey, this.clock(), opened);
      if (!expectedPlanId || plan.planId !== expectedPlanId) throw new InfluxDb3EnterpriseLegacyRetentionError('INFLUXDB3_ENTERPRISE_LEGACY_RETENTION_PLAN_STALE', 'The legacy RecoveryPoint or repository changed after deletion review.', { category: 'conflict' });
      if (plan.blockedReason) throw new InfluxDb3EnterpriseLegacyRetentionError('INFLUXDB3_ENTERPRISE_LEGACY_RETENTION_DELETE_BLOCKED', 'Legacy RecoveryPoint deletion remains blocked by retention, dependency, or active-operation safety.', { category: 'conflict' });
      const deletion = await opened.adapter.delete({}, { key: plan.manifestKey });
      if (!deletion?.deleted && !deletion?.absent) throw new InfluxDb3EnterpriseLegacyRetentionError('INFLUXDB3_ENTERPRISE_LEGACY_RETENTION_DELETE_UNCONFIRMED', 'The repository did not confirm legacy manifest deletion.', { retryable: true });
      const projected = await this.controlDatabase.transaction((transaction) => {
        const point = transaction.get('recoveryPoint', tenant, pointId);
        if (!point || point.revision !== plan.recoveryPointRevision) throw new InfluxDb3EnterpriseLegacyRetentionError('INFLUXDB3_ENTERPRISE_LEGACY_RETENTION_PLAN_STALE', 'The legacy RecoveryPoint changed during deletion.', { category: 'conflict' });
        const copies = point.repositoryCopies.map((copy) => copy.repositoryId === repositoryKey ? { ...copy, state: 'pruned', prunedAt: this.clock(), deletionPlanId: plan.planId, manifestDeletion: { confirmed: true, absent: deletion.absent === true } } : copy);
        return transaction.projectRecoveryPointRepositoryCopies(tenant, point.id, copies, { expectedRevision: point.revision, actorId: actor });
      });
      const chunkResults = [];
      for (let index = 0; index < plan.chunkKeys.length; index += 1) {
        const key = plan.chunkKeys[index];
        const result = await opened.adapter.delete({}, { key });
        if (!result?.deleted && !result?.absent) throw new InfluxDb3EnterpriseLegacyRetentionError('INFLUXDB3_ENTERPRISE_LEGACY_RETENTION_DELETE_UNCONFIRMED', 'The repository did not confirm legacy chunk deletion.', { retryable: true });
        chunkResults.push({ digest: stableDigest(key), absent: result.absent === true });
        if ((index + 1) % 100 === 0) lease = await opened.adapter.renewLock({ masterKey: opened.masterKey }, lease);
      }
      return {
        planId: plan.planId,
        recoveryPointId: pointId,
        repositoryId: repositoryKey,
        copyState: projected.repositoryCopies.find((copy) => copy.repositoryId === repositoryKey).state,
        manifestDeletionConfirmed: true,
        chunksDeleted: chunkResults.length,
        chunkEvidence: chunkResults,
        completedAt: this.clock()
      };
    } finally {
      await opened.adapter.releaseLock({ masterKey: opened.masterKey }, lease).catch(() => {});
    }
  }

  async #build(workspaceId, recoveryPointId, repositoryId, evaluatedAt, suppliedOpened = null) {
    const now = Date.parse(evaluatedAt);
    if (!Number.isFinite(now)) throw new InfluxDb3EnterpriseLegacyRetentionError('INFLUXDB3_ENTERPRISE_LEGACY_RETENTION_CLOCK_INVALID', 'Legacy retention evaluation time is invalid.', { category: 'internal' });
    const [repository, point, points, artifacts, restores, verifications] = await Promise.all([
      this.controlDatabase.repository('repository').get(workspaceId, repositoryId),
      this.controlDatabase.repository('recoveryPoint').get(workspaceId, recoveryPointId),
      this.controlDatabase.repository('recoveryPoint').list(workspaceId, { limit: MAXIMUM_POINTS }),
      this.controlDatabase.repository('artifact').list(workspaceId, { limit: MAXIMUM_ARTIFACTS }),
      this.controlDatabase.repository('restoreRun').list(workspaceId, { limit: MAXIMUM_OPERATIONS }),
      this.controlDatabase.repository('verificationRun').list(workspaceId, { limit: MAXIMUM_OPERATIONS })
    ]);
    if (points.length >= MAXIMUM_POINTS || artifacts.length >= MAXIMUM_ARTIFACTS || restores.length >= MAXIMUM_OPERATIONS || verifications.length >= MAXIMUM_OPERATIONS) throw new InfluxDb3EnterpriseLegacyRetentionError('INFLUXDB3_ENTERPRISE_LEGACY_RETENTION_SCAN_LIMIT', 'Legacy retention could not inspect every ownership, chain, and active-operation record.', { category: 'capacity' });
    if (!repository || !(repository.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new InfluxDb3EnterpriseLegacyRetentionError('INFLUXDB3_ENTERPRISE_LEGACY_RETENTION_REPOSITORY_UNAVAILABLE', 'Legacy RecoveryPoint deletion must run on the repository owner device.', { category: 'authorization' });
    if (!point) throw new InfluxDb3EnterpriseLegacyRetentionError('INFLUXDB3_ENTERPRISE_LEGACY_RETENTION_POINT_NOT_FOUND', 'The legacy RecoveryPoint was not found.', { category: 'not-found' });
    const source = await this.controlDatabase.repository('source').get(workspaceId, point.sourceId);
    if (!source || !isLegacyFilesystemSource(source)) throw new InfluxDb3EnterpriseLegacyRetentionError('INFLUXDB3_ENTERPRISE_LEGACY_RETENTION_POINT_INVALID', 'The RecoveryPoint is not owned by an InfluxDB 3 Enterprise legacy filesystem Source.', { category: 'validation' });
    let execution;
    try { execution = normalizeLegacySourceExecution(source.physicalExecution); }
    catch { throw new InfluxDb3EnterpriseLegacyRetentionError('INFLUXDB3_ENTERPRISE_LEGACY_RETENTION_POINT_INVALID', 'The legacy Source execution identity is unavailable.', { category: 'integrity' }); }
    if (point.type !== 'full' || point.parentRecoveryPointId !== null || point.chainRootId !== point.id) throw new InfluxDb3EnterpriseLegacyRetentionError('INFLUXDB3_ENTERPRISE_LEGACY_RETENTION_CHAIN_INCOMPLETE', 'Legacy deletion requires a proven standalone full RecoveryPoint chain root.', { category: 'integrity' });
    const dependencies = points.filter((candidate) => candidate.id !== point.id && (candidate.parentRecoveryPointId === point.id || candidate.chainRootId === point.id) && (candidate.repositoryCopies || []).some((copy) => copy.state === 'available'));
    const copy = (point.repositoryCopies || []).find((candidate) => candidate.repositoryId === repositoryId);
    if (!copy || copy.state !== 'available' || !copy.engineSnapshotId || !copy.manifestLocator || !copy.manifestChecksum?.digest) throw new InfluxDb3EnterpriseLegacyRetentionError('INFLUXDB3_ENTERPRISE_LEGACY_RETENTION_OWNERSHIP_INCOMPLETE', 'The repository copy does not contain complete legacy ownership evidence.', { category: 'integrity' });
    const activeOperationIds = [];
    for (const restore of restores) if (!RESOLVED_STATES.has(restore.state) && (restore.recoveryPointIds || []).includes(point.id)) activeOperationIds.push(restore.id);
    for (const verification of verifications) if (!RESOLVED_STATES.has(verification.state) && [METADATA_MODE, DRILL_MODE].includes(verification.mode) && (verification.recoveryPointId === point.id || (verification.recoveryPointIds || []).includes(point.id))) activeOperationIds.push(verification.id);
    activeOperationIds.sort();
    const opened = suppliedOpened || await this.openRepository(workspaceId, repositoryId);
    const manifestKeys = await listManifestKeys(opened.adapter);
    const availableCopies = points.flatMap((candidate) => (candidate.repositoryCopies || []).filter((candidateCopy) => candidateCopy.repositoryId === repositoryId && candidateCopy.state === 'available').map((candidateCopy) => ({ point: candidate, copy: candidateCopy })));
    const ownersByManifest = new Map();
    for (const owner of availableCopies) {
      if (!owner.copy.manifestLocator || !owner.copy.engineSnapshotId || !owner.copy.manifestChecksum?.digest || ownersByManifest.has(owner.copy.manifestLocator)) throw new InfluxDb3EnterpriseLegacyRetentionError('INFLUXDB3_ENTERPRISE_LEGACY_RETENTION_OWNERSHIP_INCOMPLETE', 'Repository manifest ownership is missing or ambiguous.', { category: 'integrity' });
      ownersByManifest.set(owner.copy.manifestLocator, owner);
    }
    if (manifestKeys.length !== ownersByManifest.size || manifestKeys.some((key) => !ownersByManifest.has(key)) || [...ownersByManifest].some(([key]) => !manifestKeys.includes(key))) throw new InfluxDb3EnterpriseLegacyRetentionError('INFLUXDB3_ENTERPRISE_LEGACY_RETENTION_OWNERSHIP_INCOMPLETE', 'Every repository manifest must have one exact available RecoveryPoint owner before deletion.', { category: 'integrity' });
    const manifests = new Map();
    let chunkReferences = 0;
    for (const key of manifestKeys) {
      const owner = ownersByManifest.get(key);
      const snapshot = await opened.engine.openSnapshot({}, { repositoryId, snapshotId: owner.copy.engineSnapshotId, masterKey: opened.masterKey });
      if (snapshot.summary?.manifestKey !== key || snapshot.summary?.manifestChecksum?.digest !== owner.copy.manifestChecksum.digest) throw new InfluxDb3EnterpriseLegacyRetentionError('INFLUXDB3_ENTERPRISE_LEGACY_RETENTION_OWNERSHIP_INCOMPLETE', 'A repository manifest no longer matches its RecoveryPoint owner.', { category: 'integrity' });
      manifests.set(key, snapshot);
      for (const file of snapshot.manifest.files || []) {
        for (const _chunk of file.chunks || []) {
          chunkReferences += 1;
          if (chunkReferences > MAXIMUM_CHUNK_REFERENCES) throw new InfluxDb3EnterpriseLegacyRetentionError('INFLUXDB3_ENTERPRISE_LEGACY_RETENTION_SCAN_LIMIT', 'Legacy retention exceeded its bounded chunk-reference limit.', { category: 'capacity' });
        }
      }
    }
    const candidateSnapshot = manifests.get(copy.manifestLocator);
    const pointArtifacts = artifacts.filter((artifact) => artifact.recoveryPointId === point.id && artifact.repositoryId === repositoryId);
    const manifestArtifact = pointArtifacts.filter((artifact) => artifact.kind === 'manifest');
    const metadataArtifact = pointArtifacts.filter((artifact) => artifact.kind === 'metadata' && artifact.metadata?.kind === ARTIFACT_KIND);
    if (manifestArtifact.length !== 1 || metadataArtifact.length !== 1 || pointArtifacts.length !== 2 || manifestArtifact[0].locator !== copy.manifestLocator || manifestArtifact[0].checksum?.digest !== copy.manifestChecksum.digest || manifestArtifact[0].encryption?.algorithm !== 'aes-256-gcm' || manifestArtifact[0].encryption?.keyVersion !== candidateSnapshot.manifest.keyVersion || metadataArtifact[0].locator !== `${copy.manifestLocator}#${encodeURIComponent(METADATA_PATH)}` || metadataArtifact[0].encryption?.algorithm !== 'aes-256-gcm' || metadataArtifact[0].encryption?.keyVersion !== candidateSnapshot.manifest.keyVersion) throw new InfluxDb3EnterpriseLegacyRetentionError('INFLUXDB3_ENTERPRISE_LEGACY_RETENTION_OWNERSHIP_INCOMPLETE', 'Legacy manifest and metadata Artifact ownership is incomplete or ambiguous.', { category: 'integrity' });
    const metadataFile = candidateSnapshot.manifest.files.find((file) => file.type === 'file' && file.path === METADATA_PATH);
    if (!metadataFile || metadataFile.sizeBytes !== metadataArtifact[0].sizeBytes || metadataFile.contentDigest?.digest !== metadataArtifact[0].checksum?.digest || metadataFile.metadata?.artifactKind !== 'metadata' || digestJson(metadataFile.metadata?.database) !== digestJson(metadataArtifact[0].metadata)) throw new InfluxDb3EnterpriseLegacyRetentionError('INFLUXDB3_ENTERPRISE_LEGACY_RETENTION_OWNERSHIP_INCOMPLETE', 'The legacy metadata Artifact does not match its encrypted repository manifest.', { category: 'integrity' });
    let metadata;
    try { metadata = JSON.parse((await opened.engine.readFile({}, { repositoryId, manifest: candidateSnapshot.manifest, path: METADATA_PATH, masterKey: opened.masterKey })).toString('utf8')); }
    catch { throw new InfluxDb3EnterpriseLegacyRetentionError('INFLUXDB3_ENTERPRISE_LEGACY_RETENTION_OWNERSHIP_INCOMPLETE', 'The legacy metadata Artifact could not be authenticated.', { category: 'integrity' }); }
    if (digestJson(metadata) !== digestJson(metadataArtifact[0].metadata) || !exactLegacyArtifact(metadata, point, source, execution)) throw new InfluxDb3EnterpriseLegacyRetentionError('INFLUXDB3_ENTERPRISE_LEGACY_RETENTION_OWNERSHIP_INCOMPLETE', 'The authenticated legacy metadata is inconsistent with its RecoveryPoint owner.', { category: 'integrity' });
    let media;
    try { media = normalizeLegacyMedia(metadata.nativeMedia); }
    catch { throw new InfluxDb3EnterpriseLegacyRetentionError('INFLUXDB3_ENTERPRISE_LEGACY_RETENTION_OWNERSHIP_INCOMPLETE', 'Legacy media ownership evidence is invalid.', { category: 'integrity' }); }
    const members = new Map(media.members.map((member) => [member.relativePath, member]));
    const filesByPath = new Map(candidateSnapshot.manifest.files.filter((file) => file.type === 'file').map((file) => [file.path, file]));
    const mediaFiles = candidateSnapshot.manifest.files.filter((file) => file.type === 'file' && file.path.startsWith(MEDIA_PREFIX));
    if (mediaFiles.length !== media.fileCount || candidateSnapshot.manifest.files.filter((file) => file.type === 'file').length !== media.fileCount + 1 || metadata.nativeMedia.members.some((raw) => {
      const member = members.get(raw.relativePath);
      const expectedPath = member ? repositoryPath(member.relativePath) : null;
      const file = expectedPath ? filesByPath.get(expectedPath) : null;
      return !member || raw.repositoryPath !== expectedPath || !file || file.sizeBytes !== member.sizeBytes || file.metadata?.artifactKind !== 'physical-backup-member' || file.metadata?.componentId !== 'legacy-cluster-member' || file.metadata?.nativeRelativePath !== member.relativePath || file.metadata?.contentDigest !== member.contentDigest;
    })) throw new InfluxDb3EnterpriseLegacyRetentionError('INFLUXDB3_ENTERPRISE_LEGACY_RETENTION_OWNERSHIP_INCOMPLETE', 'The complete legacy repository member set is not exactly owned.', { category: 'integrity' });
    const retainedChunks = new Set();
    const candidateChunks = new Set();
    for (const [key, snapshot] of manifests) {
      const target = key === copy.manifestLocator ? candidateChunks : retainedChunks;
      for (const file of snapshot.manifest.files || []) for (const chunk of file.chunks || []) target.add(chunk.key);
    }
    const chunkKeys = [...candidateChunks].filter((key) => !retainedChunks.has(key)).sort();
    let blockedReason = null;
    if (point.retention?.deletionEligible !== true) blockedReason = 'retention-not-eligible';
    else if (held(point.legalHold) || held(point.retention?.legalHold) || held(copy.legalHold)) blockedReason = 'legal-hold';
    else if (immutable(point.immutableUntil, now) || immutable(copy.immutableUntil, now)) blockedReason = 'immutable';
    else if (activeOperationIds.length) blockedReason = 'active-operation';
    else if (dependencies.length) blockedReason = 'dependency';
    const evidence = {
      version: 1,
      recoveryPointId: point.id,
      recoveryPointRevision: point.revision,
      repositoryId,
      manifestKey: copy.manifestLocator,
      manifestChecksum: copy.manifestChecksum.digest,
      snapshotId: copy.engineSnapshotId,
      metadataArtifactId: metadataArtifact[0].id,
      metadataChecksum: metadataArtifact[0].checksum.digest,
      mediaFingerprint: media.mediaFingerprint,
      directoryFingerprint: media.directoryFingerprint,
      manifestRegistryFingerprint: stableDigest(manifestKeys),
      candidateChunkFingerprint: stableDigest(chunkKeys),
      activeOperationIds,
      dependencyIds: dependencies.map((dependency) => dependency.id).sort(),
      blockedReason
    };
    return {
      ...evidence,
      evaluatedAt,
      planId: deletionPlanId(evidence),
      ownership: { repositoryOwnerDevice: true, uniqueManifestOwner: true, encryptedMetadataArtifact: true, completeMemberSet: true, manifestRegistryFingerprint: evidence.manifestRegistryFingerprint },
      chain: { standaloneFullRoot: true, dependencyIds: evidence.dependencyIds },
      chunkKeys
    };
  }
}

module.exports = {
  InfluxDb3EnterpriseLegacyRetentionError,
  InfluxDb3EnterpriseLegacyRetentionService,
  MAXIMUM_ARTIFACTS,
  MAXIMUM_MANIFESTS,
  MAXIMUM_OPERATIONS,
  MAXIMUM_POINTS,
  deletionPlanId,
  exactLegacyArtifact,
  listManifestKeys
};
