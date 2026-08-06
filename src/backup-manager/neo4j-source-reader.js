const crypto = require('crypto');
const fsNative = require('fs');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { DatabaseAdapterError } = require('./database-adapter');
const { ADAPTER_ID, MAX_DUMP_BYTES, selectedDatabase, stableDigest, supportsFirstDifferentialOverlap } = require('./neo4j');

class Neo4jSourceReaderError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'Neo4jSourceReaderError';
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

function preparationPrefix(workspaceId, executionId) {
  return `run-${crypto.createHash('sha256').update(`${workspaceId}\0${executionId}`).digest('hex').slice(0, 32)}-`;
}

class Neo4jSourceReaderService {
  constructor({ controlDatabase, deviceId, adapterRegistry, adapter, connectionService, openRepository = null, temporaryRoot = path.join(os.tmpdir(), 'deployerx-neo4j-backups'), fileSystem = fs, createReadStream = fsNative.createReadStream } = {}) {
    if (!controlDatabase || !adapterRegistry || !adapter || !connectionService) throw new TypeError('Neo4j source reader dependencies are required.');
    this.controlDatabase = controlDatabase;
    this.deviceId = requiredText(deviceId, 'Device ID', 200);
    this.adapterRegistry = adapterRegistry;
    this.adapter = adapter;
    this.connectionService = connectionService;
    this.openRepository = openRepository;
    this.temporaryRoot = path.resolve(requiredText(temporaryRoot, 'Neo4j temporary root'));
    this.fileSystem = fileSystem;
    this.createReadStream = createReadStream;
    this.preparations = new Map();
  }

