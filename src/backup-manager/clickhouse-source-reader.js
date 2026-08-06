const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { DatabaseAdapterError, digestJson } = require('./database-adapter');
const { ADAPTER_ID, normalizeBackupExecution } = require('./clickhouse');

const MAX_METADATA_BYTES = 16 * 1024 * 1024;

class ClickHouseSourceReaderError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'ClickHouseSourceReaderError';
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

class ClickHouseSourceReaderService {
  constructor({ controlDatabase, deviceId, adapterRegistry, adapter, connectionService, openRepository = null, temporaryRoot = path.join(os.tmpdir(), 'deployerx-clickhouse-backups'), fileSystem = fs } = {}) {
    if (!controlDatabase || !adapterRegistry || !adapter || !connectionService) throw new TypeError('ClickHouse source reader dependencies are required.');
    this.controlDatabase = controlDatabase;
    this.deviceId = requiredText(deviceId, 'Device ID', 200);
    this.adapterRegistry = adapterRegistry;
    this.adapter = adapter;
    this.connectionService = connectionService;
    this.openRepository = typeof openRepository === 'function' ? openRepository : null;
    this.temporaryRoot = path.resolve(requiredText(temporaryRoot, 'ClickHouse backup temporary root'));
    this.fileSystem = fileSystem;
    this.preparations = new Map();
  }

