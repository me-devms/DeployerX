const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const initSqlJs = require('sql.js');
const { DirectDatabaseDriverRuntime } = require('./direct-driver-runtime');
const { SidecarDriverRuntime, resolveDatabaseDriverHostPath } = require('./driver-runtime');
const { LOCAL_TUNNEL_HOST, openSshForward } = require('./server-tunnel');

const MUTATION_ACKNOWLEDGEMENT = 'I_UNDERSTAND_THIS_USES_DISPOSABLE_DATABASES';
const NETWORK_CONNECTION_ENV = Object.freeze([
  Object.freeze({ driverId: 'postgresql', variable: 'DEPLOYERX_DB_ACCEPT_POSTGRESQL_JSON' }),
  Object.freeze({ driverId: 'mysql', variable: 'DEPLOYERX_DB_ACCEPT_MYSQL_JSON' })
]);
const TUNNEL_CONNECTION_ENV = Object.freeze([
  Object.freeze({ driverId: 'postgresql', variable: 'DEPLOYERX_DB_ACCEPT_POSTGRESQL_SSH_JSON' }),
  Object.freeze({ driverId: 'mysql', variable: 'DEPLOYERX_DB_ACCEPT_MYSQL_SSH_JSON' })
]);
const NATIVE_ACCEPTANCE_REPORT_SCHEMA_VERSION = 2;
const MAX_CONFIGURATION_BYTES = 512 * 1024;
const SAFE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,119}$/;

class NativeAcceptanceError extends Error {
  constructor(code) {
    super(code);
    this.name = 'NativeAcceptanceError';
    this.code = code;
  }
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function environmentConfiguration(environment, descriptor, invalidJsonCode) {
  const serialized = environment[descriptor.variable];
  if (serialized === undefined || String(serialized).trim() === '') return null;
  const text = String(serialized);
  if (Buffer.byteLength(text, 'utf8') > MAX_CONFIGURATION_BYTES) throw new NativeAcceptanceError('NATIVE_ACCEPTANCE_CONFIGURATION_TOO_LARGE');
  try {
    return JSON.parse(text);
  } catch {
    throw new NativeAcceptanceError(invalidJsonCode);
  }
}

function normalizeNetworkConnection(connection, driverId) {
  if (!plainObject(connection) || connection.driverId !== driverId || !plainObject(connection.endpoint)
    || connection.endpoint.kind !== 'network' || typeof connection.endpoint.host !== 'string'
    || !connection.endpoint.host.trim() || connection.endpoint.host.includes('\0')
    || !Number.isInteger(connection.endpoint.port) || connection.endpoint.port < 1 || connection.endpoint.port > 65535
    || typeof connection.database !== 'string' || !connection.database.trim() || connection.database.includes('\0')
    || (connection.settings !== undefined && !plainObject(connection.settings))
    || (connection.credentials !== undefined && !plainObject(connection.credentials))
    || (connection.ssl !== undefined && !plainObject(connection.ssl))) {
    throw new NativeAcceptanceError('NATIVE_ACCEPTANCE_CONNECTION_INVALID');
  }
  return {
    driverId,
    endpoint: { ...connection.endpoint, kind: 'network', host: connection.endpoint.host.trim() },
    database: connection.database.trim(),
    defaultSchema: typeof connection.defaultSchema === 'string' ? connection.defaultSchema.trim() || null : null,
    accessMode: 'read-write',
    ssl: connection.ssl || { mode: 'disabled' },
    settings: connection.settings || {},
    credentials: connection.credentials || {}
  };
}

function configuredNetworkConnection(environment, descriptor) {
  const connection = environmentConfiguration(environment, descriptor, 'NATIVE_ACCEPTANCE_CONNECTION_JSON_INVALID');
  return connection ? normalizeNetworkConnection(connection, descriptor.driverId) : null;
}

function normalizedSshConfiguration(input) {
  if (!plainObject(input)) throw new NativeAcceptanceError('NATIVE_ACCEPTANCE_SSH_CONFIGURATION_INVALID');
  const host = String(input.host || '').trim();
  const username = String(input.username || '').trim();
  const port = input.port === undefined ? 22 : Number(input.port);
  const readyTimeout = input.timeout === undefined ? 20000 : Number(input.timeout);
  if (!host || host.length > 255 || host.includes('\0') || !username || username.length > 200 || username.includes('\0')
    || !Number.isInteger(port) || port < 1 || port > 65535
    || !Number.isInteger(readyTimeout) || readyTimeout < 1000 || readyTimeout > 120000
    || !['password', 'key'].includes(input.authType)) {
    throw new NativeAcceptanceError('NATIVE_ACCEPTANCE_SSH_CONFIGURATION_INVALID');
  }
  const configuration = { host, port, username, readyTimeout };
  if (input.authType === 'password') {
    if (typeof input.password !== 'string' || !input.password || input.password.length > 16384 || input.password.includes('\0')) {
      throw new NativeAcceptanceError('NATIVE_ACCEPTANCE_SSH_CONFIGURATION_INVALID');
    }
    configuration.password = input.password;
  } else {
    if (typeof input.privateKey !== 'string' || !input.privateKey || input.privateKey.length > 262144 || input.privateKey.includes('\0')) {
      throw new NativeAcceptanceError('NATIVE_ACCEPTANCE_SSH_CONFIGURATION_INVALID');
    }
    configuration.privateKey = input.privateKey;
    if (input.passphrase !== undefined) {
      if (typeof input.passphrase !== 'string' || input.passphrase.length > 16384 || input.passphrase.includes('\0')) {
        throw new NativeAcceptanceError('NATIVE_ACCEPTANCE_SSH_CONFIGURATION_INVALID');
      }
      configuration.passphrase = input.passphrase;
    }
  }
  return configuration;
}

function configuredTunnelConnection(environment, descriptor) {
  const value = environmentConfiguration(environment, descriptor, 'NATIVE_ACCEPTANCE_SSH_JSON_INVALID');
  if (value === null) return null;
  if (!plainObject(value) || !plainObject(value.connection) || !plainObject(value.ssh)) {
    throw new NativeAcceptanceError('NATIVE_ACCEPTANCE_SSH_CONFIGURATION_INVALID');
  }
  return {
    connection: normalizeNetworkConnection(value.connection, descriptor.driverId),
    sshConfig: normalizedSshConfiguration(value.ssh)
  };
}

async function createSqliteAcceptanceFixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-db-accept-'));
  const databasePath = path.join(directory, 'acceptance.sqlite3');
  try {
    const SQL = await initSqlJs();
    const database = new SQL.Database();
    database.run('PRAGMA user_version = 1');
    const bytes = database.export();
    database.close();
    await fs.writeFile(databasePath, bytes, { flag: 'wx' });
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    connection: {
      driverId: 'sqlite',
      endpoint: { kind: 'file', path: databasePath },
      database: 'main',
      defaultSchema: null,
      accessMode: 'read-write',
      ssl: { mode: 'disabled' },
      settings: {},
      credentials: {}
    },
    cleanup: () => fs.rm(directory, { recursive: true, force: true })
  };
}

