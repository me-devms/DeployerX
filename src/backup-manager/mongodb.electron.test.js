const { app, safeStorage } = require('electron');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { BackupControlDatabase } = require('./control-database');
const { DatabaseAdapterRegistry } = require('./database-adapter');
const { DatabaseSourceService } = require('./database-source');
const { MongoDbConnectionService, MongoDbNativeAdapter } = require('./mongodb');
const { BackupSecretStore } = require('./secrets');

class Runner {
  constructor() { this.calls = []; }

  async consume(input) {
    this.calls.push({ args: [...input.args], env: { ...(input.env || {}) }, stdin: Buffer.from(input.stdin).toString('utf8') });
    const value = {
      topology: 'replica-set', version: '8.0.4', featureCompatibilityVersion: '8.0', setName: 'rs0',
      replicaSetId: 'ObjectId(0123456789abcdef01234567)', clusterId: null, endpointIdentity: 'mongo01.example.com:27017',
      primary: 'mongo01.example.com:27017', me: 'mongo02.example.com:27017',
      members: ['mongo01.example.com:27017', 'mongo02.example.com:27017', 'mongo03.example.com:27017'],
      storageEngine: 'wiredTiger', persistent: true, logicalSessionTimeoutMinutes: 30,
      databases: ['admin', 'analytics', 'config', 'local', 'orders'],
      authenticatedUsers: [{ user: 'deployerx_backup', db: 'admin' }],
      authenticatedRoles: [{ role: 'backup', db: 'admin' }], privilegeCount: 12,
      privilegeActions: ['find', 'listCollections', 'listDatabases', 'listIndexes'],
      logicalInventory: {
        version: 1, databases: ['analytics', 'orders'], indexCount: 2,
        collections: [
          { database: 'analytics', name: 'events', type: 'collection', uuid: { $uuid: '11111111-2222-3333-4444-555555555555' }, options: {}, indexes: [{ name: '_id_', key: { _id: 1 } }] },
          { database: 'orders', name: 'events', type: 'collection', uuid: { $uuid: '22222222-2222-3333-4444-555555555555' }, options: {}, indexes: [{ name: '_id_', key: { _id: 1 } }] }
        ],
        nativeValidation: { performed: false, results: [] }
      },
      oplog: { earliest: { ts: { $timestamp: { t: 100, i: 1 } } }, latest: { ts: { $timestamp: { t: 200, i: 1 } } } }
    };
    return { exitCode: 0, stdout: `DX_MONGODB_ID\x1f${JSON.stringify(value)}\n` };
  }
}

async function run() {
  await app.whenReady();
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Electron safeStorage is unavailable on this device.');
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-mongodb-electron-test-'));
  const password = `electron-mongodb-${Date.now()}-${Math.random()}`;
  let controlDatabase = null;
  try {
    controlDatabase = new BackupControlDatabase({ rootPath: path.join(rootPath, 'control') });
    await controlDatabase.initialize();
    const secretStore = new BackupSecretStore({ rootPath: path.join(rootPath, 'secrets'), secureStorage: safeStorage, isReferenced: async () => false });
    await secretStore.initialize();
    const runner = new Runner();
    const adapter = new MongoDbNativeAdapter({ processRunner: runner });
    const connections = new MongoDbConnectionService({ controlDatabase, secretStore, deviceId: 'mongodb-electron-device', adapter });
    const created = await connections.create('local', 'electron-test', {
      name: 'Electron MongoDB', host: 'mongo01.example.com', username: 'deployerx_backup', password,
      authSource: 'admin', replicaSet: 'rs0', expectedTopology: 'replica-set', tlsMode: 'verify-identity'
    });
    const tested = await connections.test('local', created.id, 'electron-test');
    const discovered = await connections.discover('local', created.id);
    const sourceService = new DatabaseSourceService({ controlDatabase, adapterRegistry: new DatabaseAdapterRegistry([adapter]) });
    const source = await sourceService.save('local', 'electron-test', {
      name: 'Electron MongoDB replica-set', connectionId: created.id, selector: { allDatabases: true },
      consistency: { requestedLevel: 'application', method: 'mongodb-oplog-dump', backupMethod: 'logical', backupMode: 'full', captureCoordinates: true }
    });

    await controlDatabase.close();
    controlDatabase = new BackupControlDatabase({ rootPath: path.join(rootPath, 'control') });
    await controlDatabase.initialize();
    const [persistedConnection] = await controlDatabase.repository('connection').list('local');
    const controlBytes = await fs.readFile(path.join(rootPath, 'control', 'control.db'));
    const secretBytes = await fs.readFile(path.join(rootPath, 'secrets', 'secrets.json'));
    const commandSurfaces = JSON.stringify(runner.calls.map((call) => ({ args: call.args, env: call.env })));
    const ok = tested.result.status === 'success'
      && tested.connection.trust.fingerprint?.startsWith('sha256:')
      && discovered.items.map((item) => item.name).join(',') === 'analytics,orders'
      && persistedConnection.secretRefIds.length === 1
      && source.adapterId === adapter.manifest().adapterId
      && !commandSurfaces.includes(password)
      && runner.calls.every((call) => call.stdin.includes(password))
      && !controlBytes.includes(Buffer.from(password))
      && !secretBytes.includes(Buffer.from(password));
    process.stdout.write(`${JSON.stringify({ ok, connectionStatus: tested.result.status, topology: tested.result.endpointIdentity.topology, databases: discovered.items.map((item) => item.name), sourceCreated: Boolean(source.id), plaintextPersisted: controlBytes.includes(Buffer.from(password)) || secretBytes.includes(Buffer.from(password)) })}\n`);
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
