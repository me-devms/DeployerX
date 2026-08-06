const crypto = require('crypto');
const { ADAPTER_ID, RESTORE_CONFIRMATION, databaseName, supportsFirstDifferentialOverlap } = require('./neo4j');

const TERMINAL_STATES = new Set(['succeeded', 'warning', 'failed', 'canceled', 'interrupted']);
const RESTORE_OPERATIONS = new Set(['neo4j-offline-alternate-load', 'neo4j-enterprise-alternate-restore']);

class Neo4jRestoreError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'Neo4jRestoreError';
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

function normalizeRequest(input = {}, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Neo4j restore request must be an object.');
  const mode = String(input.mode || 'alternate');
  if (mode !== 'alternate') throw new Neo4jRestoreError('NEO4J_RESTORE_MODE_UNSUPPORTED', 'Neo4j recovery currently supports an empty alternate target only.', { category: 'compatibility' });
  if (options.requireConfirmation !== false && (input.confirmed !== true || String(input.confirmationText || '').trim() !== RESTORE_CONFIRMATION)) throw new Neo4jRestoreError('NEO4J_RESTORE_CONFIRMATION_REQUIRED', 'Confirm the Neo4j alternate-target recovery before continuing.', { category: 'conflict' });
  return {
    recoveryPointId: requiredText(input.recoveryPointId, 'RecoveryPoint ID', 200),
    targetConnectionId: requiredText(input.targetConnectionId, 'Neo4j target connection ID', 200),
    targetDatabase: databaseName(input.targetDatabase, 'Neo4j target database'),
    mode
  };
}

function publicError(error) {
  if (error instanceof Neo4jRestoreError || (error?.code && error?.category)) return { code: String(error.code).slice(0, 100), category: String(error.category || 'restore').slice(0, 80), retryable: Boolean(error.retryable), safeMessage: String(error.message || 'The Neo4j recovery failed.').slice(0, 500) };
  return { code: 'NEO4J_RESTORE_FAILED', category: 'restore', retryable: false, safeMessage: 'DeployerX could not complete the Neo4j alternate-target recovery.' };
}

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function metadataDigest(value) {
  return `sha256:${crypto.createHash('sha256').update(canonical(value)).digest('hex')}`;
}

class Neo4jRestoreService {
  constructor({ controlDatabase, deviceId, adapter, connectionService, openRepository, clock = () => new Date().toISOString(), now = () => Date.now() } = {}) {
    if (!controlDatabase || !adapter || !connectionService || typeof openRepository !== 'function') throw new TypeError('Neo4j restore dependencies are required.');
    this.controlDatabase = controlDatabase;
    this.deviceId = requiredText(deviceId, 'Device ID', 200);
    this.adapter = adapter;
    this.connectionService = connectionService;
    this.openRepository = openRepository;
    this.clock = clock;
    this.now = now;
    this.active = new Map();
  }

  async preview(workspaceId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const request = normalizeRequest(input, { requireConfirmation: false });
    const prepared = await this.#prepare(tenant, request, input.signal);
    return {
      mode: 'alternate',
      recoveryPointId: prepared.point.id,
      sourceDatabase: prepared.metadata.database.name,
      targetConnectionId: prepared.targetConnection.id,
      targetDatabase: request.targetDatabase,
      sourceEdition: prepared.metadata.edition,
      targetEdition: prepared.plan.target.edition,
      sourceVersion: prepared.metadata.productVersion,
      targetVersion: prepared.plan.target.version,
      storeFormat: prepared.metadata.artifact.storeFormat,
      sizeBytes: prepared.totalBytes,
      artifactCount: prepared.entries.length,
      chainRecoveryPointIds: prepared.entries.map((entry) => entry.point.id),
      targetEmpty: true,
      sourceDeploymentProtected: true,
      nativeValidation: true,
      serviceStartsAutomatically: false,
      confirmationText: RESTORE_CONFIRMATION,
      planDigest: digest({ recoveryPointId: prepared.point.id, targetConnectionId: prepared.targetConnection.id, targetDatabase: request.targetDatabase, target: prepared.plan.target, artifacts: prepared.entries.map((entry) => entry.metadata.artifact) })
    };
  }

