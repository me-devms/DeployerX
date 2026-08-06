const crypto = require('crypto');
const { ADAPTER_ID } = require('./cockroachdb');
const { normalizeDestination } = require('./cockroachdb-native');
const { ARTIFACT_PATH, MAX_METADATA_BYTES, normalizePublishedMetadata } = require('./cockroachdb-source-reader');
const {
  MAX_CHAIN_LENGTH,
  RESTORE_CONFIRMATION,
  RESTORE_OPERATION,
  CockroachDbNativeRestoreController,
  sealRecoveryEvidence
} = require('./cockroachdb-restore');

const TERMINAL_STATES = new Set(['succeeded', 'warning', 'failed', 'canceled', 'interrupted']);
const MAX_POINT_SCAN = 1000;
const MAX_ARTIFACT_SCAN = 5000;

class CockroachDbRestoreRunError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'CockroachDbRestoreRunError';
    this.code = code;
    this.category = options.category || 'restore';
    this.retryable = Boolean(options.retryable);
  }
}

function requiredText(value, label, maximumLength = 4096) {
  const text = String(value ?? '').trim();
  if (!text || /[\u0000-\u001f\u007f]/.test(text) || text.length > maximumLength) throw new TypeError(`${label} is invalid.`);
  return text;
}

function timestamp(value, label) {
  const date = new Date(requiredText(value, label, 100));
  if (Number.isNaN(date.getTime())) throw new TypeError(`${label} is invalid.`);
  return date.toISOString();
}

