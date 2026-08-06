const assert = require('node:assert/strict');
const test = require('node:test');
const {
  commitLogCursor,
  compareCommitLogCursors,
  normalizeCommitLogArchiveEnrollment,
  planCassandraCommitLogRestore,
  validateCommitLogArchiveProperties
} = require('./cassandra-commit-log');

const HOSTS = ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'];
const ARCHIVE_COMMAND = 'test ! -e /archive/%name && cp -- %path /archive/%name';

function enrollment(index) {
  return normalizeCommitLogArchiveEnrollment({
    directory: `/archive/node-${index + 1}`,
    propertiesPath: '/etc/cassandra/commitlog_archiving.properties',
    archiveCommand: ARCHIVE_COMMAND,
    ownershipMarker: `workspace-a:node-${index + 1}`,
    precision: 'MICROSECONDS',
    maximumClockSkewSeconds: 5
  });
}

function segment(id, modifiedAt, hash = 'a') {
  return { name: `CommitLog-7-${id}.log`, sizeBytes: 32, modifiedAt, sha256: hash.repeat(64) };
}

function node(index, segments) {
  const settings = enrollment(index);
  return {
    hostId: HOSTS[index],
    archiveDirectoryDigest: `sha256:${String(index + 1).repeat(64)}`,
    propertiesDigest: `sha256:${String(index + 3).repeat(64)}`,
    archiveCommandDigest: settings.archiveCommandDigest,
    ownershipMarkerDigest: settings.ownershipMarkerDigest,
    precision: settings.precision,
    clockObservedAt: '2026-08-04T00:01:00.000Z',
    clockOffsetMilliseconds: 0,
    clockSkewMilliseconds: 0,
    segments
  };
}

test('normalizes secret-free archive enrollment and authenticates inactive Cassandra archive properties', () => {
  const settings = enrollment(0);
  assert.equal(Object.hasOwn(settings, 'archiveCommand'), false);
  assert.match(settings.archiveCommandDigest, /^sha256:[0-9a-f]{64}$/);
  const evidence = validateCommitLogArchiveProperties(`archive_command=${ARCHIVE_COMMAND}\nrestore_command=\nrestore_directories=\nrestore_point_in_time=\nprecision=MICROSECONDS\n`, settings);
  assert.equal(evidence.precision, 'MICROSECONDS');
  assert.throws(() => validateCommitLogArchiveProperties(`archive_command=${ARCHIVE_COMMAND}\nrestore_point_in_time=2026:08:04 00:00:00.000000\nprecision=MICROSECONDS\n`, settings), /active commit-log restore settings/i);
  assert.throws(() => normalizeCommitLogArchiveEnrollment({ directory: '/archive', archiveCommand: 'cp source target', ownershipMarker: 'owner' }), /%path and %name/i);
});

test('advances an authenticated multi-node cursor and refuses missing, rewritten, late, or format-changed segments', () => {
  const first = commitLogCursor([
    node(0, [segment('1000', '2026-08-04T00:00:10.000Z')]),
    node(1, [segment('1001', '2026-08-04T00:00:11.000Z', 'b')])
  ]);
  const second = commitLogCursor([
    node(0, [segment('1000', '2026-08-04T00:00:10.000Z'), segment('2000', '2026-08-04T00:00:20.000Z', 'c')]),
    node(1, [segment('1001', '2026-08-04T00:00:11.000Z', 'b'), segment('2001', '2026-08-04T00:00:21.000Z', 'd')])
  ]);
  const compared = compareCommitLogCursors(first, second);
  assert.equal(compared.added.size, 2);
  assert.equal(compared.currentSafeThrough, '2026-08-04T00:00:20.000Z');
  const aheadNode = { ...node(0, [segment('3000', '2026-08-04T00:00:30.000Z')]), clockOffsetMilliseconds: 2000, clockSkewMilliseconds: 2000 };
  const conservative = commitLogCursor([aheadNode, node(1, [segment('3001', '2026-08-04T00:00:35.000Z', 'e')])]);
  assert.equal(conservative.safeThrough, '2026-08-04T00:00:28.000Z');

  const missing = commitLogCursor([node(0, []), node(1, second.nodes[1].segments)]);
  assert.throws(() => compareCommitLogCursors(first, missing), /previously recorded.*missing/i);
  const rewritten = commitLogCursor([node(0, [segment('1000', '2026-08-04T00:00:10.000Z', 'e')]), node(1, second.nodes[1].segments)]);
  assert.throws(() => compareCommitLogCursors(first, rewritten), /changed/i);
  const late = commitLogCursor([node(0, [segment('999', '2026-08-04T00:00:09.000Z', 'f'), ...first.nodes[0].segments]), node(1, first.nodes[1].segments)]);
  assert.throws(() => compareCommitLogCursors(first, late), /behind the authenticated archive cursor/i);
  assert.throws(() => commitLogCursor([node(0, [...first.nodes[0].segments, { ...segment('2000', '2026-08-04T00:00:20.000Z', 'c'), name: 'CommitLog-8-2000.log' }]), node(1, first.nodes[1].segments)]), /multiple segment formats/i);
});

