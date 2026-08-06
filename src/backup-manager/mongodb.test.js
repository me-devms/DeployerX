const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { DatabaseAdapterRegistry } = require('./database-adapter');
const {
  ADAPTER_ID,
  MongoDbConnectionService,
  MongoDbNativeAdapter,
  compareLogicalInventories,
  deploymentFingerprint,
  logicalInventoryFromMetadata,
  logicalInventoryMetadata,
  normalizeConfig,
  normalizeShardedTopology,
  oplogCoordinate,
  parseIdentity,
  replicaMemberConfig,
  shardedTopologyFingerprint,
  validateBsonFile,
  validateIdentity
} = require('./mongodb');

const PASSWORD = 'privateMongoPassword';
const MARKER = 'DX_MONGODB_ID\x1f';

function config(overrides = {}) {
  return {
    host: 'mongo01.example.com', port: 27017, username: 'deployerx_backup', passwordSecretRefId: 'secret-mongodb',
    authSource: 'admin', expectedTopology: 'auto', tlsMode: 'verify-identity', timeoutMs: 5000, ...overrides
  };
}

function logicalInventory(databases = ['accounts', 'orders']) {
  return {
    version: 1, databases,
    collections: databases.map((database) => ({
      database, name: 'events', type: 'collection', uuid: { $uuid: `${database === 'accounts' ? '11111111' : '22222222'}-2222-3333-4444-555555555555` },
      options: { capped: false, size: null, max: null, validator: null, validationLevel: null, validationAction: null, timeseries: null, clusteredIndex: null, changeStreamPreAndPostImages: null, collation: null, viewOn: null, pipeline: null },
      indexes: [{ name: '_id_', key: { _id: 1 }, unique: false, sparse: false, hidden: false, expireAfterSeconds: null, partialFilterExpression: null, collation: null, wildcardProjection: null, weights: null, default_language: null, language_override: null, textIndexVersion: null, '2dsphereIndexVersion': null, bits: null, min: null, max: null, bucketSize: null, clustered: false }]
    })),
    indexCount: databases.length,
    nativeValidation: { performed: false, results: [] }
  };
}

function identity(overrides = {}) {
  return {
    topology: 'replica-set', version: '8.0.4', featureCompatibilityVersion: '8.0', setName: 'rs0',
    replicaSetId: 'ObjectId(0123456789abcdef01234567)', clusterId: null, endpointIdentity: 'mongo01.example.com:27017',
    primary: 'mongo01.example.com:27017', me: 'mongo02.example.com:27017',
    members: ['mongo01.example.com:27017', 'mongo02.example.com:27017', 'mongo03.example.com:27017'],
    storageEngine: 'wiredTiger', persistent: true, logicalSessionTimeoutMinutes: 30,
    databases: ['admin', 'accounts', 'config', 'local', 'orders'],
    authenticatedUsers: [{ user: 'deployerx_backup', db: 'admin' }],
    authenticatedRoles: [{ role: 'backup', db: 'admin' }], privilegeCount: 12,
    privilegeActions: ['find', 'listCollections', 'listDatabases', 'listIndexes'],
    logicalInventory: logicalInventory(),
    replicaStatus: {
      lastCommittedOpTime: { ts: { $timestamp: { t: 198, i: 1 } }, t: 1 },
      members: [
        { name: 'mongo01.example.com:27017', state: 'PRIMARY', health: 1, self: false, uptime: 1000, optime: { ts: { $timestamp: { t: 200, i: 1 } }, t: 1 }, arbiterOnly: false, hidden: false, secondaryDelaySecs: 0, votes: 1, priority: 1 },
        { name: 'mongo02.example.com:27017', state: 'SECONDARY', health: 1, self: true, uptime: 900, optime: { ts: { $timestamp: { t: 199, i: 1 } }, t: 1 }, syncSourceHost: 'mongo01.example.com:27017', arbiterOnly: false, hidden: false, secondaryDelaySecs: 0, votes: 1, priority: 1 }
      ]
    },
    oplog: {
      earliest: { ts: { $timestamp: { t: 100, i: 1 } }, t: 1, h: '1' },
      latest: { ts: { $timestamp: { t: 200, i: 1 } }, t: 1, h: '2' }
    },
    ...overrides
  };
}

function encodedIdentity(value) {
  return `${MARKER}${JSON.stringify(value)}\n`;
}

class Runner {
  constructor(value = identity()) { this.value = value; this.values = Array.isArray(value) ? value : null; this.identityIndex = 0; this.calls = []; this.toolCalls = []; this.configFiles = []; this.dump = Buffer.from('mongodb-archive'); this.bson = Buffer.from([5, 0, 0, 0, 0]); }
  async consume(input) {
    if (path.win32.basename(input.executable).toLowerCase().replace(/[.]exe$/, '') === 'mongorestore') {
      const chunks = [];
      if (input.stdin && typeof input.stdin[Symbol.asyncIterator] === 'function') {
        for await (const chunk of input.stdin) chunks.push(Buffer.from(chunk));
      } else chunks.push(Buffer.from(input.stdin || ''));
      this.calls.push({ executable: input.executable, args: [...input.args], env: { ...(input.env || {}) }, stdin: Buffer.concat(chunks).toString('utf8') });
      return { exitCode: 0, stdout: 'restored', stderr: '' };
    }
    this.calls.push({ executable: input.executable, args: [...input.args], env: { ...(input.env || {}) }, stdin: Buffer.from(input.stdin).toString('utf8') });
    const source = this.values ? this.values[Math.min(this.identityIndex++, this.values.length - 1)] : this.value;
    const value = structuredClone(source);
    if (this.calls.at(-1).stdin.includes('const dxRunNativeValidation = true') && value.logicalInventory) {
      value.logicalInventory.nativeValidation = { performed: true, results: value.logicalInventory.collections.filter((item) => item.type === 'collection').map((item) => ({ database: item.database, name: item.name, ok: true, valid: true, warnings: 0, errors: 0, nIndexes: item.indexes.length, nrecords: 5 })) };
    }
    return { exitCode: 0, stdout: encodedIdentity(value) };
  }

