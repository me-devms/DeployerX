const assert = require('node:assert/strict');
const test = require('node:test');
const { DatabaseOperationalLogService, normalizeOptions } = require('./operational-log');

function fixture() {
  return new DatabaseOperationalLogService({
    profileService: { list: async () => [{ id: 'profile-a', name: 'Orders' }] },
    queryWorkspaceStore: { listHistory: async () => [{
      id: 'history-a', profileId: 'profile-a', query: 'SELECT password FROM credentials', source: 'SELECT token FROM secrets', status: 'password-secret', classification: 'C:\\private\\classification',
      executionTimeMs: 7, rowCount: 0, affectedRows: 0, errorCode: 'DATABASE_QUERY_FAILED', safeMessage: 'password leaked', createdAt: '2026-08-06T08:00:00.000Z'
    }] },
    taskService: { list: async () => [{
      id: 'task-a', profileId: 'profile-a', type: 'SELECT api_key FROM settings', state: 'succeeded', label: 'Explain SELECT * FROM secret_table at C:\\private\\orders.sql', progress: { percent: 100, bytesCompleted: 4096 },
      updatedAt: '2026-08-06T09:00:00.000Z', safeMessage: 'C:\\private\\orders.sql'
    }] },
    pluginHealthStore: { list: async () => [{
      pluginId: 'vendor.redis', status: 'warning', lastEvent: 'protocol-error', lastEventAt: '2026-08-06T10:00:00.000Z',
      lastErrorCode: 'DATABASE_MANAGER_DRIVER_PROTOCOL_ERROR', crashCount: 1, protocolErrorCount: 2, stderrEventCount: 3,
      stderr: 'token=secret'
    }] },
    operationalEvidenceStore: { list: async () => [{
      id: 'evidence-connection', workspaceId: 'workspace-a', profileId: 'profile-a', category: 'connection', operation: 'open', state: 'ready',
      code: null, occurredAt: '2026-08-06T11:00:00.000Z', endpoint: 'private.internal', password: 'secret'
    }, {
      id: 'evidence-schema', workspaceId: 'workspace-a', profileId: 'profile-a', category: 'schema', operation: 'create-table', state: 'changed',
      code: null, occurredAt: '2026-08-06T10:30:00.000Z', query: 'CREATE TABLE private_table', objectName: 'private_table'
    }] }
  });
}

test('aggregates sorted bounded operational evidence without SQL, paths, or diagnostics', async () => {
  const result = await fixture().list('workspace-a', { limit: 20 });
  assert.deepEqual(result.entries.map((entry) => entry.category), ['connection', 'schema', 'driver', 'task', 'query']);
  assert.equal(result.entries[0].severity, 'success');
  assert.equal(result.entries[1].severity, 'success');
  assert.equal(result.entries[2].severity, 'warning');
  assert.equal(result.entries[3].profileName, 'Orders');
  assert.equal(result.entries[4].metrics.executionTimeMs, 7);
  assert.equal(result.entries[3].operation, 'task');
  assert.equal(result.entries[4].operation, 'editor-query');
  assert.equal(result.entries[4].state, 'failed');
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /SELECT password|SELECT token|SELECT api_key|SELECT \* FROM secret_table|CREATE TABLE private_table|credentials|secrets|settings|private\.internal|private_table|C:\\\\private|orders\.sql|token=secret|password leaked/);
  assert.match(serialized, /DATABASE_MANAGER_DRIVER_PROTOCOL_ERROR/);
  assert.equal(result.sources.evidence, 'fulfilled');
});

test('filters categories, severities, profiles, and safe search text', async () => {
  const service = fixture();
  assert.deepEqual((await service.list('workspace-a', { categories: ['task'], severities: ['success'] })).entries.map((entry) => entry.id), ['task:task-a']);
  assert.deepEqual((await service.list('workspace-a', { categories: ['connection'] })).entries.map((entry) => entry.id), ['evidence:evidence-connection']);
  assert.deepEqual((await service.list('workspace-a', { categories: ['schema'], severities: ['success'] })).entries.map((entry) => entry.id), ['evidence:evidence-schema']);
  assert.deepEqual((await service.list('workspace-a', { profileId: 'profile-a' })).entries.map((entry) => entry.category), ['connection', 'schema', 'task', 'query']);
  assert.deepEqual((await service.list('workspace-a', { search: 'protocol' })).entries.map((entry) => entry.category), ['driver']);
});

test('returns partial results with source status when one durable source fails', async () => {
  const service = fixture();
  service.queryWorkspaceStore.listHistory = async () => { throw new Error('history unavailable'); };
  const result = await service.list('workspace-a');
  assert.equal(result.sources.queries, 'rejected');
  assert.deepEqual(result.entries.map((entry) => entry.category), ['connection', 'schema', 'driver', 'task']);

  service.queryWorkspaceStore.listHistory = async () => [];
  service.operationalEvidenceStore.list = async () => { throw new Error('evidence unavailable'); };
  const evidenceFailure = await service.list('workspace-a');
  assert.equal(evidenceFailure.sources.evidence, 'rejected');
  assert.deepEqual(evidenceFailure.entries.map((entry) => entry.category), ['driver', 'task']);
});

test('rejects malformed durable evidence instead of coercing it into a connection failure', async () => {
  const service = fixture();
  service.operationalEvidenceStore.list = async () => [{ id: 'bad', profileId: 'profile-a', category: 'credential', operation: 'open', state: 'ready', occurredAt: '2026-08-06T11:00:00.000Z' }];
  await assert.rejects(service.list('workspace-a'), /evidence category/);
});

test('rejects unknown filters and caps log limits', () => {
  assert.throws(() => normalizeOptions({ categories: ['credential'] }), /category/);
  assert.throws(() => normalizeOptions({ severities: ['fatal'] }), /severity/);
  assert.equal(normalizeOptions({ limit: 5000 }).limit, 500);
});
