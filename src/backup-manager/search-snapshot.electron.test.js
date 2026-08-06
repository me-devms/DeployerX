const { app, safeStorage } = require('electron');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { BackupControlDatabase } = require('./control-database');
const { SearchSnapshotAdapter, SearchSnapshotConnectionService } = require('./search-snapshot');
const { BackupSecretStore } = require('./secrets');

class Transport {
  constructor() { this.calls = []; }

  async request(input) {
    this.calls.push({ apiPath: input.apiPath, authorizationPresent: /^Basic [A-Za-z0-9+/=]+$/.test(input.authorization) });
    const responses = {
      '/': { headers: { 'x-elastic-product': 'Elasticsearch' }, body: { cluster_name: 'electron-search', cluster_uuid: 'electron-search-cluster-001', version: { number: '9.1.2', build_flavor: 'default' }, tagline: 'You Know, for Search' } },
      '/_cluster/health': { body: { cluster_name: 'electron-search', status: 'green', timed_out: false, number_of_nodes: 3, number_of_data_nodes: 2, active_primary_shards: 12, initializing_shards: 0, unassigned_shards: 0 } },
      '/_snapshot/_all': { body: { archive: { type: 's3', settings: { bucket: 'electron-search-backups', base_path: 'production', readonly: 'false' } } } },
      '/_snapshot/_status': { body: { snapshots: [] } },
      '/_cluster/state/blocks': { body: { cluster_uuid: 'electron-search-cluster-001', blocks: {} } }
    };
    const response = responses[input.apiPath];
    if (!response) throw new Error(`Unexpected search API path: ${input.apiPath}`);
    return { statusCode: 200, headers: { 'content-type': 'application/json', ...(response.headers || {}) }, body: response.body };
  }
}

async function run() {
  await app.whenReady();
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Electron safeStorage is unavailable on this device.');
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-search-snapshot-electron-test-'));
  const credential = `electron-search-${Date.now()}-${Math.random()}`;
  let controlDatabase = null;
  try {
    controlDatabase = new BackupControlDatabase({ rootPath: path.join(rootPath, 'control') });
    await controlDatabase.initialize();
    const secretStore = new BackupSecretStore({ rootPath: path.join(rootPath, 'secrets'), secureStorage: safeStorage, isReferenced: async () => false });
    await secretStore.initialize();
    const transport = new Transport();
    const adapter = new SearchSnapshotAdapter({ transport: transport.request.bind(transport) });
    const connections = new SearchSnapshotConnectionService({ controlDatabase, secretStore, deviceId: 'search-electron-device', adapter });
    const created = await connections.create('local', 'electron-test', {
      name: 'Electron Search Snapshot', host: 'search01.example.com', username: 'backup-user', credential,
      authMode: 'basic', expectedProduct: 'auto', tlsMode: 'verify-identity'
    });
    const tested = await connections.test('local', created.id, 'electron-test');
    const discovered = await connections.discover('local', created.id, { kind: 'repositories' });

    await controlDatabase.close();
    controlDatabase = new BackupControlDatabase({ rootPath: path.join(rootPath, 'control') });
    await controlDatabase.initialize();
    const persisted = await controlDatabase.repository('connection').get('local', created.id);
    const controlBytes = await fs.readFile(path.join(rootPath, 'control', 'control.db'));
    const secretBytes = await fs.readFile(path.join(rootPath, 'secrets', 'secrets.json'));
    const ok = tested.result.status === 'success'
      && tested.connection.endpoint.expectedProduct === 'elasticsearch'
      && tested.connection.endpoint.expectedClusterUuid === 'electron-search-cluster-001'
      && tested.connection.trust.fingerprint?.startsWith('sha256:')
      && discovered.items.length === 1
      && discovered.items[0].name === 'archive'
      && persisted.secretRefIds.length === 1
      && transport.calls.length === 10
      && transport.calls.every((call) => call.authorizationPresent)
      && !controlBytes.includes(Buffer.from(credential))
      && !secretBytes.includes(Buffer.from(credential));
    process.stdout.write(`${JSON.stringify({ ok, status: tested.result.status, product: tested.result.endpointIdentity.product, clusterUuid: tested.result.endpointIdentity.clusterUuid, repositories: discovered.items.map((item) => item.name), plaintextPersisted: controlBytes.includes(Buffer.from(credential)) || secretBytes.includes(Buffer.from(credential)), authenticatedRequests: transport.calls.filter((call) => call.authorizationPresent).length })}\n`);
    if (!ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  } finally {
    await controlDatabase?.close().catch(() => {});
    await fs.rm(rootPath, { recursive: true, force: true });
    app.quit();
  }
}

run();
