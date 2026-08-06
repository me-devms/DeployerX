const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  MUTATION_ACKNOWLEDGEMENT,
  configuredNetworkConnection,
  configuredTunnelConnection,
  createSqliteAcceptanceFixture,
  runNativeLiveAcceptance
} = require('./native-live-acceptance');

class FakeRuntime {
  constructor({ failAt = null } = {}) {
    this.failAt = failAt;
    this.calls = [];
    this.connectionEndpoints = [];
    this.tableName = null;
    this.value = null;
  }

  async health() { this.calls.push('health'); return { status: 'ready', protocolVersion: 1 }; }
  async testConnection(connection) { this.calls.push(`test:${connection.driverId}`); this.connectionEndpoints.push({ ...connection.endpoint }); return { status: 'success' }; }
  async openConnection(connection) { this.calls.push(`open:${connection.driverId}`); this.connectionEndpoints.push({ ...connection.endpoint }); return { runtimeSessionId: `session-${connection.driverId}` }; }
  async connectionStatus() { this.calls.push('status'); return { status: 'ready' }; }
  async executeSessionQuery(_sessionId, request) {
    const sql = request.query;
    const operation = sql.trim().split(/\s+/)[0].toLowerCase();
    this.calls.push(operation);
    if (operation === this.failAt) throw Object.assign(new Error('raw host detail with password=hunter2'), { code: 'DATABASE_MANAGER_QUERY_FAILED' });
    if (operation === 'create') this.tableName = sql.match(/deployerx_accept_[a-f0-9]+/i)?.[0];
    if (operation === 'insert') { this.value = 'created'; return { affectedRows: 1 }; }
    if (operation === 'select') return { rows: this.value === null ? [] : sql.includes('id, value') ? [[1, this.value]] : [[this.value]] };
    if (operation === 'update') { this.value = 'updated'; return { affectedRows: 1 }; }
    if (operation === 'delete') { this.value = null; return { affectedRows: 1 }; }
    if (operation === 'drop') this.tableName = null;
    return { affectedRows: 0 };
  }
  async discoverSessionSchema() { this.calls.push('schema'); return { schemas: [{ tables: this.tableName ? [{ name: this.tableName }] : [] }] }; }
  async executeQuery(connection) {
    this.calls.push(`stateless:${connection.accessMode}`);
    this.connectionEndpoints.push({ ...connection.endpoint });
    throw Object.assign(new Error('rejected SQL contains a secret'), { code: 'DATABASE_MANAGER_READ_ONLY_VIOLATION' });
  }
  async closeConnection() { this.calls.push('close'); return { status: 'closed' }; }
  async stop() { this.calls.push('stop'); }
}

async function hostFixture(context) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-live-host-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const executablePath = path.join(directory, 'deployerx-db-host.exe');
  await fs.writeFile(executablePath, 'fixture');
  return executablePath;
}

const sqliteFixture = async () => ({
  connection: { driverId: 'sqlite', endpoint: { kind: 'file', path: 'private.sqlite3' }, database: 'main', accessMode: 'read-write', settings: {}, credentials: {} },
  cleanup: async () => {}
});

test('runs the complete session, mutation, schema, read-only, and cleanup contract', async (context) => {
  const executablePath = await hostFixture(context);
  const runtime = new FakeRuntime();
  const report = await runNativeLiveAcceptance({ executablePath, runtimeFactory: () => runtime, sqliteFixtureFactory: sqliteFixture, environment: {} });
  assert.equal(report.passed, true);
  assert.equal(report.drivers.find((driver) => driver.driverId === 'sqlite').status, 'passed');
  assert.deepEqual(runtime.calls, ['health', 'test:sqlite', 'open:sqlite', 'status', 'create', 'insert', 'select', 'update', 'select', 'schema', 'stateless:read-only', 'delete', 'select', 'drop', 'close', 'stop']);
  assert.equal(report.summary.failed, 0);
  assert.equal(report.summary.skipped, 4);
});

test('drops created objects, closes sessions, and stops the host after a failed check', async (context) => {
  const executablePath = await hostFixture(context);
  const runtime = new FakeRuntime({ failAt: 'insert' });
  const report = await runNativeLiveAcceptance({ executablePath, runtimeFactory: () => runtime, sqliteFixtureFactory: sqliteFixture, environment: {} });
  assert.equal(report.passed, false);
  assert.equal(report.drivers[0].status, 'failed');
  assert.ok(runtime.calls.includes('drop'));
  assert.ok(runtime.calls.includes('close'));
  assert.equal(runtime.calls.at(-1), 'stop');
});

