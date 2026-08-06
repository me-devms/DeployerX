const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ADAPTER_ID, redisRestorePath } = require('./redis');
const { RESTORE_CONFIRMATIONS, RedisRestoreService, normalizeRequest } = require('./redis-restore');

const WORKSPACE_ID = 'workspace-redis-restore';
const DEVICE_ID = 'device-redis-restore';

function fixture(targetDirectory, bytes) {
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  const repositoryDigest = crypto.createHmac('sha256', 'repository-test-key').update(bytes).digest('hex');
  const databaseMetadata = {
    version: 1,
    kind: 'redis-rdb',
    adapterId: ADAPTER_ID,
    artifact: { kind: 'database-dump', path: 'redis/dump.rdb', mediaType: 'application/x-redis-rdb', sizeBytes: bytes.length, contentDigest: `sha256:${digest}` },
    consistency: { evidence: { serverVersion: '7.4.2', metadata: { databases: [{ name: 'db0', keys: 2, expires: 0 }] } } }
  };
  const records = {
    recoveryPoint: new Map([['point-redis', { id: 'point-redis', sourceId: 'source-redis', type: 'full', consistency: 'application', repositoryCopies: [{ repositoryId: 'repository-a', engineSnapshotId: 'snapshot-a', state: 'available' }] }]]),
    source: new Map([['source-redis', { id: 'source-redis', adapterId: ADAPTER_ID, connectionId: 'connection-redis' }]]),
    connection: new Map([['connection-redis', { id: 'connection-redis', adapterId: ADAPTER_ID, workerAffinity: [`device:${DEVICE_ID}`] }]]),
    artifact: new Map([['artifact-rdb', { id: 'artifact-rdb', recoveryPointId: 'point-redis', repositoryId: 'repository-a', kind: 'database-dump', locator: 'manifest#redis%2Fdump.rdb', sizeBytes: bytes.length, checksum: { algorithm: 'hmac-sha256', digest: repositoryDigest }, metadata: databaseMetadata }]]),
    restoreRun: new Map()
  };
  let sequence = 0;
  const repository = (name) => ({
    get: async (_workspaceId, id) => records[name].get(id) || null,
    list: async () => [...records[name].values()],
    create: async (input) => {
      const record = { ...input, id: `restore-${++sequence}`, revision: 1 };
      records[name].set(record.id, record);
      return record;
    }
  });
  const controlDatabase = {
    repository,
    transaction: async (callback) => callback({
      get: (name, _workspaceId, id) => records[name].get(id) || null,
      projectExecution: (name, _workspaceId, id, changes) => {
        const updated = { ...records[name].get(id), ...changes, revision: records[name].get(id).revision + 1 };
        records[name].set(id, updated);
        return updated;
      }
    })
  };
  const snapshot = { manifest: { files: [{ path: 'redis/dump.rdb', type: 'file', sizeBytes: bytes.length, contentDigest: { algorithm: 'hmac-sha256', digest: repositoryDigest }, metadata: { artifactKind: 'database-dump', database: databaseMetadata } }] } };
  const openRepository = async () => ({
    masterKey: Buffer.alloc(32),
    engine: {
      openSnapshot: async () => snapshot,
      streamFile: () => (async function* () { yield bytes.subarray(0, 9); yield bytes.subarray(9); })()
    }
  });
  const calls = [];
  const adapter = {
    async planRestore(_context, request) { calls.push(['plan', request]); return { operation: 'redis-isolated-alternate-restore', targetDirectory: request.targetDirectory, metadata: request.metadata }; },
    async executeRestore(_context, plan, source) {
      const chunks = [];
      for await (const chunk of await source.open('redis/dump.rdb')) chunks.push(Buffer.from(chunk));
      calls.push(['execute', plan, Buffer.concat(chunks)]);
      return { status: 'succeeded', targetDirectory: plan.targetDirectory, validation: { valid: true, warnings: [] } };
    },
    async validateRestore() {
      calls.push(['validate']);
      return { valid: true, status: 'succeeded', nativeIntegrityValidation: true, warnings: [], checks: [{ id: 'keyspace', status: 'pass', safeMessage: 'matched' }] };
    }
  };
  return { adapter, calls, controlDatabase, openRepository, records, targetDirectory };
}

