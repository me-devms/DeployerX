const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseAdapterError, DatabaseAdapterRegistry } = require('./database-adapter');
const {
  ADAPTER_ID,
  RedisConnectionService,
  RedisNativeAdapter,
  clusterTopologyFingerprint,
  deploymentFingerprint,
  normalizeConfig,
  normalizeIdentity,
  parseClusterNodes,
  redisCliArguments,
  validateIdentity
} = require('./redis');

const PASSWORD = 'redis-secret-value';
const REPLICATION_ID = '0123456789abcdef0123456789abcdef01234567';

function baseResponses(overrides = {}) {
  return {
    ping: 'PONG',
    server: '# Server\nredis_version:8.10.0\nredis_mode:standalone\nrun_id:run-redis-001\n',
    persistence: '# Persistence\nloading:0\nrdb_bgsave_in_progress:0\nrdb_last_bgsave_status:ok\nrdb_last_save_time:100\nrdb_saves:1\naof_enabled:1\naof_rewrite_in_progress:0\naof_last_bgrewrite_status:ok\naof_last_write_status:ok\n',
    replication: `# Replication\nrole:master\nmaster_replid:${REPLICATION_ID}\nmaster_repl_offset:120\nconnected_slaves:0\n`,
    keyspace: '# Keyspace\ndb0:keys=12,expires=2,avg_ttl=4000\ndb2:keys=4,expires=0,avg_ttl=0\n',
    role: ['master', 120, []],
    config: ['dir', '/var/lib/redis', 'dbfilename', 'dump.rdb', 'appendonly', 'yes', 'appendfilename', 'appendonly.aof', 'appenddirname', 'appendonlydir', 'auto-aof-rewrite-percentage', '100', 'backupdirname', 'backupdir', 'backup-sealed-ttl', '0'],
    backupCommand: [['backup', -2, ['write'], 0, 0, 0]],
    clusterInfo: null,
    clusterNodes: null,
    ...overrides
  };
}

function connectionConfig(overrides = {}) {
  return {
    host: 'redis01.example.com',
    port: 6379,
    username: 'backup-user',
    passwordSecretRefId: 'sec_redis123',
    tlsMode: 'verify-identity',
    expectedTopology: 'standalone',
    ...overrides
  };
}

class Runner {
  constructor(responses = baseResponses()) {
    this.responses = responses;
    this.calls = [];
  }

  async run(input) {
    this.calls.push(input);
    if (input.args.length === 1 && input.args[0] === '--version') return { exitCode: 0, stdout: 'redis-cli 8.10.0', stderr: '' };
    const commands = [
      ['CONFIG', 'GET', 'dir', 'dbfilename', 'appendonly', 'appendfilename', 'appenddirname', 'auto-aof-rewrite-percentage', 'backupdirname', 'backup-sealed-ttl'],
      ['COMMAND', 'INFO', 'BACKUP'],
      ['INFO', 'persistence'],
      ['INFO', 'replication'],
      ['INFO', 'keyspace'],
      ['INFO', 'server'],
      ['CLUSTER', 'INFO'],
      ['CLUSTER', 'NODES'],
      ['PING'],
      ['ROLE']
    ];
    const command = commands.find((candidate) => candidate.every((part, index) => input.args[input.args.length - candidate.length + index] === part));
    assert.ok(command, `Unexpected redis-cli arguments: ${input.args.join(' ')}`);
    const key = {
      'PING': 'ping',
      'INFO server': 'server',
      'INFO persistence': 'persistence',
      'INFO replication': 'replication',
      'INFO keyspace': 'keyspace',
      'ROLE': 'role',
      'CONFIG GET dir dbfilename appendonly appendfilename appenddirname auto-aof-rewrite-percentage backupdirname backup-sealed-ttl': 'config',
      'COMMAND INFO BACKUP': 'backupCommand',
      'CLUSTER INFO': 'clusterInfo',
      'CLUSTER NODES': 'clusterNodes'
    }[command.join(' ')];
    return { exitCode: 0, stdout: JSON.stringify(this.responses[key]), stderr: '' };
  }
}

test('normalizes a verified TLS Redis connection and rejects unsafe variants', () => {
  const normalized = normalizeConfig(connectionConfig({ clientCertificateFile: 'C:\\certs\\redis.crt', clientKeyFile: 'C:\\certs\\redis.key' }));
  assert.equal(normalized.port, 6379);
  assert.equal(normalized.username, 'backup-user');
  assert.equal(normalized.redisCliExecutable, 'redis-cli');
  assert.throws(() => normalizeConfig(connectionConfig({ tlsMode: 'disabled' })), /TLS certificate identity/);
  assert.throws(() => normalizeConfig(connectionConfig({ clientCertificateFile: 'C:\\certs\\redis.crt' })), /both a client certificate/);
  assert.throws(() => normalizeConfig(connectionConfig({ redisCliExecutable: 'bash' })), /Only the redis-cli/);
});

test('passes the password only through REDISCLI_AUTH', async () => {
  const runner = new Runner();
  const adapter = new RedisNativeAdapter({ processRunner: runner });
  const result = await adapter.testConnection({ resolveSecret: async () => PASSWORD }, connectionConfig());
  assert.equal(result.status, 'success');
  assert.ok(runner.calls.length >= 8);
  for (const call of runner.calls) {
    assert.equal(call.env.REDISCLI_AUTH, PASSWORD);
    assert.equal(call.args.some((argument) => argument.includes(PASSWORD)), false);
    assert.equal(JSON.stringify(call.args).includes('sec_redis123'), false);
  }
  const args = redisCliArguments(normalizeConfig(connectionConfig()), ['PING']);
  assert.equal(args.includes('--tls'), true);
  assert.equal(args.includes('--sni'), true);
});

test('discovers Redis identity, persistence strategy, and logical databases', async () => {
  const runner = new Runner();
  const adapter = new RedisNativeAdapter({ processRunner: runner, clock: () => '2026-08-04T00:00:00.000Z', now: () => 10 });
  const result = await adapter.testConnection({ resolveSecret: async () => PASSWORD }, connectionConfig());
  assert.equal(result.status, 'success');
  assert.equal(result.endpointIdentity.backupStrategy, 'sealed-backup');
  assert.equal(result.endpointIdentity.role, 'master');
  assert.equal(result.checks.find((check) => check.id === 'filesystem-executor').status, 'warning');
  const pages = [];
  for await (const page of adapter.discover({ resolveSecret: async () => PASSWORD }, { connection: connectionConfig() })) pages.push(page);
  assert.deepEqual(pages[0].items.map((item) => [item.name, item.keyCount]), [['db0', 12], ['db2', 4]]);
});

test('keeps deployment trust stable while the replication offset advances', () => {
  const first = normalizeIdentity(baseResponses());
  const second = normalizeIdentity(baseResponses({
    replication: baseResponses().replication.replace('master_repl_offset:120', 'master_repl_offset:900'),
    role: ['master', 900, []]
  }));
  assert.equal(deploymentFingerprint(first), deploymentFingerprint(second));
  assert.notEqual(first.replicationOffset, second.replicationOffset);
});

test('registers executable standalone and crash-consistent Redis Cluster strategies', () => {
  const registry = new DatabaseAdapterRegistry([new RedisNativeAdapter({ processRunner: new Runner() })]);
  const manifest = registry.manifest(ADAPTER_ID);
  assert.equal(manifest.executionReady, true);
  assert.deepEqual(manifest.capabilities.backupModes, ['full']);
  assert.deepEqual(manifest.capabilities.consistencyStrategies.map((item) => item.id), ['redis-rdb', 'redis-aof', 'redis-cluster-rdb', 'redis-cluster-aof']);
});