  async run(input) {
    this.toolCalls.push({ executable: input.executable, args: [...input.args] });
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
    const configPath = input.args.find((argument) => argument.startsWith('--config=')).slice('--config='.length);
    const inspection = fs.readFile(configPath, 'utf8').then((contents) => {
      this.configFiles.push(contents);
      this.toolCalls.push({ executable: input.executable, args: [...input.args] });
    });
    return {
      stdout: Readable.from((async function* (runner) { await inspection; yield runner.dump; })(this)),
      completion: inspection.then(() => ({ exitCode: 0, stderr: '' })),
      cancel() {}
    };
  }
}

test('requires verified TLS and rejects unknown or unsafe MongoDB connection fields', () => {
  assert.equal(normalizeConfig(config()).tlsMode, 'verify-identity');
  assert.throws(() => normalizeConfig(config({ tlsMode: 'require' })), /identity verification/);
  assert.throws(() => normalizeConfig(config({ connectionString: 'mongodb:\/\/example.com' })), /Unknown MongoDB connection field/);
  assert.throws(() => normalizeConfig(config({ host: 'mongodb:\/\/example.com' })), /hostname or IP address/);
  assert.throws(() => normalizeConfig(config({ mongoshExecutable: 'powershell.exe' })), /Only the mongosh executable/);
});

test('passes the MongoDB password only through bounded mongosh standard input', async () => {
  const runner = new Runner();
  const adapter = new MongoDbNativeAdapter({ processRunner: runner, clock: () => '2026-08-04T00:00:00.000Z', now: (() => { let value = 0; return () => value += 5; })() });
  const result = await adapter.testConnection({ resolveSecret: async () => PASSWORD }, config({ replicaSet: 'rs0' }));
  assert.equal(result.status, 'success');
  assert.deepEqual(runner.calls[0].args, ['--nodb', '--quiet']);
  assert.equal(JSON.stringify(runner.calls[0].args).includes(PASSWORD), false);
  assert.equal(JSON.stringify(runner.calls[0].env).includes(PASSWORD), false);
  assert.equal(runner.calls[0].stdin.includes(PASSWORD), true);
  assert.equal(runner.calls[0].stdin.includes('tls=true'), true);
  assert.equal(result.endpointIdentity.topology, 'replica-set');
  assert.match(result.endpointIdentity.deploymentFingerprint, /^sha256:[a-f0-9]{64}$/);
});

test('locks and unlocks only the authenticated direct replica-set member with stdin credentials', async () => {
  const calls = [];
  const runner = {
    async consume(input) {
      const stdin = Buffer.from(input.stdin).toString('utf8');
      calls.push({ args: input.args, env: input.env, stdin });
      const action = stdin.includes('fsyncUnlock') ? 'unlock' : 'lock';
      return { exitCode: 0, stdout: `DX_MONGODB_SNAPSHOT_LOCK\x1f${JSON.stringify({ action, member: 'mongo02.example.com:27018', setName: 'rs0', lockCount: action === 'lock' ? 1 : 0, operationTime: { $timestamp: { t: 200, i: 3 } } })}\n` };
    }
  };
  const adapter = new MongoDbNativeAdapter({ processRunner: runner });
  const memberConfig = replicaMemberConfig(config({ replicaSet: 'rs0' }), 'mongo02.example.com:27018');
  assert.equal(memberConfig.host, 'mongo02.example.com');
  assert.equal(memberConfig.port, 27018);
  const locked = await adapter.setSnapshotMemberLock({ resolveSecret: async () => PASSWORD }, config({ replicaSet: 'rs0' }), 'mongo02.example.com:27018', true);
  const unlocked = await adapter.setSnapshotMemberLock({ resolveSecret: async () => PASSWORD }, config({ replicaSet: 'rs0' }), 'mongo02.example.com:27018', false);
  assert.equal(locked.lockCount, 1);
  assert.equal(unlocked.action, 'unlock');
  assert.equal(calls.every((call) => call.args.join(' ').includes(PASSWORD) === false && JSON.stringify(call.env).includes(PASSWORD) === false), true);
  assert.equal(calls.every((call) => call.stdin.includes(PASSWORD) && call.stdin.includes('mongo02.example.com:27018') && call.stdin.includes('directConnection=true')), true);
});

