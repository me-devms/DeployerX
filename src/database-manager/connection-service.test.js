const assert = require('node:assert/strict');
const test = require('node:test');
const { DatabaseConnectionService, normalizeConnectionTestResult, safeStatusCode } = require('./connection-service');

function profile(overrides = {}) {
  return {
    id: 'profile-a',
    driverId: 'postgresql',
    endpoint: { kind: 'network', host: 'db.example.test', port: 5432 },
    database: 'orders',
    defaultSchema: 'public',
    accessMode: 'read-only',
    ssl: { mode: 'verify-full' },
    tunnel: { type: 'none' },
    settings: { username: 'app_user' },
    queryTimeoutMs: 5000,
    credentialSecretRefs: [{ slotId: 'password', secretRefId: 'secret-a' }],
    ...overrides
  };
}

function fixture(profileValue = profile(), runtimeResult = { status: 'success', serverVersion: '16.4', database: 'orders', readOnly: true }) {
  const observed = { marked: [], resolved: [], connection: null };
  const runtime = {
    async testConnection(connection) {
      observed.connection = connection;
      return runtimeResult;
    }
  };
  const service = new DatabaseConnectionService({
    profileService: { get: async (_workspaceId, id) => id === profileValue?.id ? profileValue : null },
    secretStore: {
      resolve: async ({ id }) => { observed.resolved.push(id); return 'database-password'; },
      markValidated: async (input) => { observed.marked.push(input); }
    },
    runtimeRegistry: { get: (driverId) => { assert.equal(driverId, profileValue.driverId); return runtime; } },
    clock: (() => { let now = 1000; return () => (now += 12); })()
  });
  return { observed, service };
}

test('resolves SecretRefs only for the runtime call and returns safe connection evidence', async () => {
  const { observed, service } = fixture();
  const result = await service.test('workspace-a', 'tester', 'profile-a');
  assert.deepEqual(observed.resolved, ['secret-a']);
  assert.equal(observed.connection.credentials.password, '');
  assert.deepEqual(observed.marked, [{ workspaceId: 'workspace-a', id: 'secret-a', actorId: 'tester' }]);
  assert.equal(result.status, 'success');
  assert.equal(result.driverId, 'postgresql');
  assert.equal(result.serverVersion, '16.4');
  assert.equal(result.latencyMs, 12);
  assert.equal(JSON.stringify(result).includes('database-password'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'endpoint'), false);
});

test('requires saved profiles and rejects linked tunnels before resolving credentials', async () => {
  const missing = fixture(null);
  await assert.rejects(missing.service.test('workspace-a', 'tester', 'missing'), (error) => error.code === 'DATABASE_MANAGER_PROFILE_NOT_FOUND');
  const tunneled = fixture(profile({ tunnel: { type: 'server', projectId: 'server-a' } }));
  await assert.rejects(tunneled.service.test('workspace-a', 'tester', 'profile-a'), (error) => error.code === 'DATABASE_MANAGER_TUNNEL_NOT_AVAILABLE');
  assert.deepEqual(tunneled.observed.resolved, []);
});

test('routes connection tests through a short-lived loopback tunnel and closes it after credential clearing', async () => {
  const events = [];
  let runtimeConnection;
  const profileValue = profile({ tunnel: { type: 'server', projectId: 'server-a' } });
  const service = new DatabaseConnectionService({
    profileService: { get: async () => profileValue },
    secretStore: { resolve: async () => 'database-password' },
    runtimeRegistry: { get: () => ({ testConnection: async (connection) => {
      runtimeConnection = connection;
      events.push(`runtime:${connection.endpoint.host}:${connection.endpoint.port}`);
      return { status: 'success', database: 'orders' };
    } }) },
    tunnelProvider: { open: async ({ workspaceId, profile: linkedProfile }) => {
      assert.equal(workspaceId, 'workspace-a');
      assert.equal(linkedProfile.endpoint.host, 'db.example.test');
      events.push('tunnel-open');
      return { host: '127.0.0.1', port: 43123, close: async () => events.push(`tunnel-close:${runtimeConnection.credentials.password}`) };
    } },
    clock: () => 1000
  });
  const result = await service.test('workspace-a', 'tester', 'profile-a');
  assert.equal(result.status, 'success');
  assert.deepEqual(runtimeConnection.endpoint, { kind: 'network', host: '127.0.0.1', port: 43123 });
  assert.deepEqual(profileValue.endpoint, { kind: 'network', host: 'db.example.test', port: 5432 });
  assert.deepEqual(events, ['tunnel-open', 'runtime:127.0.0.1:43123', 'tunnel-close:']);
});

