const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { Readable } = require('stream');
const { ADAPTER_ID, stableDigest } = require('./cassandra-scylla');
const { commitLogCursor } = require('./cassandra-commit-log');
const { ARCHIVE_MAGIC, incrementalCursor } = require('./cassandra-scylla-physical');
const {
  ALTERNATE_CONFIRMATIONS,
  CassandraScyllaRestoreService,
  OFFLINE_CONFIRMATION,
  assertCompatibleVersions,
  consumeNodeArchive,
  safeArchivePath,
  validateRecoveryChain
} = require('./cassandra-scylla-restore');

const SOURCE_HOST = '11111111-1111-1111-1111-111111111111';
const TARGET_HOSTS = ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'];
const MODIFIED_AT = '2026-08-04T00:00:00.000Z';

function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

function nodeEvidence(fileContent = Buffer.from('sstable-data'), archivePath = `nodes/${SOURCE_HOST}/data-0/app/orders/tag/nb-1-big-Data.db`) {
  const file = { archivePath, sizeBytes: fileContent.length, modifiedAt: MODIFIED_AT, sha256: sha256(fileContent) };
  const node = { version: 1, hostId: SOURCE_HOST, connectionId: 'source-connection', connectionRevision: 1, serverIdentityFingerprint: 'sha256:source-node', tokenCount: 2, tokenDigest: 'sha256:source-tokens', tags: [], files: [file], fileCount: 1, sourceBytes: fileContent.length };
  node.manifestDigest = stableDigest(node);
  return { node, file, fileContent };
}

function archiveBytes(node, contentsByPath, options = {}) {
  const chunks = [ARCHIVE_MAGIC];
  for (const file of node.files) {
    const header = { version: 1, path: options.headerPath || file.archivePath, sizeBytes: file.sizeBytes, modifiedAt: file.modifiedAt, sha256: options.headerDigest || file.sha256 };
    const bytes = Buffer.from(JSON.stringify(header), 'utf8');
    const size = Buffer.alloc(4); size.writeUInt32BE(bytes.length);
    chunks.push(size, bytes, contentsByPath.get(file.archivePath));
  }
  chunks.push(Buffer.alloc(4));
  if (options.trailing) chunks.push(Buffer.from('trailing'));
  return Buffer.concat(chunks);
}

function fullManifest(node, schemaBytes = Buffer.from('CREATE KEYSPACE app WITH replication = {};\nCREATE TABLE app.orders (id uuid PRIMARY KEY);\n')) {
  const manifest = {
    version: 1,
    kind: 'cassandra-scylla-native-full',
    adapterId: ADAPTER_ID,
    adapterVersion: '0.1.0',
    engine: 'cassandra-scylla',
    backupMethod: 'physical',
    backupMode: 'full',
    selection: { kind: 'database-objects', digest: 'selector-digest' },
    selectionDigest: 'selection-fingerprint',
    consistency: { achievedLevel: 'crash', proven: true },
    cluster: {
      product: 'cassandra', version: '5.0.3', partitioner: 'org.apache.cassandra.dht.Murmur3Partitioner', name: 'source-cluster',
      clusterFingerprint: 'sha256:source-cluster', topologyFingerprint: 'sha256:source-topology', ringFingerprint: 'sha256:source-ring',
      schemaVersion: 'cccccccc-cccc-cccc-cccc-cccccccccccc', coverageMode: 'vnode-ring', tokenCount: 2
    },
    source: { sourceId: 'source-a', sourceRevision: 1, jobId: 'job-a', ownerId: 'backup-owner' },
    keyspaces: [{ name: 'app', durableWrites: true, replication: { class: 'NetworkTopologyStrategy', dc1: '2' }, tabletsEnabled: false }],
    tables: [{ database: 'app', schema: 'app', name: 'orders', tableId: 'dddddddd-dddd-dddd-dddd-dddddddddddd' }],
    rebuildObjects: [{ kind: 'secondary-index', keyspace: 'app', table: 'orders', name: 'orders_status_idx', restoreAction: 'rebuild' }],
    nodes: [node],
    schema: { path: 'cassandra-scylla/schema/schema.cql', sizeBytes: schemaBytes.length, sha256: sha256(schemaBytes), scope: 'selected-keyspaces', selectionDigest: 'selection-fingerprint' },
    chain: { parentRecoveryPointId: null, chainRootRecoveryPointId: null },
    incremental: null,
    commitLog: null,
    snapshotWindow: { startedAt: MODIFIED_AT, membershipCapturedAt: MODIFIED_AT },
    cleanup: { ownership: 'exact-native-tags', state: 'released' },
    artifacts: [
      { componentId: SOURCE_HOST, kind: 'physical-backup', path: `cassandra-scylla/nodes/${SOURCE_HOST}.dxcsnapshot` },
      { componentId: 'schema', kind: 'schema', path: 'cassandra-scylla/schema/schema.cql' },
      { componentId: 'cluster-manifest', kind: 'metadata', path: 'cassandra-scylla/cluster-manifest.json' }
    ],
    publication: { state: 'sealed', sealedAt: MODIFIED_AT, postflight: { topology: 'verified', ring: 'verified', schema: 'verified' } }
  };
  manifest.manifestDigest = stableDigest(manifest);
  return manifest;
}

