const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseAdapterRegistry } = require('./database-adapter');
const { DatabaseSourceService } = require('./database-source');
const { RedisNativeAdapter, clusterTopologyFingerprint, deploymentFingerprint, normalizeIdentity } = require('./redis');
const { RedisSourceReaderService, remoteFilesystemProvider } = require('./redis-source-reader');

const PASSWORD = 'redis-reader-secret';
const REPLICATION_ID = '0123456789abcdef0123456789abcdef01234567';

function responses(directory) {
  return {
    ping: 'PONG',
    server: 'redis_version:8.10.0\nredis_mode:standalone\nrun_id:redis-reader-run\n',
    persistence: 'loading:0\nrdb_bgsave_in_progress:0\nrdb_last_bgsave_status:ok\nrdb_last_save_time:100\nrdb_saves:1\naof_enabled:1\naof_rewrite_in_progress:0\naof_last_bgrewrite_status:ok\naof_last_write_status:ok\n',
    replication: `role:master\nmaster_replid:${REPLICATION_ID}\nmaster_repl_offset:300\nconnected_slaves:0\n`,
    keyspace: 'db0:keys=10,expires=1,avg_ttl=2000\n',
    role: ['master', 300, []],
    config: ['dir', directory, 'dbfilename', 'dump.rdb', 'appendonly', 'yes', 'appendfilename', 'appendonly.aof', 'appenddirname', 'appendonlydir', 'auto-aof-rewrite-percentage', '100', 'backupdirname', 'backupdir', 'backup-sealed-ttl', '0'],
    backupCommand: [['backup', -2, ['write'], 0, 0, 0]]
  };
}

class Runner {
  constructor(directory, sourcePath, bytes) {
    this.values = responses(directory);
    this.sourcePath = sourcePath;
    this.bytes = bytes;
    this.calls = [];
  }

  async run(input) {
    this.calls.push(input);
    if (input.args.length === 1 && input.args[0] === '--version') return { exitCode: 0, stdout: 'redis-cli 8.10.0', stderr: '' };
    if (input.args.at(-1) === 'BGSAVE') {
      await fs.writeFile(this.sourcePath, this.bytes);
      this.values.persistence = this.values.persistence.replace('rdb_last_save_time:100', 'rdb_last_save_time:101').replace('rdb_saves:1', 'rdb_saves:2');
      return { exitCode: 0, stdout: JSON.stringify('Background saving started'), stderr: '' };
    }
    const commands = [
      ['CONFIG', 'GET', 'dir', 'dbfilename', 'appendonly', 'appendfilename', 'appenddirname', 'auto-aof-rewrite-percentage', 'backupdirname', 'backup-sealed-ttl'],
      ['COMMAND', 'INFO', 'BACKUP'], ['INFO', 'persistence'], ['INFO', 'replication'], ['INFO', 'keyspace'], ['INFO', 'server'], ['PING'], ['ROLE']
    ];
    const command = commands.find((candidate) => candidate.every((part, index) => input.args[input.args.length - candidate.length + index] === part));
    assert.ok(command, `Unexpected redis-cli command: ${input.args.join(' ')}`);
    const key = {
      PING: 'ping', ROLE: 'role', 'INFO server': 'server', 'INFO persistence': 'persistence', 'INFO replication': 'replication', 'INFO keyspace': 'keyspace',
      'CONFIG GET dir dbfilename appendonly appendfilename appenddirname auto-aof-rewrite-percentage backupdirname backup-sealed-ttl': 'config', 'COMMAND INFO BACKUP': 'backupCommand'
    }[command.join(' ')];
    return { exitCode: 0, stdout: JSON.stringify(this.values[key]), stderr: '' };
  }
}

class SealedReaderRunner extends Runner {
  constructor(directory, files) {
    super(directory, path.join(directory, 'dump.rdb'), Buffer.from('unused'));
    this.files = files;
    this.statuses = [
      ['state', 'idle', 'start_time', '0', 'end_time', '0', 'error', ''],
      ['state', 'incrementing', 'start_time', '1000', 'end_time', '0', 'error', ''],
      ['state', 'sealed', 'start_time', '1000', 'end_time', '1100', 'error', ''],
      ['state', 'idle', 'start_time', '0', 'end_time', '0', 'error', '']
    ];
    this.backupCalls = [];
  }

