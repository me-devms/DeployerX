const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { digestJson } = require('./database-adapter');
const { ADAPTER_ID, COPY_PHASES, RESTORE_CONFIRMATION, authenticateCapturedNode, normalizeRestoreSource } = require('./influxdb3-core');

const TERMINAL_STATES = new Set(['succeeded', 'warning', 'failed', 'canceled', 'interrupted']);
const RESTORE_OPERATION = 'influxdb3-core-alternate-filesystem-restore';
const S3_RESTORE_OPERATION = 'influxdb3-core-alternate-s3-restore';
const AZURE_RESTORE_OPERATION = 'influxdb3-core-alternate-azure-restore';
const GCS_RESTORE_OPERATION = 'influxdb3-core-alternate-gcs-restore';
const ARTIFACT_KIND_TO_OBJECT_STORE = Object.freeze({
  'influxdb3-core-filesystem-full': 'file',
  'influxdb3-core-s3-full': 's3',
  'influxdb3-core-azure-full': 'azure',
  'influxdb3-core-gcs-full': 'google'
});
const OBJECT_STORE_TO_ARTIFACT_KIND = Object.freeze(Object.fromEntries(Object.entries(ARTIFACT_KIND_TO_OBJECT_STORE).map(([kind, objectStore]) => [objectStore, kind])));
const RESTORE_OPERATIONS = new Set([RESTORE_OPERATION, S3_RESTORE_OPERATION, AZURE_RESTORE_OPERATION, GCS_RESTORE_OPERATION]);
const METADATA_PATH = 'influxdb3-core/backup-metadata.json';
const NATIVE_PREFIX = 'influxdb3-core/node/';
const MAX_ARTIFACTS = 1000;
const MAX_METADATA_BYTES = 32 * 1024 * 1024;

class InfluxDb3CoreRestoreError extends Error {
  constructor(code, safeMessage, options = {}) { super(safeMessage); this.name = 'InfluxDb3CoreRestoreError'; this.code = code; this.category = options.category || 'restore'; this.retryable = Boolean(options.retryable); }
}

function requiredText(value, label, maximumLength = 4096) { const text = String(value ?? '').trim(); if (!text || text.includes('\0') || text.length > maximumLength) throw new TypeError(`${label} is invalid.`); return text; }
function isCoreRestoreOperation(value) { return RESTORE_OPERATIONS.has(value); }
function mutationStarted(record) { return record?.target?.targetMutationStarted === true || record?.target?.filesystemMutationStarted === true; }
function artifactKindForObjectStore(objectStore) { return Object.prototype.hasOwnProperty.call(OBJECT_STORE_TO_ARTIFACT_KIND, objectStore) ? OBJECT_STORE_TO_ARTIFACT_KIND[objectStore] : null; }
function objectStoreForArtifactKind(kind) { return Object.prototype.hasOwnProperty.call(ARTIFACT_KIND_TO_OBJECT_STORE, kind) ? ARTIFACT_KIND_TO_OBJECT_STORE[kind] : null; }

function normalizeRequest(input = {}, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('InfluxDB 3 Core restore request must be an object.');
  if (String(input.mode || 'alternate') !== 'alternate') throw new InfluxDb3CoreRestoreError('INFLUXDB3_CORE_RESTORE_MODE_UNSUPPORTED', 'InfluxDB 3 Core recovery supports alternate stopped targets only.', { category: 'compatibility' });
  if (options.requireConfirmation !== false && (input.confirmed !== true || String(input.confirmationText || '').trim() !== RESTORE_CONFIRMATION)) throw new InfluxDb3CoreRestoreError('INFLUXDB3_CORE_RESTORE_CONFIRMATION_REQUIRED', 'Confirm the alternate stopped InfluxDB 3 Core recovery before continuing.', { category: 'conflict' });
  return { recoveryPointId: requiredText(input.recoveryPointId, 'RecoveryPoint ID', 200), targetConnectionId: requiredText(input.targetConnectionId, 'InfluxDB 3 Core target connection ID', 200), mode: 'alternate' };
}

function publicError(error) {
  if (error instanceof InfluxDb3CoreRestoreError || (error?.code && error?.category)) return { code: String(error.code).slice(0, 100), category: String(error.category || 'restore').slice(0, 80), retryable: Boolean(error.retryable), safeMessage: String(error.message || 'The InfluxDB 3 Core recovery failed.').slice(0, 500) };
  return { code: 'INFLUXDB3_CORE_RESTORE_FAILED', category: 'restore', retryable: false, safeMessage: 'DeployerX could not complete the InfluxDB 3 Core alternate recovery.' };
}

