const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { digestJson } = require('./database-adapter');
const { ADAPTER_ID, MAX_NODES } = require('./influxdb3-enterprise');
const {
  RESTORE_CONFIRMATION,
  authenticateLegacyFilesystem,
  normalizeLegacyMedia,
  normalizeLegacyTopology,
  restoreLegacyFilesystem
} = require('./influxdb3-enterprise-legacy');
const {
  ARTIFACT_KIND,
  MEDIA_PREFIX,
  METADATA_PATH,
  SOURCE_TIER,
  isLegacyFilesystemSource,
  normalizeLegacySourceExecution,
  normalizeLegacySourceStorage,
  repositoryPath
} = require('./influxdb3-enterprise-legacy-source-reader');

const RESTORE_OPERATION = 'influxdb3-enterprise-legacy-alternate-filesystem-restore';
const RESTORE_STAGE_KIND = 'influxdb3-enterprise-legacy-restore-stage';
const TERMINAL_STATES = new Set(['succeeded', 'warning', 'failed', 'canceled', 'interrupted']);
const MAX_ARTIFACTS = 1000;
const MAX_METADATA_BYTES = 32 * 1024 * 1024;
const MAX_STAGE_DIRECTORIES = 10000;
const MAX_STOP_PROOF_CHECKS = 64;
const MAX_STOP_PROOF_AGE_MS = 5 * 60 * 1000;

class InfluxDb3EnterpriseLegacyRestoreError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'InfluxDb3EnterpriseLegacyRestoreError';
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
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function restorePrefix(workspaceId, restoreRunId) {
  return `legacy-restore-${crypto.createHash('sha256').update(`${workspaceId}\0${restoreRunId}`).digest('hex').slice(0, 32)}-`;
}

function pathsOverlap(left, right) {
  const relative = path.relative(left, right);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function topologyInput(topology) {
  return { dataRoot: topology.dataRoot, clusterId: topology.clusterId, compactorNodeId: topology.compactorNodeId, dataNodeIds: topology.dataNodeIds };
}

function normalizeRestoreRequest(input = {}, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('InfluxDB 3 Enterprise legacy restore request must be an object.');
  const allowed = ['recoveryPointId', 'targetConnectionId', 'mode', 'target', 'confirmed', 'confirmationText', 'signal'];
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new TypeError(`Unknown InfluxDB 3 Enterprise legacy restore field: ${unknown[0]}.`);
  if (String(input.mode || 'alternate') !== 'alternate') throw new InfluxDb3EnterpriseLegacyRestoreError('INFLUXDB3_ENTERPRISE_LEGACY_RESTORE_MODE_UNSUPPORTED', 'InfluxDB 3 Enterprise legacy recovery supports an empty alternate local target only.', { category: 'compatibility' });
  if (options.requireConfirmation !== false && (input.confirmed !== true || input.confirmationText !== RESTORE_CONFIRMATION)) throw new InfluxDb3EnterpriseLegacyRestoreError('INFLUXDB3_ENTERPRISE_LEGACY_RESTORE_CONFIRMATION_REQUIRED', 'InfluxDB 3 Enterprise legacy recovery requires the exact destructive-operation confirmation.', { category: 'conflict' });
  if (!input.target || typeof input.target !== 'object' || Array.isArray(input.target)) throw new TypeError('InfluxDB 3 Enterprise legacy restore target must be an object.');
  const targetAllowed = ['kind', 'dataRoot', 'clusterId', 'compactorNodeId', 'dataNodeIds'];
  const targetUnknown = Object.keys(input.target).filter((key) => !targetAllowed.includes(key));
  if (targetUnknown.length) throw new TypeError(`Unknown InfluxDB 3 Enterprise legacy restore target field: ${targetUnknown[0]}.`);
  if (input.target.kind !== 'local-filesystem') throw new InfluxDb3EnterpriseLegacyRestoreError('INFLUXDB3_ENTERPRISE_LEGACY_RESTORE_TARGET_UNSUPPORTED', 'InfluxDB 3 Enterprise legacy recovery supports a local filesystem target only.', { category: 'compatibility' });
  const { kind: _kind, ...targetInput } = input.target;
  const target = normalizeLegacyTopology(targetInput);
  return Object.freeze({
    recoveryPointId: requiredText(input.recoveryPointId, 'RecoveryPoint ID', 200),
    targetConnectionId: requiredText(input.targetConnectionId, 'InfluxDB 3 Enterprise target connection ID', 200),
    mode: 'alternate',
    target: Object.freeze({ kind: 'local-filesystem', ...topologyInput(target) })
  });
}

function containsAbsolutePath(value) {
  if (typeof value === 'string') return path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value);
  if (Array.isArray(value)) return value.some(containsAbsolutePath);
  if (value && typeof value === 'object') return Object.values(value).some(containsAbsolutePath);
  return false;
}

function publicError(error) {
  if (error instanceof InfluxDb3EnterpriseLegacyRestoreError || (error?.code && error?.category)) {
    return {
      code: String(error.code || 'INFLUXDB3_ENTERPRISE_LEGACY_RESTORE_FAILED').slice(0, 120),
      category: String(error.category || 'restore').slice(0, 80),
      retryable: Boolean(error.retryable),
      safeMessage: String(error.message || 'InfluxDB 3 Enterprise legacy recovery failed.').slice(0, 500)
    };
  }
  return {
    code: 'INFLUXDB3_ENTERPRISE_LEGACY_RESTORE_FAILED',
    category: 'restore',
    retryable: false,
    safeMessage: 'DeployerX could not complete the InfluxDB 3 Enterprise legacy alternate recovery.'
  };
}

function stopProofTimestamp(value, label) {
  const text = requiredText(value, label, 40);
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== text) throw new InfluxDb3EnterpriseLegacyRestoreError('INFLUXDB3_ENTERPRISE_LEGACY_STOP_PROOF_INVALID', 'The authenticated cluster stop proof is malformed.', { category: 'integrity' });
  return { text, milliseconds: parsed.getTime() };
}

