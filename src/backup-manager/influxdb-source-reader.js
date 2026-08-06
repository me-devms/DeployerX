const crypto = require('crypto');
const fs = require('fs');
const fsPromises = require('fs/promises');
const os = require('os');
const path = require('path');
const { DatabaseAdapterError } = require('./database-adapter');
const { ADAPTER_ID, normalizeBackupExecution } = require('./influxdb');

const MAX_METADATA_BYTES = 16 * 1024 * 1024;

class InfluxDbSourceReaderError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'InfluxDbSourceReaderError';
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

class InfluxDbSourceReaderService {
  constructor({ controlDatabase, secretStore, deviceId, adapterRegistry, adapter, connectionService, temporaryRoot = path.join(os.tmpdir(), 'deployerx-influxdb-backups'), fileSystem = fsPromises, createReadStream = fs.createReadStream } = {}) {
    if (!controlDatabase || !secretStore || !adapterRegistry || !adapter || !connectionService) throw new TypeError('InfluxDB source reader dependencies are required.');
    this.controlDatabase = controlDatabase;
    this.secretStore = secretStore;
    this.deviceId = requiredText(deviceId, 'Device ID', 200);
    this.adapterRegistry = adapterRegistry;
    this.adapter = adapter;
    this.connectionService = connectionService;
    this.temporaryRoot = path.resolve(requiredText(temporaryRoot, 'InfluxDB backup temporary root'));
    this.fileSystem = fileSystem;
    this.createReadStream = createReadStream;
    this.preparations = new Map();
  }

