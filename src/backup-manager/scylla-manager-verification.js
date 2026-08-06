const { ADAPTER_ID, stableDigest } = require('./scylla-manager');
const { RESTORE_CONFIRMATION, connectionContext, loadRecoveryMetadata } = require('./scylla-manager-restore');

const METADATA_MODE = 'scylla-manager-metadata';
const DRILL_MODE = 'scylla-manager-full-drill';
const DRILL_CONFIRMATION = 'RUN SCYLLA MANAGER RECOVERY DRILL';
const TERMINAL_STATES = new Set(['succeeded', 'warning', 'failed', 'canceled', 'interrupted']);
const SUCCESS_RUN_STATES = new Set(['done', 'success', 'succeeded']);

class ScyllaManagerVerificationError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'ScyllaManagerVerificationError';
    this.code = code;
    this.category = options.category || 'verification';
    this.retryable = Boolean(options.retryable);
  }
}

function requiredText(value, label, maximumLength = 4096) {
  const text = String(value ?? '').trim();
  if (!text || text.includes('\0') || text.length > maximumLength) throw new ScyllaManagerVerificationError('SCYLLA_MANAGER_VERIFICATION_INPUT_INVALID', `${label} is invalid.`, { category: 'validation' });
  return text;
}

function safeError(error) {
  if (error?.code) return { code: String(error.code).slice(0, 100), category: String(error.category || 'verification').slice(0, 50), retryable: Boolean(error.retryable), safeMessage: String(error.message || 'The Manager recovery test failed.').slice(0, 500) };
  return { code: 'SCYLLA_MANAGER_VERIFICATION_FAILED', category: 'verification', retryable: false, safeMessage: 'DeployerX could not complete the ScyllaDB Manager recovery test.' };
}

function exactCatalog(metadata, catalogs) {
  const catalog = catalogs.find((item) => item.clusterId === metadata.managedClusterId && item.taskId === metadata.taskId && item.snapshots.some((snapshot) => snapshot.snapshotTag === metadata.snapshotTag));
  if (!catalog || stableDigest(catalog) !== stableDigest(metadata.catalog)) throw new ScyllaManagerVerificationError('SCYLLA_MANAGER_VERIFICATION_CATALOG_CHANGED', 'Manager no longer reports the exact authenticated backup catalog evidence.', { category: 'integrity' });
  return catalog;
}

