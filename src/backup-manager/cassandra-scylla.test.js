const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs/promises');
const path = require('path');
const { DatabaseAdapterRegistry } = require('./database-adapter');
const {
  ADAPTER_ID,
  CassandraScyllaAdapter,
  CassandraScyllaConnectionService,
  cqlshrcContents,
  extractVersion,
  normalizeConfig,
  parseRing,
  parseStatus
} = require('./cassandra-scylla');

const CQL_PASSWORD = 'cql-secret-value';
const HOST_KEY = `SHA256:${'A'.repeat(43)}`;

function outputs(product = 'scylladb') {
  return {
    product,
    productVersion: product === 'scylladb' ? '6.2.1-0.20260804' : '5.0.3',
    nodetoolVersion: product === 'scylladb' ? 'ReleaseVersion: 3.0.8' : 'ReleaseVersion: 5.0.3',
    info: [
      'ID                     : 11111111-1111-1111-1111-111111111111',
      'Gossip active          : true',
      'Native Transport active: true',
      'Cluster Name           : production-ring',
      'Data Center            : dc1',
      'Rack                   : rack1'
    ].join('\n'),
    status: [
      'Datacenter: dc1',
      '================',
      'Status=Up/Down',
      '|/ State=Normal/Leaving/Joining/Moving',
      '--  Address    Load       Tokens  Owns  Host ID                               Rack',
      'UN  10.0.0.1  100 KiB    2       ?     11111111-1111-1111-1111-111111111111  rack1',
      'UN  10.0.0.2  120 KiB    2       ?     22222222-2222-2222-2222-222222222222  rack2',
      '',
      'Datacenter: dc2',
      '================',
      'UN  10.0.1.1  140 KiB    2       ?     33333333-3333-3333-3333-333333333333  rack1'
    ].join('\n'),
    ring: [
      'Datacenter: dc1',
      '==========',
      'Address    Rack   Status State   Load      Owns Token',
      '10.0.0.1   rack1  Up     Normal  100 KiB   ?    -100',
      '10.0.0.1   rack1  Up     Normal  100 KiB   ?    0',
      '10.0.0.2   rack2  Up     Normal  120 KiB   ?    100',
      '10.0.0.2   rack2  Up     Normal  120 KiB   ?    200',
      'Datacenter: dc2',
      '==========',
      '10.0.1.1   rack1  Up     Normal  140 KiB   ?    300',
      '10.0.1.1   rack1  Up     Normal  140 KiB   ?    400'
    ].join('\n'),
    describeCluster: 'Cluster Information:\n  Name: production-ring\n  Partitioner: org.apache.cassandra.dht.Murmur3Partitioner\n  Schema versions:\n    aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa: [10.0.0.1, 10.0.0.2, 10.0.1.1]\n',
    local: JSON.stringify({ cluster_name: 'production-ring', data_center: 'dc1', host_id: '11111111-1111-1111-1111-111111111111', partitioner: 'org.apache.cassandra.dht.Murmur3Partitioner', rack: 'rack1', release_version: '3.0.8', schema_version: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }),
    keyspaces: [
      JSON.stringify({ keyspace_name: 'app', durable_writes: true, replication: { class: 'NetworkTopologyStrategy', dc1: '3', dc2: '2' }, tablets: { enabled: false } }),
      JSON.stringify({ keyspace_name: 'system', durable_writes: true, replication: { class: 'LocalStrategy' } })
    ].join('\n'),
    tables: [
      JSON.stringify({ id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', keyspace_name: 'app', table_name: 'orders' }),
      JSON.stringify({ id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', keyspace_name: 'system', table_name: 'local' })
    ].join('\n'),
    views: JSON.stringify({ id: 'dddddddd-dddd-dddd-dddd-dddddddddddd', keyspace_name: 'app', view_name: 'orders_by_customer', base_table_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' }),
    indexes: JSON.stringify({ keyspace_name: 'app', table_name: 'orders', index_name: 'orders_status_idx', kind: 'COMPOSITES' })
  };
}

function commandDispatcher(state = outputs()) {
  return async ({ executable, args }) => {
    const name = String(executable).replace(/\\/g, '/').split('/').at(-1);
    if (name === 'scylla' && args[0] === '--version') {
      if (state.product !== 'scylladb') throw Object.assign(new Error('missing'), { exitCode: 1 });
      return { stdout: `${state.productVersion}\n`, stderr: '', exitCode: 0 };
    }
    if (name === 'cassandra' && args[0] === '-v') {
      if (state.product !== 'cassandra') throw Object.assign(new Error('missing'), { exitCode: 1 });
      return { stdout: `${state.productVersion}\n`, stderr: '', exitCode: 0 };
    }
    if (name === 'nodetool') {
      if (args[0] === 'version') return { stdout: state.nodetoolVersion, stderr: '', exitCode: 0 };
      if (args[0] === 'info') return { stdout: state.info, stderr: '', exitCode: 0 };
      if (args[0] === 'status') return { stdout: state.status, stderr: '', exitCode: 0 };
      if (args[0] === 'ring') return { stdout: state.ring, stderr: '', exitCode: 0 };
      if (args[0] === 'describecluster') return { stdout: state.describeCluster, stderr: '', exitCode: 0 };
      if (args[0] === 'statusbackup') return { stdout: 'running\n', stderr: '', exitCode: 0 };
      if (args[0] === 'listsnapshots') return { stdout: 'Snapshot Details:\nSnapshot name Keyspace name Column family name\ndx-old app orders\nTotal TrueDiskSpaceUsed: 1 KiB\n', stderr: '', exitCode: 0 };
    }
    if (name === 'cqlsh') {
      if (args[0] === '--version') return { stdout: 'cqlsh 6.2.0\n', stderr: '', exitCode: 0 };
      const statement = args.at(-1);
      if (statement.includes('FROM system.local')) return { stdout: `${state.local}\n(1 rows)\n`, stderr: '', exitCode: 0 };
      if (statement.includes('FROM system_schema.keyspaces')) return { stdout: `${state.keyspaces}\n(2 rows)\n`, stderr: '', exitCode: 0 };
      if (statement.includes('FROM system_schema.tables')) return { stdout: `${state.tables}\n(2 rows)\n`, stderr: '', exitCode: 0 };
      if (statement.includes('FROM system_schema.views')) return { stdout: `${state.views}\n(1 rows)\n`, stderr: '', exitCode: 0 };
      if (statement.includes('FROM system_schema.indexes')) return { stdout: `${state.indexes}\n(1 rows)\n`, stderr: '', exitCode: 0 };
    }
    throw new Error(`Unexpected command: ${name} ${args.join(' ')}`);
  };
}

function config(overrides = {}) {
  return {
    expectedProduct: 'auto',
    executionMode: 'local',
    contactHost: '127.0.0.1',
    nativePort: 9042,
    ...overrides
  };
}

test('normalizes local and SSH execution bindings without accepting inline credentials', () => {
  const local = normalizeConfig(config());
  assert.equal(local.executionMode, 'local');
  assert.equal(local.nodetoolPath, 'nodetool');
  const ssh = normalizeConfig(config({ executionMode: 'ssh', sshConnectionId: 'connection-ssh' }));
  assert.equal(ssh.sshConnectionId, 'connection-ssh');
  assert.throws(() => normalizeConfig(config({ password: CQL_PASSWORD })), /Unknown Cassandra\/Scylla connection field/);
  assert.throws(() => normalizeConfig(config({ cqlUsername: 'backup' })), /both a username and password SecretRef/);
  assert.throws(() => normalizeConfig(config({ executionMode: 'ssh' })), /saved SSH connection/);
});

test('parses supported product versions and rejects unsupported releases', () => {
  assert.equal(extractVersion('Apache Cassandra 5.0.3', 'cassandra').major, 5);
  assert.equal(extractVersion('6.2.1-0.20260804', 'scylladb').minor, 2);
  assert.equal(extractVersion('2026.1.4', 'scylladb').major, 2026);
  assert.throws(() => extractVersion('3.11.18', 'cassandra'), (error) => error.code === 'CASSANDRA_VERSION_UNSUPPORTED');
  assert.throws(() => extractVersion('4.6.0', 'scylladb'), (error) => error.code === 'CASSANDRA_VERSION_UNSUPPORTED');
});

test('parses multi-datacenter nodetool topology and refuses empty output', () => {
  const nodes = parseStatus(outputs().status);
  assert.equal(nodes.length, 3);
  assert.deepEqual([...new Set(nodes.map((node) => node.dataCenter))].sort(), ['dc1', 'dc2']);
  assert.equal(nodes[0].status, 'up');
  assert.equal(nodes[0].state, 'normal');
  assert.throws(() => parseStatus('Datacenter: dc1\n-- Address Load Tokens Owns Host ID Rack'), (error) => error.code === 'CASSANDRA_TOPOLOGY_INVALID');
});

test('parses exact vnode coverage and refuses duplicate or mismatched tokens', () => {
  const state = outputs();
  const nodes = parseStatus(state.status);
  const coverage = parseRing(state.ring, nodes);
  assert.equal(coverage.tokenCount, 6);
  assert.equal(coverage.nodeCoverage.length, 3);
  assert.match(coverage.ringFingerprint, /^sha256:/);
  assert.throws(() => parseRing(state.ring.replace(/\s400$/, '    300'), nodes), (error) => error.code === 'CASSANDRA_RING_TOKEN_DUPLICATE');
  assert.throws(() => parseRing(state.ring.replace(/\n10[.]0[.]1[.]1[^\n]+400$/, ''), nodes), (error) => error.code === 'CASSANDRA_RING_TOKEN_COUNT_MISMATCH');
});

test('discovers ScyllaDB identity, topology, schema objects, snapshots, and incremental state', async () => {
  const adapter = new CassandraScyllaAdapter({ clock: () => '2026-08-04T00:00:00.000Z', now: () => 10 });
  const context = { runNativeCommand: commandDispatcher() };
  const result = await adapter.testConnection(context, config());
  assert.equal(result.status, 'success');
  assert.equal(result.endpointIdentity.product, 'scylladb');
  assert.equal(result.endpointIdentity.clusterName, 'production-ring');
  assert.equal(result.endpointIdentity.nodeCount, 3);
  assert.equal(result.endpointIdentity.incrementalBackupsEnabled, true);
  assert.equal(result.endpointIdentity.schemaAgreement, true);
  assert.match(result.endpointIdentity.deploymentFingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.match(result.endpointIdentity.topologyFingerprint, /^sha256:[0-9a-f]{64}$/);
  const pages = [];
  for await (const page of adapter.discover(context, { connection: config(), kind: 'all' })) pages.push(page);
  assert.equal(pages[0].keyspaces.find((item) => item.name === 'system').system, true);
  assert.equal(pages[0].tables.find((item) => item.name === 'orders').selectable, true);
  assert.equal(pages[0].tables.find((item) => item.name === 'local').selectable, false);
  assert.equal(pages[0].keyspaces.find((item) => item.name === 'app').tabletsEnabled, false);
  assert.equal(pages[0].coverage.tokenCount, 6);
  assert.deepEqual(pages[0].derivedObjects.map((item) => item.kind), ['materialized-view', 'secondary-index']);
  assert.equal(pages[0].derivedObjects.every((item) => item.restoreAction === 'rebuild'), true);
  assert.deepEqual(pages[0].snapshots, ['dx-old']);
});

test('pins product and topology identities and advertises full, incremental, and Cassandra-only native log backup', async () => {
  const adapter = new CassandraScyllaAdapter();
  const context = { runNativeCommand: commandDispatcher() };
  const initial = await adapter.testConnection(context, config());
  const pinned = config({
    expectedProduct: initial.endpointIdentity.product,
    expectedClusterName: initial.endpointIdentity.clusterName,
    expectedDeploymentFingerprint: initial.endpointIdentity.deploymentFingerprint,
    expectedTopologyFingerprint: initial.endpointIdentity.topologyFingerprint
  });
  assert.equal((await adapter.testConnection(context, pinned)).status, 'success');
  const changed = outputs();
  changed.status = changed.status.replace('33333333-3333-3333-3333-333333333333', '44444444-4444-4444-4444-444444444444');
  const topology = await adapter.testConnection({ runNativeCommand: commandDispatcher(changed) }, pinned);
  assert.equal(topology.status, 'failure');
  assert.equal(topology.error.code, 'CASSANDRA_TOPOLOGY_CHANGED');
  const registry = new DatabaseAdapterRegistry([adapter]);
  assert.equal(registry.manifest(ADAPTER_ID).executionReady, true);
  assert.equal(registry.manifest(ADAPTER_ID).sourceEnrollmentReady, true);
  assert.deepEqual(registry.manifest(ADAPTER_ID).capabilities.backupModes, ['full', 'incremental', 'native']);
  assert.equal(registry.manifest(ADAPTER_ID).capabilities.transactionLogs.type, 'cassandra-commit-log');
  assert.deepEqual(registry.manifest(ADAPTER_ID).capabilities.transactionLogs.supportedProducts, ['cassandra']);
  assert.equal(registry.manifest(ADAPTER_ID).capabilities.streaming.backup, true);
  assert.equal(registry.manifest(ADAPTER_ID).capabilities.streaming.restore, true);
  assert.equal(registry.manifest(ADAPTER_ID).capabilities.restore.alternateTarget, true);
  assert.equal(registry.manifest(ADAPTER_ID).capabilities.restore.originalTarget, false);
  const physicalExecution = { engine: 'cassandra-scylla', topology: 'cluster' };
  const source = { id: 'source-a', physicalExecution, consistency: { backupMethod: 'physical', backupMode: 'full' } };
  const consistency = { backupMethod: 'physical', backupMode: 'full', method: 'cassandra-native-snapshot', achievedLevel: 'crash', proven: true };
  const preflight = await adapter.preflight({ preflightCassandraCluster: async () => ({ consistency: [{ method: 'cassandra-native-snapshot', verified: true }] }) }, { source });
  assert.equal(preflight.consistency[0].verified, true);
  const plan = await adapter.planBackup({}, { source, consistency });
  assert.equal(plan.operation, 'cassandra-scylla-native-full');
  assert.equal((await adapter.executeBackup({ executeCassandraClusterBackup: async () => ({ status: 'succeeded' }) }, plan, {})).status, 'succeeded');
  const incrementalPlan = await adapter.planBackup({}, { source, consistency: { ...consistency, backupMode: 'incremental' } });
  assert.equal(incrementalPlan.operation, 'cassandra-scylla-native-incremental');
  const commitLogExecution = { ...physicalExecution, product: 'cassandra', commitLogPitrEnabled: true, nodes: [{ commitLogArchive: { version: 1 } }] };
  const commitLogSource = { ...source, physicalExecution: commitLogExecution };
  const commitLogPlan = await adapter.planBackup({}, { source: commitLogSource, consistency: { ...consistency, backupMode: 'native' } });
  assert.equal(commitLogPlan.operation, 'cassandra-commit-log');
  await assert.rejects(adapter.planBackup({}, { source: { ...commitLogSource, physicalExecution: { ...commitLogExecution, product: 'scylladb' } }, consistency: { ...consistency, backupMode: 'native' } }), (error) => error.code === 'CASSANDRA_COMMIT_LOG_NOT_ENROLLED');
  await assert.rejects(adapter.planRestore(), (error) => error.code === 'CASSANDRA_RESTORE_NOT_READY');
});

function serviceFixture() {
  const connections = new Map();
  const secretRefs = new Map();
  const transientWrites = [];
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
        const record = { ...input, id: 'connection-cassandra', revision: 1 };
        connections.set(record.id, record);
        return record;
      }
    })
  };
  const secretStore = {
    create: async (input) => ({ id: 'sec_cql', workspaceId: input.workspaceId, name: input.name, provider: 'local-safe-storage', scope: input.scope, providerKey: 'cql-key', secretType: input.secretType, version: 1 }),
    resolve: async ({ id }) => id === 'sec_cql' ? CQL_PASSWORD : 'ssh-private-secret',
    markValidated: async () => ({ lastValidatedAt: '2026-08-04T00:00:00.000Z' }),
    delete: async () => {}
  };
  connections.set('connection-ssh', {
    id: 'connection-ssh', workspaceId: 'workspace-a', adapterId: 'deployerx.connection.ssh', revision: 1,
    endpoint: { host: 'db01.example.com', port: 22, username: 'backup', authType: 'password', timeoutMs: 20000 },
    secretRefIds: ['sec_ssh'], trust: { fingerprint: HOST_KEY, algorithm: 'ssh-ed25519' }, workerAffinity: ['device:device-a'], lastTest: { status: 'success' }
  });
  const dispatch = commandDispatcher();
  const sessionFactory = async () => ({
    writeFile: async (remotePath, contents, options) => transientWrites.push({ remotePath, contents, options }),
    run: async (shellCommand) => {
      if (shellCommand.startsWith("'rm' ")) return { stdout: '', stderr: '', exitCode: 0 };
      const quoted = [...shellCommand.matchAll(/'((?:[^']|'\"'\"')*)'/g)].map((match) => match[1].replace(/'\"'\"'/g, "'"));
      return dispatch({ executable: quoted[0], args: quoted.slice(1) });
    },
    close: () => {}
  });
  return { connections, secretRefs, transientWrites, controlDatabase, secretStore, sessionFactory };
}

test('persists CQL authentication only as a SecretRef and discovers through a tested SSH binding', async () => {
  const fixture = serviceFixture();
  const adapter = new CassandraScyllaAdapter({ clock: () => '2026-08-04T00:00:00.000Z', now: () => 0 });
  const service = new CassandraScyllaConnectionService({ ...fixture, deviceId: 'device-a', adapter });
  const created = await service.create('workspace-a', 'actor-a', {
    name: 'Production ring', expectedProduct: 'auto', executionMode: 'ssh', sshConnectionId: 'connection-ssh',
    contactHost: '127.0.0.1', nativePort: 9042, cqlUsername: 'backup_user', cqlPassword: CQL_PASSWORD
  });
  assert.equal(created.adapterId, ADAPTER_ID);
  assert.deepEqual(created.secretRefIds, ['sec_cql']);
  assert.equal(created.endpoint.cqlPassword, undefined);
  assert.equal(JSON.stringify(created).includes(CQL_PASSWORD), false);
  await assert.rejects(service.discover('workspace-a', created.id), /Test the Cassandra\/Scylla connection successfully/);
  const tested = await service.test('workspace-a', created.id, 'actor-a');
  assert.equal(tested.result.status, 'success');
  assert.equal(tested.connection.endpoint.expectedProduct, 'scylladb');
  assert.equal(tested.connection.endpoint.expectedClusterName, 'production-ring');
  assert.match(tested.connection.trust.fingerprint, /^sha256:/);
  assert.equal(tested.connection.clusterInventory.coverage.tokenCount, 6);
  assert.equal(tested.connection.clusterInventory.localHostId, '11111111-1111-1111-1111-111111111111');
  assert.equal(tested.connection.clusterInventory.productVersion, '6.2.1');
  assert.equal(tested.connection.clusterInventory.partitioner, 'org.apache.cassandra.dht.Murmur3Partitioner');
  assert.equal(tested.connection.clusterInventory.derivedObjects.length, 2);
  const discovered = await service.discover('workspace-a', created.id, { kind: 'tables' });
  assert.deepEqual(discovered.items.map((item) => item.name), ['orders', 'local']);
  assert.equal(fixture.transientWrites.length, 2);
  assert.match(fixture.transientWrites[0].remotePath, /^\/tmp\/deployerx-cql-[0-9a-f]{32}[.]rc$/);
  assert.equal(fixture.transientWrites[0].options.mode, 0o600);
  assert.equal(fixture.transientWrites[0].contents, cqlshrcContents('backup_user', CQL_PASSWORD));
  assert.equal(JSON.stringify([...fixture.connections.values()]).includes(CQL_PASSWORD), false);
  assert.equal((await service.list('workspace-a')).find((item) => item.id === created.id).currentDevice, true);
});

test('registers Cassandra/Scylla connection, backup, and audited recovery desktop APIs', async () => {
  const [mainSource, preloadSource] = await Promise.all([
    fs.readFile(path.join(__dirname, '..', 'main.js'), 'utf8'),
    fs.readFile(path.join(__dirname, '..', 'preload.js'), 'utf8')
  ]);
  assert.match(mainSource, /new DatabaseAdapterRegistry\(\[[^\]]*cassandraScyllaAdapter[^\]]*\]\)/);
  assert.match(mainSource, /new CassandraScyllaConnectionService\(\{ controlDatabase, secretStore: getBackupSecretStore\(\), deviceId: backupDeviceId, adapter: cassandraScyllaAdapter \}\)/);
  assert.match(mainSource, /new CassandraScyllaRestoreService\(\{ controlDatabase, secretStore: getBackupSecretStore\(\), snapshotBrowser: backupSnapshotBrowserService, adapter: cassandraScyllaAdapter, deviceId: backupDeviceId \}\)/);
  for (const operation of ['list', 'create', 'test', 'discover']) assert.equal(mainSource.includes(`ipcMain.handle('backup:connections:cassandra-scylla:${operation}'`), true);
  assert.equal(mainSource.includes("action: 'connection.create-cassandra-scylla'"), true);
  assert.equal(mainSource.includes("action: 'connection.test-cassandra-scylla'"), true);
  assert.equal(preloadSource.includes("listBackupCassandraScyllaConnections: () => ipcRenderer.invoke('backup:connections:cassandra-scylla:list')"), true);
  assert.equal(preloadSource.includes("createBackupCassandraScyllaConnection: (payload) => ipcRenderer.invoke('backup:connections:cassandra-scylla:create', payload)"), true);
  assert.equal(preloadSource.includes("testBackupCassandraScyllaConnection: (id) => ipcRenderer.invoke('backup:connections:cassandra-scylla:test', { id })"), true);
  assert.equal(preloadSource.includes("discoverBackupCassandraScyllaResources: (id, kind = 'all') => ipcRenderer.invoke('backup:connections:cassandra-scylla:discover', { id, kind })"), true);
  for (const operation of ['preview', 'list', 'start', 'wait', 'cancel']) assert.equal(mainSource.includes(`ipcMain.handle('backup:cassandra-scylla-restores:${operation}'`), true);
  assert.equal(mainSource.includes("action: 'restore.start-cassandra-scylla'"), true);
  assert.equal(mainSource.includes("action: 'restore.cancel-cassandra-scylla'"), true);
  assert.equal(preloadSource.includes("previewBackupCassandraScyllaRestore: (payload) => ipcRenderer.invoke('backup:cassandra-scylla-restores:preview', payload)"), true);
  assert.equal(preloadSource.includes("startBackupCassandraScyllaRestore: (payload) => ipcRenderer.invoke('backup:cassandra-scylla-restores:start', payload)"), true);
});
