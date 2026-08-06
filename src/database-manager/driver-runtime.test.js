const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const {
  DATABASE_DRIVER_PROTOCOL_VERSION,
  DatabaseDriverRuntimeRegistry,
  SidecarDriverRuntime,
  createInstalledPluginRuntime,
  resolveDatabaseDriverHostPath,
  sanitizePluginEnvironment
} = require('./driver-runtime');

function runtime(context, options = {}) {
  const value = new SidecarDriverRuntime({
    executablePath: process.execPath,
    args: [path.join(__dirname, 'driver-runtime-fixture.js')],
    requestTimeoutMs: 1000,
    ...options
  });
  context.after(() => value.stop());
  return value;
}

test('exchanges versioned JSON-RPC messages with the database driver host', async (context) => {
  const value = runtime(context);
  assert.deepEqual(await value.health(), { status: 'ready', protocolVersion: DATABASE_DRIVER_PROTOCOL_VERSION, hostVersion: 'test' });
  const tested = await value.testConnection({
    driverId: 'postgresql', database: 'orders', accessMode: 'read-only', settings: {}, credentials: { password: 'not-returned' }
  });
  assert.deepEqual(tested, { status: 'success', latencyMs: 4, serverVersion: 'fixture-1', database: 'orders', readOnly: true });
  assert.equal(JSON.stringify(tested).includes('not-returned'), false);
  const schema = await value.discoverSchema({ driverId: 'postgresql', database: 'orders', credentials: {} }, { requestId: 'schema-a', profileId: 'profile-a' });
  assert.equal(schema.schemas[0].tables[0].name, 'orders');
});

test('opens, reuses, reports, and closes an opaque host session', async (context) => {
  const value = runtime(context);
  const opened = await value.openConnection({ driverId: 'postgresql', database: 'orders', accessMode: 'read-only', settings: {}, credentials: { password: 'not-returned' } });
  assert.equal(opened.connectionMode, 'physical-pool');
  assert.match(opened.runtimeSessionId, /^dbsession_/);
  assert.equal(JSON.stringify(opened).includes('not-returned'), false);
  assert.equal((await value.connectionStatus(opened.runtimeSessionId)).status, 'ready');
  assert.deepEqual((await value.executeSessionQuery(opened.runtimeSessionId, { requestId: 'query-a', query: 'SELECT 1', page: 1, pageSize: 10 })).rows, [['orders']]);
  assert.equal((await value.discoverSessionSchema(opened.runtimeSessionId, { requestId: 'schema-a', profileId: 'profile-a' })).database, 'orders');
  assert.equal((await value.closeConnection(opened.runtimeSessionId)).closed, true);
  assert.equal((await value.connectionStatus(opened.runtimeSessionId)).status, 'closed');
  const unhealthy = await value.openConnection({ driverId: 'postgresql', database: 'orders', accessMode: 'read-only', settings: { mode: 'health-failure' }, credentials: {} });
  assert.deepEqual(await value.connectionStatus(unhealthy.runtimeSessionId), { status: 'failed', connectionMode: 'physical-pool', code: 'DATABASE_FIXTURE_HEALTH_FAILED', retryable: true });
});

test('redacts remote driver messages and enforces timeout cancellation', async (context) => {
  const value = runtime(context, { requestTimeoutMs: 1000 });
  await assert.rejects(
    value.testConnection({ settings: { mode: 'remote-error' }, credentials: { password: 'top-secret' } }),
    (error) => error.code === 'DATABASE_AUTH_FAILED' && error.message === 'Authentication failed.' && !JSON.stringify(error).includes('top-secret')
  );
  await assert.rejects(
    value.testConnection({ settings: { mode: 'slow' }, credentials: {} }, { timeoutMs: 100 }),
    (error) => error.code === 'DATABASE_MANAGER_DRIVER_TIMEOUT' && error.retryable === true
  );
});

test('rejects pending work on a crash and starts a fresh host for the next request', async (context) => {
  const value = runtime(context, { requestTimeoutMs: 1000 });
  await value.health();
  const pending = value.testConnection({ settings: { mode: 'slow' }, credentials: {} });
  value.child.kill();
  await assert.rejects(pending, (error) => error.code === 'DATABASE_MANAGER_DRIVER_HOST_EXITED' && error.retryable === true);
  assert.equal((await value.health()).status, 'ready');
});

