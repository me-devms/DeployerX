const assert = require('node:assert/strict');
const test = require('node:test');

test('stable CockroachDB schedule module exposes the SQL-backed native controller', () => {
  const stable = require('./cockroachdb-schedule');
  const native = require('./cockroachdb-native-schedule');
  assert.equal(stable.CockroachDbNativeScheduleController, native.CockroachDbNativeScheduleController);
  assert.equal(stable.buildCreateScheduleStatement, native.buildCreateScheduleStatement);
  assert.equal(stable.publicScheduleProjection, native.publicScheduleProjection);
});