function clusterFixture(targetDirectory, options = {}) {
  const data = fixture(targetDirectory, Buffer.from('REDIS0011-unused-cluster-rdb'));
  const contents = new Map([
    ['redis/cluster/node-a/dump.rdb', Buffer.from('REDIS0011-cluster-node-a')],
    ['redis/cluster/node-b/dump.rdb', Buffer.from('REDIS0011-cluster-node-b')]
  ]);
  const artifact = (artifactPath, bytes) => ({
    kind: 'physical-backup', component: 'rdb', path: artifactPath, filename: 'dump.rdb', mediaType: 'application/x-redis-rdb', sizeBytes: bytes.length,
    contentDigest: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`
  });
  const artifacts = [...contents].map(([artifactPath, bytes]) => artifact(artifactPath, bytes));
  const metadata = {
    version: 1, kind: 'redis-cluster-backup', adapterId: ADAPTER_ID, engine: 'redis', backupMethod: 'physical', backupMode: 'full',
    cluster: {
      topologyFingerprint: `sha256:${'a'.repeat(64)}`, coveredSlots: 16384,
      masters: [
        { nodeId: 'node-a', slots: ['0-8191'], kind: 'redis-rdb', serverVersion: '8.0.0', databases: [{ name: 'db0', keys: 2, expires: 0 }], artifacts: [artifacts[0]] },
        { nodeId: 'node-b', slots: ['8192-16383'], kind: 'redis-rdb', serverVersion: '8.0.0', databases: [{ name: 'db0', keys: 3, expires: 1 }], artifacts: [artifacts[1]] }
      ]
    },
    artifacts
  };
  options.mutateMetadata?.(metadata);
  data.records.recoveryPoint.get('point-redis').consistency = 'crash';
  data.records.source.get('source-redis').physicalExecution = { topology: 'cluster' };
  data.records.artifact = new Map();
  const manifestFiles = [];
  for (const [index, declared] of metadata.artifacts.entries()) {
    const bytes = contents.get(declared.path) || Buffer.from(`unexpected-${index}`);
    const repositoryDigest = crypto.createHmac('sha256', 'repository-test-key').update(bytes).digest('hex');
    data.records.artifact.set(`artifact-${index}`, { id: `artifact-${index}`, recoveryPointId: 'point-redis', repositoryId: 'repository-a', kind: declared.kind, locator: `manifest#${encodeURIComponent(declared.path)}`, sizeBytes: declared.sizeBytes, checksum: { algorithm: 'hmac-sha256', digest: repositoryDigest }, metadata });
    manifestFiles.push({ path: declared.path, type: 'file', sizeBytes: declared.sizeBytes, contentDigest: { algorithm: 'hmac-sha256', digest: repositoryDigest }, metadata: { artifactKind: declared.kind, database: metadata } });
  }
  let repositoryOpens = 0;
  const openedPaths = [];
  const snapshotIds = [];
  data.openRepository = async () => {
    repositoryOpens += 1;
    return {
      masterKey: Buffer.alloc(32),
      engine: {
        openSnapshot: async (_context, request) => { snapshotIds.push(request.snapshotId); return { manifest: { files: manifestFiles } }; },
        streamFile: (_context, request) => (async function* () { openedPaths.push(request.path); yield contents.get(request.path); })()
      }
    };
  };
  let validationCount = 0;
  data.adapter = {
    async planRestore(_context, request) { return { operation: 'redis-isolated-alternate-restore', targetDirectory: request.targetDirectory, metadata: request.metadata }; },
    async executeRestore(context, plan, source) {
      if (options.executeRestore) return options.executeRestore(context, plan, source);
      await fs.mkdir(plan.targetDirectory, { recursive: false });
      for (const declared of plan.metadata.kind === 'redis-rdb' ? [plan.metadata.artifact] : plan.metadata.artifacts) {
        const chunks = [];
        for await (const chunk of await source.open(declared.path)) chunks.push(Buffer.from(chunk));
        await fs.writeFile(path.join(plan.targetDirectory, declared.filename), Buffer.concat(chunks));
      }
      return { status: 'succeeded', targetDirectory: plan.targetDirectory, validation: { valid: true, warnings: [] } };
    },
    async validateRestore() {
      validationCount += 1;
      await options.onValidate?.(validationCount);
      const warnings = options.validationWarnings?.(validationCount) || [];
      return { valid: true, status: warnings.length ? 'warning' : 'succeeded', nativeIntegrityValidation: true, warnings, checks: [{ id: 'keyspace', status: warnings.length ? 'warning' : 'pass' }] };
    }
  };
  return { ...data, contents, metadata, openedPaths, snapshotIds, repositoryOpens: () => repositoryOpens };
}

test('executes a repository-authenticated Redis alternate restore run', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-redis-restore-service-test-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from('REDIS0011-service-rdb');
  const data = fixture(path.join(root, 'restored'), bytes);
  const service = new RedisRestoreService({ controlDatabase: data.controlDatabase, deviceId: DEVICE_ID, adapter: data.adapter, openRepository: data.openRepository, clock: () => '2026-08-04T12:00:00.000Z' });
  const started = await service.start(WORKSPACE_ID, 'actor-a', { recoveryPointId: 'point-redis', targetDirectory: data.targetDirectory, port: 26379, confirmed: true, confirmationText: RESTORE_CONFIRMATIONS.alternate });
  const completed = await service.wait(WORKSPACE_ID, started.id);

  assert.equal(completed.state, 'succeeded');
  assert.equal(completed.validation.nativeIntegrityValidation, true);
  assert.equal(completed.result.bytesRestored, bytes.length);
  assert.deepEqual(completed.result.recoveryTarget, { type: 'isolated-directory', path: data.targetDirectory, serviceRunning: false });
  assert.equal(data.calls[0][0], 'plan');
  assert.equal(data.calls[0][1].confirmation, 'RESTORE_REDIS_ALTERNATE');
  assert.equal(data.calls[1][2].equals(bytes), true);
  assert.equal((await service.list(WORKSPACE_ID)).length, 1);
});