  async plan(workspaceId, sourceId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const source = await this.controlDatabase.repository('source').get(tenant, requiredText(sourceId, 'Source ID', 200));
    if (!source || source.sourceType !== 'database' || source.adapterId !== ADAPTER_ID || !source.enabled) throw new Neo4jSourceReaderError('NEO4J_SOURCE_UNAVAILABLE', 'The Neo4j source is unavailable.');
    const databaseName = selectedDatabase(source.selector);
    const online = source.physicalExecution?.tier === 'enterprise-online';
    if (source.consistency?.backupMethod !== 'physical' || source.consistency?.requestedLevel !== 'application'
      || (online && (source.consistency.method !== 'neo4j-native-backup' || !['full', 'differential'].includes(source.consistency.backupMode) || source.consistency.captureCoordinates !== true))
      || (!online && (source.consistency.method !== 'offline' || source.consistency.backupMode !== 'full' || source.consistency.captureCoordinates))) throw new Neo4jSourceReaderError('NEO4J_SOURCE_CONSISTENCY_INVALID', online ? 'Neo4j Enterprise online backup requires native full or differential application consistency with coordinate capture.' : 'Neo4j offline backup requires physical full mode with explicit offline application consistency.', { category: 'consistency' });
    const connection = await this.controlDatabase.repository('connection').get(tenant, source.connectionId);
    if (!connection || connection.adapterId !== ADAPTER_ID) throw new Neo4jSourceReaderError('NEO4J_SOURCE_CONNECTION_MISSING', 'The Neo4j source connection is unavailable.');
    if (!(connection.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new Neo4jSourceReaderError('NEO4J_SOURCE_OTHER_DEVICE', 'The Neo4j source belongs to another device.', { category: 'authorization' });
    if (connection.lastTest?.status !== 'success' || !connection.trust?.fingerprint) throw new Neo4jSourceReaderError('NEO4J_SOURCE_CONNECTION_UNHEALTHY', 'Test the Neo4j connection successfully before running a backup.', { category: 'connectivity', retryable: true });
    if (online) {
      const execution = source.physicalExecution;
      const identity = connection.lastTest.endpointIdentity;
      if (typeof this.openRepository !== 'function') throw new Neo4jSourceReaderError('NEO4J_REPOSITORY_ACCESS_UNAVAILABLE', 'Neo4j differential chain access is unavailable.', { category: 'compatibility' });
      if (execution.engine !== 'neo4j' || execution.databaseName !== databaseName || execution.connectionRevision !== connection.revision || execution.databaseId === undefined
        || identity?.edition !== 'enterprise' || identity.deploymentFingerprint !== execution.deploymentFingerprint || identity.topologyFingerprint !== execution.topologyFingerprint
        || connection.trust.fingerprint !== execution.deploymentFingerprint || connection.trust.topologyFingerprint !== execution.topologyFingerprint) throw new Neo4jSourceReaderError('NEO4J_DATABASE_IDENTITY_CHANGED', 'The Neo4j Enterprise deployment changed after the Source was saved.', { category: 'integrity' });
    }
    const manifest = this.adapterRegistry.manifest(ADAPTER_ID);
    if (!manifest.executionReady) throw new Neo4jSourceReaderError('NEO4J_EXECUTION_NOT_READY', 'Neo4j backup execution is unavailable.', { category: 'compatibility' });
    return {
      source, online,
      connection,
      connectionConfig: this.connectionService.config(connection),
      manifest: { adapterId: manifest.adapterId, adapterVersion: manifest.adapterVersion, selectionDigest: source.selector.digest, sourceRevision: source.revision }
    };
  }

  async #onlineParents(workspaceId, plan, options) {
    if (options.backupMode === 'full') return [];
    if (options.backupMode !== 'differential') throw new Neo4jSourceReaderError('NEO4J_BACKUP_MODE_UNSUPPORTED', 'Neo4j Enterprise online backup supports full and differential modes only.', { category: 'compatibility' });
    const previous = options.previousRecoveryPoint;
    if (!previous || previous.sourceId !== plan.source.id || previous.jobId !== options.jobId) throw new Neo4jSourceReaderError('NEO4J_DIFFERENTIAL_PARENT_REQUIRED', 'A previous RecoveryPoint from this exact Neo4j Job is required for differential backup.', { category: 'consistency' });
    const points = await this.controlDatabase.repository('recoveryPoint').list(workspaceId, { limit: 1000 });
    const byId = new Map(points.map((point) => [point.id, point]));
    byId.set(previous.id, previous);
    const newestFirst = [];
    const seen = new Set();
    let current = previous;
    while (current) {
      if (seen.has(current.id) || newestFirst.length >= 1000) throw new Neo4jSourceReaderError('NEO4J_DIFFERENTIAL_CHAIN_INVALID', 'The Neo4j differential chain is cyclic or exceeds the supported length.', { category: 'integrity' });
      seen.add(current.id);
      if (current.sourceId !== plan.source.id || current.jobId !== options.jobId || !['full', 'differential'].includes(current.type) || current.consistency !== 'application'
        || current.verification?.state !== 'succeeded' || current.retention?.deletionEligible === true || !Array.isArray(current.repositoryCopies)) throw new Neo4jSourceReaderError('NEO4J_DIFFERENTIAL_CHAIN_UNAVAILABLE', 'Every Neo4j differential ancestor must be retained, verified, application-consistent, and available.', { category: 'integrity' });
      newestFirst.push(current);
      if (current.type === 'full') break;
      if (!current.parentRecoveryPointId) throw new Neo4jSourceReaderError('NEO4J_DIFFERENTIAL_CHAIN_INCOMPLETE', 'The Neo4j differential chain has no full baseline.', { category: 'integrity' });
      current = byId.get(current.parentRecoveryPointId);
      if (!current) throw new Neo4jSourceReaderError('NEO4J_DIFFERENTIAL_CHAIN_INCOMPLETE', 'A required Neo4j differential ancestor is missing.', { category: 'integrity' });
    }
    const chain = newestFirst.reverse();
    const root = chain[0];
    if (root?.type !== 'full' || root.id !== (previous.chainRootId || root.id) || chain.some((point, index) => index > 0 && point.parentRecoveryPointId !== chain[index - 1].id)) throw new Neo4jSourceReaderError('NEO4J_DIFFERENTIAL_CHAIN_INVALID', 'The Neo4j RecoveryPoint lineage is not a complete ordered chain.', { category: 'integrity' });
    const requestedRepositories = new Set((options.repositoryIds || []).map(String));
    const repositoryId = [...requestedRepositories].find((id) => chain.every((point) => point.repositoryCopies.some((copy) => copy.repositoryId === id && copy.state === 'available')));
    if (!repositoryId) throw new Neo4jSourceReaderError('NEO4J_DIFFERENTIAL_REPOSITORY_UNAVAILABLE', 'No selected repository contains the complete Neo4j differential parent chain.', { category: 'not-found' });
    const opened = await this.openRepository(workspaceId, repositoryId);
    const artifacts = await this.controlDatabase.repository('artifact').list(workspaceId, { limit: 5000 });
    const parents = [];
    let prior = null;
    for (const point of chain) {
      const copy = point.repositoryCopies.find((item) => item.repositoryId === repositoryId && item.state === 'available');
      const artifact = artifacts.find((item) => item.recoveryPointId === point.id && item.repositoryId === repositoryId && item.kind === 'physical-backup' && item.metadata?.adapterId === ADAPTER_ID && item.metadata?.kind === 'neo4j-enterprise-backup');
      if (!artifact) throw new Neo4jSourceReaderError('NEO4J_DIFFERENTIAL_ARTIFACT_MISSING', 'A required Neo4j native parent Artifact is missing.', { category: 'not-found' });
      const snapshot = await opened.engine.openSnapshot({}, { repositoryId, snapshotId: copy.engineSnapshotId, masterKey: opened.masterKey });
      if (snapshot.summary.manifestKey !== copy.manifestLocator || snapshot.summary.manifestChecksum?.digest !== copy.manifestChecksum?.digest) throw new Neo4jSourceReaderError('NEO4J_DIFFERENTIAL_MANIFEST_CHANGED', 'A Neo4j parent repository manifest no longer matches its RecoveryPoint.', { category: 'integrity' });
      const locatorPath = decodeURIComponent(String(artifact.locator || '').split('#').slice(1).join('#'));
      const file = (snapshot.manifest.files || []).find((candidate) => candidate.type === 'file' && candidate.path === locatorPath && candidate.metadata?.artifactKind === 'physical-backup' && candidate.metadata?.database?.adapterId === ADAPTER_ID);
      const metadata = file?.metadata?.database;
      if (!file || file.sizeBytes !== artifact.sizeBytes || file.contentDigest?.digest !== artifact.checksum?.digest || stableDigest(metadata) !== stableDigest(artifact.metadata)
        || metadata.selectionDigest !== plan.source.selector.digest || metadata.source?.deploymentFingerprint !== plan.source.physicalExecution.deploymentFingerprint || metadata.source?.topologyFingerprint !== plan.source.physicalExecution.topologyFingerprint
        || metadata.database?.name !== plan.source.physicalExecution.databaseName || metadata.database?.databaseId !== plan.source.physicalExecution.databaseId
        || metadata.edition !== 'enterprise' || metadata.productVersion !== plan.source.physicalExecution.productVersion || metadata.metadataScope !== (plan.source.selector.includeGlobalObjects ? 'database-store-and-rbac' : 'database-store-only-no-rbac')
        || metadata.artifact?.path !== file.path || metadata.artifact?.sizeBytes !== file.sizeBytes || !/^sha256:[0-9a-f]{64}$/.test(String(metadata.artifact?.contentDigest || ''))
        || metadata.artifact?.nativeKind !== 'neo4j-backup' || !/^sha256:[0-9a-f]{64}$/.test(String(metadata.artifact?.inspectionDigest || '')) || !/^[A-Za-z0-9._+-]+$/.test(String(metadata.artifact?.storeFormat || ''))
        || metadata.backupMode !== point.type || (point.type === 'full' && metadata.chain?.parentRecoveryPointId) || (point.type === 'differential' && (metadata.chain?.parentRecoveryPointId !== point.parentRecoveryPointId || metadata.chain?.chainRootRecoveryPointId !== point.chainRootId))) throw new Neo4jSourceReaderError('NEO4J_DIFFERENTIAL_ARTIFACT_INVALID', 'Authenticated Neo4j parent metadata is incomplete or inconsistent with its RecoveryPoint.', { category: 'integrity' });
      const range = metadata.transactionRange;
      if (!Number.isSafeInteger(range?.lowestTransactionId) || !Number.isSafeInteger(range?.highestTransactionId) || range.lowestTransactionId < 0 || range.highestTransactionId < range.lowestTransactionId) throw new Neo4jSourceReaderError('NEO4J_DIFFERENTIAL_RANGE_INVALID', 'A Neo4j parent has invalid transaction-range evidence.', { category: 'integrity' });
      const firstDifferentialOverlap = prior?.backupMode === 'full' && supportsFirstDifferentialOverlap(metadata.productVersion);
      const contiguous = !prior || (firstDifferentialOverlap ? range.lowestTransactionId <= prior.highestTransactionId + 1 : range.lowestTransactionId === prior.highestTransactionId + 1);
      if (prior && (metadata.artifact.storeFormat !== prior.storeFormat || !contiguous || range.highestTransactionId < prior.highestTransactionId)) throw new Neo4jSourceReaderError('NEO4J_DIFFERENTIAL_CHAIN_GAP', 'The authenticated Neo4j parent chain is discontinuous.', { category: 'integrity' });
      const fileName = String(metadata.artifact.nativeFileName || '');
      if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*[.]backup$/.test(fileName) || fileName.includes('..') || parents.some((parent) => parent.fileName === fileName)) throw new Neo4jSourceReaderError('NEO4J_DIFFERENTIAL_FILENAME_INVALID', 'A Neo4j parent has an unsafe or duplicate native filename.', { category: 'integrity' });
      const parent = {
        pointId: point.id, fileName, sizeBytes: file.sizeBytes, contentDigest: metadata.artifact.contentDigest,
        databaseId: metadata.database.databaseId, backupMode: metadata.backupMode, storeFormat: metadata.artifact.storeFormat,
        highestTransactionId: range.highestTransactionId,
        open: async () => opened.engine.streamFile({}, { repositoryId, manifest: snapshot.manifest, masterKey: opened.masterKey, path: file.path })
      };
      parents.push(parent);
      prior = parent;
    }
    return parents;
  }