function digest(value) { return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`; }

function safeRelativePath(value) {
  const relative = requiredText(value, 'InfluxDB 3 Core native member path', 8192).replace(/\\/g, '/');
  if (relative.startsWith('/') || relative.endsWith('/') || relative.includes('//') || relative.split('/').some((segment) => !segment || segment === '.' || segment === '..') || path.posix.normalize(relative) !== relative || !COPY_PHASES.some((phase) => relative === phase.name || (phase.kind === 'directory' && relative.startsWith(`${phase.name}/`)))) throw new InfluxDb3CoreRestoreError('INFLUXDB3_CORE_RESTORE_MEDIA_INVALID', 'InfluxDB 3 Core recovery media contains an unsafe path.', { category: 'integrity' });
  return relative;
}

function restorePrefix(workspaceId, restoreRunId) { return `restore-${crypto.createHash('sha256').update(`${workspaceId}\0${restoreRunId}`).digest('hex').slice(0, 32)}-`; }

function publicSourceEvidence(source) {
  return Object.freeze({ product: source.product, productVersion: source.productVersion, objectStore: source.objectStore, nodeId: source.nodeId, deploymentFingerprint: source.deploymentFingerprint, consistency: source.consistency, nativeMedia: { fileCount: source.nativeMedia.fileCount, directoryCount: source.nativeMedia.directoryCount, totalBytes: source.nativeMedia.totalBytes, mediaFingerprint: source.nativeMedia.mediaFingerprint, directoryFingerprint: source.nativeMedia.directoryFingerprint } });
}

function publicTargetEvidence(target) {
  return Object.freeze({ productVersion: target.productVersion, deploymentFingerprint: target.deploymentFingerprint, dataRootFingerprint: target.dataRootFingerprint || null, storageFingerprint: target.storageFingerprint || null, nodeId: target.nodeId, objectStore: target.objectStore, endpointMustRemainStopped: true });
}

class InfluxDb3CoreRestoreService {
  constructor({ controlDatabase, deviceId, adapter, connectionService, openRepository, temporaryRoot = path.join(os.tmpdir(), 'deployerx-influxdb3-core-restores'), fileSystem = fs, clock = () => new Date().toISOString(), now = () => Date.now() } = {}) {
    if (!controlDatabase || !adapter || !connectionService || typeof openRepository !== 'function') throw new TypeError('InfluxDB 3 Core restore dependencies are required.');
    this.controlDatabase = controlDatabase; this.deviceId = requiredText(deviceId, 'Device ID', 200); this.adapter = adapter; this.connectionService = connectionService; this.openRepository = openRepository; this.temporaryRoot = path.resolve(requiredText(temporaryRoot, 'InfluxDB 3 Core restore temporary root')); this.fileSystem = fileSystem; this.clock = clock; this.now = now; this.active = new Map();
  }

  async preview(workspaceId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200); const request = normalizeRequest(input, { requireConfirmation: false });
    const executionId = `preview-${digest({ tenant, ...request }).slice(7, 39)}`;
    const prepared = await this.#prepare(tenant, request, executionId, input.signal);
    return { mode: 'alternate', recoveryPointId: prepared.point.id, targetConnectionId: prepared.targetConnection.id, sourceVersion: prepared.sourceEvidence.productVersion, targetVersion: prepared.plan.target.productVersion, nodeId: prepared.sourceEvidence.nodeId, objectStore: prepared.sourceEvidence.objectStore, consistency: prepared.point.consistency, fileCount: prepared.sourceEvidence.nativeMedia.fileCount, directoryCount: prepared.sourceEvidence.nativeMedia.directoryCount, totalBytes: prepared.sourceEvidence.nativeMedia.totalBytes, targetStopped: true, targetNodeAbsent: true, sourceDeploymentProtected: true, originalTargetReplacement: false, automaticStartup: false, ownershipReviewRequired: prepared.sourceEvidence.objectStore === 'file', operatorReviewRequired: true, nativeValidation: true, confirmationText: RESTORE_CONFIRMATION, warnings: prepared.point.consistency === 'crash' ? ['This ordered live-copy RecoveryPoint is crash-consistent and may omit writes after its latest included snapshot.'] : [], planDigest: digest({ recoveryPointId: prepared.point.id, targetConnectionId: prepared.targetConnection.id, source: publicSourceEvidence(prepared.sourceEvidence), target: prepared.plan.target }) };
  }

  async start(workspaceId, actorId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200); const actor = requiredText(actorId, 'Actor ID', 200); const request = normalizeRequest(input); const executionId = `restore-${crypto.randomUUID()}`;
    const prepared = await this.#prepare(tenant, request, executionId, input.signal); const now = this.clock();
    const record = await this.controlDatabase.repository('restoreRun').create({ workspaceId: tenant, actorId: actor, recoveryPointIds: [prepared.point.id], targetConnectionId: prepared.targetConnection.id, target: { operation: prepared.plan.operation, mode: 'alternate', engine: 'influxdb3-core', sourceId: prepared.source.id, targetConnectionId: prepared.targetConnection.id, targetDeploymentFingerprint: prepared.plan.target.deploymentFingerprint, targetPlanDigest: digest(prepared.plan.target), restoreExecutionId: executionId, targetMutationStarted: false, filesystemMutationStarted: false, mutationStartedAt: null, restoreEvidence: { source: publicSourceEvidence(prepared.sourceEvidence), target: publicTargetEvidence(prepared.plan.target) } }, mode: 'alternate', conflictPolicy: 'fail', workerId: `device:${this.deviceId}`, state: 'queued', progress: { phase: 'queued', itemsTotal: prepared.sourceEvidence.nativeMedia.fileCount, itemsCompleted: 0, bytesTotal: prepared.sourceEvidence.nativeMedia.totalBytes, bytesWritten: 0, throughputBytesPerSecond: 0, startedAt: null, updatedAt: now, warnings: prepared.point.consistency === 'crash' ? ['Crash-consistent source media'] : [] }, validation: null, result: null });
    const controller = new AbortController(); const operation = this.#execute(tenant, actor, record.id, request, executionId, controller.signal).catch(() => this.controlDatabase.repository('restoreRun').get(tenant, record.id));
    this.active.set(record.id, { operation, controller }); operation.finally(() => this.active.delete(record.id)); return record;
  }

  async wait(workspaceId, restoreRunId) { const tenant = requiredText(workspaceId, 'Workspace ID', 200); const id = requiredText(restoreRunId, 'RestoreRun ID', 200); if (this.active.has(id)) await this.active.get(id).operation; const record = await this.controlDatabase.repository('restoreRun').get(tenant, id); if (!record || !isCoreRestoreOperation(record.target?.operation) || record.target?.engine !== 'influxdb3-core') throw new InfluxDb3CoreRestoreError('INFLUXDB3_CORE_RESTORE_RUN_NOT_FOUND', 'The InfluxDB 3 Core RestoreRun was not found.', { category: 'not-found' }); return record; }

  async cancel(workspaceId, actorId, restoreRunId) { const tenant = requiredText(workspaceId, 'Workspace ID', 200); requiredText(actorId, 'Actor ID', 200); const id = requiredText(restoreRunId, 'RestoreRun ID', 200); const record = await this.controlDatabase.repository('restoreRun').get(tenant, id); if (!record || !isCoreRestoreOperation(record.target?.operation) || record.target?.engine !== 'influxdb3-core') throw new InfluxDb3CoreRestoreError('INFLUXDB3_CORE_RESTORE_RUN_NOT_FOUND', 'The InfluxDB 3 Core RestoreRun was not found.', { category: 'not-found' }); if (TERMINAL_STATES.has(record.state)) return record; const active = this.active.get(id); if (!active) throw new InfluxDb3CoreRestoreError('INFLUXDB3_CORE_RESTORE_NOT_ACTIVE', 'The InfluxDB 3 Core recovery is not active in this DeployerX process.', { category: 'conflict' }); active.controller.abort(); await active.operation; return this.controlDatabase.repository('restoreRun').get(tenant, id); }

  async list(workspaceId, options = {}) { return (await this.controlDatabase.repository('restoreRun').list(requiredText(workspaceId, 'Workspace ID', 200), { limit: Math.min(200, Math.max(1, Number(options.limit) || 50)) })).filter((record) => isCoreRestoreOperation(record.target?.operation) && record.target?.engine === 'influxdb3-core'); }

  async authenticateRecoveryPoint(workspaceId, recoveryPointId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200); const point = await this.controlDatabase.repository('recoveryPoint').get(tenant, requiredText(recoveryPointId, 'RecoveryPoint ID', 200));
    if (!point) throw new InfluxDb3CoreRestoreError('INFLUXDB3_CORE_RECOVERY_POINT_NOT_FOUND', 'The InfluxDB 3 Core RecoveryPoint was not found.', { category: 'not-found' });
    const source = await this.controlDatabase.repository('source').get(tenant, point.sourceId);
    if (!source || source.adapterId !== ADAPTER_ID || point.type !== 'full' || !['application', 'crash'].includes(point.consistency) || point.verification?.state !== 'succeeded' || point.retention?.deletionEligible === true || source.consistency?.backupMethod !== 'physical') throw new InfluxDb3CoreRestoreError('INFLUXDB3_CORE_RECOVERY_POINT_INVALID', 'Choose a retained and verified InfluxDB 3 Core full RecoveryPoint.', { category: 'validation' });
    const sourceObjectStore = String(source.physicalExecution?.objectStore || '');
    const expectedArtifactKind = artifactKindForObjectStore(sourceObjectStore);
    if (!expectedArtifactKind) throw new InfluxDb3CoreRestoreError('INFLUXDB3_CORE_RECOVERY_POINT_INVALID', 'The InfluxDB 3 Core RecoveryPoint uses an unsupported object-store identity.', { category: 'validation' });
    const artifacts = await this.controlDatabase.repository('artifact').list(tenant, { limit: MAX_ARTIFACTS });
    if (artifacts.length === MAX_ARTIFACTS) throw new InfluxDb3CoreRestoreError('INFLUXDB3_CORE_RESTORE_ARTIFACT_LIMIT', 'The InfluxDB 3 Core Artifact scan exceeds the bounded limit.', { category: 'capacity' });
    const candidates = (point.repositoryCopies || []).filter((copy) => copy.state === 'available').flatMap((copy) => artifacts.filter((item) => item.recoveryPointId === point.id && item.repositoryId === copy.repositoryId && item.kind === 'metadata' && item.metadata?.adapterId === ADAPTER_ID).map((artifact) => ({ copy, artifact })));
    const selected = candidates.find(({ artifact }) => artifact.metadata?.kind === expectedArtifactKind && artifact.metadata?.source?.objectStore === sourceObjectStore && artifact.metadata?.artifact?.restoreSupported === true);
    if (!selected && candidates.length) throw new InfluxDb3CoreRestoreError('INFLUXDB3_CORE_RESTORE_ARTIFACT_INVALID', 'The InfluxDB 3 Core metadata Artifact kind, object store, or restore approval is inconsistent.', { category: 'integrity' });
    if (!selected) throw new InfluxDb3CoreRestoreError('INFLUXDB3_CORE_RESTORE_REPOSITORY_UNAVAILABLE', 'No available repository contains the authenticated InfluxDB 3 Core backup.', { category: 'not-found' });
    const repositoryId = selected.copy.repositoryId; const opened = await this.openRepository(tenant, repositoryId); const snapshot = await opened.engine.openSnapshot({}, { repositoryId, snapshotId: selected.copy.engineSnapshotId, masterKey: opened.masterKey });
    if (snapshot.summary?.manifestKey !== selected.copy.manifestLocator || snapshot.summary?.manifestChecksum?.digest !== selected.copy.manifestChecksum?.digest) throw new InfluxDb3CoreRestoreError('INFLUXDB3_CORE_RESTORE_MANIFEST_INVALID', 'The repository manifest no longer matches the InfluxDB 3 Core RecoveryPoint.', { category: 'integrity' });
    const locatorParts = String(selected.artifact.locator || '').split('#'); const locatorPath = decodeURIComponent(locatorParts.slice(1).join('#')); const metadataFile = (snapshot.manifest.files || []).find((file) => file.type === 'file' && file.path === locatorPath);
    if (locatorParts.length !== 2 || locatorPath !== METADATA_PATH || !metadataFile || metadataFile.sizeBytes !== selected.artifact.sizeBytes || metadataFile.sizeBytes < 1 || metadataFile.sizeBytes > MAX_METADATA_BYTES || metadataFile.contentDigest?.digest !== selected.artifact.checksum?.digest || metadataFile.metadata?.artifactKind !== 'metadata' || metadataFile.metadata?.database?.adapterId !== ADAPTER_ID) throw new InfluxDb3CoreRestoreError('INFLUXDB3_CORE_RESTORE_ARTIFACT_INVALID', 'The InfluxDB 3 Core metadata Artifact is incomplete or inconsistent.', { category: 'integrity' });
    let metadata;
    try { metadata = JSON.parse((await opened.engine.readFile({}, { repositoryId, manifest: snapshot.manifest, path: METADATA_PATH, masterKey: opened.masterKey })).toString('utf8')); } catch { throw new InfluxDb3CoreRestoreError('INFLUXDB3_CORE_RESTORE_ARTIFACT_INVALID', 'The authenticated InfluxDB 3 Core metadata cannot be decoded.', { category: 'integrity' }); }
    const metadataObjectStore = objectStoreForArtifactKind(metadata.kind);
    if (digestJson(metadata) !== digestJson(selected.artifact.metadata) || !metadataObjectStore || metadata.kind !== expectedArtifactKind || metadataObjectStore !== metadata.source?.objectStore || metadata.adapterId !== ADAPTER_ID || metadata.sourceId !== source.id || metadata.selectionDigest !== source.selector?.digest || metadata.backupMethod !== 'physical' || metadata.backupMode !== 'full' || metadata.artifact?.path !== METADATA_PATH || metadata.artifact?.restoreSupported !== true || metadata.source?.objectStore !== sourceObjectStore || metadata.source?.deploymentFingerprint !== source.physicalExecution?.deploymentFingerprint || metadata.source?.storageFingerprint !== source.physicalExecution?.storageFingerprint || metadata.capture?.achievedConsistency !== point.consistency || digestJson(metadata.capture?.copyOrder) !== digestJson(COPY_PHASES.map((phase) => phase.name)) || digestJson(metadata.capture?.excluded) !== digestJson(['table-snapshots/'])) throw new InfluxDb3CoreRestoreError('INFLUXDB3_CORE_RESTORE_ARTIFACT_INVALID', 'Authenticated InfluxDB 3 Core metadata is inconsistent with its Source and RecoveryPoint.', { category: 'integrity' });
    let sourceEvidence;
    try { sourceEvidence = normalizeRestoreSource({ product: metadata.source.product, productVersion: metadata.source.productVersion, objectStore: metadata.source.objectStore, nodeId: metadata.source.nodeId, deploymentFingerprint: metadata.source.deploymentFingerprint, consistency: point.consistency, restoreSupported: metadata.artifact.restoreSupported, nativeMedia: metadata.nativeMedia }); } catch (error) { throw new InfluxDb3CoreRestoreError(error.code || 'INFLUXDB3_CORE_RESTORE_MEDIA_INVALID', error.message, { category: error.category || 'integrity' }); }
    const seen = new Set(); const memberByPath = new Map(sourceEvidence.nativeMedia.members.map((member) => [member.relativePath, member]));
    const members = (metadata.nativeMedia.members || []).map((raw) => {
      const relativePath = safeRelativePath(raw.relativePath); const normalized = memberByPath.get(relativePath); const repositoryPath = `${NATIVE_PREFIX}${sourceEvidence.nodeId}/${relativePath}`;
      if (!normalized || raw.path !== repositoryPath || seen.has(relativePath)) throw new InfluxDb3CoreRestoreError('INFLUXDB3_CORE_RESTORE_MEDIA_INVALID', 'InfluxDB 3 Core media evidence is malformed or duplicated.', { category: 'integrity' });
      seen.add(relativePath); const file = snapshot.manifest.files.find((candidate) => candidate.type === 'file' && candidate.path === repositoryPath);
      if (!file || file.sizeBytes !== normalized.sizeBytes || file.metadata?.artifactKind !== 'physical-backup-member' || file.metadata?.nativeRelativePath !== relativePath || file.metadata?.contentDigest !== normalized.contentDigest) throw new InfluxDb3CoreRestoreError('INFLUXDB3_CORE_RESTORE_MEDIA_INVALID', 'An InfluxDB 3 Core member is missing or inconsistent in the repository manifest.', { category: 'integrity' });
      return Object.freeze({ ...normalized, repositoryPath, file });
    }).sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en-US'));
    const nativeFiles = snapshot.manifest.files.filter((file) => file.type === 'file' && file.path.startsWith(`${NATIVE_PREFIX}${sourceEvidence.nodeId}/`));
    if (members.length !== sourceEvidence.nativeMedia.fileCount || nativeFiles.length !== members.length || snapshot.manifest.files.filter((file) => file.type === 'file').length !== members.length + 1) throw new InfluxDb3CoreRestoreError('INFLUXDB3_CORE_RESTORE_MEDIA_INVALID', 'The complete InfluxDB 3 Core repository media set failed authentication.', { category: 'integrity' });
    return { point, source, repositoryId, opened, snapshot, artifact: selected.artifact, metadata, sourceEvidence, members };
  }

  async verifyRecoveryPointMedia(selected, signal) {
    const verified = []; let totalBytes = 0;
    for (const member of selected.members || []) {
      if (signal?.aborted) throw new InfluxDb3CoreRestoreError('INFLUXDB3_CORE_VERIFICATION_CANCELED', 'InfluxDB 3 Core media verification was canceled.', { category: 'canceled' });
      const hash = crypto.createHash('sha256'); let sizeBytes = 0;
      for await (const raw of selected.opened.engine.streamFile({}, { repositoryId: selected.repositoryId, manifest: selected.snapshot.manifest, path: member.repositoryPath, masterKey: selected.opened.masterKey })) { if (signal?.aborted) throw new InfluxDb3CoreRestoreError('INFLUXDB3_CORE_VERIFICATION_CANCELED', 'InfluxDB 3 Core media verification was canceled.', { category: 'canceled' }); const chunk = Buffer.from(raw); hash.update(chunk); sizeBytes += chunk.length; }
      const contentDigest = `sha256:${hash.digest('hex')}`; if (sizeBytes !== member.sizeBytes || contentDigest !== member.contentDigest) throw new InfluxDb3CoreRestoreError('INFLUXDB3_CORE_RESTORE_MEDIA_INVALID', 'An InfluxDB 3 Core repository member failed end-to-end verification.', { category: 'integrity' });
      verified.push({ relativePath: member.relativePath, sizeBytes, contentDigest }); totalBytes += sizeBytes;
    }
    if (verified.length !== selected.sourceEvidence.nativeMedia.fileCount || totalBytes !== selected.sourceEvidence.nativeMedia.totalBytes || digest(verified) !== selected.sourceEvidence.nativeMedia.mediaFingerprint) throw new InfluxDb3CoreRestoreError('INFLUXDB3_CORE_RESTORE_MEDIA_INVALID', 'The complete InfluxDB 3 Core repository media set failed end-to-end verification.', { category: 'integrity' });
    return Object.freeze({ fileCount: verified.length, directoryCount: selected.sourceEvidence.nativeMedia.directoryCount, totalBytes, mediaFingerprint: digest(verified), directoryFingerprint: selected.sourceEvidence.nativeMedia.directoryFingerprint });
  }

  async reconcile(workspaceId, actorId = 'system') {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200); const recovered = [];
    for (const record of (await this.list(tenant, { limit: 200 })).filter((item) => !TERMINAL_STATES.has(item.state) && !this.active.has(item.id))) {
      await this.#cleanupOwnedDirectories(tenant, record.id).catch(() => {});
      let validation = null; let reconciliationError = null;
      if (mutationStarted(record)) {
        try {
          const authenticated = await this.authenticateRecoveryPoint(tenant, record.recoveryPointIds?.[0]); const connection = await this.controlDatabase.repository('connection').get(tenant, record.targetConnectionId);
          if (!this.#validTargetConnection(connection, authenticated.sourceEvidence)) throw new InfluxDb3CoreRestoreError('INFLUXDB3_CORE_RESTORE_TARGET_CONNECTION_INVALID', 'The InfluxDB 3 Core restore target connection is unavailable or no longer matches the authenticated provider identity.', { category: 'connectivity' });
          validation = await this.connectionService.withExecution(tenant, connection, undefined, (context, config) => this.adapter.validateRestore(context, { plan: { operation: record.target.operation, connection: config, executionId: record.target.restoreExecutionId, source: authenticated.sourceEvidence, target: record.target.restoreEvidence?.target } }));
        } catch (error) { reconciliationError = publicError(error); }
      }
      if (validation?.valid === true) {
        let current = await this.controlDatabase.repository('restoreRun').get(tenant, record.id);
        if (current.state === 'queued') current = await this.#project(tenant, record.id, { state: 'preparing', progress: { ...(current.progress || {}), phase: 'reconciling', updatedAt: this.clock() } }, actorId);
        if (current.state === 'preparing') current = await this.#project(tenant, record.id, { state: 'running', progress: { ...(current.progress || {}), phase: 'reconciling', updatedAt: this.clock() } }, actorId);
        if (current.state === 'running') current = await this.#project(tenant, record.id, { state: 'validating', progress: { ...(current.progress || {}), phase: 'validating', updatedAt: this.clock() } }, actorId);
        recovered.push(await this.#project(tenant, record.id, { state: 'succeeded', progress: { ...(current.progress || {}), phase: 'complete', itemsCompleted: validation.fileCount, bytesWritten: validation.totalBytes, updatedAt: this.clock() }, validation: this.#validationRecord(validation), result: { reconciledAfterRestart: true, nodeId: validation.nodeId, objectStore: validation.objectStore || record.target.restoreEvidence?.target?.objectStore || 'file', fileCount: validation.fileCount, directoryCount: validation.directoryCount, bytesRestored: validation.totalBytes, targetPreserved: true, targetStopped: true, automaticStartup: false, ownershipReviewRequired: (validation.objectStore || record.target.restoreEvidence?.target?.objectStore || 'file') === 'file', operatorReviewRequired: true, rollbackClaimed: false, warnings: [], completedAt: this.clock() } }, actorId));
      } else {
        const mutated = mutationStarted(record);
        recovered.push(await this.#project(tenant, record.id, { state: mutated ? 'interrupted' : 'failed', progress: { ...(record.progress || {}), phase: mutated ? 'operator-action-required' : 'failed', updatedAt: this.clock() }, result: { reconciliationError, error: { code: mutated ? 'INFLUXDB3_CORE_RESTORE_INTERRUPTED_AFTER_MUTATION' : 'INFLUXDB3_CORE_RESTORE_PROCESS_INTERRUPTED', category: 'restore', retryable: false, safeMessage: mutated ? 'InfluxDB 3 Core recovery was interrupted after target mutation began. The installed node or partial target objects are preserved for inspection and no rollback is claimed.' : 'InfluxDB 3 Core recovery was interrupted before target mutation began.' }, targetPreserved: mutated, rollbackClaimed: false, completedAt: this.clock() } }, actorId));
      }
    }
    return recovered;
  }

  #validTargetConnection(connection, sourceEvidence = null) {
    const identity = connection?.lastTest?.endpointIdentity;
    const identityStore = identity?.objectStore; const trustStore = connection?.trust?.objectStore; const endpointStore = connection?.endpoint?.objectStore || (identityStore === 'file' && trustStore === 'file' ? 'file' : null);
    const exactSource = !sourceEvidence || (identityStore === sourceEvidence.objectStore && identity?.version === sourceEvidence.productVersion && identity?.nodeId === sourceEvidence.nodeId && identity?.deploymentFingerprint !== sourceEvidence.deploymentFingerprint);
    return connection?.adapterId === ADAPTER_ID && connection.lastTest?.status === 'success' && Boolean(artifactKindForObjectStore(identityStore)) && identity?.restoreSupported === true && Boolean(connection.trust?.fingerprint) && connection.trust.fingerprint === connection.endpoint?.expectedDeploymentFingerprint && identity?.deploymentFingerprint === connection.trust.fingerprint && identity?.version === connection.endpoint?.expectedVersion && identity?.nodeId === connection.endpoint?.nodeId && identity?.storageFingerprint === connection.trust?.storageFingerprint && identity?.storageFingerprint === connection.endpoint?.expectedStorageFingerprint && identityStore === trustStore && identityStore === endpointStore && identity?.dataRootFingerprint === connection.trust?.dataRootFingerprint && (connection.workerAffinity || []).includes(`device:${this.deviceId}`) && exactSource;
  }

  async #prepare(workspaceId, request, executionId, signal) {
    const authenticated = await this.authenticateRecoveryPoint(workspaceId, request.recoveryPointId); const targetConnection = await this.controlDatabase.repository('connection').get(workspaceId, request.targetConnectionId);
    if (!this.#validTargetConnection(targetConnection, authenticated.sourceEvidence)) throw new InfluxDb3CoreRestoreError('INFLUXDB3_CORE_RESTORE_TARGET_CONNECTION_INVALID', 'Choose a separately tested InfluxDB 3 Core target with the exact provider, version, node, and storage identity on this device.', { category: 'connectivity', retryable: true });
    const targetIdentity = { version: targetConnection.lastTest.endpointIdentity.version, deploymentFingerprint: targetConnection.lastTest.endpointIdentity.deploymentFingerprint, dataRootFingerprint: targetConnection.lastTest.endpointIdentity.dataRootFingerprint, storageFingerprint: targetConnection.lastTest.endpointIdentity.storageFingerprint, objectStore: targetConnection.lastTest.endpointIdentity.objectStore, nodeId: targetConnection.lastTest.endpointIdentity.nodeId };
    const plan = await this.connectionService.withExecution(workspaceId, targetConnection, signal, (context, connection) => this.adapter.planRestore(context, { mode: 'alternate', confirmation: RESTORE_CONFIRMATION, connection, source: authenticated.sourceEvidence, targetIdentity, executionId }));
    return { ...authenticated, targetConnection, plan };
  }

  async #materialize(workspaceId, restoreRunId, authenticated, signal, onProgress) {
    await this.fileSystem.mkdir(this.temporaryRoot, { recursive: true, mode: 0o700 }); await this.fileSystem.chmod(this.temporaryRoot, 0o700).catch(() => {});
    const directory = await this.fileSystem.mkdtemp(path.join(this.temporaryRoot, restorePrefix(workspaceId, restoreRunId))); const nodeDirectory = path.join(directory, 'node');
    try {
      await this.fileSystem.chmod(directory, 0o700).catch(() => {}); await this.fileSystem.writeFile(path.join(directory, '.owner.json'), JSON.stringify({ version: 1, workspaceId, restoreRunId }), { flag: 'wx', mode: 0o600 }); await this.fileSystem.mkdir(nodeDirectory, { mode: 0o700 });
      for (const relative of authenticated.sourceEvidence.nativeMedia.directories) await this.fileSystem.mkdir(path.join(nodeDirectory, ...relative.split('/')), { recursive: true, mode: 0o700 });
      let bytesWritten = 0; let itemsCompleted = 0;
      for (const member of authenticated.members) {
        if (signal?.aborted) throw new InfluxDb3CoreRestoreError('INFLUXDB3_CORE_RESTORE_CANCELED', 'InfluxDB 3 Core recovery was canceled before target mutation.', { category: 'canceled' });
        const destination = path.resolve(nodeDirectory, ...member.relativePath.split('/')); if (!destination.startsWith(`${nodeDirectory}${path.sep}`)) throw new InfluxDb3CoreRestoreError('INFLUXDB3_CORE_RESTORE_MEDIA_INVALID', 'InfluxDB 3 Core media escaped the owned source stage.', { category: 'integrity' });
        await this.fileSystem.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 }); const handle = await this.fileSystem.open(destination, 'wx', 0o600); const hash = crypto.createHash('sha256'); let sizeBytes = 0;
        try {
          for await (const raw of authenticated.opened.engine.streamFile({}, { repositoryId: authenticated.repositoryId, manifest: authenticated.snapshot.manifest, path: member.repositoryPath, masterKey: authenticated.opened.masterKey })) {
            if (signal?.aborted) throw new InfluxDb3CoreRestoreError('INFLUXDB3_CORE_RESTORE_CANCELED', 'InfluxDB 3 Core recovery was canceled before target mutation.', { category: 'canceled' });
            const chunk = Buffer.from(raw); let offset = 0; while (offset < chunk.length) { const written = (await handle.write(chunk, offset, chunk.length - offset)).bytesWritten; if (!Number.isInteger(written) || written < 1) throw new InfluxDb3CoreRestoreError('INFLUXDB3_CORE_RESTORE_MEDIA_INVALID', 'InfluxDB 3 Core source staging could not write an authenticated member.', { category: 'integrity' }); offset += written; }
            hash.update(chunk); sizeBytes += chunk.length; bytesWritten += chunk.length; await onProgress?.({ bytesWritten, itemsCompleted });
          }
          await handle.sync();
        } finally { await handle.close(); }
        const contentDigest = `sha256:${hash.digest('hex')}`; if (sizeBytes !== member.sizeBytes || contentDigest !== member.contentDigest) throw new InfluxDb3CoreRestoreError('INFLUXDB3_CORE_RESTORE_MEDIA_INVALID', 'A materialized InfluxDB 3 Core member failed authentication.', { category: 'integrity' });
        itemsCompleted += 1; await onProgress?.({ bytesWritten, itemsCompleted });
      }
      await authenticateCapturedNode(nodeDirectory, authenticated.sourceEvidence); return { directory, nodeDirectory };
    } catch (error) { await this.fileSystem.rm(directory, { recursive: true, force: true }).catch(() => {}); throw error; }
  }

  async #cleanupOwnedDirectory(workspaceId, restoreRunId, directory) { const owner = await this.fileSystem.readFile(path.join(directory, '.owner.json'), 'utf8').then(JSON.parse).catch(() => null); if (owner?.version !== 1 || owner.workspaceId !== workspaceId || owner.restoreRunId !== restoreRunId) throw new InfluxDb3CoreRestoreError('INFLUXDB3_CORE_RESTORE_CLEANUP_UNPROVEN', 'InfluxDB 3 Core source-stage ownership could not be proven.', { category: 'integrity' }); await this.fileSystem.rm(directory, { recursive: true, force: true }); }
  async #cleanupOwnedDirectories(workspaceId, restoreRunId) { const prefix = restorePrefix(workspaceId, restoreRunId); const entries = await this.fileSystem.readdir(this.temporaryRoot, { withFileTypes: true }).catch((error) => error?.code === 'ENOENT' ? [] : Promise.reject(error)); let removed = 0; for (const entry of entries.slice(0, 10000)) { if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue; await this.#cleanupOwnedDirectory(workspaceId, restoreRunId, path.join(this.temporaryRoot, entry.name)); removed += 1; } return removed; }
  #validationRecord(validation) { return { state: validation.status, connectivity: 'stopped-as-required', expectedObjects: 'succeeded', nativeIntegrityValidation: true, checks: validation.checks || [], completedAt: this.clock() }; }

  async #execute(workspaceId, actorId, restoreRunId, request, executionId, signal) {
    let progress = { phase: 'preparing', itemsTotal: 0, itemsCompleted: 0, bytesTotal: 0, bytesWritten: 0, throughputBytesPerSecond: 0, startedAt: this.clock(), updatedAt: this.clock(), warnings: [] }; let staging = null;
    try {
      await this.#project(workspaceId, restoreRunId, { state: 'preparing', progress }, actorId); const prepared = await this.#prepare(workspaceId, request, executionId, signal); const admitted = await this.controlDatabase.repository('restoreRun').get(workspaceId, restoreRunId);
      if (admitted.target?.targetPlanDigest !== digest(prepared.plan.target)) throw new InfluxDb3CoreRestoreError('INFLUXDB3_CORE_RESTORE_TARGET_CHANGED', 'The alternate InfluxDB 3 Core target changed after restore admission.', { category: 'integrity' });
      progress = { ...progress, itemsTotal: prepared.members.length, bytesTotal: prepared.sourceEvidence.nativeMedia.totalBytes, phase: 'materializing', updatedAt: this.clock() }; let lastProjection = this.now(); let projectedItems = 0;
      staging = await this.#materialize(workspaceId, restoreRunId, prepared, signal, async (update) => { progress = { ...progress, ...update, updatedAt: this.clock() }; const currentTime = this.now(); if (update.itemsCompleted === projectedItems && currentTime - lastProjection < 1000) return; const current = await this.controlDatabase.repository('restoreRun').get(workspaceId, restoreRunId); if (current?.state === 'preparing') { await this.#project(workspaceId, restoreRunId, { progress }, actorId); lastProjection = currentTime; projectedItems = update.itemsCompleted; } });
      const outcome = await this.connectionService.withExecution(workspaceId, prepared.targetConnection, signal, async (context, connection) => {
        const targetIdentity = { version: prepared.targetConnection.lastTest.endpointIdentity.version, deploymentFingerprint: prepared.targetConnection.lastTest.endpointIdentity.deploymentFingerprint, dataRootFingerprint: prepared.targetConnection.lastTest.endpointIdentity.dataRootFingerprint, storageFingerprint: prepared.targetConnection.lastTest.endpointIdentity.storageFingerprint, objectStore: prepared.targetConnection.lastTest.endpointIdentity.objectStore, nodeId: prepared.targetConnection.lastTest.endpointIdentity.nodeId };
        const plan = await this.adapter.planRestore(context, { mode: 'alternate', confirmation: RESTORE_CONFIRMATION, connection, source: prepared.sourceEvidence, targetIdentity, executionId });
        if (digest(plan.target) !== digest(prepared.plan.target)) throw new InfluxDb3CoreRestoreError('INFLUXDB3_CORE_RESTORE_TARGET_CHANGED', 'The alternate InfluxDB 3 Core target changed before restore.', { category: 'integrity' });
        const restored = await this.adapter.executeRestore({ ...context, signal, sourceDirectory: staging.nodeDirectory, onProgress: async (event) => { progress = { ...progress, phase: 'restoring', currentComponent: event.component, updatedAt: this.clock() }; }, onMutationStarted: async () => { progress = { ...progress, phase: 'restoring', updatedAt: this.clock() }; const current = await this.controlDatabase.repository('restoreRun').get(workspaceId, restoreRunId); await this.#project(workspaceId, restoreRunId, { state: 'running', progress, target: { ...(current.target || {}), targetMutationStarted: true, filesystemMutationStarted: plan.target.objectStore === 'file', mutationStartedAt: this.clock() } }, actorId); } }, plan);
        progress = { ...progress, phase: 'validating', itemsCompleted: prepared.members.length, bytesWritten: prepared.sourceEvidence.nativeMedia.totalBytes, updatedAt: this.clock() }; await this.#project(workspaceId, restoreRunId, { state: 'validating', progress }, actorId); return restored.validation;
      });
      await this.#cleanupOwnedDirectory(workspaceId, restoreRunId, staging.directory); staging = null; progress = { ...progress, phase: 'complete', updatedAt: this.clock() };
      return this.#project(workspaceId, restoreRunId, { state: 'succeeded', progress, validation: this.#validationRecord(outcome), result: { recoveryPointId: prepared.point.id, nodeId: outcome.nodeId, objectStore: outcome.objectStore || prepared.sourceEvidence.objectStore, fileCount: outcome.fileCount, directoryCount: outcome.directoryCount, bytesRestored: outcome.totalBytes, targetPreserved: true, targetStopped: true, automaticStartup: false, ownershipReviewRequired: prepared.sourceEvidence.objectStore === 'file', operatorReviewRequired: true, rollbackClaimed: false, warnings: prepared.point.consistency === 'crash' ? ['The restored RecoveryPoint is crash-consistent.'] : [], completedAt: this.clock() } }, actorId);
    } catch (error) {
      if (staging) await this.#cleanupOwnedDirectory(workspaceId, restoreRunId, staging.directory).catch(() => {});
      const current = await this.controlDatabase.repository('restoreRun').get(workspaceId, restoreRunId);
      if (current && !TERMINAL_STATES.has(current.state)) { const canceled = signal.aborted || error?.code === 'INFLUXDB3_CORE_RESTORE_CANCELED'; const mutated = mutationStarted(current); const state = mutated ? 'interrupted' : canceled ? 'canceled' : 'failed'; const safe = mutated ? { code: 'INFLUXDB3_CORE_RESTORE_TARGET_REQUIRES_INSPECTION', category: 'restore', retryable: false, safeMessage: 'InfluxDB 3 Core target mutation began but recovery did not finish. The installed node or partial target objects are preserved for inspection and no rollback is claimed.' } : canceled ? { code: 'INFLUXDB3_CORE_RESTORE_CANCELED', category: 'canceled', retryable: false, safeMessage: 'InfluxDB 3 Core recovery was canceled before target mutation began.' } : publicError(error); return this.#project(workspaceId, restoreRunId, { state, progress: { ...progress, phase: mutated ? 'operator-action-required' : state, updatedAt: this.clock() }, result: { error: safe, targetPreserved: mutated, rollbackClaimed: false, completedAt: this.clock() } }, actorId); }
      throw error;
    }
  }

  async #project(workspaceId, id, changes, actorId) { return this.controlDatabase.transaction((transaction) => { const current = transaction.get('restoreRun', workspaceId, id); return transaction.projectExecution('restoreRun', workspaceId, id, changes, { expectedRevision: current.revision, actorId }); }); }
}

module.exports = { ARTIFACT_KIND_TO_OBJECT_STORE, AZURE_RESTORE_OPERATION, GCS_RESTORE_OPERATION, InfluxDb3CoreRestoreError, InfluxDb3CoreRestoreService, METADATA_PATH, NATIVE_PREFIX, OBJECT_STORE_TO_ARTIFACT_KIND, RESTORE_CONFIRMATION, RESTORE_OPERATION, S3_RESTORE_OPERATION, artifactKindForObjectStore, normalizeRequest, objectStoreForArtifactKind, restorePrefix };
