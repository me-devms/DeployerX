const assert = require('node:assert/strict');
const test = require('node:test');
const {
  DatabasePrincipalAdministrationService,
  PRINCIPAL_LIST_QUERIES,
  buildPrincipalAdministrationSql,
  buildPrincipalGrantInventoryQuery,
  normalizePrincipalActionInput,
  normalizePrincipalGrantInventory,
  principalAdministrationCapabilities,
  normalizePrincipalInventory
} = require('./principal-administration');

function profile(overrides = {}) {
  return { id: 'profile-a', name: 'Development PostgreSQL', driverId: 'postgresql', database: 'orders', accessMode: 'read-write', environment: 'development', ...overrides };
}

test('builds escaped PostgreSQL role, membership, and scoped privilege statements', () => {
  assert.equal(buildPrincipalAdministrationSql('postgresql', {
    action: 'create-principal', principal: 'reporting"user', options: { login: true, createDatabase: false }, passwordSecretRefId: 'secret-a', validUntil: '2030-01-01T00:00:00.000Z'
  }, "p'ass\\word"), 'CREATE ROLE "reporting""user" LOGIN NOCREATEDB PASSWORD $deployerx_d036436b0714$p\'ass\\word$deployerx_d036436b0714$ VALID UNTIL \'2030-01-01T00:00:00.000Z\'');
  assert.equal(buildPrincipalAdministrationSql('postgresql', {
    action: 'grant', principal: 'analyst', scope: { type: 'all-tables', schema: 'analytics' }, privileges: ['select'], grantOption: true
  }), 'GRANT SELECT ON ALL TABLES IN SCHEMA "analytics" TO "analyst" WITH GRANT OPTION');
  assert.equal(buildPrincipalAdministrationSql('postgresql', {
    action: 'revoke-role', principal: 'analyst', role: 'reporting', adminOption: true
  }), 'REVOKE ADMIN OPTION FOR "reporting" FROM "analyst"');
});

test('builds escaped MySQL account and privilege statements', () => {
  assert.equal(buildPrincipalAdministrationSql('mysql', {
    action: 'create-principal', principal: "app'user", host: '10.%', passwordSecretRefId: 'secret-a'
  }, "s'ecret"), "CREATE USER 'app''user'@'10.%' IDENTIFIED BY 's''ecret'");
  assert.equal(buildPrincipalAdministrationSql('mysql', {
    action: 'grant', principal: 'app', host: 'localhost', scope: { type: 'table', database: 'orders', objectName: 'order`items' }, privileges: ['select', 'update']
  }), 'GRANT SELECT, UPDATE ON `orders`.`order``items` TO \'app\'@\'localhost\'');
  assert.equal(buildPrincipalAdministrationSql('mysql', {
    action: 'lock-principal', principal: 'app', host: '%'
  }), "ALTER USER 'app'@'%' ACCOUNT LOCK");
});

test('rejects inline credentials, unsupported drivers, privileges, and incomplete changes', () => {
  assert.throws(() => normalizePrincipalActionInput({ action: 'create-principal', principal: 'app', password: 'inline' }, profile()), (error) => error.code === 'DATABASE_MANAGER_PRINCIPAL_PASSWORD_INLINE_FORBIDDEN');
  assert.throws(() => normalizePrincipalActionInput({ action: 'create-principal', principal: 'app' }, profile({ driverId: 'sqlite' })), (error) => error.code === 'DATABASE_MANAGER_PRINCIPAL_ACTION_UNSUPPORTED');
  assert.throws(() => buildPrincipalAdministrationSql('postgresql', { action: 'grant', principal: 'app', scope: { type: 'schema', schema: 'public' }, privileges: ['SUPERUSER'] }), (error) => error.code === 'DATABASE_MANAGER_PRIVILEGE_INVALID');
  assert.throws(() => normalizePrincipalActionInput({ action: 'alter-principal', principal: 'app' }, profile()), (error) => error.code === 'DATABASE_MANAGER_PRINCIPAL_ACTION_INVALID');
  assert.equal(principalAdministrationCapabilities(profile({ accessMode: 'read-only' })).available, false);
  assert.equal(principalAdministrationCapabilities(profile({ driverId: 'sqlite' })).actions.length, 0);
});

