const crypto = require('crypto');
const path = require('path');
const { generateUuidV7 } = require('./control-database');
const { ADAPTER_ID, identityQuery, normalizeDatabaseName, parseJsonResult } = require('./sqlserver');
const { SqlServerPhysicalBackupService, mediaValidationStatement, normalizeRemotePath, passwordWrapper, remoteSqlcmdCommand, sqlUnicodeLiteral } = require('./sqlserver-physical');
const { commandFromArgs, connectionConfigFromRecord, openSshExecutionSession } = require('./ssh-execution');

const RESTORE_CONFIRMATIONS = Object.freeze({ original: 'RESTORE SQL SERVER ORIGINAL', alternate: 'RESTORE SQL SERVER ALTERNATE' });
const TAIL_CONFIRMATION = 'CAPTURE SQL SERVER TAIL LOG';
const DAMAGED_TAIL_CONFIRMATION = 'ALLOW DAMAGED SQL SERVER TAIL LOG';
const TERMINAL_STATES = new Set(['succeeded', 'warning', 'failed', 'canceled']);
const REPOSITORY_LEASE_MS = 5 * 60 * 1000;

class SqlServerRestoreError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'SqlServerRestoreError';
    this.code = code;
    this.category = options.category || 'physical-restore';
    this.retryable = Boolean(options.retryable);
  }
}

function requiredText(value, label, maximumLength = 4096) {
  const text = String(value ?? '').trim();
  if (!text || text.includes('\0') || text.length > maximumLength) throw new TypeError(`${label} is invalid.`);
  return text;
}

function normalizeRecoveryTarget(input = {}) {
  const type = String(input.type || 'latest');
  if (!['latest', 'time'].includes(type)) throw new SqlServerRestoreError('SQLSERVER_RECOVERY_TARGET_INVALID', 'Choose end-of-chain or UTC-time SQL Server recovery.', { category: 'validation' });
  if (type === 'latest') return Object.freeze({ type, value: null });
  const candidate = requiredText(input.value, 'SQL Server recovery target time', 100);
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(candidate) || !Number.isFinite(Date.parse(candidate))) throw new SqlServerRestoreError('SQLSERVER_RECOVERY_TIME_INVALID', 'Enter a recovery timestamp with an explicit UTC offset.', { category: 'validation' });
  return Object.freeze({ type, value: new Date(candidate).toISOString() });
}

function normalizeRequest(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('SQL Server restore request must be an object.');
  const mode = String(input.mode || 'original');
  if (!RESTORE_CONFIRMATIONS[mode]) throw new SqlServerRestoreError('SQLSERVER_RESTORE_MODE_INVALID', 'Choose the original or an alternate SQL Server target.', { category: 'validation' });
  if (input.confirmed !== true || String(input.confirmationText || '').trim() !== RESTORE_CONFIRMATIONS[mode]) throw new SqlServerRestoreError('SQLSERVER_RESTORE_CONFIRMATION_REQUIRED', 'Enter the exact destructive SQL Server restore confirmation.', { category: 'conflict' });
  const tailMode = mode === 'original' ? String(input.tailMode || 'none') : 'none';
  if (!['none', 'online', 'offline', 'damaged'].includes(tailMode)) throw new SqlServerRestoreError('SQLSERVER_TAIL_MODE_INVALID', 'Choose a supported SQL Server tail-log mode.', { category: 'validation' });
  if (tailMode !== 'none' && (input.tailConfirmed !== true || String(input.tailConfirmationText || '').trim() !== TAIL_CONFIRMATION)) throw new SqlServerRestoreError('SQLSERVER_TAIL_CONFIRMATION_REQUIRED', 'Enter the exact tail-log confirmation before original recovery.', { category: 'conflict' });
  if (tailMode === 'damaged' && (input.damagedTailConfirmed !== true || String(input.damagedTailConfirmationText || '').trim() !== DAMAGED_TAIL_CONFIRMATION)) throw new SqlServerRestoreError('SQLSERVER_DAMAGED_TAIL_CONFIRMATION_REQUIRED', 'Damaged tail-log capture requires its independent high-risk confirmation.', { category: 'conflict' });
  return {
    recoveryPointId: requiredText(input.recoveryPointId, 'RecoveryPoint ID', 200), mode,
    targetSourceId: mode === 'alternate' ? requiredText(input.targetSourceId, 'Alternate SQL Server Source ID', 200) : null,
    targetDatabase: input.targetDatabase ? normalizeDatabaseName(input.targetDatabase, 'SQL Server restore database') : null,
    recoveryTarget: normalizeRecoveryTarget(input.recoveryTarget), tailMode, deepValidation: Boolean(input.deepValidation)
  };
}

function safeError(error) {
  if (error instanceof SqlServerRestoreError || error?.code) return { code: String(error.code).slice(0, 100), category: String(error.category || 'physical-restore').slice(0, 80), retryable: Boolean(error.retryable), safeMessage: String(error.message || 'The SQL Server restore failed.').slice(0, 500) };
  return { code: 'SQLSERVER_RESTORE_FAILED', category: 'physical-restore', retryable: false, safeMessage: 'DeployerX could not complete the SQL Server restore.' };
}

function assertPhysicalSource(source) {
  if (!source || source.adapterId !== ADAPTER_ID || source.consistency?.backupMethod !== 'physical' || source.physicalExecution?.engine !== 'sqlserver') throw new SqlServerRestoreError('SQLSERVER_RESTORE_SOURCE_INVALID', 'Choose a configured SQL Server native Source as the restore target.', { category: 'validation' });
  return source;
}

function bigLsn(value, label) {
  try {
    const result = BigInt(requiredText(value, label, 50));
    if (result < 0n) throw new Error();
    return result;
  } catch { throw new SqlServerRestoreError('SQLSERVER_CHAIN_LSN_INVALID', `${label} is invalid.`, { category: 'integrity' }); }
}