test('streams one complete multipart Redis artifact set from one repository copy', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-redis-multipart-restore-service-test-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const data = fixture(path.join(root, 'restored'), Buffer.from('REDIS0011-unused-rdb'));
  const contents = new Map([
    ['redis/aof/appendonly.aof.1.base.rdb', Buffer.from('REDIS0011-service-base')],
    ['redis/aof/appendonly.aof.1.incr.aof', Buffer.from('service-increment')],
    ['redis/aof/appendonly.aof.manifest', Buffer.from('file appendonly.aof.1.base.rdb seq 1 type b\nfile appendonly.aof.1.incr.aof seq 1 type i\n')]
  ]);
  const components = ['base', 'increment', 'manifest'];
  const metadata = {
    version: 1, kind: 'redis-multipart-aof', adapterId: ADAPTER_ID,
    artifacts: [...contents].map(([artifactPath, bytes], index) => ({ kind: 'physical-backup', component: components[index], filename: path.basename(artifactPath), path: artifactPath, sizeBytes: bytes.length, contentDigest: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}` })),
    consistency: { evidence: { serverVersion: '7.4.2', metadata: { databases: [{ name: 'db0', keys: 2, expires: 0 }] } } }
  };
  const manifestFiles = [];
  data.records.artifact = new Map();
  for (const [index, artifact] of metadata.artifacts.entries()) {
    const bytes = contents.get(artifact.path);
    const repositoryDigest = crypto.createHmac('sha256', 'repository-test-key').update(bytes).digest('hex');
    data.records.artifact.set(`artifact-${index}`, { id: `artifact-${index}`, recoveryPointId: 'point-redis', repositoryId: 'repository-a', kind: 'physical-backup', locator: `manifest#${encodeURIComponent(artifact.path)}`, sizeBytes: bytes.length, checksum: { algorithm: 'hmac-sha256', digest: repositoryDigest }, metadata });
    manifestFiles.push({ path: artifact.path, type: 'file', sizeBytes: bytes.length, contentDigest: { algorithm: 'hmac-sha256', digest: repositoryDigest }, metadata: { artifactKind: 'physical-backup', database: metadata } });
  }
  let repositoryOpens = 0;
  const openRepository = async () => {
    repositoryOpens += 1;
    return { masterKey: Buffer.alloc(32), engine: { openSnapshot: async () => ({ manifest: { files: manifestFiles } }), streamFile: (_context, input) => (async function* () { yield contents.get(input.path); })() } };
  };
  const openedPaths = [];
  const adapter = {
    async planRestore(_context, request) { return { operation: 'redis-isolated-alternate-restore', targetDirectory: request.targetDirectory, metadata: request.metadata }; },
    async executeRestore(_context, plan, source) {
      for (const artifact of plan.metadata.artifacts) {
        const chunks = [];
        for await (const chunk of await source.open(artifact.path)) chunks.push(Buffer.from(chunk));
        assert.equal(Buffer.concat(chunks).equals(contents.get(artifact.path)), true);
        openedPaths.push(artifact.path);
      }
      return { status: 'succeeded', targetDirectory: plan.targetDirectory, validation: { valid: true, warnings: [] } };
    },
    async validateRestore() { return { valid: true, status: 'succeeded', nativeIntegrityValidation: true, warnings: [], checks: [{ id: 'keyspace', status: 'pass' }] }; }
  };
  const service = new RedisRestoreService({ controlDatabase: data.controlDatabase, deviceId: DEVICE_ID, adapter, openRepository });
  const started = await service.start(WORKSPACE_ID, 'actor-a', { recoveryPointId: 'point-redis', targetDirectory: data.targetDirectory, port: 26380, confirmed: true, confirmationText: RESTORE_CONFIRMATIONS.alternate });
  const completed = await service.wait(WORKSPACE_ID, started.id);

  assert.equal(completed.state, 'succeeded');
  assert.equal(completed.result.restoredItems, 3);
  assert.deepEqual(openedPaths, metadata.artifacts.map((artifact) => artifact.path));
  assert.equal(repositoryOpens, 1);
});

test('publishes a complete two-master Redis Cluster recovery bundle from one authenticated snapshot', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-redis-cluster-restore-test-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const targetDirectory = path.join(root, 'cluster-restored');
  const data = clusterFixture(targetDirectory);
  const service = new RedisRestoreService({ controlDatabase: data.controlDatabase, deviceId: DEVICE_ID, adapter: data.adapter, openRepository: data.openRepository });
  const started = await service.start(WORKSPACE_ID, 'actor-a', { recoveryPointId: 'point-redis', targetDirectory, port: 26381, confirmed: true, confirmationText: RESTORE_CONFIRMATIONS.clusterAlternate });
  const completed = await service.wait(WORKSPACE_ID, started.id);

  assert.equal(completed.state, 'succeeded');
  assert.deepEqual(completed.result.recoveryTarget, { type: 'isolated-cluster-directory', path: targetDirectory, serviceRunning: false, masterCount: 2, coveredSlots: 16384 });
  assert.equal(completed.progress.itemsTotal, 2);
  assert.equal(completed.progress.itemsCompleted, 2);
  assert.equal(completed.result.bytesRestored, [...data.contents.values()].reduce((total, bytes) => total + bytes.length, 0));
  assert.equal(data.repositoryOpens(), 1);
  assert.deepEqual(data.snapshotIds, ['snapshot-a']);
  assert.deepEqual(data.openedPaths.sort(), [...data.contents.keys()].sort());
  const topology = JSON.parse(await fs.readFile(path.join(targetDirectory, 'topology.json'), 'utf8'));
  assert.deepEqual(Object.keys(topology).sort(), ['coveredSlots', 'kind', 'masters', 'serviceRunning', 'topologyFingerprint', 'version']);
  assert.equal(topology.serviceRunning, false);
  assert.deepEqual(topology.masters.map((master) => master.nodeId), ['node-a', 'node-b']);
  assert.equal((await fs.readFile(path.join(targetDirectory, 'masters', 'node-a', 'dump.rdb'))).equals(data.contents.get('redis/cluster/node-a/dump.rdb')), true);
  assert.equal((await fs.readFile(path.join(targetDirectory, 'masters', 'node-b', 'dump.rdb'))).equals(data.contents.get('redis/cluster/node-b/dump.rdb')), true);
});

