const crypto = require('crypto');
const fsNative = require('fs');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { generateUuidV7 } = require('./control-database');
const { ADAPTER_ID, MAX_DUMP_BYTES, stableDigest } = require('./neo4j');

const CONFIRMATION = 'AGGREGATE NEO4J BACKUP';
const OPERATION = 'neo4j-enterprise-aggregation';
const TERMINAL_STATES = new Set(['succeeded', 'warning', 'failed', 'canceled', 'interrupted']);

class Neo4jAggregationError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'Neo4jAggregationError';
    this.code = code;
    this.category = options.category || 'aggregation';
    this.retryable = Boolean(options.retryable);
  }
}

function requiredText(value, label, maximumLength = 4096) {
  const text = String(value ?? '').trim();
  if (!text || text.includes('\0') || text.length > maximumLength) throw new TypeError(`${label} is invalid.`);
  return text;
}

function normalizeRequest(input = {}, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Neo4j aggregation request must be an object.');
  if (options.requireConfirmation !== false && (input.confirmed !== true || String(input.confirmationText || '').trim() !== CONFIRMATION)) throw new Neo4jAggregationError('NEO4J_AGGREGATE_CONFIRMATION_REQUIRED', 'Confirm Neo4j native-chain aggregation before continuing.', { category: 'conflict' });
  return {
    recoveryPointId: requiredText(input.recoveryPointId, 'RecoveryPoint ID', 200),
    repositoryId: requiredText(input.repositoryId, 'Repository ID', 200),
    expectedPlanId: input.expectedPlanId ? requiredText(input.expectedPlanId, 'Aggregation plan ID', 200) : null
  };
}

