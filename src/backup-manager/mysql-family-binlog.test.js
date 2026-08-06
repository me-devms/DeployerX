const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MysqlFamilyBinlogError,
  normalizePointInTimeTarget,
  parseDumpCoordinate,
  parseBinaryLogInventory,
  parseBinaryLogStatus,
  planBinaryLogSegments
} = require('./mysql-family-binlog');

const fingerprint = `sha256:${'a'.repeat(64)}`;

function coordinate(file, position, capturedAt) {
  return { version: 1, engine: 'mysql', file, position, gtidSet: 'uuid:1-20', capturedAt, serverIdentityFingerprint: fingerprint };
}

test('parses bounded MySQL-family status and log inventory output', () => {
  const status = parseBinaryLogStatus('mysql-bin.000042\t8192\t\t\tuuid:1-20\n', { engine: 'mysql', capturedAt: '2026-08-04T10:00:00.000Z', serverIdentityFingerprint: fingerprint });
  const inventory = parseBinaryLogInventory('mysql-bin.000041\t4096\tNo\nmysql-bin.000042\t12288\tYes\n');
  assert.deepEqual(status, coordinate('mysql-bin.000042', 8192, '2026-08-04T10:00:00.000Z'));
  assert.deepEqual(inventory.map((item) => ({ name: item.name, sizeBytes: item.sizeBytes, encrypted: item.encrypted })), [
    { name: 'mysql-bin.000041', sizeBytes: 4096, encrypted: false },
    { name: 'mysql-bin.000042', sizeBytes: 12288, encrypted: true }
  ]);
});

test('parses MySQL and MariaDB snapshot coordinates from a bounded dump header', () => {
  const mysql = parseDumpCoordinate("-- CHANGE REPLICATION SOURCE TO SOURCE_LOG_FILE='mysql-bin.000042', SOURCE_LOG_POS=8192;\nCREATE DATABASE `orders`;", { engine: 'mysql', capturedAt: '2026-08-04T10:00:00Z', serverIdentityFingerprint: fingerprint });
  const mariadb = parseDumpCoordinate("-- CHANGE MASTER TO MASTER_LOG_FILE='mariadb-bin.000007', MASTER_LOG_POS=512;\n", { engine: 'mariadb', capturedAt: '2026-08-04T10:00:00Z', serverIdentityFingerprint: fingerprint });
  assert.equal(mysql.file, 'mysql-bin.000042');
  assert.equal(mysql.position, 8192);
  assert.equal(mariadb.file, 'mariadb-bin.000007');
  assert.equal(mariadb.position, 512);
  assert.throws(() => parseDumpCoordinate('CREATE DATABASE `orders`;', { engine: 'mysql', capturedAt: '2026-08-04T10:00:00Z', serverIdentityFingerprint: fingerprint }), (error) => error.code === 'BINLOG_ANCHOR_COORDINATE_MISSING');
});

test('plans exact ordered capture segments across rotated logs', () => {
  const inventory = parseBinaryLogInventory('mysql-bin.000041\t4096\nmysql-bin.000042\t12288\nmysql-bin.000043\t9000\n');
  const plan = planBinaryLogSegments({
    start: coordinate('mysql-bin.000041', 3000, '2026-08-04T10:00:00.000Z'),
    end: coordinate('mysql-bin.000043', 7000, '2026-08-04T10:15:00.000Z'),
    inventory
  });
  assert.deepEqual(plan.segments.map((item) => [item.file, item.startPosition, item.stopPosition]), [
    ['mysql-bin.000041', 3000, 4096],
    ['mysql-bin.000042', 4, 12288],
    ['mysql-bin.000043', 4, 7000]
  ]);
  assert.equal(plan.empty, false);
});

test('represents an unchanged coordinate as an empty log interval', () => {
  const point = coordinate('mysql-bin.000042', 8192, '2026-08-04T10:00:00.000Z');
  const plan = planBinaryLogSegments({ start: point, end: { ...point, capturedAt: '2026-08-04T10:05:00.000Z' }, inventory: parseBinaryLogInventory('mysql-bin.000042\t12288\n') });
  assert.equal(plan.empty, true);
  assert.deepEqual(plan.segments, []);
});

test('fails closed when a required log was purged or server identity changed', () => {
  const start = coordinate('mysql-bin.000041', 3000, '2026-08-04T10:00:00.000Z');
  const end = coordinate('mysql-bin.000043', 7000, '2026-08-04T10:15:00.000Z');
  assert.throws(
    () => planBinaryLogSegments({ start, end, inventory: parseBinaryLogInventory('mysql-bin.000041\t4096\nmysql-bin.000043\t9000\n') }),
    (error) => error instanceof MysqlFamilyBinlogError && error.code === 'BINLOG_CHAIN_GAP'
  );
  assert.throws(
    () => planBinaryLogSegments({ start, end: { ...end, serverIdentityFingerprint: `sha256:${'b'.repeat(64)}` }, inventory: parseBinaryLogInventory('mysql-bin.000041\t4096\nmysql-bin.000042\t12288\nmysql-bin.000043\t9000\n') }),
    (error) => error.code === 'BINLOG_SERVER_IDENTITY_CHANGED'
  );
});

test('normalizes one timestamp or native coordinate inside the recoverable window', () => {
  const earliestCoordinate = coordinate('mysql-bin.000041', 3000, '2026-08-04T10:00:00.000Z');
  const latestCoordinate = coordinate('mysql-bin.000043', 7000, '2026-08-04T10:15:00.000Z');
  const bounds = { engine: 'mysql', earliest: earliestCoordinate.capturedAt, latest: latestCoordinate.capturedAt, earliestCoordinate, latestCoordinate };
  assert.deepEqual(normalizePointInTimeTarget({ timestamp: '2026-08-04T10:07:30Z' }, bounds), { type: 'timestamp', timestamp: '2026-08-04T10:07:30.000Z', coordinate: null });
  const byPosition = normalizePointInTimeTarget({ coordinate: coordinate('mysql-bin.000042', 6000, '2026-08-04T10:08:00.000Z') }, bounds);
  assert.equal(byPosition.type, 'coordinate');
  assert.equal(byPosition.coordinate.file, 'mysql-bin.000042');
  assert.throws(() => normalizePointInTimeTarget({ timestamp: '2026-08-04T09:59:59Z' }, bounds), (error) => error.code === 'PITR_TIMESTAMP_OUT_OF_RANGE');
  assert.throws(() => normalizePointInTimeTarget({ timestamp: '2026-08-04T10:05:00Z', coordinate: earliestCoordinate }, bounds), (error) => error.code === 'PITR_STOP_POINT_INVALID');
});
