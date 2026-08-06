const path = require('path');
const { ADAPTER_ID, inspectRestorePath, restoreStagePath } = require('./sqlite');

const RESTORE_CONFIRMATIONS = Object.freeze({ alternate: 'RESTORE SQLITE ALTERNATE' });
const TERMINAL_STATES = new Set(['succeeded', 'warning', 'failed', 'canceled']);
const RECONCILIATION_PAGE_SIZE = 200;

class SqliteRestoreError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'SqliteRestoreError';
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

function absolutePath(value) {
  const targetPath = requiredText(value, 'SQLite recovery target path');
  if (!path.isAbsolute(targetPath) || path.normalize(targetPath) !== targetPath || /[\r\n\x1f]/.test(targetPath)) throw new SqliteRestoreError('SQLITE_RESTORE_TARGET_INVALID', 'Choose a canonical absolute path for SQLite recovery.', { category: 'validation' });
  return targetPath;
}

function normalizeRequest(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('SQLite restore request must be an object.');
  const mode = String(input.mode || 'alternate');
  if (!RESTORE_CONFIRMATIONS[mode]) throw new SqliteRestoreError('SQLITE_RESTORE_MODE_UNSUPPORTED', 'SQLite recovery currently supports an alternate absent path only.', { category: 'compatibility' });
  if (input.confirmed !== true || String(input.confirmationText || '').trim() !== RESTORE_CONFIRMATIONS[mode]) throw new SqliteRestoreError('SQLITE_RESTORE_CONFIRMATION_REQUIRED', 'Confirm the alternate SQLite recovery target before continuing.', { category: 'conflict' });
  return { recoveryPointId: requiredText(input.recoveryPointId, 'Recovery point ID', 200), mode, targetPath: absolutePath(input.targetPath) };
}

function publicError(error) {
  if (error instanceof SqliteRestoreError || (error?.code && error?.category)) return { code: String(error.code).slice(0, 100), category: String(error.category || 'restore').slice(0, 50), retryable: Boolean(error.retryable), safeMessage: String(error.message || 'The SQLite recovery failed.').slice(0, 500) };
  return { code: 'SQLITE_RESTORE_FAILED', category: 'restore', retryable: false, safeMessage: 'DeployerX could not complete the SQLite recovery.' };
}

class SqliteRestoreService {
  constructor({ controlDatabase, deviceId, adapter, openRepository, fileSystem, clock = () => new Date().toISOString() } = {}) {
    if (!controlDatabase || !adapter || typeof openRepository !== 'function') throw new TypeError('SQLite restore dependencies are required.');
    this.controlDatabase = controlDatabase;
    this.deviceId = requiredText(deviceId, 'Device ID', 200);
    this.adapter = adapter;
    this.openRepository = openRepository;
    this.fileSystem = fileSystem || require('fs/promises');
    this.clock = clock;
    this.active = new Map();
  }