test('requires the exact Redis Cluster alternate-recovery confirmation', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-redis-cluster-confirmation-test-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const data = clusterFixture(path.join(root, 'cluster-restored'));
  const service = new RedisRestoreService({ controlDatabase: data.controlDatabase, deviceId: DEVICE_ID, adapter: data.adapter, openRepository: data.openRepository });
  await assert.rejects(service.start(WORKSPACE_ID, 'actor-a', { recoveryPointId: 'point-redis', targetDirectory: data.targetDirectory, port: 26381, confirmed: true, confirmationText: RESTORE_CONFIRMATIONS.alternate }), (error) => error.code === 'REDIS_RESTORE_CONFIRMATION_REQUIRED');
});

test('projects per-master Redis Cluster validation warnings', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-redis-cluster-warning-test-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const targetDirectory = path.join(root, 'cluster-restored');
  const data = clusterFixture(targetDirectory, { validationWarnings: (count) => count === 2 ? ['One expiring key was absent after native load.'] : [] });
  const service = new RedisRestoreService({ controlDatabase: data.controlDatabase, deviceId: DEVICE_ID, adapter: data.adapter, openRepository: data.openRepository });
  const started = await service.start(WORKSPACE_ID, 'actor-a', { recoveryPointId: 'point-redis', targetDirectory, port: 26381, confirmed: true, confirmationText: RESTORE_CONFIRMATIONS.clusterAlternate });
  const completed = await service.wait(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'warning');
  assert.equal(completed.validation.state, 'warning');
  assert.deepEqual(completed.progress.warnings, ['One expiring key was absent after native load.']);
  assert.deepEqual(completed.result.warnings, ['One expiring key was absent after native load.']);
});