test('plans an exact UTC offline replay configuration only for a contiguous authenticated chain', () => {
  const rootCursor = commitLogCursor([
    node(0, [segment('1000', '2026-08-04T00:00:01.000Z')]),
    node(1, [segment('1001', '2026-08-04T00:00:01.000Z', 'b')])
  ]);
  const childCursor = commitLogCursor([
    node(0, [...rootCursor.nodes[0].segments, segment('2000', '2026-08-04T00:00:10.000Z', 'c')]),
    node(1, [...rootCursor.nodes[1].segments, segment('2001', '2026-08-04T00:00:11.000Z', 'd')])
  ]);
  const cluster = { product: 'cassandra', clusterFingerprint: 'cluster', topologyFingerprint: 'topology', ringFingerprint: 'ring', schemaVersion: 'schema' };
  const source = { sourceId: 'source-a', jobId: 'job-a' };
  const root = {
    kind: 'cassandra-scylla-native-full', engine: 'cassandra-scylla', selectionDigest: 'selection', cluster, source,
    nodes: HOSTS.map((hostId) => ({ hostId })),
    commitLog: { baseline: true, cursor: rootCursor, precision: 'MICROSECONDS', recoveryWindow: { earliest: '2026-08-04T00:00:02.000000Z', latest: '2026-08-04T00:00:02.000000Z' }, gaps: [] }
  };
  const child = {
    kind: 'cassandra-commit-log', engine: 'cassandra-scylla', selectionDigest: 'selection', cluster, source,
    chain: { parentRecoveryPointId: 'rp-root', chainRootRecoveryPointId: 'rp-root' },
    commitLog: { cursor: childCursor, precision: 'MICROSECONDS', recoveryWindow: { earliest: '2026-08-04T00:00:02.000000Z', previous: '2026-08-04T00:00:02.000000Z', latest: '2026-08-04T00:00:10.000000Z' }, gaps: [] }
  };
  const request = {
    operation: 'cassandra-commit-log-offline-plan',
    targetUtc: '2026-08-04T00:00:08.123456Z',
    chain: [{ recoveryPointId: 'rp-root', manifest: root }, { recoveryPointId: 'rp-log', manifest: child }],
    nodeMappings: HOSTS.map((hostId, index) => ({ sourceHostId: hostId, targetHostId: `target-${index + 1}`, restoreDirectory: `/restore/node-${index + 1}`, propertiesPath: `/restore/node-${index + 1}/commitlog-archiving.properties` }))
  };
  const plan = planCassandraCommitLogRestore(request);
  assert.equal(plan.terminalRecoveryPointId, 'rp-log');
  assert.equal(plan.serviceMutationAllowed, false);
  assert.equal(plan.materializationAllowed, false);
  assert.equal(plan.configurations.length, 2);
  assert.match(plan.configurations[0].contents, /restore_point_in_time=2026:08:04 00:00:08[.]123456/);
  assert.match(plan.planDigest, /^sha256:/);
  assert.throws(() => planCassandraCommitLogRestore({ ...request, targetUtc: '2026-08-04T00:00:08.123Z' }), /exact UTC microseconds/i);
  assert.throws(() => planCassandraCommitLogRestore({ ...request, targetUtc: '2026-08-04T00:00:12.000000Z' }), /does not cover/i);
  assert.throws(() => planCassandraCommitLogRestore({ ...request, nodeMappings: request.nodeMappings.slice(1) }), /one unambiguous target mapping/i);
});
