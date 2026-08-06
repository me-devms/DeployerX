const { app, safeStorage } = require('electron');
const fs = require('fs/promises');
const http = require('http');
const os = require('os');
const path = require('path');
const { BackupControlDatabase } = require('./control-database');
const { InfluxDbConnectionService, InfluxDbOssV2Adapter } = require('./influxdb');
const { BackupSecretStore } = require('./secrets');

const ORG_ID = '0123456789abcdef';
const BUCKET_ID = 'fedcba9876543210';

function startFixture(token, observations) {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    observations.push({ method: request.method, pathname: url.pathname, query: Object.fromEntries(url.searchParams), authenticated: request.headers.authorization === `Token ${token}` });
    if (request.method !== 'GET' || request.headers.authorization !== `Token ${token}`) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ code: 'unauthorized' }));
      return;
    }
    const bodies = {
      '/health': { name: 'influxdb', status: 'pass', version: '2.7.11' },
      '/api/v2/orgs': { orgs: [{ id: ORG_ID, name: 'Electron organization', status: 'active' }], total: 1 },
      '/api/v2/buckets': { buckets: [{ id: BUCKET_ID, orgID: ORG_ID, name: 'electron_metrics', type: 'user', schemaType: 'implicit', retentionRules: [{ type: 'expire', everySeconds: 604800, shardGroupDurationSeconds: 86400 }] }], total: 1 }
    };
    if (!bodies[url.pathname]) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ code: 'not found' }));
      return;
    }
    const bytes = Buffer.from(JSON.stringify(bodies[url.pathname]));
    response.writeHead(200, { 'content-type': 'application/json', 'content-length': bytes.length });
    response.end(bytes);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function closeServer(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function run() {
  await app.whenReady();
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Electron safeStorage is unavailable on this device.');
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-influxdb-electron-test-'));
  const token = `electron-influxdb-${Date.now()}-${Math.random()}`;
  const requests = [];
  const commands = [];
  let controlDatabase = null;
  let fixture = null;
  try {
    fixture = await startFixture(token, requests);
    const controlPath = path.join(rootPath, 'control');
    const secretPath = path.join(rootPath, 'secrets');
    const cliPath = path.join(rootPath, 'controlled-influx.exe');
    const makeAdapter = () => new InfluxDbOssV2Adapter({
      commandRunner: async ({ executable, args }) => {
        commands.push({ executable, args: [...args] });
        if (executable !== cliPath || args.length !== 1 || args[0] !== 'version') throw new Error('Unexpected Influx CLI command contract.');
        return { stdout: 'Influx CLI 2.7.5 (git: electron-fixture)', stderr: '', exitCode: 0 };
      }
    });

    controlDatabase = new BackupControlDatabase({ rootPath: controlPath });
    await controlDatabase.initialize();
    let secretStore = new BackupSecretStore({ rootPath: secretPath, secureStorage: safeStorage, isReferenced: async () => false });
    await secretStore.initialize();
    let connections = new InfluxDbConnectionService({ controlDatabase, secretStore, deviceId: 'influxdb-electron-device', adapter: makeAdapter() });
    const created = await connections.create('local', 'electron-test', {
      name: 'Electron InfluxDB', protocol: 'http', allowInsecureHttp: true, host: '127.0.0.1', port: fixture.port, token, cliPath
    });
    const tested = await connections.test('local', created.id, 'electron-test');

    await controlDatabase.close();
    controlDatabase = new BackupControlDatabase({ rootPath: controlPath });
    await controlDatabase.initialize();
    secretStore = new BackupSecretStore({ rootPath: secretPath, secureStorage: safeStorage, isReferenced: async () => false });
    await secretStore.initialize();
    connections = new InfluxDbConnectionService({ controlDatabase, secretStore, deviceId: 'influxdb-electron-device', adapter: makeAdapter() });
    const persisted = await controlDatabase.repository('connection').get('local', created.id);
    const discovered = await connections.discover('local', created.id, { kind: 'all' });
    const controlBytes = await fs.readFile(path.join(controlPath, 'control.db'));
    const secretBytes = await fs.readFile(path.join(secretPath, 'secrets.json'));
    const plaintextPersisted = controlBytes.includes(Buffer.from(token)) || secretBytes.includes(Buffer.from(token));
    const ok = tested.result.status === 'success'
      && tested.result.endpointIdentity.version === '2.7.11'
      && tested.result.endpointIdentity.cliVersion === '2.7.5'
      && tested.connection.influxdbInventory?.organizations?.length === 1
      && tested.connection.influxdbInventory?.buckets?.length === 1
      && persisted.secretRefIds.length === 1
      && !Object.prototype.hasOwnProperty.call(persisted.endpoint, 'token')
      && discovered.organizations[0].id === ORG_ID
      && discovered.buckets[0].id === BUCKET_ID
      && discovered.buckets[0].retentionRules[0].everySeconds === 604800
      && requests.length === 9
      && requests.every((entry) => entry.method === 'GET' && entry.authenticated)
      && requests.filter((entry) => entry.pathname === '/api/v2/orgs').every((entry) => entry.query.limit === '100' && entry.query.offset === '0')
      && commands.length === 3
      && commands.every((entry) => entry.executable === cliPath && entry.args.join(' ') === 'version' && !entry.args.some((argument) => argument.includes(token)))
      && !plaintextPersisted;
    process.stdout.write(`${JSON.stringify({ ok, status: tested.result.status, serverVersion: tested.result.endpointIdentity.version, cliVersion: tested.result.endpointIdentity.cliVersion, organizations: discovered.organizations.length, buckets: discovered.buckets.length, authenticatedRequests: requests.filter((entry) => entry.authenticated).length, cliProbes: commands.length, plaintextPersisted })}\n`);
    if (!ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  } finally {
    await controlDatabase?.close().catch(() => {});
    if (fixture) await closeServer(fixture.server).catch(() => {});
    await fs.rm(rootPath, { recursive: true, force: true });
    app.exit(process.exitCode || 0);
  }
}

run();
