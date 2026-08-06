const path = require('path');
const { isDeepStrictEqual } = require('util');
const { ADAPTER_ID, redisRestorePath } = require('./redis');

const RESTORE_CONFIRMATIONS = Object.freeze({ alternate: 'RESTORE REDIS ALTERNATE', clusterAlternate: 'RESTORE REDIS CLUSTER ALTERNATE' });
const TERMINAL_STATES = new Set(['succeeded', 'warning', 'failed', 'canceled']);

class RedisRestoreError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'RedisRestoreError';
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

function normalizeRequest(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Redis restore request must be an object.');
  const mode = String(input.mode || 'alternate');
  if (mode !== 'alternate') throw new RedisRestoreError('REDIS_RESTORE_MODE_UNSUPPORTED', 'Redis recovery currently supports an isolated alternate directory only.', { category: 'compatibility' });
  const confirmationText = String(input.confirmationText || '').trim();
  if (input.confirmed !== true || !Object.values(RESTORE_CONFIRMATIONS).includes(confirmationText)) throw new RedisRestoreError('REDIS_RESTORE_CONFIRMATION_REQUIRED', 'Confirm the isolated alternate Redis recovery before continuing.', { category: 'conflict' });
  const targetDirectory = requiredText(input.targetDirectory, 'Redis recovery target directory');
  if (!path.isAbsolute(targetDirectory) || path.normalize(targetDirectory) !== targetDirectory) throw new RedisRestoreError('REDIS_RESTORE_TARGET_INVALID', 'Choose a canonical absolute directory for Redis recovery.', { category: 'validation' });
  const port = Number(input.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new RedisRestoreError('REDIS_RESTORE_PORT_INVALID', 'Redis isolated validation port must be between 1024 and 65535.', { category: 'validation' });
  return {
    recoveryPointId: requiredText(input.recoveryPointId, 'Recovery point ID', 200), mode, targetDirectory, port,
    confirmationText, redisServerExecutable: input.redisServerExecutable || 'redis-server', redisCliExecutable: input.redisCliExecutable || 'redis-cli', timeoutMs: input.timeoutMs || 30000
  };
}

function publicError(error) {
  if (error instanceof RedisRestoreError || (error?.code && error?.category)) return { code: String(error.code).slice(0, 100), category: String(error.category || 'restore').slice(0, 50), retryable: Boolean(error.retryable), safeMessage: String(error.message || 'The Redis recovery failed.').slice(0, 500) };
  return { code: 'REDIS_RESTORE_FAILED', category: 'restore', retryable: false, safeMessage: 'DeployerX could not complete the Redis recovery.' };
}

class RedisRestoreService {
  constructor({ controlDatabase, deviceId, adapter, openRepository, fileSystem, clock = () => new Date().toISOString() } = {}) {
    if (!controlDatabase || !adapter || typeof openRepository !== 'function') throw new TypeError('Redis restore dependencies are required.');
    this.controlDatabase = controlDatabase;
    this.deviceId = requiredText(deviceId, 'Device ID', 200);
    this.adapter = adapter;
    this.openRepository = openRepository;
    this.fileSystem = fileSystem || require('fs/promises');
    this.clock = clock;
    this.active = new Map();
  }

  async start(workspaceId, actorId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const request = normalizeRequest(input);
    const point = await this.controlDatabase.repository('recoveryPoint').get(tenant, request.recoveryPointId);
    if (!point || point.type !== 'full' || !['application', 'crash'].includes(point.consistency)) throw new RedisRestoreError('REDIS_RECOVERY_POINT_INVALID', 'Choose a Redis full recovery point with proven application or cluster crash consistency.', { category: 'validation' });
    const source = await this.controlDatabase.repository('source').get(tenant, point.sourceId);
    const connection = source ? await this.controlDatabase.repository('connection').get(tenant, source.connectionId) : null;
    if (!source || source.adapterId !== ADAPTER_ID || !connection || connection.adapterId !== ADAPTER_ID) throw new RedisRestoreError('REDIS_RECOVERY_POINT_INVALID', 'The selected recovery point is not a Redis native backup.', { category: 'validation' });
    const clusterSource = source.physicalExecution?.topology === 'cluster';
    if (point.consistency !== (clusterSource ? 'crash' : 'application')) throw new RedisRestoreError('REDIS_RECOVERY_POINT_INVALID', clusterSource ? 'Choose a Redis Cluster full recovery point with proven crash consistency.' : 'Choose a Redis full recovery point with proven application consistency.', { category: 'validation' });
    if (request.confirmationText !== (clusterSource ? RESTORE_CONFIRMATIONS.clusterAlternate : RESTORE_CONFIRMATIONS.alternate)) throw new RedisRestoreError('REDIS_RESTORE_CONFIRMATION_REQUIRED', clusterSource ? 'Confirm the isolated alternate Redis Cluster recovery before continuing.' : 'Confirm the isolated alternate Redis recovery before continuing.', { category: 'conflict' });
    if (!(connection.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new RedisRestoreError('REDIS_RESTORE_OTHER_DEVICE', 'Redis recovery must run on the protected source device.', { category: 'authorization' });
    if (await this.fileSystem.lstat(request.targetDirectory).catch(() => null)) throw new RedisRestoreError('REDIS_RESTORE_TARGET_EXISTS', 'Choose an absent directory for alternate Redis recovery.', { category: 'conflict' });
    const now = this.clock();
    const record = await this.controlDatabase.repository('restoreRun').create({
      workspaceId: tenant, actorId: actor, recoveryPointIds: [point.id], targetConnectionId: connection.id,
      target: { operation: 'alternate-directory', mode: 'alternate', engine: 'redis', sourceId: source.id, connectionId: connection.id, targetDirectory: request.targetDirectory, targetName: path.basename(request.targetDirectory), port: request.port },
      mode: 'alternate', conflictPolicy: 'fail', workerId: `device:${this.deviceId}`, state: 'queued',
      progress: { phase: 'queued', itemsTotal: 0, itemsCompleted: 0, bytesTotal: 0, bytesWritten: 0, throughputBytesPerSecond: 0, startedAt: null, updatedAt: now, warnings: [] }, validation: null, result: null
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
    if (!record || record.target?.engine !== 'redis') throw new RedisRestoreError('REDIS_RESTORE_RUN_NOT_FOUND', 'The Redis RestoreRun was not found.', { category: 'not-found' });
    return record;
  }

  async cancel(workspaceId, actorId, restoreRunId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    requiredText(actorId, 'Actor ID', 200);
    const id = requiredText(restoreRunId, 'Restore run ID', 200);
    const record = await this.controlDatabase.repository('restoreRun').get(tenant, id);
    if (!record || record.target?.engine !== 'redis') throw new RedisRestoreError('REDIS_RESTORE_RUN_NOT_FOUND', 'The Redis RestoreRun was not found.', { category: 'not-found' });
    if (TERMINAL_STATES.has(record.state)) return record;
    const active = this.active.get(id);
    if (!active) throw new RedisRestoreError('REDIS_RESTORE_NOT_ACTIVE', 'The Redis recovery is not active in this DeployerX process.', { category: 'conflict' });
    active.controller.abort();
    await active.operation;
    return this.controlDatabase.repository('restoreRun').get(tenant, id);
  }

  async list(workspaceId, options = {}) {
    return (await this.controlDatabase.repository('restoreRun').list(requiredText(workspaceId, 'Workspace ID', 200), { limit: Math.min(200, Math.max(1, Number(options.limit) || 50)) })).filter((record) => record.target?.engine === 'redis');
  }

  async reconcile(workspaceId, actorId = 'system') {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const records = await this.list(tenant, { limit: 200 });
    const recovered = [];
    for (const record of records.filter((item) => !TERMINAL_STATES.has(item.state) && !this.active.has(item.id))) {
      const targetDirectory = record.target?.targetDirectory;
      if (targetDirectory) {
        await this.fileSystem.rm(redisRestorePath(targetDirectory, record.id, 'stage'), { recursive: true, force: true }).catch(() => {});
        await this.fileSystem.rm(redisRestorePath(targetDirectory, record.id, 'validate'), { recursive: true, force: true }).catch(() => {});
        await this.fileSystem.rm(redisRestorePath(targetDirectory, record.id, 'cluster-stage'), { recursive: true, force: true }).catch(() => {});
      }
      const published = targetDirectory ? Boolean(await this.fileSystem.lstat(targetDirectory).catch(() => null)) : false;
      recovered.push(await this.#project(tenant, record.id, {
        state: 'failed', progress: { ...(record.progress || {}), phase: 'operator-action-required', updatedAt: this.clock() },
        result: { error: { code: 'REDIS_RESTORE_PROCESS_INTERRUPTED', category: 'restore', retryable: false, safeMessage: published ? 'Redis recovery was interrupted after the alternate target may have been published. Validate it before use.' : 'Redis recovery was interrupted before alternate-target publication.' }, completedAt: this.clock() }
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

  async #verifiedArtifacts(workspaceId, point) {
    const artifacts = await this.controlDatabase.repository('artifact').list(workspaceId, { limit: 10000 });
    for (const copy of (point.repositoryCopies || []).filter((item) => item.state === 'available')) {
      const candidates = artifacts.filter((item) => item.recoveryPointId === point.id && item.repositoryId === copy.repositoryId && ['database-dump', 'physical-backup'].includes(item.kind) && item.metadata?.adapterId === ADAPTER_ID);
      if (!candidates.length) continue;
      const opened = await this.openRepository(workspaceId, copy.repositoryId);
      const snapshot = await opened.engine.openSnapshot({}, { repositoryId: copy.repositoryId, snapshotId: copy.engineSnapshotId, masterKey: opened.masterKey });
      const metadata = candidates[0].metadata;
      if (!metadata || !['redis-rdb', 'redis-sealed-backup', 'redis-multipart-aof', 'redis-cluster-backup'].includes(metadata.kind)) throw new RedisRestoreError('REDIS_RESTORE_METADATA_INVALID', 'The authenticated Redis recovery metadata is incomplete.', { category: 'integrity' });
      const expected = metadata.kind === 'redis-rdb' ? [metadata.artifact] : metadata.artifacts;
      if (!Array.isArray(expected) || !expected.length) throw new RedisRestoreError('REDIS_RESTORE_METADATA_INVALID', 'The authenticated Redis artifact membership is incomplete.', { category: 'integrity' });
      const expectedPaths = expected.map((artifact) => artifact?.path);
      if (expectedPaths.some((artifactPath) => typeof artifactPath !== 'string' || !artifactPath) || new Set(expectedPaths).size !== expectedPaths.length) throw new RedisRestoreError('REDIS_RESTORE_METADATA_INVALID', 'The authenticated Redis artifact membership contains duplicate or invalid paths.', { category: 'integrity' });
      const candidatePaths = candidates.map((candidate) => {
        try { return decodeURIComponent(String(candidate.locator || '').split('#').slice(1).join('#')); }
        catch { return null; }
      });
      if (candidatePaths.length !== expectedPaths.length || new Set(candidatePaths).size !== candidatePaths.length || candidatePaths.some((artifactPath) => !expectedPaths.includes(artifactPath))) throw new RedisRestoreError('REDIS_RESTORE_MANIFEST_INVALID', 'The repository Artifact records do not exactly match the Redis recovery artifact set.', { category: 'integrity' });
      const files = [];
      for (const expectedArtifact of expected) {
        const file = (snapshot.manifest.files || []).find((candidate) => candidate.type === 'file' && candidate.path === expectedArtifact.path && candidate.metadata?.database?.adapterId === ADAPTER_ID);
        const controlArtifact = candidates[candidatePaths.indexOf(expectedArtifact.path)];
        if (!file || !controlArtifact || file.metadata?.artifactKind !== expectedArtifact.kind || controlArtifact.kind !== expectedArtifact.kind || file.sizeBytes !== controlArtifact.sizeBytes || file.contentDigest?.algorithm !== 'hmac-sha256' || controlArtifact.checksum?.algorithm !== 'hmac-sha256' || file.contentDigest.digest !== controlArtifact.checksum.digest || expectedArtifact.sizeBytes !== file.sizeBytes || !/^sha256:[0-9a-f]{64}$/.test(String(expectedArtifact.contentDigest || '')) || !isDeepStrictEqual(file.metadata.database, metadata) || !isDeepStrictEqual(controlArtifact.metadata, metadata)) throw new RedisRestoreError('REDIS_RESTORE_MANIFEST_INVALID', 'The repository manifest, Artifact record, and Redis recovery metadata do not agree.', { category: 'integrity' });
        files.push(file);
      }
      return { copy, opened, snapshot, metadata, files };
    }
    throw new RedisRestoreError('REDIS_RESTORE_ARTIFACT_UNAVAILABLE', 'No available repository copy contains the complete Redis recovery artifact set.', { category: 'not-found' });
  }

  #normalizeCluster(metadata) {
    const cluster = metadata?.cluster;
    if (!cluster || !/^sha256:[0-9a-f]{64}$/.test(String(cluster.topologyFingerprint || '')) || cluster.coveredSlots !== 16384 || !Array.isArray(cluster.masters) || !cluster.masters.length || cluster.masters.length > 1000) throw new RedisRestoreError('REDIS_CLUSTER_RESTORE_METADATA_INVALID', 'Redis Cluster recovery topology metadata is incomplete.', { category: 'integrity' });
    const ownership = new Array(16384).fill(null);
    const nodeIds = new Set();
    const artifactPaths = new Set();
    const masters = cluster.masters.map((master) => {
      const nodeId = String(master?.nodeId ?? '').trim();
      if (!nodeId || nodeId.includes('\0') || nodeId.length > 200 || nodeIds.has(nodeId)) throw new RedisRestoreError('REDIS_CLUSTER_RESTORE_METADATA_INVALID', 'Redis Cluster recovery contains an invalid or duplicate master node ID.', { category: 'integrity' });
      nodeIds.add(nodeId);
      if (!['redis-rdb', 'redis-sealed-backup', 'redis-multipart-aof'].includes(master?.kind) || !Array.isArray(master.artifacts) || !master.artifacts.length || !Array.isArray(master.slots) || !master.slots.length) throw new RedisRestoreError('REDIS_CLUSTER_RESTORE_METADATA_INVALID', `Redis Cluster master ${nodeId} recovery metadata is incomplete.`, { category: 'integrity' });
      for (const artifact of master.artifacts) {
        const artifactPath = typeof artifact?.path === 'string' ? artifact.path : '';
        if (!artifactPath || artifactPaths.has(artifactPath)) throw new RedisRestoreError('REDIS_CLUSTER_RESTORE_METADATA_INVALID', 'Redis Cluster recovery assigns an artifact path more than once.', { category: 'integrity' });
        artifactPaths.add(artifactPath);
      }
      for (const range of master.slots) {
        const match = /^(\d+)(?:-(\d+))?$/.exec(String(range));
        if (!match) throw new RedisRestoreError('REDIS_CLUSTER_RESTORE_METADATA_INVALID', 'Redis Cluster recovery contains an invalid slot range.', { category: 'integrity' });
        const first = Number(match[1]);
        const last = Number(match[2] ?? match[1]);
        if (first < 0 || last > 16383 || first > last) throw new RedisRestoreError('REDIS_CLUSTER_RESTORE_METADATA_INVALID', 'Redis Cluster recovery contains an invalid slot range.', { category: 'integrity' });
        for (let slot = first; slot <= last; slot += 1) {
          if (ownership[slot]) throw new RedisRestoreError('REDIS_CLUSTER_RESTORE_METADATA_INVALID', 'Redis Cluster recovery contains duplicate slot ownership.', { category: 'integrity' });
          ownership[slot] = nodeId;
        }
      }
      return { ...master, nodeId };
    });
    if (ownership.some((nodeId) => !nodeId)) throw new RedisRestoreError('REDIS_CLUSTER_RESTORE_METADATA_INVALID', 'Redis Cluster recovery does not cover all 16,384 slots exactly once.', { category: 'integrity' });
    const flattened = masters.flatMap((master) => master.artifacts.map((artifact) => artifact.path)).sort();
    const declared = Array.isArray(metadata.artifacts) ? metadata.artifacts.map((artifact) => artifact?.path).sort() : [];
    if (new Set(declared).size !== declared.length || JSON.stringify(flattened) !== JSON.stringify(declared)) throw new RedisRestoreError('REDIS_CLUSTER_RESTORE_METADATA_INVALID', 'Redis Cluster recovery artifact membership does not match its master topology.', { category: 'integrity' });
    return { topologyFingerprint: cluster.topologyFingerprint, masters };
  }

  async #validateTargetParent(targetDirectory) {
    const parentDirectory = path.dirname(targetDirectory);
    const parent = await this.fileSystem.lstat(parentDirectory).catch(() => null);
    if (!parent?.isDirectory() || parent.isSymbolicLink()) throw new RedisRestoreError('REDIS_RESTORE_PARENT_INVALID', 'Choose an existing regular parent directory for Redis recovery.', { category: 'validation' });
    const realParent = await this.fileSystem.realpath(parentDirectory);
    const comparable = (value) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
    if (comparable(realParent) !== comparable(parentDirectory)) throw new RedisRestoreError('REDIS_RESTORE_PARENT_SYMLINK_REFUSED', 'Redis recovery paths must not traverse a symbolic link.', { category: 'integrity' });
  }

  async #executeCluster(workspaceId, actorId, restoreRunId, request, selected, source, progress) {
    if (request.confirmationText !== RESTORE_CONFIRMATIONS.clusterAlternate) throw new RedisRestoreError('REDIS_RESTORE_CONFIRMATION_REQUIRED', 'Confirm the isolated alternate Redis Cluster recovery before continuing.', { category: 'conflict' });
    const cluster = this.#normalizeCluster(selected.metadata);
    await this.#validateTargetParent(request.targetDirectory);
    const clusterStage = redisRestorePath(request.targetDirectory, restoreRunId, 'cluster-stage');
    if (await this.fileSystem.lstat(clusterStage).catch(() => null)) throw new RedisRestoreError('REDIS_RESTORE_STAGE_EXISTS', 'Redis Cluster recovery staging already exists for this run.', { category: 'conflict' });
    await this.fileSystem.mkdir(clusterStage, { recursive: false, mode: 0o700 });
    const mastersDirectory = path.join(clusterStage, 'masters');
    await this.fileSystem.mkdir(mastersDirectory, { recursive: false, mode: 0o700 });
    const validations = [];
    let targetClaimed = false;
    try {
      for (const master of cluster.masters) {
        if (request.signal?.aborted) throw new RedisRestoreError('REDIS_RESTORE_CANCELED', 'The Redis Cluster recovery was canceled before publication.', { category: 'canceled' });
        const childMetadata = {
          kind: master.kind,
          ...(master.kind === 'redis-rdb' ? { artifact: master.artifacts[0] } : { artifacts: master.artifacts }),
          consistency: { evidence: { serverVersion: master.serverVersion, metadata: { databases: master.databases || [] } } }
        };
        const childTarget = path.join(mastersDirectory, encodeURIComponent(master.nodeId));
        const plan = await this.adapter.planRestore({}, { mode: 'alternate', confirmation: 'RESTORE_REDIS_ALTERNATE', targetDirectory: childTarget, executionId: `${restoreRunId}:${master.nodeId}`, port: request.port, redisServerExecutable: request.redisServerExecutable, redisCliExecutable: request.redisCliExecutable, timeoutMs: request.timeoutMs, metadata: childMetadata });
        const restored = await this.adapter.executeRestore({ signal: request.signal }, plan, source);
        const validation = await this.adapter.validateRestore({}, restored);
        if (!validation.valid) throw new RedisRestoreError('REDIS_CLUSTER_MASTER_VALIDATION_FAILED', `Redis Cluster master ${master.nodeId} failed isolated native validation.`, { category: 'integrity' });
        validations.push({ nodeId: master.nodeId, targetDirectory: childTarget, status: validation.status, warnings: validation.warnings || [], checks: validation.checks || [] });
      }
      if (request.signal?.aborted) throw new RedisRestoreError('REDIS_RESTORE_CANCELED', 'The Redis Cluster recovery was canceled before publication.', { category: 'canceled' });
      const topology = { version: 1, kind: 'redis-cluster-offline-topology', topologyFingerprint: cluster.topologyFingerprint, coveredSlots: 16384, serviceRunning: false, masters: cluster.masters.map((master) => ({ nodeId: master.nodeId, slots: master.slots, directory: `masters/${encodeURIComponent(master.nodeId)}` })) };
      await this.fileSystem.writeFile(path.join(clusterStage, 'topology.json'), JSON.stringify(topology, null, 2), { flag: 'wx', mode: 0o600 });
      try { await this.fileSystem.mkdir(request.targetDirectory, { recursive: false, mode: 0o700 }); targetClaimed = true; }
      catch (error) { if (error?.code === 'EEXIST') throw new RedisRestoreError('REDIS_RESTORE_TARGET_EXISTS', 'The alternate Redis Cluster target appeared before publication.', { category: 'conflict' }); throw error; }
      await this.fileSystem.rename(mastersDirectory, path.join(request.targetDirectory, 'masters'));
      await this.fileSystem.rename(path.join(clusterStage, 'topology.json'), path.join(request.targetDirectory, 'topology.json'));
      await this.fileSystem.rm(clusterStage, { recursive: true, force: true });
      return { targetDirectory: request.targetDirectory, validations, warnings: validations.flatMap((item) => item.warnings), topology };
    } catch (error) {
      await this.fileSystem.rm(clusterStage, { recursive: true, force: true }).catch(() => {});
      if (targetClaimed) throw new RedisRestoreError('REDIS_RESTORE_PUBLICATION_UNCERTAIN', 'The alternate Redis Cluster target was claimed and may contain validated master artifacts. Inspect it before any retry.', { category: 'conflict' });
      throw error;
    }
  }

  async #execute(workspaceId, actorId, restoreRunId, request, signal) {
    let progress = { phase: 'preparing', itemsTotal: 0, itemsCompleted: 0, bytesTotal: 0, bytesWritten: 0, throughputBytesPerSecond: 0, startedAt: this.clock(), updatedAt: this.clock(), warnings: [] };
    let validationRecord = null;
    try {
      await this.#project(workspaceId, restoreRunId, { state: 'preparing', progress }, actorId);
      const point = await this.controlDatabase.repository('recoveryPoint').get(workspaceId, request.recoveryPointId);
      const selected = await this.#verifiedArtifacts(workspaceId, point);
      if (selected.metadata.kind === 'redis-cluster-backup' && point.consistency !== 'crash') throw new RedisRestoreError('REDIS_RECOVERY_POINT_INVALID', 'Redis Cluster recovery requires its authenticated crash-consistency label.', { category: 'integrity' });
      if (selected.metadata.kind !== 'redis-cluster-backup' && point.consistency !== 'application') throw new RedisRestoreError('REDIS_RECOVERY_POINT_INVALID', 'Standalone Redis recovery requires its authenticated application-consistency label.', { category: 'integrity' });
      if (selected.metadata.kind !== 'redis-cluster-backup' && request.confirmationText !== RESTORE_CONFIRMATIONS.alternate) throw new RedisRestoreError('REDIS_RESTORE_CONFIRMATION_REQUIRED', 'Use the standalone Redis alternate-recovery confirmation for this recovery point.', { category: 'conflict' });
      const filesByPath = new Map(selected.files.map((file) => [file.path, file]));
      const openedPaths = new Set();
      const source = {
        open: async (artifactPath) => {
          const file = filesByPath.get(artifactPath);
          if (!file) throw new RedisRestoreError('REDIS_RESTORE_ARTIFACT_UNAVAILABLE', 'A Redis recovery artifact is unavailable.', { category: 'integrity' });
          if (openedPaths.has(artifactPath)) throw new RedisRestoreError('REDIS_RESTORE_ARTIFACT_REOPENED', 'A Redis recovery artifact was requested more than once.', { category: 'integrity' });
          openedPaths.add(artifactPath);
          const stream = selected.opened.engine.streamFile({}, { repositoryId: selected.copy.repositoryId, manifest: selected.snapshot.manifest, masterKey: selected.opened.masterKey, path: file.path });
          return (async function* tracked() {
            for await (const chunk of stream) {
              if (signal.aborted) throw new RedisRestoreError('REDIS_RESTORE_CANCELED', 'The Redis recovery was canceled before publication.', { category: 'canceled' });
              progress.bytesWritten += Buffer.byteLength(chunk);
              yield Buffer.from(chunk);
            }
            progress.itemsCompleted += 1;
          })();
        }
      };
      if (selected.metadata.kind === 'redis-cluster-backup') {
        progress = { ...progress, phase: 'running', itemsTotal: selected.files.length, bytesTotal: selected.files.reduce((total, file) => total + file.sizeBytes, 0), updatedAt: this.clock() };
        await this.#project(workspaceId, restoreRunId, { state: 'running', progress }, actorId);
        const restored = await this.#executeCluster(workspaceId, actorId, restoreRunId, { ...request, signal }, selected, source, progress);
        const warning = restored.warnings.length > 0;
        validationRecord = { state: warning ? 'warning' : 'succeeded', connectivity: 'pass', contentDigest: 'pass', expectedObjects: warning ? 'warning' : 'pass', nativeIntegrityValidation: true, checks: [{ id: 'cluster-artifacts', status: 'pass', safeMessage: 'Every Redis Cluster master recovery set passed authenticated native loading.' }, { id: 'cluster-slots', status: 'pass', safeMessage: 'The offline recovery topology covers all 16,384 slots exactly once.' }], completedAt: this.clock() };
        progress = { ...progress, phase: 'complete', warnings: restored.warnings, updatedAt: this.clock() };
        return this.#project(workspaceId, restoreRunId, { state: warning ? 'warning' : 'succeeded', progress, validation: validationRecord, result: { restoredItems: selected.files.length, bytesRestored: progress.bytesWritten, targetName: path.basename(request.targetDirectory), recoveryTarget: { type: 'isolated-cluster-directory', path: request.targetDirectory, serviceRunning: false, masterCount: restored.validations.length, coveredSlots: 16384 }, warnings: restored.warnings, completedAt: this.clock() } }, actorId);
      }
      const plan = await this.adapter.planRestore({}, {
        mode: 'alternate', confirmation: 'RESTORE_REDIS_ALTERNATE', targetDirectory: request.targetDirectory, executionId: restoreRunId, port: request.port,
        redisServerExecutable: request.redisServerExecutable, redisCliExecutable: request.redisCliExecutable, timeoutMs: request.timeoutMs, metadata: selected.metadata
      });
      progress = { ...progress, phase: 'running', itemsTotal: selected.files.length, bytesTotal: selected.files.reduce((total, file) => total + file.sizeBytes, 0), updatedAt: this.clock() };
      await this.#project(workspaceId, restoreRunId, { state: 'running', progress }, actorId);
      const restored = await this.adapter.executeRestore({ signal }, plan, source);
      progress = { ...progress, phase: 'validating', updatedAt: this.clock() };
      await this.#project(workspaceId, restoreRunId, { state: 'validating', progress }, actorId);
      const validation = await this.adapter.validateRestore({}, restored);
      validationRecord = { state: validation.status, connectivity: 'pass', contentDigest: 'pass', expectedObjects: validation.checks?.find((check) => check.id === 'keyspace')?.status || 'unavailable', nativeIntegrityValidation: Boolean(validation.nativeIntegrityValidation), checks: validation.checks || [], completedAt: this.clock() };
      if (!validation.valid) throw new RedisRestoreError('REDIS_RESTORE_VALIDATION_FAILED', 'The recovered Redis artifacts did not pass native isolated validation.', { category: 'integrity' });
      progress = { ...progress, phase: 'complete', warnings: validation.warnings || [], updatedAt: this.clock() };
      return this.#project(workspaceId, restoreRunId, {
        state: validation.status === 'warning' ? 'warning' : 'succeeded', progress, validation: validationRecord,
        result: { restoredItems: selected.files.length, bytesRestored: progress.bytesWritten, targetName: path.basename(request.targetDirectory), recoveryTarget: { type: 'isolated-directory', path: request.targetDirectory, serviceRunning: false }, warnings: validation.warnings || [], completedAt: this.clock() }
      }, actorId);
    } catch (error) {
      const current = await this.controlDatabase.repository('restoreRun').get(workspaceId, restoreRunId);
      if (current && !TERMINAL_STATES.has(current.state)) {
        const canceled = signal.aborted || error?.code === 'REDIS_RESTORE_CANCELED';
        return this.#project(workspaceId, restoreRunId, { state: canceled ? 'canceled' : 'failed', progress: { ...progress, phase: canceled ? 'canceled' : 'failed', updatedAt: this.clock() }, validation: validationRecord, result: { error: canceled ? { code: 'REDIS_RESTORE_CANCELED', category: 'canceled', retryable: false, safeMessage: 'The Redis recovery was canceled before alternate-target publication.' } : publicError(error), completedAt: this.clock() } }, actorId);
      }
      throw error;
    }
  }
}

module.exports = { RESTORE_CONFIRMATIONS, RedisRestoreError, RedisRestoreService, normalizeRequest };
