const crypto = require('crypto');
const path = require('path');
const { databaseFingerprint, parseIdentity, parseServerVersion } = require('./oracle');
const { commandFromArgs, connectionConfigFromRecord, openSshExecutionSession } = require('./ssh-execution');

const PHYSICAL_FORMAT_VERSION = 1;
const MAX_ORACLE_BACKUP_BYTES = 128 * 1024 * 1024 * 1024 * 1024;
const PIECE_MARKER = 'DX_ORACLE_PIECE';
const REDO_MARKER = 'DX_ORACLE_REDO';
const PREFLIGHT_MARKER = 'DX_ORACLE_PREFLIGHT';
const SEPARATOR = '\x1f';
const BACKUP_TYPES = new Set(['full', 'level-0', 'level-1-differential', 'level-1-cumulative', 'archived-redo']);

class OraclePhysicalError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'OraclePhysicalError';
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
  const text = requiredText(value, label, 4096);
  if (!/^[A-Za-z0-9._+/@-]+$/.test(text)) throw new OraclePhysicalError('ORACLE_REMOTE_PATH_INVALID', `${label} contains unsupported characters.`, { category: 'validation' });
  const candidate = path.posix.normalize(text);
  const normalized = candidate.length > 1 ? candidate.replace(/\/$/, '') : candidate;
  if (!normalized.startsWith('/') || normalized === '/' || normalized.split('/').includes('..')) throw new OraclePhysicalError('ORACLE_REMOTE_PATH_INVALID', `${label} is unsafe.`, { category: 'validation' });
  return normalized;
}

function decimalText(value, label, { allowNull = false } = {}) {
  if (allowNull && (value === undefined || value === null || value === '')) return null;
  const text = requiredText(value, label, 100);
  if (!/^\d+$/.test(text)) throw new OraclePhysicalError('ORACLE_RMAN_METADATA_INVALID', `${label} is invalid.`, { category: 'integrity' });
  return text.replace(/^0+(?=\d)/, '');
}

function selectedDatabase(selector) {
  const included = selector?.databases?.include || [];
  const objectRules = (selector?.databases?.exclude?.length || 0) + (selector?.schemas?.include?.length || 0) + (selector?.schemas?.exclude?.length || 0)
    + (selector?.tables?.include?.length || 0) + (selector?.tables?.exclude?.length || 0) + Number(Boolean(selector?.includeGlobalObjects));
  if (selector?.kind !== 'database-objects' || selector.allDatabases || included.length !== 1 || objectRules) throw new OraclePhysicalError('ORACLE_SELECTION_UNSUPPORTED', 'Oracle RMAN backup requires exactly one whole database without object filters.', { category: 'compatibility' });
  return requiredText(included[0].name, 'Oracle selected database', 128);
}

function parseOracleToolVersion(value, name) {
  const text = requiredText(value, `${name} version output`, 16384);
  const match = /(?:Release|Version)\s+(19|21|23)(?:[.](\d+))?(?:[.](\d+))?/i.exec(text);
  if (!match) throw new OraclePhysicalError('ORACLE_TOOL_VERSION_UNSUPPORTED', `Oracle ${name} 19c, 21c, or 23ai is required.`, { category: 'compatibility' });
  return { name, version: `${Number(match[1])}.${Number(match[2] || 0)}.${Number(match[3] || 0)}`, major: Number(match[1]), text: text.slice(0, 300) };
}

function rmanTag(executionId) {
  return `DX${crypto.createHash('sha256').update(requiredText(executionId, 'Oracle execution ID', 200)).digest('hex').slice(0, 26).toUpperCase()}`;
}

function backupType(backupMode, anchorMode = 'level-0') {
  if (backupMode === 'full') return anchorMode === 'full' ? 'full' : 'level-0';
  if (backupMode === 'incremental') return 'level-1-differential';
  if (backupMode === 'differential') return 'level-1-cumulative';
  if (backupMode === 'native') return 'archived-redo';
  throw new OraclePhysicalError('ORACLE_BACKUP_MODE_UNSUPPORTED', 'Oracle RMAN backup mode is unsupported.', { category: 'compatibility' });
}

function oracleCommand(execution, executable, args = []) {
  const runAsUser = execution.privilegeMode === 'sudo-noninteractive' ? execution.oracleOwner : null;
  return commandFromArgs('env', [
    `ORACLE_HOME=${execution.oracleHome}`,
    `ORACLE_SID=${execution.oracleSid}`,
    `PATH=${execution.oracleHome}/bin:/usr/bin:/bin`,
    executable,
    ...args
  ], { privilegeMode: execution.privilegeMode, ...(runAsUser ? { runAsUser } : {}) });
}

function operatingSystemCommand(execution, executable, args = []) {
  return commandFromArgs(executable, args, {
    privilegeMode: execution.privilegeMode,
    ...(execution.privilegeMode === 'sudo-noninteractive' ? { runAsUser: execution.oracleOwner } : {})
  });
}