test('refuses a Redis Cluster target beneath a non-directory parent before staging', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-redis-cluster-parent-test-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const parentPath = path.join(root, 'not-a-directory');
  await fs.writeFile(parentPath, 'occupied');
  const targetDirectory = path.join(parentPath, 'cluster-restored');
  const data = clusterFixture(targetDirectory);
  const service = new RedisRestoreService({ controlDatabase: data.controlDatabase, deviceId: DEVICE_ID, adapter: data.adapter, openRepository: data.openRepository });
  const started = await service.start(WORKSPACE_ID, 'actor-a', { recoveryPointId: 'point-redis', targetDirectory, port: 26381, confirmed: true, confirmationText: RESTORE_CONFIRMATIONS.clusterAlternate });
  const completed = await service.wait(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'failed');
  assert.equal(completed.result.error.code, 'REDIS_RESTORE_PARENT_INVALID');
  assert.equal(await fs.lstat(redisRestorePath(targetDirectory, started.id, 'cluster-stage')).catch(() => null), null);
});

test('refuses incomplete, duplicate, and multiply assigned Redis Cluster recovery membership', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-redis-cluster-membership-test-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const cases = [
    ['missing slot', (metadata) => { metadata.cluster.masters[1].slots = ['8192-16382']; }],
    ['duplicate slot', (metadata) => { metadata.cluster.masters[1].slots = ['8191-16383']; }],
    ['duplicate node ID', (metadata) => { metadata.cluster.masters[1].nodeId = 'node-a'; }],
    ['artifact assigned twice', (metadata) => { metadata.cluster.masters[1].artifacts = [metadata.artifacts[0]]; }]
  ];
  for (const [name, mutateMetadata] of cases) {
    const targetDirectory = path.join(root, name.replaceAll(' ', '-'));
    const data = clusterFixture(targetDirectory, { mutateMetadata });
    const service = new RedisRestoreService({ controlDatabase: data.controlDatabase, deviceId: DEVICE_ID, adapter: data.adapter, openRepository: data.openRepository });
    const started = await service.start(WORKSPACE_ID, 'actor-a', { recoveryPointId: 'point-redis', targetDirectory, port: 26381, confirmed: true, confirmationText: RESTORE_CONFIRMATIONS.clusterAlternate });
    const completed = await service.wait(WORKSPACE_ID, started.id);
    assert.equal(completed.state, 'failed', name);
    assert.equal(completed.result.error.code, 'REDIS_CLUSTER_RESTORE_METADATA_INVALID', name);
    assert.equal(await fs.lstat(targetDirectory).catch(() => null), null, name);
  }
});

test('preserves a target created concurrently before Redis Cluster publication', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-redis-cluster-race-test-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const targetDirectory = path.join(root, 'cluster-restored');
  const data = clusterFixture(targetDirectory, { onValidate: async (count) => {
    if (count === 2) {
      await fs.mkdir(targetDirectory);
      await fs.writeFile(path.join(targetDirectory, 'owner.txt'), 'concurrent-owner');
    }
  } });
  const service = new RedisRestoreService({ controlDatabase: data.controlDatabase, deviceId: DEVICE_ID, adapter: data.adapter, openRepository: data.openRepository });
  const started = await service.start(WORKSPACE_ID, 'actor-a', { recoveryPointId: 'point-redis', targetDirectory, port: 26381, confirmed: true, confirmationText: RESTORE_CONFIRMATIONS.clusterAlternate });
  const completed = await service.wait(WORKSPACE_ID, started.id);

  assert.equal(completed.state, 'failed');
  assert.equal(completed.result.error.code, 'REDIS_RESTORE_TARGET_EXISTS');
  assert.equal(await fs.readFile(path.join(targetDirectory, 'owner.txt'), 'utf8'), 'concurrent-owner');
  assert.equal(await fs.lstat(redisRestorePath(targetDirectory, started.id, 'cluster-stage')).catch(() => null), null);
});