test('parses stable replica-set, sharded-cluster, and standalone deployment identities', () => {
  const replicaSet = parseIdentity(encodedIdentity(identity()));
  const sharded = parseIdentity(encodedIdentity(identity({
    topology: 'sharded', setName: null, replicaSetId: null, clusterId: 'ObjectId(fedcba987654321001234567)',
    primary: null, me: null, members: [], storageEngine: null, persistent: null, replicaStatus: null
  })));
  const standalone = parseIdentity(encodedIdentity(identity({
    topology: 'standalone', setName: null, replicaSetId: null, clusterId: null, primary: null, me: null,
    members: [], endpointIdentity: 'standalone.example.com:27017', replicaStatus: null
  })));
  assert.equal(replicaSet.deploymentId, replicaSet.replicaSetId);
  assert.equal(replicaSet.replicaStatus.members[1].state, 'SECONDARY');
  assert.deepEqual(replicaSet.replicaStatus.lastCommittedOpTime.timestamp, { $timestamp: { t: 198, i: 1 } });
  assert.equal(sharded.deploymentId, sharded.clusterId);
  assert.equal(standalone.deploymentId, 'standalone.example.com:27017');
  assert.notEqual(deploymentFingerprint(replicaSet), deploymentFingerprint(sharded));
});

test('normalizes authenticated mongos topology and bounded routing metadata evidence', () => {
  const shardedTopology = {
    configServer: 'configRs/cfg02.example.com:27019,cfg01.example.com:27019',
    shards: [
      { _id: 'shard-a', host: 'rsA/a02.example.com:27017,a01.example.com:27017', state: { $numberInt: '1' } },
      { _id: 'shard-b', host: 'rsB/b01.example.com:27017,b02.example.com:27017', state: 1 }
    ],
    databasePrimaries: [{ _id: 'orders', primary: 'shard-a', partitioned: true, version: { uuid: 'db-version' } }],
    collectionCount: { $numberLong: '1' },
    collections: [{ _id: 'orders.events', uuid: { $uuid: '01234567-89ab-cdef-0123-456789abcdef' }, key: { tenantId: 1 }, unique: false, timestamp: { $timestamp: { t: 500, i: 1 } } }],
    chunks: {
      count: { $numberLong: '2' },
      head: [{ _id: 'chunk-a', shard: 'shard-a', min: { tenantId: 0 }, max: { tenantId: 100 } }],
      tail: [{ _id: 'chunk-b', shard: 'shard-b', min: { tenantId: 100 }, max: { tenantId: 200 } }],
      byShard: [{ _id: 'shard-a', count: { $numberLong: '1' } }, { _id: 'shard-b', count: { $numberLong: '1' } }]
    },
    balancer: { mode: 'full', inBalancerRound: false, numBalancerRounds: { $numberLong: '12' }, settings: { mode: 'full' } },
    operationTime: { $timestamp: { t: 501, i: 2 } }
  };
  const parsed = parseIdentity(encodedIdentity(identity({
    topology: 'sharded', setName: null, replicaSetId: null, replicaRole: null, clusterId: 'ObjectId(fedcba987654321001234567)',
    primary: null, me: null, members: [], storageEngine: null, persistent: null, replicaStatus: null, oplog: null, shardedTopology
  })));
  assert.equal(parsed.shardedTopology.configServer.setName, 'configRs');
  assert.deepEqual(parsed.shardedTopology.configServer.hosts, ['cfg01.example.com:27019', 'cfg02.example.com:27019']);
  assert.deepEqual(parsed.shardedTopology.shards.map((item) => item.shardId), ['shard-a', 'shard-b']);
  assert.equal(parsed.shardedTopology.collectionEvidence.mode, 'complete');
  assert.equal(parsed.shardedTopology.chunkEvidence.total, 2);
  assert.equal(parsed.shardedTopology.balancer.running, true);
  assert.match(shardedTopologyFingerprint(parsed), /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(normalizeShardedTopology(shardedTopology), parsed.shardedTopology);
});

test('stops and starts the balancer only through authenticated mongos stdin', async () => {
  const calls = [];
  const runner = {
    async consume(input) {
      const stdin = Buffer.from(input.stdin).toString('utf8');
      calls.push({ args: input.args, env: input.env, stdin });
      const action = stdin.includes('balancerStop') ? 'stop' : stdin.includes('balancerStart') ? 'start' : 'status';
      const mode = action === 'stop' ? 'off' : 'full';
      return { exitCode: 0, stdout: `DX_MONGODB_BALANCER\x1f${JSON.stringify({ action, mode, inBalancerRound: false, operationTime: { $timestamp: { t: 510, i: 1 } } })}\n` };
    }
  };
  const adapter = new MongoDbNativeAdapter({ processRunner: runner });
  const router = config({ expectedTopology: 'sharded' });
  assert.equal((await adapter.setBalancerState({ resolveSecret: async () => PASSWORD }, router, 'status')).running, true);
  assert.equal((await adapter.setBalancerState({ resolveSecret: async () => PASSWORD }, router, 'stop')).running, false);
  assert.equal((await adapter.setBalancerState({ resolveSecret: async () => PASSWORD }, router, 'start')).running, true);
  assert.equal(calls.every((call) => JSON.stringify(call.args).includes(PASSWORD) === false && JSON.stringify(call.env).includes(PASSWORD) === false), true);
  assert.equal(calls.every((call) => call.stdin.includes(PASSWORD) && call.stdin.includes("msg !== 'isdbgrid'")), true);
});

test('normalizes a bounded collection, UUID, option, and index validation inventory', () => {
  const parsed = parseIdentity(encodedIdentity(identity()));
  const inventory = parsed.logicalInventory;
  assert.equal(inventory.collections.length, 2);
  assert.equal(inventory.indexCount, 2);
  assert.match(inventory.inventoryFingerprint, /^sha256:[a-f0-9]{64}$/);
  const metadata = logicalInventoryMetadata(inventory);
  assert.deepEqual(logicalInventoryFromMetadata(metadata), inventory);
  assert.equal(compareLogicalInventories(inventory, { ...inventory, nativeValidation: { performed: true, results: inventory.collections.map((item) => ({ database: item.database, name: item.name, ok: true, valid: true, warnings: 0, errors: 0 })) } }).valid, true);
});

test('validates restored collections, indexes, UUIDs, and native integrity with stdin-only credentials', async () => {
  const raw = identity({ privilegeActions: ['find', 'listCollections', 'listDatabases', 'insert', 'createCollection', 'createIndex', 'dropCollection'] });
  const runner = new Runner(raw);
  const adapter = new MongoDbNativeAdapter({ processRunner: runner });
  const expected = parseIdentity(encodedIdentity(raw)).logicalInventory;
  const result = await adapter.validateRestore({ resolveSecret: async () => PASSWORD }, {
    connection: config({ replicaSet: 'rs0', expectedTopology: 'replica-set' }), expectedDatabases: expected.databases,
    validationInventory: expected, requireUuid: true, targetFingerprint: deploymentFingerprint(parseIdentity(encodedIdentity(raw)))
  });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.nativeIntegrityValidation, true);
  assert.equal(result.checks.find((check) => check.id === 'expected-objects').status, 'pass');
  assert.equal(result.checks.find((check) => check.id === 'indexes').status, 'pass');
  assert.equal(result.checks.find((check) => check.id === 'native-validation').collectionsChecked, 2);
  assert.equal(runner.calls.at(-1).stdin.includes('runCommand({ validate:'), true);
  assert.equal(runner.calls.at(-1).stdin.includes(PASSWORD), true);
  assert.equal(JSON.stringify(runner.calls.at(-1).args).includes(PASSWORD) || JSON.stringify(runner.calls.at(-1).env).includes(PASSWORD), false);
});