  async run(input) {
    const command = input.args.slice(-2);
    if (command[0] === 'BACKUP') {
      this.calls.push(input);
      const operation = command[1];
      this.backupCalls.push(operation);
      if (operation === 'STATUS') return { exitCode: 0, stdout: JSON.stringify(this.statuses.shift()), stderr: '' };
      if (operation === 'SEAL') {
        await fs.mkdir(path.dirname(this.files[0].path), { recursive: true });
        for (const file of this.files) await fs.writeFile(file.path, file.bytes);
      }
      const value = operation === 'LIST' ? this.files.map((file) => file.path) : 'OK';
      return { exitCode: 0, stdout: JSON.stringify(value), stderr: '' };
    }
    return super.run(input);
  }
}

class MultipartReaderRunner extends Runner {
  constructor(directory) {
    super(directory, path.join(directory, 'dump.rdb'), Buffer.from('unused'));
    this.values.server = this.values.server.replace('redis_version:8.10.0', 'redis_version:7.4.2');
    this.values.backupCommand = [null];
    this.policyCalls = [];
    this.controlCalls = [];
  }

  async run(input) {
    if (input.args.length === 1 && input.args[0] === '--version') return { exitCode: 0, stdout: 'redis-cli 7.4.2', stderr: '' };
    const clientCommand = input.args.slice(-4);
    if (clientCommand[0] === 'CLIENT' && clientCommand[1] === 'PAUSE') {
      this.calls.push(input);
      this.controlCalls.push(['PAUSE', Number(clientCommand[2]), clientCommand[3]]);
      return { exitCode: 0, stdout: JSON.stringify('OK'), stderr: '' };
    }
    if (input.args.at(-2) === 'CLIENT' && input.args.at(-1) === 'UNPAUSE') {
      this.calls.push(input);
      this.controlCalls.push(['UNPAUSE']);
      return { exitCode: 0, stdout: JSON.stringify('OK'), stderr: '' };
    }
    const command = input.args.slice(-4);
    if (command[0] === 'CONFIG' && command[1] === 'SET' && command[2] === 'auto-aof-rewrite-percentage') {
      this.calls.push(input);
      const value = Number(command[3]);
      this.policyCalls.push(value);
      const index = this.values.config.indexOf('auto-aof-rewrite-percentage');
      this.values.config[index + 1] = String(value);
      return { exitCode: 0, stdout: JSON.stringify('OK'), stderr: '' };
    }
    return super.run(input);
  }
}

function fixture(adapter, fingerprint) {
  const connections = new Map();
  const sources = new Map();
  connections.set('connection-local', {
    id: 'connection-local', revision: 1, adapterId: 'deployerx.connection.local', kind: 'local', endpoint: {},
    workerAffinity: ['device:device-a'], lastTest: { status: 'success' }, trust: null, secretRefIds: []
  });
  connections.set('connection-redis', {
    id: 'connection-redis', revision: 1, adapterId: 'deployerx.database.redis.native', kind: 'database',
    endpoint: { host: '127.0.0.1', port: 6379, username: 'backup-user', tlsMode: 'verify-identity', expectedTopology: 'standalone', timeoutMs: 30000, redisCliExecutable: 'redis-cli', filesystemConnectionId: 'connection-local' },
    workerAffinity: ['device:device-a'], secretRefIds: ['sec_redis123'], lastTest: { status: 'success', endpointIdentity: { mode: 'standalone' } }, trust: { mode: 'verify-identity', fingerprint }
  });
  const connectionRepository = { get: async (_workspaceId, id) => connections.get(id) || null };
  const sourceRepository = {
    get: async (_workspaceId, id) => sources.get(id) || null,
    create: async (input) => {
      const record = { ...input, id: 'source-redis', revision: 1 };
      sources.set(record.id, record);
      return record;
    }
  };
  const controlDatabase = { repository: (name) => name === 'connection' ? connectionRepository : sourceRepository };
  const secretStore = { resolve: async () => PASSWORD };
  const registry = new DatabaseAdapterRegistry([adapter]);
  return { connections, sources, controlDatabase, secretStore, registry };
}

