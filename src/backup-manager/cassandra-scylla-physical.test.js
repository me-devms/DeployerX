const assert = require('node:assert/strict');
const crypto = require('crypto');
const test = require('node:test');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { StructuredLogStore } = require('./audit');
const { BackupJobService } = require('./backup-job');
const { BackupControlDatabase } = require('./control-database');
const { DatabaseAdapterRegistry } = require('./database-adapter');
const { CassandraScyllaAdapter } = require('./cassandra-scylla');
const { normalizeCommitLogArchiveEnrollment } = require('./cassandra-commit-log');
const {
  ARCHIVE_MAGIC,
  CassandraScyllaPhysicalBackupService,
  parseSnapshotFileListing,
  snapshotTag,
  validateSstableMembership
} = require('./cassandra-scylla-physical');
const { CassandraScyllaSourceReaderService } = require('./cassandra-scylla-source-reader');
const { LocalFolderRepositoryAdapter, ADAPTER_ID: LOCAL_REPOSITORY_ADAPTER_ID } = require('./local-repository');
const { ManualBackupService } = require('./manual-backup');
const { ENGINE_ID, ENGINE_VERSION, FileRepositoryEngine, REPOSITORY_FORMAT_VERSION } = require('./repository-engine');
const { RunCheckpointStore } = require('./run-checkpoint');

const HOSTS = ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'];
const TABLE_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function discovery(hostId, incrementalBackupsEnabled = false) {
  const nodeCoverage = HOSTS.map((id, index) => ({ hostId: id, address: `10.0.0.${index + 1}`, dataCenter: 'dc1', rack: `rack${index + 1}`, tokenCount: 2, tokenDigest: `sha256:tokens-${index + 1}` }));
  return {
    nextCursor: null, product: 'cassandra', clusterName: 'production-ring', deploymentFingerprint: `sha256:node-${HOSTS.indexOf(hostId) + 1}`,
    clusterFingerprint: 'sha256:cluster', topologyFingerprint: 'sha256:topology',
    identity: { product: 'cassandra', version: { text: '5.0.3' }, clusterName: 'production-ring', partitioner: 'org.apache.cassandra.dht.Murmur3Partitioner', schemaVersion: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', schemaVersions: ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'], schemaAgreement: true, localHostId: hostId, incrementalBackupsEnabled, nativeTransportActive: true, gossipActive: true },
    topology: HOSTS.map((id, index) => ({ hostId: id, address: `10.0.0.${index + 1}`, dataCenter: 'dc1', rack: `rack${index + 1}`, status: 'up', state: 'normal', tokens: 2 })),
    coverage: { mode: 'vnode-ring', tokenCount: 4, ringFingerprint: 'sha256:ring', nodeCoverage },
    keyspaces: [{ kind: 'keyspace', name: 'app', durableWrites: true, replication: { class: 'NetworkTopologyStrategy', dc1: '2' }, tabletsEnabled: false, system: false }],
    tables: [{ kind: 'table', keyspace: 'app', name: 'orders', tableId: TABLE_ID, system: false, selectable: true }],
    derivedObjects: [{ kind: 'secondary-index', keyspace: 'app', name: 'orders_status_idx', table: 'orders', restoreAction: 'rebuild' }], snapshots: []
  };
}