test('fails restore validation on UUID, index, and native collection divergence', async () => {
  const expectedRaw = identity();
  const expectedIdentity = parseIdentity(encodedIdentity(expectedRaw));
  const changed = structuredClone(expectedRaw);
  changed.logicalInventory.collections[0].uuid = { $uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' };
  changed.logicalInventory.collections[1].indexes[0].key = { changed: 1 };
  changed.logicalInventory.nativeValidation = { performed: true, results: changed.logicalInventory.collections.map((item, index) => ({ database: item.database, name: item.name, ok: true, valid: index !== 0, warnings: 0, errors: index === 0 ? 1 : 0 })) };
  const runner = { async consume() { return { exitCode: 0, stdout: encodedIdentity(changed) }; } };
  const adapter = new MongoDbNativeAdapter({ processRunner: runner });
  const result = await adapter.validateRestore({ resolveSecret: async () => PASSWORD }, {
    connection: config({ replicaSet: 'rs0', expectedTopology: 'replica-set' }), expectedDatabases: expectedIdentity.logicalInventory.databases,
    validationInventory: expectedIdentity.logicalInventory, requireUuid: true, targetFingerprint: deploymentFingerprint(expectedIdentity)
  });
  assert.equal(result.valid, false);
  assert.equal(result.checks.find((check) => check.id === 'collection-uuids').status, 'fail');
  assert.equal(result.checks.find((check) => check.id === 'indexes').status, 'fail');
  assert.equal(result.checks.find((check) => check.id === 'native-validation').status, 'fail');
});

test('reports a warning for legacy MongoDB recovery points without object inventory', async () => {
  const raw = identity();
  const adapter = new MongoDbNativeAdapter({ processRunner: new Runner(raw) });
  const parsed = parseIdentity(encodedIdentity(raw));
  const result = await adapter.validateRestore({ resolveSecret: async () => PASSWORD }, {
    connection: config({ replicaSet: 'rs0', expectedTopology: 'replica-set' }), expectedDatabases: ['accounts', 'orders'], targetFingerprint: deploymentFingerprint(parsed)
  });
  assert.equal(result.status, 'warning');
  assert.equal(result.valid, true);
  assert.equal(result.nativeIntegrityValidation, false);
  assert.equal(result.checks.find((check) => check.id === 'expected-objects').reasonCode, 'MONGODB_VALIDATION_INVENTORY_UNAVAILABLE');
});

test('refuses topology, replica-set, version, storage-engine, and persistence mismatches', () => {
  const replicaSet = parseIdentity(encodedIdentity(identity()));
  assert.throws(() => validateIdentity(config({ expectedTopology: 'sharded' }), replicaSet), (error) => error.code === 'MONGODB_TOPOLOGY_MISMATCH');
  assert.throws(() => validateIdentity(config({ replicaSet: 'other' }), replicaSet), (error) => error.code === 'MONGODB_REPLICA_SET_MISMATCH');
  assert.throws(() => parseIdentity(encodedIdentity(identity({ version: '6.0.18' }))), (error) => error.code === 'MONGODB_VERSION_UNSUPPORTED');
  assert.throws(() => validateIdentity(config(), parseIdentity(encodedIdentity(identity({ storageEngine: 'inMemory' })))), (error) => error.code === 'MONGODB_STORAGE_ENGINE_UNSUPPORTED');
  assert.throws(() => validateIdentity(config(), parseIdentity(encodedIdentity(identity({ persistent: false })))), (error) => error.code === 'MONGODB_STORAGE_NOT_PERSISTENT');
});

test('discovers user databases by default and exposes system databases only when requested', async () => {
  const adapter = new MongoDbNativeAdapter({ processRunner: new Runner() });
  const userPages = [];
  for await (const page of adapter.discover({ resolveSecret: async () => PASSWORD }, { connection: config() })) userPages.push(page);
  assert.deepEqual(userPages[0].items.map((item) => item.name), ['accounts', 'orders']);
  const allPages = [];
  for await (const page of adapter.discover({ resolveSecret: async () => PASSWORD }, { connection: config(), includeSystem: true })) allPages.push(page);
  assert.deepEqual(allPages[0].items.map((item) => item.name), ['accounts', 'admin', 'config', 'local', 'orders']);
  assert.equal(allPages[0].items.find((item) => item.name === 'admin').selectable, false);
});

test('preflights original and alternate restore targets with identity, privilege, version, and collision safeguards', async () => {
  const restoreActions = ['find', 'listCollections', 'listDatabases', 'listIndexes', 'validate', 'insert', 'createCollection', 'createIndex', 'dropCollection'];
  const originalIdentity = parseIdentity(encodedIdentity(identity({ privilegeActions: restoreActions })));
  const metadata = { serverVersion: originalIdentity.version, serverIdentityFingerprint: deploymentFingerprint(originalIdentity), databases: ['accounts', 'orders'] };
  const original = new MongoDbNativeAdapter({ processRunner: new Runner(identity({ privilegeActions: restoreActions })) });
  const prepared = await original.prepareRestoreTarget({ resolveSecret: async () => PASSWORD }, { mode: 'original', connection: config(), metadata });
  assert.equal(prepared.destructive, true);
  assert.deepEqual(prepared.expectedDatabases, ['accounts', 'orders']);

  const alternateIdentity = identity({ replicaSetId: 'ObjectId(fedcba987654321001234567)', privilegeActions: restoreActions });
  const alternate = new MongoDbNativeAdapter({ processRunner: new Runner(alternateIdentity) });
  await assert.rejects(alternate.prepareRestoreTarget({ resolveSecret: async () => PASSWORD }, { mode: 'alternate', connection: config(), metadata, conflictPolicy: 'fail' }), (error) => error.code === 'MONGODB_ALTERNATE_TARGET_CONFLICT');
  const overwrite = await alternate.prepareRestoreTarget({ resolveSecret: async () => PASSWORD }, { mode: 'alternate', connection: config(), metadata, conflictPolicy: 'overwrite' });
  assert.deepEqual(overwrite.collisions, ['accounts', 'orders']);

  const weak = new MongoDbNativeAdapter({ processRunner: new Runner(identity()) });
  await assert.rejects(weak.prepareRestoreTarget({ resolveSecret: async () => PASSWORD }, { mode: 'original', connection: config(), metadata }), (error) => error.code === 'MONGODB_RESTORE_PRIVILEGES_MISSING');

  const inventoryMetadata = { ...metadata, ...logicalInventoryMetadata(originalIdentity.logicalInventory) };
  const noDropIdentity = identity({ replicaSetId: 'ObjectId(aaaaaaaaaaaaaaaaaaaaaaaa)', deploymentId: 'ObjectId(aaaaaaaaaaaaaaaaaaaaaaaa)', privilegeActions: restoreActions.filter((action) => action !== 'dropCollection') });
  const noDrop = new MongoDbNativeAdapter({ processRunner: new Runner(noDropIdentity) });
  await assert.rejects(noDrop.prepareRestoreTarget({ resolveSecret: async () => PASSWORD }, { mode: 'alternate', connection: config(), metadata: inventoryMetadata, conflictPolicy: 'overwrite' }), (error) => error.code === 'MONGODB_RESTORE_PRIVILEGES_MISSING');
  const noValidateIdentity = identity({ privilegeActions: restoreActions.filter((action) => action !== 'validate') });
  const noValidate = new MongoDbNativeAdapter({ processRunner: new Runner(noValidateIdentity) });
  await assert.rejects(noValidate.prepareRestoreTarget({ resolveSecret: async () => PASSWORD }, { mode: 'original', connection: config(), metadata: inventoryMetadata }), (error) => error.code === 'MONGODB_RESTORE_PRIVILEGES_MISSING');
});

test('recovers a replica-set logical anchor into a verified standalone target', async () => {
  const restoreActions = ['find', 'listCollections', 'listDatabases', 'listIndexes', 'validate', 'insert', 'createCollection', 'createIndex', 'dropCollection'];
  const sourceIdentity = parseIdentity(encodedIdentity(identity({ privilegeActions: restoreActions })));
  const metadata = {
    serverVersion: sourceIdentity.version,
    serverIdentityFingerprint: deploymentFingerprint(sourceIdentity),
    databases: ['accounts', 'orders'],
    ...logicalInventoryMetadata(sourceIdentity.logicalInventory)
  };
  const standalone = (databases, inventory) => identity({
    topology: 'standalone', setName: null, replicaSetId: null, clusterId: null, primary: null, me: null, members: [],
    endpointIdentity: 'restore-standalone.example.com:27017', replicaStatus: null, oplog: null,
    databases: ['admin', 'config', 'local', ...databases], logicalInventory: inventory, privilegeActions: restoreActions
  });
  const runner = new Runner(standalone([], null));
  const adapter = new MongoDbNativeAdapter({ processRunner: runner });
  const connection = config({ host: 'restore-standalone.example.com', expectedTopology: 'standalone', replicaSet: null });
  const prepared = await adapter.prepareRestoreTarget({ resolveSecret: async () => PASSWORD }, {
    mode: 'alternate', connection, metadata, conflictPolicy: 'fail'
  });
  assert.equal(prepared.identity.topology, 'standalone');
  assert.deepEqual(prepared.collisions, []);

  const plan = await adapter.planRestore({}, {
    mode: 'alternate', confirmation: 'RESTORE_MONGODB_ALTERNATE', connection, metadata,
    artifactPath: 'mongodb/replica-set-anchor.archive.gz', prepared, targetFingerprint: prepared.targetFingerprint
  });
  const restored = await adapter.executeRestore({ resolveSecret: async () => PASSWORD }, plan, {
    async open() { return Readable.from([Buffer.from('replica-set-logical-anchor')]); }
  });
  assert.equal(restored.status, 'succeeded');
  const restoreCall = runner.calls.find((call) => path.win32.basename(call.executable).toLowerCase().replace(/[.]exe$/, '') === 'mongorestore');
  assert.ok(restoreCall);
  assert.equal(restoreCall.args.includes('--oplogReplay'), true);
  assert.equal(restoreCall.args.includes('--drop'), true);
  assert.equal(restoreCall.args.includes('--preserveUUID'), true);
  assert.equal(restoreCall.args.join(' ').includes(PASSWORD), false);

  runner.value = standalone(['accounts', 'orders'], logicalInventory());
  const validation = await adapter.validateRestore({ resolveSecret: async () => PASSWORD }, {
    connection, expectedDatabases: prepared.expectedDatabases, validationInventory: prepared.validationInventory,
    targetFingerprint: prepared.targetFingerprint, requireUuid: true
  });
  assert.equal(validation.status, 'succeeded');
  assert.equal(validation.nativeIntegrityValidation, true);
  assert.equal(validation.checks.find((check) => check.id === 'expected-objects').status, 'pass');
  assert.equal(validation.checks.find((check) => check.id === 'collection-uuids').status, 'pass');
  assert.equal(validation.checks.find((check) => check.id === 'indexes').status, 'pass');
});

test('streams one whole-replica-set mongodump anchor with paired oplog evidence', async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-mongodb-adapter-test-'));
  context.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const runner = new Runner();
  const adapter = new MongoDbNativeAdapter({ processRunner: runner, temporaryRoot, clock: () => '2026-08-04T00:00:00.000Z' });
  const registry = new DatabaseAdapterRegistry([adapter]);
  const prepared = await registry.prepareBackup(ADAPTER_ID, { resolveSecret: async () => PASSWORD }, {
    connection: config({ passwordSecretRefId: 'sec_mongodb123', replicaSet: 'rs0', expectedTopology: 'replica-set' }),
    selector: { allDatabases: true },
    consistency: { requestedLevel: 'application', method: 'mongodb-oplog-dump', backupMethod: 'logical', backupMode: 'full', captureCoordinates: true }
  });
  assert.equal(prepared.consistency.proven, true);
  assert.equal(prepared.adapterPlan.dumpArguments.includes('--oplog'), true);
  let artifact;
  const result = await adapter.executeBackup({ resolveSecret: async () => PASSWORD }, prepared.adapterPlan, {
    async write(input) {
      const chunks = [];
      for await (const chunk of input.content) chunks.push(Buffer.from(chunk));
      artifact = { ...input, content: Buffer.concat(chunks) };
      return { path: input.path, sizeBytes: artifact.content.length };
    }
  });
  assert.equal(result.status, 'succeeded');
  assert.equal(artifact.content.equals(runner.dump), true);
  assert.deepEqual(artifact.metadata.oplog.start, identity().oplog.latest.ts);
  assert.deepEqual(artifact.metadata.oplog.end, identity().oplog.latest.ts);
  const dumpCall = runner.toolCalls.find((call) => call.args.includes('--oplog'));
  assert.ok(dumpCall);
  assert.equal(dumpCall.args.some((argument) => argument.includes(PASSWORD)), false);
  assert.equal(runner.configFiles.some((contents) => contents.includes(PASSWORD)), true);
  assert.deepEqual(await fs.readdir(temporaryRoot), []);
});

