const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { remapMysqlFamilyMetadata } = require('./database-restore-target');
const { normalizePointInTimeTarget } = require('./mysql-family-binlog');
const { ADAPTER_ID: MYSQL_ADAPTER_ID } = require('./mysql-logical');
const { ADAPTER_ID: MARIADB_ADAPTER_ID } = require('./mariadb-logical');
const { RESTORE_CONFIRMATIONS: MYSQL_RESTORE_CONFIRMATIONS } = require('./mysql-restore');
const { RESTORE_CONFIRMATIONS: MARIADB_RESTORE_CONFIRMATIONS } = require('./mariadb-restore');

const TERMINAL_STATES = new Set(['succeeded', 'warning', 'failed', 'canceled']);
const MAX_CHAIN_POINTS = 1000;
const MAX_REPLAY_BYTES = 1024 * 1024 * 1024 * 1024;

const PROFILES = Object.freeze({
  mysql: Object.freeze({ engine: 'mysql', label: 'MySQL', adapterId: MYSQL_ADAPTER_ID, confirmation: 'RECOVER MYSQL TO POINT IN TIME', restoreConfirmations: MYSQL_RESTORE_CONFIRMATIONS, codePrefix: 'MYSQL', temporaryPrefix: 'deployerx-mysql-pitr' }),
  mariadb: Object.freeze({ engine: 'mariadb', label: 'MariaDB', adapterId: MARIADB_ADAPTER_ID, confirmation: 'RECOVER MARIADB TO POINT IN TIME', restoreConfirmations: MARIADB_RESTORE_CONFIRMATIONS, codePrefix: 'MARIADB', temporaryPrefix: 'deployerx-mariadb-pitr' })
});

class MysqlFamilyPitrError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'MysqlFamilyPitrError';
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

function publicError(error, profile) {
  if (error?.code && error?.category) return { code: String(error.code).slice(0, 100), category: String(error.category).slice(0, 50), retryable: Boolean(error.retryable), safeMessage: String(error.message || `${profile.label} point-in-time recovery failed.`).slice(0, 500) };
  return { code: `${profile.codePrefix}_PITR_FAILED`, category: 'restore', retryable: false, safeMessage: `DeployerX could not complete the ${profile.label} point-in-time recovery.` };
}

function normalizeRequest(input, profile) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError(`${profile.label} point-in-time recovery request must be an object.`);
  if (input.confirmed !== true || String(input.confirmationText || '').trim() !== profile.confirmation) throw new MysqlFamilyPitrError(`${profile.codePrefix}_PITR_CONFIRMATION_REQUIRED`, `Confirm the ${profile.label} point-in-time recovery before continuing.`, { category: 'conflict' });
  const mode = String(input.mode || 'original');
  if (!profile.restoreConfirmations[mode]) throw new MysqlFamilyPitrError(`${profile.codePrefix}_PITR_MODE_INVALID`, `Choose original server, alternate server, or new database for ${profile.label} point-in-time recovery.`, { category: 'validation' });
  const targetConnectionId = mode === 'original' ? null : requiredText(input.targetConnectionId, 'Target connection ID', 200);
  const targetDatabase = mode === 'new-database' ? requiredText(input.targetDatabase, 'Target database', 64) : null;
  const conflictPolicy = mode === 'alternate' && input.conflictPolicy === 'overwrite' ? 'overwrite' : 'fail';
  const stop = input.stop && typeof input.stop === 'object' && !Array.isArray(input.stop) ? structuredClone(input.stop) : {};
  return { terminalRecoveryPointId: requiredText(input.terminalRecoveryPointId || input.recoveryPointId, 'Terminal recovery point ID', 200), mode, targetConnectionId, targetDatabase, conflictPolicy, stop };
}

function coordinateKey(coordinate) {
  return `${coordinate?.engine || ''}\0${coordinate?.serverIdentityFingerprint || ''}\0${coordinate?.file || ''}\0${coordinate?.position || ''}`;
}

class MysqlFamilyPointInTimeRestoreService {
  constructor({ controlDatabase, secretStore, deviceId, adapter, baseRestoreService, openRepository, engine, temporaryRoot = os.tmpdir(), fileSystem = fs, clock = () => new Date().toISOString() } = {}) {
    const profile = PROFILES[engine];
    if (!profile || !controlDatabase || !secretStore || !adapter || !baseRestoreService || typeof openRepository !== 'function') throw new TypeError('MySQL-family point-in-time restore dependencies are required.');
    this.profile = profile;
    this.controlDatabase = controlDatabase;
    this.secretStore = secretStore;
    this.deviceId = requiredText(deviceId, 'Device ID', 200);
    this.adapter = adapter;
    this.baseRestoreService = baseRestoreService;
    this.openRepository = openRepository;
    this.temporaryRoot = temporaryRoot;
    this.fileSystem = fileSystem;
    this.clock = clock;
    this.active = new Map();
  }