test('accepts network configuration only from environment JSON and never reports secrets or endpoints', async (context) => {
  const executablePath = await hostFixture(context);
  const runtime = new FakeRuntime();
  const environment = {
    DEPLOYERX_DB_ACCEPT_MUTATIONS: MUTATION_ACKNOWLEDGEMENT,
    DEPLOYERX_DB_ACCEPT_POSTGRESQL_JSON: JSON.stringify({
      driverId: 'postgresql', endpoint: { kind: 'network', host: 'secret-db.internal', port: 5432 }, database: 'secret_orders',
      settings: { username: 'secret_user' }, credentials: { password: 'hunter2' }, ssl: { mode: 'required' }
    })
  };
  const parsed = configuredNetworkConnection(environment, { driverId: 'postgresql', variable: 'DEPLOYERX_DB_ACCEPT_POSTGRESQL_JSON' });
  assert.equal(parsed.accessMode, 'read-write');
  const report = await runNativeLiveAcceptance({ executablePath, runtimeFactory: () => runtime, sqliteFixtureFactory: sqliteFixture, environment });
  assert.equal(report.drivers.find((driver) => driver.driverId === 'postgresql').status, 'passed');
  const serialized = JSON.stringify(report);
  for (const secret of ['secret-db.internal', 'secret_orders', 'secret_user', 'hunter2', 'private.sqlite3', 'raw host detail']) assert.equal(serialized.includes(secret), false);
});

test('runs configured network acceptance through loopback SSH and closes the tunnel', async (context) => {
  const executablePath = await hostFixture(context);
  const runtime = new FakeRuntime();
  let closed = 0;
  const environment = {
    DEPLOYERX_DB_ACCEPT_MUTATIONS: MUTATION_ACKNOWLEDGEMENT,
    DEPLOYERX_DB_ACCEPT_POSTGRESQL_SSH_JSON: JSON.stringify({
      connection: {
        driverId: 'postgresql', endpoint: { kind: 'network', host: 'secret-db.internal', port: 5432 }, database: 'secret_orders',
        settings: { username: 'secret_db_user' }, credentials: { password: 'database-password' }, ssl: { mode: 'required' }
      },
      ssh: { host: 'secret-bastion.internal', port: 2222, username: 'secret_ssh_user', authType: 'password', password: 'ssh-password', timeout: 5000 }
    })
  };
  const configuration = configuredTunnelConnection(environment, { driverId: 'postgresql', variable: 'DEPLOYERX_DB_ACCEPT_POSTGRESQL_SSH_JSON' });
  assert.equal(configuration.sshConfig.readyTimeout, 5000);
  const report = await runNativeLiveAcceptance({
    executablePath,
    runtimeFactory: () => runtime,
    sqliteFixtureFactory: sqliteFixture,
    environment,
    tunnelFactory: async (input) => {
      assert.equal(input.sshConfig.host, 'secret-bastion.internal');
      assert.equal(input.sshConfig.password, 'ssh-password');
      assert.equal(input.remoteHost, 'secret-db.internal');
      assert.equal(input.remotePort, 5432);
      return { host: '127.0.0.1', port: 45123, close: async () => { closed += 1; } };
    }
  });
  const tunneled = report.drivers.find((driver) => driver.driverId === 'postgresql' && driver.transport === 'ssh');
  assert.equal(tunneled.status, 'passed');
  assert.equal(tunneled.checks[0].name, 'tunnel-open');
  assert.equal(tunneled.checks.at(-1).name, 'tunnel-close');
  assert.equal(closed, 1);
  assert.ok(runtime.connectionEndpoints.filter((endpoint) => endpoint.kind === 'network').every((endpoint) => endpoint.host === '127.0.0.1' && endpoint.port === 45123));
  const serialized = JSON.stringify(report);
  for (const secret of ['secret-db.internal', 'secret_orders', 'secret_db_user', 'database-password', 'secret-bastion.internal', 'secret_ssh_user', 'ssh-password']) assert.equal(serialized.includes(secret), false);
});