test('saves and executes a full local Redis RDB source with digest and coordinate evidence', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-redis-reader-test-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const redisDirectory = path.join(root, 'redis');
  const stagingDirectory = path.join(root, 'staging');
  await fs.mkdir(redisDirectory);
  const sourcePath = path.join(redisDirectory, 'dump.rdb');
  await fs.writeFile(sourcePath, Buffer.from('old'));
  const protectedBytes = Buffer.from('REDIS0011-complete-reader-rdb');
  const rawIdentity = normalizeIdentity({ ...responses(redisDirectory), clusterInfo: null, clusterNodes: null });
  const runner = new Runner(redisDirectory, sourcePath, protectedBytes);
  const adapter = new RedisNativeAdapter({ processRunner: runner, delay: async () => {} });
  const data = fixture(adapter, deploymentFingerprint(rawIdentity));
  const sourceService = new DatabaseSourceService({ controlDatabase: data.controlDatabase, adapterRegistry: data.registry, deviceId: 'device-a', clock: () => '2026-08-04T00:00:00.000Z' });
  const source = await sourceService.save('workspace-a', 'actor-a', {
    name: 'Local Redis RDB', connectionId: 'connection-redis',
    selector: { allDatabases: true },
    consistency: { requestedLevel: 'application', method: 'redis-rdb', backupMethod: 'physical', backupMode: 'full', captureCoordinates: true }
  });
  assert.equal(source.physicalExecution, null);
  const reader = new RedisSourceReaderService({ controlDatabase: data.controlDatabase, secretStore: data.secretStore, deviceId: 'device-a', adapterRegistry: data.registry, adapter, temporaryRoot: stagingDirectory });
  const opened = await reader.files('workspace-a', source.id, { executionId: 'run-redis-001', backupMode: 'full' });
  const entries = [];
  for await (const entry of opened.create()) {
    const chunks = [];
    for await (const chunk of entry.content) chunks.push(Buffer.from(chunk));
    entries.push({ ...entry, content: Buffer.concat(chunks) });
  }
  assert.equal(entries.length, 1);
  assert.equal(entries[0].path, 'redis/dump.rdb');
  assert.equal(entries[0].content.equals(protectedBytes), true);
  assert.match(opened.manifest.database.artifact.contentDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(opened.manifest.database.coordinates.before.rdbSaves, 1);
  assert.equal(opened.manifest.database.coordinates.after.rdbSaves, 2);
  assert.equal(opened.manifest.database.restore.originalReplacementSupported, false);
  assert.equal(runner.calls.some((call) => call.args.at(-1) === 'BGSAVE'), true);
  assert.equal(runner.calls.some((call) => JSON.stringify(call.args).includes(PASSWORD)), false);
  assert.equal(await reader.release('workspace-a', 'run-redis-001'), true);
  assert.deepEqual(await fs.readdir(stagingDirectory), []);
});