test('refuses filtered, standalone, sharded, weak-privilege, and old-tool oplog anchors', async () => {
  const request = (connection, selector = { allDatabases: true }) => ({
    connection, selector,
    consistency: { requestedLevel: 'application', method: 'mongodb-oplog-dump', backupMethod: 'logical', backupMode: 'full', captureCoordinates: true }
  });
  const context = { resolveSecret: async () => PASSWORD };
  const filtered = new DatabaseAdapterRegistry([new MongoDbNativeAdapter({ processRunner: new Runner() })]);
  await assert.rejects(filtered.prepareBackup(ADAPTER_ID, context, request(config({ passwordSecretRefId: 'sec_mongodb123', replicaSet: 'rs0' }), { databases: { include: [{ name: 'orders' }] } })), (error) => error.code === 'DATABASE_CONSISTENCY_UNPROVEN');
  for (const value of [
    identity({ topology: 'standalone', setName: null, replicaSetId: null, primary: null, me: null, endpointIdentity: 'mongo01.example.com:27017', members: [], oplog: null }),
    identity({ topology: 'sharded', setName: null, replicaSetId: null, clusterId: 'ObjectId(fedcba987654321001234567)', primary: null, me: null, members: [], storageEngine: null, persistent: null, oplog: null }),
    identity({ privilegeActions: ['find'] })
  ]) {
    const registry = new DatabaseAdapterRegistry([new MongoDbNativeAdapter({ processRunner: new Runner(value) })]);
    await assert.rejects(registry.prepareBackup(ADAPTER_ID, context, request(config({ passwordSecretRefId: 'sec_mongodb123' }))), (error) => ['DATABASE_CONSISTENCY_UNPROVEN', 'DATABASE_PRIVILEGE_MISSING'].includes(error.code));
  }
  const oldToolRunner = new Runner();
  oldToolRunner.run = async () => ({ exitCode: 0, stdout: 'mongodump version: 100.8.0', stderr: '' });
  const oldTool = new DatabaseAdapterRegistry([new MongoDbNativeAdapter({ processRunner: oldToolRunner })]);
  await assert.rejects(oldTool.prepareBackup(ADAPTER_ID, context, request(config({ passwordSecretRefId: 'sec_mongodb123', replicaSet: 'rs0' }))), (error) => ['DATABASE_CONSISTENCY_UNPROVEN', 'DATABASE_NATIVE_TOOL_UNAVAILABLE'].includes(error.code));
});

