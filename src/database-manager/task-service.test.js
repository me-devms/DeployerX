const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { BackupControlDatabase } = require('../backup-manager/control-database');
const { DatabaseTaskService, DatabaseTaskStore } = require('./task-service');

async function fixture(context, onEvent = null) {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-database-task-test-'));
  context.after(() => fs.rm(rootPath, { recursive: true, force: true }));
  let now = Date.parse('2026-08-05T12:00:00.000Z');
  const clock = () => new Date(now).toISOString();
  const controlDatabase = new BackupControlDatabase({ rootPath, clock });
  await controlDatabase.initialize();
  context.after(() => controlDatabase.close());
  const connection = await controlDatabase.repository('connection').create({ workspaceId: 'workspace-a', name: 'Database host', kind: 'database', adapterId: 'deployerx.database', endpoint: {} });
  const profile = await controlDatabase.repository('databaseProfile').create({
    workspaceId: 'workspace-a', name: 'Orders', sharedConnectionId: connection.id, driverId: 'postgresql', environment: 'production', accessMode: 'read-write'
  });
  const store = new DatabaseTaskStore({ controlDatabase });
  const service = new DatabaseTaskService({ store, clock, onEvent });
  return { service, store, profile, advance: () => { now += 1000; } };
}

test('persists workspace-scoped tasks through bounded lifecycle transitions', async (context) => {
  const values = await fixture(context);
  const created = await values.service.create('workspace-a', 'tester', { profileId: values.profile.id, type: 'import', label: 'Import customers' });
  assert.equal(created.state, 'queued');
  assert.equal(created.progress.percent, 0);
  values.advance();
  const running = await values.service.start('workspace-a', 'tester', created.id, created.revision);
  assert.equal(running.state, 'running');
  values.advance();
  const progressed = await values.service.reportProgress('workspace-a', 'tester', created.id, { phase: 'loading', percent: 45, itemsTotal: 100, itemsCompleted: 45 }, running.revision);
  assert.equal(progressed.progress.percent, 45);
  values.advance();
  const completed = await values.service.complete('workspace-a', 'tester', created.id, { expectedRevision: progressed.revision });
  assert.equal(completed.state, 'succeeded');
  assert.equal(completed.progress.percent, 100);
  assert.equal(completed.canCancel, false);
  assert.equal((await values.service.list('workspace-a', { profileId: values.profile.id, state: 'succeeded' }))[0].id, created.id);
  assert.equal((await values.service.list('workspace-b')).length, 0);
  await assert.rejects(values.store.project('workspace-a', 'tester', created.id, { state: 'running' }, completed.revision), (error) => error.code === 'DATABASE_MANAGER_TASK_STATE_INVALID');
});

test('cancels only cancellable tasks after runtime acknowledgement', async (context) => {
  const values = await fixture(context);
  const created = await values.service.create('workspace-a', 'tester', { profileId: values.profile.id, type: 'dump', label: 'Dump orders' });
  const running = await values.service.start('workspace-a', 'tester', created.id, created.revision);
  let cancellations = 0;
  values.service.registerCancellation('workspace-a', created.id, async () => { cancellations += 1; });
  values.advance();
  const canceled = await values.service.cancel('workspace-a', 'tester', created.id);
  assert.equal(cancellations, 1);
  assert.equal(canceled.state, 'canceled');
  assert.equal(canceled.safeMessage, 'Canceled by user.');
  await assert.rejects(values.service.cancel('workspace-a', 'tester', created.id), (error) => error.code === 'DATABASE_MANAGER_TASK_NOT_CANCELLABLE');
  await assert.rejects(values.service.reportProgress('workspace-a', 'tester', running.id, { percent: 50 }), (error) => error.code === 'DATABASE_MANAGER_TASK_STATE_INVALID');
});

test('rejects missing and cross-workspace task profiles', async (context) => {
  const values = await fixture(context);
  await assert.rejects(values.service.create('workspace-b', 'tester', { profileId: values.profile.id, type: 'schema', label: 'Refresh schema' }), (error) => error.code === 'DATABASE_MANAGER_PROFILE_NOT_FOUND');
});

test('emits authoritative task lifecycle projections without changing persistence outcomes', async (context) => {
  const events = [];
  const values = await fixture(context, async (workspaceId, task) => events.push({ workspaceId, task }));
  const created = await values.service.create('workspace-a', 'tester', { profileId: values.profile.id, type: 'schema', label: 'Create index' });
  const running = await values.service.start('workspace-a', 'tester', created.id, created.revision);
  const progressed = await values.service.reportProgress('workspace-a', 'tester', created.id, { phase: 'applying', percent: 60 }, running.revision);
  await values.service.complete('workspace-a', 'tester', created.id, { expectedRevision: progressed.revision });
  assert.deepEqual(events.map(({ workspaceId, task }) => ({ workspaceId, state: task.state, phase: task.progress.phase, percent: task.progress.percent })), [
    { workspaceId: 'workspace-a', state: 'queued', phase: 'queued', percent: 0 },
    { workspaceId: 'workspace-a', state: 'running', phase: 'running', percent: 0 },
    { workspaceId: 'workspace-a', state: 'running', phase: 'applying', percent: 60 },
    { workspaceId: 'workspace-a', state: 'succeeded', phase: 'complete', percent: 100 }
  ]);
  values.service.onEvent = async () => { throw new Error('renderer unavailable'); };
  assert.equal((await values.service.create('workspace-a', 'tester', { profileId: values.profile.id, type: 'schema', label: 'Create view' })).state, 'queued');
});