function normalizeClusterStopProof(proof, expectedNodeIds, nowValue) {
  if (!proof || typeof proof !== 'object' || Array.isArray(proof) || proof.stopped !== true) {
    throw new InfluxDb3EnterpriseLegacyRestoreError('INFLUXDB3_ENTERPRISE_LEGACY_CLUSTER_RUNNING', 'Every alternate InfluxDB 3 Enterprise target node must remain stopped.', { category: 'consistency' });
  }
  const allowedProofKeys = ['stopped', 'nodes', 'issuedAt', 'proofDigest'];
  if (Object.keys(proof).some((key) => !allowedProofKeys.includes(key)) || !Array.isArray(proof.nodes) || !proof.nodes.length || proof.nodes.length > MAX_NODES) {
    throw new InfluxDb3EnterpriseLegacyRestoreError('INFLUXDB3_ENTERPRISE_LEGACY_STOP_PROOF_INVALID', 'The authenticated cluster stop proof is malformed.', { category: 'integrity' });
  }
  const expected = [...expectedNodeIds].map((nodeId) => requiredText(nodeId, 'InfluxDB 3 Enterprise target node ID', 200)).sort((left, right) => left.localeCompare(right, 'en-US'));
  if (!expected.length || expected.length > MAX_NODES || new Set(expected).size !== expected.length) throw new InfluxDb3EnterpriseLegacyRestoreError('INFLUXDB3_ENTERPRISE_LEGACY_STOP_PROOF_INVALID', 'The expected cluster stop-proof node set is invalid.', { category: 'integrity' });
  const now = stopProofTimestamp(nowValue, 'Cluster stop-proof validation time');
  const issuedAt = stopProofTimestamp(proof.issuedAt, 'Cluster stop-proof issue time');
  if (issuedAt.milliseconds > now.milliseconds + MAX_STOP_PROOF_AGE_MS || now.milliseconds - issuedAt.milliseconds > MAX_STOP_PROOF_AGE_MS) {
    throw new InfluxDb3EnterpriseLegacyRestoreError('INFLUXDB3_ENTERPRISE_LEGACY_STOP_PROOF_STALE', 'The authenticated cluster stop proof is stale.', { category: 'integrity', retryable: true });
  }
  const proofDigest = requiredText(proof.proofDigest, 'Cluster stop-proof digest', 80).toLowerCase();
  if (!/^hmac-sha256:[0-9a-f]{64}$/.test(proofDigest)) throw new InfluxDb3EnterpriseLegacyRestoreError('INFLUXDB3_ENTERPRISE_LEGACY_STOP_PROOF_INVALID', 'The authenticated cluster stop proof digest is invalid.', { category: 'integrity' });
  const actual = [];
  for (const node of proof.nodes) {
    if (!node || typeof node !== 'object' || Array.isArray(node) || Object.keys(node).some((key) => !['nodeId', 'unitName', 'checkedAt', 'recheckedAt'].includes(key))) throw new InfluxDb3EnterpriseLegacyRestoreError('INFLUXDB3_ENTERPRISE_LEGACY_STOP_PROOF_INVALID', 'The authenticated cluster stop proof contains malformed node evidence.', { category: 'integrity' });
    const nodeId = requiredText(node.nodeId, 'Cluster stop-proof node ID', 200);
    const unitName = requiredText(node.unitName, 'Cluster stop-proof systemd unit', 255);
    if (!/^[A-Za-z0-9][A-Za-z0-9:_.@-]*\.service$/.test(unitName) || unitName.includes('..')) throw new InfluxDb3EnterpriseLegacyRestoreError('INFLUXDB3_ENTERPRISE_LEGACY_STOP_PROOF_INVALID', 'The authenticated cluster stop proof contains an invalid service identity.', { category: 'integrity' });
    const checkedAt = stopProofTimestamp(node.checkedAt, 'Cluster stop-proof check time');
    const recheckedAt = stopProofTimestamp(node.recheckedAt, 'Cluster stop-proof recheck time');
    if (checkedAt.milliseconds > recheckedAt.milliseconds || recheckedAt.milliseconds > issuedAt.milliseconds) throw new InfluxDb3EnterpriseLegacyRestoreError('INFLUXDB3_ENTERPRISE_LEGACY_STOP_PROOF_INVALID', 'The authenticated cluster stop proof chronology is invalid.', { category: 'integrity' });
    actual.push(nodeId);
  }
  actual.sort((left, right) => left.localeCompare(right, 'en-US'));
  if (new Set(actual).size !== actual.length || actual.length !== expected.length || actual.some((nodeId, index) => nodeId !== expected[index])) {
    throw new InfluxDb3EnterpriseLegacyRestoreError('INFLUXDB3_ENTERPRISE_LEGACY_STOP_PROOF_INVALID', 'The authenticated cluster stop proof does not match the exact target node set.', { category: 'integrity' });
  }
  return Object.freeze({
    issuedAt: issuedAt.text,
    proofDigest,
    nodeCount: actual.length,
    nodeSetDigest: stableDigest(actual)
  });
}

function compactClusterStopEvidence(entries) {
  if (!Array.isArray(entries) || !entries.length || entries.length > MAX_STOP_PROOF_CHECKS) throw new InfluxDb3EnterpriseLegacyRestoreError('INFLUXDB3_ENTERPRISE_LEGACY_STOP_PROOF_LIMIT', 'Cluster stop-proof evidence exceeded its bounded limit.', { category: 'capacity' });
  const normalized = entries.map((entry) => {
    const boundary = requiredText(entry?.boundary, 'Cluster stop-proof boundary', 80);
    if (!/^[a-z0-9][a-z0-9._:-]{0,79}$/.test(boundary)) throw new InfluxDb3EnterpriseLegacyRestoreError('INFLUXDB3_ENTERPRISE_LEGACY_STOP_PROOF_INVALID', 'Cluster stop-proof boundary evidence is invalid.', { category: 'integrity' });
    const proof = entry?.proof;
    if (!proof || typeof proof !== 'object' || !/^hmac-sha256:[0-9a-f]{64}$/.test(proof.proofDigest || '') || !/^sha256:[0-9a-f]{64}$/.test(proof.nodeSetDigest || '') || !Number.isInteger(proof.nodeCount) || proof.nodeCount < 1 || proof.nodeCount > MAX_NODES) throw new InfluxDb3EnterpriseLegacyRestoreError('INFLUXDB3_ENTERPRISE_LEGACY_STOP_PROOF_INVALID', 'Cluster stop-proof boundary evidence is invalid.', { category: 'integrity' });
    return Object.freeze({ boundary, issuedAt: proof.issuedAt, proofDigest: proof.proofDigest, nodeCount: proof.nodeCount, nodeSetDigest: proof.nodeSetDigest });
  });
  const first = normalized[0];
  const last = normalized[normalized.length - 1];
  if (normalized.some((entry) => entry.nodeCount !== first.nodeCount || entry.nodeSetDigest !== first.nodeSetDigest)) throw new InfluxDb3EnterpriseLegacyRestoreError('INFLUXDB3_ENTERPRISE_LEGACY_STOP_PROOF_CHANGED', 'The authenticated cluster stop-proof node set changed during recovery.', { category: 'integrity' });
  return Object.freeze({
    version: 1,
    checkCount: normalized.length,
    firstIssuedAt: first.issuedAt,
    lastIssuedAt: last.issuedAt,
    finalProofDigest: last.proofDigest,
    nodeCount: first.nodeCount,
    nodeSetDigest: first.nodeSetDigest,
    proofChainDigest: stableDigest(normalized)
  });
}

function publicSourceEvidence(metadata, point) {
  return Object.freeze({
    product: metadata.source.product,
    productVersion: metadata.source.productVersion,
    storageEngine: 'legacy-parquet',
    clusterId: metadata.source.clusterId,
    compactorNodeId: metadata.source.compactorNodeId,
    dataNodeIds: Object.freeze([...metadata.source.dataNodeIds]),
    topologyFingerprint: metadata.source.topologyFingerprint,
    storageFingerprint: metadata.source.storageFingerprint,
    consistency: point.consistency,
    nativeMedia: Object.freeze({
      fileCount: metadata.nativeMedia.fileCount,
      directoryCount: metadata.nativeMedia.directoryCount,
      totalBytes: metadata.nativeMedia.totalBytes,
      mediaFingerprint: metadata.nativeMedia.mediaFingerprint,
      directoryFingerprint: metadata.nativeMedia.directoryFingerprint
    })
  });
}

function publicTargetEvidence(admission) {
  return Object.freeze({
    kind: 'local-filesystem',
    clusterId: admission.target.clusterId,
    compactorNodeId: admission.target.compactorNodeId,
    dataNodeIds: Object.freeze([...admission.target.dataNodeIds]),
    topologyFingerprint: admission.target.topologyFingerprint,
    storageBindingDigest: admission.storageBindingDigest,
    targetConnectionRevision: admission.connection.revision,
    targetDeploymentFingerprint: admission.identity.deploymentFingerprint,
    emptyAtAdmission: true,
    separateAlternateStorage: true,
    clusterStopProven: true,
    clusterStopEvidence: admission.clusterStopEvidence,
    automaticStartup: false
  });
}

