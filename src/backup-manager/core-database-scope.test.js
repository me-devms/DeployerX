'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CORE_DATABASE_ADAPTER_IDS,
  isCoreDatabaseAdapterId
} = require('./core-database-scope');

const EXPECTED_ADAPTER_IDS = [
  'deployerx.database.mysql.logical',
  'deployerx.database.mariadb.logical',
  'deployerx.database.postgresql.logical',
  'deployerx.database.mongodb.native',
  'deployerx.database.redis.native',
  'deployerx.database.sqlite.native',
  'deployerx.database.clickhouse'
];

test('defines the exact ordered core database adapter scope', () => {
  assert.deepEqual(CORE_DATABASE_ADAPTER_IDS, EXPECTED_ADAPTER_IDS);
  assert.equal(Object.isFrozen(CORE_DATABASE_ADAPTER_IDS), true);
  assert.throws(() => CORE_DATABASE_ADAPTER_IDS.push('deployerx.database.influxdb'), TypeError);
});

test('checks adapter membership against only the core scope', () => {
  for (const adapterId of EXPECTED_ADAPTER_IDS) {
    assert.equal(isCoreDatabaseAdapterId(adapterId), true, `${adapterId} should be in core scope`);
  }

  assert.equal(isCoreDatabaseAdapterId('deployerx.database.cockroachdb.logical'), false);
  assert.equal(isCoreDatabaseAdapterId('deployerx.database.postgresql.logical '), false);
  assert.equal(isCoreDatabaseAdapterId(undefined), false);
});
