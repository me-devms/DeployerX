const { ADAPTER_ID } = require('./mysql-logical');

const RESTORE_CONFIRMATION = 'RESTORE MYSQL';
const RESTORE_CONFIRMATIONS = Object.freeze({ original: RESTORE_CONFIRMATION, alternate: 'RESTORE MYSQL ALTERNATE', 'new-database': 'RESTORE MYSQL NEW DATABASE' });
const TERMINAL_STATES = new Set(['succeeded', 'warning', 'failed', 'canceled']);

class MysqlRestoreError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'MysqlRestoreError';
    this.code = code;
    this.category = options.category || 'restore';
    this.retryable = Boolean(options.retryable);
  }
}

function requiredText(value, label, maximumLength = 4096) {
  const text = String(value ?? '').trim();
  if (!text || text.includes('\0') || text.length > maximumLength) throw new TypeError(`${label} is invalid.`);
  return text;
}

function publicError(error) {
  if (error instanceof MysqlRestoreError || (error?.code && error?.category)) {
    return { code: String(error.code).slice(0, 100), category: String(error.category || 'restore').slice(0, 50), retryable: Boolean(error.retryable), safeMessage: String(error.message || 'The MySQL restore failed.').slice(0, 500) };
  }
  return { code: 'MYSQL_RESTORE_FAILED', category: 'restore', retryable: false, safeMessage: 'DeployerX could not complete the MySQL restore.' };
}

function normalizeRequest(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('MySQL restore request must be an object.');
  const mode = String(input.mode || 'original');
  if (!RESTORE_CONFIRMATIONS[mode]) throw new MysqlRestoreError('MYSQL_RESTORE_MODE_INVALID', 'Choose original server, alternate server, or new database for the MySQL restore.', { category: 'validation' });
  if (input.confirmed !== true || String(input.confirmationText || '').trim() !== RESTORE_CONFIRMATIONS[mode]) throw new MysqlRestoreError('MYSQL_RESTORE_CONFIRMATION_REQUIRED', 'Confirm the selected MySQL restore target before continuing.', { category: 'conflict' });
  const targetConnectionId = mode === 'original' ? null : requiredText(input.targetConnectionId, 'Target connection ID', 200);
  const targetDatabase = mode === 'new-database' ? requiredText(input.targetDatabase, 'Target database', 64) : null;
  if (targetDatabase && /\p{C}/u.test(targetDatabase)) throw new TypeError('Target database is invalid.');
  const conflictPolicy = mode === 'alternate' && input.conflictPolicy === 'overwrite' ? 'overwrite' : 'fail';
  return { recoveryPointId: requiredText(input.recoveryPointId, 'Recovery point ID', 200), mode, targetConnectionId, targetDatabase, conflictPolicy };
}

class MysqlRestoreService {
  constructor({ controlDatabase, secretStore, deviceId, adapter, openRepository, clock = () => new Date().toISOString() } = {}) {
    if (!controlDatabase || !secretStore || !adapter || typeof openRepository !== 'function') throw new TypeError('MySQL restore dependencies are required.');
    this.controlDatabase = controlDatabase;
    this.secretStore = secretStore;
    this.deviceId = requiredText(deviceId, 'Device ID', 200);
    this.adapter = adapter;
    this.openRepository = openRepository;
    this.clock = clock;
    this.active = new Map();
  }

