const assert = require('node:assert/strict');
const test = require('node:test');
const { DatabaseQueryService } = require('./query-service');

function profile(overrides = {}) {
  return {
    id: 'profile-a', name: 'Orders Production', driverId: 'postgresql',
    endpoint: { kind: 'network', host: 'db.example.test', port: 5432 }, database: 'orders', defaultSchema: 'public',
    accessMode: 'read-write', environment: 'production', ssl: { mode: 'required' }, tunnel: { type: 'none' },
    settings: { username: 'app_user' }, queryTimeoutMs: 5000,
    credentialSecretRefs: [{ slotId: 'password', secretRefId: 'secret-a' }],
    ...overrides
  };
}

function result(overrides = {}) {
  return {
    columns: [{ name: 'id', dataType: 'BIGINT' }, { name: 'name', dataType: 'TEXT' }],
    rows: [[1, 'first']], affectedRows: 0, truncated: false,
    pagination: { page: 1, pageSize: 100, totalRows: null, hasMore: false }, executionTimeMs: 4, warnings: [], additionalResults: [],
    ...overrides
  };
}

function fixture(profileValue = profile(), executeQuery = async () => result(), driverPolicy = null) {
  const observed = { calls: 0, connection: null, requests: [], secrets: 0, history: [] };
  const runtime = {
    async executeQuery(connection, request, options) {
      observed.calls += 1;
      observed.connection = connection;
      observed.requests.push(request);
      return executeQuery(connection, request, options);
    }
  };
  const runtimeRegistry = { get: () => runtime };
  if (driverPolicy) runtimeRegistry.getPolicy = () => driverPolicy;
  const service = new DatabaseQueryService({
    profileService: { get: async (_workspaceId, id) => id === profileValue.id ? profileValue : null },
    secretStore: { resolve: async () => { observed.secrets += 1; return 'query-password'; } },
    runtimeRegistry,
    historyRecorder: async (workspaceId, actorId, entry) => observed.history.push({ workspaceId, actorId, ...entry })
  });
  return { observed, service };
}

test('executes normalized reads and clears transient credentials', async () => {
  const values = fixture();
  const executed = await values.service.execute('workspace-a', 'tester', { requestId: 'query-a', profileId: 'profile-a', query: 'SELECT id, name FROM users' });
  assert.equal(executed.classification, 'read');
  assert.equal(executed.result.rows[0][1], 'first');
  assert.equal(values.observed.connection.credentials.password, '');
  assert.equal(JSON.stringify(executed).includes('query-password'), false);
  assert.deepEqual(values.observed.history.map((entry) => ({ status: entry.status, classification: entry.classification, rowCount: entry.rowCount })), [{ status: 'succeeded', classification: 'read', rowCount: 1 }]);
});

test('keeps an operation-scoped linked-server tunnel open through query completion', async () => {
  const events = [];
  let connection;
  const service = new DatabaseQueryService({
    profileService: { get: async () => profile({ environment: 'development', tunnel: { type: 'server', projectId: 'server-a' } }) },
    secretStore: { resolve: async () => 'query-password' },
    runtimeRegistry: { get: () => ({ executeQuery: async (resolved) => { connection = resolved; events.push(`query:${resolved.endpoint.host}:${resolved.endpoint.port}`); return result(); } }) },
    tunnelProvider: { open: async () => ({ host: '127.0.0.1', port: 43126, close: async () => events.push(`close:${connection.credentials.password}`) }) }
  });
  const executed = await service.execute('workspace-a', 'tester', { requestId: 'query-tunnel', profileId: 'profile-a', query: 'SELECT 1' });
  assert.equal(executed.result.rows.length, 1);
  assert.deepEqual(events, ['query:127.0.0.1:43126', 'close:']);
});

test('reuses an actor-owned host session without resolving credentials again', async () => {
  let secrets = 0;
  let runtimeSessionId = null;
  let releases = 0;
  const runtime = {
    async executeSessionQuery(sessionId) { runtimeSessionId = sessionId; return result(); },
    async executeQuery() { throw new Error('unexpected operation-scoped query'); }
  };
  const service = new DatabaseQueryService({
    profileService: { get: async () => profile({ environment: 'development' }) },
    secretStore: { resolve: async () => { secrets += 1; return 'password'; } },
    runtimeRegistry: { get: () => runtime },
    connectionService: { acquire: async () => ({ runtime, runtimeSessionId: 'dbsession_runtime_a', connectionMode: 'logical', release: () => { releases += 1; } }) }
  });
  const executed = await service.execute('workspace-a', 'tester', { requestId: 'query-session', profileId: 'profile-a', query: 'SELECT 1' });
  assert.equal(executed.result.rows.length, 1);
  assert.equal(runtimeSessionId, 'dbsession_runtime_a');
  assert.equal(secrets, 0);
  assert.equal(releases, 1);
});