test('registers driver runtimes and resolves packaged and source host paths', () => {
  const fake = { testConnection() {}, executeQuery() {}, discoverSchema() {}, stop() {} };
  const registry = new DatabaseDriverRuntimeRegistry()
    .register('postgresql', fake)
    .register('mysql', fake)
    .register('vendor.readonly', fake, { sqlDialect: 'postgres', capabilities: { query: true, crud: false } });
  assert.equal(registry.get('postgresql'), fake);
  assert.deepEqual(registry.getPolicy('postgresql'), { sqlDialect: 'postgresql', query: true, readOnly: false });
  assert.deepEqual(registry.getPolicy('vendor.readonly'), { sqlDialect: 'postgresql', query: true, readOnly: true });
  assert.throws(() => registry.get('oracle'), (error) => error.code === 'DATABASE_MANAGER_DRIVER_NOT_AVAILABLE');
  assert.throws(() => registry.getPolicy('oracle'), (error) => error.code === 'DATABASE_MANAGER_DRIVER_NOT_AVAILABLE');
  assert.equal(
    resolveDatabaseDriverHostPath({ isPackaged: true, resourcesPath: 'C:\\app\\resources', platform: 'win32', arch: 'x64' }),
    path.join('C:\\app\\resources', 'database-manager', 'win32-x64', 'deployerx-db-host.exe')
  );
  assert.equal(
    resolveDatabaseDriverHostPath({ appPath: 'C:\\source', platform: 'win32', arch: 'x64' }),
    path.join('C:\\source', 'native', 'deployerx-db-host', 'dist', 'win32-x64', 'deployerx-db-host.exe')
  );
});