test('refuses replica INFO and ROLE offset divergence', async () => {
  const responses = baseResponses({
    replication: `role:slave\nmaster_replid:${REPLICATION_ID}\nslave_repl_offset:119\nconnected_slaves:0\n`,
    role: ['slave', 'redis-primary.example.com', 6379, 'connected', 120]
  });
  const adapter = new RedisNativeAdapter({ processRunner: new Runner(responses) });
  const result = await adapter.testConnection({ resolveSecret: async () => PASSWORD }, connectionConfig({ expectedTopology: 'replication' }));
  assert.equal(result.status, 'failure');
  assert.equal(result.error.code, 'REDIS_REPLICATION_IDENTITY_DIVERGED');
});

test('requires a paired filesystem executor and an idle healthy persistence boundary for backup', () => {
  const identity = normalizeIdentity(baseResponses());
  assert.throws(() => validateIdentity(normalizeConfig(connectionConfig()), identity, { forBackup: true }), (error) => error.code === 'REDIS_FILESYSTEM_EXECUTOR_REQUIRED');
  const busy = normalizeIdentity(baseResponses({ persistence: baseResponses().persistence.replace('rdb_bgsave_in_progress:0', 'rdb_bgsave_in_progress:1') }));
  assert.throws(() => validateIdentity(normalizeConfig(connectionConfig({ filesystemConnectionId: 'connection-local' })), busy, { forBackup: true }), (error) => error.code === 'REDIS_PERSISTENCE_BUSY');
});

test('proves complete Redis Cluster coverage and plans an exact master child', async () => {
  const nodes = [
    'node-a 10.0.0.1:6379@16379 myself,master - 0 0 1 connected 0-8191',
    'node-b 10.0.0.2:6379@16379 master - 0 0 2 connected 8192-16383',
    'node-r 10.0.0.3:6379@16379 slave node-a 0 0 3 connected'
  ].join('\n');
  const responses = baseResponses({
    server: '# Server\nredis_version:8.10.0\nredis_mode:cluster\nrun_id:run-cluster-a\n',
    clusterInfo: 'cluster_state:ok\ncluster_slots_assigned:16384\n',
    clusterNodes: nodes
  });
  const adapter = new RedisNativeAdapter({ processRunner: new Runner(responses) });
  const result = await adapter.testConnection({ resolveSecret: async () => PASSWORD }, connectionConfig({ expectedTopology: 'cluster' }));
  assert.equal(result.status, 'success');
  assert.equal(result.endpointIdentity.clusterMasterCount, 2);
  assert.equal(result.endpointIdentity.coveredSlots, 16384);
  assert.equal(result.endpointIdentity.clusterMasters.length, 2);
  assert.match(result.endpointIdentity.clusterTopologyFingerprint, /^sha256:[0-9a-f]{64}$/);
  const identity = normalizeIdentity(responses);
  assert.equal(result.endpointIdentity.clusterTopologyFingerprint, clusterTopologyFingerprint(identity.cluster));
  const registry = new DatabaseAdapterRegistry([adapter]);
  const prepared = await registry.prepareBackup(ADAPTER_ID, { resolveSecret: async () => PASSWORD }, {
    connection: connectionConfig({ expectedTopology: 'cluster', filesystemConnectionId: 'connection-ssh' }), selector: { allDatabases: true },
    consistency: { requestedLevel: 'crash', method: 'redis-cluster-rdb', backupMethod: 'physical', backupMode: 'full', captureCoordinates: true }, execution: { topology: 'cluster' }
  });
  assert.equal(prepared.consistency.achievedLevel, 'crash');
  assert.equal(prepared.adapterPlan.operation, 'redis-cluster-rdb-backup');
  const member = await adapter.planClusterMemberBackup({ resolveSecret: async () => PASSWORD }, { connection: connectionConfig({ expectedTopology: 'cluster', filesystemConnectionId: 'connection-ssh' }), nodeId: 'node-a', topologyFingerprint: clusterTopologyFingerprint(identity.cluster), method: 'redis-cluster-rdb', artifactPrefix: 'redis/cluster' });
  assert.equal(member.operation, 'redis-rdb-backup');
  assert.equal(member.artifact.path, 'redis/cluster/node-a/dump.rdb');
  assert.throws(() => parseClusterNodes(nodes.replace('8192-16383', '8193-16383')), (error) => error.code === 'REDIS_CLUSTER_INCOMPLETE');
  assert.throws(() => parseClusterNodes(nodes.replace('8192-16383', '8000-16383')), (error) => error.code === 'REDIS_CLUSTER_SLOT_DUPLICATE');
});

test('creates a run-owned full RDB only after BGSAVE completion and stable file capture', async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-redis-rdb-test-'));
  context.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const bytes = Buffer.from('REDIS0011-tested-rdb-bytes');
  const responses = baseResponses();
  class RdbRunner extends Runner {
    constructor() { super(responses); this.persistenceReads = 0; }
    async run(input) {
      if (input.args.length === 1 && input.args[0] === '--version') return { exitCode: 0, stdout: 'redis-cli 8.10.0', stderr: '' };
      if (input.args.at(-1) === 'BGSAVE') {
        this.calls.push(input);
        return { exitCode: 0, stdout: JSON.stringify('Background saving started'), stderr: '' };
      }
      const isPersistence = input.args.slice(-2).join(' ') === 'INFO persistence';
      if (isPersistence) {
        this.persistenceReads += 1;
        if (this.persistenceReads >= 3) this.responses.persistence = baseResponses().persistence.replace('rdb_last_save_time:100', 'rdb_last_save_time:101').replace('rdb_saves:1', 'rdb_saves:2');
      }
      return super.run(input);
    }
  }
  const runner = new RdbRunner();
  const adapter = new RedisNativeAdapter({ processRunner: runner, now: () => 10, delay: async () => {} });
  const config = normalizeConfig(connectionConfig({ filesystemConnectionId: 'connection-local' }));
  const initial = normalizeIdentity(baseResponses());
  const plan = {
    version: 1,
    operation: 'redis-rdb-backup',
    connection: config,
    selector: { allDatabases: true, databases: { include: [], exclude: [] }, schemas: { include: [], exclude: [] }, tables: { include: [], exclude: [] }, includeGlobalObjects: false },
    consistency: { proven: true, evidence: { serverIdentityFingerprint: deploymentFingerprint(initial) } },
    artifact: { kind: 'database-dump', path: 'redis/dump.rdb', mediaType: 'application/x-redis-rdb' }
  };
  let statCalls = 0;
  const filesystem = {
    resolvePath: (directory, filename) => `${directory}/${filename}`,
    lstat: async () => {
      statCalls += 1;
      return { isFile: true, isSymbolicLink: false, size: bytes.length, mtimeMs: statCalls === 1 ? 1000 : 2000 };
    },
    read: async function* () { yield bytes.subarray(0, 8); yield bytes.subarray(8); }
  };
  const destination = path.join(temporaryRoot, 'dump.rdb');
  const media = await adapter.createRdbMedia({ resolveSecret: async () => PASSWORD, filesystem }, plan, destination);
  assert.equal((await fs.readFile(destination)).equals(bytes), true);
  assert.equal(media.sizeBytes, bytes.length);
  assert.match(media.digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(media.before.rdbSaves, 1);
  assert.equal(media.after.rdbSaves, 2);
  const bgsave = runner.calls.find((call) => call.args.at(-1) === 'BGSAVE');
  assert.ok(bgsave);
  assert.equal(bgsave.env.REDISCLI_AUTH, PASSWORD);
  assert.equal(JSON.stringify(bgsave.args).includes(PASSWORD), false);
});

function backupStatus(state, startTime = 0, endTime = 0, error = '') {
  return ['state', state, 'start_time', String(startTime), 'end_time', String(endTime), 'error', error];
}

