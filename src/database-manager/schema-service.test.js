const assert = require('node:assert/strict');
const test = require('node:test');
const { DatabaseSchemaService } = require('./schema-service');

function profile(overrides = {}) {
  return {
    id: 'profile-a', name: 'Orders', driverId: 'postgresql', endpoint: { kind: 'network', host: 'db.example.test', port: 5432 },
    database: 'orders', defaultSchema: 'public', accessMode: 'read-only', environment: 'production', ssl: { mode: 'required' }, tunnel: { type: 'none' },
    settings: { username: 'reader' }, queryTimeoutMs: 5000, credentialSecretRefs: [{ slotId: 'password', secretRefId: 'secret-a' }], ...overrides
  };
}

function snapshot() {
  return { database: 'orders', schemas: [{ name: 'public', tables: [{ name: 'orders', type: 'table', columns: [{ name: 'id', dataType: 'BIGINT', nullable: false, primaryKey: true }] }] }], truncated: false, warnings: [] };
}

function fixture(discoverSchema = async () => snapshot()) {
  const observed = { connection: null, calls: 0 };
  const profileValue = profile();
  const service = new DatabaseSchemaService({
    profileService: { get: async (_workspaceId, id) => id === profileValue.id ? profileValue : null },
    secretStore: { resolve: async () => 'schema-password' },
    runtimeRegistry: { get: () => ({ discoverSchema: async (connection, request, options) => { observed.connection = connection; observed.calls += 1; return discoverSchema(connection, request, options); } }) },
    clock: () => '2026-08-05T13:00:00.000Z'
  });
  return { observed, service };
}

test('loads bounded schema snapshots and clears transient credentials', async () => {
  const values = fixture();
  const loaded = await values.service.load('workspace-a', 'tester', { requestId: 'schema-a', profileId: 'profile-a' });
  assert.equal(loaded.snapshot.schemas[0].tables[0].name, 'orders');
  assert.equal(loaded.loadedAt, '2026-08-05T13:00:00.000Z');
  assert.equal(values.observed.connection.credentials.password, '');
  assert.equal(JSON.stringify(loaded).includes('schema-password'), false);
});

test('loads schema through an open host session without resolving credentials again', async () => {
  let secrets = 0;
  let runtimeSessionId = null;
  let releases = 0;
  const runtime = {
    async discoverSessionSchema(sessionId) { runtimeSessionId = sessionId; return snapshot(); },
    async discoverSchema() { throw new Error('unexpected operation-scoped schema request'); }
  };
  const service = new DatabaseSchemaService({
    profileService: { get: async () => profile() },
    secretStore: { resolve: async () => { secrets += 1; return 'password'; } },
    runtimeRegistry: { get: () => runtime },
    connectionService: { acquire: async () => ({ runtime, runtimeSessionId: 'dbsession_runtime_a', connectionMode: 'logical', release: () => { releases += 1; } }) },
    clock: () => '2026-08-05T13:00:00.000Z'
  });
  const loaded = await service.load('workspace-a', 'tester', { requestId: 'schema-session', profileId: 'profile-a' });
  assert.equal(loaded.snapshot.database, 'orders');
  assert.equal(runtimeSessionId, 'dbsession_runtime_a');
  assert.equal(secrets, 0);
  assert.equal(releases, 1);
});

test('releases an acquired session lease when schema discovery fails', async () => {
  let releases = 0;
  const runtime = {
    async discoverSessionSchema() { throw Object.assign(new Error('Schema failed.'), { code: 'DATABASE_MANAGER_SCHEMA_DISCOVERY_FAILED' }); }
  };
  const service = new DatabaseSchemaService({
    profileService: { get: async () => profile() },
    secretStore: { resolve: async () => { throw new Error('unexpected secret'); } },
    runtimeRegistry: { get: () => runtime },
    connectionService: { acquire: async () => ({ runtime, runtimeSessionId: 'dbsession_runtime_a', connectionMode: 'logical', release: () => { releases += 1; } }) }
  });
  await assert.rejects(
    service.load('workspace-a', 'tester', { requestId: 'schema-session-failure', profileId: 'profile-a' }),
    (error) => error.code === 'DATABASE_MANAGER_SCHEMA_DISCOVERY_FAILED'
  );
  assert.equal(releases, 1);
});

test('rejects missing profiles and malformed driver snapshots', async () => {
  const values = fixture(async () => ({ schemas: [{ name: 'public', tables: [{ name: 'bad', columns: 'invalid' }] }] }));
  await assert.rejects(values.service.load('workspace-a', 'tester', { profileId: 'missing' }), (error) => error.code === 'DATABASE_MANAGER_PROFILE_NOT_FOUND');
  await assert.rejects(values.service.load('workspace-a', 'tester', { profileId: 'profile-a' }), (error) => error.code === 'DATABASE_MANAGER_DRIVER_RESPONSE_INVALID');
});

test('cancels only actor-owned active schema requests', async () => {
  let started;
  const running = new Promise((resolve) => { started = resolve; });
  const values = fixture(async (_connection, _request, { signal }) => {
    started();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'DATABASE_MANAGER_DRIVER_REQUEST_CANCELLED' })), { once: true }));
  });
  const load = values.service.load('workspace-a', 'tester', { requestId: 'schema-cancel', profileId: 'profile-a' });
  await running;
  assert.equal(values.service.cancel('workspace-a', 'other', 'schema-cancel').cancelled, false);
  assert.equal(values.service.cancel('workspace-a', 'tester', 'schema-cancel').cancelled, true);
  await assert.rejects(load, (error) => error.code === 'DATABASE_MANAGER_DRIVER_REQUEST_CANCELLED');
});
