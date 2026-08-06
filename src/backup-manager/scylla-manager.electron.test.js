const { app, safeStorage } = require('electron');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { BackupControlDatabase } = require('./control-database');
const { ScyllaManagerAdapter, ScyllaManagerConnectionService } = require('./scylla-manager');
const { BackupSecretStore } = require('./secrets');

const CLUSTER_ID = '8c3fd8a0-148f-4c6d-a67c-876543210abc';

class Transport {
  constructor() { this.calls = []; }

  async request(input) {
    this.calls.push({ apiPath: input.apiPath, authorizationPresent: /^Bearer [^\s]+$/.test(input.authorization || '') });
    if (input.apiPath === '/version') return this.#json({ version: '3.11.0' });
    if (input.apiPath === '/clusters') return this.#json([this.#cluster()]);
    if (input.apiPath === `/cluster/${CLUSTER_ID}`) return this.#json(this.#cluster());
    if (input.apiPath === `/cluster/${CLUSTER_ID}/status`) return this.#json([{ dc: 'dc1', host_id: '11111111-1111-1111-1111-111111111111', host: '10.0.0.11', status: 'UP', cql_status: 'UP', rest_status: 'UP', scylla_version: '2025.1.3', agent_version: '3.11.0', total_ram: 68719476736, cpu_count: 16 }]);
    if (input.apiPath === `/cluster/${CLUSTER_ID}/tasks/backup/target`) return this.#json({ cluster_id: CLUSTER_ID, host: '10.0.0.11', dc: ['dc1'], with_hosts: ['10.0.0.11'], location: ['s3:company-backups/production'], retention: 4, retention_days: 30, rate_limit: ['dc1:100M'], snapshot_parallel: ['dc1:2'], upload_parallel: ['dc1:4'], units: [{ keyspace: 'orders', tables: ['items'], all_tables: false }], size: 4096, transfers: 4, purge_only: false, skip_schema: false, method: 'native', retention_lock_mode: 'none', override_retention_lock: false });
    throw new Error(`Unexpected Manager API path: ${input.apiPath}`);
  }

  #cluster() { return { id: CLUSTER_ID, name: 'electron-scylla', host: '10.0.0.11', port: 10001, labels: { environment: 'test' }, password: 'must-not-persist' }; }
  #json(body) { return { statusCode: 200, headers: { 'content-type': 'application/json' }, body }; }
}

async function run() {
  await app.whenReady();
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Electron safeStorage is unavailable on this device.');
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-scylla-manager-electron-test-'));
  const credential = `electron-manager-${Date.now()}-${Math.random()}`;
  let controlDatabase = null;
  try {
    controlDatabase = new BackupControlDatabase({ rootPath: path.join(rootPath, 'control') });
    await controlDatabase.initialize();
    const secretStore = new BackupSecretStore({ rootPath: path.join(rootPath, 'secrets'), secureStorage: safeStorage, isReferenced: async () => false });
    await secretStore.initialize();
    const transport = new Transport();
    const adapter = new ScyllaManagerAdapter({ transport: transport.request.bind(transport) });
    const connections = new ScyllaManagerConnectionService({ controlDatabase, secretStore, deviceId: 'manager-electron-device', adapter });
    const created = await connections.create('local', 'electron-test', { name: 'Electron ScyllaDB Manager', host: 'manager01.example.com', port: 5080, authMode: 'bearer', credential, tlsMode: 'verify-identity', managedClusterId: CLUSTER_ID });
    const tested = await connections.test('local', created.id, 'electron-test');
    const discovered = await connections.discover('local', created.id, { kind: 'nodes' });
    const verified = await connections.verifyTarget('local', created.id, { taskUpdate: { name: 'verify-orders', type: 'backup', labels: { 'deployerx.owner': 'deployerx' }, enabled: false, schedule: {}, properties: { location: ['s3:company-backups/production'], keyspace: ['orders.items'], dc: ['dc1'], method: 'native', retention: 4, retention_days: 30 } } }, 'electron-test');

    await controlDatabase.close();
    controlDatabase = new BackupControlDatabase({ rootPath: path.join(rootPath, 'control') });
    await controlDatabase.initialize();
    const persisted = await controlDatabase.repository('connection').get('local', created.id);
    const controlBytes = await fs.readFile(path.join(rootPath, 'control', 'control.db'));
    const secretBytes = await fs.readFile(path.join(rootPath, 'secrets', 'secrets.json'));
    const plaintextPersisted = controlBytes.includes(Buffer.from(credential)) || secretBytes.includes(Buffer.from(credential));
    const ok = tested.result.status === 'success'
      && tested.connection.endpoint.expectedManagerVersion === '3.11.0'
      && tested.connection.endpoint.expectedDeploymentFingerprint?.startsWith('sha256:')
      && tested.connection.trust.fingerprint?.startsWith('sha256:')
      && discovered.items.length === 1
      && discovered.items[0].healthy === true
      && verified.verification.target.locations[0].location === 's3:company-backups/production'
      && persisted.secretRefIds.length === 1
      && persisted.managerTargetTrust.targetFingerprint?.startsWith('sha256:')
      && transport.calls.length === 13
      && transport.calls.every((call) => call.authorizationPresent)
      && !plaintextPersisted
      && !controlBytes.includes(Buffer.from('must-not-persist'));
    process.stdout.write(`${JSON.stringify({ ok, status: tested.result.status, managerVersion: tested.result.endpointIdentity.managerVersion, managedClusterId: tested.result.endpointIdentity.managedClusterId, nodes: discovered.items.length, targetFingerprint: verified.verification.target.targetFingerprint, plaintextPersisted, authenticatedRequests: transport.calls.filter((call) => call.authorizationPresent).length })}\n`);
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
