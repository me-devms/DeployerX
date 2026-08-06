const { ADAPTER_ID } = require('./mongodb');
const { RESTORE_CONFIRMATIONS } = require('./mongodb-restore');

const MODE = 'mongodb-recovery-drill';
const TERMINAL_STATES = new Set(['succeeded', 'warning', 'failed', 'canceled']);
const ACTIVE_STATES = new Set(['queued', 'running', 'interrupted']);
const DEFAULT_TIMEOUT_SECONDS = 3600;
const MINIMUM_TIMEOUT_SECONDS = 30;
const MAXIMUM_TIMEOUT_SECONDS = 86400;

class MongoDbRecoveryDrillError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage);
    this.name = 'MongoDbRecoveryDrillError';
    this.code = code;
    this.category = options.category || 'verification';
    this.retryable = Boolean(options.retryable);
  }
}

function requiredText(value, label, maximumLength = 300) {
  const text = String(value ?? '').trim();
  if (!text || text.includes('\0') || text.length > maximumLength) throw new MongoDbRecoveryDrillError('MONGODB_RECOVERY_DRILL_INPUT_INVALID', `${label} is invalid.`, { category: 'validation' });
  return text;
}

function boundedTimeout(value) {
  const seconds = Number(value ?? DEFAULT_TIMEOUT_SECONDS);
  if (!Number.isInteger(seconds) || seconds < MINIMUM_TIMEOUT_SECONDS || seconds > MAXIMUM_TIMEOUT_SECONDS) throw new MongoDbRecoveryDrillError('MONGODB_RECOVERY_DRILL_TIMEOUT_INVALID', `Recovery drill timeout must be between ${MINIMUM_TIMEOUT_SECONDS} and ${MAXIMUM_TIMEOUT_SECONDS} seconds.`, { category: 'validation' });
  return seconds;
}

function publicError(error) {
  if (error instanceof MongoDbRecoveryDrillError || (error?.code && error?.category)) return {
    code: String(error.code).slice(0, 100), category: String(error.category || 'verification').slice(0, 50),
    retryable: Boolean(error.retryable), safeMessage: String(error.message || 'The MongoDB recovery drill failed.').slice(0, 500)
  };
  return { code: 'MONGODB_RECOVERY_DRILL_FAILED', category: 'verification', retryable: false, safeMessage: 'DeployerX could not complete the MongoDB recovery drill.' };
}

function exactOwner(workspaceId, verificationRunId) {
  return `mongodb-recovery-drill:${workspaceId}:${verificationRunId}`;
}

function requireProvisionedTarget(result, owner, controllerId) {
  if (!result || result.owner !== owner || result.controllerId !== controllerId || !result.leaseId || !result.targetId || !result.targetConnectionId) throw new MongoDbRecoveryDrillError('MONGODB_RECOVERY_DRILL_OWNERSHIP_UNPROVEN', 'The disposable MongoDB target controller did not prove exact lease ownership.', { category: 'authorization' });
  if (result.targetEmpty !== true) throw new MongoDbRecoveryDrillError('MONGODB_RECOVERY_DRILL_TARGET_OCCUPIED', 'The disposable MongoDB recovery target is not empty.', { category: 'conflict' });
  if (result.isolated !== true || result.serviceExposed !== false) throw new MongoDbRecoveryDrillError('MONGODB_RECOVERY_DRILL_TARGET_NOT_ISOLATED', 'The disposable MongoDB recovery target is not isolated from application traffic.', { category: 'authorization' });
  if (!['standalone', 'replica-set'].includes(result.topology)) throw new MongoDbRecoveryDrillError('MONGODB_RECOVERY_DRILL_TARGET_INVALID', 'The disposable recovery target must be a MongoDB standalone or replica set.', { category: 'validation' });
  return {
    controllerId, controllerVersion: String(result.controllerVersion || ''), owner,
    leaseId: requiredText(result.leaseId, 'Controller lease ID', 300), targetId: requiredText(result.targetId, 'Disposable target ID', 300),
    targetConnectionId: requiredText(result.targetConnectionId, 'Disposable target connection ID', 200), topology: result.topology,
    state: 'active', targetEmpty: true, isolated: true, serviceExposed: false, provisionedAt: result.provisionedAt || null
  };
}

