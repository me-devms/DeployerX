const { ADAPTER_ID } = require('./cockroachdb');
const { RESTORE_CONFIRMATION } = require('./cockroachdb-restore');

const METADATA_MODE = 'cockroachdb-metadata';
const DRILL_MODE = 'cockroachdb-full-drill';
const DRILL_CONFIRMATION = 'RUN COCKROACHDB RECOVERY DRILL';
const TERMINAL_STATES = new Set(['succeeded', 'warning', 'failed', 'canceled', 'interrupted']);

class CockroachDbVerificationError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'CockroachDbVerificationError';
    this.code = code;
    this.category = options.category || 'verification';
    this.retryable = Boolean(options.retryable);
  }
}

function requiredText(value, label, maximumLength = 4096) {
  const text = String(value ?? '').trim();
  if (!text || text.includes('\0') || text.length > maximumLength) throw new CockroachDbVerificationError('COCKROACH_VERIFICATION_INPUT_INVALID', `${label} is invalid.`, { category: 'validation' });
  return text;
}

function optionalTimestamp(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const date = new Date(requiredText(value, label, 100));
  if (!Number.isFinite(date.getTime())) throw new CockroachDbVerificationError('COCKROACH_VERIFICATION_INPUT_INVALID', `${label} is invalid.`, { category: 'validation' });
  return date.toISOString();
}

function assertNotCanceled(signal) {
  if (signal?.aborted) throw new CockroachDbVerificationError('COCKROACH_VERIFICATION_CANCELED', 'The CockroachDB recovery test was canceled.', { category: 'canceled' });
}

function safeError(error) {
  if (error?.code) return {
    code: String(error.code).slice(0, 100),
    category: String(error.category || 'verification').slice(0, 80),
    retryable: Boolean(error.retryable),
    safeMessage: String(error.message || 'The CockroachDB recovery test failed.').slice(0, 500)
  };
  return { code: 'COCKROACH_VERIFICATION_FAILED', category: 'verification', retryable: false, safeMessage: 'DeployerX could not complete the CockroachDB recovery test.' };
}

function destinationMatches(connection, metadata) {
  const trust = connection?.cockroachdbBackupDestinationTrust;
  return trust?.clusterId === metadata.binding.clusterId
    && trust?.deploymentFingerprint === metadata.binding.deploymentFingerprint
    && trust?.topologyFingerprint === metadata.binding.topologyFingerprint
    && trust?.inventoryFingerprint === metadata.binding.inventoryFingerprint
    && trust?.destinationFingerprint === metadata.destination.destinationFingerprint
    && trust?.localityFingerprint === metadata.destination.localityFingerprint
    && trust?.bindingCount === metadata.destination.bindingCount;
}

function selectionEvidence(metadata, discovery) {
  const scope = metadata.selection.scope;
  const databaseName = scope === 'cluster' ? null : scope === 'database' ? metadata.selection.database : metadata.selection.tables?.[0]?.database;
  const databaseVisible = scope === 'cluster' || Boolean(databaseName && discovery.databases?.some((database) => database.name === databaseName));
  if (!databaseVisible) throw new CockroachDbVerificationError('COCKROACH_VERIFICATION_SELECTION_CHANGED', 'The database protected by the authenticated CockroachDB RecoveryPoint is no longer visible on the source cluster.', { category: 'integrity' });
  return {
    scope,
    databaseVisible,
    selectedDatabaseCount: scope === 'cluster' ? discovery.databases.length : 1,
    selectedTableCount: scope === 'table' ? metadata.selection.tables.length : 0
  };
}

