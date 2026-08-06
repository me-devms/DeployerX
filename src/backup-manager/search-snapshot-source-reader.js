const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { DatabaseAdapterError } = require('./database-adapter');
const { ADAPTER_ID } = require('./search-snapshot');

const MAX_METADATA_BYTES = 16 * 1024 * 1024;

class SearchSnapshotSourceReaderError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'SearchSnapshotSourceReaderError';
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

class SearchSnapshotSourceReaderService {
  constructor({ controlDatabase, secretStore, deviceId, adapterRegistry, adapter, temporaryRoot = path.join(os.tmpdir(), 'deployerx-search-snapshots'), fileSystem = fs } = {}) {
    if (!controlDatabase || !secretStore || !adapterRegistry || !adapter) throw new TypeError('Search snapshot source reader dependencies are required.');
    this.controlDatabase = controlDatabase;
    this.secretStore = secretStore;
    this.deviceId = requiredText(deviceId, 'Device ID', 200);
    this.adapterRegistry = adapterRegistry;
    this.adapter = adapter;
    this.temporaryRoot = path.resolve(requiredText(temporaryRoot, 'Search snapshot temporary root'));
    this.fileSystem = fileSystem;
    this.preparations = new Map();
  }

  async plan(workspaceId, sourceId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const source = await this.controlDatabase.repository('source').get(tenant, requiredText(sourceId, 'Source ID', 200));
    if (!source || source.sourceType !== 'database' || source.adapterId !== ADAPTER_ID || !source.enabled) throw new SearchSnapshotSourceReaderError('SEARCH_SOURCE_UNAVAILABLE', 'The search snapshot Source is unavailable.');
    if (source.selector?.kind !== 'database-objects' || (!source.selector.allDatabases && !source.selector.databases?.include?.length) || source.selector.schemas?.include?.length || source.selector.schemas?.exclude?.length || source.selector.tables?.include?.length || source.selector.tables?.exclude?.length) throw new SearchSnapshotSourceReaderError('SEARCH_SOURCE_SELECTION_INVALID', 'The search snapshot Source has an invalid index or data-stream selection.', { category: 'compatibility' });
    if (source.consistency?.backupMethod !== 'physical' || source.consistency?.backupMode !== 'native' || !['auto', 'search-native-snapshot'].includes(source.consistency?.method) || source.consistency?.requestedLevel !== 'crash' || source.consistency?.captureCoordinates !== true) throw new SearchSnapshotSourceReaderError('SEARCH_SOURCE_CONSISTENCY_INVALID', 'The search snapshot Source must use native crash-consistent snapshot execution.', { category: 'compatibility' });
    const connection = await this.controlDatabase.repository('connection').get(tenant, source.connectionId);
    if (!connection || connection.adapterId !== ADAPTER_ID) throw new SearchSnapshotSourceReaderError('SEARCH_SOURCE_CONNECTION_MISSING', 'The search snapshot connection is unavailable.');
    if (!(connection.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new SearchSnapshotSourceReaderError('SEARCH_SOURCE_OTHER_DEVICE', 'The search snapshot Source belongs to another device.', { category: 'authorization' });
    if (connection.lastTest?.status !== 'success' || !connection.trust?.fingerprint) throw new SearchSnapshotSourceReaderError('SEARCH_SOURCE_CONNECTION_UNHEALTHY', 'Test the search snapshot connection successfully before backup.', { category: 'connectivity', retryable: true });
    const execution = source.physicalExecution || {};
    const repositoryTrust = (Array.isArray(connection.repositoryTrusts) ? connection.repositoryTrusts : []).find((item) => item.repositoryName === execution.repositoryName);
    if (!repositoryTrust || repositoryTrust.repositoryFingerprint !== execution.repositoryFingerprint || repositoryTrust.writerClusterUuid !== connection.endpoint.expectedClusterUuid || execution.clusterUuid !== connection.endpoint.expectedClusterUuid || execution.product !== connection.endpoint.expectedProduct) throw new SearchSnapshotSourceReaderError('SEARCH_REPOSITORY_TRUST_CHANGED', 'Verify the selected search snapshot repository again before backup.', { category: 'integrity' });
    const [credentialSecretRefId] = connection.secretRefIds || [];
    const connectionConfig = this.adapter.normalizeConfig({ ...connection.endpoint, credentialSecretRefId });
    const manifest = this.adapterRegistry.manifest(ADAPTER_ID);
    if (!manifest.executionReady) throw new SearchSnapshotSourceReaderError('SEARCH_EXECUTION_NOT_READY', 'Search snapshot execution is unavailable.', { category: 'compatibility' });
    return { source, connection, connectionConfig, manifest: { adapterId: manifest.adapterId, adapterVersion: manifest.adapterVersion, selectionDigest: source.selector.digest, sourceRevision: source.revision } };
  }

  async #writeOwner(ownerPath, owner) {
    const nextPath = `${ownerPath}.next`;
    await this.fileSystem.writeFile(nextPath, JSON.stringify(owner), { flag: 'w', mode: 0o600 });
    await this.fileSystem.rename(nextPath, ownerPath);
  }

  async #prepare(workspaceId, executionId, plan, options) {
    let directory = null;
    try {
      const resolveSecret = (secretRefId) => this.secretStore.resolve({ workspaceId, id: secretRefId });
      const prepared = await this.adapterRegistry.prepareBackup(ADAPTER_ID, { resolveSecret, signal: options.signal }, {
        connection: plan.connectionConfig,
        selector: plan.source.selector,
        consistency: plan.source.consistency,
        execution: { ...plan.source.physicalExecution, executionId, sourceId: plan.source.id, workspaceId }
      });
      if (prepared.consistency.evidence.serverIdentityFingerprint !== plan.connection.trust.fingerprint) throw new SearchSnapshotSourceReaderError('SEARCH_CLUSTER_IDENTITY_CHANGED', 'Search cluster identity changed after the last successful connection test.', { category: 'integrity' });
      await this.fileSystem.mkdir(this.temporaryRoot, { recursive: true, mode: 0o700 });
      await this.fileSystem.chmod(this.temporaryRoot, 0o700).catch(() => {});
      directory = await this.fileSystem.mkdtemp(path.join(this.temporaryRoot, preparationPrefix(workspaceId, executionId)));
      await this.fileSystem.chmod(directory, 0o700).catch(() => {});
      const ownerPath = path.join(directory, '.owner.json');
      let owner = { version: 1, workspaceId, executionId, connectionId: plan.connection.id, searchSnapshot: null };
      await this.fileSystem.writeFile(ownerPath, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
      const onOwnership = async (snapshotOwner) => {
        owner = { ...owner, searchSnapshot: snapshotOwner };
        await this.#writeOwner(ownerPath, owner);
      };
      const databaseManifest = await this.adapter.executeBackup({ resolveSecret, signal: options.signal, onProgress: options.onProgress, onOwnership, planDigest: prepared.planDigest }, prepared.adapterPlan);
      const bytes = Buffer.from(JSON.stringify(databaseManifest));
      if (bytes.length < 1 || bytes.length > MAX_METADATA_BYTES) throw new SearchSnapshotSourceReaderError('SEARCH_METADATA_INVALID', 'Search snapshot metadata exceeds the supported size.', { category: 'integrity' });
      return { directory, bytes, prepared, databaseManifest };
    } catch (error) {
      if (directory) {
        const owner = await this.fileSystem.readFile(path.join(directory, '.owner.json'), 'utf8').then(JSON.parse).catch(() => null);
        if (!owner?.searchSnapshot) await this.fileSystem.rm(directory, { recursive: true, force: true }).catch(() => {});
      }
      if (error instanceof SearchSnapshotSourceReaderError) throw error;
      if (error instanceof DatabaseAdapterError || error?.code) throw new SearchSnapshotSourceReaderError(error.code || 'SEARCH_BACKUP_PREPARATION_FAILED', error.message, { category: error.category, retryable: error.retryable });
      throw new SearchSnapshotSourceReaderError('SEARCH_BACKUP_PREPARATION_FAILED', 'DeployerX could not prepare the native search snapshot.', { retryable: true });
    }
  }

  async files(workspaceId, sourceId, options = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const executionId = requiredText(options.executionId, 'Backup execution ID', 200);
    if (options.backupMode && options.backupMode !== 'native') throw new SearchSnapshotSourceReaderError('SEARCH_BACKUP_MODE_UNSUPPORTED', 'Search backup supports native snapshot mode only.', { category: 'compatibility' });
    const plan = await this.plan(tenant, sourceId);
    const key = `${tenant}:${executionId}`;
    if (!this.preparations.has(key)) {
      const promise = this.#prepare(tenant, executionId, plan, options);
      promise.catch(() => this.preparations.delete(key));
      this.preparations.set(key, promise);
    }
    const prepared = await this.preparations.get(key);
    const bytes = prepared.bytes;
    const artifactPath = prepared.prepared.adapterPlan.artifact.path;
    return {
      ...plan,
      manifest: {
        ...plan.manifest,
        workloadType: 'database',
        resumable: false,
        consistency: prepared.prepared.consistency,
        database: prepared.databaseManifest,
        artifactPath,
        artifactPaths: [artifactPath],
        sizeBytes: bytes.length,
        externalNativeMedia: true
      },
      create: async function* createSearchSnapshotMetadata() {
        yield {
          path: artifactPath,
          type: 'file',
          metadata: { workload: 'database', artifactKind: 'metadata', externalNativeMedia: true, database: prepared.databaseManifest },
          content: (async function* content() { yield bytes; })()
        };
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
    let reconciledSnapshots = 0;
    let proven = true;
    for (const entry of entries.slice(0, 10000)) {
      if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
      const directory = path.join(this.temporaryRoot, entry.name);
      const owner = await this.fileSystem.readFile(path.join(directory, '.owner.json'), 'utf8').then(JSON.parse).catch(() => null);
      if (owner?.version !== 1 || owner.workspaceId !== tenant || owner.executionId !== executionId) continue;
      if (owner.searchSnapshot) {
        const connection = await this.controlDatabase.repository('connection').get(tenant, owner.connectionId);
        if (!connection || connection.adapterId !== ADAPTER_ID) { proven = false; continue; }
        const [credentialSecretRefId] = connection.secretRefIds || [];
        try {
          await this.adapter.reconcileSnapshot({ resolveSecret: (id) => this.secretStore.resolve({ workspaceId: tenant, id }) }, { connection: this.adapter.normalizeConfig({ ...connection.endpoint, credentialSecretRefId }), owner: owner.searchSnapshot });
          reconciledSnapshots += 1;
        } catch { proven = false; continue; }
      }
      await this.fileSystem.rm(directory, { recursive: true, force: true });
      removed += 1;
    }
    return { applicable: true, proven, removedTemporaryDirectories: removed, reconciledSnapshots, sourceLease: run.sourceLease || null };
  }
}

module.exports = { MAX_METADATA_BYTES, SearchSnapshotSourceReaderError, SearchSnapshotSourceReaderService, preparationPrefix };