function point(id = 'rp-full') {
  return {
    id, workspaceId: 'workspace-a', sourceId: 'source-a', jobId: 'job-a', runId: 'run-a', type: 'full', parentRecoveryPointId: null, chainRootId: id,
    repositoryCopies: [{ repositoryId: 'repository-a', engineSnapshotId: `snapshot-${id}`, state: 'available' }],
    verification: { state: 'succeeded' }, retention: { deletionEligible: false }
  };
}

class MemoryControlDatabase {
  constructor(records) { this.records = Object.fromEntries(Object.entries(records).map(([name, values]) => [name, new Map(values.map((value) => [value.id, structuredClone(value)]))])); }
  repository(name) {
    const records = this.records[name] || (this.records[name] = new Map());
    return {
      get: async (_workspaceId, id) => records.get(id) || null,
      list: async () => [...records.values()],
      create: async (value) => { const created = { ...structuredClone(value), id: value.id || `restore-${records.size + 1}`, revision: 1 }; records.set(created.id, created); return structuredClone(created); }
    };
  }
  async transaction(operation) {
    return operation({
      get: (name, _workspaceId, id) => this.records[name].get(id),
      projectExecution: (name, _workspaceId, id, changes) => { const current = this.records[name].get(id); const updated = { ...current, ...structuredClone(changes), revision: current.revision + 1 }; this.records[name].set(id, updated); return structuredClone(updated); }
    });
  }
}

function repositoryFixture(options = {}) {
  const schemaBytes = Buffer.from('CREATE KEYSPACE app WITH replication = {};\nCREATE TABLE app.orders (id uuid PRIMARY KEY);\n');
  const evidence = nodeEvidence(options.fileContent);
  const manifest = fullManifest(evidence.node, schemaBytes);
  if (options.mutateManifest) options.mutateManifest(manifest);
  if (options.mutateManifest) manifest.manifestDigest = stableDigest({ ...manifest, manifestDigest: undefined });
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const archive = options.archive || archiveBytes(evidence.node, new Map([[evidence.file.archivePath, evidence.fileContent]]), options.archiveOptions);
  const content = new Map([
    ['cassandra-scylla/cluster-manifest.json', manifestBytes],
    ['cassandra-scylla/schema/schema.cql', schemaBytes],
    [`cassandra-scylla/nodes/${SOURCE_HOST}.dxcsnapshot`, archive]
  ]);
  const files = manifest.artifacts.map((artifact) => {
    const bytes = content.get(artifact.path);
    const database = artifact.componentId === 'cluster-manifest'
      ? manifest
      : { adapterId: ADAPTER_ID, component: { componentId: artifact.componentId, manifestDigest: artifact.componentId === 'schema' ? manifest.schema.sha256 : manifest.nodes.find((node) => node.hostId === artifact.componentId)?.manifestDigest } };
    return { type: 'file', path: artifact.path, sizeBytes: bytes.length, contentDigest: { algorithm: 'sha256', digest: sha256(bytes) }, metadata: { componentId: artifact.componentId, artifactKind: artifact.kind, database } };
  });
  const opened = {
    point: point(), copy: { repositoryId: 'repository-a' }, manifest: { files }, masterKey: Buffer.alloc(32),
    engine: { streamFile: (_context, request) => options.nodeStream && request.path.endsWith('.dxcsnapshot') ? options.nodeStream(content.get(request.path)) : Readable.from([content.get(request.path)]) }
  };
  const source = { id: 'source-a', adapterId: ADAPTER_ID, sourceType: 'database' };
  const controlDatabase = new MemoryControlDatabase({ recoveryPoint: [point()], source: [source], connection: options.connections || [], restoreRun: [] });
  const snapshotBrowser = { openAuthenticatedSnapshot: async () => opened };
  return { archive, controlDatabase, evidence, manifest, opened, schemaBytes, snapshotBrowser };
}

function openedRecord(recordPoint, manifest, content) {
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const allContent = new Map([[MANIFEST_TEST_PATH, manifestBytes], ...content]);
  const files = manifest.artifacts.map((artifact) => {
    const bytes = allContent.get(artifact.path);
    const database = artifact.componentId === 'cluster-manifest'
      ? manifest
      : { adapterId: ADAPTER_ID, component: { componentId: artifact.componentId, manifestDigest: artifact.componentId === 'schema' ? manifest.schema?.sha256 : manifest.nodes.find((node) => node.hostId === artifact.componentId)?.manifestDigest } };
    return { type: 'file', path: artifact.path, sizeBytes: bytes.length, contentDigest: { algorithm: 'sha256', digest: sha256(bytes) }, metadata: { componentId: artifact.componentId, artifactKind: artifact.kind, database } };
  });
  return { point: recordPoint, copy: { repositoryId: 'repository-a' }, manifest: { files }, masterKey: Buffer.alloc(32), engine: { streamFile: (_context, request) => Readable.from([allContent.get(request.path)]) } };
}

const MANIFEST_TEST_PATH = 'cassandra-scylla/cluster-manifest.json';

