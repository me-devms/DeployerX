const assert = require('node:assert/strict');
const test = require('node:test');
const { DATABASE_MANAGER_EVENT_VERSION, createDatabaseManagerEvent } = require('./event-contract');

test('creates versioned, bounded lifecycle events', () => {
  const event = createDatabaseManagerEvent('query-progress', 'workspace-a', {
    requestId: 'query-a', profileId: 'profile-a', state: 'succeeded', statementCount: 1, rowCount: 25
  }, { sequence: 7, occurredAt: '2026-08-05T12:00:00.000Z' });
  assert.deepEqual(event, {
    databaseManagerEventVersion: DATABASE_MANAGER_EVENT_VERSION,
    sequence: 7,
    type: 'query-progress',
    workspaceId: 'workspace-a',
    occurredAt: '2026-08-05T12:00:00.000Z',
    payload: { requestId: 'query-a', profileId: 'profile-a', state: 'succeeded', statementCount: 1, rowCount: 25, code: null }
  });
  assert.equal(Object.isFrozen(event), true);
  assert.equal(Object.isFrozen(event.payload), true);
});

test('whitelists event fields so sensitive and unbounded values are dropped', () => {
  const event = createDatabaseManagerEvent('connection-status', 'workspace-a', {
    profileId: 'profile-a', state: 'failed', operation: 'test', code: 'DATABASE_CONNECTION_FAILED',
    password: 'do-not-send', query: 'SELECT secret FROM credentials', path: 'C:\\private\\database.sqlite', safeMessage: 'unbounded message'
  }, { sequence: 1 });
  const encoded = JSON.stringify(event);
  assert.equal(encoded.includes('do-not-send'), false);
  assert.equal(encoded.includes('SELECT secret'), false);
  assert.equal(encoded.includes('private'), false);
  assert.equal(encoded.includes('unbounded message'), false);
});

test('normalizes task and plugin events and rejects malformed state', () => {
  const task = createDatabaseManagerEvent('task-state', 'local', {
    taskId: 'task-a', profileId: 'profile-a', state: 'running', phase: 'copying', percent: 42.5
  }, { sequence: 2 });
  assert.equal(task.payload.percent, 42.5);
  const plugin = createDatabaseManagerEvent('plugin-state', 'local', { state: 'catalog-refreshed' }, { sequence: 3 });
  assert.equal(plugin.payload.pluginId, null);
  assert.throws(() => createDatabaseManagerEvent('query-progress', 'local', { requestId: 'a', profileId: 'b', state: 'unknown' }, { sequence: 4 }), (error) => error.code === 'DATABASE_MANAGER_EVENT_INVALID');
  assert.throws(() => createDatabaseManagerEvent('unknown', 'local', { state: 'running' }, { sequence: 5 }), (error) => error.code === 'DATABASE_MANAGER_EVENT_INVALID');
  assert.throws(() => createDatabaseManagerEvent('plugin-state', 'local', { pluginId: 'safe', state: 'warning', code: 'path C:\\private' }, { sequence: 6 }), (error) => error.code === 'DATABASE_MANAGER_EVENT_INVALID');
});