test('retains a linked-server tunnel for a physical session and releases it after the runtime pool', async () => {
  const events = [];
  const profileValue = profile({ revision: 4, tunnel: { type: 'server', projectId: 'server-a' } });
  const runtime = {
    async openConnection(connection) {
      events.push(`runtime-open:${connection.endpoint.host}:${connection.endpoint.port}`);
      return { status: 'success', connectionMode: 'physical-pool', runtimeSessionId: 'dbsession_tunnel', evidence: { status: 'success' } };
    },
    async closeConnection() { events.push('runtime-close'); }
  };
  const service = new DatabaseConnectionService({
    profileService: { get: async () => profileValue },
    secretStore: { resolve: async () => 'database-password' },
    runtimeRegistry: { get: () => runtime },
    tunnelProvider: { open: async () => ({ host: '127.0.0.1', port: 43124, close: async () => events.push('tunnel-close') }) },
    clock: () => 1000
  });
  const opened = await service.open('workspace-a', 'tester', 'profile-a');
  assert.equal(opened.state, 'ready');
  assert.deepEqual(events, ['runtime-open:127.0.0.1:43124']);
  await service.close('workspace-a', 'tester', 'profile-a');
  assert.deepEqual(events, ['runtime-open:127.0.0.1:43124', 'runtime-close', 'tunnel-close']);
});

test('closes an acquired tunnel when database credential resolution fails', async () => {
  let closed = 0;
  const profileValue = profile({ tunnel: { type: 'server', projectId: 'server-a' } });
  const service = new DatabaseConnectionService({
    profileService: { get: async () => profileValue },
    secretStore: { resolve: async () => { throw new Error('private secret error'); } },
    runtimeRegistry: { get: () => ({ testConnection: async () => { throw new Error('unexpected runtime call'); } }) },
    tunnelProvider: { open: async () => ({ host: '127.0.0.1', port: 43125, close: async () => { closed += 1; } }) }
  });
  await assert.rejects(service.test('workspace-a', 'tester', 'profile-a'), (error) => error.code === 'DATABASE_MANAGER_CREDENTIAL_RESOLUTION_FAILED' && !error.message.includes('private'));
  assert.equal(closed, 1);
});

test('requires a device-local SQLite binding and passes it only to the driver', async () => {
  const sqliteProfile = profile({ driverId: 'sqlite', endpoint: { kind: 'file', localResourceRequired: true }, database: null, credentialSecretRefs: [] });
  const withoutBinding = fixture(sqliteProfile);
  await assert.rejects(withoutBinding.service.test('workspace-a', 'tester', 'profile-a'), (error) => error.code === 'DATABASE_MANAGER_LOCAL_RESOURCE_REQUIRED');

  let runtimeConnection;
  const service = new DatabaseConnectionService({
    profileService: { get: async () => sqliteProfile },
    secretStore: { resolve: async () => { throw new Error('unexpected secret'); } },
    runtimeRegistry: { get: () => ({ testConnection: async (connection) => { runtimeConnection = connection; return { status: 'success', database: 'main' }; } }) },
    localResourceResolver: async () => 'C:\\data\\local.sqlite',
    clock: () => 1000
  });
  const result = await service.test('workspace-a', 'tester', 'profile-a');
  assert.equal(runtimeConnection.endpoint.path, 'C:\\data\\local.sqlite');
  assert.equal(JSON.stringify(result).includes('local.sqlite'), false);
});

