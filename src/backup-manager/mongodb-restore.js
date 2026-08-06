const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { ADAPTER_ID, compareOplogTimestamps, normalizeOplogCoordinate, sameOplogHistory } = require('./mongodb');

const RESTORE_CONFIRMATIONS = Object.freeze({ original: 'RESTORE MONGODB', alternate: 'RESTORE MONGODB ALTERNATE' });
const TERMINAL_STATES = new Set(['succeeded', 'warning', 'failed', 'canceled']);
const MAX_CHAIN_POINTS = 1000;
const MAX_REPLAY_BYTES = 1024 * 1024 * 1024 * 1024;

class MongoDbRestoreError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'MongoDbRestoreError';
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
  if (error instanceof MongoDbRestoreError || (error?.code && error?.category)) return { code: String(error.code).slice(0, 100), category: String(error.category || 'restore').slice(0, 50), retryable: Boolean(error.retryable), safeMessage: String(error.message || 'The MongoDB restore failed.').slice(0, 500) };
  return { code: 'MONGODB_RESTORE_FAILED', category: 'restore', retryable: false, safeMessage: 'DeployerX could not complete the MongoDB restore.' };
}

function normalizeRequest(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('MongoDB restore request must be an object.');
  const mode = String(input.mode || 'original');
  if (!RESTORE_CONFIRMATIONS[mode]) throw new MongoDbRestoreError('MONGODB_RESTORE_MODE_INVALID', 'Choose the original deployment or an alternate deployment for MongoDB recovery.', { category: 'validation' });
  if (input.confirmed !== true || String(input.confirmationText || '').trim() !== RESTORE_CONFIRMATIONS[mode]) throw new MongoDbRestoreError('MONGODB_RESTORE_CONFIRMATION_REQUIRED', 'Confirm the selected MongoDB recovery target before continuing.', { category: 'conflict' });
  const stop = input.stop && typeof input.stop === 'object' && !Array.isArray(input.stop) ? structuredClone(input.stop) : { type: 'latest' };
  if (!['latest', 'coordinate'].includes(String(stop.type || 'latest'))) throw new MongoDbRestoreError('MONGODB_PITR_TARGET_INVALID', 'MongoDB recovery currently requires the latest boundary or an exact authenticated oplog coordinate.', { category: 'validation' });
  return {
    recoveryPointId: requiredText(input.recoveryPointId || input.terminalRecoveryPointId, 'Recovery point ID', 200), mode,
    targetConnectionId: mode === 'original' ? null : requiredText(input.targetConnectionId, 'Target connection ID', 200),
    conflictPolicy: mode === 'alternate' && input.conflictPolicy === 'overwrite' ? 'overwrite' : 'fail', stop
  };
}

function coordinateIdentity(coordinate) {
  const normalized = normalizeOplogCoordinate(coordinate);
  return `${normalized.serverIdentityFingerprint || ''}\0${normalized.replicaSetId || ''}`;
}

function exclusiveLimit(coordinate) {
  const normalized = normalizeOplogCoordinate(coordinate);
  const timestamp = normalized.timestamp.$timestamp;
  const next = timestamp.i < 0xffffffff ? { t: timestamp.t, i: timestamp.i + 1 } : { t: timestamp.t + 1, i: 0 };
  return { ...normalized, timestamp: { $timestamp: next } };
}

class MongoDbRestoreService {
  constructor({ controlDatabase, secretStore, deviceId, adapter, openRepository, temporaryRoot = os.tmpdir(), fileSystem = fs, clock = () => new Date().toISOString() } = {}) {
    if (!controlDatabase || !secretStore || !adapter || typeof openRepository !== 'function') throw new TypeError('MongoDB restore dependencies are required.');
    this.controlDatabase = controlDatabase;
    this.secretStore = secretStore;
    this.deviceId = requiredText(deviceId, 'Device ID', 200);
    this.adapter = adapter;
    this.openRepository = openRepository;
    this.temporaryRoot = temporaryRoot;
    this.fileSystem = fileSystem;
    this.clock = clock;
    this.active = new Map();
  }