  async plan(workspaceId, sourceId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const source = await this.controlDatabase.repository('source').get(tenant, requiredText(sourceId, 'Source ID', 200));
    if (!source || source.sourceType !== 'database' || source.adapterId !== ADAPTER_ID || !source.enabled) throw new ClickHouseSourceReaderError('CLICKHOUSE_SOURCE_UNAVAILABLE', 'The ClickHouse Source is unavailable.');
    const selector = source.selector || {};
    if (selector.kind !== 'database-objects' || selector.allDatabases || selector.databases?.include?.length !== 1 || selector.databases?.exclude?.length || selector.schemas?.include?.length || selector.schemas?.exclude?.length || selector.tables?.exclude?.length || selector.includeGlobalObjects) throw new ClickHouseSourceReaderError('CLICKHOUSE_SOURCE_SELECTION_INVALID', 'The ClickHouse Source must contain one database and optional exact tables.', { category: 'compatibility' });
    if (source.consistency?.backupMethod !== 'physical' || source.consistency?.backupMode !== 'full' || !['auto', 'clickhouse-native-backup'].includes(source.consistency?.method) || source.consistency?.requestedLevel !== 'application' || source.consistency?.captureCoordinates !== true) throw new ClickHouseSourceReaderError('CLICKHOUSE_SOURCE_CONSISTENCY_INVALID', 'The ClickHouse Source must use native application-consistent full backup.', { category: 'compatibility' });
    const connection = await this.controlDatabase.repository('connection').get(tenant, source.connectionId);
    if (!connection || connection.adapterId !== ADAPTER_ID) throw new ClickHouseSourceReaderError('CLICKHOUSE_SOURCE_CONNECTION_MISSING', 'The ClickHouse connection is unavailable.');
    if (!(connection.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new ClickHouseSourceReaderError('CLICKHOUSE_SOURCE_OTHER_DEVICE', 'The ClickHouse Source belongs to another device.', { category: 'authorization' });
    if (connection.lastTest?.status !== 'success' || !connection.trust?.fingerprint || connection.trust.fingerprint !== connection.endpoint?.expectedDeploymentFingerprint || connection.trust.topologyFingerprint !== connection.endpoint?.expectedTopologyFingerprint) throw new ClickHouseSourceReaderError('CLICKHOUSE_SOURCE_CONNECTION_UNHEALTHY', 'Retest the ClickHouse connection before backup.', { category: 'connectivity', retryable: true });
    const execution = normalizeBackupExecution(source.physicalExecution);
    const destinationTrust = connection.clickhouseDestinationTrust;
    if (!destinationTrust || destinationTrust.diskName !== execution.diskName || destinationTrust.destinationFingerprint !== execution.destinationFingerprint || destinationTrust.deploymentFingerprint !== connection.trust.fingerprint || destinationTrust.topologyFingerprint !== connection.trust.topologyFingerprint) throw new ClickHouseSourceReaderError('CLICKHOUSE_DESTINATION_TRUST_CHANGED', 'Approve the ClickHouse backup disk again before backup.', { category: 'integrity' });
    const manifest = this.adapterRegistry.manifest(ADAPTER_ID);
    if (!manifest.executionReady) throw new ClickHouseSourceReaderError('CLICKHOUSE_EXECUTION_NOT_READY', 'ClickHouse backup execution is unavailable.', { category: 'compatibility' });
    return { source, connection, connectionConfig: this.connectionService.config(connection), manifest: { adapterId: manifest.adapterId, adapterVersion: manifest.adapterVersion, selectionDigest: selector.digest, sourceRevision: source.revision } };
  }

  async #writeOwner(ownerPath, owner) {
    const nextPath = `${ownerPath}.next`;
    await this.fileSystem.writeFile(nextPath, JSON.stringify(owner), { flag: 'w', mode: 0o600 });
    await this.fileSystem.rename(nextPath, ownerPath);
  }

  async #incrementalBase(workspaceId, plan, options) {
    if (options.backupMode === 'full') return null;
    if (options.backupMode !== 'incremental') throw new ClickHouseSourceReaderError('CLICKHOUSE_BACKUP_MODE_UNSUPPORTED', 'ClickHouse backup supports full and incremental modes only.', { category: 'compatibility' });
    if (!this.openRepository) throw new ClickHouseSourceReaderError('CLICKHOUSE_REPOSITORY_ACCESS_UNAVAILABLE', 'ClickHouse incremental chain authentication is unavailable.', { category: 'compatibility' });
    const previous = options.previousRecoveryPoint;
    if (!previous || previous.sourceId !== plan.source.id || previous.jobId !== options.jobId) throw new ClickHouseSourceReaderError('CLICKHOUSE_INCREMENTAL_BASE_REQUIRED', 'A previous RecoveryPoint from this exact ClickHouse Job is required for incremental backup.', { category: 'consistency' });
    const points = await this.controlDatabase.repository('recoveryPoint').list(workspaceId, { limit: 1000 });
    const byId = new Map(points.map((point) => [point.id, point]));
    byId.set(previous.id, previous);
    const newestFirst = [];
    const seen = new Set();
    let current = previous;
    while (current && newestFirst.length < 1000) {
      if (seen.has(current.id)) throw new ClickHouseSourceReaderError('CLICKHOUSE_INCREMENTAL_CHAIN_CYCLE', 'The ClickHouse incremental chain contains a cycle.', { category: 'integrity' });
      seen.add(current.id);
      if (current.sourceId !== plan.source.id || current.jobId !== options.jobId || !['full', 'incremental'].includes(current.type) || current.consistency !== 'application' || current.verification?.state !== 'succeeded' || current.retention?.deletionEligible === true || !Array.isArray(current.repositoryCopies)) throw new ClickHouseSourceReaderError('CLICKHOUSE_INCREMENTAL_CHAIN_UNAVAILABLE', 'Every ClickHouse incremental ancestor must be retained, verified, application-consistent, and available.', { category: 'integrity' });
      newestFirst.push(current);
      if (current.type === 'full') break;
      if (!current.parentRecoveryPointId) throw new ClickHouseSourceReaderError('CLICKHOUSE_INCREMENTAL_CHAIN_INCOMPLETE', 'The ClickHouse incremental chain has no full baseline.', { category: 'integrity' });
      current = byId.get(current.parentRecoveryPointId);
      if (!current) throw new ClickHouseSourceReaderError('CLICKHOUSE_INCREMENTAL_CHAIN_INCOMPLETE', 'A required ClickHouse incremental ancestor is missing.', { category: 'integrity' });
    }
    const chain = newestFirst.reverse();
    if (!chain.length || chain.length > 1000 || chain[0].type !== 'full' || chain[0].id !== (previous.chainRootId || chain[0].id) || chain.some((point, index) => index > 0 && point.parentRecoveryPointId !== chain[index - 1].id)) throw new ClickHouseSourceReaderError('CLICKHOUSE_INCREMENTAL_CHAIN_INVALID', 'The ClickHouse RecoveryPoint lineage is not a complete ordered chain.', { category: 'integrity' });
    const requestedRepositories = new Set((options.repositoryIds || []).map(String));
    const repositoryId = [...requestedRepositories].find((id) => chain.every((point) => point.repositoryCopies.some((copy) => copy.repositoryId === id && copy.state === 'available')));
    if (!repositoryId) throw new ClickHouseSourceReaderError('CLICKHOUSE_INCREMENTAL_REPOSITORY_UNAVAILABLE', 'No selected repository contains the complete ClickHouse incremental metadata chain.', { category: 'not-found' });
    const opened = await this.openRepository(workspaceId, repositoryId);
    const artifacts = await this.controlDatabase.repository('artifact').list(workspaceId, { limit: 5000 });
    const authenticated = [];
    for (let index = 0; index < chain.length; index += 1) {
      const point = chain[index];
      const prior = authenticated[index - 1] || null;
      const copy = point.repositoryCopies.find((item) => item.repositoryId === repositoryId && item.state === 'available');
      const artifact = artifacts.find((item) => item.recoveryPointId === point.id && item.repositoryId === repositoryId && item.kind === 'metadata' && item.metadata?.adapterId === ADAPTER_ID && item.metadata?.kind === 'clickhouse-native-backup');
      if (!artifact) throw new ClickHouseSourceReaderError('CLICKHOUSE_INCREMENTAL_ARTIFACT_MISSING', 'A required ClickHouse native metadata Artifact is missing.', { category: 'not-found' });
      const snapshot = await opened.engine.openSnapshot({}, { repositoryId, snapshotId: copy.engineSnapshotId, masterKey: opened.masterKey });
      if (snapshot.summary.manifestKey !== copy.manifestLocator || snapshot.summary.manifestChecksum?.digest !== copy.manifestChecksum?.digest) throw new ClickHouseSourceReaderError('CLICKHOUSE_INCREMENTAL_MANIFEST_CHANGED', 'A ClickHouse parent repository manifest no longer matches its RecoveryPoint.', { category: 'integrity' });
      const locatorPath = decodeURIComponent(String(artifact.locator || '').split('#').slice(1).join('#'));
      const file = (snapshot.manifest.files || []).find((candidate) => candidate.type === 'file' && candidate.path === locatorPath && candidate.metadata?.artifactKind === 'metadata' && candidate.metadata?.externalNativeMedia === true && candidate.metadata?.database?.adapterId === ADAPTER_ID);
      const metadata = file?.metadata?.database;
      const metadataDigest = metadata ? `sha256:${digestJson(metadata)}` : null;
      const expectedAncestors = chain.slice(0, index).map((item) => item.id);
      const expectedRoot = index ? chain[0].id : null;
      const destination = metadata?.destination;
      const operation = metadata?.operation;
      if (!file || file.sizeBytes !== artifact.sizeBytes || file.contentDigest?.digest !== artifact.checksum?.digest || digestJson(metadata) !== digestJson(artifact.metadata)
        || metadata.selectionDigest !== plan.source.selector.digest || metadata.sourceId !== plan.source.id || metadata.jobId !== options.jobId || metadata.deploymentFingerprint !== plan.source.physicalExecution.deploymentFingerprint || metadata.topologyFingerprint !== plan.source.physicalExecution.topologyFingerprint
        || metadata.backupMethod !== 'physical' || metadata.backupMode !== point.type || metadata.externalNativeMedia !== true || typeof metadata.restoreSupported !== 'boolean'
        || destination?.type !== 'disk' || destination.diskName !== plan.source.physicalExecution.diskName || destination.destinationFingerprint !== plan.source.physicalExecution.destinationFingerprint || !/^deployerx\/[0-9a-f]{16}\/deployerx-[0-9a-f]{32}[.]zip$/.test(String(destination.relativePath || ''))
        || !/^deployerx-[0-9a-f]{32}$/.test(String(operation?.id || '')) || !String(destination.relativePath).endsWith(`${operation.id}.zip`) || destination.backupName !== operation.name || operation.status !== 'BACKUP_CREATED' || operation.files < 1 || operation.entries < 1 || operation.totalBytes < 1
        || metadata.chain?.parentRecoveryPointId !== (prior ? point.parentRecoveryPointId : null) || metadata.chain?.chainRootRecoveryPointId !== expectedRoot || JSON.stringify(metadata.chain?.ancestorRecoveryPointIds || []) !== JSON.stringify(expectedAncestors)
        || (prior && (metadata.chain?.baseOperationId !== prior.operationId || metadata.chain?.baseRelativePath !== prior.relativePath || metadata.chain?.baseMetadataDigest !== prior.metadataDigest))) throw new ClickHouseSourceReaderError('CLICKHOUSE_INCREMENTAL_ARTIFACT_INVALID', 'Authenticated ClickHouse parent metadata is incomplete or inconsistent with its RecoveryPoint and native chain.', { category: 'integrity' });
      authenticated.push({ pointId: point.id, operationId: operation.id, relativePath: destination.relativePath, metadataDigest });
    }
    const base = authenticated.at(-1);
    return {
      version: 1, operationId: base.operationId, relativePath: base.relativePath, parentRecoveryPointId: previous.id,
      chainRootRecoveryPointId: chain[0].id, ancestorRecoveryPointIds: chain.map((point) => point.id), selectionDigest: plan.source.selector.digest,
      destinationFingerprint: plan.source.physicalExecution.destinationFingerprint, deploymentFingerprint: plan.source.physicalExecution.deploymentFingerprint,
      topologyFingerprint: plan.source.physicalExecution.topologyFingerprint, metadataDigest: base.metadataDigest
    };
  }

