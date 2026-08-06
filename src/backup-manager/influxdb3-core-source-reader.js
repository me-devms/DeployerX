const crypto = require('crypto');
const fs = require('fs');
const fsPromises = require('fs/promises');
const os = require('os');
const path = require('path');
const { DatabaseAdapterError } = require('./database-adapter');
const { ADAPTER_ID, normalizeBackupExecution } = require('./influxdb3-core');

const MAX_METADATA_BYTES = 32 * 1024 * 1024;
const CORE_PUBLICATION_POLICY = Object.freeze({
  file: Object.freeze({ kind: 'influxdb3-core-filesystem-full', restoreSupported: true }),
  s3: Object.freeze({ kind: 'influxdb3-core-s3-full', restoreSupported: true }),
  azure: Object.freeze({ kind: 'influxdb3-core-azure-full', restoreSupported: true }),
  google: Object.freeze({ kind: 'influxdb3-core-gcs-full', restoreSupported: true })
});

class InfluxDb3CoreSourceReaderError extends Error {
  constructor(code, safeMessage, options = {}) { super(safeMessage); this.name = 'InfluxDb3CoreSourceReaderError'; this.code = code; this.category = options.category || 'source'; this.retryable = Boolean(options.retryable); }
}

function requiredText(value, label, maximumLength = 4096) { const text = String(value ?? '').trim(); if (!text || text.includes('\0') || text.length > maximumLength) throw new TypeError(`${label} is invalid.`); return text; }
function preparationPrefix(workspaceId, executionId) { return `run-${crypto.createHash('sha256').update(`${workspaceId}\0${executionId}`).digest('hex').slice(0, 32)}-`; }

class InfluxDb3CoreSourceReaderService {
  constructor({ controlDatabase, deviceId, adapterRegistry, adapter, connectionService, temporaryRoot = path.join(os.tmpdir(), 'deployerx-influxdb3-core-backups'), fileSystem = fsPromises, createReadStream = fs.createReadStream } = {}) {
    if (!controlDatabase || !adapterRegistry || !adapter || !connectionService) throw new TypeError('InfluxDB 3 Core source reader dependencies are required.');
    this.controlDatabase = controlDatabase; this.deviceId = requiredText(deviceId, 'Device ID', 200); this.adapterRegistry = adapterRegistry; this.adapter = adapter; this.connectionService = connectionService; this.temporaryRoot = path.resolve(requiredText(temporaryRoot, 'InfluxDB 3 Core temporary root')); this.fileSystem = fileSystem; this.createReadStream = createReadStream; this.preparations = new Map();
  }

