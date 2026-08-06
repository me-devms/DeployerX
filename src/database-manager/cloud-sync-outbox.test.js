const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { CLOUD_SYNC_OUTBOX_SCHEMA_VERSION, DatabaseCloudSyncOutbox } = require('./cloud-sync-outbox');

function profile(overrides = {}) {
  return {
    id: 'profile-a', revision: 1, name: 'Orders', driverId: 'postgresql', endpoint: { kind: 'network', host: 'db.example.test', port: 5432 },
    database: 'orders', defaultSchema: 'public', environment: 'production', accessMode: 'read-write', tags: [], ssl: { mode: 'disabled' }, tunnel: { type: 'none' },
    credentialSlots: [{ id: 'password', type: 'password', label: 'Password', required: false }], credentialSecretRefs: [{ slotId: 'password', secretRefId: 'secret-local' }], settings: { username: 'app' }, ...overrides
  };
}

async function fixture(context) {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-cloud-outbox-'));
  let sequence = 0;
  const outbox = new DatabaseCloudSyncOutbox({ rootPath, clock: () => `2026-08-05T00:00:0${sequence++}.000Z` });
  await outbox.initialize();
  context.after(() => fs.rm(rootPath, { recursive: true, force: true }));
  return { rootPath, outbox };
}

test('persists only redacted cloud profile projections and survives restart', async (context) => {
  const value = await fixture(context);
  await value.outbox.enqueueUpsert('workspace-a', profile(), { expectedRevision: 0 });
  const raw = await fs.readFile(path.join(value.rootPath, 'cloud-profile-outbox.json'), 'utf8');
  assert.doesNotMatch(raw, /secret-local|credentialSecretRefs|username/);
  const restarted = new DatabaseCloudSyncOutbox({ rootPath: value.rootPath });
  await restarted.initialize();
  assert.deepEqual(await restarted.listPending('workspace-a'), [{ profileId: 'profile-a', type: 'upsert', expectedRevision: 0, attempts: 0, lastAttemptAt: null, lastErrorCode: null }]);
});

test('loads version-one queues conservatively without inventing a cloud base revision', async (context) => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-cloud-outbox-v1-'));
  context.after(() => fs.rm(rootPath, { recursive: true, force: true }));
  const document = require('./cloud-metadata').cloudProfileDocument(profile());
  await fs.writeFile(path.join(rootPath, 'cloud-profile-outbox.json'), JSON.stringify({
    schemaVersion: 1,
    operations: [{ workspaceId: 'workspace-a', profileId: 'profile-a', type: 'upsert', document }]
  }));
  const migrated = new DatabaseCloudSyncOutbox({ rootPath });
  await migrated.initialize();
  assert.equal((await migrated.listPending('workspace-a'))[0].expectedRevision, null);
  assert.equal(JSON.parse(await fs.readFile(path.join(rootPath, 'cloud-profile-outbox.json'), 'utf8')).schemaVersion, CLOUD_SYNC_OUTBOX_SCHEMA_VERSION);
});

test('sanitizes schema-two local-profile fields during the schema-three migration', async (context) => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'deployerx-cloud-outbox-v2-'));
  context.after(() => fs.rm(rootPath, { recursive: true, force: true }));
  const document = require('./cloud-metadata').cloudProfileDocument(profile());
  const legacyDocument = {
    ...document,
    metadata: { ...document.metadata, settings: { username: 'legacy-local' }, startupScript: 'SELECT 1', queryTimeoutMs: 60000 }
  };
  await fs.writeFile(path.join(rootPath, 'cloud-profile-outbox.json'), JSON.stringify({
    schemaVersion: 2,
    operations: [{ workspaceId: 'workspace-a', profileId: 'profile-a', type: 'upsert', document: legacyDocument, expectedRevision: 0 }]
  }));
  const migrated = new DatabaseCloudSyncOutbox({ rootPath });
  await migrated.initialize();
  const persisted = await fs.readFile(path.join(rootPath, 'cloud-profile-outbox.json'), 'utf8');
  assert.doesNotMatch(persisted, /legacy-local|startupScript|queryTimeoutMs|settings/);
  assert.equal(JSON.parse(persisted).schemaVersion, CLOUD_SYNC_OUTBOX_SCHEMA_VERSION);
});

test('coalesces each profile to its latest idempotent operation', async (context) => {
  const value = await fixture(context);
  await value.outbox.enqueueUpsert('workspace-a', profile(), { expectedRevision: 4 });
  await value.outbox.enqueueUpsert('workspace-a', profile({ revision: 2, name: 'Orders primary' }), { expectedRevision: 5 });
  await value.outbox.enqueueDelete('workspace-a', 'profile-a', { expectedRevision: 5 });
  assert.deepEqual(await value.outbox.listPending('workspace-a'), [{ profileId: 'profile-a', type: 'delete', expectedRevision: 4, attempts: 0, lastAttemptAt: null, lastErrorCode: null }]);
});

test('retains failed operations with safe evidence and removes successful retries', async (context) => {
  const value = await fixture(context);
  await value.outbox.enqueueUpsert('workspace-a', profile(), { expectedRevision: 0 });
  const failed = await value.outbox.flush('workspace-a', async () => { throw Object.assign(new Error('Bearer secret-value'), { code: 'NETWORK_DOWN' }); });
  assert.equal(failed.pending, 1);
  assert.deepEqual(failed.failed, [{ profileId: 'profile-a', type: 'upsert', code: 'NETWORK_DOWN' }]);
  assert.equal((await value.outbox.listPending('workspace-a'))[0].attempts, 1);
  const delivered = [];
  const succeeded = await value.outbox.flush('workspace-a', async (operation) => delivered.push(operation));
  assert.equal(succeeded.pending, 0);
  assert.equal(delivered[0].document.metadata.name, 'Orders');
});

test('rebases conflicts atomically and can explicitly discard pending work', async (context) => {
  const value = await fixture(context);
  await value.outbox.enqueueUpsert('workspace-a', profile(), { expectedRevision: 2 });
  await value.outbox.flush('workspace-a', async () => { throw Object.assign(new Error('conflict'), { code: 'DATABASE_MANAGER_CLOUD_SYNC_CONFLICT' }); });
  assert.equal((await value.outbox.listPending('workspace-a'))[0].lastErrorCode, 'DATABASE_MANAGER_CLOUD_SYNC_CONFLICT');
  const held = await value.outbox.flush('workspace-a', async () => { throw new Error('A conflict must not retry automatically.'); });
  assert.equal(held.attempted, 0);
  assert.equal(held.pending, 1);
  await value.outbox.rebase('workspace-a', 'profile-a', 5);
  const rebased = await value.outbox.getOperation('workspace-a', 'profile-a');
  assert.equal(rebased.expectedRevision, 5);
  assert.equal(rebased.document.revision, 6);
  assert.equal(rebased.attempts, 0);
  assert.deepEqual(await value.outbox.discard('workspace-a', 'profile-a'), { profileId: 'profile-a', removed: true });
  assert.equal(await value.outbox.getOperation('workspace-a', 'profile-a'), null);
});
