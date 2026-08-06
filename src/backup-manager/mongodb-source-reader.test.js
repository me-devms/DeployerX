const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { BackupControlDatabase } = require('./control-database');
const { DatabaseAdapterRegistry } = require('./database-adapter');
const { DatabaseSourceService } = require('./database-source');
const { MongoDbConnectionService, MongoDbNativeAdapter, oplogCoordinate } = require('./mongodb');
const { MongoDbSourceReaderService } = require('./mongodb-source-reader');
const { BackupSecretStore } = require('./secrets');

function secureStorage() {
  return { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(`encrypted:${value}`), decryptString: (value) => Buffer.from(value).toString().replace(/^encrypted:/, '') };
}

function identity(overrides = {}) {
  return {
    topology: 'replica-set', version: '8.0.4', featureCompatibilityVersion: '8.0', setName: 'rs0',
    replicaSetId: 'ObjectId(0123456789abcdef01234567)', clusterId: null, endpointIdentity: 'mongo01.example.com:27017',
    primary: 'mongo01.example.com:27017', me: 'mongo02.example.com:27017', members: ['mongo01.example.com:27017', 'mongo02.example.com:27017'],
    storageEngine: 'wiredTiger', persistent: true, logicalSessionTimeoutMinutes: 30,
    databases: ['admin', 'config', 'local', 'orders'], authenticatedUsers: [{ user: 'backup', db: 'admin' }],
    authenticatedRoles: [{ role: 'backup', db: 'admin' }], privilegeCount: 8,
    privilegeActions: ['find', 'listCollections', 'listDatabases', 'listIndexes'],
    logicalInventory: {
      version: 1, databases: ['orders'], indexCount: 1,
      collections: [{ database: 'orders', name: 'events', type: 'collection', uuid: { $uuid: '22222222-2222-3333-4444-555555555555' }, options: {}, indexes: [{ name: '_id_', key: { _id: 1 } }] }],
      nativeValidation: { performed: false, results: [] }
    },
    oplog: {
      earliest: { ts: { $timestamp: { t: 100, i: 1 } }, t: 1, h: '1' },
      latest: { ts: { $timestamp: { t: 200, i: 1 } }, t: 1, h: '2' }
    },
    ...overrides
  };
}

class Runner {
  constructor() { this.dump = Buffer.from('authenticated-mongodb-archive'); this.bson = Buffer.from([5, 0, 0, 0, 0]); this.streamCalls = 0; this.configFiles = []; this.currentIdentity = identity(); }
  async consume() { return { exitCode: 0, stdout: `DX_MONGODB_ID\x1f${JSON.stringify(this.currentIdentity)}\n` }; }
  async run(input) {
    const output = input.args.find((argument) => argument.startsWith('--out='));
    if (output) {
      const configPath = input.args.find((argument) => argument.startsWith('--config=')).slice('--config='.length);
      this.configFiles.push(await fs.readFile(configPath, 'utf8'));
      const directory = path.join(output.slice('--out='.length), 'local');
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, 'oplog.rs.bson'), this.bson);
      return { exitCode: 0, stdout: 'done', stderr: '' };
    }
    return { exitCode: 0, stdout: 'mongodump version: 100.13.0', stderr: '' };
  }
  stream(input) {
    this.streamCalls += 1;
    const configPath = input.args.find((argument) => argument.startsWith('--config=')).slice('--config='.length);
    const inspect = fs.readFile(configPath, 'utf8').then((contents) => this.configFiles.push(contents));
    return { stdout: Readable.from((async function* (runner) { await inspect; yield runner.dump; })(this)), completion: inspect.then(() => ({ exitCode: 0, stderr: '' })), cancel() {} };
  }
}

async function fixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-mongodb-reader-test-'));
  const controlDatabase = new BackupControlDatabase({ rootPath: path.join(root, 'control') });
  await controlDatabase.initialize();
  const secretStore = new BackupSecretStore({ rootPath: path.join(root, 'secrets'), secureStorage: secureStorage(), isReferenced: async () => false });
  await secretStore.initialize();
  context.after(async () => { await controlDatabase.close(); await fs.rm(root, { recursive: true, force: true }); });
  const credentialRoot = path.join(root, 'credentials');
  const dumpRoot = path.join(root, 'dumps');
  await fs.mkdir(credentialRoot, { recursive: true });
  await fs.mkdir(dumpRoot, { recursive: true });
  const runner = new Runner();
  const adapter = new MongoDbNativeAdapter({ processRunner: runner, temporaryRoot: credentialRoot, clock: () => '2026-08-04T00:00:00.000Z' });
  const registry = new DatabaseAdapterRegistry([adapter]);
  const connections = new MongoDbConnectionService({ controlDatabase, secretStore, deviceId: 'device-a', adapter });
  const connection = await connections.create('workspace-a', 'tester', { name: 'Production MongoDB', host: 'mongo01.example.com', username: 'backup', password: 'not-persisted', authSource: 'admin', replicaSet: 'rs0', expectedTopology: 'replica-set' });
  const tested = await connections.test('workspace-a', connection.id, 'tester');
  const source = await new DatabaseSourceService({ controlDatabase, adapterRegistry: registry, deviceId: 'device-a' }).save('workspace-a', 'tester', {
    name: 'MongoDB replica-set anchor', connectionId: connection.id, selector: { allDatabases: true },
    consistency: { requestedLevel: 'application', method: 'mongodb-oplog-dump', backupMethod: 'logical', backupMode: 'full', captureCoordinates: true }
  });
  const reader = new MongoDbSourceReaderService({ controlDatabase, secretStore, deviceId: 'device-a', adapterRegistry: registry, adapter, temporaryRoot: dumpRoot });
  return { root, dumpRoot, controlDatabase, secretStore, runner, adapter, registry, connection: tested.connection, source, reader };
}

