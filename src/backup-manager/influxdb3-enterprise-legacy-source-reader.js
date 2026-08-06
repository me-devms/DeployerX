const crypto = require('crypto');
const fsSync = require('fs');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { DatabaseAdapterError } = require('./database-adapter');
const { ADAPTER_ID } = require('./influxdb3-enterprise');
const {
  CONSISTENCY_METHODS,
  authenticateLegacyFilesystem,
  captureLegacyFilesystem,
  inspectLegacyClusterLayout,
  normalizeBackupExecution,
  normalizeLegacyTopology
} = require('./influxdb3-enterprise-legacy');

const ARTIFACT_KIND = 'influxdb3-enterprise-legacy-filesystem-full';
const METADATA_PATH = 'influxdb3-enterprise/legacy/backup-metadata.json';
const MEDIA_PREFIX = 'influxdb3-enterprise/legacy/cluster/';
const SOURCE_TIER = 'legacy-filesystem';
const STAGE_KIND = 'influxdb3-enterprise-legacy-source-stage';
const MAX_METADATA_BYTES = 32 * 1024 * 1024;
const MAX_STAGE_DIRECTORIES = 10000;

class InfluxDb3EnterpriseLegacySourceReaderError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'InfluxDb3EnterpriseLegacySourceReaderError';
    this.code = code;
    this.category = options.category || 'source';
    this.retryable = Boolean(options.retryable);
  }
}

function requiredText(value, label, maximumLength = 4096) {
  const text = String(value ?? '').trim();
  if (!text || text.includes('\0') || text.length > maximumLength) throw new TypeError(`${label} is invalid.`);
  return text;
}