  async #prepare(workspaceId, executionId, plan, options) {
    let directory = null;
    try {
      const baseBackup = await this.#incrementalBase(workspaceId, plan, options);
      return await this.connectionService.withExecution(workspaceId, plan.connection, options.signal, async (context, connectionConfig) => {
        const effectiveConsistency = { ...plan.source.consistency, backupMode: options.backupMode };
        const prepared = await this.adapterRegistry.prepareBackup(ADAPTER_ID, context, {
          connection: connectionConfig,
          selector: plan.source.selector,
          consistency: effectiveConsistency,
          execution: { ...plan.source.physicalExecution, executionId, sourceId: plan.source.id, workspaceId, jobId: options.jobId, baseBackup }
        });
        if (prepared.consistency.evidence.serverIdentityFingerprint !== plan.connection.trust.fingerprint) throw new ClickHouseSourceReaderError('CLICKHOUSE_DEPLOYMENT_CHANGED', 'ClickHouse identity changed after the last successful connection test.', { category: 'integrity' });
        await this.fileSystem.mkdir(this.temporaryRoot, { recursive: true, mode: 0o700 });
        await this.fileSystem.chmod(this.temporaryRoot, 0o700).catch(() => {});
        directory = await this.fileSystem.mkdtemp(path.join(this.temporaryRoot, preparationPrefix(workspaceId, executionId)));
        await this.fileSystem.chmod(directory, 0o700).catch(() => {});
        const ownerPath = path.join(directory, '.owner.json');
        let owner = { version: 1, workspaceId, executionId, connectionId: plan.connection.id, clickhouseBackup: null };
        await this.fileSystem.writeFile(ownerPath, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
        const onOwnership = async (clickhouseBackup) => {
          owner = { ...owner, clickhouseBackup };
          await this.#writeOwner(ownerPath, owner);
        };
        const databaseManifest = await this.adapter.executeBackup({ ...context, signal: options.signal, onProgress: options.onProgress, onOwnership, planDigest: prepared.planDigest }, prepared.adapterPlan);
        const bytes = Buffer.from(JSON.stringify(databaseManifest));
        if (bytes.length < 1 || bytes.length > MAX_METADATA_BYTES) throw new ClickHouseSourceReaderError('CLICKHOUSE_METADATA_INVALID', 'ClickHouse backup metadata exceeds the supported size.', { category: 'integrity' });
        return { directory, bytes, prepared, databaseManifest };
      });
    } catch (error) {
      if (directory) {
        const owner = await this.fileSystem.readFile(path.join(directory, '.owner.json'), 'utf8').then(JSON.parse).catch(() => null);
        if (!owner?.clickhouseBackup) await this.fileSystem.rm(directory, { recursive: true, force: true }).catch(() => {});
      }
      if (error instanceof ClickHouseSourceReaderError) throw error;
      if (error instanceof DatabaseAdapterError || error?.code) throw new ClickHouseSourceReaderError(error.code || 'CLICKHOUSE_BACKUP_PREPARATION_FAILED', error.message, { category: error.category, retryable: error.retryable });
      throw new ClickHouseSourceReaderError('CLICKHOUSE_BACKUP_PREPARATION_FAILED', 'DeployerX could not prepare the native ClickHouse backup.', { retryable: true });
    }
  }