class InfluxDb3EnterpriseLegacyRestoreService {
  constructor({
    controlDatabase,
    deviceId,
    openRepository,
    stopProofService,
    temporaryRoot = path.join(os.tmpdir(), 'deployerx-influxdb3-enterprise-legacy-restores'),
    fileSystem = fs,
    clock = () => new Date().toISOString(),
    randomUUID = crypto.randomUUID
  } = {}) {
    if (!controlDatabase || typeof openRepository !== 'function' || !stopProofService || typeof stopProofService.assertClusterStopped !== 'function' || typeof stopProofService.verifyClusterStopProof !== 'function' || typeof stopProofService.resolveBindings !== 'function') throw new TypeError('InfluxDB 3 Enterprise legacy restore requires a dynamic persisted stop-binding proof service.');
    this.controlDatabase = controlDatabase;
    this.deviceId = requiredText(deviceId, 'Device ID', 200);
    this.openRepository = openRepository;
    this.stopProofService = stopProofService;
    this.temporaryRoot = path.resolve(requiredText(temporaryRoot, 'InfluxDB 3 Enterprise legacy restore temporary root'));
    this.fileSystem = fileSystem;
    this.clock = clock;
    this.randomUUID = randomUUID;
    this.active = new Map();
  }

  async preview(workspaceId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const request = normalizeRestoreRequest(input, { requireConfirmation: false });
    const prepared = await this.#prepare(tenant, request, input.signal);
    return {
      mode: 'alternate',
      recoveryPointId: prepared.point.id,
      targetConnectionId: prepared.targetAdmission.connection.id,
      engine: 'influxdb3-enterprise',
      tier: SOURCE_TIER,
      consistency: prepared.point.consistency,
      clusterId: prepared.media.clusterId,
      compactorNodeId: prepared.media.compactorNodeId,
      dataNodeIds: [...prepared.media.dataNodeIds],
      fileCount: prepared.media.fileCount,
      directoryCount: prepared.media.directoryCount,
      totalBytes: prepared.media.totalBytes,
      completeMediaAuthenticated: true,
      targetEmpty: true,
      targetStopped: true,
      clusterStopEvidence: prepared.targetAdmission.clusterStopEvidence,
      separateAlternateStorage: true,
      originalStorageProtected: true,
      partialTargetPreservedOnFailure: true,
      rollbackAvailable: false,
      automaticStartup: false,
      ownershipReviewRequired: true,
      licenseReviewRequired: true,
      confirmationText: RESTORE_CONFIRMATION,
      warnings: prepared.point.consistency === 'crash' ? ['This ordered live-copy RecoveryPoint is crash-consistent.'] : [],
      planDigest: stableDigest({ recoveryPointId: prepared.point.id, source: publicSourceEvidence(prepared.metadata, prepared.point), target: publicTargetEvidence(prepared.targetAdmission) })
    };
  }

  async start(workspaceId, actorId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const request = normalizeRestoreRequest(input);
    const prepared = await this.#prepare(tenant, request, input.signal);
    const executionId = `legacy-restore-${this.randomUUID()}`;
    const sourceEvidence = publicSourceEvidence(prepared.metadata, prepared.point);
    const targetEvidence = publicTargetEvidence(prepared.targetAdmission);
    const targetPlanDigest = this.#targetPlanDigest(prepared.targetAdmission);
    const now = this.clock();
    const record = await this.controlDatabase.repository('restoreRun').create({
      workspaceId: tenant,
      actorId: actor,
      recoveryPointIds: [prepared.point.id],
      targetConnectionId: prepared.targetAdmission.connection.id,
      target: {
        operation: RESTORE_OPERATION,
        mode: 'alternate',
        engine: 'influxdb3-enterprise',
        tier: SOURCE_TIER,
        sourceId: prepared.source.id,
        targetConnectionId: prepared.targetAdmission.connection.id,
        targetTopologyFingerprint: prepared.targetAdmission.target.topologyFingerprint,
        targetStorageBindingDigest: prepared.targetAdmission.storageBindingDigest,
        targetPlanDigest,
        restoreExecutionId: executionId,
        targetMutationStarted: false,
        filesystemMutationStarted: false,
        mutationStartedAt: null,
        restoreEvidence: { source: sourceEvidence, target: targetEvidence }
      },
      mode: 'alternate',
      conflictPolicy: 'fail',
      workerId: `device:${this.deviceId}`,
      state: 'queued',
      progress: {
        phase: 'queued',
        itemsTotal: prepared.media.fileCount,
        itemsCompleted: 0,
        bytesTotal: prepared.media.totalBytes,
        bytesWritten: 0,
        throughputBytesPerSecond: 0,
        startedAt: null,
        updatedAt: now,
        warnings: prepared.point.consistency === 'crash' ? ['Crash-consistent source media'] : []
      },
      validation: null,
      result: null
    });
    const controller = new AbortController();
    const operation = this.#execute(tenant, actor, record.id, request, targetPlanDigest, controller.signal).catch(() => this.controlDatabase.repository('restoreRun').get(tenant, record.id));
    this.active.set(record.id, { controller, operation });
    operation.finally(() => this.active.delete(record.id));
    return record;
  }