class SealedRunner extends Runner {
  constructor({ identity = baseResponses(), statuses = [], listed = [], failures = {}, replies = {}, statusFailureAfter = null } = {}) {
    super(identity);
    this.statuses = [...statuses];
    this.listed = listed;
    this.failures = failures;
    this.replies = replies;
    this.statusFailureAfter = statusFailureAfter;
    this.statusReads = 0;
    this.backupCalls = [];
  }

  async run(input) {
    const command = input.args.slice(-2);
    if (command[0] === 'BACKUP') {
      this.calls.push(input);
      const operation = command[1];
      this.backupCalls.push(operation);
      if (operation === 'STATUS') {
        this.statusReads += 1;
        if (this.statusReads === this.statusFailureAfter) throw new DatabaseAdapterError('REDIS_OPERATION_CANCELED', 'The Redis status request was canceled.', { category: 'canceled' });
      }
      if (this.failures[operation]) throw this.failures[operation];
      const value = operation === 'STATUS' ? this.statuses.shift()
        : operation === 'LIST' ? this.listed
          : this.replies[operation] ?? 'OK';
      assert.notEqual(value, undefined, `Missing Redis BACKUP ${operation} fixture response.`);
      return { exitCode: 0, stdout: JSON.stringify(value), stderr: '' };
    }
    return super.run(input);
  }
}

function sealedFiles(overrides = {}) {
  const baseFilename = 'backup-1000.base.rdb';
  const incrementFilename = 'backup-1000.incr.aof';
  const manifestFilename = 'backup-1000.manifest';
  return {
    baseFilename,
    incrementFilename,
    manifestFilename,
    files: {
      [`/var/lib/redis/backupdir/${baseFilename}`]: Buffer.from('REDIS0011-sealed-base'),
      [`/var/lib/redis/backupdir/${incrementFilename}`]: Buffer.from('sealed-increment'),
      [`/var/lib/redis/backupdir/${manifestFilename}`]: Buffer.from(`file ${baseFilename} seq 1 type b\nfile ${incrementFilename} seq 1 type i\n`),
      ...overrides
    }
  };
}

function sealedFilesystem(files) {
  return {
    validateBackupPath: (_directory, _backupDirectoryName, listedPath) => {
      assert.match(listedPath, /^\/var\/lib\/redis\/backupdir\/[^/]+$/);
      return listedPath;
    },
    lstat: async (filePath) => files[filePath] ? { isFile: true, isSymbolicLink: false, size: files[filePath].length, mtimeMs: 1000 } : null,
    read: async function* (filePath) {
      const bytes = files[filePath];
      yield bytes.subarray(0, Math.min(9, bytes.length));
      if (bytes.length > 9) yield bytes.subarray(9);
    }
  };
}

function sealedPlan(identity = normalizeIdentity(baseResponses())) {
  return {
    version: 1,
    operation: 'redis-sealed-backup',
    connection: normalizeConfig(connectionConfig({ filesystemConnectionId: 'connection-local' })),
    selector: { allDatabases: true, databases: { include: [], exclude: [] }, schemas: { include: [], exclude: [] }, tables: { include: [], exclude: [] }, includeGlobalObjects: false },
    consistency: { proven: true, method: 'redis-aof', evidence: { serverIdentityFingerprint: deploymentFingerprint(identity) } },
    artifact: { kind: 'physical-backup', pathPrefix: 'redis/sealed', mediaType: 'application/octet-stream' }
  };
}

test('captures an owned Redis 8.10 sealed BASE, INCR, and manifest set', async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-redis-sealed-test-'));
  context.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const fixture = sealedFiles();
  const listed = Object.keys(fixture.files);
  const runner = new SealedRunner({ statuses: [backupStatus('idle'), backupStatus('incrementing', 1000), backupStatus('sealed', 1000, 1100), backupStatus('idle')], listed });
  const sessions = [];
  const adapter = new RedisNativeAdapter({ processRunner: runner, delay: async () => {} });
  const media = await adapter.createSealedBackupMedia({
    resolveSecret: async () => PASSWORD,
    filesystem: sealedFilesystem(fixture.files),
    onSession: async (session) => sessions.push(session)
  }, sealedPlan(), path.join(temporaryRoot, 'sealed'));

  assert.deepEqual(media.files.map((file) => file.component), ['base', 'increment', 'manifest']);
  assert.deepEqual(media.files.map((file) => file.artifactPath), listed.map((filePath) => `redis/sealed/${path.posix.basename(filePath)}`));
  for (const file of media.files) {
    assert.equal((await fs.readFile(file.filePath)).equals(fixture.files[file.sourcePath]), true);
    assert.match(file.digest, /^sha256:[a-f0-9]{64}$/);
  }
  assert.deepEqual(media.manifestEntries.map((entry) => entry.type), ['b', 'i']);
  assert.deepEqual(sessions.map((session) => session?.state ?? null), ['incrementing', 'sealed', null]);
  assert.equal(sessions[0].startTime, 1000);
  assert.deepEqual(runner.backupCalls, ['STATUS', 'START', 'STATUS', 'SEAL', 'STATUS', 'LIST', 'CLEANUP', 'STATUS']);
});

test('refuses incomplete or manifest-mismatched sealed backup sets and cleans the owned session', async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-redis-sealed-invalid-test-'));
  context.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const fixture = sealedFiles();
  fixture.files[`/var/lib/redis/backupdir/${fixture.manifestFilename}`] = Buffer.from(`file other.base.rdb seq 1 type b\nfile ${fixture.incrementFilename} seq 1 type i\n`);
  const runner = new SealedRunner({ statuses: [backupStatus('idle'), backupStatus('incrementing', 1000), backupStatus('sealed', 1000, 1100), backupStatus('sealed', 1000, 1100), backupStatus('idle')], listed: Object.keys(fixture.files) });
  const adapter = new RedisNativeAdapter({ processRunner: runner, delay: async () => {} });
  await assert.rejects(adapter.createSealedBackupMedia({ resolveSecret: async () => PASSWORD, filesystem: sealedFilesystem(fixture.files) }, sealedPlan(), path.join(temporaryRoot, 'sealed')), (error) => error.code === 'REDIS_BACKUP_MANIFEST_MISMATCH');
  assert.deepEqual(runner.backupCalls.slice(-3), ['STATUS', 'CLEANUP', 'STATUS']);

  const incompleteRunner = new SealedRunner({ statuses: [backupStatus('idle'), backupStatus('incrementing', 2000), backupStatus('sealed', 2000, 2100), backupStatus('sealed', 2000, 2100), backupStatus('idle')], listed: Object.keys(fixture.files).slice(0, 2) });
  const incompleteAdapter = new RedisNativeAdapter({ processRunner: incompleteRunner, delay: async () => {} });
  await assert.rejects(incompleteAdapter.createSealedBackupMedia({ resolveSecret: async () => PASSWORD, filesystem: sealedFilesystem(fixture.files) }, sealedPlan(), path.join(temporaryRoot, 'incomplete')), (error) => error.code === 'REDIS_BACKUP_FILE_SET_INVALID');
  assert.equal(incompleteRunner.backupCalls.includes('CLEANUP'), true);
});

test('refuses foreign sessions and binds ownership to the observed Redis start_time', async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-redis-session-test-'));
  context.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const fixture = sealedFiles();
  const busyRunner = new SealedRunner({ statuses: [backupStatus('snapshotting', 900)] });
  await assert.rejects(new RedisNativeAdapter({ processRunner: busyRunner }).createSealedBackupMedia({ resolveSecret: async () => PASSWORD, filesystem: sealedFilesystem(fixture.files) }, sealedPlan(), path.join(temporaryRoot, 'busy')), (error) => error.code === 'REDIS_BACKUP_SESSION_BUSY');
  assert.deepEqual(busyRunner.backupCalls, ['STATUS']);

  const changedRunner = new SealedRunner({ statuses: [backupStatus('idle'), backupStatus('incrementing', 1000), backupStatus('sealed', 2000, 2100), backupStatus('sealed', 2000, 2100)], listed: Object.keys(fixture.files) });
  await assert.rejects(new RedisNativeAdapter({ processRunner: changedRunner, delay: async () => {} }).createSealedBackupMedia({ resolveSecret: async () => PASSWORD, filesystem: sealedFilesystem(fixture.files) }, sealedPlan(), path.join(temporaryRoot, 'changed')), (error) => error.code === 'REDIS_BACKUP_CLEANUP_UNPROVEN');
  assert.equal(changedRunner.backupCalls.includes('CLEANUP'), false);
  assert.equal(changedRunner.backupCalls.includes('ABORT'), false);
});

