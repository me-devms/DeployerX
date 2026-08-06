const crypto = require('crypto');
const { NONTERMINAL_RUN_STATES, TERMINAL_RUN_STATES } = require('./manual-backup');
const { calculateRetrySchedule, normalizeRetryPolicy, priorityRank } = require('./execution-policy');
const { BackupScheduleError, nextOccurrence } = require('./schedule');
const { evaluateExecutionCalendar, evaluateMissedRun } = require('./schedule-policy');

const WORKER_PROTOCOL_VERSION = 1;
const DEFAULT_POLL_INTERVAL_MS = 15000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10000;
const DISPATCH_FAILURE_RETRY_MS = 60000;
const MAXIMUM_RETRY_ATTEMPTS = 10;

class ScheduledBackupWorkerError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'ScheduledBackupWorkerError';
    this.code = code;
    this.category = options.category || 'worker';
    this.retryable = Boolean(options.retryable);
  }
}

function requiredText(value, label, maximumLength = 300) {
  const text = String(value ?? '').trim();
  if (!text || text.includes('\0') || text.length > maximumLength) throw new TypeError(`${label} is required.`);
  return text;
}

function isoTime(value, label) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new ScheduledBackupWorkerError('BACKUP_SCHEDULE_TIME_INVALID', `${label} is invalid.`, { category: 'validation' });
  return date.toISOString();
}

function boundedAttempts(policy) {
  const attempts = Number(policy?.retry?.maximumAttempts ?? 3);
  if (!Number.isInteger(attempts)) return 3;
  return Math.max(1, Math.min(MAXIMUM_RETRY_ATTEMPTS, attempts));
}

function safeDispatchFailure(error, clock) {
  const known = new Set(['ManualBackupError', 'FileSourceReaderError', 'RepositoryEngineError', 'RepositoryLockError', 'LocalRepositoryError', 'SftpRepositoryError', 'S3RepositoryError', 'RunCheckpointError']);
  return {
    safeErrorCode: /^[A-Z][A-Z0-9_]{2,127}$/.test(String(error?.code || '')) ? error.code : 'BACKUP_SCHEDULE_DISPATCH_FAILED',
    safeMessage: known.has(error?.name) ? String(error.message).slice(0, 300) : 'The scheduled backup could not be dispatched.',
    category: String(error?.category || 'worker').slice(0, 80),
    retryable: error?.retryable !== false,
    failedAt: clock()
  };
}

function effectiveJobDispatchTime(job) {
  const scheduledAt = Date.parse(job?.nextRunAt || '');
  if (!Number.isFinite(scheduledAt)) return null;
  const dispatchAt = Date.parse(job?.scheduleState?.nextDispatchAttemptAt || '');
  return new Date(Number.isFinite(dispatchAt) ? Math.max(scheduledAt, dispatchAt) : scheduledAt).toISOString();
}

class ScheduledBackupWorkerService {
  constructor({
    controlDatabase,
    manualBackupService,
    recoveryDrillService = null,
    notificationService = null,
    deviceId,
    clock = () => new Date().toISOString(),
    now = () => Date.now(),
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
    maximumConcurrentRuns = 2,
    autoTimers = true,
    randomUUID = crypto.randomUUID
  } = {}) {
    if (!controlDatabase || !manualBackupService) throw new TypeError('Control database and manual backup service are required.');
    this.controlDatabase = controlDatabase;
    this.manualBackupService = manualBackupService;
    this.recoveryDrillService = recoveryDrillService;
    this.notificationService = notificationService;
    this.deviceId = requiredText(deviceId, 'Device ID', 200);
    this.workerId = `device:${this.deviceId}`;
    this.workerGeneration = `process:${process.pid}:${randomUUID()}`;
    this.clock = clock;
    this.now = now;
    this.pollIntervalMs = Number(pollIntervalMs);
    this.heartbeatIntervalMs = Number(heartbeatIntervalMs);
    this.maximumConcurrentRuns = Number(maximumConcurrentRuns);
    this.autoTimers = Boolean(autoTimers);
    if (!Number.isInteger(this.pollIntervalMs) || this.pollIntervalMs < 1000 || this.pollIntervalMs > 300000) throw new TypeError('Worker poll interval is invalid.');
    if (!Number.isInteger(this.heartbeatIntervalMs) || this.heartbeatIntervalMs < 1000 || this.heartbeatIntervalMs > 300000) throw new TypeError('Worker heartbeat interval is invalid.');
    if (!Number.isInteger(this.maximumConcurrentRuns) || this.maximumConcurrentRuns < 1 || this.maximumConcurrentRuns > 16) throw new TypeError('Worker concurrency is invalid.');
    this.workspaceId = null;
    this.actorId = null;
    this.registration = null;
    this.pollTimer = null;
    this.heartbeatTimer = null;
    this.tickPromise = null;
    this.draining = false;
    this.activeRuns = new Map();
    this.activeRunJobs = new Map();
  }