test('reports uncertain Redis Cluster publication after claiming a partial target', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-redis-cluster-uncertain-test-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const targetDirectory = path.join(root, 'cluster-restored');
  const data = clusterFixture(targetDirectory);
  let renameCount = 0;
  const fileSystem = {
    lstat: (...args) => fs.lstat(...args), realpath: (...args) => fs.realpath(...args), mkdir: (...args) => fs.mkdir(...args), writeFile: (...args) => fs.writeFile(...args), rm: (...args) => fs.rm(...args),
    rename: async (...args) => {
      renameCount += 1;
      if (renameCount === 2) throw Object.assign(new Error('injected publication failure'), { code: 'EIO' });
      return fs.rename(...args);
    }
  };
  const service = new RedisRestoreService({ controlDatabase: data.controlDatabase, deviceId: DEVICE_ID, adapter: data.adapter, openRepository: data.openRepository, fileSystem });
  const started = await service.start(WORKSPACE_ID, 'actor-a', { recoveryPointId: 'point-redis', targetDirectory, port: 26381, confirmed: true, confirmationText: RESTORE_CONFIRMATIONS.clusterAlternate });
  const completed = await service.wait(WORKSPACE_ID, started.id);

  assert.equal(completed.state, 'failed');
  assert.equal(completed.result.error.code, 'REDIS_RESTORE_PUBLICATION_UNCERTAIN');
  assert.ok(await fs.lstat(path.join(targetDirectory, 'masters')));
  assert.equal(await fs.lstat(path.join(targetDirectory, 'topology.json')).catch(() => null), null);
});

test('cancels Redis Cluster recovery and removes only run-owned staging', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-redis-cluster-cancel-test-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const targetDirectory = path.join(root, 'cluster-restored');
  let enteredResolve;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  const data = clusterFixture(targetDirectory, { executeRestore: async ({ signal }) => {
    enteredResolve();
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('canceled'), { code: 'REDIS_RESTORE_CANCELED', category: 'canceled' })), { once: true }));
  } });
  const service = new RedisRestoreService({ controlDatabase: data.controlDatabase, deviceId: DEVICE_ID, adapter: data.adapter, openRepository: data.openRepository });
  const started = await service.start(WORKSPACE_ID, 'actor-a', { recoveryPointId: 'point-redis', targetDirectory, port: 26381, confirmed: true, confirmationText: RESTORE_CONFIRMATIONS.clusterAlternate });
  await entered;
  const completed = await service.cancel(WORKSPACE_ID, 'actor-a', started.id);

  assert.equal(completed.state, 'canceled');
  assert.equal(await fs.lstat(redisRestorePath(targetDirectory, started.id, 'cluster-stage')).catch(() => null), null);
  assert.equal(await fs.lstat(targetDirectory).catch(() => null), null);
});

test('refuses reopening an authenticated Redis Cluster artifact stream', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-redis-cluster-reopen-test-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const targetDirectory = path.join(root, 'cluster-restored');
  const data = clusterFixture(targetDirectory, { executeRestore: async (_context, plan, source) => {
    const artifactPath = plan.metadata.artifact.path;
    for await (const _chunk of await source.open(artifactPath)) { /* consume authenticated stream */ }
    await source.open(artifactPath);
  } });
  const service = new RedisRestoreService({ controlDatabase: data.controlDatabase, deviceId: DEVICE_ID, adapter: data.adapter, openRepository: data.openRepository });
  const started = await service.start(WORKSPACE_ID, 'actor-a', { recoveryPointId: 'point-redis', targetDirectory, port: 26381, confirmed: true, confirmationText: RESTORE_CONFIRMATIONS.clusterAlternate });
  const completed = await service.wait(WORKSPACE_ID, started.id);
  assert.equal(completed.state, 'failed');
  assert.equal(completed.result.error.code, 'REDIS_RESTORE_ARTIFACT_REOPENED');
});