function connection(hostId, index) {
  return {
    id: `connection-${index + 1}`, workspaceId: 'workspace-a', name: `Node ${index + 1}`, kind: 'database', adapterId: 'deployerx.database.cassandra-scylla', adapterVersion: '0.1.0', revision: 4,
    endpoint: { expectedProduct: 'cassandra', executionMode: 'ssh', sshConnectionId: `ssh-${index + 1}`, contactHost: '127.0.0.1', nativePort: 9042, nodetoolPath: 'nodetool', cqlshPath: 'cqlsh', cassandraPath: 'cassandra', scyllaPath: 'scylla', timeoutMs: 30000, expectedClusterName: 'production-ring', expectedDeploymentFingerprint: `sha256:node-${index + 1}`, expectedTopologyFingerprint: 'sha256:topology' },
    secretRefIds: [], workerAffinity: ['device:device-a'], trust: { fingerprint: `sha256:node-${index + 1}`, topologyFingerprint: 'sha256:topology' },
    lastTest: { status: 'success', endpointIdentity: { clusterFingerprint: 'sha256:cluster' } },
    clusterInventory: { product: 'cassandra', productVersion: '5.0.3', partitioner: 'org.apache.cassandra.dht.Murmur3Partitioner', localHostId: hostId, clusterFingerprint: 'sha256:cluster', topologyFingerprint: 'sha256:topology', schemaVersion: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', coverage: { ringFingerprint: 'sha256:ring' } }
  };
}

function source(connections, options = {}) {
  return {
    id: 'source-a', name: 'Production Cassandra', revision: 3, enabled: true, sourceType: 'database', adapterId: 'deployerx.database.cassandra-scylla', connectionId: connections[0].id,
    selector: { kind: 'database-objects', digest: 'selector-digest', allDatabases: false, databases: { include: [{ name: 'app' }], exclude: [] }, schemas: { include: [], exclude: [] }, tables: { include: [{ database: 'app', schema: 'app', name: 'orders' }], exclude: [] }, includeGlobalObjects: false },
    consistency: { requestedLevel: 'crash', method: 'cassandra-native-snapshot', backupMethod: 'physical', backupMode: 'full', captureCoordinates: true, allowDowngrade: false },
    physicalExecution: {
      version: 1, engine: 'cassandra-scylla', topology: 'cluster', product: 'cassandra', productVersion: '5.0.3', partitioner: 'org.apache.cassandra.dht.Murmur3Partitioner', clusterName: 'production-ring', clusterFingerprint: 'sha256:cluster', topologyFingerprint: 'sha256:topology', ringFingerprint: 'sha256:ring', schemaVersion: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', coverageMode: 'vnode-ring', tokenCount: 4, selectionFingerprint: 'selection-fingerprint',
      keyspaces: [{ name: 'app', durableWrites: true, replication: { class: 'NetworkTopologyStrategy', dc1: '2' }, tabletsEnabled: false }],
      tables: [{ database: 'app', schema: 'app', name: 'orders', tableId: TABLE_ID }], rebuildObjects: [{ kind: 'secondary-index', keyspace: 'app', name: 'orders_status_idx', table: 'orders', restoreAction: 'rebuild' }],
      incrementalBackupsEnabled: options.incrementalEnabled === true,
      commitLogPitrEnabled: options.commitLogEnabled === true,
      nodes: connections.map((item, index) => ({
        hostId: HOSTS[index], connectionId: item.id, connectionRevision: item.revision, address: `10.0.0.${index + 1}`, dataCenter: 'dc1', rack: `rack${index + 1}`, tokenCount: 2, tokenDigest: `sha256:tokens-${index + 1}`, serverIdentityFingerprint: item.trust.fingerprint, inventoryFingerprint: `sha256:inventory-${index + 1}`, incrementalBackupsEnabled: options.incrementalEnabled === true, dataDirectories: ['/var/lib/cassandra/data'],
        commitLogArchive: options.commitLogEnabled ? normalizeCommitLogArchiveEnrollment({ directory: '/var/lib/cassandra/commitlog-archive', propertiesPath: '/etc/cassandra/commitlog_archiving.properties', archiveCommand: 'test ! -e /var/lib/cassandra/commitlog-archive/%name && cp -- %path /var/lib/cassandra/commitlog-archive/%name', ownershipMarker: `workspace-a:${HOSTS[index]}`, precision: 'MICROSECONDS', maximumClockSkewSeconds: 5 }) : null
      }))
    }
  };
}

class FakeRuntime {
  constructor(hostId, options = {}) {
    this.hostId = hostId;
    this.options = options;
    this.tags = new Set();
    this.closed = false;
    this.contents = new Map();
    this.modifiedTimes = new Map();
    this.signal = null;
    this.streamStarted = null;
    this.resolveStreamStarted = null;
  }

  snapshotDirectory(tag) { return `/var/lib/cassandra/data/app/orders-${TABLE_ID.replace(/-/g, '')}/snapshots/${tag}`; }
  backupDirectory() { return `/var/lib/cassandra/data/app/orders-${TABLE_ID.replace(/-/g, '')}/backups`; }
  commitLogDirectory() { return '/var/lib/cassandra/commitlog-archive'; }
  commitLogPropertiesPath() { return '/etc/cassandra/commitlog_archiving.properties'; }
  commitLogMarkerPath() { return `${this.commitLogDirectory()}/.deployerx-owner`; }

  enableCommitLogArchive() {
    this.contents.set(this.commitLogMarkerPath(), Buffer.from(`workspace-a:${this.hostId}\n`));
    this.contents.set(this.commitLogPropertiesPath(), Buffer.from(`archive_command=test ! -e ${this.commitLogDirectory()}/%name && cp -- %path ${this.commitLogDirectory()}/%name\nrestore_command=\nrestore_directories=\nrestore_point_in_time=\nprecision=MICROSECONDS\n`));
  }

  addCommitLog(id, modifiedAt, suffix = this.hostId.slice(0, 8)) {
    const file = `${this.commitLogDirectory()}/CommitLog-7-${id}.log`;
    this.contents.set(file, Buffer.from(`commit-log-${id}-${suffix}`));
    this.modifiedTimes.set(file, modifiedAt);
  }

  addIncremental(descriptor, suffix = this.hostId.slice(0, 8)) {
    const directory = this.backupDirectory();
    this.contents.set(`${directory}/${descriptor}-Data.db`, Buffer.from(`incremental-data-${descriptor}-${suffix}`));
    this.contents.set(`${directory}/${descriptor}-Statistics.db`, Buffer.from(`incremental-stats-${descriptor}-${suffix}`));
    this.contents.set(`${directory}/${descriptor}-TOC.txt`, Buffer.from('Data.db\nStatistics.db\nTOC.txt\n'));
  }

  populate(tag) {
    const directory = this.snapshotDirectory(tag);
    this.contents.set(`${directory}/nb-1-big-Data.db`, Buffer.from(`data-${this.hostId}`));
    this.contents.set(`${directory}/nb-1-big-Statistics.db`, Buffer.from(`stats-${this.hostId}`));
    this.contents.set(`${directory}/nb-1-big-TOC.txt`, Buffer.from('Data.db\nStatistics.db\nTOC.txt\n'));
  }

  async run(executable, args) {
    if (executable === 'identity') return { stdout: this.options.driftAfterSnapshot && this.tags.size ? HOSTS.find((item) => item !== this.hostId) : this.hostId, stderr: '', exitCode: 0 };
    if (executable === 'test') {
      const target = args.at(-1);
      if (target === '/var/lib/cassandra/data' || (target === this.commitLogDirectory() && this.contents.has(this.commitLogMarkerPath())) || this.contents.has(target) || [...this.tags].some((tag) => target === this.snapshotDirectory(tag)) || (target === this.backupDirectory() && [...this.contents.keys()].some((name) => path.posix.dirname(name) === target))) return { stdout: '', stderr: '', exitCode: 0 };
      throw Object.assign(new Error('missing'), { code: 'TEST_MISSING' });
    }
    if (executable === 'cqlsh') return { stdout: 'CREATE KEYSPACE app WITH replication = {};\nCREATE TABLE app.orders (id uuid PRIMARY KEY);\n', stderr: '', exitCode: 0 };
    if (executable === 'nodetool' && args[0] === 'snapshot') {
      if (this.options.failSnapshot) throw new Error('snapshot failed');
      const tag = args[args.indexOf('-t') + 1]; this.tags.add(tag); this.populate(tag);
      return { stdout: 'Snapshot directory created', stderr: '', exitCode: 0 };
    }
    if (executable === 'nodetool' && args[0] === 'clearsnapshot') {
      if (this.options.failCleanup) throw new Error('cleanup failed');
      this.tags.delete(args[args.indexOf('-t') + 1]); return { stdout: '', stderr: '', exitCode: 0 };
    }
    if (executable === 'nodetool' && args[0] === 'listsnapshots') return { stdout: [...this.tags].map((tag) => `${tag} app orders`).join('\n'), stderr: '', exitCode: 0 };
    if (executable === 'nodetool' && args[0] === 'netstats') return { stdout: this.options.activeStreaming ? 'Mode: NORMAL\nReceiving 1 files, 100 bytes total\n' : 'Mode: NORMAL\nNot sending any streams.\n', stderr: '', exitCode: 0 };
    if (executable === 'find') {
      const directory = args[0];
      if (args.includes('!')) return { stdout: '', stderr: '', exitCode: 0 };
      const files = [...this.contents.entries()].filter(([name]) => path.posix.dirname(name) === directory);
      return { stdout: files.map(([name, bytes]) => `${bytes.length}\0${Date.parse(this.modifiedTimes.get(name) || '2026-08-04T00:00:00.000Z') / 1000}.0\0${path.posix.basename(name)}\0`).join(''), stderr: '', exitCode: 0 };
    }
    if (executable === 'cat') return { stdout: this.contents.get(args.at(-1)).toString('utf8'), stderr: '', exitCode: 0 };
    if (executable === 'sha256sum') {
      const bytes = this.contents.get(args.at(-1));
      return { stdout: `${crypto.createHash('sha256').update(bytes).digest('hex')}  ${args.at(-1)}\0`, stderr: '', exitCode: 0 };
    }
    if (executable === 'date') return { stdout: `${this.options.clock()}\n`, stderr: '', exitCode: 0 };
    if (executable === 'rm') return { stdout: '', stderr: '', exitCode: 0 };
    throw new Error(`Unexpected command ${executable} ${args.join(' ')}`);
  }

  async stream(executable, args) {
    assert.equal(executable, 'cat');
    const bytes = this.contents.get(args.at(-1));
    const runtime = this;
    return {
      stdout: (async function* chunks() {
        runtime.resolveStreamStarted?.();
        if (runtime.options.blockStream && !runtime.signal?.aborted) await new Promise((resolve) => runtime.signal?.addEventListener('abort', resolve, { once: true }));
        if (runtime.signal?.aborted) throw new Error('stream canceled');
        yield bytes;
      })(),
      completion: Promise.resolve({ exitCode: 0, stderr: '' }), close() {}
    };
  }

  async writeFile() {}
  close() { this.closed = true; }
}

function fixture(options = {}) {
  const connections = HOSTS.map(connection);
  let currentTime = options.currentTime || '2026-08-04T00:00:00.000Z';
  const runtimes = new Map(connections.map((item, index) => [item.id, new FakeRuntime(HOSTS[index], { ...(options[index] || {}), clock: () => currentTime })]));
  const incrementalEnabled = HOSTS.every((_host, index) => options[index]?.incrementalEnabled === true);
  const commitLogEnabled = options.commitLogEnabled === true;
  if (commitLogEnabled) for (const runtime of runtimes.values()) runtime.enableCommitLogArchive();
  const sourceRecord = source(connections, { incrementalEnabled, commitLogEnabled });
  const artifacts = [];
  const recoveryPoints = [];
  const repositories = {
    connection: { get: async (_workspaceId, id) => connections.find((item) => item.id === id) || null },
    source: { get: async (_workspaceId, id) => id === sourceRecord.id ? sourceRecord : null },
    artifact: { list: async () => artifacts },
    recoveryPoint: { list: async () => recoveryPoints }
  };
  const controlDatabase = { repository: (name) => repositories[name] };
  const adapter = new CassandraScyllaAdapter();
  adapter.discover = async function* fakeDiscover(context) {
    const identity = await context.runNativeCommand({ executable: 'identity', args: [], timeoutMs: 1000 });
    const runtime = [...runtimes.values()].find((item) => item.hostId === identity.stdout);
    yield discovery(identity.stdout, runtime?.options.incrementalEnabled === true);
  };
  const runtimeFactory = { open: async (_workspaceId, item, signal) => { const runtime = runtimes.get(item.id); runtime.signal = signal; return runtime; } };
  const secretStore = { resolve: async () => 'unused' };
  const service = new CassandraScyllaPhysicalBackupService({ controlDatabase, secretStore, deviceId: 'device-a', adapter, runtimeFactory, clock: () => currentTime });
  const plan = { source: sourceRecord, connection: connections[0], manifest: { adapterVersion: '0.1.0' } };
  return { artifacts, connections, controlDatabase, recoveryPoints, sourceRecord, runtimes, secretStore, adapter, service, plan, setClock: (value) => { currentTime = value; } };
}

async function consumePrepared(prepared) {
  for (const artifact of prepared.artifacts) for await (const _chunk of artifact.content()) {}
}

function recoveryPoint(id, type = 'full', parentRecoveryPointId = null, chainRootId = id, jobId = 'job-incremental') {
  return { id, type, sourceId: 'source-a', jobId, parentRecoveryPointId, chainRootId, verification: { state: 'succeeded' }, retention: { deletionEligible: false }, repositoryCopies: [{ repositoryId: 'repo-a', state: 'available' }] };
}

test('validates snapshot listings, deterministic tags, and complete SSTable TOCs', async () => {
  const listed = parseSnapshotFileListing(['4', '1722816000.0', 'nb-1-big-Data.db', ''].join('\0'), '/data/snapshot', 'node/table');
  assert.equal(listed[0].archivePath, 'node/table/nb-1-big-Data.db');
  assert.equal(snapshotTag('owner', HOSTS[0], 'app', 'orders'), snapshotTag('owner', HOSTS[0], 'app', 'orders'));
  const files = ['Data.db', 'Statistics.db', 'TOC.txt'].map((suffix) => ({ name: `nb-1-big-${suffix}`, sourcePath: `/snapshot/nb-1-big-${suffix}` }));
  await validateSstableMembership(files, async () => 'Data.db\nStatistics.db\nTOC.txt\n');
  await assert.rejects(validateSstableMembership(files.slice(1), async () => 'Data.db\nStatistics.db\nTOC.txt\n'), /missing required components/i);
});

test('preflights every node, snapshots exact tables, streams immutable node archives, and clears owned tags', async () => {
  const data = fixture();
  const leases = [];
  const prepared = await data.service.prepare('workspace-a', 'run-a', data.plan, { backupMode: 'full', jobId: 'job-a', onSourceLease: async (lease) => leases.push(lease) });
  assert.equal(prepared.databaseManifest.nodes.length, 2);
  assert.equal(prepared.databaseManifest.artifacts.length, 4);
  assert.equal(prepared.databaseManifest.cluster.version, '5.0.3');
  assert.equal(prepared.databaseManifest.cluster.partitioner, 'org.apache.cassandra.dht.Murmur3Partitioner');
  assert.equal(prepared.databaseManifest.schema.scope, 'selected-keyspaces');
  assert.equal(prepared.databaseManifest.schema.selectionDigest, 'selection-fingerprint');
  assert.equal(prepared.databaseManifest.nodes.every((node) => node.fileCount === 3), true);
  for (const artifact of prepared.artifacts) {
    const chunks = [];
    for await (const chunk of artifact.content()) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    assert.equal(bytes.length > 0, true);
    if (HOSTS.includes(artifact.componentId)) assert.equal(bytes.subarray(0, ARCHIVE_MAGIC.length).equals(ARCHIVE_MAGIC), true);
  }
  assert.equal(prepared.databaseManifest.publication.state, 'sealed');
  assert.equal(prepared.databaseManifest.cleanup.state, 'pending-publication');
  assert.equal(leases.some((lease) => lease.state === 'active' && lease.nodes.every((node) => node.tags.length === 1)), true);
  await data.service.release(prepared);
  assert.equal([...data.runtimes.values()].every((runtime) => runtime.tags.size === 0 && runtime.closed), true);
  assert.equal(leases.at(-1).state, 'released');
});

test('captures a full incremental cursor, advances it with only new complete SSTable sets, and reports no change', async () => {
  const data = fixture({ 0: { incrementalEnabled: true }, 1: { incrementalEnabled: true } });
  for (const runtime of data.runtimes.values()) runtime.addIncremental('nb-1-big');
  const baseline = await data.service.prepare('workspace-a', 'run-baseline', data.plan, { backupMode: 'full', requestedBackupMode: 'incremental', jobId: 'job-incremental' });
  await consumePrepared(baseline);
  assert.equal(baseline.databaseManifest.incremental.baseline, true);
  assert.equal(baseline.databaseManifest.incremental.currentSetCount, 2);
  const baselinePoint = recoveryPoint('rp-baseline');
  data.recoveryPoints.push(baselinePoint);
  data.artifacts.push({ recoveryPointId: baselinePoint.id, kind: 'metadata', metadata: structuredClone(baseline.databaseManifest) });
  await data.service.release(baseline);

  for (const runtime of data.runtimes.values()) runtime.addIncremental('nb-2-big');
  const incremental = await data.service.prepare('workspace-a', 'run-incremental', data.plan, { backupMode: 'incremental', requestedBackupMode: 'incremental', jobId: 'job-incremental', previousRecoveryPoint: baselinePoint });
  assert.equal(incremental.databaseManifest.kind, 'cassandra-scylla-native-incremental');
  assert.equal(incremental.databaseManifest.incremental.previousSetCount, 2);
  assert.equal(incremental.databaseManifest.incremental.currentSetCount, 4);
  assert.equal(incremental.databaseManifest.incremental.newSetCount, 2);
  assert.equal(incremental.databaseManifest.nodes.every((node) => node.files.every((file) => file.descriptor === 'nb-2-big')), true);
  await consumePrepared(incremental);
  const incrementalPoint = recoveryPoint('rp-incremental', 'incremental', baselinePoint.id, baselinePoint.id);
  data.recoveryPoints.push(incrementalPoint);
  data.artifacts.push({ recoveryPointId: incrementalPoint.id, kind: 'metadata', metadata: structuredClone(incremental.databaseManifest) });
  await data.service.release(incremental);
  assert.equal([...data.runtimes.values()].every((runtime) => [...runtime.contents.keys()].some((name) => name.includes('/backups/nb-1-big-Data.db')) && [...runtime.contents.keys()].some((name) => name.includes('/backups/nb-2-big-Data.db'))), true);

  const noChange = await data.service.prepare('workspace-a', 'run-no-change', data.plan, { backupMode: 'incremental', requestedBackupMode: 'incremental', jobId: 'job-incremental', previousRecoveryPoint: incrementalPoint });
  assert.equal(noChange.databaseManifest.noChange, true);
  assert.equal(noChange.databaseManifest.incremental.newSetCount, 0);
  await data.service.release(noChange);
});

test('refuses an incremental chain with missing prior media, changed prior media, or a new SSTable format', async () => {
  const prepareBaseline = async () => {
    const data = fixture({ 0: { incrementalEnabled: true }, 1: { incrementalEnabled: true } });
    for (const runtime of data.runtimes.values()) runtime.addIncremental('nb-1-big');
    const baseline = await data.service.prepare('workspace-a', `run-baseline-${Math.random()}`, data.plan, { backupMode: 'full', requestedBackupMode: 'incremental', jobId: 'job-incremental' });
    await consumePrepared(baseline);
    const point = recoveryPoint(`rp-${Math.random()}`);
    data.recoveryPoints.push(point);
    data.artifacts.push({ recoveryPointId: point.id, kind: 'metadata', metadata: structuredClone(baseline.databaseManifest) });
    await data.service.release(baseline);
    return { data, point };
  };

  const missing = await prepareBaseline();
  missing.data.runtimes.get(missing.data.connections[0].id).contents.delete(`${missing.data.runtimes.get(missing.data.connections[0].id).backupDirectory()}/nb-1-big-Data.db`);
  await assert.rejects(missing.data.service.prepare('workspace-a', 'run-gap', missing.data.plan, { backupMode: 'incremental', requestedBackupMode: 'incremental', jobId: 'job-incremental', previousRecoveryPoint: missing.point }), /missing required components|missing.*chain cannot advance/i);

  const changed = await prepareBaseline();
  const changedRuntime = changed.data.runtimes.get(changed.data.connections[0].id);
  changedRuntime.contents.set(`${changedRuntime.backupDirectory()}/nb-1-big-Data.db`, Buffer.from('mutated-prior-media'));
  await assert.rejects(changed.data.service.prepare('workspace-a', 'run-changed-prior', changed.data.plan, { backupMode: 'incremental', requestedBackupMode: 'incremental', jobId: 'job-incremental', previousRecoveryPoint: changed.point }), /previously recorded.*changed/i);

  const format = await prepareBaseline();
  for (const runtime of format.data.runtimes.values()) runtime.addIncremental('mc-2-big');
  await assert.rejects(format.data.service.prepare('workspace-a', 'run-format-change', format.data.plan, { backupMode: 'incremental', requestedBackupMode: 'incremental', jobId: 'job-incremental', previousRecoveryPoint: format.point }), /format changed.*full baseline/i);
});

test('refuses incremental baselines when native incrementals are disabled or node streaming is active', async () => {
  const disabled = fixture();
  await assert.rejects(disabled.service.prepare('workspace-a', 'run-disabled', disabled.plan, { backupMode: 'full', requestedBackupMode: 'incremental', jobId: 'job-incremental' }), /incremental backups are not enabled/i);
  const streaming = fixture({ 0: { incrementalEnabled: true, activeStreaming: true }, 1: { incrementalEnabled: true } });
  await assert.rejects(streaming.service.prepare('workspace-a', 'run-streaming', streaming.plan, { backupMode: 'full', requestedBackupMode: 'incremental', jobId: 'job-incremental' }), /not in idle normal streaming state/i);
});

test('captures a Cassandra full anchor, advances only completed commit-log segments, and suppresses no-change points', async () => {
  const data = fixture({ commitLogEnabled: true });
  for (const runtime of data.runtimes.values()) runtime.addCommitLog('1000', '2026-08-03T23:59:59.000Z');
  const baseline = await data.service.prepare('workspace-a', 'run-log-baseline', data.plan, { backupMode: 'full', requestedBackupMode: 'native', jobId: 'job-native' });
  await consumePrepared(baseline);
  assert.equal(baseline.databaseManifest.kind, 'cassandra-scylla-native-full');
  assert.equal(baseline.databaseManifest.commitLog.baseline, true);
  assert.equal(baseline.databaseManifest.commitLog.currentSegmentCount, 2);
  assert.equal(baseline.databaseManifest.commitLog.recoveryWindow.latest, '2026-08-04T00:00:00.000Z');
  const baselinePoint = recoveryPoint('rp-log-baseline', 'full', null, 'rp-log-baseline', 'job-native');
  data.recoveryPoints.push(baselinePoint);
  data.artifacts.push({ recoveryPointId: baselinePoint.id, kind: 'metadata', metadata: structuredClone(baseline.databaseManifest) });
  await data.service.release(baseline);

  data.setClock('2026-08-04T00:00:20.000Z');
  let index = 0;
  for (const runtime of data.runtimes.values()) runtime.addCommitLog(String(2000 + index++), `2026-08-04T00:00:${index === 1 ? '10' : '11'}.000Z`);
  const logs = await data.service.prepare('workspace-a', 'run-log-delta', data.plan, { backupMode: 'native', requestedBackupMode: 'native', jobId: 'job-native', previousRecoveryPoint: baselinePoint, repositoryIds: ['repo-a'] });
  assert.equal(logs.databaseManifest.kind, 'cassandra-commit-log');
  assert.equal(logs.databaseManifest.noChange, false);
  assert.equal(logs.databaseManifest.commitLog.newSegmentCount, 2);
  assert.equal(logs.databaseManifest.commitLog.recoveryWindow.latest, '2026-08-04T00:00:10.000Z');
  assert.equal(logs.artifacts.filter((artifact) => artifact.artifactKind === 'transaction-log').length, 2);
  await consumePrepared(logs);
  const logPoint = recoveryPoint('rp-log-delta', 'log', baselinePoint.id, baselinePoint.id, 'job-native');
  data.recoveryPoints.push(logPoint);
  data.artifacts.push({ recoveryPointId: logPoint.id, kind: 'metadata', metadata: structuredClone(logs.databaseManifest) });
  await data.service.release(logs);
  assert.equal([...data.runtimes.values()].every((runtime) => [...runtime.contents.keys()].some((name) => name.endsWith('CommitLog-7-1000.log'))), true);

  data.setClock('2026-08-04T00:00:30.000Z');
  const noChange = await data.service.prepare('workspace-a', 'run-log-no-change', data.plan, { backupMode: 'native', requestedBackupMode: 'native', jobId: 'job-native', previousRecoveryPoint: logPoint, repositoryIds: ['repo-a'] });
  assert.equal(noChange.databaseManifest.noChange, true);
  assert.equal(noChange.databaseManifest.commitLog.newSegmentCount, 0);
  assert.deepEqual(noChange.artifacts.map((artifact) => artifact.componentId), ['cluster-manifest']);
  await data.service.release(noChange);
});

test('refuses Cassandra commit-log gaps, rewrites, archive-control drift, and excessive clock skew', async () => {
  const prepareBaseline = async () => {
    const data = fixture({ commitLogEnabled: true });
    for (const runtime of data.runtimes.values()) runtime.addCommitLog('1000', '2026-08-03T23:59:59.000Z');
    const baseline = await data.service.prepare('workspace-a', `run-log-baseline-${Math.random()}`, data.plan, { backupMode: 'full', requestedBackupMode: 'native', jobId: 'job-native' });
    await consumePrepared(baseline);
    const point = recoveryPoint(`rp-log-${Math.random()}`, 'full', null, undefined, 'job-native');
    point.chainRootId = point.id;
    data.recoveryPoints.push(point);
    data.artifacts.push({ recoveryPointId: point.id, kind: 'metadata', metadata: structuredClone(baseline.databaseManifest) });
    await data.service.release(baseline);
    data.setClock('2026-08-04T00:00:20.000Z');
    return { data, point };
  };

  const missing = await prepareBaseline();
  missing.data.runtimes.get(missing.data.connections[0].id).contents.delete(`${missing.data.runtimes.get(missing.data.connections[0].id).commitLogDirectory()}/CommitLog-7-1000.log`);
  await assert.rejects(missing.data.service.prepare('workspace-a', 'run-log-gap', missing.data.plan, { backupMode: 'native', requestedBackupMode: 'native', jobId: 'job-native', previousRecoveryPoint: missing.point, repositoryIds: ['repo-a'] }), /previously recorded.*missing/i);

  const rewritten = await prepareBaseline();
  const rewrittenRuntime = rewritten.data.runtimes.get(rewritten.data.connections[0].id);
  rewrittenRuntime.contents.set(`${rewrittenRuntime.commitLogDirectory()}/CommitLog-7-1000.log`, Buffer.from('rewritten'));
  await assert.rejects(rewritten.data.service.prepare('workspace-a', 'run-log-rewrite', rewritten.data.plan, { backupMode: 'native', requestedBackupMode: 'native', jobId: 'job-native', previousRecoveryPoint: rewritten.point, repositoryIds: ['repo-a'] }), /previously recorded.*changed/i);

  const configuration = await prepareBaseline();
  const configurationRuntime = configuration.data.runtimes.get(configuration.data.connections[0].id);
  configurationRuntime.contents.set(configurationRuntime.commitLogPropertiesPath(), Buffer.from('archive_command=cp -- %path /other/%name\nprecision=MICROSECONDS\n'));
  await assert.rejects(configuration.data.service.prepare('workspace-a', 'run-log-config', configuration.data.plan, { backupMode: 'native', requestedBackupMode: 'native', jobId: 'job-native', previousRecoveryPoint: configuration.point, repositoryIds: ['repo-a'] }), /archive command does not match/i);

  const skew = await prepareBaseline();
  skew.data.runtimes.get(skew.data.connections[0].id).options.clock = () => '2026-08-04T00:01:20.000Z';
  await assert.rejects(skew.data.service.prepare('workspace-a', 'run-log-skew', skew.data.plan, { backupMode: 'native', requestedBackupMode: 'native', jobId: 'job-native', previousRecoveryPoint: skew.point, repositoryIds: ['repo-a'] }), /clock exceeds.*skew limit/i);
});

test('commit-log cancellation closes transfer without deleting operator archive media', async () => {
  const data = fixture({ commitLogEnabled: true });
  for (const runtime of data.runtimes.values()) runtime.addCommitLog('1000', '2026-08-03T23:59:59.000Z');
  const baseline = await data.service.prepare('workspace-a', 'run-log-cancel-baseline', data.plan, { backupMode: 'full', requestedBackupMode: 'native', jobId: 'job-native' });
  await consumePrepared(baseline);
  const point = recoveryPoint('rp-log-cancel-baseline', 'full', null, undefined, 'job-native');
  point.chainRootId = point.id;
  data.recoveryPoints.push(point);
  data.artifacts.push({ recoveryPointId: point.id, kind: 'metadata', metadata: structuredClone(baseline.databaseManifest) });
  await data.service.release(baseline);

  data.setClock('2026-08-04T00:00:20.000Z');
  let index = 0;
  for (const runtime of data.runtimes.values()) runtime.addCommitLog(String(2000 + index++), `2026-08-04T00:00:${index === 1 ? '10' : '11'}.000Z`);
  const blocking = data.runtimes.get(data.connections[0].id);
  blocking.options.blockStream = true;
  blocking.streamStarted = new Promise((resolve) => { blocking.resolveStreamStarted = resolve; });
  const controller = new AbortController();
  const prepared = await data.service.prepare('workspace-a', 'run-log-cancel', data.plan, { backupMode: 'native', requestedBackupMode: 'native', jobId: 'job-native', previousRecoveryPoint: point, repositoryIds: ['repo-a'], signal: controller.signal });
  const transfer = (async () => { for await (const _chunk of prepared.artifacts.find((artifact) => artifact.artifactKind === 'transaction-log').content()) {} })();
  await blocking.streamStarted;
  controller.abort();
  await assert.rejects(transfer, /canceled/i);
  await data.service.release(prepared, 'canceled');
  assert.equal([...data.runtimes.values()].every((runtime) => [...runtime.contents.keys()].some((name) => name.includes('/commitlog-archive/CommitLog-7-200'))), true);
});

test('cleans partial snapshots on failure and detects mutation during repository streaming', async () => {
  const failed = fixture({ 1: { failSnapshot: true } });
  await assert.rejects(failed.service.prepare('workspace-a', 'run-failed', failed.plan, { backupMode: 'full' }), /snapshot failed|preparation failed/i);
  assert.equal([...failed.runtimes.values()].every((runtime) => runtime.tags.size === 0), true);
  const changed = fixture();
  const prepared = await changed.service.prepare('workspace-a', 'run-changed', changed.plan, { backupMode: 'full' });
  const nodeArtifact = prepared.artifacts[0];
  const runtime = changed.runtimes.get(changed.connections[0].id);
  const dataPath = [...runtime.contents.keys()].find((name) => name.endsWith('-Data.db'));
  runtime.contents.set(dataPath, Buffer.from('changed-after-membership'));
  await assert.rejects(async () => { for await (const _chunk of nodeArtifact.content()) {} }, /changed after immutable membership|grew during transfer/i);
  await changed.service.release(prepared);
});

test('refuses cluster publication when post-transfer node identity changes', async () => {
  const data = fixture({ 0: { driftAfterSnapshot: true } });
  const prepared = await data.service.prepare('workspace-a', 'run-drift', data.plan, { backupMode: 'full' });
  await assert.rejects(async () => {
    for (const artifact of prepared.artifacts) for await (const _chunk of artifact.content()) {}
  }, /identity changed after enrollment/i);
  await data.service.release(prepared);
  assert.equal([...data.runtimes.values()].every((runtime) => runtime.tags.size === 0), true);
});

test('preserves an active lease when cleanup is unproven and reconciles only the exact interrupted owner', async () => {
  const unproven = fixture({ 0: { failCleanup: true } });
  const leases = [];
  const prepared = await unproven.service.prepare('workspace-a', 'run-cleanup', unproven.plan, { backupMode: 'full', onSourceLease: async (lease) => leases.push(lease) });
  await assert.rejects(unproven.service.release(prepared), /cleanup.*could not be proven/i);
  assert.equal(leases.at(-1).state, 'active');
  unproven.runtimes.get(unproven.connections[0].id).options.failCleanup = false;
  const result = await unproven.service.reconcile('workspace-a', { id: 'run-cleanup', sourceLease: leases.at(-1) });
  assert.equal(result.proven, true);
  assert.equal(result.sourceLease.state, 'released');
  const foreign = await unproven.service.reconcile('workspace-a', { id: 'other-run', sourceLease: leases.at(-1) });
  assert.equal(foreign.proven, false);
});

test('source reader exposes every node archive and schema artifact through the registered physical contract', async () => {
  const data = fixture();
  const registry = new DatabaseAdapterRegistry([new CassandraScyllaAdapter()]);
  const reader = new CassandraScyllaSourceReaderService({ controlDatabase: data.controlDatabase, secretStore: data.secretStore, deviceId: 'device-a', adapterRegistry: registry, adapter: data.adapter, physicalBackupService: data.service });
  const files = await reader.files('workspace-a', data.sourceRecord.id, { executionId: 'run-reader', jobId: 'job-a', backupMode: 'full' });
  assert.equal(files.manifest.database.kind, 'cassandra-scylla-native-full');
  const emitted = [];
  for await (const file of files.create()) emitted.push(file);
  assert.deepEqual(emitted.map((item) => item.metadata.componentId), [HOSTS[0], HOSTS[1], 'schema', 'cluster-manifest']);
  assert.equal(await reader.release('workspace-a', 'run-reader'), true);
  const mainSource = await fs.readFile(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(mainSource, /new CassandraScyllaSourceReaderService/);
  assert.match(mainSource, /\[CASSANDRA_SCYLLA_ADAPTER_ID\]: cassandraScyllaSourceReader/);
});

test('shared runner publishes a full baseline and incremental chain, skips no-change points, and cleans cancellation', async (context) => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-cassandra-runner-test-'));
  const database = new BackupControlDatabase({ rootPath: path.join(rootPath, 'control'), clock: () => '2026-08-04T00:00:00.000Z' });
  await database.initialize();
  context.after(async () => { await database.close(); await fs.rm(rootPath, { recursive: true, force: true }); });
  const savedConnections = [];
  for (let index = 0; index < HOSTS.length; index += 1) {
    const item = connection(HOSTS[index], index);
    savedConnections.push(await database.repository('connection').create({ ...item, id: undefined, workspaceId: 'workspace-a', actorId: 'tester' }));
  }
  const savedSource = await database.repository('source').create({ ...source(savedConnections, { incrementalEnabled: true, commitLogEnabled: true }), id: undefined, workspaceId: 'workspace-a', actorId: 'tester', connectionId: savedConnections[0].id });
  const repositoryRoot = path.join(rootPath, 'repository');
  await fs.mkdir(repositoryRoot, { recursive: true });
  const repository = await database.repository('repository').create({
    workspaceId: 'workspace-a', actorId: 'tester', name: 'Archive', connectionId: null, adapterId: LOCAL_REPOSITORY_ADAPTER_ID, adapterVersion: '1.0.0', engineId: ENGINE_ID, engineVersion: ENGINE_VERSION,
    location: { path: repositoryRoot }, secretRefIds: [], encryptionKeyRefId: null, encryption: { algorithm: 'aes-256-gcm', keyVersion: 'test-key-v1' }, workerAffinity: ['device:device-a'], health: { status: 'ready', repositoryFormatVersion: REPOSITORY_FORMAT_VERSION, lockState: { status: 'available' } }
  });
  const repositoryAdapter = new LocalFolderRepositoryAdapter({ rootPath: repositoryRoot });
  await repositoryAdapter.initialize();
  const repositoryEngine = new FileRepositoryEngine({ adapter: repositoryAdapter });
  await repositoryEngine.ensureRepository({}, { repositoryId: repository.id });
  const masterKey = Buffer.alloc(32, 7);
  let currentTime = '2026-08-04T00:00:00.000Z';
  const runtimes = new Map(savedConnections.map((item, index) => [item.id, new FakeRuntime(HOSTS[index], { incrementalEnabled: true, clock: () => currentTime })]));
  for (const runtime of runtimes.values()) { runtime.enableCommitLogArchive(); runtime.addCommitLog('1000', '2026-08-03T23:59:59.000Z'); }
  const runtimeFactory = { open: async (_workspaceId, item, signal) => { const runtime = runtimes.get(item.id); runtime.signal = signal; return runtime; } };
  const secretStore = { resolve: async () => 'unused' };
  const adapter = new CassandraScyllaAdapter();
  adapter.discover = async function* fakeDiscover(context) {
    const identity = await context.runNativeCommand({ executable: 'identity', args: [], timeoutMs: 1000 });
    yield discovery(identity.stdout, true);
  };
  const registry = new DatabaseAdapterRegistry([new CassandraScyllaAdapter()]);
  const physical = new CassandraScyllaPhysicalBackupService({ controlDatabase: database, secretStore, deviceId: 'device-a', adapter, runtimeFactory, clock: () => currentTime });
  const sourceReader = new CassandraScyllaSourceReaderService({ controlDatabase: database, secretStore, deviceId: 'device-a', adapterRegistry: registry, adapter, physicalBackupService: physical });
  const jobService = new BackupJobService({ controlDatabase: database, deviceId: 'device-a', clock: () => '2026-08-04T00:00:00.000Z' });
  const created = await jobService.create('workspace-a', 'tester', { name: 'Cassandra full protection', sourceId: savedSource.id, repositoryIds: [repository.id], backupMode: 'full' });
  const logStore = new StructuredLogStore({ rootPath: path.join(rootPath, 'logs') });
  const service = new ManualBackupService({
    controlDatabase: database, sourceReader, deviceId: 'device-a',
    checkpointStore: new RunCheckpointStore({ rootPath: path.join(rootPath, 'checkpoints') }),
    logStore,
    openRepository: async () => ({ repository, adapter: repositoryAdapter, engine: repositoryEngine, masterKey, keyVersion: 'test-key-v1' })
  });
  const started = await service.start('workspace-a', 'tester', created.job.id);
  await service.wait(started.id);
  const completed = await database.repository('run').get('workspace-a', started.id);
  const points = await database.repository('recoveryPoint').list('workspace-a');
  const artifacts = await database.repository('artifact').list('workspace-a');
  const logs = await logStore.list('workspace-a', { correlationId: started.id, component: 'backup-run', limit: 20 });
  assert.equal(completed.state, 'succeeded', JSON.stringify({ result: completed.result, logs }));
  assert.equal(points.length, 1);
  assert.equal(points[0].type, 'full');
  assert.equal(points[0].consistency, 'crash');
  assert.equal(points[0].verification.state, 'succeeded');
  assert.equal(artifacts.filter((item) => ['physical-backup', 'schema', 'metadata'].includes(item.kind)).length, 4);
  assert.equal(artifacts.find((item) => item.kind === 'physical-backup').metadata.kind, 'cassandra-scylla-native-full');
  assert.equal(artifacts.find((item) => item.kind === 'metadata').metadata.publication.state, 'sealed');
  assert.equal([...runtimes.values()].every((runtime) => runtime.tags.size === 0), true);

  const incrementalJob = await jobService.create('workspace-a', 'tester', { name: 'Cassandra incremental protection', sourceId: savedSource.id, repositoryIds: [repository.id], backupMode: 'incremental', maximumIncrementalChainLength: 2 });
  assert.equal(incrementalJob.job.adapterSettings.cassandraIncremental.maximumChainLength, 2);
  const baselineRun = await service.start('workspace-a', 'tester', incrementalJob.job.id);
  await service.wait(baselineRun.id);
  const baselineCompleted = await database.repository('run').get('workspace-a', baselineRun.id);
  const baselinePoint = (await database.repository('recoveryPoint').list('workspace-a')).find((point) => point.jobId === incrementalJob.job.id);
  assert.equal(baselineCompleted.state, 'succeeded', JSON.stringify(baselineCompleted.result));
  assert.equal(baselinePoint.type, 'full');
  const baselineMetadata = (await database.repository('artifact').list('workspace-a')).find((artifact) => artifact.recoveryPointId === baselinePoint.id && artifact.kind === 'metadata');
  assert.equal(baselineMetadata.metadata.incremental.baseline, true);

  for (const runtime of runtimes.values()) runtime.addIncremental('nb-2-big');
  const incrementalRun = await service.start('workspace-a', 'tester', incrementalJob.job.id);
  await service.wait(incrementalRun.id);
  const incrementalCompleted = await database.repository('run').get('workspace-a', incrementalRun.id);
  const chainPoints = (await database.repository('recoveryPoint').list('workspace-a')).filter((point) => point.jobId === incrementalJob.job.id);
  const incrementalPoint = chainPoints.find((point) => point.type === 'incremental');
  assert.equal(incrementalCompleted.state, 'succeeded', JSON.stringify(incrementalCompleted.result));
  assert.equal(chainPoints.length, 2);
  assert.equal(incrementalPoint.parentRecoveryPointId, baselinePoint.id);
  assert.equal(incrementalPoint.chainRootId, baselinePoint.id);
  const openedIncremental = await repositoryEngine.openSnapshot({}, { repositoryId: repository.id, snapshotId: incrementalPoint.repositoryCopies[0].engineSnapshotId, masterKey });
  assert.equal(openedIncremental.summary.parentSnapshotId, baselinePoint.repositoryCopies[0].engineSnapshotId);
  const incrementalMetadata = (await database.repository('artifact').list('workspace-a')).find((artifact) => artifact.recoveryPointId === incrementalPoint.id && artifact.kind === 'metadata');
  assert.equal(incrementalMetadata.metadata.kind, 'cassandra-scylla-native-incremental');
  assert.equal(incrementalMetadata.metadata.incremental.newSetCount, 2);
  assert.equal([...runtimes.values()].every((runtime) => [...runtime.contents.keys()].some((name) => name.includes('/backups/nb-2-big-Data.db'))), true);

  const noChangeRun = await service.start('workspace-a', 'tester', incrementalJob.job.id);
  await service.wait(noChangeRun.id);
  const noChangeCompleted = await database.repository('run').get('workspace-a', noChangeRun.id);
  assert.equal(noChangeCompleted.state, 'succeeded');
  assert.equal(noChangeCompleted.result.noChange, true);
  assert.equal((await database.repository('recoveryPoint').list('workspace-a')).filter((point) => point.jobId === incrementalJob.job.id).length, 2);

  for (const runtime of runtimes.values()) runtime.addIncremental('nb-3-big');
  const blockingRuntime = runtimes.get(savedConnections[0].id);
  blockingRuntime.options.blockStream = true;
  blockingRuntime.streamStarted = new Promise((resolve) => { blockingRuntime.resolveStreamStarted = resolve; });
  const cancelStarted = await service.start('workspace-a', 'tester', incrementalJob.job.id);
  await blockingRuntime.streamStarted;
  const canceled = await service.cancel('workspace-a', 'tester', cancelStarted.id);
  assert.equal(canceled.state, 'canceled');
  assert.equal([...runtimes.values()].every((runtime) => runtime.tags.size === 0), true);
  assert.equal([...runtimes.values()].every((runtime) => [...runtime.contents.keys()].some((name) => name.includes('/backups/nb-3-big-Data.db'))), true);
  assert.equal((await database.repository('recoveryPoint').list('workspace-a')).length, 3);

  blockingRuntime.options.blockStream = false;
  blockingRuntime.resolveStreamStarted = null;
  const secondIncrementalRun = await service.start('workspace-a', 'tester', incrementalJob.job.id);
  await service.wait(secondIncrementalRun.id);
  assert.equal((await database.repository('run').get('workspace-a', secondIncrementalRun.id)).state, 'succeeded');
  const rolloverRun = await service.start('workspace-a', 'tester', incrementalJob.job.id);
  await service.wait(rolloverRun.id);
  assert.equal((await database.repository('run').get('workspace-a', rolloverRun.id)).state, 'succeeded');
  let currentPoints = (await database.repository('recoveryPoint').list('workspace-a')).filter((point) => point.jobId === incrementalJob.job.id);
  const scheduledRollover = currentPoints.find((point) => point.runId === rolloverRun.id);
  assert.equal(scheduledRollover.type, 'full');
  assert.equal(scheduledRollover.chainRootId, scheduledRollover.id);
  const openedRollover = await repositoryEngine.openSnapshot({}, { repositoryId: repository.id, snapshotId: scheduledRollover.repositoryCopies[0].engineSnapshotId, masterKey });
  assert.equal(openedRollover.summary.parentSnapshotId, null);
  let rolloverMetadata = (await database.repository('artifact').list('workspace-a')).find((artifact) => artifact.recoveryPointId === scheduledRollover.id && artifact.kind === 'metadata');
  assert.equal(rolloverMetadata.metadata.incremental.rolloverReason, 'maximum-chain-length');

  for (const suffix of ['Data.db', 'Statistics.db', 'TOC.txt']) blockingRuntime.contents.delete(`${blockingRuntime.backupDirectory()}/nb-2-big-${suffix}`);
  for (const runtime of runtimes.values()) runtime.addIncremental('nb-4-big');
  const forcedBaselineRun = await service.start('workspace-a', 'tester', incrementalJob.job.id);
  await service.wait(forcedBaselineRun.id);
  assert.equal((await database.repository('run').get('workspace-a', forcedBaselineRun.id)).state, 'succeeded');
  currentPoints = (await database.repository('recoveryPoint').list('workspace-a')).filter((point) => point.jobId === incrementalJob.job.id);
  const forcedBaseline = currentPoints.find((point) => point.runId === forcedBaselineRun.id);
  rolloverMetadata = (await database.repository('artifact').list('workspace-a')).find((artifact) => artifact.recoveryPointId === forcedBaseline.id && artifact.kind === 'metadata');
  assert.equal(forcedBaseline.type, 'full', JSON.stringify({ point: forcedBaseline, metadata: rolloverMetadata?.metadata }));
  assert.equal(rolloverMetadata.metadata.incremental.rolloverReason, 'CASSANDRA_INCREMENTAL_GAP');
  assert.equal((await database.repository('recoveryPoint').list('workspace-a')).length, 6);

  const nativeJob = await jobService.create('workspace-a', 'tester', { name: 'Cassandra commit-log protection', sourceId: savedSource.id, repositoryIds: [repository.id], backupMode: 'native', maximumCommitLogChainLength: 2 });
  assert.equal(nativeJob.job.adapterSettings.cassandraCommitLog.maximumChainLength, 2);
  const logBaselineRun = await service.start('workspace-a', 'tester', nativeJob.job.id);
  await service.wait(logBaselineRun.id);
  const logBaselinePoint = (await database.repository('recoveryPoint').list('workspace-a')).find((point) => point.jobId === nativeJob.job.id);
  assert.equal((await database.repository('run').get('workspace-a', logBaselineRun.id)).state, 'succeeded');
  assert.equal(logBaselinePoint.type, 'full');
  assert.equal(logBaselinePoint.pointInTime.type, 'cassandra-commit-log');
  const logBaselineMetadata = (await database.repository('artifact').list('workspace-a')).find((artifact) => artifact.recoveryPointId === logBaselinePoint.id && artifact.kind === 'metadata');
  assert.equal(logBaselineMetadata.metadata.commitLog.baseline, true);

  currentTime = '2026-08-04T00:00:20.000Z';
  let commitLogIndex = 0;
  for (const runtime of runtimes.values()) runtime.addCommitLog(String(2000 + commitLogIndex++), `2026-08-04T00:00:${commitLogIndex === 1 ? '10' : '11'}.000Z`);
  const commitLogRun = await service.start('workspace-a', 'tester', nativeJob.job.id);
  await service.wait(commitLogRun.id);
  const nativePoints = (await database.repository('recoveryPoint').list('workspace-a')).filter((point) => point.jobId === nativeJob.job.id);
  const commitLogPoint = nativePoints.find((point) => point.type === 'log');
  assert.equal((await database.repository('run').get('workspace-a', commitLogRun.id)).state, 'succeeded');
  assert.equal(nativePoints.length, 2);
  assert.equal(commitLogPoint.parentRecoveryPointId, logBaselinePoint.id);
  assert.equal(commitLogPoint.chainRootId, logBaselinePoint.id);
  assert.equal(commitLogPoint.pointInTime.latest, '2026-08-04T00:00:10.000Z');
  const openedCommitLog = await repositoryEngine.openSnapshot({}, { repositoryId: repository.id, snapshotId: commitLogPoint.repositoryCopies[0].engineSnapshotId, masterKey });
  assert.equal(openedCommitLog.summary.parentSnapshotId, logBaselinePoint.repositoryCopies[0].engineSnapshotId);
  const commitLogArtifacts = (await database.repository('artifact').list('workspace-a')).filter((artifact) => artifact.recoveryPointId === commitLogPoint.id);
  assert.equal(commitLogArtifacts.filter((artifact) => artifact.kind === 'transaction-log').length, 2);
  assert.equal(commitLogArtifacts.find((artifact) => artifact.kind === 'metadata').metadata.kind, 'cassandra-commit-log');

  currentTime = '2026-08-04T00:00:25.000Z';
  const commitLogNoChangeRun = await service.start('workspace-a', 'tester', nativeJob.job.id);
  await service.wait(commitLogNoChangeRun.id);
  assert.equal((await database.repository('run').get('workspace-a', commitLogNoChangeRun.id)).result.noChange, true);
  assert.equal((await database.repository('recoveryPoint').list('workspace-a')).filter((point) => point.jobId === nativeJob.job.id).length, 2);

  currentTime = '2026-08-04T00:00:40.000Z';
  commitLogIndex = 0;
  for (const runtime of runtimes.values()) runtime.addCommitLog(String(3000 + commitLogIndex++), `2026-08-04T00:00:${commitLogIndex === 1 ? '30' : '31'}.000Z`);
  const secondCommitLogRun = await service.start('workspace-a', 'tester', nativeJob.job.id);
  await service.wait(secondCommitLogRun.id);
  const secondCommitLogPoint = (await database.repository('recoveryPoint').list('workspace-a')).find((point) => point.runId === secondCommitLogRun.id);
  assert.equal(secondCommitLogPoint.type, 'log');
  currentTime = '2026-08-04T00:00:45.000Z';
  const logRolloverRun = await service.start('workspace-a', 'tester', nativeJob.job.id);
  await service.wait(logRolloverRun.id);
  const logRolloverPoint = (await database.repository('recoveryPoint').list('workspace-a')).find((point) => point.runId === logRolloverRun.id);
  assert.equal(logRolloverPoint.type, 'full');
  assert.equal(logRolloverPoint.parentRecoveryPointId, null);
  const logRolloverMetadata = (await database.repository('artifact').list('workspace-a')).find((artifact) => artifact.recoveryPointId === logRolloverPoint.id && artifact.kind === 'metadata');
  assert.equal(logRolloverMetadata.metadata.commitLog.rolloverReason, 'maximum-commit-log-chain-length');

  const gapRuntime = runtimes.get(savedConnections[0].id);
  gapRuntime.contents.delete(`${gapRuntime.commitLogDirectory()}/CommitLog-7-2000.log`);
  currentTime = '2026-08-04T00:01:00.000Z';
  commitLogIndex = 0;
  for (const runtime of runtimes.values()) runtime.addCommitLog(String(4000 + commitLogIndex++), `2026-08-04T00:00:${commitLogIndex === 1 ? '50' : '51'}.000Z`);
  const logGapRun = await service.start('workspace-a', 'tester', nativeJob.job.id);
  await service.wait(logGapRun.id);
  const logGapPoint = (await database.repository('recoveryPoint').list('workspace-a')).find((point) => point.runId === logGapRun.id);
  assert.equal(logGapPoint.type, 'full');
  const logGapMetadata = (await database.repository('artifact').list('workspace-a')).find((artifact) => artifact.recoveryPointId === logGapPoint.id && artifact.kind === 'metadata');
  assert.equal(logGapMetadata.metadata.commitLog.rolloverReason, 'CASSANDRA_COMMIT_LOG_GAP');
  assert.equal([...runtimes.values()].every((runtime) => [...runtime.contents.keys()].some((name) => name.endsWith('CommitLog-7-4000.log') || name.endsWith('CommitLog-7-4001.log'))), true);
});