class CockroachDbRecoveryTestService {
  constructor({ controlDatabase, adapter, connectionService, restoreService, deviceId, notificationService = null, clock = () => new Date().toISOString() } = {}) {
    if (!controlDatabase || !adapter || !connectionService || !restoreService) throw new TypeError('CockroachDB recovery-test dependencies are required.');
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
    if (![METADATA_MODE, DRILL_MODE].includes(mode)) throw new CockroachDbVerificationError('COCKROACH_VERIFICATION_MODE_INVALID', 'Choose CockroachDB metadata validation or a full alternate-target drill.', { category: 'validation' });
    if (mode === DRILL_MODE && (input.confirmed !== true || String(input.confirmationText || '').trim() !== DRILL_CONFIRMATION)) {
      throw new CockroachDbVerificationError('COCKROACH_DRILL_CONFIRMATION_REQUIRED', 'Confirm the full alternate-target CockroachDB recovery drill before continuing.', { category: 'conflict' });
    }
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
    this.active.set(record.id, { operation, controller, restoreRunId: null, restoreCancelRequested: false });
    operation.finally(() => this.active.delete(record.id));
    return record;
  }

  async wait(workspaceId, verificationRunId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const id = requiredText(verificationRunId, 'Verification run ID', 200);
    if (this.active.has(id)) await this.active.get(id).operation;
    const record = await this.controlDatabase.repository('verificationRun').get(tenant, id);
    if (!record || ![METADATA_MODE, DRILL_MODE].includes(record.mode)) throw new CockroachDbVerificationError('COCKROACH_VERIFICATION_NOT_FOUND', 'The CockroachDB recovery test was not found.', { category: 'not-found' });
    return record;
  }