test('requires exact Redis restore confirmation and an application-consistent point', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-redis-restore-refusal-service-test-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.throws(() => normalizeRequest({ recoveryPointId: 'point', targetDirectory: path.join(root, 'target'), port: 26379, confirmed: false }), (error) => error.code === 'REDIS_RESTORE_CONFIRMATION_REQUIRED');
  const data = fixture(path.join(root, 'target'), Buffer.from('REDIS0011-service-rdb'));
  data.records.recoveryPoint.get('point-redis').consistency = 'crash';
  const service = new RedisRestoreService({ controlDatabase: data.controlDatabase, deviceId: DEVICE_ID, adapter: data.adapter, openRepository: data.openRepository });
  await assert.rejects(service.start(WORKSPACE_ID, 'actor-a', { recoveryPointId: 'point-redis', targetDirectory: data.targetDirectory, port: 26379, confirmed: true, confirmationText: RESTORE_CONFIRMATIONS.alternate }), (error) => error.code === 'REDIS_RECOVERY_POINT_INVALID');
});

test('reconciles exact Redis staging directories without deleting a published target', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-redis-restore-reconcile-test-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const targetDirectory = path.join(root, 'published');
  const data = fixture(targetDirectory, Buffer.from('REDIS0011-service-rdb'));
  const interrupted = { id: 'restore-interrupted', revision: 1, target: { engine: 'redis', targetDirectory }, state: 'running', progress: { phase: 'running' } };
  data.records.restoreRun.set(interrupted.id, interrupted);
  const stage = redisRestorePath(targetDirectory, interrupted.id, 'stage');
  const validate = redisRestorePath(targetDirectory, interrupted.id, 'validate');
  const clusterStage = redisRestorePath(targetDirectory, interrupted.id, 'cluster-stage');
  await fs.mkdir(stage);
  await fs.mkdir(validate);
  await fs.mkdir(clusterStage);
  await fs.mkdir(targetDirectory);
  await fs.writeFile(path.join(targetDirectory, 'dump.rdb'), 'published');
  await fs.writeFile(path.join(targetDirectory, 'topology.json'), '{"serviceRunning":false}');
  const service = new RedisRestoreService({ controlDatabase: data.controlDatabase, deviceId: DEVICE_ID, adapter: data.adapter, openRepository: data.openRepository });
  const [reconciled] = await service.reconcile(WORKSPACE_ID, 'actor-a');

  assert.equal(reconciled.state, 'failed');
  assert.equal(reconciled.progress.phase, 'operator-action-required');
  assert.equal(await fs.lstat(stage).catch(() => null), null);
  assert.equal(await fs.lstat(validate).catch(() => null), null);
  assert.equal(await fs.lstat(clusterStage).catch(() => null), null);
  assert.equal((await fs.readFile(path.join(targetDirectory, 'dump.rdb'), 'utf8')), 'published');
  assert.equal((await fs.readFile(path.join(targetDirectory, 'topology.json'), 'utf8')), '{"serviceRunning":false}');
});

test('registers audited Redis restore IPC and preload APIs', async () => {
  const [mainSource, preloadSource] = await Promise.all([
    fs.readFile(path.join(__dirname, '..', 'main.js'), 'utf8'),
    fs.readFile(path.join(__dirname, '..', 'preload.js'), 'utf8')
  ]);
  assert.match(mainSource, /new RedisRestoreService\(\{ controlDatabase, deviceId: backupDeviceId, adapter: redisAdapter, openRepository \}\)/);
  assert.match(mainSource, /backupRedisRestoreService[.]reconcile/);
  for (const operation of ['list', 'start', 'wait', 'cancel']) assert.equal(mainSource.includes(`ipcMain.handle('backup:redis-restores:${operation}'`), true);
  assert.equal(mainSource.includes("action: 'restore.start-redis-alternate'"), true);
  assert.equal(mainSource.includes("cluster ? REDIS_RESTORE_CONFIRMATIONS.clusterAlternate : REDIS_RESTORE_CONFIRMATIONS.alternate"), true);
  assert.equal(mainSource.includes("action: 'restore.cancel-redis'"), true);
  assert.equal(preloadSource.includes("startBackupRedisRestore: (payload) => ipcRenderer.invoke('backup:redis-restores:start'"), true);
  assert.equal(preloadSource.includes("cancelBackupRedisRestore: (restoreRunId) => ipcRenderer.invoke('backup:redis-restores:cancel'"), true);
});