function request(query) {
  return { requestId: `accept_${crypto.randomUUID()}`, query, page: 1, pageSize: 10, schema: null, batch: false };
}

function schemaRequest() {
  return { requestId: `accept_${crypto.randomUUID()}`, profileId: 'native-acceptance', schema: null, includeSystem: false, maxTables: 100, maxColumnsPerTable: 100 };
}

function safeCode(error, fallback = 'NATIVE_ACCEPTANCE_CHECK_FAILED') {
  const code = String(error?.code || '');
  return SAFE_CODE_PATTERN.test(code) ? code : fallback;
}

function assertCheck(condition, code = 'NATIVE_ACCEPTANCE_ASSERTION_FAILED') {
  if (!condition) throw new NativeAcceptanceError(code);
}

function schemaContainsTable(snapshot, tableName) {
  return Array.isArray(snapshot?.schemas) && snapshot.schemas.some((schema) =>
    Array.isArray(schema?.tables) && schema.tables.some((table) => table?.name === tableName));
}

async function runDriverAcceptance(runtime, driverId, connection, transport = 'direct') {
  const tableName = `deployerx_accept_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const quotedTable = driverId === 'mysql' ? `\`${tableName}\`` : `"${tableName}"`;
  const checks = [];
  let runtimeSessionId = null;
  let tableCreated = false;
  let primaryError = null;
  const check = async (name, operation) => {
    try {
      await operation();
      checks.push({ name, status: 'passed' });
    } catch (error) {
      checks.push({ name, status: 'failed', code: safeCode(error) });
      throw error;
    }
  };
  try {
    await check('connection-test', async () => {
      const result = await runtime.testConnection(connection);
      assertCheck(result?.status === 'success', 'NATIVE_ACCEPTANCE_CONNECTION_TEST_FAILED');
    });
    await check('connection-open', async () => {
      const result = await runtime.openConnection(connection);
      runtimeSessionId = result?.runtimeSessionId;
      assertCheck(typeof runtimeSessionId === 'string' && runtimeSessionId.length > 0, 'NATIVE_ACCEPTANCE_SESSION_OPEN_FAILED');
    });
    await check('connection-status', async () => {
      const result = await runtime.connectionStatus(runtimeSessionId);
      assertCheck(result?.status === 'ready', 'NATIVE_ACCEPTANCE_SESSION_STATUS_FAILED');
    });
    await check('create', async () => {
      await runtime.executeSessionQuery(runtimeSessionId, request(`CREATE TABLE ${quotedTable} (id INTEGER PRIMARY KEY, value VARCHAR(64) NOT NULL)`));
      tableCreated = true;
    });
    await check('insert', async () => {
      const result = await runtime.executeSessionQuery(runtimeSessionId, request(`INSERT INTO ${quotedTable} (id, value) VALUES (1, 'created')`));
      assertCheck(Number(result?.affectedRows) === 1, 'NATIVE_ACCEPTANCE_INSERT_FAILED');
    });
    await check('select', async () => {
      const result = await runtime.executeSessionQuery(runtimeSessionId, request(`SELECT id, value FROM ${quotedTable} WHERE id = 1`));
      assertCheck(Array.isArray(result?.rows) && result.rows.length === 1 && Number(result.rows[0]?.[0]) === 1 && result.rows[0]?.[1] === 'created', 'NATIVE_ACCEPTANCE_SELECT_FAILED');
    });
    await check('update', async () => {
      const result = await runtime.executeSessionQuery(runtimeSessionId, request(`UPDATE ${quotedTable} SET value = 'updated' WHERE id = 1`));
      assertCheck(Number(result?.affectedRows) === 1, 'NATIVE_ACCEPTANCE_UPDATE_FAILED');
    });
    await check('update-verification', async () => {
      const result = await runtime.executeSessionQuery(runtimeSessionId, request(`SELECT value FROM ${quotedTable} WHERE id = 1`));
      assertCheck(Array.isArray(result?.rows) && result.rows.length === 1 && result.rows[0]?.[0] === 'updated', 'NATIVE_ACCEPTANCE_UPDATE_VERIFICATION_FAILED');
    });
    await check('schema-visibility', async () => {
      const result = await runtime.discoverSessionSchema(runtimeSessionId, schemaRequest());
      assertCheck(schemaContainsTable(result, tableName), 'NATIVE_ACCEPTANCE_SCHEMA_FAILED');
    });
    await check('read-only-rejection', async () => {
      try {
        await runtime.executeQuery({ ...connection, accessMode: 'read-only' }, request(`UPDATE ${quotedTable} SET value = 'rejected' WHERE id = 1`));
      } catch (error) {
        if (error?.code === 'DATABASE_MANAGER_READ_ONLY_VIOLATION') return;
        throw error;
      }
      throw new NativeAcceptanceError('NATIVE_ACCEPTANCE_READ_ONLY_NOT_ENFORCED');
    });
    await check('delete', async () => {
      const result = await runtime.executeSessionQuery(runtimeSessionId, request(`DELETE FROM ${quotedTable} WHERE id = 1`));
      assertCheck(Number(result?.affectedRows) === 1, 'NATIVE_ACCEPTANCE_DELETE_FAILED');
    });
    await check('delete-verification', async () => {
      const result = await runtime.executeSessionQuery(runtimeSessionId, request(`SELECT id FROM ${quotedTable} WHERE id = 1`));
      assertCheck(Array.isArray(result?.rows) && result.rows.length === 0, 'NATIVE_ACCEPTANCE_DELETE_VERIFICATION_FAILED');
    });
  } catch (error) {
    primaryError = error;
  } finally {
    if (tableCreated && runtimeSessionId) {
      try {
        await runtime.executeSessionQuery(runtimeSessionId, request(`DROP TABLE ${quotedTable}`));
        checks.push({ name: 'drop-cleanup', status: 'passed' });
      } catch (error) {
        checks.push({ name: 'drop-cleanup', status: 'failed', code: safeCode(error, 'NATIVE_ACCEPTANCE_DROP_CLEANUP_FAILED') });
        primaryError ||= error;
      }
    }
    if (runtimeSessionId) {
      try {
        await runtime.closeConnection(runtimeSessionId);
        checks.push({ name: 'connection-close', status: 'passed' });
      } catch (error) {
        checks.push({ name: 'connection-close', status: 'failed', code: safeCode(error, 'NATIVE_ACCEPTANCE_SESSION_CLOSE_FAILED') });
        primaryError ||= error;
      }
    }
  }
  return { driverId, transport, status: primaryError ? 'failed' : 'passed', checks };
}

