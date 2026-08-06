const crypto = require('crypto');
const { METADATA_PATH, SOURCE_LEASE_KIND } = require('./influxdb3-enterprise-source-reader');
const { ROW_DELETE_WARNING, SOURCE_TIER, rowDeleteEvidence } = require('./influxdb3-enterprise-restore');
const { normalizeBackupName } = require('./influxdb3-enterprise-native');

const METADATA_MODE = 'influxdb3-enterprise-metadata';
const UNSUPPORTED_LIVE_DRILL_MODE = 'influxdb3-enterprise-full-drill';
const TERMINAL_STATES = new Set(['succeeded', 'warning', 'failed', 'canceled', 'interrupted']);

class InfluxDb3EnterpriseVerificationError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'InfluxDb3EnterpriseVerificationError';
    this.code = code;
    this.category = options.category || 'verification';
    this.retryable = Boolean(options.retryable);
  }
}

function requiredText(value, label, maximumLength = 4096) {
  const text = String(value ?? '').trim();
  if (!text || text.includes('\0') || text.length > maximumLength) throw new InfluxDb3EnterpriseVerificationError('INFLUXDB3_ENTERPRISE_VERIFICATION_INPUT_INVALID', `${label} is invalid.`, { category: 'validation' });
  return text;
}

function stableDigest(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameIdentity(expected, actual) {
  return actual && expected
    && actual.productVersion === expected.productVersion
    && actual.storageEngine === expected.storageEngine
    && actual.clusterId === expected.clusterId
    && actual.nodeId === expected.nodeId
    && actual.nodeCatalogId === expected.nodeCatalogId
    && actual.instanceId === expected.instanceId
    && actual.roleFingerprint === expected.roleFingerprint
    && actual.deploymentFingerprint === expected.deploymentFingerprint
    && actual.capabilityFingerprint === expected.capabilityFingerprint;
}

function publicError(error) {
  if (error?.code && /^INFLUXDB3_ENTERPRISE_[A-Z0-9_]+$/.test(String(error.code))) {
    return { code: String(error.code).slice(0, 120), category: String(error.category || 'verification').slice(0, 80), retryable: Boolean(error.retryable), safeMessage: 'The InfluxDB 3 Enterprise recovery test could not complete.' };
  }
  return { code: 'INFLUXDB3_ENTERPRISE_VERIFICATION_FAILED', category: 'verification', retryable: false, safeMessage: 'The InfluxDB 3 Enterprise recovery test could not complete.' };
}

function assertMetadataArtifact(authenticated) {
  const metadata = authenticated?.metadata;
  const operation = metadata?.operation;
  const source = metadata?.source;
  if (!metadata || metadata.kind !== SOURCE_LEASE_KIND || metadata.engine !== 'influxdb3-enterprise' || metadata.backupMethod !== 'physical' || !['full', 'incremental'].includes(metadata.backupMode)
    || metadata.publication?.path !== METADATA_PATH || metadata.publication?.artifactKind !== 'metadata' || metadata.externalNativeMedia?.managedByServer !== true
    || metadata.externalNativeMedia?.authoritativeOwner !== 'influxdb3-enterprise' || metadata.externalNativeMedia?.includedInRepository !== false || metadata.externalNativeMedia?.deletionIssued !== false
    || !operation || !['full', 'incremental'].includes(operation.backupType) || operation.status !== 'completed' || operation.watermark === null || operation.watermark === undefined
    || !source || source.storageEngine !== 'upgraded' || source.compactorCapable !== true) {
    throw new InfluxDb3EnterpriseVerificationError('INFLUXDB3_ENTERPRISE_VERIFICATION_ARTIFACT_INVALID', 'The retained InfluxDB 3 Enterprise native backup artifact is not approved for recovery verification.', { category: 'integrity' });
  }
  if (authenticated?.source?.id !== metadata.sourceId || authenticated?.execution?.storageEngine !== 'upgraded' || !sameIdentity({ ...authenticated.execution, productVersion: authenticated.execution.productVersion }, { ...source, nativeBackupAvailable: true })) {
    throw new InfluxDb3EnterpriseVerificationError('INFLUXDB3_ENTERPRISE_VERIFICATION_SOURCE_BINDING_INVALID', 'The retained InfluxDB 3 Enterprise backup does not match its protected Source binding.', { category: 'integrity' });
  }
  return { metadata, operation, source };
}

function authenticatedChain(authenticated, operation) {
  const supplied = authenticated?.nativeChain;
  const chain = Array.isArray(supplied) && supplied.length ? supplied : [{ name: operation.backupName, type: operation.backupType, parentName: operation.backupType === 'full' ? null : operation.parentName, status: operation.status, watermark: operation.watermark }];
  if (chain.length > 200) throw new InfluxDb3EnterpriseVerificationError('INFLUXDB3_ENTERPRISE_VERIFICATION_CHAIN_INVALID', 'The retained native backup chain exceeds the verification limit.', { category: 'integrity' });
  const names = new Set();
  let parentName = null;
  for (let index = 0; index < chain.length; index += 1) {
    const item = chain[index];
    let name;
    let itemParentName;
    try {
      name = normalizeBackupName(item?.name);
      itemParentName = item?.parentName === null ? null : normalizeBackupName(item?.parentName);
    } catch {
      throw new InfluxDb3EnterpriseVerificationError('INFLUXDB3_ENTERPRISE_VERIFICATION_CHAIN_INVALID', 'The retained native full and incremental backup chain is incomplete or inconsistent.', { category: 'integrity' });
    }
    if (!item || !['full', 'incremental'].includes(item.type) || item.status !== 'completed' || names.has(name)
      || (index === 0 ? item.type !== 'full' || itemParentName !== null : item.type !== 'incremental' || itemParentName !== parentName)) {
      throw new InfluxDb3EnterpriseVerificationError('INFLUXDB3_ENTERPRISE_VERIFICATION_CHAIN_INVALID', 'The retained native full and incremental backup chain is incomplete or inconsistent.', { category: 'integrity' });
    }
    names.add(name);
    parentName = name;
  }
  const leaf = chain[chain.length - 1];
  if (leaf.name !== operation.backupName || leaf.type !== operation.backupType || !sameValue(leaf.watermark, operation.watermark)) {
    throw new InfluxDb3EnterpriseVerificationError('INFLUXDB3_ENTERPRISE_VERIFICATION_CHAIN_INVALID', 'The retained native chain leaf does not match the repository-authenticated backup.', { category: 'integrity' });
  }
  return chain;
}

function privateVerificationBinding(authenticated, metadata, chain) {
  const recoveryPointRevision = Number(authenticated?.point?.revision);
  const sourceRevision = Number(authenticated?.source?.revision);
  const connectionRevision = Number(authenticated?.execution?.connectionRevision);
  if (!Number.isInteger(recoveryPointRevision) || recoveryPointRevision < 1
    || !Number.isInteger(sourceRevision) || sourceRevision < 1
    || !Number.isInteger(connectionRevision) || connectionRevision < 1) {
    throw new InfluxDb3EnterpriseVerificationError('INFLUXDB3_ENTERPRISE_VERIFICATION_BINDING_INVALID', 'The authenticated RecoveryPoint, Source, or connection revision is invalid.', { category: 'integrity' });
  }
  return Object.freeze({
    version: 1,
    recoveryPointId: authenticated.point.id,
    recoveryPointRevision,
    sourceId: authenticated.source.id,
    sourceRevision,
    connectionId: requiredText(authenticated.source.connectionId, 'Connection ID', 200),
    connectionRevision,
    repositoryId: authenticated.repositoryId,
    metadataArtifactId: authenticated.selected?.artifact?.id || null,
    metadataDigest: authenticated.metadataDigest || stableDigest(metadata),
    chainDigest: stableDigest(chain)
  });
}

function publicRun(record) {
  if (!record) return null;
  const result = record.result ? {
    state: record.result.state,
    fullRestorePerformed: false,
    productionClusterModified: false,
    completedAt: record.result.completedAt || null,
    error: record.result.error ? publicError(record.result.error) : null
  } : null;
  return Object.freeze({
    id: record.id,
    state: record.state,
    mode: record.mode,
    progress: record.progress ? { phase: record.progress.phase, startedAt: record.progress.startedAt || null, updatedAt: record.progress.updatedAt || null } : null,
    evidence: record.evidence ? structuredClone(record.evidence) : null,
    result,
    createdAt: record.createdAt || null,
    completedAt: record.completedAt || null
  });
}

class InfluxDb3EnterpriseRecoveryTestService {
  constructor({ controlDatabase, restoreService, deviceId, notificationService = null, clock = () => new Date().toISOString() } = {}) {
    if (!controlDatabase || !restoreService || typeof restoreService.authenticateRecoveryPoint !== 'function' || typeof restoreService.preview !== 'function') throw new TypeError('InfluxDB 3 Enterprise recovery-test dependencies are required.');
    this.controlDatabase = controlDatabase;
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
    if (mode === UNSUPPORTED_LIVE_DRILL_MODE || /drill|restore|live/i.test(mode)) {
      throw new InfluxDb3EnterpriseVerificationError('INFLUXDB3_ENTERPRISE_LIVE_DRILL_UNSAFE_BM411', 'A destructive live-cluster InfluxDB 3 Enterprise recovery drill is not available under BM-411.', { category: 'authorization' });
    }
    if (mode !== METADATA_MODE) throw new InfluxDb3EnterpriseVerificationError('INFLUXDB3_ENTERPRISE_VERIFICATION_MODE_INVALID', 'Choose InfluxDB 3 Enterprise native metadata verification.', { category: 'validation' });
    const recoveryPointId = requiredText(input.recoveryPointId, 'RecoveryPoint ID', 200);
    const authenticated = await this.restoreService.authenticateRecoveryPoint(tenant, recoveryPointId);
    const { metadata, operation } = assertMetadataArtifact(authenticated);
    const chain = authenticatedChain(authenticated, operation);
    const now = this.clock();
    const record = await this.controlDatabase.transaction((transaction) => {
      const currentPoint = transaction.get('recoveryPoint', tenant, authenticated.point.id);
      if (!currentPoint || currentPoint.revision !== authenticated.point.revision) {
        throw new InfluxDb3EnterpriseVerificationError('INFLUXDB3_ENTERPRISE_VERIFICATION_BINDING_CHANGED', 'The RecoveryPoint changed during verification admission.', { category: 'integrity', retryable: true });
      }
      if (currentPoint.retention?.nativeMediaDeletionClaim !== undefined && currentPoint.retention?.nativeMediaDeletionClaim !== null) {
        throw new InfluxDb3EnterpriseVerificationError('INFLUXDB3_ENTERPRISE_NATIVE_MEDIA_DELETION_ACTIVE', 'Native media deletion currently owns this RecoveryPoint.', { category: 'conflict', retryable: true });
      }
      return transaction.create('verificationRun', {
        workspaceId: tenant,
        actorId: actor,
        scopeType: 'recovery-point',
        scopeId: authenticated.point.id,
        recoveryPointId: authenticated.point.id,
        recoveryPointIds: [authenticated.point.id],
        repositoryId: authenticated.repositoryId,
        mode: METADATA_MODE,
        workerId: `device:${this.deviceId}`,
        state: 'queued',
        progress: { phase: 'queued', startedAt: null, updatedAt: now },
        privateVerificationBinding: privateVerificationBinding(authenticated, metadata, chain),
        evidence: null,
        result: null
      });
    });
    const entry = { controller: new AbortController(), operation: null, cancelRequested: false };
    this.active.set(record.id, entry);
    entry.operation = this.#execute(tenant, actor, record.id, recoveryPointId, entry).catch(() => this.controlDatabase.repository('verificationRun').get(tenant, record.id));
    entry.operation.finally(() => this.active.delete(record.id));
    return publicRun(record);
  }

  async wait(workspaceId, verificationRunId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const id = requiredText(verificationRunId, 'Verification Run ID', 200);
    if (this.active.has(id)) await this.active.get(id).operation;
    const record = await this.#owned(tenant, id);
    return publicRun(record);
  }

  async list(workspaceId, options = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new InfluxDb3EnterpriseVerificationError('INFLUXDB3_ENTERPRISE_VERIFICATION_INPUT_INVALID', 'Verification list options are invalid.', { category: 'validation' });
    const limit = Math.min(200, Math.max(1, Number(options.limit) || 50));
    const recoveryPointId = options.recoveryPointId === undefined || options.recoveryPointId === null || options.recoveryPointId === ''
      ? null
      : requiredText(options.recoveryPointId, 'RecoveryPoint ID', 200);
    const records = await this.controlDatabase.repository('verificationRun').list(tenant, { limit: recoveryPointId ? 200 : limit });
    return records
      .filter((record) => this.#owns(record)
        && (!recoveryPointId || (record.recoveryPointId === recoveryPointId && record.privateVerificationBinding?.recoveryPointId === recoveryPointId)))
      .slice(0, limit)
      .map(publicRun);
  }

  async cancel(workspaceId, actorId, verificationRunId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const id = requiredText(verificationRunId, 'Verification Run ID', 200);
    const record = await this.#owned(tenant, id);
    if (TERMINAL_STATES.has(record.state)) return publicRun(record);
    const active = this.active.get(id);
    if (!active) throw new InfluxDb3EnterpriseVerificationError('INFLUXDB3_ENTERPRISE_VERIFICATION_NOT_ACTIVE', 'The InfluxDB 3 Enterprise recovery test is not active in this process.', { category: 'conflict' });
    active.cancelRequested = true;
    active.controller.abort();
    await active.operation;
    const completed = await this.#owned(tenant, id);
    return publicRun(completed);
  }

  async reconcile(workspaceId, actorId = 'system') {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const records = await this.controlDatabase.repository('verificationRun').list(tenant, { limit: 200 });
    const reconciled = [];
    for (const record of records.filter((item) => this.#owns(item) && !TERMINAL_STATES.has(item.state) && !this.active.has(item.id))) {
      const projected = await this.#project(tenant, record.id, {
        state: 'interrupted',
        completedAt: null,
        progress: { ...(record.progress || {}), phase: 'interrupted', updatedAt: this.clock() },
        result: { state: 'interrupted', fullRestorePerformed: false, productionClusterModified: false, error: { code: 'INFLUXDB3_ENTERPRISE_VERIFICATION_PROCESS_INTERRUPTED', category: 'verification', retryable: false }, completedAt: null }
      }, actor);
      await this.#notify(tenant, projected);
      reconciled.push(publicRun(projected));
    }
    return reconciled;
  }

  async #execute(workspaceId, actorId, verificationRunId, recoveryPointId, entry) {
    const signal = entry.controller.signal;
    const startedAt = this.clock();
    try {
      await this.#project(workspaceId, verificationRunId, { state: 'running', startedAt, progress: { phase: 'authenticating-retained-native-chain', startedAt, updatedAt: startedAt } }, actorId);
      this.#throwIfAborted(signal);
      const authenticated = await this.restoreService.authenticateRecoveryPoint(workspaceId, recoveryPointId);
      const { metadata, operation, source } = assertMetadataArtifact(authenticated);
      const chain = authenticatedChain(authenticated, operation);
      const binding = privateVerificationBinding(authenticated, metadata, chain);
      await this.#assertStoredBinding(workspaceId, verificationRunId, binding);
      this.#throwIfAborted(signal);
      const preview = await this.restoreService.preview(workspaceId, { recoveryPointId, signal });
      this.#throwIfAborted(signal);
      const finalAuthenticated = await this.restoreService.authenticateRecoveryPoint(workspaceId, recoveryPointId);
      const finalArtifact = assertMetadataArtifact(finalAuthenticated);
      const finalChain = authenticatedChain(finalAuthenticated, finalArtifact.operation);
      const finalBinding = privateVerificationBinding(finalAuthenticated, finalArtifact.metadata, finalChain);
      if (!sameValue(binding, finalBinding)) throw new InfluxDb3EnterpriseVerificationError('INFLUXDB3_ENTERPRISE_VERIFICATION_BINDING_CHANGED', 'The authenticated RecoveryPoint or native chain changed during verification.', { category: 'integrity', retryable: true });
      this.#throwIfAborted(signal);
      this.#assertFreshNativeBinding(finalAuthenticated, finalArtifact.metadata, finalArtifact.operation, finalArtifact.source, preview);
      const completedAt = this.clock();
      const completed = await this.#complete(workspaceId, verificationRunId, actorId, entry, finalBinding, {
        state: 'succeeded',
        completedAt,
        progress: { phase: 'complete', startedAt, updatedAt: completedAt },
        evidence: {
          verificationClass: 'influxdb3-enterprise-upgraded-native-metadata',
          repositoryManifestAuthenticated: true,
          repositoryArtifactAuthenticated: true,
          retainedNativeChainAuthenticated: true,
          nativeChainLength: finalChain.length,
          nativeChainRootType: 'full',
          nativeChainLeafType: finalArtifact.operation.backupType,
          ownedNativeBackupCompleted: true,
          ownedNativeBackupWatermarkAuthenticated: true,
          sourceIdentityFreshlyRevalidated: true,
          productIdentityVerified: true,
          upgradedStorageEngineVerified: true,
          protectedClusterIdentityVerified: true,
          deploymentIdentityVerified: true,
          capabilityIdentityVerified: true,
          compactorIdentityVerified: true,
          externalNativeMediaManagedByServer: true,
          repositoryContainsMetadataArtifactOnly: true,
          fullRestorePerformed: false,
          destructiveLiveDrillAvailable: false,
          ...rowDeleteEvidence(),
          warnings: [ROW_DELETE_WARNING]
        },
        result: { state: 'succeeded', fullRestorePerformed: false, productionClusterModified: false, completedAt }
      }, actorId);
      await this.#notify(workspaceId, completed);
      return completed;
    } catch (error) {
      const current = await this.controlDatabase.repository('verificationRun').get(workspaceId, verificationRunId);
      if (!this.#owns(current) || TERMINAL_STATES.has(current.state)) return current;
      const canceled = signal.aborted || error?.category === 'canceled';
      const completedAt = this.clock();
      const failed = await this.#project(workspaceId, verificationRunId, {
        state: canceled ? 'canceled' : 'failed',
        completedAt,
        progress: { ...(current.progress || {}), phase: canceled ? 'canceled' : 'failed', updatedAt: completedAt },
        result: { state: canceled ? 'canceled' : 'failed', fullRestorePerformed: false, productionClusterModified: false, error: canceled ? { code: 'INFLUXDB3_ENTERPRISE_VERIFICATION_CANCELED', category: 'canceled', retryable: false } : publicError(error), completedAt }
      }, actorId);
      await this.#notify(workspaceId, failed);
      return failed;
    }
  }

  #assertFreshNativeBinding(authenticated, metadata, operation, source, preview) {
    const identity = preview?.identity;
    const expected = authenticated.execution;
    if (!preview || preview.mode !== 'in-place' || preview.engine !== 'influxdb3-enterprise' || preview.tier !== SOURCE_TIER || preview.destructive !== true || preview.liveCluster !== true
      || preview.backupName !== operation.backupName || preview.backupType !== operation.backupType || !sameValue(preview.backupWatermark, operation.watermark)
      || preview.productVersion !== source.productVersion || preview.clusterId !== source.clusterId || preview.storageEngine !== 'upgraded'
      || expected?.compactorCapable !== true || expected?.nativeBackupAvailable !== true
      || !sameIdentity(expected, { ...identity, productVersion: identity?.productVersion || identity?.version })
      || identity?.clusterId !== source.clusterId || identity?.deploymentFingerprint !== source.deploymentFingerprint || identity?.capabilityFingerprint !== source.capabilityFingerprint
      || preview.rowDeleteStateCapturedByBackup !== false || preview.rowDeletesMayPersist !== true) {
      throw new InfluxDb3EnterpriseVerificationError('INFLUXDB3_ENTERPRISE_VERIFICATION_FRESH_BINDING_INVALID', 'The protected upgraded-native InfluxDB 3 Enterprise connection, identity, capability, or owned backup status changed during verification.', { category: 'integrity', retryable: true });
    }
  }

  #throwIfAborted(signal) {
    if (signal?.aborted) throw new InfluxDb3EnterpriseVerificationError('INFLUXDB3_ENTERPRISE_VERIFICATION_CANCELED', 'The InfluxDB 3 Enterprise recovery test was canceled.', { category: 'canceled' });
  }

  async #assertStoredBinding(workspaceId, id, binding) {
    const record = await this.#owned(workspaceId, id);
    if (!sameValue(record.privateVerificationBinding, binding)) {
      throw new InfluxDb3EnterpriseVerificationError('INFLUXDB3_ENTERPRISE_VERIFICATION_BINDING_CHANGED', 'The authenticated RecoveryPoint or native chain changed after recovery-test admission.', { category: 'integrity', retryable: true });
    }
  }

  async #complete(workspaceId, id, actorId, entry, binding, changes) {
    return this.controlDatabase.transaction((transaction) => {
      const current = transaction.get('verificationRun', workspaceId, id);
      if (!this.#owns(current)) throw new InfluxDb3EnterpriseVerificationError('INFLUXDB3_ENTERPRISE_VERIFICATION_NOT_FOUND', 'The InfluxDB 3 Enterprise recovery test was not found.', { category: 'not-found' });
      if (TERMINAL_STATES.has(current.state)) return current;
      if (!sameValue(current.privateVerificationBinding, binding)) {
        throw new InfluxDb3EnterpriseVerificationError('INFLUXDB3_ENTERPRISE_VERIFICATION_BINDING_CHANGED', 'The authenticated RecoveryPoint or native chain changed before terminal publication.', { category: 'integrity', retryable: true });
      }
      if (entry.cancelRequested || entry.controller.signal.aborted) {
        const completedAt = this.clock();
        return transaction.projectExecution('verificationRun', workspaceId, id, {
          state: 'canceled',
          completedAt,
          progress: { ...(current.progress || {}), phase: 'canceled', updatedAt: completedAt },
          result: { state: 'canceled', fullRestorePerformed: false, productionClusterModified: false, error: { code: 'INFLUXDB3_ENTERPRISE_VERIFICATION_CANCELED', category: 'canceled', retryable: false }, completedAt }
        }, { expectedRevision: current.revision, actorId });
      }
      this.#assertCurrentCatalogBinding(transaction, workspaceId, binding);
      return transaction.projectExecution('verificationRun', workspaceId, id, changes, { expectedRevision: current.revision, actorId });
    });
  }

  #assertCurrentCatalogBinding(transaction, workspaceId, binding) {
    const point = transaction.get('recoveryPoint', workspaceId, binding.recoveryPointId);
    const source = transaction.get('source', workspaceId, binding.sourceId);
    const connection = transaction.get('connection', workspaceId, binding.connectionId);
    if (!point || point.revision !== binding.recoveryPointRevision || point.sourceId !== binding.sourceId
      || !source || source.revision !== binding.sourceRevision || source.connectionId !== binding.connectionId
      || !connection || connection.revision !== binding.connectionRevision) {
      throw new InfluxDb3EnterpriseVerificationError('INFLUXDB3_ENTERPRISE_VERIFICATION_BINDING_CHANGED', 'The RecoveryPoint, Source, or tested connection changed before terminal publication.', { category: 'integrity', retryable: true });
    }
  }

  #owns(record) {
    return record?.mode === METADATA_MODE && record?.privateVerificationBinding && record?.workerId === `device:${this.deviceId}`;
  }

  async #owned(workspaceId, id) {
    const record = await this.controlDatabase.repository('verificationRun').get(workspaceId, id);
    if (!this.#owns(record)) throw new InfluxDb3EnterpriseVerificationError('INFLUXDB3_ENTERPRISE_VERIFICATION_NOT_FOUND', 'The InfluxDB 3 Enterprise recovery test was not found.', { category: 'not-found' });
    return record;
  }

  async #project(workspaceId, id, changes, actorId) {
    return this.controlDatabase.transaction((transaction) => {
      const current = transaction.get('verificationRun', workspaceId, id);
      if (!current) throw new InfluxDb3EnterpriseVerificationError('INFLUXDB3_ENTERPRISE_VERIFICATION_NOT_FOUND', 'The InfluxDB 3 Enterprise recovery test was not found.', { category: 'not-found' });
      if (TERMINAL_STATES.has(current.state) && changes.state && changes.state !== current.state) return current;
      return transaction.projectExecution('verificationRun', workspaceId, id, changes, { expectedRevision: current.revision, actorId });
    });
  }

  async #notify(workspaceId, record) {
    if (this.notificationService && TERMINAL_STATES.has(record?.state)) await this.notificationService.notifyVerificationRun(workspaceId, publicRun(record)).catch(() => {});
  }
}

module.exports = {
  METADATA_MODE,
  TERMINAL_STATES,
  UNSUPPORTED_LIVE_DRILL_MODE,
  InfluxDb3EnterpriseRecoveryTestService,
  InfluxDb3EnterpriseVerificationError,
  authenticatedChain,
  privateVerificationBinding,
  publicRun
};
