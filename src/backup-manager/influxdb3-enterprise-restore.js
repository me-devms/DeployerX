const { digestJson } = require('./database-adapter');
const {
  ADAPTER_ID,
  NATIVE_CONSISTENCY_METHOD,
  normalizeNativeBackupExecution
} = require('./influxdb3-enterprise');
const {
  BACKUP_STATES,
  InfluxDb3EnterpriseNativeController,
  RESTORE_CONFIRMATION,
  RESTORE_STATES,
  normalizeBackupName,
  normalizeRestoreMutation
} = require('./influxdb3-enterprise-native');
const {
  METADATA_PATH,
  SOURCE_LEASE_KIND
} = require('./influxdb3-enterprise-source-reader');

const SOURCE_TIER = 'upgraded-native';
const RESTORE_OPERATION = 'influxdb3-enterprise-upgraded-native-in-place-restore';
const TERMINAL_STATES = new Set(['succeeded', 'warning', 'failed', 'canceled', 'interrupted']);
const MAX_ARTIFACTS = 1000;
const MAX_METADATA_BYTES = 1024 * 1024;
const ROW_DELETE_WARNING = 'Row-delete state is not captured by this backup format, so row deletes may persist after the point-in-time rollback.';

class InfluxDb3EnterpriseRestoreError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'InfluxDb3EnterpriseRestoreError';
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

function stableDigest(value) {
  return `sha256:${digestJson(value)}`;
}

function sameValue(left, right) {
  return digestJson(left) === digestJson(right);
}

function hasExactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function normalizeRestoreRequest(input = {}, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('InfluxDB 3 Enterprise restore request must be an object.');
  if (String(input.mode || 'in-place') !== 'in-place') {
    throw new InfluxDb3EnterpriseRestoreError('INFLUXDB3_ENTERPRISE_RESTORE_MODE_UNSUPPORTED', 'InfluxDB 3 Enterprise upgraded-native recovery supports the original live cluster only.', { category: 'compatibility' });
  }
  if (options.requireConfirmation !== false && (input.confirmed !== true || input.confirmationText !== RESTORE_CONFIRMATION)) {
    throw new InfluxDb3EnterpriseRestoreError('INFLUXDB3_ENTERPRISE_RESTORE_CONFIRMATION_REQUIRED', 'Enter the exact destructive live-cluster restore confirmation.', { category: 'conflict' });
  }
  return {
    recoveryPointId: requiredText(input.recoveryPointId, 'RecoveryPoint ID', 200),
    targetConnectionId: input.targetConnectionId === undefined || input.targetConnectionId === null || input.targetConnectionId === ''
      ? null
      : requiredText(input.targetConnectionId, 'InfluxDB 3 Enterprise target connection ID', 200),
    mode: 'in-place'
  };
}

function publicError(error) {
  if (error instanceof InfluxDb3EnterpriseRestoreError) {
    return { code: error.code, category: error.category, retryable: error.retryable, safeMessage: error.message };
  }
  const code = /^INFLUXDB3_ENTERPRISE_[A-Z0-9_]+$/.test(String(error?.code || ''))
    ? String(error.code)
    : 'INFLUXDB3_ENTERPRISE_RESTORE_FAILED';
  const messages = {
    INFLUXDB3_ENTERPRISE_RESTORE_CONFLICT: 'Another InfluxDB 3 Enterprise restore is already running across the cluster.',
    INFLUXDB3_ENTERPRISE_RESTORE_FAILED: 'InfluxDB 3 Enterprise reported that the native restore failed.',
    INFLUXDB3_ENTERPRISE_RESTORE_POLL_LIMIT: 'InfluxDB 3 Enterprise restore monitoring reached its bounded poll limit.',
    INFLUXDB3_ENTERPRISE_RESTORE_POLL_TIMEOUT: 'InfluxDB 3 Enterprise restore monitoring reached its deadline.',
    INFLUXDB3_ENTERPRISE_RESTORE_MUTATION_PERSIST_FAILED: 'InfluxDB 3 Enterprise accepted the restore, but durable mutation persistence failed.'
  };
  return {
    code,
    category: /^[a-z][a-z0-9-]{0,79}$/.test(String(error?.category || '')) ? String(error.category) : 'restore',
    retryable: Boolean(error?.retryable),
    safeMessage: messages[code] || 'DeployerX could not complete the InfluxDB 3 Enterprise live-cluster restore.'
  };
}

function sameExecutionIdentity(execution, identity) {
  return execution.productVersion === identity?.version
    && execution.clusterId === identity?.clusterId
    && execution.storageEngine === identity?.storageEngine
    && execution.nodeId === identity?.nodeId
    && execution.nodeCatalogId === identity?.nodeCatalogId
    && execution.instanceId === identity?.instanceId
    && execution.roleFingerprint === identity?.roleFingerprint
    && execution.deploymentFingerprint === identity?.deploymentFingerprint
    && execution.capabilityFingerprint === identity?.capabilityFingerprint;
}

function publicIdentity(execution) {
  return Object.freeze({
    productVersion: execution.productVersion,
    clusterId: execution.clusterId,
    storageEngine: execution.storageEngine,
    nodeId: execution.nodeId,
    nodeCatalogId: execution.nodeCatalogId,
    instanceId: execution.instanceId,
    roleFingerprint: execution.roleFingerprint,
    deploymentFingerprint: execution.deploymentFingerprint,
    capabilityFingerprint: execution.capabilityFingerprint
  });
}

function rowDeleteEvidence() {
  return Object.freeze({
    restoreMode: 'live-cluster-in-place',
    effect: 'point-in-time-rollback',
    walTruncatedToBackupWatermark: true,
    rowDeleteStateCapturedByBackup: false,
    rowDeletesMayPersist: true,
    compactedPostBackupFilesMayRemainUnreferenced: true
  });
}

function optionalTimestamp(value) {
  return value === null || (typeof value === 'string' && value === value.trim() && value.length <= 64 && Number.isFinite(Date.parse(value)));
}

function validWatermark(value) {
  return Number.isSafeInteger(value) && value >= 0
    || typeof value === 'string' && value === value.trim() && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
}

function validRecoveryPointTopology(point, retentionAuthentication) {
  if (point?.type === 'full') return point.chainRootId === point.id && point.parentRecoveryPointId === null;
  if (!retentionAuthentication || point?.type !== 'incremental') return false;
  const validId = (value) => typeof value === 'string' && value === value.trim() && value.length > 0 && value.length <= 200;
  return validId(point.chainRootId)
    && validId(point.parentRecoveryPointId)
    && point.chainRootId !== point.id
    && point.parentRecoveryPointId !== point.id;
}

