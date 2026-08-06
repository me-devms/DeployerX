const crypto = require('crypto');
const fs = require('fs');
const fsPromises = require('fs/promises');
const os = require('os');
const path = require('path');
const { DatabaseAdapterError } = require('./database-adapter');
const { ADAPTER_ID } = require('./sqlite');

const MAX_SQLITE_BACKUP_BYTES = 1024 * 1024 * 1024 * 1024;

class SqliteSourceReaderError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'SqliteSourceReaderError';
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

function protectedIdentity(identity = {}) {
  return {
    sqliteVersion: identity.version, journalMode: identity.journalMode, pageSize: identity.pageSize, pageCount: identity.pageCount,
    freelistCount: identity.freelistCount, schemaVersion: identity.schemaVersion, userVersion: identity.userVersion,
    applicationId: identity.applicationId, objectCount: identity.objectCount, schemaFingerprint: identity.schemaFingerprint, quickCheck: identity.quickCheck
  };
}

class SqliteSourceReaderService {
  constructor({ controlDatabase, deviceId, adapterRegistry, adapter, temporaryRoot = path.join(os.tmpdir(), 'deployerx-sqlite-backups'), fileSystem = fsPromises, createReadStream = fs.createReadStream } = {}) {
    if (!controlDatabase || !adapterRegistry || !adapter) throw new TypeError('SQLite source reader dependencies are required.');
    this.controlDatabase = controlDatabase;
    this.deviceId = requiredText(deviceId, 'Device ID', 200);
    this.adapterRegistry = adapterRegistry;
    this.adapter = adapter;
    this.temporaryRoot = path.resolve(requiredText(temporaryRoot, 'SQLite temporary root'));
    this.fileSystem = fileSystem;
    this.createReadStream = createReadStream;
    this.preparations = new Map();
  }

