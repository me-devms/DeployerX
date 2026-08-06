const { ADAPTER_ID, RESTORE_CONFIRMATION } = require('./influxdb3-core');
const { objectStoreForArtifactKind } = require('./influxdb3-core-restore');

const METADATA_MODE = 'influxdb3-core-metadata';
const DRILL_MODE = 'influxdb3-core-full-drill';
const DRILL_CONFIRMATION = 'RUN INFLUXDB3 CORE RECOVERY DRILL';
const TERMINAL_STATES = new Set(['succeeded', 'warning', 'failed', 'canceled', 'interrupted']);

class InfluxDb3CoreVerificationError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'InfluxDb3CoreVerificationError';
    this.code = code;
    this.category = options.category || 'verification';
    this.retryable = Boolean(options.retryable);
  }
}

function requiredText(value, label, maximumLength = 4096) {
  const text = String(value ?? '').trim();
  if (!text || text.includes('\0') || text.length > maximumLength) throw new InfluxDb3CoreVerificationError('INFLUXDB3_CORE_VERIFICATION_INPUT_INVALID', `${label} is invalid.`, { category: 'validation' });
  return text;
}

function safeError(error) {
  if (error?.code) return { code: String(error.code).slice(0, 100), category: String(error.category || 'verification').slice(0, 80), retryable: Boolean(error.retryable), safeMessage: String(error.message || 'The InfluxDB 3 Core recovery test failed.').slice(0, 500) };
  return { code: 'INFLUXDB3_CORE_VERIFICATION_FAILED', category: 'verification', retryable: false, safeMessage: 'DeployerX could not complete the InfluxDB 3 Core recovery test.' };
}

function assertRestorableArtifact(selected) {
  const metadata = selected?.metadata;
  const artifactMetadata = selected?.artifact?.metadata;
  const objectStore = objectStoreForArtifactKind(metadata?.kind);
  if (!objectStore || objectStore !== metadata?.source?.objectStore || artifactMetadata?.kind !== metadata.kind || artifactMetadata?.source?.objectStore !== objectStore || metadata?.artifact?.restoreSupported !== true || artifactMetadata?.artifact?.restoreSupported !== true) throw new InfluxDb3CoreVerificationError('INFLUXDB3_CORE_VERIFICATION_RESTORE_UNSUPPORTED', 'The authenticated InfluxDB 3 Core Artifact is not approved for recovery validation or a full drill.', { category: 'compatibility' });
}