test('normalizes bounded account inventories without authentication material', async () => {
  assert.doesNotMatch(PRINCIPAL_LIST_QUERIES.postgresql, /rolpassword/i);
  assert.doesNotMatch(PRINCIPAL_LIST_QUERIES.mysql, /authentication_string/i);
  const inventory = normalizePrincipalInventory('mysql', { result: {
    columns: [{ name: 'principal' }, { name: 'account_host' }, { name: 'is_locked' }, { name: 'credential_expired' }],
    rows: [['app', '10.%', 'Y', 'N']]
  } });
  assert.deepEqual(inventory.principals[0], { name: 'app', host: '10.%', locked: true, credentialExpired: false });
  let request;
  const service = new DatabasePrincipalAdministrationService({
    profileService: { get: async () => profile({ driverId: 'mysql' }) },
    queryService: { executeReadPage: async (_workspaceId, _actorId, input) => { request = input; return { result: { columns: [{ name: 'principal' }, { name: 'account_host' }], rows: [['root', 'localhost']] } }; } },
    taskService: taskService([]),
    definitionExecutor: { execute: async () => ({}), executePrepared: async () => ({}), cancel: () => ({ cancelled: true }) }
  });
  const listed = await service.list('workspace-a', 'tester', 'profile-a');
  assert.equal(request.query, PRINCIPAL_LIST_QUERIES.mysql);
  assert.equal(request.pageSize, 500);
  assert.equal(listed.principals[0].name, 'root');
});

test('builds and normalizes bounded privilege inventories without query history', async () => {
  const postgresqlQuery = buildPrincipalGrantInventoryQuery('postgresql', { principal: "app'role" });
  assert.match(postgresqlQuery, /information_schema\.role_table_grants/);
  assert.match(postgresqlQuery, /pg_catalog\.pg_auth_members/);
  assert.doesNotMatch(postgresqlQuery, /rolpassword|authentication_string/i);
  const mysqlQuery = buildPrincipalGrantInventoryQuery('mysql', { principal: "app'user", host: '10.%' });
  assert.match(mysqlQuery, /information_schema\.USER_PRIVILEGES/);
  assert.match(mysqlQuery, /QUOTE\('app''user'\)/);
  assert.doesNotMatch(mysqlQuery, /mysql\.user|authentication_string/i);

  const normalized = normalizePrincipalGrantInventory('postgresql', { result: {
    columns: [{ name: 'privilege_type' }, { name: 'scope_type' }, { name: 'object_scope' }, { name: 'is_grantable' }],
    rows: [['select', 'table', 'public.orders', 'YES'], ['member', 'role', 'reporting', 'NO']]
  } }, { principal: 'analyst' });
  assert.deepEqual(normalized.grants, [
    { privilege: 'SELECT', scope: 'table', object: 'public.orders', grantable: true },
    { privilege: 'MEMBER', scope: 'role', object: 'reporting', grantable: false }
  ]);

  let request;
  const service = new DatabasePrincipalAdministrationService({
    profileService: { get: async () => profile({ driverId: 'mysql' }) },
    queryService: { executeReadPage: async (_workspaceId, _actorId, input) => {
      request = input;
      return { result: { columns: [{ name: 'privilege_type' }, { name: 'scope_type' }, { name: 'object_scope' }, { name: 'is_grantable' }], rows: [['SELECT', 'database', 'orders.*', 'NO']] } };
    } },
    taskService: taskService([]),
    definitionExecutor: { execute: async () => ({}), executePrepared: async () => ({}), cancel: () => ({ cancelled: true }) }
  });
  const inspected = await service.inspect('workspace-a', 'tester', { profileId: 'profile-a', principal: 'app', host: 'localhost' });
  assert.equal(request.pageSize, 1000);
  assert.match(request.query, /SCHEMA_PRIVILEGES/);
  assert.deepEqual(inspected.grants[0], { privilege: 'SELECT', scope: 'database', object: 'orders.*', grantable: false });
});