function hash(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function publicError(error) {
  if (error instanceof CockroachDbRestoreRunError || (error?.code && error?.category)) {
    return {
      code: String(error.code).slice(0, 100),
      category: String(error.category || 'restore').slice(0, 80),
      retryable: Boolean(error.retryable),
      safeMessage: String(error.message || 'The CockroachDB recovery failed.').slice(0, 500)
    };
  }
  return { code: 'COCKROACH_RESTORE_RUN_FAILED', category: 'restore', retryable: false, safeMessage: 'DeployerX could not complete the CockroachDB alternate-target recovery.' };
}

function normalizeRequest(input = {}, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('CockroachDB restore request must be an object.');
  if (String(input.mode || 'alternate') !== 'alternate') throw new CockroachDbRestoreRunError('COCKROACH_RESTORE_MODE_UNSUPPORTED', 'CockroachDB recovery currently supports an empty alternate database target only.', { category: 'compatibility' });
  if (options.requireConfirmation !== false && (input.confirmed !== true || String(input.confirmationText || '').trim() !== RESTORE_CONFIRMATION)) throw new CockroachDbRestoreRunError('COCKROACH_RESTORE_CONFIRMATION_REQUIRED', 'Confirm the CockroachDB alternate-target recovery before continuing.', { category: 'conflict' });
  const targetDatabase = requiredText(input.targetDatabase, 'CockroachDB alternate database name', 256);
  if (['system', 'defaultdb', 'postgres'].includes(targetDatabase.toLowerCase())) throw new TypeError('CockroachDB alternate database name is reserved.');
  return {
    recoveryPointId: requiredText(input.recoveryPointId, 'RecoveryPoint ID', 200),
    targetConnectionId: requiredText(input.targetConnectionId, 'CockroachDB target connection ID', 200),
    targetDatabase,
    restoreTimestamp: input.restoreTimestamp ? timestamp(input.restoreTimestamp, 'CockroachDB restore timestamp') : null,
    mode: 'alternate'
  };
}

function rawSelection(selection) {
  if (selection.scope === 'cluster') return { scope: 'cluster' };
  if (selection.scope === 'database') return { scope: 'database', database: selection.database };
  return { scope: 'table', tables: selection.tables.map(({ database, schema, name }) => ({ database, schema, name })) };
}

function targetTrust(connection, deviceId) {
  if (!connection || connection.adapterId !== ADAPTER_ID || connection.kind !== 'database') throw new CockroachDbRestoreRunError('COCKROACH_RESTORE_TARGET_CONNECTION_INVALID', 'Choose a tested CockroachDB target connection.', { category: 'connectivity', retryable: true });
  if (!(connection.workerAffinity || []).includes(`device:${requiredText(deviceId, 'Device ID', 200)}`)) throw new CockroachDbRestoreRunError('COCKROACH_RESTORE_TARGET_DEVICE_INVALID', 'The CockroachDB target connection belongs to another device.', { category: 'connectivity' });
  const endpoint = connection.endpoint || {};
  const trust = connection.trust || {};
  const identity = connection.lastTest?.endpointIdentity || {};
  const inventory = connection.cockroachdbInventory || {};
  const destinationTrust = connection.cockroachdbBackupDestinationTrust;
  if (connection.lastTest?.status !== 'success' || !destinationTrust
    || trust.clusterId !== endpoint.expectedClusterId || trust.clusterId !== identity.clusterId || trust.clusterId !== inventory.clusterId
    || trust.fingerprint !== endpoint.expectedDeploymentFingerprint || trust.fingerprint !== identity.deploymentFingerprint || trust.fingerprint !== inventory.deploymentFingerprint
    || trust.topologyFingerprint !== endpoint.expectedTopologyFingerprint || trust.topologyFingerprint !== identity.topologyFingerprint || trust.topologyFingerprint !== inventory.topologyFingerprint
    || trust.inventoryFingerprint !== endpoint.expectedInventoryFingerprint || trust.inventoryFingerprint !== identity.inventoryFingerprint || trust.inventoryFingerprint !== inventory.inventoryFingerprint) {
    throw new CockroachDbRestoreRunError('COCKROACH_RESTORE_TARGET_UNTRUSTED', 'Retest the exact CockroachDB target cluster before recovery.', { category: 'integrity' });
  }
  const destination = normalizeDestination(destinationTrust.destination);
  const names = new Set((inventory.externalConnections || []).map((item) => item.name));
  const capabilities = inventory.capabilities;
  if (destinationTrust.version !== 1 || destinationTrust.connectionRevision !== connection.revision
    || destinationTrust.clusterId !== trust.clusterId || destinationTrust.deploymentFingerprint !== trust.fingerprint
    || destinationTrust.topologyFingerprint !== trust.topologyFingerprint || destinationTrust.inventoryFingerprint !== trust.inventoryFingerprint
    || destinationTrust.destinationFingerprint !== destination.destinationFingerprint || destinationTrust.localityFingerprint !== destination.localityFingerprint
    || destination.localities.some((item) => !names.has(item.externalConnectionName))
    || capabilities?.restoreSyntax !== true || capabilities?.detachedJobs !== true || capabilities?.jobsVisible !== true
    || capabilities?.externalConnectionsVisible !== true || capabilities?.privilegeEvidenceVisible !== true
    || capabilities?.systemPrivileges?.RESTORE !== true || capabilities?.systemPrivileges?.VIEWJOB !== true || capabilities?.systemPrivileges?.CONTROLJOB !== true) {
    throw new CockroachDbRestoreRunError('COCKROACH_RESTORE_TARGET_DESTINATION_UNTRUSTED', 'Approve the exact CockroachDB backup destination and restore privileges on the target again.', { category: 'integrity' });
  }
  return { connection, destination, inventory, binding: {
    clusterId: trust.clusterId,
    deploymentFingerprint: trust.fingerprint,
    topologyFingerprint: trust.topologyFingerprint,
    inventoryFingerprint: trust.inventoryFingerprint,
    connectionRevision: connection.revision
  } };
}

function regionsFromInventory(inventory) {
  const regions = new Set();
  for (const node of inventory?.nodes || []) {
    const match = /(?:^|,)region=([^,]+)/.exec(String(node.locality || ''));
    if (match) regions.add(match[1]);
  }
  return [...regions].sort((left, right) => left.localeCompare(right, 'en-US'));
}

function publicJob(job) {
  return job ? {
    jobType: 'RESTORE', status: job.status, createdAt: job.createdAt, startedAt: job.startedAt,
    finishedAt: job.finishedAt, modifiedAt: job.modifiedAt, fractionCompleted: job.fractionCompleted,
    hasError: job.hasError, terminal: job.terminal, evidenceFingerprint: job.evidenceFingerprint
  } : null;
}

function publicRecord(record) {
  if (!record) return record;
  const copy = structuredClone(record);
  if (copy.target) delete copy.target.nativeOwnership;
  return copy;
}

class CockroachDbRestoreRunService {
  constructor({ controlDatabase, deviceId, connectionService, openRepository, controller = new CockroachDbNativeRestoreController(), clock = () => new Date().toISOString() } = {}) {
    if (!controlDatabase || !connectionService || typeof openRepository !== 'function' || !controller) throw new TypeError('CockroachDB RestoreRun dependencies are required.');
    this.controlDatabase = controlDatabase;
    this.deviceId = requiredText(deviceId, 'Device ID', 200);
    this.connectionService = connectionService;
    this.openRepository = openRepository;
    this.controller = controller;
    this.clock = clock;
    this.active = new Map();
  }

  async authenticateRecoveryPoint(workspaceId, recoveryPointId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const point = await this.controlDatabase.repository('recoveryPoint').get(tenant, requiredText(recoveryPointId, 'RecoveryPoint ID', 200));
    if (!point) throw new CockroachDbRestoreRunError('COCKROACH_RECOVERY_POINT_NOT_FOUND', 'The CockroachDB RecoveryPoint was not found.', { category: 'not-found' });
    const source = await this.controlDatabase.repository('source').get(tenant, point.sourceId);
    if (!source || source.adapterId !== ADAPTER_ID || source.consistency?.backupMethod !== 'physical') throw new CockroachDbRestoreRunError('COCKROACH_RECOVERY_POINT_INVALID', 'The selected RecoveryPoint is not a CockroachDB native backup.', { category: 'integrity' });
    const points = await this.controlDatabase.repository('recoveryPoint').list(tenant, { limit: MAX_POINT_SCAN });
    if (points.length >= MAX_POINT_SCAN) throw new CockroachDbRestoreRunError('COCKROACH_RESTORE_POINT_SCAN_LIMIT', 'The CockroachDB RecoveryPoint scan reached its bounded limit.', { category: 'capacity' });
    const byId = new Map(points.map((item) => [item.id, item]));
    byId.set(point.id, point);
    const newestFirst = [];
    const seen = new Set();
    let current = point;
    while (current) {
      if (seen.has(current.id) || newestFirst.length >= MAX_CHAIN_LENGTH) throw new CockroachDbRestoreRunError('COCKROACH_RESTORE_CHAIN_INVALID', 'The CockroachDB recovery chain is cyclic or exceeds its bounded length.', { category: 'integrity' });
      seen.add(current.id);
      if (current.sourceId !== point.sourceId || current.jobId !== point.jobId || !['full', 'incremental'].includes(current.type)
        || current.consistency !== 'application' || current.verification?.state !== 'succeeded' || current.retention?.deletionEligible === true
        || !Array.isArray(current.repositoryCopies)) throw new CockroachDbRestoreRunError('COCKROACH_RECOVERY_POINT_INVALID', 'Every CockroachDB recovery ancestor must be retained, verified, application-consistent, and available.', { category: 'integrity' });
      newestFirst.push(current);
      if (current.type === 'full') break;
      if (!current.parentRecoveryPointId || !(current = byId.get(current.parentRecoveryPointId))) throw new CockroachDbRestoreRunError('COCKROACH_RESTORE_CHAIN_INCOMPLETE', 'A required CockroachDB recovery ancestor is missing.', { category: 'integrity' });
    }
    const chain = newestFirst.reverse();
    const root = chain[0];
    if (!root || root.type !== 'full' || root.chainRootId !== root.id
      || chain.some((item, index) => item.chainRootId !== root.id || index > 0 && item.parentRecoveryPointId !== chain[index - 1].id)) {
      throw new CockroachDbRestoreRunError('COCKROACH_RESTORE_CHAIN_INVALID', 'The CockroachDB RecoveryPoint lineage is not one complete ordered chain.', { category: 'integrity' });
    }
    const repositoryId = (root.repositoryCopies || []).find((copy) => copy.state === 'available'
      && chain.every((item) => item.repositoryCopies.some((candidate) => candidate.repositoryId === copy.repositoryId && candidate.state === 'available')))?.repositoryId;
    if (!repositoryId) throw new CockroachDbRestoreRunError('COCKROACH_RESTORE_REPOSITORY_UNAVAILABLE', 'No repository contains the complete CockroachDB recovery chain.', { category: 'not-found' });
    const opened = await this.openRepository(tenant, repositoryId);
    const artifacts = await this.controlDatabase.repository('artifact').list(tenant, { limit: MAX_ARTIFACT_SCAN });
    if (artifacts.length >= MAX_ARTIFACT_SCAN) throw new CockroachDbRestoreRunError('COCKROACH_RESTORE_ARTIFACT_SCAN_LIMIT', 'The CockroachDB Artifact scan reached its bounded limit.', { category: 'capacity' });
    const entries = [];
    for (let index = 0; index < chain.length; index += 1) {
      const chainPoint = chain[index];
      const copy = chainPoint.repositoryCopies.find((item) => item.repositoryId === repositoryId && item.state === 'available');
      const artifact = artifacts.find((item) => item.recoveryPointId === chainPoint.id && item.repositoryId === repositoryId && item.kind === 'metadata');
      if (!artifact) throw new CockroachDbRestoreRunError('COCKROACH_RESTORE_ARTIFACT_UNAVAILABLE', 'A required CockroachDB metadata Artifact is unavailable.', { category: 'not-found' });
      const snapshot = await opened.engine.openSnapshot({}, { repositoryId, snapshotId: copy.engineSnapshotId, masterKey: opened.masterKey });
      let locatorPath = null;
      try { locatorPath = decodeURIComponent(String(artifact.locator || '').split('#').slice(1).join('#')); } catch {}
      const file = locatorPath === ARTIFACT_PATH ? (snapshot.manifest?.files || []).find((candidate) => candidate.type === 'file' && candidate.path === ARTIFACT_PATH
        && candidate.metadata?.artifactKind === 'metadata' && candidate.metadata?.externalNativeMedia === true) : null;
      const metadata = file?.metadata?.database;
      if (!file || snapshot.summary?.manifestKey !== copy.manifestLocator || snapshot.summary?.manifestChecksum?.digest !== copy.manifestChecksum?.digest
        || file.sizeBytes < 1 || file.sizeBytes > MAX_METADATA_BYTES || file.sizeBytes !== artifact.sizeBytes
        || file.contentDigest?.digest !== artifact.checksum?.digest || JSON.stringify(metadata) !== JSON.stringify(artifact.metadata)) {
        throw new CockroachDbRestoreRunError('COCKROACH_RESTORE_ARTIFACT_CHANGED', 'An authenticated CockroachDB repository Artifact changed.', { category: 'integrity' });
      }
      const first = entries[0]?.metadata;
      const normalized = normalizePublishedMetadata(metadata, {
        sourceId: source.id,
        jobId: point.jobId,
        selectionFingerprint: first?.selectionFingerprint,
        destinationFingerprint: first?.destination.destinationFingerprint,
        localityFingerprint: first?.destination.localityFingerprint,
        clusterId: first?.binding.clusterId,
        deploymentFingerprint: first?.binding.deploymentFingerprint,
        topologyFingerprint: first?.binding.topologyFingerprint,
        inventoryFingerprint: first?.binding.inventoryFingerprint,
        connectionRevision: first?.binding.connectionRevision,
        revisionHistory: first?.revisionHistory,
        encryptionMode: 'none'
      });
      const expectedAncestors = chain.slice(0, index).map((item) => item.id);
      if (normalized.restoreSupported !== true || normalized.backupMode !== chainPoint.type || normalized.nativeChain.incrementalCount !== index
        || normalized.nativeChain.headExecutionId !== chainPoint.runId
        || normalized.chain.parentRecoveryPointId !== (index ? chain[index - 1].id : null)
        || normalized.chain.chainRootRecoveryPointId !== (index ? root.id : null)
        || JSON.stringify(normalized.chain.ancestorRecoveryPointIds) !== JSON.stringify(expectedAncestors)
        || index && (normalized.nativeChain.rootExecutionId !== entries[0].metadata.nativeChain.rootExecutionId
          || Date.parse(normalized.asOfTimestamp) <= Date.parse(entries[index - 1].metadata.asOfTimestamp))) {
        throw new CockroachDbRestoreRunError('COCKROACH_RESTORE_ARTIFACT_INVALID', 'Authenticated CockroachDB metadata is inconsistent with its RecoveryPoint and native lineage.', { category: 'integrity' });
      }
      entries.push({ point: chainPoint, copy, artifact, snapshot, file, metadata: normalized });
    }
    return { tenant, point, source, repositoryId, opened, entries, metadata: entries.at(-1).metadata };
  }

  async #prepareEvidence(workspaceId, request) {
    const authenticated = await this.authenticateRecoveryPoint(workspaceId, request.recoveryPointId);
    const targetConnection = await this.controlDatabase.repository('connection').get(workspaceId, request.targetConnectionId);
    const target = targetTrust(targetConnection, this.deviceId);
    if (target.destination.destinationFingerprint !== authenticated.metadata.destination.destinationFingerprint
      || target.destination.localityFingerprint !== authenticated.metadata.destination.localityFingerprint) {
      throw new CockroachDbRestoreRunError('COCKROACH_RESTORE_COLLECTION_UNTRUSTED', 'The target does not expose the authenticated CockroachDB backup destination identity.', { category: 'integrity' });
    }
    const sourceConnection = await this.controlDatabase.repository('connection').get(workspaceId, authenticated.source.connectionId);
    const sourceInventory = sourceConnection?.cockroachdbInventory;
    if (!sourceInventory || sourceInventory.clusterId !== authenticated.metadata.binding.clusterId
      || sourceInventory.deploymentFingerprint !== authenticated.metadata.binding.deploymentFingerprint
      || sourceInventory.topologyFingerprint !== authenticated.metadata.binding.topologyFingerprint) {
      throw new CockroachDbRestoreRunError('COCKROACH_RESTORE_REGION_EVIDENCE_UNAVAILABLE', 'Authenticated CockroachDB source topology evidence is unavailable for region compatibility checks.', { category: 'integrity' });
    }
    const requiredRegions = regionsFromInventory(sourceInventory);
    const chain = authenticated.entries.map((entry) => ({
      recoveryPointId: entry.point.id,
      parentRecoveryPointId: entry.point.parentRecoveryPointId,
      type: entry.point.type,
      asOfTimestamp: entry.metadata.asOfTimestamp,
      verificationState: 'succeeded',
      retained: true
    }));
    const head = authenticated.entries.at(-1);
    const recovery = sealRecoveryEvidence({
      version: 1,
      kind: 'cockroachdb-native-backup',
      adapterId: ADAPTER_ID,
      recoveryPointId: authenticated.point.id,
      artifactId: head.artifact.id,
      sourceId: authenticated.source.id,
      sourceClusterId: authenticated.metadata.binding.clusterId,
      sourceVersion: authenticated.metadata.productVersion,
      sourceClusterVersion: authenticated.metadata.clusterVersion,
      sourceDeploymentFingerprint: authenticated.metadata.binding.deploymentFingerprint,
      sourceTopologyFingerprint: authenticated.metadata.binding.topologyFingerprint,
      selection: rawSelection(authenticated.metadata.selection),
      collection: {
        type: 'external-connection',
        localities: target.destination.localities.map(({ locality, externalConnectionName }) => ({ locality, externalConnectionName })),
        destinationFingerprint: target.destination.destinationFingerprint,
        localityFingerprint: target.destination.localityFingerprint,
        localityAware: target.destination.localityAware
      },
      backupMode: authenticated.metadata.backupMode,
      asOfTimestamp: authenticated.metadata.asOfTimestamp,
      revisionHistory: authenticated.metadata.revisionHistory,
      encryptionMode: 'none',
      consistency: 'application',
      verificationState: 'succeeded',
      deletionEligible: false,
      restoreSupported: true,
      externalNativeMedia: true,
      multiRegion: requiredRegions.length > 0,
      requiredRegions,
      dependencyPolicy: 'reject-unresolved',
      manifestDigest: head.copy.manifestChecksum.digest,
      artifactDigest: head.artifact.checksum.digest,
      chain: {
        version: 1,
        complete: true,
        points: chain,
        revisionStartTimestamp: authenticated.metadata.revisionHistory ? authenticated.entries[0].metadata.asOfTimestamp : null
      }
    });
    return { ...authenticated, target, targetConnection, recovery, requiredRegions };
  }

  async #preparePlan(workspaceId, request, restoreRunId, signal) {
    const prepared = await this.#prepareEvidence(workspaceId, request);
    const nativeRequest = {
      connection: this.connectionService.config(prepared.targetConnection),
      targetBinding: prepared.target.binding,
      recovery: prepared.recovery,
      targetDatabase: request.targetDatabase,
      restoreTimestamp: request.restoreTimestamp,
      mode: 'alternate',
      confirmed: true,
      confirmationText: RESTORE_CONFIRMATION,
      execution: { workspaceId, restoreRunId, connectionRevision: prepared.targetConnection.revision }
    };
    const plan = await this.connectionService.withExecution(workspaceId, prepared.targetConnection, signal, (context, connection) => this.controller.planRestore(context, { ...nativeRequest, connection }));
    return { ...prepared, nativeRequest, plan };
  }

  async preview(workspaceId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const request = normalizeRequest(input, { requireConfirmation: false });
    const previewId = `preview-${hash({ tenant, ...request }).slice(7, 39)}`;
    const prepared = await this.#preparePlan(tenant, request, previewId, input.signal);
    return {
      mode: 'alternate',
      recoveryPointId: prepared.point.id,
      chainRecoveryPointIds: prepared.entries.map((entry) => entry.point.id),
      sourceDatabase: prepared.metadata.selection.database,
      targetConnectionId: prepared.targetConnection.id,
      targetDatabase: request.targetDatabase,
      sourceVersion: prepared.metadata.productVersion,
      targetVersion: prepared.plan.admission.targetVersion,
      backupMode: prepared.point.type,
      restoreTimestamp: prepared.plan.request.restoreTimestamp,
      revisionHistory: prepared.metadata.revisionHistory,
      restorableFrom: prepared.recovery.chain.revisionStartTimestamp || prepared.entries[0].metadata.asOfTimestamp,
      restorableTo: prepared.metadata.asOfTimestamp,
      requiredRegions: prepared.requiredRegions,
      targetEmpty: prepared.plan.admission.targetDatabaseAbsent,
      nativeValidation: true,
      unresolvedDependenciesRejected: true,
      confirmationText: RESTORE_CONFIRMATION,
      planDigest: prepared.plan.planDigest
    };
  }

  async start(workspaceId, actorId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const request = normalizeRequest(input);
    const prepared = await this.#prepareEvidence(tenant, request);
    const now = this.clock();
    const record = await this.controlDatabase.repository('restoreRun').create({
      workspaceId: tenant,
      actorId: actor,
      recoveryPointIds: prepared.entries.map((entry) => entry.point.id),
      targetConnectionId: prepared.targetConnection.id,
      target: {
        operation: RESTORE_OPERATION,
        engine: 'cockroachdb',
        mode: 'alternate',
        sourceId: prepared.source.id,
        sourceDatabase: prepared.metadata.selection.database,
        targetDatabase: request.targetDatabase,
        restoreTimestamp: request.restoreTimestamp || prepared.metadata.asOfTimestamp,
        targetClusterId: prepared.target.binding.clusterId,
        targetTopologyFingerprint: prepared.target.binding.topologyFingerprint,
        destinationFingerprint: prepared.target.destination.destinationFingerprint,
        localityFingerprint: prepared.target.destination.localityFingerprint,
        recoveryEvidenceDigest: prepared.recovery.evidenceDigest,
        nativeMutationStarted: false,
        nativeStatus: null,
        nativeOwnership: null,
        partialTargetPreserved: false,
        rollbackClaimed: false
      },
      mode: 'alternate',
      conflictPolicy: 'fail',
      workerId: `device:${this.deviceId}`,
      state: 'queued',
      progress: { phase: 'queued', itemsTotal: prepared.entries.length, itemsCompleted: 0, bytesTotal: prepared.entries.reduce((total, entry) => total + entry.artifact.sizeBytes, 0), bytesWritten: 0, throughputBytesPerSecond: 0, startedAt: null, updatedAt: now, warnings: [] },
      validation: null,
      result: null
    });
    const controller = new AbortController();
    const operation = this.#execute(tenant, actor, record.id, request, controller.signal).catch(() => this.controlDatabase.repository('restoreRun').get(tenant, record.id));
    this.active.set(record.id, { operation, controller });
    operation.finally(() => this.active.delete(record.id));
    return publicRecord(record);
  }

  async wait(workspaceId, restoreRunId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const id = requiredText(restoreRunId, 'RestoreRun ID', 200);
    if (this.active.has(id)) await this.active.get(id).operation;
    const record = await this.controlDatabase.repository('restoreRun').get(tenant, id);
    if (!record || record.target?.operation !== RESTORE_OPERATION || record.target?.engine !== 'cockroachdb') throw new CockroachDbRestoreRunError('COCKROACH_RESTORE_RUN_NOT_FOUND', 'The CockroachDB RestoreRun was not found.', { category: 'not-found' });
    return publicRecord(record);
  }

  async list(workspaceId, options = {}) {
    const records = await this.controlDatabase.repository('restoreRun').list(requiredText(workspaceId, 'Workspace ID', 200), { limit: Math.min(200, Math.max(1, Number(options.limit) || 50)) });
    return records.filter((record) => record.target?.operation === RESTORE_OPERATION && record.target?.engine === 'cockroachdb').map(publicRecord);
  }

  async #project(workspaceId, id, changes, actorId) {
    return this.controlDatabase.transaction((transaction) => {
      const current = transaction.get('restoreRun', workspaceId, id);
      if (!current) throw new CockroachDbRestoreRunError('COCKROACH_RESTORE_RUN_NOT_FOUND', 'The CockroachDB RestoreRun was not found.', { category: 'not-found' });
      return transaction.projectExecution('restoreRun', workspaceId, id, changes, { expectedRevision: current.revision, actorId });
    });
  }

  async #execute(workspaceId, actorId, restoreRunId, request, signal) {
    let progress = { phase: 'preparing', itemsTotal: 0, itemsCompleted: 0, bytesTotal: 0, bytesWritten: 0, throughputBytesPerSecond: 0, startedAt: this.clock(), updatedAt: this.clock(), warnings: [] };
    try {
      await this.#project(workspaceId, restoreRunId, { state: 'preparing', progress }, actorId);
      const prepared = await this.#preparePlan(workspaceId, request, restoreRunId, signal);
      progress = { ...progress, itemsTotal: prepared.entries.length, bytesTotal: prepared.entries.reduce((total, entry) => total + entry.artifact.sizeBytes, 0), updatedAt: this.clock() };
      const outcome = await this.connectionService.withExecution(workspaceId, prepared.targetConnection, signal, async (context) => this.controller.executeRestore({ ...context, signal, onOwnership: async (ownership) => {
        const current = await this.controlDatabase.repository('restoreRun').get(workspaceId, restoreRunId);
        progress = { ...progress, phase: 'restoring', updatedAt: this.clock() };
        await this.#project(workspaceId, restoreRunId, {
          state: 'running',
          progress,
          target: { ...current.target, nativeMutationStarted: true, nativeStatus: 'submitted', nativeOwnership: ownership, partialTargetPreserved: true, rollbackClaimed: false }
        }, actorId);
      } }, prepared.plan));
      const current = await this.controlDatabase.repository('restoreRun').get(workspaceId, restoreRunId);
      progress = { ...progress, phase: 'validating', itemsCompleted: prepared.entries.length, updatedAt: this.clock() };
      await this.#project(workspaceId, restoreRunId, { state: 'validating', progress, target: { ...current.target, nativeStatus: outcome.job.status } }, actorId);
      progress = { ...progress, phase: 'complete', updatedAt: this.clock() };
      return this.#project(workspaceId, restoreRunId, {
        state: 'succeeded',
        progress,
        validation: { state: 'succeeded', connectivity: 'succeeded', expectedObjects: 'succeeded', nativeIntegrityValidation: true, checks: outcome.validation, completedAt: this.clock() },
        result: {
          recoveryPointId: prepared.point.id,
          chainRecoveryPointIds: prepared.entries.map((entry) => entry.point.id),
          targetDatabase: outcome.targetDatabase,
          restoreTimestamp: outcome.restoreTimestamp,
          job: publicJob(outcome.job),
          validation: outcome.validation,
          targetPreserved: true,
          partialTargetPreserved: false,
          rollbackClaimed: false,
          warnings: [],
          completedAt: this.clock()
        }
      }, actorId);
    } catch (error) {
      const current = await this.controlDatabase.repository('restoreRun').get(workspaceId, restoreRunId);
      if (current && !TERMINAL_STATES.has(current.state)) {
        const canceled = signal.aborted || error?.code === 'COCKROACH_RESTORE_CANCELED' || error?.code === 'COCKROACH_RESTORE_MONITOR_CANCELED';
        const mutated = current.target?.nativeMutationStarted === true;
        const state = mutated ? 'interrupted' : canceled ? 'canceled' : 'failed';
        const safe = mutated
          ? { code: 'COCKROACH_RESTORE_TARGET_REQUIRES_INSPECTION', category: 'restore', retryable: false, safeMessage: 'CockroachDB native restore was submitted but did not finish with validated success. The partial alternate target is preserved for inspection and no rollback is claimed.' }
          : canceled
            ? { code: 'COCKROACH_RESTORE_CANCELED', category: 'canceled', retryable: false, safeMessage: 'The CockroachDB recovery was canceled before native submission.' }
            : publicError(error);
        return this.#project(workspaceId, restoreRunId, {
          state,
          progress: { ...progress, phase: mutated ? 'operator-action-required' : state, updatedAt: this.clock() },
          target: { ...current.target, partialTargetPreserved: mutated, rollbackClaimed: false },
          result: { error: safe, targetPreserved: mutated, partialTargetPreserved: mutated, rollbackClaimed: false, completedAt: this.clock() }
        }, actorId);
      }
      throw error;
    }
  }

  async #owned(workspaceId, restoreRunId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const id = requiredText(restoreRunId, 'RestoreRun ID', 200);
    const record = await this.controlDatabase.repository('restoreRun').get(tenant, id);
    const ownership = record?.target?.nativeOwnership;
    if (!record || record.target?.operation !== RESTORE_OPERATION || record.target?.engine !== 'cockroachdb' || !ownership
      || ownership.restoreRunId !== record.id || record.target.nativeMutationStarted !== true) {
      throw new CockroachDbRestoreRunError('COCKROACH_RESTORE_OWNERSHIP_INVALID', 'The CockroachDB RestoreRun has no exact native ownership evidence.', { category: 'integrity' });
    }
    const connection = await this.controlDatabase.repository('connection').get(tenant, record.targetConnectionId);
    targetTrust(connection, this.deviceId);
    return { tenant, record, ownership, connection };
  }

  async #control(workspaceId, actorId, restoreRunId, operation) {
    const actor = requiredText(actorId, 'Actor ID', 200);
    const owned = await this.#owned(workspaceId, restoreRunId);
    const controlled = await this.connectionService.withExecution(owned.tenant, owned.connection, null, (context, connection) => this.controller[operation](context, { connection, ownership: owned.ownership }));
    const current = await this.controlDatabase.repository('restoreRun').get(owned.tenant, owned.record.id);
    await this.#project(owned.tenant, current.id, { target: { ...current.target, nativeStatus: controlled.job.status, lastControl: operation, controlledAt: controlled.controlledAt } }, actor);
    return { operation, status: controlled.job.status, terminal: controlled.job.terminal, fractionCompleted: controlled.job.fractionCompleted, controlledAt: controlled.controlledAt, targetPreserved: true, rollbackClaimed: false };
  }

  async pause(workspaceId, actorId, restoreRunId) { return this.#control(workspaceId, actorId, restoreRunId, 'pause'); }
  async resume(workspaceId, actorId, restoreRunId) { return this.#control(workspaceId, actorId, restoreRunId, 'resume'); }

  async cancel(workspaceId, actorId, restoreRunId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const id = requiredText(restoreRunId, 'RestoreRun ID', 200);
    const record = await this.controlDatabase.repository('restoreRun').get(tenant, id);
    if (!record || record.target?.operation !== RESTORE_OPERATION || record.target?.engine !== 'cockroachdb') throw new CockroachDbRestoreRunError('COCKROACH_RESTORE_RUN_NOT_FOUND', 'The CockroachDB RestoreRun was not found.', { category: 'not-found' });
    if (TERMINAL_STATES.has(record.state)) return publicRecord(record);
    if (record.target?.nativeOwnership) await this.#control(tenant, actor, id, 'cancel');
    const active = this.active.get(id);
    if (active) {
      active.controller.abort();
      await active.operation;
      return this.wait(tenant, id);
    }
    if (!record.target?.nativeOwnership) return publicRecord(await this.#project(tenant, id, { state: 'canceled', progress: { ...(record.progress || {}), phase: 'canceled', updatedAt: this.clock() }, result: { error: { code: 'COCKROACH_RESTORE_CANCELED', category: 'canceled', retryable: false, safeMessage: 'The CockroachDB recovery was canceled before native submission.' }, targetPreserved: false, rollbackClaimed: false, completedAt: this.clock() } }, actor));
    return this.reconcileRun(tenant, actor, id);
  }

  async #succeedReconciled(workspaceId, actorId, record, reconciled) {
    let current = record;
    if (current.state === 'queued') current = await this.#project(workspaceId, current.id, { state: 'preparing', progress: { ...(current.progress || {}), phase: 'reconciling', updatedAt: this.clock() } }, actorId);
    if (current.state === 'preparing') current = await this.#project(workspaceId, current.id, { state: 'running', progress: { ...(current.progress || {}), phase: 'reconciling', updatedAt: this.clock() } }, actorId);
    if (current.state === 'running') current = await this.#project(workspaceId, current.id, { state: 'validating', progress: { ...(current.progress || {}), phase: 'validating', updatedAt: this.clock() } }, actorId);
    return this.#project(workspaceId, current.id, {
      state: 'succeeded',
      progress: { ...(current.progress || {}), phase: 'complete', itemsCompleted: current.progress?.itemsTotal || 1, updatedAt: this.clock() },
      target: { ...current.target, nativeStatus: reconciled.job.status },
      validation: { state: 'succeeded', connectivity: 'succeeded', expectedObjects: 'succeeded', nativeIntegrityValidation: true, checks: reconciled.nativeValidation, completedAt: this.clock() },
      result: { reconciledAfterRestart: true, targetDatabase: current.target.targetDatabase, restoreTimestamp: current.target.restoreTimestamp, job: publicJob(reconciled.job), validation: reconciled.nativeValidation, targetPreserved: true, partialTargetPreserved: false, rollbackClaimed: false, warnings: [], completedAt: this.clock() }
    }, actorId);
  }

  async reconcileRun(workspaceId, actorId, restoreRunId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const id = requiredText(restoreRunId, 'RestoreRun ID', 200);
    const record = await this.controlDatabase.repository('restoreRun').get(tenant, id);
    if (!record || record.target?.operation !== RESTORE_OPERATION || record.target?.engine !== 'cockroachdb') throw new CockroachDbRestoreRunError('COCKROACH_RESTORE_RUN_NOT_FOUND', 'The CockroachDB RestoreRun was not found.', { category: 'not-found' });
    if (TERMINAL_STATES.has(record.state) || this.active.has(id)) return publicRecord(record);
    if (!record.target?.nativeOwnership) {
      const mutated = record.target?.nativeMutationStarted === true;
      return publicRecord(await this.#project(tenant, id, { state: mutated ? 'interrupted' : 'failed', progress: { ...(record.progress || {}), phase: mutated ? 'operator-action-required' : 'failed', updatedAt: this.clock() }, result: { error: { code: mutated ? 'COCKROACH_RESTORE_OWNERSHIP_MISSING' : 'COCKROACH_RESTORE_PROCESS_INTERRUPTED', category: 'restore', retryable: false, safeMessage: mutated ? 'CockroachDB target mutation was recorded without complete native ownership. Preserve the partial target for operator inspection.' : 'CockroachDB recovery was interrupted before native submission.' }, targetPreserved: mutated, partialTargetPreserved: mutated, rollbackClaimed: false, completedAt: this.clock() } }, actor));
    }
    try {
      const owned = await this.#owned(tenant, id);
      const reconciled = await this.connectionService.withExecution(tenant, owned.connection, null, (context, connection) => this.controller.reconcile(context, { connection, ownership: owned.ownership }));
      if (reconciled.job.status === 'succeeded' && reconciled.targetDatabasePresent === true && reconciled.nativeValidation?.dependenciesValid === true) return publicRecord(await this.#succeedReconciled(tenant, actor, record, reconciled));
      if (reconciled.terminal) return publicRecord(await this.#project(tenant, id, { state: 'interrupted', progress: { ...(record.progress || {}), phase: 'operator-action-required', updatedAt: this.clock() }, target: { ...record.target, nativeStatus: reconciled.job.status, partialTargetPreserved: true, rollbackClaimed: false }, result: { error: { code: 'COCKROACH_RESTORE_RECONCILED_INCOMPLETE', category: 'restore', retryable: false, safeMessage: 'The owned CockroachDB restore reached a terminal state without validated success. Preserve the partial target for operator inspection.' }, job: publicJob(reconciled.job), targetPreserved: true, partialTargetPreserved: true, rollbackClaimed: false, completedAt: this.clock() } }, actor));
      return publicRecord(await this.#project(tenant, id, { target: { ...record.target, nativeStatus: reconciled.job.status, reconciledAt: reconciled.reconciledAt } }, actor));
    } catch (error) {
      return publicRecord(await this.#project(tenant, id, { state: 'interrupted', progress: { ...(record.progress || {}), phase: 'operator-action-required', updatedAt: this.clock() }, result: { error: { code: 'COCKROACH_RESTORE_RECONCILIATION_UNPROVEN', category: 'restore', retryable: false, safeMessage: 'CockroachDB native ownership could not be reconciled. Preserve the partial alternate target and inspect the exact owned job.' }, reconciliationError: publicError(error), targetPreserved: true, partialTargetPreserved: true, rollbackClaimed: false, completedAt: this.clock() } }, actor));
    }
  }

  async reconcile(workspaceId, actorId = 'system') {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const records = await this.controlDatabase.repository('restoreRun').list(tenant, { limit: 200 });
    const reconciled = [];
    for (const record of records.filter((item) => item.target?.operation === RESTORE_OPERATION && item.target?.engine === 'cockroachdb' && !TERMINAL_STATES.has(item.state) && !this.active.has(item.id))) reconciled.push(await this.reconcileRun(tenant, actor, record.id));
    return reconciled;
  }
}

module.exports = {
  CockroachDbRestoreRunError,
  CockroachDbRestoreRunService,
  CockroachDbRestoreService: CockroachDbRestoreRunService,
  normalizeRequest,
  publicRecord,
  regionsFromInventory,
  targetTrust
};