  async start(workspaceId, actorId = 'backup-worker') {
    if (this.workspaceId) return this.status();
    this.workspaceId = requiredText(workspaceId, 'Workspace ID', 200);
    this.actorId = requiredText(actorId, 'Actor ID', 200);
    this.draining = false;
    await this.#register('online');
    await this.tick();
    if (this.autoTimers) {
      this.pollTimer = setInterval(() => this.tick().catch(() => {}), this.pollIntervalMs);
      this.heartbeatTimer = setInterval(() => this.#heartbeat().catch(() => {}), this.heartbeatIntervalMs);
    }
    return this.status();
  }

  async stop(options = {}) {
    this.draining = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.pollTimer = null;
    this.heartbeatTimer = null;
    if (options.drain !== false) await Promise.allSettled([...this.activeRuns.values()]);
    if (this.workspaceId) await this.#register('offline').catch(() => {});
    const status = this.status();
    this.workspaceId = null;
    this.actorId = null;
    return status;
  }

  status() {
    return {
      protocolVersion: WORKER_PROTOCOL_VERSION,
      workerId: this.workerId,
      workerGeneration: this.workerGeneration,
      deviceId: this.deviceId,
      workspaceId: this.workspaceId,
      state: !this.workspaceId ? 'offline' : this.draining ? 'draining' : 'online',
      activeRunIds: [...this.activeRuns.keys()],
      availableRunSlots: Math.max(0, this.maximumConcurrentRuns - this.activeRuns.size),
      lastHeartbeatAt: this.registration?.heartbeatAt || null,
      lastTickAt: this.registration?.lastTickAt || null
    };
  }

  tick() {
    if (!this.workspaceId || this.draining) return Promise.resolve(this.status());
    if (this.tickPromise) return this.tickPromise;
    this.tickPromise = this.#tick().finally(() => { this.tickPromise = null; });
    return this.tickPromise;
  }

  async #tick() {
    await this.#heartbeat({ lastTickAt: this.clock() });
    await this.manualBackupService.reconcile(this.workspaceId, this.actorId);
    if (this.recoveryDrillService) {
      await this.recoveryDrillService.reconcile(this.workspaceId, this.actorId).catch(() => []);
      await this.recoveryDrillService.dispatchScheduled(this.workspaceId, this.actorId).catch(() => []);
    }
    await this.notificationService?.evaluateOverdueRpo(this.workspaceId).catch(() => {});
    const attempted = new Set();
    while (true) {
      const [jobs, policies, persistedRuns, groups] = await Promise.all([
        this.controlDatabase.repository('backupJob').list(this.workspaceId, { limit: 1000 }),
        this.controlDatabase.repository('policy').list(this.workspaceId, { limit: 1000 }),
        this.controlDatabase.repository('run').list(this.workspaceId, { limit: 1000 }),
        this.controlDatabase.repository('executionGroup').list(this.workspaceId, { limit: 1000 })
      ]);
      const persistedActive = persistedRuns.filter((run) => NONTERMINAL_RUN_STATES.has(run.state));
      const occupiedRunIds = new Set([...persistedActive.map((run) => run.id), ...this.activeRuns.keys()]);
      if (occupiedRunIds.size >= this.maximumConcurrentRuns) break;
      const policyById = new Map(policies.map((policy) => [policy.id, policy]));
      const jobById = new Map(jobs.map((job) => [job.id, job]));
      const groupById = new Map(groups.map((group) => [group.id, group]));
      const activeJobIds = new Set([...persistedActive.map((run) => run.jobId), ...this.activeRunJobs.values()]);
      const now = this.now();
      const candidates = await this.#dispatchCandidates({ jobs, policyById, jobById, groupById, runs: persistedRuns, activeJobIds, attempted, now });
      const candidate = candidates[0];
      if (!candidate) break;
      attempted.add(`${candidate.kind}:${candidate.id}`);
      if (candidate.kind === 'retry') {
        try {
          const resumed = await this.manualBackupService.resume(this.workspaceId, this.actorId, candidate.run.id);
          this.#track(resumed.id, candidate.run.jobId);
        } catch (error) {
          if (error?.code === 'BACKUP_JOB_ALREADY_RUNNING') continue;
          const failure = safeDispatchFailure(error, this.clock);
          if (failure.retryable) await this.#deferRetryDispatch(candidate.run.id, failure);
          else await this.manualBackupService.failInterrupted(this.workspaceId, this.actorId, candidate.run.id, failure).catch(() => {});
        }
        continue;
      }
      let job = candidate.job;
      const policy = candidate.policy;
      const calendarDecision = evaluateExecutionCalendar(policy.schedule, new Date(now));
      if (calendarDecision.action !== 'allow') {
        await this.#applyCalendarDecision(job.id, policy, calendarDecision);
        continue;
      }
      const missedDecision = evaluateMissedRun(policy.schedule, job.nextRunAt, new Date(now));
      if (['skip', 'advance'].includes(missedDecision.action)) {
        await this.#applyMissedDecision(job.id, missedDecision);
        continue;
      }
      if (missedDecision.scheduledFor !== job.nextRunAt || missedDecision.skippedCount > 0) job = await this.#applyMissedDecision(job.id, missedDecision);
      const scheduledFor = isoTime(missedDecision.scheduledFor, 'Scheduled occurrence time');
      try {
        const run = await this.manualBackupService.startScheduled(this.workspaceId, this.actorId, job.id, scheduledFor);
        await this.#markDispatched(job.id, scheduledFor, run, policy);
        if (run.occurrenceCreated) this.#track(run.id, job.id);
      } catch (error) {
        if (error?.code !== 'BACKUP_JOB_ALREADY_RUNNING') await this.#recordDispatchFailure(job.id, scheduledFor, error);
      }
    }
    return this.status();
  }