test('isolates installed plugin environment and runs the shared JSON-RPC contract', async (context) => {
  let integrityChecks = 0;
  const isolatedEnvironment = sanitizePluginEnvironment({
    PATH: process.env.PATH || '',
    SystemRoot: process.env.SystemRoot || '',
    TEMP: process.env.TEMP || '',
    AWS_SECRET_ACCESS_KEY: 'cloud-secret',
    DEPLOYERX_DB_PLUGIN_ACCEPT_JSON: '{"credentials":"database-secret"}',
    NODE_OPTIONS: '--require=untrusted.js'
  });
  assert.equal(isolatedEnvironment.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(isolatedEnvironment.DEPLOYERX_DB_PLUGIN_ACCEPT_JSON, undefined);
  assert.equal(isolatedEnvironment.NODE_OPTIONS, undefined);
  const plugin = createInstalledPluginRuntime({
    installed: {
      pluginId: 'vendor.fixture',
      installPath: path.dirname(process.execPath),
      entrypoint: path.basename(process.execPath),
      driverManifest: { runtime: { args: [path.join(__dirname, 'plugin-runtime-fixture.js')], methods: {} } }
    },
    beforeStart: async () => { integrityChecks += 1; },
    environment: { ...process.env, AWS_SECRET_ACCESS_KEY: 'cloud-secret', DEPLOYERX_DB_PLUGIN_ACCEPT_JSON: '{"credentials":"database-secret"}' },
    requestTimeoutMs: 1000
  });
  context.after(() => plugin.stop());
  assert.equal(plugin.runtime.environment.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(plugin.runtime.environment.DEPLOYERX_DB_PLUGIN_ACCEPT_JSON, undefined);
  assert.equal(plugin.runtime.environment.DEPLOYERX_DATABASE_PLUGIN_ID, 'vendor.fixture');
  const result = await plugin.testConnection({ driverId: 'vendor.fixture', database: 'orders', accessMode: 'read-only', settings: {}, credentials: { token: 'not-returned' } });
  assert.equal(result.status, 'success');
  assert.equal(JSON.stringify(result).includes('not-returned'), false);
  const connectionUri = 'https://private-user:private-password@example.test';
  const uriResult = await plugin.testConnection({ driverId: 'vendor.fixture', database: 'orders', accessMode: 'read-only', settings: { requireConnectionUriDatabase: true }, credentials: { 'connection-uri': connectionUri } });
  assert.equal(uriResult.status, 'success');
  assert.equal(uriResult.database, 'orders');
  assert.equal(JSON.stringify(uriResult).includes(connectionUri), false);
  await assert.rejects(
    plugin.testConnection({ driverId: 'vendor.fixture', database: 'orders', accessMode: 'read-only', settings: { mode: 'remote-error' }, credentials: { token: 'private-token' } }),
    (error) => error.code === 'DATABASE_MANAGER_PLUGIN_OPERATION_FAILED'
      && error.message === 'The database plugin could not complete the operation.'
      && error.retryable === false
      && !JSON.stringify(error).includes('private-token')
  );
  const query = await plugin.executeQuery({ driverId: 'vendor.fixture', database: 'orders', accessMode: 'read-only', settings: {}, credentials: {} }, { query: 'SELECT 1', page: 2, pageSize: 25 });
  assert.equal(query.affectedRows, 0);
  assert.equal(query.pagination.pageSize, 25);
  const opened = await plugin.openConnection({ driverId: 'vendor.fixture', database: 'orders', accessMode: 'read-only', settings: {}, credentials: {} });
  assert.equal(opened.connectionMode, 'operation-scoped');
  assert.equal(Object.prototype.hasOwnProperty.call(opened, 'runtimeSessionId'), false);
  assert.equal(integrityChecks, 1);
  await plugin.stop();
  assert.equal((await plugin.health()).status, 'ready');
  assert.equal(integrityChecks, 2);
  const declaredHealth = createInstalledPluginRuntime({
    installed: {
      pluginId: 'vendor.declared-health',
      installPath: path.dirname(process.execPath),
      entrypoint: path.basename(process.execPath),
      driverManifest: { runtime: { args: [path.join(__dirname, 'plugin-runtime-fixture.js')], methods: { health: 'unsupported_health' } } }
    },
    requestTimeoutMs: 1000
  });
  context.after(() => declaredHealth.stop());
  await assert.rejects(declaredHealth.health(), (error) => error.code === 'DATABASE_MANAGER_PLUGIN_HEALTH_FAILED');
  const registry = new DatabaseDriverRuntimeRegistry().register('vendor.fixture', plugin);
  assert.equal(registry.has('vendor.fixture'), true);
  assert.equal(await registry.unregister('vendor.fixture'), true);
  assert.equal(registry.has('vendor.fixture'), false);
});

test('serializes per-profile plugin settings, parses Db2 URIs, and clears operation secrets', async (context) => {
  const plugin = createInstalledPluginRuntime({
    installed: {
      pluginId: 'vendor.settings',
      installPath: path.dirname(process.execPath),
      entrypoint: path.basename(process.execPath),
      driverManifest: { runtime: { args: [path.join(__dirname, 'plugin-runtime-fixture.js')], methods: {} } }
    },
    requestTimeoutMs: 1000
  });
  context.after(() => plugin.stop());
  assert.deepEqual(await plugin.health(), { status: 'ready' });
  const connection = (profile) => ({
    driverId: 'db2',
    database: 'not-the-uri',
    accessMode: 'read-only',
    settings: { profile, requireDb2Parts: true },
    credentials: {
      'connection-uri': 'db2://db2%20user:private%20password@db.example.test:50001/sample',
      'extra-properties': `ApplicationName=${profile.toUpperCase()}`
    }
  });
  const [first, second] = await Promise.all([plugin.testConnection(connection('a')), plugin.testConnection(connection('b'))]);
  assert.equal(first.status, 'success');
  assert.equal(second.status, 'success');
  const query = await plugin.executeQuery(connection('a'), { query: 'SELECT 1', page: 1, pageSize: 7 });
  assert.equal(query.pagination.pageSize, 7);
  assert.deepEqual(await plugin.invoke('inspect_settings', {}), {});
  await assert.rejects(
    plugin.testConnection({ ...connection('a'), credentials: { ...connection('a').credentials, 'connection-uri': 'https://private.example.test/sample' } }),
    (error) => error.code === 'DATABASE_MANAGER_PLUGIN_CONNECTION_URI_INVALID' && !JSON.stringify(error).includes('private.example.test')
  );
});