test('closes a configured SSH tunnel after a driver failure and reports only a safe code', async (context) => {
  const executablePath = await hostFixture(context);
  const runtime = new FakeRuntime({ failAt: 'insert' });
  let closed = false;
  const environment = {
    DEPLOYERX_DB_ACCEPT_MUTATIONS: MUTATION_ACKNOWLEDGEMENT,
    DEPLOYERX_DB_ACCEPT_MYSQL_SSH_JSON: JSON.stringify({
      connection: { driverId: 'mysql', endpoint: { kind: 'network', host: 'private-db', port: 3306 }, database: 'private_database', credentials: { password: 'database-secret' } },
      ssh: { host: 'private-ssh', username: 'deploy', authType: 'key', privateKey: 'private-key-material', passphrase: 'key-secret' }
    })
  };
  const report = await runNativeLiveAcceptance({
    executablePath,
    runtimeFactory: () => runtime,
    sqliteFixtureFactory: sqliteFixture,
    environment,
    tunnelFactory: async () => ({ host: '127.0.0.1', port: 45124, close: async () => { closed = true; } })
  });
  const tunneled = report.drivers.find((driver) => driver.driverId === 'mysql' && driver.transport === 'ssh');
  assert.equal(tunneled.status, 'failed');
  assert.equal(closed, true);
  assert.ok(tunneled.checks.some((check) => check.code === 'DATABASE_MANAGER_QUERY_FAILED'));
  const serialized = JSON.stringify(report);
  for (const secret of ['private-db', 'private_database', 'database-secret', 'private-ssh', 'private-key-material', 'key-secret', 'raw host detail']) assert.equal(serialized.includes(secret), false);
});

test('requires disposable-database acknowledgement before opening a configured SSH tunnel', async (context) => {
  const executablePath = await hostFixture(context);
  let tunnelOpened = false;
  const environment = {
    DEPLOYERX_DB_ACCEPT_POSTGRESQL_SSH_JSON: JSON.stringify({
      connection: { driverId: 'postgresql', endpoint: { kind: 'network', host: 'private-db', port: 5432 }, database: 'private_database' },
      ssh: { host: 'private-ssh', username: 'deploy', authType: 'password', password: 'private-password' }
    })
  };
  const report = await runNativeLiveAcceptance({
    executablePath,
    runtimeFactory: () => new FakeRuntime(),
    sqliteFixtureFactory: sqliteFixture,
    environment,
    tunnelFactory: async () => { tunnelOpened = true; throw new Error('must not open'); }
  });
  const tunneled = report.drivers.find((driver) => driver.driverId === 'postgresql' && driver.transport === 'ssh');
  assert.equal(report.ready, false);
  assert.equal(report.passed, false);
  assert.equal(tunnelOpened, false);
  assert.deepEqual(tunneled.checks, [{ name: 'configuration', status: 'skipped', code: 'NATIVE_ACCEPTANCE_MUTATION_ACK_REQUIRED' }]);
});

test('rejects malformed and oversized SSH acceptance configuration', () => {
  const descriptor = { driverId: 'postgresql', variable: 'DEPLOYERX_DB_ACCEPT_POSTGRESQL_SSH_JSON' };
  assert.throws(() => configuredTunnelConnection({ [descriptor.variable]: '{invalid' }, descriptor), (error) => error.code === 'NATIVE_ACCEPTANCE_SSH_JSON_INVALID');
  assert.throws(() => configuredTunnelConnection({ [descriptor.variable]: JSON.stringify({ connection: { driverId: 'postgresql' }, ssh: {} }) }, descriptor), (error) => error.code === 'NATIVE_ACCEPTANCE_CONNECTION_INVALID');
  assert.throws(() => configuredTunnelConnection({ [descriptor.variable]: 'x'.repeat(512 * 1024 + 1) }, descriptor), (error) => error.code === 'NATIVE_ACCEPTANCE_CONFIGURATION_TOO_LARGE');
});

test('selects the direct runtime and completes SQLite acceptance when the native host is unavailable', async () => {
  let sidecarSelected = false;
  let directSelected = false;
  const runtime = new FakeRuntime();
  const report = await runNativeLiveAcceptance({
    executablePath: path.join(os.tmpdir(), `missing-${Date.now()}.exe`),
    runtimeFactory: () => { sidecarSelected = true; return runtime; },
    directRuntimeFactory: () => { directSelected = true; return runtime; },
    sqliteFixtureFactory: sqliteFixture,
    environment: {}
  });
  assert.equal(report.ready, true);
  assert.equal(report.passed, true);
  assert.equal(sidecarSelected, false);
  assert.equal(directSelected, true);
  assert.deepEqual(report.checks[0], { name: 'native-host', status: 'passed', code: 'DIRECT_RUNTIME_SELECTED' });
  assert.equal(report.drivers.find((driver) => driver.driverId === 'sqlite').status, 'passed');
});

test('creates a valid temporary SQLite database and removes its containing fixture', async () => {
  const fixture = await createSqliteAcceptanceFixture();
  const databasePath = fixture.connection.endpoint.path;
  const bytes = await fs.readFile(databasePath);
  assert.equal(bytes.subarray(0, 16).toString('ascii'), 'SQLite format 3\0');
  await fixture.cleanup();
  await assert.rejects(fs.access(databasePath));
});