test('releases an acquired session lease when query execution fails', async () => {
  let releases = 0;
  const runtime = {
    async executeSessionQuery() { throw Object.assign(new Error('Query failed.'), { code: 'DATABASE_MANAGER_QUERY_FAILED' }); }
  };
  const service = new DatabaseQueryService({
    profileService: { get: async () => profile({ environment: 'development' }) },
    secretStore: { resolve: async () => { throw new Error('unexpected secret'); } },
    runtimeRegistry: { get: () => runtime },
    connectionService: { acquire: async () => ({ runtime, runtimeSessionId: 'dbsession_runtime_a', connectionMode: 'logical', release: () => { releases += 1; } }) }
  });
  await assert.rejects(
    service.execute('workspace-a', 'tester', { requestId: 'query-session-failure', profileId: 'profile-a', query: 'SELECT 1' }),
    (error) => error.code === 'DATABASE_MANAGER_QUERY_FAILED'
  );
  assert.equal(releases, 1);
});

test('rejects read-only writes before resolving secrets or invoking a driver', async () => {
  const values = fixture(profile({ accessMode: 'read-only' }));
  await assert.rejects(values.service.execute('workspace-a', 'tester', { profileId: 'profile-a', query: 'UPDATE users SET active = 1 WHERE id = 2' }), (error) => error.code === 'DATABASE_MANAGER_READ_ONLY_VIOLATION');
  assert.equal(values.observed.calls, 0);
  assert.equal(values.observed.secrets, 0);
  assert.equal(values.observed.history.length, 0);
});

test('enforces full-result export reads before resolving secrets', async () => {
  const values = fixture(profile({ environment: 'development' }));
  await assert.rejects(
    values.service.executeReadPage('workspace-a', 'tester', { profileId: 'profile-a', query: 'UPDATE users SET active = 1' }),
    (error) => error.code === 'DATABASE_MANAGER_RESULT_EXPORT_READ_REQUIRED'
  );
  assert.equal(values.observed.calls, 0);
  assert.equal(values.observed.secrets, 0);
  const executed = await values.service.executeReadPage('workspace-a', 'tester', { profileId: 'profile-a', query: 'SELECT id FROM users', page: 2 });
  assert.equal(executed.classification, 'read');
  assert.equal(values.observed.requests[0].page, 2);
  assert.equal(values.observed.history.length, 0);
});

test('enforces plugin-declared read-only and query capabilities before resolving secrets', async () => {
  const pluginProfile = profile({ driverId: 'vendor.analytics', environment: 'development', accessMode: 'read-write' });
  const readOnly = fixture(pluginProfile, async () => result(), { sqlDialect: 'postgresql', query: true, readOnly: true });
  await assert.rejects(
    readOnly.service.execute('workspace-a', 'tester', { profileId: 'profile-a', query: 'WITH changed AS (DELETE FROM users RETURNING *) SELECT * FROM changed' }),
    (error) => error.code === 'DATABASE_MANAGER_READ_ONLY_VIOLATION' && error.details.classification === 'destructive'
  );
  assert.equal(readOnly.observed.secrets, 0);
  assert.equal(readOnly.observed.calls, 0);

  const unavailable = fixture(pluginProfile, async () => result(), { sqlDialect: 'generic', query: false, readOnly: false });
  await assert.rejects(
    unavailable.service.execute('workspace-a', 'tester', { profileId: 'profile-a', query: 'SELECT 1' }),
    (error) => error.code === 'DATABASE_MANAGER_DRIVER_QUERY_UNSUPPORTED'
  );
  assert.equal(unavailable.observed.secrets, 0);
  assert.equal(unavailable.observed.calls, 0);
});

test('rejects implicit multi-statement execution before resolving secrets', async () => {
  const values = fixture(profile({ environment: 'development' }));
  await assert.rejects(
    values.service.execute('workspace-a', 'tester', { profileId: 'profile-a', query: 'SELECT 1; SELECT 2' }),
    (error) => error.code === 'DATABASE_MANAGER_BATCH_REQUIRED' && error.details.statementCount === 2
  );
  assert.equal(values.observed.calls, 0);
  assert.equal(values.observed.secrets, 0);
  assert.equal(values.observed.history.length, 0);
});

