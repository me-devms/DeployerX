const path = require('path');
const { pgpassContents, sslMode } = require('./postgresql-logical');
const { commandFromArgs, connectionConfigFromRecord, openSshExecutionSession } = require('./ssh-execution');

const PHYSICAL_FORMAT_VERSION = 1;
const MAX_PHYSICAL_BACKUP_BYTES = 128 * 1024 * 1024 * 1024 * 1024;
const MAX_WAL_SEGMENTS_PER_POINT = 4096;
const WAL_FILE_PATTERN = /^[0-9A-F]{24}$/;
const TIMELINE_HISTORY_PATTERN = /^[0-9A-F]{8}[.]history$/i;

class PostgresqlPhysicalError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'PostgresqlPhysicalError';
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
  if (!normalized.startsWith('/') || normalized === '/' || normalized.split('/').includes('..')) throw new PostgresqlPhysicalError('POSTGRESQL_PHYSICAL_REMOTE_PATH_INVALID', `${label} is unsafe.`, { category: 'validation' });
  return normalized;
}

function parsePostgresqlToolVersion(value, tool) {
  const text = requiredText(value, `${tool} version output`, 4096);
  const match = /PostgreSQL\)?\s+(\d+)(?:[.](\d+))?(?:[.](\d+))?/i.exec(text) || /\b(\d+)(?:[.](\d+))?(?:[.](\d+))?\b/.exec(text);
  const major = Number(match?.[1]);
  if (!match || major < 14 || major > 18) throw new PostgresqlPhysicalError('POSTGRESQL_PHYSICAL_TOOL_UNSUPPORTED', `${tool} from PostgreSQL 14 through 18 is required.`, { category: 'compatibility' });
  return { name: tool, version: [major, Number(match[2] || 0), Number(match[3] || 0)].join('.'), major, text: text.slice(0, 300) };
}

function parseServerVersion(value) {
  const text = requiredText(value, 'PostgreSQL server version', 100);
  const match = /^(\d+)(?:[.](\d+))?/.exec(text);
  const major = Number(match?.[1]);
  if (!match || major < 14 || major > 18) throw new PostgresqlPhysicalError('POSTGRESQL_PHYSICAL_SERVER_UNSUPPORTED', 'PostgreSQL physical backup requires PostgreSQL 14 through 18.', { category: 'compatibility' });
  return { text, major };
}

function parseWalSegmentSize(value) {
  const match = /^\s*(\d+)\s*(B|kB|MB|GB)\s*$/i.exec(String(value || ''));
  if (!match) throw new PostgresqlPhysicalError('POSTGRESQL_WAL_SEGMENT_SIZE_INVALID', 'The PostgreSQL WAL segment size is invalid.', { category: 'integrity' });
  const factors = { b: 1, kb: 1024, mb: 1024 * 1024, gb: 1024 * 1024 * 1024 };
  const bytes = Number(match[1]) * factors[match[2].toLowerCase()];
  if (!Number.isSafeInteger(bytes) || bytes < 1024 * 1024 || bytes > 1024 * 1024 * 1024 || (0x100000000 % bytes) !== 0) throw new PostgresqlPhysicalError('POSTGRESQL_WAL_SEGMENT_SIZE_INVALID', 'The PostgreSQL WAL segment size is unsupported.', { category: 'compatibility' });
  return bytes;
}

function parseLsn(value, label = 'PostgreSQL LSN') {
  const text = requiredText(value, label, 40).toUpperCase();
  const match = /^([0-9A-F]{1,8})\/([0-9A-F]{1,8})$/.exec(text);
  if (!match) throw new PostgresqlPhysicalError('POSTGRESQL_LSN_INVALID', `${label} is invalid.`, { category: 'integrity' });
  return `${match[1]}/${match[2]}`;
}

function walSegmentForLsn(lsn, timeline, segmentSizeBytes) {
  const normalized = parseLsn(lsn);
  const [high, low] = normalized.split('/').map((part) => BigInt(`0x${part}`));
  const segmentSize = BigInt(segmentSizeBytes);
  const segmentsPerLog = 0x100000000n / segmentSize;
  const segmentNumber = ((high << 32n) + low) / segmentSize;
  const log = segmentNumber / segmentsPerLog;
  const segment = segmentNumber % segmentsPerLog;
  return `${Number(timeline).toString(16).toUpperCase().padStart(8, '0')}${log.toString(16).toUpperCase().padStart(8, '0')}${segment.toString(16).toUpperCase().padStart(8, '0')}`;
}

