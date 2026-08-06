const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { digestJson } = require('./database-adapter');
const { ADAPTER_ID, RESTORE_CONFIRMATION } = require('./influxdb');

const TERMINAL_STATES = new Set(['succeeded', 'warning', 'failed', 'canceled', 'interrupted']);
const RESTORE_OPERATION = 'influxdb-oss-v2-alternate-restore';
const METADATA_PATH = 'influxdb/backup-metadata.json';
const NATIVE_PREFIX = 'influxdb/native/';
const MAX_ARTIFACTS = 1000;
const MAX_METADATA_BYTES = 16 * 1024 * 1024;

class InfluxDbRestoreError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'InfluxDbRestoreError';
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
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('InfluxDB restore request must be an object.');
  if (String(input.mode || 'alternate') !== 'alternate') throw new InfluxDbRestoreError('INFLUXDB_RESTORE_MODE_UNSUPPORTED', 'InfluxDB recovery currently supports an alternate instance only.', { category: 'compatibility' });
  if (options.requireConfirmation !== false && (input.confirmed !== true || String(input.confirmationText || '').trim() !== RESTORE_CONFIRMATION)) throw new InfluxDbRestoreError('INFLUXDB_RESTORE_CONFIRMATION_REQUIRED', 'Confirm the InfluxDB alternate-instance recovery before continuing.', { category: 'conflict' });
  return { recoveryPointId: requiredText(input.recoveryPointId, 'RecoveryPoint ID', 200), targetConnectionId: requiredText(input.targetConnectionId, 'InfluxDB target connection ID', 200), mode: 'alternate' };
}

function publicError(error) {
  if (error instanceof InfluxDbRestoreError || (error?.code && error?.category)) return { code: String(error.code).slice(0, 100), category: String(error.category || 'restore').slice(0, 80), retryable: Boolean(error.retryable), safeMessage: String(error.message || 'The InfluxDB recovery failed.').slice(0, 500) };
  return { code: 'INFLUXDB_RESTORE_FAILED', category: 'restore', retryable: false, safeMessage: 'DeployerX could not complete the InfluxDB alternate-instance recovery.' };
}

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function safeRelativePath(value) {
  const relative = requiredText(value, 'InfluxDB native member path', 8192);
  const segments = relative.split('/');
  if (relative.includes('\\') || path.posix.isAbsolute(relative) || segments.some((segment) => !segment || segment === '.' || segment === '..')) throw new InfluxDbRestoreError('INFLUXDB_RESTORE_MEDIA_INVALID', 'InfluxDB native media contains an unsafe member path.', { category: 'integrity' });
  return relative;
}

function restorePrefix(workspaceId, restoreRunId) {
  return `restore-${crypto.createHash('sha256').update(`${workspaceId}\0${restoreRunId}`).digest('hex').slice(0, 32)}-`;
}

class InfluxDbRestoreService {
  constructor({ controlDatabase, deviceId, adapter, connectionService, openRepository, temporaryRoot = path.join(os.tmpdir(), 'deployerx-influxdb-restores'), fileSystem = fs, clock = () => new Date().toISOString(), now = () => Date.now() } = {}) {
    if (!controlDatabase || !adapter || !connectionService || typeof openRepository !== 'function') throw new TypeError('InfluxDB restore dependencies are required.');
    this.controlDatabase = controlDatabase;
    this.deviceId = requiredText(deviceId, 'Device ID', 200);
    this.adapter = adapter;
    this.connectionService = connectionService;
    this.openRepository = openRepository;
    this.temporaryRoot = path.resolve(requiredText(temporaryRoot, 'InfluxDB restore temporary root'));
    this.fileSystem = fileSystem;
    this.clock = clock;
    this.now = now;
    this.active = new Map();
  }