  async cancel(workspaceId, actorId, verificationRunId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const id = requiredText(verificationRunId, 'Verification run ID', 200);
    const record = await this.controlDatabase.repository('verificationRun').get(tenant, id);
    if (!record || ![METADATA_MODE, DRILL_MODE].includes(record.mode)) throw new CockroachDbVerificationError('COCKROACH_VERIFICATION_NOT_FOUND', 'The CockroachDB recovery test was not found.', { category: 'not-found' });
    if (TERMINAL_STATES.has(record.state)) return record;
    const active = this.active.get(id);
    if (!active) throw new CockroachDbVerificationError('COCKROACH_VERIFICATION_NOT_ACTIVE', 'The CockroachDB recovery test is not active in this process.', { category: 'conflict' });
    active.controller.abort();
    await this.#cancelRestore(tenant, actor, active);
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
        result: {
          state: 'interrupted',
          targetPreserved: record.mode === DRILL_MODE,
          cleanupPerformed: false,
          rollbackPerformed: false,
          error: {
            code: 'COCKROACH_VERIFICATION_PROCESS_INTERRUPTED', category: 'verification', retryable: false,
            safeMessage: record.mode === DRILL_MODE
              ? 'The CockroachDB recovery drill was interrupted; inspect the alternate database and exact native restore job. No rollback is claimed.'
              : 'CockroachDB metadata validation was interrupted.'
          },
          completedAt: null
        }
      }, actorId));
    }
    return projected;
  }

  async #project(workspaceId, id, changes, actorId) {
    return this.controlDatabase.transaction((transaction) => {
      const current = transaction.get('verificationRun', workspaceId, id);
      if (!current) throw new CockroachDbVerificationError('COCKROACH_VERIFICATION_NOT_FOUND', 'The CockroachDB recovery test was not found.', { category: 'not-found' });
      return transaction.projectExecution('verificationRun', workspaceId, id, changes, { expectedRevision: current.revision, actorId });
    });
  }

  async #notify(workspaceId, run) {
    if (this.notificationService && ['succeeded', 'warning', 'failed', 'interrupted'].includes(run?.state)) await this.notificationService.notifyVerificationRun(workspaceId, run).catch(() => {});
  }

  async #cancelRestore(workspaceId, actorId, active) {
    if (!active?.restoreRunId || active.restoreCancelRequested) return;
    active.restoreCancelRequested = true;
    await this.restoreService.cancel(workspaceId, actorId, active.restoreRunId).catch(() => {});
  }

  async #validateSource(workspaceId, selected, signal) {
    const connection = await this.controlDatabase.repository('connection').get(workspaceId, selected.source.connectionId);
    if (!connection || connection.adapterId !== ADAPTER_ID || connection.lastTest?.status !== 'success' || !(connection.workerAffinity || []).includes(`device:${this.deviceId}`)) {
      throw new CockroachDbVerificationError('COCKROACH_VERIFICATION_SOURCE_CONNECTION_INVALID', 'Retest the protected CockroachDB Source connection on this device.', { category: 'connectivity', retryable: true });
    }
    return this.connectionService.withExecution(workspaceId, connection, signal, async (context, config) => {
      const tested = await this.adapter.testConnection({ ...context, signal }, config);
      if (tested.status !== 'success') throw new CockroachDbVerificationError('COCKROACH_VERIFICATION_SOURCE_UNHEALTHY', tested.error?.safeMessage || 'The protected CockroachDB Source is unavailable.', { category: tested.error?.category || 'connectivity', retryable: Boolean(tested.error?.retryable) });
      const pages = [];
      for await (const page of this.adapter.discover({ ...context, signal }, { connection: config, kind: 'all' })) pages.push(page);
      const discovery = pages[0];
      const metadata = selected.metadata;
      if (pages.length !== 1 || tested.endpointIdentity?.clusterId !== metadata.binding.clusterId
        || tested.endpointIdentity?.deploymentFingerprint !== metadata.binding.deploymentFingerprint
        || tested.endpointIdentity?.topologyFingerprint !== metadata.binding.topologyFingerprint
        || tested.endpointIdentity?.inventoryFingerprint !== metadata.binding.inventoryFingerprint
        || discovery?.clusterId !== metadata.binding.clusterId || discovery.deploymentFingerprint !== metadata.binding.deploymentFingerprint
        || discovery.topologyFingerprint !== metadata.binding.topologyFingerprint || discovery.inventoryFingerprint !== metadata.binding.inventoryFingerprint
        || discovery.version?.text !== metadata.productVersion || discovery.clusterVersion?.text !== metadata.clusterVersion
        || discovery.capabilities?.jobsVisible !== true || discovery.capabilities?.externalConnectionsVisible !== true
        || discovery.capabilities?.systemPrivileges?.VIEWJOB !== true || discovery.capabilities?.systemPrivileges?.CONTROLJOB !== true
        || !destinationMatches(connection, metadata)) {
        throw new CockroachDbVerificationError('COCKROACH_VERIFICATION_SOURCE_CHANGED', 'The protected CockroachDB cluster, topology, version, privileges, inventory, or approved backup destination no longer matches the authenticated recovery point.', { category: 'integrity' });
      }
      return { tested, discovery, selection: selectionEvidence(metadata, discovery) };
    });
  }

  async #execute(workspaceId, actorId, verificationRunId, input, selected, signal) {
    const startedAt = this.clock();
    try {
      await this.#project(workspaceId, verificationRunId, { state: 'running', startedAt, progress: { phase: 'authenticating-recovery-media', startedAt, updatedAt: startedAt } }, actorId);
      assertNotCanceled(signal);
      const source = await this.#validateSource(workspaceId, selected, signal);
      assertNotCanceled(signal);
      if (String(input.mode || METADATA_MODE) === METADATA_MODE) {
        const metadata = selected.metadata;
        const completed = await this.#project(workspaceId, verificationRunId, {
          state: 'succeeded',
          completedAt: this.clock(),
          progress: { phase: 'complete', startedAt, updatedAt: this.clock() },
          evidence: {
            verificationClass: 'cockroachdb-metadata-only',
            repositoryVerified: true,
            completeChainAuthenticated: true,
            sourceIdentityVerified: true,
            topologyVerified: true,
            inventoryVerified: true,
            selectionMetadataAuthenticated: true,
            selectedDatabaseVisible: source.selection.databaseVisible,
            destinationIdentityVerified: true,
            productVersion: metadata.productVersion,
            clusterVersion: metadata.clusterVersion,
            clusterId: metadata.binding.clusterId,
            scope: source.selection.scope,
            selectedDatabaseCount: source.selection.selectedDatabaseCount,
            selectedTableCount: source.selection.selectedTableCount,
            backupMode: metadata.backupMode,
            revisionHistory: metadata.revisionHistory,
            asOfTimestamp: metadata.asOfTimestamp,
            artifactCount: selected.entries.length,
            chainRecoveryPointIds: selected.entries.map((entry) => entry.point.id),
            externalNativeMediaPreserved: true,
            fullRestorePerformed: false
          },
          result: { state: 'succeeded', mode: METADATA_MODE, recoveryPointId: selected.point.id, completedAt: this.clock() }
        }, actorId);
        await this.#notify(workspaceId, completed);
        return completed;
      }

      await this.#project(workspaceId, verificationRunId, { progress: { phase: 'restoring-alternate-database', startedAt, updatedAt: this.clock() } }, actorId);
      assertNotCanceled(signal);
      const restoreTimestamp = optionalTimestamp(input.restoreTimestamp, 'CockroachDB drill restore timestamp');
      const startedRestore = await this.restoreService.start(workspaceId, actorId, {
        recoveryPointId: selected.point.id,
        targetConnectionId: requiredText(input.targetConnectionId, 'CockroachDB drill target connection ID', 200),
        targetDatabase: requiredText(input.targetDatabase, 'CockroachDB drill target database', 256),
        restoreTimestamp,
        mode: 'alternate',
        confirmed: true,
        confirmationText: RESTORE_CONFIRMATION
      });
      const active = this.active.get(verificationRunId);
      if (active) active.restoreRunId = startedRestore.id;
      await this.#project(workspaceId, verificationRunId, { restoreRunId: startedRestore.id }, actorId);
      if (signal.aborted) {
        await this.#cancelRestore(workspaceId, actorId, active);
        assertNotCanceled(signal);
      }
      const restored = await this.restoreService.wait(workspaceId, startedRestore.id);
      assertNotCanceled(signal);
      if (restored.state !== 'succeeded' || restored.validation?.nativeIntegrityValidation !== true) {
        throw new CockroachDbVerificationError('COCKROACH_DRILL_RESTORE_FAILED', 'The full CockroachDB recovery drill did not pass native alternate-target validation.', { category: 'integrity' });
      }
      const completed = await this.#project(workspaceId, verificationRunId, {
        state: 'succeeded',
        completedAt: this.clock(),
        progress: { phase: 'complete', startedAt, updatedAt: this.clock() },
        evidence: {
          verificationClass: 'cockroachdb-full-restore-drill',
          repositoryVerified: true,
          sourceIdentityVerified: true,
          completeChainAuthenticated: true,
          fullRestorePerformed: true,
          nativeIntegrityValidation: true,
          targetDatabase: restored.result.targetDatabase,
          restoreTimestamp: restored.result.restoreTimestamp,
          chainRecoveryPointIds: restored.result.chainRecoveryPointIds,
          targetPreserved: true,
          cleanupPerformed: false,
          rollbackPerformed: false,
          externalNativeMediaPreserved: true
        },
        result: { state: 'succeeded', mode: DRILL_MODE, recoveryPointId: selected.point.id, restoreRunId: restored.id, targetPreserved: true, cleanupPerformed: false, rollbackPerformed: false, completedAt: this.clock() }
      }, actorId);
      await this.#notify(workspaceId, completed);
      return completed;
    } catch (error) {
      const current = await this.controlDatabase.repository('verificationRun').get(workspaceId, verificationRunId);
      if (current && !TERMINAL_STATES.has(current.state)) {
        const canceled = signal.aborted || error?.category === 'canceled';
        const failed = await this.#project(workspaceId, verificationRunId, {
          state: canceled ? 'canceled' : 'failed',
          completedAt: this.clock(),
          progress: { ...(current.progress || {}), phase: canceled ? 'canceled' : 'failed', updatedAt: this.clock() },
          result: {
            state: canceled ? 'canceled' : 'failed',
            targetPreserved: current.mode === DRILL_MODE && Boolean(current.restoreRunId),
            cleanupPerformed: false,
            rollbackPerformed: false,
            error: safeError(error),
            completedAt: this.clock()
          }
        }, actorId);
        await this.#notify(workspaceId, failed);
        return failed;
      }
      throw error;
    }
  }
}

module.exports = {
  DRILL_CONFIRMATION,
  DRILL_MODE,
  METADATA_MODE,
  CockroachDbRecoveryTestService,
  CockroachDbVerificationError,
  destinationMatches,
  selectionEvidence
};