function publicError(error) {
  if (error instanceof Neo4jAggregationError || (error?.code && error?.category)) return { code: String(error.code).slice(0, 100), category: String(error.category || 'aggregation').slice(0, 80), retryable: Boolean(error.retryable), safeMessage: String(error.message || 'Neo4j aggregation failed.').slice(0, 500) };
  return { code: 'NEO4J_AGGREGATE_FAILED', category: 'aggregation', retryable: false, safeMessage: 'DeployerX could not aggregate the Neo4j native backup chain.' };
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function planId(value) {
  return `neo4j_aggregate_${crypto.createHash('sha256').update(canonical(value)).digest('hex')}`;
}

class Neo4jAggregationService {
  constructor({ controlDatabase, deviceId, adapter, connectionService, chainService, openRepository, temporaryRoot = path.join(os.tmpdir(), 'deployerx-neo4j-aggregation'), fileSystem = fs, createReadStream = fsNative.createReadStream, clock = () => new Date().toISOString() } = {}) {
    if (!controlDatabase || !adapter || !connectionService || !chainService || typeof chainService.prepareEnterpriseChain !== 'function' || typeof openRepository !== 'function') throw new TypeError('Neo4j aggregation dependencies are required.');
    this.controlDatabase = controlDatabase;
    this.deviceId = requiredText(deviceId, 'Device ID', 200);
    this.workerId = `device:${this.deviceId}`;
    this.adapter = adapter;
    this.connectionService = connectionService;
    this.chainService = chainService;
    this.openRepository = openRepository;
    this.temporaryRoot = path.resolve(requiredText(temporaryRoot, 'Neo4j aggregation temporary root'));
    this.fileSystem = fileSystem;
    this.createReadStream = createReadStream;
    this.clock = clock;
    this.active = new Map();
  }

  async #prepare(workspaceId, request) {
    const prepared = await this.chainService.prepareEnterpriseChain(workspaceId, request.recoveryPointId, request.repositoryId);
    const [connection, repository, job] = await Promise.all([
      this.controlDatabase.repository('connection').get(workspaceId, prepared.source.connectionId),
      this.controlDatabase.repository('repository').get(workspaceId, request.repositoryId),
      this.controlDatabase.repository('backupJob').get(workspaceId, prepared.point.jobId)
    ]);
    const execution = prepared.source.physicalExecution;
    const identity = connection?.lastTest?.endpointIdentity;
    if (!connection || connection.adapterId !== ADAPTER_ID || connection.lastTest?.status !== 'success' || !(connection.workerAffinity || []).includes(this.workerId) || connection.revision !== execution.connectionRevision || connection.trust?.fingerprint !== execution.deploymentFingerprint || connection.trust?.topologyFingerprint !== execution.topologyFingerprint || identity?.version !== execution.productVersion) throw new Neo4jAggregationError('NEO4J_AGGREGATE_CONNECTION_CHANGED', 'The tested Neo4j aggregation connection changed after Source enrollment.', { category: 'integrity' });
    if (!repository || !(repository.workerAffinity || []).includes(this.workerId) || repository.health?.status !== 'ready' || repository.health?.lockState?.status === 'unavailable') throw new Neo4jAggregationError('NEO4J_AGGREGATE_REPOSITORY_UNAVAILABLE', 'The selected aggregation repository is unavailable on this device.', { category: 'repository', retryable: true });
    if (!job || job.sourceId !== prepared.source.id) throw new Neo4jAggregationError('NEO4J_AGGREGATE_JOB_INVALID', 'The selected Neo4j chain no longer belongs to its recorded Job.', { category: 'integrity' });
    if (!Number.isSafeInteger(prepared.totalBytes) || prepared.totalBytes < 1 || prepared.totalBytes > MAX_DUMP_BYTES) throw new Neo4jAggregationError('NEO4J_AGGREGATE_SIZE_INVALID', 'The Neo4j chain exceeds the supported aggregation staging limit.', { category: 'capacity' });
    const evidence = {
      version: 1,
      recoveryPointId: prepared.point.id,
      recoveryPointRevision: prepared.point.revision,
      sourceId: prepared.source.id,
      sourceRevision: prepared.source.revision,
      jobId: prepared.point.jobId,
      repositoryId: request.repositoryId,
      connectionId: connection.id,
      connectionRevision: connection.revision,
      databaseId: prepared.metadata.database.databaseId,
      productVersion: prepared.metadata.productVersion,
      chain: prepared.entries.map((entry) => ({ recoveryPointId: entry.point.id, recoveryPointRevision: entry.point.revision, artifactId: entry.artifact.id, artifactRevision: entry.artifact.revision, contentDigest: entry.metadata.artifact.contentDigest, sizeBytes: entry.file.sizeBytes }))
    };
    return { ...prepared, connection, repository, job, evidence, planId: planId(evidence) };
  }

  async preview(workspaceId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const request = normalizeRequest(input, { requireConfirmation: false });
    const prepared = await this.#prepare(tenant, request);
    return {
      operation: OPERATION,
      planId: prepared.planId,
      recoveryPointId: prepared.point.id,
      repositoryId: prepared.repository.id,
      database: prepared.metadata.database.name,
      databaseId: prepared.metadata.database.databaseId,
      productVersion: prepared.metadata.productVersion,
      storeFormat: prepared.metadata.artifact.storeFormat,
      chainRecoveryPointIds: prepared.entries.map((entry) => entry.point.id),
      artifactCount: prepared.entries.length,
      sourceBytes: prepared.totalBytes,
      publishesIndependentFull: true,
      preservesSourceChain: true,
      confirmationText: CONFIRMATION
    };
  }

  async start(workspaceId, actorId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const request = normalizeRequest(input);
    const prepared = await this.#prepare(tenant, request);
    if (!request.expectedPlanId || request.expectedPlanId !== prepared.planId) throw new Neo4jAggregationError('NEO4J_AGGREGATE_PLAN_STALE', 'Review a fresh Neo4j aggregation preview before starting.', { category: 'conflict' });
    const baseOccurrenceKey = `${OPERATION}:${prepared.planId}`;
    const priorRuns = (await this.list(tenant, { limit: 200 })).filter((run) => run.idempotencyKey?.startsWith(`${baseOccurrenceKey}:`));
    const existing = priorRuns.find((run) => !['failed', 'canceled', 'interrupted'].includes(run.state));
    if (existing) return existing;
    const attempt = priorRuns.length + 1;
    const occurrenceKey = attempt === 1 ? baseOccurrenceKey : `${baseOccurrenceKey}:retry:${attempt}`;
    const created = await this.controlDatabase.transaction((transaction) => {
      const group = transaction.create('executionGroup', { workspaceId: tenant, actorId: actor, jobId: prepared.job.id, jobRevision: prepared.job.revision, trigger: 'api', scheduledFor: null, idempotencyKey: occurrenceKey, state: 'pending', latestRunId: null, terminalRunId: null });
      const run = transaction.create('run', {
        workspaceId: tenant, actorId: actor, jobId: prepared.job.id, jobRevision: prepared.job.revision, executionGroupId: group.id, scheduledFor: null,
        idempotencyKey: `${occurrenceKey}:attempt:${attempt}`, trigger: 'api', workerId: this.workerId, state: 'queued', attempt, parentRunId: priorRuns.at(-1)?.id || null,
        configSnapshot: { version: 1, operation: OPERATION, source: { id: prepared.source.id, revision: prepared.source.revision }, repositories: [{ id: prepared.repository.id }], selectedRecoveryPointIds: prepared.entries.map((entry) => entry.point.id) },
        planDigest: prepared.planId, progress: { phase: 'queued', sourceBytes: prepared.totalBytes, bytesRead: 0, uploadedBytes: 0, reusedBytes: 0, itemsTotal: prepared.entries.length, itemsCompleted: 0, repositorySnapshotId: null, startedAt: null, updatedAt: this.clock() },
        lease: null, checkpoint: { available: false, sequence: 0, runId: null }, startedAt: null, finishedAt: null, result: null
      });
      transaction.projectExecution('executionGroup', tenant, group.id, { latestRunId: run.id }, { expectedRevision: group.revision, actorId: actor });
      return run;
    });
    const controller = new AbortController();
    const operation = this.#execute(tenant, actor, created.id, request, controller.signal).catch(() => this.controlDatabase.repository('run').get(tenant, created.id));
    this.active.set(created.id, { operation, controller });
    operation.finally(() => this.active.delete(created.id));
    return created;
  }

  async wait(workspaceId, runId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const id = requiredText(runId, 'Aggregation Run ID', 200);
    if (this.active.has(id)) await this.active.get(id).operation;
    const run = await this.controlDatabase.repository('run').get(tenant, id);
    if (!run || run.configSnapshot?.operation !== OPERATION) throw new Neo4jAggregationError('NEO4J_AGGREGATE_RUN_NOT_FOUND', 'The Neo4j aggregation Run was not found.', { category: 'not-found' });
    return run;
  }

  async cancel(workspaceId, actorId, runId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    requiredText(actorId, 'Actor ID', 200);
    const id = requiredText(runId, 'Aggregation Run ID', 200);
    const run = await this.controlDatabase.repository('run').get(tenant, id);
    if (!run || run.configSnapshot?.operation !== OPERATION) throw new Neo4jAggregationError('NEO4J_AGGREGATE_RUN_NOT_FOUND', 'The Neo4j aggregation Run was not found.', { category: 'not-found' });
    if (TERMINAL_STATES.has(run.state)) return run;
    const active = this.active.get(id);
    if (!active) throw new Neo4jAggregationError('NEO4J_AGGREGATE_NOT_ACTIVE', 'The Neo4j aggregation is not active in this process.', { category: 'conflict' });
    active.controller.abort();
    await active.operation;
    return this.controlDatabase.repository('run').get(tenant, id);
  }

  async list(workspaceId, options = {}) {
    return (await this.controlDatabase.repository('run').list(requiredText(workspaceId, 'Workspace ID', 200), { limit: Math.min(200, Math.max(1, Number(options.limit) || 50)) })).filter((run) => run.configSnapshot?.operation === OPERATION);
  }

  async reconcile(workspaceId, actorId = 'system') {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const reconciled = [];
    for (const run of (await this.list(tenant, { limit: 200 })).filter((item) => !TERMINAL_STATES.has(item.state) && !this.active.has(item.id))) {
      const state = run.progress?.repositorySnapshotId ? 'interrupted' : 'failed';
      const updated = await this.controlDatabase.transaction((transaction) => {
        const current = transaction.get('run', tenant, run.id);
        const group = transaction.get('executionGroup', tenant, current.executionGroupId);
        const projected = transaction.projectExecution('run', tenant, current.id, { state, finishedAt: this.clock(), result: { recoveryPointIds: [], warnings: [], safeErrorCode: state === 'interrupted' ? 'NEO4J_AGGREGATE_PUBLICATION_INTERRUPTED' : 'NEO4J_AGGREGATE_PROCESS_INTERRUPTED', completedAt: this.clock() } }, { expectedRevision: current.revision, actorId: actor });
        if (group && !TERMINAL_STATES.has(group.state)) transaction.projectExecution('executionGroup', tenant, group.id, { state: 'failed', terminalRunId: current.id }, { expectedRevision: group.revision, actorId: actor });
        return projected;
      });
      reconciled.push(updated);
    }
    return reconciled;
  }

  async #project(workspaceId, runId, changes, actorId) {
    return this.controlDatabase.transaction((transaction) => {
      const current = transaction.get('run', workspaceId, runId);
      return transaction.projectExecution('run', workspaceId, runId, changes, { expectedRevision: current.revision, actorId });
    });
  }

  async #execute(workspaceId, actorId, runId, request, signal) {
    let stageDirectory = null;
    let lease = null;
    let prepared;
    try {
      let run = await this.#project(workspaceId, runId, { state: 'preparing', startedAt: this.clock(), progress: { phase: 'preparing', sourceBytes: 0, bytesRead: 0, uploadedBytes: 0, reusedBytes: 0, itemsTotal: 0, itemsCompleted: 0, repositorySnapshotId: null, startedAt: this.clock(), updatedAt: this.clock() } }, actorId);
      prepared = await this.#prepare(workspaceId, request);
      if (prepared.planId !== request.expectedPlanId) throw new Neo4jAggregationError('NEO4J_AGGREGATE_PLAN_STALE', 'The Neo4j aggregation chain changed after preview.', { category: 'conflict' });
      const opened = await this.openRepository(workspaceId, prepared.repository.id);
      lease = await opened.adapter.acquireLock({ masterKey: opened.masterKey }, { repositoryId: prepared.repository.id, operation: 'neo4j-aggregate', scope: `repository:${prepared.repository.id}:mutation`, workerId: this.workerId, runId, ttlMs: 15 * 60 * 1000 });
      const group = await this.controlDatabase.repository('executionGroup').get(workspaceId, run.executionGroupId);
      await this.controlDatabase.transaction((transaction) => transaction.projectExecution('executionGroup', workspaceId, group.id, { state: 'running' }, { expectedRevision: group.revision, actorId }));
      run = await this.#project(workspaceId, runId, { state: 'running', progress: { ...run.progress, phase: 'aggregating', sourceBytes: prepared.totalBytes, itemsTotal: prepared.entries.length, updatedAt: this.clock() } }, actorId);
      await this.fileSystem.mkdir(this.temporaryRoot, { recursive: true, mode: 0o700 });
      stageDirectory = await this.fileSystem.mkdtemp(path.join(this.temporaryRoot, 'run-'));
      await this.fileSystem.chmod(stageDirectory, 0o700).catch(() => {});
      const destination = path.join(stageDirectory, `${prepared.metadata.database.name}.backup`);
      const chain = prepared.entries.map((entry) => ({
        pointId: entry.point.id, fileName: entry.metadata.artifact.nativeFileName, sizeBytes: entry.file.sizeBytes, contentDigest: entry.metadata.artifact.contentDigest,
        databaseId: entry.metadata.database.databaseId, backupMode: entry.metadata.backupMode, storeFormat: entry.metadata.artifact.storeFormat, highestTransactionId: entry.metadata.transactionRange.highestTransactionId,
        open: () => prepared.opened.engine.streamFile({}, { repositoryId: entry.copy.repositoryId, manifest: entry.snapshot.manifest, masterKey: prepared.opened.masterKey, path: entry.file.path })
      }));
      let renewalError = null;
      let renewal = Promise.resolve();
      const heartbeat = setInterval(() => {
        renewal = renewal.then(async () => { lease = await opened.adapter.renewLock({ masterKey: opened.masterKey }, lease); }).catch((error) => { renewalError = error; });
      }, 5 * 60 * 1000);
      heartbeat.unref?.();
      let media;
      try {
        media = await this.connectionService.withExecution(workspaceId, prepared.connection, signal, (context, connection) => this.adapter.aggregateOnlineBackupMedia({ ...context, aggregationRunId: runId, onAggregationProgress: ({ bytesWritten }) => { run.progress.bytesRead = bytesWritten; run.progress.updatedAt = this.clock(); } }, {
          connection, productVersion: prepared.metadata.productVersion, databaseName: prepared.metadata.database.name, databaseId: prepared.metadata.database.databaseId, totalBytes: prepared.totalBytes, chain
        }, destination));
      } finally {
        clearInterval(heartbeat);
        await renewal;
      }
      if (renewalError) throw new Neo4jAggregationError('NEO4J_AGGREGATE_LOCK_LOST', 'Neo4j aggregation lost its repository mutation lock before publication.', { category: 'conflict', retryable: true });
      lease = await opened.adapter.renewLock({ masterKey: opened.masterKey }, lease);
      if (signal.aborted) throw new Neo4jAggregationError('NEO4J_AGGREGATE_CANCELED', 'Neo4j aggregation was canceled before publication.', { category: 'canceled' });
      const artifactPath = `neo4j/${media.nativeFileName}`;
      const databaseManifest = {
        version: 1, kind: 'neo4j-enterprise-backup', adapterId: ADAPTER_ID, adapterVersion: this.adapter.manifest().adapterVersion, engine: 'neo4j', backupMethod: 'physical', backupMode: 'full', requestedBackupMode: 'aggregation',
        selection: prepared.source.selector, selectionDigest: prepared.source.selector.digest, consistency: { ...prepared.metadata.consistency, backupMode: 'full' }, source: prepared.metadata.source, database: prepared.metadata.database,
        edition: 'enterprise', productVersion: prepared.metadata.productVersion, metadataScope: prepared.metadata.metadataScope, transactionRange: media.inspection,
        chain: { parentRecoveryPointId: null, chainRootRecoveryPointId: null, materializedParentRecoveryPointIds: [] }, nativeTools: prepared.metadata.nativeTools, warnings: prepared.metadata.warnings || [],
        aggregation: { version: 1, sourceRecoveryPointId: prepared.point.id, sourceChainRootRecoveryPointId: prepared.entries[0].point.id, sourceRecoveryPointIds: prepared.entries.map((entry) => entry.point.id), keepOldBackup: true, sourceMediaPreserved: true, aggregatedAt: this.clock() },
        artifact: { kind: 'physical-backup', nativeKind: 'neo4j-backup', path: artifactPath, nativeFileName: media.nativeFileName, mediaType: 'application/vnd.neo4j.backup', sizeBytes: media.sizeBytes, contentDigest: media.digest, inspectionDigest: media.inspectionDigest, storeFormat: media.storeFormat }
      };
      const summary = await opened.engine.createSnapshot({}, {
        repositoryId: prepared.repository.id, masterKey: opened.masterKey, keyVersion: opened.keyVersion, idempotencyKey: `${OPERATION}:${runId}:${prepared.repository.id}`, parentSnapshotId: null,
        files: (async function* aggregateFile() { yield { path: artifactPath, type: 'file', metadata: { workload: 'database', artifactKind: 'physical-backup', database: databaseManifest }, content: fsNative.createReadStream(media.filePath) }; })()
      });
      const snapshot = await opened.engine.openSnapshot({}, { repositoryId: prepared.repository.id, snapshotId: summary.snapshotId, masterKey: opened.masterKey });
      const file = snapshot.manifest.files.find((entry) => entry.path === artifactPath && entry.type === 'file');
      const manifestStat = await opened.adapter.stat({}, summary.manifestKey);
      if (!file || file.sizeBytes !== media.sizeBytes || canonical(file.metadata?.database) !== canonical(databaseManifest) || snapshot.summary.manifestChecksum?.digest !== summary.manifestChecksum?.digest || !manifestStat?.sizeBytes) throw new Neo4jAggregationError('NEO4J_AGGREGATE_PUBLICATION_INVALID', 'The published Neo4j aggregate failed repository authentication.', { category: 'integrity' });
      run = await this.#project(workspaceId, runId, { state: 'verifying', progress: { ...run.progress, phase: 'verifying', bytesRead: prepared.totalBytes, uploadedBytes: summary.uploadedBytes || 0, reusedBytes: summary.reusedBytes || 0, itemsCompleted: prepared.entries.length, repositorySnapshotId: summary.snapshotId, updatedAt: this.clock() } }, actorId);
      const finishedAt = this.clock();
      const recoveryPointId = `rp_${generateUuidV7()}`;
      await this.controlDatabase.transaction((transaction) => {
        const point = transaction.create('recoveryPoint', {
          id: recoveryPointId, workspaceId, actorId, jobId: prepared.point.jobId, sourceId: prepared.source.id, runId, type: 'full', consistency: 'application', chainRootId: recoveryPointId, parentRecoveryPointId: null,
          capturedFrom: prepared.entries[0].point.capturedFrom, capturedTo: prepared.point.capturedTo,
          repositoryCopies: [{ repositoryId: prepared.repository.id, engineSnapshotId: summary.snapshotId, state: 'available', manifestLocator: summary.manifestKey, manifestChecksum: summary.manifestChecksum, immutableUntil: null }],
          verification: { mode: 'native-inspection-and-manifest', state: 'succeeded', verifiedAt: finishedAt, verificationRunId: null }, retention: { ...(prepared.point.retention || {}), expireAt: null, ruleMatches: ['neo4j-aggregate-baseline'], deletionEligible: false, evaluatedAt: finishedAt }, manifestChecksum: stableDigest([{ repositoryId: prepared.repository.id, checksum: summary.manifestChecksum }]),
          physical: { engine: 'neo4j', databaseId: prepared.metadata.database.databaseId, storeFormat: media.storeFormat, aggregation: true, sourceRecoveryPointId: prepared.point.id }
        });
        transaction.create('artifact', { workspaceId, actorId, recoveryPointId: point.id, repositoryId: prepared.repository.id, kind: 'manifest', locator: summary.manifestKey, sizeBytes: manifestStat.sizeBytes, checksum: summary.manifestChecksum, encryption: { algorithm: 'aes-256-gcm', keyVersion: summary.keyVersion || null }, compression: { mode: 'native' } });
        transaction.create('artifact', { workspaceId, actorId, recoveryPointId: point.id, repositoryId: prepared.repository.id, kind: 'physical-backup', locator: `${summary.manifestKey}#${encodeURIComponent(artifactPath)}`, sizeBytes: file.sizeBytes, checksum: file.contentDigest, encryption: { algorithm: 'aes-256-gcm', keyVersion: summary.keyVersion || null }, compression: { mode: 'native' }, metadata: databaseManifest });
        const currentRun = transaction.get('run', workspaceId, runId);
        transaction.projectExecution('run', workspaceId, runId, { state: 'succeeded', finishedAt, progress: { ...currentRun.progress, phase: 'completed', updatedAt: finishedAt }, result: { recoveryPointIds: [point.id], sourceRecoveryPointIds: prepared.entries.map((entry) => entry.point.id), warnings: [], safeErrorCode: null, sourceBytes: prepared.totalBytes, aggregateBytes: media.sizeBytes, uploadedBytes: summary.uploadedBytes || 0, reusedBytes: summary.reusedBytes || 0 } }, { expectedRevision: currentRun.revision, actorId });
        const currentGroup = transaction.get('executionGroup', workspaceId, currentRun.executionGroupId);
        transaction.projectExecution('executionGroup', workspaceId, currentGroup.id, { state: 'succeeded', terminalRunId: runId }, { expectedRevision: currentGroup.revision, actorId });
      });
    } catch (error) {
      const current = await this.controlDatabase.repository('run').get(workspaceId, runId);
      if (current && !TERMINAL_STATES.has(current.state)) {
        const canceled = signal.aborted || error?.code === 'NEO4J_AGGREGATE_CANCELED';
        const state = canceled ? 'canceled' : current.progress?.repositorySnapshotId ? 'interrupted' : 'failed';
        const failure = publicError(error);
        await this.controlDatabase.transaction((transaction) => {
          const run = transaction.get('run', workspaceId, runId);
          transaction.projectExecution('run', workspaceId, runId, { state, finishedAt: this.clock(), progress: { ...run.progress, phase: state, updatedAt: this.clock() }, result: { recoveryPointIds: [], warnings: [], safeErrorCode: failure.code, error: failure } }, { expectedRevision: run.revision, actorId });
          const group = transaction.get('executionGroup', workspaceId, run.executionGroupId);
          if (group && !TERMINAL_STATES.has(group.state)) transaction.projectExecution('executionGroup', workspaceId, group.id, { state: canceled ? 'canceled' : 'failed', terminalRunId: runId }, { expectedRevision: group.revision, actorId });
        });
      }
    } finally {
      if (lease && prepared?.repository) {
        const opened = await this.openRepository(workspaceId, prepared.repository.id).catch(() => null);
        await opened?.adapter.releaseLock({ masterKey: opened.masterKey }, lease).catch(() => {});
      }
      if (stageDirectory) await this.fileSystem.rm(stageDirectory, { recursive: true, force: true }).catch(() => {});
    }
  }
}

module.exports = { AGGREGATION_CONFIRMATION: CONFIRMATION, NEO4J_AGGREGATION_OPERATION: OPERATION, Neo4jAggregationError, Neo4jAggregationService, normalizeAggregationRequest: normalizeRequest };