  async #dispatchCandidates({ jobs, policyById, jobById, groupById, runs, activeJobIds, attempted, now }) {
    const candidates = [];
    for (let run of runs) {
      const group = groupById.get(run.executionGroupId);
      if (run.state !== 'interrupted' || !['schedule', 'retry'].includes(run.trigger) || group?.latestRunId !== run.id || TERMINAL_RUN_STATES.has(group.state) || activeJobIds.has(run.jobId) || attempted.has(`retry:${run.id}`)) continue;
      const currentJob = jobById.get(run.jobId);
      const currentPolicy = policyById.get(currentJob?.policyId);
      if (currentJob?.state !== 'enabled' || !currentPolicy?.enabled) continue;
      const retryPolicy = normalizeRetryPolicy(run.configSnapshot?.policy?.retry || currentPolicy?.retry || {});
      const category = String(run.result?.category || 'execution');
      if (!run.result?.retryable || !retryPolicy.retryableCategories.includes(category)) {
        await this.manualBackupService.failInterrupted(this.workspaceId, this.actorId, run.id, {
          safeErrorCode: 'BACKUP_RETRY_CATEGORY_NOT_ALLOWED', safeMessage: `Automatic retry is disabled for ${category} failures.`, category
        });
        continue;
      }
      if (run.attempt >= retryPolicy.maximumAttempts) {
        await this.manualBackupService.failInterrupted(this.workspaceId, this.actorId, run.id);
        continue;
      }
      if (!run.retryState?.notBefore) {
        const schedule = calculateRetrySchedule(retryPolicy, run.attempt, run.result?.failedAt || run.finishedAt || run.updatedAt || this.clock(), group.idempotencyKey || group.id);
        run = await this.controlDatabase.transaction((transaction) => transaction.projectExecution('run', this.workspaceId, run.id, {
          retryState: { ...schedule, category, status: 'waiting', scheduledAt: this.clock() }
        }, { expectedRevision: run.revision, actorId: this.actorId }));
      }
      const notBefore = Date.parse(run.retryState.notBefore);
      if (Number.isFinite(notBefore) && notBefore <= now) {
        const priority = run.configSnapshot?.policy?.performance?.priority || currentPolicy?.performance?.priority || 'normal';
        candidates.push({ kind: 'retry', id: run.id, run, priority, dispatchAt: notBefore, createdAt: run.createdAt });
      }
    }
    for (const job of jobs) {
      const policy = policyById.get(job.policyId);
      const scheduledAt = Date.parse(job.nextRunAt || '');
      const retryAt = Date.parse(job.scheduleState?.nextDispatchAttemptAt || '');
      if (attempted.has(`job:${job.id}`) || activeJobIds.has(job.id) || job.state !== 'enabled' || !policy?.enabled || !Number.isFinite(scheduledAt) || scheduledAt > now || (Number.isFinite(retryAt) && retryAt > now)) continue;
      candidates.push({ kind: 'job', id: job.id, job, policy, priority: policy.performance?.priority || 'normal', dispatchAt: scheduledAt, createdAt: job.createdAt });
    }
    return candidates.sort((left, right) => priorityRank(right.priority) - priorityRank(left.priority)
      || left.dispatchAt - right.dispatchAt
      || String(left.createdAt).localeCompare(String(right.createdAt), 'en-US')
      || left.id.localeCompare(right.id, 'en-US'));
  }

  #track(runId, jobId) {
    if (this.activeRuns.has(runId)) return;
    const completion = Promise.resolve(this.manualBackupService.wait(runId)).finally(() => {
      this.activeRuns.delete(runId);
      this.activeRunJobs.delete(runId);
      if (this.workspaceId && !this.draining) setTimeout(() => this.tick().catch(() => {}), 0);
    });
    this.activeRuns.set(runId, completion);
    this.activeRunJobs.set(runId, jobId);
  }

  async #deferRetryDispatch(runId, failure) {
    const current = await this.controlDatabase.repository('run').get(this.workspaceId, runId);
    if (!current || current.state !== 'interrupted') return;
    await this.controlDatabase.transaction((transaction) => transaction.projectExecution('run', this.workspaceId, current.id, {
      retryState: {
        ...(current.retryState || {}),
        status: 'dispatch-failed',
        notBefore: new Date(this.now() + DISPATCH_FAILURE_RETRY_MS).toISOString(),
        lastDispatchError: failure
      }
    }, { expectedRevision: current.revision, actorId: this.actorId }));
  }

  async #applyCalendarDecision(jobId, policy, decision) {
    const current = await this.controlDatabase.repository('backupJob').get(this.workspaceId, jobId);
    if (!current) return null;
    const skipped = decision.action === 'skip';
    let nextRunAt = current.nextRunAt;
    let recurrenceError = null;
    if (skipped) {
      try {
        nextRunAt = nextOccurrence(policy.schedule, new Date(this.now()));
      } catch (error) {
        nextRunAt = null;
        recurrenceError = {
          safeErrorCode: error instanceof BackupScheduleError ? error.code : 'BACKUP_SCHEDULE_INVALID',
          safeMessage: error instanceof BackupScheduleError ? error.message : 'The next backup occurrence could not be calculated.',
          category: 'validation', retryable: false, failedAt: this.clock()
        };
      }
    }
    return this.controlDatabase.repository('backupJob').update(this.workspaceId, current.id, {
      nextRunAt,
      scheduleState: {
        ...(current.scheduleState || {}),
        lastCalendarDecision: {
          action: decision.action,
          reasonCode: decision.reasonCode,
          evaluatedAt: decision.evaluatedAt,
          scheduledFor: current.nextRunAt,
          nextRunAt
        },
        nextDispatchAttemptAt: decision.action === 'defer' ? decision.nextDispatchAttemptAt : null,
        recurrenceError,
        calculatedAt: this.clock()
      }
    }, { expectedRevision: current.revision, actorId: this.actorId });
  }

  async #applyMissedDecision(jobId, decision) {
    const current = await this.controlDatabase.repository('backupJob').get(this.workspaceId, jobId);
    if (!current) return null;
    const nextRunAt = decision.action === 'dispatch' ? decision.scheduledFor : decision.nextRunAt;
    return this.controlDatabase.repository('backupJob').update(this.workspaceId, current.id, {
      nextRunAt,
      scheduleState: {
        ...(current.scheduleState || {}),
        lastMissedRunDecision: {
          action: decision.action,
          evaluatedAt: decision.evaluatedAt,
          originalScheduledFor: current.nextRunAt,
          selectedScheduledFor: decision.scheduledFor,
          nextRunAt,
          skippedCount: decision.skippedCount,
          latenessSeconds: decision.latenessSeconds,
          scanLimitReached: Boolean(decision.scanLimitReached)
        },
        nextDispatchAttemptAt: null,
        calculatedAt: this.clock()
      }
    }, { expectedRevision: current.revision, actorId: this.actorId });
  }

  async #markDispatched(jobId, scheduledFor, run, policy) {
    const current = await this.controlDatabase.repository('backupJob').get(this.workspaceId, jobId);
    if (!current || isoTime(current.nextRunAt, 'Scheduled occurrence time') !== scheduledFor) return;
    let nextRunAt = null;
    let recurrenceError = null;
    try {
      nextRunAt = nextOccurrence(policy?.schedule, scheduledFor);
    } catch (error) {
      recurrenceError = {
        safeErrorCode: error instanceof BackupScheduleError ? error.code : 'BACKUP_SCHEDULE_INVALID',
        safeMessage: error instanceof BackupScheduleError ? error.message : 'The next backup occurrence could not be calculated.',
        category: 'validation',
        retryable: false,
        failedAt: this.clock()
      };
    }
    await this.controlDatabase.repository('backupJob').update(this.workspaceId, current.id, {
      nextRunAt,
      scheduleState: {
        ...(current.scheduleState || {}),
        lastScheduledFor: scheduledFor,
        lastDispatchedAt: this.clock(),
        lastRunId: run.id,
        lastDispatchError: null,
        nextDispatchAttemptAt: null,
        recurrenceError,
        lastCalendarDecision: current.scheduleState?.lastCalendarDecision || null,
        lastMissedRunDecision: current.scheduleState?.lastMissedRunDecision || null,
        calculatedAt: this.clock()
      }
    }, { expectedRevision: current.revision, actorId: this.actorId });
  }

  async #recordDispatchFailure(jobId, scheduledFor, error) {
    const current = await this.controlDatabase.repository('backupJob').get(this.workspaceId, jobId);
    if (!current || current.nextRunAt !== scheduledFor) return;
    const retryAt = new Date(this.now() + DISPATCH_FAILURE_RETRY_MS).toISOString();
    await this.controlDatabase.repository('backupJob').update(this.workspaceId, current.id, {
      scheduleState: {
        ...(current.scheduleState || {}),
        lastScheduledFor: scheduledFor,
        lastDispatchError: safeDispatchFailure(error, this.clock),
        nextDispatchAttemptAt: retryAt
      }
    }, { expectedRevision: current.revision, actorId: this.actorId }).catch(() => {});
  }

  async #register(state, extra = {}) {
    if (!this.workspaceId) return null;
    const records = await this.controlDatabase.repository('workerRegistration').list(this.workspaceId, { limit: 1000 });
    const current = records.find((record) => record.workerId === this.workerId);
    const heartbeatAt = this.clock();
    const values = {
      state,
      protocolVersion: WORKER_PROTOCOL_VERSION,
      workerGeneration: this.workerGeneration,
      heartbeatAt,
      processId: process.pid,
      activeRunIds: [...this.activeRuns.keys()],
      maximumConcurrentRuns: this.maximumConcurrentRuns,
      capabilities: {
        sourceAdapters: ['deployerx.files.local', 'deployerx.files.ssh'],
        repositoryAdapters: ['deployerx.repository.local', 'deployerx.repository.sftp', 'deployerx.repository.s3'],
        repositoryEngines: ['deployerx.repository-engine.files']
      },
      ...extra
    };
    this.registration = current
      ? await this.controlDatabase.repository('workerRegistration').update(this.workspaceId, current.id, values, { expectedRevision: current.revision, actorId: this.actorId })
      : await this.controlDatabase.repository('workerRegistration').create({
        workspaceId: this.workspaceId,
        actorId: this.actorId,
        name: `Backup worker ${this.deviceId.slice(0, 12)}`,
        workerId: this.workerId,
        deviceId: this.deviceId,
        ...values
      });
    return this.registration;
  }

  async #heartbeat(extra = {}) {
    return this.#register(this.draining ? 'draining' : 'online', extra);
  }
}

module.exports = {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DISPATCH_FAILURE_RETRY_MS,
  MAXIMUM_RETRY_ATTEMPTS,
  ScheduledBackupWorkerError,
  ScheduledBackupWorkerService,
  WORKER_PROTOCOL_VERSION,
  boundedAttempts,
  effectiveJobDispatchTime,
  safeDispatchFailure
};