async function runTunneledDriverAcceptance(runtime, driverId, configuration, tunnelFactory) {
  let tunnel = null;
  let result = null;
  const tunnelChecks = [];
  try {
    tunnel = await tunnelFactory({
      sshConfig: configuration.sshConfig,
      remoteHost: configuration.connection.endpoint.host,
      remotePort: configuration.connection.endpoint.port
    });
    if (tunnel?.host !== LOCAL_TUNNEL_HOST || !Number.isInteger(tunnel?.port) || tunnel.port < 1 || tunnel.port > 65535 || typeof tunnel.close !== 'function') {
      throw new NativeAcceptanceError('NATIVE_ACCEPTANCE_TUNNEL_INVALID');
    }
    tunnelChecks.push({ name: 'tunnel-open', status: 'passed' });
    const localConnection = {
      ...configuration.connection,
      endpoint: { kind: 'network', host: LOCAL_TUNNEL_HOST, port: tunnel.port }
    };
    result = await runDriverAcceptance(runtime, driverId, localConnection, 'ssh');
  } catch (error) {
    tunnelChecks.push({ name: 'tunnel-open', status: 'failed', code: safeCode(error, 'NATIVE_ACCEPTANCE_TUNNEL_OPEN_FAILED') });
    result = { driverId, transport: 'ssh', status: 'failed', checks: [] };
  } finally {
    if (tunnel) {
      try {
        await tunnel.close();
        tunnelChecks.push({ name: 'tunnel-close', status: 'passed' });
      } catch (error) {
        tunnelChecks.push({ name: 'tunnel-close', status: 'failed', code: safeCode(error, 'NATIVE_ACCEPTANCE_TUNNEL_CLOSE_FAILED') });
        if (result) result.status = 'failed';
      }
    }
  }
  result.checks = [
    ...tunnelChecks.filter((check) => check.name === 'tunnel-open'),
    ...result.checks,
    ...tunnelChecks.filter((check) => check.name === 'tunnel-close')
  ];
  return result;
}