  async start(workspaceId, actorId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const request = normalizeRequest(input);
    const point = await this.controlDatabase.repository('recoveryPoint').get(tenant, request.recoveryPointId);
    if (!point) throw new MysqlRestoreError('MYSQL_RECOVERY_POINT_NOT_FOUND', 'The MySQL recovery point was not found.', { category: 'not-found' });
    const source = await this.controlDatabase.repository('source').get(tenant, point.sourceId);
    if (!source || source.adapterId !== ADAPTER_ID) throw new MysqlRestoreError('MYSQL_RECOVERY_POINT_INVALID', 'The selected recovery point is not a MySQL logical backup.', { category: 'validation' });
    const targetConnectionId = request.mode === 'original' ? source.connectionId : request.targetConnectionId;
    const targetConnection = await this.controlDatabase.repository('connection').get(tenant, targetConnectionId);
    if (!targetConnection || targetConnection.adapterId !== ADAPTER_ID) throw new MysqlRestoreError('MYSQL_RESTORE_TARGET_INVALID', 'Choose a saved MySQL connection for the restore target.', { category: 'validation' });
    if (!(targetConnection.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new MysqlRestoreError('MYSQL_RESTORE_OTHER_DEVICE', 'The MySQL restore target belongs to another device.', { category: 'authorization' });
    if (targetConnection.lastTest?.status !== 'success' || !targetConnection.trust?.fingerprint) throw new MysqlRestoreError('MYSQL_RESTORE_TARGET_UNHEALTHY', 'Retest the selected MySQL connection before restoring.', { category: 'connectivity', retryable: true });
    const now = this.clock();
    const record = await this.controlDatabase.repository('restoreRun').create({
      workspaceId: tenant,
      actorId: actor,
      recoveryPointIds: [point.id],
      targetConnectionId,
      target: { mode: request.mode, engine: 'mysql', sourceId: source.id, connectionId: targetConnectionId, targetDatabase: request.targetDatabase, serverIdentityFingerprint: targetConnection.trust.fingerprint },
      mode: request.mode,
      conflictPolicy: request.mode === 'original' ? 'overwrite' : request.conflictPolicy,
      workerId: `device:${this.deviceId}`,
      state: 'queued',
      progress: { phase: 'queued', itemsTotal: 1, itemsCompleted: 0, bytesTotal: 0, bytesWritten: 0, throughputBytesPerSecond: 0, startedAt: null, updatedAt: now, warnings: [] },
      validation: null,
      result: null
    });
    const operation = this.#execute(tenant, actor, record.id, request).catch(() => this.controlDatabase.repository('restoreRun').get(tenant, record.id));
    this.active.set(record.id, operation);
    operation.finally(() => this.active.delete(record.id));
    return record;
  }

  async wait(workspaceId, restoreRunId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const id = requiredText(restoreRunId, 'Restore run ID', 200);
    if (this.active.has(id)) await this.active.get(id);
    const record = await this.controlDatabase.repository('restoreRun').get(tenant, id);
    if (!record) throw new MysqlRestoreError('MYSQL_RESTORE_RUN_NOT_FOUND', 'The MySQL restore run was not found.', { category: 'not-found' });
    return record;
  }

  async list(workspaceId, options = {}) {
    return (await this.controlDatabase.repository('restoreRun').list(requiredText(workspaceId, 'Workspace ID', 200), { limit: Math.min(200, Math.max(1, Number(options.limit) || 50)) }))
      .filter((record) => record.target?.engine === 'mysql' && !['point-in-time', 'physical'].includes(record.target?.operation));
  }

  async reconcile(workspaceId, actorId = 'system') {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const records = await this.list(tenant, { limit: 200 });
    const recovered = [];
    for (const record of records.filter((item) => !TERMINAL_STATES.has(item.state) && !this.active.has(item.id))) {
      recovered.push(await this.#project(tenant, record.id, {
        state: 'failed',
        progress: { ...(record.progress || {}), phase: 'failed', updatedAt: this.clock() },
        result: { error: { code: 'MYSQL_RESTORE_PROCESS_INTERRUPTED', category: 'restore', retryable: true, safeMessage: 'The DeployerX process stopped before the MySQL restore completed.' }, completedAt: this.clock() }
      }, actorId));
    }
    return recovered;
  }