  async #chain(workspaceId, terminalRecoveryPointId) {
    const points = await this.controlDatabase.repository('recoveryPoint').list(workspaceId, { limit: MAX_CHAIN_POINTS });
    if (points.length === MAX_CHAIN_POINTS) throw new MysqlFamilyPitrError(`${this.profile.codePrefix}_PITR_CHAIN_LIMIT`, 'The point-in-time recovery chain exceeds the supported bound.', { category: 'capacity' });
    const byId = new Map(points.map((point) => [point.id, point]));
    const terminal = byId.get(terminalRecoveryPointId);
    if (!terminal || terminal.type !== 'log') throw new MysqlFamilyPitrError(`${this.profile.codePrefix}_PITR_TERMINAL_INVALID`, `Choose a ${this.profile.label} binary-log recovery point.`, { category: 'validation' });
    const reverse = [];
    const seen = new Set();
    let current = terminal;
    while (current) {
      if (seen.has(current.id)) throw new MysqlFamilyPitrError(`${this.profile.codePrefix}_PITR_CHAIN_CYCLE`, 'The recovery chain contains a cycle.', { category: 'integrity' });
      seen.add(current.id);
      reverse.push(current);
      if (current.type === 'full') break;
      current = byId.get(current.parentRecoveryPointId);
      if (!current) throw new MysqlFamilyPitrError(`${this.profile.codePrefix}_PITR_CHAIN_GAP`, 'A required recovery point is missing from the binary-log chain.', { category: 'integrity' });
    }
    const chain = reverse.reverse();
    if (chain[0]?.type !== 'full' || chain.slice(1).some((point) => point.type !== 'log')) throw new MysqlFamilyPitrError(`${this.profile.codePrefix}_PITR_ANCHOR_INVALID`, 'The recovery chain does not begin with one logical full anchor.', { category: 'integrity' });
    const [anchor] = chain;
    if (chain.some((point) => point.sourceId !== anchor.sourceId || point.jobId !== anchor.jobId || point.chainRootId !== anchor.id)) throw new MysqlFamilyPitrError(`${this.profile.codePrefix}_PITR_CHAIN_IDENTITY_INVALID`, 'The recovery chain crosses a source, job, or chain boundary.', { category: 'integrity' });
    return chain;
  }

  async start(workspaceId, actorId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const request = normalizeRequest(input, this.profile);
    const chain = await this.#chain(tenant, request.terminalRecoveryPointId);
    const source = await this.controlDatabase.repository('source').get(tenant, chain[0].sourceId);
    if (!source || source.adapterId !== this.profile.adapterId) throw new MysqlFamilyPitrError(`${this.profile.codePrefix}_PITR_SOURCE_INVALID`, `The recovery chain is not a ${this.profile.label} PITR source.`, { category: 'validation' });
    const targetConnectionId = request.mode === 'original' ? source.connectionId : request.targetConnectionId;
    const connection = await this.controlDatabase.repository('connection').get(tenant, targetConnectionId);
    if (!connection || connection.adapterId !== this.profile.adapterId) throw new MysqlFamilyPitrError(`${this.profile.codePrefix}_PITR_TARGET_INVALID`, `Choose a saved ${this.profile.label} connection for the recovery target.`, { category: 'validation' });
    if (!(connection.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new MysqlFamilyPitrError(`${this.profile.codePrefix}_PITR_OTHER_DEVICE`, `The ${this.profile.label} recovery target belongs to another device.`, { category: 'authorization' });
    if (connection.lastTest?.status !== 'success' || !connection.trust?.fingerprint) throw new MysqlFamilyPitrError(`${this.profile.codePrefix}_PITR_TARGET_UNHEALTHY`, `Retest the selected ${this.profile.label} connection before recovery.`, { category: 'connectivity', retryable: true });
    const now = this.clock();
    const record = await this.controlDatabase.repository('restoreRun').create({
      workspaceId: tenant, actorId: actor, recoveryPointIds: chain.map((point) => point.id), targetConnectionId,
      target: { operation: 'point-in-time', mode: request.mode, engine: this.profile.engine, sourceId: source.id, connectionId: targetConnectionId, targetDatabase: request.targetDatabase, serverIdentityFingerprint: connection.trust.fingerprint },
      mode: request.mode, conflictPolicy: request.mode === 'original' ? 'overwrite' : request.conflictPolicy, workerId: `device:${this.deviceId}`, state: 'queued',
      progress: { phase: 'queued', itemsTotal: chain.length, itemsCompleted: 0, bytesTotal: 0, bytesWritten: 0, throughputBytesPerSecond: 0, startedAt: null, updatedAt: now, warnings: [] }, validation: null, result: null
    });
    const operation = this.#execute(tenant, actor, record.id, request, chain).catch(() => this.controlDatabase.repository('restoreRun').get(tenant, record.id));
    this.active.set(record.id, operation);
    operation.finally(() => this.active.delete(record.id));
    return record;
  }

  async wait(workspaceId, restoreRunId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const id = requiredText(restoreRunId, 'Restore run ID', 200);
    if (this.active.has(id)) await this.active.get(id);
    const record = await this.controlDatabase.repository('restoreRun').get(tenant, id);
    if (!record) throw new MysqlFamilyPitrError(`${this.profile.codePrefix}_PITR_RUN_NOT_FOUND`, 'The point-in-time RestoreRun was not found.', { category: 'not-found' });
    return record;
  }

  async list(workspaceId, options = {}) {
    return (await this.controlDatabase.repository('restoreRun').list(requiredText(workspaceId, 'Workspace ID', 200), { limit: Math.min(200, Math.max(1, Number(options.limit) || 50)) }))
      .filter((record) => record.target?.engine === this.profile.engine && record.target?.operation === 'point-in-time');
  }

  async reconcile(workspaceId, actorId = 'system') {
    const records = await this.list(workspaceId, { limit: 200 });
    const recovered = [];
    for (const record of records.filter((item) => !TERMINAL_STATES.has(item.state) && !this.active.has(item.id))) recovered.push(await this.#project(workspaceId, record.id, { state: 'failed', progress: { ...(record.progress || {}), phase: 'failed', updatedAt: this.clock() }, result: { error: { code: `${this.profile.codePrefix}_PITR_PROCESS_INTERRUPTED`, category: 'restore', retryable: true, safeMessage: 'The DeployerX process stopped before point-in-time recovery completed.' }, completedAt: this.clock() } }, actorId));
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
    for (const point of chain) {
      const kind = point.type === 'full' ? 'database-dump' : 'transaction-log';
      let selection = null;
      for (const copy of (point.repositoryCopies || []).filter((item) => item.state === 'available')) {
        const matching = artifacts.filter((artifact) => artifact.recoveryPointId === point.id && artifact.repositoryId === copy.repositoryId && artifact.kind === kind);
        if (matching.length) { selection = { point, copy, artifacts: matching }; break; }
      }
      if (!selection) throw new MysqlFamilyPitrError(`${this.profile.codePrefix}_PITR_ARTIFACT_UNAVAILABLE`, `A required ${this.profile.label} recovery-chain Artifact is unavailable.`, { category: 'not-found' });
      selected.push(selection);
    }
    const anchorMetadata = selected[0].artifacts[0].metadata;
    const anchorCoordinate = anchorMetadata?.binaryLog?.anchorCoordinate;
    if (!anchorCoordinate) throw new MysqlFamilyPitrError(`${this.profile.codePrefix}_PITR_ANCHOR_COORDINATE_MISSING`, 'The logical full anchor has no authenticated binary-log coordinate.', { category: 'integrity' });
    let previous = anchorCoordinate;
    for (const entry of selected.slice(1)) {
      const binaryLog = entry.artifacts[0].metadata?.binaryLog;
      if (!binaryLog?.startCoordinate || !binaryLog?.endCoordinate || coordinateKey(binaryLog.startCoordinate) !== coordinateKey(previous)) throw new MysqlFamilyPitrError(`${this.profile.codePrefix}_PITR_COORDINATE_GAP`, 'Adjacent recovery points do not form a contiguous binary-log interval.', { category: 'integrity' });
      previous = binaryLog.endCoordinate;
    }
    return { selected, anchorMetadata, anchorCoordinate, endCoordinate: previous };
  }

  async #materialize(workspaceId, selections, directory, progress, actorId, restoreRunId) {
    const files = [];
    let bytes = 0;
    for (let pointIndex = 0; pointIndex < selections.length; pointIndex += 1) {
      const entry = selections[pointIndex];
      const opened = await this.openRepository(workspaceId, entry.copy.repositoryId);
      const snapshot = await opened.engine.openSnapshot({}, { repositoryId: entry.copy.repositoryId, snapshotId: entry.copy.engineSnapshotId, masterKey: opened.masterKey });
      const artifactByPath = new Map(entry.artifacts.map((artifact) => [decodeURIComponent(String(artifact.locator).split('#').slice(1).join('#')), artifact]));
      const manifestFiles = (snapshot.manifest.files || []).filter((file) => file.type === 'file' && file.metadata?.artifactKind === 'transaction-log');
      for (const file of manifestFiles) {
        const artifact = artifactByPath.get(file.path);
        if (!artifact || artifact.sizeBytes !== file.sizeBytes || artifact.checksum?.digest !== file.contentDigest?.digest) throw new MysqlFamilyPitrError(`${this.profile.codePrefix}_PITR_MANIFEST_INVALID`, 'A binary-log manifest does not match its Artifact record.', { category: 'integrity' });
        bytes += file.sizeBytes;
        if (bytes > MAX_REPLAY_BYTES) throw new MysqlFamilyPitrError(`${this.profile.codePrefix}_PITR_REPLAY_LIMIT`, 'The point-in-time replay exceeds the temporary-storage limit.', { category: 'capacity' });
        const fileName = requiredText(file.metadata?.segment?.file, 'Binary-log file name', 255);
        const filePath = path.join(directory, `${String(pointIndex).padStart(4, '0')}-${fileName}`);
        const handle = await this.fileSystem.open(filePath, 'wx', 0o600);
        try {
          const stream = opened.engine.streamFile({}, { repositoryId: entry.copy.repositoryId, manifest: snapshot.manifest, masterKey: opened.masterKey, path: file.path });
          for await (const chunk of stream) {
            await handle.write(Buffer.from(chunk));
            progress.bytesWritten += Buffer.byteLength(chunk);
          }
          await handle.sync();
        } finally { await handle.close(); }
        files.push({ file: fileName, filePath, startPosition: Number(file.metadata.segment.startPosition), stopPosition: Number(file.metadata.segment.stopPosition), sizeBytes: file.sizeBytes });
        progress.itemsCompleted += 1; progress.updatedAt = this.clock();
        await this.#project(workspaceId, restoreRunId, { progress: structuredClone(progress) }, actorId);
      }
    }
    return { files, bytes };
  }

  async #execute(workspaceId, actorId, restoreRunId, request, chain) {
    let directory = null;
    let progress = { phase: 'preparing', itemsTotal: chain.length, itemsCompleted: 0, bytesTotal: 0, bytesWritten: 0, throughputBytesPerSecond: 0, startedAt: this.clock(), updatedAt: this.clock(), warnings: [] };
    let validationRecord = null;
    try {
      await this.#project(workspaceId, restoreRunId, { state: 'preparing', progress }, actorId);
      const source = await this.controlDatabase.repository('source').get(workspaceId, chain[0].sourceId);
      const evidence = await this.#selectArtifacts(workspaceId, chain);
      const stop = normalizePointInTimeTarget(request.stop, { engine: this.profile.engine, earliest: evidence.anchorCoordinate.capturedAt, latest: evidence.endCoordinate.capturedAt, earliestCoordinate: evidence.anchorCoordinate, latestCoordinate: evidence.endCoordinate });
      const sourceDatabase = evidence.anchorMetadata?.binaryLog?.database || evidence.anchorMetadata?.server?.selectedDatabases?.[0] || evidence.anchorMetadata?.selection?.databases?.include?.[0]?.name;
      if (!sourceDatabase) throw new MysqlFamilyPitrError(`${this.profile.codePrefix}_PITR_DATABASE_MISSING`, 'The recovery chain has no authenticated protected database identity.', { category: 'integrity' });
      progress = { ...progress, phase: 'running', itemsTotal: evidence.selected.slice(1).reduce((count, entry) => count + entry.artifacts.length, 0) + 1, bytesTotal: evidence.selected.slice(1).flatMap((entry) => entry.artifacts).reduce((total, artifact) => total + Number(artifact.sizeBytes || 0), 0), updatedAt: this.clock() };
      await this.#project(workspaceId, restoreRunId, { state: 'running', progress, target: { operation: 'point-in-time', mode: request.mode, engine: this.profile.engine, sourceId: source.id, connectionId: request.mode === 'original' ? source.connectionId : request.targetConnectionId, sourceDatabase, targetDatabase: request.targetDatabase, stop } }, actorId);
      const anchorRun = await this.baseRestoreService.start(workspaceId, actorId, { recoveryPointId: chain[0].id, mode: request.mode, targetConnectionId: request.targetConnectionId, targetDatabase: request.targetDatabase, conflictPolicy: request.conflictPolicy, confirmed: true, confirmationText: this.profile.restoreConfirmations[request.mode] });
      const anchorCompleted = await this.baseRestoreService.wait(workspaceId, anchorRun.id);
      if (!['succeeded', 'warning'].includes(anchorCompleted.state)) throw new MysqlFamilyPitrError(`${this.profile.codePrefix}_PITR_ANCHOR_RESTORE_FAILED`, `The ${this.profile.label} logical anchor restore failed before binary-log replay.`, { category: 'restore' });
      progress.itemsCompleted = 1;
      directory = await this.fileSystem.mkdtemp(path.join(this.temporaryRoot, `${this.profile.temporaryPrefix}-`));
      await this.fileSystem.chmod(directory, 0o700).catch(() => {});
      const materialized = await this.#materialize(workspaceId, evidence.selected.slice(1), directory, progress, actorId, restoreRunId);
      const targetConnectionId = request.mode === 'original' ? source.connectionId : request.targetConnectionId;
      const targetConnection = await this.controlDatabase.repository('connection').get(workspaceId, targetConnectionId);
      const [passwordSecretRefId] = targetConnection.secretRefIds || [];
      const connectionConfig = this.adapter.normalizeConfig({ ...targetConnection.endpoint, passwordSecretRefId });
      const targetDatabase = request.mode === 'new-database' ? request.targetDatabase : sourceDatabase;
      const replay = await this.adapter.executeBinaryLogReplay({ resolveSecret: (secretRefId) => this.secretStore.resolve({ workspaceId, id: secretRefId }) }, { connection: connectionConfig, sourceDatabase, targetDatabase, files: materialized.files, stop });
      progress = { ...progress, phase: 'validating', updatedAt: this.clock() };
      await this.#project(workspaceId, restoreRunId, { state: 'validating', progress }, actorId);
      const validationMetadata = request.mode === 'new-database' ? remapMysqlFamilyMetadata(evidence.anchorMetadata.server || evidence.anchorMetadata, targetDatabase).metadata : (evidence.anchorMetadata.server || evidence.anchorMetadata);
      const validation = await this.adapter.validateRestore({ resolveSecret: (secretRefId) => this.secretStore.resolve({ workspaceId, id: secretRefId }), connection: connectionConfig }, { status: 'succeeded', metadata: validationMetadata });
      validationRecord = { state: validation.status, connectivity: validation.checks?.find((check) => check.id === 'connectivity')?.status || 'failed', expectedObjects: validation.checks?.find((check) => check.id === 'expected-objects')?.status || 'unavailable', nativeIntegrityValidation: Boolean(validation.nativeIntegrityValidation), checks: validation.checks || [], completedAt: this.clock() };
      if (!validation.valid) throw new MysqlFamilyPitrError(`${this.profile.codePrefix}_PITR_VALIDATION_FAILED`, `The recovered ${this.profile.label} database did not pass native validation.`, { category: 'integrity' });
      progress = { ...progress, phase: 'complete', updatedAt: this.clock() };
      return this.#project(workspaceId, restoreRunId, { state: 'succeeded', progress, validation: { ...validationRecord, state: 'succeeded' }, result: { anchorRestoreRunId: anchorCompleted.id, fullAnchorRecoveryPointId: chain[0].id, terminalRecoveryPointId: chain.at(-1).id, replayedRecoveryPointIds: chain.slice(1).map((point) => point.id), replayedFiles: replay.replayedFiles, bytesRestored: materialized.bytes, stop, finalCoordinate: evidence.endCoordinate, warnings: [], completedAt: this.clock() } }, actorId);
    } catch (error) {
      const current = await this.controlDatabase.repository('restoreRun').get(workspaceId, restoreRunId);
      if (current && !TERMINAL_STATES.has(current.state)) return this.#project(workspaceId, restoreRunId, { state: 'failed', progress: { ...progress, phase: 'failed', updatedAt: this.clock() }, validation: validationRecord, result: { error: publicError(error, this.profile), completedAt: this.clock() } }, actorId);
      throw error;
    } finally {
      if (directory) await this.fileSystem.rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  }
}

class MysqlPointInTimeRestoreService extends MysqlFamilyPointInTimeRestoreService {
  constructor(options = {}) { super({ ...options, engine: 'mysql' }); }
}

class MariadbPointInTimeRestoreService extends MysqlFamilyPointInTimeRestoreService {
  constructor(options = {}) { super({ ...options, engine: 'mariadb' }); }
}

module.exports = {
  MAX_CHAIN_POINTS,
  MAX_REPLAY_BYTES,
  MariadbPointInTimeRestoreService,
  MysqlFamilyPitrError,
  MysqlFamilyPointInTimeRestoreService,
  MysqlPointInTimeRestoreService,
  PROFILES,
  normalizeRequest
};