test('aborts then cleans an owned unsealed session when capture is canceled', async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-redis-cancel-test-'));
  context.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const fixture = sealedFiles();
  const runner = new SealedRunner({
    statuses: [backupStatus('idle'), backupStatus('incrementing', 1000), backupStatus('incrementing', 1000), backupStatus('failed', 1000, 1001, 'aborted'), backupStatus('idle')],
    failures: { SEAL: new DatabaseAdapterError('REDIS_OPERATION_CANCELED', 'The Redis sealed backup was canceled.', { category: 'canceled' }) }
  });
  const sessions = [];
  await assert.rejects(new RedisNativeAdapter({ processRunner: runner, delay: async () => {} }).createSealedBackupMedia({ resolveSecret: async () => PASSWORD, filesystem: sealedFilesystem(fixture.files), onSession: async (session) => sessions.push(session) }, sealedPlan(), path.join(temporaryRoot, 'sealed')), (error) => error.code === 'REDIS_OPERATION_CANCELED');
  assert.deepEqual(runner.backupCalls.slice(-6), ['SEAL', 'STATUS', 'ABORT', 'STATUS', 'CLEANUP', 'STATUS']);
  assert.equal(sessions.at(-1), null);
});

test('reports an unowned residual risk when start_time cannot be observed after BACKUP START', async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-redis-unbound-test-'));
  context.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const fixture = sealedFiles();
  const runner = new SealedRunner({ statuses: [backupStatus('idle')], statusFailureAfter: 2 });
  await assert.rejects(new RedisNativeAdapter({ processRunner: runner, delay: async () => {} }).createSealedBackupMedia({ resolveSecret: async () => PASSWORD, filesystem: sealedFilesystem(fixture.files) }, sealedPlan(), path.join(temporaryRoot, 'sealed')), (error) => {
    assert.equal(error.code, 'REDIS_BACKUP_CLEANUP_UNPROVEN');
    assert.equal(error.details.captureErrorCode, 'REDIS_OPERATION_CANCELED');
    assert.equal(error.details.cleanupErrorCode, 'REDIS_BACKUP_OWNERSHIP_UNPROVEN');
    return true;
  });
  assert.deepEqual(runner.backupCalls, ['STATUS', 'START', 'STATUS']);
});

test('surfaces unproven cleanup after a sealed capture failure', async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-redis-cleanup-test-'));
  context.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const fixture = sealedFiles();
  const runner = new SealedRunner({ statuses: [backupStatus('idle'), backupStatus('incrementing', 1000), backupStatus('sealed', 1000, 1100), backupStatus('sealed', 1000, 1100)], listed: Object.keys(fixture.files).slice(0, 2), replies: { CLEANUP: 'NOT-OK' } });
  await assert.rejects(new RedisNativeAdapter({ processRunner: runner, delay: async () => {} }).createSealedBackupMedia({ resolveSecret: async () => PASSWORD, filesystem: sealedFilesystem(fixture.files) }, sealedPlan(), path.join(temporaryRoot, 'sealed')), (error) => {
    assert.equal(error.code, 'REDIS_BACKUP_CLEANUP_UNPROVEN');
    assert.equal(error.details.captureErrorCode, 'REDIS_BACKUP_FILE_SET_INVALID');
    assert.equal(error.details.cleanupErrorCode, 'REDIS_BACKUP_CLEANUP_FAILED');
    return true;
  });
});

test('requires backup-sealed-ttl zero before starting a Redis sealed backup', async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-redis-ttl-test-'));
  context.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const identityResponses = baseResponses({ config: [...baseResponses().config.slice(0, -1), '60'] });
  const runner = new SealedRunner({ identity: identityResponses });
  await assert.rejects(new RedisNativeAdapter({ processRunner: runner }).createSealedBackupMedia({ resolveSecret: async () => PASSWORD, filesystem: sealedFilesystem(sealedFiles().files) }, sealedPlan(normalizeIdentity(identityResponses)), path.join(temporaryRoot, 'sealed')), (error) => error.code === 'REDIS_BACKUP_TTL_UNSAFE');
  assert.deepEqual(runner.backupCalls, []);
});

test('reconciles only a Redis backup session with matching identity and start_time', async () => {
  const identity = normalizeIdentity(baseResponses());
  const ownership = { version: 1, state: 'incrementing', startTime: 1000, serverIdentityFingerprint: deploymentFingerprint(identity) };
  const ownedRunner = new SealedRunner({ statuses: [backupStatus('incrementing', 1000), backupStatus('failed', 1000, 1001), backupStatus('idle')] });
  const owned = await new RedisNativeAdapter({ processRunner: ownedRunner }).reconcileBackupSession({ resolveSecret: async () => PASSWORD }, normalizeConfig(connectionConfig()), ownership);
  assert.deepEqual(owned, { proven: true, reconciled: true, previousState: 'failed', state: 'idle' });
  assert.deepEqual(ownedRunner.backupCalls, ['STATUS', 'ABORT', 'STATUS', 'CLEANUP', 'STATUS']);

  const foreignRunner = new SealedRunner({ statuses: [backupStatus('sealed', 2000, 2100)] });
  const foreign = await new RedisNativeAdapter({ processRunner: foreignRunner }).reconcileBackupSession({ resolveSecret: async () => PASSWORD }, normalizeConfig(connectionConfig()), ownership);
  assert.equal(foreign.proven, false);
  assert.equal(foreign.reasonCode, 'REDIS_RECONCILIATION_OWNERSHIP_CHANGED');
  assert.deepEqual(foreignRunner.backupCalls, ['STATUS']);
});

function multipartResponses(overrides = {}) {
  const base = baseResponses();
  return baseResponses({
    server: base.server.replace('redis_version:8.10.0', 'redis_version:7.4.2'),
    backupCommand: [null],
    ...overrides
  });
}

class MultipartRunner extends Runner {
  constructor({ identity = multipartResponses(), replies = {}, failures = {}, controlReplies = {} } = {}) {
    super(identity);
    this.replies = replies;
    this.failures = failures;
    this.controlReplies = controlReplies;
    this.policyCalls = [];
    this.controlCalls = [];
  }

  async run(input) {
    if (input.args.length === 1 && input.args[0] === '--version') return { exitCode: 0, stdout: 'redis-cli 7.4.2', stderr: '' };
    const clientCommand = input.args.slice(-4);
    if (clientCommand[0] === 'CLIENT' && clientCommand[1] === 'PAUSE') {
      this.calls.push(input);
      this.controlCalls.push(['PAUSE', Number(clientCommand[2]), clientCommand[3]]);
      return { exitCode: 0, stdout: JSON.stringify(this.controlReplies.PAUSE ?? 'OK'), stderr: '' };
    }
    if (input.args.at(-2) === 'CLIENT' && input.args.at(-1) === 'UNPAUSE') {
      this.calls.push(input);
      this.controlCalls.push(['UNPAUSE']);
      return { exitCode: 0, stdout: JSON.stringify(this.controlReplies.UNPAUSE ?? 'OK'), stderr: '' };
    }
    const command = input.args.slice(-4);
    if (command[0] === 'CONFIG' && command[1] === 'SET' && command[2] === 'auto-aof-rewrite-percentage') {
      this.calls.push(input);
      const value = Number(command[3]);
      this.policyCalls.push(value);
      if (this.failures[value]) throw this.failures[value];
      const reply = this.replies[value] ?? 'OK';
      if (String(reply).toUpperCase() === 'OK') {
        const index = this.responses.config.indexOf('auto-aof-rewrite-percentage');
        this.responses.config[index + 1] = String(value);
      }
      return { exitCode: 0, stdout: JSON.stringify(reply), stderr: '' };
    }
    return super.run(input);
  }
}

