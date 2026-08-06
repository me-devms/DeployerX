const assert = require('node:assert/strict');
const test = require('node:test');
const { ADAPTER_ID } = require('./mongodb');
const { MODE, MongoDbRecoveryDrillService } = require('./mongodb-recovery-drill');

const WORKSPACE_ID = 'local';
const DEVICE_ID = 'mongodb-drill-device';

function memoryDatabase() {
  const data = {
    source: [{ id: 'source-mongodb', workspaceId: WORKSPACE_ID, connectionId: 'source-connection', adapterId: ADAPTER_ID, consistency: { backupMethod: 'logical', method: 'mongodb-oplog-dump' } }],
    backupJob: [{ id: 'job-mongodb', workspaceId: WORKSPACE_ID, sourceId: 'source-mongodb', policyId: 'policy-mongodb', state: 'enabled' }],
    policy: [{ id: 'policy-mongodb', workspaceId: WORKSPACE_ID, enabled: true, verification: { fullRecoveryTest: true, timeoutSeconds: 60 } }],
    run: [{ id: 'run-mongodb', workspaceId: WORKSPACE_ID, jobId: 'job-mongodb', state: 'succeeded', finishedAt: '2026-08-04T12:00:00.000Z' }],
    recoveryPoint: [{ id: 'point-mongodb', workspaceId: WORKSPACE_ID, jobId: 'job-mongodb', sourceId: 'source-mongodb', runId: 'run-mongodb', type: 'log', capturedTo: '2026-08-04T12:00:00.000Z' }],
    connection: [{ id: 'target-connection', workspaceId: WORKSPACE_ID, adapterId: ADAPTER_ID, workerAffinity: [`device:${DEVICE_ID}`], trust: { fingerprint: 'isolated-target-fingerprint' }, lastTest: { status: 'success' } }],
    verificationRun: []
  };
  let sequence = 0;
  const transitions = {
    queued: ['running', 'failed', 'canceled', 'interrupted'], running: ['succeeded', 'warning', 'failed', 'canceled', 'interrupted'],
    interrupted: ['failed', 'canceled'], succeeded: [], warning: [], failed: [], canceled: []
  };
  return {
    data,
    repository(type) {
      return {
        async create(input) {
          const record = { ...structuredClone(input), id: input.id || `verify-${++sequence}`, revision: 1, createdAt: '2026-08-04T12:00:00.000Z', updatedAt: '2026-08-04T12:00:00.000Z' };
          delete record.actorId;
          data[type].push(record);
          return structuredClone(record);
        },
        async get(workspaceId, id) { return structuredClone(data[type].find((record) => record.workspaceId === workspaceId && record.id === id) || null); },
        async list(workspaceId, options = {}) { return data[type].filter((record) => record.workspaceId === workspaceId).slice(0, options.limit || 100).map((record) => structuredClone(record)); }
      };
    },
    async transaction(operation) {
      return operation({
        get(type, workspaceId, id) { return structuredClone(data[type].find((record) => record.workspaceId === workspaceId && record.id === id) || null); },
        projectExecution(type, workspaceId, id, changes) {
          const index = data[type].findIndex((record) => record.workspaceId === workspaceId && record.id === id);
          const current = data[type][index];
          const state = changes.state || current.state;
          if (state !== current.state && !transitions[current.state]?.includes(state)) throw new Error(`invalid transition ${current.state} -> ${state}`);
          data[type][index] = { ...current, ...structuredClone(changes), revision: current.revision + 1, updatedAt: '2026-08-04T12:00:01.000Z' };
          return structuredClone(data[type][index]);
        }
      });
    }
  };
}

