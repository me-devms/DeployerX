const path = require('path');
const { ADAPTER_ID } = require('./mysql-logical');
const { parseCheckpoints, parseXtrabackupVersion } = require('./mysql-physical');
const { commandFromArgs, connectionConfigFromRecord, openSshExecutionSession, shellQuote } = require('./ssh-execution');

const RESTORE_CONFIRMATIONS = Object.freeze({ original: 'RESTORE MYSQL PHYSICAL', alternate: 'RESTORE MYSQL PHYSICAL ALTERNATE' });
const TERMINAL_STATES = new Set(['succeeded', 'warning', 'failed', 'canceled']);

class MysqlPhysicalRestoreError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'MysqlPhysicalRestoreError';
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

function normalizeRequest(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('MySQL physical restore request must be an object.');
  const mode = String(input.mode || 'original');
  if (!RESTORE_CONFIRMATIONS[mode]) throw new MysqlPhysicalRestoreError('MYSQL_PHYSICAL_RESTORE_MODE_INVALID', 'Choose the original or an alternate physical MySQL target.', { category: 'validation' });
  if (input.confirmed !== true || String(input.confirmationText || '').trim() !== RESTORE_CONFIRMATIONS[mode]) throw new MysqlPhysicalRestoreError('MYSQL_PHYSICAL_RESTORE_CONFIRMATION_REQUIRED', 'Enter the exact destructive physical restore confirmation.', { category: 'conflict' });
  return {
    recoveryPointId: requiredText(input.recoveryPointId, 'RecoveryPoint ID', 200),
    mode,
    targetSourceId: mode === 'alternate' ? requiredText(input.targetSourceId, 'Alternate physical Source ID', 200) : null
  };
}

function safeError(error) {
  if (error instanceof MysqlPhysicalRestoreError || error?.code) return { code: String(error.code).slice(0, 100), category: String(error.category || 'physical-restore').slice(0, 80), retryable: Boolean(error.retryable), safeMessage: String(error.message || 'The MySQL physical restore failed.').slice(0, 500) };
  return { code: 'MYSQL_PHYSICAL_RESTORE_FAILED', category: 'physical-restore', retryable: false, safeMessage: 'DeployerX could not complete the MySQL physical restore.' };
}

function assertPhysicalSource(source) {
  if (!source || source.adapterId !== ADAPTER_ID || source.consistency?.backupMethod !== 'physical' || !source.physicalExecution) throw new MysqlPhysicalRestoreError('MYSQL_PHYSICAL_RESTORE_TARGET_INVALID', 'Choose a configured MySQL physical Source as the restore target.', { category: 'validation' });
  return source;
}

