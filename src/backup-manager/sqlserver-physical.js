const crypto = require('crypto');
const path = require('path');
const { normalizeDatabaseName, instanceFingerprint, parseJsonResult, parseServerVersion, sqlcmdArguments } = require('./sqlserver');
const { commandFromArgs, connectionConfigFromRecord, openSshExecutionSession } = require('./ssh-execution');

const PHYSICAL_FORMAT_VERSION = 1;
const MAX_SQLSERVER_BACKUP_BYTES = 128 * 1024 * 1024 * 1024 * 1024;
const BACKUP_TYPES = new Set(['full', 'differential', 'log', 'tail-log']);

class SqlServerPhysicalError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'SqlServerPhysicalError';
    this.code = code;
    this.category = options.category || 'physical-backup';
    this.retryable = Boolean(options.retryable);
  }
}

function requiredText(value, label, maximumLength = 4096) {
  const text = String(value ?? '').trim();
  if (!text || text.includes('\0') || text.length > maximumLength) throw new TypeError(`${label} is invalid.`);
  return text;
}

function normalizeRemotePath(value, label) {
  const candidate = path.posix.normalize(requiredText(value, label, 4096));
  const normalized = candidate.length > 1 ? candidate.replace(/\/$/, '') : candidate;
  if (!normalized.startsWith('/') || normalized === '/' || normalized.split('/').includes('..')) throw new SqlServerPhysicalError('SQLSERVER_REMOTE_PATH_INVALID', `${label} is unsafe.`, { category: 'validation' });
  return normalized;
}

function sqlUnicodeLiteral(value) {
  const bytes = Buffer.from(String(value), 'utf16le').toString('hex').toUpperCase();
  return `CONVERT(nvarchar(max), 0x${bytes})`;
}

function selectedDatabase(selector) {
  const objectRules = (selector?.databases?.exclude?.length || 0) + (selector?.schemas?.include?.length || 0) + (selector?.schemas?.exclude?.length || 0)
    + (selector?.tables?.include?.length || 0) + (selector?.tables?.exclude?.length || 0) + Number(Boolean(selector?.includeGlobalObjects));
  const included = selector?.databases?.include || [];
  if (selector?.kind !== 'database-objects' || selector.allDatabases || included.length !== 1 || objectRules) throw new SqlServerPhysicalError('SQLSERVER_SELECTION_UNSUPPORTED', 'SQL Server native backup requires exactly one selected user database without object filters.', { category: 'compatibility' });
  return normalizeDatabaseName(included[0].name);
}

function parseSqlcmdVersion(value) {
  const text = requiredText(value, 'sqlcmd version output', 8192);
  const match = /(?:Version\s+)?(\d+)[.](\d+)(?:[.](\d+))?/i.exec(text);
  const major = Number(match?.[1]);
  if (!match || major < 18 || major > 30) throw new SqlServerPhysicalError('SQLSERVER_SQLCMD_UNSUPPORTED', 'Microsoft sqlcmd 18 or newer is required.', { category: 'compatibility' });
  return { name: 'sqlcmd', version: `${major}.${Number(match[2])}.${Number(match[3] || 0)}`, major, text: text.slice(0, 300) };
}