function fixture(options = {}) {
  const database = memoryDatabase();
  const controller = {
    id: 'test.mongodb.disposable-target', version: '1.0.0', provisioned: [], inspected: [], destroyed: [], exists: true,
    destroyFailures: Number(options.destroyFailures || 0),
    async provision(input) {
      this.provisioned.push(structuredClone({ ...input, signal: undefined }));
      const base = {
        controllerId: this.id, controllerVersion: this.version, owner: input.owner, leaseId: 'lease-isolated', targetId: 'target-isolated',
        targetConnectionId: 'target-connection', topology: 'standalone', targetEmpty: true, isolated: true, serviceExposed: false,
        provisionedAt: '2026-08-04T12:00:00.000Z'
      };
      return typeof options.provision === 'function' ? options.provision(base, input) : { ...base, ...(options.provision || {}) };
    },
    async inspect(input) {
      this.inspected.push(structuredClone({ ...input, signal: undefined }));
      const base = {
        exists: this.exists, controllerId: this.id, controllerVersion: this.version, owner: input.owner, leaseId: input.leaseId || 'lease-isolated',
        targetId: input.targetId || 'target-isolated', targetConnectionId: 'target-connection', topology: 'standalone', targetEmpty: true,
        isolated: true, serviceExposed: false
      };
      return typeof options.inspect === 'function' ? options.inspect(base, input) : { ...base, ...(options.inspect || {}) };
    },
    async destroy(input) {
      this.destroyed.push(structuredClone({ ...input, signal: undefined }));
      if (this.destroyFailures > 0) { this.destroyFailures -= 1; throw Object.assign(new Error('controller unavailable'), { code: 'DISPOSABLE_TARGET_CLEANUP_FAILED', category: 'cleanup', retryable: true }); }
      this.exists = false;
      return { owner: input.owner, leaseId: input.leaseId, targetId: input.targetId, destroyed: true, serviceExposed: false };
    }
  };
  let now = 1000;
  let timerCallback = null;
  const restore = {
    started: [], canceled: [],
    async start(workspaceId, actorId, input) {
      const [verification] = database.data.verificationRun;
      assert.equal(verification.lease?.state, 'active', 'lease must be durable before repository-backed restore starts');
      this.started.push({ workspaceId, actorId, input: structuredClone(input) });
      return { id: 'restore-isolated', state: 'queued' };
    },
    async wait() {
      if (options.blockRestore) return new Promise(() => {});
      now = 6500;
      return options.restoreResult || {
        id: 'restore-isolated', state: 'succeeded', validation: { expectedObjects: 'pass', nativeIntegrityValidation: true },
        result: { recoveryTarget: { type: 'coordinate', coordinate: { timestamp: { $timestamp: { t: 275, i: 4 } } } } }
      };
    },
    async cancel(_workspaceId, _actorId, restoreRunId) { this.canceled.push(restoreRunId); return { id: restoreRunId, state: 'canceled' }; }
  };
  const service = new MongoDbRecoveryDrillService({
    controlDatabase: database, restoreService: restore, targetController: controller, deviceId: DEVICE_ID,
    clock: () => new Date(1722772800000 + now).toISOString(), now: () => now,
    setTimer(callback) { timerCallback = callback; return 1; }, clearTimer() {}
  });
  return { database, controller, restore, service, fireTimeout: () => timerCallback() };
}

async function waitFor(predicate) {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('condition was not reached');
}

test('dispatches one policy-scheduled logical recovery drill, measures RTO, and deduplicates the backup occurrence', async () => {
  const { service, controller, restore } = fixture();
  const [started] = await service.dispatchScheduled(WORKSPACE_ID, 'worker');
  assert.equal(started.mode, MODE);
  assert.equal(started.triggerBackupRunId, 'run-mongodb');
  const completed = await service.wait(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'succeeded');
  assert.equal(completed.measuredRtoSeconds, 6);
  assert.deepEqual(completed.evidence, {
    isolated: true, serviceExposed: false, targetDestroyed: true, topology: 'standalone', expectedObjects: 'pass', nativeIntegrityValidation: true,
    recoveryTarget: { type: 'coordinate', coordinate: { timestamp: { $timestamp: { t: 275, i: 4 } } } }
  });
  assert.equal(restore.started[0].input.mode, 'alternate');
  assert.equal(restore.started[0].input.targetConnectionId, 'target-connection');
  assert.equal(controller.destroyed.length, 1);
  assert.deepEqual(await service.dispatchScheduled(WORKSPACE_ID, 'worker'), []);
});

test('refuses an occupied exact-owned target before restore and destroys only that owned target', async () => {
  const { service, controller, restore } = fixture({ provision: { targetEmpty: false } });
  const started = await service.start(WORKSPACE_ID, 'actor', { jobId: 'job-mongodb', recoveryPointId: 'point-mongodb', timeoutSeconds: 60 });
  const completed = await service.wait(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'failed');
  assert.equal(completed.result.error.code, 'MONGODB_RECOVERY_DRILL_TARGET_OCCUPIED');
  assert.equal(restore.started.length, 0);
  assert.equal(controller.destroyed.length, 1);
});