  async plan(workspaceId, sourceId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const source = await this.controlDatabase.repository('source').get(tenant, requiredText(sourceId, 'Source ID', 200));
    if (!source || source.sourceType !== 'database' || source.adapterId !== ADAPTER_ID || !source.enabled) throw new SqliteSourceReaderError('SQLITE_SOURCE_UNAVAILABLE', 'The SQLite source is unavailable.');
    const selector = source.selector || {};
    const selectedMain = selector.allDatabases === true || (selector.databases?.include?.length === 1 && selector.databases.include[0]?.name === 'main');
    const filtered = selector.databases?.exclude?.length || selector.schemas?.include?.length || selector.schemas?.exclude?.length || selector.tables?.include?.length || selector.tables?.exclude?.length || selector.includeGlobalObjects;
    if (!selectedMain || filtered) throw new SqliteSourceReaderError('SQLITE_SOURCE_SELECTION_INVALID', 'The SQLite source must contain the complete main database without object filters.', { category: 'compatibility' });
    const connection = await this.controlDatabase.repository('connection').get(tenant, source.connectionId);
    if (!connection || connection.adapterId !== ADAPTER_ID) throw new SqliteSourceReaderError('SQLITE_SOURCE_CONNECTION_MISSING', 'The SQLite source connection is unavailable.');
    if (!(connection.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new SqliteSourceReaderError('SQLITE_SOURCE_OTHER_DEVICE', 'The SQLite source belongs to another device.', { category: 'authorization' });
    if (connection.lastTest?.status !== 'success' || !connection.trust?.fingerprint) throw new SqliteSourceReaderError('SQLITE_SOURCE_CONNECTION_UNHEALTHY', 'Test the SQLite connection successfully before running a backup.', { category: 'connectivity', retryable: true });
    const manifest = this.adapterRegistry.manifest(ADAPTER_ID);
    if (!manifest.executionReady) throw new SqliteSourceReaderError('SQLITE_EXECUTION_NOT_READY', 'SQLite online backup execution is unavailable.', { category: 'compatibility' });
    return {
      source, connection, connectionConfig: this.adapter.normalizeConfig(connection.endpoint),
      manifest: { adapterId: manifest.adapterId, adapterVersion: manifest.adapterVersion, selectionDigest: source.selector.digest, sourceRevision: source.revision }
    };
  }

  async #prepare(workspaceId, executionId, plan, options) {
    let directory = null;
    try {
      const prepared = await this.adapterRegistry.prepareBackup(ADAPTER_ID, { signal: options.signal, onProgress: options.onProgress }, {
        connection: plan.connectionConfig, selector: plan.source.selector, consistency: plan.source.consistency
      });
      if (prepared.consistency.evidence.serverIdentityFingerprint !== plan.connection.trust.fingerprint) throw new SqliteSourceReaderError('SQLITE_DATABASE_IDENTITY_CHANGED', 'The SQLite database identity changed after its last successful connection test.', { category: 'integrity' });
      await this.fileSystem.mkdir(this.temporaryRoot, { recursive: true, mode: 0o700 });
      await this.fileSystem.chmod(this.temporaryRoot, 0o700).catch(() => {});
      directory = await this.fileSystem.mkdtemp(path.join(this.temporaryRoot, preparationPrefix(workspaceId, executionId)));
      await this.fileSystem.chmod(directory, 0o700).catch(() => {});
      await this.fileSystem.writeFile(path.join(directory, '.owner.json'), JSON.stringify({ version: 1, workspaceId, executionId }), { flag: 'wx', mode: 0o600 });
      const media = await this.adapter.createBackupMedia({ signal: options.signal, onProgress: options.onProgress }, prepared.adapterPlan, path.join(directory, 'database.sqlite3'));
      if (!Number.isSafeInteger(media.sizeBytes) || media.sizeBytes < 1 || media.sizeBytes > MAX_SQLITE_BACKUP_BYTES) throw new SqliteSourceReaderError('SQLITE_BACKUP_LIMIT_EXCEEDED', 'The SQLite backup exceeds the supported temporary-storage limit.', { category: 'capacity' });
      const identity = protectedIdentity(media.identity);
      const databaseManifest = {
        version: 1, kind: 'sqlite-online-backup', adapterId: ADAPTER_ID, adapterVersion: prepared.adapterVersion, engine: 'sqlite',
        selection: plan.source.selector, selectionDigest: plan.source.selector.digest, consistency: prepared.consistency,
        source: { databaseFingerprint: prepared.consistency.evidence.serverIdentityFingerprint },
        nativeTools: prepared.consistency.evidence.nativeTools, warnings: prepared.consistency.evidence.warnings,
        protectedIdentity: identity,
        artifact: { kind: 'database-dump', path: prepared.adapterPlan.artifact.path, mediaType: prepared.adapterPlan.artifact.mediaType, sizeBytes: media.sizeBytes, contentDigest: media.digest }
      };
      return { directory, filePath: media.filePath, sizeBytes: media.sizeBytes, prepared, databaseManifest };
    } catch (error) {
      if (directory) await this.fileSystem.rm(directory, { recursive: true, force: true }).catch(() => {});
      if (error instanceof SqliteSourceReaderError) throw error;
      if (error instanceof DatabaseAdapterError || error?.code) throw new SqliteSourceReaderError(error.code || 'SQLITE_BACKUP_PREPARATION_FAILED', error.message, { category: error.category, retryable: error.retryable });
      throw new SqliteSourceReaderError('SQLITE_BACKUP_PREPARATION_FAILED', 'DeployerX could not prepare the SQLite online backup.', { retryable: true });
    }
  }

  async files(workspaceId, sourceId, options = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const executionId = requiredText(options.executionId, 'Backup execution ID', 200);
    if (options.backupMode && options.backupMode !== 'full') throw new SqliteSourceReaderError('SQLITE_BACKUP_MODE_UNSUPPORTED', 'SQLite online backup currently supports full recovery points only.', { category: 'compatibility' });
    const plan = await this.plan(tenant, sourceId);
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
    const artifactPath = prepared.prepared.adapterPlan.artifact.path;
    const content = () => (async function* readBackup() {
      for await (const rawChunk of createReadStream(prepared.filePath, { highWaterMark: 64 * 1024, signal })) {
        if (signal?.aborted) throw new SqliteSourceReaderError('SQLITE_BACKUP_CANCELED', 'The SQLite backup was canceled.', { category: 'cancellation' });
        const chunk = Buffer.from(rawChunk);
        const paced = bandwidthLimiter ? await bandwidthLimiter.consume(chunk.length) : { limitBytesPerSecond: null, waitedMilliseconds: 0 };
        await onProgress?.({ phase: 'transferring', path: artifactPath, bytesRead: chunk.length, bandwidthLimitBytesPerSecond: paced.limitBytesPerSecond, throttleWaitMilliseconds: paced.waitedMilliseconds });
        yield chunk;
      }
    })();
    return {
      ...plan,
      manifest: { ...plan.manifest, workloadType: 'database', resumable: false, consistency: prepared.prepared.consistency, database: prepared.databaseManifest, artifactPath, sizeBytes: prepared.sizeBytes },
      create: async function* createSqliteFiles() {
        yield { path: artifactPath, type: 'file', metadata: { workload: 'database', artifactKind: 'database-dump', database: prepared.databaseManifest }, content: content() };
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

module.exports = { MAX_SQLITE_BACKUP_BYTES, SqliteSourceReaderError, SqliteSourceReaderService, preparationPrefix, protectedIdentity };