function preflightQuery(database) {
  const literal = sqlUnicodeLiteral(database);
  return `SET NOCOUNT ON;
DECLARE @db sysname = CONVERT(sysname, ${literal});
SELECT
  CONVERT(nvarchar(128), SERVERPROPERTY('ServerName')) AS serverName,
  CONVERT(nvarchar(128), SERVERPROPERTY('MachineName')) AS machineName,
  CONVERT(nvarchar(128), SERVERPROPERTY('InstanceName')) AS instanceName,
  CONVERT(varchar(100), SERVERPROPERTY('ProductVersion')) AS productVersion,
  CONVERT(nvarchar(128), SERVERPROPERTY('Edition')) AS edition,
  CONVERT(int, SERVERPROPERTY('EngineEdition')) AS engineEdition,
  h.host_platform AS hostPlatform,
  ISNULL(IS_SRVROLEMEMBER('sysadmin'), 0) AS isSysadmin,
  d.name AS databaseName,
  d.state_desc AS databaseState,
  d.recovery_model_desc AS recoveryModel,
  d.compatibility_level AS compatibilityLevel,
  d.is_read_only AS isReadOnly,
  CASE WHEN d.source_database_id IS NULL THEN CAST(0 AS bit) ELSE CAST(1 AS bit) END AS isSnapshot,
  CONVERT(varchar(36), drs.database_guid) AS databaseGuid,
  CONVERT(varchar(36), drs.family_guid) AS familyGuid,
  CASE WHEN EXISTS (SELECT 1 FROM sys.availability_databases_cluster adc WHERE adc.database_name = d.name) THEN CAST(1 AS bit) ELSE CAST(0 AS bit) END AS inAvailabilityGroup,
  CONVERT(varchar(130), dek.encryptor_thumbprint, 2) AS tdeThumbprint
FROM sys.dm_os_host_info h
JOIN sys.databases d ON d.name = @db
LEFT JOIN sys.database_recovery_status drs ON drs.database_id = d.database_id
LEFT JOIN sys.dm_database_encryption_keys dek ON dek.database_id = d.database_id AND dek.encryption_state <> 1
FOR JSON PATH, WITHOUT_ARRAY_WRAPPER;`;
}

function backupStatement(database, mediaPath, type, options = {}) {
  if (!BACKUP_TYPES.has(type)) throw new TypeError('SQL Server backup type is invalid.');
  const databaseLiteral = sqlUnicodeLiteral(database);
  const pathLiteral = sqlUnicodeLiteral(mediaPath);
  const operation = type === 'log' ? 'LOG' : 'DATABASE';
  const nativeOperation = type === 'tail-log' ? 'LOG' : operation;
  const differential = type === 'differential' ? ', DIFFERENTIAL' : '';
  const compression = options.compression === false ? '' : ', COMPRESSION';
  const tailMode = String(options.tailMode || 'online');
  const tail = type !== 'tail-log' ? '' : tailMode === 'online' ? ', NORECOVERY' : tailMode === 'offline' ? ', NO_TRUNCATE' : tailMode === 'damaged' ? ', NO_TRUNCATE, CONTINUE_AFTER_ERROR' : null;
  if (tail === null) throw new TypeError('SQL Server tail-log mode is invalid.');
  return `SET NOCOUNT ON;
DECLARE @db sysname = CONVERT(sysname, ${databaseLiteral});
DECLARE @path nvarchar(4000) = ${pathLiteral};
IF DB_ID(@db) IS NULL THROW 51000, 'Protected database is unavailable.', 1;
DECLARE @sql nvarchar(max) = N'BACKUP ${nativeOperation} ' + QUOTENAME(@db) + N' TO DISK = ' + QUOTENAME(@path, '''') + N' WITH INIT, CHECKSUM, STATS = 5${differential}${compression}${tail}';
EXEC sys.sp_executesql @sql;`;
}

function mediaValidationStatement(mediaPath, kind) {
  const pathLiteral = sqlUnicodeLiteral(mediaPath);
  const operation = kind === 'header' ? 'HEADERONLY' : kind === 'files' ? 'FILELISTONLY' : 'VERIFYONLY';
  const checksum = kind === 'verify' ? ' WITH CHECKSUM' : '';
  return `DECLARE @path nvarchar(4000) = ${pathLiteral}; RESTORE ${operation} FROM DISK = @path${checksum};`;
}

