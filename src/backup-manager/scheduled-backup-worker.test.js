const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { BackupControlDatabase } = require('./control-database');
const { ScheduledBackupWorkerService, effectiveJobDispatchTime } = require('./scheduled-backup-worker');

const WORKSPACE_ID = 'local';
const NOW = Date.parse('2026-08-03T12:00:00.000Z');

class FakeManualBackupService {
  constructor() {
    this.started = [];
    this.resumed = [];
    this.failed = [];
    this.reconciled = 0;
    this.waiters = new Map();
    this.resumeError = null;
  }

  async startScheduled(workspaceId, actorId, jobId, scheduledFor) {
    const run = { id: `run-${this.started.length + 1}`, workspaceId, actorId, jobId, scheduledFor, occurrenceCreated: true };
    this.started.push(run);
    this.waiters.set(run.id, new Promise(() => {}));
    return run;
  }

  async reconcile() { this.reconciled += 1; return []; }

  async resume(workspaceId, actorId, runId) {
    if (this.resumeError) throw this.resumeError;
    const run = { id: `retry-${runId}`, workspaceId, actorId, parentRunId: runId };
    this.resumed.push(run);
    this.waiters.set(run.id, new Promise(() => {}));
    return run;
  }

  async failInterrupted(workspaceId, actorId, runId) {
    this.failed.push({ workspaceId, actorId, runId });
    return { id: runId, state: 'failed' };
  }

  wait(runId) { return this.waiters.get(runId) || Promise.resolve(); }
}

async function fixture(context, options = {}) {
  let currentNow = options.now ?? NOW;
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-scheduled-worker-test-'));
  const database = new BackupControlDatabase({ rootPath });
  await database.initialize();
  context.after(async () => { await database.close(); await fs.rm(rootPath, { recursive: true, force: true }); });
  const connection = await database.repository('connection').create({ workspaceId: WORKSPACE_ID, name: 'Host', kind: 'local', adapterId: 'deployerx.connection.local' });
  const source = await database.repository('source').create({ workspaceId: WORKSPACE_ID, name: 'Files', connectionId: connection.id, sourceType: 'files', adapterId: 'deployerx.files.local', enabled: true });
  const policy = await database.repository('policy').create({
    workspaceId: WORKSPACE_ID, name: options.policyName || 'Scheduled policy', enabled: true, backupMode: 'incremental',
    schedule: options.schedule || { type: 'manual' },
    performance: { priority: options.priority || 'normal' },
    retry: { maximumAttempts: options.maximumAttempts || 3, backoff: 'exponential', initialDelaySeconds: 30, maximumDelaySeconds: 3600, jitterPercent: 0, retryableCategories: ['execution', 'timeout', 'connectivity'] }
  });
  const job = await database.repository('backupJob').create({
    workspaceId: WORKSPACE_ID, name: options.jobName || 'Scheduled job', sourceId: source.id, policyId: policy.id,
    state: 'enabled', nextRunAt: options.nextRunAt === undefined ? '2026-08-03T11:59:00.000Z' : options.nextRunAt, repositoryBindings: []
  });
  const manual = new FakeManualBackupService();
  const notificationService = options.notificationService || null;
  const worker = new ScheduledBackupWorkerService({
    controlDatabase: database, manualBackupService: manual, deviceId: 'test-device',
    clock: () => new Date(currentNow).toISOString(), now: () => currentNow, autoTimers: false,
    maximumConcurrentRuns: options.maximumConcurrentRuns ?? 1, notificationService, recoveryDrillService: options.recoveryDrillService || null
  });
  context.after(() => worker.stop({ drain: false }));
  return { database, manual, worker, policy, job, notificationService, setNow: (value) => { currentNow = Number(value); } };
}

test('registers, heartbeats, and dispatches one due scheduled occurrence', async (context) => {
  const { database, manual, worker, job } = await fixture(context);
  const status = await worker.start(WORKSPACE_ID);
  assert.equal(status.state, 'online');
  assert.equal(manual.started.length, 1);
  assert.equal(manual.started[0].jobId, job.id);
  assert.equal(manual.started[0].scheduledFor, '2026-08-03T11:59:00.000Z');
  const updated = await database.repository('backupJob').get(WORKSPACE_ID, job.id);
  assert.equal(updated.nextRunAt, null);
  assert.equal(updated.scheduleState.lastRunId, 'run-1');
  const [registration] = await database.repository('workerRegistration').list(WORKSPACE_ID);
  assert.equal(registration.state, 'online');
  assert.equal(registration.protocolVersion, 1);
  assert.equal(registration.workerGeneration, status.workerGeneration);
  await worker.tick();
  assert.equal(manual.started.length, 1);
});

