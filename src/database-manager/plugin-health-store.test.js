const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabasePluginHealthStore } = require('./plugin-health-store');

async function fixture(context) {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-plugin-health-'));
  let index = 0;
  const store = new DatabasePluginHealthStore({ rootPath, clock: () => `2026-08-05T00:00:0${index++}.000Z` });
  await store.initialize();
  context.after(() => fs.rm(rootPath, { recursive: true, force: true }));
  return { rootPath, store };
}

test('persists bounded ready and crash evidence across restart', async (context) => {
  const value = await fixture(context);
  await value.store.recordDiagnostic('vendor.redis', 'spawn');
  await value.store.recordHealth('vendor.redis', { ok: true });
  await value.store.recordDiagnostic('vendor.redis', 'exit', { exitCode: 7, signal: 'SIGTERM', password: 'not-persisted' });
  const record = await value.store.get('vendor.redis');
  assert.equal(record.status, 'crashed');
  assert.equal(record.crashCount, 1);
  assert.equal(record.lastExitCode, 7);
  const raw = await fs.readFile(path.join(value.rootPath, 'health.json'), 'utf8');
  assert.doesNotMatch(raw, /not-persisted|password/i);
  const restarted = new DatabasePluginHealthStore({ rootPath: value.rootPath });
  assert.equal((await restarted.get('vendor.redis')).crashCount, 1);
});

test('tracks stderr and protocol events without persisting their contents', async (context) => {
  const value = await fixture(context);
  await value.store.recordDiagnostic('vendor.csv', 'stderr', { byteLength: 18, content: 'database password' });
  await value.store.recordDiagnostic('vendor.csv', 'protocol-error', { query: 'select secret' });
  const record = await value.store.get('vendor.csv');
  assert.equal(record.status, 'warning');
  assert.equal(record.stderrEventCount, 1);
  assert.equal(record.protocolErrorCount, 1);
  assert.equal(record.lastErrorCode, 'DATABASE_MANAGER_DRIVER_PROTOCOL_ERROR');
  assert.doesNotMatch(await fs.readFile(path.join(value.rootPath, 'health.json'), 'utf8'), /database password|select secret/i);
});

test('records failed health checks, disablement, and removal', async (context) => {
  const value = await fixture(context);
  await value.store.recordHealth('vendor.db2', { ok: false, errorCode: 'DATABASE_MANAGER_DRIVER_TIMEOUT' });
  assert.equal((await value.store.get('vendor.db2')).lastErrorCode, 'DATABASE_MANAGER_DRIVER_TIMEOUT');
  assert.equal((await value.store.setDisabled('vendor.db2')).status, 'disabled');
  assert.equal(await value.store.remove('vendor.db2'), true);
  assert.equal(await value.store.get('vendor.db2'), null);
});