class ScyllaManagerRecoveryTestService {
  constructor({ controlDatabase, secretStore, snapshotBrowser, adapter, restoreService, deviceId, notificationService = null, clock = () => new Date().toISOString() } = {}) {
    if (!controlDatabase || !secretStore || !snapshotBrowser || !adapter || !restoreService) throw new TypeError('ScyllaDB Manager recovery-test dependencies are required.');
    this.controlDatabase = controlDatabase;
    this.secretStore = secretStore;
    this.snapshotBrowser = snapshotBrowser;
    this.adapter = adapter;
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
    if (![METADATA_MODE, DRILL_MODE].includes(mode)) throw new ScyllaManagerVerificationError('SCYLLA_MANAGER_VERIFICATION_MODE_INVALID', 'Choose Manager metadata validation or a full alternate-cluster drill.', { category: 'validation' });
    if (mode === DRILL_MODE && (input.confirmed !== true || String(input.confirmationText || '').trim() !== DRILL_CONFIRMATION)) throw new ScyllaManagerVerificationError('SCYLLA_MANAGER_DRILL_CONFIRMATION_REQUIRED', 'Confirm the full alternate-cluster Manager recovery drill before continuing.', { category: 'conflict' });
    const selected = await loadRecoveryMetadata(this.controlDatabase, this.snapshotBrowser, tenant, requiredText(input.recoveryPointId, 'Recovery point ID', 200));
    const now = this.clock();
    const record = await this.controlDatabase.repository('verificationRun').create({
      workspaceId: tenant, actorId: actor, scopeType: 'recovery-point', scopeId: selected.point.id, recoveryPointId: selected.point.id,
      repositoryId: selected.opened.copy.repositoryId, mode, targetConnectionId: input.targetConnectionId || null,
      workerId: `device:${this.deviceId}`, state: 'queued', progress: { phase: 'queued', startedAt: null, updatedAt: now }, result: null
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
    if (!record || ![METADATA_MODE, DRILL_MODE].includes(record.mode)) throw new ScyllaManagerVerificationError('SCYLLA_MANAGER_VERIFICATION_NOT_FOUND', 'The Manager recovery test was not found.', { category: 'not-found' });
    return record;
  }

  async cancel(workspaceId, actorId, verificationRunId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const id = requiredText(verificationRunId, 'Verification run ID', 200);
    const record = await this.controlDatabase.repository('verificationRun').get(tenant, id);
    if (!record || ![METADATA_MODE, DRILL_MODE].includes(record.mode)) throw new ScyllaManagerVerificationError('SCYLLA_MANAGER_VERIFICATION_NOT_FOUND', 'The Manager recovery test was not found.', { category: 'not-found' });
    if (TERMINAL_STATES.has(record.state)) return record;
    const active = this.active.get(id);
    if (!active) throw new ScyllaManagerVerificationError('SCYLLA_MANAGER_VERIFICATION_NOT_ACTIVE', 'The Manager recovery test is not active in this process.', { category: 'conflict' });
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
        state: 'interrupted', progress: { ...(record.progress || {}), phase: 'operator-action-required', updatedAt: this.clock() },
        result: { state: 'interrupted', targetPreserved: record.mode === DRILL_MODE, cleanupPerformed: false, rollbackPerformed: false, error: { code: 'SCYLLA_MANAGER_VERIFICATION_PROCESS_INTERRUPTED', category: 'verification', retryable: false, safeMessage: record.mode === DRILL_MODE ? 'The Manager recovery drill was interrupted; inspect the alternate cluster and its owned restore tasks.' : 'Manager metadata validation was interrupted.' }, completedAt: null }
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

  async #validateMetadata(workspaceId, selected, signal) {
    const target = await connectionContext(this.controlDatabase, this.secretStore, this.adapter, this.deviceId, workspaceId, selected.source.connectionId);
    const context = { ...target.context, signal };
    const environment = await this.adapter.readEnvironment(context, target.config);
    const metadata = selected.metadata;
    if (!environment.status.healthy || environment.cluster.id !== metadata.managedClusterId || environment.deploymentFingerprint !== metadata.deploymentFingerprint || environment.cluster.clusterFingerprint !== metadata.clusterFingerprint || environment.status.topologyFingerprint !== metadata.topologyFingerprint) throw new ScyllaManagerVerificationError('SCYLLA_MANAGER_VERIFICATION_CLUSTER_CHANGED', 'The source managed-cluster identity or topology no longer matches the authenticated recovery point.', { category: 'integrity' });
    const task = await this.adapter.getTask(context, { connection: target.config, type: 'backup', taskId: metadata.taskId });
    if (task.labels['deployerx.owner'] !== 'deployerx' || task.labels['deployerx.operation'] !== 'backup' || task.labels['deployerx.source'] !== selected.source.id || !task.labels['deployerx.execution']) throw new ScyllaManagerVerificationError('SCYLLA_MANAGER_VERIFICATION_TASK_NOT_OWNED', 'The exact Manager backup task is no longer provably owned by this Source.', { category: 'authorization' });
    const owner = { adapterId: ADAPTER_ID, managedClusterId: metadata.managedClusterId, type: 'backup', execution: task.labels['deployerx.execution'], sourceId: selected.source.id, taskId: metadata.taskId, runId: metadata.runId };
    const history = await this.adapter.taskHistory(context, { connection: target.config, type: 'backup', taskId: metadata.taskId, owner, limit: 100 });
    const run = history.find((item) => item.id === metadata.runId);
    if (!run || !SUCCESS_RUN_STATES.has(run.status)) throw new ScyllaManagerVerificationError('SCYLLA_MANAGER_VERIFICATION_RUN_MISSING', 'Manager no longer reports the exact successful backup run.', { category: 'integrity' });
    const current = await this.adapter.taskProgress(context, { connection: target.config, type: 'backup', taskId: metadata.taskId, runId: metadata.runId, owner });
    if (current.progress.snapshotTag !== metadata.snapshotTag || current.progress.failed !== 0 || current.progress.uploaded + current.progress.skipped < current.progress.size || stableDigest(current.progress) !== stableDigest(metadata.progress)) throw new ScyllaManagerVerificationError('SCYLLA_MANAGER_VERIFICATION_PROGRESS_CHANGED', 'Manager progress no longer matches the authenticated snapshot, size, retention, and transfer evidence.', { category: 'integrity' });
    const catalogs = await this.adapter.listBackups(context, { connection: target.config, locations: metadata.target.locations.map((item) => item.location), sourceClusterId: metadata.managedClusterId, keyspaces: metadata.target.units.map((unit) => unit.keyspace) });
    const catalog = exactCatalog(metadata, catalogs);
    return { environment, task, run, progress: current.progress, catalog };
  }

  async #execute(workspaceId, actorId, verificationRunId, input, selected, signal) {
    try {
      const startedAt = this.clock();
      await this.#project(workspaceId, verificationRunId, { state: 'running', startedAt, progress: { phase: 'authenticating-manager-evidence', startedAt, updatedAt: startedAt } }, actorId);
      if (signal.aborted) throw new ScyllaManagerVerificationError('SCYLLA_MANAGER_VERIFICATION_CANCELED', 'The Manager recovery test was canceled.', { category: 'canceled' });
      if (String(input.mode || METADATA_MODE) === METADATA_MODE) {
        const checked = await this.#validateMetadata(workspaceId, selected, signal);
        const completed = await this.#project(workspaceId, verificationRunId, {
          state: 'succeeded', completedAt: this.clock(), progress: { phase: 'complete', startedAt, updatedAt: this.clock() },
          evidence: { verificationClass: 'manager-metadata-only', repositoryVerified: true, exactTaskOwnership: true, exactRun: true, exactSnapshot: true, exactCatalog: true, clusterHealthy: true, taskId: checked.task.id, runId: checked.run.id, snapshotTag: checked.progress.snapshotTag, locations: selected.metadata.target.locations, retentionDays: checked.progress.retentionDays, retentionLockMode: checked.progress.retentionLockMode, sizeBytes: checked.progress.size, fullRestorePerformed: false },
          result: { state: 'succeeded', mode: METADATA_MODE, recoveryPointId: selected.point.id, completedAt: this.clock() }
        }, actorId);
        await this.#notify(workspaceId, completed);
        return completed;
      }
      await this.#project(workspaceId, verificationRunId, { progress: { phase: 'restoring-alternate-cluster', startedAt, updatedAt: this.clock() } }, actorId);
      const startedRestore = await this.restoreService.start(workspaceId, actorId, { recoveryPointId: selected.point.id, targetConnectionId: requiredText(input.targetConnectionId, 'Manager drill target connection ID', 200), selectedTables: input.selectedTables, dataCenterMapping: input.dataCenterMapping, rateLimit: input.rateLimit, parallel: input.parallel, transfers: input.transfers, confirmed: true, confirmationText: RESTORE_CONFIRMATION });
      const active = this.active.get(verificationRunId);
      if (active) active.restoreRunId = startedRestore.id;
      await this.#project(workspaceId, verificationRunId, { restoreRunId: startedRestore.id }, actorId);
      const restored = await this.restoreService.wait(workspaceId, startedRestore.id);
      if (restored.state !== 'succeeded' || restored.validation?.nativeIntegrityValidation !== true || restored.result?.originalClusterModified !== false || restored.result?.sourceMediaDeleted !== false || restored.result?.rollbackPerformed !== false) throw new ScyllaManagerVerificationError('SCYLLA_MANAGER_DRILL_RESTORE_FAILED', 'The full Manager recovery drill did not pass alternate-cluster native validation.', { category: 'integrity' });
      const completed = await this.#project(workspaceId, verificationRunId, {
        state: 'succeeded', completedAt: this.clock(), progress: { phase: 'complete', startedAt, updatedAt: this.clock() },
        evidence: { verificationClass: 'manager-full-restore-drill', fullRestorePerformed: true, nativeIntegrityValidation: true, schemaPhase: restored.validation.schemaPhase, tablePhase: restored.validation.tablePhase, clusterHealth: restored.validation.clusterHealth, targetManagedClusterId: restored.result.targetManagedClusterId, snapshotTag: restored.result.snapshotTag, ownedTasks: restored.target?.ownedTasks || [], targetPreserved: true, cleanupPerformed: false, rollbackPerformed: false, sourceMediaDeleted: false, originalClusterModified: false },
        result: { state: 'succeeded', mode: DRILL_MODE, recoveryPointId: selected.point.id, restoreRunId: restored.id, targetPreserved: true, cleanupPerformed: false, completedAt: this.clock() }
      }, actorId);
      await this.#notify(workspaceId, completed);
      return completed;
    } catch (error) {
      const current = await this.controlDatabase.repository('verificationRun').get(workspaceId, verificationRunId);
      if (current && !TERMINAL_STATES.has(current.state)) {
        const canceled = signal.aborted || error?.category === 'canceled';
        const failed = await this.#project(workspaceId, verificationRunId, { state: canceled ? 'canceled' : 'failed', completedAt: this.clock(), progress: { ...(current.progress || {}), phase: canceled ? 'canceled' : 'failed', updatedAt: this.clock() }, result: { state: canceled ? 'canceled' : 'failed', targetPreserved: current.mode === DRILL_MODE, cleanupPerformed: false, rollbackPerformed: false, error: safeError(error), completedAt: this.clock() } }, actorId);
        await this.#notify(workspaceId, failed);
        return failed;
      }
      throw error;
    }
  }
}

module.exports = { DRILL_CONFIRMATION, DRILL_MODE, METADATA_MODE, ScyllaManagerRecoveryTestService, ScyllaManagerVerificationError, exactCatalog };