function multipartFixture() {
  const directory = '/var/lib/redis';
  const appendDirectory = `${directory}/appendonlydir`;
  const baseFilename = 'appendonly.aof.1.base.rdb';
  const incrementFilenames = ['appendonly.aof.1.incr.aof', 'appendonly.aof.2.incr.aof'];
  const manifestFilename = 'appendonly.aof.manifest';
  const manifest = Buffer.from(`file ${baseFilename} seq 1 type b\nfile ${incrementFilenames[0]} seq 1 type i\nfile ${incrementFilenames[1]} seq 2 type i\n`);
  const files = {
    [`${appendDirectory}/${baseFilename}`]: Buffer.from('REDIS0011-multipart-base'),
    [`${appendDirectory}/${incrementFilenames[0]}`]: Buffer.from('first-increment'),
    [`${appendDirectory}/${incrementFilenames[1]}`]: Buffer.from('second-increment'),
    [`${appendDirectory}/${manifestFilename}`]: manifest
  };
  return { directory, appendDirectory, baseFilename, incrementFilenames, manifestFilename, manifest, files };
}

function multipartFilesystem(fixture, options = {}) {
  let manifestReads = 0;
  return {
    resolveAofPath: (directory, appendDirectoryName, filename) => {
      assert.equal(directory, fixture.directory);
      assert.equal(appendDirectoryName, 'appendonlydir');
      assert.match(filename, /^[A-Za-z0-9._-]+$/);
      return `${fixture.appendDirectory}/${filename}`;
    },
    lstat: async (filePath) => {
      const bytes = fixture.files[filePath];
      return bytes ? { isFile: true, isSymbolicLink: false, size: bytes.length, mtimeMs: 1000 } : null;
    },
    read: async function* (filePath) {
      let bytes = fixture.files[filePath];
      if (filePath.endsWith('.manifest')) {
        manifestReads += 1;
        if (manifestReads >= 2 && options.changedManifest) bytes = options.changedManifest;
      }
      if (options.cancelPath === filePath) throw new DatabaseAdapterError('REDIS_OPERATION_CANCELED', 'The Redis AOF backup was canceled.', { category: 'canceled' });
      yield bytes.subarray(0, Math.min(9, bytes.length));
      if (bytes.length > 9) yield bytes.subarray(9);
    }
  };
}

function multipartPlan(identity = normalizeIdentity(multipartResponses())) {
  return {
    version: 1,
    operation: 'redis-multipart-aof-backup',
    connection: normalizeConfig(connectionConfig({ filesystemConnectionId: 'connection-local' })),
    selector: { allDatabases: true, databases: { include: [], exclude: [] }, schemas: { include: [], exclude: [] }, tables: { include: [], exclude: [] }, includeGlobalObjects: false },
    consistency: { proven: true, method: 'redis-aof', evidence: { serverIdentityFingerprint: deploymentFingerprint(identity), metadata: { backupStrategy: 'multipart-aof' } } },
    artifact: { kind: 'physical-backup', pathPrefix: 'redis/aof', mediaType: 'application/octet-stream' }
  };
}

test('captures a Redis 7 multipart-AOF manifest set and restores rewrite policy', async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-redis-multipart-test-'));
  context.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const fixture = multipartFixture();
  const runner = new MultipartRunner();
  const sessions = [];
  const adapter = new RedisNativeAdapter({ processRunner: runner });
  const media = await adapter.createMultipartAofMedia({ resolveSecret: async () => PASSWORD, filesystem: multipartFilesystem(fixture), onSession: async (session) => sessions.push(session) }, multipartPlan(), path.join(temporaryRoot, 'aof'));

  assert.deepEqual(media.files.map((file) => file.component), ['base', 'increment', 'increment', 'manifest']);
  assert.deepEqual(media.files.map((file) => file.artifactPath), [fixture.baseFilename, ...fixture.incrementFilenames, fixture.manifestFilename].map((filename) => `redis/aof/${filename}`));
  assert.deepEqual(media.manifestEntries.map((entry) => [entry.type, entry.sequence]), [['b', 1], ['i', 1], ['i', 2]]);
  assert.deepEqual(runner.policyCalls, [0, 100]);
  assert.deepEqual(runner.controlCalls, [['PAUSE', 300000, 'WRITE'], ['UNPAUSE']]);
  assert.equal(runner.responses.config[runner.responses.config.indexOf('auto-aof-rewrite-percentage') + 1], '100');
  assert.equal(sessions[0].kind, 'multipart-aof-rewrite-policy');
  assert.equal(sessions.at(-1), null);
  assert.equal(media.rewritePolicy.restored, true);
  for (const file of media.files) assert.match(file.digest, /^sha256:[a-f0-9]{64}$/);
});

test('refuses multipart-AOF manifest drift and restores rewrite policy after failure', async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-redis-multipart-drift-test-'));
  context.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const fixture = multipartFixture();
  const changedManifest = Buffer.from(fixture.manifest.toString('utf8').replace('seq 2 type i', 'seq 3 type i'));
  const runner = new MultipartRunner();
  const adapter = new RedisNativeAdapter({ processRunner: runner });
  await assert.rejects(adapter.createMultipartAofMedia({ resolveSecret: async () => PASSWORD, filesystem: multipartFilesystem(fixture, { changedManifest }) }, multipartPlan(), path.join(temporaryRoot, 'aof')), (error) => error.code === 'REDIS_BACKUP_MANIFEST_CHANGED');
  assert.deepEqual(runner.policyCalls, [0, 100]);
  assert.deepEqual(runner.controlCalls, [['PAUSE', 300000, 'WRITE'], ['UNPAUSE']]);
  assert.equal(await fs.stat(path.join(temporaryRoot, 'aof')).then(() => true).catch(() => false), false);
});

test('restores multipart-AOF rewrite policy on cancellation and exposes restoration failure', async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-redis-multipart-cancel-test-'));
  context.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const fixture = multipartFixture();
  const cancelPath = `${fixture.appendDirectory}/${fixture.incrementFilenames[0]}`;
  const runner = new MultipartRunner();
  await assert.rejects(new RedisNativeAdapter({ processRunner: runner }).createMultipartAofMedia({ resolveSecret: async () => PASSWORD, filesystem: multipartFilesystem(fixture, { cancelPath }) }, multipartPlan(), path.join(temporaryRoot, 'canceled')), (error) => error.code === 'REDIS_OPERATION_CANCELED');
  assert.deepEqual(runner.policyCalls, [0, 100]);
  assert.deepEqual(runner.controlCalls, [['PAUSE', 300000, 'WRITE'], ['UNPAUSE']]);

  const unsafeRunner = new MultipartRunner({ replies: { 100: 'NOT-OK' } });
  await assert.rejects(new RedisNativeAdapter({ processRunner: unsafeRunner }).createMultipartAofMedia({ resolveSecret: async () => PASSWORD, filesystem: multipartFilesystem(fixture, { cancelPath }) }, multipartPlan(), path.join(temporaryRoot, 'unsafe')), (error) => {
    assert.equal(error.code, 'REDIS_AOF_CLEANUP_UNPROVEN');
    assert.equal(error.details.captureErrorCode, 'REDIS_OPERATION_CANCELED');
    assert.equal(error.details.restoreErrorCode, 'REDIS_AOF_POLICY_RESTORE_FAILED');
    return true;
  });

  const resumeRunner = new MultipartRunner({ controlReplies: { UNPAUSE: 'NOT-OK' } });
  await assert.rejects(new RedisNativeAdapter({ processRunner: resumeRunner }).createMultipartAofMedia({ resolveSecret: async () => PASSWORD, filesystem: multipartFilesystem(fixture) }, multipartPlan(), path.join(temporaryRoot, 'resume-unsafe')), (error) => {
    assert.equal(error.code, 'REDIS_AOF_CLEANUP_UNPROVEN');
    assert.equal(error.details.captureErrorCode, 'REDIS_AOF_WRITE_RESUME_FAILED');
    assert.equal(error.details.unpauseErrorCode, 'REDIS_AOF_WRITE_RESUME_FAILED');
    return true;
  });
  assert.deepEqual(resumeRunner.policyCalls, [0, 100]);
  assert.deepEqual(resumeRunner.controlCalls, [['PAUSE', 300000, 'WRITE'], ['UNPAUSE'], ['UNPAUSE']]);
});