test('normalizes failure evidence and rejects malformed driver responses', () => {
  const failure = normalizeConnectionTestResult({ status: 'failure', latencyMs: 9, error: { code: 'AUTH_FAILED', safeMessage: 'Authentication failed.', retryable: false } }, 'profile-a', 'mysql', 10);
  assert.deepEqual(failure.error, { code: 'AUTH_FAILED', safeMessage: 'Authentication failed.', retryable: false });
  assert.throws(() => normalizeConnectionTestResult({ status: 'unknown' }, 'profile-a', 'mysql', 10), (error) => error.code === 'DATABASE_MANAGER_DRIVER_RESPONSE_INVALID');
});

test('owns an open host session by workspace, actor, profile revision, and clears resolved credentials', async () => {
  const observed = { opened: null, closed: [] };
  const runtime = {
    async testConnection() { throw new Error('unexpected connection test'); },
    async openConnection(connection) {
      observed.opened = connection;
      return {
        status: 'success',
        connectionMode: 'physical-pool',
        runtimeSessionId: 'dbsession_runtime_a',
        evidence: { status: 'success', latencyMs: 5, serverVersion: '16.4', database: 'orders', readOnly: true }
      };
    },
    async connectionStatus() { return { status: 'ready' }; },
    async closeConnection(id) { observed.closed.push(id); return { status: 'closed', closed: true }; }
  };
  const profileValue = profile({ revision: 7 });
  const service = new DatabaseConnectionService({
    profileService: { get: async () => profileValue },
    secretStore: { resolve: async () => 'database-password', markValidated: async () => {} },
    runtimeRegistry: { get: () => runtime },
    clock: () => 1000,
    idleTimeoutMs: 5000
  });

  const opened = await service.open('workspace-a', 'tester', 'profile-a');
  assert.equal(opened.state, 'ready');
  assert.equal(opened.connectionMode, 'physical-pool');
  assert.match(opened.sessionId, /^dbconn_/);
  assert.equal(observed.opened.credentials.password, '');
  assert.equal(JSON.stringify(opened).includes('database-password'), false);
  assert.equal((await service.status('workspace-a', 'tester', 'profile-a')).state, 'ready');
  assert.equal(await service.acquire('workspace-a', 'other-actor', profileValue), null);
  assert.equal((await service.acquire('workspace-a', 'tester', profileValue)).runtimeSessionId, 'dbsession_runtime_a');
  assert.equal((await service.listStatus('workspace-a', 'tester')).length, 1);
  assert.equal((await service.close('workspace-a', 'tester', 'profile-a')).closed, true);
  assert.deepEqual(observed.closed, ['dbsession_runtime_a']);
});

test('expires idle sessions and invalidates sessions when a profile revision changes', async () => {
  let now = 1000;
  let revision = 1;
  const closed = [];
  const runtime = {
    async openConnection() { return { status: 'success', connectionMode: 'physical-pool', runtimeSessionId: `dbsession_${revision}_runtime`, evidence: { status: 'success' } }; },
    async closeConnection(id) { closed.push(id); }
  };
  const service = new DatabaseConnectionService({
    profileService: { get: async () => profile({ revision }) },
    secretStore: { resolve: async () => 'password' },
    runtimeRegistry: { get: () => runtime },
    clock: () => now,
    idleTimeoutMs: 1000
  });

  await service.open('workspace-a', 'tester', 'profile-a');
  revision = 2;
  assert.equal((await service.status('workspace-a', 'tester', 'profile-a')).state, 'closed');
  await service.open('workspace-a', 'tester', 'profile-a');
  now = 2000;
  assert.equal((await service.status('workspace-a', 'tester', 'profile-a')).state, 'closed');
  assert.deepEqual(closed, ['dbsession_1_runtime', 'dbsession_2_runtime']);
});