function validateChain(points, metadataByPoint, selectedPointId) {
  const byId = new Map(points.map((point) => [point.id, point]));
  const reversed = [];
  const visited = new Set();
  let current = byId.get(selectedPointId);
  while (current) {
    if (visited.has(current.id)) throw new MysqlPhysicalRestoreError('MYSQL_PHYSICAL_RESTORE_CHAIN_CYCLE', 'The physical recovery chain contains a cycle.', { category: 'integrity' });
    visited.add(current.id);
    reversed.push(current);
    if (!current.parentRecoveryPointId) break;
    current = byId.get(current.parentRecoveryPointId);
    if (!current) throw new MysqlPhysicalRestoreError('MYSQL_PHYSICAL_RESTORE_CHAIN_GAP', 'A required physical recovery point is missing.', { category: 'integrity' });
  }
  const chain = reversed.reverse();
  if (!chain.length || chain[0].type !== 'full') throw new MysqlPhysicalRestoreError('MYSQL_PHYSICAL_RESTORE_ANCHOR_MISSING', 'The physical recovery chain has no full anchor.', { category: 'integrity' });
  const rootId = chain[0].id;
  let previousLsn = '0';
  let serverUuid = null;
  let sourceId = null;
  let jobId = null;
  for (let index = 0; index < chain.length; index += 1) {
    const point = chain[index];
    const metadata = metadataByPoint.get(point.id);
    if (!metadata || metadata.kind !== 'mysql-xtrabackup') throw new MysqlPhysicalRestoreError('MYSQL_PHYSICAL_RESTORE_METADATA_INVALID', 'A physical recovery point has no authenticated XtraBackup metadata.', { category: 'integrity' });
    const checkpoints = parseCheckpoints(`backup_type = ${metadata.checkpoints?.backupType}\nfrom_lsn = ${metadata.checkpoints?.fromLsn}\nto_lsn = ${metadata.checkpoints?.toLsn}\nlast_lsn = ${metadata.checkpoints?.lastLsn}\n`);
    if (index === 0 && (checkpoints.backupType !== 'full-backuped' || checkpoints.fromLsn !== '0')) throw new MysqlPhysicalRestoreError('MYSQL_PHYSICAL_RESTORE_ANCHOR_INVALID', 'The physical full anchor checkpoint is invalid.', { category: 'integrity' });
    if (index > 0 && (point.type !== 'incremental' || checkpoints.backupType !== 'incremental' || checkpoints.fromLsn !== previousLsn || point.parentRecoveryPointId !== chain[index - 1].id || point.chainRootId !== rootId)) throw new MysqlPhysicalRestoreError('MYSQL_PHYSICAL_RESTORE_LSN_GAP', 'The physical recovery chain has an LSN or parent gap.', { category: 'integrity' });
    serverUuid ||= metadata.server?.serverUuid;
    sourceId ||= metadata.source?.sourceId;
    jobId ||= metadata.source?.jobId;
    if (!serverUuid || metadata.server?.serverUuid !== serverUuid || metadata.source?.sourceId !== sourceId || metadata.source?.jobId !== jobId || point.sourceId !== sourceId || point.jobId !== jobId) throw new MysqlPhysicalRestoreError('MYSQL_PHYSICAL_RESTORE_CHAIN_MISMATCH', 'The physical recovery chain mixes different servers, Sources, or jobs.', { category: 'integrity' });
    previousLsn = checkpoints.toLsn;
  }
  return { chain, rootId, serverUuid, sourceId, jobId, toLsn: previousLsn };
}

class MysqlPhysicalRestoreService {
  constructor({ controlDatabase, secretStore, deviceId, mysqlAdapter, openRepository, sessionFactory = openSshExecutionSession, clock = () => new Date().toISOString() } = {}) {
    if (!controlDatabase || !secretStore || !mysqlAdapter || typeof openRepository !== 'function') throw new TypeError('MySQL physical restore dependencies are required.');
    this.controlDatabase = controlDatabase;
    this.secretStore = secretStore;
    this.deviceId = requiredText(deviceId, 'Device ID', 200);
    this.mysqlAdapter = mysqlAdapter;
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
    if (!point) throw new MysqlPhysicalRestoreError('MYSQL_PHYSICAL_RECOVERY_POINT_NOT_FOUND', 'The physical RecoveryPoint was not found.', { category: 'not-found' });
    const protectedSource = assertPhysicalSource(await this.controlDatabase.repository('source').get(tenant, point.sourceId));
    const targetSource = request.mode === 'original' ? protectedSource : assertPhysicalSource(await this.controlDatabase.repository('source').get(tenant, request.targetSourceId));
    if (request.mode === 'alternate' && targetSource.id === protectedSource.id) throw new MysqlPhysicalRestoreError('MYSQL_PHYSICAL_ALTERNATE_IS_ORIGINAL', 'Choose a different physical Source for alternate-host restore.', { category: 'conflict' });
    await this.#targetConnections(tenant, targetSource);
    const now = this.clock();
    const record = await this.controlDatabase.repository('restoreRun').create({
      workspaceId: tenant, actorId: actor, recoveryPointIds: [point.id], targetConnectionId: targetSource.connectionId,
      target: { operation: 'physical', engine: 'mysql', mode: request.mode, sourceId: targetSource.id, mysqlConnectionId: targetSource.connectionId, sshConnectionId: targetSource.physicalExecution.sshConnectionId, datadir: targetSource.physicalExecution.dataDirectory, serviceName: targetSource.physicalExecution.serviceName },
      mode: request.mode, conflictPolicy: 'fail', workerId: `device:${this.deviceId}`, state: 'queued',
      progress: { phase: 'queued', itemsTotal: 0, itemsCompleted: 0, bytesTotal: 0, bytesWritten: 0, throughputBytesPerSecond: 0, startedAt: null, updatedAt: now, warnings: [] }, validation: null, result: null
    });
    const controller = new AbortController();
    const operation = this.#execute(tenant, actor, record.id, request, controller.signal).catch(() => this.controlDatabase.repository('restoreRun').get(tenant, record.id));
    this.active.set(record.id, { operation, controller });
    operation.finally(() => this.active.delete(record.id));
    return record;
  }