function requireDestroyedTarget(result, lease) {
  if (!result || result.owner !== lease.owner || result.leaseId !== lease.leaseId || result.targetId !== lease.targetId || result.destroyed !== true || result.serviceExposed !== false) throw new MongoDbRecoveryDrillError('MONGODB_RECOVERY_DRILL_CLEANUP_UNPROVEN', 'Disposable MongoDB target cleanup could not be proven.', { category: 'cleanup', retryable: true });
  return result;
}

function ownedLeaseForCleanup(result, owner, controllerId) {
  if (!result || result.owner !== owner || result.controllerId !== controllerId || !result.leaseId || !result.targetId) return null;
  return {
    controllerId, controllerVersion: String(result.controllerVersion || ''), owner,
    leaseId: requiredText(result.leaseId, 'Controller lease ID', 300), targetId: requiredText(result.targetId, 'Disposable target ID', 300),
    targetConnectionId: result.targetConnectionId ? requiredText(result.targetConnectionId, 'Disposable target connection ID', 200) : null,
    topology: result.topology || null, state: 'active'
  };
}

class MongoDbRecoveryDrillService {
  constructor({ controlDatabase, restoreService, targetController, deviceId, notificationService = null, clock = () => new Date().toISOString(), now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    if (!controlDatabase || !restoreService || typeof restoreService.start !== 'function' || typeof restoreService.wait !== 'function' || typeof restoreService.cancel !== 'function') throw new TypeError('MongoDB recovery drill control database and restore service are required.');
    if (!targetController || typeof targetController.provision !== 'function' || typeof targetController.inspect !== 'function' || typeof targetController.destroy !== 'function') throw new TypeError('An approved MongoDB disposable target controller is required.');
    this.controlDatabase = controlDatabase;
    this.restoreService = restoreService;
    this.targetController = targetController;
    this.controllerId = requiredText(targetController.id, 'Target controller ID', 200);
    this.deviceId = requiredText(deviceId, 'Device ID', 200);
    this.notificationService = notificationService;
    this.clock = clock;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.active = new Map();
  }

  async start(workspaceId, actorId, input = {}) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const jobId = requiredText(input.jobId, 'Backup Job ID', 200);
    const recoveryPointId = requiredText(input.recoveryPointId, 'Recovery point ID', 200);
    const timeoutSeconds = boundedTimeout(input.timeoutSeconds);
    const [job, point] = await Promise.all([
      this.controlDatabase.repository('backupJob').get(tenant, jobId),
      this.controlDatabase.repository('recoveryPoint').get(tenant, recoveryPointId)
    ]);
    if (!job || !point || point.jobId !== job.id || !['full', 'log'].includes(point.type)) throw new MongoDbRecoveryDrillError('MONGODB_RECOVERY_DRILL_POINT_INVALID', 'Choose a logical MongoDB recovery point owned by this Backup Job.', { category: 'validation' });
    const source = await this.controlDatabase.repository('source').get(tenant, job.sourceId);
    if (!source || source.adapterId !== ADAPTER_ID || source.consistency?.backupMethod !== 'logical') throw new MongoDbRecoveryDrillError('MONGODB_RECOVERY_DRILL_SOURCE_INVALID', 'Scheduled recovery drills currently support MongoDB logical backups only.', { category: 'validation' });
    const duplicateKey = input.triggerBackupRunId ? requiredText(input.triggerBackupRunId, 'Trigger backup Run ID', 200) : null;
    if (duplicateKey) {
      const existing = (await this.controlDatabase.repository('verificationRun').list(tenant, { limit: 1000 })).find((run) => run.mode === MODE && run.triggerBackupRunId === duplicateKey);
      if (existing) return existing;
    }
    const record = await this.controlDatabase.repository('verificationRun').create({
      workspaceId: tenant, actorId: actor, scopeType: 'job', scopeId: job.id, mode: MODE, recoveryPointId: point.id,
      repositoryId: null, triggerBackupRunId: duplicateKey, workerId: `device:${this.deviceId}`, state: 'queued', timeoutSeconds,
      controller: { id: this.controllerId, version: String(this.targetController.version || '') }, lease: null, restoreRunId: null,
      progress: { phase: 'queued', startedAt: null, updatedAt: this.clock() }, measuredRtoSeconds: null, evidence: null, result: null
    });
    const controller = new AbortController();
    const operation = this.#execute(tenant, actor, record.id, { job, source, point, timeoutSeconds }, controller).catch(() => this.controlDatabase.repository('verificationRun').get(tenant, record.id));
    this.active.set(record.id, { controller, operation, restoreRunId: null });
    operation.finally(() => this.active.delete(record.id));
    return record;
  }