function validateChain(points, metadataByPoint, selectedPointId, target = { type: 'latest', value: null }) {
  const byId = new Map(points.map((point) => [point.id, point]));
  const reversed = [];
  const visited = new Set();
  let current = byId.get(selectedPointId);
  while (current) {
    if (visited.has(current.id)) throw new SqlServerRestoreError('SQLSERVER_CHAIN_CYCLE', 'The SQL Server recovery chain contains a cycle.', { category: 'integrity' });
    visited.add(current.id); reversed.push(current);
    if (!current.parentRecoveryPointId) break;
    current = byId.get(current.parentRecoveryPointId);
    if (!current) throw new SqlServerRestoreError('SQLSERVER_CHAIN_GAP', 'A required SQL Server RecoveryPoint is missing.', { category: 'integrity' });
  }
  const chain = reversed.reverse();
  if (!chain.length || chain[0].type !== 'full') throw new SqlServerRestoreError('SQLSERVER_CHAIN_FULL_MISSING', 'The SQL Server recovery chain has no full backup anchor.', { category: 'integrity' });
  const rootId = chain[0].id;
  let identity = null;
  let databaseGuid = null;
  let familyGuid = null;
  let databaseName = null;
  let sourceId = null;
  let jobId = null;
  let lastLog = null;
  let seenDifferential = false;
  for (let index = 0; index < chain.length; index += 1) {
    const point = chain[index];
    const metadata = metadataByPoint.get(point.id);
    if (!metadata || metadata.kind !== 'sqlserver-native') throw new SqlServerRestoreError('SQLSERVER_CHAIN_METADATA_INVALID', 'A SQL Server RecoveryPoint lacks authenticated native metadata.', { category: 'integrity' });
    const type = metadata.backup?.type;
    if (point.type !== type || !['full', 'differential', 'log'].includes(type)) throw new SqlServerRestoreError('SQLSERVER_CHAIN_TYPE_INVALID', 'A SQL Server RecoveryPoint type does not match its backup header.', { category: 'integrity' });
    identity ||= metadata.server?.instanceFingerprint;
    databaseGuid ||= metadata.database?.databaseGuid;
    familyGuid ||= metadata.database?.familyGuid;
    databaseName ||= metadata.database?.name;
    sourceId ||= metadata.source?.sourceId;
    jobId ||= metadata.source?.jobId;
    if (!identity || !databaseGuid || !familyGuid || !databaseName || metadata.server?.instanceFingerprint !== identity || metadata.database?.databaseGuid !== databaseGuid || metadata.database?.familyGuid !== familyGuid || metadata.database?.name !== databaseName || metadata.source?.sourceId !== sourceId || metadata.source?.jobId !== jobId || point.sourceId !== sourceId || point.jobId !== jobId) throw new SqlServerRestoreError('SQLSERVER_CHAIN_IDENTITY_MISMATCH', 'The SQL Server chain mixes different instances, databases, Sources, or Jobs.', { category: 'integrity' });
    if (index === 0) {
      if (metadata.backup.isCopyOnly || point.chainRootId !== rootId) throw new SqlServerRestoreError('SQLSERVER_CHAIN_FULL_INVALID', 'The SQL Server chain anchor is not a conventional authenticated full backup.', { category: 'integrity' });
      continue;
    }
    if (point.parentRecoveryPointId !== chain[index - 1].id && type !== 'differential') throw new SqlServerRestoreError('SQLSERVER_CHAIN_PARENT_INVALID', 'The SQL Server log chain has an invalid parent.', { category: 'integrity' });
    if (point.chainRootId !== rootId) throw new SqlServerRestoreError('SQLSERVER_CHAIN_ROOT_INVALID', 'The SQL Server chain root changed.', { category: 'integrity' });
    if (type === 'differential') {
      if (index !== 1 || seenDifferential) throw new SqlServerRestoreError('SQLSERVER_CHAIN_ORDER_INVALID', 'The SQL Server differential must directly follow its full backup.', { category: 'integrity' });
      if (metadata.backup.differentialBaseGuid !== metadataByPoint.get(rootId)?.backup?.backupSetGuid) throw new SqlServerRestoreError('SQLSERVER_CHAIN_DIFFERENTIAL_BASE_INVALID', 'The SQL Server differential base does not match the full backup.', { category: 'integrity' });
      seenDifferential = true;
    } else if (type === 'log') {
      if (seenDifferential) throw new SqlServerRestoreError('SQLSERVER_CHAIN_ORDER_INVALID', 'A stored SQL Server chain cannot place log backups after a differential parent.', { category: 'integrity' });
      if (lastLog) {
        if (bigLsn(metadata.backup.lastLsn, 'SQL Server log LastLSN') <= bigLsn(lastLog.backup.lastLsn, 'Previous SQL Server log LastLSN') || bigLsn(metadata.backup.firstLsn, 'SQL Server log FirstLSN') > bigLsn(lastLog.backup.lastLsn, 'Previous SQL Server log LastLSN')) throw new SqlServerRestoreError('SQLSERVER_CHAIN_LOG_GAP', 'The SQL Server log chain has a gap or non-advancing range.', { category: 'integrity' });
        if (metadata.backup.firstRecoveryForkId !== lastLog.backup.recoveryForkId && metadata.backup.recoveryForkId !== lastLog.backup.recoveryForkId) throw new SqlServerRestoreError('SQLSERVER_CHAIN_FORK_INVALID', 'The SQL Server recovery fork changed without an authenticated transition.', { category: 'integrity' });
      }
      lastLog = metadata;
    }
  }
  if (target.type === 'time') {
    const logs = chain.map((point) => metadataByPoint.get(point.id)).filter((metadata) => metadata.backup.type === 'log');
    if (!logs.length) throw new SqlServerRestoreError('SQLSERVER_STOPAT_LOG_REQUIRED', 'UTC-time recovery requires transaction-log backup coverage.', { category: 'validation' });
    const requested = Date.parse(target.value);
    const covering = logs.find((metadata) => Date.parse(metadata.backup.backupStartTime) <= requested && requested <= Date.parse(metadata.backup.backupFinishTime));
    if (!covering) throw new SqlServerRestoreError('SQLSERVER_STOPAT_OUTSIDE_CHAIN', 'The requested UTC time is outside the authenticated SQL Server log chain.', { category: 'validation' });
    if (covering.backup.hasBulkLoggedData && requested < Date.parse(covering.backup.backupFinishTime)) throw new SqlServerRestoreError('SQLSERVER_STOPAT_BULK_LOGGED_UNSUPPORTED', 'SQL Server cannot stop inside a log backup that contains bulk-logged changes.', { category: 'compatibility' });
  }
  return { chain, rootId, identity, databaseGuid, familyGuid, databaseName, sourceId, jobId, major: Number(metadataByPoint.get(rootId).server?.major), recoveryModel: metadataByPoint.get(rootId).database?.recoveryModel, metadataByPoint };
}

function fileListQuery(mediaPath, position = 1) {
  const file = Number(position);
  if (!Number.isInteger(file) || file < 1 || file > 1000) throw new TypeError('SQL Server media position is invalid.');
  return `SET NOCOUNT ON;
DECLARE @path nvarchar(4000) = ${sqlUnicodeLiteral(mediaPath)};
CREATE TABLE #files (LogicalName nvarchar(128), PhysicalName nvarchar(260), [Type] char(1), FileGroupName nvarchar(128) NULL, Size numeric(20,0), MaxSize numeric(20,0), FileID bigint, CreateLSN numeric(25,0), DropLSN numeric(25,0) NULL, UniqueID uniqueidentifier, ReadOnlyLSN numeric(25,0) NULL, ReadWriteLSN numeric(25,0) NULL, BackupSizeInBytes bigint, SourceBlockSize int, FileGroupID int, LogGroupGUID uniqueidentifier NULL, DifferentialBaseLSN numeric(25,0) NULL, DifferentialBaseGUID uniqueidentifier NULL, IsReadOnly bit, IsPresent bit, TDEThumbprint varbinary(32) NULL, SnapshotURL nvarchar(360) NULL);
INSERT INTO #files EXEC(N'RESTORE FILELISTONLY FROM DISK = ' + QUOTENAME(@path, '''') + N' WITH FILE = ${file}');
SELECT LogicalName AS logicalName, [Type] AS type, FileID AS fileId, CONVERT(varchar(36), UniqueID) AS uniqueId, CONVERT(varchar(40), Size) AS sizeBytes FROM #files ORDER BY FileID FOR JSON PATH;`;
}

