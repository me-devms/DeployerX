const path = require('path');
const { isDeepStrictEqual } = require('node:util');
const { ADAPTER_ID, databaseFingerprint, parseIdentity } = require('./oracle');
const { normalizeRemotePath, operatingSystemCommand, oracleCommand, parseOracleToolVersion, remoteIdentityQuery, remoteSqlPlusScript } = require('./oracle-physical');
const { normalizePhysicalExecution } = require('./database-source');
const { commandFromArgs, connectionConfigFromRecord, openSshExecutionSession, shellQuote } = require('./ssh-execution');

const RESTORE_CONFIRMATIONS = Object.freeze({ original: 'RESTORE ORACLE ORIGINAL', alternate: 'RESTORE ORACLE ALTERNATE' });
const RESETLOGS_CONFIRMATION = 'OPEN RESETLOGS ORACLE';
const TERMINAL_STATES = new Set(['succeeded', 'warning', 'failed', 'canceled']);

class OracleRestoreError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'OracleRestoreError';
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

function decimalText(value, label) {
  const text = requiredText(value, label, 100);
  if (!/^\d+$/.test(text)) throw new OracleRestoreError('ORACLE_RECOVERY_COORDINATE_INVALID', `${label} is invalid.`, { category: 'validation' });
  return text.replace(/^0+(?=\d)/, '');
}

function normalizeRecoveryTarget(input = {}) {
  const type = String(input.type || 'latest');
  if (!['latest', 'scn', 'sequence', 'time'].includes(type)) throw new OracleRestoreError('ORACLE_RECOVERY_TARGET_INVALID', 'Choose latest, SCN, archived-log sequence, or UTC-time Oracle recovery.', { category: 'validation' });
  if (type === 'latest') return Object.freeze({ type, value: null });
  if (type === 'scn' || type === 'sequence') return Object.freeze({ type, value: decimalText(input.value, type === 'scn' ? 'Oracle recovery SCN' : 'Oracle archived-log sequence') });
  const candidate = requiredText(input.value, 'Oracle recovery target time', 100);
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(candidate) || !Number.isFinite(Date.parse(candidate))) throw new OracleRestoreError('ORACLE_RECOVERY_TIME_INVALID', 'Enter an Oracle recovery timestamp with an explicit UTC offset.', { category: 'validation' });
  return Object.freeze({ type, value: new Date(candidate).toISOString() });
}

