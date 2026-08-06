const fs = require('fs');
const fsPromises = require('fs/promises');
const os = require('os');
const path = require('path');
const { DatabaseAdapterError } = require('./database-adapter');
const { MysqlFamilyBinlogError, parseDumpCoordinate } = require('./mysql-family-binlog');
const { ADAPTER_ID } = require('./mysql-logical');
const { MysqlPhysicalBackupService, MysqlPhysicalError } = require('./mysql-physical');

const MAX_MYSQL_DUMP_BYTES = 1024 * 1024 * 1024 * 1024;

class MysqlSourceReaderError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'MysqlSourceReaderError';
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

class LogicalDatabaseSourceReaderService {
  constructor({ controlDatabase, secretStore, deviceId, adapterRegistry, adapter, physicalBackupService = null, profile = {}, temporaryRoot = os.tmpdir(), fileSystem = fsPromises, createReadStream = fs.createReadStream } = {}) {
    if (!controlDatabase || !secretStore || !adapterRegistry || !adapter) throw new TypeError('Database source reader dependencies are required.');
    this.controlDatabase = controlDatabase;
    this.secretStore = secretStore;
    this.deviceId = requiredText(deviceId, 'Device ID', 200);
    this.adapterRegistry = adapterRegistry;
    this.adapter = adapter;
    this.temporaryRoot = temporaryRoot;
    this.fileSystem = fileSystem;
    this.createReadStream = createReadStream;
    this.physicalBackupService = physicalBackupService;
    this.preparations = new Map();
    this.profile = {
      adapterId: profile.adapterId || ADAPTER_ID,
      codePrefix: profile.codePrefix || 'MYSQL',
      label: profile.label || 'MySQL',
      engine: profile.engine || 'mysql',
      manifestKind: profile.manifestKind || 'mysql-logical',
      binlogManifestKind: profile.binlogManifestKind || 'mysql-binlog',
      temporaryPrefix: profile.temporaryPrefix || 'deployerx-mysql-dump',
      emptyToolName: profile.emptyToolName || 'mysqldump',
      maximumDumpBytes: profile.maximumDumpBytes || MAX_MYSQL_DUMP_BYTES,
      parseAnchorCoordinate: profile.parseAnchorCoordinate || ((bytes, context) => parseDumpCoordinate(bytes, context))
    };
  }