test('reconciles only an owned Redis multipart-AOF rewrite-policy mutation', async () => {
  const disabled = multipartResponses();
  disabled.config[disabled.config.indexOf('auto-aof-rewrite-percentage') + 1] = '0';
  const identity = normalizeIdentity(multipartResponses());
  const ownership = { version: 1, kind: 'multipart-aof-rewrite-policy', originalAutomaticRewritePercentage: 100, serverIdentityFingerprint: deploymentFingerprint(identity) };
  const runner = new MultipartRunner({ identity: disabled });
  const result = await new RedisNativeAdapter({ processRunner: runner }).reconcileBackupSession({ resolveSecret: async () => PASSWORD }, normalizeConfig(connectionConfig()), ownership);
  assert.deepEqual(result, { proven: true, reconciled: true, previousValue: 0, value: 100, state: 'restored' });
  assert.deepEqual(runner.policyCalls, [100]);

  const foreignPolicy = multipartResponses();
  foreignPolicy.config[foreignPolicy.config.indexOf('auto-aof-rewrite-percentage') + 1] = '50';
  const foreignRunner = new MultipartRunner({ identity: foreignPolicy });
  const foreign = await new RedisNativeAdapter({ processRunner: foreignRunner }).reconcileBackupSession({ resolveSecret: async () => PASSWORD }, normalizeConfig(connectionConfig()), ownership);
  assert.equal(foreign.proven, false);
  assert.equal(foreign.reasonCode, 'REDIS_AOF_RECONCILIATION_OWNERSHIP_CHANGED');
  assert.deepEqual(foreignRunner.policyCalls, []);
});

class RestoreRunner {
  constructor({ serverVersion = '8.10.0', databases = 'db0:keys=3,expires=1,avg_ttl=1000\n', failPing = false } = {}) {
    this.serverVersion = serverVersion;
    this.databases = databases;
    this.failPing = failPing;
    this.calls = [];
    this.streamCalls = [];
    this.server = null;
    this.cancelCount = 0;
  }

  async run(input) {
    this.calls.push(input);
    if (input.executable.endsWith('redis-server') && input.args.length === 1 && input.args[0] === '--version') return { exitCode: 0, stdout: `Redis server v=${this.serverVersion} sha=00000000 malloc=libc bits=64`, stderr: '' };
    const command = input.args.at(-2) === 'SHUTDOWN' ? 'SHUTDOWN' : input.args.at(-2) === 'INFO' ? `INFO ${input.args.at(-1)}` : input.args.at(-1);
    if (command === 'SHUTDOWN') {
      this.server?.resolve({ exitCode: 0, signal: null, stderr: '' });
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (this.failPing && command === 'PING') throw new DatabaseAdapterError('REDIS_CONNECT_FAILED', 'not ready', { category: 'connectivity', retryable: true });
    const values = {
      PING: 'PONG',
      'INFO server': `redis_version:${this.serverVersion}\nredis_mode:standalone\nrun_id:isolated-restore\n`,
      'INFO persistence': 'loading:0\nrdb_last_bgsave_status:ok\naof_enabled:1\naof_last_bgrewrite_status:ok\naof_last_write_status:ok\n',
      'INFO keyspace': this.databases,
      ROLE: ['master', 0, []]
    };
    assert.ok(Object.hasOwn(values, command), `Unexpected isolated Redis command: ${input.args.join(' ')}`);
    return { exitCode: 0, stdout: JSON.stringify(values[command]), stderr: '' };
  }

  stream(input) {
    this.streamCalls.push(input);
    let resolve;
    let reject;
    const completion = new Promise((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
    this.server = { resolve, reject };
    return { stdout: { resume() {} }, completion, cancel: () => { this.cancelCount += 1; resolve({ exitCode: 0, signal: 'SIGTERM', stderr: '' }); } };
  }
}

function restoreDigest(bytes) {
  return `sha256:${require('node:crypto').createHash('sha256').update(bytes).digest('hex')}`;
}

function rdbRestoreMetadata(bytes) {
  return {
    kind: 'redis-rdb',
    artifact: { kind: 'database-dump', path: 'redis/dump.rdb', mediaType: 'application/x-redis-rdb', sizeBytes: bytes.length, contentDigest: restoreDigest(bytes) },
    consistency: { evidence: { serverVersion: '7.4.2', metadata: { databases: [{ name: 'db0', keys: 3, expires: 1 }] } } }
  };
}

function aofRestoreFixture(kind = 'redis-multipart-aof') {
  const baseFilename = kind === 'redis-sealed-backup' ? 'backup-1000.base.rdb' : 'appendonly.aof.1.base.rdb';
  const incrementFilenames = kind === 'redis-sealed-backup' ? ['backup-1000.incr.aof'] : ['appendonly.aof.1.incr.aof', 'appendonly.aof.2.incr.aof'];
  const manifestFilename = kind === 'redis-sealed-backup' ? 'backup-1000.manifest' : 'appendonly.aof.manifest';
  const bytes = new Map([
    [baseFilename, Buffer.from('REDIS0011-restore-base')],
    ...incrementFilenames.map((filename, index) => [filename, Buffer.from(`restore-increment-${index + 1}`)]),
    [manifestFilename, Buffer.from(`file ${baseFilename} seq 1 type b\n${incrementFilenames.map((filename, index) => `file ${filename} seq ${index + 1} type i`).join('\n')}\n`)]
  ]);
  const prefix = kind === 'redis-sealed-backup' ? 'redis/sealed' : 'redis/aof';
  const artifacts = [
    { component: 'base', filename: baseFilename, path: `${prefix}/${baseFilename}`, mediaType: 'application/x-redis-rdb' },
    ...incrementFilenames.map((filename) => ({ component: 'increment', filename, path: `${prefix}/${filename}`, mediaType: 'application/x-redis-aof' })),
    { component: 'manifest', filename: manifestFilename, path: `${prefix}/${manifestFilename}`, mediaType: 'text/plain' }
  ].map((artifact) => ({ ...artifact, sizeBytes: bytes.get(artifact.filename).length, contentDigest: restoreDigest(bytes.get(artifact.filename)) }));
  return {
    bytes,
    metadata: { kind, artifacts, consistency: { evidence: { serverVersion: kind === 'redis-sealed-backup' ? '8.10.0' : '7.4.2', metadata: { databases: [{ name: 'db0', keys: 3, expires: 1 }] } } } }
  };
}

function restoreSource(bytesByPath) {
  return {
    async open(artifactPath) {
      const bytes = bytesByPath.get(artifactPath);
      assert.ok(bytes, `Missing restore source fixture: ${artifactPath}`);
      return (async function* () { yield bytes.subarray(0, Math.min(9, bytes.length)); if (bytes.length > 9) yield bytes.subarray(9); })();
    }
  };
}

test('materializes and natively validates an isolated alternate Redis RDB restore', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-redis-rdb-restore-test-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const targetDirectory = path.join(root, 'restored-rdb');
  const bytes = Buffer.from('REDIS0011-authenticated-restore-rdb');
  const runner = new RestoreRunner({ serverVersion: '7.4.2' });
  const adapter = new RedisNativeAdapter({ processRunner: runner, delay: async () => {} });
  const plan = await adapter.planRestore({}, { mode: 'alternate', confirmation: 'RESTORE_REDIS_ALTERNATE', targetDirectory, executionId: 'restore-rdb-1', port: 26379, timeoutMs: 30000, metadata: rdbRestoreMetadata(bytes) });
  const result = await adapter.executeRestore({}, plan, restoreSource(new Map([['redis/dump.rdb', bytes]])));
  const validation = await adapter.validateRestore({}, result);

  assert.equal((await fs.readFile(path.join(targetDirectory, 'dump.rdb'))).equals(bytes), true);
  assert.equal(await fs.lstat(plan.stageDirectory).catch(() => null), null);
  assert.equal(await fs.lstat(plan.validationDirectory).catch(() => null), null);
  assert.equal(result.validation.role, 'master');
  assert.equal(validation.valid, true);
  assert.equal(validation.nativeIntegrityValidation, true);
  assert.equal(runner.streamCalls[0].args.includes('--appendonly'), true);
  assert.equal(runner.streamCalls[0].args[runner.streamCalls[0].args.indexOf('--appendonly') + 1], 'no');
  assert.deepEqual(runner.streamCalls[0].args.slice(0, 6), ['--bind', '127.0.0.1', '--protected-mode', 'yes', '--port', '26379']);
});

test('natively validates multipart and sealed AOF layouts without mutating published artifacts', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-redis-aof-restore-test-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const kind of ['redis-multipart-aof', 'redis-sealed-backup']) {
    const fixture = aofRestoreFixture(kind);
    const byPath = new Map(fixture.metadata.artifacts.map((artifact) => [artifact.path, fixture.bytes.get(artifact.filename)]));
    const targetDirectory = path.join(root, kind);
    const runner = new RestoreRunner({ serverVersion: kind === 'redis-sealed-backup' ? '8.10.0' : '7.4.2' });
    const adapter = new RedisNativeAdapter({ processRunner: runner, delay: async () => {} });
    const plan = await adapter.planRestore({}, { mode: 'alternate', confirmation: 'RESTORE_REDIS_ALTERNATE', targetDirectory, executionId: `restore-${kind}`, port: kind === 'redis-sealed-backup' ? 26380 : 26381, timeoutMs: 30000, metadata: fixture.metadata });
    const result = await adapter.executeRestore({}, plan, restoreSource(byPath));
    assert.equal((await adapter.validateRestore({}, result)).valid, true);
    for (const artifact of plan.layout) assert.equal((await fs.readFile(path.join(targetDirectory, artifact.relativePath))).equals(byPath.get(artifact.path)), true);
    if (kind === 'redis-multipart-aof') {
      assert.equal(runner.streamCalls[0].args.includes('--appendfilename'), true);
      assert.equal(runner.streamCalls[0].args.includes('appendonly.aof'), true);
    } else {
      assert.equal(runner.streamCalls[0].args.includes('--preload-file'), true);
      assert.match(runner.streamCalls[0].args.at(-1), /^aof:.*backup-1000[.]manifest$/);
    }
  }
});