  async dispatchScheduled(workspaceId, actorId = 'backup-worker') {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const [jobs, policies, sources, runs, points, verifications] = await Promise.all([
      this.controlDatabase.repository('backupJob').list(tenant, { limit: 1000 }),
      this.controlDatabase.repository('policy').list(tenant, { limit: 1000 }),
      this.controlDatabase.repository('source').list(tenant, { limit: 1000 }),
      this.controlDatabase.repository('run').list(tenant, { limit: 1000 }),
      this.controlDatabase.repository('recoveryPoint').list(tenant, { limit: 1000 }),
      this.controlDatabase.repository('verificationRun').list(tenant, { limit: 1000 })
    ]);
    if (verifications.some((run) => run.mode === MODE && ['queued', 'running', 'interrupted'].includes(run.state))) return [];
    const policyById = new Map(policies.map((policy) => [policy.id, policy]));
    const sourceById = new Map(sources.map((source) => [source.id, source]));
    const alreadyDispatched = new Set(verifications.filter((run) => run.mode === MODE && run.triggerBackupRunId).map((run) => run.triggerBackupRunId));
    const candidates = [];
    for (const job of jobs) {
      const policy = policyById.get(job.policyId);
      const source = sourceById.get(job.sourceId);
      if (job.state !== 'enabled' || !policy?.enabled || policy.verification?.fullRecoveryTest !== true || source?.adapterId !== ADAPTER_ID || source.consistency?.backupMethod !== 'logical') continue;
      const successfulRuns = runs.filter((run) => run.jobId === job.id && ['succeeded', 'warning'].includes(run.state) && !alreadyDispatched.has(run.id)).sort((left, right) => Date.parse(right.finishedAt || right.updatedAt || 0) - Date.parse(left.finishedAt || left.updatedAt || 0));
      for (const run of successfulRuns) {
        const terminal = points.filter((point) => point.jobId === job.id && point.runId === run.id && ['full', 'log'].includes(point.type)).sort((left, right) => Date.parse(right.capturedTo || right.updatedAt || 0) - Date.parse(left.capturedTo || left.updatedAt || 0))[0];
        if (terminal) candidates.push({ job, policy, run, point: terminal });
      }
    }
    candidates.sort((left, right) => Date.parse(left.run.finishedAt || left.run.updatedAt || 0) - Date.parse(right.run.finishedAt || right.run.updatedAt || 0));
    const candidate = candidates[0];
    if (!candidate) return [];
    return [await this.start(tenant, actor, { jobId: candidate.job.id, recoveryPointId: candidate.point.id, triggerBackupRunId: candidate.run.id, timeoutSeconds: candidate.policy.verification?.timeoutSeconds })];
  }

  async wait(workspaceId, verificationRunId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const id = requiredText(verificationRunId, 'Verification Run ID', 200);
    if (this.active.has(id)) await this.active.get(id).operation;
    const record = await this.controlDatabase.repository('verificationRun').get(tenant, id);
    if (!record || record.mode !== MODE) throw new MongoDbRecoveryDrillError('MONGODB_RECOVERY_DRILL_NOT_FOUND', 'The MongoDB recovery drill was not found.', { category: 'not-found' });
    return record;
  }