function pitrFixture() {
  const base = repositoryFixture();
  const cursorNode = (segments) => ({
    hostId: SOURCE_HOST,
    archiveDirectoryDigest: `sha256:${'1'.repeat(64)}`,
    propertiesDigest: `sha256:${'2'.repeat(64)}`,
    archiveCommandDigest: `sha256:${'3'.repeat(64)}`,
    ownershipMarkerDigest: `sha256:${'4'.repeat(64)}`,
    precision: 'MICROSECONDS',
    clockObservedAt: '2026-08-04T00:00:10.000Z',
    clockOffsetMilliseconds: 0,
    clockSkewMilliseconds: 0,
    segments
  });
  const segmentOneBytes = Buffer.from('commit-log-one');
  const segmentTwoBytes = Buffer.from('commit-log-two');
  const segmentOne = { name: 'CommitLog-7-1.log', version: '7', segmentId: '1', sizeBytes: segmentOneBytes.length, modifiedAt: '2026-08-04T00:00:01.000Z', sha256: sha256(segmentOneBytes) };
  const segmentTwo = { name: 'CommitLog-7-2.log', version: '7', segmentId: '2', sizeBytes: segmentTwoBytes.length, modifiedAt: '2026-08-04T00:00:02.000Z', sha256: sha256(segmentTwoBytes) };
  const baselineCursor = commitLogCursor([cursorNode([segmentOne])]);
  const currentCursor = commitLogCursor([cursorNode([segmentOne, segmentTwo])]);
  base.manifest.commitLog = { cursor: baselineCursor, baseline: true, precision: 'MICROSECONDS', recoveryWindow: { earliest: '2026-08-04T00:00:00.000000Z', previous: null, latest: '2026-08-04T00:00:00.000000Z' }, gaps: [] };
  base.manifest.manifestDigest = stableDigest({ ...base.manifest, manifestDigest: undefined });
  const logFile = { archivePath: `nodes/${SOURCE_HOST}/commitlog/${segmentTwo.name}`, sizeBytes: segmentTwo.sizeBytes, modifiedAt: segmentTwo.modifiedAt, sha256: segmentTwo.sha256 };
  const logNode = { version: 1, hostId: SOURCE_HOST, connectionId: 'source-connection', connectionRevision: 1, serverIdentityFingerprint: 'sha256:source-node', tokenCount: 2, tokenDigest: 'sha256:source-tokens', files: [logFile], fileCount: 1, sourceBytes: logFile.sizeBytes, commitLog: { previousSegmentCount: 1, currentSegmentCount: 2, newSegmentCount: 1, safeThrough: segmentTwo.modifiedAt, clockObservedAt: '2026-08-04T00:00:10.000Z', clockOffsetMilliseconds: 0, clockSkewMilliseconds: 0 } };
  logNode.manifestDigest = stableDigest(logNode);
  const logPoint = { ...point('rp-log'), type: 'log', parentRecoveryPointId: 'rp-full', chainRootId: 'rp-full' };
  const logManifest = structuredClone(base.manifest);
  logManifest.kind = 'cassandra-commit-log';
  logManifest.backupMode = 'native';
  logManifest.nodes = [logNode];
  delete logManifest.schema;
  logManifest.chain = { parentRecoveryPointId: 'rp-full', chainRootRecoveryPointId: 'rp-full' };
  logManifest.commitLog = { cursor: currentCursor, previousCursorDigest: baselineCursor.digest, previousSegmentCount: 1, currentSegmentCount: 2, newSegmentCount: 1, precision: 'MICROSECONDS', recoveryWindow: { earliest: '2026-08-04T00:00:00.000000Z', previous: '2026-08-04T00:00:00.000000Z', latest: currentCursor.safeThrough }, gaps: [] };
  logManifest.artifacts = [{ componentId: SOURCE_HOST, kind: 'transaction-log', path: `cassandra-scylla/commitlog/${SOURCE_HOST}.dxcsnapshot` }, { componentId: 'cluster-manifest', kind: 'metadata', path: MANIFEST_TEST_PATH }];
  logManifest.manifestDigest = stableDigest({ ...logManifest, manifestDigest: undefined });
  const rootArchive = archiveBytes(base.evidence.node, new Map([[base.evidence.file.archivePath, base.evidence.fileContent]]));
  const logArchive = archiveBytes(logNode, new Map([[logFile.archivePath, segmentTwoBytes]]));
  const rootOpened = openedRecord(point(), base.manifest, new Map([
    ['cassandra-scylla/schema/schema.cql', base.schemaBytes],
    [`cassandra-scylla/nodes/${SOURCE_HOST}.dxcsnapshot`, rootArchive]
  ]));
  const logOpened = openedRecord(logPoint, logManifest, new Map([[`cassandra-scylla/commitlog/${SOURCE_HOST}.dxcsnapshot`, logArchive]]));
  const source = { id: 'source-a', adapterId: ADAPTER_ID, sourceType: 'database' };
  const controlDatabase = new MemoryControlDatabase({ recoveryPoint: [point(), logPoint], source: [source], connection: [], restoreRun: [] });
  const snapshotBrowser = { openAuthenticatedSnapshot: async (_workspaceId, recoveryPointId) => recoveryPointId === 'rp-full' ? rootOpened : logOpened };
  return { controlDatabase, logFile, logManifest, segmentTwoBytes, snapshotBrowser };
}