test('evaluates overdue RPO on every worker tick and isolates evaluator failures', async (context) => {
  const workspaces = [];
  const notificationService = { async evaluateOverdueRpo(workspaceId) { workspaces.push(workspaceId); if (workspaces.length === 2) throw new Error('notification evaluation failed'); } };
  const { worker } = await fixture(context, { notificationService, nextRunAt: null });
  await worker.start(WORKSPACE_ID);
  await worker.tick();
  assert.deepEqual(workspaces, [WORKSPACE_ID, WORKSPACE_ID]);
  assert.equal(worker.status().state, 'online');
});

test('reconciles and dispatches scheduled recovery drills on each worker tick', async (context) => {
  const calls = [];
  const recoveryDrillService = {
    async reconcile(workspaceId, actorId) { calls.push(['reconcile', workspaceId, actorId]); return []; },
    async dispatchScheduled(workspaceId, actorId) { calls.push(['dispatch', workspaceId, actorId]); return []; }
  };
  const { worker } = await fixture(context, { recoveryDrillService, nextRunAt: null });
  await worker.start(WORKSPACE_ID, 'drill-worker');
  assert.deepEqual(calls, [
    ['reconcile', WORKSPACE_ID, 'drill-worker'],
    ['dispatch', WORKSPACE_ID, 'drill-worker']
  ]);
});

test('reports the later calendar deferral as the effective dispatch time', () => {
  assert.equal(effectiveJobDispatchTime({
    nextRunAt: '2026-08-03T11:59:00Z',
    scheduleState: { nextDispatchAttemptAt: '2026-08-03T13:00:00Z' }
  }), '2026-08-03T13:00:00.000Z');
  assert.equal(effectiveJobDispatchTime({ nextRunAt: '2026-08-04T11:59:00Z' }), '2026-08-04T11:59:00.000Z');
  assert.equal(effectiveJobDispatchTime({ nextRunAt: null }), null);
});

test('advances a recurring job from its scheduled occurrence without cadence drift', async (context) => {
  const { database, manual, worker, job } = await fixture(context, { schedule: { type: 'daily', time: '11:59' } });
  await worker.start(WORKSPACE_ID);
  assert.equal(manual.started.length, 1);
  const updated = await database.repository('backupJob').get(WORKSPACE_ID, job.id);
  assert.equal(updated.nextRunAt, '2026-08-04T11:59:00.000Z');
  assert.equal(updated.scheduleState.lastScheduledFor, '2026-08-03T11:59:00.000Z');
  assert.equal(updated.scheduleState.recurrenceError, null);
});

test('coalesces overdue occurrences to the latest scheduled instant', async (context) => {
  const { database, manual, worker, job } = await fixture(context, {
    nextRunAt: '2026-08-03T08:00:00.000Z',
    schedule: { type: 'hourly', minute: 0, missedRun: { behavior: 'run-latest', graceMinutes: 0 } }
  });
  await worker.start(WORKSPACE_ID);
  assert.equal(manual.started[0].scheduledFor, '2026-08-03T12:00:00.000Z');
  const updated = await database.repository('backupJob').get(WORKSPACE_ID, job.id);
  assert.equal(updated.nextRunAt, '2026-08-03T13:00:00.000Z');
  assert.equal(updated.scheduleState.lastMissedRunDecision.skippedCount, 4);
});

test('skips overdue occurrences when the missed-run policy requires it', async (context) => {
  const { database, manual, worker, job } = await fixture(context, {
    nextRunAt: '2026-08-03T08:00:00.000Z',
    schedule: { type: 'hourly', minute: 0, missedRun: { behavior: 'skip', graceMinutes: 0 } }
  });
  await worker.start(WORKSPACE_ID);
  assert.equal(manual.started.length, 0);
  const updated = await database.repository('backupJob').get(WORKSPACE_ID, job.id);
  assert.equal(updated.nextRunAt, '2026-08-03T13:00:00.000Z');
  assert.equal(updated.scheduleState.lastMissedRunDecision.action, 'skip');
  assert.equal(updated.scheduleState.lastMissedRunDecision.skippedCount, 5);
});

