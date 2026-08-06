const path = require('path');
const { ADAPTER_ID, pgpassContents, sslMode } = require('./postgresql-logical');
const { nextWalSegment, parsePostgresqlToolVersion, parseWalSegmentSize } = require('./postgresql-physical');
const { commandFromArgs, connectionConfigFromRecord, openSshExecutionSession, shellQuote } = require('./ssh-execution');

const RESTORE_CONFIRMATIONS = Object.freeze({ original: 'RESTORE POSTGRESQL PHYSICAL', alternate: 'RESTORE POSTGRESQL PHYSICAL ALTERNATE' });
const TERMINAL_STATES = new Set(['succeeded', 'warning', 'failed', 'canceled']);
const TARGET_TYPES = new Set(['latest', 'immediate', 'time', 'lsn', 'xid', 'name']);
const WAL_FILE_PATTERN = /^[0-9A-F]{24}$/;
const HISTORY_FILE_PATTERN = /^[0-9A-F]{8}[.]history$/;

class PostgresqlPitrRestoreError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'PostgresqlPitrRestoreError';
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
  if (!TARGET_TYPES.has(type)) throw new PostgresqlPitrRestoreError('POSTGRESQL_PITR_TARGET_INVALID', 'Choose a supported PostgreSQL recovery target.', { category: 'validation' });
  let value = null;
  if (type === 'time') {
    const candidate = requiredText(input.value, 'Recovery target time', 100);
    if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(candidate) || !Number.isFinite(Date.parse(candidate))) throw new PostgresqlPitrRestoreError('POSTGRESQL_PITR_TIME_INVALID', 'Enter a recovery timestamp with an explicit UTC offset.', { category: 'validation' });
    value = new Date(candidate).toISOString();
  } else if (type === 'lsn') {
    value = requiredText(input.value, 'Recovery target LSN', 40).toUpperCase();
    if (!/^[0-9A-F]{1,8}\/[0-9A-F]{1,8}$/.test(value)) throw new PostgresqlPitrRestoreError('POSTGRESQL_PITR_LSN_INVALID', 'The recovery target LSN is invalid.', { category: 'validation' });
  } else if (type === 'xid') {
    value = requiredText(input.value, 'Recovery target transaction ID', 30);
    if (!/^\d{1,30}$/.test(value)) throw new PostgresqlPitrRestoreError('POSTGRESQL_PITR_XID_INVALID', 'The recovery target transaction ID is invalid.', { category: 'validation' });
  } else if (type === 'name') {
    value = requiredText(input.value, 'Recovery target name', 200);
    if (!/^[A-Za-z0-9_.:@+ -]+$/.test(value)) throw new PostgresqlPitrRestoreError('POSTGRESQL_PITR_NAME_INVALID', 'The recovery target name contains unsupported characters.', { category: 'validation' });
  }
  const timeline = String(input.timeline || 'latest').toLowerCase();
  if (!['latest', 'current'].includes(timeline) && !/^[1-9]\d{0,9}$/.test(timeline)) throw new PostgresqlPitrRestoreError('POSTGRESQL_PITR_TIMELINE_INVALID', 'The recovery target timeline is invalid.', { category: 'validation' });
  return Object.freeze({ type, value, inclusive: input.inclusive !== false, timeline });
}

function normalizeRequest(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('PostgreSQL physical restore request must be an object.');
  const mode = String(input.mode || 'original');
  if (!RESTORE_CONFIRMATIONS[mode]) throw new PostgresqlPitrRestoreError('POSTGRESQL_PITR_MODE_INVALID', 'Choose the original or an alternate PostgreSQL physical target.', { category: 'validation' });
  if (input.confirmed !== true || String(input.confirmationText || '').trim() !== RESTORE_CONFIRMATIONS[mode]) throw new PostgresqlPitrRestoreError('POSTGRESQL_PITR_CONFIRMATION_REQUIRED', 'Enter the exact destructive PostgreSQL physical restore confirmation.', { category: 'conflict' });
  return {
    recoveryPointId: requiredText(input.recoveryPointId, 'RecoveryPoint ID', 200), mode,
    targetSourceId: mode === 'alternate' ? requiredText(input.targetSourceId, 'Alternate physical Source ID', 200) : null,
    recoveryTarget: normalizeRecoveryTarget(input.recoveryTarget)
  };
}

