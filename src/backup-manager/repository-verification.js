const crypto = require('crypto');

const MODES = new Set(['checksum', 'sample-restore']);
const MAX_RECOVERY_POINTS = 1000;
const MAX_SAMPLE_FILES = 1000;

class RepositoryVerificationError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'RepositoryVerificationError';
    this.code = code;
    this.category = options.category || 'verification';
    this.retryable = Boolean(options.retryable);
  }
}

function requiredText(value, label, maximumLength = 300) {
  const text = String(value ?? '').trim();
  if (!text || text.includes('\0') || text.length > maximumLength) throw new RepositoryVerificationError('VERIFICATION_INPUT_INVALID', `${label} is invalid.`, { category: 'validation' });
  return text;
}

function boundedInteger(value, fallback, minimum, maximum, label) {
  const number = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) throw new RepositoryVerificationError('VERIFICATION_INPUT_INVALID', `${label} must be between ${minimum} and ${maximum}.`, { category: 'validation' });
  return number;
}

function normalizeRequest(input = {}) {
  const mode = String(input.mode || 'sample-restore');
  if (!MODES.has(mode)) throw new RepositoryVerificationError('VERIFICATION_MODE_INVALID', 'Verification mode is invalid.', { category: 'validation' });
  if (mode === 'checksum') {
    return { mode, repositoryId: requiredText(input.repositoryId, 'Repository ID', 200), recoveryPointId: null, samplePercent: null, minimumFiles: null, maximumFiles: null };
  }
  const request = {
    mode,
    repositoryId: input.repositoryId ? requiredText(input.repositoryId, 'Repository ID', 200) : null,
    recoveryPointId: requiredText(input.recoveryPointId, 'Recovery point ID', 200),
    samplePercent: boundedInteger(input.samplePercent, 10, 1, 100, 'Sample percentage'),
    minimumFiles: boundedInteger(input.minimumFiles, 1, 1, MAX_SAMPLE_FILES, 'Minimum sample files'),
    maximumFiles: boundedInteger(input.maximumFiles, MAX_SAMPLE_FILES, 1, MAX_SAMPLE_FILES, 'Maximum sample files')
  };
  if (request.minimumFiles > request.maximumFiles) throw new RepositoryVerificationError('VERIFICATION_INPUT_INVALID', 'Minimum sample files cannot exceed the maximum.', { category: 'validation' });
  return request;
}

function sampleFiles(recoveryPointId, files, policy) {
  if (!files.length) return [];
  const count = Math.min(
    files.length,
    policy.maximumFiles,
    Math.max(policy.minimumFiles, Math.ceil(files.length * policy.samplePercent / 100))
  );
  return files.map((entry) => ({
    entry,
    score: crypto.createHash('sha256').update(`${recoveryPointId}\0${entry.path}`).digest('hex')
  })).sort((left, right) => left.score.localeCompare(right.score, 'en-US')).slice(0, count).map((item) => item.entry);
}

function safeBaseName(value) {
  return String(value || '').replace(/\\/g, '/').split('/').filter(Boolean).pop() || 'file';
}

function publicError(error) {
  if (error instanceof RepositoryVerificationError) return { code: error.code, category: error.category, retryable: error.retryable, safeMessage: error.message };
  const code = String(error?.code || 'VERIFICATION_FAILED');
  const known = code.startsWith('REPOSITORY_') || code.startsWith('SNAPSHOT_');
  return {
    code: known ? code : 'VERIFICATION_FAILED',
    category: known ? String(error.category || 'integrity') : 'verification',
    retryable: Boolean(known && error.retryable),
    safeMessage: known ? String(error.message || 'Repository verification failed.') : 'DeployerX could not complete repository verification.'
  };
}

class RepositoryVerificationService {
  constructor({ controlDatabase, snapshotBrowser, deviceId, notificationService = null, clock } = {}) {
    if (!controlDatabase || !snapshotBrowser || !deviceId) throw new TypeError('Control database, snapshot browser, and device ID are required.');
    this.controlDatabase = controlDatabase;
    this.snapshotBrowser = snapshotBrowser;
    this.deviceId = requiredText(deviceId, 'Device ID', 200);
    this.notificationService = notificationService;
    this.clock = clock || (() => new Date().toISOString());
    this.active = new Map();
  }