async function collectFiles(files) {
  const entries = [];
  for await (const entry of files.create()) {
    const chunks = [];
    for await (const chunk of entry.content) chunks.push(Buffer.from(chunk));
    entries.push({ ...entry, content: Buffer.concat(chunks) });
  }
  return entries;
}

test('spools one authenticated MongoDB oplog anchor per run and releases it after publication', async (context) => {
  const { root, dumpRoot, runner, connection, source, reader } = await fixture(context);
  const first = await reader.files('workspace-a', source.id, { executionId: 'run_mongodb_anchor' });
  const second = await reader.files('workspace-a', source.id, { executionId: 'run_mongodb_anchor' });
  const [one] = await collectFiles(first);
  const [two] = await collectFiles(second);
  assert.equal(runner.streamCalls, 1);
  assert.equal(one.content.equals(runner.dump), true);
  assert.equal(two.content.equals(runner.dump), true);
  assert.equal(first.manifest.consistency.achievedLevel, 'application');
  assert.equal(one.metadata.database.binaryLog.anchorCoordinate.engine, 'mongodb');
  assert.deepEqual(one.metadata.database.binaryLog.anchorCoordinate.start, identity().oplog.latest.ts);
  assert.deepEqual(one.metadata.database.binaryLog.anchorCoordinate.end, identity().oplog.latest.ts);
  assert.match(connection.trust.fingerprint, /^sha256:/);
  assert.equal(runner.configFiles.some((contents) => contents.includes('not-persisted')), true);
  assert.equal((await fs.readFile(path.join(root, 'control', 'control.db'))).includes(Buffer.from('not-persisted')), false);
  assert.equal((await fs.readdir(dumpRoot)).length, 1);
  await reader.release('workspace-a', 'run_mongodb_anchor');
  assert.deepEqual(await fs.readdir(dumpRoot), []);
});

test('publishes one BSON transaction-log artifact and reports a non-advancing range as no change', async (context) => {
  const { controlDatabase, secretStore, dumpRoot, runner, adapter, registry, source, reader: anchorReader } = await fixture(context);
  const anchorFiles = await anchorReader.files('workspace-a', source.id, { executionId: 'run_anchor_for_logs' });
  const [anchorEntry] = await collectFiles(anchorFiles);
  const anchorMetadata = anchorEntry.metadata.database;
  await anchorReader.release('workspace-a', 'run_anchor_for_logs');

  let artifacts = [{ recoveryPointId: 'rp_mongodb_anchor', kind: 'database-dump', metadata: anchorMetadata }];
  const proxyDatabase = {
    repository(name) {
      if (name === 'artifact') return { list: async () => artifacts };
      return controlDatabase.repository(name);
    }
  };
  const logReader = new MongoDbSourceReaderService({ controlDatabase: proxyDatabase, secretStore, deviceId: 'device-a', adapterRegistry: registry, adapter, temporaryRoot: dumpRoot });
  const base = identity();
  assert.equal(anchorMetadata.binaryLog.anchorCoordinate.historyFingerprint, oplogCoordinate(base.oplog.latest).historyFingerprint);
  const endEntry = { ts: { $timestamp: { t: 300, i: 2 } }, t: 2, h: 'next' };
  runner.currentIdentity = identity({ oplog: { earliest: base.oplog.earliest, latest: endEntry, probe: base.oplog.latest } });
  const previousPoint = { id: 'rp_mongodb_anchor', sourceId: source.id, type: 'full', chainRootId: 'rp_mongodb_anchor' };
  const logFiles = await logReader.files('workspace-a', source.id, { executionId: 'run_mongodb_log', backupMode: 'incremental', previousRecoveryPoint: previousPoint });
  const [logEntry] = await collectFiles(logFiles);
  assert.equal(logFiles.manifest.noChange, false);
  assert.equal(logEntry.metadata.artifactKind, 'transaction-log');
  assert.equal(logEntry.metadata.database.kind, 'mongodb-oplog');
  assert.deepEqual(logEntry.metadata.database.binaryLog.startCoordinate.timestamp, base.oplog.latest.ts);
  assert.deepEqual(logEntry.metadata.database.binaryLog.endCoordinate.timestamp, endEntry.ts);
  assert.equal(logEntry.content.equals(runner.bson), true);

  artifacts = [{ recoveryPointId: 'rp_mongodb_log', kind: 'transaction-log', metadata: logEntry.metadata.database }];
  runner.currentIdentity = identity({ oplog: { earliest: base.oplog.earliest, latest: endEntry, probe: endEntry } });
  const noChange = await logReader.files('workspace-a', source.id, {
    executionId: 'run_mongodb_no_change', backupMode: 'incremental',
    previousRecoveryPoint: { id: 'rp_mongodb_log', sourceId: source.id, type: 'log', chainRootId: 'rp_mongodb_anchor' }
  });
  assert.equal(noChange.manifest.noChange, true);
  assert.deepEqual(noChange.manifest.artifactPaths, []);
  await logReader.release('workspace-a', 'run_mongodb_log');
  await logReader.release('workspace-a', 'run_mongodb_no_change');
});