function safeError(error) {
  if (error instanceof PostgresqlPitrRestoreError || error?.code) return { code: String(error.code).slice(0, 100), category: String(error.category || 'physical-restore').slice(0, 80), retryable: Boolean(error.retryable), safeMessage: String(error.message || 'The PostgreSQL physical restore failed.').slice(0, 500) };
  return { code: 'POSTGRESQL_PITR_RESTORE_FAILED', category: 'physical-restore', retryable: false, safeMessage: 'DeployerX could not complete the PostgreSQL physical restore.' };
}

function assertPhysicalSource(source) {
  if (!source || source.adapterId !== ADAPTER_ID || source.consistency?.backupMethod !== 'physical' || source.physicalExecution?.engine !== 'postgresql') throw new PostgresqlPitrRestoreError('POSTGRESQL_PITR_TARGET_SOURCE_INVALID', 'Choose a configured PostgreSQL physical Source as the restore target.', { category: 'validation' });
  return source;
}

function validateChain(points, metadataByPoint, selectedPointId) {
  const byId = new Map(points.map((point) => [point.id, point]));
  const reversed = [];
  const visited = new Set();
  let current = byId.get(selectedPointId);
  while (current) {
    if (visited.has(current.id)) throw new PostgresqlPitrRestoreError('POSTGRESQL_PITR_CHAIN_CYCLE', 'The PostgreSQL recovery chain contains a cycle.', { category: 'integrity' });
    visited.add(current.id); reversed.push(current);
    if (!current.parentRecoveryPointId) break;
    current = byId.get(current.parentRecoveryPointId);
    if (!current) throw new PostgresqlPitrRestoreError('POSTGRESQL_PITR_CHAIN_GAP', 'A required PostgreSQL recovery point is missing.', { category: 'integrity' });
  }
  const chain = reversed.reverse();
  if (!chain.length || chain[0].type !== 'full') throw new PostgresqlPitrRestoreError('POSTGRESQL_PITR_ANCHOR_MISSING', 'The PostgreSQL recovery chain has no full base-backup anchor.', { category: 'integrity' });
  const rootId = chain[0].id;
  let systemIdentifier = null;
  let sourceId = null;
  let jobId = null;
  let major = null;
  let segmentSizeBytes = null;
  let lastSegment = null;
  for (let index = 0; index < chain.length; index += 1) {
    const point = chain[index];
    const metadata = metadataByPoint.get(point.id);
    const expectedKind = index === 0 ? 'postgresql-basebackup' : 'postgresql-wal';
    if (!metadata || metadata.kind !== expectedKind) throw new PostgresqlPitrRestoreError('POSTGRESQL_PITR_METADATA_INVALID', 'A PostgreSQL recovery point lacks authenticated physical metadata.', { category: 'integrity' });
    if (index > 0 && (point.type !== 'log' || point.parentRecoveryPointId !== chain[index - 1].id || point.chainRootId !== rootId)) throw new PostgresqlPitrRestoreError('POSTGRESQL_PITR_PARENT_INVALID', 'The PostgreSQL WAL chain has an invalid parent or root.', { category: 'integrity' });
    systemIdentifier ||= metadata.server?.systemIdentifier;
    sourceId ||= metadata.source?.sourceId;
    jobId ||= metadata.source?.jobId;
    major ||= metadata.server?.major;
    segmentSizeBytes ||= metadata.wal?.segmentSizeBytes;
    if (!/^\d{1,30}$/.test(systemIdentifier || '') || metadata.server?.systemIdentifier !== systemIdentifier || metadata.source?.sourceId !== sourceId || metadata.source?.jobId !== jobId || metadata.server?.major !== major || metadata.wal?.segmentSizeBytes !== segmentSizeBytes || point.sourceId !== sourceId || point.jobId !== jobId) throw new PostgresqlPitrRestoreError('POSTGRESQL_PITR_CHAIN_MISMATCH', 'The PostgreSQL recovery chain mixes different clusters, Sources, jobs, versions, or WAL formats.', { category: 'integrity' });
    if (index === 0) lastSegment = metadata.wal?.endSegment || metadata.wal?.lastSegment;
    else {
      const expectedFirst = nextWalSegment(lastSegment, segmentSizeBytes);
      if (metadata.wal?.firstSegment !== expectedFirst) throw new PostgresqlPitrRestoreError('POSTGRESQL_PITR_WAL_GAP', 'The PostgreSQL recovery chain has a WAL segment gap.', { category: 'integrity' });
      lastSegment = metadata.wal.lastSegment;
    }
  }
  return { chain, rootId, systemIdentifier, sourceId, jobId, major, segmentSizeBytes, lastSegment };
}

function postgresConfigLiteral(value) { return `'${String(value).replace(/'/g, "''")}'`; }