test('saves and emits a complete Redis sealed AOF recovery point', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-redis-sealed-reader-test-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const redisDirectory = path.join(root, 'redis');
  const backupDirectory = path.join(redisDirectory, 'backupdir');
  const stagingDirectory = path.join(root, 'staging');
  await fs.mkdir(redisDirectory);
  const baseFilename = 'backup-1000.base.rdb';
  const incrementFilename = 'backup-1000.incr.aof';
  const manifestFilename = 'backup-1000.manifest';
  const files = [
    { component: 'base', filename: baseFilename, path: path.join(backupDirectory, baseFilename), bytes: Buffer.from('REDIS0011-reader-sealed-base') },
    { component: 'increment', filename: incrementFilename, path: path.join(backupDirectory, incrementFilename), bytes: Buffer.from('reader-sealed-increment') },
    { component: 'manifest', filename: manifestFilename, path: path.join(backupDirectory, manifestFilename), bytes: Buffer.from(`file ${baseFilename} seq 1 type b\nfile ${incrementFilename} seq 1 type i\n`) }
  ];
  const rawIdentity = normalizeIdentity({ ...responses(redisDirectory), clusterInfo: null, clusterNodes: null });
  const runner = new SealedReaderRunner(redisDirectory, files);
  const adapter = new RedisNativeAdapter({ processRunner: runner, delay: async () => {} });
  const data = fixture(adapter, deploymentFingerprint(rawIdentity));
  const sourceService = new DatabaseSourceService({ controlDatabase: data.controlDatabase, adapterRegistry: data.registry, deviceId: 'device-a', clock: () => '2026-08-04T00:00:00.000Z' });
  const source = await sourceService.save('workspace-a', 'actor-a', {
    name: 'Local Redis sealed AOF', connectionId: 'connection-redis',
    selector: { allDatabases: true },
    consistency: { requestedLevel: 'application', method: 'redis-aof', backupMethod: 'physical', backupMode: 'full', captureCoordinates: true }
  });
  const reader = new RedisSourceReaderService({ controlDatabase: data.controlDatabase, secretStore: data.secretStore, deviceId: 'device-a', adapterRegistry: data.registry, adapter, temporaryRoot: stagingDirectory });
  const opened = await reader.files('workspace-a', source.id, { executionId: 'run-redis-sealed-001', backupMode: 'full' });
  const entries = [];
  for await (const entry of opened.create()) {
    const chunks = [];
    for await (const chunk of entry.content) chunks.push(Buffer.from(chunk));
    entries.push({ ...entry, content: Buffer.concat(chunks) });
  }

  assert.deepEqual(entries.map((entry) => entry.path), files.map((file) => `redis/sealed/${file.filename}`));
  assert.deepEqual(entries.map((entry) => entry.metadata.component), ['base', 'increment', 'manifest']);
  for (let index = 0; index < files.length; index += 1) assert.equal(entries[index].content.equals(files[index].bytes), true);
  assert.equal(opened.manifest.database.kind, 'redis-sealed-backup');
  assert.deepEqual(opened.manifest.artifactPaths, files.map((file) => `redis/sealed/${file.filename}`));
  assert.equal(opened.manifest.database.artifacts.length, 3);
  assert.equal(opened.manifest.database.artifacts.every((artifact) => /^sha256:[a-f0-9]{64}$/.test(artifact.contentDigest)), true);
  assert.deepEqual(opened.manifest.database.manifestEntries.map((entry) => [entry.filename, entry.type]), [[baseFilename, 'b'], [incrementFilename, 'i']]);
  assert.deepEqual(opened.manifest.database.session, { startTime: 1000, endTime: 1100 });
  assert.deepEqual(runner.backupCalls, ['STATUS', 'START', 'STATUS', 'SEAL', 'STATUS', 'LIST', 'CLEANUP', 'STATUS']);
  const [preparationName] = await fs.readdir(stagingDirectory);
  const owner = JSON.parse(await fs.readFile(path.join(stagingDirectory, preparationName, '.owner.json'), 'utf8'));
  assert.equal(owner.redisSession, null);
  assert.equal(await reader.release('workspace-a', 'run-redis-sealed-001'), true);
  assert.deepEqual(await fs.readdir(stagingDirectory), []);
});