  async wait(workspaceId, restoreRunId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const id = requiredText(restoreRunId, 'RestoreRun ID', 200);
    if (this.active.has(id)) await this.active.get(id).operation;
    const record = await this.controlDatabase.repository('restoreRun').get(tenant, id);
    if (!record || record.target?.operation !== 'physical') throw new MysqlPhysicalRestoreError('MYSQL_PHYSICAL_RESTORE_RUN_NOT_FOUND', 'The physical RestoreRun was not found.', { category: 'not-found' });
    return record;
  }

  async cancel(workspaceId, actorId, restoreRunId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    requiredText(actorId, 'Actor ID', 200);
    const id = requiredText(restoreRunId, 'RestoreRun ID', 200);
    const record = await this.controlDatabase.repository('restoreRun').get(tenant, id);
    if (!record || record.target?.operation !== 'physical') throw new MysqlPhysicalRestoreError('MYSQL_PHYSICAL_RESTORE_RUN_NOT_FOUND', 'The physical RestoreRun was not found.', { category: 'not-found' });
    if (TERMINAL_STATES.has(record.state)) return record;
    const active = this.active.get(id);
    if (!active) {
      const latest = await this.controlDatabase.repository('restoreRun').get(tenant, id);
      if (latest && TERMINAL_STATES.has(latest.state)) return latest;
      throw new MysqlPhysicalRestoreError('MYSQL_PHYSICAL_RESTORE_NOT_ACTIVE', 'The physical restore is not active in this DeployerX process.', { category: 'conflict' });
    }
    active.controller.abort();
    await active.operation;
    return this.controlDatabase.repository('restoreRun').get(tenant, id);
  }

  async list(workspaceId, options = {}) {
    return (await this.controlDatabase.repository('restoreRun').list(requiredText(workspaceId, 'Workspace ID', 200), { limit: Math.min(200, Math.max(1, Number(options.limit) || 50)) })).filter((record) => record.target?.operation === 'physical' && record.target?.engine === 'mysql');
  }

  async reconcile(workspaceId, actorId = 'system') {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const recovered = [];
    for (const record of (await this.list(tenant, { limit: 200 })).filter((item) => !TERMINAL_STATES.has(item.state) && !this.active.has(item.id))) {
      recovered.push(await this.#project(tenant, record.id, { state: 'failed', progress: { ...(record.progress || {}), phase: 'failed', updatedAt: this.clock() }, result: { error: { code: 'MYSQL_PHYSICAL_RESTORE_INTERRUPTED', category: 'physical-restore', retryable: false, safeMessage: 'The DeployerX process stopped during physical restore. Inspect the target datadir before retrying.' }, completedAt: this.clock() } }, actorId));
    }
    return recovered;
  }

  async #project(workspaceId, id, changes, actorId) {
    return this.controlDatabase.transaction((transaction) => {
      const current = transaction.get('restoreRun', workspaceId, id);
      return transaction.projectExecution('restoreRun', workspaceId, id, changes, { expectedRevision: current.revision, actorId });
    });
  }