function skippedDriver(driverId, code, transport = 'direct') {
  return { driverId, transport, status: 'skipped', checks: [{ name: 'configuration', status: 'skipped', code }] };
}

function finalizeReport(report) {
  const checks = [...report.checks, ...report.drivers.flatMap((driver) => driver.checks)];
  report.summary = {
    passed: checks.filter((check) => check.status === 'passed').length,
    failed: checks.filter((check) => check.status === 'failed').length,
    skipped: checks.filter((check) => check.status === 'skipped').length
  };
  report.passed = report.ready && report.summary.failed === 0 && report.drivers.some((driver) => driver.status === 'passed');
  return report;
}

async function runNativeLiveAcceptance({
  environment = process.env,
  executablePath = resolveDatabaseDriverHostPath({ appPath: path.resolve(__dirname, '..', '..') }),
  runtimeFactory = (options) => new SidecarDriverRuntime(options),
  directRuntimeFactory = () => new DirectDatabaseDriverRuntime(),
  sqliteFixtureFactory = createSqliteAcceptanceFixture,
  tunnelFactory = openSshForward
} = {}) {
  const report = { schemaVersion: NATIVE_ACCEPTANCE_REPORT_SCHEMA_VERSION, ready: false, passed: false, checks: [], drivers: [], summary: { passed: 0, failed: 0, skipped: 0 } };
  const nativeHostAvailable = await fs.stat(executablePath).then((stat) => stat.isFile()).catch(() => false);

  let networkConnections;
  let tunnelConnections;
  try {
    networkConnections = NETWORK_CONNECTION_ENV.map((descriptor) => ({ descriptor, connection: configuredNetworkConnection(environment, descriptor) }));
    tunnelConnections = TUNNEL_CONNECTION_ENV.map((descriptor) => ({ descriptor, configuration: configuredTunnelConnection(environment, descriptor) }));
  } catch (error) {
    report.checks.push({ name: 'configuration', status: 'failed', code: safeCode(error, 'NATIVE_ACCEPTANCE_CONFIGURATION_INVALID') });
    return finalizeReport(report);
  }
  const networkConfigured = networkConnections.some((entry) => entry.connection) || tunnelConnections.some((entry) => entry.configuration);
  const mutationsAccepted = environment.DEPLOYERX_DB_ACCEPT_MUTATIONS === MUTATION_ACKNOWLEDGEMENT;
  report.checks.push(nativeHostAvailable
    ? { name: 'native-host', status: 'passed' }
    : { name: 'native-host', status: 'passed', code: 'DIRECT_RUNTIME_SELECTED' });
  report.ready = true;

  const runtime = nativeHostAvailable ? runtimeFactory({ executablePath }) : directRuntimeFactory();
  let sqliteFixture = null;
  try {
    try {
      const health = await runtime.health();
      assertCheck(health?.status === 'ready', 'NATIVE_ACCEPTANCE_HOST_HEALTH_FAILED');
      report.checks.push({ name: 'system-health', status: 'passed' });
    } catch (error) {
      report.checks.push({ name: 'system-health', status: 'failed', code: safeCode(error, 'NATIVE_ACCEPTANCE_HOST_HEALTH_FAILED') });
      return finalizeReport(report);
    }

    try {
      sqliteFixture = await sqliteFixtureFactory();
      report.drivers.push(await runDriverAcceptance(runtime, 'sqlite', sqliteFixture.connection, 'local'));
    } catch (error) {
      report.drivers.push({ driverId: 'sqlite', transport: 'local', status: 'failed', checks: [{ name: 'fixture', status: 'failed', code: safeCode(error, 'NATIVE_ACCEPTANCE_SQLITE_FIXTURE_FAILED') }] });
    }

    for (const entry of networkConnections) {
      if (!entry.connection) {
        report.drivers.push(skippedDriver(entry.descriptor.driverId, 'NATIVE_ACCEPTANCE_CONNECTION_NOT_CONFIGURED'));
      } else if (!mutationsAccepted) {
        report.drivers.push(skippedDriver(entry.descriptor.driverId, 'NATIVE_ACCEPTANCE_MUTATION_ACK_REQUIRED'));
      } else {
        report.drivers.push(await runDriverAcceptance(runtime, entry.descriptor.driverId, entry.connection));
      }
    }
    for (const entry of tunnelConnections) {
      if (!entry.configuration) {
        report.drivers.push(skippedDriver(entry.descriptor.driverId, 'NATIVE_ACCEPTANCE_SSH_NOT_CONFIGURED', 'ssh'));
      } else if (!mutationsAccepted) {
        report.drivers.push(skippedDriver(entry.descriptor.driverId, 'NATIVE_ACCEPTANCE_MUTATION_ACK_REQUIRED', 'ssh'));
      } else {
        report.drivers.push(await runTunneledDriverAcceptance(runtime, entry.descriptor.driverId, entry.configuration, tunnelFactory));
      }
    }
    if (networkConfigured && !mutationsAccepted) report.ready = false;
  } finally {
    try { await sqliteFixture?.cleanup?.(); } catch {}
    try { await runtime.stop(); } catch {}
  }
  return finalizeReport(report);
}