  async start(workspaceId, actorId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const request = normalizeRequest(input);
    const point = await this.controlDatabase.repository('recoveryPoint').get(tenant, request.recoveryPointId);
    if (!point || point.type !== 'full' || point.consistency !== 'application') throw new SqliteRestoreError('SQLITE_RECOVERY_POINT_INVALID', 'Choose an application-consistent SQLite full recovery point.', { category: 'validation' });
    const source = await this.controlDatabase.repository('source').get(tenant, point.sourceId);
    const connection = source ? await this.controlDatabase.repository('connection').get(tenant, source.connectionId) : null;
    if (!source || source.adapterId !== ADAPTER_ID || !connection || connection.adapterId !== ADAPTER_ID) throw new SqliteRestoreError('SQLITE_RECOVERY_POINT_INVALID', 'The selected recovery point is not a SQLite online backup.', { category: 'validation' });
    if (!(connection.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new SqliteRestoreError('SQLITE_RESTORE_OTHER_DEVICE', 'SQLite recovery must run on the source connection device.', { category: 'authorization' });
    if (await inspectRestorePath(this.fileSystem, request.targetPath)) throw new SqliteRestoreError('SQLITE_RESTORE_TARGET_EXISTS', 'Choose an absent path for alternate SQLite recovery.', { category: 'conflict' });
    const now = this.clock();
    const record = await this.controlDatabase.repository('restoreRun').create({
      workspaceId: tenant, actorId: actor, recoveryPointIds: [point.id], targetConnectionId: connection.id,
      target: { operation: 'alternate-file', mode: 'alternate', engine: 'sqlite', sourceId: source.id, connectionId: connection.id, targetPath: request.targetPath, targetName: path.basename(request.targetPath) },
      mode: 'alternate', conflictPolicy: 'fail', workerId: `device:${this.deviceId}`, state: 'queued',
      progress: { phase: 'queued', itemsTotal: 1, itemsCompleted: 0, bytesTotal: 0, bytesWritten: 0, throughputBytesPerSecond: 0, startedAt: null, updatedAt: now, warnings: [] }, validation: null, result: null
    });
    const controller = new AbortController();
    const operation = this.#execute(tenant, actor, record.id, request, controller.signal).catch(() => this.controlDatabase.repository('restoreRun').get(tenant, record.id));
    this.active.set(record.id, { operation, controller });
    operation.finally(() => this.active.delete(record.id));
    return record;
  }

  async wait(workspaceId, restoreRunId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const id = requiredText(restoreRunId, 'Restore run ID', 200);
    if (this.active.has(id)) await this.active.get(id).operation;
    const record = await this.controlDatabase.repository('restoreRun').get(tenant, id);
    if (!record || record.target?.engine !== 'sqlite') throw new SqliteRestoreError('SQLITE_RESTORE_RUN_NOT_FOUND', 'The SQLite RestoreRun was not found.', { category: 'not-found' });
    return record;
  }

  async cancel(workspaceId, actorId, restoreRunId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    requiredText(actorId, 'Actor ID', 200);
    const id = requiredText(restoreRunId, 'Restore run ID', 200);
    const record = await this.controlDatabase.repository('restoreRun').get(tenant, id);
    if (!record || record.target?.engine !== 'sqlite') throw new SqliteRestoreError('SQLITE_RESTORE_RUN_NOT_FOUND', 'The SQLite RestoreRun was not found.', { category: 'not-found' });
    if (TERMINAL_STATES.has(record.state)) return record;
    const active = this.active.get(id);
    if (!active) throw new SqliteRestoreError('SQLITE_RESTORE_NOT_ACTIVE', 'The SQLite recovery is not active in this DeployerX process.', { category: 'conflict' });
    active.controller.abort();
    await active.operation;
    return this.controlDatabase.repository('restoreRun').get(tenant, id);
  }

  async list(workspaceId, options = {}) {
    return (await this.controlDatabase.repository('restoreRun').list(requiredText(workspaceId, 'Workspace ID', 200), { limit: Math.min(200, Math.max(1, Number(options.limit) || 50)) })).filter((record) => record.target?.engine === 'sqlite');
  }

  async reconcile(workspaceId, actorId = 'system') {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const records = await this.#reconciliationCandidates(tenant);
    const recovered = [];
    for (const record of records.filter((item) => !this.active.has(item.id))) {
      const targetPath = record.target?.targetPath;
      const stagePath = targetPath ? restoreStagePath(targetPath, record.id) : null;
      if (stagePath) await this.fileSystem.rm(stagePath, { force: true }).catch(() => {});
      let targetState = 'absent';
      if (targetPath) {
        try { targetState = await inspectRestorePath(this.fileSystem, targetPath) ? 'present' : 'absent'; }
        catch { targetState = 'unknown'; }
      }
      const safeMessage = targetState === 'present'
        ? 'SQLite recovery was interrupted after the target may have been published. Validate the target before using it.'
        : targetState === 'unknown'
          ? 'SQLite recovery was interrupted and target publication could not be determined. Inspect the target before retrying.'
          : 'SQLite recovery was interrupted before target publication.';
      recovered.push(await this.#project(tenant, record.id, {
        state: 'failed', progress: { ...(record.progress || {}), phase: 'operator-action-required', updatedAt: this.clock() },
        result: { error: { code: 'SQLITE_RESTORE_PROCESS_INTERRUPTED', category: 'restore', retryable: false, safeMessage }, completedAt: this.clock() }
      }, actorId));
    }
    return recovered;
  }