  async wait(workspaceId, restoreRunId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const id = requiredText(restoreRunId, 'RestoreRun ID', 200);
    if (this.active.has(id)) await this.active.get(id).operation;
    const record = await this.controlDatabase.repository('restoreRun').get(tenant, id);
    if (!this.#ownsRun(record)) throw new InfluxDb3EnterpriseLegacyRestoreError('INFLUXDB3_ENTERPRISE_LEGACY_RESTORE_RUN_NOT_FOUND', 'The InfluxDB 3 Enterprise legacy RestoreRun was not found.', { category: 'not-found' });
    return record;
  }

  async cancel(workspaceId, actorId, restoreRunId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    requiredText(actorId, 'Actor ID', 200);
    const id = requiredText(restoreRunId, 'RestoreRun ID', 200);
    const record = await this.controlDatabase.repository('restoreRun').get(tenant, id);
    if (!this.#ownsRun(record)) throw new InfluxDb3EnterpriseLegacyRestoreError('INFLUXDB3_ENTERPRISE_LEGACY_RESTORE_RUN_NOT_FOUND', 'The InfluxDB 3 Enterprise legacy RestoreRun was not found.', { category: 'not-found' });
    if (TERMINAL_STATES.has(record.state)) return record;
    const active = this.active.get(id);
    if (!active) throw new InfluxDb3EnterpriseLegacyRestoreError('INFLUXDB3_ENTERPRISE_LEGACY_RESTORE_NOT_ACTIVE', 'The InfluxDB 3 Enterprise legacy recovery is not active in this DeployerX process.', { category: 'conflict' });
    active.controller.abort();
    await active.operation;
    return this.controlDatabase.repository('restoreRun').get(tenant, id);
  }

  async list(workspaceId, options = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const records = await this.controlDatabase.repository('restoreRun').list(tenant, { limit: Math.min(200, Math.max(1, Number(options.limit) || 50)) });
    return records.filter((record) => this.#ownsRun(record));
  }

  async authenticateRecoveryPoint(workspaceId, recoveryPointId, signal) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const point = await this.controlDatabase.repository('recoveryPoint').get(tenant, requiredText(recoveryPointId, 'RecoveryPoint ID', 200));
    if (!point) throw new InfluxDb3EnterpriseLegacyRestoreError('INFLUXDB3_ENTERPRISE_LEGACY_RECOVERY_POINT_NOT_FOUND', 'The InfluxDB 3 Enterprise legacy RecoveryPoint was not found.', { category: 'not-found' });
    const source = await this.controlDatabase.repository('source').get(tenant, point.sourceId);
    if (!source || !isLegacyFilesystemSource(source) || source.enabled !== true || point.type !== 'full' || !['application', 'crash'].includes(point.consistency) || point.verification?.state !== 'succeeded' || point.retention?.deletionEligible === true || source.consistency?.backupMethod !== 'physical' || source.consistency?.backupMode !== 'full') throw new InfluxDb3EnterpriseLegacyRestoreError('INFLUXDB3_ENTERPRISE_LEGACY_RECOVERY_POINT_INVALID', 'Choose a retained, verified, physical full InfluxDB 3 Enterprise legacy RecoveryPoint.', { category: 'validation' });
    let sourceExecution;
    let sourceStorage;
    try {
      sourceExecution = normalizeLegacySourceExecution(source.physicalExecution);
      sourceStorage = normalizeLegacySourceStorage(source.legacyFilesystem, source.physicalExecution);
    } catch {
      throw new InfluxDb3EnterpriseLegacyRestoreError('INFLUXDB3_ENTERPRISE_LEGACY_RECOVERY_POINT_INVALID', 'The InfluxDB 3 Enterprise legacy Source binding is unavailable.', { category: 'integrity' });
    }
    const artifacts = await this.controlDatabase.repository('artifact').list(tenant, { limit: MAX_ARTIFACTS });
    if (artifacts.length === MAX_ARTIFACTS) throw new InfluxDb3EnterpriseLegacyRestoreError('INFLUXDB3_ENTERPRISE_LEGACY_ARTIFACT_LIMIT', 'The InfluxDB 3 Enterprise legacy Artifact scan exceeds the bounded limit.', { category: 'capacity' });
    const candidates = (point.repositoryCopies || []).filter((copy) => copy.state === 'available').flatMap((copy) => artifacts.filter((artifact) => artifact.recoveryPointId === point.id && artifact.repositoryId === copy.repositoryId && artifact.kind === 'metadata' && artifact.metadata?.adapterId === ADAPTER_ID && artifact.metadata?.kind === ARTIFACT_KIND).map((artifact) => ({ copy, artifact })));
    const selected = candidates[0];
    if (!selected) throw new InfluxDb3EnterpriseLegacyRestoreError('INFLUXDB3_ENTERPRISE_LEGACY_REPOSITORY_UNAVAILABLE', 'No available repository contains the InfluxDB 3 Enterprise legacy Artifact.', { category: 'not-found' });
    const repositoryId = selected.copy.repositoryId;
    const opened = await this.openRepository(tenant, repositoryId);
    const snapshot = await opened.engine.openSnapshot({}, { repositoryId, snapshotId: selected.copy.engineSnapshotId, masterKey: opened.masterKey });
    if (snapshot.summary?.manifestKey !== selected.copy.manifestLocator || snapshot.summary?.manifestChecksum?.digest !== selected.copy.manifestChecksum?.digest) throw new InfluxDb3EnterpriseLegacyRestoreError('INFLUXDB3_ENTERPRISE_LEGACY_MANIFEST_INVALID', 'The repository manifest no longer matches the InfluxDB 3 Enterprise legacy RecoveryPoint.', { category: 'integrity' });
    const locatorParts = String(selected.artifact.locator || '').split('#');
    let locatorPath = null;
    try { locatorPath = decodeURIComponent(locatorParts.slice(1).join('#')); } catch {}
    const metadataFile = (snapshot.manifest.files || []).find((file) => file.type === 'file' && file.path === locatorPath);
    if (locatorParts.length !== 2 || locatorPath !== METADATA_PATH || !metadataFile || metadataFile.sizeBytes !== selected.artifact.sizeBytes || metadataFile.sizeBytes < 1 || metadataFile.sizeBytes > MAX_METADATA_BYTES || metadataFile.contentDigest?.digest !== selected.artifact.checksum?.digest || metadataFile.metadata?.artifactKind !== 'metadata' || metadataFile.metadata?.componentId !== 'cluster-manifest' || metadataFile.metadata?.database?.adapterId !== ADAPTER_ID || digestJson(metadataFile.metadata.database) !== digestJson(selected.artifact.metadata) || selected.artifact.encryption?.algorithm !== 'aes-256-gcm' || !selected.artifact.encryption?.keyVersion || selected.artifact.encryption.keyVersion !== snapshot.manifest.keyVersion) throw new InfluxDb3EnterpriseLegacyRestoreError('INFLUXDB3_ENTERPRISE_LEGACY_ARTIFACT_INVALID', 'The InfluxDB 3 Enterprise legacy metadata Artifact is incomplete or inconsistent.', { category: 'integrity' });
    let metadata;
    try {
      metadata = JSON.parse((await opened.engine.readFile({}, { repositoryId, manifest: snapshot.manifest, path: METADATA_PATH, masterKey: opened.masterKey })).toString('utf8'));
    } catch {
      throw new InfluxDb3EnterpriseLegacyRestoreError('INFLUXDB3_ENTERPRISE_LEGACY_ARTIFACT_INVALID', 'The authenticated InfluxDB 3 Enterprise legacy metadata cannot be decoded.', { category: 'integrity' });
    }
    if (containsAbsolutePath(metadata) || digestJson(metadata) !== digestJson(selected.artifact.metadata) || metadata.kind !== ARTIFACT_KIND || metadata.adapterId !== ADAPTER_ID || metadata.tier !== SOURCE_TIER || metadata.sourceId !== source.id || metadata.selectionDigest !== source.selector?.digest || metadata.backupMethod !== 'physical' || metadata.backupMode !== 'full' || metadata.artifact?.path !== METADATA_PATH || metadata.artifact?.restoreSupported !== true || metadata.publication?.localPathsPublished !== false || metadata.capture?.completeMediaAuthenticated !== true || metadata.capture?.achievedConsistency !== point.consistency || metadata.source?.clusterId !== sourceExecution.clusterId || metadata.source?.compactorNodeId !== sourceExecution.compactorNodeId || stableDigest(metadata.source?.dataNodeIds) !== stableDigest(sourceExecution.dataNodeIds) || metadata.source?.topologyFingerprint !== sourceExecution.topologyFingerprint || metadata.source?.storageFingerprint !== sourceExecution.storageFingerprint) throw new InfluxDb3EnterpriseLegacyRestoreError('INFLUXDB3_ENTERPRISE_LEGACY_ARTIFACT_INVALID', 'Authenticated InfluxDB 3 Enterprise legacy metadata is inconsistent with its Source and RecoveryPoint.', { category: 'integrity' });
    let media;
    try { media = normalizeLegacyMedia(metadata.nativeMedia); }
    catch (error) { throw new InfluxDb3EnterpriseLegacyRestoreError(error.code || 'INFLUXDB3_ENTERPRISE_LEGACY_MEDIA_INVALID', error.message, { category: error.category || 'integrity' }); }
    if (media.consistency !== point.consistency || media.topologyFingerprint !== sourceExecution.topologyFingerprint) throw new InfluxDb3EnterpriseLegacyRestoreError('INFLUXDB3_ENTERPRISE_LEGACY_MEDIA_INVALID', 'InfluxDB 3 Enterprise legacy media identity is inconsistent.', { category: 'integrity' });
    const normalizedByPath = new Map(media.members.map((member) => [member.relativePath, member]));
    const seen = new Set();
    const members = metadata.nativeMedia.members.map((raw) => {
      const member = normalizedByPath.get(raw.relativePath);
      const expectedPath = member ? repositoryPath(member.relativePath) : null;
      if (!member || seen.has(member.relativePath) || raw.repositoryPath !== expectedPath) throw new InfluxDb3EnterpriseLegacyRestoreError('INFLUXDB3_ENTERPRISE_LEGACY_MEDIA_INVALID', 'InfluxDB 3 Enterprise legacy media evidence is malformed or duplicated.', { category: 'integrity' });
      seen.add(member.relativePath);
      const file = snapshot.manifest.files.find((candidate) => candidate.type === 'file' && candidate.path === expectedPath);
      if (!file || file.sizeBytes !== member.sizeBytes || file.metadata?.artifactKind !== 'physical-backup-member' || file.metadata?.componentId !== 'legacy-cluster-member' || file.metadata?.nativeRelativePath !== member.relativePath || file.metadata?.contentDigest !== member.contentDigest) throw new InfluxDb3EnterpriseLegacyRestoreError('INFLUXDB3_ENTERPRISE_LEGACY_MEDIA_INVALID', 'An InfluxDB 3 Enterprise legacy repository member is missing or inconsistent.', { category: 'integrity' });
      return Object.freeze({ ...member, repositoryPath: expectedPath, file });
    }).sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en-US'));
    const repositoryMembers = snapshot.manifest.files.filter((file) => file.type === 'file' && file.path.startsWith(MEDIA_PREFIX));
    if (members.length !== media.fileCount || repositoryMembers.length !== media.fileCount || snapshot.manifest.files.filter((file) => file.type === 'file').length !== media.fileCount + 1) throw new InfluxDb3EnterpriseLegacyRestoreError('INFLUXDB3_ENTERPRISE_LEGACY_MEDIA_INVALID', 'The complete InfluxDB 3 Enterprise legacy repository media set failed structural authentication.', { category: 'integrity' });
    const verified = [];
    let totalBytes = 0;
    for (const member of members) {
      if (signal?.aborted) throw new InfluxDb3EnterpriseLegacyRestoreError('INFLUXDB3_ENTERPRISE_LEGACY_RESTORE_CANCELED', 'InfluxDB 3 Enterprise legacy recovery was canceled before target mutation.', { category: 'canceled' });
      const hash = crypto.createHash('sha256');
      let sizeBytes = 0;
      for await (const raw of opened.engine.streamFile({}, { repositoryId, manifest: snapshot.manifest, path: member.repositoryPath, masterKey: opened.masterKey })) {
        if (signal?.aborted) throw new InfluxDb3EnterpriseLegacyRestoreError('INFLUXDB3_ENTERPRISE_LEGACY_RESTORE_CANCELED', 'InfluxDB 3 Enterprise legacy recovery was canceled before target mutation.', { category: 'canceled' });
        const chunk = Buffer.from(raw);
        hash.update(chunk);
        sizeBytes += chunk.length;
      }
      const contentDigest = `sha256:${hash.digest('hex')}`;
      if (sizeBytes !== member.sizeBytes || contentDigest !== member.contentDigest) throw new InfluxDb3EnterpriseLegacyRestoreError('INFLUXDB3_ENTERPRISE_LEGACY_MEDIA_INVALID', 'An InfluxDB 3 Enterprise legacy repository member failed end-to-end authentication.', { category: 'integrity' });
      verified.push({ relativePath: member.relativePath, sizeBytes, contentDigest });
      totalBytes += sizeBytes;
    }
    if (verified.length !== media.fileCount || totalBytes !== media.totalBytes || stableDigest(verified) !== media.mediaFingerprint) throw new InfluxDb3EnterpriseLegacyRestoreError('INFLUXDB3_ENTERPRISE_LEGACY_MEDIA_INVALID', 'The complete InfluxDB 3 Enterprise legacy repository media set failed end-to-end authentication.', { category: 'integrity' });
    return { point, source, sourceExecution, sourceStorage, selected, repositoryId, opened, snapshot, metadata, media, members };
  }

  async #prepare(workspaceId, request, signal) {
    const authenticated = await this.authenticateRecoveryPoint(workspaceId, request.recoveryPointId, signal);
    const targetAdmission = await this.#admitTarget(workspaceId, request, authenticated, signal);
    return { ...authenticated, targetAdmission };
  }

  async #loadTargetConnection(workspaceId, targetConnectionId, target) {
    const connection = await this.controlDatabase.repository('connection').get(workspaceId, requiredText(targetConnectionId, 'InfluxDB 3 Enterprise target connection ID', 200));
    const identity = connection?.lastTest?.endpointIdentity;
    const validConnection = connection?.adapterId === ADAPTER_ID
      && connection.lastTest?.status === 'success'
      && connection.scope === 'device'
      && (connection.workerAffinity || []).includes(`device:${this.deviceId}`)
      && identity?.storageEngine === 'legacy-parquet'
      && identity?.legacyParquetEngine === true
      && identity?.compactorCapable === true
      && identity?.nativeBackupAvailable === false
      && identity?.clusterId === target.clusterId
      && identity?.nodeId === target.compactorNodeId
      && connection.trust?.fingerprint === identity?.deploymentFingerprint
      && connection.trust?.capabilityFingerprint === identity?.capabilityFingerprint;
    if (!validConnection) throw new InfluxDb3EnterpriseLegacyRestoreError('INFLUXDB3_ENTERPRISE_LEGACY_RESTORE_CONNECTION_INVALID', 'Choose an exactly tested legacy-engine compactor connection on this device.', { category: 'integrity', retryable: true });
    return { connection, identity };
  }