function metadataQuery(mediaPath) {
  const literal = sqlUnicodeLiteral(mediaPath);
  return `SET NOCOUNT ON;
DECLARE @path nvarchar(4000) = ${literal};
SELECT TOP (1)
  bs.database_name AS databaseName,
  bs.type AS backupTypeCode,
  bs.backup_start_date AS backupStartTime,
  bs.backup_finish_date AS backupFinishTime,
  CONVERT(varchar(40), bs.first_lsn) AS firstLsn,
  CONVERT(varchar(40), bs.last_lsn) AS lastLsn,
  CONVERT(varchar(40), bs.checkpoint_lsn) AS checkpointLsn,
  CONVERT(varchar(40), bs.database_backup_lsn) AS databaseBackupLsn,
  CONVERT(varchar(40), bs.differential_base_lsn) AS differentialBaseLsn,
  CONVERT(varchar(36), bs.differential_base_guid) AS differentialBaseGuid,
  CONVERT(varchar(36), bs.backup_set_uuid) AS backupSetGuid,
  CONVERT(varchar(36), bs.family_guid) AS familyGuid,
  CONVERT(varchar(36), bs.first_recovery_fork_guid) AS firstRecoveryForkId,
  CONVERT(varchar(36), bs.last_recovery_fork_guid) AS recoveryForkId,
  CONVERT(varchar(40), bs.fork_point_lsn) AS forkPointLsn,
  bs.recovery_model AS recoveryModel,
  bs.has_backup_checksums AS hasBackupChecksums,
  bs.begins_log_chain AS beginsLogChain,
  bs.is_copy_only AS isCopyOnly,
  bs.has_bulk_logged_data AS hasBulkLoggedData,
  bs.has_incomplete_metadata AS hasIncompleteMetadata,
  bs.is_damaged AS isDamaged,
  bs.position AS position,
  bs.server_name AS serverName,
  bs.machine_name AS machineName,
  bs.database_version AS databaseVersion,
  bs.compatibility_level AS compatibilityLevel,
  bs.software_major_version AS softwareMajorVersion,
  bs.software_minor_version AS softwareMinorVersion,
  bs.software_build_version AS softwareBuildVersion,
  bmf.media_family_id AS mediaFamilyId,
  bmf.physical_device_name AS physicalDeviceName
FROM msdb.dbo.backupset bs
JOIN msdb.dbo.backupmediafamily bmf ON bmf.media_set_id = bs.media_set_id
WHERE bmf.physical_device_name = @path
ORDER BY bs.backup_finish_date DESC
FOR JSON PATH, WITHOUT_ARRAY_WRAPPER;`;
}

function booleanValue(value) { return value === true || value === 1 || value === '1'; }

function normalizeHeader(input = {}) {
  const typeByCode = { D: 'full', I: 'differential', L: 'log' };
  const type = typeByCode[String(input.backupTypeCode || '')];
  if (!type) throw new SqlServerPhysicalError('SQLSERVER_BACKUP_HEADER_INVALID', 'SQL Server returned an unsupported backup-set type.', { category: 'integrity' });
  const guid = (value) => value ? requiredText(value, 'SQL Server backup GUID', 64).toLowerCase() : null;
  const lsn = (value) => value === null || value === undefined || value === '' ? null : requiredText(value, 'SQL Server backup LSN', 50);
  return {
    type, databaseName: normalizeDatabaseName(input.databaseName), backupStartTime: requiredText(input.backupStartTime, 'Backup start time', 100), backupFinishTime: requiredText(input.backupFinishTime, 'Backup finish time', 100),
    firstLsn: lsn(input.firstLsn), lastLsn: lsn(input.lastLsn), checkpointLsn: lsn(input.checkpointLsn), databaseBackupLsn: lsn(input.databaseBackupLsn), differentialBaseLsn: lsn(input.differentialBaseLsn),
    differentialBaseGuid: guid(input.differentialBaseGuid), backupSetGuid: guid(input.backupSetGuid), familyGuid: guid(input.familyGuid), firstRecoveryForkId: guid(input.firstRecoveryForkId), recoveryForkId: guid(input.recoveryForkId), forkPointLsn: lsn(input.forkPointLsn),
    recoveryModel: requiredText(input.recoveryModel, 'SQL Server recovery model', 30).toUpperCase(), hasBackupChecksums: booleanValue(input.hasBackupChecksums), beginsLogChain: booleanValue(input.beginsLogChain),
    isCopyOnly: booleanValue(input.isCopyOnly), hasBulkLoggedData: booleanValue(input.hasBulkLoggedData), hasIncompleteMetadata: booleanValue(input.hasIncompleteMetadata), isDamaged: booleanValue(input.isDamaged),
    position: Number(input.position), serverName: requiredText(input.serverName, 'SQL Server backup server', 128), machineName: requiredText(input.machineName, 'SQL Server backup machine', 128),
    databaseVersion: Number(input.databaseVersion), compatibilityLevel: Number(input.compatibilityLevel), softwareVersion: `${Number(input.softwareMajorVersion)}.${Number(input.softwareMinorVersion)}.${Number(input.softwareBuildVersion)}`,
    mediaFamilyId: guid(input.mediaFamilyId), physicalDeviceName: requiredText(input.physicalDeviceName, 'SQL Server media path', 4096)
  };
}

