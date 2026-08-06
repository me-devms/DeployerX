const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseOperationalEvidenceStore, normalizeEvidenceRecord } = require('./operational-evidence-store');

async function fixture(context, options = {}) {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-operational-evidence-'));
  context.after(() => fs.rm(rootPath, { recursive: true, force: true }));
  let second = 0;
  const store = new DatabaseOperationalEvidenceStore({ rootPath, maxRecords: options.maxRecords || 5000, clock: () => `2026-08-06T12:00:0${second++}.000Z` });
  await store.initialize();
  return { rootPath, store };
}

test('persists only allowlisted connection and schema evidence across restart', async (context) => {
  const value = await fixture(context);
  await value.store.append('workspace-a', { profileId: 'profile-a', category: 'connection', operation: 'open', state: 'ready', password: 'secret', endpoint: 'private.internal' });
  await value.store.append('workspace-a', { profileId: 'profile-a', category: 'schema', operation: 'create-table', state: 'changed', query: 'CREATE TABLE secret', objectName: 'private_table' });
  const raw = await fs.readFile(path.join(value.rootPath, 'operational-evidence.json'), 'utf8');
  assert.doesNotMatch(raw, /secret|private\.internal|CREATE TABLE|private_table/i);
  const restarted = new DatabaseOperationalEvidenceStore({ rootPath: value.rootPath });
  assert.deepEqual((await restarted.list('workspace-a')).map((record) => [record.category, record.operation]), [['schema', 'create-table'], ['connection', 'open']]);
});

test('enforces bounded retention and workspace/profile isolation', async (context) => {
  const value = await fixture(context, { maxRecords: 3 });
  await value.store.append('workspace-a', { profileId: 'profile-a', category: 'connection', operation: 'test', state: 'tested' });
  await value.store.append('workspace-a', { profileId: 'profile-b', category: 'connection', operation: 'open', state: 'ready' });
  await value.store.append('workspace-b', { profileId: 'profile-c', category: 'connection', operation: 'close', state: 'closed' });
  await value.store.append('workspace-a', { profileId: 'profile-a', category: 'schema', operation: 'drop-table', state: 'failed', code: 'DATABASE_MANAGER_QUERY_FAILED' });
  assert.deepEqual((await value.store.list('workspace-a')).map((record) => record.profileId), ['profile-a', 'profile-b']);
  assert.equal((await value.store.list('workspace-a', { profileId: 'profile-a' })).length, 1);
  assert.equal((await value.store.list('workspace-b')).length, 1);
});

test('rejects arbitrary operations, unsafe codes, and corrupt persisted state', async (context) => {
  assert.throws(() => normalizeEvidenceRecord({ workspaceId: 'workspace-a', profileId: 'profile-a', category: 'schema', operation: 'DROP TABLE private', state: 'changed', occurredAt: new Date().toISOString() }), /operation/);
  assert.throws(() => normalizeEvidenceRecord({ workspaceId: 'workspace-a', profileId: 'profile-a', category: 'connection', operation: 'open', state: 'failed', code: 'path C:\\private', occurredAt: new Date().toISOString() }), /code/);
  const value = await fixture(context);
  await fs.writeFile(path.join(value.rootPath, 'operational-evidence.json'), '{"schemaVersion":1,"records":"invalid"}');
  const corrupt = new DatabaseOperationalEvidenceStore({ rootPath: value.rootPath });
  await assert.rejects(corrupt.initialize(), /state is invalid/);
});