  async plan(workspaceId, sourceId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const source = await this.controlDatabase.repository('source').get(tenant, requiredText(sourceId, 'Source ID', 200));
    if (!source || source.sourceType !== 'database' || source.adapterId !== ADAPTER_ID || !source.enabled) throw new InfluxDbSourceReaderError('INFLUXDB_SOURCE_UNAVAILABLE', 'The InfluxDB Source is unavailable.');
    const execution = normalizeBackupExecution(source.physicalExecution);
    const selector = source.selector || {};
    if (selector.allDatabases || selector.databases?.include?.length !== 1 || selector.databases?.exclude?.length || selector.schemas?.include?.length || selector.schemas?.exclude?.length || selector.tables?.include?.length > 1 || selector.tables?.exclude?.length || selector.includeGlobalObjects) throw new InfluxDbSourceReaderError('INFLUXDB_SOURCE_SELECTION_INVALID', 'The InfluxDB Source must contain one organization and optional one exact bucket.', { category: 'compatibility' });
    if (source.consistency?.backupMethod !== 'physical' || source.consistency?.backupMode !== 'full' || !['auto', 'influxdb-v2-native-backup'].includes(source.consistency?.method) || source.consistency?.requestedLevel !== 'application' || source.consistency?.captureCoordinates !== true) throw new InfluxDbSourceReaderError('INFLUXDB_SOURCE_CONSISTENCY_INVALID', 'The InfluxDB Source must use native application-consistent full backup.', { category: 'compatibility' });
    const connection = await this.controlDatabase.repository('connection').get(tenant, source.connectionId);
    if (!connection || connection.adapterId !== ADAPTER_ID) throw new InfluxDbSourceReaderError('INFLUXDB_SOURCE_CONNECTION_MISSING', 'The InfluxDB connection is unavailable.');
    if (!(connection.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new InfluxDbSourceReaderError('INFLUXDB_SOURCE_OTHER_DEVICE', 'The InfluxDB Source belongs to another device.', { category: 'authorization' });
    const identity = connection.lastTest?.endpointIdentity;
    if (connection.lastTest?.status !== 'success' || connection.trust?.fingerprint !== execution.deploymentFingerprint || identity?.inventoryFingerprint !== execution.inventoryFingerprint || execution.connectionRevision !== connection.revision) throw new InfluxDbSourceReaderError('INFLUXDB_SOURCE_CONNECTION_UNHEALTHY', 'Retest and re-save the InfluxDB Source before backup.', { category: 'integrity', retryable: true });
    const manifest = this.adapterRegistry.manifest(ADAPTER_ID);
    if (!manifest.executionReady) throw new InfluxDbSourceReaderError('INFLUXDB_EXECUTION_NOT_READY', 'InfluxDB backup execution is unavailable.', { category: 'compatibility' });
    return { source, connection, execution, connectionConfig: this.connectionService.config(connection), manifest: { adapterId: manifest.adapterId, adapterVersion: manifest.adapterVersion, selectionDigest: selector.digest, sourceRevision: source.revision } };
  }

  async #prepare(workspaceId, executionId, plan, options) {
    let directory = null;
    try {
      const context = { resolveSecret: (id) => this.secretStore.resolve({ workspaceId, id }), signal: options.signal, onProgress: options.onProgress };
      const prepared = await this.adapterRegistry.prepareBackup(ADAPTER_ID, context, { connection: plan.connectionConfig, selector: plan.source.selector, consistency: plan.source.consistency, execution: plan.execution });
      if (prepared.consistency.evidence.serverIdentityFingerprint !== plan.execution.deploymentFingerprint) throw new InfluxDbSourceReaderError('INFLUXDB_SOURCE_IDENTITY_CHANGED', 'InfluxDB identity changed after Source enrollment.', { category: 'integrity' });
      await this.fileSystem.mkdir(this.temporaryRoot, { recursive: true, mode: 0o700 });
      await this.fileSystem.chmod(this.temporaryRoot, 0o700).catch(() => {});
      directory = await this.fileSystem.mkdtemp(path.join(this.temporaryRoot, preparationPrefix(workspaceId, executionId)));
      await this.fileSystem.chmod(directory, 0o700).catch(() => {});
      await this.fileSystem.writeFile(path.join(directory, '.owner.json'), JSON.stringify({ version: 1, workspaceId, executionId }), { flag: 'wx', mode: 0o600 });
      const media = await this.adapter.createBackupMedia(context, prepared.adapterPlan, path.join(directory, 'native'));
      const nativeMembers = media.files.map((file) => ({ path: `influxdb/native/${file.relativePath}`, relativePath: file.relativePath, sizeBytes: file.sizeBytes, contentDigest: file.contentDigest }));
      const organizationBuckets = (plan.connection.influxdbInventory?.buckets || [])
        .filter((bucket) => bucket.organizationId === media.selection.organizationId && bucket.selectable === true && (media.selection.scope === 'organization' || bucket.id === media.selection.bucketId))
        .map((bucket) => ({ id: bucket.id, name: bucket.name, type: bucket.type, schemaType: bucket.schemaType || null, retentionRules: bucket.retentionRules || [] }));
      if (media.selection.scope === 'bucket' && organizationBuckets.length !== 1) throw new InfluxDbSourceReaderError('INFLUXDB_RESTORE_SCOPE_INCOMPLETE', 'InfluxDB backup scope lacks authenticated bucket and retention evidence.', { category: 'integrity' });
      const databaseManifest = {
        version: 1, kind: 'influxdb-oss-v2-native-backup', adapterId: ADAPTER_ID, adapterVersion: prepared.adapterVersion, engine: 'influxdb', backupMethod: 'physical', backupMode: 'full',
        sourceId: plan.source.id, selection: plan.source.selector, selectionDigest: plan.source.selector.digest, consistency: prepared.consistency,
        source: { product: media.product, productVersion: media.productVersion, cliVersion: media.cliVersion, deploymentFingerprint: media.deploymentFingerprint, inventoryFingerprint: media.inventoryFingerprint },
        scope: { type: media.selection.scope, organizationId: media.selection.organizationId, organizationName: media.selection.organizationName, bucketId: media.selection.bucketId, bucketName: media.selection.bucketName, buckets: organizationBuckets },
        nativeTools: prepared.consistency.evidence.nativeTools, warnings: prepared.consistency.evidence.warnings, tokenRecovery: media.tokenRecovery,
        nativeMedia: { fileCount: media.fileCount, totalBytes: media.totalBytes, mediaFingerprint: media.mediaFingerprint, members: nativeMembers },
        artifact: { kind: 'metadata', path: prepared.adapterPlan.artifact.path, mediaType: prepared.adapterPlan.artifact.mediaType, restoreSupported: true }
      };
      const metadataBytes = Buffer.from(JSON.stringify(databaseManifest));
      if (metadataBytes.length < 1 || metadataBytes.length > MAX_METADATA_BYTES) throw new InfluxDbSourceReaderError('INFLUXDB_METADATA_LIMIT_EXCEEDED', 'InfluxDB backup metadata exceeds the supported size.', { category: 'capacity' });
      return { directory, prepared, media, nativeMembers, databaseManifest, metadataBytes };
    } catch (error) {
      if (directory) await this.fileSystem.rm(directory, { recursive: true, force: true }).catch(() => {});
      if (error instanceof InfluxDbSourceReaderError) throw error;
      if (error instanceof DatabaseAdapterError || error?.code) throw new InfluxDbSourceReaderError(error.code || 'INFLUXDB_BACKUP_PREPARATION_FAILED', error.message, { category: error.category, retryable: error.retryable });
      throw new InfluxDbSourceReaderError('INFLUXDB_BACKUP_PREPARATION_FAILED', 'DeployerX could not prepare the native InfluxDB backup.', { retryable: true });
    }
  }

  async files(workspaceId, sourceId, options = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const executionId = requiredText(options.executionId, 'Backup execution ID', 200);
    if (options.backupMode && options.backupMode !== 'full') throw new InfluxDbSourceReaderError('INFLUXDB_BACKUP_MODE_UNSUPPORTED', 'InfluxDB OSS v2 native backup currently supports full recovery points only.', { category: 'compatibility' });
    const plan = await this.plan(tenant, sourceId);
    const key = `${tenant}:${executionId}`;
    if (!this.preparations.has(key)) {
      const promise = this.#prepare(tenant, executionId, plan, options);
      promise.catch(() => this.preparations.delete(key));
      this.preparations.set(key, promise);
    }
    const prepared = await this.preparations.get(key);
    const createReadStream = this.createReadStream;
    const signal = options.signal;
    const onProgress = options.onProgress;
    const bandwidthLimiter = options.bandwidthLimiter;
    const content = (member) => (async function* streamMember() {
      for await (const rawChunk of createReadStream(path.join(prepared.media.directory, ...member.relativePath.split('/')), { highWaterMark: 64 * 1024, signal })) {
        if (signal?.aborted) throw new InfluxDbSourceReaderError('INFLUXDB_BACKUP_CANCELED', 'The InfluxDB backup was canceled.', { category: 'canceled' });
        const chunk = Buffer.from(rawChunk);
        const paced = bandwidthLimiter ? await bandwidthLimiter.consume(chunk.length) : { limitBytesPerSecond: null, waitedMilliseconds: 0 };
        await onProgress?.({ phase: 'transferring', path: member.path, bytesRead: chunk.length, bandwidthLimitBytesPerSecond: paced.limitBytesPerSecond, throttleWaitMilliseconds: paced.waitedMilliseconds });
        yield chunk;
      }
    })();
    const artifactPath = prepared.prepared.adapterPlan.artifact.path;
    return {
      ...plan,
      manifest: { ...plan.manifest, workloadType: 'database', resumable: false, consistency: prepared.prepared.consistency, database: prepared.databaseManifest, artifactPath, artifactPaths: [artifactPath], sizeBytes: prepared.media.totalBytes + prepared.metadataBytes.length },
      create: async function* createInfluxDbFiles() {
        yield { path: artifactPath, type: 'file', metadata: { workload: 'database', artifactKind: 'metadata', database: prepared.databaseManifest }, content: (async function* metadata() { yield prepared.metadataBytes; })() };
        for (const member of prepared.nativeMembers) yield { path: member.path, type: 'file', metadata: { workload: 'database', artifactKind: 'physical-backup-member', componentId: 'native-member', nativeRelativePath: member.relativePath, contentDigest: member.contentDigest }, content: content(member) };
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

module.exports = { InfluxDbSourceReaderError, InfluxDbSourceReaderService, MAX_METADATA_BYTES, preparationPrefix };