test('captures an authenticated BSON oplog interval and preserves exact history boundaries', async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-mongodb-oplog-test-'));
  const destination = path.join(temporaryRoot, 'capture');
  await fs.mkdir(destination);
  context.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const base = identity();
  const startEntry = base.oplog.latest;
  const endEntry = { ts: { $timestamp: { t: 300, i: 4 } }, t: 2, h: '3' };
  const observed = identity({ oplog: { earliest: base.oplog.earliest, latest: endEntry, probe: startEntry } });
  const runner = new Runner([observed, observed]);
  runner.bson = Buffer.concat([Buffer.from([5, 0, 0, 0, 0]), Buffer.from([5, 0, 0, 0, 0])]);
  const adapter = new MongoDbNativeAdapter({ processRunner: runner, temporaryRoot, clock: () => '2026-08-04T01:00:00.000Z' });
  const fingerprint = deploymentFingerprint(parseIdentity(encodedIdentity(base)));
  const startCoordinate = oplogCoordinate(startEntry, { capturedAt: '2026-08-04T00:00:00.000Z', serverIdentityFingerprint: fingerprint, replicaSetId: base.replicaSetId });
  const plan = await adapter.prepareBinaryLogCapture({ resolveSecret: async () => PASSWORD }, {
    connection: config({ replicaSet: 'rs0' }), selector: { kind: 'database-objects', allDatabases: true, databases: { include: [], exclude: [] }, schemas: { include: [], exclude: [] }, tables: { include: [], exclude: [] }, includeGlobalObjects: false }, startCoordinate
  });
  assert.equal(plan.empty, false);
  assert.deepEqual(plan.start.timestamp, startEntry.ts);
  assert.deepEqual(plan.end.timestamp, endEntry.ts);
  const [captured] = await adapter.captureBinaryLogs({ resolveSecret: async () => PASSWORD }, plan, destination);
  assert.equal(captured.documentCount, 2);
  assert.equal(captured.sizeBytes, 10);
  assert.equal(captured.startCoordinate.historyFingerprint, startCoordinate.historyFingerprint);
  const nativeCall = runner.toolCalls.find((call) => call.args.some((argument) => argument === '--collection=oplog.rs'));
  assert.ok(nativeCall);
  assert.equal(JSON.stringify(nativeCall.args).includes(PASSWORD), false);
  assert.equal(runner.configFiles.some((contents) => contents.includes(PASSWORD)), true);
  assert.equal((await fs.readFile(captured.filePath)).equals(runner.bson), true);
});