  async #targetConnections(workspaceId, source) {
    const [mysqlConnection, sshConnection] = await Promise.all([
      this.controlDatabase.repository('connection').get(workspaceId, source.connectionId),
      this.controlDatabase.repository('connection').get(workspaceId, source.physicalExecution.sshConnectionId)
    ]);
    if (!mysqlConnection || mysqlConnection.adapterId !== ADAPTER_ID || mysqlConnection.lastTest?.status !== 'success' || !mysqlConnection.lastTest?.endpointIdentity?.serverUuid) throw new MysqlPhysicalRestoreError('MYSQL_PHYSICAL_TARGET_MYSQL_UNHEALTHY', 'Retest the target MySQL connection before preparing its datadir.', { category: 'connectivity' });
    if (!sshConnection || sshConnection.adapterId !== 'deployerx.connection.ssh' || sshConnection.lastTest?.status !== 'success') throw new MysqlPhysicalRestoreError('MYSQL_PHYSICAL_TARGET_SSH_UNHEALTHY', 'Retest the target SSH execution connection before restore.', { category: 'connectivity' });
    if (![mysqlConnection, sshConnection].every((connection) => (connection.workerAffinity || []).includes(`device:${this.deviceId}`))) throw new MysqlPhysicalRestoreError('MYSQL_PHYSICAL_RESTORE_OTHER_DEVICE', 'The physical restore target belongs to another device.', { category: 'authorization' });
    return { mysqlConnection, sshConnection };
  }

  async #loadChain(workspaceId, selectedPointId) {
    const [points, artifacts] = await Promise.all([
      this.controlDatabase.repository('recoveryPoint').list(workspaceId, { limit: 1000 }),
      this.controlDatabase.repository('artifact').list(workspaceId, { limit: 5000 })
    ]);
    const physicalArtifacts = artifacts.filter((artifact) => artifact.kind === 'physical-backup');
    const metadataByPoint = new Map(physicalArtifacts.map((artifact) => [artifact.recoveryPointId, artifact.metadata]));
    const validated = validateChain(points, metadataByPoint, selectedPointId);
    return { ...validated, artifacts: physicalArtifacts };
  }

  async #repositoryFile(workspaceId, point, artifacts) {
    for (const copy of (point.repositoryCopies || []).filter((item) => item.state === 'available')) {
      const artifact = artifacts.find((item) => item.recoveryPointId === point.id && item.repositoryId === copy.repositoryId);
      if (!artifact) continue;
      const opened = await this.openRepository(workspaceId, copy.repositoryId);
      const snapshot = await opened.engine.openSnapshot({}, { repositoryId: copy.repositoryId, snapshotId: copy.engineSnapshotId, masterKey: opened.masterKey });
      const file = snapshot.manifest.files.find((item) => item.type === 'file' && item.metadata?.artifactKind === 'physical-backup');
      if (!file || file.sizeBytes !== artifact.sizeBytes || file.contentDigest?.digest !== artifact.checksum?.digest || file.metadata?.database?.kind !== 'mysql-xtrabackup') throw new MysqlPhysicalRestoreError('MYSQL_PHYSICAL_ARTIFACT_INVALID', 'A physical Artifact does not match its authenticated repository manifest.', { category: 'integrity' });
      return { copy, artifact, opened, snapshot, file };
    }
    throw new MysqlPhysicalRestoreError('MYSQL_PHYSICAL_ARTIFACT_UNAVAILABLE', 'No available repository copy contains a required physical Artifact.', { category: 'not-found' });
  }

  async #execute(workspaceId, actorId, restoreRunId, request, signal) {
    let session = null;
    let remoteWorkspace = null;
    let progress = { phase: 'preparing', itemsTotal: 0, itemsCompleted: 0, bytesTotal: 0, bytesWritten: 0, throughputBytesPerSecond: 0, startedAt: this.clock(), updatedAt: this.clock(), warnings: [] };
    const startedMs = Date.now();
    try {
      await this.#project(workspaceId, restoreRunId, { state: 'preparing', progress }, actorId);
      const selectedPoint = await this.controlDatabase.repository('recoveryPoint').get(workspaceId, request.recoveryPointId);
      const protectedSource = assertPhysicalSource(await this.controlDatabase.repository('source').get(workspaceId, selectedPoint?.sourceId));
      const targetSource = request.mode === 'original' ? protectedSource : assertPhysicalSource(await this.controlDatabase.repository('source').get(workspaceId, request.targetSourceId));
      const { mysqlConnection, sshConnection } = await this.#targetConnections(workspaceId, targetSource);
      const chain = await this.#loadChain(workspaceId, request.recoveryPointId);
      const files = [];
      for (const point of chain.chain) files.push(await this.#repositoryFile(workspaceId, point, chain.artifacts));
      progress.itemsTotal = files.length;
      progress.bytesTotal = files.reduce((total, item) => total + Number(item.file.sizeBytes || 0), 0);
      const execution = targetSource.physicalExecution;
      session = await this.sessionFactory({ connectionConfig: connectionConfigFromRecord(sshConnection), resolveSecret: (secretRefId) => this.secretStore.resolve({ workspaceId, id: secretRefId }), signal });
      const toolVersions = await Promise.all([
        session.run(commandFromArgs(execution.xtrabackupExecutable, ['--version']), { stdoutLimitBytes: 8192 }),
        session.run(commandFromArgs(execution.xbstreamExecutable, ['--version']), { stdoutLimitBytes: 8192 })
      ]);
      parseXtrabackupVersion(`${toolVersions[0].stdout}\n${toolVersions[0].stderr}`, 'xtrabackup');
      parseXtrabackupVersion(`${toolVersions[1].stdout}\n${toolVersions[1].stderr}`, 'xbstream');
      const root = path.posix.normalize(execution.remoteTemporaryDirectory).replace(/\/$/, '');
      const allocated = await session.run(commandFromArgs('mktemp', ['-d', '-p', root, `deployerx-xtrabackup-restore-${String(restoreRunId).slice(0, 20)}.XXXXXX`]), { stdoutLimitBytes: 8192 });
      remoteWorkspace = path.posix.normalize(allocated.stdout.trim()).replace(/\/$/, '');
      if (path.posix.dirname(remoteWorkspace) !== root || !path.posix.basename(remoteWorkspace).startsWith('deployerx-xtrabackup-restore-')) throw new MysqlPhysicalRestoreError('MYSQL_PHYSICAL_RESTORE_WORKSPACE_INVALID', 'The restore workspace is outside the approved temporary root.', { category: 'integrity' });
      const directories = [];
      for (let index = 0; index < files.length; index += 1) {
        const directory = path.posix.join(remoteWorkspace, index === 0 ? 'base' : `incremental-${index}`);
        directories.push(directory);
        await session.run(commandFromArgs('mkdir', ['-m', '0700', '--', directory]), { stdoutLimitBytes: 1024 });
        const item = files[index];
        const content = (async function* tracked() {
          const stream = item.opened.engine.streamFile({}, { repositoryId: item.copy.repositoryId, manifest: item.snapshot.manifest, masterKey: item.opened.masterKey, path: item.file.path });
          for await (const chunk of stream) {
            progress.bytesWritten += Buffer.byteLength(chunk);
            progress.throughputBytesPerSecond = Math.round(progress.bytesWritten / Math.max(1, (Date.now() - startedMs) / 1000));
            yield chunk;
          }
        })();
        await session.consume(commandFromArgs(execution.xbstreamExecutable, ['-x', `--directory=${directory}`], { privilegeMode: execution.privilegeMode }), content, { stderrLimitBytes: 4 * 1024 * 1024 });
        const unsafeScript = `if find ${shellQuote(directory)} -xdev \\( -type l -o -type b -o -type c -o -type p -o -type s \\) -print -quit | grep -q .; then exit 42; fi`;
        await session.run(commandFromArgs('sh', ['-c', unsafeScript], { privilegeMode: execution.privilegeMode }), { stdoutLimitBytes: 8192 }).catch((error) => {
          if (error?.exitCode === 42) throw new MysqlPhysicalRestoreError('MYSQL_PHYSICAL_ARCHIVE_UNSAFE', 'The physical backup contains a link or special file and cannot be restored safely.', { category: 'integrity' });
          throw new MysqlPhysicalRestoreError('MYSQL_PHYSICAL_ARCHIVE_INSPECTION_FAILED', 'DeployerX could not verify the extracted physical backup file types.', { category: 'integrity' });
        });
        progress.itemsCompleted += 1;
        progress.updatedAt = this.clock();
        await this.#project(workspaceId, restoreRunId, { state: 'running', progress: { ...progress, phase: 'materializing' } }, actorId);
      }
      const base = directories[0];
      if (directories.length === 1) {
        await session.run(commandFromArgs(execution.xtrabackupExecutable, ['--prepare', `--target-dir=${base}`], { privilegeMode: execution.privilegeMode }), { stdoutLimitBytes: 4 * 1024 * 1024, stderrLimitBytes: 4 * 1024 * 1024 });
      } else {
        await session.run(commandFromArgs(execution.xtrabackupExecutable, ['--prepare', '--apply-log-only', `--target-dir=${base}`], { privilegeMode: execution.privilegeMode }), { stdoutLimitBytes: 4 * 1024 * 1024, stderrLimitBytes: 4 * 1024 * 1024 });
        for (let index = 1; index < directories.length; index += 1) {
          const args = ['--prepare', `--target-dir=${base}`, `--incremental-dir=${directories[index]}`];
          if (index < directories.length - 1) args.splice(1, 0, '--apply-log-only');
          await session.run(commandFromArgs(execution.xtrabackupExecutable, args, { privilegeMode: execution.privilegeMode }), { stdoutLimitBytes: 4 * 1024 * 1024, stderrLimitBytes: 4 * 1024 * 1024 });
        }
      }
      const preparedCheckpoints = await session.run(commandFromArgs('cat', [path.posix.join(base, 'xtrabackup_checkpoints')], { privilegeMode: execution.privilegeMode }), { stdoutLimitBytes: 8192 });
      const prepared = parseCheckpoints(preparedCheckpoints.stdout);
      if (prepared.toLsn !== chain.toLsn) throw new MysqlPhysicalRestoreError('MYSQL_PHYSICAL_PREPARE_LSN_MISMATCH', 'The prepared physical backup does not reach the selected RecoveryPoint LSN.', { category: 'integrity' });
      progress.phase = 'copying-back'; progress.updatedAt = this.clock();
      await this.#project(workspaceId, restoreRunId, { state: 'running', progress }, actorId);
      await session.run(commandFromArgs('systemctl', ['stop', execution.serviceName], { privilegeMode: execution.privilegeMode }), { stdoutLimitBytes: 8192 });
      const stopped = await session.run(commandFromArgs('systemctl', ['show', '--property=ActiveState', '--value', execution.serviceName], { privilegeMode: execution.privilegeMode }), { stdoutLimitBytes: 8192 });
      if (stopped.stdout.trim() !== 'inactive') throw new MysqlPhysicalRestoreError('MYSQL_PHYSICAL_SERVICE_STILL_ACTIVE', 'The MySQL service did not reach the inactive state.', { category: 'conflict' });
      await session.run(commandFromArgs('install', ['-d', '-m', '0750', '-o', execution.mysqlOwner, '-g', execution.mysqlGroup, execution.dataDirectory], { privilegeMode: execution.privilegeMode }), { stdoutLimitBytes: 8192 });
      const emptyScript = `test -z "$(find ${shellQuote(execution.dataDirectory)} -mindepth 1 -maxdepth 1 -print -quit)"`;
      await session.run(commandFromArgs('sh', ['-c', emptyScript], { privilegeMode: execution.privilegeMode }), { stdoutLimitBytes: 8192 }).catch((error) => { throw new MysqlPhysicalRestoreError('MYSQL_PHYSICAL_DATADIR_NOT_EMPTY', 'The target datadir is not empty. DeployerX will not remove or overwrite it.', { category: 'conflict' }); });
      await session.run(commandFromArgs(execution.xtrabackupExecutable, ['--copy-back', `--target-dir=${base}`, `--datadir=${execution.dataDirectory}`], { privilegeMode: execution.privilegeMode }), { stdoutLimitBytes: 4 * 1024 * 1024, stderrLimitBytes: 4 * 1024 * 1024 });
      if (request.mode === 'alternate') await session.run(commandFromArgs('rm', ['-f', '--', path.posix.join(execution.dataDirectory, 'auto.cnf')], { privilegeMode: execution.privilegeMode }), { stdoutLimitBytes: 1024 });
      await session.run(commandFromArgs('chown', ['-hR', `${execution.mysqlOwner}:${execution.mysqlGroup}`, execution.dataDirectory], { privilegeMode: execution.privilegeMode }), { stdoutLimitBytes: 8192 });
      await session.run(commandFromArgs('systemctl', ['start', execution.serviceName], { privilegeMode: execution.privilegeMode }), { stdoutLimitBytes: 8192 });
      const active = await session.run(commandFromArgs('systemctl', ['show', '--property=ActiveState', '--value', execution.serviceName], { privilegeMode: execution.privilegeMode }), { stdoutLimitBytes: 8192 });
      if (active.stdout.trim() !== 'active') throw new MysqlPhysicalRestoreError('MYSQL_PHYSICAL_SERVICE_START_FAILED', 'The MySQL service did not return to the active state.', { category: 'connectivity', retryable: true });
      progress.phase = 'validating'; progress.updatedAt = this.clock();
      await this.#project(workspaceId, restoreRunId, { state: 'validating', progress }, actorId);
      const [passwordSecretRefId] = mysqlConnection.secretRefIds || [];
      const testResult = await this.mysqlAdapter.testConnection({ resolveSecret: (secretRefId) => this.secretStore.resolve({ workspaceId, id: secretRefId }) }, this.mysqlAdapter.normalizeConfig({ ...mysqlConnection.endpoint, passwordSecretRefId }));
      if (testResult.status !== 'success' || !testResult.endpointIdentity?.serverUuid) throw new MysqlPhysicalRestoreError('MYSQL_PHYSICAL_NATIVE_VALIDATION_FAILED', 'The restored MySQL server did not pass native connectivity and identity validation.', { category: 'integrity' });
      if (request.mode === 'original' && testResult.endpointIdentity.serverUuid !== chain.serverUuid) throw new MysqlPhysicalRestoreError('MYSQL_PHYSICAL_SERVER_UUID_MISMATCH', 'The restored original server UUID does not match the protected server.', { category: 'integrity' });
      if (request.mode === 'alternate' && testResult.endpointIdentity.serverUuid === chain.serverUuid) throw new MysqlPhysicalRestoreError('MYSQL_PHYSICAL_ALTERNATE_UUID_NOT_REGENERATED', 'The alternate server did not generate a distinct server UUID.', { category: 'integrity' });
      const validation = { state: 'succeeded', nativeIntegrityValidation: true, checkedAt: this.clock(), checks: [{ id: 'service', status: 'pass' }, { id: 'connectivity', status: 'pass' }, { id: 'server-version', status: 'pass' }, { id: 'server-identity', status: 'pass' }], serverUuid: testResult.endpointIdentity.serverUuid, preparedToLsn: prepared.toLsn };
      progress.phase = 'complete'; progress.updatedAt = this.clock();
      return this.#project(workspaceId, restoreRunId, { state: 'succeeded', progress, validation, result: { restoredRecoveryPointIds: chain.chain.map((point) => point.id), chainRootRecoveryPointId: chain.rootId, preparedToLsn: prepared.toLsn, bytesRestored: progress.bytesWritten, targetServerUuid: testResult.endpointIdentity.serverUuid, completedAt: this.clock() } }, actorId);
    } catch (error) {
      const current = await this.controlDatabase.repository('restoreRun').get(workspaceId, restoreRunId);
      if (current && !TERMINAL_STATES.has(current.state)) {
        const canceled = signal?.aborted || error?.code === 'SSH_EXECUTION_CANCELED';
        const failure = canceled
          ? { code: 'MYSQL_PHYSICAL_RESTORE_CANCELED', category: 'canceled', retryable: false, safeMessage: 'The MySQL physical restore was canceled.' }
          : safeError(error);
        return this.#project(workspaceId, restoreRunId, { state: canceled ? 'canceled' : 'failed', progress: { ...progress, phase: canceled ? 'canceled' : 'failed', updatedAt: this.clock() }, result: { error: failure, completedAt: this.clock() } }, actorId);
      }
      throw error;
    } finally {
      if (session && remoteWorkspace && path.posix.basename(remoteWorkspace).startsWith('deployerx-xtrabackup-restore-')) await session.run(commandFromArgs('rm', ['-rf', '--', remoteWorkspace]), { stdoutLimitBytes: 1024, ignoreAbort: true }).catch(() => {});
      session?.close();
    }
  }
}

module.exports = { MysqlPhysicalRestoreError, MysqlPhysicalRestoreService, RESTORE_CONFIRMATIONS, normalizeRequest, validateChain };