function validateHeader(header, expected = {}) {
  if (header.type !== expected.type || header.databaseName !== expected.database || header.physicalDeviceName !== expected.mediaPath) throw new SqlServerPhysicalError('SQLSERVER_BACKUP_HEADER_MISMATCH', 'SQL Server backup media does not match the requested database, type, or path.', { category: 'integrity' });
  if (!header.hasBackupChecksums || header.isCopyOnly || (header.isDamaged && !expected.allowDamaged) || (header.hasIncompleteMetadata && !expected.allowIncompleteMetadata) || !header.backupSetGuid || !header.familyGuid || !header.firstLsn || !header.lastLsn) throw new SqlServerPhysicalError('SQLSERVER_BACKUP_HEADER_UNSAFE', 'SQL Server backup media lacks required checksum, identity, or LSN evidence.', { category: 'integrity' });
  if (expected.type === 'differential' && (!expected.base || header.differentialBaseGuid !== expected.base.backup?.backupSetGuid || header.familyGuid !== expected.base.backup?.familyGuid)) throw new SqlServerPhysicalError('SQLSERVER_DIFFERENTIAL_BASE_MISMATCH', 'The SQL Server differential does not match its authenticated full base.', { category: 'integrity' });
  if (expected.type === 'log' && !['FULL', 'BULK-LOGGED'].includes(header.recoveryModel)) throw new SqlServerPhysicalError('SQLSERVER_LOG_RECOVERY_MODEL_INVALID', 'SQL Server transaction-log backup requires Full or Bulk-Logged recovery.', { category: 'consistency' });
  if (expected.previous?.backup?.recoveryForkId && header.firstRecoveryForkId && header.firstRecoveryForkId !== expected.previous.backup.recoveryForkId && header.recoveryForkId !== expected.previous.backup.recoveryForkId) throw new SqlServerPhysicalError('SQLSERVER_LOG_RECOVERY_FORK_MISMATCH', 'The SQL Server transaction-log recovery fork changed.', { category: 'integrity' });
}

function validatePreflight(input, expected = {}) {
  const version = parseServerVersion(input.productVersion);
  if (String(input.hostPlatform).toLowerCase() !== 'linux') throw new SqlServerPhysicalError('SQLSERVER_PLATFORM_UNSUPPORTED', 'SQL Server native backup currently requires SQL Server on Linux.', { category: 'compatibility' });
  if (Number(input.isSysadmin) !== 1) throw new SqlServerPhysicalError('SQLSERVER_SYSADMIN_REQUIRED', 'The SQL Server login must be a sysadmin for native backup and restore.', { category: 'authorization' });
  const permittedState = expected.tailMode === 'offline'
    ? ['OFFLINE', 'RECOVERY_PENDING'].includes(input.databaseState)
    : expected.tailMode === 'damaged'
      ? ['ONLINE', 'SUSPECT', 'EMERGENCY', 'RECOVERY_PENDING'].includes(input.databaseState)
      : input.databaseState === 'ONLINE';
  if (input.databaseName !== expected.database || !permittedState || booleanValue(input.isReadOnly) || booleanValue(input.isSnapshot)) throw new SqlServerPhysicalError('SQLSERVER_DATABASE_NOT_BACKUP_READY', 'The selected SQL Server database state is not valid for this native backup operation.', { category: 'consistency' });
  if (booleanValue(input.inAvailabilityGroup)) throw new SqlServerPhysicalError('SQLSERVER_AVAILABILITY_GROUP_UNSUPPORTED', 'SQL Server availability-group databases are not supported in this release.', { category: 'compatibility' });
  const fingerprint = instanceFingerprint(expected.connectionConfig, input);
  if (fingerprint !== expected.instanceFingerprint) throw new SqlServerPhysicalError('SQLSERVER_INSTANCE_PAIR_MISMATCH', 'The paired SSH host reaches a different SQL Server instance.', { category: 'integrity' });
  return { ...input, version, instanceFingerprint: fingerprint, recoveryModel: String(input.recoveryModel || '').toUpperCase(), databaseGuid: requiredText(input.databaseGuid, 'SQL Server database GUID', 64).toLowerCase(), familyGuid: requiredText(input.familyGuid, 'SQL Server database family GUID', 64).toLowerCase(), tdeThumbprint: input.tdeThumbprint || null };
}