test('node archive consumption authenticates exact paths, sizes, hashes, completeness, and terminator', async () => {
  const { evidence, archive } = repositoryFixture();
  const restored = new Map();
  const result = await consumeNodeArchive(Readable.from([archive]), evidence.node, async (entry, chunks) => {
    const collected = [];
    for await (const chunk of chunks) collected.push(Buffer.from(chunk));
    restored.set(entry.archivePath, Buffer.concat(collected));
  });
  assert.equal(result.fileCount, 1);
  assert.deepEqual(restored.get(evidence.file.archivePath), evidence.fileContent);
  assert.throws(() => safeArchivePath('../escape'), (error) => error.code === 'CASSANDRA_RESTORE_ARCHIVE_PATH_UNSAFE');
  await assert.rejects(consumeNodeArchive(Readable.from([archive.subarray(0, archive.length - 2)]), evidence.node, async (_entry, chunks) => { for await (const _chunk of chunks) {} }), (error) => error.code === 'CASSANDRA_RESTORE_ARCHIVE_TRUNCATED');
  const trailing = archiveBytes(evidence.node, new Map([[evidence.file.archivePath, evidence.fileContent]]), { trailing: true });
  await assert.rejects(consumeNodeArchive(Readable.from([trailing]), evidence.node, async (_entry, chunks) => { for await (const _chunk of chunks) {} }), (error) => error.code === 'CASSANDRA_RESTORE_ARCHIVE_TRAILING_DATA');
});

test('recovery-chain validation refuses a mismatched or unauthenticated child', () => {
  const first = repositoryFixture();
  const secondPoint = { ...point('rp-incremental'), type: 'incremental', parentRecoveryPointId: 'rp-full', chainRootId: 'rp-full' };
  const secondManifest = structuredClone(first.manifest);
  secondManifest.kind = 'cassandra-scylla-native-incremental';
  secondManifest.chain = { parentRecoveryPointId: 'rp-full', chainRootRecoveryPointId: 'rp-full' };
  secondManifest.incremental = { cursor: null };
  secondManifest.manifestDigest = stableDigest({ ...secondManifest, manifestDigest: undefined });
  assert.throws(() => validateRecoveryChain([{ point: point(), manifest: first.manifest }, { point: secondPoint, manifest: secondManifest }]), (error) => ['CASSANDRA_INCREMENTAL_CURSOR_INVALID', 'CASSANDRA_RESTORE_CHAIN_MISMATCH'].includes(error.code));
  secondManifest.cluster.clusterFingerprint = 'sha256:other';
  secondManifest.manifestDigest = stableDigest({ ...secondManifest, manifestDigest: undefined });
  assert.throws(() => validateRecoveryChain([{ point: point(), manifest: first.manifest }, { point: secondPoint, manifest: secondManifest }]), (error) => error.code === 'CASSANDRA_RESTORE_CHAIN_MISMATCH');
});

test('incremental recovery authenticates a full root, exact parent lineage, and an advancing SSTable cursor', () => {
  const first = repositoryFixture();
  const table = { dataRootIndex: 0, keyspace: 'app', table: 'orders', tableId: 'dddddddd-dddd-dddd-dddd-dddddddddddd' };
  const baselineCursor = incrementalCursor([{ binding: { hostId: SOURCE_HOST }, incrementalTables: [{ ...table, sets: [] }] }]);
  const component = { name: 'nb-2-big-Data.db', sizeBytes: 4, modifiedAt: MODIFIED_AT, sha256: sha256(Buffer.from('next')) };
  const currentCursor = incrementalCursor([{ binding: { hostId: SOURCE_HOST }, incrementalTables: [{ ...table, sets: [{ descriptor: 'nb-2-big', format: 'nb', setDigest: 'sha256:' + 'a'.repeat(64), components: [component] }] }] }]);
  first.manifest.incremental = { cursor: baselineCursor, baseline: true };
  first.manifest.manifestDigest = stableDigest({ ...first.manifest, manifestDigest: undefined });
  const childPoint = { ...point('rp-incremental'), type: 'incremental', parentRecoveryPointId: 'rp-full', chainRootId: 'rp-full' };
  const childManifest = structuredClone(first.manifest);
  childManifest.kind = 'cassandra-scylla-native-incremental';
  childManifest.chain = { parentRecoveryPointId: 'rp-full', chainRootRecoveryPointId: 'rp-full' };
  childManifest.incremental = { cursor: currentCursor, previousCursorDigest: baselineCursor.digest, previousSetCount: 0, currentSetCount: 1, newSetCount: 1 };
  childManifest.manifestDigest = stableDigest({ ...childManifest, manifestDigest: undefined });
  const chain = validateRecoveryChain([{ point: point(), manifest: first.manifest }, { point: childPoint, manifest: childManifest }]);
  assert.equal(chain.kind, 'incremental');
  assert.deepEqual(chain.recoveryPointIds, ['rp-full', 'rp-incremental']);
  childManifest.chain.parentRecoveryPointId = 'rp-other';
  childManifest.manifestDigest = stableDigest({ ...childManifest, manifestDigest: undefined });
  assert.throws(() => validateRecoveryChain([{ point: point(), manifest: first.manifest }, { point: childPoint, manifest: childManifest }]), (error) => error.code === 'CASSANDRA_RESTORE_CHAIN_MISMATCH');
});