test('saves and emits a Redis 7 multipart-AOF recovery point with restored policy', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-redis-multipart-reader-test-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const redisDirectory = path.join(root, 'redis');
  const appendDirectory = path.join(redisDirectory, 'appendonlydir');
  const stagingDirectory = path.join(root, 'staging');
  await fs.mkdir(appendDirectory, { recursive: true });
  const baseFilename = 'appendonly.aof.1.base.rdb';
  const incrementFilenames = ['appendonly.aof.1.incr.aof', 'appendonly.aof.2.incr.aof'];
  const manifestFilename = 'appendonly.aof.manifest';
  const files = [
    { component: 'base', filename: baseFilename, bytes: Buffer.from('REDIS0011-reader-multipart-base') },
    { component: 'increment', filename: incrementFilenames[0], bytes: Buffer.from('reader-first-increment') },
    { component: 'increment', filename: incrementFilenames[1], bytes: Buffer.from('reader-second-increment') },
    { component: 'manifest', filename: manifestFilename, bytes: Buffer.from(`file ${baseFilename} seq 1 type b\nfile ${incrementFilenames[0]} seq 1 type i\nfile ${incrementFilenames[1]} seq 2 type i\n`) }
  ];
  for (const file of files) await fs.writeFile(path.join(appendDirectory, file.filename), file.bytes);
  const identityResponses = responses(redisDirectory);
  identityResponses.server = identityResponses.server.replace('redis_version:8.10.0', 'redis_version:7.4.2');
  identityResponses.backupCommand = [null];
  const rawIdentity = normalizeIdentity({ ...identityResponses, clusterInfo: null, clusterNodes: null });
  const runner = new MultipartReaderRunner(redisDirectory);
  const adapter = new RedisNativeAdapter({ processRunner: runner });
  const data = fixture(adapter, deploymentFingerprint(rawIdentity));
  const sourceService = new DatabaseSourceService({ controlDatabase: data.controlDatabase, adapterRegistry: data.registry, deviceId: 'device-a', clock: () => '2026-08-04T00:00:00.000Z' });
  const source = await sourceService.save('workspace-a', 'actor-a', {
    name: 'Local Redis multipart AOF', connectionId: 'connection-redis',
    selector: { allDatabases: true },
    consistency: { requestedLevel: 'application', method: 'redis-aof', backupMethod: 'physical', backupMode: 'full', captureCoordinates: true }
  });
  const reader = new RedisSourceReaderService({ controlDatabase: data.controlDatabase, secretStore: data.secretStore, deviceId: 'device-a', adapterRegistry: data.registry, adapter, temporaryRoot: stagingDirectory });
  const opened = await reader.files('workspace-a', source.id, { executionId: 'run-redis-multipart-001', backupMode: 'full' });
  const entries = [];
  for await (const entry of opened.create()) {
    const chunks = [];
    for await (const chunk of entry.content) chunks.push(Buffer.from(chunk));
    entries.push({ ...entry, content: Buffer.concat(chunks) });
  }

  assert.deepEqual(entries.map((entry) => entry.path), files.map((file) => `redis/aof/${file.filename}`));
  assert.deepEqual(entries.map((entry) => entry.metadata.component), files.map((file) => file.component));
  for (let index = 0; index < files.length; index += 1) assert.equal(entries[index].content.equals(files[index].bytes), true);
  assert.equal(opened.manifest.database.kind, 'redis-multipart-aof');
  assert.equal(opened.manifest.database.artifacts.length, 4);
  assert.equal(opened.manifest.database.artifacts.every((artifact) => /^sha256:[a-f0-9]{64}$/.test(artifact.contentDigest)), true);
  assert.deepEqual(opened.manifest.database.manifestEntries.map((entry) => [entry.type, entry.sequence]), [['b', 1], ['i', 1], ['i', 2]]);
  assert.deepEqual(opened.manifest.database.rewritePolicy, { originalAutomaticRewritePercentage: 100, restored: true });
  assert.deepEqual(runner.policyCalls, [0, 100]);
  assert.deepEqual(runner.controlCalls, [['PAUSE', 300000, 'WRITE'], ['UNPAUSE']]);
  const [preparationName] = await fs.readdir(stagingDirectory);
  const owner = JSON.parse(await fs.readFile(path.join(stagingDirectory, preparationName, '.owner.json'), 'utf8'));
  assert.equal(owner.redisSession, null);
  assert.equal(await reader.release('workspace-a', 'run-redis-multipart-001'), true);
});

test('refuses a local filesystem pair for a non-loopback Redis endpoint', async () => {
  const identity = normalizeIdentity({ ...responses('C:\\redis'), clusterInfo: null, clusterNodes: null });
  const adapter = new RedisNativeAdapter({ processRunner: new Runner('C:\\redis', 'C:\\redis\\dump.rdb', Buffer.from('rdb')) });
  const data = fixture(adapter, deploymentFingerprint(identity));
  data.connections.get('connection-redis').endpoint.host = 'redis01.example.com';
  const service = new DatabaseSourceService({ controlDatabase: data.controlDatabase, adapterRegistry: data.registry, deviceId: 'device-a' });
  await assert.rejects(service.save('workspace-a', 'actor-a', {
    name: 'Unsafe pair', connectionId: 'connection-redis', selector: { allDatabases: true },
    consistency: { requestedLevel: 'application', method: 'redis-rdb', backupMethod: 'physical', backupMode: 'full', captureCoordinates: true }
  }), /loopback Redis endpoint/);
});

