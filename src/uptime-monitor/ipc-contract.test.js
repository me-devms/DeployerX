const assert = require('node:assert/strict');
const test = require('node:test');
const { safeUptimeIpcError, unwrapUptimeIpc, wrapUptimeIpc } = require('./ipc-contract');

test('round-trips successful Uptime IPC values', async () => {
  const response = await wrapUptimeIpc(async (value) => ({ value }))('evidence');
  assert.deepEqual(unwrapUptimeIpc(response), { value: 'evidence' });
});

test('preserves recognized safe codes and hides unexpected internal failures', async () => {
  const validation = Object.assign(new Error('URL is required.'), { code: 'UPTIME_INPUT_REQUIRED', category: 'validation' });
  const validationResponse = await wrapUptimeIpc(async () => { throw validation; })();
  assert.throws(() => unwrapUptimeIpc(validationResponse), (error) => error.code === 'UPTIME_INPUT_REQUIRED' && error.message === 'URL is required.' && error.category === 'validation');

  const internal = safeUptimeIpcError(new Error('C:\\private\\control.db could not be opened with token secret-value'));
  assert.deepEqual(internal, { code: 'UPTIME_OPERATION_FAILED', message: 'Could not complete the Uptime operation.', category: 'internal' });
  assert.throws(() => unwrapUptimeIpc({ uptimeIpcVersion: 1, ok: false, error: internal }), (error) => error.code === 'UPTIME_OPERATION_FAILED' && !error.message.includes('private'));
});

test('rejects unsupported IPC response shapes with a stable code', () => {
  assert.throws(() => unwrapUptimeIpc({ ok: true, value: 'legacy' }), (error) => error.code === 'UPTIME_IPC_RESPONSE_INVALID');
});