function passwordWrapper() {
  return "#!/bin/sh\nIFS= read -r SQLCMDPASSWORD < \"$1\" || exit 71\nexport SQLCMDPASSWORD\nshift\nexec \"$@\"\n";
}

function remoteSqlcmdCommand(execution, connectionConfig, wrapper, passwordFile, query) {
  return commandFromArgs(wrapper, [passwordFile, execution.sqlcmdExecutable, ...sqlcmdArguments(connectionConfig, query)]);
}

function newest(points, predicate) {
  return points.filter(predicate).sort((left, right) => String(right.backup?.backupFinishTime || '').localeCompare(String(left.backup?.backupFinishTime || '')))[0] || null;
}

class SqlServerPhysicalBackupService {
  constructor({ controlDatabase, secretStore, deviceId, sessionFactory = openSshExecutionSession } = {}) {
    if (!controlDatabase || !secretStore) throw new TypeError('SQL Server physical backup dependencies are required.');
    this.controlDatabase = controlDatabase;
    this.secretStore = secretStore;
    this.deviceId = requiredText(deviceId, 'Device ID', 200);
    this.sessionFactory = sessionFactory;
  }

  async previousMetadata(workspaceId, plan, database, jobId) {
    const artifacts = await this.controlDatabase.repository('artifact').list(workspaceId, { limit: 5000 });
    return artifacts.filter((artifact) => ['physical-backup', 'transaction-log'].includes(artifact.kind))
      .map((artifact) => ({ recoveryPointId: artifact.recoveryPointId, ...artifact.metadata }))
      .filter((metadata) => metadata.kind === 'sqlserver-native' && metadata.source?.sourceId === plan.source.id && metadata.source?.jobId === jobId && metadata.database?.name === database);
  }