  async plan(workspaceId, sourceId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200); const source = await this.controlDatabase.repository('source').get(tenant, requiredText(sourceId, 'Source ID', 200));
    if (!source || source.sourceType !== 'database' || source.adapterId !== ADAPTER_ID || !source.enabled) throw new InfluxDb3CoreSourceReaderError('INFLUXDB3_CORE_SOURCE_UNAVAILABLE', 'The InfluxDB 3 Core Source is unavailable.');
    const execution = normalizeBackupExecution(source.physicalExecution); const selector = source.selector || {};
    if (!selector.allDatabases || selector.databases?.include?.length || selector.databases?.exclude?.length || selector.schemas?.include?.length || selector.schemas?.exclude?.length || selector.tables?.include?.length || selector.tables?.exclude?.length || selector.includeGlobalObjects) throw new InfluxDb3CoreSourceReaderError('INFLUXDB3_CORE_SELECTION_INVALID', 'InfluxDB 3 Core object-store backup must protect the exact whole node.', { category: 'compatibility' });
    if (source.consistency?.backupMethod !== 'physical' || source.consistency?.backupMode !== 'full' || !['auto', execution.consistencyMethod].includes(source.consistency?.method) || source.consistency?.captureCoordinates !== false) throw new InfluxDb3CoreSourceReaderError('INFLUXDB3_CORE_CONSISTENCY_INVALID', 'InfluxDB 3 Core Source consistency does not match its object-store proof mode.', { category: 'compatibility' });
    const connection = await this.controlDatabase.repository('connection').get(tenant, source.connectionId);
    if (!connection || connection.adapterId !== ADAPTER_ID) throw new InfluxDb3CoreSourceReaderError('INFLUXDB3_CORE_CONNECTION_MISSING', 'The InfluxDB 3 Core connection is unavailable.');
    if (!(connection.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new InfluxDb3CoreSourceReaderError('INFLUXDB3_CORE_OTHER_DEVICE', 'The InfluxDB 3 Core Source belongs to another device.', { category: 'authorization' });
    if (connection.lastTest?.status !== 'success' || connection.trust?.fingerprint !== execution.deploymentFingerprint || connection.trust?.storageFingerprint !== execution.storageFingerprint || execution.connectionRevision !== connection.revision) throw new InfluxDb3CoreSourceReaderError('INFLUXDB3_CORE_CONNECTION_UNHEALTHY', 'Retest and re-save the InfluxDB 3 Core Source before backup.', { category: 'integrity', retryable: true });
    const manifest = this.adapterRegistry.manifest(ADAPTER_ID);
    return { source, connection, execution, connectionConfig: this.connectionService.config(connection), manifest: { adapterId: manifest.adapterId, adapterVersion: manifest.adapterVersion, selectionDigest: selector.digest, sourceRevision: source.revision } };
  }

  async prepare(workspaceId, executionId, plan, options) {
    return this.connectionService.withExecution(workspaceId, plan.connection, options.signal, async (executionContext, connectionConfig) => {
      let directory = null;
      try {
        const prepared = await this.adapterRegistry.prepareBackup(ADAPTER_ID, { ...executionContext, onProgress: options.onProgress }, { connection: connectionConfig, selector: plan.source.selector, consistency: plan.source.consistency, execution: plan.execution });
        await this.fileSystem.mkdir(this.temporaryRoot, { recursive: true, mode: 0o700 }); await this.fileSystem.chmod(this.temporaryRoot, 0o700).catch(() => {});
        directory = await this.fileSystem.mkdtemp(path.join(this.temporaryRoot, preparationPrefix(workspaceId, executionId))); await this.fileSystem.chmod(directory, 0o700).catch(() => {});
        await this.fileSystem.writeFile(path.join(directory, '.owner.json'), JSON.stringify({ version: 1, workspaceId, executionId }), { flag: 'wx', mode: 0o600 });
        const media = await this.adapter.createBackupMedia({ ...executionContext, onProgress: options.onProgress }, prepared.adapterPlan, path.join(directory, 'node'));
        const members = media.files.map((file) => ({ path: `influxdb3-core/node/${media.nodeId}/${file.relativePath}`, relativePath: file.relativePath, sizeBytes: file.sizeBytes, contentDigest: file.contentDigest }));
        const publication = CORE_PUBLICATION_POLICY[media.objectStore];
        if (!publication) throw new InfluxDb3CoreSourceReaderError('INFLUXDB3_CORE_OBJECT_STORE_UNSUPPORTED', 'InfluxDB 3 Core backup media uses an unsupported object store.', { category: 'compatibility' });
        const databaseManifest = { version: 1, kind: publication.kind, adapterId: ADAPTER_ID, adapterVersion: prepared.adapterVersion, engine: 'influxdb3-core', backupMethod: 'physical', backupMode: 'full', sourceId: plan.source.id, selection: plan.source.selector, selectionDigest: plan.source.selector.digest, consistency: prepared.consistency, source: { product: media.product, productVersion: media.productVersion, nodeId: media.nodeId, objectStore: media.objectStore, deploymentFingerprint: media.deploymentFingerprint, storageFingerprint: media.storageFingerprint }, capture: { copyOrder: media.copyOrder, excluded: media.excluded, consistencyMode: media.consistencyMode, achievedConsistency: media.achievedConsistency, phaseEvidence: media.phaseEvidence, sourceDriftPhases: media.driftPhases }, nativeMedia: { fileCount: media.fileCount, directoryCount: media.directoryCount, totalBytes: media.totalBytes, mediaFingerprint: media.mediaFingerprint, directoryFingerprint: media.directoryFingerprint, directories: media.directories, members }, artifact: { kind: 'metadata', path: prepared.adapterPlan.artifact.path, mediaType: prepared.adapterPlan.artifact.mediaType, restoreSupported: publication.restoreSupported } };
        const metadataBytes = Buffer.from(JSON.stringify(databaseManifest));
        if (metadataBytes.length < 1 || metadataBytes.length > MAX_METADATA_BYTES) throw new InfluxDb3CoreSourceReaderError('INFLUXDB3_CORE_METADATA_LIMIT', 'InfluxDB 3 Core backup metadata exceeds the supported size.', { category: 'capacity' });
        return { directory, prepared, media, members, databaseManifest, metadataBytes };
      } catch (error) {
        if (directory) await this.fileSystem.rm(directory, { recursive: true, force: true }).catch(() => {});
        if (error instanceof InfluxDb3CoreSourceReaderError) throw error;
        if (error instanceof DatabaseAdapterError || error?.code) throw new InfluxDb3CoreSourceReaderError(error.code || 'INFLUXDB3_CORE_PREPARATION_FAILED', error.message, { category: error.category, retryable: error.retryable });
        throw new InfluxDb3CoreSourceReaderError('INFLUXDB3_CORE_PREPARATION_FAILED', 'DeployerX could not prepare the InfluxDB 3 Core object-store backup.', { retryable: true });
      }
    });
  }

  async files(workspaceId, sourceId, options = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200); const executionId = requiredText(options.executionId, 'Backup execution ID', 200);
    if (options.backupMode && options.backupMode !== 'full') throw new InfluxDb3CoreSourceReaderError('INFLUXDB3_CORE_MODE_UNSUPPORTED', 'InfluxDB 3 Core object-store backup supports full recovery points only.', { category: 'compatibility' });
    const plan = await this.plan(tenant, sourceId); const key = `${tenant}:${executionId}`;
    if (!this.preparations.has(key)) { const promise = this.prepare(tenant, executionId, plan, options); promise.catch(() => this.preparations.delete(key)); this.preparations.set(key, promise); }
    const prepared = await this.preparations.get(key); const createReadStream = this.createReadStream; const signal = options.signal; const onProgress = options.onProgress; const bandwidthLimiter = options.bandwidthLimiter;
    const content = (member) => (async function* streamMember() { for await (const raw of createReadStream(path.join(prepared.media.directory, ...member.relativePath.split('/')), { highWaterMark: 64 * 1024, signal })) { if (signal?.aborted) throw new InfluxDb3CoreSourceReaderError('INFLUXDB3_CORE_CANCELED', 'The InfluxDB 3 Core backup was canceled.', { category: 'canceled' }); const chunk = Buffer.from(raw); const paced = bandwidthLimiter ? await bandwidthLimiter.consume(chunk.length) : { limitBytesPerSecond: null, waitedMilliseconds: 0 }; await onProgress?.({ phase: 'transferring', path: member.path, bytesRead: chunk.length, bandwidthLimitBytesPerSecond: paced.limitBytesPerSecond, throttleWaitMilliseconds: paced.waitedMilliseconds }); yield chunk; } })();
    const artifactPath = prepared.prepared.adapterPlan.artifact.path;
    return { ...plan, manifest: { ...plan.manifest, workloadType: 'database', resumable: false, consistency: prepared.prepared.consistency, database: prepared.databaseManifest, artifactPath, artifactPaths: [artifactPath], sizeBytes: prepared.media.totalBytes + prepared.metadataBytes.length }, create: async function* createCoreFiles() { yield { path: artifactPath, type: 'file', metadata: { workload: 'database', artifactKind: 'metadata', database: prepared.databaseManifest }, content: (async function* metadata() { yield prepared.metadataBytes; })() }; for (const member of prepared.members) yield { path: member.path, type: 'file', metadata: { workload: 'database', artifactKind: 'physical-backup-member', componentId: 'node-member', nativeRelativePath: member.relativePath, contentDigest: member.contentDigest }, content: content(member) }; } };
  }