test('defers outside a maintenance window without consuming the occurrence', async (context) => {
  const { database, manual, worker, job } = await fixture(context, {
    schedule: {
      type: 'daily', time: '11:59',
      executionCalendar: { maintenanceWindows: [{ daysOfWeek: [1], startTime: '13:00', endTime: '14:00' }], outsideMaintenanceBehavior: 'defer' }
    }
  });
  await worker.start(WORKSPACE_ID);
  assert.equal(manual.started.length, 0);
  const updated = await database.repository('backupJob').get(WORKSPACE_ID, job.id);
  assert.equal(updated.nextRunAt, job.nextRunAt);
  assert.equal(updated.scheduleState.nextDispatchAttemptAt, '2026-08-03T13:00:00.000Z');
  assert.equal(updated.scheduleState.lastCalendarDecision.reasonCode, 'OUTSIDE_MAINTENANCE_WINDOW');
});

test('skips all currently blocked occurrences during a blackout', async (context) => {
  const { database, manual, worker, job } = await fixture(context, {
    schedule: {
      type: 'daily', time: '11:59',
      executionCalendar: {
        blackouts: [{ startsAt: '2026-08-03T11:00:00Z', endsAt: '2026-08-03T13:00:00Z' }],
        blackoutBehavior: 'skip'
      }
    }
  });
  await worker.start(WORKSPACE_ID);
  assert.equal(manual.started.length, 0);
  const updated = await database.repository('backupJob').get(WORKSPACE_ID, job.id);
  assert.equal(updated.nextRunAt, '2026-08-04T11:59:00.000Z');
  assert.equal(updated.scheduleState.lastCalendarDecision.reasonCode, 'BLACKOUT_ACTIVE');
});

test('does not dispatch a second job while the worker has no run slot', async (context) => {
  const { database, manual, worker } = await fixture(context);
  const firstConnection = (await database.repository('connection').list(WORKSPACE_ID))[0];
  const secondSource = await database.repository('source').create({ workspaceId: WORKSPACE_ID, name: 'Second files', connectionId: firstConnection.id, sourceType: 'files', adapterId: 'deployerx.files.local', enabled: true });
  const policy = (await database.repository('policy').list(WORKSPACE_ID))[0];
  await database.repository('backupJob').create({ workspaceId: WORKSPACE_ID, name: 'Second job', sourceId: secondSource.id, policyId: policy.id, state: 'enabled', nextRunAt: '2026-08-03T11:59:30.000Z', repositoryBindings: [] });
  await worker.start(WORKSPACE_ID);
  await worker.tick();
  assert.equal(manual.started.length, 1);
});

test('resumes the latest retryable scheduled interruption after restart', async (context) => {
  const { database, manual, worker, job, setNow } = await fixture(context, { nextRunAt: null });
  const records = await database.transaction((transaction) => {
    const group = transaction.create('executionGroup', { workspaceId: WORKSPACE_ID, jobId: job.id, jobRevision: job.revision, trigger: 'schedule', scheduledFor: '2026-08-03T11:00:00.000Z', idempotencyKey: 'schedule:recover', state: 'running' });
    const run = transaction.create('run', { workspaceId: WORKSPACE_ID, jobId: job.id, jobRevision: job.revision, executionGroupId: group.id, scheduledFor: '2026-08-03T11:00:00.000Z', idempotencyKey: 'schedule:recover:attempt:1', trigger: 'schedule', workerId: 'device:test-device', state: 'interrupted', attempt: 1, configSnapshot: {}, result: { retryable: true, failedAt: '2026-08-03T12:00:00.000Z' } });
    const projected = transaction.projectExecution('executionGroup', WORKSPACE_ID, group.id, { latestRunId: run.id }, { expectedRevision: group.revision });
    return { group: projected, run };
  });
  await worker.start(WORKSPACE_ID);
  assert.equal(manual.resumed.length, 0);
  const waiting = await database.repository('run').get(WORKSPACE_ID, records.run.id);
  assert.equal(waiting.retryState.notBefore, '2026-08-03T12:00:30.000Z');
  assert.equal(waiting.retryState.nextAttempt, 2);
  setNow(Date.parse(waiting.retryState.notBefore));
  await worker.tick();
  assert.equal(manual.resumed.length, 1);
  assert.equal(manual.resumed[0].parentRunId, records.run.id);
});

