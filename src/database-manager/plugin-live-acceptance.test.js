const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabasePluginRegistry } = require('./plugin-registry');
const {
  PLUGIN_ACCEPTANCE_CONFIGURATION_ENV,
  PLUGIN_ACCEPTANCE_REGISTRY_ROOT_ENV,
  PLUGIN_QUERY_ACKNOWLEDGEMENT,
  PLUGIN_QUERY_ACKNOWLEDGEMENT_ENV,
  acceptanceConfiguration,
  runPluginLiveAcceptance
} = require('./plugin-live-acceptance');

const PLUGIN_ID = 'vendor.fixture';
const ARCHIVE = Buffer.from('plugin-acceptance-fixture');

async function installedFixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-plugin-accept-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const fixtureSource = await fs.readFile(path.join(__dirname, 'plugin-runtime-fixture.js'));
  const registry = new DatabasePluginRegistry({
    rootPath: root,
    download: async () => ARCHIVE,
    verifySignature: async () => true,
    extract: async (_archive, destination) => {
      await fs.mkdir(destination, { recursive: true });
      await fs.writeFile(path.join(destination, 'driver.js'), fixtureSource);
      return [{ path: 'driver.js', size: fixtureSource.byteLength, executable: true }];
    }
  });
  registry.setCatalog({
    schemaVersion: 1,
    releases: [{
      pluginId: PLUGIN_ID,
      version: '1.0.0',
      name: 'Fixture driver',
      approved: true,
      target: { platforms: [process.platform], architectures: ['universal'] },
      archive: {
        name: 'fixture.zip',
        url: 'https://example.test/fixture.zip',
        size: ARCHIVE.byteLength,
        sha256: crypto.createHash('sha256').update(ARCHIVE).digest('hex')
      },
      signature: { algorithm: 'Ed25519', value: 'fixture-signature', keyId: 'fixture-key' },
      manifestSha256: 'c'.repeat(64),
      entrypoint: 'driver.js',
      driverManifest: {
        id: PLUGIN_ID,
        name: 'Fixture driver',
        version: '1.0.0',
        capabilities: { schemas: true, query: true },
        credentialSlots: [{ id: 'token', type: 'token', label: 'Token', required: true }],
        runtime: { args: [], methods: {} }
      }
    }]
  });
  await registry.install(PLUGIN_ID);
  return { root, entrypointPath: path.join(root, 'installed', PLUGIN_ID, '1.0.0', 'driver.js') };
}

function environment(root, overrides = {}) {
  return {
    ...process.env,
    [PLUGIN_ACCEPTANCE_REGISTRY_ROOT_ENV]: root,
    [PLUGIN_ACCEPTANCE_CONFIGURATION_ENV]: JSON.stringify([{
      pluginId: PLUGIN_ID,
      connection: {
        driverId: PLUGIN_ID,
        endpoint: { kind: 'none' },
        database: 'private-fixture-database',
        accessMode: 'read-only',
        ssl: { mode: 'disabled' },
        settings: {},
        credentials: { token: 'private-fixture-token' }
      },
      query: 'SELECT private_fixture_value'
    }]),
    [PLUGIN_QUERY_ACKNOWLEDGEMENT_ENV]: PLUGIN_QUERY_ACKNOWLEDGEMENT,
    ...overrides
  };
}

test('runs an installed plugin through integrity, health, connection, schema, query, and cleanup', async (context) => {
  const fixture = await installedFixture(context);
  const report = await runPluginLiveAcceptance({ environment: environment(fixture.root) });
  assert.equal(report.ready, true);
  assert.equal(report.passed, true);
  assert.equal(report.schemaVersion, 1);
  assert.deepEqual(report.plugins[0], {
    pluginId: PLUGIN_ID,
    version: '1.0.0',
    status: 'passed',
    checks: [
      { name: 'installed-integrity', status: 'passed' },
      { name: 'credential-contract', status: 'passed' },
      { name: 'system-health', status: 'passed' },
      { name: 'connection-test', status: 'passed' },
      { name: 'schema-discovery', status: 'passed' },
      { name: 'read-query', status: 'passed' },
      { name: 'runtime-stop', status: 'passed' }
    ]
  });
  const serialized = JSON.stringify(report);
  for (const sensitive of [fixture.root, 'private-fixture-database', 'private-fixture-token', 'SELECT private_fixture_value']) {
    assert.equal(serialized.includes(sensitive), false);
  }
});