test('offline recovery materializes only authenticated members and persists an ownership-bound inventory', async (context) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-cassandra-restore-test-'));
  context.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const destination = path.join(temporary, 'bundle');
  const fixture = repositoryFixture();
  const service = new CassandraScyllaRestoreService({ controlDatabase: fixture.controlDatabase, secretStore: {}, snapshotBrowser: fixture.snapshotBrowser, adapter: {}, deviceId: 'device-a', clock: () => '2026-08-04T12:00:00.000Z' });
  const preview = await service.preview('workspace-a', { recoveryPointId: 'rp-full', mode: 'offline-bundle', destinationRoot: destination });
  assert.equal(preview.serviceMutationAllowed, false);
  assert.equal(preview.materializationAllowed, true);
  const started = await service.start('workspace-a', 'operator-a', { recoveryPointId: 'rp-full', mode: 'offline-bundle', destinationRoot: destination, confirmed: true, confirmationText: OFFLINE_CONFIRMATION });
  const completed = await service.wait('workspace-a', started.id);
  assert.equal(completed.state, 'succeeded');
  const materialized = path.join(destination, 'payload', ...fixture.evidence.file.archivePath.split('/'));
  assert.deepEqual(await fs.readFile(materialized), fixture.evidence.fileContent);
  const inventory = JSON.parse(await fs.readFile(path.join(destination, 'bundle-inventory.json'), 'utf8'));
  assert.equal(inventory.kind, 'cassandra-scylla-offline-bundle');
  assert.equal(inventory.serviceMutationAllowed, false);
  assert.equal(inventory.files.some((file) => file.path.includes('repository-a')), false);
  const ownerMode = (await fs.stat(path.join(destination, '.deployerx-restore-owner'))).mode & 0o777;
  if (process.platform !== 'win32') assert.equal(ownerMode, 0o600);
  else assert.equal((await fs.readFile(path.join(destination, '.deployerx-restore-owner'), 'utf8')).includes(started.id), true);
});

test('offline recovery removes only its exactly owned new root after archive authentication fails', async (context) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-cassandra-restore-failure-'));
  context.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const destination = path.join(temporary, 'bundle');
  const fixture = repositoryFixture({ archiveOptions: { trailing: true } });
  const service = new CassandraScyllaRestoreService({ controlDatabase: fixture.controlDatabase, secretStore: {}, snapshotBrowser: fixture.snapshotBrowser, adapter: {}, deviceId: 'device-a' });
  const started = await service.start('workspace-a', 'operator-a', { recoveryPointId: 'rp-full', mode: 'offline-bundle', destinationRoot: destination, confirmed: true, confirmationText: OFFLINE_CONFIRMATION });
  const completed = await service.wait('workspace-a', started.id);
  assert.equal(completed.state, 'failed');
  assert.equal(completed.result.error.code, 'CASSANDRA_RESTORE_ARCHIVE_TRAILING_DATA');
  await assert.rejects(fs.stat(destination), (error) => error.code === 'ENOENT');
});

test('offline Cassandra PITR materializes the full anchor, new segments, and exact protected replay configuration', async (context) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-cassandra-pitr-bundle-'));
  context.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const destination = path.join(temporary, 'bundle');
  const fixture = pitrFixture();
  const service = new CassandraScyllaRestoreService({ controlDatabase: fixture.controlDatabase, secretStore: {}, snapshotBrowser: fixture.snapshotBrowser, adapter: {}, deviceId: 'device-a', clock: () => '2026-08-04T12:00:00.000Z' });
  const request = {
    recoveryPointId: 'rp-log', mode: 'offline-bundle', destinationRoot: destination, targetUtc: '2026-08-04T00:00:01.500000Z',
    commitLogNodeMappings: [{ sourceHostId: SOURCE_HOST, targetHostId: 'target-node-a', restoreDirectory: '/var/lib/cassandra/commitlog-restore', propertiesPath: '/etc/cassandra/commitlog_archiving.properties' }]
  };
  const preview = await service.preview('workspace-a', request);
  assert.equal(preview.chainKind, 'commit-log');
  assert.equal(preview.targetUtc, request.targetUtc);
  const started = await service.start('workspace-a', 'operator-a', { ...request, confirmed: true, confirmationText: OFFLINE_CONFIRMATION });
  const completed = await service.wait('workspace-a', started.id);
  assert.equal(completed.state, 'succeeded');
  const config = await fs.readFile(path.join(destination, 'commitlog-config', SOURCE_HOST, 'commitlog-archiving.properties'), 'utf8');
  assert.match(config, /restore_point_in_time=2026:08:04 00:00:01[.]500000/);
  assert.match(config, /precision=MICROSECONDS/);
  const segmentPath = path.join(destination, 'payload', ...fixture.logFile.archivePath.split('/'));
  assert.deepEqual(await fs.readFile(segmentPath), fixture.segmentTwoBytes);
});