function remoteSqlPlusScript(query) {
  return `WHENEVER OSERROR EXIT 91\nWHENEVER SQLERROR EXIT SQL.SQLCODE\nSET ECHO OFF FEEDBACK OFF HEADING OFF PAGESIZE 0 VERIFY OFF TERMOUT ON TRIMSPOOL ON LINESIZE 32767\nCONNECT / AS SYSBACKUP\n${requiredText(query, 'Oracle SQL query', 65536)}\nEXIT SUCCESS\n`;
}

function remoteIdentityQuery() {
  return `SELECT 'DX_ORACLE_ID' || CHR(31) ||
  TO_CHAR(d.dbid) || CHR(31) || d.name || CHR(31) || d.db_unique_name || CHR(31) ||
  d.database_role || CHR(31) || d.open_mode || CHR(31) || d.log_mode || CHR(31) || d.cdb || CHR(31) ||
  d.platform_name || CHR(31) || i.instance_name || CHR(31) || i.host_name || CHR(31) || i.version_full || CHR(31) ||
  TO_CHAR((SELECT COUNT(*) FROM gv$instance)) || CHR(31) ||
  TO_CHAR((SELECT incarnation# FROM v$database_incarnation WHERE status = 'CURRENT')) || CHR(31) ||
  TO_CHAR(d.resetlogs_change#) || CHR(31) || TO_CHAR(d.resetlogs_time, 'YYYY-MM-DD"T"HH24:MI:SS') || CHR(31) ||
  TO_CHAR(d.current_scn)
FROM v$database d CROSS JOIN v$instance i;
SELECT '${PREFLIGHT_MARKER}' || CHR(31) ||
  CASE WHEN (SELECT value FROM v$parameter WHERE name = 'spfile') IS NULL THEN 'NO' ELSE 'YES' END || CHR(31) ||
  TO_CHAR((SELECT COUNT(*) FROM v$encrypted_tablespaces)) || CHR(31) ||
  TO_CHAR((SELECT COUNT(*) FROM v$datafile WHERE name LIKE '+%'))
FROM dual;`;
}

function parseNativePreflight(value) {
  const [fields] = markedRows(value, PREFLIGHT_MARKER, 3);
  if (!fields) throw new OraclePhysicalError('ORACLE_PREFLIGHT_EVIDENCE_MISSING', 'Oracle native preflight evidence is missing.', { category: 'integrity' });
  const evidence = { spfileConfigured: fields[0] === 'YES', encryptedTablespaces: Number(decimalText(fields[1], 'Oracle encrypted-tablespace count')), asmDatafiles: Number(decimalText(fields[2], 'Oracle ASM data-file count')) };
  if (!evidence.spfileConfigured) throw new OraclePhysicalError('ORACLE_SPFILE_REQUIRED', 'Oracle RMAN protection requires the database to use an SPFILE.', { category: 'compatibility' });
  if (evidence.encryptedTablespaces) throw new OraclePhysicalError('ORACLE_TDE_UNSUPPORTED', 'Oracle TDE wallet and keystore recovery is not supported in this release.', { category: 'compatibility' });
  if (evidence.asmDatafiles) throw new OraclePhysicalError('ORACLE_ASM_UNSUPPORTED', 'Oracle ASM restore orchestration is not supported in this release.', { category: 'compatibility' });
  return evidence;
}

function metadataQuery(tag) {
  const safeTag = requiredText(tag, 'RMAN tag', 30);
  if (!/^[A-Z0-9_]+$/.test(safeTag)) throw new TypeError('RMAN tag is invalid.');
  return `SELECT '${PIECE_MARKER}' || CHR(31) ||
  TO_CHAR(bs.recid) || CHR(31) || TO_CHAR(bs.set_stamp) || CHR(31) || TO_CHAR(bs.set_count) || CHR(31) || bs.backup_type || CHR(31) ||
  NVL(TO_CHAR(bs.incremental_level), '') || CHR(31) || bs.controlfile_included || CHR(31) || bs.spfile_included || CHR(31) ||
  TO_CHAR(FROM_TZ(CAST(bs.start_time AS TIMESTAMP), TO_CHAR(SYSTIMESTAMP, 'TZH:TZM')), 'YYYY-MM-DD"T"HH24:MI:SSTZH:TZM') || CHR(31) ||
  TO_CHAR(FROM_TZ(CAST(bs.completion_time AS TIMESTAMP), TO_CHAR(SYSTIMESTAMP, 'TZH:TZM')), 'YYYY-MM-DD"T"HH24:MI:SSTZH:TZM') || CHR(31) ||
  NVL(TO_CHAR(bs.checkpoint_change#), '') || CHR(31) || TO_CHAR(bp.recid) || CHR(31) || TO_CHAR(bp.piece#) || CHR(31) ||
  bp.handle || CHR(31) || TO_CHAR(bp.bytes) || CHR(31) || bp.compressed || CHR(31) || bp.status
FROM v$backup_set bs JOIN v$backup_piece bp ON bp.set_stamp = bs.set_stamp AND bp.set_count = bs.set_count
WHERE bs.tag = '${safeTag}' AND bp.device_type = 'DISK'
ORDER BY bs.set_stamp, bs.set_count, bp.piece#;
SELECT '${REDO_MARKER}' || CHR(31) || TO_CHAR(br.thread#) || CHR(31) || TO_CHAR(br.sequence#) || CHR(31) ||
  TO_CHAR(br.first_change#) || CHR(31) || TO_CHAR(br.next_change#) || CHR(31) ||
  TO_CHAR(FROM_TZ(CAST(br.first_time AS TIMESTAMP), TO_CHAR(SYSTIMESTAMP, 'TZH:TZM')), 'YYYY-MM-DD"T"HH24:MI:SSTZH:TZM') || CHR(31) ||
  TO_CHAR(FROM_TZ(CAST(br.next_time AS TIMESTAMP), TO_CHAR(SYSTIMESTAMP, 'TZH:TZM')), 'YYYY-MM-DD"T"HH24:MI:SSTZH:TZM') || CHR(31) ||
  TO_CHAR(br.resetlogs_change#) || CHR(31) || TO_CHAR(br.resetlogs_time, 'YYYY-MM-DD"T"HH24:MI:SS')
FROM v$backup_redolog br JOIN v$backup_set bs ON bs.set_stamp = br.set_stamp AND bs.set_count = br.set_count
WHERE bs.tag = '${safeTag}'
ORDER BY br.thread#, br.sequence#;`;
}