function nextWalSegment(value, segmentSizeBytes) {
  const name = requiredText(value, 'WAL segment name', 24).toUpperCase();
  if (!WAL_FILE_PATTERN.test(name)) throw new PostgresqlPhysicalError('POSTGRESQL_WAL_SEGMENT_INVALID', 'The WAL segment name is invalid.', { category: 'integrity' });
  const timeline = name.slice(0, 8);
  let log = BigInt(`0x${name.slice(8, 16)}`);
  let segment = BigInt(`0x${name.slice(16)}`) + 1n;
  const segmentsPerLog = 0x100000000n / BigInt(segmentSizeBytes);
  if (segment >= segmentsPerLog) { log += 1n; segment = 0n; }
  return `${timeline}${log.toString(16).toUpperCase().padStart(8, '0')}${segment.toString(16).toUpperCase().padStart(8, '0')}`;
}

function parseBackupManifest(value) {
  const source = requiredText(value, 'PostgreSQL backup manifest', 64 * 1024 * 1024);
  const rawSystemIdentifier = /"System-Identifier"\s*:\s*(?:"(\d{1,30})"|(\d{1,30}))/.exec(source);
  let manifest;
  try { manifest = JSON.parse(source); }
  catch { throw new PostgresqlPhysicalError('POSTGRESQL_BACKUP_MANIFEST_INVALID', 'The PostgreSQL backup manifest is invalid.', { category: 'integrity' }); }
  const systemIdentifier = rawSystemIdentifier?.[1] || rawSystemIdentifier?.[2] || String(manifest.systemIdentifier ?? '');
  const ranges = manifest['WAL-Ranges'] || manifest.walRanges;
  if (!/^\d{1,30}$/.test(systemIdentifier) || !Array.isArray(ranges) || !ranges.length) throw new PostgresqlPhysicalError('POSTGRESQL_BACKUP_MANIFEST_INVALID', 'The PostgreSQL backup manifest lacks required identity or WAL ranges.', { category: 'integrity' });
  const walRanges = ranges.map((range) => ({
    timeline: Number(range.Timeline ?? range.timeline),
    startLsn: parseLsn(range['Start-LSN'] ?? range.startLsn, 'Backup start LSN'),
    endLsn: parseLsn(range['End-LSN'] ?? range.endLsn, 'Backup end LSN')
  }));
  if (walRanges.some((range) => !Number.isInteger(range.timeline) || range.timeline < 1)) throw new PostgresqlPhysicalError('POSTGRESQL_BACKUP_MANIFEST_INVALID', 'The PostgreSQL backup timeline is invalid.', { category: 'integrity' });
  return { manifest, systemIdentifier, walRanges, startLsn: walRanges[0].startLsn, endLsn: walRanges.at(-1).endLsn, timeline: walRanges.at(-1).timeline };
}

function validatePhysicalSelection(selector) {
  const childRules = (selector?.databases?.include?.length || 0) + (selector?.databases?.exclude?.length || 0)
    + (selector?.schemas?.include?.length || 0) + (selector?.schemas?.exclude?.length || 0)
    + (selector?.tables?.include?.length || 0) + (selector?.tables?.exclude?.length || 0);
  if (selector?.kind !== 'database-objects' || selector.allDatabases !== true || childRules || selector.includeGlobalObjects) throw new PostgresqlPhysicalError('POSTGRESQL_PHYSICAL_SELECTION_UNSUPPORTED', 'PostgreSQL physical backup requires the whole cluster without object filters.', { category: 'compatibility' });
}

