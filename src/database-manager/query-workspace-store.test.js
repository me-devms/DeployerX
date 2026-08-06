const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { BackupControlDatabase } = require('../backup-manager/control-database');
const { DatabaseQueryWorkspaceStore } = require('./query-workspace-store');

async function fixture(context, historyLimit = 3) {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-query-workspace-test-'));
  let currentMs = Date.parse('2026-08-05T14:00:00.000Z');
  const controlDatabase = new BackupControlDatabase({ rootPath, clock: () => new Date(currentMs).toISOString() });
  await controlDatabase.initialize();
  const connection = await controlDatabase.repository('connection').create({
    workspaceId: 'workspace-a', actorId: 'tester', name: 'Orders database', kind: 'database',
    adapterId: 'deployerx.database-manager.sqlite', adapterVersion: '1.0.0', scope: 'device',
    endpoint: { kind: 'file' }, secretRefIds: [], trust: {}, workerAffinity: []
  });
  const profile = await controlDatabase.repository('databaseProfile').create({
    workspaceId: 'workspace-a', actorId: 'tester', name: 'Orders SQLite', sharedConnectionId: connection.id,
    driverId: 'sqlite', environment: 'development', accessMode: 'read-write', credentialSecretRefs: []
  });
  context.after(async () => {
    await controlDatabase.close();
    await fs.rm(rootPath, { recursive: true, force: true });
  });
  return {
    controlDatabase,
    profile,
    store: new DatabaseQueryWorkspaceStore({ controlDatabase, historyLimit }),
    advance(ms = 1000) { currentMs += ms; }
  };
}

test('creates, searches, updates, and soft-deletes revisioned saved queries', async (context) => {
  const values = await fixture(context);
  const created = await values.store.createSavedQuery('workspace-a', 'tester', {
    profileId: values.profile.id, name: 'Recent orders', description: 'Daily review', query: 'SELECT * FROM orders', tags: ['ops']
  });
  assert.equal(created.revision, 1);
  assert.equal((await values.store.listSavedQueries('workspace-a', { profileId: values.profile.id, search: 'daily' }))[0].id, created.id);
  assert.equal(await values.store.getSavedQuery('workspace-b', created.id), null);
  values.advance();
  const updated = await values.store.updateSavedQuery('workspace-a', 'editor', created.id, { name: 'Recent paid orders', query: "SELECT * FROM orders WHERE status = 'paid'" }, created.revision);
  assert.equal(updated.revision, 2);
  await assert.rejects(values.store.updateSavedQuery('workspace-a', 'editor', created.id, { name: 'Stale' }, 1), (error) => error.code === 'BACKUP_CONTROL_REVISION_CONFLICT');
  await assert.rejects(values.store.createSavedQuery('workspace-a', 'tester', { profileId: values.profile.id, name: 'RECENT PAID ORDERS', query: 'SELECT 1' }), (error) => error.code === 'DATABASE_MANAGER_SAVED_QUERY_NAME_EXISTS');
  await values.store.deleteSavedQuery('workspace-a', 'editor', created.id, updated.revision);
  assert.equal((await values.store.listSavedQueries('workspace-a')).length, 0);
});

test('requires profiles in the same workspace for saved queries and history', async (context) => {
  const values = await fixture(context);
  await assert.rejects(values.store.createSavedQuery('workspace-b', 'tester', { profileId: values.profile.id, name: 'Wrong workspace', query: 'SELECT 1' }), (error) => error.code === 'DATABASE_MANAGER_PROFILE_NOT_FOUND');
  await assert.rejects(values.store.recordHistory('workspace-b', 'tester', { profileId: values.profile.id, query: 'SELECT 1', status: 'succeeded' }), (error) => error.code === 'DATABASE_MANAGER_PROFILE_NOT_FOUND');
});

test('records bounded history and clears one profile without mutable history CRUD', async (context) => {
  const values = await fixture(context, 3);
  for (let index = 1; index <= 4; index += 1) {
    await values.store.recordHistory('workspace-a', 'tester', {
      profileId: values.profile.id, query: `SELECT ${index}`, source: 'editor', status: index === 2 ? 'failed' : 'succeeded',
      classification: 'read', executionTimeMs: index, rowCount: index === 2 ? 0 : 1, affectedRows: 0,
      errorCode: index === 2 ? 'DATABASE_MANAGER_QUERY_FAILED' : null, safeMessage: index === 2 ? 'Query failed.' : null
    });
    values.advance();
  }
  const history = await values.store.listHistory('workspace-a');
  assert.deepEqual(history.map((entry) => entry.query), ['SELECT 4', 'SELECT 3', 'SELECT 2']);
  await assert.rejects(values.controlDatabase.repository('databaseQueryHistory').update('workspace-a', history[0].id, { status: 'failed' }), /cannot be changed/);
  assert.deepEqual(await values.store.clearHistory('workspace-a', { profileId: values.profile.id }), { deletedCount: 3, profileId: values.profile.id });
  assert.equal((await values.store.listHistory('workspace-a')).length, 0);
});

test('persists revisioned notebooks without execution results', async (context) => {
  const values = await fixture(context);
  const created = await values.store.createNotebook('workspace-a', 'tester', {
    profileId: values.profile.id, name: 'Operations review', description: 'Daily checks', tags: ['ops'],
    cells: [{ id: 'notes', type: 'markdown', content: '# Review' }, { id: 'orders', type: 'sql', content: 'SELECT * FROM orders' }]
  });
  assert.equal(created.revision, 1);
  assert.equal(created.cells.length, 2);
  assert.equal(Object.hasOwn(created.cells[1], 'result'), false);
  assert.equal((await values.store.listNotebooks('workspace-a', { profileId: values.profile.id, search: 'daily' }))[0].id, created.id);
  assert.equal(await values.store.getNotebook('workspace-b', created.id), null);
  values.advance();
  const updated = await values.store.updateNotebook('workspace-a', 'editor', created.id, {
    name: 'Operations review v2', cells: [{ id: 'orders', type: 'sql', content: 'SELECT id FROM orders' }]
  }, created.revision);
  assert.equal(updated.revision, 2);
  assert.equal(updated.cells[0].content, 'SELECT id FROM orders');
  await assert.rejects(values.store.updateNotebook('workspace-a', 'editor', created.id, { name: 'Stale' }, 1), (error) => error.code === 'BACKUP_CONTROL_REVISION_CONFLICT');
  await assert.rejects(values.store.createNotebook('workspace-a', 'tester', { profileId: values.profile.id, name: 'OPERATIONS REVIEW V2', cells: [{ id: 'x', type: 'sql', content: '' }] }), (error) => error.code === 'DATABASE_MANAGER_NOTEBOOK_NAME_EXISTS');
  await values.store.deleteNotebook('workspace-a', 'editor', created.id, updated.revision);
  assert.equal((await values.store.listNotebooks('workspace-a')).length, 0);
});

test('rejects cross-workspace notebook profile references', async (context) => {
  const values = await fixture(context);
  await assert.rejects(values.store.createNotebook('workspace-b', 'tester', {
    profileId: values.profile.id, name: 'Wrong workspace', cells: [{ id: 'query', type: 'sql', content: 'SELECT 1' }]
  }), (error) => error.code === 'DATABASE_MANAGER_PROFILE_NOT_FOUND');
});