  async start(workspaceId, actorId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const request = normalizeRequest(input);
    const prepared = await this.#prepare(tenant, request, input.signal);
    const now = this.clock();
    const record = await this.controlDatabase.repository('restoreRun').create({
      workspaceId: tenant,
      actorId: actor,
      recoveryPointIds: prepared.entries.map((entry) => entry.point.id),
      targetConnectionId: prepared.targetConnection.id,
      target: {
        operation: prepared.plan.operation,
        mode: 'alternate',
        engine: 'neo4j',
        sourceId: prepared.source.id,
        sourceDatabase: prepared.metadata.database.name,
        sourceDatabaseId: prepared.metadata.database.databaseId,
        targetConnectionId: prepared.targetConnection.id,
        targetDatabase: request.targetDatabase,
        targetDeploymentFingerprint: prepared.plan.target.deploymentFingerprint,
        targetTopologyFingerprint: prepared.plan.target.topologyFingerprint,
        nativeMutationStarted: false,
        stagePath: null,
        serviceStarted: false
      },
      mode: 'alternate',
      conflictPolicy: 'fail',
      workerId: `device:${this.deviceId}`,
      state: 'queued',
      progress: { phase: 'queued', itemsTotal: prepared.entries.length, itemsCompleted: 0, bytesTotal: prepared.totalBytes, bytesWritten: 0, throughputBytesPerSecond: 0, startedAt: null, updatedAt: now, warnings: [] },
      validation: null,
      result: null
    });
    const controller = new AbortController();
    const operation = this.#execute(tenant, actor, record.id, request, controller.signal).catch(() => this.controlDatabase.repository('restoreRun').get(tenant, record.id));
    this.active.set(record.id, { operation, controller });
    operation.finally(() => this.active.delete(record.id));
    return record;
  }

  async wait(workspaceId, restoreRunId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const id = requiredText(restoreRunId, 'RestoreRun ID', 200);
    if (this.active.has(id)) await this.active.get(id).operation;
    const record = await this.controlDatabase.repository('restoreRun').get(tenant, id);
    if (!record || !RESTORE_OPERATIONS.has(record.target?.operation) || record.target?.engine !== 'neo4j') throw new Neo4jRestoreError('NEO4J_RESTORE_RUN_NOT_FOUND', 'The Neo4j RestoreRun was not found.', { category: 'not-found' });
    return record;
  }

  async cancel(workspaceId, actorId, restoreRunId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    requiredText(actorId, 'Actor ID', 200);
    const id = requiredText(restoreRunId, 'RestoreRun ID', 200);
    const record = await this.controlDatabase.repository('restoreRun').get(tenant, id);
    if (!record || !RESTORE_OPERATIONS.has(record.target?.operation) || record.target?.engine !== 'neo4j') throw new Neo4jRestoreError('NEO4J_RESTORE_RUN_NOT_FOUND', 'The Neo4j RestoreRun was not found.', { category: 'not-found' });
    if (TERMINAL_STATES.has(record.state)) return record;
    const active = this.active.get(id);
    if (!active) throw new Neo4jRestoreError('NEO4J_RESTORE_NOT_ACTIVE', 'The Neo4j recovery is not active in this DeployerX process.', { category: 'conflict' });
    active.controller.abort();
    await active.operation;
    return this.controlDatabase.repository('restoreRun').get(tenant, id);
  }

  async list(workspaceId, options = {}) {
    return (await this.controlDatabase.repository('restoreRun').list(requiredText(workspaceId, 'Workspace ID', 200), { limit: Math.min(200, Math.max(1, Number(options.limit) || 50)) }))
      .filter((record) => RESTORE_OPERATIONS.has(record.target?.operation) && record.target?.engine === 'neo4j');
  }