  async preview(workspaceId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const request = normalizeRequest(input, { requireConfirmation: false });
    const prepared = await this.#prepare(tenant, request, input.signal);
    return {
      mode: 'alternate', recoveryPointId: prepared.point.id, targetConnectionId: prepared.targetConnection.id,
      scope: prepared.metadata.scope.type, organization: { id: prepared.metadata.scope.organizationId, name: prepared.metadata.scope.organizationName },
      bucket: prepared.metadata.scope.type === 'bucket' ? { id: prepared.metadata.scope.bucketId, name: prepared.metadata.scope.bucketName } : null,
      sourceVersion: prepared.metadata.source.productVersion, targetVersion: prepared.plan.target.productVersion,
      fileCount: prepared.metadata.nativeMedia.fileCount, totalBytes: prepared.metadata.nativeMedia.totalBytes,
      targetEmpty: true, sourceDeploymentProtected: true, originalTargetReplacement: false, nativeValidation: true,
      confirmationText: RESTORE_CONFIRMATION,
      planDigest: digest({ recoveryPointId: prepared.point.id, targetConnectionId: prepared.targetConnection.id, source: prepared.sourceEvidence, target: prepared.plan.target })
    };
  }

  async start(workspaceId, actorId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const request = normalizeRequest(input);
    const prepared = await this.#prepare(tenant, request, input.signal);
    const now = this.clock();
    const record = await this.controlDatabase.repository('restoreRun').create({
      workspaceId: tenant, actorId: actor, recoveryPointIds: [prepared.point.id], targetConnectionId: prepared.targetConnection.id,
      target: {
        operation: RESTORE_OPERATION, mode: 'alternate', engine: 'influxdb', sourceId: prepared.source.id,
        targetConnectionId: prepared.targetConnection.id, targetDeploymentFingerprint: prepared.plan.target.deploymentFingerprint,
        nativeMutationStarted: false, mutationStartedAt: null,
        restoreEvidence: { source: prepared.sourceEvidence, target: prepared.plan.target }
      },
      mode: 'alternate', conflictPolicy: 'fail', workerId: `device:${this.deviceId}`, state: 'queued',
      progress: { phase: 'queued', itemsTotal: prepared.metadata.nativeMedia.fileCount, itemsCompleted: 0, bytesTotal: prepared.metadata.nativeMedia.totalBytes, bytesWritten: 0, throughputBytesPerSecond: 0, startedAt: null, updatedAt: now, warnings: [] },
      validation: null, result: null
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
    if (!record || record.target?.operation !== RESTORE_OPERATION || record.target?.engine !== 'influxdb') throw new InfluxDbRestoreError('INFLUXDB_RESTORE_RUN_NOT_FOUND', 'The InfluxDB RestoreRun was not found.', { category: 'not-found' });
    return record;
  }

  async cancel(workspaceId, actorId, restoreRunId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    requiredText(actorId, 'Actor ID', 200);
    const id = requiredText(restoreRunId, 'RestoreRun ID', 200);
    const record = await this.controlDatabase.repository('restoreRun').get(tenant, id);
    if (!record || record.target?.operation !== RESTORE_OPERATION || record.target?.engine !== 'influxdb') throw new InfluxDbRestoreError('INFLUXDB_RESTORE_RUN_NOT_FOUND', 'The InfluxDB RestoreRun was not found.', { category: 'not-found' });
    if (TERMINAL_STATES.has(record.state)) return record;
    const active = this.active.get(id);
    if (!active) throw new InfluxDbRestoreError('INFLUXDB_RESTORE_NOT_ACTIVE', 'The InfluxDB recovery is not active in this DeployerX process.', { category: 'conflict' });
    active.controller.abort();
    await active.operation;
    return this.controlDatabase.repository('restoreRun').get(tenant, id);
  }

  async list(workspaceId, options = {}) {
    return (await this.controlDatabase.repository('restoreRun').list(requiredText(workspaceId, 'Workspace ID', 200), { limit: Math.min(200, Math.max(1, Number(options.limit) || 50)) }))
      .filter((record) => record.target?.operation === RESTORE_OPERATION && record.target?.engine === 'influxdb');
  }

  async authenticateRecoveryPoint(workspaceId, recoveryPointId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const point = await this.controlDatabase.repository('recoveryPoint').get(tenant, requiredText(recoveryPointId, 'RecoveryPoint ID', 200));
    if (!point) throw new InfluxDbRestoreError('INFLUXDB_RECOVERY_POINT_NOT_FOUND', 'The InfluxDB RecoveryPoint was not found.', { category: 'not-found' });
    const source = await this.controlDatabase.repository('source').get(tenant, point.sourceId);
    if (!source || source.adapterId !== ADAPTER_ID || point.type !== 'full' || point.consistency !== 'application' || point.verification?.state !== 'succeeded' || point.retention?.deletionEligible === true || source.consistency?.backupMethod !== 'physical') throw new InfluxDbRestoreError('INFLUXDB_RECOVERY_POINT_INVALID', 'Choose a retained, verified, application-consistent InfluxDB full RecoveryPoint.', { category: 'validation' });
    const artifacts = await this.controlDatabase.repository('artifact').list(tenant, { limit: MAX_ARTIFACTS });
    if (artifacts.length === MAX_ARTIFACTS) throw new InfluxDbRestoreError('INFLUXDB_RESTORE_ARTIFACT_LIMIT', 'The InfluxDB Artifact scan exceeds the bounded limit.', { category: 'capacity' });
    const selected = (point.repositoryCopies || []).filter((copy) => copy.state === 'available').map((copy) => ({ copy, artifact: artifacts.find((item) => item.recoveryPointId === point.id && item.repositoryId === copy.repositoryId && item.kind === 'metadata' && item.metadata?.adapterId === ADAPTER_ID && item.metadata?.kind === 'influxdb-oss-v2-native-backup') })).find((item) => item.artifact);
    if (!selected) throw new InfluxDbRestoreError('INFLUXDB_RESTORE_REPOSITORY_UNAVAILABLE', 'No available repository contains the authenticated InfluxDB backup.', { category: 'not-found' });
    const repositoryId = selected.copy.repositoryId;
    const opened = await this.openRepository(tenant, repositoryId);
    const snapshot = await opened.engine.openSnapshot({}, { repositoryId, snapshotId: selected.copy.engineSnapshotId, masterKey: opened.masterKey });
    if (snapshot.summary?.manifestKey !== selected.copy.manifestLocator || snapshot.summary?.manifestChecksum?.digest !== selected.copy.manifestChecksum?.digest) throw new InfluxDbRestoreError('INFLUXDB_RESTORE_MANIFEST_INVALID', 'The repository manifest no longer matches the InfluxDB RecoveryPoint.', { category: 'integrity' });
    const locatorParts = String(selected.artifact.locator || '').split('#');
    const locatorPath = decodeURIComponent(locatorParts.slice(1).join('#'));
    const metadataFile = (snapshot.manifest.files || []).find((file) => file.type === 'file' && file.path === locatorPath);
    if (locatorParts.length !== 2 || locatorPath !== METADATA_PATH || !metadataFile || metadataFile.sizeBytes !== selected.artifact.sizeBytes || metadataFile.sizeBytes < 1 || metadataFile.sizeBytes > MAX_METADATA_BYTES || metadataFile.contentDigest?.digest !== selected.artifact.checksum?.digest || metadataFile.metadata?.artifactKind !== 'metadata' || metadataFile.metadata?.database?.adapterId !== ADAPTER_ID) throw new InfluxDbRestoreError('INFLUXDB_RESTORE_ARTIFACT_INVALID', 'The InfluxDB metadata Artifact is incomplete or inconsistent.', { category: 'integrity' });
    let metadata;
    try { metadata = JSON.parse((await opened.engine.readFile({}, { repositoryId, manifest: snapshot.manifest, path: METADATA_PATH, masterKey: opened.masterKey })).toString('utf8')); } catch { throw new InfluxDbRestoreError('INFLUXDB_RESTORE_ARTIFACT_INVALID', 'The authenticated InfluxDB metadata cannot be decoded.', { category: 'integrity' }); }
    if (digestJson(metadata) !== digestJson(selected.artifact.metadata) || metadata.kind !== 'influxdb-oss-v2-native-backup' || metadata.adapterId !== ADAPTER_ID || metadata.sourceId !== source.id || metadata.selectionDigest !== source.selector?.digest || metadata.backupMethod !== 'physical' || metadata.backupMode !== 'full' || metadata.artifact?.path !== METADATA_PATH || metadata.artifact?.restoreSupported !== true || metadata.tokenRecovery !== 'hash-only-plaintext-unrecoverable' || metadata.source?.deploymentFingerprint !== source.physicalExecution?.deploymentFingerprint || metadata.source?.inventoryFingerprint !== source.physicalExecution?.inventoryFingerprint) throw new InfluxDbRestoreError('INFLUXDB_RESTORE_ARTIFACT_INVALID', 'Authenticated InfluxDB metadata is inconsistent with its Source and RecoveryPoint.', { category: 'integrity' });
    const rawMembers = metadata.nativeMedia?.members;
    if (!Array.isArray(rawMembers) || rawMembers.length !== metadata.nativeMedia?.fileCount || rawMembers.length < 1 || rawMembers.length > 10000) throw new InfluxDbRestoreError('INFLUXDB_RESTORE_MEDIA_INVALID', 'InfluxDB native media inventory is invalid.', { category: 'integrity' });
    const seen = new Set(); let totalBytes = 0;
    const members = rawMembers.map((raw) => {
      const relativePath = safeRelativePath(raw.relativePath);
      const repositoryPath = `${NATIVE_PREFIX}${relativePath}`;
      const sizeBytes = Number(raw.sizeBytes);
      const contentDigest = requiredText(raw.contentDigest, 'InfluxDB native member digest', 80);
      if (raw.path !== repositoryPath || seen.has(relativePath) || !Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || !/^sha256:[0-9a-f]{64}$/.test(contentDigest)) throw new InfluxDbRestoreError('INFLUXDB_RESTORE_MEDIA_INVALID', 'InfluxDB native media evidence is malformed or duplicated.', { category: 'integrity' });
      seen.add(relativePath); totalBytes += sizeBytes;
      const file = snapshot.manifest.files.find((candidate) => candidate.type === 'file' && candidate.path === repositoryPath);
      if (!file || file.sizeBytes !== sizeBytes || file.metadata?.artifactKind !== 'physical-backup-member' || file.metadata?.nativeRelativePath !== relativePath || file.metadata?.contentDigest !== contentDigest) throw new InfluxDbRestoreError('INFLUXDB_RESTORE_MEDIA_INVALID', 'A native InfluxDB member is missing or inconsistent in the repository manifest.', { category: 'integrity' });
      return Object.freeze({ relativePath, repositoryPath, sizeBytes, contentDigest, file });
    }).sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en-US'));
    const nativeFiles = snapshot.manifest.files.filter((file) => file.type === 'file' && file.path.startsWith(NATIVE_PREFIX));
    const mediaFingerprint = digest(members.map(({ relativePath, sizeBytes, contentDigest }) => ({ relativePath, sizeBytes, contentDigest })));
    if (nativeFiles.length !== members.length || snapshot.manifest.files.filter((file) => file.type === 'file').length !== members.length + 1 || totalBytes !== metadata.nativeMedia.totalBytes || mediaFingerprint !== metadata.nativeMedia.mediaFingerprint || members.filter((member) => member.relativePath.endsWith('.manifest')).length !== 1) throw new InfluxDbRestoreError('INFLUXDB_RESTORE_MEDIA_INVALID', 'The complete InfluxDB native media set failed authentication.', { category: 'integrity' });
    return { point, source, repositoryId, opened, snapshot, artifact: selected.artifact, metadata, members, totalBytes };
  }

  async verifyRecoveryPointMedia(selected, signal) {
    if (!selected?.opened?.engine || !selected?.snapshot?.manifest || !Array.isArray(selected.members)) throw new InfluxDbRestoreError('INFLUXDB_RESTORE_MEDIA_INVALID', 'Authenticated InfluxDB recovery media is required.', { category: 'integrity' });
    const verified = []; let totalBytes = 0;
    for (const member of selected.members) {
      if (signal?.aborted) throw new InfluxDbRestoreError('INFLUXDB_VERIFICATION_CANCELED', 'InfluxDB recovery-media verification was canceled.', { category: 'canceled' });
      const hash = crypto.createHash('sha256'); let sizeBytes = 0;
      for await (const rawChunk of selected.opened.engine.streamFile({}, { repositoryId: selected.repositoryId, manifest: selected.snapshot.manifest, path: member.repositoryPath, masterKey: selected.opened.masterKey })) {
        if (signal?.aborted) throw new InfluxDbRestoreError('INFLUXDB_VERIFICATION_CANCELED', 'InfluxDB recovery-media verification was canceled.', { category: 'canceled' });
        const chunk = Buffer.from(rawChunk); hash.update(chunk); sizeBytes += chunk.length;
      }
      const contentDigest = `sha256:${hash.digest('hex')}`;
      if (sizeBytes !== member.sizeBytes || contentDigest !== member.contentDigest) throw new InfluxDbRestoreError('INFLUXDB_RESTORE_MEDIA_INVALID', 'An InfluxDB repository member failed end-to-end verification.', { category: 'integrity' });
      verified.push({ relativePath: member.relativePath, sizeBytes, contentDigest }); totalBytes += sizeBytes;
    }
    const mediaFingerprint = digest(verified);
    if (verified.length !== selected.metadata.nativeMedia.fileCount || totalBytes !== selected.metadata.nativeMedia.totalBytes || mediaFingerprint !== selected.metadata.nativeMedia.mediaFingerprint) throw new InfluxDbRestoreError('INFLUXDB_RESTORE_MEDIA_INVALID', 'The complete InfluxDB repository media set failed end-to-end verification.', { category: 'integrity' });
    return Object.freeze({ fileCount: verified.length, totalBytes, mediaFingerprint });
  }

  async reconcile(workspaceId, actorId = 'system') {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const recovered = [];
    for (const record of (await this.list(tenant, { limit: 200 })).filter((item) => !TERMINAL_STATES.has(item.state) && !this.active.has(item.id))) {
      await this.#cleanupOwnedDirectories(tenant, record.id).catch(() => {});
      let validation = null; let reconciliationError = null;
      if (record.target?.nativeMutationStarted === true) {
        try {
          const connection = await this.controlDatabase.repository('connection').get(tenant, record.targetConnectionId);
          if (!this.#validTargetConnection(connection)) throw new InfluxDbRestoreError('INFLUXDB_RESTORE_TARGET_CONNECTION_INVALID', 'The InfluxDB restore target connection is unavailable.', { category: 'connectivity' });
          validation = await this.connectionService.withExecution(tenant, connection, undefined, (context, config) => this.adapter.validateRestore(context, { plan: { operation: RESTORE_OPERATION, connection: config, source: record.target.restoreEvidence?.source, target: record.target.restoreEvidence?.target } }));
        } catch (error) { reconciliationError = publicError(error); }
      }
      if (validation?.valid === true) {
        let current = await this.controlDatabase.repository('restoreRun').get(tenant, record.id);
        if (current.state === 'queued') current = await this.#project(tenant, record.id, { state: 'preparing', progress: { ...(current.progress || {}), phase: 'reconciling', updatedAt: this.clock() } }, actorId);
        if (current.state === 'preparing') current = await this.#project(tenant, record.id, { state: 'running', progress: { ...(current.progress || {}), phase: 'reconciling', updatedAt: this.clock() } }, actorId);
        if (current.state === 'running') current = await this.#project(tenant, record.id, { state: 'validating', progress: { ...(current.progress || {}), phase: 'validating', updatedAt: this.clock() } }, actorId);
        recovered.push(await this.#project(tenant, record.id, { state: 'succeeded', progress: { ...(current.progress || {}), phase: 'complete', itemsCompleted: current.progress?.itemsTotal || validation.buckets.length, updatedAt: this.clock() }, validation: this.#validationRecord(validation), result: { reconciledAfterRestart: true, organization: validation.organization, buckets: validation.buckets, targetPreserved: true, rollbackClaimed: false, warnings: [], completedAt: this.clock() } }, actorId));
      } else {
        const mutated = record.target?.nativeMutationStarted === true;
        recovered.push(await this.#project(tenant, record.id, { state: mutated ? 'interrupted' : 'failed', progress: { ...(record.progress || {}), phase: mutated ? 'operator-action-required' : 'failed', updatedAt: this.clock() }, result: { reconciliationError, error: { code: mutated ? 'INFLUXDB_RESTORE_INTERRUPTED_AFTER_MUTATION' : 'INFLUXDB_RESTORE_PROCESS_INTERRUPTED', category: 'restore', retryable: false, safeMessage: mutated ? 'InfluxDB recovery was interrupted after native restore began. The alternate target is preserved for inspection and no rollback is claimed.' : 'InfluxDB recovery was interrupted before native restore began.' }, targetPreserved: mutated, rollbackClaimed: false, completedAt: this.clock() } }, actorId));
      }
    }
    return recovered;
  }

  #validTargetConnection(connection) {
    const identity = connection?.lastTest?.endpointIdentity;
    return connection?.adapterId === ADAPTER_ID && connection.lastTest?.status === 'success' && Boolean(connection.trust?.fingerprint)
      && connection.trust.fingerprint === connection.endpoint?.expectedDeploymentFingerprint && identity?.deploymentFingerprint === connection.trust.fingerprint
      && identity?.version === connection.endpoint?.expectedVersion && identity?.cliVersion === connection.endpoint?.expectedCliVersion
      && (connection.workerAffinity || []).includes(`device:${this.deviceId}`);
  }

  async #prepare(workspaceId, request, signal) {
    const authenticated = await this.authenticateRecoveryPoint(workspaceId, request.recoveryPointId);
    const targetConnection = await this.controlDatabase.repository('connection').get(workspaceId, request.targetConnectionId);
    if (!this.#validTargetConnection(targetConnection)) throw new InfluxDbRestoreError('INFLUXDB_RESTORE_TARGET_CONNECTION_INVALID', 'Choose a successfully tested InfluxDB target connection on this device.', { category: 'connectivity', retryable: true });
    const sourceEvidence = { product: authenticated.metadata.source.product, productVersion: authenticated.metadata.source.productVersion, cliVersion: authenticated.metadata.source.cliVersion, deploymentFingerprint: authenticated.metadata.source.deploymentFingerprint, scope: authenticated.metadata.scope, nativeMedia: { fileCount: authenticated.metadata.nativeMedia.fileCount, totalBytes: authenticated.metadata.nativeMedia.totalBytes, mediaFingerprint: authenticated.metadata.nativeMedia.mediaFingerprint } };
    const plan = await this.connectionService.withExecution(workspaceId, targetConnection, signal, (context, connection) => this.adapter.planRestore(context, { mode: 'alternate', confirmation: RESTORE_CONFIRMATION, connection, source: sourceEvidence }));
    return { ...authenticated, targetConnection, sourceEvidence, plan };
  }

  async #materialize(workspaceId, restoreRunId, authenticated, signal, onProgress) {
    await this.fileSystem.mkdir(this.temporaryRoot, { recursive: true, mode: 0o700 });
    await this.fileSystem.chmod(this.temporaryRoot, 0o700).catch(() => {});
    const directory = await this.fileSystem.mkdtemp(path.join(this.temporaryRoot, restorePrefix(workspaceId, restoreRunId)));
    const nativeDirectory = path.join(directory, 'native');
    try {
      await this.fileSystem.chmod(directory, 0o700).catch(() => {});
      await this.fileSystem.writeFile(path.join(directory, '.owner.json'), JSON.stringify({ version: 1, workspaceId, restoreRunId }), { flag: 'wx', mode: 0o600 });
      await this.fileSystem.mkdir(nativeDirectory, { mode: 0o700 });
      let bytesWritten = 0; let itemsCompleted = 0; const verified = [];
      for (const member of authenticated.members) {
        if (signal?.aborted) throw new InfluxDbRestoreError('INFLUXDB_RESTORE_CANCELED', 'The InfluxDB recovery was canceled before native restore.', { category: 'canceled' });
        const destination = path.resolve(nativeDirectory, ...member.relativePath.split('/'));
        if (!destination.startsWith(`${nativeDirectory}${path.sep}`)) throw new InfluxDbRestoreError('INFLUXDB_RESTORE_MEDIA_INVALID', 'InfluxDB native media escaped the owned restore directory.', { category: 'integrity' });
        await this.fileSystem.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
        const handle = await this.fileSystem.open(destination, 'wx', 0o600);
        const hash = crypto.createHash('sha256'); let sizeBytes = 0;
        try {
          for await (const rawChunk of authenticated.opened.engine.streamFile({}, { repositoryId: authenticated.repositoryId, manifest: authenticated.snapshot.manifest, path: member.repositoryPath, masterKey: authenticated.opened.masterKey })) {
            if (signal?.aborted) throw new InfluxDbRestoreError('INFLUXDB_RESTORE_CANCELED', 'The InfluxDB recovery was canceled before native restore.', { category: 'canceled' });
            const chunk = Buffer.from(rawChunk); let offset = 0;
            while (offset < chunk.length) {
              const written = (await handle.write(chunk, offset, chunk.length - offset)).bytesWritten;
              if (!Number.isInteger(written) || written < 1) throw new InfluxDbRestoreError('INFLUXDB_RESTORE_MEDIA_INVALID', 'InfluxDB restore staging could not write an authenticated member.', { category: 'integrity' });
              offset += written;
            }
            hash.update(chunk); sizeBytes += chunk.length; bytesWritten += chunk.length;
            await onProgress?.({ bytesWritten, itemsCompleted });
          }
          await handle.sync();
        } finally { await handle.close(); }
        const contentDigest = `sha256:${hash.digest('hex')}`;
        if (sizeBytes !== member.sizeBytes || contentDigest !== member.contentDigest) throw new InfluxDbRestoreError('INFLUXDB_RESTORE_MEDIA_INVALID', 'A materialized InfluxDB member failed its authenticated size or digest.', { category: 'integrity' });
        verified.push({ relativePath: member.relativePath, sizeBytes, contentDigest }); itemsCompleted += 1;
        await onProgress?.({ bytesWritten, itemsCompleted });
      }
      if (bytesWritten !== authenticated.totalBytes || digest(verified) !== authenticated.metadata.nativeMedia.mediaFingerprint) throw new InfluxDbRestoreError('INFLUXDB_RESTORE_MEDIA_INVALID', 'Materialized InfluxDB media failed aggregate authentication.', { category: 'integrity' });
      return { directory, nativeDirectory };
    } catch (error) {
      await this.fileSystem.rm(directory, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async #cleanupOwnedDirectory(workspaceId, restoreRunId, directory) {
    const owner = await this.fileSystem.readFile(path.join(directory, '.owner.json'), 'utf8').then(JSON.parse).catch(() => null);
    if (owner?.version !== 1 || owner.workspaceId !== workspaceId || owner.restoreRunId !== restoreRunId) throw new InfluxDbRestoreError('INFLUXDB_RESTORE_CLEANUP_UNPROVEN', 'InfluxDB restore staging ownership could not be proven.', { category: 'integrity' });
    await this.fileSystem.rm(directory, { recursive: true, force: true });
  }

  async #cleanupOwnedDirectories(workspaceId, restoreRunId) {
    const prefix = restorePrefix(workspaceId, restoreRunId);
    const entries = await this.fileSystem.readdir(this.temporaryRoot, { withFileTypes: true }).catch((error) => error?.code === 'ENOENT' ? [] : Promise.reject(error));
    let removed = 0;
    for (const entry of entries.slice(0, 10000)) {
      if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
      await this.#cleanupOwnedDirectory(workspaceId, restoreRunId, path.join(this.temporaryRoot, entry.name)); removed += 1;
    }
    return removed;
  }

  #validationRecord(validation) {
    return { state: validation.status, connectivity: 'succeeded', expectedObjects: 'succeeded', nativeIntegrityValidation: true, checks: validation.checks || [], completedAt: this.clock() };
  }

  async #execute(workspaceId, actorId, restoreRunId, request, signal) {
    let progress = { phase: 'preparing', itemsTotal: 0, itemsCompleted: 0, bytesTotal: 0, bytesWritten: 0, throughputBytesPerSecond: 0, startedAt: this.clock(), updatedAt: this.clock(), warnings: [] };
    let staging = null;
    try {
      await this.#project(workspaceId, restoreRunId, { state: 'preparing', progress }, actorId);
      const prepared = await this.#prepare(workspaceId, request, signal);
      const admitted = await this.controlDatabase.repository('restoreRun').get(workspaceId, restoreRunId);
      if (digest(admitted.target?.restoreEvidence?.target) !== digest(prepared.plan.target)) throw new InfluxDbRestoreError('INFLUXDB_RESTORE_TARGET_CHANGED', 'The alternate InfluxDB target changed after restore admission.', { category: 'integrity' });
      progress = { ...progress, itemsTotal: prepared.members.length, bytesTotal: prepared.totalBytes, phase: 'materializing', updatedAt: this.clock() };
      let lastProgressProjection = this.now(); let projectedItems = 0;
      staging = await this.#materialize(workspaceId, restoreRunId, prepared, signal, async (update) => {
        progress = { ...progress, ...update, updatedAt: this.clock() };
        const currentTime = this.now();
        if (update.itemsCompleted === projectedItems && currentTime - lastProgressProjection < 1000) return;
        const current = await this.controlDatabase.repository('restoreRun').get(workspaceId, restoreRunId);
        if (current?.state === 'preparing') {
          await this.#project(workspaceId, restoreRunId, { progress }, actorId);
          lastProgressProjection = currentTime; projectedItems = update.itemsCompleted;
        }
      });
      const outcome = await this.connectionService.withExecution(workspaceId, prepared.targetConnection, signal, async (context, connection) => {
        const plan = await this.adapter.planRestore(context, { mode: 'alternate', confirmation: RESTORE_CONFIRMATION, connection, source: prepared.sourceEvidence });
        if (digest(plan.target) !== digest(prepared.plan.target)) throw new InfluxDbRestoreError('INFLUXDB_RESTORE_TARGET_CHANGED', 'The alternate InfluxDB target changed before native restore.', { category: 'integrity' });
        const restored = await this.adapter.executeRestore({ ...context, signal, sourceDirectory: staging.nativeDirectory, onMutationStarted: async () => {
          progress = { ...progress, phase: 'restoring', updatedAt: this.clock() };
          const current = await this.controlDatabase.repository('restoreRun').get(workspaceId, restoreRunId);
          await this.#project(workspaceId, restoreRunId, { state: 'running', progress, target: { ...(current.target || {}), nativeMutationStarted: true, mutationStartedAt: this.clock() } }, actorId);
        } }, plan);
        progress = { ...progress, phase: 'validating', itemsCompleted: prepared.members.length, updatedAt: this.clock() };
        await this.#project(workspaceId, restoreRunId, { state: 'validating', progress }, actorId);
        return this.adapter.validateRestore(context, restored);
      });
      await this.#cleanupOwnedDirectory(workspaceId, restoreRunId, staging.directory); staging = null;
      progress = { ...progress, phase: 'complete', updatedAt: this.clock() };
      return this.#project(workspaceId, restoreRunId, { state: 'succeeded', progress, validation: this.#validationRecord(outcome), result: { recoveryPointId: prepared.point.id, organization: outcome.organization, buckets: outcome.buckets, targetPreserved: true, rollbackClaimed: false, warnings: [], completedAt: this.clock() } }, actorId);
    } catch (error) {
      if (staging) await this.#cleanupOwnedDirectory(workspaceId, restoreRunId, staging.directory).catch(() => {});
      const current = await this.controlDatabase.repository('restoreRun').get(workspaceId, restoreRunId);
      if (current && !TERMINAL_STATES.has(current.state)) {
        const canceled = signal.aborted || error?.code === 'INFLUXDB_RESTORE_CANCELED';
        const mutated = current.target?.nativeMutationStarted === true;
        const state = mutated ? 'interrupted' : canceled ? 'canceled' : 'failed';
        const safe = mutated ? { code: 'INFLUXDB_RESTORE_TARGET_REQUIRES_INSPECTION', category: 'restore', retryable: false, safeMessage: 'InfluxDB native restore began but recovery did not finish. The alternate target is preserved for inspection and no rollback is claimed.' } : canceled ? { code: 'INFLUXDB_RESTORE_CANCELED', category: 'canceled', retryable: false, safeMessage: 'The InfluxDB recovery was canceled before native restore began.' } : publicError(error);
        return this.#project(workspaceId, restoreRunId, { state, progress: { ...progress, phase: mutated ? 'operator-action-required' : state, updatedAt: this.clock() }, result: { error: safe, targetPreserved: mutated, rollbackClaimed: false, completedAt: this.clock() } }, actorId);
      }
      throw error;
    }
  }

  async #project(workspaceId, id, changes, actorId) {
    return this.controlDatabase.transaction((transaction) => {
      const current = transaction.get('restoreRun', workspaceId, id);
      return transaction.projectExecution('restoreRun', workspaceId, id, changes, { expectedRevision: current.revision, actorId });
    });
  }
}

module.exports = { InfluxDbRestoreError, InfluxDbRestoreService, METADATA_PATH, NATIVE_PREFIX, RESTORE_CONFIRMATION, RESTORE_OPERATION, normalizeRequest, restorePrefix };