  async start(workspaceId, actorId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const request = normalizeRequest(input);
    const scopeType = request.mode === 'checksum' ? 'repository' : 'recovery-point';
    const scopeId = request.mode === 'checksum' ? request.repositoryId : request.recoveryPointId;
    const record = await this.controlDatabase.repository('verificationRun').create({
      workspaceId: tenant,
      actorId: actor,
      scopeType,
      scopeId,
      mode: request.mode,
      recoveryPointId: request.recoveryPointId,
      repositoryId: request.repositoryId,
      workerId: `device:${this.deviceId}`,
      state: 'queued',
      samplePolicy: request.mode === 'sample-restore' ? { samplePercent: request.samplePercent, minimumFiles: request.minimumFiles, maximumFiles: request.maximumFiles, selection: 'sha256-ranked-paths' } : null,
      progress: { phase: 'queued', recoveryPointsTotal: 0, recoveryPointsVerified: 0, filesTotal: 0, filesVerified: 0, bytesVerified: 0, currentFile: null, startedAt: null, updatedAt: this.clock() },
      result: null
    });
    const operation = this.#execute(tenant, actor, record.id, request).catch(() => this.controlDatabase.repository('verificationRun').get(tenant, record.id));
    this.active.set(record.id, operation);
    operation.finally(() => this.active.delete(record.id));
    return record;
  }

  async wait(workspaceId, verificationRunId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const id = requiredText(verificationRunId, 'Verification run ID', 200);
    if (this.active.has(id)) await this.active.get(id);
    const record = await this.controlDatabase.repository('verificationRun').get(tenant, id);
    if (!record) throw new RepositoryVerificationError('VERIFICATION_RUN_NOT_FOUND', 'The verification run was not found.', { category: 'not-found' });
    return record;
  }

  async list(workspaceId, options = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const records = await this.controlDatabase.repository('verificationRun').list(tenant, { limit: Math.min(1000, Math.max(1, Number(options.limit) || 100)) });
    return records.filter((record) => (!options.recoveryPointId || record.recoveryPointId === options.recoveryPointId)
      && (!options.repositoryId || record.repositoryId === options.repositoryId));
  }