function rmanScript(input = {}) {
  const type = requiredText(input.type, 'Oracle backup type', 40);
  if (!BACKUP_TYPES.has(type)) throw new TypeError('Oracle backup type is invalid.');
  const directory = normalizeRemotePath(input.directory, 'Oracle backup workspace');
  const tag = requiredText(input.tag, 'RMAN tag', 30);
  if (!/^[A-Z0-9_]+$/.test(tag)) throw new TypeError('RMAN tag is invalid.');
  const scn = input.startScn ? decimalText(input.startScn, 'Archived-redo start SCN') : null;
  const lines = ['RUN {', '  ALLOCATE CHANNEL dx1 DEVICE TYPE DISK;'];
  if (type === 'full') lines.push(`  BACKUP AS BACKUPSET DATABASE TAG '${tag}' FORMAT '${directory}/data-%U.bkp';`);
  if (type === 'level-0') lines.push(`  BACKUP AS BACKUPSET INCREMENTAL LEVEL 0 DATABASE TAG '${tag}' FORMAT '${directory}/data-%U.bkp';`);
  if (type === 'level-1-differential') lines.push(`  BACKUP AS BACKUPSET INCREMENTAL LEVEL 1 DATABASE TAG '${tag}' FORMAT '${directory}/data-%U.bkp';`);
  if (type === 'level-1-cumulative') lines.push(`  BACKUP AS BACKUPSET INCREMENTAL LEVEL 1 CUMULATIVE DATABASE TAG '${tag}' FORMAT '${directory}/data-%U.bkp';`);
  lines.push(`  SQL "ALTER SYSTEM ARCHIVE LOG CURRENT";`);
  lines.push(`  BACKUP AS BACKUPSET ARCHIVELOG ${scn ? `FROM SCN ${scn}` : 'ALL'} TAG '${tag}' FORMAT '${directory}/redo-%U.bkp';`);
  lines.push(`  BACKUP CURRENT CONTROLFILE TAG '${tag}' FORMAT '${directory}/control-%U.bkp';`);
  if (type !== 'archived-redo') lines.push(`  BACKUP SPFILE TAG '${tag}' FORMAT '${directory}/spfile-%U.bkp';`);
  lines.push('  RELEASE CHANNEL dx1;', '}', 'EXIT;');
  return `${lines.join('\n')}\n`;
}

function validationScript(pieces) {
  const setKeys = [...new Set((pieces || []).map((piece) => decimalText(piece.backupSetKey, 'Oracle backup-set key')))];
  if (!setKeys.length || setKeys.length > 10000) throw new OraclePhysicalError('ORACLE_RMAN_BACKUP_SETS_MISSING', 'Oracle RMAN backup-set keys are unavailable for native validation.', { category: 'integrity' });
  return `${setKeys.map((key) => `VALIDATE BACKUPSET ${key};`).join('\n')}\nEXIT;\n`;
}

function markedRows(value, marker, fields) {
  const lines = String(value || '').split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith(`${marker}${SEPARATOR}`));
  return lines.map((line) => {
    const items = line.split(SEPARATOR);
    if (items.length !== fields + 1 || items[0] !== marker) throw new OraclePhysicalError('ORACLE_RMAN_METADATA_INVALID', 'Oracle RMAN returned malformed backup metadata.', { category: 'integrity' });
    return items.slice(1);
  });
}