  async files(workspaceId, sourceId, options = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const executionId = requiredText(options.executionId, 'Backup execution ID', 200);
    const backupMode = options.backupMode || 'full';
    if (!['full', 'incremental'].includes(backupMode)) throw new ClickHouseSourceReaderError('CLICKHOUSE_BACKUP_MODE_UNSUPPORTED', 'ClickHouse backup supports full and incremental modes only.', { category: 'compatibility' });
    const plan = await this.plan(tenant, sourceId);
    const key = `${tenant}:${executionId}`;
    if (!this.preparations.has(key)) {
      const promise = this.#prepare(tenant, executionId, plan, { ...options, backupMode });
      promise.catch(() => this.preparations.delete(key));
      this.preparations.set(key, promise);
    }
    const prepared = await this.preparations.get(key);
    const artifactPath = prepared.prepared.adapterPlan.artifact.path;
    return {
      ...plan,
      manifest: { ...plan.manifest, workloadType: 'database', resumable: false, consistency: prepared.prepared.consistency, database: prepared.databaseManifest, artifactPath, artifactPaths: [artifactPath], sizeBytes: prepared.bytes.length, externalNativeMedia: true },
      create: async function* createClickHouseBackupMetadata() {
        yield { path: artifactPath, type: 'file', metadata: { workload: 'database', artifactKind: 'metadata', externalNativeMedia: true, database: prepared.databaseManifest }, content: (async function* content() { yield prepared.bytes; })() };
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
    let reconciledOperations = 0;
    let proven = true;
    for (const entry of entries.slice(0, 10000)) {
      if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
      const directory = path.join(this.temporaryRoot, entry.name);
      const owner = await this.fileSystem.readFile(path.join(directory, '.owner.json'), 'utf8').then(JSON.parse).catch(() => null);
      if (owner?.version !== 1 || owner.workspaceId !== tenant || owner.executionId !== executionId) continue;
      if (owner.clickhouseBackup) {
        const connection = await this.controlDatabase.repository('connection').get(tenant, owner.connectionId);
        if (!connection || connection.adapterId !== ADAPTER_ID) { proven = false; continue; }
        try {
          const result = await this.connectionService.withExecution(tenant, connection, null, (context, config) => this.adapter.reconcileBackup(context, { connection: config, owner: owner.clickhouseBackup }));
          if (!result.terminal || result.nativeMediaPreserved !== true) { proven = false; continue; }
          reconciledOperations += 1;
        } catch { proven = false; continue; }
      }
      await this.fileSystem.rm(directory, { recursive: true, force: true });
      removed += 1;
    }
    return { applicable: true, proven, removedTemporaryDirectories: removed, reconciledOperations, nativeMediaDeleted: false, sourceLease: run.sourceLease || null };
  }
}

module.exports = { ClickHouseSourceReaderError, ClickHouseSourceReaderService, MAX_METADATA_BYTES, preparationPrefix };
