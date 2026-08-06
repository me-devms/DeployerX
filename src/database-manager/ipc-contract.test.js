const assert = require('node:assert/strict');
const test = require('node:test');
const {
  DATABASE_MANAGER_IPC_VERSION,
  safeError,
  unwrapDatabaseManagerIpc,
  wrapDatabaseManagerIpc
} = require('./ipc-contract');

test('wraps successful Database Manager IPC values', async () => {
  const response = await wrapDatabaseManagerIpc(async (_event, value) => ({ value }))({}, 42);
  assert.deepEqual(response, { databaseManagerIpcVersion: DATABASE_MANAGER_IPC_VERSION, ok: true, value: { value: 42 } });
  assert.deepEqual(unwrapDatabaseManagerIpc(response), { value: 42 });
});

test('returns structured safe errors without credential details', async () => {
  const operation = wrapDatabaseManagerIpc(async () => {
    throw Object.assign(new Error('Connection failed safely.'), {
      code: 'DATABASE_CONNECTION_FAILED',
      category: 'connectivity',
      retryable: true,
      details: { host: 'db.example.test', password: 'do-not-return', attempt: 2 }
    });
  });
  const response = await operation();
  assert.equal(response.ok, false);
  assert.deepEqual(response.error.details, { host: 'db.example.test', attempt: 2 });
  assert.throws(
    () => unwrapDatabaseManagerIpc(response),
    (error) => error.code === 'DATABASE_CONNECTION_FAILED' && error.retryable === true && error.details.password === undefined
  );
});

test('rejects unsupported IPC envelopes', () => {
  assert.throws(
    () => unwrapDatabaseManagerIpc({ databaseManagerIpcVersion: 999, ok: true, value: null }),
    (error) => error.code === 'DATABASE_MANAGER_IPC_RESPONSE_INVALID'
  );
  assert.deepEqual(safeError(null).details, {});
});