function parseArchiveInventory(value) {
  const files = [];
  const names = new Set();
  for (const line of String(value || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [rawName, rawSize, rawType = 'f'] = line.split('\t');
    const raw = String(rawName || '').trim();
    const name = WAL_FILE_PATTERN.test(raw.toUpperCase()) ? raw.toUpperCase() : TIMELINE_HISTORY_PATTERN.test(raw) ? `${raw.slice(0, 8).toUpperCase()}.history` : raw;
    const sizeBytes = Number(rawSize);
    if ((!WAL_FILE_PATTERN.test(name) && !TIMELINE_HISTORY_PATTERN.test(name)) || !Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || rawType !== 'f' || names.has(name)) continue;
    names.add(name);
    files.push({ name, sizeBytes, kind: WAL_FILE_PATTERN.test(name) ? 'segment' : 'history' });
  }
  return files.sort((left, right) => left.name.localeCompare(right.name));
}

function selectWalFiles(inventory, previousSegment, targetSegment, segmentSizeBytes, maximum = MAX_WAL_SEGMENTS_PER_POINT) {
  const start = requiredText(previousSegment, 'Previous WAL segment', 24).toUpperCase();
  const target = requiredText(targetSegment, 'Target WAL segment', 24).toUpperCase();
  if (!WAL_FILE_PATTERN.test(start) || !WAL_FILE_PATTERN.test(target) || start.slice(0, 8) !== target.slice(0, 8)) throw new PostgresqlPhysicalError('POSTGRESQL_WAL_TIMELINE_CHANGED', 'The PostgreSQL WAL timeline changed; create a new full base backup before continuing.', { category: 'consistency' });
  const byName = new Map(inventory.map((file) => [file.name, file]));
  const segments = [];
  let expected = nextWalSegment(start, segmentSizeBytes);
  while (expected <= target) {
    const file = byName.get(expected);
    if (!file || file.kind !== 'segment' || file.sizeBytes !== segmentSizeBytes) throw new PostgresqlPhysicalError('POSTGRESQL_WAL_ARCHIVE_GAP', 'The PostgreSQL WAL archive has a missing or invalid segment.', { category: 'integrity' });
    segments.push(file);
    if (segments.length > maximum) throw new PostgresqlPhysicalError('POSTGRESQL_WAL_CAPTURE_LIMIT_EXCEEDED', 'The PostgreSQL WAL capture exceeds the per-run segment limit.', { category: 'capacity' });
    if (expected === target) break;
    expected = nextWalSegment(expected, segmentSizeBytes);
  }
  return [...inventory.filter((file) => file.kind === 'history'), ...segments];
}

function remotePostgresCommand(execution, connectionConfig, passfile, executable, args) {
  return commandFromArgs('env', [
    `PGPASSFILE=${passfile}`,
    `PGSSLMODE=${sslMode(connectionConfig.tlsMode)}`,
    executable,
    `--host=${connectionConfig.host}`,
    `--port=${connectionConfig.port}`,
    `--username=${connectionConfig.username}`,
    '--no-password',
    ...args
  ], { privilegeMode: execution.privilegeMode });
}

function parsePreflight(value) {
  const fields = String(value || '').trim().split('\t');
  if (fields.length < 13) throw new PostgresqlPhysicalError('POSTGRESQL_PHYSICAL_PREFLIGHT_INVALID', 'PostgreSQL physical preflight returned incomplete evidence.', { category: 'integrity' });
  const [versionText, systemIdentifier, dataDirectory, inRecovery, walLevel, fullPageWrites, maxWalSenders, archiveMode, archiveCommand, archiveLibrary, walSegmentSize, userTablespaces, replicationAllowed] = fields;
  return {
    version: parseServerVersion(versionText), systemIdentifier, dataDirectory, inRecovery: inRecovery === 't', walLevel,
    fullPageWrites: fullPageWrites === 'on', maxWalSenders: Number(maxWalSenders), archiveMode,
    archiveCommand, archiveLibrary, walSegmentSizeBytes: parseWalSegmentSize(walSegmentSize), userTablespaces: Number(userTablespaces), replicationAllowed: replicationAllowed === 't'
  };
}

function validatePreflight(preflight, expected = {}) {
  if (!/^\d{1,30}$/.test(preflight.systemIdentifier) || preflight.systemIdentifier !== expected.systemIdentifier) throw new PostgresqlPhysicalError('POSTGRESQL_PHYSICAL_CLUSTER_PAIR_MISMATCH', 'The paired SSH host reaches a different PostgreSQL cluster identity.', { category: 'integrity' });
  if (normalizeRemotePath(preflight.dataDirectory, 'Reported PostgreSQL data directory') !== normalizeRemotePath(expected.dataDirectory, 'Configured PostgreSQL data directory')) throw new PostgresqlPhysicalError('POSTGRESQL_PHYSICAL_DATADIR_MISMATCH', 'The configured PostgreSQL data directory does not match the server-reported data directory.', { category: 'integrity' });
  if (preflight.inRecovery) throw new PostgresqlPhysicalError('POSTGRESQL_PHYSICAL_STANDBY_UNSUPPORTED', 'PostgreSQL standby base backups are not supported in this release.', { category: 'compatibility' });
  if (!['replica', 'logical'].includes(preflight.walLevel) || !preflight.fullPageWrites || !Number.isInteger(preflight.maxWalSenders) || preflight.maxWalSenders < 2) throw new PostgresqlPhysicalError('POSTGRESQL_PHYSICAL_WAL_SETTINGS_INVALID', 'PostgreSQL WAL and sender settings do not satisfy physical backup requirements.', { category: 'consistency' });
  if (preflight.archiveMode !== 'on' || (!String(preflight.archiveCommand).trim() && !String(preflight.archiveLibrary).trim())) throw new PostgresqlPhysicalError('POSTGRESQL_WAL_ARCHIVING_DISABLED', 'Enable PostgreSQL WAL archiving before physical protection.', { category: 'consistency' });
  if (!preflight.replicationAllowed) throw new PostgresqlPhysicalError('POSTGRESQL_REPLICATION_PRIVILEGE_MISSING', 'The PostgreSQL account requires REPLICATION or superuser capability.', { category: 'authorization' });
  if (preflight.userTablespaces !== 0) throw new PostgresqlPhysicalError('POSTGRESQL_PHYSICAL_TABLESPACES_UNSUPPORTED', 'PostgreSQL physical backup currently requires no user-defined tablespaces.', { category: 'compatibility' });
}

class PostgresqlPhysicalBackupService {
  constructor({ controlDatabase, secretStore, deviceId, sessionFactory = openSshExecutionSession, delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)) } = {}) {
    if (!controlDatabase || !secretStore) throw new TypeError('PostgreSQL physical backup dependencies are required.');
    this.controlDatabase = controlDatabase;
    this.secretStore = secretStore;
    this.deviceId = requiredText(deviceId, 'Device ID', 200);
    this.sessionFactory = sessionFactory;
    this.delay = delay;
  }

  async #previousMetadata(workspaceId, previousRecoveryPoint) {
    if (!previousRecoveryPoint) return null;
    const artifacts = await this.controlDatabase.repository('artifact').list(workspaceId, { limit: 5000 });
    return artifacts.find((artifact) => artifact.recoveryPointId === previousRecoveryPoint.id && ['physical-backup', 'transaction-log'].includes(artifact.kind) && ['postgresql-basebackup', 'postgresql-wal'].includes(artifact.metadata?.kind))?.metadata || null;
  }

  async prepare(workspaceId, executionId, plan, options = {}) {
    validatePhysicalSelection(plan.source.selector);
    const execution = plan.source.physicalExecution;
    if (!execution || execution.engine !== 'postgresql' || plan.source.consistency?.backupMethod !== 'physical') throw new PostgresqlPhysicalError('POSTGRESQL_PHYSICAL_SOURCE_INVALID', 'The PostgreSQL Source is not configured for physical backup.', { category: 'validation' });
    const sshConnection = await this.controlDatabase.repository('connection').get(workspaceId, execution.sshConnectionId);
    if (!sshConnection || sshConnection.adapterId !== 'deployerx.connection.ssh' || sshConnection.lastTest?.status !== 'success') throw new PostgresqlPhysicalError('POSTGRESQL_PHYSICAL_SSH_UNHEALTHY', 'Retest the paired SSH execution connection before backup.', { category: 'connectivity', retryable: true });
    if (!(sshConnection.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new PostgresqlPhysicalError('POSTGRESQL_PHYSICAL_OTHER_DEVICE', 'The paired SSH execution connection belongs to another device.', { category: 'authorization' });
    const systemIdentifier = requiredText(plan.connection.lastTest?.endpointIdentity?.systemIdentifier, 'Tested PostgreSQL system identifier', 100);
    const session = await this.sessionFactory({ connectionConfig: connectionConfigFromRecord(sshConnection), resolveSecret: (secretRefId) => this.secretStore.resolve({ workspaceId, id: secretRefId }), signal: options.signal });
    let remoteWorkspace = null;
    try {
      const root = normalizeRemotePath(execution.remoteTemporaryDirectory, 'Remote temporary directory');
      const created = await session.run(commandFromArgs('mktemp', ['-d', '-p', root, `deployerx-postgresql-${String(executionId).slice(0, 24)}.XXXXXX`]), { stdoutLimitBytes: 8192 });
      remoteWorkspace = normalizeRemotePath(created.stdout.trim(), 'Allocated PostgreSQL workspace');
      if (path.posix.dirname(remoteWorkspace) !== root || !path.posix.basename(remoteWorkspace).startsWith('deployerx-postgresql-')) throw new PostgresqlPhysicalError('POSTGRESQL_PHYSICAL_WORKSPACE_INVALID', 'The remote temporary workspace is outside the approved root.', { category: 'integrity' });
      const passfile = path.posix.join(remoteWorkspace, 'pgpass.conf');
      const [passwordSecretRefId] = plan.connection.secretRefIds || [];
      const password = await this.secretStore.resolve({ workspaceId, id: passwordSecretRefId });
      await session.writeFile(passfile, pgpassContents(plan.connectionConfig, password), { mode: 0o600 });
      const query = "SELECT current_setting('server_version'), c.system_identifier::text, current_setting('data_directory'), pg_is_in_recovery(), current_setting('wal_level'), current_setting('full_page_writes'), current_setting('max_wal_senders'), current_setting('archive_mode'), current_setting('archive_command', true), current_setting('archive_library', true), current_setting('wal_segment_size'), (SELECT count(*) FROM pg_tablespace WHERE spcname NOT IN ('pg_default','pg_global')), (SELECT rolreplication OR rolsuper FROM pg_roles WHERE rolname=current_user) FROM pg_control_system() c;";
      const toolCommands = [
        [execution.pgBasebackupExecutable, 'pg_basebackup'], [execution.pgVerifybackupExecutable, 'pg_verifybackup'],
        [execution.pgWaldumpExecutable, 'pg_waldump'], [execution.psqlExecutable, 'psql']
      ];
      const [preflightResult, ...toolResults] = await Promise.all([
        session.run(remotePostgresCommand(execution, plan.connectionConfig, passfile, execution.psqlExecutable, ['--dbname=' + plan.connectionConfig.maintenanceDatabase, '--no-psqlrc', '--tuples-only', '--no-align', '--field-separator=\t', '--set=ON_ERROR_STOP=1', `--command=${query}`]), { stdoutLimitBytes: 16384 }),
        ...toolCommands.map(([executable]) => session.run(commandFromArgs(executable, ['--version'], { privilegeMode: execution.privilegeMode }), { stdoutLimitBytes: 8192 }))
      ]);
      const preflight = parsePreflight(preflightResult.stdout);
      validatePreflight(preflight, { systemIdentifier, dataDirectory: execution.dataDirectory });
      const tools = Object.fromEntries(toolCommands.map(([, name], index) => [name, parsePostgresqlToolVersion(`${toolResults[index].stdout}\n${toolResults[index].stderr}`, name)]));
      if (Object.values(tools).some((tool) => tool.major !== preflight.version.major)) throw new PostgresqlPhysicalError('POSTGRESQL_PHYSICAL_TOOL_MAJOR_MISMATCH', 'PostgreSQL physical tools must match the server major version.', { category: 'compatibility' });
      await session.run(commandFromArgs('test', ['-r', execution.walArchiveDirectory], { privilegeMode: execution.privilegeMode }), { stdoutLimitBytes: 1024 });
      return options.backupMode === 'incremental'
        ? await this.#prepareWal(workspaceId, plan, options, { session, remoteWorkspace, passfile, execution, preflight, tools })
        : await this.#prepareBase(plan, options, { session, remoteWorkspace, passfile, execution, preflight, tools });
    } catch (error) {
      if (remoteWorkspace) await this.cleanup(session, remoteWorkspace).catch(() => {});
      session.close();
      if (error instanceof PostgresqlPhysicalError) throw error;
      throw new PostgresqlPhysicalError(error?.code || 'POSTGRESQL_PHYSICAL_BACKUP_FAILED', error?.message || 'PostgreSQL physical backup failed.', { category: error?.category, retryable: error?.retryable });
    }
  }

  async #prepareBase(plan, options, prepared) {
    const { session, remoteWorkspace, passfile, execution, preflight, tools } = prepared;
    const targetDirectory = path.posix.join(remoteWorkspace, 'base');
    await options.onProgress?.({ phase: 'scanning', path: execution.dataDirectory });
    await session.run(remotePostgresCommand(execution, plan.connectionConfig, passfile, execution.pgBasebackupExecutable, [
      `--pgdata=${targetDirectory}`, '--format=plain', '--wal-method=stream', '--checkpoint=spread', '--manifest-checksums=SHA256', '--progress'
    ]), { stdoutLimitBytes: 4 * 1024 * 1024, stderrLimitBytes: 4 * 1024 * 1024 });
    const manifestResult = await session.run(commandFromArgs('cat', [path.posix.join(targetDirectory, 'backup_manifest')], { privilegeMode: execution.privilegeMode }), { stdoutLimitBytes: 16 * 1024 * 1024 });
    const backup = parseBackupManifest(manifestResult.stdout);
    if (backup.systemIdentifier !== preflight.systemIdentifier) throw new PostgresqlPhysicalError('POSTGRESQL_BACKUP_MANIFEST_IDENTITY_MISMATCH', 'The PostgreSQL backup manifest belongs to a different cluster.', { category: 'integrity' });
    await session.run(commandFromArgs(execution.pgVerifybackupExecutable, [targetDirectory], { privilegeMode: execution.privilegeMode }), { stdoutLimitBytes: 4 * 1024 * 1024, stderrLimitBytes: 4 * 1024 * 1024 });
    const endSegment = walSegmentForLsn(backup.endLsn, backup.timeline, preflight.walSegmentSizeBytes);
    const artifactPath = `postgresql-physical/base-${backup.timeline}-${backup.endLsn.replace('/', '-')}.tar`;
    const databaseManifest = {
      version: PHYSICAL_FORMAT_VERSION, kind: 'postgresql-basebackup', adapterId: plan.source.adapterId, adapterVersion: plan.manifest.adapterVersion,
      engine: 'postgresql', backupMethod: 'physical', backupMode: 'full', selection: plan.source.selector, selectionDigest: plan.source.selector.digest,
      consistency: { requestedLevel: 'application', achievedLevel: 'application', backupMethod: 'physical', backupMode: 'full', method: 'pg-basebackup', proven: true },
      server: { systemIdentifier: preflight.systemIdentifier, serverIdentityFingerprint: plan.connection.trust.fingerprint, version: preflight.version.text, major: preflight.version.major, dataDirectory: execution.dataDirectory },
      source: { sourceId: plan.source.id, jobId: options.jobId, postgresqlConnectionId: plan.connection.id, postgresqlConnectionRevision: plan.connection.revision, sshConnectionId: plan.executionConnection?.id, sshConnectionRevision: plan.executionConnection?.revision },
      tools, wal: { timeline: backup.timeline, startLsn: backup.startLsn, endLsn: backup.endLsn, endSegment, lastSegment: endSegment, segmentSizeBytes: preflight.walSegmentSizeBytes, ranges: backup.walRanges },
      chain: { chainRootRecoveryPointId: null, parentRecoveryPointId: null },
      restore: { serviceName: execution.serviceName, postgresOwner: execution.postgresOwner, postgresGroup: execution.postgresGroup, privilegeMode: execution.privilegeMode },
      artifact: { kind: 'physical-backup', path: artifactPath, mediaType: 'application/x-tar', sizeBytes: null }
    };
    return { ...prepared, artifactPath, databaseManifest, content: () => this.#streamTar(session, execution, targetDirectory, null, artifactPath, options) };
  }

  async #prepareWal(workspaceId, plan, options, prepared) {
    const { session, remoteWorkspace, passfile, execution, preflight, tools } = prepared;
    const previous = await this.#previousMetadata(workspaceId, options.previousRecoveryPoint);
    if (!previous || !['postgresql-basebackup', 'postgresql-wal'].includes(previous.kind) || previous.server?.systemIdentifier !== preflight.systemIdentifier || previous.source?.sourceId !== plan.source.id || previous.source?.jobId !== options.jobId) throw new PostgresqlPhysicalError('POSTGRESQL_WAL_ANCHOR_REQUIRED', 'A matching PostgreSQL base backup or WAL point is required before WAL capture.', { category: 'consistency' });
    if (previous.server.major !== preflight.version.major || previous.wal?.segmentSizeBytes !== preflight.walSegmentSizeBytes) throw new PostgresqlPhysicalError('POSTGRESQL_WAL_CHAIN_MISMATCH', 'The PostgreSQL WAL chain version or segment size changed.', { category: 'integrity' });
    const switchQuery = "SELECT pg_walfile_name(pg_switch_wal());";
    const switched = await session.run(remotePostgresCommand(execution, plan.connectionConfig, passfile, execution.psqlExecutable, ['--dbname=' + plan.connectionConfig.maintenanceDatabase, '--no-psqlrc', '--tuples-only', '--no-align', '--set=ON_ERROR_STOP=1', `--command=${switchQuery}`]), { stdoutLimitBytes: 8192 });
    const targetSegment = requiredText(switched.stdout, 'Archived WAL target segment', 100).split(/\s+/)[0].toUpperCase();
    if (!WAL_FILE_PATTERN.test(targetSegment)) throw new PostgresqlPhysicalError('POSTGRESQL_WAL_SWITCH_INVALID', 'PostgreSQL returned an invalid switched WAL segment.', { category: 'integrity' });
    const inventoryCommand = commandFromArgs('find', [execution.walArchiveDirectory, '-maxdepth', '1', '-type', 'f', '-printf', '%f\t%s\tf\n'], { privilegeMode: execution.privilegeMode });
    let inventory = [];
    const attempts = Math.min(120, Math.max(1, Number(options.archiveWaitAttempts) || 12));
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      inventory = parseArchiveInventory((await session.run(inventoryCommand, { stdoutLimitBytes: 16 * 1024 * 1024 })).stdout);
      if (inventory.some((file) => file.name === targetSegment)) break;
      if (attempt + 1 < attempts) await this.delay(Math.min(5000, Math.max(1, Number(options.archiveWaitMilliseconds) || 5000)));
    }
    if (!inventory.some((file) => file.name === targetSegment)) throw new PostgresqlPhysicalError('POSTGRESQL_WAL_ARCHIVE_TIMEOUT', 'The switched PostgreSQL WAL segment was not archived before the capture timeout.', { category: 'timeout', retryable: true });
    const files = selectWalFiles(inventory, previous.wal.lastSegment, targetSegment, preflight.walSegmentSizeBytes);
    const segments = files.filter((file) => file.kind === 'segment');
    if (!segments.length) throw new PostgresqlPhysicalError('POSTGRESQL_WAL_NO_CHANGE', 'No new completed PostgreSQL WAL segment is available.', { category: 'consistency' });
    const listFile = path.posix.join(remoteWorkspace, 'wal-files.txt');
    await session.writeFile(listFile, `${files.map((file) => file.name).join('\n')}\n`, { mode: 0o600 });
    await session.run(commandFromArgs(execution.pgWaldumpExecutable, ['--quiet', `--path=${execution.walArchiveDirectory}`, segments[0].name, segments.at(-1).name], { privilegeMode: execution.privilegeMode }), { stdoutLimitBytes: 1024 * 1024, stderrLimitBytes: 4 * 1024 * 1024 });
    const artifactPath = `postgresql-wal/${segments[0].name}-${segments.at(-1).name}.tar`;
    const chainRootRecoveryPointId = previous.chain?.chainRootRecoveryPointId || options.previousRecoveryPoint?.chainRootId || options.previousRecoveryPoint?.id;
    const databaseManifest = {
      version: PHYSICAL_FORMAT_VERSION, kind: 'postgresql-wal', adapterId: plan.source.adapterId, adapterVersion: plan.manifest.adapterVersion,
      engine: 'postgresql', backupMethod: 'physical', backupMode: 'incremental', selection: plan.source.selector, selectionDigest: plan.source.selector.digest,
      consistency: { requestedLevel: 'application', achievedLevel: 'application', backupMethod: 'physical', backupMode: 'incremental', method: 'archived-wal', proven: true },
      server: { systemIdentifier: preflight.systemIdentifier, serverIdentityFingerprint: plan.connection.trust.fingerprint, version: preflight.version.text, major: preflight.version.major, dataDirectory: execution.dataDirectory },
      source: { sourceId: plan.source.id, jobId: options.jobId, postgresqlConnectionId: plan.connection.id, postgresqlConnectionRevision: plan.connection.revision, sshConnectionId: plan.executionConnection?.id, sshConnectionRevision: plan.executionConnection?.revision },
      tools, wal: { timeline: Number.parseInt(targetSegment.slice(0, 8), 16), firstSegment: segments[0].name, lastSegment: segments.at(-1).name, segmentSizeBytes: preflight.walSegmentSizeBytes, files },
      chain: { chainRootRecoveryPointId, parentRecoveryPointId: options.previousRecoveryPoint.id },
      restore: { serviceName: execution.serviceName, postgresOwner: execution.postgresOwner, postgresGroup: execution.postgresGroup, privilegeMode: execution.privilegeMode },
      artifact: { kind: 'transaction-log', path: artifactPath, mediaType: 'application/x-tar', sizeBytes: null }
    };
    return { ...prepared, artifactPath, databaseManifest, content: () => this.#streamTar(session, execution, execution.walArchiveDirectory, listFile, artifactPath, options) };
  }

  async *#streamTar(session, execution, directory, listFile, artifactPath, options) {
    const args = ['--create', '--file=-', `--directory=${directory}`];
    if (listFile) args.push('--verbatim-files-from', `--files-from=${listFile}`);
    else args.push('.');
    const opened = await session.stream(commandFromArgs(execution.tarExecutable, args, { privilegeMode: execution.privilegeMode }), { stderrLimitBytes: 4 * 1024 * 1024 });
    let sizeBytes = 0;
    try {
      for await (const rawChunk of opened.stdout) {
        const chunk = Buffer.from(rawChunk);
        sizeBytes += chunk.length;
        if (sizeBytes > MAX_PHYSICAL_BACKUP_BYTES) throw new PostgresqlPhysicalError('POSTGRESQL_PHYSICAL_BACKUP_LIMIT_EXCEEDED', 'The PostgreSQL physical artifact exceeds the supported limit.', { category: 'capacity' });
        const paced = options.bandwidthLimiter ? await options.bandwidthLimiter.consume(chunk.length) : { limitBytesPerSecond: null, waitedMilliseconds: 0 };
        await options.onProgress?.({ phase: 'transferring', path: artifactPath, bytesRead: chunk.length, bandwidthLimitBytesPerSecond: paced.limitBytesPerSecond, throttleWaitMilliseconds: paced.waitedMilliseconds });
        yield chunk;
      }
      await opened.completion;
      if (!sizeBytes) throw new PostgresqlPhysicalError('POSTGRESQL_PHYSICAL_BACKUP_EMPTY', 'The PostgreSQL physical artifact is empty.', { category: 'integrity' });
    } catch (error) { opened.close(); throw error; }
  }

  async cleanup(session, remoteWorkspace) {
    const target = normalizeRemotePath(remoteWorkspace, 'Allocated PostgreSQL workspace');
    if (!path.posix.basename(target).startsWith('deployerx-postgresql-')) throw new PostgresqlPhysicalError('POSTGRESQL_PHYSICAL_WORKSPACE_INVALID', 'Refusing to remove an unrecognized remote path.', { category: 'integrity' });
    await session.run(commandFromArgs('rm', ['-rf', '--', target]), { stdoutLimitBytes: 1024, ignoreAbort: true });
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
  MAX_WAL_SEGMENTS_PER_POINT,
  PHYSICAL_FORMAT_VERSION,
  PostgresqlPhysicalBackupService,
  PostgresqlPhysicalError,
  nextWalSegment,
  parseArchiveInventory,
  parseBackupManifest,
  parsePostgresqlToolVersion,
  parsePreflight,
  parseServerVersion,
  parseWalSegmentSize,
  selectWalFiles,
  validatePhysicalSelection,
  validatePreflight,
  walSegmentForLsn
};
