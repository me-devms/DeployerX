const { assertSecretRefOnlyCredentials } = require('./database-adapter');
const { ADAPTER_ID } = require('./mongodb');
const { MongoDbSnapshotError, normalizeLayout } = require('./mongodb-snapshot');

const RESTORE_CONFIRMATION = 'RESTORE MONGODB PHYSICAL EMPTY TARGET';
const TERMINAL_STATES = new Set(['succeeded', 'warning', 'failed', 'canceled']);

class MongoDbPhysicalRestoreError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'MongoDbPhysicalRestoreError';
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
  if (error instanceof MongoDbPhysicalRestoreError || error instanceof MongoDbSnapshotError || (error?.code && error?.category)) return { code: String(error.code).slice(0, 100), category: String(error.category || 'restore').slice(0, 50), retryable: Boolean(error.retryable), safeMessage: String(error.message).slice(0, 500) };
  return { code: 'MONGODB_PHYSICAL_RESTORE_FAILED', category: 'restore', retryable: false, safeMessage: 'DeployerX could not complete the MongoDB physical restore.' };
}

function normalizeRequest(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('MongoDB physical restore request must be an object.');
  if (input.confirmed !== true || String(input.confirmationText || '').trim() !== RESTORE_CONFIRMATION) throw new MongoDbPhysicalRestoreError('MONGODB_PHYSICAL_RESTORE_CONFIRMATION_REQUIRED', 'Confirm the empty-target MongoDB physical restore before continuing.', { category: 'conflict' });
  const profile = input.targetProfile && typeof input.targetProfile === 'object' && !Array.isArray(input.targetProfile) ? structuredClone(input.targetProfile) : null;
  if (!profile) throw new TypeError('MongoDB physical restore target profile is required.');
  assertSecretRefOnlyCredentials(profile, 'MongoDB physical restore target profile');
  return {
    recoveryPointId: requiredText(input.recoveryPointId, 'Recovery point ID', 200),
    targetConnectionId: requiredText(input.targetConnectionId, 'Target execution connection ID', 200),
    targetProfile: { providerId: requiredText(profile.providerId, 'Snapshot provider ID', 200), layout: normalizeLayout(profile.layout), providerConfiguration: profile.providerConfiguration && typeof profile.providerConfiguration === 'object' ? structuredClone(profile.providerConfiguration) : {}, targetIdentity: requiredText(profile.targetIdentity, 'Physical restore target identity', 500) }
  };
}

function normalizePreflight(raw, request, expectedLeaseOwner) {
  if (!raw || raw.ready !== true || raw.destinationAbsent !== true || raw.serviceStopped !== true || raw.rollbackAvailable !== true) throw new MongoDbPhysicalRestoreError('MONGODB_PHYSICAL_RESTORE_TARGET_NOT_EMPTY', 'The provider did not prove an absent destination, stopped MongoDB service, and rollback cleanup.', { category: 'conflict' });
  const layout = normalizeLayout(raw.layout);
  if (JSON.stringify(layout) !== JSON.stringify(request.targetProfile.layout)) throw new MongoDbPhysicalRestoreError('MONGODB_PHYSICAL_RESTORE_LAYOUT_MISMATCH', 'The provider returned a different restore layout.', { category: 'integrity' });
  const leaseOwner = requiredText(raw.leaseOwner, 'Provider restore lease owner', 500);
  if (leaseOwner !== expectedLeaseOwner) throw new MongoDbPhysicalRestoreError('MONGODB_PHYSICAL_RESTORE_LEASE_OWNER_MISMATCH', 'The provider returned a restore lease owned by a different execution.', { category: 'integrity' });
  return { targetIdentity: requiredText(raw.targetIdentity, 'Provider target identity', 500), leaseId: requiredText(raw.leaseId, 'Provider restore lease ID', 500), leaseOwner, destinationAbsent: true, serviceStopped: true, rollbackAvailable: true, layout };
}

class MongoDbPhysicalRestoreService {
  constructor({ controlDatabase, deviceId, providerRegistry, openRepository, clock = () => new Date().toISOString() } = {}) {
    if (!controlDatabase || !providerRegistry || typeof openRepository !== 'function') throw new TypeError('MongoDB physical restore dependencies are required.');
    this.controlDatabase = controlDatabase;
    this.deviceId = requiredText(deviceId, 'Device ID', 200);
    this.providerRegistry = providerRegistry;
    this.openRepository = openRepository;
    this.clock = clock;
    this.active = new Map();
  }