test('requires production mutation and typed destructive approvals', async () => {
  const values = fixture();
  await assert.rejects(values.service.execute('workspace-a', 'tester', { profileId: 'profile-a', query: 'UPDATE users SET active = 1 WHERE id = 2' }), (error) => error.code === 'DATABASE_MANAGER_QUERY_CONFIRMATION_REQUIRED');
  const mutation = await values.service.execute('workspace-a', 'tester', { profileId: 'profile-a', query: 'UPDATE users SET active = 1 WHERE id = 2', approval: { confirmed: true } });
  assert.equal(mutation.classification, 'mutation');
  await assert.rejects(values.service.execute('workspace-a', 'tester', { profileId: 'profile-a', query: 'DROP TABLE users', approval: { confirmed: true } }), (error) => error.code === 'DATABASE_MANAGER_QUERY_TYPED_CONFIRMATION_REQUIRED');
  const destructive = await values.service.execute('workspace-a', 'tester', { profileId: 'profile-a', query: 'DROP TABLE users', approval: { confirmed: true, typedProfileName: 'Orders Production' } });
  assert.equal(destructive.classification, 'destructive');
});

test('cancels only actor-owned active requests and clears operation ownership', async () => {
  let started;
  const running = new Promise((resolve) => { started = resolve; });
  const values = fixture(profile({ environment: 'development' }), async (_connection, _request, { signal }) => {
    started();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'DATABASE_MANAGER_DRIVER_REQUEST_CANCELLED' })), { once: true }));
  });
  const execution = values.service.execute('workspace-a', 'tester', { requestId: 'query-cancel', profileId: 'profile-a', query: 'SELECT 1' });
  await running;
  assert.deepEqual(values.service.cancel('workspace-a', 'other-user', 'query-cancel'), { requestId: 'query-cancel', cancelled: false });
  assert.deepEqual(values.service.cancel('workspace-a', 'tester', 'query-cancel'), { requestId: 'query-cancel', cancelled: true });
  await assert.rejects(execution, (error) => error.code === 'DATABASE_MANAGER_DRIVER_REQUEST_CANCELLED');
  assert.equal(values.observed.history[0].status, 'cancelled');
  assert.deepEqual(values.service.cancel('workspace-a', 'tester', 'query-cancel'), { requestId: 'query-cancel', cancelled: false });
});

test('rejects malformed driver results at the service boundary', async () => {
  const values = fixture(profile({ environment: 'development' }), async () => ({ columns: ['id'], rows: [[1, 2]] }));
  await assert.rejects(values.service.execute('workspace-a', 'tester', { profileId: 'profile-a', query: 'SELECT 1' }), (error) => error.code === 'DATABASE_MANAGER_DRIVER_RESPONSE_INVALID');
  assert.equal(values.observed.history[0].status, 'failed');
  assert.equal(values.observed.history[0].errorCode, 'DATABASE_MANAGER_DRIVER_RESPONSE_INVALID');
});

test('does not let history persistence failures change query outcomes', async () => {
  const values = fixture(profile({ environment: 'development' }));
  values.service.historyRecorder = async () => { throw new Error('history disk unavailable'); };
  const executed = await values.service.execute('workspace-a', 'tester', { profileId: 'profile-a', query: 'SELECT 1' });
  assert.equal(executed.result.rows.length, 1);
});

test('executes explicit batches sequentially and combines bounded statement results', async () => {
  const values = fixture(profile({ environment: 'development' }), async (_connection, request) => result({
    rows: [[request.query.includes('2') ? 2 : 1, request.query]],
    executionTimeMs: request.query.includes('2') ? 3 : 2
  }));
  const executed = await values.service.execute('workspace-a', 'tester', {
    requestId: 'query-batch', profileId: 'profile-a', query: "SELECT ';' AS value; SELECT 2", batch: true
  });
  assert.equal(executed.statementCount, 2);
  assert.equal(values.observed.calls, 2);
  assert.deepEqual(values.observed.requests.map((request) => ({ query: request.query, batch: request.batch, page: request.page })), [
    { query: "SELECT ';' AS value", batch: false, page: 1 },
    { query: 'SELECT 2', batch: false, page: 1 }
  ]);
  assert.equal(executed.result.rows[0][0], 1);
  assert.equal(executed.result.additionalResults[0].rows[0][0], 2);
  assert.equal(executed.result.executionTimeMs, 2);
  assert.equal(executed.totalExecutionTimeMs, 5);
  assert.equal(values.observed.history[0].rowCount, 2);
});

test('stops an explicit batch on the first failed statement with safe progress details', async () => {
  const values = fixture(profile({ environment: 'development' }), async (_connection, request) => {
    if (request.query.includes('missing')) throw Object.assign(new Error('Query failed.'), { code: 'DATABASE_MANAGER_QUERY_FAILED', safeMessage: 'Query failed.' });
    return result();
  });
  await assert.rejects(
    values.service.execute('workspace-a', 'tester', { profileId: 'profile-a', query: 'SELECT 1; SELECT * FROM missing; SELECT 3', batch: true }),
    (error) => error.code === 'DATABASE_MANAGER_QUERY_FAILED' && error.details.statementIndex === 2 && error.details.completedStatementCount === 1
  );
  assert.equal(values.observed.calls, 2);
  assert.equal(values.observed.history[0].status, 'failed');
});