function parsePieceInventory(value, workspace) {
  const root = normalizeRemotePath(workspace, 'Oracle backup workspace');
  const pieces = markedRows(value, PIECE_MARKER, 16).map((fields) => {
    const [backupSetKey, setStamp, setCount, rawType, level, control, spfile, startedAt, completedAt, checkpointScn, pieceKey, pieceNumber, handle, sizeBytes, compressed, status] = fields;
    const remotePath = normalizeRemotePath(handle, 'Oracle RMAN piece path');
    if (path.posix.dirname(remotePath) !== root || !/^[A-Za-z0-9._+-]+[.]bkp$/.test(path.posix.basename(remotePath))) throw new OraclePhysicalError('ORACLE_RMAN_PIECE_PATH_INVALID', 'Oracle RMAN returned a backup piece outside the private workspace.', { category: 'integrity' });
    if (!['D', 'I', 'L'].includes(rawType) || status !== 'A') throw new OraclePhysicalError('ORACLE_RMAN_PIECE_UNAVAILABLE', 'Oracle RMAN returned an unavailable or unsupported backup piece.', { category: 'integrity' });
    const kind = rawType === 'L' ? 'archived-redo' : spfile === 'YES' ? 'spfile' : control === 'YES' ? 'control-file' : 'datafile';
    return {
      backupSetKey: decimalText(backupSetKey, 'Oracle backup-set key'), setStamp: decimalText(setStamp, 'Oracle backup-set stamp'), setCount: decimalText(setCount, 'Oracle backup-set count'),
      backupTypeCode: rawType, incrementalLevel: decimalText(level, 'Oracle incremental level', { allowNull: true }), kind,
      controlFileIncluded: control === 'YES', spfileIncluded: spfile === 'YES', startedAt: requiredText(startedAt, 'Oracle backup start time', 100),
      completedAt: requiredText(completedAt, 'Oracle backup completion time', 100), checkpointScn: decimalText(checkpointScn, 'Oracle checkpoint SCN', { allowNull: true }),
      pieceKey: decimalText(pieceKey, 'Oracle piece key'), pieceNumber: Number(decimalText(pieceNumber, 'Oracle piece number')),
      remotePath, fileName: path.posix.basename(remotePath), sizeBytes: Number(decimalText(sizeBytes, 'Oracle piece size')), compressed: compressed === 'YES', status: 'available'
    };
  });
  if (!pieces.length || pieces.length > 10000) throw new OraclePhysicalError('ORACLE_RMAN_PIECES_MISSING', 'Oracle RMAN did not return a bounded backup-piece inventory.', { category: 'integrity' });
  if (pieces.some((piece) => !Number.isSafeInteger(piece.sizeBytes) || piece.sizeBytes < 1 || piece.sizeBytes > MAX_ORACLE_BACKUP_BYTES || !Number.isSafeInteger(piece.pieceNumber))) throw new OraclePhysicalError('ORACLE_RMAN_PIECE_SIZE_INVALID', 'Oracle RMAN returned an invalid backup-piece size.', { category: 'integrity' });
  return pieces;
}

function parseRedoInventory(value, expected = {}) {
  const rows = markedRows(value, REDO_MARKER, 8).map((fields) => ({
    thread: Number(decimalText(fields[0], 'Oracle redo thread')),
    sequence: Number(decimalText(fields[1], 'Oracle redo sequence')),
    firstChange: decimalText(fields[2], 'Oracle redo first-change SCN'),
    nextChange: decimalText(fields[3], 'Oracle redo next-change SCN'),
    firstTime: requiredText(fields[4], 'Oracle redo first time', 100),
    nextTime: requiredText(fields[5], 'Oracle redo next time', 100),
    resetlogsChange: decimalText(fields[6], 'Oracle redo resetlogs SCN'),
    resetlogsTime: requiredText(fields[7], 'Oracle redo resetlogs time', 100)
  }));
  if (!rows.length || rows.length > 100000) throw new OraclePhysicalError('ORACLE_ARCHIVED_REDO_MISSING', 'Oracle RMAN did not capture any archived redo after the forced log switch.', { category: 'consistency' });
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!Number.isSafeInteger(row.thread) || row.thread !== 1 || !Number.isSafeInteger(row.sequence) || row.sequence < 1) throw new OraclePhysicalError('ORACLE_ARCHIVED_REDO_TOPOLOGY_UNSUPPORTED', 'Oracle archived redo requires one continuous thread in this release.', { category: 'compatibility' });
    if (row.resetlogsChange !== expected.resetlogsChange) throw new OraclePhysicalError('ORACLE_ARCHIVED_REDO_INCARNATION_MISMATCH', 'Oracle archived redo belongs to a different resetlogs lineage.', { category: 'integrity' });
    if (index && (row.sequence !== rows[index - 1].sequence + 1 || BigInt(row.firstChange) > BigInt(rows[index - 1].nextChange))) throw new OraclePhysicalError('ORACLE_ARCHIVED_REDO_GAP', 'Oracle archived redo contains a sequence or SCN gap.', { category: 'integrity' });
  }
  return rows;
}

function validatePieceKinds(type, pieces) {
  const kinds = new Set(pieces.map((piece) => piece.kind));
  if (!kinds.has('archived-redo') || !kinds.has('control-file')) throw new OraclePhysicalError('ORACLE_RMAN_REQUIRED_MEDIA_MISSING', 'Oracle RMAN media is missing archived redo or a current control file.', { category: 'integrity' });
  if (type !== 'archived-redo' && (!kinds.has('datafile') || !kinds.has('spfile'))) throw new OraclePhysicalError('ORACLE_RMAN_REQUIRED_MEDIA_MISSING', 'Oracle RMAN media is missing data-file or SPFILE pieces.', { category: 'integrity' });
  if (type === 'archived-redo' && kinds.has('datafile')) throw new OraclePhysicalError('ORACLE_RMAN_UNEXPECTED_MEDIA', 'An archived-redo run returned unexpected data-file media.', { category: 'integrity' });
}