  async #reconciliationCandidates(workspaceId) {
    const candidates = [];
    let offset = 0;
    while (true) {
      const page = await this.controlDatabase.read((transaction) => {
        const statement = transaction.database.prepare(`
          SELECT data_json FROM restore_runs
          WHERE workspace_id = ? AND deleted_at IS NULL
            AND state NOT IN ('succeeded','warning','failed','canceled')
          ORDER BY created_at DESC, id DESC
          LIMIT ? OFFSET ?
        `);
        const records = [];
        try {
          statement.bind([workspaceId, RECONCILIATION_PAGE_SIZE, offset]);
          while (statement.step()) records.push(JSON.parse(statement.getAsObject().data_json));
        } finally { statement.free(); }
        return records;
      });
      candidates.push(...page.filter((record) => record?.target?.engine === 'sqlite' && record.workerId === `device:${this.deviceId}`));
      if (page.length < RECONCILIATION_PAGE_SIZE) break;
      offset += page.length;
    }
    return candidates;
  }

  async #project(workspaceId, id, changes, actorId) {
    return this.controlDatabase.transaction((transaction) => {
      const current = transaction.get('restoreRun', workspaceId, id);
      return transaction.projectExecution('restoreRun', workspaceId, id, changes, { expectedRevision: current.revision, actorId });
    });
  }

  async #verifiedArtifact(workspaceId, point) {
    const artifacts = await this.controlDatabase.repository('artifact').list(workspaceId, { limit: 1000 });
    for (const copy of (point.repositoryCopies || []).filter((item) => item.state === 'available')) {
      const artifact = artifacts.find((item) => item.recoveryPointId === point.id && item.repositoryId === copy.repositoryId && item.kind === 'database-dump' && item.metadata?.adapterId === ADAPTER_ID);
      if (!artifact) continue;
      const opened = await this.openRepository(workspaceId, copy.repositoryId);
      const snapshot = await opened.engine.openSnapshot({}, { repositoryId: copy.repositoryId, snapshotId: copy.engineSnapshotId, masterKey: opened.masterKey });
      const locatorPath = decodeURIComponent(String(artifact.locator || '').split('#').slice(1).join('#'));
      const file = (snapshot.manifest.files || []).find((candidate) => candidate.type === 'file' && candidate.path === locatorPath && candidate.metadata?.artifactKind === 'database-dump' && candidate.metadata?.database?.adapterId === ADAPTER_ID);
      if (!file || file.sizeBytes !== artifact.sizeBytes || file.contentDigest?.digest !== artifact.checksum?.digest) throw new SqliteRestoreError('SQLITE_RESTORE_MANIFEST_INVALID', 'The authenticated repository manifest does not match the SQLite Artifact.', { category: 'integrity' });
      const metadata = file.metadata.database;
      const expectedDigest = metadata.artifact?.contentDigest;
      if (!/^sha256:[0-9a-f]{64}$/.test(String(expectedDigest || '')) || metadata.artifact?.sizeBytes !== file.sizeBytes || !metadata.protectedIdentity) throw new SqliteRestoreError('SQLITE_RESTORE_METADATA_INVALID', 'The authenticated SQLite recovery metadata is incomplete.', { category: 'integrity' });
      return { copy, artifact, opened, snapshot, file, metadata, expectedDigest };
    }
    throw new SqliteRestoreError('SQLITE_RESTORE_ARTIFACT_UNAVAILABLE', 'No available repository copy contains the SQLite backup Artifact.', { category: 'not-found' });
  }

  async #execute(workspaceId, actorId, restoreRunId, request, signal) {
    let progress = { phase: 'preparing', itemsTotal: 1, itemsCompleted: 0, bytesTotal: 0, bytesWritten: 0, throughputBytesPerSecond: 0, startedAt: this.clock(), updatedAt: this.clock(), warnings: [] };
    let validationRecord = null;
    try {
      await this.#project(workspaceId, restoreRunId, { state: 'preparing', progress }, actorId);
      const point = await this.controlDatabase.repository('recoveryPoint').get(workspaceId, request.recoveryPointId);
      if (!point || point.type !== 'full' || point.consistency !== 'application') throw new SqliteRestoreError('SQLITE_RECOVERY_POINT_INVALID', 'Choose an application-consistent SQLite full recovery point.', { category: 'validation' });
      const source = await this.controlDatabase.repository('source').get(workspaceId, point.sourceId);
      const connection = source ? await this.controlDatabase.repository('connection').get(workspaceId, source.connectionId) : null;
      if (!source || source.adapterId !== ADAPTER_ID || !connection || connection.adapterId !== ADAPTER_ID) throw new SqliteRestoreError('SQLITE_RESTORE_SOURCE_UNAVAILABLE', 'The protected SQLite source connection is unavailable.', { category: 'not-found' });
      const selected = await this.#verifiedArtifact(workspaceId, point);
      const plan = await this.adapter.planRestore({}, {
        mode: 'alternate', confirmation: 'RESTORE_SQLITE_ALTERNATE', targetPath: request.targetPath, executionId: restoreRunId,
        sqliteExecutable: connection.endpoint.sqliteExecutable, timeoutMs: connection.endpoint.timeoutMs, sizeBytes: selected.file.sizeBytes,
        contentDigest: selected.expectedDigest, protectedIdentity: selected.metadata.protectedIdentity
      });
      progress = { ...progress, phase: 'running', bytesTotal: selected.file.sizeBytes, updatedAt: this.clock() };
      await this.#project(workspaceId, restoreRunId, { state: 'running', progress }, actorId);
      const content = () => (async function* tracked() {
        const stream = selected.opened.engine.streamFile({ signal }, { repositoryId: selected.copy.repositoryId, manifest: selected.snapshot.manifest, masterKey: selected.opened.masterKey, path: selected.file.path });
        for await (const chunk of stream) {
          if (signal.aborted) throw new SqliteRestoreError('SQLITE_RESTORE_CANCELED', 'The SQLite recovery was canceled.', { category: 'canceled' });
          progress.bytesWritten += Buffer.byteLength(chunk);
          yield Buffer.from(chunk);
        }
      })();
      const restored = await this.adapter.executeRestore({ signal }, plan, { async open() { return content(); } });
      progress = { ...progress, phase: 'validating', itemsCompleted: 1, updatedAt: this.clock() };
      await this.#project(workspaceId, restoreRunId, { state: 'validating', progress }, actorId);
      const validation = await this.adapter.validateRestore({}, restored);
      validationRecord = { state: validation.status, connectivity: 'pass', contentDigest: selected.expectedDigest, expectedObjects: validation.checks?.find((check) => check.id === 'expected-objects')?.status || 'unavailable', nativeIntegrityValidation: Boolean(validation.nativeIntegrityValidation), checks: validation.checks || [], completedAt: this.clock() };
      if (!validation.valid) throw new SqliteRestoreError('SQLITE_RESTORE_VALIDATION_FAILED', 'The recovered SQLite database did not pass authenticated native validation.', { category: 'integrity' });
      progress = { ...progress, phase: 'complete', updatedAt: this.clock() };
      return this.#project(workspaceId, restoreRunId, { state: 'succeeded', progress, validation: validationRecord, result: { restoredItems: 1, bytesRestored: progress.bytesWritten, targetName: path.basename(request.targetPath), warnings: [], completedAt: this.clock() } }, actorId);
    } catch (error) {
      const current = await this.controlDatabase.repository('restoreRun').get(workspaceId, restoreRunId);
      if (current && !TERMINAL_STATES.has(current.state)) {
        const canceled = signal.aborted || error?.code === 'SQLITE_RESTORE_CANCELED';
        const publicationUncertain = error?.code === 'SQLITE_RESTORE_PUBLICATION_UNCERTAIN';
        return this.#project(workspaceId, restoreRunId, { state: canceled ? 'canceled' : 'failed', progress: { ...progress, phase: canceled ? 'canceled' : publicationUncertain ? 'operator-action-required' : 'failed', updatedAt: this.clock() }, validation: validationRecord, result: { error: canceled ? { code: 'SQLITE_RESTORE_CANCELED', category: 'canceled', retryable: false, safeMessage: 'The SQLite recovery was canceled before target publication.' } : publicError(error), completedAt: this.clock() } }, actorId);
      }
      throw error;
    }
  }
}

module.exports = { RESTORE_CONFIRMATIONS, SqliteRestoreError, SqliteRestoreService, normalizeRequest };
