const path = require('path');
const { optionFileContents } = require('./mysql-logical');
const { commandFromArgs, connectionConfigFromRecord, openSshExecutionSession } = require('./ssh-execution');

const PHYSICAL_FORMAT_VERSION = 1;
const MAX_PHYSICAL_BACKUP_BYTES = 128 * 1024 * 1024 * 1024 * 1024;
const REQUIRED_XTRABACKUP_PRIVILEGES = Object.freeze(['BACKUP_ADMIN', 'PROCESS', 'RELOAD', 'LOCK TABLES', 'REPLICATION CLIENT']);

class MysqlPhysicalError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'MysqlPhysicalError';
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

function decimalLsn(value, label) {
  const text = requiredText(value, label, 40);
  if (!/^\d+$/.test(text)) throw new MysqlPhysicalError('MYSQL_PHYSICAL_LSN_INVALID', `${label} is invalid.`, { category: 'integrity' });
  return BigInt(text).toString(10);
}

function parseXtrabackupVersion(value, tool = 'xtrabackup') {
  const text = requiredText(value, `${tool} version output`, 4096);
  const match = /(?:version|Ver)\s+8[.]4[.](\d+)/i.exec(text) || /\b8[.]4[.](\d+)\b/.exec(text);
  if (!match) throw new MysqlPhysicalError('MYSQL_PHYSICAL_TOOL_UNSUPPORTED', `${tool} 8.4 is required.`, { category: 'compatibility' });
  return { name: tool, version: `8.4.${Number(match[1])}`, text: text.slice(0, 300) };
}

function parseMysql84Version(value) {
  const text = requiredText(value, 'MySQL server version', 100);
  const match = /^(\d+)[.](\d+)[.](\d+)/.exec(text);
  if (!match || Number(match[1]) !== 8 || Number(match[2]) !== 4) throw new MysqlPhysicalError('MYSQL_PHYSICAL_SERVER_UNSUPPORTED', 'MySQL physical backup requires MySQL 8.4.x.', { category: 'compatibility' });
  return { text, major: 8, minor: 4, patch: Number(match[3]) };
}