class InfluxDb3CoreRecoveryTestService {
  constructor({ controlDatabase, adapter, connectionService, restoreService, deviceId, notificationService = null, clock = () => new Date().toISOString() } = {}) {
    if (!controlDatabase || !adapter || !connectionService || !restoreService) throw new TypeError('InfluxDB 3 Core recovery-test dependencies are required.');
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
    if (![METADATA_MODE, DRILL_MODE].includes(mode)) throw new InfluxDb3CoreVerificationError('INFLUXDB3_CORE_VERIFICATION_MODE_INVALID', 'Choose InfluxDB 3 Core metadata validation or a full stopped-target drill.', { category: 'validation' });
    if (mode === DRILL_MODE && (input.confirmed !== true || String(input.confirmationText || '').trim() !== DRILL_CONFIRMATION)) throw new InfluxDb3CoreVerificationError('INFLUXDB3_CORE_DRILL_CONFIRMATION_REQUIRED', 'Confirm the full stopped-target InfluxDB 3 Core recovery drill before continuing.', { category: 'conflict' });
    const selected = await this.restoreService.authenticateRecoveryPoint(tenant, requiredText(input.recoveryPointId, 'RecoveryPoint ID', 200));
    assertRestorableArtifact(selected);
    const now = this.clock();
    const record = await this.controlDatabase.repository('verificationRun').create({
      workspaceId: tenant,
      actorId: actor,
      scopeType: 'recovery-point',
      scopeId: selected.point.id,
      recoveryPointId: selected.point.id,
      recoveryPointIds: [selected.point.id],
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
    if (!record || ![METADATA_MODE, DRILL_MODE].includes(record.mode)) throw new InfluxDb3CoreVerificationError('INFLUXDB3_CORE_VERIFICATION_NOT_FOUND', 'The InfluxDB 3 Core recovery test was not found.', { category: 'not-found' });
    return record;
  }

  async cancel(workspaceId, actorId, verificationRunId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const id = requiredText(verificationRunId, 'Verification run ID', 200);
    const record = await this.controlDatabase.repository('verificationRun').get(tenant, id);
    if (!record || ![METADATA_MODE, DRILL_MODE].includes(record.mode)) throw new InfluxDb3CoreVerificationError('INFLUXDB3_CORE_VERIFICATION_NOT_FOUND', 'The InfluxDB 3 Core recovery test was not found.', { category: 'not-found' });
    if (TERMINAL_STATES.has(record.state)) return record;
    const active = this.active.get(id);
    if (!active) throw new InfluxDb3CoreVerificationError('INFLUXDB3_CORE_VERIFICATION_NOT_ACTIVE', 'The InfluxDB 3 Core recovery test is not active in this process.', { category: 'conflict' });
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
      const drill = record.mode === DRILL_MODE;
      const restore = record.restoreRunId ? await this.controlDatabase.repository('restoreRun').get(tenant, record.restoreRunId) : null;
      const targetPreserved = drill && (restore?.target?.targetMutationStarted === true || restore?.target?.filesystemMutationStarted === true || restore?.result?.targetPreserved === true);
      projected.push(await this.#project(tenant, record.id, {
        state: 'interrupted',
        progress: { ...(record.progress || {}), phase: targetPreserved ? 'operator-action-required' : 'interrupted', updatedAt: this.clock() },
        result: {
          state: 'interrupted',
          targetPreserved,
          cleanupPerformed: false,
          rollbackPerformed: false,
          error: { code: 'INFLUXDB3_CORE_VERIFICATION_PROCESS_INTERRUPTED', category: 'verification', retryable: false, safeMessage: targetPreserved ? 'The InfluxDB 3 Core recovery drill was interrupted; inspect the stopped alternate target. No rollback or target cleanup is claimed.' : drill ? 'The InfluxDB 3 Core recovery drill was interrupted before target preservation was proven.' : 'InfluxDB 3 Core metadata validation was interrupted.' },
          completedAt: null
        }
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
    const source = selected.source;
    const execution = source?.physicalExecution;
    const connection = await this.controlDatabase.repository('connection').get(workspaceId, source?.connectionId);
    const identity = connection?.lastTest?.endpointIdentity;
    const metadata = selected.metadata;
    const identityStore = identity?.objectStore; const executionStore = execution?.objectStore; const endpointStore = connection?.endpoint?.objectStore; const trustStore = connection?.trust?.objectStore;
    if (!connection || connection.adapterId !== ADAPTER_ID || connection.lastTest?.status !== 'success'
      || !(connection.workerAffinity || []).includes(`device:${this.deviceId}`)
      || objectStoreForArtifactKind(metadata.kind) !== executionStore
      || endpointStore !== executionStore
      || trustStore !== executionStore
      || connection.trust?.fingerprint !== execution?.deploymentFingerprint
      || connection.trust?.storageFingerprint !== execution?.storageFingerprint
      || connection.endpoint?.expectedVersion !== metadata.source?.productVersion
      || connection.endpoint?.expectedDeploymentFingerprint !== execution?.deploymentFingerprint
      || connection.endpoint?.expectedStorageFingerprint !== execution?.storageFingerprint
      || identity?.version !== metadata.source?.productVersion
      || identity?.nodeId !== metadata.source?.nodeId
      || identity?.nodeId !== connection.endpoint?.nodeId
      || identityStore !== executionStore
      || metadata.source?.objectStore !== executionStore
      || identity?.restoreSupported !== true
      || metadata.source?.deploymentFingerprint !== execution?.deploymentFingerprint
      || metadata.source?.storageFingerprint !== execution?.storageFingerprint) {
      throw new InfluxDb3CoreVerificationError('INFLUXDB3_CORE_VERIFICATION_SOURCE_CONNECTION_INVALID', 'Retest and re-save the protected InfluxDB 3 Core Source connection on this device.', { category: 'connectivity', retryable: true });
    }
    return this.connectionService.withExecution(workspaceId, connection, signal, async (context, config) => {
      const preflight = await this.adapter.preflight({ ...context, signal }, { operation: 'backup', connection: config, execution });
      if (preflight.serverVersion !== metadata.source.productVersion
        || preflight.serverIdentityFingerprint !== metadata.source.deploymentFingerprint
        || preflight.metadata?.nodeId !== metadata.source.nodeId
        || preflight.metadata?.objectStore !== metadata.source.objectStore
        || preflight.metadata?.storageFingerprint !== metadata.source.storageFingerprint
        || preflight.metadata?.consistencyMode !== metadata.capture?.consistencyMode
        || preflight.consistency?.[0]?.method !== execution.consistencyMethod
        || preflight.consistency?.[0]?.verified !== true) {
        throw new InfluxDb3CoreVerificationError('INFLUXDB3_CORE_VERIFICATION_SOURCE_CHANGED', 'The protected InfluxDB 3 Core deployment, object-store identity, version, node, or consistency proof no longer matches the authenticated RecoveryPoint.', { category: 'integrity' });
      }
      return preflight;
    });
  }

  async #execute(workspaceId, actorId, verificationRunId, input, selected, signal) {
    const startedAt = this.clock();
    try {
      await this.#project(workspaceId, verificationRunId, { state: 'running', startedAt, progress: { phase: 'authenticating-recovery-media', startedAt, updatedAt: startedAt } }, actorId);
      const media = await this.restoreService.verifyRecoveryPointMedia(selected, signal);
      const sourceProof = await this.#validateSource(workspaceId, selected, signal);
      if (String(input.mode || METADATA_MODE) === METADATA_MODE) {
        const completed = await this.#project(workspaceId, verificationRunId, {
          state: 'succeeded',
          completedAt: this.clock(),
          progress: { phase: 'complete', startedAt, updatedAt: this.clock() },
          evidence: {
            verificationClass: 'influxdb3-core-metadata-only',
            repositoryVerified: true,
            completeMediaAuthenticated: true,
            sourceIdentityVerified: true,
            storageIdentityVerified: true,
            consistencyProofVerified: true,
            productVersion: selected.metadata.source.productVersion,
            nodeId: selected.metadata.source.nodeId,
            objectStore: selected.metadata.source.objectStore,
            consistencyMode: selected.metadata.capture.consistencyMode,
            achievedConsistency: selected.metadata.capture.achievedConsistency,
            nativeFileCount: media.fileCount,
            nativeDirectoryCount: media.directoryCount,
            sizeBytes: media.totalBytes,
            mediaFingerprint: media.mediaFingerprint,
            directoryFingerprint: media.directoryFingerprint,
            endpointProof: sourceProof.metadata.consistencyMode === 'stopped' ? 'stopped-unreachable' : 'authenticated-running',
            fullRestorePerformed: false
          },
          result: { state: 'succeeded', mode: METADATA_MODE, recoveryPointId: selected.point.id, completedAt: this.clock() }
        }, actorId);
        await this.#notify(workspaceId, completed);
        return completed;
      }
      await this.#project(workspaceId, verificationRunId, { progress: { phase: 'restoring-stopped-alternate-target', startedAt, updatedAt: this.clock() } }, actorId);
      const startedRestore = await this.restoreService.start(workspaceId, actorId, { recoveryPointId: selected.point.id, targetConnectionId: requiredText(input.targetConnectionId, 'InfluxDB 3 Core drill target connection ID', 200), mode: 'alternate', confirmed: true, confirmationText: RESTORE_CONFIRMATION });
      const active = this.active.get(verificationRunId);
      if (active) active.restoreRunId = startedRestore.id;
      await this.#project(workspaceId, verificationRunId, { restoreRunId: startedRestore.id }, actorId);
      const restored = await this.restoreService.wait(workspaceId, startedRestore.id);
      if (restored.state !== 'succeeded' || restored.validation?.nativeIntegrityValidation !== true || restored.result?.targetStopped !== true || (restored.result?.operatorReviewRequired !== true && restored.result?.ownershipReviewRequired !== true)) throw new InfluxDb3CoreVerificationError('INFLUXDB3_CORE_DRILL_RESTORE_FAILED', 'The full InfluxDB 3 Core recovery drill did not pass stopped-target validation.', { category: 'integrity' });
      const completed = await this.#project(workspaceId, verificationRunId, {
        state: 'succeeded',
        completedAt: this.clock(),
        progress: { phase: 'complete', startedAt, updatedAt: this.clock() },
        evidence: {
          verificationClass: 'influxdb3-core-full-restore-drill',
          repositoryVerified: true,
          completeMediaAuthenticated: true,
          sourceIdentityVerified: true,
          consistencyProofVerified: true,
          fullRestorePerformed: true,
          nativeIntegrityValidation: true,
          nodeId: restored.result.nodeId,
          objectStore: restored.result.objectStore,
          nativeFileCount: media.fileCount,
          nativeDirectoryCount: media.directoryCount,
          sizeBytes: media.totalBytes,
          targetPreserved: true,
          targetStopped: true,
          ownershipReviewRequired: restored.result.ownershipReviewRequired === true,
          operatorReviewRequired: true,
          automaticStartup: false,
          cleanupPerformed: false,
          rollbackPerformed: false
        },
        result: { state: 'succeeded', mode: DRILL_MODE, recoveryPointId: selected.point.id, restoreRunId: restored.id, objectStore: restored.result.objectStore, targetPreserved: true, targetStopped: true, ownershipReviewRequired: restored.result.ownershipReviewRequired === true, operatorReviewRequired: true, automaticStartup: false, cleanupPerformed: false, rollbackPerformed: false, completedAt: this.clock() }
      }, actorId);
      await this.#notify(workspaceId, completed);
      return completed;
    } catch (error) {
      const current = await this.controlDatabase.repository('verificationRun').get(workspaceId, verificationRunId);
      if (current && !TERMINAL_STATES.has(current.state)) {
        const canceled = signal.aborted || error?.category === 'canceled';
        const drillStarted = current.mode === DRILL_MODE && Boolean(current.restoreRunId);
        const failed = await this.#project(workspaceId, verificationRunId, {
          state: canceled ? 'canceled' : 'failed',
          completedAt: this.clock(),
          progress: { ...(current.progress || {}), phase: canceled ? 'canceled' : 'failed', updatedAt: this.clock() },
          result: { state: canceled ? 'canceled' : 'failed', targetPreserved: drillStarted, cleanupPerformed: false, rollbackPerformed: false, error: safeError(error), completedAt: this.clock() }
        }, actorId);
        await this.#notify(workspaceId, failed);
        return failed;
      }
      throw error;
    }
  }
}

module.exports = { DRILL_CONFIRMATION, DRILL_MODE, METADATA_MODE, InfluxDb3CoreRecoveryTestService, InfluxDb3CoreVerificationError };