  async prepare(workspaceId, executionId, plan, options = {}) {
    const database = selectedDatabase(plan.source.selector);
    const requestedMode = String(options.backupMode || 'full');
    const type = requestedMode === 'incremental' ? 'log' : requestedMode;
    if (!BACKUP_TYPES.has(type)) throw new SqlServerPhysicalError('SQLSERVER_BACKUP_TYPE_UNSUPPORTED', 'Choose full, differential, or transaction-log backup.', { category: 'validation' });
    const execution = plan.source.physicalExecution;
    if (!execution || execution.engine !== 'sqlserver' || plan.source.consistency?.backupMethod !== 'physical') throw new SqlServerPhysicalError('SQLSERVER_PHYSICAL_SOURCE_INVALID', 'The SQL Server Source is not configured for native backup.', { category: 'validation' });
    const sshConnection = await this.controlDatabase.repository('connection').get(workspaceId, execution.sshConnectionId);
    if (!sshConnection || sshConnection.adapterId !== 'deployerx.connection.ssh' || sshConnection.lastTest?.status !== 'success') throw new SqlServerPhysicalError('SQLSERVER_SSH_UNHEALTHY', 'Retest the paired SSH execution connection before backup.', { category: 'connectivity', retryable: true });
    if (!(sshConnection.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new SqlServerPhysicalError('SQLSERVER_PHYSICAL_OTHER_DEVICE', 'The paired SSH execution connection belongs to another device.', { category: 'authorization' });
    const testedFingerprint = requiredText(plan.connection.lastTest?.endpointIdentity?.instanceFingerprint, 'Tested SQL Server instance fingerprint', 200);
    const session = await this.sessionFactory({ connectionConfig: connectionConfigFromRecord(sshConnection), resolveSecret: (secretRefId) => this.secretStore.resolve({ workspaceId, id: secretRefId }), signal: options.signal });
    let remoteWorkspace = null;
    let mediaPath = null;
    try {
      const temporaryRoot = normalizeRemotePath(execution.remoteTemporaryDirectory, 'Remote temporary directory');
      const backupRoot = normalizeRemotePath(execution.backupDirectory, 'SQL Server backup directory');
      const created = await session.run(commandFromArgs('mktemp', ['-d', '-p', temporaryRoot, `deployerx-sqlserver-${String(executionId).slice(0, 24)}.XXXXXX`]), { stdoutLimitBytes: 8192 });
      remoteWorkspace = normalizeRemotePath(created.stdout.trim(), 'Allocated SQL Server workspace');
      if (path.posix.dirname(remoteWorkspace) !== temporaryRoot || !path.posix.basename(remoteWorkspace).startsWith('deployerx-sqlserver-')) throw new SqlServerPhysicalError('SQLSERVER_WORKSPACE_INVALID', 'The remote temporary workspace is outside the approved root.', { category: 'integrity' });
      await session.run(commandFromArgs('test', ['-d', backupRoot]), { stdoutLimitBytes: 1024 });
      const passwordFile = path.posix.join(remoteWorkspace, 'sqlcmd-password');
      const wrapper = path.posix.join(remoteWorkspace, 'sqlcmd-wrapper');
      const [passwordSecretRefId] = plan.connection.secretRefIds || [];
      const password = String(await this.secretStore.resolve({ workspaceId, id: passwordSecretRefId }));
      if (!password || password.includes('\0') || /[\r\n]/.test(password)) throw new SqlServerPhysicalError('SQLSERVER_PASSWORD_INVALID', 'The SQL Server password cannot be represented safely.', { category: 'authentication' });
      await session.writeFile(passwordFile, `${password}\n`, { mode: 0o600 });
      await session.writeFile(wrapper, passwordWrapper(), { mode: 0o700 });
      const [preflightResult, toolResult] = await Promise.all([
        session.run(remoteSqlcmdCommand(execution, plan.connectionConfig, wrapper, passwordFile, preflightQuery(database)), { stdoutLimitBytes: 1024 * 1024 }),
        session.run(commandFromArgs(execution.sqlcmdExecutable, ['-?']), { stdoutLimitBytes: 1024 * 1024 })
      ]);
      const preflight = validatePreflight(parseJsonResult(preflightResult.stdout, 'SQL Server backup preflight'), { database, connectionConfig: plan.connectionConfig, instanceFingerprint: testedFingerprint, tailMode: type === 'tail-log' ? String(options.tailMode || 'online') : null });
      const tool = parseSqlcmdVersion(`${toolResult.stdout}\n${toolResult.stderr}`);
      const prior = await this.previousMetadata(workspaceId, plan, database, options.jobId);
      const sameDatabase = (metadata) => metadata.database?.databaseGuid === preflight.databaseGuid && metadata.database?.familyGuid === preflight.familyGuid && metadata.server?.instanceFingerprint === preflight.instanceFingerprint;
      const base = newest(prior, (metadata) => sameDatabase(metadata) && metadata.backup?.type === 'full' && !metadata.backup?.isCopyOnly);
      const previousLog = newest(prior, (metadata) => sameDatabase(metadata) && metadata.backup?.type === 'log');
      if (type === 'differential' && !base) throw new SqlServerPhysicalError('SQLSERVER_DIFFERENTIAL_BASE_REQUIRED', 'Create a conventional SQL Server full backup before a differential backup.', { category: 'consistency' });
      if (['log', 'tail-log'].includes(type) && !base) throw new SqlServerPhysicalError('SQLSERVER_LOG_ANCHOR_REQUIRED', 'Create a SQL Server full backup before transaction-log capture.', { category: 'consistency' });
      if (['log', 'tail-log'].includes(type) && !['FULL', 'BULK_LOGGED', 'BULK-LOGGED'].includes(preflight.recoveryModel)) throw new SqlServerPhysicalError('SQLSERVER_LOG_RECOVERY_MODEL_INVALID', 'SQL Server transaction-log backup requires Full or Bulk-Logged recovery.', { category: 'consistency' });
      const previous = ['log', 'tail-log'].includes(type) ? previousLog || base : type === 'differential' ? base : null;
      const suffix = ['log', 'tail-log'].includes(type) ? 'trn' : 'bak';
      const token = crypto.createHash('sha256').update(`${executionId}\0${database}\0${type}`).digest('hex').slice(0, 24);
      mediaPath = path.posix.join(backupRoot, `deployerx-${token}.${suffix}`);
      await session.run(remoteSqlcmdCommand(execution, plan.connectionConfig, wrapper, passwordFile, backupStatement(database, mediaPath, type, { compression: options.compression !== false, tailMode: options.tailMode })), { stdoutLimitBytes: 4 * 1024 * 1024, stderrLimitBytes: 4 * 1024 * 1024 });
      for (const kind of ['header', 'files', 'verify']) await session.run(remoteSqlcmdCommand(execution, plan.connectionConfig, wrapper, passwordFile, mediaValidationStatement(mediaPath, kind)), { stdoutLimitBytes: 16 * 1024 * 1024, stderrLimitBytes: 4 * 1024 * 1024 });
      const metadataResult = await session.run(remoteSqlcmdCommand(execution, plan.connectionConfig, wrapper, passwordFile, metadataQuery(mediaPath)), { stdoutLimitBytes: 1024 * 1024 });
      const header = normalizeHeader(parseJsonResult(metadataResult.stdout, 'SQL Server backup metadata'));
      const damagedTail = type === 'tail-log' && String(options.tailMode || '') === 'damaged';
      validateHeader(header, { type: type === 'tail-log' ? 'log' : type, database, mediaPath, base, previous, allowDamaged: damagedTail, allowIncompleteMetadata: damagedTail });
      if (header.familyGuid !== preflight.familyGuid) throw new SqlServerPhysicalError('SQLSERVER_DATABASE_FAMILY_MISMATCH', 'The SQL Server backup family identity changed during capture.', { category: 'integrity' });
      const statResult = await session.run(commandFromArgs(execution.statExecutable, ['--printf=%s', '--', mediaPath], { privilegeMode: execution.privilegeMode }), { stdoutLimitBytes: 8192 });
      const sizeBytes = Number(String(statResult.stdout).trim());
      if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > MAX_SQLSERVER_BACKUP_BYTES) throw new SqlServerPhysicalError('SQLSERVER_BACKUP_SIZE_INVALID', 'The SQL Server backup media size is invalid or exceeds the supported limit.', { category: 'capacity' });
      const artifactPath = `sqlserver/${crypto.createHash('sha256').update(database).digest('hex').slice(0, 16)}/${type}-${header.backupSetGuid}.${suffix}`;
      const chainRootRecoveryPointId = type === 'full' ? null : base.recoveryPointId;
      const parentRecoveryPointId = type === 'full' ? null : previous.recoveryPointId;
      const databaseManifest = {
        version: PHYSICAL_FORMAT_VERSION, kind: 'sqlserver-native', adapterId: plan.source.adapterId, adapterVersion: plan.manifest.adapterVersion,
        engine: 'sqlserver', backupMethod: 'physical', backupMode: requestedMode,
        selection: plan.source.selector, selectionDigest: plan.source.selector.digest,
        consistency: { requestedLevel: 'application', achievedLevel: 'application', backupMethod: 'physical', backupMode: requestedMode, method: 'sql-server-native-backup', captureCoordinates: true, proven: true },
        server: { instanceFingerprint: preflight.instanceFingerprint, serverName: preflight.serverName, machineName: preflight.machineName, instanceName: preflight.instanceName || null, version: preflight.version.text, major: preflight.version.major, edition: preflight.edition, platform: 'linux' },
        database: { name: database, databaseGuid: preflight.databaseGuid, familyGuid: preflight.familyGuid, recoveryModel: preflight.recoveryModel, compatibilityLevel: Number(preflight.compatibilityLevel), tdeThumbprint: preflight.tdeThumbprint },
        backup: { ...header, tail: type === 'tail-log', tailMode: type === 'tail-log' ? String(options.tailMode || 'online') : null },
        source: { sourceId: plan.source.id, jobId: options.jobId, sqlServerConnectionId: plan.connection.id, sqlServerConnectionRevision: plan.connection.revision, sshConnectionId: plan.executionConnection?.id, sshConnectionRevision: plan.executionConnection?.revision },
        tools: { sqlcmd: tool },
        chain: { chainRootRecoveryPointId, parentRecoveryPointId, fullBaseRecoveryPointId: type === 'full' ? null : base.recoveryPointId },
        restore: { dataDirectory: execution.dataDirectory, logDirectory: execution.logDirectory, privilegeMode: execution.privilegeMode },
        artifact: { kind: ['log', 'tail-log'].includes(type) ? 'transaction-log' : 'physical-backup', path: artifactPath, mediaType: 'application/octet-stream', sizeBytes }
      };
      return { session, remoteWorkspace, mediaPath, execution, artifactPath, databaseManifest, sizeBytes, content: () => this.streamMedia(session, execution, mediaPath, artifactPath, sizeBytes, options) };
    } catch (error) {
      if (mediaPath) await session.run(commandFromArgs(execution.rmExecutable, ['-f', '--', mediaPath], { privilegeMode: execution.privilegeMode }), { stdoutLimitBytes: 1024, ignoreAbort: true }).catch(() => {});
      if (remoteWorkspace) await this.cleanupWorkspace(session, remoteWorkspace).catch(() => {});
      session.close();
      if (error instanceof SqlServerPhysicalError || error?.code) throw error;
      throw new SqlServerPhysicalError('SQLSERVER_BACKUP_FAILED', 'SQL Server native backup failed.', { category: 'execution', retryable: true });
    }
  }

  async *streamMedia(session, execution, mediaPath, artifactPath, expectedBytes, options = {}) {
    const opened = await session.stream(commandFromArgs(execution.ddExecutable, [`if=${mediaPath}`, 'bs=65536', 'status=none'], { privilegeMode: execution.privilegeMode }), { stderrLimitBytes: 4 * 1024 * 1024 });
    let sizeBytes = 0;
    try {
      for await (const rawChunk of opened.stdout) {
        const chunk = Buffer.from(rawChunk);
        sizeBytes += chunk.length;
        if (sizeBytes > expectedBytes || sizeBytes > MAX_SQLSERVER_BACKUP_BYTES) throw new SqlServerPhysicalError('SQLSERVER_BACKUP_STREAM_OVERRUN', 'The SQL Server backup stream exceeded its authenticated media size.', { category: 'integrity' });
        const paced = options.bandwidthLimiter ? await options.bandwidthLimiter.consume(chunk.length) : { limitBytesPerSecond: null, waitedMilliseconds: 0 };
        await options.onProgress?.({ phase: 'transferring', path: artifactPath, bytesRead: chunk.length, bandwidthLimitBytesPerSecond: paced.limitBytesPerSecond, throttleWaitMilliseconds: paced.waitedMilliseconds });
        yield chunk;
      }
      await opened.completion;
      if (sizeBytes !== expectedBytes) throw new SqlServerPhysicalError('SQLSERVER_BACKUP_STREAM_SIZE_MISMATCH', 'The SQL Server backup stream size changed after native verification.', { category: 'integrity' });
    } catch (error) { opened.close(); throw error; }
  }

  async cleanupWorkspace(session, remoteWorkspace) {
    const target = normalizeRemotePath(remoteWorkspace, 'Allocated SQL Server workspace');
    if (!path.posix.basename(target).startsWith('deployerx-sqlserver-')) throw new SqlServerPhysicalError('SQLSERVER_WORKSPACE_INVALID', 'Refusing to remove an unrecognized remote path.', { category: 'integrity' });
    await session.run(commandFromArgs('rm', ['-rf', '--', target]), { stdoutLimitBytes: 1024, ignoreAbort: true });
  }

  async release(prepared) {
    if (!prepared) return false;
    try {
      await prepared.session.run(commandFromArgs(prepared.execution.rmExecutable, ['-f', '--', prepared.mediaPath], { privilegeMode: prepared.execution.privilegeMode }), { stdoutLimitBytes: 1024, ignoreAbort: true });
      await this.cleanupWorkspace(prepared.session, prepared.remoteWorkspace);
    } finally { prepared.session.close(); }
    return true;
  }
}

module.exports = {
  BACKUP_TYPES,
  MAX_SQLSERVER_BACKUP_BYTES,
  PHYSICAL_FORMAT_VERSION,
  SqlServerPhysicalBackupService,
  SqlServerPhysicalError,
  backupStatement,
  mediaValidationStatement,
  metadataQuery,
  normalizeHeader,
  normalizeRemotePath,
  parseSqlcmdVersion,
  passwordWrapper,
  preflightQuery,
  remoteSqlcmdCommand,
  selectedDatabase,
  sqlUnicodeLiteral,
  validateHeader,
  validatePreflight
};