test('does not resume interrupted work while its job is paused', async (context) => {
  const { database, manual, worker, job } = await fixture(context, { nextRunAt: null });
  await database.repository('backupJob').update(WORKSPACE_ID, job.id, { state: 'paused' }, { expectedRevision: job.revision, actorId: 'operator' });
  const run = await database.transaction((transaction) => {
    const group = transaction.create('executionGroup', { workspaceId: WORKSPACE_ID, jobId: job.id, jobRevision: job.revision, trigger: 'schedule', scheduledFor: '2026-08-03T11:00:00.000Z', idempotencyKey: 'schedule:paused', state: 'running' });
    const created = transaction.create('run', {
      workspaceId: WORKSPACE_ID, jobId: job.id, jobRevision: job.revision, executionGroupId: group.id,
      scheduledFor: '2026-08-03T11:00:00.000Z', idempotencyKey: 'schedule:paused:attempt:1', trigger: 'retry',
      workerId: 'device:test-device', state: 'interrupted', attempt: 1, configSnapshot: {},
      retryState: { nextAttempt: 2, notBefore: '2026-08-03T11:59:00.000Z', status: 'waiting' },
      result: { retryable: true, category: 'connectivity', failedAt: '2026-08-03T11:58:00.000Z' }
    });
    transaction.projectExecution('executionGroup', WORKSPACE_ID, group.id, { latestRunId: created.id }, { expectedRevision: group.revision });
    return created;
  });
  await worker.start(WORKSPACE_ID);
  assert.equal(manual.resumed.length, 0);
  assert.equal(manual.failed.length, 0);
  assert.equal((await database.repository('run').get(WORKSPACE_ID, run.id)).state, 'interrupted');
});

test('terminally finalizes an interrupted occurrence at the retry limit', async (context) => {
  const { database, manual, worker, job } = await fixture(context, { nextRunAt: null, maximumAttempts: 2 });
  const run = await database.transaction((transaction) => {
    const group = transaction.create('executionGroup', { workspaceId: WORKSPACE_ID, jobId: job.id, jobRevision: job.revision, trigger: 'schedule', scheduledFor: '2026-08-03T11:00:00.000Z', idempotencyKey: 'schedule:limit', state: 'running' });
    const created = transaction.create('run', { workspaceId: WORKSPACE_ID, jobId: job.id, jobRevision: job.revision, executionGroupId: group.id, scheduledFor: '2026-08-03T11:00:00.000Z', idempotencyKey: 'schedule:limit:attempt:2', trigger: 'retry', workerId: 'device:test-device', state: 'interrupted', attempt: 2, configSnapshot: {}, result: { retryable: true } });
    transaction.projectExecution('executionGroup', WORKSPACE_ID, group.id, { latestRunId: created.id }, { expectedRevision: group.revision });
    return created;
  });
  await worker.start(WORKSPACE_ID);
  assert.deepEqual(manual.failed.map((entry) => entry.runId), [run.id]);
  assert.equal(manual.resumed.length, 0);
});

test('refuses retry categories excluded by the immutable run policy', async (context) => {
  const { database, manual, worker, job } = await fixture(context, { nextRunAt: null });
  const run = await database.transaction((transaction) => {
    const group = transaction.create('executionGroup', { workspaceId: WORKSPACE_ID, jobId: job.id, jobRevision: job.revision, trigger: 'schedule', scheduledFor: '2026-08-03T11:00:00.000Z', idempotencyKey: 'schedule:category', state: 'running' });
    const created = transaction.create('run', {
      workspaceId: WORKSPACE_ID, jobId: job.id, jobRevision: job.revision, executionGroupId: group.id,
      scheduledFor: '2026-08-03T11:00:00.000Z', idempotencyKey: 'schedule:category:attempt:1', trigger: 'schedule',
      workerId: 'device:test-device', state: 'interrupted', attempt: 1,
      configSnapshot: { policy: { retry: { maximumAttempts: 3, retryableCategories: ['timeout'] } } },
      result: { retryable: true, category: 'capacity' }
    });
    transaction.projectExecution('executionGroup', WORKSPACE_ID, group.id, { latestRunId: created.id }, { expectedRevision: group.revision });
    return created;
  });
  await worker.start(WORKSPACE_ID);
  assert.deepEqual(manual.failed.map((entry) => entry.runId), [run.id]);
  assert.equal(manual.resumed.length, 0);
});