  async plan(workspaceId, sourceId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const source = await this.controlDatabase.repository('source').get(tenant, requiredText(sourceId, 'Source ID', 200));
    const { adapterId, codePrefix, label } = this.profile;
    if (!source || source.sourceType !== 'database' || source.adapterId !== adapterId || !source.enabled) throw new MysqlSourceReaderError(`${codePrefix}_SOURCE_UNAVAILABLE`, `The ${label} source is unavailable.`);
    if (source.selector?.kind !== 'database-objects' || (!source.selector.allDatabases && !source.selector.databases?.include?.length)) throw new MysqlSourceReaderError(`${codePrefix}_SOURCE_SELECTION_INVALID`, `The ${label} source does not contain a valid database selection.`);
    const connection = await this.controlDatabase.repository('connection').get(tenant, source.connectionId);
    if (!connection || connection.adapterId !== adapterId) throw new MysqlSourceReaderError(`${codePrefix}_SOURCE_CONNECTION_MISSING`, `The ${label} source connection is unavailable.`);
    if (!(connection.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new MysqlSourceReaderError(`${codePrefix}_SOURCE_OTHER_DEVICE`, `The ${label} source belongs to another device.`, { category: 'authorization' });
    if (connection.lastTest?.status !== 'success' || !connection.trust?.fingerprint) throw new MysqlSourceReaderError(`${codePrefix}_SOURCE_CONNECTION_UNHEALTHY`, `Test the ${label} connection successfully before running a backup.`, { category: 'connectivity', retryable: true });
    const [passwordSecretRefId] = connection.secretRefIds || [];
    const connectionConfig = this.adapter.normalizeConfig({ ...connection.endpoint, passwordSecretRefId });
    const manifest = this.adapterRegistry.manifest(adapterId);
    const executionConnection = source.consistency?.backupMethod === 'physical' && source.physicalExecution?.sshConnectionId
      ? await this.controlDatabase.repository('connection').get(tenant, source.physicalExecution.sshConnectionId)
      : null;
    return { source, connection, executionConnection, connectionConfig, manifest: { adapterId: manifest.adapterId, adapterVersion: manifest.adapterVersion, selectionDigest: source.selector.digest, sourceRevision: source.revision } };
  }

  async #prepare(workspaceId, executionId, plan, options) {
    if (plan.source.consistency?.backupMethod === 'physical') return this.#preparePhysical(workspaceId, executionId, plan, options);
    if (options.backupMode === 'incremental') return this.#prepareBinaryLogs(workspaceId, executionId, plan, options);
    let directory = null;
    let fileHandle = null;
    try {
      const { adapterId, codePrefix, label, engine, manifestKind, temporaryPrefix, emptyToolName, maximumDumpBytes } = this.profile;
      const prepared = await this.adapterRegistry.prepareBackup(adapterId, {
        resolveSecret: (secretRefId) => this.secretStore.resolve({ workspaceId, id: secretRefId }),
        signal: options.signal,
        onProgress: options.onProgress
      }, {
        connection: plan.connectionConfig,
        selector: plan.source.selector,
        consistency: plan.source.consistency
      });
      if (prepared.consistency.evidence.serverIdentityFingerprint !== plan.connection.trust.fingerprint) throw new MysqlSourceReaderError(`${codePrefix}_SERVER_IDENTITY_CHANGED`, `The ${label} server identity changed after the last successful connection test.`, { category: 'integrity' });
      directory = await this.fileSystem.mkdtemp(path.join(this.temporaryRoot, `${temporaryPrefix}-${executionId.slice(0, 40)}-`));
      await this.fileSystem.chmod(directory, 0o700).catch(() => {});
      const filePath = path.join(directory, 'logical-dump.sql');
      fileHandle = await this.fileSystem.open(filePath, 'wx', 0o600);
      const opened = await this.adapter.openBackup({
        resolveSecret: (secretRefId) => this.secretStore.resolve({ workspaceId, id: secretRefId }),
        signal: options.signal,
        onProgress: options.onProgress
      }, prepared.adapterPlan);
      let sizeBytes = 0;
      for await (const rawChunk of opened.content) {
        const chunk = Buffer.from(rawChunk);
        sizeBytes += chunk.length;
        if (sizeBytes > maximumDumpBytes) throw new MysqlSourceReaderError(`${codePrefix}_DUMP_LIMIT_EXCEEDED`, `The ${label} logical dump exceeds the temporary-storage limit.`, { category: 'capacity' });
        let offset = 0;
        while (offset < chunk.length) {
          const written = await fileHandle.write(chunk, offset, chunk.length - offset);
          if (!written.bytesWritten) throw new MysqlSourceReaderError(`${codePrefix}_DUMP_WRITE_FAILED`, `DeployerX could not write the temporary ${label} dump.`, { category: 'capacity', retryable: true });
          offset += written.bytesWritten;
        }
      }
      await fileHandle.sync();
      await fileHandle.close();
      fileHandle = null;
      await this.fileSystem.chmod(filePath, 0o600).catch(() => {});
      if (sizeBytes < 1) throw new MysqlSourceReaderError(`${codePrefix}_DUMP_EMPTY`, `${emptyToolName} returned an empty logical backup.`, { category: 'integrity' });
      let binaryLog = null;
      if (prepared.consistency.captureCoordinates) {
        const headerHandle = await this.fileSystem.open(filePath, 'r');
        try {
          const header = Buffer.alloc(Math.min(sizeBytes, 2 * 1024 * 1024));
          const read = await headerHandle.read(header, 0, header.length, 0);
          const anchorCoordinate = this.profile.parseAnchorCoordinate(header.subarray(0, read.bytesRead), {
            engine,
            capturedAt: prepared.consistency.evidence.checkedAt,
            serverIdentityFingerprint: prepared.consistency.evidence.serverIdentityFingerprint
          }, prepared, opened.metadata);
          binaryLog = { version: 1, anchorCoordinate, settings: prepared.consistency.evidence.metadata?.binaryLog || null };
        } finally { await headerHandle.close(); }
      }
      const databaseManifest = {
        version: 1,
        kind: manifestKind,
        adapterId,
        adapterVersion: prepared.adapterVersion,
        engine,
        selection: plan.source.selector,
        selectionDigest: plan.source.selector.digest,
        consistency: prepared.consistency,
        server: { ...(prepared.consistency.evidence.metadata || {}), ...(opened.metadata?.server || {}) },
        nativeTools: prepared.consistency.evidence.nativeTools,
        warnings: prepared.consistency.evidence.warnings,
        binaryLog,
        artifact: { kind: 'database-dump', path: prepared.adapterPlan.artifact.path, mediaType: prepared.adapterPlan.artifact.mediaType, sizeBytes }
      };
      return { directory, filePath, sizeBytes, prepared, databaseManifest };
    } catch (error) {
      await fileHandle?.close().catch(() => {});
      if (directory) await this.fileSystem.rm(directory, { recursive: true, force: true }).catch(() => {});
      if (error instanceof MysqlSourceReaderError) throw error;
      if (error instanceof MysqlFamilyBinlogError) throw new MysqlSourceReaderError(error.code, error.message, { category: error.category, retryable: error.retryable });
      if (error instanceof DatabaseAdapterError) throw new MysqlSourceReaderError(error.code, error.message, { category: error.category, retryable: error.retryable });
      throw new MysqlSourceReaderError(`${this.profile.codePrefix}_SOURCE_PREPARATION_FAILED`, `DeployerX could not prepare the ${this.profile.label} logical dump.`, { retryable: true });
    }
  }

  async #preparePhysical(workspaceId, executionId, plan, options) {
    const { codePrefix, label } = this.profile;
    if (!this.physicalBackupService) throw new MysqlSourceReaderError(`${codePrefix}_PHYSICAL_ENGINE_UNAVAILABLE`, `${label} physical backup execution is unavailable.`, { category: 'compatibility' });
    try {
      const prepared = await this.physicalBackupService.prepare(workspaceId, executionId, plan, options);
      return { ...prepared, physical: true, sizeBytes: null };
    } catch (error) {
      if (error instanceof MysqlPhysicalError || error?.code) throw new MysqlSourceReaderError(error.code || `${codePrefix}_PHYSICAL_BACKUP_FAILED`, error.message, { category: error.category, retryable: error.retryable });
      throw new MysqlSourceReaderError(`${codePrefix}_PHYSICAL_BACKUP_FAILED`, `DeployerX could not create the ${label} physical backup.`, { retryable: true });
    }
  }