test('refuses foreign ownership without touching the foreign target', async () => {
  const { service, controller, restore } = fixture({ provision: { owner: 'another-owner' } });
  const started = await service.start(WORKSPACE_ID, 'actor', { jobId: 'job-mongodb', recoveryPointId: 'point-mongodb', timeoutSeconds: 60 });
  const completed = await service.wait(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'failed');
  assert.equal(completed.result.error.code, 'MONGODB_RECOVERY_DRILL_OWNERSHIP_UNPROVEN');
  assert.equal(restore.started.length, 0);
  assert.equal(controller.destroyed.length, 0);
});

test('fails closed when authenticated MongoDB validation fails and still destroys the target', async () => {
  const { service, controller } = fixture({ restoreResult: { id: 'restore-isolated', state: 'failed', validation: { expectedObjects: 'failed', nativeIntegrityValidation: false } } });
  const started = await service.start(WORKSPACE_ID, 'actor', { jobId: 'job-mongodb', recoveryPointId: 'point-mongodb', timeoutSeconds: 60 });
  const completed = await service.wait(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'failed');
  assert.equal(completed.result.error.code, 'MONGODB_RECOVERY_DRILL_VALIDATION_FAILED');
  assert.equal(controller.destroyed.length, 1);
});

test('times out an active restore, cancels it, and destroys the disposable target', async () => {
  const { service, controller, restore, fireTimeout } = fixture({ blockRestore: true });
  const started = await service.start(WORKSPACE_ID, 'actor', { jobId: 'job-mongodb', recoveryPointId: 'point-mongodb', timeoutSeconds: 60 });
  await waitFor(() => restore.started.length === 1);
  fireTimeout();
  const completed = await service.wait(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'failed');
  assert.equal(completed.result.error.code, 'MONGODB_RECOVERY_DRILL_TIMED_OUT');
  assert.deepEqual(restore.canceled, ['restore-isolated']);
  assert.equal(controller.destroyed.length, 1);
});

test('keeps timed-out provisioning interrupted until deterministic-owner reconciliation proves cleanup', async () => {
  const { service, controller, restore, fireTimeout } = fixture({ provision: () => new Promise(() => {}) });
  const started = await service.start(WORKSPACE_ID, 'actor', { jobId: 'job-mongodb', recoveryPointId: 'point-mongodb', timeoutSeconds: 60 });
  await waitFor(() => controller.provisioned.length === 1);
  fireTimeout();
  const interrupted = await service.wait(WORKSPACE_ID, started.id);
  assert.equal(interrupted.state, 'interrupted');
  assert.equal(interrupted.result.error.code, 'MONGODB_RECOVERY_DRILL_CLEANUP_UNPROVEN');
  assert.equal(restore.started.length, 0);
  assert.deepEqual(await service.dispatchScheduled(WORKSPACE_ID, 'worker'), []);
  const [reconciled] = await service.reconcile(WORKSPACE_ID, 'reconciler');
  assert.equal(reconciled.state, 'failed');
  assert.equal(controller.destroyed.length, 1);
});

test('keeps cleanup uncertainty interrupted, then reconciles exact ownership once and remains idempotent', async () => {
  const { service, controller } = fixture({ destroyFailures: 1 });
  const started = await service.start(WORKSPACE_ID, 'actor', { jobId: 'job-mongodb', recoveryPointId: 'point-mongodb', timeoutSeconds: 60 });
  const interrupted = await service.wait(WORKSPACE_ID, started.id);
  assert.equal(interrupted.state, 'interrupted');
  assert.equal(interrupted.progress.phase, 'operator-action-required');
  assert.equal(interrupted.result.cleanupUncertain, true);
  const [reconciled] = await service.reconcile(WORKSPACE_ID, 'reconciler');
  assert.equal(reconciled.state, 'failed');
  assert.equal(reconciled.result.error.code, 'MONGODB_RECOVERY_DRILL_PROCESS_INTERRUPTED');
  assert.equal(controller.destroyed.length, 2);
  assert.deepEqual(await service.reconcile(WORKSPACE_ID, 'reconciler'), []);
  assert.equal(controller.destroyed.length, 2);
});

test('fails when the recovered target becomes exposed and records no successful drill evidence', async () => {
  const { service, controller } = fixture({ inspect: { serviceExposed: true } });
  const started = await service.start(WORKSPACE_ID, 'actor', { jobId: 'job-mongodb', recoveryPointId: 'point-mongodb', timeoutSeconds: 60 });
  const completed = await service.wait(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'failed');
  assert.equal(completed.result.error.code, 'MONGODB_RECOVERY_DRILL_TARGET_EXPOSED');
  assert.equal(completed.evidence, null);
  assert.equal(controller.destroyed.length, 1);
});