test('requires query acknowledgement before registry access or plugin spawn', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-plugin-accept-ack-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  let registryCreated = false;
  let runtimeCreated = false;
  const report = await runPluginLiveAcceptance({
    environment: environment(root, { [PLUGIN_QUERY_ACKNOWLEDGEMENT_ENV]: '' }),
    registryFactory: () => { registryCreated = true; throw new Error('must not load'); },
    runtimeFactory: () => { runtimeCreated = true; throw new Error('must not spawn'); }
  });
  assert.equal(report.ready, false);
  assert.equal(report.passed, false);
  assert.equal(registryCreated, false);
  assert.equal(runtimeCreated, false);
  assert.deepEqual(report.checks, [{ name: 'query-acknowledgement', status: 'failed', code: 'PLUGIN_ACCEPTANCE_QUERY_ACK_REQUIRED' }]);
});

test('fails without creating a missing plugin registry root', async () => {
  const root = path.join(os.tmpdir(), `deployerx-plugin-accept-missing-${crypto.randomUUID()}`);
  let registryCreated = false;
  const report = await runPluginLiveAcceptance({
    environment: environment(root),
    registryFactory: () => { registryCreated = true; throw new Error('must not create'); }
  });
  assert.equal(report.ready, false);
  assert.equal(report.passed, false);
  assert.equal(registryCreated, false);
  assert.deepEqual(report.checks, [{ name: 'registry', status: 'failed', code: 'PLUGIN_ACCEPTANCE_REGISTRY_ROOT_UNAVAILABLE' }]);
  assert.equal(await fs.access(root).then(() => true, () => false), false);
});

test('reports persisted unsigned plugins without creating a runtime', async () => {
  let runtimeCreated = false;
  const unsigned = { pluginId: PLUGIN_ID, version: '0.5.0', enabled: false, integrityStatus: 'verified', signatureVerified: false };
  const report = await runPluginLiveAcceptance({
    environment: environment(path.resolve(os.tmpdir(), 'private-plugin-registry')),
    registryRootStat: async () => ({ isDirectory: () => true }),
    registryFactory: () => ({
      initialize: async () => {},
      listInstalled: () => [unsigned],
      getInstalled: () => null
    }),
    runtimeFactory: () => { runtimeCreated = true; throw new Error('must not spawn'); }
  });
  assert.equal(report.ready, true);
  assert.equal(report.passed, false);
  assert.equal(runtimeCreated, false);
  assert.deepEqual(report.plugins[0].checks, [{ name: 'installed-integrity', status: 'failed', code: 'PLUGIN_ACCEPTANCE_SIGNATURE_REQUIRED' }]);
});

test('quarantines modified installed content before creating a plugin runtime', async (context) => {
  const fixture = await installedFixture(context);
  await fs.appendFile(fixture.entrypointPath, '\n// modified after installation\n');
  let runtimeCreated = false;
  const report = await runPluginLiveAcceptance({
    environment: environment(fixture.root),
    runtimeFactory: () => { runtimeCreated = true; throw new Error('must not spawn'); }
  });
  assert.equal(report.ready, true);
  assert.equal(report.passed, false);
  assert.equal(runtimeCreated, false);
  assert.deepEqual(report.plugins[0].checks, [{ name: 'installed-integrity', status: 'failed', code: 'PLUGIN_ACCEPTANCE_INTEGRITY_FAILED' }]);
  const persisted = JSON.parse(await fs.readFile(path.join(fixture.root, 'plugins.json'), 'utf8'));
  assert.equal(persisted.plugins[0].enabled, false);
});