function normalizeAlternateTargetProfile(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new OracleRestoreError('ORACLE_ALTERNATE_PROFILE_REQUIRED', 'Configure the absent Oracle recovery target.', { category: 'validation' });
  const oracleSid = requiredText(input.oracleSid, 'Alternate Oracle SID', 8).toUpperCase();
  const databaseUniqueName = requiredText(input.databaseUniqueName, 'Alternate Oracle DB_UNIQUE_NAME', 128);
  if (!/^[A-Z][A-Z0-9_$#]{0,7}$/.test(oracleSid)) throw new OracleRestoreError('ORACLE_ALTERNATE_SID_INVALID', 'The alternate Oracle SID must be an unquoted DB_NAME of at most 8 characters.', { category: 'validation' });
  if (!/^[A-Za-z0-9][A-Za-z0-9._$#-]{0,127}$/.test(databaseUniqueName)) throw new OracleRestoreError('ORACLE_ALTERNATE_UNIQUE_NAME_INVALID', 'The alternate Oracle DB_UNIQUE_NAME is invalid.', { category: 'validation' });
  const execution = normalizePhysicalExecution({ ...input, oracleSid }, 'oracle');
  const recoveryAreaSizeBytes = Number(input.recoveryAreaSizeBytes);
  if (!Number.isSafeInteger(recoveryAreaSizeBytes) || recoveryAreaSizeBytes < 1024 ** 3 || recoveryAreaSizeBytes > 8 * 1024 ** 5) throw new OracleRestoreError('ORACLE_ALTERNATE_FRA_SIZE_INVALID', 'The alternate fast-recovery-area size must be between 1 GiB and 8 PiB.', { category: 'validation' });
  const lsnrctlExecutable = String(input.lsnrctlExecutable || 'lsnrctl').trim();
  if (path.posix.basename(lsnrctlExecutable) !== 'lsnrctl' || lsnrctlExecutable.includes('..')) throw new OracleRestoreError('ORACLE_ALTERNATE_LISTENER_TOOL_INVALID', 'Only the lsnrctl executable may be configured.', { category: 'validation' });
  const roots = [execution.dataDirectory, execution.recoveryAreaDirectory, execution.redoDirectory];
  for (let left = 0; left < roots.length; left += 1) {
    for (let right = left + 1; right < roots.length; right += 1) {
      if (roots[left] === roots[right] || roots[left].startsWith(`${roots[right]}/`) || roots[right].startsWith(`${roots[left]}/`)) throw new OracleRestoreError('ORACLE_ALTERNATE_ROOTS_OVERLAP', 'Oracle alternate data, recovery, and redo destinations must be separate non-nested paths.', { category: 'validation' });
    }
  }
  if (roots.some((root) => execution.remoteTemporaryDirectory === root || execution.remoteTemporaryDirectory.startsWith(`${root}/`) || root.startsWith(`${execution.remoteTemporaryDirectory}/`))) throw new OracleRestoreError('ORACLE_ALTERNATE_TEMP_OVERLAP', 'The Oracle restore workspace must be outside every alternate database destination.', { category: 'validation' });
  return Object.freeze({ ...execution, databaseUniqueName, recoveryAreaSizeBytes, lsnrctlExecutable });
}

function normalizeRequest(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Oracle restore request must be an object.');
  const mode = String(input.mode || 'original');
  if (!RESTORE_CONFIRMATIONS[mode]) throw new OracleRestoreError('ORACLE_RESTORE_MODE_INVALID', 'Choose the original or an alternate Oracle target.', { category: 'validation' });
  if (input.confirmed !== true || String(input.confirmationText || '').trim() !== RESTORE_CONFIRMATIONS[mode]) throw new OracleRestoreError('ORACLE_RESTORE_CONFIRMATION_REQUIRED', 'Enter the exact destructive Oracle restore confirmation.', { category: 'conflict' });
  if (input.resetlogsConfirmed !== true || String(input.resetlogsConfirmationText || '').trim() !== RESETLOGS_CONFIRMATION) throw new OracleRestoreError('ORACLE_RESETLOGS_CONFIRMATION_REQUIRED', 'Enter the exact Oracle OPEN RESETLOGS confirmation.', { category: 'conflict' });
  const targetProfile = mode === 'alternate' ? normalizeAlternateTargetProfile(input.targetProfile) : null;
  return {
    recoveryPointId: requiredText(input.recoveryPointId, 'RecoveryPoint ID', 200),
    mode,
    targetProfile,
    recoveryTarget: normalizeRecoveryTarget(input.recoveryTarget),
    deepValidation: Boolean(input.deepValidation)
  };
}

function safeError(error) {
  if (error instanceof OracleRestoreError || error?.code) return { code: String(error.code).slice(0, 100), category: String(error.category || 'physical-restore').slice(0, 80), retryable: Boolean(error.retryable), safeMessage: String(error.message || 'The Oracle restore failed.').slice(0, 500) };
  return { code: 'ORACLE_RESTORE_FAILED', category: 'physical-restore', retryable: false, safeMessage: 'DeployerX could not complete the Oracle restore.' };
}

function assertPhysicalSource(source) {
  if (!source || source.adapterId !== ADAPTER_ID || source.consistency?.backupMethod !== 'physical' || source.physicalExecution?.engine !== 'oracle') throw new OracleRestoreError('ORACLE_RESTORE_SOURCE_INVALID', 'Choose a configured Oracle RMAN Source as the restore target.', { category: 'validation' });
  return source;
}

function bigint(value, label) {
  try { return BigInt(decimalText(value, label)); }
  catch (error) { if (error instanceof OracleRestoreError) throw error; throw new OracleRestoreError('ORACLE_CHAIN_COORDINATE_INVALID', `${label} is invalid.`, { category: 'integrity' }); }
}

function validateRecoveryTarget(target, chain) {
  const rootMetadata = chain.metadataByPoint.get(chain.rootId);
  const terminalMetadata = chain.metadataByPoint.get(chain.selectedPointId);
  const lowerScn = bigint(rootMetadata.backup?.checkpointScn, 'Oracle root checkpoint SCN');
  const upperScn = bigint(terminalMetadata.archivedRedo?.endScn, 'Oracle terminal redo SCN');
  if (target.type === 'scn') {
    const requested = bigint(target.value, 'Oracle recovery SCN');
    if (requested < lowerScn || requested > upperScn) throw new OracleRestoreError('ORACLE_RECOVERY_SCN_OUTSIDE_CHAIN', 'The requested SCN is outside the authenticated Oracle recovery chain.', { category: 'validation' });
  }
  if (target.type === 'sequence') {
    const requested = bigint(target.value, 'Oracle archived-log sequence');
    const first = bigint(rootMetadata.archivedRedo?.firstSequence, 'Oracle first archived-log sequence');
    const last = bigint(terminalMetadata.archivedRedo?.lastSequence, 'Oracle last archived-log sequence');
    if (requested < first || requested > last) throw new OracleRestoreError('ORACLE_RECOVERY_SEQUENCE_OUTSIDE_CHAIN', 'The requested archived-log sequence is outside the authenticated Oracle recovery chain.', { category: 'validation' });
  }
  if (target.type === 'time') {
    const requested = Date.parse(target.value);
    const earliestText = String(rootMetadata.archivedRedo?.startedAt || '');
    const latestText = String(terminalMetadata.archivedRedo?.completedAt || '');
    const earliest = /(?:Z|[+-]\d{2}:\d{2})$/.test(earliestText) ? Date.parse(earliestText) : NaN;
    const latest = /(?:Z|[+-]\d{2}:\d{2})$/.test(latestText) ? Date.parse(latestText) : NaN;
    if (!Number.isFinite(earliest) || !Number.isFinite(latest) || requested < earliest || requested > latest) throw new OracleRestoreError('ORACLE_RECOVERY_TIME_OUTSIDE_CHAIN', 'The requested UTC time is outside the authenticated Oracle recovery chain.', { category: 'validation' });
  }
  return target;
}

function validateChain(points, metadataByPoint, selectedPointId, target = { type: 'latest', value: null }) {
  const byId = new Map(points.map((point) => [point.id, point]));
  const selectedPoint = byId.get(selectedPointId);
  if (!selectedPoint) throw new OracleRestoreError('ORACLE_CHAIN_POINT_MISSING', 'The selected Oracle RecoveryPoint is unavailable.', { category: 'not-found' });
  const selectedMetadata = metadataByPoint.get(selectedPointId);
  if (!selectedMetadata || selectedMetadata.kind !== 'oracle-rman') throw new OracleRestoreError('ORACLE_CHAIN_METADATA_INVALID', 'The selected Oracle RecoveryPoint lacks authenticated RMAN metadata.', { category: 'integrity' });
  const reversed = [];
  const visited = new Set();
  let currentPoint = selectedPoint;
  while (currentPoint) {
    if (visited.has(currentPoint.id)) throw new OracleRestoreError('ORACLE_CHAIN_CYCLE', 'The Oracle redo chain contains a cycle.', { category: 'integrity' });
    visited.add(currentPoint.id);
    reversed.push(currentPoint);
    const metadata = metadataByPoint.get(currentPoint.id);
    if (!metadata) throw new OracleRestoreError('ORACLE_CHAIN_METADATA_INVALID', 'An Oracle RecoveryPoint lacks authenticated RMAN metadata.', { category: 'integrity' });
    const parentId = metadata.chain?.redoParentRecoveryPointId || null;
    if (!parentId) break;
    currentPoint = byId.get(parentId);
    if (!currentPoint) throw new OracleRestoreError('ORACLE_CHAIN_REDO_PARENT_MISSING', 'A required Oracle archived-redo parent is missing.', { category: 'integrity' });
  }
  const chain = reversed.reverse();
  const root = chain[0];
  const rootMetadata = metadataByPoint.get(root.id);
  if (!rootMetadata || !['full', 'level-0'].includes(rootMetadata.backup?.type) || root.type !== 'full' || root.chainRootId !== root.id) throw new OracleRestoreError('ORACLE_CHAIN_ANCHOR_INVALID', 'The Oracle recovery chain has no authenticated full or level-0 anchor.', { category: 'integrity' });
  const identity = {
    dbid: rootMetadata.database?.dbid,
    uniqueName: rootMetadata.database?.uniqueName,
    databaseName: rootMetadata.database?.name,
    incarnation: rootMetadata.database?.incarnation,
    resetlogsChange: rootMetadata.database?.resetlogsChange,
    databaseFingerprint: rootMetadata.server?.databaseFingerprint,
    sourceId: rootMetadata.source?.sourceId,
    jobId: rootMetadata.source?.jobId,
    major: Number(rootMetadata.server?.major)
  };
  if (!identity.dbid || !identity.uniqueName || !identity.databaseName || !identity.incarnation || !identity.resetlogsChange || !identity.databaseFingerprint || !identity.sourceId || !identity.jobId || ![19, 21, 23].includes(identity.major)) throw new OracleRestoreError('ORACLE_CHAIN_IDENTITY_INVALID', 'The Oracle chain anchor lacks required DBID, incarnation, or version evidence.', { category: 'integrity' });
  let previousRedo = null;
  for (let index = 0; index < chain.length; index += 1) {
    const point = chain[index];
    const metadata = metadataByPoint.get(point.id);
    const expectedType = metadata.backup?.type === 'archived-redo' ? 'log' : metadata.backup?.type === 'level-1-cumulative' ? 'differential' : metadata.backup?.type === 'level-1-differential' ? 'incremental' : 'full';
    if (point.type !== expectedType || metadata.database?.dbid !== identity.dbid || metadata.database?.uniqueName !== identity.uniqueName || Number(metadata.database?.incarnation) !== Number(identity.incarnation) || metadata.database?.resetlogsChange !== identity.resetlogsChange || metadata.server?.databaseFingerprint !== identity.databaseFingerprint || metadata.source?.sourceId !== identity.sourceId || metadata.source?.jobId !== identity.jobId || point.sourceId !== identity.sourceId || point.jobId !== identity.jobId || Number(metadata.server?.major) !== identity.major) throw new OracleRestoreError('ORACLE_CHAIN_IDENTITY_MISMATCH', 'The Oracle chain mixes different databases, incarnations, Sources, Jobs, or versions.', { category: 'integrity' });
    if (index && point.chainRootId !== root.id) throw new OracleRestoreError('ORACLE_CHAIN_ROOT_MISMATCH', 'The Oracle chain root changed.', { category: 'integrity' });
    const redo = metadata.archivedRedo;
    if (!redo?.startScn || !redo?.endScn || Number(redo.thread) !== 1 || redo.resetlogsChange !== identity.resetlogsChange) throw new OracleRestoreError('ORACLE_CHAIN_REDO_INVALID', 'An Oracle RecoveryPoint lacks authenticated archived-redo coverage.', { category: 'integrity' });
    if (previousRedo && (bigint(redo.startScn, 'Oracle redo start SCN') > bigint(previousRedo.endScn, 'Previous Oracle redo end SCN') || bigint(redo.endScn, 'Oracle redo end SCN') <= bigint(previousRedo.endScn, 'Previous Oracle redo end SCN'))) throw new OracleRestoreError('ORACLE_CHAIN_REDO_GAP', 'The Oracle archived-redo chain has a gap or non-advancing boundary.', { category: 'integrity' });
    previousRedo = redo;
    if (metadata.backup.type.startsWith('level-1')) {
      const dataParentId = metadata.chain?.dataParentRecoveryPointId;
      const dataParent = metadataByPoint.get(dataParentId);
      const dataParentIndex = chain.findIndex((candidate) => candidate.id === dataParentId);
      if (!dataParent || dataParentIndex < 0 || dataParentIndex >= index || !['level-0', 'level-1-differential', 'level-1-cumulative'].includes(dataParent.backup?.type) || (metadata.backup.type === 'level-1-cumulative' && dataParent.backup.type !== 'level-0')) throw new OracleRestoreError('ORACLE_CHAIN_DATA_PARENT_INVALID', 'An Oracle level-1 backup has an invalid data-file parent.', { category: 'integrity' });
    }
  }
  const result = { chain, rootId: root.id, selectedPointId, metadataByPoint, ...identity };
  validateRecoveryTarget(target, result);
  return result;
}

function validateTarListing(value, expectedPieces) {
  const names = (expectedPieces || []).map((piece) => requiredText(piece.fileName, 'Oracle RMAN piece name', 255));
  if (names.some((name) => path.posix.basename(name) !== name || !/^[A-Za-z0-9._+-]+[.]bkp$/.test(name)) || new Set(names).size !== names.length) throw new OracleRestoreError('ORACLE_RESTORE_PIECE_METADATA_UNSAFE', 'Oracle RMAN piece metadata contains an unsafe or duplicate name.', { category: 'integrity' });
  const expected = new Set(names);
  const observed = new Set();
  const lines = String(value || '').split(/\r?\n/).filter(Boolean);
  if (!lines.length || !expected.size) throw new OracleRestoreError('ORACLE_RESTORE_ARCHIVE_EMPTY', 'An Oracle RMAN recovery archive is empty.', { category: 'integrity' });
  for (const line of lines) {
    const match = /^-\S*\s+\S+\s+\d+\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?(?:[.]\d+)?(?:\s+[+-]\d{4})?\s+(.+)$/.exec(line);
    const name = match?.[1]?.trim().replace(/^\.\//, '');
    if (!name || name.includes('/') || !expected.has(name) || observed.has(name)) throw new OracleRestoreError('ORACLE_RESTORE_ARCHIVE_UNSAFE', 'An Oracle RMAN recovery archive contains an unexpected, duplicate, or unsafe member.', { category: 'integrity' });
    observed.add(name);
  }
  if (observed.size !== expected.size) throw new OracleRestoreError('ORACLE_RESTORE_ARCHIVE_INCOMPLETE', 'An Oracle RMAN recovery archive is missing an authenticated piece.', { category: 'integrity' });
  return true;
}

function rmanUntilClause(target, terminalMetadata) {
  if (target.type === 'scn') return `SET UNTIL SCN ${decimalText(target.value, 'Oracle recovery SCN')};`;
  if (target.type === 'sequence') return `SET UNTIL SEQUENCE ${decimalText(target.value, 'Oracle archived-log sequence')} THREAD 1;`;
  if (target.type === 'time') {
    const utc = new Date(target.value).toISOString().replace('T', ' ').replace(/[.]\d{3}Z$/, '');
    return `SET UNTIL TIME "CAST(TO_TIMESTAMP_TZ('${utc} +00:00', 'YYYY-MM-DD HH24:MI:SS TZH:TZM') AT LOCAL TIME ZONE AS DATE)";`;
  }
  return `SET UNTIL SCN ${decimalText(terminalMetadata.archivedRedo.endScn, 'Oracle terminal recovery SCN')};`;
}

function originalRestoreScript(chain, mediaDirectory, target, bootstrapPfilePath = null) {
  const directory = normalizeRemotePath(mediaDirectory, 'Oracle restore media directory');
  const allMetadata = chain.chain.map((point) => chain.metadataByPoint.get(point.id));
  const allPieces = allMetadata.flatMap((metadata) => metadata.pieces || []);
  const control = [...allPieces].reverse().find((piece) => piece.kind === 'control-file');
  const spfile = [...allPieces].reverse().find((piece) => piece.kind === 'spfile');
  if (!control || !spfile) throw new OracleRestoreError('ORACLE_RESTORE_BOOT_MEDIA_MISSING', 'Oracle recovery requires authenticated control-file and SPFILE pieces.', { category: 'integrity' });
  const terminal = chain.metadataByPoint.get(chain.selectedPointId);
  const startup = bootstrapPfilePath ? `STARTUP FORCE NOMOUNT PFILE='${normalizeRemotePath(bootstrapPfilePath, 'Oracle bootstrap PFILE')}';` : 'STARTUP FORCE NOMOUNT;';
  return `SET DBID ${decimalText(chain.dbid, 'Oracle DBID')};
${startup}
RESTORE SPFILE FROM '${directory}/${spfile.fileName}';
SHUTDOWN IMMEDIATE;
STARTUP NOMOUNT;
RESTORE CONTROLFILE FROM '${directory}/${control.fileName}';
ALTER DATABASE MOUNT;
CATALOG START WITH '${directory}/' NOPROMPT;
RUN {
  ${rmanUntilClause(target, terminal)}
  RESTORE DATABASE;
  RECOVER DATABASE;
}
SQL "ALTER DATABASE OPEN RESETLOGS";
EXIT;
`;
}

function bootstrapPfile(profile, chain) {
  const compatible = `${chain.major}.0.0`;
  return `db_name='${profile.oracleSid}'
db_unique_name='${profile.databaseUniqueName}'
compatible='${compatible}'
db_create_file_dest='${profile.dataDirectory}'
db_create_online_log_dest_1='${profile.redoDirectory}'
db_recovery_file_dest='${profile.recoveryAreaDirectory}'
db_recovery_file_dest_size=${profile.recoveryAreaSizeBytes}
control_files='${profile.recoveryAreaDirectory}/control01.ctl','${profile.recoveryAreaDirectory}/control02.ctl'
service_names='${profile.databaseUniqueName}'
${chain.metadataByPoint.get(chain.rootId).database?.cdb ? 'enable_pluggable_database=true\n' : ''}`;
}

function originalBootstrapPfile(execution, chain) {
  return `db_name='${chain.databaseName}'
compatible='${chain.major}.0.0'
${chain.metadataByPoint.get(chain.rootId).database?.cdb ? 'enable_pluggable_database=true\n' : ''}`;
}

function alternateRestoreScript(chain, mediaDirectory, target, bootstrapPfilePath, profile) {
  const directory = normalizeRemotePath(mediaDirectory, 'Oracle restore media directory');
  const pfile = normalizeRemotePath(bootstrapPfilePath, 'Oracle bootstrap PFILE');
  const terminal = chain.metadataByPoint.get(chain.selectedPointId);
  return `SET DBID ${decimalText(chain.dbid, 'Oracle DBID')};
STARTUP FORCE NOMOUNT PFILE='${pfile}';
RUN {
  ${rmanUntilClause(target, terminal)}
  DUPLICATE DATABASE TO ${profile.oracleSid}
    BACKUP LOCATION '${directory}'
    SPFILE
      SET db_unique_name '${profile.databaseUniqueName}'
      SET db_create_file_dest '${profile.dataDirectory}'
      SET db_create_online_log_dest_1 '${profile.redoDirectory}'
      SET db_recovery_file_dest '${profile.recoveryAreaDirectory}'
      SET db_recovery_file_dest_size ${profile.recoveryAreaSizeBytes}
      SET control_files '${profile.recoveryAreaDirectory}/control01.ctl'
      SET service_names '${profile.databaseUniqueName}';
}
EXIT;
`;
}

function alternatePreflightScript(profile) {
  const roots = [profile.dataDirectory, profile.recoveryAreaDirectory, profile.redoDirectory];
  const sid = profile.oracleSid;
  const markers = [`${profile.oracleHome}/dbs/spfile${sid}.ora`, `${profile.oracleHome}/dbs/init${sid}.ora`, `${profile.oracleHome}/dbs/orapw${sid}`];
  return `#!/bin/sh
set -eu
for dx_root in ${roots.map(shellQuote).join(' ')}; do
  [ ! -e "$dx_root" ] || exit 41
  dx_parent=$(dirname -- "$dx_root")
  [ -d "$dx_parent" ] && [ -w "$dx_parent" ] || exit 45
done
for dx_marker in ${markers.map(shellQuote).join(' ')}; do
  [ ! -e "$dx_marker" ] || exit 42
done
if ps -eo args= | grep -F '[o]ra_pmon_${sid}' >/dev/null 2>&1; then exit 43; fi
if [ -f /etc/oratab ] && awk -F: -v sid='${sid}' '$1 == sid { found=1 } END { exit(found ? 0 : 1) }' /etc/oratab; then exit 44; fi
exit 0
`;
}

function alternatePreflightError(error) {
  const failures = {
    41: ['ORACLE_ALTERNATE_DESTINATION_EXISTS', 'An alternate Oracle data, recovery, or redo destination already exists.'],
    42: ['ORACLE_ALTERNATE_SID_FILES_EXIST', 'The alternate Oracle SID already has an SPFILE, PFILE, or password file.'],
    43: ['ORACLE_ALTERNATE_INSTANCE_RUNNING', 'The alternate Oracle SID is already running.'],
    44: ['ORACLE_ALTERNATE_ORATAB_EXISTS', 'The alternate Oracle SID is already registered in /etc/oratab.'],
    45: ['ORACLE_ALTERNATE_PARENT_UNUSABLE', 'An alternate Oracle destination parent is missing or not writable by the Oracle owner.']
  };
  const failure = failures[Number(error?.exitCode)];
  return failure ? new OracleRestoreError(failure[0], failure[1], { category: 'conflict' }) : error;
}

function validationScript(deepValidation) {
  return `${deepValidation ? 'VALIDATE DATABASE CHECK LOGICAL;\n' : ''}REPORT SCHEMA;\nEXIT;\n`;
}

class OracleRestoreService {
  constructor({ controlDatabase, secretStore, deviceId, adapter, openRepository, sessionFactory = openSshExecutionSession, clock = () => new Date().toISOString() } = {}) {
    if (!controlDatabase || !secretStore || !adapter || typeof openRepository !== 'function') throw new TypeError('Oracle restore dependencies are required.');
    this.controlDatabase = controlDatabase;
    this.secretStore = secretStore;
    this.deviceId = requiredText(deviceId, 'Device ID', 200);
    this.adapter = adapter;
    this.openRepository = openRepository;
    this.sessionFactory = sessionFactory;
    this.clock = clock;
    this.active = new Map();
  }

  async start(workspaceId, actorId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const request = normalizeRequest(input);
    const point = await this.controlDatabase.repository('recoveryPoint').get(tenant, request.recoveryPointId);
    if (!point) throw new OracleRestoreError('ORACLE_RECOVERY_POINT_NOT_FOUND', 'The Oracle RecoveryPoint was not found.', { category: 'not-found' });
    const source = assertPhysicalSource(await this.controlDatabase.repository('source').get(tenant, point.sourceId));
    const target = request.mode === 'alternate' ? await this.targetSshConnection(tenant, request.targetProfile.sshConnectionId) : await this.targetConnections(tenant, source);
    const now = this.clock();
    const record = await this.controlDatabase.repository('restoreRun').create({
      workspaceId: tenant,
      actorId: actor,
      recoveryPointIds: [point.id],
      targetConnectionId: request.mode === 'alternate' ? target.sshConnection.id : source.connectionId,
      target: request.mode === 'alternate'
        ? { operation: 'oracle-rman', engine: 'oracle', mode: request.mode, sourceId: source.id, sshConnectionId: target.sshConnection.id, oracleSid: request.targetProfile.oracleSid, databaseUniqueName: request.targetProfile.databaseUniqueName, targetProfile: request.targetProfile, recoveryTarget: request.recoveryTarget }
        : { operation: 'oracle-rman', engine: 'oracle', mode: request.mode, sourceId: source.id, oracleConnectionId: source.connectionId, sshConnectionId: source.physicalExecution.sshConnectionId, oracleSid: source.physicalExecution.oracleSid, recoveryTarget: request.recoveryTarget },
      mode: request.mode,
      conflictPolicy: 'fail',
      workerId: `device:${this.deviceId}`,
      state: 'queued',
      progress: { phase: 'queued', itemsTotal: 0, itemsCompleted: 0, bytesTotal: 0, bytesWritten: 0, throughputBytesPerSecond: 0, startedAt: null, updatedAt: now, warnings: [] },
      validation: null,
      result: null
    });
    const controller = new AbortController();
    const operation = this.execute(tenant, actor, record.id, request, controller.signal).catch(() => this.controlDatabase.repository('restoreRun').get(tenant, record.id));
    this.active.set(record.id, { operation, controller });
    operation.finally(() => this.active.delete(record.id));
    return record;
  }

  async wait(workspaceId, restoreRunId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const id = requiredText(restoreRunId, 'RestoreRun ID', 200);
    if (this.active.has(id)) await this.active.get(id).operation;
    const record = await this.controlDatabase.repository('restoreRun').get(tenant, id);
    if (!record || record.target?.operation !== 'oracle-rman') throw new OracleRestoreError('ORACLE_RESTORE_RUN_NOT_FOUND', 'The Oracle RestoreRun was not found.', { category: 'not-found' });
    return record;
  }

  async cancel(workspaceId, actorId, restoreRunId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    requiredText(actorId, 'Actor ID', 200);
    const id = requiredText(restoreRunId, 'RestoreRun ID', 200);
    const record = await this.controlDatabase.repository('restoreRun').get(tenant, id);
    if (!record || record.target?.operation !== 'oracle-rman') throw new OracleRestoreError('ORACLE_RESTORE_RUN_NOT_FOUND', 'The Oracle RestoreRun was not found.', { category: 'not-found' });
    if (TERMINAL_STATES.has(record.state)) return record;
    const active = this.active.get(id);
    if (!active) throw new OracleRestoreError('ORACLE_RESTORE_NOT_ACTIVE', 'The Oracle restore is not active in this DeployerX process.', { category: 'conflict' });
    active.controller.abort();
    await active.operation;
    return this.controlDatabase.repository('restoreRun').get(tenant, id);
  }

  async list(workspaceId, options = {}) {
    return (await this.controlDatabase.repository('restoreRun').list(requiredText(workspaceId, 'Workspace ID', 200), { limit: Math.min(200, Math.max(1, Number(options.limit) || 50)) })).filter((record) => record.target?.operation === 'oracle-rman');
  }

  async reconcile(workspaceId, actorId = 'system') {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const recovered = [];
    for (const record of (await this.list(tenant, { limit: 200 })).filter((item) => !TERMINAL_STATES.has(item.state) && !this.active.has(item.id))) {
      recovered.push(await this.project(tenant, record.id, { state: 'failed', progress: { ...(record.progress || {}), phase: 'failed', updatedAt: this.clock() }, result: { error: { code: 'ORACLE_RESTORE_INTERRUPTED', category: 'physical-restore', retryable: false, safeMessage: 'The DeployerX process stopped during Oracle recovery. Inspect the target instance before retrying.' }, completedAt: this.clock() } }, actorId));
    }
    return recovered;
  }

  async project(workspaceId, id, changes, actorId) {
    return this.controlDatabase.transaction((transaction) => {
      const current = transaction.get('restoreRun', workspaceId, id);
      return transaction.projectExecution('restoreRun', workspaceId, id, changes, { expectedRevision: current.revision, actorId });
    });
  }

  async targetConnections(workspaceId, source) {
    const [databaseConnection, sshConnection] = await Promise.all([
      this.controlDatabase.repository('connection').get(workspaceId, source.connectionId),
      this.controlDatabase.repository('connection').get(workspaceId, source.physicalExecution.sshConnectionId)
    ]);
    if (!databaseConnection || databaseConnection.adapterId !== ADAPTER_ID || databaseConnection.lastTest?.status !== 'success' || !databaseConnection.lastTest?.endpointIdentity?.databaseFingerprint) throw new OracleRestoreError('ORACLE_RESTORE_DATABASE_UNHEALTHY', 'Retest the target Oracle connection before recovery.', { category: 'connectivity' });
    if (!sshConnection || sshConnection.adapterId !== 'deployerx.connection.ssh' || sshConnection.lastTest?.status !== 'success') throw new OracleRestoreError('ORACLE_RESTORE_SSH_UNHEALTHY', 'Retest the target SSH execution connection before recovery.', { category: 'connectivity' });
    if (![databaseConnection, sshConnection].every((connection) => (connection.workerAffinity || []).includes(`device:${this.deviceId}`))) throw new OracleRestoreError('ORACLE_RESTORE_OTHER_DEVICE', 'The Oracle recovery target belongs to another device.', { category: 'authorization' });
    const [passwordSecretRefId] = databaseConnection.secretRefIds || [];
    return { databaseConnection, sshConnection, connectionConfig: this.adapter.normalizeConfig({ ...databaseConnection.endpoint, passwordSecretRefId }) };
  }

  async targetSshConnection(workspaceId, sshConnectionId) {
    const sshConnection = await this.controlDatabase.repository('connection').get(workspaceId, sshConnectionId);
    if (!sshConnection || sshConnection.adapterId !== 'deployerx.connection.ssh' || sshConnection.lastTest?.status !== 'success') throw new OracleRestoreError('ORACLE_ALTERNATE_SSH_UNHEALTHY', 'Retest the alternate Oracle SSH connection before recovery.', { category: 'connectivity' });
    if (!(sshConnection.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new OracleRestoreError('ORACLE_RESTORE_OTHER_DEVICE', 'The Oracle recovery target belongs to another device.', { category: 'authorization' });
    return { sshConnection };
  }

  async loadChain(workspaceId, selectedPointId, target) {
    const [points, artifacts] = await Promise.all([
      this.controlDatabase.repository('recoveryPoint').list(workspaceId, { limit: 1000 }),
      this.controlDatabase.repository('artifact').list(workspaceId, { limit: 5000 })
    ]);
    const relevant = artifacts.filter((artifact) => ['physical-backup', 'transaction-log'].includes(artifact.kind) && artifact.metadata?.kind === 'oracle-rman');
    const metadataByPoint = new Map();
    for (const artifact of relevant) if (!metadataByPoint.has(artifact.recoveryPointId)) metadataByPoint.set(artifact.recoveryPointId, artifact.metadata);
    return { ...validateChain(points, metadataByPoint, selectedPointId, target), artifacts: relevant };
  }

  async repositoryFile(workspaceId, point, artifacts) {
    for (const copy of (point.repositoryCopies || []).filter((item) => item.state === 'available')) {
      const artifact = artifacts.find((item) => item.recoveryPointId === point.id && item.repositoryId === copy.repositoryId && item.metadata?.kind === 'oracle-rman');
      if (!artifact) continue;
      const opened = await this.openRepository(workspaceId, copy.repositoryId);
      const snapshot = await opened.engine.openSnapshot({}, { repositoryId: copy.repositoryId, snapshotId: copy.engineSnapshotId, masterKey: opened.masterKey });
      const file = snapshot.manifest.files.find((item) => item.type === 'file' && item.path === artifact.metadata?.artifact?.path && item.metadata?.artifactKind === artifact.kind);
      const authenticatedMetadata = file?.metadata?.database;
      if (!file || Number(file.sizeBytes) !== Number(artifact.sizeBytes) || file.contentDigest?.digest !== artifact.checksum?.digest || authenticatedMetadata?.kind !== 'oracle-rman' || !isDeepStrictEqual(authenticatedMetadata, artifact.metadata)) throw new OracleRestoreError('ORACLE_RESTORE_ARTIFACT_INVALID', 'An Oracle RMAN Artifact does not match its authenticated repository manifest.', { category: 'integrity' });
      return { copy, artifact, metadata: authenticatedMetadata, opened, snapshot, file };
    }
    throw new OracleRestoreError('ORACLE_RESTORE_ARTIFACT_UNAVAILABLE', 'No available repository copy contains a required Oracle RMAN Artifact.', { category: 'not-found' });
  }

  async writeRemote(session, execution, remotePath, content) {
    async function* bytes() { yield Buffer.from(content, 'utf8'); }
    await session.consume(operatingSystemCommand(execution, 'tee', [remotePath]), bytes(), { stdoutLimitBytes: 1024 });
    await session.run(operatingSystemCommand(execution, 'chmod', ['600', remotePath]), { stdoutLimitBytes: 1024 });
  }

  async execute(workspaceId, actorId, restoreRunId, request, signal) {
    let session = null;
    let remoteWorkspace = null;
    let execution = null;
    let progress = { phase: 'preparing', itemsTotal: 0, itemsCompleted: 0, bytesTotal: 0, bytesWritten: 0, throughputBytesPerSecond: 0, startedAt: this.clock(), updatedAt: this.clock(), warnings: [] };
    const startedMs = Date.now();
    try {
      await this.project(workspaceId, restoreRunId, { state: 'preparing', progress }, actorId);
      const selectedPoint = await this.controlDatabase.repository('recoveryPoint').get(workspaceId, request.recoveryPointId);
      const source = assertPhysicalSource(await this.controlDatabase.repository('source').get(workspaceId, selectedPoint?.sourceId));
      const chain = await this.loadChain(workspaceId, selectedPoint.id, request.recoveryTarget);
      if (chain.metadataByPoint.get(chain.rootId).database?.encryptedTablespaces || chain.metadataByPoint.get(chain.rootId).database?.asmDatafiles) throw new OracleRestoreError('ORACLE_RESTORE_STORAGE_UNSUPPORTED', 'Oracle TDE or ASM media cannot be restored by this release.', { category: 'compatibility' });
      const connections = request.mode === 'alternate' ? await this.targetSshConnection(workspaceId, request.targetProfile.sshConnectionId) : await this.targetConnections(workspaceId, source);
      if (request.mode === 'original' && (connections.databaseConnection.lastTest.endpointIdentity.databaseFingerprint !== chain.databaseFingerprint || connections.databaseConnection.lastTest.endpointIdentity.dbid !== chain.dbid)) throw new OracleRestoreError('ORACLE_RESTORE_ORIGINAL_IDENTITY_MISMATCH', 'The original Oracle target no longer matches the protected DBID.', { category: 'integrity' });
      const files = [];
      for (const point of chain.chain) files.push(await this.repositoryFile(workspaceId, point, chain.artifacts));
      progress.itemsTotal = files.length;
      progress.bytesTotal = files.reduce((sum, item) => sum + Number(item.file.sizeBytes || 0), 0);
      execution = request.mode === 'alternate' ? request.targetProfile : source.physicalExecution;
      session = await this.sessionFactory({ connectionConfig: connectionConfigFromRecord(connections.sshConnection), resolveSecret: (secretRefId) => this.secretStore.resolve({ workspaceId, id: secretRefId }), signal });
      const [sqlplusVersionResult, rmanVersionResult, ownerResult] = await Promise.all([
        session.run(oracleCommand(execution, execution.sqlplusExecutable, ['-V']), { stdoutLimitBytes: 8192 }),
        session.run(oracleCommand(execution, execution.rmanExecutable, ['-version']), { stdoutLimitBytes: 8192 }),
        session.run(operatingSystemCommand(execution, 'id', ['-un']), { stdoutLimitBytes: 1024 })
      ]);
      const sqlplus = parseOracleToolVersion(`${sqlplusVersionResult.stdout}\n${sqlplusVersionResult.stderr}`, 'SQL*Plus');
      const rman = parseOracleToolVersion(`${rmanVersionResult.stdout}\n${rmanVersionResult.stderr}`, 'RMAN');
      if (sqlplus.major !== chain.major || rman.major !== chain.major) throw new OracleRestoreError('ORACLE_RESTORE_TOOL_MAJOR_MISMATCH', 'Oracle restore tools must match the backup major release.', { category: 'compatibility' });
      if (requiredText(ownerResult.stdout, 'Oracle execution owner', 128) !== execution.oracleOwner) throw new OracleRestoreError('ORACLE_RESTORE_OWNER_MISMATCH', 'Oracle recovery is not running as the configured software owner.', { category: 'authorization' });
      const temporaryRoot = normalizeRemotePath(execution.remoteTemporaryDirectory, 'Oracle remote temporary directory');
      const allocated = await session.run(operatingSystemCommand(execution, 'mktemp', ['-d', '-p', temporaryRoot, `deployerx-oracle-restore-${String(restoreRunId).replace(/[^A-Za-z0-9]/g, '').slice(0, 20)}.XXXXXX`]), { stdoutLimitBytes: 8192 });
      remoteWorkspace = normalizeRemotePath(allocated.stdout.trim(), 'Allocated Oracle restore workspace');
      if (path.posix.dirname(remoteWorkspace) !== temporaryRoot || !path.posix.basename(remoteWorkspace).startsWith('deployerx-oracle-restore-')) throw new OracleRestoreError('ORACLE_RESTORE_WORKSPACE_INVALID', 'The Oracle restore workspace is outside the approved temporary directory.', { category: 'integrity' });
      const mediaDirectory = path.posix.join(remoteWorkspace, 'media');
      await session.run(operatingSystemCommand(execution, 'mkdir', ['-m', '0700', '--', mediaDirectory]), { stdoutLimitBytes: 1024 });
      for (let index = 0; index < files.length; index += 1) {
        const item = files[index];
        const archivePath = path.posix.join(remoteWorkspace, `point-${index}.tar`);
        const content = (async function* tracked() {
          const stream = item.opened.engine.streamFile({}, { repositoryId: item.copy.repositoryId, manifest: item.snapshot.manifest, masterKey: item.opened.masterKey, path: item.file.path });
          for await (const chunk of stream) {
            progress.bytesWritten += Buffer.byteLength(chunk);
            progress.throughputBytesPerSecond = Math.round(progress.bytesWritten / Math.max(1, (Date.now() - startedMs) / 1000));
            yield chunk;
          }
        })();
        await session.consume(operatingSystemCommand(execution, 'tee', [archivePath]), content, { stderrLimitBytes: 4 * 1024 * 1024 });
        const staged = await session.run(operatingSystemCommand(execution, execution.statExecutable, ['--format=%s', '--', archivePath]), { stdoutLimitBytes: 1024 });
        if (Number(staged.stdout.trim()) !== Number(item.file.sizeBytes)) throw new OracleRestoreError('ORACLE_RESTORE_ARCHIVE_SIZE_MISMATCH', 'A staged Oracle RMAN archive changed size.', { category: 'integrity' });
        const listing = await session.run(operatingSystemCommand(execution, execution.tarExecutable, ['--list', '--verbose', `--file=${archivePath}`]), { stdoutLimitBytes: 16 * 1024 * 1024 });
        validateTarListing(listing.stdout, item.metadata.pieces);
        await session.run(operatingSystemCommand(execution, execution.tarExecutable, ['--extract', `--file=${archivePath}`, `--directory=${mediaDirectory}`, '--no-same-owner', '--no-same-permissions', '--keep-old-files']), { stdoutLimitBytes: 1024 * 1024, stderrLimitBytes: 4 * 1024 * 1024 });
        for (const piece of item.metadata.pieces) {
          const piecePath = path.posix.join(mediaDirectory, piece.fileName);
          const [stat, checksum] = await Promise.all([
            session.run(operatingSystemCommand(execution, execution.statExecutable, ['--format=%s', '--', piecePath]), { stdoutLimitBytes: 1024 }),
            session.run(operatingSystemCommand(execution, execution.sha256sumExecutable, ['--', piecePath]), { stdoutLimitBytes: 1024 })
          ]);
          if (Number(stat.stdout.trim()) !== Number(piece.sizeBytes) || String(checksum.stdout || '').trim().split(/\s+/)[0]?.toLowerCase() !== piece.checksum?.digest) throw new OracleRestoreError('ORACLE_RESTORE_PIECE_TAMPERED', 'A materialized Oracle RMAN piece failed authenticated size or checksum validation.', { category: 'integrity' });
        }
        progress.itemsCompleted += 1;
        progress.updatedAt = this.clock();
        await this.project(workspaceId, restoreRunId, { state: 'running', progress: { ...progress, phase: 'materializing' } }, actorId);
      }
      const restoreCommandFile = path.posix.join(remoteWorkspace, 'restore.rman');
      const restoreLog = path.posix.join(remoteWorkspace, 'restore.log');
      if (request.mode === 'alternate') {
        const preflightFile = path.posix.join(remoteWorkspace, 'alternate-preflight.sh');
        await this.writeRemote(session, execution, preflightFile, alternatePreflightScript(request.targetProfile));
        try {
          await session.run(operatingSystemCommand(execution, '/bin/sh', [preflightFile]), { stdoutLimitBytes: 8192 });
        } catch (error) {
          throw alternatePreflightError(error);
        }
        for (const destination of [execution.dataDirectory, execution.recoveryAreaDirectory, execution.redoDirectory]) await session.run(operatingSystemCommand(execution, 'mkdir', ['-m', '0750', '--', destination]), { stdoutLimitBytes: 1024 });
        const bootstrapFile = path.posix.join(remoteWorkspace, `init${execution.oracleSid}.ora`);
        await this.writeRemote(session, execution, bootstrapFile, bootstrapPfile(execution, chain));
        await this.writeRemote(session, execution, restoreCommandFile, alternateRestoreScript(chain, mediaDirectory, request.recoveryTarget, bootstrapFile, execution));
      } else {
        const bootstrapFile = path.posix.join(remoteWorkspace, `init${execution.oracleSid}.ora`);
        await this.writeRemote(session, execution, bootstrapFile, originalBootstrapPfile(execution, chain));
        await this.writeRemote(session, execution, restoreCommandFile, originalRestoreScript(chain, mediaDirectory, request.recoveryTarget, bootstrapFile));
      }
      progress.phase = 'restoring';
      progress.updatedAt = this.clock();
      await this.project(workspaceId, restoreRunId, { state: 'running', progress }, actorId);
      await session.run(oracleCommand(execution, execution.rmanExecutable, request.mode === 'alternate' ? ['auxiliary', '/', 'cmdfile', restoreCommandFile, 'log', restoreLog] : ['target', '/', 'cmdfile', restoreCommandFile, 'log', restoreLog]), { stdoutLimitBytes: 4 * 1024 * 1024, stderrLimitBytes: 4 * 1024 * 1024 });
      const validationCommandFile = path.posix.join(remoteWorkspace, 'validate.rman');
      const validationLog = path.posix.join(remoteWorkspace, 'validate.log');
      await this.writeRemote(session, execution, validationCommandFile, validationScript(request.deepValidation));
      await session.run(oracleCommand(execution, execution.rmanExecutable, ['target', '/', 'cmdfile', validationCommandFile, 'log', validationLog]), { stdoutLimitBytes: 4 * 1024 * 1024, stderrLimitBytes: 4 * 1024 * 1024 });
      const identityScript = path.posix.join(remoteWorkspace, 'identity.sql');
      await this.writeRemote(session, execution, identityScript, remoteSqlPlusScript(remoteIdentityQuery()));
      const restoredResult = await session.run(oracleCommand(execution, execution.sqlplusExecutable, ['-L', '-S', '/nolog', `@${identityScript}`]), { stdoutLimitBytes: 16384 });
      const restored = parseIdentity(restoredResult.stdout);
      if (request.mode === 'alternate') {
        if (restored.dbid === chain.dbid || restored.databaseName.toUpperCase() !== execution.oracleSid || restored.databaseUniqueName.toLowerCase() !== execution.databaseUniqueName.toLowerCase() || restored.databaseRole !== 'PRIMARY' || restored.openMode !== 'READ WRITE' || restored.logMode !== 'ARCHIVELOG' || restored.cdb !== Boolean(chain.metadataByPoint.get(chain.rootId).database?.cdb)) throw new OracleRestoreError('ORACLE_ALTERNATE_VALIDATION_FAILED', 'The alternate Oracle database failed new-DBID, identity, topology, or open-mode validation.', { category: 'integrity' });
      } else if (restored.dbid !== chain.dbid || restored.databaseName !== chain.databaseName || restored.databaseRole !== 'PRIMARY' || restored.openMode !== 'READ WRITE' || restored.logMode !== 'ARCHIVELOG' || restored.incarnation <= Number(chain.incarnation) || databaseFingerprint(restored) !== chain.databaseFingerprint) {
        throw new OracleRestoreError('ORACLE_RESTORE_VALIDATION_FAILED', 'The restored Oracle database failed DBID, open-mode, or new-incarnation validation.', { category: 'integrity' });
      }
      progress.phase = 'validating';
      progress.updatedAt = this.clock();
      await this.project(workspaceId, restoreRunId, { state: 'validating', progress }, actorId);
      let connectivityCheck;
      if (request.mode === 'alternate') {
        const registerScript = path.posix.join(remoteWorkspace, 'register.sql');
        await this.writeRemote(session, execution, registerScript, remoteSqlPlusScript('ALTER SYSTEM REGISTER;'));
        await session.run(oracleCommand(execution, execution.sqlplusExecutable, ['-L', '-S', '/nolog', `@${registerScript}`]), { stdoutLimitBytes: 8192 });
        const listener = await session.run(oracleCommand(execution, execution.lsnrctlExecutable, ['status']), { stdoutLimitBytes: 1024 * 1024 });
        if (!String(listener.stdout || '').toLowerCase().includes(execution.databaseUniqueName.toLowerCase())) throw new OracleRestoreError('ORACLE_ALTERNATE_LISTENER_VALIDATION_FAILED', 'The alternate Oracle service was not registered with the listener.', { category: 'connectivity' });
        connectivityCheck = { id: 'listener-registration', status: 'pass' };
      } else {
        const connectionResult = await this.adapter.testConnection({ resolveSecret: (secretRefId) => this.secretStore.resolve({ workspaceId, id: secretRefId }), signal }, connections.connectionConfig);
        if (connectionResult.status !== 'success' || connectionResult.endpointIdentity.databaseFingerprint !== chain.databaseFingerprint) throw new OracleRestoreError('ORACLE_RESTORE_CONNECTIVITY_FAILED', 'The restored Oracle database did not pass the TCPS connectivity check.', { category: 'connectivity' });
        connectivityCheck = { id: 'tcps-connectivity', status: 'pass' };
      }
      const validation = { state: 'succeeded', nativeIntegrityValidation: true, checkedAt: this.clock(), checks: [{ id: 'repository-media', status: 'pass' }, { id: request.mode === 'alternate' ? 'rman-duplicate' : 'rman-restore', status: 'pass' }, { id: request.mode === 'alternate' ? 'new-dbid' : 'dbid', status: 'pass' }, { id: 'open-mode', status: 'pass' }, { id: request.mode === 'alternate' ? 'target-identity' : 'new-incarnation', status: 'pass' }, connectivityCheck, ...(request.deepValidation ? [{ id: 'rman-check-logical', status: 'pass' }] : [])], dbid: restored.dbid, incarnation: restored.incarnation, resetlogsChange: restored.resetlogsChange };
      progress.phase = 'complete';
      progress.updatedAt = this.clock();
      return this.project(workspaceId, restoreRunId, { state: 'succeeded', progress, validation, result: { restoredRecoveryPointIds: chain.chain.map((point) => point.id), chainRootRecoveryPointId: chain.rootId, sourceDbid: chain.dbid, dbid: restored.dbid, databaseName: restored.databaseName, databaseUniqueName: restored.databaseUniqueName, incarnation: restored.incarnation, bytesRestored: progress.bytesWritten, recoveryTarget: request.recoveryTarget, completedAt: this.clock() } }, actorId);
    } catch (error) {
      const current = await this.controlDatabase.repository('restoreRun').get(workspaceId, restoreRunId);
      if (current && !TERMINAL_STATES.has(current.state)) {
        const canceled = signal?.aborted || error?.code === 'SSH_EXECUTION_CANCELED';
        return this.project(workspaceId, restoreRunId, { state: canceled ? 'canceled' : 'failed', progress: { ...progress, phase: canceled ? 'canceled' : 'failed', updatedAt: this.clock() }, result: { error: canceled ? { code: 'ORACLE_RESTORE_CANCELED', category: 'canceled', retryable: false, safeMessage: 'The Oracle restore was canceled.' } : safeError(error), completedAt: this.clock() } }, actorId);
      }
      throw error;
    } finally {
      if (session && remoteWorkspace && path.posix.basename(remoteWorkspace).startsWith('deployerx-oracle-restore-')) await session.run(commandFromArgs(execution?.rmExecutable || 'rm', ['-rf', '--', remoteWorkspace], { privilegeMode: execution?.privilegeMode || 'direct', ...(execution?.privilegeMode === 'sudo-noninteractive' ? { runAsUser: execution.oracleOwner } : {}) }), { stdoutLimitBytes: 1024, ignoreAbort: true }).catch(() => {});
      session?.close();
    }
  }
}

module.exports = {
  RESETLOGS_CONFIRMATION,
  RESTORE_CONFIRMATIONS,
  OracleRestoreError,
  OracleRestoreService,
  alternatePreflightScript,
  alternateRestoreScript,
  assertPhysicalSource,
  bootstrapPfile,
  normalizeAlternateTargetProfile,
  originalBootstrapPfile,
  normalizeRecoveryTarget,
  normalizeRequest,
  originalRestoreScript,
  rmanUntilClause,
  validateChain,
  validateRecoveryTarget,
  validateTarListing,
  validationScript
};