function newest(items, predicate) {
  return items.filter(predicate).sort((left, right) => String(right.metadata.backup?.completedAt || '').localeCompare(String(left.metadata.backup?.completedAt || '')))[0] || null;
}

class OraclePhysicalBackupService {
  constructor({ controlDatabase, secretStore, deviceId, sessionFactory = openSshExecutionSession } = {}) {
    if (!controlDatabase || !secretStore) throw new TypeError('Oracle physical backup dependencies are required.');
    this.controlDatabase = controlDatabase;
    this.secretStore = secretStore;
    this.deviceId = requiredText(deviceId, 'Device ID', 200);
    this.sessionFactory = sessionFactory;
  }

  async previousMetadata(workspaceId, plan, jobId) {
    const artifacts = await this.controlDatabase.repository('artifact').list(workspaceId, { limit: 5000 });
    const unique = new Map();
    for (const artifact of artifacts) {
      const metadata = artifact.metadata;
      if (!metadata || metadata.kind !== 'oracle-rman' || metadata.source?.sourceId !== plan.source.id || metadata.source?.jobId !== jobId || !artifact.recoveryPointId) continue;
      unique.set(artifact.recoveryPointId, { recoveryPointId: artifact.recoveryPointId, metadata });
    }
    return [...unique.values()];
  }

  chainFor(type, prior) {
    if (type === 'full' || type === 'level-0') return { root: null, parent: null, dataParent: null, redoParent: null, startScn: null };
    const level0 = newest(prior, (item) => item.metadata.backup?.type === 'level-0');
    if ((type === 'level-1-differential' || type === 'level-1-cumulative') && !level0) throw new OraclePhysicalError('ORACLE_LEVEL0_REQUIRED', 'An authenticated Oracle incremental level-0 RecoveryPoint is required first.', { category: 'consistency' });
    const dataParent = type === 'level-1-differential'
      ? newest(prior, (item) => ['level-0', 'level-1-differential', 'level-1-cumulative'].includes(item.metadata.backup?.type))
      : level0;
    const redoParent = newest(prior, (item) => item.metadata.archivedRedo?.endScn);
    if (!redoParent) throw new OraclePhysicalError('ORACLE_REDO_PARENT_REQUIRED', 'An authenticated Oracle archived-redo boundary is required first.', { category: 'consistency' });
    const parent = newest([dataParent, redoParent].filter(Boolean), () => true);
    return {
      root: level0?.recoveryPointId || redoParent.metadata.chain?.chainRootRecoveryPointId || redoParent.recoveryPointId,
      parent: parent?.recoveryPointId || null,
      dataParent: dataParent?.recoveryPointId || null,
      redoParent: redoParent.recoveryPointId,
      startScn: redoParent.metadata.archivedRedo.endScn
    };
  }