  async cancel(workspaceId, actorId, verificationRunId) {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    requiredText(actorId, 'Actor ID', 200);
    const id = requiredText(verificationRunId, 'Verification Run ID', 200);
    const record = await this.controlDatabase.repository('verificationRun').get(tenant, id);
    if (!record || record.mode !== MODE) throw new MongoDbRecoveryDrillError('MONGODB_RECOVERY_DRILL_NOT_FOUND', 'The MongoDB recovery drill was not found.', { category: 'not-found' });
    if (TERMINAL_STATES.has(record.state)) return record;
    const active = this.active.get(id);
    if (!active) throw new MongoDbRecoveryDrillError('MONGODB_RECOVERY_DRILL_NOT_ACTIVE', 'The MongoDB recovery drill is not active in this DeployerX process.', { category: 'conflict' });
    active.controller.abort(new MongoDbRecoveryDrillError('MONGODB_RECOVERY_DRILL_CANCELED', 'The MongoDB recovery drill was canceled.', { category: 'canceled' }));
    if (active.restoreRunId) await this.restoreService.cancel(tenant, actorId, active.restoreRunId).catch(() => {});
    await active.operation;
    return this.controlDatabase.repository('verificationRun').get(tenant, id);
  }

  async list(workspaceId, options = {}) {
    const records = await this.controlDatabase.repository('verificationRun').list(requiredText(workspaceId, 'Workspace ID', 200), { limit: Math.min(1000, Math.max(1, Number(options.limit) || 100)) });
    return records.filter((record) => record.mode === MODE && (!options.jobId || record.scopeId === options.jobId));
  }