function recoveryConfiguration(target, walDirectory, major, alternate) {
  const restoreCommand = `cp -- ${shellQuote(path.posix.join(walDirectory, '%f'))} ${shellQuote('%p')}`;
  const lines = [`restore_command = ${postgresConfigLiteral(restoreCommand)}`, `recovery_target_timeline = ${postgresConfigLiteral(target.timeline)}`, "recovery_target_action = 'promote'"];
  if (target.type === 'immediate') lines.push("recovery_target = 'immediate'");
  else if (target.type !== 'latest') {
    lines.push(`recovery_target_${target.type} = ${postgresConfigLiteral(target.value)}`);
    if (['time', 'lsn', 'xid'].includes(target.type)) lines.push(`recovery_target_inclusive = ${target.inclusive ? 'on' : 'off'}`);
  }
  if (alternate) {
    lines.push("archive_command = ''");
    if (major >= 15) lines.push("archive_library = ''");
  }
  return `${lines.join('\n')}\n`;
}

function validateTarListing(value, kind, expectedNames = []) {
  const lines = String(value || '').split(/\r?\n/).filter(Boolean);
  if (!lines.length) throw new PostgresqlPitrRestoreError('POSTGRESQL_PITR_ARCHIVE_EMPTY', 'A PostgreSQL recovery archive is empty.', { category: 'integrity' });
  const expected = new Set(expectedNames);
  const observed = new Set();
  for (const line of lines) {
    const match = /^([-d])\S*\s+\S+\s+\d+\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?(?:[.]\d+)?(?:\s+[+-]\d{4})?\s+(.+)$/.exec(line);
    if (!match) throw new PostgresqlPitrRestoreError('POSTGRESQL_PITR_ARCHIVE_UNSAFE', 'A PostgreSQL recovery archive contains an unsafe member.', { category: 'integrity' });
    const type = match[1];
    const rawName = match[2].trim();
    const name = rawName === './' ? '.' : rawName.replace(/^\.\//, '').replace(/\/$/, '');
    if (!name || path.posix.isAbsolute(name) || path.posix.normalize(name).startsWith('../') || name.split('/').includes('..') || (name === '.' && type !== 'd')) throw new PostgresqlPitrRestoreError('POSTGRESQL_PITR_ARCHIVE_UNSAFE', 'A PostgreSQL recovery archive contains an unsafe member.', { category: 'integrity' });
    if (kind === 'wal') {
      if (type !== '-' || (!WAL_FILE_PATTERN.test(name) && !HISTORY_FILE_PATTERN.test(name)) || !expected.has(name) || observed.has(name)) throw new PostgresqlPitrRestoreError('POSTGRESQL_PITR_WAL_ARCHIVE_INVALID', 'A PostgreSQL WAL archive contains an unexpected or duplicate member.', { category: 'integrity' });
      observed.add(name);
    }
  }
  if (kind === 'wal' && (observed.size !== expected.size || [...expected].some((name) => !observed.has(name)))) throw new PostgresqlPitrRestoreError('POSTGRESQL_PITR_WAL_ARCHIVE_INCOMPLETE', 'A PostgreSQL WAL archive is missing an authenticated member.', { category: 'integrity' });
  return true;
}

class PostgresqlPitrRestoreService {
  constructor({ controlDatabase, secretStore, deviceId, adapter, openRepository, sessionFactory = openSshExecutionSession, clock = () => new Date().toISOString(), delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)) } = {}) {
    if (!controlDatabase || !secretStore || !adapter || typeof openRepository !== 'function') throw new TypeError('PostgreSQL PITR dependencies are required.');
    this.controlDatabase = controlDatabase; this.secretStore = secretStore; this.deviceId = requiredText(deviceId, 'Device ID', 200);
    this.adapter = adapter; this.openRepository = openRepository; this.sessionFactory = sessionFactory; this.clock = clock; this.delay = delay; this.active = new Map();
  }

  async start(workspaceId, actorId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200); const actor = requiredText(actorId, 'Actor ID', 200); const request = normalizeRequest(input);
    const point = await this.controlDatabase.repository('recoveryPoint').get(tenant, request.recoveryPointId);
    if (!point) throw new PostgresqlPitrRestoreError('POSTGRESQL_PITR_POINT_NOT_FOUND', 'The PostgreSQL RecoveryPoint was not found.', { category: 'not-found' });
    const protectedSource = assertPhysicalSource(await this.controlDatabase.repository('source').get(tenant, point.sourceId));
    const targetSource = request.mode === 'original' ? protectedSource : assertPhysicalSource(await this.controlDatabase.repository('source').get(tenant, request.targetSourceId));
    if (request.mode === 'alternate' && targetSource.id === protectedSource.id) throw new PostgresqlPitrRestoreError('POSTGRESQL_PITR_ALTERNATE_IS_ORIGINAL', 'Choose a different PostgreSQL physical Source for alternate recovery.', { category: 'conflict' });
    await this.#targetConnections(tenant, targetSource);
    const now = this.clock();
    const record = await this.controlDatabase.repository('restoreRun').create({
      workspaceId: tenant, actorId: actor, recoveryPointIds: [point.id], targetConnectionId: targetSource.connectionId,
      target: { operation: 'postgresql-pitr', engine: 'postgresql', mode: request.mode, sourceId: targetSource.id, postgresqlConnectionId: targetSource.connectionId, sshConnectionId: targetSource.physicalExecution.sshConnectionId, datadir: targetSource.physicalExecution.dataDirectory, serviceName: targetSource.physicalExecution.serviceName, recoveryTarget: request.recoveryTarget },
      mode: request.mode, conflictPolicy: 'fail', workerId: `device:${this.deviceId}`, state: 'queued',
      progress: { phase: 'queued', itemsTotal: 0, itemsCompleted: 0, bytesTotal: 0, bytesWritten: 0, throughputBytesPerSecond: 0, startedAt: null, updatedAt: now, warnings: [] }, validation: null, result: null
    });
    const controller = new AbortController();
    const operation = this.#execute(tenant, actor, record.id, request, controller.signal).catch(() => this.controlDatabase.repository('restoreRun').get(tenant, record.id));
    this.active.set(record.id, { operation, controller }); operation.finally(() => this.active.delete(record.id)); return record;
  }

  async wait(workspaceId, restoreRunId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200); const id = requiredText(restoreRunId, 'RestoreRun ID', 200);
    if (this.active.has(id)) await this.active.get(id).operation;
    const record = await this.controlDatabase.repository('restoreRun').get(tenant, id);
    if (!record || record.target?.operation !== 'postgresql-pitr') throw new PostgresqlPitrRestoreError('POSTGRESQL_PITR_RUN_NOT_FOUND', 'The PostgreSQL PITR RestoreRun was not found.', { category: 'not-found' });
    return record;
  }

  async cancel(workspaceId, actorId, restoreRunId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200); requiredText(actorId, 'Actor ID', 200); const id = requiredText(restoreRunId, 'RestoreRun ID', 200);
    const record = await this.controlDatabase.repository('restoreRun').get(tenant, id);
    if (!record || record.target?.operation !== 'postgresql-pitr') throw new PostgresqlPitrRestoreError('POSTGRESQL_PITR_RUN_NOT_FOUND', 'The PostgreSQL PITR RestoreRun was not found.', { category: 'not-found' });
    if (TERMINAL_STATES.has(record.state)) return record;
    const active = this.active.get(id);
    if (!active) throw new PostgresqlPitrRestoreError('POSTGRESQL_PITR_NOT_ACTIVE', 'The PostgreSQL PITR restore is not active in this DeployerX process.', { category: 'conflict' });
    active.controller.abort(); await active.operation; return this.controlDatabase.repository('restoreRun').get(tenant, id);
  }

  async list(workspaceId, options = {}) {
    return (await this.controlDatabase.repository('restoreRun').list(requiredText(workspaceId, 'Workspace ID', 200), { limit: Math.min(200, Math.max(1, Number(options.limit) || 50)) })).filter((record) => record.target?.operation === 'postgresql-pitr');
  }

  async reconcile(workspaceId, actorId = 'system') {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200); const recovered = [];
    for (const record of (await this.list(tenant, { limit: 200 })).filter((item) => !TERMINAL_STATES.has(item.state) && !this.active.has(item.id))) recovered.push(await this.#project(tenant, record.id, { state: 'failed', progress: { ...(record.progress || {}), phase: 'failed', updatedAt: this.clock() }, result: { error: { code: 'POSTGRESQL_PITR_INTERRUPTED', category: 'physical-restore', retryable: false, safeMessage: 'The DeployerX process stopped during PostgreSQL recovery. Inspect the target datadir before retrying.' }, completedAt: this.clock() } }, actorId));
    return recovered;
  }

  async #project(workspaceId, id, changes, actorId) { return this.controlDatabase.transaction((transaction) => { const current = transaction.get('restoreRun', workspaceId, id); return transaction.projectExecution('restoreRun', workspaceId, id, changes, { expectedRevision: current.revision, actorId }); }); }

  async #targetConnections(workspaceId, source) {
    const [postgresqlConnection, sshConnection] = await Promise.all([this.controlDatabase.repository('connection').get(workspaceId, source.connectionId), this.controlDatabase.repository('connection').get(workspaceId, source.physicalExecution.sshConnectionId)]);
    if (!postgresqlConnection || postgresqlConnection.adapterId !== ADAPTER_ID || postgresqlConnection.lastTest?.status !== 'success' || !postgresqlConnection.lastTest?.endpointIdentity?.systemIdentifier) throw new PostgresqlPitrRestoreError('POSTGRESQL_PITR_TARGET_DATABASE_UNHEALTHY', 'Retest the target PostgreSQL connection before recovery.', { category: 'connectivity' });
    if (!sshConnection || sshConnection.adapterId !== 'deployerx.connection.ssh' || sshConnection.lastTest?.status !== 'success') throw new PostgresqlPitrRestoreError('POSTGRESQL_PITR_TARGET_SSH_UNHEALTHY', 'Retest the target SSH execution connection before recovery.', { category: 'connectivity' });
    if (![postgresqlConnection, sshConnection].every((connection) => (connection.workerAffinity || []).includes(`device:${this.deviceId}`))) throw new PostgresqlPitrRestoreError('POSTGRESQL_PITR_OTHER_DEVICE', 'The PostgreSQL recovery target belongs to another device.', { category: 'authorization' });
    return { postgresqlConnection, sshConnection };
  }

  async #loadChain(workspaceId, selectedPointId) {
    const [points, artifacts] = await Promise.all([this.controlDatabase.repository('recoveryPoint').list(workspaceId, { limit: 1000 }), this.controlDatabase.repository('artifact').list(workspaceId, { limit: 5000 })]);
    const relevant = artifacts.filter((artifact) => ['physical-backup', 'transaction-log'].includes(artifact.kind) && ['postgresql-basebackup', 'postgresql-wal'].includes(artifact.metadata?.kind));
    return { ...validateChain(points, new Map(relevant.map((artifact) => [artifact.recoveryPointId, artifact.metadata])), selectedPointId), artifacts: relevant };
  }

  async #repositoryFile(workspaceId, point, artifacts) {
    for (const copy of (point.repositoryCopies || []).filter((item) => item.state === 'available')) {
      const artifact = artifacts.find((item) => item.recoveryPointId === point.id && item.repositoryId === copy.repositoryId); if (!artifact) continue;
      const opened = await this.openRepository(workspaceId, copy.repositoryId);
      const snapshot = await opened.engine.openSnapshot({}, { repositoryId: copy.repositoryId, snapshotId: copy.engineSnapshotId, masterKey: opened.masterKey });
      const file = snapshot.manifest.files.find((item) => item.type === 'file' && item.path === artifact.metadata?.artifact?.path && item.metadata?.artifactKind === artifact.kind);
      if (!file || file.sizeBytes !== artifact.sizeBytes || file.contentDigest?.digest !== artifact.checksum?.digest || file.metadata?.database?.kind !== artifact.metadata?.kind) throw new PostgresqlPitrRestoreError('POSTGRESQL_PITR_ARTIFACT_INVALID', 'A PostgreSQL recovery Artifact does not match its authenticated repository manifest.', { category: 'integrity' });
      return { copy, artifact, opened, snapshot, file };
    }
    throw new PostgresqlPitrRestoreError('POSTGRESQL_PITR_ARTIFACT_UNAVAILABLE', 'No available repository copy contains a required PostgreSQL recovery Artifact.', { category: 'not-found' });
  }

  async #execute(workspaceId, actorId, restoreRunId, request, signal) {
    let session = null; let remoteWorkspace = null;
    let progress = { phase: 'preparing', itemsTotal: 0, itemsCompleted: 0, bytesTotal: 0, bytesWritten: 0, throughputBytesPerSecond: 0, startedAt: this.clock(), updatedAt: this.clock(), warnings: [] };
    const startedMs = Date.now();
    try {
      await this.#project(workspaceId, restoreRunId, { state: 'preparing', progress }, actorId);
      const selectedPoint = await this.controlDatabase.repository('recoveryPoint').get(workspaceId, request.recoveryPointId);
      const protectedSource = assertPhysicalSource(await this.controlDatabase.repository('source').get(workspaceId, selectedPoint?.sourceId));
      const targetSource = request.mode === 'original' ? protectedSource : assertPhysicalSource(await this.controlDatabase.repository('source').get(workspaceId, request.targetSourceId));
      const { postgresqlConnection, sshConnection } = await this.#targetConnections(workspaceId, targetSource);
      const chain = await this.#loadChain(workspaceId, request.recoveryPointId);
      const files = []; for (const point of chain.chain) files.push(await this.#repositoryFile(workspaceId, point, chain.artifacts));
      progress.itemsTotal = files.length; progress.bytesTotal = files.reduce((total, item) => total + Number(item.file.sizeBytes || 0), 0);
      const execution = targetSource.physicalExecution;
      session = await this.sessionFactory({ connectionConfig: connectionConfigFromRecord(sshConnection), resolveSecret: (secretRefId) => this.secretStore.resolve({ workspaceId, id: secretRefId }), signal });
      const versions = await Promise.all([execution.pgVerifybackupExecutable, execution.pgWaldumpExecutable, execution.psqlExecutable].map((executable) => session.run(commandFromArgs(executable, ['--version'], { privilegeMode: execution.privilegeMode }), { stdoutLimitBytes: 8192 })));
      const parsedTools = versions.map((result, index) => parsePostgresqlToolVersion(`${result.stdout}\n${result.stderr}`, ['pg_verifybackup', 'pg_waldump', 'psql'][index]));
      if (parsedTools.some((tool) => tool.major !== chain.major)) throw new PostgresqlPitrRestoreError('POSTGRESQL_PITR_TOOL_MAJOR_MISMATCH', 'PostgreSQL recovery tools must match the backup major version.', { category: 'compatibility' });
      const root = path.posix.normalize(execution.remoteTemporaryDirectory).replace(/\/$/, '');
      const allocated = await session.run(commandFromArgs('mktemp', ['-d', '-p', root, `deployerx-postgresql-restore-${String(restoreRunId).slice(0, 20)}.XXXXXX`]), { stdoutLimitBytes: 8192 });
      remoteWorkspace = path.posix.normalize(allocated.stdout.trim()).replace(/\/$/, '');
      if (path.posix.dirname(remoteWorkspace) !== root || !path.posix.basename(remoteWorkspace).startsWith('deployerx-postgresql-restore-')) throw new PostgresqlPitrRestoreError('POSTGRESQL_PITR_WORKSPACE_INVALID', 'The PostgreSQL restore workspace is outside the approved temporary root.', { category: 'integrity' });
      const baseDirectory = path.posix.join(remoteWorkspace, 'base'); const walDirectory = path.posix.join(remoteWorkspace, 'wal');
      await session.run(commandFromArgs('mkdir', ['-m', '0700', '--', baseDirectory, walDirectory]), { stdoutLimitBytes: 1024 });
      for (let index = 0; index < files.length; index += 1) {
        const item = files[index]; const archivePath = path.posix.join(remoteWorkspace, index === 0 ? 'base.tar' : `wal-${index}.tar`);
        const content = (async function* tracked() { const stream = item.opened.engine.streamFile({}, { repositoryId: item.copy.repositoryId, manifest: item.snapshot.manifest, masterKey: item.opened.masterKey, path: item.file.path }); for await (const chunk of stream) { progress.bytesWritten += Buffer.byteLength(chunk); progress.throughputBytesPerSecond = Math.round(progress.bytesWritten / Math.max(1, (Date.now() - startedMs) / 1000)); yield chunk; } })();
        await session.consume(commandFromArgs('sh', ['-c', `umask 077; cat > ${shellQuote(archivePath)}`]), content, { stderrLimitBytes: 4 * 1024 * 1024 });
        const listing = await session.run(commandFromArgs(execution.tarExecutable, ['--list', '--verbose', `--file=${archivePath}`], { privilegeMode: execution.privilegeMode }), { stdoutLimitBytes: 16 * 1024 * 1024 });
        const metadata = item.artifact.metadata;
        validateTarListing(listing.stdout, index === 0 ? 'base' : 'wal', index === 0 ? [] : metadata.wal.files.map((file) => file.name));
        await session.run(commandFromArgs(execution.tarExecutable, ['--extract', `--file=${archivePath}`, `--directory=${index === 0 ? baseDirectory : walDirectory}`, '--no-same-owner', '--no-same-permissions', ...(index ? ['--keep-old-files'] : [])], { privilegeMode: execution.privilegeMode }), { stdoutLimitBytes: 1024 * 1024, stderrLimitBytes: 4 * 1024 * 1024 });
        progress.itemsCompleted += 1; progress.updatedAt = this.clock(); await this.#project(workspaceId, restoreRunId, { state: 'running', progress: { ...progress, phase: 'materializing' } }, actorId);
      }
      await session.run(commandFromArgs(execution.pgVerifybackupExecutable, [baseDirectory], { privilegeMode: execution.privilegeMode }), { stdoutLimitBytes: 4 * 1024 * 1024, stderrLimitBytes: 4 * 1024 * 1024 });
      const walSegments = chain.chain.slice(1).flatMap((point) => chain.artifacts.find((artifact) => artifact.recoveryPointId === point.id)?.metadata?.wal?.files || []).filter((file) => file.kind === 'segment');
      if (walSegments.length) await session.run(commandFromArgs(execution.pgWaldumpExecutable, ['--quiet', `--path=${walDirectory}`, walSegments[0].name, walSegments.at(-1).name], { privilegeMode: execution.privilegeMode }), { stdoutLimitBytes: 1024 * 1024, stderrLimitBytes: 4 * 1024 * 1024 });
      progress.phase = 'copying-back'; progress.updatedAt = this.clock(); await this.#project(workspaceId, restoreRunId, { state: 'running', progress }, actorId);
      await session.run(commandFromArgs('systemctl', ['stop', execution.serviceName], { privilegeMode: execution.privilegeMode }), { stdoutLimitBytes: 8192 });
      const stopped = await session.run(commandFromArgs('systemctl', ['show', '--property=ActiveState', '--value', execution.serviceName], { privilegeMode: execution.privilegeMode }), { stdoutLimitBytes: 8192 });
      if (stopped.stdout.trim() !== 'inactive') throw new PostgresqlPitrRestoreError('POSTGRESQL_PITR_SERVICE_STILL_ACTIVE', 'The PostgreSQL service did not reach the inactive state.', { category: 'conflict' });
      await session.run(commandFromArgs('install', ['-d', '-m', '0700', '-o', execution.postgresOwner, '-g', execution.postgresGroup, execution.dataDirectory], { privilegeMode: execution.privilegeMode }), { stdoutLimitBytes: 8192 });
      await session.run(commandFromArgs('sh', ['-c', `test -z "$(find ${shellQuote(execution.dataDirectory)} -mindepth 1 -maxdepth 1 -print -quit)"`], { privilegeMode: execution.privilegeMode }), { stdoutLimitBytes: 8192 }).catch(() => { throw new PostgresqlPitrRestoreError('POSTGRESQL_PITR_DATADIR_NOT_EMPTY', 'The target PostgreSQL data directory is not empty. DeployerX will not remove or overwrite it.', { category: 'conflict' }); });
      await session.run(commandFromArgs('cp', ['-a', '--', path.posix.join(baseDirectory, '.'), execution.dataDirectory], { privilegeMode: execution.privilegeMode }), { stdoutLimitBytes: 8192 });
      const configFile = path.posix.join(remoteWorkspace, 'recovery-settings.conf');
      await session.writeFile(configFile, recoveryConfiguration(request.recoveryTarget, walDirectory, chain.major, request.mode === 'alternate'), { mode: 0o600 });
      await session.run(commandFromArgs('sh', ['-c', `cat ${shellQuote(configFile)} >> ${shellQuote(path.posix.join(execution.dataDirectory, 'postgresql.auto.conf'))}`], { privilegeMode: execution.privilegeMode }), { stdoutLimitBytes: 8192 });
      await session.run(commandFromArgs('touch', [path.posix.join(execution.dataDirectory, 'recovery.signal')], { privilegeMode: execution.privilegeMode }), { stdoutLimitBytes: 1024 });
      await session.run(commandFromArgs('chown', ['-hR', `${execution.postgresOwner}:${execution.postgresGroup}`, execution.dataDirectory], { privilegeMode: execution.privilegeMode }), { stdoutLimitBytes: 8192 });
      await session.run(commandFromArgs('systemctl', ['start', execution.serviceName], { privilegeMode: execution.privilegeMode }), { stdoutLimitBytes: 8192 });
      progress.phase = 'recovering'; progress.updatedAt = this.clock(); await this.#project(workspaceId, restoreRunId, { state: 'validating', progress }, actorId);
      const [passwordSecretRefId] = postgresqlConnection.secretRefIds || []; const password = await this.secretStore.resolve({ workspaceId, id: passwordSecretRefId });
      const connectionConfig = this.adapter.normalizeConfig({ ...postgresqlConnection.endpoint, passwordSecretRefId }); const passfile = path.posix.join(remoteWorkspace, 'target.pgpass');
      await session.writeFile(passfile, pgpassContents(connectionConfig, password), { mode: 0o600 });
      const queryCommand = commandFromArgs('env', [`PGPASSFILE=${passfile}`, `PGSSLMODE=${sslMode(connectionConfig.tlsMode)}`, execution.psqlExecutable, `--host=${connectionConfig.host}`, `--port=${connectionConfig.port}`, `--username=${connectionConfig.username}`, `--dbname=${connectionConfig.maintenanceDatabase}`, '--no-password', '--no-psqlrc', '--tuples-only', '--no-align', '--field-separator=\t', '--set=ON_ERROR_STOP=1', "--command=SELECT pg_is_in_recovery(), COALESCE(pg_last_wal_replay_lsn()::text, pg_current_wal_lsn()::text), (pg_control_checkpoint()).timeline_id, (pg_control_system()).system_identifier::text;"], { privilegeMode: execution.privilegeMode });
      let recoveryEvidence = null;
      for (let attempt = 0; attempt < 120; attempt += 1) {
        try { const result = await session.run(queryCommand, { stdoutLimitBytes: 8192 }); const [inRecovery, finalLsn, timeline, restoredIdentifier] = result.stdout.trim().split('\t'); if (inRecovery === 'f') { recoveryEvidence = { finalLsn, timeline: Number(timeline), systemIdentifier: restoredIdentifier }; break; } } catch (error) { if (signal.aborted) throw error; }
        await this.delay(5000);
      }
      if (!recoveryEvidence) throw new PostgresqlPitrRestoreError('POSTGRESQL_PITR_RECOVERY_TIMEOUT', 'PostgreSQL did not complete recovery before the validation timeout.', { category: 'timeout', retryable: true });
      if (recoveryEvidence.systemIdentifier !== chain.systemIdentifier || !Number.isInteger(recoveryEvidence.timeline) || recoveryEvidence.timeline < 1) throw new PostgresqlPitrRestoreError('POSTGRESQL_PITR_IDENTITY_MISMATCH', 'The recovered PostgreSQL cluster identity or timeline is invalid.', { category: 'integrity' });
      const active = await session.run(commandFromArgs('systemctl', ['show', '--property=ActiveState', '--value', execution.serviceName], { privilegeMode: execution.privilegeMode }), { stdoutLimitBytes: 8192 });
      if (active.stdout.trim() !== 'active') throw new PostgresqlPitrRestoreError('POSTGRESQL_PITR_SERVICE_START_FAILED', 'The PostgreSQL service is not active after recovery.', { category: 'connectivity', retryable: true });
      const validation = { state: 'succeeded', nativeIntegrityValidation: true, checkedAt: this.clock(), checks: [{ id: 'base-manifest', status: 'pass' }, { id: 'wal-parse', status: 'pass' }, { id: 'service', status: 'pass' }, { id: 'promotion', status: 'pass' }, { id: 'system-identity', status: 'pass' }], ...recoveryEvidence };
      progress.phase = 'complete'; progress.updatedAt = this.clock();
      return this.#project(workspaceId, restoreRunId, { state: 'succeeded', progress, validation, result: { restoredRecoveryPointIds: chain.chain.map((point) => point.id), chainRootRecoveryPointId: chain.rootId, recoveryTarget: request.recoveryTarget, finalLsn: recoveryEvidence.finalLsn, timeline: recoveryEvidence.timeline, systemIdentifier: recoveryEvidence.systemIdentifier, bytesRestored: progress.bytesWritten, completedAt: this.clock() } }, actorId);
    } catch (error) {
      const current = await this.controlDatabase.repository('restoreRun').get(workspaceId, restoreRunId);
      if (current && !TERMINAL_STATES.has(current.state)) { const canceled = signal?.aborted || error?.code === 'SSH_EXECUTION_CANCELED'; const failure = canceled ? { code: 'POSTGRESQL_PITR_CANCELED', category: 'canceled', retryable: false, safeMessage: 'The PostgreSQL physical restore was canceled.' } : safeError(error); return this.#project(workspaceId, restoreRunId, { state: canceled ? 'canceled' : 'failed', progress: { ...progress, phase: canceled ? 'canceled' : 'failed', updatedAt: this.clock() }, result: { error: failure, completedAt: this.clock() } }, actorId); }
      throw error;
    } finally {
      if (session && remoteWorkspace && path.posix.basename(remoteWorkspace).startsWith('deployerx-postgresql-restore-')) await session.run(commandFromArgs('rm', ['-rf', '--', remoteWorkspace]), { stdoutLimitBytes: 1024, ignoreAbort: true }).catch(() => {});
      session?.close();
    }
  }
}

module.exports = { PostgresqlPitrRestoreError, PostgresqlPitrRestoreService, RESTORE_CONFIRMATIONS, normalizeRecoveryTarget, normalizeRequest, recoveryConfiguration, validateChain, validateTarListing };