test('stops a failed plugin and reports only fixed evidence', async () => {
  let stopped = 0;
  const installed = {
    pluginId: PLUGIN_ID,
    version: '1.0.0',
    enabled: true,
    integrityStatus: 'verified',
    installPath: path.join(os.tmpdir(), 'private-plugin-path'),
    entrypoint: 'private-driver.exe',
    driverManifest: { capabilities: { schemas: true, query: true }, credentialSlots: [{ id: 'token', required: true }], runtime: { args: [], methods: {} } }
  };
  const registry = {
    initialize: async () => {},
    listInstalled: () => [installed],
    getInstalled: () => installed,
    verifyInstalled: async () => ({ pluginId: PLUGIN_ID, integrityStatus: 'verified' })
  };
  const report = await runPluginLiveAcceptance({
    environment: environment(path.resolve(os.tmpdir(), 'private-plugin-registry')),
    registryRootStat: async () => ({ isDirectory: () => true }),
    registryFactory: () => registry,
    runtimeFactory: () => ({
      health: async () => ({ status: 'ready' }),
      testConnection: async () => { throw Object.assign(new Error('private-fixture-token at private-host'), { code: 'DATABASE_PLUGIN_REMOTE_FAILURE' }); },
      discoverSchema: async () => ({ schemas: [] }),
      executeQuery: async () => ({ rows: [] }),
      stop: async () => { stopped += 1; }
    })
  });
  assert.equal(report.passed, false);
  assert.equal(stopped, 1);
  assert.ok(report.plugins[0].checks.some((check) => check.code === 'DATABASE_PLUGIN_REMOTE_FAILURE'));
  const serialized = JSON.stringify(report);
  for (const sensitive of ['private-fixture-token', 'private-host', 'private-plugin-path', 'private-driver.exe']) assert.equal(serialized.includes(sensitive), false);
});

test('rejects unsafe, duplicate, sensitive, and oversized configuration', () => {
  const valid = JSON.parse(environment(path.resolve(os.tmpdir(), 'plugin-registry'))[PLUGIN_ACCEPTANCE_CONFIGURATION_ENV]);
  assert.throws(() => acceptanceConfiguration({
    [PLUGIN_ACCEPTANCE_REGISTRY_ROOT_ENV]: 'relative/path',
    [PLUGIN_ACCEPTANCE_CONFIGURATION_ENV]: JSON.stringify(valid)
  }), (error) => error.code === 'PLUGIN_ACCEPTANCE_REGISTRY_ROOT_INVALID');
  assert.throws(() => acceptanceConfiguration({
    [PLUGIN_ACCEPTANCE_REGISTRY_ROOT_ENV]: path.resolve(os.tmpdir(), 'plugin-registry'),
    [PLUGIN_ACCEPTANCE_CONFIGURATION_ENV]: JSON.stringify([...valid, ...valid])
  }), (error) => error.code === 'PLUGIN_ACCEPTANCE_CONFIGURATION_INVALID');
  const sensitiveSettings = structuredClone(valid);
  sensitiveSettings[0].connection.settings = { apiToken: 'must-not-be-here' };
  assert.throws(() => acceptanceConfiguration({
    [PLUGIN_ACCEPTANCE_REGISTRY_ROOT_ENV]: path.resolve(os.tmpdir(), 'plugin-registry'),
    [PLUGIN_ACCEPTANCE_CONFIGURATION_ENV]: JSON.stringify(sensitiveSettings)
  }), (error) => error.code === 'PLUGIN_ACCEPTANCE_CONNECTION_INVALID');
  assert.throws(() => acceptanceConfiguration({
    [PLUGIN_ACCEPTANCE_REGISTRY_ROOT_ENV]: path.resolve(os.tmpdir(), 'plugin-registry'),
    [PLUGIN_ACCEPTANCE_CONFIGURATION_ENV]: 'x'.repeat(512 * 1024 + 1)
  }), (error) => error.code === 'PLUGIN_ACCEPTANCE_CONFIGURATION_TOO_LARGE');
});
