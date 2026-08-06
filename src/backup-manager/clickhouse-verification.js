const { ADAPTER_ID } = require('./clickhouse');
const { RESTORE_CONFIRMATION } = require('./clickhouse-restore');

const METADATA_MODE = 'clickhouse-metadata';
const DRILL_MODE = 'clickhouse-full-drill';
const DRILL_CONFIRMATION = 'RUN CLICKHOUSE RECOVERY DRILL';
const TERMINAL_STATES = new Set(['succeeded', 'warning', 'failed', 'canceled', 'interrupted']);

class ClickHouseVerificationError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'ClickHouseVerificationError';
    this.code = code;
    this.category = options.category || 'verification';
    this.retryable = Boolean(options.retryable);
  }
}

function requiredText(value, label, maximumLength = 4096) {
  const text = String(value ?? '').trim();
  if (!text || text.includes('\0') || text.length > maximumLength) throw new ClickHouseVerificationError('CLICKHOUSE_VERIFICATION_INPUT_INVALID', `${label} is invalid.`, { category: 'validation' });
  return text;
}

function safeError(error) {
  if (error?.code) return { code: String(error.code).slice(0, 100), category: String(error.category || 'verification').slice(0, 80), retryable: Boolean(error.retryable), safeMessage: String(error.message || 'The ClickHouse recovery test failed.').slice(0, 500) };
  return { code: 'CLICKHOUSE_VERIFICATION_FAILED', category: 'verification', retryable: false, safeMessage: 'DeployerX could not complete the ClickHouse recovery test.' };
}

class ClickHouseRecoveryTestService {
  constructor({ controlDatabase, adapter, connectionService, restoreService, deviceId, notificationService = null, clock = () => new Date().toISOString() } = {}) {
    if (!controlDatabase || !adapter || !connectionService || !restoreService) throw new TypeError('ClickHouse recovery-test dependencies are required.');
    this.controlDatabase = controlDatabase;
    this.adapter = adapter;
    this.connectionService = connectionService;
    this.restoreService = restoreService;
    this.deviceId = requiredText(deviceId, 'Device ID', 200);
    this.notificationService = notificationService;
    this.clock = clock;
    this.active = new Map();
  }

  async start(workspaceId, actorId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const mode = String(input.mode || METADATA_MODE);
    if (![METADATA_MODE, DRILL_MODE].includes(mode)) throw new ClickHouseVerificationError('CLICKHOUSE_VERIFICATION_MODE_INVALID', 'Choose ClickHouse metadata validation or a full alternate-target drill.', { category: 'validation' });
    if (mode === DRILL_MODE && (input.confirmed !== true || String(input.confirmationText || '').trim() !== DRILL_CONFIRMATION)) throw new ClickHouseVerificationError('CLICKHOUSE_DRILL_CONFIRMATION_REQUIRED', 'Confirm the full alternate-target ClickHouse recovery drill before continuing.', { category: 'conflict' });
    const selected = await this.restoreService.authenticateRecoveryPoint(tenant, requiredText(input.recoveryPointId, 'RecoveryPoint ID', 200));
    const now = this.clock();
    const record = await this.controlDatabase.repository('verificationRun').create({
      workspaceId: tenant,
      actorId: actor,
      scopeType: 'recovery-point',
      scopeId: selected.point.id,
      recoveryPointId: selected.point.id,
      recoveryPointIds: selected.entries.map((entry) => entry.point.id),
      repositoryId: selected.repositoryId,
      mode,
      targetConnectionId: input.targetConnectionId || null,
      workerId: `device:${this.deviceId}`,
      state: 'queued',
      progress: { phase: 'queued', startedAt: null, updatedAt: now },
      result: null
    });
    const controller = new AbortController();
    const operation = this.#execute(tenant, actor, record.id, input, selected, controller.signal).catch(() => this.controlDatabase.repository('verificationRun').get(tenant, record.id));
    this.active.set(record.id, { operation, controller, restoreRunId: null });
    operation.finally(() => this.active.delete(record.id));
    return record;
  }