test('refuses oplog rollover, rollback divergence, and malformed BSON framing', async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-mongodb-oplog-refusal-test-'));
  context.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const base = identity();
  const fingerprint = deploymentFingerprint(parseIdentity(encodedIdentity(base)));
  const start = oplogCoordinate(base.oplog.latest, { capturedAt: '2026-08-04T00:00:00.000Z', serverIdentityFingerprint: fingerprint, replicaSetId: base.replicaSetId });
  const selector = { kind: 'database-objects', allDatabases: true, databases: { include: [], exclude: [] }, schemas: { include: [], exclude: [] }, tables: { include: [], exclude: [] }, includeGlobalObjects: false };
  const request = { connection: config({ replicaSet: 'rs0' }), selector, startCoordinate: start };
  const rolled = identity({ oplog: { earliest: { ts: { $timestamp: { t: 201, i: 0 } }, t: 2, h: 'new' }, latest: { ts: { $timestamp: { t: 300, i: 0 } }, t: 2, h: 'end' }, probe: null } });
  await assert.rejects(new MongoDbNativeAdapter({ processRunner: new Runner(rolled) }).prepareBinaryLogCapture({ resolveSecret: async () => PASSWORD }, request), (error) => error.code === 'MONGODB_OPLOG_ROLLED_OVER');
  const divergent = identity({ oplog: { earliest: base.oplog.earliest, latest: { ts: { $timestamp: { t: 300, i: 0 } }, t: 2, h: 'end' }, probe: { ...base.oplog.latest, h: 'different-history' } } });
  await assert.rejects(new MongoDbNativeAdapter({ processRunner: new Runner(divergent) }).prepareBinaryLogCapture({ resolveSecret: async () => PASSWORD }, request), (error) => error.code === 'MONGODB_OPLOG_HISTORY_DIVERGED');
  const invalidPath = path.join(temporaryRoot, 'invalid.bson');
  await fs.writeFile(invalidPath, Buffer.from([8, 0, 0, 0, 1, 2]));
  await assert.rejects(validateBsonFile(fs, invalidPath), (error) => ['MONGODB_OPLOG_BSON_INVALID', 'MONGODB_OPLOG_BSON_TRUNCATED'].includes(error.code));
});