  async prepareEnterpriseChain(workspaceId, recoveryPointId, repositoryId = null) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const point = await this.controlDatabase.repository('recoveryPoint').get(tenant, requiredText(recoveryPointId, 'RecoveryPoint ID', 200));
    if (!point) throw new Neo4jRestoreError('NEO4J_RECOVERY_POINT_NOT_FOUND', 'The Neo4j RecoveryPoint was not found.', { category: 'not-found' });
    const source = await this.controlDatabase.repository('source').get(tenant, point.sourceId);
    if (!source || source.adapterId !== ADAPTER_ID || source.consistency?.method !== 'neo4j-native-backup' || source.physicalExecution?.tier !== 'enterprise-online') throw new Neo4jRestoreError('NEO4J_RECOVERY_POINT_INVALID', 'The selected RecoveryPoint is not a Neo4j Enterprise native backup.', { category: 'validation' });
    const selected = await this.#verifiedEnterpriseChain(tenant, point, source, repositoryId ? requiredText(repositoryId, 'Repository ID', 200) : null);
    return { point, source, ...selected };
  }

  async authenticateRecoveryPoint(workspaceId, recoveryPointId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const point = await this.controlDatabase.repository('recoveryPoint').get(tenant, requiredText(recoveryPointId, 'RecoveryPoint ID', 200));
    if (!point) throw new Neo4jRestoreError('NEO4J_RECOVERY_POINT_NOT_FOUND', 'The Neo4j RecoveryPoint was not found.', { category: 'not-found' });
    const source = await this.controlDatabase.repository('source').get(tenant, point.sourceId);
    if (!source || source.adapterId !== ADAPTER_ID || source.consistency?.backupMethod !== 'physical') throw new Neo4jRestoreError('NEO4J_RECOVERY_POINT_INVALID', 'The selected RecoveryPoint is not a Neo4j physical backup.', { category: 'validation' });
    const enterprise = source.consistency?.method === 'neo4j-native-backup' || source.physicalExecution?.tier === 'enterprise-online' || point.type === 'differential';
    const selected = enterprise ? await this.#verifiedEnterpriseChain(tenant, point, source) : await this.#verifiedArtifact(tenant, point);
    if (!enterprise) {
      selected.entries = [{ point, copy: selected.copy, artifact: selected.artifact, snapshot: selected.snapshot, file: selected.file, metadata: selected.metadata }];
      selected.totalBytes = selected.file.sizeBytes;
    }
    if (selected.metadata.selectionDigest !== source.selector?.digest || selected.metadata.database?.name !== source.selector?.databases?.include?.[0]?.name?.toLowerCase()) throw new Neo4jRestoreError('NEO4J_RESTORE_SOURCE_SCOPE_CHANGED', 'The Neo4j Source selection no longer matches the authenticated backup.', { category: 'integrity' });
    return {
      point,
      source,
      repositoryId: selected.entries[0].copy.repositoryId,
      entries: selected.entries,
      metadata: selected.metadata,
      totalBytes: selected.totalBytes,
      opened: selected.opened
    };
  }

  async reconcile(workspaceId, actorId = 'system') {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const recovered = [];
    for (const record of (await this.list(tenant, { limit: 200 })).filter((item) => !TERMINAL_STATES.has(item.state) && !this.active.has(item.id))) {
      const mutated = record.target?.nativeMutationStarted === true;
      recovered.push(await this.#project(tenant, record.id, {
        state: mutated ? 'interrupted' : 'failed',
        progress: { ...(record.progress || {}), phase: mutated ? 'operator-action-required' : 'failed', updatedAt: this.clock() },
        result: {
          error: {
            code: mutated ? 'NEO4J_RESTORE_INTERRUPTED_AFTER_LOAD' : 'NEO4J_RESTORE_PROCESS_INTERRUPTED',
            category: 'restore',
            retryable: false,
            safeMessage: mutated ? 'Neo4j recovery was interrupted after native load began. The target database and owned stage are preserved for inspection; no rollback is claimed.' : 'Neo4j recovery was interrupted before native load. Any recorded owned stage is preserved for inspection.'
          },
          completedAt: this.clock()
        }
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

  async #verifiedArtifact(workspaceId, point) {
    if (point.type !== 'full' || point.consistency !== 'application' || point.verification?.state !== 'succeeded' || point.retention?.deletionEligible === true) throw new Neo4jRestoreError('NEO4J_RECOVERY_POINT_INVALID', 'Choose a retained, verified, application-consistent Neo4j full RecoveryPoint.', { category: 'validation' });
    const artifacts = await this.controlDatabase.repository('artifact').list(workspaceId, { limit: 5000 });
    for (const copy of (point.repositoryCopies || []).filter((item) => item.state === 'available')) {
      const artifact = artifacts.find((item) => item.recoveryPointId === point.id && item.repositoryId === copy.repositoryId && item.kind === 'database-dump' && item.metadata?.adapterId === ADAPTER_ID && item.metadata?.kind === 'neo4j-offline-dump');
      if (!artifact) continue;
      const opened = await this.openRepository(workspaceId, copy.repositoryId);
      const snapshot = await opened.engine.openSnapshot({}, { repositoryId: copy.repositoryId, snapshotId: copy.engineSnapshotId, masterKey: opened.masterKey });
      const locatorPath = decodeURIComponent(String(artifact.locator || '').split('#').slice(1).join('#'));
      const file = (snapshot.manifest.files || []).find((candidate) => candidate.type === 'file' && candidate.path === locatorPath && candidate.metadata?.artifactKind === 'database-dump' && candidate.metadata?.database?.adapterId === ADAPTER_ID);
      if (!file || file.sizeBytes !== artifact.sizeBytes || file.contentDigest?.digest !== artifact.checksum?.digest) throw new Neo4jRestoreError('NEO4J_RESTORE_MANIFEST_INVALID', 'The authenticated repository manifest does not match the Neo4j Artifact.', { category: 'integrity' });
      const metadata = file.metadata.database;
      if (metadataDigest(metadata) !== metadataDigest(artifact.metadata) || metadata.artifact?.path !== file.path || metadata.artifact?.sizeBytes !== file.sizeBytes || !/^sha256:[0-9a-f]{64}$/.test(String(metadata.artifact?.contentDigest || '')) || !/^sha256:[0-9a-f]{64}$/.test(String(metadata.artifact?.inspectionDigest || '')) || !metadata.artifact?.storeFormat) throw new Neo4jRestoreError('NEO4J_RESTORE_METADATA_INVALID', 'The authenticated Neo4j recovery metadata is incomplete or inconsistent.', { category: 'integrity' });
      return { copy, artifact, opened, snapshot, file, metadata };
    }
    throw new Neo4jRestoreError('NEO4J_RESTORE_ARTIFACT_UNAVAILABLE', 'No available repository copy contains the Neo4j dump Artifact.', { category: 'not-found' });
  }

  async #verifiedEnterpriseChain(workspaceId, selectedPoint, source, requestedRepositoryId = null) {
    const points = await this.controlDatabase.repository('recoveryPoint').list(workspaceId, { limit: 1000 });
    if (points.length === 1000) throw new Neo4jRestoreError('NEO4J_RESTORE_CHAIN_LIMIT', 'The Neo4j restore chain exceeds the bounded recovery-point scan.', { category: 'capacity' });
    const byId = new Map(points.map((point) => [point.id, point]));
    byId.set(selectedPoint.id, selectedPoint);
    const newestFirst = [];
    const seen = new Set();
    let current = selectedPoint;
    while (current) {
      if (seen.has(current.id) || newestFirst.length >= 1000) throw new Neo4jRestoreError('NEO4J_RESTORE_CHAIN_INVALID', 'The Neo4j restore chain is cyclic or exceeds the supported length.', { category: 'integrity' });
      seen.add(current.id);
      if (current.sourceId !== selectedPoint.sourceId || current.jobId !== selectedPoint.jobId || !['full', 'differential'].includes(current.type) || current.consistency !== 'application' || current.verification?.state !== 'succeeded' || current.retention?.deletionEligible === true) throw new Neo4jRestoreError('NEO4J_RECOVERY_POINT_INVALID', 'Every Neo4j restore ancestor must be retained, verified, and application-consistent.', { category: 'validation' });
      newestFirst.push(current);
      if (current.type === 'full') break;
      if (!current.parentRecoveryPointId || !(current = byId.get(current.parentRecoveryPointId))) throw new Neo4jRestoreError('NEO4J_RESTORE_CHAIN_INCOMPLETE', 'A required Neo4j restore ancestor is missing.', { category: 'integrity' });
    }
    const chain = newestFirst.reverse();
    const root = chain[0];
    if (!root || root.type !== 'full' || root.chainRootId !== root.id || chain.some((point, index) => point.chainRootId !== root.id || (index > 0 && point.parentRecoveryPointId !== chain[index - 1].id))) throw new Neo4jRestoreError('NEO4J_RESTORE_CHAIN_INVALID', 'The Neo4j RecoveryPoint lineage is not a complete ordered chain.', { category: 'integrity' });
    const repositoryId = (root.repositoryCopies || []).find((copy) => (!requestedRepositoryId || copy.repositoryId === requestedRepositoryId) && copy.state === 'available' && chain.every((point) => (point.repositoryCopies || []).some((candidate) => candidate.repositoryId === copy.repositoryId && candidate.state === 'available')))?.repositoryId;
    if (!repositoryId) throw new Neo4jRestoreError('NEO4J_RESTORE_CHAIN_REPOSITORY_UNAVAILABLE', 'No repository contains the complete Neo4j restore chain.', { category: 'not-found' });
    const opened = await this.openRepository(workspaceId, repositoryId);
    const artifacts = await this.controlDatabase.repository('artifact').list(workspaceId, { limit: 5000 });
    if (artifacts.length === 5000) throw new Neo4jRestoreError('NEO4J_RESTORE_ARTIFACT_LIMIT', 'The Neo4j restore artifact scan exceeded its bounded limit.', { category: 'capacity' });
    const entries = [];
    const filenames = new Set();
    let previous = null;
    for (const point of chain) {
      const copy = point.repositoryCopies.find((item) => item.repositoryId === repositoryId && item.state === 'available');
      const artifact = artifacts.find((item) => item.recoveryPointId === point.id && item.repositoryId === repositoryId && item.kind === 'physical-backup' && item.metadata?.adapterId === ADAPTER_ID && item.metadata?.kind === 'neo4j-enterprise-backup');
      if (!artifact) throw new Neo4jRestoreError('NEO4J_RESTORE_ARTIFACT_UNAVAILABLE', 'A required Neo4j native restore Artifact is unavailable.', { category: 'not-found' });
      const snapshot = await opened.engine.openSnapshot({}, { repositoryId, snapshotId: copy.engineSnapshotId, masterKey: opened.masterKey });
      if (snapshot.summary?.manifestKey !== copy.manifestLocator || snapshot.summary?.manifestChecksum?.digest !== copy.manifestChecksum?.digest) throw new Neo4jRestoreError('NEO4J_RESTORE_MANIFEST_INVALID', 'A Neo4j repository manifest no longer matches its RecoveryPoint.', { category: 'integrity' });
      const locatorPath = decodeURIComponent(String(artifact.locator || '').split('#').slice(1).join('#'));
      const file = (snapshot.manifest.files || []).find((candidate) => candidate.type === 'file' && candidate.path === locatorPath && candidate.metadata?.artifactKind === 'physical-backup' && candidate.metadata?.database?.adapterId === ADAPTER_ID);
      const metadata = file?.metadata?.database;
      const native = metadata?.artifact;
      const range = metadata?.transactionRange;
      const filename = String(native?.nativeFileName || '');
      if (!file || file.sizeBytes !== artifact.sizeBytes || file.contentDigest?.digest !== artifact.checksum?.digest || metadataDigest(metadata) !== metadataDigest(artifact.metadata)
        || metadata.selectionDigest !== source.selector?.digest || metadata.database?.name !== source.selector?.databases?.include?.[0]?.name?.toLowerCase() || metadata.database?.databaseId !== source.physicalExecution?.databaseId
        || metadata.source?.deploymentFingerprint !== source.physicalExecution?.deploymentFingerprint || metadata.source?.topologyFingerprint !== source.physicalExecution?.topologyFingerprint || metadata.edition !== 'enterprise'
        || metadata.productVersion !== source.physicalExecution?.productVersion || metadata.metadataScope !== (source.selector?.includeGlobalObjects ? 'database-store-and-rbac' : 'database-store-only-no-rbac')
        || native?.path !== file.path || native?.sizeBytes !== file.sizeBytes || native?.nativeKind !== 'neo4j-backup' || !/^sha256:[0-9a-f]{64}$/.test(String(native?.contentDigest || '')) || !/^sha256:[0-9a-f]{64}$/.test(String(native?.inspectionDigest || '')) || !/^[A-Za-z0-9._+-]+$/.test(String(native?.storeFormat || ''))
        || !/^[A-Za-z0-9][A-Za-z0-9._+-]*[.]backup$/.test(filename) || filename.includes('..') || filenames.has(filename)
        || metadata.backupMode !== point.type || !Number.isSafeInteger(range?.lowestTransactionId) || !Number.isSafeInteger(range?.highestTransactionId) || range.lowestTransactionId < 0 || range.highestTransactionId < range.lowestTransactionId
        || (point.type === 'full' && (metadata.chain?.parentRecoveryPointId || metadata.chain?.chainRootRecoveryPointId))
        || (point.type === 'differential' && (metadata.chain?.parentRecoveryPointId !== point.parentRecoveryPointId || metadata.chain?.chainRootRecoveryPointId !== root.id))) throw new Neo4jRestoreError('NEO4J_RESTORE_ARTIFACT_INVALID', 'Authenticated Neo4j native restore metadata is incomplete or inconsistent.', { category: 'integrity' });
      if (previous) {
        const firstOverlap = previous.metadata.backupMode === 'full' && supportsFirstDifferentialOverlap(metadata.productVersion);
        const contiguous = firstOverlap ? range.lowestTransactionId <= previous.metadata.transactionRange.highestTransactionId + 1 : range.lowestTransactionId === previous.metadata.transactionRange.highestTransactionId + 1;
        if (native.storeFormat !== previous.metadata.artifact.storeFormat || !contiguous || range.highestTransactionId < previous.metadata.transactionRange.highestTransactionId) throw new Neo4jRestoreError('NEO4J_RESTORE_CHAIN_GAP', 'The authenticated Neo4j restore chain is discontinuous.', { category: 'integrity' });
      }
      filenames.add(filename);
      const entry = { point, copy, artifact, snapshot, file, metadata };
      entries.push(entry);
      previous = entry;
    }
    const totalBytes = entries.reduce((sum, entry) => sum + entry.file.sizeBytes, 0);
    if (!Number.isSafeInteger(totalBytes) || totalBytes < 1) throw new Neo4jRestoreError('NEO4J_RESTORE_SIZE_INVALID', 'The Neo4j restore chain size is invalid.', { category: 'capacity' });
    return { opened, entries, metadata: entries.at(-1).metadata, totalBytes };
  }

  async #prepare(workspaceId, request, signal) {
    const authenticated = await this.authenticateRecoveryPoint(workspaceId, request.recoveryPointId);
    const { point, source } = authenticated;
    const targetConnection = await this.controlDatabase.repository('connection').get(workspaceId, request.targetConnectionId);
    if (!targetConnection || targetConnection.adapterId !== ADAPTER_ID || targetConnection.lastTest?.status !== 'success' || !targetConnection.trust?.fingerprint || !(targetConnection.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new Neo4jRestoreError('NEO4J_RESTORE_TARGET_CONNECTION_INVALID', 'Choose a successfully tested Neo4j target connection on this device.', { category: 'connectivity', retryable: true });
    const enterprise = source.consistency?.method === 'neo4j-native-backup' || source.physicalExecution?.tier === 'enterprise-online' || point.type === 'differential';
    const sourceEvidence = {
      kind: authenticated.metadata.kind,
      adapterId: authenticated.metadata.adapterId,
      edition: authenticated.metadata.edition,
      productVersion: authenticated.metadata.productVersion,
      deploymentFingerprint: authenticated.metadata.source?.deploymentFingerprint,
      topologyFingerprint: authenticated.metadata.source?.topologyFingerprint,
      database: authenticated.metadata.database,
      metadataScope: authenticated.metadata.metadataScope,
      artifact: authenticated.metadata.artifact,
      chain: enterprise ? authenticated.entries.map((entry) => ({ pointId: entry.point.id, backupMode: entry.metadata.backupMode, transactionRange: entry.metadata.transactionRange, chain: entry.metadata.chain, artifact: entry.metadata.artifact })) : undefined
    };
    const plan = await this.connectionService.withExecution(workspaceId, targetConnection, signal, (context, connection) => this.adapter.planRestore(context, { mode: 'alternate', confirmation: 'RESTORE_NEO4J_ALTERNATE', connection, targetDatabase: request.targetDatabase, source: sourceEvidence }));
    return { ...authenticated, targetConnection, sourceEvidence, plan };
  }

  async #execute(workspaceId, actorId, restoreRunId, request, signal) {
    let progress = { phase: 'preparing', itemsTotal: 1, itemsCompleted: 0, bytesTotal: 0, bytesWritten: 0, throughputBytesPerSecond: 0, startedAt: this.clock(), updatedAt: this.clock(), warnings: [] };
    const startedMs = this.now();
    let validationRecord = null;
    try {
      await this.#project(workspaceId, restoreRunId, { state: 'preparing', progress }, actorId);
      const prepared = await this.#prepare(workspaceId, request, signal);
      progress.itemsTotal = prepared.entries.length;
      progress.bytesTotal = prepared.totalBytes;
      const byPath = new Map(prepared.entries.map((entry) => [entry.file.path, entry]));
      const restored = await this.connectionService.withExecution(workspaceId, prepared.targetConnection, signal, async (context) => this.adapter.executeRestore({
        ...context,
        restoreRunId,
        onRestoreProgress: ({ bytesWritten, bytesTotal }) => {
          progress.bytesWritten = bytesWritten;
          progress.bytesTotal = bytesTotal;
          progress.throughputBytesPerSecond = Math.round(bytesWritten / Math.max(1, (this.now() - startedMs) / 1000));
          progress.updatedAt = this.clock();
        },
        onStageAllocated: async (stagePath) => {
          progress = { ...progress, phase: 'staging', updatedAt: this.clock() };
          const current = await this.controlDatabase.repository('restoreRun').get(workspaceId, restoreRunId);
          await this.#project(workspaceId, restoreRunId, { progress, target: { ...(current.target || {}), stagePath } }, actorId);
        },
        onMutationStarted: async ({ nativeDirectory }) => {
          progress = { ...progress, phase: 'loading', updatedAt: this.clock() };
          const current = await this.controlDatabase.repository('restoreRun').get(workspaceId, restoreRunId);
          await this.#project(workspaceId, restoreRunId, { state: 'running', progress, target: { ...(current.target || {}), stagePath: nativeDirectory, nativeMutationStarted: true } }, actorId);
        }
      }, prepared.plan, {
        open: async (artifactPath) => {
          const entry = byPath.get(artifactPath);
          if (!entry) throw new Neo4jRestoreError('NEO4J_RESTORE_ARTIFACT_INVALID', 'The requested Neo4j restore artifact is outside the authenticated chain.', { category: 'integrity' });
          return prepared.opened.engine.streamFile({}, { repositoryId: entry.copy.repositoryId, manifest: entry.snapshot.manifest, masterKey: prepared.opened.masterKey, path: entry.file.path });
        }
      }));
      progress = { ...progress, phase: 'validating', itemsCompleted: prepared.entries.length, updatedAt: this.clock() };
      const current = await this.controlDatabase.repository('restoreRun').get(workspaceId, restoreRunId);
      await this.#project(workspaceId, restoreRunId, { state: current.state === 'running' ? 'validating' : current.state, progress, target: { ...(current.target || {}), stagePath: null } }, actorId);
      const validation = await this.adapter.validateRestore({}, restored);
      validationRecord = { state: validation.status, connectivity: 'unavailable', expectedObjects: 'unavailable', nativeIntegrityValidation: Boolean(validation.nativeIntegrityValidation), checks: validation.checks || [], completedAt: this.clock() };
      if (!validation.valid) throw new Neo4jRestoreError('NEO4J_RESTORE_VALIDATION_FAILED', 'The loaded Neo4j database did not pass authenticated native validation.', { category: 'integrity' });
      progress = { ...progress, phase: 'complete', updatedAt: this.clock() };
      const latest = await this.controlDatabase.repository('restoreRun').get(workspaceId, restoreRunId);
      return this.#project(workspaceId, restoreRunId, {
        state: 'succeeded',
        progress,
        target: { ...(latest.target || {}), stagePath: null, serviceStarted: false },
        validation: validationRecord,
        result: { recoveryPointId: prepared.point.id, chainRecoveryPointIds: prepared.entries.map((entry) => entry.point.id), artifactCount: restored.artifactCount, targetDatabase: restored.targetDatabase, bytesRestored: restored.sizeBytes, contentDigest: restored.contentDigest, storeFormat: restored.storeFormat, consistencyCheckDigest: restored.consistencyCheckDigest, serviceStarted: false, warnings: [], completedAt: this.clock() }
      }, actorId);
    } catch (error) {
      const current = await this.controlDatabase.repository('restoreRun').get(workspaceId, restoreRunId);
      if (current && !TERMINAL_STATES.has(current.state)) {
        const canceled = signal.aborted || error?.code === 'NEO4J_RESTORE_CANCELED';
        const mutated = current.target?.nativeMutationStarted === true;
        const state = mutated ? 'interrupted' : canceled ? 'canceled' : 'failed';
        const safe = mutated ? { code: 'NEO4J_RESTORE_TARGET_REQUIRES_INSPECTION', category: 'restore', retryable: false, safeMessage: 'Neo4j native load began but recovery did not finish. The target database and owned stage are preserved for inspection; no rollback is claimed.' } : canceled ? { code: 'NEO4J_RESTORE_CANCELED', category: 'canceled', retryable: false, safeMessage: 'The Neo4j recovery was canceled before native load and its owned stage was removed.' } : publicError(error);
        return this.#project(workspaceId, restoreRunId, { state, target: mutated ? current.target : { ...(current.target || {}), stagePath: null }, progress: { ...progress, phase: mutated ? 'operator-action-required' : state, updatedAt: this.clock() }, validation: validationRecord, result: { error: safe, completedAt: this.clock() } }, actorId);
      }
      throw error;
    }
  }
}

module.exports = { Neo4jRestoreError, Neo4jRestoreService, RESTORE_CONFIRMATION, normalizeRequest };