function hasNativeMediaDeletionClaim(point) {
  return point?.retention?.nativeMediaDeletionClaim !== undefined
    && point.retention.nativeMediaDeletionClaim !== null;
}

function exactWholeClusterSelector(selector) {
  const empty = (rules) => !rules?.include?.length && !rules?.exclude?.length;
  return selector?.kind === 'database-objects'
    && selector.allDatabases === true
    && empty(selector.databases)
    && empty(selector.schemas)
    && empty(selector.tables)
    && selector.includeGlobalObjects !== true;
}

class InfluxDb3EnterpriseRestoreService {
  constructor({ controlDatabase, secretStore, deviceId, adapter, nativeController = null, openRepository, clock = () => new Date().toISOString() } = {}) {
    if (!controlDatabase || !secretStore || !adapter || typeof openRepository !== 'function') throw new TypeError('InfluxDB 3 Enterprise restore dependencies are required.');
    this.controlDatabase = controlDatabase;
    this.secretStore = secretStore;
    this.deviceId = requiredText(deviceId, 'Device ID', 200);
    this.adapter = adapter;
    this.nativeController = nativeController || new InfluxDb3EnterpriseNativeController({ adapter });
    this.openRepository = openRepository;
    this.clock = clock;
    this.active = new Map();
  }

  async preview(workspaceId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const request = normalizeRestoreRequest(input, { requireConfirmation: false });
    const prepared = await this.#prepare(tenant, request, input.signal);
    return {
      mode: 'in-place',
      recoveryPointId: prepared.point.id,
      sourceId: prepared.source.id,
      targetConnectionId: prepared.connection.id,
      engine: 'influxdb3-enterprise',
      tier: SOURCE_TIER,
      backupName: prepared.metadata.operation.backupName,
      backupType: prepared.metadata.operation.backupType,
      backupWatermark: prepared.metadata.operation.watermark,
      consistency: prepared.point.consistency,
      productVersion: prepared.execution.productVersion,
      clusterId: prepared.execution.clusterId,
      storageEngine: prepared.execution.storageEngine,
      identity: publicIdentity(prepared.execution),
      destructive: true,
      liveCluster: true,
      wholeCluster: true,
      originalClusterModified: true,
      rollbackAvailable: false,
      providerRestoreConflictScope: 'cluster',
      ...rowDeleteEvidence(),
      confirmationText: RESTORE_CONFIRMATION,
      warnings: [ROW_DELETE_WARNING],
      planDigest: prepared.planDigest
    };
  }

  async start(workspaceId, actorId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const request = normalizeRestoreRequest(input);
    const prepared = await this.#prepare(tenant, request, input.signal);
    await this.#assertNoLocalConflict(tenant, prepared.execution.clusterId);
    const now = this.clock();
    const evidence = {
      source: {
        sourceId: prepared.source.id,
        recoveryPointId: prepared.point.id,
        metadataDigest: prepared.metadataDigest,
        backupName: prepared.metadata.operation.backupName,
        backupWatermark: prepared.metadata.operation.watermark,
        identity: publicIdentity(prepared.execution)
      },
      limitations: rowDeleteEvidence()
    };
    const record = await this.controlDatabase.transaction((transaction) => {
      const currentPoint = transaction.get('recoveryPoint', tenant, prepared.point.id);
      if (!currentPoint || currentPoint.revision !== prepared.point.revision || hasNativeMediaDeletionClaim(currentPoint)) {
        throw new InfluxDb3EnterpriseRestoreError('INFLUXDB3_ENTERPRISE_RESTORE_ADMISSION_CHANGED', 'The RecoveryPoint changed or entered native-media deletion before restore admission completed.', { category: 'conflict', retryable: true });
      }
      return transaction.create('restoreRun', {
        workspaceId: tenant,
        actorId: actor,
        recoveryPointIds: [prepared.point.id],
        targetConnectionId: prepared.connection.id,
        target: {
          operation: RESTORE_OPERATION,
          mode: 'in-place',
          engine: 'influxdb3-enterprise',
          tier: SOURCE_TIER,
          sourceId: prepared.source.id,
          targetConnectionId: prepared.connection.id,
          connectionRevision: prepared.connection.revision,
          clusterId: prepared.execution.clusterId,
          backupName: prepared.metadata.operation.backupName,
          backupWatermark: prepared.metadata.operation.watermark,
          metadataDigest: prepared.metadataDigest,
          planDigest: prepared.planDigest,
          nativeRestoreId: null,
          nativeMutation: null,
          targetMutationStarted: false,
          mutationStartedAt: null,
          cancellationAccepted: false,
          restoreEvidence: evidence
        },
        mode: 'in-place',
        conflictPolicy: 'fail',
        workerId: `device:${this.deviceId}`,
        state: 'queued',
        progress: {
          phase: 'queued',
          itemsTotal: 1,
          itemsCompleted: 0,
          bytesTotal: 0,
          bytesWritten: 0,
          throughputBytesPerSecond: 0,
          startedAt: null,
          updatedAt: now,
          warnings: [ROW_DELETE_WARNING]
        },
        validation: null,
        result: null
      });
    });
    const entry = { controller: new AbortController(), operation: null, cancelRequested: false };
    this.active.set(record.id, entry);
    entry.operation = this.#execute(tenant, actor, record.id, request, prepared.planDigest, entry)
      .catch(() => this.controlDatabase.repository('restoreRun').get(tenant, record.id));
    entry.operation.finally(() => this.active.delete(record.id));
    return record;
  }