async function main() {
  if (process.argv.length > 2) {
    process.stdout.write(`${JSON.stringify(finalizeReport({ schemaVersion: NATIVE_ACCEPTANCE_REPORT_SCHEMA_VERSION, ready: false, passed: false, checks: [{ name: 'arguments', status: 'failed', code: 'NATIVE_ACCEPTANCE_ARGUMENTS_NOT_SUPPORTED' }], drivers: [], summary: {} }), null, 2)}\n`);
    process.exitCode = 2;
    return;
  }
  const report = await runNativeLiveAcceptance();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exitCode = 2;
}

if (require.main === module) main().catch(() => {
  process.stdout.write(`${JSON.stringify({ schemaVersion: NATIVE_ACCEPTANCE_REPORT_SCHEMA_VERSION, ready: false, passed: false, checks: [{ name: 'runner', status: 'failed', code: 'NATIVE_ACCEPTANCE_RUNNER_FAILED' }], drivers: [], summary: { passed: 0, failed: 1, skipped: 0 } }, null, 2)}\n`);
  process.exitCode = 2;
});

module.exports = {
  MUTATION_ACKNOWLEDGEMENT,
  NATIVE_ACCEPTANCE_REPORT_SCHEMA_VERSION,
  NETWORK_CONNECTION_ENV,
  TUNNEL_CONNECTION_ENV,
  NativeAcceptanceError,
  configuredNetworkConnection,
  configuredTunnelConnection,
  createSqliteAcceptanceFixture,
  runDriverAcceptance,
  runTunneledDriverAcceptance,
  runNativeLiveAcceptance
};