  async #prepareBinaryLogs(workspaceId, executionId, plan, options) {
    let directory = null;
    try {
      const { adapterId, codePrefix, label, engine, binlogManifestKind, temporaryPrefix } = this.profile;
      if (plan.source.consistency?.captureCoordinates !== true) throw new MysqlSourceReaderError(`${codePrefix}_PITR_NOT_ENABLED`, `Enable point-in-time recovery on the ${label} source before running incremental log capture.`, { category: 'compatibility' });
      const previousPoint = options.previousRecoveryPoint;
      if (!previousPoint || previousPoint.sourceId !== plan.source.id || !['full', 'log'].includes(previousPoint.type)) throw new MysqlSourceReaderError(`${codePrefix}_PITR_ANCHOR_REQUIRED`, `A coordinate-bearing ${label} full backup is required before incremental log capture.`, { category: 'consistency' });
      const artifacts = await this.controlDatabase.repository('artifact').list(workspaceId, { limit: 1000 });
      const previousArtifact = artifacts.find((item) => item.recoveryPointId === previousPoint.id && ['database-dump', 'transaction-log'].includes(item.kind) && item.metadata?.adapterId === adapterId);
      const previousMetadata = previousArtifact?.metadata;
      const startCoordinate = previousMetadata?.binaryLog?.endCoordinate || previousMetadata?.binaryLog?.anchorCoordinate;
      if (!startCoordinate) throw new MysqlSourceReaderError(`${codePrefix}_PITR_ANCHOR_COORDINATE_MISSING`, `The preceding ${label} recovery point has no authenticated binary-log coordinate.`, { category: 'integrity' });
      const capturePlan = await this.adapter.prepareBinaryLogCapture({ resolveSecret: (secretRefId) => this.secretStore.resolve({ workspaceId, id: secretRefId }), signal: options.signal }, { connection: plan.connectionConfig, selector: plan.source.selector, startCoordinate });
      directory = await this.fileSystem.mkdtemp(path.join(this.temporaryRoot, `${temporaryPrefix}-binlog-${executionId.slice(0, 40)}-`));
      await this.fileSystem.chmod(directory, 0o700).catch(() => {});
      const files = capturePlan.empty ? [] : await this.adapter.captureBinaryLogs({ resolveSecret: (secretRefId) => this.secretStore.resolve({ workspaceId, id: secretRefId }), signal: options.signal }, capturePlan, directory);
      const databaseManifest = {
        version: 1,
        kind: binlogManifestKind,
        adapterId,
        adapterVersion: plan.manifest.adapterVersion,
        engine,
        selection: plan.source.selector,
        selectionDigest: plan.source.selector.digest,
        consistency: { requestedLevel: 'application', achievedLevel: 'application', backupMethod: 'logical', backupMode: 'incremental', captureCoordinates: true, proven: true },
        server: { engine, serverIdentityFingerprint: capturePlan.serverIdentityFingerprint, selectedDatabases: [capturePlan.database], selectionMode: 'databases' },
        nativeTools: [{ name: capturePlan.nativeTool.name, version: capturePlan.nativeTool.text, compatible: capturePlan.nativeTool.supported }],
        warnings: [],
        binaryLog: { version: 1, database: capturePlan.database, startCoordinate: capturePlan.start, endCoordinate: capturePlan.end, checksum: capturePlan.checksum, segments: capturePlan.segments.map(({ filePath: _filePath, ...segment }) => segment) },
        artifacts: files.map((file) => ({ kind: 'transaction-log', path: file.artifactPath, mediaType: 'application/octet-stream', sizeBytes: file.sizeBytes, file: file.file, startPosition: file.startPosition, stopPosition: file.stopPosition }))
      };
      return { directory, files, sizeBytes: files.reduce((total, file) => total + file.sizeBytes, 0), capturePlan, databaseManifest, noChange: capturePlan.empty };
    } catch (error) {
      if (directory) await this.fileSystem.rm(directory, { recursive: true, force: true }).catch(() => {});
      if (error instanceof MysqlSourceReaderError) throw error;
      if (error instanceof MysqlFamilyBinlogError || error instanceof DatabaseAdapterError || error?.code) throw new MysqlSourceReaderError(error.code || `${this.profile.codePrefix}_BINLOG_CAPTURE_FAILED`, error.message, { category: error.category, retryable: error.retryable });
      throw new MysqlSourceReaderError(`${this.profile.codePrefix}_BINLOG_CAPTURE_FAILED`, `DeployerX could not capture the ${this.profile.label} binary logs.`, { retryable: true });
    }
  }

  async files(workspaceId, sourceId, options = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const executionId = requiredText(options.executionId, 'Backup execution ID', 200);
    const plan = await this.plan(tenant, sourceId);
    const key = `${tenant}:${executionId}`;
    if (!this.preparations.has(key)) {
      const promise = this.#prepare(tenant, executionId, plan, options);
      promise.catch(() => this.preparations.delete(key));
      this.preparations.set(key, promise);
    }
    const prepared = await this.preparations.get(key);
    if (prepared.physical) {
      const artifacts = prepared.artifacts || [{
        artifactPath: prepared.artifactPath,
        content: prepared.content,
        artifactKind: prepared.databaseManifest.artifact?.kind || 'physical-backup'
      }];
      if (!artifacts.length || artifacts.some((artifact) => !artifact.artifactPath || typeof artifact.content !== 'function')) throw new MysqlSourceReaderError(`${this.profile.codePrefix}_PHYSICAL_ARTIFACT_INVALID`, `${this.profile.label} physical backup returned an invalid artifact set.`, { category: 'integrity' });
      const artifactPaths = artifacts.map((artifact) => artifact.artifactPath);
      return {
        ...plan,
        manifest: {
          ...plan.manifest,
          workloadType: 'database',
          resumable: false,
          consistency: prepared.databaseManifest.consistency,
          database: prepared.databaseManifest,
          artifactPath: artifactPaths.length === 1 ? artifactPaths[0] : null,
          artifactPaths,
          sizeBytes: null
        },
        create: async function* createPhysicalFiles() {
          for (const artifact of artifacts) yield {
            path: artifact.artifactPath,
            type: 'file',
            metadata: { workload: 'database', artifactKind: artifact.artifactKind || 'physical-backup', database: prepared.databaseManifest, componentId: artifact.componentId || null },
            content: artifact.content()
          };
        }
      };
    }
    if (options.backupMode === 'incremental') {
      const onProgress = options.onProgress;
      const bandwidthLimiter = options.bandwidthLimiter;
      const createReadStream = this.createReadStream;
      const signal = options.signal;
      return {
        ...plan,
        manifest: {
          ...plan.manifest,
          workloadType: 'database',
          resumable: false,
          consistency: prepared.databaseManifest.consistency,
          database: prepared.databaseManifest,
          artifactPaths: prepared.files.map((file) => file.artifactPath),
          sizeBytes: prepared.sizeBytes,
          noChange: prepared.noChange
        },
        create: async function* createBinaryLogFiles() {
          for (const file of prepared.files) {
            const content = (async function* readBinaryLog() {
              for await (const rawChunk of createReadStream(file.filePath, { highWaterMark: 64 * 1024, signal })) {
                if (signal?.aborted) throw new MysqlSourceReaderError('DATABASE_BACKUP_CANCELED', 'The database backup was canceled.', { category: 'cancellation' });
                const chunk = Buffer.from(rawChunk);
                const paced = bandwidthLimiter ? await bandwidthLimiter.consume(chunk.length) : { limitBytesPerSecond: null, waitedMilliseconds: 0 };
                await onProgress?.({ phase: 'transferring', path: file.artifactPath, bytesRead: chunk.length, bandwidthLimitBytesPerSecond: paced.limitBytesPerSecond, throttleWaitMilliseconds: paced.waitedMilliseconds });
                yield chunk;
              }
            })();
            yield { path: file.artifactPath, type: 'file', metadata: { workload: 'database', artifactKind: 'transaction-log', database: prepared.databaseManifest, segment: { file: file.file, startPosition: file.startPosition, stopPosition: file.stopPosition } }, content };
          }
        }
      };
    }
    const createReadStream = this.createReadStream;
    const onProgress = options.onProgress;
    const bandwidthLimiter = options.bandwidthLimiter;
    const signal = options.signal;
    const content = () => (async function* readDump() {
      for await (const rawChunk of createReadStream(prepared.filePath, { highWaterMark: 64 * 1024, signal })) {
        if (signal?.aborted) throw new MysqlSourceReaderError('DATABASE_BACKUP_CANCELED', 'The database backup was canceled.', { category: 'cancellation' });
        const chunk = Buffer.from(rawChunk);
        const paced = bandwidthLimiter ? await bandwidthLimiter.consume(chunk.length) : { limitBytesPerSecond: null, waitedMilliseconds: 0 };
        await onProgress?.({ phase: 'transferring', path: prepared.prepared.adapterPlan.artifact.path, bytesRead: chunk.length, bandwidthLimitBytesPerSecond: paced.limitBytesPerSecond, throttleWaitMilliseconds: paced.waitedMilliseconds });
        yield chunk;
      }
    })();
    return {
      ...plan,
      manifest: {
        ...plan.manifest,
        workloadType: 'database',
        resumable: false,
        consistency: prepared.prepared.consistency,
        database: prepared.databaseManifest,
        artifactPath: prepared.prepared.adapterPlan.artifact.path,
        sizeBytes: prepared.sizeBytes
      },
      create: async function* createMysqlFiles() {
        yield {
          path: prepared.prepared.adapterPlan.artifact.path,
          type: 'file',
          metadata: { workload: 'database', artifactKind: 'database-dump', database: prepared.databaseManifest },
          content: content()
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
    if (prepared?.physical && this.physicalBackupService) return this.physicalBackupService.release(prepared);
    if (prepared?.directory) await this.fileSystem.rm(prepared.directory, { recursive: true, force: true }).catch(() => {});
    return true;
  }
}

class MysqlSourceReaderService extends LogicalDatabaseSourceReaderService {
  constructor(options = {}) {
    const physicalBackupService = options.physicalBackupService || new MysqlPhysicalBackupService(options);
    super({ ...options, physicalBackupService, profile: { adapterId: ADAPTER_ID, codePrefix: 'MYSQL', label: 'MySQL', engine: 'mysql', manifestKind: 'mysql-logical', binlogManifestKind: 'mysql-binlog', temporaryPrefix: 'deployerx-mysql-dump', emptyToolName: 'mysqldump', maximumDumpBytes: MAX_MYSQL_DUMP_BYTES } });
  }
}

class BackupSourceReaderRouter {
  constructor({ controlDatabase, fileReader, databaseReaders = {} } = {}) {
    if (!controlDatabase || !fileReader) throw new TypeError('Backup source reader router dependencies are required.');
    this.controlDatabase = controlDatabase;
    this.fileReader = fileReader;
    this.databaseReaders = new Map(Object.entries(databaseReaders));
  }

  async #reader(workspaceId, sourceId) {
    const source = await this.controlDatabase.repository('source').get(workspaceId, sourceId);
    if (!source) throw new Error('Backup source was not found.');
    if (source.sourceType === 'files') return this.fileReader;
    const reader = this.databaseReaders.get(source.adapterId);
    if (!reader) throw new Error('This database source adapter cannot execute backups yet.');
    return reader;
  }

  async plan(workspaceId, sourceId) { return (await this.#reader(workspaceId, sourceId)).plan(workspaceId, sourceId); }

  async files(workspaceId, sourceId, options = {}) { return (await this.#reader(workspaceId, sourceId)).files(workspaceId, sourceId, options); }

  async release(workspaceId, executionId) {
    await Promise.all([...this.databaseReaders.values()].map((reader) => reader.release?.(workspaceId, executionId)));
  }

  async reconcileRun(workspaceId, run) {
    const adapterId = run?.configSnapshot?.source?.adapterId;
    const reader = this.databaseReaders.get(adapterId);
    if (!reader?.reconcileRun) return { applicable: false, proven: true, sourceLease: run?.sourceLease || null };
    return reader.reconcileRun(workspaceId, run);
  }
}

module.exports = {
  BackupSourceReaderRouter,
  LogicalDatabaseSourceReaderService,
  MAX_MYSQL_DUMP_BYTES,
  MysqlSourceReaderError,
  MysqlSourceReaderService
};