test('refuses unsafe Redis restore targets, metadata, digests, and incompatible servers', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-redis-restore-refusal-test-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from('REDIS0011-refusal-rdb');
  const adapter = new RedisNativeAdapter({ processRunner: new RestoreRunner({ serverVersion: '7.4.2' }), delay: async () => {} });
  await assert.rejects(adapter.planRestore({}, { mode: 'original', confirmation: 'RESTORE_REDIS_ORIGINAL', targetDirectory: path.join(root, 'original'), executionId: 'unsafe-1', port: 26382, metadata: rdbRestoreMetadata(bytes) }), (error) => error.code === 'REDIS_RESTORE_MODE_UNSUPPORTED');
  await fs.mkdir(path.join(root, 'exists'));
  await assert.rejects(adapter.planRestore({}, { mode: 'alternate', confirmation: 'RESTORE_REDIS_ALTERNATE', targetDirectory: path.join(root, 'exists'), executionId: 'unsafe-2', port: 26382, metadata: rdbRestoreMetadata(bytes) }), (error) => error.code === 'REDIS_RESTORE_TARGET_EXISTS');
  const unsafeMetadata = rdbRestoreMetadata(bytes);
  unsafeMetadata.artifact.path = '../dump.rdb';
  await assert.rejects(adapter.planRestore({}, { mode: 'alternate', confirmation: 'RESTORE_REDIS_ALTERNATE', targetDirectory: path.join(root, 'unsafe-metadata'), executionId: 'unsafe-3', port: 26382, metadata: unsafeMetadata }), (error) => error.code === 'REDIS_RESTORE_METADATA_INVALID');
  const oversizedManifest = aofRestoreFixture().metadata;
  oversizedManifest.artifacts.find((artifact) => artifact.component === 'manifest').sizeBytes = 1024 * 1024 + 1;
  await assert.rejects(adapter.planRestore({}, { mode: 'alternate', confirmation: 'RESTORE_REDIS_ALTERNATE', targetDirectory: path.join(root, 'oversized-manifest'), executionId: 'unsafe-manifest', port: 26382, metadata: oversizedManifest }), (error) => error.code === 'REDIS_RESTORE_METADATA_INVALID');

  const digestPlan = await adapter.planRestore({}, { mode: 'alternate', confirmation: 'RESTORE_REDIS_ALTERNATE', targetDirectory: path.join(root, 'digest'), executionId: 'unsafe-4', port: 26382, metadata: rdbRestoreMetadata(bytes) });
  const corrupt = Buffer.from(bytes);
  corrupt[10] ^= 1;
  await assert.rejects(adapter.executeRestore({}, digestPlan, restoreSource(new Map([['redis/dump.rdb', corrupt]]))), (error) => error.code === 'REDIS_RESTORE_DIGEST_MISMATCH');
  assert.equal(await fs.lstat(digestPlan.targetDirectory).catch(() => null), null);

  const sealed = aofRestoreFixture('redis-sealed-backup');
  const oldRunner = new RestoreRunner({ serverVersion: '7.4.2' });
  const oldAdapter = new RedisNativeAdapter({ processRunner: oldRunner, delay: async () => {} });
  const sealedPlan = await oldAdapter.planRestore({}, { mode: 'alternate', confirmation: 'RESTORE_REDIS_ALTERNATE', targetDirectory: path.join(root, 'old-server'), executionId: 'unsafe-5', port: 26383, metadata: sealed.metadata });
  const sealedSource = restoreSource(new Map(sealed.metadata.artifacts.map((artifact) => [artifact.path, sealed.bytes.get(artifact.filename)])));
  await assert.rejects(oldAdapter.executeRestore({}, sealedPlan, sealedSource), (error) => error.code === 'REDIS_RESTORE_VERSION_INCOMPATIBLE');
  assert.equal(oldRunner.streamCalls.length, 0);
});

