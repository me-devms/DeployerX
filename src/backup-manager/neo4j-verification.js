const { ADAPTER_ID } = require('./neo4j');
const { RESTORE_CONFIRMATION } = require('./neo4j-restore');

const METADATA_MODE = 'neo4j-metadata';
const DRILL_MODE = 'neo4j-full-drill';
const DRILL_CONFIRMATION = 'RUN NEO4J RECOVERY DRILL';
const TERMINAL_STATES = new Set(['succeeded', 'warning', 'failed', 'canceled', 'interrupted']);

class Neo4jVerificationError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'Neo4jVerificationError';
    this.code = code;
    this.category = options.category || 'verification';
    this.retryable = Boolean(options.retryable);
  }
}

function requiredText(value, label, maximumLength = 4096) {
  const text = String(value ?? '').trim();
  if (!text || text.includes('\0') || text.length > maximumLength) throw new Neo4jVerificationError('NEO4J_VERIFICATION_INPUT_INVALID', `${label} is invalid.`, { category: 'validation' });
  return text;
}

function safeError(error) {
  if (error?.code) return { code: String(error.code).slice(0, 100), category: String(error.category || 'verification').slice(0, 80), retryable: Boolean(error.retryable), safeMessage: String(error.message || 'The Neo4j recovery test failed.').slice(0, 500) };
  return { code: 'NEO4J_VERIFICATION_FAILED', category: 'verification', retryable: false, safeMessage: 'DeployerX could not complete the Neo4j recovery test.' };
}

class Neo4jRecoveryTestService {
  constructor({ controlDatabase, adapter, connectionService, restoreService, deviceId, notificationService = null, clock = () => new Date().toISOString() } = {}) {
    if (!controlDatabase || !adapter || !connectionService || !restoreService) throw new TypeError('Neo4j recovery-test dependencies are required.');
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
    if (![METADATA_MODE, DRILL_MODE].includes(mode)) throw new Neo4jVerificationError('NEO4J_VERIFICATION_MODE_INVALID', 'Choose Neo4j metadata validation or a full alternate-target drill.', { category: 'validation' });
    if (mode === DRILL_MODE && (input.confirmed !== true || String(input.confirmationText || '').trim() !== DRILL_CONFIRMATION)) throw new Neo4jVerificationError('NEO4J_DRILL_CONFIRMATION_REQUIRED', 'Confirm the full alternate-target Neo4j recovery drill before continuing.', { category: 'conflict' });
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
    if (!record || ![METADATA_MODE, DRILL_MODE].includes(record.mode)) throw new Neo4jVerificationError('NEO4J_VERIFICATION_NOT_FOUND', 'The Neo4j recovery test was not found.', { category: 'not-found' });
    return record;
  }