  async start(workspaceId, actorId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const request = normalizeRequest(input);
    const point = await this.controlDatabase.repository('recoveryPoint').get(tenant, request.recoveryPointId);
    if (!point || point.type !== 'full') throw new MongoDbPhysicalRestoreError('MONGODB_PHYSICAL_RECOVERY_POINT_INVALID', 'Choose a MongoDB physical full RecoveryPoint.', { category: 'validation' });
    const source = await this.controlDatabase.repository('source').get(tenant, point.sourceId);
    if (!source || source.adapterId !== ADAPTER_ID || source.consistency?.backupMethod !== 'physical') throw new MongoDbPhysicalRestoreError('MONGODB_PHYSICAL_RECOVERY_POINT_INVALID', 'The selected RecoveryPoint is not a MongoDB physical snapshot.', { category: 'validation' });
    const targetConnection = await this.controlDatabase.repository('connection').get(tenant, request.targetConnectionId);
    if (!targetConnection || !(targetConnection.workerAffinity || []).includes(`device:${this.deviceId}`) || targetConnection.lastTest?.status !== 'success') throw new MongoDbPhysicalRestoreError('MONGODB_PHYSICAL_TARGET_CONNECTION_INVALID', 'Choose a tested target execution connection on this device.', { category: 'connectivity', retryable: true });
    const providerEntry = this.providerRegistry.get(request.targetProfile.providerId);
    if (!providerEntry.manifest.supportsRestore) throw new MongoDbPhysicalRestoreError('MONGODB_PHYSICAL_RESTORE_PROVIDER_UNSUPPORTED', 'The selected snapshot provider cannot restore physical MongoDB media.', { category: 'compatibility' });
    const now = this.clock();
    const record = await this.controlDatabase.repository('restoreRun').create({
      workspaceId: tenant, actorId: actor, recoveryPointIds: [point.id], targetConnectionId: targetConnection.id,
      target: { operation: 'physical-empty-target', mode: 'empty-target', engine: 'mongodb', sourceId: source.id, connectionId: targetConnection.id, providerId: request.targetProfile.providerId, targetIdentity: request.targetProfile.targetIdentity, layout: request.targetProfile.layout },
      mode: 'empty-target', conflictPolicy: 'fail', workerId: `device:${this.deviceId}`, state: 'queued',
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
    if (!record) throw new MongoDbPhysicalRestoreError('MONGODB_PHYSICAL_RESTORE_RUN_NOT_FOUND', 'The MongoDB physical RestoreRun was not found.', { category: 'not-found' });
    return record;
  }

  async cancel(workspaceId, actorId, restoreRunId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    requiredText(actorId, 'Actor ID', 200);
    const id = requiredText(restoreRunId, 'Restore run ID', 200);
    const record = await this.controlDatabase.repository('restoreRun').get(tenant, id);
    if (!record || record.target?.operation !== 'physical-empty-target' || record.target?.engine !== 'mongodb') throw new MongoDbPhysicalRestoreError('MONGODB_PHYSICAL_RESTORE_RUN_NOT_FOUND', 'The MongoDB physical RestoreRun was not found.', { category: 'not-found' });
    if (TERMINAL_STATES.has(record.state)) return record;
    const active = this.active.get(id);
    if (!active) throw new MongoDbPhysicalRestoreError('MONGODB_PHYSICAL_RESTORE_NOT_ACTIVE', 'The MongoDB physical restore is not active in this DeployerX process.', { category: 'conflict' });
    active.controller.abort();
    await active.operation;
    return this.controlDatabase.repository('restoreRun').get(tenant, id);
  }

  async list(workspaceId, options = {}) {
    return (await this.controlDatabase.repository('restoreRun').list(requiredText(workspaceId, 'Workspace ID', 200), { limit: Math.min(200, Math.max(1, Number(options.limit) || 50)) })).filter((record) => record.target?.engine === 'mongodb' && record.target?.operation === 'physical-empty-target');
  }

  async reconcile(workspaceId, actorId = 'system') {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const records = await this.list(tenant, { limit: 200 });
    const recovered = [];
    for (const record of records.filter((item) => !TERMINAL_STATES.has(item.state) && !this.active.has(item.id))) {
      const expectedOwner = `mongodb-physical-restore:${tenant}:${record.id}`;
      const lease = record.target?.lease;
      let rollbackProven = false;
      const activeLease = lease?.state === 'active';
      if (activeLease && lease.ownerId === expectedOwner && lease.leaseId && lease.providerId && lease.targetIdentity) {
        try {
          const { provider } = this.providerRegistry.get(lease.providerId);
          await provider.rollbackRestore({ leaseId: lease.leaseId, leaseOwner: lease.ownerId, targetIdentity: lease.targetIdentity, reason: 'process-interrupted', signal: undefined });
          rollbackProven = true;
        } catch (_error) {}
      }
      const cleanupUnproven = activeLease && !rollbackProven;
      if (cleanupUnproven && record.state === 'interrupted') {
        recovered.push(record);
        continue;
      }
      recovered.push(await this.#project(tenant, record.id, {
        state: cleanupUnproven ? 'interrupted' : 'failed',
        target: { ...(record.target || {}), ...(lease ? { lease: { ...lease, state: rollbackProven ? 'rolled-back' : lease.state, reconciledAt: this.clock() } } : {}) },
        progress: { ...(record.progress || {}), phase: cleanupUnproven ? 'operator-action-required' : 'failed', updatedAt: this.clock() },
        result: { error: cleanupUnproven
          ? { code: 'MONGODB_PHYSICAL_RESTORE_LEASE_CLEANUP_UNPROVEN', category: 'consistency', retryable: false, safeMessage: 'Physical restore was interrupted and provider lease cleanup could not be proven. Inspect the target before retrying.' }
          : { code: 'MONGODB_PHYSICAL_RESTORE_INTERRUPTED', category: 'restore', retryable: false, safeMessage: rollbackProven ? 'Physical restore was interrupted and its owned provider lease was rolled back.' : 'Physical restore was interrupted before a provider lease was acquired. Inspect the target before retrying.' }, completedAt: this.clock() }
      }, actorId));
    }
    return recovered;
  }