  async wait(workspaceId, verificationRunId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const id = requiredText(verificationRunId, 'Verification run ID', 200);
    if (this.active.has(id)) await this.active.get(id).operation;
    const record = await this.controlDatabase.repository('verificationRun').get(tenant, id);
    if (!record || ![METADATA_MODE, DRILL_MODE].includes(record.mode)) throw new ClickHouseVerificationError('CLICKHOUSE_VERIFICATION_NOT_FOUND', 'The ClickHouse recovery test was not found.', { category: 'not-found' });
    return record;
  }

  async cancel(workspaceId, actorId, verificationRunId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const id = requiredText(verificationRunId, 'Verification run ID', 200);
    const record = await this.controlDatabase.repository('verificationRun').get(tenant, id);
    if (!record || ![METADATA_MODE, DRILL_MODE].includes(record.mode)) throw new ClickHouseVerificationError('CLICKHOUSE_VERIFICATION_NOT_FOUND', 'The ClickHouse recovery test was not found.', { category: 'not-found' });
    if (TERMINAL_STATES.has(record.state)) return record;
    const active = this.active.get(id);
    if (!active) throw new ClickHouseVerificationError('CLICKHOUSE_VERIFICATION_NOT_ACTIVE', 'The ClickHouse recovery test is not active in this process.', { category: 'conflict' });
    active.controller.abort();
    if (active.restoreRunId) await this.restoreService.cancel(tenant, actor, active.restoreRunId).catch(() => {});
    await active.operation;
    return this.controlDatabase.repository('verificationRun').get(tenant, id);
  }

  async list(workspaceId, options = {}) {
    const records = await this.controlDatabase.repository('verificationRun').list(requiredText(workspaceId, 'Workspace ID', 200), { limit: Math.min(200, Math.max(1, Number(options.limit) || 50)) });
    return records.filter((record) => [METADATA_MODE, DRILL_MODE].includes(record.mode));
  }