test('returns a no-change oplog plan when the authenticated boundary has not advanced', async () => {
  const base = identity({ oplog: { ...identity().oplog, probe: identity().oplog.latest } });
  const fingerprint = deploymentFingerprint(parseIdentity(encodedIdentity(base)));
  const startCoordinate = oplogCoordinate(base.oplog.latest, { capturedAt: '2026-08-04T00:00:00.000Z', serverIdentityFingerprint: fingerprint, replicaSetId: base.replicaSetId });
  const adapter = new MongoDbNativeAdapter({ processRunner: new Runner(base) });
  const plan = await adapter.prepareBinaryLogCapture({ resolveSecret: async () => PASSWORD }, {
    connection: config({ replicaSet: 'rs0' }), selector: { kind: 'database-objects', allDatabases: true, databases: { include: [], exclude: [] }, schemas: { include: [], exclude: [] }, tables: { include: [], exclude: [] }, includeGlobalObjects: false }, startCoordinate
  });
  assert.equal(plan.empty, true);
  assert.deepEqual(plan.segments, []);
});

function serviceFixture() {
  const connections = new Map();
  const secretRefs = new Map();
  const deletedSecrets = [];
  const connectionRepository = {
    list: async () => [...connections.values()],
    get: async (_workspaceId, id) => connections.get(id) || null,
    update: async (_workspaceId, id, patch, options) => {
      const current = connections.get(id);
      assert.equal(options.expectedRevision, current.revision);
      const updated = { ...current, ...patch, revision: current.revision + 1 };
      connections.set(id, updated);
      return updated;
    }
  };
  const secretRepository = {
    get: async (_workspaceId, id) => secretRefs.get(id) || null,
    update: async (_workspaceId, id, patch, options) => {
      const current = secretRefs.get(id);
      assert.equal(options.expectedRevision, current.revision);
      const updated = { ...current, ...patch, revision: current.revision + 1 };
      secretRefs.set(id, updated);
      return updated;
    }
  };
  const controlDatabase = {
    repository: (name) => name === 'connection' ? connectionRepository : secretRepository,
    transaction: async (callback) => callback({
      create: (name, input) => {
        if (name === 'secretRef') { const record = { ...input, revision: 1 }; secretRefs.set(record.id, record); return record; }
        const record = { ...input, id: 'connection-mongodb', revision: 1 };
        connections.set(record.id, record);
        return record;
      }
    })
  };
  const secretStore = {
    create: async (input) => ({ id: 'secret-mongodb', workspaceId: input.workspaceId, name: input.name, provider: 'local-safe-storage', scope: input.scope, providerKey: 'mongodb-key', secretType: input.secretType, version: 1 }),
    resolve: async () => PASSWORD,
    markValidated: async () => ({ lastValidatedAt: '2026-08-04T00:00:00.000Z' }),
    delete: async ({ id }) => deletedSecrets.push(id)
  };
  return { connections, deletedSecrets, controlDatabase, secretStore };
}

test('persists only a password SecretRef and gates discovery on tested deployment trust', async () => {
  const fixture = serviceFixture();
  const adapter = new MongoDbNativeAdapter({ processRunner: new Runner(), clock: () => '2026-08-04T00:00:00.000Z', now: () => 0 });
  const service = new MongoDbConnectionService({ ...fixture, deviceId: 'device-a', adapter });
  const created = await service.create('workspace-a', 'actor-a', {
    name: 'Orders MongoDB', host: 'mongo01.example.com', username: 'deployerx_backup', password: PASSWORD,
    authSource: 'admin', replicaSet: 'rs0', expectedTopology: 'replica-set', tlsMode: 'verify-identity'
  });
  assert.equal(created.adapterId, ADAPTER_ID);
  assert.deepEqual(created.secretRefIds, ['secret-mongodb']);
  assert.equal(created.endpoint.password, undefined);
  assert.equal(JSON.stringify(created).includes(PASSWORD), false);
  await assert.rejects(service.discover('workspace-a', created.id), /Test the MongoDB connection successfully/);
  const tested = await service.test('workspace-a', created.id, 'actor-a');
  assert.equal(tested.result.status, 'success');
  assert.match(tested.connection.trust.fingerprint, /^sha256:/);
  const discovered = await service.discover('workspace-a', created.id);
  assert.deepEqual(discovered.items.map((item) => item.name), ['accounts', 'orders']);
  assert.equal((await service.list('workspace-a'))[0].currentDevice, true);
  assert.equal(fixture.deletedSecrets.length, 0);
  assert.equal(JSON.stringify([...fixture.connections.values()]).includes(PASSWORD), false);
});