  async reconcile(workspaceId, actorId = 'system') {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const records = await this.controlDatabase.repository('verificationRun').list(tenant, { limit: 1000 });
    const abandoned = records.filter((record) => MODES.has(record.mode) && ['queued', 'running'].includes(record.state) && !this.active.has(record.id));
    const reconciled = [];
    for (const record of abandoned) {
      const projected = await this.#project(tenant, record.id, {
        state: 'failed',
        progress: { ...(record.progress || {}), phase: 'failed', currentFile: null, updatedAt: this.clock() },
        result: { error: { code: 'VERIFICATION_PROCESS_INTERRUPTED', category: 'verification', retryable: true, safeMessage: 'The DeployerX process stopped before verification completed.' }, completedAt: this.clock() }
      }, actor);
      reconciled.push(projected);
      await this.#notify(tenant, projected);
    }
    return reconciled;
  }

  async #project(workspaceId, verificationRunId, changes, actorId) {
    return this.controlDatabase.transaction((transaction) => {
      const current = transaction.get('verificationRun', workspaceId, verificationRunId);
      return transaction.projectExecution('verificationRun', workspaceId, verificationRunId, changes, { expectedRevision: current.revision, actorId });
    });
  }

  async #notify(workspaceId, run) {
    if (!this.notificationService || !['succeeded', 'warning', 'failed'].includes(run?.state)) return;
    await this.notificationService.notifyVerificationRun(workspaceId, run).catch(() => {});
  }

  async #execute(workspaceId, actorId, verificationRunId, request) {
    let progress = { phase: 'running', recoveryPointsTotal: 0, recoveryPointsVerified: 0, filesTotal: 0, filesVerified: 0, bytesVerified: 0, currentFile: null, startedAt: this.clock(), updatedAt: this.clock() };
    try {
      await this.#project(workspaceId, verificationRunId, { state: 'running', startedAt: progress.startedAt, progress }, actorId);
      const evidence = crypto.createHash('sha256');
      let warnings = [];
      if (request.mode === 'checksum') {
        const repository = await this.controlDatabase.repository('repository').get(workspaceId, request.repositoryId);
        if (!repository) throw new RepositoryVerificationError('VERIFICATION_REPOSITORY_NOT_FOUND', 'The backup repository was not found.', { category: 'not-found' });
        if (!(repository.workerAffinity || []).includes(`device:${this.deviceId}`)) throw new RepositoryVerificationError('VERIFICATION_REPOSITORY_DEVICE_MISMATCH', 'This repository belongs to another DeployerX device.', { category: 'authorization' });
        if (repository.health?.status !== 'ready' || repository.health?.lockState?.status === 'unavailable') throw new RepositoryVerificationError('VERIFICATION_REPOSITORY_NOT_READY', 'Test the repository successfully before verification.', { category: 'repository', retryable: true });
        const catalog = await this.controlDatabase.repository('recoveryPoint').list(workspaceId, { limit: MAX_RECOVERY_POINTS });
        if (catalog.length === MAX_RECOVERY_POINTS) warnings.push({ code: 'VERIFICATION_CATALOG_LIMIT_REACHED', safeMessage: `Verification is bounded to the newest ${MAX_RECOVERY_POINTS} recovery points.` });
        const points = catalog
          .filter((point) => (point.repositoryCopies || []).some((copy) => copy.repositoryId === request.repositoryId && copy.state === 'available'));
        progress.recoveryPointsTotal = points.length;
        if (!points.length) warnings.push({ code: 'VERIFICATION_REPOSITORY_EMPTY', safeMessage: 'This repository has no available recovery points to verify.' });
        for (const point of points) {
          const opened = await this.snapshotBrowser.openAuthenticatedSnapshot(workspaceId, point.id, { repositoryId: request.repositoryId });
          const files = (opened.manifest.files || []).filter((entry) => entry.type === 'file');
          progress.filesTotal += files.length;
          evidence.update(`${point.id}\0${opened.summary.manifestChecksum?.digest || ''}\0`);
          for (const entry of files) await this.#verifyFile(opened, entry, progress, evidence, workspaceId, verificationRunId, actorId);
          progress.recoveryPointsVerified += 1;
          progress.updatedAt = this.clock();
          await this.#project(workspaceId, verificationRunId, { progress: { ...progress } }, actorId);
        }
      } else {
        const opened = await this.snapshotBrowser.openAuthenticatedSnapshot(workspaceId, request.recoveryPointId, { repositoryId: request.repositoryId });
        const files = (opened.manifest.files || []).filter((entry) => entry.type === 'file');
        const selected = sampleFiles(request.recoveryPointId, files, request);
        progress.recoveryPointsTotal = 1;
        progress.filesTotal = selected.length;
        evidence.update(`${opened.point.id}\0${opened.copy.repositoryId}\0${opened.summary.manifestChecksum?.digest || ''}\0`);
        for (const entry of selected) await this.#verifyFile(opened, entry, progress, evidence, workspaceId, verificationRunId, actorId);
        progress.recoveryPointsVerified = 1;
        if (!files.length) warnings.push({ code: 'VERIFICATION_POINT_HAS_NO_FILES', safeMessage: 'This recovery point has no files to sample.' });
      }
      progress = { ...progress, phase: 'complete', currentFile: null, updatedAt: this.clock() };
      const state = warnings.length ? 'warning' : 'succeeded';
      const completed = await this.#project(workspaceId, verificationRunId, {
        state,
        completedAt: this.clock(),
        progress,
        result: {
          state,
          mode: request.mode,
          repositoryId: request.repositoryId,
          recoveryPointsVerified: progress.recoveryPointsVerified,
          filesVerified: progress.filesVerified,
          bytesVerified: progress.bytesVerified,
          evidenceDigest: { algorithm: 'sha256', digest: evidence.digest('hex') },
          warnings,
          completedAt: this.clock()
        }
      }, actorId);
      await this.#notify(workspaceId, completed);
      return completed;
    } catch (error) {
      const current = await this.controlDatabase.repository('verificationRun').get(workspaceId, verificationRunId);
      if (current && !['succeeded', 'warning', 'failed', 'canceled'].includes(current.state)) {
        const failed = await this.#project(workspaceId, verificationRunId, {
          state: 'failed',
          completedAt: this.clock(),
          progress: { ...progress, phase: 'failed', currentFile: null, updatedAt: this.clock() },
          result: { state: 'failed', error: publicError(error), completedAt: this.clock() }
        }, actorId);
        await this.#notify(workspaceId, failed);
        return failed;
      }
      throw error;
    }
  }

  async #verifyFile(opened, entry, progress, evidence, workspaceId, verificationRunId, actorId) {
    progress.currentFile = safeBaseName(entry.path);
    let bytes = 0;
    for await (const chunk of opened.engine.streamFile({}, { repositoryId: opened.copy.repositoryId, manifest: opened.manifest, path: entry.path, masterKey: opened.masterKey })) bytes += chunk.length;
    if (bytes !== Number(entry.sizeBytes)) throw new RepositoryVerificationError('VERIFICATION_BYTE_COUNT_MISMATCH', 'A verified file did not match its recorded size.', { category: 'integrity' });
    progress.filesVerified += 1;
    progress.bytesVerified += bytes;
    progress.updatedAt = this.clock();
    evidence.update(`${crypto.createHash('sha256').update(entry.path).digest('hex')}\0${bytes}\0${entry.contentDigest?.digest || ''}\0`);
    await this.#project(workspaceId, verificationRunId, { progress: { ...progress } }, actorId);
  }
}

module.exports = {
  MAX_RECOVERY_POINTS,
  MAX_SAMPLE_FILES,
  RepositoryVerificationError,
  RepositoryVerificationService,
  normalizeRequest,
  sampleFiles
};