function parseCheckpoints(value) {
  const fields = new Map();
  for (const line of String(value || '').split(/\r?\n/)) {
    const match = /^\s*([a-z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match) fields.set(match[1], match[2]);
  }
  const backupType = fields.get('backup_type');
  if (!['full-backuped', 'full-prepared', 'incremental'].includes(backupType)) throw new MysqlPhysicalError('MYSQL_PHYSICAL_CHECKPOINT_INVALID', 'XtraBackup checkpoint type is invalid.', { category: 'integrity' });
  const checkpoints = {
    backupType,
    fromLsn: decimalLsn(fields.get('from_lsn'), 'Physical backup from LSN'),
    toLsn: decimalLsn(fields.get('to_lsn'), 'Physical backup to LSN'),
    lastLsn: decimalLsn(fields.get('last_lsn'), 'Physical backup last LSN')
  };
  if (BigInt(checkpoints.toLsn) < BigInt(checkpoints.fromLsn) || BigInt(checkpoints.lastLsn) < BigInt(checkpoints.toLsn)) throw new MysqlPhysicalError('MYSQL_PHYSICAL_CHECKPOINT_INVALID', 'XtraBackup checkpoint LSN ordering is invalid.', { category: 'integrity' });
  return Object.freeze(checkpoints);
}

function validatePhysicalSelection(selector) {
  const childRules = (selector?.databases?.include?.length || 0) + (selector?.databases?.exclude?.length || 0)
    + (selector?.schemas?.include?.length || 0) + (selector?.schemas?.exclude?.length || 0)
    + (selector?.tables?.include?.length || 0) + (selector?.tables?.exclude?.length || 0);
  if (selector?.kind !== 'database-objects' || selector.allDatabases !== true || childRules || selector.includeGlobalObjects) {
    throw new MysqlPhysicalError('MYSQL_PHYSICAL_SELECTION_UNSUPPORTED', 'MySQL physical backup requires the whole instance without object filters.', { category: 'compatibility' });
  }
}

function grantsSatisfyXtrabackup(value) {
  const upper = String(value || '').toUpperCase();
  if (/GRANT\s+ALL\s+PRIVILEGES\s+ON\s+[*][.][*]/.test(upper)) return true;
  return REQUIRED_XTRABACKUP_PRIVILEGES.every((privilege) => new RegExp(`(?:^|[,\\s])${privilege.replace(' ', '\\s+')}(?:[,\\s]|ON)`).test(upper));
}

function validateIncrementalPredecessor(previousMetadata, expected = {}) {
  if (!previousMetadata || previousMetadata.kind !== 'mysql-xtrabackup') throw new MysqlPhysicalError('MYSQL_PHYSICAL_ANCHOR_REQUIRED', 'A valid MySQL physical full backup is required before an incremental backup.', { category: 'consistency' });
  if (previousMetadata.server?.serverUuid !== expected.serverUuid || previousMetadata.source?.sourceId !== expected.sourceId || previousMetadata.source?.jobId !== expected.jobId) {
    throw new MysqlPhysicalError('MYSQL_PHYSICAL_CHAIN_MISMATCH', 'The preceding physical backup belongs to a different MySQL instance, Source, or job.', { category: 'integrity' });
  }
  const toLsn = decimalLsn(previousMetadata.checkpoints?.toLsn, 'Preceding physical backup to LSN');
  return {
    toLsn,
    chainRootRecoveryPointId: requiredText(previousMetadata.chain?.chainRootRecoveryPointId || expected.previousRecoveryPointId, 'Physical chain root RecoveryPoint ID', 200)
  };
}

function normalizeRemotePath(value, label) {
  const candidate = path.posix.normalize(requiredText(value, label, 4096));
  const normalized = candidate.length > 1 ? candidate.replace(/\/$/, '') : candidate;
  if (!normalized.startsWith('/') || normalized === '/' || normalized.split('/').includes('..')) throw new MysqlPhysicalError('MYSQL_PHYSICAL_REMOTE_PATH_INVALID', `${label} is unsafe.`, { category: 'validation' });
  return normalized;
}

function mysqlQueryCommand(execution, optionFile, query) {
  return commandFromArgs(execution.mysqlExecutable, [
    `--defaults-extra-file=${optionFile}`,
    '--batch', '--skip-column-names', '--raw', `--execute=${query}`
  ], { privilegeMode: 'direct' });
}

class MysqlPhysicalBackupService {
  constructor({ controlDatabase, secretStore, deviceId, sessionFactory = openSshExecutionSession } = {}) {
    if (!controlDatabase || !secretStore) throw new TypeError('MySQL physical backup dependencies are required.');
    this.controlDatabase = controlDatabase;
    this.secretStore = secretStore;
    this.deviceId = requiredText(deviceId, 'Device ID', 200);
    this.sessionFactory = sessionFactory;
  }

  async #previousMetadata(workspaceId, previousRecoveryPoint) {
    if (!previousRecoveryPoint) return null;
    const artifacts = await this.controlDatabase.repository('artifact').list(workspaceId, { limit: 1000 });
    return artifacts.find((artifact) => artifact.recoveryPointId === previousRecoveryPoint.id && artifact.kind === 'physical-backup')?.metadata || null;
  }

  async prepare(workspaceId, executionId, plan, options = {}) {
    validatePhysicalSelection(plan.source.selector);
    const execution = plan.source.physicalExecution;
    if (!execution || plan.source.consistency?.backupMethod !== 'physical') throw new MysqlPhysicalError('MYSQL_PHYSICAL_SOURCE_INVALID', 'The MySQL Source is not configured for physical backup.', { category: 'validation' });
    const sshConnection = await this.controlDatabase.repository('connection').get(workspaceId, execution.sshConnectionId);
    if (!sshConnection || sshConnection.adapterId !== 'deployerx.connection.ssh') throw new MysqlPhysicalError('MYSQL_PHYSICAL_SSH_MISSING', 'The paired SSH execution connection is unavailable.', { category: 'not-found' });
    if (!(sshConnection.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new MysqlPhysicalError('MYSQL_PHYSICAL_OTHER_DEVICE', 'The paired SSH execution connection belongs to another device.', { category: 'authorization' });
    if (sshConnection.lastTest?.status !== 'success') throw new MysqlPhysicalError('MYSQL_PHYSICAL_SSH_UNHEALTHY', 'Test the paired SSH execution connection successfully before backup.', { category: 'connectivity', retryable: true });
    const serverUuid = requiredText(plan.connection.lastTest?.endpointIdentity?.serverUuid, 'Tested MySQL server UUID', 100);
    const sshConfig = connectionConfigFromRecord(sshConnection);
    const session = await this.sessionFactory({
      connectionConfig: sshConfig,
      resolveSecret: (secretRefId) => this.secretStore.resolve({ workspaceId, id: secretRefId }),
      signal: options.signal
    });
    let remoteWorkspace = null;
    try {
      const root = normalizeRemotePath(execution.remoteTemporaryDirectory, 'Remote temporary directory');
      const created = await session.run(commandFromArgs('mktemp', ['-d', '-p', root, `deployerx-xtrabackup-${String(executionId).slice(0, 24)}.XXXXXX`]), { stdoutLimitBytes: 8192 });
      remoteWorkspace = normalizeRemotePath(created.stdout.trim(), 'Allocated XtraBackup workspace');
      if (path.posix.dirname(remoteWorkspace) !== root || !path.posix.basename(remoteWorkspace).startsWith('deployerx-xtrabackup-')) throw new MysqlPhysicalError('MYSQL_PHYSICAL_WORKSPACE_INVALID', 'The remote temporary workspace is outside the approved root.', { category: 'integrity' });
      const optionFile = path.posix.join(remoteWorkspace, 'client.cnf');
      const [passwordSecretRefId] = plan.connection.secretRefIds || [];
      const password = await this.secretStore.resolve({ workspaceId, id: passwordSecretRefId });
      await session.writeFile(optionFile, optionFileContents(plan.connectionConfig, password), { mode: 0o600 });

      const [xtrabackupResult, xbstreamResult, identityResult, grantsResult] = await Promise.all([
        session.run(commandFromArgs(execution.xtrabackupExecutable, ['--version']), { stdoutLimitBytes: 8192 }),
        session.run(commandFromArgs(execution.xbstreamExecutable, ['--version']), { stdoutLimitBytes: 8192 }),
        session.run(mysqlQueryCommand(execution, optionFile, 'SELECT VERSION(), @@server_uuid, @@datadir;'), { stdoutLimitBytes: 8192 }),
        session.run(mysqlQueryCommand(execution, optionFile, 'SHOW GRANTS FOR CURRENT_USER();'), { stdoutLimitBytes: 1024 * 1024 })
      ]);
      const xtrabackup = parseXtrabackupVersion(`${xtrabackupResult.stdout}\n${xtrabackupResult.stderr}`, 'xtrabackup');
      const xbstream = parseXtrabackupVersion(`${xbstreamResult.stdout}\n${xbstreamResult.stderr}`, 'xbstream');
      const [remoteVersionText, remoteServerUuid, reportedDatadir] = identityResult.stdout.trim().split('\t');
      const mysqlVersion = parseMysql84Version(remoteVersionText);
      if (!remoteServerUuid || remoteServerUuid !== serverUuid) throw new MysqlPhysicalError('MYSQL_PHYSICAL_SERVER_PAIR_MISMATCH', 'The paired SSH host reaches a different MySQL server identity.', { category: 'integrity' });
      if (normalizeRemotePath(reportedDatadir, 'Reported MySQL data directory') !== normalizeRemotePath(execution.dataDirectory, 'Configured MySQL data directory')) throw new MysqlPhysicalError('MYSQL_PHYSICAL_DATADIR_MISMATCH', 'The configured MySQL datadir does not match the server-reported datadir.', { category: 'integrity' });
      if (!grantsSatisfyXtrabackup(grantsResult.stdout)) throw new MysqlPhysicalError('MYSQL_PHYSICAL_PRIVILEGE_MISSING', 'The MySQL account does not have the required XtraBackup privileges.', { category: 'authorization' });
      await session.run(commandFromArgs('test', ['-r', execution.dataDirectory]), { stdoutLimitBytes: 1024 });

      const incremental = options.backupMode === 'incremental';
      const previousMetadata = incremental ? await this.#previousMetadata(workspaceId, options.previousRecoveryPoint) : null;
      const predecessor = incremental ? validateIncrementalPredecessor(previousMetadata, {
        serverUuid,
        sourceId: plan.source.id,
        jobId: options.jobId,
        previousRecoveryPointId: options.previousRecoveryPoint?.id
      }) : null;
      const targetDirectory = path.posix.join(remoteWorkspace, 'data');
      const backupArgs = [`--defaults-extra-file=${optionFile}`, '--backup', `--target-dir=${targetDirectory}`, `--datadir=${execution.dataDirectory}`];
      if (incremental) backupArgs.push(`--incremental-lsn=${predecessor.toLsn}`);
      await options.onProgress?.({ phase: 'scanning', path: execution.dataDirectory });
      await session.run(commandFromArgs(execution.xtrabackupExecutable, backupArgs, { privilegeMode: execution.privilegeMode }), { stdoutLimitBytes: 4 * 1024 * 1024, stderrLimitBytes: 4 * 1024 * 1024 });
      const checkpointResult = await session.run(commandFromArgs('cat', [path.posix.join(targetDirectory, 'xtrabackup_checkpoints')], { privilegeMode: execution.privilegeMode }), { stdoutLimitBytes: 8192 });
      const checkpoints = parseCheckpoints(checkpointResult.stdout);
      if (incremental && (checkpoints.backupType !== 'incremental' || checkpoints.fromLsn !== predecessor.toLsn)) throw new MysqlPhysicalError('MYSQL_PHYSICAL_INCREMENTAL_LSN_MISMATCH', 'XtraBackup returned an incremental backup with the wrong starting LSN.', { category: 'integrity' });
      if (!incremental && (checkpoints.backupType !== 'full-backuped' || checkpoints.fromLsn !== '0')) throw new MysqlPhysicalError('MYSQL_PHYSICAL_FULL_CHECKPOINT_INVALID', 'XtraBackup returned invalid full-backup checkpoint metadata.', { category: 'integrity' });
      const artifactPath = `mysql-physical/${incremental ? 'incremental' : 'full'}-${checkpoints.toLsn}.xbstream`;
      const chainRootRecoveryPointId = incremental ? predecessor.chainRootRecoveryPointId : null;
      const databaseManifest = {
        version: PHYSICAL_FORMAT_VERSION,
        kind: 'mysql-xtrabackup',
        adapterId: plan.source.adapterId,
        adapterVersion: plan.manifest.adapterVersion,
        engine: 'mysql',
        backupMethod: 'physical',
        backupMode: incremental ? 'incremental' : 'full',
        selection: plan.source.selector,
        selectionDigest: plan.source.selector.digest,
        consistency: { requestedLevel: 'application', achievedLevel: 'application', backupMethod: 'physical', backupMode: incremental ? 'incremental' : 'full', method: 'coordinated-lock', proven: true },
        server: { serverUuid, serverIdentityFingerprint: plan.connection.trust.fingerprint, version: mysqlVersion.text, datadir: execution.dataDirectory },
        source: { sourceId: plan.source.id, jobId: options.jobId, mysqlConnectionId: plan.connection.id, mysqlConnectionRevision: plan.connection.revision, sshConnectionId: sshConnection.id, sshConnectionRevision: sshConnection.revision },
        tools: { xtrabackup, xbstream },
        checkpoints,
        chain: { chainRootRecoveryPointId, parentRecoveryPointId: incremental ? options.previousRecoveryPoint.id : null },
        restore: { serviceName: execution.serviceName, mysqlOwner: execution.mysqlOwner, mysqlGroup: execution.mysqlGroup, privilegeMode: execution.privilegeMode },
        artifact: { kind: 'physical-backup', path: artifactPath, mediaType: 'application/x-xbstream', sizeBytes: null }
      };
      const content = async function* streamArchive() {
        const opened = await session.stream(commandFromArgs(execution.xbstreamExecutable, ['-c', `--directory=${targetDirectory}`, '.'], { privilegeMode: execution.privilegeMode }), { stderrLimitBytes: 4 * 1024 * 1024 });
        let sizeBytes = 0;
        try {
          for await (const rawChunk of opened.stdout) {
            const chunk = Buffer.from(rawChunk);
            sizeBytes += chunk.length;
            if (sizeBytes > MAX_PHYSICAL_BACKUP_BYTES) throw new MysqlPhysicalError('MYSQL_PHYSICAL_BACKUP_LIMIT_EXCEEDED', 'The physical backup exceeds the supported artifact limit.', { category: 'capacity' });
            const paced = options.bandwidthLimiter ? await options.bandwidthLimiter.consume(chunk.length) : { limitBytesPerSecond: null, waitedMilliseconds: 0 };
            await options.onProgress?.({ phase: 'transferring', path: artifactPath, bytesRead: chunk.length, bandwidthLimitBytesPerSecond: paced.limitBytesPerSecond, throttleWaitMilliseconds: paced.waitedMilliseconds });
            yield chunk;
          }
          await opened.completion;
          if (!sizeBytes) throw new MysqlPhysicalError('MYSQL_PHYSICAL_BACKUP_EMPTY', 'xbstream returned an empty physical backup.', { category: 'integrity' });
        } catch (error) {
          opened.close();
          throw error;
        }
      };
      return { session, remoteWorkspace, artifactPath, databaseManifest, content };
    } catch (error) {
      if (remoteWorkspace) await this.cleanup(session, remoteWorkspace).catch(() => {});
      session.close();
      if (error instanceof MysqlPhysicalError) throw error;
      throw new MysqlPhysicalError(error?.code || 'MYSQL_PHYSICAL_BACKUP_FAILED', error?.message || 'MySQL physical backup failed.', { category: error?.category, retryable: error?.retryable });
    }
  }

  async cleanup(session, remoteWorkspace) {
    const target = normalizeRemotePath(remoteWorkspace, 'Allocated XtraBackup workspace');
    if (!path.posix.basename(target).startsWith('deployerx-xtrabackup-')) throw new MysqlPhysicalError('MYSQL_PHYSICAL_WORKSPACE_INVALID', 'Refusing to remove an unrecognized remote path.', { category: 'integrity' });
    await session.run(commandFromArgs('rm', ['-rf', '--', target]), { stdoutLimitBytes: 1024 });
  }

  async release(prepared) {
    if (!prepared) return false;
    try { await this.cleanup(prepared.session, prepared.remoteWorkspace); }
    finally { prepared.session.close(); }
    return true;
  }
}

module.exports = {
  MAX_PHYSICAL_BACKUP_BYTES,
  MysqlPhysicalBackupService,
  MysqlPhysicalError,
  PHYSICAL_FORMAT_VERSION,
  REQUIRED_XTRABACKUP_PRIVILEGES,
  grantsSatisfyXtrabackup,
  parseCheckpoints,
  parseMysql84Version,
  parseXtrabackupVersion,
  validateIncrementalPredecessor,
  validatePhysicalSelection
};