test('saves and emits one crash-consistent recovery set for every Redis Cluster master', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-redis-cluster-reader-test-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const nodesFor = (self) => [
    `node-a 127.0.0.1:7000@17000 ${self === 'node-a' ? 'myself,' : ''}master - 0 0 1 connected 0-8191`,
    `node-b 127.0.0.1:7001@17001 ${self === 'node-b' ? 'myself,' : ''}master - 0 0 2 connected 8192-16383`
  ].join('\n');
  const identityFor = (nodeId, port) => normalizeIdentity({
    ...responses(path.join(root, nodeId)),
    server: `redis_version:8.10.0\nredis_mode:cluster\nrun_id:run-${nodeId}\n`,
    clusterInfo: 'cluster_state:ok\ncluster_slots_assigned:16384\n', clusterNodes: nodesFor(nodeId),
    replication: `role:master\nmaster_replid:${nodeId === 'node-a' ? REPLICATION_ID : 'abcdef0123456789abcdef0123456789abcdef01'}\nmaster_repl_offset:${port}\nconnected_slaves:0\n`, role: ['master', port, []]
  });
  const identities = new Map([[7000, identityFor('node-a', 7000)], [7001, identityFor('node-b', 7001)]]);
  const endpointIdentity = (identity) => ({
    mode: 'cluster', role: 'master', clusterNodeId: identity.cluster.selfNodeId, clusterMasterCount: identity.cluster.masters.length, coveredSlots: identity.cluster.coveredSlots,
    clusterTopologyFingerprint: clusterTopologyFingerprint(identity.cluster), clusterMasters: identity.cluster.masters.map((master) => ({ nodeId: master.nodeId, address: master.address, slots: master.slots.slice() })), backupStrategy: identity.backupStrategy
  });
  class ClusterAdapter extends RedisNativeAdapter {
    constructor() { super({ processRunner: { async run() { throw new Error('Unexpected native command'); } } }); this.seedReads = 0; this.driftAtSeedRead = null; }
    async readIdentity(_context, config) {
      const identity = identities.get(Number(config.port));
      if (Number(config.port) !== 7000) return identity;
      this.seedReads += 1;
      if (this.driftAtSeedRead !== this.seedReads) return identity;
      const changed = structuredClone(identity);
      changed.cluster.masters[0].slots = ['0-8190'];
      return changed;
    }
    async preflight(_context, request) {
      const identity = identities.get(Number(request.connection.port));
      return {
        checkedAt: '2026-08-04T00:00:00.000Z', serverVersion: identity.version.text, serverVersionSupported: true, serverIdentityFingerprint: deploymentFingerprint(identity),
        consistency: [{ method: 'redis-cluster-rdb', verified: true, produces: 'crash' }], tools: [{ name: 'redis-cli', version: '8.10.0', compatible: true }], privileges: [], coordinateCaptureVerified: true, warnings: [],
        metadata: { mode: 'cluster', role: 'master', backupStrategy: 'sealed-backup', clusterNodeId: identity.cluster.selfNodeId, clusterMasterCount: 2, coveredSlots: 16384, clusterTopologyFingerprint: clusterTopologyFingerprint(identity.cluster), clusterMasters: identity.cluster.masters, databases: identity.databases }
      };
    }
    async createRdbMedia(_context, plan, destination) {
      const bytes = Buffer.from(`REDIS0011-cluster-${plan.expectedClusterNodeId}`);
      await fs.writeFile(destination, bytes, { flag: 'wx' });
      const identity = identities.get(Number(plan.connection.port));
      return { filePath: destination, sizeBytes: bytes.length, digest: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`, before: { replicationId: identity.replicationId, replicationOffset: identity.replicationOffset }, after: { replicationId: identity.replicationId, replicationOffset: identity.replicationOffset }, identity };
    }
  }
  const adapter = new ClusterAdapter();
  const data = fixture(adapter, deploymentFingerprint(identities.get(7000)));
  const seed = data.connections.get('connection-redis');
  Object.assign(seed.endpoint, { port: 7000, expectedTopology: 'cluster' });
  seed.lastTest.endpointIdentity = endpointIdentity(identities.get(7000));
  data.connections.set('connection-master-b', {
    ...structuredClone(seed), id: 'connection-master-b', endpoint: { ...seed.endpoint, port: 7001 }, trust: { mode: 'verify-identity', fingerprint: deploymentFingerprint(identities.get(7001)) }, lastTest: { status: 'success', endpointIdentity: endpointIdentity(identities.get(7001)) }
  });
  const service = new DatabaseSourceService({ controlDatabase: data.controlDatabase, adapterRegistry: data.registry, deviceId: 'device-a' });
  await assert.rejects(service.save('workspace-a', 'actor-a', {
    name: 'Incomplete Cluster Redis', connectionId: 'connection-redis', selector: { allDatabases: true }, consistency: { requestedLevel: 'crash', method: 'redis-cluster-rdb', backupMethod: 'physical', backupMode: 'full', captureCoordinates: true },
    physicalExecution: { topology: 'cluster', masters: [{ nodeId: 'node-a', connectionId: 'connection-redis' }] }
  }), /complete authenticated seed topology/);
  const source = await service.save('workspace-a', 'actor-a', {
    name: 'Cluster Redis', connectionId: 'connection-redis', selector: { allDatabases: true }, consistency: { requestedLevel: 'crash', method: 'redis-cluster-rdb', backupMethod: 'physical', backupMode: 'full', captureCoordinates: true },
    physicalExecution: { topology: 'cluster', masters: [{ nodeId: 'node-a', connectionId: 'connection-redis' }, { nodeId: 'node-b', connectionId: 'connection-master-b' }] }
  });
  const reader = new RedisSourceReaderService({ controlDatabase: data.controlDatabase, secretStore: data.secretStore, deviceId: 'device-a', adapterRegistry: data.registry, adapter, temporaryRoot: path.join(root, 'staging') });
  const opened = await reader.files('workspace-a', source.id, { executionId: 'run-cluster-001', backupMode: 'full' });
  const entries = [];
  for await (const entry of opened.create()) { const chunks = []; for await (const chunk of entry.content) chunks.push(Buffer.from(chunk)); entries.push({ ...entry, bytes: Buffer.concat(chunks) }); }

  assert.equal(opened.manifest.consistency.achievedLevel, 'crash');
  assert.equal(opened.manifest.database.kind, 'redis-cluster-backup');
  assert.equal(opened.manifest.database.cluster.coveredSlots, 16384);
  assert.deepEqual(opened.manifest.database.cluster.masters.map((master) => master.nodeId), ['node-a', 'node-b']);
  assert.deepEqual(entries.map((entry) => entry.path), ['redis/cluster/node-a/dump.rdb', 'redis/cluster/node-b/dump.rdb']);
  assert.equal(entries.every((entry) => entry.metadata.artifactKind === 'physical-backup' && entry.bytes.subarray(0, 9).toString() === 'REDIS0011'), true);
  assert.equal(await reader.release('workspace-a', 'run-cluster-001'), true);
  adapter.seedReads = 0;
  adapter.driftAtSeedRead = 3;
  await assert.rejects(reader.files('workspace-a', source.id, { executionId: 'run-cluster-drift', backupMode: 'full' }), (error) => error.code === 'REDIS_CLUSTER_TOPOLOGY_CHANGED');
});

test('streams a stable Redis RDB through the paired SFTP provider', async () => {
  const bytes = Buffer.from('REDIS0011-sftp-rdb');
  let closedHandle = false;
  let closedSession = false;
  const session = {
    lstat: async () => ({ mode: 0o100640, size: bytes.length, mtime: 100 }),
    open: async () => 'handle-rdb',
    read: async (_handle, buffer, offset, length, position) => {
      const chunk = bytes.subarray(position, position + length);
      chunk.copy(buffer, offset);
      return chunk.length;
    },
    closeHandle: async () => { closedHandle = true; },
    close: () => { closedSession = true; }
  };
  const provider = remoteFilesystemProvider(session);
  const filePath = provider.resolvePath('/var/lib/redis', 'dump.rdb');
  assert.equal(filePath, '/var/lib/redis/dump.rdb');
  assert.equal(provider.resolveAofPath('/var/lib/redis', 'appendonlydir', 'appendonly.aof.manifest'), '/var/lib/redis/appendonlydir/appendonly.aof.manifest');
  const stat = await provider.lstat(filePath);
  assert.equal(stat.isFile, true);
  const chunks = [];
  for await (const chunk of provider.read(filePath)) chunks.push(Buffer.from(chunk));
  assert.equal(Buffer.concat(chunks).equals(bytes), true);
  assert.equal(closedHandle, true);
  provider.close();
  assert.equal(closedSession, true);
});