  async wait(workspaceId, restoreRunId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const id = requiredText(restoreRunId, 'RestoreRun ID', 200);
    if (this.active.has(id)) await this.active.get(id).operation;
    const record = await this.controlDatabase.repository('restoreRun').get(tenant, id);
    if (!this.#ownsRun(record)) throw new InfluxDb3EnterpriseRestoreError('INFLUXDB3_ENTERPRISE_RESTORE_RUN_NOT_FOUND', 'The InfluxDB 3 Enterprise upgraded-native RestoreRun was not found.', { category: 'not-found' });
    return record;
  }

  async cancel(workspaceId, actorId, restoreRunId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const id = requiredText(restoreRunId, 'RestoreRun ID', 200);
    let record = await this.controlDatabase.repository('restoreRun').get(tenant, id);
    if (!this.#ownsRun(record)) throw new InfluxDb3EnterpriseRestoreError('INFLUXDB3_ENTERPRISE_RESTORE_RUN_NOT_FOUND', 'The InfluxDB 3 Enterprise upgraded-native RestoreRun was not found.', { category: 'not-found' });
    if (TERMINAL_STATES.has(record.state)) return record;
    const active = this.active.get(id);
    if (active) {
      active.cancelRequested = true;
      active.controller.abort();
      await active.operation;
      return this.controlDatabase.repository('restoreRun').get(tenant, id);
    }
    if (!record.target?.nativeMutation) {
      return this.#project(tenant, id, {
        state: 'canceled',
        progress: { ...(record.progress || {}), phase: 'canceled', updatedAt: this.clock() },
        result: { error: { code: 'INFLUXDB3_ENTERPRISE_RESTORE_CANCELED', category: 'canceled', retryable: false, safeMessage: 'The RestoreRun was canceled before native cluster mutation.' }, originalClusterModified: false, completedAt: this.clock() }
      }, actor);
    }
    const request = { recoveryPointId: record.recoveryPointIds[0], targetConnectionId: record.targetConnectionId, mode: 'in-place' };
    try {
      const prepared = await this.#prepare(tenant, request);
      const outcome = await this.#cancelOwnedMutation(tenant, actor, record, prepared);
      if (outcome.kind === 'completed') return this.#complete(tenant, actor, record.id, prepared, outcome.remote, true);
      record = await this.controlDatabase.repository('restoreRun').get(tenant, id);
      return this.#project(tenant, id, {
        state: 'canceled',
        progress: { ...(record.progress || {}), phase: 'canceled', updatedAt: this.clock() },
        result: { restoreId: outcome.restoreId, cancellationConfirmed: true, originalClusterModified: true, rollbackClaimed: false, ...rowDeleteEvidence(), warnings: [ROW_DELETE_WARNING], completedAt: this.clock() }
      }, actor);
    } catch (error) {
      record = await this.controlDatabase.repository('restoreRun').get(tenant, id);
      return this.#project(tenant, id, {
        state: 'interrupted',
        progress: { ...(record.progress || {}), phase: 'operator-action-required', updatedAt: this.clock() },
        result: { error: publicError(error), cancellationConfirmed: false, originalClusterModified: true, rollbackClaimed: false, ...rowDeleteEvidence(), warnings: [ROW_DELETE_WARNING], completedAt: this.clock() }
      }, actor);
    }
  }

  async list(workspaceId, options = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const records = await this.controlDatabase.repository('restoreRun').list(tenant, { limit: Math.min(200, Math.max(1, Number(options.limit) || 50)) });
    return records.filter((record) => this.#ownsRun(record));
  }

  async authenticateRecoveryPoint(workspaceId, recoveryPointId, options = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const point = await this.controlDatabase.repository('recoveryPoint').get(tenant, requiredText(recoveryPointId, 'RecoveryPoint ID', 200));
    if (!point) throw new InfluxDb3EnterpriseRestoreError('INFLUXDB3_ENTERPRISE_RECOVERY_POINT_NOT_FOUND', 'The InfluxDB 3 Enterprise RecoveryPoint was not found.', { category: 'not-found' });
    const source = await this.controlDatabase.repository('source').get(tenant, point.sourceId);
    const retentionAuthentication = options?.allowDeletionEligible === true;
    if (!source || source.sourceType !== 'database' || source.adapterId !== ADAPTER_ID || source.enabled !== true || !exactWholeClusterSelector(source.selector) || !validRecoveryPointTopology(point, retentionAuthentication) || point.consistency !== 'application' || point.verification?.state !== 'succeeded' || (!retentionAuthentication && point.retention?.deletionEligible === true) || point.retention?.nativeMediaDeleted === true || hasNativeMediaDeletionClaim(point) || source.consistency?.backupMethod !== 'physical' || source.consistency?.backupMode !== 'full' || source.consistency?.method !== NATIVE_CONSISTENCY_METHOD || source.consistency?.requestedLevel !== 'application' || source.consistency?.captureCoordinates !== true || source.consistency?.allowDowngrade === true) {
      throw new InfluxDb3EnterpriseRestoreError('INFLUXDB3_ENTERPRISE_RECOVERY_POINT_INVALID', 'Choose a retained, verified, application-consistent InfluxDB 3 Enterprise native full RecoveryPoint.', { category: 'validation' });
    }
    const authenticatedBackupType = point.type;
    let execution;
    try { execution = normalizeNativeBackupExecution(source.physicalExecution); }
    catch { throw new InfluxDb3EnterpriseRestoreError('INFLUXDB3_ENTERPRISE_RECOVERY_POINT_INVALID', 'The InfluxDB 3 Enterprise upgraded-native Source binding is invalid.', { category: 'integrity' }); }
    if ((execution.workspaceId && execution.workspaceId !== tenant) || (execution.sourceId && execution.sourceId !== source.id)) {
      throw new InfluxDb3EnterpriseRestoreError('INFLUXDB3_ENTERPRISE_RECOVERY_POINT_INVALID', 'The InfluxDB 3 Enterprise Source identity does not own this RecoveryPoint.', { category: 'integrity' });
    }
    const artifacts = await this.controlDatabase.repository('artifact').list(tenant, { limit: MAX_ARTIFACTS });
    if (artifacts.length === MAX_ARTIFACTS) throw new InfluxDb3EnterpriseRestoreError('INFLUXDB3_ENTERPRISE_RESTORE_ARTIFACT_LIMIT', 'The InfluxDB 3 Enterprise Artifact scan exceeds the bounded limit.', { category: 'capacity' });
    const candidates = (point.repositoryCopies || []).filter((copy) => copy.state === 'available').flatMap((copy) => artifacts
      .filter((artifact) => artifact.recoveryPointId === point.id && artifact.repositoryId === copy.repositoryId && artifact.kind === 'metadata' && artifact.metadata?.adapterId === ADAPTER_ID && artifact.metadata?.kind === SOURCE_LEASE_KIND)
      .map((artifact) => ({ copy, artifact })));
    const selected = candidates[0];
    if (!selected) throw new InfluxDb3EnterpriseRestoreError('INFLUXDB3_ENTERPRISE_RESTORE_REPOSITORY_UNAVAILABLE', 'No available encrypted repository contains the InfluxDB 3 Enterprise native backup metadata.', { category: 'not-found' });
    const repositoryId = selected.copy.repositoryId;
    let opened;
    let snapshot;
    try {
      opened = await this.openRepository(tenant, repositoryId);
      snapshot = await opened.engine.openSnapshot({}, { repositoryId, snapshotId: selected.copy.engineSnapshotId, masterKey: opened.masterKey });
    } catch {
      throw new InfluxDb3EnterpriseRestoreError('INFLUXDB3_ENTERPRISE_RESTORE_REPOSITORY_INVALID', 'The encrypted repository snapshot could not be authenticated.', { category: 'integrity' });
    }
    if (snapshot.summary?.manifestKey !== selected.copy.manifestLocator || snapshot.summary?.manifestChecksum?.digest !== selected.copy.manifestChecksum?.digest) {
      throw new InfluxDb3EnterpriseRestoreError('INFLUXDB3_ENTERPRISE_RESTORE_MANIFEST_INVALID', 'The repository manifest no longer matches the InfluxDB 3 Enterprise RecoveryPoint.', { category: 'integrity' });
    }
    const locatorParts = String(selected.artifact.locator || '').split('#');
    let locatorPath = null;
    try { locatorPath = decodeURIComponent(locatorParts[1] || ''); } catch {}
    const metadataFile = (snapshot.manifest.files || []).find((file) => file.type === 'file' && file.path === locatorPath);
    const artifactEncrypted = selected.artifact.encryption?.algorithm === 'aes-256-gcm'
      && typeof selected.artifact.encryption?.keyVersion === 'string'
      && selected.artifact.encryption.keyVersion.length > 0
      && selected.artifact.encryption.keyVersion === snapshot.manifest?.keyVersion;
    if (locatorParts.length !== 2 || locatorParts[0] !== selected.copy.manifestLocator || locatorPath !== METADATA_PATH || !metadataFile || metadataFile.sizeBytes !== selected.artifact.sizeBytes || metadataFile.sizeBytes < 1 || metadataFile.sizeBytes > MAX_METADATA_BYTES || metadataFile.contentDigest?.digest !== selected.artifact.checksum?.digest || metadataFile.metadata?.artifactKind !== 'metadata' || metadataFile.metadata?.externalNativeMedia !== true || metadataFile.metadata?.database?.adapterId !== ADAPTER_ID || !sameValue(metadataFile.metadata.database, selected.artifact.metadata) || !artifactEncrypted) {
      throw new InfluxDb3EnterpriseRestoreError('INFLUXDB3_ENTERPRISE_RESTORE_ARTIFACT_INVALID', 'The encrypted InfluxDB 3 Enterprise metadata Artifact is incomplete or inconsistent.', { category: 'integrity' });
    }
    let metadata;
    try {
      const bytes = await opened.engine.readFile({}, { repositoryId, manifest: snapshot.manifest, path: METADATA_PATH, masterKey: opened.masterKey });
      if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_METADATA_BYTES) throw new Error('invalid metadata size');
      metadata = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new InfluxDb3EnterpriseRestoreError('INFLUXDB3_ENTERPRISE_RESTORE_ARTIFACT_INVALID', 'The authenticated InfluxDB 3 Enterprise metadata cannot be decoded.', { category: 'integrity' });
    }
    let backupName;
    try { backupName = normalizeBackupName(metadata?.operation?.backupName); }
    catch { throw new InfluxDb3EnterpriseRestoreError('INFLUXDB3_ENTERPRISE_RESTORE_ARTIFACT_INVALID', 'The InfluxDB 3 Enterprise backup identity is invalid.', { category: 'integrity' }); }
    const metadataValid = sameValue(metadata, selected.artifact.metadata)
      && hasExactKeys(metadata, ['version', 'kind', 'adapterId', 'adapterVersion', 'engine', 'backupMethod', 'backupMode', 'sourceId', 'selectionDigest', 'consistency', 'source', 'operation', 'publication', 'externalNativeMedia', 'restoreSupported'])
      && hasExactKeys(metadata.consistency, ['level', 'method', 'persistedDataWatermark'])
      && hasExactKeys(metadata.source, ['product', 'productVersion', 'clusterId', 'storageEngine', 'nodeId', 'nodeCatalogId', 'instanceId', 'roleFingerprint', 'deploymentFingerprint', 'capabilityFingerprint', 'compactorCapable'])
      && hasExactKeys(metadata.operation, ['backupName', 'backupType', 'status', 'watermark', 'createdAt', 'completedAt'])
      && hasExactKeys(metadata.publication, ['artifactKind', 'path', 'mediaType'])
      && hasExactKeys(metadata.externalNativeMedia, ['managedByServer', 'authoritativeOwner', 'includedInRepository', 'deletionIssued'])
      && metadata.version === 1
      && metadata.kind === SOURCE_LEASE_KIND
      && metadata.adapterId === ADAPTER_ID
      && metadata.adapterVersion === source.adapterVersion
      && metadata.engine === 'influxdb3-enterprise'
      && metadata.backupMethod === 'physical'
      && metadata.backupMode === authenticatedBackupType
      && metadata.sourceId === source.id
      && metadata.selectionDigest === source.selector?.digest
      && metadata.consistency?.level === 'application'
      && metadata.consistency?.method === NATIVE_CONSISTENCY_METHOD
      && sameValue(metadata.consistency?.persistedDataWatermark, metadata.operation?.watermark)
      && metadata.source?.product === 'InfluxDB 3 Enterprise'
      && metadata.source?.productVersion === execution.productVersion
      && metadata.source?.clusterId === execution.clusterId
      && metadata.source?.storageEngine === execution.storageEngine
      && metadata.source?.nodeId === execution.nodeId
      && metadata.source?.nodeCatalogId === execution.nodeCatalogId
      && metadata.source?.instanceId === execution.instanceId
      && metadata.source?.roleFingerprint === execution.roleFingerprint
      && metadata.source?.deploymentFingerprint === execution.deploymentFingerprint
      && metadata.source?.capabilityFingerprint === execution.capabilityFingerprint
      && metadata.source?.compactorCapable === true
      && metadata.operation?.backupName === backupName
      && metadata.operation?.backupType === authenticatedBackupType
      && metadata.operation?.status === BACKUP_STATES.COMPLETED
      && validWatermark(metadata.operation?.watermark)
      && optionalTimestamp(metadata.operation?.createdAt)
      && optionalTimestamp(metadata.operation?.completedAt)
      && metadata.publication?.artifactKind === 'metadata'
      && metadata.publication?.path === METADATA_PATH
      && metadata.publication?.mediaType === 'application/vnd.deployerx.influxdb3-enterprise-native-backup+json'
      && metadata.externalNativeMedia?.managedByServer === true
      && metadata.externalNativeMedia?.authoritativeOwner === 'influxdb3-enterprise'
      && metadata.externalNativeMedia?.includedInRepository === false
      && metadata.externalNativeMedia?.deletionIssued === false
      && metadata.restoreSupported === false;
    if (!metadataValid) throw new InfluxDb3EnterpriseRestoreError('INFLUXDB3_ENTERPRISE_RESTORE_ARTIFACT_INVALID', 'Authenticated InfluxDB 3 Enterprise metadata is inconsistent with its Source and RecoveryPoint.', { category: 'integrity' });
    return { point, source, execution, selected, repositoryId, opened, snapshot, metadata, metadataDigest: stableDigest(metadata) };
  }

  async reconcile(workspaceId, actorId = 'system') {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const recovered = [];
    const records = await this.controlDatabase.repository('restoreRun').list(tenant, { limit: 200 });
    for (const initial of records.filter((record) => this.#ownsRun(record) && !TERMINAL_STATES.has(record.state) && !this.active.has(record.id))) {
      let record = initial;
      if (!record.target?.nativeMutation) {
        recovered.push(await this.#project(tenant, record.id, {
          state: 'interrupted',
          progress: { ...(record.progress || {}), phase: 'interrupted', updatedAt: this.clock() },
          result: { error: { code: 'INFLUXDB3_ENTERPRISE_RESTORE_PROCESS_INTERRUPTED', category: 'restore', retryable: false, safeMessage: 'The RestoreRun process stopped before durable native mutation ownership was recorded.' }, originalClusterModified: false, completedAt: this.clock() }
        }, actor));
        continue;
      }
      try {
        const request = { recoveryPointId: record.recoveryPointIds[0], targetConnectionId: record.targetConnectionId, mode: 'in-place' };
        const prepared = await this.#prepare(tenant, request);
        this.#assertStoredPlan(record, prepared);
        const mutation = this.#ownedMutation(record, prepared);
        const remote = await this.nativeController.getRestore(this.#nativeContext(tenant), { connection: prepared.connectionConfig, restoreId: mutation.restoreId });
        this.#assertRemoteRestore(remote, prepared, mutation.restoreId);
        if (remote.restore.status === RESTORE_STATES.COMPLETED) {
          recovered.push(await this.#complete(tenant, actor, record.id, prepared, remote, true));
        } else if (remote.restore.status === RESTORE_STATES.FAILED) {
          recovered.push(await this.#interruptTerminalFailure(tenant, actor, record.id, 'INFLUXDB3_ENTERPRISE_RESTORE_FAILED', 'InfluxDB 3 Enterprise reported a failed terminal restore during startup reconciliation.'));
        } else {
          record = await this.#ensureRunning(tenant, actor, record.id);
          recovered.push(await this.#project(tenant, record.id, { progress: { ...(record.progress || {}), phase: 'reconciling-live-restore', updatedAt: this.clock() } }, actor));
        }
      } catch (error) {
        record = await this.controlDatabase.repository('restoreRun').get(tenant, record.id);
        if (error?.code === 'INFLUXDB3_ENTERPRISE_RESTORE_NOT_FOUND' && record.target?.cancellationAccepted === true) {
          recovered.push(await this.#project(tenant, record.id, { state: 'canceled', progress: { ...(record.progress || {}), phase: 'canceled', updatedAt: this.clock() }, result: { cancellationConfirmed: true, originalClusterModified: true, rollbackClaimed: false, ...rowDeleteEvidence(), warnings: [ROW_DELETE_WARNING], completedAt: this.clock() } }, actor));
        } else {
          recovered.push(await this.#project(tenant, record.id, { state: 'interrupted', progress: { ...(record.progress || {}), phase: 'operator-action-required', updatedAt: this.clock() }, result: { error: publicError(error), originalClusterModified: true, rollbackClaimed: false, ...rowDeleteEvidence(), warnings: [ROW_DELETE_WARNING], completedAt: this.clock() } }, actor));
        }
      }
    }
    return recovered;
  }

  async #prepare(workspaceId, request, signal) {
    const authenticated = await this.authenticateRecoveryPoint(workspaceId, request.recoveryPointId);
    const admitted = await this.#admitConnection(workspaceId, request.targetConnectionId, authenticated.source, authenticated.execution);
    const remote = await this.nativeController.getBackup(this.#nativeContext(workspaceId, signal), { connection: admitted.connectionConfig, name: authenticated.metadata.operation.backupName });
    if (!sameExecutionIdentity(authenticated.execution, remote.identity)
      || remote.backup.name !== authenticated.metadata.operation.backupName
      || remote.backup.type !== 'full'
      || remote.backup.parentName !== null
      || remote.backup.status !== BACKUP_STATES.COMPLETED
      || !sameValue(remote.backup.watermark, authenticated.metadata.operation.watermark)) {
      throw new InfluxDb3EnterpriseRestoreError('INFLUXDB3_ENTERPRISE_RESTORE_BACKUP_IDENTITY_INVALID', 'The server-managed native backup no longer matches the authenticated RecoveryPoint.', { category: 'integrity' });
    }
    const planDigest = stableDigest({
      recoveryPointId: authenticated.point.id,
      sourceId: authenticated.source.id,
      sourceRevision: authenticated.source.revision,
      connectionId: admitted.connection.id,
      connectionRevision: admitted.connection.revision,
      metadataDigest: authenticated.metadataDigest,
      backupName: authenticated.metadata.operation.backupName,
      backupWatermark: authenticated.metadata.operation.watermark,
      identity: publicIdentity(authenticated.execution)
    });
    return { ...authenticated, ...admitted, remoteBackup: remote.backup, planDigest };
  }

  async #admitConnection(workspaceId, requestedConnectionId, source, execution) {
    if (requestedConnectionId && requestedConnectionId !== source.connectionId) throw new InfluxDb3EnterpriseRestoreError('INFLUXDB3_ENTERPRISE_RESTORE_TARGET_INVALID', 'The upgraded-native restore can target only the exact protected live cluster.', { category: 'authorization' });
    const connection = await this.controlDatabase.repository('connection').get(workspaceId, source.connectionId);
    const identity = connection?.lastTest?.endpointIdentity;
    const pinsMatch = connection?.adapterId === ADAPTER_ID
      && connection.revision === execution.connectionRevision
      && connection.lastTest?.status === 'success'
      && (connection.workerAffinity || []).includes(`device:${this.deviceId}`)
      && connection.endpoint?.expectedVersion === execution.productVersion
      && connection.endpoint?.expectedStorageEngine === execution.storageEngine
      && connection.endpoint?.expectedClusterId === execution.clusterId
      && connection.endpoint?.expectedNodeId === execution.nodeId
      && connection.endpoint?.expectedNodeCatalogId === execution.nodeCatalogId
      && connection.endpoint?.expectedInstanceId === execution.instanceId
      && connection.endpoint?.expectedRoleFingerprint === execution.roleFingerprint
      && connection.endpoint?.expectedDeploymentFingerprint === execution.deploymentFingerprint
      && connection.endpoint?.expectedCapabilityFingerprint === execution.capabilityFingerprint
      && connection.trust?.fingerprint === execution.deploymentFingerprint
      && connection.trust?.clusterId === execution.clusterId
      && connection.trust?.nodeId === execution.nodeId
      && connection.trust?.nodeCatalogId === execution.nodeCatalogId
      && connection.trust?.instanceId === execution.instanceId
      && connection.trust?.roleFingerprint === execution.roleFingerprint
      && connection.trust?.capabilityFingerprint === execution.capabilityFingerprint
      && identity?.compactorCapable === true
      && identity?.nativeBackupAvailable === true
      && sameExecutionIdentity(execution, identity);
    if (!pinsMatch) throw new InfluxDb3EnterpriseRestoreError('INFLUXDB3_ENTERPRISE_RESTORE_CONNECTION_INVALID', 'Retest the exact upgraded-engine compactor connection before live-cluster recovery.', { category: 'integrity', retryable: true });
    if (!Array.isArray(connection.secretRefIds) || connection.secretRefIds.length !== 1) throw new InfluxDb3EnterpriseRestoreError('INFLUXDB3_ENTERPRISE_RESTORE_CONNECTION_INVALID', 'The InfluxDB 3 Enterprise admin-token binding is invalid.', { category: 'authentication' });
    let connectionConfig;
    try { connectionConfig = this.adapter.normalizeConfig({ ...connection.endpoint, adminTokenSecretRefId: connection.secretRefIds[0] }); }
    catch { throw new InfluxDb3EnterpriseRestoreError('INFLUXDB3_ENTERPRISE_RESTORE_CONNECTION_INVALID', 'The tested InfluxDB 3 Enterprise connection binding is invalid.', { category: 'configuration' }); }
    return { connection, connectionConfig };
  }

  #nativeContext(workspaceId, signal) {
    return {
      signal,
      resolveSecret: (secretRefId) => this.secretStore.resolve({ workspaceId, id: secretRefId })
    };
  }

  async #assertNoLocalConflict(workspaceId, clusterId, excludeId = null) {
    const records = await this.controlDatabase.repository('restoreRun').list(workspaceId, { limit: 200 });
    const conflict = records.find((record) => record.id !== excludeId && this.#ownsRun(record) && !TERMINAL_STATES.has(record.state) && record.target?.clusterId === clusterId);
    if (conflict) throw new InfluxDb3EnterpriseRestoreError('INFLUXDB3_ENTERPRISE_RESTORE_CONFLICT', 'Another InfluxDB 3 Enterprise restore is already running across the cluster.', { category: 'conflict', retryable: true });
  }

  #assertStoredPlan(record, prepared) {
    if (record.target?.planDigest !== prepared.planDigest
      || record.target?.metadataDigest !== prepared.metadataDigest
      || record.target?.backupName !== prepared.metadata.operation.backupName
      || !sameValue(record.target?.backupWatermark, prepared.metadata.operation.watermark)
      || record.target?.clusterId !== prepared.execution.clusterId
      || record.target?.connectionRevision !== prepared.connection.revision) {
      throw new InfluxDb3EnterpriseRestoreError('INFLUXDB3_ENTERPRISE_RESTORE_PLAN_CHANGED', 'The authenticated RecoveryPoint, native backup, or live-cluster binding changed after restore admission.', { category: 'integrity' });
    }
  }

  #ownedMutation(record, prepared) {
    let mutation;
    try { mutation = normalizeRestoreMutation(record.target?.nativeMutation, record.target?.nativeRestoreId); }
    catch { throw new InfluxDb3EnterpriseRestoreError('INFLUXDB3_ENTERPRISE_RESTORE_OWNERSHIP_INVALID', 'Exact native restore mutation ownership is unavailable.', { category: 'authorization' }); }
    if (mutation.backupName !== prepared.metadata.operation.backupName || !sameExecutionIdentity(prepared.execution, { ...mutation, version: prepared.execution.productVersion })) {
      throw new InfluxDb3EnterpriseRestoreError('INFLUXDB3_ENTERPRISE_RESTORE_OWNERSHIP_INVALID', 'Native restore mutation ownership does not match the authenticated RecoveryPoint and cluster.', { category: 'authorization' });
    }
    return mutation;
  }

  #assertRemoteRestore(remote, prepared, expectedRestoreId) {
    if (!sameExecutionIdentity(prepared.execution, remote?.identity)
      || remote.restore?.id !== expectedRestoreId
      || remote.restore?.backupName !== prepared.metadata.operation.backupName) {
      throw new InfluxDb3EnterpriseRestoreError('INFLUXDB3_ENTERPRISE_RESTORE_VALIDATION_FAILED', 'Terminal native restore state does not match the authenticated backup and cluster identity.', { category: 'integrity' });
    }
  }

  async #execute(workspaceId, actorId, restoreRunId, request, expectedPlanDigest, entry) {
    let prepared = null;
    let acceptedMutation = null;
    let progress = { phase: 'preparing', itemsTotal: 1, itemsCompleted: 0, bytesTotal: 0, bytesWritten: 0, throughputBytesPerSecond: 0, startedAt: this.clock(), updatedAt: this.clock(), warnings: [ROW_DELETE_WARNING] };
    try {
      await this.#project(workspaceId, restoreRunId, { state: 'preparing', progress }, actorId);
      prepared = await this.#prepare(workspaceId, request, entry.controller.signal);
      if (prepared.planDigest !== expectedPlanDigest) throw new InfluxDb3EnterpriseRestoreError('INFLUXDB3_ENTERPRISE_RESTORE_PLAN_CHANGED', 'The authenticated RecoveryPoint or live-cluster binding changed after restore admission.', { category: 'integrity' });
      await this.#assertNoLocalConflict(workspaceId, prepared.execution.clusterId, restoreRunId);
      const result = await this.nativeController.createRestore({
        ...this.#nativeContext(workspaceId, entry.controller.signal),
        onMutationStarted: async (value) => {
          acceptedMutation = normalizeRestoreMutation(value);
          if (acceptedMutation.backupName !== prepared.metadata.operation.backupName || !sameExecutionIdentity(prepared.execution, { ...acceptedMutation, version: prepared.execution.productVersion })) {
            throw new InfluxDb3EnterpriseRestoreError('INFLUXDB3_ENTERPRISE_RESTORE_OWNERSHIP_INVALID', 'The accepted native restore mutation does not match the authenticated cluster.', { category: 'authorization' });
          }
          const current = await this.controlDatabase.repository('restoreRun').get(workspaceId, restoreRunId);
          if (!current || current.target?.nativeMutation) throw new InfluxDb3EnterpriseRestoreError('INFLUXDB3_ENTERPRISE_RESTORE_OWNERSHIP_INVALID', 'The RestoreRun already contains incompatible native mutation ownership.', { category: 'authorization' });
          progress = { ...progress, phase: 'restoring-live-cluster', updatedAt: this.clock() };
          await this.#project(workspaceId, restoreRunId, {
            state: 'running',
            progress,
            target: { ...current.target, nativeRestoreId: acceptedMutation.restoreId, nativeMutation: acceptedMutation, targetMutationStarted: true, mutationStartedAt: acceptedMutation.acceptedAt || this.clock() }
          }, actorId);
        }
      }, {
        connection: prepared.connectionConfig,
        backupName: prepared.metadata.operation.backupName,
        confirmed: true,
        confirmationText: RESTORE_CONFIRMATION
      });
      const current = await this.controlDatabase.repository('restoreRun').get(workspaceId, restoreRunId);
      const mutation = this.#ownedMutation(current, prepared);
      this.#assertRemoteRestore({ identity: result.identity, restore: result.restore }, prepared, mutation.restoreId);
      if (result.restore.status !== RESTORE_STATES.COMPLETED
        || result.evidence?.restoreMode !== 'live-cluster-in-place'
        || result.evidence?.effect !== 'point-in-time-rollback'
        || result.evidence?.backupWatermarkApplied !== true
        || result.evidence?.walTruncatedToBackupWatermark !== true
        || result.evidence?.rowDeleteStateCapturedByBackup !== false
        || result.evidence?.rowDeletesMayPersist !== true
        || result.evidence?.identityRevalidated !== true
        || !sameValue(result.evidence?.backupWatermark, prepared.metadata.operation.watermark)) {
        throw new InfluxDb3EnterpriseRestoreError('INFLUXDB3_ENTERPRISE_RESTORE_VALIDATION_FAILED', 'InfluxDB 3 Enterprise did not return complete terminal restore and limitation evidence.', { category: 'integrity' });
      }
      return this.#complete(workspaceId, actorId, restoreRunId, prepared, { identity: result.identity, restore: result.restore }, false);
    } catch (error) {
      let current = await this.controlDatabase.repository('restoreRun').get(workspaceId, restoreRunId);
      if (!current || TERMINAL_STATES.has(current.state)) return current;
      if (acceptedMutation && !current.target?.nativeMutation) {
        try {
          current = await this.#project(workspaceId, restoreRunId, { state: current.state === 'preparing' ? 'running' : current.state, target: { ...current.target, nativeRestoreId: acceptedMutation.restoreId, nativeMutation: acceptedMutation, targetMutationStarted: true, mutationStartedAt: acceptedMutation.acceptedAt || this.clock() } }, actorId);
        } catch {}
      }
      current = await this.controlDatabase.repository('restoreRun').get(workspaceId, restoreRunId);
      const mutated = Boolean(current.target?.targetMutationStarted || acceptedMutation || error?.details?.operationAccepted);
      if (entry.cancelRequested) {
        if (!mutated) return this.#project(workspaceId, restoreRunId, { state: 'canceled', progress: { ...progress, phase: 'canceled', updatedAt: this.clock() }, result: { error: { code: 'INFLUXDB3_ENTERPRISE_RESTORE_CANCELED', category: 'canceled', retryable: false, safeMessage: 'The RestoreRun was canceled before native cluster mutation.' }, originalClusterModified: false, completedAt: this.clock() } }, actorId);
        try {
          prepared = prepared || await this.#prepare(workspaceId, request);
          const outcome = await this.#cancelOwnedMutation(workspaceId, actorId, current, prepared);
          if (outcome.kind === 'completed') return this.#complete(workspaceId, actorId, restoreRunId, prepared, outcome.remote, true);
          current = await this.controlDatabase.repository('restoreRun').get(workspaceId, restoreRunId);
          return this.#project(workspaceId, restoreRunId, { state: 'canceled', progress: { ...(current.progress || progress), phase: 'canceled', updatedAt: this.clock() }, result: { restoreId: outcome.restoreId, cancellationConfirmed: true, originalClusterModified: true, rollbackClaimed: false, ...rowDeleteEvidence(), warnings: [ROW_DELETE_WARNING], completedAt: this.clock() } }, actorId);
        } catch (cancelError) {
          error = cancelError;
        }
      }
      current = await this.controlDatabase.repository('restoreRun').get(workspaceId, restoreRunId);
      const state = mutated ? 'interrupted' : entry.controller.signal.aborted ? 'canceled' : 'failed';
      return this.#project(workspaceId, restoreRunId, {
        state,
        progress: { ...(current.progress || progress), phase: mutated ? 'operator-action-required' : state, updatedAt: this.clock() },
        result: {
          error: mutated && error?.code !== 'INFLUXDB3_ENTERPRISE_RESTORE_MUTATION_PERSIST_FAILED'
            ? { code: 'INFLUXDB3_ENTERPRISE_RESTORE_TARGET_REQUIRES_INSPECTION', category: 'restore', retryable: false, safeMessage: 'The live cluster was mutated, but a successful terminal restore could not be proven. Preserve the cluster for inspection.' }
            : publicError(error),
          providerError: mutated ? publicError(error) : null,
          originalClusterModified: mutated,
          rollbackClaimed: false,
          ...(mutated ? rowDeleteEvidence() : {}),
          warnings: mutated ? [ROW_DELETE_WARNING] : [],
          completedAt: this.clock()
        }
      }, actorId);
    }
  }

  async #cancelOwnedMutation(workspaceId, actorId, record, prepared) {
    this.#assertStoredPlan(record, prepared);
    const mutation = this.#ownedMutation(record, prepared);
    const context = this.#nativeContext(workspaceId);
    let current;
    try { current = await this.nativeController.getRestore(context, { connection: prepared.connectionConfig, restoreId: mutation.restoreId }); }
    catch (error) {
      if (error?.code === 'INFLUXDB3_ENTERPRISE_RESTORE_NOT_FOUND' && record.target?.cancellationAccepted === true) return { kind: 'canceled', restoreId: mutation.restoreId };
      throw error;
    }
    this.#assertRemoteRestore(current, prepared, mutation.restoreId);
    if (current.restore.status === RESTORE_STATES.COMPLETED) return { kind: 'completed', remote: current, restoreId: mutation.restoreId };
    if (current.restore.status === RESTORE_STATES.FAILED) {
      if (record.target?.cancellationAccepted === true) return { kind: 'canceled', restoreId: mutation.restoreId };
      throw new InfluxDb3EnterpriseRestoreError('INFLUXDB3_ENTERPRISE_RESTORE_FAILED', 'The native restore failed before cancellation could be proven.', { category: 'restore' });
    }
    await this.nativeController.cancelRestore(context, { connection: prepared.connectionConfig, restoreId: mutation.restoreId, mutation });
    let latest = await this.controlDatabase.repository('restoreRun').get(workspaceId, record.id);
    latest = await this.#project(workspaceId, record.id, { target: { ...latest.target, cancellationAccepted: true, cancellationAcceptedAt: this.clock() } }, actorId);
    try { current = await this.nativeController.getRestore(context, { connection: prepared.connectionConfig, restoreId: mutation.restoreId }); }
    catch (error) {
      if (error?.code === 'INFLUXDB3_ENTERPRISE_RESTORE_NOT_FOUND') return { kind: 'canceled', restoreId: mutation.restoreId };
      throw error;
    }
    this.#assertRemoteRestore(current, prepared, mutation.restoreId);
    if (current.restore.status === RESTORE_STATES.COMPLETED) return { kind: 'completed', remote: current, restoreId: mutation.restoreId };
    if (current.restore.status === RESTORE_STATES.FAILED) return { kind: 'canceled', restoreId: mutation.restoreId };
    throw new InfluxDb3EnterpriseRestoreError('INFLUXDB3_ENTERPRISE_RESTORE_CANCEL_UNCONFIRMED', 'InfluxDB 3 Enterprise accepted cancellation, but terminal or not-found proof is unavailable.', { category: 'conflict', retryable: true });
  }

  async #complete(workspaceId, actorId, restoreRunId, prepared, remote, reconciledAfterRestart) {
    const ownedRecord = await this.controlDatabase.repository('restoreRun').get(workspaceId, restoreRunId);
    const ownedMutation = this.#ownedMutation(ownedRecord, prepared);
    this.#assertRemoteRestore(remote, prepared, ownedMutation.restoreId);
    if (remote.restore.status !== RESTORE_STATES.COMPLETED) throw new InfluxDb3EnterpriseRestoreError('INFLUXDB3_ENTERPRISE_RESTORE_VALIDATION_FAILED', 'A completed terminal native restore is required.', { category: 'integrity' });
    let current = await this.#ensureRunning(workspaceId, actorId, restoreRunId);
    if (current.state === 'running') current = await this.#project(workspaceId, restoreRunId, { state: 'validating', progress: { ...(current.progress || {}), phase: 'validating-cluster-identity', updatedAt: this.clock() } }, actorId);
    if (current.state !== 'validating') return current;
    const evidence = {
      ...rowDeleteEvidence(),
      sourceBackupName: prepared.metadata.operation.backupName,
      sourceBackupType: prepared.metadata.operation.backupType,
      backupWatermark: prepared.metadata.operation.watermark,
      backupWatermarkApplied: true,
      catalogRestored: true,
      checkpointAdvanced: true,
      identityRevalidated: true,
      clusterIdentity: publicIdentity(prepared.execution)
    };
    return this.#project(workspaceId, restoreRunId, {
      state: 'succeeded',
      progress: { ...(current.progress || {}), phase: 'complete', itemsCompleted: 1, updatedAt: this.clock() },
      validation: { state: 'succeeded', nativeRestoreStatus: 'completed', backupIdentity: 'succeeded', clusterIdentity: 'succeeded', identityRevalidated: true, rowDeleteStateCapturedByBackup: false, rowDeletesMayPersist: true, completedAt: this.clock() },
      result: { recoveryPointId: prepared.point.id, restoreId: remote.restore.id, backupName: prepared.metadata.operation.backupName, evidence, originalClusterModified: true, rollbackClaimed: false, reconciledAfterRestart: Boolean(reconciledAfterRestart), warnings: [ROW_DELETE_WARNING], completedAt: this.clock() }
    }, actorId);
  }

  async #ensureRunning(workspaceId, actorId, restoreRunId) {
    let current = await this.controlDatabase.repository('restoreRun').get(workspaceId, restoreRunId);
    if (current.state === 'queued') current = await this.#project(workspaceId, restoreRunId, { state: 'preparing', progress: { ...(current.progress || {}), phase: 'reconciling', updatedAt: this.clock() } }, actorId);
    if (current.state === 'preparing') current = await this.#project(workspaceId, restoreRunId, { state: 'running', progress: { ...(current.progress || {}), phase: 'reconciling', updatedAt: this.clock() } }, actorId);
    return current;
  }

  async #interruptTerminalFailure(workspaceId, actorId, restoreRunId, code, safeMessage) {
    const current = await this.controlDatabase.repository('restoreRun').get(workspaceId, restoreRunId);
    return this.#project(workspaceId, restoreRunId, { state: 'interrupted', progress: { ...(current.progress || {}), phase: 'operator-action-required', updatedAt: this.clock() }, result: { error: { code, category: 'restore', retryable: false, safeMessage }, originalClusterModified: true, rollbackClaimed: false, ...rowDeleteEvidence(), warnings: [ROW_DELETE_WARNING], completedAt: this.clock() } }, actorId);
  }

  #ownsRun(record) {
    return record?.target?.operation === RESTORE_OPERATION
      && record.target?.engine === 'influxdb3-enterprise'
      && record.target?.tier === SOURCE_TIER
      && record.mode === 'in-place';
  }

  async #project(workspaceId, restoreRunId, changes, actorId) {
    return this.controlDatabase.transaction((transaction) => {
      const current = transaction.get('restoreRun', workspaceId, restoreRunId);
      return transaction.projectExecution('restoreRun', workspaceId, restoreRunId, changes, { expectedRevision: current.revision, actorId });
    });
  }
}

module.exports = {
  InfluxDb3EnterpriseRestoreError,
  InfluxDb3EnterpriseRestoreService,
  MAX_ARTIFACTS,
  RESTORE_CONFIRMATION,
  RESTORE_OPERATION,
  ROW_DELETE_WARNING,
  SOURCE_TIER,
  normalizeRestoreRequest,
  rowDeleteEvidence
};