function parseFileList(value) {
  const rows = parseJsonResult(value, 'SQL Server backup file list');
  if (!Array.isArray(rows) || !rows.length || rows.length > 10000) throw new SqlServerRestoreError('SQLSERVER_FILELIST_INVALID', 'SQL Server returned an invalid backup file list.', { category: 'integrity' });
  const ids = new Set();
  return rows.map((row) => {
    const logicalName = requiredText(row.logicalName, 'SQL Server logical file name', 128);
    const type = String(row.type || '');
    const fileId = Number(row.fileId);
    if (!['D', 'L'].includes(type) || !Number.isInteger(fileId) || fileId < 1 || ids.has(fileId)) throw new SqlServerRestoreError('SQLSERVER_FILELIST_UNSUPPORTED', 'The SQL Server backup contains an unsupported or duplicate file.', { category: 'compatibility' });
    ids.add(fileId);
    return { logicalName, type, fileId, uniqueId: requiredText(row.uniqueId, 'SQL Server file unique ID', 64).toLowerCase(), sizeBytes: requiredText(row.sizeBytes, 'SQL Server file size', 40) };
  });
}

function relocationPlan(files, execution, restoreId) {
  const dataRoot = normalizeRemotePath(execution.dataDirectory, 'SQL Server data directory');
  const logRoot = normalizeRemotePath(execution.logDirectory, 'SQL Server log directory');
  let dataIndex = 0;
  let logIndex = 0;
  const token = crypto.createHash('sha256').update(String(restoreId)).digest('hex').slice(0, 20);
  return files.map((file) => {
    const index = file.type === 'L' ? logIndex++ : dataIndex++;
    const extension = file.type === 'L' ? 'ldf' : index === 0 ? 'mdf' : 'ndf';
    const root = file.type === 'L' ? logRoot : dataRoot;
    return { ...file, targetPath: path.posix.join(root, `deployerx-${token}-${file.type.toLowerCase()}${index}.${extension}`) };
  });
}

function restoreStatement(database, mediaPath, backup, options = {}) {
  const position = Number(backup.position || 1);
  if (!Number.isInteger(position) || position < 1 || position > 1000) throw new TypeError('SQL Server restore media position is invalid.');
  const operation = backup.type === 'log' ? 'LOG' : 'DATABASE';
  const variables = [`DECLARE @db sysname = CONVERT(sysname, ${sqlUnicodeLiteral(database)});`, `DECLARE @path nvarchar(4000) = ${sqlUnicodeLiteral(mediaPath)};`];
  const fragments = [`N'RESTORE ${operation} ' + QUOTENAME(@db) + N' FROM DISK = ' + QUOTENAME(@path, '''') + N' WITH FILE = ${position}, CHECKSUM`];
  for (const [index, move] of (options.moves || []).entries()) {
    variables.push(`DECLARE @logical${index} nvarchar(128) = ${sqlUnicodeLiteral(move.logicalName)};`);
    variables.push(`DECLARE @target${index} nvarchar(4000) = ${sqlUnicodeLiteral(move.targetPath)};`);
    fragments.push(`N', MOVE ' + QUOTENAME(@logical${index}, '''') + N' TO ' + QUOTENAME(@target${index}, '''')`);
  }
  if (options.stopAt) {
    variables.push(`DECLARE @stopAt nvarchar(40) = ${sqlUnicodeLiteral(options.stopAt)};`);
    fragments.push(`N', STOPAT = ' + QUOTENAME(@stopAt, '''')`);
  }
  fragments.push(options.recovery ? `N', RECOVERY'` : `N', NORECOVERY'`);
  return `SET NOCOUNT ON;\n${variables.join('\n')}\nDECLARE @sql nvarchar(max) = ${fragments.join(' + ')};\nEXEC sys.sp_executesql @sql;`;
}

function targetPreflightQuery(database, tdeThumbprint = null) {
  const tde = tdeThumbprint && /^[0-9A-Fa-f]{2,130}$/.test(tdeThumbprint) ? `0x${tdeThumbprint}` : 'NULL';
  return `SET NOCOUNT ON;
DECLARE @db sysname = CONVERT(sysname, ${sqlUnicodeLiteral(database)});
DECLARE @thumbprint varbinary(65) = ${tde};
SELECT CONVERT(nvarchar(128), SERVERPROPERTY('ServerName')) AS serverName, CONVERT(nvarchar(128), SERVERPROPERTY('MachineName')) AS machineName,
  CONVERT(nvarchar(128), SERVERPROPERTY('InstanceName')) AS instanceName, CONVERT(varchar(100), SERVERPROPERTY('ProductVersion')) AS productVersion,
  h.host_platform AS hostPlatform, ISNULL(IS_SRVROLEMEMBER('sysadmin'), 0) AS isSysadmin,
  CASE WHEN d.database_id IS NULL THEN CAST(0 AS bit) ELSE CAST(1 AS bit) END AS databaseExists, d.state_desc AS databaseState,
  CASE WHEN EXISTS (SELECT 1 FROM sys.availability_databases_cluster adc WHERE adc.database_name = @db) THEN CAST(1 AS bit) ELSE CAST(0 AS bit) END AS inAvailabilityGroup,
  CASE WHEN @thumbprint IS NULL OR EXISTS (SELECT 1 FROM sys.certificates WHERE thumbprint = @thumbprint) THEN CAST(1 AS bit) ELSE CAST(0 AS bit) END AS tdeKeyAvailable
FROM sys.dm_os_host_info h LEFT JOIN sys.databases d ON d.name = @db
FOR JSON PATH, WITHOUT_ARRAY_WRAPPER;`;
}

function deepValidationQuery(database) {
  return `SET NOCOUNT ON;
DECLARE @db sysname = CONVERT(sysname, ${sqlUnicodeLiteral(database)});
DECLARE @sql nvarchar(max) = N'DBCC CHECKDB (' + QUOTENAME(@db) + N') WITH PHYSICAL_ONLY, NO_INFOMSGS';
EXEC sys.sp_executesql @sql;`;
}

class SqlServerRestoreService {
  constructor({ controlDatabase, secretStore, deviceId, adapter, openRepository, physicalBackupService = null, sessionFactory = openSshExecutionSession, clock = () => new Date().toISOString() } = {}) {
    if (!controlDatabase || !secretStore || !adapter || typeof openRepository !== 'function') throw new TypeError('SQL Server restore dependencies are required.');
    this.controlDatabase = controlDatabase; this.secretStore = secretStore; this.deviceId = requiredText(deviceId, 'Device ID', 200); this.adapter = adapter; this.openRepository = openRepository;
    this.physicalBackupService = physicalBackupService || new SqlServerPhysicalBackupService({ controlDatabase, secretStore, deviceId, sessionFactory });
    this.sessionFactory = sessionFactory; this.clock = clock; this.active = new Map();
  }