test('does not replace an alternate Redis target created during publication', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-redis-restore-race-test-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const targetDirectory = path.join(root, 'concurrent-target');
  const bytes = Buffer.from('REDIS0011-concurrent-target-rdb');
  let injected = false;
  const raceFileSystem = Object.create(fs);
  raceFileSystem.mkdir = async (directory, options) => {
    if (directory === targetDirectory && !injected) {
      injected = true;
      await fs.mkdir(directory, options);
    }
    return fs.mkdir(directory, options);
  };
  const adapter = new RedisNativeAdapter({ processRunner: new RestoreRunner({ serverVersion: '7.4.2' }), fileSystem: raceFileSystem, delay: async () => {} });
  const plan = await adapter.planRestore({}, { mode: 'alternate', confirmation: 'RESTORE_REDIS_ALTERNATE', targetDirectory, executionId: 'publish-race-1', port: 26385, metadata: rdbRestoreMetadata(bytes) });

  await assert.rejects(adapter.executeRestore({}, plan, restoreSource(new Map([['redis/dump.rdb', bytes]]))), (error) => error.code === 'REDIS_RESTORE_TARGET_EXISTS');
  assert.deepEqual(await fs.readdir(targetDirectory), []);
  assert.equal(await fs.lstat(plan.stageDirectory).catch(() => null), null);
  assert.equal(await fs.lstat(plan.validationDirectory).catch(() => null), null);
});

test('reports an uncertain Redis publication without deleting the claimed target', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-redis-restore-publish-failure-test-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const targetDirectory = path.join(root, 'claimed-target');
  const bytes = Buffer.from('REDIS0011-publish-failure-rdb');
  const failingFileSystem = Object.create(fs);
  failingFileSystem.rename = async (sourcePath, destinationPath) => {
    if (destinationPath === path.join(targetDirectory, 'dump.rdb')) {
      const error = new Error('publication move failed');
      error.code = 'EIO';
      throw error;
    }
    return fs.rename(sourcePath, destinationPath);
  };
  const adapter = new RedisNativeAdapter({ processRunner: new RestoreRunner({ serverVersion: '7.4.2' }), fileSystem: failingFileSystem, delay: async () => {} });
  const plan = await adapter.planRestore({}, { mode: 'alternate', confirmation: 'RESTORE_REDIS_ALTERNATE', targetDirectory, executionId: 'publish-failure-1', port: 26388, metadata: rdbRestoreMetadata(bytes) });

  await assert.rejects(adapter.executeRestore({}, plan, restoreSource(new Map([['redis/dump.rdb', bytes]]))), (error) => error.code === 'REDIS_RESTORE_PUBLICATION_UNCERTAIN');
  assert.deepEqual(await fs.readdir(targetDirectory), []);
  assert.equal(await fs.lstat(plan.stageDirectory).catch(() => null), null);
  assert.equal(await fs.lstat(plan.validationDirectory).catch(() => null), null);
});

test('accepts only key-count deficits bounded by protected expirations', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-redis-restore-expiry-test-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from('REDIS0011-expiry-bounds-rdb');
  const warningAdapter = new RedisNativeAdapter({ processRunner: new RestoreRunner({ serverVersion: '7.4.2', databases: 'db0:keys=2,expires=0,avg_ttl=0\n' }), delay: async () => {} });
  const warningPlan = await warningAdapter.planRestore({}, { mode: 'alternate', confirmation: 'RESTORE_REDIS_ALTERNATE', targetDirectory: path.join(root, 'warning'), executionId: 'expiry-warning-1', port: 26386, metadata: rdbRestoreMetadata(bytes) });
  const warning = await warningAdapter.executeRestore({}, warningPlan, restoreSource(new Map([['redis/dump.rdb', bytes]])));
  assert.equal(warning.validation.warnings.length, 1);

  const failureRunner = new RestoreRunner({ serverVersion: '7.4.2', databases: 'db0:keys=1,expires=0,avg_ttl=0\n' });
  const failureAdapter = new RedisNativeAdapter({ processRunner: failureRunner, delay: async () => {} });
  const failurePlan = await failureAdapter.planRestore({}, { mode: 'alternate', confirmation: 'RESTORE_REDIS_ALTERNATE', targetDirectory: path.join(root, 'failure'), executionId: 'expiry-failure-1', port: 26387, metadata: rdbRestoreMetadata(bytes) });
  await assert.rejects(failureAdapter.executeRestore({}, failurePlan, restoreSource(new Map([['redis/dump.rdb', bytes]]))), (error) => error.code === 'REDIS_RESTORE_KEYSPACE_DIVERGED');
  assert.equal(await fs.lstat(failurePlan.targetDirectory).catch(() => null), null);
  assert.equal(failureRunner.cancelCount, 1);
});

test('removes all Redis restore staging when cancellation occurs before publication', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-redis-restore-cancel-test-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from('REDIS0011-canceled-restore-rdb');
  const controller = new AbortController();
  const adapter = new RedisNativeAdapter({ processRunner: new RestoreRunner({ serverVersion: '7.4.2' }), delay: async () => {} });
  const plan = await adapter.planRestore({}, { mode: 'alternate', confirmation: 'RESTORE_REDIS_ALTERNATE', targetDirectory: path.join(root, 'canceled'), executionId: 'cancel-1', port: 26384, metadata: rdbRestoreMetadata(bytes) });
  const source = {
    async open() {
      return (async function* () { yield bytes.subarray(0, 9); controller.abort(); yield bytes.subarray(9); })();
    }
  };
  await assert.rejects(adapter.executeRestore({ signal: controller.signal }, plan, source), (error) => error.code === 'REDIS_RESTORE_CANCELED');
  assert.equal(await fs.lstat(plan.targetDirectory).catch(() => null), null);
  assert.equal(await fs.lstat(plan.stageDirectory).catch(() => null), null);
  assert.equal(await fs.lstat(plan.validationDirectory).catch(() => null), null);
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
        if (name === 'secretRef') {
          const record = { ...input, revision: 1 };
          secretRefs.set(record.id, record);
          return record;
        }
        const record = { ...input, id: 'connection-redis', revision: 1 };
        connections.set(record.id, record);
        return record;
      }
    })
  };
  const secretStore = {
    create: async (input) => ({ id: 'sec_redis123', workspaceId: input.workspaceId, name: input.name, provider: 'local-safe-storage', scope: input.scope, providerKey: 'redis-key', secretType: input.secretType, version: 1 }),
    resolve: async () => PASSWORD,
    markValidated: async () => ({ lastValidatedAt: '2026-08-04T00:00:00.000Z' }),
    delete: async ({ id }) => deletedSecrets.push(id)
  };
  return { connections, deletedSecrets, controlDatabase, secretStore };
}

test('persists only a device-scoped Redis password SecretRef and gates discovery on trust', async () => {
  const fixture = serviceFixture();
  const adapter = new RedisNativeAdapter({ processRunner: new Runner(), clock: () => '2026-08-04T00:00:00.000Z', now: () => 0 });
  const service = new RedisConnectionService({ ...fixture, deviceId: 'device-a', adapter });
  const created = await service.create('workspace-a', 'actor-a', { name: 'Cache Redis', host: 'redis01.example.com', username: 'backup-user', password: PASSWORD, tlsMode: 'verify-identity' });
  assert.equal(created.adapterId, ADAPTER_ID);
  assert.deepEqual(created.secretRefIds, ['sec_redis123']);
  assert.equal(created.endpoint.password, undefined);
  assert.equal(JSON.stringify(created).includes(PASSWORD), false);
  await assert.rejects(service.discover('workspace-a', created.id), /Test the Redis connection successfully/);
  const tested = await service.test('workspace-a', created.id, 'actor-a');
  assert.equal(tested.result.status, 'success');
  assert.match(tested.connection.trust.fingerprint, /^sha256:/);
  const discovered = await service.discover('workspace-a', created.id);
  assert.deepEqual(discovered.items.map((item) => item.name), ['db0', 'db2']);
  assert.equal((await service.list('workspace-a'))[0].currentDevice, true);
  assert.equal(fixture.deletedSecrets.length, 0);
  assert.equal(JSON.stringify([...fixture.connections.values()]).includes(PASSWORD), false);
});
