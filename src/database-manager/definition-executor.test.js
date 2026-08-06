const assert = require('node:assert/strict');
const test = require('node:test');
const { DatabaseDefinitionExecutor } = require('./definition-executor');

function profile(overrides = {}) {
  return { id: 'profile-a', driverId: 'postgresql', accessMode: 'read-write', environment: 'production', queryTimeoutMs: 5000, endpoint: { kind: 'network', host: 'db.example.test', port: 5432 }, ssl: { mode: 'disabled' }, tunnel: { type: 'none' }, credentialSecretRefs: [{ slotId: 'password', secretRefId: 'secret-a' }], ...overrides };
}

function result() {
  return { columns: [], rows: [], affectedRows: 0, executionTimeMs: 8, warnings: [], additionalResults: [], pagination: null };
}

test('executes one opaque confirmed definition and clears runtime credentials', async () => {
  let connection;
  let request;
  const service = new DatabaseDefinitionExecutor({
    profileService: { get: async () => profile({ name: 'Production PostgreSQL' }) }, secretStore: { resolve: async () => 'definition-password' },
    runtimeRegistry: { get: () => ({ executeQuery: async (resolved, input) => { connection = resolved; request = input; return result(); } }) }
  });
  const output = await service.execute('workspace-a', 'tester', {
    requestId: 'definition-a', profileId: 'profile-a', query: 'CREATE FUNCTION public.refresh_totals() RETURNS void AS $$ BEGIN PERFORM 1; END; $$ LANGUAGE plpgsql',
    approval: { confirmed: true, typedProfileName: 'profile-name' }
  }).catch(async (error) => {
    assert.equal(error.code, 'DATABASE_MANAGER_QUERY_TYPED_CONFIRMATION_REQUIRED');
    return service.execute('workspace-a', 'tester', {
      requestId: 'definition-a', profileId: 'profile-a', query: 'CREATE FUNCTION public.refresh_totals() RETURNS void AS $$ BEGIN PERFORM 1; END; $$ LANGUAGE plpgsql',
      approval: { confirmed: true, typedProfileName: 'Production PostgreSQL' }
    });
  });
  assert.equal(output.classification, 'destructive');
  assert.match(request.query, /BEGIN PERFORM 1; END;/);
  assert.equal(connection.credentials.password, '');
});

test('requires destructive confirmation before resolving credentials', async () => {
  let resolves = 0;
  const service = new DatabaseDefinitionExecutor({
    profileService: { get: async () => profile({ environment: 'development' }) },
    secretStore: { resolve: async () => { resolves += 1; return 'password'; } },
    runtimeRegistry: { get: () => ({ executeQuery: async () => result() }) }
  });
  await assert.rejects(service.execute('workspace-a', 'tester', { requestId: 'definition-a', profileId: 'profile-a', query: 'CREATE TRIGGER audit AFTER INSERT ON events BEGIN SELECT 1; END' }), (error) => error.code === 'DATABASE_MANAGER_QUERY_CONFIRMATION_REQUIRED');
  assert.equal(resolves, 0);
});

test('resolves an operation SecretRef only after approval and does not return its query', async () => {
  const resolved = [];
  let runtimeRequest;
  const service = new DatabaseDefinitionExecutor({
    profileService: { get: async () => profile({ environment: 'development', credentialSecretRefs: [] }) },
    secretStore: { resolve: async ({ id }) => { resolved.push(id); return id === 'principal-password' ? "s'ecret" : ''; } },
    runtimeRegistry: { get: () => ({ executeQuery: async (_connection, request) => { runtimeRequest = request; return result(); } }) }
  });
  const input = { requestId: 'definition-secret', profileId: 'profile-a', query: 'CREATE ROLE "reporter" PASSWORD \'[saved password]\'' };
  await assert.rejects(service.executePrepared('workspace-a', 'tester', input, {
    secretRefId: 'principal-password', buildQuery: (password) => `CREATE ROLE "reporter" PASSWORD '${password.replaceAll("'", "''")}'`
  }), (error) => error.code === 'DATABASE_MANAGER_QUERY_CONFIRMATION_REQUIRED');
  assert.deepEqual(resolved, []);
  const output = await service.executePrepared('workspace-a', 'tester', { ...input, approval: { confirmed: true } }, {
    secretRefId: 'principal-password', buildQuery: (password) => `CREATE ROLE "reporter" PASSWORD '${password.replaceAll("'", "''")}'`
  });
  assert.deepEqual(resolved, ['principal-password']);
  assert.equal(runtimeRequest.query, 'CREATE ROLE "reporter" PASSWORD \'s\'\'ecret\'');
  assert.equal(JSON.stringify(output).includes("s'ecret"), false);
  assert.equal(JSON.stringify(output).includes('principal-password'), false);
});

test('rejects an operation SecretRef with the wrong metadata type before resolving it', async () => {
  let resolves = 0;
  let runtimeCalls = 0;
  const service = new DatabaseDefinitionExecutor({
    profileService: { get: async () => profile({ environment: 'development', credentialSecretRefs: [] }) },
    secretStore: {
      list: async () => [{ id: 'wrong-secret', secretType: 'token' }],
      resolve: async () => { resolves += 1; return 'not-a-password'; }
    },
    runtimeRegistry: { get: () => ({ executeQuery: async () => { runtimeCalls += 1; return result(); } }) }
  });
  await assert.rejects(service.executePrepared('workspace-a', 'tester', {
    requestId: 'definition-secret-type', profileId: 'profile-a', query: 'CREATE ROLE "reporter" PASSWORD \'[saved password]\'', approval: { confirmed: true }
  }, { secretRefId: 'wrong-secret', secretType: 'password', buildQuery: () => 'CREATE ROLE "reporter"' }), (error) => error.code === 'DATABASE_MANAGER_PRINCIPAL_PASSWORD_SECRET_INVALID');
  assert.equal(resolves, 0);
  assert.equal(runtimeCalls, 0);
});

test('cancels only actor-owned active definitions', async () => {
  let started;
  const running = new Promise((resolve) => { started = resolve; });
  const service = new DatabaseDefinitionExecutor({
    profileService: { get: async () => profile({ name: 'Production', environment: 'development', credentialSecretRefs: [] }) }, secretStore: { resolve: async () => '' },
    runtimeRegistry: { get: () => ({ executeQuery: async (_connection, _request, { signal }) => { started(); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'DATABASE_MANAGER_DRIVER_REQUEST_CANCELLED' })), { once: true })); } }) }
  });
  const execution = service.execute('workspace-a', 'tester', { requestId: 'definition-cancel', profileId: 'profile-a', query: 'CREATE TRIGGER audit AFTER INSERT ON events BEGIN SELECT 1; END', approval: { confirmed: true } });
  await running;
  assert.equal(service.cancel('workspace-a', 'other', 'definition-cancel').cancelled, false);
  assert.equal(service.cancel('workspace-a', 'tester', 'definition-cancel').cancelled, true);
  await assert.rejects(execution, (error) => error.code === 'DATABASE_MANAGER_DRIVER_REQUEST_CANCELLED');
});