  async #project(workspaceId, restoreRunId, changes, actorId) {
    return this.controlDatabase.transaction((transaction) => {
      const current = transaction.get('restoreRun', workspaceId, restoreRunId);
      return transaction.projectExecution('restoreRun', workspaceId, restoreRunId, changes, { expectedRevision: current.revision, actorId });
    });
  }

  async #execute(workspaceId, actorId, restoreRunId, request) {
    const startedMs = Date.now();
    let progress = { phase: 'preparing', itemsTotal: 1, itemsCompleted: 0, bytesTotal: 0, bytesWritten: 0, throughputBytesPerSecond: 0, startedAt: this.clock(), updatedAt: this.clock(), warnings: [] };
    let validationRecord = null;
    try {
      await this.#project(workspaceId, restoreRunId, { state: 'preparing', progress }, actorId);
      const point = await this.controlDatabase.repository('recoveryPoint').get(workspaceId, request.recoveryPointId);
      if (!point || point.consistency !== 'application') throw new MysqlRestoreError('MYSQL_RECOVERY_POINT_CONSISTENCY_INVALID', 'Only an application-consistent MySQL recovery point can be restored.', { category: 'consistency' });
      const [source, artifacts] = await Promise.all([
        this.controlDatabase.repository('source').get(workspaceId, point.sourceId),
        this.controlDatabase.repository('artifact').list(workspaceId, { limit: 1000 })
      ]);
      const targetConnectionId = request.mode === 'original' ? source?.connectionId : request.targetConnectionId;
      const connection = targetConnectionId ? await this.controlDatabase.repository('connection').get(workspaceId, targetConnectionId) : null;
      if (!source || source.adapterId !== ADAPTER_ID || !connection || connection.adapterId !== ADAPTER_ID) throw new MysqlRestoreError('MYSQL_RESTORE_SOURCE_UNAVAILABLE', 'The protected MySQL source or selected restore connection is unavailable.', { category: 'not-found' });
      if (!(connection.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new MysqlRestoreError('MYSQL_RESTORE_OTHER_DEVICE', 'The MySQL restore target belongs to another device.', { category: 'authorization' });
      if (connection.lastTest?.status !== 'success' || !connection.trust?.fingerprint) throw new MysqlRestoreError('MYSQL_RESTORE_TARGET_UNHEALTHY', 'Retest the selected MySQL connection before restoring.', { category: 'connectivity', retryable: true });
      const availableCopies = (point.repositoryCopies || []).filter((copy) => copy.state === 'available');
      let selected = null;
      for (const copy of availableCopies) {
        const artifact = artifacts.find((item) => item.recoveryPointId === point.id && item.repositoryId === copy.repositoryId && item.kind === 'database-dump');
        if (artifact) { selected = { copy, artifact }; break; }
      }
      if (!selected) throw new MysqlRestoreError('MYSQL_DUMP_COPY_UNAVAILABLE', 'No available repository copy contains the MySQL dump artifact.', { category: 'not-found' });
      const opened = await this.openRepository(workspaceId, selected.copy.repositoryId);
      const snapshot = await opened.engine.openSnapshot({}, { repositoryId: selected.copy.repositoryId, snapshotId: selected.copy.engineSnapshotId, masterKey: opened.masterKey });
      const dumpFile = snapshot.manifest.files.find((file) => file.type === 'file' && file.metadata?.artifactKind === 'database-dump' && file.metadata?.database?.adapterId === ADAPTER_ID);
      if (!dumpFile || dumpFile.sizeBytes !== selected.artifact.sizeBytes || dumpFile.contentDigest?.digest !== selected.artifact.checksum?.digest) throw new MysqlRestoreError('MYSQL_DUMP_MANIFEST_INVALID', 'The authenticated repository manifest does not match the MySQL dump artifact.', { category: 'integrity' });
      const serverMetadata = dumpFile.metadata.database.server || {};
      if (request.mode === 'original' && serverMetadata.serverIdentityFingerprint !== connection.trust.fingerprint) throw new MysqlRestoreError('MYSQL_RESTORE_SERVER_MISMATCH', 'The original MySQL server identity no longer matches this recovery point.', { category: 'integrity' });
      const [passwordSecretRefId] = connection.secretRefIds || [];
      const connectionConfig = this.adapter.normalizeConfig({ ...connection.endpoint, passwordSecretRefId });
      const prepared = await this.adapter.prepareRestoreTarget({ resolveSecret: (secretRefId) => this.secretStore.resolve({ workspaceId, id: secretRefId }) }, {
        mode: request.mode, connection: connectionConfig, metadata: serverMetadata, targetDatabase: request.targetDatabase, conflictPolicy: request.conflictPolicy
      });
      await this.#project(workspaceId, restoreRunId, {
        target: { mode: request.mode, engine: 'mysql', sourceId: source.id, connectionId: connection.id, targetDatabase: prepared.targetDatabase, sourceDatabase: prepared.sourceDatabase, serverIdentityFingerprint: connection.trust.fingerprint, collisionCount: prepared.collisions.length, databaseCreated: prepared.databaseCreated }
      }, actorId);
      const restorePlan = await this.adapter.planRestore({}, {
        mode: request.mode, confirmation: request.mode === 'original' ? 'RESTORE_MYSQL_ORIGINAL' : request.mode === 'alternate' ? 'RESTORE_MYSQL_ALTERNATE' : 'RESTORE_MYSQL_NEW_DATABASE', connection: connectionConfig,
        metadata: prepared.metadata, serverIdentityFingerprint: connection.trust.fingerprint, artifactPath: dumpFile.path, targetPrepared: true, databaseCreated: prepared.databaseCreated
      });
      progress = { ...progress, phase: 'running', bytesTotal: dumpFile.sizeBytes, updatedAt: this.clock() };
      await this.#project(workspaceId, restoreRunId, { state: 'running', progress }, actorId);
      const content = () => (async function* trackedContent() {
        const stream = opened.engine.streamFile({}, { repositoryId: selected.copy.repositoryId, manifest: snapshot.manifest, masterKey: opened.masterKey, path: dumpFile.path });
        for await (const chunk of stream) {
          progress.bytesWritten += Buffer.byteLength(chunk);
          progress.throughputBytesPerSecond = Math.round(progress.bytesWritten / Math.max(1, (Date.now() - startedMs) / 1000));
          yield chunk;
        }
      })();
      const restored = await this.adapter.executeRestore({ resolveSecret: (secretRefId) => this.secretStore.resolve({ workspaceId, id: secretRefId }) }, restorePlan, { async open() { return content(); } });
      progress = { ...progress, phase: 'validating', itemsCompleted: 1, updatedAt: this.clock() };
      await this.#project(workspaceId, restoreRunId, { state: 'validating', progress }, actorId);
      const validation = await this.adapter.validateRestore({ resolveSecret: (secretRefId) => this.secretStore.resolve({ workspaceId, id: secretRefId }), connection: connectionConfig }, restored);
      const warnings = Array.isArray(validation.warnings) ? validation.warnings.slice(0, 20) : [];
      validationRecord = { state: validation.status, connectivity: validation.checks?.find((check) => check.id === 'connectivity')?.status || 'failed', expectedObjects: validation.checks?.find((check) => check.id === 'expected-objects')?.status || 'unavailable', nativeIntegrityValidation: Boolean(validation.nativeIntegrityValidation), checks: validation.checks || [], completedAt: this.clock() };
      if (!validation.valid) throw new MysqlRestoreError('MYSQL_RESTORE_NATIVE_VALIDATION_FAILED', 'The restored MySQL databases did not pass expected-object and native integrity validation.', { category: 'integrity' });
      const terminalState = warnings.length ? 'warning' : 'succeeded';
      progress = { ...progress, phase: 'complete', warnings, updatedAt: this.clock() };
      return this.#project(workspaceId, restoreRunId, {
        state: terminalState,
        progress,
        validation: { ...validationRecord, state: terminalState },
        result: { restoredItems: 1, bytesRestored: progress.bytesWritten, warnings, targetDatabase: prepared.targetDatabase, completedAt: this.clock() }
      }, actorId);
    } catch (error) {
      const current = await this.controlDatabase.repository('restoreRun').get(workspaceId, restoreRunId);
      if (current && !TERMINAL_STATES.has(current.state)) return this.#project(workspaceId, restoreRunId, {
        state: 'failed',
        progress: { ...progress, phase: 'failed', updatedAt: this.clock() },
        validation: validationRecord,
        result: { error: publicError(error), completedAt: this.clock() }
      }, actorId);
      throw error;
    }
  }
}

module.exports = { MysqlRestoreError, MysqlRestoreService, RESTORE_CONFIRMATION, RESTORE_CONFIRMATIONS, normalizeRequest };