  async prepare(workspaceId, executionId, plan, options = {}) {
    const execution = plan.source?.physicalExecution;
    if (!execution || execution.engine !== 'oracle') throw new OraclePhysicalError('ORACLE_PHYSICAL_CONFIG_MISSING', 'Oracle RMAN execution settings are missing.', { category: 'configuration' });
    const selected = selectedDatabase(plan.source.selector);
    const expectedIdentity = plan.connection?.lastTest?.endpointIdentity;
    if (!expectedIdentity?.databaseFingerprint || !expectedIdentity.dbid || selected !== expectedIdentity.databaseUniqueName) throw new OraclePhysicalError('ORACLE_SOURCE_IDENTITY_MISSING', 'The Oracle Source lacks authenticated DBID and DB_UNIQUE_NAME evidence.', { category: 'integrity' });
    const sshConnection = plan.executionConnection || await this.controlDatabase.repository('connection').get(workspaceId, execution.sshConnectionId);
    if (!sshConnection || sshConnection.adapterId !== 'deployerx.connection.ssh' || sshConnection.lastTest?.status !== 'success') throw new OraclePhysicalError('ORACLE_SSH_CONNECTION_UNAVAILABLE', 'The tested Oracle SSH execution connection is unavailable.', { category: 'connectivity', retryable: true });
    if (![plan.connection, sshConnection].every((connection) => (connection.workerAffinity || []).includes(`device:${this.deviceId}`))) throw new OraclePhysicalError('ORACLE_EXECUTION_OTHER_DEVICE', 'The Oracle and SSH connections belong to another device.', { category: 'authorization' });
    const type = backupType(options.backupMode || 'full', execution.anchorMode);
    const prior = await this.previousMetadata(workspaceId, plan, options.jobId);
    const chain = this.chainFor(type, prior);
    const session = await this.sessionFactory({ connectionConfig: connectionConfigFromRecord(sshConnection), resolveSecret: (secretRefId) => this.secretStore.resolve({ workspaceId, id: secretRefId }), signal: options.signal });
    let remoteWorkspace = null;
    try {
      const backupRoot = normalizeRemotePath(execution.backupDirectory, 'Oracle backup-piece directory');
      await session.run(operatingSystemCommand(execution, 'test', ['-d', backupRoot]), { stdoutLimitBytes: 1024 });
      await session.run(operatingSystemCommand(execution, 'test', ['-w', backupRoot]), { stdoutLimitBytes: 1024 });
      const allocated = await session.run(operatingSystemCommand(execution, 'mktemp', ['-d', '-p', backupRoot, `deployerx-oracle-${String(executionId).replace(/[^A-Za-z0-9]/g, '').slice(0, 20)}.XXXXXX`]), { stdoutLimitBytes: 8192 });
      remoteWorkspace = normalizeRemotePath(allocated.stdout.trim(), 'Allocated Oracle backup workspace');
      if (path.posix.dirname(remoteWorkspace) !== backupRoot || !path.posix.basename(remoteWorkspace).startsWith('deployerx-oracle-')) throw new OraclePhysicalError('ORACLE_WORKSPACE_INVALID', 'The Oracle backup workspace is outside the approved directory.', { category: 'integrity' });
      const identityScript = path.posix.join(remoteWorkspace, 'identity.sql');
      const rmanCommandFile = path.posix.join(remoteWorkspace, 'backup.rman');
      const rmanLog = path.posix.join(remoteWorkspace, 'backup.log');
      const validationCommandFile = path.posix.join(remoteWorkspace, 'validate.rman');
      const validationLog = path.posix.join(remoteWorkspace, 'validate.log');
      const metadataScript = path.posix.join(remoteWorkspace, 'metadata.sql');
      const listFile = path.posix.join(remoteWorkspace, 'pieces.txt');
      const tag = rmanTag(executionId);
      await this.writeRemote(session, execution, identityScript, remoteSqlPlusScript(remoteIdentityQuery()));
      const [identityResult, sqlplusVersionResult, rmanVersionResult, ownerResult] = await Promise.all([
        session.run(oracleCommand(execution, execution.sqlplusExecutable, ['-L', '-S', '/nolog', `@${identityScript}`]), { stdoutLimitBytes: 16384 }),
        session.run(oracleCommand(execution, execution.sqlplusExecutable, ['-V']), { stdoutLimitBytes: 8192 }),
        session.run(oracleCommand(execution, execution.rmanExecutable, ['-version']), { stdoutLimitBytes: 8192 }),
        session.run(operatingSystemCommand(execution, 'id', ['-un']), { stdoutLimitBytes: 1024 })
      ]);
      const identity = parseIdentity(identityResult.stdout);
      const nativePreflight = parseNativePreflight(identityResult.stdout);
      const version = parseServerVersion(identity.version);
      const sqlplus = parseOracleToolVersion(`${sqlplusVersionResult.stdout}\n${sqlplusVersionResult.stderr}`, 'SQL*Plus');
      const rman = parseOracleToolVersion(`${rmanVersionResult.stdout}\n${rmanVersionResult.stderr}`, 'RMAN');
      if (version.major !== sqlplus.major || version.major !== rman.major) throw new OraclePhysicalError('ORACLE_TOOL_MAJOR_MISMATCH', 'Oracle SQL*Plus and RMAN must match the database major release.', { category: 'compatibility' });
      if (requiredText(ownerResult.stdout, 'Oracle execution owner', 128) !== execution.oracleOwner) throw new OraclePhysicalError('ORACLE_EXECUTION_OWNER_MISMATCH', 'RMAN is not running as the configured Oracle software owner.', { category: 'authorization' });
      if (databaseFingerprint(identity) !== expectedIdentity.databaseFingerprint || identity.dbid !== expectedIdentity.dbid || identity.databaseUniqueName !== selected) throw new OraclePhysicalError('ORACLE_DATABASE_PAIR_MISMATCH', 'The paired SSH context reaches a different Oracle database.', { category: 'integrity' });
      if (identity.incarnation !== Number(expectedIdentity.incarnation) || identity.resetlogsChange !== expectedIdentity.resetlogsChange) throw new OraclePhysicalError('ORACLE_INCARNATION_CHANGED', 'The Oracle database incarnation changed after the Source connection test.', { category: 'integrity' });
      if (identity.databaseRole !== 'PRIMARY' || identity.openMode !== 'READ WRITE' || identity.logMode !== 'ARCHIVELOG' || identity.instanceCount !== 1 || !identity.platformName.toLowerCase().startsWith('linux')) throw new OraclePhysicalError('ORACLE_DATABASE_NOT_BACKUP_READY', 'The Oracle database is not a supported single-instance Linux primary in ARCHIVELOG read/write mode.', { category: 'consistency' });
      await this.writeRemote(session, execution, rmanCommandFile, rmanScript({ type, directory: remoteWorkspace, tag, startScn: chain.startScn }));
      await options.onProgress?.({ phase: 'scanning', path: selected });
      await session.run(oracleCommand(execution, execution.rmanExecutable, ['target', '/', 'cmdfile', rmanCommandFile, 'log', rmanLog]), { stdoutLimitBytes: 4 * 1024 * 1024, stderrLimitBytes: 4 * 1024 * 1024 });
      await this.writeRemote(session, execution, metadataScript, remoteSqlPlusScript(metadataQuery(tag)));
      const metadataResult = await session.run(oracleCommand(execution, execution.sqlplusExecutable, ['-L', '-S', '/nolog', `@${metadataScript}`]), { stdoutLimitBytes: 16 * 1024 * 1024 });
      const pieces = parsePieceInventory(metadataResult.stdout, remoteWorkspace);
      validatePieceKinds(type, pieces);
      const redo = parseRedoInventory(metadataResult.stdout, { resetlogsChange: identity.resetlogsChange });
      await this.writeRemote(session, execution, validationCommandFile, validationScript(pieces));
      await session.run(oracleCommand(execution, execution.rmanExecutable, ['target', '/', 'cmdfile', validationCommandFile, 'log', validationLog]), { stdoutLimitBytes: 4 * 1024 * 1024, stderrLimitBytes: 4 * 1024 * 1024 });
      let totalPieceBytes = 0;
      for (const piece of pieces) {
        const [stat, checksum] = await Promise.all([
          session.run(operatingSystemCommand(execution, execution.statExecutable, ['--format=%s', '--', piece.remotePath]), { stdoutLimitBytes: 1024 }),
          session.run(operatingSystemCommand(execution, execution.sha256sumExecutable, ['--', piece.remotePath]), { stdoutLimitBytes: 1024 })
        ]);
        const exactSize = Number(decimalText(stat.stdout, 'Oracle piece stat size'));
        const digest = String(checksum.stdout || '').trim().split(/\s+/)[0]?.toLowerCase();
        if (exactSize !== piece.sizeBytes || !/^[a-f0-9]{64}$/.test(digest)) throw new OraclePhysicalError('ORACLE_RMAN_PIECE_VERIFICATION_FAILED', 'An Oracle backup piece failed exact size or checksum verification.', { category: 'integrity' });
        piece.checksum = { algorithm: 'sha256', digest };
        totalPieceBytes += exactSize;
        if (!Number.isSafeInteger(totalPieceBytes) || totalPieceBytes > MAX_ORACLE_BACKUP_BYTES) throw new OraclePhysicalError('ORACLE_RMAN_BACKUP_LIMIT_EXCEEDED', 'Oracle RMAN media exceeds the configured size limit.', { category: 'capacity' });
      }
      await this.writeRemote(session, execution, listFile, `${pieces.map((piece) => piece.fileName).join('\n')}\n`);
      const completedAt = pieces.map((piece) => piece.completedAt).sort().at(-1);
      const checkpointScn = pieces.filter((piece) => piece.checkpointScn).map((piece) => piece.checkpointScn).sort((left, right) => BigInt(left) < BigInt(right) ? -1 : 1).at(-1) || identity.currentScn;
      const artifactPath = `oracle-rman/${type}-${checkpointScn}-${tag.toLowerCase()}.tar`;
      const archivedRedo = {
        thread: 1,
        firstSequence: redo[0].sequence,
        lastSequence: redo.at(-1).sequence,
        startScn: redo[0].firstChange,
        endScn: redo.at(-1).nextChange,
        startedAt: redo[0].firstTime,
        completedAt: redo.at(-1).nextTime,
        resetlogsChange: identity.resetlogsChange,
        resetlogsTime: identity.resetlogsTime,
        logs: redo
      };
      const databaseManifest = {
        version: PHYSICAL_FORMAT_VERSION,
        kind: 'oracle-rman',
        adapterId: plan.source.adapterId,
        adapterVersion: plan.manifest.adapterVersion,
        engine: 'oracle',
        backupMethod: 'physical',
        selection: plan.source.selector,
        selectionDigest: plan.source.selector.digest,
        consistency: { requestedLevel: 'application', achievedLevel: 'application', method: 'oracle-rman', backupMethod: 'physical', backupMode: options.backupMode || 'full', captureCoordinates: true, proven: true },
        server: { databaseFingerprint: expectedIdentity.databaseFingerprint, instanceFingerprint: expectedIdentity.instanceFingerprint || null, version: version.text, major: version.major, platform: identity.platformName, hostName: identity.hostName, instanceName: identity.instanceName },
        database: { dbid: identity.dbid, name: identity.databaseName, uniqueName: identity.databaseUniqueName, cdb: identity.cdb, role: identity.databaseRole, openMode: identity.openMode, logMode: identity.logMode, incarnation: identity.incarnation, resetlogsChange: identity.resetlogsChange, resetlogsTime: identity.resetlogsTime, encryptedTablespaces: nativePreflight.encryptedTablespaces, asmDatafiles: nativePreflight.asmDatafiles, spfileConfigured: nativePreflight.spfileConfigured },
        source: { sourceId: plan.source.id, jobId: options.jobId, oracleConnectionId: plan.connection.id, oracleConnectionRevision: plan.connection.revision, sshConnectionId: sshConnection.id, sshConnectionRevision: sshConnection.revision },
        tools: { sqlplus, rman },
        backup: { type, incrementalLevel: type === 'level-0' ? 0 : type.startsWith('level-1') ? 1 : null, cumulative: type === 'level-1-cumulative', tag, checkpointScn, startedAt: pieces.map((piece) => piece.startedAt).sort()[0], completedAt, pieceCount: pieces.length, totalPieceBytes, nativeValidation: true },
        archivedRedo,
        pieces: pieces.map(({ remotePath: _remotePath, ...piece }) => piece),
        chain: { chainRootRecoveryPointId: chain.root, parentRecoveryPointId: chain.parent, dataParentRecoveryPointId: chain.dataParent, redoParentRecoveryPointId: chain.redoParent },
        restore: { oracleHome: execution.oracleHome, oracleSid: execution.oracleSid, oracleOwner: execution.oracleOwner, oracleGroup: execution.oracleGroup, privilegeMode: execution.privilegeMode, dataDirectory: execution.dataDirectory, recoveryAreaDirectory: execution.recoveryAreaDirectory, redoDirectory: execution.redoDirectory, controlFileIncluded: pieces.some((piece) => piece.kind === 'control-file'), spfileIncluded: pieces.some((piece) => piece.kind === 'spfile') },
        artifact: { kind: type === 'archived-redo' ? 'transaction-log' : 'physical-backup', path: artifactPath, mediaType: 'application/x-tar', sizeBytes: null }
      };
      return {
        session,
        remoteWorkspace,
        execution,
        artifactPath,
        databaseManifest,
        content: () => this.streamArchive(session, execution, remoteWorkspace, listFile, artifactPath, options)
      };
    } catch (error) {
      if (remoteWorkspace) await this.cleanup(session, execution, remoteWorkspace).catch(() => {});
      session.close();
      if (error instanceof OraclePhysicalError) throw error;
      if (error?.code) throw new OraclePhysicalError(error.code, error.message, { category: error.category, retryable: error.retryable });
      throw new OraclePhysicalError('ORACLE_RMAN_BACKUP_FAILED', 'Oracle RMAN backup execution failed.', { retryable: true });
    }
  }