test('defers a retry when resume dispatch fails transiently', async (context) => {
  const { database, manual, worker, job } = await fixture(context, { nextRunAt: null });
  const run = await database.transaction((transaction) => {
    const group = transaction.create('executionGroup', { workspaceId: WORKSPACE_ID, jobId: job.id, jobRevision: job.revision, trigger: 'schedule', scheduledFor: '2026-08-03T11:00:00.000Z', idempotencyKey: 'schedule:resume-failure', state: 'running' });
    const created = transaction.create('run', {
      workspaceId: WORKSPACE_ID, jobId: job.id, jobRevision: job.revision, executionGroupId: group.id,
      scheduledFor: '2026-08-03T11:00:00.000Z', idempotencyKey: 'schedule:resume-failure:attempt:1', trigger: 'schedule',
      workerId: 'device:test-device', state: 'interrupted', attempt: 1, configSnapshot: {},
      retryState: { nextAttempt: 2, notBefore: '2026-08-03T11:59:00.000Z', status: 'waiting' },
      result: { retryable: true, category: 'connectivity', failedAt: '2026-08-03T11:58:00.000Z' }
    });
    transaction.projectExecution('executionGroup', WORKSPACE_ID, group.id, { latestRunId: created.id }, { expectedRevision: group.revision });
    return created;
  });
  manual.resumeError = Object.assign(new Error('Temporary connection failure.'), { name: 'ManualBackupError', code: 'BACKUP_RETRY_DISPATCH_FAILED', category: 'connectivity', retryable: true });
  await worker.start(WORKSPACE_ID);
  const deferred = await database.repository('run').get(WORKSPACE_ID, run.id);
  assert.equal(deferred.state, 'interrupted');
  assert.equal(deferred.retryState.status, 'dispatch-failed');
  assert.equal(deferred.retryState.notBefore, '2026-08-03T12:01:00.000Z');
  assert.equal(deferred.retryState.lastDispatchError.category, 'connectivity');
  assert.equal(manual.failed.length, 0);
});

test('fills two worker slots with independent jobs', async (context) => {
  const { database, manual, worker, policy } = await fixture(context, { maximumConcurrentRuns: 2 });
  const connection = (await database.repository('connection').list(WORKSPACE_ID))[0];
  const source = await database.repository('source').create({ workspaceId: WORKSPACE_ID, name: 'Second files', connectionId: connection.id, sourceType: 'files', adapterId: 'deployerx.files.local', enabled: true });
  await database.repository('backupJob').create({ workspaceId: WORKSPACE_ID, name: 'Second job', sourceId: source.id, policyId: policy.id, state: 'enabled', nextRunAt: '2026-08-03T11:59:30.000Z', repositoryBindings: [] });
  await worker.start(WORKSPACE_ID);
  assert.equal(manual.started.length, 2);
  assert.equal(worker.status().availableRunSlots, 0);
});

test('dispatches higher priority jobs before older low priority jobs', async (context) => {
  const { database, manual, worker } = await fixture(context, { priority: 'low' });
  const connection = (await database.repository('connection').list(WORKSPACE_ID))[0];
  const source = await database.repository('source').create({ workspaceId: WORKSPACE_ID, name: 'Critical files', connectionId: connection.id, sourceType: 'files', adapterId: 'deployerx.files.local', enabled: true });
  const policy = await database.repository('policy').create({ workspaceId: WORKSPACE_ID, name: 'Critical policy', enabled: true, backupMode: 'incremental', schedule: { type: 'manual' }, performance: { priority: 'critical' }, retry: { maximumAttempts: 3 } });
  const critical = await database.repository('backupJob').create({ workspaceId: WORKSPACE_ID, name: 'Critical job', sourceId: source.id, policyId: policy.id, state: 'enabled', nextRunAt: '2026-08-03T11:59:30.000Z', repositoryBindings: [] });
  await worker.start(WORKSPACE_ID);
  assert.equal(manual.started.length, 1);
  assert.equal(manual.started[0].jobId, critical.id);
});