  async cancel(workspaceId, actorId, verificationRunId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const id = requiredText(verificationRunId, 'Verification run ID', 200);
    const record = await this.controlDatabase.repository('verificationRun').get(tenant, id);
    if (!record || ![METADATA_MODE, DRILL_MODE].includes(record.mode)) throw new Neo4jVerificationError('NEO4J_VERIFICATION_NOT_FOUND', 'The Neo4j recovery test was not found.', { category: 'not-found' });
    if (TERMINAL_STATES.has(record.state)) return record;
    const active = this.active.get(id);
    if (!active) throw new Neo4jVerificationError('NEO4J_VERIFICATION_NOT_ACTIVE', 'The Neo4j recovery test is not active in this process.', { category: 'conflict' });
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
        result: { state: 'interrupted', targetPreserved: record.mode === DRILL_MODE, cleanupPerformed: false, rollbackPerformed: false, error: { code: 'NEO4J_VERIFICATION_PROCESS_INTERRUPTED', category: 'verification', retryable: false, safeMessage: record.mode === DRILL_MODE ? 'The Neo4j recovery drill was interrupted; inspect the alternate database and its owned restore stage. No rollback is claimed.' : 'Neo4j metadata validation was interrupted.' }, completedAt: null }
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
    if (!connection || connection.adapterId !== ADAPTER_ID || connection.lastTest?.status !== 'success' || !connection.trust?.fingerprint || !(connection.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new Neo4jVerificationError('NEO4J_VERIFICATION_SOURCE_CONNECTION_INVALID', 'Retest the protected Neo4j Source connection on this device.', { category: 'connectivity', retryable: true });
    return this.connectionService.withExecution(workspaceId, connection, signal, async (context, config) => {
      const tested = await this.adapter.testConnection({ ...context, signal }, config);
      if (tested.status !== 'success') throw new Neo4jVerificationError('NEO4J_VERIFICATION_SOURCE_UNHEALTHY', tested.error?.safeMessage || 'The protected Neo4j Source is unavailable.', { category: tested.error?.category || 'connectivity', retryable: Boolean(tested.error?.retryable) });
      const pages = [];
      for await (const page of this.adapter.discover({ ...context, signal }, { connection: config, kind: 'all' })) pages.push(page);
      const inventory = pages[0];
      const metadata = selected.metadata;
      const database = inventory?.databases?.find((item) => item.name === metadata.database.name && item.databaseId === metadata.database.databaseId);
      if (pages.length !== 1 || tested.endpointIdentity?.deploymentFingerprint !== metadata.source?.deploymentFingerprint || tested.endpointIdentity?.topologyFingerprint !== metadata.source?.topologyFingerprint
        || inventory.deploymentFingerprint !== metadata.source?.deploymentFingerprint || inventory.topologyFingerprint !== metadata.source?.topologyFingerprint
        || inventory.edition !== metadata.edition || inventory.version?.text !== metadata.productVersion || !database) throw new Neo4jVerificationError('NEO4J_VERIFICATION_SOURCE_CHANGED', 'The protected Neo4j deployment, topology, version, edition, or database identity no longer matches the authenticated recovery point.', { category: 'integrity' });
      return { tested, inventory, database };
    });
  }

  async #execute(workspaceId, actorId, verificationRunId, input, selected, signal) {
    const startedAt = this.clock();
    try {
      await this.#project(workspaceId, verificationRunId, { state: 'running', startedAt, progress: { phase: 'authenticating-recovery-media', startedAt, updatedAt: startedAt } }, actorId);
      if (signal.aborted) throw new Neo4jVerificationError('NEO4J_VERIFICATION_CANCELED', 'The Neo4j recovery test was canceled.', { category: 'canceled' });
      const source = await this.#validateSource(workspaceId, selected, signal);
      if (String(input.mode || METADATA_MODE) === METADATA_MODE) {
        const completed = await this.#project(workspaceId, verificationRunId, {
          state: 'succeeded',
          completedAt: this.clock(),
          progress: { phase: 'complete', startedAt, updatedAt: this.clock() },
          evidence: {
            verificationClass: 'neo4j-metadata-only', repositoryVerified: true, completeChainAuthenticated: true,
            sourceIdentityVerified: true, topologyVerified: true, databaseIdentityVerified: true,
            edition: selected.metadata.edition, productVersion: selected.metadata.productVersion,
            databaseName: selected.metadata.database.name, databaseId: selected.metadata.database.databaseId,
            backupMode: selected.metadata.backupMode || 'full', storeFormat: selected.metadata.artifact.storeFormat,
            artifactCount: selected.entries.length, sizeBytes: selected.totalBytes,
            chainRecoveryPointIds: selected.entries.map((entry) => entry.point.id),
            serverCount: source.inventory.servers.length, fullRestorePerformed: false
          },
          result: { state: 'succeeded', mode: METADATA_MODE, recoveryPointId: selected.point.id, completedAt: this.clock() }
        }, actorId);
        await this.#notify(workspaceId, completed);
        return completed;
      }
      await this.#project(workspaceId, verificationRunId, { progress: { phase: 'restoring-alternate-database', startedAt, updatedAt: this.clock() } }, actorId);
      const startedRestore = await this.restoreService.start(workspaceId, actorId, { recoveryPointId: selected.point.id, targetConnectionId: requiredText(input.targetConnectionId, 'Neo4j drill target connection ID', 200), targetDatabase: requiredText(input.targetDatabase, 'Neo4j drill target database', 63), mode: 'alternate', confirmed: true, confirmationText: RESTORE_CONFIRMATION });
      const active = this.active.get(verificationRunId);
      if (active) active.restoreRunId = startedRestore.id;
      await this.#project(workspaceId, verificationRunId, { restoreRunId: startedRestore.id }, actorId);
      const restored = await this.restoreService.wait(workspaceId, startedRestore.id);
      if (restored.state !== 'succeeded' || restored.validation?.nativeIntegrityValidation !== true || restored.result?.serviceStarted !== false) throw new Neo4jVerificationError('NEO4J_DRILL_RESTORE_FAILED', 'The full Neo4j recovery drill did not pass native alternate-target validation.', { category: 'integrity' });
      const completed = await this.#project(workspaceId, verificationRunId, {
        state: 'succeeded', completedAt: this.clock(), progress: { phase: 'complete', startedAt, updatedAt: this.clock() },
        evidence: { verificationClass: 'neo4j-full-restore-drill', repositoryVerified: true, sourceIdentityVerified: true, completeChainAuthenticated: true, fullRestorePerformed: true, nativeIntegrityValidation: true, targetDatabase: restored.result.targetDatabase, storeFormat: restored.result.storeFormat, consistencyCheckDigest: restored.result.consistencyCheckDigest, artifactCount: restored.result.artifactCount, bytesRestored: restored.result.bytesRestored, chainRecoveryPointIds: restored.result.chainRecoveryPointIds, serviceStarted: false, targetPreserved: true, cleanupPerformed: false, rollbackPerformed: false },
        result: { state: 'succeeded', mode: DRILL_MODE, recoveryPointId: selected.point.id, restoreRunId: restored.id, targetPreserved: true, cleanupPerformed: false, completedAt: this.clock() }
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

module.exports = { DRILL_CONFIRMATION, DRILL_MODE, METADATA_MODE, Neo4jRecoveryTestService, Neo4jVerificationError };