  async writeRemote(session, execution, remotePath, content) {
    async function* bytes() { yield Buffer.from(content, 'utf8'); }
    await session.consume(operatingSystemCommand(execution, 'tee', [remotePath]), bytes(), { stdoutLimitBytes: 1024 });
    await session.run(operatingSystemCommand(execution, 'chmod', ['600', remotePath]), { stdoutLimitBytes: 1024 });
  }

  async *streamArchive(session, execution, directory, listFile, artifactPath, options) {
    const opened = await session.stream(operatingSystemCommand(execution, execution.tarExecutable, ['--create', '--file=-', `--directory=${directory}`, '--verbatim-files-from', `--files-from=${listFile}`]), { stderrLimitBytes: 4 * 1024 * 1024 });
    let sizeBytes = 0;
    try {
      for await (const rawChunk of opened.stdout) {
        const chunk = Buffer.from(rawChunk);
        sizeBytes += chunk.length;
        if (sizeBytes > MAX_ORACLE_BACKUP_BYTES) throw new OraclePhysicalError('ORACLE_RMAN_BACKUP_LIMIT_EXCEEDED', 'Oracle RMAN media exceeds the configured size limit.', { category: 'capacity' });
        await options.onProgress?.({ phase: 'reading', path: artifactPath, bytes: chunk.length });
        yield chunk;
      }
      await opened.completion;
      if (!sizeBytes) throw new OraclePhysicalError('ORACLE_RMAN_ARCHIVE_EMPTY', 'Oracle RMAN archive streaming returned no data.', { category: 'integrity' });
    } catch (error) {
      opened.close();
      throw error;
    }
  }