  async #chain(workspaceId, terminalId) {
    const points = await this.controlDatabase.repository('recoveryPoint').list(workspaceId, { limit: MAX_CHAIN_POINTS });
    if (points.length === MAX_CHAIN_POINTS) throw new MongoDbRestoreError('MONGODB_RESTORE_CHAIN_LIMIT', 'The MongoDB recovery chain exceeds the supported bound.', { category: 'capacity' });
    const byId = new Map(points.map((point) => [point.id, point]));
    let current = byId.get(terminalId);
    if (!current || !['full', 'log'].includes(current.type)) throw new MongoDbRestoreError('MONGODB_RECOVERY_POINT_INVALID', 'Choose a MongoDB logical full or oplog recovery point.', { category: 'validation' });
    const reverse = [];
    const seen = new Set();
    while (current) {
      if (seen.has(current.id)) throw new MongoDbRestoreError('MONGODB_RESTORE_CHAIN_CYCLE', 'The MongoDB recovery chain contains a cycle.', { category: 'integrity' });
      seen.add(current.id);
      reverse.push(current);
      if (current.type === 'full') break;
      current = byId.get(current.parentRecoveryPointId);
      if (!current) throw new MongoDbRestoreError('MONGODB_RESTORE_CHAIN_GAP', 'A required MongoDB recovery point is missing.', { category: 'integrity' });
    }
    const chain = reverse.reverse();
    const anchor = chain[0];
    if (anchor?.type !== 'full' || chain.slice(1).some((point) => point.type !== 'log')) throw new MongoDbRestoreError('MONGODB_RESTORE_ANCHOR_INVALID', 'The MongoDB recovery chain does not begin with one logical full anchor.', { category: 'integrity' });
    if (chain.some((point) => point.sourceId !== anchor.sourceId || point.jobId !== anchor.jobId || point.chainRootId !== anchor.id)) throw new MongoDbRestoreError('MONGODB_RESTORE_CHAIN_IDENTITY_INVALID', 'The MongoDB recovery chain crosses a source, job, or root boundary.', { category: 'integrity' });
    return chain;
  }

  async start(workspaceId, actorId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const request = normalizeRequest(input);
    const chain = await this.#chain(tenant, request.recoveryPointId);
    const source = await this.controlDatabase.repository('source').get(tenant, chain[0].sourceId);
    if (!source || source.adapterId !== ADAPTER_ID) throw new MongoDbRestoreError('MONGODB_RESTORE_SOURCE_INVALID', 'The selected recovery chain is not a MongoDB logical backup.', { category: 'validation' });
    const targetConnectionId = request.mode === 'original' ? source.connectionId : request.targetConnectionId;
    const connection = await this.controlDatabase.repository('connection').get(tenant, targetConnectionId);
    if (!connection || connection.adapterId !== ADAPTER_ID) throw new MongoDbRestoreError('MONGODB_RESTORE_TARGET_INVALID', 'Choose a saved MongoDB connection for the recovery target.', { category: 'validation' });
    if (!(connection.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new MongoDbRestoreError('MONGODB_RESTORE_OTHER_DEVICE', 'The MongoDB recovery target belongs to another device.', { category: 'authorization' });
    if (connection.lastTest?.status !== 'success' || !connection.trust?.fingerprint) throw new MongoDbRestoreError('MONGODB_RESTORE_TARGET_UNHEALTHY', 'Retest the selected MongoDB connection before recovery.', { category: 'connectivity', retryable: true });
    const now = this.clock();
    const record = await this.controlDatabase.repository('restoreRun').create({
      workspaceId: tenant, actorId: actor, recoveryPointIds: chain.map((point) => point.id), targetConnectionId,
      target: { operation: chain.length > 1 ? 'point-in-time' : 'logical', mode: request.mode, engine: 'mongodb', sourceId: source.id, connectionId: targetConnectionId, serverIdentityFingerprint: connection.trust.fingerprint },
      mode: request.mode, conflictPolicy: request.mode === 'original' ? 'overwrite' : request.conflictPolicy, workerId: `device:${this.deviceId}`, state: 'queued',
      progress: { phase: 'queued', itemsTotal: chain.length, itemsCompleted: 0, bytesTotal: 0, bytesWritten: 0, throughputBytesPerSecond: 0, startedAt: null, updatedAt: now, warnings: [] }, validation: null, result: null
    });
    const controller = new AbortController();
    const operation = this.#execute(tenant, actor, record.id, request, chain, controller.signal).catch(() => this.controlDatabase.repository('restoreRun').get(tenant, record.id));
    this.active.set(record.id, { operation, controller });
    operation.finally(() => this.active.delete(record.id));
    return record;
  }

  async wait(workspaceId, restoreRunId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const id = requiredText(restoreRunId, 'Restore run ID', 200);
    if (this.active.has(id)) await this.active.get(id).operation;
    const record = await this.controlDatabase.repository('restoreRun').get(tenant, id);
    if (!record) throw new MongoDbRestoreError('MONGODB_RESTORE_RUN_NOT_FOUND', 'The MongoDB RestoreRun was not found.', { category: 'not-found' });
    return record;
  }

  async cancel(workspaceId, actorId, restoreRunId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    requiredText(actorId, 'Actor ID', 200);
    const id = requiredText(restoreRunId, 'Restore run ID', 200);
    const record = await this.controlDatabase.repository('restoreRun').get(tenant, id);
    if (!record || record.target?.engine !== 'mongodb' || record.target?.operation === 'physical-empty-target') throw new MongoDbRestoreError('MONGODB_RESTORE_RUN_NOT_FOUND', 'The MongoDB RestoreRun was not found.', { category: 'not-found' });
    if (TERMINAL_STATES.has(record.state)) return record;
    const active = this.active.get(id);
    if (!active) throw new MongoDbRestoreError('MONGODB_RESTORE_NOT_ACTIVE', 'The MongoDB restore is not active in this DeployerX process.', { category: 'conflict' });
    active.controller.abort();
    await active.operation;
    return this.controlDatabase.repository('restoreRun').get(tenant, id);
  }

  async list(workspaceId, options = {}) {
    return (await this.controlDatabase.repository('restoreRun').list(requiredText(workspaceId, 'Workspace ID', 200), { limit: Math.min(200, Math.max(1, Number(options.limit) || 50)) })).filter((record) => record.target?.engine === 'mongodb' && record.target?.operation !== 'physical-empty-target');
  }

  async reconcile(workspaceId, actorId = 'system') {
    const records = await this.list(workspaceId, { limit: 200 });
    const recovered = [];
    for (const record of records.filter((item) => !TERMINAL_STATES.has(item.state) && !this.active.has(item.id))) recovered.push(await this.#project(workspaceId, record.id, { state: 'failed', progress: { ...(record.progress || {}), phase: 'operator-action-required', updatedAt: this.clock() }, result: { error: { code: 'MONGODB_RESTORE_PROCESS_INTERRUPTED', category: 'restore', retryable: false, safeMessage: 'MongoDB recovery was interrupted. Inspect the possibly modified target before starting another restore.' }, completedAt: this.clock() } }, actorId));
    return recovered;
  }

  async #project(workspaceId, id, changes, actorId) {
    return this.controlDatabase.transaction((transaction) => {
      const current = transaction.get('restoreRun', workspaceId, id);
      return transaction.projectExecution('restoreRun', workspaceId, id, changes, { expectedRevision: current.revision, actorId });
    });
  }

  async #selectArtifacts(workspaceId, chain) {
    const artifacts = await this.controlDatabase.repository('artifact').list(workspaceId, { limit: 1000 });
    const selected = [];
    let previous = null;
    for (const point of chain) {
      const kind = point.type === 'full' ? 'database-dump' : 'transaction-log';
      let entry = null;
      for (const copy of (point.repositoryCopies || []).filter((item) => item.state === 'available')) {
        const artifact = artifacts.find((item) => item.recoveryPointId === point.id && item.repositoryId === copy.repositoryId && item.kind === kind && item.metadata?.adapterId === ADAPTER_ID);
        if (artifact) { entry = { point, copy, artifact }; break; }
      }
      if (!entry) throw new MongoDbRestoreError('MONGODB_RESTORE_ARTIFACT_UNAVAILABLE', 'A required MongoDB recovery-chain Artifact is unavailable.', { category: 'not-found' });
      const binaryLog = entry.artifact.metadata?.binaryLog;
      const coordinate = point.type === 'full' ? binaryLog?.anchorCoordinate : binaryLog?.endCoordinate;
      if (!coordinate) throw new MongoDbRestoreError('MONGODB_RESTORE_COORDINATE_MISSING', 'A MongoDB recovery-chain Artifact has no authenticated oplog coordinate.', { category: 'integrity' });
      if (previous) {
        const start = binaryLog?.startCoordinate;
        if (!start || coordinateIdentity(start) !== coordinateIdentity(previous) || !sameOplogHistory(previous, start)) throw new MongoDbRestoreError('MONGODB_RESTORE_COORDINATE_GAP', 'Adjacent MongoDB recovery points do not form one continuous oplog history.', { category: 'integrity' });
      }
      previous = normalizeOplogCoordinate(coordinate);
      selected.push({ ...entry, coordinate: previous });
    }
    return selected;
  }

  #boundedSelections(selections, stop) {
    if (!stop || String(stop.type || 'latest') === 'latest') return { selections, target: selections.at(-1).coordinate, limited: false };
    const target = normalizeOplogCoordinate(stop.coordinate);
    const anchor = selections[0].coordinate;
    const terminal = selections.at(-1).coordinate;
    if (coordinateIdentity(target) !== coordinateIdentity(anchor) || compareOplogTimestamps(target.timestamp, anchor.timestamp) < 0 || compareOplogTimestamps(target.timestamp, terminal.timestamp) > 0) throw new MongoDbRestoreError('MONGODB_PITR_TARGET_OUT_OF_RANGE', 'The requested MongoDB oplog coordinate is outside the authenticated recovery range.', { category: 'validation' });
    const terminalIndex = selections.findIndex((entry) => compareOplogTimestamps(target.timestamp, entry.coordinate.timestamp) <= 0);
    return { selections: selections.slice(0, terminalIndex + 1), target, limited: compareOplogTimestamps(target.timestamp, selections[terminalIndex].coordinate.timestamp) < 0 };
  }

  async #openVerified(workspaceId, selection, kind) {
    const opened = await this.openRepository(workspaceId, selection.copy.repositoryId);
    const snapshot = await opened.engine.openSnapshot({}, { repositoryId: selection.copy.repositoryId, snapshotId: selection.copy.engineSnapshotId, masterKey: opened.masterKey });
    const locatorPath = decodeURIComponent(String(selection.artifact.locator || '').split('#').slice(1).join('#'));
    const file = (snapshot.manifest.files || []).find((candidate) => candidate.type === 'file' && candidate.path === locatorPath && candidate.metadata?.artifactKind === kind && candidate.metadata?.database?.adapterId === ADAPTER_ID);
    if (!file || file.sizeBytes !== selection.artifact.sizeBytes || file.contentDigest?.digest !== selection.artifact.checksum?.digest) throw new MongoDbRestoreError('MONGODB_RESTORE_MANIFEST_INVALID', 'An authenticated repository manifest does not match its MongoDB Artifact record.', { category: 'integrity' });
    return { opened, snapshot, file };
  }

  async #execute(workspaceId, actorId, restoreRunId, request, chain, signal) {
    let directory = null;
    let progress = { phase: 'preparing', itemsTotal: chain.length, itemsCompleted: 0, bytesTotal: 0, bytesWritten: 0, throughputBytesPerSecond: 0, startedAt: this.clock(), updatedAt: this.clock(), warnings: [] };
    let validationRecord = null;
    try {
      if (signal?.aborted) throw new MongoDbRestoreError('MONGODB_RESTORE_CANCELED', 'The MongoDB restore was canceled.', { category: 'canceled' });
      await this.#project(workspaceId, restoreRunId, { state: 'preparing', progress }, actorId);
      const [source, selections] = await Promise.all([this.controlDatabase.repository('source').get(workspaceId, chain[0].sourceId), this.#selectArtifacts(workspaceId, chain)]);
      const bounded = this.#boundedSelections(selections, request.stop);
      const targetConnectionId = request.mode === 'original' ? source.connectionId : request.targetConnectionId;
      const connection = await this.controlDatabase.repository('connection').get(workspaceId, targetConnectionId);
      if (!source || !connection || connection.adapterId !== ADAPTER_ID) throw new MongoDbRestoreError('MONGODB_RESTORE_SOURCE_UNAVAILABLE', 'The protected MongoDB source or selected recovery connection is unavailable.', { category: 'not-found' });
      const [passwordSecretRefId] = connection.secretRefIds || [];
      const connectionConfig = this.adapter.normalizeConfig({ ...connection.endpoint, passwordSecretRefId });
      const anchorMetadata = bounded.selections[0].artifact.metadata?.server || {};
      const prepared = await this.adapter.prepareRestoreTarget({ resolveSecret: (id) => this.secretStore.resolve({ workspaceId, id }), signal }, { mode: request.mode, connection: connectionConfig, metadata: anchorMetadata, serverIdentityFingerprint: bounded.selections[0].coordinate.serverIdentityFingerprint, conflictPolicy: request.conflictPolicy });
      const anchor = await this.#openVerified(workspaceId, bounded.selections[0], 'database-dump');
      progress = { ...progress, phase: 'running', itemsTotal: bounded.selections.length, bytesTotal: bounded.selections.reduce((total, entry) => total + Number(entry.artifact.sizeBytes || 0), 0), updatedAt: this.clock() };
      await this.#project(workspaceId, restoreRunId, { state: 'running', progress, target: { operation: bounded.selections.length > 1 ? 'point-in-time' : 'logical', mode: request.mode, engine: 'mongodb', sourceId: source.id, connectionId: connection.id, serverIdentityFingerprint: prepared.targetFingerprint, stop: { type: 'coordinate', coordinate: bounded.target } } }, actorId);
      const plan = await this.adapter.planRestore({}, { mode: request.mode, confirmation: request.mode === 'original' ? 'RESTORE_MONGODB_ORIGINAL' : 'RESTORE_MONGODB_ALTERNATE', connection: connectionConfig, artifactPath: anchor.file.path, prepared, targetFingerprint: prepared.targetFingerprint });
      const content = () => (async function* tracked() {
        const stream = anchor.opened.engine.streamFile({}, { repositoryId: bounded.selections[0].copy.repositoryId, manifest: anchor.snapshot.manifest, masterKey: anchor.opened.masterKey, path: anchor.file.path });
        for await (const chunk of stream) {
          if (signal?.aborted) throw new MongoDbRestoreError('MONGODB_RESTORE_CANCELED', 'The MongoDB restore was canceled.', { category: 'canceled' });
          progress.bytesWritten += Buffer.byteLength(chunk); yield Buffer.from(chunk);
        }
      })();
      await this.adapter.executeRestore({ resolveSecret: (id) => this.secretStore.resolve({ workspaceId, id }), signal }, plan, { async open() { return content(); } });
      progress.itemsCompleted = 1;
      if (bounded.selections.length > 1) {
        directory = await this.fileSystem.mkdtemp(path.join(this.temporaryRoot, 'deployerx-mongodb-restore-'));
        await this.fileSystem.chmod(directory, 0o700).catch(() => {});
        const files = [];
        let bytes = 0;
        for (let index = 1; index < bounded.selections.length; index += 1) {
          if (signal?.aborted) throw new MongoDbRestoreError('MONGODB_RESTORE_CANCELED', 'The MongoDB restore was canceled.', { category: 'canceled' });
          const selected = bounded.selections[index];
          const verified = await this.#openVerified(workspaceId, selected, 'transaction-log');
          bytes += verified.file.sizeBytes;
          if (bytes > MAX_REPLAY_BYTES) throw new MongoDbRestoreError('MONGODB_RESTORE_REPLAY_LIMIT', 'The MongoDB oplog replay exceeds the temporary-storage limit.', { category: 'capacity' });
          const filePath = path.join(directory, `${String(index).padStart(4, '0')}.bson`);
          const handle = await this.fileSystem.open(filePath, 'wx', 0o600);
          try {
            const stream = verified.opened.engine.streamFile({}, { repositoryId: selected.copy.repositoryId, manifest: verified.snapshot.manifest, masterKey: verified.opened.masterKey, path: verified.file.path });
            for await (const chunk of stream) {
              if (signal?.aborted) throw new MongoDbRestoreError('MONGODB_RESTORE_CANCELED', 'The MongoDB restore was canceled.', { category: 'canceled' });
              await handle.write(Buffer.from(chunk)); progress.bytesWritten += Buffer.byteLength(chunk);
            }
            await handle.sync();
          } finally { await handle.close(); }
          files.push({ filePath });
          progress.itemsCompleted += 1;
          progress.updatedAt = this.clock();
          await this.#project(workspaceId, restoreRunId, { progress: structuredClone(progress) }, actorId);
        }
        await this.adapter.executeOplogReplay({ resolveSecret: (id) => this.secretStore.resolve({ workspaceId, id }), signal }, { connection: connectionConfig, files, oplogLimit: bounded.limited ? exclusiveLimit(bounded.target) : null });
      }
      progress = { ...progress, phase: 'validating', updatedAt: this.clock() };
      await this.#project(workspaceId, restoreRunId, { state: 'validating', progress }, actorId);
      const validation = await this.adapter.validateRestore({ resolveSecret: (id) => this.secretStore.resolve({ workspaceId, id }), signal }, { connection: connectionConfig, expectedDatabases: prepared.expectedDatabases, validationInventory: prepared.validationInventory, requireUuid: prepared.preserveUuid, targetFingerprint: prepared.targetFingerprint });
      validationRecord = { state: validation.status, connectivity: validation.checks?.find((check) => check.id === 'connectivity')?.status || 'failed', expectedObjects: validation.checks?.find((check) => check.id === 'expected-objects')?.status || 'unavailable', nativeIntegrityValidation: Boolean(validation.nativeIntegrityValidation), checks: validation.checks || [], completedAt: this.clock() };
      if (!validation.valid) throw new MongoDbRestoreError('MONGODB_RESTORE_VALIDATION_FAILED', 'The recovered MongoDB deployment did not pass authenticated collection, index, UUID, and native integrity validation.', { category: 'integrity' });
      progress = { ...progress, phase: 'complete', updatedAt: this.clock() };
      const terminalState = validation.status === 'warning' ? 'warning' : 'succeeded';
      return this.#project(workspaceId, restoreRunId, { state: terminalState, progress, validation: { ...validationRecord, state: terminalState }, result: { fullAnchorRecoveryPointId: bounded.selections[0].point.id, terminalRecoveryPointId: bounded.selections.at(-1).point.id, replayedRecoveryPointIds: bounded.selections.slice(1).map((entry) => entry.point.id), bytesRestored: progress.bytesWritten, recoveryTarget: { type: 'coordinate', coordinate: bounded.target }, warnings: validation.warnings || [], completedAt: this.clock() } }, actorId);
    } catch (error) {
      const current = await this.controlDatabase.repository('restoreRun').get(workspaceId, restoreRunId);
      if (current && !TERMINAL_STATES.has(current.state)) {
        const canceled = signal?.aborted || error?.code === 'MONGODB_RESTORE_CANCELED' || error?.code === 'NATIVE_PROCESS_CANCELED';
        return this.#project(workspaceId, restoreRunId, { state: canceled ? 'canceled' : 'failed', progress: { ...progress, phase: canceled ? 'canceled' : 'failed', updatedAt: this.clock() }, validation: validationRecord, result: { error: canceled ? { code: 'MONGODB_RESTORE_CANCELED', category: 'canceled', retryable: false, safeMessage: 'The MongoDB restore was canceled. The target may have been partially modified and must be inspected.' } : publicError(error), completedAt: this.clock() } }, actorId);
      }
      throw error;
    } finally {
      if (directory) await this.fileSystem.rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  }
}

module.exports = { MAX_CHAIN_POINTS, MAX_REPLAY_BYTES, MongoDbRestoreError, MongoDbRestoreService, RESTORE_CONFIRMATIONS, exclusiveLimit, normalizeRequest };
