const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { DatabaseAdapterError } = require('./database-adapter');
const { ADAPTER_ID } = require('./scylla-manager');

const MAX_METADATA_BYTES = 16 * 1024 * 1024;

class ScyllaManagerSourceReaderError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'ScyllaManagerSourceReaderError';
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

class ScyllaManagerSourceReaderService {
  constructor({ controlDatabase, secretStore, deviceId, adapterRegistry, adapter, temporaryRoot = path.join(os.tmpdir(), 'deployerx-scylla-manager'), fileSystem = fs } = {}) {
    if (!controlDatabase || !secretStore || !adapterRegistry || !adapter) throw new TypeError('ScyllaDB Manager source reader dependencies are required.');
    this.controlDatabase = controlDatabase;
    this.secretStore = secretStore;
    this.deviceId = requiredText(deviceId, 'Device ID', 200);
    this.adapterRegistry = adapterRegistry;
    this.adapter = adapter;
    this.temporaryRoot = path.resolve(requiredText(temporaryRoot, 'ScyllaDB Manager temporary root'));
    this.fileSystem = fileSystem;
    this.preparations = new Map();
  }

  async plan(workspaceId, sourceId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const source = await this.controlDatabase.repository('source').get(tenant, requiredText(sourceId, 'Source ID', 200));
    if (!source || source.sourceType !== 'database' || source.adapterId !== ADAPTER_ID || !source.enabled) throw new ScyllaManagerSourceReaderError('SCYLLA_MANAGER_SOURCE_UNAVAILABLE', 'The ScyllaDB Manager Source is unavailable.');
    if (source.selector?.kind !== 'database-objects' || (!source.selector.allDatabases && !source.selector.databases?.include?.length) || source.selector.schemas?.include?.length || source.selector.schemas?.exclude?.length || source.selector.tables?.exclude?.length) throw new ScyllaManagerSourceReaderError('SCYLLA_MANAGER_SOURCE_SELECTION_INVALID', 'The ScyllaDB Manager Source has an invalid keyspace/table selection.', { category: 'compatibility' });
    if (source.consistency?.backupMethod !== 'physical' || source.consistency?.backupMode !== 'native' || !['auto', 'scylla-manager-backup'].includes(source.consistency?.method) || source.consistency?.requestedLevel !== 'crash' || source.consistency?.captureCoordinates !== true) throw new ScyllaManagerSourceReaderError('SCYLLA_MANAGER_SOURCE_CONSISTENCY_INVALID', 'The ScyllaDB Manager Source must use native crash-consistent execution.', { category: 'compatibility' });
    const connection = await this.controlDatabase.repository('connection').get(tenant, source.connectionId);
    if (!connection || connection.adapterId !== ADAPTER_ID) throw new ScyllaManagerSourceReaderError('SCYLLA_MANAGER_SOURCE_CONNECTION_MISSING', 'The ScyllaDB Manager connection is unavailable.');
    if (!(connection.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new ScyllaManagerSourceReaderError('SCYLLA_MANAGER_SOURCE_OTHER_DEVICE', 'The ScyllaDB Manager Source belongs to another device.', { category: 'authorization' });
    if (connection.lastTest?.status !== 'success' || !connection.trust?.fingerprint || !connection.clusterInventory?.healthy) throw new ScyllaManagerSourceReaderError('SCYLLA_MANAGER_SOURCE_CONNECTION_UNHEALTHY', 'Retest the ScyllaDB Manager connection with every agent, CQL endpoint, and REST endpoint up.', { category: 'connectivity', retryable: true });
    const execution = source.physicalExecution || {};
    const targetTrust = connection.managerTargetTrust;
    if (!targetTrust || targetTrust.targetFingerprint !== execution.targetFingerprint || targetTrust.managedClusterId !== execution.managedClusterId || execution.managedClusterId !== connection.endpoint.managedClusterId || execution.deploymentFingerprint !== connection.trust.fingerprint) throw new ScyllaManagerSourceReaderError('SCYLLA_MANAGER_TARGET_TRUST_CHANGED', 'Verify and save the exact Manager backup target again before backup.', { category: 'integrity' });
    const connectionConfig = this.adapter.normalizeConfig({ ...connection.endpoint, credentialSecretRefId: connection.secretRefIds?.[0] || null });
    const manifest = this.adapterRegistry.manifest(ADAPTER_ID);
    if (!manifest.executionReady) throw new ScyllaManagerSourceReaderError('SCYLLA_MANAGER_EXECUTION_NOT_READY', 'ScyllaDB Manager execution is unavailable.', { category: 'compatibility' });
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
      const prepared = await this.adapterRegistry.prepareBackup(ADAPTER_ID, { resolveSecret, signal: options.signal }, { connection: plan.connectionConfig, selector: plan.source.selector, consistency: plan.source.consistency, execution: { ...plan.source.physicalExecution, executionId, sourceId: plan.source.id, workspaceId } });
      if (prepared.consistency.evidence.serverIdentityFingerprint !== plan.connection.trust.fingerprint) throw new ScyllaManagerSourceReaderError('SCYLLA_MANAGER_IDENTITY_CHANGED', 'Manager identity changed after the last successful connection test.', { category: 'integrity' });
      await this.fileSystem.mkdir(this.temporaryRoot, { recursive: true, mode: 0o700 });
      await this.fileSystem.chmod(this.temporaryRoot, 0o700).catch(() => {});
      directory = await this.fileSystem.mkdtemp(path.join(this.temporaryRoot, preparationPrefix(workspaceId, executionId)));
      await this.fileSystem.chmod(directory, 0o700).catch(() => {});
      const ownerPath = path.join(directory, '.owner.json');
      let owner = { version: 1, workspaceId, executionId, connectionId: plan.connection.id, managerTask: null };
      await this.fileSystem.writeFile(ownerPath, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
      const onOwnership = async (managerOwner) => {
        owner = { ...owner, managerTask: managerOwner };
        await this.#writeOwner(ownerPath, owner);
      };
      const databaseManifest = await this.adapter.executeBackup({ resolveSecret, signal: options.signal, onProgress: options.onProgress, onOwnership, planDigest: prepared.planDigest }, prepared.adapterPlan);
      const bytes = Buffer.from(JSON.stringify(databaseManifest));
      if (bytes.length < 1 || bytes.length > MAX_METADATA_BYTES) throw new ScyllaManagerSourceReaderError('SCYLLA_MANAGER_METADATA_INVALID', 'Manager backup metadata exceeds the supported size.', { category: 'integrity' });
      return { directory, bytes, prepared, databaseManifest };
    } catch (error) {
      if (directory) {
        const owner = await this.fileSystem.readFile(path.join(directory, '.owner.json'), 'utf8').then(JSON.parse).catch(() => null);
        if (!owner?.managerTask) await this.fileSystem.rm(directory, { recursive: true, force: true }).catch(() => {});
      }
      if (error instanceof ScyllaManagerSourceReaderError) throw error;
      if (error instanceof DatabaseAdapterError || error?.code) throw new ScyllaManagerSourceReaderError(error.code || 'SCYLLA_MANAGER_BACKUP_PREPARATION_FAILED', error.message, { category: error.category, retryable: error.retryable });
      throw new ScyllaManagerSourceReaderError('SCYLLA_MANAGER_BACKUP_PREPARATION_FAILED', 'DeployerX could not prepare the Manager backup.', { retryable: true });
    }
  }

  async files(workspaceId, sourceId, options = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const executionId = requiredText(options.executionId, 'Backup execution ID', 200);
    if (options.backupMode && options.backupMode !== 'native') throw new ScyllaManagerSourceReaderError('SCYLLA_MANAGER_BACKUP_MODE_UNSUPPORTED', 'Manager backup supports native mode only.', { category: 'compatibility' });
    const plan = await this.plan(tenant, sourceId);
    const key = `${tenant}:${executionId}`;
    if (!this.preparations.has(key)) {
      const promise = this.#prepare(tenant, executionId, plan, options);
      promise.catch(() => this.preparations.delete(key));
      this.preparations.set(key, promise);
    }
    const prepared = await this.preparations.get(key);
    const artifactPath = prepared.prepared.adapterPlan.artifact.path;
    return {
      ...plan,
      manifest: { ...plan.manifest, workloadType: 'database', resumable: false, consistency: prepared.prepared.consistency, database: prepared.databaseManifest, artifactPath, artifactPaths: [artifactPath], sizeBytes: prepared.bytes.length, externalNativeMedia: true },
      create: async function* createScyllaManagerMetadata() {
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
    let reconciledTasks = 0;
    let proven = true;
    for (const entry of entries.slice(0, 10000)) {
      if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
      const directory = path.join(this.temporaryRoot, entry.name);
      const owner = await this.fileSystem.readFile(path.join(directory, '.owner.json'), 'utf8').then(JSON.parse).catch(() => null);
      if (owner?.version !== 1 || owner.workspaceId !== tenant || owner.executionId !== executionId) continue;
      if (owner.managerTask) {
        const connection = await this.controlDatabase.repository('connection').get(tenant, owner.connectionId);
        if (!connection || connection.adapterId !== ADAPTER_ID) { proven = false; continue; }
        try {
          const result = await this.adapter.reconcileTask({ resolveSecret: (id) => this.secretStore.resolve({ workspaceId: tenant, id }) }, { connection: this.adapter.normalizeConfig({ ...connection.endpoint, credentialSecretRefId: connection.secretRefIds?.[0] || null }), owner: owner.managerTask });
          if (!result.proven) { proven = false; continue; }
          reconciledTasks += 1;
        } catch { proven = false; continue; }
      }
      await this.fileSystem.rm(directory, { recursive: true, force: true });
      removed += 1;
    }
    return { applicable: true, proven, removedTemporaryDirectories: removed, reconciledTasks, sourceLease: run.sourceLease || null };
  }
}

module.exports = { MAX_METADATA_BYTES, ScyllaManagerSourceReaderError, ScyllaManagerSourceReaderService, preparationPrefix };