  async #proveClusterStopped(workspaceId, targetConnectionId, target, signal) {
    const proof = await this.stopProofService.assertClusterStopped({
      workspaceId,
      targetConnectionId,
      clusterId: target.clusterId,
      nodeIds: [...target.allNodeIds],
      signal
    });
    if (await this.stopProofService.verifyClusterStopProof({ workspaceId, targetConnectionId, proof }) !== true) {
      throw new InfluxDb3EnterpriseLegacyRestoreError('INFLUXDB3_ENTERPRISE_LEGACY_STOP_PROOF_INVALID', 'The authenticated cluster stop proof could not be verified.', { category: 'integrity' });
    }
    return normalizeClusterStopProof(proof, target.allNodeIds, this.clock());
  }

  async assertTargetStopped(workspaceId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['targetConnectionId', 'target', 'signal'].includes(key))) throw new TypeError('InfluxDB 3 Enterprise target stop-proof request is invalid.');
    if (!input.target || typeof input.target !== 'object' || Array.isArray(input.target) || Object.keys(input.target).some((key) => !['kind', 'dataRoot', 'clusterId', 'compactorNodeId', 'dataNodeIds'].includes(key)) || input.target.kind !== 'local-filesystem') throw new TypeError('InfluxDB 3 Enterprise target stop-proof topology is invalid.');
    const target = normalizeLegacyTopology(topologyInput(input.target));
    const { connection } = await this.#loadTargetConnection(tenant, input.targetConnectionId, target);
    const proof = await this.#proveClusterStopped(tenant, connection.id, target, input.signal);
    return compactClusterStopEvidence([{ boundary: 'external-assertion', proof }]);
  }

  async #admitTarget(workspaceId, request, authenticated, signal) {
    const target = normalizeLegacyTopology(topologyInput(request.target));
    if (target.topologyFingerprint !== authenticated.media.topologyFingerprint) throw new InfluxDb3EnterpriseLegacyRestoreError('INFLUXDB3_ENTERPRISE_LEGACY_RESTORE_TOPOLOGY_INVALID', 'The alternate target must preserve the protected InfluxDB 3 Enterprise cluster and node IDs.', { category: 'compatibility' });
    if (pathsOverlap(authenticated.sourceStorage.dataRoot, target.dataRoot) || pathsOverlap(target.dataRoot, authenticated.sourceStorage.dataRoot)) throw new InfluxDb3EnterpriseLegacyRestoreError('INFLUXDB3_ENTERPRISE_LEGACY_RESTORE_TARGET_INVALID', 'The InfluxDB 3 Enterprise legacy target must use separate alternate storage.', { category: 'configuration' });
    const targetStat = await this.fileSystem.lstat(target.dataRoot).catch(() => null);
    if (!targetStat?.isDirectory() || targetStat.isSymbolicLink()) throw new InfluxDb3EnterpriseLegacyRestoreError('INFLUXDB3_ENTERPRISE_LEGACY_RESTORE_TARGET_INVALID', 'The alternate InfluxDB 3 Enterprise local target is unavailable or unsafe.', { category: 'configuration' });
    if ((await this.fileSystem.readdir(target.dataRoot)).length) throw new InfluxDb3EnterpriseLegacyRestoreError('INFLUXDB3_ENTERPRISE_LEGACY_RESTORE_TARGET_NOT_EMPTY', 'The alternate InfluxDB 3 Enterprise local target must be completely empty.', { category: 'conflict' });
    const { connection, identity } = await this.#loadTargetConnection(workspaceId, request.targetConnectionId, target);
    const stopProof = await this.#proveClusterStopped(workspaceId, connection.id, target, signal);
    const clusterStopEvidence = compactClusterStopEvidence([{ boundary: 'admission', proof: stopProof }]);
    const storageBindingDigest = stableDigest({ dataRoot: target.dataRoot, dev: String(targetStat.dev), ino: String(targetStat.ino), birthtimeMs: Math.trunc(targetStat.birthtimeMs || 0), topologyFingerprint: target.topologyFingerprint });
    return { target, targetStat, storageBindingDigest, connection, identity, clusterStopEvidence };
  }

  #targetPlanDigest(admission) {
    return stableDigest({ dataRoot: admission.target.dataRoot, topologyFingerprint: admission.target.topologyFingerprint, storageBindingDigest: admission.storageBindingDigest, connectionId: admission.connection.id, connectionRevision: admission.connection.revision, deploymentFingerprint: admission.identity.deploymentFingerprint });
  }

  async #assertTargetBinding(admission, requireEmpty) {
    const stat = await this.fileSystem.lstat(admission.target.dataRoot).catch(() => null);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new InfluxDb3EnterpriseLegacyRestoreError('INFLUXDB3_ENTERPRISE_LEGACY_RESTORE_TARGET_CHANGED', 'The alternate InfluxDB 3 Enterprise target storage changed after admission.', { category: 'integrity' });
    const storageBindingDigest = stableDigest({ dataRoot: admission.target.dataRoot, dev: String(stat.dev), ino: String(stat.ino), birthtimeMs: Math.trunc(stat.birthtimeMs || 0), topologyFingerprint: admission.target.topologyFingerprint });
    if (storageBindingDigest !== admission.storageBindingDigest || (requireEmpty && (await this.fileSystem.readdir(admission.target.dataRoot)).length)) throw new InfluxDb3EnterpriseLegacyRestoreError('INFLUXDB3_ENTERPRISE_LEGACY_RESTORE_TARGET_CHANGED', 'The alternate InfluxDB 3 Enterprise target storage changed after admission.', { category: 'integrity' });
  }

  async #writeOwner(ownerPath, owner, flag = 'w') {
    if (flag === 'wx') return this.fileSystem.writeFile(ownerPath, JSON.stringify(owner), { flag, mode: 0o600 });
    const nextPath = `${ownerPath}.next`;
    await this.fileSystem.writeFile(nextPath, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
    await this.fileSystem.rename(nextPath, ownerPath);
  }

  #ownsStage(owner, workspaceId, restoreRunId) {
    return owner?.version === 1 && owner.kind === RESTORE_STAGE_KIND && owner.workspaceId === workspaceId && owner.restoreRunId === restoreRunId && ['materializing', 'authenticated', 'restoring'].includes(owner.state);
  }

  async #cleanupOwnedDirectory(workspaceId, restoreRunId, directory) {
    if (path.dirname(directory) !== this.temporaryRoot || !path.basename(directory).startsWith(restorePrefix(workspaceId, restoreRunId))) return false;
    const owner = await this.fileSystem.readFile(path.join(directory, '.owner.json'), 'utf8').then(JSON.parse).catch(() => null);
    if (!this.#ownsStage(owner, workspaceId, restoreRunId)) return false;
    await this.fileSystem.rm(directory, { recursive: true, force: true });
    return true;
  }

  async #cleanupOwnedDirectories(workspaceId, restoreRunId) {
    const prefix = restorePrefix(workspaceId, restoreRunId);
    const entries = await this.fileSystem.readdir(this.temporaryRoot, { withFileTypes: true }).catch((error) => error?.code === 'ENOENT' ? [] : Promise.reject(error));
    let removed = 0;
    let proven = true;
    for (const entry of entries.slice(0, MAX_STAGE_DIRECTORIES)) {
      if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
      if (await this.#cleanupOwnedDirectory(workspaceId, restoreRunId, path.join(this.temporaryRoot, entry.name))) removed += 1;
      else proven = false;
    }
    return { removed, proven };
  }

  async #materialize(workspaceId, restoreRunId, authenticated, signal, onProgress) {
    await this.fileSystem.mkdir(this.temporaryRoot, { recursive: true, mode: 0o700 });
    await this.fileSystem.chmod(this.temporaryRoot, 0o700).catch(() => {});
    const directory = await this.fileSystem.mkdtemp(path.join(this.temporaryRoot, restorePrefix(workspaceId, restoreRunId)));
    const mediaRoot = path.join(directory, 'media');
    const ownerPath = path.join(directory, '.owner.json');
    let owner = { version: 1, kind: RESTORE_STAGE_KIND, state: 'materializing', workspaceId, restoreRunId, recoveryPointId: authenticated.point.id, createdAt: this.clock() };
    try {
      await this.fileSystem.chmod(directory, 0o700).catch(() => {});
      await this.#writeOwner(ownerPath, owner, 'wx');
      await this.fileSystem.mkdir(mediaRoot, { mode: 0o700 });
      for (const relativePath of authenticated.media.directories) await this.fileSystem.mkdir(path.join(mediaRoot, ...relativePath.split('/')), { recursive: true, mode: 0o700 });
      let bytesWritten = 0;
      let itemsCompleted = 0;
      for (const member of authenticated.members) {
        if (signal?.aborted) throw new InfluxDb3EnterpriseLegacyRestoreError('INFLUXDB3_ENTERPRISE_LEGACY_RESTORE_CANCELED', 'InfluxDB 3 Enterprise legacy recovery was canceled before target mutation.', { category: 'canceled' });
        const destination = path.resolve(mediaRoot, ...member.relativePath.split('/'));
        if (!destination.startsWith(`${mediaRoot}${path.sep}`)) throw new InfluxDb3EnterpriseLegacyRestoreError('INFLUXDB3_ENTERPRISE_LEGACY_MEDIA_INVALID', 'InfluxDB 3 Enterprise legacy media escaped its owned restore stage.', { category: 'integrity' });
        await this.fileSystem.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
        const handle = await this.fileSystem.open(destination, 'wx', 0o600);
        const hash = crypto.createHash('sha256');
        let sizeBytes = 0;
        try {
          for await (const raw of authenticated.opened.engine.streamFile({}, { repositoryId: authenticated.repositoryId, manifest: authenticated.snapshot.manifest, path: member.repositoryPath, masterKey: authenticated.opened.masterKey })) {
            if (signal?.aborted) throw new InfluxDb3EnterpriseLegacyRestoreError('INFLUXDB3_ENTERPRISE_LEGACY_RESTORE_CANCELED', 'InfluxDB 3 Enterprise legacy recovery was canceled before target mutation.', { category: 'canceled' });
            const chunk = Buffer.from(raw);
            let offset = 0;
            while (offset < chunk.length) {
              const written = (await handle.write(chunk, offset, chunk.length - offset)).bytesWritten;
              if (!Number.isInteger(written) || written < 1) throw new InfluxDb3EnterpriseLegacyRestoreError('INFLUXDB3_ENTERPRISE_LEGACY_MEDIA_INVALID', 'InfluxDB 3 Enterprise legacy staging could not write an authenticated member.', { category: 'integrity' });
              offset += written;
            }
            hash.update(chunk);
            sizeBytes += chunk.length;
            bytesWritten += chunk.length;
            await onProgress?.({ bytesWritten, itemsCompleted });
          }
          await handle.sync();
        } finally { await handle.close(); }
        const contentDigest = `sha256:${hash.digest('hex')}`;
        if (sizeBytes !== member.sizeBytes || contentDigest !== member.contentDigest) throw new InfluxDb3EnterpriseLegacyRestoreError('INFLUXDB3_ENTERPRISE_LEGACY_MEDIA_INVALID', 'A materialized InfluxDB 3 Enterprise legacy member failed authentication.', { category: 'integrity' });
        itemsCompleted += 1;
        await onProgress?.({ bytesWritten, itemsCompleted });
      }
      await authenticateLegacyFilesystem(mediaRoot, authenticated.metadata.nativeMedia);
      owner = { ...owner, state: 'authenticated', mediaFingerprint: authenticated.media.mediaFingerprint, authenticatedAt: this.clock() };
      await this.#writeOwner(ownerPath, owner);
      return { directory, mediaRoot, ownerPath, owner };
    } catch (error) {
      error.restoreStageCleanupProven = await this.#cleanupOwnedDirectory(workspaceId, restoreRunId, directory).catch(() => false);
      throw error;
    }
  }

  async #targetHasEntries(targetRoot) {
    return this.fileSystem.readdir(targetRoot).then((entries) => entries.length > 0).catch(() => false);
  }

  async #execute(workspaceId, actorId, restoreRunId, request, expectedTargetPlanDigest, signal) {
    let progress = { phase: 'preparing', itemsTotal: 0, itemsCompleted: 0, bytesTotal: 0, bytesWritten: 0, throughputBytesPerSecond: 0, startedAt: this.clock(), updatedAt: this.clock(), warnings: [] };
    let staging = null;
    let targetMutationPossible = false;
    const mutationStopProofs = [];
    try {
      await this.#project(workspaceId, restoreRunId, { state: 'preparing', progress }, actorId);
      const prepared = await this.#prepare(workspaceId, request, signal);
      if (this.#targetPlanDigest(prepared.targetAdmission) !== expectedTargetPlanDigest) throw new InfluxDb3EnterpriseLegacyRestoreError('INFLUXDB3_ENTERPRISE_LEGACY_RESTORE_TARGET_CHANGED', 'The alternate InfluxDB 3 Enterprise target changed after restore admission.', { category: 'integrity' });
      progress = { ...progress, phase: 'materializing', itemsTotal: prepared.media.fileCount, bytesTotal: prepared.media.totalBytes, updatedAt: this.clock(), warnings: prepared.point.consistency === 'crash' ? ['Crash-consistent source media'] : [] };
      staging = await this.#materialize(workspaceId, restoreRunId, prepared, signal, async (update) => {
        progress = { ...progress, ...update, updatedAt: this.clock() };
      });
      await this.#assertTargetBinding(prepared.targetAdmission, true);
      staging.owner = { ...staging.owner, state: 'restoring', restoringAt: this.clock() };
      await this.#writeOwner(staging.ownerPath, staging.owner);
      const result = await restoreLegacyFilesystem({
        signal,
        assertClusterStopped: async ({ clusterId, nodeIds, signal: proofSignal, boundary = 'restore-boundary' }) => {
          if (clusterId !== prepared.targetAdmission.target.clusterId || stableDigest([...nodeIds].sort()) !== stableDigest([...prepared.targetAdmission.target.allNodeIds].sort())) throw new InfluxDb3EnterpriseLegacyRestoreError('INFLUXDB3_ENTERPRISE_LEGACY_STOP_PROOF_INVALID', 'The restore engine requested stop proof for an unexpected cluster boundary.', { category: 'integrity' });
          if (mutationStopProofs.length >= MAX_STOP_PROOF_CHECKS - 1) throw new InfluxDb3EnterpriseLegacyRestoreError('INFLUXDB3_ENTERPRISE_LEGACY_STOP_PROOF_LIMIT', 'Cluster stop-proof evidence exceeded its bounded limit.', { category: 'capacity' });
          const proof = await this.#proveClusterStopped(workspaceId, prepared.targetAdmission.connection.id, prepared.targetAdmission.target, proofSignal);
          mutationStopProofs.push({ boundary, proof });
          return { stopped: true };
        },
        onProgress: async (event) => {
          progress = { ...progress, phase: 'restoring', currentComponent: event.component, updatedAt: this.clock() };
          const current = await this.controlDatabase.repository('restoreRun').get(workspaceId, restoreRunId);
          const mutated = current?.target?.targetMutationStarted === true || await this.#targetHasEntries(request.target.dataRoot);
          targetMutationPossible = targetMutationPossible || mutated;
          if (current?.state === 'preparing' && mutated) {
            await this.#project(workspaceId, restoreRunId, { state: 'running', progress, target: { ...current.target, targetMutationStarted: true, filesystemMutationStarted: true, mutationStartedAt: this.clock() } }, actorId);
          } else if (current?.state === 'running') {
            await this.#project(workspaceId, restoreRunId, { progress }, actorId);
          }
        }
      }, staging.mediaRoot, prepared.metadata.nativeMedia, { ...topologyInput(request.target), confirmationText: RESTORE_CONFIRMATION });
      let current = await this.controlDatabase.repository('restoreRun').get(workspaceId, restoreRunId);
      await this.#assertTargetBinding(prepared.targetAdmission, false);
      if (current.state === 'preparing') current = await this.#project(workspaceId, restoreRunId, { state: 'running', progress: { ...progress, phase: 'restoring', updatedAt: this.clock() }, target: { ...current.target, targetMutationStarted: true, filesystemMutationStarted: true, mutationStartedAt: this.clock() } }, actorId);
      progress = { ...progress, phase: 'validating', itemsCompleted: prepared.media.fileCount, bytesWritten: prepared.media.totalBytes, updatedAt: this.clock() };
      await this.#project(workspaceId, restoreRunId, { state: 'validating', progress }, actorId);
      const installed = await authenticateLegacyFilesystem(request.target.dataRoot, prepared.metadata.nativeMedia);
      if (installed.media.mediaFingerprint !== prepared.media.mediaFingerprint || installed.files.length !== prepared.media.fileCount) throw new InfluxDb3EnterpriseLegacyRestoreError('INFLUXDB3_ENTERPRISE_LEGACY_RESTORE_VALIDATION_FAILED', 'Installed InfluxDB 3 Enterprise legacy media failed final authentication.', { category: 'integrity' });
      const finalStopProof = await this.#proveClusterStopped(workspaceId, prepared.targetAdmission.connection.id, prepared.targetAdmission.target, signal);
      mutationStopProofs.push({ boundary: 'after-installed-validation', proof: finalStopProof });
      const clusterStopEvidence = compactClusterStopEvidence(mutationStopProofs);
      const cleaned = await this.#cleanupOwnedDirectory(workspaceId, restoreRunId, staging.directory);
      staging = null;
      progress = { ...progress, phase: 'complete', updatedAt: this.clock() };
      return this.#project(workspaceId, restoreRunId, {
        state: 'succeeded',
        progress,
        validation: { state: 'succeeded', completeMediaAuthenticated: true, clusterStopped: true, clusterStopEvidence, manualStartupRequired: true, completedAt: this.clock() },
        result: {
          recoveryPointId: prepared.point.id,
          clusterId: result.clusterId,
          nodeIds: result.nodeIds,
          fileCount: result.fileCount,
          directoryCount: result.directoryCount,
          bytesRestored: result.totalBytes,
          mediaFingerprint: result.mediaFingerprint,
          targetPreserved: true,
          targetStopped: true,
          clusterStopEvidence,
          automaticStartup: false,
          originalStoreCleared: false,
          ownershipReviewRequired: true,
          licenseReviewRequired: true,
          operatorReviewRequired: true,
          partialStatePreservedOnFailure: true,
          rollbackClaimed: false,
          stagingCleanupProven: cleaned,
          warnings: prepared.point.consistency === 'crash' ? ['The restored RecoveryPoint is crash-consistent.'] : [],
          completedAt: this.clock()
        }
      }, actorId);
    } catch (error) {
      const stagingCleanupProven = staging ? await this.#cleanupOwnedDirectory(workspaceId, restoreRunId, staging.directory).catch(() => false) : error.restoreStageCleanupProven !== false;
      const current = await this.controlDatabase.repository('restoreRun').get(workspaceId, restoreRunId);
      if (current && !TERMINAL_STATES.has(current.state)) {
        const mutated = current.target?.targetMutationStarted === true || current.target?.filesystemMutationStarted === true || targetMutationPossible || await this.#targetHasEntries(request.target.dataRoot);
        const canceled = signal.aborted || error?.code === 'INFLUXDB3_ENTERPRISE_LEGACY_RESTORE_CANCELED';
        const state = mutated ? 'interrupted' : canceled ? 'canceled' : 'failed';
        const safe = mutated ? {
          code: 'INFLUXDB3_ENTERPRISE_LEGACY_RESTORE_TARGET_REQUIRES_INSPECTION',
          category: 'restore',
          retryable: false,
          safeMessage: 'InfluxDB 3 Enterprise legacy target mutation began but recovery did not finish. The partial alternate target is preserved for inspection and no rollback is claimed.'
        } : canceled ? {
          code: 'INFLUXDB3_ENTERPRISE_LEGACY_RESTORE_CANCELED',
          category: 'canceled',
          retryable: false,
          safeMessage: 'InfluxDB 3 Enterprise legacy recovery was canceled before target mutation began.'
        } : publicError(error);
        return this.#project(workspaceId, restoreRunId, {
          state,
          progress: { ...progress, phase: mutated ? 'operator-action-required' : state, updatedAt: this.clock() },
          target: mutated ? { ...current.target, targetMutationStarted: true, filesystemMutationStarted: true, mutationStartedAt: current.target.mutationStartedAt || this.clock() } : current.target,
          result: { error: safe, targetPreserved: mutated, partialTargetPreserved: mutated, targetDeletionAttempted: false, rollbackClaimed: false, stagingCleanupProven, completedAt: this.clock() }
        }, actorId);
      }
      throw error;
    }
  }

  async reconcile(workspaceId, actorId = 'system') {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const recovered = [];
    const records = await this.controlDatabase.repository('restoreRun').list(tenant, { limit: 200 });
    for (const record of records.filter((item) => this.#ownsRun(item) && !TERMINAL_STATES.has(item.state) && !this.active.has(item.id))) {
      const cleanup = await this.#cleanupOwnedDirectories(tenant, record.id).catch(() => ({ removed: 0, proven: false }));
      const mutated = record.target?.targetMutationStarted === true || record.target?.filesystemMutationStarted === true;
      recovered.push(await this.#project(tenant, record.id, {
        state: 'interrupted',
        progress: { ...(record.progress || {}), phase: mutated ? 'operator-action-required' : 'interrupted', updatedAt: this.clock() },
        result: {
          error: {
            code: mutated ? 'INFLUXDB3_ENTERPRISE_LEGACY_RESTORE_INTERRUPTED_AFTER_MUTATION' : 'INFLUXDB3_ENTERPRISE_LEGACY_RESTORE_PROCESS_INTERRUPTED',
            category: 'restore',
            retryable: false,
            safeMessage: mutated ? 'InfluxDB 3 Enterprise legacy recovery was interrupted after target mutation. The partial alternate target is preserved for inspection and no rollback is claimed.' : 'InfluxDB 3 Enterprise legacy recovery was interrupted before target mutation.'
          },
          targetPreserved: mutated,
          partialTargetPreserved: mutated,
          targetDeletionAttempted: false,
          rollbackClaimed: false,
          stagingCleanupProven: cleanup.proven,
          removedOwnedStagingDirectories: cleanup.removed,
          completedAt: this.clock()
        }
      }, actor));
    }
    return recovered;
  }

  #ownsRun(record) {
    return record?.target?.operation === RESTORE_OPERATION && record.target?.engine === 'influxdb3-enterprise' && record.target?.tier === SOURCE_TIER;
  }

  async #project(workspaceId, id, changes, actorId) {
    return this.controlDatabase.transaction((transaction) => {
      const current = transaction.get('restoreRun', workspaceId, id);
      return transaction.projectExecution('restoreRun', workspaceId, id, changes, { expectedRevision: current.revision, actorId });
    });
  }
}

module.exports = {
  InfluxDb3EnterpriseLegacyRestoreError,
  InfluxDb3EnterpriseLegacyRestoreService,
  MAX_ARTIFACTS,
  MAX_STOP_PROOF_CHECKS,
  RESTORE_OPERATION,
  RESTORE_STAGE_KIND,
  containsAbsolutePath,
  compactClusterStopEvidence,
  normalizeRestoreRequest,
  normalizeClusterStopProof,
  publicSourceEvidence,
  publicTargetEvidence,
  restorePrefix
};