test('offline cancellation aborts publication and removes only the exact owned partial bundle', async (context) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-cassandra-cancel-'));
  context.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const destination = path.join(temporary, 'bundle');
  let startedResolve;
  let releaseResolve;
  const startedStreaming = new Promise((resolve) => { startedResolve = resolve; });
  const releaseStreaming = new Promise((resolve) => { releaseResolve = resolve; });
  const fixture = repositoryFixture({
    nodeStream: async function* blockedNodeStream(bytes) {
      yield bytes.subarray(0, ARCHIVE_MAGIC.length);
      startedResolve();
      await releaseStreaming;
      yield bytes.subarray(ARCHIVE_MAGIC.length);
    }
  });
  const service = new CassandraScyllaRestoreService({ controlDatabase: fixture.controlDatabase, secretStore: {}, snapshotBrowser: fixture.snapshotBrowser, adapter: {}, deviceId: 'device-a' });
  const request = { recoveryPointId: 'rp-full', mode: 'offline-bundle', destinationRoot: destination, confirmed: true, confirmationText: OFFLINE_CONFIRMATION };
  const queued = await service.start('workspace-a', 'operator-a', request);
  await startedStreaming;
  const cancellation = service.cancel('workspace-a', 'operator-a', queued.id);
  await new Promise((resolve) => setImmediate(resolve));
  releaseResolve();
  const canceled = await cancellation;
  assert.equal(canceled.state, 'canceled');
  assert.equal(canceled.result.rollbackPerformed, false);
  assert.equal(canceled.result.cleanupRequired, false);
  await assert.rejects(fs.stat(destination), (error) => error.code === 'ENOENT');
});

test('startup reconciliation preserves interrupted recovery targets for operator inspection', async () => {
  const fixture = repositoryFixture();
  fixture.controlDatabase.records.restoreRun.set('restore-abandoned', {
    id: 'restore-abandoned', revision: 1, workspaceId: 'workspace-a', state: 'running',
    target: { engine: 'cassandra-scylla', mode: 'alternate-cluster', operation: 'cassandra-scylla-alternate-cluster' },
    progress: { phase: 'running' }
  });
  const service = new CassandraScyllaRestoreService({ controlDatabase: fixture.controlDatabase, secretStore: {}, snapshotBrowser: fixture.snapshotBrowser, adapter: {}, deviceId: 'device-a' });
  const [reconciled] = await service.reconcile('workspace-a', 'system');
  assert.equal(reconciled.state, 'interrupted');
  assert.equal(reconciled.progress.phase, 'operator-action-required');
  assert.equal(reconciled.result.cleanupRequired, true);
  assert.equal(reconciled.result.targetMutationMayHaveOccurred, true);
});

class FakeTargetRuntime {
  constructor(shared, connectionId) { this.shared = shared; this.connectionId = connectionId; this.commands = []; this.files = new Map(); this.mode = 'ssh'; this.closed = false; }
  async run(executable, args) {
    this.commands.push({ executable, args: [...args] });
    if (executable === 'cat') return { stdout: this.files.get(args.at(-1)).toString('utf8'), stderr: '', exitCode: 0 };
    if (executable === 'cqlsh') this.shared.schemaApplied = true;
    if (executable === 'rm' && args.includes('-rf')) { this.files.clear(); this.shared.stageRemoved = true; }
    return { stdout: '', stderr: '', exitCode: 0 };
  }
  async writeFile(target, content) {
    const chunks = [];
    if (content && typeof content[Symbol.asyncIterator] === 'function') for await (const chunk of content) chunks.push(Buffer.from(chunk));
    else chunks.push(Buffer.from(content));
    this.files.set(target, Buffer.concat(chunks));
  }
  close() { this.closed = true; }
}

