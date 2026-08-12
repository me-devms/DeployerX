const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SHARED_CONTROL_ENTITY_TYPES,
  compareWorkspaceControlRecords,
  mergeWorkspaceControlRecord,
  projectWorkspaceControlRecord,
  workspaceControlChangeIsShared,
  workspaceControlRecordsEquivalent,
  workspaceControlDocumentId
} = require('./workspace-control-sync');

test('shares collaborative control records but excludes runtime entity types', () => {
  assert.deepEqual(SHARED_CONTROL_ENTITY_TYPES, [
    'connection', 'source', 'repository', 'notificationRoute', 'policy', 'backupJob'
  ]);
  assert.equal(projectWorkspaceControlRecord('run', { id: 'run-a' }), null);
  assert.equal(projectWorkspaceControlRecord('databaseTask', { id: 'task-a' }), null);
  assert.equal(projectWorkspaceControlRecord('databaseSavedQuery', { id: 'query-a' }), null);
  assert.equal(projectWorkspaceControlRecord('databaseNotebook', { id: 'notebook-a' }), null);
});

test('cloud projections remove device credentials, local paths, and runtime state', () => {
  const connection = projectWorkspaceControlRecord('connection', {
    id: 'connection-a', scope: 'device', adapterId: 'deployerx.local', endpoint: { path: 'C:\\private', host: 'server.test' },
    secretRefIds: ['secret-a'], lastTest: { state: 'ready' }
  });
  assert.deepEqual(connection.secretRefIds, []);
  assert.deepEqual(connection.endpoint, { host: 'server.test' });
  assert.equal(connection.lastTest, undefined);

  const source = projectWorkspaceControlRecord('source', {
    id: 'source-a', adapterId: 'deployerx.files.local', selector: { roots: [{ path: 'C:\\private', type: 'directory' }], options: {} },
    lastDiscovery: { rootCount: 1 }
  });
  assert.deepEqual(source.selector.roots, []);
  assert.equal(source.localSelectionRequired, true);
  assert.equal(source.lastDiscovery, undefined);

  const job = projectWorkspaceControlRecord('backupJob', {
    id: 'job-a', workerId: 'device:a', lastSuccessfulRunId: 'run-a', scheduleState: { lastRunId: 'run-a' }
  });
  assert.equal(job.workerId, null);
  assert.equal(job.lastSuccessfulRunId, null);
  assert.equal(job.scheduleState, undefined);
});

test('remote merges retain device-local bindings already configured on this device', () => {
  const merged = mergeWorkspaceControlRecord('connection', {
    id: 'connection-a', scope: 'device', adapterId: 'deployerx.local', endpoint: { path: 'C:\\data' },
    secretRefIds: ['secret-local'], lastTest: { state: 'ready' }
  }, {
    id: 'connection-a', scope: 'device', adapterId: 'deployerx.local', endpoint: { host: 'server.test' },
    secretRefIds: [], revision: 3
  });
  assert.deepEqual(merged.secretRefIds, ['secret-local']);
  assert.deepEqual(merged.endpoint, { host: 'server.test', path: 'C:\\data' });
  assert.deepEqual(merged.lastTest, { state: 'ready' });
  assert.equal(merged.revision, 3);
});

test('record comparison and document identities are deterministic', () => {
  assert.ok(compareWorkspaceControlRecords({ updatedAt: '2026-08-12T10:00:00.000Z', revision: 1 }, { updatedAt: '2026-08-12T09:00:00.000Z', revision: 9 }) > 0);
  assert.ok(compareWorkspaceControlRecords({ updatedAt: '2026-08-12T10:00:00.000Z', revision: 2 }, { updatedAt: '2026-08-12T10:00:00.000Z', revision: 1 }) > 0);
  assert.equal(workspaceControlDocumentId('connection', 'same-id'), workspaceControlDocumentId('connection', 'same-id'));
  assert.notEqual(workspaceControlDocumentId('connection', 'same-id'), workspaceControlDocumentId('repository', 'same-id'));
});

test('runtime-only record updates do not trigger workspace writes', () => {
  const previous = {
    id: 'job-a', name: 'Nightly', revision: 1, updatedAt: '2026-08-12T09:00:00.000Z', updatedBy: 'user-a',
    workerId: null, lastSuccessfulRunId: null, scheduleState: null
  };
  const runtimeUpdate = {
    ...previous, revision: 2, updatedAt: '2026-08-12T10:00:00.000Z', updatedBy: 'worker',
    lastSuccessfulRunId: 'run-a', scheduleState: { lastRunId: 'run-a' }
  };
  assert.equal(workspaceControlChangeIsShared('backupJob', previous, runtimeUpdate), false);
  assert.equal(workspaceControlChangeIsShared('backupJob', previous, { ...runtimeUpdate, name: 'Nightly production' }), true);
  assert.equal(workspaceControlRecordsEquivalent('backupJob', previous, runtimeUpdate), true);
});