  async reconcile(workspaceId, actorId = 'system') {
    const tenant = requiredText(workspaceId, 'Workspace ID', 200);
    const actor = requiredText(actorId, 'Actor ID', 200);
    const records = (await this.list(tenant, { limit: 1000 })).filter((record) => ACTIVE_STATES.has(record.state) && !this.active.has(record.id));
    const reconciled = [];
    for (const record of records) {
      const owner = exactOwner(tenant, record.id);
      try {
        const inspected = await this.targetController.inspect({ workspaceId: tenant, owner, leaseId: record.lease?.leaseId || null, targetId: record.lease?.targetId || null });
        if (inspected?.exists) {
          const lease = ownedLeaseForCleanup({ ...inspected, targetConnectionId: inspected.targetConnectionId || record.lease?.targetConnectionId }, owner, this.controllerId);
          if (!lease) throw new MongoDbRecoveryDrillError('MONGODB_RECOVERY_DRILL_OWNERSHIP_UNPROVEN', 'Disposable MongoDB target ownership could not be proven. No cleanup was attempted.', { category: 'authorization' });
          const destroyed = await this.targetController.destroy({ workspaceId: tenant, owner, leaseId: lease.leaseId, targetId: lease.targetId, signal: new AbortController().signal });
          requireDestroyedTarget(destroyed, lease);
        } else if (inspected?.owner && inspected.owner !== owner) {
          throw new MongoDbRecoveryDrillError('MONGODB_RECOVERY_DRILL_OWNERSHIP_UNPROVEN', 'A disposable target exists under another owner. No cleanup was attempted.', { category: 'authorization' });
        }
        reconciled.push(await this.#project(tenant, record.id, {
          state: 'failed', completedAt: this.clock(), progress: { ...(record.progress || {}), phase: 'failed', updatedAt: this.clock() },
          lease: record.lease ? { ...record.lease, state: 'destroyed', destroyedAt: this.clock() } : null,
          result: { state: 'failed', error: { code: 'MONGODB_RECOVERY_DRILL_PROCESS_INTERRUPTED', category: 'verification', retryable: true, safeMessage: 'The DeployerX process stopped before the MongoDB recovery drill completed; the exact-owned disposable target was removed.' }, completedAt: this.clock() }
        }, actor));
      } catch (error) {
        reconciled.push(await this.#interrupt(tenant, actor, record, error));
      }
    }
    return reconciled;
  }

  async #execute(workspaceId, actorId, verificationRunId, input, abortController) {
    const owner = exactOwner(workspaceId, verificationRunId);
    const startedMs = this.now();
    let lease = null;
    let restoreRunId = null;
    let cleanupError = null;
    let completedRestore = null;
    let provisionAttempted = false;
    let provisionReturned = false;
    const timeoutError = new MongoDbRecoveryDrillError('MONGODB_RECOVERY_DRILL_TIMED_OUT', 'The MongoDB recovery drill exceeded its configured timeout.', { category: 'timeout', retryable: true });
    const timer = this.setTimer(() => abortController.abort(timeoutError), input.timeoutSeconds * 1000);
    try {
      await this.#project(workspaceId, verificationRunId, { state: 'running', startedAt: this.clock(), progress: { phase: 'provisioning', startedAt: this.clock(), updatedAt: this.clock() }, lease: { controllerId: this.controllerId, owner, state: 'acquiring' } }, actorId);
      provisionAttempted = true;
      const provisioned = await this.#abortable(abortController.signal, this.targetController.provision({
        workspaceId, actorId, owner, jobId: input.job.id, sourceId: input.source.id, recoveryPointId: input.point.id,
        sourceConnectionId: input.source.connectionId, timeoutSeconds: input.timeoutSeconds, signal: abortController.signal
      }));
      provisionReturned = true;
      lease = ownedLeaseForCleanup(provisioned, owner, this.controllerId);
      lease = requireProvisionedTarget(provisioned, owner, this.controllerId);
      const targetConnection = await this.controlDatabase.repository('connection').get(workspaceId, lease.targetConnectionId);
      if (!targetConnection || targetConnection.adapterId !== ADAPTER_ID || !(targetConnection.workerAffinity || []).includes(`device:${this.deviceId}`) || targetConnection.lastTest?.status !== 'success' || !targetConnection.trust?.fingerprint) throw new MongoDbRecoveryDrillError('MONGODB_RECOVERY_DRILL_CONNECTION_INVALID', 'The disposable target controller did not provide a tested current-device MongoDB connection.', { category: 'connectivity' });
      await this.#project(workspaceId, verificationRunId, { lease, progress: { phase: 'restoring', startedAt: this.clock(), updatedAt: this.clock() } }, actorId);
      const startedRestore = await this.restoreService.start(workspaceId, actorId, {
        recoveryPointId: input.point.id, mode: 'alternate', targetConnectionId: lease.targetConnectionId, conflictPolicy: 'fail', stop: { type: 'latest' },
        confirmed: true, confirmationText: RESTORE_CONFIRMATIONS.alternate
      });
      restoreRunId = startedRestore.id;
      const active = this.active.get(verificationRunId);
      if (active) active.restoreRunId = restoreRunId;
      await this.#project(workspaceId, verificationRunId, { restoreRunId, progress: { phase: 'restoring', startedAt: this.clock(), updatedAt: this.clock() } }, actorId);
      completedRestore = await this.#abortable(abortController.signal, this.restoreService.wait(workspaceId, restoreRunId));
      if (!['succeeded', 'warning'].includes(completedRestore?.state) || completedRestore.validation?.expectedObjects !== 'pass' || completedRestore.validation?.nativeIntegrityValidation !== true) throw new MongoDbRecoveryDrillError('MONGODB_RECOVERY_DRILL_VALIDATION_FAILED', 'The disposable MongoDB recovery did not pass collection, index, UUID, and native integrity validation.', { category: 'integrity' });
      const isolation = await this.#abortable(abortController.signal, this.targetController.inspect({ workspaceId, owner, leaseId: lease.leaseId, targetId: lease.targetId, signal: abortController.signal }));
      if (!isolation?.exists || isolation.owner !== owner || isolation.isolated !== true || isolation.serviceExposed !== false) throw new MongoDbRecoveryDrillError('MONGODB_RECOVERY_DRILL_TARGET_EXPOSED', 'The disposable MongoDB recovery target did not remain isolated during validation.', { category: 'authorization' });
    } catch (error) {
      if (restoreRunId && abortController.signal.aborted) await this.restoreService.cancel(workspaceId, actorId, restoreRunId).catch(() => {});
      completedRestore = { error: abortController.signal.reason || error };
    } finally {
      this.clearTimer(timer);
      if (lease) {
        try {
          const destroyed = await this.targetController.destroy({ workspaceId, owner, leaseId: lease.leaseId, targetId: lease.targetId, signal: new AbortController().signal });
          requireDestroyedTarget(destroyed, lease);
          lease = { ...lease, state: 'destroyed', destroyedAt: this.clock() };
        } catch (error) { cleanupError = error; }
      } else if (provisionAttempted && !provisionReturned && !cleanupError) {
        cleanupError = new MongoDbRecoveryDrillError('MONGODB_RECOVERY_DRILL_CLEANUP_UNPROVEN', 'Disposable MongoDB target creation was interrupted before ownership and cleanup could be proven.', { category: 'cleanup', retryable: true });
      }
    }
    const current = await this.controlDatabase.repository('verificationRun').get(workspaceId, verificationRunId);
    if (cleanupError) return this.#interrupt(workspaceId, actorId, { ...current, lease: lease || current.lease }, cleanupError);
    if (completedRestore?.error) {
      const error = completedRestore.error;
      const canceled = error?.code === 'MONGODB_RECOVERY_DRILL_CANCELED' || error?.category === 'canceled';
      const failed = await this.#project(workspaceId, verificationRunId, {
        state: canceled ? 'canceled' : 'failed', completedAt: this.clock(), lease,
        progress: { ...(current.progress || {}), phase: canceled ? 'canceled' : 'failed', updatedAt: this.clock() },
        result: { state: canceled ? 'canceled' : 'failed', error: publicError(error), restoreRunId, completedAt: this.clock() }
      }, actorId);
      await this.#notify(workspaceId, failed);
      return failed;
    }
    const measuredRtoSeconds = Math.max(0, Math.ceil((this.now() - startedMs) / 1000));
    const succeeded = await this.#project(workspaceId, verificationRunId, {
      state: 'succeeded', completedAt: this.clock(), measuredRtoSeconds, lease,
      progress: { ...(current.progress || {}), phase: 'complete', updatedAt: this.clock() },
      evidence: { isolated: true, serviceExposed: false, targetDestroyed: true, topology: lease.topology, expectedObjects: 'pass', nativeIntegrityValidation: true, recoveryTarget: completedRestore.result?.recoveryTarget || null },
      result: { state: 'succeeded', restoreRunId, recoveryPointId: input.point.id, measuredRtoSeconds, completedAt: this.clock() }
    }, actorId);
    await this.#notify(workspaceId, succeeded);
    return succeeded;
  }

  async #abortable(signal, promise) {
    if (signal.aborted) throw signal.reason;
    let listener;
    const aborted = new Promise((_resolve, reject) => { listener = () => reject(signal.reason); signal.addEventListener('abort', listener, { once: true }); });
    try { return await Promise.race([promise, aborted]); } finally { signal.removeEventListener('abort', listener); }
  }

  async #interrupt(workspaceId, actorId, record, error) {
    const interrupted = await this.#project(workspaceId, record.id, {
      state: 'interrupted', completedAt: null, progress: { ...(record.progress || {}), phase: 'operator-action-required', updatedAt: this.clock() },
      result: { state: 'interrupted', cleanupUncertain: true, error: publicError(error), completedAt: null }
    }, actorId);
    await this.#notify(workspaceId, interrupted);
    return interrupted;
  }

  async #project(workspaceId, verificationRunId, changes, actorId) {
    return this.controlDatabase.transaction((transaction) => {
      const current = transaction.get('verificationRun', workspaceId, verificationRunId);
      return transaction.projectExecution('verificationRun', workspaceId, verificationRunId, changes, { expectedRevision: current.revision, actorId });
    });
  }

  async #notify(workspaceId, run) {
    if (!this.notificationService || !['succeeded', 'warning', 'failed', 'interrupted'].includes(run?.state)) return;
    await this.notificationService.notifyVerificationRun(workspaceId, run).catch(() => {});
  }
}

module.exports = {
  DEFAULT_TIMEOUT_SECONDS, MAXIMUM_TIMEOUT_SECONDS, MINIMUM_TIMEOUT_SECONDS, MODE,
  MongoDbRecoveryDrillError, MongoDbRecoveryDrillService, boundedTimeout, exactOwner, ownedLeaseForCleanup, requireDestroyedTarget, requireProvisionedTarget
};