function taskService(calls) {
  const tasks = new Map();
  return {
    create: async (_workspaceId, _actorId, input) => { calls.push(['create', input]); const task = { id: 'task-a', revision: 1, state: 'queued', ...input }; tasks.set(task.id, task); return task; },
    start: async () => { const task = { ...tasks.get('task-a'), revision: 2, state: 'running' }; tasks.set(task.id, task); return task; },
    complete: async (_workspaceId, _actorId, id, options = {}) => { const task = { ...tasks.get(id), revision: 3, state: options.state || 'succeeded' }; tasks.set(id, task); calls.push(['complete', options]); return task; },
    get: async (_workspaceId, id) => tasks.get(id),
    registerCancellation: (_workspaceId, _taskId, handler) => { calls.push(['cancel-handler', handler]); return () => calls.push(['unregister']); }
  };
}

test('routes password actions through the opaque prepared executor without returning a SecretRef', async () => {
  const calls = [];
  const service = new DatabasePrincipalAdministrationService({
    profileService: { get: async () => profile() },
    queryService: { executeReadPage: async () => ({ result: { columns: [], rows: [] } }) },
    taskService: taskService(calls),
    definitionExecutor: {
      execute: async () => { throw new Error('plain executor must not receive password action'); },
      executePrepared: async (...args) => { calls.push(['prepared', ...args]); return { result: { affectedRows: 0 } }; },
      cancel: () => ({ cancelled: true })
    }
  });
  const result = await service.execute('workspace-a', 'tester', {
    requestId: 'principal-a', profileId: 'profile-a', action: 'create-principal', principal: 'reporter',
    options: { login: true }, passwordSecretRefId: 'secret-password', approval: { confirmed: true }
  });
  const prepared = calls.find((call) => call[0] === 'prepared');
  assert.equal(prepared[4].secretRefId, 'secret-password');
  assert.doesNotMatch(prepared[3].query, /secret-password/);
  assert.equal(prepared[4].buildQuery("p'ass"), 'CREATE ROLE "reporter" LOGIN PASSWORD $deployerx_8606c066ecd1$p\'ass$deployerx_8606c066ecd1$');
  assert.equal(result.action.usesPasswordSecret, true);
  assert.equal(JSON.stringify(result).includes('secret-password'), false);
  assert.equal(result.task.state, 'succeeded');
});

test('requires confirmation before task creation and records opaque failures safely', async () => {
  const calls = [];
  const service = new DatabasePrincipalAdministrationService({
    profileService: { get: async () => profile() },
    queryService: { executeReadPage: async () => ({ result: { columns: [], rows: [] } }) },
    taskService: taskService(calls),
    definitionExecutor: {
      execute: async () => { throw new Error('remote SQL includes sensitive details'); },
      executePrepared: async () => { throw new Error('unused'); },
      cancel: () => ({ cancelled: true })
    }
  });
  const input = { requestId: 'principal-a', profileId: 'profile-a', action: 'drop-principal', principal: 'old_user' };
  await assert.rejects(service.execute('workspace-a', 'tester', input), (error) => error.code === 'DATABASE_MANAGER_QUERY_CONFIRMATION_REQUIRED');
  assert.equal(calls.some((call) => call[0] === 'create'), false);
  await assert.rejects(service.execute('workspace-a', 'tester', { ...input, approval: { confirmed: true } }), /sensitive details/);
  assert.equal(calls.find((call) => call[0] === 'complete')[1].safeMessage, 'Database user or privilege operation failed.');
});