function targetConnections(options = {}) {
  const product = options.product || 'cassandra';
  const productVersion = options.productVersion || (product === 'scylladb' ? '6.2.2' : '5.0.4');
  const keyspaces = options.conflict ? [{ name: 'app', system: false }] : [];
  const nodes = TARGET_HOSTS.map((hostId, index) => ({ hostId, address: `10.1.0.${index + 1}`, dataCenter: 'dc1', rack: `rack${index + 1}`, status: options.unhealthy && index === 1 ? 'down' : 'up', state: 'normal', tokenCount: 2, tokenDigest: `sha256:target-token-${index}` }));
  return TARGET_HOSTS.map((hostId, index) => ({
    id: `target-${index + 1}`, adapterId: ADAPTER_ID, endpoint: { expectedProduct: product, executionMode: 'ssh', sshConnectionId: `ssh-target-${index + 1}`, contactHost: `10.1.0.${index + 1}`, nativePort: 9042, nodetoolPath: 'nodetool', cqlshPath: 'cqlsh', sstableloaderPath: 'sstableloader', cassandraPath: 'cassandra', scyllaPath: 'scylla', timeoutMs: 30000, expectedClusterName: 'target-cluster', expectedDeploymentFingerprint: `sha256:target-node-${index}`, expectedTopologyFingerprint: 'sha256:target-topology' },
    secretRefIds: options.secret && index === 0 ? ['secret-a'] : [], workerAffinity: ['device:device-a'], trust: { fingerprint: options.staleTrust && index === 0 ? 'sha256:stale-target-node' : `sha256:target-node-${index}`, topologyFingerprint: 'sha256:target-topology' }, lastTest: { status: 'success', endpointIdentity: { version: productVersion, partitioner: 'org.apache.cassandra.dht.Murmur3Partitioner' } },
    clusterInventory: { version: 1, product, productVersion, partitioner: 'org.apache.cassandra.dht.Murmur3Partitioner', clusterName: 'target-cluster', localHostId: hostId, clusterFingerprint: options.sameCluster ? 'sha256:source-cluster' : 'sha256:target-cluster', topologyFingerprint: 'sha256:target-topology', schemaVersion: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', schemaAgreement: true, deploymentFingerprint: `sha256:target-node-${index}`, inventoryFingerprint: `sha256:target-inventory-${index}`, coverage: { mode: 'vnode-ring', tokenCount: 4, ringFingerprint: 'sha256:target-ring' }, nodes, keyspaces, tables: [] }
  }));
}

function alternateFixture(options = {}) {
  const connections = targetConnections(options);
  const base = repositoryFixture({ connections, mutateManifest: options.product === 'scylladb' ? (manifest) => { manifest.cluster.product = 'scylladb'; manifest.cluster.version = '6.2.1'; } : null });
  const shared = { schemaApplied: false, stageRemoved: false };
  const runtimes = new Map(connections.map((connection) => [connection.id, new FakeTargetRuntime(shared, connection.id)]));
  const adapter = {
    async *discover(_context, request) {
      const connection = connections.find((item) => item.endpoint.contactHost === request.connection.contactHost);
      const seed = connection.clusterInventory;
      const localHostId = options.liveDriftConnectionId === connection.id ? TARGET_HOSTS.find((hostId) => hostId !== seed.localHostId) : seed.localHostId;
      yield {
        product: seed.product, clusterName: seed.clusterName, deploymentFingerprint: seed.deploymentFingerprint, clusterFingerprint: seed.clusterFingerprint, topologyFingerprint: seed.topologyFingerprint,
        identity: { localHostId, partitioner: seed.partitioner, version: { text: seed.productVersion } },
        keyspaces: shared.schemaApplied ? [{ name: 'app', system: false }] : [],
        tables: shared.schemaApplied ? [{ keyspace: 'app', name: 'orders', tableId: 'dddddddd-dddd-dddd-dddd-dddddddddddd' }] : [],
        topology: seed.nodes.map((node) => ({ ...node, tokens: node.tokenCount })), coverage: seed.coverage
      };
    }
  };
  const service = new CassandraScyllaRestoreService({ controlDatabase: base.controlDatabase, secretStore: { resolve: async () => 'secret' }, snapshotBrowser: base.snapshotBrowser, adapter, deviceId: 'device-a', runtimeFactory: { open: async (_workspaceId, connection) => runtimes.get(connection.id) }, clock: () => '2026-08-04T12:00:00.000Z' });
  const request = {
    recoveryPointId: 'rp-full', mode: 'alternate-cluster', targetSeedConnectionId: connections[0].id, conflictPolicy: 'fail',
    targetNodes: connections.map((connection, index) => ({ targetHostId: TARGET_HOSTS[index], connectionId: connection.id }))
  };
  return { ...base, adapter, connections, request, runtimes, service, shared };
}

test('alternate recovery checks a separate compatible empty cluster, loads SSTables, repairs every node, and validates tables', async () => {
  const fixture = alternateFixture();
  const preview = await fixture.service.preview('workspace-a', fixture.request);
  assert.equal(preview.compatibility.policy, 'same-major-release-line');
  assert.equal(preview.serviceMutationAllowed, true);
  const started = await fixture.service.start('workspace-a', 'operator-a', { ...fixture.request, confirmed: true, confirmationText: ALTERNATE_CONFIRMATIONS.cassandra });
  const completed = await fixture.service.wait('workspace-a', started.id);
  assert.equal(completed.state, 'succeeded');
  assert.equal(completed.validation.nativeValidation, true);
  assert.equal(fixture.shared.stageRemoved, true);
  const commands = [...fixture.runtimes.values()].flatMap((runtime) => runtime.commands);
  assert.equal(commands.some((command) => command.executable === 'sstableloader'), true);
  assert.equal(commands.filter((command) => command.executable === 'nodetool' && command.args[0] === 'repair').length, TARGET_HOSTS.length);
  assert.equal(commands.some((command) => command.executable === 'rm' && command.args.includes('-rf')), true);
});

test('ScyllaDB alternate recovery uses the same authenticated SSTable workflow without advertising commit-log replay', async () => {
  const fixture = alternateFixture({ product: 'scylladb' });
  const preview = await fixture.service.preview('workspace-a', fixture.request);
  assert.equal(preview.product, 'scylladb');
  assert.equal(preview.executable, true);
  assert.equal(preview.chainKind, 'full');
  const started = await fixture.service.start('workspace-a', 'operator-a', { ...fixture.request, confirmed: true, confirmationText: ALTERNATE_CONFIRMATIONS.scylladb });
  const completed = await fixture.service.wait('workspace-a', started.id);
  assert.equal(completed.state, 'succeeded');
  assert.equal(completed.result.targetClusterFingerprint, 'sha256:target-cluster');
});

test('alternate planning refuses target conflicts, cross-major media, and unsafe loader credential exposure', async () => {
  const conflict = alternateFixture({ conflict: true });
  const conflictPreview = await conflict.service.preview('workspace-a', conflict.request);
  assert.equal(conflictPreview.executable, false);
  assert.equal(conflictPreview.conflicts.some((item) => item.name === 'app'), true);
  assert.equal(conflictPreview.blockers[0].code, 'CASSANDRA_RESTORE_TARGET_CONFLICT');
  await assert.rejects(conflict.service.start('workspace-a', 'operator-a', { ...conflict.request, confirmed: true, confirmationText: ALTERNATE_CONFIRMATIONS.cassandra }), (error) => error.code === 'CASSANDRA_RESTORE_TARGET_CONFLICT');
  const incompatible = alternateFixture({ productVersion: '4.1.8' });
  await assert.rejects(incompatible.service.preview('workspace-a', incompatible.request), (error) => error.code === 'CASSANDRA_RESTORE_VERSION_INCOMPATIBLE');
  const original = alternateFixture({ sameCluster: true });
  await assert.rejects(original.service.preview('workspace-a', original.request), (error) => error.code === 'CASSANDRA_RESTORE_TARGET_INCOMPATIBLE');
  const incomplete = alternateFixture();
  await assert.rejects(incomplete.service.preview('workspace-a', { ...incomplete.request, targetNodes: incomplete.request.targetNodes.slice(0, 1) }), (error) => error.code === 'CASSANDRA_RESTORE_TARGET_NODE_MAPPING_INVALID');
  const secret = alternateFixture({ secret: true });
  const secretPreview = await secret.service.preview('workspace-a', secret.request);
  assert.equal(secretPreview.executable, false);
  assert.equal(secretPreview.blockers[0].code, 'CASSANDRA_RESTORE_LOADER_SECRET_UNSUPPORTED');
  const staleTrust = alternateFixture({ staleTrust: true });
  await assert.rejects(staleTrust.service.preview('workspace-a', staleTrust.request), (error) => error.code === 'CASSANDRA_RESTORE_TARGET_CONNECTION_INVALID');
  const unhealthy = alternateFixture({ unhealthy: true });
  await assert.rejects(unhealthy.service.preview('workspace-a', unhealthy.request), (error) => error.code === 'CASSANDRA_RESTORE_TARGET_HEALTH_INVALID');
  const unmappedSeed = alternateFixture();
  const seedOnly = structuredClone(unmappedSeed.connections[0]);
  seedOnly.id = 'target-seed-only';
  unmappedSeed.controlDatabase.records.connection.set(seedOnly.id, seedOnly);
  await assert.rejects(unmappedSeed.service.preview('workspace-a', { ...unmappedSeed.request, targetSeedConnectionId: seedOnly.id }), (error) => error.code === 'CASSANDRA_RESTORE_TARGET_NODE_MAPPING_INVALID');
  assert.throws(() => assertCompatibleVersions('cassandra', '5.0.3', '4.1.8'), (error) => error.code === 'CASSANDRA_RESTORE_VERSION_INCOMPATIBLE');
});

test('authenticated repository catalogs bind the cluster manifest, schema, and node archive evidence', async () => {
  for (const componentId of ['cluster-manifest', 'schema', SOURCE_HOST]) {
    const fixture = repositoryFixture();
    const file = fixture.opened.manifest.files.find((item) => item.metadata.componentId === componentId);
    if (componentId === 'cluster-manifest') file.metadata.database.manifestDigest = 'sha256:tampered-manifest';
    else file.metadata.database.component.manifestDigest = 'sha256:tampered-component';
    const service = new CassandraScyllaRestoreService({ controlDatabase: fixture.controlDatabase, secretStore: {}, snapshotBrowser: fixture.snapshotBrowser, adapter: {}, deviceId: 'device-a' });
    await assert.rejects(service.preview('workspace-a', { recoveryPointId: 'rp-full', mode: 'offline-bundle', destinationRoot: path.join(os.tmpdir(), `deployerx-catalog-${componentId}`) }), (error) => error.code === 'CASSANDRA_RESTORE_REPOSITORY_ARTIFACT_INVALID');
  }
});

test('alternate execution revalidates every mapped local node before creating remote state', async () => {
  const fixture = alternateFixture({ liveDriftConnectionId: 'target-2' });
  const started = await fixture.service.start('workspace-a', 'operator-a', { ...fixture.request, confirmed: true, confirmationText: ALTERNATE_CONFIRMATIONS.cassandra });
  const completed = await fixture.service.wait('workspace-a', started.id);
  assert.equal(completed.state, 'failed');
  assert.equal(completed.result.error.code, 'CASSANDRA_RESTORE_TARGET_CHANGED');
  assert.equal(fixture.shared.schemaApplied, false);
  assert.equal([...fixture.runtimes.values()].flatMap((runtime) => runtime.commands).some((command) => command.executable === 'mkdir'), false);
});