test('does not prune an idle session while an acquired operation lease is active', async () => {
  let now = 1000;
  const closed = [];
  const profileValue = profile({ revision: 1 });
  const runtime = {
    async openConnection() { return { status: 'success', connectionMode: 'physical-pool', runtimeSessionId: 'dbsession_leased', evidence: { status: 'success' } }; },
    async closeConnection(id) { closed.push(id); }
  };
  const service = new DatabaseConnectionService({
    profileService: { get: async () => profileValue },
    secretStore: { resolve: async () => 'password' },
    runtimeRegistry: { get: () => runtime },
    clock: () => now,
    idleTimeoutMs: 1000
  });

  await service.open('workspace-a', 'tester', 'profile-a');
  const lease = await service.acquire('workspace-a', 'tester', profileValue);
  now = 2500;
  assert.equal((await service.status('workspace-a', 'tester', 'profile-a')).state, 'ready');
  assert.deepEqual(closed, []);

  lease.release();
  lease.release();
  now = 3499;
  assert.equal((await service.status('workspace-a', 'tester', 'profile-a')).state, 'ready');
  now = 3500;
  assert.equal((await service.status('workspace-a', 'tester', 'profile-a')).state, 'closed');
  assert.deepEqual(closed, ['dbsession_leased']);
});

test('keeps plugin connection state explicitly operation scoped', async () => {
  const service = new DatabaseConnectionService({
    profileService: { get: async () => profile({ driverId: 'vendor.fixture', credentialSecretRefs: [] }) },
    secretStore: { resolve: async () => { throw new Error('unexpected secret'); } },
    runtimeRegistry: { get: () => ({
      openConnection: async () => ({ status: 'success', connectionMode: 'operation-scoped', evidence: { status: 'success' } }),
      testConnection: async () => ({ status: 'success' })
    }) },
    clock: () => 1000
  });
  const opened = await service.open('workspace-a', 'tester', 'profile-a');
  assert.equal(opened.connectionMode, 'operation-scoped');
  assert.equal((await service.acquire('workspace-a', 'tester', profile({ driverId: 'vendor.fixture', credentialSecretRefs: [] }))).runtimeSessionId, null);
});

test('evicts unhealthy pooled sessions and returns only a safe status code', async () => {
  const closed = [];
  const runtime = {
    async openConnection() { return { status: 'success', connectionMode: 'physical-pool', runtimeSessionId: 'dbsession_unhealthy', evidence: { status: 'success' } }; },
    async connectionStatus() { return { status: 'failed', code: 'DATABASE_POOL_UNREACHABLE', retryable: true }; },
    async closeConnection(id) { closed.push(id); }
  };
  const profileValue = profile({ revision: 3 });
  const service = new DatabaseConnectionService({
    profileService: { get: async () => profileValue },
    secretStore: { resolve: async () => 'password' },
    runtimeRegistry: { get: () => runtime },
    clock: () => 1000
  });
  await service.open('workspace-a', 'tester', 'profile-a');
  const status = await service.status('workspace-a', 'tester', 'profile-a');
  assert.equal(status.state, 'failed');
  assert.equal(status.code, 'DATABASE_POOL_UNREACHABLE');
  assert.equal(status.sessionId, null);
  assert.equal(Object.prototype.hasOwnProperty.call(status, 'safeMessage'), false);
  assert.equal(await service.acquire('workspace-a', 'tester', profileValue), null);
  assert.deepEqual(closed, ['dbsession_unhealthy']);
  assert.equal(safeStatusCode('path C:\\private'), 'DATABASE_MANAGER_CONNECTION_HEALTH_FAILED');
});

test('converts driver-host status errors into failed state and probes sessions when listing', async () => {
  let checks = 0;
  const runtime = {
    async openConnection() { return { status: 'success', connectionMode: 'physical-pool', runtimeSessionId: 'dbsession_crashed', evidence: { status: 'success' } }; },
    async connectionStatus() { checks += 1; throw Object.assign(new Error('private host details'), { code: 'DATABASE_MANAGER_DRIVER_HOST_EXITED' }); },
    async closeConnection() {}
  };
  const service = new DatabaseConnectionService({
    profileService: { get: async () => profile({ revision: 1 }) },
    secretStore: { resolve: async () => 'password' },
    runtimeRegistry: { get: () => runtime },
    clock: () => 1000
  });
  await service.open('workspace-a', 'tester', 'profile-a');
  const statuses = await service.listStatus('workspace-a', 'tester');
  assert.equal(checks, 1);
  assert.deepEqual(statuses.map((status) => ({ state: status.state, code: status.code })), [{ state: 'failed', code: 'DATABASE_MANAGER_DRIVER_HOST_EXITED' }]);
  assert.equal(JSON.stringify(statuses).includes('private host details'), false);
});