  async release(workspaceId, executionId) { const key = `${requiredText(workspaceId, 'Workspace ID', 200)}:${requiredText(executionId, 'Backup execution ID', 200)}`; const promise = this.preparations.get(key); this.preparations.delete(key); if (!promise) return false; const prepared = await promise.catch(() => null); if (prepared?.directory) await this.fileSystem.rm(prepared.directory, { recursive: true, force: true }).catch(() => {}); return true; }
  async reconcileRun(workspaceId, run = {}) { const tenant = requiredText(workspaceId, 'Workspace ID', 200); const executionId = requiredText(run.id, 'Backup execution ID', 200); const prefix = preparationPrefix(tenant, executionId); const entries = await this.fileSystem.readdir(this.temporaryRoot, { withFileTypes: true }).catch((error) => error?.code === 'ENOENT' ? [] : Promise.reject(error)); let removed = 0; for (const entry of entries.slice(0, 10000)) { if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue; const directory = path.join(this.temporaryRoot, entry.name); const owner = await this.fileSystem.readFile(path.join(directory, '.owner.json'), 'utf8').then(JSON.parse).catch(() => null); if (owner?.version !== 1 || owner.workspaceId !== tenant || owner.executionId !== executionId) continue; await this.fileSystem.rm(directory, { recursive: true, force: true }); removed += 1; } return { applicable: true, proven: true, removedTemporaryDirectories: removed, sourceLease: run.sourceLease || null }; }
}

module.exports = { InfluxDb3CoreSourceReaderError, InfluxDb3CoreSourceReaderService, MAX_METADATA_BYTES, preparationPrefix };