  async #prepare(workspaceId, executionId, plan, options) {
    let directory = null;
    try {
      await this.fileSystem.mkdir(this.temporaryRoot, { recursive: true, mode: 0o700 });
      await this.fileSystem.chmod(this.temporaryRoot, 0o700).catch(() => {});
      directory = await this.fileSystem.mkdtemp(path.join(this.temporaryRoot, preparationPrefix(workspaceId, executionId)));
      await this.fileSystem.chmod(directory, 0o700).catch(() => {});
      await this.fileSystem.writeFile(path.join(directory, '.owner.json'), JSON.stringify({ version: 1, workspaceId, executionId }), { flag: 'wx', mode: 0o600 });
      const parents = plan.online ? await this.#onlineParents(workspaceId, plan, options) : [];
      return await this.connectionService.withExecution(workspaceId, plan.connection, options.signal, async (context, connectionConfig) => {
        const effectiveConsistency = plan.online ? { ...plan.source.consistency, backupMode: options.backupMode } : plan.source.consistency;
        const prepared = await this.adapterRegistry.prepareBackup(ADAPTER_ID, { ...context, onProgress: options.onProgress }, {
          connection: connectionConfig,
          selector: plan.source.selector,
          consistency: effectiveConsistency,
          execution: plan.source.physicalExecution
        });
        if (prepared.consistency.evidence.serverIdentityFingerprint !== plan.connection.trust.fingerprint) throw new Neo4jSourceReaderError('NEO4J_DATABASE_IDENTITY_CHANGED', 'The Neo4j deployment identity changed after its last successful connection test.', { category: 'integrity' });
        const databaseName = selectedDatabase(plan.source.selector);
        const filePath = path.join(directory, plan.online ? `${databaseName}.backup` : `${databaseName}.dump`);
        const media = await this.adapter.createBackupMedia({ ...context, runId: executionId, onProgress: options.onProgress }, prepared.adapterPlan, filePath, { parents });
        if (!Number.isSafeInteger(media.sizeBytes) || media.sizeBytes < 1 || media.sizeBytes > MAX_DUMP_BYTES) throw new Neo4jSourceReaderError('NEO4J_DUMP_LIMIT_EXCEEDED', 'The Neo4j dump exceeds the supported temporary-storage limit.', { category: 'capacity' });
        if (plan.online) {
          const actualFull = media.backupMode === 'full';
          const previous = options.previousRecoveryPoint || null;
          const artifactPath = `neo4j/${media.nativeFileName}`;
          const databaseManifest = {
            version: 1,
            kind: 'neo4j-enterprise-backup',
            adapterId: ADAPTER_ID,
            adapterVersion: prepared.adapterVersion,
            engine: 'neo4j',
            backupMethod: 'physical',
            backupMode: media.backupMode,
            requestedBackupMode: options.requestedBackupMode || options.backupMode,
            selection: plan.source.selector,
            selectionDigest: plan.source.selector.digest,
            consistency: { ...prepared.consistency, backupMode: media.backupMode },
            source: { deploymentFingerprint: media.deploymentFingerprint, topologyFingerprint: media.topologyFingerprint },
            database: media.database,
            edition: media.edition,
            productVersion: media.version,
            metadataScope: media.metadataScope,
            transactionRange: {
              backupTime: media.inspection.backupTime,
              lowestTransactionId: media.inspection.lowestTransactionId,
              highestTransactionId: media.inspection.highestTransactionId
            },
            chain: {
              parentRecoveryPointId: actualFull ? null : previous.id,
              chainRootRecoveryPointId: actualFull ? null : previous.chainRootId || previous.id,
              materializedParentRecoveryPointIds: actualFull ? [] : parents.map((parent) => parent.pointId)
            },
            nativeTools: prepared.consistency.evidence.nativeTools,
            warnings: prepared.consistency.evidence.warnings,
            artifact: { kind: 'physical-backup', nativeKind: 'neo4j-backup', path: artifactPath, nativeFileName: media.nativeFileName, mediaType: prepared.adapterPlan.artifact.mediaType, sizeBytes: media.sizeBytes, contentDigest: media.digest, inspectionDigest: media.inspectionDigest, storeFormat: media.inspection.storeFormat }
          };
          return { directory, filePath, sizeBytes: media.sizeBytes, prepared, databaseManifest, artifactPath, artifactKind: 'physical-backup', noChange: media.noChange };
        }
        const databaseManifest = {
          version: 1,
          kind: 'neo4j-offline-dump',
          adapterId: ADAPTER_ID,
          adapterVersion: prepared.adapterVersion,
          engine: 'neo4j',
          selection: plan.source.selector,
          selectionDigest: plan.source.selector.digest,
          consistency: prepared.consistency,
          source: { deploymentFingerprint: media.deploymentFingerprint, topologyFingerprint: media.topologyFingerprint },
          database: media.database,
          edition: media.edition,
          productVersion: media.version,
          metadataScope: media.metadataScope,
          nativeTools: prepared.consistency.evidence.nativeTools,
          warnings: prepared.consistency.evidence.warnings,
          artifact: { kind: 'database-dump', path: prepared.adapterPlan.artifact.path, mediaType: prepared.adapterPlan.artifact.mediaType, sizeBytes: media.sizeBytes, contentDigest: media.digest, inspectionDigest: media.inspectionDigest, storeFormat: media.storeFormat }
        };
        return { directory, filePath, sizeBytes: media.sizeBytes, prepared, databaseManifest, artifactPath: prepared.adapterPlan.artifact.path, artifactKind: 'database-dump', noChange: false };
      });
    } catch (error) {
      if (directory) await this.fileSystem.rm(directory, { recursive: true, force: true }).catch(() => {});
      if (error instanceof Neo4jSourceReaderError) throw error;
      if (error instanceof DatabaseAdapterError || error?.code) throw new Neo4jSourceReaderError(error.code || 'NEO4J_BACKUP_PREPARATION_FAILED', error.message, { category: error.category, retryable: error.retryable });
      throw new Neo4jSourceReaderError('NEO4J_BACKUP_PREPARATION_FAILED', 'DeployerX could not prepare the Neo4j backup.', { retryable: true });
    }
  }

  async files(workspaceId, sourceId, options = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const executionId = requiredText(options.executionId, 'Backup execution ID', 200);
    const plan = await this.plan(tenant, sourceId);
    const backupMode = options.backupMode || 'full';
    if ((!plan.online && backupMode !== 'full') || (plan.online && !['full', 'differential'].includes(backupMode))) throw new Neo4jSourceReaderError('NEO4J_BACKUP_MODE_UNSUPPORTED', plan.online ? 'Neo4j Enterprise online backup supports full and differential recovery points only.' : 'Neo4j offline dump supports full recovery points only.', { category: 'compatibility' });
    const key = `${tenant}:${executionId}`;
    if (!this.preparations.has(key)) {
      const promise = this.#prepare(tenant, executionId, plan, options);
      promise.catch(() => this.preparations.delete(key));
      this.preparations.set(key, promise);
    }
    const prepared = await this.preparations.get(key);
    const createReadStream = this.createReadStream;
    const onProgress = options.onProgress;
    const bandwidthLimiter = options.bandwidthLimiter;
    const signal = options.signal;
    const artifactPath = prepared.artifactPath;
    const content = () => (async function* readDump() {
      for await (const rawChunk of createReadStream(prepared.filePath, { highWaterMark: 64 * 1024, signal })) {
        if (signal?.aborted) throw new Neo4jSourceReaderError('NEO4J_BACKUP_CANCELED', 'The Neo4j backup was canceled.', { category: 'canceled' });
        const chunk = Buffer.from(rawChunk);
        const paced = bandwidthLimiter ? await bandwidthLimiter.consume(chunk.length) : { limitBytesPerSecond: null, waitedMilliseconds: 0 };
        await onProgress?.({ phase: 'transferring', path: artifactPath, bytesRead: chunk.length, bandwidthLimitBytesPerSecond: paced.limitBytesPerSecond, throttleWaitMilliseconds: paced.waitedMilliseconds });
        yield chunk;
      }
    })();
    return {
      ...plan,
      manifest: { ...plan.manifest, workloadType: 'database', resumable: false, consistency: prepared.databaseManifest.consistency, database: prepared.databaseManifest, artifactPath, sizeBytes: prepared.sizeBytes, noChange: prepared.noChange === true },
      create: async function* createNeo4jFiles() {
        if (!prepared.noChange) yield { path: artifactPath, type: 'file', metadata: { workload: 'database', artifactKind: prepared.artifactKind, database: prepared.databaseManifest }, content: content() };
      }
    };
  }

  async release(workspaceId, executionId) {
    const key = `${requiredText(workspaceId, 'Workspace ID', 200)}:${requiredText(executionId, 'Backup execution ID', 200)}`;
    const promise = this.preparations.get(key);
    this.preparations.delete(key);
    if (!promise) return false;
    const prepared = await promise.catch(() => null);
    if (prepared?.directory) await this.fileSystem.rm(prepared.directory, { recursive: true, force: true }).catch(() => {});
    return true;
  }

  async reconcileRun(workspaceId, run = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const executionId = requiredText(run.id, 'Backup execution ID', 200);
    const prefix = preparationPrefix(tenant, executionId);
    const entries = await this.fileSystem.readdir(this.temporaryRoot, { withFileTypes: true }).catch((error) => error?.code === 'ENOENT' ? [] : Promise.reject(error));
    let removed = 0;
    for (const entry of entries.slice(0, 10000)) {
      if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
      const directory = path.join(this.temporaryRoot, entry.name);
      const owner = await this.fileSystem.readFile(path.join(directory, '.owner.json'), 'utf8').then(JSON.parse).catch(() => null);
      if (owner?.version !== 1 || owner.workspaceId !== tenant || owner.executionId !== executionId) continue;
      await this.fileSystem.rm(directory, { recursive: true, force: true });
      removed += 1;
    }
    return { applicable: true, proven: true, removedTemporaryDirectories: removed, sourceLease: run.sourceLease || null };
  }
}

module.exports = { Neo4jSourceReaderError, Neo4jSourceReaderService, preparationPrefix };