  async #project(workspaceId, id, changes, actorId) {
    return this.controlDatabase.transaction((transaction) => {
      const current = transaction.get('restoreRun', workspaceId, id);
      return transaction.projectExecution('restoreRun', workspaceId, id, changes, { expectedRevision: current.revision, actorId });
    });
  }

  async #execute(workspaceId, actorId, restoreRunId, request, signal) {
    let progress = { phase: 'preparing', itemsTotal: 1, itemsCompleted: 0, bytesTotal: 0, bytesWritten: 0, throughputBytesPerSecond: 0, startedAt: this.clock(), updatedAt: this.clock(), warnings: [] };
    let provider = null;
    let preflight = null;
    let restored = null;
    let validationRecord = null;
    let committed = false;
    try {
      if (signal?.aborted) throw new MongoDbPhysicalRestoreError('MONGODB_PHYSICAL_RESTORE_CANCELED', 'The MongoDB physical restore was canceled.', { category: 'canceled' });
      await this.#project(workspaceId, restoreRunId, { state: 'preparing', progress }, actorId);
      const point = await this.controlDatabase.repository('recoveryPoint').get(workspaceId, request.recoveryPointId);
      const artifacts = await this.controlDatabase.repository('artifact').list(workspaceId, { limit: 1000 });
      let selected = null;
      for (const copy of (point?.repositoryCopies || []).filter((item) => item.state === 'available')) {
        const artifact = artifacts.find((item) => item.recoveryPointId === point.id && item.repositoryId === copy.repositoryId && item.kind === 'physical-backup' && item.metadata?.adapterId === ADAPTER_ID);
        if (artifact) { selected = { copy, artifact }; break; }
      }
      if (!selected) throw new MongoDbPhysicalRestoreError('MONGODB_PHYSICAL_ARTIFACT_UNAVAILABLE', 'No available repository copy contains the MongoDB physical snapshot.', { category: 'not-found' });
      const metadata = selected.artifact.metadata;
      if (metadata.kind !== 'mongodb-coordinated-snapshot' || metadata.physicalSnapshot?.consistency?.proven !== true || metadata.physicalSnapshot?.lock?.unlocked !== true) throw new MongoDbPhysicalRestoreError('MONGODB_PHYSICAL_MANIFEST_INVALID', 'The MongoDB physical manifest lacks coordinated snapshot evidence.', { category: 'integrity' });
      const providerEntry = this.providerRegistry.get(request.targetProfile.providerId);
      provider = providerEntry.provider;
      if (metadata.physicalSnapshot.provider?.providerId !== providerEntry.manifest.providerId) throw new MongoDbPhysicalRestoreError('MONGODB_PHYSICAL_PROVIDER_MISMATCH', 'The selected provider does not match the physical snapshot format.', { category: 'compatibility' });
      const targetConnection = await this.controlDatabase.repository('connection').get(workspaceId, request.targetConnectionId);
      const leaseOwner = `mongodb-physical-restore:${workspaceId}:${restoreRunId}`;
      preflight = normalizePreflight(await provider.preflightRestore({ leaseOwner, target: { connectionId: targetConnection.id, adapterId: targetConnection.adapterId, revision: targetConnection.revision, identity: request.targetProfile.targetIdentity }, layout: request.targetProfile.layout, configuration: request.targetProfile.providerConfiguration, protectedSnapshot: structuredClone(metadata.physicalSnapshot), signal }), request, leaseOwner);
      if (preflight.targetIdentity !== request.targetProfile.targetIdentity) throw new MongoDbPhysicalRestoreError('MONGODB_PHYSICAL_TARGET_IDENTITY_MISMATCH', 'The provider preflight reached a different physical restore target.', { category: 'integrity' });
      const opened = await this.openRepository(workspaceId, selected.copy.repositoryId);
      const snapshot = await opened.engine.openSnapshot({}, { repositoryId: selected.copy.repositoryId, snapshotId: selected.copy.engineSnapshotId, masterKey: opened.masterKey });
      const locatorPath = decodeURIComponent(String(selected.artifact.locator || '').split('#').slice(1).join('#'));
      const file = (snapshot.manifest.files || []).find((item) => item.type === 'file' && item.path === locatorPath && item.metadata?.artifactKind === 'physical-backup' && item.metadata?.database?.adapterId === ADAPTER_ID);
      if (!file || file.sizeBytes !== selected.artifact.sizeBytes || file.contentDigest?.digest !== selected.artifact.checksum?.digest) throw new MongoDbPhysicalRestoreError('MONGODB_PHYSICAL_REPOSITORY_MANIFEST_INVALID', 'The authenticated repository manifest does not match the MongoDB physical Artifact.', { category: 'integrity' });
      progress = { ...progress, phase: 'running', bytesTotal: file.sizeBytes, updatedAt: this.clock() };
      await this.#project(workspaceId, restoreRunId, { state: 'running', progress, target: { operation: 'physical-empty-target', mode: 'empty-target', engine: 'mongodb', providerId: providerEntry.manifest.providerId, targetIdentity: preflight.targetIdentity, layout: preflight.layout, leaseId: preflight.leaseId, lease: { version: 1, providerId: providerEntry.manifest.providerId, leaseId: preflight.leaseId, ownerId: preflight.leaseOwner, targetIdentity: preflight.targetIdentity, state: 'active', acquiredAt: this.clock() } } }, actorId);
      const content = (async function* tracked(service) {
        const stream = opened.engine.streamFile({}, { repositoryId: selected.copy.repositoryId, manifest: snapshot.manifest, masterKey: opened.masterKey, path: file.path });
        for await (const chunk of stream) {
          if (signal?.aborted) throw new MongoDbPhysicalRestoreError('MONGODB_PHYSICAL_RESTORE_CANCELED', 'The MongoDB physical restore was canceled.', { category: 'canceled' });
          progress.bytesWritten += Buffer.byteLength(chunk); yield Buffer.from(chunk);
        }
      })(this);
      restored = await provider.restoreExport({ leaseId: preflight.leaseId, leaseOwner: preflight.leaseOwner, targetIdentity: preflight.targetIdentity, layout: preflight.layout, content, expected: { sizeBytes: file.sizeBytes, digest: file.contentDigest.digest, snapshot: structuredClone(metadata.physicalSnapshot) }, signal });
      if (!restored || requiredText(restored.leaseId, 'Provider restore lease ID', 500) !== preflight.leaseId || restored.serviceStarted === true || Number(restored.bytesWritten) !== file.sizeBytes) throw new MongoDbPhysicalRestoreError('MONGODB_PHYSICAL_RESTORE_RESULT_INVALID', 'The provider did not prove complete media materialization with MongoDB still stopped.', { category: 'integrity' });
      progress = { ...progress, phase: 'validating', itemsCompleted: 1, updatedAt: this.clock() };
      await this.#project(workspaceId, restoreRunId, { state: 'validating', progress }, actorId);
      const validation = await provider.validateRestoredMedia({ leaseId: preflight.leaseId, leaseOwner: preflight.leaseOwner, targetIdentity: preflight.targetIdentity, layout: preflight.layout, protectedSnapshot: structuredClone(metadata.physicalSnapshot), restoreResult: structuredClone(restored), signal });
      const valid = validation?.valid === true && validation?.isolated === true && validation?.serviceExposed !== true;
      validationRecord = { state: valid ? 'succeeded' : 'failed', connectivity: validation?.connectivity === true ? 'pass' : 'unavailable', expectedObjects: validation?.expectedObjects === true ? 'pass' : 'unavailable', nativeIntegrityValidation: validation?.nativeIntegrityValidation === true, isolated: validation?.isolated === true, serviceExposed: validation?.serviceExposed === true, checks: Array.isArray(validation?.checks) ? validation.checks.slice(0, 100) : [], completedAt: this.clock() };
      if (!valid) throw new MongoDbPhysicalRestoreError('MONGODB_PHYSICAL_RESTORE_VALIDATION_FAILED', 'The restored MongoDB media did not pass isolated provider validation.', { category: 'integrity' });
      const commit = await provider.commitRestore({ leaseId: preflight.leaseId, leaseOwner: preflight.leaseOwner, targetIdentity: preflight.targetIdentity, restoreResult: structuredClone(restored), validation: structuredClone(validation), signal });
      if (!commit || commit.committed !== true || commit.leaseOwner !== preflight.leaseOwner) throw new MongoDbPhysicalRestoreError('MONGODB_PHYSICAL_RESTORE_COMMIT_UNPROVEN', 'The provider did not prove final ownership transfer for the restored target.', { category: 'consistency' });
      committed = true;
      progress = { ...progress, phase: 'complete', updatedAt: this.clock() };
      const current = await this.controlDatabase.repository('restoreRun').get(workspaceId, restoreRunId);
      return this.#project(workspaceId, restoreRunId, { state: 'succeeded', target: { ...(current.target || {}), lease: { ...current.target.lease, state: 'committed', committedAt: this.clock() } }, progress, validation: validationRecord, result: { recoveryPointId: point.id, providerId: providerEntry.manifest.providerId, targetIdentity: preflight.targetIdentity, leaseId: preflight.leaseId, bytesRestored: progress.bytesWritten, serviceExposed: false, warnings: [], completedAt: this.clock() } }, actorId);
    } catch (error) {
      let rollbackFailed = false;
      const canceled = signal?.aborted || error?.code === 'MONGODB_PHYSICAL_RESTORE_CANCELED';
      if (provider && preflight && !committed) {
        try { await provider.rollbackRestore({ leaseId: preflight.leaseId, leaseOwner: preflight.leaseOwner, targetIdentity: preflight.targetIdentity, restoreResult: restored, reason: canceled ? 'restore-canceled' : 'restore-failed', signal: undefined }); }
        catch (_error) { rollbackFailed = true; }
      }
      const current = await this.controlDatabase.repository('restoreRun').get(workspaceId, restoreRunId);
      if (current && !TERMINAL_STATES.has(current.state)) {
        const state = rollbackFailed || committed ? 'interrupted' : canceled ? 'canceled' : 'failed';
        const lease = current.target?.lease;
        return this.#project(workspaceId, restoreRunId, {
          state, target: { ...(current.target || {}), ...(lease ? { lease: { ...lease, state: rollbackFailed ? 'active' : committed ? 'committed' : 'rolled-back', reconciledAt: this.clock() } } : {}) },
          progress: { ...progress, phase: state === 'interrupted' ? 'operator-action-required' : state, updatedAt: this.clock() }, validation: validationRecord,
          result: { error: rollbackFailed
            ? { code: 'MONGODB_PHYSICAL_RESTORE_LEASE_CLEANUP_UNPROVEN', category: 'consistency', retryable: false, safeMessage: 'Provider lease rollback could not be proven. Inspect the target before retrying.' }
            : canceled ? { code: 'MONGODB_PHYSICAL_RESTORE_CANCELED', category: 'canceled', retryable: false, safeMessage: 'The MongoDB physical restore was canceled and its owned provider lease was rolled back.' }
              : publicError(error), completedAt: this.clock() }
        }, actorId);
      }
      throw error;
    }
  }
}

module.exports = { MongoDbPhysicalRestoreError, MongoDbPhysicalRestoreService, RESTORE_CONFIRMATION, normalizeRequest };