  async start(workspaceId, actorId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200); const actor = requiredText(actorId, 'Actor ID', 200); const request = normalizeRequest(input);
    const point = await this.controlDatabase.repository('recoveryPoint').get(tenant, request.recoveryPointId);
    if (!point) throw new SqlServerRestoreError('SQLSERVER_RECOVERY_POINT_NOT_FOUND', 'The SQL Server RecoveryPoint was not found.', { category: 'not-found' });
    const protectedSource = assertPhysicalSource(await this.controlDatabase.repository('source').get(tenant, point.sourceId));
    const targetSource = request.mode === 'original' ? protectedSource : assertPhysicalSource(await this.controlDatabase.repository('source').get(tenant, request.targetSourceId));
    if (request.mode === 'alternate' && targetSource.id === protectedSource.id) throw new SqlServerRestoreError('SQLSERVER_ALTERNATE_IS_ORIGINAL', 'Choose a different SQL Server Source for alternate recovery.', { category: 'conflict' });
    await this.targetConnections(tenant, targetSource);
    const now = this.clock();
    const record = await this.controlDatabase.repository('restoreRun').create({
      workspaceId: tenant, actorId: actor, recoveryPointIds: [point.id], targetConnectionId: targetSource.connectionId,
      target: { operation: 'sqlserver-native', engine: 'sqlserver', mode: request.mode, sourceId: targetSource.id, sqlServerConnectionId: targetSource.connectionId, sshConnectionId: targetSource.physicalExecution.sshConnectionId, database: request.targetDatabase || null, recoveryTarget: request.recoveryTarget, tailMode: request.tailMode },
      mode: request.mode, conflictPolicy: 'fail', workerId: `device:${this.deviceId}`, state: 'queued',
      progress: { phase: 'queued', itemsTotal: 0, itemsCompleted: 0, bytesTotal: 0, bytesWritten: 0, throughputBytesPerSecond: 0, startedAt: null, updatedAt: now, warnings: [] }, validation: null, result: null
    });
    const controller = new AbortController();
    const operation = this.execute(tenant, actor, record.id, request, controller.signal).catch(() => this.controlDatabase.repository('restoreRun').get(tenant, record.id));
    this.active.set(record.id, { operation, controller }); operation.finally(() => this.active.delete(record.id)); return record;
  }

  async wait(workspaceId, restoreRunId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200); const id = requiredText(restoreRunId, 'RestoreRun ID', 200);
    if (this.active.has(id)) await this.active.get(id).operation;
    const record = await this.controlDatabase.repository('restoreRun').get(tenant, id);
    if (!record || record.target?.operation !== 'sqlserver-native') throw new SqlServerRestoreError('SQLSERVER_RESTORE_RUN_NOT_FOUND', 'The SQL Server RestoreRun was not found.', { category: 'not-found' });
    return record;
  }

  async cancel(workspaceId, actorId, restoreRunId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200); requiredText(actorId, 'Actor ID', 200); const id = requiredText(restoreRunId, 'RestoreRun ID', 200);
    const record = await this.controlDatabase.repository('restoreRun').get(tenant, id);
    if (!record || record.target?.operation !== 'sqlserver-native') throw new SqlServerRestoreError('SQLSERVER_RESTORE_RUN_NOT_FOUND', 'The SQL Server RestoreRun was not found.', { category: 'not-found' });
    if (TERMINAL_STATES.has(record.state)) return record;
    const active = this.active.get(id);
    if (!active) throw new SqlServerRestoreError('SQLSERVER_RESTORE_NOT_ACTIVE', 'The SQL Server restore is not active in this DeployerX process.', { category: 'conflict' });
    active.controller.abort(); await active.operation; return this.controlDatabase.repository('restoreRun').get(tenant, id);
  }

  async list(workspaceId, options = {}) { return (await this.controlDatabase.repository('restoreRun').list(requiredText(workspaceId, 'Workspace ID', 200), { limit: Math.min(200, Math.max(1, Number(options.limit) || 50)) })).filter((record) => record.target?.operation === 'sqlserver-native'); }

  async reconcile(workspaceId, actorId = 'system') {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200); const recovered = [];
    for (const record of (await this.list(tenant, { limit: 200 })).filter((item) => !TERMINAL_STATES.has(item.state) && !this.active.has(item.id))) recovered.push(await this.project(tenant, record.id, { state: 'failed', progress: { ...(record.progress || {}), phase: 'failed', updatedAt: this.clock() }, result: { error: { code: 'SQLSERVER_RESTORE_INTERRUPTED', category: 'physical-restore', retryable: false, safeMessage: 'The DeployerX process stopped during SQL Server recovery. Inspect the target database state before retrying.' }, completedAt: this.clock() } }, actorId));
    return recovered;
  }

  async project(workspaceId, id, changes, actorId) { return this.controlDatabase.transaction((transaction) => { const current = transaction.get('restoreRun', workspaceId, id); return transaction.projectExecution('restoreRun', workspaceId, id, changes, { expectedRevision: current.revision, actorId }); }); }

  async targetConnections(workspaceId, source) {
    const [databaseConnection, sshConnection] = await Promise.all([this.controlDatabase.repository('connection').get(workspaceId, source.connectionId), this.controlDatabase.repository('connection').get(workspaceId, source.physicalExecution.sshConnectionId)]);
    if (!databaseConnection || databaseConnection.adapterId !== ADAPTER_ID || databaseConnection.lastTest?.status !== 'success' || !databaseConnection.lastTest?.endpointIdentity?.instanceFingerprint) throw new SqlServerRestoreError('SQLSERVER_RESTORE_DATABASE_UNHEALTHY', 'Retest the target SQL Server connection before recovery.', { category: 'connectivity' });
    if (!sshConnection || sshConnection.adapterId !== 'deployerx.connection.ssh' || sshConnection.lastTest?.status !== 'success') throw new SqlServerRestoreError('SQLSERVER_RESTORE_SSH_UNHEALTHY', 'Retest the target SSH execution connection before recovery.', { category: 'connectivity' });
    if (![databaseConnection, sshConnection].every((connection) => (connection.workerAffinity || []).includes(`device:${this.deviceId}`))) throw new SqlServerRestoreError('SQLSERVER_RESTORE_OTHER_DEVICE', 'The SQL Server recovery target belongs to another device.', { category: 'authorization' });
    const [passwordSecretRefId] = databaseConnection.secretRefIds || [];
    return { databaseConnection, sshConnection, connectionConfig: this.adapter.normalizeConfig({ ...databaseConnection.endpoint, passwordSecretRefId }) };
  }

  async loadChain(workspaceId, selectedPointId, target) {
    const [points, artifacts] = await Promise.all([this.controlDatabase.repository('recoveryPoint').list(workspaceId, { limit: 1000 }), this.controlDatabase.repository('artifact').list(workspaceId, { limit: 5000 })]);
    const relevant = artifacts.filter((artifact) => ['physical-backup', 'transaction-log'].includes(artifact.kind) && artifact.metadata?.kind === 'sqlserver-native');
    return { ...validateChain(points, new Map(relevant.map((artifact) => [artifact.recoveryPointId, artifact.metadata])), selectedPointId, target), artifacts: relevant };
  }

  async repositoryFile(workspaceId, point, metadata, artifacts) {
    for (const copy of (point.repositoryCopies || []).filter((item) => item.state === 'available')) {
      const artifact = artifacts.find((item) => item.recoveryPointId === point.id && item.repositoryId === copy.repositoryId && item.metadata?.kind === 'sqlserver-native');
      if (!artifact) continue;
      const opened = await this.openRepository(workspaceId, copy.repositoryId);
      const snapshot = await opened.engine.openSnapshot({}, { repositoryId: copy.repositoryId, snapshotId: copy.engineSnapshotId, masterKey: opened.masterKey });
      const file = snapshot.manifest.files.find((item) => item.type === 'file' && item.path === metadata.artifact?.path);
      if (!file || file.sizeBytes !== artifact.sizeBytes || file.contentDigest?.digest !== artifact.checksum?.digest || file.metadata?.database?.backup?.backupSetGuid !== metadata.backup?.backupSetGuid) throw new SqlServerRestoreError('SQLSERVER_RESTORE_ARTIFACT_INVALID', 'A SQL Server Artifact does not match its authenticated repository manifest.', { category: 'integrity' });
      return { copy, artifact, opened, snapshot, file, metadata };
    }
    throw new SqlServerRestoreError('SQLSERVER_RESTORE_ARTIFACT_UNAVAILABLE', 'No available repository copy contains a required SQL Server Artifact.', { category: 'not-found' });
  }

  async createTailExecution(workspaceId, actorId, restoreRunId, selectedPoint) {
    const parentRun = await this.controlDatabase.repository('run').get(workspaceId, selectedPoint.runId);
    if (!parentRun) throw new SqlServerRestoreError('SQLSERVER_TAIL_PARENT_RUN_MISSING', 'The selected SQL Server RecoveryPoint has no authenticated parent run.', { category: 'integrity' });
    const now = this.clock();
    return this.controlDatabase.transaction((transaction) => {
      const idempotencyKey = `sqlserver-tail:${restoreRunId}`;
      const group = transaction.create('executionGroup', {
        workspaceId, actorId, jobId: selectedPoint.jobId, jobRevision: Math.max(1, Number(parentRun.jobRevision || 1)), trigger: 'api', scheduledFor: null,
        idempotencyKey, state: 'running', latestRunId: null, terminalRunId: null
      });
      const run = transaction.create('run', {
        workspaceId, actorId, jobId: selectedPoint.jobId, jobRevision: Math.max(1, Number(parentRun.jobRevision || 1)), executionGroupId: group.id,
        scheduledFor: null, idempotencyKey: `${idempotencyKey}:attempt:1`, trigger: 'api', workerId: `device:${this.deviceId}`, state: 'running', attempt: 1,
        parentRunId: null, retryOfRunId: null, configSnapshot: { ...(parentRun.configSnapshot || {}), operation: 'sqlserver-tail-log', restoreRunId },
        planDigest: parentRun.planDigest || crypto.createHash('sha256').update(idempotencyKey).digest('hex'),
        progress: { phase: 'capturing-tail-log', itemsTotal: 1, itemsCompleted: 0, bytesTotal: 0, bytesRead: 0, startedAt: now, updatedAt: now },
        lease: null, checkpoint: { available: false, sequence: 0, runId: null }, startedAt: now, finishedAt: null, result: null
      });
      const projectedGroup = transaction.projectExecution('executionGroup', workspaceId, group.id, { latestRunId: run.id }, { expectedRevision: group.revision, actorId });
      return { group: projectedGroup, run };
    });
  }

  async failTailExecution(workspaceId, actorId, execution, error) {
    if (!execution) return;
    await this.controlDatabase.transaction((transaction) => {
      const run = transaction.get('run', workspaceId, execution.run.id);
      const group = transaction.get('executionGroup', workspaceId, execution.group.id);
      if (run && !TERMINAL_STATES.has(run.state)) transaction.projectExecution('run', workspaceId, run.id, { state: 'failed', finishedAt: this.clock(), progress: { ...(run.progress || {}), phase: 'failed', updatedAt: this.clock() }, result: { ...safeError(error), completedAt: this.clock() } }, { expectedRevision: run.revision, actorId });
      if (group && !TERMINAL_STATES.has(group.state)) transaction.projectExecution('executionGroup', workspaceId, group.id, { state: 'failed', latestRunId: execution.run.id, terminalRunId: execution.run.id }, { expectedRevision: group.revision, actorId });
    }).catch(() => {});
  }

  async publishTail(workspaceId, actorId, restoreRunId, selectedPoint, source, plan, request) {
    const tailExecution = await this.createTailExecution(workspaceId, actorId, restoreRunId, selectedPoint);
    let prepared = null;
    const committed = [];
    try {
      prepared = await this.physicalBackupService.prepare(workspaceId, tailExecution.run.id, plan, { backupMode: 'tail-log', tailMode: request.tailMode, jobId: selectedPoint.jobId });
      for (const copy of (selectedPoint.repositoryCopies || []).filter((item) => item.state === 'available')) {
        const opened = await this.openRepository(workspaceId, copy.repositoryId);
        const lease = await opened.adapter.acquireLock({ masterKey: opened.masterKey }, { repositoryId: copy.repositoryId, operation: 'backup', scope: `repository:${copy.repositoryId}:mutation`, workerId: `device:${this.deviceId}`, runId: tailExecution.run.id, ttlMs: REPOSITORY_LEASE_MS });
        try {
          const summary = await opened.engine.createSnapshot({}, { repositoryId: copy.repositoryId, masterKey: opened.masterKey, keyVersion: opened.keyVersion, idempotencyKey: `sqlserver-tail:${restoreRunId}:${copy.repositoryId}`, parentSnapshotId: copy.engineSnapshotId, files: (async function* () { yield { path: prepared.artifactPath, type: 'file', metadata: { workload: 'database', artifactKind: 'transaction-log', database: prepared.databaseManifest }, content: prepared.content() }; })() });
          const snapshot = await opened.engine.openSnapshot({}, { repositoryId: copy.repositoryId, snapshotId: summary.snapshotId, masterKey: opened.masterKey });
          const file = snapshot.manifest.files.find((item) => item.path === prepared.artifactPath);
          const stat = await opened.adapter.stat({}, summary.manifestKey);
          if (!file || file.sizeBytes !== prepared.sizeBytes || !stat?.sizeBytes) throw new SqlServerRestoreError('SQLSERVER_TAIL_PUBLICATION_INVALID', 'The SQL Server tail-log repository publication could not be authenticated.', { category: 'integrity' });
          committed.push({ repositoryId: copy.repositoryId, summary, stat, file });
        } finally {
          await opened.adapter.releaseLock({ masterKey: opened.masterKey }, lease).catch(() => {});
        }
      }
      if (!committed.length) throw new SqlServerRestoreError('SQLSERVER_TAIL_REPOSITORY_UNAVAILABLE', 'No repository copy is available for the required SQL Server tail log.', { category: 'not-found' });
      const now = this.clock(); const pointId = `rp_${generateUuidV7()}`;
      const degraded = request.tailMode === 'damaged' || prepared.databaseManifest.backup.isDamaged || prepared.databaseManifest.backup.hasIncompleteMetadata;
      const tailWarnings = degraded ? [{ code: 'SQLSERVER_TAIL_DEGRADED', safeMessage: 'The SQL Server tail log was captured from a damaged or incomplete database state and requires operator review.' }] : [];
      return await this.controlDatabase.transaction((transaction) => {
        const point = transaction.create('recoveryPoint', { id: pointId, workspaceId, actorId, jobId: selectedPoint.jobId, sourceId: source.id, runId: tailExecution.run.id, type: 'log', consistency: 'application', chainRootId: prepared.databaseManifest.chain.chainRootRecoveryPointId, parentRecoveryPointId: prepared.databaseManifest.chain.parentRecoveryPointId, capturedFrom: prepared.databaseManifest.backup.backupStartTime, capturedTo: prepared.databaseManifest.backup.backupFinishTime, pointInTime: { version: 1, type: 'sql-server-lsn', firstLsn: prepared.databaseManifest.backup.firstLsn, lastLsn: prepared.databaseManifest.backup.lastLsn, recoveryForkId: prepared.databaseManifest.backup.recoveryForkId, tail: true, tailMode: request.tailMode, degraded, isDamaged: Boolean(prepared.databaseManifest.backup.isDamaged), hasIncompleteMetadata: Boolean(prepared.databaseManifest.backup.hasIncompleteMetadata) }, repositoryCopies: committed.map((item) => ({ repositoryId: item.repositoryId, engineSnapshotId: item.summary.snapshotId, state: 'available', manifestLocator: item.summary.manifestKey, manifestChecksum: item.summary.manifestChecksum, immutableUntil: null })), verification: { mode: 'native-and-manifest', state: degraded ? 'warning' : 'succeeded', verifiedAt: now, verificationRunId: null }, retention: { ...(selectedPoint.retention || {}), deletionEligible: false, evaluatedAt: now }, manifestChecksum: crypto.createHash('sha256').update(JSON.stringify(committed.map((item) => item.summary.manifestChecksum))).digest('hex') });
        for (const item of committed) {
          transaction.create('artifact', { workspaceId, actorId, recoveryPointId: point.id, repositoryId: item.repositoryId, kind: 'manifest', locator: item.summary.manifestKey, sizeBytes: item.stat.sizeBytes, checksum: item.summary.manifestChecksum, encryption: { algorithm: 'aes-256-gcm', keyVersion: item.summary.keyVersion || null }, compression: { mode: 'balanced' } });
          transaction.create('artifact', { workspaceId, actorId, recoveryPointId: point.id, repositoryId: item.repositoryId, kind: 'transaction-log', locator: `${item.summary.manifestKey}#${encodeURIComponent(prepared.artifactPath)}`, sizeBytes: item.file.sizeBytes, checksum: item.file.contentDigest, encryption: { algorithm: 'aes-256-gcm', keyVersion: item.summary.keyVersion || null }, compression: { mode: 'balanced' }, metadata: prepared.databaseManifest });
        }
        const restore = transaction.get('restoreRun', workspaceId, restoreRunId);
        transaction.projectExecution('restoreRun', workspaceId, restoreRunId, { recoveryPointIds: [...restore.recoveryPointIds, point.id], target: { ...restore.target, tailRecoveryPointId: point.id } }, { expectedRevision: restore.revision, actorId });
        const tailRun = transaction.get('run', workspaceId, tailExecution.run.id);
        const tailGroup = transaction.get('executionGroup', workspaceId, tailExecution.group.id);
        const verifyingRun = transaction.projectExecution('run', workspaceId, tailRun.id, { state: 'verifying', progress: { ...(tailRun.progress || {}), phase: 'verifying', itemsCompleted: 1, bytesTotal: prepared.sizeBytes, bytesRead: prepared.sizeBytes, updatedAt: now } }, { expectedRevision: tailRun.revision, actorId });
        transaction.projectExecution('run', workspaceId, verifyingRun.id, { state: degraded ? 'warning' : 'succeeded', finishedAt: now, progress: { ...(verifyingRun.progress || {}), phase: 'completed', updatedAt: now }, result: { recoveryPointIds: [point.id], sourceBytes: prepared.sizeBytes, uploadedBytes: prepared.sizeBytes, reusedBytes: 0, tailMode: request.tailMode, degraded, warnings: tailWarnings } }, { expectedRevision: verifyingRun.revision, actorId });
        transaction.projectExecution('executionGroup', workspaceId, tailGroup.id, { state: degraded ? 'warning' : 'succeeded', latestRunId: tailRun.id, terminalRunId: tailRun.id }, { expectedRevision: tailGroup.revision, actorId });
        return point;
      });
    } catch (error) {
      await this.failTailExecution(workspaceId, actorId, tailExecution, error);
      throw error;
    } finally { if (prepared) await this.physicalBackupService.release(prepared).catch(() => {}); }
  }

  async execute(workspaceId, actorId, restoreRunId, request, signal) {
    let session = null; let remoteWorkspace = null; let execution = null; const stagedPaths = [];
    let progress = { phase: 'preparing', itemsTotal: 0, itemsCompleted: 0, bytesTotal: 0, bytesWritten: 0, throughputBytesPerSecond: 0, startedAt: this.clock(), updatedAt: this.clock(), warnings: [] };
    const startedMs = Date.now();
    try {
      await this.project(workspaceId, restoreRunId, { state: 'preparing', progress }, actorId);
      let selectedPoint = await this.controlDatabase.repository('recoveryPoint').get(workspaceId, request.recoveryPointId);
      const protectedSource = assertPhysicalSource(await this.controlDatabase.repository('source').get(workspaceId, selectedPoint?.sourceId));
      const targetSource = request.mode === 'original' ? protectedSource : assertPhysicalSource(await this.controlDatabase.repository('source').get(workspaceId, request.targetSourceId));
      const targetConnections = await this.targetConnections(workspaceId, targetSource);
      let chain = await this.loadChain(workspaceId, selectedPoint.id, request.mode === 'original' && request.tailMode !== 'none' ? { type: 'latest', value: null } : request.recoveryTarget);
      const targetDatabase = request.targetDatabase || chain.databaseName;
      if (request.mode === 'original' && targetDatabase !== chain.databaseName) throw new SqlServerRestoreError('SQLSERVER_ORIGINAL_NAME_MISMATCH', 'Original SQL Server recovery must use the protected database name.', { category: 'integrity' });
      if (request.mode === 'original' && ['FULL', 'BULK_LOGGED', 'BULK-LOGGED'].includes(String(chain.recoveryModel || '').toUpperCase()) && request.tailMode === 'none') throw new SqlServerRestoreError('SQLSERVER_TAIL_REQUIRED', 'Original recovery of a Full or Bulk-Logged database requires an authenticated tail-log backup.', { category: 'conflict' });
      if (request.mode === 'original' && request.tailMode !== 'none') {
        const plan = { source: protectedSource, connection: targetConnections.databaseConnection, executionConnection: targetConnections.sshConnection, connectionConfig: targetConnections.connectionConfig, manifest: { adapterVersion: protectedSource.platform?.adapterVersion || '1.0.0' } };
        selectedPoint = await this.publishTail(workspaceId, actorId, restoreRunId, selectedPoint, protectedSource, plan, request);
        chain = await this.loadChain(workspaceId, selectedPoint.id, request.recoveryTarget);
      }
      const files = [];
      for (const point of chain.chain) files.push(await this.repositoryFile(workspaceId, point, chain.metadataByPoint.get(point.id), chain.artifacts));
      progress.itemsTotal = files.length; progress.bytesTotal = files.reduce((sum, item) => sum + Number(item.file.sizeBytes || 0), 0);
      execution = targetSource.physicalExecution;
      session = await this.sessionFactory({ connectionConfig: connectionConfigFromRecord(targetConnections.sshConnection), resolveSecret: (secretRefId) => this.secretStore.resolve({ workspaceId, id: secretRefId }), signal });
      const temporaryRoot = normalizeRemotePath(execution.remoteTemporaryDirectory, 'Remote temporary directory');
      const allocated = await session.run(commandFromArgs('mktemp', ['-d', '-p', temporaryRoot, `deployerx-sqlserver-restore-${String(restoreRunId).slice(0, 20)}.XXXXXX`]), { stdoutLimitBytes: 8192 });
      remoteWorkspace = normalizeRemotePath(allocated.stdout.trim(), 'Allocated SQL Server restore workspace');
      if (path.posix.dirname(remoteWorkspace) !== temporaryRoot || !path.posix.basename(remoteWorkspace).startsWith('deployerx-sqlserver-restore-')) throw new SqlServerRestoreError('SQLSERVER_RESTORE_WORKSPACE_INVALID', 'The SQL Server restore workspace is outside the approved root.', { category: 'integrity' });
      const passwordFile = path.posix.join(remoteWorkspace, 'sqlcmd-password'); const wrapper = path.posix.join(remoteWorkspace, 'sqlcmd-wrapper');
      const password = String(await this.secretStore.resolve({ workspaceId, id: targetConnections.databaseConnection.secretRefIds[0] }));
      if (!password || /[\r\n\0]/.test(password)) throw new SqlServerRestoreError('SQLSERVER_PASSWORD_INVALID', 'The SQL Server password cannot be represented safely.', { category: 'authentication' });
      await session.writeFile(passwordFile, `${password}\n`, { mode: 0o600 }); await session.writeFile(wrapper, passwordWrapper(), { mode: 0o700 });
      const targetResult = await session.run(remoteSqlcmdCommand(execution, targetConnections.connectionConfig, wrapper, passwordFile, targetPreflightQuery(targetDatabase, chain.metadataByPoint.get(chain.rootId).database?.tdeThumbprint)), { stdoutLimitBytes: 1024 * 1024 });
      const target = parseJsonResult(targetResult.stdout, 'SQL Server restore target preflight');
      const testResult = await this.adapter.testConnection({ resolveSecret: (secretRefId) => this.secretStore.resolve({ workspaceId, id: secretRefId }), signal }, targetConnections.connectionConfig);
      if (testResult.status !== 'success') throw new SqlServerRestoreError('SQLSERVER_RESTORE_TARGET_UNHEALTHY', 'The target SQL Server instance failed connection validation.', { category: 'connectivity' });
      if (Number(String(target.productVersion).split('.')[0]) < chain.major) throw new SqlServerRestoreError('SQLSERVER_RESTORE_DOWNGRADE_REFUSED', 'SQL Server cannot restore this backup to an older engine major.', { category: 'compatibility' });
      if (request.mode === 'original' && testResult.endpointIdentity.instanceFingerprint !== chain.identity) throw new SqlServerRestoreError('SQLSERVER_RESTORE_INSTANCE_MISMATCH', 'The original restore target does not match the protected SQL Server instance.', { category: 'integrity' });
      if (request.mode === 'alternate' && testResult.endpointIdentity.instanceFingerprint === chain.identity) throw new SqlServerRestoreError('SQLSERVER_RESTORE_ALTERNATE_IS_ORIGINAL', 'Choose a different SQL Server instance for alternate recovery.', { category: 'conflict' });
      if (request.mode === 'alternate' && target.databaseExists) throw new SqlServerRestoreError('SQLSERVER_RESTORE_TARGET_EXISTS', 'The alternate SQL Server database already exists.', { category: 'conflict' });
      if (request.mode === 'original' && !target.databaseExists) throw new SqlServerRestoreError('SQLSERVER_RESTORE_ORIGINAL_MISSING', 'The original SQL Server database no longer exists.', { category: 'conflict' });
      if (target.inAvailabilityGroup) throw new SqlServerRestoreError('SQLSERVER_RESTORE_AVAILABILITY_GROUP_UNSUPPORTED', 'Remove the database from its availability group before restore.', { category: 'compatibility' });
      if (!target.tdeKeyAvailable) throw new SqlServerRestoreError('SQLSERVER_RESTORE_TDE_KEY_MISSING', 'The target SQL Server instance lacks the TDE certificate required by this backup.', { category: 'compatibility' });
      const backupRoot = normalizeRemotePath(execution.backupDirectory, 'SQL Server backup directory');
      for (let index = 0; index < files.length; index += 1) {
        const item = files[index]; const extension = item.metadata.backup.type === 'log' ? 'trn' : 'bak';
        const remotePath = path.posix.join(backupRoot, `deployerx-restore-${crypto.createHash('sha256').update(`${restoreRunId}:${index}`).digest('hex').slice(0, 24)}.${extension}`); stagedPaths.push(remotePath);
        const content = (async function* tracked() {
          const stream = item.opened.engine.streamFile({}, { repositoryId: item.copy.repositoryId, manifest: item.snapshot.manifest, masterKey: item.opened.masterKey, path: item.file.path });
          for await (const chunk of stream) { progress.bytesWritten += Buffer.byteLength(chunk); progress.throughputBytesPerSecond = Math.round(progress.bytesWritten / Math.max(1, (Date.now() - startedMs) / 1000)); yield chunk; }
        })();
        await session.consume(commandFromArgs(execution.ddExecutable, [`of=${remotePath}`, 'bs=65536', 'status=none', 'conv=fsync'], { privilegeMode: execution.privilegeMode }), content, { stderrLimitBytes: 4 * 1024 * 1024 });
        const stat = await session.run(commandFromArgs(execution.statExecutable, ['--printf=%s', '--', remotePath], { privilegeMode: execution.privilegeMode }), { stdoutLimitBytes: 8192 });
        if (Number(stat.stdout.trim()) !== Number(item.file.sizeBytes)) throw new SqlServerRestoreError('SQLSERVER_RESTORE_MEDIA_SIZE_MISMATCH', 'A staged SQL Server backup file changed size.', { category: 'integrity' });
        for (const kind of ['header', 'files', 'verify']) await session.run(remoteSqlcmdCommand(execution, targetConnections.connectionConfig, wrapper, passwordFile, mediaValidationStatement(remotePath, kind)), { stdoutLimitBytes: 16 * 1024 * 1024, stderrLimitBytes: 4 * 1024 * 1024 });
        item.remotePath = remotePath; progress.itemsCompleted += 1; progress.updatedAt = this.clock();
        await this.project(workspaceId, restoreRunId, { state: 'running', progress: { ...progress, phase: 'materializing' } }, actorId);
      }
      const full = files[0];
      const listed = await session.run(remoteSqlcmdCommand(execution, targetConnections.connectionConfig, wrapper, passwordFile, fileListQuery(full.remotePath, full.metadata.backup.position)), { stdoutLimitBytes: 4 * 1024 * 1024 });
      const moves = relocationPlan(parseFileList(listed.stdout), execution, restoreRunId);
      for (const move of moves) await session.run(commandFromArgs('test', ['!', '-e', move.targetPath], { privilegeMode: execution.privilegeMode }), { stdoutLimitBytes: 1024 }).catch(() => { throw new SqlServerRestoreError('SQLSERVER_RESTORE_FILE_COLLISION', 'A planned SQL Server restore file already exists.', { category: 'conflict' }); });
      progress.phase = 'restoring'; progress.updatedAt = this.clock(); await this.project(workspaceId, restoreRunId, { state: 'running', progress }, actorId);
      for (let index = 0; index < files.length; index += 1) {
        const item = files[index]; const final = index === files.length - 1;
        const stopAt = final && item.metadata.backup.type === 'log' && request.recoveryTarget.type === 'time' ? request.recoveryTarget.value : null;
        await session.run(remoteSqlcmdCommand(execution, targetConnections.connectionConfig, wrapper, passwordFile, restoreStatement(targetDatabase, item.remotePath, item.metadata.backup, { moves: index === 0 ? moves : [], recovery: final, stopAt })), { stdoutLimitBytes: 4 * 1024 * 1024, stderrLimitBytes: 4 * 1024 * 1024 });
      }
      if (request.deepValidation) await session.run(remoteSqlcmdCommand(execution, targetConnections.connectionConfig, wrapper, passwordFile, deepValidationQuery(targetDatabase)), { stdoutLimitBytes: 4 * 1024 * 1024, stderrLimitBytes: 4 * 1024 * 1024 });
      progress.phase = 'validating'; progress.updatedAt = this.clock(); await this.project(workspaceId, restoreRunId, { state: 'validating', progress }, actorId);
      const databaseResult = await this.adapter.runQuery({ resolveSecret: (secretRefId) => this.secretStore.resolve({ workspaceId, id: secretRefId }), signal }, targetConnections.connectionConfig, `SET NOCOUNT ON; DECLARE @db sysname = CONVERT(sysname, ${sqlUnicodeLiteral(targetDatabase)}); SELECT name, state_desc AS state, recovery_model_desc AS recoveryModel FROM sys.databases WHERE name=@db FOR JSON PATH, WITHOUT_ARRAY_WRAPPER;`, { operation: 'restore validation' });
      const restored = parseJsonResult(databaseResult.stdout, 'SQL Server restored database validation');
      if (restored.name !== targetDatabase || restored.state !== 'ONLINE') throw new SqlServerRestoreError('SQLSERVER_RESTORE_VALIDATION_FAILED', 'The restored SQL Server database did not reach the online state.', { category: 'integrity' });
      const validation = { state: 'succeeded', nativeIntegrityValidation: true, checkedAt: this.clock(), checks: [{ id: 'media', status: 'pass' }, { id: 'restore-sequence', status: 'pass' }, { id: 'connectivity', status: 'pass' }, { id: 'database-online', status: 'pass' }, ...(request.deepValidation ? [{ id: 'dbcc-physical', status: 'pass' }] : [])], database: targetDatabase, recoveryModel: restored.recoveryModel };
      progress.phase = 'complete'; progress.updatedAt = this.clock();
      return this.project(workspaceId, restoreRunId, { state: 'succeeded', progress, validation, result: { restoredRecoveryPointIds: chain.chain.map((point) => point.id), chainRootRecoveryPointId: chain.rootId, tailRecoveryPointId: selectedPoint.id !== request.recoveryPointId ? selectedPoint.id : null, database: targetDatabase, bytesRestored: progress.bytesWritten, recoveryTarget: request.recoveryTarget, completedAt: this.clock() } }, actorId);
    } catch (error) {
      const current = await this.controlDatabase.repository('restoreRun').get(workspaceId, restoreRunId);
      if (current && !TERMINAL_STATES.has(current.state)) {
        const canceled = signal?.aborted || error?.code === 'SSH_EXECUTION_CANCELED';
        return this.project(workspaceId, restoreRunId, { state: canceled ? 'canceled' : 'failed', progress: { ...progress, phase: canceled ? 'canceled' : 'failed', updatedAt: this.clock() }, result: { error: canceled ? { code: 'SQLSERVER_RESTORE_CANCELED', category: 'canceled', retryable: false, safeMessage: 'The SQL Server restore was canceled.' } : safeError(error), completedAt: this.clock() } }, actorId);
      }
      throw error;
    } finally {
      if (session) for (const media of stagedPaths) await session.run(commandFromArgs(execution?.rmExecutable || 'rm', ['-f', '--', media], { privilegeMode: execution?.privilegeMode || 'direct' }), { stdoutLimitBytes: 1024, ignoreAbort: true }).catch(() => {});
      if (session && remoteWorkspace && path.posix.basename(remoteWorkspace).startsWith('deployerx-sqlserver-restore-')) await session.run(commandFromArgs('rm', ['-rf', '--', remoteWorkspace]), { stdoutLimitBytes: 1024, ignoreAbort: true }).catch(() => {});
      session?.close();
    }
  }
}

module.exports = {
  DAMAGED_TAIL_CONFIRMATION,
  RESTORE_CONFIRMATIONS,
  SqlServerRestoreError,
  SqlServerRestoreService,
  TAIL_CONFIRMATION,
  deepValidationQuery,
  fileListQuery,
  normalizeRecoveryTarget,
  normalizeRequest,
  parseFileList,
  relocationPlan,
  restoreStatement,
  targetPreflightQuery,
  validateChain
};