function stableDigest(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function preparationPrefix(workspaceId, executionId) {
  return `legacy-${crypto.createHash('sha256').update(`${workspaceId}\0${executionId}`).digest('hex').slice(0, 32)}-`;
}

function isLegacyFilesystemSource(source) {
  return source?.sourceType === 'database'
    && source?.adapterId === ADAPTER_ID
    && source?.physicalExecution?.tier === SOURCE_TIER;
}

function normalizeLegacySourceExecution(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('InfluxDB 3 Enterprise legacy Source execution must be an object.');
  if (input.tier !== SOURCE_TIER) throw new TypeError('InfluxDB 3 Enterprise legacy Source execution requires the legacy-filesystem tier.');
  const { tier, ...executionInput } = input;
  return Object.freeze({ tier, ...normalizeBackupExecution(executionInput) });
}

function normalizeLegacySourceStorage(input = {}, executionInput = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('InfluxDB 3 Enterprise legacy Source storage must be an object.');
  const allowed = ['kind', 'dataRoot'];
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new TypeError(`Unknown InfluxDB 3 Enterprise legacy Source storage field: ${unknown[0]}.`);
  if (input.kind !== 'local-filesystem') throw new TypeError('InfluxDB 3 Enterprise legacy Source storage must be a local filesystem.');
  const execution = normalizeLegacySourceExecution(executionInput);
  const topology = normalizeLegacyTopology({
    dataRoot: input.dataRoot,
    clusterId: execution.clusterId,
    compactorNodeId: execution.compactorNodeId,
    dataNodeIds: execution.dataNodeIds
  });
  return Object.freeze({ kind: 'local-filesystem', dataRoot: topology.dataRoot });
}

function emptyRules(value) {
  return !value?.include?.length && !value?.exclude?.length;
}

function exactWholeClusterSelector(selector) {
  return selector?.kind === 'database-objects'
    && selector.allDatabases === true
    && emptyRules(selector.databases)
    && emptyRules(selector.schemas)
    && emptyRules(selector.tables)
    && selector.includeGlobalObjects !== true;
}

function exactLegacyConsistency(consistency, execution) {
  const achievedLevel = execution.consistencyMode === 'ordered-live-copy' ? 'crash' : 'application';
  return consistency?.backupMethod === 'physical'
    && consistency.backupMode === 'full'
    && consistency.method === execution.consistencyMethod
    && consistency.requestedLevel === achievedLevel
    && consistency.captureCoordinates === false
    && consistency.allowDowngrade !== true;
}

function repositoryPath(relativePath) {
  return `${MEDIA_PREFIX}${relativePath}`;
}

function topologyInput(topology) {
  return {
    dataRoot: topology.dataRoot,
    clusterId: topology.clusterId,
    compactorNodeId: topology.compactorNodeId,
    dataNodeIds: topology.dataNodeIds
  };
}

function backupExecutionInput(execution) {
  const { tier: _tier, ...input } = execution;
  return input;
}

function publicMedia(media) {
  return Object.freeze({
    product: media.product,
    engine: media.engine,
    objectStore: media.objectStore,
    clusterId: media.clusterId,
    compactorNodeId: media.compactorNodeId,
    dataNodeIds: Object.freeze([...media.dataNodeIds]),
    topologyFingerprint: media.topologyFingerprint,
    consistency: media.consistency,
    members: Object.freeze(media.members.map((member) => Object.freeze({
      relativePath: member.relativePath,
      repositoryPath: repositoryPath(member.relativePath),
      sizeBytes: member.sizeBytes,
      contentDigest: member.contentDigest
    }))),
    directories: Object.freeze([...media.directories]),
    fileCount: media.fileCount,
    directoryCount: media.directoryCount,
    totalBytes: media.totalBytes,
    mediaFingerprint: media.mediaFingerprint,
    directoryFingerprint: media.directoryFingerprint
  });
}

function publicMetadata(plan, media) {
  const identity = plan.connection.lastTest.endpointIdentity;
  const nativeMedia = publicMedia(media);
  return Object.freeze({
    version: 1,
    kind: ARTIFACT_KIND,
    adapterId: ADAPTER_ID,
    adapterVersion: plan.manifest.adapterVersion,
    engine: 'influxdb3-enterprise',
    tier: SOURCE_TIER,
    backupMethod: 'physical',
    backupMode: 'full',
    sourceId: plan.source.id,
    selectionDigest: plan.source.selector.digest,
    consistency: Object.freeze({
      level: media.consistency,
      method: plan.execution.consistencyMethod,
      mode: plan.execution.consistencyMode,
      confirmationDigest: stableDigest(plan.execution.confirmationText)
    }),
    source: Object.freeze({
      product: 'InfluxDB 3 Enterprise',
      productVersion: String(identity.version?.text || identity.version),
      storageEngine: 'legacy-parquet',
      clusterId: media.clusterId,
      compactorNodeId: media.compactorNodeId,
      dataNodeIds: Object.freeze([...media.dataNodeIds]),
      topologyFingerprint: media.topologyFingerprint,
      storageFingerprint: plan.execution.storageFingerprint,
      deploymentFingerprint: identity.deploymentFingerprint,
      capabilityFingerprint: identity.capabilityFingerprint
    }),
    capture: Object.freeze({
      copyOrder: Object.freeze([...media.copyOrder]),
      restoreOrder: Object.freeze([...media.restoreOrder]),
      excluded: Object.freeze([...media.excluded]),
      achievedConsistency: media.consistency,
      driftPhases: Object.freeze([...media.driftPhases]),
      completeMediaAuthenticated: true
    }),
    nativeMedia,
    artifact: Object.freeze({
      kind: 'metadata',
      path: METADATA_PATH,
      mediaType: 'application/vnd.deployerx.influxdb3-enterprise-legacy-filesystem+json',
      restoreSupported: true
    }),
    publication: Object.freeze({ state: 'sealed', localPathsPublished: false })
  });
}

function publicFailure(error) {
  if (error instanceof InfluxDb3EnterpriseLegacySourceReaderError) return error;
  if (error instanceof DatabaseAdapterError || (error?.code && error?.category)) {
    return new InfluxDb3EnterpriseLegacySourceReaderError(
      String(error.code || 'INFLUXDB3_ENTERPRISE_LEGACY_CAPTURE_FAILED').slice(0, 120),
      String(error.message || 'InfluxDB 3 Enterprise legacy capture failed.').slice(0, 500),
      { category: error.category, retryable: error.retryable }
    );
  }
  return new InfluxDb3EnterpriseLegacySourceReaderError(
    'INFLUXDB3_ENTERPRISE_LEGACY_CAPTURE_FAILED',
    'DeployerX could not prepare the InfluxDB 3 Enterprise legacy filesystem backup.',
    { retryable: true }
  );
}

class InfluxDb3EnterpriseLegacySourceReaderService {
  constructor({
    controlDatabase,
    deviceId,
    adapterRegistry,
    temporaryRoot = path.join(os.tmpdir(), 'deployerx-influxdb3-enterprise-legacy-backups'),
    fileSystem = fs,
    createReadStream = fsSync.createReadStream,
    assertClusterStopped = null,
    clock = () => new Date().toISOString()
  } = {}) {
    if (!controlDatabase || !adapterRegistry) throw new TypeError('InfluxDB 3 Enterprise legacy Source reader dependencies are required.');
    this.controlDatabase = controlDatabase;
    this.deviceId = requiredText(deviceId, 'Device ID', 200);
    this.adapterRegistry = adapterRegistry;
    this.temporaryRoot = path.resolve(requiredText(temporaryRoot, 'InfluxDB 3 Enterprise legacy temporary root'));
    this.fileSystem = fileSystem;
    this.createReadStream = createReadStream;
    this.assertClusterStopped = assertClusterStopped;
    this.clock = clock;
    this.preparations = new Map();
  }

  async plan(workspaceId, sourceId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const source = await this.controlDatabase.repository('source').get(tenant, requiredText(sourceId, 'Source ID', 200));
    if (!source || !isLegacyFilesystemSource(source) || source.enabled !== true) throw new InfluxDb3EnterpriseLegacySourceReaderError('INFLUXDB3_ENTERPRISE_LEGACY_SOURCE_UNAVAILABLE', 'The InfluxDB 3 Enterprise legacy filesystem Source is unavailable.');
    if (!exactWholeClusterSelector(source.selector)) throw new InfluxDb3EnterpriseLegacySourceReaderError('INFLUXDB3_ENTERPRISE_LEGACY_SELECTION_INVALID', 'InfluxDB 3 Enterprise legacy filesystem backup requires exact whole-cluster selection.', { category: 'compatibility' });
    let execution;
    let storage;
    try {
      execution = normalizeLegacySourceExecution(source.physicalExecution);
      storage = normalizeLegacySourceStorage(source.legacyFilesystem, source.physicalExecution);
    } catch {
      throw new InfluxDb3EnterpriseLegacySourceReaderError('INFLUXDB3_ENTERPRISE_LEGACY_BINDING_INVALID', 'Re-enroll the exact InfluxDB 3 Enterprise legacy filesystem binding.', { category: 'integrity' });
    }
    if (!exactLegacyConsistency(source.consistency, execution)) throw new InfluxDb3EnterpriseLegacySourceReaderError('INFLUXDB3_ENTERPRISE_LEGACY_CONSISTENCY_INVALID', 'InfluxDB 3 Enterprise legacy filesystem consistency must exactly match its full physical copy proof.', { category: 'compatibility' });
    const connection = await this.controlDatabase.repository('connection').get(tenant, source.connectionId);
    const identity = connection?.lastTest?.endpointIdentity;
    const connectionProven = connection?.adapterId === ADAPTER_ID
      && connection.lastTest?.status === 'success'
      && connection.revision === execution.connectionRevision
      && (connection.workerAffinity || []).includes(`device:${this.deviceId}`)
      && identity?.storageEngine === 'legacy-parquet'
      && identity?.legacyParquetEngine === true
      && identity?.compactorCapable === true
      && identity?.clusterId === execution.clusterId
      && identity?.nodeId === execution.compactorNodeId
      && connection.trust?.fingerprint === identity?.deploymentFingerprint
      && connection.trust?.capabilityFingerprint === identity?.capabilityFingerprint;
    if (!connectionProven) throw new InfluxDb3EnterpriseLegacySourceReaderError('INFLUXDB3_ENTERPRISE_LEGACY_CONNECTION_UNHEALTHY', 'Retest and re-enroll the exact legacy-engine compactor connection on this device.', { category: 'integrity', retryable: true });
    const topology = normalizeLegacyTopology({ dataRoot: storage.dataRoot, clusterId: execution.clusterId, compactorNodeId: execution.compactorNodeId, dataNodeIds: execution.dataNodeIds });
    const layout = await inspectLegacyClusterLayout(topologyInput(topology));
    if (layout.topologyFingerprint !== execution.topologyFingerprint || layout.storageFingerprint !== execution.storageFingerprint) throw new InfluxDb3EnterpriseLegacySourceReaderError('INFLUXDB3_ENTERPRISE_LEGACY_STORAGE_CHANGED', 'The InfluxDB 3 Enterprise legacy topology or local storage identity changed after enrollment.', { category: 'integrity', retryable: true });
    const manifest = this.adapterRegistry.manifest(ADAPTER_ID);
    return { source, connection, execution, storage, topology, layout, manifest: { adapterId: ADAPTER_ID, adapterVersion: manifest.adapterVersion, sourceRevision: source.revision, selectionDigest: source.selector.digest } };
  }

  async #writeOwner(ownerPath, owner, flag = 'w') {
    if (flag === 'wx') return this.fileSystem.writeFile(ownerPath, JSON.stringify(owner), { flag, mode: 0o600 });
    const nextPath = `${ownerPath}.next`;
    await this.fileSystem.writeFile(nextPath, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
    await this.fileSystem.rename(nextPath, ownerPath);
  }

  #owns(owner, workspaceId, executionId, sourceId = null) {
    return owner?.version === 1
      && owner.kind === STAGE_KIND
      && owner.workspaceId === workspaceId
      && owner.executionId === executionId
      && (!sourceId || owner.sourceId === sourceId)
      && ['preparing', 'prepared', 'publishing'].includes(owner.state);
  }

  async #readOwner(directory) {
    return this.fileSystem.readFile(path.join(directory, '.owner.json'), 'utf8').then(JSON.parse).catch(() => null);
  }

  async #cleanupOwned(directory, workspaceId, executionId, sourceId = null) {
    const prefix = preparationPrefix(workspaceId, executionId);
    if (path.dirname(directory) !== this.temporaryRoot || !path.basename(directory).startsWith(prefix)) return false;
    const owner = await this.#readOwner(directory);
    if (!this.#owns(owner, workspaceId, executionId, sourceId)) return false;
    await this.fileSystem.rm(directory, { recursive: true, force: true });
    return true;
  }

  async #prepare(workspaceId, executionId, plan, options) {
    let directory = null;
    try {
      await this.fileSystem.mkdir(this.temporaryRoot, { recursive: true, mode: 0o700 });
      await this.fileSystem.chmod(this.temporaryRoot, 0o700).catch(() => {});
      directory = await this.fileSystem.mkdtemp(path.join(this.temporaryRoot, preparationPrefix(workspaceId, executionId)));
      await this.fileSystem.chmod(directory, 0o700).catch(() => {});
      const ownerPath = path.join(directory, '.owner.json');
      let owner = { version: 1, kind: STAGE_KIND, state: 'preparing', workspaceId, executionId, sourceId: plan.source.id, createdAt: this.clock() };
      await this.#writeOwner(ownerPath, owner, 'wx');
      const media = await captureLegacyFilesystem({
        signal: options.signal,
        onProgress: options.onProgress,
        assertClusterStopped: options.assertClusterStopped || this.assertClusterStopped
      }, topologyInput(plan.topology), backupExecutionInput(plan.execution), path.join(directory, 'media'));
      await authenticateLegacyFilesystem(media.directory, media);
      const databaseManifest = publicMetadata(plan, media);
      const metadataBytes = Buffer.from(JSON.stringify(databaseManifest));
      if (metadataBytes.length < 1 || metadataBytes.length > MAX_METADATA_BYTES) throw new InfluxDb3EnterpriseLegacySourceReaderError('INFLUXDB3_ENTERPRISE_LEGACY_METADATA_LIMIT', 'InfluxDB 3 Enterprise legacy metadata exceeds the supported size.', { category: 'capacity' });
      owner = { ...owner, state: 'prepared', mediaFingerprint: media.mediaFingerprint, preparedAt: this.clock() };
      await this.#writeOwner(ownerPath, owner);
      return { directory, ownerPath, owner, media, databaseManifest, metadataBytes };
    } catch (error) {
      if (directory) await this.#cleanupOwned(directory, workspaceId, executionId, plan.source.id).catch(() => {});
      throw publicFailure(error);
    }
  }

  async files(workspaceId, sourceId, options = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const executionId = requiredText(options.executionId, 'Backup execution ID', 200);
    if (String(options.backupMode || 'full') !== 'full' || (options.requestedBackupMode && String(options.requestedBackupMode) !== 'full')) throw new InfluxDb3EnterpriseLegacySourceReaderError('INFLUXDB3_ENTERPRISE_LEGACY_MODE_UNSUPPORTED', 'InfluxDB 3 Enterprise legacy filesystem Jobs support physical full backups only.', { category: 'compatibility' });
    const plan = await this.plan(tenant, sourceId);
    const key = `${tenant}:${executionId}`;
    if (!this.preparations.has(key)) {
      const promise = this.#prepare(tenant, executionId, plan, options);
      promise.catch(() => this.preparations.delete(key));
      this.preparations.set(key, promise);
    }
    const prepared = await this.preparations.get(key);
    const service = this;
    const consistency = {
      achievedLevel: prepared.media.consistency,
      method: plan.execution.consistencyMethod,
      backupMethod: 'physical',
      backupMode: 'full',
      captureCoordinates: false,
      proven: true
    };
    return {
      ...plan,
      manifest: {
        ...plan.manifest,
        workloadType: 'database',
        resumable: false,
        consistency,
        database: prepared.databaseManifest,
        artifactPath: METADATA_PATH,
        artifactPaths: [METADATA_PATH],
        sizeBytes: prepared.media.totalBytes + prepared.metadataBytes.length
      },
      create: async function* createLegacyFilesystemFiles() {
        await authenticateLegacyFilesystem(prepared.media.directory, prepared.media);
        prepared.owner = { ...prepared.owner, state: 'publishing', publishingAt: service.clock() };
        await service.#writeOwner(prepared.ownerPath, prepared.owner);
        yield {
          path: METADATA_PATH,
          type: 'file',
          metadata: { workload: 'database', artifactKind: 'metadata', componentId: 'cluster-manifest', database: prepared.databaseManifest },
          content: (async function* metadata() { yield prepared.metadataBytes; })()
        };
        for (const member of prepared.media.members) {
          const publicPath = repositoryPath(member.relativePath);
          yield {
            path: publicPath,
            type: 'file',
            metadata: { workload: 'database', artifactKind: 'physical-backup-member', componentId: 'legacy-cluster-member', nativeRelativePath: member.relativePath, contentDigest: member.contentDigest },
            content: service.#streamMember(prepared.media.directory, member, publicPath, options)
          };
        }
      }
    };
  }

  async *#streamMember(mediaRoot, member, publicPath, options) {
    const absolutePath = path.resolve(mediaRoot, ...member.relativePath.split('/'));
    if (!absolutePath.startsWith(`${mediaRoot}${path.sep}`)) throw new InfluxDb3EnterpriseLegacySourceReaderError('INFLUXDB3_ENTERPRISE_LEGACY_MEDIA_INVALID', 'InfluxDB 3 Enterprise legacy media escaped its owned stage.', { category: 'integrity' });
    const before = await this.fileSystem.lstat(absolutePath).catch(() => null);
    if (!before?.isFile() || before.isSymbolicLink() || before.size !== member.sizeBytes) throw new InfluxDb3EnterpriseLegacySourceReaderError('INFLUXDB3_ENTERPRISE_LEGACY_MEDIA_CHANGED', 'InfluxDB 3 Enterprise legacy staged media changed before publication.', { category: 'integrity' });
    const hash = crypto.createHash('sha256');
    let sizeBytes = 0;
    for await (const raw of this.createReadStream(absolutePath, { highWaterMark: 64 * 1024, signal: options.signal })) {
      if (options.signal?.aborted) throw new InfluxDb3EnterpriseLegacySourceReaderError('INFLUXDB3_ENTERPRISE_LEGACY_CANCELED', 'The InfluxDB 3 Enterprise legacy backup was canceled.', { category: 'canceled' });
      const chunk = Buffer.from(raw);
      hash.update(chunk);
      sizeBytes += chunk.length;
      const paced = options.bandwidthLimiter ? await options.bandwidthLimiter.consume(chunk.length) : { limitBytesPerSecond: null, waitedMilliseconds: 0 };
      await options.onProgress?.({ phase: 'transferring', path: publicPath, bytesRead: chunk.length, bandwidthLimitBytesPerSecond: paced.limitBytesPerSecond, throttleWaitMilliseconds: paced.waitedMilliseconds });
      yield chunk;
    }
    const after = await this.fileSystem.lstat(absolutePath).catch(() => null);
    const digest = `sha256:${hash.digest('hex')}`;
    if (!after?.isFile() || after.isSymbolicLink() || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || String(after.dev) !== String(before.dev) || String(after.ino) !== String(before.ino) || sizeBytes !== member.sizeBytes || digest !== member.contentDigest) throw new InfluxDb3EnterpriseLegacySourceReaderError('INFLUXDB3_ENTERPRISE_LEGACY_MEDIA_CHANGED', 'InfluxDB 3 Enterprise legacy staged media changed during publication.', { category: 'integrity' });
  }

  async release(workspaceId, executionId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const id = requiredText(executionId, 'Backup execution ID', 200);
    const key = `${tenant}:${id}`;
    const promise = this.preparations.get(key);
    this.preparations.delete(key);
    if (!promise) return false;
    const prepared = await promise.catch(() => null);
    if (!prepared?.directory) return false;
    return this.#cleanupOwned(prepared.directory, tenant, id, prepared.owner.sourceId);
  }

  async reconcileRun(workspaceId, run = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const executionId = requiredText(run.id, 'Backup execution ID', 200);
    const prefix = preparationPrefix(tenant, executionId);
    const entries = await this.fileSystem.readdir(this.temporaryRoot, { withFileTypes: true }).catch((error) => error?.code === 'ENOENT' ? [] : Promise.reject(error));
    const candidates = entries.slice(0, MAX_STAGE_DIRECTORIES).filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix));
    let removed = 0;
    let proven = true;
    for (const entry of candidates) {
      const directory = path.join(this.temporaryRoot, entry.name);
      if (await this.#cleanupOwned(directory, tenant, executionId)) removed += 1;
      else proven = false;
    }
    return { applicable: candidates.length > 0, proven, removedTemporaryDirectories: removed, sourceMediaDeleted: false, repositoryMediaDeleted: false, sourceLease: run.sourceLease || null };
  }
}

module.exports = {
  ARTIFACT_KIND,
  InfluxDb3EnterpriseLegacySourceReaderError,
  InfluxDb3EnterpriseLegacySourceReaderService,
  MAX_METADATA_BYTES,
  MEDIA_PREFIX,
  METADATA_PATH,
  SOURCE_TIER,
  STAGE_KIND,
  exactLegacyConsistency,
  exactWholeClusterSelector,
  isLegacyFilesystemSource,
  normalizeLegacySourceExecution,
  normalizeLegacySourceStorage,
  preparationPrefix,
  publicMedia,
  publicMetadata,
  repositoryPath
};