  async cleanup(session, execution, remoteWorkspace) {
    const target = normalizeRemotePath(remoteWorkspace, 'Allocated Oracle backup workspace');
    if (!path.posix.basename(target).startsWith('deployerx-oracle-')) throw new OraclePhysicalError('ORACLE_WORKSPACE_INVALID', 'Refusing to remove an unrecognized Oracle path.', { category: 'integrity' });
    await session.run(operatingSystemCommand(execution, execution.rmExecutable, ['-rf', '--', target]), { stdoutLimitBytes: 1024, ignoreAbort: true });
  }

  async release(prepared) {
    if (!prepared) return false;
    try { await this.cleanup(prepared.session, prepared.execution, prepared.remoteWorkspace); }
    finally { prepared.session.close(); }
    return true;
  }
}

module.exports = {
  MAX_ORACLE_BACKUP_BYTES,
  OraclePhysicalBackupService,
  OraclePhysicalError,
  backupType,
  metadataQuery,
  normalizeRemotePath,
  operatingSystemCommand,
  oracleCommand,
  parseOracleToolVersion,
  parseNativePreflight,
  parsePieceInventory,
  parseRedoInventory,
  remoteIdentityQuery,
  remoteSqlPlusScript,
  rmanScript,
  rmanTag,
  selectedDatabase,
  validationScript,
  validatePieceKinds
};