  async reconcile(workspaceId, actorId = 'system') {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const projected = [];
    for (const record of (await this.list(tenant, { limit: 200 })).filter((item) => !TERMINAL_STATES.has(item.state) && !this.active.has(item.id))) {
      projected.push(await this.#project(tenant, record.id, {
        state: 'interrupted',
        progress: { ...(record.progress || {}), phase: record.mode === DRILL_MODE ? 'operator-action-required' : 'interrupted', updatedAt: this.clock() },
        result: { state: 'interrupted', targetPreserved: record.mode === DRILL_MODE, cleanupPerformed: false, rollbackPerformed: false, error: { code: 'CLICKHOUSE_VERIFICATION_PROCESS_INTERRUPTED', category: 'verification', retryable: false, safeMessage: record.mode === DRILL_MODE ? 'The ClickHouse recovery drill was interrupted; inspect the alternate database and its native restore operation. No rollback is claimed.' : 'ClickHouse metadata validation was interrupted.' }, completedAt: null }
      }, actorId));
    }
    return projected;
  }

  async #project(workspaceId, id, changes, actorId) {
    return this.controlDatabase.transaction((transaction) => {
      const current = transaction.get('verificationRun', workspaceId, id);
      return transaction.projectExecution('verificationRun', workspaceId, id, changes, { expectedRevision: current.revision, actorId });
    });
  }

  async #notify(workspaceId, run) {
    if (this.notificationService && ['succeeded', 'warning', 'failed', 'interrupted'].includes(run?.state)) await this.notificationService.notifyVerificationRun(workspaceId, run).catch(() => {});
  }

  async #validateSource(workspaceId, selected, signal) {
    const connection = await this.controlDatabase.repository('connection').get(workspaceId, selected.source.connectionId);
    if (!connection || connection.adapterId !== ADAPTER_ID || connection.lastTest?.status !== 'success' || !connection.trust?.fingerprint || !(connection.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new ClickHouseVerificationError('CLICKHOUSE_VERIFICATION_SOURCE_CONNECTION_INVALID', 'Retest the protected ClickHouse Source connection on this device.', { category: 'connectivity', retryable: true });
    return this.connectionService.withExecution(workspaceId, connection, signal, async (context, config) => {
      const tested = await this.adapter.testConnection({ ...context, signal }, config);
      if (tested.status !== 'success') throw new ClickHouseVerificationError('CLICKHOUSE_VERIFICATION_SOURCE_UNHEALTHY', tested.error?.safeMessage || 'The protected ClickHouse Source is unavailable.', { category: tested.error?.category || 'connectivity', retryable: Boolean(tested.error?.retryable) });
      const pages = [];
      for await (const page of this.adapter.discover({ ...context, signal }, { connection: config, kind: 'all' })) pages.push(page);
      const inventory = pages[0];
      const metadata = selected.metadata;
      const expectedTables = metadata.selection?.tables || [];
      const database = inventory?.databases?.find((item) => item.name === metadata.selection?.database?.name && item.uuid === metadata.selection?.database?.uuid && item.engine === metadata.selection?.database?.engine);
      const tablesMatch = expectedTables.length > 0 && expectedTables.every((expected) => inventory?.tables?.some((item) => item.database === expected.database && item.name === expected.name && item.uuid === expected.uuid && item.engine === expected.engine));
      const destinationTrust = connection.clickhouseDestinationTrust;
      if (pages.length !== 1 || tested.endpointIdentity?.deploymentFingerprint !== metadata.deploymentFingerprint || tested.endpointIdentity?.topologyFingerprint !== metadata.topologyFingerprint
        || inventory.deploymentFingerprint !== metadata.deploymentFingerprint || inventory.topologyFingerprint !== metadata.topologyFingerprint || inventory.version?.text !== metadata.productVersion || !database || !tablesMatch
        || destinationTrust?.diskName !== metadata.destination?.diskName || destinationTrust?.destinationFingerprint !== metadata.destination?.destinationFingerprint
        || destinationTrust?.deploymentFingerprint !== metadata.deploymentFingerprint || destinationTrust?.topologyFingerprint !== metadata.topologyFingerprint) throw new ClickHouseVerificationError('CLICKHOUSE_VERIFICATION_SOURCE_CHANGED', 'The protected ClickHouse deployment, topology, version, selected object identities, or approved backup disk no longer matches the authenticated recovery point.', { category: 'integrity' });
      return { tested, inventory, database };
    });
  }

  async #execute(workspaceId, actorId, verificationRunId, input, selected, signal) {
    const startedAt = this.clock();
    try {
      await this.#project(workspaceId, verificationRunId, { state: 'running', startedAt, progress: { phase: 'authenticating-recovery-media', startedAt, updatedAt: startedAt } }, actorId);
      if (signal.aborted) throw new ClickHouseVerificationError('CLICKHOUSE_VERIFICATION_CANCELED', 'The ClickHouse recovery test was canceled.', { category: 'canceled' });
      const source = await this.#validateSource(workspaceId, selected, signal);
      if (String(input.mode || METADATA_MODE) === METADATA_MODE) {
        const rowCount = selected.metadata.selection.statistics.reduce((sum, item) => sum + item.rowCount, 0);
        const partCount = selected.metadata.selection.statistics.reduce((sum, item) => sum + item.partCount, 0);
        const completed = await this.#project(workspaceId, verificationRunId, {
          state: 'succeeded', completedAt: this.clock(), progress: { phase: 'complete', startedAt, updatedAt: this.clock() },
          evidence: {
            verificationClass: 'clickhouse-metadata-only', repositoryVerified: true, completeChainAuthenticated: true, sourceIdentityVerified: true, topologyVerified: true, selectionIdentityVerified: true, destinationIdentityVerified: true,
            productVersion: selected.metadata.productVersion, databaseName: selected.metadata.selection.database.name, databaseUuid: selected.metadata.selection.database.uuid,
            backupMode: selected.metadata.backupMode, tableCount: selected.metadata.selection.tables.length, rowCount, partCount, artifactCount: selected.entries.length,
            sizeBytes: selected.totalBytes, chainRecoveryPointIds: selected.entries.map((entry) => entry.point.id), nativeOperationId: selected.metadata.operation.id,
            discoveredTableCount: source.inventory.tables.length, fullRestorePerformed: false
          },
          result: { state: 'succeeded', mode: METADATA_MODE, recoveryPointId: selected.point.id, completedAt: this.clock() }
        }, actorId);
        await this.#notify(workspaceId, completed);
        return completed;
      }
      await this.#project(workspaceId, verificationRunId, { progress: { phase: 'restoring-alternate-database', startedAt, updatedAt: this.clock() } }, actorId);
      const startedRestore = await this.restoreService.start(workspaceId, actorId, { recoveryPointId: selected.point.id, targetConnectionId: requiredText(input.targetConnectionId, 'ClickHouse drill target connection ID', 200), targetDatabase: requiredText(input.targetDatabase, 'ClickHouse drill target database', 512), mode: 'alternate', confirmed: true, confirmationText: RESTORE_CONFIRMATION });
      const active = this.active.get(verificationRunId);
      if (active) active.restoreRunId = startedRestore.id;
      await this.#project(workspaceId, verificationRunId, { restoreRunId: startedRestore.id }, actorId);
      const restored = await this.restoreService.wait(workspaceId, startedRestore.id);
      if (restored.state !== 'succeeded' || restored.validation?.nativeIntegrityValidation !== true) throw new ClickHouseVerificationError('CLICKHOUSE_DRILL_RESTORE_FAILED', 'The full ClickHouse recovery drill did not pass native alternate-target validation.', { category: 'integrity' });
      const completed = await this.#project(workspaceId, verificationRunId, {
        state: 'succeeded', completedAt: this.clock(), progress: { phase: 'complete', startedAt, updatedAt: this.clock() },
        evidence: {
          verificationClass: 'clickhouse-full-restore-drill', repositoryVerified: true, sourceIdentityVerified: true, completeChainAuthenticated: true, fullRestorePerformed: true, nativeIntegrityValidation: true,
          targetDatabase: restored.result.targetDatabase, tableCount: restored.result.tableMappings?.length || 0, nativeOperationId: restored.result.nativeOperation?.id || null,
          chainRecoveryPointIds: restored.result.chainRecoveryPointIds, targetPreserved: true, cleanupPerformed: false, rollbackPerformed: false
        },
        result: { state: 'succeeded', mode: DRILL_MODE, recoveryPointId: selected.point.id, restoreRunId: restored.id, targetPreserved: true, cleanupPerformed: false, rollbackPerformed: false, completedAt: this.clock() }
      }, actorId);
      await this.#notify(workspaceId, completed);
      return completed;
    } catch (error) {
      const current = await this.controlDatabase.repository('verificationRun').get(workspaceId, verificationRunId);
      if (current && !TERMINAL_STATES.has(current.state)) {
        const canceled = signal.aborted || error?.category === 'canceled';
        const failed = await this.#project(workspaceId, verificationRunId, { state: canceled ? 'canceled' : 'failed', completedAt: this.clock(), progress: { ...(current.progress || {}), phase: canceled ? 'canceled' : 'failed', updatedAt: this.clock() }, result: { state: canceled ? 'canceled' : 'failed', targetPreserved: current.mode === DRILL_MODE && Boolean(current.restoreRunId), cleanupPerformed: false, rollbackPerformed: false, error: safeError(error), completedAt: this.clock() } }, actorId);
        await this.#notify(workspaceId, failed);
        return failed;
      }
      throw error;
    }
  }
}

module.exports = { DRILL_CONFIRMATION, DRILL_MODE, METADATA_MODE, ClickHouseRecoveryTestService, ClickHouseVerificationError };
